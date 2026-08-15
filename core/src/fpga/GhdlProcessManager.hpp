#pragma once

#include <chrono>
#include <memory>
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

private:
    class Impl;
    std::unique_ptr<Impl> m_impl;
};

} // namespace lasecsimul::fpga
