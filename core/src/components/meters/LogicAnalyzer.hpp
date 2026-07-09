#pragma once

#include <algorithm>
#include <array>
#include <cstring>
#include <optional>
#include <string>
#include "lasecsimul/IComponentModel.hpp"
#include "lasecsimul/PropertyDefinition.hpp"
#include "simulation/Scheduler.hpp"

namespace lasecsimul::components {

/**
 * Porta de `SimulIDE-dev/src/components/meters/logicanalizer.cpp`/`lachannel.cpp` — analisador
 * lógico de 8 canais (`m_pin.resize(8)` no original), alta impedância, cada canal amostrado como
 * nível digital, empacotado num bitmask de 8 bits.
 *
 * **Histerese de 2 limiares** (`thresholdRising`/`thresholdFalling`, porta fiel de
 * `LAnalizer::thresholdR()`/`thresholdF()`): acima de `thresholdRising` o canal vai pra alto,
 * abaixo de `thresholdFalling` vai pra baixo; entre os dois (zona morta) o canal MANTÉM o último
 * nível -- mesmo princípio de um Schmitt trigger de hardware real, evita oscilação espúria do bit
 * quando a tensão fica perto de UM limiar único (ruído cruzando repetidamente um valor fixo geraria
 * transições falsas). Estado de histerese é POR CANAL (`m_channelHigh[8]`), já que cada canal pode
 * estar em lados diferentes da zona morta a qualquer momento.
 *
 * **Buffer de histórico com tempo real** (2026-06-29, mesmo princípio de `Oscope`): grava um
 * bitmask por amostra, só quando passou `sampleIntervalNs` de tempo SIMULADO (`Scheduler::nowNs()`)
 * desde a última gravação -- não a cada `stamp()` (que roda por settle, não por amostra de
 * relógio). Janela "Expande" da Webview lê isso via `getComponentState()` em vez de acumular uma
 * amostra por poll de IPC (~300ms de parede, sem relação com o circuito).
 */
class LogicAnalyzer final : public IComponentModel {
public:
    static constexpr size_t kChannelCount = 8;
    static constexpr size_t kHistoryCapacity = 1024;

    explicit LogicAnalyzer(simulation::Scheduler& scheduler, std::array<Pin, kChannelCount> pins, double thresholdRising, double thresholdFalling)
        : m_scheduler(scheduler), m_pins(std::move(pins)), m_thresholdRising(thresholdRising), m_thresholdFalling(thresholdFalling) {}

    const char* typeId() const override { return "meters.logic_analyzer"; }
    std::span<Pin> pins() override { return m_pins; }

    void stamp(MnaMatrixView& matrix) override {
        m_lastLevels = 0;
        for (size_t ch = 0; ch < kChannelCount; ++ch) {
            const double v = matrix.getNodeVoltage(m_pins[ch]);
            if (v > m_thresholdRising) m_channelHigh[ch] = true;
            else if (v < m_thresholdFalling) m_channelHigh[ch] = false;
            // zona morta entre os dois limiares: mantém m_channelHigh[ch] como estava.
            if (m_channelHigh[ch]) m_lastLevels |= (1u << ch);
            matrix.addConductanceToGround(m_pins[ch], kInputConductance);
        }

        const uint64_t now = m_scheduler.nowNs();
        if (now - m_lastSampleNs >= m_sampleIntervalNs) {
            m_history[m_writeIndex] = Sample{now, m_lastLevels};
            m_lastSampleNs = now;
            m_writeIndex = (m_writeIndex + 1) % kHistoryCapacity;
            if (m_count < kHistoryCapacity) ++m_count;
        }
    }

    void postStep(uint64_t) override {}

    /** Formato: [0..4) uint32 (último bitmask, compatível com leitores antigos) + [4..8) uint32 nº
     * de amostras gravadas + histórico cronológico, cada amostra {uint64 timestampNs, uint32
     * bitmask}. Mesmo contrato de sempre: `cap` insuficiente devolve 0, nunca escreve parcial. */
    size_t getState(uint8_t* out, size_t cap) const override {
        const uint32_t sampleCount = static_cast<uint32_t>(m_count);
        const size_t needed = sizeof(m_lastLevels) + sizeof(uint32_t) + sampleCount * kSampleBytes;
        if (cap < needed) return 0;

        size_t offset = 0;
        std::memcpy(out + offset, &m_lastLevels, sizeof(m_lastLevels));
        offset += sizeof(m_lastLevels);
        std::memcpy(out + offset, &sampleCount, sizeof(uint32_t));
        offset += sizeof(uint32_t);
        for (uint32_t i = 0; i < sampleCount; ++i) {
            const Sample& sample = sampleAt(i);
            std::memcpy(out + offset, &sample.timestampNs, sizeof(uint64_t));
            offset += sizeof(uint64_t);
            std::memcpy(out + offset, &sample.levels, sizeof(uint32_t));
            offset += sizeof(uint32_t);
        }
        return offset;
    }
    void setState(const uint8_t* in, size_t len) override {
        if (len < sizeof(m_lastLevels)) return;
        std::memcpy(&m_lastLevels, in, sizeof(m_lastLevels));
        // Histórico não é restaurado por setState() (snapshot/undo) -- mesma decisão do Oscope.
    }

    std::vector<PropertyDescriptor> propertyDescriptors() override { return toPropertyDescriptors(properties()); }

    std::vector<PropertyDefinition> properties() {
        const std::vector<PropertySchema> schemas = propertySchema();
        const PropertySchema thresholdRisingSchema = schemaById(schemas, "thresholdRising");
        const PropertySchema thresholdFallingSchema = schemaById(schemas, "thresholdFalling");
        const PropertySchema sampleIntervalSchema = schemaById(schemas, "sampleIntervalNs");
        return {
            PropertyDefinition{
                thresholdRisingSchema,
                [this] { return PropertyValue{m_thresholdRising}; },
                [this, thresholdRisingSchema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(thresholdRisingSchema, v)) {
                        return {false, *error};
                    }
                    m_thresholdRising = std::get<double>(v);
                    return {true, {}};
                },
            },
            PropertyDefinition{
                thresholdFallingSchema,
                [this] { return PropertyValue{m_thresholdFalling}; },
                [this, thresholdFallingSchema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(thresholdFallingSchema, v)) {
                        return {false, *error};
                    }
                    m_thresholdFalling = std::get<double>(v);
                    return {true, {}};
                },
            },
            PropertyDefinition{
                sampleIntervalSchema,
                [this] { return PropertyValue{static_cast<double>(m_sampleIntervalNs)}; },
                [this, sampleIntervalSchema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(sampleIntervalSchema, v)) {
                        return {false, *error};
                    }
                    m_sampleIntervalNs = static_cast<uint64_t>(std::max(1.0, std::get<double>(v)));
                    return {true, {}};
                },
            },
        };
    }

    /** ABI v2 (.spec/lasecsimul-native-devices.spec) -- `getState()` é 1 série temporal de
     * {timestamp, bitmask}, não N séries independentes como o Oscope (ver formato em getState()
     * acima) -- por isso BitmaskHistory, não ChannelHistory. */
    static ReadoutFormat readoutFormat() {
        ReadoutFormat format;
        format.kind = ReadoutKind::BitmaskHistory;
        format.channels = kChannelCount;
        return format;
    }

    static std::vector<PropertySchema> propertySchema() {
        PropertySchema thresholdRising;
        thresholdRising.id = "thresholdRising";
        thresholdRising.label = "Limiar Lógico ↑ (Rising)";
        thresholdRising.group = "Leitura";
        thresholdRising.unit = "V";
        thresholdRising.valueKind = PropertyValueKind::Number;
        thresholdRising.editor = "number";
        thresholdRising.defaultValue = 2.5;

        PropertySchema thresholdFalling;
        thresholdFalling.id = "thresholdFalling";
        thresholdFalling.label = "Limiar Lógico ↓ (Falling)";
        thresholdFalling.group = "Leitura";
        thresholdFalling.unit = "V";
        thresholdFalling.valueKind = PropertyValueKind::Number;
        thresholdFalling.editor = "number";
        thresholdFalling.defaultValue = 2.5;

        PropertySchema sampleInterval;
        sampleInterval.id = "sampleIntervalNs";
        sampleInterval.label = "Intervalo de Amostra";
        sampleInterval.group = "Leitura";
        sampleInterval.unit = "ns";
        sampleInterval.valueKind = PropertyValueKind::Number;
        sampleInterval.editor = "number";
        sampleInterval.defaultValue = 50000.0;
        sampleInterval.minValue = 1.0;

        return {thresholdRising, thresholdFalling, sampleInterval};
    }

private:
    struct Sample {
        uint64_t timestampNs = 0;
        uint32_t levels = 0;
    };
    static constexpr size_t kSampleBytes = sizeof(uint64_t) + sizeof(uint32_t);
    static constexpr double kInputConductance = 1e-9;

    const Sample& sampleAt(uint32_t index) const {
        const size_t physical = m_count < kHistoryCapacity ? index : (m_writeIndex + index) % kHistoryCapacity;
        return m_history[physical];
    }

    simulation::Scheduler& m_scheduler;
    std::array<Pin, kChannelCount> m_pins;
    double m_thresholdRising;
    double m_thresholdFalling;
    std::array<bool, kChannelCount> m_channelHigh{};
    uint32_t m_lastLevels = 0;
    std::array<Sample, kHistoryCapacity> m_history{};
    size_t m_writeIndex = 0;
    size_t m_count = 0;
    uint64_t m_lastSampleNs = 0;
    uint64_t m_sampleIntervalNs = 50'000;
};

} // namespace lasecsimul::components
