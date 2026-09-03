#include "SimulationSession.hpp"
#include "../components/bridges/SignalBridges.hpp"
#include <array>
#include <algorithm>
#include <cmath>
#include <cctype>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <map>
#include <optional>
#include <random>
#include <span>
#include <stdexcept>
#include <unordered_map>
#include <utility>
#include <nlohmann/json.hpp>
#include "../fpga/FpgaComponent.hpp"
#include "../mcu/ConsumerTrace.hpp"
#include "../mcu/McuComponent.hpp"
#include "../plc/PlcComponent.hpp"
#include "lasecsimul/qemu_arena_abi.h"
#include "lasecsimul/CausalTrace.hpp"
#include "../mcu/qemu/QemuArenaBridge.hpp"

namespace lasecsimul::session {

namespace {
// Abaixo disso, duas tensões são consideradas "a mesma" — evita reativar listeners por ruído de
// ponto flutuante quando um grupo resolve para um valor numericamente idêntico ao anterior.
constexpr double kVoltageEpsilon = 1e-9;


// Mesmo papel do Simulator::m_maxNlstp do SimulIDE — limite de rounds em que o settle-loop é
// mantido vivo só por componente não-linear não convergido, pra nunca girar pra sempre. Contador
// global (não por componente) porque ainda não existe componente não-linear real pra calibrar
// algo mais fino — ver .spec/archive/legacy-v2/lasecsimul.spec, seção 7.4.
constexpr uint32_t kMaxNonlinearIterations = 50;

// Ver SimulationSession::McuPositionTracking (.hpp) -- precisa ficar bem maior que a folga do
// Scheduler (5-20ms) pra nunca excluir por engano um MCU genuinamente lento mas ainda progredindo.
// Ponto de partida a refinar com medição real, não considerado definitivo.
constexpr auto kStaleMcuTimeout = std::chrono::milliseconds(1000);
constexpr size_t kMaxComponentStateBytes = 16u * 1024u * 1024u;

// F9.5: unico typeId de instancia de PLC nesta rodada -- sem paleta/editor grafico ainda (ver plano
// F9), entao nao ha por que ter N "tipos" distintos como MCU (N chips diferentes); o que varia por
// instancia e' o artefato carregado via SimulationSession::loadPlcArtifact(), nao o typeId.
constexpr const char* kPlcInstanceTypeId = "plc.instance";

// Cadência máxima de postStep() por componente dinâmico (ver
// SimulationSession::advanceDynamicComponentsUnlocked). 16'666'667ns = mesma constante de 60Hz que
// simulide-complex/src/lib.c já usa internamente para o tick de rolagem de OLED/servo -- não é um
// valor novo escolhido a dedo, é a granularidade que o único consumidor real já assume.
constexpr uint64_t kDynamicComponentTickNs = 16'666'667ull;

std::vector<uint8_t> readComponentStateWithGrowth(
    IComponentModel& component,
    size_t initialCapacity,
    bool telemetry) {
    std::vector<uint8_t> buffer(initialCapacity);
    const auto read = [&](uint8_t* out, size_t cap) {
        return telemetry ? component.getTelemetryState(out, cap) : component.getState(out, cap);
    };
    size_t written = read(buffer.data(), buffer.size());
    if (written > buffer.size()) {
        if (written > kMaxComponentStateBytes)
            throw std::runtime_error("estado de componente excede limite de 16 MiB");
        buffer.resize(written);
        written = read(buffer.data(), buffer.size());
        if (written > buffer.size())
            throw std::runtime_error("estado de componente mudou de tamanho durante a leitura");
    }
    buffer.resize(written);
    return buffer;
}

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
// spec explicitamente deixa como decisão de implementação (.spec/archive/legacy-v2/lasecsimul-subcircuits.spec,
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

std::optional<SimulationSession::UartRxSnapshot>
SimulationSession::tryDrainUartRx(uint32_t component) const {
    return m_scheduler.trySynchronized([&]() -> UartRxSnapshot {
        UartRxSnapshot snapshot;
        if (const auto dropped = propertyValueOfUnlocked(component, "uart_rx_dropped");
            dropped && std::holds_alternative<double>(*dropped)) {
            snapshot.dropped = std::get<double>(*dropped);
        }

        // Quando o RX do instrumento esta' no mesmo no' de um pino TX dedicado de uma MCU,
        // prefira a copia byte-exata independente publicada pelo modulo USART. O fio continua
        // eletricamente presente e sendo simulado; so' a observacao de texto do instrumento deixa
        // de depender do alinhamento entre a thread QEMU e a amostragem bit-a-bit do plugin.
        if (component < m_componentInstances.size() && m_componentInstances[component]) {
            const auto& slots = m_netlist.pinSlotsOf(component);
            auto rxIt = slots.find("rx");
            if (rxIt == slots.end()) rxIt = slots.find("RX");
            if (rxIt != slots.end() && rxIt->second < m_topology.slotToNode.size()) {
                const uint32_t node = m_topology.slotToNode[rxIt->second];
                if (node < m_topology.pinRefsByNode.size()) {
                    for (const simulation::NodePinRef& ref : m_topology.pinRefsByNode[node]) {
                        if (ref.componentIndex == component ||
                            ref.componentIndex >= m_componentInstances.size()) {
                            continue;
                        }
                        auto* source = dynamic_cast<mcu::McuComponent*>(
                            m_componentInstances[ref.componentIndex].get());
                        if (!source) continue;
                        bool sourceBusy = false;
                        const std::optional<std::string> tapped =
                            source->tryDrainUartTxWireTap(ref.localPinIndex, sourceBusy);
                        if (sourceBusy) {
                            // Nao drene o receptor eletrico: nenhum byte foi obtido do tap e o
                            // proximo poll deve repetir a tentativa integralmente.
                            snapshot.dataHex.clear();
                            snapshot.pending = 0.0;
                            return snapshot;
                        }
                        if (!tapped) continue;

                        // Esvazia a copia eletrica do receptor para ela nao crescer/estourar. Seu
                        // conteudo pode conter bytes corrompidos e nunca e' misturado com o tap.
                        (void)propertyValueOfUnlocked(component, "uart_rx_hex");
                        snapshot.dataHex = *tapped;
                        snapshot.pending = 0.0;
                        return snapshot;
                    }
                }
            }
        }

        const auto data = propertyValueOfUnlocked(component, "uart_rx_hex");
        if (!data || !std::holds_alternative<std::string>(*data)) {
            throw std::runtime_error("componente nao implementa canal UART");
        }
        snapshot.dataHex = std::get<std::string>(*data);
        if (const auto pending = propertyValueOfUnlocked(component, "uart_rx_pending");
            pending && std::holds_alternative<double>(*pending)) {
            snapshot.pending = std::get<double>(*pending);
        }
        return snapshot;
    });
}

SimulationSession::SimulationSession(plugins::GlobalPluginCache& globalCache, size_t componentCapacity,
                                     resources::ResourceGovernor resourceGovernor)
    : m_globalCache(globalCache), m_resourceGovernor(std::move(resourceGovernor)),
      m_pluginRuntime(globalCache), m_mnaSolver(m_resourceGovernor),
      m_scheduler(componentCapacity, [this] { return settleStep(); }),
      m_pythonRuntime(m_resourceGovernor.budget()),
      m_commandQueue(m_resourceGovernor.budget().commandQueueCapacity) {
    m_scheduler.setBeforeExecutionCallback([this] {
        if (!publishSimulationPlan()) {
            throw std::logic_error("SimulationPlan so pode ser publicado com a simulacao parada");
        }
    });
    m_scheduler.setTimeStepCallbacks(
        [this](uint64_t previous, uint64_t current) {
            const TransientStepContext context{current, current - previous, m_transientSettings.method,
                                               m_acceptedTransientSteps.load(std::memory_order_relaxed)};
            // Política cross-domain explícita: atuadores consomem o último sinal ACEITO; sensores
            // só publicarão a solução elétrica atual em onStableStepUnlocked(). Isso introduz uma
            // fronteira causal de um passo aceito e impede loop algébrico interdomínio incidental.
            applySignalActuatorsUnlocked();
            m_runtimeState.signals.beginContinuousStep(previous, current);
            for (uint32_t i : m_reactiveComponentIndices) {
                IComponentModel* component = m_componentInstances[i].get();
                component->beginTransientStep(context);
                m_scheduler.dirtySet().insert(i);
            }
        },
        [this](uint64_t previous, uint64_t current, bool eventBoundary) -> simulation::Scheduler::TimeStepDecision {
            double maximumError = 0.0;
            const double signalError = m_runtimeState.signals.continuousErrorRatio(
                m_transientSettings.absoluteTolerance, m_transientSettings.relativeTolerance);
            if (m_transientSettings.adaptiveTimeStep && !eventBoundary) {
                maximumError = signalError;
                for (uint32_t index : m_reactiveComponentIndices) {
                    IComponentModel* component = m_componentInstances[index].get();
                    maximumError = std::max(maximumError, component->transientErrorRatio(
                        m_transientSettings.absoluteTolerance, m_transientSettings.relativeTolerance));
                }
            }
            if (!m_scheduler.lastSettleConvergedUnlocked()) maximumError = std::max(maximumError, 2.0);
            const bool atMinimumStep = current - previous <= m_transientSettings.minimumStepNs;
            const bool accept = eventBoundary || atMinimumStep || !m_transientSettings.adaptiveTimeStep || maximumError <= 1.0;
            for (uint32_t index : m_reactiveComponentIndices) {
                IComponentModel* component = m_componentInstances[index].get();
                if (accept) component->commitTransientStep();
                else component->rollbackTransientStep();
            }
            if (accept) ++m_acceptedTransientSteps;
            else ++m_rejectedTransientSteps;
            // FPGA (GHDL) só avança quando `current` é o tempo REALMENTE aceito -- nunca no
            // primeiro callback (TimeStepBeginFn), que roda ANTES de o passo adaptativo decidir
            // aceitar/rejeitar. GHDL não tem como "desfazer" um ADVANCE_TO (seu relógio interno é
            // monotônico), então avançá-lo num passo que depois é rejeitado/reencolhido
            // dessincronizaria o GHDL do timeline real do Scheduler pra sempre -- mesma razão pela
            // qual componentes reativos só fazem commitTransientStep() aqui, não no callback de
            // início. Ver plano FPGA, ".claude/plans/golden-puzzling-quasar.md": "o Core continua
            // sendo a autoridade do tempo".
            if (accept) {
                for (const uint32_t index : m_fpgaComponentIndices) {
                    auto* fpgaComponent = static_cast<fpga::FpgaComponent*>(m_componentInstances[index].get());
                    fpgaComponent->advanceLockstep(previous, current);
                }
            }
            if (accept) advanceDynamicComponentsUnlocked(current - previous);
            if (accept) m_runtimeState.signals.commitContinuousStep();
            else m_runtimeState.signals.rollbackContinuousStep();
            return {accept, maximumError};
        });
    m_scheduler.setStableStepCallback([this](uint64_t timestampNs) { onStableStepUnlocked(timestampNs); });
    m_scheduler.setCommandDrainCallback([this] { drainCommandQueue(); });
    m_scheduler.setCommandPendingCallback([this] { return m_commandQueue.hasPending(); });
    m_scheduler.setAdvanceLimitCallback([this] { return computeSlowestMcuPositionNs(); });
    setTransientSettings(m_transientSettings);
}

void SimulationSession::invalidatePlan(simulation::PlanDomain domains) {
    if (domains == simulation::PlanDomain::None) return;
    if ((domains & simulation::PlanDomain::Electrical) != simulation::PlanDomain::None &&
        (!m_signalSubscribers.empty() || !m_pauseConditions.empty())) {
        domains = domains | simulation::PlanDomain::Signal;
    }
    if ((domains & simulation::PlanDomain::Signal) != simulation::PlanDomain::None) {
        m_signalRoutesDirty = true;
    }
    std::lock_guard<std::mutex> lock(m_planMutex);
    ++m_authoringRevision;
    if ((domains & simulation::PlanDomain::Electrical) != simulation::PlanDomain::None) {
        ++m_electricalPlanRevision;
    }
    m_planInvalidation.invalidate(domains);
}

simulation::PlanDomain SimulationSession::refreshComponentExecutionLists(uint32_t componentIndex) {
    IComponentModel* component = componentIndex < m_componentInstances.size()
                                     ? m_componentInstances[componentIndex].get()
                                     : nullptr;
    const auto setMembership = [componentIndex](std::vector<uint32_t>& list, bool member) {
        const auto position = std::lower_bound(list.begin(), list.end(), componentIndex);
        const bool present = position != list.end() && *position == componentIndex;
        if (member == present) return false;
        if (member) list.insert(position, componentIndex);
        else list.erase(position);
        return true;
    };

    simulation::PlanDomain changed = simulation::PlanDomain::None;
    const bool activeChanged = setMembership(m_activeComponentIndices, component != nullptr);
    const bool reactiveChanged = setMembership(m_reactiveComponentIndices, component && component->isReactive());
    const bool nonlinearChanged = setMembership(m_nonlinearComponentIndices, component && component->isNonlinear());
    if (activeChanged || reactiveChanged || nonlinearChanged) {
        changed = changed | simulation::PlanDomain::ExecutionIndex;
    }
    const bool isFpga = component && dynamic_cast<fpga::FpgaComponent*>(component) != nullptr;
    const bool isMcu = component && dynamic_cast<mcu::McuComponent*>(component) != nullptr;
    const bool fpgaChanged = setMembership(m_fpgaComponentIndices, isFpga);
    const bool mcuChanged = setMembership(m_mcuComponentIndices, isMcu);
    if (fpgaChanged || mcuChanged) {
        changed = changed | simulation::PlanDomain::ExecutionIndex | simulation::PlanDomain::External;
    }
    const bool isPlc = component && dynamic_cast<plc::PlcComponent*>(component) != nullptr;
    if (setMembership(m_plcComponentIndices, isPlc)) {
        changed = changed | simulation::PlanDomain::ExecutionIndex | simulation::PlanDomain::Plc;
    }
    if (setMembership(m_signalSubscribers, component && !component->signalSubscriptions().empty())) {
        changed = changed | simulation::PlanDomain::ExecutionIndex | simulation::PlanDomain::Signal;
    }
    if (setMembership(m_dynamicComponentIndices, component && component->isDynamic())) {
        // Sai ou entra na lista: zera o acumulado em vez de deixar (index reciclado por uma
        // instância nova herdaria ns acumulados de quem ocupava este índice antes).
        m_dynamicAccumulatedNs.erase(componentIndex);
        changed = changed | simulation::PlanDomain::ExecutionIndex;
    }
    return changed;
}

bool SimulationSession::publishSimulationPlan() {
    if (m_scheduler.isRunning()) return false;
    simulation::PlanCompileInput input;
    {
        std::lock_guard<std::mutex> lock(m_planMutex);
        if (m_planInvalidation.empty() && m_publishedPlan) return true;
        input.authoringRevision = m_authoringRevision;
        input.electricalRevision = m_electricalPlanRevision;
        input.invalidation = m_planInvalidation;
        input.previous = m_publishedPlan;
    }

    rebuildTopologyIfNeeded();
    rebuildSignalRoutesIfNeeded();
    input.componentCapacity = m_componentInstances.size();
    input.normalizedComponentState.resize(m_componentInstances.size());
    for (uint32_t componentIndex : m_activeComponentIndices) {
        IComponentModel* component = m_componentInstances[componentIndex].get();
        nlohmann::json normalized{{"typeId", component->typeId()}, {"pins", nlohmann::json::array()},
                                  {"properties", nlohmann::json::object()}};
        for (const Pin& pin : component->pins()) normalized["pins"].push_back(pin.id);
        for (PropertyDescriptor& descriptor : component->propertyDescriptors()) {
            normalized["properties"][descriptor.name] = std::visit([](const auto& value) -> nlohmann::json {
                using Value = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<Value, PropertyPoint>) {
                    return nlohmann::json{{"x", value.x}, {"y", value.y}};
                } else {
                    return nlohmann::json(value);
                }
            }, descriptor.get());
        }
        input.normalizedComponentState[componentIndex] = normalized.dump();
    }
    input.electricalTopology = &m_topology;
    input.execution = m_runtimeState.execution;
    input.resolvedSignalSubscribers = m_runtimeState.resolvedSignalSubscribers;
    input.signalGraph = &m_signalGraphDefinition;
    input.electricalSignalBridges = m_electricalSignalBridgeDefinitions;
    input.pythonBlocks.reserve(m_pythonBlockDefinitions.size());
    for (const auto& block : m_pythonBlockDefinitions) {
        input.pythonBlocks.push_back({block.blockId, block.source, block.rateGroupId, block.dependencies});
    }
    input.plcInstances.reserve(m_plcComponentIndices.size());
    for (uint32_t componentIndex : m_plcComponentIndices) {
        auto* plcComponent = static_cast<plc::PlcComponent*>(m_componentInstances[componentIndex].get());
        simulation::PlcInstanceDescriptor descriptor;
        descriptor.componentIndex = componentIndex;
        if (plcComponent->artifact()) {
            descriptor.artifact = std::make_shared<const plc::PlcNativeModule>(*plcComponent->artifact());
        }
        descriptor.taskIntervalNs = plcComponent->taskIntervalNs();
        descriptor.ioBindingRequests = plcComponent->ioBindingRequests();
        input.plcInstances.push_back(std::move(descriptor));
    }

    // Staging: nenhuma referência publicada muda antes de compile() concluir integralmente.
    std::shared_ptr<const simulation::SimulationPlan> staged = simulation::PlanCompiler::compile(input);
    m_runtimeState.bind(staged);
    m_runtimeState.signals.executeUntil(m_runtimeState.virtualTimeNs);
    if (const std::optional<uint64_t> next = m_runtimeState.signals.nextEventNs();
        next && *next > m_runtimeState.virtualTimeNs &&
        (!m_signalBoundaryScheduledNs || *next < *m_signalBoundaryScheduledNs)) {
        m_signalBoundaryScheduledNs = *next;
        const uint64_t generation = m_signalScheduleGeneration;
        m_scheduler.scheduleAt(*next, [this, boundary = *next, generation] {
            if (generation != m_signalScheduleGeneration || m_signalBoundaryScheduledNs != boundary) return;
            m_signalBoundaryScheduledNs.reset();
            m_runtimeState.signals.noteExplicitBoundary(boundary);
        });
    }
    schedulePlcScansUnlocked(m_runtimeState.virtualTimeNs);
    {
        std::lock_guard<std::mutex> lock(m_planMutex);
        m_publishedPlan = std::move(staged);
        m_planInvalidation.clear(input.invalidation.domains());
    }
    return true;
}

void SimulationSession::setSignalGraph(simulation::SignalGraphDefinition definition) {
    runViaCommandQueue([definition = std::move(definition)](SimulationSession& self) mutable {
        if (self.m_scheduler.isRunning()) {
            throw std::runtime_error("setSignalGraph requer simulacao parada para publicar SignalPlan");
        }
        // Compile before mutating authoring state so a malformed graph is transactionally rejected.
        (void)simulation::SignalCompiler::compile(definition);
        self.m_signalGraphDefinition = std::move(definition);
        self.m_signalBoundaryScheduledNs.reset();
        ++self.m_signalScheduleGeneration;
        self.invalidatePlan(simulation::PlanDomain::Signal);
    });
}

void SimulationSession::setElectricalSignalBridges(
    std::vector<simulation::ElectricalSignalBridgeDefinition> definitions) {
    runViaCommandQueue([definitions = std::move(definitions)](SimulationSession& self) mutable {
        if (self.m_scheduler.isRunning())
            throw std::runtime_error("setElectricalSignalBridges requer simulacao parada");
        const auto engine = simulation::SignalCompiler::compile(self.m_signalGraphDefinition);
        std::unordered_set<uint32_t> components;
        std::unordered_set<std::string> sensorTargets;
        for (const auto& bridge : definitions) {
            if (bridge.componentIndex >= self.m_componentInstances.size() ||
                !self.m_componentInstances[bridge.componentIndex])
                throw std::invalid_argument("bridge referencia componente inexistente");
            if (!components.insert(bridge.componentIndex).second)
                throw std::invalid_argument("componente possui mais de um bridge");
            const char* expectedType = nullptr;
            bool sensor = false;
            switch (bridge.kind) {
            case simulation::ElectricalSignalBridgeKind::VoltageSensor:
                expectedType = "bridges.voltage_sensor"; sensor = true; break;
            case simulation::ElectricalSignalBridgeKind::CurrentSensor:
                expectedType = "bridges.current_sensor"; sensor = true; break;
            case simulation::ElectricalSignalBridgeKind::DigitalInput:
                expectedType = "bridges.digital_input"; sensor = true; break;
            case simulation::ElectricalSignalBridgeKind::ControlledVoltageSource:
                expectedType = "bridges.controlled_voltage_source"; break;
            case simulation::ElectricalSignalBridgeKind::ControlledCurrentSource:
                expectedType = "bridges.controlled_current_source"; break;
            case simulation::ElectricalSignalBridgeKind::DigitalOutput:
                expectedType = "bridges.digital_output"; break;
            }
            if (std::string_view(self.m_componentInstances[bridge.componentIndex]->typeId()) != expectedType)
                throw std::invalid_argument("kind do bridge nao corresponde ao componente eletrico");
            const simulation::SignalPortDefinition output =
                simulation::SignalCompiler::outputDefinition(engine, bridge.signalBlockId);
            const bool digital = bridge.kind == simulation::ElectricalSignalBridgeKind::DigitalInput ||
                                 bridge.kind == simulation::ElectricalSignalBridgeKind::DigitalOutput;
            const simulation::SignalScalarType expectedScalar = digital
                ? simulation::SignalScalarType::Bool : simulation::SignalScalarType::Real;
            std::string_view expectedUnit;
            if (bridge.kind == simulation::ElectricalSignalBridgeKind::VoltageSensor ||
                bridge.kind == simulation::ElectricalSignalBridgeKind::ControlledVoltageSource) expectedUnit = "V";
            else if (bridge.kind == simulation::ElectricalSignalBridgeKind::CurrentSensor ||
                     bridge.kind == simulation::ElectricalSignalBridgeKind::ControlledCurrentSource) expectedUnit = "A";
            if (output.type.scalar != expectedScalar || output.type.width != 1 || output.unit != expectedUnit)
                throw std::invalid_argument("tipo/largura/unidade incompativel no bridge: " + bridge.signalBlockId);
            if (sensor) {
                if (!simulation::SignalCompiler::isExternalInput(engine, bridge.signalBlockId))
                    throw std::invalid_argument("sensor bridge exige ExternalInput");
                if (!sensorTargets.insert(bridge.signalBlockId).second)
                    throw std::invalid_argument("mais de um sensor publica no mesmo ExternalInput");
            }
        }
        self.m_electricalSignalBridgeDefinitions = std::move(definitions);
        self.invalidatePlan(simulation::PlanDomain::Signal);
    });
}

void SimulationSession::setPythonBlocks(std::vector<python::PythonBlockDefinition> definitions) {
    runViaCommandQueue([definitions = std::move(definitions)](SimulationSession& self) mutable {
        if (self.m_scheduler.isRunning())
            throw std::runtime_error("setPythonBlocks requer simulacao parada para publicar PythonPlan");
        // PythonRuntime::configure validates IDs and payload before mutating the session plan.
        self.m_pythonRuntime.configure(definitions);
        self.m_pythonBlockDefinitions = std::move(definitions);
        self.invalidatePlan(simulation::PlanDomain::Python);
    });
}

std::vector<python::PythonStepResult> SimulationSession::stepPythonBatch(
    const std::string& rateGroupId, const std::vector<python::PythonStep>& steps) {
    return runViaCommandQueue([rateGroupId, steps](SimulationSession& self) {
        if (!self.publishSimulationPlan() && !self.m_scheduler.isRunning())
            throw std::runtime_error("falha ao publicar PythonPlan");
        std::shared_ptr<const simulation::SimulationPlan> plan;
        {
            std::lock_guard<std::mutex> lock(self.m_planMutex);
            plan = self.m_publishedPlan;
        }
        if (!plan || !plan->python) throw std::runtime_error("PythonPlan nao publicado");
        std::vector<std::string> expected;
        for (const auto& block : plan->python->blocks) {
            if (block.rateGroupId == rateGroupId) expected.push_back(block.blockId);
        }
        if (expected.size() != steps.size())
            throw std::invalid_argument("STEP_BATCH deve conter exatamente o RateGroup publicado");
        for (size_t i = 0; i < expected.size(); ++i) {
            if (steps[i].blockId != expected[i])
                throw std::invalid_argument("STEP_BATCH fora da ordem deterministica do PythonPlan");
        }
        try {
            return self.m_pythonRuntime.stepBatch(self.m_scheduler.nowNs(), rateGroupId, steps);
        } catch (...) {
            self.m_scheduler.pause();
            throw;
        }
    });
}

void SimulationSession::restartPythonRuntime() {
    runViaCommandQueue([](SimulationSession& self) { self.m_pythonRuntime.restart(); });
}

void SimulationSession::loadPlcArtifact(uint32_t componentIndex, std::optional<plc::PlcNativeModule> module) {
    runViaCommandQueue([componentIndex, module = std::move(module)](SimulationSession& self) mutable {
        if (self.m_scheduler.isRunning()) {
            throw std::runtime_error("loadPlcArtifact requer simulacao parada para publicar SimulationPlan");
        }
        if (componentIndex >= self.m_componentInstances.size() || !self.m_componentInstances[componentIndex]) {
            throw std::invalid_argument("loadPlcArtifact: componente inexistente");
        }
        auto* plcComponent = dynamic_cast<plc::PlcComponent*>(self.m_componentInstances[componentIndex].get());
        if (!plcComponent) throw std::invalid_argument("loadPlcArtifact: componente nao e uma instancia de PLC");

        // Worker do artefato ANTERIOR (se houver) e' destruido dentro de loadArtifact() (troca
        // m_runtime); nenhum scan pode estar "no ar" pra esta instancia enquanto a simulacao esta
        // parada (pre-condicao ja checada acima), entao nao ha corrida com runPlcScanUnlocked().
        plcComponent->loadArtifact(std::move(module));
        self.reregisterPinsIfChanged(componentIndex, plcComponent);
        self.m_plcScanScheduledNs.erase(componentIndex);
        ++self.m_plcScanGeneration[componentIndex];
        self.m_topologyDirty = true;
        self.m_topologyReuseSafe = false;
        self.invalidatePlan(simulation::PlanDomain::Electrical | simulation::PlanDomain::Plc);
        self.m_scheduler.dirtySet().insert(componentIndex);
    });
}

void SimulationSession::setPlcIoBindings(uint32_t componentIndex, std::vector<simulation::PlcIoBindingRequest> requests) {
    runViaCommandQueue([componentIndex, requests = std::move(requests)](SimulationSession& self) mutable {
        if (self.m_scheduler.isRunning()) {
            throw std::runtime_error("setPlcIoBindings requer simulacao parada para publicar SimulationPlan");
        }
        if (componentIndex >= self.m_componentInstances.size() || !self.m_componentInstances[componentIndex]) {
            throw std::invalid_argument("setPlcIoBindings: componente inexistente");
        }
        auto* plcComponent = dynamic_cast<plc::PlcComponent*>(self.m_componentInstances[componentIndex].get());
        if (!plcComponent) throw std::invalid_argument("setPlcIoBindings: componente nao e uma instancia de PLC");
        plcComponent->setIoBindingRequests(std::move(requests));
        // Resolucao/validacao real (tipo/ExternalInput/duplicatas) so acontece dentro de
        // PlanCompiler::compile() na proxima publishSimulationPlan() -- mesmo padrao de
        // setElectricalSignalBridges (que tambem valida via SignalCompiler::compile ali mesmo
        // e nao aqui, ainda que este caminho especifico nao precise recompilar o grafo).
        self.invalidatePlan(simulation::PlanDomain::Plc);
    });
}

void SimulationSession::setPlcTaskIntervalNs(uint32_t componentIndex, uint64_t intervalNs) {
    runViaCommandQueue([componentIndex, intervalNs](SimulationSession& self) {
        if (self.m_scheduler.isRunning()) {
            throw std::runtime_error("setPlcTaskIntervalNs requer simulacao parada para publicar SimulationPlan");
        }
        if (intervalNs == 0) throw std::invalid_argument("setPlcTaskIntervalNs: intervalo deve ser > 0");
        if (componentIndex >= self.m_componentInstances.size() || !self.m_componentInstances[componentIndex]) {
            throw std::invalid_argument("setPlcTaskIntervalNs: componente inexistente");
        }
        auto* plcComponent = dynamic_cast<plc::PlcComponent*>(self.m_componentInstances[componentIndex].get());
        if (!plcComponent) throw std::invalid_argument("setPlcTaskIntervalNs: componente nao e uma instancia de PLC");
        plcComponent->setTaskIntervalNs(intervalNs);
        self.invalidatePlan(simulation::PlanDomain::Plc);
    });
}

plc::PlcRuntime& SimulationSession::requirePlcRuntimeUnlocked(uint32_t componentIndex, const char* callerName) {
    if (componentIndex >= m_componentInstances.size() || !m_componentInstances[componentIndex]) {
        throw std::invalid_argument(std::string(callerName) + ": componente inexistente");
    }
    auto* plcComponent = dynamic_cast<plc::PlcComponent*>(m_componentInstances[componentIndex].get());
    if (!plcComponent) throw std::invalid_argument(std::string(callerName) + ": componente nao e uma instancia de PLC");
    plc::PlcRuntime* runtime = plcComponent->runtime();
    if (!runtime) throw std::invalid_argument(std::string(callerName) + ": instancia de PLC sem artefato/worker carregado");
    return *runtime;
}

std::string SimulationSession::plcGetVariable(uint32_t componentIndex, const std::string& qualifiedName) {
    return runViaCommandQueue([componentIndex, qualifiedName](SimulationSession& self) {
        return self.requirePlcRuntimeUnlocked(componentIndex, "plcGetVariable").get(qualifiedName);
    });
}

std::string SimulationSession::plcSetVariable(uint32_t componentIndex, const std::string& qualifiedName, const std::string& value) {
    return runViaCommandQueue([componentIndex, qualifiedName, value](SimulationSession& self) {
        return self.requirePlcRuntimeUnlocked(componentIndex, "plcSetVariable").set(qualifiedName, value);
    });
}

std::string SimulationSession::plcForceVariable(uint32_t componentIndex, const std::string& qualifiedName, const std::string& value) {
    return runViaCommandQueue([componentIndex, qualifiedName, value](SimulationSession& self) {
        return self.requirePlcRuntimeUnlocked(componentIndex, "plcForceVariable").force(qualifiedName, value);
    });
}

std::string SimulationSession::plcUnforceVariable(uint32_t componentIndex, const std::string& qualifiedName) {
    return runViaCommandQueue([componentIndex, qualifiedName](SimulationSession& self) {
        return self.requirePlcRuntimeUnlocked(componentIndex, "plcUnforceVariable").unforce(qualifiedName);
    });
}

void SimulationSession::plcReset(uint32_t componentIndex) {
    runViaCommandQueue([componentIndex](SimulationSession& self) {
        self.requirePlcRuntimeUnlocked(componentIndex, "plcReset").reset();
    });
}

plc::PlcRuntimeState SimulationSession::plcRuntimeState(uint32_t componentIndex) const {
    if (componentIndex >= m_componentInstances.size() || !m_componentInstances[componentIndex]) {
        throw std::invalid_argument("plcRuntimeState: componente inexistente");
    }
    const auto* plcComponent = dynamic_cast<const plc::PlcComponent*>(m_componentInstances[componentIndex].get());
    if (!plcComponent) throw std::invalid_argument("plcRuntimeState: componente nao e uma instancia de PLC");
    const plc::PlcRuntime* runtime = plcComponent->runtime();
    return runtime ? runtime->state() : plc::PlcRuntimeState::Stopped;
}

std::shared_ptr<const simulation::SimulationPlan> SimulationSession::simulationPlan() {
    if (!m_scheduler.isRunning()) publishSimulationPlan();
    std::lock_guard<std::mutex> lock(m_planMutex);
    return m_publishedPlan;
}

void SimulationSession::enqueueCommand(CommandQueue::Command command) {
    if (!m_scheduler.isRunning() || m_scheduler.isCurrentThreadWorker()) {
        // Sem worker viva não há com quem competir por m_netlist/m_componentInstances -- aplicar
        // direto aqui (thread de IPC) é seguro E evita bloquear pra sempre esperando uma thread que
        // não existe. Cobre o caso mais comum: editar o circuito (addComponent/connectWire/
        // setProperty/etc.) ANTES do usuário apertar "play" pela primeira vez, ou depois de parar.
        //
        // O segundo caso (bug real de desempenho achado 2026-07-19 perfilando o Core ao vivo): quem
        // chamou já É a própria thread do Scheduler (ex.: código do MCU rodando dentro de
        // `onPollEvent()`, que é um callback síncrono de `scheduleAt`) -- enfileirar aqui seria
        // `runViaCommandQueue` alocar uma `std::promise` e bloquear em `future.get()` esperando esta
        // MESMA thread se desbloquear sozinha na próxima iteração de drenagem, sem nenhum outro
        // consumidor concorrente possível nesse caso. Aplicar direto preserva o mesmo contrato
        // observável (síncrono do ponto de vista de quem chama) sem a alocação/fila/espera.
        command(*this);
        return;
    }
    const CommandQueue::PushResult result = m_commandQueue.push(std::move(command));
    if (result == CommandQueue::PushResult::Full) {
        throw std::runtime_error("fila de comandos atingiu a capacidade do ResourceBudget");
    }
    if (result == CommandQueue::PushResult::First) m_scheduler.notifyCommandPending();
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
    m_runtimeState.signals.resetMetrics();
    m_pythonRuntime.resetMetrics();
}

SimulationPerformanceSnapshot SimulationSession::performanceMetrics() const {
    const simulation::Scheduler::MetricsSnapshot schedulerMetrics = m_scheduler.metrics();
    const simulation::SignalRuntimeMetrics& signalMetrics = m_runtimeState.signals.metrics();
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
            m_rejectedTransientSteps.load(std::memory_order_relaxed),
            signalMetrics.acceptedDynamicSteps, signalMetrics.rejectedDynamicSteps,
            signalMetrics.discontinuityEvents, signalMetrics.lastAcceptedDynamicStepNs,
            signalMetrics.lastDynamicErrorRatio, m_mnaSolver.threadCount(),
            m_mnaSolver.workerThreadCount(), m_mnaSolver.resourceBudget().maxParallelTasks,
            schedulerMetrics.maxSettleNanoseconds, schedulerMetrics.maxSettleAtNowNs,
            schedulerMetrics.advanceLimitWaitCount, schedulerMetrics.advanceLimitWaitNanoseconds};
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
    if (m_scheduler.isRunning()) {
        throw std::runtime_error("addComponent requer simulacao parada para publicar SimulationPlan");
    }
    std::unique_ptr<IComponentModel> instance;
    if (m_components.contains(typeId)) {
        instance = m_components.create(typeId, params);
    } else if (m_mcus.contains(typeId)) {
        instance = std::make_unique<mcu::McuComponent>(m_mcus.create(typeId), m_scheduler, params.pinList);
        // Fast path de transferência I2C (ver resolveI2cTransferUnlocked): a fila/handshake da
        // arena roda numa thread de fundo por MCU, então este handler pode ser chamado de QUALQUER
        // thread -- `mcuIndex` é resolvido depois (onAssignedIndex ainda não rodou aqui), por isso
        // a lambda captura `this` e recebe o índice como parâmetro de setI2cTransferHandler no
        // ponto de chamada real (McuComponent::processI2cBurstLocked já sabe seu próprio índice).
        static_cast<mcu::McuComponent*>(instance.get())->setI2cTransferHandler(
            [this](uint32_t mcuIndex, uint32_t bus, const I2cTransfer& transfer) -> I2cTransferResult {
                /* McuComponent garante este contrato: chamada direta quando já está na worker ou
                 * chamada externa envolvida por Scheduler::synchronized(). Reentrar aqui no mesmo
                 * mutex faria a thread externa tentar travá-lo duas vezes. */
                return resolveI2cTransferUnlocked(mcuIndex, bus, transfer);
            });
    } else if (typeId == kPlcInstanceTypeId) {
        // Sem registry proprio (ao contrario de MCU/plugins) -- ha um unico "tipo" de instancia de
        // PLC nesta rodada (sem editor grafico/paleta de dispositivos PLC ainda), diferente de MCU
        // que tem N chips distintos. Sobe sem artefato (zero pinos) -- loadPlcArtifact() e' quem
        // carrega o PlcNativeModule depois, mesmo padrao de loadFirmware() do McuComponent.
        instance = std::make_unique<plc::PlcComponent>();
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
    m_componentInstances.push_back(std::move(instance));
    const simulation::PlanDomain executionChanges = refreshComponentExecutionLists(componentIndex);
    if (!params.instanceName.empty()) m_signalAliases[params.instanceName] = componentIndex;
    for (const std::string& alias : params.signalAliases) if (!alias.empty()) m_signalAliases[alias] = componentIndex;
    m_topologyDirty = true;
    m_topologyReuseSafe = false;
    invalidatePlan(simulation::PlanDomain::Electrical | executionChanges);
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

simulation::SignalPlan::Route SimulationSession::compileSignalRouteUnlocked(
    const std::string& reference, std::optional<uint32_t> self) const {
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
        for (uint32_t i : m_activeComponentIndices) {
            const auto& byId = m_netlist.pinSlotsOf(i);
            const auto pin = byId.find(base);
            if (pin == byId.end()) continue;
            if (!slots.empty()) throw std::invalid_argument("sinal ambiguo: " + base);
            slots.push_back(pin->second);
        }
        if (slots.empty()) throw std::invalid_argument("sinal nao encontrado: " + base);
    }

    simulation::SignalPlan::Route route;
    route.descriptor.source = reference;
    route.descriptor.label = reference;
    route.descriptor.width = static_cast<uint16_t>(slots.size());
    route.descriptor.msb = static_cast<int16_t>(msb.value_or(static_cast<int>(slots.size()) - 1));
    route.descriptor.lsb = static_cast<int16_t>(lsb.value_or(0));
    route.descriptor.kind = slots.size() == 1 ? SignalValueKind::Analog : SignalValueKind::Unsigned;
    route.nodeIndices.reserve(slots.size());
    for (uint32_t slot : slots) {
        if (slot >= m_topology.slotToNode.size()) throw std::runtime_error("topologia ainda nao resolvida para " + reference);
        route.nodeIndices.push_back(m_topology.slotToNode[slot]);
    }
    return route;
}

ResolvedSignal SimulationSession::sampleSignalRouteUnlocked(const simulation::SignalPlan::Route& route) const {
    ResolvedSignal result;
    result.descriptor = route.descriptor;
    result.elements.reserve(route.nodeIndices.size());
    for (uint32_t node : route.nodeIndices) result.elements.push_back(m_nodeVoltages.at(node));
    return result;
}

ResolvedSignal SimulationSession::resolveSignalUnlocked(const std::string& reference,
                                                         std::optional<uint32_t> self) const {
    return sampleSignalRouteUnlocked(compileSignalRouteUnlocked(reference, self));
}

void SimulationSession::rebuildSignalRoutesIfNeeded() {
    if (!m_signalRoutesDirty) return;
    std::vector<simulation::SignalPlan::Subscriber> resolved;
    resolved.reserve(m_signalSubscribers.size());
    for (uint32_t componentIndex : m_signalSubscribers) {
        IComponentModel* component = m_componentInstances[componentIndex].get();
        simulation::SignalPlan::Subscriber subscriber;
        subscriber.componentIndex = componentIndex;
        const std::vector<SignalSubscription> subscriptions = component->signalSubscriptions();
        subscriber.channels.reserve(subscriptions.size());
        for (const SignalSubscription& subscription : subscriptions) {
            simulation::SignalPlan::Route route =
                compileSignalRouteUnlocked(subscription.source, componentIndex);
            route.descriptor.channelId = subscription.channelId;
            route.descriptor.label = subscription.label.empty() ? subscription.source : subscription.label;
            route.descriptor.kind = subscription.requestedKind;
            subscriber.channels.push_back(std::move(route));
        }
        resolved.push_back(std::move(subscriber));
    }
    m_runtimeState.resolvedSignalSubscribers = std::move(resolved);
    for (auto& [ownerId, condition] : m_pauseConditions) {
        (void)ownerId;
        for (auto& [reference, route] : condition.signalRoutes) {
            route = compileSignalRouteUnlocked(reference, std::nullopt);
        }
    }
    m_signalRoutesDirty = false;
}

void SimulationSession::acquireSubscribedSignalsUnlocked(uint64_t timestampNs) {
    for (const simulation::SignalPlan::Subscriber& subscriber : m_runtimeState.resolvedSignalSubscribers) {
        IComponentModel* component = m_componentInstances[subscriber.componentIndex].get();
        if (!component->wantsResolvedSignalSample(timestampNs)) continue;
        std::vector<ResolvedSignal> values;
        values.reserve(subscriber.channels.size());
        for (const simulation::SignalPlan::Route& route : subscriber.channels)
            values.push_back(sampleSignalRouteUnlocked(route));
        component->onResolvedSignalSample(timestampNs, values);
    }
}

void SimulationSession::setPauseCondition(const std::string& ownerId, const std::string& expression) {
    PauseExpression compiled = PauseExpression::compile(expression);
    m_scheduler.synchronized([&] {
        PauseConditionState next;
        if (!compiled.empty()) {
            // Validação semântica antes de iniciar; não arma bordas com esta leitura.
            compiled.evaluate([this, &next](PauseSignalMode mode, const std::string& reference) -> PauseScalar {
                if (mode == PauseSignalMode::Current) {
                    const auto alias = m_signalAliases.find(reference);
                    if (alias == m_signalAliases.end()) throw std::invalid_argument("componente de corrente não encontrado: " + reference);
                    IComponentModel* component = m_componentInstances.at(alias->second).get();
                    const auto current = component ? component->current() : std::nullopt;
                    if (!current) throw std::invalid_argument("componente não expõe corrente: " + reference);
                    next.currentComponents[reference] = alias->second;
                    return *current;
                }
                simulation::SignalPlan::Route route = compileSignalRouteUnlocked(reference, std::nullopt);
                const ResolvedSignal signal = sampleSignalRouteUnlocked(route);
                next.signalRoutes[reference] = std::move(route);
                if (mode == PauseSignalMode::Digital || mode == PauseSignalMode::Rising || mode == PauseSignalMode::Falling)
                    return signal.unsignedValue() != 0;
                if (signal.elements.size() == 1) return signal.elements.front();
                return signal.unsignedValue();
            });
            compiled.resetEdges();
        }
        if (compiled.empty()) m_pauseConditions.erase(ownerId);
        else {
            next.expression = std::move(compiled);
            m_pauseConditions[ownerId] = std::move(next);
        }
    });
}

void SimulationSession::applySignalActuatorsUnlocked() {
    for (const simulation::SignalPlan::BridgeBinding& binding : m_runtimeState.electricalSignalBridges) {
        const uint32_t componentIndex = binding.definition.componentIndex;
        if (componentIndex >= m_componentInstances.size() || !m_componentInstances[componentIndex]) continue;
        bool changed = false;
        switch (binding.definition.kind) {
        case simulation::ElectricalSignalBridgeKind::ControlledVoltageSource:
            changed = static_cast<components::SignalControlledVoltageSource*>(m_componentInstances[componentIndex].get())
                          ->setCommand(m_runtimeState.signals.real(binding.signal));
            break;
        case simulation::ElectricalSignalBridgeKind::ControlledCurrentSource:
            changed = static_cast<components::SignalControlledCurrentSource*>(m_componentInstances[componentIndex].get())
                          ->setCommand(m_runtimeState.signals.real(binding.signal));
            break;
        case simulation::ElectricalSignalBridgeKind::DigitalOutput:
            changed = static_cast<components::SignalDigitalOutput*>(m_componentInstances[componentIndex].get())
                          ->setCommand(m_runtimeState.signals.boolean(binding.signal));
            break;
        default:
            break;
        }
        if (changed) m_scheduler.dirtySet().insert(componentIndex);
    }
}

void SimulationSession::advanceDynamicComponentsUnlocked(uint64_t acceptedDeltaNs) {
    if (acceptedDeltaNs == 0 || m_dynamicComponentIndices.empty()) return;
    for (const uint32_t index : m_dynamicComponentIndices) {
        uint64_t& accumulated = m_dynamicAccumulatedNs[index];
        accumulated += acceptedDeltaNs;
        if (accumulated < kDynamicComponentTickNs) continue;
        // Entrega o acumulado (não só o delta do último passo aceito) -- o consumidor real
        // (simulide-complex/src/lib.c::post_step) só faz `elapsed_ns += dt_ns`, então lotes maiores
        // e mais raros são equivalentes a muitos pequenos, sem perda de precisão temporal.
        m_componentInstances[index]->postStep(accumulated);
        accumulated = 0;
    }
}

void SimulationSession::publishElectricalSensorsToSignalUnlocked() {
    for (const simulation::SignalPlan::BridgeBinding& binding : m_runtimeState.electricalSignalBridges) {
        const uint32_t componentIndex = binding.definition.componentIndex;
        if (componentIndex >= m_componentInstances.size() || !m_componentInstances[componentIndex]) continue;
        switch (binding.definition.kind) {
        case simulation::ElectricalSignalBridgeKind::VoltageSensor:
            m_runtimeState.signals.setExternalReal(
                binding.definition.signalBlockId,
                static_cast<components::SignalVoltageSensor*>(m_componentInstances[componentIndex].get())->measuredValue());
            break;
        case simulation::ElectricalSignalBridgeKind::CurrentSensor:
            m_runtimeState.signals.setExternalReal(
                binding.definition.signalBlockId,
                static_cast<components::SignalCurrentSensor*>(m_componentInstances[componentIndex].get())->measuredValue());
            break;
        case simulation::ElectricalSignalBridgeKind::DigitalInput:
            m_runtimeState.signals.setExternalBool(
                binding.definition.signalBlockId,
                static_cast<components::SignalDigitalInput*>(m_componentInstances[componentIndex].get())->measuredValue());
            break;
        default:
            break;
        }
    }
}

void SimulationSession::onStableStepUnlocked(uint64_t timestampNs) {
    m_runtimeState.virtualTimeNs = timestampNs;
    publishElectricalSensorsToSignalUnlocked();
    m_runtimeState.signals.executeUntil(timestampNs);
    scheduleNextSignalBoundaryUnlocked(timestampNs);
    publishSnapshot();
    publishTelemetrySnapshotIfRequested(timestampNs);
    acquireSubscribedSignalsUnlocked(timestampNs);
    for (auto& [ownerId, condition] : m_pauseConditions) try {
        PauseEvaluation evaluation = condition.expression.evaluate([this, &condition](PauseSignalMode mode, const std::string& reference) -> PauseScalar {
            if (mode == PauseSignalMode::Current) {
                const auto compiled = condition.currentComponents.find(reference);
                if (compiled == condition.currentComponents.end())
                    throw std::invalid_argument("handle de corrente nao compilado: " + reference);
                IComponentModel* component = m_componentInstances.at(compiled->second).get();
                const auto current = component ? component->current() : std::nullopt;
                if (!current) throw std::invalid_argument("componente não expõe corrente: " + reference);
                return *current;
            }
            const auto compiled = condition.signalRoutes.find(reference);
            if (compiled == condition.signalRoutes.end())
                throw std::invalid_argument("handle de sinal nao compilado: " + reference);
            const ResolvedSignal signal = sampleSignalRouteUnlocked(compiled->second);
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

std::vector<std::vector<uint8_t>> SimulationSession::captureComponentTelemetryStatesUnlocked(
    const std::vector<uint32_t>& componentIndices) const {
    std::vector<std::vector<uint8_t>> states;
    states.reserve(componentIndices.size());
    for (uint32_t componentIndex : componentIndices) {
        if (componentIndex >= m_componentInstances.size() || !m_componentInstances[componentIndex])
            throw std::runtime_error("getComponentTelemetryStates: componente removido");

        IComponentModel& instance = *m_componentInstances[componentIndex];
        std::array<uint8_t, 256> compact{};
        const size_t compactWritten = instance.getTelemetryState(compact.data(), compact.size());
        if (compactWritten > 0 && compactWritten <= compact.size()) {
            states.emplace_back(compact.begin(), compact.begin() + compactWritten);
            continue;
        }
        states.push_back(readComponentStateWithGrowth(instance, 65536, true));
    }
    return states;
}

void SimulationSession::publishTelemetrySnapshotIfRequested(uint64_t timestampNs) {
    std::vector<uint32_t> subscriptions;
    uint64_t requestedGeneration = 0;
    {
        std::lock_guard<std::mutex> lock(m_telemetrySnapshotMutex);
        if (m_telemetryRequestedGeneration == m_telemetryPublishedGeneration) return;
        requestedGeneration = m_telemetryRequestedGeneration;
        subscriptions.assign(m_telemetrySubscriptions.begin(), m_telemetrySubscriptions.end());
    }
    std::sort(subscriptions.begin(), subscriptions.end());

    auto snapshot = std::make_shared<ComponentTelemetrySnapshot>();
    snapshot->planGeneration = m_runtimeState.planGeneration;
    snapshot->telemetryGeneration = m_telemetryFrameGeneration.fetch_add(1, std::memory_order_relaxed) + 1;
    snapshot->timestampNs = timestampNs;
    snapshot->nodeVoltages = currentSnapshot();
    snapshot->states.resize(m_componentInstances.size());
    const uint64_t rawFrameLimit = m_resourceGovernor.budget().telemetryQueueBytes / 2;
    uint64_t capturedBytes = 0;
    for (uint32_t componentIndex : subscriptions) {
        if (componentIndex >= m_componentInstances.size() || !m_componentInstances[componentIndex]) continue;
        try {
            std::vector<std::vector<uint8_t>> captured =
                captureComponentTelemetryStatesUnlocked({componentIndex});
            if (captured.front().size() > rawFrameLimit - std::min(rawFrameLimit, capturedBytes)) continue;
            capturedBytes += captured.front().size();
            snapshot->states[componentIndex] = std::move(captured.front());
        } catch (const std::exception&) {
            // Um plugin defeituoso nao pode interromper a worker nem impedir os demais estados.
        }
    }

    std::lock_guard<std::mutex> lock(m_telemetrySnapshotMutex);
    m_publishedTelemetrySnapshot = std::move(snapshot);
    m_telemetryPublishedGeneration = requestedGeneration;
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
    if (m_scheduler.isRunning()) {
        throw std::runtime_error("connectWire requer simulacao parada para publicar ElectricalPlan");
    }
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
    invalidatePlan(simulation::PlanDomain::Electrical);
}

bool SimulationSession::disconnectWire(uint32_t componentA, const std::string& pinIdA, uint32_t componentB,
                                        const std::string& pinIdB) {
    return runViaCommandQueue([componentA, pinIdA, componentB, pinIdB](SimulationSession& self) {
        return self.disconnectWireUnlocked(componentA, pinIdA, componentB, pinIdB);
    });
}

bool SimulationSession::disconnectWireUnlocked(uint32_t componentA, const std::string& pinIdA, uint32_t componentB,
                                                const std::string& pinIdB) {
    if (m_scheduler.isRunning()) {
        throw std::runtime_error("disconnectWire requer simulacao parada para publicar ElectricalPlan");
    }
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
    if (removed) {
        m_topologyDirty = true;
        m_topologyReuseSafe = false;
        ++m_wireTopologyRevision;
        invalidatePlan(simulation::PlanDomain::Electrical);
    }
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
    uint64_t authoringRevisionBefore = 0;
    uint64_t electricalRevisionBefore = 0;
    simulation::PlanInvalidation invalidationBefore;
    {
        std::lock_guard<std::mutex> lock(m_planMutex);
        authoringRevisionBefore = m_authoringRevision;
        electricalRevisionBefore = m_electricalPlanRevision;
        invalidationBefore = m_planInvalidation;
    }
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
        {
            std::lock_guard<std::mutex> lock(m_planMutex);
            m_authoringRevision = authoringRevisionBefore;
            m_electricalPlanRevision = electricalRevisionBefore;
            m_planInvalidation = invalidationBefore;
        }
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
    if (m_scheduler.isRunning()) {
        throw std::runtime_error("setTunnelName requer simulacao parada para publicar ElectricalPlan");
    }
    if (m_netlist.isComponentRemoved(component))
        throw std::invalid_argument("SimulationSession::setTunnelName: componente removido");
    const uint32_t slot = m_netlist.pinSlotsOf(component).at(pinId);
    m_netlist.setTunnelName(slot, oldName, newName);
    m_topologyDirty = true;
    m_topologyReuseSafe = false;
    invalidatePlan(simulation::PlanDomain::Electrical);
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
        if (m_scheduler.isRunning() &&
            (schema.flags & (PropertySchemaAffectsTopology | PropertySchemaAffectsPinCount)) != 0) {
            return validationError("requires_stop", "propriedade estrutural requer simulacao parada: " + propertyName);
        }
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
        simulation::PlanDomain executionChanges = refreshComponentExecutionLists(component);
        if (std::binary_search(m_signalSubscribers.begin(), m_signalSubscribers.end(), component)) {
            // A lista pode continuar contendo o mesmo observer enquanto suas sources/channels mudam.
            executionChanges = executionChanges | simulation::PlanDomain::Signal;
        }

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
            invalidatePlan(simulation::PlanDomain::Electrical | executionChanges);
        } else if (executionChanges != simulation::PlanDomain::None) {
            invalidatePlan(executionChanges);
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

std::optional<std::optional<PropertyValue>> SimulationSession::tryPropertyValueOf(
    uint32_t component, const std::string& propertyName) const {
    return m_scheduler.trySynchronized([&] {
        return propertyValueOfUnlocked(component, propertyName);
    });
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
    if (m_scheduler.isRunning()) {
        throw std::runtime_error("removeComponent requer simulacao parada para publicar SimulationPlan");
    }
    IComponentModel* instance = m_componentInstances.at(componentIndex).get();
    if (!instance) return; // já removido, idempotente

    m_netlist.removeComponent(componentIndex);
    m_componentInstances[componentIndex].reset();
    const simulation::PlanDomain executionChanges = refreshComponentExecutionLists(componentIndex);
    m_mcuPositionTracking.erase(componentIndex);
    m_plcScanScheduledNs.erase(componentIndex);
    ++m_plcScanGeneration[componentIndex]; // invalida qualquer callback de scan ainda no ar pra este componentIndex.
    m_scheduler.dirtySet().remove(componentIndex);
    m_topologyDirty = true;
    m_topologyReuseSafe = false;
    invalidatePlan(simulation::PlanDomain::Electrical | executionChanges);
}

void SimulationSession::scheduleNextSignalBoundaryUnlocked(uint64_t timestampNs) {
    const std::optional<uint64_t> next = m_runtimeState.signals.nextEventNs();
    if (!next || *next <= timestampNs) return;
    if (m_signalBoundaryScheduledNs && *m_signalBoundaryScheduledNs <= *next) return;
    m_signalBoundaryScheduledNs = *next;
    const uint64_t generation = m_signalScheduleGeneration;
    m_scheduler.scheduleEventUnlocked(*next - timestampNs, [this, boundary = *next, generation] {
        if (generation != m_signalScheduleGeneration || m_signalBoundaryScheduledNs != boundary) return;
        m_signalBoundaryScheduledNs.reset();
        m_runtimeState.signals.noteExplicitBoundary(boundary);
    });
}

namespace {

std::string toUpperAscii(const std::string& text) {
    std::string upper = text;
    for (char& c : upper) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
    return upper;
}

/** Formata o valor atual do slot do Signal Engine como texto no formato que `PlcScanSession`
 * espera pra `SCAN <requestId> <timeNs> NOME=valor` (ver `var_set_value` em
 * `PlcVariableCommands.hpp`) -- BOOL vira TRUE/FALSE, os demais tipos (Round 1: todos mapeiam pra
 * Real ou Int64 do Signal Engine, ver `plcIoScalarType` em SimulationPlan.cpp) viram a
 * representação decimal padrão de `std::to_string`. */
std::string plcSignalValueToText(const simulation::PlcIoBinding& binding, const simulation::SignalRuntime& signals) {
    if (!binding.signal) return binding.iecType == "BOOL" ? "FALSE" : "0";
    if (binding.iecType == "BOOL") return signals.boolean(*binding.signal) ? "TRUE" : "FALSE";
    if (binding.iecType == "REAL" || binding.iecType == "LREAL") return std::to_string(signals.real(*binding.signal));
    return std::to_string(signals.integer(*binding.signal));
}

} // namespace

void SimulationSession::scheduleOnePlcScanUnlocked(uint32_t componentIndex, uint64_t fromTimeNs, uint64_t intervalNs) {
    const uint64_t nextScanNs = fromTimeNs + intervalNs;
    const uint64_t generation = ++m_plcScanGeneration[componentIndex];
    m_plcScanScheduledNs[componentIndex] = nextScanNs;
    m_scheduler.scheduleEventUnlocked(intervalNs, [this, componentIndex, nextScanNs, generation] {
        if (m_plcScanGeneration[componentIndex] != generation) return; // substituido/invalidado.
        const auto pending = m_plcScanScheduledNs.find(componentIndex);
        if (pending == m_plcScanScheduledNs.end() || pending->second != nextScanNs) return; // obsoleto.
        m_plcScanScheduledNs.erase(pending);
        runPlcScanUnlocked(componentIndex, nextScanNs);
    });
}

void SimulationSession::schedulePlcScansUnlocked(uint64_t timestampNs) {
    for (const simulation::PlcInstancePlan& instance : m_runtimeState.plcInstances) {
        if (!instance.artifact) continue; // sem artefato -- nada a agendar (zero pinos, zero scans).
        if (m_plcScanScheduledNs.count(instance.componentIndex)) continue; // ja tem scan pendente.
        scheduleOnePlcScanUnlocked(instance.componentIndex, timestampNs, instance.taskIntervalNs);
    }
}

void SimulationSession::runPlcScanUnlocked(uint32_t componentIndex, uint64_t scanTimeNs) {
    const simulation::PlcInstancePlan* planEntry = nullptr;
    for (const simulation::PlcInstancePlan& instance : m_runtimeState.plcInstances) {
        if (instance.componentIndex == componentIndex) { planEntry = &instance; break; }
    }
    // Instancia removida ou artefato descarregado entre o agendamento e agora -- nao reagenda,
    // nao publica nada; a proxima publishSimulationPlan() (se a instancia voltar a existir com
    // artefato) e' quem da a partida de novo via schedulePlcScansUnlocked.
    if (!planEntry || !planEntry->artifact) return;
    if (componentIndex >= m_componentInstances.size() || !m_componentInstances[componentIndex]) return;

    auto* plcComponent = static_cast<plc::PlcComponent*>(m_componentInstances[componentIndex].get());
    plc::PlcRuntime* runtime = plcComponent->runtime();
    if (!runtime) return;

    // InputLatch: TODOS os inputs sao lidos do Signal Engine ANTES de chamar scan() -- atomicidade
    // por scan (mesmo contrato ja provado em F9.2/F9.4, aqui so alimentado por uma fonte real em
    // vez de valores passados direto no teste).
    plc::PlcScanRequest request;
    request.simulationTimeNs = static_cast<int64_t>(scanTimeNs);
    std::unordered_set<std::string> signalBoundInputNames;
    for (const simulation::PlcIoBinding& binding : planEntry->ioBindings) {
        if (binding.direction == "input" && !binding.signalBlockId.empty()) {
            signalBoundInputNames.insert(binding.name);
            signalBoundInputNames.insert(binding.ioId);
        }
    }
    plcComponent->appendElectricalInputs(request, signalBoundInputNames);
    for (const simulation::PlcIoBinding& binding : planEntry->ioBindings) {
        if (binding.direction != "input") continue;
        request.inputs[toUpperAscii(binding.name)] = plcSignalValueToText(binding, m_runtimeState.signals);
    }

    plc::PlcScanResult result;
    try {
        result = runtime->scan(request);
    } catch (const plc::PlcRuntimeError&) {
        // PlcRuntime ja transitou pra Faulted e nao devolveu nenhum PlcScanResult -- nenhuma saida
        // e publicada, esta instancia nao reagenda (fica parada ate reset/restart explicito, fora
        // do escopo desta rodada), Core e as outras instancias PLC seguem normalmente.
        return;
    }

    // OutputCommit: so publica depois de uma resposta COMPLETA e valida -- nunca parcial.
    bool anyOutputChanged = false;
    for (const simulation::PlcIoBinding& binding : planEntry->ioBindings) {
        if (binding.direction != "output" || binding.signalBlockId.empty()) continue;
        const auto found = result.outputs.find(toUpperAscii(binding.name));
        if (found == result.outputs.end()) continue; // defensivo -- nao deveria faltar um output exportado.
        if (binding.iecType == "BOOL") {
            m_runtimeState.signals.setExternalBool(binding.signalBlockId, found->second == "TRUE");
        } else {
            // Round 1: compilePlc() ja rejeita outputs mapeados pra Int64 (SignalRuntime nao tem
            // setExternalInt) -- aqui so sobra REAL/LREAL.
            m_runtimeState.signals.setExternalReal(binding.signalBlockId, std::stod(found->second));
        }
        anyOutputChanged = true;
    }
    anyOutputChanged = plcComponent->commitElectricalOutputs(result.outputs) || anyOutputChanged;
    if (anyOutputChanged) m_scheduler.dirtySet().insert(componentIndex);

    // Reagenda o PROXIMO scan desta MESMA instancia -- nunca dois eventos pendentes ao mesmo tempo
    // pra mesma task: cada callback so agenda o seguinte estritamente `taskIntervalNs` a frente do
    // `scanTimeNs` que ele mesmo acabou de processar, entao a mesma task nunca recebe dois SCAN no
    // mesmo timestamp (ver relatorio de F9.5, secao "Tempo").
    scheduleOnePlcScanUnlocked(componentIndex, scanTimeNs, planEntry->taskIntervalNs);
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
    if (m_scheduler.isRunning()) {
        throw std::runtime_error("addSubcircuitInstance requer simulacao parada para publicar SimulationPlan");
    }
    const registry::SubcircuitDefinition* def = m_subcircuits.find(typeId);
    if (!def) throw std::invalid_argument("subcircuito desconhecido: " + typeId);
    if (std::find(expansionStack.begin(), expansionStack.end(), typeId) != expansionStack.end()) {
        throw std::runtime_error("ciclo de dependência de subcircuito detectado envolvendo: " + typeId);
    }
    expansionStack.push_back(typeId);

    const uint32_t rawId = m_nextSubcircuitInstanceId++;
    const uint32_t subcircuitInstanceId = kSubcircuitInstanceFlag | rawId;

    std::unordered_map<std::string, uint32_t> componentIndexByLocalId;
    std::unordered_map<std::string, SubcircuitExpansionResult> nestedExpansionByLocalId;
    std::vector<uint32_t> childComponentIndices;
    std::vector<uint32_t> childSubcircuitIds; // subcircuitos aninhados, pra cascata de remoção
    std::optional<uint32_t> primaryMcuInstanceId;

    try {
    for (const registry::SubcircuitComponentDef& compDef : def->components) {
        if (isSubcircuitType(compDef.typeId)) {
            const SubcircuitExpansionResult nested = expandSubcircuit(compDef.typeId, expansionStack);
            childSubcircuitIds.push_back(nested.subcircuitInstanceId);
            if (!primaryMcuInstanceId && nested.primaryMcuInstanceId) primaryMcuInstanceId = nested.primaryMcuInstanceId;
            componentIndexByLocalId[compDef.id] = nested.subcircuitInstanceId;
            nestedExpansionByLocalId.emplace(compDef.id, nested);
            continue;
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

    const auto resolveEndpoint = [&](const std::string& localId, const std::string& portId) {
        if (const auto nestedIt = nestedExpansionByLocalId.find(localId);
            nestedIt != nestedExpansionByLocalId.end()) {
            const auto pinIt = nestedIt->second.exposedPins.find(portId);
            if (pinIt == nestedIt->second.exposedPins.end()) {
                throw std::runtime_error("subcircuito '" + typeId + "': componente aninhado '" + localId +
                                         "' nao possui portId externo '" + portId + "'");
            }
            return pinIt->second;
        }
        const auto componentIt = componentIndexByLocalId.find(localId);
        if (componentIt == componentIndexByLocalId.end()) {
            throw std::runtime_error("subcircuito '" + typeId + "': fio interno referencia componente inexistente: " + localId);
        }
        return SubcircuitExposedPin{componentIt->second, portId};
    };

    for (const registry::SubcircuitWireDef& wireDef : def->wires) {
        const SubcircuitExposedPin from = resolveEndpoint(wireDef.fromComponentId, wireDef.fromPinId);
        const SubcircuitExposedPin to = resolveEndpoint(wireDef.toComponentId, wireDef.toPinId);
        try {
            connectWireUnlocked(from.instanceId, from.pinId, to.instanceId, to.pinId);
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
    } catch (...) {
        // Expansão é uma publicação atômica: nenhum filho criado no staging pode sobreviver a um
        // endpoint inválido, factory ausente, ciclo ou erro de propriedade.
        for (auto it = childSubcircuitIds.rbegin(); it != childSubcircuitIds.rend(); ++it) {
            removeSubcircuitInstanceUnlocked(*it);
        }
        for (auto it = childComponentIndices.rbegin(); it != childComponentIndices.rend(); ++it) {
            removeComponentUnlocked(*it);
        }
        m_subcircuitChildren.erase(rawId);
        m_subcircuitChildIndexByLocalId.erase(rawId);
        if (!expansionStack.empty() && expansionStack.back() == typeId) expansionStack.pop_back();
        throw;
    }
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
    return readComponentStateWithGrowth(*instance, 65536, false);
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
    if (!m_scheduler.isRunning()) return captureComponentTelemetryStatesUnlocked(componentIndices);

    std::shared_ptr<const ComponentTelemetrySnapshot> snapshot;
    {
        std::lock_guard<std::mutex> lock(m_telemetrySnapshotMutex);
        for (uint32_t componentIndex : componentIndices) m_telemetrySubscriptions.insert(componentIndex);
        ++m_telemetryRequestedGeneration;
        snapshot = m_publishedTelemetrySnapshot;
    }

    std::vector<std::vector<uint8_t>> states;
    states.reserve(componentIndices.size());
    for (uint32_t componentIndex : componentIndices) {
        if (!snapshot || componentIndex >= snapshot->states.size() || !snapshot->states[componentIndex])
            throw std::runtime_error("telemetria ainda nao publicada; tente novamente");
        states.push_back(*snapshot->states[componentIndex]);
    }
    return states;
}

TelemetryFrameSnapshot SimulationSession::getTelemetryFrameSnapshot(
    const std::vector<uint32_t>& componentIndices) const {
    if (!m_scheduler.isRunning()) {
        TelemetryFrameSnapshot frame;
        frame.planGeneration = m_runtimeState.planGeneration;
        frame.telemetryGeneration = m_telemetryFrameGeneration.fetch_add(1, std::memory_order_relaxed) + 1;
        frame.timestampNs = m_scheduler.nowNs();
        frame.nodeVoltages = currentSnapshot();
        const uint64_t rawFrameLimit = m_resourceGovernor.budget().telemetryQueueBytes / 2;
        uint64_t capturedBytes = 0;
        frame.componentStates.reserve(componentIndices.size());
        for (uint32_t componentIndex : componentIndices) {
            std::vector<std::vector<uint8_t>> captured =
                captureComponentTelemetryStatesUnlocked({componentIndex});
            if (captured.front().size() > rawFrameLimit - std::min(rawFrameLimit, capturedBytes))
                throw std::runtime_error("frame de telemetria excede ResourceBudget");
            capturedBytes += captured.front().size();
            frame.componentStates.push_back(std::move(captured.front()));
        }
        return frame;
    }

    std::shared_ptr<const ComponentTelemetrySnapshot> snapshot;
    {
        std::lock_guard<std::mutex> lock(m_telemetrySnapshotMutex);
        m_telemetrySubscriptions.clear();
        for (uint32_t componentIndex : componentIndices) m_telemetrySubscriptions.insert(componentIndex);
        ++m_telemetryRequestedGeneration;
        snapshot = m_publishedTelemetrySnapshot;
    }
    if (!snapshot) throw std::runtime_error("telemetria ainda nao publicada; tente novamente");

    TelemetryFrameSnapshot frame;
    frame.planGeneration = snapshot->planGeneration;
    frame.telemetryGeneration = snapshot->telemetryGeneration;
    frame.timestampNs = snapshot->timestampNs;
    frame.nodeVoltages = snapshot->nodeVoltages;
    frame.componentStates.reserve(componentIndices.size());
    for (uint32_t componentIndex : componentIndices) {
        if (componentIndex >= snapshot->states.size() || !snapshot->states[componentIndex])
            throw std::runtime_error("telemetria ainda nao publicada; tente novamente");
        frame.componentStates.push_back(*snapshot->states[componentIndex]);
    }
    return frame;
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
    if (!m_runtimeState.executionActive || m_runtimeState.sessionExecutionId == 0)
        throw std::runtime_error("loadMcuFirmware requer execucao ativa");
    const RuntimeLaunchIdentity identity{
        m_runtimeState.sessionExecutionId,
        mcu->runtimeInstanceId(),
        mcu->reserveLaunchGeneration()};
    mcu->loadFirmware(firmwarePath, arenaName, qemuBinaryOverride, debug, identity);
}

void SimulationSession::stopMcuFirmware(uint32_t componentIndex) {
    IComponentModel* instance = m_componentInstances.at(componentIndex).get();
    auto* mcu = dynamic_cast<mcu::McuComponent*>(instance);
    if (!mcu) throw std::runtime_error("stopMcuFirmware: componente nao e MCU/QEMU");
    mcu->stopFirmware();
}

void SimulationSession::stopSimulation() {
    std::lock_guard<std::mutex> identityLock(m_executionIdentityMutex);
    // Primeiro interrompe a worker: nenhum componente pode voltar a agendar trabalho enquanto as
    // MCUs são encerradas. reset() também limpa dirty/events, volta o relógio a zero e despausa.
    m_scheduler.stop();
    for (uint32_t index : m_mcuComponentIndices) {
        static_cast<mcu::McuComponent*>(m_componentInstances[index].get())->stopFirmware();
    }
    for (const uint32_t index : m_fpgaComponentIndices) {
        static_cast<fpga::FpgaComponent*>(m_componentInstances[index].get())->stop();
    }
    for (uint32_t index : m_plcComponentIndices) {
        auto* plcComponent = static_cast<plc::PlcComponent*>(m_componentInstances[index].get());
        if (plc::PlcRuntime* runtime = plcComponent->runtime()) runtime->shutdown();
    }
    m_pythonRuntime.shutdown();
    m_scheduler.reset();
    m_runtimeState.executionActive = false;
    m_runtimeState.virtualTimeNs = 0;
    m_runtimeState.signals.reset();
    m_signalBoundaryScheduledNs.reset();
    ++m_signalScheduleGeneration;
    m_plcScanScheduledNs.clear();
    for (auto& [componentIndex, generation] : m_plcScanGeneration) ++generation;
}

std::string SimulationSession::mcuLogs(uint32_t componentIndex) const {
    IComponentModel* instance = m_componentInstances.at(componentIndex).get();
    if (!instance) throw std::runtime_error("getMcuLogs: componente removido");
    const auto* mcu = dynamic_cast<const mcu::McuComponent*>(instance);
    if (!mcu) throw std::runtime_error("getMcuLogs: componente nao e MCU/QEMU");
    return mcu->qemuLogs();
}

void SimulationSession::setFpgaConfig(uint32_t componentIndex, std::vector<std::string> sources,
                                      std::string topEntity, std::string standard) {
    runViaCommandQueue([componentIndex, sources = std::move(sources), topEntity = std::move(topEntity),
                        standard = std::move(standard)](SimulationSession& self) mutable {
        if (self.m_scheduler.isRunning()) {
            throw std::runtime_error("setFpgaConfig requer simulacao parada para publicar ExternalBindingPlan");
        }
        IComponentModel* instance = self.m_componentInstances.at(componentIndex).get();
        if (!instance) throw std::runtime_error("setFpgaConfig: componente removido");
        auto* fpgaComponent = dynamic_cast<fpga::FpgaComponent*>(instance);
        if (!fpgaComponent) throw std::runtime_error("setFpgaConfig: componente nao e FPGA");
        fpgaComponent->setSources(std::move(sources), std::move(topEntity), std::move(standard));
        self.invalidatePlan(simulation::PlanDomain::External);
    });
}

void SimulationSession::runFpga(uint32_t componentIndex) {
    runViaCommandQueue([componentIndex](SimulationSession& self) {
        IComponentModel* instance = self.m_componentInstances.at(componentIndex).get();
        if (!instance) throw std::runtime_error("runFpga: componente removido");
        auto* fpgaComponent = dynamic_cast<fpga::FpgaComponent*>(instance);
        if (!fpgaComponent) throw std::runtime_error("runFpga: componente nao e FPGA");
        if (!fpgaComponent->controller().isRunning()) fpgaComponent->start();
    });
}

void SimulationSession::stopFpga(uint32_t componentIndex) {
    runViaCommandQueue([componentIndex](SimulationSession& self) {
        IComponentModel* instance = self.m_componentInstances.at(componentIndex).get();
        if (!instance) throw std::runtime_error("stopFpga: componente removido");
        auto* fpgaComponent = dynamic_cast<fpga::FpgaComponent*>(instance);
        if (!fpgaComponent) throw std::runtime_error("stopFpga: componente nao e FPGA");
        fpgaComponent->stop();
    });
}

void SimulationSession::restartFpga(uint32_t componentIndex) {
    runViaCommandQueue([componentIndex](SimulationSession& self) {
        IComponentModel* instance = self.m_componentInstances.at(componentIndex).get();
        if (!instance) throw std::runtime_error("restartFpga: componente removido");
        auto* fpgaComponent = dynamic_cast<fpga::FpgaComponent*>(instance);
        if (!fpgaComponent) throw std::runtime_error("restartFpga: componente nao e FPGA");
        fpgaComponent->restart();
    });
}

std::string SimulationSession::fpgaLogs(uint32_t componentIndex) const {
    auto result = m_scheduler.trySynchronized([&] {
        IComponentModel* instance = m_componentInstances.at(componentIndex).get();
        if (!instance) throw std::runtime_error("getFpgaLogs: componente removido");
        const auto* fpgaComponent = dynamic_cast<const fpga::FpgaComponent*>(instance);
        if (!fpgaComponent) throw std::runtime_error("getFpgaLogs: componente nao e FPGA");
        return fpgaComponent->logs();
    });
    if (!result) throw std::runtime_error("simulacao ocupada; logs FPGA adiados");
    return *result;
}

mcu::McuComponent* SimulationSession::mcuComponentForTesting(uint32_t componentIndex) const {
    if (componentIndex >= m_componentInstances.size()) return nullptr;
    IComponentModel* instance = m_componentInstances[componentIndex].get();
    return instance ? dynamic_cast<mcu::McuComponent*>(instance) : nullptr;
}

std::optional<uint64_t> SimulationSession::firstMcuVirtualTimeNs() const {
    for (uint32_t index : m_mcuComponentIndices) {
        auto* mcu = static_cast<mcu::McuComponent*>(m_componentInstances[index].get());
        if (!mcu->arenaBridge().arena()) continue;
        // Achado 2026-07-22: `arena->qemuTime` nunca é escrito pelo QEMU real (campo morto, ver
        // comentário de `McuComponent::latestVirtualTimeNs()`) -- lê-lo direto sempre dava 0,
        // fazendo o indicador "MCU real-time ratio" ficar preso em 0% pra sempre, mesmo com o MCU
        // rodando normalmente. `latestVirtualTimeNs()` rastreia o progresso real via os eventos
        // efetivamente processados.
        return mcu->latestVirtualTimeNs();
    }
    return std::nullopt;
}

std::optional<uint64_t> SimulationSession::computeSlowestMcuPositionNs() {
    const auto now = std::chrono::steady_clock::now();
    std::optional<uint64_t> slowest;
    for (uint32_t i : m_mcuComponentIndices) {
        auto* mcu = static_cast<mcu::McuComponent*>(m_componentInstances[i].get());
        if (!mcu->arenaBridge().arena()) {
            m_mcuPositionTracking.erase(i);
            continue;
        }
        // Achado 2026-07-23: cheguei a tratar "arena aberta, zero eventos despachados ainda" como
        // posição 0 (em vez de nullopt) pra prender o teto perto do piso durante o boot -- reduzia
        // um salto real de Scheduler::nowNs() observado em teste sintético (~22s -> ~7s), mas
        // criava uma regressão pior: `session_restart_stress` roda cada ciclo por só 600ms de
        // parede, bem abaixo de `kStaleMcuTimeout` (1s) -- um MCU recém-recarregado que ainda não
        // produziu nenhum evento ficava com o teto travado perto de zero pelo ciclo INTEIRO, sem
        // tempo de a exclusão por staleness entrar em ação. Revertido: um MCU sem posição ainda
        // continua EXCLUÍDO do cálculo (comportamento original), não contribuindo pro teto até
        // processar seu primeiro evento de verdade -- ver .spec, seção 32.3.5, pra o porquê essa
        // troca acabou não sendo necessária (a causa raiz investigada está fora do Core).
        const std::optional<uint64_t> position = mcu->pacingPositionNs();
        if (!position) {
            m_mcuPositionTracking.erase(i); // sem dado ainda -- nao ha o que rastrear.
            continue;
        }

        auto& tracking = m_mcuPositionTracking[i];
        if (*position != tracking.lastPositionNs || tracking.lastChangeWallTime == std::chrono::steady_clock::time_point{}) {
            tracking.lastPositionNs = *position;
            tracking.lastChangeWallTime = now;
        }
        // Achado 2026-07-23 (McuComponentLivePollThreadTest com 2 MCUs): um MCU que parou de
        // produzir eventos novos (ficou ocioso, ou -- em produção -- genuinamente dormindo) fica
        // com a posição CONGELADA -- sem isto, esse valor antigo travaria o teto pra sempre, mesmo
        // esse MCU não estando "lento" de verdade, só quieto. Ver McuPositionTracking no .hpp.
        if (now - tracking.lastChangeWallTime > kStaleMcuTimeout) continue;

        slowest = slowest ? std::min(*slowest, *position) : *position;
    }
    return slowest;
}

bool SimulationSession::isI2cFastPathTransparentUnlocked(const IComponentModel& component) {
    // Tipos embutidos cujo comportamento elétrico já é conhecido e não interfere no protocolo I2C
    // (resistor passivo ou um túnel que só encaminha o mesmo nó) -- qualquer
    // OUTRA coisa presente no mesmo nó (capacitor, driver ativo desconhecido, outro dispositivo
    // I2C sem suporte a transferI2c) precisa do caminho elétrico bit-a-bit de verdade, então força
    // fallback (ver resolveI2cTransferUnlocked). Comparação por typeId (não dynamic_cast) porque
    // são tipos embutidos com typeId estável, mesmo padrão já usado alhures neste arquivo.
    const std::string_view typeId = component.typeId();
    return typeId == "passive.resistor" || typeId == "connectors.tunnel";
}

I2cTransferResult SimulationSession::resolveI2cTransferUnlocked(uint32_t mcuIndex, uint32_t bus,
                                                                 const I2cTransfer& transfer) {
    auto& causalTrace = lasecsimul::trace::Recorder::instance();
    // The arena sequence is the protocol identity.  Do not substitute the
    // recorder's process-local counter: it cannot distinguish relaunches,
    // MCUs, or sessions.
    const uint64_t traceTransaction = causalTrace.currentI2cRequest();
    causalTrace.record(lasecsimul::trace::EventType::I2cEnter, traceTransaction, 0,
                       m_scheduler.nowNs(), transfer.txSize);
    I2cTransferResult fallback{};
    const bool traceI2c = [] {
        const char* value = std::getenv("LASECSIMUL_I2C_FASTPATH_TRACE");
        return value && *value && std::string_view(value) != "0";
    }();
    if (traceI2c) {
        const auto wallUs = std::chrono::duration_cast<std::chrono::microseconds>(
                                 std::chrono::steady_clock::now().time_since_epoch())
                                 .count();
        std::fprintf(stderr, "[LasecSimul][I2C fast-path] enter wallUs=%lld\n", static_cast<long long>(wallUs));
    }
    const auto traceFallback = [&](const char* reason, const IComponentModel* component = nullptr) {
        if (traceI2c) std::fprintf(stderr, "[LasecSimul][I2C fast-path] fallback: %s%s%s\n", reason,
                                  component ? " type=" : "", component ? component->typeId() : "");
        return fallback;
    };
    if (mcuIndex >= m_componentInstances.size() || !m_componentInstances[mcuIndex]) return traceFallback("MCU inválido");
    auto* mcuComponent = dynamic_cast<mcu::McuComponent*>(m_componentInstances[mcuIndex].get());
    if (!mcuComponent) return traceFallback("componente não é MCU");

    const auto sdaPinIndex = mcuComponent->resolveI2cPinIndex(bus, true);
    const auto sclPinIndex = mcuComponent->resolveI2cPinIndex(bus, false);
    const std::span<Pin> mcuPins = mcuComponent->pins();
    if (!sdaPinIndex || !sclPinIndex || *sdaPinIndex >= mcuPins.size() || *sclPinIndex >= mcuPins.size()) {
        return traceFallback("adaptador não resolveu SDA/SCL");
    }

    const auto& slots = m_netlist.pinSlotsOf(mcuIndex);
    const auto sdaSlot = slots.find(mcuPins[*sdaPinIndex].id);
    const auto sclSlot = slots.find(mcuPins[*sclPinIndex].id);
    if (sdaSlot == slots.end() || sclSlot == slots.end() ||
        sdaSlot->second >= m_topology.slotToNode.size() || sclSlot->second >= m_topology.slotToNode.size()) {
        return traceFallback("slot SDA/SCL ausente");
    }
    const uint32_t sdaNode = m_topology.slotToNode[sdaSlot->second];
    const uint32_t sclNode = m_topology.slotToNode[sclSlot->second];
    if (sdaNode >= m_topology.pinRefsByNode.size() || sclNode >= m_topology.pinRefsByNode.size()) return traceFallback("nó SDA/SCL ausente");

    std::vector<IComponentModel*> targets;
    for (const simulation::NodePinRef& ref : m_topology.pinRefsByNode[sdaNode]) {
        if (ref.componentIndex == mcuIndex) continue;
        if (ref.componentIndex >= m_componentInstances.size() || !m_componentInstances[ref.componentIndex]) continue;
        IComponentModel* candidate = m_componentInstances[ref.componentIndex].get();
        if (candidate->supportsI2cTransfer()) {
            const auto candidateSda = candidate->i2cPinIndex(true);
            const auto candidateScl = candidate->i2cPinIndex(false);
            if (!candidateSda || !candidateScl || ref.localPinIndex != *candidateSda) {
                if (traceI2c) std::fprintf(stderr, "[LasecSimul][I2C fast-path] pin mismatch ref=%u sda=%u scl=%u\\n",
                                            ref.localPinIndex, candidateSda.value_or(999u), candidateScl.value_or(999u));
                return traceFallback("pinos I2C do alvo incompatíveis", candidate);
            }
            const bool sclMatches = std::any_of(
                m_topology.pinRefsByNode[sclNode].begin(), m_topology.pinRefsByNode[sclNode].end(),
                [&](const simulation::NodePinRef& sclRef) {
                    return sclRef.componentIndex == ref.componentIndex && sclRef.localPinIndex == *candidateScl;
                });
            if (!sclMatches) return traceFallback("SCL do alvo não está no mesmo barramento", candidate);
            if (std::find(targets.begin(), targets.end(), candidate) == targets.end()) targets.push_back(candidate);
            continue;
        }
        if (!isI2cFastPathTransparentUnlocked(*candidate)) return traceFallback("componente opaco em SDA", candidate);
    }

    for (const simulation::NodePinRef& ref : m_topology.pinRefsByNode[sclNode]) {
        if (ref.componentIndex == mcuIndex) continue;
        if (ref.componentIndex >= m_componentInstances.size() || !m_componentInstances[ref.componentIndex]) continue;
        IComponentModel* candidate = m_componentInstances[ref.componentIndex].get();
        if (candidate->supportsI2cTransfer()) {
            const auto candidateScl = candidate->i2cPinIndex(false);
            if (candidateScl && ref.localPinIndex == *candidateScl &&
                std::find(targets.begin(), targets.end(), candidate) != targets.end()) {
                continue;
            }
            return traceFallback("alvo I2C inesperado em SCL", candidate);
        }
        if (!isI2cFastPathTransparentUnlocked(*candidate)) return traceFallback("componente opaco em SCL", candidate);
    }

    if (targets.empty()) {
        I2cTransferResult nack{};
        nack.handled = true;
        nack.firstNack = 0;
        return nack;
    }

    I2cTransferResult combined{};
    combined.handled = true;
    combined.firstNack = UINT32_MAX;
    uint32_t readResponders = 0;
    for (IComponentModel* target : targets) {
        const I2cTransferResult result = target->transferI2c(transfer);
        if (!result.handled) return traceFallback("plugin recusou transferência", target);
        if (!result.addressAck) continue;
        combined.addressAck = true;
        combined.firstNack = std::min(combined.firstNack, result.firstNack);
        combined.stretchNs = std::max(combined.stretchNs, result.stretchNs);
        if (transfer.read) {
            ++readResponders;
            combined.rxSize = result.rxSize;
        }
    }
    if (transfer.read && readResponders > 1) return traceFallback("mais de um alvo respondeu leitura");
    if (traceI2c) {
        const auto wallUs = std::chrono::duration_cast<std::chrono::microseconds>(
                                 std::chrono::steady_clock::now().time_since_epoch())
                                 .count();
        std::fprintf(stderr, "[LasecSimul][I2C fast-path] handled wallUs=%lld bus=%u addr=0x%02x tx=%u rx=%u ack=%u\n",
                     static_cast<long long>(wallUs), bus, transfer.address, transfer.txSize, transfer.rxSize,
                     combined.addressAck ? 1u : 0u);
    }
    causalTrace.record(lasecsimul::trace::EventType::I2cHandled, traceTransaction,
                       traceTransaction, m_scheduler.nowNs(), transfer.txSize);
    return combined;
}

void SimulationSession::beginExecutionIfNeeded() {
    std::lock_guard<std::mutex> identityLock(m_executionIdentityMutex);
    // Chamado pelo lifecycle de controle antes de Scheduler::start(). O próprio mutex do
    // Scheduler serializa esta transição; não introduzimos uma segunda disciplina de lock.
    if (m_runtimeState.executionActive) return;
    std::random_device rd;
    uint64_t id = (static_cast<uint64_t>(rd()) << 32) ^ static_cast<uint64_t>(rd());
    if (id == 0) id = 1;
    m_runtimeState.sessionExecutionId = id;
    m_runtimeState.executionActive = true;
}

void SimulationSession::abortExecutionIfCurrent(uint64_t attemptedId) {
    std::lock_guard<std::mutex> identityLock(m_executionIdentityMutex);
    if (m_runtimeState.executionActive && m_runtimeState.sessionExecutionId == attemptedId)
        m_runtimeState.executionActive = false;
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
    for (uint32_t i : m_activeComponentIndices) {
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
        for (uint32_t i : m_activeComponentIndices) m_scheduler.dirtySet().insert(i);
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
        for (uint32_t componentIndex : m_activeComponentIndices) {
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
    for (uint32_t componentIndex : m_activeComponentIndices) {
        const auto& slots = m_netlist.pinSlotsOf(componentIndex);
        if (slots.empty()) continue;
        const uint32_t anySlot = slots.begin()->second;
        const uint32_t groupIndex = m_topology.resolutionBySlot[anySlot].groupIndex;
        if (!groupReused[groupIndex]) m_scheduler.dirtySet().insert(componentIndex);
    }
}

bool SimulationSession::settleStep() {
    const bool profile = m_performanceProfilingEnabled.load(std::memory_order_relaxed);
    // TEMPORARY (ConsumerTrace investigation, round 5) -- no-op unless
    // LASECSIMUL_MCU_CONSUMER_TRACE=1; attributes settleStep()'s CPU cost by phase, following the
    // existing wall-clock profiling blocks already here (m_topologyNanoseconds/
    // m_deviceStampNanoseconds/m_solverNanoseconds) but using per-thread CPU cycles (same
    // QueryThreadCycleTime()-based mechanism validated in round 4) instead of wall time, plus a
    // per-component stamp breakdown. Every phase boundary below is one that already existed in
    // this function; nothing about ITS behavior is changed, only wrapped with timing. See
    // ConsumerTrace.hpp.
    const bool tracing = mcu::diag::traceEnabled();
    const uint64_t settleStepSeq = tracing ? mcu::diag::nextSettleStepSequence() : 0;
    const uint64_t phaseStartCpuNs = tracing ? mcu::diag::currentThreadCpuTimeNs() : 0;
    uint64_t topologyCpuNs = 0, stampingCpuNs = 0, mnaSolveCpuNs = 0, propagationCpuNs = 0, convergenceCpuNs = 0;

    const bool topologyWasDirty = m_topologyDirty;
    const auto topologyStart = profile && topologyWasDirty ? std::chrono::steady_clock::now()
                                                            : std::chrono::steady_clock::time_point{};
    const uint64_t topologyCpu0 = tracing ? mcu::diag::currentThreadCpuTimeNs() : 0;
    rebuildTopologyIfNeeded();
    rebuildSignalRoutesIfNeeded();
    if (tracing) topologyCpuNs = mcu::diag::currentThreadCpuTimeNs() - topologyCpu0;
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
    m_stampedNonlinearThisRound.clear();
    const auto deviceStart = profile ? std::chrono::steady_clock::now() : std::chrono::steady_clock::time_point{};
    const uint64_t stampingCpu0 = tracing ? mcu::diag::currentThreadCpuTimeNs() : 0;
    for (uint32_t componentIndex : m_stampedThisRound) {
        IComponentModel* component = m_componentInstances[componentIndex].get();
        if (std::binary_search(m_nonlinearComponentIndices.begin(), m_nonlinearComponentIndices.end(),
                               componentIndex)) {
            m_stampedNonlinearThisRound.push_back(componentIndex);
        }
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
        const uint64_t oneStampCpu0 = tracing ? mcu::diag::currentThreadCpuTimeNs() : 0;
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
        if (tracing) {
            mcu::diag::traceComponentStamp(settleStepSeq, componentIndex,
                                            mcu::diag::currentThreadCpuTimeNs() - oneStampCpu0);
        }
    }
    if (tracing) stampingCpuNs = mcu::diag::currentThreadCpuTimeNs() - stampingCpu0;
    if (profile) {
        m_componentStamps.fetch_add(m_stampedThisRound.size(), std::memory_order_relaxed);
        m_deviceStampNanoseconds.fetch_add(static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::steady_clock::now() - deviceStart).count()), std::memory_order_relaxed);
    }
    m_scheduler.dirtySet().clear();

    // 2. Resolve só os grupos dirty (admitância ou corrente mudou) — em paralelo entre si.
    const auto solverStart = profile ? std::chrono::steady_clock::now() : std::chrono::steady_clock::time_point{};
    const uint64_t solveCpu0 = tracing ? mcu::diag::currentThreadCpuTimeNs() : 0;
    m_mnaSolver.solve(m_topology.groups, m_nodeVoltages, settleStepSeq);
    if (tracing) mnaSolveCpuNs = mcu::diag::currentThreadCpuTimeNs() - solveCpu0;
    if (profile) {
        m_solverCalls.fetch_add(1, std::memory_order_relaxed);
        m_solverNanoseconds.fetch_add(static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::steady_clock::now() - solverStart).count()), std::memory_order_relaxed);
    }

    // 3. Nó cuja tensão de fato mudou: marca dirty quem tem pino lá (listenersByNode).
    const uint64_t propagationCpu0 = tracing ? mcu::diag::currentThreadCpuTimeNs() : 0;
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
    if (tracing) propagationCpuNs = mcu::diag::currentThreadCpuTimeNs() - propagationCpu0;

    // 4. Componente não-linear que estampou neste round e ainda não convergiu pede outra
    //    iteração — mesmo que nenhum vizinho tenha mudado tensão o bastante pra disparar isso via
    //    listener (passo 3). Sem componente não-linear real hoje, isto nunca dispara de fato; é
    //    só o contrato/mecânica fixados (ver .spec, seção 7.4) — Newton-Raphson de verdade
    //    (critério de convergência, diodo/transistor) fica para depois.
    const uint64_t convergenceCpu0 = tracing ? mcu::diag::currentThreadCpuTimeNs() : 0;
    bool anyNonlinearPending = false;
    if (m_nonlinearIterations < kMaxNonlinearIterations) {
        for (uint32_t componentIndex : m_stampedNonlinearThisRound) {
            IComponentModel* component = m_componentInstances[componentIndex].get();
            if (!component->hasConverged()) {
                m_scheduler.dirtySet().insert(componentIndex);
                anyNonlinearPending = true;
            }
        }
    } else {
        std::fprintf(stderr, "[SimulationSession] %u componente(s) não convergiram após %u iterações — "
                              "seguindo com último ponto de operação\n",
                     static_cast<unsigned>(m_stampedNonlinearThisRound.size()), kMaxNonlinearIterations);
    }
    m_nonlinearIterations = anyNonlinearPending ? m_nonlinearIterations + 1 : 0;
    if (tracing) convergenceCpuNs = mcu::diag::currentThreadCpuTimeNs() - convergenceCpu0;

    if (tracing) {
        const uint64_t totalCpuNs = mcu::diag::currentThreadCpuTimeNs() - phaseStartCpuNs;
        const uint64_t accountedCpuNs = topologyCpuNs + stampingCpuNs + mnaSolveCpuNs + propagationCpuNs + convergenceCpuNs;
        mcu::diag::traceSettleStepPhase(mcu::diag::SettleStepPhaseEntry{
            /*hostTsNs=*/0, settleStepSeq, totalCpuNs, topologyCpuNs, stampingCpuNs,
            static_cast<uint64_t>(m_stampedThisRound.size()), mnaSolveCpuNs, propagationCpuNs, convergenceCpuNs,
            totalCpuNs > accountedCpuNs ? totalCpuNs - accountedCpuNs : 0});
    }

    // Ainda há trabalho se alguma tensão mudou (logo, novos componentes podem ter ficado dirty), se
    // algum não-linear pediu outra iteração, OU se já havia dirty pendente que este round não tocou
    // — isso é o "settle loop" da seção 7 do .spec: só avança Δt quando esta função devolve false.
    return anyVoltageChanged || anyNonlinearPending || !m_scheduler.dirtySet().empty();
}

} // namespace lasecsimul::session
