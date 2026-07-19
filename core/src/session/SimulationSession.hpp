#pragma once
#include <atomic>

#include <deque>
#include <filesystem>
#include <functional>
#include <future>
#include <memory>
#include <mutex>
#include <optional>
#include <type_traits>
#include <vector>
#include "../plugins/GlobalPluginCache.hpp"
#include "../plugins/PluginRuntime.hpp"
#include <string>
#include <unordered_map>
#include "../registry/ComponentRegistry.hpp"
#include "../registry/McuRegistry.hpp"
#include "../registry/SubcircuitRegistry.hpp"
#include "../simulation/ComponentMatrixView.hpp"
#include "../simulation/MnaSolver.hpp"
#include "../simulation/Netlist.hpp"
#include "../simulation/Scheduler.hpp"
#include "lasecsimul/IComponentModel.hpp"
#include "PauseExpression.hpp"

namespace lasecsimul::mcu {
class McuComponent;
} // namespace lasecsimul::mcu

namespace lasecsimul::session {

/** Pino exposto de uma instância de subcircuito -- É o pino real do `Tunnel` interno renomeado,
 * nunca um proxy (ver .spec/lasecsimul-subcircuits.spec, seção 5.2). */
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
    size_t solverThreads = 0;
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

    /** Devolve `true` só na transição vazio->não-vazio -- quem chama usa isso pra decidir se
     * precisa acordar a thread do Scheduler (via `Scheduler::scheduleAt`); se já havia comando
     * pendente, a thread já vai acordar (ou já está acordada) processando aquele. */
    bool push(Command command) {
        std::lock_guard<std::mutex> lock(m_mutex);
        const bool wasEmpty = m_commands.empty();
        m_commands.push_back(std::move(command));
        m_hasPending.store(true, std::memory_order_release);
        return wasEmpty;
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

private:
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
 * porque múltiplas sessões simultâneas sejam suportadas hoje — ver .spec/lasecsimul.spec, seção 4.
 *
 * `settleStep()` é o callback real passado ao Scheduler (ver .spec, seção 7/7.2): drena os
 * componentes dirty, estampa via ComponentMatrixView, resolve grupos dirty via MnaSolver, marca
 * como dirty quem escuta um nó cuja tensão de fato mudou. Devolve true enquanto ainda houver
 * trabalho pendente neste "round" — o Scheduler chama de novo até estabilizar.
 */
class SimulationSession {
public:
    explicit SimulationSession(plugins::GlobalPluginCache& globalCache, size_t componentCapacity = 1024);

    registry::ComponentRegistry& components() { return m_components; }
    registry::McuRegistry& mcus() { return m_mcus; }
    plugins::PluginRuntime& pluginRuntime() { return m_pluginRuntime; }
    simulation::Netlist& netlist() { return m_netlist; }
    simulation::Scheduler& scheduler() { return m_scheduler; }
    void setTransientSettings(const TransientSettings& settings);
    const TransientSettings& transientSettings() const { return m_transientSettings; }
    uint64_t acceptedTransientSteps() const { return m_acceptedTransientSteps.load(std::memory_order_relaxed); }
    uint64_t rejectedTransientSteps() const { return m_rejectedTransientSteps.load(std::memory_order_relaxed); }
    void setPerformanceProfilingEnabled(bool enabled);
    void resetPerformanceMetrics();
    SimulationPerformanceSnapshot performanceMetrics() const;

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
     * tocar em nenhum outro componente/fio (EX-6.1/EX-6.2, .spec/lasecsimul-native-devices.spec) --
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
     * inválida. Ver .spec/lasecsimul-subcircuits.spec, seção 5.1. */
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
    std::vector<double> nodeVoltagesOfPins(
        const std::vector<std::pair<uint32_t, std::string>>& probes) const;

    /** Saúde operacional da instância (`Ok`/`Lagging`/`Faulted`) -- ver
     * `IComponentModel::health()`/`NativeDeviceProxy` e `.spec/lasecsimul-native-devices.spec`
     * seção 13. Lança se a instância já foi removida. */
    PluginHealthStatus componentHealth(uint32_t componentIndex) const;

    /** Corrente elétrica no "ramo principal" da instância na última `solve()` -- ver
     * `IComponentModel::current()`. `std::nullopt` se o componente não implementa isso ou se já
     * foi removido. Nunca dispara solve novo, mesmo princípio de `nodeVoltageOfPin`. */
    std::optional<double> componentCurrent(uint32_t componentIndex) const;
    void loadMcuFirmware(uint32_t componentIndex, const std::filesystem::path& firmwarePath,
                         const std::string& arenaName, const std::string& qemuBinaryOverride,
                         McuDebugOptions debug = {});
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
    std::optional<UartRxSnapshot> tryDrainUartRx(uint32_t component) const {
        return m_scheduler.trySynchronized([&]() -> UartRxSnapshot {
            UartRxSnapshot snapshot;
            if (const auto dropped = propertyValueOfUnlocked(component, "uart_rx_dropped");
                dropped && std::holds_alternative<double>(*dropped)) {
                snapshot.dropped = std::get<double>(*dropped);
            }
            const auto data = propertyValueOfUnlocked(component, "uart_rx_hex");
            if (!data || !std::holds_alternative<std::string>(*data)) {
                throw std::runtime_error("componente não implementa canal UART");
            }
            snapshot.dataHex = std::get<std::string>(*data);
            if (const auto pending = propertyValueOfUnlocked(component, "uart_rx_pending");
                pending && std::holds_alternative<double>(*pending)) {
                snapshot.pending = std::get<double>(*pending);
            }
            return snapshot;
        });
    }

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
    void acquireSubscribedSignalsUnlocked(uint64_t timestampNs);
    void onStableStepUnlocked(uint64_t timestampNs);
    /** Chamado no fim de `onStableStepUnlocked()` (já na thread do Scheduler, com o mutex dela
     * tomado) -- publica um `NodeVoltageSnapshot` novo em `m_publishedSnapshot`, sob
     * `m_snapshotMutex` (mutex dedicado, NUNCA o do Scheduler -- ver doc-comment de
     * `NodeVoltageSnapshot`). Reaproveita `slotToNode`/`pinSlotsByComponent` da publicação anterior
     * quando `m_snapshotTopologyStale` está falso (topologia não mudou desde a última publicação). */
    void publishSnapshot();
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

    std::vector<std::unique_ptr<IComponentModel>> m_componentInstances;
    std::vector<uint32_t> m_signalSubscribers;
    std::unordered_map<std::string, uint32_t> m_signalAliases;
    struct PauseConditionState { PauseExpression expression; bool wasTrue = false; bool errorReported = false; };
    std::unordered_map<std::string, PauseConditionState> m_pauseConditions;
    std::function<void(const PauseConditionTriggered&)> m_pauseTriggeredCallback;
    simulation::Topology m_topology;
    std::vector<double> m_nodeVoltages;
    std::vector<double> m_previousNodeVoltages;
    /** Por nó global -> `nowNs()` da última vez que esse nó cruzou `kDigitalThreshold` -- só usado
     * pra calcular o `c` (ns desde a última borda) de `ComponentEvent{kPinChangeEventTag,...}`. Ver
     * settleStep(). */
    std::vector<uint64_t> m_lastEdgeTimeNs;
    /** Scratch reutilizado pelo settle: evita alocar/copiar um vetor novo em toda iteração. */
    std::vector<uint32_t> m_stampedThisRound;
    bool m_topologyDirty = true;
    /** Verdadeiro somente enquanto a revisão pendente contém EXCLUSIVAMENTE adições de fios.
     * Qualquer operação capaz de separar/reindexar rede desabilita reuso de matrizes neste rebuild. */
    bool m_topologyReuseSafe = false;
    uint64_t m_wireTopologyRevision = 0;
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
};

} // namespace lasecsimul::session
