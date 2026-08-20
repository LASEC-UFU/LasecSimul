#include "ResourceGovernor.hpp"

#include <algorithm>
#include <stdexcept>
#include <thread>
#include <utility>

namespace lasecsimul::resources {
namespace {

constexpr uint64_t kib(uint64_t value) { return value * 1024ull; }
constexpr uint64_t mib(uint64_t value) { return kib(value) * 1024ull; }
constexpr uint64_t gib(uint64_t value) { return mib(value) * 1024ull; }

size_t detectedLogicalProcessors() {
    return std::max<size_t>(1, std::thread::hardware_concurrency());
}

} // namespace

ResourceGovernor::ResourceGovernor(ResourceProfile profile)
    : ResourceGovernor(profile, makeBudget(profile, detectedLogicalProcessors())) {
    if (profile == ResourceProfile::Custom) {
        throw std::invalid_argument("o perfil Custom exige um ResourceBudget explicito");
    }
}

ResourceGovernor::ResourceGovernor(ResourceBudget customBudget)
    : ResourceGovernor(ResourceProfile::Custom, std::move(customBudget)) {}

ResourceGovernor ResourceGovernor::forProfile(ResourceProfile profile, size_t logicalProcessors) {
    if (profile == ResourceProfile::Custom) {
        throw std::invalid_argument("o perfil Custom exige um ResourceBudget explicito");
    }
    return ResourceGovernor(profile, makeBudget(profile, logicalProcessors));
}

ResourceGovernor::ResourceGovernor(ResourceProfile profile, ResourceBudget budget)
    : m_profile(profile), m_budget(std::move(budget)) {
    validate(m_budget);
}

ResourceBudget ResourceGovernor::makeBudget(ResourceProfile profile, size_t logicalProcessors) {
    const size_t processors = std::max<size_t>(1, logicalProcessors);
    const bool shared = profile == ResourceProfile::SharedHost;

    // Automatic adota Desktop, mas reserva ao menos um processador logico para SO/UI. O teto
    // evita conceder uma maquina inteira a cada sessao em hosts grandes.
    const size_t parallelTasks = shared ? std::min<size_t>(2, processors)
                                        : (processors <= 2 ? 1 : std::min<size_t>(8, processors - 1));

    ResourceBudget budget;
    budget.maxWorkerThreads = parallelTasks - 1;
    budget.maxParallelTasks = parallelTasks;
    budget.maxExternalProcesses = shared ? 2 : 4;
    budget.maxBuildJobs = 1;
    budget.plcVmMemoryBytes = shared ? mib(64) : mib(256);
    budget.telemetryBytesPerSecond = shared ? kib(256) : mib(2);
    budget.telemetryQueueBytes = shared ? mib(1) : mib(8);
    budget.scopeHistoryBytes = shared ? mib(32) : mib(256);
    budget.logBytes = shared ? mib(4) : mib(16);
    budget.cacheBytes = shared ? mib(512) : gib(2);
    budget.commandQueueCapacity = shared ? 256 : 1024;
    budget.pythonMemoryBytes = shared ? mib(128) : mib(512);
    budget.pythonPayloadBytes = shared ? mib(1) : mib(8);
    budget.pythonStepTimeoutMs = shared ? 250 : 1000;
    return budget;
}

void ResourceGovernor::validate(const ResourceBudget& budget) {
    if (budget.maxParallelTasks == 0) {
        throw std::invalid_argument("maxParallelTasks deve incluir ao menos a thread coordenadora");
    }
    if (budget.maxParallelTasks > budget.maxWorkerThreads + 1) {
        throw std::invalid_argument("maxParallelTasks excede workers mais a thread coordenadora");
    }
    if (budget.maxBuildJobs > budget.maxExternalProcesses) {
        throw std::invalid_argument("maxBuildJobs nao pode exceder maxExternalProcesses");
    }
    if (budget.telemetryQueueBytes == 0 || budget.commandQueueCapacity == 0) {
        throw std::invalid_argument("filas devem declarar capacidade positiva");
    }
    if (budget.maxExternalProcesses > 0 &&
        (budget.pythonMemoryBytes == 0 || budget.pythonPayloadBytes == 0 || budget.pythonStepTimeoutMs == 0)) {
        throw std::invalid_argument("runtime Python exige limites positivos de memoria, payload e watchdog");
    }
}

ParallelGrant ResourceGovernor::grantParallelTasks(size_t taskCount, size_t estimatedWork,
                                                    size_t minimumParallelWork) const {
    ParallelGrant grant;
    grant.taskCount = taskCount;
    if (taskCount < 2 || estimatedWork < minimumParallelWork || m_budget.maxWorkerThreads == 0) {
        return grant;
    }
    grant.parallelTasks = std::min({taskCount, m_budget.maxParallelTasks,
                                    m_budget.maxWorkerThreads + 1});
    grant.workerThreads = grant.parallelTasks - 1;
    return grant;
}

} // namespace lasecsimul::resources
