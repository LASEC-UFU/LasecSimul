#pragma once

#include <array>
#include <cmath>
#include <cstring>
#include <optional>
#include <stdexcept>
#include "lasecsimul/IComponentModel.hpp"
#include "lasecsimul/PropertyDefinition.hpp"

namespace lasecsimul::components {

class Inductor final : public IComponentModel {
public:
    static constexpr double kInitialShortConductance = 1e9;

    Inductor(std::array<Pin, 2> pins, double inductanceHenry)
        : m_pins(std::move(pins))
        , m_inductance(validate(inductanceHenry)) {}

    const char* typeId() const override { return "passive.inductor"; }
    std::span<Pin> pins() override { return m_pins; }

    void stamp(MnaMatrixView& matrix) override {
        // Modelo inicial DC: indutor em regime permanente se aproxima de curto. O solver ainda nao
        // expoe fonte de corrente historica/dt para o modelo dinamico completo. Corrente lida da
        // ÚLTIMA solve() antes de re-estampar -- mesma técnica de Resistor/plano de leitura de
        // corrente (.spec/lasecsimul.spec, seção 7.3).
        m_current = kInitialShortConductance * (matrix.getNodeVoltage(m_pins[0]) - matrix.getNodeVoltage(m_pins[1]));
        matrix.addConductance(m_pins[0], m_pins[1], kInitialShortConductance);
    }

    void postStep(uint64_t) override {
        // Estado dinamico reservado, mas ainda nao atualizavel sem dt + tensao/corrente do passo.
    }

    /** Corrente de p1 pra p2 (convenção do stamp()) na última solve(). */
    std::optional<double> current() const override { return m_current; }

    size_t getState(uint8_t* out, size_t cap) const override {
        if (!out || cap < sizeof(m_current)) return 0;
        std::memcpy(out, &m_current, sizeof(m_current));
        return sizeof(m_current);
    }

    void setState(const uint8_t* in, size_t len) override {
        if (!in || len < sizeof(m_current)) return;
        std::memcpy(&m_current, in, sizeof(m_current));
    }

    std::vector<PropertyDescriptor> propertyDescriptors() override { return toPropertyDescriptors(properties()); }

    std::vector<PropertyDefinition> properties() {
        const PropertySchema schema = propertySchema().front();
        return {
            PropertyDefinition{
                schema,
                [this] { return PropertyValue{m_inductance}; },
                [this, schema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(schema, v)) return {false, *error};
                    setInductance(std::get<double>(v));
                    return {true, {}};
                },
            },
        };
    }

    /** Ver Resistor::propertySchema() — mesmo papel (instância + ComponentMetadataRegistry). */
    static std::vector<PropertySchema> propertySchema() {
        PropertySchema schema;
        schema.id = "inductance";
        schema.label = "Indutância";
        schema.group = "Elétrica";
        schema.unit = "H";
        schema.valueKind = PropertyValueKind::Number;
        schema.editor = "number";
        schema.defaultValue = 1e-3;
        schema.minValue = 1e-9;
        schema.step = 1e-4;
        schema.flags |= PropertySchemaShowOnSymbol;
        return {schema};
    }

    void setInductance(double henry) { m_inductance = validate(henry); } // chamador deve marcar dirty

private:
    static double validate(double henry) {
        if (!std::isfinite(henry) || henry <= 0.0) {
            throw std::invalid_argument("inductance deve ser > 0 H");
        }
        return henry;
    }

    std::array<Pin, 2> m_pins;
    double m_inductance;
    double m_current = 0.0;
};

} // namespace lasecsimul::components
