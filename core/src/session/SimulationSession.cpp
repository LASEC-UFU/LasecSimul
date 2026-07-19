#include "SimulationSession.hpp"
#include <array>
#include <algorithm>
#include <cmath>
#include <cctype>
#include <chrono>
#include <cstdio>
#include <limits>
#include <map>
#include <optional>
#include <span>
#include <stdexcept>
#include <unordered_map>
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
      m_scheduler(componentCapacity, [this] { return settleStep(); }) {
    m_scheduler.setTimeStepCallbacks(
        [this](uint64_t previous, uint64_t current) {
            const TransientStepContext context{current, current - previous, m_transientSettings.method,
                                               m_acceptedTransientSteps.load(std::memory_order_relaxed)};
            for (uint32_t i = 0; i < m_componentInstances.size(); ++i) {
                IComponentModel* component = m_componentInstances[i].get();
                if (!component || !component->isReactive()) continue;
                component->beginTransientStep(context);
                m_scheduler.dirtySet().insert(i);
            }
        },
        [this](uint64_t previous, uint64_t current, bool eventBoundary) -> simulation::Scheduler::TimeStepDecision {
            double maximumError = 0.0;
            if (m_transientSettings.adaptiveTimeStep && !eventBoundary) {
                for (const auto& component : m_componentInstances) {
                    if (component && component->isReactive()) {
                        maximumError = std::max(maximumError, component->transientErrorRatio(
                            m_transientSettings.absoluteTolerance, m_transientSettings.relativeTolerance));
                    }
                }
            }
            if (!m_scheduler.lastSettleConvergedUnlocked()) maximumError = std::max(maximumError, 2.0);
            const bool atMinimumStep = current - previous <= m_transientSettings.minimumStepNs;
            const bool accept = eventBoundary || atMinimumStep || !m_transientSettings.adaptiveTimeStep || maximumError <= 1.0;
            for (const auto& component : m_componentInstances) {
                if (!component || !component->isReactive()) continue;
                if (accept) component->commitTransientStep();
                else component->rollbackTransientStep();
            }
            if (accept) ++m_acceptedTransientSteps;
            else ++m_rejectedTransientSteps;
            return {accept, maximumError};
        });
    m_scheduler.setStableStepCallback([this](uint64_t timestampNs) { onStableStepUnlocked(timestampNs); });
    m_scheduler.setCommandDrainCallback([this] { drainCommandQueue(); });
    m_scheduler.setCommandPendingCallback([this] { return m_commandQueue.hasPending(); });
    setTransientSettings(m_transientSettings);
}

void SimulationSession::enqueueCommand(CommandQueue::Command command) {
    if (!m_scheduler.isRunning()) {
        // Sem worker viva não há com quem competir por m_netlist/m_componentInstances -- aplicar
        // direto aqui (thread de IPC) é seguro E evita bloquear pra sempre esperando uma thread que
        // não existe. Cobre o caso mais comum: editar o circuito (addComponent/connectWire/
        // setProperty/etc.) ANTES do usuário apertar "play" pela primeira vez, ou depois de parar.
        command(*this);
        return;
    }
    if (m_commandQueue.push(std::move(command))) m_scheduler.notifyCommandPending();
}

void SimulationSession::drainCommandQueue() {
    std::deque<CommandQueue::Command> commands = m_commandQueue.takeAll();
    for (CommandQueue::Command& command : commands) command(*this);
}

void SimulationSession::setTransientSettings(const TransientSettings& settings) {
    if (settings.minimumStepNs == 0 || settings.maximumStepNs < settings.minimumStepNs ||
        settings.initialStepNs < settings.minimumStepNs || settings.initialStepNs > settings.maximumStepNs ||
        !(settings.relativeTolerance > 0.0) || !(settings.absoluteTolerance > 0.0)) {
        throw std::invalid_argument("configuracao transiente invalida");
    }
    m_transientSettings = settings;
    m_scheduler.setMaximumTimeStepNs(settings.maximumStepNs);
    m_scheduler.configureAdaptiveTimeStep(settings.initialStepNs, settings.minimumStepNs, settings.adaptiveTimeStep);
    m_scheduler.setMaxNonLinearIterations(settings.maximumNewtonIterations);
}

void SimulationSession::setPerformanceProfilingEnabled(bool enabled) {
    m_performanceProfilingEnabled.store(enabled, std::memory_order_relaxed);
    m_scheduler.setProfilingEnabled(enabled);
}

void SimulationSession::resetPerformanceMetrics() {
    m_componentStamps.store(0, std::memory_order_relaxed);
    m_deviceStampNanoseconds.store(0, std::memory_order_relaxed);
    m_solverCalls.store(0, std::memory_order_relaxed);
    m_solverNanoseconds.store(0, std::memory_order_relaxed);
    m_topologyRebuilds.store(0, std::memory_order_relaxed);
    m_topologyNanoseconds.store(0, std::memory_order_relaxed);
    m_scheduler.resetMetrics();
}

SimulationPerformanceSnapshot SimulationSession::performanceMetrics() const {
    const simulation::Scheduler::MetricsSnapshot schedulerMetrics = m_scheduler.metrics();
    return {m_performanceProfilingEnabled.load(std::memory_order_relaxed),
            m_scheduler.nowNs(), schedulerMetrics.eventsProcessed, schedulerMetrics.timeSteps,
            schedulerMetrics.settleIterations, schedulerMetrics.settleNanoseconds,
            m_componentStamps.load(std::memory_order_relaxed),
            m_deviceStampNanoseconds.load(std::memory_order_relaxed),
            m_solverCalls.load(std::memory_order_relaxed),
            m_solverNanoseconds.load(std::memory_order_relaxed),
            m_topologyRebuilds.load(std::memory_order_relaxed),
            m_topologyNanoseconds.load(std::memory_order_relaxed), schedulerMetrics.pendingEvents,
            m_acceptedTransientSteps.load(std::memory_order_relaxed),
            m_rejectedTransientSteps.load(std::memory_order_relaxed), m_mnaSolver.threadCount()};
}

void SimulationSession::registerKnownPluginTypes() {
    for (const std::string& typeId : m_globalCache.knownDeviceTypeIds()) {
        m_components.replaceFactory(typeId, [this, typeId](const registry::ComponentParams& params) {
            ComponentMeta meta;
            meta.typeId = typeId;
            meta.pins = params.pinList;
            if (const registry::ComponentMetadata* metadata = m_globalCache.metadata().find(typeId)) {
                meta.propertySchema = metadata->propertySchema;
                meta.stepTimeoutMs = metadata->stepTimeoutMs;
                meta.pinSpec = metadata->pinSpec;
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

void SimulationSession::reregisterPinsIfChanged(uint32_t componentIndex, IComponentModel* instance) {
    std::vector<std::string> newPinIds;
    for (const Pin& pin : instance->pins()) newPinIds.push_back(pin.id);

    const std::unordered_map<std::string, uint32_t>& currentSlots = m_netlist.pinSlotsOf(componentIndex);
    bool changed = currentSlots.size() != newPinIds.size();
    if (!changed) {
        for (const std::string& id : newPinIds) {
            if (currentSlots.find(id) == currentSlots.end()) {
                changed = true;
                break;
            }
        }
    }
    if (changed) m_netlist.reregisterComponentPins(componentIndex, newPinIds);
}

uint32_t SimulationSession::addComponent(const std::string& typeId, const registry::ComponentParams& params) {
    return runViaCommandQueue([typeId, params](SimulationSession& self) {
        return self.addComponentUnlocked(typeId, params);
    });
}

uint32_t SimulationSession::addComponentUnlocked(const std::string& typeId, const registry::ComponentParams& params) {
    std::unique_ptr<IComponentModel> instance;
    if (m_components.contains(typeId)) {
        instance = m_components.create(typeId, params);
    } else if (m_mcus.contains(typeId)) {
        instance = std::make_unique<mcu::McuComponent>(m_mcus.create(typeId), m_scheduler, params.pinList);
    } else {
        instance = m_components.create(typeId, params);
    }

    // Caminho único de hidratação: toda propriedade declarada é reaplicada pelo descriptor da
    // instância. Assim factories só precisam dos argumentos indispensáveis ao construtor e nenhum
    // medidor perde campos ao reabrir um projeto.
    for (PropertyDescriptor& descriptor : instance->propertyDescriptors()) {
        const auto value = params.properties.find(descriptor.name);
        if (value != params.properties.end() && propertyKindMatches(value->second, descriptor.schema.valueKind)) {
            descriptor.set(value->second);
        }
    }

    const uint32_t componentIndex = static_cast<uint32_t>(m_componentInstances.size());

    std::vector<std::string> pinIds;
    for (const Pin& pin : instance->pins()) pinIds.push_back(pin.id);
    m_netlist.registerComponent(componentIndex, pinIds);
    for (const Pin& pin : instance->pins()) {
        const std::optional<std::string> tunnel = instance->fallbackTunnelNameForPin(pin.id);
        if (tunnel) m_netlist.setFallbackTunnelName(m_netlist.pinSlotsOf(componentIndex).at(pin.id), *tunnel);
    }

    instance->onAssignedIndex(componentIndex);
    if (!instance->signalSubscriptions().empty()) m_signalSubscribers.push_back(componentIndex);
    m_componentInstances.push_back(std::move(instance));
    if (!params.instanceName.empty()) m_signalAliases[params.instanceName] = componentIndex;
    for (const std::string& alias : params.signalAliases) if (!alias.empty()) m_signalAliases[alias] = componentIndex;
    m_topologyDirty = true;
    m_topologyReuseSafe = false;
    // `dirtySet()` (não `markDirty()`) -- bug real encontrado 2026-07-19 rodando
    // command_queue_session_test pela primeira vez: quando isto roda via drainCommandQueue() dentro
    // de settleUntilStableLocked(), `Scheduler::m_mutex` já está travado pela própria thread
    // (runUntil() segura o lock pelo ciclo inteiro) -- `markDirty()` tenta travar de novo por dentro
    // (mutex não-reentrante), o que lança `std::system_error` ("resource deadlock would occur") em
    // vez de travar silenciosamente. Mesmo cuidado já documentado em `sendComponentEventUnlocked`/
    // `setPropertyUnlocked` ("mutex já pertence ao wrapper"); `addComponent` foi o único dos métodos
    // migrados nesta fase que ainda chamava a versão com lock.
    m_scheduler.dirtySet().insert(componentIndex);
    return componentIndex;
}

ResolvedSignal SimulationSession::resolveSignal(const std::string& reference, std::optional<uint32_t> self) const {
    return m_scheduler.synchronized([&] { return resolveSignalUnlocked(reference, self); });
}

ResolvedSignal SimulationSession::resolveSignalUnlocked(const std::string& reference, std::optional<uint32_t> self) const {
    std::string text;
    for (char c : reference) if (!std::isspace(static_cast<unsigned char>(c))) text.push_back(c);
    if (text.empty()) throw std::invalid_argument("referencia de sinal vazia");

    std::optional<int> msb;
    std::optional<int> lsb;
    const size_t bracket = text.find('[');
    std::string base = bracket == std::string::npos ? text : text.substr(0, bracket);
    if (bracket != std::string::npos) {
        if (text.back() != ']') throw std::invalid_argument("slice sem ] em " + reference);
        const std::string slice = text.substr(bracket + 1, text.size() - bracket - 2);
        const size_t colon = slice.find(':');
        try {
            msb = std::stoi(slice.substr(0, colon));
            lsb = colon == std::string::npos ? *msb : std::stoi(slice.substr(colon + 1));
        } catch (...) { throw std::invalid_argument("indice de barramento invalido em " + reference); }
        if (*msb < 0 || *lsb < 0 || *msb > 63 || *lsb > 63) throw std::out_of_range("indice de barramento fora de 0..63 em " + reference);
    }

    std::optional<uint32_t> component;
    std::string pinId;
    if (base.starts_with("@self.")) {
        if (!self) throw std::invalid_argument("@self usado fora de um componente");
        component = *self;
        pinId = base.substr(6);
    } else if (const size_t dot = base.find('.'); dot != std::string::npos) {
        const auto alias = m_signalAliases.find(base.substr(0, dot));
        if (alias == m_signalAliases.end()) throw std::invalid_argument("componente desconhecido: " + base.substr(0, dot));
        component = alias->second;
        pinId = base.substr(dot + 1);
    } else if (const auto alias = m_signalAliases.find(base); alias != m_signalAliases.end()) {
        component = alias->second;
    }

    std::vector<uint32_t> slots;
    std::vector<int> bitIndices;
    if (component) {
        const auto& byId = m_netlist.pinSlotsOf(*component);
        if (!pinId.empty()) {
            const auto pin = byId.find(pinId);
            if (pin == byId.end()) throw std::invalid_argument("pino desconhecido: " + base);
            slots.push_back(pin->second);
        } else if (msb) {
            const int step = *msb >= *lsb ? 1 : -1;
            for (int bit = *lsb;; bit += step) {
                const auto pin = byId.find("bit-" + std::to_string(bit));
                if (pin == byId.end()) throw std::out_of_range("bit " + std::to_string(bit) + " inexistente em " + base);
                slots.push_back(pin->second);
                bitIndices.push_back(bit);
                if (bit == *msb) break;
            }
        } else {
            for (int bit = 0; bit < 64; ++bit) {
                const auto pin = byId.find("bit-" + std::to_string(bit));
                if (pin == byId.end()) break;
                slots.push_back(pin->second);
                bitIndices.push_back(bit);
            }
            if (slots.empty() && byId.size() == 1) slots.push_back(byId.begin()->second);
            if (slots.empty()) throw std::invalid_argument("componente nao representa sinal unico/barramento: " + base);
        }
    } else if (const auto tunnel = m_netlist.tunnelSlot(base)) {
        if (msb && (*msb != 0 || *lsb != 0)) throw std::out_of_range("sinal escalar nao possui esse indice: " + reference);
        slots.push_back(*tunnel);
    } else {
        for (uint32_t i = 0; i < m_componentInstances.size(); ++i) {
            if (!m_componentInstances[i]) continue;
            const auto& byId = m_netlist.pinSlotsOf(i);
            const auto pin = byId.find(base);
            if (pin == byId.end()) continue;
            if (!slots.empty()) throw std::invalid_argument("sinal ambiguo: " + base);
            slots.push_back(pin->second);
        }
        if (slots.empty()) throw std::invalid_argument("sinal nao encontrado: " + base);
    }

    ResolvedSignal result;
    result.descriptor.source = reference;
    result.descriptor.label = reference;
    result.descriptor.width = static_cast<uint16_t>(slots.size());
    result.descriptor.msb = static_cast<int16_t>(msb.value_or(static_cast<int>(slots.size()) - 1));
    result.descriptor.lsb = static_cast<int16_t>(lsb.value_or(0));
    result.descriptor.kind = slots.size() == 1 ? SignalValueKind::Analog : SignalValueKind::Unsigned;
    result.elements.reserve(slots.size());
    for (uint32_t slot : slots) {
        if (slot >= m_topology.slotToNode.size()) throw std::runtime_error("topologia ainda nao resolvida para " + reference);
        result.elements.push_back(m_nodeVoltages.at(m_topology.slotToNode[slot]));
    }
    return result;
}

void SimulationSession::acquireSubscribedSignalsUnlocked(uint64_t timestampNs) {
    for (uint32_t componentIndex : m_signalSubscribers) {
        IComponentModel* component = m_componentInstances[componentIndex].get();
        if (!component || !component->wantsResolvedSignalSample(timestampNs)) continue;
        const std::vector<SignalSubscription> subscriptions = component->signalSubscriptions();
        if (subscriptions.empty()) continue;
        std::vector<ResolvedSignal> values;
        values.reserve(subscriptions.size());
        for (const SignalSubscription& subscription : subscriptions) {
            ResolvedSignal value = resolveSignalUnlocked(subscription.source, componentIndex);
            value.descriptor.channelId = subscription.channelId;
            value.descriptor.label = subscription.label.empty() ? subscription.source : subscription.label;
            value.descriptor.kind = subscription.requestedKind;
            values.push_back(std::move(value));
        }
        component->onResolvedSignalSample(timestampNs, values);
    }
}

void SimulationSession::setPauseCondition(const std::string& ownerId, const std::string& expression) {
    PauseExpression compiled = PauseExpression::compile(expression);
    m_scheduler.synchronized([&] {
        if (!compiled.empty()) {
            // Validação semântica antes de iniciar; não arma bordas com esta leitura.
            compiled.evaluate([this](PauseSignalMode mode, const std::string& reference) -> PauseScalar {
                if (mode == PauseSignalMode::Current) {
                    const auto alias = m_signalAliases.find(reference);
                    if (alias == m_signalAliases.end()) throw std::invalid_argument("componente de corrente não encontrado: " + reference);
                    IComponentModel* component = m_componentInstances.at(alias->second).get();
                    const auto current = component ? component->current() : std::nullopt;
                    if (!current) throw std::invalid_argument("componente não expõe corrente: " + reference);
                    return *current;
                }
                const ResolvedSignal signal = resolveSignalUnlocked(reference, std::nullopt);
                if (mode == PauseSignalMode::Digital || mode == PauseSignalMode::Rising || mode == PauseSignalMode::Falling)
                    return signal.unsignedValue() != 0;
                if (signal.elements.size() == 1) return signal.elements.front();
                return signal.unsignedValue();
            });
            compiled.resetEdges();
        }
        if (compiled.empty()) m_pauseConditions.erase(ownerId);
        else m_pauseConditions[ownerId] = PauseConditionState{std::move(compiled), false, false};
    });
}

void SimulationSession::onStableStepUnlocked(uint64_t timestampNs) {
    publishSnapshot();
    acquireSubscribedSignalsUnlocked(timestampNs);
    for (auto& [ownerId, condition] : m_pauseConditions) try {
        PauseEvaluation evaluation = condition.expression.evaluate([this](PauseSignalMode mode, const std::string& reference) -> PauseScalar {
            if (mode == PauseSignalMode::Current) {
                const auto alias = m_signalAliases.find(reference);
                if (alias == m_signalAliases.end()) throw std::invalid_argument("componente de corrente não encontrado: " + reference);
                IComponentModel* component = m_componentInstances.at(alias->second).get();
                const auto current = component ? component->current() : std::nullopt;
                if (!current) throw std::invalid_argument("componente não expõe corrente: " + reference);
                return *current;
            }
            const ResolvedSignal signal = resolveSignalUnlocked(reference, std::nullopt);
            if (mode == PauseSignalMode::Digital || mode == PauseSignalMode::Rising || mode == PauseSignalMode::Falling)
                return signal.unsignedValue() != 0;
            if (signal.elements.size() == 1) return signal.elements.front();
            return signal.unsignedValue();
        });
        if (evaluation.value && !condition.wasTrue) {
            m_scheduler.pause();
            if (m_pauseTriggeredCallback) m_pauseTriggeredCallback({ownerId, timestampNs, condition.expression.source(), std::move(evaluation.resolvedValues)});
        }
        condition.wasTrue = evaluation.value;
        condition.errorReported = false;
    } catch (const PauseExpressionError& error) {
        m_scheduler.pause();
        if (!condition.errorReported && m_pauseTriggeredCallback) {
            m_pauseTriggeredCallback({ownerId, timestampNs, condition.expression.source(), {},
                "coluna " + std::to_string(error.column) + ": " + error.what()});
        }
        condition.errorReported = true;
    } catch (const std::exception& error) {
        m_scheduler.pause();
        if (!condition.errorReported && m_pauseTriggeredCallback) m_pauseTriggeredCallback({ownerId, timestampNs, condition.expression.source(), {}, error.what()});
        condition.errorReported = true;
        std::fprintf(stderr, "[PauseCondition] avaliação falhou em %llu ns: %s\n", static_cast<unsigned long long>(timestampNs), error.what());
    }
}

void SimulationSession::publishSnapshot() {
    // m_publishedSnapshot só é lido/escrito sob m_snapshotMutex, SEMPRE -- mesmo aqui, onde só a
    // thread do Scheduler jamais escreve nele (produtor único): um leitor concorrente em
    // currentSnapshot() copia o mesmo shared_ptr, e ler/escrever um shared_ptr sem sincronização
    // dos DOIS lados é data race (só o refcount do control block é atômico, o ponteiro guardado em
    // m_publishedSnapshot em si não é). O trabalho caro (copiar tensões/mapeamento de pinos) fica
    // FORA das duas seções críticas abaixo, que só copiam ponteiros -- por isso duas seções curtas
    // em vez de segurar o mutex pelo tempo inteiro da função.
    auto nodeVoltages = std::make_shared<const std::vector<double>>(m_nodeVoltages);

    std::shared_ptr<const std::vector<uint32_t>> slotToNode;
    std::shared_ptr<const std::vector<std::unordered_map<std::string, uint32_t>>> pinSlotsByComponent;
    bool needsTopologyCopy;
    {
        std::lock_guard<std::mutex> lock(m_snapshotMutex);
        needsTopologyCopy = m_snapshotTopologyStale || !m_publishedSnapshot;
        if (!needsTopologyCopy) {
            slotToNode = m_publishedSnapshot->slotToNode;
            pinSlotsByComponent = m_publishedSnapshot->pinSlotsByComponent;
        }
    }
    if (needsTopologyCopy) {
        // Topologia mudou (ou é a primeira publicação) -- recopia. Caso raro comparado a tensão
        // mudando (várias solve() por segundo, topologia bem mais devagar).
        slotToNode = std::make_shared<const std::vector<uint32_t>>(m_topology.slotToNode);
        pinSlotsByComponent = std::make_shared<const std::vector<std::unordered_map<std::string, uint32_t>>>(
            m_netlist.componentPinSlotsCopy());
    }

    auto snapshot = std::make_shared<const NodeVoltageSnapshot>(
        NodeVoltageSnapshot{std::move(nodeVoltages), std::move(slotToNode), std::move(pinSlotsByComponent)});

    std::lock_guard<std::mutex> lock(m_snapshotMutex);
    m_publishedSnapshot = std::move(snapshot);
    m_snapshotTopologyStale = false;
}

std::optional<double> resolveNodeVoltage(const NodeVoltageSnapshot& snapshot, uint32_t component,
                                          const std::string& pinId) {
    if (!snapshot.pinSlotsByComponent || component >= snapshot.pinSlotsByComponent->size()) return std::nullopt;
    const std::unordered_map<std::string, uint32_t>& slots = (*snapshot.pinSlotsByComponent)[component];
    const auto slotIt = slots.find(pinId);
    if (slotIt == slots.end()) return std::nullopt;
    if (!snapshot.slotToNode || slotIt->second >= snapshot.slotToNode->size()) return std::nullopt;
    const uint32_t node = (*snapshot.slotToNode)[slotIt->second];
    if (!snapshot.nodeVoltages || node >= snapshot.nodeVoltages->size()) return std::nullopt;
    return (*snapshot.nodeVoltages)[node];
}

void SimulationSession::connectWire(uint32_t componentA, const std::string& pinIdA, uint32_t componentB,
                                     const std::string& pinIdB) {
    runViaCommandQueue([componentA, pinIdA, componentB, pinIdB](SimulationSession& self) {
        self.connectWireUnlocked(componentA, pinIdA, componentB, pinIdB);
    });
}

void SimulationSession::connectWireUnlocked(uint32_t componentA, const std::string& pinIdA, uint32_t componentB,
                                             const std::string& pinIdB) {
    if (m_netlist.isComponentRemoved(componentA) || m_netlist.isComponentRemoved(componentB))
        throw std::invalid_argument("SimulationSession::connectWire: componente removido");
    // Arquivos de autoria antigos e alguns packages genéricos usam `pin-N`, enquanto a factory
    // elétrica pode publicar ids semânticos (`p1`, `p2`, `out`...). Preserve primeiro o id exato;
    // o fallback posicional só é aceito para o formato genérico estrito e dentro do span real.
    const auto resolveSlot = [this](uint32_t component, const std::string& pinId) -> uint32_t {
        const auto& slots = m_netlist.pinSlotsOf(component);
        if (const auto exact = slots.find(pinId); exact != slots.end()) return exact->second;
        constexpr std::string_view prefix{"pin-"};
        if (!pinId.starts_with(prefix)) throw std::out_of_range("pin inexistente: " + pinId);
        size_t consumed = 0;
        unsigned long oneBased = 0;
        try { oneBased = std::stoul(pinId.substr(prefix.size()), &consumed); }
        catch (const std::exception&) { throw std::out_of_range("pin inexistente: " + pinId); }
        if (consumed != pinId.size() - prefix.size() || oneBased == 0)
            throw std::out_of_range("pin inexistente: " + pinId);
        const std::span<Pin> pins = m_componentInstances.at(component)->pins();
        if (oneBased > pins.size()) throw std::out_of_range("pin inexistente: " + pinId);
        return slots.at(pins[oneBased - 1].id);
    };
    const auto resolveEndpoint = [&](uint32_t component, const std::string& pinId) {
        std::vector<uint32_t> slots;
        if (const auto busPins = m_componentInstances.at(component)->busEndpointPinIds(pinId)) {
            slots.reserve(busPins->size());
            for (const std::string& bitPin : *busPins) slots.push_back(resolveSlot(component, bitPin));
        } else {
            slots.push_back(resolveSlot(component, pinId));
        }
        return slots;
    };
    const std::vector<uint32_t> slotsA = resolveEndpoint(componentA, pinIdA);
    const std::vector<uint32_t> slotsB = resolveEndpoint(componentB, pinIdB);
    if (slotsA.size() != slotsB.size()) {
        throw std::invalid_argument("larguras de barramento incompatíveis: " + std::to_string(slotsA.size()) +
                                    " e " + std::to_string(slotsB.size()));
    }
    const bool wasDirty = m_topologyDirty;
    for (size_t i = 0; i < slotsA.size(); ++i) m_netlist.connectWire(slotsA[i], slotsB[i]);
    m_topologyDirty = true;
    if (!wasDirty) m_topologyReuseSafe = true;
    ++m_wireTopologyRevision;
}

bool SimulationSession::disconnectWire(uint32_t componentA, const std::string& pinIdA, uint32_t componentB,
                                        const std::string& pinIdB) {
    return runViaCommandQueue([componentA, pinIdA, componentB, pinIdB](SimulationSession& self) {
        return self.disconnectWireUnlocked(componentA, pinIdA, componentB, pinIdB);
    });
}

bool SimulationSession::disconnectWireUnlocked(uint32_t componentA, const std::string& pinIdA, uint32_t componentB,
                                                const std::string& pinIdB) {
    if (m_netlist.isComponentRemoved(componentA) || m_netlist.isComponentRemoved(componentB))
        throw std::invalid_argument("SimulationSession::disconnectWire: componente removido");
    const auto endpointSlots = [&](uint32_t component, const std::string& pinId) {
        std::vector<uint32_t> slots;
        const auto& byId = m_netlist.pinSlotsOf(component);
        if (const auto busPins = m_componentInstances.at(component)->busEndpointPinIds(pinId)) {
            for (const std::string& bitPin : *busPins) slots.push_back(byId.at(bitPin));
        } else {
            slots.push_back(byId.at(pinId));
        }
        return slots;
    };
    const std::vector<uint32_t> slotsA = endpointSlots(componentA, pinIdA);
    const std::vector<uint32_t> slotsB = endpointSlots(componentB, pinIdB);
    if (slotsA.size() != slotsB.size())
        throw std::invalid_argument("larguras de barramento incompatíveis ao desconectar");
    bool removed = false;
    for (size_t i = 0; i < slotsA.size(); ++i) removed = m_netlist.disconnectWire(slotsA[i], slotsB[i]) || removed;
    if (removed) { m_topologyDirty = true; m_topologyReuseSafe = false; ++m_wireTopologyRevision; }
    return removed;
}

uint64_t SimulationSession::applyWireTopologyTransaction(uint64_t baseRevision, const std::vector<WireTopologyOperation>& operations) {
    return runViaCommandQueue([baseRevision, operations](SimulationSession& self) {
        return self.applyWireTopologyTransactionUnlocked(baseRevision, operations);
    });
}

uint64_t SimulationSession::applyWireTopologyTransactionUnlocked(uint64_t baseRevision,
                                                                   const std::vector<WireTopologyOperation>& operations) {
    if (baseRevision != m_wireTopologyRevision)
        throw std::runtime_error("topology_revision_conflict: esperado " + std::to_string(m_wireTopologyRevision) +
                                 ", recebido " + std::to_string(baseRevision));
    // Primeiro valida sem mutar. `connectWireUnlocked` contém aliases posicionais; repetir a
    // resolução aqui seria uma segunda regra, então uma cópia barata do Netlist funciona também
    // como staging.
    simulation::Netlist staged = m_netlist;
    const bool dirtyBefore = m_topologyDirty;
    const bool reuseSafeBefore = m_topologyReuseSafe;
    const uint64_t revisionBefore = m_wireTopologyRevision;
    try {
        for (const WireTopologyOperation& operation : operations) {
            if (operation.kind == WireTopologyOperation::Kind::Connect) {
                connectWireUnlocked(operation.from.component, operation.from.pinId, operation.to.component, operation.to.pinId);
            } else {
                disconnectWireUnlocked(operation.from.component, operation.from.pinId, operation.to.component, operation.to.pinId);
            }
        }
    } catch (...) {
        m_netlist = std::move(staged);
        m_topologyDirty = dirtyBefore;
        m_topologyReuseSafe = reuseSafeBefore;
        m_wireTopologyRevision = revisionBefore;
        throw;
    }
    m_wireTopologyRevision = revisionBefore + 1;
    return m_wireTopologyRevision;
}

void SimulationSession::setTunnelName(uint32_t component, const std::string& pinId, const std::string& oldName,
                                       const std::string& newName) {
    runViaCommandQueue([component, pinId, oldName, newName](SimulationSession& self) {
        self.setTunnelNameUnlocked(component, pinId, oldName, newName);
    });
}

void SimulationSession::setTunnelNameUnlocked(uint32_t component, const std::string& pinId, const std::string& oldName,
                                               const std::string& newName) {
    if (m_netlist.isComponentRemoved(component))
        throw std::invalid_argument("SimulationSession::setTunnelName: componente removido");
    const uint32_t slot = m_netlist.pinSlotsOf(component).at(pinId);
    m_netlist.setTunnelName(slot, oldName, newName);
    m_topologyDirty = true;
    m_topologyReuseSafe = false;
}

std::optional<std::string> SimulationSession::setProperty(uint32_t component, const std::string& propertyName,
                                                          const PropertyValue& value) {
    // Redesign de concorrência 2026-07-19 (fase 2): antes bloqueava a thread de IPC inteira em
    // `Scheduler::synchronized()` até o ciclo de settle em andamento terminar -- mesma classe do bug
    // de head-of-line-blocking já corrigido em `tryDrainUartRx` (ver
    // project_lasecsimul_drainuart_headofline_blocking_fix), só que síncrono em vez de num poll
    // contínuo. Agora enfileira e espera só o Scheduler aplicar (uma iteração de settle, não o ciclo
    // inteiro) -- mesmo contrato observável (código/mensagem de erro idênticos).
    return runViaCommandQueue([component, propertyName, value](SimulationSession& self) {
        return self.setPropertyUnlocked(component, propertyName, value);
    });
}

std::optional<std::string> SimulationSession::setPropertyUnlocked(uint32_t component, const std::string& propertyName,
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
            const bool validOption = std::any_of(schema.options.begin(), schema.options.end(), [&](const PropertyOption& option) {
                if (const std::string* text = std::get_if<std::string>(&value)) return option.value == *text;
                if (const bool* flag = std::get_if<bool>(&value)) return option.value == (*flag ? "true" : "false");
                if (const double* number = std::get_if<double>(&value)) {
                    try { return std::abs(std::stod(option.value) - *number) <= 1e-12; }
                    catch (const std::exception&) { return false; }
                }
                return false;
            });
            if (!validOption) {
                return validationError("invalid_option", "opÃ§Ã£o invÃ¡lida para propriedade: " + propertyName);
            }
        }

        std::unordered_map<std::string, std::string> oldFallbackTunnels;
        for (const Pin& pin : instance->pins()) {
            if (const std::optional<std::string> name = instance->fallbackTunnelNameForPin(pin.id)) {
                oldFallbackTunnels.emplace(pin.id, *name);
            }
        }

        descriptor.set(value);
        if ((schema.flags & PropertySchemaAffectsPinCount) != 0) reregisterPinsIfChanged(component, instance);

        bool fallbackTunnelChanged = false;
        for (const Pin& pin : instance->pins()) {
            const std::optional<std::string> name = instance->fallbackTunnelNameForPin(pin.id);
            if (!name) continue;
            const auto old = oldFallbackTunnels.find(pin.id);
            if (old == oldFallbackTunnels.end() || old->second != *name) fallbackTunnelChanged = true;
            m_netlist.setFallbackTunnelName(m_netlist.pinSlotsOf(component).at(pin.id), *name);
        }
        if ((schema.flags & (PropertySchemaAffectsTopology | PropertySchemaAffectsPinCount)) != 0 || fallbackTunnelChanged) {
            m_topologyDirty = true;
            m_topologyReuseSafe = false;
        }
        m_scheduler.dirtySet().insert(component); // mutex já pertence ao wrapper setProperty()
        return std::nullopt;
    }

    return validationError("unknown_property", "propriedade desconhecida: " + propertyName);
}

std::optional<PropertySchema> SimulationSession::propertySchemaOf(uint32_t component,
                                                                  const std::string& propertyName) const {
    // Bug real de concorrência corrigido 2026-07-19 (fase 1 do redesign de concorrência, ver
    // .claude/plans/idempotent-floating-cat.md): antes lia `m_componentInstances` sem sincronização
    // NENHUMA, concorrente com a thread do Scheduler dentro de settleStep(). Único chamador
    // (CoreApplication.cpp, handler de "setProperty") só usa o resultado pra decidir se marca
    // `requiresRestart` numa resposta de SUCESSO -- nunca pra validar/rejeitar a escrita (isso já é
    // responsabilidade de `setPropertyUnlocked`, chamado em seguida, com seu próprio lock). Por
    // isso "ocupado agora" pode ser tratado igual a "propriedade não encontrada" com segurança --
    // mesmo princípio já usado por `componentCurrent()` (auxiliar/visual, nunca bloqueia, uma
    // leitura indisponível equivale a "sem valor", sem efeito colateral observável).
    auto result = m_scheduler.trySynchronized([&]() -> std::optional<PropertySchema> {
        if (component >= m_componentInstances.size()) return std::nullopt;
        IComponentModel* instance = m_componentInstances[component].get();
        if (!instance) return std::nullopt;
        for (PropertyDescriptor& descriptor : instance->propertyDescriptors()) {
            if (descriptor.name == propertyName) return descriptor.schema;
        }
        return std::nullopt;
    });
    if (!result) return std::nullopt;
    return *result;
}

std::optional<PropertyValue> SimulationSession::propertyValueOf(uint32_t component,
                                                                  const std::string& propertyName) const {
    return m_scheduler.synchronized([&] { return propertyValueOfUnlocked(component, propertyName); });
}

std::optional<PropertyValue> SimulationSession::propertyValueOfUnlocked(uint32_t component,
                                                                         const std::string& propertyName) const {
    if (component >= m_componentInstances.size() || !m_componentInstances[component]) return std::nullopt;
    for (PropertyDescriptor& descriptor : m_componentInstances[component]->propertyDescriptors()) {
        if (descriptor.name == propertyName) return descriptor.get();
    }
    return std::nullopt;
}

void SimulationSession::removeComponent(uint32_t componentIndex) {
    runViaCommandQueue([componentIndex](SimulationSession& self) {
        self.removeComponentUnlocked(componentIndex);
    });
}

void SimulationSession::removeComponentUnlocked(uint32_t componentIndex) {
    IComponentModel* instance = m_componentInstances.at(componentIndex).get();
    if (!instance) return; // já removido, idempotente

    m_netlist.removeComponent(componentIndex);
    m_componentInstances[componentIndex].reset();
    m_scheduler.dirtySet().remove(componentIndex);
    m_topologyDirty = true;
    m_topologyReuseSafe = false;
}

bool SimulationSession::isSubcircuitInstance(uint32_t instanceId) const {
    if ((instanceId & kSubcircuitInstanceFlag) == 0) return false;
    return m_subcircuitChildren.count(instanceId & ~kSubcircuitInstanceFlag) > 0;
}

SubcircuitExpansionResult SimulationSession::addSubcircuitInstance(const std::string& typeId) {
    return runViaCommandQueue([typeId](SimulationSession& self) {
        std::vector<std::string> expansionStack;
        return self.expandSubcircuit(typeId, expansionStack);
    });
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
        registry::ComponentParams params = paramsFromPropertiesJson(compDef.propertiesJson);
        // Subcircuitos armazenam endpoints nos wires, não uma cópia redundante de `pinList` em
        // cada componente. Reconstitui primeiro pelos metadados e completa com todo ID realmente
        // referenciado. Isso preserva IDs semânticos (pin-P1, GPIO23...) sem fallback hardcoded.
        if (const registry::ComponentMetadata* metadata = m_globalCache.metadata().find(compDef.typeId)) {
            params.pinList = metadata->pinSpec ? resolveDynamicPins(*metadata->pinSpec, params.properties)
                                               : metadata->pins;
        }
        const auto appendReferencedPin = [&](const std::string& id) {
            if (id.empty()) return;
            const bool exists = std::any_of(params.pinList.begin(), params.pinList.end(),
                                            [&](const Pin& pin) { return pin.id == id; });
            if (!exists) params.pinList.push_back(Pin{id});
        };
        for (const registry::SubcircuitWireDef& wire : def->wires) {
            if (wire.fromComponentId == compDef.id) appendReferencedPin(wire.fromPinId);
            if (wire.toComponentId == compDef.id) appendReferencedPin(wire.toPinId);
        }
        const uint32_t childIndex = addComponentUnlocked(compDef.typeId, params);
        componentIndexByLocalId[compDef.id] = childIndex;
        childComponentIndices.push_back(childIndex);
        if (!primaryMcuInstanceId && m_mcus.contains(compDef.typeId)) primaryMcuInstanceId = childIndex;

        if (compDef.typeId == "connectors.tunnel") {
            const std::string internalName = tunnelNameFromPropertiesJson(compDef.propertiesJson);
            if (!internalName.empty()) setTunnelNameUnlocked(childIndex, "pin", "", internalName);
        }
    }

    for (const registry::SubcircuitWireDef& wireDef : def->wires) {
        const auto fromIt = componentIndexByLocalId.find(wireDef.fromComponentId);
        const auto toIt = componentIndexByLocalId.find(wireDef.toComponentId);
        if (fromIt == componentIndexByLocalId.end() || toIt == componentIndexByLocalId.end()) {
            throw std::runtime_error("subcircuito '" + typeId + "': fio interno referencia componente inexistente");
        }
        try {
            connectWireUnlocked(fromIt->second, wireDef.fromPinId, toIt->second, wireDef.toPinId);
        } catch (const std::exception& err) {
            throw std::runtime_error(
                "subcircuito '" + typeId + "': fio interno inválido " + wireDef.fromComponentId + "." +
                wireDef.fromPinId + " -> " + wireDef.toComponentId + "." + wireDef.toPinId + ": " + err.what());
        }
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
        setTunnelNameUnlocked(tunnelIndex, "pin", ifaceDef.internalTunnel, externalName);
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
    runViaCommandQueue([subcircuitInstanceId](SimulationSession& self) {
        self.removeSubcircuitInstanceUnlocked(subcircuitInstanceId);
    });
}

void SimulationSession::removeSubcircuitInstanceUnlocked(uint32_t subcircuitInstanceId) {
    const uint32_t rawId = subcircuitInstanceId & ~kSubcircuitInstanceFlag;
    const auto it = m_subcircuitChildren.find(rawId);
    if (it == m_subcircuitChildren.end()) return; // já removido, idempotente

    for (uint32_t childId : it->second) {
        if ((childId & kSubcircuitInstanceFlag) != 0) {
            removeSubcircuitInstanceUnlocked(childId); // aninhado -- recursivo
        } else {
            removeComponentUnlocked(childId);
        }
    }
    m_subcircuitChildren.erase(it);
    m_subcircuitChildIndexByLocalId.erase(rawId);
}

std::optional<uint32_t> SimulationSession::findSubcircuitChildByLocalId(uint32_t subcircuitInstanceId, const std::string& localId) const {
    // Bug real de concorrência corrigido 2026-07-19 (fase 1, ver
    // .claude/plans/idempotent-floating-cat.md): lia `m_subcircuitChildIndexByLocalId` sem
    // sincronização nenhuma. Ao contrário de `propertySchemaOf` acima, aqui `nullopt` JÁ significa
    // algo visível pro usuário ("componente interno não encontrado", ver
    // CoreApplication.cpp/"setSubcircuitChildProperty"/"getSubcircuitChildInstanceId") -- por isso
    // "ocupado agora" tem que LANÇAR (distinguível), nunca virar silenciosamente o mesmo nullopt de
    // "não existe", senão um usuário editando uma propriedade de Modo Placa bem na hora errada veria
    // "componente interno não encontrado" pra um componente que existe perfeitamente.
    auto result = m_scheduler.trySynchronized([&]() -> std::optional<uint32_t> {
        const uint32_t rawId = subcircuitInstanceId & ~kSubcircuitInstanceFlag;
        const auto it = m_subcircuitChildIndexByLocalId.find(rawId);
        if (it == m_subcircuitChildIndexByLocalId.end()) return std::nullopt;
        const auto childIt = it->second.find(localId);
        if (childIt == it->second.end()) return std::nullopt;
        return childIt->second;
    });
    if (!result) throw std::runtime_error("simulacao ocupada; tente novamente");
    return *result;
}

std::vector<uint8_t> SimulationSession::getComponentState(uint32_t componentIndex) const {
    auto result = m_scheduler.trySynchronized([&] {
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
    });
    if (!result) throw std::runtime_error("simulacao ocupada; telemetria adiada");
    return std::move(*result);
}

std::vector<uint8_t> SimulationSession::getComponentTelemetryState(uint32_t componentIndex) const {
    auto states = getComponentTelemetryStates({componentIndex});
    return states.empty() ? std::vector<uint8_t>{} : std::move(states.front());
}

std::vector<std::vector<uint8_t>> SimulationSession::getComponentTelemetryStates(
    const std::vector<uint32_t>& componentIndices) const {
    auto result = m_scheduler.trySynchronized([&] {
        std::vector<std::vector<uint8_t>> states;
        states.reserve(componentIndices.size());
        for (uint32_t componentIndex : componentIndices) {
            IComponentModel* instance = m_componentInstances.at(componentIndex).get();
            if (!instance) throw std::runtime_error("getComponentTelemetryStates: componente removido");

            // Estados periódicos built-in cabem neste buffer pequeno sem heap. O fallback mantém
            // compatibilidade com plugins antigos, cujo default ainda pode devolver um snapshot
            // grande pelo getState().
            std::array<uint8_t, 256> compact{};
            const size_t compactWritten = instance->getTelemetryState(compact.data(), compact.size());
            if (compactWritten > 0 && compactWritten <= compact.size()) {
                states.emplace_back(compact.begin(), compact.begin() + compactWritten);
                continue;
            }
            std::vector<uint8_t> fallback(65536);
            const size_t written = instance->getTelemetryState(fallback.data(), fallback.size());
            fallback.resize(written);
            states.push_back(std::move(fallback));
        }
        return states;
    });
    if (!result) throw std::runtime_error("simulacao ocupada; telemetria adiada");
    return std::move(*result);
}

std::vector<double> SimulationSession::nodeVoltagesOfPins(
    const std::vector<std::pair<uint32_t, std::string>>& probes) const {
    auto result = m_scheduler.trySynchronized([&] {
        std::vector<double> values;
        values.reserve(probes.size());
        for (const auto& [component, pinId] : probes) {
            const uint32_t slot = m_netlist.pinSlotsOf(component).at(pinId);
            const uint32_t node = m_topology.slotToNode.at(slot);
            values.push_back(m_nodeVoltages.at(node));
        }
        return values;
    });
    if (!result) throw std::runtime_error("simulacao ocupada; telemetria adiada");
    return std::move(*result);
}

PluginHealthStatus SimulationSession::componentHealth(uint32_t componentIndex) const {
    // Bug real de concorrência corrigido 2026-07-19 (fase 1, ver
    // .claude/plans/idempotent-floating-cat.md): lia/chamava `m_componentInstances`/`health()` sem
    // sincronização nenhuma, concorrente com stamp()/onEvent() da thread do Scheduler no mesmo
    // objeto. Mesmo padrão de `getComponentState`/`nodeVoltageOfPin` (lança em vez de devolver um
    // valor parcial/inventado quando ocupado -- não existe "PluginHealthStatus vazio" seguro aqui).
    auto result = m_scheduler.trySynchronized([&]() -> PluginHealthStatus {
        IComponentModel* instance = m_componentInstances.at(componentIndex).get();
        if (!instance) throw std::runtime_error("componentHealth: componente removido");
        return instance->health();
    });
    if (!result) throw std::runtime_error("simulacao ocupada; telemetria adiada");
    return *result;
}

std::optional<double> SimulationSession::componentCurrent(uint32_t componentIndex) const {
    auto result = m_scheduler.trySynchronized([&]() -> std::optional<double> {
    if (componentIndex >= m_componentInstances.size()) return std::nullopt;
    IComponentModel* instance = m_componentInstances[componentIndex].get();
    if (!instance) return std::nullopt;
    return instance->current();
    });
    // Leitura auxiliar/visual: nunca espera atrás da worker nem ocupa o canal de controle. Uma
    // amostra indisponível neste instante equivale a "sem leitura"; o próximo frame tenta de novo.
    if (!result) return std::nullopt;
    return *result;
}

void SimulationSession::loadMcuFirmware(uint32_t componentIndex, const std::filesystem::path& firmwarePath,
                                         const std::string& arenaName, const std::string& qemuBinaryOverride,
                                         McuDebugOptions debug) {
    IComponentModel* instance = m_componentInstances.at(componentIndex).get();
    if (!instance) throw std::runtime_error("loadMcuFirmware: componente removido");
    auto* mcu = dynamic_cast<mcu::McuComponent*>(instance);
    if (!mcu) throw std::runtime_error("loadMcuFirmware: componente nao e MCU/QEMU");
    mcu->loadFirmware(firmwarePath, arenaName, qemuBinaryOverride, debug);
}

void SimulationSession::stopMcuFirmware(uint32_t componentIndex) {
    IComponentModel* instance = m_componentInstances.at(componentIndex).get();
    auto* mcu = dynamic_cast<mcu::McuComponent*>(instance);
    if (!mcu) throw std::runtime_error("stopMcuFirmware: componente nao e MCU/QEMU");
    mcu->stopFirmware();
}

void SimulationSession::stopSimulation() {
    // Primeiro interrompe a worker: nenhum componente pode voltar a agendar trabalho enquanto as
    // MCUs são encerradas. reset() também limpa dirty/events, volta o relógio a zero e despausa.
    m_scheduler.stop();
    for (const auto& instance : m_componentInstances) {
        if (auto* mcu = instance ? dynamic_cast<mcu::McuComponent*>(instance.get()) : nullptr) {
            mcu->stopFirmware();
        }
    }
    m_scheduler.reset();
}

std::string SimulationSession::mcuLogs(uint32_t componentIndex) const {
    IComponentModel* instance = m_componentInstances.at(componentIndex).get();
    if (!instance) throw std::runtime_error("getMcuLogs: componente removido");
    const auto* mcu = dynamic_cast<const mcu::McuComponent*>(instance);
    if (!mcu) throw std::runtime_error("getMcuLogs: componente nao e MCU/QEMU");
    return mcu->qemuLogs();
}

mcu::McuComponent* SimulationSession::mcuComponentForTesting(uint32_t componentIndex) const {
    if (componentIndex >= m_componentInstances.size()) return nullptr;
    IComponentModel* instance = m_componentInstances[componentIndex].get();
    return instance ? dynamic_cast<mcu::McuComponent*>(instance) : nullptr;
}

void SimulationSession::sendComponentEvent(uint32_t componentIndex, const ComponentEvent& event) {
    // Bug real de concorrência corrigido 2026-07-19: chamava `instance->onEvent()` sem sincronização
    // nenhuma -- pior que as races de container achadas na mesma auditoria, porque é uma mutação
    // concorrente do MESMO objeto que a thread do Scheduler chama stamp()/onEvent() dentro de
    // settleStep(). Fase 1 usou `trySynchronized` (estopgap, introduzia "ocupado" como falha nova);
    // fase 2 (aqui) move pra fila de comandos -- volta a ser sempre bem-sucedido do ponto de vista de
    // quem chama, igual ao contrato de antes do bug, só que agora sem race nenhuma.
    runViaCommandQueue([componentIndex, event](SimulationSession& self) {
        self.sendComponentEventUnlocked(componentIndex, event);
    });
}

void SimulationSession::sendComponentEventUnlocked(uint32_t componentIndex, const ComponentEvent& event) {
    // `m_scheduler.dirtySet()` (não `markDirty()`) porque `markDirty()` toma `m_mutex` de novo por
    // dentro -- quando isto roda via drainCommandQueue() dentro de settleUntilStableLocked(), o mutex
    // já está travado por quem chamou (mesmo cuidado documentado em `setPropertyUnlocked`, "mutex já
    // pertence ao wrapper"). Quando roda direto (worker não existe, ver `enqueueCommand`), não há
    // mutex nenhum pra disputar -- acesso direto também é seguro nesse caso.
    IComponentModel* instance = m_componentInstances.at(componentIndex).get();
    if (!instance) throw std::runtime_error("sendComponentEvent: componente removido");
    instance->onEvent(event);
    m_scheduler.dirtySet().insert(componentIndex);
}

void SimulationSession::rebuildTopologyIfNeeded() {
    if (!m_topologyDirty) return;

    std::vector<uint32_t> extraVarCountByComponent(m_componentInstances.size());
    for (size_t i = 0; i < m_componentInstances.size(); ++i) {
        if (!m_componentInstances[i]) continue;
        extraVarCountByComponent[i] = m_componentInstances[i]->extraVariableCount();
        const std::span<Pin> pins = m_componentInstances[i]->pins();
        for (size_t local = 0; local < pins.size(); ++local) {
            m_componentInstances[i]->onPinConnectionChanged(
                local, m_netlist.isPinExternallyConnected(static_cast<uint32_t>(i), pins[local].id));
        }
    }

    const bool allowReuse = m_topologyReuseSafe;
    m_topologyReuseSafe = false;
    simulation::Topology previous = std::move(m_topology);
    std::vector<double> previousNodeVoltages = std::move(m_nodeVoltages);
    m_topology = m_netlist.rebuildTopology(extraVarCountByComponent);
    m_nodeVoltages.assign(m_topology.listenersByNode.size(), 0.0);
    m_lastEdgeTimeNs.assign(m_topology.listenersByNode.size(), 0);
    m_topologyDirty = false;
    // Fase 3 do redesign de concorrência: `slotToNode`/`pinSlotsByComponent` do snapshot publicado
    // (ver publishSnapshot()) ficaram obsoletos -- a próxima publicação precisa recopiar os dois em
    // vez de reaproveitar o shared_ptr da publicação anterior.
    m_snapshotTopologyStale = true;

    // Preenche m_nodeVoltages ANTES do reset acima ter zerado tudo: grupo reaproveitado não passa
    // por MnaSolver::solve() de novo (`dirty()` continua false, ver CircuitGroup.hpp) -- sem isto,
    // a tensão de uma rede intocada cairia pra 0 no primeiro rebuild depois de qualquer edição em
    // OUTRA rede, porque o array inteiro acabou de ser zerado e ninguém reescreveria essas posições.
    if (allowReuse) {
        reuseUnaffectedCircuitGroups(previous, previousNodeVoltages);
    } else {
        // Deleção/split/túnel/pinos/componente: rebuild integral + restamp integral é o oracle.
        for (uint32_t i = 0; i < m_componentInstances.size(); ++i)
            if (m_componentInstances[i]) m_scheduler.dirtySet().insert(i);
    }
    m_previousNodeVoltages = m_nodeVoltages;
}

void SimulationSession::reuseUnaffectedCircuitGroups(simulation::Topology& previous,
                                                       const std::vector<double>& previousNodeVoltages) {
    // Agrupa componentIndex vivos por groupIndex, de um lado (`previous` ou `m_topology`) por vez.
    // `pinSlotsOf` nunca muda de número pra um componente já registrado (slot é append-only, nunca
    // reciclado -- .spec seção 7.2) -- por isso o MESMO slot de um componente vivo é um índice válido
    // tanto em `previous.resolutionBySlot` quanto em `m_topology.resolutionBySlot`, desde que o
    // componente já existisse na topologia anterior (checado abaixo por bounds).
    const auto groupComponentSignatures = [this](const simulation::Topology& topology) {
        std::map<uint32_t, std::vector<uint32_t>> byGroup;
        for (uint32_t componentIndex = 0; componentIndex < m_componentInstances.size(); ++componentIndex) {
            if (!m_componentInstances[componentIndex]) continue;
            const auto& slots = m_netlist.pinSlotsOf(componentIndex);
            if (slots.empty()) continue;
            const uint32_t anySlot = slots.begin()->second;
            if (anySlot >= topology.resolutionBySlot.size()) continue; // registrado depois desta topologia
            byGroup[topology.resolutionBySlot[anySlot].groupIndex].push_back(componentIndex);
        }
        std::map<std::vector<uint32_t>, uint32_t> bySignature;
        for (auto& [groupIndex, members] : byGroup) {
            std::sort(members.begin(), members.end());
            bySignature.emplace(std::move(members), groupIndex);
        }
        return bySignature;
    };

    const std::map<std::vector<uint32_t>, uint32_t> oldBySignature = groupComponentSignatures(previous);
    const std::map<std::vector<uint32_t>, uint32_t> newBySignature = groupComponentSignatures(m_topology);

    std::vector<bool> groupReused(m_topology.groups.size(), false);
    for (const auto& [members, newGroupIndex] : newBySignature) {
        const auto oldIt = oldBySignature.find(members);
        if (oldIt == oldBySignature.end()) continue; // conjunto de componentes mudou -- rede nova/afetada
        const uint32_t oldGroupIndex = oldIt->second;

        // Estado iterativo de componente não linear nunca atravessa uma revisão topológica, mesmo
        // quando a ilha parece estruturalmente idêntica. Ele deve reestabilizar contra o novo oracle.
        if (std::any_of(members.begin(), members.end(), [this](uint32_t componentIndex) {
                return m_componentInstances[componentIndex]->isNonlinear();
            })) continue;

        // Mesmo conjunto de componentes não basta: a MESMA fiação entre eles pode ainda assim ter
        // mudado (ex: A-B e B-C viram A-B, B-C E A-C -- 4 nós encolhem pra 3 sem o conjunto de
        // componentes mudar). Só reaproveita se TODO pino de TODO membro caiu no MESMO índice local
        // (linha/coluna da matriz) nos dois lados -- aí sim a estampa acumulada continua válida.
        bool sameStructure = true;
        for (uint32_t componentIndex : members) {
            for (const auto& [pinId, slot] : m_netlist.pinSlotsOf(componentIndex)) {
                (void)pinId;
                if (previous.resolutionBySlot[slot].localIndex != m_topology.resolutionBySlot[slot].localIndex) {
                    sameStructure = false;
                    break;
                }
            }
            if (!sameStructure) break;
            const uint32_t extraCount = m_componentInstances[componentIndex]->extraVariableCount();
            if (extraCount > 0 &&
                previous.extraVariablesByComponent[componentIndex].baseLocalIndex !=
                    m_topology.extraVariablesByComponent[componentIndex].baseLocalIndex) {
                sameStructure = false;
            }
            if (!sameStructure) break;
        }
        if (!sameStructure) continue;
        if (previous.groups[oldGroupIndex].totalSize() != m_topology.groups[newGroupIndex].totalSize()) continue; // defensivo, não deveria divergir se sameStructure
        // Compactar union-find pode deslocar IDs GLOBAIS de redes posteriores quando uma adição
        // funde duas redes anteriores na ordem de slots. CircuitGroup carrega esses IDs; sem igualdade
        // exata, mover a matriz escreveria tensões nos nós errados mesmo com índices locais iguais.
        if (previous.groups[oldGroupIndex].nodeIndices() != m_topology.groups[newGroupIndex].nodeIndices()) continue;

        m_topology.groups[newGroupIndex] = std::move(previous.groups[oldGroupIndex]);
        groupReused[newGroupIndex] = true;

        // O grupo reaproveitado não vai passar por solve() de novo (não está dirty) -- sem isto a
        // leitura de tensão desses nós ficaria em 0.0 (valor do assign() em rebuildTopologyIfNeeded)
        // até a rede voltar a ficar dirty por algum outro motivo. Índices são os mesmos dos dois
        // lados por construção (sameStructure já garantiu que nada mudou nessa rede).
        for (uint32_t nodeIndex : m_topology.groups[newGroupIndex].nodeIndices()) {
            if (nodeIndex < previousNodeVoltages.size()) m_nodeVoltages[nodeIndex] = previousNodeVoltages[nodeIndex];
        }
    }

    // Só marca dirty quem está num grupo NÃO reaproveitado -- grupo reaproveitado já tem a estampa
    // certa (nada mudou na rede dele), re-stampar seria trabalho jogado fora sem efeito no resultado.
    for (uint32_t componentIndex = 0; componentIndex < m_componentInstances.size(); ++componentIndex) {
        if (!m_componentInstances[componentIndex]) continue;
        const auto& slots = m_netlist.pinSlotsOf(componentIndex);
        if (slots.empty()) continue;
        const uint32_t anySlot = slots.begin()->second;
        const uint32_t groupIndex = m_topology.resolutionBySlot[anySlot].groupIndex;
        if (!groupReused[groupIndex]) m_scheduler.dirtySet().insert(componentIndex);
    }
}

bool SimulationSession::settleStep() {
    const bool profile = m_performanceProfilingEnabled.load(std::memory_order_relaxed);
    const bool topologyWasDirty = m_topologyDirty;
    const auto topologyStart = profile && topologyWasDirty ? std::chrono::steady_clock::now()
                                                            : std::chrono::steady_clock::time_point{};
    rebuildTopologyIfNeeded();
    if (profile && topologyWasDirty) {
        m_topologyRebuilds.fetch_add(1, std::memory_order_relaxed);
        m_topologyNanoseconds.fetch_add(static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::steady_clock::now() - topologyStart).count()), std::memory_order_relaxed);
    }

    if (m_scheduler.dirtySet().empty()) return false; // circuito estável, nada a fazer

    // 1. Estampa todo componente dirty — cada um só vê o CircuitGroup a que pertence (passada 2
    //    do Netlist garante que todos os pinos de um componente caem no mesmo grupo).
    const auto dirtyComponents = m_scheduler.dirtySet().dense();
    m_stampedThisRound.assign(dirtyComponents.begin(), dirtyComponents.end());
    const auto deviceStart = profile ? std::chrono::steady_clock::now() : std::chrono::steady_clock::time_point{};
    for (uint32_t componentIndex : m_stampedThisRound) {
        IComponentModel* component = m_componentInstances[componentIndex].get();
        const simulation::ComponentStampResolution& stampResolution =
            m_topology.stampResolutionByComponent[componentIndex];
        const uint32_t groupIndex = stampResolution.groupIndex;
        if (groupIndex == UINT32_MAX) continue; // componente sem pinos (não deveria existir)

        std::optional<uint32_t> extraVarBase;
        if (component->extraVariableCount() > 0) {
            extraVarBase = m_topology.extraVariablesByComponent[componentIndex].baseLocalIndex;
        }

        simulation::ComponentMatrixView view(m_topology.groups[groupIndex], stampResolution.localIndexByPinId, componentIndex,
                                             extraVarBase);
        try {
            component->stamp(view);
            // LeakageGuard (D9, docs/25-auditoria-arquitetural-core-2026-07-09.md): aplicado pelo
            // framework, SEMPRE depois de stamp() (nunca antes -- teria que assumir o pino "vazio"
            // antes mesmo de stamp() decidir se ia estampar de verdade ali ou não; aplicar depois é
            // seguro porque a condutância de fuga é somada, não substitui nada que já foi estampado).
            const std::span<Pin> pins = component->pins();
            for (uint32_t localIndex : component->leakagePinIndices()) {
                if (localIndex < pins.size()) view.addConductanceToGround(pins[localIndex], kLeakageGuardConductance);
            }
            view.commit();
        } catch (const std::exception& e) {
            // Fronteira de robustez (não é o CrashGuard de plugin — isso é defesa geral contra
            // exceção de qualquer stamp(), built-in ou plugin, escapando e derrubando a thread do
            // Scheduler). Ver .spec, seção 7.2.
            std::fprintf(stderr, "[SimulationSession] stamp() de componente %u lançou: %s\n", componentIndex,
                         e.what());
        }
    }
    if (profile) {
        m_componentStamps.fetch_add(m_stampedThisRound.size(), std::memory_order_relaxed);
        m_deviceStampNanoseconds.fetch_add(static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::steady_clock::now() - deviceStart).count()), std::memory_order_relaxed);
    }
    m_scheduler.dirtySet().clear();

    // 2. Resolve só os grupos dirty (admitância ou corrente mudou) — em paralelo entre si.
    const auto solverStart = profile ? std::chrono::steady_clock::now() : std::chrono::steady_clock::time_point{};
    m_mnaSolver.solve(m_topology.groups, m_nodeVoltages);
    if (profile) {
        m_solverCalls.fetch_add(1, std::memory_order_relaxed);
        m_solverNanoseconds.fetch_add(static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::steady_clock::now() - solverStart).count()), std::memory_order_relaxed);
    }

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
        for (uint32_t componentIndex : m_stampedThisRound) {
            IComponentModel* component = m_componentInstances[componentIndex].get();
            if (component->isNonlinear() && !component->hasConverged()) {
                m_scheduler.dirtySet().insert(componentIndex);
                anyNonlinearPending = true;
            }
        }
    } else {
        std::fprintf(stderr, "[SimulationSession] %u componente(s) não convergiram após %u iterações — "
                              "seguindo com último ponto de operação\n",
                     static_cast<unsigned>(m_stampedThisRound.size()), kMaxNonlinearIterations);
    }
    m_nonlinearIterations = anyNonlinearPending ? m_nonlinearIterations + 1 : 0;

    // Ainda há trabalho se alguma tensão mudou (logo, novos componentes podem ter ficado dirty), se
    // algum não-linear pediu outra iteração, OU se já havia dirty pendente que este round não tocou
    // — isso é o "settle loop" da seção 7 do .spec: só avança Δt quando esta função devolve false.
    return anyVoltageChanged || anyNonlinearPending || !m_scheduler.dirtySet().empty();
}

} // namespace lasecsimul::session
