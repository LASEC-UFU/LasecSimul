// Sources: parâmetros oficiais -> kernels de `simulation/library/kernels/SourceKernels.cpp`.
// `VectorParams1D` não tem efeito: os sinais do engine são sempre 1-D (vetor linha/coluna vira vetor).
#include <cstdint>
#include <limits>

#include "BuilderCommon.hpp"

namespace lasecsimul::components::blocks::builders {
namespace {

constexpr double kTwoPi = 6.283185307179586476925286766559;
constexpr int64_t kNeverNs = std::numeric_limits<int64_t>::max();

bool constantRate(const BuildContext& c) { return c.resolution.rate.periodNs >= simulation::kConstantSamplePeriodNs; }

/** Fontes discretas (contadores, sequências em escada...): sem entradas, `-1` não tem de quem herdar
 * aqui (o engine não propaga taxa de volta do destino), então só um Sample time explícito > 0 vale. */
void requireDiscreteSource(const BuildContext& c) {
    if (c.resolution.rate.continuous() || constantRate(c))
        c.fail("exige tempo de amostragem discreto (defina Sample time > 0; com -1 a fonte sem entradas nao tem taxa para herdar)");
}

/** Taxa discreta lida de um parâmetro de tempo de amostragem (`Ts` ou `[Ts, offset]`, Ts > 0). */
simulation::SignalRate discreteRate(const BuildContext& c, const char* name) {
    const lib::ParamValue value = c.value(name);
    if (value.numel() < 1 || value.numel() > 2) c.fail(std::string(name) + " deve ser Ts ou [Ts, offset]");
    const double period = value.data[0], offset = value.numel() == 2 ? value.data[1] : 0.0;
    if (!(period > 0.0) || !std::isfinite(period) || !(offset >= 0.0) || offset >= period)
        c.fail("exige tempo de amostragem discreto (" + std::string(name) + " > 0 e 0 <= offset < Ts)");
    const uint64_t periodNs = static_cast<uint64_t>(nanoseconds(c, period, name));
    if (periodNs == 0) c.fail(std::string(name) + " menor que 1 ns");
    return {periodNs, static_cast<uint64_t>(nanoseconds(c, offset, name)), 0};
}

/** Instante de evento (s) -> ns: negativo vira 0 (já aconteceu em t = 0), Inf/enorme = nunca. */
int64_t eventNs(const BuildContext& c, double seconds, const char* what) {
    if (std::isnan(seconds)) c.fail(std::string(what) + " invalido (NaN)");
    if (seconds > 1.8e10) return kNeverNs;
    if (seconds <= 0.0) return 0;
    return nanoseconds(c, seconds, what);
}

/** Parâmetros com expansão escalar para uma largura comum `n` (o maior; `minimum` = largura de uma
 * entrada de tempo externo). Cada um precisa ser escalar ou ter a largura `n`. */
std::vector<std::vector<double>> expandedParams(const BuildContext& c, const std::vector<const char*>& names, size_t& n, size_t minimum = 1) {
    std::vector<std::vector<double>> values;
    n = minimum;
    for (const char* name : names) {
        values.push_back(c.value(name).linear());
        if (values.back().empty()) c.fail(std::string(name) + " vazio");
        n = std::max(n, values.back().size());
    }
    if (n > 4096) c.fail("largura de sinal grande demais");
    for (size_t i = 0; i < names.size(); ++i) values[i] = expandTo(c, values[i], n, names[i]);
    return values;
}

std::vector<double> concat(const std::vector<std::vector<double>>& parts) {
    std::vector<double> all;
    for (const auto& part : parts) all.insert(all.end(), part.begin(), part.end());
    return all;
}

/** Output minimum/maximum: verificação de faixa do PARÂMETRO (o Simulink recusa valor fora da faixa). */
void checkOutputRange(const BuildContext& c, const std::vector<double>& values, const char* what) {
    const lib::ParamValue minimum = c.value("OutMin"), maximum = c.value("OutMax");
    if (minimum.numel() > 1 || maximum.numel() > 1) c.fail("Output minimum/maximum precisam ser escalares ou []");
    for (double value : values) {
        if (!minimum.empty() && value < minimum.data[0]) c.fail(std::string(what) + " abaixo de Output minimum");
        if (!maximum.empty() && value > maximum.data[0]) c.fail(std::string(what) + " acima de Output maximum");
    }
}

/** Inteiro >= `minimum` (contagens de amostras, bits, sementes). */
double integerParam(const BuildContext& c, double value, const char* what, double minimum, double maximum = 9007199254740992.0) {
    if (!std::isfinite(value) || value != std::floor(value) || value < minimum || value > maximum)
        c.fail(std::string(what) + " precisa ser inteiro em [" + std::to_string(static_cast<long long>(minimum)) + ", " +
               std::to_string(static_cast<long long>(maximum)) + "]");
    return value;
}

void buildConstant(BuildContext& c) {
    const lib::ParamValue value = c.value("Value");
    if (value.empty()) c.fail("Constant value vazio");
    if (value.numel() > 4096) c.fail("Constant value grande demais");
    checkOutputRange(c, value.data, "Constant value");
    // Matriz vira vetor na ordem linear do MATLAB (por coluna).
    simpleKernel(c, "constant", static_cast<uint16_t>(value.numel()), value.linear());
}

void buildGround(BuildContext& c) { simpleKernel(c, "constant", 1, {0.0}); }

/** Parâmetro renomeado pela MathWorks (R2026a: Step Before/After -> InitialValue/FinalValue; os
 * nomes antigos continuam aceitos pelo set_param): o antigo vale quando o novo está no padrão. */
lib::ParamValue renamedParam(const BuildContext& c, const char* name, const char* legacy) {
    const ParamSpec* spec = c.spec.param(name);
    if (c.props.count(legacy) != 0 && spec && c.text(name) == propertyText(spec->defaultValue)) return c.value(legacy);
    return c.value(name);
}

void buildStep(BuildContext& c) {
    const double time = c.scalar("Time");
    std::vector<double> before = renamedParam(c, "InitialValue", "Before").linear();
    std::vector<double> after = renamedParam(c, "FinalValue", "After").linear();
    if (before.empty() || after.empty()) c.fail("Initial value/Final value vazios");
    const size_t n = std::max(before.size(), after.size());
    before = expandTo(c, before, n, "Initial value");
    after = expandTo(c, after, n, "Final value");
    std::vector<double> rp{time};
    rp.insert(rp.end(), before.begin(), before.end());
    rp.insert(rp.end(), after.begin(), after.end());
    simpleKernel(c, "step", static_cast<uint16_t>(n), rp, {static_cast<int64_t>(n), eventNs(c, time, "Step time")});
}

void buildRamp(BuildContext& c) {
    size_t n = 1;
    const auto values = expandedParams(c, {"slope", "start", "InitialOutput"}, n);
    std::vector<int64_t> ip{static_cast<int64_t>(n)};
    for (double start : values[1]) ip.push_back(eventNs(c, start, "Start time"));
    simpleKernel(c, "ramp", static_cast<uint16_t>(n), concat(values), ip);
}

void buildSine(BuildContext& c) {
    const bool sampleBased = c.text("SineType") == "Sample based";
    const bool externalTime = !sampleBased && c.text("TimeSource") == "Use external signal";
    const std::vector<const char*> names = sampleBased ? std::vector<const char*>{"Amplitude", "Bias", "Samples", "Offset"}
                                                       : std::vector<const char*>{"Amplitude", "Bias", "Frequency", "Phase"};
    size_t n = 1;
    const auto values = expandedParams(c, names, n, externalTime ? c.inputWidth(0) : 1);
    simpleKernel(c, "sine_wave", static_cast<uint16_t>(n), concat(values), {sampleBased ? 1 : externalTime ? 2 : 0, static_cast<int64_t>(n)});
}

void buildClock(BuildContext& c) {
    if (c.spec.param("Decimation") && c.flag("DisplayTime")) integerParam(c, c.scalar("Decimation"), "Decimation", 1);
    simpleKernel(c, "clock", 1);
}

void buildPulseGenerator(BuildContext& c) {
    const bool sampleBased = c.text("PulseType") == "Sample based";
    const bool external = !sampleBased && c.text("TimeSource") == "Use external signal";
    size_t n = 1;
    auto values = expandedParams(c, {"Amplitude", "Period", "PulseWidth", "PhaseDelay"}, n, external ? c.inputWidth(0) : 1);
    for (size_t e = 0; e < n; ++e) {
        double& period = values[1][e];
        double& width = values[2][e];
        double& delay = values[3][e];
        if (!std::isfinite(delay)) c.fail("Phase delay precisa ser finito");
        if (sampleBased) {
            integerParam(c, period, "Period (amostras)", 1);
            integerParam(c, width, "Pulse width (amostras)", 0);
            integerParam(c, delay, "Phase delay (amostras)", -9007199254740992.0);
            continue;
        }
        if (!(period > 0.0) || !std::isfinite(period)) c.fail("Period precisa ser > 0");
        if (!(width >= 0.0 && width <= 100.0)) c.fail("Pulse width precisa estar em [0, 100] (% do periodo)");
        const double seconds = period * width / 100.0;
        if (seconds == 0.0 || seconds == period) c.fail("Period*PulseWidth/100 nao pode ser 0 nem igual a Period (saida constante)");
        width = seconds;
    }
    c.outputWidths = {static_cast<uint16_t>(n)};
    if (c.widthsOnly) return;
    // Modo por amostras: o bloco roda no Sample time (a especificação declara tempo contínuo, que é o
    // do modo por tempo -- ver relatório: a taxa depende de PulseType).
    simulation::SignalBlockDefinition& block = c.kernel("", "pulse_generator", inputWidths(c), static_cast<uint16_t>(n), concat(values),
                                                        {sampleBased ? 2 : external ? 1 : 0, static_cast<int64_t>(n)});
    if (sampleBased) block.rate = discreteRate(c, "SampleTime");
    c.connectInputs(c.outputBlock(0));
}

void buildSignalGenerator(BuildContext& c) {
    const std::string waveForm = c.text("WaveForm");
    const int64_t wave = waveForm == "sine" ? 0 : waveForm == "square" ? 1 : waveForm == "sawtooth" ? 2 : waveForm == "random" ? 3 : -1;
    if (wave < 0) c.fail("Wave form desconhecida: " + waveForm);
    const bool external = c.text("TimeSource") == "Use external signal";
    const bool hertz = c.text("Units") == "Hertz";
    size_t n = 1;
    auto values = expandedParams(c, {"Amplitude", "Frequency"}, n, external ? c.inputWidth(0) : 1);
    for (double& frequency : values[1]) {
        if (!std::isfinite(frequency)) c.fail("Frequency precisa ser finita");
        if (!hertz) frequency /= kTwoPi;
    }
    std::vector<double> rp = concat(values);
    rp.push_back(0.0); // semente fixa da forma aleatória (o bloco não tem parâmetro de semente)
    simpleKernel(c, "signal_generator", static_cast<uint16_t>(n), rp, {wave, external ? 1 : 0, static_cast<int64_t>(n)});
}

/** Tabela tempo/valor de uma sequência repetitiva: mesmos tamanhos, >= 2 pontos, tempos finitos e
 * estritamente crescentes. */
std::vector<double> sequenceTable(const BuildContext& c, const char* timeName, const char* valueName) {
    const std::vector<double> times = c.value(timeName).linear(), values = c.value(valueName).linear();
    if (times.size() != values.size()) c.fail(std::string(timeName) + " e " + valueName + " precisam ter o mesmo numero de elementos");
    if (times.size() < 2) c.fail("a sequencia precisa de pelo menos dois pontos");
    for (size_t j = 0; j < times.size(); ++j) {
        if (!std::isfinite(times[j])) c.fail(std::string(timeName) + " precisa ser finito");
        if (j > 0 && !(times[j] > times[j - 1])) c.fail(std::string(timeName) + " precisa ser estritamente crescente");
    }
    std::vector<double> rp = times;
    rp.insert(rp.end(), values.begin(), values.end());
    return rp;
}

void buildRepeatingSequence(BuildContext& c) {
    std::vector<double> rp = sequenceTable(c, "rep_seq_t", "rep_seq_y");
    const auto m = static_cast<int64_t>(rp.size() / 2);
    simpleKernel(c, "repeating_sequence", 1, std::move(rp), {0, m});
}

void buildRepeatingSequenceInterpolated(BuildContext& c) {
    requireDiscreteSource(c);
    const std::string method = c.text("LookUpMeth");
    const int64_t code = method == "Interpolation-Use End Values" ? 0 : method == "Use Input Nearest" ? 1 : method == "Use Input Below" ? 2
                       : method == "Use Input Above" ? 3 : -1;
    if (code < 0) c.fail("Lookup Method desconhecido: " + method);
    std::vector<double> rp = sequenceTable(c, "TimeValues", "OutValues");
    const auto m = static_cast<int64_t>(rp.size() / 2);
    checkOutputRange(c, std::vector<double>(rp.begin() + m, rp.end()), "Vector of output values");
    simpleKernel(c, "repeating_sequence", 1, std::move(rp), {code, m});
}

void buildRepeatingSequenceStair(BuildContext& c) {
    requireDiscreteSource(c);
    const std::vector<double> values = c.value("OutValues").linear();
    if (values.empty()) c.fail("Vector of output values vazio");
    checkOutputRange(c, values, "Vector of output values");
    simpleKernel(c, "sequence_stair", 1, values);
}

void buildChirp(BuildContext& c) {
    size_t n = 1;
    const auto values = expandedParams(c, {"f1", "T", "f2"}, n);
    for (double target : values[1]) if (!(target > 0.0) || !std::isfinite(target)) c.fail("Target time precisa ser > 0");
    simpleKernel(c, "chirp", static_cast<uint16_t>(n), concat(values), {static_cast<int64_t>(n)});
}

void checkSeeds(const BuildContext& c, const std::vector<double>& seeds) {
    for (double seed : seeds) integerParam(c, seed, "Seed", 0);
}

void buildRandomNumber(BuildContext& c) {
    size_t n = 1;
    auto values = expandedParams(c, {"Mean", "Variance", "Seed"}, n);
    for (double& variance : values[1]) {
        if (!(variance >= 0.0) || !std::isfinite(variance)) c.fail("Variance precisa ser >= 0");
        variance = std::sqrt(variance);
    }
    checkSeeds(c, values[2]);
    simpleKernel(c, "random_number", static_cast<uint16_t>(n), concat(values), {0, static_cast<int64_t>(n)});
}

void buildUniformRandomNumber(BuildContext& c) {
    size_t n = 1;
    auto values = expandedParams(c, {"Minimum", "Maximum", "Seed"}, n);
    for (size_t e = 0; e < n; ++e) {
        if (!std::isfinite(values[0][e]) || !std::isfinite(values[1][e])) c.fail("Minimum/Maximum precisam ser finitos");
        values[1][e] -= values[0][e];
    }
    checkSeeds(c, values[2]);
    simpleKernel(c, "random_number", static_cast<uint16_t>(n), concat(values), {1, static_cast<int64_t>(n)});
}

void buildBandLimitedWhiteNoise(BuildContext& c) {
    if (c.resolution.rate.continuous() || constantRate(c))
        c.fail("exige tempo de amostragem discreto (Sample time = tempo de correlacao do ruido, > 0)");
    size_t n = 1;
    auto values = expandedParams(c, {"Cov", "seed"}, n);
    const double ts = static_cast<double>(c.resolution.rate.periodNs) * 1e-9;
    std::vector<double> rp(n, 0.0);
    for (double power : values[0]) {
        if (!(power >= 0.0) || !std::isfinite(power)) c.fail("Noise power precisa ser >= 0");
        rp.push_back(std::sqrt(power / ts));
    }
    checkSeeds(c, values[1]);
    rp.insert(rp.end(), values[1].begin(), values[1].end());
    simpleKernel(c, "random_number", static_cast<uint16_t>(n), rp, {0, static_cast<int64_t>(n)});
}

void buildCounterFreeRunning(BuildContext& c) {
    requireDiscreteSource(c);
    // Contagem exata em double: até 2^53 (o Simulink vai até 64 bits com tipos inteiros).
    const double bits = integerParam(c, c.scalar("NumBits"), "Number of Bits", 1, 53);
    simpleKernel(c, "counter", 1, {std::ldexp(1.0, static_cast<int>(bits))});
}

void buildCounterLimited(BuildContext& c) {
    requireDiscreteSource(c);
    const double limit = integerParam(c, c.scalar("uplimit"), "Upper limit", 0, 9007199254740991.0);
    simpleKernel(c, "counter", 1, {limit + 1.0});
}

} // namespace

void registerSourceBuilders(BuilderTable& table) {
    table.add("constant", buildConstant);
    table.add("ground", buildGround);
    table.add("step", buildStep);
    table.add("ramp", buildRamp);
    table.add("sine_wave", buildSine);
    table.add("sine_wave_function", buildSine); // Math Operations: mesmo bloco (BlockType Sin) com tempo externo
    table.add("clock", buildClock);
    table.add("digital_clock", buildClock);
    table.add("pulse_generator", buildPulseGenerator);
    table.add("signal_generator", buildSignalGenerator);
    table.add("repeating_sequence", buildRepeatingSequence);
    table.add("repeating_sequence_interpolated", buildRepeatingSequenceInterpolated);
    table.add("repeating_sequence_stair", buildRepeatingSequenceStair);
    table.add("chirp_signal", buildChirp);
    table.add("random_number", buildRandomNumber);
    table.add("uniform_random_number", buildUniformRandomNumber);
    table.add("band_limited_white_noise", buildBandLimitedWhiteNoise);
    table.add("counter_free_running", buildCounterFreeRunning);
    table.add("counter_limited", buildCounterLimited);
}

} // namespace lasecsimul::components::blocks::builders
