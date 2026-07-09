#pragma once

#include <array>
#include <optional>
#include "lasecsimul/IComponentModel.hpp"
#include "lasecsimul/PropertyDefinition.hpp"

namespace lasecsimul::components {

/** Fonte de tensão ideal DC. Precisa de 1 variável extra (corrente do ramo) no CircuitGroup — ver
 * .spec/lasecsimul.spec, seção 7.3. p1 é o terminal +, p2 o terminal -. */
class DcVoltageSource final : public IComponentModel {
public:
    DcVoltageSource(std::array<Pin, 2> pins, double voltage) : m_pins(std::move(pins)), m_voltage(voltage) {}

    const char* typeId() const override { return "sources.dc_voltage"; }
    std::span<Pin> pins() override { return m_pins; }
    uint32_t extraVariableCount() const override { return 1; }

    void stamp(MnaMatrixView& matrix) override {
        matrix.addVoltageSource(m_pins[0], m_pins[1], m_voltage);
        // getBranchCurrent() lê a variável extra desta fonte na ÚLTIMA solve() -- leitura grátis,
        // já é uma incógnita resolvida (ver plano de leitura de corrente, .spec/lasecsimul.spec
        // seção 7.3). Só funciona depois do primeiro rebuild de topologia (extraVarBase alocado);
        // antes disso, ComponentMatrixView::getBranchCurrent() lançaria -- por isso só lemos aqui,
        // nunca antes do primeiro stamp() real.
        m_lastCurrent = matrix.getBranchCurrent();
    }

    void postStep(uint64_t) override {} // DC, sem variação no tempo

    /** Convenção de sinal PASSIVA (mesma do Resistor: positiva quando a corrente entra por p1 e
     * sai por p2) -- verificada empiricamente em `voltage_divider_test.cpp`. Uma fonte FORNECENDO
     * energia a um circuito externo aparece NEGATIVA aqui (P=V·I com V>0 e I<0 ⟹ potência
     * entregue, não absorvida) -- não inverter pra "parecer mais intuitivo": a convenção precisa
     * ser a MESMA em todo componente pra somar corrente em qualquer nó (KCL) sem cada um ter sua
     * própria regra. */
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

    /** Ver Resistor::propertySchema() — mesmo papel (instância + ComponentMetadataRegistry). Sem
     * minValue: tensão negativa é fisicamente válida (polaridade invertida), nunca restringida. */
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

    void setVoltage(double v) { m_voltage = v; } // chamador deve marcar o componente "dirty"

private:
    std::array<Pin, 2> m_pins;
    double m_voltage;
    std::optional<double> m_lastCurrent;
};

} // namespace lasecsimul::components
