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
// real faria (protocolo v3, ver qemu_arena_abi.h/simuliface.c::pushQueueEntry) -- publica uma
// entrada na fila de escritas/heartbeat direto nos campos brutos da arena, sem lock nenhum (mesma
// coisa que o processo QEMU real faz via memória compartilhada; a serialização contra o poll do
// McuComponent vem do protocolo de índices da fila, não de um mutex do lado C++).
void simulateQemuWrite(LsdnQemuArena* arena, uint64_t addr, uint64_t value) {
    const uint64_t slot = arena->queueWriteIndex % LSDN_QEMU_ARENA_QUEUE_DEPTH;
    arena->queue[slot].regAddr = addr;
    arena->queue[slot].regData = value;
    arena->queue[slot].simuAction = LSDN_SIM_WRITE;
    arena->queue[slot].simuTime = 1;
    arena->queueWriteIndex++;
}

// Fila totalmente vazia -- corresponde a "toda entrada publicada até agora já foi consumida pela
// thread de poll dedicada" (mesma condição que readReg() do lado QEMU real espera antes de emitir
// uma leitura, ver waitForQueueDrain() em simuliface.c).
bool queueDrained(const LsdnQemuArena* arena) { return arena->queueReadIndex == arena->queueWriteIndex; }

// TEMPORARY regression test infra (2026-08-27, duplicate I2C dispatch fix) -- simula o que
// i2cBurstTransfer() do lado QEMU real faria (ABI v5, ver qemu_arena_abi.h/simuliface.c): publica
// os campos do pedido e SÓ POR ÚLTIMO i2cRequestSeq (mesmo motivo de simulateQemuWrite() publicar
// queueWriteIndex por último -- é isso que torna o pedido visível/pendente pro lado Core).
void simulateQemuI2cBurstRequest(LsdnQemuArena* arena, uint64_t sequence, uint8_t addressByte) {
    arena->i2cBus = 0;
    arena->i2cFlags = 0x3; // START|STOP, sem READ -- uma escrita completa de um byte
    arena->i2cPeriodNs = 10000; // 100kHz nominal, irrelevante pro teste (sem plugin real de barramento)
    arena->i2cTxLen = 1;
    arena->i2cRxLen = 0;
    arena->i2cTx[0] = addressByte;
    arena->i2cRequestSeq = sequence;
}

bool i2cResponseObserved(const LsdnQemuArena* arena, uint64_t sequence) {
    return arena->i2cResponseSeq == sequence;
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
    if (!waitUntil([&] { return queueDrained(arena); })) return false; // aguarda a thread de poll confirmar
    simulateQemuWrite(arena, gpioStart + 0x04, high ? (1u << 2) : 0u); // GPIO_OUT_REG
    if (!waitUntil([&] { return queueDrained(arena); })) return false;
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
    waitUntil([&] { return queueDrained(arena); });

    std::atomic<bool> running{true};
    std::atomic<uint64_t> writeCount{0};
    std::thread writer([&] {
        bool level = false;
        while (running.load(std::memory_order_relaxed)) {
            // Respeita o protocolo real de backpressure da fila (mesmo raciocínio de
            // QemuArenaBridge::poll()/waitForSynch() em simuliface.c): só bloqueia quando a fila
            // está CHEIA, publica livremente enquanto houver espaço -- diferente do protocolo v2
            // de slot único, que esperava CADA entrada confirmar antes da próxima.
            while (running.load(std::memory_order_relaxed) &&
                   (arena->queueWriteIndex - arena->queueReadIndex) >= LSDN_QEMU_ARENA_QUEUE_DEPTH) {
                std::this_thread::yield();
            }
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

// TEMPORARY regression test (2026-08-27, investigacao TG0WDT_SYS_RESET -- corrige a race de
// double-dispatch descrita em McuComponent.cpp::pollStepLocked()) -- exercita exatamente o
// mecanismo da race: onPollEvent() (thread do proprio Scheduler) e runBackgroundPollLoop() (thread
// de poll dedicada) ambos fazem peek em arena.pollI2cBurst(); antes da correcao, nada impedia as
// duas de despachar o MESMO i2cRequestSeq de forma independente enquanto o pedido seguia pendente
// (runBackgroundPollLoop() solta m_callbackState->mutex ANTES do dispatch, de proposito). Instala um
// handler contador diretamente via McuComponent::setI2cTransferHandler() -- o mesmo metodo publico
// que SimulationSession::resolveI2cTransferUnlocked() usa na producao -- para checar a invariante
// (um pedido -> exatamente um dispatch) sem precisar montar uma topologia eletrica I2C completa.
void runI2cDuplicateDispatchRegressionTest(mcu::McuComponent& mcu, LsdnQemuArena* arena) {
    std::atomic<uint64_t> lastDispatchCount{0};
    mcu.setI2cTransferHandler([&](uint32_t, uint32_t, const I2cTransfer&) -> I2cTransferResult {
        lastDispatchCount.fetch_add(1, std::memory_order_relaxed);
        // A race real (Pass 2, firmware/QEMU de verdade) tem uma janela de poucos microssegundos
        // entre runBackgroundPollLoop() soltar m_callbackState->mutex e completeI2cBurst() -- estreita
        // demais pra reproduzir de forma confiavel num dispatch sintetico instantaneo. O plugin OLED
        // real (devices/simulide-complex/src/lib.c) nao dorme, mas o CAMINHO ate ele (topologia +
        // m_deviceMutex) mediu tipicamente dezenas de microssegundos no Pass 2 -- ainda maior que um
        // retorno instantaneo. Alargar aqui pra alguns milissegundos e' o que da' ao Scheduler uma
        // chance real de disparar onPollEvent() durante a janela, sem inventar um segundo mecanismo
        // de forcar a concorrencia.
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
        I2cTransferResult result;
        result.handled = true;
        result.addressAck = true;
        return result;
    });

    auto publishAndVerifyOnce = [&](uint64_t sequence) -> bool {
        lastDispatchCount.store(0, std::memory_order_relaxed);
        simulateQemuI2cBurstRequest(arena, sequence, 0x3C << 1);
        if (!waitUntil([&] { return i2cResponseObserved(arena, sequence); })) return false;
        // Pequena folga: um segundo despacho concorrente (a propria race) pode publicar
        // completeI2cBurst() um pouco depois do primeiro -- ver reconstrucao causal na investigacao
        // TG0WDT_SYS_RESET (Pass 2). Sem esta folga, o teste poderia observar count==1 por sorte de
        // timing mesmo com a race presente.
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
        return lastDispatchCount.load(std::memory_order_relaxed) == 1;
    };

    // TESTE 1 (janela de partida): pedido publicado logo apos o Scheduler ligar, sem qualquer
    // garantia de que a thread de poll dedicada ja rodou. Sem a correcao, onPollEvent() (thread do
    // Scheduler) despacha sincronamente aqui -- ISSO e' o comportamento de janela de partida
    // pretendido (pollThreadRunning ainda false), preservado pela correcao; o teste garante que
    // continua despachando exatamente uma vez, nao zero e nao duas.
    check(publishAndVerifyOnce(1001),
          "pedido I2C na janela de partida (thread de poll ainda nao confirmada) despachado exatamente uma vez");

    // TESTE 2 (estado estacionario): espera a thread de poll dedicada confirmadamente rodando, guard
    // o mesmo estado ja mantido por CallbackState::pollThreadRunning (reutilizado, nao um novo bool),
    // depois publica varios pedidos sequenciais.
    check(waitUntil([&] { return mcu.pollThreadRunningForTesting(); }),
          "thread de poll dedicada confirmada rodando antes do teste de estado estacionario");
    bool allSteadyStateOk = true;
    for (uint64_t seq = 2000; seq < 2020; ++seq) {
        if (!publishAndVerifyOnce(seq)) allSteadyStateOk = false;
    }
    check(allSteadyStateOk, "20 pedidos I2C sequenciais em estado estacionario, cada um despachado exatamente uma vez");

    // TESTE 3 (estresse concorrente): escritas de registrador concorrentes (gerando wakeups
    // frequentes do Scheduler -- o gatilho real da race, via onPollEvent()) enquanto pedidos I2C sao
    // publicados um a um. Reproducao mais proxima da race original (19 duplicatas observadas no
    // Pass 2 real com firmware/QEMU de verdade).
    std::atomic<bool> stressRunning{true};
    std::thread stressWriter([&] {
        uint32_t counter = 0;
        while (stressRunning.load(std::memory_order_relaxed)) {
            while (stressRunning.load(std::memory_order_relaxed) &&
                   (arena->queueWriteIndex - arena->queueReadIndex) >= LSDN_QEMU_ARENA_QUEUE_DEPTH) {
                std::this_thread::yield();
            }
            if (!stressRunning.load(std::memory_order_relaxed)) break;
            simulateQemuWrite(arena, 0x3ff44004, counter++); // GPIO_OUT_REG; valor irrelevante aqui
        }
    });
    bool allStressOk = true;
    for (uint64_t seq = 3000; seq < 3040; ++seq) {
        if (!publishAndVerifyOnce(seq)) allStressOk = false;
    }
    stressRunning.store(false, std::memory_order_relaxed);
    stressWriter.join();
    check(allStressOk,
          "40 pedidos I2C sob rajada concorrente de escritas de registrador, cada um despachado exatamente uma vez");

    mcu.setI2cTransferHandler(nullptr);
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

    const std::string arenaNameA = uniqueArenaName("a");
    const std::string arenaNameB = uniqueArenaName("b");
    mcuA->openSyntheticArenaForTesting(arenaNameA);
    mcuB->openSyntheticArenaForTesting(arenaNameB);
    LsdnQemuArena* arenaA = mcuA->arenaBridge().arena();
    LsdnQemuArena* arenaB = mcuB->arenaBridge().arena();

    // A F3 torna o plano imutavel durante RUN. Monte o circuito nao-linear antes de iniciar a
    // worker; a rajada abaixo continua exercitando stamp()/health() concorrentemente em RUN.
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

    // Liga o Scheduler de verdade -- ponto central deste teste: a partir daqui, McuComponent::
    // onPollEvent() vê isRunning()==true e delega para runBackgroundPollLoop() em vez do laço
    // síncrono que McuComponentTest.cpp exercita.
    session.scheduler().start();
    check(session.scheduler().isRunning(), "Scheduler realmente rodando em background");
#ifdef _WIN32
    check(mcuA->pollDoorbellBoundForTesting() && mcuB->pollDoorbellBoundForTesting(),
          "arenas sinteticas criam handles doorbell reais no Windows");
    const uint64_t wakesBefore = mcuA->pollDoorbellWakeCountForTesting();
    mcuA->ringPollDoorbellForTesting();
    check(waitUntil([&] { return mcuA->pollDoorbellWakeCountForTesting() > wakesBefore; }),
          "doorbell real acorda a thread dedicada sem depender do timeout");
#endif

    // Regressao da race de double-dispatch I2C -- roda logo apos o Scheduler ligar, testando
    // explicitamente a janela de partida (thread de poll dedicada ainda sem garantia de ja ter
    // rodado), o estado estacionario e um cenario de estresse concorrente com escritas de registrador.
    runI2cDuplicateDispatchRegressionTest(*mcuA, arenaA);

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
        mcuA->openSyntheticArenaForTesting(arenaNameA);
    }
    arenaA = mcuA->arenaBridge().arena();
    check(mcuA->arenaBridge().isOpen(), "arena A reaberta depois de 10 ciclos de reload com o Scheduler vivo");
    check(toggleAndWaitForLevel(arenaA, gpioStart, session, indexA, "GPIO2", true),
          "MCU A volta a responder a escritas de registrador depois dos reloads ao vivo");

    // Reconfirma a mesma regressao depois de 10 ciclos de fechar/reabrir a arena com o Scheduler
    // vivo -- prova que a ownership do consumidor I2C (pollThreadRunning) se recompoe corretamente
    // apos a thread de poll antiga sair e uma nova nascer, sem janela de pedido perdido nem
    // duplicado.
    runI2cDuplicateDispatchRegressionTest(*mcuA, arenaA);

    // Parada limpa: stopSimulation() precisa devolver o controle (sem travar) mesmo com as duas
    // threads de poll dedicadas ainda potencialmente ativas.
    session.stopSimulation();
    check(!session.scheduler().isRunning(), "Scheduler parado depois de stopSimulation()");
    check(!mcuA->pollWorkerLaunchFailedForTesting() && mcuA->pollWaitFailureCountForTesting() == 0,
          "ciclo de vida do poll terminou sem falha de lancamento ou HANDLE wait");
    check(mcuA->health() == PluginHealthStatus::Ok && mcuB->health() == PluginHealthStatus::Ok,
          "as duas instâncias continuam saudáveis depois da parada");

    if (failures == 0) {
        std::printf("\nTodos os testes de McuComponentLivePollThread passaram.\n");
        return 0;
    }
    std::fprintf(stderr, "\n%d teste(s) FALHARAM.\n", failures);
    return 1;
}
