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

} // namespace lasecsimul::protocols
