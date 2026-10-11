#include <cstdio>
#include <fstream>
#include <iostream>
#include <string>
#include <cerrno>

#include "PlcScanSession.hpp"
#include "fixtures/hello.generated.hpp"

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#else
#include <arpa/inet.h>
#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>
#endif

using namespace lasecsimul::plc;
namespace {
strucpp::Program_HELLO g_program;
strucpp::IECVar<strucpp::BOOL_t> g_fileDenied;
strucpp::IECVar<strucpp::BOOL_t> g_networkDenied;
strucpp::IECVar<strucpp::BOOL_t> g_secretEnvironmentBlocked;
constexpr uint16_t kProbePort = 43917;

VarDescriptor var(const char* name, VarTypeTag type, void* value) { return {name, type, value}; }

void runSandboxProbes() {
    g_secretEnvironmentBlocked.set(std::getenv("LASECSIMUL_PLC_TEST_SECRET") == nullptr);
    std::ifstream sentinel(LASECSIMUL_TEST_PLC_SANDBOX_SENTINEL, std::ios::binary);
    g_fileDenied.set(!sentinel.good());
#if defined(_WIN32)
    WSADATA data{};
    const bool winsockReady = WSAStartup(MAKEWORD(2, 2), &data) == 0;
    SOCKET socketHandle = winsockReady ? socket(AF_INET, SOCK_STREAM, IPPROTO_TCP) : INVALID_SOCKET;
    if (socketHandle != INVALID_SOCKET) {
        u_long nonBlocking = 1;
        ioctlsocket(socketHandle, FIONBIO, &nonBlocking);
        sockaddr_in address{};
        address.sin_family = AF_INET;
        address.sin_port = htons(kProbePort);
        address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        const int connected = connect(socketHandle, reinterpret_cast<sockaddr*>(&address), sizeof(address));
        if (connected == 0) g_networkDenied.set(false);
        else if (WSAGetLastError() == WSAEWOULDBLOCK) {
            fd_set writable; FD_ZERO(&writable); FD_SET(socketHandle, &writable);
            timeval timeout{0, 250000};
            const int ready = select(0, nullptr, &writable, nullptr, &timeout);
            int error = 0; int errorLength = sizeof(error);
            if (ready > 0) getsockopt(socketHandle, SOL_SOCKET, SO_ERROR, reinterpret_cast<char*>(&error), &errorLength);
            g_networkDenied.set(ready <= 0 || error != 0);
        } else g_networkDenied.set(true);
        closesocket(socketHandle);
    } else g_networkDenied.set(true);
    if (winsockReady) WSACleanup();
#else
    const int socketHandle = socket(AF_INET, SOCK_STREAM, 0);
    if (socketHandle >= 0) {
        const int flags = fcntl(socketHandle, F_GETFL, 0);
        if (flags >= 0) fcntl(socketHandle, F_SETFL, flags | O_NONBLOCK);
        sockaddr_in address{};
        address.sin_family = AF_INET;
        address.sin_port = htons(kProbePort);
        address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        const int connected = connect(socketHandle, reinterpret_cast<sockaddr*>(&address), sizeof(address));
        if (connected == 0) g_networkDenied.set(false);
        else if (errno == EINPROGRESS) {
            pollfd descriptor{socketHandle, POLLOUT, 0};
            const int ready = poll(&descriptor, 1, 250);
            int error = 0; socklen_t errorLength = sizeof(error);
            if (ready > 0) getsockopt(socketHandle, SOL_SOCKET, SO_ERROR, &error, &errorLength);
            g_networkDenied.set(ready <= 0 || error != 0);
        } else g_networkDenied.set(true);
        close(socketHandle);
    } else g_networkDenied.set(true);
#endif
}
}

int main() {
    runSandboxProbes();
    std::vector<VarDescriptor> allVars = {
        var("DI0", VarTypeTag::BOOL, &g_program.DI0),
        var("DO0", VarTypeTag::BOOL, &g_program.DO0),
        var("TIMER0", VarTypeTag::OTHER, &g_program.TIMER0),
        var("FS_BLOCKED", VarTypeTag::BOOL, &g_fileDenied),
        var("NETWORK_BLOCKED", VarTypeTag::BOOL, &g_networkDenied),
        var("ENV_BLOCKED", VarTypeTag::BOOL, &g_secretEnvironmentBlocked),
    };
    std::vector<VarDescriptor> inputs = {var("DI0", VarTypeTag::BOOL, &g_program.DI0)};
    std::vector<VarDescriptor> outputs = {var("DO0", VarTypeTag::BOOL, &g_program.DO0)};
    ProgramDescriptor descriptor{"HELLO", &g_program, allVars.data(), allVars.size(), 0LL};
    PlcScanSession session(descriptor, std::move(inputs), std::move(outputs), [] {
        g_program.~Program_HELLO();
        new (&g_program) strucpp::Program_HELLO();
    });
    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.empty()) continue;
        std::cout << session.handleLine(line) << "\n" << std::flush;
        if (line.rfind("SHUTDOWN", 0) == 0) break;
    }
    return 0;
}
