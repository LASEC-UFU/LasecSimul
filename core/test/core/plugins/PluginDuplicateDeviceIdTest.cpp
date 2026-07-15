// Unicidade global de device ID (ver plano de arquitetura "single source of truth per device ID"):
// GlobalPluginCache::loadLibrary deve REJEITAR (lancar) quando o MESMO typeId/chipId aparece
// declarado por dois arquivos `.lsdevice` DIFERENTES -- nunca first-wins/last-wins/overwrite
// silencioso. Recarregar o MESMO `.lsdevice` de novo (idempotente, ver
// SimulationSession::registerKnownPluginTypes/registerKnownMcuTypes, que chamam loadLibrary de novo
// a cada `loadDeviceLibrary` IPC) precisa continuar funcionando sem erro. Usa o binario REAL de
// example-blinker (mesmo padrao de PluginChecksumTest.cpp) pra provar que o registro do PRIMEIRO
// dispositivo realmente teve sucesso antes do conflito -- nao e so "o segundo load falhou por
// binario ausente".
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <nlohmann/json.hpp>
#include <string>
#include "plugins/GlobalPluginCache.hpp"

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

void writeDeviceManifest(const fs::path& manifestPath, const std::string& typeId, const fs::path& binaryPath) {
    nlohmann::json manifest{
        {"schemaVersion", 1},
        {"typeId", typeId},
        {"name", typeId},
        {"nativeEntry",
         {{"win32-x64", binaryPath.generic_string()},
          {"linux-x64", binaryPath.generic_string()},
          {"darwin-universal", binaryPath.generic_string()}}},
    };
    std::ofstream(manifestPath) << manifest.dump();
}

void writeLibraryJson(const fs::path& libraryPath, const std::vector<std::pair<std::string, std::string>>& devices) {
    nlohmann::json entries = nlohmann::json::array();
    for (const auto& [typeId, manifestFileName] : devices) {
        entries.push_back({{"typeId", typeId}, {"manifest", manifestFileName}});
    }
    nlohmann::json library{{"schemaVersion", 1}, {"devices", entries}};
    std::ofstream(libraryPath) << library.dump();
}

} // namespace

int main() {
    std::fprintf(stderr, "=== PluginDuplicateDeviceIdTest ===\n");

#ifndef EXAMPLE_BLINKER_MSVC_DLL_PATH
#error "EXAMPLE_BLINKER_MSVC_DLL_PATH precisa ser definido pelo CMakeLists"
#endif
    const fs::path dllPath = EXAMPLE_BLINKER_MSVC_DLL_PATH;
    if (!fs::exists(dllPath)) {
        std::fprintf(stderr, "PULADO: %s nao existe -- rode 'npm run build:devices' antes deste teste.\n", dllPath.string().c_str());
        return 0;
    }

    const fs::path tempDir = fs::temp_directory_path() / "lasecsimul_duplicate_device_id_test";
    fs::remove_all(tempDir);
    fs::create_directories(tempDir);

    // Caso 1: mesmo typeId, 2 arquivos .lsdevice DIFERENTES (dentro do MESMO library.json) -- deve
    // lancar, nomeando as duas definicoes.
    {
        const fs::path manifestA = tempDir / "device-a.lsdevice";
        const fs::path manifestB = tempDir / "device-b.lsdevice";
        writeDeviceManifest(manifestA, "example.blinker", dllPath);
        writeDeviceManifest(manifestB, "example.blinker", dllPath);
        const fs::path libraryPath = tempDir / "conflict-library.json";
        writeLibraryJson(libraryPath, {{"example.blinker", "device-a.lsdevice"}, {"example.blinker", "device-b.lsdevice"}});

        GlobalPluginCache cache;
        bool threw = false;
        std::string message;
        try {
            cache.loadLibrary(libraryPath);
        } catch (const std::exception& e) {
            threw = true;
            message = e.what();
        }
        CHECK(threw, "mesmo typeId em 2 arquivos .lsdevice diferentes: loadLibrary DEVE lancar");
        CHECK(message.find("Duplicate device ID: example.blinker") != std::string::npos, "mensagem deveria nomear o typeId duplicado");
        CHECK(message.find(fs::canonical(manifestA).string()) != std::string::npos, "mensagem deveria nomear a PRIMEIRA definicao (arquivo A)");
        CHECK(message.find(fs::canonical(manifestB).string()) != std::string::npos, "mensagem deveria nomear a definicao CONFLITANTE (arquivo B)");
    }

    // Caso 2: recarregar o MESMO library.json (mesmo arquivo .lsdevice) uma segunda vez -- reload
    // idempotente, nao deve lancar (mesmo comportamento que SimulationSession ja depende hoje).
    {
        const fs::path manifestPath = tempDir / "device-solo.lsdevice";
        writeDeviceManifest(manifestPath, "example.blinker.solo", dllPath);
        const fs::path libraryPath = tempDir / "solo-library.json";
        writeLibraryJson(libraryPath, {{"example.blinker.solo", "device-solo.lsdevice"}});

        GlobalPluginCache cache;
        bool threwFirst = false;
        try {
            cache.loadLibrary(libraryPath);
        } catch (const std::exception&) {
            threwFirst = true;
        }
        CHECK(!threwFirst, "primeiro load do device solo nao deveria lancar");
        CHECK(cache.activeDeviceModule("example.blinker.solo") != nullptr, "device solo deveria ficar ativo apos o primeiro load");

        bool threwSecond = false;
        try {
            cache.loadLibrary(libraryPath); // mesmo arquivo, de novo -- idempotente
        } catch (const std::exception& e) {
            threwSecond = true;
            std::fprintf(stderr, "  (excecao inesperada: %s)\n", e.what());
        }
        CHECK(!threwSecond, "recarregar o MESMO library.json/.lsdevice de novo NAO deveria lancar (reload idempotente)");
    }

    // Caso 3: 2 arquivos com dispositivos DISTINTOS -- sucesso, sem conflito.
    {
        const fs::path manifestX = tempDir / "device-x.lsdevice";
        const fs::path manifestY = tempDir / "device-y.lsdevice";
        writeDeviceManifest(manifestX, "example.blinker.x", dllPath);
        writeDeviceManifest(manifestY, "example.blinker.y", dllPath);
        const fs::path libraryPath = tempDir / "distinct-library.json";
        writeLibraryJson(libraryPath, {{"example.blinker.x", "device-x.lsdevice"}, {"example.blinker.y", "device-y.lsdevice"}});

        GlobalPluginCache cache;
        bool threw = false;
        try {
            cache.loadLibrary(libraryPath);
        } catch (const std::exception& e) {
            threw = true;
            std::fprintf(stderr, "  (excecao inesperada: %s)\n", e.what());
        }
        CHECK(!threw, "typeIds distintos, mesmo binario compartilhado: NAO e duplicacao, nao deveria lancar");
        CHECK(cache.activeDeviceModule("example.blinker.x") != nullptr, "example.blinker.x deveria ficar ativo");
        CHECK(cache.activeDeviceModule("example.blinker.y") != nullptr, "example.blinker.y deveria ficar ativo");
    }

    fs::remove_all(tempDir);

    if (failures == 0) {
        std::fprintf(stderr, "\nTodos os testes passaram.\n");
        return 0;
    }
    std::fprintf(stderr, "\n%d teste(s) FALHARAM.\n", failures);
    return 1;
}
