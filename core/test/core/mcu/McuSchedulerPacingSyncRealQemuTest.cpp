// Achado 2026-07-23 (usuário reporta, AO VIVO, com firmware real -- potenciômetro em analogRead()
// + UART pra LasecPlot: "o MCU subiu e depois caiu pra 0%" no meio de uma única execução, sem
// nenhum Stop/Run no meio). O indicador do elétrico ficou em ~98% (não travado, correndo livre) --
// consistente com a correção de staleness em SimulationSession::computeSlowestMcuPositionNs()
// funcionando como esperado (um MCU que parou de responder deixa de travar o elétrico pra sempre),
// mas isso NÃO explica por que o MCU parou de produzir eventos em primeiro lugar.
//
// Nenhum teste existente cobre "QEMU real + Scheduler real + a sincronização de ritmo nova,
// sustentado por um tempo longo": QemuQueueStressTest.cpp roda 60s de QEMU real mas via
// McuController puro (sem Scheduler/AdvanceLimitFn nenhum); SessionRestartStressTest.cpp usa
// Scheduler+QEMU reais mas em MUITOS ciclos CURTOS de Stop->Run, não uma única sessão longa;
// McuSchedulerPacingSyncTest.cpp exercita a sincronização de ritmo mas só com arena SINTÉTICA (sem
// QEMU de verdade). Este teste fecha essa lacuna: QEMU real + Scheduler real + AdvanceLimitFn real,
// numa ÚNICA sessão sustentada, monitorando o maior intervalo (parede) entre avanços de
// latestVirtualTimeNs() E entre avanços de Scheduler::nowNs() -- uma trava real do tipo relatado se
// manifestaria como um desses dois parar de avançar pelo resto do teste.
#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <memory>
#include <string>
#include <string_view>
#include <thread>
#include <vector>
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

std::string uniqueArenaName() {
    return "lasecsimul-pacing-sync-real-qemu-test-" +
           std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
}

std::filesystem::path createBlankFlash() {
    const std::filesystem::path path =
        std::filesystem::temp_directory_path() / (uniqueArenaName() + "-flash.bin");
    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    const std::vector<char> erasedBlock(64 * 1024, static_cast<char>(0xFF));
    for (int i = 0; i < 64; ++i) out.write(erasedBlock.data(), erasedBlock.size());
    if (!out) throw std::runtime_error("nao foi possivel criar flash vazia de teste");
    return path;
}

int configuredStressSeconds() {
    const char* value = std::getenv("LASECSIMUL_STRESS_SECONDS");
    if (!value || !*value) return 90;
    char* end = nullptr;
    const long parsed = std::strtol(value, &end, 10);
    return end != value && *end == '\0' && parsed >= 5 && parsed <= 600
               ? static_cast<int>(parsed)
               : 90;
}

} // namespace

int main() {
#ifndef QEMU_REAL_BINARY_PATH
#error "QEMU_REAL_BINARY_PATH precisa ser definido pelo CMakeLists (caminho do qemu-system-xtensa.exe real)"
#endif
#ifndef ESP32_ADAPTER_DLL_PATH
#error "ESP32_ADAPTER_DLL_PATH precisa ser definido pelo CMakeLists (caminho do adapter.dll real)"
#endif
    const char* qemuOverride = std::getenv("LASECSIMUL_TEST_QEMU_BINARY");
    const std::filesystem::path qemuPath =
        (qemuOverride && *qemuOverride) ? std::filesystem::u8path(qemuOverride)
                                        : std::filesystem::path(QEMU_REAL_BINARY_PATH);
    const std::filesystem::path dllPath = ESP32_ADAPTER_DLL_PATH;
    if (!std::filesystem::exists(qemuPath)) {
        std::fprintf(stderr, "PULADO: %s nao existe.\n", qemuPath.string().c_str());
        return 0;
    }
    if (!std::filesystem::exists(dllPath)) {
        std::fprintf(stderr, "PULADO: %s nao existe -- rode 'npm run build:mcu-adapters'.\n", dllPath.string().c_str());
        return 0;
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
    const uint32_t mcuIndex = session.addComponent("mcu.esp32", {});
    TEST_ASSERT(mcuPtr != nullptr, "McuComponent real criado");

    const std::filesystem::path flashPath = createBlankFlash();
    const std::string arenaName = uniqueArenaName();

    session.scheduler().setRealTimeRate(1.0); // mesmo default que a extensao configura hoje.
    // Mesma ordem que o handler "start" real usa (CoreApplication.cpp): desde 102546b,
    // loadMcuFirmware() exige executionActive/sessionExecutionId, estabelecidos por
    // beginExecutionIfNeeded().
    session.beginExecutionIfNeeded();
    session.scheduler().resume();
    if (!session.scheduler().isRunning()) session.scheduler().start();
    try {
        session.loadMcuFirmware(mcuIndex, flashPath, arenaName, qemuPath.string());
    } catch (const std::exception& ex) {
        std::fprintf(stderr, "FALHOU: loadMcuFirmware lancou: %s\n", ex.what());
        return 1;
    }

    // Espera o primeiro sinal de vida -- só a thread de poll dedicada drena a fila, o Scheduler ja
    // esta rodando em background. Transport-aware (user-specified, PLAN_MTTCG_VNEXT_B_CAUSALITY.md
    // R3c follow-up): LEGACY's arena->running is a field VNEXT_B never writes -- there is no
    // register-level "guest booted" equivalent, and this test deliberately uses blank flash, so
    // inventing one would be meaningless. "Process alive" alone is rejected too: a genuinely hung
    // guest would also satisfy that. For VNEXT_B, require pacingPositionNs() (which folds in the
    // R3c heartbeat watermark, see McuComponent::pacingPositionNs()) to have advanced past its
    // pre-wait baseline -- proof QEMU_CLOCK_VIRTUAL is actually ticking for this session, using
    // the exact same accessor this test's own stall-detection loop below already trusts.
    const char* transportEnv = std::getenv("LASECSIMUL_MCU_TRANSPORT");
    const bool usingVnextB = transportEnv && std::string_view(transportEnv) == "VNEXT_B";
    constexpr auto kBootTimeout = std::chrono::seconds(5);
    const auto bootDeadline = std::chrono::steady_clock::now() + kBootTimeout;
    const uint64_t pacingBaselineAtBoot = usingVnextB ? mcuPtr->pacingPositionNs().value_or(0) : 0;
    bool livenessObserved = false;
    while (std::chrono::steady_clock::now() < bootDeadline) {
        if (usingVnextB) {
            if (mcuPtr->pacingPositionNs().value_or(0) > pacingBaselineAtBoot) { livenessObserved = true; break; }
        } else {
            const LsdnQemuArena* arena = mcuPtr->arenaBridge().arena();
            if (arena && arena->running != 0) { livenessObserved = true; break; }
        }
        if (!mcuPtr->firmwareRunning()) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    TEST_ASSERT(livenessObserved, usingVnextB ? "MCU real avancou pacingPositionNs() (heartbeat vivo, R3c)"
                                               : "MCU real inicializou (arena->running==1)");

    // Duracao deliberadamente bem maior que os outros testes de pacing sync (que rodam frações de
    // segundo a poucos segundos com arena SINTETICA) -- o achado ao vivo foi "funcionou por um
    // tempo com firmware real, depois o MCU parou de produzir eventos", entao uma janela curta nao
    // teria exposicao suficiente.
    const auto stressDuration = std::chrono::seconds(configuredStressSeconds());
    constexpr auto kStallThreshold = std::chrono::seconds(10);

    uint64_t lastMcuVirtualNs = mcuPtr->latestVirtualTimeNs();
    uint64_t lastSchedulerNowNs = session.scheduler().nowNs();
    auto lastMcuProgressAt = std::chrono::steady_clock::now();
    auto lastSchedulerProgressAt = std::chrono::steady_clock::now();
    auto longestMcuGap = std::chrono::steady_clock::duration::zero();
    auto longestSchedulerGap = std::chrono::steady_clock::duration::zero();
    bool stillRunning = true;

    const auto testDeadline = std::chrono::steady_clock::now() + stressDuration;
    while (std::chrono::steady_clock::now() < testDeadline) {
        if (!mcuPtr->firmwareRunning()) { stillRunning = false; break; }

        const auto now = std::chrono::steady_clock::now();
        // PLAN_MTTCG_VNEXT_B_CAUSALITY.md's R3c: this test's own name and header comment say its
        // purpose is Scheduler PACING sync, i.e. whether the electrical simulation is ever left
        // believing an MCU that stopped responding is still fine -- pacingPositionNs() is the
        // exact getter that answers that (it feeds Scheduler::AdvanceLimitFn), and per R3c it now
        // also incorporates the VNEXT_B heartbeat watermark, so pacing correctly never stalls even
        // when the guest is legitimately silent (this test's blank flash: no valid app partition,
        // so no GPIO/I2C is ever produced -- by design, see createBlankFlash()'s purpose).
        // latestVirtualTimeNs() is a DIFFERENT, deliberately narrower signal (confirmed *applied*
        // events only -- see its own doc-comment) that must NOT be conflated with pacing safety;
        // it legitimately stays flat for a silent guest and checking it here would fail this test
        // for a reason that has nothing to do with pacing.
        const uint64_t mcuVirtualNs = mcuPtr->pacingPositionNs().value_or(0);
        if (mcuVirtualNs != lastMcuVirtualNs) {
            longestMcuGap = std::max(longestMcuGap, now - lastMcuProgressAt);
            lastMcuVirtualNs = mcuVirtualNs;
            lastMcuProgressAt = now;
        }

        const uint64_t schedulerNowNs = session.scheduler().nowNs();
        if (schedulerNowNs != lastSchedulerNowNs) {
            longestSchedulerGap = std::max(longestSchedulerGap, now - lastSchedulerProgressAt);
            lastSchedulerNowNs = schedulerNowNs;
            lastSchedulerProgressAt = now;
        }

        const auto mcuGapSoFar = now - lastMcuProgressAt;
        if (mcuGapSoFar > kStallThreshold) {
            std::fprintf(stderr, "AVISO: %lld segundos sem o MCU avancar (limiar de trava: %lld s)\n",
                         static_cast<long long>(std::chrono::duration_cast<std::chrono::seconds>(mcuGapSoFar).count()),
                         static_cast<long long>(kStallThreshold.count()));
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }

    const auto finalNow = std::chrono::steady_clock::now();
    longestMcuGap = std::max(longestMcuGap, finalNow - lastMcuProgressAt);
    longestSchedulerGap = std::max(longestSchedulerGap, finalNow - lastSchedulerProgressAt);

    const std::string logs = mcuPtr->qemuLogs();
    session.stopSimulation();
    std::filesystem::remove(flashPath);

    TEST_ASSERT(stillRunning, "processo QEMU real permaneceu vivo durante toda a janela de estresse");
    TEST_ASSERT(longestMcuGap < kStallThreshold,
        "MCU nunca ficou mais que o limiar de trava sem avancar -- nenhuma trava real durante a sessao longa");
    TEST_ASSERT(longestSchedulerGap < kStallThreshold,
        "Scheduler::nowNs() nunca ficou mais que o limiar de trava sem avancar (o teto novo nao prende o eletrico pra sempre)");

    std::fprintf(stderr, "longestMcuGapMs=%lld longestSchedulerGapMs=%lld duration=%llds\n",
                 static_cast<long long>(std::chrono::duration_cast<std::chrono::milliseconds>(longestMcuGap).count()),
                 static_cast<long long>(std::chrono::duration_cast<std::chrono::milliseconds>(longestSchedulerGap).count()),
                 static_cast<long long>(stressDuration.count()));

    if (failures == 0) {
        std::printf("\nTodos os testes de sincronizacao de ritmo com QEMU real passaram (sem trava em %llds sustentados).\n",
                     static_cast<long long>(stressDuration.count()));
        return 0;
    }
    std::fprintf(stderr, "\n%d teste(s) FALHARAM. Ultimos logs QEMU:\n%s\n", failures, logs.c_str());
    return 1;
}
