#pragma once

#include <array>
#include <cmath>
#include "lasecsimul/IComponentModel.hpp"
#include "lasecsimul/PropertyDefinition.hpp"

namespace lasecsimul::components {

class Comparator final : public IComponentModel {
public:
    Comparator(std::array<Pin, 3> pins, double highVoltage, bool inverted)
        : m_pins(std::move(pins)), m_highVoltage(highVoltage), m_inverted(inverted) {}
    const char* typeId() const override { return "active.comparator"; }
    std::span<Pin> pins() override { return m_pins; }
    bool isNonlinear() const override { return true; }
    bool hasConverged() const override { return m_converged; }
    void stamp(MnaMatrixView& matrix) override {
        bool high = matrix.getNodeVoltage(m_pins[0]) > matrix.getNodeVoltage(m_pins[1]);
        if (m_inverted) high = !high;
        const double output = high ? m_highVoltage : 0.0;
        matrix.addConductanceToGround(m_pins[2], kOutputConductance);
        matrix.addCurrentToGround(m_pins[2], output * kOutputConductance);
        m_converged = high == m_lastHigh;
        m_lastHigh = high;
    }
    void postStep(uint64_t) override {}
    size_t getState(uint8_t* out, size_t cap) const override {
        if (cap < 1) return 0;
        out[0] = m_lastHigh ? 1 : 0;
        return 1;
    }
    void setState(const uint8_t* in, size_t len) override { if (len) m_lastHigh = in[0] != 0; }
    std::vector<PropertyDescriptor> propertyDescriptors() override { return toPropertyDescriptors(properties()); }
    std::vector<PropertyDefinition> properties() {
        const auto schemas = propertySchema();
        const auto high = schemaById(schemas, "outputHighVoltage");
        const auto inverted = schemaById(schemas, "inverted");
        return {
            PropertyDefinition{high, [this] { return PropertyValue{m_highVoltage}; },
                [this, high](const PropertyValue& v) -> PropertyBindResult {
                    if (auto e = validatePropertyValue(high, v)) return {false, *e};
                    m_highVoltage = std::get<double>(v); return {true, {}};
                }},
            PropertyDefinition{inverted, [this] { return PropertyValue{m_inverted}; },
                [this, inverted](const PropertyValue& v) -> PropertyBindResult {
                    if (auto e = validatePropertyValue(inverted, v)) return {false, *e};
                    m_inverted = std::get<bool>(v); return {true, {}};
                }},
        };
    }
    static std::vector<PropertySchema> propertySchema() {
        PropertySchema high{"outputHighVoltage", "Tensão de saída alta", "Elétrica", "V",
                            PropertyValueKind::Number, "number", 5.0};
        high.minValue = 0.0;
        PropertySchema inverted{"inverted", "Invertido", "Elétrica", "", PropertyValueKind::Bool,
                                "checkbox", false};
        return {high, inverted};
    }
private:
    static constexpr double kOutputConductance = 1e6;
    std::array<Pin, 3> m_pins;
    double m_highVoltage;
    bool m_inverted;
    bool m_lastHigh = false;
    bool m_converged = false;
};

} // namespace lasecsimul::components
