#include "session/SimulationSession.hpp"
#include "plugins/GlobalPluginCache.hpp"

#include <cstdio>
#include <stdexcept>

using namespace lasecsimul;

namespace {
int failures = 0;
#define CHECK(condition, message) do { if (!(condition)) { std::fprintf(stderr, "FAIL: %s\n", message); ++failures; } } while (false)

resources::ResourceGovernor governor(uint32_t timeoutMs = 500) {
    auto budget = resources::ResourceGovernor::forProfile(resources::ResourceProfile::SharedHost, 4).budget();
    budget.pythonStepTimeoutMs = timeoutMs;
    return resources::ResourceGovernor(budget);
}

const char* source =
    "def step(inputs, state, time_ns):\n"
    "    state['n'] = state.get('n', 0) + 1\n"
    "    return {'y': inputs.get('x', 0.0) + state['n'], 't': float(time_ns)}\n";
}

int main() {
    plugins::GlobalPluginCache cache;
    session::SimulationSession simulationSession(cache, 16, governor());
    simulationSession.setPythonBlocks({{"first", source, "control"}, {"second", source, "control"}});
    const auto plan = simulationSession.simulationPlan();
    CHECK(plan && plan->python && plan->python->blocks.size() == 2,
          "Python definitions must compile into an immutable PythonPlan");
    CHECK(!simulationSession.pythonRuntime().workerRunning(), "publishing PythonPlan must not materialize a worker");

    bool wrongOrder = false;
    try {
        (void)simulationSession.stepPythonBatch("control", {{"second", {}}, {"first", {}}});
    } catch (const std::invalid_argument&) {
        wrongOrder = true;
    }
    CHECK(wrongOrder && !simulationSession.pythonRuntime().workerRunning(),
          "session must reject batches outside compiled order before process creation");

    const auto result = simulationSession.stepPythonBatch("control", {
        {"first", {{"x", 4.0}}}, {"second", {{"x", 9.0}}}
    });
    CHECK(result.size() == 2 && result[0].outputs.at("y") == 5.0 && result[1].outputs.at("y") == 10.0,
          "session must execute a complete RateGroup as one ordered batch");
    CHECK(result[0].outputs.at("t") == 0.0, "session, not caller or wall clock, owns Python timestamp");

    simulationSession.setPythonBlocks({{"hang", "def step(inputs, state, time_ns):\n    while True: pass\n", "fault"}});
    simulationSession.stopSimulation();
    simulationSession.scheduler().start();
    bool faulted = false;
    try { (void)simulationSession.stepPythonBatch("fault", {{"hang", {}}}); }
    catch (const std::exception&) { faulted = true; }
    CHECK(faulted && simulationSession.pythonRuntime().health() == python::PythonWorkerHealth::Faulted,
          "worker timeout must surface as a session-domain fault");
    CHECK(simulationSession.scheduler().isPaused(), "Python fault must pause the owning simulation session");
    simulationSession.stopSimulation();

    if (failures == 0) std::printf("Python Session/Plan integration: OK\n");
    return failures == 0 ? 0 : 1;
}
