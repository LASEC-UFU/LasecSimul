// Fontes (biblioteca Sources). Layout de parâmetros documentado em cada kernel; montado pelos
// builders (`SourceBuilders.cpp`) a partir dos parâmetros oficiais (nomes programáticos do Simulink).
//
// Fontes contínuas descontínuas (Step, Pulse Generator, Signal Generator quadrada/dente de serra/
// aleatória, Repeating Sequence) seguem a regra do engine: o MODO (nível do pulso, ciclo, segmento da
// tabela) é o do último passo MAIOR (`majorNs`) e cada borda é publicada como breakpoint, então o
// passo termina exatamente nela e o passo maior seguinte já publica o valor novo -- o mesmo que o
// Simulink faz com as fontes de tempo variável. Os breakpoints são arredondados para 1 ns; as
// comparações de fase toleram esse meio nanossegundo (`kHalfNs`).
#include <cmath>
#include <cstring>
#include <limits>

#include "../KernelCommon.hpp"
#include "Families.hpp"

namespace lasecsimul::simulation::library {
namespace {
using namespace detail;
constexpr double kTwoPi = 6.283185307179586476925286766559;
constexpr double kHalfNs = 0.5e-9;
constexpr int64_t kNeverNs = std::numeric_limits<int64_t>::max();

double seconds(uint64_t ns) { return static_cast<double>(ns) * 1e-9; }

/** Instante (s) -> ns do breakpoint, sempre depois de `afterNs`. */
uint64_t breakpointNs(double timeSeconds, uint64_t afterNs) {
    if (!std::isfinite(timeSeconds) || timeSeconds > 1.8e10) return kNoBreakpoint;
    const double ns = std::round(timeSeconds * 1e9);
    const uint64_t value = ns <= 0.0 ? 0 : static_cast<uint64_t>(ns);
    return value > afterNs ? value : afterNs + 1;
}

/** Índice do ciclo e fase (s) de `x` num período `period` > 0, tolerando `tol` (arredondamento do
 * breakpoint): um instante a menos de `tol` antes de uma borda já conta como a borda. */
struct Cycle { double index; double phase; };
Cycle cycleOf(double x, double period, double tol) {
    const double index = std::floor((x + tol) / period);
    double phase = x - index * period;
    if (phase < 0.0) phase = 0.0;
    return {index, phase};
}

// ---- Gerador pseudoaleatório determinístico por semente ------------------------------------------
// Baseado em contador (SplitMix64 aplicado a semente, elemento e índice da amostra): o valor da
// amostra k é função pura de (Seed, elemento, k), então não há estado de gerador a guardar além do
// contador e a mesma semente reproduz a mesma sequência em qualquer plataforma. NÃO é o gerador 'v4'
// do MATLAB: a sequência não é bit a bit a do Simulink (só a distribuição e a repetibilidade são).
uint64_t splitmix64(uint64_t x) {
    x += 0x9E3779B97F4A7C15ull;
    x = (x ^ (x >> 30)) * 0xBF58476D1CE4E5B9ull;
    x = (x ^ (x >> 27)) * 0x94D049BB133111EBull;
    return x ^ (x >> 31);
}
/** Uniforme em [0, 1) com 53 bits. */
double uniform01(double seed, uint64_t element, uint64_t index) {
    uint64_t key = splitmix64(static_cast<uint64_t>(seed));
    key = splitmix64(key ^ (0xD1B54A32D192ED03ull * (element + 1)));
    key = splitmix64(key ^ index);
    return static_cast<double>(key >> 11) * (1.0 / 9007199254740992.0);
}
/** Normal padrão (Box-Muller) a partir de duas uniformes independentes. */
double standardNormal(double seed, uint64_t element, uint64_t sample) {
    const double u1 = 1.0 - uniform01(seed, element, 2 * sample);       // (0, 1]
    const double u2 = uniform01(seed, element, 2 * sample + 1);
    return std::sqrt(-2.0 * std::log(u1)) * std::cos(kTwoPi * u2);
}

// ---- Constant: rp = Value (1 ou largura da saída). Ajustável em execução. ----
KernelShape constantConfigure(const KernelConfig& c) {
    requireInputs(c, 0, "Constant");
    if (c.realParameters.size() != 1 && c.realParameters.size() != c.outputWidth) fail("Constant: Value com largura incompativel");
    return {0, 0, {}};
}
void constantOutputs(KernelContext& k) {
    for (uint16_t i = 0; i < k.outWidth; ++i) k.out[i] = k.rp[k.rpCount == 1 ? 0 : i];
}

// ---- Step: ip = [n, stepTimeNs]; rp = [Time, InitialValue x n, FinalValue x n]. ----
// y = InitialValue para t < Time; FinalValue para t >= Time (documentação: "Step time"). Como no
// Simulink, a descontinuidade só troca de modo num passo MAIOR: o passo que termina exatamente em
// Time é integrado inteiro com InitialValue (limite à esquerda), e o passo maior em Time já publica
// FinalValue. stepTimeNs = INT64_MAX: o degrau nunca acontece (Time = Inf).
KernelShape stepConfigure(const KernelConfig& c) {
    requireInputs(c, 0, "Step");
    if (c.intParameters.size() != 2) fail("Step: parametros internos invalidos");
    const size_t n = static_cast<size_t>(c.intParameters[0]);
    if (c.realParameters.size() != 1 + 2 * n || (n != 1 && n != c.outputWidth)) fail("Step: Before/After com larguras incompativeis");
    return {0, 0, {}};
}
void stepOutputs(KernelContext& k) {
    const size_t n = static_cast<size_t>(k.ip[0]);
    const bool after = k.ip[1] != kNeverNs && static_cast<uint64_t>(k.ip[1]) <= k.majorNs;
    for (uint16_t i = 0; i < k.outWidth; ++i) k.out[i] = k.rp[1 + (after ? n : 0) + (n == 1 ? 0 : i)];
}
uint64_t stepBreakpoint(const KernelContext& k) {
    if (k.ip[1] == kNeverNs) return kNoBreakpoint;
    const uint64_t time = static_cast<uint64_t>(k.ip[1]);
    return k.tNs < time ? time : kNoBreakpoint;
}

// ---- Ramp: ip = [n, startNs x n]; rp = [Slope x n, Start x n, InitialOutput x n]. ----
// y = InitialOutput para t < Start; InitialOutput + Slope*(t - Start) depois (função contínua do
// tempo; o início da rampa é breakpoint para o integrador acertar a quina). Start < 0: rampa já em
// curso em t = 0 (startNs = 0).
KernelShape rampConfigure(const KernelConfig& c) {
    requireInputs(c, 0, "Ramp");
    if (c.intParameters.empty()) fail("Ramp: parametros internos invalidos");
    const size_t n = static_cast<size_t>(c.intParameters[0]);
    if (c.intParameters.size() != 1 + n || c.realParameters.size() != 3 * n || (n != 1 && n != c.outputWidth))
        fail("Ramp: parametros com larguras incompativeis");
    return {0, 0, {}};
}
void rampOutputs(KernelContext& k) {
    const size_t n = static_cast<size_t>(k.ip[0]);
    for (uint16_t i = 0; i < k.outWidth; ++i) {
        const size_t e = n == 1 ? 0 : i;
        const bool started = k.ip[1 + e] != kNeverNs && static_cast<uint64_t>(k.ip[1 + e]) <= k.tNs;
        k.out[i] = started ? k.rp[2 * n + e] + k.rp[e] * (k.t - k.rp[n + e]) : k.rp[2 * n + e];
    }
}
uint64_t rampBreakpoint(const KernelContext& k) {
    const size_t n = static_cast<size_t>(k.ip[0]);
    uint64_t next = kNoBreakpoint;
    for (size_t e = 0; e < n; ++e) {
        if (k.ip[1 + e] == kNeverNs) continue;
        const uint64_t start = static_cast<uint64_t>(k.ip[1 + e]);
        if (k.tNs < start && start < next) next = start;
    }
    return next;
}

// ---- Sine Wave / Sine Wave Function: ip = [mode, n]. ----
// mode 0 (time based, tempo de simulação) e 2 (time based, tempo externo u):
//   rp = [Amp x n, Bias x n, Freq x n, Phase x n], y = Amp*sin(Freq*t + Phase) + Bias.
//   Em tempo discreto (Sample time > 0) o Simulink usa a recursão incremental de sin/cos; aqui o
//   seno é avaliado no instante da amostra (mesmo valor sem o acúmulo de arredondamento).
// mode 1 (sample based): rp = [Amp x n, Bias x n, Samples x n, Offset x n], d = [k x n],
//   y = Amp*sin(2*pi*(k + Offset)/Samples) + Bias, k = 0..Samples-1 contado nos acertos de amostra
//   (volta a 0 ao atingir Samples), independente do deslocamento [Ts offset] do tempo de amostragem.
KernelShape sineConfigure(const KernelConfig& c) {
    if (c.intParameters.size() != 2) fail("Sine Wave: parametros internos invalidos");
    const bool external = c.intParameters[0] == 2;
    requireInputs(c, external ? 1 : 0, "Sine Wave");
    const size_t n = static_cast<size_t>(c.intParameters[1]);
    if (c.realParameters.size() != 4 * n || (n != 1 && n != c.outputWidth)) fail("Sine Wave: parametros com larguras incompativeis");
    if (external) requireExpandable(c, "Sine Wave");
    uint32_t discrete = 0;
    if (c.intParameters[0] == 1) {
        if (!(c.samplePeriod > 0.0)) fail("Sine Wave: modo baseado em amostras exige Sample time > 0");
        for (size_t i = 0; i < n; ++i)
            if (!(c.realParameters[2 * n + i] > 0.0)) fail("Sine Wave: Samples per period deve ser positivo");
        discrete = static_cast<uint32_t>(n);
    }
    return {0, discrete, std::vector<uint8_t>(external ? 1 : 0, 1)};
}
void sineInit(KernelContext& k) {
    if (k.ip[0] != 1) return;
    for (int64_t e = 0; e < k.ip[1]; ++e) k.d[e] = 0.0;
}
void sineOutputs(KernelContext& k) {
    const size_t n = static_cast<size_t>(k.ip[1]);
    for (uint16_t i = 0; i < k.outWidth; ++i) {
        const size_t e = n == 1 ? 0 : i;
        const double amplitude = k.rp[e], bias = k.rp[n + e];
        if (k.ip[0] == 0 || k.ip[0] == 2) {
            const double time = k.ip[0] == 2 ? k.input(0, i) : k.t;
            k.out[i] = amplitude * std::sin(k.rp[2 * n + e] * time + k.rp[3 * n + e]) + bias;
        } else {
            k.out[i] = amplitude * std::sin(kTwoPi * (k.d[e] + k.rp[3 * n + e]) / k.rp[2 * n + e]) + bias;
        }
    }
}
void sineUpdate(KernelContext& k) {
    if (k.ip[0] != 1) return;
    const size_t n = static_cast<size_t>(k.ip[1]);
    for (size_t e = 0; e < n; ++e) {
        k.d[e] += 1.0;
        if (k.d[e] >= k.rp[2 * n + e]) k.d[e] = 0.0;
    }
}

// ---- Clock / Digital Clock: y = t (Digital Clock é o mesmo kernel num RateGroup discreto: t = t_k). ----
KernelShape clockConfigure(const KernelConfig& c) { requireInputs(c, 0, "Clock"); return {0, 0, {}}; }
void clockOutputs(KernelContext& k) { for (uint16_t i = 0; i < k.outWidth; ++i) k.out[i] = k.t; }

// ---- Pulse Generator: ip = [mode, n]; rp = [Amplitude x n, Period x n, Width x n, Delay x n]. ----
// mode 0 (time based, tempo de simulação) / 1 (time based, tempo externo u): Period, Width e Delay
//   em segundos (Width = Period*PulseWidth/100). y = Amplitude se t - Delay >= 0 e
//   mod(t - Delay, Period) < Width; senão 0. No modo 0 o nível é o do último passo maior e as
//   bordas são breakpoints (o Simulink dá ao bloco tempo de amostragem variável: acertos só nas bordas).
// mode 2 (sample based): Period, Width e Delay em AMOSTRAS; d = [k], k = acertos desde o início:
//   y = Amplitude se k >= Delay e mod(k - Delay, Period) < Width; senão 0.
enum PulseMode : int64_t { PulseTime = 0, PulseExternal = 1, PulseSamples = 2 };

bool pulseOn(double x, double period, double width, double tol) {
    if (x + tol < 0.0) return false;
    return cycleOf(x, period, tol).phase + tol < width;
}
KernelShape pulseConfigure(const KernelConfig& c) {
    if (c.intParameters.size() != 2) fail("Pulse Generator: parametros internos invalidos");
    const int64_t mode = c.intParameters[0];
    requireInputs(c, mode == PulseExternal ? 1 : 0, "Pulse Generator");
    const size_t n = static_cast<size_t>(c.intParameters[1]);
    if (c.realParameters.size() != 4 * n || (n != 1 && n != c.outputWidth)) fail("Pulse Generator: parametros com larguras incompativeis");
    if (mode == PulseExternal) requireExpandable(c, "Pulse Generator");
    for (size_t e = 0; e < n; ++e) {
        const double period = c.realParameters[n + e], width = c.realParameters[2 * n + e];
        if (!(period > 0.0) || !std::isfinite(period)) fail("Pulse Generator: Period deve ser > 0");
        if (!(width >= 0.0) || !std::isfinite(c.realParameters[3 * n + e])) fail("Pulse Generator: largura/atraso invalidos");
    }
    if (mode == PulseSamples && !(c.samplePeriod > 0.0)) fail("Pulse Generator: modo baseado em amostras exige Sample time > 0");
    return {0, mode == PulseSamples ? 1u : 0u, std::vector<uint8_t>(mode == PulseExternal ? 1 : 0, 1)};
}
void pulseInit(KernelContext& k) { if (k.ip[0] == PulseSamples) k.d[0] = 0.0; }
void pulseOutputs(KernelContext& k) {
    const size_t n = static_cast<size_t>(k.ip[1]);
    const int64_t mode = k.ip[0];
    for (uint16_t i = 0; i < k.outWidth; ++i) {
        const size_t e = n == 1 ? 0 : i;
        const double amplitude = k.rp[e], period = k.rp[n + e], width = k.rp[2 * n + e], delay = k.rp[3 * n + e];
        bool on = false;
        if (mode == PulseTime) on = pulseOn(seconds(k.majorNs) - delay, period, width, kHalfNs);
        else if (mode == PulseExternal) on = pulseOn(k.input(0, i) - delay, period, width, 0.0);
        else {
            const double sample = k.d[0] - delay;
            on = sample >= 0.0 && sample - std::floor(sample / period) * period < width;
        }
        k.out[i] = on ? amplitude : 0.0;
    }
}
void pulseUpdate(KernelContext& k) { if (k.ip[0] == PulseSamples) k.d[0] += 1.0; }
uint64_t pulseBreakpoint(const KernelContext& k) {
    if (k.ip[0] != PulseTime) return kNoBreakpoint;
    const size_t n = static_cast<size_t>(k.ip[1]);
    const double now = seconds(k.tNs) + kHalfNs;
    uint64_t next = kNoBreakpoint;
    for (size_t e = 0; e < n; ++e) {
        const double period = k.rp[n + e], width = k.rp[2 * n + e], delay = k.rp[3 * n + e];
        const double x = now - delay;
        double edge;
        if (x < 0.0) edge = delay;
        else {
            const double index = std::floor(x / period);
            edge = x - index * period < width ? delay + index * period + width : delay + (index + 1.0) * period;
        }
        next = std::min(next, breakpointNs(edge, k.tNs));
    }
    return next;
}

// ---- Signal Generator: ip = [forma, externo, n]; rp = [Amplitude x n, f (Hz) x n, Semente]. ----
// forma 0 seno: y = A*sin(2*pi*f*t). 1 quadrada: y = A se frac(f*t) >= 1/2, senão -A (começa em -A,
// sobe na metade do período). 2 dente de serra: y = A*(1 - 2*frac(f*t)) (começa em +A e desce até
// -A no fim do período). 3 aleatória: valor uniforme em [-A, A] mantido por período 1/f (decisão do
// LasecSimul: a documentação não fixa distribuição nem taxa). t = tempo de simulação ou entrada u.
// Com tempo de simulação, quadrada/dente/aleatória mudam de ciclo só em passo maior, com as bordas
// como breakpoints.
enum Wave : int64_t { WaveSine = 0, WaveSquare, WaveSawtooth, WaveRandom };

KernelShape signalGeneratorConfigure(const KernelConfig& c) {
    if (c.intParameters.size() != 3 || c.intParameters[0] < 0 || c.intParameters[0] > WaveRandom) fail("Signal Generator: parametros internos invalidos");
    const bool external = c.intParameters[1] != 0;
    requireInputs(c, external ? 1 : 0, "Signal Generator");
    const size_t n = static_cast<size_t>(c.intParameters[2]);
    if (c.realParameters.size() != 2 * n + 1 || (n != 1 && n != c.outputWidth)) fail("Signal Generator: Amplitude/Frequency com larguras incompativeis");
    if (external) requireExpandable(c, "Signal Generator");
    return {0, 0, std::vector<uint8_t>(external ? 1 : 0, 1)};
}
void signalGeneratorOutputs(KernelContext& k) {
    const int64_t wave = k.ip[0];
    const bool external = k.ip[1] != 0;
    const size_t n = static_cast<size_t>(k.ip[2]);
    const double seed = k.rp[2 * n];
    for (uint16_t i = 0; i < k.outWidth; ++i) {
        const size_t e = n == 1 ? 0 : i;
        const double amplitude = k.rp[e], frequency = k.rp[n + e];
        const double t = external ? k.input(0, i) : k.t;
        if (wave == WaveSine) { k.out[i] = amplitude * std::sin(kTwoPi * frequency * t); continue; }
        // Ciclo decidido no passo maior (tempo de simulação) ou no próprio u (tempo externo).
        const double reference = external ? t : seconds(k.majorNs);
        const double tol = external ? 0.0 : std::abs(frequency) * kHalfNs;
        const double cycles = frequency * reference;
        const double index = std::floor(cycles + tol);
        if (wave == WaveSquare) {
            const double half = std::floor(2.0 * cycles + 2.0 * tol);
            k.out[i] = std::fmod(half, 2.0) != 0.0 ? amplitude : -amplitude;
        } else if (wave == WaveSawtooth) {
            k.out[i] = amplitude * (1.0 - 2.0 * (frequency * t - index));
        } else {
            const double sample = index < 0.0 ? 0.0 : index;
            k.out[i] = amplitude * (2.0 * uniform01(seed, e, static_cast<uint64_t>(sample)) - 1.0);
        }
    }
}
uint64_t signalGeneratorBreakpoint(const KernelContext& k) {
    const int64_t wave = k.ip[0];
    if (wave == WaveSine || k.ip[1] != 0) return kNoBreakpoint;
    const size_t n = static_cast<size_t>(k.ip[2]);
    const double edgesPerCycle = wave == WaveSquare ? 2.0 : 1.0;
    uint64_t next = kNoBreakpoint;
    for (size_t e = 0; e < n; ++e) {
        const double rate = std::abs(k.rp[n + e]) * edgesPerCycle;
        if (!(rate > 0.0) || !std::isfinite(rate)) continue;
        const double edges = std::floor((seconds(k.tNs) + kHalfNs) * rate) + 1.0;
        next = std::min(next, breakpointNs(edges / rate, k.tNs));
    }
    return next;
}

// ---- Repeating Sequence (contínuo) / Repeating Sequence Interpolated (discreto) -----------------
// ip = [método, m]; rp = [T x m, Y x m] (T estritamente crescente). Período P = T(m) - T(1); o
// instante local é T(1) + mod(t - T(1), P). Método 0: interpolação linear (Repeating Sequence;
// Repeating Sequence Interpolated "Interpolation-Use End Values"); 1 "Use Input Nearest" (empate:
// ponto de cima, como interp1 'nearest'); 2 "Use Input Below"; 3 "Use Input Above".
// Em tempo contínuo o SEGMENTO (ciclo e intervalo da tabela) é o do último passo maior e cada ponto
// da tabela é breakpoint: dentro do passo a reta do segmento é estendida (limite à esquerda no salto
// de fim de período).
enum Lookup : int64_t { LookupLinear = 0, LookupNearest, LookupBelow, LookupAbove };

KernelShape sequenceConfigure(const KernelConfig& c) {
    requireInputs(c, 0, "Repeating Sequence");
    if (c.intParameters.size() != 2 || c.intParameters[0] < 0 || c.intParameters[0] > LookupAbove) fail("Repeating Sequence: parametros internos invalidos");
    const size_t m = static_cast<size_t>(c.intParameters[1]);
    if (m < 2 || c.realParameters.size() != 2 * m || c.outputWidth != 1) fail("Repeating Sequence: tabela invalida");
    for (size_t j = 1; j < m; ++j)
        if (!(c.realParameters[j] > c.realParameters[j - 1])) fail("Repeating Sequence: valores de tempo devem ser estritamente crescentes");
    return {0, 0, {}};
}
void sequenceOutputs(KernelContext& k) {
    const size_t m = static_cast<size_t>(k.ip[1]);
    const double* times = k.rp;
    const double* values = k.rp + m;
    const double first = times[0], period = times[m - 1] - first;
    const Cycle cycle = cycleOf(seconds(k.majorNs) - first, period, kHalfNs);
    const double local = first + cycle.phase;
    // Intervalo [T(j), T(j+1)) que contém o instante local do passo maior.
    size_t j = 0;
    while (j + 2 < m && times[j + 1] <= local + kHalfNs) ++j;
    switch (k.ip[0]) {
    case LookupLinear: {
        const double x = k.t - cycle.index * period;   // tempo local no instante do estágio
        k.out[0] = values[j] + (values[j + 1] - values[j]) * (x - times[j]) / (times[j + 1] - times[j]);
        return;
    }
    case LookupBelow: k.out[0] = local + kHalfNs >= times[j + 1] ? values[j + 1] : values[j]; return;
    case LookupAbove: k.out[0] = local <= times[j] + kHalfNs ? values[j] : values[j + 1]; return;
    default: k.out[0] = local - times[j] < times[j + 1] - local ? values[j] : values[j + 1]; return;
    }
}
uint64_t sequenceBreakpoint(const KernelContext& k) {
    const size_t m = static_cast<size_t>(k.ip[1]);
    const double* times = k.rp;
    const double first = times[0], period = times[m - 1] - first;
    const Cycle cycle = cycleOf(seconds(k.tNs) + kHalfNs - first, period, 0.0);
    const double local = first + cycle.phase;
    double edge = first + (cycle.index + 1.0) * period;
    for (size_t j = 1; j < m; ++j)
        if (times[j] > local) { edge = times[j] + cycle.index * period; break; }
    return breakpointNs(edge, k.tNs);
}

// ---- Repeating Sequence Stair: rp = OutValues (N); d = [k]. y_k = OutValues(mod(k, N) + 1). ----
KernelShape stairConfigure(const KernelConfig& c) {
    requireInputs(c, 0, "Repeating Sequence Stair");
    if (c.realParameters.empty() || c.outputWidth != 1) fail("Repeating Sequence Stair: vetor de valores vazio");
    return {0, 1, {}};
}
void stairInit(KernelContext& k) { k.d[0] = 0.0; }
void stairOutputs(KernelContext& k) { k.out[0] = k.rp[static_cast<size_t>(k.d[0])]; }
void stairUpdate(KernelContext& k) {
    k.d[0] += 1.0;
    if (k.d[0] >= static_cast<double>(k.rpCount)) k.d[0] = 0.0;
}

// ---- Counter Free-Running / Counter Limited: rp = [M]; d = [k]. y_k = k mod M (0, 1, ..., M-1, 0...).
// Free-Running: M = 2^NumBits; Limited: M = UpperLimit + 1. Contador sempre começa em 0.
KernelShape counterConfigure(const KernelConfig& c) {
    requireInputs(c, 0, "Counter");
    if (c.realParameters.size() != 1 || !(c.realParameters[0] >= 1.0) || c.outputWidth != 1) fail("Counter: modulo invalido");
    return {0, 1, {}};
}
void counterInit(KernelContext& k) { k.d[0] = 0.0; }
void counterOutputs(KernelContext& k) { k.out[0] = k.d[0]; }
void counterUpdate(KernelContext& k) {
    k.d[0] += 1.0;
    if (k.d[0] >= k.rp[0]) k.d[0] = 0.0;
}

// ---- Chirp Signal: ip = [n]; rp = [f1 x n, T x n, f2 x n] (Hz, s). ----
// Frequência instantânea documentada f(t) = f1 + (f2 - f1)*t/T (continua mudando no mesmo ritmo
// depois de T); a fase é a integral: y = sin(2*pi*(f1*t + (f2 - f1)*t^2/(2*T))).
KernelShape chirpConfigure(const KernelConfig& c) {
    requireInputs(c, 0, "Chirp Signal");
    if (c.intParameters.size() != 1) fail("Chirp Signal: parametros internos invalidos");
    const size_t n = static_cast<size_t>(c.intParameters[0]);
    if (c.realParameters.size() != 3 * n || (n != 1 && n != c.outputWidth)) fail("Chirp Signal: parametros com larguras incompativeis");
    for (size_t e = 0; e < n; ++e) if (!(c.realParameters[n + e] > 0.0)) fail("Chirp Signal: Target time deve ser > 0");
    return {0, 0, {}};
}
void chirpOutputs(KernelContext& k) {
    const size_t n = static_cast<size_t>(k.ip[0]);
    for (uint16_t i = 0; i < k.outWidth; ++i) {
        const size_t e = n == 1 ? 0 : i;
        const double f1 = k.rp[e], target = k.rp[n + e], f2 = k.rp[2 * n + e];
        k.out[i] = std::sin(kTwoPi * (f1 * k.t + (f2 - f1) * k.t * k.t / (2.0 * target)));
    }
}

// ---- Random Number / Uniform Random Number / Band-Limited White Noise ----------------------------
// ip = [distribuição, n]; rp = [a x n, b x n, Seed x n]; d = [k] (índice da amostra).
// distribuição 0 (normal): y_k = a + b*N(0,1)  -- Random Number: a = Mean, b = sqrt(Variance);
//                                                 Band-Limited White Noise: a = 0, b = sqrt(Cov/Ts).
// distribuição 1 (uniforme): y_k = a + b*U[0,1) -- Uniform Random Number: a = Minimum, b = Max - Min.
// Uma nova amostra por acerto de amostra (mantida entre acertos); a semente reinicia a sequência a
// cada início de simulação.
KernelShape randomConfigure(const KernelConfig& c) {
    requireInputs(c, 0, "Random Number");
    if (c.intParameters.size() != 2 || c.intParameters[0] < 0 || c.intParameters[0] > 1) fail("Random Number: parametros internos invalidos");
    const size_t n = static_cast<size_t>(c.intParameters[1]);
    if (c.realParameters.size() != 3 * n || (n != 1 && n != c.outputWidth)) fail("Random Number: parametros com larguras incompativeis");
    return {0, 1, {}};
}
void randomInit(KernelContext& k) { k.d[0] = 0.0; }
void randomOutputs(KernelContext& k) {
    const size_t n = static_cast<size_t>(k.ip[1]);
    const uint64_t sample = static_cast<uint64_t>(k.d[0]);
    for (uint16_t i = 0; i < k.outWidth; ++i) {
        const size_t e = n == 1 ? 0 : i;
        const double draw = k.ip[0] == 0 ? standardNormal(k.rp[2 * n + e], i, sample) : uniform01(k.rp[2 * n + e], i, sample);
        k.out[i] = k.rp[e] + k.rp[n + e] * draw;
    }
}
void randomUpdate(KernelContext& k) { k.d[0] += 1.0; }

const KernelSpec kConstant{"constant", constantConfigure, nullptr, constantOutputs, nullptr, nullptr, nullptr};
const KernelSpec kStep{"step", stepConfigure, nullptr, stepOutputs, nullptr, nullptr, stepBreakpoint};
const KernelSpec kRamp{"ramp", rampConfigure, nullptr, rampOutputs, nullptr, nullptr, rampBreakpoint};
const KernelSpec kSine{"sine_wave", sineConfigure, sineInit, sineOutputs, sineUpdate, nullptr, nullptr};
const KernelSpec kClock{"clock", clockConfigure, nullptr, clockOutputs, nullptr, nullptr, nullptr};
const KernelSpec kPulse{"pulse_generator", pulseConfigure, pulseInit, pulseOutputs, pulseUpdate, nullptr, pulseBreakpoint};
const KernelSpec kSignalGenerator{"signal_generator", signalGeneratorConfigure, nullptr, signalGeneratorOutputs, nullptr, nullptr, signalGeneratorBreakpoint};
const KernelSpec kSequence{"repeating_sequence", sequenceConfigure, nullptr, sequenceOutputs, nullptr, nullptr, sequenceBreakpoint};
const KernelSpec kStair{"sequence_stair", stairConfigure, stairInit, stairOutputs, stairUpdate, nullptr, nullptr};
const KernelSpec kCounter{"counter", counterConfigure, counterInit, counterOutputs, counterUpdate, nullptr, nullptr};
const KernelSpec kChirp{"chirp", chirpConfigure, nullptr, chirpOutputs, nullptr, nullptr, nullptr};
const KernelSpec kRandom{"random_number", randomConfigure, randomInit, randomOutputs, randomUpdate, nullptr, nullptr};

const KernelSpec* const kSources[] = {&kConstant, &kStep, &kRamp, &kSine, &kClock, &kPulse, &kSignalGenerator,
                                      &kSequence, &kStair, &kCounter, &kChirp, &kRandom};
} // namespace

std::span<const KernelSpec* const> sourceKernels() { return kSources; }

} // namespace lasecsimul::simulation::library
