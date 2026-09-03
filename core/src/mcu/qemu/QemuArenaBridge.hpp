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

    /** Resolve Environment usando LASECSIMUL_QEMU_ARENA_VERSION. V5 é o padrão; V3 é rollback. */
    static QemuArenaProtocol configuredProtocol();

    /** Lê o próximo evento pendente -- PERF-13 (protocolo v3, ver qemu_arena_abi.h): primeiro a
     * fila de escritas/heartbeat (`queueReadIndex != queueWriteIndex`), senão o slot único de
     * leitura (`simuTime != 0`) -- e já resolve o módulo dono de `regAddr` via
     * `setMemoryRegions()`. NÃO confirma a ação (nunca avança `queueReadIndex`/zera `simuTime`/
     * seta `qemuAction`, mesmo em SIM_READ); quem chama decide isso via
     * `acknowledgeRead()`/`acknowledgeWrite()` depois de repassar pro módulo certo (ver
     * McuComponent::stamp()). */
    QemuPollResult poll();
    std::optional<QemuI2cBurst> pollI2cBurst() const;
    static uint64_t qpcNow() noexcept;
    uint64_t completeI2cBurst(uint64_t sequence, uint32_t status, uint32_t firstNack,
                              std::span<const uint8_t> rx, uint64_t stretchNs);
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

    /** D2 STAGE 1 (2026-08-29, SHADOW/OBSERVATION ONLY -- see coreProgressNs's doc-comment in
     * qemu_arena_abi.h for the full semantic). Publishes `max(nowNs, 1)` -- never literal 0 --
     * via a release store, so 0 stays an unambiguous "not published yet this execution" sentinel
     * on the reading side. No-op if the arena isn't open. Increments a bounded, Core-local
     * publish counter (see publishCountForTesting()) -- no per-call I/O, no new thread/timer.
     * STAGE 1B: internally rate-gated (>=1ms virtual progress OR >=5ms host-time heartbeat) using
     * only a cheap std::chrono::steady_clock read -- callers may call this unconditionally every
     * poll iteration; the value written, when it is written, is always the real current nowNs. */
    void publishCoreProgress(uint64_t nowNs);
    uint64_t publishCountForTesting() const { return m_publishCount; }

private:
    class SharedMemory;

    std::unique_ptr<SharedMemory> m_sharedMemory;
    LsdnQemuArena* m_arena = nullptr;
    LsdnQemuArenaDescriptor* m_descriptor = nullptr;
    QemuArenaProtocol m_protocol = QemuArenaProtocol::Environment;
    std::vector<MemoryRegion> m_regions;
    uint64_t m_publishCount = 0;
    uint64_t m_lastPublishedProgressNs = 0;  // D2 STAGE 1B: last virtual nowNs actually published
    uint64_t m_lastPublishHostNs = 0;        // D2 STAGE 1B: host time (steady_clock ns) of that publish
};

} // namespace lasecsimul::mcu::qemu
