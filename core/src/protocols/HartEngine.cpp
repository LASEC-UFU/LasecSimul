#include "HartEngine.hpp"

#include <algorithm>

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

} // namespace lasecsimul::protocols
