#pragma once

#include <array>
#include <cstring>
#include <optional>
#include "lasecsimul/IComponentModel.hpp"

namespace lasecsimul::components {

/**
 * Porta de `SimulIDE-dev/src/components/meters/ampmeter.cpp` (via `Meter`) — amperímetro de 3
 * pinos: `lPin`/`rPin` em série no circuito medido (resistência ~0, `setResistance(1e-6)` no
 * original) e `outPin`, que devolve a corrente medida como tensão analógica (mesmo papel do
 * `m_outPin->setOutHighV(m_dispValue)` do `Meter` base -- outros componentes podem ler esse pino
 * pra reagir à leitura, ex: um osciloscópio). Corrente lida a partir da queda de tensão na própria
 * resistência interna, na ÚLTIMA `solve()` (mesmo princípio do `Diode`/`Probe`).
 */
class Ampmeter final : public IComponentModel {
public:
    Ampmeter(std::array<Pin, 3> pins, double resistanceOhm)
        : m_pins(std::move(pins)), m_resistance(resistanceOhm < 1e-12 ? 1e-12 : resistanceOhm) {}

    const char* typeId() const override { return "meters.ampmeter"; }
    std::span<Pin> pins() override { return m_pins; }

    void stamp(MnaMatrixView& matrix) override {
        const double dropV = matrix.getNodeVoltage(m_pins[kLeft]) - matrix.getNodeVoltage(m_pins[kRight]);
        m_lastCurrent = dropV / m_resistance;

        matrix.addConductance(m_pins[kLeft], m_pins[kRight], 1.0 / m_resistance);

        matrix.addConductanceToGround(m_pins[kOut], kOutConductance);
        matrix.addCurrentToGround(m_pins[kOut], m_lastCurrent * kOutConductance);
    }

    void postStep(uint64_t) override {}

    /** lPin->rPin, convenção passiva -- já era exatamente isto que `m_lastCurrent` computava (Ohm
     * puro, sem termo de corrente injetada), só faltava expor via `current()`. */
    std::optional<double> current() const override { return m_lastCurrent; }

    size_t getState(uint8_t* out, size_t cap) const override {
        if (cap < sizeof(double)) return 0;
        std::memcpy(out, &m_lastCurrent, sizeof(double));
        return sizeof(double);
    }
    void setState(const uint8_t* in, size_t len) override {
        if (len < sizeof(double)) return;
        std::memcpy(&m_lastCurrent, in, sizeof(double));
    }

    std::vector<PropertyDescriptor> propertyDescriptors() override {
        PropertyDescriptor resistance{"resistance", "Ω", [this] { return PropertyValue{m_resistance}; },
                                       [this](const PropertyValue& v) {
                                           if (const double* d = std::get_if<double>(&v)) {
                                               m_resistance = *d < 1e-12 ? 1e-12 : *d;
                                           }
                                       }};
        resistance.schema = propertySchema().front();
        return {resistance};
    }

    /** ABI v2 (.spec/lasecsimul-native-devices.spec) -- `getState()` é 1 double de corrente. */
    static ReadoutFormat readoutFormat() {
        ReadoutFormat format;
        format.kind = ReadoutKind::Scalar;
        format.unit = "A";
        return format;
    }

    static std::vector<PropertySchema> propertySchema() {
        PropertySchema resistance;
        resistance.id = "resistance";
        resistance.label = "Resistência Interna";
        resistance.group = "Leitura";
        resistance.unit = "Ω";
        resistance.valueKind = PropertyValueKind::Number;
        resistance.editor = "number";
        resistance.defaultValue = 1e-6;
        resistance.minValue = 1e-12;
        resistance.flags |= PropertySchemaShowOnSymbol;
        return {resistance};
    }

private:
    static constexpr size_t kLeft = 0;
    static constexpr size_t kRight = 1;
    static constexpr size_t kOut = 2;
    static constexpr double kOutConductance = 1e9;

    std::array<Pin, 3> m_pins;
    double m_resistance;
    double m_lastCurrent = 0.0;
};

} // namespace lasecsimul::components
