#pragma once

#include <cstdio>
#include <filesystem>
#include <fstream>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>
#include <unordered_map>
#include <vector>
#include "PluginLoader.hpp"
#include "PluginModule.hpp"
#include "../registry/ComponentMetadataRegistry.hpp"
#include "../registry/PropertyJson.hpp"

namespace lasecsimul::plugins {

namespace detail {

#if defined(_WIN32)
constexpr const char* kPlatformKey = "win32-x64";
#elif defined(__APPLE__)
constexpr const char* kPlatformKey = "darwin-universal";
#else
constexpr const char* kPlatformKey = "linux-x64";
#endif

/** Confere `abiVersion` declarado no manifesto contra o header compilado -- SÓ um aviso (não
 * bloqueia o load): o gate real de compatibilidade já acontece em
 * `PluginLoader::createDeviceModuleFromExports`/`createMcuModuleFromExports`, comparando o
 * `abi_major` que `lsdn_get_vtable()`/`lsdn_get_mcu_vtable()` devolve EM RUNTIME contra
 * `LSDN_ABI_VERSION_MAJOR`/`LSDN_MCU_ABI_VERSION_MAJOR` -- essa é a fonte de verdade, porque é
 * exatamente o que o binário carregado relata de si mesmo. O campo `abiVersion` do `.lsdevice` é só
 * documentação (achado de auditoria arquitetural 2026-07-09, D15: todo manifesto do repo declarava
 * major 4 enquanto o Core real estava compilado contra major 3 -- corrigido nos dados, mas sem essa
 * checagem o mesmo desvio silencioso podia voltar a acontecer sem ninguém notar). */
inline void warnIfAbiVersionMismatch(const nlohmann::json& manifest, const std::string& manifestLabel,
                                      uint32_t compiledMajor, uint32_t compiledMinor) {
    if (!manifest.contains("abiVersion") || !manifest["abiVersion"].is_object()) return;
    const nlohmann::json& declared = manifest["abiVersion"];
    const uint32_t declaredMajor = declared.value("major", compiledMajor);
    const uint32_t declaredMinor = declared.value("minor", compiledMinor);
    if (declaredMajor == compiledMajor && declaredMinor == compiledMinor) return;
    std::fprintf(stderr,
                 "[GlobalPluginCache] %s declara abiVersion %u.%u, mas o Core está compilado contra "
                 "%u.%u -- desatualizado, não bloqueante (o gate real é lsdn_get_vtable em tempo de "
                 "carregamento); atualize o manifesto.\n",
                 manifestLabel.c_str(), declaredMajor, declaredMinor, compiledMajor, compiledMinor);
}

/** `checksums` de `library.json` mapeia caminho relativo ao diretório do próprio `library.json` (não
 * ao `.lsdevice`) -> SHA-256 hex esperado. Placeholder ainda comum enquanto o build não populou o
 * hash real (`"PREENCHER_NO_BUILD_SHA256"`, ver `devices/library.json`/`mcu-adapters/library.json`)
 * ou entrada simplesmente ausente -- ambos tratados como "sem checksum declarado", que
 * `PluginLoader::verifyChecksum` já trata como opt-out silencioso; a validação de formato real
 * mora ali, aqui só repassamos o texto bruto (ou vazio) do JSON. */
inline std::string checksumFor(const nlohmann::json& checksums, const std::filesystem::path& libraryDir,
                                const std::filesystem::path& binaryPath) {
    const std::string key = std::filesystem::relative(binaryPath, libraryDir).generic_string();
    if (!checksums.is_object() || !checksums.contains(key)) return {};
    return checksums.value(key, std::string{});
}

} // namespace detail

/**
 * Estado compartilhado entre sessões (hoje só existe uma SimulationSession por processo, ver
 * .spec/lasecsimul.spec seção 4) — qual PluginModule é a versão ativa por typeId/chipId, e o
 * catálogo de metadados de UI. Nunca mutado fora de loadLibrary/setActive*Module; sessões só leem
 * activeDeviceModule/activeMcuModule ao criar uma instância nova.
 */
class GlobalPluginCache {
public:
    PluginLoader& loader() { return m_loader; }
    registry::ComponentMetadataRegistry& metadata() { return m_metadata; }

    /** Único ponto de entrada pra "biblioteca de dispositivos": lê `library.json` (`"devices"` e/ou
     * `"mcus"`), parseia cada `.lsdevice` referenciado, resolve o binário nativo da plataforma
     * atual, publica `registry::ComponentMetadata` (pra devices) e o `PluginModule` ativo por
     * typeId/chipId. Caminhos em `nativeEntry`/`manifest` são relativos ao arquivo que os declara
     * (`.lsdevice` e `library.json`, respectivamente) — mesma convenção usada por
     * `npm run build:devices`. Antes morava em duas funções quase-idênticas dentro de
     * `CoreApplication.cpp` (achado de auditoria arquitetural 2026-07-09, D16) enquanto
     * `PluginLoader::scanDirectory()` ficava como stub eternamente não-implementado — mudou pra cá
     * porque é este cache, não o loader isolado, que tem `loader()`+`metadata()`+os mapas
     * `setActive*Module` todos juntos, exatamente o que essa responsabilidade precisa. */
    void loadLibrary(const std::filesystem::path& libraryJsonPath) {
        std::ifstream libraryFile(libraryJsonPath);
        if (!libraryFile) throw std::runtime_error("library.json não encontrado: " + libraryJsonPath.string());
        nlohmann::json library;
        libraryFile >> library;
        const std::filesystem::path libraryDir = libraryJsonPath.parent_path();
        const nlohmann::json checksums = library.value("checksums", nlohmann::json::object());

        if (library.contains("devices") && library["devices"].is_array()) {
            for (const auto& deviceEntry : library["devices"]) loadDeviceEntry(deviceEntry, libraryDir, checksums);
        }
        if (library.contains("mcus") && library["mcus"].is_array()) {
            for (const auto& mcuEntry : library["mcus"]) loadMcuEntry(mcuEntry, libraryDir, checksums);
        }
    }

    /** Versioned swap (ver .spec/lasecsimul-native-devices.spec, seção 3): publica qual módulo é
     * usado por NOVAS instâncias a partir de agora. Instâncias já criadas mantêm seu próprio
     * shared_ptr para o módulo antigo — nunca são afetadas por esta chamada. */
    void setActiveDeviceModule(std::string typeId, std::shared_ptr<PluginModule> module) {
        m_deviceModules[std::move(typeId)] = std::move(module);
    }
    void setActiveMcuModule(std::string chipId, std::shared_ptr<PluginModule> module) {
        m_mcuModules[std::move(chipId)] = std::move(module);
    }

    std::shared_ptr<PluginModule> activeDeviceModule(const std::string& typeId) const {
        auto it = m_deviceModules.find(typeId);
        return it != m_deviceModules.end() ? it->second : nullptr;
    }
    std::shared_ptr<PluginModule> activeMcuModule(const std::string& chipId) const {
        auto it = m_mcuModules.find(chipId);
        return it != m_mcuModules.end() ? it->second : nullptr;
    }

    /** typeIds com PluginModule ativo — usado por SimulationSession::registerKnownPluginTypes(). */
    std::vector<std::string> knownDeviceTypeIds() const {
        std::vector<std::string> ids;
        ids.reserve(m_deviceModules.size());
        for (const auto& [typeId, module] : m_deviceModules) ids.push_back(typeId);
        return ids;
    }

    /** chipIds com PluginModule ativo — usado por SimulationSession::registerKnownMcuTypes(). */
    std::vector<std::string> knownMcuChipIds() const {
        std::vector<std::string> ids;
        ids.reserve(m_mcuModules.size());
        for (const auto& [chipId, module] : m_mcuModules) ids.push_back(chipId);
        return ids;
    }

private:
    void loadDeviceEntry(const nlohmann::json& deviceEntry, const std::filesystem::path& libraryDir,
                          const nlohmann::json& checksums) {
        const std::string typeId = deviceEntry.value("typeId", std::string{});
        const std::string manifestRelative = deviceEntry.value("manifest", std::string{});
        if (typeId.empty() || manifestRelative.empty()) return;

        const std::filesystem::path manifestPath = libraryDir / manifestRelative;
        std::ifstream manifestFile(manifestPath);
        if (!manifestFile) throw std::runtime_error("manifesto de dispositivo (.lsdevice) não encontrado: " + manifestPath.string());
        nlohmann::json device;
        manifestFile >> device;
        detail::warnIfAbiVersionMismatch(device, manifestPath.string(), LSDN_ABI_VERSION_MAJOR, LSDN_ABI_VERSION_MINOR);

        if (!device.contains("nativeEntry") || !device["nativeEntry"].contains(detail::kPlatformKey)) {
            throw std::runtime_error("manifesto de dispositivo sem nativeEntry para a plataforma atual ('" +
                                      std::string(detail::kPlatformKey) + "'): " + manifestPath.string());
        }
        const std::filesystem::path binaryPath =
            manifestPath.parent_path() / device["nativeEntry"][detail::kPlatformKey].get<std::string>();

        registry::ComponentMetadata metadata;
        metadata.typeId = typeId;
        metadata.displayName = device.value("name", typeId);
        metadata.propertySchema = registry::parsePropertySchemaList(device);
        metadata.readoutFormat = registry::parseReadoutFormat(device);
        metadata.interactionKind = registry::parseInteractionKind(device);
        metadata.pinSpec = registry::parsePinSpec(device);
        // language é obrigatório por contrato (RNF12 de lasecsimul.spec), mas manifesto anterior a
        // esta rodada não declara -- default "pt-BR" preserva compatibilidade (todo manifesto existente
        // até aqui foi de fato escrito em português, então o default não está mentindo).
        metadata.language = device.value("language", std::string{"pt-BR"});
        if (device.contains("translations")) metadata.translationsJson = device["translations"].dump();
        if (device.contains("limits") && device["limits"].is_object()) {
            metadata.stepTimeoutMs = device["limits"].value("stepTimeoutMs", 0u);
        }
        if (device.contains("pins") && device["pins"].is_array()) {
            for (const auto& pinJson : device["pins"]) {
                Pin pin;
                pin.id = pinJson.value("id", std::string{});
                pin.x = pinJson.value("x", 0.0);
                pin.y = pinJson.value("y", 0.0);
                metadata.pins.push_back(std::move(pin));
            }
        }
        m_metadata.registerMetadata(std::move(metadata));

        const std::string expectedSha256Hex = detail::checksumFor(checksums, libraryDir, binaryPath);
        std::shared_ptr<PluginModule> module = m_loader.loadDevicePlugin(binaryPath, expectedSha256Hex);
        setActiveDeviceModule(typeId, module);
    }

    /** Mesmo padrão de `loadDeviceEntry`, para a chave `"mcus"` de `library.json` (adaptador de MCU
     * via plugin nativo, ver `mcu_abi.h`). Cada entrada `{chipId, manifest}` aponta pra um
     * `.lsdevice` cujo `nativeEntry[plataforma]` é resolvido e carregado via
     * `PluginLoader::loadMcuPlugin`. Sem `registry::ComponentMetadata` aqui -- MCU não passa pelo
     * catálogo de propriedades editáveis genérico (ver `.spec/lasecsimul-native-devices.spec`
     * seção 22 e a auditoria arquitetural 2026-07-09, seção 10 do relatório: `McuComponent` não
     * expõe `propertyDescriptors()` hoje). */
    void loadMcuEntry(const nlohmann::json& mcuEntry, const std::filesystem::path& libraryDir,
                       const nlohmann::json& checksums) {
        const std::string chipId = mcuEntry.value("chipId", std::string{});
        const std::string manifestRelative = mcuEntry.value("manifest", std::string{});
        if (chipId.empty() || manifestRelative.empty()) return;

        const std::filesystem::path manifestPath = libraryDir / manifestRelative;
        std::ifstream manifestFile(manifestPath);
        if (!manifestFile) throw std::runtime_error("manifesto de MCU (.lsdevice) não encontrado: " + manifestPath.string());
        nlohmann::json mcu;
        manifestFile >> mcu;
        detail::warnIfAbiVersionMismatch(mcu, manifestPath.string(), LSDN_MCU_ABI_VERSION_MAJOR, LSDN_MCU_ABI_VERSION_MINOR);

        if (!mcu.contains("nativeEntry") || !mcu["nativeEntry"].contains(detail::kPlatformKey)) {
            throw std::runtime_error("manifesto de MCU sem nativeEntry para a plataforma atual ('" +
                                      std::string(detail::kPlatformKey) + "'): " + manifestPath.string());
        }
        const std::filesystem::path binaryPath =
            manifestPath.parent_path() / mcu["nativeEntry"][detail::kPlatformKey].get<std::string>();

        std::shared_ptr<PluginModule> module = m_loader.loadMcuPlugin(binaryPath);
        setActiveMcuModule(chipId, module);
    }

    PluginLoader m_loader;
    registry::ComponentMetadataRegistry m_metadata;
    std::unordered_map<std::string, std::shared_ptr<PluginModule>> m_deviceModules;
    std::unordered_map<std::string, std::shared_ptr<PluginModule>> m_mcuModules;
};

} // namespace lasecsimul::plugins
