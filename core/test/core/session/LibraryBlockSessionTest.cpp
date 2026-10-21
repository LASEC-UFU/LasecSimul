// Blocos `sl.*` (biblioteca equivalente ao Simulink, docs/66) no caminho REAL da sessão: o mesmo
// `addComponent`/`connectWire` que a Extension aciona, com larguras e tempos de amostragem herdados
// resolvidos pela materialização. Referências analíticas, nunca o próprio engine.
#include <algorithm>
#include <cmath>
#include <filesystem>
#include <cstdio>
#include <cstring>
#include <limits>
#include <functional>
#include <memory>
#include <fstream>
#include <string>

#include <nlohmann/json.hpp>

#include "components/blocks/LibraryBlock.hpp"
#include "components/control/SignalConstant.hpp"
#include "components/connectors/SignalTunnel.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "session/SimulationSession.hpp"

using namespace lasecsimul;
using namespace lasecsimul::registry;
using namespace lasecsimul::plugins;
using namespace lasecsimul::session;
using namespace lasecsimul::simulation;

namespace {

int failures = 0;
void check(bool ok, const std::string& label) {
    if (ok) std::printf("OK: %s\n", label.c_str());
    else { std::fprintf(stderr, "FALHOU: %s\n", label.c_str()); ++failures; }
}

struct Harness {
    GlobalPluginCache cache;
    SimulationSession session{cache};
    uint64_t now = 0;
    Harness() {
        for (const components::blocks::BlockSpec& spec : components::blocks::blockLibrary())
            session.components().registerFactory(spec.typeId, [&spec](const ComponentParams& p) {
                return std::make_unique<components::blocks::LibraryBlock>(spec, p);
            });
        session.components().registerFactory(components::SignalConstant::kTypeId, [](const ComponentParams& p) {
            return std::make_unique<components::SignalConstant>(p);
        });
    }
    uint32_t add(const std::string& block, std::initializer_list<std::pair<const char*, PropertyValue>> properties = {}) {
        ComponentParams params;
        for (const auto& [name, value] : properties) params.properties[name] = value;
        return session.addComponent("sl." + block, params);
    }
    void wire(uint32_t from, const char* fromPort, uint32_t to, const char* toPort) { session.connectWire(from, fromPort, to, toPort); }
    void runUntil(double seconds) { now = static_cast<uint64_t>(std::llround(seconds * 1e9)); session.scheduler().runUntil(now); }
    double value(uint32_t component, const char* port = "out1", uint16_t element = 0) {
        return session.signalRuntime().real(session.signalRuntime().output(signalPortBlockId(component, port)), element);
    }
};

PropertyValue text(const char* value) { return PropertyValue{std::string(value)}; }

void stepIntoTransferFunction() {
    Harness h;
    const uint32_t step = h.add("step", {{"Time", text("0.5")}});
    const uint32_t tf = h.add("transfer_fcn", {{"Numerator", text("[1]")}, {"Denominator", text("[1 1]")}});
    h.wire(step, "out1", tf, "in1");
    h.runUntil(2.0);
    const double expected = 1.0 - std::exp(-1.5);
    check(std::abs(h.value(tf) - expected) < 1e-4, "Step -> Transfer Fcn 1/(s+1): y(2) = 1 - e^-1.5 (" + std::to_string(h.value(tf)) + ")");
    check(h.value(step) == 1.0, "Step publica o valor final depois do instante do degrau");
}

void inheritanceConstantAndContinuous() {
    Harness h;
    const uint32_t constant = h.add("constant", {{"Value", text("[1 2 3]")}});
    const uint32_t gain = h.add("gain", {{"Gain", text("2")}});
    const uint32_t sum = h.add("sum", {{"Inputs", text("+")}});
    h.wire(constant, "out1", gain, "in1");
    h.wire(gain, "out1", sum, "in1");
    const uint32_t sine = h.add("sine_wave", {{"Amplitude", text("3")}});
    const uint32_t gain2 = h.add("gain", {{"Gain", text("2")}});
    h.wire(sine, "out1", gain2, "in1");
    h.runUntil(0.7);
    check(h.value(gain, "out1", 0) == 2.0 && h.value(gain, "out1", 2) == 6.0, "Constant vetorial -> Gain herda largura 3 e tempo constante");
    check(h.value(sum) == 12.0, "Sum com uma entrada '+' soma os elementos");
    check(std::abs(h.value(gain2) - 6.0 * std::sin(0.7)) < 1e-9, "Gain herda tempo continuo do Sine Wave: 2*3*sin(0.7)");
}

void muxDemuxAndFcn() {
    Harness h;
    const uint32_t a = h.add("constant", {{"Value", text("3")}});
    const uint32_t b = h.add("constant", {{"Value", text("[4 5]")}});
    const uint32_t mux = h.add("mux", {{"Inputs", text("2")}});
    h.wire(a, "out1", mux, "in1");
    h.wire(b, "out1", mux, "in2");
    const uint32_t demux = h.add("demux", {{"Outputs", text("[2 1]")}});
    h.wire(mux, "out1", demux, "in1");
    const uint32_t fcn = h.add("fcn", {{"Expr", text("u(1)^2 + 2*u(2) - -2^2")}});
    h.wire(mux, "out1", fcn, "in1");
    h.runUntil(0.01);
    check(h.value(demux, "out1", 0) == 3.0 && h.value(demux, "out1", 1) == 4.0 && h.value(demux, "out2") == 5.0,
          "Mux concatena [3 | 4 5] e Demux [2 1] separa");
    check(h.value(fcn) == 9.0 + 8.0 + 4.0, "Fcn: u(1)^2 + 2*u(2) - -2^2 = 21 (precedencia: ^ antes do menos unario)");
}

void discreteTransferFunction() {
    Harness h;
    const uint32_t one = h.add("constant", {{"Value", text("1")}, {"SampleTime", text("0.1")}});
    // y[k] = 0.5 y[k-1] + u[k-1] -> H(z) = 1/(z - 0.5): 0, 1, 1.5, 1.75 ...
    const uint32_t dtf = h.add("discrete_transfer_fcn", {{"Numerator", text("[1]")}, {"Denominator", text("[1 -0.5]")}, {"SampleTime", text("0.1")}});
    h.wire(one, "out1", dtf, "in1");
    const double expected[] = {0.0, 1.0, 1.5, 1.75, 1.875};
    for (int k = 0; k < 5; ++k) {
        h.runUntil(0.1 * k + 0.05);
        check(std::abs(h.value(dtf) - expected[k]) < 1e-12, "Discrete Transfer Fcn amostra " + std::to_string(k));
    }
}

void continuousPiLoop() {
    // r = 1 -> e = r - y -> PI (Kp = 2, Ki = 1) -> planta 1/(s+1) -> y. Em regime y = 1.
    Harness h;
    const uint32_t r = h.add("constant", {{"Value", text("1")}});
    const uint32_t e = h.add("sum", {{"Inputs", text("|+-")}});
    const uint32_t kp = h.add("gain", {{"Gain", text("2")}});
    const uint32_t ki = h.add("integrator");
    const uint32_t u = h.add("sum", {{"Inputs", text("++")}});
    const uint32_t plant = h.add("transfer_fcn");
    h.wire(r, "out1", e, "in1");
    h.wire(plant, "out1", e, "in2");
    h.wire(e, "out1", kp, "in1");
    h.wire(e, "out1", ki, "in1");
    h.wire(kp, "out1", u, "in1");
    h.wire(ki, "out1", u, "in2");
    h.wire(u, "out1", plant, "in1");
    h.runUntil(20.0);
    // T(s) = (2s+1)/(s^2+3s+1): y(t) = 1 + r1 e^(p1 t) + r2 e^(p2 t), p = (-3 +- sqrt(5))/2.
    const double p1 = (-3.0 + std::sqrt(5.0)) / 2.0, p2 = (-3.0 - std::sqrt(5.0)) / 2.0;
    const double r1 = (2.0 * p1 + 1.0) / (p1 * (p1 - p2)), r2 = (2.0 * p2 + 1.0) / (p2 * (p2 - p1));
    const double expected = 1.0 + r1 * std::exp(p1 * 20.0) + r2 * std::exp(p2 * 20.0);
    check(std::abs(h.value(plant) - expected) < 1e-6, "malha PI continua: y(20) analitico " + std::to_string(expected) + " (" + std::to_string(h.value(plant)) + ")");
}

void integratorResetPort() {
    Harness h;
    const uint32_t one = h.add("constant", {{"Value", text("1")}});
    const uint32_t pulse = h.add("step", {{"Time", text("1")}});
    const uint32_t integrator = h.add("integrator", {{"ExternalReset", text("rising")}});
    h.wire(one, "out1", integrator, "in1");
    h.wire(pulse, "out1", integrator, "reset");
    h.runUntil(1.5);
    check(std::abs(h.value(integrator) - 0.5) < 1e-6, "Integrator zera na borda de subida do reset em t = 1 (" + std::to_string(h.value(integrator)) + ")");
}

void discreteBlockRejectsContinuousInput() {
    Harness h;
    const uint32_t sine = h.add("sine_wave");
    const uint32_t delay = h.add("unit_delay");
    bool rejected = false;
    try {
        h.wire(sine, "out1", delay, "in1");
        h.runUntil(0.1);
    } catch (const std::exception& error) {
        rejected = std::string(error.what()).find("Unit Delay") != std::string::npos;
    }
    check(rejected, "Unit Delay herdando tempo continuo e recusado com mensagem citando o bloco");
}

void legacyConstantFeedsLibraryBlock() {
    Harness h;
    ComponentParams params;
    params.properties["value"] = 4.0;
    const uint32_t legacy = h.session.addComponent("control.constant", params);
    const uint32_t gain = h.add("gain", {{"Gain", text("0.5")}});
    h.wire(legacy, "out", gain, "in1");
    h.runUntil(0.01);
    check(h.value(gain) == 2.0, "Constante do projeto (componente nao-biblioteca) alimenta Gain herdado");
}

/** Mesmos casos do teste da Extension (`blockLibrary.test.ts`): todos os `port-vectors*.json` do
 * diretório de fixtures (um arquivo por família de blocos). */
void sharedPortVectors() {
    std::vector<std::filesystem::path> files;
    for (const auto& entry : std::filesystem::directory_iterator(PORT_VECTORS_DIR)) {
        const std::string name = entry.path().filename().string();
        if (name.rfind("port-vectors", 0) == 0 && entry.path().extension() == ".json") files.push_back(entry.path());
    }
    std::sort(files.begin(), files.end());
    check(!files.empty(), "arquivos de casos de porta existem");
    for (const auto& file : files) {
    std::ifstream input(file);
    const nlohmann::json root = nlohmann::json::parse(input);
    for (const auto& item : root.at("cases")) {
        const std::string typeId = item.at("typeId").get<std::string>();
        const components::blocks::BlockSpec* spec = components::blocks::findBlockSpec(typeId);
        check(spec != nullptr, "especificacao existe: " + typeId);
        if (!spec) continue;
        components::blocks::PropertyMap properties;
        for (const auto& [name, value] : item.at("properties").items()) {
            if (value.is_boolean()) properties[name] = value.get<bool>();
            else if (value.is_number()) properties[name] = value.get<double>();
            else properties[name] = value.get<std::string>();
        }
        const auto effective = components::blocks::withDefaults(*spec, properties);
        const auto inputs = components::blocks::resolvePorts(spec->inputs, effective);
        const auto outputs = components::blocks::resolvePorts(spec->outputs, effective);
        check(inputs == item.at("inputs").get<std::vector<std::string>>() && outputs == item.at("outputs").get<std::vector<std::string>>(),
              "portas de " + typeId + " " + item.at("properties").dump());
    }
    }
}

/** Todo bloco da especificação tem builder e compila com os parâmetros padrão (entradas soltas). */
void everyBlockCompilesWithDefaults() {
    for (const components::blocks::BlockSpec& spec : components::blocks::blockLibrary()) {
        Harness h;
        try {
            const uint32_t block = h.session.addComponent(spec.typeId, {});
            (void)block;
            h.runUntil(0.01);
            check(true, "compila com padroes: " + spec.typeId);
        } catch (const std::exception& error) {
            // Recusas que o próprio Simulink também faz com a entrada solta (sinal escalar sem taxa):
            // bloco discreto com tempo herdado resolvido como constante, e blocos cujo padrão exige
            // vetor na entrada (Demux de 2 saídas, Fcn com u(2)). Qualquer outra falha é defeito.
            const std::string message = error.what();
            const bool expected = message.find("exige tempo de amostragem discreto") != std::string::npos ||
                                  message.find("largura") != std::string::npos || message.find("faixa fora do vetor") != std::string::npos;
            check(expected, "compila com padroes: " + spec.typeId + " -> " + message);
        }
    }
}

/** Manifesto (JSON) -> definição registrável, como `.lssubcircuit` com sinal. */
SubcircuitDefinition definitionFromJson(const nlohmann::json& manifest) {
    SubcircuitDefinition definition;
    definition.typeId = manifest.at("typeId").get<std::string>();
    definition.name = manifest.value("name", definition.typeId);
    for (const auto& component : manifest.at("components"))
        definition.components.push_back({component.at("id").get<std::string>(), component.at("typeId").get<std::string>(),
                                         component.value("properties", nlohmann::json::object()).dump()});
    for (const auto& wire : manifest.at("wires"))
        definition.wires.push_back({wire[0].get<std::string>(), wire[1].get<std::string>(), wire[2].get<std::string>(), wire[3].get<std::string>()});
    for (const char* pin : {"in", "out"}) {
        SubcircuitInterfaceDef interfaceDef;
        interfaceDef.pinId = pin;
        interfaceDef.label = pin;
        interfaceDef.internalTunnel = pin;
        interfaceDef.domain = "signal";
        interfaceDef.direction = std::string(pin) == "in" ? "in" : "out";
        definition.interfaceDefs.push_back(std::move(interfaceDef));
    }
    return definition;
}

nlohmann::json tunnel(const char* name, bool input) {
    return {{"id", std::string(name) + "-tunnel"}, {"typeId", "connectors.signal_tunnel"},
            {"properties", {{"name", name}, {"pinId", name}, {"direction", input ? "Input" : "Output"}, {"valueType", "Real"}}}};
}

/** Instância de subsistema DENTRO de outro manifesto com `@filho.Param`: vale por instância (é o
 * caminho das conversões compostas da biblioteca, docs/68). in -> a(@k.Gain=3) -> b(modelo, Gain=2). */
void nestedSubsystemInstanceOverrides() {
    Harness h;
    h.session.components().registerFactory("connectors.signal_tunnel", [](const ComponentParams& p) {
        return std::make_unique<components::SignalTunnel>(p);
    });
    h.session.subcircuits().registerDefinition(definitionFromJson({
        {"typeId", "subsystem.dobro"},
        {"components", {tunnel("in", true), {{"id", "k"}, {"typeId", "sl.gain"}, {"properties", {{"Gain", "2"}}}}, tunnel("out", false)}},
        {"wires", {{"in-tunnel", "value", "k", "in1"}, {"k", "out1", "out-tunnel", "value"}}},
    }));
    h.session.subcircuits().registerDefinition(definitionFromJson({
        {"typeId", "subsystem.serie"},
        {"components", {tunnel("in", true), {{"id", "a"}, {"typeId", "subsystem.dobro"}, {"properties", {{"@k.Gain", "3"}}}},
                        {{"id", "b"}, {"typeId", "subsystem.dobro"}, {"properties", nlohmann::json::object()}}, tunnel("out", false)}},
        {"wires", {{"in-tunnel", "value", "a", "in"}, {"a", "out", "b", "in"}, {"b", "out", "out-tunnel", "value"}}},
    }));
    const SubcircuitExpansionResult expansion = h.session.addSubcircuitInstance("subsystem.serie");
    const auto& in = expansion.exposedSignalPins.at("in");
    const auto& out = expansion.exposedSignalPins.at("out");
    const uint32_t one = h.add("constant", {{"Value", text("1")}});
    h.wire(one, "out1", in.instanceId, in.pinId.c_str());
    h.runUntil(0.01);
    const double y = h.session.signalRuntime().real(h.session.signalRuntime().output(signalPortBlockId(out.instanceId, out.pinId)));
    check(y == 6.0, "subsistema aninhado: @k.Gain=3 so na instancia 'a' -> 1*3*2 = 6 (" + std::to_string(y) + ")");

    // Dois níveis: `@b.@k.Gain` na instância de cima chega ao Gain dentro de 'b'.
    Harness h2;
    h2.session.components().registerFactory("connectors.signal_tunnel", [](const ComponentParams& p) {
        return std::make_unique<components::SignalTunnel>(p);
    });
    for (const auto& definition : {h.session.subcircuits().find("subsystem.dobro"), h.session.subcircuits().find("subsystem.serie")})
        h2.session.subcircuits().registerDefinition(*definition);
    h2.session.subcircuits().registerDefinition(definitionFromJson({
        {"typeId", "subsystem.topo"},
        {"components", {tunnel("in", true), {{"id", "s"}, {"typeId", "subsystem.serie"}, {"properties", {{"@b.@k.Gain", "5"}}}}, tunnel("out", false)}},
        {"wires", {{"in-tunnel", "value", "s", "in"}, {"s", "out", "out-tunnel", "value"}}},
    }));
    const SubcircuitExpansionResult top = h2.session.addSubcircuitInstance("subsystem.topo");
    const uint32_t one2 = h2.add("constant", {{"Value", text("1")}});
    h2.wire(one2, "out1", top.exposedSignalPins.at("in").instanceId, top.exposedSignalPins.at("in").pinId.c_str());
    h2.runUntil(0.01);
    const auto& out2 = top.exposedSignalPins.at("out");
    const double y2 = h2.session.signalRuntime().real(h2.session.signalRuntime().output(signalPortBlockId(out2.instanceId, out2.pinId)));
    check(y2 == 15.0, "subsistema em dois niveis: @b.@k.Gain=5 -> 1*3*5 = 15 (" + std::to_string(y2) + ")");

    // O mesmo endereço pelo caminho da Extension (`setSubcircuitChildProperty`, instância de cima).
    const auto error = h2.session.setSubcircuitChildProperty(top.subcircuitInstanceId, "s", "@a.@k.Gain", PropertyValue{std::string("7")});
    check(!error.has_value(), "setSubcircuitChildProperty desce @a.@k.Gain (" + error.value_or("") + ")");
    h2.runUntil(0.02);
    const double y3 = h2.session.signalRuntime().real(h2.session.signalRuntime().output(signalPortBlockId(out2.instanceId, out2.pinId)));
    check(y3 == 35.0, "apos setSubcircuitChildProperty: 1*7*5 = 35 (" + std::to_string(y3) + ")");
}

/** Parâmetro ajustável com o plano compilado (Simulink: tunable muda durante a simulação, sem
 * recompilar): Constant `inf` -> Gain; o valor novo vale a partir do instante seguinte e o estado do
 * integrador a jusante NÃO é reiniciado. Mudança de forma (escalar -> vetor) recompila. */
void tunableParametersLive() {
    Harness h;
    const uint32_t constant = h.add("constant", {{"Value", text("1")}, {"SampleTime", text("inf")}});
    const uint32_t gain = h.add("gain", {{"Gain", text("2")}});
    const uint32_t integrator = h.add("integrator");
    h.wire(constant, "out1", gain, "in1");
    h.wire(gain, "out1", integrator, "in1");
    h.runUntil(1.0);
    check(std::abs(h.value(integrator) - 2.0) < 1e-6, "antes: integral de 2 em 1 s = 2 (" + std::to_string(h.value(integrator)) + ")");
    check(!h.session.setProperty(gain, "Gain", text("5")).has_value(), "Gain e ajustavel com o plano compilado");
    check(!h.session.setProperty(constant, "Value", text("3")).has_value(), "Value da Constant e ajustavel");
    h.runUntil(2.0);
    check(h.value(gain) == 15.0, "Gain e Constant novos valem sem recompilar: 3*5 = 15 (" + std::to_string(h.value(gain)) + ")");
    check(std::abs(h.value(integrator) - 17.0) < 1e-6, "estado do integrador preservado: 2 + 15*1 = 17 (" + std::to_string(h.value(integrator)) + ")");
    check(h.session.setProperty(gain, "Gain", text("[1 2")).has_value(), "expressao invalida e recusada");
    h.runUntil(2.5);
    check(h.value(gain) == 15.0, "valor anterior mantido depois da recusa");
    check(!h.session.setProperty(constant, "Value", text("[1 2]")).has_value(), "mudanca de forma com a simulacao parada e aceita");
    // Como no Simulink, a forma nova vale na próxima compilação (o `start` publica o plano).
    check(h.session.publishSimulationPlan(), "plano republicado com a forma nova");
    h.runUntil(3.0);
    const auto gainSlot = h.session.signalRuntime().output(signalPortBlockId(gain, "out1"));
    check(gainSlot.width == 2 && h.value(gain, "out1", 1) == 10.0,
          "mudanca de forma recompila: [1 2]*5 -> elemento 2 = 10 (largura " + std::to_string(gainSlot.width) + ", y = " +
          std::to_string(h.value(gain, "out1", 0)) + ")");
}

/** Mesmo bit: CalcExpression legado x Fcn convertido (`extension/src/migration/controlLibrary/
 * legacyExpression.ts`), sobre TODAS as expressões gravadas no repositório (fixture gerada pelo teste
 * da migração com amostras e o valor do interpretador legado em TS). Prova a conversão textual
 * (precedência, associatividade, números) contra os dois motores reais do Core. */
void calcExpressionConversionIsBitExact() {
    std::ifstream input(std::filesystem::path(PORT_VECTORS_DIR) / "calc-expression-conversions.json");
    check(input.good(), "fixture de expressoes convertidas existe");
    if (!input.good()) return;
    const nlohmann::json root = nlohmann::json::parse(input);
    const auto same = [](double a, double b) { return (std::isnan(a) && std::isnan(b)) || std::memcmp(&a, &b, sizeof(double)) == 0; };
    size_t compared = 0, mismatches = 0, legacyMismatches = 0;
    for (const auto& item : root.at("cases")) {
        const auto inputs = item.at("inputs").get<std::vector<std::string>>();
        const std::string legacyText = item.at("expression").get<std::string>();
        const std::string fcnText = item.at("fcn").get<std::string>();
        const auto& samples = item.at("samples");
        const auto& legacyTs = item.at("legacy");
        // Legado: Sources -> CalcExpression, pelo SignalEngine.
        SignalGraphDefinition legacy;
        Harness h;
        std::vector<uint32_t> fcnBlocks;
        for (size_t k = 0; k < samples.size(); ++k) {
            SignalBlockDefinition calc;
            calc.id = "calc" + std::to_string(k);
            calc.kind = SignalBlockKind::CalcExpression;
            calc.output = {"out", {SignalScalarType::Real, 1}, ""};
            calc.expression = legacyText;
            std::vector<uint32_t> constants;
            for (size_t i = 0; i < inputs.size(); ++i) {
                const double value = samples[k][i].get<double>();
                SignalBlockDefinition source;
                source.id = "s" + std::to_string(k) + "_" + std::to_string(i);
                source.kind = SignalBlockKind::Source;
                source.output = {"out", {SignalScalarType::Real, 1}, ""};
                source.realParameters = {value};
                legacy.blocks.push_back(source);
                calc.inputs.push_back({inputs[i], {SignalScalarType::Real, 1}, ""});
                legacy.connections.push_back({source.id, "out", calc.id, inputs[i], false});
                char text[64];
                std::snprintf(text, sizeof text, "%.17g", value);
                constants.push_back(h.add("constant", {{"Value", PropertyValue{std::string(text)}}}));
            }
            legacy.blocks.push_back(calc);
            // Novo: Constant(s) [-> Mux] -> Fcn, pela sessão (o caminho real dos blocos `sl.*`).
            const uint32_t fcn = h.add("fcn", {{"Expr", PropertyValue{fcnText}}});
            if (constants.size() == 1) h.wire(constants[0], "out1", fcn, "in1");
            else {
                const uint32_t mux = h.add("mux", {{"Inputs", PropertyValue{std::to_string(constants.size())}}});
                for (size_t i = 0; i < constants.size(); ++i) h.wire(constants[i], "out1", mux, ("in" + std::to_string(i + 1)).c_str());
                h.wire(mux, "out1", fcn, "in1");
            }
            fcnBlocks.push_back(fcn);
        }
        SignalRuntime runtime;
        runtime.bind(SignalCompiler::compile(legacy));
        runtime.executeUntil(0);
        h.runUntil(0.001);
        for (size_t k = 0; k < samples.size(); ++k) {
            const double old = runtime.real(runtime.output("calc" + std::to_string(k)));
            const double converted = h.value(fcnBlocks[k]);
            const double ts = legacyTs[k].is_null() ? std::numeric_limits<double>::quiet_NaN() : legacyTs[k].get<double>();
            ++compared;
            if (!same(old, converted)) {
                if (++mismatches <= 5) std::fprintf(stderr, "  diverge: %s | %s -> %.17g x %.17g\n", legacyText.c_str(), fcnText.c_str(), old, converted);
            }
            // O interpretador TS só gera a fixture: `Math.pow` do V8 e `std::pow` do MSVC podem diferir no
            // último bit; a migração não depende dele (não avalia expressões), só a fixture.
            if (!same(old, ts) && !(std::isinf(old) && std::isinf(ts))) {
                const double ulps = std::abs(old - ts) / std::max(std::abs(old) * std::numeric_limits<double>::epsilon(), std::numeric_limits<double>::denorm_min());
                if (ulps > 4.0 && ++legacyMismatches <= 3)
                    std::fprintf(stderr, "  TS x Core: %s -> %.17g x %.17g (%.1f ulp)\n", legacyText.c_str(), old, ts, ulps);
            }
        }
    }
    check(compared > 300, "amostras comparadas: " + std::to_string(compared));
    check(mismatches == 0, "Fcn convertido = CalcExpression legado bit a bit (" + std::to_string(mismatches) + " divergencias)");
    check(legacyMismatches == 0, "interpretador legado da migracao (TS) = CalcExpression do Core (" + std::to_string(legacyMismatches) + " divergencias)");
}

} // namespace

int main() {
    const std::pair<const char*, std::function<void()>> cases[] = {
        {"stepIntoTransferFunction", stepIntoTransferFunction},
        {"inheritanceConstantAndContinuous", inheritanceConstantAndContinuous},
        {"muxDemuxAndFcn", muxDemuxAndFcn},
        {"discreteTransferFunction", discreteTransferFunction},
        {"continuousPiLoop", continuousPiLoop},
        {"integratorResetPort", integratorResetPort},
        {"discreteBlockRejectsContinuousInput", discreteBlockRejectsContinuousInput},
        {"legacyConstantFeedsLibraryBlock", legacyConstantFeedsLibraryBlock},
        {"sharedPortVectors", sharedPortVectors},
        {"everyBlockCompilesWithDefaults", everyBlockCompilesWithDefaults},
        {"nestedSubsystemInstanceOverrides", nestedSubsystemInstanceOverrides},
        {"tunableParametersLive", tunableParametersLive},
        {"calcExpressionConversionIsBitExact", calcExpressionConversionIsBitExact},
    };
    for (const auto& [name, test] : cases) {
        try { test(); } catch (const std::exception& error) { check(false, std::string(name) + " lancou: " + error.what()); }
    }
    if (failures == 0) std::puts("LibraryBlockSessionTest: OK");
    return failures == 0 ? 0 : 1;
}
