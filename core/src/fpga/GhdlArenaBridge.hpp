#pragma once

#include <cstdint>
#include <memory>
#include <optional>
#include <span>

#include "fpga/GhdlArenaTypes.hpp"

namespace lasecsimul::fpga {

/** Transporte de memória compartilhada Core <-> processo GHDL (via `lasecsimul_vpi`), mesmo
 * padrão comprovado de `mcu::qemu::QemuArenaBridge` (descriptor versionado, handshake
 * coreReady/peerReady, capacidades negociadas) mas com um protocolo DIFERENTE de propósito --
 * request/reply síncrono (`ADVANCE_TO`/`TIME_REACHED`), não a fila circular assíncrona do QEMU --
 * porque GHDL é um participante COMANDADO pelo Scheduler, não um processo livre precisando ser
 * "puxado" de volta. Ver `fpga_arena_abi.h` pro protocolo completo e o porquê da diferença. */
class GhdlArenaBridge {
public:
    GhdlArenaBridge();
    ~GhdlArenaBridge();

    GhdlArenaBridge(const GhdlArenaBridge&) = delete;
    GhdlArenaBridge& operator=(const GhdlArenaBridge&) = delete;

    void open(const GhdlArenaOpenOptions& options);
    void close();
    bool isOpen() const;

    LsdnFpgaArenaTransport* transport();
    const LsdnFpgaArenaTransport* transport() const;
    const LsdnFpgaArenaDescriptor* descriptor() const;
    uint32_t inputChangeCapacity() const;
    uint32_t outputChangeCapacity() const;
    uint64_t negotiatedCapabilities() const;
    bool peerReady() const;
    LsdnFpgaState state() const;

    /** Core -> GHDL: publica `ADVANCE_TO(targetNs)` com as mudanças de entrada desta rodada.
     * `inputs.size()` não pode exceder `inputChangeCapacity()` -- lança em vez de truncar (erro
     * de chamada do FpgaComponent, não condição de corrida esperada: a capacidade é fixada no
     * `open()` a partir da contagem real de bits do componente). */
    void requestAdvanceTo(uint64_t targetNs, std::span<const GhdlChangeEntry> inputs);
    void requestReset();
    void requestStop();

    /** Não bloqueia -- só observa se `replySeq==commandSeq` já aconteceu (mesma separação de
     * responsabilidade de `QemuArenaBridge::poll()`: quem decide ESPERAR com timeout/watchdog é
     * FpgaComponent, não esta classe). */
    GhdlAdvanceReply pollReply() const;

    std::optional<GhdlLogMessage> pollLog();
    void acknowledgeLog();

private:
    class SharedMemory;

    void mapPointers();

    std::unique_ptr<SharedMemory> m_sharedMemory;
    LsdnFpgaArenaDescriptor* m_descriptor = nullptr;
    LsdnFpgaArenaTransport* m_transport = nullptr;
    LsdnFpgaChangeEntry* m_inputChanges = nullptr;
    LsdnFpgaChangeEntry* m_outputChanges = nullptr;
    uint32_t m_inputCapacity = 0;
    uint32_t m_outputCapacity = 0;
};

} // namespace lasecsimul::fpga
