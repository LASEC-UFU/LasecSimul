#pragma once
#include <atomic>

#include <chrono>
#include <deque>
#include <filesystem>
#include <functional>
#include <future>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <type_traits>
#include <utility>
#include <vector>
#include "../plugins/GlobalPluginCache.hpp"
#include "../plugins/PluginRuntime.hpp"
#include <string>
#include <unordered_map>
#include <unordered_set>
#include "../registry/ComponentRegistry.hpp"
#include "../registry/McuRegistry.hpp"
#include "../registry/SubcircuitRegistry.hpp"
#include "../simulation/ComponentMatrixView.hpp"
#include "../simulation/MnaSolver.hpp"
#include "../simulation/Netlist.hpp"
#include "../simulation/RuntimeState.hpp"
#include "../simulation/Scheduler.hpp"
#include "../python/PythonRuntime.hpp"
#include "../plc/PlcNativeModule.hpp"
#include "../plc/PlcRuntime.hpp"
#include "lasecsimul/IComponentModel.hpp"
#include "PauseExpression.hpp"

namespace lasecsimul::mcu {
class McuComponent;
} // namespace lasecsimul::mcu

namespace lasecsimul::plc {
class PlcComponent;
} // namespace lasecsimul::plc

namespace lasecsimul::session {

/** Pino exposto de uma instância de subcircuito -- É o pino real do `Tunnel` interno renomeado,
 * nunca um proxy (ver .spec/archive/legacy-v2/lasecsimul-subcircuits.spec, seção 5.2). */
struct SubcircuitExposedPin {
    uint32_t instanceId;
    std::string pinId;
};

struct SubcircuitExpansionResult {
    uint32_t subcircuitInstanceId;
    std::unordered_map<std::string, SubcircuitExposedPin> exposedPins;
    std::optional<uint32_t> primaryMcuInstanceId;
};

struct WireEndpointRef {
    uint32_t component;
    std::string pinId;
};

struct WireTopologyOperation {
    enum class Kind { Connect, Disconnect };
    Kind kind;
    WireEndpointRef from;
    WireEndpointRef to;
};

struct PauseConditionTriggered {
    std::string ownerId;
    uint64_t simulationTimeNs = 0;
    std::string expression;
    std::unordered_map<std::string, PauseScalar> resolvedValues;
    std::string error;
};

/** Fase 3 do redesign de concorrência (ver .claude/plans/idempotent-floating-cat.md) -- cópia
 * imutável e congelada do necessário pra resolver "tensão do pino X do componente Y" sem NUNCA
 * tocar o mutex do Scheduler nem `m_netlist`/`m_topology` diretamente. Publicada só a cada *stable
 * step* (não a cada iteração de settle -- só quando o circuito de fato estabiliza, ver
 * `publishSnapshot()`), lida via `currentSnapshot()` com um mutex PRÓPRIO e dedicado (segurado só
 * pelo tempo de copiar um `shared_ptr`, nunca pelo tempo de um settle inteiro). `slotToNode` e
 * `pinSlotsByComponent` só mudam quando a topologia muda de verdade (raro comparado a tensão, que
 * muda toda hora) -- publicações consecutivas reaproveitam o MESMO `shared_ptr` pra essas duas
 * partes quando a topologia não mudou desde a última publicação, então a maioria das publicações só
 * aloca um `vector<double>` novo pras tensões. */
struct NodeVoltageSnapshot {
    std::shared_ptr<const std::vector<double>> nodeVoltages;
    std::shared_ptr<const std::vector<uint32_t>> slotToNode; // por slot -> nó global
    // por componentIndex -> {pinId -> slot}; índice fora de faixa ou pinId ausente = componente/
    // pino não existente (removido ou nunca existiu) NESTE snapshot.
    std::shared_ptr<const std::vector<std::unordered_map<std::string, uint32_t>>> pinSlotsByComponent;
};

/** Resolve a tensão do pino `pinId` de `component` dentro de `snapshot` -- `std::nullopt` se o
 * componente/pino não existir NESTE snapshot (removido, nunca existiu, ou nó fora da faixa
 * registrada até a última publicação). Nunca lança, nunca bloqueia -- não toca em nenhum mutex do
 * Scheduler nem em `m_netlist`/`m_topology`, só lê os vetores/mapas já congelados do snapshot. */
std::optional<double> resolveNodeVoltage(const NodeVoltageSnapshot& snapshot, uint32_t component,
                                          const std::string& pinId);

struct SimulationPerformanceSnapshot {
    bool enabled = false;
    uint64_t simulatedNanoseconds = 0;
    uint64_t eventsProcessed = 0;
    uint64_t timeSteps = 0;
    uint64_t settleIterations = 0;
    uint64_t settleNanoseconds = 0;
    uint64_t componentStamps = 0;
    uint64_t deviceStampNanoseconds = 0;
    uint64_t solverCalls = 0;
    uint64_t solverNanoseconds = 0;
    uint64_t topologyRebuilds = 0;
    uint64_t topologyNanoseconds = 0;
    uint64_t pendingEvents = 0;
    uint64_t acceptedTransientSteps = 0;
    uint64_t rejectedTransientSteps = 0;
    uint64_t acceptedSignalDynamicSteps = 0;
    uint64_t rejectedSignalDynamicSteps = 0;
    uint64_t signalDiscontinuityEvents = 0;
    uint64_t signalLastStepNs = 0;
    double signalLastErrorRatio = 0.0;
    size_t solverThreads = 0;
    size_t solverWorkerThreads = 0;
    size_t solverMaxParallelTasks = 1;
    /** Duração da MAIOR chamada individual de settle (não a soma) e o instante (m_nowNs) em que
     * ela começou -- ver Scheduler::MetricsSnapshot::maxSettleNanoseconds/maxSettleAtNowNs. Só
     * lido daqui pra fora (getPerformanceMetrics); nunca populado neste struct. */
    uint64_t maxSettleNanoseconds = 0;
    uint64_t maxSettleAtNowNs = 0;
    uint64_t advanceLimitWaitCount = 0;
    uint64_t advanceLimitWaitNanoseconds = 0;
};

/** Um frame visual coerente, publicado apenas em fronteira de stable step. Estados de componente
 * e tensoes apontam para a mesma geracao; leitores nunca percorrem objetos mutaveis do runtime. */
struct TelemetryFrameSnapshot {
    uint64_t planGeneration = 0;
    uint64_t telemetryGeneration = 0;
    uint64_t timestampNs = 0;
    std::shared_ptr<const NodeVoltageSnapshot> nodeVoltages;
    std::vector<std::vector<uint8_t>> componentStates;
};

class SimulationSession; // ver CommandQueue::Command logo abaixo -- só usado por referência aqui

/** Fila de comandos de escrita (fase 2 do redesign de concorrência, ver
 * .claude/plans/idempotent-floating-cat.md) -- toda mutação estrutural de `SimulationSession`
 * (`connectWire`, `removeComponent`, `setProperty`, etc.) empurra um fechamento aqui pela thread de
 * IPC em vez de mutar `m_netlist`/`m_componentInstances` direto; só a thread do Scheduler drena e
 * aplica (`SimulationSession::drainCommandQueue()`, chamado via `Scheduler::CommandDrainFn`). Isso
 * elimina a data race real que existia entre a thread de IPC e a thread do Scheduler nesses
 * containers -- não é uma janela mais estreita, é zero escritores concorrentes. A fila em si tem
 * único produtor de fato (a fila de IPC é estritamente serial, ver IpcServer::processLoop), então um
 * mutex simples (não lock-free) é suficiente. */
class CommandQueue {
public:
    using Command = std::function<void(SimulationSession&)>;
    enum class PushResult { First, Queued, Full };

    explicit CommandQueue(size_t capacity = 1024) : m_capacity(capacity) {
        if (capacity == 0) throw std::invalid_argument("CommandQueue exige capacidade positiva");
    }

    /** Devolve `First` só na transição vazio->não-vazio -- quem chama usa isso pra decidir se
     * precisa acordar a thread do Scheduler. `Queued` preserva FIFO sem novo wakeup e `Full`
     * torna o overflow explícito para o produtor. */
    PushResult push(Command command) {
        std::lock_guard<std::mutex> lock(m_mutex);
        if (m_commands.size() >= m_capacity) return PushResult::Full;
        const bool wasEmpty = m_commands.empty();
        m_commands.push_back(std::move(command));
        m_hasPending.store(true, std::memory_order_release);
        return wasEmpty ? PushResult::First : PushResult::Queued;
    }

    /** Bug real de desempenho corrigido 2026-07-19 (achado testando ao vivo na extensão, não pela
     * suíte): `settleUntilStableLocked()` chama `CommandDrainFn` a CADA iteração do settle, não só
     * quando ocioso (ver doc-comment de `CommandDrainFn` em Scheduler.hpp) -- uma simulação com MCU
     * ativo pode rodar centenas de milhares de iterações de settle por segundo, e antes deste fix
     * CADA uma delas tomava `m_mutex` aqui incondicionalmente, mesmo com a fila vazia (o caso
     * comum). Isso virou um custo por iteração que não existia antes do redesign de concorrência --
     * sintoma real: taxa de simulação estabilizando bem abaixo de 100% de forma ESTÁVEL (não os
     * picos/travamentos do bug original, que já tinha sido corrigido -- um custo por iteração novo,
     * não um artefato de medição). `m_hasPending` deixa o caminho comum (fila vazia) virar uma única
     * leitura atômica, sem tocar `m_mutex` nunca. */
    std::deque<Command> takeAll() {
        if (!m_hasPending.load(std::memory_order_acquire)) return {};
        std::lock_guard<std::mutex> lock(m_mutex);
        m_hasPending.store(false, std::memory_order_release);
        return std::exchange(m_commands, {}); // não std::move -- precisa garantir vazio depois
    }

    /** Usado só como `Scheduler::CommandPendingFn` -- leitura atômica lock-free (mesmo raciocínio de
     * `takeAll()` acima), por isso é seguro chamar de dentro do predicado de `m_wake.wait(...)` sem
     * o produtor (`push`) e o predicado compartilharem lock nenhum -- ver notifyCommandPending(). */
    bool hasPending() const {
        return m_hasPending.load(std::memory_order_acquire);
    }

    size_t capacity() const { return m_capacity; }
    size_t size() const {
        std::lock_guard<std::mutex> lock(m_mutex);
        return m_commands.size();
    }

private:
    const size_t m_capacity;
    std::atomic<bool> m_hasPending{false};
    mutable std::mutex m_mutex;
    std::deque<Command> m_commands;
};

/**
 * Unidade de isolamento lógico de um projeto aberto: dona de ComponentRegistry, McuRegistry,
 * PluginRuntime, Netlist, MnaSolver e Scheduler.
 *
 * Escopo atual: exatamente UMA sessão por processo Core. O tipo existe para que isso não seja um
 * singleton implícito (cada membro é uma instância normal, não um Meyers-singleton/global), não
 * porque múltiplas sessões simultâneas sejam suportadas hoje — ver .spec/archive/legacy-v2/lasecsimul.spec, seção 4.
 *
 * `settleStep()` é o callback real passado ao Scheduler (ver .spec, seção 7/7.2): drena os
 * componentes dirty, estampa via ComponentMatrixView, resolve grupos dirty via MnaSolver, marca
 * como dirty quem escuta um nó cuja tensão de fato mudou. Devolve true enquanto ainda houver
 * trabalho pendente neste "round" — o Scheduler chama de novo até estabilizar.
 */
class SimulationSession {
public:
    explicit SimulationSession(
        plugins::GlobalPluginCache& globalCache,
        size_t componentCapacity = 1024,
        resources::ResourceGovernor resourceGovernor = resources::ResourceGovernor{});

    registry::ComponentRegistry& components() { return m_components; }
    registry::McuRegistry& mcus() { return m_mcus; }
    plugins::PluginRuntime& pluginRuntime() { return m_pluginRuntime; }
    const simulation::Netlist& netlist() const { return m_netlist; }
    simulation::Scheduler& scheduler() { return m_scheduler; }
    const resources::ResourceGovernor& resourceGovernor() const { return m_resourceGovernor; }
    size_t solverWorkerThreadCount() const { return m_mnaSolver.workerThreadCount(); }
    /** Compila/publica pendências somente quando o Scheduler está parado. Durante RUN nunca troca
     * a geração visível; alterações estruturais ficam pendentes até a próxima fronteira parada. */
    std::shared_ptr<const simulation::SimulationPlan> simulationPlan();
    bool publishSimulationPlan();
    const simulation::RuntimeState& runtimeState() const { return m_runtimeState; }
    /** Inicia uma nova execução real no cold path. Idempotente para pause/resume. */
    void beginExecutionIfNeeded();
    void abortExecutionIfCurrent(uint64_t attemptedId);
    simulation::PlanDomain pendingPlanDomains() const {
        std::lock_guard<std::mutex> lock(m_planMutex);
        return m_planInvalidation.domains();
    }
    void setTransientSettings(const TransientSettings& settings);
    const TransientSettings& transientSettings() const { return m_transientSettings; }
    uint64_t acceptedTransientSteps() const { return m_acceptedTransientSteps.load(std::memory_order_relaxed); }
    uint64_t rejectedTransientSteps() const { return m_rejectedTransientSteps.load(std::memory_order_relaxed); }
    void setPerformanceProfilingEnabled(bool enabled);
    void resetPerformanceMetrics();
    SimulationPerformanceSnapshot performanceMetrics() const;
    /** Substitui o grafo de blocos no cold path. A publicação compila tipos, unidades, SCCs e rates. */
    void setSignalGraph(simulation::SignalGraphDefinition definition);
    void setElectricalSignalBridges(std::vector<simulation::ElectricalSignalBridgeDefinition> definitions);
    const simulation::SignalRuntime& signalRuntime() const { return m_runtimeState.signals; }
    /** Publica blocos Python somente no cold path. O processo continua inexistente ate o primeiro lote. */
    void setPythonBlocks(std::vector<python::PythonBlockDefinition> definitions);
    std::vector<python::PythonStepResult> stepPythonBatch(
        const std::string& rateGroupId, const std::vector<python::PythonStep>& steps);
    void restartPythonRuntime();
    const python::PythonRuntime& pythonRuntime() const { return m_pythonRuntime; }

    /** F9.5: carrega (ou descarrega, se `module` for `nullopt`) um artefato compilado (F9.3) numa
     * instância `plc.instance` existente -- reconstrói os pinos (`exportedIo[]` exato, zero pinos
     * sem artefato) via `reregisterPinsIfChanged`, igual a qualquer outra propriedade estrutural
     * (`AffectsPinCount`). Requer simulação parada, mesma regra de `setProperty` estrutural. */
    void loadPlcArtifact(uint32_t componentIndex, std::optional<plc::PlcNativeModule> module);
    /** Pedidos de ligação de I/O do PLC a blocos do Signal Engine -- resolvidos/validados só na
     * próxima `publishSimulationPlan()` (mesmo caminho de `PlcInstanceDescriptor`, ver
     * SimulationPlan.hpp). Substitui a lista inteira desta instância (mesmo padrão de
     * `setElectricalSignalBridges`/`setPythonBlocks` -- não incremental). */
    void setPlcIoBindings(uint32_t componentIndex, std::vector<simulation::PlcIoBindingRequest> requests);
    void setPlcTaskIntervalNs(uint32_t componentIndex, uint64_t intervalNs);

    /** GET/SET/FORCE/UNFORCE passam direto pro `PlcRuntime` da instância, sem tocar
     * `simulationTimeNs`/disparar `scan()` (garantia já provada em F9.2/F9.4) -- funcionam com a
     * simulação rodando OU pausada (nunca com ela parada/sem worker ainda iniciado). Lança
     * `std::invalid_argument` se `componentIndex` não for uma instância de PLC com artefato
     * carregado; propaga `plc::PlcRuntimeError` se o worker faltar. */
    std::string plcGetVariable(uint32_t componentIndex, const std::string& qualifiedName);
    std::string plcSetVariable(uint32_t componentIndex, const std::string& qualifiedName, const std::string& value);
    std::string plcForceVariable(uint32_t componentIndex, const std::string& qualifiedName, const std::string& value);
    std::string plcUnforceVariable(uint32_t componentIndex, const std::string& qualifiedName);
    void plcReset(uint32_t componentIndex);
    plc::PlcRuntimeState plcRuntimeState(uint32_t componentIndex) const;

    /** Registra, no ComponentRegistry desta sessão, uma factory delegando ao PluginRuntime para
     * cada typeId com PluginModule ativo no GlobalPluginCache. Componentes built-in (ex: Resistor)
     * são registrados separadamente, direto pelo chamador — ver lasecsimul.spec, seção 12.2. */
    void registerKnownPluginTypes();

    /** Registra, no McuRegistry desta sessão, factories para cada chipId ativo no cache global. */
    void registerKnownMcuTypes();

    /** Cria uma instância de `typeId`, registra seus pinos no Netlist, marca a topologia como
     * suja (próxima rebuildTopology() inclui esta instância) e o componente como dirty (vai
     * estampar no próximo settleStep()). Devolve o índice estável da instância. */
    uint32_t addComponent(const std::string& typeId, const registry::ComponentParams& params);

    /** Fio entre o pino `pinId` da instância `a` e o pino `pinId` da instância `b`. Marca a
     * topologia como suja. */
    void connectWire(uint32_t componentA, const std::string& pinIdA, uint32_t componentB,
                      const std::string& pinIdB);

    /** Inverso de `connectWire` -- remove SÓ este fio específico (Netlist::disconnectWire), sem
     * tocar em nenhum outro componente/fio (EX-6.1/EX-6.2, .spec/archive/legacy-v2/lasecsimul-native-devices.spec) --
     * antes disto, a Extension não tinha como remover um fio sem reconstruir o circuito inteiro do
     * zero (removeComponent+addComponent+connectWire de TODOS os componentes). Devolve `false` (sem
     * marcar a topologia como suja) se este par de pinos não estava conectado -- idempotente, igual
     * a `removeComponent`. Marca a topologia como suja só quando de fato removeu algo. */
    bool disconnectWire(uint32_t componentA, const std::string& pinIdA, uint32_t componentB,
                         const std::string& pinIdB);

    /** Aplica um lote de arestas como uma única mutação observável. Todos os endpoints são
     * validados antes; uma exceção restaura integralmente Netlist/topologyDirty. */
    uint64_t applyWireTopologyTransaction(uint64_t baseRevision, const std::vector<WireTopologyOperation>& operations);
    uint64_t wireTopologyRevision() const { return m_wireTopologyRevision; }

    /** Renomeia (ou remove, se newName vazio) o nome de túnel do pino `pinId` da instância
     * `component` — ver .spec, seção 7.2. Marca a topologia como suja. */
    void setTunnelName(uint32_t component, const std::string& pinId, const std::string& oldName,
                        const std::string& newName);

    /** Remove logicamente a instância `componentIndex`: desconecta seus fios/túnel no Netlist,
     * libera o IComponentModel e marca a topologia como suja. O índice nunca é reciclado — ver
     * Netlist::removeComponent. Idempotente: remover de novo a mesma instância não falha. */
    void removeComponent(uint32_t componentIndex);

    registry::SubcircuitRegistry& subcircuits() { return m_subcircuits; }
    bool isSubcircuitType(const std::string& typeId) const { return m_subcircuits.contains(typeId); }

    /** `true` quando `instanceId` é um `subcircuitInstanceId` (devolvido por
     * `addSubcircuitInstance`) e não um `componentIndex` comum -- ver `kSubcircuitInstanceFlag` no
     * .cpp. Quem despacha `removeComponent` via IPC usa isto para decidir entre
     * `removeComponent()` simples e `removeSubcircuitInstance()` (cascata). */
    bool isSubcircuitInstance(uint32_t instanceId) const;

    /** Expande `typeId` (precisa satisfazer `isSubcircuitType`) recursivamente: cria cada
     * componente interno via `addComponent` normal (nesting automático se o `typeId` interno for
     * outro subcircuito), conecta os fios internos, e renomeia o `Tunnel` de cada pino exposto em
     * `interface[]` para `"<subcircuitInstanceId>::<internalTunnel>"`. Lança em ciclo de
     * dependência (subcircuito que se contém, direta ou indiretamente) ou referência interna
     * inválida. Ver .spec/archive/legacy-v2/lasecsimul-subcircuits.spec, seção 5.1. */
    SubcircuitExpansionResult addSubcircuitInstance(const std::string& typeId);

    /** Remove em cascata todos os `componentIndex` (recursivamente, incluindo subcircuitos
     * aninhados) criados pela expansão de `subcircuitInstanceId` — ver seção 5.4. Idempotente:
     * `subcircuitInstanceId` já removido não falha (no-op). */
    void removeSubcircuitInstance(uint32_t subcircuitInstanceId);

    /** Bytes opacos de `IComponentModel::getState()` de uma instância — mecanismo genérico de
     * leitura via IPC (ver CoreApplication.cpp, "getComponentState"), reaproveitado por
     * instrumentos (ex: voltímetro plugin) que calculam um valor em stamp() e o expõem como
     * estado em vez de propriedade — plugins ainda não têm getter de propriedade na ABI (ver
     * NativeDeviceProxy.hpp). Lança se a instância já foi removida (ponteiro nulo). */
    std::vector<uint8_t> getComponentState(uint32_t componentIndex) const;
    std::vector<uint8_t> getComponentTelemetryState(uint32_t componentIndex) const;
    std::vector<std::vector<uint8_t>> getComponentTelemetryStates(const std::vector<uint32_t>& componentIndices) const;
    TelemetryFrameSnapshot getTelemetryFrameSnapshot(const std::vector<uint32_t>& componentIndices) const;
    std::vector<double> nodeVoltagesOfPins(
        const std::vector<std::pair<uint32_t, std::string>>& probes) const;

    /** Saúde operacional da instância (`Ok`/`Lagging`/`Faulted`) -- ver
     * `IComponentModel::health()`/`NativeDeviceProxy` e `.spec/archive/legacy-v2/lasecsimul-native-devices.spec`
     * seção 13. Lança se a instância já foi removida. */
    PluginHealthStatus componentHealth(uint32_t componentIndex) const;

    /** Corrente elétrica no "ramo principal" da instância na última `solve()` -- ver
     * `IComponentModel::current()`. `std::nullopt` se o componente não implementa isso ou se já
     * foi removido. Nunca dispara solve novo, mesmo princípio de `nodeVoltageOfPin`. */
    std::optional<double> componentCurrent(uint32_t componentIndex) const;
    void loadMcuFirmware(uint32_t componentIndex, const std::filesystem::path& firmwarePath,
                         const std::string& arenaName, const std::string& qemuBinaryOverride,
                         McuDebugOptions debug = {});
    /** Atualiza sources/top/standard de uma instância `digital.generic_fpga` já criada, pra uso no
     * PRÓXIMO `runFpga`/`restartFpga` (verbo IPC `setFpgaConfig`) -- mesmo papel de
     * `loadMcuFirmware` pra MCU, mas sem (re)compilar/rodar imediatamente (isso é `runFpga`,
     * separado, pra permitir editar o VHDL sem religar o backend a cada keystroke). Lança se
     * `componentIndex` não for um `FpgaComponent` ou já tiver sido removido. */
    void setFpgaConfig(uint32_t componentIndex, std::vector<std::string> sources, std::string topEntity,
                       std::string standard);
    /** Compila (com cache) e inicia o processo GHDL da instância -- lança (mensagem inclui o log
     * de compilação real do GHDL, ver plano Caso C) se `compile()` falhar. */
    void runFpga(uint32_t componentIndex);
    void stopFpga(uint32_t componentIndex);
    void restartFpga(uint32_t componentIndex);
    std::string fpgaLogs(uint32_t componentIndex) const;
    /** Parada total da execução: encerra todas as MCUs/QEMUs e zera scheduler, tempo e eventos.
     * As instâncias elétricas são recriadas pela camada de projeto depois da confirmação deste
     * método, restaurando também o estado interno dos componentes built-in/ABI. */
    void stopSimulation();
    void stopMcuFirmware(uint32_t componentIndex);
    std::string mcuLogs(uint32_t componentIndex) const;
    /** Ponteiro cru pra instância MCU real (nullptr se `componentIndex` não for um McuComponent ou
     * já tiver sido removido) -- só pra TESTE controlar a arena sintética/ler estado interno
     * (`resetPinHigh()`/`loadFirmwareCallCountForTesting()`) de um MCU dentro de um subcircuito
     * REAL expandido (`addSubcircuitInstance`), onde não há outro jeito de chegar na instância além
     * do índice devolvido por `SubcircuitExposedPin::instanceId`. Produção nunca deveria precisar
     * disso -- todo caminho real já passa por `loadMcuFirmware`/`stopMcuFirmware`/`mcuLogs` acima. */
    mcu::McuComponent* mcuComponentForTesting(uint32_t componentIndex) const;

    /** Tempo virtual (ns) do PRIMEIRO MCU/QEMU da sessão, se houver algum -- lido direto de
     * `arena->qemuTime` (mesmo campo que `McuComponent::qemuEventTimeNs` já usa pra agendar
     * eventos). Existe só pro indicador diagnóstico "MCU real-time ratio" (ver
     * `getSimulationTime` em CoreApplication.cpp) -- nunca usado por lógica de simulação, e
     * DELIBERADAMENTE não é o mesmo relógio que `scheduler().nowNs()` (o elétrico, pareado ao
     * relógio de parede por design): a diferença entre os dois é exatamente o que expõe se o
     * MCU/QEMU está ficando pra trás do tempo real, mesmo que o solver elétrico continue "a
     * 100%". MVP: só o primeiro MCU encontrado -- agregação multi-MCU fica como trabalho futuro. */
    std::optional<uint64_t> firstMcuVirtualTimeNs() const;

    /** Só pra TESTE: expõe `computeSlowestMcuPositionNs()` (ver seu doc-comment na seção privada)
     * sem precisar esperar um ciclo real do laço de pacing do Scheduler chamar o hook sozinho. */
    std::optional<uint64_t> computeSlowestMcuPositionNsForTesting() { return computeSlowestMcuPositionNs(); }

    void sendComponentEvent(uint32_t componentIndex, const ComponentEvent& event);

    /** Edita UMA propriedade de uma instância já existente via PropertyDescriptor (ver
     * IComponentModel.hpp) — caminho genérico do painel de propriedades. Valida readOnly/tipo/
     * faixa/opções antes de chamar o setter; marca o componente dirty (vai re-stampar no próximo
     * settleStep()) e, se o schema declarar `affectsTopology`, também força rebuild de topologia
     * no próximo settleStep(). Túnel continua usando setTunnelName() acima, não isto (ver nota em
     * Tunnel.hpp). `std::nullopt` = sucesso; valor presente = "codigo|mensagem". */
    std::optional<std::string> setProperty(uint32_t component, const std::string& propertyName,
                                           const PropertyValue& value);

    /** Resolve o id LOCAL de um componente dentro de um subcircuito (ex: "button_en" no
     * `.lssubcircuit`) pro índice REAL do componente no Core -- usado pelo overlay de Modo Placa no
     * circuito principal (Extension não tem acesso a `componentIndexByLocalId`, que é local de
     * `expandSubcircuit()`). `subcircuitInstanceId` é o id COM a flag (`kSubcircuitInstanceFlag`),
     * mesmo valor devolvido por `addSubcircuitInstance()`. `std::nullopt` se a instância ou o id
     * local não existem (instância removida, id digitado errado etc.). */
    std::optional<uint32_t> findSubcircuitChildByLocalId(uint32_t subcircuitInstanceId, const std::string& localId) const;

    std::optional<PropertySchema> propertySchemaOf(uint32_t component, const std::string& propertyName) const;
    std::optional<PropertyValue> propertyValueOf(uint32_t component, const std::string& propertyName) const;

    /** [FIX] getProperty IPC head-of-line blocking (2026-08-28) -- non-blocking sibling of
     * propertyValueOf(), used ONLY by the getProperty IPC handler, which must never wait on
     * Scheduler::m_mutex from the strictly single-threaded IPC dispatch thread (a slow/contended
     * wait there blocks every other queued request, including trivial ones like
     * getSimulationTime, behind it). propertyValueOf() itself is untouched -- its other callers
     * (writeUart/getUartStatus handlers, 20+ existing tests) keep their current blocking
     * behavior unchanged.
     *
     * Reuses propertyValueOfUnlocked() (the same lookup propertyValueOf() itself calls) under
     * trySynchronized() instead of synchronized() -- no lookup logic duplicated, only the locking
     * strategy differs. Distinguishes three outcomes via a nested optional:
     *   outer nullopt              -> Scheduler::m_mutex busy (lock not acquired)
     *   outer present, inner nullopt -> lock acquired, component/property not found
     *   outer present, inner value   -> lock acquired, value found */
    std::optional<std::optional<PropertyValue>> tryPropertyValueOf(uint32_t component,
                                                                     const std::string& propertyName) const;

    /** Resolvedor canônico usado por aquisição vetorial e condições de pausa. */
    ResolvedSignal resolveSignal(const std::string& reference, std::optional<uint32_t> self = std::nullopt) const;
    void setPauseCondition(const std::string& ownerId, const std::string& expression);
    void setPauseConditionTriggeredCallback(std::function<void(const PauseConditionTriggered&)> callback) {
        m_pauseTriggeredCallback = std::move(callback);
    }

    /** Chamado pelo Scheduler (na thread dele, já com o mutex do Scheduler tomado — ver
     * Scheduler.cpp). Não chamar diretamente fora desse contexto. */
    bool settleStep();

    /** Snapshot publicado mais recente (fase 3 do redesign de concorrência) -- `nullptr` só antes do
     * PRIMEIRO stable step da sessão (nenhuma solve() aconteceu ainda). Cópia barata de um
     * `shared_ptr` sob um mutex DEDICADO (não o do Scheduler) -- nunca bloqueia, nunca falha por
     * "ocupado". Este é o caminho usado por `getNodeVoltage`/`getNodeVoltages` via IPC (o mais
     * chamado continuamente por osciloscópio/LasecPlot); `nodeVoltageOfPin`/`nodeVoltagesOfPins`
     * abaixo continuam existindo tal como antes só porque dezenas de testes já os chamam
     * diretamente fora de qualquer contexto concorrente real. */
    std::shared_ptr<const NodeVoltageSnapshot> currentSnapshot() const {
        std::lock_guard<std::mutex> lock(m_snapshotMutex);
        return m_publishedSnapshot;
    }

    /** Tensão atual (última solve()) do nó ao qual `pinId` da instância `component` está
     * resolvido. Usado por instrumentos/telemetria e por testes — nunca dispara um solve novo,
     * só lê o que já foi calculado. */
    double nodeVoltageOfPin(uint32_t component, const std::string& pinId) const {
        auto result = m_scheduler.trySynchronized([&] {
        const uint32_t slot = m_netlist.pinSlotsOf(component).at(pinId);
        // .at() em vez de operator[]: se ainda não houve nenhum settleStep() (ex: chamado via IPC
        // antes do "start"), m_topology/m_nodeVoltages estão vazios — sem isso seria acesso fora
        // dos limites (UB), não uma exceção limpa que o chamador (ex: handler de IPC) já trata.
        const uint32_t node = m_topology.slotToNode.at(slot);
        return m_nodeVoltages.at(node);
        });
        if (!result) throw std::runtime_error("simulacao ocupada; telemetria adiada");
        return *result;
    }

    /** Snapshot ATÔMICO (uma única aquisição de mutex, não três) das propriedades que o handler IPC
     * de "drainUart" precisa juntas (dropped/hex/pending do MESMO instante) -- e, principalmente,
     * SEM BLOQUEAR a thread de IPC se o Scheduler estiver no meio de um ciclo de settle. Bug real
     * 2026-07-18: LasecPlot sonda "drainUart" a cada 10-50ms (`LasecPlotBroker::poll`, ver
     * extension/src/lasecplot/broker.ts) e o handler antigo fazia TRÊS chamadas BLOQUEANTES de
     * `propertyValueOf` (cada uma via `Scheduler::synchronized`, que trava até o ciclo de settle em
     * andamento terminar) -- como `IpcServer::processLoop` despacha uma requisição JSON por vez,
     * estritamente serial (ver IpcServer.cpp), UMA dessas chamadas travadas bloqueava o pipe
     * INTEIRO, inclusive `getSimulationTime` (usado pra calcular a taxa de simulação mostrada na
     * UI) -- daí o sintoma relatado: taxa caindo perto de 0% durante o travamento, seguida de um
     * pico absurdo (>1000%) quando as respostas atrasadas chegavam de uma vez. Mesmo padrão já
     * usado por `getComponentState`/`nodeVoltageOfPin` acima (`trySynchronized`, não
     * `synchronized`), só que devolvendo `std::nullopt` em vez de lançar -- quem chama isto (o
     * handler IPC) já trata "ocupado agora" como caso NORMAL e frequente (tenta de novo no próximo
     * poll), não excepcional. `uart_rx_hex` drena o buffer atomicamente dentro do getter -- se o
     * chamador descartar um resultado `std::nullopt`, nenhum byte chega a ser perdido, só adiado. */
    struct UartRxSnapshot { std::string dataHex; double pending = 0.0; double dropped = 0.0; };
    std::optional<UartRxSnapshot> tryDrainUartRx(uint32_t component) const;

private:
    /** Corpo real de `addComponent`/`connectWire`/etc. -- o método público correspondente (sem o
     * sufixo) só empacota os argumentos e chama `runViaCommandQueue`; isto aqui é o que de fato roda
     * na thread do Scheduler (ou direto na thread de IPC quando a worker não existe, ver
     * `enqueueCommand`). Chamadores INTERNOS (`expandSubcircuit`, a cascata de
     * `removeSubcircuitInstanceUnlocked`, `applyWireTopologyTransactionUnlocked`) chamam estes
     * diretamente, nunca o público -- chamar o público de dentro de um comando já em execução
     * enfileiraria de novo e bloquearia esperando a própria thread que está travada nisto (deadlock:
     * só existe UM consumidor da fila, e ele já está ocupado sendo o chamador). */
    uint32_t addComponentUnlocked(const std::string& typeId, const registry::ComponentParams& params);
    void connectWireUnlocked(uint32_t componentA, const std::string& pinIdA, uint32_t componentB,
                              const std::string& pinIdB);
    bool disconnectWireUnlocked(uint32_t componentA, const std::string& pinIdA, uint32_t componentB,
                                 const std::string& pinIdB);
    uint64_t applyWireTopologyTransactionUnlocked(uint64_t baseRevision,
                                                   const std::vector<WireTopologyOperation>& operations);
    void setTunnelNameUnlocked(uint32_t component, const std::string& pinId, const std::string& oldName,
                                const std::string& newName);
    void removeComponentUnlocked(uint32_t componentIndex);
    void removeSubcircuitInstanceUnlocked(uint32_t subcircuitInstanceId);
    void sendComponentEventUnlocked(uint32_t componentIndex, const ComponentEvent& event);

    std::optional<std::string> setPropertyUnlocked(uint32_t component, const std::string& propertyName,
                                                   const PropertyValue& value);
    std::optional<PropertyValue> propertyValueOfUnlocked(uint32_t component, const std::string& propertyName) const;
    ResolvedSignal resolveSignalUnlocked(const std::string& reference, std::optional<uint32_t> self) const;
    simulation::SignalPlan::Route compileSignalRouteUnlocked(const std::string& reference,
                                                              std::optional<uint32_t> self) const;
    ResolvedSignal sampleSignalRouteUnlocked(const simulation::SignalPlan::Route& route) const;
    void rebuildSignalRoutesIfNeeded();
    void acquireSubscribedSignalsUnlocked(uint64_t timestampNs);
    void applySignalActuatorsUnlocked();
    /** Despacha postStep() para `m_dynamicComponentIndices`, mas não a cada passo MNA aceito (que
     * pode acontecer em microssegundos simulados sob passo adaptativo) -- acumula `acceptedDeltaNs`
     * por componente e só chama quando o total atinge `kDynamicComponentTickNs` (~60Hz, mesma
     * granularidade que simulide-complex/src/lib.c já usa pra rolagem de OLED/servo). Necessário
     * porque `NativeDeviceProxy::postStep` passa por `PluginWatchdog::call`, que cria uma thread
     * nova por chamada sempre que o manifesto declara `stepTimeoutMs` (todo device "complex" declara
     * 8-10ms) -- despachar a cada passo MNA geraria uma tempestade de criação de threads. */
    void advanceDynamicComponentsUnlocked(uint64_t acceptedDeltaNs);
    void publishElectricalSensorsToSignalUnlocked();
    void onStableStepUnlocked(uint64_t timestampNs);
    void scheduleNextSignalBoundaryUnlocked(uint64_t timestampNs);
    /** F9.5: agenda o PRIMEIRO scan de qualquer instância de PLC com artefato que ainda não tenha
     * um scan pendente (`m_plcScanScheduledNs`) -- chamado depois de publicar um plano novo, mesmo
     * espírito de `scheduleNextSignalBoundaryUnlocked`. Cada scan subsequente se reagenda sozinho
     * (ver `runPlcScanUnlocked`), então isto só precisa "dar a partida" em instâncias novas. */
    void schedulePlcScansUnlocked(uint64_t timestampNs);
    /** Agenda UM scan (o próximo, `intervalNs` a partir de `fromTimeNs`) pra `componentIndex` --
     * usado tanto pra dar a partida inicial quanto pelo autoagendamento no fim de cada scan (ver
     * `runPlcScanUnlocked`), garantindo as duas chamadas sempre usam exatamente a mesma lógica de
     * geração/staleness. */
    void scheduleOnePlcScanUnlocked(uint32_t componentIndex, uint64_t fromTimeNs, uint64_t intervalNs);
    /** Corpo do evento agendado pra UM scan de UMA instância -- InputLatch (lê `ioBindings` do
     * Signal Engine) -> `PlcRuntime::scan()` -> OutputCommit (só se `scan()` retornar com sucesso,
     * nunca parcial) -> reagenda o PRÓXIMO scan desta mesma instância. Roda fora do mutex do
     * Scheduler (ver `Scheduler::scheduleEventUnlocked` -- callback invocado com o lock liberado),
     * então bloquear aqui dentro de `PlcRuntime::scan()` nunca trava outras threads de IPC, só
     * atrasa o progresso do próprio worker thread do Scheduler (mesma categoria de custo já aceita
     * pra qualquer outro passo síncrono de processo externo). Um fault NÃO reagenda -- a instância
     * fica parada em `Faulted` até um reset/restart explícito (fora do escopo desta rodada), Core e
     * outras instâncias seguem normalmente. */
    void runPlcScanUnlocked(uint32_t componentIndex, uint64_t scanTimeNs);
    /** Resolve `componentIndex` pra um `PlcComponent` com `PlcRuntime` já carregado, ou lança
     * `std::invalid_argument` com uma mensagem prefixada por `callerName` -- usado por
     * `plcGetVariable`/`plcSetVariable`/`plcForceVariable`/`plcUnforceVariable` (todos idênticos na
     * validação, só o método chamado no `PlcRuntime` resultante muda). */
    plc::PlcRuntime& requirePlcRuntimeUnlocked(uint32_t componentIndex, const char* callerName);
    /** Chamado no fim de `onStableStepUnlocked()` (já na thread do Scheduler, com o mutex dela
     * tomado) -- publica um `NodeVoltageSnapshot` novo em `m_publishedSnapshot`, sob
     * `m_snapshotMutex` (mutex dedicado, NUNCA o do Scheduler -- ver doc-comment de
     * `NodeVoltageSnapshot`). Reaproveita `slotToNode`/`pinSlotsByComponent` da publicação anterior
     * quando `m_snapshotTopologyStale` está falso (topologia não mudou desde a última publicação). */
    void publishSnapshot();
    void publishTelemetrySnapshotIfRequested(uint64_t timestampNs);
    std::vector<std::vector<uint8_t>> captureComponentTelemetryStatesUnlocked(
        const std::vector<uint32_t>& componentIndices) const;
    void rebuildTopologyIfNeeded();
    /** Reaproveita `CircuitGroup` (matriz/fatoração já estampada) de `previous` pra qualquer rede
     * cujo conjunto de componentes vivos E mapeamento pino->índice local não mudaram -- sem isso,
     * `Netlist::rebuildTopology()` sempre aloca `CircuitGroup` novo/vazio pra TUDO (deliberado,
     * .spec seção 24.5), então qualquer mudança de topologia em QUALQUER ilha do circuito forçava
     * re-stamp de todo componente vivo do projeto inteiro, não só da ilha tocada. Só marca dirty os
     * componentes de grupos que NÃO puderam ser reaproveitados. */
    void reuseUnaffectedCircuitGroups(simulation::Topology& previous, const std::vector<double>& previousNodeVoltages);
    SubcircuitExpansionResult expandSubcircuit(const std::string& typeId, std::vector<std::string>& expansionStack);
    /** Relê `instance->pins()` (já com a contagem nova, resolvida por quem implementa
     * `IComponentModel` -- `SimulidePassiveState`/`NativeDeviceProxy`, nunca aqui) e reregistra no
     * `Netlist` só se o conjunto de ids mudou de verdade -- evita `reregisterComponentPins` (que
     * sempre gera slots novos, nunca reciclados) em toda edição de propriedade com
     * `AffectsPinCount`, mesmo quando o valor não mudou o suficiente pra alterar a contagem. */
    void reregisterPinsIfChanged(uint32_t componentIndex, IComponentModel* instance);
    simulation::PlanDomain refreshComponentExecutionLists(uint32_t componentIndex);
    void invalidatePlan(simulation::PlanDomain domains);

    /** Empurra `command` na `m_commandQueue` e, se a fila estava vazia antes (transição
     * vazio->não-vazio), acorda a thread do Scheduler caso ela esteja parada ociosa (ver
     * `Scheduler::scheduleAt`/`m_wake`) -- se já havia comando pendente, a thread já vai processar
     * este também quando esvaziar a fila, sem precisar de um novo "wake". */
    void enqueueCommand(CommandQueue::Command command);

    /** Chamado pelo Scheduler (via `CommandDrainFn`, já na thread dele) em dois pontos seguros:
     * antes do laço de settle e a cada iteração dentro dele -- ver `Scheduler::settleUntilStableLocked`.
     * Aplica cada comando pendente, em ordem (FIFO, único consumidor). */
    void drainCommandQueue();

    /** Empacota `fn` (que muta `*this`, chamado só na thread do Scheduler) num comando, empurra na
     * fila e bloqueia (via `std::promise`/`std::future`) até a thread do Scheduler de fato aplicar
     * -- preserva o contrato síncrono de hoje (mesma resposta/erro/timing observável do ponto de
     * vista de quem chama) sem que a thread de IPC toque em `m_netlist`/`m_componentInstances`
     * diretamente. `std::make_shared<std::promise<...>>` porque o comando pode ser aplicado (e a
     * promise, satisfeita) numa call stack diferente/depois do retorno desta função caso a fila
     * ainda não tenha sido drenada no instante do `push` -- a promise precisa sobreviver a essa
     * travessia de thread. Exceções lançadas por `fn` são propagadas pra quem chama via
     * `promise->set_exception`/`future.get()`, igual a uma chamada direta teria feito. */
    template <class Fn>
    auto runViaCommandQueue(Fn&& fn) -> std::invoke_result_t<Fn, SimulationSession&> {
        using Result = std::invoke_result_t<Fn, SimulationSession&>;
        auto promise = std::make_shared<std::promise<Result>>();
        std::future<Result> future = promise->get_future();
        enqueueCommand([promise, fn = std::forward<Fn>(fn)](SimulationSession& session) mutable {
            try {
                if constexpr (std::is_void_v<Result>) {
                    fn(session);
                    promise->set_value();
                } else {
                    promise->set_value(fn(session));
                }
            } catch (...) {
                promise->set_exception(std::current_exception());
            }
        });
        return future.get();
    }

    plugins::GlobalPluginCache& m_globalCache;
    resources::ResourceGovernor m_resourceGovernor;
    registry::ComponentRegistry m_components;
    registry::McuRegistry m_mcus;
    registry::SubcircuitRegistry m_subcircuits;
    std::unordered_map<uint32_t, std::vector<uint32_t>> m_subcircuitChildren; // rawId (sem a flag) -> filhos
    // rawId (sem a flag) -> {id local do .lssubcircuit -> índice real do componente no Core} --
    // sobrevive além do escopo de expandSubcircuit() pra permitir endereçar um filho específico por
    // nome (overlay de Modo Placa, ver findSubcircuitChildByLocalId()).
    std::unordered_map<uint32_t, std::unordered_map<std::string, uint32_t>> m_subcircuitChildIndexByLocalId;
    uint32_t m_nextSubcircuitInstanceId = 0;
    plugins::PluginRuntime m_pluginRuntime;
    simulation::Netlist m_netlist;
    simulation::MnaSolver m_mnaSolver;
    simulation::Scheduler m_scheduler;
    python::PythonRuntime m_pythonRuntime;

    std::vector<std::unique_ptr<IComponentModel>> m_componentInstances;
    simulation::RuntimeState m_runtimeState;
    // Serializa apenas as transições cold-path de identidade (start/stop). Não participa
    // do settle-loop nem do caminho I2C.
    mutable std::mutex m_executionIdentityMutex;
    std::vector<uint32_t>& m_activeComponentIndices = m_runtimeState.execution.activeComponents;
    std::vector<uint32_t>& m_reactiveComponentIndices = m_runtimeState.execution.reactiveComponents;
    std::vector<uint32_t>& m_nonlinearComponentIndices = m_runtimeState.execution.nonlinearComponents;
    std::vector<uint32_t>& m_fpgaComponentIndices = m_runtimeState.execution.fpgaComponents;
    std::vector<uint32_t>& m_mcuComponentIndices = m_runtimeState.execution.mcuComponents;
    std::vector<uint32_t>& m_plcComponentIndices = m_runtimeState.execution.plcComponents;
    std::vector<uint32_t>& m_signalSubscribers = m_runtimeState.execution.signalSubscribers;
    std::vector<uint32_t>& m_dynamicComponentIndices = m_runtimeState.execution.dynamicComponents;
    /** componentIndex -> ns simulados acumulados desde o último postStep() despachado -- ver
     * `advanceDynamicComponentsUnlocked`. Entrada removida (não zerada) quando o componente sai da
     * lista dinâmica, pra uma instância nova reaproveitando o mesmo índice nunca herdar acumulado
     * da anterior. */
    std::unordered_map<uint32_t, uint64_t> m_dynamicAccumulatedNs;
    std::unordered_map<std::string, uint32_t> m_signalAliases;
    simulation::SignalGraphDefinition m_signalGraphDefinition;
    std::vector<simulation::ElectricalSignalBridgeDefinition> m_electricalSignalBridgeDefinitions;
    std::vector<python::PythonBlockDefinition> m_pythonBlockDefinitions;
    std::optional<uint64_t> m_signalBoundaryScheduledNs;
    uint64_t m_signalScheduleGeneration = 0;
    /** F9.5: `componentIndex` -> `simulationTimeNs` do próximo SCAN já agendado no Scheduler pra
     * essa instância -- mesmo papel de `m_signalBoundaryScheduledNs`, mas por instância (cada PLC
     * tem seu próprio relógio de task, ao contrário do único calendário do Signal Engine). Ausência
     * de entrada = nenhum scan pendente pra essa instância (fault recém-ocorrido, artefato
     * descarregado, ou ainda não teve o primeiro scan agendado). */
    std::unordered_map<uint32_t, uint64_t> m_plcScanScheduledNs;
    /** `componentIndex` -> geração atual daquela instância -- incrementada a CADA chamada de
     * `scheduleOnePlcScanUnlocked` (não só em reset/reload) e também em `loadPlcArtifact`/
     * `stopSimulation`/remoção. Cada callback agendado captura a geração do momento em que foi
     * armado; um valor capturado diferente do valor atual do mapa significa "outro agendamento pra
     * esta instância já aconteceu depois deste" -- protege contra o caso em que
     * `nextScanNs` sozinho colidiria por coincidência com um agendamento anterior já invalidado
     * (mesmo raciocínio de `m_signalScheduleGeneration`, só que por instância em vez de global —
     * global invalidaria erroneamente OUTRAS instâncias PLC não relacionadas a cada reload). */
    std::unordered_map<uint32_t, uint64_t> m_plcScanGeneration;
    struct PauseConditionState {
        PauseExpression expression;
        std::unordered_map<std::string, simulation::SignalPlan::Route> signalRoutes;
        std::unordered_map<std::string, uint32_t> currentComponents;
        bool wasTrue = false;
        bool errorReported = false;
    };
    std::unordered_map<std::string, PauseConditionState> m_pauseConditions;
    std::function<void(const PauseConditionTriggered&)> m_pauseTriggeredCallback;
    simulation::Topology& m_topology = m_runtimeState.electricalTopology;
    std::vector<double>& m_nodeVoltages = m_runtimeState.nodeVoltages;
    std::vector<double>& m_previousNodeVoltages = m_runtimeState.previousNodeVoltages;
    /** Por nó global -> `nowNs()` da última vez que esse nó cruzou `kDigitalThreshold` -- só usado
     * pra calcular o `c` (ns desde a última borda) de `ComponentEvent{kPinChangeEventTag,...}`. Ver
     * settleStep(). */
    std::vector<uint64_t>& m_lastEdgeTimeNs = m_runtimeState.lastEdgeTimeNs;
    /** Scratch reutilizado pelo settle: evita alocar/copiar um vetor novo em toda iteração. */
    std::vector<uint32_t>& m_stampedThisRound = m_runtimeState.stampedThisRound;
    std::vector<uint32_t>& m_stampedNonlinearThisRound = m_runtimeState.stampedNonlinearThisRound;
    bool m_topologyDirty = true;
    bool m_signalRoutesDirty = true;
    /** Verdadeiro somente enquanto a revisão pendente contém EXCLUSIVAMENTE adições de fios.
     * Qualquer operação capaz de separar/reindexar rede desabilita reuso de matrizes neste rebuild. */
    bool m_topologyReuseSafe = false;
    uint64_t m_wireTopologyRevision = 0;
    uint64_t m_authoringRevision = 0;
    uint64_t m_electricalPlanRevision = 0;
    simulation::PlanInvalidation m_planInvalidation{simulation::PlanDomain::All};
    mutable std::mutex m_planMutex;
    std::shared_ptr<const simulation::SimulationPlan> m_publishedPlan;
    uint32_t m_nonlinearIterations = 0; // ver kMaxNonlinearIterations em SimulationSession.cpp
    TransientSettings m_transientSettings;
    std::atomic<uint64_t> m_acceptedTransientSteps{0};
    std::atomic<uint64_t> m_rejectedTransientSteps{0};
    std::atomic<bool> m_performanceProfilingEnabled{false};
    std::atomic<uint64_t> m_componentStamps{0};
    std::atomic<uint64_t> m_deviceStampNanoseconds{0};
    std::atomic<uint64_t> m_solverCalls{0};
    std::atomic<uint64_t> m_solverNanoseconds{0};
    std::atomic<uint64_t> m_topologyRebuilds{0};
    std::atomic<uint64_t> m_topologyNanoseconds{0};

    CommandQueue m_commandQueue;

    /** Mutex DEDICADO pra `m_publishedSnapshot` -- deliberadamente separado de `m_scheduler`'s
     * mutex: só é tomado pelo tempo de trocar um `shared_ptr` (publicar) ou copiar um (ler), nunca
     * pelo tempo de um settle inteiro, então leitores nunca bloqueiam de verdade. */
    mutable std::mutex m_snapshotMutex;
    std::shared_ptr<const NodeVoltageSnapshot> m_publishedSnapshot;
    /** `true` quando `slotToNode`/`pinSlotsByComponent` precisam ser recopiados na próxima
     * `publishSnapshot()` -- setado por `rebuildTopologyIfNeeded()` sempre que a topologia é
     * reconstruída de verdade; começa `true` pra garantir que a primeira publicação sempre copie. */
    bool m_snapshotTopologyStale = true;

    /** Snapshot sob demanda dos blobs usados por `getComponentStates` (LED, displays e demais
     * estados visuais). O mutex e' independente do Scheduler e fica tomado apenas para registrar
     * ids ou trocar o snapshot; a captura real ocorre na worker depois de um stable step. */
    struct ComponentTelemetrySnapshot {
        uint64_t planGeneration = 0;
        uint64_t telemetryGeneration = 0;
        uint64_t timestampNs = 0;
        std::shared_ptr<const NodeVoltageSnapshot> nodeVoltages;
        std::vector<std::optional<std::vector<uint8_t>>> states;
    };
    mutable std::mutex m_telemetrySnapshotMutex;
    mutable std::unordered_set<uint32_t> m_telemetrySubscriptions;
    mutable uint64_t m_telemetryRequestedGeneration = 0;
    uint64_t m_telemetryPublishedGeneration = 0;
    mutable std::atomic<uint64_t> m_telemetryFrameGeneration{0};
    std::shared_ptr<const ComponentTelemetrySnapshot> m_publishedTelemetrySnapshot;

    /** Achado 2026-07-23 (McuComponentLivePollThreadTest com 2 MCUs, real, sob a nova
     * sincronização de ritmo): um MCU cuja arena continua aberta mas que PAROU de produzir eventos
     * novos há um bom tempo (ex.: ficou ocioso depois de uma rajada de teste, ou -- em produção --
     * um firmware genuinamente dormindo/esperando um evento externo por um período longo) tem sua
     * `pacingPositionNs()` CONGELADA pra sempre no último valor visto. Como
     * `computeSlowestMcuPositionNs()` toma o MÍNIMO entre todos os MCUs, esse valor congelado vira
     * um teto permanente sobre o elétrico -- mesmo que esse MCU não esteja "lento" de verdade, só
     * quieto. Corrigido com o MÍNIMO de estado necessário: rastreia por MCU (chave = componentIndex,
     * nunca reaproveitado) só o último `(posição, instante de parede em que mudou)`; se a posição
     * não mudou por mais que `kStaleMcuTimeout`, esse MCU para de contribuir pro teto (mesmo
     * tratamento de "sem dado" que um MCU recém-carregado já recebe) -- volta a contribuir
     * normalmente assim que produzir um evento novo. `kStaleMcuTimeout` precisa ficar bem maior que
     * a folga do Scheduler (5-20ms) pra nunca excluir por engano um MCU genuinamente lento mas ainda
     * progredindo -- valor inicial a refinar com medição real, não considerado definitivo. */
    struct McuPositionTracking {
        uint64_t lastPositionNs = 0;
        std::chrono::steady_clock::time_point lastChangeWallTime{};
    };
    std::unordered_map<uint32_t, McuPositionTracking> m_mcuPositionTracking;

    /** Callback de `Scheduler::AdvanceLimitFn` (setado no construtor via
     * `setAdvanceLimitCallback`) -- itera todo `McuComponent` da sessão com arena aberta, lê
     * `pacingPositionNs()` (posição já traduzida pra timeline do Scheduler, `nullopt` se o MCU
     * ainda não processou nenhum evento -- boot ou logo após recarga -- ou se ficou parado por mais
     * que `kStaleMcuTimeout`, ver `McuPositionTracking` acima), e devolve a MENOR entre todas (o
     * mais lento). `nullopt` se nenhum MCU contribuiu -- inclui o caso de 0 MCUs na sessão,
     * degradando pro comportamento de sempre sem exceção nenhuma. A folga acima dessa posição é
     * aplicada pelo PRÓPRIO Scheduler (derivada da granularidade de pacing que ele já calibra, ver
     * `Scheduler::pacingQuantumNs()`) -- não somada aqui, pra não duplicar essa responsabilidade.
     * Substituiu um design anterior (`computeSlowestMcuPacingRatio()`, uma EMA com estado por-MCU e
     * janela de aquecimento) que falhou em teste ao vivo duas vezes (ver `Scheduler::AdvanceLimitFn`,
     * doc-comment em Scheduler.hpp, pro raciocínio completo) -- o único estado que sobrou aqui é o
     * de staleness acima, nada de suavização/ratio/aquecimento. Thread-safety: chamada pela thread
     * worker do Scheduler, mesma convenção de `settleStep()` -- toda mutação externa de
     * `m_componentInstances` já é funilada pela fila de comandos (`enqueueCommand`/
     * `drainCommandQueue`), nunca concorrente com a própria worker. */
    std::optional<uint64_t> computeSlowestMcuPositionNs();

    /** Fast path de transferência I2C (ver McuComponent::setI2cTransferHandler,
     * docs/39-i2c-mttcg-throughput-ceiling-*.md seção 9): dado o MCU e o índice de barramento I2C,
     * acha o pino físico que carrega SDA agora (`McuComponent::resolveI2cPinIndex`, chip-específico
     * -- nullopt aqui já é fallback seguro, chip sem suporte), o nó elétrico daquele pino
     * (`m_netlist`/`m_topology`, chip-neutro) e todo componente com pino no MESMO nó
     * (`pinRefsByNode`). Só usa o fast path se TODOS os outros componentes daquele nó forem ou (a)
     * capazes de `transferI2c` (dispositivo I2C real) ou (b) um tipo explicitamente transparente
     * pra essa decisão (resistor de pull-up, terra, túnel) -- qualquer outra coisa (capacitor,
     * componente ativo desconhecido, outro MCU fazendo bit-bang) força `handled=false`, que o
     * chamador (McuComponent/QEMU) interpreta como "sem suporte, use o caminho elétrico
     * bit-a-bit". Só o PRIMEIRO componente I2C-capaz que confirma o endereço (`addressAck`) é
     * usado; se nenhum confirmar, devolve `handled=true, addressAck=false` -- um NACK definitivo
     * resolvido pelo fast path, não um "não sei, tente devagar". `mcuIndex` é lido com
     * `m_componentInstances[mcuIndex]` sem lock adicional -- seguro porque `m_componentInstances`
     * só muda via `enqueueCommand`, nunca concorrente com a worker (ver doc-comment de
     * `computeSlowestMcuPositionNs` acima); mas os campos DENTRO de outro `IComponentModel` (ex: o
     * framebuffer do plugin do SSD1306) só são seguros de tocar na mesma serialização que protege
     * `stamp()` -- por isso `McuComponent::processI2cBurstLocked` só chama este método via
     * `m_scheduler.isCurrentThreadWorker()` (chamada direta) ou `m_scheduler.synchronized(...)`
     * (qualquer outra thread, ex: a thread de poll de fundo do MCU) -- nunca direto de uma thread
     * que não seja a worker sem passar por `synchronized`. */
    I2cTransferResult resolveI2cTransferUnlocked(uint32_t mcuIndex, uint32_t bus, const I2cTransfer& transfer);
    /** true se `componentIndex` pode compartilhar o nó elétrico de um barramento I2C fast-path sem
     * forçar fallback -- ver doc-comment de `resolveI2cTransferUnlocked` acima, item (b). */
    static bool isI2cFastPathTransparentUnlocked(const IComponentModel& component);

public:
    /** Só pra TESTE -- ver `computeSlowestMcuPositionNsForTesting` acima pro mesmo padrão. */
    I2cTransferResult resolveI2cTransferForTesting(uint32_t mcuIndex, uint32_t bus, const I2cTransfer& transfer) {
        return resolveI2cTransferUnlocked(mcuIndex, bus, transfer);
    }
};

} // namespace lasecsimul::session
