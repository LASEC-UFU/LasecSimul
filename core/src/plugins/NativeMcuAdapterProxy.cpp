#include "NativeMcuAdapterProxy.hpp"
#include <stdexcept>
#include "CrashGuard.hpp"
#include "QemuModuleProxy.hpp"

namespace lasecsimul::plugins {

void NativeMcuAdapterProxy::recordOutcome(WatchdogOutcome outcome) const {
    switch (outcome) {
        case WatchdogOutcome::Completed:
            m_consecutiveTimeouts = 0;
            m_health = PluginHealthStatus::Ok;
            break;
        case WatchdogOutcome::Crashed:
            m_health = PluginHealthStatus::Faulted;
            break;
        case WatchdogOutcome::TimedOut:
            m_consecutiveTimeouts++;
            m_health = m_consecutiveTimeouts >= kMaxConsecutiveTimeouts ? PluginHealthStatus::Faulted
                                                                        : PluginHealthStatus::Lagging;
            break;
    }
}

NativeMcuAdapterProxy::NativeMcuAdapterProxy(std::shared_ptr<PluginModule> module, LsdnMcuAdapter* handle,
                                             std::string chipId)
    : m_module(std::move(module)), m_handle(handle), m_chipId(std::move(chipId)) {
    const LsdnMcuVTable* vt = m_module->mcuVTable();

    const WatchdogOutcome regionsOutcome = PluginWatchdog::call(m_chipId, kColdCallTimeoutMs, [&] {
        const uint32_t regionCount = vt->get_memory_regions(m_handle, nullptr, 0);
        m_memoryRegions.resize(regionCount);
        if (regionCount > 0) {
            std::vector<LsdnMemoryRegion> regions(regionCount);
            vt->get_memory_regions(m_handle, regions.data(), regionCount);
            for (uint32_t i = 0; i < regionCount; ++i) m_memoryRegions[i] = toCoreRegion(regions[i]);
        }
    });
    recordOutcome(regionsOutcome);
    if (regionsOutcome != WatchdogOutcome::Completed) {
        throw std::runtime_error("Plugin MCU get_memory_regions() falhou (crash ou timeout) para chipId: " + m_chipId);
    }

    const WatchdogOutcome pinsOutcome = PluginWatchdog::call(m_chipId, kColdCallTimeoutMs, [&] {
        const uint32_t pinCount = vt->get_pin_map(m_handle, nullptr, 0);
        m_pinMappings.resize(pinCount);
        if (pinCount > 0) {
            std::vector<LsdnPinMapping> pins(pinCount);
            vt->get_pin_map(m_handle, pins.data(), pinCount);
            for (uint32_t i = 0; i < pinCount; ++i) m_pinMappings[i] = toCorePinMapping(pins[i]);
        }
    });
    recordOutcome(pinsOutcome);
    if (pinsOutcome != WatchdogOutcome::Completed) {
        throw std::runtime_error("Plugin MCU get_pin_map() falhou (crash ou timeout) para chipId: " + m_chipId);
    }
}

NativeMcuAdapterProxy::~NativeMcuAdapterProxy() {
    if (m_module && m_handle && m_module->mcuVTable()->destroy) {
        // Best-effort: destrutor nunca lança. Timeout/crash aqui só fica em m_health (que ninguém
        // mais vai ler, já que o objeto está sendo destruído) -- resultado ignorado de propósito.
        PluginWatchdog::call(m_chipId, kColdCallTimeoutMs, [&] { m_module->mcuVTable()->destroy(m_handle); });
    }
}

QemuLaunchSpec NativeMcuAdapterProxy::buildLaunchArgs(std::string_view firmwarePath) const {
    const std::string firmwareCopy(firmwarePath);
    LsdnQemuLaunchSpec spec{};
    const WatchdogOutcome outcome = PluginWatchdog::call(m_chipId, kColdCallTimeoutMs, [&] {
        spec = m_module->mcuVTable()->build_launch_args(m_handle, firmwareCopy.c_str());
    });
    recordOutcome(outcome);
    if (outcome != WatchdogOutcome::Completed) {
        throw std::runtime_error("Plugin MCU build_launch_args() falhou (crash ou timeout) para chipId: " + m_chipId);
    }

    QemuLaunchSpec out;
    if (spec.binary) out.binary = spec.binary;
    out.args.reserve(spec.arg_count);
    for (uint32_t i = 0; i < spec.arg_count; ++i) {
        if (spec.args && spec.args[i]) out.args.emplace_back(spec.args[i]);
    }
    return out;
}

MemoryRegion NativeMcuAdapterProxy::toCoreRegion(const LsdnMemoryRegion& region) {
    return MemoryRegion{region.start, region.end, toCoreModuleKind(region.moduleKind), region.moduleIndex};
}

PinMapping NativeMcuAdapterProxy::toCorePinMapping(const LsdnPinMapping& mapping) {
    return PinMapping{mapping.pinId ? mapping.pinId : std::string{}, toCoreModuleKind(mapping.moduleKind),
                      mapping.moduleIndex, mapping.bitOrLine};
}

std::vector<std::unique_ptr<QemuModule>> NativeMcuAdapterProxy::createModules() const {
    const LsdnMcuVTable* vt = m_module->mcuVTable();
    if (!vt->create_modules) return {};

    std::vector<LsdnQemuModuleHandle> handles;
    const WatchdogOutcome outcome = PluginWatchdog::call(m_chipId, kColdCallTimeoutMs, [&] {
        const uint32_t count = vt->create_modules(m_handle, nullptr, 0);
        if (count == 0) return;
        handles.resize(count);
        vt->create_modules(m_handle, handles.data(), count);
    });
    recordOutcome(outcome);
    if (outcome != WatchdogOutcome::Completed) {
        throw std::runtime_error("Plugin MCU create_modules() falhou (crash ou timeout) para chipId: " + m_chipId);
    }

    std::vector<std::unique_ptr<QemuModule>> modules;
    modules.reserve(handles.size());
    for (const LsdnQemuModuleHandle& handle : handles) {
        const ModuleKind kind = toCoreModuleKind(handle.moduleKind);
        uint64_t memStart = 0;
        uint64_t memEnd = 0;
        for (const MemoryRegion& region : m_memoryRegions) {
            if (region.moduleKind == kind && region.moduleIndex == handle.moduleIndex) {
                memStart = region.start;
                memEnd = region.end;
                break;
            }
        }
        modules.push_back(std::make_unique<QemuModuleProxy>(handle, memStart, memEnd, m_module->abiMinor()));
    }
    return modules;
}

void NativeMcuAdapterProxy::setPinTransitionsObserved(uint32_t pinIndex, bool observed) {
    const LsdnMcuVTable* vt = m_module->mcuVTable();
    if (!vt->set_pin_transitions_observed || m_health == PluginHealthStatus::Faulted) return;
    const bool ok = CrashGuard::call(m_chipId, [&] {
        vt->set_pin_transitions_observed(m_handle, pinIndex, observed ? 1 : 0);
    });
    if (!ok) m_health = PluginHealthStatus::Faulted;
}

void NativeMcuAdapterProxy::setSpiBytePairs(std::span<const uint32_t> clockPins, std::span<const uint32_t> dataPins) {
    const LsdnMcuVTable* vt = m_module->mcuVTable();
    // O slot só existe na vtable de um plugin de minor >= 3.
    if (m_module->abiMinor() < 3 || !vt->set_spi_byte_pairs || m_health == PluginHealthStatus::Faulted) return;
    const uint32_t count = static_cast<uint32_t>(std::min(clockPins.size(), dataPins.size()));
    const bool ok = CrashGuard::call(m_chipId, [&] {
        vt->set_spi_byte_pairs(m_handle, clockPins.data(), dataPins.data(), count);
    });
    if (!ok) m_health = PluginHealthStatus::Faulted;
}

void NativeMcuAdapterProxy::setSpiBytePairsWithMiso(std::span<const uint32_t> clockPins,
                                                    std::span<const uint32_t> dataPins,
                                                    std::span<const uint32_t> misoPins) {
    const LsdnMcuVTable* vt = m_module->mcuVTable();
    if (m_health == PluginHealthStatus::Faulted) return;
    const uint32_t count = static_cast<uint32_t>(std::min({clockPins.size(), dataPins.size(), misoPins.size()}));
    if (m_module->abiMinor() >= 6 && vt->set_spi_byte_pairs_miso) {
        const bool ok = CrashGuard::call(m_chipId, [&] {
            vt->set_spi_byte_pairs_miso(m_handle, clockPins.data(), dataPins.data(), misoPins.data(), count);
        });
        if (!ok) m_health = PluginHealthStatus::Faulted;
        return;
    }
    std::vector<uint32_t> clocks, data;
    for (uint32_t i = 0; i < count; ++i) {
        if (misoPins[i] == UINT32_MAX) { clocks.push_back(clockPins[i]); data.push_back(dataPins[i]); }
    }
    setSpiBytePairs(clocks, data);
}

std::optional<uint32_t> NativeMcuAdapterProxy::resolveI2cPinIndex(uint32_t bus, bool sda) const {
    const LsdnMcuVTable* vt = m_module->mcuVTable();
    if (!vt->resolve_i2c_pin || m_health == PluginHealthStatus::Faulted) return std::nullopt;
    uint32_t pin = 0;
    int32_t found = 0;
    const bool ok = CrashGuard::call(m_chipId, [&] {
        found = vt->resolve_i2c_pin(m_handle, bus, sda ? 1 : 0, &pin);
    });
    if (!ok) {
        m_health = PluginHealthStatus::Faulted;
        return std::nullopt;
    }
    if (found == 0) return std::nullopt;
    return pin;
}

} // namespace lasecsimul::plugins
