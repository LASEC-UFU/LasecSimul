#pragma once

#include <stdexcept>
#include <string>
#include "lasecsimul/QemuModule.hpp"
#include "lasecsimul/mcu_abi.h"
#include "CrashGuard.hpp"

namespace lasecsimul::plugins {

inline ModuleKind toCoreModuleKind(LsdnModuleKind kind) {
    switch (kind) {
        case LSDN_MODULE_GPIO: return ModuleKind::Gpio;
        case LSDN_MODULE_IOMUX: return ModuleKind::IoMux;
        case LSDN_MODULE_I2C: return ModuleKind::I2c;
        case LSDN_MODULE_SPI: return ModuleKind::Spi;
        case LSDN_MODULE_USART: return ModuleKind::Usart;
        case LSDN_MODULE_TIMER: return ModuleKind::Timer;
        case LSDN_MODULE_RESET: return ModuleKind::Reset;
        case LSDN_MODULE_ADC: return ModuleKind::Adc;
        case LSDN_MODULE_PWM: return ModuleKind::Pwm;
        default: throw std::runtime_error("LsdnModuleKind desconhecido");
    }
}

/**
 * Adapta um LsdnQemuModuleHandle (estado opaco + vtable C, vindo de um plugin de MCU via
 * mcu_abi.h) para QemuModule -- mesmo papel que NativeDeviceProxy já faz para IComponentModel.
 * Cada chamada virtual aqui é uma indireção a mais sobre um ponteiro de função C: mesmo custo de
 * uma chamada virtual C++ comum, sem fronteira de processo/serialização (o plugin roda no mesmo
 * processo do Core) -- por isso um QemuModule via plugin tem o mesmo desempenho de um built-in.
 * `is_output_enabled`/`output_level`/`set_input_level` são opcionais na ABI (ponteiro pode ser
 * nulo, ex: módulo que não é GPIO-like) -- tratado aqui como "nunca dirige nada", mesmo default de
 * QemuModule.
 *
 * Contenção de crash (achado de auditoria arquitetural 2026-07-09): toda chamada pra dentro do
 * plugin passa por `CrashGuard::call` SEM watchdog de thread (`timeoutMs` implícito = 0, mesmo
 * caminho direto de `PluginWatchdog::call` quando não há orçamento declarado) -- de propósito,
 * porque `McuComponent` chama estes métodos conforme o passo temporal configurado no Scheduler
 * (`McuComponent.hpp`); no Windows x64, `CrashGuard`/SEH table-based não tem custo mensurável no
 * caminho feliz (sem exceção), então isso fecha a mesma lacuna de robustez que `NativeDeviceProxy`
 * já tinha pra dispositivos ABI comuns, sem competir com o orçamento de tempo real do MCU. Uma
 * thread de watchdog COM timeout aqui custaria dezenas de microssegundos só pra criar/destruir --
 * maior que o próprio período de poll -- por isso reservada só pras chamadas frias de
 * `NativeMcuAdapterProxy` (create/get_memory_regions/get_pin_map/create_modules/destroy, uma vez
 * por instância, nunca por poll). Ver `docs/25-auditoria-arquitetural-core-2026-07-09.md` seção 8.1.
 */
class QemuModuleProxy final : public QemuModule {
public:
    QemuModuleProxy(LsdnQemuModuleHandle handle, uint64_t memStart, uint64_t memEnd)
        : QemuModule(toCoreModuleKind(handle.moduleKind), handle.moduleIndex, memStart, memEnd),
          m_handle(handle), m_label("qemu-module#" + std::to_string(handle.moduleIndex)) {}

    ~QemuModuleProxy() override {
        if (m_handle.vtable && m_handle.vtable->destroy) {
            CrashGuard::call(m_label, [&] { m_handle.vtable->destroy(m_handle.module); });
        }
    }

    QemuModuleProxy(const QemuModuleProxy&) = delete;
    QemuModuleProxy& operator=(const QemuModuleProxy&) = delete;

    void reset() override {
        if (!m_handle.vtable->reset) return;
        if (!CrashGuard::call(m_label, [&] { m_handle.vtable->reset(m_handle.module); })) m_health = PluginHealthStatus::Faulted;
    }

    void writeRegister(uint64_t address, uint64_t value) override {
        const bool ok = CrashGuard::call(m_label, [&] {
            if (m_handle.vtable->write_register_at) m_handle.vtable->write_register_at(m_handle.module, address, value, 0);
            else m_handle.vtable->write_register(m_handle.module, address, value);
        });
        if (!ok) m_health = PluginHealthStatus::Faulted;
    }

    void writeRegisterAt(uint64_t address, uint64_t value, uint64_t nowNs) override {
        const bool ok = CrashGuard::call(m_label, [&] {
            if (m_handle.vtable->write_register_at) m_handle.vtable->write_register_at(m_handle.module, address, value, nowNs);
            else m_handle.vtable->write_register(m_handle.module, address, value);
        });
        if (!ok) m_health = PluginHealthStatus::Faulted;
    }

    uint64_t readRegister(uint64_t address) override {
        uint64_t value = 0;
        const bool ok = CrashGuard::call(m_label, [&] { value = m_handle.vtable->read_register(m_handle.module, address); });
        if (!ok) m_health = PluginHealthStatus::Faulted;
        return value;
    }

    bool isOutputEnabled(uint32_t bitOrLine) const override {
        if (!m_handle.vtable->is_output_enabled) return false;
        bool result = false;
        const bool ok = CrashGuard::call(
            m_label, [&] { result = m_handle.vtable->is_output_enabled(m_handle.module, bitOrLine) != 0; });
        if (!ok) m_health = PluginHealthStatus::Faulted;
        return result;
    }

    bool outputLevel(uint32_t bitOrLine) const override {
        if (!m_handle.vtable->output_level) return false;
        bool result = false;
        const bool ok = CrashGuard::call(m_label, [&] { result = m_handle.vtable->output_level(m_handle.module, bitOrLine) != 0; });
        if (!ok) m_health = PluginHealthStatus::Faulted;
        return result;
    }

    void setInputLevel(uint32_t bitOrLine, bool level) override {
        const bool ok = CrashGuard::call(m_label, [&] {
            if (m_handle.vtable->set_input_level_at) m_handle.vtable->set_input_level_at(m_handle.module, bitOrLine, level ? 1 : 0, 0);
            else if (m_handle.vtable->set_input_level) m_handle.vtable->set_input_level(m_handle.module, bitOrLine, level ? 1 : 0);
        });
        if (!ok) m_health = PluginHealthStatus::Faulted;
    }

    void setInputLevelAt(uint32_t bitOrLine, bool level, uint64_t nowNs) override {
        const bool ok = CrashGuard::call(m_label, [&] {
            if (m_handle.vtable->set_input_level_at) {
                m_handle.vtable->set_input_level_at(m_handle.module, bitOrLine, level ? 1 : 0, nowNs);
            } else if (m_handle.vtable->set_input_level) {
                m_handle.vtable->set_input_level(m_handle.module, bitOrLine, level ? 1 : 0);
            }
        });
        if (!ok) m_health = PluginHealthStatus::Faulted;
    }

    void setInputVoltageAt(uint32_t bitOrLine, double voltage, uint64_t nowNs) override {
        const bool ok = CrashGuard::call(m_label, [&] {
            if (m_handle.vtable->set_input_voltage_at) {
                m_handle.vtable->set_input_voltage_at(m_handle.module, bitOrLine, voltage, nowNs);
            } else if (m_handle.vtable->set_input_level_at) {
                m_handle.vtable->set_input_level_at(m_handle.module, bitOrLine, voltage > 1.65 ? 1 : 0, nowNs);
            } else if (m_handle.vtable->set_input_level) {
                m_handle.vtable->set_input_level(m_handle.module, bitOrLine, voltage > 1.65 ? 1 : 0);
            }
        });
        if (!ok) m_health = PluginHealthStatus::Faulted;
    }

    uint64_t nextWakeupDelayNs() const override {
        if (!m_handle.vtable->next_wakeup_delay_ns_at && !m_handle.vtable->next_wakeup_delay_ns) return QemuModule::kNoWakeup;
        uint64_t value = QemuModule::kNoWakeup;
        const bool ok = CrashGuard::call(m_label, [&] {
            if (m_handle.vtable->next_wakeup_delay_ns_at) value = m_handle.vtable->next_wakeup_delay_ns_at(m_handle.module, 0);
            else value = m_handle.vtable->next_wakeup_delay_ns(m_handle.module);
        });
        if (!ok) { m_health = PluginHealthStatus::Faulted; return QemuModule::kNoWakeup; }
        return value;
    }

    uint64_t nextWakeupDelayNs(uint64_t nowNs) const override {
        if (!m_handle.vtable->next_wakeup_delay_ns_at && !m_handle.vtable->next_wakeup_delay_ns) return QemuModule::kNoWakeup;
        uint64_t value = QemuModule::kNoWakeup;
        const bool ok = CrashGuard::call(m_label, [&] {
            if (m_handle.vtable->next_wakeup_delay_ns_at) value = m_handle.vtable->next_wakeup_delay_ns_at(m_handle.module, nowNs);
            else value = m_handle.vtable->next_wakeup_delay_ns(m_handle.module);
        });
        if (!ok) { m_health = PluginHealthStatus::Faulted; return QemuModule::kNoWakeup; }
        return value;
    }

    void onWakeup(uint64_t nowNs) override {
        if (!m_handle.vtable->on_wakeup) return;
        if (!CrashGuard::call(m_label, [&] { m_handle.vtable->on_wakeup(m_handle.module, nowNs); })) {
            m_health = PluginHealthStatus::Faulted;
        }
    }

    PluginHealthStatus health() const override { return m_health; }

private:
    LsdnQemuModuleHandle m_handle;
    std::string m_label;
    mutable PluginHealthStatus m_health = PluginHealthStatus::Ok;
};

} // namespace lasecsimul::plugins
