// Roteamento de sinais (biblioteca Signal Routing) e a infraestrutura de saídas múltiplas.
// `slice`, `concat` e `passthrough` são infraestrutura usada também por outras famílias e pela
// sessão (relay de porta de tempo contínuo): ids, layouts e semântica são estáveis.
#include <cmath>
#include <limits>

#include "../KernelCommon.hpp"
#include "Families.hpp"

namespace lasecsimul::simulation::library {
namespace {
using namespace detail;

// ---- Slice: ip = [offset]. y = u[offset .. offset+largura). É como uma porta de saída N de um bloco
// com várias saídas lê o vetor concatenado do kernel (Demux usa o mesmo kernel). ----
KernelShape sliceConfigure(const KernelConfig& c) {
    requireInputs(c, 1, "Slice");
    if (c.intParameters.size() != 1 || c.intParameters[0] < 0 ||
        static_cast<size_t>(c.intParameters[0]) + c.outputWidth > c.inputWidths[0])
        fail("Slice: faixa fora do vetor de entrada");
    return {0, 0, {1}};
}
void sliceOutputs(KernelContext& k) {
    const auto offset = static_cast<size_t>(k.ip[0]);
    for (uint16_t i = 0; i < k.outWidth; ++i) k.out[i] = k.in[0][offset + i];
}

// ---- Mux / Vector Concatenate: concatena as entradas na ordem das portas. ----
KernelShape concatConfigure(const KernelConfig& c) {
    if (c.inputWidths.empty()) fail("Mux: ao menos uma entrada");
    size_t total = 0;
    for (uint16_t w : c.inputWidths) total += w;
    if (total != c.outputWidth) fail("Mux: largura da saida difere da soma das entradas");
    return {0, 0, allFeedthrough(c.inputWidths.size())};
}
void concatOutputs(KernelContext& k) {
    size_t offset = 0;
    for (uint16_t port = 0; port < k.inputCount; ++port)
        for (uint16_t i = 0; i < k.inWidth[port]; ++i) k.out[offset++] = k.in[port][i];
}

// ---- Passagem (identidade com feedthrough): relay de porta de tempo contínuo na partição contínua;
// também Signal Conversion/Signal Specification/Rate Transition (cópia ou ZOH na taxa do kernel). ----
KernelShape passthroughConfigure(const KernelConfig& c) {
    requireInputs(c, 1, "passagem");
    if (c.inputWidths[0] != c.outputWidth) fail("passagem: larguras diferentes");
    return {0, 0, {1}};
}
void passthroughOutputs(KernelContext& k) { for (uint16_t i = 0; i < k.outWidth; ++i) k.out[i] = k.in[0][i]; }

// ---- Switch: entradas [u1, u2 (controle), u3]; ip = [criterio, zeroCross]; rp = Threshold (1 ou
// largura); d = modo por elemento (1 = passa u1). Critério 0: u2 >= Threshold; 1: u2 > Threshold;
// 2: u2 ~= 0. y_i = u1_i se o critério vale para u2_i, senão u3_i (expansão escalar em tudo).
// Com ZeroCross ligado o modo só muda em passo MAIOR e fica congelado nos estágios do integrador
// (sem localização do instante de cruzamento -- ver docs/66); desligado, o critério é avaliado em
// toda chamada, inclusive nos estágios (o que o Simulink faz sem detecção de cruzamento). ----
enum SwitchCriteria : int64_t { SwitchGe = 0, SwitchGt = 1, SwitchNonzero = 2 };
KernelShape switchConfigure(const KernelConfig& c) {
    requireInputs(c, 3, "Switch");
    requireExpandable(c, "Switch");
    if (c.intParameters.size() != 2 || c.intParameters[0] < SwitchGe || c.intParameters[0] > SwitchNonzero)
        fail("Switch: parametros internos invalidos");
    if (c.realParameters.size() != 1 && c.realParameters.size() != c.outputWidth) fail("Switch: Threshold com largura incompativel");
    return {0, c.outputWidth, {1, 1, 1}};
}
bool switchPassesFirst(const KernelContext& k, uint16_t i) {
    const double u2 = k.input(1, i);
    switch (k.ip[0]) {
    case SwitchGe: return u2 >= k.rp[k.rpCount == 1 ? 0 : i];
    case SwitchGt: return u2 > k.rp[k.rpCount == 1 ? 0 : i];
    default: return u2 != 0.0;
    }
}
void switchInit(KernelContext& k) { for (uint16_t i = 0; i < k.outWidth; ++i) k.d[i] = switchPassesFirst(k, i) ? 1.0 : 0.0; }
void switchOutputs(KernelContext& k) {
    const bool latched = k.ip[1] != 0;
    for (uint16_t i = 0; i < k.outWidth; ++i) {
        bool first;
        if (!latched) first = switchPassesFirst(k, i);
        else {
            if (k.major) k.d[i] = switchPassesFirst(k, i) ? 1.0 : 0.0;
            first = k.d[i] != 0.0;
        }
        k.out[i] = first ? k.input(0, i) : k.input(2, i);
    }
}

// ---- Multiport Switch: entradas [controle, d1..dN, (porta * adicional)]; ip = [N, adicional(0/1),
// diagnostico(0 None, 1 Warning, 2 Error), pares, (indice, porta 0-based)...]. k = fix(controle);
// a porta é a do par cujo índice é k. Fora da faixa (inclusive NaN/Inf/além de int32, que no
// Simulink é erro de execução): porta * adicional ou a última porta de dados; com Diagnostic =
// Error o Simulink PARA a simulação -- o engine não tem canal de erro de execução, então a saída
// vira NaN (erro visível em vez de valor plausível). Dados com expansão escalar. ----
KernelShape multiportConfigure(const KernelConfig& c) {
    if (c.intParameters.size() < 4) fail("Multiport Switch: parametros internos invalidos");
    const int64_t n = c.intParameters[0], additional = c.intParameters[1], pairs = c.intParameters[3];
    if (n < 1 || (additional != 0 && additional != 1) || pairs < 1 || c.intParameters.size() != static_cast<size_t>(4 + 2 * pairs))
        fail("Multiport Switch: parametros internos invalidos");
    requireInputs(c, static_cast<size_t>(1 + n + additional), "Multiport Switch");
    if (c.inputWidths[0] != 1) fail("Multiport Switch: largura do controle precisa ser 1 (controle escalar)");
    for (size_t port = 1; port < c.inputWidths.size(); ++port)
        if (c.inputWidths[port] != 1 && c.inputWidths[port] != c.outputWidth) fail("Multiport Switch: largura de entrada incompativel com a saida");
    for (int64_t p = 0; p < pairs; ++p) {
        const int64_t port = c.intParameters[4 + 2 * p + 1];
        if (port < 0 || port >= n) fail("Multiport Switch: porta de dados invalida");
    }
    return {0, 0, allFeedthrough(c.inputWidths.size())};
}
/** Controle -> porta de dados (0-based); -1 = fora da faixa. */
int64_t multiportPort(const KernelContext& k) {
    const double control = k.in[0][0];
    if (!std::isfinite(control)) return -1;
    const double truncated = std::trunc(control);
    if (truncated < static_cast<double>(std::numeric_limits<int32_t>::min()) || truncated > static_cast<double>(std::numeric_limits<int32_t>::max()))
        return -1;
    const auto index = static_cast<int64_t>(truncated);
    const int64_t pairs = k.ip[3];
    for (int64_t p = 0; p < pairs; ++p)
        if (k.ip[4 + 2 * p] == index) return k.ip[4 + 2 * p + 1];
    return -1;
}
void multiportOutputs(KernelContext& k) {
    const int64_t n = k.ip[0];
    int64_t port = multiportPort(k);
    if (port < 0) {
        if (k.ip[2] == 2) { for (uint16_t i = 0; i < k.outWidth; ++i) k.out[i] = std::numeric_limits<double>::quiet_NaN(); return; }
        port = k.ip[1] != 0 ? n : n - 1;
    }
    const auto input = static_cast<uint16_t>(1 + port);
    for (uint16_t i = 0; i < k.outWidth; ++i) k.out[i] = k.input(input, i);
}

// ---- Index Vector (Multiport Switch com 1 porta de dados contígua): entradas [controle, d,
// (porta *)]; ip = [base (0/1), adicional(0/1), diagnostico]. y = d(fix(controle) - base) -- o
// ELEMENTO do vetor de dados; fora da faixa: elemento * (adicional) ou o último elemento; Error ->
// NaN (ver Multiport Switch). Saída escalar. ----
KernelShape indexVectorConfigure(const KernelConfig& c) {
    if (c.intParameters.size() != 3 || (c.intParameters[1] != 0 && c.intParameters[1] != 1)) fail("Index Vector: parametros internos invalidos");
    requireInputs(c, static_cast<size_t>(2 + c.intParameters[1]), "Index Vector");
    if (c.inputWidths[0] != 1) fail("Index Vector: largura do controle precisa ser 1 (controle escalar)");
    if (c.intParameters[1] != 0 && c.inputWidths[2] != 1) fail("Index Vector: largura da porta * precisa ser 1");
    if (c.outputWidth != 1) fail("Index Vector: largura da saida precisa ser 1");
    return {0, 0, allFeedthrough(c.inputWidths.size())};
}
void indexVectorOutputs(KernelContext& k) {
    const double control = k.in[0][0];
    const uint16_t width = k.inWidth[1];
    if (std::isfinite(control)) {
        const double index = std::trunc(control) - static_cast<double>(k.ip[0]);
        if (index >= 0.0 && index < static_cast<double>(width)) { k.out[0] = k.in[1][static_cast<size_t>(index)]; return; }
    }
    if (k.ip[2] == 2) k.out[0] = std::numeric_limits<double>::quiet_NaN();
    else k.out[0] = k.ip[1] != 0 ? k.in[2][0] : k.in[1][width - 1];
}

// ---- Manual Switch: entradas [u1, u2]; rp = [sw] (ajustável: '1' = entrada de cima, '0' = de
// baixo). y = sw ? u1 : u2, com expansão escalar. ----
KernelShape manualSwitchConfigure(const KernelConfig& c) {
    requireInputs(c, 2, "Manual Switch");
    requireExpandable(c, "Manual Switch");
    requireParams(c, 1, "Manual Switch");
    return {0, 0, {1, 1}};
}
void manualSwitchOutputs(KernelContext& k) {
    const uint16_t port = k.rp[0] != 0.0 ? 0 : 1;
    for (uint16_t i = 0; i < k.outWidth; ++i) k.out[i] = k.input(port, i);
}

// ---- Selector (1-D): entradas [u, (Idx1)]; ip = [modo, base]; rp = índices 0-based (modo 1) ou
// início 0-based (modo 3). Modos: 0 Select all; 1 Index vector (dialog); 2 Index vector (port);
// 3 Starting index (dialog); 4 Starting index (port). Índices da porta: fix(valor) - base. Índice
// fora da faixa vindo da porta é erro de execução no Simulink (para a simulação); aqui a posição
// sai NaN (o engine não tem canal de erro de execução). ----
enum SelectorMode : int64_t { SelectAll = 0, SelectDialogVector, SelectPortVector, SelectDialogStart, SelectPortStart };
KernelShape selectorConfigure(const KernelConfig& c) {
    if (c.intParameters.size() != 2 || c.intParameters[0] < SelectAll || c.intParameters[0] > SelectPortStart)
        fail("Selector: parametros internos invalidos");
    const int64_t mode = c.intParameters[0];
    const bool port = mode == SelectPortVector || mode == SelectPortStart;
    requireInputs(c, port ? 2 : 1, "Selector");
    const uint16_t width = c.inputWidths[0];
    switch (mode) {
    case SelectAll: if (c.outputWidth != width) fail("Selector: largura da saida difere da entrada"); break;
    case SelectDialogVector:
        if (c.realParameters.size() != c.outputWidth) fail("Selector: parametros internos invalidos");
        for (double index : c.realParameters) if (!(index >= 0.0) || index >= width) fail("Selector: indice fora da faixa do vetor de entrada");
        break;
    case SelectPortVector: if (c.inputWidths[1] != c.outputWidth) fail("Selector: largura da saida difere da largura de Idx1"); break;
    case SelectDialogStart:
        if (c.realParameters.size() != 1 || !(c.realParameters[0] >= 0.0) || c.realParameters[0] + c.outputWidth > width)
            fail("Selector: faixa fora do vetor de entrada");
        break;
    default: if (c.inputWidths[1] != 1) fail("Selector: Idx1 (indice inicial) precisa ter largura 1"); break;
    }
    return {0, 0, allFeedthrough(c.inputWidths.size())};
}
double selectorElement(const KernelContext& k, double index) {
    if (!std::isfinite(index)) return std::numeric_limits<double>::quiet_NaN();
    const double position = std::trunc(index) - static_cast<double>(k.ip[1]);
    if (position < 0.0 || position >= static_cast<double>(k.inWidth[0])) return std::numeric_limits<double>::quiet_NaN();
    return k.in[0][static_cast<size_t>(position)];
}
void selectorOutputs(KernelContext& k) {
    switch (k.ip[0]) {
    case SelectAll: for (uint16_t i = 0; i < k.outWidth; ++i) k.out[i] = k.in[0][i]; break;
    case SelectDialogVector: for (uint16_t i = 0; i < k.outWidth; ++i) k.out[i] = k.in[0][static_cast<size_t>(k.rp[i])]; break;
    case SelectPortVector: for (uint16_t i = 0; i < k.outWidth; ++i) k.out[i] = selectorElement(k, k.in[1][i]); break;
    case SelectDialogStart: {
        const auto start = static_cast<size_t>(k.rp[0]);
        for (uint16_t i = 0; i < k.outWidth; ++i) k.out[i] = k.in[0][start + i];
        break;
    }
    default: {
        const double start = k.in[1][0];
        for (uint16_t i = 0; i < k.outWidth; ++i) k.out[i] = selectorElement(k, start + static_cast<double>(i));
        break;
    }
    }
}

// ---- Merge: N entradas; ip = [N, offset_1..offset_N]; rp = Initial output expandido para a largura
// (InitialOutput [] = 0, valor padrão do tipo no modo de inicialização simplificado). d = [iniciado,
// porta ativa por elemento (-1 = nenhuma) x largura, último valor visto de cada entrada...]. A saída
// é o valor que a entrada "escreveu" por último; sem subsistemas condicionais no LasecSimul toda
// entrada é calculada em todo acerto, então ESCRITA = mudança de valor observada num passo maior
// (no mesmo passo vence a porta de número maior). O primeiro passo maior só registra os valores
// (saída = Initial output até a primeira escrita). Entre passos maiores a porta ativa fica fixa e a
// saída acompanha o valor corrente dela. ----
KernelShape mergeConfigure(const KernelConfig& c) {
    if (c.intParameters.empty() || c.intParameters[0] < 1 || c.intParameters.size() != static_cast<size_t>(1 + c.intParameters[0]))
        fail("Merge: parametros internos invalidos");
    requireInputs(c, static_cast<size_t>(c.intParameters[0]), "Merge");
    if (c.realParameters.size() != c.outputWidth) fail("Merge: Initial output com largura incompativel");
    uint32_t seen = 0;
    for (size_t port = 0; port < c.inputWidths.size(); ++port) {
        const int64_t offset = c.intParameters[1 + port];
        if (offset < 0 || offset + c.inputWidths[port] > c.outputWidth) fail("Merge: faixa fora do vetor de saida");
        seen += c.inputWidths[port];
    }
    return {0, 1u + c.outputWidth + seen, allFeedthrough(c.inputWidths.size())};
}
void mergeInit(KernelContext& k) {
    k.d[0] = 0.0;
    for (uint16_t i = 0; i < k.outWidth; ++i) k.d[1 + i] = -1.0;
}
void mergeOutputs(KernelContext& k) {
    double* active = k.d + 1;
    double* seen = active + k.outWidth;
    if (k.major) {
        const bool started = k.d[0] != 0.0;
        size_t cursor = 0;
        for (uint16_t port = 0; port < k.inputCount; ++port) {
            bool written = false;
            for (uint16_t i = 0; i < k.inWidth[port]; ++i) {
                const double value = k.in[port][i];
                const double previous = seen[cursor + i];
                if (started && !(value == previous || (std::isnan(value) && std::isnan(previous)))) written = true;
                seen[cursor + i] = value;
            }
            if (written) {
                const auto offset = static_cast<uint16_t>(k.ip[1 + port]);
                for (uint16_t i = 0; i < k.inWidth[port]; ++i) active[offset + i] = port;
            }
            cursor += k.inWidth[port];
        }
        k.d[0] = 1.0;
    }
    for (uint16_t i = 0; i < k.outWidth; ++i) {
        const double port = active[i];
        if (port < 0.0) { k.out[i] = k.rp[i]; continue; }
        const auto p = static_cast<uint16_t>(port);
        k.out[i] = k.in[p][i - static_cast<uint16_t>(k.ip[1 + p])];
    }
}

// ---- Rate Transition, transição lenta -> rápida determinística ("1/z" na taxa LENTA): rp =
// InitialCondition (1 ou largura); d = valor segurado. y = d; no acerto lento d = u. Um kernel de
// passagem na taxa rápida publica a saída (ver RoutingBuilders). ----
KernelShape rtDelayConfigure(const KernelConfig& c) {
    requireInputs(c, 1, "Rate Transition");
    requireExpandable(c, "Rate Transition");
    if (c.realParameters.size() != 1 && c.realParameters.size() != c.outputWidth) fail("Rate Transition: Initial conditions com largura incompativel");
    return {0, c.outputWidth, {0}};
}
void rtDelayInit(KernelContext& k) { for (uint16_t i = 0; i < k.outWidth; ++i) k.d[i] = k.rp[k.rpCount == 1 ? 0 : i]; }
void rtDelayOutputs(KernelContext& k) { for (uint16_t i = 0; i < k.outWidth; ++i) k.out[i] = k.d[i]; }
void rtDelayUpdate(KernelContext& k) { for (uint16_t i = 0; i < k.outWidth; ++i) k.d[i] = k.input(0, i); }

const KernelSpec kSlice{"slice", sliceConfigure, nullptr, sliceOutputs, nullptr, nullptr, nullptr};
const KernelSpec kPassthrough{"passthrough", passthroughConfigure, nullptr, passthroughOutputs, nullptr, nullptr, nullptr};
const KernelSpec kConcat{"concat", concatConfigure, nullptr, concatOutputs, nullptr, nullptr, nullptr};
const KernelSpec kSwitch{"switch", switchConfigure, switchInit, switchOutputs, nullptr, nullptr, nullptr};
const KernelSpec kMultiport{"multiport_switch", multiportConfigure, nullptr, multiportOutputs, nullptr, nullptr, nullptr};
const KernelSpec kIndexVector{"index_vector", indexVectorConfigure, nullptr, indexVectorOutputs, nullptr, nullptr, nullptr};
const KernelSpec kManualSwitch{"manual_switch", manualSwitchConfigure, nullptr, manualSwitchOutputs, nullptr, nullptr, nullptr};
const KernelSpec kSelector{"selector", selectorConfigure, nullptr, selectorOutputs, nullptr, nullptr, nullptr};
const KernelSpec kMerge{"merge", mergeConfigure, mergeInit, mergeOutputs, nullptr, nullptr, nullptr};
const KernelSpec kRtDelay{"rate_transition_delay", rtDelayConfigure, rtDelayInit, rtDelayOutputs, rtDelayUpdate, nullptr, nullptr};

const KernelSpec* const kRouting[] = {&kSlice, &kConcat, &kPassthrough, &kSwitch, &kMultiport, &kIndexVector,
                                      &kManualSwitch, &kSelector, &kMerge, &kRtDelay};
} // namespace

std::span<const KernelSpec* const> routingKernels() { return kRouting; }

} // namespace lasecsimul::simulation::library
