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
 * Porta de `SimulIDE-dev/src/components/meters/oscope.cpp` — osciloscópio de 4 canais (mesmo
 * `m_timePos[4]`/`m_voltDiv[4]` do original), todos alta impedância. Cada canal amostra a tensão a
 * cada `stamp()`, mas só GRAVA no histórico quando passou `m_sampleIntervalNs` de tempo SIMULADO
 * desde a última amostra gravada (mesmo padrão de `nowNs()` de `FreqMeter`/`Clock`/`WaveGen`) --
 * sem isso, `stamp()` roda a cada settle (pode ser várias vezes por ns simulado em transientes),
 * gravar tudo encheria o buffer com amostras redundantes do MESMO instante.
 *
 * **Buffer de histórico com tempo real** (2026-06-29, resolve a limitação documentada antes desta
 * data): `kHistoryCapacity` amostras por canal, timestamp de verdade (`Scheduler::nowNs()`, tempo
 * SIMULADO do circuito, não tempo de parede da Extension) -- a janela "Expande" da Webview
 * (`extension/src/ui/webview/main.ts`) lê isso via `getComponentState()` em vez de acumular uma
 * amostra por poll de IPC (~300ms de parede, sem relação com o clock do circuito). Janela de
 * captura real = `kHistoryCapacity * sampleIntervalNs` (default 512 * 50µs = ~25.6ms simulados,
 * dá pra ver vários períodos de um sinal de até alguns kHz -- `sampleIntervalNs` é propriedade
 * editável pra quem precisar de mais alcance, ao custo de resolução).
 *
 * **Limitação que CONTINUA existindo**: a janela de plotagem gráfica interativa em si (zoom,
 * trigger por hardware, divisão de tempo/tensão por canal) é UI da Extension/Webview, não do Core
 * -- aqui só o sensoriamento elétrico + histórico temporal real estão implementados;
 * `filter`/`autoSC`/`tracks` continuam expostos como propriedades pra bater "todas as propriedades"
 * do original, mesmo sem efeito visual ainda (decisão de escopo inalterada, só a base de tempo do
 * histórico mudou).
 */
class Oscope final : public IComponentModel {
public:
    static constexpr size_t kChannelCount = 4;
    static constexpr size_t kPinCount = kChannelCount + 1;
    static constexpr size_t kHistoryCapacity = 512;

    explicit Oscope(simulation::Scheduler& scheduler, std::array<Pin, kPinCount> pins)
        : m_scheduler(scheduler), m_pins(std::move(pins)) {}

    const char* typeId() const override { return "meters.oscope"; }
    std::span<Pin> pins() override { return m_pins; }
    void onPinConnectionChanged(size_t pinIndex, bool connected) override {
        if (pinIndex == kReferencePin) m_referenceConnected = connected;
    }

    void stamp(MnaMatrixView& matrix) override {
        const uint64_t now = m_scheduler.nowNs();
        const bool dueSample = now - m_lastSampleNs >= m_sampleIntervalNs;
        const double reference = m_referenceConnected ? matrix.getNodeVoltage(m_pins[kReferencePin]) : 0.0;
        for (size_t ch = 0; ch < kChannelCount; ++ch) {
            m_lastVoltages[ch] = matrix.getNodeVoltage(m_pins[ch]) - reference;
            if (m_referenceConnected) matrix.addConductance(m_pins[ch], m_pins[kReferencePin], kInputConductance);
            else matrix.addConductanceToGround(m_pins[ch], kInputConductance);
            if (dueSample) m_history[ch][m_writeIndex] = Sample{now, m_lastVoltages[ch]};
        }
        matrix.addConductanceToGround(m_pins[kReferencePin], kInputConductance);
        if (dueSample) {
            m_lastSampleNs = now;
            m_writeIndex = (m_writeIndex + 1) % kHistoryCapacity;
            if (m_count < kHistoryCapacity) ++m_count;
        }
    }

    void postStep(uint64_t) override {}

    /** Formato: [0..32) 4 doubles (última leitura, compatível com leitores antigos que só olhavam
     * isso) + [32..36) uint32 nº de amostras gravadas por canal + histórico CHANNEL-MAJOR (canal 0
     * inteiro, depois canal 1, ...), cada amostra {uint64 timestampNs, double value}, em ordem
     * cronológica (mais antiga primeiro). `cap` insuficiente devolve 0 (mesmo contrato de sempre,
     * nunca escreve parcial) -- quem chama (`SimulationSession::getComponentState`) já reserva
     * espaço de sobra pro tamanho típico deste componente. */
    size_t getState(uint8_t* out, size_t cap) const override {
        const uint32_t sampleCount = static_cast<uint32_t>(m_count);
        const size_t needed = sizeof(m_lastVoltages) + sizeof(uint32_t) + kChannelCount * sampleCount * kSampleBytes;
        if (cap < needed) return 0;

        size_t offset = 0;
        std::memcpy(out + offset, m_lastVoltages.data(), sizeof(m_lastVoltages));
        offset += sizeof(m_lastVoltages);
        std::memcpy(out + offset, &sampleCount, sizeof(uint32_t));
        offset += sizeof(uint32_t);
        for (size_t ch = 0; ch < kChannelCount; ++ch) {
            for (uint32_t i = 0; i < sampleCount; ++i) {
                const Sample& sample = sampleAt(ch, i);
                std::memcpy(out + offset, &sample.timestampNs, sizeof(uint64_t));
                offset += sizeof(uint64_t);
                std::memcpy(out + offset, &sample.value, sizeof(double));
                offset += sizeof(double);
            }
        }
        return offset;
    }
    void setState(const uint8_t* in, size_t len) override {
        if (len < sizeof(m_lastVoltages)) return;
        std::memcpy(m_lastVoltages.data(), in, sizeof(m_lastVoltages));
        // Histórico não é restaurado por setState() (snapshot/undo) -- recomeça do zero, mesmo
        // espírito de não reintroduzir estado complexo num caminho pensado pra valores escalares.
    }

    std::vector<PropertyDescriptor> propertyDescriptors() override { return toPropertyDescriptors(properties()); }

    std::vector<PropertyDefinition> properties() {
        const std::vector<PropertySchema> schemas = propertySchema();
        const PropertySchema filterSchema = schemaById(schemas, "filter");
        const PropertySchema autoScaleSchema = schemaById(schemas, "autoScale");
        const PropertySchema tracksSchema = schemaById(schemas, "tracks");
        const PropertySchema sampleIntervalSchema = schemaById(schemas, "sampleIntervalNs");
        return {
            PropertyDefinition{
                filterSchema,
                [this] { return PropertyValue{m_filter}; },
                [this, filterSchema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(filterSchema, v)) return {false, *error};
                    m_filter = std::get<double>(v);
                    return {true, {}};
                },
            },
            PropertyDefinition{
                autoScaleSchema,
                [this] { return PropertyValue{m_autoScale}; },
                [this, autoScaleSchema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(autoScaleSchema, v)) return {false, *error};
                    m_autoScale = std::get<bool>(v);
                    return {true, {}};
                },
            },
            PropertyDefinition{
                tracksSchema,
                [this] { return PropertyValue{static_cast<double>(m_tracks)}; },
                [this, tracksSchema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(tracksSchema, v)) return {false, *error};
                    m_tracks = static_cast<int>(std::get<double>(v));
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

    /** ABI v2 (.spec/lasecsimul-native-devices.spec) -- declara que `getState()` começa com 4
     * canais de histórico temporal, pra Webview decodificar sem checar typeId. */
    static ReadoutFormat readoutFormat() {
        ReadoutFormat format;
        format.kind = ReadoutKind::ChannelHistory;
        format.channels = kChannelCount;
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
        filter.defaultValue = 0.0;

        PropertySchema autoSc;
        autoSc.id = "autoScale";
        autoSc.label = "Auto Escala";
        autoSc.group = "Leitura";
        autoSc.valueKind = PropertyValueKind::Bool;
        autoSc.editor = "checkbox";
        autoSc.defaultValue = true;

        PropertySchema tracks;
        tracks.id = "tracks";
        tracks.label = "Canais Visíveis";
        tracks.group = "Leitura";
        tracks.valueKind = PropertyValueKind::Number;
        tracks.editor = "number";
        tracks.defaultValue = 4.0;
        tracks.minValue = 1.0;
        tracks.maxValue = 4.0;

        PropertySchema sampleInterval;
        sampleInterval.id = "sampleIntervalNs";
        sampleInterval.label = "Intervalo de Amostra";
        sampleInterval.group = "Leitura";
        sampleInterval.unit = "ns";
        sampleInterval.valueKind = PropertyValueKind::Number;
        sampleInterval.editor = "number";
        sampleInterval.defaultValue = 50000.0;
        sampleInterval.minValue = 1.0;

        return {filter, autoSc, tracks, sampleInterval};
    }

private:
    struct Sample {
        uint64_t timestampNs = 0;
        double value = 0.0;
    };
    static constexpr size_t kSampleBytes = sizeof(uint64_t) + sizeof(double);
    static constexpr double kInputConductance = 1e-9;

    /** Amostra `index`-ésima em ordem cronológica (0 = mais antiga ainda no buffer) -- traduz pro
     * índice físico do ring buffer (`m_writeIndex` é onde a PRÓXIMA amostra entra, então a mais
     * antiga viva é `m_writeIndex` quando o buffer já deu a volta, ou índice 0 enquanto não deu). */
    const Sample& sampleAt(size_t channel, uint32_t index) const {
        const size_t physical = m_count < kHistoryCapacity ? index : (m_writeIndex + index) % kHistoryCapacity;
        return m_history[channel][physical];
    }

    simulation::Scheduler& m_scheduler;
    static constexpr size_t kReferencePin = kChannelCount;
    std::array<Pin, kPinCount> m_pins;
    std::array<double, kChannelCount> m_lastVoltages{};
    std::array<std::array<Sample, kHistoryCapacity>, kChannelCount> m_history{};
    size_t m_writeIndex = 0;
    size_t m_count = 0;
    uint64_t m_lastSampleNs = 0;
    uint64_t m_sampleIntervalNs = 50'000; // 50µs -- ver doc da classe pra janela total resultante
    double m_filter = 0.0;
    bool m_autoScale = true;
    int m_tracks = 4;
    bool m_referenceConnected = false;
};

} // namespace lasecsimul::components
