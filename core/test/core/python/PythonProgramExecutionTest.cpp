#include "python/PythonRuntime.hpp"

#include <cmath>
#include <cstdio>
#include <string>

using namespace lasecsimul;

int main() {
#if !defined(LASECSIMUL_TEST_PYTHON_EXECUTABLE)
    std::puts("PULADO: CMake nao encontrou um interpretador Python 3");
    return 0;
#else
    auto budget = resources::ResourceGovernor::forProfile(resources::ResourceProfile::SharedHost, 4).budget();
    budget.pythonStepTimeoutMs = 1000;
    budget.pythonMemoryBytes = 128ull * 1024ull * 1024ull;
    budget.pythonPayloadBytes = 256ull * 1024ull;
    python::PythonRuntime runtime(budget, LASECSIMUL_TEST_PYTHON_EXECUTABLE);
    python::PythonBlockDefinition definition;
    definition.blockId = "direct";
    definition.rateGroupId = "100000000";
    definition.source = "state.integral = state.get('integral', 0.0) + temperature * sim.dt\n"
                       "reference = temperature * 2.0 + state.integral\n"
                       "enabled = enable and reference > 0\n"
                       "ticks = sim.step\n"
                       "loop_total = sum(range(sim.step))\n";
    definition.inputs = {{"temperature", "real"}, {"enable", "bool"}};
    definition.outputs = {{"reference", "real"}, {"enabled", "bool"}, {"ticks", "int64"}, {"loop_total", "int64"}};
    runtime.configure({definition});

    const auto run = [&](uint64_t timestampNs) {
        python::PythonStep step;
        step.blockId = "direct";
        step.dtNs = 100'000'000;
        step.typedInputs["temperature"] = 25.0;
        step.typedInputs["enable"] = true;
        return runtime.stepBatch(timestampNs, "100000000", {step}).front();
    };
    const auto first = run(100'000'000);
    const auto second = run(200'000'000);
    const auto firstReference = std::get<double>(first.typedOutputs.at("reference"));
    const auto secondReference = std::get<double>(second.typedOutputs.at("reference"));
    if (std::abs(firstReference - 52.5) > 1e-9 || std::abs(secondReference - 55.0) > 1e-9 ||
        std::get<bool>(first.typedOutputs.at("enabled")) != true ||
        std::get<int64_t>(first.typedOutputs.at("ticks")) != 1 ||
        std::get<int64_t>(second.typedOutputs.at("ticks")) != 2 ||
        std::get<int64_t>(first.typedOutputs.at("loop_total")) != 0 ||
        std::get<int64_t>(second.typedOutputs.at("loop_total")) != 1) {
        std::fprintf(stderr, "Python direct variables/state/sim context failed\n");
        runtime.shutdown();
        return 1;
    }
    runtime.shutdown();
    runtime.configure({{"syntax", "if True print('invalid')"}});
    bool syntaxReported = false;
    try { (void)runtime.stepBatch(0, "syntax", {{"syntax", {}}}); }
    catch (const std::exception& error) { syntaxReported = std::string(error.what()).find("invalid syntax") != std::string::npos; }
    if (!syntaxReported || runtime.health() != python::PythonWorkerHealth::Faulted) {
        std::fprintf(stderr, "Python syntax error was not reported by the runtime\n");
        return 1;
    }
    runtime.restart();
    python::PythonBlockDefinition failing;
    failing.blockId = "exception";
    failing.source = "raise RuntimeError('expected block error')";
    failing.outputs = {{"held", "real", 3.0}};
    python::PythonBlockDefinition healthy;
    healthy.blockId = "healthy";
    healthy.source = "y = 7.0";
    healthy.outputs = {{"y", "real", 0.0}};
    runtime.configure({failing, healthy});
    const auto isolated = runtime.stepBatch(0, "exception", {{"exception", {}}, {"healthy", {}}});
    const auto isolatedAgain = runtime.stepBatch(1, "exception", {{"exception", {}}, {"healthy", {}}});
    if (isolated.size() != 2 || isolated[0].error.find("expected block error") == std::string::npos ||
        std::get<double>(isolated[0].typedOutputs.at("held")) != 3.0 ||
        std::get<double>(isolated[1].typedOutputs.at("y")) != 7.0 ||
        isolatedAgain[0].error.empty() || std::get<double>(isolatedAgain[1].typedOutputs.at("y")) != 7.0 ||
        runtime.health() != python::PythonWorkerHealth::Ready) {
        std::fprintf(stderr, "Python block exception was not isolated from healthy blocks\n");
        return 1;
    }
    runtime.shutdown();
    std::puts("Python variables, loops, state, time, syntax and isolated runtime diagnostics: OK");
    return 0;
#endif
}
