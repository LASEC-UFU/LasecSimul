// PID Controller / PID Controller (2DOF) e as variantes discretas (bibliotecas Continuous e Discrete).
//
// Um único kernel `pid` cobre os quatro blocos (1DOF/2DOF, tempo contínuo/discreto), com a estrutura
// documentada pela MathWorks (pidcontroller.html, pidcontroller2dof.html e as páginas discretas):
//
//   1DOF: eP = eI = eD = u                2DOF: eP = b*r - y, eI = r - y, eD = c*r - y
//   Paralela: y = P*eP + I*integral(eI) + termo D sobre D*eD
//   Ideal:    as três ações recebem P*e (o ganho P "age sobre a soma de todas as ações")
//   Termo D:  integrador de filtro f com entrada dOut = N*(D*eD - f)  =>  D*N*s/(s + N)
//             (discreto: D*N/(1 + N*beta(z))); sem filtro (só discreto): D*(z - 1)/(z*Ts)
//   Integral: integrador da entrada v = I*eI [+ Kb*(ysat - y) back-calculation] [+ Kt*(TR - ysat)]
//             clamping zera I*eI enquanto a soma passa dos limites com o mesmo sinal da entrada do
//             integrador; anti-windup externo integra extAW e publica preInt.
//
// Discreto (Discrete-Time Integrator, Initial condition setting = Auto): com q = c*s (c = 0 Forward
// Euler, 1 Backward Euler, 1/2 Trapezoidal; s = Ts, ou 1 com Use I*Ts) a saída do integrador é
// Y = x + q*v e o estado vai a x(n+1) = Y + (s - q)*v -- exatamente as equações de passo do bloco
// Discrete-Time Integrator. Com Backward Euler/Trapezoidal a saída depende da entrada atual e o
// back-calculation/tracking formam um laço algébrico (o Simulink resolve numericamente); aqui ele é
// resolvido de forma exata por regiões lineares da saturação.
//
// Contínuo: estados x = [xI (n) | xF (n)] integrados pela partição contínua acoplada (RK4). Reset,
// limite do integrador e a decisão do clamping só mudam em passo MAIOR (sem localização de
// cruzamento por zero, como os demais blocos de modo do engine).
//
// ip = [n, 2dof, termos (1 P | 2 I | 4 D), ideal, discreto, método integrador, método filtro,
//       filtro (1) ou diferenciador (0), Use I*Ts, modo de reset (ResetMode), IC na saída (Output),
//       IC externa, Limit output, anti-windup (0 none, 1 back-calculation, 2 clamping, 3 external),
//       tracking, limite do integrador, preInt publicado, portas por papel (-1 = ausente) x PidRoleCount]
// rp = [P, I, D, N, b, c, IC integrador, IC filtro/diferenciador, Upper, Lower, IntUpper, IntLower]
//      (cada um com n elementos) + [Kb, Kt]
// d  = [xI (n, discreto) | xF (n, discreto) | reset anterior (n) | modo (n: clamping contínuo
//       congelado; no discreto, "IC aplicada na saída neste passo") | inicializado]
// Saída: [y (n)] ou [y (n) | preInt (n)].
#include <algorithm>
#include <cmath>
#include <limits>

#include "../KernelCommon.hpp"
#include "Families.hpp"
#include "ResetEdge.hpp"

namespace lasecsimul::simulation::library {
namespace {
using namespace detail;

enum PidIp : int64_t {
    PidWidth = 0, PidTwoDof, PidTerms, PidIdeal, PidDiscrete, PidIntMethod, PidFiltMethod, PidUseFilter, PidUseKiTs,
    PidResetMode, PidIcOutput, PidIcExternal, PidLimit, PidAntiWindup, PidTracking, PidLimitIntegrator, PidPreInt,
    PidPortBase
};
enum PidRole : int64_t {
    RoleU = 0, RoleY, RoleP, RoleI, RoleD, RoleN, RoleB, RoleC, RoleReset, RoleI0, RoleD0, RoleUp, RoleLo, RoleTr, RoleExtAw,
    PidRoleCount
};
enum PidRp : size_t { RpP = 0, RpI, RpD, RpN, RpB, RpC, RpIcI, RpIcF, RpUpper, RpLower, RpIntUpper, RpIntLower, RpVectorCount };
enum PidTerm : int64_t { TermP = 1, TermI = 2, TermD = 4 };
enum PidAw : int64_t { AwNone = 0, AwBackCalculation = 1, AwClamping = 2, AwExternal = 3 };

constexpr double kInf = std::numeric_limits<double>::infinity();

/** Fração da entrada atual na saída do integrador discreto: FE 0, BE 1, Trapezoidal 1/2. */
double methodFraction(int64_t method) { return method == 1 ? 1.0 : method == 2 ? 0.5 : 0.0; }

struct Pid {
    const KernelContext& k;
    size_t n;
    bool twoDof, hasP, hasI, hasD, ideal, discrete, filtered, limit, tracking, limitIntegrator;
    int64_t antiWindup;
    double s = 0.0, q = 0.0, qF = 0.0; // escala do integrador, fração direta do integrador e do filtro

    explicit Pid(const KernelContext& context)
        : k(context), n(static_cast<size_t>(context.ip[PidWidth])), twoDof(context.ip[PidTwoDof] != 0),
          hasP((context.ip[PidTerms] & TermP) != 0), hasI((context.ip[PidTerms] & TermI) != 0),
          hasD((context.ip[PidTerms] & TermD) != 0), ideal(context.ip[PidIdeal] != 0), discrete(context.ip[PidDiscrete] != 0),
          filtered(context.ip[PidUseFilter] != 0), limit(context.ip[PidLimit] != 0), tracking(context.ip[PidTracking] != 0),
          limitIntegrator(context.ip[PidLimitIntegrator] != 0), antiWindup(context.ip[PidAntiWindup]) {
        if (discrete) {
            s = k.ip[PidUseKiTs] != 0 ? 1.0 : k.ts;
            q = methodFraction(k.ip[PidIntMethod]) * s;
            qF = methodFraction(k.ip[PidFiltMethod]) * k.ts;
        }
    }

    int64_t port(int64_t role) const { return k.ip[PidPortBase + role]; }
    bool has(int64_t role) const { return port(role) >= 0; }
    double in(int64_t role, size_t i) const { return k.input(static_cast<uint16_t>(port(role)), static_cast<uint16_t>(i)); }
    double rp(size_t block, size_t i) const { return k.rp[block * n + i]; }
    /** Parâmetro do controlador: porta externa quando existe, senão o valor do diálogo. */
    double param(int64_t role, size_t block, size_t i) const { return has(role) ? in(role, i) : rp(block, i); }

    double upper(size_t i) const { return !limit ? kInf : has(RoleUp) ? in(RoleUp, i) : rp(RpUpper, i); }
    double lower(size_t i) const { return !limit ? -kInf : has(RoleLo) ? in(RoleLo, i) : rp(RpLower, i); }
    double intUpper(size_t i) const { return limitIntegrator ? rp(RpIntUpper, i) : kInf; }
    double intLower(size_t i) const { return limitIntegrator ? rp(RpIntLower, i) : -kInf; }
    double clampIntegrator(double x, size_t i) const { return limitIntegrator ? std::clamp(x, intLower(i), intUpper(i)) : x; }
    double kb() const { return antiWindup == AwBackCalculation ? k.rp[RpVectorCount * n] : 0.0; }
    double kt() const { return tracking ? k.rp[RpVectorCount * n + 1] : 0.0; }
    double icIntegrator(size_t i) const { return clampIntegrator(has(RoleI0) ? in(RoleI0, i) : rp(RpIcI, i), i); }
    double icFilter(size_t i) const { return has(RoleD0) ? in(RoleD0, i) : rp(RpIcF, i); }
    static double saturate(double value, double lo, double up) { return value > up ? up : value < lo ? lo : value; }
};

/** Resultado da avaliação de um elemento com o estado dado. */
struct PidEval {
    double y = 0.0, yUnsat = 0.0, integral = 0.0, v = 0.0, preInt = 0.0, gI = 0.0;
    double dOut = 0.0, fOut = 0.0, scaled = 0.0;
};

/** Pedido de avaliação: estado e, opcionalmente, saídas impostas (IC na saída) e modo de clamping. */
struct PidState {
    double xI = 0.0, xF = 0.0;
    bool forceIntegrator = false, forceFilter = false;
    double forcedIntegrator = 0.0, forcedFilter = 0.0;
    /** -1 = decidir agora (discreto); 0/1 = modo congelado do passo maior (contínuo). */
    int clampMode = -1;
};

bool clampCondition(double yUnsat, double lo, double up, double gI) {
    const double dz = yUnsat > up ? yUnsat - up : yUnsat < lo ? yUnsat - lo : 0.0;
    return dz != 0.0 && sgn(dz) == sgn(gI);
}

/** Saída Y do integrador discreto com fração direta q > 0: Y = clampI(x + q*v(Y)), onde
 * v(Y) = g + Kb*(sat(A + Y) - (A + Y)) + Kt*(TR - sat(A + Y)) é linear por região da saturação.
 * Para Kb, Kt >= 0 a solução é única; procura-se a região (e o limite do integrador) consistente. */
double solveIntegrator(const Pid& pid, size_t i, double x, double A, double g, double TR) {
    const double lo = pid.lower(i), up = pid.upper(i), Kb = pid.kb(), Kt = pid.kt();
    const double iLo = pid.intLower(i), iUp = pid.intUpper(i);
    struct Region { double from, to, alpha, beta; };
    Region regions[3];
    size_t count = 0;
    regions[count++] = {lo - A, up - A, g + Kt * (TR - A), -Kt};
    if (std::isfinite(lo)) regions[count++] = {-kInf, lo - A, g + Kb * (lo - A) + Kt * (TR - lo), -Kb};
    if (std::isfinite(up)) regions[count++] = {up - A, kInf, g + Kb * (up - A) + Kt * (TR - up), -Kb};
    const double q = pid.q;
    for (size_t r = 0; r < count; ++r) {
        const Region& region = regions[r];
        const auto inside = [&](double Y) { return Y >= region.from && Y <= region.to; };
        const auto z = [&](double Y) { return x + q * (region.alpha + region.beta * Y); };
        const double den = 1.0 - q * region.beta;
        if (den != 0.0) {
            const double Y = (x + q * region.alpha) / den;
            if (inside(Y) && Y >= iLo && Y <= iUp) return Y;
        }
        if (std::isfinite(iUp) && inside(iUp) && z(iUp) >= iUp) return iUp;
        if (std::isfinite(iLo) && inside(iLo) && z(iLo) <= iLo) return iLo;
    }
    // Ganhos negativos (sem solução única): um passo de ponto fixo a partir do estado.
    const double Y0 = pid.clampIntegrator(x, i);
    const double y0 = Pid::saturate(A + Y0, lo, up);
    return pid.clampIntegrator(x + q * (g + Kb * (y0 - (A + Y0)) + Kt * (TR - y0)), i);
}

PidEval evaluate(const Pid& pid, size_t i, const PidState& state) {
    PidEval e;
    double eP, eI, eD;
    if (pid.twoDof) {
        const double r = pid.in(RoleU, i), ym = pid.in(RoleY, i);
        eP = pid.param(RoleB, RpB, i) * r - ym;
        eI = r - ym;
        eD = pid.hasD ? pid.param(RoleC, RpC, i) * r - ym : 0.0;
    } else {
        eP = eI = eD = pid.in(RoleU, i);
    }
    double pTerm = 0.0, Dd = 0.0;
    const double P = pid.hasP ? pid.param(RoleP, RpP, i) : 0.0;
    if (pid.ideal && pid.hasP) {
        // Forma ideal: o ganho P vem antes de todas as ações.
        pTerm = P * eP;
        if (pid.hasI) e.gI = pid.param(RoleI, RpI, i) * (P * eI);
        if (pid.hasD) Dd = pid.param(RoleD, RpD, i) * (P * eD);
    } else {
        if (pid.hasP) pTerm = P * eP;
        if (pid.hasI) e.gI = pid.param(RoleI, RpI, i) * eI;
        if (pid.hasD) Dd = pid.param(RoleD, RpD, i) * eD;
    }
    if (pid.hasD) {
        if (!pid.discrete) {
            e.fOut = state.xF;
            e.dOut = pid.param(RoleN, RpN, i) * (Dd - state.xF);
        } else if (pid.filtered) {
            const double N = pid.param(RoleN, RpN, i);
            e.fOut = state.forceFilter ? state.forcedFilter : (state.xF + pid.qF * N * Dd) / (1.0 + pid.qF * N);
            e.dOut = N * (Dd - e.fOut);
        } else {
            // Diferenciador: estado = entrada escalada anterior (D*e/Ts).
            e.scaled = Dd / pid.k.ts;
            e.dOut = e.scaled - state.xF;
        }
    }
    const double lo = pid.lower(i), up = pid.upper(i);
    if (!pid.hasI) {
        e.yUnsat = pTerm + e.dOut;
        e.y = pid.limit ? Pid::saturate(e.yUnsat, lo, up) : e.yUnsat;
        return e;
    }
    const double TR = pid.tracking ? pid.in(RoleTr, i) : 0.0;
    const double Kb = pid.kb(), Kt = pid.kt();
    const bool clamping = pid.limit && pid.antiWindup == AwClamping;
    const bool external = pid.antiWindup == AwExternal && pid.has(RoleExtAw);
    const auto finish = [&](double Y, bool clamped) {
        e.integral = Y;
        e.yUnsat = (pTerm + Y) + e.dOut;
        e.y = pid.limit ? Pid::saturate(e.yUnsat, lo, up) : e.yUnsat;
        const double tr = pid.tracking ? Kt * (TR - e.y) : 0.0;
        e.preInt = e.gI + tr;
        if (external) { e.v = pid.in(RoleExtAw, i); return; }
        e.v = ((clamped ? 0.0 : e.gI) + Kb * (e.y - e.yUnsat)) + tr;
    };
    if (state.forceIntegrator) {
        finish(state.forcedIntegrator, false);
        if (clamping && clampCondition(e.yUnsat, lo, up, e.gI)) finish(state.forcedIntegrator, true);
        return e;
    }
    if (pid.q == 0.0 || external) {
        // Saída do integrador independe da entrada atual (contínuo, Forward Euler) ou vem de extAW.
        const double Y = pid.q == 0.0 ? pid.clampIntegrator(state.xI, i) : pid.clampIntegrator(state.xI + pid.q * pid.in(RoleExtAw, i), i);
        finish(Y, false);
        const bool clamp = clamping && (state.clampMode >= 0 ? state.clampMode != 0 : clampCondition(e.yUnsat, lo, up, e.gI));
        if (clamp) finish(Y, true);
        return e;
    }
    // Backward Euler / Trapezoidal: laço algébrico resolvido de forma exata.
    const double A = pTerm + e.dOut;
    finish(solveIntegrator(pid, i, state.xI, A, e.gI, TR), false);
    if (clamping && clampCondition(e.yUnsat, lo, up, e.gI)) finish(solveIntegrator(pid, i, state.xI, A, 0.0, TR), true);
    return e;
}

// ---- configure ----------------------------------------------------------------------------------

KernelShape pidConfigure(const KernelConfig& c) {
    constexpr const char* kName = "PID Controller";
    const auto& ip = c.intParameters;
    if (ip.size() != static_cast<size_t>(PidPortBase + PidRoleCount)) fail("PID Controller: parametros internos invalidos");
    const auto n = static_cast<size_t>(ip[PidWidth]);
    if (n == 0 || n > 4096) fail("PID Controller: largura invalida");
    if (c.realParameters.size() != RpVectorCount * n + 2) fail("PID Controller: parametros com largura incompativel");
    const size_t outputs = n * (ip[PidPreInt] != 0 ? 2 : 1);
    if (c.outputWidth != outputs) fail("PID Controller: largura de saida incompativel");
    const bool discrete = ip[PidDiscrete] != 0;
    if (discrete && !(c.samplePeriod > 0.0)) fail("Discrete PID Controller: exige tempo de amostragem discreto");
    if (!discrete && c.samplePeriod != 0.0) fail("PID Controller: tempo continuo exige taxa continua");
    // Portas por papel: índices 0..k-1 distintos, na ordem das entradas do bloco.
    size_t expected = 0;
    for (int64_t role = 0; role < PidRoleCount; ++role) if (ip[PidPortBase + role] >= 0) ++expected;
    requireInputs(c, expected, kName);
    for (int64_t role = 0; role < PidRoleCount; ++role) {
        const int64_t port = ip[PidPortBase + role];
        if (port >= static_cast<int64_t>(expected)) fail("PID Controller: porta fora da faixa");
    }
    for (uint16_t width : c.inputWidths)
        if (width != 1 && width != n) fail("PID Controller: largura de entrada " + std::to_string(width) + " incompativel com " + std::to_string(n));
    const bool hasI = (ip[PidTerms] & TermI) != 0, hasD = (ip[PidTerms] & TermD) != 0;
    const bool filtered = ip[PidUseFilter] != 0;
    const double qF = discrete ? methodFraction(ip[PidFiltMethod]) * c.samplePeriod : 0.0;
    for (size_t i = 0; i < n; ++i) {
        const double N = c.realParameters[RpN * n + i];
        if (hasD && filtered && ip[PidPortBase + RoleN] < 0) {
            if (!std::isfinite(N)) fail("PID Controller: N = Inf nao e suportado (derivada ideal sem filtro); use um coeficiente finito");
            if (discrete && 1.0 + qF * N == 0.0) fail("PID Controller: filtro discreto singular (1 + N*Ts*fracao = 0)");
        }
        if (!std::isfinite(c.realParameters[RpIcI * n + i]) || !std::isfinite(c.realParameters[RpIcF * n + i]))
            fail("PID Controller: condicao inicial nao pode ser NaN ou Inf");
    }
    // Direct feedthrough real (a tabela da documentação diz "no", mas P e o termo D filtrado são
    // algébricos de u para y): só as entradas que afetam a saída do MESMO instante.
    const bool intDirect = discrete && hasI && ip[PidIntMethod] != 0;
    const bool preInt = ip[PidPreInt] != 0;
    // Clamping contínuo decide o modo no passo maior com I*e do mesmo instante.
    const bool clampDecision = !discrete && hasI && ip[PidLimit] != 0 && ip[PidAntiWindup] == AwClamping;
    const bool errorDirect = (ip[PidTerms] & (TermP | TermD)) != 0 || intDirect || preInt || clampDecision;
    std::vector<uint8_t> feedthrough(expected, 1);
    const auto set = [&](int64_t role, bool value) {
        const int64_t port = ip[PidPortBase + role];
        if (port >= 0) feedthrough[static_cast<size_t>(port)] = value ? 1 : 0;
    };
    set(RoleU, errorDirect);
    set(RoleY, errorDirect);
    set(RoleI, intDirect || preInt || clampDecision);
    set(RoleTr, intDirect || preInt);
    set(RoleExtAw, intDirect);
    return {discrete ? 0u : static_cast<uint32_t>(2 * n), static_cast<uint32_t>(4 * n + 1), feedthrough};
}

// ---- estados iniciais, reset ----------------------------------------------------------------------

double* stateI(KernelContext& k, const Pid& pid) { return pid.discrete ? k.d : k.x; }
double* stateF(KernelContext& k, const Pid& pid) { return pid.discrete ? k.d + pid.n : k.x + pid.n; }

void pidInit(KernelContext& k) {
    const Pid pid(k);
    const size_t n = pid.n;
    for (size_t i = 0; i < n; ++i) {
        // IC interna já no estado (a passada inicial sem efeito colateral mostra o valor certo);
        // IC externa é lida no primeiro passo maior.
        stateI(k, pid)[i] = pid.has(RoleI0) ? 0.0 : pid.clampIntegrator(pid.rp(RpIcI, i), i);
        stateF(k, pid)[i] = pid.has(RoleD0) ? 0.0 : pid.rp(RpIcF, i);
        k.d[2 * n + i] = 0.0;
        k.d[3 * n + i] = 0.0;
    }
    k.d[4 * n] = 0.0;
}

/** (Re)inicialização no passo maior: estado = IC (Auto) ou saída imposta = IC (Output, discreto). */
void applyInitialConditions(KernelContext& k, const Pid& pid, size_t i) {
    stateI(k, pid)[i] = pid.icIntegrator(i);
    stateF(k, pid)[i] = pid.icFilter(i);
    if (pid.discrete) k.d[3 * pid.n + i] = k.ip[PidIcOutput] != 0 ? 1.0 : 0.0;
}

PidState currentState(const KernelContext& k, const Pid& pid, size_t i) {
    PidState state;
    state.xI = pid.discrete ? k.d[i] : k.x[i];
    state.xF = pid.discrete ? k.d[pid.n + i] : k.x[pid.n + i];
    if (pid.discrete) {
        if (k.d[3 * pid.n + i] != 0.0) {
            state.forceIntegrator = pid.hasI;
            state.forcedIntegrator = pid.icIntegrator(i);
            state.forceFilter = pid.hasD && pid.filtered;
            state.forcedFilter = pid.icFilter(i);
        }
    } else {
        state.clampMode = k.d[3 * pid.n + i] != 0.0 ? 1 : 0;
    }
    return state;
}

void publish(const KernelContext& k, const Pid& pid, size_t i, const PidEval& e) {
    k.out[i] = e.y;
    if (k.ip[PidPreInt] != 0) k.out[pid.n + i] = e.preInt;
}

// ---- outputs / update / derivatives ---------------------------------------------------------------

void pidOutputs(KernelContext& k) {
    const Pid pid(k);
    const size_t n = pid.n;
    const auto mode = static_cast<ResetMode>(k.ip[PidResetMode]);
    for (size_t i = 0; i < n; ++i) {
        if (k.major) {
            const bool first = k.d[4 * n] == 0.0;
            const bool reset = mode != ResetMode::None && pid.has(RoleReset) && resetTriggered(mode, k.d[2 * n + i], pid.in(RoleReset, i));
            if (first || reset) applyInitialConditions(k, pid, i);
            else if (pid.discrete) k.d[3 * n + i] = 0.0;
            if (!pid.discrete && pid.limitIntegrator) k.x[i] = pid.clampIntegrator(k.x[i], i);
        }
        PidState state = currentState(k, pid, i);
        if (!pid.discrete && k.major) state.clampMode = -1; // decide o modo do próximo intervalo
        const PidEval e = evaluate(pid, i, state);
        if (!pid.discrete && k.major && pid.hasI && pid.limit && pid.antiWindup == AwClamping)
            k.d[3 * n + i] = clampCondition(e.yUnsat, pid.lower(i), pid.upper(i), e.gI) ? 1.0 : 0.0;
        publish(k, pid, i, e);
    }
}

void pidUpdate(KernelContext& k) {
    const Pid pid(k);
    const size_t n = pid.n;
    for (size_t i = 0; i < n; ++i) {
        if (pid.discrete) {
            const PidEval e = evaluate(pid, i, currentState(k, pid, i));
            if (pid.hasI) k.d[i] = pid.clampIntegrator(e.integral + (pid.s - pid.q) * e.v, i);
            if (pid.hasD) k.d[n + i] = pid.filtered ? e.fOut + (k.ts - pid.qF) * e.dOut : e.scaled;
            k.d[3 * n + i] = 0.0;
        }
        if (pid.has(RoleReset)) k.d[2 * n + i] = pid.in(RoleReset, i);
    }
    k.d[4 * n] = 1.0;
}

void pidDerivatives(KernelContext& k) {
    const Pid pid(k);
    const size_t n = pid.n;
    const bool levelHold = static_cast<ResetMode>(k.ip[PidResetMode]) == ResetMode::Level && pid.has(RoleReset);
    for (size_t i = 0; i < n; ++i) {
        const PidEval e = evaluate(pid, i, currentState(k, pid, i));
        double dxI = pid.hasI ? e.v : 0.0;
        if (pid.limitIntegrator && ((k.x[i] >= pid.intUpper(i) && dxI > 0.0) || (k.x[i] <= pid.intLower(i) && dxI < 0.0))) dxI = 0.0;
        double dxF = pid.hasD ? e.dOut : 0.0;
        // Reset "level": estados presos na condição inicial enquanto o sinal for não nulo.
        if (levelHold && pid.in(RoleReset, i) != 0.0) dxI = dxF = 0.0;
        k.dx[i] = dxI;
        k.dx[n + i] = dxF;
    }
}

const KernelSpec kPid{"pid", pidConfigure, pidInit, pidOutputs, pidUpdate, pidDerivatives, nullptr};
const KernelSpec* const kPidKernels[] = {&kPid};
} // namespace

std::span<const KernelSpec* const> pidKernels() { return kPidKernels; }

} // namespace lasecsimul::simulation::library
