#pragma once
#include <algorithm>
#include <array>
#include <cstring>
#include <optional>
#include <string>
#include <vector>
#include <nlohmann/json.hpp>
#include "lasecsimul/IComponentModel.hpp"
#include "lasecsimul/PropertyDefinition.hpp"
#include "simulation/Scheduler.hpp"
#include "InstrumentTunnels.hpp"

namespace lasecsimul::components {

/** Analisador vetorial: os oito pinos físicos legados continuam válidos, mas cada canal de
 * aquisição é uma SignalSubscription explícita e pode ter largura 1..64. */
class LogicAnalyzer final : public IComponentModel {
public:
    static constexpr size_t kChannelCount = 8;
    static constexpr size_t kHistoryCapacity = 1024;
    static constexpr uint32_t kVectorMagic = 0x3256414c; // "LAV2" little-endian

    explicit LogicAnalyzer(simulation::Scheduler& scheduler, std::array<Pin, kChannelCount> pins,
                           double thresholdRising, double thresholdFalling)
        : m_scheduler(scheduler), m_pins(std::move(pins)), m_thresholdRising(thresholdRising),
          m_thresholdFalling(thresholdFalling) { resetLegacyChannels(); }

    const char* typeId() const override { return "meters.logic_analyzer"; }
    std::span<Pin> pins() override { return m_pins; }
    std::optional<std::string> fallbackTunnelNameForPin(std::string_view pinId) const override {
        for (size_t channel = 0; channel < kChannelCount; ++channel)
            if (m_pins[channel].id == pinId) return m_tunnelNames[channel];
        return std::nullopt;
    }

    void stamp(MnaMatrixView& matrix) override {
        for (const Pin& pin : m_pins) matrix.addConductanceToGround(pin, kInputConductance);
    }
    void postStep(uint64_t) override {}

    std::vector<SignalSubscription> signalSubscriptions() const override { return m_channels; }
    bool wantsResolvedSignalSample(uint64_t timestampNs) const override {
        return timestampNs >= m_lastSampleNs && timestampNs - m_lastSampleNs >= m_sampleIntervalNs;
    }

    void onResolvedSignalSample(uint64_t timestampNs, std::span<const ResolvedSignal> values) override {
        if (timestampNs - m_lastSampleNs < m_sampleIntervalNs || values.empty()) return;
        if (m_channelStates.size() != values.size()) m_channelStates.assign(values.size(), 0);
        Sample sample;
        sample.timestampNs = timestampNs;
        sample.values.reserve(values.size());
        m_lastLevels = 0;
        for (size_t channel = 0; channel < values.size(); ++channel) {
            uint64_t packed = 0;
            const size_t width = std::min<size_t>(64, values[channel].elements.size());
            for (size_t bit = 0; bit < width; ++bit) {
                const uint64_t mask = uint64_t{1} << bit;
                const double voltage = values[channel].elements[bit];
                bool high = (m_channelStates[channel] & mask) != 0;
                if (voltage > m_thresholdRising) high = true;
                else if (voltage < m_thresholdFalling) high = false;
                if (high) packed |= mask;
            }
            m_channelStates[channel] = packed;
            sample.values.push_back(packed);
            if (channel < 32 && (packed & 1u)) m_lastLevels |= uint32_t{1} << channel;
        }
        m_descriptors.clear();
        for (const ResolvedSignal& value : values) m_descriptors.push_back(value.descriptor);
        m_history[m_writeIndex] = std::move(sample);
        m_lastSampleNs = timestampNs;
        m_writeIndex = (m_writeIndex + 1) % kHistoryCapacity;
        if (m_count < kHistoryCapacity) ++m_count;
    }

    /** V2: legacy latest-mask + magic/version + descritores dimensionais + amostras channel-major. */
    size_t getState(uint8_t* out, size_t cap) const override {
        size_t needed = sizeof(uint32_t) * 2 + sizeof(uint16_t) * 2;
        for (const SignalDescriptor& d : m_descriptors)
            needed += sizeof(uint16_t) * 6 + sizeof(uint8_t) * 2 + d.channelId.size() + d.label.size() + d.source.size();
        size_t packedBytesPerSample = sizeof(uint64_t);
        for (const SignalDescriptor& d : m_descriptors) packedBytesPerSample += std::max<size_t>(1, (d.width + 7) / 8);
        needed += sizeof(uint32_t) + m_count * packedBytesPerSample;
        if (cap < needed) return 0;
        size_t offset = 0;
        auto put = [&](const auto& value) { std::memcpy(out + offset, &value, sizeof(value)); offset += sizeof(value); };
        put(m_lastLevels); put(kVectorMagic);
        const uint16_t version = 2;
        const uint16_t channelCount = static_cast<uint16_t>(m_descriptors.size());
        put(version); put(channelCount);
        for (const SignalDescriptor& d : m_descriptors) {
            const uint16_t idLen = static_cast<uint16_t>(d.channelId.size());
            const uint16_t labelLen = static_cast<uint16_t>(d.label.size());
            const uint16_t sourceLen = static_cast<uint16_t>(d.source.size());
            const uint16_t width = d.width;
            const uint16_t msb = static_cast<uint16_t>(d.msb);
            const uint16_t lsb = static_cast<uint16_t>(d.lsb);
            const uint8_t kind = static_cast<uint8_t>(d.kind), reserved = 0;
            put(idLen); put(labelLen); put(sourceLen); put(width); put(msb); put(lsb); put(kind); put(reserved);
            for (const std::string* text : {&d.channelId, &d.label, &d.source}) {
                std::memcpy(out + offset, text->data(), text->size()); offset += text->size();
            }
        }
        const uint32_t sampleCount = static_cast<uint32_t>(m_count); put(sampleCount);
        for (uint32_t i = 0; i < sampleCount; ++i) {
            const Sample& sample = sampleAt(i); put(sample.timestampNs);
            for (size_t channel = 0; channel < m_descriptors.size(); ++channel) {
                const uint64_t value = channel < sample.values.size() ? sample.values[channel] : 0;
                const size_t byteCount = std::max<size_t>(1, (m_descriptors[channel].width + 7) / 8);
                for (size_t byte = 0; byte < byteCount; ++byte) out[offset++] = static_cast<uint8_t>(value >> (byte * 8));
            }
        }
        return offset;
    }
    size_t getTelemetryState(uint8_t* out, size_t cap) const override {
        if (cap < sizeof(m_lastLevels)) return 0;
        std::memcpy(out, &m_lastLevels, sizeof(m_lastLevels));
        return sizeof(m_lastLevels);
    }
    void setState(const uint8_t* in, size_t len) override {
        if (len >= sizeof(m_lastLevels)) std::memcpy(&m_lastLevels, in, sizeof(m_lastLevels));
    }

    std::vector<PropertyDescriptor> propertyDescriptors() override { return toPropertyDescriptors(properties()); }
    std::vector<PropertyDefinition> properties() {
        const auto schemas = propertySchema();
        const auto rising = schemaById(schemas, "thresholdRising");
        const auto falling = schemaById(schemas, "thresholdFalling");
        const auto interval = schemaById(schemas, "sampleIntervalNs");
        const auto tunnels = schemaById(schemas, "tunnels");
        const auto channels = schemaById(schemas, "signalChannels");
        return {
            {rising, [this]{ return PropertyValue{m_thresholdRising}; }, [this,rising](const PropertyValue& v){ if(auto e=validatePropertyValue(rising,v)) return PropertyBindResult{false,*e}; m_thresholdRising=std::get<double>(v); return PropertyBindResult{true,{}}; }},
            {falling, [this]{ return PropertyValue{m_thresholdFalling}; }, [this,falling](const PropertyValue& v){ if(auto e=validatePropertyValue(falling,v)) return PropertyBindResult{false,*e}; m_thresholdFalling=std::get<double>(v); return PropertyBindResult{true,{}}; }},
            {interval, [this]{ return PropertyValue{static_cast<double>(m_sampleIntervalNs)}; }, [this,interval](const PropertyValue& v){ if(auto e=validatePropertyValue(interval,v)) return PropertyBindResult{false,*e}; m_sampleIntervalNs=static_cast<uint64_t>(std::max(1.0,std::get<double>(v))); return PropertyBindResult{true,{}}; }},
            {tunnels, [this]{ return PropertyValue{instrument_tunnels::serialize(m_tunnelNames)}; }, [this,tunnels](const PropertyValue& v){ if(auto e=validatePropertyValue(tunnels,v)) return PropertyBindResult{false,*e}; m_tunnelNames=instrument_tunnels::parse<kChannelCount>(std::get<std::string>(v)); return PropertyBindResult{true,{}}; }},
            {channels, [this]{ return PropertyValue{serializeChannels()}; }, [this,channels](const PropertyValue& v){ if(auto e=validatePropertyValue(channels,v)) return PropertyBindResult{false,*e}; return parseChannels(std::get<std::string>(v)); }},
        };
    }

    static ReadoutFormat readoutFormat() { ReadoutFormat f; f.kind = ReadoutKind::VectorHistory; f.channels = kChannelCount; return f; }
    static std::vector<PropertySchema> propertySchema() {
        PropertySchema r{"thresholdRising","Limiar Lógico ↑ (Rising)","Leitura","V",PropertyValueKind::Number,"number",2.5};
        PropertySchema f{"thresholdFalling","Limiar Lógico ↓ (Falling)","Leitura","V",PropertyValueKind::Number,"number",2.5};
        PropertySchema i{"sampleIntervalNs","Intervalo de Amostra","Leitura","ns",PropertyValueKind::Number,"number",50000.0}; i.minValue=1.0;
        PropertySchema c{"signalChannels","Canais de Sinal","Aquisição","",PropertyValueKind::String,"text",std::string{}};
        return {r,f,i,instrument_tunnels::schema(),c};
    }

private:
    struct Sample { uint64_t timestampNs=0; std::vector<uint64_t> values; };
    void resetLegacyChannels() {
        m_channels.clear();
        for (size_t i=0;i<kChannelCount;++i) m_channels.push_back({"D"+std::to_string(i),"@self."+m_pins[i].id,"D"+std::to_string(i),SignalValueKind::Digital});
    }
    std::string serializeChannels() const {
        nlohmann::json j=nlohmann::json::array();
        for(const auto& c:m_channels) j.push_back({{"id",c.channelId},{"source",c.source},{"label",c.label},{"kind",c.requestedKind==SignalValueKind::Unsigned?"unsigned":c.requestedKind==SignalValueKind::Analog?"analog":"digital"}});
        return j.dump();
    }
    PropertyBindResult parseChannels(const std::string& raw) {
        if(raw.empty()){ resetLegacyChannels(); return {true,{}}; }
        try {
            const auto j=nlohmann::json::parse(raw); if(!j.is_array()||j.empty()||j.size()>32) return {false,"signalChannels deve ser array JSON com 1..32 canais"};
            std::vector<SignalSubscription> next;
            for(const auto& item:j){
                SignalSubscription c; c.channelId=item.value("id",std::string{}); c.source=item.value("source",std::string{}); c.label=item.value("label",c.channelId);
                const std::string kind=item.value("kind",std::string{"digital"}); c.requestedKind=kind=="unsigned"?SignalValueKind::Unsigned:kind=="analog"?SignalValueKind::Analog:SignalValueKind::Digital;
                if(c.channelId.empty()||c.source.empty()) return {false,"cada canal requer id e source"}; next.push_back(std::move(c));
            }
            m_channels=std::move(next); m_descriptors.clear(); m_count=0; m_writeIndex=0; m_channelStates.clear(); return {true,{}};
        } catch(const std::exception& e){ return {false,std::string("signalChannels JSON inválido: ")+e.what()}; }
    }
    const Sample& sampleAt(uint32_t index) const { const size_t physical=m_count<kHistoryCapacity?index:(m_writeIndex+index)%kHistoryCapacity; return m_history[physical]; }
    static constexpr double kInputConductance=1e-9;
    simulation::Scheduler& m_scheduler;
    std::array<Pin,kChannelCount> m_pins;
    double m_thresholdRising, m_thresholdFalling;
    uint32_t m_lastLevels=0;
    std::vector<SignalSubscription> m_channels;
    std::vector<SignalDescriptor> m_descriptors;
    std::vector<uint64_t> m_channelStates;
    std::array<Sample,kHistoryCapacity> m_history{};
    size_t m_writeIndex=0,m_count=0;
    uint64_t m_lastSampleNs=0,m_sampleIntervalNs=50'000;
    std::array<std::string,kChannelCount> m_tunnelNames{};
};
} // namespace lasecsimul::components
