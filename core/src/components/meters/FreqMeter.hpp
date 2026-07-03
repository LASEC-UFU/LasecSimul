#pragma once

#include <array>
#include <cmath>
#include <cstring>
#include "lasecsimul/IComponentModel.hpp"
#include "simulation/Scheduler.hpp"

namespace lasecsimul::components {

/**
 * Porta de `SimulIDE-dev/src/components/meters/freqmeter.cpp` — frequencímetro de 1 pino, alta
 * impedância, mede frequência por detecção de borda (subida/queda) com filtro de ruído (`filter`,
 * mesmo papel do `m_filter` original). Recebe o `Scheduler` (mesmo padrão de `Clock`/`WaveGen`) só
 * pra ler `nowNs()` -- não se auto-agenda, só usa o tempo atual a cada `stamp()` pra medir o
 * período entre picos.
 */
class FreqMeter final : public IComponentModel {
public:
    FreqMeter(simulation::Scheduler& scheduler, Pin pin, double filter)
        : m_scheduler(scheduler), m_pins{std::move(pin)}, m_filter(filter) {}

    const char* typeId() const override { return "meters.freqmeter"; }
    std::span<Pin> pins() override { return m_pins; }

    void stamp(MnaMatrixView& matrix) override {
        const double data = matrix.getNodeVoltage(m_pins[0]);
        matrix.addConductanceToGround(m_pins[0], kInputConductance); // alta impedância, nunca zero

        const double delta = data - m_lastData;
        const uint64_t now = m_scheduler.nowNs();

        if (delta > m_filter) { // subida
            if (m_falling && !m_rising) m_falling = false;
            m_rising = true;
            m_lastData = data;
        } else if (delta < -m_filter) { // queda
            if (m_rising && !m_falling) { // pico encontrado
                if (m_numMax > 0) {
                    const uint64_t period = now - m_lastMax;
                    m_totalPeriod += period;
                }
                m_lastMax = now;
                m_numMax++;
                m_rising = false;
            }
            m_falling = true;
            m_lastData = data;
        }

        if (m_numMax > 1) {
            m_freqHz = 1e9 / (static_cast<double>(m_totalPeriod) / static_cast<double>(m_numMax - 1));
            m_totalPeriod = 0;
            m_numMax = 0;
        }
    }

    void postStep(uint64_t) override {}

    size_t getState(uint8_t* out, size_t cap) const override {
        if (cap < sizeof(double)) return 0;
        std::memcpy(out, &m_freqHz, sizeof(double));
        return sizeof(double);
    }
    void setState(const uint8_t* in, size_t len) override {
        if (len < sizeof(double)) return;
        std::memcpy(&m_freqHz, in, sizeof(double));
    }

    std::vector<PropertyDescriptor> propertyDescriptors() override {
        PropertyDescriptor filter{"filter", "V", [this] { return PropertyValue{m_filter}; },
                                   [this](const PropertyValue& v) {
                                       if (const double* d = std::get_if<double>(&v)) m_filter = *d;
                                   }};
        filter.schema = propertySchema().front();
        return {filter};
    }

    /** ABI v2 (.spec/lasecsimul-native-devices.spec) -- `getState()` é 1 double de frequência. */
    static ReadoutFormat readoutFormat() {
        ReadoutFormat format;
        format.kind = ReadoutKind::Scalar;
        format.unit = "Hz";
        return format;
    }

    static std::vector<PropertySchema> propertySchema() {
        PropertySchema filter;
        filter.id = "filter";
        filter.label = "Filtro";
        filter.group = "Leitura";
        filter.unit = "V";
        filter.valueKind = PropertyValueKind::Number;
        filter.editor = "number";
        filter.defaultValue = 0.1;
        return {filter};
    }

private:
    static constexpr double kInputConductance = 1e-9;

    simulation::Scheduler& m_scheduler;
    std::array<Pin, 1> m_pins;
    double m_filter;
    bool m_rising = false;
    bool m_falling = false;
    double m_lastData = 0.0;
    double m_freqHz = 0.0;
    uint64_t m_lastMax = 0;
    uint64_t m_totalPeriod = 0;
    uint64_t m_numMax = 0;
};

} // namespace lasecsimul::components
