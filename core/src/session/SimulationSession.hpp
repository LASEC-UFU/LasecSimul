#pragma once

#include <filesystem>
#include <memory>
#include <optional>
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
    uint64_t acceptedTransientSteps() const { return m_acceptedTransientSteps; }
    uint64_t rejectedTransientSteps() const { return m_rejectedTransientSteps; }

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
    void stopMcuFirmware(uint32_t componentIndex);
    std::string mcuLogs(uint32_t componentIndex) const;

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

    /** Chamado pelo Scheduler (na thread dele, já com o mutex do Scheduler tomado — ver
     * Scheduler.cpp). Não chamar diretamente fora desse contexto. */
    bool settleStep();

    /** Tensão atual (última solve()) do nó ao qual `pinId` da instância `component` está
     * resolvido. Usado por instrumentos/telemetria e por testes — nunca dispara um solve novo,
     * só lê o que já foi calculado. */
    double nodeVoltageOfPin(uint32_t component, const std::string& pinId) const {
        return m_scheduler.synchronized([&] {
        const uint32_t slot = m_netlist.pinSlotsOf(component).at(pinId);
        // .at() em vez de operator[]: se ainda não houve nenhum settleStep() (ex: chamado via IPC
        // antes do "start"), m_topology/m_nodeVoltages estão vazios — sem isso seria acesso fora
        // dos limites (UB), não uma exceção limpa que o chamador (ex: handler de IPC) já trata.
        const uint32_t node = m_topology.slotToNode.at(slot);
        return m_nodeVoltages.at(node);
        });
    }

private:
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
    simulation::Topology m_topology;
    std::vector<double> m_nodeVoltages;
    std::vector<double> m_previousNodeVoltages;
    /** Por nó global -> `nowNs()` da última vez que esse nó cruzou `kDigitalThreshold` -- só usado
     * pra calcular o `c` (ns desde a última borda) de `ComponentEvent{kPinChangeEventTag,...}`. Ver
     * settleStep(). */
    std::vector<uint64_t> m_lastEdgeTimeNs;
    bool m_topologyDirty = true;
    /** Verdadeiro somente enquanto a revisão pendente contém EXCLUSIVAMENTE adições de fios.
     * Qualquer operação capaz de separar/reindexar rede desabilita reuso de matrizes neste rebuild. */
    bool m_topologyReuseSafe = false;
    uint64_t m_wireTopologyRevision = 0;
    uint32_t m_nonlinearIterations = 0; // ver kMaxNonlinearIterations em SimulationSession.cpp
    TransientSettings m_transientSettings;
    uint64_t m_acceptedTransientSteps = 0;
    uint64_t m_rejectedTransientSteps = 0;
};

} // namespace lasecsimul::session
