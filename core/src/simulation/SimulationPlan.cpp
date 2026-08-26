#include "SimulationPlan.hpp"

#include <algorithm>
#include <iomanip>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string_view>
#include <unordered_set>

namespace lasecsimul::simulation {
namespace {

constexpr uint64_t kFnvOffset = 14695981039346656037ull;
constexpr uint64_t kFnvPrime = 1099511628211ull;

void hashBytes(uint64_t& hash, const void* data, size_t size) {
    const auto* bytes = static_cast<const uint8_t*>(data);
    for (size_t index = 0; index < size; ++index) {
        hash ^= bytes[index];
        hash *= kFnvPrime;
    }
}

template <class T>
void hashScalar(uint64_t& hash, const T& value) {
    hashBytes(hash, &value, sizeof(value));
}

void hashText(uint64_t& hash, std::string_view text) {
    hashScalar(hash, text.size());
    hashBytes(hash, text.data(), text.size());
}

void validateDenseList(const std::vector<uint32_t>& values, size_t capacity,
                       const std::vector<uint32_t>* active, std::string_view name) {
    if (!std::is_sorted(values.begin(), values.end()) ||
        std::adjacent_find(values.begin(), values.end()) != values.end()) {
        throw std::invalid_argument(std::string(name) + " deve ser ordenada e sem duplicatas");
    }
    for (uint32_t value : values) {
        if (value >= capacity) throw std::invalid_argument(std::string(name) + " contem indice fora da capacidade");
        if (active && !std::binary_search(active->begin(), active->end(), value)) {
            throw std::invalid_argument(std::string(name) + " contem componente inativo");
        }
    }
}

void validateExecution(const DenseExecutionLists& lists, size_t capacity) {
    validateDenseList(lists.activeComponents, capacity, nullptr, "activeComponents");
    validateDenseList(lists.reactiveComponents, capacity, &lists.activeComponents, "reactiveComponents");
    validateDenseList(lists.nonlinearComponents, capacity, &lists.activeComponents, "nonlinearComponents");
    validateDenseList(lists.fpgaComponents, capacity, &lists.activeComponents, "fpgaComponents");
    validateDenseList(lists.mcuComponents, capacity, &lists.activeComponents, "mcuComponents");
    validateDenseList(lists.signalSubscribers, capacity, &lists.activeComponents, "signalSubscribers");
    validateDenseList(lists.plcComponents, capacity, &lists.activeComponents, "plcComponents");
    validateDenseList(lists.pythonComponents, capacity, &lists.activeComponents, "pythonComponents");
    validateDenseList(lists.dynamicComponents, capacity, &lists.activeComponents, "dynamicComponents");
}

bool isSensorBridge(ElectricalSignalBridgeKind kind) {
    return kind == ElectricalSignalBridgeKind::VoltageSensor ||
           kind == ElectricalSignalBridgeKind::CurrentSensor ||
           kind == ElectricalSignalBridgeKind::DigitalInput;
}

SignalScalarType bridgeScalar(ElectricalSignalBridgeKind kind) {
    return kind == ElectricalSignalBridgeKind::DigitalInput || kind == ElectricalSignalBridgeKind::DigitalOutput
        ? SignalScalarType::Bool : SignalScalarType::Real;
}

std::string_view bridgeUnit(ElectricalSignalBridgeKind kind) {
    if (kind == ElectricalSignalBridgeKind::VoltageSensor || kind == ElectricalSignalBridgeKind::ControlledVoltageSource)
        return "V";
    if (kind == ElectricalSignalBridgeKind::CurrentSensor || kind == ElectricalSignalBridgeKind::ControlledCurrentSource)
        return "A";
    return "";
}

void hashList(uint64_t& hash, const std::vector<uint32_t>& values) {
    hashScalar(hash, values.size());
    for (uint32_t value : values) hashScalar(hash, value);
}

std::string structuralHash(const PlanCompileInput& input) {
    uint64_t hash = kFnvOffset;
    hashScalar(hash, input.componentCapacity);
    hashScalar(hash, input.normalizedComponentState.size());
    for (const std::string& component : input.normalizedComponentState) hashText(hash, component);
    const DenseExecutionLists& lists = input.execution;
    hashList(hash, lists.activeComponents);
    hashList(hash, lists.reactiveComponents);
    hashList(hash, lists.nonlinearComponents);
    hashList(hash, lists.fpgaComponents);
    hashList(hash, lists.mcuComponents);
    hashList(hash, lists.signalSubscribers);
    hashList(hash, lists.plcComponents);
    hashList(hash, lists.pythonComponents);
    hashList(hash, lists.dynamicComponents);
    hashScalar(hash, input.resolvedSignalSubscribers.size());
    for (const SignalPlan::Subscriber& subscriber : input.resolvedSignalSubscribers) {
        hashScalar(hash, subscriber.componentIndex);
        for (const SignalPlan::Route& route : subscriber.channels) {
            hashText(hash, route.descriptor.channelId);
            hashText(hash, route.descriptor.source);
            hashText(hash, route.descriptor.label);
            hashList(hash, route.nodeIndices);
        }
    }
    if (input.signalGraph) {
        const SignalGraphDefinition& graph = *input.signalGraph;
        hashScalar(hash, graph.maxVectorWidth);
        hashScalar(hash, graph.maxMicrosteps);
        hashScalar(hash, graph.blocks.size());
        for (const SignalBlockDefinition& block : graph.blocks) {
            hashText(hash, block.id); hashScalar(hash, block.kind);
            hashText(hash, block.output.id); hashScalar(hash, block.output.type.scalar);
            hashScalar(hash, block.output.type.width); hashText(hash, block.output.unit);
            hashScalar(hash, block.rate.periodNs); hashScalar(hash, block.rate.offsetNs); hashScalar(hash, block.rate.phase);
            hashScalar(hash, block.loopPolicy); hashScalar(hash, block.maxIterations); hashScalar(hash, block.tolerance);
            hashScalar(hash, block.historyCapacity);
            hashScalar(hash, block.inputs.size());
            for (const SignalPortDefinition& port : block.inputs) {
                hashText(hash, port.id); hashScalar(hash, port.type.scalar); hashScalar(hash, port.type.width); hashText(hash, port.unit);
            }
            hashScalar(hash, block.realParameters.size());
            for (double value : block.realParameters) hashScalar(hash, value);
            hashScalar(hash, block.intParameters.size());
            for (int64_t value : block.intParameters) hashScalar(hash, value);
            hashScalar(hash, block.boolParameters.size());
            for (uint8_t value : block.boolParameters) hashScalar(hash, value);
            hashText(hash, block.expression);
        }
        hashScalar(hash, graph.connections.size());
        for (const SignalConnectionDefinition& edge : graph.connections) {
            hashText(hash, edge.sourceBlock); hashText(hash, edge.sourcePort);
            hashText(hash, edge.targetBlock); hashText(hash, edge.targetPort);
            hashScalar(hash, edge.allowUnitConversion);
        }
    }
    hashScalar(hash, input.electricalSignalBridges.size());
    for (const ElectricalSignalBridgeDefinition& bridge : input.electricalSignalBridges) {
        hashScalar(hash, bridge.kind);
        hashScalar(hash, bridge.componentIndex);
        hashText(hash, bridge.signalBlockId);
    }
    hashScalar(hash, input.pythonBlocks.size());
    for (const PythonBlockPlan& block : input.pythonBlocks) {
        hashText(hash, block.blockId);
        hashText(hash, block.source);
        hashText(hash, block.rateGroupId);
        hashScalar(hash, block.dependencies.size());
        for (const std::string& dependency : block.dependencies) hashText(hash, dependency);
    }

    if (input.electricalTopology) {
        const Topology& topology = *input.electricalTopology;
        hashList(hash, topology.slotToNode);
        hashScalar(hash, topology.groups.size());
        for (const CircuitGroup& group : topology.groups) {
            hashList(hash, group.nodeIndices());
            hashScalar(hash, group.totalSize());
        }
        hashScalar(hash, topology.stampResolutionByComponent.size());
        for (const ComponentStampResolution& resolution : topology.stampResolutionByComponent) {
            hashScalar(hash, resolution.groupIndex);
            std::vector<std::pair<std::string, uint32_t>> pins(resolution.localIndexByPinId.begin(),
                                                               resolution.localIndexByPinId.end());
            std::sort(pins.begin(), pins.end());
            for (const auto& [pin, localIndex] : pins) {
                hashText(hash, pin);
                hashScalar(hash, localIndex);
            }
        }
    }

    std::ostringstream text;
    text << std::hex << std::setfill('0') << std::setw(16) << hash;
    return text.str();
}

std::shared_ptr<const ElectricalPlan> compileElectrical(const PlanCompileInput& input) {
    if (!input.electricalTopology) throw std::invalid_argument("ElectricalPlan exige Topology compilada");
    const Topology& topology = *input.electricalTopology;
    auto plan = std::make_shared<ElectricalPlan>();
    plan->revision = input.electricalRevision;
    plan->groups.reserve(topology.groups.size());
    for (const CircuitGroup& group : topology.groups) {
        plan->groups.push_back({group.nodeIndices(), group.totalSize()});
    }
    plan->resolutionBySlot = topology.resolutionBySlot;
    plan->listenersByNode = topology.listenersByNode;
    plan->pinRefsByNode = topology.pinRefsByNode;
    plan->slotToNode = topology.slotToNode;
    plan->extraVariablesByComponent = topology.extraVariablesByComponent;
    plan->stampResolutionByComponent = topology.stampResolutionByComponent;
    return plan;
}

/** Round 1 simplification (documentada, nao inventada silenciosamente): mapeamento IEC->Signal
 * Engine so distingue BOOL/REAL/LREAL; todo o resto (SINT/INT/DINT/LINT/USINT/UINT/UDINT/ULINT/
 * BYTE/WORD/DWORD/LWORD/TIME) cai no bucket Int64 do Signal Engine -- suficiente pra rotear pelo
 * barramento de 3 tipos ja existente (Real/Bool/Int64) sem implementar semantica numerica IEC
 * completa nesta rodada. */
SignalScalarType plcIoScalarType(const std::string& iecType) {
    if (iecType == "BOOL") return SignalScalarType::Bool;
    if (iecType == "REAL" || iecType == "LREAL") return SignalScalarType::Real;
    return SignalScalarType::Int64;
}

std::shared_ptr<PlcPlan> compilePlc(const PlanCompileInput& input, const std::shared_ptr<const CompiledSignalGraph>& engine) {
    auto plc = std::make_shared<PlcPlan>();
    plc->revision = input.authoringRevision;

    std::unordered_set<uint32_t> seenComponents;
    for (const PlcInstanceDescriptor& descriptor : input.plcInstances) {
        if (descriptor.componentIndex >= input.componentCapacity ||
            !std::binary_search(input.execution.plcComponents.begin(), input.execution.plcComponents.end(),
                                descriptor.componentIndex)) {
            throw std::invalid_argument("PlcInstanceDescriptor referencia componente PLC inativo/inexistente");
        }
        if (!seenComponents.insert(descriptor.componentIndex).second) {
            throw std::invalid_argument("PlcInstanceDescriptor duplicado pro mesmo componentIndex");
        }

        PlcInstancePlan instance;
        instance.componentIndex = descriptor.componentIndex;
        instance.artifact = descriptor.artifact;
        instance.taskIntervalNs = descriptor.taskIntervalNs > 0 ? descriptor.taskIntervalNs : 10'000'000;

        if (instance.artifact) {
            std::unordered_set<std::string> requestedIds;
            std::unordered_set<std::string> outputTargets; // dedup: só um OUTPUT de PLC por signalBlockId nesta instância.
            for (const plc::PlcExportedIo& io : instance.artifact->exportedIo) {
                PlcIoBinding binding;
                binding.ioId = io.ioId;
                binding.name = io.name;
                binding.direction = io.direction;
                binding.iecType = io.iecType;

                const PlcIoBindingRequest* request = nullptr;
                for (const PlcIoBindingRequest& candidate : descriptor.ioBindingRequests) {
                    if (candidate.ioId == io.ioId) { request = &candidate; break; }
                }
                if (request) {
                    requestedIds.insert(request->ioId);
                    const SignalScalarType expectedScalar = plcIoScalarType(io.iecType);
                    if (io.direction == "output") {
                        // Round 1: SignalRuntime só tem setExternalReal/setExternalBool (sem
                        // setExternalInt) -- um output PLC mapeado pra Int64 (SINT/INT/DINT/etc,
                        // ver plcIoScalarType) não tem como ser publicado no Signal Engine ainda.
                        // Rejeitado explicitamente aqui em vez de aceitar a ligação e falhar
                        // silenciosamente em tempo de scan.
                        if (expectedScalar == SignalScalarType::Int64) {
                            throw std::invalid_argument(
                                "PLC output de tipo IEC inteiro/temporal (" + io.iecType +
                                ") ainda não pode ser ligado ao Signal Engine nesta rodada (só BOOL/REAL/LREAL): " + io.ioId);
                        }
                        if (!SignalCompiler::isExternalInput(engine, request->signalBlockId)) {
                            throw std::invalid_argument("PLC output deve publicar em um bloco ExternalInput do Signal Engine: " +
                                                        request->signalBlockId);
                        }
                        const SignalPortDefinition target = SignalCompiler::outputDefinition(engine, request->signalBlockId);
                        if (target.type.scalar != expectedScalar) {
                            throw std::invalid_argument("PLC output com tipo incompativel no bloco alvo: " + request->signalBlockId);
                        }
                        if (!outputTargets.insert(request->signalBlockId).second) {
                            throw std::invalid_argument("mais de um output de PLC publica no mesmo bloco: " + request->signalBlockId);
                        }
                        binding.signalBlockId = request->signalBlockId;
                    } else if (io.direction == "input") {
                        const SignalPortDefinition source = SignalCompiler::outputDefinition(engine, request->signalBlockId);
                        if (source.type.scalar != expectedScalar) {
                            throw std::invalid_argument("PLC input com tipo incompativel na fonte: " + request->signalBlockId);
                        }
                        binding.signalBlockId = request->signalBlockId;
                        binding.signal = SignalCompiler::output(engine, request->signalBlockId);
                    }
                }
                instance.ioBindings.push_back(std::move(binding));
            }
            for (const PlcIoBindingRequest& request : descriptor.ioBindingRequests) {
                if (!requestedIds.count(request.ioId)) instance.orphanedBindingRequests.push_back(request.ioId);
            }
        }

        plc->instances.push_back(std::move(instance));
    }
    return plc;
}

} // namespace

std::shared_ptr<const SimulationPlan> PlanCompiler::compile(const PlanCompileInput& input) {
    validateExecution(input.execution, input.componentCapacity);
    const bool first = !input.previous;
    auto next = std::make_shared<SimulationPlan>();
    next->generation = first ? 1 : input.previous->generation + 1;
    next->authoringRevision = input.authoringRevision;
    next->normalizedAuthoringHash = structuralHash(input);

    if (first || input.invalidation.contains(PlanDomain::ExecutionIndex)) {
        next->execution = std::make_shared<const DenseExecutionLists>(input.execution);
    } else {
        next->execution = input.previous->execution;
    }
    if (first || input.invalidation.contains(PlanDomain::Electrical)) {
        next->electrical = compileElectrical(input);
    } else {
        next->electrical = input.previous->electrical;
    }
    if (first || input.invalidation.contains(PlanDomain::Signal)) {
        auto signal = std::make_shared<SignalPlan>();
        signal->revision = input.authoringRevision;
        signal->subscribers = input.execution.signalSubscribers;
        signal->resolvedSubscribers = input.resolvedSignalSubscribers;
        signal->engine = input.signalGraph ? SignalCompiler::compile(*input.signalGraph)
                                           : SignalCompiler::compile(SignalGraphDefinition{});
        std::unordered_set<uint32_t> boundComponents;
        std::unordered_set<std::string> sensorTargets;
        for (const ElectricalSignalBridgeDefinition& bridge : input.electricalSignalBridges) {
            if (bridge.componentIndex >= input.componentCapacity ||
                !std::binary_search(input.execution.activeComponents.begin(), input.execution.activeComponents.end(),
                                    bridge.componentIndex)) {
                throw std::invalid_argument("bridge referencia componente eletrico inativo/inexistente");
            }
            if (!boundComponents.insert(bridge.componentIndex).second)
                throw std::invalid_argument("componente eletrico possui mais de um bridge");
            const SignalPortDefinition output = SignalCompiler::outputDefinition(signal->engine, bridge.signalBlockId);
            if (output.type.scalar != bridgeScalar(bridge.kind) || output.type.width != 1)
                throw std::invalid_argument("bridge possui tipo/largura de sinal incompativel: " + bridge.signalBlockId);
            if (output.unit != bridgeUnit(bridge.kind))
                throw std::invalid_argument("bridge possui unidade incompativel: " + bridge.signalBlockId);
            if (isSensorBridge(bridge.kind)) {
                if (!SignalCompiler::isExternalInput(signal->engine, bridge.signalBlockId))
                    throw std::invalid_argument("sensor bridge deve publicar em ExternalInput: " + bridge.signalBlockId);
                if (!sensorTargets.insert(bridge.signalBlockId).second)
                    throw std::invalid_argument("mais de um sensor publica no mesmo ExternalInput");
            }
            signal->electricalBridges.push_back({bridge, SignalCompiler::output(signal->engine, bridge.signalBlockId)});
        }
        next->signal = std::move(signal);
    } else {
        next->signal = input.previous->signal;
    }
    if (first || input.invalidation.contains(PlanDomain::External)) {
        auto external = std::make_shared<ExternalBindingPlan>();
        external->revision = input.authoringRevision;
        external->processComponents = input.execution.fpgaComponents;
        external->processComponents.insert(external->processComponents.end(), input.execution.mcuComponents.begin(),
                                           input.execution.mcuComponents.end());
        std::sort(external->processComponents.begin(), external->processComponents.end());
        external->processComponents.erase(std::unique(external->processComponents.begin(),
                                                       external->processComponents.end()),
                                          external->processComponents.end());
        next->externalBindings = std::move(external);
    } else {
        next->externalBindings = input.previous->externalBindings;
    }
    if (first || input.invalidation.contains(PlanDomain::Plc)) {
        next->plc = compilePlc(input, next->signal ? next->signal->engine : nullptr);
    } else {
        next->plc = input.previous->plc;
    }
    if (first || input.invalidation.contains(PlanDomain::Python)) {
        auto python = std::make_shared<PythonPlan>();
        python->revision = input.authoringRevision;
        std::unordered_set<std::string> ids;
        for (const PythonBlockPlan& block : input.pythonBlocks) {
            if (block.blockId.empty() || block.source.empty() || block.rateGroupId.empty())
                throw std::invalid_argument("PythonPlan exige blockId/source/rateGroupId nao vazios");
            if (!ids.insert(block.blockId).second)
                throw std::invalid_argument("PythonPlan contem blockId duplicado: " + block.blockId);
            python->blocks.push_back(block);
        }
        next->python = std::move(python);
    } else {
        next->python = input.previous->python;
    }
    return next;
}

} // namespace lasecsimul::simulation
