#include <cmath>
#include <cstdio>
#include <stdexcept>

#include "simulation/SignalEngine.hpp"

using namespace lasecsimul::simulation;

namespace {
int failures = 0;
#define CHECK(expr, message) do { if (!(expr)) { std::fprintf(stderr, "FALHOU: %s -- %s\n", message, #expr); ++failures; } } while (false)

SignalPortDefinition realPort(std::string id, std::string unit = "", uint16_t width = 1) {
    return {std::move(id), {SignalScalarType::Real, width}, std::move(unit)};
}

SignalBlockDefinition source(std::string id, double value, SignalRate rate = {}) {
    SignalBlockDefinition block;
    block.id = std::move(id); block.kind = SignalBlockKind::Source; block.output = realPort("out");
    block.realParameters = {value}; block.rate = rate;
    return block;
}

void typedDagUnitsExpressionsAndRates() {
    SignalGraphDefinition definition;
    SignalBlockDefinition volts = source("volts", 2.0, {10, 0, 0});
    volts.output.unit = "V";
    SignalBlockDefinition gain;
    gain.id = "gain"; gain.kind = SignalBlockKind::Gain; gain.inputs = {realPort("x", "mV")};
    gain.output = realPort("out", "mV"); gain.realParameters = {0.5}; gain.rate = {10, 0, 0};
    SignalBlockDefinition expression;
    expression.id = "calc"; expression.kind = SignalBlockKind::CalcExpression;
    expression.inputs = {realPort("x", "mV")}; expression.output = realPort("out", "mV");
    expression.expression = "(x + 1) * 2"; expression.rate = {10, 0, 0};
    definition.blocks = {volts, gain, expression};
    definition.connections = {{"volts", "out", "gain", "x", true}, {"gain", "out", "calc", "x", false}};

    SignalRuntime runtime; runtime.bind(SignalCompiler::compile(definition));
    const void* storage = runtime.realStorageAddress();
    runtime.executeUntil(25);
    CHECK(std::abs(runtime.real(runtime.output("gain")) - 1000.0) < 1e-12, "conversao V->mV ocorre antes do Gain");
    CHECK(std::abs(runtime.real(runtime.output("calc")) - 2002.0) < 1e-12, "DAG e CalcExpression propagam por microsteps");
    CHECK(runtime.metrics().rateGroupActivations == 3, "RateGroup ativa nos instantes 0, 10 e 20");
    CHECK(runtime.metrics().blockEvaluations == 9, "cada bloco DAG executa uma vez por ativacao");
    runtime.executeUntil(100);
    CHECK(storage == runtime.realStorageAddress(), "steady state preserva endereco dos slots densos");
}

void boolIntAndVectorsUseSeparatePools() {
    SignalGraphDefinition definition;
    SignalBlockDefinition integers;
    integers.id = "ints"; integers.kind = SignalBlockKind::Source;
    integers.output = {"out", {SignalScalarType::Int64, 3}, ""}; integers.intParameters = {4, 5, 6};
    SignalBlockDefinition intProbe;
    intProbe.id = "int_probe"; intProbe.kind = SignalBlockKind::Probe;
    intProbe.inputs = {{"x", {SignalScalarType::Int64, 3}, ""}};
    intProbe.output = {"out", {SignalScalarType::Int64, 3}, ""};
    SignalBlockDefinition booleans;
    booleans.id = "bools"; booleans.kind = SignalBlockKind::Source;
    booleans.output = {"out", {SignalScalarType::Bool, 2}, ""}; booleans.boolParameters = {1, 0};
    definition.blocks = {integers, intProbe, booleans};
    definition.connections = {{"ints", "out", "int_probe", "x", false}};
    SignalRuntime runtime; runtime.bind(SignalCompiler::compile(definition)); runtime.executeUntil(0);
    CHECK(runtime.integer(runtime.output("int_probe"), 2) == 6, "vetor Int64 usa slots contiguos");
    CHECK(runtime.boolean(runtime.output("bools"), 0) && !runtime.boolean(runtime.output("bools"), 1), "Bool usa pool dedicado");
}

void invalidBindingsFailOnColdPath() {
    SignalGraphDefinition mismatch;
    SignalBlockDefinition real = source("real", 1.0);
    SignalBlockDefinition probe;
    probe.id = "bool_probe"; probe.kind = SignalBlockKind::Probe;
    probe.inputs = {{"x", {SignalScalarType::Bool, 1}, ""}};
    probe.output = {"out", {SignalScalarType::Bool, 1}, ""};
    mismatch.blocks = {real, probe}; mismatch.connections = {{"real", "out", "bool_probe", "x", false}};
    bool rejected = false; try { (void)SignalCompiler::compile(mismatch); } catch (const std::invalid_argument&) { rejected = true; }
    CHECK(rejected, "mismatch Real/Bool falha na compilacao");

    SignalGraphDefinition implicit;
    auto volts = source("volts", 1.0); volts.output.unit = "V";
    SignalBlockDefinition millivolts;
    millivolts.id = "mv"; millivolts.kind = SignalBlockKind::Probe;
    millivolts.inputs = {realPort("x", "mV")}; millivolts.output = realPort("out", "mV");
    implicit.blocks = {volts, millivolts}; implicit.connections = {{"volts", "out", "mv", "x", false}};
    rejected = false; try { (void)SignalCompiler::compile(implicit); } catch (const std::invalid_argument&) { rejected = true; }
    CHECK(rejected, "conversao implicita de unidade e rejeitada");

    SignalGraphDefinition badExpression;
    auto input = source("input", 1.0);
    SignalBlockDefinition calc;
    calc.id = "calc"; calc.kind = SignalBlockKind::CalcExpression; calc.inputs = {realPort("x")};
    calc.output = realPort("out"); calc.expression = "unknown + 1";
    badExpression.blocks = {input, calc}; badExpression.connections = {{"input", "out", "calc", "x", false}};
    rejected = false; try { (void)SignalCompiler::compile(badExpression); } catch (const std::invalid_argument&) { rejected = true; }
    CHECK(rejected, "variavel desconhecida em CalcExpression falha na compilacao");
}

void allPrimitiveBlocksExecuteDeterministically() {
    SignalGraphDefinition definition;
    auto a = source("a", 3.0);
    auto b = source("b", 4.0);
    SignalBlockDefinition condition;
    condition.id = "condition"; condition.kind = SignalBlockKind::Source;
    condition.output = {"out", {SignalScalarType::Bool, 1}, ""}; condition.boolParameters = {1};
    SignalBlockDefinition sum;
    sum.id = "sum"; sum.kind = SignalBlockKind::Sum;
    sum.inputs = {realPort("a"), realPort("b")}; sum.output = realPort("out");
    SignalBlockDefinition product = sum; product.id = "product"; product.kind = SignalBlockKind::Product;
    SignalBlockDefinition limiter;
    limiter.id = "limiter"; limiter.kind = SignalBlockKind::Limiter;
    limiter.inputs = {realPort("x")}; limiter.output = realPort("out"); limiter.realParameters = {0.0, 5.0};
    SignalBlockDefinition selector;
    selector.id = "selector"; selector.kind = SignalBlockKind::Selector;
    selector.inputs = {{"condition", {SignalScalarType::Bool, 1}, ""}, realPort("yes"), realPort("no")};
    selector.output = realPort("out");
    SignalBlockDefinition probe;
    probe.id = "probe"; probe.kind = SignalBlockKind::Probe;
    probe.inputs = {realPort("x")}; probe.output = realPort("out");
    definition.blocks = {a, b, condition, sum, product, limiter, selector, probe};
    definition.connections = {
        {"a", "out", "sum", "a", false}, {"b", "out", "sum", "b", false},
        {"a", "out", "product", "a", false}, {"b", "out", "product", "b", false},
        {"sum", "out", "limiter", "x", false}, {"condition", "out", "selector", "condition", false},
        {"sum", "out", "selector", "yes", false}, {"product", "out", "selector", "no", false},
        {"selector", "out", "probe", "x", false},
    };
    const auto graph = SignalCompiler::compile(definition);
    SignalRuntime first; SignalRuntime second;
    first.bind(graph); second.bind(graph); first.executeUntil(3); second.executeUntil(3);
    CHECK(first.real(first.output("sum")) == 7.0, "Sum executa");
    CHECK(first.real(first.output("product")) == 12.0, "Product executa");
    CHECK(first.real(first.output("limiter")) == 5.0, "Limiter executa");
    CHECK(first.real(first.output("probe")) == 7.0, "Selector e Probe executam");
    CHECK(first.real(first.output("probe")) == second.real(second.output("probe")) &&
              first.metrics().blockEvaluations == second.metrics().blockEvaluations,
          "mesmo plano produz valores e ordem identicos independentemente do runtime");
}

void phaseOrdersRateGroupsAtTheSameTimestamp() {
    SignalGraphDefinition definition;
    auto slowSource = source("slow", 9.0, {10, 0, 0});
    SignalBlockDefinition fastProbe;
    fastProbe.id = "fast"; fastProbe.kind = SignalBlockKind::Probe;
    fastProbe.inputs = {realPort("x")}; fastProbe.output = realPort("out");
    fastProbe.rate = {5, 0, 1};
    definition.blocks = {slowSource, fastProbe};
    definition.connections = {{"slow", "out", "fast", "x", false}};
    SignalRuntime runtime; runtime.bind(SignalCompiler::compile(definition)); runtime.executeUntil(0);
    CHECK(runtime.real(runtime.output("fast")) == 9.0,
          "phase, e nao periodo do RateGroup, ordena eventos no mesmo timestamp");
}

void algebraicLoopsNeedPolicyAndAreBounded() {
    SignalGraphDefinition rejectedGraph;
    SignalBlockDefinition loop;
    loop.id = "loop"; loop.kind = SignalBlockKind::Gain; loop.inputs = {realPort("x")};
    loop.output = realPort("out"); loop.realParameters = {0.5};
    rejectedGraph.blocks = {loop}; rejectedGraph.connections = {{"loop", "out", "loop", "x", false}};
    bool rejected = false; try { (void)SignalCompiler::compile(rejectedGraph); } catch (const std::invalid_argument&) { rejected = true; }
    CHECK(rejected, "SCC sem politica produz diagnostico de compilacao");

    loop.loopPolicy = AlgebraicLoopPolicy::FixedPoint; loop.maxIterations = 4; loop.tolerance = 0.0;
    rejectedGraph.blocks = {loop};
    SignalRuntime runtime; runtime.bind(SignalCompiler::compile(rejectedGraph)); runtime.executeUntil(0);
    CHECK(runtime.metrics().algebraicIterations == 1, "FixedPoint convergente encerra antes do limite");
    CHECK(runtime.metrics().nonConvergentLoops == 0, "SCC convergente nao emite diagnostico runtime");

    SignalGraphDefinition divergent;
    SignalBlockDefinition calc;
    calc.id = "divergent"; calc.kind = SignalBlockKind::CalcExpression;
    calc.inputs = {realPort("x")}; calc.output = realPort("out"); calc.expression = "x + 1";
    calc.loopPolicy = AlgebraicLoopPolicy::FixedPoint; calc.maxIterations = 3; calc.tolerance = 0.0;
    divergent.blocks = {calc}; divergent.connections = {{"divergent", "out", "divergent", "x", false}};
    runtime.bind(SignalCompiler::compile(divergent)); runtime.executeUntil(0);
    CHECK(runtime.metrics().algebraicIterations == 3 && runtime.metrics().nonConvergentLoops == 1,
          "SCC oscilante para no limite e registra diagnostico");
}
} // namespace

int main() {
    typedDagUnitsExpressionsAndRates();
    boolIntAndVectorsUseSeparatePools();
    invalidBindingsFailOnColdPath();
    allPrimitiveBlocksExecuteDeterministically();
    phaseOrdersRateGroupsAtTheSameTimestamp();
    algebraicLoopsNeedPolicyAndAreBounded();
    if (failures == 0) std::puts("SignalEngineTest: OK");
    return failures == 0 ? 0 : 1;
}
