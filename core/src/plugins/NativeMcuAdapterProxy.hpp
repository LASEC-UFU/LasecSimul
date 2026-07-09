#pragma once

#include <memory>
#include <span>
#include <string>
#include <vector>
#include "PluginModule.hpp"
#include "PluginWatchdog.hpp"
#include "lasecsimul/IMcuAdapter.hpp"

namespace lasecsimul::plugins {

/**
 * Proxy de adaptador de MCU nativo: mantém o PluginModule carregado e traduz a vtable C da ABI
 * para IMcuAdapter, que é o contrato interno do Core.
 *
 * Contenção de crash/travamento (achado de auditoria arquitetural 2026-07-09): toda chamada pra
 * dentro do plugin aqui é FRIA (construtor -- 1x por instância; `buildLaunchArgs`/`createModules`
 * -- 1x por `loadFirmware`/construção; destrutor -- 1x no fim da vida), nunca por poll de 50us
 * (isso é `QemuModuleProxy`, que usa só `CrashGuard` sem thread por ser hot path) -- por isso pode
 * pagar o custo de um `PluginWatchdog` de verdade (thread dedicada + timeout), que também contém
 * TRAVAMENTO (loop infinito), não só crash (`CrashGuard` sozinho só pega SEH síncrono no Windows).
 * Mesma política de `NativeDeviceProxy` (`kMaxConsecutiveTimeouts`), adaptada pra chamadas
 * raras em vez de por-step.
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

    PluginHealthStatus health() const override { return m_health; }

private:
    static MemoryRegion toCoreRegion(const LsdnMemoryRegion& region);
    static PinMapping toCorePinMapping(const LsdnPinMapping& mapping);
    /** Mesmo state machine de `NativeDeviceProxy::postStep` (Completed reseta, Crashed falta na
     * hora, TimedOut acumula até `kMaxConsecutiveTimeouts` antes de virar `Faulted`). */
    void recordOutcome(WatchdogOutcome outcome) const;

    /** Timeout fixo pras chamadas frias de inicialização/finalização -- generoso de propósito
     * (nunca deveriam demorar mais que milissegundos num plugin legítimo; ver classe doc). Sem
     * `stepTimeoutMs` declarável no manifesto pra MCU hoje (só devices têm `limits.stepTimeoutMs`
     * -- ver `.spec/lasecsimul-native-devices.spec` seção 13), então uma constante única serve
     * todo mundo por enquanto. */
    static constexpr uint32_t kColdCallTimeoutMs = 5000;
    static constexpr uint32_t kMaxConsecutiveTimeouts = 3;

    std::shared_ptr<PluginModule> m_module;
    LsdnMcuAdapter* m_handle;
    std::string m_chipId;
    std::vector<MemoryRegion> m_memoryRegions;
    std::vector<PinMapping> m_pinMappings;
    mutable PluginHealthStatus m_health = PluginHealthStatus::Ok;
    mutable uint32_t m_consecutiveTimeouts = 0;
};

} // namespace lasecsimul::plugins
