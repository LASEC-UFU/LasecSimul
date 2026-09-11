#include "HartCommandJson.hpp"

#include <nlohmann/json.hpp>

#include <array>
#include <optional>

namespace lasecsimul::protocols {

namespace {

struct VarIdName { HartVarId id; const char* name; };
constexpr std::array<VarIdName, 12> kVarIdNames{{
    {HartVarId::ManufacturerId, "ManufacturerId"},
    {HartVarId::DeviceType, "DeviceType"},
    {HartVarId::DeviceId, "DeviceId"},
    {HartVarId::NumRequestPreambles, "NumRequestPreambles"},
    {HartVarId::UniversalCommandRevision, "UniversalCommandRevision"},
    {HartVarId::TransmitterSpecificRevision, "TransmitterSpecificRevision"},
    {HartVarId::SoftwareRevision, "SoftwareRevision"},
    {HartVarId::HardwareRevisionAndSignal, "HardwareRevisionAndSignal"},
    {HartVarId::Flags, "Flags"},
    {HartVarId::Tag, "Tag"},
    {HartVarId::PrimaryVariableUnit, "PrimaryVariableUnit"},
    {HartVarId::PrimaryVariable, "PrimaryVariable"},
}};

std::optional<HartVarId> parseVarId(const std::string& name) noexcept {
    for (const auto& entry : kVarIdNames) if (name == entry.name) return entry.id;
    return std::nullopt;
}

const char* varIdName(HartVarId id) noexcept {
    for (const auto& entry : kVarIdNames) if (entry.id == id) return entry.name;
    return "";
}

std::optional<std::vector<uint8_t>> parseHex(const std::string& text) {
    if (text.size() % 2 != 0) return std::nullopt;
    std::vector<uint8_t> bytes(text.size() / 2);
    auto nibble = [](char c) -> int {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
    };
    for (size_t i = 0; i < bytes.size(); ++i) {
        const int hi = nibble(text[2 * i]);
        const int lo = nibble(text[2 * i + 1]);
        if (hi < 0 || lo < 0) return std::nullopt;
        bytes[i] = static_cast<uint8_t>((hi << 4) | lo);
    }
    return bytes;
}

std::string toHex(std::span<const uint8_t> bytes) {
    static constexpr char kDigits[] = "0123456789ABCDEF";
    std::string out;
    out.reserve(bytes.size() * 2);
    for (uint8_t b : bytes) { out.push_back(kDigits[b >> 4]); out.push_back(kDigits[b & 0x0F]); }
    return out;
}

// Standard command ids that a user-authored command may never shadow --
// they are always served by HartReferenceCatalog::commandProgramDefinitions(),
// never by a per-device override (HART-FR-007 spirit: explicit exclusion, not
// silent collision).
bool isReservedStandardCommandId(HartCommandId id) noexcept {
    return id == 0x00 || id == 0x01 || id == 0x03 || id == 0x0B || id == 0x21;
}

} // namespace

HartCommandJson::ParseResult HartCommandJson::parseCommandDefinition(const nlohmann::json& value) {
    ParseResult result;
    if (!value.is_object()) { result.error = "command entry must be a JSON object"; return result; }
    if (!value.contains("id") || !value["id"].is_number_integer()) {
        result.error = "command entry requires an integer \"id\"";
        return result;
    }
    const int64_t idValue = value["id"].get<int64_t>();
    if (idValue < 0 || idValue > 0xFFFF) { result.error = "command id out of range (0-65535)"; return result; }
    const auto id = static_cast<HartCommandId>(idValue);
    if (isReservedStandardCommandId(id)) {
        result.error = "command id " + std::to_string(id) +
                       " is a standard command already served by the reference catalog; choose another id";
        return result;
    }

    HartCommandDefinition definition;
    definition.id = id;
    definition.name = value.value("name", std::string{});
    if (value.contains("enabled") && value["enabled"].is_boolean() && !value["enabled"].get<bool>()) {
        // An explicitly-disabled custom command compiles to an empty response
        // program rather than being silently skipped by the caller -- the
        // collection parser filters it out instead (see parseCommandCollection).
    }

    if (!value.contains("responseSteps") || !value["responseSteps"].is_array()) {
        result.error = "command \"" + definition.name + "\" requires a \"responseSteps\" array";
        return result;
    }
    for (const auto& step : value["responseSteps"]) {
        if (!step.is_object() || !step.contains("kind") || !step["kind"].is_string()) {
            result.error = "response step must be an object with a string \"kind\"";
            return result;
        }
        const std::string kind = step["kind"].get<std::string>();
        if (kind == "hex") {
            const std::string hexText = step.value("bytes", std::string{});
            const auto bytes = parseHex(hexText);
            if (!bytes) { result.error = "invalid hex constant \"" + hexText + "\""; return result; }
            definition.resp.push_back(HartStatement{HartAppendStmt{HartExpr::hex(*bytes)}});
        } else if (kind == "variable") {
            const std::string name = step.value("variable", std::string{});
            const auto varId = parseVarId(name);
            if (varId) definition.resp.push_back(HartStatement{HartAppendStmt{HartExpr::var(*varId)}});
            else if (!name.empty()) definition.resp.push_back(HartStatement{HartAppendStmt{HartExpr::userVar(name)}});
            else { result.error = "empty variable reference"; return result; }
        } else if (kind == "body") {
            definition.resp.push_back(HartStatement{HartAppendStmt{HartExpr::body()}});
        } else if (kind == "bodySlice") {
            if (!step.contains("offset") || !step["offset"].is_number_unsigned() ||
                !step.contains("length") || !step["length"].is_number_unsigned()) {
                result.error = "bodySlice step requires unsigned \"offset\" and \"length\"";
                return result;
            }
            definition.resp.push_back(HartStatement{
                HartAppendStmt{HartExpr::bodySlice(step["offset"].get<size_t>(), step["length"].get<size_t>())}});
        } else {
            result.error = "unsupported response step kind \"" + kind +
                           "\" (only hex/variable/body/bodySlice are authorable from the UI in this iteration)";
            return result;
        }
    }

    result.success = true;
    result.definition = std::move(definition);
    return result;
}

HartCommandJson::CollectionParseResult HartCommandJson::parseCommandCollection(const std::string& json) {
    CollectionParseResult result;
    nlohmann::json parsed;
    try {
        parsed = nlohmann::json::parse(json.empty() ? "[]" : json);
    } catch (const std::exception& ex) {
        result.error = std::string("invalid JSON: ") + ex.what();
        return result;
    }
    if (!parsed.is_array()) { result.error = "command collection must be a JSON array"; return result; }
    if (parsed.size() > 64) { result.error = "too many commands declared (max 64)"; return result; }

    for (const auto& entry : parsed) {
        if (entry.is_object() && entry.contains("enabled") && entry["enabled"].is_boolean() &&
            !entry["enabled"].get<bool>()) {
            continue; // disabled: not compiled, not installed, not an error
        }
        const ParseResult parsedCommand = parseCommandDefinition(entry);
        if (!parsedCommand.success) { result.error = parsedCommand.error; return result; }
        for (const HartCommandDefinition& existing : result.definitions) {
            if (existing.id == parsedCommand.definition.id) {
                result.error = "duplicate command id " + std::to_string(parsedCommand.definition.id);
                return result;
            }
        }
        result.definitions.push_back(parsedCommand.definition);
    }
    result.success = true;
    return result;
}

nlohmann::json HartCommandJson::toJson(const HartCommandDefinition& definition) {
    nlohmann::json steps = nlohmann::json::array();
    bool unsupported = false;
    for (const HartStatement& statement : definition.resp) {
        const auto* append = std::get_if<HartAppendStmt>(&statement.node);
        if (!append) { unsupported = true; break; }
        switch (append->source.kind) {
            case HartExpr::Kind::HexConstant:
                steps.push_back({{"kind", "hex"}, {"bytes", toHex(append->source.constant)}});
                break;
            case HartExpr::Kind::Variable:
                steps.push_back({{"kind", "variable"}, {"variable", varIdName(append->source.variable)}});
                break;
            case HartExpr::Kind::UserVariable:
                steps.push_back({{"kind", "variable"}, {"variable", append->source.variableId}});
                break;
            case HartExpr::Kind::RequestBody:
                steps.push_back({{"kind", "body"}});
                break;
            case HartExpr::Kind::BodySlice:
                steps.push_back({{"kind", "bodySlice"}, {"offset", append->source.offset}, {"length", append->source.length}});
                break;
            case HartExpr::Kind::LocalCode:
                unsupported = true;
                break;
        }
        if (unsupported) break;
    }
    nlohmann::json out{{"id", definition.id}, {"name", definition.name}, {"enabled", true}};
    if (unsupported) { out["responseSteps"] = nlohmann::json::array(); out["unsupported"] = true; }
    else out["responseSteps"] = std::move(steps);
    return out;
}

} // namespace lasecsimul::protocols
