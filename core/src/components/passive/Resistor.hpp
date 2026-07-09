#pragma once

#include <array>
#include <cmath>
#include <optional>
#include <stdexcept>
#include "lasecsimul/IComponentModel.hpp"
#include "lasecsimul/PropertyDefinition.hpp"

namespace lasecsimul::components {

/** Tier nativo estatico: stamp() só roda na criação/edição, igual a e-resistor.cpp do SimulIDE-dev. */
class Resistor final : public IComponentModel {
public:
    Resistor(std::array<Pin, 2> pins, double resistanceOhm) : m_pins(std::move(pins)), m_resistance(validate(resistanceOhm)) {}

    const char* typeId() const override { return "passive.resistor"; }
    std::span<Pin> pins() override { return m_pins; }

    void stamp(MnaMatrixView& matrix) override {
        // Lê a tensão da ÚLTIMA solve() ANTES de re-estampar -- mesma técnica de "current" cacheado
        // usada por Diode/Ampmeter/etc, ver plano de leitura de corrente em .spec/lasecsimul.spec,
        // seção 7.3 (opção de baixo custo: sem incógnita nova, só Ohm na tensão já resolvida).
        const double conductance = 1.0 / m_resistance;
        m_lastCurrent = conductance * (matrix.getNodeVoltage(m_pins[0]) - matrix.getNodeVoltage(m_pins[1]));
        matrix.addConductance(m_pins[0], m_pins[1], conductance);
    }

    void postStep(uint64_t) override {
        // resistor é puramente algébrico — nunca é registrado como dinâmico, isto nunca é chamado
    }

    /** Corrente de p1 pra p2 (convenção do stamp()) na última solve(). */
    std::optional<double> current() const override { return m_lastCurrent; }

    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}

    std::vector<PropertyDescriptor> propertyDescriptors() override { return toPropertyDescriptors(properties()); }

    /** Schema rico estático (grupo/editor/min/step) — usado tanto por `properties()` (busca por id,
     * nunca por índice -- achado de auditoria arquitetural 2026-07-09, D1) quanto em
     * `CoreApplication::registerBuiltinComponents` (registra no `ComponentMetadataRegistry` por
     * typeId, antes de qualquer instância existir). Mesmo vocabulário que `.lsdevice` usa pra
     * plugins — ver `.spec/lasecsimul.spec` sobre paridade built-in/plugin. */
    static std::vector<PropertySchema> propertySchema() {
        PropertySchema schema;
        schema.id = "resistance";
        schema.label = "Resistência";
        schema.group = "Elétrica";
        schema.unit = "Ω";
        schema.valueKind = PropertyValueKind::Number;
        schema.editor = "number";
        schema.defaultValue = 1000.0;
        schema.minValue = 0.01;
        schema.step = 1.0;
        schema.flags |= PropertySchemaShowOnSymbol; // valor formatado aparece perto do símbolo (ex: "1 kΩ")
        return {schema};
    }

    /** `set` chama `setResistance` (validação extra além do schema: finito e > 0, ver `validate()`
     * abaixo) DEPOIS de `validatePropertyValue` já ter confirmado o tipo/min contra o schema --
     * duas camadas deliberadas, não redundância: schema cobre "editável em runtime", `validate()`
     * cobre o invariante físico do próprio Resistor (nunca aceita NaN/Inf, mesmo se um schema
     * futuro esquecer `minValue`). */
    std::vector<PropertyDefinition> properties() {
        const PropertySchema schema = propertySchema().front();
        return {
            PropertyDefinition{
                schema,
                [this] { return PropertyValue{m_resistance}; },
                [this, schema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(schema, v)) return {false, *error};
                    setResistance(std::get<double>(v));
                    return {true, {}};
                },
            },
        };
    }

    void setResistance(double ohm) { m_resistance = validate(ohm); } // chamador deve marcar o componente "dirty"

private:
    static double validate(double ohm) {
        if (!std::isfinite(ohm) || ohm <= 0.0) {
            throw std::invalid_argument("resistance deve ser > 0 ohm");
        }
        return ohm;
    }

    std::array<Pin, 2> m_pins;
    double m_resistance;
    double m_lastCurrent = 0.0;
};

} // namespace lasecsimul::components
