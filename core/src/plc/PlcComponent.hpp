#pragma once

#include <memory>
#include <string>
#include <vector>

#include "lasecsimul/IComponentModel.hpp"
#include "PlcNativeModule.hpp"
#include "PlcRuntime.hpp"
#include "../simulation/SimulationPlan.hpp"

namespace lasecsimul::plc {

/** Pedido de ligação de um I/O do PLC a um bloco do Signal Engine (nesta rodada, ajustado via
 * `PlcComponent::setIoBindingRequests`, sem editor gráfico) -- resolvido/validado pelo
 * `PlanCompiler` (F9.5, `simulation::PlanCompileInput::plcInstances[].ioBindingRequests`) contra o
 * grafo do Signal Engine já compilado, nunca aqui. Reaproveita o tipo de
 * `simulation::PlcIoBindingRequest` diretamente (mesmo formato, só reexportado aqui pra quem já
 * inclui `PlcComponent.hpp` não precisar incluir `SimulationPlan.hpp` à parte). `ioId` é a
 * identidade estável (== `PlcExportedIo::ioId`, que nesta rodada é o nome da variável ST). */
using PlcIoBindingRequest = simulation::PlcIoBindingRequest;

/**
 * Componente do PLC (F9.5) -- ponte entre `PlcNativeModule`/`PlcRuntime` (F9.3/F9.4, já provados
 * isoladamente) e `IComponentModel` (entra no Netlist como qualquer outro componente, com pinos
 * reais ligáveis por fio -- mesmo papel que `McuComponent` cumpre pra QEMU, ver seu doc-comment).
 *
 * Pinos nesta rodada são placeholders de IDENTIDADE/conectividade (um `Pin{ioId}` por
 * `PlcNativeModule::exportedIo[]`), não participam da equação MNA (`stamp()` é no-op) -- a troca de
 * valor de verdade com o resto da simulação acontece pelo Signal Engine (`PlcIoBinding::signal`,
 * resolvido pelo `PlanCompiler`), a mesma dualidade "pino elétrico real + amarração a um bloco do
 * Signal Engine por string" que `ElectricalSignalBridgeDefinition`/`SignalVoltageSensor` etc. já
 * usam. Fazer um pino de PLC dirigir tensão real na matriz MNA diretamente fica pra quando a rodada
 * gráfica decidir como um bloco PLC deve se conectar fisicamente a um circuito -- não implementado
 * agora (ver plano F9, seção 8, rodadas futuras).
 *
 * O worker (`PlcRuntime`) é uma OWN member, criado/recriado por `loadArtifact()`, destruído
 * sincronamente no destrutor (mesmo padrão de `McuController::stop()` em `~McuComponent()`) -- a
 * remoção do componente (`SimulationSession::removeComponentUnlocked`, que já exige simulação
 * parada antes de rodar) garante que nenhuma outra thread está no meio de um `scan()` quando isso
 * acontece.
 */
class PlcComponent final : public IComponentModel {
public:
    explicit PlcComponent(PlcRuntimeOptions runtimeOptions = {}) : m_runtimeOptions(runtimeOptions) {}
    ~PlcComponent() override = default;

    const char* typeId() const override { return "plc.instance"; }
    std::span<Pin> pins() override { return m_pins; }

    void stamp(MnaMatrixView&) override {} // sem participação elétrica nesta rodada -- ver doc-comment acima.
    void postStep(uint64_t) override {}    // não usado -- scan é disparado pelo Scheduler via SimulationSession, não por postStep.

    /** `stamp()` nunca estampa nada -- sem isto, cada pino de PLC fica um nó totalmente flutuante
     * (nenhuma condutância, nem pra terra nem pra qualquer outro nó), o que deixa o grupo elétrico
     * daquele componente singular. O framework já resolve exatamente esse caso (LeakageGuard, ver
     * `SimulationSession.cpp`, D9/auditoria-2026-07-09): uma condutância de fuga minúscula pra
     * terra é somada DEPOIS de `stamp()` pra cada índice retornado aqui -- mesmo padrão que
     * `SignalDigitalInput::stamp()` já faz manualmente com `addConductance(..., 1e-12)`, só que via
     * o mecanismo genérico em vez de cada componente reimplementar. Sem isso, o solver via a matriz
     * cair num grupo singular a cada settle sem nunca estabilizar. */
    std::span<const uint32_t> leakagePinIndices() const override { return m_leakageIndices; }

    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}

    void onAssignedIndex(uint32_t index) override { m_componentIndex = index; }
    uint32_t componentIndex() const { return m_componentIndex; }

    /** Carrega um artefato compilado (F9.3) -- reconstrói `m_pins` a partir de
     * `module.exportedIo` (zero pinos se `module` for `nullopt`, exatamente `exportedIo.size()`
     * caso contrário) e (re)cria o `PlcRuntime`, descartando qualquer worker anterior. Chamado fora
     * do caminho de propriedades genérico (não há editor/IPC pra isso ainda nesta rodada) --
     * `SimulationSession::loadPlcArtifact` é quem invoca isto e cuida de
     * `reregisterPinsIfChanged`/`invalidatePlan`. */
    void loadArtifact(std::optional<PlcNativeModule> module) {
        m_runtime.reset();
        m_module = std::move(module);
        m_pins.clear();
        m_leakageIndices.clear();
        if (m_module) {
            m_pins.reserve(m_module->exportedIo.size());
            m_leakageIndices.reserve(m_module->exportedIo.size());
            for (uint32_t i = 0; i < m_module->exportedIo.size(); ++i) {
                m_pins.push_back(Pin{m_module->exportedIo[i].ioId, 0.0, 0.0});
                m_leakageIndices.push_back(i);
            }
            m_runtime = std::make_unique<PlcRuntime>(*m_module, m_runtimeOptions);
        }
    }

    void setIoBindingRequests(std::vector<PlcIoBindingRequest> requests) { m_ioBindingRequests = std::move(requests); }
    const std::vector<PlcIoBindingRequest>& ioBindingRequests() const { return m_ioBindingRequests; }

    void setTaskIntervalNs(uint64_t ns) { m_taskIntervalNs = ns; }
    uint64_t taskIntervalNs() const { return m_taskIntervalNs; }

    const std::optional<PlcNativeModule>& artifact() const { return m_module; }
    PlcRuntime* runtime() { return m_runtime.get(); }
    const PlcRuntime* runtime() const { return m_runtime.get(); }

private:
    uint32_t m_componentIndex = 0;
    std::vector<Pin> m_pins;
    std::vector<uint32_t> m_leakageIndices;
    std::optional<PlcNativeModule> m_module;
    std::vector<PlcIoBindingRequest> m_ioBindingRequests;
    uint64_t m_taskIntervalNs = 10'000'000; // 10ms -- default fixo desta rodada, ver doc-comment em SimulationPlan.hpp/PlcInstancePlan.
    PlcRuntimeOptions m_runtimeOptions;
    std::unique_ptr<PlcRuntime> m_runtime;
};

} // namespace lasecsimul::plc
