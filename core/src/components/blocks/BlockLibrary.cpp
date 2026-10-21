#include "BlockLibrary.hpp"

#include <cmath>
#include <cstdio>
#include <stdexcept>

#include "simulation/library/ParamExpr.hpp"

namespace lasecsimul::components::blocks {

extern const unsigned char kBlockLibrarySpec[];
extern const std::size_t kBlockLibrarySpecSize;

const ParamSpec* BlockSpec::param(std::string_view name) const {
    for (const ParamSpec& spec : params) if (spec.name == name) return &spec;
    return nullptr;
}

namespace {

std::vector<std::pair<std::string, std::vector<nlohmann::json>>> parseConditions(const nlohmann::json& node) {
    std::vector<std::pair<std::string, std::vector<nlohmann::json>>> conditions;
    if (!node.is_object()) return conditions;
    for (const auto& [name, values] : node.items()) {
        std::vector<nlohmann::json> accepted;
        if (values.is_array()) for (const auto& value : values) accepted.push_back(value);
        else accepted.push_back(values);
        conditions.emplace_back(name, std::move(accepted));
    }
    return conditions;
}

std::vector<PortRule> parsePorts(const nlohmann::json& node) {
    std::vector<PortRule> rules;
    if (!node.is_array()) return rules;
    for (const auto& entry : node) {
        PortRule rule;
        if (entry.contains("repeat")) {
            rule.repeat = true;
            rule.param = entry.at("repeat").at("param").get<std::string>();
            rule.rule = entry.at("repeat").at("rule").get<std::string>();
            rule.prefix = entry.value("prefix", std::string("in"));
            rule.start = entry.value("start", 1);
        } else {
            rule.id = entry.at("id").get<std::string>();
        }
        rule.label = entry.value("label", std::string());
        if (entry.contains("when")) rule.when = parseConditions(entry.at("when"));
        rules.push_back(std::move(rule));
    }
    return rules;
}

PropertyValue jsonToProperty(const nlohmann::json& value, ParamType type) {
    if (type == ParamType::Bool) return PropertyValue{value.is_boolean() ? value.get<bool>() : value == "on"};
    if (value.is_string()) return PropertyValue{value.get<std::string>()};
    if (value.is_boolean()) return PropertyValue{value.get<bool>()};
    if (value.is_number()) {
        // Expressões são guardadas como TEXTO (o campo do diálogo do Simulink); números do JSON
        // viram o texto equivalente.
        char buffer[64];
        std::snprintf(buffer, sizeof(buffer), "%.15g", value.get<double>());
        return PropertyValue{std::string(buffer)};
    }
    return PropertyValue{std::string()};
}

std::vector<BlockSpec> parseLibrary() {
    const std::string text(reinterpret_cast<const char*>(kBlockLibrarySpec), kBlockLibrarySpecSize);
    const nlohmann::json root = nlohmann::json::parse(text);
    std::vector<BlockSpec> blocks;
    for (const auto& library : root) {
        const std::string libraryId = library.at("library").get<std::string>();
        for (const auto& node : library.at("blocks")) {
            BlockSpec spec;
            spec.id = node.at("id").get<std::string>();
            spec.typeId = "sl." + spec.id;
            spec.library = libraryId;
            spec.name = node.at("name").get<std::string>();
            spec.titlePt = node.contains("title") ? node.at("title").value("pt-BR", spec.name) : spec.name;
            spec.doc = node.value("doc", std::string());
            const auto& sampleTime = node.at("sampleTime");
            if (sampleTime.contains("param")) {
                spec.sampleTime = SampleTimeKind::Param;
                spec.sampleTimeParam = sampleTime.at("param").get<std::string>();
            } else {
                const std::string fixed = sampleTime.at("fixed").get<std::string>();
                spec.sampleTime = fixed == "continuous" ? SampleTimeKind::Continuous
                                  : fixed == "constant" ? SampleTimeKind::Constant : SampleTimeKind::Inherited;
            }
            for (const auto& entry : node.at("params")) {
                ParamSpec param;
                param.name = entry.at("name").get<std::string>();
                const std::string type = entry.at("type").get<std::string>();
                param.type = type == "enum" ? ParamType::Enum : type == "bool" ? ParamType::Bool
                             : type == "string" ? ParamType::String : ParamType::Expr;
                param.defaultValue = jsonToProperty(entry.at("default"), param.type);
                if (entry.contains("options")) for (const auto& option : entry.at("options"))
                    param.options.push_back(option.is_object() ? option.at("value").get<std::string>() : option.get<std::string>());
                param.group = entry.value("group", std::string());
                if (entry.contains("visibleWhen")) param.visibleWhen = parseConditions(entry.at("visibleWhen"));
                param.tunable = entry.value("tunable", false);
                if (entry.contains("title")) {
                    param.titleEn = entry.at("title").value("en", param.name);
                    param.titlePt = entry.at("title").value("pt-BR", param.titleEn);
                } else {
                    param.titleEn = param.titlePt = param.name;
                }
                spec.params.push_back(std::move(param));
            }
            spec.inputs = parsePorts(node.value("inputs", nlohmann::json::array()));
            spec.outputs = parsePorts(node.value("outputs", nlohmann::json::array()));
            blocks.push_back(std::move(spec));
        }
    }
    return blocks;
}

bool sameValue(const PropertyValue& value, const nlohmann::json& accepted) {
    if (const bool* flag = std::get_if<bool>(&value)) {
        if (accepted.is_boolean()) return *flag == accepted.get<bool>();
        if (accepted.is_string()) return (*flag ? "on" : "off") == accepted.get<std::string>();
        return false;
    }
    if (const std::string* text = std::get_if<std::string>(&value)) {
        if (accepted.is_string()) return *text == accepted.get<std::string>();
        if (accepted.is_boolean()) return (*text == "on") == accepted.get<bool>();
        return false;
    }
    if (const double* number = std::get_if<double>(&value)) return accepted.is_number() && *number == accepted.get<double>();
    return false;
}

} // namespace

const std::vector<BlockSpec>& blockLibrary() {
    static const std::vector<BlockSpec> library = parseLibrary();
    return library;
}

const BlockSpec* findBlockSpec(std::string_view typeId) {
    for (const BlockSpec& spec : blockLibrary()) if (spec.typeId == typeId) return &spec;
    return nullptr;
}

bool isLibraryTypeId(std::string_view typeId) { return findBlockSpec(typeId) != nullptr; }

PropertyMap withDefaults(const BlockSpec& spec, const PropertyMap& properties) {
    PropertyMap result = properties;
    for (const ParamSpec& param : spec.params) {
        const auto it = result.find(param.name);
        if (it == result.end()) { result[param.name] = param.defaultValue; continue; }
        // Normaliza o tipo: bool salvo como "on"/"off" e número onde se espera texto de expressão.
        if (param.type == ParamType::Bool) {
            if (const std::string* text = std::get_if<std::string>(&it->second)) it->second = PropertyValue{*text == "on" || *text == "true"};
            else if (const double* number = std::get_if<double>(&it->second)) it->second = PropertyValue{*number != 0.0};
        } else if (const double* number = std::get_if<double>(&it->second)) {
            it->second = PropertyValue{propertyText(it->second)};
        }
    }
    return result;
}

bool conditionsHold(const std::vector<std::pair<std::string, std::vector<nlohmann::json>>>& conditions,
                    const PropertyMap& properties) {
    for (const auto& [name, accepted] : conditions) {
        const auto it = properties.find(name);
        if (it == properties.end()) return false;
        bool any = false;
        for (const auto& value : accepted) any = any || sameValue(it->second, value);
        if (!any) return false;
    }
    return true;
}

size_t repeatCount(const std::string& rule, const PropertyValue& value) {
    const std::string text = propertyText(value);
    if (rule == "signs" || rule == "ops") {
        size_t count = 0;
        bool symbolic = false;
        for (char c : text) {
            if (c == '+' || c == '-' || c == '*' || c == '/') { ++count; symbolic = true; }
            else if (c == '|' || c == ' ') symbolic = true;
        }
        if (symbolic) return count;
    }
    try {
        const simulation::library::ParamValue parsed = simulation::library::evaluateParam(text);
        if (rule == "vectorLength" && parsed.numel() > 1) return parsed.numel();
        if (parsed.numel() != 1) return 0;
        const double n = parsed.data[0];
        if (!(n >= 0.0) || n != std::floor(n) || n > 4096.0) return 0;
        return static_cast<size_t>(n);
    } catch (const std::exception&) {
        return 0;
    }
}

std::vector<std::string> resolvePorts(const std::vector<PortRule>& rules, const PropertyMap& properties) {
    std::vector<std::string> ids;
    for (const PortRule& rule : rules) {
        if (!rule.when.empty() && !conditionsHold(rule.when, properties)) continue;
        if (!rule.repeat) { ids.push_back(rule.id); continue; }
        const auto it = properties.find(rule.param);
        const size_t count = it == properties.end() ? 0 : repeatCount(rule.rule, it->second);
        for (size_t i = 0; i < count; ++i) ids.push_back(rule.prefix + std::to_string(rule.start + static_cast<int>(i)));
    }
    return ids;
}

std::string propertyText(const PropertyValue& value) {
    if (const std::string* text = std::get_if<std::string>(&value)) return *text;
    if (const bool* flag = std::get_if<bool>(&value)) return *flag ? "on" : "off";
    if (const double* number = std::get_if<double>(&value)) {
        char buffer[64];
        std::snprintf(buffer, sizeof(buffer), "%.15g", *number);
        return buffer;
    }
    return {};
}

} // namespace lasecsimul::components::blocks
