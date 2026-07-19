#pragma once

#include <algorithm>
#include <cstdint>
#include <limits>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>
#include "CircuitGroup.hpp"
#include "UnionFind.hpp"

namespace lasecsimul::simulation {

/** Onde um pino (slot global) caiu depois da resolução de topologia. */
struct PinSlotResolution {
    uint32_t groupIndex; // índice em Topology::groups
    uint32_t localIndex; // linha/coluna dentro daquele CircuitGroup
};

/** Onde a(s) variável(is) extra(s) — corrente de ramo — de um componente caiu. Só populado para
 * componentes com extraVariableCount() > 0 (ver .spec/lasecsimul.spec, seção 7.3). */
struct ExtraVariableResolution {
    uint32_t groupIndex;
    uint32_t baseLocalIndex; // primeira linha/coluna de variável extra deste componente, no grupo
};

/** Resolução pronta para o hot path de stamp(). O mapa depende apenas da topologia e, portanto,
 * deve ser construído uma vez no rebuild, não novamente a cada passo/iteração do solver. */
struct ComponentStampResolution {
    uint32_t groupIndex = std::numeric_limits<uint32_t>::max();
    std::unordered_map<std::string, uint32_t> localIndexByPinId;
};

/** Um pino específico de um componente específico, presente num nó — usado pra disparar
 * `ComponentEvent{kPinChangeEventTag,...}` quando esse nó cruza o limiar digital (ver
 * SimulationSession::settleStep()). `localPinIndex` = posição do pino na ordem de declaração
 * (mesmo índice que `IComponentModel::pins()`/a ABI de plugin usam) -- NUNCA o slot global. */
struct NodePinRef {
    uint32_t componentIndex;
    uint32_t localPinIndex;
};

struct Topology {
    std::vector<CircuitGroup> groups;
    std::vector<PinSlotResolution> resolutionBySlot;    // por slot de pino -> grupo + índice local
    std::vector<std::vector<uint32_t>> listenersByNode; // por nó global -> componentIndex interessados (dedup)
    /** Por nó global -> TODOS os (componente, pino-local) ali presentes, SEM dedup (um componente
     * com 2 pinos no mesmo nó aparece 2x, cada vez com seu próprio localPinIndex) -- diferente de
     * `listenersByNode`, que só serve pra marcar dirty (dedup é o correto ali). */
    std::vector<std::vector<NodePinRef>> pinRefsByNode;
    std::vector<uint32_t> slotToNode;                   // por slot -> nó global (pós passada 1)
    std::vector<ExtraVariableResolution> extraVariablesByComponent; // por componentIndex (se > 0 vars)
    std::vector<ComponentStampResolution> stampResolutionByComponent;
};

/**
 * Grafo de nós do circuito, sempre achatado (subcircuitos/devices aninhados nunca geram matriz
 * própria — ver .spec/lasecsimul.spec, seção 7.1). Resolve topologia em duas passadas de
 * `UnionFind`, sempre do zero — nunca incremental, porque união não é desfazível (renomear um
 * túnel pode separar nós que estavam fundidos) e topologia só muda em edição do usuário, nunca no
 * caminho crítico de simulação (ver seção 7.2):
 *
 *   Passada 1 (pino -> nó): une slots conectados por fio OU por nome de túnel compartilhado.
 *   Passada 2 (nó -> grupo): cada componente une os nós dos seus PRÓPRIOS pinos entre si — é
 *   isso que forma os `CircuitGroup` (sistemas lineares independentes, ver seção 7.1).
 *
 * Variáveis extras (correntes de ramo de fonte de tensão ideal, seção 7.3) são alocadas na MESMA
 * passada de rebuild, depois das linhas de nó de cada grupo — nunca durante stamp().
 */
class Netlist {
public:
    /** Aloca um slot de nó por pino do componente. Devolve o slot global por id local de pino
     * (ex: "p1") — quem chama (SimulationSession) guarda isso pra montar o ComponentMatrixView
     * de cada componente depois de rebuildTopology(). */
    const std::unordered_map<std::string, uint32_t>& registerComponent(
        uint32_t componentIndex, const std::vector<std::string>& pinIds) {
        if (componentIndex != m_componentPinSlots.size())
            throw std::invalid_argument("Netlist::registerComponent: componentIndex must be dense");

        // Slots de um componente são sempre alocados em sequência contígua, na ordem de `pinIds`
        // (uma única chamada, um push por iteração) -- por isso `localPinIndex` de um slot é
        // derivável sem guardar a lista ordenada de novo: `slot - m_firstSlotByComponent[owner]`.
        m_firstSlotByComponent.push_back(static_cast<uint32_t>(m_slotOwner.size()));

        std::unordered_map<std::string, uint32_t> slotsByPinId;
        for (const std::string& pinId : pinIds) {
            if (pinId.empty()) throw std::invalid_argument("Netlist::registerComponent: empty pin id");
            if (slotsByPinId.find(pinId) != slotsByPinId.end())
                throw std::invalid_argument("Netlist::registerComponent: duplicate pin id");

            const uint32_t slot = static_cast<uint32_t>(m_slotOwner.size());
            m_slotOwner.push_back(componentIndex);
            m_slotOrphaned.push_back(false);
            m_tunnelNameBySlot.emplace_back();
            m_fallbackTunnelNameBySlot.emplace_back();
            slotsByPinId.emplace(pinId, slot);
        }
        m_componentPinSlots.push_back(std::move(slotsByPinId));
        m_componentRemoved.push_back(false);
        return m_componentPinSlots.back();
    }

    /** Remove logicamente o componente `componentIndex`: desconecta todos os fios que tocam seus
     * pinos, limpa nome de túnel deles e marca o componente como removido — rebuildTopology() passa
     * a ignorar seus slots (não formam nó/grupo/listener novos). O índice NUNCA é reciclado:
     * registerComponent() exige componentIndex == size() (denso e crescente), então reaproveitar um
     * buraco exigiria recompactar todos os índices já distribuídos à Extension/Webview — fora de
     * escopo (ver docs/mvp-limitacoes.md). Idempotente: remover de novo não falha. */
    void removeComponent(uint32_t componentIndex) {
        if (componentIndex >= m_componentPinSlots.size())
            throw std::out_of_range("Netlist::removeComponent: invalid component index");
        if (m_componentRemoved[componentIndex]) return;

        for (const auto& [pinId, slot] : m_componentPinSlots[componentIndex]) {
            (void)pinId;
            disconnectSlot(slot);
        }
        m_componentRemoved[componentIndex] = true;
    }

    bool isComponentRemoved(uint32_t componentIndex) const { return m_componentRemoved.at(componentIndex); }

    /** Troca o CONJUNTO de pinos de um componente vivo (ex: `rows`/`columns` de um keypad mudou) —
     * mesma filosofia append-only/nunca-reciclado de `removeComponent`/`registerComponent`, só que
     * pro nível de pino em vez de componente inteiro: os slots ANTIGOS são desconectados (fio/túnel)
     * e marcados órfãos (`m_slotOrphaned`, nunca mais aparecem em nó/grupo/listener/pinRef depois de
     * `rebuildTopology()` — mesmo tratamento que `m_componentRemoved` já dá aos slots de um
     * componente inteiramente removido), os slots NOVOS são alocados no final do array global
     * (mesmo padrão de `registerComponent`) e `m_firstSlotByComponent[componentIndex]` é atualizado
     * pro novo início -- `localPinIndex = slot - primeiro slot` continua válido pros pinos NOVOS
     * (contíguos entre si), só não existe mais pros antigos (que não são mais referenciados). Custo:
     * alguns slots "mortos" por edição de propriedade que muda contagem de pino, ao longo de uma
     * sessão -- aceito pela mesma razão que `componentIndex` nunca ser reciclado já é aceito. Chamar
     * isto NUNCA é caminho crítico (só via `SimulationSession::setProperty`, evento raro do
     * usuário) -- não confundir com `connectWire`/`disconnectWire`, que são frequentes. */
    void reregisterComponentPins(uint32_t componentIndex, const std::vector<std::string>& newPinIds) {
        if (componentIndex >= m_componentPinSlots.size())
            throw std::out_of_range("Netlist::reregisterComponentPins: invalid component index");
        if (m_componentRemoved[componentIndex])
            throw std::invalid_argument("Netlist::reregisterComponentPins: componente removido");

        for (const auto& [pinId, slot] : m_componentPinSlots[componentIndex]) {
            (void)pinId;
            disconnectSlot(slot);
            m_slotOrphaned[slot] = true;
        }

        m_firstSlotByComponent[componentIndex] = static_cast<uint32_t>(m_slotOwner.size());
        std::unordered_map<std::string, uint32_t> slotsByPinId;
        for (const std::string& pinId : newPinIds) {
            if (pinId.empty()) throw std::invalid_argument("Netlist::reregisterComponentPins: empty pin id");
            if (slotsByPinId.find(pinId) != slotsByPinId.end())
                throw std::invalid_argument("Netlist::reregisterComponentPins: duplicate pin id");

            const uint32_t slot = static_cast<uint32_t>(m_slotOwner.size());
            m_slotOwner.push_back(componentIndex);
            m_slotOrphaned.push_back(false);
            m_tunnelNameBySlot.emplace_back();
            m_fallbackTunnelNameBySlot.emplace_back();
            slotsByPinId.emplace(pinId, slot);
        }
        m_componentPinSlots[componentIndex] = std::move(slotsByPinId);
    }

    void connectWire(uint32_t slotA, uint32_t slotB) {
        validateSlot(slotA, "Netlist::connectWire");
        validateSlot(slotB, "Netlist::connectWire");
        m_wireEdges.emplace_back(slotA, slotB);
    }

    bool disconnectWire(uint32_t slotA, uint32_t slotB) {
        validateSlot(slotA, "Netlist::disconnectWire");
        validateSlot(slotB, "Netlist::disconnectWire");
        const auto matches = [slotA, slotB](const auto& edge) {
            return (edge.first == slotA && edge.second == slotB) ||
                   (edge.first == slotB && edge.second == slotA);
        };
        const auto it = std::find_if(m_wireEdges.begin(), m_wireEdges.end(), matches);
        if (it == m_wireEdges.end()) return false;
        m_wireEdges.erase(it);
        return true;
    }

    /** Túnel: associa/reassocia/desassocia um slot a um nome. Por sessão (esta Netlist), nunca
     * estático/global — dois projetos abertos nunca compartilham nomes de túnel por acidente
     * (decisão deliberada vs. o `static QMap` do SimulIDE — ver .spec, seção 7.2). */
    void setTunnelName(uint32_t slot, const std::string& oldName, const std::string& newName) {
        (void)oldName; // Estado real fica nesta Netlist; o parametro antigo existe para compatibilidade.
        validateSlot(slot, "Netlist::setTunnelName");

        std::string& currentName = m_tunnelNameBySlot[slot];
        if (currentName == newName) return;

        if (!currentName.empty()) {
            auto it = m_tunnelGroups.find(currentName);
            if (it != m_tunnelGroups.end()) {
                auto& slots = it->second;
                slots.erase(std::remove(slots.begin(), slots.end(), slot), slots.end());
                if (slots.empty()) m_tunnelGroups.erase(it);
            }
        }
        currentName = newName;
        if (!newName.empty()) m_tunnelGroups[newName].push_back(slot);
    }

    /** Entrada por nome com precedência menor que fio físico. Diferente de setTunnelName(), este
     * slot não cria um grupo: ele apenas se associa a um grupo de Tunnel real já existente. */
    void setFallbackTunnelName(uint32_t slot, const std::string& newName) {
        validateSlot(slot, "Netlist::setFallbackTunnelName");
        std::string& currentName = m_fallbackTunnelNameBySlot[slot];
        if (currentName == newName) return;
        if (!currentName.empty()) {
            auto it = m_fallbackTunnelGroups.find(currentName);
            if (it != m_fallbackTunnelGroups.end()) {
                auto& slots = it->second;
                slots.erase(std::remove(slots.begin(), slots.end(), slot), slots.end());
                if (slots.empty()) m_fallbackTunnelGroups.erase(it);
            }
        }
        currentName = newName;
        if (!newName.empty()) m_fallbackTunnelGroups[newName].push_back(slot);
    }

    const std::unordered_map<std::string, uint32_t>& pinSlotsOf(uint32_t componentIndex) const {
        return m_componentPinSlots.at(componentIndex);
    }

    /** Cópia rasa de TODOS os mapeamentos pino->slot, por componentIndex -- usado só pra montar o
     * snapshot publicado de tensões de nó (ver SimulationSession::NodeVoltageSnapshot, fase 3 do
     * redesign de concorrência, .claude/plans/idempotent-floating-cat.md): a thread de IPC nunca
     * mais toca `Netlist` diretamente pra ler tensão, então precisa de uma cópia congelada em vez de
     * `pinSlotsOf()` (que devolveria uma referência pra dentro deste objeto, mutável pela thread do
     * Scheduler a qualquer momento). Só chamado no momento da publicação (raro: 1x por stable step,
     * não por leitura), nunca no caminho quente de leitura em si. */
    std::vector<std::unordered_map<std::string, uint32_t>> componentPinSlotsCopy() const {
        return m_componentPinSlots;
    }

    std::optional<uint32_t> tunnelSlot(std::string_view name) const {
        const auto it = m_tunnelGroups.find(std::string(name));
        if (it == m_tunnelGroups.end() || it->second.empty()) return std::nullopt;
        return it->second.front();
    }

    bool isPinExternallyConnected(uint32_t componentIndex, const std::string& pinId) const {
        const uint32_t slot = m_componentPinSlots.at(componentIndex).at(pinId);
        if (!m_tunnelNameBySlot[slot].empty()) return true;
        if (hasWire(slot)) return true;
        const std::string& fallback = m_fallbackTunnelNameBySlot[slot];
        return !fallback.empty() && m_tunnelGroups.contains(fallback);
    }

    /** Recomputa tudo do zero — só deve ser chamado quando a topologia muda (fio/túnel/componente
     * adicionado ou removido), nunca a cada passo de simulação. `extraVarCountByComponent` (mesma
     * ordem/índice de componentIndex que registerComponent) vem de
     * `IComponentModel::extraVariableCount()` — Netlist não conhece IComponentModel, então quem
     * chama (SimulationSession) é responsável por essa consulta antes de chamar isto. */
    Topology rebuildTopology(const std::vector<uint32_t>& extraVarCountByComponent = {}) const {
        const size_t slotCount = m_slotOwner.size();

        // Passada 1: pino/slot -> nó global. Este rebuild integral é o oracle de conectividade:
        // union-find comprimido não é reutilizado entre revisões porque remoções/splits não são
        // reversíveis e componentes ativos podem depender de uma reestabilização completa.
        UnionFind pinUnion(slotCount);
        for (const auto& [a, b] : m_wireEdges) {
            validateSlot(a, "Netlist::rebuildTopology");
            validateSlot(b, "Netlist::rebuildTopology");
            pinUnion.unite(a, b);
        }
        for (const auto& [name, slots] : m_tunnelGroups) {
            if (!slots.empty()) validateSlot(slots[0], "Netlist::rebuildTopology");
            for (size_t i = 1; i < slots.size(); ++i) {
                validateSlot(slots[i], "Netlist::rebuildTopology");
                pinUnion.unite(slots[0], slots[i]);
            }
            // Mesmo contrato de Oscope/LAnalizer do SimulIDE: o nome digitado só vale quando o
            // canal não tem connector físico e quando Tunnel::getEnode(name) encontraria uma rede.
            if (!slots.empty()) {
                const auto fallbacks = m_fallbackTunnelGroups.find(name);
                if (fallbacks != m_fallbackTunnelGroups.end()) {
                    for (uint32_t fallbackSlot : fallbacks->second) {
                        validateSlot(fallbackSlot, "Netlist::rebuildTopology fallback tunnel");
                        if (!hasWire(fallbackSlot)) pinUnion.unite(slots[0], fallbackSlot);
                    }
                }
            }
        }
        const std::vector<uint32_t> slotToNode = pinUnion.compress();
        const size_t nodeCount = pinUnion.idCount();

        // Passada 2: nó -> grupo (mesmo componente => mesmo grupo). Componente removido não tem
        // mais pinos vivos — não deve fundir nós nem aparecer em grupo/listener algum.
        UnionFind groupUnion(nodeCount);
        for (size_t componentIndex = 0; componentIndex < m_componentPinSlots.size(); ++componentIndex) {
            if (m_componentRemoved[componentIndex]) continue;
            const std::unordered_map<std::string, uint32_t>& slotsByPinId = m_componentPinSlots[componentIndex];
            uint32_t firstNode = std::numeric_limits<uint32_t>::max();
            for (const auto& [pinId, slot] : slotsByPinId) {
                (void)pinId;
                const uint32_t node = slotToNode[slot];
                if (firstNode == std::numeric_limits<uint32_t>::max()) firstNode = node;
                else groupUnion.unite(firstNode, node);
            }
        }
        const std::vector<uint32_t> nodeToGroup = groupUnion.compress();
        const size_t groupCount = groupUnion.idCount();

        // Monta os nós (em ordem local) de cada grupo + resolução nó -> (grupo, índice local)
        std::vector<std::vector<uint32_t>> nodesPerGroup(groupCount);
        for (uint32_t node = 0; node < nodeCount; ++node) nodesPerGroup[nodeToGroup[node]].push_back(node);

        std::vector<PinSlotResolution> resolutionByNode(nodeCount);
        for (uint32_t g = 0; g < groupCount; ++g) {
            for (uint32_t local = 0; local < nodesPerGroup[g].size(); ++local) {
                resolutionByNode[nodesPerGroup[g][local]] = {g, local};
            }
        }

        // Variáveis extras: por componente, soma no grupo a que pertence (qualquer um dos seus
        // nós serve — passada 2 garante que todos caem no mesmo grupo). Base = nodeCount do grupo
        // + quanto já foi reservado antes deste componente, na ordem de componentIndex.
        std::vector<uint32_t> extraCountPerGroup(groupCount, 0);
        std::vector<ExtraVariableResolution> extraVariablesByComponent(m_componentPinSlots.size(), {0, 0});
        for (size_t componentIndex = 0; componentIndex < m_componentPinSlots.size(); ++componentIndex) {
            if (m_componentRemoved[componentIndex]) continue;
            const uint32_t needed = componentIndex < extraVarCountByComponent.size()
                                         ? extraVarCountByComponent[componentIndex]
                                         : 0;
            if (needed == 0) continue;
            const auto& slotsByPinId = m_componentPinSlots[componentIndex];
            if (slotsByPinId.empty()) continue;
            const uint32_t anyNode = slotToNode[slotsByPinId.begin()->second];
            const uint32_t group = nodeToGroup[anyNode];

            extraVariablesByComponent[componentIndex] = {
                group, static_cast<uint32_t>(nodesPerGroup[group].size() + extraCountPerGroup[group])};
            extraCountPerGroup[group] += needed;
        }

        Topology topology;
        topology.groups.reserve(groupCount); // zero realloc -- CircuitGroup não precisa ser barato de mover
        for (uint32_t g = 0; g < groupCount; ++g)
            topology.groups.emplace_back(nodesPerGroup[g], extraCountPerGroup[g]);

        topology.resolutionBySlot.resize(slotCount);
        for (uint32_t slot = 0; slot < slotCount; ++slot)
            topology.resolutionBySlot[slot] = resolutionByNode[slotToNode[slot]];

        topology.stampResolutionByComponent.resize(m_componentPinSlots.size());
        for (size_t componentIndex = 0; componentIndex < m_componentPinSlots.size(); ++componentIndex) {
            if (m_componentRemoved[componentIndex]) continue;
            ComponentStampResolution& stamp = topology.stampResolutionByComponent[componentIndex];
            stamp.localIndexByPinId.reserve(m_componentPinSlots[componentIndex].size());
            for (const auto& [pinId, slot] : m_componentPinSlots[componentIndex]) {
                const PinSlotResolution& resolution = topology.resolutionBySlot[slot];
                stamp.groupIndex = resolution.groupIndex;
                stamp.localIndexByPinId.emplace(pinId, resolution.localIndex);
            }
        }

        topology.listenersByNode.resize(nodeCount);
        for (uint32_t slot = 0; slot < slotCount; ++slot) {
            // removido nunca volta a ser dirty; órfão (reregisterComponentPins trocou o conjunto de
            // pinos do componente, este slot específico não existe mais) idem, mesmo o dono vivo.
            if (m_componentRemoved[m_slotOwner[slot]] || m_slotOrphaned[slot]) continue;
            topology.listenersByNode[slotToNode[slot]].push_back(m_slotOwner[slot]);
        }
        for (std::vector<uint32_t>& listeners : topology.listenersByNode) {
            std::sort(listeners.begin(), listeners.end());
            listeners.erase(std::unique(listeners.begin(), listeners.end()), listeners.end());
        }

        topology.pinRefsByNode.resize(nodeCount);
        for (uint32_t slot = 0; slot < slotCount; ++slot) {
            const uint32_t owner = m_slotOwner[slot];
            // removido nunca volta a receber evento de pino; órfão idem (ver listenersByNode acima).
            if (m_componentRemoved[owner] || m_slotOrphaned[slot]) continue;
            const uint32_t localPinIndex = slot - m_firstSlotByComponent[owner];
            topology.pinRefsByNode[slotToNode[slot]].push_back({owner, localPinIndex});
        }

        topology.slotToNode = slotToNode;
        topology.extraVariablesByComponent = std::move(extraVariablesByComponent);
        return topology;
    }

private:
    bool hasWire(uint32_t slot) const {
        return std::any_of(m_wireEdges.begin(), m_wireEdges.end(),
                           [slot](const auto& edge) { return edge.first == slot || edge.second == slot; });
    }

    void validateSlot(uint32_t slot, const char* operation) const {
        if (slot >= m_slotOwner.size()) throw std::out_of_range(std::string(operation) + ": invalid pin slot");
    }

    /** Limpa nome de túnel e fios de UM slot -- extraído de `removeComponent` pra ser reaproveitado
     * por `reregisterComponentPins` (mesma limpeza, granularidade de slot em vez de componente
     * inteiro). Não marca `m_slotOrphaned`/`m_componentRemoved` -- cada chamador decide qual dos
     * dois (ou nenhum, não há terceiro caso hoje). */
    void disconnectSlot(uint32_t slot) {
        if (!m_tunnelNameBySlot[slot].empty()) setTunnelName(slot, m_tunnelNameBySlot[slot], "");
        if (!m_fallbackTunnelNameBySlot[slot].empty()) setFallbackTunnelName(slot, "");
        const auto touchesSlot = [slot](const auto& edge) { return edge.first == slot || edge.second == slot; };
        m_wireEdges.erase(std::remove_if(m_wireEdges.begin(), m_wireEdges.end(), touchesSlot), m_wireEdges.end());
    }

    std::vector<uint32_t> m_slotOwner;                                    // slot -> componentIndex
    std::vector<bool> m_slotOrphaned; // slot -> true se reregisterComponentPins descartou este pino
    std::vector<uint32_t> m_firstSlotByComponent;                         // componentIndex -> 1o slot dele
    std::vector<std::unordered_map<std::string, uint32_t>> m_componentPinSlots; // por componente: pinId -> slot
    std::vector<std::pair<uint32_t, uint32_t>> m_wireEdges;
    std::unordered_map<std::string, std::vector<uint32_t>> m_tunnelGroups;
    std::unordered_map<std::string, std::vector<uint32_t>> m_fallbackTunnelGroups;
    std::vector<std::string> m_tunnelNameBySlot;
    std::vector<std::string> m_fallbackTunnelNameBySlot;
    std::vector<bool> m_componentRemoved; // por componente: true se removeComponent() já foi chamado
};

} // namespace lasecsimul::simulation
