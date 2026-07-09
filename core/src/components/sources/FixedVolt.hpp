#pragma once

#include <array>
#include <optional>
#include "lasecsimul/IComponentModel.hpp"
#include "lasecsimul/PropertyDefinition.hpp"

namespace lasecsimul::components {

/**
 * Porta de `SimulIDE-dev/src/components/sources/fixedvolt.cpp` — fonte de tensão fixa de 1
 * terminal com botão liga/desliga (`out`). Quando desligada, o pino não é estampado (alta
 * impedância — equivalente a `m_outpin->setOutState(false)` do SimulIDE deixar o pino em estado
 * desconectado); quando ligada, mesmo Norton-pra-terra do `Rail`.
 */
class FixedVolt final : public IComponentModel {
public:
    FixedVolt(Pin pin, double voltage, bool out) : m_pins{std::move(pin)}, m_voltage(voltage), m_out(out) {}

    const char* typeId() const override { return "sources.fixed_volt"; }
    std::span<Pin> pins() override { return m_pins; }

    void stamp(MnaMatrixView& matrix) override {
        if (!m_out) {
            m_lastCurrent = 0.0; // desligado: sem contribuição, sem corrente real (honesto, não inventado)
            return; // botão desligado -- pino fica flutuando, sem contribuição
        }
        // Convenção passiva -- ver Rail::current()/DcVoltageSource::current().
        m_lastCurrent = kConductance * matrix.getNodeVoltage(m_pins[0]) - m_voltage * kConductance;
        matrix.addConductanceToGround(m_pins[0], kConductance);
        matrix.addCurrentToGround(m_pins[0], m_voltage * kConductance);
    }

    void postStep(uint64_t) override {}

    std::optional<double> current() const override { return m_lastCurrent; }

    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}

    std::vector<PropertyDescriptor> propertyDescriptors() override { return toPropertyDescriptors(properties()); }

    std::vector<PropertyDefinition> properties() {
        const std::vector<PropertySchema> schemas = propertySchema();
        const PropertySchema voltageSchema = schemaById(schemas, "voltage");
        const PropertySchema outSchema = schemaById(schemas, "out");
        return {
            PropertyDefinition{
                voltageSchema,
                [this] { return PropertyValue{m_voltage}; },
                [this, voltageSchema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(voltageSchema, v)) return {false, *error};
                    setVoltage(std::get<double>(v));
                    return {true, {}};
                },
            },
            PropertyDefinition{
                outSchema,
                [this] { return PropertyValue{m_out}; },
                [this, outSchema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(outSchema, v)) return {false, *error};
                    setOut(std::get<bool>(v));
                    return {true, {}};
                },
            },
        };
    }

    static std::vector<PropertySchema> propertySchema() {
        PropertySchema voltage;
        voltage.id = "voltage";
        voltage.label = "Tensão";
        voltage.group = "Elétrica";
        voltage.unit = "V";
        voltage.valueKind = PropertyValueKind::Number;
        voltage.editor = "number";
        voltage.defaultValue = 5.0;
        voltage.step = 0.1;
        voltage.flags |= PropertySchemaShowOnSymbol;

        PropertySchema out;
        out.id = "out";
        out.label = "Ligado";
        out.group = "Elétrica";
        out.valueKind = PropertyValueKind::Bool;
        out.editor = "checkbox";
        // `true` -- achado ao converter a fábrica de `sources.fixed_volt` pra `propertyOrDefault`
        // (auditoria arquitetural 2026-07-09): o schema dizia `false`, mas a fábrica real em
        // `CoreApplication.cpp` (e todo teste que registra este typeId) sempre usava `true` como
        // fallback -- os dois nunca bateram. `true` é o comportamento real observado em produção.
        out.defaultValue = true;

        return {voltage, out};
    }

    void setVoltage(double v) { m_voltage = v; }
    void setOut(bool out) { m_out = out; }

private:
    static constexpr double kConductance = 1e9;

    std::array<Pin, 1> m_pins;
    double m_voltage;
    bool m_out;
    double m_lastCurrent = 0.0;
};

} // namespace lasecsimul::components
