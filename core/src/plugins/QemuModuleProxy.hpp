#pragma once

#include <stdexcept>
#include "lasecsimul/QemuModule.hpp"
#include "lasecsimul/mcu_abi.h"

namespace lasecsimul::plugins {

inline ModuleKind toCoreModuleKind(LsdnModuleKind kind) {
    switch (kind) {
        case LSDN_MODULE_GPIO: return ModuleKind::Gpio;
        case LSDN_MODULE_I2C: return ModuleKind::I2c;
        case LSDN_MODULE_SPI: return ModuleKind::Spi;
        case LSDN_MODULE_USART: return ModuleKind::Usart;
        case LSDN_MODULE_TIMER: return ModuleKind::Timer;
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
 */
class QemuModuleProxy final : public QemuModule {
public:
    QemuModuleProxy(LsdnQemuModuleHandle handle, uint64_t memStart, uint64_t memEnd)
        : QemuModule(toCoreModuleKind(handle.moduleKind), handle.moduleIndex, memStart, memEnd),
          m_handle(handle) {}

    ~QemuModuleProxy() override {
        if (m_handle.vtable && m_handle.vtable->destroy) m_handle.vtable->destroy(m_handle.module);
    }

    QemuModuleProxy(const QemuModuleProxy&) = delete;
    QemuModuleProxy& operator=(const QemuModuleProxy&) = delete;

    void reset() override {
        if (m_handle.vtable->reset) m_handle.vtable->reset(m_handle.module);
    }

    void writeRegister(uint64_t address, uint64_t value) override {
        m_handle.vtable->write_register(m_handle.module, address, value);
    }

    uint64_t readRegister(uint64_t address) override {
        return m_handle.vtable->read_register(m_handle.module, address);
    }

    bool isOutputEnabled(uint32_t bitOrLine) const override {
        return m_handle.vtable->is_output_enabled && m_handle.vtable->is_output_enabled(m_handle.module, bitOrLine) != 0;
    }

    bool outputLevel(uint32_t bitOrLine) const override {
        return m_handle.vtable->output_level && m_handle.vtable->output_level(m_handle.module, bitOrLine) != 0;
    }

    void setInputLevel(uint32_t bitOrLine, bool level) override {
        if (m_handle.vtable->set_input_level) m_handle.vtable->set_input_level(m_handle.module, bitOrLine, level ? 1 : 0);
    }

private:
    LsdnQemuModuleHandle m_handle;
};

} // namespace lasecsimul::plugins
