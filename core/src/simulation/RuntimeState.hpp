#pragma once

#include <cstdint>
#include <memory>
#include <stdexcept>
#include <vector>

#include "SimulationPlan.hpp"

namespace lasecsimul::simulation {

/** Todo estado mutável da execução elétrica pertencente a uma sessão. */
struct RuntimeState {
    uint64_t planGeneration = 0;
    uint64_t virtualTimeNs = 0;
    DenseExecutionLists execution;
    std::vector<SignalPlan::Subscriber> resolvedSignalSubscribers;
    SignalRuntime signals;
    Topology electricalTopology;
    std::vector<double> nodeVoltages;
    std::vector<double> previousNodeVoltages;
    std::vector<uint64_t> lastEdgeTimeNs;
    std::vector<uint32_t> stampedThisRound;
    std::vector<uint32_t> stampedNonlinearThisRound;

    void bind(const std::shared_ptr<const SimulationPlan>& plan) {
        if (!plan || !plan->execution) throw std::invalid_argument("RuntimeState exige SimulationPlan completo");
        planGeneration = plan->generation;
        execution = *plan->execution;
        resolvedSignalSubscribers = plan->signal ? plan->signal->resolvedSubscribers
                                                 : std::vector<SignalPlan::Subscriber>{};
        const auto engine = plan->signal ? plan->signal->engine : nullptr;
        if (signals.graph() != engine) signals.bind(engine);
    }
};

} // namespace lasecsimul::simulation
