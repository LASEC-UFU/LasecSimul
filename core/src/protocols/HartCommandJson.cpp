#include "HartCommandJson.hpp"
#include "HartCommandClassification.hpp"

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

// Diagnostic for a command id a manufacturer may not author, per the
// HCF_SPEC-99 Table 9 classifier (HartCommandClassification.hpp). Mirrors
// section 139/150 of the architecture doc: applicability and authorship are
// different questions, and this function only answers "who may define this
// id's semantics", never "does this device support it".
std::string manufacturerAuthoringRejection(HartCommandId id, uint32_t consumedDeviceSpecificCount) {
    const HartCommandClass cls = classifyHartCommandNumber(id);
    switch (cls) {
        case HartCommandClass::Universal:
        case HartCommandClass::CommonPractice:
        case HartCommandClass::AdditionalCommonPractice:
        case HartCommandClass::WirelessHart:
        case HartCommandClass::DeviceFamily:
            return "command id " + std::to_string(id) + " is " + hartCommandClassName(cls) +
                   " (HART-standardized); its semantics are defined by the HART specification and cannot be "
                   "redefined by a manufacturer command. Use a Device-Specific id (128-253) instead.";
        case HartCommandClass::NonPublic:
            return "command id " + std::to_string(id) +
                   " falls in the Non-Public/factory-only range (122-126); factory-mode authoring is not "
                   "implemented in this build.";
        case HartCommandClass::ExpansionFlag:
            return "command id 31 is the HART Expansion Flag (protocol framing infrastructure for extended "
                   "command numbers) and can never be a user-defined command body.";
        case HartCommandClass::Reserved:
            return "command id " + std::to_string(id) + " falls in a Reserved HART command-number range and "
                   "cannot be defined.";
        case HartCommandClass::WirelessDeviceSpecific:
            return "command id " + std::to_string(id) +
                   " is Wireless Device-Specific (64512-64765), which requires a WirelessHART-capable device "
                   "context; this build has no WirelessHART device-capability model.";
        case HartCommandClass::AdditionalDeviceSpecific:
            return "command id " + std::to_string(id) +
                   " is Additional Device-Specific (64768-65021), only usable once the primary Device-Specific "
                   "range (128-253) is more than 90% consumed by this device (currently " +
                   std::to_string(consumedDeviceSpecificCount) + "/" + std::to_string(kDeviceSpecificRangeSize) + ").";
        case HartCommandClass::DeviceSpecific:
            return {}; // authorable -- never reached, callers check isManufacturerAuthorable() first
    }
    return "command id " + std::to_string(id) + " is not manufacturer-authorable.";
}

// ---------------------------------------------------------------------------
// JSON -> HartExpr / HartStatement (full recursive vocabulary: Set/If/Map/
// ForCodes, not just flat Append). This is the compiler target the Lasec
// HART Command DSL parser (extension/src/dsl/HartCommandDsl.ts) lowers to.

std::optional<HartExpr> parseExpr(const nlohmann::json& node, std::string& error) {
    if (!node.is_object() || !node.contains("kind") || !node["kind"].is_string()) {
        error = "expression must be an object with a string \"kind\"";
        return std::nullopt;
    }
    const std::string kind = node["kind"].get<std::string>();
    if (kind == "hex") {
        const std::string hexText = node.value("bytes", std::string{});
        const auto bytes = parseHex(hexText);
        if (!bytes) { error = "invalid hex constant \"" + hexText + "\""; return std::nullopt; }
        return HartExpr::hex(*bytes);
    }
    if (kind == "variable") {
        const std::string name = node.value("variable", std::string{});
        if (name.empty()) { error = "empty variable reference"; return std::nullopt; }
        if (const auto varId = parseVarId(name)) return HartExpr::var(*varId);
        return HartExpr::userVar(name);
    }
    if (kind == "body") return HartExpr::body();
    if (kind == "bodySlice") {
        if (!node.contains("offset") || !node["offset"].is_number_unsigned() ||
            !node.contains("length") || !node["length"].is_number_unsigned()) {
            error = "bodySlice requires unsigned \"offset\" and \"length\"";
            return std::nullopt;
        }
        return HartExpr::bodySlice(node["offset"].get<size_t>(), node["length"].get<size_t>());
    }
    if (kind == "localCode") return HartExpr::localCode();
    error = "unknown expression kind \"" + kind + "\"";
    return std::nullopt;
}

bool parseStatementList(const nlohmann::json& array, std::vector<HartStatement>& out, std::string& error, int depth);

bool parseStatement(const nlohmann::json& node, std::vector<HartStatement>& out, std::string& error, int depth) {
    if (depth > 8) { error = "command body nesting too deep"; return false; }
    if (!node.is_object() || !node.contains("kind") || !node["kind"].is_string()) {
        error = "statement must be an object with a string \"kind\"";
        return false;
    }
    const std::string kind = node["kind"].get<std::string>();
    // Any expression kind appearing directly in a statement list means
    // "append this" (implicit Append, matches PACTware's SEQUENCE semantics
    // and keeps the flat-step authoring shape from the previous iteration
    // working unchanged).
    if (kind == "hex" || kind == "variable" || kind == "body" || kind == "bodySlice" || kind == "localCode") {
        auto expr = parseExpr(node, error);
        if (!expr) return false;
        out.push_back(HartStatement{HartAppendStmt{std::move(*expr)}});
        return true;
    }
    if (kind == "set") {
        const std::string target = node.value("target", std::string{});
        const auto varId = parseVarId(target);
        if (!varId) { error = "SET target \"" + target + "\" is not a recognized built-in variable"; return false; }
        if (!node.contains("value")) { error = "SET requires a \"value\" expression"; return false; }
        auto value = parseExpr(node["value"], error);
        if (!value) return false;
        out.push_back(HartStatement{HartSetStmt{*varId, std::move(*value)}});
        return true;
    }
    if (kind == "if") {
        if (!node.contains("lhs") || !node.contains("rhs")) { error = "IF requires \"lhs\" and \"rhs\""; return false; }
        auto lhs = parseExpr(node["lhs"], error);
        if (!lhs) return false;
        auto rhs = parseExpr(node["rhs"], error);
        if (!rhs) return false;
        HartIfStmt stmt;
        stmt.lhs = std::move(*lhs);
        stmt.rhs = std::move(*rhs);
        if (node.contains("then") && !parseStatementList(node["then"], stmt.thenBranch, error, depth + 1)) return false;
        if (node.contains("else") && !parseStatementList(node["else"], stmt.elseBranch, error, depth + 1)) return false;
        out.push_back(HartStatement{std::move(stmt)});
        return true;
    }
    if (kind == "map") {
        if (!node.contains("key")) { error = "MAP requires a \"key\" expression"; return false; }
        auto key = parseExpr(node["key"], error);
        if (!key) return false;
        HartMapStmt stmt;
        stmt.key = std::move(*key);
        if (node.contains("table")) {
            if (!node["table"].is_array()) { error = "MAP \"table\" must be an array"; return false; }
            for (const auto& entry : node["table"]) {
                const auto keyBytes = parseHex(entry.value("key", std::string{}));
                const auto valueBytes = parseHex(entry.value("value", std::string{}));
                if (!keyBytes || !valueBytes) { error = "MAP table entry has invalid hex"; return false; }
                stmt.table.push_back({*keyBytes, *valueBytes});
            }
        }
        if (node.contains("default")) {
            const auto def = parseHex(node.value("default", std::string{}));
            if (!def) { error = "MAP \"default\" has invalid hex"; return false; }
            stmt.defaultValue = *def;
        }
        out.push_back(HartStatement{std::move(stmt)});
        return true;
    }
    if (kind == "forCodes") {
        if (!node.contains("source")) { error = "FOR_CODES requires a \"source\" expression"; return false; }
        auto source = parseExpr(node["source"], error);
        if (!source) return false;
        HartForCodesStmt stmt;
        stmt.source = std::move(*source);
        if (node.contains("maxIterations")) {
            if (!node["maxIterations"].is_number_unsigned()) { error = "FOR_CODES \"maxIterations\" must be a non-negative integer"; return false; }
            stmt.maxIterations = node["maxIterations"].get<size_t>();
        }
        if (node.contains("prefix") && !parseStatementList(node["prefix"], stmt.prefix, error, depth + 1)) return false;
        if (node.contains("body") && !parseStatementList(node["body"], stmt.body, error, depth + 1)) return false;
        out.push_back(HartStatement{std::move(stmt)});
        return true;
    }
    error = "unsupported statement kind \"" + kind + "\"";
    return false;
}

bool parseStatementList(const nlohmann::json& array, std::vector<HartStatement>& out, std::string& error, int depth) {
    if (!array.is_array()) { error = "expected a JSON array of statements"; return false; }
    for (const auto& node : array) {
        if (!parseStatement(node, out, error, depth)) return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// HartExpr / HartStatement -> JSON (inverse of the above; used so the UI can
// re-render what it just sent, and so a hand-authored C++ definition -- e.g.
// the reference catalog's built-ins -- can round-trip for display).

nlohmann::json exprToJson(const HartExpr& expr) {
    switch (expr.kind) {
        case HartExpr::Kind::HexConstant: return {{"kind", "hex"}, {"bytes", toHex(expr.constant)}};
        case HartExpr::Kind::Variable: return {{"kind", "variable"}, {"variable", varIdName(expr.variable)}};
        case HartExpr::Kind::UserVariable: return {{"kind", "variable"}, {"variable", expr.variableId}};
        case HartExpr::Kind::RequestBody: return {{"kind", "body"}};
        case HartExpr::Kind::BodySlice: return {{"kind", "bodySlice"}, {"offset", expr.offset}, {"length", expr.length}};
        case HartExpr::Kind::LocalCode: return {{"kind", "localCode"}};
    }
    return {{"kind", "hex"}, {"bytes", ""}}; // unreachable: switch above is exhaustive over HartExpr::Kind
}

nlohmann::json statementsToJson(const std::vector<HartStatement>& statements);

nlohmann::json statementToJson(const HartStatement& statement) {
    return std::visit(
        [](const auto& node) -> nlohmann::json {
            using T = std::decay_t<decltype(node)>;
            if constexpr (std::is_same_v<T, HartAppendStmt>) {
                return exprToJson(node.source);
            } else if constexpr (std::is_same_v<T, HartSetStmt>) {
                return {{"kind", "set"}, {"target", varIdName(node.target)}, {"value", exprToJson(node.value)}};
            } else if constexpr (std::is_same_v<T, HartIfStmt>) {
                return {{"kind", "if"}, {"lhs", exprToJson(node.lhs)}, {"rhs", exprToJson(node.rhs)},
                        {"then", statementsToJson(node.thenBranch)}, {"else", statementsToJson(node.elseBranch)}};
            } else if constexpr (std::is_same_v<T, HartMapStmt>) {
                nlohmann::json table = nlohmann::json::array();
                for (const HartMapEntry& entry : node.table) {
                    table.push_back({{"key", toHex(entry.key)}, {"value", toHex(entry.value)}});
                }
                return {{"kind", "map"}, {"key", exprToJson(node.key)}, {"table", std::move(table)},
                        {"default", toHex(node.defaultValue)}};
            } else if constexpr (std::is_same_v<T, HartForCodesStmt>) {
                return {{"kind", "forCodes"}, {"source", exprToJson(node.source)}, {"maxIterations", node.maxIterations},
                        {"prefix", statementsToJson(node.prefix)}, {"body", statementsToJson(node.body)}};
            } else {
                return {{"kind", "hex"}, {"bytes", ""}}; // unreachable: visit above is exhaustive over HartStatementNode
            }
        },
        statement.node);
}

nlohmann::json statementsToJson(const std::vector<HartStatement>& statements) {
    nlohmann::json out = nlohmann::json::array();
    for (const HartStatement& statement : statements) out.push_back(statementToJson(statement));
    return out;
}

} // namespace

HartCommandJson::ParseResult HartCommandJson::parseCommandDefinition(const nlohmann::json& value,
                                                                      uint32_t consumedDeviceSpecificCount) {
    ParseResult result;
    if (!value.is_object()) { result.error = "command entry must be a JSON object"; return result; }
    if (!value.contains("id") || !value["id"].is_number_integer()) {
        result.error = "command entry requires an integer \"id\"";
        return result;
    }
    const int64_t idValue = value["id"].get<int64_t>();
    if (idValue < 0 || idValue > 0xFFFF) { result.error = "command id out of range (0-65535)"; return result; }
    const auto id = static_cast<HartCommandId>(idValue);
    // This build has no WirelessHART device-capability model (see
    // HartCommandClassification.hpp), so `isWirelessHartCapable` is always
    // false here -- an honestly-reported limitation, not a silent stub.
    if (!isManufacturerAuthorable(id, /*isWirelessHartCapable=*/false, consumedDeviceSpecificCount)) {
        result.error = manufacturerAuthoringRejection(id, consumedDeviceSpecificCount);
        return result;
    }

    HartCommandDefinition definition;
    definition.id = id;
    definition.name = value.value("name", std::string{});

    if (!value.contains("responseSteps") || !value["responseSteps"].is_array()) {
        result.error = "command \"" + definition.name + "\" requires a \"responseSteps\" array";
        return result;
    }
    if (!parseStatementList(value["responseSteps"], definition.resp, result.error, 0)) return result;
    if (value.contains("writeSteps") && !parseStatementList(value["writeSteps"], definition.write, result.error, 0)) return result;
    if (value.contains("afterSteps") && !parseStatementList(value["afterSteps"], definition.after, result.error, 0)) return result;

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

    // Additional Device-Specific (64768-65021) authoring is gated on how much
    // of the primary Device-Specific range (128-253) this SAME collection
    // already consumes (HCF_SPEC-99 >90% rule) -- computed up front so every
    // entry in the collection sees the collection's real total, not just the
    // entries parsed before it.
    uint32_t consumedDeviceSpecificCount = 0;
    for (const auto& entry : parsed) {
        if (!entry.is_object() || !entry.contains("id") || !entry["id"].is_number_integer()) continue;
        if (entry.contains("enabled") && entry["enabled"].is_boolean() && !entry["enabled"].get<bool>()) continue;
        const int64_t idValue = entry["id"].get<int64_t>();
        if (idValue >= static_cast<int64_t>(kDeviceSpecificRangeBegin) &&
            idValue <= static_cast<int64_t>(kDeviceSpecificRangeEnd)) {
            ++consumedDeviceSpecificCount;
        }
    }

    for (const auto& entry : parsed) {
        if (entry.is_object() && entry.contains("enabled") && entry["enabled"].is_boolean() &&
            !entry["enabled"].get<bool>()) {
            continue; // disabled: not compiled, not installed, not an error
        }
        const ParseResult parsedCommand = parseCommandDefinition(entry, consumedDeviceSpecificCount);
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
    nlohmann::json out{{"id", definition.id}, {"name", definition.name}, {"enabled", true}};
    out["responseSteps"] = statementsToJson(definition.resp);
    if (!definition.write.empty()) out["writeSteps"] = statementsToJson(definition.write);
    if (!definition.after.empty()) out["afterSteps"] = statementsToJson(definition.after);
    return out;
}

} // namespace lasecsimul::protocols
