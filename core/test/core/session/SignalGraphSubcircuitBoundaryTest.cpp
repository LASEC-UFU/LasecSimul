// Fecha o item 6/16(g) do gate de materializacao de portas Signal Graph (HART Device Engine v2,
// FEAT-013): fronteira de `.lssubcircuit` para o dominio Signal Graph, generica -- SEM nenhum caso
// especial de HART. `SimulationSession::expandSubcircuit` ja resolvia fronteira ELETRICA via
// `connectors.tunnel`/`SubcircuitInterfaceDef` (`domain=="electrical"`); este teste prova a MESMA
// resolucao para `domain=="signal"`, via o novo `components::SignalTunnel` (`connectors.signal_
// tunnel`) + `SubcircuitExpansionResult::exposedSignalPins` (mapa SEPARADO de `exposedPins`, nunca
// fundido -- ver SignalTunnel.hpp e a doc de `exposedSignalPins` em SimulationSession.hpp).
//
// Padrao de construcao de subcircuito (SubcircuitDefinition/registerDefinition/addSubcircuitInstance)
// copiado deliberadamente de subcircuit_test.cpp (o teste de fronteira ELETRICA ja existente) --
// mesma infraestrutura, mesma convencao, só o dominio muda.
#include <cmath>
#include <cstdio>
#include <memory>
#include <optional>

#include "components/connectors/SignalTunnel.hpp"
#include "lasecsimul/IComponentModel.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "protocols/HartCommunicationComponent.hpp"
#include "registry/SubcircuitRegistry.hpp"
#include "session/SimulationSession.hpp"

using namespace lasecsimul;
using namespace lasecsimul::registry;
using namespace lasecsimul::plugins;
using namespace lasecsimul::session;
using namespace lasecsimul::simulation;

namespace {

int failures = 0;
void check(bool ok, const char* label) {
    if (ok) std::printf("OK: %s\n", label);
    else { std::fprintf(stderr, "FALHOU: %s\n", label); ++failures; }
}

class FakeSignalSource final : public IComponentModel {
public:
    const char* typeId() const override { return "test.fake_signal_source"; }
    std::span<Pin> pins() override { return {}; }
    void stamp(MnaMatrixView&) override {}
    void postStep(uint64_t) override {}
    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}
    std::vector<SignalPortDescriptor> signalPorts() const override {
        return {{"value", SignalPortDirection::Output, SignalValueKind::Analog, "kPa"}};
    }
};

class FakeSignalSink final : public IComponentModel {
public:
    const char* typeId() const override { return "test.fake_signal_sink"; }
    std::span<Pin> pins() override { return {}; }
    void stamp(MnaMatrixView&) override {}
    void postStep(uint64_t) override {}
    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}
    std::vector<SignalPortDescriptor> signalPorts() const override {
        return {{"reading", SignalPortDirection::Input, SignalValueKind::Analog, "kPa"}};
    }
};

void registerCommon(SimulationSession& session) {
    session.components().registerFactory("connectors.signal_tunnel", [](const ComponentParams& p) {
        return std::make_unique<components::SignalTunnel>(p);
    });
    session.components().registerFactory("test.fake_signal_source", [](const ComponentParams&) {
        return std::make_unique<FakeSignalSource>();
    });
    session.components().registerFactory("test.fake_signal_sink", [](const ComponentParams&) {
        return std::make_unique<FakeSignalSink>();
    });
}

ComponentParams signalTunnelParams(const std::string& name, const std::string& direction,
                                    const std::string& valueType = "Real", const std::string& unit = "kPa") {
    ComponentParams p;
    p.properties["name"] = name;
    p.properties["direction"] = direction;
    p.properties["valueType"] = valueType;
    p.properties["unit"] = unit;
    return p;
}

/** Subcircuito folha: expoe DOIS pares Input/Output (um Real "pressure", um Bool "alarm") --
 * usado pelos testes 1/2/3 (input/output/multiplos portos) e como bloco de dentro de
 * `makeSignalWrapperDefinition` (teste 4, aninhamento). */
// NOTA sobre a "conexão interna direta tunnel->tunnel": `connectSignalWireUnlocked`'s exceção de
// papel-coringa (ver comentário lá) só se aplica quando EXATAMENTE um lado é `connectors.
// signal_tunnel` -- dois tunnels ligados direto um no outro caem no caso normal (direção
// DECLARADA de cada um decide fonte/alvo, não a ordem "from"/"to" do fio), o que inverteria o
// sentido pretendido de um "passthrough" puro feito só de tunnels. Por isso este subcircuito usa
// um `test.fake_signal_sink`/`test.fake_signal_source` internos DE VERDADE como o "bloco interno"
// entre a fronteira de entrada e a de saída -- exatamente o cenário descrito nos testes 1/2
// ("exposed input -> internal block", "internal block -> exposed output"), e o jeito correto de
// obter a orientação certa (tunnel + componente NÃO-tunnel sempre aciona o papel-coringa).
SubcircuitDefinition makeSignalPassthroughDefinition() {
    SubcircuitDefinition def;
    def.typeId = "subcircuits.signal_passthrough";
    def.name = "Signal Passthrough";
    def.components = {
        {"internal_source", "test.fake_signal_source", "{}"},
        {"internal_sink", "test.fake_signal_sink", "{}"},
        {"sig_in_a", "connectors.signal_tunnel", R"({"name":"IN_A","direction":"Input","valueType":"Real","unit":"kPa"})"},
        {"sig_out_a", "connectors.signal_tunnel", R"({"name":"OUT_A","direction":"Output","valueType":"Real","unit":"kPa"})"},
        {"sig_in_b", "connectors.signal_tunnel", R"({"name":"IN_B","direction":"Input","valueType":"Bool","unit":""})"},
        {"sig_out_b", "connectors.signal_tunnel", R"({"name":"OUT_B","direction":"Output","valueType":"Bool","unit":""})"},
    };
    def.wires = {
        // Exposed INPUT (sig_in_a) -> bloco interno REAL (internal_sink) -- teste 1.
        {"sig_in_a", "value", "internal_sink", "reading"},
        // Bloco interno REAL (internal_source) -> exposed OUTPUT (sig_out_a) -- teste 2.
        {"internal_source", "value", "sig_out_a", "value"},
        // sig_in_b/sig_out_b deliberadamente SEM fio interno -- só existem pra provar (teste 3)
        // que um par de fronteira não relacionado não interfere no par "pressure" acima.
    };
    def.interfaceDefs = {
        {"pressureIn", "Pressao (entrada)", "IN_A", "signal", "in", "Real", 1, "kPa"},
        {"pressureOut", "Pressao (saida)", "OUT_A", "signal", "out", "Real", 1, "kPa"},
        {"alarmIn", "Alarme (entrada)", "IN_B", "signal", "in", "Bool", 1, ""},
        {"alarmOut", "Alarme (saida)", "OUT_B", "signal", "out", "Bool", 1, ""},
    };
    return def;
}

/** Subcircuito que CONTEM uma instancia de `subcircuits.signal_passthrough` e reexpoe
 * "pressureIn"/"pressureOut" na SUA PRÓPRIA fronteira -- prova resolucao recursiva (teste 4). */
SubcircuitDefinition makeSignalWrapperDefinition() {
    SubcircuitDefinition def;
    def.typeId = "subcircuits.signal_wrapper";
    def.name = "Signal Wrapper (aninhado)";
    def.components = {
        {"inner", "subcircuits.signal_passthrough", "{}"},
        {"wrap_in", "connectors.signal_tunnel", R"({"name":"WRAP_IN","direction":"Input","valueType":"Real","unit":"kPa"})"},
        {"wrap_out", "connectors.signal_tunnel", R"({"name":"WRAP_OUT","direction":"Output","valueType":"Real","unit":"kPa"})"},
    };
    def.wires = {
        {"wrap_in", "value", "inner", "pressureIn"},
        {"inner", "pressureOut", "wrap_out", "value"},
    };
    def.interfaceDefs = {
        {"boundaryIn", "Entrada", "WRAP_IN", "signal", "in", "Real", 1, "kPa"},
        {"boundaryOut", "Saida", "WRAP_OUT", "signal", "out", "Real", 1, "kPa"},
    };
    return def;
}

/** Subcircuito com um HartCommunicationComponent REAL dentro, Output "measured" exposto na
 * fronteira -- prova teste 6 (HART Output atraves de porta exposta). */
SubcircuitDefinition makeHartOutputWrapperDefinition() {
    SubcircuitDefinition def;
    def.typeId = "subcircuits.hart_output_wrapper";
    def.name = "HART Output Wrapper";
    def.components = {
        {"hart", "protocol.hart.serial",
         R"({"bus":"hart-sub-out","endpoint":"COM40","uniqueId":"DDDDDD","pollingAddress":5,"enabled":true,)"
         R"("hartVariablesJson":"[{\"id\":\"measured\",\"name\":\"Measured\",\"type\":\"Float32\",\"direction\":\"Output\",\"value\":66.0,\"unit\":\"kPa\"}]"})"},
        {"sig_out", "connectors.signal_tunnel", R"({"name":"OUT","direction":"Output","valueType":"Real","unit":"kPa"})"},
    };
    def.wires = {{"hart", "measured", "sig_out", "value"}};
    def.interfaceDefs = {{"hartMeasured", "HART Measured", "OUT", "signal", "out", "Real", 1, "kPa"}};
    return def;
}

/** Espelho do anterior: HART Input "setpoint" exposto na fronteira -- prova teste 5. */
SubcircuitDefinition makeHartInputWrapperDefinition() {
    SubcircuitDefinition def;
    def.typeId = "subcircuits.hart_input_wrapper";
    def.name = "HART Input Wrapper";
    def.components = {
        {"hart", "protocol.hart.serial",
         R"({"bus":"hart-sub-in","endpoint":"COM41","uniqueId":"EEEEEE","pollingAddress":6,"enabled":true,)"
         R"("hartVariablesJson":"[{\"id\":\"setpoint\",\"name\":\"Setpoint\",\"type\":\"Float32\",\"direction\":\"Input\",\"value\":0.0,\"unit\":\"kPa\"}]"})"},
        {"sig_in", "connectors.signal_tunnel", R"({"name":"IN","direction":"Input","valueType":"Real","unit":"kPa"})"},
    };
    def.wires = {{"sig_in", "value", "hart", "setpoint"}};
    def.interfaceDefs = {{"hartSetpoint", "HART Setpoint", "IN", "signal", "in", "Real", 1, "kPa"}};
    return def;
}

void registerHartFactory(SimulationSession& session) {
    session.components().registerFactory("protocol.hart.serial", [&session](const ComponentParams& p) {
        return std::make_unique<protocols::HartCommunicationComponent>(
            protocols::HartCommunicationComponent::Mode::Serial, session.scheduler(), p);
    });
}

// (1)+(2)+(3): fonte externa -> entrada exposta -> grafo interno -> saida exposta -> consumidor
// externo, com MULTIPLOS portos simultaneos (Real "pressure" + Bool "alarm") sem cross-talk.
void genericSubcircuitExposesSignalInputAndOutput() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerCommon(session);
    session.subcircuits().registerDefinition(makeSignalPassthroughDefinition());

    // Ordem determinística de criação (`expandSubcircuit` processa `def.components` em ordem, e
    // esta é a primeira operação de uma sessão nova): internal_source=0, internal_sink=1,
    // sig_in_a=2, sig_out_a=3, sig_in_b=4, sig_out_b=5.
    constexpr uint32_t kInternalSource = 0;
    constexpr uint32_t kInternalSink = 1;
    const SubcircuitExpansionResult expansion = session.addSubcircuitInstance("subcircuits.signal_passthrough");
    check(expansion.exposedPins.empty(), "subcircuito 100% Signal Graph nao expoe NENHUM pino eletrico");
    check(expansion.exposedSignalPins.size() == 4,
          "os 4 pinos de interface domain=signal aparecem em exposedSignalPins, nenhum em exposedPins");

    const uint32_t pressureSource = session.addComponent("test.fake_signal_source", {});
    const auto& pressureIn = expansion.exposedSignalPins.at("pressureIn");
    session.connectWire(pressureSource, "value", pressureIn.instanceId, pressureIn.pinId);

    const auto plan = session.simulationPlan();
    check(plan != nullptr && plan->signal && plan->signal->engine,
          "sessao com fio externo -> fronteira signal (entrada) -> bloco interno compila");

    session.scheduler().runUntil(1);
    const double observed = session.signalRuntime().real(session.signalRuntime().output(signalPortBlockId(kInternalSink, "reading")));
    check(std::abs(observed) < 1e-9,
          "(1) sem valor publicado ainda pela fonte externa, o bloco interno le o default (0.0) -- "
          "baseline antes de setar a fonte (prova que a fronteira compila e resolve, mesmo sem "
          "valor != 0 ainda)");
    (void)kInternalSource;
}

// Dirige um valor real pela fonte externa (via um SignalRuntime proprio vinculado ao
// CompiledSignalGraph publicado -- mesma tecnica de SignalGraphWiringTest.cpp, já que a sessao só
// expõe `signalRuntime()` como `const&`) e confere os DOIS pares de porta (pressure Real + alarm
// Bool) em paralelo, provando ausencia de cross-talk entre pares de fronteira distintos (teste 3),
// além de fechar o teste 2 (bloco interno -> saida exposta -> consumidor externo).
void multiplePortsCrossValuesIndependently() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerCommon(session);
    session.subcircuits().registerDefinition(makeSignalPassthroughDefinition());
    constexpr uint32_t kInternalSource = 0;
    constexpr uint32_t kInternalSink = 1;
    const SubcircuitExpansionResult expansion = session.addSubcircuitInstance("subcircuits.signal_passthrough");

    const uint32_t pressureSource = session.addComponent("test.fake_signal_source", {});
    const uint32_t pressureSink = session.addComponent("test.fake_signal_sink", {});
    const auto& pressureIn = expansion.exposedSignalPins.at("pressureIn");
    const auto& pressureOut = expansion.exposedSignalPins.at("pressureOut");
    session.connectWire(pressureSource, "value", pressureIn.instanceId, pressureIn.pinId);
    session.connectWire(pressureOut.instanceId, pressureOut.pinId, pressureSink, "reading");

    const auto plan = session.simulationPlan();
    check(plan != nullptr && plan->signal && plan->signal->engine, "plano com 4 portos de fronteira compila");

    SignalRuntime runtime;
    runtime.bind(plan->signal->engine);
    // Teste 1 (entrada exposta -> bloco interno), agora com um valor de verdade.
    runtime.setExternalReal(signalPortBlockId(pressureSource, "value"), 41.5);
    // Teste 2 (bloco interno -> saida exposta): o "bloco interno" É o produtor aqui
    // (`internal_source`), dirigido diretamente -- nada externo o alimenta.
    runtime.setExternalReal(signalPortBlockId(kInternalSource, "value"), 77.25);
    runtime.executeUntil(1);

    const double atInternalSink = runtime.real(runtime.output(signalPortBlockId(kInternalSink, "reading")));
    check(std::abs(atInternalSink - 41.5) < 1e-9,
          "(1) fonte externa -> entrada exposta (pressureIn) -> bloco interno (internal_sink) "
          "entrega o valor certo");

    const double atExternalSink = runtime.real(runtime.output(signalPortBlockId(pressureSink, "reading")));
    check(std::abs(atExternalSink - 77.25) < 1e-9,
          "(2) bloco interno (internal_source) -> saida exposta (pressureOut) -> consumidor "
          "externo entrega o valor certo");

    // O par "alarm" (Bool) nao foi ligado a NADA (nem externa nem internamente) -- prova que ele
    // nao compila quebrado (degrada pro default ExternalInput, mesma regra de porto nao fiado) e
    // nao interfere nos valores do par "pressure" acima (re-confere os DOIS, ainda corretos).
    const double atInternalSinkAfter = runtime.real(runtime.output(signalPortBlockId(kInternalSink, "reading")));
    const double atExternalSinkAfter = runtime.real(runtime.output(signalPortBlockId(pressureSink, "reading")));
    check(std::abs(atInternalSinkAfter - 41.5) < 1e-9 && std::abs(atExternalSinkAfter - 77.25) < 1e-9,
          "(3) o par de fronteira NAO relacionado (alarm, sem nenhum fio) nao afeta os valores do "
          "par pressure (sem cross-talk)");
}

// (4) subcircuito aninhado: top-level -> subcircuito A (wrapper) -> subcircuito B aninhado
// (passthrough) -> bloco interno -> conexao de runtime correta, atravessando DOIS niveis de
// fronteira Signal Graph.
void nestedSubcircuitSignalBoundaryResolvesRecursively() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerCommon(session);
    session.subcircuits().registerDefinition(makeSignalPassthroughDefinition());
    session.subcircuits().registerDefinition(makeSignalWrapperDefinition());

    // A expansao aninhada roda PRIMEIRO (o componente "inner" do wrapper é, ele próprio, outro
    // subcircuito -- `expandSubcircuit` expande recursivamente ANTES de processar o resto de
    // `def.components` do nível de fora, ver o loop principal). Numa sessão nova, isso significa
    // que os componentes do "signal_passthrough" interno pegam os PRIMEIROS índices da sessão
    // inteira -- mesma ordem determinística do teste plano (internal_source=0, internal_sink=1).
    constexpr uint32_t kInnerInternalSource = 0;
    constexpr uint32_t kInnerInternalSink = 1;
    const SubcircuitExpansionResult expansion = session.addSubcircuitInstance("subcircuits.signal_wrapper");
    check(expansion.exposedSignalPins.size() == 2, "wrapper reexpoe exatamente os 2 pinos que declarou (boundaryIn/boundaryOut)");

    const uint32_t source = session.addComponent("test.fake_signal_source", {});
    const uint32_t sink = session.addComponent("test.fake_signal_sink", {});
    const auto& boundaryIn = expansion.exposedSignalPins.at("boundaryIn");
    const auto& boundaryOut = expansion.exposedSignalPins.at("boundaryOut");
    session.connectWire(source, "value", boundaryIn.instanceId, boundaryIn.pinId);
    session.connectWire(boundaryOut.instanceId, boundaryOut.pinId, sink, "reading");

    const auto plan = session.simulationPlan();
    check(plan != nullptr && plan->signal && plan->signal->engine, "topologia com subcircuito aninhado compila");

    SignalRuntime runtime;
    runtime.bind(plan->signal->engine);
    // Duas cadeias independentes atravessam os DOIS niveis de fronteira (exatamente como no teste
    // plano -- `signal_passthrough` nao tem um passthrough literal ponta-a-ponta, tem um bloco de
    // entrada e um de saida distintos, ver comentario em `makeSignalPassthroughDefinition`):
    // (a) top-level source -> wrapper.boundaryIn -> inner.pressureIn -> inner.internal_sink;
    // (b) inner.internal_source -> inner.pressureOut -> wrapper.boundaryOut -> top-level sink.
    runtime.setExternalReal(signalPortBlockId(source, "value"), 88.25);
    runtime.setExternalReal(signalPortBlockId(kInnerInternalSource, "value"), 12.5);
    runtime.executeUntil(1);

    const double atInnerSink = runtime.real(runtime.output(signalPortBlockId(kInnerInternalSink, "reading")));
    check(std::abs(atInnerSink - 88.25) < 1e-9,
          "(4a) top-level source -> boundary IN do wrapper -> boundary IN do subcircuito aninhado "
          "-> bloco interno do aninhado, atravessando DOIS niveis de fronteira Signal Graph");

    const double atTopSink = runtime.real(runtime.output(signalPortBlockId(sink, "reading")));
    check(std::abs(atTopSink - 12.5) < 1e-9,
          "(4b) bloco interno do subcircuito aninhado -> boundary OUT do aninhado -> boundary OUT "
          "do wrapper -> consumidor top-level, atravessando DOIS niveis de fronteira Signal Graph");
}

// (6) HART Output -> internal generic signal output -> exposed subcircuit signal output ->
// downstream external wire funciona -- SEM nenhum caminho especial de HART no compilador (o HART
// so' é mais um IComponentModel com signalPorts(), exatamente como os fakes acima).
void hartOutputThroughExposedSubcircuitPort() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerCommon(session);
    registerHartFactory(session);
    session.subcircuits().registerDefinition(makeHartOutputWrapperDefinition());

    const SubcircuitExpansionResult expansion = session.addSubcircuitInstance("subcircuits.hart_output_wrapper");
    const uint32_t sink = session.addComponent("test.fake_signal_sink", {});
    const auto& hartMeasured = expansion.exposedSignalPins.at("hartMeasured");
    session.connectWire(hartMeasured.instanceId, hartMeasured.pinId, sink, "reading");

    const auto plan = session.simulationPlan();
    check(plan != nullptr && plan->signal && plan->signal->engine, "subcircuito com HART real dentro compila");
    session.scheduler().runUntil(1);
    const double observed = session.signalRuntime().real(session.signalRuntime().output(signalPortBlockId(sink, "reading")));
    check(std::abs(observed - 66.0) < 1e-9,
          "(6) HART Output (dentro do subcircuito) -> porta exposta -> consumidor externo recebe o "
          "valor real do dispositivo, via publishHartOutputsToSignalUnlocked de verdade");
}

// (5) Signal source externa -> exposed subcircuit signal input -> internal generic signal input ->
// HART variable Input, verificado via a MESMA janela pública (session.signalRuntime()) que
// sampleHartInputsFromSignalUnlocked usa internamente -- ver justificativa em
// SignalGraphWiringTest.cpp (nao reabre a auditoria de comandos HART pra decodificar um comando
// real só pra ler o valor de volta).
void hartInputThroughExposedSubcircuitPort() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerCommon(session);
    registerHartFactory(session);
    session.subcircuits().registerDefinition(makeHartInputWrapperDefinition());

    // `addSubcircuitInstance` é a PRIMEIRA operação que cria componentes nesta sessão -- os
    // `components[]` de `makeHartInputWrapperDefinition` são processados em ordem
    // (`expandSubcircuit`), então "hart" (o primeiro da lista) recebe componentIndex 0, "sig_in" o
    // índice 1. `addSubcircuitInstance` só devolve `exposedSignalPins` (que aponta pro TUNNEL, não
    // pro HART) -- pra observar o bloco do PRÓPRIO HART (a prova real de que o valor atravessou a
    // fronteira e chegou até o consumidor final, não só até o relay), este teste depende dessa
    // ordem determinística em vez de expor um accessor novo só para isto.
    constexpr uint32_t kHartComponentIndex = 0;
    const SubcircuitExpansionResult expansion = session.addSubcircuitInstance("subcircuits.hart_input_wrapper");
    const uint32_t source = session.addComponent("test.fake_signal_source", {});
    const auto& hartSetpoint = expansion.exposedSignalPins.at("hartSetpoint");
    session.connectWire(source, "value", hartSetpoint.instanceId, hartSetpoint.pinId);

    const auto plan = session.simulationPlan();
    check(plan != nullptr && plan->signal && plan->signal->engine, "subcircuito com HART Input real dentro compila");

    SignalRuntime runtime;
    runtime.bind(plan->signal->engine);
    runtime.setExternalReal(signalPortBlockId(source, "value"), 33.75);
    runtime.executeUntil(1);
    const double atBoundary = runtime.real(runtime.output(signalPortBlockId(hartSetpoint.instanceId, hartSetpoint.pinId)));
    check(std::abs(atBoundary - 33.75) < 1e-9,
          "(5a) o SignalTunnel de fronteira observa o valor publicado pela fonte externa");
    const double atHart = runtime.real(runtime.output(signalPortBlockId(kHartComponentIndex, "setpoint")));
    check(std::abs(atHart - 33.75) < 1e-9,
          "(5b) o valor atravessa o fio interno relay->HART: o proprio bloco materializado da "
          "variavel HART \"setpoint\" observa o mesmo valor que chegou pela fronteira externa");
}

// (7) identidade estavel: renomear o display `name` da variavel HART exposta na fronteira (mantendo
// o `id`) nunca deveria derrubar o fio externo -- mesma garantia de SignalGraphWiringTest.cpp
// (`renamingDisplayNameNeverBreaksAnExistingWire`), agora atravessando uma fronteira de subcircuito.
void renamingHartDisplayNameInsideSubcircuitNeverBreaksBoundaryWire() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerCommon(session);
    registerHartFactory(session);
    session.subcircuits().registerDefinition(makeHartOutputWrapperDefinition());
    constexpr uint32_t kHartComponentIndex = 0;

    const SubcircuitExpansionResult expansion = session.addSubcircuitInstance("subcircuits.hart_output_wrapper");
    const uint32_t sink = session.addComponent("test.fake_signal_sink", {});
    const auto& hartMeasured = expansion.exposedSignalPins.at("hartMeasured");
    session.connectWire(hartMeasured.instanceId, hartMeasured.pinId, sink, "reading");

    session.scheduler().runUntil(1);
    const double beforeRename = session.signalRuntime().real(session.signalRuntime().output(signalPortBlockId(sink, "reading")));
    check(std::abs(beforeRename - 66.0) < 1e-9, "fio de fronteira entrega o valor certo ANTES do rename (baseline)");

    const auto renameError = session.setProperty(kHartComponentIndex, "hartVariablesJson", PropertyValue{std::string(
        R"([{"id":"measured","name":"ProcessMeasured","type":"Float32","direction":"Output","value":66.0,"unit":"kPa"}])")});
    check(!renameError.has_value(), "renomear so' o display name da variavel HART exposta e' aceito");

    const auto planAfterRename = session.simulationPlan();
    check(planAfterRename != nullptr, "sessao continua compilando depois do rename dentro do subcircuito");
    session.scheduler().runUntil(2);
    const double afterRename = session.signalRuntime().real(session.signalRuntime().output(signalPortBlockId(sink, "reading")));
    check(std::abs(afterRename - 66.0) < 1e-9,
          "(7) fio de fronteira sobrevive ao rename do display name da variavel HART -- MESMO id, "
          "MESMA conexao, MESMO valor entregue atraves da fronteira de subcircuito");
}

// (10) casos invalidos de fronteira: endpoint interno inexistente, direcao incompativel, escritor
// duplicado, porta exposta orfa -- todos rejeitados atomicamente, sem mutacao parcial.
void invalidSignalBoundaryDeclarationsAreRejected() {
    // (10a) interface de sinal referencia um SignalTunnel interno que nao existe.
    {
        GlobalPluginCache cache;
        SimulationSession session(cache);
        registerCommon(session);
        SubcircuitDefinition def;
        def.typeId = "subcircuits.dangling_signal_interface";
        def.components = {{"sig_out", "connectors.signal_tunnel", R"({"name":"OUT","direction":"Output","valueType":"Real"})"}};
        def.interfaceDefs = {{"pinId", "label", "NAO_EXISTE", "signal", "out", "Real", 1, ""}};
        session.subcircuits().registerDefinition(std::move(def));
        bool rejected = false;
        try { session.addSubcircuitInstance("subcircuits.dangling_signal_interface"); }
        catch (const std::runtime_error&) { rejected = true; }
        check(rejected, "(10a) interface de sinal referenciando SignalTunnel interno inexistente e' rejeitada atomicamente");
    }
    // (10b) direcao declarada na interface diverge da direcao real do SignalTunnel interno.
    {
        GlobalPluginCache cache;
        SimulationSession session(cache);
        registerCommon(session);
        SubcircuitDefinition def;
        def.typeId = "subcircuits.wrong_direction_signal_interface";
        def.components = {{"sig_out", "connectors.signal_tunnel", R"({"name":"OUT","direction":"Output","valueType":"Real"})"}};
        // Declara "in" (esperaria um SignalTunnel Input por dentro), mas o SignalTunnel real e' Output.
        def.interfaceDefs = {{"pinId", "label", "OUT", "signal", "in", "Real", 1, ""}};
        session.subcircuits().registerDefinition(std::move(def));
        bool rejected = false;
        try { session.addSubcircuitInstance("subcircuits.wrong_direction_signal_interface"); }
        catch (const std::runtime_error&) { rejected = true; }
        check(rejected, "(10b) direction declarada incompativel com o SignalTunnel real e' rejeitada atomicamente");
    }
    // (10c) escritor duplicado: dois fios externos tentando dirigir a MESMA porta de entrada exposta.
    {
        GlobalPluginCache cache;
        SimulationSession session(cache);
        registerCommon(session);
        session.subcircuits().registerDefinition(makeSignalPassthroughDefinition());
        const SubcircuitExpansionResult expansion = session.addSubcircuitInstance("subcircuits.signal_passthrough");
        const uint32_t sourceA = session.addComponent("test.fake_signal_source", {});
        const uint32_t sourceB = session.addComponent("test.fake_signal_source", {});
        const auto& pressureIn = expansion.exposedSignalPins.at("pressureIn");
        session.connectWire(sourceA, "value", pressureIn.instanceId, pressureIn.pinId);
        bool rejected = false;
        try { session.connectWire(sourceB, "value", pressureIn.instanceId, pressureIn.pinId); }
        catch (const std::invalid_argument&) { rejected = true; }
        check(rejected, "(10c) segundo fio externo tentando dirigir a MESMA porta de entrada exposta e' rejeitado "
                        "(single-writer atravessa a fronteira de subcircuito tambem)");
        const auto plan = session.simulationPlan();
        check(plan != nullptr, "estado permanece consistente apos tentativa de segundo escritor na fronteira");
    }
    // (10d) porta exposta cujo pinId colide entre duas entradas de interface[] (uma eletrica, uma
    // de sinal) -- nunca ambiguo, sempre rejeitado antes de compilar qualquer coisa.
    {
        GlobalPluginCache cache;
        SimulationSession session(cache);
        registerCommon(session);
        SubcircuitDefinition def;
        def.typeId = "subcircuits.duplicate_boundary_pin_id";
        def.components = {{"sig_out", "connectors.signal_tunnel", R"({"name":"OUT","direction":"Output","valueType":"Real"})"}};
        def.interfaceDefs = {
            {"shared", "label1", "OUT", "signal", "out", "Real", 1, ""},
            {"shared", "label2", "OUT", "signal", "out", "Real", 1, ""},
        };
        session.subcircuits().registerDefinition(std::move(def));
        bool rejected = false;
        try { session.addSubcircuitInstance("subcircuits.duplicate_boundary_pin_id"); }
        catch (const std::runtime_error&) { rejected = true; }
        check(rejected, "(10d) pinId de interface duplicado (mesmo dentro do mesmo dominio) e' rejeitado atomicamente");
    }
}

// (8) save/reopen: Core não tem memória entre processos (ver justificativa completa em
// SignalGraphWiringTest.cpp::freshSessionReplayingSameSequenceReproducesTheSameWire) -- "reabrir"
// um projeto com um subcircuito instanciado é reconstruir do zero via `addSubcircuitInstance` +
// `connectWire` (mesma sequência que qualquer rebuild da Extension replaya). Prova a equivalência
// para a fronteira Signal Graph também: uma segunda sessão, construída do zero com a MESMA
// sequência, produz a MESMA conexão de fronteira funcionando.
void freshSessionReplayingSubcircuitBoundarySequenceReproducesSameWire() {
    const auto buildAndWire = [](SimulationSession& session) -> std::pair<uint32_t, SubcircuitExposedPin> {
        registerCommon(session);
        session.subcircuits().registerDefinition(makeSignalPassthroughDefinition());
        const SubcircuitExpansionResult expansion = session.addSubcircuitInstance("subcircuits.signal_passthrough");
        const uint32_t source = session.addComponent("test.fake_signal_source", {});
        const auto& pressureIn = expansion.exposedSignalPins.at("pressureIn");
        session.connectWire(source, "value", pressureIn.instanceId, pressureIn.pinId);
        return {source, pressureIn};
    };
    constexpr uint32_t kInternalSink = 1;

    GlobalPluginCache cacheA;
    SimulationSession sessionA(cacheA);
    buildAndWire(sessionA);
    const auto planA = sessionA.simulationPlan();
    check(planA != nullptr && planA->signal && planA->signal->engine, "sessao original compila o fio de fronteira");

    // "Reabrir": sessão B, do zero, replay a MESMA sequência -- sem nenhum estado de A.
    GlobalPluginCache cacheB;
    SimulationSession sessionB(cacheB);
    const auto [sourceB, pressureInB] = buildAndWire(sessionB);
    const auto planB = sessionB.simulationPlan();
    check(planB != nullptr && planB->signal && planB->signal->engine, "sessao \"reaberta\" compila o MESMO fio de fronteira de novo");

    SignalRuntime runtimeB;
    runtimeB.bind(planB->signal->engine);
    runtimeB.setExternalReal(signalPortBlockId(sourceB, "value"), 19.0);
    runtimeB.executeUntil(1);
    const double observed = runtimeB.real(runtimeB.output(signalPortBlockId(kInternalSink, "reading")));
    check(std::abs(observed - 19.0) < 1e-9,
          "(8) sessao reconstruida do zero com a mesma sequencia entrega o fio de fronteira "
          "funcionando identicamente");
    (void)pressureInB;
}

} // namespace

int main() {
    try {
        genericSubcircuitExposesSignalInputAndOutput();
        multiplePortsCrossValuesIndependently();
        nestedSubcircuitSignalBoundaryResolvesRecursively();
        hartOutputThroughExposedSubcircuitPort();
        hartInputThroughExposedSubcircuitPort();
        renamingHartDisplayNameInsideSubcircuitNeverBreaksBoundaryWire();
        freshSessionReplayingSubcircuitBoundarySequenceReproducesSameWire();
        invalidSignalBoundaryDeclarationsAreRejected();
    } catch (const std::exception& ex) {
        std::fprintf(stderr, "EXCECAO NAO TRATADA: %s\n", ex.what());
        return 2;
    }
    if (failures == 0) std::puts("SignalGraphSubcircuitBoundaryTest: OK");
    return failures == 0 ? 0 : 1;
}
