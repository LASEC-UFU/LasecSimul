#pragma once

#include <array>
#include <cstdint>
#include <optional>
#include "lasecsimul/IComponentModel.hpp"
#include "lasecsimul/PropertyDefinition.hpp"
#include "simulation/Scheduler.hpp"

namespace lasecsimul::components {

/**
 * Porta de `SimulIDE-dev/src/components/sources/clock.cpp` (via `ClockBase`/`FixedVolt`) — gerador
 * de onda quadrada de 1 terminal, alterna entre 0V e `voltage` a `freqHz`. Diferente dos demais
 * built-ins (que só reagem a `stamp()`/eventos de tensão), este precisa se auto-agendar no
 * `Scheduler` pra avançar no tempo sem nenhum estímulo externo — por isso recebe a referência do
 * `Scheduler` no construtor e descobre o próprio `componentIndex` via `onAssignedIndex()` pra poder
 * chamar `markDirty()` depois de cada toggle.
 *
 * Unidade de frequência: o SimulIDE rotula a propriedade "Freq" como "kHz" mas o valor interno
 * (`ClockBase::setFreq`) é literalmente Hz (`m_psPerCycleDbl = 1e12 / freq`); aqui a propriedade já
 * é `freqHz`/"Hz" sem essa ambiguidade de rótulo.
 */
class Clock final : public IComponentModel {
public:
    Clock(simulation::Scheduler& scheduler, Pin pin, double voltage, double freqHz, bool alwaysOn)
        : m_scheduler(scheduler), m_pins{std::move(pin)}, m_voltage(voltage), m_freqHz(freqHz),
          m_alwaysOn(alwaysOn), m_running(alwaysOn) {}

    const char* typeId() const override { return "sources.clock"; }
    std::span<Pin> pins() override { return m_pins; }

    void onAssignedIndex(uint32_t index) override {
        m_componentIndex = index;
        scheduleNextToggle();
    }

    void stamp(MnaMatrixView& matrix) override {
        if (!m_running) {
            m_lastCurrent = 0.0; // parado: sem contribuição real, sem corrente real
            return; // parado: pino fica flutuando (sem contribuição), igual a um pino desconectado
        }
        const double level = m_state ? m_voltage : 0.0;
        // Convenção passiva -- ver Rail::current()/DcVoltageSource::current().
        m_lastCurrent = kConductance * matrix.getNodeVoltage(m_pins[0]) - level * kConductance;
        matrix.addConductanceToGround(m_pins[0], kConductance);
        matrix.addCurrentToGround(m_pins[0], level * kConductance);
    }

    void postStep(uint64_t) override {} // avanço no tempo é via Scheduler::scheduleEvent, não postStep

    std::optional<double> current() const override { return m_lastCurrent; }

    size_t getState(uint8_t* out, size_t cap) const override {
        if (cap < sizeof(bool)) return 0;
        out[0] = m_state ? 1 : 0;
        return sizeof(bool);
    }
    void setState(const uint8_t* in, size_t len) override {
        if (len < sizeof(bool)) return;
        m_state = in[0] != 0;
    }

    std::vector<PropertyDescriptor> propertyDescriptors() override { return toPropertyDescriptors(properties()); }

    std::vector<PropertyDefinition> properties() {
        const std::vector<PropertySchema> schemas = propertySchema();
        const PropertySchema voltageSchema = schemaById(schemas, "voltage");
        const PropertySchema freqSchema = schemaById(schemas, "freqHz");
        const PropertySchema alwaysOnSchema = schemaById(schemas, "alwaysOn");
        const PropertySchema runningSchema = schemaById(schemas, "running");
        return {
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
                freqSchema,
                [this] { return PropertyValue{m_freqHz}; },
                [this, freqSchema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(freqSchema, v)) return {false, *error};
                    setFreqHz(std::get<double>(v));
                    return {true, {}};
                },
            },
            PropertyDefinition{
                alwaysOnSchema,
                [this] { return PropertyValue{m_alwaysOn}; },
                [this, alwaysOnSchema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(alwaysOnSchema, v)) return {false, *error};
                    setAlwaysOn(std::get<bool>(v));
                    return {true, {}};
                },
            },
            PropertyDefinition{
                runningSchema,
                [this] { return PropertyValue{m_running}; },
                [this, runningSchema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(runningSchema, v)) return {false, *error};
                    setRunning(std::get<bool>(v));
                    return {true, {}};
                },
            },
        };
    }

    static std::vector<PropertySchema> propertySchema() {
        PropertySchema voltage;
        voltage.id = "voltage";
        voltage.label = "Tensão";
        voltage.group = "Elétrica";
        voltage.unit = "V";
        voltage.valueKind = PropertyValueKind::Number;
        voltage.editor = "number";
        voltage.defaultValue = 5.0;
        voltage.flags |= PropertySchemaShowOnSymbol;

        PropertySchema freq;
        freq.id = "freqHz";
        freq.label = "Frequência";
        freq.group = "Elétrica";
        freq.unit = "Hz";
        freq.valueKind = PropertyValueKind::Number;
        freq.editor = "number";
        freq.defaultValue = 1000.0;
        freq.minValue = 0.0;

        PropertySchema alwaysOn;
        alwaysOn.id = "alwaysOn";
        alwaysOn.label = "Sempre Ligado";
        alwaysOn.group = "Elétrica";
        alwaysOn.valueKind = PropertyValueKind::Bool;
        alwaysOn.editor = "checkbox";
        alwaysOn.defaultValue = false;

        PropertySchema running;
        running.id = "running";
        running.label = "Rodando";
        running.group = "Elétrica";
        running.valueKind = PropertyValueKind::Bool;
        running.editor = "checkbox";
        running.defaultValue = false;

        return {voltage, freq, alwaysOn, running};
    }

    void setFreqHz(double freq) {
        m_freqHz = freq;
    }

    void setAlwaysOn(bool on) {
        m_alwaysOn = on;
        if (on) setRunning(true);
    }

    void setRunning(bool running) {
        const bool wasRunning = m_running;
        m_running = running && m_freqHz > 0;
        m_scheduler.markDirty(m_componentIndex);
        if (m_running && !wasRunning) scheduleNextToggle(); // religou: reagenda o ciclo
    }

private:
    static constexpr double kConductance = 1e9;
    static constexpr uint32_t kNoIndex = 0xFFFFFFFFu;

    void scheduleNextToggle() {
        if (!m_running || m_freqHz <= 0) return;
        const uint64_t halfPeriodNs = static_cast<uint64_t>(5e8 / m_freqHz);
        m_scheduler.scheduleEvent(halfPeriodNs, [this] { onToggle(); });
    }

    void onToggle() {
        if (!m_running) return; // foi parado entre o agendamento e a execução -- não reagenda
        m_state = !m_state;
        m_scheduler.markDirty(m_componentIndex);
        scheduleNextToggle();
    }

    simulation::Scheduler& m_scheduler;
    std::array<Pin, 1> m_pins;
    double m_voltage;
    double m_freqHz;
    bool m_alwaysOn;
    bool m_running;
    bool m_state = false;
    uint32_t m_componentIndex = kNoIndex;
    double m_lastCurrent = 0.0;
};

} // namespace lasecsimul::components
