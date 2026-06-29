#pragma once

#include <memory>
#include <span>
#include <string>
#include <vector>
#include "PluginModule.hpp"
#include "lasecsimul/IMcuAdapter.hpp"

namespace lasecsimul::plugins {

/**
 * Proxy de adaptador de MCU nativo: mantém o PluginModule carregado e traduz a vtable C da ABI
 * para IMcuAdapter, que é o contrato interno do Core.
 */
class NativeMcuAdapterProxy final : public IMcuAdapter {
public:
    NativeMcuAdapterProxy(std::shared_ptr<PluginModule> module, LsdnMcuAdapter* handle, std::string chipId);
    ~NativeMcuAdapterProxy() override;

    const char* chipId() const override { return m_chipId.c_str(); }
    QemuLaunchSpec buildLaunchArgs(std::string_view firmwarePath) const override;
    std::span<const MemoryRegion> memoryRegions() const override { return m_memoryRegions; }
    std::span<const PinMapping> pinMap() const override { return m_pinMappings; }

    /** Chama `LsdnMcuVTable::create_modules` (major 2+) e envolve cada `LsdnQemuModuleHandle`
     * devolvido num `QemuModuleProxy` -- mesmo papel que um adaptador built-in faz devolvendo
     * `QemuModule`s C++ direto. `memStart`/`memEnd` de cada módulo vêm de `m_memoryRegions` (já
     * resolvidos no construtor via `get_memory_regions`), casando por `moduleKind`/`moduleIndex`.
     * Plugin compilado contra uma ABI sem `create_modules` (ou que devolve 0 módulos) resulta em
     * vetor vazio -- mesmo comportamento de antes da major 2 (pino sempre flutuante). */
    std::vector<std::unique_ptr<QemuModule>> createModules() const override;

private:
    static MemoryRegion toCoreRegion(const LsdnMemoryRegion& region);
    static PinMapping toCorePinMapping(const LsdnPinMapping& mapping);

    std::shared_ptr<PluginModule> m_module;
    LsdnMcuAdapter* m_handle;
    std::string m_chipId;
    std::vector<MemoryRegion> m_memoryRegions;
    std::vector<PinMapping> m_pinMappings;
};

} // namespace lasecsimul::plugins
