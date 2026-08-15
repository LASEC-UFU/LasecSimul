#pragma once

#include <cassert>
#include <filesystem>
#include "lasecsimul/device_abi.h"
#include "lasecsimul/mcu_abi.h"

namespace lasecsimul::plugins {

enum class PluginKind { Device, McuAdapter };

/**
 * Código carregado de UM binário (DLL/SO) — vida útil independente de qualquer instância que o
 * use. Vive em std::shared_ptr; FreeLibrary/dlclose só acontece no destrutor, quando a última
 * referência (a última PluginInstance que aponta para este módulo) é liberada. Nunca descarregar
 * fora desse caminho — ver .spec/archive/legacy-v2/lasecsimul-native-devices.spec, seção 1 e 3 (versioned swap).
 *
 * Guarda a vtable como void* + um PluginKind porque device_abi.h e mcu_abi.h têm formas de vtable
 * diferentes; o construtor escolhido (por overload) já fixa o kind corretamente.
 */
class PluginModule {
public:
    PluginModule(void* libraryHandle, const LsdnDeviceVTable* vtable, std::filesystem::path binaryPath)
        : m_libraryHandle(libraryHandle), m_kind(PluginKind::Device), m_vtable(vtable),
          m_binaryPath(std::move(binaryPath)) {}

    PluginModule(void* libraryHandle, const LsdnMcuVTable* vtable, std::filesystem::path binaryPath)
        : m_libraryHandle(libraryHandle), m_kind(PluginKind::McuAdapter), m_vtable(vtable),
          m_binaryPath(std::move(binaryPath)) {}

    ~PluginModule();

    PluginModule(const PluginModule&) = delete;
    PluginModule& operator=(const PluginModule&) = delete;

    PluginKind kind() const { return m_kind; }

    const LsdnDeviceVTable* deviceVTable() const {
        assert(m_kind == PluginKind::Device);
        return static_cast<const LsdnDeviceVTable*>(m_vtable);
    }
    const LsdnMcuVTable* mcuVTable() const {
        assert(m_kind == PluginKind::McuAdapter);
        return static_cast<const LsdnMcuVTable*>(m_vtable);
    }

    const std::filesystem::path& binaryPath() const { return m_binaryPath; }

private:
    void* m_libraryHandle;
    PluginKind m_kind;
    const void* m_vtable;
    std::filesystem::path m_binaryPath;
};

} // namespace lasecsimul::plugins
