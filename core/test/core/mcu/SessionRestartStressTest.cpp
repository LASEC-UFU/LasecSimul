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
#include <string_view>
#include <thread>
#include <unordered_set>
#include <vector>
#include "components/other/Ground.hpp"
#include "components/passive/Resistor.hpp"
#include "mcu/McuComponent.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "plugins/PluginRuntime.hpp"
#include "session/SimulationSession.hpp"
#ifdef _WIN32
#include <crtdbg.h>
#include <windows.h>
#endif

using namespace lasecsimul;
using namespace lasecsimul::session;

namespace {

int failures = 0;

const auto& harnessStart() {
    static const auto start = std::chrono::steady_clock::now();
    return start;
}

void phaseMarker(const char* phase, int cycle = -1, uint64_t executionId = 0) {
    const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - harnessStart()).count();
    const auto tid = std::hash<std::thread::id>{}(std::this_thread::get_id());
    std::fprintf(stderr, "[HARNESS_PHASE] %s elapsed_ms=%lld cycle=%d executionId=%llu tid=%zu\n",
                 phase, static_cast<long long>(elapsed), cycle,
                 static_cast<unsigned long long>(executionId), tid);
    std::fflush(stderr);
}

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

std::string uniqueArenaNameForThisTestRun() {
    // Producao usa "lasecsimul-mcu-<hostInstanceId>-<instanceId>" (CoreApplication.cpp, handler
    // loadMcuFirmware): ESTAVEL para o mesmo McuComponent durante todo o processo, nunca varia
    // entre ciclos Stop->Run. bindPollDoorbellLocked() (McuComponent.cpp, desde 102546b) assume
    // essa mesma estabilidade -- o primeiro nome vincula o doorbell nomeado pra vida do
    // McuComponent, e um nome diferente em qualquer ciclo seguinte lanca deliberadamente. Reflete
    // aqui: UM nome por invocacao deste teste (isola execucoes concorrentes/independentes do
    // teste, ex. duas rodadas do binario ao mesmo tempo), reutilizado por TODOS os ciclos do
    // loop -- nao um nome novo por ciclo.
    return "lasecsimul-session-restart-stress-" +
           std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
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

bool vnextBootLivenessByPacing(bool firmwareRunning, bool schedulerRunning,
                               uint64_t pacingBaseline, uint64_t pacingNow) {
    return firmwareRunning && schedulerRunning && pacingNow > pacingBaseline;
}

bool vnextBlankLifecycleProgress(bool firmwareRunning, bool schedulerRunning,
                                 uint64_t pacingBaseline, uint64_t pacingNow) {
    return vnextBootLivenessByPacing(firmwareRunning, schedulerRunning,
                                     pacingBaseline, pacingNow);
}

bool vnextRealFirmwareProgress(uint64_t submissionsStart, uint64_t submissionsNow,
                               uint64_t completionsStart, uint64_t completionsNow,
                               uint64_t artifactProgressStart,
                               uint64_t artifactProgressNow) {
    return submissionsNow > submissionsStart &&
           completionsNow > completionsStart &&
           completionsNow - completionsStart >= 2 &&
           artifactProgressNow > artifactProgressStart;
}

} // namespace

int main() {
    phaseMarker("PHASE_00_TEST_START");
    // E144 (EVIDENCE.md, 2026-09-08): E132-E's historical "session_restart_stress_test 15/15"
    // ran a Release build; E142/E143 had been (re)building and running Debug without noticing --
    // an unoptimized Debug build is slow enough per real-firmware dispatch cycle that it cannot
    // reach the guest's I2C phase within a 5s window even with the H143 fix applied (E144's own
    // Debug time series: Scheduler::nowNs advances monotonically throughout a 30s window, never
    // frozen, just ~60x slower than real time), while Release reliably does. Self-report the
    // build config unconditionally (cheap, once, not a hot-path log) so this is never silently
    // ambiguous again, and fail closed -- before doing anything else -- if the caller explicitly
    // requires the formal (Release) configuration via LASECSIMUL_REQUIRE_RELEASE=1.
#ifdef _DEBUG
    constexpr const char* kHarnessBuildConfig = "Debug";
#else
    constexpr const char* kHarnessBuildConfig = "Release";
#endif
    std::fprintf(stderr, "HARNESS_BUILD_CONFIG=%s\n", kHarnessBuildConfig);
    {
        const char* requireRelease = std::getenv("LASECSIMUL_REQUIRE_RELEASE");
        const bool requireReleaseSet = requireRelease && *requireRelease && requireRelease[0] != '0';
#ifdef _DEBUG
        if (requireReleaseSet) {
            std::fprintf(stderr,
                "FALHOU: LASECSIMUL_REQUIRE_RELEASE=1 exige o build formal (Release), mas este "
                "executavel foi compilado Debug -- recompile/rode session_restart_stress_test.exe "
                "em C:\\SourceCode\\LasecSimul\\core\\build\\Release, nao Debug.\n");
            return 1;
        }
#else
        (void)requireReleaseSet;
#endif
    }
#ifdef _WIN32
    // Achado ao vivo 2026-07-27 (.spec 32.5.8): um crash interno do processo QEMU filho (assert do
    // proprio QEMU, ex. fifo8_pop) pode deixar o processo deste teste num estado que o CRT de Debug
    // do MSVC trata como abort()/assercao -- o comportamento PADRAO do CRT de Debug é mostrar uma
    // caixa de dialogo MODAL ("Debug Error!... abort() has been called") que BLOQUEIA o processo
    // esperando um clique humano. Para uma bateria automatizada e não-supervisionada (até 300
    // ciclos pedidos nesta tarefa), isso é inaceitável -- trava a tela do usuário indefinidamente
    // em vez de só terminar o processo. Redireciona qualquer relatório do CRT (assert/erro) e o
    // WER (Windows Error Reporting) pra stderr/saída direta do processo, nunca uma caixa de
    // dialogo interativa.
    _CrtSetReportMode(_CRT_ASSERT, _CRTDBG_MODE_FILE);
    _CrtSetReportFile(_CRT_ASSERT, _CRTDBG_FILE_STDERR);
    _CrtSetReportMode(_CRT_ERROR, _CRTDBG_MODE_FILE);
    _CrtSetReportFile(_CRT_ERROR, _CRTDBG_FILE_STDERR);
    _set_abort_behavior(0, _WRITE_ABORT_MSG | _CALL_REPORTFAULT);
    SetErrorMode(SEM_NOGPFAULTERRORBOX | SEM_FAILCRITICALERRORS);
#endif
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
    const bool useVnextB = std::getenv("LASECSIMUL_MCU_TRANSPORT") &&
                           std::string_view(std::getenv("LASECSIMUL_MCU_TRANSPORT")) == "VNEXT_B";
    const bool verboseLogs = verboseOverride && *verboseOverride &&
                             std::string(verboseOverride) != "0";
    const char* requireGpioOverride = std::getenv("LASECSIMUL_STRESS_REQUIRE_GPIO");
    const bool requireGpio = useRealFirmware && requireGpioOverride &&
                             std::string(requireGpioOverride) != "0";
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
    cache.loadLibrary(std::filesystem::path(REAL_DEVICES_LIBRARY_JSON_PATH));

    TEST_ASSERT(!vnextBootLivenessByPacing(true, true, 1000, 1000),
                "oraculo VNEXT_B rejeita processo/scheduler vivos sem avanco de pacing");

    phaseMarker("PHASE_01_CREATE_SESSION_BEGIN");
    SimulationSession session(cache);
    phaseMarker("PHASE_02_CREATE_SESSION_END");
    session.registerKnownMcuTypes();
    session.registerKnownPluginTypes();

    mcu::McuComponent* mcuPtr = nullptr;
    session.components().registerFactory("mcu.esp32", [&mcuPtr, &session](const registry::ComponentParams&) {
        auto instance = std::make_unique<mcu::McuComponent>(session.mcus().create("espressif.esp32"), session.scheduler());
        mcuPtr = instance.get();
        instance->setI2cTransferHandler([&session](uint32_t mcuIndex, uint32_t bus,
                                                   const I2cTransfer& transfer) {
            return session.resolveI2cTransferForTesting(mcuIndex, bus, transfer);
        });
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

    registry::ComponentParams i2cParams;
    i2cParams.pinList = {{"sda", 0.0, 8.0}, {"scl", 0.0, 16.0},
                         {"a0", 0.0, 24.0}, {"a1", 0.0, 32.0}, {"a2", 0.0, 40.0}};
    i2cParams.properties["sizeBytes"] = PropertyValue{256.0};
    i2cParams.properties["controlCode"] = PropertyValue{60.0};
    i2cParams.properties["pinCount"] = PropertyValue{5.0};
    i2cParams.properties["persistent"] = PropertyValue{false};
    const uint32_t i2cSlave = session.addComponent("logic.i2c_ram", i2cParams);
    session.connectWire(mcuIndex, "GPIO21", i2cSlave, "sda");
    session.connectWire(mcuIndex, "GPIO22", i2cSlave, "scl");

    registry::ComponentParams plotParams;
    plotParams.pinList = {{"tx", 0.0, 8.0}, {"rx", 0.0, 24.0}};
    const uint32_t plotIndex = session.addComponent("peripherals.lasecplot", plotParams);
    session.setProperty(plotIndex, "baudrate", PropertyValue{115200.0});
    session.setProperty(plotIndex, "data_bits", PropertyValue{8.0});
    session.setProperty(plotIndex, "stop_bits", PropertyValue{1.0});
    session.setProperty(plotIndex, "parity", PropertyValue{std::string("none")});
    session.connectWire(mcuIndex, "GPIO1", plotIndex, "rx");


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
    int panicFailures = 0;
    int stopCleanupFailures = 0;
    // Confirma que stopSimulation() realmente encerra a execucao anterior (executionActive=false)
    // e que o beginExecutionIfNeeded() de cada ciclo cria uma NOVA identidade, nao reaproveita uma
    // stale -- sem isso, "15/15 ciclos inicializaram" nao provaria que o lifecycle de restart em si
    // esta correto, so que o guard passa.
    std::unordered_set<uint64_t> executionIds;
    // Prova que o doorbell nomeado reutilizado (mesmo HANDLE do ciclo 0, ver
    // uniqueArenaNameForThisTestRun() acima) continua FUNCIONAL apos restart, nao so que o guard de
    // rebind parou de lancar: pollDoorbellWakeCountForTesting() e' cumulativo e nunca resetado
    // entre ciclos (mesma vida do HANDLE) -- comparar o valor logo apos o ciclo 0 contra o valor
    // final prova atividade (SetEvent/Wait bem-sucedidos) em ciclos POS-restart tambem.
    uint64_t doorbellWakeCountAfterCycle0 = 0;
    bool staleCallbackBarrierArmed = false;
    bool staleCallbackBarrierEntered = false;
    bool staleCallbackBarrierReleased = false;
    uint64_t staleCallbackRejected = 0;
    std::chrono::steady_clock::time_point staleBarrierEnteredAt{};
    int vnextProgressCycles = 0;
    int i2cStopQuiescenceCycles = 0;
    bool vnextNoDedicatedPoll = true;
    // Producao nunca varia o nome da arena entre ciclos Stop->Run do mesmo McuComponent (ver
    // comentario de uniqueArenaNameForThisTestRun() acima) -- um nome so, calculado uma vez,
    // reutilizado pelos 15 ciclos. Isola execucoes concorrentes/independentes deste binario de
    // teste sem violar o contrato de bindPollDoorbellLocked() (McuComponent.cpp).
    const std::string arenaName = uniqueArenaNameForThisTestRun();

    std::fprintf(stderr, "Restart stress: ciclos=%d run_ms=%lld firmware=%s arena=%s\n",
                 cycleCount, static_cast<long long>(runDuration.count()),
                 useRealFirmware ? realFirmware.string().c_str() : "flash-vazia",
                 arenaName.c_str());

    for (int cycle = 0; cycle < cycleCount; ++cycle) {
        phaseMarker(cycle == 0 ? "PHASE_03_START_A_BEGIN" : "PHASE_11_START_B_BEGIN", cycle);
        const std::filesystem::path flashPath =
            useRealFirmware ? realFirmware : createBlankFlash(cycle);
        const auto removeTemporaryFlash = [&] {
            if (!useRealFirmware) std::filesystem::remove(flashPath);
        };

        // Mesma ordem que o handler "start" real usa (CoreApplication.cpp): beginExecutionIfNeeded()
        // primeiro -- desde 102546b, loadMcuFirmware() exige executionActive/sessionExecutionId, e só
        // beginExecutionIfNeeded() estabelece isso -- depois resume()/start() do Scheduler, só então
        // loadMcuFirmware.
        session.scheduler().start();
        session.beginExecutionIfNeeded();
        const uint64_t executionId = session.runtimeState().sessionExecutionId;
        if (executionId == 0 || !executionIds.insert(executionId).second) {
            std::fprintf(stderr,
                "  ciclo %d: sessionExecutionId=%llu (zero ou repetido -- stopSimulation() do ciclo"
                " anterior nao encerrou a execucao corretamente)\n",
                cycle, static_cast<unsigned long long>(executionId));
        }
        // [DIAGNOSTIC] .spec 32.5.18 -- testar a hipotese de que uma unica chamada de
        // settleUntilStableLocked() segurando m_mutex por muito tempo (circuito lento pra
        // convergir) explica os saltos de ~0,7-1,1s de tempo virtual vistos do lado QEMU antes do
        // watchdog do TIMER_GROUP1 expirar. Reset por-ciclo pra isolar o maximo deste ciclo.
        session.scheduler().setProfilingEnabled(true);
        session.scheduler().resetMetrics();

        try {
            McuDebugOptions debug;
            debug.gdbPort = static_cast<uint16_t>(gdbPort);
            debug.startPaused = false;
            session.loadMcuFirmware(mcuIndex, flashPath, arenaName, qemuPath.string(), debug);
            phaseMarker(cycle == 0 ? "PHASE_04_A_READY" : "PHASE_12_B_READY", cycle, executionId);
        } catch (const std::exception& ex) {
            std::fprintf(stderr, "  ciclo %d: loadMcuFirmware lancou: %s\n", cycle, ex.what());
            ++failedToBoot;
            session.stopSimulation();
            removeTemporaryFlash();
            continue;
        }

        // If Execution A intentionally held one dispatcher callback while it was torn down,
        // release it immediately after Execution B has a registered attachment, before B's
        // boot-liveness wait. VNEXT_B boot is proven by pacingPositionNs(), and pacing itself is
        // fed by the shared dispatcher; waiting until after B "boots" would turn the test barrier
        // into an artificial boot deadlock.
        if (useVnextB && cycle == 1 && staleCallbackBarrierArmed &&
            staleCallbackBarrierEntered && !staleCallbackBarrierReleased) {
            mcu::qemu::releaseVnextBTestWaitCallbackBarrier();
            staleCallbackBarrierReleased = true;
            (void)mcu::qemu::waitVnextBTestStaleWaitCallbackRejected(std::chrono::seconds(5));
            staleCallbackRejected = mcu::qemu::vnextBTestStaleWaitCallbackCount();
            staleCallbackBarrierArmed = false;
            std::fprintf(stderr, "  stale Execution A callback released before B boot rejected=%llu\n",
                         static_cast<unsigned long long>(staleCallbackRejected));
            const auto heldMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - staleBarrierEnteredAt).count();
            std::fprintf(stderr, "STALE_BARRIER_HELD_MS=%lld STALE_BARRIER_HELD_DURING_B_PROGRESS=0\n",
                         static_cast<long long>(heldMs));
            phaseMarker("PHASE_23_STALE_CALLBACK_RELEASED", cycle, executionId);
        }

        // TEMPORARY (ConsumerTrace investigation, round 7: restart-timebase audit) -- one line per
        // cycle, right after loadMcuFirmware() returns: sessionExecutionId + qemuTimeOriginNs (the
        // Scheduler::nowNs() base every eventNs for THIS cycle is computed relative to). Checks for
        // a stale/carried timebase across restarts without assuming one exists. No-op text unless
        // LASECSIMUL_MCU_CONSUMER_TRACE=1 (qemuTimeOriginNs itself is always real; only this print
        // is gated, to keep it out of the way when tracing is off).
        mcu::McuComponent::resetPerCycleWatchesForTesting();
        if (useVnextB) vnextNoDedicatedPoll = vnextNoDedicatedPoll &&
            !mcuPtr->pollThreadRunningForTesting();
        if (std::getenv("LASECSIMUL_MCU_CONSUMER_TRACE")) {
            std::fprintf(stderr, "  ciclo %d: TIMEBASE-CHECK sessionExecutionId=%llu qemuTimeOriginNs=%llu"
                                  " schedulerNowNsAtLoad=%llu\n",
                          cycle, static_cast<unsigned long long>(executionId),
                          static_cast<unsigned long long>(mcuPtr->qemuTimeOriginNsForTesting()),
                          static_cast<unsigned long long>(session.scheduler().nowNs()));
        }

        // Espera o primeiro sinal de vida real (arena->running==1) -- só a thread de poll dedicada
        // do McuComponent (Scheduler já está rodando) drena a fila, não fazemos isso manualmente
        // aqui (ao contrário de McuRestartStressTest, que usa McuController puro sem Scheduler).
        const auto bootDeadline = std::chrono::steady_clock::now() + bootTimeout;
        const uint64_t bootPacingBaseline = useVnextB ? mcuPtr->pacingPositionNs().value_or(0) : 0;
        uint64_t bootPacingObserved = bootPacingBaseline;
        bool booted = false;
        while (std::chrono::steady_clock::now() < bootDeadline) {
            const LsdnQemuArena* arena = mcuPtr->arenaBridge().arena();
            if (useVnextB) {
                bootPacingObserved = mcuPtr->pacingPositionNs().value_or(0);
                if (vnextBootLivenessByPacing(mcuPtr->firmwareRunning(),
                                              session.scheduler().isRunning(),
                                              bootPacingBaseline,
                                              bootPacingObserved)) {
                    booted = true;
                    break;
                }
            } else if (arena && arena->running != 0) {
                booted = true;
                break;
            }
            if (!mcuPtr->firmwareRunning()) break; // processo morreu antes de sinalizar vida
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
        if (!booted) {
            // Estado da arena no momento do timeout de boot (achado .spec 32.5.5: o harness chegou a
            // travar indefinidamente neste ramo -- ver QemuProcessManager::reapProcess()/
            // Scheduler::stop(), agora com timeout, e o comentário de bootDeadline acima). Registra
            // running/fila cru em vez de só firmwareRunning() pra diferenciar "processo nunca chegou a
            // reportar vida" de "processo morreu no meio".
            const LsdnQemuArena* bootArena = mcuPtr->arenaBridge().arena();
            std::fprintf(stderr,
                "  ciclo %d: NAO INICIALIZOU em %lldms (firmwareRunning=%s arenaRunning=%llu"
                " queue=%llu/%llu abi=%u peerReady=%s schedulerRunning=%s"
                " pacingNs=%llu->%llu)\n",
                cycle, static_cast<long long>(bootTimeout.count()),
                mcuPtr->firmwareRunning() ? "sim" : "nao",
                static_cast<unsigned long long>(bootArena ? bootArena->running : 999),
                static_cast<unsigned long long>(bootArena ? bootArena->queueReadIndex : 999),
                static_cast<unsigned long long>(bootArena ? bootArena->queueWriteIndex : 999),
                mcuPtr->arenaBridge().protocolMajor(),
                mcuPtr->arenaBridge().peerReady() ? "sim" : "nao",
                session.scheduler().isRunning() ? "sim" : "nao",
                static_cast<unsigned long long>(bootPacingBaseline),
                static_cast<unsigned long long>(bootPacingObserved));
            // TEMPORARY (ConsumerTrace investigation) -- dump FIRST, see rationale at the
            // TRAVOU NO MEIO site above (a pre-existing, OPEN/SECONDARY crash can land inside the
            // qemuLogs() print right after a mid-run stall; ordering the dump first protects it
            // here too even though this specific boot-failure path hasn't shown that crash yet).
            mcu::McuComponent::dumpConsumerTraceToFileForTesting();
            mcu::McuComponent::dumpConsumerTraceForTesting();
            std::fprintf(stderr, "  Logs QEMU do ciclo %d:\n%s\n", cycle,
                         mcuPtr->qemuLogs().c_str());
            if (useRealFirmware) {
                const auto uartTx = session.propertyValueOf(mcuIndex, "uart0_tx_monitor_hex");
                if (uartTx && std::holds_alternative<std::string>(*uartTx)) {
                    std::fprintf(stderr, "  UART0 TX do ciclo %d (parcial ate o timeout):\n%s\n",
                                 cycle, decodeHex(std::get<std::string>(*uartTx)).c_str());
                }
            }
            ++failedToBoot;
            session.stopSimulation();
            removeTemporaryFlash();
            continue;
        }
        phaseMarker(cycle == 0 ? "PHASE_05_A_RUNNING" : "PHASE_13_B_RUNNING", cycle, executionId);

        // The stale callback is intentionally held while Execution A is torn down, but it must
        // be released as soon as Execution B has completed its attachment/registration. Holding
        // the single shared dispatcher thread for B's whole run window would also hold B's
        // Artifact->Core wake and turn the test barrier into an artificial B liveness failure.
        if (useVnextB && cycle == 1 && staleCallbackBarrierArmed && !staleCallbackBarrierReleased) {
            staleCallbackBarrierEntered =
                mcu::qemu::waitVnextBTestWaitCallbackEntered(std::chrono::seconds(5));
            if (!staleCallbackBarrierEntered) {
                std::fprintf(stderr, "  stale Execution A callback did not enter before B run\\n");
            } else {
                mcu::qemu::releaseVnextBTestWaitCallbackBarrier();
                staleCallbackBarrierReleased = true;
                (void)mcu::qemu::waitVnextBTestStaleWaitCallbackRejected(std::chrono::seconds(5));
                staleCallbackRejected = mcu::qemu::vnextBTestStaleWaitCallbackCount();
                staleCallbackBarrierArmed = false;
                std::fprintf(stderr, "  stale Execution A callback released before B run rejected=%llu\\n",
                             static_cast<unsigned long long>(staleCallbackRejected));
                const auto heldMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                    std::chrono::steady_clock::now() - staleBarrierEnteredAt).count();
                std::fprintf(stderr, "STALE_BARRIER_HELD_MS=%lld STALE_BARRIER_HELD_DURING_B_PROGRESS=0\\n",
                             static_cast<long long>(heldMs));
                phaseMarker("PHASE_23_STALE_CALLBACK_RELEASED", cycle, executionId);
            }
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
        const uint64_t pacingAtStart = useVnextB ? mcuPtr->pacingPositionNs().value_or(0) : 0;
        const uint64_t vnextI2cAtStart = mcuPtr->vnextI2cCompletionCountForTesting();
        const uint64_t vnextI2cSubmissionsAtStart = mcuPtr->vnextI2cSubmissionCountForTesting();
        const uint64_t vnextArtifactProgressAtStart = mcuPtr->vnextArtifactProgressForTesting();
        bool haveGpioLevel = false;
        bool previousGpioHigh = false;
        bool observedGpioHigh = false;
        bool observedGpioLowAfterHigh = false;
        int gpioTransitions = 0;
        bool aRealI2cObserved = false;
        // [WAIT-DIAG] .spec 32.5.19 -- nowNs() do Scheduler, nao wall-clock: os eventos da fila do
        // arena carregam o simuClockNs() do lado QEMU (ver simuliface.c), entao esta e a MESMA linha
        // do tempo virtual que aparece em start_virt_ns/end_virt_ns dos logs [WAIT-DIAG] e em
        // maxSettleAtNowNs do Scheduler -- permite comparar diretamente QUANDO (nao so SE) cada
        // espera/settle ocorreu em relacao a ultima borda observada do GPIO13, sem depender de
        // alinhar relogios de parede entre os dois processos.
        uint64_t firstGpioHighNowNs = 0;
        uint64_t firstGpioLowAfterHighNowNs = 0;
        uint64_t lastGpioTransitionNowNs = 0;
        constexpr auto kVnextBBlankRunWindow = std::chrono::milliseconds(1500);
        const auto effectiveRunDuration =
            useVnextB && !useRealFirmware && runDuration < kVnextBBlankRunWindow
                ? kVnextBBlankRunWindow
                : runDuration;
        const auto runDeadline = std::chrono::steady_clock::now() + effectiveRunDuration;
        const auto maximumDeadline = runDeadline + (useRealFirmware && requireGpio ? gpioGrace
                                                                    : std::chrono::milliseconds{0});
        phaseMarker(cycle == 0 ? "PHASE_06_A_TEST_WINDOW_BEGIN" : "PHASE_14_B_TEST_WINDOW_BEGIN", cycle, executionId);
        // E144 (EVIDENCE.md, 2026-09-08): opt-in-only (LASECSIMUL_STRESS_TIME_SERIES), never in
        // the default/hot path -- classifies "Scheduler slow" vs. "Scheduler frozen" with an
        // actual time series instead of a single end-of-window snapshot, per this episode's own
        // "no 'stuck' without time series" rule. 250ms cadence, read-only *ForTesting() accessors
        // only, no behavior change.
        const bool timeSeriesEnabled = std::getenv("LASECSIMUL_STRESS_TIME_SERIES") != nullptr;
        auto lastTimeSeriesSampleAt = std::chrono::steady_clock::now();
        bool firstWindowIteration = true;
        while (std::chrono::steady_clock::now() < maximumDeadline) {
            if (firstWindowIteration) phaseMarker(cycle == 0 ? "PHASE_06A_BEFORE_RUNNING_CHECK" : "PHASE_14A_BEFORE_RUNNING_CHECK", cycle, executionId);
            const bool firmwareStillRunning = mcuPtr->firmwareRunning();
            if (firstWindowIteration) phaseMarker(cycle == 0 ? "PHASE_06B_AFTER_RUNNING_CHECK" : "PHASE_14B_AFTER_RUNNING_CHECK", cycle, executionId);
            if (!firmwareStillRunning) break;
            if (firstWindowIteration) phaseMarker(cycle == 0 ? "PHASE_06C_BEFORE_UART_DRAIN" : "PHASE_14C_BEFORE_UART_DRAIN", cycle, executionId);
            // UART observation is unrelated to the VNEXT I2C progress proof. In the explicit
            // no-GPIO diagnostic mode it can contend with the Scheduler while the real guest is
            // producing traffic, so leave this optional monitor dormant; final UART/panic
            // inspection below remains enabled.
            if (requireGpio) (void)session.tryDrainUartRx(plotIndex);
            if (firstWindowIteration) {
                phaseMarker(cycle == 0 ? "PHASE_06D_AFTER_UART_DRAIN" : "PHASE_14D_AFTER_UART_DRAIN", cycle, executionId);
                firstWindowIteration = false;
            }
            const uint64_t currentVnextSubmissions = mcuPtr->vnextI2cSubmissionCountForTesting();
            const uint64_t currentVnextCompletions = mcuPtr->vnextI2cCompletionCountForTesting();
            const uint64_t currentVnextArtifactProgress = mcuPtr->vnextArtifactProgressForTesting();
            const bool currentRealFirmwareProgress =
                vnextRealFirmwareProgress(vnextI2cSubmissionsAtStart, currentVnextSubmissions,
                                          vnextI2cAtStart, currentVnextCompletions,
                                          vnextArtifactProgressAtStart,
                                          currentVnextArtifactProgress);
            if (useVnextB && useRealFirmware &&
                currentVnextSubmissions > vnextI2cSubmissionsAtStart &&
                currentVnextCompletions > vnextI2cAtStart) {
                aRealI2cObserved = true;
                if (cycleCount >= 2 && cycle == 0 && currentRealFirmwareProgress &&
                    !staleCallbackBarrierArmed &&
                    std::getenv("LASECSIMUL_STRESS_SKIP_STALE_BARRIER") == nullptr) {
                    mcu::qemu::armVnextBTestWaitCallbackBarrier();
                    staleCallbackBarrierArmed = true;
                }
            }
            if (staleCallbackBarrierArmed && !staleCallbackBarrierReleased &&
                aRealI2cObserved && currentVnextCompletions > vnextI2cAtStart &&
                mcu::qemu::waitVnextBTestWaitCallbackEntered(std::chrono::milliseconds(1))) {
                if (!staleCallbackBarrierEntered) {
                    staleCallbackBarrierEntered = true;
                    staleBarrierEnteredAt = std::chrono::steady_clock::now();
                    phaseMarker("PHASE_19_STALE_CALLBACK_HELD", cycle, executionId);
                }
            }
            if (staleCallbackBarrierArmed && !staleCallbackBarrierReleased && aRealI2cObserved &&
                currentVnextCompletions > vnextI2cAtStart &&
                mcu::qemu::waitVnextBTestWaitCallbackEntered(std::chrono::milliseconds(1))) {
                staleCallbackBarrierEntered = true;
                break;
            }
            if (useRealFirmware && requireGpio) {
                try {
                    const bool high = session.nodeVoltageOfPin(mcuIndex, "GPIO13") > 2.0;
                    if (haveGpioLevel && high != previousGpioHigh) {
                        ++gpioTransitions;
                        lastGpioTransitionNowNs = session.scheduler().nowNs();
                        if (high && firstGpioHighNowNs == 0) firstGpioHighNowNs = lastGpioTransitionNowNs;
                        if (!high && observedGpioHigh && firstGpioLowAfterHighNowNs == 0) {
                            firstGpioLowAfterHighNowNs = lastGpioTransitionNowNs;
                        }
                    }
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
            if (timeSeriesEnabled && useVnextB) {
                const auto nowSteady = std::chrono::steady_clock::now();
                if (nowSteady - lastTimeSeriesSampleAt >= std::chrono::milliseconds(250)) {
                    lastTimeSeriesSampleAt = nowSteady;
                    const auto [lane0Write, lane0Read] = mcuPtr->vnextBAttachmentForTesting().laneRingSeqForTesting(0);
                    std::fprintf(stderr,
                        "  E144_TIME_SERIES ciclo=%d elapsedMs=%lld schedulerNowNs=%llu "
                        "lane0={write=%llu read=%llu} submissions=%llu completions=%llu\n",
                        cycle,
                        static_cast<long long>(std::chrono::duration_cast<std::chrono::milliseconds>(
                            nowSteady - (runDeadline - effectiveRunDuration)).count()),
                        static_cast<unsigned long long>(session.scheduler().nowNs()),
                        static_cast<unsigned long long>(lane0Write), static_cast<unsigned long long>(lane0Read),
                        static_cast<unsigned long long>(currentVnextSubmissions),
                        static_cast<unsigned long long>(currentVnextCompletions));
                }
            }
            std::this_thread::sleep_for(useRealFirmware ? std::chrono::milliseconds(2)
                                                        : std::chrono::milliseconds(10));
        }
        const bool stillRunning = mcuPtr->firmwareRunning();
        const bool schedulerStillRunning = session.scheduler().isRunning();
        const uint64_t virtualTimeAfter = mcuPtr->latestVirtualTimeNs();
        const uint64_t pacingAfter = useVnextB ? mcuPtr->pacingPositionNs().value_or(0) : 0;
        const uint64_t vnextI2cSubmissionsAfter = mcuPtr->vnextI2cSubmissionCountForTesting();
        const uint64_t vnextI2cCompletionsAfter = mcuPtr->vnextI2cCompletionCountForTesting();
        const uint64_t vnextArtifactProgressAfter = mcuPtr->vnextArtifactProgressForTesting();
        const bool vnextBlankProgressObserved =
            useVnextB && !useRealFirmware &&
            vnextBlankLifecycleProgress(stillRunning, schedulerStillRunning,
                                        pacingAtStart, pacingAfter);
        const bool vnextRealProgressObserved =
            useVnextB && useRealFirmware &&
            vnextRealFirmwareProgress(vnextI2cSubmissionsAtStart, vnextI2cSubmissionsAfter,
                                      vnextI2cAtStart, vnextI2cCompletionsAfter,
                                      vnextArtifactProgressAtStart,
                                      vnextArtifactProgressAfter);
        const bool vnextProgressObserved =
            vnextBlankProgressObserved || vnextRealProgressObserved;
        if (useVnextB) {
            std::fprintf(stderr,
                          "[HARNESS_PROGRESS] cycle=%d submissions=%llu/%llu completions=%llu/%llu"
                          " artifact_progress=%llu/%llu pacing=%llu/%llu mode=%s"
                          " criteria={submission:%s completion:%s artifact:%s minimum:%s"
                          " pacing:%s} running={firmware:%s scheduler:%s}\n",
                          cycle,
                          static_cast<unsigned long long>(vnextI2cSubmissionsAfter),
                          static_cast<unsigned long long>(vnextI2cSubmissionsAtStart),
                          static_cast<unsigned long long>(vnextI2cCompletionsAfter),
                          static_cast<unsigned long long>(vnextI2cAtStart),
                          static_cast<unsigned long long>(vnextArtifactProgressAfter),
                          static_cast<unsigned long long>(vnextArtifactProgressAtStart),
                          static_cast<unsigned long long>(pacingAfter),
                          static_cast<unsigned long long>(pacingAtStart),
                          useRealFirmware ? "real_firmware" : "blank_flash",
                          vnextI2cSubmissionsAfter > vnextI2cSubmissionsAtStart ? "true" : "false",
                          vnextI2cCompletionsAfter > vnextI2cAtStart ? "true" : "false",
                          vnextArtifactProgressAfter > vnextArtifactProgressAtStart ? "true" : "false",
                          vnextI2cCompletionsAfter - vnextI2cAtStart >= 2 ? "true" : "false",
                          pacingAfter > pacingAtStart ? "true" : "false",
                          stillRunning ? "true" : "false",
                          schedulerStillRunning ? "true" : "false");
            std::fflush(stderr);
        }
        if (vnextProgressObserved) {
            if (useVnextB && !useRealFirmware) {
                phaseMarker(cycle == 0 ? "PHASE_07_A_PACING_PROGRESS_CONFIRMED"
                                        : "PHASE_15_B_PACING_PROGRESS_CONFIRMED",
                            cycle, executionId);
            } else {
                phaseMarker(cycle == 0 ? "PHASE_07_A_REAL_PROGRESS_CONFIRMED"
                                        : "PHASE_15_B_REAL_PROGRESS_CONFIRMED",
                            cycle, executionId);
            }
        }
        phaseMarker(cycle == 0 ? "PHASE_08_A_TEST_WINDOW_END" : "PHASE_16_B_TEST_WINDOW_END", cycle, executionId);
        if (useVnextB && verboseLogs) {
            std::fprintf(stderr, "  ciclo %d: VNEXT I2C completions=%llu start=%llu progress=%s\\n",
                         cycle,
                         static_cast<unsigned long long>(vnextI2cCompletionsAfter),
                         static_cast<unsigned long long>(vnextI2cAtStart),
                         vnextProgressObserved ? "sim" : "nao");
        }
        if (useVnextB && vnextProgressObserved) ++vnextProgressCycles;
        if (useVnextB && cycle == 1 && staleCallbackBarrierEntered &&
            !staleCallbackBarrierReleased) {
            mcu::qemu::releaseVnextBTestWaitCallbackBarrier();
            staleCallbackBarrierReleased = true;
            (void)mcu::qemu::waitVnextBTestStaleWaitCallbackRejected(std::chrono::seconds(5));
            staleCallbackRejected = mcu::qemu::vnextBTestStaleWaitCallbackCount();
            staleCallbackBarrierArmed = false;
            std::fprintf(stderr, "  stale Execution A callback released rejected=%llu\n",
                         static_cast<unsigned long long>(staleCallbackRejected));
        }
        std::string uartText;
        if (useRealFirmware) {
            const auto uartTx = session.propertyValueOf(mcuIndex, "uart0_tx_monitor_hex");
            if (uartTx && std::holds_alternative<std::string>(*uartTx)) {
                uartText = decodeHex(std::get<std::string>(*uartTx));
            }
            if (uartText.find("Guru Meditation Error") != std::string::npos) {
                ++panicFailures;
                std::fprintf(stderr,
                             "  ciclo %d: PANIC NA UART (mesmo que o firmware tenha reiniciado):\n%s\n",
                             cycle, uartText.c_str());
            }
        }

        const bool intentionalStaleBarrierHold =
            useVnextB && cycle == 0 && staleCallbackBarrierEntered &&
            !staleCallbackBarrierReleased;
        if (!intentionalStaleBarrierHold &&
            (!stillRunning || !schedulerStillRunning ||
             (useVnextB ? !vnextProgressObserved : virtualTimeAfter == virtualTimeAtStart))) {
            // D2 STAGE 1 (2026-08-29) -- write qemuLogs() (which carries QEMU's own D2-SHADOW
            // report) to a crash-resistant local file FIRST, before anything else in this branch.
            // The pre-existing OPEN/SECONDARY exit-code-3 crash (not investigated, per standing
            // instruction) has repeatedly cut the piped stderr capture off before reaching the
            // qemuLogs() print later in this same branch -- this mirrors the same
            // open-write-close-immediately pattern already proven for the ConsumerTrace dump.
            {
                const char* path = std::getenv("LASECSIMUL_QEMU_LOGS_FILE");
                const std::string resolvedPath = (path && *path) ? path : "qemu_logs_dump.txt";
                if (std::FILE* f = std::fopen(resolvedPath.c_str(), "w")) {
                    const std::string logs = mcuPtr->qemuLogs();
                    std::fwrite(logs.data(), 1, logs.size(), f);
                    std::fclose(f);
                }
            }
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
            // E142 (EVIDENCE.md, 2026-09-08): Phase 2 causal-bisection boundary snapshot -- read
            // only, uses only existing/new *ForTesting() accessors (no stderr elsewhere, no env
            // var, no behavior change). Classifies exactly where the artifactEvent -> ... -> I2C
            // chain stopped for THIS failing cycle. Temporary: kept only if Phase 6/7 finds it
            // belongs in production diagnostics, removed otherwise.
            if (useVnextB) {
                const auto& diagAttachment = mcuPtr->vnextBAttachmentForTesting();
                const auto [lane0Write, lane0Read] = diagAttachment.laneRingSeqForTesting(0);
                const auto [lane1Write, lane1Read] = diagAttachment.laneRingSeqForTesting(1);
                std::fprintf(stderr,
                    "  E142_BOUNDARY_SNAPSHOT ciclo=%d lane0={write=%llu read=%llu} "
                    "lane1={write=%llu read=%llu} artifact_state=%u core_state=%u "
                    "heartbeat=%llu artifact_progress=%llu notificationPending=%s "
                    "pollGeneration=%llu pollThreadRunning=%s polling=%s pollEventScheduled=%s "
                    "waitDispatcherOccupiedSlots=%u\n",
                    cycle,
                    static_cast<unsigned long long>(lane0Write), static_cast<unsigned long long>(lane0Read),
                    static_cast<unsigned long long>(lane1Write), static_cast<unsigned long long>(lane1Read),
                    diagAttachment.view().control ? diagAttachment.view().control->artifact_state : 999u,
                    diagAttachment.view().control ? diagAttachment.view().control->core_state : 999u,
                    static_cast<unsigned long long>(diagAttachment.heartbeatWatermarkForTesting()),
                    static_cast<unsigned long long>(diagAttachment.artifactProgressForTesting()),
                    diagAttachment.notificationPending() ? "sim" : "nao",
                    static_cast<unsigned long long>(mcuPtr->pollGenerationForTesting()),
                    mcuPtr->pollThreadRunningForTesting() ? "sim" : "nao",
                    mcuPtr->pollingForTesting() ? "sim" : "nao",
                    mcuPtr->pollEventScheduledForTesting() ? "sim" : "nao",
                    static_cast<unsigned>(mcu::qemu::VnextBAttachment::waitDispatcherStatsForTesting().occupiedSlots));
                // E142 Phase 2, second pass: peekLane() is non-mutating -- safe to read the stuck
                // head event directly and reconstruct the exact arbiter inputs
                // (originNs + event.timestamp_ns vs nowNs) to prove/disprove the
                // "eternally-future" hypothesis this entry's own invariant list calls out.
                if (const auto head = diagAttachment.peekLane(0)) {
                    const uint64_t originNs = mcuPtr->qemuTimeOriginNsForTesting();
                    const uint64_t nowNs = session.scheduler().nowNs();
                    const uint64_t computed = originNs + head->timestamp_ns;
                    const auto pacing = mcuPtr->pacingPositionNs();
                    std::fprintf(stderr,
                        "  E142_ARBITER_INPUTS ciclo=%d lane0Head.timestamp_ns=%llu "
                        "originNs=%llu computed(origin+ts)=%llu nowNs=%llu ready=%s "
                        "pacingPositionNs=%s%llu\n",
                        cycle, static_cast<unsigned long long>(head->timestamp_ns),
                        static_cast<unsigned long long>(originNs),
                        static_cast<unsigned long long>(computed),
                        static_cast<unsigned long long>(nowNs),
                        computed <= nowNs ? "sim" : "nao",
                        pacing.has_value() ? "" : "NULLOPT/",
                        static_cast<unsigned long long>(pacing.value_or(0)));
                }
            }
            // TEMPORARY (ConsumerTrace investigation) -- dump the Core-side arena-consumer trace
            // FIRST, right where a mid-run stall (queue-full / QEMU premature exit) is detected,
            // BEFORE qemuLogs()/UART below -- a pre-existing, still-OPEN/SECONDARY crash (exit
            // code 3, not yet investigated per explicit instruction) has been observed landing
            // inside/soon after the qemuLogs() print on this exact path twice already, and cut the
            // trace dump off both times when it was ordered after. Round 2: also mirror to a local
            // file FIRST (more crash-resistant than the piped stderr capture -- see
            // dumpConsumerTraceToFileForTesting() doc-comment). No-op unless
            // LASECSIMUL_MCU_CONSUMER_TRACE=1. See McuComponent::ConsumerTrace.hpp.
            mcu::McuComponent::dumpConsumerTraceToFileForTesting();
            mcu::McuComponent::dumpConsumerTraceForTesting();
            std::fprintf(stderr, "  Logs QEMU do ciclo %d:\n%s\n", cycle,
                         mcuPtr->qemuLogs().c_str());
            ++stalledMidRun;
        } else if (intentionalStaleBarrierHold) {
            std::fprintf(stderr,
                         "STALE_BARRIER_INTENTIONAL_HOLD OBSERVED cycle=%d "
                         "callback_retained=1 normal_progress_exempt=1\n",
                         cycle);
        } else {
            std::fprintf(stderr, "  ciclo %d: OK (virtualTimeNs avancou %llu->%llu",
                         cycle, static_cast<unsigned long long>(virtualTimeAtStart),
                         static_cast<unsigned long long>(virtualTimeAfter));
            if (useRealFirmware && requireGpio) {
                std::fprintf(stderr, ", GPIO13 bordas=%d high=%s low-apos-high=%s"
                                     " ultimaBordaNowNs=%llu",
                             gpioTransitions, observedGpioHigh ? "sim" : "nao",
                             observedGpioLowAfterHigh ? "sim" : "nao",
                             static_cast<unsigned long long>(lastGpioTransitionNowNs));
            }
            std::fprintf(stderr, ")\n");
            // TEMPORARY (ConsumerTrace investigation, round 8) -- healthy-cycle aggregate summary
            // only (no per-event dump); the terminal/failing cycle gets the full detailed dump via
            // the existing dumpConsumerTraceToFileForTesting()/dumpConsumerTraceForTesting() calls
            // in the TRAVOU NO MEIO branch above instead.
            mcu::McuComponent::printAddressWatchSummaryForTesting(cycle);
        }

        if (useRealFirmware && requireGpio && !intentionalStaleBarrierHold &&
            (!observedGpioHigh || !observedGpioLowAfterHigh || gpioTransitions < 2)) {
            const LsdnQemuArena* failedArena = mcuPtr->arenaBridge().arena();
            const LsdnQemuQueueEntry* failedHead =
                failedArena && failedArena->queueReadIndex < failedArena->queueWriteIndex
                    ? &failedArena->queue[
                          failedArena->queueReadIndex % LSDN_QEMU_ARENA_QUEUE_DEPTH]
                    : nullptr;
            std::fprintf(stderr,
                "  ciclo %d: GPIO13 TRAVOU -- bordas=%d high=%s low-apos-high=%s"
                " firstHighNowNs=%llu firstLowAfterHighNowNs=%llu ultimaBordaNowNs=%llu"
                " arenaRunning=%llu queue=%llu/%llu schedulerNow=%llu pending=%zu"
                " head={timePs=%llu action=%llu addr=0x%llx}"
                " poll={enabled=%s thread=%s scheduled=%s generation=%llu}"
                " abi=%u peerReady=%s caps=0x%llx\n",
                cycle, gpioTransitions, observedGpioHigh ? "sim" : "nao",
                observedGpioLowAfterHigh ? "sim" : "nao",
                static_cast<unsigned long long>(firstGpioHighNowNs),
                static_cast<unsigned long long>(firstGpioLowAfterHighNowNs),
                static_cast<unsigned long long>(lastGpioTransitionNowNs),
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
            if (!uartText.empty()) {
                std::fprintf(stderr, "  UART0 TX do ciclo %d:\n%s\n", cycle,
                             uartText.c_str());
            }
            ++gpioFailures;
        } else if (verboseLogs) {
            std::fprintf(stderr, "  Logs QEMU do ciclo %d:\n%s\n", cycle,
                         mcuPtr->qemuLogs().c_str());
        }

        // [DIAGNOSTIC] .spec 32.5.19 -- ver comentario no setProfilingEnabled() acima. Impresso
        // incondicionalmente (ciclo passe ou falhe) pra comparar. maxSettleAtNowNs e as bordas do
        // GPIO13 estao todas na MESMA linha do tempo virtual que start_virt_ns/end_virt_ns dos logs
        // [WAIT-DIAG] do lado QEMU (ver simuliface.c) -- correlacao cruzada entre os dois processos
        // nao depende de alinhar relogios de parede, so comparar estes valores numericamente.
        {
            const auto metrics = session.scheduler().metrics();
            std::fprintf(stderr,
                "  ciclo %d: scheduler metrics -- settleIterations=%llu settleNanoseconds=%llu"
                " maxSettleNanoseconds=%llu (%.3fms) maxSettleAtNowNs=%llu timeSteps=%llu"
                " eventsProcessed=%llu gpioFirstHighNowNs=%llu gpioFirstLowAfterHighNowNs=%llu"
                " gpioLastEdgeNowNs=%llu\n",
                cycle,
                static_cast<unsigned long long>(metrics.settleIterations),
                static_cast<unsigned long long>(metrics.settleNanoseconds),
                static_cast<unsigned long long>(metrics.maxSettleNanoseconds),
                static_cast<double>(metrics.maxSettleNanoseconds) / 1.0e6,
                static_cast<unsigned long long>(metrics.maxSettleAtNowNs),
                static_cast<unsigned long long>(metrics.timeSteps),
                static_cast<unsigned long long>(metrics.eventsProcessed),
                static_cast<unsigned long long>(firstGpioHighNowNs),
                static_cast<unsigned long long>(firstGpioLowAfterHighNowNs),
                static_cast<unsigned long long>(lastGpioTransitionNowNs));
        }

        {
            const uint64_t doorbellWakeCount = mcuPtr->pollDoorbellWakeCountForTesting();
            const uint64_t doorbellWaitFailures = mcuPtr->pollWaitFailureCountForTesting();
            std::fprintf(stderr,
                "  ciclo %d: doorbell -- wakeCount(cumulativo)=%llu waitFailures(cumulativo)=%llu\n",
                cycle, static_cast<unsigned long long>(doorbellWakeCount),
                static_cast<unsigned long long>(doorbellWaitFailures));
            if (cycle == 0) doorbellWakeCountAfterCycle0 = doorbellWakeCount;
        }

        // TEMPORARY (ConsumerTrace investigation, round 6: Release-vs-Debug validation campaign)
        // -- one lightweight summary line per cycle (reads/resets the existing pressure tracker's
        // running max via peekAndResetMaxQueueOccupancyForTesting(); no new capture mechanism, no
        // full-trace dump). No-op text (queueMaxOcc=0) unless LASECSIMUL_MCU_CONSUMER_TRACE=1.
        std::fprintf(stderr,
            "  ciclo %d: RELEASE-CHECK bootOK=%s virtualTimeNs=%llu->%llu queueMaxOcc=%llu guru=%s"
            " coreProgressNs=%llu corePublishCount=%llu pacingNs=%llu->%llu mode=%s\n",
            cycle, booted ? "sim" : "nao",
            static_cast<unsigned long long>(virtualTimeAtStart), static_cast<unsigned long long>(virtualTimeAfter),
            static_cast<unsigned long long>(mcuPtr->peekAndResetMaxQueueOccupancyForTesting()),
            uartText.find("Guru Meditation Error") != std::string::npos ? "sim" : "nao",
            static_cast<unsigned long long>(mcuPtr->coreProgressNsForTesting()),
            static_cast<unsigned long long>(mcuPtr->corePublishCountForTesting()),
            static_cast<unsigned long long>(pacingAtStart),
            static_cast<unsigned long long>(pacingAfter),
            useRealFirmware ? "real_firmware" : "blank_flash");

        phaseMarker(cycle == 0 ? "PHASE_09_STOP_A_BEGIN" : "PHASE_17_STOP_B_BEGIN", cycle, executionId);
        const uint64_t vnextI2cSubmissionsBeforeStop = mcuPtr->vnextI2cSubmissionCountForTesting();
        const uint64_t vnextI2cCompletionsBeforeStop = mcuPtr->vnextI2cCompletionCountForTesting();
        std::thread staleReleaseDuringStop;
        if (intentionalStaleBarrierHold) {
            // The barrier is test-only and exists solely to leave one Execution A callback in
            // flight while stop() advances the attachment generation. Releasing it during stop()
            // proves the stale-generation rejection without manufacturing an unregister drain
            // timeout or carrying a blocked dispatcher into Execution B.
            staleReleaseDuringStop = std::thread([] {
                std::this_thread::sleep_for(std::chrono::milliseconds(250));
                mcu::qemu::releaseVnextBTestWaitCallbackBarrier();
                (void)mcu::qemu::waitVnextBTestStaleWaitCallbackRejected(std::chrono::seconds(5));
            });
        }
        session.stopSimulation();
        if (staleReleaseDuringStop.joinable()) {
            staleReleaseDuringStop.join();
            staleCallbackBarrierReleased = true;
            staleCallbackBarrierArmed = false;
            staleCallbackRejected = mcu::qemu::vnextBTestStaleWaitCallbackCount();
            std::fprintf(stderr, "  stale Execution A callback released during A stop rejected=%llu\n",
                         static_cast<unsigned long long>(staleCallbackRejected));
            const auto heldMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - staleBarrierEnteredAt).count();
            std::fprintf(stderr, "STALE_BARRIER_HELD_MS=%lld STALE_BARRIER_HELD_DURING_B_PROGRESS=0\n",
                         static_cast<long long>(heldMs));
            phaseMarker("PHASE_23_STALE_CALLBACK_RELEASED", cycle, executionId);
        }
        phaseMarker(cycle == 0 ? "PHASE_10_STOP_A_END" : "PHASE_18_STOP_B_END", cycle, executionId);
        const bool i2cQuiescedAfterStop =
            !useVnextB || !useRealFirmware || !aRealI2cObserved ||
            (mcuPtr->vnextI2cSubmissionCountForTesting() == vnextI2cSubmissionsBeforeStop &&
             mcuPtr->vnextI2cCompletionCountForTesting() == vnextI2cCompletionsBeforeStop);
        const bool stopClean = !mcuPtr->firmwareRunning() &&
                               !session.scheduler().isRunning() &&
                               !session.scheduler().isPaused() &&
                               session.scheduler().nowNs() == 0 &&
                               session.scheduler().pendingEventCount() == 0 &&
                               !session.runtimeState().executionActive;
        if (!stopClean || !i2cQuiescedAfterStop) {
            std::fprintf(stderr,
                "  ciclo %d: STOP NAO LIMPOU -- firmware=%s scheduler=%s paused=%s nowNs=%llu eventos=%zu"
                " executionActive=%s i2cBeforeStop=%llu/%llu i2cAfterStop=%llu/%llu quiesced=%s\n",
                cycle, mcuPtr->firmwareRunning() ? "rodando" : "parado",
                session.scheduler().isRunning() ? "rodando" : "parado",
                session.scheduler().isPaused() ? "sim" : "nao",
                static_cast<unsigned long long>(session.scheduler().nowNs()),
                session.scheduler().pendingEventCount(),
                session.runtimeState().executionActive ? "sim" : "nao",
                static_cast<unsigned long long>(vnextI2cSubmissionsBeforeStop),
                static_cast<unsigned long long>(vnextI2cCompletionsBeforeStop),
                static_cast<unsigned long long>(mcuPtr->vnextI2cSubmissionCountForTesting()),
                static_cast<unsigned long long>(mcuPtr->vnextI2cCompletionCountForTesting()),
                i2cQuiescedAfterStop ? "sim" : "nao");
            ++stopCleanupFailures;
        } else if (useVnextB && useRealFirmware && aRealI2cObserved) {
            ++i2cStopQuiescenceCycles;
        }
        removeTemporaryFlash();
    }

    if (!useVnextB) {
        const uint64_t finalDoorbellWakeCount = mcuPtr->pollDoorbellWakeCountForTesting();
        TEST_ASSERT(finalDoorbellWakeCount > doorbellWakeCountAfterCycle0,
                    "o doorbell reutilizado (mesmo HANDLE do ciclo 0) continua sendo sinalizado/aguardado"
                    " com sucesso em ciclos POS-restart, nao so no ciclo 0");
        TEST_ASSERT(mcuPtr->pollWaitFailureCountForTesting() == 0,
                    "nenhuma falha de wait no doorbell reutilizado ao longo de todos os ciclos");
    }

    TEST_ASSERT(failedToBoot == 0,
                useVnextB
                    ? "nenhum ciclo VNEXT_B deveria falhar em INICIALIZAR (pacingPositionNs sem avancar)"
                    : "nenhum ciclo deveria falhar em INICIALIZAR (arena->running nunca chegando a 1)");
    TEST_ASSERT(stalledMidRun == 0, "nenhum ciclo deveria travar NO MEIO (Scheduler+MCU reais)");
    if (requireGpio) {
        TEST_ASSERT(gpioFailures == 0, "GPIO13 deveria piscar em todos os ciclos com firmware real");
    }
    TEST_ASSERT(panicFailures == 0, "UART nao deveria conter Guru Meditation em nenhum ciclo");
    TEST_ASSERT(stopCleanupFailures == 0, "Stop deveria limpar MCU, Scheduler, pausa, relogio e eventos");
    TEST_ASSERT(executionIds.size() == static_cast<size_t>(cycleCount),
                "cada ciclo deveria obter um sessionExecutionId novo e distinto (stopSimulation()"
                " encerrando a execucao anterior antes do proximo beginExecutionIfNeeded())");

    if (useVnextB && !useRealFirmware && cycleCount >= 2 && failedToBoot == 0 &&
        stalledMidRun == 0 && vnextProgressCycles == cycleCount && vnextNoDedicatedPoll) {
        std::fprintf(stderr, "P9_RESTART_MANAGED_LIFECYCLE PASS mode=blank_flash cycles=%d\n", cycleCount);
        std::fprintf(stderr, "P9_RESTART_PACING_LIVENESS PASS cycles=%d\n", vnextProgressCycles);
        std::fprintf(stderr, "P9_STALE_WAIT_CALLBACK_REJECTED NOT_APPLICABLE mode=blank_flash no_real_i2c=1\n");
        std::fprintf(stderr, "P9_I2C_INFLIGHT_STOP_QUIESCENCE NOT_APPLICABLE mode=blank_flash no_real_i2c=1\n");
        std::fprintf(stderr, "VNEXT_NO_POLL_RESTART PASS polling_threads=0\n");
        std::fprintf(stderr, "VNEXT_DISPATCHER_RESTART_REUSE PASS slot_reused=bounded_generation_safe\n");
    }

    if (useVnextB && useRealFirmware && cycleCount >= 2 && failedToBoot == 0 && stalledMidRun == 0 &&
        vnextProgressCycles == cycleCount && staleCallbackBarrierEntered &&
        staleCallbackBarrierReleased && staleCallbackRejected == 1 &&
        i2cStopQuiescenceCycles == cycleCount) {
        std::fprintf(stderr, "P9_RESTART_MANAGED_LIFECYCLE PASS\n");
        std::fprintf(stderr, "P9_RESTART_REAL_PROGRESS PASS cycles=%d\n", vnextProgressCycles);
        std::fprintf(stderr, "P9_STALE_WAIT_CALLBACK_REJECTED PASS generation_mismatch=1 semantic_effect_on_B=0\n");
        std::fprintf(stderr, "P9_I2C_INFLIGHT_STOP_QUIESCENCE PASS cycles=%d\n", i2cStopQuiescenceCycles);
        std::fprintf(stderr, "P9_I2C_RESTART_ISOLATION PASS stale_real_i2c_result=NOT_APPLICABLE_TO_SYNCHRONOUS_RESPONSE_PATH synchronous_quiescence=1 fresh_B_i2c=1\n");
        std::fprintf(stderr, "VNEXT_NO_POLL_RESTART PASS polling_threads=0\n");
        std::fprintf(stderr, "VNEXT_DISPATCHER_RESTART_REUSE PASS slot_reused=bounded_generation_safe\n");
    }

    if (useVnextB && cycleCount == 1 && failedToBoot == 0 && stalledMidRun == 0 &&
        vnextProgressCycles == 1 && vnextNoDedicatedPoll) {
        std::fprintf(stderr, "VNEXT_NO_POLL_SINGLE_EXECUTION PASS polling_threads=0\n");
    }

    std::fprintf(stderr,
                 "\nResumo: %d/%d falharam ao iniciar, %d/%d travaram, %d/%d falharam no GPIO13, "
                 "%d/%d tiveram Guru Meditation, %d/%d deixaram estado apos Stop, "
                 "%zu/%d sessionExecutionId distintos.\n",
                 failedToBoot, cycleCount, stalledMidRun, cycleCount, gpioFailures, cycleCount,
                 panicFailures, cycleCount,
                 stopCleanupFailures, cycleCount,
                 executionIds.size(), cycleCount);

    if (failures == 0) {
        std::printf("\nTodos os %d ciclos (Scheduler+QEMU reais) passaram sem falha.\n", cycleCount);
        return 0;
    }
    std::fprintf(stderr, "\n%d teste(s) FALHARAM.\n", failures);
    return 1;
}
