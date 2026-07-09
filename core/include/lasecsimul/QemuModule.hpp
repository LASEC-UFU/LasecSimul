#pragma once

#include <cstdint>
#include <limits>
#include "Types.hpp"

namespace lasecsimul {

/**
 * Espelho fiel de `QemuModule` (C:\SourceCode\simulide_2\src\microsim\cores\qemu\qemumodule.h) --
 * intérprete de registrador MMIO de UM periférico concreto (GPIO, IOMUX, I2C, SPI, USART de um
 * chip específico). `memStart`/`memEnd` = faixa de endereço absoluta que esse módulo cobre (ver
 * `IMcuAdapter::memoryRegions()`); `McuComponent`/`QemuArenaBridge::dispatch()` usam isso pra
 * achar qual módulo é dono de cada `regAddr` recebido via `SIM_READ`/`SIM_WRITE`
 * (qemu_arena_abi.h).
 *
 * Deliberadamente CHIP-ESPECÍFICO: cada subclasse concreta (ex: Esp32GpioModule) conhece os
 * offsets de registrador exatos daquele periférico naquele chip -- isso não é generalizável
 * (confirmado lendo hw/gpio/esp32_gpio.c do fork QEMU real: o offset 0x04 só significa
 * "GPIO_OUT_REG" porque é assim que o ESP32 define seu mapa de registradores, nada nisso é
 * universal entre chips). Só `Scheduler`/`BusController`/`Netlist`/IPC/UI precisam ser neutros
 * quanto a chip -- ver `IMcuAdapter.hpp`.
 */
class QemuModule {
public:
    static constexpr uint64_t kNoWakeup = std::numeric_limits<uint64_t>::max();

    /** `kind`/`index` identificam este módulo do MESMO jeito que `MemoryRegion`/`PinMapping` já
     * fazem (ex: ModuleKind::Gpio, índice 0) -- é assim que `McuComponent` acha qual `QemuModule`
     * corresponde a um `PinMapping`, sem precisar perguntar "que chip é esse" pra ninguém. */
    QemuModule(ModuleKind kind, uint32_t index, uint64_t memStart, uint64_t memEnd)
        : m_kind(kind), m_index(index), m_memStart(memStart), m_memEnd(memEnd) {}
    virtual ~QemuModule() = default;

    ModuleKind kind() const { return m_kind; }
    uint32_t index() const { return m_index; }
    uint64_t memStart() const { return m_memStart; }
    uint64_t memEnd() const { return m_memEnd; }
    bool owns(uint64_t address) const { return address >= m_memStart && address <= m_memEnd; }

    virtual void reset() {}

    /** `address` é ABSOLUTO (mesmo espaço de `regAddr` da arena) -- subclasse subtrai `m_memStart`
     * pra achar o offset do registrador, igual ao `m_eventAddress - m_memStart` do SimulIDE real. */
    virtual void writeRegister(uint64_t address, uint64_t value) = 0;
    virtual void writeRegisterAt(uint64_t address, uint64_t value, uint64_t) { writeRegister(address, value); }
    virtual uint64_t readRegister(uint64_t address) = 0;

    /** Ponte genérica pino<->matriz elétrica, usada por `McuComponent::stamp()` -- chamada pra
     * TODO `PinMapping` cujo `moduleKind` aponta pra este módulo, independente de qual chip é.
     * Default (módulo que não é GPIO, ex: I2C/SPI/USART) nunca dirige nada -- só um módulo tipo
     * GPIO faz sentido sobrescrever; é isso que mantém `McuComponent` neutro quanto a chip (ele
     * chama estes 3 métodos genericamente, nunca sabe "é ESP32" ou o que cada bit significa). */
    virtual bool isOutputEnabled(uint32_t) const { return false; }
    virtual bool outputLevel(uint32_t) const { return false; }
    virtual void setInputLevel(uint32_t, bool) {}
    virtual void setInputLevelAt(uint32_t bitOrLine, bool level, uint64_t) { setInputLevel(bitOrLine, level); }

    /** Modulos com protocolo temporizado (UART/SPI/I2C, timers, PWM) podem pedir um wakeup de
     * simulacao. O Core agenda a chamada e re-estampa o MCU; o modulo continua sem conhecer
     * Scheduler/Netlist e sem depender de built-in. */
    virtual uint64_t nextWakeupDelayNs() const { return kNoWakeup; }
    virtual uint64_t nextWakeupDelayNs(uint64_t) const { return nextWakeupDelayNs(); }
    virtual void onWakeup(uint64_t) {}

    /** Default `Ok` -- só `QemuModuleProxy` (plugin de MCU via `mcu_abi.h`) sobrescreve, marcando
     * `Faulted` se uma chamada pra dentro do plugin crashar (ver `CrashGuard`). Mesmo padrão de
     * `IComponentModel::health()`; `McuComponent::health()` agrega isto de todo módulo + do próprio
     * `IMcuAdapter::health()` (achado de auditoria arquitetural 2026-07-09: MCU não tinha contenção
     * de crash nenhuma até esta correção, ao contrário de `NativeDeviceProxy`). */
    virtual PluginHealthStatus health() const { return PluginHealthStatus::Ok; }

protected:
    ModuleKind m_kind;
    uint32_t m_index;
    uint64_t m_memStart;
    uint64_t m_memEnd;
};

} // namespace lasecsimul
