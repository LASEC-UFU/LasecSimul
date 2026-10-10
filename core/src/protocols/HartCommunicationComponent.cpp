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
    if (s.rfind("BIT_ENUM", 0) == 0) return HartVariableType::BitEnum;
    if (s.rfind("ENUM", 0) == 0) return HartVariableType::Enum;
    if (s == "UInt8") return HartVariableType::UInt8;
    if (s == "UInt16") return HartVariableType::UInt16;
    if (s == "Int16") return HartVariableType::Int16;
    if (s == "PackedAscii") return HartVariableType::PackedAscii;
    if (s == "Bool") return HartVariableType::Bool;
    if (s == "Ascii") return HartVariableType::Ascii;
    return HartVariableType::Float32;
}
const char* typeName(HartVariableType type) {
    switch (type) {
        case HartVariableType::UInt8: return "UInt8";
        case HartVariableType::UInt16: return "UInt16";
        case HartVariableType::Int16: return "Int16";
        case HartVariableType::PackedAscii: return "PackedAscii";
        case HartVariableType::Bool: return "Bool";
        case HartVariableType::Enum: return "ENUM";
        case HartVariableType::BitEnum: return "BIT_ENUM";
        case HartVariableType::Ascii: return "Ascii";
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
      m_typeId(preset && preset->typeId ? preset->typeId : (mode == Mode::Serial ? "protocol.hart.internal" : "protocol.hart.udp")),
      m_scheduler(scheduler), m_engine(m_profiles),
      m_endpoint(m_engine, HartTransportConfig{mode == Mode::Serial ? HartTransportKind::Serial : HartTransportKind::Udp}) {
    m_fieldDevice = preset != nullptr;
    if (m_fieldDevice) {
        const auto supplied = p.pins<4>();
        static constexpr std::array<const char*, 4> ids{"sensor_plus", "sensor_minus", "loop_plus", "loop_minus"};
        for (size_t i = 0; i < m_pins.size(); ++i) {
            m_pins[i] = supplied[i];
            if (m_pins[i].id.empty()) m_pins[i].id = ids[i];
        }
    }
    m_bus = stringProperty(p, "bus", "hart-1");
    m_endpointName = stringProperty(p, "endpoint", mode == Mode::Serial ? "COM1" : "127.0.0.1");
    m_uniqueId = stringProperty(p, "uniqueId", preset ? preset->uniqueId : m_uniqueId);
    m_tag = stringProperty(p, "tag", preset ? preset->tag : m_tag);
    m_unit = stringProperty(p, "unit", preset ? preset->unit : m_unit);
    m_pollingAddress = static_cast<uint8_t>(std::clamp(numberProperty(p, "pollingAddress", 0), 0.0, 63.0));
    m_baudRate = static_cast<uint32_t>(std::max(1.0, numberProperty(p, "baudRate", 1200)));
    m_udpPort = static_cast<uint16_t>(std::clamp(numberProperty(p, "udpPort", 5094), 1.0, 65535.0));
    m_enabled = p.property("enabled", true);
    m_sensorFault = p.property("sensorFault", false);
    // Read on construction, not just on a later setPropertyValue: `addComponent`
    // passes the FULL saved properties map here (including on project reopen,
    // per `registry::ComponentParams`'s own doc comment) -- without this, a
    // saved device's variables/commands were silently dropped and replaced by
    // an empty "[]" on every reopen (Gate 12/section 38 persistence contract).
    // A DevicePreset's `hartVariablesJson` is the fallback when `p` carries none (a fresh SMAR
    // device instance, or a test constructing directly with an empty ComponentParams) -- the
    // preset's Signal Graph ports/Device Variable roles apply out of the box, never an empty "[]".
    m_hartVariablesJson = stringProperty(p, "hartVariablesJson", preset ? preset->hartVariablesJson : "[]");
    ++m_hartVariablesRevision;
    m_hartCommandsJson = stringProperty(p, "hartCommandsJson", "[]");
    m_hartBurstJson = stringProperty(p, "hartBurstJson", "[]");
    m_hartAdditionalJson = stringProperty(p, "hartAdditionalJson", "{}");
    // Concrete devices ship per-instance defaults as data; the generic
    // fallbacks below apply to everything else.
    nlohmann::json presetDefaults = nlohmann::json::object();
    if (preset) {
        try { presetDefaults = nlohmann::json::parse(preset->propertyDefaultsJson.empty() ? "{}" : preset->propertyDefaultsJson); }
        catch (...) { presetDefaults = nlohmann::json::object(); }
        if (!presetDefaults.is_object()) presetDefaults = nlohmann::json::object();
    }
    const auto defaultText = [&](const char* name, std::string fallback) {
        return presetDefaults.contains(name) && presetDefaults[name].is_string() ? presetDefaults[name].get<std::string>() : fallback;
    };
    const auto defaultNumber = [&](const char* name, double fallback) {
        return presetDefaults.contains(name) && presetDefaults[name].is_number() ? presetDefaults[name].get<double>() : fallback;
    };
    m_alarmSelectionCode = static_cast<uint8_t>(std::clamp(numberProperty(p, "alarmSelectionCode", defaultNumber("alarmSelectionCode", 0xFB)), 0.0, 255.0));
    m_writeProtectCode = static_cast<uint8_t>(std::clamp(numberProperty(p, "writeProtectCode", defaultNumber("writeProtectCode", 0xFB)), 0.0, 255.0));
    m_configurationChangedFlags = static_cast<uint8_t>(std::clamp(numberProperty(p, "configurationChangedFlags", defaultNumber("configurationChangedFlags", 0)), 0.0, 3.0));
    m_configChangeCounter = static_cast<uint32_t>(std::clamp(numberProperty(p, "hartConfigChangeCounter", defaultNumber("hartConfigChangeCounter", 0)), 0.0, 65535.0));
    // Universal Command 12/13/16/20/6 identity fields (Anexo F.6): read on
    // construction for the exact same reopen reason as variables/commands
    // above -- without this, a HART write command's effect from a PRIOR
    // session would be silently dropped back to defaults on every reopen.
    m_message = stringProperty(p, "message", defaultText("message", ""));
    m_descriptor = stringProperty(p, "descriptor", defaultText("descriptor", ""));
    m_longTag = stringProperty(p, "longTag", "");
    m_date[0] = static_cast<uint8_t>(std::clamp(numberProperty(p, "dateDay", defaultNumber("dateDay", 0)), 0.0, 31.0));
    m_date[1] = static_cast<uint8_t>(std::clamp(numberProperty(p, "dateMonth", defaultNumber("dateMonth", 0)), 0.0, 12.0));
    m_date[2] = static_cast<uint8_t>(std::clamp(numberProperty(p, "dateYear", defaultNumber("dateYear", 0)), 0.0, 255.0));
    m_finalAssemblyNumber = static_cast<uint32_t>(std::clamp(numberProperty(p, "finalAssemblyNumber", defaultNumber("finalAssemblyNumber", 0)), 0.0, 16777215.0));
    m_loopCurrentModeEnabled = p.property("loopCurrentMode", true);
    m_analogInput = stringProperty(p, "analogLoopDirection", defaultText("analogLoopDirection", "output")) == "input";
    m_inputResistance = std::clamp(numberProperty(p, "analogInputResistance", defaultNumber("analogInputResistance", 550.0)), 1.0, 1e6);
    m_inputMinimumMilliamps = std::clamp(numberProperty(p, "analogInputMinimumMilliamps", defaultNumber("analogInputMinimumMilliamps", 3.8)), 0.0, 24.0);
    m_inputCurrentVariable = stringProperty(p, "analogInputVariable", defaultText("analogInputVariable", "inputCurrent"));
    if (m_analogInput) m_loopCurrent = 0.0;
    m_sensorLowVolts = numberProperty(p, "sensorLowVolts", defaultNumber("sensorLowVolts", 0.0));
    m_sensorHighVolts = std::max(m_sensorLowVolts + 1e-9, numberProperty(p, "sensorHighVolts", defaultNumber("sensorHighVolts", 5.0)));
    m_displayInstalled = p.property("displayInstalled", presetDefaults.value("displayInstalled", true));
    m_displayVariable1 = stringProperty(p, "displayVariable1", defaultText("displayVariable1", "pv"));
    m_displayVariable2 = stringProperty(p, "displayVariable2", defaultText("displayVariable2", ""));
    m_displayCodeMap = stringProperty(p, "displayCodeMap", defaultText("displayCodeMap", ""));
    m_displayGlass = numberProperty(p, "displayGlass", defaultNumber("displayGlass", 0));
    m_displayModelName = stringProperty(p, "displayModelName", defaultText("displayModelName", "HART"));
    m_powerOnNs = m_scheduler.nowNs();
    const double nan = std::numeric_limits<double>::quiet_NaN();
    m_sensorLowValue = numberProperty(p, "sensorLowValue", defaultNumber("sensorLowValue", nan));
    m_sensorHighValue = numberProperty(p, "sensorHighValue", defaultNumber("sensorHighValue", nan));

    HartReferenceCatalog::registerProfiles(m_profiles);
    m_profileId = stringProperty(p, "profileId", preset ? preset->profileId : m_profileId);
    resolveProfileTraits(p, preset ? preset->propertyDefaultsJson : std::string("{}"));
    rebuildConfiguredPlan(); // builds the device from every property above (including
                             // variables/commands) and installs the command hook.
    // A device without an explicit signal scale maps the injected signal onto
    // the PV range it was created with -- frozen here, never re-read later.
    if (const HartDevicePlan* plan = m_engine.findDevicePlan(m_deviceId); plan && (!std::isfinite(m_sensorLowValue) || !std::isfinite(m_sensorHighValue))) {
        const auto pv = std::find_if(plan->variables.begin(), plan->variables.end(), [](const auto& v) { return v.id == "PV"; });
        const double low = pv != plan->variables.end() && std::isfinite(pv->lowerRangeValue) ? pv->lowerRangeValue : 0.0;
        const double high = pv != plan->variables.end() && std::isfinite(pv->upperRangeValue) ? pv->upperRangeValue : low + 1.0;
        if (!std::isfinite(m_sensorLowValue)) m_sensorLowValue = low;
        if (!std::isfinite(m_sensorHighValue)) m_sensorHighValue = high;
    }
    HartTransportConfig config;
    config.kind = mode == Mode::Serial ? HartTransportKind::Serial : HartTransportKind::Udp;
    config.bus = m_bus; config.endpoint = m_endpointName; config.baudRate = m_baudRate; config.udpPort = m_udpPort;
    m_endpoint.configure(std::move(config));
}

void HartCommunicationComponent::resolveProfileTraits(const registry::ComponentParams& p, const std::string& defaultsJson) {
    nlohmann::json defaults = nlohmann::json::object();
    try { defaults = nlohmann::json::parse(defaultsJson.empty() ? "{}" : defaultsJson); } catch (...) {}
    if (!defaults.is_object()) defaults = nlohmann::json::object();
    const HartDeviceProfile* base = m_profiles.find(m_profileId);
    if (!base) base = m_profiles.find("lasecsimul.hart.process-simul-compatible");
    const auto number = [&](const char* id, double fallback) {
        const double preset = defaults.contains(id) && defaults[id].is_number() ? defaults[id].get<double>() : fallback;
        return numberProperty(p, id, preset);
    };
    auto& t = m_traits;
    t.manufacturerId = number("hartManufacturerId", base ? base->manufacturerId : 0);
    t.deviceType = number("hartDeviceType", base ? base->deviceType : 0);
    t.requestPreambles = number("hartRequestPreambles", base ? base->identity.numRequestPreambles : 5);
    t.universalRevision = number("hartUniversalRevision", base ? base->identity.universalCommandRevision : 7);
    t.deviceRevision = number("hartDeviceRevision", base ? base->identity.transmitterSpecificRevision : 1);
    t.softwareRevision = number("hartSoftwareRevision", base ? base->identity.softwareRevision : 1);
    t.hardwareRevision = number("hartHardwareRevision", base ? base->identity.hardwareRevisionAndSignal : 0);
    t.flags = number("hartFlags", base ? base->identity.flags : 0);
    t.implementedRevision = number("hartImplementedRevision", base ? base->implementedUniversalRevision : 7);
    const auto percent = [](float value, double none) { return std::isfinite(value) ? static_cast<double>(value) : none; };
    t.saturationLowPercent = number("analogSaturationLowPercent", base ? percent(base->analogLowerSaturationPercent, -1000.0) : -1000.0);
    t.saturationHighPercent = number("analogSaturationHighPercent", base ? percent(base->analogUpperSaturationPercent, 1000.0) : 1000.0);
    t.commandSet = stringProperty(p, "hartCommandSet",
        defaults.contains("hartCommandSet") && defaults["hartCommandSet"].is_string() ? defaults["hartCommandSet"].get<std::string>() : "");
    const auto milliamps = [](float value) { return std::isfinite(value) ? static_cast<double>(value) : 0.0; };
    t.fixedLowMilliamps = number("analogFixedLowMilliamps", base ? milliamps(base->analogFixedLowMilliamps) : 0.0);
    t.fixedHighMilliamps = number("analogFixedHighMilliamps", base ? milliamps(base->analogFixedHighMilliamps) : 0.0);
    t.alarmLowMilliamps = number("analogAlarmLowMilliamps", base ? milliamps(base->analogAlarmLowMilliamps) : 0.0);
    t.alarmHighMilliamps = number("analogAlarmHighMilliamps", base ? milliamps(base->analogAlarmHighMilliamps) : 0.0);
    t.rangeTolerancePercent = number("rangeLimitTolerancePercent", base ? base->rangeLimitTolerancePercent : 0.0);
    t.minimumSpanAcceptPercent = number("minimumSpanAcceptPercent", base ? base->minimumSpanAcceptPercent : 100.0);
    t.operationCounters = stringProperty(p, "hartOperationCounters",
        defaults.contains("hartOperationCounters") && defaults["hartOperationCounters"].is_string()
            ? defaults["hartOperationCounters"].get<std::string>() : "");
    t.alarmHighCode = number("hartAlarmHighCode", base ? base->analogAlarmHighCode : 0);
    t.alarmLowCode = number("hartAlarmLowCode", base ? base->analogAlarmLowCode : 1);
    t.writeProtectActiveCode = number("hartWriteProtectActiveCode", 1);
    t.burnoutStatus = number("hartBurnoutStatus", base ? base->burnoutStatus : 0x04);
    t.coldStartKeptByCommand0 = p.property("hartColdStartKeptByCommand0",
        defaults.contains("hartColdStartKeptByCommand0") && defaults["hartColdStartKeptByCommand0"].is_boolean()
            ? defaults["hartColdStartKeptByCommand0"].get<bool>() : (base && base->coldStartKeptByCommand0));
    t.burnoutPercentFollowsOutput = p.property("hartBurnoutPercentFollowsOutput", base && base->burnoutPercentFollowsOutput);
    t.maxDeviceVariables = number("hartMaxDeviceVariables", base ? base->maximumDeviceVariables : 0);
    t.privateLabel = number("hartPrivateLabel", base ? base->privateLabelDistributor : 0);
    t.deviceProfile = number("hartDeviceProfile", base ? base->deviceProfile : 1);
    t.responseDataLimits = stringProperty(p, "hartResponseDataLimits",
        defaults.contains("hartResponseDataLimits") && defaults["hartResponseDataLimits"].is_string()
            ? defaults["hartResponseDataLimits"].get<std::string>() : "");
}

HartLcdPage HartCommunicationComponent::displayPage(const std::string& source, const HartDevicePlan& plan, double pv,
                                                    const HartAnalogOutput& analog) const {
    HartLcdPage page;
    std::string token = source;
    // `var:<id>`: the shown variable is selected by a device parameter (e.g.
    // the LD301 "Display 1st variable" code read by its Command 164),
    // translated by `displayCodeMap` ("3=percent,5=dv:5").
    if (token.rfind("var:", 0) == 0) {
        const auto selector = std::find_if(plan.variables.begin(), plan.variables.end(),
            [&](const auto& v) { return v.id == token.substr(4); });
        if (selector == plan.variables.end()) return page;
        const std::string code = std::to_string(static_cast<long long>(std::llround(
            m_engine.variableValue(m_deviceId, selector->id).value_or(selector->value))));
        token.clear();
        size_t at = 0;
        while (at < m_displayCodeMap.size()) {
            const size_t comma = std::min(m_displayCodeMap.find(',', at), m_displayCodeMap.size());
            const std::string entry = m_displayCodeMap.substr(at, comma - at);
            at = comma + 1;
            const size_t equals = entry.find('=');
            if (equals != std::string::npos && entry.substr(0, equals) == code) token = entry.substr(equals + 1);
        }
    }
    // "2=pv/1": at most 1 decimal on the numeric field for this page.
    int maxDecimals = 3;
    if (const size_t slash = token.rfind('/'); slash != std::string::npos) {
        maxDecimals = std::clamp(std::atoi(token.c_str() + slash + 1), 0, 3);
        token.erase(slash);
    }
    const auto primary = std::find_if(plan.variables.begin(), plan.variables.end(), [](const auto& v) { return v.id == "PV"; });
    if (token == "pv") {
        const HartDeviceProfile* profile = m_profiles.find(plan.profileId);
        const uint8_t unit = primary != plan.variables.end() && primary->deviceVariableUnit != 250
            ? primary->deviceVariableUnit : (profile ? profile->primaryVariableUnit : 250);
        uint32_t annunciators = HartLcdAnnunciator::ProcessVariable;
        const std::string label = hartLcdUnitLabel(unit, annunciators);
        page = {true, pv, label, annunciators};
    } else if (token == "percent") {
        page = {true, analog.percentOfRange, "", HartLcdAnnunciator::ProcessVariable | HartLcdAnnunciator::Percent};
    } else if (token == "current") {
        page = {true, analog.milliamps, "mA", 0};
    } else if (token == "output") {
        page = {true, analog.outputPercent, "OUT", HartLcdAnnunciator::Percent};
    } else if (token.rfind("value:", 0) == 0) {
        const std::string id = token.substr(6);
        const auto variable = std::find_if(plan.variables.begin(), plan.variables.end(),
            [&](const auto& v) { return v.id == id; });
        if (variable == plan.variables.end()) return page;
        page.valid = true;
        page.value = m_engine.variableValue(m_deviceId, id).value_or(variable->value);
        page.label = hartLcdUnitLabel(variable->deviceVariableUnit, page.annunciators);
    } else if (token.rfind("dv:", 0) == 0) {
        const long code = std::strtol(token.c_str() + 3, nullptr, 10);
        const auto variable = std::find_if(plan.variables.begin(), plan.variables.end(),
            [code](const auto& v) { return v.deviceVariableCode == code; });
        if (variable == plan.variables.end()) return page;
        double value = m_engine.variableValue(m_deviceId, variable->id).value_or(variable->value);
        if (variable->derivedSource == HartDerivedSource::LoopCurrent) value = analog.milliamps;
        else if (variable->derivedSource == HartDerivedSource::PercentRange)
            value = std::isfinite(variable->lowerRangeValue) && std::isfinite(variable->upperRangeValue)
                ? variable->lowerRangeValue + analog.percentOfRange / 100.0 * (variable->upperRangeValue - variable->lowerRangeValue)
                : analog.percentOfRange;
        page.valid = true;
        page.value = value;
        // A variable derived from the percent of range is the PV re-expressed (LD301 "Unidade do
        // Usuário"): the manual lights the PV icon whenever that PV is on the display.
        if (variable->derivedSource == HartDerivedSource::PercentRange) page.annunciators |= HartLcdAnnunciator::ProcessVariable;
        page.label = hartLcdUnitLabel(variable->deviceVariableUnit, page.annunciators);
    }
    page.maxDecimals = maxDecimals;
    return page;
}

HartLcdFrame HartCommunicationComponent::displayFrame(std::optional<uint64_t> elapsedNs) const {
    HartLcdInput input;
    const HartDevicePlan* plan = m_engine.findDevicePlan(m_deviceId);
    if (!plan) return {};
    const HartDeviceProfile* profile = m_profiles.find(plan->profileId);
    const auto primary = std::find_if(plan->variables.begin(), plan->variables.end(), [](const auto& v) { return v.id == "PV"; });
    const double pv = m_engine.variableValue(m_deviceId, "PV").value_or(plan->primaryValue) + plan->primaryVariableZeroOffset;
    const float lower = primary != plan->variables.end() && std::isfinite(primary->lowerRangeValue)
        ? primary->lowerRangeValue : (profile ? profile->lowerRangeValue : 0.0f);
    const float upper = primary != plan->variables.end() && std::isfinite(primary->upperRangeValue)
        ? primary->upperRangeValue : (profile ? profile->upperRangeValue : 100.0f);
    const float lowSat = profile ? profile->analogLowerSaturationPercent : std::numeric_limits<float>::quiet_NaN();
    const float highSat = profile ? profile->analogUpperSaturationPercent : std::numeric_limits<float>::quiet_NaN();
    const HartAnalogOutput driven = hartEvaluateAnalogOutput(pv, lower, upper, lowSat, highSat, plan->fixedCurrentMode,
        plan->fixedCurrentMilliamps, plan->loopCurrentZeroTrim, plan->loopCurrentGainTrim, plan->loopCurrentMode,
        profile ? hartAlarmMilliamps(*profile, *plan) : std::numeric_limits<float>::quiet_NaN(), hartTransferSettings(*plan));
    const HartAnalogOutput measured = hartEvaluateAnalogOutput(pv, lower, upper, lowSat, highSat, false, 0.0f, 0.0f, 1.0f,
        plan->loopCurrentMode, std::numeric_limits<float>::quiet_NaN(), hartTransferSettings(*plan));
    input.installed = m_fieldDevice && m_displayInstalled;
    input.powered = m_enabled;
    const uint64_t now = m_scheduler.nowNs();
    input.elapsedNs = elapsedNs ? *elapsedNs : (now > m_powerOnNs ? now - m_powerOnNs : 0);
    input.modelName = m_displayModelName;
    input.universalRevision = profile ? profile->identity.universalCommandRevision : 7;
    input.softwareRevision = profile ? profile->identity.softwareRevision : 1;
    input.pollingAddress = plan->pollingAddress;
    input.malfunction = (plan->diagnosticStatus & HartDeviceStatusBits::DeviceMalfunction) != 0;
    input.sensorFault = plan->sensorFault;
    input.outputSaturated = measured.saturated && !plan->fixedCurrentMode;
    input.fixedCurrent = plan->fixedCurrentMode;
    input.multidrop = plan->loopCurrentMode == 0;
    input.transferFunctionCode = plan->pvTransferFunctionCode;
    input.glass = static_cast<uint8_t>(std::clamp(m_displayGlass, 0.0, 1.0));
    HartAnalogOutput shown = driven;
    if (profile && profile->burnoutPercentFollowsOutput && std::isfinite(hartAlarmMilliamps(*profile, *plan)) &&
        !plan->fixedCurrentMode && plan->loopCurrentMode != 0)
        shown.percentOfRange = shown.outputPercent;
    input.first = displayPage(m_displayVariable1, *plan, pv, shown);
    input.second = displayPage(m_displayVariable2, *plan, pv, shown);
    return hartLcdCompose(input);
}

size_t HartCommunicationComponent::getTelemetryState(uint8_t* out, size_t cap) const {
    if (!m_fieldDevice) return getState(out, cap);
    constexpr size_t total = 8 + 4 + kHartLcdPayloadBytes;
    if (cap < total) return 0;
    // Live analog output (fixed mode, saturation, trims), also when the
    // loop terminals are not part of an electrical circuit.
    const HartDevicePlan* plan = m_engine.findDevicePlan(m_deviceId);
    double milliamps = m_loopCurrent * 1000.0;
    if (plan && !m_analogInput) {
        const HartDeviceProfile* profile = m_profiles.find(plan->profileId);
        const auto primary = std::find_if(plan->variables.begin(), plan->variables.end(), [](const auto& v) { return v.id == "PV"; });
        const double pv = m_engine.variableValue(m_deviceId, "PV").value_or(plan->primaryValue) + plan->primaryVariableZeroOffset;
        const float lower = primary != plan->variables.end() && std::isfinite(primary->lowerRangeValue) ? primary->lowerRangeValue : 0.0f;
        const float upper = primary != plan->variables.end() && std::isfinite(primary->upperRangeValue) ? primary->upperRangeValue : 100.0f;
        milliamps = hartEvaluateAnalogOutput(pv, lower, upper,
            profile ? profile->analogLowerSaturationPercent : std::numeric_limits<float>::quiet_NaN(),
            profile ? profile->analogUpperSaturationPercent : std::numeric_limits<float>::quiet_NaN(),
            plan->fixedCurrentMode, plan->fixedCurrentMilliamps, plan->loopCurrentZeroTrim, plan->loopCurrentGainTrim,
            plan->loopCurrentMode, profile ? hartAlarmMilliamps(*profile, *plan) : std::numeric_limits<float>::quiet_NaN(),
            hartTransferSettings(*plan)).milliamps;
    }
    std::memcpy(out, &milliamps, sizeof milliamps);
    const uint32_t marker = 0x4C434431u; // "LCD1"
    for (int i = 0; i < 4; ++i) out[8 + i] = static_cast<uint8_t>(marker >> (8 * i));
    hartLcdSerialize(inputPowered() ? displayFrame() : HartLcdFrame{}, out + 12);
    return total;
}

void HartCommunicationComponent::stamp(MnaMatrixView& matrix) {
    if (!m_fieldDevice) return;
    const HartDevicePlan* plan = m_engine.findDevicePlan(m_deviceId);
    if (!plan) return;
    const auto pv = std::find_if(plan->variables.begin(), plan->variables.end(), [](const auto& v) { return v.id == "PV"; });
    if (pv == plan->variables.end()) return;
    // Signal terminals (sensor_plus/sensor_minus): when both are wired, the
    // injected differential signal IS the process value, linearly scaled and
    // not clamped (beyond the sensor limits the device reports PV out of
    // limits, below/above the range it saturates). Unwired, the PV comes from
    // the Signal Graph input instead.
    if (m_pinConnected[0] && m_pinConnected[1]) {
        const double volts = matrix.getNodeVoltage(m_pins[0]) - matrix.getNodeVoltage(m_pins[1]);
        const double value = m_sensorLowValue + (volts - m_sensorLowVolts) / (m_sensorHighVolts - m_sensorLowVolts) *
            (m_sensorHighValue - m_sensorLowValue);
        feedPrimary(value);
    }
    if (m_analogInput) {
        stampCurrentInput(matrix);
        return;
    }
    const double processValue = m_engine.variableValue(m_deviceId, "PV").value_or(0.0);
    const double low = std::isfinite(pv->lowerRangeValue) ? pv->lowerRangeValue : 0.0;
    const double high = std::isfinite(pv->upperRangeValue) ? pv->upperRangeValue : low + 1.0;
    // Loop terminals: a two-wire transmitter sinks the loop current from
    // loop_plus to loop_minus. It is the device's own analog output, so
    // fixed-current mode (loop test), saturation, trims and multidrop apply.
    const HartDeviceProfile* profile = m_profiles.find(plan->profileId);
    const HartAnalogOutput analog = hartEvaluateAnalogOutput(
        processValue + plan->primaryVariableZeroOffset, static_cast<float>(low), static_cast<float>(high),
        profile ? profile->analogLowerSaturationPercent : std::numeric_limits<float>::quiet_NaN(),
        profile ? profile->analogUpperSaturationPercent : std::numeric_limits<float>::quiet_NaN(),
        plan->fixedCurrentMode, plan->fixedCurrentMilliamps, plan->loopCurrentZeroTrim, plan->loopCurrentGainTrim,
        plan->loopCurrentMode, profile ? hartAlarmMilliamps(*profile, *plan) : std::numeric_limits<float>::quiet_NaN(),
        hartTransferSettings(*plan));
    m_loopCurrent = analog.milliamps / 1000.0;
    if (!m_enabled || !m_pinConnected[2] || !m_pinConnected[3]) return;
    // HART on the loop: the reply carrier rides on the DC current (±0.5 mA,
    // zero mean, so the 4-20 mA value is unchanged)...
    const uint64_t now = m_scheduler.nowNsUnlocked();
    m_wireTx.advance(now);
    const double carrier = hart_phy::kSlaveCurrentAmplitudeA * m_wireTx.value(now);
    matrix.addCurrent(m_pins[2], m_pins[3], m_loopCurrent + carrier);
    // ...and the master's carrier is the AC voltage across the terminals.
    if (m_wireRx.muted()) return;
    receiveOnWire(now, matrix.getNodeVoltage(m_pins[2]) - matrix.getNodeVoltage(m_pins[3]));
}

void HartCommunicationComponent::stampCurrentInput(MnaMatrixView& matrix) {
    if (!m_pinConnected[2] || !m_pinConnected[3]) {
        m_inputRawAmps = 0.0;
        return;
    }
    // Load of `analogInputResistance` with the reply carrier in series (Norton form):
    // i(L+ -> L-) = (V(L+) - V(L-) - v_tx) / R. Fed by a current source, the carrier shows up as a
    // voltage across the terminals; the master (in parallel on the line) hears it.
    const uint64_t now = m_scheduler.nowNsUnlocked();
    m_wireTx.advance(now);
    const double carrier = hart_phy::kSlaveVoltageAmplitudeV * m_wireTx.value(now);
    const double conductance = 1.0 / m_inputResistance;
    matrix.addConductance(m_pins[2], m_pins[3], conductance);
    if (carrier != 0.0) matrix.addCurrent(m_pins[3], m_pins[2], conductance * carrier);
    const double volts = matrix.getNodeVoltage(m_pins[2]) - matrix.getNodeVoltage(m_pins[3]);
    m_inputRawAmps = (volts - carrier) * conductance;
    if (!m_enabled || !inputPowered() || m_wireRx.muted()) return;
    receiveOnWire(now, volts);
}

void HartCommunicationComponent::publishInputCurrent() {
    const double milliamps = m_loopCurrent * 1000.0;
    if (std::fabs(milliamps - m_publishedInputMilliamps) < 1e-6) return;
    m_publishedInputMilliamps = milliamps;
    if (!m_inputCurrentVariable.empty()) m_engine.setMeasuredVariable(m_deviceId, m_inputCurrentVariable, milliamps);
}

void HartCommunicationComponent::receiveOnWire(uint64_t now, double volts) {
    m_wireRx.sample(now, volts);
    const std::vector<uint8_t> bytes = m_wireRx.takeBytes();
    if (bytes.empty()) return;
    for (auto& frame : m_wireFrames.push(bytes)) {
        const size_t preambles = static_cast<size_t>(std::find_if(frame.begin(), frame.end(), [](uint8_t b) { return b != 0xFF; }) - frame.begin());
        // Only master requests (STX); another slave's reply is not for us.
        if (preambles < frame.size() && (frame[preambles] & 0x07u) == 0x02u) m_wireRequests.push_back(std::move(frame));
    }
    if (m_wireRequests.empty() || m_wireProcessScheduled) return;
    m_wireProcessScheduled = true;
    m_wireRequestEndNs = now;
    std::weak_ptr<bool> alive = m_alive;
    m_scheduler.scheduleEventUnlocked(0, [this, alive] {
        if (alive.expired() || !*alive.lock()) return;
        m_scheduler.synchronized([this] { onWireRequests(); });
    });
}

namespace {
/** Slave turnaround: the reply starts after the master's carrier is gone and
 * at least one character time after the request ended. */
constexpr uint64_t kWireTurnaroundNs = hart_phy::kCharNs;
constexpr uint64_t kWireCheckNs = 1'000'000;
constexpr uint64_t kWireReplyTimeoutNs = 200'000'000;
} // namespace

void HartCommunicationComponent::onWireRequests() {
    m_wireProcessScheduled = false;
    std::vector<std::vector<uint8_t>> requests;
    requests.swap(m_wireRequests);
    for (const auto& request : requests) {
        ++m_wireFramesReceived;
        HartResponseBuilder response(300);
        if (!transact(request, response) || response.size() == 0) continue;
        m_wireReply.assign(response.bytes().begin(), response.bytes().end());
    }
    if (m_wireReply.empty() || m_wireReplyWaiting) return;
    m_wireReplyWaiting = true;
    std::weak_ptr<bool> alive = m_alive;
    m_scheduler.scheduleEventUnlocked(kWireCheckNs, [this, alive] {
        if (alive.expired() || !*alive.lock()) return;
        m_scheduler.synchronized([this] { onWireReplyCheck(); });
    });
}

void HartCommunicationComponent::onWireReplyCheck() {
    const uint64_t now = m_scheduler.nowNsUnlocked();
    const bool lineBusy = m_wireRx.carrierAt(now);
    if (now >= m_wireRequestEndNs + kWireReplyTimeoutNs) {
        // The master never released the line: the reply is dropped.
        m_wireReply.clear();
        m_wireReplyWaiting = false;
        return;
    }
    if (lineBusy || now < m_wireRequestEndNs + kWireTurnaroundNs) {
        std::weak_ptr<bool> alive = m_alive;
        m_scheduler.scheduleEventUnlocked(kWireCheckNs, [this, alive] {
            if (alive.expired() || !*alive.lock()) return;
            m_scheduler.synchronized([this] { onWireReplyCheck(); });
        });
        return;
    }
    m_wireReplyWaiting = false;
    m_wireTx.send(m_wireReply, now);
    m_wireReply.clear();
    ++m_wireRepliesSent;
    m_wireRx.setMuted(true); // half duplex
    m_wireFrames.reset();
    if (m_wireSampling) return;
    m_wireSampling = true;
    onWireCarrierSample();
}

void HartCommunicationComponent::onWireCarrierSample() {
    const uint64_t now = m_scheduler.nowNsUnlocked();
    m_wireTx.advance(now);
    m_scheduler.dirtySet().insert(m_componentIndex);
    if (!m_wireTx.active()) {
        m_wireSampling = false;
        m_wireRx.setMuted(false);
        return;
    }
    std::weak_ptr<bool> alive = m_alive;
    m_scheduler.scheduleEventUnlocked(hart_phy::kSampleNs, [this, alive] {
        if (alive.expired() || !*alive.lock()) return;
        m_scheduler.synchronized([this] { onWireCarrierSample(); });
    });
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
    // HART 5: a polling address 1..15 means multidrop (loop current parked
    // at 4 mA). HART 6/7 keep address and loop current mode independent
    // (Command 6 byte 1 / property loopCurrentMode).
    if (m_traits.implementedRevision < 6 && m_pollingAddress != 0) device.loopCurrentMode = 0;
    device.alarmSelectionCode = m_alarmSelectionCode;
    device.writeProtectCode = m_writeProtectCode;
    device.writeProtectActiveCode = static_cast<uint16_t>(std::clamp(m_traits.writeProtectActiveCode, 0.0, 256.0));
    device.configurationChangedCounter = m_configChangeCounter;
    device.configurationChangedMasters = m_configurationChangedFlags;
    device.sensorFault = m_sensorFault || m_signalSensorFault;
    if (m_configurationChangedFlags != 0) device.diagnosticStatus = static_cast<uint8_t>(device.diagnosticStatus | 0x40u);
    const HartDeviceProfile* base = m_profiles.find(device.profileId);
    if (!base) { m_profileId = "lasecsimul.hart.process-simul-compatible"; device.profileId = m_profileId; base = m_profiles.find(device.profileId); }
    // This transmitter's own profile: the registered one reshaped by the
    // instance traits. Nothing device-model specific lives in code -- a model
    // (e.g. the LD301 template) is just a set of property values.
    HartDeviceProfile instance = *base;
    instance.id = base->id + "@" + device.id;
    const auto byte = [](double value) { return static_cast<uint8_t>(std::clamp(value, 0.0, 255.0)); };
    instance.manufacturerId = byte(m_traits.manufacturerId);
    instance.deviceType = byte(m_traits.deviceType);
    instance.identity = {byte(m_traits.requestPreambles), byte(m_traits.universalRevision), byte(m_traits.deviceRevision),
                         byte(m_traits.softwareRevision), byte(m_traits.hardwareRevision), byte(m_traits.flags)};
    instance.implementedUniversalRevision = byte(m_traits.implementedRevision);
    const auto saturation = [](double percent) {
        return std::fabs(percent) >= 1000.0 ? std::numeric_limits<float>::quiet_NaN() : static_cast<float>(percent);
    };
    instance.analogLowerSaturationPercent = saturation(m_traits.saturationLowPercent);
    instance.analogUpperSaturationPercent = saturation(m_traits.saturationHighPercent);
    const auto current = [](double milliamps) {
        return milliamps > 0.0 ? static_cast<float>(milliamps) : std::numeric_limits<float>::quiet_NaN();
    };
    instance.analogFixedLowMilliamps = current(m_traits.fixedLowMilliamps);
    instance.analogFixedHighMilliamps = current(m_traits.fixedHighMilliamps);
    instance.analogAlarmLowMilliamps = current(m_traits.alarmLowMilliamps);
    instance.analogAlarmHighMilliamps = current(m_traits.alarmHighMilliamps);
    instance.rangeLimitTolerancePercent = static_cast<float>(std::clamp(m_traits.rangeTolerancePercent, 0.0, 1000.0));
    instance.minimumSpanAcceptPercent = static_cast<float>(std::clamp(m_traits.minimumSpanAcceptPercent, 0.0, 100.0));
    instance.analogAlarmHighCode = byte(m_traits.alarmHighCode);
    instance.analogAlarmLowCode = byte(m_traits.alarmLowCode);
    instance.burnoutStatus = byte(m_traits.burnoutStatus);
    instance.coldStartKeptByCommand0 = m_traits.coldStartKeptByCommand0;
    instance.burnoutPercentFollowsOutput = m_traits.burnoutPercentFollowsOutput;
    instance.maximumDeviceVariables = byte(m_traits.maxDeviceVariables);
    instance.privateLabelDistributor = static_cast<uint16_t>(std::clamp(m_traits.privateLabel, 0.0, 65535.0));
    instance.deviceProfile = byte(m_traits.deviceProfile);
    // "15=17;9=20": a response data length cap per command.
    instance.responseDataLimits.clear();
    for (size_t at = 0; at < m_traits.responseDataLimits.size();) {
        const size_t semicolon = std::min(m_traits.responseDataLimits.find(';', at), m_traits.responseDataLimits.size());
        const std::string entry = m_traits.responseDataLimits.substr(at, semicolon - at);
        at = semicolon + 1;
        const size_t equals = entry.find('=');
        if (equals == std::string::npos) continue;
        try {
            instance.responseDataLimits.push_back({static_cast<HartCommandId>(std::stoul(entry.substr(0, equals))),
                                                   static_cast<uint8_t>(std::min(255ul, std::stoul(entry.substr(equals + 1))))});
        } catch (...) {}
    }
    // "43=counter.zero;35,36,37=counter.range": which command's
    // configuration change increments which UInt8 variable.
    instance.operationCounters.clear();
    for (size_t at = 0; at < m_traits.operationCounters.size();) {
        const size_t semicolon = std::min(m_traits.operationCounters.find(';', at), m_traits.operationCounters.size());
        const std::string entry = m_traits.operationCounters.substr(at, semicolon - at);
        at = semicolon + 1;
        const size_t equals = entry.find('=');
        if (equals == std::string::npos) continue;
        const std::string variableId = entry.substr(equals + 1);
        for (size_t from = 0; from < equals;) {
            const size_t comma = std::min(entry.find(',', from), equals);
            try { instance.operationCounters.push_back({static_cast<HartCommandId>(std::stoul(entry.substr(from, comma - from))), variableId}); }
            catch (...) {}
            from = comma + 1;
        }
    }
    if (!m_traits.commandSet.empty()) {
        // "0-3,6,11-19,33-46": the standard commands this transmitter
        // implements; anything else answers Response Code 64.
        const auto names = HartReferenceCatalog::commandDescriptors();
        instance.commands.clear();
        size_t at = 0;
        while (at < m_traits.commandSet.size()) {
            const size_t comma = std::min(m_traits.commandSet.find(',', at), m_traits.commandSet.size());
            const std::string item = m_traits.commandSet.substr(at, comma - at);
            at = comma + 1;
            try {
                const size_t dash = item.find('-');
                const long first = std::stol(item.substr(0, dash));
                const long last = dash == std::string::npos ? first : std::stol(item.substr(dash + 1));
                for (long id = std::max(0L, first); id <= std::min(65535L, last); ++id) {
                    const auto named = std::find_if(names.begin(), names.end(), [id](const auto& d) { return d.id == id; });
                    instance.commands.push_back({static_cast<HartCommandId>(id),
                                                 named != names.end() ? named->name : "Command " + std::to_string(id)});
                }
            } catch (...) { m_hartVariablesStatus = "ERROR: invalid HART command set \"" + item + "\""; return; }
        }
    }
    m_profiles.registerOrReplace(std::move(instance));
    device.profileId = base->id + "@" + device.id;
    const HartDeviceProfile* profile = m_profiles.find(device.profileId);
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
        if (parsed.size() > 160) { m_hartVariablesStatus = "ERROR: too many variables declared (max 160)"; return; }
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
            const std::string variableType = item.value("type", std::string{});
            // HCF_SPEC-183: Expanded Device Type (1), Join Process Status
            // flags (52), and Change Notification flags (60) are 16-bit.
            // The UI stores table identity in the type string, not a parallel
            // per-command shadow field.
            variable.wireWidth = variableType == "ENUM01" || variableType == "BIT_ENUM52" || variableType == "BIT_ENUM60" ? 2 : 1;
            if (variable.type == HartVariableType::Ascii) {
                variable.wireWidth = static_cast<uint8_t>(std::clamp(item.value("width", 32), 1, 255));
                variable.textValue = item.value("text", std::string{});
                if (variable.textValue.size() > variable.wireWidth) variable.textValue.resize(variable.wireWidth);
            }
            variable.derivedSource = static_cast<uint8_t>(std::clamp(item.value("derivedSource", 255), 0, 255));
            variable.runtimeMutable = item.value("runtimeMutable", false);
            variable.transferParameter = static_cast<uint8_t>(std::clamp(item.value("transferParameter", 0), 0, 2));
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

namespace {
/** A HART variable's engineering unit as a Signal Graph unit. The Signal
 * Graph has a closed unit vocabulary (SignalEngine.cpp `unitInfo`); a HART
 * unit outside it (mmH2O@20C, mm, %, ...) is carried as dimensionless so the
 * plan still compiles -- the HART unit itself stays in the device. */
std::string signalUnitFor(const std::string& hartUnit) {
    if (hartUnit == "C" || hartUnit == "degC" || hartUnit == "\xC2\xB0" "C") return "degC";
    static const char* const known[] = {"V", "mV", "kV", "A", "mA", "s", "ms", "us", "Hz", "kHz", "Pa", "kPa", "K"};
    for (const char* unit : known)
        if (hartUnit == unit) return hartUnit;
    return std::string();
}
} // namespace

std::vector<SignalPortDescriptor> HartCommunicationComponent::signalPorts() const {
    return cachedSignalPorts();
}

const std::vector<SignalPortDescriptor>& HartCommunicationComponent::cachedSignalPorts() const {
    // Called on every stable step (HART <-> Signal Graph): parse the
    // variables JSON only when it changed.
    if (m_signalPortsRevision != m_hartVariablesRevision) {
        m_signalPortsCache = parseSignalPorts();
        m_signalPortsRevision = m_hartVariablesRevision;
    }
    return m_signalPortsCache;
}

std::vector<SignalPortDescriptor> HartCommunicationComponent::parseSignalPorts() const {
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
                             kind, signalUnitFor(item.value("unit", std::string{}))});
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
    m_writeProtectCode = plan->writeProtectCode;
    m_configChangeCounter = plan->configurationChangedCounter & 0xFFFFu;
    // HART-5 rules make the per-master Configuration Changed bits
    // non-volatile: they survive save/reopen like any other device state.
    m_configurationChangedFlags = plan->configurationChangedMasters;
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
                if (it->type == HartVariableType::Ascii) item["text"] = it->textValue;
                if (it->runtimeMutable) item["runtimeMutable"] = true;
                item["deviceVariableUnit"] = it->deviceVariableUnit;
                item["dampingValue"] = it->dampingValue;
                if (it->rangeUnitCode != 0xFF) item["rangeUnitCode"] = it->rangeUnitCode;
                if (std::isfinite(it->lowerRangeValue)) item["lowerRangeValue"] = it->lowerRangeValue;
                if (std::isfinite(it->upperRangeValue)) item["upperRangeValue"] = it->upperRangeValue;
                if (it->upperTransducerLimit > it->lowerTransducerLimit) {
                    item["upperTransducerLimit"] = it->upperTransducerLimit;
                    item["lowerTransducerLimit"] = it->lowerTransducerLimit;
                    item["minimumSpan"] = it->minimumSpan;
                }
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
            // Runs after every transaction, reads included: keep the port cache unless something changed.
            std::string dumped = variables.dump();
            if (dumped != m_hartVariablesJson) {
                m_hartVariablesJson = std::move(dumped);
                ++m_hartVariablesRevision;
            }
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
    // A model's input stage reports a broken sensor through the `sensorFault` input variable: the
    // device goes to burnout exactly as with the `sensorFault` property.
    if (variableId == "sensorFault") {
        const bool fault = std::isfinite(value) && value > 0.5;
        if (fault == m_signalSensorFault) return true;
        m_signalSensorFault = fault;
        m_engine.setSensorFault(m_deviceId, m_sensorFault || m_signalSensorFault);
        m_scheduler.dirtySet().insert(m_componentIndex);
        return true;
    }
    if (m_fieldDevice && variableId == "PV" && std::isfinite(value)) {
        if (m_rawPrimary == value) return true;
        feedPrimary(value);
        // The loop current follows the PV: re-stamp (called outside stamp()).
        m_scheduler.dirtySet().insert(m_componentIndex);
        return true;
    }
    return m_engine.setVariableInput(m_deviceId, variableId, value);
}

double HartCommunicationComponent::primaryDampingSeconds() const {
    const HartDevicePlan* plan = m_engine.findDevicePlan(m_deviceId);
    if (!plan) return 0.0;
    const auto pv = std::find_if(plan->variables.begin(), plan->variables.end(), [](const auto& v) { return v.id == "PV"; });
    return pv != plan->variables.end() && std::isfinite(pv->dampingValue) ? std::max(0.0, static_cast<double>(pv->dampingValue)) : 0.0;
}

void HartCommunicationComponent::feedPrimary(double raw) {
    m_rawPrimary = raw;
    // Without damping (or before the first sample) the input is the PV at
    // once; otherwise postStep() moves the PV toward it.
    if (primaryDampingSeconds() <= 0.0 || !std::isfinite(m_dampedPrimary)) {
        m_dampedPrimary = raw;
        m_engine.setVariableInput(m_deviceId, "PV", raw);
    }
}

void HartCommunicationComponent::postStep(uint64_t deltaNs) {
    if (m_fieldDevice && m_analogInput) {
        // Input stage filter: the 4-20 mA setpoint without the HART carrier riding on it.
        const double alpha = 1.0 - std::exp(-static_cast<double>(deltaNs) * 1e-9 / kInputFilterSeconds);
        const double before = m_loopCurrent;
        m_loopCurrent += (m_inputRawAmps - m_loopCurrent) * alpha;
        publishInputCurrent();
        if (std::fabs(m_loopCurrent - before) > 1e-9) m_scheduler.dirtySet().insert(m_componentIndex);
    }
    if (!m_fieldDevice || !std::isfinite(m_rawPrimary) || !std::isfinite(m_dampedPrimary)) return;
    const double tau = primaryDampingSeconds();
    if (tau <= 0.0) m_dampedPrimary = m_rawPrimary;
    else m_dampedPrimary += (m_rawPrimary - m_dampedPrimary) * (1.0 - std::exp(-static_cast<double>(deltaNs) * 1e-9 / tau));
    const double before = m_engine.variableValue(m_deviceId, "PV").value_or(m_dampedPrimary);
    m_engine.setVariableInput(m_deviceId, "PV", m_dampedPrimary);
    if (before != m_dampedPrimary) m_scheduler.dirtySet().insert(m_componentIndex);
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
        {"enabled", "Habilitado", "Comunicacao", "", PropertyValueKind::Bool, "checkbox", true},
        numberSchema("pollingAddress", "Polling address", "HART", "", 0, 0, 63),
        textSchema("profileId", "Perfil de dispositivo", "HART", preset ? preset->profileId : "lasecsimul.hart.process-simul-compatible"),
        textSchema("uniqueId", "Unique ID", "HART", preset ? preset->uniqueId : "029EB1"),
        textSchema("tag", "Tag", "HART", preset ? preset->tag : "HART"),
        textSchema("unit", "Unidade PV", "HART", preset ? preset->unit : "V"),
        numberSchema("alarmSelectionCode", "PV alarm selection code", "HART", "", 251, 0, 255),
        numberSchema("writeProtectCode", "Write protect code (0 No, 1 Yes, 251 None)", "HART", "", 251, 0, 255),
        numberSchema("configurationChangedFlags", "Configuration Changed (bit0 primary, bit1 secondary master)", "HART", "", 0, 0, 3),
        // Perfil do transmissor (por instancia): identidade do Command 0,
        // revisao implementada, comandos suportados e saturacao da saida.
        numberSchema("hartManufacturerId", "Fabricante (Command 0)", "HART Perfil", "", 0x3E, 0, 255),
        numberSchema("hartDeviceType", "Tipo de dispositivo (Command 0)", "HART Perfil", "", 0, 0, 255),
        numberSchema("hartRequestPreambles", "Preambulos requeridos", "HART Perfil", "", 5, 2, 20),
        numberSchema("hartUniversalRevision", "Revisao universal (Command 0)", "HART Perfil", "", 7, 0, 255),
        numberSchema("hartDeviceRevision", "Revisao do dispositivo", "HART Perfil", "", 1, 0, 255),
        numberSchema("hartSoftwareRevision", "Revisao de software", "HART Perfil", "", 1, 0, 255),
        numberSchema("hartHardwareRevision", "Revisao de hardware + sinalizacao", "HART Perfil", "", 0, 0, 255),
        numberSchema("hartFlags", "Flags (Common Table 11)", "HART Perfil", "", 0, 0, 255),
        numberSchema("hartImplementedRevision", "Revisao HART dos layouts implementados", "HART Perfil", "", 7, 5, 7),
        textSchema("hartCommandSet", "Comandos padrao suportados (ex.: 0-3,6,11-19)", "HART Perfil", ""),
        numberSchema("analogSaturationLowPercent", "Saturacao inferior da saida", "HART Perfil", "%", -1000, -1000, 0),
        numberSchema("analogSaturationHighPercent", "Saturacao superior da saida", "HART Perfil", "%", 1000, 100, 1000),
        numberSchema("analogFixedLowMilliamps", "Corrente fixa minima (Cmd 40; 0 = saturacao)", "HART Perfil", "mA", 0, 0, 24),
        numberSchema("analogFixedHighMilliamps", "Corrente fixa maxima (Cmd 40; 0 = saturacao)", "HART Perfil", "mA", 0, 0, 24),
        numberSchema("analogAlarmLowMilliamps", "Corrente de falha baixa (burnout; 0 = nenhuma)", "HART Perfil", "mA", 0, 0, 24),
        numberSchema("analogAlarmHighMilliamps", "Corrente de falha alta (burnout; 0 = nenhuma)", "HART Perfil", "mA", 0, 0, 24),
        numberSchema("rangeLimitTolerancePercent", "Tolerancia da faixa alem dos limites (Cmd 35-37)", "HART Perfil", "%", 0, 0, 1000),
        numberSchema("minimumSpanAcceptPercent", "Span aceito com aviso (% do span minimo)", "HART Perfil", "%", 100, 0, 100),
        textSchema("hartOperationCounters", "Contadores de operacao (ex.: 43=counter.zero;35,36,37=counter.range)", "HART Perfil", ""),
        numberSchema("hartAlarmHighCode", "Codigo de alarme da corrente de falha alta (Cmd 15 byte 0)", "HART Perfil", "", 0, 0, 255),
        numberSchema("hartAlarmLowCode", "Codigo de alarme da corrente de falha baixa (Cmd 15 byte 0)", "HART Perfil", "", 1, 0, 255),
        {"hartColdStartKeptByCommand0", "Command 0 mantem o bit Cold Start", "HART Perfil", "", PropertyValueKind::Bool, "checkbox", false},
        {"hartBurnoutPercentFollowsOutput", "Em burnout o PV % acompanha a saida", "HART Perfil", "", PropertyValueKind::Bool, "checkbox", false},
        numberSchema("hartBurnoutStatus", "Bits de status durante o burnout (4 = saturada)", "HART Perfil", "", 4, 0, 255),
        numberSchema("hartWriteProtectActiveCode", "Codigo de protecao de escrita que bloqueia escritas (256 = nenhum)", "HART Perfil", "", 1, 0, 256),
        numberSchema("hartMaxDeviceVariables", "Maximo de variaveis de dispositivo (Command 0, HART 6/7)", "HART Perfil", "", 0, 0, 255),
        numberSchema("hartPrivateLabel", "Private Label Distributor (Command 0, HART 7)", "HART Perfil", "", 0, 0, 65535),
        numberSchema("hartDeviceProfile", "Device Profile (Command 0, HART 7)", "HART Perfil", "", 1, 0, 255),
        textSchema("hartResponseDataLimits", "Bytes de dados maximos por comando (ex.: 15=17)", "HART Perfil", ""),
        numberSchema("hartConfigChangeCounter", "Contador de mudancas de configuracao (Command 0, HART 6/7)", "HART", "", 0, 0, 65535),
        {"sensorFault", "Simular falha do sensor", "Sensor", "", PropertyValueKind::Bool, "checkbox", false},
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
    // A field device (Mode::Serial) has no serial port: HART reaches it only
    // as FSK on its loop terminals, through a HART modem in the circuit. The
    // UDP tap keeps its bus/address.
    if (mode == Mode::Udp) {
        out.insert(out.begin(), textSchema("endpoint", "Endereco UDP", "Comunicacao", "127.0.0.1"));
        out.insert(out.begin(), textSchema("bus", "Canal HART", "Comunicacao", "hart-1"));
        out.push_back(numberSchema("udpPort", "Porta UDP", "UDP", "", 5094, 1, 65535));
        // UDP is a transport tap, never a second shadow transmitter. The
        // Extension renders this as a selector of the field device/loop.
        out.push_back(textSchema("hart_device_id", "Laço HART", "HART", ""));
    }
    if (preset) {
        // Terminais de sinal: tensao injetada <-> valor de processo (escala
        // fisica fixa, independente do LRV/URV configuravel via HART).
        out.push_back(numberSchema("sensorLowVolts", "Sinal de entrada: tensao A", "Sensor", "V", 0.0, -1000, 1000));
        out.push_back(numberSchema("sensorHighVolts", "Sinal de entrada: tensao B", "Sensor", "V", 5.0, -1000, 1000));
        out.push_back(numberSchema("sensorLowValue", "Processo na tensao A", "Sensor", preset->unit, 0.0, -1e9, 1e9));
        out.push_back(numberSchema("sensorHighValue", "Processo na tensao B", "Sensor", preset->unit, 0.0, -1e9, 1e9));
        out.push_back(readonlySchema("loopCurrentMilliamps", "Corrente de loop (4-20 mA)", "Sensor", "4"));
        // Laço: transmissor (saída 4-20 mA) ou atuador alimentado pelo laço (entrada 4-20 mA).
        PropertySchema direction{"analogLoopDirection", "Laço 4-20 mA", "Laço", "", PropertyValueKind::String, "select", std::string("output")};
        direction.options = {{"output", "Saída (transmissor)"}, {"input", "Entrada (atuador / posicionador)"}};
        out.push_back(direction);
        out.push_back(numberSchema("analogInputResistance", "Impedância de entrada (entrada 4-20 mA)", "Laço", "Ω", 550, 1, 1e6));
        out.push_back(numberSchema("analogInputMinimumMilliamps", "Corrente mínima para funcionar (entrada 4-20 mA)", "Laço", "mA", 3.8, 0, 24));
        out.push_back(textSchema("analogInputVariable", "Variável HART que recebe a corrente medida (mA)", "Laço", "inputCurrent"));
        // Indicador local (LCD 4 1/2 digitos + 5 alfanumericos + anunciadores).
        out.push_back({"displayInstalled", "Indicador instalado", "Display", "", PropertyValueKind::Bool, "checkbox", true});
        out.push_back(textSchema("displayVariable1", "1a variavel (pv, percent, current, output, dv:N, var:id)", "Display", "pv"));
        out.push_back(textSchema("displayVariable2", "2a variavel (vazio = nenhuma)", "Display", ""));
        out.push_back(textSchema("displayCodeMap", "Mapa de codigos (ex.: 3=percent,5=dv:5,2=pv/1)", "Display", ""));
        out.push_back(numberSchema("displayGlass", "Vidro do display (0 LD301: raiz, SAT/SFAIL; 1 TT301: ACK, alarme AL_0)", "Display", "", 0, 0, 1));
        out.push_back(textSchema("displayModelName", "Nome no indicador ao ligar", "Display", "HART"));
    }
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

HartCommunicationComponent::DevicePreset HartCommunicationComponent::standardFieldDevicePreset() {
    // The standard HART field device: one PV measured from the Signal Graph
    // or the signal terminals, a 4-20 mA loop, and every HART trait open to
    // per-instance configuration. Concrete transmitters (subcircuits/hart_*)
    // are built by configuring an instance of it.
    return {"protocol.hart.device.standard", "lasecsimul.hart.standard-field-device", "HART", "000001", "%",
            R"json([{"id":"PV","name":"PV","unit":"%","value":0.0,"role":"PV","type":"Float32","direction":"Input",)json"
            R"json("deviceVariableCode":246,"deviceVariableUnit":57,"lowerRangeValue":0.0,"upperRangeValue":100.0}])json"};
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
    if (id == "hartAlarmHighCode") return m_traits.alarmHighCode; if (id == "hartAlarmLowCode") return m_traits.alarmLowCode;
    if (id == "hartWriteProtectActiveCode") return m_traits.writeProtectActiveCode; if (id == "hartBurnoutStatus") return m_traits.burnoutStatus;
    if (id == "hartColdStartKeptByCommand0") return m_traits.coldStartKeptByCommand0;
    if (id == "hartBurnoutPercentFollowsOutput") return m_traits.burnoutPercentFollowsOutput;
    if (id == "hartMaxDeviceVariables") return m_traits.maxDeviceVariables; if (id == "hartPrivateLabel") return m_traits.privateLabel;
    if (id == "hartDeviceProfile") return m_traits.deviceProfile; if (id == "hartResponseDataLimits") return m_traits.responseDataLimits;
    if (id == "hartConfigChangeCounter") return static_cast<double>(m_configChangeCounter);
    if (id == "displayGlass") return m_displayGlass;
    if (id == "analogLoopDirection") return std::string(m_analogInput ? "input" : "output");
    if (id == "analogInputResistance") return m_inputResistance;
    if (id == "analogInputMinimumMilliamps") return m_inputMinimumMilliamps;
    if (id == "analogInputVariable") return m_inputCurrentVariable;
    if (id == "bus") return m_bus; if (id == "endpoint") return m_endpointName; if (id == "enabled") return m_enabled;
    if (id == "pollingAddress") return static_cast<double>(m_pollingAddress); if (id == "uniqueId") return m_uniqueId;
    if (id == "tag") return m_tag; if (id == "unit") return m_unit; if (id == "profileId") return m_profileId; if (id == "hartVariablesJson") return m_hartVariablesJson; if (id == "hartCommandsJson") return m_hartCommandsJson; if (id == "hartBurstJson") return m_hartBurstJson; if (id == "hartAdditionalJson") return m_hartAdditionalJson; if (id == "alarmSelectionCode") return static_cast<double>(m_alarmSelectionCode); if (id == "writeProtectCode") return static_cast<double>(m_writeProtectCode); if (id == "hartManufacturerId") return m_traits.manufacturerId; if (id == "hartDeviceType") return m_traits.deviceType; if (id == "hartRequestPreambles") return m_traits.requestPreambles; if (id == "hartUniversalRevision") return m_traits.universalRevision; if (id == "hartDeviceRevision") return m_traits.deviceRevision; if (id == "hartSoftwareRevision") return m_traits.softwareRevision; if (id == "hartHardwareRevision") return m_traits.hardwareRevision; if (id == "hartFlags") return m_traits.flags; if (id == "hartImplementedRevision") return m_traits.implementedRevision; if (id == "analogSaturationLowPercent") return m_traits.saturationLowPercent; if (id == "analogSaturationHighPercent") return m_traits.saturationHighPercent; if (id == "hartCommandSet") return m_traits.commandSet; if (id == "analogFixedLowMilliamps") return m_traits.fixedLowMilliamps; if (id == "analogFixedHighMilliamps") return m_traits.fixedHighMilliamps; if (id == "analogAlarmLowMilliamps") return m_traits.alarmLowMilliamps; if (id == "analogAlarmHighMilliamps") return m_traits.alarmHighMilliamps; if (id == "rangeLimitTolerancePercent") return m_traits.rangeTolerancePercent; if (id == "minimumSpanAcceptPercent") return m_traits.minimumSpanAcceptPercent; if (id == "hartOperationCounters") return m_traits.operationCounters; if (id == "sensorFault") return m_sensorFault; if (id == "displayInstalled") return m_displayInstalled; if (id == "displayVariable1") return m_displayVariable1; if (id == "displayVariable2") return m_displayVariable2; if (id == "displayCodeMap") return m_displayCodeMap; if (id == "displayModelName") return m_displayModelName; if (id == "sensorLowVolts") return m_sensorLowVolts; if (id == "sensorHighVolts") return m_sensorHighVolts; if (id == "sensorLowValue") return m_sensorLowValue; if (id == "sensorHighValue") return m_sensorHighValue; if (id == "loopCurrentMilliamps") return std::to_string(m_loopCurrent * 1000.0); if (id == "configurationChangedFlags") return static_cast<double>(m_configurationChangedFlags); if (id == "hartCommandsStatus") return m_hartCommandsStatus; if (id == "hartVariablesStatus") return m_hartVariablesStatus; if (id == "baudRate") return static_cast<double>(m_baudRate);
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
    else if (id == "hartVariablesJson") { m_hartVariablesJson = std::get<std::string>(v); ++m_hartVariablesRevision; rebuildConfiguredPlan(); }
    else if (id == "hartCommandsJson") { m_hartCommandsJson = std::get<std::string>(v); rebuildCommandPrograms(); }
    else if (id == "hartBurstJson") { m_hartBurstJson = std::get<std::string>(v); rebuildConfiguredPlan(); }
    else if (id == "hartAdditionalJson") { m_hartAdditionalJson = std::get<std::string>(v); rebuildConfiguredPlan(); }
    else if (id == "alarmSelectionCode") { m_alarmSelectionCode = static_cast<uint8_t>(std::clamp(std::get<double>(v), 0.0, 255.0)); rebuildConfiguredPlan(); }
    else if (id == "hartManufacturerId") { m_traits.manufacturerId = std::get<double>(v); rebuildConfiguredPlan(); }
    else if (id == "hartDeviceType") { m_traits.deviceType = std::get<double>(v); rebuildConfiguredPlan(); }
    else if (id == "hartRequestPreambles") { m_traits.requestPreambles = std::get<double>(v); rebuildConfiguredPlan(); }
    else if (id == "hartUniversalRevision") { m_traits.universalRevision = std::get<double>(v); rebuildConfiguredPlan(); }
    else if (id == "hartDeviceRevision") { m_traits.deviceRevision = std::get<double>(v); rebuildConfiguredPlan(); }
    else if (id == "hartSoftwareRevision") { m_traits.softwareRevision = std::get<double>(v); rebuildConfiguredPlan(); }
    else if (id == "hartHardwareRevision") { m_traits.hardwareRevision = std::get<double>(v); rebuildConfiguredPlan(); }
    else if (id == "hartFlags") { m_traits.flags = std::get<double>(v); rebuildConfiguredPlan(); }
    else if (id == "hartImplementedRevision") { m_traits.implementedRevision = std::get<double>(v); rebuildConfiguredPlan(); }
    else if (id == "analogSaturationLowPercent") { m_traits.saturationLowPercent = std::get<double>(v); rebuildConfiguredPlan(); }
    else if (id == "analogSaturationHighPercent") { m_traits.saturationHighPercent = std::get<double>(v); rebuildConfiguredPlan(); }
    else if (id == "hartCommandSet") { m_traits.commandSet = std::get<std::string>(v); rebuildConfiguredPlan(); }
    else if (id == "analogFixedLowMilliamps") { m_traits.fixedLowMilliamps = std::get<double>(v); rebuildConfiguredPlan(); }
    else if (id == "analogFixedHighMilliamps") { m_traits.fixedHighMilliamps = std::get<double>(v); rebuildConfiguredPlan(); }
    else if (id == "analogAlarmLowMilliamps") { m_traits.alarmLowMilliamps = std::get<double>(v); rebuildConfiguredPlan(); }
    else if (id == "analogAlarmHighMilliamps") { m_traits.alarmHighMilliamps = std::get<double>(v); rebuildConfiguredPlan(); }
    else if (id == "rangeLimitTolerancePercent") { m_traits.rangeTolerancePercent = std::get<double>(v); rebuildConfiguredPlan(); }
    else if (id == "minimumSpanAcceptPercent") { m_traits.minimumSpanAcceptPercent = std::get<double>(v); rebuildConfiguredPlan(); }
    else if (id == "hartOperationCounters") { m_traits.operationCounters = std::get<std::string>(v); rebuildConfiguredPlan(); }
    else if (id == "hartAlarmHighCode") { m_traits.alarmHighCode = std::get<double>(v); rebuildConfiguredPlan(); }
    else if (id == "hartAlarmLowCode") { m_traits.alarmLowCode = std::get<double>(v); rebuildConfiguredPlan(); }
    else if (id == "hartBurnoutPercentFollowsOutput") { m_traits.burnoutPercentFollowsOutput = std::get<bool>(v); rebuildConfiguredPlan(); }
    else if (id == "hartColdStartKeptByCommand0") { m_traits.coldStartKeptByCommand0 = std::get<bool>(v); rebuildConfiguredPlan(); }
    else if (id == "hartBurnoutStatus") { m_traits.burnoutStatus = std::get<double>(v); rebuildConfiguredPlan(); }
    else if (id == "hartWriteProtectActiveCode") { m_traits.writeProtectActiveCode = std::get<double>(v); rebuildConfiguredPlan(); }
    else if (id == "hartMaxDeviceVariables") { m_traits.maxDeviceVariables = std::get<double>(v); rebuildConfiguredPlan(); }
    else if (id == "hartPrivateLabel") { m_traits.privateLabel = std::get<double>(v); rebuildConfiguredPlan(); }
    else if (id == "hartDeviceProfile") { m_traits.deviceProfile = std::get<double>(v); rebuildConfiguredPlan(); }
    else if (id == "hartResponseDataLimits") { m_traits.responseDataLimits = std::get<std::string>(v); rebuildConfiguredPlan(); }
    else if (id == "hartConfigChangeCounter") { m_configChangeCounter = static_cast<uint32_t>(std::clamp(std::get<double>(v), 0.0, 65535.0)); rebuildConfiguredPlan(); }
    else if (id == "sensorFault") { m_sensorFault = std::get<bool>(v); m_engine.setSensorFault(m_deviceId, m_sensorFault || m_signalSensorFault); }
    else if (id == "displayInstalled") m_displayInstalled = std::get<bool>(v);
    else if (id == "displayVariable1") m_displayVariable1 = std::get<std::string>(v);
    else if (id == "displayVariable2") m_displayVariable2 = std::get<std::string>(v);
    else if (id == "displayCodeMap") m_displayCodeMap = std::get<std::string>(v);
    else if (id == "displayGlass") m_displayGlass = std::get<double>(v);
    else if (id == "displayModelName") m_displayModelName = std::get<std::string>(v);
    else if (id == "analogLoopDirection") {
        m_analogInput = std::get<std::string>(v) == "input";
        m_publishedInputMilliamps = std::numeric_limits<double>::quiet_NaN();
        m_scheduler.dirtySet().insert(m_componentIndex);
    }
    else if (id == "analogInputResistance") { m_inputResistance = std::clamp(std::get<double>(v), 1.0, 1e6); m_scheduler.dirtySet().insert(m_componentIndex); }
    else if (id == "analogInputMinimumMilliamps") m_inputMinimumMilliamps = std::clamp(std::get<double>(v), 0.0, 24.0);
    else if (id == "analogInputVariable") { m_inputCurrentVariable = std::get<std::string>(v); m_publishedInputMilliamps = std::numeric_limits<double>::quiet_NaN(); }
    else if (id == "sensorLowVolts") m_sensorLowVolts = std::get<double>(v);
    else if (id == "sensorHighVolts") m_sensorHighVolts = std::max(m_sensorLowVolts + 1e-9, std::get<double>(v));
    else if (id == "sensorLowValue") m_sensorLowValue = std::get<double>(v);
    else if (id == "sensorHighValue") m_sensorHighValue = std::get<double>(v);
    else if (id == "writeProtectCode") { m_writeProtectCode = static_cast<uint8_t>(std::clamp(std::get<double>(v), 0.0, 255.0)); rebuildConfiguredPlan(); }
    else if (id == "configurationChangedFlags") { m_configurationChangedFlags = static_cast<uint8_t>(std::clamp(std::get<double>(v), 0.0, 3.0)); rebuildConfiguredPlan(); }
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
