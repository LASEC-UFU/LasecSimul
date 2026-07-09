#pragma once

#include <array>
#include <optional>
#include "lasecsimul/IComponentModel.hpp"
#include "lasecsimul/PropertyDefinition.hpp"

namespace lasecsimul::components {

/**
 * Porta de `SimulIDE-dev/src/components/sources/rail.cpp` — fonte de tensão ideal de 1 terminal só
 * (o "retorno" é implícito, referenciado à terra global do circuito, igual ao SimulIDE: `Rail` só
 * tem `m_out`). Modelado como Norton-pra-terra: admitância alta + corrente injetada equivalente
 * (ver `IComponentModel::addCurrentToGround`) — mesma técnica de `Ground`, mas fixando `voltage`
 * em vez de 0V.
 */
class Rail final : public IComponentModel {
public:
    static constexpr double kRailConductance = 1e9; // siemens — mesma ordem de Ground::kGroundConductance

    Rail(Pin pin, double voltage) : m_pins{std::move(pin)}, m_voltage(voltage) {}

    const char* typeId() const override { return "sources.rail"; }
    std::span<Pin> pins() override { return m_pins; }

    void stamp(MnaMatrixView& matrix) override {
        // Convenção PASSIVA (ver DcVoltageSource::current() / Battery::current()): corrente
        // entrando no pino vinda de fora = Gg·Vúltima - Ig. Lida ANTES de re-estampar (reflete a
        // última solve()) -- mesma técnica de Resistor/Inductor.
        m_lastCurrent = kRailConductance * matrix.getNodeVoltage(m_pins[0]) - m_voltage * kRailConductance;
        matrix.addConductanceToGround(m_pins[0], kRailConductance);
        matrix.addCurrentToGround(m_pins[0], m_voltage * kRailConductance);
    }

    void postStep(uint64_t) override {} // DC -- sem variação no tempo

    /** Negativa quando o Rail está fornecendo corrente à carga (convenção passiva, ver
     * DcVoltageSource::current()). */
    std::optional<double> current() const override { return m_lastCurrent; }

    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}

    std::vector<PropertyDescriptor> propertyDescriptors() override { return toPropertyDescriptors(properties()); }

    std::vector<PropertyDefinition> properties() {
        const PropertySchema schema = propertySchema().front();
        return {
            PropertyDefinition{
                schema,
                [this] { return PropertyValue{m_voltage}; },
                [this, schema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(schema, v)) return {false, *error};
                    setVoltage(std::get<double>(v));
                    return {true, {}};
                },
            },
        };
    }

    static std::vector<PropertySchema> propertySchema() {
        PropertySchema schema;
        schema.id = "voltage";
        schema.label = "Tensão";
        schema.group = "Elétrica";
        schema.unit = "V";
        schema.valueKind = PropertyValueKind::Number;
        schema.editor = "number";
        schema.defaultValue = 5.0;
        schema.step = 0.1;
        schema.flags |= PropertySchemaShowOnSymbol;
        return {schema};
    }

    void setVoltage(double v) { m_voltage = v; }

private:
    std::array<Pin, 1> m_pins;
    double m_voltage;
    double m_lastCurrent = 0.0;
};

} // namespace lasecsimul::components
