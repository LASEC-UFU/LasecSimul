#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "Netlist.hpp"
#include "SignalEngine.hpp"
#include "lasecsimul/Signal.hpp"

namespace lasecsimul::simulation {

enum class PlanDomain : uint32_t {
    None = 0,
    Electrical = 1u << 0,
    Signal = 1u << 1,
    External = 1u << 2,
    Plc = 1u << 3,
    ExecutionIndex = 1u << 4,
    All = (1u << 5) - 1u,
};

constexpr PlanDomain operator|(PlanDomain left, PlanDomain right) {
    return static_cast<PlanDomain>(static_cast<uint32_t>(left) | static_cast<uint32_t>(right));
}

constexpr PlanDomain operator&(PlanDomain left, PlanDomain right) {
    return static_cast<PlanDomain>(static_cast<uint32_t>(left) & static_cast<uint32_t>(right));
}

class PlanInvalidation {
public:
    explicit PlanInvalidation(PlanDomain domains = PlanDomain::None) : m_domains(domains) {}

    void invalidate(PlanDomain domains) { m_domains = m_domains | domains; }
    void clear(PlanDomain domains) {
        m_domains = static_cast<PlanDomain>(static_cast<uint32_t>(m_domains) &
                                            ~static_cast<uint32_t>(domains));
    }
    void clearAll() { m_domains = PlanDomain::None; }
    bool contains(PlanDomain domain) const { return (m_domains & domain) != PlanDomain::None; }
    bool empty() const { return m_domains == PlanDomain::None; }
    PlanDomain domains() const { return m_domains; }

private:
    PlanDomain m_domains;
};

/** Índices resolvidos uma vez no cold path. Todos os vetores são ordenados por componentIndex. */
struct DenseExecutionLists {
    std::vector<uint32_t> activeComponents;
    std::vector<uint32_t> reactiveComponents;
    std::vector<uint32_t> nonlinearComponents;
    std::vector<uint32_t> fpgaComponents;
    std::vector<uint32_t> mcuComponents;
    std::vector<uint32_t> signalSubscribers;
    std::vector<uint32_t> plcComponents;
};

struct ElectricalGroupPlan {
    std::vector<uint32_t> nodeIndices;
    size_t totalSize = 0;
};

/** Somente estrutura elétrica imutável; matrizes, soluções e fatorações ficam no RuntimeState. */
struct ElectricalPlan {
    uint64_t revision = 0;
    std::vector<ElectricalGroupPlan> groups;
    std::vector<PinSlotResolution> resolutionBySlot;
    std::vector<std::vector<uint32_t>> listenersByNode;
    std::vector<std::vector<NodePinRef>> pinRefsByNode;
    std::vector<uint32_t> slotToNode;
    std::vector<ExtraVariableResolution> extraVariablesByComponent;
    std::vector<ComponentStampResolution> stampResolutionByComponent;
};

enum class ElectricalSignalBridgeKind : uint8_t {
    VoltageSensor,
    CurrentSensor,
    DigitalInput,
    ControlledVoltageSource,
    ControlledCurrentSource,
    DigitalOutput,
};

struct ElectricalSignalBridgeDefinition {
    ElectricalSignalBridgeKind kind = ElectricalSignalBridgeKind::VoltageSensor;
    uint32_t componentIndex = 0;
    std::string signalBlockId;
};

struct SignalPlan {
    uint64_t revision = 0;
    std::vector<uint32_t> subscribers;
    struct Route {
        SignalDescriptor descriptor;
        std::vector<uint32_t> nodeIndices;
    };
    struct Subscriber {
        uint32_t componentIndex = 0;
        std::vector<Route> channels;
    };
    std::vector<Subscriber> resolvedSubscribers;
    std::shared_ptr<const CompiledSignalGraph> engine;
    struct BridgeBinding {
        ElectricalSignalBridgeDefinition definition;
        SignalSlotHandle signal;
    };
    std::vector<BridgeBinding> electricalBridges;
};

struct ExternalBindingPlan {
    uint64_t revision = 0;
    std::vector<uint32_t> processComponents;
};

struct PlcPlan {
    uint64_t revision = 0;
    std::vector<uint32_t> instances;
};

struct SimulationPlan {
    uint64_t generation = 0;
    uint64_t authoringRevision = 0;
    std::string normalizedAuthoringHash;
    std::shared_ptr<const DenseExecutionLists> execution;
    std::shared_ptr<const ElectricalPlan> electrical;
    std::shared_ptr<const SignalPlan> signal;
    std::shared_ptr<const ExternalBindingPlan> externalBindings;
    std::shared_ptr<const PlcPlan> plc;
};

struct PlanCompileInput {
    uint64_t authoringRevision = 0;
    uint64_t electricalRevision = 0;
    size_t componentCapacity = 0;
    /** JSON/texto canônico por componentIndex, produzido pelo normalizador da sessão. */
    std::vector<std::string> normalizedComponentState;
    const Topology* electricalTopology = nullptr;
    DenseExecutionLists execution;
    std::vector<SignalPlan::Subscriber> resolvedSignalSubscribers;
    const SignalGraphDefinition* signalGraph = nullptr;
    std::vector<ElectricalSignalBridgeDefinition> electricalSignalBridges;
    PlanInvalidation invalidation{PlanDomain::All};
    std::shared_ptr<const SimulationPlan> previous;
};

class PlanCompiler {
public:
    /** Compila em staging e só devolve um plano completo. Exceções não alteram o plano anterior. */
    static std::shared_ptr<const SimulationPlan> compile(const PlanCompileInput& input);
};

} // namespace lasecsimul::simulation
