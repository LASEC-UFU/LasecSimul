#pragma once

#include <algorithm>
#include <array>
#include <optional>
#include "lasecsimul/IComponentModel.hpp"
#include "lasecsimul/PropertyDefinition.hpp"

namespace lasecsimul::components {

/**
 * Porta de `SimulIDE-dev/src/components/sources/battery.cpp` — fonte de tensão real (ideal + uma
 * resistência interna em série), 2 pinos. Modelado como equivalente de Norton entre os próprios
 * pinos (condutância `1/R` + fonte de corrente `V/R`) em vez de variável extra de ramo — mesma
 * álgebra que o `eResistor::stamp()`/`stampCurrent()` do SimulIDE fazem com `m_admit`, sem
 * precisar de `extraVariableCount()` (que o `Battery` real do SimulIDE também não usa). `p1` é o
 * terminal `+` (vermelho no SimulIDE), `p2` o `-`.
 */
class Battery final : public IComponentModel {
public:
    Battery(std::array<Pin, 2> pins, double voltage, double resistanceOhm)
        : m_pins(std::move(pins)), m_voltage(validateVoltage(voltage)), m_resistance(validateResistance(resistanceOhm)) {}

    const char* typeId() const override { return "sources.battery"; }
    std::span<Pin> pins() override { return m_pins; }

    void stamp(MnaMatrixView& matrix) override {
        const double conductance = 1.0 / m_resistance;
        // Convenção passiva (current(), validada empiricamente em simulide_sources_meters_test.cpp):
        // entrando em p1, saindo em p2 = G*(V1-V2) - I, onde I é o termo do addCurrent(p2,p1,I)
        // abaixo. Lida ANTES de re-estampar (reflete a última solve()).
        m_lastCurrent = conductance * (matrix.getNodeVoltage(m_pins[0]) - matrix.getNodeVoltage(m_pins[1])) -
                        m_voltage * conductance;
        matrix.addConductance(m_pins[0], m_pins[1], conductance);
        // addCurrent(a,b,I): I sai de a, entra em b -- pra essa fonte Norton empurrar corrente PRA
        // FORA do terminal + (m_pins[0]) no circuito externo, a corrente interna do ramo precisa
        // sair de p2(-) e entrar em p1(+) (convenção padrão de fonte real: corrente convencional
        // sai pelo +). Por isso a ordem é (p2, p1), não (p1, p2).
        matrix.addCurrent(m_pins[1], m_pins[0], m_voltage * conductance);
    }

    void postStep(uint64_t) override {} // DC -- sem variação no tempo

    /** Negativa quando a bateria está fornecendo energia (convenção passiva, ver
     * DcVoltageSource::current()). */
    std::optional<double> current() const override { return m_lastCurrent; }

    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}

    std::vector<PropertyDescriptor> propertyDescriptors() override { return toPropertyDescriptors(properties()); }

    std::vector<PropertyDefinition> properties() {
        const std::vector<PropertySchema> schemas = propertySchema();
        const PropertySchema voltageSchema = schemaById(schemas, "voltage");
        const PropertySchema resistanceSchema = schemaById(schemas, "resistance");
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
                resistanceSchema,
                [this] { return PropertyValue{m_resistance}; },
                [this, resistanceSchema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(resistanceSchema, v)) return {false, *error};
                    setResistance(std::get<double>(v));
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
        voltage.minValue = 1e-12; // SimulIDE::Battery::setVoltage nunca aceita <= 0
        voltage.step = 0.1;
        voltage.flags |= PropertySchemaShowOnSymbol;

        PropertySchema resistance;
        resistance.id = "resistance";
        resistance.label = "Resistência Interna";
        resistance.group = "Elétrica";
        resistance.unit = "Ω";
        resistance.valueKind = PropertyValueKind::Number;
        resistance.editor = "number";
        resistance.defaultValue = 1e-3; // SimulIDE usa m_admit=1e3 -> R=1mΩ por default
        resistance.minValue = 1e-14;
        resistance.step = 1e-3;
        return {voltage, resistance};
    }

    void setVoltage(double v) { m_voltage = validateVoltage(v); }
    void setResistance(double r) { m_resistance = validateResistance(r); }

private:
    static double validateVoltage(double v) { return v < 1e-12 ? 1e-12 : v; } // mesma trava do SimulIDE
    static double validateResistance(double r) { return r < 1e-14 ? 1e-14 : r; }

    std::array<Pin, 2> m_pins;
    double m_voltage;
    double m_resistance;
    double m_lastCurrent = 0.0;
};

} // namespace lasecsimul::components
