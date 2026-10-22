#include "python/PythonRuntime.hpp"

#include <chrono>
#include <cstdio>
#include <string>
#include <vector>

#if defined(_WIN32)
#include <windows.h>
#include <psapi.h>
#else
#include <sys/resource.h>
#include <sys/times.h>
#include <unistd.h>
#endif

using namespace lasecsimul;

namespace {
struct ProcessSample { double cpuMs = 0; double privateMb = 0; };
ProcessSample sampleProcess(uint64_t pid) {
    ProcessSample sample;
#if defined(_WIN32)
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, FALSE, static_cast<DWORD>(pid));
    if (!process) return sample;
    FILETIME created{}, exited{}, kernel{}, user{};
    PROCESS_MEMORY_COUNTERS_EX memory{};
    if (GetProcessTimes(process, &created, &exited, &kernel, &user)) {
        const uint64_t ticks = (static_cast<uint64_t>(kernel.dwHighDateTime) << 32) | kernel.dwLowDateTime;
        const uint64_t userTicks = (static_cast<uint64_t>(user.dwHighDateTime) << 32) | user.dwLowDateTime;
        sample.cpuMs = static_cast<double>(ticks + userTicks) / 10000.0;
    }
    if (K32GetProcessMemoryInfo(process, reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&memory), sizeof(memory)))
        sample.privateMb = static_cast<double>(memory.PrivateUsage) / (1024.0 * 1024.0);
    CloseHandle(process);
#else
    (void)pid;
    rusage usage{};
    if (getrusage(RUSAGE_CHILDREN, &usage) == 0) {
        sample.cpuMs = static_cast<double>(usage.ru_utime.tv_sec + usage.ru_stime.tv_sec) * 1000.0 +
                       static_cast<double>(usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) / 1000.0;
        sample.privateMb = static_cast<double>(usage.ru_maxrss) / 1024.0;
    }
#endif
    return sample;
}

void runCase(size_t blockCount, size_t inputCount, size_t cycles) {
#if !defined(LASECSIMUL_TEST_PYTHON_EXECUTABLE)
    (void)blockCount; (void)inputCount; (void)cycles;
    std::puts("PULADO: CMake nao encontrou Python 3");
#else
    auto budget = resources::ResourceGovernor::forProfile(resources::ResourceProfile::SharedHost, 4).budget();
    budget.pythonStepTimeoutMs = 5000;
    budget.pythonMemoryBytes = 256ull * 1024ull * 1024ull;
    budget.pythonPayloadBytes = 4ull * 1024ull * 1024ull;
    python::PythonRuntime runtime(budget, LASECSIMUL_TEST_PYTHON_EXECUTABLE);
    std::vector<python::PythonBlockDefinition> definitions;
    std::vector<python::PythonStep> steps;
    definitions.reserve(blockCount); steps.reserve(blockCount);
    std::vector<python::PythonPortDefinition> inputPorts;
    std::string source;
    for (size_t input = 0; input < inputCount; ++input) {
        const std::string name = "x" + std::to_string(input);
        inputPorts.push_back({name, "real"});
        source += (input == 0 ? "y = " : " + ") + name;
    }
    source += "\n";
    for (size_t block = 0; block < blockCount; ++block) {
        python::PythonBlockDefinition definition;
        definition.blockId = "python-" + std::to_string(block);
        definition.source = source;
        definition.inputs = inputPorts;
        definition.outputs = {{"y", "real"}};
        definitions.push_back(std::move(definition));
        python::PythonStep step;
        step.blockId = "python-" + std::to_string(block);
        step.dtNs = 1'000'000;
        for (size_t input = 0; input < inputCount; ++input) step.typedInputs["x" + std::to_string(input)] = 1.0;
        steps.push_back(std::move(step));
    }
    runtime.configure(std::move(definitions));
    (void)runtime.stepBatch(1'000'000, "1ms", steps); // inclui startup e import/compile, não medidos abaixo
    const uint64_t pid = runtime.workerProcessId();
    const ProcessSample before = sampleProcess(pid);
    const auto started = std::chrono::steady_clock::now();
    for (size_t cycle = 0; cycle < cycles; ++cycle)
        (void)runtime.stepBatch((cycle + 2) * 1'000'000, "1ms", steps);
    const auto elapsed = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
    const ProcessSample after = sampleProcess(pid);
    const double stepCount = static_cast<double>(blockCount * cycles);
    std::printf("%zu,%zu,%zu,%.6f,%.3f,%.3f,%.3f\n", blockCount, inputCount, cycles,
                elapsed / static_cast<double>(cycles), (after.cpuMs - before.cpuMs),
                after.privateMb, stepCount / elapsed * 1000.0);
    runtime.shutdown();
#endif
}
}

int main() {
    std::puts("blocks,inputs_per_block,cycles,wall_ms_per_batch,worker_cpu_ms,worker_private_mb,steps_per_second");
    runCase(1, 1, 1000);
    runCase(10, 1, 1000);
    runCase(100, 1, 500);
    runCase(1, 4, 1000);
    runCase(1, 16, 1000);
}
