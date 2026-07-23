// Achado 2026-07-22 (usuário: LED de 500ms via millis() demora ~4s reais mesmo com a simulação "a
// 100%"): `QemuIcountCalibrator` mede a taxa real de ns-por-instrução deste host contra o binário
// QEMU real, e seta LASECSIMUL_ESP32_ICOUNT_SHIFT no ambiente do processo -- lido por
// Esp32Adapter.cpp::buildLaunchArgs no lugar do `shift=4` fixo nunca calibrado.
//
// Mesma técnica de McuControllerRealQemuTest.cpp (binário QEMU real, plugin adapter real, pula se
// qualquer um dos dois não existir) -- este teste prova especificamente o CICLO de calibração:
// primeira chamada mede e cacheia, chamadas seguintes (mesmo processo OU processo novo simulado via
// unsetenv + cache em disco) não relançam QEMU.
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <memory>
#include <string>
#include "mcu/qemu/QemuIcountCalibrator.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "plugins/PluginRuntime.hpp"

using namespace lasecsimul;

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

void setEnv(const char* name, const std::string& value) {
#ifdef _WIN32
    _putenv_s(name, value.c_str());
#else
    setenv(name, value.c_str(), 1);
#endif
}

void unsetEnv(const char* name) {
#ifdef _WIN32
    _putenv_s(name, "");
#else
    unsetenv(name);
#endif
}

std::string getEnv(const char* name) {
    const char* value = std::getenv(name);
    return value ? std::string(value) : std::string();
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

    plugins::GlobalPluginCache cache;
    std::shared_ptr<plugins::PluginModule> module = cache.loader().loadMcuPlugin(dllPath);
    cache.setActiveMcuModule("espressif.esp32", module);
    plugins::PluginRuntime runtime(cache);
    const std::unique_ptr<IMcuAdapter> adapter = runtime.createMcuAdapter("espressif.esp32");
    TEST_ASSERT(adapter != nullptr, "PluginRuntime cria o IMcuAdapter ESP32 a partir do plugin real");

    const std::filesystem::path dataDir = std::filesystem::temp_directory_path() /
        ("lasecsimul-icount-calib-test-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    std::filesystem::create_directories(dataDir);
    setEnv("LASECSIMUL_CORE_DATA_DIR", dataDir.string());
    unsetEnv("LASECSIMUL_ESP32_ICOUNT_SHIFT");

    std::string logOutput;
    auto log = [&](const std::string& line) { logOutput += line; std::fprintf(stderr, "%s", line.c_str()); };

    // --- 1. binário vazio: no-op seguro, nunca lança, nunca seta nada ---
    mcu::qemu::ensureIcountShiftCalibrated(*adapter, "", log);
    TEST_ASSERT(getEnv("LASECSIMUL_ESP32_ICOUNT_SHIFT").empty(),
        "resolvedBinaryPath vazio nao deveria setar a env var");

    // --- 2. primeira calibração real (cache miss): mede e seta a env var ---
    const auto firstStart = std::chrono::steady_clock::now();
    mcu::qemu::ensureIcountShiftCalibrated(*adapter, qemuPath.string(), log);
    const auto firstElapsed = std::chrono::steady_clock::now() - firstStart;
    const std::string firstShift = getEnv("LASECSIMUL_ESP32_ICOUNT_SHIFT");
    TEST_ASSERT(!firstShift.empty(), "primeira calibracao deveria setar LASECSIMUL_ESP32_ICOUNT_SHIFT");
    if (!firstShift.empty()) {
        const int shiftValue = std::atoi(firstShift.c_str());
        TEST_ASSERT(shiftValue >= 0 && shiftValue <= 10, "shift calibrado deveria estar em [0,10]");
    }
    TEST_ASSERT(logOutput.find("cache=miss") != std::string::npos,
        "primeira calibracao deveria logar cache=miss (mediu de verdade)");
    TEST_ASSERT(std::filesystem::exists(dataDir / "qemu-icount-calibration.json"),
        "primeira calibracao deveria gravar o cache em disco");

    // --- 3. segunda chamada NO MESMO PROCESSO: no-op (env var ja setada), nao relanca QEMU ---
    logOutput.clear();
    const auto secondStart = std::chrono::steady_clock::now();
    mcu::qemu::ensureIcountShiftCalibrated(*adapter, qemuPath.string(), log);
    const auto secondElapsed = std::chrono::steady_clock::now() - secondStart;
    TEST_ASSERT(getEnv("LASECSIMUL_ESP32_ICOUNT_SHIFT") == firstShift,
        "segunda chamada no mesmo processo nao deveria mudar o shift ja calibrado");
    TEST_ASSERT(logOutput.empty(), "segunda chamada no mesmo processo deveria ser um no-op silencioso (nao loga nada)");
    TEST_ASSERT(secondElapsed < firstElapsed,
        "segunda chamada (no-op) deveria ser bem mais rapida que a primeira (que lancou QEMU de verdade)");

    // --- 4. processo "novo" simulado (env var limpa, cache em disco preservado): cache=hit, sem relancar QEMU ---
    unsetEnv("LASECSIMUL_ESP32_ICOUNT_SHIFT");
    logOutput.clear();
    const auto thirdStart = std::chrono::steady_clock::now();
    mcu::qemu::ensureIcountShiftCalibrated(*adapter, qemuPath.string(), log);
    const auto thirdElapsed = std::chrono::steady_clock::now() - thirdStart;
    TEST_ASSERT(getEnv("LASECSIMUL_ESP32_ICOUNT_SHIFT") == firstShift,
        "cache em disco deveria reproduzir o MESMO shift calibrado antes");
    TEST_ASSERT(logOutput.find("cache=hit") != std::string::npos, "deveria logar cache=hit ao reutilizar o cache em disco");
    TEST_ASSERT(thirdElapsed < firstElapsed,
        "ler do cache em disco deveria ser bem mais rapido que medir de novo (relancando QEMU)");

    // --- 5. cache com fingerprint desatualizado (ex.: binario "trocou" de tamanho): recalibra em vez de confiar cegamente ---
    unsetEnv("LASECSIMUL_ESP32_ICOUNT_SHIFT");
    {
        std::ofstream corrupted(dataDir / "qemu-icount-calibration.json", std::ios::trunc);
        corrupted << "{\"logicVersion\":2,\"binaryPath\":\"" << qemuPath.string()
                  << "\",\"binaryMtimeUnixMs\":0,\"binarySizeBytes\":1,\"shift\":9}";
    }
    logOutput.clear();
    mcu::qemu::ensureIcountShiftCalibrated(*adapter, qemuPath.string(), log);
    TEST_ASSERT(logOutput.find("cache=miss") != std::string::npos,
        "fingerprint desatualizado (tamanho errado) deveria forcar recalibracao, nao confiar no cache");
    TEST_ASSERT(getEnv("LASECSIMUL_ESP32_ICOUNT_SHIFT") != "9",
        "nao deveria ter usado cegamente o shift=9 de um cache com fingerprint invalido");

    std::filesystem::remove_all(dataDir);
    unsetEnv("LASECSIMUL_CORE_DATA_DIR");
    unsetEnv("LASECSIMUL_ESP32_ICOUNT_SHIFT");

    if (failures == 0) {
        std::printf("\nTodos os testes de QemuIcountCalibrator passaram.\n");
        return 0;
    }
    std::fprintf(stderr, "\n%d teste(s) FALHARAM.\n", failures);
    return 1;
}
