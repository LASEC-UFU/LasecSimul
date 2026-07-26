#pragma once

#include "QemuArenaTypes.hpp"
#include <memory>
#include <span>
#include <vector>

namespace lasecsimul::mcu::qemu {

class QemuArenaBridge {
public:
    QemuArenaBridge();
    ~QemuArenaBridge();

    QemuArenaBridge(const QemuArenaBridge&) = delete;
    QemuArenaBridge& operator=(const QemuArenaBridge&) = delete;

    void setMemoryRegions(std::span<const MemoryRegion> regions);
    void open(const QemuArenaOpenOptions& options);
    void close();
    bool isOpen() const;

    LsdnQemuArena* arena();
    const LsdnQemuArena* arena() const;
    const LsdnQemuArenaDescriptor* descriptor() const;
    uint32_t protocolMajor() const;
    uint64_t negotiatedCapabilities() const;
    bool peerReady() const;

    /** Resolve Environment usando LASECSIMUL_QEMU_ARENA_VERSION. V4 é o padrão; V3 é rollback. */
    static QemuArenaProtocol configuredProtocol();

    /** Lê o próximo evento pendente -- PERF-13 (protocolo v3, ver qemu_arena_abi.h): primeiro a
     * fila de escritas/heartbeat (`queueReadIndex != queueWriteIndex`), senão o slot único de
     * leitura (`simuTime != 0`) -- e já resolve o módulo dono de `regAddr` via
     * `setMemoryRegions()`. NÃO confirma a ação (nunca avança `queueReadIndex`/zera `simuTime`/
     * seta `qemuAction`, mesmo em SIM_READ); quem chama decide isso via
     * `acknowledgeRead()`/`acknowledgeWrite()` depois de repassar pro módulo certo (ver
     * McuComponent::stamp()). */
    QemuPollResult poll();
    QemuDispatchResult dispatch(uint64_t address) const;

    /** Confirma uma ação da FILA (SIM_WRITE/SIM_EVENT/qualquer ação sem retorno) -- avança
     * `queueReadIndex`, liberando um slot pro QEMU publicar a próxima entrada (protocolo v3). */
    void acknowledgeWrite();

    /** Confirma uma ação SIM_READ: grava `regData` (valor lido) E seta `qemuAction = SIM_READ`
     * -- é isso que desbloqueia o `readReg()` do lado QEMU (que espera `qemuAction`, não
     * `simuTime`) -- depois zera `simuTime` como qualquer outra ação. */
    void acknowledgeRead(uint64_t regData);
    /** Confirma um evento sem resposta que veio do slot único legado (ex.: SIM_FREQ em QEMUs
     * anteriores ao protocolo v3), sem tocar queueReadIndex. */
    void acknowledgeEventSlot();

private:
    class SharedMemory;

    std::unique_ptr<SharedMemory> m_sharedMemory;
    LsdnQemuArena* m_arena = nullptr;
    LsdnQemuArenaDescriptor* m_descriptor = nullptr;
    QemuArenaProtocol m_protocol = QemuArenaProtocol::Environment;
    std::vector<MemoryRegion> m_regions;
};

} // namespace lasecsimul::mcu::qemu
