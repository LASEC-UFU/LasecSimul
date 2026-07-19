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

/** Bug real de CI corrigido 2026-07-18: o processo QEMU real imprime seu próprio banner de
 * inicializacao (linha de comando completa, incluindo "-nic ...model=open_eth...") no stdout, lido
 * de forma assíncrona por uma thread de pipe dentro de QemuProcessManager -- um `sleep_for(500ms)`
 * fixo seguido de UMA checagem é suficiente na maioria das máquinas de desenvolvimento (passava
 * sempre localmente no Windows), mas falha de forma intermitente em runners de CI mais lentos/
 * compartilhados (GitHub Actions Linux) onde o banner ainda não tinha sido lido/anexado aos logs
 * naquele instante -- não é uma regressão de texto/wording, é uma corrida contra um processo
 * externo real. Poll com timeout generoso é robusto nos dois ambientes sem esconder uma regressão
 * de verdade (ainda falha se o texto nunca aparecer dentro do prazo). */
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
    std::fprintf(stderr, "=== McuControllerRealQemuTest ===\n");

    // This test deliberately exercises the enabled/SLIRP path. Separate launch tests assert that
    // the product default is disabled and contains no -nic.
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
    bool ownsFlashPath = false;
    bool started = false;
    try {
        const char* configuredFirmware = std::getenv("LASECSIMUL_TEST_FIRMWARE");
        if (configuredFirmware && *configuredFirmware) {
            flashPath = std::filesystem::u8path(configuredFirmware);
            if (!std::filesystem::exists(flashPath))
                throw std::runtime_error("LASECSIMUL_TEST_FIRMWARE nao existe");
        } else {
            flashPath = createBlankFlash();
            ownsFlashPath = true;
        }
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
    const bool sawOpenEthNic = waitForLogSubstring(controller, "model=open_eth");
    std::fprintf(stderr, "  [info] qemuLogs(): %s\n", controller.qemuLogs().c_str());
    TEST_ASSERT(controller.isRunning(), "QEMU real permanece vivo com flash MTD valida e OpenETH/SLIRP inicializados");
    TEST_ASSERT(sawOpenEthNic, "logs do processo integrado registram a configuracao OpenETH");

    controller.stop();
    TEST_ASSERT(!controller.isRunning(), "primeiro processo QEMU encerra apos stop()");

    // Backend externo indisponivel nao pode derrubar a CPU: a porta abaixo nao tem listener neste
    // teste, entao o Core troca socket/TAP por SLIRP antes de qemu_init().
#ifdef _WIN32
    _putenv_s("LASECSIMUL_NETWORK_MODE", "lab-bridge");
    _putenv_s("LASECSIMUL_GATEWAY_PORT", "65534");
#else
    setenv("LASECSIMUL_NETWORK_MODE", "lab-bridge", 1);
    setenv("LASECSIMUL_GATEWAY_PORT", "65534", 1);
#endif
    bool fallbackStarted = false;
    try {
        controller.start(flashPath, uniqueArenaName());
        fallbackStarted = true;
    } catch (const std::exception& e) {
        std::fprintf(stderr, "FALHOU: fallback de gateway lancou: %s\n", e.what());
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(500));
    const bool sawFallbackWarning = waitForLogSubstring(controller, "gateway unavailable; falling back to isolated SLIRP");
    const bool sawFallbackOpenEthNic = waitForLogSubstring(controller, "user,model=open_eth");
    TEST_ASSERT(fallbackStarted && controller.isRunning(),
                "QEMU continua executando quando gateway/TAP esta indisponivel");
    TEST_ASSERT(sawFallbackWarning, "log explica claramente o fallback de backend indisponivel");
    TEST_ASSERT(sawFallbackOpenEthNic, "fallback preserva a NIC OpenETH usando SLIRP");
    controller.stop();
    if (ownsFlashPath && !flashPath.empty()) {
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
