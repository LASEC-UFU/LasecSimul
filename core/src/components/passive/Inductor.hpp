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

class Inductor final : public IComponentModel {
public:
    static constexpr double kInitialShortConductance = 1e9;

    Inductor(std::array<Pin, 2> pins, double inductanceHenry)
        : m_pins(std::move(pins))
        , m_inductance(validate(inductanceHenry)) {}

    const char* typeId() const override { return "passive.inductor"; }
    std::span<Pin> pins() override { return m_pins; }

    void stamp(MnaMatrixView& matrix) override {
        if (m_stepActive) {
            const double dt = m_step.deltaSeconds();
            if (!(dt > 0.0)) return;
            double conductance = dt / m_inductance;
            double historyCurrent = m_current;
            if (effectiveMethod() == IntegrationMethod::Trapezoidal) {
                conductance *= 0.5;
                historyCurrent = m_current + conductance * m_voltage;
            } else if (effectiveMethod() == IntegrationMethod::Gear2 && m_step.acceptedStepIndex > 0) {
                conductance = 2.0 * dt / (3.0 * m_inductance);
                historyCurrent = (4.0 * m_current - m_olderCurrent) / 3.0;
            }
            const double voltage = matrix.getNodeVoltage(m_pins[0]) - matrix.getNodeVoltage(m_pins[1]);
            m_candidateVoltage = voltage;
            m_candidateCurrent = conductance * voltage + historyCurrent;
            matrix.addConductance(m_pins[0], m_pins[1], conductance);
            matrix.addCurrent(m_pins[0], m_pins[1], historyCurrent);
            return;
        }
        // Modelo inicial DC: indutor em regime permanente se aproxima de curto. O solver ainda nao
        // expoe fonte de corrente historica/dt para o modelo dinamico completo. Corrente lida da
        // ÚLTIMA solve() antes de re-estampar -- mesma técnica de Resistor/plano de leitura de
        // corrente (.spec/lasecsimul.spec, seção 7.3).
        m_current = kInitialShortConductance * (matrix.getNodeVoltage(m_pins[0]) - matrix.getNodeVoltage(m_pins[1]));
        matrix.addConductance(m_pins[0], m_pins[1], kInitialShortConductance);
    }

    void postStep(uint64_t) override {
    }

    bool isReactive() const override { return true; }
    void beginTransientStep(const TransientStepContext& step) override { m_step = step; m_stepActive = true; }
    void commitTransientStep() override {
        if (!m_stepActive) return;
        m_olderCurrent = m_current;
        m_current = m_candidateCurrent;
        m_voltage = m_candidateVoltage;
        m_previousDeltaNs = m_step.deltaNs;
        m_stepActive = false;
    }
    void rollbackTransientStep() override { m_stepActive = false; }
    double transientErrorRatio(double absoluteTolerance, double relativeTolerance) const override {
        if (m_step.acceptedStepIndex < 1 || m_previousDeltaNs == 0) {
            const double delta = m_candidateCurrent - m_current;
            const double magnitude = std::max({std::abs(m_candidateCurrent), std::abs(m_current),
                                               absoluteTolerance / relativeTolerance, 1e-3});
            const double scale = absoluteTolerance + relativeTolerance * magnitude;
            return 0.5 * delta * delta / (magnitude * scale);
        }
        const double ratio = static_cast<double>(m_step.deltaNs) / static_cast<double>(m_previousDeltaNs);
        const double predicted = m_current + ratio * (m_current - m_olderCurrent);
        const double scale = absoluteTolerance + relativeTolerance * std::max(std::abs(m_candidateCurrent), std::abs(m_current));
        return std::abs(m_candidateCurrent - predicted) / (3.0 * scale);
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
    IntegrationMethod effectiveMethod() const {
        if (m_step.acceptedStepIndex == 0) return IntegrationMethod::BackwardEuler;
        if (m_step.method != IntegrationMethod::Automatic) return m_step.method;
        return IntegrationMethod::Trapezoidal;
    }
    static double validate(double henry) {
        if (!std::isfinite(henry) || henry <= 0.0) {
            throw std::invalid_argument("inductance deve ser > 0 H");
        }
        return henry;
    }

    std::array<Pin, 2> m_pins;
    double m_inductance;
    double m_current = 0.0;
    double m_olderCurrent = 0.0;
    double m_voltage = 0.0;
    double m_candidateCurrent = 0.0;
    double m_candidateVoltage = 0.0;
    TransientStepContext m_step;
    bool m_stepActive = false;
    uint64_t m_previousDeltaNs = 0;
};

} // namespace lasecsimul::components
