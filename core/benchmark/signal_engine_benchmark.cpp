#include <chrono>
#include <cstdio>
#include <string>

#include "simulation/SignalEngine.hpp"

using namespace lasecsimul::simulation;

int main() {
    for (const uint32_t blockCount : {100u, 10000u, 100000u}) {
        SignalGraphDefinition definition;
        definition.blocks.reserve(blockCount);
        for (uint32_t index = 0; index < blockCount; ++index) {
            SignalBlockDefinition source;
            source.id = "source_" + std::to_string(index);
            source.kind = SignalBlockKind::Source;
            source.output = {"out", {SignalScalarType::Real, 1}, "V"};
            source.realParameters = {static_cast<double>(index)};
            source.rate = {1000, 0, 0};
            definition.blocks.push_back(std::move(source));
        }
        const auto compileBegin = std::chrono::steady_clock::now();
        const auto graph = SignalCompiler::compile(definition);
        const auto compileEnd = std::chrono::steady_clock::now();
        SignalRuntime runtime;
        runtime.bind(graph);
        const auto executeBegin = std::chrono::steady_clock::now();
        runtime.executeUntil(99'000); // 100 RateGroup activations.
        const auto executeEnd = std::chrono::steady_clock::now();
        const double compileMs = std::chrono::duration<double, std::milli>(compileEnd - compileBegin).count();
        const double executeMs = std::chrono::duration<double, std::milli>(executeEnd - executeBegin).count();
        const double nsPerBlock = std::chrono::duration<double, std::nano>(executeEnd - executeBegin).count() /
                                  static_cast<double>(runtime.metrics().blockEvaluations);
        std::printf("SIGNAL blocks=%u compile_ms=%.6f execute_ms=%.6f ns_per_block=%.3f\n",
                    blockCount, compileMs, executeMs, nsPerBlock);
    }
    return 0;
}
