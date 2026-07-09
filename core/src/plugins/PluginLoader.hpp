#pragma once

#include <filesystem>
#include <memory>
#include <string>
#include "PluginModule.hpp"

namespace lasecsimul::plugins {

/**
 * Descobre bibliotecas (library.json), valida manifesto e ABI de cada binário nativo, carrega
 * (LoadLibrary/dlopen) e devolve um PluginModule. NÃO cria instância, NÃO registra factory em
 * ComponentRegistry/McuRegistry — isso é responsabilidade de PluginRuntime (por sessão), a partir
 * do módulo que GlobalPluginCache publica como ativo. Decisão de confiança (TrustStore) acontece
 * inteiramente na Extension, antes do IPC pedir este load — ver
 * .spec/lasecsimul-native-devices.spec, seção 1, 3 e 12.
 */
class PluginLoader {
public:
    /** Varre um diretório de biblioteca (contendo library.json) e carrega cada binário declarado. */
    void scanDirectory(const std::filesystem::path& libraryJsonPath);

    /** Helpers de validação puros, usados por loadDevicePlugin/loadMcuPlugin e por testes. */
    static std::shared_ptr<PluginModule> createDeviceModuleFromExports(
        void* libraryHandle, LsdnGetVTableFn getVTable, const std::filesystem::path& binaryPath);
    static std::shared_ptr<PluginModule> createMcuModuleFromExports(
        void* libraryHandle, LsdnGetMcuVTableFn getVTable, const std::filesystem::path& binaryPath);

    /** Carrega um único binário de dispositivo; se `expectedSha256Hex` não for vazio, recalcula o
     * SHA-256 do arquivo e confere contra ele ANTES de LoadLibrary/dlopen (defesa em profundidade
     * -- não confia cegamente na Extension, que já fez sua própria decisão de confiança via
     * TrustStore antes de pedir este load pelo IPC). String vazia (default, ou quando
     * `library.json` não declara checksum pra este binário -- estado ainda comum, ver
     * .spec/lasecsimul-native-devices.spec seção 12) pula a checagem sem erro: o checksum é
     * opt-in, não uma trava obrigatória em todo binário. Lança `std::runtime_error` só quando um
     * hash FOI declarado e não bate. */
    std::shared_ptr<PluginModule> loadDevicePlugin(const std::filesystem::path& binaryPath,
                                                    const std::string& expectedSha256Hex = {});

    /** Carrega um único binário de adaptador de MCU (lsdn_get_mcu_vtable, ver mcu_abi.h). Mesma
     * semântica de `expectedSha256Hex` de `loadDevicePlugin`. */
    std::shared_ptr<PluginModule> loadMcuPlugin(const std::filesystem::path& binaryPath,
                                                 const std::string& expectedSha256Hex = {});
};

} // namespace lasecsimul::plugins
