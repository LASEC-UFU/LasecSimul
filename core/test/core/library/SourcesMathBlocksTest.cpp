// Blocos `sl.*` -- Sources, Sinks e Math Operations (docs/66). Referencias analiticas ou definicoes documentadas pela
// MathWorks; nunca o proprio engine como referencia.
#include <algorithm>
#include <cmath>
#include <functional>
#include <limits>
#include <utility>
#include <vector>

#include "library/LibraryTestHarness.hpp"

using namespace library_test;

namespace {

constexpr double kPi = 3.14159265358979323846;
const double kNaN = std::numeric_limits<double>::quiet_NaN();

/** Falha na montagem/compilacao com mensagem contendo `fragment` (a recusa e pelo motivo certo). */
bool failsWith(const std::function<void()>& body, const std::string& fragment) {
    try { body(); } catch (const std::exception& error) {
        const bool ok = std::string(error.what()).find(fragment) != std::string::npos;
        if (!ok) std::fprintf(stderr, "  mensagem inesperada: %s\n", error.what());
        return ok;
    }
    return false;
}

/** Bloco sob teste alimentado por constantes (uma por entrada, `SampleTime` constante). */
struct Fed {
    Harness h;
    uint32_t block = 0;
    Fed(const std::string& type, std::initializer_list<std::pair<const char*, PropertyValue>> properties, const std::vector<std::string>& inputs) {
        block = h.add(type, properties);
        // Portas na ordem do Simulink, resolvidas pela especificacao (Assignment sem Y0 comeca em in2).
        lasecsimul::components::blocks::PropertyMap map;
        for (const auto& [name, value] : properties) map[name] = value;
        const auto* spec = lasecsimul::components::blocks::findBlockSpec("sl." + type);
        const auto ports = lasecsimul::components::blocks::resolvePorts(spec->inputs, lasecsimul::components::blocks::withDefaults(*spec, map));
        for (size_t i = 0; i < inputs.size(); ++i) {
            const uint32_t source = h.add("constant", {{"Value", text(inputs[i])}});
            h.wire(source, "out1", block, ports.at(i).c_str());
        }
        h.runUntil(0.01);
    }
    double operator()(uint16_t element = 0, const char* port = "out1") { return h.value(block, port, element); }
};

/** Valor de `port` em cada instante de `times` (uma simulacao, instantes crescentes). */
std::vector<double> sampled(Harness& h, uint32_t block, const std::vector<double>& times, const char* port = "out1", uint16_t element = 0) {
    std::vector<double> values;
    for (double t : times) { h.runUntil(t); values.push_back(h.value(block, port, element)); }
    return values;
}

void expectSeries(const std::vector<double>& actual, const std::vector<double>& expected, double tol, const std::string& label) {
    bool ok = actual.size() == expected.size();
    std::string text;
    for (size_t i = 0; ok && i < actual.size(); ++i) {
        ok = (std::isnan(expected[i]) && std::isnan(actual[i])) || std::abs(actual[i] - expected[i]) <= tol;
        text += std::to_string(actual[i]) + " ";
    }
    check(ok, label + " (" + text + ")");
}

/** Integral exata de uma fonte (Integrator da biblioteca): mede se as bordas foram acertadas. */
double integral(const std::string& type, std::initializer_list<std::pair<const char*, PropertyValue>> properties, double until) {
    Harness h;
    const uint32_t source = h.add(type, properties);
    const uint32_t integrator = h.add("integrator");
    h.wire(source, "out1", integrator, "in1");
    h.runUntil(until);
    return h.value(integrator);
}

// ============================================================================ Sources

void constantBlock() {
    { Fed f("constant", {{"Value", text("[1 2 3]")}}, {}); check(f(0) == 1.0 && f(2) == 3.0, "Constant vetorial [1 2 3]"); }
    { Fed f("constant", {{"Value", text("[1 2; 3 4]")}}, {}); check(f(0) == 1.0 && f(1) == 3.0 && f(2) == 2.0 && f(3) == 4.0, "Constant matriz vira vetor na ordem por coluna"); }
    { Fed f("constant", {{"Value", text("2.5")}, {"SampleTime", text("0.1")}}, {}); check(f() == 2.5, "Constant com Sample time discreto"); }
    check(failsWith([] { Fed f("constant", {{"Value", text("5")}, {"OutMax", text("4")}}, {}); }, "acima de Output maximum"), "Constant: Value acima de Output maximum e recusado");
    check(failsWith([] { Fed f("constant", {{"Value", text("[1 -1]")}, {"OutMin", text("0")}}, {}); }, "abaixo de Output minimum"), "Constant: Value abaixo de Output minimum e recusado");
    { Fed f("constant", {{"Value", text("3")}, {"OutMin", text("0")}, {"OutMax", text("4")}}, {}); check(f() == 3.0, "Constant dentro de [OutMin, OutMax]"); }
    { Fed f("ground", {}, {}); check(f() == 0.0, "Ground = 0"); }
}

void stepBlock() {
    Harness h;
    const uint32_t step = h.add("step");
    expectSeries(sampled(h, step, {0.5, 0.999, 1.0, 1.5}), {0, 0, 1, 1}, 0.0, "Step padrao: 0 antes de t = 1, 1 a partir de t = 1");
    expectNear(integral("step", {{"Time", text("0.37")}, {"InitialValue", text("-1")}, {"FinalValue", text("2")}}, 2.0), -0.37 + 2.0 * 1.63, 1e-9,
               "Step -> Integrator: a borda em 0.37 e acertada exatamente");
    { Fed f("step", {{"Time", text("-1")}, {"InitialValue", text("4")}, {"FinalValue", text("7")}}, {}); check(f() == 7.0, "Step time < 0: valor final desde t = 0"); }
    { Fed f("step", {{"Time", text("inf")}, {"FinalValue", text("7")}}, {}); check(f() == 0.0, "Step time Inf: nunca muda"); }
    { Fed f("step", {{"Time", text("0")}, {"InitialValue", text("[1 2]")}, {"FinalValue", text("5")}}, {}); check(f(0) == 5.0 && f(1) == 5.0, "Step vetorial (expansao escalar do Final value)"); }
    // Nomes antigos (antes de R2026a) continuam aceitos, como no set_param.
    { Fed f("step", {{"Time", text("0")}, {"Before", text("3")}, {"After", text("9")}}, {}); check(f() == 9.0, "Step: After (nome antigo de FinalValue) aceito"); }
    // Tempo discreto: a borda aparece no primeiro acerto de amostra >= Time.
    Harness d;
    const uint32_t discrete = d.add("step", {{"Time", text("1")}, {"SampleTime", text("0.3")}});
    expectSeries(sampled(d, discrete, {0.95, 1.05, 1.25}), {0, 0, 1}, 0.0, "Step discreto Ts = 0.3: amostra 1.2 e a primeira com o valor final");
    check(failsWith([] { Fed f("step", {{"InitialValue", text("[1 2]")}, {"FinalValue", text("[1 2 3]")}}, {}); }, "largura 2 incompativel com 3"), "Step: larguras incompativeis recusadas");
}

void rampBlock() {
    Harness h;
    const uint32_t ramp = h.add("ramp", {{"slope", text("2")}, {"start", text("1")}, {"InitialOutput", text("0.5")}});
    expectSeries(sampled(h, ramp, {0.5, 1.0, 3.0}), {0.5, 0.5, 4.5}, 1e-12, "Ramp: InitialOutput + slope*(t - start)");
    expectNear(integral("ramp", {{"start", text("1")}}, 3.0), 2.0, 1e-9, "Ramp -> Integrator: area 0.5*2^2 (quina em start acertada)");
    { Fed f("ramp", {{"slope", text("1")}, {"start", text("-1")}}, {}); expectNear(f(), 1.01, 1e-12, "Ramp com start < 0 ja em curso em t = 0"); }
    { Fed f("ramp", {{"slope", text("[1 2]")}, {"start", text("0")}}, {}); expectNear(f(1), 0.02, 1e-12, "Ramp vetorial (slope [1 2])"); }
}

void sineBlocks() {
    {
        Harness h;
        const uint32_t sine = h.add("sine_wave", {{"Amplitude", text("2")}, {"Bias", text("1")}, {"Frequency", text("3")}, {"Phase", text("0.5")}});
        h.runUntil(1.3);
        expectNear(h.value(sine), 2.0 * std::sin(3.0 * 1.3 + 0.5) + 1.0, 1e-12, "Sine Wave continuo: A*sin(w*t + phi) + b");
    }
    {
        Harness h;
        const uint32_t sine = h.add("sine_wave", {{"SampleTime", text("0.1")}});
        h.runUntil(0.35);
        expectNear(h.value(sine), std::sin(0.3), 1e-12, "Sine Wave discreto: valor da amostra t = 0.3 mantido");
    }
    {
        Harness h;
        const uint32_t sine = h.add("sine_wave", {{"SineType", text("Sample based")}, {"Samples", text("4")}, {"Offset", text("1")}, {"SampleTime", text("0.25")}});
        expectSeries(sampled(h, sine, {0.1, 0.3, 0.6, 0.8, 1.1}), {1, 0, -1, 0, 1}, 1e-12, "Sine Wave por amostras: sin(2*pi*(k + o)/p), k volta a 0 em p");
    }
    {
        Harness h; // [Ts offset]: k conta acertos de amostra, nao t/Ts
        const uint32_t sine = h.add("sine_wave", {{"SineType", text("Sample based")}, {"Samples", text("4")}, {"SampleTime", text("[0.25 0.1]")}});
        expectSeries(sampled(h, sine, {0.2, 0.4}), {0, 1}, 1e-12, "Sine Wave por amostras com offset de tempo: k = 0 em t = 0.1, k = 1 em 0.35");
    }
    {
        Harness h;
        const uint32_t clock = h.add("clock");
        const uint32_t twice = h.add("gain", {{"Gain", text("2")}});
        const uint32_t sine = h.add("sine_wave", {{"TimeSource", text("Use external signal")}, {"Amplitude", text("3")}});
        const uint32_t function = h.add("sine_wave_function");
        h.wire(clock, "out1", twice, "in1");
        h.wire(twice, "out1", sine, "in1");
        h.wire(clock, "out1", function, "in1");
        h.runUntil(0.8);
        expectNear(h.value(sine), 3.0 * std::sin(1.6), 1e-12, "Sine Wave com tempo externo u = 2t");
        expectNear(h.value(function), std::sin(0.8), 1e-12, "Sine Wave Function (tempo externo por padrao)");
    }
    check(failsWith([] { Fed f("sine_wave", {{"SineType", text("Sample based")}}, {}); }, "exige Sample time > 0"), "Sine Wave por amostras com Sample time 0 e recusado");
    check(failsWith([] { Fed f("sine_wave", {{"SineType", text("Sample based")}, {"Samples", text("0")}, {"SampleTime", text("1")}}, {}); }, "Samples per period"),
          "Sine Wave: Samples per period <= 0 recusado");
}

void clockBlocks() {
    { Harness h; const uint32_t c = h.add("clock"); h.runUntil(1.234); expectNear(h.value(c), 1.234, 1e-12, "Clock: y = t"); }
    { Harness h; const uint32_t c = h.add("digital_clock", {{"SampleTime", text("0.25")}}); h.runUntil(0.6); expectNear(h.value(c), 0.5, 1e-12, "Digital Clock: t da ultima amostra"); }
    check(failsWith([] { Fed f("clock", {{"DisplayTime", PropertyValue{true}}, {"Decimation", text("0")}}, {}); }, "Decimation"), "Clock: Decimation 0 recusada");
}

void pulseGenerator() {
    {
        Harness h;
        const uint32_t pulse = h.add("pulse_generator");
        expectSeries(sampled(h, pulse, {0.25, 0.6, 10.1, 10.6}), {1, 0, 1, 0}, 0.0, "Pulse Generator padrao: 5% de 10 s ligado a partir de 0");
    }
    {
        Harness h;
        const uint32_t pulse = h.add("pulse_generator", {{"Amplitude", text("[1 3]")}, {"Period", text("4")}, {"PulseWidth", text("75")}, {"PhaseDelay", text("1")}});
        expectSeries(sampled(h, pulse, {0.5, 1.5, 3.9, 4.2, 5.1}, "out1", 1), {0, 3, 3, 0, 3}, 0.0, "Pulse Generator: atraso 1 s, 3 s ligado a cada 4 s, amplitude vetorial");
    }
    expectNear(integral("pulse_generator", {}, 25.0), 1.5, 1e-9, "Pulse Generator -> Integrator: 3 pulsos de 0.5 s (bordas acertadas)");
    expectNear(integral("pulse_generator", {{"Period", text("0.3")}, {"PulseWidth", text("40")}, {"PhaseDelay", text("0.05")}}, 3.0),
               10 * 0.12, 1e-9, "Pulse Generator periodo 0.3 s nao acumula deriva de borda (10 pulsos de 0.12 s)");
    {
        Harness h; // por amostras: P = 4, W = 2, D = 1 amostras de 0.1 s
        const uint32_t pulse = h.add("pulse_generator", {{"PulseType", text("Sample based")}, {"Period", text("4")}, {"PulseWidth", text("2")},
                                                          {"PhaseDelay", text("1")}, {"SampleTime", text("0.1")}});
        std::vector<double> times;
        for (int k = 0; k < 8; ++k) times.push_back(0.1 * k + 0.05);
        expectSeries(sampled(h, pulse, times), {0, 1, 1, 0, 0, 1, 1, 0}, 0.0, "Pulse Generator por amostras: k >= D e mod(k - D, P) < W");
    }
    {
        Harness h;
        const uint32_t clock = h.add("clock");
        const uint32_t twice = h.add("gain", {{"Gain", text("2")}});
        const uint32_t pulse = h.add("pulse_generator", {{"TimeSource", text("Use external signal")}, {"Period", text("1")}, {"PulseWidth", text("50")}});
        h.wire(clock, "out1", twice, "in1");
        h.wire(twice, "out1", pulse, "in1");
        expectSeries(sampled(h, pulse, {0.2, 0.3}), {1, 0}, 0.0, "Pulse Generator com tempo externo u = 2t");
    }
    check(failsWith([] { Fed f("pulse_generator", {{"PulseWidth", text("0")}}, {}); }, "saida constante"), "Pulse Generator: largura 0 (saida constante) recusada");
    check(failsWith([] { Fed f("pulse_generator", {{"PulseWidth", text("100")}}, {}); }, "saida constante"), "Pulse Generator: largura 100% (saida constante) recusada");
    check(failsWith([] { Fed f("pulse_generator", {{"Period", text("0")}}, {}); }, "Period precisa ser > 0"), "Pulse Generator: Period 0 recusado");
    check(failsWith([] { Fed f("pulse_generator", {{"PulseType", text("Sample based")}, {"Period", text("2.5")}}, {}); }, "Period (amostras)"), "Pulse Generator por amostras: Period nao inteiro recusado");
    check(failsWith([] { Fed f("pulse_generator", {{"PulseType", text("Sample based")}, {"SampleTime", text("0")}}, {}); }, "exige tempo de amostragem discreto"), "Pulse Generator por amostras: Sample time 0 recusado");
}

void signalGenerator() {
    {
        Harness h;
        const uint32_t sine = h.add("signal_generator", {{"Amplitude", text("2")}, {"Frequency", text("3")}});
        const uint32_t hertz = h.add("signal_generator", {{"Frequency", text("0.5")}, {"Units", text("Hertz")}});
        h.runUntil(0.7);
        expectNear(h.value(sine), 2.0 * std::sin(2.1), 1e-12, "Signal Generator seno (rad/s)");
        expectNear(h.value(hertz), std::sin(kPi * 0.7), 1e-12, "Signal Generator seno (Hz)");
    }
    {
        Harness h; // quadrada 1 rad/s: -A na primeira metade do periodo 2*pi, +A na segunda
        const uint32_t square = h.add("signal_generator", {{"WaveForm", text("square")}});
        expectSeries(sampled(h, square, {1.0, 4.0, 7.0}), {-1, 1, -1}, 0.0, "Signal Generator quadrada: -A ate t = pi, +A ate 2*pi");
    }
    {
        Harness h;
        const uint32_t saw = h.add("signal_generator", {{"WaveForm", text("sawtooth")}, {"Units", text("Hertz")}, {"Amplitude", text("2")}});
        expectSeries(sampled(h, saw, {0.25, 1.75}), {1.0, -1.0}, 1e-12, "Signal Generator dente de serra: A*(1 - 2*frac(f*t))");
    }
    expectNear(integral("signal_generator", {{"WaveForm", text("square")}, {"Units", text("Hertz")}}, 0.75), -0.25, 1e-9,
               "Signal Generator quadrada -> Integrator: bordas em multiplos de 1/(2f) acertadas");
    expectNear(integral("signal_generator", {{"WaveForm", text("sawtooth")}, {"Units", text("Hertz")}}, 1.5), 0.25, 1e-9,
               "Signal Generator dente de serra -> Integrator: salto em t = 1 acertado");
    {
        Harness a, b;
        const uint32_t ra = a.add("signal_generator", {{"WaveForm", text("random")}, {"Units", text("Hertz")}, {"Frequency", text("10")}, {"Amplitude", text("2")}});
        const uint32_t rb = b.add("signal_generator", {{"WaveForm", text("random")}, {"Units", text("Hertz")}, {"Frequency", text("10")}, {"Amplitude", text("2")}});
        const std::vector<double> times{0.02, 0.07, 0.12, 0.33, 0.51};
        const std::vector<double> va = sampled(a, ra, times), vb = sampled(b, rb, times);
        const bool bounded = std::all_of(va.begin(), va.end(), [](double v) { return v >= -2.0 && v <= 2.0; });
        check(va == vb && bounded && va[0] == va[1] && va[1] != va[2], "Signal Generator aleatoria: uniforme em [-A, A], mantida por 1/f, repetivel");
    }
}

void repeatingSequences() {
    {
        Harness h;
        const uint32_t seq = h.add("repeating_sequence");
        expectSeries(sampled(h, seq, {0.5, 2.5, 3.9}), {0.5, 0.5, 1.9}, 1e-12, "Repeating Sequence padrao [0 2]/[0 2]: dente de serra de periodo 2");
    }
    {
        Harness h;
        const uint32_t seq = h.add("repeating_sequence", {{"rep_seq_t", text("[0 1 2]")}, {"rep_seq_y", text("[0 1 0]")}});
        expectSeries(sampled(h, seq, {1.5, 2.25}), {0.5, 0.25}, 1e-12, "Repeating Sequence triangular");
    }
    expectNear(integral("repeating_sequence", {}, 4.0), 4.0, 1e-9, "Repeating Sequence -> Integrator: dois periodos de area 2 (salto acertado)");
    check(failsWith([] { Fed f("repeating_sequence", {{"rep_seq_t", text("[0 1 1 2]")}, {"rep_seq_y", text("[0 0 1 1]")}}, {}); }, "estritamente crescente"), "Repeating Sequence: tempos repetidos recusados");
    check(failsWith([] { Fed f("repeating_sequence", {{"rep_seq_t", text("[0 1 2]")}, {"rep_seq_y", text("[0 1]")}}, {}); }, "mesmo numero de elementos"), "Repeating Sequence: tamanhos diferentes recusados");

    const auto lookup = [](const char* method, std::vector<double> times) {
        Harness h;
        const uint32_t seq = h.add("repeating_sequence_interpolated", {{"LookUpMeth", text(method)}});
        return sampled(h, seq, times);
    };
    expectSeries(lookup("Interpolation-Use End Values", {0.055, 0.305, 1.305}), {2.0, 2.5, 2.5}, 1e-9, "Repeating Sequence Interpolated: interpolacao linear periodica");
    expectSeries(lookup("Use Input Below", {0.305}), {1.0}, 0.0, "Repeating Sequence Interpolated: Use Input Below");
    expectSeries(lookup("Use Input Above", {0.305}), {4.0}, 0.0, "Repeating Sequence Interpolated: Use Input Above");
    expectSeries(lookup("Use Input Nearest", {0.255, 0.355}), {1.0, 4.0}, 0.0, "Repeating Sequence Interpolated: Use Input Nearest");
    check(failsWith([] { Fed f("repeating_sequence_interpolated", {{"tsamp", text("-1")}}, {}); }, "exige tempo de amostragem discreto"), "Repeating Sequence Interpolated com tsamp -1 numa fonte e recusado");

    {
        Harness h;
        const uint32_t stair = h.add("repeating_sequence_stair", {{"tsamp", text("0.5")}});
        expectSeries(sampled(h, stair, {0.1, 0.6, 1.1, 1.6, 2.1, 2.6}), {3, 1, 4, 2, 1, 3}, 0.0, "Repeating Sequence Stair: [3 1 4 2 1] repetido");
    }
    check(failsWith([] { Fed f("repeating_sequence_stair", {}, {}); }, "exige tempo de amostragem discreto"), "Repeating Sequence Stair com tsamp -1 numa fonte e recusado");
    check(failsWith([] { Fed f("repeating_sequence_stair", {{"tsamp", text("1")}, {"OutMin", text("2")}}, {}); }, "abaixo de Output minimum"), "Repeating Sequence Stair: valor abaixo de Output minimum");
}

void chirpSignal() {
    Harness h;
    const uint32_t chirp = h.add("chirp_signal");
    const uint32_t vector = h.add("chirp_signal", {{"f1", text("[0.1 1]")}});
    h.runUntil(5.0);
    expectNear(h.value(chirp), std::sin(2.0 * kPi * (0.1 * 5.0 + 0.9 * 25.0 / 200.0)), 1e-12, "Chirp: sin(2*pi*(f1*t + (f2 - f1)*t^2/(2T)))");
    expectNear(h.value(vector, "out1", 1), std::sin(2.0 * kPi * (1.0 * 5.0 + 0.0)), 1e-9, "Chirp vetorial (f1 = f2 = 1 Hz no elemento 2)");
    check(failsWith([] { Fed f("chirp_signal", {{"T", text("0")}}, {}); }, "Target time"), "Chirp: Target time 0 recusado");
}

/** `count` amostras (uma por Ts) da saída do bloco aleatório. */
std::vector<double> randomSamples(const std::string& type, std::initializer_list<std::pair<const char*, PropertyValue>> properties, double ts, int count, uint16_t element = 0) {
    Harness h;
    const uint32_t block = h.add(type, properties);
    std::vector<double> times;
    for (int k = 0; k < count; ++k) times.push_back(ts * k + ts / 2);
    return sampled(h, block, times, "out1", element);
}

void moments(const std::vector<double>& v, double& mean, double& variance) {
    mean = 0.0;
    for (double x : v) mean += x;
    mean /= static_cast<double>(v.size());
    variance = 0.0;
    for (double x : v) variance += (x - mean) * (x - mean);
    variance /= static_cast<double>(v.size() - 1);
}

void randomSources() {
    double mean = 0, variance = 0;
    const auto normal = randomSamples("random_number", {{"Mean", text("2")}, {"Variance", text("4")}, {"Seed", text("7")}, {"SampleTime", text("0.01")}}, 0.01, 10000);
    moments(normal, mean, variance);
    // 4 desvios-padrao da media amostral (sigma/sqrt(N) = 0.02) e ~5 da variancia amostral.
    check(std::abs(mean - 2.0) < 0.08 && std::abs(variance - 4.0) < 0.3, "Random Number: media 2 e variancia 4 (" + std::to_string(mean) + ", " + std::to_string(variance) + ")");
    const auto repeat = randomSamples("random_number", {{"Mean", text("2")}, {"Variance", text("4")}, {"Seed", text("7")}, {"SampleTime", text("0.01")}}, 0.01, 50);
    const auto other = randomSamples("random_number", {{"Mean", text("2")}, {"Variance", text("4")}, {"Seed", text("8")}, {"SampleTime", text("0.01")}}, 0.01, 50);
    check(std::equal(repeat.begin(), repeat.end(), normal.begin()) && repeat != other, "Random Number: mesma semente repete a sequencia, outra semente muda");
    {
        Harness h;
        const uint32_t block = h.add("random_number", {{"Seed", text("3")}, {"SampleTime", text("0.5")}});
        h.runUntil(0.6);
        const double first = h.value(block);
        h.runUntil(0.9);
        check(h.value(block) == first, "Random Number: valor mantido entre acertos de amostra");
    }
    const auto streamA = randomSamples("random_number", {{"Seed", text("[1 2]")}}, 0.1, 20, 0);
    const auto streamB = randomSamples("random_number", {{"Seed", text("[1 2]")}}, 0.1, 20, 1);
    check(streamA != streamB, "Random Number: Seed vetorial gera fluxos independentes");

    const auto uniform = randomSamples("uniform_random_number", {{"Minimum", text("-1")}, {"Maximum", text("3")}, {"Seed", text("11")}, {"SampleTime", text("0.01")}}, 0.01, 10000);
    moments(uniform, mean, variance);
    const bool bounded = std::all_of(uniform.begin(), uniform.end(), [](double v) { return v >= -1.0 && v < 3.0; });
    check(bounded && std::abs(mean - 1.0) < 0.05 && std::abs(variance - 16.0 / 12.0) < 0.08,
          "Uniform Random Number: em [Min, Max), media (Min+Max)/2 e variancia (Max-Min)^2/12 (" + std::to_string(mean) + ", " + std::to_string(variance) + ")");

    const auto noise = randomSamples("band_limited_white_noise", {{"Cov", text("0.4")}, {"Ts", text("0.1")}}, 0.1, 10000);
    moments(noise, mean, variance);
    check(std::abs(mean) < 0.1 && std::abs(variance - 4.0) < 0.3,
          "Band-Limited White Noise: variancia = Noise power / Ts = 4 (" + std::to_string(mean) + ", " + std::to_string(variance) + ")");

    check(failsWith([] { Fed f("random_number", {{"Seed", text("-1")}}, {}); }, "Seed"), "Random Number: semente negativa recusada");
    check(failsWith([] { Fed f("uniform_random_number", {{"Seed", text("1.5")}}, {}); }, "Seed"), "Uniform Random Number: semente nao inteira recusada");
    check(failsWith([] { Fed f("random_number", {{"Variance", text("-1")}}, {}); }, "Variance"), "Random Number: variancia negativa recusada");
    check(failsWith([] { Fed f("band_limited_white_noise", {{"Ts", text("0")}}, {}); }, "exige tempo de amostragem discreto"), "Band-Limited White Noise com Ts = 0 recusado");
}

void counters() {
    {
        Harness h;
        const uint32_t free = h.add("counter_free_running", {{"NumBits", text("2")}, {"tsamp", text("0.1")}});
        const uint32_t limited = h.add("counter_limited", {{"uplimit", text("2")}, {"tsamp", text("0.1")}});
        std::vector<double> times;
        for (int k = 0; k < 6; ++k) times.push_back(0.1 * k + 0.05);
        std::vector<double> freeValues, limitedValues;
        for (double t : times) { h.runUntil(t); freeValues.push_back(h.value(free)); limitedValues.push_back(h.value(limited)); }
        expectSeries(freeValues, {0, 1, 2, 3, 0, 1}, 0.0, "Counter Free-Running 2 bits: k mod 4");
        expectSeries(limitedValues, {0, 1, 2, 0, 1, 2}, 0.0, "Counter Limited 2: k mod 3");
    }
    check(failsWith([] { Fed f("counter_free_running", {}, {}); }, "exige tempo de amostragem discreto"), "Counter Free-Running com tsamp -1 numa fonte e recusado");
    check(failsWith([] { Fed f("counter_free_running", {{"NumBits", text("0")}, {"tsamp", text("1")}}, {}); }, "Number of Bits"), "Counter Free-Running: 0 bits recusado");
    check(failsWith([] { Fed f("counter_limited", {{"uplimit", text("-1")}, {"tsamp", text("1")}}, {}); }, "Upper limit"), "Counter Limited: limite negativo recusado");
}

// ============================================================================ Sinks

void sinks() {
    {
        Harness h;
        const uint32_t constant = h.add("constant", {{"Value", text("5")}});
        const uint32_t display = h.add("display");
        const uint32_t terminator = h.add("terminator");
        h.wire(constant, "out1", display, "in1");
        h.wire(constant, "out1", terminator, "in1");
        h.runUntil(0.01);
        check(h.value(display, "in1") == 5.0, "Display le o sinal da entrada");
    }
    check(failsWith([] { Fed f("display", {{"Decimation", text("0")}}, {}); }, "Decimation"), "Display: Decimation 0 recusada");
    check(failsWith([] { Fed f("display", {{"Format", text("hexa")}}, {}); }, "Format desconhecido"), "Display: formato desconhecido recusado");
    { Fed f("scope", {{"NumInputPorts", text("3")}, {"TimeSpan", text("5")}}, {"1", "2", "3"}); check(f.h.value(f.block, "in3") == 3.0, "Scope com 3 entradas e janela de 5 s"); }
    check(failsWith([] { Fed f("scope", {{"NumInputPorts", text("97")}}, {}); }, "NumInputPorts"), "Scope: mais de 96 entradas recusado");
    check(failsWith([] { Fed f("scope", {{"YLimits", text("[1 1]")}}, {}); }, "YLimits"), "Scope: YLimits com ymin >= ymax recusado");
    check(failsWith([] { Fed f("scope", {{"LayoutDimensions", text("[2 2]")}, {"ActiveDisplay", text("5")}}, {}); }, "ActiveDisplay"), "Scope: ActiveDisplay fora da grade recusado");
    check(failsWith([] { Fed f("scope", {{"TimeSpan", text("-2")}}, {}); }, "TimeSpan"), "Scope: TimeSpan negativo recusado");
}

// ============================================================================ Math Operations

void gainBlocks() {
    { Fed f("gain", {{"Gain", text("2")}}, {"[1 2 3]"}); check(f(2) == 6.0, "Gain escalar .* vetor"); }
    { Fed f("gain", {{"Gain", text("[1 2 3]")}}, {"[4 5 6]"}); check(f(0) == 4.0 && f(2) == 18.0, "Gain vetorial elemento a elemento"); }
    { Fed f("gain", {{"Gain", text("[1 2; 3 4]")}, {"Multiplication", text("Matrix(K*u)")}}, {"[1 1]"}); check(f(0) == 3.0 && f(1) == 7.0, "Gain Matrix(K*u)"); }
    { Fed f("gain", {{"Gain", text("[1 2; 3 4]")}, {"Multiplication", text("Matrix(u*K)")}}, {"[1 1]"}); check(f(0) == 4.0 && f(1) == 6.0, "Gain Matrix(u*K)"); }
    { Fed f("gain", {{"Gain", text("3")}, {"Multiplication", text("Matrix(K*u) (u vector)")}}, {"[1 2]"}); check(f(1) == 6.0, "Gain escalar em modo matricial = escalar*u"); }
    check(failsWith([] { Fed f("gain", {{"Gain", text("[1 2; 3 4]")}, {"Multiplication", text("Matrix(K*u)")}}, {"[1 1 1]"}); }, "K*u exige"), "Gain K*u com dimensoes incompativeis recusado");
    check(failsWith([] { Fed f("gain", {{"Gain", text("-1")}, {"ParamMin", text("0")}}, {"1"}); }, "Parameter minimum"), "Gain abaixo de Parameter minimum recusado");
    { Fed f("slider_gain", {{"gain", text("1.5")}}, {"[2 4]"}); check(f(1) == 6.0, "Slider Gain: y = gain*u"); }
}

void sumProduct() {
    { Fed f("sum", {{"Inputs", text("|+-")}}, {"5", "[1 2]"}); check(f(0) == 4.0 && f(1) == 3.0, "Sum |+- com expansao escalar"); }
    { Fed f("sum", {{"Inputs", text("+")}}, {"[1 2 3]"}); check(f() == 6.0, "Sum of Elements"); }
    { Fed f("sum", {{"Inputs", text("-")}}, {"[1 2 3]"}); check(f() == -6.0, "Sum de uma entrada '-' = -soma dos elementos"); }
    { Fed f("sum", {{"Inputs", text("--")}}, {"1", "2"}); check(f() == -3.0, "Sum '--' = 0 - u1 - u2"); }
    { Fed f("sum", {{"Inputs", text("3")}}, {"1", "2", "4"}); check(f() == 7.0, "Sum com numero de entradas"); }
    { Fed f("sum", {{"Inputs", text("+")}, {"CollapseMode", text("Specified dimension")}, {"CollapseDim", text("1")}}, {"[1 2 3]"}); check(f() == 6.0, "Sum Specified dimension 1 de vetor 1-D"); }
    check(failsWith([] { Fed f("sum", {{"Inputs", text("+")}, {"CollapseMode", text("Specified dimension")}, {"CollapseDim", text("2")}}, {"[1 2 3]"}); }, "Dimension maior"), "Sum: dimensao 2 de sinal 1-D recusada");
    check(failsWith([] { Fed f("sum", {{"Inputs", text("+*")}}, {"1", "2"}); }, "caractere invalido"), "Sum: caractere invalido na lista de sinais recusado");
    check(failsWith([] { Fed f("sum", {{"Inputs", text("++")}}, {"[1 2]", "[1 2 3]"}); }, "largura"), "Sum: larguras diferentes recusadas");

    { Fed f("product", {{"Inputs", text("*/")}}, {"6", "3"}); check(f() == 2.0, "Divide (Product */)"); }
    { Fed f("product", {{"Inputs", text("*")}}, {"[2 3 4]"}); check(f() == 24.0, "Product of Elements"); }
    { Fed f("product", {{"Inputs", text("/")}}, {"[2 4]"}); check(f() == 0.125, "Product de uma entrada '/' = 1/prod"); }
    { Fed f("product", {{"Inputs", text("**/")}}, {"[2 4]", "3", "[1 2]"}); check(f(0) == 6.0 && f(1) == 6.0, "Product **/ elemento a elemento"); }
    { Fed f("product", {{"Multiplication", text("Matrix(*)")}}, {"2", "[1 2]"}); check(f(1) == 4.0, "Product Matrix(*): escalar * vetor"); }
    { Fed f("product", {{"Inputs", text("*")}, {"Multiplication", text("Matrix(*)")}}, {"[2 3]"}); check(f(0) == 2.0 && f(1) == 3.0, "Product Matrix(*) de uma entrada '*' = a propria entrada"); }
    check(failsWith([] { Fed f("product", {{"Multiplication", text("Matrix(*)")}}, {"[1 2]", "[3 4]"}); }, "produto de dois vetores"), "Product Matrix(*) de dois vetores 1-D recusado");
    check(failsWith([] { Fed f("product", {{"Inputs", text("*/")}, {"Multiplication", text("Matrix(*)")}}, {"1", "[3 4]"}); }, "inversa exige matriz quadrada"), "Product Matrix(*): inversa de vetor recusada");
    { Fed f("dot_product", {}, {"[1 2 3]", "[4 5 6]"}); check(f() == 32.0, "Dot Product = sum(u1.*u2)"); }
    check(failsWith([] { Fed f("dot_product", {}, {"[1 2 3]", "[4 5]"}); }, "mesma largura"), "Dot Product com larguras diferentes recusado");
    { Fed f("bias", {{"Bias", text("[1 -1]")}}, {"3"}); check(f(0) == 4.0 && f(1) == 2.0, "Bias vetorial"); }
}

void unaryFunctions() {
    { Fed f("abs", {}, {"[-2 0 3]"}); check(f(0) == 2.0 && f(1) == 0.0 && f(2) == 3.0, "Abs"); }
    { Fed f("sign", {}, {"[-2 0 3]"}); check(f(0) == -1.0 && f(1) == 0.0 && f(2) == 1.0, "Sign (0 em u = 0)"); }
    { Fed f("unary_minus", {}, {"[2 -3]"}); check(f(0) == -2.0 && f(1) == 3.0, "Unary Minus"); }
    { Fed f("sqrt", {}, {"[4 -1]"}); expectNear(f(0), 2.0, 0, "Sqrt"); expectNear(f(1), kNaN, 0, "Sqrt de negativo com saida real = NaN"); }
    { Fed f("sqrt", {{"Operator", text("signedSqrt")}}, {"-4"}); check(f() == -2.0, "Signed Sqrt"); }
    { Fed f("sqrt", {{"Operator", text("rSqrt")}}, {"4"}); check(f() == 0.5, "Reciprocal Sqrt"); }
    check(failsWith([] { Fed f("sqrt", {{"OutputSignalType", text("complex")}}, {"4"}); }, "complex"), "Sqrt com saida complexa recusado");
    const auto math = [](const char* op, std::vector<std::string> inputs, std::initializer_list<std::pair<const char*, PropertyValue>> extra = {}) {
        Harness h;
        lasecsimul::registry::ComponentParams params;
        params.properties["Operator"] = text(op);
        for (const auto& [name, value] : extra) params.properties[name] = value;
        const uint32_t block = h.session.addComponent("sl.math_function", params);
        for (size_t i = 0; i < inputs.size(); ++i) {
            const uint32_t source = h.add("constant", {{"Value", text(inputs[i])}});
            h.wire(source, "out1", block, ("in" + std::to_string(i + 1)).c_str());
        }
        h.runUntil(0.01);
        return h.value(block);
    };
    expectNear(math("exp", {"1"}), std::exp(1.0), 1e-15, "Math Function exp");
    expectNear(math("log", {"2"}), std::log(2.0), 1e-15, "Math Function log");
    expectNear(math("2^u", {"3"}), 8.0, 0, "Math Function 2^u");
    expectNear(math("10^u", {"2"}), 100.0, 1e-12, "Math Function 10^u");
    expectNear(math("log10", {"1000"}), 3.0, 1e-15, "Math Function log10");
    expectNear(math("magnitude^2", {"-3"}), 9.0, 0, "Math Function magnitude^2");
    expectNear(math("square", {"-3"}), 9.0, 0, "Math Function square");
    expectNear(math("reciprocal", {"4"}), 0.25, 0, "Math Function reciprocal");
    expectNear(math("conj", {"5"}), 5.0, 0, "Math Function conj (real)");
    expectNear(math("pow", {"-2", "2"}), -4.0, 0, "Math Function pow com Signed power (padrao): sign(u)*|u|^v");
    expectNear(math("pow", {"-2", "2"}, {{"SignedPower", PropertyValue{false}}}), 4.0, 0, "Math Function pow sem Signed power: u^v");
    expectNear(math("pow", {"-8", "1/3"}, {{"SignedPower", PropertyValue{false}}}), kNaN, 0, "pow sem sinal: base negativa, expoente fracionario = NaN");
    expectNear(math("pow", {"-8", "1/3"}), -2.0, 1e-12, "pow com sinal: -8^(1/3) = -2");
    expectNear(math("hypot", {"3", "4"}), 5.0, 0, "Math Function hypot");
    expectNear(math("rem", {"-7", "3"}), -1.0, 0, "rem(-7, 3) = -1 (sinal do dividendo)");
    expectNear(math("mod", {"-7", "3"}), 2.0, 0, "mod(-7, 3) = 2 (sinal do divisor)");
    expectNear(math("rem", {"5", "0"}), kNaN, 0, "rem(u, 0) = NaN");
    expectNear(math("mod", {"5", "0"}), 5.0, 0, "mod(u, 0) = u");
    check(failsWith([&] { math("exp", {"1"}, {{"OutputSignalType", text("complex")}}); }, "complex"), "Math Function com saida complexa recusada");

    const auto trig = [](std::initializer_list<std::pair<const char*, PropertyValue>> props, std::vector<std::string> inputs, const char* port = "out1") {
        Harness h;
        lasecsimul::registry::ComponentParams p;
        for (const auto& [name, value] : props) p.properties[name] = value;
        const uint32_t block = h.session.addComponent("sl.trigonometric_function", p);
        for (size_t i = 0; i < inputs.size(); ++i) {
            const uint32_t source = h.add("constant", {{"Value", text(inputs[i])}});
            h.wire(source, "out1", block, ("in" + std::to_string(i + 1)).c_str());
        }
        h.runUntil(0.01);
        return h.value(block, port);
    };
    expectNear(trig({}, {"0.5"}), std::sin(0.5), 1e-15, "Trigonometric sin");
    expectNear(trig({{"Operator", text("tan")}}, {"0.5"}), std::tan(0.5), 1e-15, "Trigonometric tan");
    expectNear(trig({{"Operator", text("asin")}}, {"2"}), kPi / 2, 1e-15, "asin com protecao (padrao): entrada saturada em 1");
    expectNear(trig({{"Operator", text("acos")}}, {"-3"}), kPi, 1e-15, "acos com protecao: entrada saturada em -1");
    expectNear(trig({{"Operator", text("asin")}, {"RemoveProtectionAgainstOutOfRangeInput", PropertyValue{true}}}, {"2"}), kNaN, 0, "asin sem protecao: NaN fora de [-1, 1]");
    expectNear(trig({{"Operator", text("atan2")}}, {"1", "-1"}), 3 * kPi / 4, 1e-15, "atan2(u1 = y, u2 = x) nos quatro quadrantes");
    expectNear(trig({{"Operator", text("sincos")}}, {"0.3"}, "out2"), std::cos(0.3), 1e-15, "sincos: cos na segunda saida");
    expectNear(trig({{"Operator", text("atanh")}}, {"0.5"}), std::atanh(0.5), 1e-15, "Trigonometric atanh");
    expectNear(trig({{"ApproximationMethod", text("Lookup")}, {"AngleUnit", text("revolution")}}, {"0.25"}), 1.0, 1e-15, "sin com Lookup em revolucoes: sin(0.25 rev) = 1");
    expectNear(trig({{"AngleUnit", text("revolution")}}, {"0.25"}), std::sin(0.25), 1e-15, "AngleUnit so vale com Lookup: sem ele o angulo e em radianos");
    expectNear(trig({{"Operator", text("atan2")}, {"ApproximationMethod", text("Lookup")}, {"AngleUnit", text("revolution")}}, {"1", "0"}), 0.25, 1e-15,
               "atan2 com Lookup em revolucoes: saida em revolucoes");
    check(failsWith([&] { trig({{"Operator", text("cos + jsin")}}, {"1"}); }, "cos + jsin"), "cos + jsin (saida complexa) recusado");

    { Fed f("rounding_function", {}, {"-2.5"}); check(f() == -3.0, "floor(-2.5) = -3"); }
    { Fed f("rounding_function", {{"Operator", text("ceil")}}, {"-2.5"}); check(f() == -2.0, "ceil(-2.5) = -2"); }
    { Fed f("rounding_function", {{"Operator", text("round")}}, {"[-2.5 2.5]"}); check(f(0) == -3.0 && f(1) == 3.0, "round: empate para longe do zero"); }
    { Fed f("rounding_function", {{"Operator", text("fix")}}, {"-2.7"}); check(f() == -2.0, "fix(-2.7) = -2"); }
    { Fed f("polynomial", {{"coefs", text("[1 2 3]")}}, {"[2 -1]"}); check(f(0) == 11.0 && f(1) == 2.0, "Polynomial: polyval([1 2 3], u)"); }
}

void minmaxBlocks() {
    { Fed f("minmax", {}, {"[3 -1 2]"}); check(f() == -1.0, "MinMax de uma entrada: min dos elementos"); }
    { Fed f("minmax", {{"Function", text("max")}, {"Inputs", text("3")}}, {"[1 5]", "4", "[2 0]"}); check(f(0) == 4.0 && f(1) == 5.0, "MinMax max de 3 entradas elemento a elemento"); }
    { Fed f("minmax", {{"Function", text("max")}, {"Inputs", text("2")}}, {"NaN", "3"}); check(f() == 3.0, "MinMax ignora NaN"); }
    { Fed f("minmax", {{"Inputs", text("2")}}, {"NaN", "NaN"}); expectNear(f(), kNaN, 0, "MinMax so de NaN = NaN"); }
    {
        Harness h; // u = [3 1 4 2 1 5] e R = [0 0 0 1 0 0], amostra de 1 s
        const uint32_t u = h.add("repeating_sequence_stair", {{"OutValues", text("[3 1 4 2 1 5]")}, {"tsamp", text("1")}});
        const uint32_t r = h.add("repeating_sequence_stair", {{"OutValues", text("[0 0 0 1 0 0]")}, {"tsamp", text("1")}});
        const uint32_t running = h.add("minmax_running_resettable", {{"vinit", text("10")}});
        const uint32_t peak = h.add("minmax_running_resettable", {{"Function", text("max")}});
        h.wire(u, "out1", running, "in1");
        h.wire(r, "out1", running, "in2");
        h.wire(u, "out1", peak, "in1");
        std::vector<double> mins, maxs;
        for (int k = 0; k < 6; ++k) { h.runUntil(k + 0.5); mins.push_back(h.value(running)); maxs.push_back(h.value(peak)); }
        expectSeries(mins, {3, 1, 1, 2, 1, 1}, 0.0, "MinMax Running Resettable min com vinit 10 e reset em k = 3");
        expectSeries(maxs, {3, 3, 4, 4, 4, 5}, 0.0, "MinMax Running Resettable max acumulado (vinit 0 participa)");
    }
}

void structuralBlocks() {
    {
        Harness h;
        const uint32_t input = h.add("constant", {{"Value", text("5")}, {"SampleTime", text("0.1")}});
        const auto wstm = [&](const char* op) {
            const uint32_t block = h.add("weighted_sample_time_math", {{"TsampMathOp", text(op)}, {"weightValue", text("2")}});
            h.wire(input, "out1", block, "in1");
            return block;
        };
        const uint32_t plus = wstm("+"), minus = wstm("-"), times = wstm("*"), divide = wstm("/"), only = wstm("Ts Only"), inverse = wstm("1/Ts Only");
        h.runUntil(0.05);
        check(std::abs(h.value(plus) - 5.2) < 1e-12 && std::abs(h.value(minus) - 4.8) < 1e-12 && std::abs(h.value(times) - 1.0) < 1e-12 &&
              std::abs(h.value(divide) - 25.0) < 1e-12 && std::abs(h.value(only) - 0.2) < 1e-15 && std::abs(h.value(inverse) - 5.0) < 1e-12,
              "Weighted Sample Time Math: u+Ts*w, u-Ts*w, u*Ts*w, u/(Ts*w), Ts*w, 1/(Ts*w) com Ts = 0.1, w = 2");
    }
    check(failsWith([] {
        Harness h;
        const uint32_t sine = h.add("sine_wave");
        const uint32_t block = h.add("weighted_sample_time_math");
        h.wire(sine, "out1", block, "in1");
        h.runUntil(0.01);
    }, "exige tempo de amostragem discreto"), "Weighted Sample Time Math com entrada continua recusado (sem Ts)");

    { Fed f("vector_concatenate", {}, {"1", "[2 3]"}); check(f(0) == 1.0 && f(1) == 2.0 && f(2) == 3.0, "Vector Concatenate [1 | 2 3]"); }
    { Fed f("matrix_concatenate", {}, {"1", "2"}); check(f(0) == 1.0 && f(1) == 2.0, "Matrix Concatenate (dim 2) de escalares = [u1 u2]"); }
    { Fed f("matrix_concatenate", {{"ConcatenateDimension", text("1")}}, {"[1 2]", "3"}); check(f(2) == 3.0, "Matrix Concatenate dim 1 empilha vetores"); }
    check(failsWith([] { Fed f("matrix_concatenate", {}, {"[1 2]", "3"}); }, "gera matriz"), "Matrix Concatenate dim 2 de vetores (gera matriz) recusado");

    const auto assignment = [](std::initializer_list<std::pair<const char*, PropertyValue>> props, std::vector<std::string> inputs) {
        Fed f("assignment", props, inputs);
        std::vector<double> values;
        for (uint16_t i = 0; i < 4; ++i) values.push_back(f(i));
        return values;
    };
    expectSeries(assignment({{"IndexParamArray", text("[2 4]")}}, {"[1 2 3 4]", "[9 8]"}), {1, 9, 3, 8}, 0.0, "Assignment Y(idx) = U (indices 1-based)");
    expectSeries(assignment({{"IndexParamArray", text("[0 1]")}, {"IndexMode", text("Zero-based")}}, {"[1 2 3 4]", "[9 8]"}), {9, 8, 3, 4}, 0.0, "Assignment 0-based");
    expectSeries(assignment({{"IndexOptionArray", text("Starting index (dialog)")}, {"IndexParamArray", text("2")}}, {"[1 2 3 4]", "[9 8]"}), {1, 9, 8, 4}, 0.0, "Assignment Starting index");
    expectSeries(assignment({{"IndexOptionArray", text("Assign all")}}, {"[1 2 3 4]", "7"}), {7, 7, 7, 7}, 0.0, "Assignment Assign all com U escalar");
    expectSeries(assignment({{"IndexOptionArray", text("Index vector (port)")}}, {"[1 2 3 4]", "[9 8]", "[3 1]"}), {8, 2, 9, 4}, 0.0, "Assignment indices pela porta Idx1");
    {
        Fed f("assignment", {{"IndexOptionArray", text("Starting index (port)")}, {"OutputInitialize", text("Specify size for each dimension in table")},
                             {"OutputSizeArray", text("3")}}, {"[5 6]", "2"});
        check(f(0) == 0.0 && f(1) == 5.0 && f(2) == 6.0, "Assignment sem Y0 (tamanho na tabela, demais elementos 0)");
    }
    check(failsWith([] { Fed f("assignment", {{"IndexParamArray", text("5")}}, {"[1 2 3 4]", "9"}); }, "faixa fora do vetor"), "Assignment com indice fora da faixa recusado");

    { Fed f("reshape", {}, {"[1 2 3]"}); check(f(2) == 3.0, "Reshape 1-D: mesmos elementos"); }
    { Fed f("reshape", {{"OutputDimensionality", text("Customize")}, {"OutputDimensions", text("[3 1]")}}, {"[1 2 3]"}); check(f(1) == 2.0, "Reshape Customize [3 1]"); }
    check(failsWith([] { Fed f("reshape", {{"OutputDimensionality", text("Customize")}, {"OutputDimensions", text("[2 2]")}}, {"[1 2 3]"}); }, "elementos para entrada de largura"), "Reshape com numero de elementos diferente recusado");
    check(failsWith([] { Fed f("reshape", {{"OutputDimensionality", text("Derive from reference input port")}}, {"[1 2 3]", "[1 2]"}); }, "difere da de Ref"), "Reshape: Ref com outra largura recusado");
}

/** Os blocos que a migracao dos `control.*` gera (docs/68), com as propriedades que ela escreve. */
void migrationShapes() {
    Harness h;
    const uint32_t constant = h.add("constant", {{"Value", text("3")}, {"SampleTime", text("inf")}});
    const uint32_t gain = h.add("gain", {{"Gain", text("2")}, {"SampleTime", text("0.01")}});
    const uint32_t sum = h.add("sum", {{"IconShape", text("rectangular")}, {"Inputs", text("+-")}, {"SampleTime", text("0.01")}});
    const uint32_t product = h.add("product", {{"Inputs", text("*/")}, {"SampleTime", text("0.01")}});
    const uint32_t bias = h.add("bias", {{"Bias", text("1.5")}});
    const uint32_t display = h.add("display");
    h.wire(constant, "out1", gain, "in1");
    h.wire(gain, "out1", sum, "in1");
    h.wire(constant, "out1", sum, "in2");
    h.wire(sum, "out1", product, "in1");
    h.wire(constant, "out1", product, "in2");
    h.wire(product, "out1", bias, "in1");
    h.wire(bias, "out1", display, "in1");
    h.runUntil(0.05);
    check(h.value(display, "in1") == 2.5, "cadeia gerada pela migracao: ((2*3 - 3)/3) + 1.5 = 2.5");
}

} // namespace

int main() {
    const std::pair<const char*, std::function<void()>> cases[] = {
        {"constantBlock", constantBlock}, {"stepBlock", stepBlock}, {"rampBlock", rampBlock}, {"sineBlocks", sineBlocks},
        {"clockBlocks", clockBlocks}, {"pulseGenerator", pulseGenerator}, {"signalGenerator", signalGenerator},
        {"repeatingSequences", repeatingSequences}, {"chirpSignal", chirpSignal}, {"randomSources", randomSources}, {"counters", counters},
        {"sinks", sinks}, {"gainBlocks", gainBlocks}, {"sumProduct", sumProduct}, {"unaryFunctions", unaryFunctions},
        {"minmaxBlocks", minmaxBlocks}, {"structuralBlocks", structuralBlocks}, {"migrationShapes", migrationShapes},
    };
    for (const auto& [name, test] : cases) {
        try { test(); } catch (const std::exception& error) { check(false, std::string(name) + " lancou: " + error.what()); }
    }
    return finish("library_sources_math");
}
