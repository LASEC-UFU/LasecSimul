// Infraestrutura de kernels da biblioteca equivalente ao Simulink (docs/66 §4): partição contínua
// acoplada, ordem global entre taxas, estados discretos, breakpoints, parâmetros ajustáveis e
// vetores. As referências são soluções analíticas, nunca o próprio engine.
#include <cmath>
#include <cstdio>
#include <stdexcept>
#include <string>

#include "simulation/SignalEngine.hpp"

using namespace lasecsimul::simulation;

namespace {
int failures = 0;
#define CHECK(expr, message) do { if (!(expr)) { std::fprintf(stderr, "FALHOU: %s -- %s\n", std::string(message).c_str(), #expr); ++failures; } } while (false)

constexpr SignalRate kContinuous{0, 0, 0};
constexpr uint64_t kMs = 1'000'000ull;

SignalBlockDefinition kernel(std::string id, std::string kernelId, std::vector<uint16_t> inputWidths, uint16_t outWidth,
                             std::vector<double> rp, std::vector<int64_t> ip = {}, SignalRate rate = kContinuous) {
    SignalBlockDefinition block;
    block.id = std::move(id);
    block.kind = SignalBlockKind::Kernel;
    block.kernel = std::move(kernelId);
    for (size_t i = 0; i < inputWidths.size(); ++i) block.inputs.push_back({"in" + std::to_string(i + 1), {SignalScalarType::Real, inputWidths[i]}, ""});
    block.output = {"out", {SignalScalarType::Real, outWidth}, ""};
    block.realParameters = std::move(rp);
    block.intParameters = std::move(ip);
    block.rate = rate;
    return block;
}

void wire(SignalGraphDefinition& graph, const std::string& from, const std::string& to, int port = 1) {
    graph.connections.push_back({from, "out", to, "in" + std::to_string(port), false});
}

/** State-space SISO de primeira ordem K/(tau s + 1) (forma do kernel: A, B, C, D, x0). */
SignalBlockDefinition firstOrder(std::string id, double gain, double tau) {
    return kernel(std::move(id), "state_space", {1}, 1, {-1.0 / tau, 1.0 / tau, gain, 0.0, 0.0}, {1, 1, 1});
}

/** Integrador simples: ip = [n, limit, reset, icExternal, wrap, showSat, showState]. */
SignalBlockDefinition integrator(std::string id, double ic = 0.0) {
    return kernel(std::move(id), "integrator", {1}, 1, {ic, INFINITY, -INFINITY, 3.14159265358979323846, -3.14159265358979323846}, {1, 0, 0, 0, 0, 0, 0});
}

struct Runner {
    SignalRuntime runtime;
    uint64_t now = 0;
    explicit Runner(const SignalGraphDefinition& graph) {
        runtime.bind(SignalCompiler::compile(graph));
        runtime.executeUntil(0);
    }
    /** Passos fixos de `stepNs`, sempre acertando breakpoints (como o Scheduler faz). */
    void advance(uint64_t untilNs, uint64_t stepNs) {
        while (now < untilNs) {
            uint64_t next = std::min(untilNs, now + stepNs);
            if (const auto event = runtime.nextEventNs(); event && *event > now) next = std::min(next, *event);
            runtime.beginContinuousStep(now, next);
            (void)runtime.continuousErrorRatio(1e-12, 1e-9);
            runtime.commitContinuousStep();
            now = next;
            runtime.executeUntil(now);
        }
    }
    double value(const std::string& id, uint16_t element = 0) const { return runtime.real(runtime.output(id), element); }
};

void coupledChainMatchesAnalyticSolution() {
    // 1 -> 1/(s+1) -> 1/(s+1): y = 1 - e^-t - t e^-t. Com entrada segurada por bloco (o caminho antigo)
    // o erro seria O(h); acoplado ele é o do RK4.
    SignalGraphDefinition graph;
    graph.blocks = {kernel("u", "constant", {}, 1, {1.0}), firstOrder("g1", 1.0, 1.0), firstOrder("g2", 1.0, 1.0)};
    wire(graph, "u", "g1"); wire(graph, "g1", "g2");
    Runner run(graph);
    run.advance(2000 * kMs, 10 * kMs);
    const double t = 2.0, expected = 1.0 - std::exp(-t) - t * std::exp(-t);
    CHECK(std::abs(run.value("g2") - expected) < 1e-8, "cadeia continua acoplada: erro " + std::to_string(run.value("g2") - expected));
}

void sineSourceIsEvaluatedAtStageTimes() {
    // Sine Wave contínua -> Integrator: y = 1 - cos(t) (fonte reavaliada nos estágios do RK4).
    SignalGraphDefinition graph;
    graph.blocks = {kernel("sine", "sine_wave", {}, 1, {1.0, 0.0, 1.0, 0.0}, {0, 1}), integrator("int")};
    wire(graph, "sine", "int");
    Runner run(graph);
    run.advance(3000 * kMs, 20 * kMs);
    CHECK(std::abs(run.value("int") - (1.0 - std::cos(3.0))) < 1e-8, "seno integrado nos estagios: " + std::to_string(run.value("int")));
}

void continuousClosedLoop() {
    // r = 1, y' = K (r - y): Sum(+-) e Gain com feedthrough, Integrator sem -> sem laço algébrico.
    SignalGraphDefinition graph;
    graph.blocks = {kernel("r", "constant", {}, 1, {1.0}), kernel("e", "sum", {1, 1}, 1, {1.0, -1.0}, {0}),
                    kernel("k", "gain", {1}, 1, {3.0}, {0, 1, 1}), integrator("y")};
    wire(graph, "r", "e", 1); wire(graph, "y", "e", 2); wire(graph, "e", "k"); wire(graph, "k", "y");
    Runner run(graph);
    run.advance(1000 * kMs, 10 * kMs);
    CHECK(std::abs(run.value("y") - (1.0 - std::exp(-3.0))) < 1e-8, "malha fechada continua: " + std::to_string(run.value("y")));
}

void stepBreakpointIsHitExactly() {
    // Step em t = 0.37 s -> Integrator: y(1) = 1 - 0.37 exatamente (o passo acerta o instante).
    SignalGraphDefinition graph;
    graph.blocks = {kernel("step", "step", {}, 1, {0.37, 0.0, 1.0}, {1, 370 * static_cast<int64_t>(kMs)}), integrator("y")};
    wire(graph, "step", "y");
    Runner run(graph);
    run.advance(1000 * kMs, 100 * kMs);
    CHECK(std::abs(run.value("y") - 0.63) < 1e-12, "degrau no breakpoint: " + std::to_string(run.value("y")));
}

void discreteInputToContinuousIsZeroOrderHold() {
    // Unit Delay discreto de 100 ms alimentado por Clock discreto: entrada em escada exata no integrador.
    SignalGraphDefinition graph;
    const SignalRate ts{100 * kMs, 0, 0};
    graph.blocks = {kernel("clock", "clock", {}, 1, {}, {}, ts), integrator("y")};
    wire(graph, "clock", "y");
    Runner run(graph);
    run.advance(1000 * kMs, 7 * kMs);
    // integral de uma escada k*0.1 em [0.1k, 0.1(k+1)): soma 0.1 * 0.1 * (0 + 1 + ... + 9) = 0.45
    CHECK(std::abs(run.value("y") - 0.45) < 1e-12, "entrada discreta segurada (ZOH) no integrador: " + std::to_string(run.value("y")));
}

void discreteBlocksAndGlobalOrder() {
    const SignalRate fast{10 * kMs, 0, 0}, slow{50 * kMs, 0, 0};
    SignalGraphDefinition graph;
    // Fonte LENTA alimenta Unit Delay RÁPIDO: no mesmo instante a fonte executa antes (ordem global).
    graph.blocks = {kernel("slowClock", "clock", {}, 1, {}, {}, slow), kernel("z", "unit_delay", {1}, 1, {-1.0}, {}, fast),
                    kernel("d3", "delay", {1}, 1, {7.0}, {3}, fast)};
    wire(graph, "slowClock", "z"); wire(graph, "slowClock", "d3");
    Runner run(graph);
    CHECK(run.value("z") == -1.0, "Unit Delay publica a condicao inicial em t = 0");
    run.advance(10 * kMs, 10 * kMs);
    CHECK(run.value("z") == 0.0, "Unit Delay em t = 10 ms ve a fonte lenta de t = 0 (ordem global)");
    run.advance(60 * kMs, 10 * kMs);
    CHECK(std::abs(run.value("z") - 0.05) < 1e-15, "Unit Delay em t = 60 ms ve a amostra de 50 ms");
    CHECK(std::abs(run.value("d3") - 0.0) < 1e-15, "Delay de 3 amostras: em 60 ms devolve u(30 ms) = 0");
    run.advance(80 * kMs, 10 * kMs);
    CHECK(std::abs(run.value("d3") - 0.05) < 1e-15, "Delay de 3 amostras: em 80 ms devolve u(50 ms)");

    SignalGraphDefinition ss;
    // x[k+1] = 0.5 x[k] + u, y = x: com u = 1 -> 0, 1, 1.5, 1.75.
    ss.blocks = {kernel("u", "constant", {}, 1, {1.0}, {}, fast), kernel("p", "discrete_state_space", {1}, 1, {0.5, 1.0, 1.0, 0.0, 0.0}, {1, 1, 1}, fast)};
    wire(ss, "u", "p");
    Runner digital(ss);
    const double expected[] = {0.0, 1.0, 1.5, 1.75};
    for (int k = 0; k < 4; ++k) {
        CHECK(std::abs(digital.value("p") - expected[k]) < 1e-15, "Discrete State-Space amostra " + std::to_string(k));
        digital.advance((k + 1) * 10 * kMs, 10 * kMs);
    }
}

void transportDelayIsExactForDiscreteAndInterpolatesContinuous() {
    const SignalRate ts{100 * kMs, 0, 0};
    SignalGraphDefinition graph;
    // Entrada discreta (Clock de 100 ms) atrasada 0.25 s: y(t) = clock(t - 0.25) EXATO (sem rampa).
    graph.blocks = {kernel("clock", "clock", {}, 1, {}, {}, ts),
                    kernel("dly", "transport_delay", {1}, 1, {0.25, -5.0}, {1, 4096, 250 * static_cast<int64_t>(kMs)}),
                    kernel("sine", "sine_wave", {}, 1, {1.0, 0.0, 2.0, 0.0}, {0, 1}),
                    kernel("dsin", "transport_delay", {1}, 1, {0.1, 0.0}, {1, 4096, 100 * static_cast<int64_t>(kMs)})};
    wire(graph, "clock", "dly"); wire(graph, "sine", "dsin");
    Runner run(graph);
    run.advance(200 * kMs, 1 * kMs);
    CHECK(run.value("dly") == -5.0, "Initial output antes do atraso");
    run.advance(400 * kMs, 1 * kMs);
    CHECK(std::abs(run.value("dly") - 0.1) < 1e-15, "entrada discreta atrasada sem interpolacao: " + std::to_string(run.value("dly")));
    run.advance(455 * kMs, 1 * kMs);
    CHECK(std::abs(run.value("dly") - 0.2) < 1e-15, "degrau discreto atravessa o atraso no instante exato");
    run.advance(1000 * kMs, 1 * kMs);
    CHECK(std::abs(run.value("dsin") - std::sin(2.0 * 0.9)) < 1e-6, "seno atrasado por interpolacao: " + std::to_string(run.value("dsin")));
}

void tunableParametersChangeWithoutRecompiling() {
    const SignalRate ts{10 * kMs, 0, 0};
    SignalGraphDefinition graph;
    graph.blocks = {kernel("c", "constant", {}, 1, {2.0}, {}, ts), kernel("k", "gain", {1}, 1, {3.0}, {0, 1, 1}, ts)};
    wire(graph, "c", "k");
    Runner run(graph);
    CHECK(run.value("k") == 6.0, "Gain inicial");
    const double gain[] = {5.0};
    run.runtime.setKernelParameters("k", gain);
    run.advance(10 * kMs, 10 * kMs);
    CHECK(run.value("k") == 10.0, "Gain ajustado em execucao vale na proxima amostra");
    bool rejected = false;
    const double wrongShape[] = {1.0, 2.0};
    try { run.runtime.setKernelParameters("k", wrongShape); } catch (const std::invalid_argument&) { rejected = true; }
    CHECK(rejected, "mudanca de tamanho exige recompilacao");

    SignalGraphDefinition constantTime;
    const SignalRate inf{kConstantSamplePeriodNs, 0, 0};
    constantTime.blocks = {kernel("c", "constant", {}, 1, {2.0}, {}, inf), kernel("k", "gain", {1}, 1, {3.0}, {0, 1, 1}, inf)};
    wire(constantTime, "c", "k");
    Runner constant(constantTime);
    CHECK(constant.value("k") == 6.0, "bloco de tempo constante executa em t = 0");
    const double newValue[] = {4.0};
    constant.runtime.setKernelParameters("c", newValue);
    constant.advance(5 * kMs, 5 * kMs);
    CHECK(constant.value("k") == 12.0, "tempo constante reavalia quando parametro ajustavel muda");
}

void vectorsMuxGainSlice() {
    const SignalRate ts{10 * kMs, 0, 0};
    SignalGraphDefinition graph;
    graph.blocks = {kernel("a", "constant", {}, 1, {1.0}, {}, ts), kernel("b", "constant", {}, 2, {2.0, 3.0}, {}, ts),
                    kernel("mux", "concat", {1, 2}, 3, {}, {}, ts), kernel("k", "gain", {3}, 3, {10.0, 20.0, 30.0}, {0, 1, 3}, ts),
                    kernel("sum", "sum", {3}, 1, {1.0}, {1}, ts), kernel("second", "slice", {3}, 1, {}, {1}, ts),
                    kernel("m", "gain", {3}, 2, {1, 0, 0, 0, 1, 1}, {1, 2, 3}, ts)};
    wire(graph, "a", "mux", 1); wire(graph, "b", "mux", 2); wire(graph, "mux", "k"); wire(graph, "k", "sum");
    wire(graph, "k", "second"); wire(graph, "mux", "m");
    Runner run(graph);
    CHECK(run.value("k", 0) == 10.0 && run.value("k", 1) == 40.0 && run.value("k", 2) == 90.0, "Gain elemento a elemento em vetor");
    CHECK(run.value("sum") == 140.0, "Sum de uma entrada soma os elementos");
    CHECK(run.value("second") == 40.0, "Slice extrai o elemento");
    CHECK(run.value("m", 0) == 1.0 && run.value("m", 1) == 5.0, "Gain matricial K*u");
}

void configurationErrorsNameTheBlock() {
    SignalGraphDefinition graph;
    graph.blocks = {kernel("c", "constant", {}, 1, {1.0}), integrator("bad")};
    graph.blocks[1].rate = {10 * kMs, 0, 0};
    wire(graph, "c", "bad");
    bool rejected = false;
    try { (void)SignalCompiler::compile(graph); } catch (const std::invalid_argument& error) {
        rejected = std::string(error.what()).find("bad") != std::string::npos;
    }
    CHECK(rejected, "estado continuo em taxa discreta e recusado citando o bloco");

    SignalGraphDefinition unknown;
    unknown.blocks = {kernel("x", "nao_existe", {}, 1, {})};
    rejected = false;
    try { (void)SignalCompiler::compile(unknown); } catch (const std::invalid_argument&) { rejected = true; }
    CHECK(rejected, "kernel desconhecido e recusado");

    SignalGraphDefinition badParams;
    badParams.blocks = {kernel("c", "constant", {}, 1, {1.0}), kernel("k", "gain", {1}, 1, {1.0, 2.0}, {0, 1, 2})};
    wire(badParams, "c", "k");
    rejected = false;
    try { (void)SignalCompiler::compile(badParams); } catch (const std::invalid_argument& error) {
        rejected = std::string(error.what()).find("[k]") != std::string::npos;
    }
    CHECK(rejected, "erro de configuracao do kernel cita o id do bloco");
}

void integratorLimitsAndReset() {
    // Integrator limitado em [0, 0.5] com u = 1: satura em t = 0.5 e não acumula (anti-windup).
    SignalGraphDefinition graph;
    graph.blocks = {kernel("one", "constant", {}, 1, {1.0}),
                    kernel("lim", "integrator", {1}, 2, {0.0, 0.5, 0.0, 0.0, 0.0}, {1, 1, 0, 0, 0, 1, 0}),
                    kernel("minus", "constant", {}, 1, {-1.0}),
                    kernel("back", "integrator", {1}, 1, {0.5, 0.5, 0.0, 0.0, 0.0}, {1, 1, 0, 0, 0, 0, 0})};
    wire(graph, "one", "lim"); wire(graph, "minus", "back");
    Runner run(graph);
    run.advance(2000 * kMs, 10 * kMs);
    CHECK(std::abs(run.value("lim") - 0.5) < 1e-12, "Integrator limitado para no limite superior");
    CHECK(run.value("lim", 1) == 1.0, "porta de saturacao indica limite superior");
    CHECK(std::abs(run.value("back")) < 1e-12, "Integrator limitado para no limite inferior");

    // Reset rising: pulso em t = 0.5 (Step 0 -> 1) zera o integrador de u = 1.
    SignalGraphDefinition reset;
    reset.blocks = {kernel("one", "constant", {}, 1, {1.0}), kernel("pulse", "step", {}, 1, {0.5, 0.0, 1.0}, {1, 500 * static_cast<int64_t>(kMs)}),
                    kernel("int", "integrator", {1, 1}, 1, {0.0, INFINITY, -INFINITY, 0.0, 0.0}, {1, 0, 1, 0, 0, 0, 0})};
    wire(reset, "one", "int", 1); wire(reset, "pulse", "int", 2);
    Runner resetRun(reset);
    resetRun.advance(1000 * kMs, 10 * kMs);
    CHECK(std::abs(resetRun.value("int") - 0.5) < 1e-9, "reset na borda de subida em t = 0.5: " + std::to_string(resetRun.value("int")));
}

} // namespace

int main() {
    coupledChainMatchesAnalyticSolution();
    sineSourceIsEvaluatedAtStageTimes();
    continuousClosedLoop();
    stepBreakpointIsHitExactly();
    discreteInputToContinuousIsZeroOrderHold();
    discreteBlocksAndGlobalOrder();
    transportDelayIsExactForDiscreteAndInterpolatesContinuous();
    tunableParametersChangeWithoutRecompiling();
    vectorsMuxGainSlice();
    configurationErrorsNameTheBlock();
    integratorLimitsAndReset();
    if (failures == 0) std::puts("KernelEngineTest: OK");
    return failures == 0 ? 0 : 1;
}
