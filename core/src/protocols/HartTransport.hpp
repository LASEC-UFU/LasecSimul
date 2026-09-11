#pragma once

#include "HartEngine.hpp"

#include <cstdint>
#include <span>
#include <string>

namespace lasecsimul::protocols {

enum class HartTransportKind : uint8_t { Virtual, Serial, Udp };

struct HartTransportConfig {
    HartTransportKind kind = HartTransportKind::Virtual;
    std::string bus = "hart-1";
    std::string endpoint;
    uint32_t baudRate = 1200;
    uint16_t udpPort = 0;
    size_t maxFrameBytes = 272;
};

struct HartTransportCounters {
    uint64_t framesRx = 0;
    uint64_t framesTx = 0;
    uint64_t checksumErrors = 0;
    uint64_t decodeErrors = 0;
    uint64_t unknownAddress = 0;
    uint64_t unsupportedCommand = 0;
};

/** Transport-independent HART request/response boundary.
 * It performs no host I/O. Serial and UDP adapters feed bounded byte frames here. */
class HartTransportEndpoint final {
public:
    HartTransportEndpoint(HartEngine& engine, HartTransportConfig config = {});

    bool configure(HartTransportConfig config);
    const HartTransportConfig& config() const noexcept { return m_config; }
    const HartTransportCounters& counters() const noexcept { return m_counters; }

    // Returns false for malformed/oversized/unknown requests. `response` receives a complete
    // encoded HART frame when true. The caller owns all I/O and can bind this to virtual, serial,
    // or UDP without changing command execution.
    bool transact(std::span<const uint8_t> request, HartResponseBuilder& response) noexcept;

private:
    HartEngine& m_engine;
    HartTransportConfig m_config;
    HartTransportCounters m_counters;
};

} // namespace lasecsimul::protocols
