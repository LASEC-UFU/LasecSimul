// Prova que os blocos `control.*` da biblioteca Ctrl/TDPS existem como componentes DE VERDADE no
// caminho de execução real -- `SimulationSession::addSubcircuitInstance` (o mesmo que a Extension
// aciona via `addComponent`), nunca só no `ProcessSubcircuitCompiler` (que é chamado apenas pelos
// seus próprios testes). Regressão original: instanciar QUALQUER dispositivo TDPS falhava com
// "addComponent falhou: Unknown component typeId: control.process", porque `expandSubcircuit`
// instancia cada filho pelo `ComponentRegistry` e nenhum `control.*` tinha factory registrada.
//
// Os manifestos carregados aqui são os ARQUIVOS REAIS de `subcircuits/` (mesma escolha de
// esp32_devkitc_subcircuit_test.cpp): um teste com definição sintética não teria pego nem a
// fronteira elétrica/sinal trocada do `process_fopdt`, nem a lista `inputs` das expressões TDPS.
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <memory>
#include <string>

#include <nlohmann/json.hpp>

#include "components/connectors/SignalTunnel.hpp"
#include "components/control/SignalMathBlock.hpp"
#include "plugins/GlobalPluginCache.hpp"
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

void registerControlFactories(SimulationSession& session) {
    session.components().registerFactory("connectors.signal_tunnel", [](const ComponentParams& p) {
        return std::make_unique<components::SignalTunnel>(p);
    });
    for (const std::string_view mathTypeId : components::SignalMathBlock::signalMathTypeIds()) {
        const std::string typeId(mathTypeId);
        session.components().registerFactory(typeId, [typeId](const ComponentParams& p) {
            return std::make_unique<components::SignalMathBlock>(typeId, p);
        });
    }
}

SubcircuitDefinition loadManifest(const std::string& fileName) {
    std::ifstream stream(std::string(SUBCIRCUIT_LIBRARY_DIR) + "/" + fileName);
    if (!stream) throw std::runtime_error("manifesto nao encontrado: " + fileName);
    nlohmann::json manifest;
    stream >> manifest;
    SubcircuitDefinition definition;
    definition.typeId = manifest.at("typeId").get<std::string>();
    definition.name = manifest.value("name", definition.typeId);
    for (const auto& component : manifest.at("components")) {
        definition.components.push_back({component.at("id").get<std::string>(),
                                          component.at("typeId").get<std::string>(),
                                          component.value("properties", nlohmann::json::object()).dump()});
    }
    for (const auto& conductor : manifest.at("topology").at("conductors")) {
        definition.wires.push_back({conductor.at("from").at("componentId").get<std::string>(),
                                     conductor.at("from").at("pinId").get<std::string>(),
                                     conductor.at("to").at("componentId").get<std::string>(),
                                     conductor.at("to").at("pinId").get<std::string>()});
    }
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

// (1) O caso EXATO do erro relatado: abrir/recriar o dispositivo `subcircuits.process.fopdt`.
void processFopdtInstantiatesThroughTheRealPath() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerControlFactories(session);
    session.subcircuits().registerDefinition(loadManifest("process_fopdt.lssubcircuit"));

    SubcircuitExpansionResult expansion{};
    bool threw = false;
    try { expansion = session.addSubcircuitInstance("subcircuits.process.fopdt"); }
    catch (const std::exception& error) {
        threw = true;
        std::fprintf(stderr, "  excecao: %s\n", error.what());
    }
    check(!threw, "(1) instanciar subcircuits.process.fopdt nao lanca (regressao 'Unknown component typeId: control.process')");
    check(expansion.exposedSignalPins.size() == 2, "(1) o processo expoe as duas fronteiras de sinal autoradas (u, y)");
    check(expansion.exposedPins.empty(), "(1) nenhum pino ELETRICO e' exposto por um processo de sinal puro");

    const auto plan = session.simulationPlan();
    check(plan != nullptr && plan->signal && plan->signal->engine, "(1) o Signal Plan do processo compila");
}

/** Fonte constante sem nenhum fio de entrada: um `control.bias` com a entrada solta lê o default 0
 * do seu proprio relay, entao a saida e' exatamente `bias`. Usado no lugar de `setExternalReal`
 * porque o estado CONTINUO (FirstOrder/DeadTime/...) so' avanca pelo passo transiente do Scheduler
 * da sessao (`beginContinuousStep`/`commitContinuousStep`), nunca por um SignalRuntime avulso. */
uint32_t addConstantSource(SimulationSession& session, double value, double samplePeriodNs) {
    ComponentParams params;
    params.properties["bias"] = value;
    params.properties["samplePeriodNs"] = samplePeriodNs;
    return session.addComponent("control.bias", params);
}

// (2) O bloco `control.process` executa a matematica autorada (K/(tau*s+1) com tempo morto), nao
// apenas "instancia sem erro": degrau na fronteira `u` e' seguido pela saida `y`.
void processFopdtRespondsToAStep() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerControlFactories(session);
    session.subcircuits().registerDefinition(loadManifest("process_fopdt.lssubcircuit"));
    const SubcircuitExpansionResult expansion = session.addSubcircuitInstance("subcircuits.process.fopdt");
    const auto& u = expansion.exposedSignalPins.at("u");
    const auto& y = expansion.exposedSignalPins.at("y");

    // Reparametriza o processo interno pelo MESMO caminho do inspector
    // (`exportedPropertyComponentIds` aponta pra "plant"): constante de tempo curta pra manter o
    // teste em milissegundos de tempo simulado -- e, de quebra, prova que editar propriedade de um
    // bloco de controle dentro de um subcircuito funciona.
    const std::optional<uint32_t> plant = session.findSubcircuitChildByLocalId(expansion.subcircuitInstanceId, "plant");
    check(plant.has_value(), "(2) o componente interno 'plant' e' localizavel pelo id local do subcircuito");
    check(!session.setProperty(*plant, "tau1", PropertyValue{0.01}).has_value(), "(2) editar tau1 do bloco interno e' aceito");
    check(!session.setProperty(*plant, "deadTime", PropertyValue{0.0}).has_value(), "(2) editar deadTime do bloco interno e' aceito");
    check(!session.setProperty(*plant, "samplePeriodNs", PropertyValue{1'000'000.0}).has_value(), "(2) editar samplePeriodNs do bloco interno e' aceito");

    const uint32_t source = addConstantSource(session, 1.0, 1'000'000.0);
    session.connectWire(source, "out", u.instanceId, u.pinId);
    check(session.simulationPlan() != nullptr, "(2) o plano continua compilando com a fonte ligada na fronteira");

    // gain=1, tau1=10ms: depois de ~10 constantes de tempo a saida esta praticamente no degrau. A
    // janela e' generosa de proposito -- o que se prova aqui e' que a cadeia Gain/FirstOrder roda
    // de verdade pelo passo transiente da sessao, nao um valor numerico exato (isso e' trabalho do
    // teste matematico do SignalEngine).
    session.scheduler().runUntil(100'000'000ull);
    const double observed = session.signalRuntime().real(
        session.signalRuntime().output(signalPortBlockId(y.instanceId, y.pinId)));
    check(observed > 0.9 && observed < 1.05, "(2) degrau unitario em u chega a y pela cadeia do control.process");
}

// (3) TODA a biblioteca Ctrl/TDPS publicada instancia e compila -- não uma amostra. O relato
// original ("nenhum dispositivo TDPS abre internamente") era exatamente isso: a falha não era de um
// manifesto específico, era de todos os que usam blocos `control.*`. Malhas fechadas aqui são o
// caso que exige política FixedPoint e RateGroup compartilhado em todo o SCC, inclusive nos relays
// de fronteira, que nascem no rate genérico.
void everyPublishedControlLibrarySubcircuitInstantiates() {
    std::vector<std::string> manifests;
    for (const auto& entry : std::filesystem::directory_iterator(SUBCIRCUIT_LIBRARY_DIR)) {
        if (entry.path().extension() != ".lssubcircuit") continue;
        const std::string fileName = entry.path().filename().string();
        if (fileName.rfind("tdps_", 0) == 0 || fileName.rfind("control_", 0) == 0 || fileName.rfind("process_", 0) == 0)
            manifests.push_back(fileName);
    }
    check(manifests.size() >= 20, "(3) a biblioteca publicada de blocos/processos foi encontrada no repositorio");

    size_t compiled = 0;
    for (const std::string& fileName : manifests) {
        GlobalPluginCache cache;
        SimulationSession session(cache);
        registerControlFactories(session);
        const SubcircuitDefinition definition = loadManifest(fileName);
        const std::string typeId = definition.typeId;
        session.subcircuits().registerDefinition(definition);
        try {
            session.addSubcircuitInstance(typeId);
            const auto plan = session.simulationPlan();
            if (plan != nullptr && plan->signal && plan->signal->engine) ++compiled;
            else std::fprintf(stderr, "  %s: instanciou mas o Signal Plan nao compilou\n", typeId.c_str());
        } catch (const std::exception& error) {
            std::fprintf(stderr, "  %s: %s\n", typeId.c_str(), error.what());
        }
    }
    check(compiled == manifests.size(), "(3) todo manifesto Ctrl/TDPS publicado instancia E compila o Signal Plan");
    std::printf("  (3) %zu/%zu manifestos\n", compiled, manifests.size());
}

// (4) O mesmo funciona SEM subcircuito nenhum: blocos avulsos ligados a mao no canvas fecham a
// malha no MESMO grafo -- e' isso que a materializacao por componente garante e que uma compilacao
// por subcircuito (fronteira propria por processo) nunca conseguiria.
void handWiredControlLoopCompilesAndConverges() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerControlFactories(session);

    constexpr double kPeriodNs = 1'000'000.0;
    ComponentParams pidParams;
    pidParams.properties["kc"] = 2.0;
    pidParams.properties["ti"] = 0.05;
    pidParams.properties["outputMin"] = 0.0;
    pidParams.properties["outputMax"] = 100.0;
    pidParams.properties["samplePeriodNs"] = kPeriodNs;
    ComponentParams processParams;
    processParams.properties["gain"] = 1.0;
    processParams.properties["tau1"] = 0.02;
    processParams.properties["samplePeriodNs"] = kPeriodNs;

    const uint32_t pid = session.addComponent("control.pid", pidParams);
    const uint32_t process = session.addComponent("control.process", processParams);
    const uint32_t setpoint = addConstantSource(session, 50.0, kPeriodNs);
    session.connectWire(setpoint, "out", pid, "sp");
    session.connectWire(pid, "out", process, "in");
    session.connectWire(process, "out", pid, "pv");

    check(session.simulationPlan() != nullptr,
          "(4) malha PID<->processo montada bloco a bloco (sem subcircuito) compila no mesmo grafo");

    session.scheduler().runUntil(2'000'000'000ull);
    const double pv = session.signalRuntime().real(session.signalRuntime().output(signalPortBlockId(process, "out")));
    check(std::abs(pv - 50.0) < 5.0, "(4) a malha realimentada leva a variavel de processo ate o setpoint");
}

// (5) A lista `inputs` de uma expressao sobrevive ao transporte de propriedades do subcircuito
// (`PropertyValue` so' guarda escalar): sem isso todo bloco de N entradas cairia no par default
// in0/in1 e os fios internos autorados nao resolveriam.
void expressionInputListSurvivesPropertyTransport() {
    const auto portsFor = [](const std::string& inputs) {
        ComponentParams params;
        params.properties["expression"] = std::string("x0*(1+x1/100)");
        params.properties["inputs"] = inputs;
        return components::SignalMathBlock("control.calc_expression", params).signalPorts();
    };
    const auto matchesAuthoredPorts = [](const std::vector<SignalPortDescriptor>& ports) {
        return ports.size() == 3 && ports[0].id == "x0" && ports[1].id == "x1" && ports[2].id == "out";
    };
    // Array JSON: forma do `.lssubcircuit` (TDPS). Lista por virgula: forma dos defaults do
    // catálogo da Extension (`controlGraphCatalog`) e da edicao pelo inspector. As duas resolvem
    // pras MESMAS portas -- divergir daria pino desenhado num lugar e porta de sinal em outro.
    check(matchesAuthoredPorts(portsFor(R"(["x0","x1"])")), "(5) portas vem da lista `inputs` em array JSON (autoria .lssubcircuit)");
    check(matchesAuthoredPorts(portsFor("x0, x1")), "(5) portas vem da lista `inputs` separada por virgula (autoria da Extension)");
}

} // namespace

int main() {
    try {
        processFopdtInstantiatesThroughTheRealPath();
        processFopdtRespondsToAStep();
        everyPublishedControlLibrarySubcircuitInstantiates();
        handWiredControlLoopCompilesAndConverges();
        expressionInputListSurvivesPropertyTransport();
    } catch (const std::exception& ex) {
        std::fprintf(stderr, "EXCECAO NAO TRATADA: %s\n", ex.what());
        return 2;
    }
    if (failures == 0) std::puts("ControlBlockSubcircuitTest: OK");
    return failures == 0 ? 0 : 1;
}
