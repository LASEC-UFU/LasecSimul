#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>
#include "lasecsimul/IComponentModel.hpp"
#include "lasecsimul/PropertyDefinition.hpp"

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
                                   uint32_t flags = PropertySchemaNone,
                                   std::optional<double> maxValue = std::nullopt) {
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
    schema.maxValue = maxValue;
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

/** `numberProperty`/`boolProperty`/`textProperty`: mesmo papel dos antigos `numberDescriptor`/
 * `boolDescriptor`/`textDescriptor` (schema + referência direta ao membro, sem escrever get/set à
 * mão) -- agora devolvendo `PropertyDefinition` (validado via `validatePropertyValue`, mesma regra
 * de `SimulationSession::setProperty`) em vez de `PropertyDescriptor` cru. Captura `target` por
 * REFERÊNCIA (mesmo espírito de antes): seguro porque o `PropertyDefinition` devolvido é consumido
 * na hora por `toPropertyDescriptors()` dentro do próprio `propertyDescriptors()` da instância --
 * `target` (membro de `this`) continua vivo por toda a vida do componente. Achado de auditoria
 * arquitetural 2026-07-09 (D1/D2): as classes abaixo indexavam `schemas[0]`/`[1]`/... por posição
 * pra casar com estes descriptors -- agora cada `properties()` busca por id via `schemaById`,
 * imune a reordenação. */
inline PropertyDefinition numberProperty(PropertySchema schema, double& target) {
    const double minValue = schema.minValue.value_or(0.0);
    return PropertyDefinition{
        schema,
        [&target] { return PropertyValue{target}; },
        [&target, schema, minValue](const PropertyValue& value) -> PropertyBindResult {
            if (const std::optional<std::string> error = validatePropertyValue(schema, value)) return {false, *error};
            target = clampMin(std::get<double>(value), minValue);
            return {true, {}};
        },
    };
}

inline PropertyDefinition boolProperty(PropertySchema schema, bool& target) {
    return PropertyDefinition{
        schema,
        [&target] { return PropertyValue{target}; },
        [&target, schema](const PropertyValue& value) -> PropertyBindResult {
            if (const std::optional<std::string> error = validatePropertyValue(schema, value)) return {false, *error};
            target = std::get<bool>(value);
            return {true, {}};
        },
    };
}

inline PropertyDefinition textProperty(PropertySchema schema, std::string& target) {
    return PropertyDefinition{
        schema,
        [&target] { return PropertyValue{target}; },
        [&target, schema](const PropertyValue& value) -> PropertyBindResult {
            if (const std::optional<std::string> error = validatePropertyValue(schema, value)) return {false, *error};
            target = std::get<std::string>(value);
            return {true, {}};
        },
    };
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

    std::vector<PropertyDescriptor> propertyDescriptors() override { return toPropertyDescriptors(properties()); }

    std::vector<PropertyDefinition> properties() {
        return {detail::numberProperty(schemaById(m_schema, "resistance"), m_resistance)};
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

    std::vector<PropertyDescriptor> propertyDescriptors() override { return toPropertyDescriptors(properties()); }

    std::vector<PropertyDefinition> properties() {
        const std::vector<PropertySchema> schemas = propertySchema();
        return {detail::numberProperty(schemaById(schemas, "resistance"), m_resistance),
                detail::numberProperty(schemaById(schemas, "position"), m_position)};
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

    std::vector<PropertyDescriptor> propertyDescriptors() override { return toPropertyDescriptors(properties()); }

    std::vector<PropertyDefinition> properties() {
        if (m_typeId == "switches.push") {
            const std::vector<PropertySchema> schemas = pushPropertySchema();
            return {detail::boolProperty(schemaById(schemas, "closed"), m_closed),
                    detail::boolProperty(schemaById(schemas, "normallyClosed"), m_normallyClosed),
                    detail::boolProperty(schemaById(schemas, "doubleThrow"), m_doubleThrow),
                    detail::numberProperty(schemaById(schemas, "poles"), m_poles),
                    detail::textProperty(schemaById(schemas, "key"), m_key)};
        }
        const std::vector<PropertySchema> schemas = propertySchema();
        return {detail::boolProperty(schemaById(schemas, "closed"), m_closed),
                detail::boolProperty(schemaById(schemas, "normallyClosed"), m_normallyClosed)};
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

    std::vector<PropertyDescriptor> propertyDescriptors() override { return toPropertyDescriptors(properties()); }

    std::vector<PropertyDefinition> properties() {
        const std::vector<PropertySchema> schemas = propertySchema();
        return {detail::boolProperty(schemaById(schemas, "normallyClosed"), m_normallyClosed),
                detail::numberProperty(schemaById(schemas, "iOn"), m_iOn),
                detail::numberProperty(schemaById(schemas, "iOff"), m_iOff)};
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
    /** `initialProperties`/`pinSpec` são OPCIONAIS (default vazio/`nullopt`) -- os 7 call sites que
     * não passam nenhum dos dois continuam com o comportamento de sempre (`m_numbers`/etc. só dos
     * defaults do schema, pinos fixos em `pins`). Só quem declara `pinSpec` (ex: `switches.keypad`)
     * ganha: (1) contagem de pino REAL na criação, a partir de `initialProperties` (normalmente
     * `ComponentParams::properties`, refletindo o que foi de fato salvo/enviado -- não só o default
     * do schema, que é o que `pins` sozinho representaria); (2) recontagem automática sempre que uma
     * propriedade com `PropertySchemaAffectsPinCount` for editada depois (`propertyDescriptors()`
     * abaixo). Nenhuma fórmula por typeId aqui -- só `resolveDynamicPins` (Types.hpp), a mesma pra
     * qualquer device que declarar `pinSpec`. */
    SimulidePassiveState(std::string typeId, std::vector<Pin> pins, std::vector<PropertySchema> schemas,
                         const std::unordered_map<std::string, PropertyValue>& initialProperties = {},
                         std::optional<ComponentPinSpec> pinSpec = std::nullopt)
        : m_typeId(std::move(typeId)), m_pins(std::move(pins)), m_schemas(std::move(schemas)),
          m_pinSpec(std::move(pinSpec)) {
        for (const auto& schema : m_schemas) {
            const auto it = initialProperties.find(schema.id);
            if (const double* d = std::get_if<double>(&schema.defaultValue)) {
                const double* override = it != initialProperties.end() ? std::get_if<double>(&it->second) : nullptr;
                m_numbers.push_back(override ? *override : *d);
            } else if (const bool* b = std::get_if<bool>(&schema.defaultValue)) {
                const bool* override = it != initialProperties.end() ? std::get_if<bool>(&it->second) : nullptr;
                m_bools.push_back((override ? *override : *b) ? 1 : 0);
            } else if (const std::string* s = std::get_if<std::string>(&schema.defaultValue)) {
                const std::string* override = it != initialProperties.end() ? std::get_if<std::string>(&it->second) : nullptr;
                m_strings.push_back(override ? *override : *s);
            }
        }
        if (m_pinSpec) m_pins = resolveDynamicPins(*m_pinSpec, currentProperties());
    }

    const char* typeId() const override { return m_typeId.c_str(); }
    std::span<Pin> pins() override { return m_pins; }

    void stamp(MnaMatrixView&) override {}
    void postStep(uint64_t) override {}
    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}

    std::vector<PropertyDescriptor> propertyDescriptors() override { return toPropertyDescriptors(properties()); }

    /** Lista dinâmica (tamanho/tipos só conhecidos em runtime, vindos de `m_schemas`) -- não dá pra
     * declarar cada `PropertyDefinition` nomeada à mão como as outras classes deste arquivo fazem;
     * cada `get`/`set` fecha sobre `this` + o índice certo dentro de `m_numbers`/`m_bools`/
     * `m_strings`, mesma estrutura de antes, agora validando via `validatePropertyValue` (mesma
     * regra de `SimulationSession::setProperty`) antes de mutar. */
    std::vector<PropertyDefinition> properties() {
        std::vector<PropertyDefinition> definitions;
        size_t n = 0;
        size_t b = 0;
        size_t s = 0;
        for (const PropertySchema& schema : m_schemas) {
            if (schema.valueKind == PropertyValueKind::Number) {
                const size_t index = n++;
                if (m_pinSpec && (schema.flags & PropertySchemaAffectsPinCount) != 0) {
                    definitions.push_back(PropertyDefinition{
                        schema,
                        [this, index] { return PropertyValue{m_numbers[index]}; },
                        [this, index, schema, minValue = schema.minValue.value_or(0.0)](const PropertyValue& value) -> PropertyBindResult {
                            if (const std::optional<std::string> error = validatePropertyValue(schema, value)) return {false, *error};
                            m_numbers[index] = detail::clampMin(std::get<double>(value), minValue);
                            m_pins = resolveDynamicPins(*m_pinSpec, currentProperties());
                            return {true, {}};
                        },
                    });
                } else {
                    definitions.push_back(detail::numberProperty(schema, m_numbers[index]));
                }
            } else if (schema.valueKind == PropertyValueKind::Bool) {
                definitions.push_back(PropertyDefinition{
                    schema,
                    [this, b] { return PropertyValue{m_bools[b] != 0}; },
                    [this, b, schema](const PropertyValue& value) -> PropertyBindResult {
                        if (const std::optional<std::string> error = validatePropertyValue(schema, value)) return {false, *error};
                        m_bools[b] = std::get<bool>(value) ? 1 : 0;
                        return {true, {}};
                    },
                });
                ++b;
            } else if (schema.valueKind == PropertyValueKind::String) {
                definitions.push_back(detail::textProperty(schema, m_strings[s++]));
            }
        }
        return definitions;
    }

private:
    /** Snapshot id->valor pra alimentar `resolveDynamicPins` -- mesma contagem n/b/s de
     * `propertyDescriptors()`/construtor, então sempre em sincronia com `m_numbers`/`m_bools`/
     * `m_strings` atuais (não um cache que possa ficar velho). */
    std::unordered_map<std::string, PropertyValue> currentProperties() const {
        std::unordered_map<std::string, PropertyValue> result;
        size_t n = 0, b = 0, s = 0;
        for (const auto& schema : m_schemas) {
            if (schema.valueKind == PropertyValueKind::Number) result.emplace(schema.id, PropertyValue{m_numbers[n++]});
            else if (schema.valueKind == PropertyValueKind::Bool) result.emplace(schema.id, PropertyValue{m_bools[b++] != 0});
            else if (schema.valueKind == PropertyValueKind::String) result.emplace(schema.id, PropertyValue{m_strings[s++]});
        }
        return result;
    }

    std::string m_typeId;
    std::vector<Pin> m_pins;
    std::vector<PropertySchema> m_schemas;
    std::vector<double> m_numbers;
    std::vector<uint8_t> m_bools;
    std::vector<std::string> m_strings;
    std::optional<ComponentPinSpec> m_pinSpec;
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

    std::vector<PropertyDescriptor> propertyDescriptors() override { return toPropertyDescriptors(properties()); }

    std::vector<PropertyDefinition> properties() {
        const std::vector<PropertySchema> schemas = propertySchema(m_forwardVoltage, m_resistance);
        return {detail::numberProperty(schemaById(schemas, "threshold"), m_forwardVoltage),
                detail::numberProperty(schemaById(schemas, "resistance"), m_resistance)};
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

    std::vector<PropertyDescriptor> propertyDescriptors() override { return toPropertyDescriptors(properties()); }

    std::vector<PropertyDefinition> properties() {
        return {detail::numberProperty(propertySchema().front(), m_beta)};
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

    std::vector<PropertyDescriptor> propertyDescriptors() override { return toPropertyDescriptors(properties()); }

    std::vector<PropertyDefinition> properties() {
        return {detail::numberProperty(propertySchema().front(), m_voltage)};
    }

    static std::vector<PropertySchema> propertySchema() {
        return {detail::numberSchema("voltage", "Tensao", "V", 5.0, 0.0, 0.1, PropertySchemaShowOnSymbol)};
    }

private:
    std::array<Pin, 3> m_pins;
    double m_voltage;
};

} // namespace lasecsimul::components
