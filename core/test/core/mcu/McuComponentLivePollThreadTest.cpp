// PERF-12 (docs/33-plano-revisao-arquitetural-core.md, alternativa C): McuComponentTest.cpp cobre
// a ponte registrador<->pino inteira, mas SEMPRE via Scheduler síncrono (settleStep()/step()) --
// nunca exercita `Scheduler::isRunning()==true`, o único estado em que McuComponent::onPollEvent()
// agora entrega o busy-wait para uma thread de poll dedicada (runBackgroundPollLoop) em vez de
// segurar a thread do Scheduler. Esse caminho também não é coberto por McuBlinkLongRunTest (só
// roda com LASECSIMUL_TEST_FIRMWARE setado, tipicamente ausente em CI) nem por
// McuMultipleControllersRealQemuTest (não sobe McuComponent/Scheduler nenhum, só McuController).
//
// Usa arena sintética (mesma técnica de McuComponentTest, sem QEMU real) só que com
// `session.scheduler().start()` ligado de verdade -- prova que a thread dedicada de poll: (a)
// desperta e despacha escritas de registrador publicadas por OUTRA thread sem qualquer
// settleStep()/markDirty() manual; (b) duas instâncias concorrentes não colidem nem perdem eventos
// uma da outra; (c) recarregar firmware repetidamente enquanto o Scheduler está vivo não
// deadlocka (a interação mais arriscada: `stopFirmware()`/`loadFirmware()` seguram
// `m_callbackState->mutex` e podem ser chamados a partir de um callback que JÁ segura esse mutex
// recursivamente, ver onEvent() -- a thread de poll nunca pode depender de join() pra terminar).
#include <atomic>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <string>
#include <thread>
#include <vector>
#include "components/active/DiodeLegArray.hpp"
#include "components/other/Ground.hpp"
#include "components/passive/Resistor.hpp"
#include "lasecsimul/qemu_arena_abi.h"
#include "mcu/McuComponent.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "plugins/PluginRuntime.hpp"
#include "session/SimulationSession.hpp"

using namespace lasecsimul;
using namespace lasecsimul::session;

namespace {

int failures = 0;

void check(bool ok, const char* label) {
    if (ok) std::printf("OK: %s\n", label);
    else {
        std::fprintf(stderr, "FALHOU: %s\n", label);
        failures++;
    }
}

std::string uniqueArenaName(const char* suffix) {
    return "lasecsimul-mcu-live-poll-test-" + std::string(suffix) + "-" +
           std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
}

// Mesmo papel do helper em McuComponentTest.cpp: simula o que writeReg(addr,value) do lado QEMU
// real faria (ver simuliface.c) -- escreve direto nos campos brutos da arena, sem lock nenhum
// (mesma coisa que o processo QEMU real faz via memória compartilhada; a serialização contra o
// poll do McuComponent vem do protocolo de slot único simuTime==0, não de um mutex do lado C++).
void simulateQemuWrite(LsdnQemuArena* arena, uint64_t addr, uint64_t value) {
    arena->regAddr = addr;
    arena->regData = value;
    arena->simuAction = LSDN_SIM_WRITE;
    arena->simuTime = 1;
}

// Espera até `timeout` por uma condição observável via poll -- corrida real contra threads vivas,
// não uma constante de sleep fixa (mesma disciplina de waitForLogSubstring em
// McuMultipleControllersRealQemuTest.cpp/McuControllerRealQemuTest.cpp).
template <class Predicate>
bool waitUntil(Predicate predicate, std::chrono::milliseconds timeout = std::chrono::seconds(5)) {
    const auto deadline = std::chrono::steady_clock::now() + timeout;
    do {
        if (predicate()) return true;
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
    } while (std::chrono::steady_clock::now() < deadline);
    return predicate();
}

// session.nodeVoltageOfPin() pode lançar se o Scheduler estiver no meio de um passo (mesma
// ressalva de McuBlinkLongRunTest.cpp) -- lido com retry em vez de deixar a exceção derrubar a
// tentativa inteira de waitUntil().
double tryReadVoltage(SimulationSession& session, uint32_t componentIndex, const char* pin, double fallback) {
    try {
        return session.nodeVoltageOfPin(componentIndex, pin);
    } catch (const std::exception&) {
        return fallback;
    }
}

// Alterna GPIO_ENABLE_REG (offset 0x20, bit 2 = pino 2 como saída) + GPIO_OUT_REG (offset 0x04) em
// `arena`, então espera a tensão do `pin` convergir para o nível esperado via a thread de poll
// dedicada -- SEM settleStep()/markDirty() manual, diferente de McuComponentTest.cpp.
bool toggleAndWaitForLevel(LsdnQemuArena* arena, uint64_t gpioStart, SimulationSession& session,
                            uint32_t componentIndex, const char* pin, bool high) {
    simulateQemuWrite(arena, gpioStart + 0x20, 1u << 2); // GPIO_ENABLE_REG: pino 2 como saida
    if (!waitUntil([&] { return arena->simuTime == 0; })) return false; // aguarda a thread de poll confirmar
    simulateQemuWrite(arena, gpioStart + 0x04, high ? (1u << 2) : 0u); // GPIO_OUT_REG
    if (!waitUntil([&] { return arena->simuTime == 0; })) return false;
    return waitUntil([&] {
        const double volts = tryReadVoltage(session, componentIndex, pin, high ? 0.0 : 5.0);
        return high ? volts > 3.0 : volts < 0.5;
    });
}

} // namespace

namespace {

// Achado 2026-07-21 (relato ao vivo do usuário: simulação travava em 0% depois de alguns minutos
// rodando): Scheduler::runUntil() segura Scheduler::m_mutex pelo laço de settle inteiro, e stamp()
// (chamado de dentro dele) adquire m_callbackState->mutex NESSA ordem -- a thread de poll dedicada
// fazia o inverso antes da correção. Esta rajada tenta reproduzir a janela de corrida de verdade:
// uma thread dedicada escreve registradores o mais rápido possível (respeitando só o protocolo de
// slot único da arena) enquanto o pino alvo está ligado a um LED não-linear (força várias iterações
// de Newton -- logo várias chamadas a stamp() -- por toggle, a mesma montagem de McuComponentTest),
// e a thread principal concorrentemente chama session.componentHealth() (o MESMO caminho real de
// produção: Scheduler::trySynchronized() -> McuComponent::health(), que expôs a segunda metade do
// bug: onEvent()/loadFirmware() aninhados via callback agendado vs. este caminho). Sem a correção,
// isto trava o processo inteiro (não falha um assert -- o timeout do CTest configurado no
// CMakeLists é quem pegaria a regressão).
void runConcurrentStressBurst(SimulationSession& session, mcu::McuComponent& mcu, uint32_t componentIndex,
                               LsdnQemuArena* arena, uint64_t gpioStart, std::chrono::seconds duration) {
    simulateQemuWrite(arena, gpioStart + 0x20, 1u << 2); // GPIO_ENABLE_REG: pino 2 como saida, uma vez.
    waitUntil([&] { return arena->simuTime == 0; });

    std::atomic<bool> running{true};
    std::atomic<uint64_t> writeCount{0};
    std::thread writer([&] {
        bool level = false;
        while (running.load(std::memory_order_relaxed)) {
            // Respeita o protocolo de slot único (mesmo raciocínio de QemuArenaBridge::poll()):
            // só publica a próxima escrita depois que a thread de poll dedicada confirmou a
            // anterior (simuTime volta a 0) -- sem isso estaríamos testando um cenário que nem o
            // QEMU real produziria.
            while (running.load(std::memory_order_relaxed) && arena->simuTime != 0) std::this_thread::yield();
            if (!running.load(std::memory_order_relaxed)) break;
            level = !level;
            simulateQemuWrite(arena, gpioStart + 0x04, level ? (1u << 2) : 0u);
            writeCount.fetch_add(1, std::memory_order_relaxed);
        }
    });

    uint64_t healthChecks = 0;
    const auto deadline = std::chrono::steady_clock::now() + duration;
    while (std::chrono::steady_clock::now() < deadline) {
        try {
            (void)session.componentHealth(componentIndex);
        } catch (const std::exception&) {
            // "simulacao ocupada" (trySynchronized não conseguiu o lock agora) é esperado e
            // inofensivo -- só reflete contenção real, não uma falha.
        }
        ++healthChecks;
    }
    running.store(false, std::memory_order_relaxed);
    writer.join();

    std::fprintf(stderr, "  [info] rajada de %lld s: %llu escritas de registrador, %llu chamadas a componentHealth()\n",
                 static_cast<long long>(duration.count()), static_cast<unsigned long long>(writeCount.load()),
                 static_cast<unsigned long long>(healthChecks));
    check(writeCount.load() > 200,
          "thread dedicada publicou um volume alto de escritas concorrentes durante a rajada (nao ficou presa)");
    (void)mcu;
}

} // namespace

int main() {
#ifndef ESP32_ADAPTER_DLL_PATH
#error "ESP32_ADAPTER_DLL_PATH precisa ser definido pelo CMakeLists (caminho do adapter.dll real)"
#endif
    const std::filesystem::path dllPath = ESP32_ADAPTER_DLL_PATH;
    if (!std::filesystem::exists(dllPath)) {
        std::fprintf(stderr,
                      "PULADO: %s não existe -- rode 'npm run build:mcu-adapters' antes deste teste.\n",
                      dllPath.string().c_str());
        return 0;
    }

    plugins::GlobalPluginCache cache;
    std::shared_ptr<plugins::PluginModule> module = cache.loader().loadMcuPlugin(dllPath);
    cache.setActiveMcuModule("espressif.esp32", module);

    SimulationSession session(cache);
    session.registerKnownMcuTypes();

    plugins::PluginRuntime runtime(cache);
    const std::unique_ptr<IMcuAdapter> probeAdapter = runtime.createMcuAdapter("espressif.esp32");
    uint64_t gpioStart = 0;
    for (const MemoryRegion& region : probeAdapter->memoryRegions()) {
        if (region.moduleKind == ModuleKind::Gpio && region.moduleIndex == 0) gpioStart = region.start;
    }
    check(gpioStart != 0, "memoryRegions() do plugin declara uma faixa GPIO");

    // Duas instâncias independentes -- mesmo raciocínio de McuMultipleControllersRealQemuTest: o
    // ponto de PERF-12 é que threads de poll dedicadas não podem serializar uma na outra nem
    // colidir em estado compartilhado indevido.
    std::vector<mcu::McuComponent*> mcus;
    session.components().registerFactory("mcu.esp32", [&mcus, &session](const registry::ComponentParams&) {
        auto instance = std::make_unique<mcu::McuComponent>(session.mcus().create("espressif.esp32"), session.scheduler());
        mcus.push_back(instance.get());
        return instance;
    });
    const uint32_t indexA = session.addComponent("mcu.esp32", {});
    const uint32_t indexB = session.addComponent("mcu.esp32", {});
    check(mcus.size() == 2, "duas instâncias de McuComponent criadas");
    mcu::McuComponent* mcuA = mcus[0];
    mcu::McuComponent* mcuB = mcus[1];

    mcuA->openSyntheticArenaForTesting(uniqueArenaName("a"));
    mcuB->openSyntheticArenaForTesting(uniqueArenaName("b"));
    LsdnQemuArena* arenaA = mcuA->arenaBridge().arena();
    LsdnQemuArena* arenaB = mcuB->arenaBridge().arena();

    // Liga o Scheduler de verdade -- ponto central deste teste: a partir daqui, McuComponent::
    // onPollEvent() vê isRunning()==true e delega para runBackgroundPollLoop() em vez do laço
    // síncrono que McuComponentTest.cpp exercita.
    session.scheduler().start();
    check(session.scheduler().isRunning(), "Scheduler realmente rodando em background");

    // Escritas intercaladas nas duas arenas, sem nenhum settleStep()/markDirty() manual -- só a
    // thread de poll dedicada de cada McuComponent deveria perceber e despachar cada uma.
    bool allTogglesOk = true;
    for (int cycle = 0; cycle < 15; ++cycle) {
        const bool levelA = (cycle % 2) == 0;
        const bool levelB = (cycle % 2) != 0; // fase oposta -- garante que as duas nao ficam sempre iguais por acidente
        if (!toggleAndWaitForLevel(arenaA, gpioStart, session, indexA, "GPIO2", levelA)) allTogglesOk = false;
        if (!toggleAndWaitForLevel(arenaB, gpioStart, session, indexB, "GPIO2", levelB)) allTogglesOk = false;
    }
    check(allTogglesOk,
          "15 ciclos de escrita intercalada em 2 MCUs convergem via thread de poll dedicada, sem settleStep()/markDirty() manual");

    check(mcuA->health() == PluginHealthStatus::Ok && mcuB->health() == PluginHealthStatus::Ok,
          "as duas instâncias continuam saudáveis depois da rajada de escritas concorrentes");

    // LED não-linear no GPIO2 de A -- cada toggle força várias iterações de Newton (várias
    // chamadas a stamp()) até convergir, a mesma montagem de McuComponentTest -- maximiza a chance
    // da thread do Scheduler estar DENTRO de stamp() (segurando as duas travas, nessa ordem)
    // exatamente quando a rajada abaixo despacha um evento pela thread de poll dedicada.
    session.components().registerFactory("passive.resistor", [](const registry::ComponentParams& p) {
        return std::make_unique<components::Resistor>(std::array<Pin, 2>{Pin{"pin-1"}, Pin{"pin-2"}},
                                                        p.property("resistance", 220.0));
    });
    session.components().registerFactory("outputs.led", [](const registry::ComponentParams&) {
        return std::make_unique<components::DiodeLegArray>(
            "outputs.led", std::vector<Pin>{Pin{"anode"}, Pin{"cathode"}},
            std::vector<components::DiodeLegArray::Leg>{{0, 1}});
    });
    session.components().registerFactory("other.ground", [](const registry::ComponentParams&) {
        return std::make_unique<components::Ground>(Pin{"pin"});
    });
    const uint32_t resistorIndex = session.addComponent("passive.resistor", {});
    const uint32_t ledIndex = session.addComponent("outputs.led", {});
    const uint32_t groundIndex = session.addComponent("other.ground", {});
    session.connectWire(indexA, "GPIO2", resistorIndex, "pin-1");
    session.connectWire(resistorIndex, "pin-2", ledIndex, "anode");
    session.connectWire(ledIndex, "cathode", groundIndex, "pin");

    // A rajada de verdade: ~4s de relógio real com escritas concorrentes o mais rápido possível +
    // session.componentHealth() (Scheduler::trySynchronized() -> McuComponent::health()) batendo
    // ao mesmo tempo -- sem a correção do lock-order, isto trava o processo inteiro.
    runConcurrentStressBurst(session, *mcuA, indexA, arenaA, gpioStart, std::chrono::seconds(4));
    check(mcuA->health() == PluginHealthStatus::Ok, "MCU A continua saudável depois da rajada concorrente de 4s");
    check(session.scheduler().isRunning(), "Scheduler continua rodando depois da rajada (nao travou)");

    // Recarrega firmware repetidamente com o Scheduler VIVO -- interação mais arriscada do
    // redesenho: stopFirmware()/loadFirmware() seguram m_callbackState->mutex, e a thread de poll
    // dedicada nunca pode depender de join() pra terminar (ver comentário de runBackgroundPollLoop
    // no .cpp) -- se essa suposição estiver errada, isto trava o processo em vez de falhar um
    // assert (o timeout do CTest pega, mas o objetivo aqui é nunca chegar nele).
    for (int cycle = 0; cycle < 10; ++cycle) {
        mcuA->stopFirmware();
        mcuA->openSyntheticArenaForTesting(uniqueArenaName("a-reload"));
    }
    arenaA = mcuA->arenaBridge().arena();
    check(mcuA->arenaBridge().isOpen(), "arena A reaberta depois de 10 ciclos de reload com o Scheduler vivo");
    check(toggleAndWaitForLevel(arenaA, gpioStart, session, indexA, "GPIO2", true),
          "MCU A volta a responder a escritas de registrador depois dos reloads ao vivo");

    // Parada limpa: stopSimulation() precisa devolver o controle (sem travar) mesmo com as duas
    // threads de poll dedicadas ainda potencialmente ativas.
    session.stopSimulation();
    check(!session.scheduler().isRunning(), "Scheduler parado depois de stopSimulation()");
    check(mcuA->health() == PluginHealthStatus::Ok && mcuB->health() == PluginHealthStatus::Ok,
          "as duas instâncias continuam saudáveis depois da parada");

    if (failures == 0) {
        std::printf("\nTodos os testes de McuComponentLivePollThread passaram.\n");
        return 0;
    }
    std::fprintf(stderr, "\n%d teste(s) FALHARAM.\n", failures);
    return 1;
}
