#include "HartCommunicationComponent.hpp"

#include "HartCommandJson.hpp"

#include <algorithm>
#include <cstring>
#include <nlohmann/json.hpp>

namespace lasecsimul::protocols {
namespace {
PropertySchema textSchema(std::string id, std::string label, std::string group, std::string value) {
    return {std::move(id), std::move(label), std::move(group), "", PropertyValueKind::String, "text", std::move(value)};
}
PropertySchema numberSchema(std::string id, std::string label, std::string group, std::string unit,
                            double value, std::optional<double> min = {}, std::optional<double> max = {}) {
    PropertySchema s{std::move(id), std::move(label), std::move(group), std::move(unit), PropertyValueKind::Number, "number", value};
    s.minValue = min; s.maxValue = max; return s;
}
PropertySchema readonlySchema(std::string id, std::string label, std::string group, std::string value) {
    PropertySchema s{std::move(id), std::move(label), std::move(group), "", PropertyValueKind::String, "display", std::move(value)};
    s.flags = PropertySchemaReadOnly;
    return s;
}

// Property Inspector Variables editor <-> HartVariableRole/Type/Direction.
// Unknown/missing strings default to the safest value rather than rejecting
// the whole collection -- a malformed single field shouldn't lose the rest of
// a user's authored variable, and every default here is `Internal`-shaped
// (never `Input`, so a stray import can't accidentally give a variable a
// write-ownership implication it didn't ask for).
HartVariableRole parseRole(const std::string& s) {
    if (s == "PV") return HartVariableRole::PrimaryVariable;
    if (s == "SV") return HartVariableRole::SecondaryVariable;
    if (s == "TV") return HartVariableRole::TertiaryVariable;
    if (s == "QV") return HartVariableRole::QuaternaryVariable;
    if (s == "DeviceSpecific") return HartVariableRole::DeviceSpecific;
    if (s == "VendorSpecific") return HartVariableRole::VendorSpecific;
    if (s == "Custom") return HartVariableRole::Custom;
    return HartVariableRole::Internal;
}
const char* roleName(HartVariableRole role) {
    switch (role) {
        case HartVariableRole::PrimaryVariable: return "PV";
        case HartVariableRole::SecondaryVariable: return "SV";
        case HartVariableRole::TertiaryVariable: return "TV";
        case HartVariableRole::QuaternaryVariable: return "QV";
        case HartVariableRole::DeviceSpecific: return "DeviceSpecific";
        case HartVariableRole::VendorSpecific: return "VendorSpecific";
        case HartVariableRole::Custom: return "Custom";
        case HartVariableRole::Internal: return "Internal";
    }
    return "Internal";
}
HartVariableType parseType(const std::string& s) {
    if (s == "UInt8") return HartVariableType::UInt8;
    if (s == "UInt16") return HartVariableType::UInt16;
    if (s == "Int16") return HartVariableType::Int16;
    if (s == "PackedAscii") return HartVariableType::PackedAscii;
    if (s == "Bool") return HartVariableType::Bool;
    return HartVariableType::Float32;
}
const char* typeName(HartVariableType type) {
    switch (type) {
        case HartVariableType::UInt8: return "UInt8";
        case HartVariableType::UInt16: return "UInt16";
        case HartVariableType::Int16: return "Int16";
        case HartVariableType::PackedAscii: return "PackedAscii";
        case HartVariableType::Bool: return "Bool";
        case HartVariableType::Float32: return "Float32";
    }
    return "Float32";
}
HartVariableDirection parseDirection(const std::string& s) {
    if (s == "Input") return HartVariableDirection::Input;
    if (s == "Output") return HartVariableDirection::Output;
    return HartVariableDirection::Internal;
}
const char* directionName(HartVariableDirection direction) {
    switch (direction) {
        case HartVariableDirection::Input: return "Input";
        case HartVariableDirection::Output: return "Output";
        case HartVariableDirection::Internal: return "Internal";
    }
    return "Internal";
}
}

std::string HartCommunicationComponent::stringProperty(const registry::ComponentParams& p, const char* n, std::string d) {
    auto it = p.properties.find(n); if (it != p.properties.end()) if (auto v = std::get_if<std::string>(&it->second)) return *v;
    return d;
}
double HartCommunicationComponent::numberProperty(const registry::ComponentParams& p, const char* n, double d) { return p.property(n, d); }

HartCommunicationComponent::HartCommunicationComponent(Mode mode, simulation::Scheduler& scheduler,
                                                       const registry::ComponentParams& p)
    : m_mode(mode), m_scheduler(scheduler), m_engine(m_profiles),
      m_endpoint(m_engine, HartTransportConfig{mode == Mode::Serial ? HartTransportKind::Serial : HartTransportKind::Udp}) {
    m_bus = stringProperty(p, "bus", "hart-1");
    m_endpointName = stringProperty(p, "endpoint", mode == Mode::Serial ? "COM1" : "127.0.0.1");
    m_uniqueId = stringProperty(p, "uniqueId", m_uniqueId);
    m_tag = stringProperty(p, "tag", m_tag);
    m_unit = stringProperty(p, "unit", m_unit);
    m_pollingAddress = static_cast<uint8_t>(std::clamp(numberProperty(p, "pollingAddress", 0), 0.0, 63.0));
    m_baudRate = static_cast<uint32_t>(std::max(1.0, numberProperty(p, "baudRate", 1200)));
    m_udpPort = static_cast<uint16_t>(std::clamp(numberProperty(p, "udpPort", 5094), 1.0, 65535.0));
    m_enabled = p.property("enabled", true);
    // Read on construction, not just on a later setPropertyValue: `addComponent`
    // passes the FULL saved properties map here (including on project reopen,
    // per `registry::ComponentParams`'s own doc comment) -- without this, a
    // saved device's variables/commands were silently dropped and replaced by
    // an empty "[]" on every reopen (Gate 12/section 38 persistence contract).
    m_hartVariablesJson = stringProperty(p, "hartVariablesJson", "[]");
    m_hartCommandsJson = stringProperty(p, "hartCommandsJson", "[]");
    // Universal Command 12/13/16/20/6 identity fields (Anexo F.6): read on
    // construction for the exact same reopen reason as variables/commands
    // above -- without this, a HART write command's effect from a PRIOR
    // session would be silently dropped back to defaults on every reopen.
    m_message = stringProperty(p, "message", "");
    m_descriptor = stringProperty(p, "descriptor", "");
    m_longTag = stringProperty(p, "longTag", "");
    m_date[0] = static_cast<uint8_t>(std::clamp(numberProperty(p, "dateDay", 0), 0.0, 31.0));
    m_date[1] = static_cast<uint8_t>(std::clamp(numberProperty(p, "dateMonth", 0), 0.0, 12.0));
    m_date[2] = static_cast<uint8_t>(std::clamp(numberProperty(p, "dateYear", 0), 0.0, 255.0));
    m_finalAssemblyNumber = static_cast<uint32_t>(std::clamp(numberProperty(p, "finalAssemblyNumber", 0), 0.0, 16777215.0));
    m_loopCurrentModeEnabled = p.property("loopCurrentMode", true);

    HartReferenceCatalog::registerProfiles(m_profiles);
    m_profileId = stringProperty(p, "profileId", m_profileId);
    rebuildConfiguredPlan(); // builds the device from every property above (including
                             // variables/commands) and installs the command hook.
    HartTransportConfig config;
    config.kind = mode == Mode::Serial ? HartTransportKind::Serial : HartTransportKind::Udp;
    config.bus = m_bus; config.endpoint = m_endpointName; config.baudRate = m_baudRate; config.udpPort = m_udpPort;
    m_endpoint.configure(std::move(config));
}

void HartCommunicationComponent::rebuildConfiguredPlan() {
    HartDevicePlan device;
    if (m_deviceId.empty()) m_deviceId = "device-" + m_endpointName;
    device.id = m_deviceId;
    m_deviceId = device.id;
    device.profileId = m_profileId;
    device.bus = m_bus; device.pollingAddress = m_pollingAddress;
    device.uniqueId = m_uniqueId; device.primaryValue = 0.0; device.tag = m_tag;
    device.message = m_message; device.descriptor = m_descriptor; device.date = m_date;
    device.finalAssemblyNumber = {static_cast<uint8_t>(m_finalAssemblyNumber >> 16),
                                  static_cast<uint8_t>(m_finalAssemblyNumber >> 8),
                                  static_cast<uint8_t>(m_finalAssemblyNumber)};
    device.longTag = m_longTag; device.loopCurrentMode = m_loopCurrentModeEnabled ? 1 : 0;
    const HartDeviceProfile* profile = m_profiles.find(device.profileId);
    if (!profile) { m_profileId = "lasecsimul.hart.process-simul-compatible"; device.profileId = m_profileId; profile = m_profiles.find(device.profileId); }
    for (const auto& command : profile->commands) device.commandConfigurations.push_back({command.id, true, false, {}});
    // `HartEngine::execute()` only reaches the compiled-program hook for a
    // command declared in `commandConfigurations` -- a custom command id must
    // be declared here too, or the standard "declared?" check above the hook
    // rejects it before the DSL ever runs. Parsed leniently (best-effort ids
    // only): if the JSON is malformed, `rebuildCommandPrograms()` below is the
    // one authority that reports the compiler error; this loop just needs the
    // id list, not a second copy of the diagnostic.
    //
    // A custom id that collides with one of the 55 catalogued standard/vendor
    // commands NOT in HartCommandJson's 5-id reserved set (e.g. authoring a
    // real body for 0x98 "Vendor Keepalive", currently only an auto-generated
    // echo-body fallback) must be allowed to OVERRIDE it, matching the
    // "custom command with the same id as a fallback wins" fix
    // (HartReferenceCatalog::installCommandPrograms already does this for the
    // HOOK). It must NOT also be pushed here as a second commandConfigurations
    // entry for the same id -- HartPlanCompiler::compile() rejects ANY
    // duplicate `command` value in that list as "duplicate HART command
    // override" regardless of which loop produced it, which would silently
    // fail the whole plan (loadPlan() returns false, the device stops
    // dispatching entirely) for a perfectly legitimate override. The id is
    // already declared (via the profile loop above), so `declaredByProfile`
    // already lets HartEngine::execute() reach the hook -- the hook itself
    // carries the overriding compiled program.
    try {
        const auto parsedCommands = nlohmann::json::parse(m_hartCommandsJson.empty() ? "[]" : m_hartCommandsJson);
        if (parsedCommands.is_array()) {
            for (const auto& entry : parsedCommands) {
                if (!entry.is_object() || !entry.contains("id") || !entry["id"].is_number_integer()) continue;
                const int64_t idValue = entry["id"].get<int64_t>();
                if (idValue < 0 || idValue > 0xFFFF) continue;
                const auto customId = static_cast<HartCommandId>(idValue);
                const bool alreadyDeclared = std::any_of(device.commandConfigurations.begin(), device.commandConfigurations.end(),
                    [customId](const HartDevicePlan::CommandConfiguration& c) { return c.command == customId; });
                if (!alreadyDeclared) device.commandConfigurations.push_back({customId, true, false, {}});
            }
        }
    } catch (...) { /* rebuildCommandPrograms() reports this; the device just keeps the standard commands */ }
    // On any rejection below, the PREVIOUS plan stays loaded (no
    // `m_engine.loadPlan` call happens) -- a malformed edit never corrupts a
    // previously-working device, and the status property tells the Property
    // Inspector exactly why (section 22/54: never a silent dangling state).
    try {
        const auto parsed = nlohmann::json::parse(m_hartVariablesJson.empty() ? "[]" : m_hartVariablesJson);
        if (!parsed.is_array()) { m_hartVariablesStatus = "ERROR: variables must be a JSON array"; return; }
        if (parsed.size() > 64) { m_hartVariablesStatus = "ERROR: too many variables declared (max 64)"; return; }
        for (const auto& item : parsed) {
            if (!item.is_object() || !item.value("id", std::string{}).size()) {
                m_hartVariablesStatus = "ERROR: every variable needs a non-empty id";
                return;
            }
            HartDevicePlan::VariableConfiguration variable;
            variable.id = item.value("id", std::string{});
            variable.name = item.value("name", variable.id);
            variable.unit = item.value("unit", std::string{});
            variable.value = item.value("value", 0.0);
            variable.role = parseRole(item.value("role", std::string{}));
            variable.type = parseType(item.value("type", std::string{}));
            variable.direction = parseDirection(item.value("direction", std::string{}));
            // Legacy flags are accepted only as migration input.  Ownership
            // and access are derived from direction/profile/command semantics;
            // they are never copied into the canonical model.
            for (const auto& already : device.variables) {
                if (already.id == variable.id) {
                    m_hartVariablesStatus = "ERROR: duplicate variable id \"" + variable.id + "\"";
                    return;
                }
            }
            device.variables.push_back(std::move(variable));
        }
    } catch (const std::exception& ex) { m_hartVariablesStatus = std::string("ERROR: ") + ex.what(); return; }
    if (!m_engine.loadPlan(HartProtocolPlan{{std::move(device)}})) {
        m_hartVariablesStatus = "ERROR: plan rejected (see polling address/profile)";
        return;
    }
    m_hartVariablesStatus = "OK";
    rebuildCommandPrograms(); // loadPlan() replaces devices but never touches the hook; re-installing here
                              // is cheap (bounded, cold-pathish) and keeps custom commands live after a
                              // variables edit even though nothing about them actually changed.
}

std::vector<SignalPortDescriptor> HartCommunicationComponent::signalPorts() const {
    std::vector<SignalPortDescriptor> ports;
    try {
        const auto parsed = nlohmann::json::parse(m_hartVariablesJson.empty() ? "[]" : m_hartVariablesJson);
        if (!parsed.is_array()) return ports;
        for (const auto& item : parsed) {
            if (!item.is_object()) continue;
            const std::string id = item.value("id", std::string{});
            if (id.empty()) continue;
            const auto direction = parseDirection(item.value("direction", std::string{}));
            if (direction == HartVariableDirection::Internal) continue;
            const SignalValueKind kind = item.value("type", std::string{}) == "Bool"
                ? SignalValueKind::Digital : SignalValueKind::Analog;
            ports.push_back({id, direction == HartVariableDirection::Input
                                   ? SignalPortDirection::Input : SignalPortDirection::Output,
                             kind, item.value("unit", std::string{})});
        }
    } catch (...) { /* invalid authoring is reported by rebuildConfiguredPlan */ }
    return ports;
}

void HartCommunicationComponent::rebuildCommandPrograms() {
    const auto parsed = HartCommandJson::parseCommandCollection(m_hartCommandsJson);
    if (!parsed.success) {
        HartReferenceCatalog::installCommandPrograms(m_engine); // built-ins only: a broken custom edit never
                                                                 // disables 0x00/0x01/0x03/0x0B/0x21.
        m_hartCommandsStatus = "ERROR: " + parsed.error;
        return;
    }
    const auto installed = HartReferenceCatalog::installCommandPrograms(m_engine, parsed.definitions);
    m_hartCommandsStatus = installed.success ? "OK" : ("ERROR: " + installed.error);
}

void HartCommunicationComponent::syncPersistedStateFromEngine() {
    const HartDevicePlan* plan = m_engine.findDevicePlan(m_deviceId);
    if (!plan) return;
    m_tag = plan->tag;
    m_message = plan->message;
    m_descriptor = plan->descriptor;
    m_date = plan->date;
    const uint32_t fan = (static_cast<uint32_t>(plan->finalAssemblyNumber[0]) << 16) |
                        (static_cast<uint32_t>(plan->finalAssemblyNumber[1]) << 8) |
                        static_cast<uint32_t>(plan->finalAssemblyNumber[2]);
    m_finalAssemblyNumber = fan;
    m_longTag = plan->longTag;
    m_pollingAddress = plan->pollingAddress;
    m_loopCurrentModeEnabled = plan->loopCurrentMode != 0;
}

const char* HartCommunicationComponent::typeId() const { return m_mode == Mode::Serial ? "protocol.hart.serial" : "protocol.hart.udp"; }

void HartCommunicationComponent::onAssignedIndex(uint32_t index) {
    m_componentIndex = index;
    m_deviceId = "hart-device-" + std::to_string(index);
    rebuildConfiguredPlan();
}

std::string HartCommunicationComponent::signalBlockId(std::string_view variableId) const {
    return "hart." + std::to_string(m_componentIndex) + "." + std::string(variableId);
}

bool HartCommunicationComponent::setSignalInput(std::string_view variableId, double value) noexcept {
    return m_engine.setVariableInput(m_deviceId, variableId, value);
}

std::optional<double> HartCommunicationComponent::signalOutput(std::string_view variableId) const noexcept {
    return m_engine.variableValue(m_deviceId, variableId);
}

std::vector<PropertySchema> HartCommunicationComponent::propertySchema(Mode mode) {
    std::vector<PropertySchema> out{
        textSchema("bus", "Canal HART", "Comunicacao", "hart-1"),
        textSchema("endpoint", mode == Mode::Serial ? "Porta serial" : "Endereco UDP", "Comunicacao", mode == Mode::Serial ? "COM1" : "127.0.0.1"),
        {"enabled", "Habilitado", "Comunicacao", "", PropertyValueKind::Bool, "checkbox", true},
        numberSchema("pollingAddress", "Polling address", "HART", "", 0, 0, 63),
        textSchema("profileId", "Perfil de dispositivo", "HART", "lasecsimul.hart.process-simul-compatible"),
        textSchema("uniqueId", "Unique ID", "HART", "029EB1"), textSchema("tag", "Tag", "HART", "HART"),
        textSchema("unit", "Unidade PV", "HART", "V"),
        // Universal Command 12/17 (Message), 13/18 (Descriptor/Date), 16/19
        // (Final Assembly Number), 20/22 (Long Tag), 6/7 (Loop Current Mode)
        // -- persisted so a HART write command's effect survives save/reopen
        // (Anexo F.6). `pollingAddress` above already round-trips Command 6's
        // live-readdressing effect since it is the same schema id
        // `syncPersistedStateFromEngine` writes back into.
        textSchema("message", "Mensagem", "HART", ""),
        textSchema("descriptor", "Descriptor", "HART", ""),
        numberSchema("dateDay", "Data (dia)", "HART", "", 0, 0, 31),
        numberSchema("dateMonth", "Data (mes)", "HART", "", 0, 0, 12),
        numberSchema("dateYear", "Data (ano-1900)", "HART", "", 0, 0, 255),
        numberSchema("finalAssemblyNumber", "Numero de montagem final", "HART", "", 0, 0, 16777215),
        textSchema("longTag", "Long Tag", "HART", ""),
        {"loopCurrentMode", "Corrente de loop habilitada", "HART", "", PropertyValueKind::Bool, "checkbox", true}};
    // Variables/commands are edited exclusively through the Property
    // Inspector's structured collection editors (PropertyInspectorViewProvider
    // -> hartInspectorSections.ts), never as raw JSON text -- hidden from the
    // canvas's generic property sheet so it never offers a second, competing,
    // unstructured editor for the same data (section 3/49). Still fully
    // readable/settable via IPC and via the sidebar, which reads
    // `component.properties` directly rather than iterating visible schemas;
    // `propertyDialogShowAll` remains an escape hatch for debugging.
    auto hartJson = textSchema("hartVariablesJson", "Variáveis HART", "HART", "[]"); hartJson.flags |= PropertySchemaHidden;
    hartJson.flags |= PropertySchemaAffectsTopology;
    out.push_back(hartJson);
    auto hartCommands = textSchema("hartCommandsJson", "Comandos HART", "HART", "[]"); hartCommands.flags |= PropertySchemaHidden;
    out.push_back(hartCommands);
    auto variablesStatus = readonlySchema("hartVariablesStatus", "Status das variáveis", "Diagnostics", "OK"); variablesStatus.flags |= PropertySchemaHidden;
    out.push_back(variablesStatus);
    auto commandsStatus = readonlySchema("hartCommandsStatus", "Status do compilador", "Diagnostics", "OK"); commandsStatus.flags |= PropertySchemaHidden;
    out.push_back(commandsStatus);
    if (mode == Mode::Serial) out.push_back(numberSchema("baudRate", "Baud rate", "Serial", "baud", 1200, 1200, 1200));
    else out.push_back(numberSchema("udpPort", "Porta UDP", "UDP", "", 5094, 1, 65535));
    return out;
}

PropertyValue HartCommunicationComponent::propertyValue(const std::string& id) const {
    if (id == "bus") return m_bus; if (id == "endpoint") return m_endpointName; if (id == "enabled") return m_enabled;
    if (id == "pollingAddress") return static_cast<double>(m_pollingAddress); if (id == "uniqueId") return m_uniqueId;
    if (id == "tag") return m_tag; if (id == "unit") return m_unit; if (id == "profileId") return m_profileId; if (id == "hartVariablesJson") return m_hartVariablesJson; if (id == "hartCommandsJson") return m_hartCommandsJson; if (id == "hartCommandsStatus") return m_hartCommandsStatus; if (id == "hartVariablesStatus") return m_hartVariablesStatus; if (id == "baudRate") return static_cast<double>(m_baudRate);
    if (id == "udpPort") return static_cast<double>(m_udpPort);
    if (id == "message") return m_message; if (id == "descriptor") return m_descriptor; if (id == "longTag") return m_longTag;
    if (id == "dateDay") return static_cast<double>(m_date[0]); if (id == "dateMonth") return static_cast<double>(m_date[1]);
    if (id == "dateYear") return static_cast<double>(m_date[2]);
    if (id == "finalAssemblyNumber") return static_cast<double>(m_finalAssemblyNumber);
    if (id == "loopCurrentMode") return m_loopCurrentModeEnabled;
    return std::string{};
}
void HartCommunicationComponent::setPropertyValue(const std::string& id, const PropertyValue& v) {
    if (id == "bus") { m_bus = std::get<std::string>(v); rebuildConfiguredPlan(); }
    else if (id == "endpoint") { m_endpointName = std::get<std::string>(v); rebuildConfiguredPlan(); }
    else if (id == "enabled") m_enabled = std::get<bool>(v);
    else if (id == "pollingAddress") { m_pollingAddress = static_cast<uint8_t>(std::clamp(std::get<double>(v), 0.0, 63.0)); rebuildConfiguredPlan(); }
    // `tag`/`uniqueId`/`unit` previously assigned the member with NO
    // `rebuildConfiguredPlan()` call -- a real, silent bug: editing the tag
    // in the Property Inspector had no effect on the live `m_engine` until
    // some UNRELATED property edit happened to trigger a rebuild. Fixed
    // alongside the new fields below, which follow the correct pattern from
    // the start (Anexo F.6).
    else if (id == "uniqueId") { m_uniqueId = std::get<std::string>(v); rebuildConfiguredPlan(); }
    else if (id == "tag") { m_tag = std::get<std::string>(v); rebuildConfiguredPlan(); }
    else if (id == "unit") { m_unit = std::get<std::string>(v); rebuildConfiguredPlan(); }
    else if (id == "profileId") { m_profileId = std::get<std::string>(v); rebuildConfiguredPlan(); }
    else if (id == "hartVariablesJson") { m_hartVariablesJson = std::get<std::string>(v); rebuildConfiguredPlan(); }
    else if (id == "hartCommandsJson") { m_hartCommandsJson = std::get<std::string>(v); rebuildCommandPrograms(); }
    else if (id == "baudRate") m_baudRate = 1200;
    else if (id == "udpPort") m_udpPort = static_cast<uint16_t>(std::clamp(std::get<double>(v), 1.0, 65535.0));
    else if (id == "message") { m_message = std::get<std::string>(v); rebuildConfiguredPlan(); }
    else if (id == "descriptor") { m_descriptor = std::get<std::string>(v); rebuildConfiguredPlan(); }
    else if (id == "longTag") { m_longTag = std::get<std::string>(v); rebuildConfiguredPlan(); }
    else if (id == "dateDay") { m_date[0] = static_cast<uint8_t>(std::clamp(std::get<double>(v), 0.0, 31.0)); rebuildConfiguredPlan(); }
    else if (id == "dateMonth") { m_date[1] = static_cast<uint8_t>(std::clamp(std::get<double>(v), 0.0, 12.0)); rebuildConfiguredPlan(); }
    else if (id == "dateYear") { m_date[2] = static_cast<uint8_t>(std::clamp(std::get<double>(v), 0.0, 255.0)); rebuildConfiguredPlan(); }
    else if (id == "finalAssemblyNumber") { m_finalAssemblyNumber = static_cast<uint32_t>(std::clamp(std::get<double>(v), 0.0, 16777215.0)); rebuildConfiguredPlan(); }
    else if (id == "loopCurrentMode") { m_loopCurrentModeEnabled = std::get<bool>(v); rebuildConfiguredPlan(); }
    HartTransportConfig config = m_endpoint.config(); config.bus = m_bus; config.endpoint = m_endpointName;
    config.baudRate = m_baudRate; config.udpPort = m_udpPort; m_endpoint.configure(std::move(config));
}
std::vector<PropertyDescriptor> HartCommunicationComponent::propertyDescriptors() {
    std::vector<PropertyDescriptor> out; for (const auto& schema : propertySchema(m_mode)) out.push_back({schema.id, schema.unit,
        [this, id=schema.id]{ return propertyValue(id); }, [this, id=schema.id](const PropertyValue& v){ setPropertyValue(id,v); }, schema}); return out;
}
size_t HartCommunicationComponent::getState(uint8_t* out, size_t cap) const { struct S { uint8_t enabled, address; }; if (cap < sizeof(S)) return 0; S s{static_cast<uint8_t>(m_enabled),m_pollingAddress}; std::memcpy(out,&s,sizeof s); return sizeof s; }
void HartCommunicationComponent::setState(const uint8_t* in, size_t len) { if (len >= 2) { m_enabled = in[0] != 0; m_pollingAddress = in[1] & 63; } }
} // namespace lasecsimul::protocols
