#pragma once

#include <array>
#include <cmath>
#include <cstring>
#include <optional>
#include <stdexcept>
#include "lasecsimul/IComponentModel.hpp"
#include "lasecsimul/PropertyDefinition.hpp"

namespace lasecsimul::components {

class Capacitor final : public IComponentModel {
public:
    Capacitor(std::array<Pin, 2> pins, double capacitanceFarad)
        : m_pins(std::move(pins))
        , m_capacitance(validate(capacitanceFarad)) {}

    const char* typeId() const override { return "passive.capacitor"; }
    std::span<Pin> pins() override { return m_pins; }

    void stamp(MnaMatrixView&) override {
        // Sem contrato de dt/postStep com acesso a tensao ainda, o stamp inicial e o equivalente DC:
        // capacitor descarregado em regime DC se comporta como circuito aberto.
    }

    void postStep(uint64_t) override {
        // Estado dinamico reservado, mas ainda nao atualizavel sem dt + tensao/corrente do passo.
    }

    /** Sempre 0: o modelo DC atual não estampa nenhuma contribuição (circuito aberto), então não
     * há corrente real pra reportar -- não esconder isso atrás de um valor "plausível" inventado.
     * Revisitar quando o modelo dinâmico completo (dt + histórico) existir. */
    std::optional<double> current() const override { return 0.0; }

    size_t getState(uint8_t* out, size_t cap) const override {
        if (!out || cap < sizeof(m_voltage)) return 0;
        std::memcpy(out, &m_voltage, sizeof(m_voltage));
        return sizeof(m_voltage);
    }

    void setState(const uint8_t* in, size_t len) override {
        if (!in || len < sizeof(m_voltage)) return;
        std::memcpy(&m_voltage, in, sizeof(m_voltage));
    }

    std::vector<PropertyDescriptor> propertyDescriptors() override { return toPropertyDescriptors(properties()); }

    std::vector<PropertyDefinition> properties() {
        const PropertySchema schema = propertySchema().front();
        return {
            PropertyDefinition{
                schema,
                [this] { return PropertyValue{m_capacitance}; },
                [this, schema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(schema, v)) return {false, *error};
                    setCapacitance(std::get<double>(v));
                    return {true, {}};
                },
            },
        };
    }

    /** Ver Resistor::propertySchema() — mesmo papel (instância + ComponentMetadataRegistry). */
    static std::vector<PropertySchema> propertySchema() {
        PropertySchema schema;
        schema.id = "capacitance";
        schema.label = "Capacitância";
        schema.group = "Elétrica";
        schema.unit = "F";
        schema.valueKind = PropertyValueKind::Number;
        schema.editor = "number";
        schema.defaultValue = 1e-6;
        schema.minValue = 1e-12;
        schema.step = 1e-7;
        schema.flags |= PropertySchemaShowOnSymbol;
        return {schema};
    }

    void setCapacitance(double farad) { m_capacitance = validate(farad); } // chamador deve marcar dirty

private:
    static double validate(double farad) {
        if (!std::isfinite(farad) || farad <= 0.0) {
            throw std::invalid_argument("capacitance deve ser > 0 F");
        }
        return farad;
    }

    std::array<Pin, 2> m_pins;
    double m_capacitance;
    double m_voltage = 0.0;
};

} // namespace lasecsimul::components
