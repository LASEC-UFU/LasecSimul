#include "HartEngine.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace lasecsimul::protocols {

bool HartResponseBuilder::writeByte(uint8_t value) noexcept {
    if (m_size >= m_bytes.size()) { m_overflow = true; return false; }
    m_bytes[m_size++] = value;
    return true;
}

bool HartResponseBuilder::writeBytes(std::span<const uint8_t> values) noexcept {
    if (values.size() > m_bytes.size() - m_size) { m_overflow = true; return false; }
    std::copy(values.begin(), values.end(), m_bytes.begin() + static_cast<std::vector<uint8_t>::difference_type>(m_size));
    m_size += values.size();
    return true;
}

bool HartResponseBuilder::writeAscii(std::string_view value) noexcept {
    return writeBytes({reinterpret_cast<const uint8_t*>(value.data()), value.size()});
}

bool HartPayloadReader::readByte(uint8_t& value) noexcept {
    if (m_offset >= m_bytes.size()) return false;
    value = m_bytes[m_offset++];
    return true;
}

bool HartPayloadReader::readU16(uint16_t& value) noexcept {
    if (m_bytes.size() - m_offset < 2) return false;
    value = static_cast<uint16_t>(m_bytes[m_offset] << 8 | m_bytes[m_offset + 1]);
    m_offset += 2;
    return true;
}

bool HartPayloadReader::readU32(uint32_t& value) noexcept {
    if (m_bytes.size() - m_offset < 4) return false;
    value = (static_cast<uint32_t>(m_bytes[m_offset]) << 24) |
            (static_cast<uint32_t>(m_bytes[m_offset + 1]) << 16) |
            (static_cast<uint32_t>(m_bytes[m_offset + 2]) << 8) |
            static_cast<uint32_t>(m_bytes[m_offset + 3]);
    m_offset += 4;
    return true;
}

bool HartPayloadReader::readBytes(size_t count, std::span<const uint8_t>& value) noexcept {
    if (count > m_bytes.size() - m_offset) return false;
    value = m_bytes.subspan(m_offset, count);
    m_offset += count;
    return true;
}

uint8_t HartFrameCodec::checksum(std::span<const uint8_t> bytes) noexcept {
    uint8_t result = 0;
    for (uint8_t byte : bytes) result ^= byte;
    return result;
}

bool HartFrameCodec::decode(std::span<const uint8_t> wire, HartFrame& frame,
                            size_t maxPayload) noexcept {
    // Semantic HART frame used by the virtual engine:
    // delimiter, short address, command, byte-count, payload, XOR checksum.
    if (wire.size() < 5 || wire[0] != 0x02) return false;
    const size_t payloadSize = wire[3];
    if (payloadSize > maxPayload || wire.size() != payloadSize + 5) return false;
    if (checksum(wire.first(wire.size() - 1)) != wire.back()) return false;
    frame.pollingAddress = wire[1];
    frame.command = wire[2];
    frame.payload.assign(wire.begin() + 4, wire.begin() + 4 + static_cast<std::span<const uint8_t>::difference_type>(payloadSize));
    return true;
}

bool HartFrameCodec::encode(const HartFrame& frame, HartResponseBuilder& output,
                            size_t maxPayload) noexcept {
    if (frame.payload.size() > maxPayload || frame.payload.size() > 255) return false;
    const size_t start = output.size();
    if (!output.writeByte(0x02) || !output.writeByte(frame.pollingAddress) ||
        !output.writeByte(static_cast<uint8_t>(frame.command)) ||
        !output.writeByte(static_cast<uint8_t>(frame.payload.size())) ||
        !output.writeBytes(frame.payload)) return false;
    const auto encoded = output.bytes();
    return output.writeByte(checksum(encoded.subspan(start)));
}

bool HartCommandRegistry::registerHandler(IHartCommandHandler& handler) {
    const auto [it, inserted] = m_handlers.emplace(handler.command(), &handler);
    return inserted && it->second == &handler;
}

bool HartCommandRegistry::remove(HartCommandId command) noexcept {
    return m_handlers.erase(command) != 0;
}

IHartCommandHandler* HartCommandRegistry::find(HartCommandId command) const noexcept {
    const auto it = m_handlers.find(command);
    return it == m_handlers.end() ? nullptr : it->second;
}

bool HartProfileRegistry::registerProfile(HartDeviceProfile profile) {
    if (profile.id.empty() || profile.version == 0) return false;
    const auto [it, inserted] = m_profiles.emplace(profile.id, std::move(profile));
    return inserted && !it->second.id.empty();
}

bool HartProfileRegistry::remove(std::string_view id) noexcept {
    return m_profiles.erase(std::string(id)) != 0;
}

const HartDeviceProfile* HartProfileRegistry::find(std::string_view id) const noexcept {
    const auto it = m_profiles.find(std::string(id));
    return it == m_profiles.end() ? nullptr : &it->second;
}

HartPlanCompileResult HartPlanCompiler::compile(std::span<const HartDevicePlan> devices,
                                                const HartProfileRegistry& profiles) {
    HartPlanCompileResult result;
    for (const HartDevicePlan& device : devices) {
        if (device.id.empty()) { result.error = "HART device id is empty"; return result; }
        if (device.bus.empty()) { result.error = "HART bus is empty"; return result; }
        if (device.pollingAddress > 63) { result.error = "HART polling address out of range"; return result; }
        if (!profiles.find(device.profileId)) { result.error = "HART profile not found: " + device.profileId; return result; }
        for (size_t i = 0; i < device.commandConfigurations.size(); ++i) {
            const auto& configuration = device.commandConfigurations[i];
            const bool declared = std::any_of(profiles.find(device.profileId)->commands.begin(),
                                              profiles.find(device.profileId)->commands.end(),
                                              [&](const HartCommandDescriptor& descriptor) {
                                                  return descriptor.id == configuration.command;
                                              });
            if (!declared) { result.error = "HART command override is not declared by profile"; return result; }
            if (configuration.staticResponse.size() > 255) {
                result.error = "HART command override response exceeds frame limit"; return result;
            }
            for (size_t j = 0; j < i; ++j) {
                if (device.commandConfigurations[j].command == configuration.command) {
                    result.error = "duplicate HART command override"; return result;
                }
            }
        }
        for (const HartDevicePlan& prior : result.plan.devices) {
            if (prior.id == device.id) { result.error = "duplicate HART device id"; return result; }
            if (prior.bus == device.bus && prior.pollingAddress == device.pollingAddress) {
                result.error = "duplicate HART address on bus: " + device.bus; return result;
            }
        }
        result.plan.devices.push_back(device);
    }
    result.success = true;
    return result;
}

HartEngine::HartEngine(const HartProfileRegistry& profiles) : m_profiles(profiles) {}

bool HartEngine::loadPlan(HartProtocolPlan plan) {
    const HartPlanCompileResult checked = HartPlanCompiler::compile(plan.devices, m_profiles);
    if (!checked.success) return false;
    std::vector<RuntimeDevice> resolved;
    resolved.reserve(checked.plan.devices.size());
    for (const HartDevicePlan& device : checked.plan.devices) {
        const HartDeviceProfile* profile = m_profiles.find(device.profileId);
        if (!profile) return false;
        resolved.push_back({device, profile});
    }
    m_devices = std::move(resolved);
    return true;
}

void HartEngine::clear() noexcept { m_devices.clear(); }

bool HartEngine::setPrimaryValue(std::string_view deviceId, double value) noexcept {
    if (!std::isfinite(value)) return false;
    for (RuntimeDevice& device : m_devices) {
        if (device.plan.id == deviceId) { device.plan.primaryValue = value; return true; }
    }
    return false;
}

bool HartEngine::setCommandEnabled(std::string_view deviceId, HartCommandId command, bool enabled) noexcept {
    for (RuntimeDevice& device : m_devices) {
        if (device.plan.id != deviceId) continue;
        for (auto& configuration : device.plan.commandConfigurations) {
            if (configuration.command == command) { configuration.enabled = enabled; return true; }
        }
        return false;
    }
    return false;
}

bool HartEngine::setCommandResponse(std::string_view deviceId, HartCommandId command,
                                    std::span<const uint8_t> response) noexcept {
    if (response.size() > 255) return false;
    for (RuntimeDevice& device : m_devices) {
        if (device.plan.id != deviceId) continue;
        for (auto& configuration : device.plan.commandConfigurations) {
            if (configuration.command != command) continue;
            configuration.hasStaticResponse = true;
            configuration.staticResponse.assign(response.begin(), response.end());
            return true;
        }
        return false;
    }
    return false;
}

bool HartEngine::execute(std::string_view bus, uint8_t pollingAddress, HartCommandId command,
                         std::span<const uint8_t> request, HartResponseBuilder& response) noexcept {
    RuntimeDevice* selected = nullptr;
    for (RuntimeDevice& device : m_devices) {
        if (device.plan.bus == bus && device.plan.pollingAddress == pollingAddress) {
            selected = &device;
            break;
        }
    }
    if (!selected) return false;
    const bool declared = std::any_of(selected->profile->commands.begin(), selected->profile->commands.end(),
                                      [command](const HartCommandDescriptor& descriptor) { return descriptor.id == command; });
    if (!declared) return false;
    for (const auto& configuration : selected->plan.commandConfigurations) {
        if (configuration.command != command) continue;
        if (!configuration.enabled) return false;
        if (configuration.hasStaticResponse) {
            return response.writeBytes(configuration.staticResponse);
        }
        break;
    }
    if (IHartCommandHandler* custom = m_commands.find(command)) {
        return custom->execute({pollingAddress, static_cast<uint8_t>(command), request}, response);
    }
    switch (command) {
        case 0: // Read unique identifier (semantic virtual representation).
            return response.writeAscii(selected->plan.uniqueId);
        case 1: { // Read primary variable: IEEE-754 float32, network byte order.
            const float value = static_cast<float>(selected->plan.primaryValue);
            uint32_t bits = 0;
            std::memcpy(&bits, &value, sizeof(bits));
            return response.writeByte(static_cast<uint8_t>(bits >> 24)) &&
                   response.writeByte(static_cast<uint8_t>(bits >> 16)) &&
                   response.writeByte(static_cast<uint8_t>(bits >> 8)) &&
                   response.writeByte(static_cast<uint8_t>(bits));
        }
        case 3: // Universal dynamic variables: PV only in the baseline profile.
            return response.writeByte(1) && response.writeByte(0) &&
                   response.writeByte(0) && response.writeByte(0);
        default:
            return false;
    }
}

} // namespace lasecsimul::protocols
