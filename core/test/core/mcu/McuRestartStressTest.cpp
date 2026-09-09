// Achado 2026-07-22 (usuário reporta, AO VIVO, comportamento inconsistente entre ciclos Stop->Run
// com um Core recém-iniciado -- já descartada a hipótese de processo antigo: às vezes o MCU nunca
// chega a rodar, às vezes roda perfeitamente, às vezes roda por um tempo e para). Todos os testes
// reais existentes (McuControllerRealQemuTest, QemuQueueStressTest) exercitam um ÚNICO
// start()/stop() -- nenhum testa o CICLO repetido, que é exatamente onde o usuário observa o
// problema. Este teste martela dezenas de ciclos start->confirma progresso->stop seguidos, cada um
// com um NOME DE ARENA ÚNICO (mesma disciplina que o Core real usa -- instanceId nunca é reaproveitado,
// ver SimulationSession::addComponent, sempre push_back), pra flagrar uma falha intermitente que um
// teste de sessão única nunca pegaria.
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <memory>
#include <string>
#include <thread>
#include <vector>
#include "mcu/McuController.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "plugins/PluginRuntime.hpp"

using namespace lasecsimul;
using namespace lasecsimul::mcu;

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
    return "lasecsimul-restart-stress-" +
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
    plugins::PluginRuntime runtime(cache);

    constexpr int kCycles = 25;
    constexpr auto kBootTimeout = std::chrono::milliseconds(4000);
    constexpr auto kRunDuration = std::chrono::milliseconds(400);
    constexpr auto kStallThreshold = std::chrono::milliseconds(1500);

    int failedToBoot = 0;
    int stalledMidRun = 0;

    for (int cycle = 0; cycle < kCycles; ++cycle) {
        const std::unique_ptr<IMcuAdapter> adapter = runtime.createMcuAdapter("espressif.esp32");
        if (!adapter) { std::fprintf(stderr, "  FALHOU: ciclo %d -- adapter nulo\n", cycle); ++failures; continue; }

        McuController controller(*adapter, qemuPath.string());
        const std::string arenaName = uniqueArenaName(cycle);
        const std::filesystem::path flashPath = createBlankFlash(cycle);

        try {
            // Pre-existing gap surfaced by PLAN_MTTCG_VNEXT_B_CAUSALITY.md R1 (explicit
            // -Transport): McuController::start()'s VNEXT_B branch requires a non-zero
            // RuntimeLaunchIdentity (McuController.cpp ~line 303) -- this test only ever
            // exercised LEGACY before that harness flag existed. launchGeneration bumps per
            // cycle, matching the production convention for repeated restarts of one MCU slot.
            const RuntimeLaunchIdentity identity{0xCCCC111122223333ULL, 1,
                                                  static_cast<uint64_t>(cycle) + 1};
            controller.start(flashPath, arenaName, {}, {}, identity);
        } catch (const std::exception& ex) {
            std::fprintf(stderr, "  ciclo %d: start() lancou: %s\n", cycle, ex.what());
            ++failedToBoot;
            std::filesystem::remove(flashPath);
            continue;
        }

        // Bombeia a arena (mesma técnica de QemuQueueStressTest) enquanto espera o primeiro sinal
        // de vida (running=1) -- sem isso o vCPU pode travar em waitForSynch() assim que tocar
        // qualquer registrador, igual ao achado que motivou QemuIcountCalibrator::pumpArenaFor.
        // Transport-aware (user-specified, PLAN_MTTCG_VNEXT_B_CAUSALITY.md R3c follow-up):
        // arenaBridge().arena()->running is LEGACY-only -- McuController::start()'s VNEXT_B branch
        // never opens that bridge (early return, McuController.cpp ~line 306-309), and this test's
        // blank flash never runs real firmware, so there is no "guest booted" signal to invent for
        // VNEXT_B. "Process alive" alone is rejected: a hung guest also satisfies that. Require the
        // R3c heartbeat watermark (VnextBAttachment::heartbeatWatermarkForTesting(), backed by
        // control->artifact_virtual_time_ns) to advance past its pre-wait baseline instead --
        // proof QEMU_CLOCK_VIRTUAL is actually ticking for this session.
        const bool usingVnextB = controller.vnextBActive();
        auto pumpUntilLiveOrTimeout = [&](std::chrono::milliseconds timeout) -> bool {
            const auto deadline = std::chrono::steady_clock::now() + timeout;
            const uint64_t heartbeatBaseline =
                usingVnextB ? controller.vnextBAttachment().heartbeatWatermarkForTesting() : 0;
            while (std::chrono::steady_clock::now() < deadline) {
                if (!controller.isRunning()) return false;
                if (usingVnextB) {
                    if (controller.vnextBAttachment().heartbeatWatermarkForTesting() > heartbeatBaseline) return true;
                } else {
                    const auto result = controller.arenaBridge().poll();
                    if (result.hasEvent) {
                        if (result.event->simuAction == LSDN_SIM_READ) controller.arenaBridge().acknowledgeRead(0);
                        else controller.arenaBridge().acknowledgeWrite();
                    }
                    if (controller.arenaBridge().arena() && controller.arenaBridge().arena()->running != 0) return true;
                }
                std::this_thread::sleep_for(std::chrono::milliseconds(1));
            }
            return false;
        };

        const bool livenessObserved = pumpUntilLiveOrTimeout(kBootTimeout);
        if (!livenessObserved) {
            std::fprintf(stderr, "  ciclo %d: NAO INICIALIZOU (%s em %lldms) -- processo vivo=%s\n",
                         cycle, usingVnextB ? "heartbeat watermark nunca avancou" : "arena->running nunca virou 1",
                         static_cast<long long>(kBootTimeout.count()), controller.isRunning() ? "sim" : "nao");
            ++failedToBoot;
            controller.stop();
            std::filesystem::remove(flashPath);
            continue;
        }

        // Já inicializou -- roda por uma janela curta, monitorando se para de progredir no meio
        // (o padrão relatado ao vivo: "começava e parava depois de um tempo").
        uint64_t eventsThisCycle = 0;
        auto lastEventAt = std::chrono::steady_clock::now();
        auto longestGapThisCycle = std::chrono::steady_clock::duration::zero();
        bool diedMidRun = false;
        if (usingVnextB) {
            // eventsThisCycle counting LEGACY lane events (arenaBridge().poll()) would always read
            // 0 under VNEXT_B (that bridge is never opened, see boot-wait comment above) and
            // incorrectly flag every silent-guest cycle as "TRAVOU NO MEIO" -- exactly the false
            // positive the R3c heartbeat exists to prevent. Also, kRunDuration=400ms is shorter
            // than the heartbeat's own 1s QEMU_CLOCK_VIRTUAL period, so a literal per-iteration
            // tick count over that window would misfire on timer phase alignment alone, even on a
            // perfectly healthy session. Use a window comfortably longer than one heartbeat period
            // and treat a single observed watermark advance as this cycle's progress signal.
            constexpr auto kVnextBMidRunWindow = std::chrono::milliseconds(1500);
            const uint64_t midRunBaseline = controller.vnextBAttachment().heartbeatWatermarkForTesting();
            const auto midRunDeadline = std::chrono::steady_clock::now() + kVnextBMidRunWindow;
            while (std::chrono::steady_clock::now() < midRunDeadline) {
                if (!controller.isRunning()) { diedMidRun = true; break; }
                if (controller.vnextBAttachment().heartbeatWatermarkForTesting() > midRunBaseline) {
                    eventsThisCycle = 1;
                    break;
                }
                std::this_thread::sleep_for(std::chrono::milliseconds(10));
            }
        } else {
            const auto runDeadline = std::chrono::steady_clock::now() + kRunDuration;
            while (std::chrono::steady_clock::now() < runDeadline) {
                if (!controller.isRunning()) { diedMidRun = true; break; }
                const auto result = controller.arenaBridge().poll();
                if (result.hasEvent) {
                    ++eventsThisCycle;
                    const auto now = std::chrono::steady_clock::now();
                    longestGapThisCycle = std::max(longestGapThisCycle, now - lastEventAt);
                    lastEventAt = now;
                    if (result.event->simuAction == LSDN_SIM_READ) controller.arenaBridge().acknowledgeRead(0);
                    else controller.arenaBridge().acknowledgeWrite();
                    continue;
                }
                std::this_thread::sleep_for(std::chrono::milliseconds(1));
            }
        }

        if (diedMidRun || eventsThisCycle == 0 || longestGapThisCycle > kStallThreshold) {
            std::fprintf(stderr,
                "  ciclo %d: TRAVOU NO MEIO -- diedMidRun=%s eventsThisCycle=%llu longestGapMs=%lld processo_vivo=%s\n",
                cycle, diedMidRun ? "sim" : "nao", static_cast<unsigned long long>(eventsThisCycle),
                static_cast<long long>(std::chrono::duration_cast<std::chrono::milliseconds>(longestGapThisCycle).count()),
                controller.isRunning() ? "sim" : "nao");
            ++stalledMidRun;
        } else {
            std::fprintf(stderr, "  ciclo %d: OK (eventos=%llu, maior intervalo=%lldms)\n", cycle,
                         static_cast<unsigned long long>(eventsThisCycle),
                         static_cast<long long>(std::chrono::duration_cast<std::chrono::milliseconds>(longestGapThisCycle).count()));
        }

        controller.stop();
        std::filesystem::remove(flashPath);
    }

    TEST_ASSERT(failedToBoot == 0, "nenhum ciclo deveria falhar em INICIALIZAR (arena->running nunca chegando a 1)");
    TEST_ASSERT(stalledMidRun == 0, "nenhum ciclo deveria travar NO MEIO depois de já ter inicializado");

    std::fprintf(stderr, "\nResumo: %d/%d ciclos falharam ao iniciar, %d/%d travaram no meio.\n",
                 failedToBoot, kCycles, stalledMidRun, kCycles);

    if (failures == 0) {
        std::printf("\nTodos os %d ciclos de restart passaram sem falha ao iniciar nem travamento no meio.\n", kCycles);
        return 0;
    }
    std::fprintf(stderr, "\n%d teste(s) FALHARAM.\n", failures);
    return 1;
}
