#include "SimulationPlan.hpp"

#include <algorithm>
#include <iomanip>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string_view>

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
        auto plc = std::make_shared<PlcPlan>();
        plc->revision = input.authoringRevision;
        plc->instances = input.execution.plcComponents;
        next->plc = std::move(plc);
    } else {
        next->plc = input.previous->plc;
    }
    return next;
}

} // namespace lasecsimul::simulation
