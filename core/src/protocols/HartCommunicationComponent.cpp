#include "HartCommunicationComponent.hpp"

#include "HartCommandJson.hpp"

#include <algorithm>
#include <cmath>
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
                                                       const registry::ComponentParams& p, const DevicePreset* preset)
    : m_mode(mode),
      m_typeId(preset && preset->typeId ? preset->typeId : (mode == Mode::Serial ? "protocol.hart.serial" : "protocol.hart.udp")),
      m_scheduler(scheduler), m_engine(m_profiles),
      m_endpoint(m_engine, HartTransportConfig{mode == Mode::Serial ? HartTransportKind::Serial : HartTransportKind::Udp}) {
    m_bus = stringProperty(p, "bus", "hart-1");
    m_endpointName = stringProperty(p, "endpoint", mode == Mode::Serial ? "COM1" : "127.0.0.1");
    m_uniqueId = stringProperty(p, "uniqueId", preset ? preset->uniqueId : m_uniqueId);
    m_tag = stringProperty(p, "tag", preset ? preset->tag : m_tag);
    m_unit = stringProperty(p, "unit", preset ? preset->unit : m_unit);
    m_pollingAddress = static_cast<uint8_t>(std::clamp(numberProperty(p, "pollingAddress", 0), 0.0, 63.0));
    m_baudRate = static_cast<uint32_t>(std::max(1.0, numberProperty(p, "baudRate", 1200)));
    m_udpPort = static_cast<uint16_t>(std::clamp(numberProperty(p, "udpPort", 5094), 1.0, 65535.0));
    m_enabled = p.property("enabled", true);
    // Read on construction, not just on a later setPropertyValue: `addComponent`
    // passes the FULL saved properties map here (including on project reopen,
    // per `registry::ComponentParams`'s own doc comment) -- without this, a
    // saved device's variables/commands were silently dropped and replaced by
    // an empty "[]" on every reopen (Gate 12/section 38 persistence contract).
    // A DevicePreset's `hartVariablesJson` is the fallback when `p` carries none (a fresh SMAR
    // device instance, or a test constructing directly with an empty ComponentParams) -- the
    // preset's Signal Graph ports/Device Variable roles apply out of the box, never an empty "[]".
    m_hartVariablesJson = stringProperty(p, "hartVariablesJson", preset ? preset->hartVariablesJson : "[]");
    m_hartCommandsJson = stringProperty(p, "hartCommandsJson", "[]");
    m_hartBurstJson = stringProperty(p, "hartBurstJson", "[]");
    m_hartAdditionalJson = stringProperty(p, "hartAdditionalJson", "{}");
    m_alarmSelectionCode = static_cast<uint8_t>(std::clamp(numberProperty(p, "alarmSelectionCode", 0xFB), 0.0, 255.0));
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
    m_profileId = stringProperty(p, "profileId", preset ? preset->profileId : m_profileId);
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
    device.alarmSelectionCode = m_alarmSelectionCode;
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
            variable.deviceVariableCode = static_cast<uint8_t>(std::clamp(item.value("deviceVariableCode", 255), 0, 255));
            if (variable.deviceVariableCode == 255 && variable.role == HartVariableRole::PrimaryVariable) variable.deviceVariableCode = 246;
            variable.deviceVariableUnit = static_cast<uint8_t>(std::clamp(item.value("deviceVariableUnit", item.value("unitCode", 250)), 0, 255));
            variable.classification = static_cast<uint8_t>(std::clamp(item.value("classification", 0), 0, 255));
            variable.family = static_cast<uint8_t>(std::clamp(item.value("family", 250), 0, 255));
            variable.transducerSerialNumber = item.value("transducerSerialNumber", 0u);
            variable.upperTransducerLimit = item.value("upperTransducerLimit", 0.0f);
            variable.lowerTransducerLimit = item.value("lowerTransducerLimit", 0.0f);
            variable.minimumSpan = item.value("minimumSpan", 0.0f);
            variable.dampingValue = item.value("dampingValue", 0.0f);
            variable.acquisitionPeriod = item.value("acquisitionPeriod", 0xFFFFFFFFu);
            variable.deviceVariableProperties = static_cast<uint8_t>(std::clamp(item.value("deviceVariableProperties", 0), 0, 255));
            variable.deviceVariableStatus = static_cast<uint8_t>(std::clamp(item.value("deviceVariableStatus", 0), 0, 255));
            variable.writable = item.value("writable", false);
            variable.allowedUnitCodes = item.value("allowedUnitCodes", std::vector<uint8_t>{});
            variable.rangeUnitCode = static_cast<uint8_t>(std::clamp(item.value("rangeUnitCode", 255), 0, 255));
            if (item.contains("lowerRangeValue") && item["lowerRangeValue"].is_number())
                variable.lowerRangeValue = item["lowerRangeValue"].get<float>();
            if (item.contains("upperRangeValue") && item["upperRangeValue"].is_number())
                variable.upperRangeValue = item["upperRangeValue"].get<float>();
            variable.trimPointsSupported = static_cast<uint8_t>(std::clamp(item.value("trimPointsSupported", 0), 0, 3));
            variable.trimPointsUnit = static_cast<uint8_t>(std::clamp(item.value("trimPointsUnit", 250), 0, 255));
            if (item.contains("lowerTrimPoint") && item["lowerTrimPoint"].is_number()) variable.lowerTrimPoint = item["lowerTrimPoint"].get<float>();
            if (item.contains("upperTrimPoint") && item["upperTrimPoint"].is_number()) variable.upperTrimPoint = item["upperTrimPoint"].get<float>();
            if (item.contains("minimumLowerTrimPoint") && item["minimumLowerTrimPoint"].is_number()) variable.minimumLowerTrimPoint = item["minimumLowerTrimPoint"].get<float>();
            if (item.contains("maximumLowerTrimPoint") && item["maximumLowerTrimPoint"].is_number()) variable.maximumLowerTrimPoint = item["maximumLowerTrimPoint"].get<float>();
            if (item.contains("minimumUpperTrimPoint") && item["minimumUpperTrimPoint"].is_number()) variable.minimumUpperTrimPoint = item["minimumUpperTrimPoint"].get<float>();
            if (item.contains("maximumUpperTrimPoint") && item["maximumUpperTrimPoint"].is_number()) variable.maximumUpperTrimPoint = item["maximumUpperTrimPoint"].get<float>();
            if (item.contains("minimumTrimDifferential") && item["minimumTrimDifferential"].is_number()) variable.minimumTrimDifferential = item["minimumTrimDifferential"].get<float>();
            variable.trimAdjustment = item.value("trimAdjustment", 0.0f);
            variable.factoryTrimAdjustment = item.value("factoryTrimAdjustment", 0.0f);
            if (item.contains("pressure") && item["pressure"].is_object()) {
                const auto& p = item["pressure"];
                auto& pressure = variable.pressure;
                pressure.status0 = static_cast<uint8_t>(std::clamp(p.value("status0", 0), 0, 255));
                pressure.familyDefinitionRevision = static_cast<uint8_t>(std::clamp(p.value("familyDefinitionRevision", 0), 0, 255));
                pressure.familyCapabilities0 = static_cast<uint8_t>(std::clamp(p.value("familyCapabilities0", 0), 0, 255));
                pressure.familyCapabilities1 = static_cast<uint8_t>(std::clamp(p.value("familyCapabilities1", 0), 0, 255));
                pressure.supportedStatusFamilyMask = static_cast<uint8_t>(std::clamp(p.value("supportedStatusFamilyMask", 0), 0, 255));
                pressure.supportedStatus0Mask = static_cast<uint8_t>(std::clamp(p.value("supportedStatus0Mask", 0), 0, 255));
                pressure.measurementType = static_cast<uint8_t>(std::clamp(p.value("measurementType", 251), 0, 255));
                pressure.moduleFillFluid = static_cast<uint8_t>(std::clamp(p.value("moduleFillFluid", 251), 0, 255));
                pressure.diaphragmMaterial = static_cast<uint8_t>(std::clamp(p.value("diaphragmMaterial", 251), 0, 255));
                pressure.sensorHardwareRevision = static_cast<uint8_t>(std::clamp(p.value("sensorHardwareRevision", 0), 0, 255));
                pressure.sensorTechnology = static_cast<uint8_t>(std::clamp(p.value("sensorTechnology", 251), 0, 255));
                pressure.pressureUnitCode = static_cast<uint8_t>(std::clamp(p.value("pressureUnitCode", 251), 0, 255));
                pressure.minimumAbsolutePressure = p.value("minimumAbsolutePressure", 0.0f);
                pressure.maximumStaticPressure = p.value("maximumStaticPressure", 0.0f);
                pressure.associatedTemperatureVariableId = p.value("associatedTemperatureVariableId", std::string{});
                pressure.associatedStaticPressureVariableId = p.value("associatedStaticPressureVariableId", std::string{});
                pressure.pressureObservationUnit = static_cast<uint8_t>(std::clamp(p.value("pressureObservationUnit", 251), 0, 255));
                pressure.minimumPressureObservation = p.value("minimumPressureObservation", 0.0f);
                pressure.maximumPressureObservation = p.value("maximumPressureObservation", 0.0f);
                pressure.temperatureObservationUnit = static_cast<uint8_t>(std::clamp(p.value("temperatureObservationUnit", 251), 0, 255));
                pressure.minimumTemperatureObservation = p.value("minimumTemperatureObservation", 0.0f);
                pressure.maximumTemperatureObservation = p.value("maximumTemperatureObservation", 0.0f);
                pressure.staticPressureObservationUnit = static_cast<uint8_t>(std::clamp(p.value("staticPressureObservationUnit", 251), 0, 255));
                pressure.minimumStaticPressureObservation = p.value("minimumStaticPressureObservation", 0.0f);
                pressure.maximumStaticPressureObservation = p.value("maximumStaticPressureObservation", 0.0f);
                pressure.supportsOptionalGasket = p.value("supportsOptionalGasket", false);
                pressure.supportsPressureObservation = p.value("supportsPressureObservation", false);
                pressure.supportsTemperatureObservation = p.value("supportsTemperatureObservation", false);
                pressure.supportsStaticPressureObservation = p.value("supportsStaticPressureObservation", false);
                pressure.supportsRemoteSeal = p.value("supportsRemoteSeal", false);
                pressure.supportsWriteProcessConnection = p.value("supportsWriteProcessConnection", false);
                pressure.supportsWriteOptionalGasket = p.value("supportsWriteOptionalGasket", false);
                pressure.supportsWriteRemoteSeal = p.value("supportsWriteRemoteSeal", false);
                if (p.contains("processConnection") && p["processConnection"].is_array() && p["processConnection"].size() == pressure.processConnection.size())
                    for (size_t i = 0; i < pressure.processConnection.size(); ++i) pressure.processConnection[i] = p["processConnection"][i].get<uint8_t>();
                if (p.contains("optionalGasket") && p["optionalGasket"].is_array() && p["optionalGasket"].size() == pressure.optionalGasket.size())
                    for (size_t i = 0; i < pressure.optionalGasket.size(); ++i) pressure.optionalGasket[i] = p["optionalGasket"][i].get<uint8_t>();
                if (p.contains("remoteSeal") && p["remoteSeal"].is_array() && p["remoteSeal"].size() == pressure.remoteSeal.size())
                    for (size_t i = 0; i < pressure.remoteSeal.size(); ++i) pressure.remoteSeal[i] = p["remoteSeal"][i].get<uint8_t>();
            }
            if (item.contains("temperature") && item["temperature"].is_object()) {
                const auto& t = item["temperature"];
                auto& temperature = variable.temperature;
                temperature.familyStatus = static_cast<uint8_t>(std::clamp(t.value("familyStatus", 0), 0, 255));
                temperature.familyStatus0 = static_cast<uint8_t>(std::clamp(t.value("familyStatus0", 0), 0, 255));
                temperature.probeType = static_cast<uint8_t>(std::clamp(t.value("probeType", 0), 0, 255));
                temperature.numberOfWires = static_cast<uint8_t>(std::clamp(t.value("numberOfWires", 0), 0, 255));
                temperature.temperatureStandard = static_cast<uint8_t>(std::clamp(t.value("temperatureStandard", 0), 0, 255));
                temperature.probeConnection = static_cast<uint8_t>(std::clamp(t.value("probeConnection", 0), 0, 255));
                temperature.coldJunctionCompensationType = static_cast<uint8_t>(std::clamp(t.value("coldJunctionCompensationType", 0), 0, 255));
                temperature.manualColdJunctionUnit = static_cast<uint8_t>(std::clamp(t.value("manualColdJunctionUnit", 250), 0, 255));
                temperature.manualColdJunctionTemperature = t.value("manualColdJunctionTemperature", 0.0f);
                temperature.cvdA = t.value("cvdA", 0.0f);
                temperature.cvdB = t.value("cvdB", 0.0f);
                temperature.cvdC = t.value("cvdC", 0.0f);
                temperature.cvdR0 = t.value("cvdR0", 0.0f);
                temperature.supportsThermocouple = t.value("supportsThermocouple", false);
                temperature.supportsCalibratedRtd = t.value("supportsCalibratedRtd", false);
                temperature.supportsWriteTemperatureStandard = t.value("supportsWriteTemperatureStandard", false);
                temperature.supportsWriteProbeConnection = t.value("supportsWriteProbeConnection", false);
                temperature.supportsWriteColdJunction = t.value("supportsWriteColdJunction", false);
            }
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
    try {
        const auto bursts = nlohmann::json::parse(m_hartBurstJson.empty() ? "[]" : m_hartBurstJson);
        if (!bursts.is_array() || bursts.size() > device.burstMessages.size()) { m_hartVariablesStatus = "ERROR: invalid Burst configuration JSON"; return; }
        device.burstMessageCount = static_cast<uint8_t>(bursts.size());
        for (size_t i = 0; i < device.burstMessageCount; ++i) {
            const auto& item = bursts[i];
            if (!item.is_object()) { m_hartVariablesStatus = "ERROR: Burst entries must be objects"; return; }
            auto& burst = device.burstMessages[i];
            burst.control = static_cast<uint8_t>(std::clamp(item.value("control", 0), 0, 3));
            burst.command = static_cast<HartCommandId>(std::clamp(item.value("command", 1), 0, 65535));
            burst.updatePeriodTicks = item.value("updatePeriodTicks", 32000u);
            burst.maximumUpdatePeriodTicks = item.value("maximumUpdatePeriodTicks", 32000u);
            burst.triggerMode = static_cast<uint8_t>(std::clamp(item.value("triggerMode", 0), 0, 3));
            burst.triggerClassification = static_cast<uint8_t>(std::clamp(item.value("triggerClassification", 0), 0, 255));
            burst.triggerUnits = static_cast<uint8_t>(std::clamp(item.value("triggerUnits", 250), 0, 255));
            if (item.contains("triggerValue") && item["triggerValue"].is_number()) burst.triggerValue = item["triggerValue"].get<float>();
            burst.mappedSubDeviceId = item.value("mappedSubDeviceId", std::string{});
            if (item.contains("deviceVariableCodes") && item["deviceVariableCodes"].is_array()) {
                if (item["deviceVariableCodes"].size() != burst.deviceVariableCodes.size()) { m_hartVariablesStatus = "ERROR: Burst variable list must contain 8 slots"; return; }
                for (size_t slot = 0; slot < burst.deviceVariableCodes.size(); ++slot)
                    burst.deviceVariableCodes[slot] = static_cast<uint8_t>(std::clamp(item["deviceVariableCodes"][slot].get<int>(), 0, 255));
            }
        }
    } catch (...) { m_hartVariablesStatus = "ERROR: invalid Burst configuration JSON"; return; }
    try {
        const auto additional = nlohmann::json::parse(m_hartAdditionalJson.empty() ? "{}" : m_hartAdditionalJson);
        if (!additional.is_object()) { m_hartVariablesStatus = "ERROR: Additional Common Practice JSON must be an object"; return; }
        const auto country = additional.value("countryCode", std::string{});
        if (country.size() == 2) { device.countryCode = {static_cast<uint8_t>(country[0]), static_cast<uint8_t>(country[1])}; }
        device.siUnitsControl = static_cast<uint8_t>(std::clamp(additional.value("siUnitsControl", 0), 0, 1));
        device.deviceLocationSupported = additional.value("deviceLocationSupported", false);
        device.deviceLocation.latitude = additional.value("latitude", 0.0f);
        device.deviceLocation.longitude = additional.value("longitude", 0.0f);
        device.deviceLocation.method = static_cast<uint8_t>(std::clamp(additional.value("locationMethod", 0), 0, 8));
        device.deviceLocation.altitude = additional.value("altitude", 0.0f);
        device.locationDescriptionSupported = additional.value("locationDescriptionSupported", false);
        device.processUnitTagSupported = additional.value("processUnitTagSupported", false);
        const auto copyFixed = [](const std::string& text, auto& target) {
            target.fill(0); std::copy_n(reinterpret_cast<const uint8_t*>(text.data()), std::min(text.size(), target.size()), target.begin());
        };
        copyFixed(additional.value("locationDescription", std::string{}), device.locationDescription);
        copyFixed(additional.value("processUnitTag", std::string{}), device.processUnitTag);
        device.condensedStatusSupported = additional.value("condensedStatusSupported", false);
        if (additional.contains("wireless") && additional["wireless"].is_object()) {
            const auto& w = additional["wireless"];
            auto& wireless = device.wireless;
            wireless.capable = w.value("capable", false);
            wireless.networkId = static_cast<uint16_t>(std::clamp(w.value("networkId", 0), 0, 65535));
            wireless.pendingNetworkId = static_cast<uint16_t>(std::clamp(w.value("pendingNetworkId", static_cast<int>(wireless.networkId)), 0, 65535));
            wireless.joinMode = static_cast<uint8_t>(std::clamp(w.value("joinMode", 0), 0, 255));
            wireless.activeSearchShedTime = w.value("activeSearchShedTime", 0u);
            wireless.maxJoinRetries = static_cast<uint8_t>(std::clamp(w.value("maxJoinRetries", 5), 0, 255));
            wireless.radioTransmitPower = static_cast<uint8_t>(std::clamp(w.value("radioTransmitPower", 0), 0, 255));
            wireless.ccaMode = static_cast<uint8_t>(std::clamp(w.value("ccaMode", 0), 0, 255));
            wireless.packetTimeToLive = w.value("packetTimeToLive", 0u);
            wireless.joinPriority = static_cast<uint8_t>(std::clamp(w.value("joinPriority", 0), 0, 255));
            wireless.packetReceivePriority = static_cast<uint8_t>(std::clamp(w.value("packetReceivePriority", 0), 0, 255));
            wireless.networkAccessMode = static_cast<uint8_t>(std::clamp(w.value("networkAccessMode", 0), 0, 255));
            wireless.joinKeyMode = static_cast<uint8_t>(std::clamp(w.value("joinKeyMode", 0), 0, 255));
            wireless.batteryLifeDays = static_cast<uint16_t>(std::clamp(w.value("batteryLifeDays", 65535), 0, 65535));
            wireless.nickname = static_cast<uint16_t>(std::clamp(w.value("nickname", 0), 0, 65535));
            wireless.securityLevelAdvertised = static_cast<uint8_t>(std::clamp(w.value("securityLevelAdvertised", 1), 0, 255));
            auto copyBytes = [](const nlohmann::json& value, auto& target) {
                if (!value.is_array() || value.size() != target.size()) return;
                for (size_t i = 0; i < target.size(); ++i) target[i] = static_cast<uint8_t>(std::clamp(value[i].get<int>(), 0, 255));
            };
            copyBytes(w.value("joinKey", nlohmann::json::array()), wireless.joinKey);
            copyBytes(w.value("networkTag", nlohmann::json::array()), wireless.networkTag);
        }
        if (additional.contains("condensedStatusMapping") && additional["condensedStatusMapping"].is_array()) {
            if (additional["condensedStatusMapping"].size() != device.condensedStatusMapping.size()) { m_hartVariablesStatus = "ERROR: invalid Condensed Status mapping length"; return; }
            for (size_t i = 0; i < device.condensedStatusMapping.size(); ++i) device.condensedStatusMapping[i] = additional["condensedStatusMapping"][i].get<uint8_t>();
        }
        device.assignmentCapacity = static_cast<uint8_t>(std::clamp(additional.value("assignmentCapacity", 0), 0, 32));
        if (additional.contains("assignments") && additional["assignments"].is_array()) {
            if (additional["assignments"].size() > device.assignments.size()) { m_hartVariablesStatus = "ERROR: assignment list exceeds capacity"; return; }
            device.assignmentCount = static_cast<uint8_t>(additional["assignments"].size());
            for (size_t i = 0; i < device.assignmentCount; ++i) {
                const auto& item = additional["assignments"][i];
                if (!item.is_object()) { m_hartVariablesStatus = "ERROR: invalid assignment entry"; return; }
                auto& assignment = device.assignments[i]; assignment.index = static_cast<uint16_t>(i + 1);
                assignment.ioCard = static_cast<uint8_t>(std::clamp(item.value("ioCard", 255), 0, 255));
                assignment.channel = static_cast<uint8_t>(std::clamp(item.value("channel", 255), 0, 255));
                assignment.manufacturerId = item.value("manufacturerId", 0u);
                assignment.expandedDeviceType = item.value("expandedDeviceType", 0u);
                assignment.deviceId = item.value("deviceId", 0u);
                copyFixed(item.value("longTag", std::string{}), assignment.longTag);
                assignment.deviceRevision = static_cast<uint8_t>(std::clamp(item.value("deviceRevision", 0), 0, 255));
                assignment.childDeviceId = item.value("childDeviceId", std::string{});
            }
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
    m_alarmSelectionCode = plan->alarmSelectionCode;
    try {
        nlohmann::json bursts = nlohmann::json::array();
        for (size_t i = 0; i < plan->burstMessageCount && i < plan->burstMessages.size(); ++i) {
            const auto& burst = plan->burstMessages[i];
            bursts.push_back({{"control", burst.control}, {"command", burst.command},
                              {"deviceVariableCodes", burst.deviceVariableCodes},
                              {"updatePeriodTicks", burst.updatePeriodTicks},
                              {"maximumUpdatePeriodTicks", burst.maximumUpdatePeriodTicks},
                              {"triggerMode", burst.triggerMode}, {"triggerClassification", burst.triggerClassification},
                              {"triggerUnits", burst.triggerUnits}, {"triggerValue", burst.triggerValue},
                              {"mappedSubDeviceId", burst.mappedSubDeviceId}});
        }
        m_hartBurstJson = bursts.dump();
    } catch (...) {}
    try {
        nlohmann::json additional;
        additional["countryCode"] = std::string(reinterpret_cast<const char*>(plan->countryCode.data()), plan->countryCode.size());
        additional["siUnitsControl"] = plan->siUnitsControl;
        additional["deviceLocationSupported"] = plan->deviceLocationSupported;
        additional["latitude"] = plan->deviceLocation.latitude;
        additional["longitude"] = plan->deviceLocation.longitude;
        additional["locationMethod"] = plan->deviceLocation.method;
        additional["altitude"] = plan->deviceLocation.altitude;
        additional["locationDescriptionSupported"] = plan->locationDescriptionSupported;
        additional["processUnitTagSupported"] = plan->processUnitTagSupported;
        additional["locationDescription"] = std::string(reinterpret_cast<const char*>(plan->locationDescription.data()), plan->locationDescription.size());
        additional["processUnitTag"] = std::string(reinterpret_cast<const char*>(plan->processUnitTag.data()), plan->processUnitTag.size());
        additional["condensedStatusSupported"] = plan->condensedStatusSupported;
        additional["condensedStatusMapping"] = plan->condensedStatusMapping;
        const auto& wireless = plan->wireless;
        additional["wireless"] = {
            {"capable", wireless.capable}, {"networkId", wireless.networkId},
            {"pendingNetworkId", wireless.pendingNetworkId}, {"joinMode", wireless.joinMode},
            {"activeSearchShedTime", wireless.activeSearchShedTime}, {"maxJoinRetries", wireless.maxJoinRetries},
            {"radioTransmitPower", wireless.radioTransmitPower}, {"ccaMode", wireless.ccaMode},
            {"packetTimeToLive", wireless.packetTimeToLive}, {"joinPriority", wireless.joinPriority},
            {"packetReceivePriority", wireless.packetReceivePriority}, {"networkAccessMode", wireless.networkAccessMode},
            {"joinKeyMode", wireless.joinKeyMode}, {"joinKey", wireless.joinKey}, {"networkTag", wireless.networkTag}
            , {"batteryLifeDays", wireless.batteryLifeDays}, {"nickname", wireless.nickname},
            {"securityLevelAdvertised", wireless.securityLevelAdvertised}
        };
        additional["assignmentCapacity"] = plan->assignmentCapacity;
        additional["assignments"] = nlohmann::json::array();
        for (size_t i = 0; i < plan->assignmentCount && i < plan->assignments.size(); ++i) {
            const auto& assignment = plan->assignments[i];
            additional["assignments"].push_back({
                {"ioCard", assignment.ioCard}, {"channel", assignment.channel}, {"manufacturerId", assignment.manufacturerId},
                {"expandedDeviceType", assignment.expandedDeviceType}, {"deviceId", assignment.deviceId},
                {"longTag", std::string(reinterpret_cast<const char*>(assignment.longTag.data()), assignment.longTag.size())},
                {"deviceRevision", assignment.deviceRevision}, {"childDeviceId", assignment.childDeviceId}});
        }
        m_hartAdditionalJson = additional.dump();
    } catch (...) {}
    // Device-variable writes (including Common Practice 35/36/37) must also
    // update the component's serialized authoring payload. This is the
    // component-level save/reopen bridge; the engine plan remains the sole
    // runtime authority.
    try {
        auto variables = nlohmann::json::parse(m_hartVariablesJson.empty() ? "[]" : m_hartVariablesJson);
        if (variables.is_array()) {
            for (auto& item : variables) {
                if (!item.is_object()) continue;
                const std::string id = item.value("id", std::string{});
                const auto it = std::find_if(plan->variables.begin(), plan->variables.end(),
                    [&](const auto& variable) { return variable.id == id; });
                if (it == plan->variables.end()) continue;
                item["value"] = it->value;
                item["deviceVariableUnit"] = it->deviceVariableUnit;
                item["dampingValue"] = it->dampingValue;
                if (it->rangeUnitCode != 0xFF) item["rangeUnitCode"] = it->rangeUnitCode;
                if (std::isfinite(it->lowerRangeValue)) item["lowerRangeValue"] = it->lowerRangeValue;
                if (std::isfinite(it->upperRangeValue)) item["upperRangeValue"] = it->upperRangeValue;
                item["trimPointsSupported"] = it->trimPointsSupported;
                item["trimPointsUnit"] = it->trimPointsUnit;
                const auto& pressure = it->pressure;
                item["pressure"] = {
                    {"status0", pressure.status0}, {"familyDefinitionRevision", pressure.familyDefinitionRevision},
                    {"familyCapabilities0", pressure.familyCapabilities0}, {"familyCapabilities1", pressure.familyCapabilities1},
                    {"supportedStatusFamilyMask", pressure.supportedStatusFamilyMask}, {"supportedStatus0Mask", pressure.supportedStatus0Mask},
                    {"measurementType", pressure.measurementType}, {"moduleFillFluid", pressure.moduleFillFluid},
                    {"diaphragmMaterial", pressure.diaphragmMaterial}, {"sensorHardwareRevision", pressure.sensorHardwareRevision},
                    {"sensorTechnology", pressure.sensorTechnology}, {"pressureUnitCode", pressure.pressureUnitCode},
                    {"minimumAbsolutePressure", pressure.minimumAbsolutePressure}, {"maximumStaticPressure", pressure.maximumStaticPressure},
                    {"processConnection", pressure.processConnection},
                    {"associatedTemperatureVariableId", pressure.associatedTemperatureVariableId},
                    {"associatedStaticPressureVariableId", pressure.associatedStaticPressureVariableId},
                    {"optionalGasket", pressure.optionalGasket}, {"pressureObservationUnit", pressure.pressureObservationUnit},
                    {"minimumPressureObservation", pressure.minimumPressureObservation}, {"maximumPressureObservation", pressure.maximumPressureObservation},
                    {"temperatureObservationUnit", pressure.temperatureObservationUnit},
                    {"minimumTemperatureObservation", pressure.minimumTemperatureObservation}, {"maximumTemperatureObservation", pressure.maximumTemperatureObservation},
                    {"staticPressureObservationUnit", pressure.staticPressureObservationUnit},
                    {"minimumStaticPressureObservation", pressure.minimumStaticPressureObservation}, {"maximumStaticPressureObservation", pressure.maximumStaticPressure},
                    {"remoteSeal", pressure.remoteSeal}, {"supportsOptionalGasket", pressure.supportsOptionalGasket},
                    {"supportsPressureObservation", pressure.supportsPressureObservation}, {"supportsTemperatureObservation", pressure.supportsTemperatureObservation},
                    {"supportsStaticPressureObservation", pressure.supportsStaticPressureObservation}, {"supportsRemoteSeal", pressure.supportsRemoteSeal},
                    {"supportsWriteProcessConnection", pressure.supportsWriteProcessConnection},
                    {"supportsWriteOptionalGasket", pressure.supportsWriteOptionalGasket}, {"supportsWriteRemoteSeal", pressure.supportsWriteRemoteSeal}
                };
                const auto& temperature = it->temperature;
                item["temperature"] = {
                    {"familyStatus", temperature.familyStatus}, {"familyStatus0", temperature.familyStatus0},
                    {"probeType", temperature.probeType}, {"numberOfWires", temperature.numberOfWires},
                    {"temperatureStandard", temperature.temperatureStandard}, {"probeConnection", temperature.probeConnection},
                    {"coldJunctionCompensationType", temperature.coldJunctionCompensationType},
                    {"manualColdJunctionUnit", temperature.manualColdJunctionUnit},
                    {"manualColdJunctionTemperature", temperature.manualColdJunctionTemperature},
                    {"cvdA", temperature.cvdA}, {"cvdB", temperature.cvdB},
                    {"cvdC", temperature.cvdC}, {"cvdR0", temperature.cvdR0},
                    {"supportsThermocouple", temperature.supportsThermocouple},
                    {"supportsCalibratedRtd", temperature.supportsCalibratedRtd},
                    {"supportsWriteTemperatureStandard", temperature.supportsWriteTemperatureStandard},
                    {"supportsWriteProbeConnection", temperature.supportsWriteProbeConnection},
                    {"supportsWriteColdJunction", temperature.supportsWriteColdJunction}
                };
                if (std::isfinite(it->lowerTrimPoint)) item["lowerTrimPoint"] = it->lowerTrimPoint;
                if (std::isfinite(it->upperTrimPoint)) item["upperTrimPoint"] = it->upperTrimPoint;
                if (std::isfinite(it->minimumLowerTrimPoint)) item["minimumLowerTrimPoint"] = it->minimumLowerTrimPoint;
                if (std::isfinite(it->maximumLowerTrimPoint)) item["maximumLowerTrimPoint"] = it->maximumLowerTrimPoint;
                if (std::isfinite(it->minimumUpperTrimPoint)) item["minimumUpperTrimPoint"] = it->minimumUpperTrimPoint;
                if (std::isfinite(it->maximumUpperTrimPoint)) item["maximumUpperTrimPoint"] = it->maximumUpperTrimPoint;
                if (std::isfinite(it->minimumTrimDifferential)) item["minimumTrimDifferential"] = it->minimumTrimDifferential;
                item["trimAdjustment"] = it->trimAdjustment;
                item["factoryTrimAdjustment"] = it->factoryTrimAdjustment;
            }
            m_hartVariablesJson = variables.dump();
        }
    } catch (...) {
        // The rebuild path already exposes malformed authoring via the
        // diagnostics property; persistence sync must never throw from a
        // successful transport transaction.
    }
}

const char* HartCommunicationComponent::typeId() const { return m_typeId.c_str(); }

void HartCommunicationComponent::onAssignedIndex(uint32_t index) {
    m_componentIndex = index;
    m_deviceId = "hart-device-" + std::to_string(index);
    rebuildConfiguredPlan();
}

std::string HartCommunicationComponent::signalBlockId(std::string_view variableId) const {
    // Delegates to the ONE naming authority every `signalPorts()`-exposing
    // component shares (`lasecsimul::signalPortBlockId`) -- HART is just a
    // consumer of the generic Signal Graph port infrastructure, not a second,
    // independently-named one.
    return signalPortBlockId(m_componentIndex, variableId);
}

bool HartCommunicationComponent::setSignalInput(std::string_view variableId, double value) noexcept {
    return m_engine.setVariableInput(m_deviceId, variableId, value);
}

std::optional<double> HartCommunicationComponent::signalOutput(std::string_view variableId) const noexcept {
    // `HartEngine::variableValue` is a generic "read this device's current
    // variable value" accessor (also used internally by Command 113/114's
    // Catch mechanism, which legitimately reads variables of any direction)
    // -- it does not itself restrict to Output-direction variables. This
    // wrapper is the actual Signal Graph-facing boundary
    // (`SimulationSession::publishHartOutputsToSignalUnlocked`), so it
    // enforces the same "not a real Signal Graph port" rule
    // `setSignalInput` already enforces for Input, rather than relying
    // entirely on every caller already having filtered via `signalPorts()`.
    const HartDevicePlan* plan = m_engine.findDevicePlan(m_deviceId);
    if (!plan) return std::nullopt;
    const auto variable = std::find_if(plan->variables.begin(), plan->variables.end(),
        [&](const auto& candidate) { return candidate.id == variableId; });
    if (variable == plan->variables.end() || variable->direction != HartVariableDirection::Output) return std::nullopt;
    return m_engine.variableValue(m_deviceId, variableId);
}

std::vector<PropertySchema> HartCommunicationComponent::propertySchema(Mode mode, const DevicePreset* preset) {
    std::vector<PropertySchema> out{
        textSchema("bus", "Canal HART", "Comunicacao", "hart-1"),
        textSchema("endpoint", mode == Mode::Serial ? "Porta serial" : "Endereco UDP", "Comunicacao", mode == Mode::Serial ? "COM1" : "127.0.0.1"),
        {"enabled", "Habilitado", "Comunicacao", "", PropertyValueKind::Bool, "checkbox", true},
        numberSchema("pollingAddress", "Polling address", "HART", "", 0, 0, 63),
        textSchema("profileId", "Perfil de dispositivo", "HART", preset ? preset->profileId : "lasecsimul.hart.process-simul-compatible"),
        textSchema("uniqueId", "Unique ID", "HART", preset ? preset->uniqueId : "029EB1"),
        textSchema("tag", "Tag", "HART", preset ? preset->tag : "HART"),
        textSchema("unit", "Unidade PV", "HART", preset ? preset->unit : "V"),
        numberSchema("alarmSelectionCode", "PV alarm selection code", "HART", "", 251, 0, 255),
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
    auto hartJson = textSchema("hartVariablesJson", "Variáveis HART", "HART", preset ? preset->hartVariablesJson : "[]"); hartJson.flags |= PropertySchemaHidden;
    // AffectsTopology (Input/Output materializa/desmaterializa uma porta Signal Graph -- edição
    // estrutural, ver ARCH-002) + AffectsPinCount: embora `pins()` (linha 27, `HartCommunicationComponent.
    // hpp`) permaneça sempre vazio -- separação deliberada Electrical Pins x Signal Ports, nunca
    // misturadas -- o flag também é o que o lado da Extension usa (`propertySchema[].affectsPinCount` sincronizado
    // por IPC) pra saber que precisa recalcular os pinos de CANVAS (`pinsForTypeId` ->
    // `hartSignalGraphPinIds`) e podar fios órfãos depois de editar esta propriedade -- sem ele, um
    // fio Signal Graph sobreviveria visualmente apontando pra uma porta que a variável removida já
    // não tem mais.
    hartJson.flags |= PropertySchemaAffectsTopology | PropertySchemaAffectsPinCount;
    out.push_back(hartJson);
    auto hartCommands = textSchema("hartCommandsJson", "Comandos HART", "HART", "[]"); hartCommands.flags |= PropertySchemaHidden;
    out.push_back(hartCommands);
    auto hartBurst = textSchema("hartBurstJson", "Burst HART", "HART", "[]"); hartBurst.flags |= PropertySchemaHidden;
    out.push_back(hartBurst);
    auto hartAdditional = textSchema("hartAdditionalJson", "Additional Common Practice HART", "HART", "{}"); hartAdditional.flags |= PropertySchemaHidden;
    out.push_back(hartAdditional);
    auto variablesStatus = readonlySchema("hartVariablesStatus", "Status das variáveis", "Diagnostics", "OK"); variablesStatus.flags |= PropertySchemaHidden;
    out.push_back(variablesStatus);
    auto commandsStatus = readonlySchema("hartCommandsStatus", "Status do compilador", "Diagnostics", "OK"); commandsStatus.flags |= PropertySchemaHidden;
    out.push_back(commandsStatus);
    if (mode == Mode::Serial) out.push_back(numberSchema("baudRate", "Baud rate", "Serial", "baud", 1200, 1200, 1200));
    else out.push_back(numberSchema("udpPort", "Porta UDP", "UDP", "", 5094, 1, 65535));
    return out;
}

HartCommunicationComponent::DevicePreset HartCommunicationComponent::smarLd301Preset() {
    // PV's id is literally "PV" -- HartEngine::evaluatePrimary() (the single authority Commands
    // 1/2/3/9/21/etc. all read through) only recognizes a variable id of "PV" or "primary" as THE
    // primary variable; any other id would leave those commands reading the unrelated
    // HartDevicePlan::primaryValue scalar (which nothing here ever writes), silently returning 0
    // forever regardless of what the Signal Graph feeds in. direction="Input" because the real
    // process quantity (differential pressure) is produced upstream by the Signal Graph and flows
    // INTO the transmitter -- the device does not invent it. classification=65 (0x41 Pressure) and
    // family=5 (0x05 "Pressure" Device Variable Family) are the real HCF Common Table 21/20 codes.
    return {"protocol.hart.device.smar_ld301", HartReferenceCatalog::makeSmarLd301Profile().id, "LD301", "029EB1", "kPa",
            R"json([{"id":"PV","name":"Pressao Diferencial","unit":"kPa","value":0.0,"role":"PV","type":"Float32",)json"
            R"json("direction":"Input","classification":65,"family":5,"writable":false,"lowerRangeValue":0.0,)json"
            R"json("upperRangeValue":25.0,"pressure":{"pressureUnitCode":12}}])json"};
}

HartCommunicationComponent::DevicePreset HartCommunicationComponent::smarTt301Preset() {
    return {"protocol.hart.device.smar_tt301", HartReferenceCatalog::makeSmarTt301Profile().id, "TT301", "029EB1", "C",
            R"json([{"id":"PV","name":"Temperatura","unit":"C","value":25.0,"role":"PV","type":"Float32",)json"
            R"json("direction":"Input","classification":64,"family":4,"writable":false,"lowerRangeValue":-50.0,)json"
            R"json("upperRangeValue":200.0,"temperature":{"probeType":0,"numberOfWires":3}}])json"};
}

HartCommunicationComponent::DevicePreset HartCommunicationComponent::smarFy301Preset() {
    // Two variables, not one InOut: "PV" (Input) is the actual measured position fed back by
    // whatever Signal Graph valve-dynamics chain the user wires downstream (e.g. the existing
    // Controle-tab rate_limiter/stiction/valve_characteristic blocks -- no new dynamics/timer code
    // here, per the "reuse the existing SignalEngine" mandate); "setpoint" (Output) is the position
    // the device/HART host commands, which that SAME dynamics chain consumes as its input. This
    // mirrors how a real positioner splits target vs. actual travel instead of pretending
    // output==input. classification=91 (0x5B Valve Actuator) and family=6 (0x06 "Valve / Actuator")
    // are the real HCF codes; no Valve Positioner Device Family (HCF_SPEC-160.6) commands are wired
    // here since that family is not implemented in the engine -- FY301 works via Universal/Common
    // Practice commands alone, per the task's explicit allowance not to invent unimplemented families.
    return {"protocol.hart.device.smar_fy301", HartReferenceCatalog::makeSmarFy301Profile().id, "FY301", "029EB1", "%",
            R"json([{"id":"PV","name":"Posicao Real","unit":"%","value":0.0,"role":"PV","type":"Float32",)json"
            R"json("direction":"Input","classification":91,"family":6,"writable":false,"lowerRangeValue":0.0,)json"
            R"json("upperRangeValue":100.0},{"id":"setpoint","name":"Setpoint de Posicao","unit":"%","value":0.0,)json"
            R"json("role":"SV","type":"Float32","direction":"Output","classification":91,"family":6,"writable":true,)json"
            R"json("lowerRangeValue":0.0,"upperRangeValue":100.0}])json"};
}

PropertyValue HartCommunicationComponent::propertyValue(const std::string& id) const {
    if (id == "bus") return m_bus; if (id == "endpoint") return m_endpointName; if (id == "enabled") return m_enabled;
    if (id == "pollingAddress") return static_cast<double>(m_pollingAddress); if (id == "uniqueId") return m_uniqueId;
    if (id == "tag") return m_tag; if (id == "unit") return m_unit; if (id == "profileId") return m_profileId; if (id == "hartVariablesJson") return m_hartVariablesJson; if (id == "hartCommandsJson") return m_hartCommandsJson; if (id == "hartBurstJson") return m_hartBurstJson; if (id == "hartAdditionalJson") return m_hartAdditionalJson; if (id == "alarmSelectionCode") return static_cast<double>(m_alarmSelectionCode); if (id == "hartCommandsStatus") return m_hartCommandsStatus; if (id == "hartVariablesStatus") return m_hartVariablesStatus; if (id == "baudRate") return static_cast<double>(m_baudRate);
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
    else if (id == "hartBurstJson") { m_hartBurstJson = std::get<std::string>(v); rebuildConfiguredPlan(); }
    else if (id == "hartAdditionalJson") { m_hartAdditionalJson = std::get<std::string>(v); rebuildConfiguredPlan(); }
    else if (id == "alarmSelectionCode") { m_alarmSelectionCode = static_cast<uint8_t>(std::clamp(std::get<double>(v), 0.0, 255.0)); rebuildConfiguredPlan(); }
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
