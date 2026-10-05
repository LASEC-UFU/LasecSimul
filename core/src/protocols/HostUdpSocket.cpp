#include "HostUdpSocket.hpp"

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#pragma comment(lib, "ws2_32.lib")
using SocketHandle = SOCKET;
#else
#include <arpa/inet.h>
#include <cerrno>
#include <fcntl.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
#endif

namespace lasecsimul::protocols {

namespace {
int lastError() {
#if defined(_WIN32)
    return WSAGetLastError();
#else
    return errno;
#endif
}
} // namespace

bool HostUdpSocket::open(const std::string& bindAddress, uint16_t port) {
    close();
    m_error.clear();
#if defined(_WIN32)
    static const bool started = [] { WSADATA data{}; return WSAStartup(MAKEWORD(2, 2), &data) == 0; }();
    if (!started) { m_error = "Winsock indisponivel"; return false; }
#endif
    sockaddr_in local{};
    local.sin_family = AF_INET;
    local.sin_port = htons(port);
    if (inet_pton(AF_INET, bindAddress.empty() ? "127.0.0.1" : bindAddress.c_str(), &local.sin_addr) != 1) {
        m_error = "Endereco UDP invalido: " + bindAddress;
        return false;
    }
    const auto handle = ::socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
#if defined(_WIN32)
    if (handle == INVALID_SOCKET) { m_error = "Nao foi possivel criar o socket UDP (" + std::to_string(lastError()) + ")"; return false; }
    u_long nonBlocking = 1;
    ioctlsocket(handle, FIONBIO, &nonBlocking);
#else
    if (handle < 0) { m_error = "Nao foi possivel criar o socket UDP (" + std::to_string(lastError()) + ")"; return false; }
    fcntl(handle, F_SETFL, fcntl(handle, F_GETFL, 0) | O_NONBLOCK);
#endif
    m_socket = handle;
    m_open = true;
    if (::bind(handle, reinterpret_cast<const sockaddr*>(&local), sizeof local) != 0) {
        m_error = "Nao foi possivel usar " + bindAddress + ":" + std::to_string(port) + " (" + std::to_string(lastError()) + ")";
        close();
        return false;
    }
    sockaddr_in bound{};
#if defined(_WIN32)
    int length = sizeof bound;
#else
    socklen_t length = sizeof bound;
#endif
    if (::getsockname(handle, reinterpret_cast<sockaddr*>(&bound), &length) == 0) m_localPort = ntohs(bound.sin_port);
    return true;
}

void HostUdpSocket::close() {
    if (!m_open) return;
#if defined(_WIN32)
    ::closesocket(static_cast<SOCKET>(m_socket));
    m_socket = ~static_cast<uintptr_t>(0);
#else
    ::close(m_socket);
    m_socket = -1;
#endif
    m_open = false;
    m_localPort = 0;
}

size_t HostUdpSocket::receive(uint8_t* out, size_t capacity, Peer& from) {
    if (!m_open || capacity == 0) return 0;
    sockaddr_in remote{};
#if defined(_WIN32)
    int length = sizeof remote;
    const int got = ::recvfrom(static_cast<SOCKET>(m_socket), reinterpret_cast<char*>(out), static_cast<int>(capacity), 0,
                               reinterpret_cast<sockaddr*>(&remote), &length);
#else
    socklen_t length = sizeof remote;
    const ssize_t got = ::recvfrom(m_socket, out, capacity, 0, reinterpret_cast<sockaddr*>(&remote), &length);
#endif
    if (got <= 0) return 0;
    from.address = remote.sin_addr.s_addr;
    from.port = remote.sin_port;
    return static_cast<size_t>(got);
}

bool HostUdpSocket::sendTo(std::span<const uint8_t> bytes, const Peer& to) {
    if (!m_open || !to.valid() || bytes.empty()) return false;
    sockaddr_in remote{};
    remote.sin_family = AF_INET;
    remote.sin_addr.s_addr = to.address;
    remote.sin_port = to.port;
#if defined(_WIN32)
    const int sent = ::sendto(static_cast<SOCKET>(m_socket), reinterpret_cast<const char*>(bytes.data()), static_cast<int>(bytes.size()), 0,
                              reinterpret_cast<const sockaddr*>(&remote), sizeof remote);
#else
    const ssize_t sent = ::sendto(m_socket, bytes.data(), bytes.size(), 0, reinterpret_cast<const sockaddr*>(&remote), sizeof remote);
#endif
    return sent == static_cast<decltype(sent)>(bytes.size());
}

} // namespace lasecsimul::protocols
