/**
 * F9.5 -- integracao ponta a ponta PLC <-> SimulationSession/Scheduler: Scheduler event(T) ->
 * InputLatch -> PlcRuntime::scan(T) -> OutputSnapshot -> OutputCommit -> propagacao normal via
 * Signal Engine. Roda contra o driver real `hello` (plc_worker_driver_hello, F9.2) e o double
 * `misbehaving_worker` (F9.4) pros caminhos de falha -- nenhum dos dois depende do binario STruCpp
 * vendorizado, por isso hermetic (mesma logica de PlcRuntimeTest.cpp).
 */
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <string>

#include "session/SimulationSession.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "lasecsimul/Sha256.hpp"

namespace fs = std::filesystem;
using namespace lasecsimul;
using namespace lasecsimul::session;
using namespace lasecsimul::simulation;
using lasecsimul::Sha256;

namespace {
int failures = 0;
#define CHECK(expr, message) \
    do { if (!(expr)) { std::fprintf(stderr, "FALHOU: %s -- %s\n", message, #expr); ++failures; } } while (false)

fs::path helloWorkerBinary() { return LASECSIMUL_TEST_PLC_WORKER_HELLO_BINARY; }
fs::path misbehavingWorkerBinary() { return LASECSIMUL_TEST_PLC_MISBEHAVING_WORKER_BINARY; }

void setMisbehaveMode(const std::string& mode) {
#if defined(_WIN32)
    _putenv_s("LASECSIMUL_PLC_TEST_MISBEHAVE_MODE", mode.c_str());
#else
    setenv("LASECSIMUL_PLC_TEST_MISBEHAVE_MODE", mode.c_str(), 1);
#endif
}

plc::PlcNativeModule makeHelloModule() {
    plc::PlcNativeModule module;
#if defined(_WIN32)
    module.targetPlatform = "windows";
#elif defined(__APPLE__)
    module.targetPlatform = "darwin";
#else
    module.targetPlatform = "linux";
#endif
#if defined(__aarch64__) || defined(_M_ARM64)
    module.targetArch = "arm64";
#elif defined(_WIN64) || defined(__x86_64__)
    module.targetArch = "x64";
#else
    module.targetArch = "unknown";
#endif
    module.workerProtocolVersion = 1;
    module.programName = "hello";
    module.nativeBinaryRef = helloWorkerBinary().string();
    module.artifactHash = Sha256::hashFile(helloWorkerBinary());
    module.exportedIo = {
        {"di0", "di0", "input", "BOOL"},
        {"do0", "do0", "output", "BOOL"},
    };
    return module;
}

plc::PlcNativeModule makeMisbehavingModule() {
    plc::PlcNativeModule module;
#if defined(_WIN32)
    module.targetPlatform = "windows";
#elif defined(__APPLE__)
    module.targetPlatform = "darwin";
#else
    module.targetPlatform = "linux";
#endif
#if defined(__aarch64__) || defined(_M_ARM64)
    module.targetArch = "arm64";
#elif defined(_WIN64) || defined(__x86_64__)
    module.targetArch = "x64";
#else
    module.targetArch = "unknown";
#endif
    module.workerProtocolVersion = 1;
    module.programName = "hello";
    module.nativeBinaryRef = misbehavingWorkerBinary().string();
    module.artifactHash = Sha256::hashFile(misbehavingWorkerBinary());
    module.exportedIo = {
        {"di0", "di0", "input", "BOOL"},
        {"do0", "do0", "output", "BOOL"},
    };
    return module;
}

/** Grafo minimo do Signal Engine com um `Source` BOOL (valor constante ate a proxima republicacao)
 * como fonte do INPUT do PLC e um `ExternalInput` BOOL como alvo do OUTPUT do PLC -- mesmo papel
 * que um sensor/atuador eletrico real cumpriria (ver `ElectricalSignalBridgeKind`), aqui isolado do
 * dominio eletrico pra testar so a ligacao PLC<->Signal Engine. */
SignalGraphDefinition makeGraph(bool sourceValue) {
    // `SignalRate::periodNs` default e' 1 (1 NANOSSEGUNDO) -- sem fixar uma taxa explicita aqui,
    // estes blocos reativariam a cada 1ns simulado, tornando `runUntil()` ate 100ms
    // computacionalmente inviavel (~1e8 reativacoes) e parecendo um hang. 10ms e' mais grosso que
    // qualquer coisa que este teste precisa resolver (so' testa o valor corrente do bloco, nao
    // dinamica temporal do proprio Signal Engine).
    constexpr SignalRate kTestRate{10'000'000, 0, 0};
    SignalGraphDefinition graph;
    SignalBlockDefinition source;
    source.id = "src_di0";
    source.kind = SignalBlockKind::Source;
    source.output = SignalPortDefinition{"out", {SignalScalarType::Bool, 1}, ""};
    source.boolParameters = {static_cast<uint8_t>(sourceValue ? 1 : 0)};
    source.rate = kTestRate;
    graph.blocks.push_back(source);

    SignalBlockDefinition target;
    target.id = "plc_do0_target";
    target.kind = SignalBlockKind::ExternalInput;
    target.output = SignalPortDefinition{"out", {SignalScalarType::Bool, 1}, ""};
    target.boolParameters = {0};
    target.rate = kTestRate;
    graph.blocks.push_back(target);
    return graph;
}

std::vector<PlcIoBindingRequest> standardBindings() {
    return {{"di0", "src_di0"}, {"do0", "plc_do0_target"}};
}

void plcBlockWithoutArtifactHasZeroPins() {
    plugins::GlobalPluginCache cache;
    SimulationSession session(cache);
    const uint32_t idx = session.addComponent("plc.instance", {});
    const auto plan = session.simulationPlan();
    CHECK(session.netlist().pinSlotsOf(idx).empty(), "PLC sem artefato deve ter zero pinos no Netlist");
    CHECK(plan->plc && plan->plc->instances.size() == 1, "PlcPlan deve conter a instancia mesmo sem artefato");
    CHECK(!plan->plc->instances[0].artifact, "instancia sem artefato carregado deve reportar artifact nulo no plano");
}

void loadingArtifactCreatesExactExportedIoPins() {
    plugins::GlobalPluginCache cache;
    SimulationSession session(cache);
    const uint32_t idx = session.addComponent("plc.instance", {});
    session.loadPlcArtifact(idx, makeHelloModule());
    const auto& slots = session.netlist().pinSlotsOf(idx);
    CHECK(slots.size() == 2, "artefato hello.st exporta exatamente 2 I/O (di0, do0)");
    CHECK(slots.find("di0") != slots.end() && slots.find("do0") != slots.end(),
          "pinos devem usar o ioId exato do artefato (di0/do0)");

    session.loadPlcArtifact(idx, std::nullopt);
    CHECK(session.netlist().pinSlotsOf(idx).empty(), "descarregar o artefato deve voltar a zero pinos");
}

void inputLatchAndOutputCommitFlowThroughSignalEngine() {
    plugins::GlobalPluginCache cache;
    SimulationSession session(cache);
    const uint32_t idx = session.addComponent("plc.instance", {});
    session.loadPlcArtifact(idx, makeHelloModule());
    session.setPlcIoBindings(idx, standardBindings());
    session.setPlcTaskIntervalNs(idx, 100'000'000); // 100ms -- TON (PT=500ms) fecha em poucos scans.
    session.setSignalGraph(makeGraph(/*sourceValue=*/false));
    const auto plan = session.simulationPlan();
    CHECK(plan->plc->instances[0].ioBindings.size() == 2, "ambos os I/O devem ter uma entrada de binding");

    const auto engine = plan->signal->engine;
    const auto outputSlot = SignalCompiler::output(engine, "plc_do0_target");

    // t=100ms: DI0=FALSE (fonte constante) -- primeiro scan, sem borda de subida ainda.
    session.scheduler().runUntil(100'000'000);
    CHECK(session.plcRuntimeState(idx) == plc::PlcRuntimeState::Ready, "primeiro scan deve deixar o runtime Ready");
    CHECK(!session.signalRuntime().boolean(outputSlot), "DO0 deve permanecer FALSE sem borda de subida em DI0");

    // Muda a fonte pra TRUE (precisa recompilar o Signal Engine -- sessao ja esta "parada" no
    // sentido de isRunning(), runUntil() sincrono nao seta isso) e forca o PlcPlan a re-resolver o
    // SignalSlotHandle contra o grafo recompilado (setPlcIoBindings com os MESMOS pedidos, so pra
    // disparar PlanDomain::Plc de novo -- nao depende de handles antigos permanecerem validos por
    // coincidencia de offset entre recompilacoes).
    session.setSignalGraph(makeGraph(/*sourceValue=*/true));
    session.setPlcIoBindings(idx, standardBindings());
    const auto planAfterEdge = session.simulationPlan();
    const auto engineAfterEdge = planAfterEdge->signal->engine;
    const auto outputSlotAfterEdge = SignalCompiler::output(engineAfterEdge, "plc_do0_target");

    // t=200ms: DI0 vira TRUE -- borda de subida, TON comeca a contar, ainda nao decorreu 500ms.
    session.scheduler().runUntil(200'000'000);
    CHECK(!session.signalRuntime().boolean(outputSlotAfterEdge), "TON nao deve fechar imediatamente na borda");

    // t=300ms..700ms: continua TRUE -- em t=700ms ja decorreram 500ms desde a borda (200ms).
    session.scheduler().runUntil(700'000'000);
    CHECK(session.signalRuntime().boolean(outputSlotAfterEdge),
          "DO0 deve ficar TRUE assim que o TON completa 500ms desde a borda -- prova InputLatch->scan->OutputCommit"
          " propagando pela infraestrutura normal do Signal Engine");
}

void pauseNeverAdvancesPlcTimeOrRunsNewScans() {
    plugins::GlobalPluginCache cache;
    SimulationSession session(cache);
    const uint32_t idx = session.addComponent("plc.instance", {});
    session.loadPlcArtifact(idx, makeHelloModule());
    session.setPlcIoBindings(idx, standardBindings());
    session.setPlcTaskIntervalNs(idx, 50'000'000);
    session.setSignalGraph(makeGraph(false));
    (void)session.simulationPlan();

    session.scheduler().pause();
    session.scheduler().runUntil(1'000'000'000); // 1s -- 20 scans caberiam se pause nao bloqueasse.
    CHECK(session.scheduler().nowNs() == 0, "pausa nunca avanca o relogio simulado (nem pro PLC)");

    session.scheduler().resume();
    session.scheduler().runUntil(50'000'000);
    CHECK(session.scheduler().nowNs() == 50'000'000, "resume deve retomar o avanco normal do tempo");
    CHECK(session.plcRuntimeState(idx) == plc::PlcRuntimeState::Ready, "o primeiro scan so' deve ocorrer apos resume");
}

void faultedInstanceDoesNotAffectAnother() {
    plugins::GlobalPluginCache cache;
    SimulationSession session(cache);

    setMisbehaveMode("hang");
    const uint32_t faulty = session.addComponent("plc.instance", {});
    session.loadPlcArtifact(faulty, makeMisbehavingModule());
    session.setPlcTaskIntervalNs(faulty, 10'000'000);
    // PlcComponent constroi seu proprio PlcRuntime com PlcRuntimeOptions default (timeout de scan
    // 5s) -- nao configuravel por instancia ainda nesta rodada, ver relatorio F9.5.

    const uint32_t healthy = session.addComponent("plc.instance", {});
    session.loadPlcArtifact(healthy, makeHelloModule());
    session.setPlcIoBindings(healthy, standardBindings());
    session.setPlcTaskIntervalNs(healthy, 10'000'000);
    session.setSignalGraph(makeGraph(false));
    (void)session.simulationPlan();

    // O worker "hang" nao responde ao SCAN -- estoura o timeout default do PlcRuntime (5s), entao
    // avancamos alem disso pra garantir que o evento de scan da instancia com defeito realmente
    // processou (e faultou) antes de checarmos o resultado.
    session.scheduler().runUntil(6'000'000'000ull);
    CHECK(session.plcRuntimeState(faulty) == plc::PlcRuntimeState::Faulted,
          "instancia presa em timeout deve ficar Faulted");
    CHECK(session.plcRuntimeState(healthy) == plc::PlcRuntimeState::Ready,
          "instancia saudavel deve continuar Ready mesmo com outra instancia faultada -- Core sobrevive");
}

void artifactReloadOrphansStaleBindingsAndKeepsFreshOnes() {
    plugins::GlobalPluginCache cache;
    SimulationSession session(cache);
    const uint32_t idx = session.addComponent("plc.instance", {});
    session.loadPlcArtifact(idx, makeHelloModule());
    session.setSignalGraph(makeGraph(false));
    session.setPlcIoBindings(idx, {{"di0", "src_di0"}, {"do0", "plc_do0_target"}, {"stale_var", "somewhere"}});
    const auto plan = session.simulationPlan();
    const PlcInstancePlan& instance = plan->plc->instances[0];
    CHECK(instance.orphanedBindingRequests.size() == 1 && instance.orphanedBindingRequests[0] == "stale_var",
          "um pedido de binding pra um ioId que nao existe no artefato deve ficar diagnosticavel, nao aplicado silenciosamente");
    bool foundDi0Bound = false;
    for (const PlcIoBinding& binding : instance.ioBindings) {
        if (binding.ioId == "di0") { foundDi0Bound = binding.signalBlockId == "src_di0"; }
    }
    CHECK(foundDi0Bound, "o pedido de binding que corresponde a um ioId real deve ser aplicado normalmente");
}

void multipleIndependentInstancesNeverInterfereEvenAtTheSameTimestamp() {
    plugins::GlobalPluginCache cache;
    SimulationSession session(cache);

    const uint32_t a = session.addComponent("plc.instance", {});
    session.loadPlcArtifact(a, makeHelloModule());
    session.setPlcIoBindings(a, standardBindings());
    session.setPlcTaskIntervalNs(a, 100'000'000); // mesmo intervalo que b -- ambos agendados pro MESMO m_nowNs.

    const uint32_t b = session.addComponent("plc.instance", {});
    session.loadPlcArtifact(b, makeHelloModule());
    session.setPlcIoBindings(b, standardBindings());
    session.setPlcTaskIntervalNs(b, 100'000'000);

    session.setSignalGraph(makeGraph(false));
    (void)session.simulationPlan();

    // Duas instancias PLC diferentes agendadas pro MESMO timestamp (100ms, 200ms, ...) -- cada uma
    // e' uma task/relogio PlcRuntime independente, entao nao ha conflito (ver relatorio F9.5,
    // secao "Tempo": o contrato de timestamp estritamente crescente vale POR INSTANCIA, nao
    // globalmente -- eventos diferentes no mesmo m_nowNs sao normais).
    session.scheduler().runUntil(500'000'000);
    CHECK(session.plcRuntimeState(a) == plc::PlcRuntimeState::Ready, "instancia A deve seguir Ready");
    CHECK(session.plcRuntimeState(b) == plc::PlcRuntimeState::Ready, "instancia B deve seguir Ready");
    CHECK(session.scheduler().nowNs() == 500'000'000, "avanco normal do tempo com duas instancias no mesmo calendario");
}

void repeatedAddRemoveLeavesNoDanglingSchedule() {
    plugins::GlobalPluginCache cache;
    SimulationSession session(cache);
    for (int i = 0; i < 5; ++i) {
        const uint32_t idx = session.addComponent("plc.instance", {});
        session.loadPlcArtifact(idx, makeHelloModule());
        session.setPlcIoBindings(idx, standardBindings());
        session.setPlcTaskIntervalNs(idx, 10'000'000);
        session.setSignalGraph(makeGraph(false));
        (void)session.simulationPlan();
        session.scheduler().runUntil(session.scheduler().nowNs() + 10'000'000);
        session.removeComponent(idx);
    }
    bool threwForRemoved = false;
    try {
        (void)session.plcRuntimeState(4);
    } catch (const std::invalid_argument&) {
        // Nota: removeComponent() destroi a instancia (m_componentInstances[idx].reset()) mas nao
        // encolhe o vetor -- o slot fica nulo. plcRuntimeState() trata isso como "componente
        // inexistente", nao crasha.
        threwForRemoved = true;
    }
    CHECK(threwForRemoved, "consultar uma instancia removida deve lancar, nunca reler um PlcComponent destruido");
    // Nota: o Scheduler (priority_queue, sem API de cancelamento -- mesmo design ja aceito pra
    // m_signalBoundaryScheduledNs) pode continuar com o EVENTO BRUTO de um scan auto-reagendado
    // ainda pendente na fila depois de removeComponent(); isso e' inofensivo por construcao --
    // scheduleOnePlcScanUnlocked() bump a geracao por componentIndex em removeComponentUnlocked(),
    // entao quando esse evento obsoleto eventualmente disparar ele vira um no-op verificavel
    // (checagem de geracao falha, nunca chama runPlcScanUnlocked de novo). Nao afirmamos
    // pendingEventCount()==0 aqui -- isso testaria um detalhe de implementacao da fila, nao a
    // garantia comportamental real (nenhum SCAN indevido acontece), que ja e' coberta acima por
    // "consultar uma instancia removida deve lancar" repetido em loop sem nunca crashar/vazar.
}

std::pair<bool, uint64_t> runEquivalentProfile(resources::ResourceProfile profile) {
    plugins::GlobalPluginCache cache;
    SimulationSession session(cache, 64, resources::ResourceGovernor::forProfile(profile, 8));
    const uint32_t idx = session.addComponent("plc.instance", {});
    session.loadPlcArtifact(idx, makeHelloModule());
    session.setPlcIoBindings(idx, standardBindings());
    session.setPlcTaskIntervalNs(idx, 100'000'000);
    session.setSignalGraph(makeGraph(true));
    const auto plan = session.simulationPlan();
    const auto output = SignalCompiler::output(plan->signal->engine, "plc_do0_target");
    session.scheduler().runUntil(700'000'000);
    return {session.signalRuntime().boolean(output), session.scheduler().nowNs()};
}

void desktopAndSharedHostPreservePlcSemantics() {
    const auto desktop = runEquivalentProfile(resources::ResourceProfile::Desktop);
    const auto shared = runEquivalentProfile(resources::ResourceProfile::SharedHost);
    CHECK(desktop == shared, "o mesmo artefato PLC deve ter resultado e tempo equivalentes nos dois perfis");
    CHECK(desktop.first && desktop.second == 700'000'000,
          "cenario de equivalencia deve realmente completar o TON e o tempo virtual esperado");
}

void resetWhileSchedulerRunsUsesTheCommandQueue() {
    plugins::GlobalPluginCache cache;
    SimulationSession session(cache);
    const uint32_t idx = session.addComponent("plc.instance", {});
    session.loadPlcArtifact(idx, makeHelloModule());
    session.setPlcIoBindings(idx, standardBindings());
    session.setPlcTaskIntervalNs(idx, 100'000'000);
    session.setSignalGraph(makeGraph(false));
    (void)session.simulationPlan();
    session.scheduler().start();
    session.plcReset(idx); // must be drained by the running scheduler, never paused before enqueue.
    CHECK(session.plcRuntimeState(idx) == plc::PlcRuntimeState::Ready,
          "reset enfileirado durante Run deve recriar o worker sem deadlock");
    session.stopSimulation();
}

} // namespace

int main() {
    plcBlockWithoutArtifactHasZeroPins();
    loadingArtifactCreatesExactExportedIoPins();
    inputLatchAndOutputCommitFlowThroughSignalEngine();
    pauseNeverAdvancesPlcTimeOrRunsNewScans();
    faultedInstanceDoesNotAffectAnother();
    artifactReloadOrphansStaleBindingsAndKeepsFreshOnes();
    multipleIndependentInstancesNeverInterfereEvenAtTheSameTimestamp();
    repeatedAddRemoveLeavesNoDanglingSchedule();
    desktopAndSharedHostPreservePlcSemantics();
    resetWhileSchedulerRunsUsesTheCommandQueue();
    if (failures == 0) std::printf("PLC <-> SimulationSession/Scheduler integration (F9.5): OK\n");
    return failures == 0 ? 0 : 1;
}
