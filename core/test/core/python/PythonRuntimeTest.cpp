#include "python/PythonRuntime.hpp"

#include <cmath>
#include <cstdio>
#include <algorithm>
#include <cctype>
#include <stdexcept>
#include <string>

using namespace lasecsimul;

namespace {
int failures = 0;
#define CHECK(condition, message) do { if (!(condition)) { std::fprintf(stderr, "FAIL: %s\n", message); ++failures; } } while (false)

resources::ResourceBudget testBudget(uint32_t timeoutMs = 1000) {
    auto budget = resources::ResourceGovernor::forProfile(resources::ResourceProfile::SharedHost, 4).budget();
    budget.pythonStepTimeoutMs = timeoutMs;
    budget.pythonMemoryBytes = 128ull * 1024ull * 1024ull;
    budget.pythonPayloadBytes = 256ull * 1024ull;
    return budget;
}

std::string interpreter() {
#if defined(LASECSIMUL_TEST_PYTHON_EXECUTABLE)
    return LASECSIMUL_TEST_PYTHON_EXECUTABLE;
#else
    return {};
#endif
}

std::string normalizedPath(std::string value) {
    std::replace(value.begin(), value.end(), '/', '\\');
#if defined(_WIN32)
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
#endif
    return value;
}

const char* kCounterSource = R"PY(
def step(inputs, state, time_ns):
    state["count"] = state.get("count", 0) + 1
    return {"value": inputs.get("x", 0.0) + state["count"], "time": float(time_ns)}
)PY";

void lazyBatchAndIsolation() {
    python::PythonRuntime runtime(testBudget(), interpreter());
    runtime.configure({{"a", kCounterSource}, {"b", kCounterSource}});
    CHECK(!runtime.workerRunning(), "configure must not create a Python process");

    const auto first = runtime.stepBatch(123456789ull, "rg-fast", {
        {"b", {{"x", 20.0}}}, {"a", {{"x", 10.0}}}, {"b", {{"x", 20.0}}}
    });
    CHECK(runtime.workerRunning(), "first STEP_BATCH must create exactly one lazy process");
    CHECK(runtime.metrics().workerStarts == 1, "one runtime must start one worker, not one per block");
    CHECK(first.size() == 3 && first[0].blockId == "b" && first[1].blockId == "a" && first[2].blockId == "b",
          "worker must preserve plan order exactly");
    CHECK(std::abs(first[0].outputs.at("value") - 21.0) < 1e-12 &&
          std::abs(first[1].outputs.at("value") - 11.0) < 1e-12 &&
          std::abs(first[2].outputs.at("value") - 22.0) < 1e-12,
          "blocks must own isolated namespaces/state inside the shared session worker");
    CHECK(first[0].outputs.at("time") == 123456789.0, "Python semantics must receive Core virtual time");
}

void sessionsNeverShareWorkerOrState() {
    python::PythonRuntime left(testBudget(), interpreter());
    python::PythonRuntime right(testBudget(), interpreter());
    left.configure({{"counter", kCounterSource}});
    right.configure({{"counter", kCounterSource}});
    const auto leftFirst = left.stepBatch(1, "rg", {{"counter", {}}});
    const auto leftSecond = left.stepBatch(2, "rg", {{"counter", {}}});
    const auto rightFirst = right.stepBatch(2, "rg", {{"counter", {}}});
    CHECK(left.workerProcessId() != 0 && right.workerProcessId() != 0 &&
          left.workerProcessId() != right.workerProcessId(), "two sessions must never share a Python worker process");
    CHECK(leftFirst[0].outputs.at("value") == 1.0 && leftSecond[0].outputs.at("value") == 2.0 &&
          rightFirst[0].outputs.at("value") == 1.0, "Python state must be isolated across sessions");
}

void timeoutFaultAndRestart() {
    python::PythonRuntime runtime(testBudget(100), interpreter());
    runtime.configure({{"hang", "def step(inputs, state, time_ns):\n    while True: pass\n"}});
    bool timedOut = false;
    try { (void)runtime.stepBatch(0, "rg", {{"hang", {}}}); }
    catch (const std::exception&) { timedOut = true; }
    CHECK(timedOut && runtime.health() == python::PythonWorkerHealth::Faulted && !runtime.workerRunning(),
          "watchdog timeout must fault the domain and terminate its worker");
    CHECK(runtime.metrics().timeouts == 1, "timeout must be observable in metrics");

    bool refusedWithoutRestart = false;
    try { (void)runtime.stepBatch(1, "rg", {{"hang", {}}}); }
    catch (const std::exception&) { refusedWithoutRestart = true; }
    CHECK(refusedWithoutRestart, "Faulted domain must require explicit restart");

    runtime.restart();
    runtime.configure({{"ok", kCounterSource}});
    const auto recovered = runtime.stepBatch(9, "rg", {{"ok", {}}});
    CHECK(recovered[0].outputs.at("value") == 1.0 && runtime.health() == python::PythonWorkerHealth::Ready,
          "restart must create a fresh namespace and recover on the next lazy batch");
}

void crashAndLimits() {
    python::PythonRuntime runtime(testBudget(), interpreter());
    runtime.configure({{"crash", "import os\ndef step(inputs, state, time_ns):\n    os._exit(23)\n"}});
    bool crashed = false;
    try { (void)runtime.stepBatch(0, "rg", {{"crash", {}}}); }
    catch (const std::exception&) { crashed = true; }
    CHECK(crashed && runtime.health() == python::PythonWorkerHealth::Faulted && runtime.metrics().crashes == 1,
          "abnormal interpreter exit must be contained and reported as a crash");

    auto forbidden = testBudget();
    forbidden.maxExternalProcesses = 0;
    python::PythonRuntime noProcesses(forbidden, interpreter());
    noProcesses.configure({{"a", kCounterSource}});
    bool rejected = false;
    try { (void)noProcesses.stepBatch(0, "rg", {{"a", {}}}); }
    catch (const std::exception&) { rejected = true; }
    CHECK(rejected && !noProcesses.workerRunning(), "maxExternalProcesses=0 must prevent worker creation");

    auto tiny = testBudget();
    tiny.pythonPayloadBytes = 64;
    python::PythonRuntime limited(tiny, interpreter());
    bool oversized = false;
    try { limited.configure({{"a", std::string(100, 'x')}}); }
    catch (const std::invalid_argument&) { oversized = true; }
    CHECK(oversized && !limited.workerRunning(), "definition payload must be rejected before process creation");
}

void interpreterSelectionChangesOnlyBetweenWorkers() {
    python::PythonRuntime runtime(testBudget(), interpreter());
    runtime.configure({{"selected", kCounterSource}});
    (void)runtime.stepBatch(0, "rg", {{"selected", {}}});
    CHECK(normalizedPath(runtime.environment().executable) == normalizedPath(interpreter()),
          ("worker diagnostics must report the selected Python executable: got '" + runtime.environment().executable + "', expected '" + interpreter() + "'").c_str());
    bool refusedWhileRunning = false;
    try { runtime.setPythonExecutable(interpreter()); }
    catch (const std::logic_error&) { refusedWhileRunning = true; }
    CHECK(refusedWhileRunning && runtime.workerRunning(),
          "changing interpreters while a worker is active must be rejected without stopping it");
    runtime.shutdown();
    runtime.setPythonExecutable(interpreter());
    CHECK(!runtime.workerRunning(), "changing interpreters while stopped must not eagerly start a process");
    runtime.configure({{"selected", kCounterSource}});
    (void)runtime.stepBatch(1, "rg", {{"selected", {}}});
    CHECK(normalizedPath(runtime.environment().executable) == normalizedPath(interpreter()),
          ("the next worker must start with the newly selected interpreter: got '" + runtime.environment().executable + "', expected '" + interpreter() + "'").c_str());
}

void stepTimeoutSettingIsValidated() {
    python::PythonRuntime runtime(testBudget(), interpreter());
    runtime.setStepTimeoutMs(10);
    runtime.setStepTimeoutMs(60'000);
    bool tooSmall = false, tooLarge = false;
    try { runtime.setStepTimeoutMs(9); } catch (const std::invalid_argument&) { tooSmall = true; }
    try { runtime.setStepTimeoutMs(60'001); } catch (const std::invalid_argument&) { tooLarge = true; }
    CHECK(tooSmall && tooLarge, "Python timeout setting accepts only 10..60000 ms");
}
} // namespace

int main() {
    if (interpreter().empty()) {
        std::printf("PULADO: CMake nao encontrou um interpretador Python 3\n");
        return 0;
    }
    lazyBatchAndIsolation();
    sessionsNeverShareWorkerOrState();
    timeoutFaultAndRestart();
    crashAndLimits();
    interpreterSelectionChangesOnlyBetweenWorkers();
    stepTimeoutSettingIsValidated();
    if (failures == 0) std::printf("Python runtime STEP_BATCH/watchdog/restart: OK\n");
    return failures == 0 ? 0 : 1;
}
