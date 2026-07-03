#pragma once

#include <array>
#include <cmath>
#include <cstring>
#include "lasecsimul/IComponentModel.hpp"

namespace lasecsimul::components {

/**
 * Porta de `SimulIDE-dev/src/components/meters/probe.cpp` — sonda de 1 pino, altíssima
 * impedância (`setImpedance(1e9)` no original), mostra a tensão lida e muda de cor acima/abaixo
 * de `threshold`. Lê a tensão no PRÓPRIO `stamp()` (reflete a última `solve()`, antes de aplicar a
 * admitância desta rodada) e guarda em `getState()` -- mesmo papel do `m_voltIn`/`setVolt()` do
 * original, exposto via o mecanismo genérico de leitura de estado em vez de rótulo gráfico
 * próprio.
 */
class Probe final : public IComponentModel {
public:
    explicit Probe(Pin pin, double threshold) : m_pins{std::move(pin)}, m_threshold(threshold) {}

    const char* typeId() const override { return "meters.probe"; }
    std::span<Pin> pins() override { return m_pins; }

    void stamp(MnaMatrixView& matrix) override {
        m_lastVoltage = matrix.getNodeVoltage(m_pins[0]);
        matrix.addConductanceToGround(m_pins[0], kInputConductance); // alta impedância, nunca zero
    }

    void postStep(uint64_t) override {}

    size_t getState(uint8_t* out, size_t cap) const override {
        if (cap < sizeof(double)) return 0;
        std::memcpy(out, &m_lastVoltage, sizeof(double));
        return sizeof(double);
    }
    void setState(const uint8_t* in, size_t len) override {
        if (len < sizeof(double)) return;
        std::memcpy(&m_lastVoltage, in, sizeof(double));
    }

    std::vector<PropertyDescriptor> propertyDescriptors() override {
        const auto schemas = propertySchema();
        PropertyDescriptor threshold{"threshold", "V", [this] { return PropertyValue{m_threshold}; },
                                      [this](const PropertyValue& v) {
                                          if (const double* d = std::get_if<double>(&v)) m_threshold = *d;
                                      }};
        threshold.schema = schemas[0];
        PropertyDescriptor showVolt{"showVolt", "", [this] { return PropertyValue{m_showVolt}; },
                                     [this](const PropertyValue& v) {
                                         if (const bool* b = std::get_if<bool>(&v)) m_showVolt = *b;
                                     }};
        showVolt.schema = schemas[1];
        return {threshold, showVolt};
    }

    /** ABI v2 (.spec/lasecsimul-native-devices.spec) -- `getState()` é 1 double de tensão. */
    static ReadoutFormat readoutFormat() {
        ReadoutFormat format;
        format.kind = ReadoutKind::Scalar;
        format.unit = "V";
        return format;
    }

    static std::vector<PropertySchema> propertySchema() {
        PropertySchema threshold;
        threshold.id = "threshold";
        threshold.label = "Limiar";
        threshold.group = "Leitura";
        threshold.unit = "V";
        threshold.valueKind = PropertyValueKind::Number;
        threshold.editor = "number";
        threshold.defaultValue = 2.5;

        PropertySchema showVolt;
        showVolt.id = "showVolt";
        showVolt.label = "Mostrar Tensão";
        showVolt.group = "Leitura";
        showVolt.valueKind = PropertyValueKind::Bool;
        showVolt.editor = "checkbox";
        showVolt.defaultValue = true;

        return {threshold, showVolt};
    }

private:
    static constexpr double kInputConductance = 1e-9; // ~1GΩ, mesma ordem do high_imp do SimulIDE

    std::array<Pin, 1> m_pins;
    double m_threshold;
    bool m_showVolt = true;
    double m_lastVoltage = 0.0;
};

} // namespace lasecsimul::components
