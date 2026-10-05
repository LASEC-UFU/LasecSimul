#pragma once

#include <cstddef>
#include <cstdint>
#include <span>
#include <string>

namespace lasecsimul::protocols {

/** Non-blocking IPv4 UDP socket bound to a local address/port. The HART
 * modem uses it as its PC side when the master talks HART over UDP (one HART
 * frame per datagram, the reply goes back to the sender). */
class HostUdpSocket {
public:
    struct Peer {
        uint32_t address = 0;   ///< network byte order
        uint16_t port = 0;      ///< network byte order
        bool valid() const noexcept { return port != 0; }
    };

    HostUdpSocket() = default;
    HostUdpSocket(const HostUdpSocket&) = delete;
    HostUdpSocket& operator=(const HostUdpSocket&) = delete;
    ~HostUdpSocket() { close(); }

    bool open(const std::string& bindAddress, uint16_t port);
    void close();
    bool isOpen() const noexcept { return m_open; }
    /** One datagram if available (never blocks); 0 when none. */
    size_t receive(uint8_t* out, size_t capacity, Peer& from);
    bool sendTo(std::span<const uint8_t> bytes, const Peer& to);
    /** Port actually bound (useful with port 0). */
    uint16_t localPort() const noexcept { return m_localPort; }
    const std::string& error() const noexcept { return m_error; }

private:
    bool m_open = false;
    uint16_t m_localPort = 0;
    std::string m_error;
#if defined(_WIN32)
    uintptr_t m_socket = ~static_cast<uintptr_t>(0);
#else
    int m_socket = -1;
#endif
};

} // namespace lasecsimul::protocols
