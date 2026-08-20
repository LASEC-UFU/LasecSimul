#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "Netlist.hpp"
#include "SignalEngine.hpp"
#include "lasecsimul/Signal.hpp"
#include "../plc/PlcNativeModule.hpp"

namespace lasecsimul::simulation {

enum class PlanDomain : uint32_t {
    None = 0,
    Electrical = 1u << 0,
    Signal = 1u << 1,
    External = 1u << 2,
    Plc = 1u << 3,
    Python = 1u << 4,
    ExecutionIndex = 1u << 5,
    All = (1u << 6) - 1u,
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
    std::vector<uint32_t> pythonComponents;
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

/** Um I/O do PLC resolvido contra o Signal Engine já compilado (F9.5) -- uma entrada por
 * `PlcNativeModule::exportedIo[]`, sempre (mesmo sem ligação pedida pelo autor -- ver
 * `signalBlockId` abaixo). `ioId`/`name`/`direction`/`iecType` são cópias diretas de
 * `PlcExportedIo` (identidade estável já resolvida em F9.3, não reinventada aqui). */
struct PlcIoBinding {
    std::string ioId;
    std::string name;
    std::string direction; // "input" | "output"
    std::string iecType;
    /** Vazio = o autor não pediu ligação pra este I/O (ou pediu uma que não resolveu) -- o I/O
     * existe como pino/identidade, mas nenhum valor é trocado com o Signal Engine nesse scan
     * (INPUT usa o valor zero do tipo; OUTPUT simplesmente não é publicado). Não é um erro --
     * mesma semântica de um pino elétrico real não ligado a nada. */
    std::string signalBlockId;
    /** Só presente quando `signalBlockId` resolveu com sucesso contra o grafo compilado. INPUT lê
     * daqui (`SignalRuntime::real/boolean`); OUTPUT escreve em `signalBlockId` via
     * `SignalRuntime::setExternalReal/Bool` (exige que o bloco alvo seja `ExternalInput`, mesma
     * exigência já usada por `ElectricalSignalBridgeKind::DigitalInput`/sensores). */
    std::optional<SignalSlotHandle> signal;
};

/** Uma instância de PLC no plano compilado (F9.5) -- por `componentIndex` (`PlcComponent`, ver
 * `core/src/plc/PlcComponent.hpp`). `artifact == nullptr` = bloco sem artefato carregado ainda:
 * zero `ioBindings`, o componente correspondente já reporta zero pinos por conta própria (ver
 * `PlcComponent::loadArtifact`). */
struct PlcInstancePlan {
    uint32_t componentIndex = 0;
    std::shared_ptr<const plc::PlcNativeModule> artifact;
    /** Intervalo entre scans desta instância -- Round 1 simplification: fixo por instância (via
     * `PlcComponent::setTaskIntervalNs`, default 10ms), não configurável por `TASK`/`CONFIGURATION`
     * IEC 61131-3 ainda (não há frontend pra `CONFIGURATION`/`RESOURCE`/`TASK` nesta rodada, só
     * `PROGRAM` -- ver plano F9 Rodada 1). Documentado como limitação, não inventado silenciosamente
     * como algo mais sofisticado. */
    uint64_t taskIntervalNs = 10'000'000;
    /** Uma entrada por `artifact->exportedIo[]`, nesta ordem -- vazio se `artifact` for nulo. */
    std::vector<PlcIoBinding> ioBindings;
    /** `ioId` pedidos pelo autor (`PlcComponent::ioBindingRequests()`) que NÃO correspondem a
     * nenhum `exportedIo[].ioId` do artefato atual -- diagnosticável (ex.: artefato recarregado e a
     * variável mudou de nome), nunca silenciosamente aplicado a outra coisa nem descartado sem
     * rastro. */
    std::vector<std::string> orphanedBindingRequests;
};

struct PlcPlan {
    uint64_t revision = 0;
    std::vector<PlcInstancePlan> instances;
};

/** Entrada de `PlanCompileInput` pra uma instância de PLC (F9.5) -- espelha
 * `ElectricalSignalBridgeDefinition` na forma (pedido bruto do autor, resolvido/validado só dentro
 * de `PlanCompiler::compile`), não `PlcInstancePlan` (que já é o resultado resolvido). */
struct PlcIoBindingRequest {
    std::string ioId;
    std::string signalBlockId;
};

struct PlcInstanceDescriptor {
    uint32_t componentIndex = 0;
    std::shared_ptr<const plc::PlcNativeModule> artifact;
    uint64_t taskIntervalNs = 10'000'000;
    std::vector<PlcIoBindingRequest> ioBindingRequests;
};

struct PythonBlockPlan {
    std::string blockId;
    std::string source;
    std::string rateGroupId;
    std::vector<std::string> dependencies;
};

struct PythonPlan {
    uint64_t revision = 0;
    std::vector<PythonBlockPlan> blocks;
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
    std::shared_ptr<const PythonPlan> python;
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
    std::vector<PythonBlockPlan> pythonBlocks;
    /** Um `PlcInstanceDescriptor` por instância de PLC ativa -- `SimulationSession::publishSimulationPlan`
     * constrói isto direto de cada `PlcComponent` (artefato + `taskIntervalNs` + pedidos de ligação),
     * mesmo padrão de `input.normalizedComponentState` (consulta direta ao componente, sem lista de
     * autoria separada -- ao contrário de `pythonBlocks`/`electricalSignalBridges`, que representam
     * ligações cross-componente, um PLC instance descriptor pertence inteiramente a UM componente). */
    std::vector<PlcInstanceDescriptor> plcInstances;
    PlanInvalidation invalidation{PlanDomain::All};
    std::shared_ptr<const SimulationPlan> previous;
};

class PlanCompiler {
public:
    /** Compila em staging e só devolve um plano completo. Exceções não alteram o plano anterior. */
    static std::shared_ptr<const SimulationPlan> compile(const PlanCompileInput& input);
};

} // namespace lasecsimul::simulation
