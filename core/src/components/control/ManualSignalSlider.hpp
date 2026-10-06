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
        : m_value(params.property("value", 50.0)) {
        if (!std::isfinite(m_value)) m_value = 50.0;
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
        PropertyDescriptor descriptor;
        descriptor.name = "value";
        descriptor.schema = propertySchema().front();
        descriptor.get = [this] { return PropertyValue{m_value}; };
        descriptor.set = [this](const PropertyValue& next) { m_value = std::get<double>(next); };
        return {std::move(descriptor)};
    }

    static std::vector<PropertySchema> propertySchema() {
        PropertySchema value;
        value.id = "value";
        value.label = "Valor do sinal";
        value.group = "Sinal";
        value.valueKind = PropertyValueKind::Number;
        value.editor = "number";
        value.defaultValue = 50.0;
        return {value};
    }

private:
    double m_value = 50.0;
};

} // namespace lasecsimul::components
