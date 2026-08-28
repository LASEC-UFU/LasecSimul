// Achado 2026-08-28 (queue-full correctness fix, ver simuliface.c waitForSynch()/
// publishQueueEntry()): antes da correção, um timeout de waitForSynch() (fila cheia por tempo
// demais) deixava publishQueueEntry() publicar a entrada de qualquer forma, sobrescrevendo um
// slot que o Core ainda não tinha consumido -- corrupção silenciosa do protocolo, sem sinal
// nenhum pro operador. A correção troca o timeout por iteração (host-speed-dependent) por um
// bound de tempo real de host (HOST PROCESS-HEALTH BACKSTOP, 3s) e faz publishQueueEntry()
// retornar false sem publicar nada quando esse bound estoura; writeReg()/writeSimEvent()/
// simu_event() tratam false como falha terminal (qemu_system_shutdown_request(
// SHUTDOWN_CAUSE_HOST_ERROR)) em vez de continuar rodando sobre estado corrompido.
//
// Este teste EXERCITA o caminho de timeout genuíno de propósito: usa a mesma técnica de
// QemuQueueStressTest.cpp (McuController de baixo nível, sem McuComponent/Scheduler por cima --
// nada drena a arena automaticamente), mas ao contrário -- em vez de bombear poll()/
// acknowledgeWrite() agressivamente, NÃO drena nada. O heartbeat do QEMU (period_ns=50000, ~50us
// de tempo virtual, que sob MTTCG-realtime acompanha aproximadamente tempo de parede 1:1) enche a
// fila de 32 entradas sozinho, sem precisar de firmware real nem registro nenhum -- flash vazia
// (apagada) já basta, mesma técnica de QemuQueueStressTest.cpp/McuControllerRealQemuTest.cpp.
//
// Critério: dentro de uma janela generosa (bem maior que o backstop de 3s), o processo QEMU deve
// se auto-terminar de forma limpa (isRunning() vira false sem precisar matar o processo) E o log
// deve mostrar a mensagem do backstop -- confirmando propagação->desligamento controlado, não uma
// trava do processo host nem uma continuação silenciosa sobre fila corrompida.
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

std::string uniqueArenaName() {
    return "lasecsimul-queue-full-timeout-test-" +
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
        qemuOverride && *qemuOverride ? std::filesystem::u8path(qemuOverride)
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
    const std::unique_ptr<IMcuAdapter> adapter = runtime.createMcuAdapter("espressif.esp32");
    TEST_ASSERT(adapter != nullptr, "PluginRuntime cria o IMcuAdapter ESP32 a partir do plugin real");
    if (!adapter) return 1;

    McuController controller(*adapter, qemuPath.string());
    const std::string arenaName = uniqueArenaName();
    const std::filesystem::path flashPath = createBlankFlash();

    try {
        controller.start(flashPath, arenaName);
    } catch (const std::exception& ex) {
        std::fprintf(stderr, "FALHOU: McuController::start lancou: %s\n", ex.what());
        return 1;
    }

    // Deliberadamente NÃO drena a arena -- nem poll(), nem acknowledgeWrite()/acknowledgeRead().
    // O heartbeat do QEMU publica sozinho na fila (SIM_EVENT, sem depender de firmware real) até
    // enchê-la (32 entradas) e então waitForSynch() passa a esperar o backstop de 3s antes de
    // desistir. Janela de observação bem maior que 3s pra dar margem sem transformar isto num
    // teste "espera exatos 3s e mede com precisão" -- só precisamos confirmar que ele SE RESOLVE.
    const auto testStart = std::chrono::steady_clock::now();
    const auto observationDeadline = testStart + std::chrono::seconds(20);
    bool selfTerminated = false;
    while (std::chrono::steady_clock::now() < observationDeadline) {
        if (!controller.isRunning()) {
            selfTerminated = true;
            break;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
    const auto elapsed = std::chrono::steady_clock::now() - testStart;

    const std::string logs = controller.qemuLogs();
    controller.stop();
    std::filesystem::remove(flashPath);

    TEST_ASSERT(selfTerminated,
        "processo QEMU real se auto-terminou (shutdown controlado) dentro da janela de 20s, sem precisar ser morto pelo teste");
    TEST_ASSERT(std::chrono::duration_cast<std::chrono::milliseconds>(elapsed).count() >= 2500,
        "o auto-termino nao ocorreu suspeitosamente antes do backstop de 3s (ver se o timeout nao ficou baixo demais)");
    TEST_ASSERT(logs.find("waitForSynch TIMEOUT") != std::string::npos,
        "log do QEMU mostra o backstop de process-health disparando (fila cheia por tempo demais)");
    TEST_ASSERT(logs.find("HOST PROCESS-HEALTH BACKSTOP") != std::string::npos,
        "mensagem classifica o timeout como backstop de saude do processo host, nao timing do ESP32");

    std::fprintf(stderr, "selfTerminated=%d elapsedMs=%lld\n", selfTerminated ? 1 : 0,
                 static_cast<long long>(std::chrono::duration_cast<std::chrono::milliseconds>(elapsed).count()));

    if (failures == 0) {
        std::printf("\nTodos os testes de QemuQueueFullTimeout passaram (backstop de 3s propagou como falha terminal e desligamento controlado, sem corrupcao/hang).\n");
        return 0;
    }
    std::fprintf(stderr, "\n%d teste(s) FALHARAM. Ultimos logs QEMU:\n%s\n", failures, logs.c_str());
    return 1;
}
