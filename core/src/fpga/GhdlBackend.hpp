#pragma once

#include <chrono>
#include <cstdint>
#include <span>
#include <string>
#include <vector>

#include "fpga/FpgaPortMapper.hpp"
#include "fpga/GhdlArenaBridge.hpp"
#include "fpga/GhdlProcessManager.hpp"
#include "fpga/RtlBackend.hpp"

namespace lasecsimul::fpga {

struct GhdlBackendOptions {
    /** Caminho resolvido do binário `ghdl` -- resolução real (setting `lasecsimul.fpga.ghdlPath`
     * vs PATH vs erro claro) é responsabilidade da Extension (Step 8), repassada aqui já pronta. */
    std::string ghdlBinary = "ghdl";
    /** Caminho do `lasecsimul_vpi.dll`/`.so` já construído (`npm run build:fpga-vpi`). */
    std::string vpiModulePath;
    /** Raiz do cache de compilação (`.lasecsimul/fpga-cache/` do projeto, ver plano seção 23) --
     * cada combinação (fontes+top+standard) ganha seu próprio subdiretório, nunca reusa
     * `work-obj08.cf` de uma combinação diferente. */
    std::string cacheRootDir;
    /** Timeout de cada etapa de `ghdl -a`/`-e` (compile, não simulação). */
    std::chrono::milliseconds compileTimeout{30000};
};

/** Implementação `RtlBackend` pra GHDL -- `compile()` roda `ghdl -a`/`-e` com cache por hash
 * (SHA-256 do conteúdo das fontes + top + standard, ver plano seção 23: nunca versiona artefato
 * compilado, sempre fora do diretório de fontes do usuário); `start()` spawna `ghdl -r
 * ... --vpi=lasecsimul_vpi` com `LASECSIMUL_FPGA_MODE=run`/`LASECSIMUL_FPGA_ARENA_NAME` (ver
 * lasecsimul_vpi.c) depois de criar a arena via `GhdlArenaBridge` (Core sempre cria antes do
 * processo poder abrir, mesma disciplina de McuController/QemuArenaBridge). Sequência de
 * invocação (`-a --std=08`, depois `-e --std=08 --time-resolution=ns`, depois `-r --std=08
 * --vpi=...`) e o PATH incluindo `ghdl --vpi-library-dir` (pra `libghdlvpi.dll` ser encontrada
 * pelo processo GHDL) são exatamente o que `GhdlLockstepRealGhdlTest` (Step 4) provou funcionar
 * contra GHDL real -- não reinventados aqui, só reempacotados atrás de uma API estável. */
class GhdlBackend final : public RtlBackend {
public:
    explicit GhdlBackend(GhdlBackendOptions options);
    ~GhdlBackend() override;

    GhdlBackend(const GhdlBackend&) = delete;
    GhdlBackend& operator=(const GhdlBackend&) = delete;

    RtlCompileResult compile(const RtlCompileRequest& request) override;

    /** Roda `ghdl -r ... --vpi=lasecsimul_vpi` em modo "discover" (env `LASECSIMUL_FPGA_MODE=
     * discover`, ver lasecsimul_vpi.c) -- sem arena, só descobre as portas da entity e termina.
     * Exige `compile()` bem-sucedido antes (usa o mesmo `m_cacheDir`/top/standard). Mecanismo real
     * de "LasecSimul: Analyze VHDL" (plano seção 13/17) -- reusa 100% da infra de processo/VPI, sem
     * parser VHDL próprio. */
    std::vector<PortSpec> discoverPorts();

    void start() override;
    void stop() override;
    bool isRunning() const override;
    bool peerReady() const override;

    void requestAdvanceTo(uint64_t targetNs, std::span<const GhdlChangeEntry> inputs) override;
    GhdlAdvanceReply pollReply() override;

    std::string logs() const override;

private:
    std::string computeCacheKey(const RtlCompileRequest& request) const;
    std::string resolveVpiLibraryDir() const;

    GhdlBackendOptions m_options;
    GhdlProcessManager m_process;
    GhdlArenaBridge m_arena;

    RtlCompileRequest m_compiledRequest; // última compilação bem-sucedida -- start() precisa do topEntity/cache dir
    std::string m_cacheDir;
    bool m_compiled = false;
};

} // namespace lasecsimul::fpga
