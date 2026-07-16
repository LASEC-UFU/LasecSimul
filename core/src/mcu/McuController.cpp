#include "McuController.hpp"

#include <charconv>
#include <cstdlib>
#include <iomanip>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string_view>

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

std::string openEthMacAddress(unsigned networkNamespace, unsigned componentSlot) {
    std::ostringstream mac;
    mac << std::hex << std::setfill('0')
        << "02:4c:53:" << std::setw(2) << networkNamespace
        << ':' << std::setw(2) << componentSlot << ":01";
    return mac.str();
}

std::string isolatedOpenEthArgument(std::string_view arenaName) {
    const unsigned networkNamespace = configuredNetworkNamespace().value_or(
        automaticNetworkNamespace(arenaName));
    const unsigned componentSlot = componentNetworkSlot(arenaName);
    const std::string prefix = "10." + std::to_string(networkNamespace) + "." +
                               std::to_string(componentSlot);
    return "user,model=open_eth,mac=" + openEthMacAddress(networkNamespace, componentSlot) +
           ",net=" + prefix + ".0/24,host=" + prefix +
           ".2,dhcpstart=" + prefix + ".15,dns=" + prefix + ".3";
}

std::string environmentValue(const char* name, std::string_view fallback) {
    const char* value = std::getenv(name);
    return value && *value ? std::string(value) : std::string(fallback);
}

void replaceAll(std::string& value, std::string_view token, std::string_view replacement) {
    size_t position = 0;
    while ((position = value.find(token, position)) != std::string::npos) {
        value.replace(position, token.size(), replacement);
        position += replacement.size();
    }
}

std::string labBridgeOpenEthArgument(std::string_view arenaName) {
    const unsigned networkNamespace = configuredNetworkNamespace().value_or(
        automaticNetworkNamespace(arenaName));
    const unsigned componentSlot = componentNetworkSlot(arenaName);
    std::string interfaceName = environmentValue(
        "LASECSIMUL_TAP_INTERFACE", "LasecSimul TAP {namespace}-{instance}");
    replaceAll(interfaceName, "{namespace}", std::to_string(networkNamespace));
    replaceAll(interfaceName, "{instance}", std::to_string(componentSlot));
    if (interfaceName.empty() || interfaceName.find_first_of(",\r\n") != std::string::npos) {
        throw std::invalid_argument(
            "LASECSIMUL_TAP_INTERFACE must name one TAP interface and cannot contain commas/newlines");
    }

    std::string argument = "tap,model=open_eth,mac=" +
                           openEthMacAddress(networkNamespace, componentSlot) +
                           ",ifname=" + interfaceName;
#ifndef _WIN32
    argument += ",script=no,downscript=no";
#endif
    return argument;
}

void configureNetwork(QemuLaunchSpec& spec, std::string_view arenaName) {
    const std::string mode = environmentValue("LASECSIMUL_NETWORK_MODE", "lab-bridge");
    if (mode != "lab-bridge" && mode != "isolated") {
        throw std::invalid_argument(
            "LASECSIMUL_NETWORK_MODE must be 'lab-bridge' or 'isolated'");
    }
    for (std::string& arg : spec.args) {
        if (arg.find("model=open_eth") != std::string::npos) {
            arg = mode == "lab-bridge" ? labBridgeOpenEthArgument(arenaName)
                                        : isolatedOpenEthArgument(arenaName);
        }
    }
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
    const QemuLaunchSpec spec = buildLaunchSpec(firmwarePath, arenaName, callSiteBinaryOverride, debug);
    m_arenaBridge.open(qemu::QemuArenaOpenOptions{arenaName, true});
    m_processManager.start(spec);
}

void McuController::stop() { m_processManager.stop(); m_arenaBridge.close(); }
bool McuController::isRunning() const { return m_processManager.isRunning(); }
std::string McuController::qemuLogs() const { return m_processManager.logs(); }

} // namespace lasecsimul::mcu
