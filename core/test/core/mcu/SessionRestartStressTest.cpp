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
#include <filesystem>
#include <fstream>
#include <memory>
#include <string>
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

} // namespace

int main() {
#ifndef ESP32_ADAPTER_DLL_PATH
#error "ESP32_ADAPTER_DLL_PATH precisa ser definido pelo CMakeLists (caminho do adapter.dll real)"
#endif
#ifndef QEMU_REAL_BINARY_PATH
#error "QEMU_REAL_BINARY_PATH precisa ser definido pelo CMakeLists (caminho do qemu-system-xtensa.exe real)"
#endif
    const std::filesystem::path dllPath = ESP32_ADAPTER_DLL_PATH;
    const std::filesystem::path qemuPath = QEMU_REAL_BINARY_PATH;
    if (!std::filesystem::exists(dllPath)) {
        std::fprintf(stderr, "PULADO: %s nao existe -- rode 'npm run build:mcu-adapters'.\n", dllPath.string().c_str());
        return 0;
    }
    if (!std::filesystem::exists(qemuPath)) {
        std::fprintf(stderr, "PULADO: %s nao existe.\n", qemuPath.string().c_str());
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

    constexpr int kCycles = 15;
    constexpr auto kBootTimeout = std::chrono::milliseconds(5000);
    constexpr auto kRunDuration = std::chrono::milliseconds(600);

    int failedToBoot = 0;
    int stalledMidRun = 0;

    for (int cycle = 0; cycle < kCycles; ++cycle) {
        const std::filesystem::path flashPath = createBlankFlash(cycle);
        const std::string arenaName = uniqueArenaName(cycle);

        // Mesma ordem que a Extension real usa: Scheduler primeiro (coreLifecycle.ts::runSimulation
        // chama Core.run(), que religa o Scheduler), depois loadMcuFirmware.
        if (!session.scheduler().isRunning()) session.scheduler().start();

        try {
            session.loadMcuFirmware(mcuIndex, flashPath, arenaName, qemuPath.string());
        } catch (const std::exception& ex) {
            std::fprintf(stderr, "  ciclo %d: loadMcuFirmware lancou: %s\n", cycle, ex.what());
            ++failedToBoot;
            std::filesystem::remove(flashPath);
            continue;
        }

        // Espera o primeiro sinal de vida real (arena->running==1) -- só a thread de poll dedicada
        // do McuComponent (Scheduler já está rodando) drena a fila, não fazemos isso manualmente
        // aqui (ao contrário de McuRestartStressTest, que usa McuController puro sem Scheduler).
        const auto bootDeadline = std::chrono::steady_clock::now() + kBootTimeout;
        bool booted = false;
        while (std::chrono::steady_clock::now() < bootDeadline) {
            const LsdnQemuArena* arena = mcuPtr->arenaBridge().arena();
            if (arena && arena->running != 0) { booted = true; break; }
            if (!mcuPtr->firmwareRunning()) break; // processo morreu antes de sinalizar vida
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
        if (!booted) {
            std::fprintf(stderr, "  ciclo %d: NAO INICIALIZOU em %lldms (firmwareRunning=%s)\n",
                         cycle, static_cast<long long>(kBootTimeout.count()),
                         mcuPtr->firmwareRunning() ? "sim" : "nao");
            ++failedToBoot;
            session.stopSimulation();
            std::filesystem::remove(flashPath);
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
        std::this_thread::sleep_for(kRunDuration);
        const bool stillRunning = mcuPtr->firmwareRunning();
        const bool schedulerStillRunning = session.scheduler().isRunning();
        const uint64_t virtualTimeAfter = mcuPtr->latestVirtualTimeNs();

        if (!stillRunning || !schedulerStillRunning || virtualTimeAfter == virtualTimeAtStart) {
            std::fprintf(stderr,
                "  ciclo %d: TRAVOU NO MEIO -- firmwareRunning=%s schedulerRunning=%s virtualTimeNs %llu->%llu "
                "arenaRunning=%llu\n",
                cycle, stillRunning ? "sim" : "nao", schedulerStillRunning ? "sim" : "nao",
                static_cast<unsigned long long>(virtualTimeAtStart), static_cast<unsigned long long>(virtualTimeAfter),
                static_cast<unsigned long long>(mcuPtr->arenaBridge().arena() ? mcuPtr->arenaBridge().arena()->running : 999));
            ++stalledMidRun;
        } else {
            std::fprintf(stderr, "  ciclo %d: OK (virtualTimeNs avancou %llu->%llu)\n", cycle,
                         static_cast<unsigned long long>(virtualTimeAtStart), static_cast<unsigned long long>(virtualTimeAfter));
        }

        session.stopSimulation();
        std::filesystem::remove(flashPath);
    }

    TEST_ASSERT(failedToBoot == 0, "nenhum ciclo deveria falhar em INICIALIZAR (arena->running nunca chegando a 1)");
    TEST_ASSERT(stalledMidRun == 0, "nenhum ciclo deveria travar NO MEIO (Scheduler+MCU reais)");

    std::fprintf(stderr, "\nResumo: %d/%d ciclos falharam ao iniciar, %d/%d travaram no meio.\n",
                 failedToBoot, kCycles, stalledMidRun, kCycles);

    if (failures == 0) {
        std::printf("\nTodos os %d ciclos (Scheduler+QEMU reais) passaram sem falha.\n", kCycles);
        return 0;
    }
    std::fprintf(stderr, "\n%d teste(s) FALHARAM.\n", failures);
    return 1;
}
