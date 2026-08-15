#pragma once

#include <chrono>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace lasecsimul::fpga {

/** Espelha `lasecsimul::QemuLaunchSpec` (Types.hpp) campo a campo -- não reaproveitado
 * diretamente de propósito: aquele tipo se chama "Qemu" e vive num header genérico só porque
 * McuController/QemuProcessManager o usam de vários lugares; renomeá-lo pra algo neutro seria
 * mexer em código MCU/QEMU já testado em produção sem necessidade (ver GhdlProcessManager.cpp e
 * o plano FPGA, `.claude/plans/golden-puzzling-quasar.md`, sobre por que este arquivo é uma
 * implementação independente, não uma base compartilhada com QemuProcessManager). */
struct GhdlLaunchSpec {
    std::string binary;
    std::vector<std::string> args;
    std::string diagnostics;
    /** `ghdl -a`/`-e`/`-r` leem/escrevem arquivos de biblioteca (`work-obj08.cf`) no diretório de
     * trabalho do processo -- vazio significa "herda o cwd do Core" (comportamento anterior a
     * este campo). GhdlBackend (compile/cache) usa isto pra apontar cada projeto pro seu próprio
     * diretório dentro de `.lasecsimul/fpga-cache/`, sem misturar work-obj08.cf de dois projetos
     * diferentes nem sujar o cwd do Core. */
    std::string workingDirectory;
    /** GHDL não repassa argv extra pro módulo VPI carregado via `--vpi=` -- variável de ambiente é
     * o mecanismo real (mesma convenção usada por cocotb pra configurar seus próprios módulos
     * VPI/FLI). `lasecsimul_vpi.c` lê `LASECSIMUL_FPGA_MODE`/`LASECSIMUL_FPGA_ARENA_NAME` daqui.
     * QemuLaunchSpec não precisa disto porque QEMU recebe o nome da arena via argv[1]
     * (McuController::buildLaunchSpec) -- não copiado aqui de propósito, GHDL não tem um lugar
     * equivalente pra receber argv customizado. */
    std::vector<std::pair<std::string, std::string>> environmentOverrides;
};

/** Processo GHDL (`ghdl -r ... --vpi=...`) controlado pelo Core -- mesmo padrão comprovado de
 * `mcu::qemu::QemuProcessManager` (Job Object no Windows pra nunca deixar o processo órfão
 * sobreviver ao Core, captura de log via pipe com teto de memória, reap com timeout que ABANDONA
 * a limpeza em vez de travar o chamador pra sempre se o processo não morrer), reimplementado aqui
 * em vez de generalizado numa base comum -- só dois usuários existiriam (QEMU e GHDL), e
 * QemuProcessManager é código de produção já testado extensivamente; extrair uma abstração agora
 * arriscaria regressão ali sem necessidade real. */
class GhdlProcessManager {
public:
    GhdlProcessManager();
    ~GhdlProcessManager();

    GhdlProcessManager(const GhdlProcessManager&) = delete;
    GhdlProcessManager& operator=(const GhdlProcessManager&) = delete;

    void start(const GhdlLaunchSpec& spec);
    bool stop(std::chrono::milliseconds timeout = std::chrono::milliseconds(1000));
    void kill();
    bool isRunning() const;
    std::string logs() const;

    /** Espera o processo terminar SOZINHO (nunca força) até `timeout`, devolve o código de saída
     * se terminou a tempo -- `std::nullopt` se ainda estava rodando quando o timeout venceu (quem
     * chama decide: `kill()` pra abortar, ou esperar mais). Pra comandos "rode até completar"
     * (`ghdl -a`/`-e`, ver GhdlBackend::compile), onde sucesso/falha É o código de saída --
     * diferente de `stop()`/`kill()`, que são pra processos de vida longa (`ghdl -r`) que
     * precisam ser INTERROMPIDOS, não esperados. */
    std::optional<int> waitForExit(std::chrono::milliseconds timeout);

private:
    class Impl;
    std::unique_ptr<Impl> m_impl;
};

} // namespace lasecsimul::fpga
