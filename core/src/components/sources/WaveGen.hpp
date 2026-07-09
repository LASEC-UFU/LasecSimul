#pragma once

#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <optional>
#include <string>
#include "lasecsimul/IComponentModel.hpp"
#include "lasecsimul/PropertyDefinition.hpp"
#include "simulation/Scheduler.hpp"

namespace lasecsimul::components {

/**
 * Porta de `SimulIDE-dev/src/components/sources/wavegen.cpp` (via `ClockBase`) — gerador de forma
 * de onda de 2 terminais (`out`/`gnd`, mesmo `m_pin.resize(2)` do original; `gnd` só importa em
 * modo bipolar+flutuante, mas existe sempre, pra bater o número de pinos). Amostra a forma de onda
 * `kSamplesPerCycle` vezes por ciclo via `Scheduler::scheduleEvent` (mesmo princípio de auto-
 * agendamento do `Clock`) -- não replica o `m_minSteps`/escalonamento de `AnalogClock` do SimulIDE,
 * que é um detalhe de performance do stepping discreto dele, irrelevante aqui.
 *
 * **Limitação documentada**: tipo de onda "Wav" (carregar arquivo de áudio) não gera nada (sempre
 * 0) -- não há infraestrutura de leitura de áudio no Core e isso seria um projeto à parte; a
 * propriedade `waveType`/`file` continuam expostas (pra bater "todas as propriedades" do
 * original), só o carregamento real do arquivo é que não está implementado.
 */
class WaveGen final : public IComponentModel {
public:
    enum class WaveType { Sine, Saw, Triangle, Square, Random, Wav };

    WaveGen(simulation::Scheduler& scheduler, std::array<Pin, 2> pins, double freqHz)
        : m_scheduler(scheduler), m_pins(std::move(pins)), m_freqHz(freqHz) {
        recomputeBase();
    }

    const char* typeId() const override { return "sources.wave_gen"; }
    std::span<Pin> pins() override { return m_pins; }

    void onAssignedIndex(uint32_t index) override {
        m_componentIndex = index;
        scheduleNextSample();
    }

    void stamp(MnaMatrixView& matrix) override {
        const double vOut = currentSample(); // [0,1]
        // Convenção passiva em todo ramo -- ver Rail::current()/Battery::current(). "Corrente
        // principal" reportada é sempre a do pino `out`, mesmo nos modos com 2 referências de
        // terra independentes (bipolar não-flutuante): simplificação documentada, não esconder.
        if (m_bipolar) {
            const double volt = m_semiAmplitude * 2.0 * (vOut - 0.5);
            if (m_floating) {
                // Fonte flutuante: corrente entre os 2 pinos, sem referência à terra global (mesma
                // técnica de Norton de alta impedância do `m_outpin->stampCurrent(volt*high_imp)`
                // original). addCurrent(a,b,I): I sai de a, entra em b -- volt positivo deve
                // empurrar corrente PRA FORA de `out`, então o ramo interno sai de `gnd` e entra em
                // `out` (mesma convenção de Battery/Csource).
                m_lastCurrent = -(volt * kHighImpAdmittance); // formula: só addCurrent(gnd,out,I) -> -I
                matrix.addCurrent(m_pins[kGnd], m_pins[kOut], volt * kHighImpAdmittance);
            } else {
                const double outTarget = m_midVoltage + volt / 2.0;
                m_lastCurrent = kConductance * matrix.getNodeVoltage(m_pins[kOut]) - outTarget * kConductance;
                matrix.addConductanceToGround(m_pins[kOut], kConductance);
                matrix.addCurrentToGround(m_pins[kOut], outTarget * kConductance);
                matrix.addConductanceToGround(m_pins[kGnd], kConductance);
                matrix.addCurrentToGround(m_pins[kGnd], (m_midVoltage - volt / 2.0) * kConductance);
            }
        } else {
            const double outTarget = m_voltBase + m_semiAmplitude * 2.0 * vOut;
            m_lastCurrent = kConductance * matrix.getNodeVoltage(m_pins[kOut]) - outTarget * kConductance;
            matrix.addConductanceToGround(m_pins[kOut], kConductance);
            matrix.addCurrentToGround(m_pins[kOut], outTarget * kConductance);
            // `gnd` precisa de ALGUMA contribuição mesmo "não usado" neste modo -- todo pino de um
            // componente cai no mesmo CircuitGroup (mesmo sem fio nenhum conectado), então deixar a
            // linha de `gnd` inteiramente zerada deixa a matriz do grupo singular (sem nenhuma
            // referência), o que zera o grupo INTEIRO via fallback do MnaSolver -- inclusive `out`,
            // que está corretamente estampado. Fixar `gnd` em 0V é também a leitura mais física do
            // próprio nome do pino fora do modo bipolar.
            matrix.addConductanceToGround(m_pins[kGnd], kConductance);
        }
    }

    void postStep(uint64_t) override {}

    std::optional<double> current() const override { return m_lastCurrent; }

    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}

    std::vector<PropertyDescriptor> propertyDescriptors() override { return toPropertyDescriptors(properties()); }

    std::vector<PropertyDefinition> properties() {
        const std::vector<PropertySchema> schemas = propertySchema();
        const PropertySchema waveTypeSchema = schemaById(schemas, "waveType");
        const PropertySchema freqSchema = schemaById(schemas, "freqHz");
        const PropertySchema phaseSchema = schemaById(schemas, "phaseShift");
        const PropertySchema dutySchema = schemaById(schemas, "duty");
        const PropertySchema fileSchema = schemaById(schemas, "file");
        const PropertySchema alwaysOnSchema = schemaById(schemas, "alwaysOn");
        const PropertySchema bipolarSchema = schemaById(schemas, "bipolar");
        const PropertySchema floatingSchema = schemaById(schemas, "floating");
        const PropertySchema semiAmpliSchema = schemaById(schemas, "semiAmplitude");
        const PropertySchema midVoltSchema = schemaById(schemas, "midVoltage");
        return {
            PropertyDefinition{
                waveTypeSchema,
                [this] { return PropertyValue{waveTypeToString(m_waveType)}; },
                [this, waveTypeSchema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(waveTypeSchema, v)) return {false, *error};
                    setWaveType(std::get<std::string>(v));
                    return {true, {}};
                },
            },
            PropertyDefinition{
                freqSchema,
                [this] { return PropertyValue{m_freqHz}; },
                [this, freqSchema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(freqSchema, v)) return {false, *error};
                    m_freqHz = std::get<double>(v);
                    return {true, {}};
                },
            },
            PropertyDefinition{
                phaseSchema,
                [this] { return PropertyValue{m_phaseShift}; },
                [this, phaseSchema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(phaseSchema, v)) return {false, *error};
                    m_phaseShift = std::get<double>(v);
                    return {true, {}};
                },
            },
            PropertyDefinition{
                dutySchema,
                [this] { return PropertyValue{m_duty}; },
                [this, dutySchema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(dutySchema, v)) return {false, *error};
                    m_duty = std::min(100.0, std::get<double>(v));
                    return {true, {}};
                },
            },
            PropertyDefinition{
                fileSchema,
                [this] { return PropertyValue{m_file}; },
                [this, fileSchema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(fileSchema, v)) return {false, *error};
                    m_file = std::get<std::string>(v);
                    return {true, {}};
                },
            },
            PropertyDefinition{
                alwaysOnSchema,
                [this] { return PropertyValue{m_alwaysOn}; },
                [this, alwaysOnSchema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(alwaysOnSchema, v)) return {false, *error};
                    m_alwaysOn = std::get<bool>(v);
                    return {true, {}};
                },
            },
            PropertyDefinition{
                bipolarSchema,
                [this] { return PropertyValue{m_bipolar}; },
                [this, bipolarSchema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(bipolarSchema, v)) return {false, *error};
                    m_bipolar = std::get<bool>(v);
                    return {true, {}};
                },
            },
            PropertyDefinition{
                floatingSchema,
                [this] { return PropertyValue{m_floating}; },
                [this, floatingSchema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(floatingSchema, v)) return {false, *error};
                    m_floating = std::get<bool>(v);
                    return {true, {}};
                },
            },
            PropertyDefinition{
                semiAmpliSchema,
                [this] { return PropertyValue{m_semiAmplitude}; },
                [this, semiAmpliSchema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(semiAmpliSchema, v)) return {false, *error};
                    m_semiAmplitude = std::get<double>(v);
                    recomputeBase();
                    return {true, {}};
                },
            },
            PropertyDefinition{
                midVoltSchema,
                [this] { return PropertyValue{m_midVoltage}; },
                [this, midVoltSchema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(midVoltSchema, v)) return {false, *error};
                    m_midVoltage = std::get<double>(v);
                    recomputeBase();
                    return {true, {}};
                },
            },
        };
    }

    static std::vector<PropertySchema> propertySchema() {
        PropertySchema waveType;
        waveType.id = "waveType";
        waveType.label = "Tipo de Onda";
        waveType.group = "Elétrica";
        waveType.valueKind = PropertyValueKind::String;
        waveType.editor = "enum";
        waveType.defaultValue = std::string("Sine");
        waveType.options = {{"Sine", "Senoidal"}, {"Saw", "Dente de Serra"}, {"Triangle", "Triangular"},
                             {"Square", "Quadrada"}, {"Random", "Aleatória"}, {"Wav", "Arquivo Wav"}};

        PropertySchema freq;
        freq.id = "freqHz";
        freq.label = "Frequência";
        freq.group = "Elétrica";
        freq.unit = "Hz";
        freq.valueKind = PropertyValueKind::Number;
        freq.editor = "number";
        freq.defaultValue = 1000.0;
        freq.minValue = 0.0;

        PropertySchema phase;
        phase.id = "phaseShift";
        phase.label = "Defasagem";
        phase.group = "Elétrica";
        phase.unit = "º";
        phase.valueKind = PropertyValueKind::Number;
        phase.editor = "number";
        phase.defaultValue = 0.0;

        PropertySchema duty;
        duty.id = "duty";
        duty.label = "Duty";
        duty.group = "Elétrica";
        duty.unit = "%";
        duty.valueKind = PropertyValueKind::Number;
        duty.editor = "number";
        duty.defaultValue = 50.0;
        duty.minValue = 0.0;
        duty.maxValue = 100.0;

        PropertySchema file;
        file.id = "file";
        file.label = "Arquivo Wav";
        file.group = "Elétrica";
        file.valueKind = PropertyValueKind::String;
        file.editor = "text";
        file.defaultValue = std::string{};

        PropertySchema alwaysOn;
        alwaysOn.id = "alwaysOn";
        alwaysOn.label = "Sempre Ligado";
        alwaysOn.group = "Elétrica";
        alwaysOn.valueKind = PropertyValueKind::Bool;
        alwaysOn.editor = "checkbox";
        alwaysOn.defaultValue = true;

        PropertySchema bipolar;
        bipolar.id = "bipolar";
        bipolar.label = "Bipolar";
        bipolar.group = "Elétrica";
        bipolar.valueKind = PropertyValueKind::Bool;
        bipolar.editor = "checkbox";
        bipolar.defaultValue = false;

        PropertySchema floating;
        floating.id = "floating";
        floating.label = "Flutuante";
        floating.group = "Elétrica";
        floating.valueKind = PropertyValueKind::Bool;
        floating.editor = "checkbox";
        floating.defaultValue = false;

        PropertySchema semiAmpli;
        semiAmpli.id = "semiAmplitude";
        semiAmpli.label = "Semi Amplitude";
        semiAmpli.group = "Elétrica";
        semiAmpli.unit = "V";
        semiAmpli.valueKind = PropertyValueKind::Number;
        semiAmpli.editor = "number";
        semiAmpli.defaultValue = 2.5;
        semiAmpli.flags |= PropertySchemaShowOnSymbol;

        PropertySchema midVolt;
        midVolt.id = "midVoltage";
        midVolt.label = "Tensão Média";
        midVolt.group = "Elétrica";
        midVolt.unit = "V";
        midVolt.valueKind = PropertyValueKind::Number;
        midVolt.editor = "number";
        midVolt.defaultValue = 0.0;

        return {waveType, freq, phase, duty, file, alwaysOn, bipolar, floating, semiAmpli, midVolt};
    }

    void setWaveType(const std::string& type) { m_waveType = waveTypeFromString(type); }

private:
    static constexpr double kConductance = 1e9;
    static constexpr double kHighImpAdmittance = 1e-7; // mesma constante low_imp/high_imp~1e7 ohm do SimulIDE
    static constexpr size_t kOut = 0;
    static constexpr size_t kGnd = 1;
    static constexpr uint32_t kNoIndex = 0xFFFFFFFFu;
    static constexpr int kSamplesPerCycle = 100; // ver docstring -- não replica m_minSteps adaptativo
    static constexpr double kPi = 3.14159265358979323846;

    void recomputeBase() { m_voltBase = m_midVoltage - m_semiAmplitude; }

    void scheduleNextSample() {
        if (!m_alwaysOn || m_freqHz <= 0) return;
        const uint64_t intervalNs = static_cast<uint64_t>(1e9 / (m_freqHz * kSamplesPerCycle));
        m_scheduler.scheduleEvent(intervalNs == 0 ? 1 : intervalNs, [this] { onSample(); });
    }

    void onSample() {
        m_phaseIndex = (m_phaseIndex + 1) % kSamplesPerCycle;
        m_scheduler.markDirty(m_componentIndex);
        scheduleNextSample();
    }

    double currentSample() const {
        const int phaseOffset = static_cast<int>(m_phaseShift / 360.0 * kSamplesPerCycle);
        const int index = ((m_phaseIndex + phaseOffset) % kSamplesPerCycle + kSamplesPerCycle) % kSamplesPerCycle;
        const double t = static_cast<double>(index) / kSamplesPerCycle; // [0,1) fração do ciclo

        switch (m_waveType) {
            case WaveType::Sine: return std::sin(t * 2.0 * kPi) / 2.0 + 0.5;
            case WaveType::Saw: return t;
            case WaveType::Triangle: {
                const double halfW = m_duty / 100.0;
                if (halfW <= 0.0) return 0.0;
                return t >= halfW ? 1.0 - (t - halfW) / (1.0 - halfW) : t / halfW;
            }
            case WaveType::Square: return t < (m_duty / 100.0) ? 1.0 : 0.0;
            case WaveType::Random: return static_cast<double>(std::rand()) / static_cast<double>(RAND_MAX);
            case WaveType::Wav: return 0.0; // ver limitação documentada na docstring da classe
        }
        return 0.0;
    }

    static WaveType waveTypeFromString(const std::string& s) {
        if (s == "Saw") return WaveType::Saw;
        if (s == "Triangle") return WaveType::Triangle;
        if (s == "Square") return WaveType::Square;
        if (s == "Random") return WaveType::Random;
        if (s == "Wav") return WaveType::Wav;
        return WaveType::Sine;
    }
    static std::string waveTypeToString(WaveType t) {
        switch (t) {
            case WaveType::Saw: return "Saw";
            case WaveType::Triangle: return "Triangle";
            case WaveType::Square: return "Square";
            case WaveType::Random: return "Random";
            case WaveType::Wav: return "Wav";
            case WaveType::Sine: default: return "Sine";
        }
    }

    simulation::Scheduler& m_scheduler;
    std::array<Pin, 2> m_pins;
    double m_freqHz;
    double m_phaseShift = 0.0;
    double m_duty = 50.0;
    std::string m_file;
    bool m_alwaysOn = true;
    bool m_bipolar = false;
    bool m_floating = false;
    double m_semiAmplitude = 2.5;
    double m_midVoltage = 0.0;
    double m_voltBase = -2.5;
    WaveType m_waveType = WaveType::Sine;
    int m_phaseIndex = 0;
    uint32_t m_componentIndex = kNoIndex;
    double m_lastCurrent = 0.0;
};

} // namespace lasecsimul::components
