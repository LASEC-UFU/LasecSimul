#pragma once

#include <string>
#include <unordered_map>

#include "SignalEngine.hpp"
#include "../registry/SubcircuitRegistry.hpp"

namespace lasecsimul::simulation {

struct CompiledProcessSubcircuit {
    SignalGraphDefinition graph;
    std::unordered_map<std::string, std::string> externalInputs;
    std::unordered_map<std::string, std::string> externalOutputs;
    std::string semanticHash;
};

/** Cold-path adapter from the existing schemaVersion-3 subcircuit contract to SignalGraphDefinition.
 * It does not introduce a second hierarchy or runtime: tunnels remain the shell, components/topology
 * remain the implementation, and the result executes in the ordinary SignalRuntime. */
class ProcessSubcircuitCompiler {
public:
    static CompiledProcessSubcircuit compile(
        const registry::SubcircuitRegistry& registry,
        const std::string& typeId,
        const std::unordered_map<std::string, double>& parameterOverrides = {});
};

} // namespace lasecsimul::simulation
