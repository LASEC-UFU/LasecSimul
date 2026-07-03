#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>
#include "lasecsimul/IComponentModel.hpp"

namespace lasecsimul::components {

namespace detail {

inline double finiteOr(double value, double fallback) {
    return std::isfinite(value) ? value : fallback;
}

inline double clampMin(double value, double minimum) {
    value = finiteOr(value, minimum);
    return value < minimum ? minimum : value;
}

inline PropertySchema numberSchema(std::string id,
                                   std::string label,
                                   std::string unit,
                                   double defaultValue,
                                   double minValue,
                                   double step,
                                   uint32_t flags = PropertySchemaNone) {
    PropertySchema schema;
    schema.id = std::move(id);
    schema.label = std::move(label);
    schema.group = "Eletrica";
    schema.unit = std::move(unit);
    schema.valueKind = PropertyValueKind::Number;
    schema.editor = "number";
    schema.defaultValue = defaultValue;
    schema.minValue = minValue;
    schema.step = step;
    schema.flags = flags;
    return schema;
}

inline PropertySchema boolSchema(std::string id, std::string label, bool defaultValue,
                                 uint32_t flags = PropertySchemaNone) {
    PropertySchema schema;
    schema.id = std::move(id);
    schema.label = std::move(label);
    schema.group = "Eletrica";
    schema.valueKind = PropertyValueKind::Bool;
    schema.editor = "checkbox";
    schema.defaultValue = defaultValue;
    schema.flags = flags;
    return schema;
}

inline PropertySchema textSchema(std::string id, std::string label, std::string defaultValue,
                                 uint32_t flags = PropertySchemaNone) {
    PropertySchema schema;
    schema.id = std::move(id);
    schema.label = std::move(label);
    schema.group = "Geral";
    schema.valueKind = PropertyValueKind::String;
    schema.editor = "text";
    schema.defaultValue = std::move(defaultValue);
    schema.flags = flags;
    return schema;
}

inline PropertyDescriptor numberDescriptor(std::string name, PropertySchema schema, double& target,
                                           double minValue) {
    PropertyDescriptor descriptor{
        name,
        schema.unit,
        [&target] { return PropertyValue{target}; },
        [&target, minValue](const PropertyValue& value) {
            if (const double* d = std::get_if<double>(&value)) target = clampMin(*d, minValue);
        },
        std::move(schema),
    };
    return descriptor;
}

inline PropertyDescriptor boolDescriptor(std::string name, PropertySchema schema, bool& target) {
    PropertyDescriptor descriptor{
        name,
        "",
        [&target] { return PropertyValue{target}; },
        [&target](const PropertyValue& value) {
            if (const bool* b = std::get_if<bool>(&value)) target = *b;
        },
        std::move(schema),
    };
    return descriptor;
}

inline PropertyDescriptor textDescriptor(std::string name, PropertySchema schema, std::string& target) {
    PropertyDescriptor descriptor{
        name,
        "",
        [&target] { return PropertyValue{target}; },
        [&target](const PropertyValue& value) {
            if (const std::string* s = std::get_if<std::string>(&value)) target = *s;
        },
        std::move(schema),
    };
    return descriptor;
}

} // namespace detail

class SimulideTwoPinResistor final : public IComponentModel {
public:
    SimulideTwoPinResistor(std::string typeId, std::array<Pin, 2> pins, double resistanceOhm,
                           std::vector<PropertySchema> schema)
        : m_typeId(std::move(typeId)), m_pins(std::move(pins)),
          m_resistance(detail::clampMin(resistanceOhm, 1e-9)), m_schema(std::move(schema)) {}

    const char* typeId() const override { return m_typeId.c_str(); }
    std::span<Pin> pins() override { return m_pins; }

    void stamp(MnaMatrixView& matrix) override {
        matrix.addConductance(m_pins[0], m_pins[1], 1.0 / detail::clampMin(m_resistance, 1e-9));
    }

    void postStep(uint64_t) override {}
    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}

    std::vector<PropertyDescriptor> propertyDescriptors() override {
        return {detail::numberDescriptor("resistance", m_schema.front(), m_resistance, 1e-9)};
    }

private:
    std::string m_typeId;
    std::array<Pin, 2> m_pins;
    double m_resistance;
    std::vector<PropertySchema> m_schema;
};

class SimulidePotentiometer final : public IComponentModel {
public:
    SimulidePotentiometer(std::string typeId, std::array<Pin, 3> pins, double resistanceOhm, double position)
        : m_typeId(std::move(typeId)), m_pins(std::move(pins)),
          m_resistance(detail::clampMin(resistanceOhm, 1e-9)), m_position(std::clamp(position, 0.0, 1.0)) {}

    const char* typeId() const override { return m_typeId.c_str(); }
    std::span<Pin> pins() override { return m_pins; }

    void stamp(MnaMatrixView& matrix) override {
        const double low = std::max(m_resistance * m_position, 1e-6);
        const double high = std::max(m_resistance - low, 1e-6);
        matrix.addConductance(m_pins[0], m_pins[2], 1.0 / low);
        matrix.addConductance(m_pins[2], m_pins[1], 1.0 / high);
    }

    void postStep(uint64_t) override {}
    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}

    std::vector<PropertyDescriptor> propertyDescriptors() override {
        auto schemas = propertySchema();
        return {detail::numberDescriptor("resistance", schemas[0], m_resistance, 1e-9),
                detail::numberDescriptor("position", schemas[1], m_position, 0.0)};
    }

    static std::vector<PropertySchema> propertySchema() {
        auto resistance = detail::numberSchema("resistance", "Resistencia", "ohm", 10000.0, 1e-9, 1.0,
                                               PropertySchemaShowOnSymbol);
        auto position = detail::numberSchema("position", "Posicao", "", 0.5, 0.0, 0.01);
        position.maxValue = 1.0;
        return {resistance, position};
    }

private:
    std::string m_typeId;
    std::array<Pin, 3> m_pins;
    double m_resistance;
    double m_position;
};

class SimulideSwitch final : public IComponentModel {
public:
    SimulideSwitch(std::string typeId, std::vector<Pin> pins, bool closed, bool normallyClosed = false,
                   bool doubleThrow = false, double poles = 1.0, std::string key = {})
        : m_typeId(std::move(typeId)), m_pins(std::move(pins)), m_closed(closed), m_normallyClosed(normallyClosed),
          m_doubleThrow(doubleThrow), m_poles(detail::clampMin(poles, 1.0)), m_key(std::move(key)) {}

    const char* typeId() const override { return m_typeId.c_str(); }
    std::span<Pin> pins() override { return m_pins; }

    void stamp(MnaMatrixView& matrix) override {
        const bool conductive = m_normallyClosed ? !m_closed : m_closed;
        // 1e-9 (aberto) ao lado de 1e6 (fechado) dá rcond ~1e-18 -- abaixo do limite de
        // CircuitGroup::singular() -- quando este switch acaba no mesmo grupo de um McuComponent
        // (que já estampa 1e-6/1e6 nos pinos flutuantes, ver McuComponent.cpp::stamp() pra raciocínio
        // completo). 1e-6 mantém "fraco o bastante" pra qualquer fio real com rcond seguro (~1e-12).
        if (m_pins.size() >= 2) matrix.addConductance(m_pins[0], m_pins[1], conductive ? 1e6 : 1e-6);
    }

    void postStep(uint64_t) override {}
    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}

    std::vector<PropertyDescriptor> propertyDescriptors() override {
        if (m_typeId == "switches.push") {
            auto schemas = pushPropertySchema();
            return {detail::boolDescriptor("closed", schemas[0], m_closed),
                    detail::boolDescriptor("normallyClosed", schemas[1], m_normallyClosed),
                    detail::boolDescriptor("doubleThrow", schemas[2], m_doubleThrow),
                    detail::numberDescriptor("poles", schemas[3], m_poles, 1.0),
                    detail::textDescriptor("key", schemas[4], m_key)};
        }
        auto schemas = propertySchema();
        return {detail::boolDescriptor("closed", schemas[0], m_closed),
                detail::boolDescriptor("normallyClosed", schemas[1], m_normallyClosed)};
    }

    static std::vector<PropertySchema> propertySchema() {
        return {detail::boolSchema("closed", "Fechado", false),
                detail::boolSchema("normallyClosed", "Normalmente Fechado", false)};
    }

    static std::vector<PropertySchema> pushPropertySchema() {
        auto schemas = std::vector<PropertySchema>{
            detail::boolSchema("closed", "Fechado", false, PropertySchemaHidden),
            detail::boolSchema("normallyClosed", "Normalmente Fechado", false),
            detail::boolSchema("doubleThrow", "Double Throw", false, PropertySchemaAffectsTopology),
            detail::numberSchema("poles", "Polos", "", 1.0, 1.0, 1.0, PropertySchemaAffectsTopology),
            detail::textSchema("key", "Tecla", ""),
        };
        for (PropertySchema& schema : schemas) schema.group = "Principal";
        return schemas;
    }

    /** Decisão de qual schema usar por typeId mora aqui (dentro da própria classe), não no
     * registrador central -- ver .spec/lasecsimul-native-devices.spec, critério de decoupling. */
    static std::vector<PropertySchema> propertySchemaFor(const std::string& typeId) {
        return typeId == "switches.push" ? pushPropertySchema() : propertySchema();
    }

    /** ABI v2 -- mesmo critério de `propertySchemaFor`: push é momentâneo (solta ao soltar o botão),
     * switch/switch_dip são toggle. */
    static InteractionKind interactionKindFor(const std::string& typeId) {
        return typeId == "switches.push" ? InteractionKind::Momentary : InteractionKind::Toggle;
    }

private:
    std::string m_typeId;
    std::vector<Pin> m_pins;
    bool m_closed;
    bool m_normallyClosed;
    bool m_doubleThrow;
    double m_poles;
    std::string m_key;
};

class SimulideRelay final : public IComponentModel {
public:
    SimulideRelay(std::vector<Pin> pins, double iOn, double iOff, bool normallyClosed)
        : m_pins(std::move(pins)), m_iOn(detail::clampMin(iOn, 0.0)),
          m_iOff(detail::clampMin(iOff, 0.0)), m_normallyClosed(normallyClosed) {}

    const char* typeId() const override { return "switches.relay"; }
    std::span<Pin> pins() override { return m_pins; }

    void stamp(MnaMatrixView& matrix) override {
        const double coilG = 1.0 / 100.0;
        if (m_pins.size() >= 4) {
            matrix.addConductance(m_pins[0], m_pins[1], coilG);
            const double coilCurrentMa = std::abs(matrix.getNodeVoltage(m_pins[0]) - matrix.getNodeVoltage(m_pins[1])) * coilG * 1000.0;
            if (coilCurrentMa >= m_iOn) m_energized = true;
            if (coilCurrentMa <= m_iOff) m_energized = false;
            const bool conductive = m_normallyClosed ? !m_energized : m_energized;
            // Mesmo ajuste de SimulideSwitch::stamp() acima -- 1e-6 em vez de 1e-9 evita rcond
            // abaixo do limite quando este relé acaba no mesmo grupo de um McuComponent.
            matrix.addConductance(m_pins[2], m_pins[3], conductive ? 1e6 : 1e-6);
        }
    }

    void postStep(uint64_t) override {}
    size_t getState(uint8_t* out, size_t cap) const override {
        if (!out || cap < sizeof(m_energized)) return 0;
        std::memcpy(out, &m_energized, sizeof(m_energized));
        return sizeof(m_energized);
    }
    void setState(const uint8_t* in, size_t len) override {
        if (!in || len < sizeof(m_energized)) return;
        std::memcpy(&m_energized, in, sizeof(m_energized));
    }

    std::vector<PropertyDescriptor> propertyDescriptors() override {
        auto schemas = propertySchema();
        return {detail::boolDescriptor("normallyClosed", schemas[0], m_normallyClosed),
                detail::numberDescriptor("iOn", schemas[1], m_iOn, 0.0),
                detail::numberDescriptor("iOff", schemas[2], m_iOff, 0.0)};
    }

    static std::vector<PropertySchema> propertySchema() {
        return {detail::boolSchema("normallyClosed", "Normalmente Fechado", false),
                detail::numberSchema("iOn", "IOn", "mA", 15.0, 0.0, 1.0),
                detail::numberSchema("iOff", "IOff", "mA", 5.0, 0.0, 1.0)};
    }

private:
    std::vector<Pin> m_pins;
    double m_iOn;
    double m_iOff;
    bool m_normallyClosed;
    bool m_energized = false;
};

class SimulidePassiveState final : public IComponentModel {
public:
    SimulidePassiveState(std::string typeId, std::vector<Pin> pins, std::vector<PropertySchema> schemas)
        : m_typeId(std::move(typeId)), m_pins(std::move(pins)), m_schemas(std::move(schemas)) {
        for (const auto& schema : m_schemas) {
            if (const double* d = std::get_if<double>(&schema.defaultValue)) m_numbers.push_back(*d);
            else if (const bool* b = std::get_if<bool>(&schema.defaultValue)) m_bools.push_back(*b ? 1 : 0);
            else if (const std::string* s = std::get_if<std::string>(&schema.defaultValue)) m_strings.push_back(*s);
        }
    }

    const char* typeId() const override { return m_typeId.c_str(); }
    std::span<Pin> pins() override { return m_pins; }

    void stamp(MnaMatrixView&) override {}
    void postStep(uint64_t) override {}
    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}

    std::vector<PropertyDescriptor> propertyDescriptors() override {
        std::vector<PropertyDescriptor> descriptors;
        size_t n = 0;
        size_t b = 0;
        size_t s = 0;
        for (const auto& schema : m_schemas) {
            if (schema.valueKind == PropertyValueKind::Number) {
                descriptors.push_back(detail::numberDescriptor(schema.id, schema, m_numbers[n++], schema.minValue.value_or(0.0)));
            } else if (schema.valueKind == PropertyValueKind::Bool) {
                descriptors.push_back(PropertyDescriptor{
                    schema.id,
                    "",
                    [this, b] { return PropertyValue{m_bools[b] != 0}; },
                    [this, b](const PropertyValue& value) {
                        if (const bool* flag = std::get_if<bool>(&value)) m_bools[b] = *flag ? 1 : 0;
                    },
                    schema,
                });
                ++b;
            } else if (schema.valueKind == PropertyValueKind::String) {
                descriptors.push_back(detail::textDescriptor(schema.id, schema, m_strings[s++]));
            }
        }
        return descriptors;
    }

private:
    std::string m_typeId;
    std::vector<Pin> m_pins;
    std::vector<PropertySchema> m_schemas;
    std::vector<double> m_numbers;
    std::vector<uint8_t> m_bools;
    std::vector<std::string> m_strings;
};

class SimulideDiodeLike final : public IComponentModel {
public:
    SimulideDiodeLike(std::string typeId, std::array<Pin, 2> pins, double forwardVoltage, double resistance)
        : m_typeId(std::move(typeId)), m_pins(std::move(pins)), m_forwardVoltage(forwardVoltage),
          m_resistance(detail::clampMin(resistance, 1e-9)) {}

    const char* typeId() const override { return m_typeId.c_str(); }
    std::span<Pin> pins() override { return m_pins; }

    void stamp(MnaMatrixView& matrix) override {
        const double vd = matrix.getNodeVoltage(m_pins[0]) - matrix.getNodeVoltage(m_pins[1]);
        const bool on = vd >= m_forwardVoltage;
        matrix.addConductance(m_pins[0], m_pins[1], on ? 1.0 / m_resistance : 1e-12);
        if (on) matrix.addCurrent(m_pins[0], m_pins[1], m_forwardVoltage / m_resistance);
    }

    bool isNonlinear() const override { return true; }
    bool hasConverged() const override { return true; }
    void postStep(uint64_t) override {}
    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}

    std::vector<PropertyDescriptor> propertyDescriptors() override {
        auto schemas = propertySchema(m_forwardVoltage, m_resistance);
        return {detail::numberDescriptor("threshold", schemas[0], m_forwardVoltage, 0.0),
                detail::numberDescriptor("resistance", schemas[1], m_resistance, 1e-9)};
    }

    static std::vector<PropertySchema> propertySchema(double threshold = 0.7, double resistance = 1.0) {
        return {detail::numberSchema("threshold", "Tensao Direta", "V", threshold, 0.0, 0.01),
                detail::numberSchema("resistance", "Resistencia On", "ohm", resistance, 1e-9, 0.1)};
    }

private:
    std::string m_typeId;
    std::array<Pin, 2> m_pins;
    double m_forwardVoltage;
    double m_resistance;
};

class SimulideTransistorLike final : public IComponentModel {
public:
    SimulideTransistorLike(std::string typeId, std::array<Pin, 3> pins, double beta, bool pnp)
        : m_typeId(std::move(typeId)), m_pins(std::move(pins)), m_beta(detail::clampMin(beta, 1.0)), m_pnp(pnp) {}

    const char* typeId() const override { return m_typeId.c_str(); }
    std::span<Pin> pins() override { return m_pins; }

    void stamp(MnaMatrixView& matrix) override {
        const double vbe = (matrix.getNodeVoltage(m_pins[1]) - matrix.getNodeVoltage(m_pins[2])) * (m_pnp ? -1.0 : 1.0);
        const bool on = vbe > 0.65;
        matrix.addConductance(m_pins[1], m_pins[2], on ? 1e-3 : 1e-9);
        matrix.addConductance(m_pins[0], m_pins[2], on ? std::min(m_beta * 1e-3, 1e3) : 1e-9);
    }

    bool isNonlinear() const override { return true; }
    bool hasConverged() const override { return true; }
    void postStep(uint64_t) override {}
    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}

    std::vector<PropertyDescriptor> propertyDescriptors() override {
        return {detail::numberDescriptor("beta", propertySchema().front(), m_beta, 1.0)};
    }

    static std::vector<PropertySchema> propertySchema() {
        return {detail::numberSchema("beta", "Ganho", "", 100.0, 1.0, 1.0)};
    }

private:
    std::string m_typeId;
    std::array<Pin, 3> m_pins;
    double m_beta;
    bool m_pnp;
};

class SimulideVoltageRegulator final : public IComponentModel {
public:
    SimulideVoltageRegulator(std::array<Pin, 3> pins, double voltage)
        : m_pins(std::move(pins)), m_voltage(detail::clampMin(voltage, 0.0)) {}

    const char* typeId() const override { return "active.volt_regulator"; }
    std::span<Pin> pins() override { return m_pins; }
    uint32_t extraVariableCount() const override { return 1; }

    void stamp(MnaMatrixView& matrix) override {
        matrix.addVoltageSource(m_pins[2], m_pins[1], m_voltage);
    }

    void postStep(uint64_t) override {}
    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}

    std::vector<PropertyDescriptor> propertyDescriptors() override {
        return {detail::numberDescriptor("voltage", propertySchema().front(), m_voltage, 0.0)};
    }

    static std::vector<PropertySchema> propertySchema() {
        return {detail::numberSchema("voltage", "Tensao", "V", 5.0, 0.0, 0.1, PropertySchemaShowOnSymbol)};
    }

private:
    std::array<Pin, 3> m_pins;
    double m_voltage;
};

} // namespace lasecsimul::components
