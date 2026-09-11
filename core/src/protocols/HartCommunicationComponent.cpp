#include "HartCommunicationComponent.hpp"

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

    auto profile = HartReferenceCatalog::makeGenericProfile();
    m_profiles.registerProfile(profile);
    HartDevicePlan device;
    device.id = "device-" + m_endpointName; device.profileId = profile.id; device.bus = m_bus;
    device.pollingAddress = m_pollingAddress; device.uniqueId = m_uniqueId; device.primaryValue = 0.0;
    for (const auto& command : profile.commands) device.commandConfigurations.push_back({command.id, true, false, {}});
    m_engine.loadPlan(HartProtocolPlan{{std::move(device)}});
    HartTransportConfig config;
    config.kind = mode == Mode::Serial ? HartTransportKind::Serial : HartTransportKind::Udp;
    config.bus = m_bus; config.endpoint = m_endpointName; config.baudRate = m_baudRate; config.udpPort = m_udpPort;
    m_endpoint.configure(std::move(config));
}

void HartCommunicationComponent::rebuildConfiguredPlan() {
    HartDevicePlan device;
    device.id = "device-" + m_endpointName;
    device.profileId = "lasecsimul.hart.process-simul-compatible";
    device.bus = m_bus; device.pollingAddress = m_pollingAddress;
    device.uniqueId = m_uniqueId; device.primaryValue = 0.0;
    const HartDeviceProfile* profile = m_profiles.find(device.profileId);
    if (!profile) { m_profiles.registerProfile(HartReferenceCatalog::makeGenericProfile()); profile = m_profiles.find(device.profileId); }
    for (const auto& command : profile->commands) device.commandConfigurations.push_back({command.id, true, false, {}});
    try {
        const auto parsed = nlohmann::json::parse(m_hartVariablesJson.empty() ? "[]" : m_hartVariablesJson);
        if (!parsed.is_array() || parsed.size() > 64) return;
        for (const auto& item : parsed) {
            if (!item.is_object() || !item.value("id", std::string{}).size()) return;
            HartDevicePlan::VariableConfiguration variable;
            variable.id = item.value("id", std::string{});
            variable.name = item.value("name", variable.id);
            variable.unit = item.value("unit", std::string{});
            variable.value = item.value("value", 0.0);
            variable.expression = item.value("expression", item.value("function", std::string{}));
            variable.writable = item.value("writable", false);
            device.variables.push_back(std::move(variable));
        }
    } catch (...) { return; }
    if (!m_engine.loadPlan(HartProtocolPlan{{std::move(device)}})) return;
}

const char* HartCommunicationComponent::typeId() const { return m_mode == Mode::Serial ? "protocol.hart.serial" : "protocol.hart.udp"; }

std::vector<PropertySchema> HartCommunicationComponent::propertySchema(Mode mode) {
    std::vector<PropertySchema> out{
        textSchema("bus", "Canal HART", "Comunicacao", "hart-1"),
        textSchema("endpoint", mode == Mode::Serial ? "Porta serial" : "Endereco UDP", "Comunicacao", mode == Mode::Serial ? "COM1" : "127.0.0.1"),
        {"enabled", "Habilitado", "Comunicacao", "", PropertyValueKind::Bool, "checkbox", true},
        numberSchema("pollingAddress", "Polling address", "HART", "", 0, 0, 63),
        textSchema("uniqueId", "Unique ID", "HART", "029EB1"), textSchema("tag", "Tag", "HART", "HART"),
        textSchema("unit", "Unidade PV", "HART", "V"), textSchema("hartVariablesJson", "Variáveis HART", "HART", "[]"),
        textSchema("hartCommandsJson", "Comandos HART", "HART", "[]")};
    if (mode == Mode::Serial) out.push_back(numberSchema("baudRate", "Baud rate", "Serial", "baud", 1200, 1200, 1200));
    else out.push_back(numberSchema("udpPort", "Porta UDP", "UDP", "", 5094, 1, 65535));
    return out;
}

PropertyValue HartCommunicationComponent::propertyValue(const std::string& id) const {
    if (id == "bus") return m_bus; if (id == "endpoint") return m_endpointName; if (id == "enabled") return m_enabled;
    if (id == "pollingAddress") return static_cast<double>(m_pollingAddress); if (id == "uniqueId") return m_uniqueId;
    if (id == "tag") return m_tag; if (id == "unit") return m_unit; if (id == "hartVariablesJson") return m_hartVariablesJson; if (id == "hartCommandsJson") return m_hartCommandsJson; if (id == "baudRate") return static_cast<double>(m_baudRate);
    if (id == "udpPort") return static_cast<double>(m_udpPort); return std::string{};
}
void HartCommunicationComponent::setPropertyValue(const std::string& id, const PropertyValue& v) {
    if (id == "bus") m_bus = std::get<std::string>(v); else if (id == "endpoint") m_endpointName = std::get<std::string>(v);
    else if (id == "enabled") m_enabled = std::get<bool>(v); else if (id == "pollingAddress") m_pollingAddress = static_cast<uint8_t>(std::clamp(std::get<double>(v), 0.0, 63.0));
    else if (id == "uniqueId") m_uniqueId = std::get<std::string>(v); else if (id == "tag") m_tag = std::get<std::string>(v); else if (id == "unit") m_unit = std::get<std::string>(v);
    else if (id == "hartVariablesJson") { m_hartVariablesJson = std::get<std::string>(v); rebuildConfiguredPlan(); }
    else if (id == "hartCommandsJson") m_hartCommandsJson = std::get<std::string>(v);
    else if (id == "baudRate") m_baudRate = 1200;
    else if (id == "udpPort") m_udpPort = static_cast<uint16_t>(std::clamp(std::get<double>(v), 1.0, 65535.0));
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
