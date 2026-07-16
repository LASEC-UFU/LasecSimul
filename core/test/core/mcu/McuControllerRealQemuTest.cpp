// Valida McuController contra o binário REAL do fork qemu-simulide (não fake/sintético como
// QemuProcessManagerTest/QemuArenaBridgeTest) -- ver docs/mvp-limitacoes.md. O adaptador ESP32 vem
// do plugin real (mcu_abi.h major 2+, mcu-adapters/espressif-esp32/), não built-in.
//
// Sem toolchain ESP-IDF local, usa uma imagem de flash apagada de 4 MiB. Ela nao executa uma
// aplicacao, mas e um MTD valido e permite verificar que a maquina, OpenETH e SLIRP sao
// inicializados e permanecem vivos. Por isso este teste prova que o McuController consegue:
//   1. abrir a arena de memória compartilhada do lado do Core, e
//   2. iniciar de fato o processo qemu-system-xtensa.exe REAL (CreateProcess/exec contra o binário
//      verdadeiro, não um stub do próprio teste),
// e encerrar tudo de volta sem travar nem vazar processo/handle. NÃO prova que o GPIO funciona de
// ponta a ponta -- isso exige firmware real. Pula (sai com 0) se o binário real do QEMU ou o
// adapter.dll do plugin não estiverem presentes no caminho esperado.
#include <chrono>
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

std::string uniqueArenaName() {
    return "lasecsimul-mcu-controller-test-" +
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
    std::fprintf(stderr, "=== McuControllerRealQemuTest ===\n");

    // This host-independent integration test deliberately exercises SLIRP. The product default is
    // lab-bridge, but CI cannot assume that a privileged TAP adapter has been provisioned.
#ifdef _WIN32
    _putenv_s("LASECSIMUL_NETWORK_MODE", "isolated");
#else
    setenv("LASECSIMUL_NETWORK_MODE", "isolated", 1);
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
    const std::unique_ptr<IMcuAdapter> adapter = runtime.createMcuAdapter("espressif.esp32");
    TEST_ASSERT(adapter != nullptr, "PluginRuntime cria o IMcuAdapter ESP32 a partir do plugin real");

    McuController controller(*adapter, qemuPath.string());

    const std::string arenaName = uniqueArenaName();
    std::filesystem::path flashPath;
    bool started = false;
    try {
        flashPath = createBlankFlash();
        controller.start(flashPath, arenaName);
        started = true;
    } catch (const std::exception& e) {
        std::fprintf(stderr, "FALHOU: McuController::start lançou: %s\n", e.what());
    }
    TEST_ASSERT(started, "McuController::start abre a arena e inicia o processo QEMU real sem lançar");
    TEST_ASSERT(controller.arenaBridge().isOpen(), "arena de memória compartilhada está aberta do lado do Core");

    // A flash apagada nao executa uma aplicacao, mas o QEMU deve permanecer vivo depois de criar
    // a maquina ESP32, a NIC OpenETH e o backend SLIRP.
    std::this_thread::sleep_for(std::chrono::milliseconds(500));

    std::fprintf(stderr, "  [info] isRunning() antes do stop(): %s\n", controller.isRunning() ? "true" : "false");
    std::fprintf(stderr, "  [info] qemuLogs(): %s\n", controller.qemuLogs().c_str());
    TEST_ASSERT(controller.isRunning(), "QEMU real permanece vivo com flash MTD valida e OpenETH/SLIRP inicializados");
    TEST_ASSERT(controller.qemuLogs().find("model=open_eth") != std::string::npos,
                "logs do processo integrado registram a configuracao OpenETH");

    controller.stop();
    if (!flashPath.empty()) {
        std::error_code removeError;
        std::filesystem::remove(flashPath, removeError);
    }
    TEST_ASSERT(!controller.isRunning(), "processo QEMU real não está mais rodando após stop()");
    TEST_ASSERT(!controller.arenaBridge().isOpen(), "arena foi fechada após stop()");

    if (failures == 0) {
        std::fprintf(stderr, "\nTodos os testes passaram.\n");
        return 0;
    }
    std::fprintf(stderr, "\n%d teste(s) FALHARAM.\n", failures);
    return 1;
}
