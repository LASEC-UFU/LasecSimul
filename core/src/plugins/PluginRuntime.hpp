#pragma once

#include <memory>
#include <stdexcept>
#include <string>
#include "GlobalPluginCache.hpp"
#include "NativeDeviceProxy.hpp"
#include "NativeMcuAdapterProxy.hpp"
#include "../registry/ComponentParams.hpp"
#include "lasecsimul/IComponentModel.hpp"
#include "lasecsimul/IMcuAdapter.hpp"

namespace lasecsimul::plugins {

/**
 * Cria/destrói PluginInstance (NativeDeviceProxy) para ESTA sessão, a partir do PluginModule ativo
 * no GlobalPluginCache. Não conhece LoadLibrary/dlopen nem valida ABI — isso é do PluginLoader.
 * Ver .spec/archive/legacy-v2/lasecsimul-native-devices.spec, seção 1.
 */
class PluginRuntime {
public:
    explicit PluginRuntime(GlobalPluginCache& cache) : m_cache(cache) {}

    std::unique_ptr<IComponentModel> createDeviceInstance(const std::string& typeId, ComponentMeta meta,
                                                          const registry::ComponentParams& params,
                                                          simulation::Scheduler& scheduler);
    std::unique_ptr<IMcuAdapter> createMcuAdapter(const std::string& chipId);

private:
    GlobalPluginCache& m_cache;
};

} // namespace lasecsimul::plugins
