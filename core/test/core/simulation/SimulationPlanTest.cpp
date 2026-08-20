#include <cstdio>
#include <stdexcept>

#include "simulation/RuntimeState.hpp"

using namespace lasecsimul::simulation;

namespace {

int failures = 0;

#define CHECK(expr, message) \
    do { \
        if (!(expr)) { \
            std::fprintf(stderr, "FALHOU: %s -- %s\n", message, #expr); \
            ++failures; \
        } \
    } while (false)

Topology topologyWithTwoNodes() {
    Topology topology;
    topology.groups.emplace_back(std::vector<uint32_t>{0, 1});
    topology.resolutionBySlot = {{0, 0}, {0, 1}};
    topology.listenersByNode = {{0}, {1}};
    topology.pinRefsByNode = {{{0, 0}}, {{1, 0}}};
    topology.slotToNode = {0, 1};
    topology.extraVariablesByComponent.resize(2);
    topology.stampResolutionByComponent.resize(2);
    topology.stampResolutionByComponent[0].groupIndex = 0;
    topology.stampResolutionByComponent[0].localIndexByPinId.emplace("out", 0);
    topology.stampResolutionByComponent[1].groupIndex = 0;
    topology.stampResolutionByComponent[1].localIndexByPinId.emplace("in", 1);
    return topology;
}

PlanCompileInput inputFor(const Topology& topology) {
    PlanCompileInput input;
    input.authoringRevision = 7;
    input.electricalRevision = 3;
    input.componentCapacity = 4;
    input.electricalTopology = &topology;
    input.execution.activeComponents = {0, 1};
    input.execution.reactiveComponents = {1};
    input.execution.fpgaComponents = {0};
    input.execution.signalSubscribers = {1};
    return input;
}

void planIsImmutableAndDomainIncremental() {
    Topology topology = topologyWithTwoNodes();
    PlanCompileInput input = inputFor(topology);
    const auto first = PlanCompiler::compile(input);
    CHECK(first->generation == 1, "primeira publicacao usa geracao 1");
    CHECK(first->electrical->groups.size() == 1, "ElectricalPlan preserva grupos resolvidos");
    CHECK(first->execution->reactiveComponents == std::vector<uint32_t>{1},
          "lista reativa chega resolvida ao plano");

    input.previous = first;
    input.authoringRevision = 8;
    input.invalidation = PlanInvalidation(PlanDomain::Signal);
    const auto second = PlanCompiler::compile(input);
    CHECK(second->generation == 2, "publicacao incrementa geracao");
    CHECK(second->electrical == first->electrical, "dominio eletrico nao invalidado e compartilhado");
    CHECK(second->signal != first->signal, "somente SignalPlan invalidado e recompilado");
    CHECK(second->execution == first->execution, "indices densos nao invalidos sao compartilhados");
}

void failedCompilationPreservesPublishedPlan() {
    Topology topology = topologyWithTwoNodes();
    PlanCompileInput input = inputFor(topology);
    const auto published = PlanCompiler::compile(input);
    input.previous = published;
    input.execution.reactiveComponents = {3};
    bool rejected = false;
    try {
        (void)PlanCompiler::compile(input);
    } catch (const std::invalid_argument&) {
        rejected = true;
    }
    CHECK(rejected, "snapshot inconsistente e rejeitado antes da publicacao");
    CHECK(published->generation == 1 && published->execution->reactiveComponents == std::vector<uint32_t>{1},
          "plano anterior permanece intacto apos falha");
}

void runtimeStateIsIsolatedPerSession() {
    Topology topology = topologyWithTwoNodes();
    const auto plan = PlanCompiler::compile(inputFor(topology));
    RuntimeState first;
    RuntimeState second;
    first.bind(plan);
    second.bind(plan);
    first.nodeVoltages = {5.0, 0.0};
    second.nodeVoltages = {1.0, 0.0};
    CHECK(first.planGeneration == second.planGeneration, "runtimes podem referenciar a mesma geracao");
    CHECK(first.nodeVoltages[0] != second.nodeVoltages[0], "solucoes MNA nunca sao compartilhadas");
}

void invalidationIsExplicitByDomain() {
    PlanInvalidation invalidation;
    invalidation.invalidate(PlanDomain::Electrical | PlanDomain::ExecutionIndex);
    CHECK(invalidation.contains(PlanDomain::Electrical), "Electrical marcado");
    CHECK(!invalidation.contains(PlanDomain::Signal), "Signal preservado");
    invalidation.clear(PlanDomain::Electrical);
    CHECK(!invalidation.contains(PlanDomain::Electrical) &&
              invalidation.contains(PlanDomain::ExecutionIndex),
          "limpeza nao afeta outro dominio");
}

} // namespace

int main() {
    planIsImmutableAndDomainIncremental();
    failedCompilationPreservesPublishedPlan();
    runtimeStateIsIsolatedPerSession();
    invalidationIsExplicitByDomain();
    if (failures == 0) std::printf("SimulationPlan/RuntimeState: OK\n");
    return failures == 0 ? 0 : 1;
}
