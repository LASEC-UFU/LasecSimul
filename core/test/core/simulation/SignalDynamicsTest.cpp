#include <cmath>
#include <cstdio>
#include <limits>
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

SignalBlockDefinition element(std::string id, uint16_t index) {
    SignalBlockDefinition block;
    block.id = std::move(id); block.kind = SignalBlockKind::Element;
    block.inputs = {{"in", {SignalScalarType::Real, AccumulatorWidth}, ""}};
    block.realParameters = {static_cast<double>(index)}; block.rate = slowRate;
    return block;
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
    tank.id = "tank::acc"; tank.kind = SignalBlockKind::Accumulator;
    tank.inputs = {realPort("in"), realPort("outflow")};
    tank.output = {"out", {SignalScalarType::Real, AccumulatorWidth}, ""};
    tank.realParameters = {0.0, 0.0, std::numeric_limits<double>::infinity(), 0.0, 0.0}; tank.rate = slowRate;
    SignalBlockDefinition level = element("tank", AccumulatorState);
    graph.blocks = {
        source("step", 2.0), source("outflow", 0.0),
        unary("integrator", SignalBlockKind::Integrator, {1.0, 0.0}),
        unary("derivative", SignalBlockKind::FilteredDerivative, {1.0, 0.1, 0.0}),
        unary("second", SignalBlockKind::SecondOrder, {1.0, 5.0, 0.7, 0.0, 0.0}),
        unary("leadlag", SignalBlockKind::LeadLag, {1.0, 0.05, 0.2, 0.0}),
        unary("limiter", SignalBlockKind::RateLimiter, {1.0, 1.0, 0.0}), tank, level,
        unary("deadtime", SignalBlockKind::DeadTime, {0.05, 0.0}),
        unary("final", SignalBlockKind::Saturation, {0.0, 100.0}),
    };
    connect(graph, "step", "integrator"); connect(graph, "step", "derivative");
    connect(graph, "step", "second"); connect(graph, "second", "leadlag");
    connect(graph, "leadlag", "limiter"); connect(graph, "step", "tank::acc", "in");
    connect(graph, "outflow", "tank::acc", "outflow"); connect(graph, "tank::acc", "tank");
    connect(graph, "limiter", "deadtime");
    connect(graph, "deadtime", "final");
    SignalRuntime runtime = runtimeFor(graph); uint64_t now = 0;
    for (int i = 0; i < 100; ++i) acceptedStep(runtime, now, 1'000'000, 1e-9, 1e-4);
    CHECK(std::abs(runtime.real(runtime.output("integrator")) - 0.2) < 1e-12, "Integrator executa");
    CHECK(runtime.real(runtime.output("derivative")) > 0.0, "FilteredDerivative executa");
    CHECK(runtime.real(runtime.output("second")) > 0.0, "SecondOrder executa");
    CHECK(runtime.real(runtime.output("leadlag")) > 0.0, "LeadLag executa");
    CHECK(runtime.real(runtime.output("limiter")) > 0.0 && runtime.real(runtime.output("limiter")) <= 0.1 + 1e-12,
          "RateLimiter respeita a taxa de subida");
    CHECK(std::abs(runtime.real(runtime.output("tank::acc"), AccumulatorState) - 0.2) < 1e-12, "Accumulator executa na cadeia (2 x 0,1 s)");
    CHECK(runtime.real(runtime.output("final")) >= 0.0 && std::isfinite(runtime.real(runtime.output("final"))),
          "cadeia completa produz saida finita e limitada");
}
constexpr double kInf = std::numeric_limits<double>::infinity();

/** Acumulador isolado: fontes externas para as demandas (e, opcional, para upper), um bloco por porta
 * nomeada. Mesmo arranjo que `control.accumulator` materializa na sessão. */
struct AccumulatorRig {
    SignalRuntime runtime;
    uint64_t now = 0;
    double value(AccumulatorElement index) const { return runtime.real(runtime.output("acc"), index); }
    double residual() const {
        return value(AccumulatorState) - x0 -
               (value(AccumulatorCumIn) - value(AccumulatorCumOut) - value(AccumulatorCumOverflow) - value(AccumulatorCumSpill));
    }
    void step(double seconds) {
        const uint64_t dt = static_cast<uint64_t>(std::llround(seconds * 1e9));
        runtime.beginContinuousStep(now, now + dt);
        if (runtime.continuousErrorRatio(1e-12, 1e-9) != 0.0) { std::fprintf(stderr, "erro estimado nao nulo\n"); ++failures; }
        runtime.commitContinuousStep();
        now += dt;
        runtime.executeUntil(now);
    }
    double x0 = 0.0;
};

AccumulatorRig accumulatorRig(double initial, double lower, double upper, double qIn, double qOut, bool upperInput = false) {
    SignalGraphDefinition graph;
    const auto external = [](std::string id, double value) {
        SignalBlockDefinition block;
        block.id = std::move(id); block.kind = SignalBlockKind::ExternalInput; block.realParameters = {value}; block.rate = slowRate;
        return block;
    };
    SignalBlockDefinition acc;
    acc.id = "acc"; acc.kind = SignalBlockKind::Accumulator;
    acc.inputs = {realPort("in"), realPort("outflow")};
    if (upperInput) acc.inputs.push_back(realPort("upper"));
    acc.output = {"out", {SignalScalarType::Real, AccumulatorWidth}, ""};
    acc.realParameters = {initial, lower, upperInput ? kInf : upper, 0.0, upperInput ? 1.0 : 0.0};
    acc.rate = slowRate;
    graph.blocks = {external("qin", qIn), external("qout", qOut), acc};
    if (upperInput) graph.blocks.push_back(external("upper", upper));
    connect(graph, "qin", "acc", "in");
    connect(graph, "qout", "acc", "outflow");
    if (upperInput) connect(graph, "upper", "acc", "upper");
    AccumulatorRig rig{runtimeFor(graph)};
    rig.x0 = rig.value(AccumulatorState);
    return rig;
}

void accumulatorMatchesConservativeOracle() {
    {   // Bomba 1 L/s, saída 0,4 L/s por 10 s em passos de 10 ms: ΔV = 6 L (Euler é exato para ZOH).
        AccumulatorRig rig = accumulatorRig(20.0, 0.0, 100.0, 1.0, 0.4);
        for (int i = 0; i < 1000; ++i) rig.step(0.01);
        CHECK(std::abs(rig.value(AccumulatorState) - 26.0) < 1e-9, "bomba: ΔV = 6 L em 10 s");
        CHECK(std::abs(rig.value(AccumulatorCumIn) - 10.0) < 1e-9 && std::abs(rig.value(AccumulatorCumOut) - 4.0) < 1e-9,
              "acumulados de entrada/saída realizados");
        CHECK(std::abs(rig.residual()) < 1e-9, "balanço fecha na bomba");
    }
    {   // Paridade com o Tank migrado: "saída" negativa (perda térmica abaixo do ambiente) aquece.
        AccumulatorRig rig = accumulatorRig(25.0, 0.0, kInf, 0.0, -1.0);
        for (int i = 0; i < 100; ++i) rig.step(0.01);
        CHECK(std::abs(rig.value(AccumulatorState) - 26.0) < 1e-12, "demanda de saída negativa soma ao estado, como no Tank");
        CHECK(std::abs(rig.residual()) < 1e-12, "balanço fecha com demanda negativa");
    }
    {   // Contato com o topo no meio do passo: x0 = 9, upper = 10, líquida 0,6, passo de 2 s.
        AccumulatorRig rig = accumulatorRig(9.0, 0.0, 10.0, 1.0, 0.4);
        rig.step(2.0);
        CHECK(rig.value(AccumulatorState) == 10.0, "estado para no topo");
        CHECK(std::abs(rig.value(AccumulatorCumOverflow) - 0.6 * (2.0 - 1.0 / 0.6)) < 1e-12, "overflow = líquida × tempo após o contato");
        CHECK(std::abs(rig.value(AccumulatorOverflow) - 0.6) < 1e-12, "vazão de transbordo instantânea = líquida");
        CHECK(std::abs(rig.residual()) < 1e-12, "balanço fecha com transbordo");
    }
    {   // Esvaziamento: x0 = 1, saída 0,5 sem entrada, passo de 4 s: seca em 2 s.
        AccumulatorRig rig = accumulatorRig(1.0, 0.0, kInf, 0.0, 0.5);
        rig.step(4.0);
        CHECK(rig.value(AccumulatorState) == 0.0, "estado para no fundo");
        CHECK(std::abs(rig.value(AccumulatorCumUnmet) - 1.0) < 1e-12, "demanda não atendida = 0,5 × 2 s");
        CHECK(std::abs(rig.value(AccumulatorCumOut) - 1.0) < 1e-12, "saída realizada = volume que existia");
        CHECK(rig.value(AccumulatorOutActual) == 0.0 && std::abs(rig.value(AccumulatorUnmet) - 0.5) < 1e-12,
              "no fundo: saída real = entrada, unmet = demanda - entrada");
        CHECK(std::abs(rig.residual()) < 1e-12, "balanço fecha no esvaziamento");
    }
    {   // Topo ao vivo (A ajustável): V = 50 L, Vmax cai de 100 para 40 L -> derramam 10 L de uma vez.
        AccumulatorRig rig = accumulatorRig(20.0, 0.0, 100.0, 1.0, 0.4, true);
        for (int i = 0; i < 5000; ++i) rig.step(0.01);
        CHECK(std::abs(rig.value(AccumulatorState) - 50.0) < 1e-9, "V = 50 L em t = 50 s");
        rig.runtime.setExternalReal("upper", 40.0);
        rig.step(0.01);
        CHECK(rig.value(AccumulatorState) == 40.0, "estado vai ao novo topo");
        CHECK(std::abs(rig.value(AccumulatorCumSpill) - 10.0) < 1e-9, "derramamento discreto de 10 L em cumSpill");
        CHECK(std::abs(rig.value(AccumulatorCumOverflow) - 0.006) < 1e-9, "transbordo contínuo do passo em cumOverflow");
        CHECK(std::abs(rig.value(AccumulatorOverflow) - 0.6) < 1e-12, "passa a transbordar 0,6 L/s");
        CHECK(std::abs(rig.residual()) < 1e-9, "balanço fecha com derramamento");
        rig.runtime.setExternalReal("upper", 200.0);
        for (int i = 0; i < 100; ++i) rig.step(0.01);
        CHECK(std::abs(rig.value(AccumulatorState) - 40.6) < 1e-9 && rig.value(AccumulatorOverflow) == 0.0,
              "topo maior: volume preservado e volta a subir");
    }
    {   // Demandas alternadas atravessando as duas fronteiras: o balanço continua fechando.
        AccumulatorRig rig = accumulatorRig(5.0, 0.0, 10.0, 0.0, 0.0);
        for (int i = 0; i < 2000; ++i) {
            rig.runtime.setExternalReal("qin", (i / 200) % 2 == 0 ? 3.0 : 0.0);
            rig.runtime.setExternalReal("qout", 1.0 + 0.5 * std::sin(i * 0.01));
            rig.step(0.05);
        }
        CHECK(std::abs(rig.residual()) < 1e-9, "balanço fecha após 2000 passos com contatos");
        CHECK(rig.value(AccumulatorCumOverflow) > 0.0 && rig.value(AccumulatorCumUnmet) > 0.0, "o roteiro tocou o topo e o fundo");
        CHECK(rig.value(AccumulatorState) >= 0.0 && rig.value(AccumulatorState) <= 10.0, "estado dentro das fronteiras");
    }
}

/** A·hmax calculado por um bloco (como no tanque do Laboratório): a nova fronteira é lida na ativação
 * e o estado já sai projetado nela -- quem lê V na mesma ativação nunca vê V > Vmax. */
void accumulatorProjectsOnSampledBoundary() {
    constexpr SignalRate fast{10'000'000ull, 0, 0};
    SignalGraphDefinition graph;
    const auto block = [&](std::string id, SignalBlockKind kind, std::vector<double> parameters, std::vector<SignalPortDefinition> inputs = {}) {
        SignalBlockDefinition result;
        result.id = std::move(id); result.kind = kind; result.realParameters = std::move(parameters);
        result.inputs = std::move(inputs); result.rate = fast;
        return result;
    };
    SignalBlockDefinition acc = block("acc", SignalBlockKind::Accumulator, {20.0, 0.0, kInf, 0.0, 1.0},
                                      {realPort("in"), realPort("outflow"), realPort("upper")});
    acc.output = {"out", {SignalScalarType::Real, AccumulatorWidth}, ""};
    SignalBlockDefinition volume = element("v", AccumulatorState);
    volume.rate = fast;
    graph.blocks = {block("qin", SignalBlockKind::ExternalInput, {1.0}), block("qout", SignalBlockKind::ExternalInput, {0.4}),
                    block("area", SignalBlockKind::ExternalInput, {0.1}),
                    block("vmax", SignalBlockKind::Gain, {1000.0}, {realPort("in")}), acc, volume};
    connect(graph, "qin", "acc", "in"); connect(graph, "qout", "acc", "outflow");
    connect(graph, "area", "vmax"); connect(graph, "vmax", "acc", "upper"); connect(graph, "acc", "v");
    SignalRuntime runtime = runtimeFor(graph);
    uint64_t now = 0;
    for (int i = 0; i < 5000; ++i) acceptedStep(runtime, now, 10'000'000);
    CHECK(std::abs(runtime.real(runtime.output("v")) - 50.0) < 1e-9, "V = 50 L em 50 s com Vmax calculado");
    runtime.setExternalReal("area", 0.04);
    acceptedStep(runtime, now, 10'000'000);
    const SignalSlotHandle out = runtime.output("acc");
    CHECK(runtime.real(runtime.output("v")) == 40.0, "na ativação seguinte V já está no novo topo (40 L)");
    CHECK(std::abs(runtime.real(out, AccumulatorCumSpill) - 10.006) < 1e-9, "derramamento = excesso medido na ativação");
    const double residual = runtime.real(out, AccumulatorState) - 20.0 -
        (runtime.real(out, AccumulatorCumIn) - runtime.real(out, AccumulatorCumOut) -
         runtime.real(out, AccumulatorCumOverflow) - runtime.real(out, AccumulatorCumSpill));
    CHECK(std::abs(residual) < 1e-9, "balanço fecha com a projeção na ativação");
    acceptedStep(runtime, now, 10'000'000);
    CHECK(std::abs(runtime.real(out, AccumulatorOverflow) - 0.6) < 1e-12 && runtime.real(runtime.output("v")) == 40.0,
          "no topo, passa a transbordar 0,6 L/s");
}

/** docs/53 §2.6 itens 3-5: instante exato de contato e identidade de balanço em toda linha. */
void accumulatorContactTimesAndBalanceAtSchedulerStep() {
    {   // Transbordo: de 20 L com líquida 0,6 L/s até 100 L -> contato em 133,333... s.
        AccumulatorRig rig = accumulatorRig(20.0, 0.0, 100.0, 1.0, 0.4);
        CHECK(rig.value(AccumulatorUpperContactTime) == -1.0, "sem contato no início");
        for (int i = 0; i < 14000; ++i) rig.step(0.01);
        CHECK(std::abs(rig.value(AccumulatorUpperContactTime) - 400.0 / 3.0) <= 1e-9, "contato com o topo em 133,333... s (<= 1 ns)");
        CHECK(rig.value(AccumulatorLowerContactTime) == -1.0, "nenhum contato com o fundo");
    }
    {   // Esvaziamento: de 20 L, saída 2 L/s -> contato com o fundo em 10 s; depois saída real 0 e falta 2 L/s.
        AccumulatorRig rig = accumulatorRig(20.0, 0.0, 100.0, 0.0, 2.0);
        for (int i = 0; i < 1200; ++i) rig.step(0.01);
        CHECK(std::abs(rig.value(AccumulatorLowerContactTime) - 10.0) <= 1e-9, "contato com o fundo em 10 s (<= 1 ns)");
        CHECK(rig.value(AccumulatorOutActual) == 0.0 && rig.value(AccumulatorUnmet) == 2.0, "no fundo: saída real 0, falta 2 L/s");
    }
    {   // Passo do Scheduler (100 µs) por 60 s com demandas variando: identidade <= 1e-12·max(1, Vmax) em toda amostra.
        AccumulatorRig rig = accumulatorRig(20.0, 0.0, 100.0, 1.0, 0.4);
        double worst = 0.0;
        for (int i = 0; i < 600000; ++i) {
            if (i % 50000 == 0) {
                rig.runtime.setExternalReal("qin", (i / 50000) % 3 == 0 ? 25.0 : 0.7);
                rig.runtime.setExternalReal("qout", (i / 50000) % 2 == 0 ? 0.4 : 30.0);
            }
            rig.step(1e-4);
            if (i % 997 == 0) worst = std::max(worst, std::abs(rig.residual()));
        }
        CHECK(worst <= 1e-12 * 100.0, "identidade de balanço <= 1e-10 L em 600 mil passos de 100 µs");
        CHECK(rig.value(AccumulatorCumOverflow) > 0.0 && rig.value(AccumulatorCumUnmet) > 0.0, "o roteiro tocou o topo e o fundo");
        std::printf("  resíduo máximo em 600 mil passos: %.3g L\n", worst);
    }
}

void accumulatorRejectsInvalidDefinitions() {
    const auto rejects = [](SignalGraphDefinition graph) {
        try { SignalCompiler::compile(graph); } catch (const std::invalid_argument&) { return true; }
        return false;
    };
    SignalBlockDefinition acc;
    acc.id = "acc"; acc.kind = SignalBlockKind::Accumulator;
    acc.inputs = {realPort("in"), realPort("outflow")};
    acc.output = {"out", {SignalScalarType::Real, AccumulatorWidth}, ""};
    acc.realParameters = {0.0, 5.0, 5.0, 0.0, 0.0}; acc.rate = slowRate;
    SignalGraphDefinition graph;
    graph.blocks = {source("a", 1.0), source("b", 0.0), acc};
    connect(graph, "a", "acc", "in"); connect(graph, "b", "acc", "outflow");
    CHECK(rejects(graph), "lower >= upper rejeitado");
    graph.blocks[2].realParameters = {0.0, 0.0, 10.0, 0.0, 1.0};
    CHECK(rejects(graph), "upper por entrada declarado sem a entrada");
    graph.blocks[2].realParameters = {0.0, 0.0, 10.0, 0.0, 0.0};
    SignalBlockDefinition wrong = element("x", AccumulatorWidth);
    graph.blocks.push_back(wrong);
    connect(graph, "acc", "x");
    CHECK(rejects(graph), "Element fora do vetor rejeitado");
}
} // namespace

int main() {
    firstOrderAndFopdtMatchGoldens();
    adaptiveCandidateRollsBackAndConverges();
    invalidDynamicParametersFailDuringCompilation();
    discreteAndNonlinearPrimitivesAreIsolated();
    remainingContinuousPrimitivesAndChainExecute();
    accumulatorMatchesConservativeOracle();
    accumulatorProjectsOnSampledBoundary();
    accumulatorContactTimesAndBalanceAtSchedulerStep();
    accumulatorRejectsInvalidDefinitions();
    if (failures == 0) std::puts("SignalDynamicsTest: OK");
    return failures == 0 ? 0 : 1;
}
