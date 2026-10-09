#pragma once

#include <algorithm>
#include <array>
#include <cstring>
#include <optional>
#include <string>
#include "lasecsimul/IComponentModel.hpp"
#include "lasecsimul/PropertyDefinition.hpp"
#include "simulation/Scheduler.hpp"
#include "InstrumentTunnels.hpp"

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
 *
 * **Entrada (`inputMode`)**, como nos instrumentos reais:
 * - `single` (convencional, padrão): os 4 canais medem contra o borne G, que é a referência comum
 *   do aparelho (num osciloscópio de bancada, o terra). Sem G ligado, os canais medem contra o
 *   terra do circuito.
 * - `differential`: 2 canais com entrada diferencial isolada (ponta diferencial / canais
 *   isolados): CH1 = pino 1 (+) − pino 2 (−), CH2 = pino 3 (+) − pino 4 (−). Nenhum borne é ligado
 *   ao terra e G não é usado, então medir sobre um resistor de um laço 4-20 mA flutuante não
 *   altera o circuito. O histórico mantém 4 colunas; as 2 últimas ficam em 0.
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
    std::optional<std::string> fallbackTunnelNameForPin(std::string_view pinId) const override {
        for (size_t channel = 0; channel < kChannelCount; ++channel) {
            if (m_pins[channel].id == pinId) return m_tunnelNames[channel];
        }
        return std::nullopt;
    }
    void onPinConnectionChanged(size_t pinIndex, bool connected) override {
        if (pinIndex == kReferencePin) m_referenceConnected = connected;
    }

    void stamp(MnaMatrixView& matrix) override {
        if (m_differential) {
            for (size_t ch = 0; ch < kDifferentialChannels; ++ch)
                matrix.addConductance(m_pins[2 * ch], m_pins[2 * ch + 1], kInputConductance);
            return;
        }
        for (size_t ch = 0; ch < kChannelCount; ++ch) {
            if (m_referenceConnected) matrix.addConductance(m_pins[ch], m_pins[kReferencePin], kInputConductance);
            else matrix.addConductanceToGround(m_pins[ch], kInputConductance);
        }
        matrix.addConductanceToGround(m_pins[kReferencePin], kInputConductance);
    }

    /** Lê os canais da solução NOVA, depois de cada solve (ver IComponentModel::observesSolution):
     * ler dentro do stamp() devolvia a solução anterior e só acontecia quando o próprio osciloscópio
     * era reestampado. */
    bool observesSolution() const override { return true; }
    bool observeSolution(const MnaMatrixView& matrix) override {
        if (m_differential) {
            for (size_t ch = 0; ch < kChannelCount; ++ch) {
                m_lastVoltages[ch] = ch < kDifferentialChannels
                    ? matrix.getNodeVoltage(m_pins[2 * ch]) - matrix.getNodeVoltage(m_pins[2 * ch + 1])
                    : 0.0;
            }
        } else {
            const double reference = m_referenceConnected ? matrix.getNodeVoltage(m_pins[kReferencePin]) : 0.0;
            for (size_t ch = 0; ch < kChannelCount; ++ch) m_lastVoltages[ch] = matrix.getNodeVoltage(m_pins[ch]) - reference;
        }
        m_hasReading = true;
        const uint64_t now = m_scheduler.nowNs();
        if (m_count == 0 || now - m_lastSampleNs >= m_sampleIntervalNs) record(now);
        return false;
    }

    /** Amostra e retém: com o circuito parado nada é resolvido e nada seria gravado, e a janela
     * "Expande" ficava vazia num nível DC (ex.: laço 4-20 mA sem HART). Um osciloscópio real
     * continua desenhando o nível: completa o intervalo desde a última amostra com a leitura atual,
     * no intervalo de amostra, limitado ao tamanho do buffer. */
    bool isDynamic() const override { return true; }
    void postStep(uint64_t) override {
        if (!m_hasReading) return;
        const uint64_t now = m_scheduler.nowNs();
        if (m_count > 0 && now < m_lastSampleNs + m_sampleIntervalNs) return;
        uint64_t next = m_count == 0 ? now : m_lastSampleNs + m_sampleIntervalNs;
        const uint64_t window = m_sampleIntervalNs * (kHistoryCapacity - 1);
        if (now - next > window) next = now - window;
        for (; next <= now; next += m_sampleIntervalNs) record(next);
    }

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
    size_t getTelemetryState(uint8_t* out, size_t cap) const override {
        if (cap < sizeof(m_lastVoltages)) return 0;
        std::memcpy(out, m_lastVoltages.data(), sizeof(m_lastVoltages));
        return sizeof(m_lastVoltages);
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
        const PropertySchema tunnelsSchema = schemaById(schemas, "tunnels");
        const PropertySchema inputModeSchema = schemaById(schemas, "inputMode");
        return {
            PropertyDefinition{
                inputModeSchema,
                [this] { return PropertyValue{std::string(m_differential ? "differential" : "single")}; },
                [this, inputModeSchema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(inputModeSchema, v)) return {false, *error};
                    m_differential = std::get<std::string>(v) == "differential";
                    m_lastVoltages.fill(0.0);
                    m_count = 0;
                    m_writeIndex = 0;
                    m_hasReading = false;
                    return {true, {}};
                },
            },
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
            PropertyDefinition{
                tunnelsSchema,
                [this] { return PropertyValue{instrument_tunnels::serialize(m_tunnelNames)}; },
                [this, tunnelsSchema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(tunnelsSchema, v)) return {false, *error};
                    m_tunnelNames = instrument_tunnels::parse<kChannelCount>(std::get<std::string>(v));
                    return {true, {}};
                },
            },
        };
    }

    /** ABI v2 (.spec/archive/legacy-v2/lasecsimul-native-devices.spec) -- declara que `getState()` começa com 4
     * canais de histórico temporal, pra Webview decodificar sem checar typeId. */
    static ReadoutFormat readoutFormat() {
        ReadoutFormat format;
        format.kind = ReadoutKind::ChannelHistory;
        format.channels = kChannelCount;
        return format;
    }

    static std::vector<PropertySchema> propertySchema() {
        PropertySchema inputMode;
        inputMode.id = "inputMode";
        inputMode.label = "Entrada";
        inputMode.group = "Leitura";
        inputMode.valueKind = PropertyValueKind::String;
        inputMode.editor = "select";
        inputMode.defaultValue = std::string("single");
        inputMode.options = {{"single", "Convencional (4 canais, referência G)"},
                             {"differential", "Diferencial (2 canais isolados)"}};
        // Troca quais bornes o instrumento acopla: o grupo elétrico é refeito com a simulação parada.
        inputMode.flags = PropertySchemaAffectsTopology;

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

        return {inputMode, filter, autoSc, tracks, sampleInterval, instrument_tunnels::schema()};
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

    void record(uint64_t timestampNs) {
        for (size_t ch = 0; ch < kChannelCount; ++ch) m_history[ch][m_writeIndex] = Sample{timestampNs, m_lastVoltages[ch]};
        m_lastSampleNs = timestampNs;
        m_writeIndex = (m_writeIndex + 1) % kHistoryCapacity;
        if (m_count < kHistoryCapacity) ++m_count;
    }

    simulation::Scheduler& m_scheduler;
    static constexpr size_t kReferencePin = kChannelCount;
    static constexpr size_t kDifferentialChannels = kChannelCount / 2;
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
    std::array<std::string, kChannelCount> m_tunnelNames{};
    bool m_referenceConnected = false;
    bool m_differential = false;
    bool m_hasReading = false;
};

} // namespace lasecsimul::components
