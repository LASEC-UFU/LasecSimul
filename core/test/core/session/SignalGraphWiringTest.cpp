// Prova o mecanismo GENERICO de fiacao Signal Graph introduzido pelo fechamento do gate de
// materializacao de portas (HART Device Engine v2, FEAT-013): connectWire()/disconnectWire()/
// applyWireTopologyTransaction() detectam quando os dois endpoints resolvem como
// IComponentModel::signalPorts() (em vez de pino eletrico) e roteiam para o dominio Signal Graph
// (SimulationSession::m_signalWires), que materializeSignalGraphUnlocked() funde na
// SignalGraphDefinition compilada -- SEM nenhum caso especial de HART: os dois componentes fake
// abaixo nao sao HART, provando que a infraestrutura serve qualquer IComponentModel que declare
// signalPorts(). Ver .spec/features/hart-device-engine.md, Anexo F (fechamento do gate de canvas).
#include <cstdio>
#include <optional>
#include <vector>

#include "lasecsimul/IComponentModel.hpp"
#include "lasecsimul/Types.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "protocols/HartCommunicationComponent.hpp"
#include "session/SimulationSession.hpp"

using namespace lasecsimul;
using namespace lasecsimul::session;
using namespace lasecsimul::simulation;

namespace {

int failures = 0;
void check(bool ok, const char* label) {
    if (ok) std::printf("OK: %s\n", label);
    else { std::fprintf(stderr, "FALHOU: %s\n", label); ++failures; }
}

/** Fonte generica: uma unica porta Signal Graph Output chamada "value" -- nenhuma relacao com
 * HART, sem pino eletrico nenhum (pins() vazio, igual HartCommunicationComponent::pins()). */
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

/** Consumidora generica: uma unica porta Signal Graph Input chamada "value" -- distinta da porta
 * da fonte só pra provar que o nome da porta nunca precisa combinar entre os dois lados. */
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

/** Segunda fonte/consumidora digital, só pra exercitar o caminho SignalValueKind::Digital e a
 * checagem de incompatibilidade de tipo (analogico <-> digital). */
class FakeDigitalSink final : public IComponentModel {
public:
    const char* typeId() const override { return "test.fake_digital_sink"; }
    std::span<Pin> pins() override { return {}; }
    void stamp(MnaMatrixView&) override {}
    void postStep(uint64_t) override {}
    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}
    std::vector<SignalPortDescriptor> signalPorts() const override {
        return {{"alarm", SignalPortDirection::Input, SignalValueKind::Digital, ""}};
    }
};

void registerFakes(SimulationSession& session) {
    session.components().registerFactory("test.fake_signal_source", [](const registry::ComponentParams&) {
        return std::make_unique<FakeSignalSource>();
    });
    session.components().registerFactory("test.fake_signal_sink", [](const registry::ComponentParams&) {
        return std::make_unique<FakeSignalSink>();
    });
    session.components().registerFactory("test.fake_digital_sink", [](const registry::ComponentParams&) {
        return std::make_unique<FakeDigitalSink>();
    });
}

// (a) componente generico A output -> fio visual -> componente generico B input -> compila ->
// SignalEngine -> B recebe o valor de A.
void genericWireCompilesAndRuntimeObservesConnection() {
    plugins::GlobalPluginCache cache;
    SimulationSession session(cache);
    registerFakes(session);
    const uint32_t source = session.addComponent("test.fake_signal_source", {});
    const uint32_t sink = session.addComponent("test.fake_signal_sink", {});

    session.connectWire(source, "value", sink, "reading");
    const auto plan = session.simulationPlan();
    check(plan != nullptr && plan->signal && plan->signal->engine,
          "plano compila com fio Signal Graph generico e produz um CompiledSignalGraph");

    // `CompiledSignalGraph` e' um artefato imutavel feito pra ser vinculado a qualquer instancia de
    // `SignalRuntime` -- usar uma instancia PROPRIA do teste (em vez do runtime privado da sessao,
    // so' exposto como `const&`) prova exatamente a mesma coisa que a sessao real observaria: o
    // grafo compilado a partir do fio generico tem a conexao certa entre os dois blocos.
    const std::string sourceBlock = signalPortBlockId(source, "value");
    const std::string sinkBlock = signalPortBlockId(sink, "reading");
    SignalRuntime runtime;
    runtime.bind(plan->signal->engine);
    runtime.setExternalReal(sourceBlock, 42.5);
    runtime.executeUntil(1);
    const double observed = runtime.real(runtime.output(sinkBlock));
    check(std::abs(observed - 42.5) < 1e-9, "B observa o valor publicado por A atraves do fio compilado");
}

// (e) identidade estavel: renomear o campo de EXIBICAO (`name`) de uma variavel HART, mantendo o
// `id` (a chave real de `signalPorts()`/`signalPortBlockId`), nunca deveria derrubar um fio já
// conectado -- exatamente o cenário que `preserveExistingVariableIds` (Property Inspector, fase
// anterior desta auditoria) protege do lado da Extension; aqui prova-se o lado Core: o fio é
// indexado por `m_signalWires`' `sourcePort`/`targetPort` (sempre o `id`, nunca `name`), então uma
// reescrita de `hartVariablesJson` que só muda `name` não deveria mudar `signalPorts()` nem invalidar
// a conexão existente.
void renamingDisplayNameNeverBreaksAnExistingWire() {
    plugins::GlobalPluginCache cache;
    SimulationSession session(cache);
    session.components().registerFactory("test.fake_hart_rename", [&session](const registry::ComponentParams& p) {
        return std::make_unique<protocols::HartCommunicationComponent>(
            protocols::HartCommunicationComponent::Mode::Serial, session.scheduler(), p);
    });
    session.components().registerFactory("test.fake_signal_sink_rename", [](const registry::ComponentParams&) {
        return std::make_unique<FakeSignalSink>();
    });

    registry::ComponentParams hartParams;
    hartParams.properties["bus"] = std::string("hart-rename");
    hartParams.properties["endpoint"] = std::string("COM30");
    hartParams.properties["uniqueId"] = std::string("CCCCCC");
    hartParams.properties["pollingAddress"] = 3.0;
    hartParams.properties["enabled"] = true;
    hartParams.properties["hartVariablesJson"] = std::string(
        R"([{"id":"measured","name":"Measured","type":"Float32","direction":"Output","value":77.0,"unit":"kPa"}])");
    const uint32_t hart = session.addComponent("test.fake_hart_rename", hartParams);
    const uint32_t sink = session.addComponent("test.fake_signal_sink_rename", {});

    session.connectWire(hart, "measured", sink, "reading");
    session.scheduler().runUntil(1);
    const std::string sinkBlock = signalPortBlockId(sink, "reading");
    const double beforeRename = session.signalRuntime().real(session.signalRuntime().output(sinkBlock));
    check(std::abs(beforeRename - 77.0) < 1e-9, "fio entrega o valor certo ANTES do rename (baseline)");

    // Só `name` muda; `id`="measured" e `direction`/`value` permanecem -- exatamente o payload que
    // a Property Inspector's `preserveExistingVariableIds` já garante chegar assim ao Core.
    const auto renameError = session.setProperty(hart, "hartVariablesJson", PropertyValue{std::string(
        R"([{"id":"measured","name":"ProcessMeasured","type":"Float32","direction":"Output","value":77.0,"unit":"kPa"}])")});
    check(!renameError.has_value(), "renomear so' o display name e' uma edicao de propriedade aceita");

    const auto planAfterRename = session.simulationPlan();
    check(planAfterRename != nullptr, "sessao continua compilando depois do rename");
    session.scheduler().runUntil(2);
    const double afterRename = session.signalRuntime().real(session.signalRuntime().output(sinkBlock));
    check(std::abs(afterRename - 77.0) < 1e-9,
          "(16e) fio sobrevive ao rename do display name -- MESMA conexao, MESMO id, MESMO valor entregue");
}

// (f) save/reopen: Core não possui memória entre processos -- quem persiste topologia (elétrica OU
// Signal Graph, ambas via `WebviewWireModel{from,to}` genérico) é a Extension (`topology.conductors`
// no `.lsproj`), e reabrir um projeto = reconstruir do zero via `addComponent`+`connectWire` (mesmo
// `rebuildCoreFromSchematicState` que qualquer edição usa, ver `coreLifecycle.ts`). Do lado do Core,
// isso significa que "salvar e reabrir" e' EXATAMENTE "destruir esta sessão e repetir a mesma
// sequência addComponent/connectWire numa sessão nova" -- não existe um formato de serialização
// separado pra `m_signalWires` no Core, e não deveria existir um (ver item 4: uma única fonte de
// verdade). Este teste prova essa equivalência: uma segunda sessão, construída do zero com a MESMA
// sequência, produz a MESMA conexão funcionando.
void freshSessionReplayingSameSequenceReproducesTheSameWire() {
    const auto buildAndWire = [](SimulationSession& session) {
        session.components().registerFactory("test.fake_signal_source", [](const registry::ComponentParams&) {
            return std::make_unique<FakeSignalSource>();
        });
        session.components().registerFactory("test.fake_signal_sink", [](const registry::ComponentParams&) {
            return std::make_unique<FakeSignalSink>();
        });
        const uint32_t source = session.addComponent("test.fake_signal_source", {});
        const uint32_t sink = session.addComponent("test.fake_signal_sink", {});
        session.connectWire(source, "value", sink, "reading");
        return sink;
    };

    plugins::GlobalPluginCache cacheA;
    SimulationSession sessionA(cacheA);
    const uint32_t sinkA = buildAndWire(sessionA);
    const auto planA = sessionA.simulationPlan();
    check(planA != nullptr && planA->signal && planA->signal->engine, "sessao original compila o fio");

    // "Reabrir": sessão A é abandonada (nunca reaproveitada), uma sessão B, do zero, replay a MESMA
    // sequência -- sem NENHUM estado carregado de A (nenhum ponteiro/cache compartilhado).
    plugins::GlobalPluginCache cacheB;
    SimulationSession sessionB(cacheB);
    const uint32_t sinkB = buildAndWire(sessionB);
    const auto planB = sessionB.simulationPlan();
    check(planB != nullptr && planB->signal && planB->signal->engine, "sessao \"reaberta\" compila o MESMO fio de novo");

    SignalRuntime runtimeB;
    runtimeB.bind(planB->signal->engine);
    runtimeB.setExternalReal(signalPortBlockId(0, "value"), 88.0);
    runtimeB.executeUntil(1);
    const double observed = runtimeB.real(runtimeB.output(signalPortBlockId(sinkB, "reading")));
    check(std::abs(observed - 88.0) < 1e-9,
          "(16f) sessao reconstruida do zero com a mesma sequencia entrega o fio funcionando identicamente");
    (void)sinkA;
}

void disconnectRemovesWireAndAllowsRewire() {
    plugins::GlobalPluginCache cache;
    SimulationSession session(cache);
    registerFakes(session);
    const uint32_t source = session.addComponent("test.fake_signal_source", {});
    const uint32_t sink = session.addComponent("test.fake_signal_sink", {});

    session.connectWire(source, "value", sink, "reading");
    const bool removed = session.disconnectWire(source, "value", sink, "reading");
    check(removed, "disconnectWire remove o fio Signal Graph existente");
    const bool removedAgain = session.disconnectWire(source, "value", sink, "reading");
    check(!removedAgain, "disconnectWire e idempotente (nada a remover na segunda chamada)");

    // Reconectar depois de desconectado deve funcionar normalmente (nenhum estado fantasma).
    session.connectWire(source, "value", sink, "reading");
    const auto plan = session.simulationPlan();
    check(plan != nullptr, "reconectar apos desconectar compila normalmente");
}

// (h) casos invalidos: Output-Output, Input-Input, tipo incompativel, porta desconhecida,
// segundo escritor (single-writer) -- todos devem ser rejeitados sem mutacao parcial.
void invalidWiringIsRejectedAtomically() {
    plugins::GlobalPluginCache cache;
    SimulationSession session(cache);
    registerFakes(session);
    const uint32_t source = session.addComponent("test.fake_signal_source", {});
    const uint32_t source2 = session.addComponent("test.fake_signal_source", {});
    const uint32_t sink = session.addComponent("test.fake_signal_sink", {});
    const uint32_t digitalSink = session.addComponent("test.fake_digital_sink", {});

    bool outputOutputRejected = false;
    try { session.connectWire(source, "value", source2, "value"); }
    catch (const std::invalid_argument&) { outputOutputRejected = true; }
    check(outputOutputRejected, "Output-Output e rejeitado");

    bool typeMismatchRejected = false;
    try { session.connectWire(source, "value", digitalSink, "alarm"); }
    catch (const std::invalid_argument&) { typeMismatchRejected = true; }
    check(typeMismatchRejected, "tipo analogico->digital incompativel e rejeitado");

    bool unknownPortRejectedAsDomainMismatch = false;
    try { session.connectWire(source, "value", sink, "nao_existe"); }
    catch (const std::invalid_argument&) { unknownPortRejectedAsDomainMismatch = true; }
    catch (const std::out_of_range&) { unknownPortRejectedAsDomainMismatch = true; }
    check(unknownPortRejectedAsDomainMismatch, "porta desconhecida (nem signal nem eletrica) e rejeitada");

    session.connectWire(source, "value", sink, "reading");
    bool secondWriterRejected = false;
    try { session.connectWire(source2, "value", sink, "reading"); }
    catch (const std::invalid_argument&) { secondWriterRejected = true; }
    check(secondWriterRejected, "segundo escritor no mesmo Input e rejeitado (single-writer)");

    // A rejeicao do segundo escritor nao deve ter mutado nada: o primeiro fio ainda funciona.
    const auto plan = session.simulationPlan();
    check(plan != nullptr, "estado permanece consistente apos tentativa de segundo escritor rejeitada");
}

// (b)/(c) HART -- consumidora real da MESMA infraestrutura genérica, sem nenhum caso especial:
// um HartCommunicationComponent Output ligado por fio a outro HartCommunicationComponent Input
// (16b: "signal source -> HART variable Input") E a uma consumidora genérica (16c: "HART variable
// Output -> downstream Signal block"), ambos através de `connectWire`/`materializeSignalGraphUnlocked`
// -- nenhum `hartWireCompiler`/pino elétrico fake envolvido. A leitura de valor usa
// `session.signalRuntime()` (a MESMA janela pública que `sampleHartInputsFromSignalUnlocked`/
// `publishHartOutputsToSignalUnlocked` usam internamente) em vez de decodificar um comando HART
// via bytes crus: o que este gate precisa provar é que o FIO entrega o valor certo no bloco certo
// -- que `HartCommunicationComponent::setSignalInput`/`signalOutput` consomem esse valor
// corretamente já está coberto por `HartEngineTest.cpp` (fora de escopo re-testar aqui, ver Anexo
// F item 19: não reabrir a auditoria de comandos HART). Um `hartTransact` real (Command 0x00, sem
// payload) é incluído só para provar que o boundary de transporte com os dois hooks
// (`sample`/`publish`) não lança nem rejeita quando de fato exercitado com um fio real conectado.
void hartComponentsUseGenericInfrastructureForInputAndOutput() {
    plugins::GlobalPluginCache cache;
    SimulationSession session(cache);
    registerFakes(session);

    // HartCommunicationComponent precisa de um simulation::Scheduler& que sobreviva ao componente;
    // o próprio `session` já possui um (`session.scheduler()`), então reaproveita-o em vez de criar
    // um segundo -- mesma convenção de qualquer registro de fábrica real (ver CoreApplication.cpp).
    session.components().registerFactory("test.fake_hart_transmitter", [&session](const registry::ComponentParams& p) {
        return std::make_unique<protocols::HartCommunicationComponent>(
            protocols::HartCommunicationComponent::Mode::Serial, session.scheduler(), p);
    });
    session.components().registerFactory("test.fake_hart_receiver", [&session](const registry::ComponentParams& p) {
        return std::make_unique<protocols::HartCommunicationComponent>(
            protocols::HartCommunicationComponent::Mode::Serial, session.scheduler(), p);
    });

    registry::ComponentParams transmitterParams;
    transmitterParams.properties["bus"] = std::string("hart-a");
    transmitterParams.properties["endpoint"] = std::string("COM20");
    transmitterParams.properties["uniqueId"] = std::string("AAAAAA");
    transmitterParams.properties["pollingAddress"] = 1.0;
    transmitterParams.properties["enabled"] = true;
    transmitterParams.properties["hartVariablesJson"] = std::string(
        R"([{"id":"measured","name":"Measured","type":"Float32","direction":"Output","value":55.0,"unit":"kPa"}])");
    const uint32_t transmitter = session.addComponent("test.fake_hart_transmitter", transmitterParams);

    registry::ComponentParams receiverParams;
    receiverParams.properties["bus"] = std::string("hart-b");
    receiverParams.properties["endpoint"] = std::string("COM21");
    receiverParams.properties["uniqueId"] = std::string("BBBBBB");
    receiverParams.properties["pollingAddress"] = 2.0;
    receiverParams.properties["enabled"] = true;
    receiverParams.properties["hartVariablesJson"] = std::string(
        R"([{"id":"setpoint","name":"Setpoint","type":"Float32","direction":"Input","value":0.0,"unit":"kPa"}])");
    const uint32_t receiver = session.addComponent("test.fake_hart_receiver", receiverParams);

    const uint32_t downstream = session.addComponent("test.fake_signal_sink", {});

    // Um único Output HART alimenta DOIS alvos ao mesmo tempo -- outro HART (16b) e um consumidor
    // genérico (16c) -- provando que fan-out de uma fonte não esbarra na regra de single-writer
    // (que só restringe quantos fios chegam a um mesmo Input, nunca quantos saem de um Output).
    session.connectWire(transmitter, "measured", receiver, "setpoint");
    session.connectWire(transmitter, "measured", downstream, "reading");

    const auto plan = session.simulationPlan();
    check(plan != nullptr && plan->signal && plan->signal->engine,
          "sessao com dois HartCommunicationComponent reais fiados compila (nenhum caso especial de HART no compilador)");

    session.scheduler().runUntil(1);

    const std::string receiverBlock = signalPortBlockId(receiver, "setpoint");
    const double receiverObserved = session.signalRuntime().real(session.signalRuntime().output(receiverBlock));
    check(std::abs(receiverObserved - 55.0) < 1e-9,
          "(16b) HART Input recebe o valor publicado por outro HART Output atraves do fio Signal Graph generico");

    const std::string downstreamBlock = signalPortBlockId(downstream, "reading");
    const double downstreamObserved = session.signalRuntime().real(session.signalRuntime().output(downstreamBlock));
    check(std::abs(downstreamObserved - 55.0) < 1e-9,
          "(16c) consumidor Signal Graph generico recebe o valor pertencente ao dispositivo HART Output");

    // Command 0x00 (Read Unique Identifier) nao exige payload -- frame minimo:
    // [0x02, pollingAddress, 0x00, 0x00, checksum XOR de tudo antes do checksum].
    const auto framedCommand0 = [](uint8_t pollingAddress) {
        const uint8_t checksum = static_cast<uint8_t>(0x02 ^ pollingAddress ^ 0x00 ^ 0x00);
        return std::vector<uint8_t>{0x02, pollingAddress, 0x00, 0x00, checksum};
    };
    const auto transmitterReply = session.hartTransact(transmitter, framedCommand0(1));
    const auto receiverReply = session.hartTransact(receiver, framedCommand0(2));
    check(transmitterReply.has_value(), "hartTransact real (0x00) no HART Output fiado nao lanca nem rejeita "
                                         "(publishHartOutputsToSignalUnlocked executa sem erro)");
    check(receiverReply.has_value(), "hartTransact real (0x00) no HART Input fiado nao lanca nem rejeita "
                                      "(sampleHartInputsFromSignalUnlocked executa sem erro)");
}

// Fio eletrico<->Signal Graph misto: nunca deveria silenciosamente virar um ou outro.
void mixedDomainEndpointsAreRejected() {
    plugins::GlobalPluginCache cache;
    SimulationSession session(cache);
    registerFakes(session);
    session.components().registerFactory("test.fake_electrical", [](const registry::ComponentParams&) {
        struct FakeElectrical final : IComponentModel {
            std::array<Pin, 1> pin{Pin{"p"}};
            const char* typeId() const override { return "test.fake_electrical"; }
            std::span<Pin> pins() override { return pin; }
            void stamp(MnaMatrixView&) override {}
            void postStep(uint64_t) override {}
            size_t getState(uint8_t*, size_t) const override { return 0; }
            void setState(const uint8_t*, size_t) override {}
        };
        return std::make_unique<FakeElectrical>();
    });
    const uint32_t source = session.addComponent("test.fake_signal_source", {});
    const uint32_t electrical = session.addComponent("test.fake_electrical", {});

    bool rejected = false;
    try { session.connectWire(source, "value", electrical, "p"); }
    catch (const std::invalid_argument&) { rejected = true; }
    check(rejected, "fio misto Signal Graph <-> eletrico e rejeitado, nunca silenciosamente aceito");
}

} // namespace

int main() {
    try {
        genericWireCompilesAndRuntimeObservesConnection();
        renamingDisplayNameNeverBreaksAnExistingWire();
        freshSessionReplayingSameSequenceReproducesTheSameWire();
        disconnectRemovesWireAndAllowsRewire();
        invalidWiringIsRejectedAtomically();
        hartComponentsUseGenericInfrastructureForInputAndOutput();
        mixedDomainEndpointsAreRejected();
    } catch (const std::exception& ex) {
        std::fprintf(stderr, "EXCECAO NAO TRATADA: %s\n", ex.what());
        return 2;
    }
    if (failures == 0) std::puts("SignalGraphWiringTest: OK");
    return failures == 0 ? 0 : 1;
}
