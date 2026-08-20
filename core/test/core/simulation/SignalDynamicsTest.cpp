#include <cmath>
#include <cstdio>
#include <stdexcept>

#include "simulation/SignalEngine.hpp"

using namespace lasecsimul::simulation;

namespace {
int failures = 0;
#define CHECK(expr, message) do { if (!(expr)) { std::fprintf(stderr, "FALHOU: %s -- %s\n", message, #expr); ++failures; } } while (false)

constexpr SignalRate slowRate{10'000'000'000ull, 0, 0};

SignalPortDefinition realPort(std::string id) { return {std::move(id), {SignalScalarType::Real, 1}, ""}; }

SignalBlockDefinition source(std::string id, double value) {
    SignalBlockDefinition block;
    block.id = std::move(id); block.kind = SignalBlockKind::Source; block.realParameters = {value}; block.rate = slowRate;
    return block;
}

SignalBlockDefinition unary(std::string id, SignalBlockKind kind, std::vector<double> parameters) {
    SignalBlockDefinition block;
    block.id = std::move(id); block.kind = kind; block.inputs = {realPort("in")};
    block.realParameters = std::move(parameters); block.rate = slowRate;
    return block;
}

void connect(SignalGraphDefinition& graph, std::string from, std::string to, std::string port = "in") {
    graph.connections.push_back({std::move(from), "out", std::move(to), std::move(port), false});
}

void acceptedStep(SignalRuntime& runtime, uint64_t& now, uint64_t stepNs,
                  double absoluteTolerance = 1e-10, double relativeTolerance = 1e-6) {
    runtime.beginContinuousStep(now, now + stepNs);
    const double error = runtime.continuousErrorRatio(absoluteTolerance, relativeTolerance);
    if (error > 1.0) {
        std::fprintf(stderr, "passo inesperadamente rejeitavel: error=%g dt=%llu\n", error,
                     static_cast<unsigned long long>(stepNs));
        ++failures;
    }
    runtime.commitContinuousStep();
    now += stepNs;
    runtime.executeUntil(now);
}

SignalRuntime runtimeFor(const SignalGraphDefinition& graph) {
    SignalRuntime runtime;
    runtime.bind(SignalCompiler::compile(graph));
    runtime.executeUntil(0);
    return runtime;
}

void firstOrderAndFopdtMatchGoldens() {
    SignalGraphDefinition firstOrder;
    firstOrder.blocks = {source("step", 1.0), unary("plant", SignalBlockKind::FirstOrder, {1.0, 1.0, 0.0})};
    connect(firstOrder, "step", "plant");
    SignalRuntime runtime = runtimeFor(firstOrder);
    const void* dynamicStorage = runtime.dynamicStorageAddress();
    uint64_t now = 0;
    for (int i = 0; i < 100; ++i) acceptedStep(runtime, now, 10'000'000);
    CHECK(std::abs(runtime.real(runtime.output("plant")) - (1.0 - std::exp(-1.0))) < 1e-8,
          "FirstOrder segue golden analitico");
    CHECK(dynamicStorage == runtime.dynamicStorageAddress(), "estado dinamico nao realoca no steady state");

    SignalGraphDefinition fopdt;
    auto delayed = unary("plant", SignalBlockKind::Fopdt, {1.0, 0.5, 0.2, 0.0});
    delayed.historyCapacity = 64;
    fopdt.blocks = {source("step", 1.0), delayed}; connect(fopdt, "step", "plant");
    runtime = runtimeFor(fopdt); now = 0;
    CHECK(runtime.nextEventNs() == std::optional<uint64_t>(200'000'000), "FOPDT agenda descontinuidade exata");
    for (int i = 0; i < 100; ++i) acceptedStep(runtime, now, 10'000'000);
    const double expected = 1.0 - std::exp(-0.8 / 0.5);
    CHECK(std::abs(runtime.real(runtime.output("plant")) - expected) < 2e-3, "FOPDT respeita atraso e golden");
}

void adaptiveCandidateRollsBackAndConverges() {
    SignalGraphDefinition graph;
    graph.blocks = {source("step", 1.0), unary("fast", SignalBlockKind::FirstOrder, {1.0, 0.01, 0.0})};
    connect(graph, "step", "fast");
    SignalRuntime runtime = runtimeFor(graph);
    runtime.beginContinuousStep(0, 100'000'000);
    const double coarseError = runtime.continuousErrorRatio(1e-12, 1e-8);
    CHECK(coarseError > 1.0, "passo grosseiro reporta erro observavel");
    runtime.rollbackContinuousStep();
    CHECK(runtime.real(runtime.output("fast")) == 0.0 && runtime.metrics().rejectedDynamicSteps == 1,
          "rollback nao publica estado candidato");
    uint64_t now = 0;
    for (int i = 0; i < 100; ++i) acceptedStep(runtime, now, 100'000, 1e-12, 1e-7);
    const double fine = runtime.real(runtime.output("fast"));

    SignalRuntime finer = runtimeFor(graph); uint64_t fineNow = 0;
    for (int i = 0; i < 200; ++i) acceptedStep(finer, fineNow, 50'000, 1e-12, 1e-7);
    CHECK(std::abs(fine - finer.real(finer.output("fast"))) < 1e-10,
          "solucao converge ao reduzir o timestep");
    CHECK(runtime.real(runtime.output("fast")) == fine,
          "duas instancias do mesmo plano mantem estados dinamicos isolados");
}

void invalidDynamicParametersFailDuringCompilation() {
    SignalGraphDefinition graph;
    graph.blocks = {source("step", 1.0), unary("invalid", SignalBlockKind::FirstOrder, {1.0, 0.0, 0.0})};
    connect(graph, "step", "invalid");
    bool rejected = false;
    try { (void)SignalCompiler::compile(graph); } catch (const std::invalid_argument&) { rejected = true; }
    CHECK(rejected, "constante de tempo invalida falha no cold path");

    auto delay = unary("delay", SignalBlockKind::DeadTime, {1.0, 0.0});
    delay.historyCapacity = 1;
    graph.blocks = {source("step", 1.0), delay}; graph.connections.clear(); connect(graph, "step", "delay");
    rejected = false;
    try { (void)SignalCompiler::compile(graph); } catch (const std::invalid_argument&) { rejected = true; }
    CHECK(rejected, "buffer de atraso sem capacidade falha no cold path");
}

void discreteAndNonlinearPrimitivesAreIsolated() {
    SignalGraphDefinition graph;
    SignalBlockDefinition delay = unary("z1", SignalBlockKind::UnitDelay, {-1.0});
    SignalBlockDefinition valve = unary("valve", SignalBlockKind::ValveCharacteristic, {2.0, 2.0});
    SignalBlockDefinition saturation = unary("sat", SignalBlockKind::Saturation, {0.0, 10.0});
    SignalBlockDefinition deadband = unary("deadband", SignalBlockKind::Deadband, {2.0});
    SignalBlockDefinition hysteresis = unary("hyst", SignalBlockKind::Hysteresis, {2.0, 4.0, 0.0, 1.0, 0.0});
    SignalBlockDefinition stiction = unary("stick", SignalBlockKind::Stiction, {1.0, 0.25, 0.0});
    graph.blocks = {source("input", 3.0), delay, valve, saturation, deadband, hysteresis, stiction};
    connect(graph, "input", "z1"); connect(graph, "input", "valve"); connect(graph, "valve", "sat");
    connect(graph, "input", "deadband"); connect(graph, "input", "hyst"); connect(graph, "input", "stick");
    SignalRuntime runtime = runtimeFor(graph);
    CHECK(runtime.real(runtime.output("z1")) == -1.0, "UnitDelay publica valor anterior");
    CHECK(runtime.real(runtime.output("valve")) == 18.0, "ValveCharacteristic executa isolada");
    CHECK(runtime.real(runtime.output("sat")) == 10.0, "Saturation executa isolada");
    CHECK(runtime.real(runtime.output("deadband")) == 2.0, "Deadband executa isolada");
    CHECK(runtime.real(runtime.output("hyst")) == 0.0, "Hysteresis mantem estado dentro da banda");
    CHECK(runtime.real(runtime.output("stick")) == 2.75, "Stiction aplica breakaway/slip");
    runtime.executeUntil(10'000'000'000ull);
    CHECK(runtime.real(runtime.output("z1")) == 3.0, "UnitDelay atualiza na ativacao seguinte");
}

void remainingContinuousPrimitivesAndChainExecute() {
    SignalGraphDefinition graph;
    SignalBlockDefinition tank;
    tank.id = "tank"; tank.kind = SignalBlockKind::Tank;
    tank.inputs = {realPort("inflow"), realPort("outflow")}; tank.realParameters = {2.0, 0.0}; tank.rate = slowRate;
    graph.blocks = {
        source("step", 2.0), source("outflow", 0.0),
        unary("integrator", SignalBlockKind::Integrator, {1.0, 0.0}),
        unary("derivative", SignalBlockKind::FilteredDerivative, {1.0, 0.1, 0.0}),
        unary("second", SignalBlockKind::SecondOrder, {1.0, 5.0, 0.7, 0.0, 0.0}),
        unary("leadlag", SignalBlockKind::LeadLag, {1.0, 0.05, 0.2, 0.0}),
        unary("limiter", SignalBlockKind::RateLimiter, {1.0, 1.0, 0.0}), tank,
        unary("deadtime", SignalBlockKind::DeadTime, {0.05, 0.0}),
        unary("final", SignalBlockKind::Saturation, {0.0, 100.0}),
    };
    connect(graph, "step", "integrator"); connect(graph, "step", "derivative");
    connect(graph, "step", "second"); connect(graph, "second", "leadlag");
    connect(graph, "leadlag", "limiter"); connect(graph, "step", "tank", "inflow");
    connect(graph, "outflow", "tank", "outflow"); connect(graph, "limiter", "deadtime");
    connect(graph, "deadtime", "final");
    SignalRuntime runtime = runtimeFor(graph); uint64_t now = 0;
    for (int i = 0; i < 100; ++i) acceptedStep(runtime, now, 1'000'000, 1e-9, 1e-4);
    CHECK(std::abs(runtime.real(runtime.output("integrator")) - 0.2) < 1e-12, "Integrator executa");
    CHECK(runtime.real(runtime.output("derivative")) > 0.0, "FilteredDerivative executa");
    CHECK(runtime.real(runtime.output("second")) > 0.0, "SecondOrder executa");
    CHECK(runtime.real(runtime.output("leadlag")) > 0.0, "LeadLag executa");
    CHECK(runtime.real(runtime.output("limiter")) > 0.0 && runtime.real(runtime.output("limiter")) <= 0.1 + 1e-12,
          "RateLimiter respeita a taxa de subida");
    CHECK(std::abs(runtime.real(runtime.output("tank")) - 0.1) < 1e-12, "Tank executa");
    CHECK(runtime.real(runtime.output("final")) >= 0.0 && std::isfinite(runtime.real(runtime.output("final"))),
          "cadeia completa produz saida finita e limitada");
}
} // namespace

int main() {
    firstOrderAndFopdtMatchGoldens();
    adaptiveCandidateRollsBackAndConverges();
    invalidDynamicParametersFailDuringCompilation();
    discreteAndNonlinearPrimitivesAreIsolated();
    remainingContinuousPrimitivesAndChainExecute();
    if (failures == 0) std::puts("SignalDynamicsTest: OK");
    return failures == 0 ? 0 : 1;
}
