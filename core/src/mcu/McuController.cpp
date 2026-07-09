#include "McuController.hpp"

namespace lasecsimul::mcu {

McuController::McuController(const IMcuAdapter& adapter, std::string qemuBinaryOverride)
    : m_adapter(adapter), m_qemuBinaryOverride(std::move(qemuBinaryOverride)) {
    m_arenaBridge.setMemoryRegions(m_adapter.memoryRegions());
}

void McuController::start(const std::filesystem::path& firmwarePath, const std::string& arenaName,
                           const std::string& callSiteBinaryOverride) {
    QemuLaunchSpec spec = m_adapter.buildLaunchArgs(firmwarePath.string());
    const std::string& effectiveOverride = !callSiteBinaryOverride.empty() ? callSiteBinaryOverride : m_qemuBinaryOverride;
    if (!effectiveOverride.empty()) spec.binary = effectiveOverride;

    // argv[1] do processo = chave da shared memory, confirmado lendo simuMain() em
    // simuliface.c (C:\SourceCode\qemu_simulide): `shMemKey = argv[1]; argv = &argv[2];` -- o
    // resto de spec.args (já incluindo o argv[0] convencional "qemu-system-xtensa" que o adapter
    // monta) segue intacto pro qemu_init(). McuController decide o NOME da arena (não o
    // adapter), então é aqui que ela entra na lista, sempre na frente.
    spec.args.insert(spec.args.begin(), arenaName);

    // Core cria a arena ANTES de iniciar o processo -- QEMU só pode abrir uma região já existente
    // (ver qemu_arena_abi.h e QemuArenaBridge::open/createIfMissing).
    m_arenaBridge.open(qemu::QemuArenaOpenOptions{arenaName, true});
    m_processManager.start(spec);
}

void McuController::stop() {
    m_processManager.stop();
    m_arenaBridge.close();
}

bool McuController::isRunning() const { return m_processManager.isRunning(); }
std::string McuController::qemuLogs() const { return m_processManager.logs(); }

} // namespace lasecsimul::mcu
