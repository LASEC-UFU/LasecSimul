// Blocos discretos (biblioteca Discrete). Executam nos acertos de amostra do RateGroup do bloco;
// `update` roda depois de todas as saídas do instante (semântica de atraso verdadeiro). `outputs`
// nunca altera estado (pode ser reavaliado em laço algébrico); tudo que muda estado fica em `update`.
#include <algorithm>
#include <cmath>

#include "../KernelCommon.hpp"
#include "Families.hpp"
#include "ResetEdge.hpp"

namespace lasecsimul::simulation::library {
namespace {
using namespace detail;

// ---- Unit Delay / Memory: rp = InitialCondition (1 ou largura); d = estado x largura.
// y[k] = u[k-1]; y[0] = InitialCondition. Memory é o mesmo kernel com a taxa contínua (atraso de um
// passo maior: `update` roda em todo passo maior da partição contínua).
KernelShape unitDelayConfigure(const KernelConfig& c) {
    requireInputs(c, 1, "Unit Delay");
    requireExpandable(c, "Unit Delay");
    if (c.realParameters.size() != 1 && c.realParameters.size() != c.outputWidth) fail("Unit Delay: Initial condition com largura incompativel");
    return {0, c.outputWidth, {0}};
}
void unitDelayInit(KernelContext& k) { for (uint16_t i = 0; i < k.outWidth; ++i) k.d[i] = k.rp[k.rpCount == 1 ? 0 : i]; }
void unitDelayOutputs(KernelContext& k) { for (uint16_t i = 0; i < k.outWidth; ++i) k.out[i] = k.d[i]; }
void unitDelayUpdate(KernelContext& k) { for (uint16_t i = 0; i < k.outWidth; ++i) k.d[i] = k.input(0, i); }

// ---- Delay simples (N fixo, sem portas opcionais): ip = [N]; rp = InitialCondition (1 ou largura).
// d = [cabeça, (N x largura) anel]. y[k] = u[k-N]; N = 0 é passagem direta.
KernelShape delayNConfigure(const KernelConfig& c) {
    requireInputs(c, 1, "Delay");
    requireExpandable(c, "Delay");
    if (c.intParameters.size() != 1 || c.intParameters[0] < 0 || c.intParameters[0] > 1'000'000) fail("Delay: Delay length invalido");
    if (c.realParameters.size() != 1 && c.realParameters.size() != c.outputWidth) fail("Delay: Initial condition com largura incompativel");
    const auto n = static_cast<uint32_t>(c.intParameters[0]);
    return {0, 1 + n * c.outputWidth, {static_cast<uint8_t>(n == 0 ? 1 : 0)}};
}
void delayNInit(KernelContext& k) {
    const auto n = static_cast<size_t>(k.ip[0]);
    k.d[0] = 0.0;
    for (size_t s = 0; s < n; ++s)
        for (uint16_t i = 0; i < k.outWidth; ++i) k.d[1 + s * k.outWidth + i] = k.rp[k.rpCount == 1 ? 0 : i];
}
void delayNOutputs(KernelContext& k) {
    const auto n = static_cast<size_t>(k.ip[0]);
    if (n == 0) { for (uint16_t i = 0; i < k.outWidth; ++i) k.out[i] = k.input(0, i); return; }
    const auto head = static_cast<size_t>(k.d[0]);
    for (uint16_t i = 0; i < k.outWidth; ++i) k.out[i] = k.d[1 + head * k.outWidth + i];
}
void delayNUpdate(KernelContext& k) {
    const auto n = static_cast<size_t>(k.ip[0]);
    if (n == 0) return;
    const auto head = static_cast<size_t>(k.d[0]);
    for (uint16_t i = 0; i < k.outWidth; ++i) k.d[1 + head * k.outWidth + i] = k.input(0, i);
    k.d[0] = static_cast<double>((head + 1) % n);
}

// ---- Delay completo (Delay / Resettable Delay / Variable Integer Delay) ---------------------------
// ip = [L, comprimentoPelaPorta, limiteInferior, icExterna, temEnable, resetMode, offsetNs, N]
// rp = InitialCondition (1 ou largura). Entradas: u, [d], [Enable], [External reset], [x0].
// d = [cabeça, inicializado, jaHabilitado, resetAnterior, ultimaSaida x w, anel L x w].
// Por amostra, na ordem documentada: (1) enable; (2) reset; (3) atraso. Habilitado: y = u(k - len),
// len = N (diálogo) ou d truncado e limitado a [limiteInferior, L] (porta); len = 0 é passagem
// direta. Na primeira execução e no reset os estados valem a condição inicial (parâmetro ou x0 lido
// no instante). Desabilitado: segura a última saída (0 se nunca habilitado, como a documentação).
// Antes do primeiro acerto (deslocamento do tempo de amostragem) y = 0.
enum DelayGIp { DgL = 0, DgFromPort, DgLower, DgIcExternal, DgEnable, DgReset, DgOffset, DgN, DgIpCount };
constexpr size_t kDgHeader = 4;

struct DelayGView {
    const KernelContext& k;
    size_t L() const { return static_cast<size_t>(k.ip[DgL]); }
    size_t w() const { return k.outWidth; }
    uint16_t dPort() const { return 1; }
    uint16_t enablePort() const { return static_cast<uint16_t>(1 + k.ip[DgFromPort]); }
    uint16_t resetPort() const { return static_cast<uint16_t>(1 + k.ip[DgFromPort] + k.ip[DgEnable]); }
    uint16_t x0Port() const { return static_cast<uint16_t>(1 + k.ip[DgFromPort] + k.ip[DgEnable] + (k.ip[DgReset] != 0 ? 1 : 0)); }
    bool enabled() const { return k.ip[DgEnable] == 0 || k.input(enablePort()) != 0.0; }
    bool reset() const {
        return k.ip[DgReset] != 0 && resetTriggered(static_cast<ResetMode>(k.ip[DgReset]), k.d[3], k.input(resetPort()));
    }
    double ic(size_t i) const { return k.ip[DgIcExternal] != 0 ? k.input(x0Port(), static_cast<uint16_t>(i)) : k.rp[k.rpCount == 1 ? 0 : i]; }
    size_t length() const {
        if (k.ip[DgFromPort] == 0) return static_cast<size_t>(k.ip[DgN]);
        const double raw = k.input(dPort());
        const double lower = static_cast<double>(k.ip[DgLower]);
        if (!std::isfinite(raw)) return raw > 0.0 ? L() : static_cast<size_t>(lower);
        return static_cast<size_t>(std::clamp(std::trunc(raw), lower, static_cast<double>(L())));
    }
    double* lastOut() const { return k.d + kDgHeader; }
    double* ring() const { return k.d + kDgHeader + w(); }
};

KernelShape delayGConfigure(const KernelConfig& c) {
    if (c.intParameters.size() != DgIpCount) fail("Delay: parametros internos invalidos");
    const auto& ip = c.intParameters;
    const size_t inputs = 1 + ip[DgFromPort] + ip[DgEnable] + (ip[DgReset] != 0 ? 1 : 0) + ip[DgIcExternal];
    requireInputs(c, inputs, "Delay");
    if (ip[DgL] < 0 || ip[DgL] > 1'000'000 || ip[DgN] < 0 || ip[DgN] > ip[DgL]) fail("Delay: Delay length invalido");
    if (c.inputWidths[0] != 1 && c.inputWidths[0] != c.outputWidth) fail("Delay: largura de entrada incompativel");
    for (size_t port = 1; port < c.inputWidths.size(); ++port) {
        const bool x0 = ip[DgIcExternal] != 0 && port == inputs - 1;
        if (x0 ? (c.inputWidths[port] != 1 && c.inputWidths[port] != c.outputWidth) : c.inputWidths[port] != 1)
            fail("Delay: largura das portas d/Enable/reset deve ser 1 e a de x0 1 ou a da entrada");
    }
    if (c.realParameters.size() != 1 && c.realParameters.size() != c.outputWidth) fail("Delay: Initial condition com largura incompativel");
    const bool uFeedthrough = ip[DgFromPort] != 0 ? ip[DgLower] == 0 : ip[DgN] == 0;
    std::vector<uint8_t> feedthrough(inputs, 1);
    feedthrough[0] = uFeedthrough ? 1 : 0;
    return {0, static_cast<uint32_t>(kDgHeader + c.outputWidth + static_cast<size_t>(ip[DgL]) * c.outputWidth), feedthrough};
}
void delayGInit(KernelContext& k) { std::fill_n(k.d, kDgHeader + k.outWidth, 0.0); }
void delayGOutputs(KernelContext& k) {
    const DelayGView v{k};
    if (k.tNs < static_cast<uint64_t>(k.ip[DgOffset])) { std::fill_n(k.out, k.outWidth, 0.0); return; }
    if (!v.enabled()) {
        for (size_t i = 0; i < v.w(); ++i) k.out[i] = k.d[2] != 0.0 ? v.lastOut()[i] : 0.0;
        return;
    }
    const bool fresh = k.d[1] == 0.0 || v.reset();
    const size_t len = v.length();
    const size_t L = v.L();
    const size_t head = static_cast<size_t>(k.d[0]);
    for (size_t i = 0; i < v.w(); ++i) {
        if (len == 0) k.out[i] = k.input(0, static_cast<uint16_t>(i));
        else k.out[i] = fresh ? v.ic(i) : v.ring()[((head + L - len) % L) * v.w() + i];
    }
}
void delayGUpdate(KernelContext& k) {
    const DelayGView v{k};
    if (k.tNs < static_cast<uint64_t>(k.ip[DgOffset]) || !v.enabled()) return;
    const size_t L = v.L(), w = v.w();
    if (k.d[1] == 0.0 || v.reset()) {
        for (size_t s = 0; s < L; ++s)
            for (size_t i = 0; i < w; ++i) v.ring()[s * w + i] = v.ic(i);
        k.d[1] = 1.0;
    }
    if (L > 0) {
        const size_t head = static_cast<size_t>(k.d[0]);
        for (size_t i = 0; i < w; ++i) v.ring()[head * w + i] = k.input(0, static_cast<uint16_t>(i));
        k.d[0] = static_cast<double>((head + 1) % L);
    }
    std::copy_n(k.out, w, v.lastOut());
    k.d[2] = 1.0;
    if (k.ip[DgReset] != 0) k.d[3] = k.input(v.resetPort());
}

// ---- Zero-Order Hold / Signal passthrough discreto: y = u no acerto de amostra. ----
KernelShape zohConfigure(const KernelConfig& c) {
    requireInputs(c, 1, "Zero-Order Hold");
    requireExpandable(c, "Zero-Order Hold");
    return {0, 0, {1}};
}
void zohOutputs(KernelContext& k) { for (uint16_t i = 0; i < k.outWidth; ++i) k.out[i] = k.input(0, i); }

// ---- Filtro IIR por canal (Discrete Transfer Fcn, Discrete Filter, Discrete Zero-Pole,
// Transfer Fcn Direct Form II e Direct Form II Time Varying) ---------------------------------------
// Coeficientes em potências crescentes de z^-1 com o MESMO comprimento L (o builder completa com
// zeros: na frente para a convenção em z de Discrete Transfer Fcn, no fim para a convenção em z^-1
// de Discrete Filter) e a0 = 1 (o builder divide por a0; coeficientes vindos de porta: numerador
// dividido por `a0div`, denominador com a0 substituído por 1 como a documentação).
// ip = [w, L, r, estrutura, numPorta, numLargura, numFrente, denPorta, denLargura, denFrente,
//       denSemLider, icPorta, resetMode]
// estrutura: 0 = Direct form II, 1 = Direct form II transposed, 2 = Direct form I,
//            3 = Direct form I transposed.
// rp = [b (r x L), a (L), a0div, icNum (w x (L-1)), icDen (w x (L-1))]
// Entradas: u, [Num], [Den], [External reset], [x0]. Saída: w canais (ou r saídas com numerador
// matricial e entrada escalar, só na forma direta II).
// d = [inicializado, resetAnterior, rascunho S, estados w x S], S = L-1 (formas II) ou 2(L-1) (I).
// Estados (a ordem que InitialStates inicializa, por canal):
//   DF II:  s_j = w(k-1-j), w(k) = u(k) - sum a_j w(k-j), y = sum b_j w(k-j);
//   DF IIt: y = b0 u + s_0; s_j <- s_{j+1} + b_{j+1} u - a_{j+1} y;
//   DF I:   [u(k-1..k-L+1) | y(k-1..k-L+1)];
//   DF It:  [q (numerador) | p (denominador)]: v = u + p_0, y = b0 v + q_0,
//           p_j <- p_{j+1} - a_{j+1} v, q_j <- q_{j+1} + b_{j+1} v.
// Na primeira amostra e no reset os estados valem as condições iniciais (parâmetro ou porta x0).
enum IirIp { IirW = 0, IirL, IirR, IirStructure, IirNumPort, IirNumWidth, IirNumFront, IirDenPort, IirDenWidth, IirDenFront,
             IirDenNoLead, IirIcPort, IirReset, IirIpCount };
enum IirStructure : int64_t { DF2 = 0, DF2T, DF1, DF1T };

struct IirView {
    const KernelContext& k;
    size_t w() const { return static_cast<size_t>(k.ip[IirW]); }
    size_t L() const { return static_cast<size_t>(k.ip[IirL]); }
    size_t r() const { return static_cast<size_t>(k.ip[IirR]); }
    int64_t structure() const { return k.ip[IirStructure]; }
    size_t perChannel() const { return (structure() == DF1 || structure() == DF1T ? 2 : 1) * (L() - 1); }
    uint16_t numPort() const { return 1; }
    uint16_t denPort() const { return static_cast<uint16_t>(1 + k.ip[IirNumPort]); }
    uint16_t resetPort() const { return static_cast<uint16_t>(1 + k.ip[IirNumPort] + k.ip[IirDenPort]); }
    uint16_t x0Port() const { return static_cast<uint16_t>(resetPort() + (k.ip[IirReset] != 0 ? 1 : 0)); }
    const double* rpA() const { return k.rp + r() * L(); }
    double a0div() const { return k.rp[r() * L() + L()]; }
    const double* icNum() const { return k.rp + r() * L() + L() + 1; }
    const double* icDen() const { return icNum() + w() * (L() - 1); }
    double* scratch() const { return k.d + 2; }
    double* states(size_t channel) const { return k.d + 2 + perChannel() + channel * perChannel(); }
    double b(size_t row, size_t j) const {
        if (k.ip[IirNumPort] == 0) return k.rp[row * L() + j];
        const auto width = static_cast<size_t>(k.ip[IirNumWidth]);
        const ptrdiff_t index = k.ip[IirNumFront] != 0 ? static_cast<ptrdiff_t>(j) - static_cast<ptrdiff_t>(L() - width) : static_cast<ptrdiff_t>(j);
        return index >= 0 && static_cast<size_t>(index) < width ? k.input(numPort(), static_cast<uint16_t>(index)) / a0div() : 0.0;
    }
    double a(size_t j) const {
        if (k.ip[IirDenPort] == 0) return rpA()[j];
        if (j == 0) return 1.0;
        const auto width = static_cast<size_t>(k.ip[IirDenWidth]);
        ptrdiff_t index;
        if (k.ip[IirDenNoLead] != 0) index = static_cast<ptrdiff_t>(j) - 1;
        else index = k.ip[IirDenFront] != 0 ? static_cast<ptrdiff_t>(j) - static_cast<ptrdiff_t>(L() - width) : static_cast<ptrdiff_t>(j);
        return index >= 0 && static_cast<size_t>(index) < width ? k.input(denPort(), static_cast<uint16_t>(index)) : 0.0;
    }
    bool fresh() const {
        return k.d[0] == 0.0 || (k.ip[IirReset] != 0 && resetTriggered(static_cast<ResetMode>(k.ip[IirReset]), k.d[1], k.input(resetPort())));
    }
    /** Estado inicial j (0 .. perChannel-1) do canal. */
    double initial(size_t channel, size_t j) const {
        const size_t n = L() - 1;
        if (k.ip[IirIcPort] != 0) {
            const uint16_t width = k.inWidth[x0Port()];
            const size_t index = width == w() * n ? channel * n + j : width == n ? j : width == w() ? channel : 0;
            return k.input(x0Port(), static_cast<uint16_t>(index));
        }
        return j < n ? icNum()[channel * n + j] : icDen()[channel * n + (j - n)];
    }
};

KernelShape iirConfigure(const KernelConfig& c) {
    if (c.intParameters.size() != IirIpCount) fail("Discrete Filter: parametros internos invalidos");
    const auto& ip = c.intParameters;
    const auto w = static_cast<size_t>(ip[IirW]), L = static_cast<size_t>(ip[IirL]), r = static_cast<size_t>(ip[IirR]);
    if (L < 1 || L > 4096 || w < 1 || r < 1) fail("Discrete Filter: ordem/canais invalidos");
    if (r > 1 && (w != 1 || ip[IirStructure] != DF2)) fail("Discrete Filter: numerador matricial exige entrada escalar e forma direta II");
    const size_t inputs = 1 + ip[IirNumPort] + ip[IirDenPort] + (ip[IirReset] != 0 ? 1 : 0) + ip[IirIcPort];
    requireInputs(c, inputs, "Discrete Filter");
    if (c.inputWidths[0] != w && !(w == 1 && c.inputWidths[0] == 1)) fail("Discrete Filter: largura da entrada difere do numero de canais");
    if (c.outputWidth != w * r) fail("Discrete Filter: largura de saida incompativel");
    if (c.realParameters.size() != r * L + L + 1 + 2 * w * (L - 1)) fail("Discrete Filter: parametros com dimensoes incompativeis");
    if (ip[IirNumPort] != 0 && c.inputWidths[1] != static_cast<uint16_t>(ip[IirNumWidth])) fail("Discrete Filter: largura da porta Num mudou");
    if (ip[IirDenPort] != 0 && c.inputWidths[1 + ip[IirNumPort]] != static_cast<uint16_t>(ip[IirDenWidth])) fail("Discrete Filter: largura da porta Den mudou");
    if (ip[IirDenPort] == 0 && c.realParameters[r * L] != 1.0) fail("Discrete Filter: denominador nao normalizado (a0 deve ser 1)");
    for (double value : c.realParameters) if (!std::isfinite(value)) fail("Discrete Filter: coeficientes e estados iniciais devem ser finitos");
    bool feedthrough = ip[IirNumPort] != 0;
    for (size_t row = 0; row < r && !feedthrough; ++row) feedthrough = c.realParameters[row * L] != 0.0;
    std::vector<uint8_t> ft(inputs, 1);
    ft[0] = feedthrough ? 1 : 0;
    const size_t perChannel = (ip[IirStructure] == DF1 || ip[IirStructure] == DF1T ? 2 : 1) * (L - 1);
    return {0, static_cast<uint32_t>(2 + perChannel + w * perChannel), ft};
}

/** Um passo do canal: escreve a saída; com `commit` grava os estados novos. */
void iirChannel(KernelContext& k, const IirView& v, size_t channel, bool fresh, bool commit) {
    const size_t L = v.L(), n = L - 1, S = v.perChannel();
    double* stored = v.states(channel);
    double* s = v.scratch();
    for (size_t j = 0; j < S; ++j) s[j] = fresh ? v.initial(channel, j) : stored[j];
    const double u = k.input(0, static_cast<uint16_t>(channel));
    switch (v.structure()) {
    case DF2: {
        double w0 = u;
        for (size_t j = 1; j < L; ++j) w0 -= v.a(j) * s[j - 1];
        for (size_t row = 0; row < v.r(); ++row) {
            double y = v.b(row, 0) * w0;
            for (size_t j = 1; j < L; ++j) y += v.b(row, j) * s[j - 1];
            k.out[v.r() > 1 ? row : channel] = y;
        }
        if (commit) {
            for (size_t j = n; j > 1; --j) stored[j - 1] = s[j - 2];
            if (n > 0) stored[0] = w0;
        }
        break;
    }
    case DF2T: {
        const double y = v.b(0, 0) * u + (n > 0 ? s[0] : 0.0);
        k.out[channel] = y;
        if (commit)
            for (size_t j = 0; j < n; ++j) stored[j] = (j + 1 < n ? s[j + 1] : 0.0) + v.b(0, j + 1) * u - v.a(j + 1) * y;
        break;
    }
    case DF1: {
        double y = v.b(0, 0) * u;
        for (size_t j = 1; j < L; ++j) y += v.b(0, j) * s[j - 1] - v.a(j) * s[n + j - 1];
        k.out[channel] = y;
        if (commit) {
            for (size_t j = n; j > 1; --j) { stored[j - 1] = s[j - 2]; stored[n + j - 1] = s[n + j - 2]; }
            if (n > 0) { stored[0] = u; stored[n] = y; }
        }
        break;
    }
    default: { // DF1T
        const double vin = u + (n > 0 ? s[n] : 0.0);
        const double y = v.b(0, 0) * vin + (n > 0 ? s[0] : 0.0);
        k.out[channel] = y;
        if (commit)
            for (size_t j = 0; j < n; ++j) {
                stored[j] = (j + 1 < n ? s[j + 1] : 0.0) + v.b(0, j + 1) * vin;
                stored[n + j] = (j + 1 < n ? s[n + j + 1] : 0.0) - v.a(j + 1) * vin;
            }
        break;
    }
    }
}
void iirOutputs(KernelContext& k) {
    const IirView v{k};
    const bool fresh = v.fresh();
    for (size_t channel = 0; channel < v.w(); ++channel) iirChannel(k, v, channel, fresh, false);
}
void iirUpdate(KernelContext& k) {
    const IirView v{k};
    const bool fresh = v.fresh();
    for (size_t channel = 0; channel < v.w(); ++channel) iirChannel(k, v, channel, fresh, true);
    k.d[0] = 1.0;
    if (k.ip[IirReset] != 0) k.d[1] = k.input(v.resetPort());
}

// ---- Discrete FIR Filter ------------------------------------------------------------------------
// ip = [w, M, r, estrutura, coefPorta, resetMode, temEnable]
// estrutura: 0 Direct form, 1 symmetric, 2 antisymmetric, 3 transposed, 4 Lattice MA.
// rp = [coeficientes (r x M), se do diálogo] + [estados iniciais w x S], S = M - 1 (formas diretas)
// ou M (lattice: número de coeficientes de reflexão). Entradas: u, [Num], [External reset], [Enable].
// Formas diretas: y = sum b_j u(k-j) (estados = entradas passadas); simétrica/antissimétrica usam
// só a primeira metade dos coeficientes, espelhada (+/-). Transposta: y = b0 u + s_0,
// s_j <- s_{j+1} + b_{j+1} u. Lattice MA: f_0 = g_0 = u; f_i = f_{i-1} + k_i g_{i-1}(k-1),
// g_i = k_i f_{i-1} + g_{i-1}(k-1); y = f_M (estados = g_{i-1}(k-1)).
// Enable: igual ao Delay (desabilitado segura a última saída; 0 antes de habilitar).
// d = [resetAnterior, jaHabilitado, inicializado, ultimaSaida x (w r), rascunho S, estados w x S]
enum FirIp { FirW = 0, FirM, FirR, FirStructure, FirCoefPort, FirReset, FirEnable, FirIpCount };
enum FirStructure : int64_t { FirDirect = 0, FirSymmetric, FirAntisymmetric, FirTransposed, FirLattice };

struct FirView {
    const KernelContext& k;
    size_t w() const { return static_cast<size_t>(k.ip[FirW]); }
    size_t M() const { return static_cast<size_t>(k.ip[FirM]); }
    size_t r() const { return static_cast<size_t>(k.ip[FirR]); }
    int64_t structure() const { return k.ip[FirStructure]; }
    size_t S() const { return structure() == FirLattice ? M() : M() - 1; }
    uint16_t resetPort() const { return static_cast<uint16_t>(1 + k.ip[FirCoefPort]); }
    uint16_t enablePort() const { return static_cast<uint16_t>(1 + k.ip[FirCoefPort] + (k.ip[FirReset] != 0 ? 1 : 0)); }
    double raw(size_t row, size_t j) const {
        return k.ip[FirCoefPort] != 0 ? k.input(1, static_cast<uint16_t>(j)) : k.rp[row * M() + j];
    }
    /** Coeficiente efetivo da derivação j (simetria aplicada). */
    double b(size_t row, size_t j) const {
        const size_t half = (M() + 1) / 2;
        if (structure() == FirSymmetric && j >= half) return raw(row, M() - 1 - j);
        if (structure() == FirAntisymmetric && j >= half) return -raw(row, M() - 1 - j);
        return raw(row, j);
    }
    const double* ic() const { return k.rp + (k.ip[FirCoefPort] != 0 ? 0 : r() * M()); }
    double* lastOut() const { return k.d + 3; }
    double* scratch() const { return k.d + 3 + w() * r(); }
    double* states(size_t channel) const { return scratch() + S() + channel * S(); }
    bool enabled() const { return k.ip[FirEnable] == 0 || k.input(enablePort()) != 0.0; }
    bool fresh() const {
        return k.d[2] == 0.0 || (k.ip[FirReset] != 0 && resetTriggered(static_cast<ResetMode>(k.ip[FirReset]), k.d[0], k.input(resetPort())));
    }
};

KernelShape firConfigure(const KernelConfig& c) {
    if (c.intParameters.size() != FirIpCount) fail("Discrete FIR Filter: parametros internos invalidos");
    const auto& ip = c.intParameters;
    const auto w = static_cast<size_t>(ip[FirW]), M = static_cast<size_t>(ip[FirM]), r = static_cast<size_t>(ip[FirR]);
    if (M < 1 || M > 4096 || w < 1 || r < 1) fail("Discrete FIR Filter: coeficientes/canais invalidos");
    if (r > 1 && (w != 1 || ip[FirStructure] != FirDirect)) fail("Discrete FIR Filter: coeficientes matriciais exigem entrada escalar e Direct form");
    const size_t inputs = 1 + ip[FirCoefPort] + (ip[FirReset] != 0 ? 1 : 0) + ip[FirEnable];
    requireInputs(c, inputs, "Discrete FIR Filter");
    if (c.inputWidths[0] != w && !(w == 1 && c.inputWidths[0] == 1)) fail("Discrete FIR Filter: largura da entrada difere do numero de canais");
    if (c.outputWidth != w * r) fail("Discrete FIR Filter: largura de saida incompativel");
    if (ip[FirCoefPort] != 0 && c.inputWidths[1] != M) fail("Discrete FIR Filter: largura da porta Num mudou");
    const size_t S = ip[FirStructure] == FirLattice ? M : M - 1;
    if (c.realParameters.size() != (ip[FirCoefPort] != 0 ? 0 : r * M) + w * S) fail("Discrete FIR Filter: parametros com dimensoes incompativeis");
    for (double value : c.realParameters) if (!std::isfinite(value)) fail("Discrete FIR Filter: coeficientes e estados iniciais devem ser finitos");
    bool feedthrough = ip[FirCoefPort] != 0 || ip[FirStructure] == FirLattice;
    for (size_t row = 0; row < r && !feedthrough; ++row) feedthrough = c.realParameters[row * M] != 0.0;
    std::vector<uint8_t> ft(inputs, 1);
    ft[0] = feedthrough ? 1 : 0;
    return {0, static_cast<uint32_t>(3 + w * r + S + w * S), ft};
}

void firChannel(KernelContext& k, const FirView& v, size_t channel, bool fresh, bool commit) {
    const size_t M = v.M(), S = v.S();
    double* stored = v.states(channel);
    double* s = v.scratch();
    for (size_t j = 0; j < S; ++j) s[j] = fresh ? v.ic()[channel * S + j] : stored[j];
    const double u = k.input(0, static_cast<uint16_t>(channel));
    switch (v.structure()) {
    case FirTransposed: {
        const double y = v.b(0, 0) * u + (S > 0 ? s[0] : 0.0);
        k.out[channel] = y;
        if (commit) for (size_t j = 0; j < S; ++j) stored[j] = (j + 1 < S ? s[j + 1] : 0.0) + v.b(0, j + 1) * u;
        break;
    }
    case FirLattice: {
        double f = u, g = u;
        for (size_t i = 0; i < M; ++i) {
            const double kappa = v.b(0, i);
            const double delayed = s[i];
            if (commit) stored[i] = g;
            const double fNext = f + kappa * delayed;
            g = kappa * f + delayed;
            f = fNext;
        }
        k.out[channel] = f;
        break;
    }
    default: {
        for (size_t row = 0; row < v.r(); ++row) {
            double y = v.b(row, 0) * u;
            for (size_t j = 1; j < M; ++j) y += v.b(row, j) * s[j - 1];
            k.out[v.r() > 1 ? row : channel] = y;
        }
        if (commit) {
            for (size_t j = S; j > 1; --j) stored[j - 1] = s[j - 2];
            if (S > 0) stored[0] = u;
        }
        break;
    }
    }
}
void firOutputs(KernelContext& k) {
    const FirView v{k};
    if (!v.enabled()) {
        for (size_t i = 0; i < v.w() * v.r(); ++i) k.out[i] = k.d[1] != 0.0 ? v.lastOut()[i] : 0.0;
        return;
    }
    const bool fresh = v.fresh();
    for (size_t channel = 0; channel < v.w(); ++channel) firChannel(k, v, channel, fresh, false);
}
void firUpdate(KernelContext& k) {
    const FirView v{k};
    if (!v.enabled()) return;
    const bool fresh = v.fresh();
    for (size_t channel = 0; channel < v.w(); ++channel) firChannel(k, v, channel, fresh, true);
    std::copy_n(k.out, v.w() * v.r(), v.lastOut());
    k.d[1] = 1.0;
    k.d[2] = 1.0;
    if (k.ip[FirReset] != 0) k.d[0] = k.input(v.resetPort());
}

// ---- Seção de primeira ordem por elemento (Transfer Fcn First Order, Lead or Lag, Real Zero,
// Difference, Discrete Derivative) ------------------------------------------------------------------
// y(k) = b0 u(k) + b1 s(k-1) + a1 y(k-1), s(k) = g u(k) (entrada anterior ponderada).
// rp = [b0, b1, a1, g, IC de s (1 ou n), IC de y (1 ou n)]; ip = [larguraIC]; d = [s x n, y x n].
KernelShape fosConfigure(const KernelConfig& c) {
    requireInputs(c, 1, "Transfer Fcn");
    requireExpandable(c, "Transfer Fcn");
    if (c.intParameters.size() != 1) fail("Transfer Fcn: parametros internos invalidos");
    const auto icWidth = static_cast<size_t>(c.intParameters[0]);
    if ((icWidth != 1 && icWidth != c.outputWidth) || c.realParameters.size() != 4 + 2 * icWidth) fail("Transfer Fcn: condicoes iniciais com largura incompativel");
    for (double value : c.realParameters) if (!std::isfinite(value)) fail("Transfer Fcn: parametros devem ser finitos");
    return {0, static_cast<uint32_t>(2 * c.outputWidth), {static_cast<uint8_t>(c.realParameters[0] != 0.0 ? 1 : 0)}};
}
void fosInit(KernelContext& k) {
    const auto icWidth = static_cast<size_t>(k.ip[0]);
    for (uint16_t i = 0; i < k.outWidth; ++i) {
        k.d[i] = k.rp[4 + (icWidth == 1 ? 0 : i)];
        k.d[k.outWidth + i] = k.rp[4 + icWidth + (icWidth == 1 ? 0 : i)];
    }
}
void fosOutputs(KernelContext& k) {
    for (uint16_t i = 0; i < k.outWidth; ++i) k.out[i] = k.rp[0] * k.input(0, i) + k.rp[1] * k.d[i] + k.rp[2] * k.d[k.outWidth + i];
}
void fosUpdate(KernelContext& k) {
    for (uint16_t i = 0; i < k.outWidth; ++i) {
        k.d[i] = k.rp[3] * k.input(0, i);
        k.d[k.outWidth + i] = k.out[i];
    }
}

// ---- Discrete-Time Integrator --------------------------------------------------------------------
// ip = [n, método (0 Forward Euler, 1 Backward Euler, 2 Trapezoidal), reset (0 none, 1 rising,
//       2 falling, 3 either, 4 level, 5 sampled level), icExterna, limite, mostraSat, mostraEstado,
//       icNaSaida (Initial condition setting = Output)]
// rp = [K x n, IC x n, Upper x n, Lower x n, T] (T = Ts na integração, 1 na acumulação)
// Entradas: u, [External reset], [x0]. Saída: [y | sat | state]. d = [x x n, resetAnterior x n, iniciado].
// Equações documentadas (T fixo, bloco não disparado):
//   FE: y(n) = x(n);              x(n+1) = clip(x(n) + K T u(n))      (o estado é limitado)
//   BE: y(n) = clip(x(n) + K T u(n));   x(n+1) = y(n)
//   TR: y(n) = clip(x(n) + K T/2 u(n)); x(n+1) = y(n) + K T/2 u(n)
// Na primeira amostra e no reset, Auto aplica IC ao ESTADO (x(n) = clip(IC)); Output aplica à SAÍDA
// (y(n) = clip(IC)). Bordas usam só valores positivos (doc.: -1 -> 0 não é subida, 0 -> 1 é);
// level: não nulo agora ou não nulo -> zero; sampled level: não nulo agora. Porta de estado: x(n)
// antes do reset (quebra laço algébrico de integrador que se reseta).
enum DtiIp { DtiN = 0, DtiMethod, DtiReset, DtiIcExternal, DtiLimit, DtiShowSat, DtiShowState, DtiIcOutput, DtiIpCount };

bool dtiTriggered(int64_t mode, double previous, double current) {
    const bool rising = previous <= 0.0 && current > 0.0;
    const bool falling = previous > 0.0 && current <= 0.0;
    switch (mode) {
    case 1: return rising;
    case 2: return falling;
    case 3: return rising || falling;
    case 4: return current != 0.0 || (previous != 0.0 && current == 0.0);
    case 5: return current != 0.0;
    default: return false;
    }
}

struct DtiStep { double y, next, state; };

DtiStep dtiStep(const KernelContext& k, size_t i) {
    const size_t n = static_cast<size_t>(k.ip[DtiN]);
    const bool limit = k.ip[DtiLimit] != 0;
    const double upper = k.rp[2 * n + i], lower = k.rp[3 * n + i];
    const auto clip = [&](double v) { return limit ? std::clamp(v, lower, upper) : v; };
    const uint16_t resetPort = 1;
    const uint16_t x0Port = static_cast<uint16_t>(k.ip[DtiReset] != 0 ? 2 : 1);
    const bool reset = k.ip[DtiReset] != 0 && dtiTriggered(k.ip[DtiReset], k.d[n + i], k.input(resetPort, static_cast<uint16_t>(i)));
    const bool fresh = k.d[2 * n] == 0.0 || reset;
    const double ic = clip(k.ip[DtiIcExternal] != 0 ? k.input(x0Port, static_cast<uint16_t>(i)) : k.rp[n + i]);
    const double x = fresh ? ic : k.d[i];
    const double kt = k.rp[i] * k.rp[4 * n];
    const double u = k.input(0, static_cast<uint16_t>(i));
    const bool atOutput = fresh && k.ip[DtiIcOutput] != 0;
    DtiStep step{};
    step.state = k.d[2 * n] == 0.0 ? ic : k.d[i];
    switch (k.ip[DtiMethod]) {
    case 0: step.y = x; step.next = clip(step.y + kt * u); break;
    case 1: step.y = atOutput ? ic : clip(x + kt * u); step.next = step.y; break;
    default: step.y = atOutput ? ic : clip(x + 0.5 * kt * u); step.next = step.y + 0.5 * kt * u; break;
    }
    return step;
}

KernelShape dtiConfigure(const KernelConfig& c) {
    if (c.intParameters.size() != DtiIpCount) fail("Discrete-Time Integrator: parametros internos invalidos");
    const auto& ip = c.intParameters;
    const auto n = static_cast<size_t>(ip[DtiN]);
    const size_t inputs = 1 + (ip[DtiReset] != 0 ? 1 : 0) + (ip[DtiIcExternal] != 0 ? 1 : 0);
    requireInputs(c, inputs, "Discrete-Time Integrator");
    for (uint16_t w : c.inputWidths) if (w != 1 && w != n) fail("Discrete-Time Integrator: largura de entrada incompativel");
    const size_t outputs = n * (1 + (ip[DtiShowSat] != 0 ? 1 : 0) + (ip[DtiShowState] != 0 ? 1 : 0));
    if (c.outputWidth != outputs) fail("Discrete-Time Integrator: largura de saida incompativel");
    if (c.realParameters.size() != 4 * n + 1) fail("Discrete-Time Integrator: parametros com largura incompativel");
    for (size_t i = 0; i < n; ++i) {
        if (!(c.realParameters[i] > 0.0) || !std::isfinite(c.realParameters[i])) fail("Discrete-Time Integrator: Gain value deve ser real positivo");
        if (!std::isfinite(c.realParameters[n + i])) fail("Discrete-Time Integrator: Initial condition nao pode ser Inf ou NaN");
        if (ip[DtiLimit] != 0 && c.realParameters[3 * n + i] > c.realParameters[2 * n + i])
            fail("Discrete-Time Integrator: Lower saturation limit maior que Upper saturation limit");
    }
    if (!(c.realParameters[4 * n] > 0.0) || !std::isfinite(c.realParameters[4 * n])) fail("Discrete-Time Integrator: tempo de amostragem invalido");
    std::vector<uint8_t> ft(inputs, 1);
    ft[0] = ip[DtiMethod] == 0 ? 0 : 1;
    return {0, static_cast<uint32_t>(2 * n + 1), ft};
}
void dtiInit(KernelContext& k) {
    const auto n = static_cast<size_t>(k.ip[DtiN]);
    for (size_t i = 0; i < n; ++i) {
        const double ic = k.ip[DtiLimit] != 0 ? std::clamp(k.rp[n + i], k.rp[3 * n + i], k.rp[2 * n + i]) : k.rp[n + i];
        k.d[i] = ic;
        k.d[n + i] = 0.0;
    }
    k.d[2 * n] = 0.0;
}
void dtiOutputs(KernelContext& k) {
    const auto n = static_cast<size_t>(k.ip[DtiN]);
    const bool limit = k.ip[DtiLimit] != 0;
    const size_t stateOffset = n * (k.ip[DtiShowSat] != 0 ? 2 : 1);
    for (size_t i = 0; i < n; ++i) {
        const DtiStep step = dtiStep(k, i);
        k.out[i] = step.y;
        if (k.ip[DtiShowSat] != 0) {
            const double upper = k.rp[2 * n + i], lower = k.rp[3 * n + i];
            k.out[n + i] = !limit ? 0.0 : step.y >= upper ? 1.0 : step.y <= lower ? -1.0 : 0.0;
        }
        if (k.ip[DtiShowState] != 0) k.out[stateOffset + i] = step.state;
    }
}
void dtiUpdate(KernelContext& k) {
    const auto n = static_cast<size_t>(k.ip[DtiN]);
    double* next = k.d; // calculado elemento a elemento: o passo i só lê o estado i
    for (size_t i = 0; i < n; ++i) {
        const DtiStep step = dtiStep(k, i);
        next[i] = step.next;
    }
    if (k.ip[DtiReset] != 0) for (size_t i = 0; i < n; ++i) k.d[n + i] = k.input(1, static_cast<uint16_t>(i));
    k.d[2 * n] = 1.0;
}

// ---- Tapped Delay -------------------------------------------------------------------------------
// ip = [N, maisNovoPrimeiro, incluiAtual]; rp = [vinit]; entrada escalar.
// d = [cabeça, anel N]. Oldest: y = [u(k-N) ... u(k-1) (u(k))]; Newest: ordem inversa.
KernelShape tappedConfigure(const KernelConfig& c) {
    requireInputs(c, 1, "Tapped Delay");
    if (c.intParameters.size() != 3 || c.intParameters[0] < 1 || c.realParameters.size() != 1) fail("Tapped Delay: parametros internos invalidos");
    if (c.inputWidths[0] != 1) fail("Tapped Delay: a entrada deve ser escalar (largura 1)");
    if (!std::isfinite(c.realParameters[0])) fail("Tapped Delay: Initial condition nao pode ser Inf ou NaN");
    const auto n = static_cast<size_t>(c.intParameters[0]);
    if (c.outputWidth != n + (c.intParameters[2] != 0 ? 1 : 0)) fail("Tapped Delay: largura de saida incompativel");
    return {0, static_cast<uint32_t>(1 + n), {static_cast<uint8_t>(c.intParameters[2] != 0 ? 1 : 0)}};
}
void tappedInit(KernelContext& k) {
    const auto n = static_cast<size_t>(k.ip[0]);
    k.d[0] = 0.0;
    std::fill_n(k.d + 1, n, k.rp[0]);
}
void tappedOutputs(KernelContext& k) {
    const auto n = static_cast<size_t>(k.ip[0]);
    const bool newest = k.ip[1] != 0, current = k.ip[2] != 0;
    const auto head = static_cast<size_t>(k.d[0]);
    const auto past = [&](size_t j) { return k.d[1 + (head + n - j) % n]; }; // u(k-j), j = 1..N
    const size_t total = n + (current ? 1 : 0);
    for (size_t m = 0; m < total; ++m) {
        // Posição m na ordem "mais antigo primeiro": u(k - N + m).
        const size_t oldestIndex = newest ? total - 1 - m : m;
        const size_t lag = n - oldestIndex; // 0 = atual
        k.out[m] = lag == 0 ? k.input(0) : past(lag);
    }
}
void tappedUpdate(KernelContext& k) {
    const auto n = static_cast<size_t>(k.ip[0]);
    const auto head = static_cast<size_t>(k.d[0]);
    k.d[1 + head] = k.input(0);
    k.d[0] = static_cast<double>((head + 1) % n);
}

// ---- Conditional Hold: y = y(k-1) com h verdadeiro (IC na primeira amostra); y = u com h falso. ----
// rp = InitialCondition (1 ou n); entradas u, h; d = [retido x n, temAnterior].
KernelShape condHoldConfigure(const KernelConfig& c) {
    requireInputs(c, 2, "Conditional Hold");
    requireExpandable(c, "Conditional Hold");
    if (c.realParameters.size() != 1 && c.realParameters.size() != c.outputWidth) fail("Conditional Hold: Initial condition com largura incompativel");
    return {0, static_cast<uint32_t>(c.outputWidth + 1), {1, 1}};
}
void condHoldOutputs(KernelContext& k) {
    const bool hasPrevious = k.d[k.outWidth] != 0.0;
    for (uint16_t i = 0; i < k.outWidth; ++i)
        k.out[i] = k.input(1, i) != 0.0 ? (hasPrevious ? k.d[i] : k.rp[k.rpCount == 1 ? 0 : i]) : k.input(0, i);
}
void condHoldUpdate(KernelContext& k) {
    std::copy_n(k.out, k.outWidth, k.d);
    k.d[k.outWidth] = 1.0;
}

const KernelSpec kUnitDelay{"unit_delay", unitDelayConfigure, unitDelayInit, unitDelayOutputs, unitDelayUpdate, nullptr, nullptr};
const KernelSpec kDelayN{"delay", delayNConfigure, delayNInit, delayNOutputs, delayNUpdate, nullptr, nullptr};
const KernelSpec kDelayGeneral{"delay_general", delayGConfigure, delayGInit, delayGOutputs, delayGUpdate, nullptr, nullptr};
const KernelSpec kZoh{"zero_order_hold", zohConfigure, nullptr, zohOutputs, nullptr, nullptr, nullptr};
const KernelSpec kIir{"iir_filter", iirConfigure, nullptr, iirOutputs, iirUpdate, nullptr, nullptr};
const KernelSpec kFir{"fir_filter", firConfigure, nullptr, firOutputs, firUpdate, nullptr, nullptr};
const KernelSpec kFirstOrderSection{"first_order_section", fosConfigure, fosInit, fosOutputs, fosUpdate, nullptr, nullptr};
const KernelSpec kDiscreteIntegrator{"discrete_integrator", dtiConfigure, dtiInit, dtiOutputs, dtiUpdate, nullptr, nullptr};
const KernelSpec kTappedDelay{"tapped_delay", tappedConfigure, tappedInit, tappedOutputs, tappedUpdate, nullptr, nullptr};
const KernelSpec kConditionalHold{"conditional_hold", condHoldConfigure, nullptr, condHoldOutputs, condHoldUpdate, nullptr, nullptr};

const KernelSpec* const kDiscrete[] = {&kUnitDelay, &kDelayN, &kDelayGeneral, &kZoh, &kIir, &kFir, &kFirstOrderSection,
                                       &kDiscreteIntegrator, &kTappedDelay, &kConditionalHold};
} // namespace

std::span<const KernelSpec* const> discreteKernels() { return kDiscrete; }

} // namespace lasecsimul::simulation::library
