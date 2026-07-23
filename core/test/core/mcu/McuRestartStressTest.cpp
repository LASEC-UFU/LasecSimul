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
    const std::filesystem::path qemuPath = QEMU_REAL_BINARY_PATH;
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
            controller.start(flashPath, arenaName);
        } catch (const std::exception& ex) {
            std::fprintf(stderr, "  ciclo %d: start() lancou: %s\n", cycle, ex.what());
            ++failedToBoot;
            std::filesystem::remove(flashPath);
            continue;
        }

        // Bombeia a arena (mesma técnica de QemuQueueStressTest) enquanto espera o primeiro sinal
        // de vida (running=1) -- sem isso o vCPU pode travar em waitForSynch() assim que tocar
        // qualquer registrador, igual ao achado que motivou QemuIcountCalibrator::pumpArenaFor.
        auto pumpUntilRunningOrTimeout = [&](std::chrono::milliseconds timeout) -> bool {
            const auto deadline = std::chrono::steady_clock::now() + timeout;
            while (std::chrono::steady_clock::now() < deadline) {
                if (!controller.isRunning()) return false;
                const auto result = controller.arenaBridge().poll();
                if (result.hasEvent) {
                    if (result.event->simuAction == LSDN_SIM_READ) controller.arenaBridge().acknowledgeRead(0);
                    else controller.arenaBridge().acknowledgeWrite();
                }
                if (controller.arenaBridge().arena() && controller.arenaBridge().arena()->running != 0) return true;
                std::this_thread::sleep_for(std::chrono::milliseconds(1));
            }
            return false;
        };

        const bool booted = pumpUntilRunningOrTimeout(kBootTimeout);
        if (!booted) {
            std::fprintf(stderr, "  ciclo %d: NAO INICIALIZOU (arena->running nunca virou 1 em %lldms) -- processo vivo=%s\n",
                         cycle, static_cast<long long>(kBootTimeout.count()), controller.isRunning() ? "sim" : "nao");
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
        const auto runDeadline = std::chrono::steady_clock::now() + kRunDuration;
        bool diedMidRun = false;
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
