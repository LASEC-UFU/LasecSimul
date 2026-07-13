#pragma once

#include <array>
#include <algorithm>
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

    void stamp(MnaMatrixView& matrix) override {
        if (!m_stepActive) return; // ponto de operacao DC: circuito aberto
        const double dt = m_step.deltaSeconds();
        if (!(dt > 0.0)) return;

        double conductance = m_capacitance / dt;
        double historyCurrent = -conductance * m_voltage;
        if (effectiveMethod() == IntegrationMethod::Trapezoidal) {
            conductance *= 2.0;
            historyCurrent = -conductance * m_voltage - m_current;
        } else if (effectiveMethod() == IntegrationMethod::Gear2 && m_step.acceptedStepIndex > 0) {
            conductance = 1.5 * m_capacitance / dt;
            historyCurrent = m_capacitance * (-2.0 * m_voltage + 0.5 * m_olderVoltage) / dt;
        }
        matrix.addConductance(m_pins[0], m_pins[1], conductance);
        matrix.addCurrent(m_pins[0], m_pins[1], historyCurrent);
        m_candidateVoltage = matrix.getNodeVoltage(m_pins[0]) - matrix.getNodeVoltage(m_pins[1]);
        m_candidateCurrent = conductance * m_candidateVoltage + historyCurrent;
    }

    void postStep(uint64_t) override {
    }

    bool isReactive() const override { return true; }
    void beginTransientStep(const TransientStepContext& step) override { m_step = step; m_stepActive = true; }
    void commitTransientStep() override {
        if (!m_stepActive) return;
        m_olderVoltage = m_voltage;
        m_voltage = m_candidateVoltage;
        m_current = m_candidateCurrent;
        m_previousDeltaNs = m_step.deltaNs;
        m_stepActive = false;
    }
    void rollbackTransientStep() override { m_stepActive = false; }
    double transientErrorRatio(double absoluteTolerance, double relativeTolerance) const override {
        if (m_step.acceptedStepIndex < 1 || m_previousDeltaNs == 0) {
            const double delta = m_candidateVoltage - m_voltage;
            const double magnitude = std::max({std::abs(m_candidateVoltage), std::abs(m_voltage),
                                               absoluteTolerance / relativeTolerance, 1.0});
            const double scale = absoluteTolerance + relativeTolerance * magnitude;
            return 0.5 * delta * delta / (magnitude * scale);
        }
        const double ratio = static_cast<double>(m_step.deltaNs) / static_cast<double>(m_previousDeltaNs);
        const double predicted = m_voltage + ratio * (m_voltage - m_olderVoltage);
        const double scale = absoluteTolerance + relativeTolerance * std::max(std::abs(m_candidateVoltage), std::abs(m_voltage));
        return std::abs(m_candidateVoltage - predicted) / (3.0 * scale);
    }

    /** Sempre 0: o modelo DC atual não estampa nenhuma contribuição (circuito aberto), então não
     * há corrente real pra reportar -- não esconder isso atrás de um valor "plausível" inventado.
     * Revisitar quando o modelo dinâmico completo (dt + histórico) existir. */
    std::optional<double> current() const override { return m_current; }

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
    IntegrationMethod effectiveMethod() const {
        // Metodos de ordem > 1 precisam de historico consistente. O primeiro passo BE evita a
        // meia-etapa artificial do trapezoidal quando a fonte liga em t=0.
        if (m_step.acceptedStepIndex == 0) return IntegrationMethod::BackwardEuler;
        if (m_step.method != IntegrationMethod::Automatic) return m_step.method;
        return IntegrationMethod::Trapezoidal;
    }
    static double validate(double farad) {
        if (!std::isfinite(farad) || farad <= 0.0) {
            throw std::invalid_argument("capacitance deve ser > 0 F");
        }
        return farad;
    }

    std::array<Pin, 2> m_pins;
    double m_capacitance;
    double m_voltage = 0.0;
    double m_olderVoltage = 0.0;
    double m_current = 0.0;
    double m_candidateVoltage = 0.0;
    double m_candidateCurrent = 0.0;
    TransientStepContext m_step;
    bool m_stepActive = false;
    uint64_t m_previousDeltaNs = 0;
};

} // namespace lasecsimul::components
