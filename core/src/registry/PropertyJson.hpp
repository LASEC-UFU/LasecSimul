#pragma once

#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <vector>
#include "lasecsimul/Types.hpp"

namespace lasecsimul::registry {

/**
 * Conversão JSON <-> `PropertyValue`/`PropertySchema`/`ReadoutFormat`/`InteractionKind`/
 * `ComponentPinSpec` -- vocabulário único usado tanto por `CoreApplication.cpp` (verbos IPC
 * `addComponent`/`setProperty`/`getPropertySchemas`) quanto por `GlobalPluginCache::loadLibrary`
 * (parse de `.lsdevice`). Extraído daqui (achado de auditoria arquitetural 2026-07-09, D16) porque
 * antes só existia dentro de `CoreApplication.cpp`, então `GlobalPluginCache` não tinha como montar
 * um `registry::ComponentMetadata` sem duplicar o parser inteiro -- mesmo vocabulário declarativo,
 * um só lugar.
 */

inline PropertyValue jsonToPropertyValue(const nlohmann::json& value) {
    if (value.is_boolean()) return value.get<bool>();
    if (value.is_string()) return value.get<std::string>();
    if (value.is_object() && value.contains("x") && value.contains("y")) {
        return PropertyPoint{value.value("x", 0.0), value.value("y", 0.0)};
    }
    return value.get<double>();
}

inline std::string optionValueToString(const nlohmann::json& value) {
    if (value.is_string()) return value.get<std::string>();
    if (value.is_number() || value.is_boolean()) return value.dump();
    return {};
}

inline PropertyValueKind parsePropertyValueKind(const std::string& valueKind, const std::string& editor) {
    if (valueKind == "number" || valueKind == "double" || valueKind == "int" || valueKind == "uint") {
        return PropertyValueKind::Number;
    }
    if (valueKind == "bool" || valueKind == "boolean") return PropertyValueKind::Bool;
    if (valueKind == "point") return PropertyValueKind::Point;
    if (valueKind == "string" || valueKind == "text" || valueKind == "enum" || valueKind == "color"
        || valueKind == "path" || valueKind == "file") {
        return PropertyValueKind::String;
    }
    if (editor == "checkbox" || editor == "switch") return PropertyValueKind::Bool;
    return PropertyValueKind::String;
}

inline uint32_t parsePropertyFlags(const nlohmann::json& propertyJson) {
    uint32_t flags = PropertySchemaNone;
    if (propertyJson.value("hidden", false)) flags |= PropertySchemaHidden;
    if (propertyJson.value("readOnly", false)) flags |= PropertySchemaReadOnly;
    if (propertyJson.value("noCopy", false)) flags |= PropertySchemaNoCopy;
    if (propertyJson.value("affectsTopology", false)) flags |= PropertySchemaAffectsTopology;
    // Plugin de terceiro ganha pino dinâmico só declarando isto no `.lsdevice` (ver `pin_declare`
    // em `device_abi.h` -- chamável de `set_property()`, não só `init()`) + chamando de verdade
    // dentro do próprio `set_property` -- `SimulationSession::setProperty` reregistra no Netlist
    // olhando só este flag, nunca o typeId (mesmo caminho genérico do built-in keypad).
    if (propertyJson.value("affectsPinCount", false)) flags |= PropertySchemaAffectsPinCount;
    if (propertyJson.value("requiresRestart", false)) flags |= PropertySchemaRequiresRestart;
    if (propertyJson.value("showOnSymbol", false)) flags |= PropertySchemaShowOnSymbol;
    return flags;
}

inline PropertySchema parsePropertySchema(const nlohmann::json& propertyJson) {
    PropertySchema schema;
    schema.id = propertyJson.value("id", propertyJson.value("name", std::string{}));
    schema.label = propertyJson.value("label", schema.id);
    schema.group = propertyJson.value("group", std::string{});
    schema.unit = propertyJson.value("unit", std::string{});
    schema.editor = propertyJson.value("editor", propertyJson.value("type", std::string{"text"}));
    schema.valueKind = parsePropertyValueKind(propertyJson.value("valueKind", propertyJson.value("type", std::string{"string"})),
                                              schema.editor);

    if (propertyJson.contains("default")) {
        schema.defaultValue = jsonToPropertyValue(propertyJson["default"]);
    } else {
        switch (schema.valueKind) {
            case PropertyValueKind::Number: schema.defaultValue = 0.0; break;
            case PropertyValueKind::Bool: schema.defaultValue = false; break;
            case PropertyValueKind::Point: schema.defaultValue = PropertyPoint{}; break;
            case PropertyValueKind::String:
            default: schema.defaultValue = std::string{}; break;
        }
    }

    if (propertyJson.contains("min") && propertyJson["min"].is_number()) schema.minValue = propertyJson["min"].get<double>();
    if (propertyJson.contains("max") && propertyJson["max"].is_number()) schema.maxValue = propertyJson["max"].get<double>();
    if (propertyJson.contains("step") && propertyJson["step"].is_number()) schema.step = propertyJson["step"].get<double>();
    if (propertyJson.contains("options") && propertyJson["options"].is_array()) {
        for (const auto& optionJson : propertyJson["options"]) {
            PropertyOption option;
            if (optionJson.is_object()) {
                if (optionJson.contains("value")) option.value = optionValueToString(optionJson["value"]);
                option.label = optionJson.contains("label") ? optionValueToString(optionJson["label"]) : option.value;
            } else if (optionJson.is_string()) {
                option.value = optionJson.get<std::string>();
                option.label = option.value;
            } else {
                option.value = optionValueToString(optionJson);
                option.label = option.value;
            }
            schema.options.push_back(std::move(option));
        }
    }
    schema.flags = parsePropertyFlags(propertyJson);
    return schema;
}

inline std::vector<PropertySchema> parsePropertySchemaList(const nlohmann::json& deviceJson) {
    std::vector<PropertySchema> schemaList;
    if (!deviceJson.contains("properties") || !deviceJson["properties"].is_array()) return schemaList;
    schemaList.reserve(deviceJson["properties"].size());
    for (const auto& propertyJson : deviceJson["properties"]) {
        schemaList.push_back(parsePropertySchema(propertyJson));
    }
    return schemaList;
}

/** ABI v2 (.spec/lasecsimul-native-devices.spec): chave opcional `"readout"` de `.lsdevice` --
 * device de terceiros declara como a UI deve decodificar sua leitura sem nenhuma mudança de código
 * no Core nem na Extension. Ausente/mal-formado = nullopt ("sem leitura estruturada"), nunca erro --
 * a maioria dos devices não tem mostrador. */
inline std::optional<ReadoutFormat> parseReadoutFormat(const nlohmann::json& deviceJson) {
    if (!deviceJson.contains("readout") || !deviceJson["readout"].is_object()) return std::nullopt;
    const nlohmann::json& readout = deviceJson["readout"];
    const std::string kind = readout.value("kind", std::string{"scalar"});
    ReadoutFormat format;
    if (kind == "channelHistory") {
        format.kind = ReadoutKind::ChannelHistory;
        format.channels = readout.value("channels", 0u);
    } else if (kind == "bitmaskHistory") {
        format.kind = ReadoutKind::BitmaskHistory;
        format.channels = readout.value("channels", 0u);
    } else {
        format.kind = ReadoutKind::Scalar;
        format.unit = readout.value("unit", std::string{});
    }
    return format;
}

/** Mesmo padrão de `parseReadoutFormat`, pra chave opcional `"interaction"` (string:
 * "momentary"/"toggle"/"none"). */
inline std::optional<InteractionKind> parseInteractionKind(const nlohmann::json& deviceJson) {
    if (!deviceJson.contains("interaction") || !deviceJson["interaction"].is_string()) return std::nullopt;
    const std::string value = deviceJson["interaction"].get<std::string>();
    if (value == "momentary") return InteractionKind::Momentary;
    if (value == "toggle") return InteractionKind::Toggle;
    if (value == "none") return InteractionKind::None;
    return std::nullopt; // unknown values (joystick, encoder, etc.) handled Extension-side
}

/** `pinSpec` opcional do `.lsdevice` -- caminho declarativo de pino dinâmico pra plugin de
 * terceiro que não quer/precisa escrever `pin_declare` em C (ver `ComponentMeta::pinSpec`,
 * Types.hpp, pro contrato completo). Mesmo vocabulário/JSON usado pelos builtins
 * (`registerBuiltinComponents`), só que aqui vem de arquivo em vez de literal C++:
 * `{"fixedPinIds": ["z","en"], "dynamicGroups": [{"idPrefix":"chan-","countProperty":"channels",
 * "countFn":"log2Ceil"}]}` -- `countFn` ausente/desconhecido cai em "value" (leitura direta). */
inline std::optional<ComponentPinSpec> parsePinSpec(const nlohmann::json& deviceJson) {
    if (!deviceJson.contains("pinSpec") || !deviceJson["pinSpec"].is_object()) return std::nullopt;
    const nlohmann::json& pinSpecJson = deviceJson["pinSpec"];

    ComponentPinSpec spec;
    if (pinSpecJson.contains("fixedPinIds") && pinSpecJson["fixedPinIds"].is_array()) {
        for (const auto& idJson : pinSpecJson["fixedPinIds"]) {
            if (idJson.is_string()) spec.fixedPinIds.push_back(idJson.get<std::string>());
        }
    }
    if (pinSpecJson.contains("dynamicGroups") && pinSpecJson["dynamicGroups"].is_array()) {
        for (const auto& groupJson : pinSpecJson["dynamicGroups"]) {
            if (!groupJson.is_object() || !groupJson.contains("countProperty")) continue;
            DynamicPinGroupSpec group;
            group.idPrefix = groupJson.value("idPrefix", std::string{"pin-"});
            group.countProperty = groupJson.value("countProperty", std::string{});
            group.countFn = groupJson.value("countFn", std::string{"value"}) == "log2Ceil"
                                ? DynamicPinCountFn::Log2Ceil
                                : DynamicPinCountFn::Value;
            spec.dynamicGroups.push_back(std::move(group));
        }
    }
    return spec;
}

// ── serialização pro lado IPC (getPropertySchemas) — inversa dos parsers acima, pra a Webview
// receber exatamente o que `.lsdevice` já declara pros plugins, também pros built-ins
// (ComponentMetadataRegistry, ver registerBuiltinComponents). ──

inline nlohmann::json propertyValueToJson(const PropertyValue& value) {
    if (const double* d = std::get_if<double>(&value)) return *d;
    if (const std::string* s = std::get_if<std::string>(&value)) return *s;
    if (const bool* b = std::get_if<bool>(&value)) return *b;
    const PropertyPoint& point = std::get<PropertyPoint>(value);
    return nlohmann::json{{"x", point.x}, {"y", point.y}};
}

inline const char* propertyValueKindToJson(PropertyValueKind kind) {
    switch (kind) {
        case PropertyValueKind::Number: return "number";
        case PropertyValueKind::Bool: return "bool";
        case PropertyValueKind::Point: return "point";
        case PropertyValueKind::String:
        default: return "string";
    }
}

inline nlohmann::json propertySchemaToJson(const PropertySchema& schema) {
    nlohmann::json json{
        {"id", schema.id},
        {"label", schema.label},
        {"group", schema.group},
        {"unit", schema.unit},
        {"valueKind", propertyValueKindToJson(schema.valueKind)},
        {"editor", schema.editor},
        {"default", propertyValueToJson(schema.defaultValue)},
        {"hidden", (schema.flags & PropertySchemaHidden) != 0},
        {"readOnly", (schema.flags & PropertySchemaReadOnly) != 0},
        {"noCopy", (schema.flags & PropertySchemaNoCopy) != 0},
        {"affectsTopology", (schema.flags & PropertySchemaAffectsTopology) != 0},
        {"affectsPinCount", (schema.flags & PropertySchemaAffectsPinCount) != 0},
        {"requiresRestart", (schema.flags & PropertySchemaRequiresRestart) != 0},
        {"showOnSymbol", (schema.flags & PropertySchemaShowOnSymbol) != 0},
    };
    if (schema.minValue) json["min"] = *schema.minValue;
    if (schema.maxValue) json["max"] = *schema.maxValue;
    if (schema.step) json["step"] = *schema.step;
    if (!schema.options.empty()) {
        nlohmann::json options = nlohmann::json::array();
        for (const PropertyOption& option : schema.options) {
            options.push_back({{"value", option.value}, {"label", option.label}});
        }
        json["options"] = std::move(options);
    }
    return json;
}

/** ABI v2 -- serializa `ReadoutFormat`/`InteractionKind` pro mesmo payload de `getPropertySchemas`,
 * inversa de `parseReadoutFormat`/`parseInteractionKind` acima. */
inline nlohmann::json readoutFormatToJson(const ReadoutFormat& format) {
    switch (format.kind) {
        case ReadoutKind::ChannelHistory:
            return nlohmann::json{{"kind", "channelHistory"}, {"channels", format.channels}};
        case ReadoutKind::BitmaskHistory:
            return nlohmann::json{{"kind", "bitmaskHistory"}, {"channels", format.channels}};
        case ReadoutKind::Scalar:
        default:
            return nlohmann::json{{"kind", "scalar"}, {"unit", format.unit}};
    }
}

inline const char* interactionKindToJson(InteractionKind kind) {
    switch (kind) {
        case InteractionKind::Momentary: return "momentary";
        case InteractionKind::Toggle: return "toggle";
        case InteractionKind::None:
        default: return "none";
    }
}

} // namespace lasecsimul::registry
