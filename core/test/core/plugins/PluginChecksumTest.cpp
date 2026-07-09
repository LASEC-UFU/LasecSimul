// Prova, contra binários REAIS (não sintéticos), que a verificação de checksum implementada em
// PluginLoader::verifyChecksum (achado de auditoria arquitetural 2026-07-09) de fato aceita hash
// correto, rejeita hash errado, e que o fio completo GlobalPluginCache::loadLibrary ->
// checksumFor -> PluginLoader::loadDevicePlugin/loadMcuPlugin funciona ponta a ponta contra
// devices/library.json e mcu-adapters/library.json de verdade -- nenhum teste existente
// (plugin_loader_real_dll_test, esp32_adapter_test etc.) chama loadLibrary() nem passa um hash
// esperado, então essa cobertura não existia antes deste arquivo. Mesmo padrão de "pula se o
// artefato não foi compilado ainda" de PluginLoaderRealDllTest.cpp (devices/example-blinker e
// mcu-adapters/espressif-esp32 são projetos CMake separados do Core, ver 'npm run build:devices').
#include <algorithm>
#include <cctype>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <nlohmann/json.hpp>
#include <string>
#include "lasecsimul/Sha256.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "plugins/PluginLoader.hpp"

using namespace lasecsimul;
using namespace lasecsimul::plugins;
namespace fs = std::filesystem;

namespace {

int failures = 0;
#define CHECK(cond, msg) \
    do { \
        if (!(cond)) { \
            std::fprintf(stderr, "  FALHOU: %s\n", msg); \
            failures++; \
        } else { \
            std::fprintf(stderr, "  OK: %s\n", msg); \
        } \
    } while (false)

bool throwsOnLoadDevice(PluginLoader& loader, const fs::path& path, const std::string& hash) {
    try {
        loader.loadDevicePlugin(path, hash);
        return false;
    } catch (const std::exception&) {
        return true;
    }
}

} // namespace

int main() {
    std::fprintf(stderr, "=== PluginChecksumTest ===\n");

#ifndef EXAMPLE_BLINKER_MSVC_DLL_PATH
#error "EXAMPLE_BLINKER_MSVC_DLL_PATH precisa ser definido pelo CMakeLists"
#endif
    const fs::path dllPath = EXAMPLE_BLINKER_MSVC_DLL_PATH;
    if (!fs::exists(dllPath)) {
        std::fprintf(stderr,
                      "PULADO: %s não existe -- rode 'npm run build:devices' antes deste teste.\n",
                      dllPath.string().c_str());
        return 0;
    }

    const std::string realHash = Sha256::hashFile(dllPath);
    CHECK(realHash.size() == 64, "hash real do binario example-blinker tem 64 hex chars");

    {
        PluginLoader loader;
        CHECK(!throwsOnLoadDevice(loader, dllPath, realHash), "hash correto: loadDevicePlugin nao lanca");
    }
    {
        PluginLoader loader;
        std::string wrongHash = realHash;
        wrongHash[0] = (wrongHash[0] == '0') ? '1' : '0'; // adultera 1 char -- ainda 64 hex chars validos
        CHECK(throwsOnLoadDevice(loader, dllPath, wrongHash), "hash errado (64 hex chars): loadDevicePlugin REJEITA");
    }
    {
        PluginLoader loader;
        CHECK(!throwsOnLoadDevice(loader, dllPath, ""), "sem hash declarado (string vazia): pula checagem, nao lanca");
    }
    {
        PluginLoader loader;
        CHECK(!throwsOnLoadDevice(loader, dllPath, "PREENCHER_NO_BUILD_SHA256"),
              "placeholder nao-hex: tratado como ausente, nao lanca");
    }
    {
        PluginLoader loader;
        std::string upperHash = realHash;
        std::transform(upperHash.begin(), upperHash.end(), upperHash.begin(),
                        [](unsigned char c) { return static_cast<char>(std::toupper(c)); });
        CHECK(!throwsOnLoadDevice(loader, dllPath, upperHash), "comparacao de hash e case-insensitive (hash em maiusculas aceito)");
    }

    // Fio completo: devices/library.json de producao, tal como CoreApplication.cpp chama no verbo
    // IPC "loadDeviceLibrary" -- prova que a chave relativa computada por detail::checksumFor bate
    // com a chave gravada de verdade em devices/library.json.
    {
        GlobalPluginCache cache;
        bool threw = false;
        try {
            cache.loadLibrary(fs::path(REAL_DEVICES_LIBRARY_JSON_PATH));
        } catch (const std::exception& e) {
            threw = true;
            std::fprintf(stderr, "  (excecao: %s)\n", e.what());
        }
        CHECK(!threw, "GlobalPluginCache::loadLibrary(devices/library.json real) nao lanca");
        CHECK(cache.activeDeviceModule("example.blinker") != nullptr, "example.blinker fica ativo apos loadLibrary real");
    }

#ifdef ESP32_ADAPTER_MSVC_DLL_PATH
    if (fs::exists(fs::path(ESP32_ADAPTER_MSVC_DLL_PATH))) {
        GlobalPluginCache cache;
        bool threw = false;
        try {
            cache.loadLibrary(fs::path(REAL_MCU_LIBRARY_JSON_PATH));
        } catch (const std::exception& e) {
            threw = true;
            std::fprintf(stderr, "  (excecao: %s)\n", e.what());
        }
        CHECK(!threw, "GlobalPluginCache::loadLibrary(mcu-adapters/library.json real) nao lanca");
        CHECK(cache.activeMcuModule("espressif.esp32") != nullptr, "espressif.esp32 fica ativo apos loadLibrary real");
    } else {
        std::fprintf(stderr, "PULADO (adapter ESP32 ausente): checagem de mcu-adapters/library.json real.\n");
    }
#endif

    // library.json sintetico apontando (via nativeEntry absoluto) pro MESMO binario real, com um
    // checksum deliberadamente errado -- prova que loadLibrary propaga a rejeicao de
    // verifyChecksum atraves de checksumFor + loadDeviceEntry, nao só a chamada direta acima.
    {
        const fs::path tempDir = fs::temp_directory_path() / "lasecsimul_checksum_test";
        fs::create_directories(tempDir);
        const fs::path manifestPath = tempDir / "blinker.lsdevice";
        const fs::path libraryPath = tempDir / "library.json";
        const std::string dllAbsolute = dllPath.generic_string();

        nlohmann::json manifest{
            {"schemaVersion", 1},
            {"typeId", "example.blinker"},
            {"name", "Blinker (checksum test)"},
            {"nativeEntry",
             {{"win32-x64", dllAbsolute}, {"linux-x64", dllAbsolute}, {"darwin-universal", dllAbsolute}}},
        };
        std::ofstream(manifestPath) << manifest.dump();

        const std::string key = fs::relative(dllPath, tempDir).generic_string();

        nlohmann::json library{
            {"schemaVersion", 1},
            {"devices", nlohmann::json::array({{{"typeId", "example.blinker"}, {"manifest", "blinker.lsdevice"}}})},
            {"checksums", {{key, realHash}}},
        };
        std::ofstream(libraryPath) << library.dump();
        {
            GlobalPluginCache cache;
            bool threw = false;
            try {
                cache.loadLibrary(libraryPath);
            } catch (const std::exception&) {
                threw = true;
            }
            CHECK(!threw, "library.json sintetico com hash correto (via checksumFor real): carrega");
        }

        library["checksums"][key] = std::string(64, 'f');
        std::ofstream(libraryPath) << library.dump();
        {
            GlobalPluginCache cache;
            bool threw = false;
            try {
                cache.loadLibrary(libraryPath);
            } catch (const std::exception& e) {
                threw = true;
                std::fprintf(stderr, "  (excecao esperada: %s)\n", e.what());
            }
            CHECK(threw, "library.json sintetico com hash errado (via checksumFor real): REJEITA o load");
        }

        fs::remove_all(tempDir);
    }

    if (failures == 0) {
        std::fprintf(stderr, "\nTodos os testes passaram.\n");
        return 0;
    }
    std::fprintf(stderr, "\n%d teste(s) FALHARAM.\n", failures);
    return 1;
}
