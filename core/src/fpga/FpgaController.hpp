#pragma once

#include <memory>
#include <span>
#include <string>

#include "fpga/RtlBackend.hpp"

namespace lasecsimul::fpga {

/** Orquestrador fino em cima de `RtlBackend` -- mesmo papel de `McuController` em cima de
 * `QemuProcessManager`+`QemuArenaBridge`, mas bem mais simples: `RtlBackend` já expõe tudo que
 * `FpgaComponent` precisa (compile/start/stop/advance/logs), então esta classe só possui o
 * backend e repassa chamadas, adicionando `restart()` (stop+start, ver plano seção 15 "Reset da
 * instância FPGA"). O valor real desta camada é a INDIREÇÃO (permite trocar de backend sem tocar
 * `FpgaComponent`), não lógica nova -- deliberadamente fino, sem generalizar além do que o plano
 * pediu. */
class FpgaController {
public:
    explicit FpgaController(std::unique_ptr<RtlBackend> backend) : m_backend(std::move(backend)) {}

    RtlCompileResult compile(const RtlCompileRequest& request) { return m_backend->compile(request); }

    void start() { m_backend->start(); }
    void stop() { m_backend->stop(); }
    /** Para+relança -- limpa estado do processo GHDL e reaplica entradas do zero (plano seção 15:
     * "Restart FPGA" é uma ação administrativa distinta do reset de sinal VHDL). Quem chama
     * (FpgaComponent) é responsável por forçar reamostragem de entrada depois disto. */
    void restart() {
        stop();
        start();
    }

    bool isRunning() const { return m_backend->isRunning(); }
    bool peerReady() const { return m_backend->peerReady(); }

    void requestAdvanceTo(uint64_t targetNs, std::span<const GhdlChangeEntry> inputs) {
        m_backend->requestAdvanceTo(targetNs, inputs);
    }
    GhdlAdvanceReply pollReply() { return m_backend->pollReply(); }

    std::string logs() const { return m_backend->logs(); }

private:
    std::unique_ptr<RtlBackend> m_backend;
};

} // namespace lasecsimul::fpga
