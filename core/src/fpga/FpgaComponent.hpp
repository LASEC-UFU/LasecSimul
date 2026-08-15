#pragma once

#include <chrono>
#include <cstdint>
#include <memory>
#include <span>
#include <vector>

#include "fpga/FpgaController.hpp"
#include "fpga/FpgaPortMapper.hpp"
#include "lasecsimul/IComponentModel.hpp"
#include "lasecsimul/LogicValue.hpp"
#include "simulation/Scheduler.hpp"

namespace lasecsimul::fpga {

struct FpgaComponentConfig {
    std::vector<PortSpec> ports;
    /** Fontes/top/standard -- guardados aqui (não só passados na hora de `start()`) pra
     * `runFpga`/`restartFpga` (Step 6, IPC) poderem operar só com um `componentIndex`, sem o
     * chamador precisar reenviar a configuração VHDL inteira a cada Run. `setSources()` atualiza
     * isto depois de criado (verbo `setFpgaConfig`). */
    std::vector<std::string> sources;
    std::string topEntity;
    std::string standard = "08";
    /** Tensão lógica "alta" usada por `toVoltageStamp()` -- 3.3V como default (mesma convenção já
     * adotada por McuComponent pra lógica moderna; SEM propriedade editável em runtime nesta
     * passada, ver Step 6/7 pra expor via PropertyDescriptor). */
    double vcc = 3.3;
    /** Quanto esperar por TIME_REACHED antes de declarar o backend `Faulted` -- ver plano, Caso E
     * (crash/hang do GHDL nunca pode travar o Core). Generoso de propósito: uma simulação VHDL
     * pesada é mais lenta que um round-trip QEMU típico, e isto bloqueia a thread worker do
     * Scheduler inteira por design (lockstep). */
    std::chrono::milliseconds advanceTimeout{5000};
};

/**
 * Bridge entre `RtlBackend`/`FpgaController` (processo GHDL comandado) e `IComponentModel` (entra
 * no Netlist/Scheduler como qualquer componente elétrico, com pinos de verdade fiáveis) -- mesmo
 * papel estrutural de `McuComponent`, mas SEM o padrão de thread de poll em segundo plano +
 * chamada adiada pro Scheduler que `McuComponent` precisa: aquele padrão existe especificamente
 * pra sobreviver ao QEMU rodando livre/assíncrono. GHDL é COMANDADO (ver plano,
 * ".claude/plans/golden-puzzling-quasar.md", "GHDL é um participante comandado, não assíncrono")
 * -- todo o round-trip acontece de forma síncrona dentro de `advanceLockstep()`, chamado pela
 * própria thread worker do Scheduler (via `TimeStepBeginFn`, ver SimulationSession.cpp), nunca
 * de uma thread separada. Isso elimina inteiramente a categoria de bug de lock-order que
 * `McuComponent` precisa documentar tão extensivamente.
 *
 * Fluxo por avanço real de tempo do Scheduler (nunca por iteração de settle):
 *   1. `advanceLockstep(previousNs, nextNs)` -- lê `m_currentValue` de cada pino de ENTRADA
 *      (atualizado pela ÚLTIMA `stamp()`, ver abaixo), calcula o diff contra o que já foi
 *      mandado, publica `ADVANCE_TO(nextNs)` via `FpgaController`, e BLOQUEIA (poll com timeout,
 *      nunca busy-wait sem limite) até `TIME_REACHED` ou timeout/crash.
 *   2. Aplica `OUTPUT_CHANGE` recebido em `m_currentValue` dos pinos de SAÍDA, marca dirty.
 *   3. `stamp()` (chamado pelo settle normal, na PRÓXIMA vez que o componente estiver dirty) lê
 *      tensão de cada pino de entrada (cacheando em `m_currentValue` pra o PRÓXIMO
 *      `advanceLockstep`) e crava eletricamente cada pino de saída com o valor já conhecido.
 */
class FpgaComponent final : public IComponentModel {
public:
    static constexpr uint32_t kNoIndex = 0xFFFFFFFFu;

    FpgaComponent(simulation::Scheduler& scheduler, std::unique_ptr<RtlBackend> backend, FpgaComponentConfig config);
    ~FpgaComponent() override;

    const char* typeId() const override { return "digital.generic_fpga"; }
    std::span<Pin> pins() override { return m_pins; }

    void onAssignedIndex(uint32_t index) override { m_componentIndex = index; }

    void stamp(MnaMatrixView& matrix) override;
    void postStep(uint64_t) override {}

    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}

    PluginHealthStatus health() const override { return m_health; }
    std::span<const uint32_t> leakagePinIndices() const override { return m_inputLocalIndices; }

    /** Compila (com cache, ver GhdlBackend) e inicia o processo GHDL, usando a configuração
     * (sources/top/standard) atual -- ver `setSources()`. Lança se `compile()` falhar (erro de
     * VHDL, ver plano Caso C; quem chama decide como reportar). Força reamostragem incondicional
     * de TODOS os pinos de entrada na próxima `advanceLockstep` (plano, "Initial-input
     * correctness": uma entrada já em nível alto ANTES do FPGA iniciar não pode ser perdida). */
    void start();
    void stop();
    void restart();

    /** Atualiza sources/top/standard pra uso no PRÓXIMO `start()`/`restart()` -- não afeta uma
     * simulação já rodando (verbo `setFpgaConfig`, Step 6). Contagem de bits de entrada/saída
     * (`ports`) permanece FIXA depois da criação nesta passada -- mudar o número de portas exige
     * recriar o componente (ver plano, `AffectsPinCount`; não coberto no Step 6, deixado pro
     * follow-up de Step 7). */
    void setSources(std::vector<std::string> sources, std::string topEntity, std::string standard);

    /** Chamado por `SimulationSession`'s `TimeStepBeginFn`, uma vez por avanço REAL do Scheduler
     * (`m_nowNs` mudando de `previousNs` pra `nextNs`) -- nunca por iteração de settle/Newton. Ver
     * docstring da classe. No-op silencioso se o backend não estiver rodando (componente ainda não
     * iniciado, ou já `Faulted`). */
    void advanceLockstep(uint64_t previousNs, uint64_t nextNs);

    FpgaController& controller() { return m_controller; }

private:
    void applyOutputChanges(std::span<const GhdlChangeEntry> changes);

    simulation::Scheduler& m_scheduler;
    FpgaController m_controller;
    RtlCompileRequest m_compileRequest; // sources/topEntity/standard atuais -- ver setSources()
    std::vector<Pin> m_pins;
    std::vector<FpgaPinBit> m_pinBits; // mesma ordem/tamanho de m_pins
    std::vector<uint32_t> m_inputLocalIndices; // leakagePinIndices() -- só pinos de entrada
    /** Indexado pela MESMA posição de `m_pins`/`m_pinBits` -- pra pino de entrada, é o último
     * valor lido via `matrix.getNodeVoltage()`; pra pino de saída, é o último valor recebido do
     * GHDL. Um pino nunca é os dois, então um array serve pros dois papéis sem união/variant. */
    std::vector<LogicValue> m_currentValue;
    /** Só significativo pra pinos de entrada -- último valor efetivamente mandado ao GHDL, pra
     * `advanceLockstep` só publicar o DIFF, exceto quando `m_forceFullInputResend` está ligado. */
    std::vector<LogicValue> m_lastSentToGhdl;
    double m_vcc;
    std::chrono::milliseconds m_advanceTimeout;
    uint32_t m_componentIndex = kNoIndex;
    bool m_forceFullInputResend = true;
    PluginHealthStatus m_health = PluginHealthStatus::Ok;
};

} // namespace lasecsimul::fpga
