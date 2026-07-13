#pragma once

#include <algorithm>
#include <cstring>
#include <string_view>
#include <vector>
#include "lasecsimul/IComponentModel.hpp"
#include "lasecsimul/PropertyDefinition.hpp"

namespace lasecsimul::components {

/** Split/merge de barramento, equivalente funcional de logic/bus.cpp do SimulIDE. `bit-0` é o
 * LSB; `bus-in` e `bus-out` representam o mesmo vetor ordenado e podem ser ligados somente a um
 * endpoint de igual largura. As portas `bit-N` são a divisão escalar explícita. */
class Bus final : public IComponentModel {
public:
    Bus(size_t width, size_t startBit) : m_width(std::max<size_t>(1, width)), m_startBit(startBit) { rebuildPins(); }

    const char* typeId() const override { return "connectors.bus"; }
    std::span<Pin> pins() override { return m_pins; }

    std::optional<std::vector<std::string>> busEndpointPinIds(std::string_view pinId) const override {
        if (pinId != "bus-in" && pinId != "bus-out") return std::nullopt;
        std::vector<std::string> ids;
        ids.reserve(m_width);
        for (size_t i = 0; i < m_width; ++i) ids.push_back(bitPinId(i));
        return ids;
    }

    std::span<const uint32_t> leakagePinIndices() const override { return m_leakageIndices; }
    void stamp(MnaMatrixView& matrix) override {
        m_lastValue = 0;
        for (size_t i = 0; i < m_width && i < 64; ++i) {
            if (matrix.getNodeVoltage(m_pins[i]) > 2.5) m_lastValue |= uint64_t{1} << i;
        }
    }
    void postStep(uint64_t) override {}
    size_t getState(uint8_t* out, size_t cap) const override {
        if (cap < sizeof(uint64_t)) return 0;
        std::memcpy(out, &m_lastValue, sizeof(m_lastValue));
        return sizeof(m_lastValue);
    }
    void setState(const uint8_t*, size_t) override {}

    std::vector<PropertyDescriptor> propertyDescriptors() override { return toPropertyDescriptors(properties()); }
    std::vector<PropertyDefinition> properties() {
        const auto schemas = propertySchema();
        const auto widthSchema = schemaById(schemas, "width");
        const auto startSchema = schemaById(schemas, "startBit");
        return {
            PropertyDefinition{widthSchema, [this] { return PropertyValue{static_cast<double>(m_width)}; },
                [this, widthSchema](const PropertyValue& value) -> PropertyBindResult {
                    if (auto error = validatePropertyValue(widthSchema, value)) return {false, *error};
                    m_width = static_cast<size_t>(std::get<double>(value));
                    rebuildPins();
                    return {true, {}};
                }},
            PropertyDefinition{startSchema, [this] { return PropertyValue{static_cast<double>(m_startBit)}; },
                [this, startSchema](const PropertyValue& value) -> PropertyBindResult {
                    if (auto error = validatePropertyValue(startSchema, value)) return {false, *error};
                    m_startBit = static_cast<size_t>(std::get<double>(value));
                    rebuildPins();
                    return {true, {}};
                }},
        };
    }

    static std::vector<PropertySchema> propertySchema() {
        PropertySchema width{"width", "Largura", "Barramento", "bits", PropertyValueKind::Number,
                             "number", 8.0};
        width.minValue = 1.0;
        width.maxValue = 64.0;
        width.flags = PropertySchemaAffectsPinCount | PropertySchemaAffectsTopology;
        PropertySchema start{"startBit", "Bit inicial", "Barramento", "", PropertyValueKind::Number,
                             "number", 0.0};
        start.minValue = 0.0;
        start.maxValue = 65535.0;
        start.flags = PropertySchemaAffectsPinCount | PropertySchemaAffectsTopology;
        return {width, start};
    }

private:
    std::string bitPinId(size_t offset) const { return "bit-" + std::to_string(m_startBit + offset); }
    void rebuildPins() {
        m_pins.clear();
        m_pins.reserve(m_width + 2);
        for (size_t i = 0; i < m_width; ++i) m_pins.push_back(Pin{bitPinId(i)});
        m_pins.push_back(Pin{"bus-in"});
        m_pins.push_back(Pin{"bus-out"});
        m_leakageIndices.resize(m_pins.size());
        for (size_t i = 0; i < m_leakageIndices.size(); ++i) m_leakageIndices[i] = static_cast<uint32_t>(i);
    }

    size_t m_width;
    size_t m_startBit;
    std::vector<Pin> m_pins;
    std::vector<uint32_t> m_leakageIndices;
    uint64_t m_lastValue = 0;
};

} // namespace lasecsimul::components
