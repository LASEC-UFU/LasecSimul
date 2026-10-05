#include "HartTransport.hpp"

#include <algorithm>

namespace lasecsimul::protocols {

HartTransportEndpoint::HartTransportEndpoint(HartEngine& engine, HartTransportConfig config)
    : m_engine(engine), m_config(std::move(config)) {}

bool HartTransportEndpoint::configure(HartTransportConfig config) {
    if (config.bus.empty() || config.maxFrameBytes < 5 || config.maxFrameBytes > 272) return false;
    if (config.kind == HartTransportKind::Serial && config.baudRate == 0) return false;
    if (config.kind == HartTransportKind::Udp && config.udpPort == 0) return false;
    m_config = std::move(config);
    return true;
}

bool HartTransportEndpoint::transact(std::span<const uint8_t> request,
                                     HartResponseBuilder& response) noexcept {
    if (request.empty() || request.size() > m_config.maxFrameBytes) {
        ++m_counters.decodeErrors;
        return false;
    }
    // A physical HART frame (what a modem or PACTware puts on the wire)
    // starts with 0xFF preambles; the legacy virtual frame starts with its
    // 0x02 delimiter and carries no preambles, response code or status.
    if (request.front() == 0xFF) return transactPhysical(request, response);

    HartFrame frame;
    if (!HartFrameCodec::decode(request, frame, m_config.maxFrameBytes - 5)) {
        ++m_counters.decodeErrors;
        return false;
    }
    ++m_counters.framesRx;

    HartResponseBuilder payload(255);
    if (!m_engine.execute(m_config.bus, frame.pollingAddress, frame.command, frame.payload, payload)) {
        ++m_counters.unsupportedCommand;
        return false;
    }
    HartFrame reply{frame.pollingAddress, frame.command,
                    std::vector<uint8_t>(payload.bytes().begin(), payload.bytes().end())};
    if (!HartFrameCodec::encode(reply, response, m_config.maxFrameBytes - 5)) {
        ++m_counters.decodeErrors;
        return false;
    }
    ++m_counters.framesTx;
    return true;
}

bool HartTransportEndpoint::transactPhysical(std::span<const uint8_t> request,
                                             HartResponseBuilder& response) noexcept {
    // Preambles, delimiter, 1-byte (short) or 5-byte (long) address,
    // command, byte count, data, longitudinal parity (XOR) -- HCF_SPEC-81.
    size_t preambles = 0;
    while (preambles < request.size() && request[preambles] == 0xFF) ++preambles;
    if (preambles < 2 || preambles >= request.size()) { ++m_counters.decodeErrors; return false; }
    const auto frame = request.subspan(preambles);
    const uint8_t delimiter = frame[0];
    // Master-to-slave STX only; 0x82 long / 0x02 short frame.
    if ((delimiter & 0x07) != 0x02 || (delimiter & 0x60) != 0) { ++m_counters.decodeErrors; return false; }
    const bool longFrame = (delimiter & 0x80) != 0;
    const size_t addressBytes = longFrame ? 5 : 1;
    if (frame.size() < 1 + addressBytes + 3) { ++m_counters.decodeErrors; return false; }
    const uint8_t command = frame[1 + addressBytes];
    const uint8_t byteCount = frame[2 + addressBytes];
    if (frame.size() != 1 + addressBytes + 2 + byteCount + 1u) { ++m_counters.decodeErrors; return false; }
    if (HartFrameCodec::checksum(frame) != 0) {
        // A corrupted frame cannot be trusted to be addressed to this
        // device; it is ignored (no reply), as on a real multidrop loop.
        ++m_counters.checksumErrors;
        return false;
    }
    HartFrameAddress address;
    address.longFrame = longFrame;
    address.primaryMaster = (frame[1] & 0x80) != 0;
    if (longFrame) {
        std::copy_n(frame.begin() + 1, 5, address.longAddress.begin());
        address.longAddress[0] = static_cast<uint8_t>(address.longAddress[0] & 0x3F); // strip master/burst bits
    } else {
        address.pollingAddress = static_cast<uint8_t>(frame[1] & 0x3F);
    }
    ++m_counters.framesRx;
    HartResponseBuilder body(253);
    const auto data = frame.subspan(3 + addressBytes, byteCount);
    const HartAddressedReply reply = m_engine.executeAddressed(m_config.bus, address, command, data, body);
    if (!reply.addressed) { ++m_counters.unknownAddress; return false; }
    if (!reply.executed) ++m_counters.unsupportedCommand;

    for (size_t i = 0; i < reply.responsePreambles; ++i)
        if (!response.writeByte(0xFF)) return false;
    const size_t frameStart = response.size();
    // Error Response Codes carry no data bytes (HCF_SPEC-307); success and
    // warnings keep them.
    const auto dataBytes = reply.executed ? body.bytes() : std::span<const uint8_t>{};
    if (!response.writeByte(static_cast<uint8_t>(delimiter | 0x04)) || // STX -> ACK (0x02 -> 0x06, 0x82 -> 0x86)
        !response.writeBytes(frame.subspan(1, addressBytes)) ||
        !response.writeByte(command) ||
        !response.writeByte(static_cast<uint8_t>(2 + dataBytes.size())) ||
        !response.writeByte(reply.responseCode) ||
        !response.writeByte(reply.deviceStatus) ||
        !response.writeBytes(dataBytes)) return false;
    if (!response.writeByte(HartFrameCodec::checksum(response.bytes().subspan(frameStart)))) return false;
    ++m_counters.framesTx;
    return true;
}

} // namespace lasecsimul::protocols
