#include "PluginLoader.hpp"
#include <algorithm>
#include <cctype>
#include <stdexcept>
#include "lasecsimul/Sha256.hpp"

#if defined(_WIN32)
#include <windows.h>
#else
#include <dlfcn.h>
#endif

namespace lasecsimul::plugins {

namespace {

#if defined(_WIN32)
void* loadNativeLibrary(const std::filesystem::path& path) { return LoadLibraryW(path.wstring().c_str()); }
void* resolveSymbol(void* handle, const char* name) { return reinterpret_cast<void*>(GetProcAddress(static_cast<HMODULE>(handle), name)); }
#else
void* loadNativeLibrary(const std::filesystem::path& path) { return dlopen(path.c_str(), RTLD_NOW | RTLD_LOCAL); }
void* resolveSymbol(void* handle, const char* name) { return dlsym(handle, name); }
#endif

bool looksLikeSha256Hex(const std::string& value) {
    if (value.size() != 64) return false;
    return std::all_of(value.begin(), value.end(), [](unsigned char c) { return std::isxdigit(c) != 0; });
}

// `expectedSha256Hex` vazio ou que não parece um SHA-256 de verdade (ex: o placeholder literal
// "PREENCHER_NO_BUILD_SHA256" que ainda sobra em alguns library.json não populados -- ver achado
// de auditoria arquitetural 2026-07-09) pula a checagem em silêncio: checksum é opt-in, ausência
// não é erro. Só quando um hash de 64 hex chars foi de fato declarado é que a comparação vira
// obrigatória -- essa é a "defesa em profundidade" real (.spec/lasecsimul-native-devices.spec,
// seção 12 item 1), não confiando cegamente na decisão de confiança que a Extension já tomou.
bool verifyChecksum(const std::filesystem::path& binaryPath, const std::string& expectedSha256Hex) {
    if (!looksLikeSha256Hex(expectedSha256Hex)) return true;
    const std::string actual = lasecsimul::Sha256::hashFile(binaryPath);
    if (actual.empty()) return false; // arquivo não abriu -- LoadLibrary/dlopen vai falhar de qualquer forma
    return std::equal(actual.begin(), actual.end(), expectedSha256Hex.begin(), expectedSha256Hex.end(),
                       [](char a, char b) { return std::tolower(static_cast<unsigned char>(a)) ==
                                                    std::tolower(static_cast<unsigned char>(b)); });
}

} // namespace

std::shared_ptr<PluginModule> PluginLoader::createDeviceModuleFromExports(
    void* libraryHandle, LsdnGetVTableFn getVTable, const std::filesystem::path& binaryPath) {
    if (!getVTable) {
        throw std::runtime_error("Plugin nao exporta lsdn_get_vtable: " + binaryPath.string());
    }

    // Só major importa: minor é sempre aditivo/sem reordenar campo existente (quando não é,
    // bumpamos major mesmo) -- não há plugin de terceiro rodando contra um Core mais velho aqui,
    // todo device deste repo é recompilado junto a cada mudança de ABI (ver npm run build:devices).
    // Checar minor exato só travaria builds legítimos por atrito, sem ganho real de segurança.
    uint32_t abiMajor = 0;
    uint32_t abiMinor = 0;
    const LsdnDeviceVTable* vtable = getVTable(&abiMajor, &abiMinor);
    if (!vtable || abiMajor != LSDN_ABI_VERSION_MAJOR) {
        throw std::runtime_error("ABI incompativel em: " + binaryPath.string());
    }

    return std::make_shared<PluginModule>(libraryHandle, vtable, binaryPath);
}

std::shared_ptr<PluginModule> PluginLoader::createMcuModuleFromExports(
    void* libraryHandle, LsdnGetMcuVTableFn getVTable, const std::filesystem::path& binaryPath) {
    if (!getVTable) {
        throw std::runtime_error("Plugin nao exporta lsdn_get_mcu_vtable: " + binaryPath.string());
    }

    uint32_t abiMajor = 0;
    uint32_t abiMinor = 0;
    const LsdnMcuVTable* vtable = getVTable(&abiMajor, &abiMinor);
    if (!vtable || abiMajor != LSDN_MCU_ABI_VERSION_MAJOR) {
        throw std::runtime_error("ABI incompativel em: " + binaryPath.string());
    }

    return std::make_shared<PluginModule>(libraryHandle, vtable, binaryPath);
}

void PluginLoader::scanDirectory(const std::filesystem::path& libraryJsonPath) {
    // Estrutura inicial: parsing real de library.json fica para a implementacao completa. Para
    // cada device/mcu declarado, chama loadDevicePlugin/loadMcuPlugin e publica o resultado no
    // GlobalPluginCache (setActiveDeviceModule/setActiveMcuModule) — isso e' responsabilidade de
    // quem chama scanDirectory (GlobalPluginCache), nao do loader.
    (void)libraryJsonPath;
}

std::shared_ptr<PluginModule> PluginLoader::loadDevicePlugin(const std::filesystem::path& binaryPath,
                                                               const std::string& expectedSha256Hex) {
    if (!verifyChecksum(binaryPath, expectedSha256Hex)) {
        throw std::runtime_error("Checksum nao corresponde ao manifesto: " + binaryPath.string());
    }

    void* handle = loadNativeLibrary(binaryPath);
    if (!handle) {
        throw std::runtime_error("Falha ao carregar plugin: " + binaryPath.string());
    }

    auto getVTable = reinterpret_cast<LsdnGetVTableFn>(resolveSymbol(handle, "lsdn_get_vtable"));
    return createDeviceModuleFromExports(handle, getVTable, binaryPath);
}

std::shared_ptr<PluginModule> PluginLoader::loadMcuPlugin(const std::filesystem::path& binaryPath,
                                                            const std::string& expectedSha256Hex) {
    if (!verifyChecksum(binaryPath, expectedSha256Hex)) {
        throw std::runtime_error("Checksum nao corresponde ao manifesto: " + binaryPath.string());
    }

    void* handle = loadNativeLibrary(binaryPath);
    if (!handle) {
        throw std::runtime_error("Falha ao carregar plugin: " + binaryPath.string());
    }

    auto getVTable = reinterpret_cast<LsdnGetMcuVTableFn>(resolveSymbol(handle, "lsdn_get_mcu_vtable"));
    return createMcuModuleFromExports(handle, getVTable, binaryPath);
}

} // namespace lasecsimul::plugins
