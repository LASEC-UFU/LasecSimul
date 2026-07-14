#pragma once

#include <array>
#include <cmath>
#include <cstdint>
#include <optional>
#include <span>
#include <stdexcept>
#include <vector>
#include "lasecsimul/IComponentModel.hpp"
#include "lasecsimul/PropertyDefinition.hpp"

namespace lasecsimul::components {

/**
 * Modelo elétrico de cinco terminais do Stepper unipolar do SimulIDE.
 *
 * A ordem preserva os quatro ids legados do LasecSimul:
 * A+, A-, B+, B-, Co. Cada meia-bobina liga um terminal de fase ao comum.
 * O modelo ainda não calcula torque/back-EMF, mas a topologia resistiva coincide
 * com `stepper.cpp` e o terminal Co deixa de ser apenas um detalhe visual ausente.
 */
class StepperWindings final : public IComponentModel {
public:
    StepperWindings(std::vector<Pin> pins, double resistanceOhm)
        : m_pins(std::move(pins)), m_resistance(validate(resistanceOhm)) {
        if (m_pins.size() != 5) throw std::invalid_argument("outputs.stepper requer 5 pinos");
        m_leakageIndices = {0, 1, 2, 3, 4};
    }

    const char* typeId() const override { return "outputs.stepper"; }
    std::span<Pin> pins() override { return m_pins; }
    std::span<const uint32_t> leakagePinIndices() const override { return m_leakageIndices; }

    void stamp(MnaMatrixView& matrix) override {
        const double conductance = 1.0 / m_resistance;
        const Pin& common = m_pins[4];
        for (size_t phase = 0; phase < 4; ++phase) {
            m_lastCurrent[phase] = conductance *
                (matrix.getNodeVoltage(m_pins[phase]) - matrix.getNodeVoltage(common));
            matrix.addConductance(m_pins[phase], common, conductance);
        }
    }

    void postStep(uint64_t) override {}
    std::optional<double> current() const override { return m_lastCurrent[0]; }
    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}

    std::vector<PropertyDescriptor> propertyDescriptors() override {
        return toPropertyDescriptors(properties());
    }

    std::vector<PropertyDefinition> properties() {
        const PropertySchema schema = propertySchema(m_resistance).front();
        return {{
            schema,
            [this] { return PropertyValue{m_resistance}; },
            [this, schema](const PropertyValue& value) -> PropertyBindResult {
                if (const std::optional<std::string> error = validatePropertyValue(schema, value)) {
                    return {false, *error};
                }
                m_resistance = validate(std::get<double>(value));
                return {true, {}};
            },
        }};
    }

    static std::vector<PropertySchema> propertySchema(double defaultOhm) {
        PropertySchema schema;
        schema.id = "resistance";
        schema.label = "Resistência";
        schema.group = "Elétrica";
        schema.unit = "Ω";
        schema.valueKind = PropertyValueKind::Number;
        schema.editor = "number";
        schema.defaultValue = defaultOhm;
        schema.minValue = 1e-9;
        schema.step = 1.0;
        schema.flags |= PropertySchemaShowOnSymbol;
        return {schema};
    }

private:
    static double validate(double ohm) {
        if (!std::isfinite(ohm) || ohm <= 0.0) {
            throw std::invalid_argument("resistance deve ser > 0 ohm");
        }
        return ohm;
    }

    std::vector<Pin> m_pins;
    double m_resistance;
    std::array<double, 4> m_lastCurrent{};
    std::vector<uint32_t> m_leakageIndices;
};

} // namespace lasecsimul::components
