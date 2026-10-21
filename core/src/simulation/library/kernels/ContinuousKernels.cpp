// Blocos de tempo contínuo (biblioteca Continuous). Estados contínuos são integrados pela partição
// contínua acoplada do SignalRuntime (RK4 com duplicação de passo, docs/66 §4.2); aqui ficam só as
// equações de saída e de derivada de cada bloco.
//
// Sem localização de cruzamento por zero (docs/66, AGENT-GUIDE): limites, saturações, resets e
// trocas de modo são aplicados no passo MAIOR (`major`), com o modo congelado nos estágios do RK4 --
// o mesmo que o Simulink faz com a detecção de cruzamento por zero desligada.
#include <algorithm>
#include <cmath>

#include "../KernelCommon.hpp"
#include "Families.hpp"
#include "ResetEdge.hpp"

namespace lasecsimul::simulation::library {
namespace {
using namespace detail;

double wrapValue(double x, double lower, double upper) {
    if (!std::isfinite(lower) || !std::isfinite(upper) || !(upper > lower)) return x;
    if (x >= lower && x < upper) return x;
    return x - (upper - lower) * std::floor((x - lower) / (upper - lower));
}

bool levelMode(int64_t mode) {
    return mode == static_cast<int64_t>(ResetMode::Level) || mode == static_cast<int64_t>(ResetMode::LevelHold);
}

// ---- Integrator --------------------------------------------------------------------------------
// ip = [n, limit, resetMode, icExternal, wrap, showSaturation, showState]
// rp = [IC x n, Upper x n, Lower x n, WrapUpper, WrapLower]   (limites do wrap escalares) ou
//      [IC x n, Upper x n, Lower x n, WrapUpper x n, WrapLower x n] (limites do wrap por elemento)
// Entradas: u, [reset] (se resetMode != none), [x0] (se icExternal). Saída: [y | sat | state].
// d = [resetAnterior x n, inicializado]
// dx/dt = u; y = x. Limite: y = clamp(x) e a integração para quando o estado está no limite e a
// entrada empurra para fora (anti-windup). Wrap: y = x - (xu - xl)*floor((x - xl)/(xu - xl)).
// Reset (no passo maior): x = condição inicial (parâmetro ou porta x0). Nos modos level/level hold
// o estado fica PRESO na condição inicial enquanto o reset do último passo maior for não nulo.
// Porta de estado: igual à saída, exceto no passo do reset (mostra o valor sem o reset).
enum IntegratorIp { IntN = 0, IntLimit, IntReset, IntIcExternal, IntWrap, IntShowSat, IntShowState, IntIpCount };

bool integratorVectorWrap(size_t rpCount, size_t n) { return n > 1 && rpCount == 5 * n; }

KernelShape integratorConfigure(const KernelConfig& c) {
    if (c.intParameters.size() != IntIpCount) fail("Integrator: parametros internos invalidos");
    const size_t n = static_cast<size_t>(c.intParameters[IntN]);
    const size_t expectedInputs = 1 + (c.intParameters[IntReset] != 0 ? 1 : 0) + (c.intParameters[IntIcExternal] != 0 ? 1 : 0);
    requireInputs(c, expectedInputs, "Integrator");
    if (c.realParameters.size() != 3 * n + 2 && c.realParameters.size() != 5 * n) fail("Integrator: parametros com largura incompativel");
    const size_t outputs = n * (1 + (c.intParameters[IntShowSat] != 0 ? 1 : 0) + (c.intParameters[IntShowState] != 0 ? 1 : 0));
    if (c.outputWidth != outputs) fail("Integrator: largura de saida incompativel");
    for (uint16_t w : c.inputWidths) if (w != 1 && w != n) fail("Integrator: largura de entrada incompativel");
    for (size_t i = 0; i < n; ++i) {
        const double ic = c.realParameters[i];
        if (!std::isfinite(ic)) fail("Integrator: Initial condition nao pode ser Inf ou NaN");
        if (c.intParameters[IntLimit] != 0) {
            const double upper = c.realParameters[n + i], lower = c.realParameters[2 * n + i];
            if (lower > upper) fail("Integrator: Lower saturation limit maior que Upper saturation limit");
            if (c.intParameters[IntIcExternal] == 0 && (ic > upper || ic < lower))
                fail("Integrator: Initial condition fora dos limites de saturacao");
        }
    }
    std::vector<uint8_t> feedthrough{0};
    if (c.intParameters[IntReset] != 0) feedthrough.push_back(1);
    if (c.intParameters[IntIcExternal] != 0) feedthrough.push_back(1);
    return {static_cast<uint32_t>(n), static_cast<uint32_t>(n + 1), feedthrough};
}

void integratorInit(KernelContext& k) {
    const size_t n = static_cast<size_t>(k.ip[IntN]);
    for (size_t i = 0; i < n; ++i) { k.x[i] = k.rp[i]; k.d[i] = 0.0; }
    k.d[n] = k.ip[IntIcExternal] != 0 ? 0.0 : 1.0;
}

uint16_t integratorX0Port(const KernelContext& k) { return static_cast<uint16_t>(k.ip[IntReset] != 0 ? 2 : 1); }

void integratorOutputs(KernelContext& k) {
    const size_t n = static_cast<size_t>(k.ip[IntN]);
    const bool limit = k.ip[IntLimit] != 0, wrap = k.ip[IntWrap] != 0;
    const bool vectorWrap = integratorVectorWrap(k.rpCount, n);
    const auto initialCondition = [&](size_t i) {
        return k.ip[IntIcExternal] != 0 ? k.input(integratorX0Port(k), static_cast<uint16_t>(i)) : k.rp[i];
    };
    if (k.major && k.d[n] == 0.0) {
        for (size_t i = 0; i < n; ++i) k.x[i] = initialCondition(i);
        k.d[n] = 1.0;
    }
    const size_t satOffset = n;
    const size_t stateOffset = n * (k.ip[IntShowSat] != 0 ? 2 : 1);
    for (size_t i = 0; i < n; ++i) {
        const double upper = k.rp[n + i], lower = k.rp[2 * n + i];
        const double wrapUpper = vectorWrap ? k.rp[3 * n + i] : k.rp[3 * n];
        const double wrapLower = vectorWrap ? k.rp[4 * n + i] : k.rp[3 * n + 1];
        const auto shape = [&](double value) {
            if (limit) value = std::clamp(value, lower, upper);
            if (wrap) value = wrapValue(value, wrapLower, wrapUpper);
            return value;
        };
        const double unreset = shape(k.x[i]);
        double x = unreset;
        if (k.major && k.ip[IntReset] != 0 &&
            resetTriggered(static_cast<ResetMode>(k.ip[IntReset]), k.d[i], k.input(1, static_cast<uint16_t>(i))))
            x = shape(initialCondition(i));
        if (k.major) k.x[i] = x;
        k.out[i] = x;
        if (k.ip[IntShowSat] != 0) k.out[satOffset + i] = !limit ? 0.0 : x >= upper ? 1.0 : x <= lower ? -1.0 : 0.0;
        if (k.ip[IntShowState] != 0) k.out[stateOffset + i] = unreset;
    }
}

void integratorUpdate(KernelContext& k) {
    const size_t n = static_cast<size_t>(k.ip[IntN]);
    if (k.ip[IntReset] == 0) return;
    for (size_t i = 0; i < n; ++i) k.d[i] = k.input(1, static_cast<uint16_t>(i));
}

void integratorDerivatives(KernelContext& k) {
    const size_t n = static_cast<size_t>(k.ip[IntN]);
    const bool limit = k.ip[IntLimit] != 0;
    const bool held = levelMode(k.ip[IntReset]);
    for (size_t i = 0; i < n; ++i) {
        const double u = k.input(0, static_cast<uint16_t>(i));
        double derivative = u;
        if (limit) {
            const double upper = k.rp[n + i], lower = k.rp[2 * n + i];
            if ((k.x[i] >= upper && u > 0.0) || (k.x[i] <= lower && u < 0.0)) derivative = 0.0;
        }
        // Reset por nível ativo no último passo maior: o estado fica na condição inicial.
        if (held && k.d[i] != 0.0) derivative = 0.0;
        k.dx[i] = derivative;
    }
}

// ---- Second-Order Integrator --------------------------------------------------------------------
// d2x/dt2 = u com dois estados ligados: x e v = dx/dt (dx/dt = v, dv/dt = u).
// ip = [n, limitX, limitDX, wrapX, resetMode, icXExterno, icDXExterno, mostraX, mostraDX, reinit]
// rp = [ICX x n, ICDX x n, UpX x n, LoX x n, UpDX x n, LoDX x n, WrapUp x n, WrapLo x n]
// Entradas: u, [x0], [dx0], [reset]. Saída: [x | dx] conforme Show output.
// Estados contínuos: [x x n, v x n]. d = [resetAnterior x n, situacaoX x n (-1/0/1), inicializado].
// Regras documentadas: x no limite segura x e zera dx/dt (para sair do limite superior dx/dt tem de
// ficar negativo, do inferior positivo); dx/dt no limite fica preso e x segue dx/dt = L; com os dois
// limitados o comportamento de x tem precedência; "Reinitialize dx/dt when x reaches saturation"
// recoloca dx/dt na sua condição inicial no instante em que x atinge o limite, se ela tirar x do
// limite imediatamente. Condições iniciais fora dos limites vão para o valor válido mais próximo e
// formam um par consistente. O reset (rising/falling/either) volta os dois estados às condições
// iniciais.
enum SoiIp { SoiN = 0, SoiLimitX, SoiLimitDX, SoiWrap, SoiReset, SoiIcXExt, SoiIcDXExt, SoiShowX, SoiShowDX, SoiReinit, SoiIpCount };

struct SoiView {
    const KernelContext& k;
    size_t n;
    double rp(size_t block, size_t i) const { return k.rp[block * n + i]; }
    double upX(size_t i) const { return rp(2, i); }
    double loX(size_t i) const { return rp(3, i); }
    double upDX(size_t i) const { return rp(4, i); }
    double loDX(size_t i) const { return rp(5, i); }
    bool limitX() const { return k.ip[SoiLimitX] != 0; }
    bool limitDX() const { return k.ip[SoiLimitDX] != 0; }
    uint16_t x0Port() const { return 1; }
    uint16_t dx0Port() const { return static_cast<uint16_t>(1 + (k.ip[SoiIcXExt] != 0 ? 1 : 0)); }
    uint16_t resetPort() const { return static_cast<uint16_t>(1 + (k.ip[SoiIcXExt] != 0 ? 1 : 0) + (k.ip[SoiIcDXExt] != 0 ? 1 : 0)); }
    double icX(size_t i) const { return k.ip[SoiIcXExt] != 0 ? k.input(x0Port(), static_cast<uint16_t>(i)) : rp(0, i); }
    double icDX(size_t i) const { return k.ip[SoiIcDXExt] != 0 ? k.input(dx0Port(), static_cast<uint16_t>(i)) : rp(1, i); }
    double clampDX(size_t i, double v) const { return limitDX() ? std::clamp(v, loDX(i), upDX(i)) : v; }
    /** Par (x, v) consistente com os limites (precedência de x). */
    void consistent(size_t i, double& x, double& v) const {
        v = clampDX(i, v);
        if (limitX()) {
            x = std::clamp(x, loX(i), upX(i));
            if ((x >= upX(i) && v > 0.0) || (x <= loX(i) && v < 0.0)) v = 0.0;
        }
        if (k.ip[SoiWrap] != 0) x = wrapValue(x, rp(7, i), rp(6, i));
    }
};

KernelShape soiConfigure(const KernelConfig& c) {
    if (c.intParameters.size() != SoiIpCount) fail("Second-Order Integrator: parametros internos invalidos");
    const size_t n = static_cast<size_t>(c.intParameters[SoiN]);
    const bool icX = c.intParameters[SoiIcXExt] != 0, icDX = c.intParameters[SoiIcDXExt] != 0, reset = c.intParameters[SoiReset] != 0;
    requireInputs(c, 1 + (icX ? 1 : 0) + (icDX ? 1 : 0) + (reset ? 1 : 0), "Second-Order Integrator");
    if (c.realParameters.size() != 8 * n) fail("Second-Order Integrator: parametros com largura incompativel");
    const size_t shown = (c.intParameters[SoiShowX] != 0 ? 1 : 0) + (c.intParameters[SoiShowDX] != 0 ? 1 : 0);
    if (shown == 0) fail("Second-Order Integrator: ao menos uma saida (x ou dx/dt) precisa ser mostrada");
    if (c.outputWidth != shown * n) fail("Second-Order Integrator: largura de saida incompativel");
    for (uint16_t w : c.inputWidths) if (w != 1 && w != n) fail("Second-Order Integrator: largura de entrada incompativel");
    const auto at = [&](size_t block, size_t i) { return c.realParameters[block * n + i]; };
    for (size_t i = 0; i < n; ++i) {
        if (!std::isfinite(at(0, i)) || !std::isfinite(at(1, i))) fail("Second-Order Integrator: condicoes iniciais nao podem ser Inf ou NaN");
        if (c.intParameters[SoiLimitX] != 0 && !(at(2, i) > at(3, i))) fail("Second-Order Integrator: Upper limit x deve ser estritamente maior que Lower limit x");
        if (c.intParameters[SoiLimitDX] != 0 && !(at(4, i) > at(5, i))) fail("Second-Order Integrator: Upper limit dx/dt deve ser estritamente maior que Lower limit dx/dt");
        if (c.intParameters[SoiLimitX] != 0 && c.intParameters[SoiLimitDX] != 0 && !(at(4, i) > 0.0 && at(5, i) < 0.0))
            fail("Second-Order Integrator: com x limitado, o limite superior de dx/dt deve ser > 0 e o inferior < 0");
    }
    std::vector<uint8_t> feedthrough{0};
    if (icX) feedthrough.push_back(1);
    if (icDX) feedthrough.push_back(1);
    if (reset) feedthrough.push_back(1);
    return {static_cast<uint32_t>(2 * n), static_cast<uint32_t>(2 * n + 1), feedthrough};
}

void soiInit(KernelContext& k) {
    const SoiView s{k, static_cast<size_t>(k.ip[SoiN])};
    for (size_t i = 0; i < s.n; ++i) {
        double x = s.rp(0, i), v = s.rp(1, i);
        s.consistent(i, x, v);
        k.x[i] = x;
        k.x[s.n + i] = v;
        k.d[i] = 0.0;
        k.d[s.n + i] = !s.limitX() ? 0.0 : x >= s.upX(i) ? 1.0 : x <= s.loX(i) ? -1.0 : 0.0;
    }
    k.d[2 * s.n] = (k.ip[SoiIcXExt] != 0 || k.ip[SoiIcDXExt] != 0) ? 0.0 : 1.0;
}

void soiOutputs(KernelContext& k) {
    const SoiView s{k, static_cast<size_t>(k.ip[SoiN])};
    const size_t n = s.n;
    if (k.major && k.d[2 * n] == 0.0) {
        for (size_t i = 0; i < n; ++i) {
            double x = s.icX(i), v = s.icDX(i);
            s.consistent(i, x, v);
            k.x[i] = x;
            k.x[n + i] = v;
        }
        k.d[2 * n] = 1.0;
    }
    const bool showX = k.ip[SoiShowX] != 0;
    for (size_t i = 0; i < n; ++i) {
        double x = k.x[i], v = k.x[n + i];
        if (k.major) {
            if (k.ip[SoiReset] != 0 &&
                resetTriggered(static_cast<ResetMode>(k.ip[SoiReset]), k.d[i], k.input(s.resetPort(), static_cast<uint16_t>(i)))) {
                x = s.icX(i);
                v = s.icDX(i);
                s.consistent(i, x, v);
            } else {
                v = s.clampDX(i, v);
                if (s.limitX()) {
                    const double status = x >= s.upX(i) ? 1.0 : x <= s.loX(i) ? -1.0 : 0.0;
                    x = std::clamp(x, s.loX(i), s.upX(i));
                    if (status != 0.0) {
                        const bool reached = k.d[n + i] != status;
                        const double ic = s.clampDX(i, s.icDX(i));
                        if (reached && k.ip[SoiReinit] != 0 && ((status > 0.0 && ic < 0.0) || (status < 0.0 && ic > 0.0))) v = ic;
                        else if ((status > 0.0 && v > 0.0) || (status < 0.0 && v < 0.0)) v = 0.0;
                    }
                    k.d[n + i] = status;
                }
                if (k.ip[SoiWrap] != 0) x = wrapValue(x, s.rp(7, i), s.rp(6, i));
            }
            k.x[i] = x;
            k.x[n + i] = v;
            if (s.limitX()) k.d[n + i] = x >= s.upX(i) ? 1.0 : x <= s.loX(i) ? -1.0 : 0.0;
        } else {
            v = s.clampDX(i, v);
            if (s.limitX()) x = std::clamp(x, s.loX(i), s.upX(i));
            if (k.ip[SoiWrap] != 0) x = wrapValue(x, s.rp(7, i), s.rp(6, i));
        }
        if (showX) k.out[i] = x;
        if (k.ip[SoiShowDX] != 0) k.out[(showX ? n : 0) + i] = v;
    }
}

void soiUpdate(KernelContext& k) {
    const SoiView s{k, static_cast<size_t>(k.ip[SoiN])};
    if (k.ip[SoiReset] == 0) return;
    for (size_t i = 0; i < s.n; ++i) k.d[i] = k.input(s.resetPort(), static_cast<uint16_t>(i));
}

void soiDerivatives(KernelContext& k) {
    const SoiView s{k, static_cast<size_t>(k.ip[SoiN])};
    const size_t n = s.n;
    for (size_t i = 0; i < n; ++i) {
        const double u = k.input(0, static_cast<uint16_t>(i));
        const double x = k.x[i], vRaw = k.x[n + i];
        double v = s.clampDX(i, vRaw);
        double dv = u;
        if (s.limitDX() && ((vRaw >= s.upDX(i) && u > 0.0) || (vRaw <= s.loDX(i) && u < 0.0))) dv = 0.0;
        if (s.limitX()) {
            if (x >= s.upX(i)) { v = std::min(v, 0.0); if (vRaw <= 0.0) dv = std::min(dv, 0.0); }
            else if (x <= s.loX(i)) { v = std::max(v, 0.0); if (vRaw >= 0.0) dv = std::max(dv, 0.0); }
        }
        k.dx[i] = v;
        k.dx[n + i] = dv;
    }
}

// ---- State-Space (contínuo) e Discrete State-Space -----------------------------------------------
// ip = [n, m, p]; rp = [A (n x n), B (n x m), C (p x n), D (p x m), x0 (n)], tudo em ordem de linha.
// Contínuo: dx/dt = Ax + Bu, y = Cx + Du. Discreto: x[k+1] = Ax[k] + Bu[k], y = Cx[k] + Du[k].
// Transfer Fcn, Zero-Pole e Descriptor State-Space (E não singular ou índice 1, reduzido no
// builder) compilam para o kernel contínuo; Fixed-Point State-Space para o discreto.
struct Dims { size_t n, m, p; };
Dims ssDims(const int64_t* ip) { return {static_cast<size_t>(ip[0]), static_cast<size_t>(ip[1]), static_cast<size_t>(ip[2])}; }

KernelShape ssShape(const KernelConfig& c, bool continuous) {
    requireInputs(c, 1, continuous ? "State-Space" : "Discrete State-Space");
    if (c.intParameters.size() != 3) fail("State-Space: parametros internos invalidos");
    const auto n = static_cast<size_t>(c.intParameters[0]), m = static_cast<size_t>(c.intParameters[1]), p = static_cast<size_t>(c.intParameters[2]);
    if (c.realParameters.size() != n * n + n * m + p * n + p * m + n) fail("State-Space: matrizes A, B, C, D com dimensoes incompativeis");
    if (c.inputWidths[0] != m && !(m == 1 && c.inputWidths[0] == 1)) fail("State-Space: largura da entrada difere do numero de colunas de B/D");
    if (c.outputWidth != p) fail("State-Space: largura da saida difere do numero de linhas de C/D");
    for (double value : c.realParameters) if (!std::isfinite(value)) fail("State-Space: matrizes e condicoes iniciais devem ser finitas");
    bool feedthrough = false;
    for (size_t i = n * n + n * m + p * n; i < n * n + n * m + p * n + p * m; ++i) feedthrough = feedthrough || c.realParameters[i] != 0.0;
    return {continuous ? static_cast<uint32_t>(n) : 0u, continuous ? 0u : static_cast<uint32_t>(2 * n), {static_cast<uint8_t>(feedthrough ? 1 : 0)}};
}
KernelShape ssConfigure(const KernelConfig& c) { return ssShape(c, true); }
KernelShape dssConfigure(const KernelConfig& c) { return ssShape(c, false); }

void ssOutput(const KernelContext& k, const double* x) {
    const Dims d = ssDims(k.ip);
    const double* C = k.rp + d.n * d.n + d.n * d.m;
    const double* D = C + d.p * d.n;
    for (size_t r = 0; r < d.p; ++r) {
        double y = 0.0;
        for (size_t s = 0; s < d.n; ++s) y += C[r * d.n + s] * x[s];
        for (size_t u = 0; u < d.m; ++u) y += D[r * d.m + u] * k.input(0, static_cast<uint16_t>(u));
        k.out[r] = y;
    }
}
void ssStateDerivative(const KernelContext& k, const double* x, double* next) {
    const Dims d = ssDims(k.ip);
    const double* A = k.rp;
    const double* B = A + d.n * d.n;
    for (size_t r = 0; r < d.n; ++r) {
        double value = 0.0;
        for (size_t s = 0; s < d.n; ++s) value += A[r * d.n + s] * x[s];
        for (size_t u = 0; u < d.m; ++u) value += B[r * d.m + u] * k.input(0, static_cast<uint16_t>(u));
        next[r] = value;
    }
}
const double* ssX0(const KernelContext& k) { const Dims d = ssDims(k.ip); return k.rp + d.n * d.n + d.n * d.m + d.p * d.n + d.p * d.m; }

void ssInit(KernelContext& k) { const Dims d = ssDims(k.ip); std::copy_n(ssX0(k), d.n, k.x); }
void ssOutputs(KernelContext& k) { ssOutput(k, k.x); }
void ssDerivatives(KernelContext& k) { ssStateDerivative(k, k.x, k.dx); }

// Discreto: d = [x x n, rascunho x n] (o rascunho evita alocar no passo e não limita a ordem).
void dssInit(KernelContext& k) { const Dims d = ssDims(k.ip); std::copy_n(ssX0(k), d.n, k.d); }
void dssOutputs(KernelContext& k) { ssOutput(k, k.d); }
void dssUpdate(KernelContext& k) {
    const Dims d = ssDims(k.ip);
    double* next = k.d + d.n;
    ssStateDerivative(k, k.d, next);
    std::copy_n(next, d.n, k.d);
}

// ---- Transport Delay ----------------------------------------------------------------------------
// ip = [n, capacidade, delayNs, (bufferFixo)]; rp = [DelayTime, InitialOutput x n]
// d = [inicio, quantidade, sobrescrito, (tNs, u x n) x capacidade]. y = InitialOutput enquanto
// t < DelayTime; depois u(t - DelayTime) por interpolação linear entre os pontos guardados nos
// passos maiores. Um sinal que muda numa ativação discreta é guardado com os DOIS limites laterais
// no mesmo instante, então entrada discreta sai exata (a documentação: "Discrete input signals are
// not interpolated: the discrete value at the required time is returned"). Buffer cheio: o mais
// antigo é sobrescrito; consulta anterior ao mais antigo extrapola linearmente (buffer fixo, como a
// documentação) ou segura o mais antigo (buffer que no Simulink cresceria -- aqui nasce no bind()).
enum DelayIp { DelN = 0, DelCapacity, DelNs, DelFixed, DelIpCount };
constexpr size_t kDelayHeader = 3;

KernelShape delayConfigure(const KernelConfig& c) {
    requireInputs(c, 1, "Transport Delay");
    if (c.intParameters.size() != DelIpCount && c.intParameters.size() != DelIpCount - 1) fail("Transport Delay: parametros internos invalidos");
    const auto n = static_cast<size_t>(c.intParameters[DelN]);
    const auto capacity = static_cast<size_t>(c.intParameters[DelCapacity]);
    if (c.realParameters.size() != 1 + n || c.outputWidth != n || (c.inputWidths[0] != n && c.inputWidths[0] != 1))
        fail("Transport Delay: larguras incompativeis");
    if (!(c.realParameters[0] >= 0.0) || !std::isfinite(c.realParameters[0])) fail("Transport Delay: Time delay deve ser >= 0");
    for (size_t i = 0; i < n; ++i)
        if (!std::isfinite(c.realParameters[1 + i])) fail("Transport Delay: Initial output nao pode ser Inf ou NaN");
    if (capacity < 2 || capacity > (1u << 22)) fail("Transport Delay: tamanho de buffer invalido");
    const bool zeroDelay = c.intParameters[DelNs] == 0;
    return {0, static_cast<uint32_t>(kDelayHeader + capacity * (1 + n)), {static_cast<uint8_t>(zeroDelay ? 1 : 0)}};
}
void delayInit(KernelContext& k) { k.d[0] = 0.0; k.d[1] = 0.0; k.d[2] = 0.0; }

struct DelayRing {
    double* d; size_t n, capacity;
    size_t head() const { return static_cast<size_t>(d[0]); }
    size_t count() const { return static_cast<size_t>(d[1]); }
    bool overwritten() const { return d[2] != 0.0; }
    double* record(size_t index) const { return d + kDelayHeader + ((head() + index) % capacity) * (1 + n); }
    /** Primeiro registro com tempo > query (busca binária no anel). */
    size_t upper(double query) const {
        size_t lo = 0, hi = count();
        while (lo < hi) { const size_t mid = (lo + hi) / 2; if (record(mid)[0] <= query) lo = mid + 1; else hi = mid; }
        return lo;
    }
    /** Guarda (tNs, valores) no fim, sobrescrevendo o mais antigo com o anel cheio. */
    void push(uint64_t tNs, const double* values, size_t width) {
        if (count() > 0) {
            const double* last = record(count() - 1);
            bool same = last[0] == static_cast<double>(tNs);
            for (size_t i = 0; same && i < width; ++i) same = last[1 + i] == values[i];
            if (same) return;
        }
        if (count() == capacity) { d[0] = static_cast<double>((head() + 1) % capacity); d[1] -= 1.0; d[2] = 1.0; }
        double* slot = record(count());
        slot[0] = static_cast<double>(tNs);
        std::copy_n(values, width, slot + 1);
        d[1] += 1.0;
    }
};

void delayOutputs(KernelContext& k) {
    const auto n = static_cast<size_t>(k.ip[DelN]);
    const auto delayNs = static_cast<uint64_t>(k.ip[DelNs]);
    if (delayNs == 0) { for (size_t i = 0; i < n; ++i) k.out[i] = k.input(0, static_cast<uint16_t>(i)); return; }
    const DelayRing ring{k.d, n, static_cast<size_t>(k.ip[DelCapacity])};
    const auto initial = [&] { for (size_t i = 0; i < n; ++i) k.out[i] = k.rp[1 + i]; };
    if (k.tNs < delayNs || ring.count() == 0) { initial(); return; }
    const double query = static_cast<double>(k.tNs - delayNs);
    const size_t lo = ring.upper(query);
    if (lo == 0) {
        if (!ring.overwritten()) { initial(); return; }
        const double* first = ring.record(0);
        const bool fixed = k.ipCount > DelFixed && k.ip[DelFixed] != 0;
        if (!fixed || ring.count() < 2) { for (size_t i = 0; i < n; ++i) k.out[i] = first[1 + i]; return; }
        const double* second = ring.record(1);
        const double span = second[0] - first[0];
        const double alpha = span > 0.0 ? (query - first[0]) / span : 0.0;
        for (size_t i = 0; i < n; ++i) k.out[i] = first[1 + i] + alpha * (second[1 + i] - first[1 + i]);
        return;
    }
    // Salto (dois registros no mesmo instante) exatamente na consulta: o valor novo só vale depois
    // do passo maior em que o salto atrasado chega (`majorNs`); antes disso, limite à esquerda.
    if (ring.record(lo - 1)[0] == query && static_cast<uint64_t>(query) + delayNs > k.majorNs) {
        size_t first = lo - 1;
        while (first > 0 && ring.record(first - 1)[0] == query) --first;
        const double* at = ring.record(first);
        for (size_t i = 0; i < n; ++i) k.out[i] = at[1 + i];
        return;
    }
    const double* left = ring.record(lo - 1);
    if (lo == ring.count()) { for (size_t i = 0; i < n; ++i) k.out[i] = left[1 + i]; return; }
    const double* right = ring.record(lo);
    const double span = right[0] - left[0];
    const double alpha = span > 0.0 ? (query - left[0]) / span : 1.0;
    for (size_t i = 0; i < n; ++i) k.out[i] = left[1 + i] + alpha * (right[1 + i] - left[1 + i]);
}

void delayUpdate(KernelContext& k) {
    const auto n = static_cast<size_t>(k.ip[DelN]);
    if (k.ip[DelNs] == 0) return;
    DelayRing ring{k.d, n, static_cast<size_t>(k.ip[DelCapacity])};
    double values[1];
    if (n == 1) { values[0] = k.input(0, 0); ring.push(k.tNs, values, 1); return; }
    // Largura > 1: grava direto no slot (sem buffer temporário).
    if (ring.count() > 0) {
        const double* last = ring.record(ring.count() - 1);
        bool same = last[0] == static_cast<double>(k.tNs);
        for (size_t i = 0; same && i < n; ++i) same = last[1 + i] == k.input(0, static_cast<uint16_t>(i));
        if (same) return;
    }
    if (ring.count() == ring.capacity) { k.d[0] = static_cast<double>((ring.head() + 1) % ring.capacity); k.d[1] -= 1.0; k.d[2] = 1.0; }
    double* slot = ring.record(ring.count());
    slot[0] = static_cast<double>(k.tNs);
    for (size_t i = 0; i < n; ++i) slot[1 + i] = k.input(0, static_cast<uint16_t>(i));
    k.d[1] += 1.0;
}

uint64_t delayBreakpoint(const KernelContext& k) {
    const auto delayNs = static_cast<uint64_t>(k.ip[DelNs]);
    if (delayNs == 0) return kNoBreakpoint;
    if (k.tNs < delayNs) return delayNs;
    const DelayRing ring{k.d, static_cast<size_t>(k.ip[DelN]), static_cast<size_t>(k.ip[DelCapacity])};
    const size_t lo = ring.upper(static_cast<double>(k.tNs - delayNs));
    if (lo == ring.count()) return kNoBreakpoint;
    return static_cast<uint64_t>(ring.record(lo)[0]) + delayNs;
}

// ---- Variable Time Delay / Variable Transport Delay ----------------------------------------------
// ip = [n, capacidade, transporte(0/1), zeroDelay]; rp = [MaximumDelay x n, InitialOutput x n]
// Entradas: u (dado), t0 (atraso, modo tempo) ou ti (atraso instantâneo, modo transporte).
// Estados contínuos (só transporte): s x n, ds/dt = 1/ti(t) (ti >= kMinTi).
// d = [inicio, quantidade, sobrescrito, (tNs, u x n, s x n) x capacidade].
// Modo tempo: y(t) = u(t - tau(t)), tau = clamp(t0, 0, MaximumDelay); interpolação linear entre os
// pontos guardados; consulta posterior ao último ponto segura o último ponto (a documentação: com
// atraso menor que o passo o bloco extrapola a partir de um ponto anterior) ou, com Handle zero
// delay, interpola até a entrada atual (passagem direta). y = InitialOutput enquanto t - tau < 0.
// Modo transporte: td(t) resolve integral_{t-td}^{t} 1/ti = 1, i.e. s(t - td) = s(t) - 1; td é
// limitado a MaximumDelay; y = InitialOutput enquanto s(t) < 1 (nada completou o trânsito).
enum VarDelayIp { VdN = 0, VdCapacity, VdTransport, VdZeroDelay, VdIpCount };
constexpr double kMinTi = 1e-6;

struct VarRing {
    double* d; size_t n, capacity;
    size_t stride() const { return 1 + 2 * n; }
    size_t head() const { return static_cast<size_t>(d[0]); }
    size_t count() const { return static_cast<size_t>(d[1]); }
    bool overwritten() const { return d[2] != 0.0; }
    double* record(size_t index) const { return d + kDelayHeader + ((head() + index) % capacity) * stride(); }
    double time(size_t index) const { return record(index)[0]; }
    double u(size_t index, size_t i) const { return record(index)[1 + i]; }
    double s(size_t index, size_t i) const { return record(index)[1 + n + i]; }
};

KernelShape varDelayConfigure(const KernelConfig& c) {
    requireInputs(c, 2, "Variable Time Delay");
    if (c.intParameters.size() != VdIpCount) fail("Variable Time Delay: parametros internos invalidos");
    const auto n = static_cast<size_t>(c.intParameters[VdN]);
    const auto capacity = static_cast<size_t>(c.intParameters[VdCapacity]);
    if (c.realParameters.size() != 2 * n || c.outputWidth != n) fail("Variable Time Delay: larguras incompativeis");
    for (uint16_t w : c.inputWidths) if (w != 1 && w != n) fail("Variable Time Delay: largura de entrada incompativel");
    for (size_t i = 0; i < n; ++i) {
        if (!(c.realParameters[i] >= 0.0) || !std::isfinite(c.realParameters[i])) fail("Variable Time Delay: Maximum delay deve ser >= 0 e finito");
        if (!std::isfinite(c.realParameters[n + i])) fail("Variable Time Delay: Initial output nao pode ser Inf ou NaN");
    }
    if (capacity < 2 || capacity > (1u << 22)) fail("Variable Time Delay: tamanho de buffer invalido");
    const bool transport = c.intParameters[VdTransport] != 0;
    const bool zeroDelay = !transport && c.intParameters[VdZeroDelay] != 0;
    return {transport ? static_cast<uint32_t>(n) : 0u, static_cast<uint32_t>(kDelayHeader + capacity * (1 + 2 * n)),
            {static_cast<uint8_t>(zeroDelay ? 1 : 0), 1}};
}
void varDelayInit(KernelContext& k) {
    k.d[0] = k.d[1] = k.d[2] = 0.0;
    if (k.ip[VdTransport] != 0) for (int64_t i = 0; i < k.ip[VdN]; ++i) k.x[i] = 0.0;
}

/** u(qNs) do elemento i por interpolação no tempo (modo tempo e limite de atraso máximo). */
double varDelayAtTime(const KernelContext& k, const VarRing& ring, size_t i, double qNs, bool zeroDelay) {
    const double initial = k.rp[ring.n + i];
    const double now = k.input(0, static_cast<uint16_t>(i));
    if (qNs < 0.0) return initial;
    if (ring.count() == 0) return zeroDelay ? now : initial;
    size_t lo = 0, hi = ring.count();
    while (lo < hi) { const size_t mid = (lo + hi) / 2; if (ring.time(mid) <= qNs) lo = mid + 1; else hi = mid; }
    if (lo == 0) return ring.overwritten() ? ring.u(0, i) : initial;
    if (lo == ring.count()) {
        const double tl = ring.time(lo - 1), ul = ring.u(lo - 1, i);
        const double tNow = static_cast<double>(k.tNs);
        if (!zeroDelay || !(tNow > tl)) return zeroDelay && tNow <= tl ? now : ul;
        return ul + (now - ul) * (qNs - tl) / (tNow - tl);
    }
    const double tl = ring.time(lo - 1), tr = ring.time(lo);
    const double span = tr - tl;
    const double alpha = span > 0.0 ? (qNs - tl) / span : 1.0;
    return ring.u(lo - 1, i) + alpha * (ring.u(lo, i) - ring.u(lo - 1, i));
}

void varDelayOutputs(KernelContext& k) {
    const auto n = static_cast<size_t>(k.ip[VdN]);
    const VarRing ring{k.d, n, static_cast<size_t>(k.ip[VdCapacity])};
    const bool transport = k.ip[VdTransport] != 0;
    const bool zeroDelay = !transport && k.ip[VdZeroDelay] != 0;
    const double tNow = static_cast<double>(k.tNs);
    for (size_t i = 0; i < n; ++i) {
        const double maxNs = k.rp[i] * 1e9;
        if (!transport) {
            const double tau = std::clamp(k.input(1, static_cast<uint16_t>(i)), 0.0, k.rp[i]);
            k.out[i] = varDelayAtTime(k, ring, i, tNow - tau * 1e9, zeroDelay);
            continue;
        }
        const double initial = k.rp[n + i];
        const double sNow = k.x[i];
        const double target = sNow - 1.0;
        if (target < 0.0) {
            // Nada completou o trânsito; o limite de atraso máximo ainda pode valer.
            k.out[i] = tNow > maxNs ? varDelayAtTime(k, ring, i, tNow - maxNs, false) : initial;
            continue;
        }
        double tStar = 0.0, value = initial;
        if (ring.count() == 0) {
            value = initial;
            tStar = tNow;
        } else {
            size_t lo = 0, hi = ring.count();
            while (lo < hi) { const size_t mid = (lo + hi) / 2; if (ring.s(mid, i) <= target) lo = mid + 1; else hi = mid; }
            if (lo == 0) {
                tStar = ring.time(0);
                value = ring.overwritten() ? ring.u(0, i) : initial;
            } else if (lo == ring.count()) {
                const double sl = ring.s(lo - 1, i), tl = ring.time(lo - 1);
                tStar = sNow > sl ? tl + (tNow - tl) * (target - sl) / (sNow - sl) : tl;
                value = ring.u(lo - 1, i);
            } else {
                const double sl = ring.s(lo - 1, i), sr = ring.s(lo, i);
                const double alpha = sr > sl ? (target - sl) / (sr - sl) : 1.0;
                tStar = ring.time(lo - 1) + alpha * (ring.time(lo) - ring.time(lo - 1));
                value = ring.u(lo - 1, i) + alpha * (ring.u(lo, i) - ring.u(lo - 1, i));
            }
        }
        if (tNow - tStar > maxNs) value = varDelayAtTime(k, ring, i, tNow - maxNs, false);
        k.out[i] = value;
    }
}

void varDelayUpdate(KernelContext& k) {
    const auto n = static_cast<size_t>(k.ip[VdN]);
    VarRing ring{k.d, n, static_cast<size_t>(k.ip[VdCapacity])};
    const bool transport = k.ip[VdTransport] != 0;
    if (ring.count() > 0) {
        bool same = ring.time(ring.count() - 1) == static_cast<double>(k.tNs);
        for (size_t i = 0; same && i < n; ++i)
            same = ring.u(ring.count() - 1, i) == k.input(0, static_cast<uint16_t>(i)) && (!transport || ring.s(ring.count() - 1, i) == k.x[i]);
        if (same) return;
    }
    if (ring.count() == ring.capacity) { k.d[0] = static_cast<double>((ring.head() + 1) % ring.capacity); k.d[1] -= 1.0; k.d[2] = 1.0; }
    double* slot = ring.record(ring.count());
    slot[0] = static_cast<double>(k.tNs);
    for (size_t i = 0; i < n; ++i) {
        slot[1 + i] = k.input(0, static_cast<uint16_t>(i));
        slot[1 + n + i] = transport ? k.x[i] : 0.0;
    }
    k.d[1] += 1.0;
}

void varDelayDerivatives(KernelContext& k) {
    const auto n = static_cast<size_t>(k.ip[VdN]);
    for (size_t i = 0; i < n; ++i) k.dx[i] = 1.0 / std::max(k.input(1, static_cast<uint16_t>(i)), kMinTi);
}

// ---- First Order Hold ---------------------------------------------------------------------------
// Saída contínua (o builder põe o kernel na partição contínua), amostras da entrada discreta.
// ip = [n, periodoNs, offsetNs, rapido, entradaContinua]; rp = [InitialOutput x n]
// d = [Tk (ns), Hk (ns), amostras] + por elemento [U_{k-1}, U_k, C_k, inclinação].
// Em cada amostra T_k (acerto da taxa da entrada; com entrada contínua, cada passo maior):
//   H_k = T_k - T_{k-1}, M = (U_k - U_{k-1})/H_k, C_k = y(T_k) (saída contínua, sem salto);
//   Slow (Avoid Overshoot): inclinação = M; Fast (Minimize Error): Û = U_k + M*H_k,
//   inclinação = (Û - C_k)/H_k. y(t) = inclinação*(t - T_k) + C_k até a próxima amostra.
// Antes da primeira amostra (e nela) y = InitialOutput; U_{-1} = InitialOutput (a documentação não
// define a primeira amostra; com isso a saída "Slow" alcança U_{k-1} em T_k).
enum FohIp { FohN = 0, FohPeriod, FohOffset, FohFast, FohContinuous, FohIpCount };

KernelShape fohConfigure(const KernelConfig& c) {
    requireInputs(c, 1, "First Order Hold");
    if (c.intParameters.size() != FohIpCount) fail("First Order Hold: parametros internos invalidos");
    const auto n = static_cast<size_t>(c.intParameters[FohN]);
    if (c.realParameters.size() != n || c.outputWidth != n || (c.inputWidths[0] != 1 && c.inputWidths[0] != n))
        fail("First Order Hold: larguras incompativeis");
    for (double v : c.realParameters) if (!std::isfinite(v)) fail("First Order Hold: Initial output nao pode ser Inf ou NaN");
    if (c.intParameters[FohContinuous] == 0 && c.intParameters[FohPeriod] <= 0) fail("First Order Hold: periodo da entrada invalido");
    return {0, static_cast<uint32_t>(3 + 4 * n), {0}};
}
void fohInit(KernelContext& k) {
    const auto n = static_cast<size_t>(k.ip[FohN]);
    k.d[0] = k.d[1] = k.d[2] = 0.0;
    for (size_t i = 0; i < n; ++i) {
        double* e = k.d + 3 + 4 * i;
        e[0] = e[1] = e[2] = k.rp[i];
        e[3] = 0.0;
    }
}
void fohOutputs(KernelContext& k) {
    const auto n = static_cast<size_t>(k.ip[FohN]);
    const bool sampled = k.d[2] > 0.0;
    const double elapsed = sampled ? (static_cast<double>(k.tNs) - k.d[0]) * 1e-9 : 0.0;
    for (size_t i = 0; i < n; ++i) {
        const double* e = k.d + 3 + 4 * i;
        k.out[i] = sampled ? e[2] + e[3] * elapsed : k.rp[i];
    }
}
void fohUpdate(KernelContext& k) {
    const auto n = static_cast<size_t>(k.ip[FohN]);
    const bool continuousInput = k.ip[FohContinuous] != 0;
    const auto period = static_cast<uint64_t>(k.ip[FohPeriod]), offset = static_cast<uint64_t>(k.ip[FohOffset]);
    const bool sampled = k.d[2] > 0.0;
    const uint64_t tk = static_cast<uint64_t>(k.d[0]);
    bool hit;
    if (continuousInput) hit = !sampled || k.tNs >= tk;
    else hit = k.tNs >= offset && (k.tNs - offset) % period == 0;
    if (!hit) return;
    const bool again = sampled && k.tNs == tk; // mesma amostra de novo (entrada já atualizada no instante)
    if (!again) {
        const double hNs = sampled ? static_cast<double>(k.tNs - tk) : (continuousInput ? 0.0 : static_cast<double>(period));
        const double elapsed = sampled ? (static_cast<double>(k.tNs) - k.d[0]) * 1e-9 : 0.0;
        for (size_t i = 0; i < n; ++i) {
            double* e = k.d + 3 + 4 * i;
            const double y = sampled ? e[2] + e[3] * elapsed : k.rp[i];
            e[0] = sampled ? e[1] : k.rp[i];
            e[2] = y;
        }
        k.d[0] = static_cast<double>(k.tNs);
        k.d[1] = hNs;
        k.d[2] += 1.0;
    }
    const double h = k.d[1] * 1e-9;
    const bool fast = k.ip[FohFast] != 0;
    for (size_t i = 0; i < n; ++i) {
        double* e = k.d + 3 + 4 * i;
        const double u = k.input(0, static_cast<uint16_t>(i));
        e[1] = u;
        if (!(h > 0.0)) { e[3] = 0.0; continue; }
        const double m = (u - e[0]) / h;
        e[3] = fast ? (u + m * h - e[2]) / h : m;
    }
}
uint64_t fohBreakpoint(const KernelContext& k) {
    if (k.ip[FohContinuous] != 0) return kNoBreakpoint;
    const auto period = static_cast<uint64_t>(k.ip[FohPeriod]), offset = static_cast<uint64_t>(k.ip[FohOffset]);
    if (k.tNs < offset) return offset;
    const uint64_t periods = (k.tNs - offset) / period + 1;
    return offset + periods * period;
}

// ---- Propagation Delay --------------------------------------------------------------------------
// Entradas u e dt (escalares). Em cada passo k (passo maior; com Run at fixed time intervals, cada
// acerto da taxa Ts) amostra U_k e D_k e agenda U_k para T_k + D_k; a saída segura o último valor
// cujo instante chegou (y = InitialOutput antes de T_0 + D_0). Com intervalos fixos o atraso é
// arredondado para baixo a um múltiplo de Ts.
// ip = [capacidade, TsNs (0 = por evento)]; rp = [InitialOutput]
// d = [saidaAtual, inicio, quantidade, (instanteNs, valor, amostraNs) x capacidade]
// Amostras com D <= 128*eps, com atraso que viola a ordem crescente dos instantes de saída ou (com
// intervalos fixos) com D < Ts são descartadas (o Simulink pararia a simulação com erro). Amostra com
// o mesmo valor do último agendado não entra na fila (a saída não mudaria), o que mantém a fila
// pequena com entrada contínua amostrada a cada passo maior.
enum PropIp { PropCapacity = 0, PropFixedNs, PropIpCount };
constexpr size_t kPropHeader = 3;

KernelShape propConfigure(const KernelConfig& c) {
    requireInputs(c, 2, "Propagation Delay");
    if (c.intParameters.size() != PropIpCount || c.realParameters.size() != 1) fail("Propagation Delay: parametros internos invalidos");
    if (c.inputWidths[0] != 1 || c.inputWidths[1] != 1 || c.outputWidth != 1) fail("Propagation Delay: u e dt devem ser escalares (largura 1)");
    const auto capacity = static_cast<size_t>(c.intParameters[PropCapacity]);
    if (capacity < 2 || capacity > (1u << 22)) fail("Propagation Delay: capacidade invalida");
    if (!std::isfinite(c.realParameters[0])) fail("Propagation Delay: Initial output deve ser finito");
    return {0, static_cast<uint32_t>(kPropHeader + 3 * capacity), {0, 0}};
}
struct PropQueue {
    double* d; size_t capacity;
    size_t head() const { return static_cast<size_t>(d[1]); }
    size_t count() const { return static_cast<size_t>(d[2]); }
    double* entry(size_t index) const { return d + kPropHeader + ((head() + index) % capacity) * 3; }
    void pop() { d[1] = static_cast<double>((head() + 1) % capacity); d[2] -= 1.0; }
};
void propInit(KernelContext& k) { k.d[0] = k.rp[0]; k.d[1] = 0.0; k.d[2] = 0.0; }
void propOutputs(KernelContext& k) {
    const PropQueue q{k.d, static_cast<size_t>(k.ip[PropCapacity])};
    double value = k.d[0];
    for (size_t i = 0; i < q.count() && q.entry(i)[0] <= static_cast<double>(k.majorNs); ++i) value = q.entry(i)[1];
    k.out[0] = value;
}
void propUpdate(KernelContext& k) {
    PropQueue q{k.d, static_cast<size_t>(k.ip[PropCapacity])};
    while (q.count() > 0 && q.entry(0)[0] <= static_cast<double>(k.tNs)) { k.d[0] = q.entry(0)[1]; q.pop(); }
    const double u = k.input(0), dt = k.input(1);
    if (!std::isfinite(dt) || !(dt > 128.0 * 2.220446049250313e-16)) return;
    const auto fixedNs = static_cast<uint64_t>(k.ip[PropFixedNs]);
    uint64_t delayNs = static_cast<uint64_t>(std::llround(dt * 1e9));
    if (fixedNs > 0) {
        delayNs = (delayNs / fixedNs) * fixedNs;
        if (delayNs < fixedNs) return;
    }
    if (delayNs == 0) return;
    const double due = static_cast<double>(k.tNs + delayNs);
    if (q.count() > 0) {
        double* last = q.entry(q.count() - 1);
        if (last[2] == static_cast<double>(k.tNs)) { // mesma amostra de novo: substitui
            const double previousDue = q.count() > 1 ? q.entry(q.count() - 2)[0] : -1.0;
            if (due > previousDue) { last[0] = due; last[1] = u; }
            return;
        }
        if (due <= last[0]) return;
        if (last[1] == u) return; // mesmo valor já agendado: a saída não muda
    } else if (k.d[0] == u) {
        return; // fila vazia e a saída já vale u
    }
    if (q.count() == q.capacity) { k.d[0] = q.entry(0)[1]; q.pop(); }
    double* slot = q.entry(q.count());
    slot[0] = due;
    slot[1] = u;
    slot[2] = static_cast<double>(k.tNs);
    k.d[2] += 1.0;
}
uint64_t propBreakpoint(const KernelContext& k) {
    const PropQueue q{k.d, static_cast<size_t>(k.ip[PropCapacity])};
    for (size_t i = 0; i < q.count(); ++i)
        if (q.entry(i)[0] > static_cast<double>(k.tNs)) return static_cast<uint64_t>(q.entry(i)[0]);
    return kNoBreakpoint;
}

// ---- Derivative ----------------------------------------------------------------------------------
// y = (u(t) - u(t_ant)) / (t - t_ant), t_ant = último passo maior; y(t0) = 0.
// d = [u_ant x n, t_ant (ns), inicializado, y_ant x n]
KernelShape derivativeConfigure(const KernelConfig& c) {
    requireInputs(c, 1, "Derivative");
    requireExpandable(c, "Derivative");
    const size_t n = c.outputWidth;
    return {0, static_cast<uint32_t>(2 * n + 2), {1}};
}
void derivativeOutputs(KernelContext& k) {
    const size_t n = k.outWidth;
    const bool initialized = k.d[n + 1] != 0.0;
    const double previousNs = k.d[n];
    for (size_t i = 0; i < n; ++i) {
        if (!initialized) { k.out[i] = 0.0; continue; }
        const double dt = (static_cast<double>(k.tNs) - previousNs) * 1e-9;
        k.out[i] = dt > 0.0 ? (k.input(0, static_cast<uint16_t>(i)) - k.d[i]) / dt : k.d[n + 2 + i];
    }
}
void derivativeUpdate(KernelContext& k) {
    const size_t n = k.outWidth;
    const bool sameInstant = k.d[n + 1] != 0.0 && k.d[n] == static_cast<double>(k.tNs);
    for (size_t i = 0; i < n; ++i) {
        if (!sameInstant) k.d[n + 2 + i] = k.out[i];
        k.d[i] = k.input(0, static_cast<uint16_t>(i));
    }
    k.d[n] = static_cast<double>(k.tNs);
    k.d[n + 1] = 1.0;
}

const KernelSpec kIntegrator{"integrator", integratorConfigure, integratorInit, integratorOutputs, integratorUpdate, integratorDerivatives, nullptr};
const KernelSpec kSecondOrderIntegrator{"second_order_integrator", soiConfigure, soiInit, soiOutputs, soiUpdate, soiDerivatives, nullptr};
const KernelSpec kStateSpace{"state_space", ssConfigure, ssInit, ssOutputs, nullptr, ssDerivatives, nullptr};
const KernelSpec kDiscreteStateSpace{"discrete_state_space", dssConfigure, dssInit, dssOutputs, dssUpdate, nullptr, nullptr};
const KernelSpec kTransportDelay{"transport_delay", delayConfigure, delayInit, delayOutputs, delayUpdate, nullptr, delayBreakpoint};
const KernelSpec kVariableDelay{"variable_delay", varDelayConfigure, varDelayInit, varDelayOutputs, varDelayUpdate, varDelayDerivatives, nullptr};
const KernelSpec kFirstOrderHold{"first_order_hold", fohConfigure, fohInit, fohOutputs, fohUpdate, nullptr, fohBreakpoint};
const KernelSpec kPropagationDelay{"propagation_delay", propConfigure, propInit, propOutputs, propUpdate, nullptr, propBreakpoint};
const KernelSpec kDerivative{"derivative", derivativeConfigure, nullptr, derivativeOutputs, derivativeUpdate, nullptr, nullptr};

const KernelSpec* const kContinuous[] = {&kIntegrator, &kSecondOrderIntegrator, &kStateSpace, &kDiscreteStateSpace, &kTransportDelay,
                                         &kVariableDelay, &kFirstOrderHold, &kPropagationDelay, &kDerivative};
} // namespace

std::span<const KernelSpec* const> continuousKernels() { return kContinuous; }

} // namespace lasecsimul::simulation::library
