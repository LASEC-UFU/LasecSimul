#include "McuController.hpp"

#include <charconv>
#include <cstdlib>
#include <iomanip>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string_view>

#if defined(_WIN32)
#include <winsock2.h>
#pragma comment(lib, "ws2_32.lib")
#else
#include <arpa/inet.h>
#include <sys/socket.h>
#include <unistd.h>
#endif

namespace lasecsimul::mcu {

namespace {

uint32_t fnv1a(std::string_view text) {
    uint32_t hash = 2166136261u;
    for (const unsigned char ch : text) {
        hash ^= ch;
        hash *= 16777619u;
    }
    return hash;
}

std::optional<unsigned> configuredNetworkNamespace() {
    const char* value = std::getenv("LASECSIMUL_NETWORK_NAMESPACE");
    if (!value || !*value) return std::nullopt;
    unsigned parsed = 0;
    const std::string_view text(value);
    const auto result = std::from_chars(text.data(), text.data() + text.size(), parsed);
    if (result.ec != std::errc{} || result.ptr != text.data() + text.size() || parsed > 255) {
        return std::nullopt;
    }
    return parsed;
}

unsigned componentNetworkSlot(std::string_view arenaName) {
    const size_t separator = arenaName.rfind('-');
    if (separator != std::string_view::npos && separator + 1 < arenaName.size()) {
        unsigned parsed = 0;
        const std::string_view suffix = arenaName.substr(separator + 1);
        const auto result = std::from_chars(suffix.data(), suffix.data() + suffix.size(), parsed);
        if (result.ec == std::errc{} && result.ptr == suffix.data() + suffix.size()) return parsed & 0xffu;
    }
    return fnv1a(arenaName) & 0xffu;
}

unsigned automaticNetworkNamespace(std::string_view arenaName) {
    const size_t separator = arenaName.rfind('-');
    const std::string_view hostPart = separator == std::string_view::npos
        ? arenaName
        : arenaName.substr(0, separator);
    return fnv1a(hostPart) & 0xffu;
}

std::string openEthMacAddress(unsigned networkNamespace, unsigned componentSlot,
                              std::string_view arenaName) {
    const std::string stableIdentity = configuredNetworkNamespace().has_value()
        ? std::to_string(networkNamespace) + ":" + std::to_string(componentSlot)
        : std::string(arenaName);
    const uint32_t identityHash = fnv1a(stableIdentity);
    std::ostringstream mac;
    mac << std::hex << std::setfill('0')
        << "02:4c:" << std::setw(2) << ((identityHash >> 24u) & 0xffu)
        << ':' << std::setw(2) << ((identityHash >> 16u) & 0xffu)
        << ':' << std::setw(2) << ((identityHash >> 8u) & 0xffu)
        << ':' << std::setw(2) << (identityHash & 0xffu);
    return mac.str();
}

std::string isolatedOpenEthArgument(std::string_view arenaName) {
    const unsigned networkNamespace = configuredNetworkNamespace().value_or(
        automaticNetworkNamespace(arenaName));
    const unsigned componentSlot = componentNetworkSlot(arenaName);
    const std::string prefix = "10." + std::to_string(networkNamespace) + "." +
                               std::to_string(componentSlot);
    return "user,model=open_eth,mac=" + openEthMacAddress(networkNamespace, componentSlot, arenaName) +
           ",net=" + prefix + ".0/24,host=" + prefix +
           ".2,dhcpstart=" + prefix + ".15,dns=" + prefix + ".3";
}

std::string environmentValue(const char* name, std::string_view fallback) {
    const char* value = std::getenv(name);
    return value && *value ? std::string(value) : std::string(fallback);
}

unsigned configuredGatewayPort() {
    unsigned gatewayPort = 9011;
    if (const char* configured = std::getenv("LASECSIMUL_GATEWAY_PORT")) {
        unsigned parsed = 0;
        const std::string_view text(configured);
        const auto result = std::from_chars(text.data(), text.data() + text.size(), parsed);
        if (result.ec == std::errc{} && result.ptr == text.data() + text.size() &&
            parsed > 0 && parsed <= 65535) {
            gatewayPort = parsed;
        }
    }
    return gatewayPort;
}

bool gatewayAcceptingConnections(unsigned port) {
#if defined(_WIN32)
    WSADATA winsock{};
    if (WSAStartup(MAKEWORD(2, 2), &winsock) != 0) return false;
    const SOCKET socketHandle = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    const bool socketCreated = socketHandle != INVALID_SOCKET;
#else
    const int socketHandle = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    const bool socketCreated = socketHandle >= 0;
#endif
    if (!socketCreated) {
#if defined(_WIN32)
        WSACleanup();
#endif
        return false;
    }
    sockaddr_in endpoint{};
    endpoint.sin_family = AF_INET;
    endpoint.sin_port = htons(static_cast<uint16_t>(port));
    endpoint.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    const bool connected = ::connect(socketHandle, reinterpret_cast<const sockaddr*>(&endpoint),
                                     sizeof(endpoint)) == 0;
#if defined(_WIN32)
    closesocket(socketHandle);
    WSACleanup();
#else
    ::close(socketHandle);
#endif
    return connected;
}

std::string labBridgeOpenEthArgument(std::string_view arenaName) {
    const unsigned networkNamespace = configuredNetworkNamespace().value_or(
        automaticNetworkNamespace(arenaName));
    const unsigned componentSlot = componentNetworkSlot(arenaName);
    const unsigned gatewayPort = configuredGatewayPort();
    return "socket,model=open_eth,mac=" + openEthMacAddress(networkNamespace, componentSlot, arenaName) +
           ",connect=127.0.0.1:" + std::to_string(gatewayPort);
}

void configureNetwork(QemuLaunchSpec& spec, std::string_view arenaName) {
    const std::string mode = environmentValue("LASECSIMUL_NETWORK_MODE", "disabled");
    if (mode != "disabled" && mode != "lab-bridge" && mode != "isolated") {
        throw std::invalid_argument(
            "LASECSIMUL_NETWORK_MODE must be 'disabled', 'lab-bridge' or 'isolated'");
    }

    // Rede e' opt-in. O adapter descreve apenas CPU/maquina/flash; assim um Blink sem rede
    // chega ao QEMU sem -nic, sem OpenETH, sem thread/socket e com o mesmo mapa MMIO do caminho
    // historico. Nao se tenta inferir CONFIG_ETH_USE_OPENETH inspecionando o .bin: esse simbolo
    // de compilacao nao faz parte de uma imagem merged e a heuristica seria instavel.
    if (mode == "disabled") {
        spec.diagnostics = "[LasecSimul] network=disabled; no NIC/backend will be created\n";
        return;
    }

    spec.args.push_back("-nic");
    spec.args.push_back(mode == "lab-bridge" ? labBridgeOpenEthArgument(arenaName)
                                               : isolatedOpenEthArgument(arenaName));
    spec.diagnostics = "[LasecSimul] network=" + mode + "; OpenETH backend enabled\n";
}

} // namespace

McuController::McuController(const IMcuAdapter& adapter, std::string qemuBinaryOverride)
    : m_adapter(adapter), m_qemuBinaryOverride(std::move(qemuBinaryOverride)) {
    m_arenaBridge.setMemoryRegions(m_adapter.memoryRegions());
}

QemuLaunchSpec McuController::buildLaunchSpec(const std::filesystem::path& firmwarePath,
                                               const std::string& arenaName,
                                               const std::string& callSiteBinaryOverride,
                                               McuDebugOptions debug) const {
    QemuLaunchSpec spec = m_adapter.buildLaunchArgs(firmwarePath.string());
    configureNetwork(spec, arenaName);
    const std::string& overridePath = !callSiteBinaryOverride.empty() ? callSiteBinaryOverride : m_qemuBinaryOverride;
    if (!overridePath.empty()) spec.binary = overridePath;
    if (debug.enabled()) {
        if (debug.startPaused) spec.args.push_back("-S");
        spec.args.push_back("-gdb");
        spec.args.push_back("tcp:127.0.0.1:" + std::to_string(debug.gdbPort));
    }
    // O fork consome a chave da arena como argv[1], antes dos argumentos normais do QEMU.
    spec.args.insert(spec.args.begin(), arenaName);
    return spec;
}

void McuController::start(const std::filesystem::path& firmwarePath, const std::string& arenaName,
                          const std::string& callSiteBinaryOverride, McuDebugOptions debug) {
    QemuLaunchSpec spec = buildLaunchSpec(
        firmwarePath, arenaName, callSiteBinaryOverride, debug);
    // O backend socket legado do QEMU encerra qemu_init() quando connect() recebe ECONNREFUSED.
    // Detecte antes de criar a CPU e degrade para SLIRP: firmware OpenETH continua tendo a mesma
    // NIC/MMIO, enquanto um gateway/TAP ausente nunca derruba GPIO, timers ou o processo inteiro.
    if (environmentValue("LASECSIMUL_NETWORK_MODE", "disabled") == "lab-bridge" &&
        !gatewayAcceptingConnections(configuredGatewayPort())) {
        for (std::string& arg : spec.args) {
            if (arg.find("socket,model=open_eth") != std::string::npos) {
                arg = isolatedOpenEthArgument(arenaName);
                spec.diagnostics +=
                    "[LasecSimul] warning: lab gateway unavailable; falling back to isolated SLIRP\n";
                break;
            }
        }
    }
    m_arenaBridge.open(qemu::QemuArenaOpenOptions{arenaName, true});
    m_processManager.start(spec);
}

void McuController::stop() { m_processManager.stop(); m_arenaBridge.close(); }
bool McuController::isRunning() const { return m_processManager.isRunning(); }
std::string McuController::qemuLogs() const { return m_processManager.logs(); }

} // namespace lasecsimul::mcu
