#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>

#include <nlohmann/json.hpp>

#include "registry/SubcircuitRegistry.hpp"
#include "simulation/ProcessSubcircuitCompiler.hpp"

using namespace lasecsimul::registry;
using namespace lasecsimul::simulation;

namespace {
int failures = 0;
#define CHECK(expr, message) do { if (!(expr)) { std::fprintf(stderr, "FALHOU: %s -- %s\n", message, #expr); ++failures; } } while (false)

SubcircuitInterfaceDef signalInterface(std::string pin, std::string direction) {
    SubcircuitInterfaceDef interfaceDef;
    interfaceDef.pinId = pin; interfaceDef.label = pin; interfaceDef.internalTunnel = pin;
    interfaceDef.domain = "signal"; interfaceDef.direction = std::move(direction);
    interfaceDef.valueType = "Real"; interfaceDef.width = 1;
    return interfaceDef;
}

SubcircuitDefinition firstOrderProcess() {
    SubcircuitDefinition definition;
    definition.typeId = "process.first-order-composite";
    definition.components = {
        {"input", "connectors.tunnel", R"({"name":"u"})"},
        {"plant", "control.process", R"({"gain":2.0,"tau1":0.5,"deadTime":0.2,"samplePeriodNs":10000000})"},
        {"output", "connectors.tunnel", R"({"name":"y"})"},
    };
    definition.wires = {{"input", "pin", "plant", "in"}, {"plant", "out", "output", "pin"}};
    definition.interfaceDefs = {signalInterface("u", "in"), signalInterface("y", "out")};
    return definition;
}

SubcircuitDefinition loadManifest(const std::string& name) {
    std::ifstream stream(std::string(PROCESS_LIBRARY_DIR) + "/" + name);
    if (!stream) throw std::runtime_error("manifesto de teste nao encontrado: " + name);
    nlohmann::json manifest; stream >> manifest;
    SubcircuitDefinition definition;
    definition.typeId = manifest.at("typeId").get<std::string>();
    definition.name = manifest.value("name", definition.typeId);
    definition.packageJson = manifest.value("symbol", nlohmann::json::object()).dump();
    for (const auto& component : manifest.at("components")) definition.components.push_back({
        component.at("id").get<std::string>(), component.at("typeId").get<std::string>(),
        component.value("properties", nlohmann::json::object()).dump()});
    for (const auto& conductor : manifest.at("topology").at("conductors")) definition.wires.push_back({
        conductor.at("from").at("componentId").get<std::string>(), conductor.at("from").at("pinId").get<std::string>(),
        conductor.at("to").at("componentId").get<std::string>(), conductor.at("to").at("pinId").get<std::string>()});
    for (const auto& entry : manifest.at("interface")) {
        SubcircuitInterfaceDef interfaceDef;
        interfaceDef.pinId = entry.at("pinId").get<std::string>();
        interfaceDef.label = entry.value("label", interfaceDef.pinId);
        interfaceDef.internalTunnel = entry.at("internalTunnel").get<std::string>();
        interfaceDef.domain = entry.value("domain", "electrical");
        interfaceDef.direction = entry.value("direction", "inout");
        interfaceDef.valueType = entry.value("valueType", "Real");
        interfaceDef.width = entry.value("width", 1);
        interfaceDef.unit = entry.value("unit", "");
        definition.interfaceDefs.push_back(std::move(interfaceDef));
    }
    return definition;
}

SignalGraphDefinition manualFirstOrderGraph() {
    SignalGraphDefinition graph;
    SignalBlockDefinition input;
    input.id = "input"; input.kind = SignalBlockKind::ExternalInput; input.realParameters = {0.0};
    input.rate = {10'000'000, 0, 0};
    SignalBlockDefinition gain;
    gain.id = "plant::gain"; gain.kind = SignalBlockKind::Gain;
    gain.inputs = {{"in", {SignalScalarType::Real, 1}, ""}}; gain.realParameters = {2.0}; gain.rate = input.rate;
    SignalBlockDefinition tau = gain;
    tau.id = "plant::tau1"; tau.kind = SignalBlockKind::FirstOrder; tau.realParameters = {1.0, 0.5, 0.0};
    SignalBlockDefinition delay = gain;
    delay.id = "plant::delay"; delay.kind = SignalBlockKind::DeadTime; delay.realParameters = {0.2, 0.0};
    SignalBlockDefinition output = gain;
    output.id = "output"; output.kind = SignalBlockKind::Probe; output.realParameters.clear();
    graph.blocks = {input, gain, tau, delay, output};
    graph.connections = {
        {"input", "out", "plant::gain", "in", false},
        {"plant::gain", "out", "plant::tau1", "in", false},
        {"plant::tau1", "out", "plant::delay", "in", false},
        {"plant::delay", "out", "output", "in", false},
    };
    return graph;
}

void advance(SignalRuntime& runtime, uint64_t endNs, uint64_t stepNs) {
    uint64_t now = 0;
    while (now < endNs) {
        const uint64_t next = std::min(endNs, now + stepNs);
        runtime.beginContinuousStep(now, next);
        (void)runtime.continuousErrorRatio(1e-9, 1e-6);
        runtime.commitContinuousStep();
        runtime.executeUntil(next);
        now = next;
    }
}

void compositeMatchesManualExpansionAndOverridesAreIsolated() {
    SubcircuitRegistry registry;
    SubcircuitDefinition definition = firstOrderProcess();
    definition.packageJson = R"({"width":80,"pins":[{"id":"u","x":0},{"id":"y","x":80}]})";
    registry.registerDefinition(definition);
    const CompiledProcessSubcircuit compiled = ProcessSubcircuitCompiler::compile(registry, definition.typeId);
    CHECK(compiled.externalInputs.at("u") == "input" && compiled.externalOutputs.at("y") == "output",
          "shell resolve portIds para blocos internos estaveis");

    SignalRuntime composite, manual;
    composite.bind(SignalCompiler::compile(compiled.graph));
    manual.bind(SignalCompiler::compile(manualFirstOrderGraph()));
    composite.setExternalReal("input", 1.0); manual.setExternalReal("input", 1.0);
    composite.executeUntil(0); manual.executeUntil(0);
    advance(composite, 1'000'000'000, 5'000'000);
    advance(manual, 1'000'000'000, 5'000'000);
    const double compositeValue = composite.real(composite.output("output"));
    const double manualValue = manual.real(manual.output("output"));
    const double golden = 2.0 * (1.0 - std::exp(-0.8 / 0.5));
    CHECK(std::abs(compositeValue - manualValue) < 1e-12, "composite equivale numericamente a expansao manual");
    CHECK(std::abs(compositeValue - golden) < 2e-3, "composite segue golden FOPDT documentado");

    const CompiledProcessSubcircuit overridden = ProcessSubcircuitCompiler::compile(
        registry, definition.typeId, {{"plant.gain", 3.0}});
    SignalRuntime first, second;
    first.bind(SignalCompiler::compile(compiled.graph));
    second.bind(SignalCompiler::compile(overridden.graph));
    first.setExternalReal("input", 1.0); second.setExternalReal("input", 1.0);
    first.executeUntil(0); second.executeUntil(0);
    advance(first, 1'000'000'000, 5'000'000); advance(second, 1'000'000'000, 5'000'000);
    CHECK(second.real(second.output("output")) > first.real(first.output("output")) * 1.49,
          "parameterOverride atinge somente a instancia alvo");
}

void pidHasDeterministicVirtualScanAndIndependentState() {
    SignalGraphDefinition graph;
    SignalBlockDefinition sp;
    sp.id = "sp"; sp.kind = SignalBlockKind::ExternalInput; sp.realParameters = {1.0}; sp.rate = {100'000'000, 0, 0};
    SignalBlockDefinition pv = sp; pv.id = "pv"; pv.realParameters = {0.0};
    SignalBlockDefinition pid;
    pid.id = "pid"; pid.kind = SignalBlockKind::Pid;
    pid.inputs = {{"sp", {SignalScalarType::Real, 1}, ""}, {"pv", {SignalScalarType::Real, 1}, ""}};
    pid.realParameters = {2.0, 1.0, 0.0, 0.0, 0.1, -100.0, 100.0, 1.0, 1.0, 0.0};
    pid.rate = sp.rate;
    graph.blocks = {sp, pv, pid};
    graph.connections = {{"sp", "out", "pid", "sp", false}, {"pv", "out", "pid", "pv", false}};
    const auto plan = SignalCompiler::compile(graph);
    SignalRuntime first, second; first.bind(plan); second.bind(plan);
    first.executeUntil(100'000'000); second.executeUntil(0);
    CHECK(std::abs(first.real(first.output("pid")) - 2.2) < 1e-12,
          "PID PI integra exatamente pelo scan virtual de 100ms");
    CHECK(std::abs(second.real(second.output("pid")) - 2.0) < 1e-12,
          "duas instancias PID nao compartilham memoria");
}

void legacyMReferencesAreRejectedFromCanonicalRuntime() {
    SubcircuitRegistry registry;
    SubcircuitDefinition definition;
    definition.typeId = "process.bad-legacy-expression";
    definition.components = {
        {"in", "connectors.tunnel", R"({"name":"u"})"},
        {"calc", "control.calc_expression", R"({"expression":"M21+1","inputs":["x0"]})"},
        {"out", "connectors.tunnel", R"({"name":"y"})"},
    };
    definition.wires = {{"in", "pin", "calc", "x0"}, {"calc", "out", "out", "pin"}};
    definition.interfaceDefs = {signalInterface("u", "in"), signalInterface("y", "out")};
    registry.registerDefinition(definition);
    bool rejected = false;
    try { (void)ProcessSubcircuitCompiler::compile(registry, definition.typeId); }
    catch (const std::invalid_argument&) { rejected = true; }
    CHECK(rejected, "Mnn nunca permanece operacional no documento canonico");
}

void canonicalCalcSupportsConstantsLimitsAndObserverProbes() {
    SubcircuitRegistry registry;
    SubcircuitDefinition definition;
    definition.typeId = "process.constant-limited-observed";
    definition.components = {
        {"constant", "control.calc_expression", R"({"expression":"12.5","inputs":[],"upperLimit":10,"upperLimitEnabled":true})"},
        {"probe", "control.probe", R"({"observerOnly":true})"},
        {"out", "connectors.tunnel", R"({"name":"y"})"},
    };
    definition.wires = {{"constant", "out", "probe", "in"}, {"probe", "out", "out", "pin"}};
    definition.interfaceDefs = {signalInterface("y", "out")};
    registry.registerDefinition(definition);
    const auto compiled = ProcessSubcircuitCompiler::compile(registry, definition.typeId);
    SignalRuntime runtime;
    runtime.bind(SignalCompiler::compile(compiled.graph));
    runtime.executeUntil(0);
    CHECK(std::abs(runtime.real(runtime.output("out")) - 10.0) < 1e-12,
          "CalcExpression constante aceita zero inputs, aplica limite e Probe nao altera valor");
}

void checkedInProcessLibraryCompilesAndRuns() {
    std::vector<std::string> files;
    for (const auto& entry : std::filesystem::directory_iterator(PROCESS_LIBRARY_DIR)) {
        const std::string file = entry.path().filename().string();
        if (file.rfind("tdps_", 0) == 0 && entry.path().extension() == ".lssubcircuit") files.push_back(file);
    }
    std::sort(files.begin(), files.end());
    CHECK(files.size() == 24, "biblioteca TDPS versionada cobre exatamente o inventario auditado");
    for (const std::string& file : files) {
        SubcircuitRegistry registry;
        const SubcircuitDefinition definition = loadManifest(file);
        registry.registerDefinition(definition);
        CompiledProcessSubcircuit compiled;
        try { compiled = ProcessSubcircuitCompiler::compile(registry, definition.typeId); }
        catch (const std::exception& error) {
            CHECK(false, (std::string("falha de compilacao TDPS: ") + error.what()).c_str());
            continue;
        }
        SignalRuntime runtime;
        runtime.bind(SignalCompiler::compile(compiled.graph));
        runtime.executeUntil(0);
        CHECK(!compiled.externalOutputs.empty(), "todo cenario TDPS convertido expoe ao menos uma saida SignalTunnel");
    }
}

void discreteTransferFunctionCompilesFromPersistedBlockProperties() {
    SubcircuitDefinition definition;
    definition.typeId = "process.discrete-controller";
    definition.components = {
        {"input", "connectors.tunnel", R"({"name":"u"})"},
        {"controller", "control.transfer_function", R"({"model":"discrete_transfer_function","numeratorCoefficients":"0.1","denominatorCoefficients":"1,-0.9","samplePeriodNs":100000000,"initialState":"[0,2]"})"},
        {"output", "connectors.tunnel", R"({"name":"y"})"},
    };
    definition.wires = {{"input", "pin", "controller", "in"}, {"controller", "out", "output", "pin"}};
    definition.interfaceDefs = {signalInterface("u", "in"), signalInterface("y", "out")};
    SubcircuitRegistry registry; registry.registerDefinition(definition);
    const auto compiled = ProcessSubcircuitCompiler::compile(registry, definition.typeId);
    SignalRuntime runtime; runtime.bind(SignalCompiler::compile(compiled.graph));
    runtime.setExternalReal(compiled.externalInputs.at("u"), 1.0); runtime.executeUntil(0);
    CHECK(std::abs(runtime.real(runtime.output(compiled.externalOutputs.at("y"))) - 1.8) < 1e-12,
          "bloco discreto publica o estado inicial configurado antes do primeiro tick");
    runtime.executeUntil(100'000'000ull);
    CHECK(std::abs(runtime.real(runtime.output(compiled.externalOutputs.at("y"))) - 1.72) < 1e-12,
          "ProcessSubcircuitCompiler compila coeficientes e samplePeriodNs preservados");

    definition.components[1].propertiesJson = R"({"model":"discrete_transfer_function","numeratorCoefficients":"0.1","denominatorCoefficients":"1,-0.9"})";
    SubcircuitRegistry missingPeriodRegistry; missingPeriodRegistry.registerDefinition(definition);
    bool rejectedMissingPeriod = false;
    try { (void)ProcessSubcircuitCompiler::compile(missingPeriodRegistry, definition.typeId); }
    catch (const std::invalid_argument&) { rejectedMissingPeriod = true; }
    CHECK(rejectedMissingPeriod, "modelo discreto dinamico sem Ts explicito nao inventa o periodo padrao");
}

void stateSpacePropertiesCompileToOriginalContinuousAndDiscreteBlocks() {
    for (const auto& [domain, expectedKind] : std::array{
             std::pair{"continuous", SignalBlockKind::StateSpaceContinuous},
             std::pair{"discrete", SignalBlockKind::StateSpaceDiscrete}}) {
        SubcircuitDefinition definition;
        definition.typeId = std::string("process.state-space-") + domain;
        const std::string properties = std::string(R"({"A":"[[-1]]","B":"[1]","C":"[1]","D":0,"domain":")") + domain +
            R"(","samplePeriodNs":100000000})";
        definition.components = {
            {"input", "connectors.tunnel", R"({"name":"u"})"},
            {"plant", "control.state_space", properties},
            {"output", "connectors.tunnel", R"({"name":"y"})"},
        };
        definition.wires = {{"input", "pin", "plant", "in"}, {"plant", "out", "output", "pin"}};
        definition.interfaceDefs = {signalInterface("u", "in"), signalInterface("y", "out")};
        SubcircuitRegistry registry; registry.registerDefinition(definition);
        const auto compiled = ProcessSubcircuitCompiler::compile(registry, definition.typeId);
        const auto block = std::find_if(compiled.graph.blocks.begin(), compiled.graph.blocks.end(), [](const auto& item) { return item.id == "plant"; });
        CHECK(block != compiled.graph.blocks.end(), "bloco A/B/C/D compilado");
        if (block != compiled.graph.blocks.end()) {
            CHECK(block->kind == expectedKind && block->intParameters == std::vector<int64_t>{1}, "dominio e dimensão são preservados");
            CHECK(block->realParameters == std::vector<double>({-1.0, 1.0, 1.0, 0.0, 0.0}), "matrizes originais e estado inicial são mantidos no plano compilado");
        }
    }
}

} // namespace

int main() {
    compositeMatchesManualExpansionAndOverridesAreIsolated();
    pidHasDeterministicVirtualScanAndIndependentState();
    legacyMReferencesAreRejectedFromCanonicalRuntime();
    canonicalCalcSupportsConstantsLimitsAndObserverProbes();
    checkedInProcessLibraryCompilesAndRuns();
    discreteTransferFunctionCompilesFromPersistedBlockProperties();
    stateSpacePropertiesCompileToOriginalContinuousAndDiscreteBlocks();
    if (failures == 0) std::puts("ProcessSubcircuitTest: OK");
    return failures == 0 ? 0 : 1;
}
