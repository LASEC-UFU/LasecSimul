#include "SimulationSession.hpp"
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <limits>
#include <optional>
#include <stdexcept>
#include <nlohmann/json.hpp>
#include "../mcu/McuComponent.hpp"

namespace lasecsimul::session {

namespace {
// Abaixo disso, duas tensões são consideradas "a mesma" — evita reativar listeners por ruído de
// ponto flutuante quando um grupo resolve para um valor numericamente idêntico ao anterior.
constexpr double kVoltageEpsilon = 1e-9;


// Mesmo papel do Simulator::m_maxNlstp do SimulIDE — limite de rounds em que o settle-loop é
// mantido vivo só por componente não-linear não convergido, pra nunca girar pra sempre. Contador
// global (não por componente) porque ainda não existe componente não-linear real pra calibrar
// algo mais fino — ver .spec/lasecsimul.spec, seção 7.4.
constexpr uint32_t kMaxNonlinearIterations = 50;

std::optional<std::string> validationError(const char* code, std::string message) {
    return std::string(code) + "|" + std::move(message);
}

bool propertyKindMatches(const PropertyValue& value, PropertyValueKind expectedKind) {
    switch (expectedKind) {
        case PropertyValueKind::Number: return std::holds_alternative<double>(value);
        case PropertyValueKind::String: return std::holds_alternative<std::string>(value);
        case PropertyValueKind::Bool: return std::holds_alternative<bool>(value);
        case PropertyValueKind::Point: return std::holds_alternative<PropertyPoint>(value);
    }
    return false;
}

// Bit alto reservado para distinguir um `subcircuitInstanceId` de um `componentIndex` comum no
// mesmo espaço numérico de `instanceId` na fronteira IPC (ambos uint32_t) -- "id sintético" que a
// spec explicitamente deixa como decisão de implementação (.spec/lasecsimul-subcircuits.spec,
// seção 5.1, item 2). Um subcircuito nunca tem `componentIndex` próprio (orquestra filhos reais),
// então não há colisão de espaço de id real a evitar, só de REPRESENTAÇÃO na mesma variável.
constexpr uint32_t kSubcircuitInstanceFlag = 0x8000'0000u;

registry::ComponentParams paramsFromPropertiesJson(const std::string& propertiesJson) {
    registry::ComponentParams params;
    nlohmann::json props;
    try {
        props = nlohmann::json::parse(propertiesJson.empty() ? "{}" : propertiesJson);
    } catch (const std::exception&) {
        return params;
    }
    if (!props.is_object()) return params;
    for (const auto& [key, value] : props.items()) {
        if (value.is_boolean()) params.properties[key] = value.get<bool>();
        else if (value.is_string()) params.properties[key] = value.get<std::string>();
        else if (value.is_number()) params.properties[key] = value.get<double>();
        // "point" (objeto {x,y}) omitido nesta primeira versão -- nenhum componente built-in tem
        // propriedade desse tipo alimentada por subcircuito ainda.
    }
    return params;
}

std::string tunnelNameFromPropertiesJson(const std::string& propertiesJson) {
    try {
        const nlohmann::json props = nlohmann::json::parse(propertiesJson.empty() ? "{}" : propertiesJson);
        return props.value("name", std::string{});
    } catch (const std::exception&) {
        return {};
    }
}
} // namespace

SimulationSession::SimulationSession(plugins::GlobalPluginCache& globalCache, size_t componentCapacity)
    : m_globalCache(globalCache), m_pluginRuntime(globalCache),
      m_scheduler(componentCapacity, [this] { return settleStep(); }) {}

void SimulationSession::registerKnownPluginTypes() {
    for (const std::string& typeId : m_globalCache.knownDeviceTypeIds()) {
        m_components.replaceFactory(typeId, [this, typeId](const registry::ComponentParams& params) {
            ComponentMeta meta;
            meta.typeId = typeId;
            meta.pins = params.pinList;
            if (const registry::ComponentMetadata* metadata = m_globalCache.metadata().find(typeId)) {
                meta.propertySchema = metadata->propertySchema;
                meta.stepTimeoutMs = metadata->stepTimeoutMs;
            }
            return m_pluginRuntime.createDeviceInstance(typeId, std::move(meta), params, m_scheduler);
        });
    }
}

void SimulationSession::registerKnownMcuTypes() {
    for (const std::string& chipId : m_globalCache.knownMcuChipIds()) {
        m_mcus.replaceFactory(chipId, [this, chipId] { return m_pluginRuntime.createMcuAdapter(chipId); });
    }
}

uint32_t SimulationSession::addComponent(const std::string& typeId, const registry::ComponentParams& params) {
    std::unique_ptr<IComponentModel> instance;
    if (m_components.contains(typeId)) {
        instance = m_components.create(typeId, params);
    } else if (m_mcus.contains(typeId)) {
        instance = std::make_unique<mcu::McuComponent>(m_mcus.create(typeId), m_scheduler, params.pinList);
    } else {
        instance = m_components.create(typeId, params);
    }

    const uint32_t componentIndex = static_cast<uint32_t>(m_componentInstances.size());

    std::vector<std::string> pinIds;
    for (const Pin& pin : instance->pins()) pinIds.push_back(pin.id);
    m_netlist.registerComponent(componentIndex, pinIds);

    instance->onAssignedIndex(componentIndex);
    m_componentInstances.push_back(std::move(instance));
    m_topologyDirty = true;
    m_scheduler.markDirty(componentIndex);
    return componentIndex;
}

void SimulationSession::connectWire(uint32_t componentA, const std::string& pinIdA, uint32_t componentB,
                                     const std::string& pinIdB) {
    if (m_netlist.isComponentRemoved(componentA) || m_netlist.isComponentRemoved(componentB))
        throw std::invalid_argument("SimulationSession::connectWire: componente removido");
    const uint32_t slotA = m_netlist.pinSlotsOf(componentA).at(pinIdA);
    const uint32_t slotB = m_netlist.pinSlotsOf(componentB).at(pinIdB);
    m_netlist.connectWire(slotA, slotB);
    m_topologyDirty = true;
}

bool SimulationSession::disconnectWire(uint32_t componentA, const std::string& pinIdA, uint32_t componentB,
                                        const std::string& pinIdB) {
    if (m_netlist.isComponentRemoved(componentA) || m_netlist.isComponentRemoved(componentB))
        throw std::invalid_argument("SimulationSession::disconnectWire: componente removido");
    const uint32_t slotA = m_netlist.pinSlotsOf(componentA).at(pinIdA);
    const uint32_t slotB = m_netlist.pinSlotsOf(componentB).at(pinIdB);
    const bool removed = m_netlist.disconnectWire(slotA, slotB);
    if (removed) m_topologyDirty = true;
    return removed;
}

void SimulationSession::setTunnelName(uint32_t component, const std::string& pinId, const std::string& oldName,
                                       const std::string& newName) {
    if (m_netlist.isComponentRemoved(component))
        throw std::invalid_argument("SimulationSession::setTunnelName: componente removido");
    const uint32_t slot = m_netlist.pinSlotsOf(component).at(pinId);
    m_netlist.setTunnelName(slot, oldName, newName);
    m_topologyDirty = true;
}

std::optional<std::string> SimulationSession::setProperty(uint32_t component, const std::string& propertyName,
                                                          const PropertyValue& value) {
    if (component >= m_componentInstances.size()) {
        return validationError("unknown_property", "propriedade desconhecida: " + propertyName);
    }

    IComponentModel* instance = m_componentInstances[component].get();
    if (!instance) return validationError("unknown_property", "propriedade desconhecida: " + propertyName);

    for (PropertyDescriptor& descriptor : instance->propertyDescriptors()) {
        if (descriptor.name != propertyName) continue;

        const PropertySchema& schema = descriptor.schema;
        if ((schema.flags & PropertySchemaReadOnly) != 0) {
            return validationError("read_only", "propriedade somente leitura: " + propertyName);
        }
        if (!propertyKindMatches(value, schema.valueKind)) {
            return validationError("type_mismatch", "tipo invÃ¡lido para propriedade: " + propertyName);
        }
        if (const double* numericValue = std::get_if<double>(&value)) {
            if (schema.minValue && *numericValue < *schema.minValue) {
                return validationError("out_of_range", "valor abaixo do mÃ­nimo para propriedade: " + propertyName);
            }
            if (schema.maxValue && *numericValue > *schema.maxValue) {
                return validationError("out_of_range", "valor acima do mÃ¡ximo para propriedade: " + propertyName);
            }
        }
        if (!schema.options.empty()) {
            const std::string* optionValue = std::get_if<std::string>(&value);
            const bool validOption = optionValue
                && std::any_of(schema.options.begin(), schema.options.end(), [&](const PropertyOption& option) {
                       return option.value == *optionValue;
                   });
            if (!validOption) {
                return validationError("invalid_option", "opÃ§Ã£o invÃ¡lida para propriedade: " + propertyName);
            }
        }

        descriptor.set(value);
        if ((schema.flags & PropertySchemaAffectsTopology) != 0) m_topologyDirty = true;
        m_scheduler.markDirty(component); // editar propriedade sempre exige re-stamp
        return std::nullopt;
    }

    return validationError("unknown_property", "propriedade desconhecida: " + propertyName);
}

std::optional<PropertySchema> SimulationSession::propertySchemaOf(uint32_t component,
                                                                  const std::string& propertyName) const {
    if (component >= m_componentInstances.size()) return std::nullopt;

    IComponentModel* instance = m_componentInstances[component].get();
    if (!instance) return std::nullopt;

    for (PropertyDescriptor& descriptor : instance->propertyDescriptors()) {
        if (descriptor.name == propertyName) return descriptor.schema;
    }
    return std::nullopt;
}

void SimulationSession::removeComponent(uint32_t componentIndex) {
    IComponentModel* instance = m_componentInstances.at(componentIndex).get();
    if (!instance) return; // já removido, idempotente

    m_netlist.removeComponent(componentIndex);
    m_componentInstances[componentIndex].reset();
    m_scheduler.dirtySet().remove(componentIndex);
    m_topologyDirty = true;
}

bool SimulationSession::isSubcircuitInstance(uint32_t instanceId) const {
    if ((instanceId & kSubcircuitInstanceFlag) == 0) return false;
    return m_subcircuitChildren.count(instanceId & ~kSubcircuitInstanceFlag) > 0;
}

SubcircuitExpansionResult SimulationSession::addSubcircuitInstance(const std::string& typeId) {
    std::vector<std::string> expansionStack;
    return expandSubcircuit(typeId, expansionStack);
}

SubcircuitExpansionResult SimulationSession::expandSubcircuit(const std::string& typeId,
                                                                std::vector<std::string>& expansionStack) {
    const registry::SubcircuitDefinition* def = m_subcircuits.find(typeId);
    if (!def) throw std::invalid_argument("subcircuito desconhecido: " + typeId);
    if (std::find(expansionStack.begin(), expansionStack.end(), typeId) != expansionStack.end()) {
        throw std::runtime_error("ciclo de dependência de subcircuito detectado envolvendo: " + typeId);
    }
    expansionStack.push_back(typeId);

    const uint32_t rawId = m_nextSubcircuitInstanceId++;
    const uint32_t subcircuitInstanceId = kSubcircuitInstanceFlag | rawId;

    std::unordered_map<std::string, uint32_t> componentIndexByLocalId;
    std::vector<uint32_t> childComponentIndices;
    std::vector<uint32_t> childSubcircuitIds; // subcircuitos aninhados, pra cascata de remoção
    std::optional<uint32_t> primaryMcuInstanceId;

    for (const registry::SubcircuitComponentDef& compDef : def->components) {
        if (isSubcircuitType(compDef.typeId)) {
            const SubcircuitExpansionResult nested = expandSubcircuit(compDef.typeId, expansionStack);
            childSubcircuitIds.push_back(nested.subcircuitInstanceId);
            if (!primaryMcuInstanceId && nested.primaryMcuInstanceId) primaryMcuInstanceId = nested.primaryMcuInstanceId;
            continue; // sem componentIndexByLocalId pra ele: wires nunca miram um subcircuito direto
        }
        const registry::ComponentParams params = paramsFromPropertiesJson(compDef.propertiesJson);
        const uint32_t childIndex = addComponent(compDef.typeId, params);
        componentIndexByLocalId[compDef.id] = childIndex;
        childComponentIndices.push_back(childIndex);
        if (!primaryMcuInstanceId && m_mcus.contains(compDef.typeId)) primaryMcuInstanceId = childIndex;

        if (compDef.typeId == "connectors.tunnel") {
            const std::string internalName = tunnelNameFromPropertiesJson(compDef.propertiesJson);
            if (!internalName.empty()) setTunnelName(childIndex, "pin", "", internalName);
        }
    }

    for (const registry::SubcircuitWireDef& wireDef : def->wires) {
        const auto fromIt = componentIndexByLocalId.find(wireDef.fromComponentId);
        const auto toIt = componentIndexByLocalId.find(wireDef.toComponentId);
        if (fromIt == componentIndexByLocalId.end() || toIt == componentIndexByLocalId.end()) {
            throw std::runtime_error("subcircuito '" + typeId + "': fio interno referencia componente inexistente");
        }
        connectWire(fromIt->second, wireDef.fromPinId, toIt->second, wireDef.toPinId);
    }

    std::unordered_map<std::string, SubcircuitExposedPin> exposedPins;
    for (const registry::SubcircuitInterfaceDef& ifaceDef : def->interfaceDefs) {
        const auto tunnelCompIt = std::find_if(
            def->components.begin(), def->components.end(), [&](const registry::SubcircuitComponentDef& c) {
                return c.typeId == "connectors.tunnel" &&
                       tunnelNameFromPropertiesJson(c.propertiesJson) == ifaceDef.internalTunnel;
            });
        if (tunnelCompIt == def->components.end()) {
            throw std::runtime_error("subcircuito '" + typeId + "': interface '" + ifaceDef.pinId +
                                      "' referencia tunnel interno inexistente: " + ifaceDef.internalTunnel);
        }
        const uint32_t tunnelIndex = componentIndexByLocalId.at(tunnelCompIt->id);
        const std::string externalName = std::to_string(subcircuitInstanceId) + "::" + ifaceDef.internalTunnel;
        setTunnelName(tunnelIndex, "pin", ifaceDef.internalTunnel, externalName);
        exposedPins[ifaceDef.pinId] = SubcircuitExposedPin{tunnelIndex, "pin"};
    }

    std::vector<uint32_t>& children = m_subcircuitChildren[rawId];
    children = std::move(childComponentIndices);
    children.insert(children.end(), childSubcircuitIds.begin(), childSubcircuitIds.end());
    m_subcircuitChildIndexByLocalId[rawId] = std::move(componentIndexByLocalId);

    expansionStack.pop_back();
    return SubcircuitExpansionResult{subcircuitInstanceId, std::move(exposedPins), primaryMcuInstanceId};
}

void SimulationSession::removeSubcircuitInstance(uint32_t subcircuitInstanceId) {
    const uint32_t rawId = subcircuitInstanceId & ~kSubcircuitInstanceFlag;
    const auto it = m_subcircuitChildren.find(rawId);
    if (it == m_subcircuitChildren.end()) return; // já removido, idempotente

    for (uint32_t childId : it->second) {
        if ((childId & kSubcircuitInstanceFlag) != 0) {
            removeSubcircuitInstance(childId); // aninhado -- recursivo
        } else {
            removeComponent(childId);
        }
    }
    m_subcircuitChildren.erase(it);
    m_subcircuitChildIndexByLocalId.erase(rawId);
}

std::optional<uint32_t> SimulationSession::findSubcircuitChildByLocalId(uint32_t subcircuitInstanceId, const std::string& localId) const {
    const uint32_t rawId = subcircuitInstanceId & ~kSubcircuitInstanceFlag;
    const auto it = m_subcircuitChildIndexByLocalId.find(rawId);
    if (it == m_subcircuitChildIndexByLocalId.end()) return std::nullopt;
    const auto childIt = it->second.find(localId);
    if (childIt == it->second.end()) return std::nullopt;
    return childIt->second;
}

std::vector<uint8_t> SimulationSession::getComponentState(uint32_t componentIndex) const {
    IComponentModel* instance = m_componentInstances.at(componentIndex).get();
    if (!instance) throw std::runtime_error("getComponentState: componente removido");

    // 64KiB cobre com folga o maior caso real hoje (Oscope::kHistoryCapacity=512 * 4 canais * 16
    // bytes/amostra ~= 32KiB, ver Oscope.hpp) -- componentes com estado pequeno (a maioria) só
    // usam uma fração disto; `getState()` sempre devolve só os bytes realmente escritos, então
    // este buffer maior não muda o tamanho da resposta de quem já era pequeno.
    std::vector<uint8_t> buffer(65536);
    const size_t written = instance->getState(buffer.data(), buffer.size());
    buffer.resize(written);
    return buffer;
}

PluginHealthStatus SimulationSession::componentHealth(uint32_t componentIndex) const {
    IComponentModel* instance = m_componentInstances.at(componentIndex).get();
    if (!instance) throw std::runtime_error("componentHealth: componente removido");
    return instance->health();
}

std::optional<double> SimulationSession::componentCurrent(uint32_t componentIndex) const {
    if (componentIndex >= m_componentInstances.size()) return std::nullopt;
    IComponentModel* instance = m_componentInstances[componentIndex].get();
    if (!instance) return std::nullopt;
    return instance->current();
}

void SimulationSession::loadMcuFirmware(uint32_t componentIndex, const std::filesystem::path& firmwarePath,
                                        const std::string& arenaName, const std::string& qemuBinaryOverride) {
    IComponentModel* instance = m_componentInstances.at(componentIndex).get();
    if (!instance) throw std::runtime_error("loadMcuFirmware: componente removido");
    auto* mcu = dynamic_cast<mcu::McuComponent*>(instance);
    if (!mcu) throw std::runtime_error("loadMcuFirmware: componente nao e MCU/QEMU");
    mcu->loadFirmware(firmwarePath, arenaName, qemuBinaryOverride);
}

std::string SimulationSession::mcuLogs(uint32_t componentIndex) const {
    IComponentModel* instance = m_componentInstances.at(componentIndex).get();
    if (!instance) throw std::runtime_error("getMcuLogs: componente removido");
    const auto* mcu = dynamic_cast<const mcu::McuComponent*>(instance);
    if (!mcu) throw std::runtime_error("getMcuLogs: componente nao e MCU/QEMU");
    return mcu->qemuLogs();
}

void SimulationSession::sendComponentEvent(uint32_t componentIndex, const ComponentEvent& event) {
    IComponentModel* instance = m_componentInstances.at(componentIndex).get();
    if (!instance) throw std::runtime_error("sendComponentEvent: componente removido");
    instance->onEvent(event);
    m_scheduler.markDirty(componentIndex);
}

void SimulationSession::rebuildTopologyIfNeeded() {
    if (!m_topologyDirty) return;

    std::vector<uint32_t> extraVarCountByComponent(m_componentInstances.size());
    for (size_t i = 0; i < m_componentInstances.size(); ++i) {
        if (m_componentInstances[i]) extraVarCountByComponent[i] = m_componentInstances[i]->extraVariableCount();
    }

    m_topology = m_netlist.rebuildTopology(extraVarCountByComponent);
    m_nodeVoltages.assign(m_topology.listenersByNode.size(), 0.0);
    m_previousNodeVoltages = m_nodeVoltages;
    m_lastEdgeTimeNs.assign(m_topology.listenersByNode.size(), 0);
    m_topologyDirty = false;

    // Topologia mudou: todo componente vivo precisa re-estampar contra os grupos novos — o que
    // existia antes pode ter ido para um CircuitGroup diferente (ou o mesmo grupo, mas com outros
    // vizinhos). Componente removido (instância nula) nunca volta a ficar dirty.
    for (uint32_t i = 0; i < m_componentInstances.size(); ++i) {
        if (m_componentInstances[i]) m_scheduler.dirtySet().insert(i);
    }
}

bool SimulationSession::settleStep() {
    rebuildTopologyIfNeeded();

    if (m_scheduler.dirtySet().empty()) return false; // circuito estável, nada a fazer

    // 1. Estampa todo componente dirty — cada um só vê o CircuitGroup a que pertence (passada 2
    //    do Netlist garante que todos os pinos de um componente caem no mesmo grupo).
    const std::vector<uint32_t> stampedThisRound(m_scheduler.dirtySet().dense().begin(),
                                                  m_scheduler.dirtySet().dense().end());
    for (uint32_t componentIndex : stampedThisRound) {
        IComponentModel* component = m_componentInstances[componentIndex].get();
        const auto& slotsByPinId = m_netlist.pinSlotsOf(componentIndex);

        std::unordered_map<std::string, uint32_t> localIndexByPinId;
        uint32_t groupIndex = UINT32_MAX;
        for (const auto& [pinId, slot] : slotsByPinId) {
            const simulation::PinSlotResolution& resolution = m_topology.resolutionBySlot[slot];
            groupIndex = resolution.groupIndex; // igual para todo pino deste componente, por construção
            localIndexByPinId[pinId] = resolution.localIndex;
        }
        if (groupIndex == UINT32_MAX) continue; // componente sem pinos (não deveria existir)

        std::optional<uint32_t> extraVarBase;
        if (component->extraVariableCount() > 0) {
            extraVarBase = m_topology.extraVariablesByComponent[componentIndex].baseLocalIndex;
        }

        simulation::ComponentMatrixView view(m_topology.groups[groupIndex], localIndexByPinId, componentIndex,
                                             extraVarBase);
        try {
            component->stamp(view);
            view.commit();
        } catch (const std::exception& e) {
            // Fronteira de robustez (não é o CrashGuard de plugin — isso é defesa geral contra
            // exceção de qualquer stamp(), built-in ou plugin, escapando e derrubando a thread do
            // Scheduler). Ver .spec, seção 7.2.
            std::fprintf(stderr, "[SimulationSession] stamp() de componente %u lançou: %s\n", componentIndex,
                         e.what());
        }
    }
    m_scheduler.dirtySet().clear();

    // 2. Resolve só os grupos dirty (admitância ou corrente mudou) — em paralelo entre si.
    m_mnaSolver.solve(m_topology.groups, m_nodeVoltages);

    // 3. Nó cuja tensão de fato mudou: marca dirty quem tem pino lá (listenersByNode).
    bool anyVoltageChanged = false;
    for (size_t node = 0; node < m_nodeVoltages.size(); ++node) {
        if (std::abs(m_nodeVoltages[node] - m_previousNodeVoltages[node]) > kVoltageEpsilon) {
            anyVoltageChanged = true;
            for (uint32_t listener : m_topology.listenersByNode[node]) m_scheduler.dirtySet().insert(listener);
        }
    }

    // 3b. Borda digital (cruzou kDigitalLevelThreshold): dispara ComponentEvent{kPinChangeEventTag}
    // pra CADA pino presente naquele nó (built-in ou plugin, sem dedup -- pinRefsByNode, não
    // listenersByNode). É a ÚNICA fonte de PIN_CHANGE do Core hoje -- protocolo (I2C/SPI/1-wire,
    // ex: WS2812) é decodificado pelo PRÓPRIO device a partir de bordas reais de pino, igual ao
    // SimulIDE -- não por um "barramento" que pula a simulação elétrica.
    for (size_t node = 0; node < m_nodeVoltages.size(); ++node) {
        const bool wasHigh = m_previousNodeVoltages[node] > kDigitalLevelThreshold;
        const bool isHigh = m_nodeVoltages[node] > kDigitalLevelThreshold;
        if (wasHigh == isHigh) continue;

        const uint64_t nowNs = m_scheduler.nowNsUnlocked();
        const uint64_t elapsedNs = nowNs - m_lastEdgeTimeNs[node];
        m_lastEdgeTimeNs[node] = nowNs;
        const uint32_t elapsedClamped =
            static_cast<uint32_t>(std::min<uint64_t>(elapsedNs, std::numeric_limits<uint32_t>::max()));

        for (const simulation::NodePinRef& ref : m_topology.pinRefsByNode[node]) {
            IComponentModel* listener = m_componentInstances[ref.componentIndex].get();
            if (!listener) continue;
            listener->onEvent(ComponentEvent{kPinChangeEventTag, ref.localPinIndex, isHigh ? 1u : 0u, elapsedClamped});
        }
    }

    m_previousNodeVoltages = m_nodeVoltages;

    // 4. Componente não-linear que estampou neste round e ainda não convergiu pede outra
    //    iteração — mesmo que nenhum vizinho tenha mudado tensão o bastante pra disparar isso via
    //    listener (passo 3). Sem componente não-linear real hoje, isto nunca dispara de fato; é
    //    só o contrato/mecânica fixados (ver .spec, seção 7.4) — Newton-Raphson de verdade
    //    (critério de convergência, diodo/transistor) fica para depois.
    bool anyNonlinearPending = false;
    if (m_nonlinearIterations < kMaxNonlinearIterations) {
        for (uint32_t componentIndex : stampedThisRound) {
            IComponentModel* component = m_componentInstances[componentIndex].get();
            if (component->isNonlinear() && !component->hasConverged()) {
                m_scheduler.dirtySet().insert(componentIndex);
                anyNonlinearPending = true;
            }
        }
    } else {
        std::fprintf(stderr, "[SimulationSession] %u componente(s) não convergiram após %u iterações — "
                              "seguindo com último ponto de operação\n",
                     static_cast<unsigned>(stampedThisRound.size()), kMaxNonlinearIterations);
    }
    m_nonlinearIterations = anyNonlinearPending ? m_nonlinearIterations + 1 : 0;

    // Ainda há trabalho se alguma tensão mudou (logo, novos componentes podem ter ficado dirty), se
    // algum não-linear pediu outra iteração, OU se já havia dirty pendente que este round não tocou
    // — isso é o "settle loop" da seção 7 do .spec: só avança Δt quando esta função devolve false.
    return anyVoltageChanged || anyNonlinearPending || !m_scheduler.dirtySet().empty();
}

} // namespace lasecsimul::session
