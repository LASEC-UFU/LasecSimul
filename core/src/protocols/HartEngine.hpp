#pragma once

#include <cstddef>
#include <cstdint>
#include <span>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace lasecsimul::protocols {

using HartCommandId = uint16_t;

struct HartCommandContext {
    uint8_t pollingAddress = 0;
    uint8_t command = 0;
    std::span<const uint8_t> request;
};

class HartResponseBuilder final {
public:
    explicit HartResponseBuilder(size_t capacity = 64) : m_bytes(capacity) {}
    bool writeByte(uint8_t value) noexcept;
    bool writeBytes(std::span<const uint8_t> values) noexcept;
    bool writeAscii(std::string_view value) noexcept;
    std::span<const uint8_t> bytes() const noexcept { return {m_bytes.data(), m_size}; }
    size_t size() const noexcept { return m_size; }
    bool overflowed() const noexcept { return m_overflow; }

private:
    std::vector<uint8_t> m_bytes;
    size_t m_size = 0;
    bool m_overflow = false;
};

class HartPayloadReader final {
public:
    explicit HartPayloadReader(std::span<const uint8_t> bytes) : m_bytes(bytes) {}
    bool readByte(uint8_t& value) noexcept;
    bool readU16(uint16_t& value) noexcept;
    bool readU32(uint32_t& value) noexcept;
    bool readBytes(size_t count, std::span<const uint8_t>& value) noexcept;
    size_t remaining() const noexcept { return m_bytes.size() - m_offset; }

private:
    std::span<const uint8_t> m_bytes;
    size_t m_offset = 0;
};

struct HartFrame {
    uint8_t pollingAddress = 0;
    HartCommandId command = 0;
    std::vector<uint8_t> payload;
};

class HartFrameCodec final {
public:
    static uint8_t checksum(std::span<const uint8_t> bytes) noexcept;
    static bool decode(std::span<const uint8_t> wire, HartFrame& frame,
                       size_t maxPayload = 255) noexcept;
    static bool encode(const HartFrame& frame, HartResponseBuilder& output,
                       size_t maxPayload = 255) noexcept;
};

struct HartCommandDescriptor {
    HartCommandId id = 0;
    std::string name;
};

class IHartCommandHandler {
public:
    virtual ~IHartCommandHandler() = default;
    virtual HartCommandId command() const noexcept = 0;
    virtual bool execute(const HartCommandContext&, HartResponseBuilder&) noexcept = 0;
};

class HartCommandRegistry final {
public:
    bool registerHandler(IHartCommandHandler& handler);
    bool remove(HartCommandId command) noexcept;
    IHartCommandHandler* find(HartCommandId command) const noexcept;
    size_t size() const noexcept { return m_handlers.size(); }

private:
    std::unordered_map<HartCommandId, IHartCommandHandler*> m_handlers;
};

struct HartDeviceProfile {
    std::string id;
    uint32_t version = 1;
    uint16_t manufacturerId = 0;
    uint16_t deviceType = 0;
    std::vector<HartCommandDescriptor> commands;
};

class HartProfileRegistry final {
public:
    bool registerProfile(HartDeviceProfile profile);
    bool remove(std::string_view id) noexcept;
    const HartDeviceProfile* find(std::string_view id) const noexcept;
    size_t size() const noexcept { return m_profiles.size(); }

private:
    std::unordered_map<std::string, HartDeviceProfile> m_profiles;
};

} // namespace lasecsimul::protocols
