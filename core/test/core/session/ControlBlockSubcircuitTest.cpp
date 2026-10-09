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
#include "components/connectors/Tunnel.hpp"
#include "components/control/SignalConstant.hpp"
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
    // O túnel ELÉTRICO legado também e' usado como relay de sinal pelos manifestos publicados (ver
    // `ProcessSubcircuitCompiler`, que aceita os dois) -- sem esta factory, 48 dos 49 manifestos da
    // biblioteca falhavam a instanciação aqui com "Unknown component typeId: connectors.tunnel", e
    // o caso (3) media cobertura de 1/49 sem que ninguém percebesse.
    session.components().registerFactory("connectors.tunnel", [](const ComponentParams& p) {
        const auto pos = p.pins<1>();
        return std::make_unique<components::Tunnel>(Pin{pos[0].id.empty() ? "pin" : pos[0].id, pos[0].x, pos[0].y});
    });
    for (const std::string_view mathTypeId : components::SignalMathBlock::signalMathTypeIds()) {
        const std::string typeId(mathTypeId);
        session.components().registerFactory(typeId, [typeId](const ComponentParams& p) {
            return std::make_unique<components::SignalMathBlock>(typeId, p);
        });
    }
    session.components().registerFactory(components::SignalConstant::kTypeId, [](const ComponentParams& p) {
        return std::make_unique<components::SignalConstant>(p);
    });
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
    size_t tdpsManifests = 0;
    size_t tdpsWithSubMillisecondEvent = 0;
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
            if (fileName.rfind("tdps_", 0) == 0) {
                ++tdpsManifests;
                const auto nextSignalEvent = session.signalRuntime().nextEventNs();
                if (nextSignalEvent && *nextSignalEvent < 1'000'000ull) {
                    ++tdpsWithSubMillisecondEvent;
                    std::fprintf(stderr, "  %s: proximo evento TDPS em %llu ns\n", typeId.c_str(),
                                 static_cast<unsigned long long>(*nextSignalEvent));
                }
            }
        } catch (const std::exception& error) {
            std::fprintf(stderr, "  %s: %s\n", typeId.c_str(), error.what());
        }
    }
    check(compiled == manifests.size(), "(3) todo manifesto Ctrl/TDPS publicado instancia E compila o Signal Plan");
    check(tdpsManifests >= 20 && tdpsWithSubMillisecondEvent == 0,
          "(3) nenhum manifesto TDPS agenda eventos de sinal abaixo de 1 ms");
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

// (6) Tanque pressurizado (process_pressurized_tank_dp): parametros sao blocos `control.constant`
// que mudam com a simulacao rodando, sem recompilar o plano, e as pernas HIGH/LOW seguem a
// hidrostatica (perna molhada no topo, capilar abaixo do nivel minimo).
void pressurizedTankParametersChangeWhileRunning() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerControlFactories(session);
    session.subcircuits().registerDefinition(loadManifest("process_pressurized_tank_dp.lssubcircuit"));
    const SubcircuitExpansionResult expansion = session.addSubcircuitInstance("subcircuits.process.pressurized_tank_dp");
    const auto read = [&](const char* pin) {
        const auto& exposed = expansion.exposedSignalPins.at(pin);
        return session.signalRuntime().real(session.signalRuntime().output(signalPortBlockId(exposed.instanceId, exposed.pinId)));
    };
    session.scheduler().runUntil(200'000'000ull);
    const double gas = 101.972 * 50.0;
    check(std::abs(read("high") - (1000.0 * (1.5 + 0.2) + gas)) < 1e-6, "(6) HIGH = 1000*(SGp*h + SGcap*Lcap) + Pgas");
    check(std::abs(read("low") - (1000.0 * 3.2 + gas)) < 1e-6, "(6) LOW = 1000*SGselo*(H + Lcap) + Pgas");
    check(std::abs(read("level_pct") - 50.0) < 1e-9, "(6) nivel inicial 1,5 m de 3 m = 50 %");

    const auto generation = session.simulationPlan()->generation;
    const std::optional<uint32_t> seal = session.findSubcircuitChildByLocalId(expansion.subcircuitInstanceId, "c_sg_seal");
    check(seal.has_value() && !session.setProperty(*seal, "value", PropertyValue{0.9}).has_value(),
          "(6) a constante da densidade do selo aceita o valor novo");
    session.scheduler().runUntil(300'000'000ull);
    check(std::abs(read("low") - (900.0 * 3.2 + gas)) < 1e-6, "(6) LOW acompanha o selo 0,9 com a simulacao rodando");
    check(session.simulationPlan()->generation == generation, "(6) mudar a constante nao recompila o plano");
}

// (7) Placa de orificio (process_orifice_flow_dp): a cadeia de blocos reproduz a ISO 5167-2. Os
// valores esperados vem da biblioteca `fluids` (C de Reader-Harris/Gallagher e epsilon da norma,
// independentes das expressoes do manifesto) -- ver docs/placa-orificio-ld301.md.
void orificePlateFollowsIso5167() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerControlFactories(session);
    session.subcircuits().registerDefinition(loadManifest("process_orifice_flow_dp.lssubcircuit"));
    const SubcircuitExpansionResult expansion = session.addSubcircuitInstance("subcircuits.process.orifice_flow_dp");
    const auto& valve = expansion.exposedSignalPins.at("valve");
    const uint32_t source = addConstantSource(session, 100.0, 10'000'000.0);
    session.connectWire(source, "out", valve.instanceId, valve.pinId);

    const auto read = [&](const char* pin) {
        const auto& exposed = expansion.exposedSignalPins.at(pin);
        return session.signalRuntime().real(session.signalRuntime().output(signalPortBlockId(exposed.instanceId, exposed.pinId)));
    };
    const auto child = [&](const char* localId) {
        const std::optional<uint32_t> index = session.findSubcircuitChildByLocalId(expansion.subcircuitInstanceId, localId);
        if (!index) throw std::runtime_error(std::string("filho ausente: ") + localId);
        return *index;
    };
    const auto inner = [&](const char* localId) {
        return session.signalRuntime().real(session.signalRuntime().output(signalPortBlockId(child(localId), "out")));
    };
    const auto setConstant = [&](const char* localId, double value) {
        return !session.setProperty(child(localId), "value", PropertyValue{value}).has_value();
    };
    const auto matches = [](double actual, double expected, double relative) {
        return std::abs(actual - expected) <= relative * std::abs(expected);
    };
    uint64_t now = 0;
    const auto runFor = [&](uint64_t ns) { now += ns; session.scheduler().runUntil(now); };

    // Agua a 20 C, D 52,5 mm, d 31,5 mm (beta 0,6), tomadas de flange, valvula 100 % -> 15 m3/h.
    runFor(40'000'000'000ull);
    check(matches(read("flow"), 15.0, 1e-9), "(7) valvula 100 % -> Q = Qmax = 15 m3/h");
    check(matches(inner("c_iso"), 0.612422441827, 1e-8), "(7) C de Reader-Harris/Gallagher (flange) igual ao da biblioteca fluids");
    check(matches(read("dp"), 3376.285174987, 1e-6), "(7) dP a 15 m3/h = 3376,29 mmH2O (fluids)");
    check(matches(read("high"), 101.97162 * 200.0, 1e-12), "(7) HIGH = pressao a montante (200 kPa em mmH2O)");
    check(matches(read("high") - read("low"), 3376.285174987, 1e-6), "(7) HIGH - LOW = dP");
    check(matches(inner("loss"), 20.728212903, 1e-6), "(7) perda de carga permanente (ISO 5167-1)");
    check(inner("ok_up") > 0.5 && inner("ok_dn") > 0.5 && inner("ok_rough") > 0.5 && inner("ok_iso") > 0.5,
          "(7) instalacao padrao (44D/8D, aco carbono) conforme a norma");
    check(inner("dev_total") == 0.0, "(7) sem desvio didatico com a instalacao conforme");

    const auto generation = session.simulationPlan()->generation;
    check(setConstant("c_tap", 2.0), "(7) tomada D e D/2 aceita");
    runFor(100'000'000ull);
    check(matches(inner("c_iso"), 0.612965722556, 1e-8), "(7) C com tomadas D e D/2 igual ao da fluids");
    check(matches(read("dp"), 3370.302922692, 1e-6), "(7) dP com tomadas D e D/2");
    check(setConstant("c_tap", 3.0), "(7) tomada de canto aceita");
    runFor(100'000'000ull);
    check(matches(inner("c_iso"), 0.611526303754, 1e-8), "(7) C com tomadas de canto igual ao da fluids");
    check(session.simulationPlan()->generation == generation, "(7) trocar a tomada nao recompila o plano");
    // Caminho do verbo IPC "setSubcircuitChildProperty": busca do filho + escrita pela fila de
    // comandos (com a simulacao rodando espera o passo em vez de falhar com "ocupada").
    check(!session.setSubcircuitChildProperty(expansion.subcircuitInstanceId, "c_tap", "value", PropertyValue{2.0}).has_value(),
          "(7) setSubcircuitChildProperty por id local aceito");
    runFor(100'000'000ull);
    check(matches(inner("c_iso"), 0.612965722556, 1e-8), "(7) a escrita por id local chega ao bloco");
    const std::optional<std::string> missing =
        session.setSubcircuitChildProperty(expansion.subcircuitInstanceId, "nao_existe", "value", PropertyValue{1.0});
    check(missing.has_value() && missing->rfind("child_not_found|", 0) == 0, "(7) filho inexistente devolve child_not_found");

    // Montante curto: 10 D com beta 0,6 (Tabela 3: A 42, B 13) -> desvio +0,5 + 1,5*(13-10)/13 %.
    check(setConstant("c_tap", 1.0) && setConstant("c_lup", 10.0), "(7) montante de 10 D aceito");
    runFor(100'000'000ull);
    check(inner("ok_up") < 0.5, "(7) montante de 10 D fora da norma acende o alarme");
    check(matches(inner("dev_total"), 0.5 + 1.5 * 3.0 / 13.0, 1e-9), "(7) desvio didatico do trecho a montante");
    check(matches(read("dp"), 3319.865147240, 1e-6), "(7) dP com o C real desviado");
    check(setConstant("c_inst", 0.0), "(7) desligar o desvio didatico aceito");
    runFor(100'000'000ull);
    check(matches(read("dp"), 3376.285174987, 1e-6), "(7) sem o desvio o dP volta ao da norma");
    check(setConstant("c_lup", 44.0) && setConstant("c_inst", 1.0), "(7) montante 44 D de volta");

    // Gas: ar a ~3 bar abs (rho 3,57 kg/m3, mu 0,0181 cP), 150 m3/h -> epsilon pela ISO 5167-2.
    check(setConstant("c_fluid", 1.0) && setConstant("c_rho", 3.57) && setConstant("c_mu", 0.0181) && setConstant("c_qmax", 150.0),
          "(7) parametros de gas aceitos");
    runFor(40'000'000'000ull);
    check(matches(inner("epsilon"), 0.988368449177, 1e-5), "(7) epsilon do gas igual ao da fluids");
    check(matches(read("dp"), 1244.199774964, 1e-4), "(7) dP do gas com epsilon (fluids)");

    // Valvula a 50 %: metade da vazao, um quarto do dP (com o C do Re menor).
    check(setConstant("c_fluid", 0.0) && setConstant("c_rho", 998.2) && setConstant("c_mu", 1.002) && setConstant("c_qmax", 15.0),
          "(7) agua de volta");
    check(!session.setProperty(source, "bias", PropertyValue{50.0}).has_value(), "(7) valvula em 50 %");
    runFor(40'000'000'000ull);
    check(matches(read("flow"), 7.5, 1e-9), "(7) valvula 50 % -> 7,5 m3/h");
    check(matches(read("dp"), 836.081491565, 1e-6), "(7) dP a 7,5 m3/h = 836,08 mmH2O (fluids)");
}

int main() {
    try {
        processFopdtInstantiatesThroughTheRealPath();
        processFopdtRespondsToAStep();
        everyPublishedControlLibrarySubcircuitInstantiates();
        handWiredControlLoopCompilesAndConverges();
        expressionInputListSurvivesPropertyTransport();
        pressurizedTankParametersChangeWhileRunning();
        orificePlateFollowsIso5167();
    } catch (const std::exception& ex) {
        std::fprintf(stderr, "EXCECAO NAO TRATADA: %s\n", ex.what());
        return 2;
    }
    if (failures == 0) std::puts("ControlBlockSubcircuitTest: OK");
    return failures == 0 ? 0 : 1;
}
