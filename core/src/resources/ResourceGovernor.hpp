#pragma once

#include <cstddef>
#include <cstdint>

namespace lasecsimul::resources {

enum class ResourceProfile {
    Automatic,
    Desktop,
    SharedHost,
    Custom,
};

/** Limites imutaveis aplicados a uma sessao durante uma rodada de simulacao. */
struct ResourceBudget {
    size_t maxWorkerThreads = 0;
    size_t maxParallelTasks = 1;
    size_t maxExternalProcesses = 0;
    size_t maxBuildJobs = 0;
    uint64_t plcVmMemoryBytes = 0;
    uint64_t telemetryBytesPerSecond = 0;
    uint64_t telemetryQueueBytes = 0;
    uint64_t scopeHistoryBytes = 0;
    uint64_t logBytes = 0;
    uint64_t cacheBytes = 0;
    size_t commandQueueCapacity = 1;
    uint64_t pythonMemoryBytes = 0;
    size_t pythonPayloadBytes = 0;
    uint32_t pythonStepTimeoutMs = 0;
};

struct ParallelGrant {
    size_t taskCount = 0;
    size_t parallelTasks = 1;
    size_t workerThreads = 0;

    bool usesWorkers() const { return workerThreads != 0; }
};

/**
 * Autoridade unica para capacidade de host e politica administrativa.
 *
 * Consumidores recebem concessoes/limites; nenhum pool deve consultar hardware_concurrency()
 * diretamente. O budget nao muda durante a vida deste objeto.
 */
class ResourceGovernor {
public:
    explicit ResourceGovernor(ResourceProfile profile = ResourceProfile::Automatic);
    explicit ResourceGovernor(ResourceBudget customBudget);

    static ResourceGovernor forProfile(ResourceProfile profile, size_t logicalProcessors);

    ResourceProfile profile() const { return m_profile; }
    const ResourceBudget& budget() const { return m_budget; }

    ParallelGrant grantParallelTasks(size_t taskCount, size_t estimatedWork,
                                     size_t minimumParallelWork) const;

private:
    ResourceGovernor(ResourceProfile profile, ResourceBudget budget);
    static ResourceBudget makeBudget(ResourceProfile profile, size_t logicalProcessors);
    static void validate(const ResourceBudget& budget);

    ResourceProfile m_profile;
    ResourceBudget m_budget;
};

} // namespace lasecsimul::resources
