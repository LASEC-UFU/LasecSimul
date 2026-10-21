// Descontinuidades (biblioteca Discontinuities). Convenções da família:
//  - blocos ESTÁTICOS (Saturation, Dead Zone, Quantizer, Coulomb and Viscous Friction, Wrap To Zero
//    e as variantes Dynamic) calculam a saída direto, em todo passo maior e em todo estágio do
//    integrador;
//  - blocos de MODO com memória (Relay, Backlash, Hit Crossing) só trocam de modo em passo MAIOR
//    (`major`): nos estágios menores do RK4 a saída fica no modo do último passo maior, como o
//    Simulink faz entre passos maiores. O engine não localiza o instante do cruzamento por zero
//    (docs/66): a troca acontece no primeiro passo maior depois dele;
//  - o modo/estado comprometido só muda em `update` (depois de todas as saídas do instante), então
//    reavaliar `outputs` no mesmo instante (laço algébrico) não acumula efeito.
// Parâmetros vetoriais seguem a expansão escalar: cada vetor tem 1 elemento ou a largura da saída.
#include <algorithm>
#include <cmath>

#include "../KernelCommon.hpp"
#include "Families.hpp"
#include "ResetEdge.hpp"

namespace lasecsimul::simulation::library {
namespace {
using namespace detail;

/** Vetores de parâmetro concatenados em `rp`; `ip[first .. first+count)` guarda o tamanho de cada um
 * (o último é o resto de `rp`). `at(v, i)` aplica a expansão escalar. */
struct Packed {
    const double* rp;
    size_t offsets[6]{};
    size_t sizes[6]{};
    double at(size_t vector, size_t element) const { return rp[offsets[vector] + (sizes[vector] == 1 ? 0 : element)]; }
};
Packed unpack(const double* rp, size_t rpCount, const int64_t* ip, size_t first, size_t vectors) {
    Packed packed{rp};
    size_t offset = 0;
    for (size_t v = 0; v < vectors; ++v) {
        const size_t size = v + 1 < vectors ? static_cast<size_t>(ip[first + v]) : rpCount - offset;
        packed.offsets[v] = offset;
        packed.sizes[v] = size;
        offset += size;
    }
    return packed;
}
void requirePacked(const KernelConfig& c, size_t first, size_t vectors, size_t width, const char* block) {
    if (c.intParameters.size() < first + vectors - 1) fail(std::string(block) + ": parametros internos invalidos");
    size_t used = 0;
    for (size_t v = 0; v + 1 < vectors; ++v) {
        const auto size = static_cast<size_t>(c.intParameters[first + v]);
        if (size != 1 && size != width) fail(std::string(block) + ": parametro com largura incompativel");
        used += size;
    }
    if (used >= c.realParameters.size()) fail(std::string(block) + ": parametros insuficientes");
    const size_t last = c.realParameters.size() - used;
    if (last != 1 && last != width) fail(std::string(block) + ": parametro com largura incompativel");
}

// ---- Saturation: ip = [nUpper, status]; rp = [UpperLimit x nUpper, LowerLimit x nLower].
// y = Upper se u > Upper; Lower se u < Lower; u caso contrário (limites inclusivos). Com
// OutputSaturationStatus (R2026b) a saída é [y | satup | satlo], n elementos cada: satup = 1 quando
// u > Upper, satlo = 1 quando u < Lower. `ip` de um elemento (sem status) continua aceito.
size_t saturationElements(const KernelConfig& c) {
    const bool status = c.intParameters.size() == 2 && c.intParameters[1] != 0;
    return status ? c.outputWidth / 3 : c.outputWidth;
}
KernelShape saturationConfigure(const KernelConfig& c) {
    requireInputs(c, 1, "Saturation");
    if (c.intParameters.empty() || c.intParameters.size() > 2) fail("Saturation: parametros internos invalidos");
    const bool status = c.intParameters.size() == 2 && c.intParameters[1] != 0;
    const size_t n = saturationElements(c);
    if (n == 0 || n * (status ? 3 : 1) != c.outputWidth) fail("Saturation: largura de saida incompativel");
    if (c.inputWidths[0] != 1 && c.inputWidths[0] != n) fail("Saturation: largura de entrada incompativel com a saida");
    requirePacked(c, 0, 2, n, "Saturation");
    return {0, 0, {1}};
}
void saturationOutputs(KernelContext& k) {
    const bool status = k.ipCount == 2 && k.ip[1] != 0;
    const size_t n = status ? k.outWidth / 3u : k.outWidth;
    const Packed limits = unpack(k.rp, k.rpCount, k.ip, 0, 2);
    for (size_t i = 0; i < n; ++i) {
        const double u = k.input(0, static_cast<uint16_t>(i));
        const double upper = limits.at(0, i), lower = limits.at(1, i);
        k.out[i] = u > upper ? upper : u < lower ? lower : u;
        if (status) {
            k.out[n + i] = u > upper ? 1.0 : 0.0;
            k.out[2 * n + i] = u < lower ? 1.0 : 0.0;
        }
    }
}

// ---- Dead Zone: ip = [nLower]; rp = [LowerValue x nLower, UpperValue x nUpper].
// y = 0 se LL <= u <= UL (limites inclusivos); u - UL se u > UL; u - LL se u < LL.
KernelShape deadZoneConfigure(const KernelConfig& c) {
    requireInputs(c, 1, "Dead Zone");
    requireExpandable(c, "Dead Zone");
    requirePacked(c, 0, 2, c.outputWidth, "Dead Zone");
    return {0, 0, {1}};
}
void deadZoneOutputs(KernelContext& k) {
    const Packed limits = unpack(k.rp, k.rpCount, k.ip, 0, 2);
    for (uint16_t i = 0; i < k.outWidth; ++i) {
        const double u = k.input(0, i), lower = limits.at(0, i), upper = limits.at(1, i);
        k.out[i] = u > upper ? u - upper : u < lower ? u - lower : 0.0;
    }
}

// ---- Variantes Dynamic: entradas [up, u, lo], sem parâmetros. Mesmas equações dos blocos de
// limite fixo, com os limites lidos das entradas no instante.
KernelShape dynamicConfigure(const KernelConfig& c, const char* block) {
    requireInputs(c, 3, block);
    requireExpandable(c, block);
    return {0, 0, {1, 1, 1}};
}
KernelShape saturationDynamicConfigure(const KernelConfig& c) { return dynamicConfigure(c, "Saturation Dynamic"); }
KernelShape deadZoneDynamicConfigure(const KernelConfig& c) { return dynamicConfigure(c, "Dead Zone Dynamic"); }
void saturationDynamicOutputs(KernelContext& k) {
    for (uint16_t i = 0; i < k.outWidth; ++i) {
        const double upper = k.input(0, i), u = k.input(1, i), lower = k.input(2, i);
        k.out[i] = u > upper ? upper : u < lower ? lower : u;
    }
}
void deadZoneDynamicOutputs(KernelContext& k) {
    for (uint16_t i = 0; i < k.outWidth; ++i) {
        const double upper = k.input(0, i), u = k.input(1, i), lower = k.input(2, i);
        k.out[i] = u > upper ? u - upper : u < lower ? u - lower : 0.0;
    }
}

// ---- Relay: ip = [nOn, nOff, nOnOut]; rp = [OnSwitchValue, OffSwitchValue, OnOutputValue,
// OffOutputValue] (cada um 1 ou n). d = [modo x n] (0 desligado, 1 ligado), inicial desligado.
// Ligado continua ligado até u <= OffSwitchValue; desligado continua desligado até u >= OnSwitchValue
// (pontos iguais = chave com limiar naquele valor). Entrada inicial entre os pontos -> desligado.
KernelShape relayConfigure(const KernelConfig& c) {
    requireInputs(c, 1, "Relay");
    requireExpandable(c, "Relay");
    requirePacked(c, 0, 4, c.outputWidth, "Relay");
    return {0, c.outputWidth, {1}};
}
double relayNext(const Packed& p, size_t i, double mode, double u) {
    if (u >= p.at(0, i)) return 1.0;
    if (u <= p.at(1, i)) return 0.0;
    return mode;
}
void relayInit(KernelContext& k) { std::fill_n(k.d, k.outWidth, 0.0); }
void relayOutputs(KernelContext& k) {
    const Packed p = unpack(k.rp, k.rpCount, k.ip, 0, 4);
    for (uint16_t i = 0; i < k.outWidth; ++i) {
        const double mode = k.major ? relayNext(p, i, k.d[i], k.input(0, i)) : k.d[i];
        k.out[i] = mode != 0.0 ? p.at(2, i) : p.at(3, i);
    }
}
void relayUpdate(KernelContext& k) {
    const Packed p = unpack(k.rp, k.rpCount, k.ip, 0, 4);
    for (uint16_t i = 0; i < k.outWidth; ++i) k.d[i] = relayNext(p, i, k.d[i], k.input(0, i));
}

// ---- Rate Limiter: ip = [n, continuo]; rp = [R x n, F x n, IC x n].
// d = [y_ant x n, t_ant (ns), inicializado]. Com dt = t - t_ant:
//   u - y_ant > R dt -> y = y_ant + R dt; u - y_ant < F dt -> y = y_ant + F dt; senão y = u.
// Discreto (taxa herdada discreta): dt = Ts, y(-1) = InitialCondition (a saída em t = 0 já sai
// limitada a partir da condição inicial). Contínuo (SampleTimeMode = continuous, ou herdado de um
// sinal contínuo): InitialCondition é ignorada e y(0) = u(0); nos estágios menores dt é contado do
// último passo maior (o que o Simulink faz entre passos maiores). `inicializado`: 0 nada, 1 y(0) =
// u(0) registrado no instante inicial, 2 comprometido por `update`. Sem grupo discreto o engine não
// tem passo maior em t0 (o primeiro é o fim do primeiro passo); por isso a avaliação em t0 (o
// primeiro estágio do primeiro passo, tNs == majorNs) registra u(0) -- escrita idempotente, sempre
// sobrescrita pela avaliação seguinte no mesmo instante, nunca depois do primeiro `update`.
KernelShape rateLimiterConfigure(const KernelConfig& c) {
    requireInputs(c, 1, "Rate Limiter");
    requireExpandable(c, "Rate Limiter");
    if (c.intParameters.size() != 2 || c.intParameters[0] != c.outputWidth) fail("Rate Limiter: parametros internos invalidos");
    if (c.realParameters.size() != 3u * c.outputWidth) fail("Rate Limiter: parametros com largura incompativel");
    for (size_t i = 2u * c.outputWidth; i < c.realParameters.size(); ++i)
        if (!std::isfinite(c.realParameters[i])) fail("Rate Limiter: Initial condition nao pode ser Inf ou NaN");
    if (c.intParameters[1] == 0 && !(c.samplePeriod > 0.0)) fail("Rate Limiter: modo discreto sem periodo");
    return {0, static_cast<uint32_t>(c.outputWidth + 2u), {1}};
}
void rateLimiterInit(KernelContext& k) {
    const size_t n = k.outWidth;
    for (size_t i = 0; i < n; ++i) k.d[i] = k.rp[2 * n + i];
    k.d[n] = 0.0;
    k.d[n + 1] = 0.0;
}
void rateLimiterOutputs(KernelContext& k) {
    const size_t n = k.outWidth;
    const bool continuous = k.ip[1] != 0;
    const double flag = k.d[n + 1];
    const bool initialInstant = flag == 0.0 || (flag == 1.0 && static_cast<double>(k.tNs) == k.d[n]);
    if (continuous && initialInstant) {
        for (size_t i = 0; i < n; ++i) k.out[i] = k.input(0, static_cast<uint16_t>(i));
        if (k.tNs == k.majorNs) {
            std::copy_n(k.out, n, k.d);
            k.d[n] = static_cast<double>(k.tNs);
            k.d[n + 1] = 1.0;
        }
        return;
    }
    const double dt = continuous ? (static_cast<double>(k.tNs) - k.d[n]) * 1e-9 : k.ts;
    for (size_t i = 0; i < n; ++i) {
        const double u = k.input(0, static_cast<uint16_t>(i)), previous = k.d[i];
        const double rise = k.rp[i] * dt, fall = k.rp[n + i] * dt;
        const double delta = u - previous;
        k.out[i] = delta > rise ? previous + rise : delta < fall ? previous + fall : u;
    }
}
void rateLimiterUpdate(KernelContext& k) {
    const size_t n = k.outWidth;
    std::copy_n(k.out, n, k.d);
    k.d[n] = static_cast<double>(k.tNs);
    k.d[n + 1] = 2.0;
}

// ---- Rate Limiter Dynamic: entradas [up, u, lo]; d = [y_ant x n], y(-1) = 0. Só tempo discreto.
// y(k) = y(k-1) + Ts*up se u - y(k-1) > Ts*up; y(k-1) + Ts*lo se u - y(k-1) < Ts*lo; senão u
// (a regra do Rate Limiter discreto com os limites lidos das entradas; desde a R2023b a primeira
// amostra já sai limitada a partir da condição inicial nula).
KernelShape rateLimiterDynamicConfigure(const KernelConfig& c) {
    requireInputs(c, 3, "Rate Limiter Dynamic");
    requireExpandable(c, "Rate Limiter Dynamic");
    if (!(c.samplePeriod > 0.0)) fail("Rate Limiter Dynamic: exige tempo de amostragem discreto");
    return {0, c.outputWidth, {1, 1, 1}};
}
void rateLimiterDynamicInit(KernelContext& k) { std::fill_n(k.d, k.outWidth, 0.0); }
void rateLimiterDynamicOutputs(KernelContext& k) {
    for (uint16_t i = 0; i < k.outWidth; ++i) {
        const double rise = k.input(0, i) * k.ts, u = k.input(1, i), fall = k.input(2, i) * k.ts;
        const double previous = k.d[i], delta = u - previous;
        k.out[i] = delta > rise ? previous + rise : delta < fall ? previous + fall : u;
    }
}
void rateLimiterDynamicUpdate(KernelContext& k) { std::copy_n(k.out, k.outWidth, k.d); }

// ---- Backlash: ip = [nWidth]; rp = [BacklashWidth x a, InitialOutput x b].
// d = [y_ant x n, modo x n]; modo 0 = desengatado (y = y_ant), +1 = engatado subindo (y = u - w/2),
// -1 = engatado descendo (y = u + w/2). Zona morta inicial centrada em InitialOutput: entrada inicial
// dentro dela -> y = InitialOutput; fora -> engata (y = u -/+ w/2).
KernelShape backlashConfigure(const KernelConfig& c) {
    requireInputs(c, 1, "Backlash");
    requireExpandable(c, "Backlash");
    requirePacked(c, 0, 2, c.outputWidth, "Backlash");
    return {0, 2u * c.outputWidth, {1}};
}
void backlashInit(KernelContext& k) {
    const Packed p = unpack(k.rp, k.rpCount, k.ip, 0, 2);
    for (uint16_t i = 0; i < k.outWidth; ++i) { k.d[i] = p.at(1, i); k.d[k.outWidth + i] = 0.0; }
}
/** Modo e saída no passo maior a partir do y comprometido. */
double backlashStep(double u, double previous, double halfWidth, double& mode) {
    if (u >= previous + halfWidth) { mode = 1.0; return u - halfWidth; }
    if (u <= previous - halfWidth) { mode = -1.0; return u + halfWidth; }
    mode = 0.0;
    return previous;
}
void backlashOutputs(KernelContext& k) {
    const Packed p = unpack(k.rp, k.rpCount, k.ip, 0, 2);
    for (uint16_t i = 0; i < k.outWidth; ++i) {
        const double u = k.input(0, i), half = 0.5 * p.at(0, i), previous = k.d[i];
        if (k.major) {
            double mode = 0.0;
            k.out[i] = backlashStep(u, previous, half, mode);
            continue;
        }
        const double mode = k.d[k.outWidth + i];
        k.out[i] = mode > 0.0 ? u - half : mode < 0.0 ? u + half : previous;
    }
}
void backlashUpdate(KernelContext& k) {
    const Packed p = unpack(k.rp, k.rpCount, k.ip, 0, 2);
    for (uint16_t i = 0; i < k.outWidth; ++i) {
        double mode = 0.0;
        k.d[i] = backlashStep(k.input(0, i), k.d[i], 0.5 * p.at(0, i), mode);
        k.d[k.outWidth + i] = mode;
    }
}

// ---- Coulomb and Viscous Friction: ip = [nOffset]; rp = [offset x a, gain x b].
// y = sign(u) .* (gain .* |u| + offset)  (y = 0 em u = 0, sign(0) = 0 do MATLAB).
KernelShape coulombConfigure(const KernelConfig& c) {
    requireInputs(c, 1, "Coulomb and Viscous Friction");
    requireExpandable(c, "Coulomb and Viscous Friction");
    requirePacked(c, 0, 2, c.outputWidth, "Coulomb and Viscous Friction");
    return {0, 0, {1}};
}
void coulombOutputs(KernelContext& k) {
    const Packed p = unpack(k.rp, k.rpCount, k.ip, 0, 2);
    for (uint16_t i = 0; i < k.outWidth; ++i) {
        const double u = k.input(0, i);
        k.out[i] = sgn(u) * (p.at(1, i) * std::abs(u) + p.at(0, i));
    }
}

// ---- Quantizer: rp = q (1 ou n). y = q * round(u / q), arredondamento ao mais próximo (meio para
// longe de zero, o `round` do MATLAB).
KernelShape quantizerConfigure(const KernelConfig& c) {
    requireInputs(c, 1, "Quantizer");
    requireExpandable(c, "Quantizer");
    if (c.realParameters.size() != 1 && c.realParameters.size() != c.outputWidth) fail("Quantizer: intervalo com largura incompativel");
    return {0, 0, {1}};
}
void quantizerOutputs(KernelContext& k) {
    for (uint16_t i = 0; i < k.outWidth; ++i) {
        const double q = k.rp[k.rpCount == 1 ? 0 : i];
        k.out[i] = q * std::round(k.input(0, i) / q);
    }
}

// ---- Wrap To Zero: rp = Threshold (1 ou n). y = 0 se u > Threshold; senão y = u.
KernelShape wrapToZeroConfigure(const KernelConfig& c) {
    requireInputs(c, 1, "Wrap To Zero");
    requireExpandable(c, "Wrap To Zero");
    if (c.realParameters.size() != 1 && c.realParameters.size() != c.outputWidth) fail("Wrap To Zero: Threshold com largura incompativel");
    return {0, 0, {1}};
}
void wrapToZeroOutputs(KernelContext& k) {
    for (uint16_t i = 0; i < k.outWidth; ++i) {
        const double u = k.input(0, i);
        k.out[i] = u > k.rp[k.rpCount == 1 ? 0 : i] ? 0.0 : u;
    }
}

// ---- Hit Crossing: ip = [direção (0 either, 1 rising, 2 falling)]; rp = HitCrossingOffset (1 ou n).
// d = [s_ant x n, y_ant x n, estado, t_inicial], s = u - offset. y = 1 no passo em que s cruza zero
// na direção escolhida (rising: de negativo para zero/positivo ou de zero para positivo; falling: o
// simétrico), e continua 1 enquanto u fica exatamente no offset depois do cruzamento. Entrada
// inicial igual ao offset: y = 1 só com `either`. Nos estágios menores y fica no valor do passo maior.
// `estado`: 0 nada, 1 instante inicial registrado (provisório, como no Rate Limiter contínuo: sem
// grupo discreto o primeiro passo maior é o fim do primeiro passo), 2 comprometido por `update`.
enum HitDirection : int64_t { HitEither = 0, HitRising = 1, HitFalling = 2 };
KernelShape hitCrossingConfigure(const KernelConfig& c) {
    requireInputs(c, 1, "Hit Crossing");
    requireExpandable(c, "Hit Crossing");
    if (c.intParameters.size() != 1 || c.intParameters[0] < HitEither || c.intParameters[0] > HitFalling) fail("Hit Crossing: direcao invalida");
    if (c.realParameters.size() != 1 && c.realParameters.size() != c.outputWidth) fail("Hit Crossing: offset com largura incompativel");
    return {0, 2u * c.outputWidth + 2u, {1}};
}
bool hitCrossingInitialInstant(const KernelContext& k) {
    const size_t n = k.outWidth;
    return k.d[2 * n] == 0.0 || (k.d[2 * n] == 1.0 && static_cast<double>(k.tNs) == k.d[2 * n + 1]);
}
double hitCrossingSignal(const KernelContext& k, uint16_t i) { return k.input(0, i) - k.rp[k.rpCount == 1 ? 0 : i]; }
double hitCrossingValue(const KernelContext& k, uint16_t i) {
    const size_t n = k.outWidth;
    const double s = hitCrossingSignal(k, i);
    const auto direction = static_cast<HitDirection>(k.ip[0]);
    if (hitCrossingInitialInstant(k)) return s == 0.0 && direction == HitEither ? 1.0 : 0.0;
    const double previous = k.d[i];
    const bool rising = risingEdge(previous, s), falling = fallingEdge(previous, s);
    const bool crossed = direction == HitRising ? rising : direction == HitFalling ? falling : rising || falling;
    if (crossed) return 1.0;
    return s == 0.0 && k.d[n + i] != 0.0 ? 1.0 : 0.0;
}
void hitCrossingOutputs(KernelContext& k) {
    const size_t n = k.outWidth;
    if (!k.major && !hitCrossingInitialInstant(k)) {
        for (uint16_t i = 0; i < n; ++i) k.out[i] = k.d[n + i];
        return;
    }
    const bool record = k.d[2 * n] < 2.0 && k.tNs == k.majorNs && hitCrossingInitialInstant(k);
    for (uint16_t i = 0; i < n; ++i) {
        k.out[i] = hitCrossingValue(k, i);
        if (record) { k.d[i] = hitCrossingSignal(k, i); k.d[n + i] = k.out[i]; }
    }
    if (record) { k.d[2 * n] = 1.0; k.d[2 * n + 1] = static_cast<double>(k.tNs); }
}
void hitCrossingUpdate(KernelContext& k) {
    const size_t n = k.outWidth;
    for (uint16_t i = 0; i < n; ++i) {
        const double y = hitCrossingValue(k, i);
        k.d[n + i] = y;
        k.d[i] = hitCrossingSignal(k, i);
    }
    k.d[2 * n] = 2.0;
}

// ---- PWM: ip = [modo (0 contínuo, 1 intervalos fixos), DisallowZeroDutyCycle]; rp = [Period,
// InitialDelay]. O ciclo de trabalho D (entrada, limitado a [0, 1]) é lido no início de cada pulso.
// Contínuo: pulso começando em tk (primeiro em InitialDelay) -> y = 1 em tk <= t < tk + D(tk) P e
// y = 0 até tk + P; as bordas são breakpoints do passo. d = [próximo início (ns), fim do pulso (ns),
// y comprometido]. Com DisallowZeroDutyCycle a saída em tk é 1 sem ler D (sem direct feedthrough);
// a largura é fixada no `update` do mesmo instante.
// Intervalos fixos (Ts): nP = floor(P/Ts) amostras por período, npw = floor(D P / Ts) amostras em 1;
// InitialDelay arredondado para baixo a múltiplo de Ts. d = [amostra, npw do período, y].
enum PwmIp { PwmMode = 0, PwmDisallowZero, PwmIpCount };
KernelShape pwmConfigure(const KernelConfig& c) {
    requireInputs(c, 1, "PWM");
    if (c.inputWidths[0] != 1 || c.outputWidth != 1) fail("PWM: entrada D e saida precisam ser escalares (largura 1)");
    if (c.intParameters.size() != PwmIpCount || c.realParameters.size() != 2) fail("PWM: parametros internos invalidos");
    if (!(c.realParameters[0] > 0.0) || !std::isfinite(c.realParameters[0])) fail("PWM: Period precisa ser > 0");
    if (!(c.realParameters[1] >= 0.0) || !std::isfinite(c.realParameters[1])) fail("PWM: Initial Delay precisa ser >= 0");
    if (c.intParameters[PwmMode] != 0 && !(c.samplePeriod > 0.0)) fail("PWM: modo de intervalos fixos exige Sample Time > 0");
    const bool feedthrough = c.intParameters[PwmDisallowZero] == 0;
    return {0, 3, {static_cast<uint8_t>(feedthrough ? 1 : 0)}};
}
double clampDuty(double duty) { return std::isnan(duty) ? 0.0 : std::clamp(duty, 0.0, 1.0); }
uint64_t pwmPeriodNs(const KernelContext& k) { return std::max<uint64_t>(1, static_cast<uint64_t>(std::llround(k.rp[0] * 1e9))); }
void pwmInit(KernelContext& k) {
    if (k.ip[PwmMode] == 0) {
        k.d[0] = static_cast<double>(std::llround(k.rp[1] * 1e9));
        k.d[1] = 0.0;
    } else {
        k.d[0] = 0.0;
        k.d[1] = 0.0;
    }
    k.d[2] = 0.0;
}
/** Contínuo: início do pulso que vale em `t` (o último início <= t) e se ele é novo. */
struct PwmPulse { bool started; double startNs; };
PwmPulse pwmPulseAt(const KernelContext& k, uint64_t t) {
    const double next = k.d[0];
    if (static_cast<double>(t) < next) return {false, 0.0};
    const double period = static_cast<double>(pwmPeriodNs(k));
    const double skipped = std::floor((static_cast<double>(t) - next) / period);
    return {true, next + skipped * period};
}
/** Intervalos fixos: (posição no período, amostras por período); posição < 0 durante o atraso inicial. */
struct PwmSample { int64_t position; int64_t samples; };
PwmSample pwmSample(const KernelContext& k) {
    const double ts = k.ts;
    const auto samples = static_cast<int64_t>(std::floor(k.rp[0] / ts + 1e-9));
    const auto delay = static_cast<int64_t>(std::floor(k.rp[1] / ts + 1e-9));
    const auto index = static_cast<int64_t>(k.d[0]);
    if (index < delay || samples < 1) return {-1, std::max<int64_t>(1, samples)};
    return {(index - delay) % samples, samples};
}
int64_t pwmHighSamples(const KernelContext& k, int64_t samples) {
    const double high = std::floor(clampDuty(k.input(0)) * k.rp[0] / k.ts + 1e-9);
    return std::clamp<int64_t>(static_cast<int64_t>(high), 0, samples);
}
void pwmOutputs(KernelContext& k) {
    if (!k.major) { k.out[0] = k.d[2]; return; }
    if (k.ip[PwmMode] != 0) {
        const PwmSample s = pwmSample(k);
        if (s.position < 0) { k.out[0] = 0.0; return; }
        const int64_t high = s.position == 0 ? pwmHighSamples(k, s.samples) : static_cast<int64_t>(k.d[1]);
        k.out[0] = s.position < high ? 1.0 : 0.0;
        return;
    }
    const PwmPulse pulse = pwmPulseAt(k, k.tNs);
    if (!pulse.started) { k.out[0] = static_cast<double>(k.tNs) < k.d[1] ? 1.0 : 0.0; return; }
    if (k.ip[PwmDisallowZero] != 0) { k.out[0] = 1.0; return; }
    const double end = pulse.startNs + clampDuty(k.input(0)) * static_cast<double>(pwmPeriodNs(k));
    k.out[0] = static_cast<double>(k.tNs) < end ? 1.0 : 0.0;
}
void pwmUpdate(KernelContext& k) {
    if (k.ip[PwmMode] != 0) {
        const PwmSample s = pwmSample(k);
        if (s.position == 0) k.d[1] = static_cast<double>(pwmHighSamples(k, s.samples));
        k.d[2] = s.position < 0 ? 0.0 : s.position < static_cast<int64_t>(k.d[1]) ? 1.0 : 0.0;
        k.d[0] += 1.0;
        return;
    }
    const PwmPulse pulse = pwmPulseAt(k, k.tNs);
    if (pulse.started) {
        const double period = static_cast<double>(pwmPeriodNs(k));
        k.d[1] = std::round(pulse.startNs + clampDuty(k.input(0)) * period);
        k.d[0] = pulse.startNs + period;
        // Sem ciclo nulo: a borda de subida em tk já foi publicada (y = 1 neste instante).
        k.d[2] = k.ip[PwmDisallowZero] != 0 ? 1.0 : static_cast<double>(k.tNs) < k.d[1] ? 1.0 : 0.0;
        return;
    }
    k.d[2] = static_cast<double>(k.tNs) < k.d[1] ? 1.0 : 0.0;
}
uint64_t pwmBreakpoint(const KernelContext& k) {
    if (k.ip[PwmMode] != 0) return kNoBreakpoint;
    uint64_t next = kNoBreakpoint;
    for (const double edge : {k.d[0], k.d[1]})
        if (edge > static_cast<double>(k.tNs)) next = std::min(next, static_cast<uint64_t>(edge));
    return next;
}

const KernelSpec kSaturation{"saturation", saturationConfigure, nullptr, saturationOutputs, nullptr, nullptr, nullptr};
const KernelSpec kDeadZone{"dead_zone", deadZoneConfigure, nullptr, deadZoneOutputs, nullptr, nullptr, nullptr};
const KernelSpec kSaturationDynamic{"saturation_dynamic", saturationDynamicConfigure, nullptr, saturationDynamicOutputs, nullptr, nullptr, nullptr};
const KernelSpec kDeadZoneDynamic{"dead_zone_dynamic", deadZoneDynamicConfigure, nullptr, deadZoneDynamicOutputs, nullptr, nullptr, nullptr};
const KernelSpec kRelay{"relay", relayConfigure, relayInit, relayOutputs, relayUpdate, nullptr, nullptr};
const KernelSpec kRateLimiter{"rate_limiter", rateLimiterConfigure, rateLimiterInit, rateLimiterOutputs, rateLimiterUpdate, nullptr, nullptr};
const KernelSpec kRateLimiterDynamic{"rate_limiter_dynamic", rateLimiterDynamicConfigure, rateLimiterDynamicInit, rateLimiterDynamicOutputs,
                                     rateLimiterDynamicUpdate, nullptr, nullptr};
const KernelSpec kBacklash{"backlash", backlashConfigure, backlashInit, backlashOutputs, backlashUpdate, nullptr, nullptr};
const KernelSpec kCoulomb{"coulomb_viscous_friction", coulombConfigure, nullptr, coulombOutputs, nullptr, nullptr, nullptr};
const KernelSpec kQuantizer{"quantizer", quantizerConfigure, nullptr, quantizerOutputs, nullptr, nullptr, nullptr};
const KernelSpec kWrapToZero{"wrap_to_zero", wrapToZeroConfigure, nullptr, wrapToZeroOutputs, nullptr, nullptr, nullptr};
const KernelSpec kHitCrossing{"hit_crossing", hitCrossingConfigure, nullptr, hitCrossingOutputs, hitCrossingUpdate, nullptr, nullptr};
const KernelSpec kPwm{"pwm", pwmConfigure, pwmInit, pwmOutputs, pwmUpdate, nullptr, pwmBreakpoint};

const KernelSpec* const kDiscontinuities[] = {&kSaturation, &kDeadZone, &kSaturationDynamic, &kDeadZoneDynamic, &kRelay, &kRateLimiter,
                                              &kRateLimiterDynamic, &kBacklash, &kCoulomb, &kQuantizer, &kWrapToZero, &kHitCrossing, &kPwm};
} // namespace

std::span<const KernelSpec* const> discontinuityKernels() { return kDiscontinuities; }

} // namespace lasecsimul::simulation::library
