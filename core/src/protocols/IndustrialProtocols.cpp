#include "IndustrialProtocols.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace lasecsimul::protocols {
namespace {

bool valueMatches(VariableType type, const ProtocolValue& value) {
    return (type == VariableType::Boolean && std::holds_alternative<bool>(value)) ||
           (type == VariableType::Integer && std::holds_alternative<int64_t>(value)) ||
           (type == VariableType::Real && std::holds_alternative<double>(value));
}

std::string keyOf(const VariableDescriptor& descriptor) {
    return descriptor.namespaceId + ":" + descriptor.name;
}

double numeric(const ProtocolValue& value) {
    if (const auto boolean = std::get_if<bool>(&value)) return *boolean ? 1.0 : 0.0;
    if (const auto integer = std::get_if<int64_t>(&value)) return static_cast<double>(*integer);
    return std::get<double>(value);
}

std::string formatValue(const ProtocolValue& value) {
    if (const auto boolean = std::get_if<bool>(&value)) return *boolean ? "1" : "0";
    if (const auto integer = std::get_if<int64_t>(&value)) return std::to_string(*integer);
    return std::to_string(std::get<double>(value));
}

} // namespace

VariableHandle VariableRegistry::registerVariable(VariableDescriptor descriptor, ProtocolValue initialValue) {
    if (descriptor.namespaceId.empty() || descriptor.name.empty()) {
        throw std::invalid_argument("protocol variable requires namespace and name");
    }
    if (!valueMatches(descriptor.type, initialValue)) throw std::invalid_argument("protocol variable initial type mismatch");
    const std::string key = keyOf(descriptor);
    if (m_byQualifiedName.contains(key)) throw std::invalid_argument("duplicate protocol variable: " + key);
    const VariableHandle handle = static_cast<VariableHandle>(m_entries.size());
    m_entries.push_back({std::move(descriptor), std::move(initialValue)});
    m_byQualifiedName.emplace(key, handle);
    return handle;
}

const VariableDescriptor& VariableRegistry::descriptor(VariableHandle handle) const {
    if (handle >= m_entries.size()) throw std::out_of_range("invalid protocol variable handle");
    return m_entries[handle].descriptor;
}

ProtocolValue VariableRegistry::read(VariableHandle handle) const {
    if (handle >= m_entries.size()) throw std::out_of_range("invalid protocol variable handle");
    return m_entries[handle].value;
}

void VariableRegistry::write(VariableHandle handle, ProtocolValue value) {
    if (handle >= m_entries.size()) throw std::out_of_range("invalid protocol variable handle");
    Entry& entry = m_entries[handle];
    if (!entry.descriptor.writable) throw std::runtime_error("protocol variable is read-only");
    if (!valueMatches(entry.descriptor.type, value)) throw std::invalid_argument("protocol variable type mismatch");
    entry.value = std::move(value);
}

ModbusSemanticEndpoint::ModbusSemanticEndpoint(VariableRegistry& registry, std::string sessionNamespace)
    : m_registry(registry), m_sessionNamespace(std::move(sessionNamespace)) {
    if (m_sessionNamespace.empty()) throw std::invalid_argument("Modbus endpoint requires a session namespace");
}

void ModbusSemanticEndpoint::addMapping(ModbusMapping mapping) {
    (void)m_registry.descriptor(mapping.variable);
    if (!std::isfinite(mapping.scale) || mapping.scale == 0.0 || !std::isfinite(mapping.offset)) {
        throw std::invalid_argument("invalid Modbus scale/offset");
    }
    const auto duplicate = std::find_if(m_mappings.begin(), m_mappings.end(), [&](const ModbusMapping& existing) {
        return existing.unitId == mapping.unitId && existing.area == mapping.area && existing.address == mapping.address;
    });
    if (duplicate != m_mappings.end()) throw std::invalid_argument("duplicate Modbus mapping");
    m_mappings.push_back(mapping);
}

void ModbusSemanticEndpoint::enforceDeadline(uint64_t now, uint64_t deadline) {
    if (now > deadline) throw ProtocolTimeout("Modbus virtual deadline exceeded");
}

const ModbusMapping& ModbusSemanticEndpoint::requireMapping(uint8_t unitId, ModbusArea area, uint16_t address) const {
    const auto found = std::find_if(m_mappings.begin(), m_mappings.end(), [&](const ModbusMapping& mapping) {
        return mapping.unitId == unitId && mapping.area == area && mapping.address == address;
    });
    if (found == m_mappings.end()) throw std::out_of_range("unmapped Modbus address");
    return *found;
}

uint16_t ModbusSemanticEndpoint::encode(const ProtocolValue& value, const ModbusMapping& mapping) {
    const double encoded = (numeric(value) - mapping.offset) / mapping.scale;
    if (!std::isfinite(encoded) || encoded < 0.0 || encoded > 65535.0) throw std::overflow_error("Modbus value out of range");
    return static_cast<uint16_t>(std::llround(encoded));
}

ProtocolValue ModbusSemanticEndpoint::decode(uint16_t value, const VariableDescriptor& descriptor,
                                              const ModbusMapping& mapping) {
    const double decoded = static_cast<double>(value) * mapping.scale + mapping.offset;
    if (descriptor.type == VariableType::Boolean) return decoded != 0.0;
    if (descriptor.type == VariableType::Integer) return static_cast<int64_t>(std::llround(decoded));
    return decoded;
}

std::vector<uint16_t> ModbusSemanticEndpoint::read(uint8_t unitId, ModbusArea area, uint16_t address,
                                                    uint16_t quantity, uint64_t virtualNowNs,
                                                    uint64_t virtualDeadlineNs) const {
    enforceDeadline(virtualNowNs, virtualDeadlineNs);
    if (quantity == 0) throw std::invalid_argument("Modbus quantity must be positive");
    std::vector<uint16_t> result;
    result.reserve(quantity);
    for (uint32_t offset = 0; offset < quantity; ++offset) {
        const ModbusMapping& mapping = requireMapping(unitId, area, static_cast<uint16_t>(address + offset));
        result.push_back(encode(m_registry.read(mapping.variable), mapping));
    }
    return result;
}

void ModbusSemanticEndpoint::write(uint8_t unitId, ModbusArea area, uint16_t address,
                                    const std::vector<uint16_t>& values, uint64_t virtualNowNs,
                                    uint64_t virtualDeadlineNs) {
    enforceDeadline(virtualNowNs, virtualDeadlineNs);
    if (area != ModbusArea::Coil && area != ModbusArea::HoldingRegister) {
        throw std::invalid_argument("Modbus area is read-only");
    }
    // Validate the complete request before committing any value.
    std::vector<std::pair<VariableHandle, ProtocolValue>> staged;
    staged.reserve(values.size());
    for (size_t offset = 0; offset < values.size(); ++offset) {
        const ModbusMapping& mapping = requireMapping(unitId, area, static_cast<uint16_t>(address + offset));
        const VariableDescriptor& descriptor = m_registry.descriptor(mapping.variable);
        if (!descriptor.writable) throw std::runtime_error("Modbus mapping targets read-only variable");
        staged.emplace_back(mapping.variable, decode(values[offset], descriptor, mapping));
    }
    for (auto& [handle, value] : staged) m_registry.write(handle, std::move(value));
}

void ModbusSemanticEndpoint::configureRealTransport(RealTransportOptions options) {
    if (!options.explicitOptIn || options.port == 0) {
        throw std::invalid_argument("real Modbus transport requires explicit opt-in and a nonzero port");
    }
    m_realTransport = options;
}

void HartSemanticEndpoint::addDevice(HartDevice device) {
    (void)m_registry.descriptor(device.primaryVariable);
    if (device.uniqueId.empty()) throw std::invalid_argument("HART device requires uniqueId");
    const auto duplicate = std::find_if(m_devices.begin(), m_devices.end(), [&](const HartDevice& existing) {
        return existing.pollingAddress == device.pollingAddress || existing.uniqueId == device.uniqueId;
    });
    if (duplicate != m_devices.end()) throw std::invalid_argument("duplicate HART address/identity");
    m_devices.push_back(std::move(device));
}

HartResponse HartSemanticEndpoint::execute(uint8_t pollingAddress, uint8_t command) const {
    const auto found = std::find_if(m_devices.begin(), m_devices.end(),
                                    [&](const HartDevice& device) { return device.pollingAddress == pollingAddress; });
    if (found == m_devices.end()) throw std::out_of_range("unknown HART polling address");
    if (command == 0) return {command, {found->uniqueId, found->tag}};
    if (command == 1) return {command, {formatValue(m_registry.read(found->primaryVariable)), found->unit}};
    if (command == 3) {
        const auto& descriptor = m_registry.descriptor(found->primaryVariable);
        return {command, {descriptor.namespaceId + ":" + descriptor.name,
                          formatValue(m_registry.read(found->primaryVariable)), found->unit}};
    }
    throw std::invalid_argument("unsupported semantic HART command");
}

void SemanticBindingPlan::add(ProtocolBinding binding) {
    const auto duplicate = std::find_if(m_bindings.begin(), m_bindings.end(), [&](const ProtocolBinding& existing) {
        return existing.protocolVariable == binding.protocolVariable;
    });
    if (duplicate != m_bindings.end()) throw std::invalid_argument("protocol variable has multiple binding sources");
    m_bindings.push_back(binding);
}

void SemanticBindingPlan::commit(const std::unordered_map<uint32_t, ProtocolValue>& sourceValues,
                                 VariableRegistry& registry) const {
    std::vector<std::pair<VariableHandle, ProtocolValue>> staged;
    staged.reserve(m_bindings.size());
    for (const ProtocolBinding& binding : m_bindings) {
        const auto value = sourceValues.find(binding.sourceHandle);
        if (value == sourceValues.end()) throw std::out_of_range("binding source handle has no value");
        const VariableDescriptor& descriptor = registry.descriptor(binding.protocolVariable);
        if (!valueMatches(descriptor.type, value->second)) throw std::invalid_argument("binding type mismatch");
        staged.emplace_back(binding.protocolVariable, value->second);
    }
    for (auto& [handle, value] : staged) registry.write(handle, std::move(value));
}

} // namespace lasecsimul::protocols
