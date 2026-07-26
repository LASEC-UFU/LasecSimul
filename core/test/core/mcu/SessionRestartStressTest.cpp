// Achado 2026-07-22 (relato ao vivo, Core recém-iniciado, sem processo antigo envolvido): ciclos
// repetidos de Stop->Run pela UI real mostram comportamento inconsistente -- às vezes o MCU nunca
// inicializa, às vezes roda perfeitamente, às vezes roda por um tempo e trava. Duas suítes já
// existentes cobrem PARTE disso mas nunca as duas coisas JUNTAS:
//   - McuRestartStressTest.cpp: QEMU real reiniciado repetidamente, mas SEM Scheduler/SimulationSession
//     (só McuController, poll manual síncrono).
//   - McuComponentLivePollThreadTest.cpp: Scheduler de verdade + reload repetido, mas com arena
//     SINTÉTICA (sem QEMU real nenhum).
// Este teste combina os dois: QEMU real + SimulationSession::stopSimulation()/scheduler().start()
// de verdade, repetidos muitas vezes -- a combinação mais próxima do que a Extension real faz a
// cada clique em Stop/Run.
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <memory>
#include <string>
#include <thread>
#include <vector>
#include "components/other/Ground.hpp"
#include "components/passive/Resistor.hpp"
#include "mcu/McuComponent.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "plugins/PluginRuntime.hpp"
#include "session/SimulationSession.hpp"

using namespace lasecsimul;
using namespace lasecsimul::session;

namespace {

int failures = 0;

#define TEST_ASSERT(expr, msg) \
    do { \
        if (!(expr)) { \
            std::fprintf(stderr, "  FALHOU: %s -- %s\n", msg, #expr); \
            failures++; \
        } else { \
            std::fprintf(stderr, "  OK: %s\n", msg); \
        } \
    } while (false)

std::string uniqueArenaName(int cycle) {
    return "lasecsimul-session-restart-stress-" +
           std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) +
           "-" + std::to_string(cycle);
}

std::filesystem::path createBlankFlash(int cycle) {
    const std::filesystem::path path =
        std::filesystem::temp_directory_path() / (uniqueArenaName(cycle) + "-flash.bin");
    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    const std::vector<char> erasedBlock(64 * 1024, static_cast<char>(0xFF));
    for (int i = 0; i < 64; ++i) out.write(erasedBlock.data(), erasedBlock.size());
    if (!out) throw std::runtime_error("nao foi possivel criar flash vazia de teste");
    return path;
}

int positiveEnvironmentValue(const char* name, int fallback, int maximum) {
    const char* value = std::getenv(name);
    if (!value || !*value) return fallback;
    char* end = nullptr;
    const long parsed = std::strtol(value, &end, 10);
    if (!end || *end != '\0' || parsed <= 0 || parsed > maximum) return fallback;
    return static_cast<int>(parsed);
}

std::string decodeHex(const std::string& hex) {
    const auto nibble = [](char c) -> int {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
    };
    std::string bytes;
    bytes.reserve(hex.size() / 2);
    for (size_t i = 0; i + 1 < hex.size(); i += 2) {
        const int high = nibble(hex[i]);
        const int low = nibble(hex[i + 1]);
        if (high < 0 || low < 0) break;
        bytes.push_back(static_cast<char>((high << 4) | low));
    }
    return bytes;
}

} // namespace

int main() {
#ifndef ESP32_ADAPTER_DLL_PATH
#error "ESP32_ADAPTER_DLL_PATH precisa ser definido pelo CMakeLists (caminho do adapter.dll real)"
#endif
#ifndef QEMU_REAL_BINARY_PATH
#error "QEMU_REAL_BINARY_PATH precisa ser definido pelo CMakeLists (caminho do qemu-system-xtensa.exe real)"
#endif
    const char* qemuOverride = std::getenv("LASECSIMUL_TEST_QEMU_BINARY");
    const char* firmwareOverride = std::getenv("LASECSIMUL_TEST_FIRMWARE");
    const char* verboseOverride = std::getenv("LASECSIMUL_TEST_VERBOSE");
    const std::filesystem::path dllPath = ESP32_ADAPTER_DLL_PATH;
    const std::filesystem::path qemuPath =
        (qemuOverride && *qemuOverride) ? std::filesystem::u8path(qemuOverride)
                                        : std::filesystem::path(QEMU_REAL_BINARY_PATH);
    const bool useRealFirmware = firmwareOverride && *firmwareOverride;
    const bool verboseLogs = verboseOverride && *verboseOverride &&
                             std::string(verboseOverride) != "0";
    const std::filesystem::path realFirmware =
        useRealFirmware ? std::filesystem::u8path(firmwareOverride) : std::filesystem::path{};
    if (!std::filesystem::exists(dllPath)) {
        std::fprintf(stderr, "PULADO: %s nao existe -- rode 'npm run build:mcu-adapters'.\n", dllPath.string().c_str());
        return 0;
    }
    if (!std::filesystem::exists(qemuPath)) {
        std::fprintf(stderr, "PULADO: %s nao existe.\n", qemuPath.string().c_str());
        return 0;
    }
    if (useRealFirmware && !std::filesystem::exists(realFirmware)) {
        std::fprintf(stderr, "FALHOU: LASECSIMUL_TEST_FIRMWARE nao existe: %s\n",
                     realFirmware.string().c_str());
        return 1;
    }

#ifdef _WIN32
    _putenv_s("LASECSIMUL_NETWORK_MODE", "disabled");
#else
    setenv("LASECSIMUL_NETWORK_MODE", "disabled", 1);
#endif

    plugins::GlobalPluginCache cache;
    std::shared_ptr<plugins::PluginModule> module = cache.loader().loadMcuPlugin(dllPath);
    cache.setActiveMcuModule("espressif.esp32", module);

    SimulationSession session(cache);
    session.registerKnownMcuTypes();

    mcu::McuComponent* mcuPtr = nullptr;
    session.components().registerFactory("mcu.esp32", [&mcuPtr, &session](const registry::ComponentParams&) {
        auto instance = std::make_unique<mcu::McuComponent>(session.mcus().create("espressif.esp32"), session.scheduler());
        mcuPtr = instance.get();
        return instance;
    });
    session.components().registerFactory("passive.resistor", [](const registry::ComponentParams&) {
        return std::make_unique<components::Resistor>(
            std::array<Pin, 2>{Pin{"pin-1"}, Pin{"pin-2"}}, 1000.0);
    });
    session.components().registerFactory("other.ground", [](const registry::ComponentParams&) {
        return std::make_unique<components::Ground>(Pin{"pin"});
    });
    const uint32_t mcuIndex = session.addComponent("mcu.esp32", {});
    TEST_ASSERT(mcuPtr != nullptr, "McuComponent real criado");

    if (useRealFirmware) {
        const uint32_t resistorIndex = session.addComponent("passive.resistor", {});
        const uint32_t groundIndex = session.addComponent("other.ground", {});
        session.connectWire(mcuIndex, "GPIO13", resistorIndex, "pin-1");
        session.connectWire(resistorIndex, "pin-2", groundIndex, "pin");
    }

    const int cycleCount = positiveEnvironmentValue("LASECSIMUL_STRESS_CYCLES", 15, 200);
    const int gdbPort = positiveEnvironmentValue("LASECSIMUL_TEST_GDB_PORT", 0, 65535);
    const auto bootTimeout = std::chrono::milliseconds(
        positiveEnvironmentValue("LASECSIMUL_STRESS_BOOT_MS", 5000, 120000));
    const auto runDuration = std::chrono::milliseconds(
        positiveEnvironmentValue("LASECSIMUL_STRESS_RUN_MS",
                                 useRealFirmware ? 5000 : 600, 120000));
    const auto gpioGrace = std::chrono::milliseconds(
        positiveEnvironmentValue("LASECSIMUL_STRESS_GPIO_GRACE_MS", 3000, 120000));

    int failedToBoot = 0;
    int stalledMidRun = 0;
    int gpioFailures = 0;
    int stopCleanupFailures = 0;

    std::fprintf(stderr, "Restart stress: ciclos=%d run_ms=%lld firmware=%s\n",
                 cycleCount, static_cast<long long>(runDuration.count()),
                 useRealFirmware ? realFirmware.string().c_str() : "flash-vazia");

    for (int cycle = 0; cycle < cycleCount; ++cycle) {
        const std::filesystem::path flashPath =
            useRealFirmware ? realFirmware : createBlankFlash(cycle);
        const std::string arenaName = uniqueArenaName(cycle);
        const auto removeTemporaryFlash = [&] {
            if (!useRealFirmware) std::filesystem::remove(flashPath);
        };

        // Mesma ordem que a Extension real usa: Scheduler primeiro (coreLifecycle.ts::runSimulation
        // chama Core.run(), que religa o Scheduler), depois loadMcuFirmware.
        if (!session.scheduler().isRunning()) session.scheduler().start();

        try {
            McuDebugOptions debug;
            debug.gdbPort = static_cast<uint16_t>(gdbPort);
            debug.startPaused = false;
            session.loadMcuFirmware(mcuIndex, flashPath, arenaName, qemuPath.string(), debug);
        } catch (const std::exception& ex) {
            std::fprintf(stderr, "  ciclo %d: loadMcuFirmware lancou: %s\n", cycle, ex.what());
            ++failedToBoot;
            session.stopSimulation();
            removeTemporaryFlash();
            continue;
        }

        // Espera o primeiro sinal de vida real (arena->running==1) -- só a thread de poll dedicada
        // do McuComponent (Scheduler já está rodando) drena a fila, não fazemos isso manualmente
        // aqui (ao contrário de McuRestartStressTest, que usa McuController puro sem Scheduler).
        const auto bootDeadline = std::chrono::steady_clock::now() + bootTimeout;
        bool booted = false;
        while (std::chrono::steady_clock::now() < bootDeadline) {
            const LsdnQemuArena* arena = mcuPtr->arenaBridge().arena();
            if (arena && arena->running != 0) { booted = true; break; }
            if (!mcuPtr->firmwareRunning()) break; // processo morreu antes de sinalizar vida
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
        if (!booted) {
            std::fprintf(stderr, "  ciclo %d: NAO INICIALIZOU em %lldms (firmwareRunning=%s)\n",
                         cycle, static_cast<long long>(bootTimeout.count()),
                         mcuPtr->firmwareRunning() ? "sim" : "nao");
            std::fprintf(stderr, "  Logs QEMU do ciclo %d:\n%s\n", cycle,
                         mcuPtr->qemuLogs().c_str());
            ++failedToBoot;
            session.stopSimulation();
            removeTemporaryFlash();
            continue;
        }

        // Já inicializou -- confirma que o MCU continua "vivo" (processo real + saudável) por uma
        // janela curta, monitorando o padrão relatado ao vivo ("começava e parava depois de um
        // tempo"). Achado 2026-07-22: stampCountForTesting() (cresce só quando o circuito é marcado
        // dirty, i.e. dispatchArenaEvent() detecta mudança elétrica) é um PROXY RUIM aqui -- a flash
        // vazia usada neste teste não tem app válido, então o QEMU fica preso na ROM de boot sem
        // NUNCA tocar um pino, e dispatchArenaEvent() nunca retorna `changed=true` mesmo com a
        // integração 100% saudável. latestVirtualTimeNs() (atualizado em pollStepLocked() a cada
        // evento da fila realmente processado, heartbeat ou registrador -- ver seu doc-comment no
        // .hpp) é o proxy correto de "o cano QEMU<->Core continua fluindo": não depende do firmware
        // mexer em GPIO nenhum, só de o relógio virtual do QEMU seguir avançando.
        const uint64_t virtualTimeAtStart = mcuPtr->latestVirtualTimeNs();
        bool haveGpioLevel = false;
        bool previousGpioHigh = false;
        bool observedGpioHigh = false;
        bool observedGpioLowAfterHigh = false;
        int gpioTransitions = 0;
        const auto runDeadline = std::chrono::steady_clock::now() + runDuration;
        const auto maximumDeadline = runDeadline + (useRealFirmware ? gpioGrace
                                                                    : std::chrono::milliseconds{0});
        while (std::chrono::steady_clock::now() < maximumDeadline && mcuPtr->firmwareRunning()) {
            if (useRealFirmware) {
                try {
                    const bool high = session.nodeVoltageOfPin(mcuIndex, "GPIO13") > 2.0;
                    if (haveGpioLevel && high != previousGpioHigh) ++gpioTransitions;
                    observedGpioHigh = observedGpioHigh || high;
                    observedGpioLowAfterHigh = observedGpioLowAfterHigh || (observedGpioHigh && !high);
                    previousGpioHigh = high;
                    haveGpioLevel = true;
                } catch (const std::exception&) {
                    // O Scheduler pode estar no meio de um passo; a proxima amostra tenta de novo.
                }
            }
            // A primeira execução de um binário QEMU novo também mede/calibra o -icount. Essa
            // calibração é trabalho de parede, não travamento do firmware: o relógio virtual segue
            // avançando, mas pode ainda não ter alcançado o primeiro blink quando acaba a janela
            // mínima. Só usa a tolerância extra nesse caso; ciclos que já comprovaram HIGH->LOW
            // preservam a duração normal e um GPIO realmente travado ainda falha ao fim da graça.
            if (std::chrono::steady_clock::now() >= runDeadline &&
                (!useRealFirmware ||
                 (observedGpioHigh && observedGpioLowAfterHigh && gpioTransitions >= 2))) {
                break;
            }
            std::this_thread::sleep_for(useRealFirmware ? std::chrono::milliseconds(2)
                                                        : std::chrono::milliseconds(10));
        }
        const bool stillRunning = mcuPtr->firmwareRunning();
        const bool schedulerStillRunning = session.scheduler().isRunning();
        const uint64_t virtualTimeAfter = mcuPtr->latestVirtualTimeNs();

        if (!stillRunning || !schedulerStillRunning || virtualTimeAfter == virtualTimeAtStart) {
            const LsdnQemuArena* stalledArena = mcuPtr->arenaBridge().arena();
            std::fprintf(stderr,
                "  ciclo %d: TRAVOU NO MEIO -- firmwareRunning=%s schedulerRunning=%s"
                " virtualTimeNs %llu->%llu arenaRunning=%llu queue=%llu/%llu"
                " abi=%u peerReady=%s caps=0x%llx\n",
                cycle, stillRunning ? "sim" : "nao", schedulerStillRunning ? "sim" : "nao",
                static_cast<unsigned long long>(virtualTimeAtStart), static_cast<unsigned long long>(virtualTimeAfter),
                static_cast<unsigned long long>(stalledArena ? stalledArena->running : 999),
                static_cast<unsigned long long>(stalledArena ? stalledArena->queueReadIndex : 999),
                static_cast<unsigned long long>(stalledArena ? stalledArena->queueWriteIndex : 999),
                mcuPtr->arenaBridge().protocolMajor(),
                mcuPtr->arenaBridge().peerReady() ? "sim" : "nao",
                static_cast<unsigned long long>(
                    mcuPtr->arenaBridge().negotiatedCapabilities()));
            std::fprintf(stderr, "  Logs QEMU do ciclo %d:\n%s\n", cycle,
                         mcuPtr->qemuLogs().c_str());
            ++stalledMidRun;
        } else {
            std::fprintf(stderr, "  ciclo %d: OK (virtualTimeNs avancou %llu->%llu",
                         cycle, static_cast<unsigned long long>(virtualTimeAtStart),
                         static_cast<unsigned long long>(virtualTimeAfter));
            if (useRealFirmware) {
                std::fprintf(stderr, ", GPIO13 bordas=%d high=%s low-apos-high=%s",
                             gpioTransitions, observedGpioHigh ? "sim" : "nao",
                             observedGpioLowAfterHigh ? "sim" : "nao");
            }
            std::fprintf(stderr, ")\n");
        }

        if (useRealFirmware &&
            (!observedGpioHigh || !observedGpioLowAfterHigh || gpioTransitions < 2)) {
            const LsdnQemuArena* failedArena = mcuPtr->arenaBridge().arena();
            const LsdnQemuQueueEntry* failedHead =
                failedArena && failedArena->queueReadIndex < failedArena->queueWriteIndex
                    ? &failedArena->queue[
                          failedArena->queueReadIndex % LSDN_QEMU_ARENA_QUEUE_DEPTH]
                    : nullptr;
            std::fprintf(stderr,
                "  ciclo %d: GPIO13 TRAVOU -- bordas=%d high=%s low-apos-high=%s"
                " arenaRunning=%llu queue=%llu/%llu schedulerNow=%llu pending=%zu"
                " head={timePs=%llu action=%llu addr=0x%llx}"
                " poll={enabled=%s thread=%s scheduled=%s generation=%llu}"
                " abi=%u peerReady=%s caps=0x%llx\n",
                cycle, gpioTransitions, observedGpioHigh ? "sim" : "nao",
                observedGpioLowAfterHigh ? "sim" : "nao",
                static_cast<unsigned long long>(failedArena ? failedArena->running : 999),
                static_cast<unsigned long long>(failedArena ? failedArena->queueReadIndex : 999),
                static_cast<unsigned long long>(failedArena ? failedArena->queueWriteIndex : 999),
                static_cast<unsigned long long>(session.scheduler().nowNs()),
                session.scheduler().pendingEventCount(),
                static_cast<unsigned long long>(failedHead ? failedHead->simuTime : 0),
                static_cast<unsigned long long>(failedHead ? failedHead->simuAction : 0),
                static_cast<unsigned long long>(failedHead ? failedHead->regAddr : 0),
                mcuPtr->pollingForTesting() ? "sim" : "nao",
                mcuPtr->pollThreadRunningForTesting() ? "sim" : "nao",
                mcuPtr->pollEventScheduledForTesting() ? "sim" : "nao",
                static_cast<unsigned long long>(mcuPtr->pollGenerationForTesting()),
                mcuPtr->arenaBridge().protocolMajor(),
                mcuPtr->arenaBridge().peerReady() ? "sim" : "nao",
                static_cast<unsigned long long>(
                    mcuPtr->arenaBridge().negotiatedCapabilities()));
            std::fprintf(stderr, "  Logs QEMU do ciclo %d:\n%s\n", cycle,
                         mcuPtr->qemuLogs().c_str());
            const auto uartTx = session.propertyValueOf(mcuIndex, "uart0_tx_monitor_hex");
            if (uartTx && std::holds_alternative<std::string>(*uartTx)) {
                std::fprintf(stderr, "  UART0 TX do ciclo %d:\n%s\n", cycle,
                             decodeHex(std::get<std::string>(*uartTx)).c_str());
            }
            ++gpioFailures;
        } else if (verboseLogs) {
            std::fprintf(stderr, "  Logs QEMU do ciclo %d:\n%s\n", cycle,
                         mcuPtr->qemuLogs().c_str());
        }

        session.stopSimulation();
        const bool stopClean = !mcuPtr->firmwareRunning() &&
                               !session.scheduler().isRunning() &&
                               !session.scheduler().isPaused() &&
                               session.scheduler().nowNs() == 0 &&
                               session.scheduler().pendingEventCount() == 0;
        if (!stopClean) {
            std::fprintf(stderr,
                "  ciclo %d: STOP NAO LIMPOU -- firmware=%s scheduler=%s paused=%s nowNs=%llu eventos=%zu\n",
                cycle, mcuPtr->firmwareRunning() ? "rodando" : "parado",
                session.scheduler().isRunning() ? "rodando" : "parado",
                session.scheduler().isPaused() ? "sim" : "nao",
                static_cast<unsigned long long>(session.scheduler().nowNs()),
                session.scheduler().pendingEventCount());
            ++stopCleanupFailures;
        }
        removeTemporaryFlash();
    }

    TEST_ASSERT(failedToBoot == 0, "nenhum ciclo deveria falhar em INICIALIZAR (arena->running nunca chegando a 1)");
    TEST_ASSERT(stalledMidRun == 0, "nenhum ciclo deveria travar NO MEIO (Scheduler+MCU reais)");
    TEST_ASSERT(gpioFailures == 0, "GPIO13 deveria piscar em todos os ciclos com firmware real");
    TEST_ASSERT(stopCleanupFailures == 0, "Stop deveria limpar MCU, Scheduler, pausa, relogio e eventos");

    std::fprintf(stderr,
                 "\nResumo: %d/%d falharam ao iniciar, %d/%d travaram, %d/%d falharam no GPIO13, "
                 "%d/%d deixaram estado apos Stop.\n",
                 failedToBoot, cycleCount, stalledMidRun, cycleCount, gpioFailures, cycleCount,
                 stopCleanupFailures, cycleCount);

    if (failures == 0) {
        std::printf("\nTodos os %d ciclos (Scheduler+QEMU reais) passaram sem falha.\n", cycleCount);
        return 0;
    }
    std::fprintf(stderr, "\n%d teste(s) FALHARAM.\n", failures);
    return 1;
}
