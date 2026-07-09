#pragma once

#include <array>
#include <optional>
#include <string>
#include "lasecsimul/IComponentModel.hpp"
#include "lasecsimul/PropertyDefinition.hpp"

namespace lasecsimul::components {

/** Chave ideal: aproxima fechado/aberto com condutância alta/baixa em vez de modelar como elemento
 * não-linear — não há Newton-Raphson real no solver ainda (ver IComponentModel::isNonlinear()), e
 * um switch ideal não precisa de ponto de operação para ser fisicamente correto, só de uma
 * admitância grande o bastante para aproximar curto e pequena o bastante para aproximar aberto
 * sem deixar a matriz MNA mal-condicionada — mesma técnica do "almost zero/almost infinite
 * resistance" usado por simuladores SPICE-like para switches ideais. */
class Button final : public IComponentModel {
public:
    explicit Button(std::array<Pin, 2> pins, bool pressed) : m_pins(std::move(pins)), m_pressed(pressed) {}

    const char* typeId() const override { return "logic.button"; }
    std::span<Pin> pins() override { return m_pins; }

    void stamp(MnaMatrixView& matrix) override {
        matrix.addConductance(m_pins[0], m_pins[1], m_pressed ? kClosedSiemens : kOpenSiemens);
    }

    void postStep(uint64_t) override {
        // chave ideal é puramente algébrica — nunca registrada como dinâmica, isto nunca é chamado
    }

    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}

    std::vector<PropertyDescriptor> propertyDescriptors() override { return toPropertyDescriptors(properties()); }

    std::vector<PropertyDefinition> properties() {
        const PropertySchema schema = propertySchema().front();
        return {
            PropertyDefinition{
                schema,
                [this] { return PropertyValue{m_pressed}; },
                [this, schema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(schema, v)) return {false, *error};
                    m_pressed = std::get<bool>(v);
                    return {true, {}};
                },
            },
        };
    }

    /** Ver Resistor::propertySchema() — mesmo papel (instância + ComponentMetadataRegistry). */
    static std::vector<PropertySchema> propertySchema() {
        PropertySchema schema;
        schema.id = "pressed";
        schema.label = "Pressionado";
        schema.group = "Elétrica";
        schema.valueKind = PropertyValueKind::Bool;
        schema.editor = "checkbox";
        schema.defaultValue = false;
        return {schema};
    }

    bool pressed() const { return m_pressed; }
    void setPressed(bool pressed) { m_pressed = pressed; } // chamador deve marcar o componente "dirty"

private:
    static constexpr double kClosedSiemens = 1e6; // ~1 µΩ fechado
    static constexpr double kOpenSiemens = 1e-9;   // ~1 GΩ aberto

    std::array<Pin, 2> m_pins;
    bool m_pressed;
};

} // namespace lasecsimul::components
