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
    Topology electricalTopology;
    std::vector<double> nodeVoltages;
    std::vector<double> previousNodeVoltages;
    std::vector<uint64_t> lastEdgeTimeNs;
    std::vector<uint32_t> stampedThisRound;

    void bind(const std::shared_ptr<const SimulationPlan>& plan) {
        if (!plan || !plan->execution) throw std::invalid_argument("RuntimeState exige SimulationPlan completo");
        planGeneration = plan->generation;
        execution = *plan->execution;
    }
};

} // namespace lasecsimul::simulation
