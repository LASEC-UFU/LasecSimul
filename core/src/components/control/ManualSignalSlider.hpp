#pragma once

#include <algorithm>
#include <cmath>
#include <span>
#include <vector>

#include "lasecsimul/IComponentModel.hpp"
#include "lasecsimul/PropertyDefinition.hpp"
#include "registry/ComponentParams.hpp"

namespace lasecsimul::components {

/** Operator slider with one Signal Graph output and no electrical terminal. */
class ManualSignalSlider final : public IComponentModel {
public:
    explicit ManualSignalSlider(const registry::ComponentParams& params)
        : m_value(params.property("value", 50.0)),
          m_minimum(params.property("actionMin", 0.0)),
          m_maximum(params.property("actionMax", 100.0)) {
        if (!std::isfinite(m_value)) m_value = 50.0;
        if (!std::isfinite(m_minimum)) m_minimum = 0.0;
        if (!std::isfinite(m_maximum)) m_maximum = 100.0;
        if (m_minimum <= m_maximum) m_value = std::clamp(m_value, m_minimum, m_maximum);
    }

    const char* typeId() const override { return "graphics.slider"; }
    std::span<Pin> pins() override { return {}; }
    void stamp(MnaMatrixView&) override {}
    void postStep(uint64_t) override {}
    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}

    std::vector<SignalPortDescriptor> signalPorts() const override {
        return {{"out", SignalPortDirection::Output, SignalValueKind::Analog, ""}};
    }

    double value() const noexcept { return m_value; }

    std::vector<PropertyDescriptor> propertyDescriptors() override {
        const auto schemas = propertySchema();
        PropertyDescriptor valueDescriptor;
        valueDescriptor.name = "value";
        valueDescriptor.schema = schemas[0];
        valueDescriptor.get = [this] { return PropertyValue{m_value}; };
        valueDescriptor.set = [this](const PropertyValue& next) {
            const double value = std::get<double>(next);
            if (std::isfinite(value)) m_value = m_minimum <= m_maximum
                ? std::clamp(value, m_minimum, m_maximum) : value;
        };
        PropertyDescriptor minimumDescriptor;
        minimumDescriptor.name = "actionMin";
        minimumDescriptor.schema = schemas[1];
        minimumDescriptor.get = [this] { return PropertyValue{m_minimum}; };
        minimumDescriptor.set = [this](const PropertyValue& next) {
            const double value = std::get<double>(next);
            if (std::isfinite(value)) {
                m_minimum = value;
                if (m_minimum <= m_maximum) m_value = std::clamp(m_value, m_minimum, m_maximum);
            }
        };
        PropertyDescriptor maximumDescriptor;
        maximumDescriptor.name = "actionMax";
        maximumDescriptor.schema = schemas[2];
        maximumDescriptor.get = [this] { return PropertyValue{m_maximum}; };
        maximumDescriptor.set = [this](const PropertyValue& next) {
            const double value = std::get<double>(next);
            if (std::isfinite(value)) {
                m_maximum = value;
                if (m_minimum <= m_maximum) m_value = std::clamp(m_value, m_minimum, m_maximum);
            }
        };
        return {std::move(valueDescriptor), std::move(minimumDescriptor), std::move(maximumDescriptor)};
    }

    static std::vector<PropertySchema> propertySchema() {
        PropertySchema value;
        value.id = "value";
        value.label = "Valor do sinal";
        value.group = "Sinal";
        value.valueKind = PropertyValueKind::Number;
        value.editor = "number";
        value.defaultValue = 50.0;
        PropertySchema minimum;
        minimum.id = "actionMin";
        minimum.label = "Valor mínimo em OUT";
        minimum.group = "Sinal";
        minimum.valueKind = PropertyValueKind::Number;
        minimum.editor = "number";
        minimum.defaultValue = 0.0;
        PropertySchema maximum = minimum;
        maximum.id = "actionMax";
        maximum.label = "Valor máximo em OUT";
        maximum.defaultValue = 100.0;
        return {value, minimum, maximum};
    }

private:
    double m_value = 50.0;
    double m_minimum = 0.0;
    double m_maximum = 100.0;
};

} // namespace lasecsimul::components
