#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "lasecsimul/LogicValue.hpp"
#include "lasecsimul/fpga_arena_abi.h"

namespace lasecsimul::fpga {

struct GhdlArenaOpenOptions {
    std::string name;
    bool createIfMissing = true;
    /** Ignorados quando `createIfMissing=false` -- lidos do descriptor já existente. Mesma
     * disciplina de "quem cria decide" do QemuArenaBridge: o Core sempre cria a arena ANTES de o
     * processo GHDL poder abri-la (ver FpgaController), então essas capacidades vêm sempre de
     * `FpgaPortMapper` (contagem real de bits de entrada/saída do componente), nunca um número
     * arbitrário copiado do QEMU. */
    uint32_t inputChangeCapacity = 64;
    uint32_t outputChangeCapacity = 64;
};

struct GhdlChangeEntry {
    uint32_t portIndex = 0;
    uint32_t bitIndex = 0;
    LogicValue value = LogicValue::X;
};

struct GhdlAdvanceReply {
    /** `false` enquanto `replySeq != commandSeq` -- ainda não terminou de processar a rodada.
     * `pollReply()` NUNCA bloqueia; quem decide esperar (com timeout/watchdog) é FpgaComponent. */
    bool ready = false;
    LsdnFpgaState state = LSDN_FPGA_STATE_NOT_STARTED;
    uint64_t reachedTimeNs = 0;
    std::vector<GhdlChangeEntry> outputChanges;
    /** GHDL tentou reportar mais mudanças do que a capacidade negociada permite -- quando true,
     * `outputChanges` fica vazio de propósito (rodada inválida, nunca dados parciais). */
    bool overflow = false;
};

struct GhdlLogMessage {
    LsdnFpgaLogSeverity severity = LSDN_FPGA_LOG_INFO;
    uint64_t timeNs = 0;
    std::string message;
};

} // namespace lasecsimul::fpga
