// Lacuna real de cobertura encontrada na revisão arquitetural de 2026-07-20
// (docs/33-plano-revisao-arquitetural-core.md, seção 9.2): nenhum teste da suíte inteira sobe 2+
// McuController/processos QEMU reais simultaneamente -- McuControllerRealQemuTest usa exatamente UMA
// instância, QemuProcessManagerTest usa processos fake sequenciais. Sem isso não há como caracterizar
// (linha de base) nem depois validar (regressão) colisão de nome de arena, isolamento de rede por
// instância, nem overhead agregado com múltiplas MCUs -- pré-requisito explícito antes de
// PERF-12 (thread dedicada por MCU) nesta mesma revisão.
//
// Mesmo cuidado de McuControllerRealQemuTest: sem toolchain ESP-IDF local, usa flash apagada de
// 4 MiB (MTD válido, sem aplicação real) -- prova que os DOIS processos QEMU reais sobem e continuam
// vivos ao mesmo tempo, não que GPIO funciona ponta-a-ponta (isso já é coberto, com 1 MCU, por
// mcu_blink_long_run quando um firmware real é fornecido). Pula (sai com 0) se o binário real do QEMU
// ou o adapter.dll do plugin não estiverem presentes no caminho esperado.
#include <chrono>
#include <cstdlib>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <memory>
#include <stdexcept>
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

std::string uniqueArenaName(const char* suffix) {
    return "lasecsimul-mcu-multi-test-" + std::string(suffix) + "-" +
           std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
}

std::filesystem::path createBlankFlash(const char* suffix) {
    const std::filesystem::path path =
        std::filesystem::temp_directory_path() / (uniqueArenaName(suffix) + "-flash.bin");
    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    const std::vector<char> erasedBlock(64 * 1024, static_cast<char>(0xFF));
    for (int i = 0; i < 64; ++i) out.write(erasedBlock.data(), erasedBlock.size());
    if (!out) throw std::runtime_error("nao foi possivel criar flash vazia de teste");
    return path;
}

// Mesma disciplina de poll-com-timeout de McuControllerRealQemuTest -- corrida real contra um
// processo externo, não uma constante de sleep fixa (achado de CI 2026-07-18 do teste irmão).
bool waitForLogSubstring(const McuController& controller, const std::string& substring,
                          std::chrono::milliseconds timeout = std::chrono::seconds(5)) {
    const auto deadline = std::chrono::steady_clock::now() + timeout;
    do {
        if (controller.qemuLogs().find(substring) != std::string::npos) return true;
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    } while (std::chrono::steady_clock::now() < deadline);
    return controller.qemuLogs().find(substring) != std::string::npos;
}

} // namespace

int main() {
    std::fprintf(stderr, "=== McuMultipleControllersRealQemuTest ===\n");

#ifdef _WIN32
    _putenv_s("LASECSIMUL_NETWORK_MODE", "disabled");
#else
    setenv("LASECSIMUL_NETWORK_MODE", "disabled", 1);
#endif

#ifndef QEMU_REAL_BINARY_PATH
#error "QEMU_REAL_BINARY_PATH precisa ser definido pelo CMakeLists (caminho do qemu-system-xtensa.exe real)"
#endif
#ifndef ESP32_ADAPTER_DLL_PATH
#error "ESP32_ADAPTER_DLL_PATH precisa ser definido pelo CMakeLists (caminho do adapter.dll real)"
#endif
    const std::filesystem::path qemuPath = QEMU_REAL_BINARY_PATH;
    const std::filesystem::path dllPath = ESP32_ADAPTER_DLL_PATH;

    if (!std::filesystem::exists(qemuPath)) {
        std::fprintf(stderr,
                      "PULADO: %s não existe -- este teste exige o fork qemu-simulide compilado "
                      "localmente (ver docs/mvp-limitacoes.md).\n",
                      qemuPath.string().c_str());
        return 0;
    }
    if (!std::filesystem::exists(dllPath)) {
        std::fprintf(stderr,
                      "PULADO: %s não existe -- rode 'npm run build:mcu-adapters' antes deste teste.\n",
                      dllPath.string().c_str());
        return 0;
    }

    plugins::GlobalPluginCache cache;
    std::shared_ptr<plugins::PluginModule> module = cache.loader().loadMcuPlugin(dllPath);
    cache.setActiveMcuModule("espressif.esp32", module);
    plugins::PluginRuntime runtime(cache);

    // Duas instâncias de adaptador INDEPENDENTES -- cada McuController precisa da sua própria (o
    // mesmo padrão que SimulationSession usa pra cada McuComponent real num projeto com 2+ MCUs), não
    // uma reaproveitada entre os dois controllers.
    const std::unique_ptr<IMcuAdapter> adapterA = runtime.createMcuAdapter("espressif.esp32");
    const std::unique_ptr<IMcuAdapter> adapterB = runtime.createMcuAdapter("espressif.esp32");
    TEST_ASSERT(adapterA != nullptr && adapterB != nullptr, "duas instâncias independentes de IMcuAdapter criadas");

    McuController controllerA(*adapterA, qemuPath.string());
    McuController controllerB(*adapterB, qemuPath.string());

    const std::string arenaA = uniqueArenaName("a");
    const std::string arenaB = uniqueArenaName("b");
    TEST_ASSERT(arenaA != arenaB, "nomes de arena gerados para as duas instâncias são distintos");

    const std::filesystem::path flashA = createBlankFlash("a");
    const std::filesystem::path flashB = createBlankFlash("b");

    bool startedA = false, startedB = false;
    try {
        controllerA.start(flashA, arenaA);
        startedA = true;
    } catch (const std::exception& e) {
        std::fprintf(stderr, "FALHOU: McuController A start lançou: %s\n", e.what());
    }
    try {
        controllerB.start(flashB, arenaB);
        startedB = true;
    } catch (const std::exception& e) {
        std::fprintf(stderr, "FALHOU: McuController B start lançou: %s\n", e.what());
    }
    TEST_ASSERT(startedA, "primeiro McuController abre arena e inicia processo QEMU real sem lançar");
    TEST_ASSERT(startedB, "segundo McuController abre arena e inicia processo QEMU real sem lançar, com o primeiro ainda ativo");
    TEST_ASSERT(controllerA.arenaBridge().isOpen() && controllerB.arenaBridge().isOpen(),
                "as duas arenas de memória compartilhada estão abertas simultaneamente, sem colisão");

    std::this_thread::sleep_for(std::chrono::milliseconds(500));

    // O ponto central deste teste: as DUAS instâncias precisam estar vivas AO MESMO TEMPO, não uma
    // depois da outra -- prova que arenas/processos independentes realmente coexistem sem interferir.
    const bool aliveA = controllerA.isRunning();
    const bool aliveB = controllerB.isRunning();
    std::fprintf(stderr, "  [info] isRunning() A=%s B=%s (simultaneamente)\n", aliveA ? "true" : "false", aliveB ? "true" : "false");
    TEST_ASSERT(aliveA && aliveB, "os dois processos QEMU reais permanecem vivos ao mesmo tempo");

    const bool sawArenaA = waitForLogSubstring(controllerA, "arena mapped");
    const bool sawArenaB = waitForLogSubstring(controllerB, "arena mapped");
    TEST_ASSERT(sawArenaA && sawArenaB, "os dois processos confirmam nos próprios logs ter mapeado sua arena");

    // Parar A não pode afetar B -- cada McuController/QemuProcessManager é dono só do seu próprio
    // processo e arena.
    controllerA.stop();
    TEST_ASSERT(!controllerA.isRunning(), "McuController A encerra independentemente");
    TEST_ASSERT(controllerB.isRunning(), "McuController B continua rodando, intocado pelo stop() de A");
    TEST_ASSERT(!controllerA.arenaBridge().isOpen(), "arena A fechada após stop()");
    TEST_ASSERT(controllerB.arenaBridge().isOpen(), "arena B continua aberta, intocada pelo stop() de A");

    controllerB.stop();
    TEST_ASSERT(!controllerB.isRunning(), "McuController B encerra independentemente");
    TEST_ASSERT(!controllerB.arenaBridge().isOpen(), "arena B fechada após stop()");

    std::error_code removeError;
    std::filesystem::remove(flashA, removeError);
    std::filesystem::remove(flashB, removeError);

    if (failures == 0) {
        std::fprintf(stderr, "\nTodos os testes passaram.\n");
        return 0;
    }
    std::fprintf(stderr, "\n%d teste(s) FALHARAM.\n", failures);
    return 1;
}
