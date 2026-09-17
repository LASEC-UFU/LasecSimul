#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <vector>

#include "lasecsimul/IComponentModel.hpp"
#include "lasecsimul/PropertyDefinition.hpp"

namespace lasecsimul::components {

/**
 * ADC/DAC de 8 bits -- réplica do encapsulamento e da fiação do ADC/DAC real do SimulIDE
 * (`SimulIDE_2-R260501_Win64`, categoria Lógicos/Outros Lógicos): 1 pino analógico de terminal
 * único (referenciado ao terra global da MNA, mesma convenção de `sources.fixed_volt`/`sources.
 * rail` -- nunca um par diferencial) + um barramento de 8 pinos digitais independentes ("d0"..
 * "d7", d0 = LSB), cada um um nível lógico 0V/5V de verdade (não uma porta de Signal Graph).
 *
 * Isto substitui uma tentativa anterior (typeId igual, mesmo lugar na paleta "Conversores") que
 * expunha o valor quantizado como UMA porta de Signal Graph em vez do barramento elétrico literal
 * -- pedido explícito do usuário foi "o barramento digital de 8 bits literal do simulide", então
 * ambos os componentes agora são 100% elétricos (nenhum `signalPorts()`), como o dispositivo real.
 *
 * `typeId`s preservados ("logic.adc"/"logic.dac") -- são os que `SimulideComponentMapper.ts` já
 * mapeia na importação de `.sim1`/`.sim2`.
 */
inline double quantizeToByteCode(double value, double vref) {
    const double safeVref = std::max(1e-9, vref);
    const double clamped = std::clamp(value, 0.0, safeVref);
    return std::round(clamped / safeVref * 255.0);
}

class AdcConverter final : public IComponentModel {
public:
    /** `pins[0]` = "in" (analógico, terminal único); `pins[1..8]` = "d0".."d7" (barramento digital,
     * d0 = LSB, saída). */
    explicit AdcConverter(std::array<Pin, 9> pins, double vref = 5.0) : m_pins(std::move(pins)), m_vref(vref) {}
    const char* typeId() const override { return "logic.adc"; }
    std::span<Pin> pins() override { return m_pins; }
    bool isNonlinear() const override { return true; }
    bool hasConverged() const override { return m_converged; }

    /** "in" nunca ganha estampa própria (impedância de entrada praticamente infinita, mesmo
     * espírito de `SignalVoltageSensor`) -- só o guard genérico do framework evita nó singular. */
    std::span<const uint32_t> leakagePinIndices() const override { return {&kAnalogInputIndexValue, 1}; }

    void stamp(MnaMatrixView& matrix) override {
        const double measured = matrix.getNodeVoltage(m_pins[kIn]);
        const uint32_t code = static_cast<uint32_t>(quantizeToByteCode(measured, m_vref));
        for (uint32_t bit = 0; bit < 8; ++bit) {
            const double level = ((code >> bit) & 1u) ? kHighVolts : kLowVolts;
            matrix.addConductanceToGround(m_pins[kD0 + bit], kDriveConductance);
            matrix.addCurrentToGround(m_pins[kD0 + bit], level * kDriveConductance);
        }
        m_converged = code == m_lastCode;
        m_lastCode = code;
    }
    void postStep(uint64_t) override {}

    uint32_t code() const { return m_lastCode; }

    std::vector<PropertyDescriptor> propertyDescriptors() override { return toPropertyDescriptors(properties()); }
    std::vector<PropertyDefinition> properties() {
        const PropertySchema schema = propertySchema().front();
        return {PropertyDefinition{schema, [this] { return PropertyValue{m_vref}; },
            [this, schema](const PropertyValue& v) -> PropertyBindResult {
                if (const auto error = validatePropertyValue(schema, v)) return {false, *error};
                m_vref = std::get<double>(v);
                return {true, {}};
            }}};
    }
    static std::vector<PropertySchema> propertySchema() {
        PropertySchema vref;
        vref.id = "vref"; vref.label = "Tensão de Referência"; vref.group = "Conversão";
        vref.unit = "V"; vref.valueKind = PropertyValueKind::Number; vref.editor = "number";
        vref.defaultValue = 5.0; vref.minValue = 0.001; vref.step = 0.1;
        return {vref};
    }

    size_t getState(uint8_t* out, size_t cap) const override {
        if (cap < sizeof(m_lastCode)) return 0;
        std::memcpy(out, &m_lastCode, sizeof(m_lastCode)); return sizeof(m_lastCode);
    }
    void setState(const uint8_t* in, size_t len) override {
        if (len >= sizeof(m_lastCode)) std::memcpy(&m_lastCode, in, sizeof(m_lastCode));
    }

private:
    static constexpr size_t kIn = 0;
    static constexpr size_t kD0 = 1;
    static constexpr double kHighVolts = 5.0;
    static constexpr double kLowVolts = 0.0;
    static constexpr double kDriveConductance = 1e9; // mesma ordem de FixedVolt::kConductance
    static constexpr uint32_t kAnalogInputIndexValue = kIn;

    std::array<Pin, 9> m_pins;
    double m_vref;
    uint32_t m_lastCode = 0;
    bool m_converged = false;
};

class DacConverter final : public IComponentModel {
public:
    /** `pins[0..7]` = "d0".."d7" (barramento digital, d0 = LSB, entrada); `pins[8]` = "out"
     * (analógico, terminal único). */
    explicit DacConverter(std::array<Pin, 9> pins, double vref = 5.0) : m_pins(std::move(pins)), m_vref(vref) {}
    const char* typeId() const override { return "logic.dac"; }
    std::span<Pin> pins() override { return m_pins; }
    bool isNonlinear() const override { return true; }
    bool hasConverged() const override { return m_converged; }

    /** "d0".."d7" só são LIDOS (nunca ganham condutância própria aqui) -- mesmo motivo do "en"/
     * "addr-*" de `AnalogMux`: sem o guard, um bit não fiado deixaria o grupo topológico inteiro
     * singular. */
    std::span<const uint32_t> leakagePinIndices() const override { return kDigitalInputIndicesArray; }

    void stamp(MnaMatrixView& matrix) override {
        uint32_t code = 0;
        for (uint32_t bit = 0; bit < 8; ++bit) {
            if (matrix.getNodeVoltage(m_pins[bit]) > kLogicThreshold) code |= (1u << bit);
        }
        const double voltage = static_cast<double>(code) / 255.0 * std::max(1e-9, m_vref);
        matrix.addConductanceToGround(m_pins[kOut], kDriveConductance);
        matrix.addCurrentToGround(m_pins[kOut], voltage * kDriveConductance);
        m_converged = code == m_lastCode;
        m_lastCode = code;
    }
    void postStep(uint64_t) override {}

    uint32_t code() const { return m_lastCode; }

    std::vector<PropertyDescriptor> propertyDescriptors() override { return toPropertyDescriptors(properties()); }
    std::vector<PropertyDefinition> properties() {
        const PropertySchema schema = propertySchema().front();
        return {PropertyDefinition{schema, [this] { return PropertyValue{m_vref}; },
            [this, schema](const PropertyValue& v) -> PropertyBindResult {
                if (const auto error = validatePropertyValue(schema, v)) return {false, *error};
                m_vref = std::get<double>(v);
                return {true, {}};
            }}};
    }
    static std::vector<PropertySchema> propertySchema() { return AdcConverter::propertySchema(); }

    size_t getState(uint8_t* out, size_t cap) const override {
        if (cap < sizeof(m_lastCode)) return 0;
        std::memcpy(out, &m_lastCode, sizeof(m_lastCode)); return sizeof(m_lastCode);
    }
    void setState(const uint8_t* in, size_t len) override {
        if (len >= sizeof(m_lastCode)) std::memcpy(&m_lastCode, in, sizeof(m_lastCode));
    }

private:
    static constexpr size_t kOut = 8;
    static constexpr double kLogicThreshold = 2.5; // V -- mesmo limiar de AnalogMux/SimulIDE
    static constexpr double kDriveConductance = 1e9;
    static constexpr std::array<uint32_t, 8> kDigitalInputIndicesArray{0, 1, 2, 3, 4, 5, 6, 7};

    std::array<Pin, 9> m_pins;
    double m_vref;
    uint32_t m_lastCode = 0;
    bool m_converged = false;
};

} // namespace lasecsimul::components
