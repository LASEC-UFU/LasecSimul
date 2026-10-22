#include "python/PythonProgramBlock.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "session/SimulationSession.hpp"

#include <chrono>
#include <cstdio>
#include <string>
#include <thread>

#if defined(_WIN32)
#include <windows.h>
#include <psapi.h>
#endif

using namespace lasecsimul;

namespace {
struct WorkerSample { double cpuMs = 0; double privateMb = 0; };
WorkerSample sampleWorker(uint64_t pid) {
    WorkerSample sample;
#if defined(_WIN32)
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, FALSE, static_cast<DWORD>(pid));
    if (!process) return sample;
    FILETIME created{}, exited{}, kernel{}, user{};
    PROCESS_MEMORY_COUNTERS_EX memory{};
    if (GetProcessTimes(process, &created, &exited, &kernel, &user)) {
        const uint64_t kernelTicks = (static_cast<uint64_t>(kernel.dwHighDateTime) << 32) | kernel.dwLowDateTime;
        const uint64_t userTicks = (static_cast<uint64_t>(user.dwHighDateTime) << 32) | user.dwLowDateTime;
        sample.cpuMs = static_cast<double>(kernelTicks + userTicks) / 10000.0;
    }
    if (K32GetProcessMemoryInfo(process, reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&memory), sizeof(memory)))
        sample.privateMb = static_cast<double>(memory.PrivateUsage) / (1024.0 * 1024.0);
    CloseHandle(process);
#else
    (void)pid;
#endif
    return sample;
}

void runCase(size_t blockCount, uint64_t periodNs, size_t inputCount) {
    plugins::GlobalPluginCache cache;
    auto budget = resources::ResourceGovernor::forProfile(resources::ResourceProfile::SharedHost, 4).budget();
    budget.pythonStepTimeoutMs = 5000;
    budget.pythonMemoryBytes = 256ull * 1024ull * 1024ull;
    budget.pythonPayloadBytes = 4ull * 1024ull * 1024ull;
    session::SimulationSession session(cache, 32, resources::ResourceGovernor(budget));
    session.setPythonExecutable(LASECSIMUL_TEST_PYTHON_EXECUTABLE);
    session.components().registerFactory(python::PythonProgramBlock::kTypeId, [](const registry::ComponentParams& params) {
        return std::make_unique<python::PythonProgramBlock>(params);
    });
    std::string ports = "{\"inputs\":[";
    std::string source;
    for (size_t i = 0; i < inputCount; ++i) {
        if (i) ports += ",";
        const std::string name = "x" + std::to_string(i);
        ports += "{\"name\":\"" + name + "\",\"type\":\"real\"}";
        source += (i == 0 ? "y = " : " + ") + name;
    }
    ports += "],\"outputs\":[{\"name\":\"y\",\"type\":\"real\"}]}";
    source += "\n";
    for (size_t block = 0; block < blockCount; ++block) {
        registry::ComponentParams params;
        params.properties["source"] = source;
        params.properties["ports"] = ports;
        params.properties["periodNs"] = static_cast<double>(periodNs);
        session.addComponent(python::PythonProgramBlock::kTypeId, params);
    }
    session.scheduler().start();
    const auto startupDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(15);
    const auto stepCount = [&] { return session.scheduler().synchronized([&] { return session.pythonRuntime().metrics().steps; }); };
    while (stepCount() == 0 && std::chrono::steady_clock::now() < startupDeadline)
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    if (stepCount() == 0) {
        session.stopSimulation();
        std::fprintf(stderr, "startup timeout for %zu blocks at %llu ns\n", blockCount, static_cast<unsigned long long>(periodNs));
        return;
    }
    const uint64_t pid = session.scheduler().synchronized([&] { return session.pythonRuntime().workerProcessId(); });
    const WorkerSample before = sampleWorker(pid);
    const uint64_t startSimNs = session.scheduler().nowNs();
    const uint64_t startSteps = stepCount();
    const auto started = std::chrono::steady_clock::now();
    std::this_thread::sleep_for(std::chrono::seconds(2));
    const double wallSeconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count();
    const uint64_t endSimNs = session.scheduler().nowNs();
    const uint64_t steps = stepCount() - startSteps;
    const WorkerSample after = sampleWorker(pid);
    session.stopSimulation();
    const double simulatedSeconds = static_cast<double>(endSimNs - startSimNs) * 1e-9;
    std::printf("%zu,%llu,%zu,%.3f,%.3f,%llu,%.3f,%.3f\n", blockCount,
        static_cast<unsigned long long>(periodNs), inputCount, wallSeconds, simulatedSeconds,
        static_cast<unsigned long long>(steps), after.cpuMs - before.cpuMs, after.privateMb);
}
}

int main() {
#if !defined(LASECSIMUL_TEST_PYTHON_EXECUTABLE)
    std::puts("PULADO: CMake nao encontrou Python 3");
    return 0;
#else
    std::puts("blocks,period_ns,inputs_per_block,wall_s,simulated_s,steps,worker_cpu_ms,worker_private_mb");
    for (uint64_t period : {1'000'000ull, 10'000'000ull, 100'000'000ull})
        for (size_t blocks : {1u, 10u, 100u}) runCase(blocks, period, 1);
    runCase(1, 10'000'000ull, 4);
    runCase(1, 10'000'000ull, 16);
    return 0;
#endif
}
