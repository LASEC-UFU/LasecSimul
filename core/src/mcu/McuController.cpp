#include "McuController.hpp"

namespace lasecsimul::mcu {

McuController::McuController(const IMcuAdapter& adapter, std::string qemuBinaryOverride)
    : m_adapter(adapter), m_qemuBinaryOverride(std::move(qemuBinaryOverride)) {
    m_arenaBridge.setMemoryRegions(m_adapter.memoryRegions());
}

QemuLaunchSpec McuController::buildLaunchSpec(const std::filesystem::path& firmwarePath,
                                               const std::string& arenaName,
                                               const std::string& callSiteBinaryOverride,
                                               McuDebugOptions debug) const {
    QemuLaunchSpec spec = m_adapter.buildLaunchArgs(firmwarePath.string());
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
