#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <optional>
#include "lasecsimul/IComponentModel.hpp"
#include "lasecsimul/PropertyDefinition.hpp"

namespace lasecsimul::components {

/**
 * Porta de `SimulIDE-dev/src/components/sources/csource.cpp` — fonte controlada genérica, 4 pinos:
 * `cp`/`cm` (controle, sensoriamento) e `s1`/`s2` (saída). Mesma técnica de admitância do
 * original (`low_imp = 1e-7` reaproveitado como condutância: alta impedância de sensoriamento de
 * tensão, baixa impedância de sensoriamento de corrente via `currControl`; saída em modo tensão
 * usa Norton com `1/low_imp` pra aproximar fonte ideal, modo corrente é injeção direta).
 *
 * Linearização por round (como `Diode`): `stamp()` lê a tensão de controle da ÚLTIMA `solve()` —
 * a relação é LINEAR (sem exponencial), então converge em no máximo 2 rounds (o segundo só
 * confirma que o valor não mudou), nunca precisando do laço de Newton-Raphson de verdade.
 */
class Csource final : public IComponentModel {
public:
    Csource(std::array<Pin, 4> pins, bool controlPins, bool currSource, bool currControl, double gain,
            double voltage, double current)
        : m_pins(std::move(pins)), m_controlPins(controlPins), m_currSource(currSource), m_currControl(currControl),
          m_gain(gain), m_voltage(voltage), m_current(current) {}

    const char* typeId() const override { return "sources.controlled_source"; }
    std::span<Pin> pins() override { return m_pins; }

    bool isNonlinear() const override { return m_controlPins; } // sem pinos de controle, é puramente fixo
    bool hasConverged() const override { return m_converged; }

    void stamp(MnaMatrixView& matrix) override {
        // Pinos de controle: sempre presentes na ABI (mesmo número de pinos do SimulIDE), mas só
        // influenciam a saída quando m_controlPins -- mesmo assim sempre sensoriados (mesma
        // condutância do original, pra nunca deixar cp/cm sem nenhuma referência na matriz).
        const double controlAdmittance = m_currControl ? (1.0 / kLowImp) : kLowImp;
        matrix.addConductance(m_pins[kControlPlus], m_pins[kControlMinus], controlAdmittance);

        double effective = m_currSource ? m_current : m_voltage;
        if (m_controlPins) {
            const double controlVoltage =
                matrix.getNodeVoltage(m_pins[kControlPlus]) - matrix.getNodeVoltage(m_pins[kControlMinus]);
            const double controlSignal = m_currControl ? (controlVoltage / kLowImp) : controlVoltage;
            effective = m_gain * controlSignal;
        }

        // addCurrent(a,b,I): I sai de a, entra em b -- pra "effective" positivo empurrar corrente
        // PRA FORA de s1 (kSourcePlus) no circuito externo, o ramo interno precisa sair de s2 e
        // entrar em s1 (mesma convenção de Battery -- ver comentário lá).
        // Convenção passiva de current() (entrando em s1, saindo em s2, ver Battery::current()).
        if (m_currSource) {
            m_lastSourceCurrent = -effective; // só addCurrent(s2,s1,I), sem condutância -> -I
            matrix.addCurrent(m_pins[kSourceMinus], m_pins[kSourcePlus], effective);
        } else {
            const double g = 1.0 / kLowImp;
            m_lastSourceCurrent =
                g * (matrix.getNodeVoltage(m_pins[kSourcePlus]) - matrix.getNodeVoltage(m_pins[kSourceMinus])) -
                effective * g;
            matrix.addConductance(m_pins[kSourcePlus], m_pins[kSourceMinus], g);
            matrix.addCurrent(m_pins[kSourceMinus], m_pins[kSourcePlus], effective * g);
        }

        m_converged = std::abs(effective - m_lastEffective) < kTolerance;
        m_lastEffective = effective;
    }

    void postStep(uint64_t) override {} // puramente algébrico

    /** Corrente do ramo de SAÍDA (s1->s2, convenção passiva) -- ignora a corrente sensoriada nos
     * pinos de controle (cp/cm), que é tipicamente desprezível por construção (alta impedância,
     * ver `controlAdmittance`). */
    std::optional<double> current() const override { return m_lastSourceCurrent; }

    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}

    std::vector<PropertyDescriptor> propertyDescriptors() override { return toPropertyDescriptors(properties()); }

    std::vector<PropertyDefinition> properties() {
        const std::vector<PropertySchema> schemas = propertySchema();
        const PropertySchema controlPinsSchema = schemaById(schemas, "controlPins");
        const PropertySchema currSourceSchema = schemaById(schemas, "currSource");
        const PropertySchema currControlSchema = schemaById(schemas, "currControl");
        const PropertySchema gainSchema = schemaById(schemas, "gain");
        const PropertySchema voltageSchema = schemaById(schemas, "voltage");
        const PropertySchema currentSchema = schemaById(schemas, "current");
        return {
            PropertyDefinition{
                controlPinsSchema,
                [this] { return PropertyValue{m_controlPins}; },
                [this, controlPinsSchema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(controlPinsSchema, v)) return {false, *error};
                    m_controlPins = std::get<bool>(v);
                    return {true, {}};
                },
            },
            PropertyDefinition{
                currSourceSchema,
                [this] { return PropertyValue{m_currSource}; },
                [this, currSourceSchema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(currSourceSchema, v)) return {false, *error};
                    m_currSource = std::get<bool>(v);
                    return {true, {}};
                },
            },
            PropertyDefinition{
                currControlSchema,
                [this] { return PropertyValue{m_currControl}; },
                [this, currControlSchema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(currControlSchema, v)) return {false, *error};
                    m_currControl = std::get<bool>(v);
                    return {true, {}};
                },
            },
            PropertyDefinition{
                gainSchema,
                [this] { return PropertyValue{m_gain}; },
                [this, gainSchema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(gainSchema, v)) return {false, *error};
                    m_gain = std::get<double>(v);
                    return {true, {}};
                },
            },
            PropertyDefinition{
                voltageSchema,
                [this] { return PropertyValue{m_voltage}; },
                [this, voltageSchema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(voltageSchema, v)) return {false, *error};
                    m_voltage = std::get<double>(v);
                    return {true, {}};
                },
            },
            PropertyDefinition{
                currentSchema,
                [this] { return PropertyValue{m_current}; },
                [this, currentSchema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(currentSchema, v)) return {false, *error};
                    m_current = std::get<double>(v);
                    return {true, {}};
                },
            },
        };
    }

    static std::vector<PropertySchema> propertySchema() {
        PropertySchema controlPins;
        controlPins.id = "controlPins";
        controlPins.label = "Usar Pinos de Controle";
        controlPins.group = "Elétrica";
        controlPins.valueKind = PropertyValueKind::Bool;
        controlPins.editor = "checkbox";
        controlPins.defaultValue = true;

        PropertySchema currSource;
        currSource.id = "currSource";
        currSource.label = "Fonte de Corrente";
        currSource.group = "Elétrica";
        currSource.valueKind = PropertyValueKind::Bool;
        currSource.editor = "checkbox";
        currSource.defaultValue = true;

        PropertySchema currControl;
        currControl.id = "currControl";
        currControl.label = "Controlado por Corrente";
        currControl.group = "Elétrica";
        currControl.valueKind = PropertyValueKind::Bool;
        currControl.editor = "checkbox";
        currControl.defaultValue = false;

        PropertySchema gain;
        gain.id = "gain";
        gain.label = "Ganho";
        gain.group = "Elétrica";
        gain.valueKind = PropertyValueKind::Number;
        gain.editor = "number";
        gain.defaultValue = 1.0;
        gain.flags |= PropertySchemaShowOnSymbol;

        PropertySchema voltage;
        voltage.id = "voltage";
        voltage.label = "Tensão";
        voltage.group = "Elétrica";
        voltage.unit = "V";
        voltage.valueKind = PropertyValueKind::Number;
        voltage.editor = "number";
        voltage.defaultValue = 5.0;
        voltage.minValue = 0.0;

        PropertySchema current;
        current.id = "current";
        current.label = "Corrente";
        current.group = "Elétrica";
        current.unit = "A";
        current.valueKind = PropertyValueKind::Number;
        current.editor = "number";
        current.defaultValue = 1.0;
        current.minValue = 0.0;

        return {controlPins, currSource, currControl, gain, voltage, current};
    }

private:
    static constexpr double kLowImp = 1e-7; // mesma constante do SimulIDE (e-element.h::low_imp)
    static constexpr double kTolerance = 1e-9;
    static constexpr size_t kControlPlus = 0;
    static constexpr size_t kControlMinus = 1;
    static constexpr size_t kSourcePlus = 2;
    static constexpr size_t kSourceMinus = 3;

    std::array<Pin, 4> m_pins;
    bool m_controlPins;
    bool m_currSource;
    bool m_currControl;
    double m_gain;
    double m_voltage;
    double m_current;
    double m_lastEffective = 0.0;
    double m_lastSourceCurrent = 0.0;
    bool m_converged = false;
};

} // namespace lasecsimul::components
