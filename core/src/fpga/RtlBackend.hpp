#pragma once

#include <cstdint>
#include <span>
#include <string>
#include <vector>

#include "fpga/GhdlArenaTypes.hpp"

namespace lasecsimul::fpga {

struct RtlCompileRequest {
    std::vector<std::string> sources; // ordem explícita (MVP -- ver plano, seção 24, resolução automática fica pra depois)
    std::string topEntity;
    std::string standard = "08"; // "87"|"93"|"02"|"08" -- só "08" testado contra GHDL real até agora
    uint32_t inputBitCount = 0; // dimensiona a arena -- ver GhdlArenaOpenOptions
    uint32_t outputBitCount = 0;
};

struct RtlCompileResult {
    bool ok = false;
    std::string log; // saída combinada do compilador -- fonte do parser de diagnostics (Step 8)
};

/** Seam de backend pedido explicitamente pelo plano FPGA (`.claude/plans/golden-puzzling-quasar.md`,
 * seção "Backend FPGA genérico") -- um único backend real existe hoje (`GhdlBackend`), mas a
 * interface evita acoplar `FpgaController`/`FpgaComponent` a GHDL especificamente, deixando espaço
 * pra Verilator/CXXRTL futuros sem reescrever o resto da pilha (não implementados agora -- plano,
 * seção "Evolução futura"). */
class RtlBackend {
public:
    virtual ~RtlBackend() = default;

    virtual RtlCompileResult compile(const RtlCompileRequest& request) = 0;

    virtual void start() = 0;
    virtual void stop() = 0;
    virtual bool isRunning() const = 0;
    virtual bool peerReady() const = 0;

    /** Não bloqueia -- publica o comando e retorna. Ver `GhdlArenaBridge::requestAdvanceTo`. */
    virtual void requestAdvanceTo(uint64_t targetNs, std::span<const GhdlChangeEntry> inputs) = 0;
    /** Não bloqueia -- só observa se a rodada já terminou. Quem decide ESPERAR com timeout é
     * `FpgaComponent`, não o backend (mesma separação de `GhdlArenaBridge::pollReply`). */
    virtual GhdlAdvanceReply pollReply() = 0;

    virtual std::string logs() const = 0;
};

} // namespace lasecsimul::fpga
