#pragma once

#include <cstdio>
#include <utility>
#include <vector>
#include "../resources/ResourceGovernor.hpp"
#include "CircuitGroup.hpp"
#include "ThreadPool.hpp"

namespace lasecsimul::simulation {

/** Resolve grupos eletricamente independentes num pool persistente. */
class MnaSolver {
public:
    explicit MnaSolver(size_t threadCount = 0)
        : MnaSolver(governorForThreadCount(threadCount)) {}

    explicit MnaSolver(resources::ResourceGovernor governor)
        : m_governor(std::move(governor)), m_pool(m_governor.budget().maxWorkerThreads) {}

    void solve(std::vector<CircuitGroup>& groups, std::vector<double>& nodeVoltages) {
        m_dirtyGroups.clear();
        if (m_dirtyGroups.capacity() < groups.size()) m_dirtyGroups.reserve(groups.size());
        for (CircuitGroup& group : groups) if (group.dirty()) m_dirtyGroups.push_back(&group);

        size_t estimatedWork = 0;
        for (const CircuitGroup* group : m_dirtyGroups) {
            const size_t n = group->totalSize();
            estimatedWork += group->admittanceChanged() ? n * n * n : n * n;
        }
        auto solveGroup = [&](size_t taskIndex) {
            CircuitGroup& group = *m_dirtyGroups[taskIndex];
            if (group.admittanceChanged()) group.factor();
            const Eigen::VectorXd& voltages = group.solve();
            const std::vector<uint32_t>& indices = group.nodeIndices();
            const bool singular = group.singular() || !voltages.allFinite();
            for (size_t i = 0; i < indices.size(); ++i) {
                nodeVoltages[indices[i]] = singular ? 0.0 : voltages[static_cast<Eigen::Index>(i)];
            }
            if (singular) {
                std::fprintf(stderr, "[MnaSolver] grupo com %zu no(s) deu sistema singular; tensao definida como 0V\n",
                             indices.size());
            }
        };
        // Thread dispatch custa mais que uma substituicao LU pequena. Paraleliza somente quando
        // ha trabalho suficiente para amortizar fila/sincronizacao.
        const resources::ParallelGrant grant = m_governor.grantParallelTasks(
            m_dirtyGroups.size(), estimatedWork, m_parallelWorkThreshold);
        if (grant.usesWorkers()) {
            m_pool.parallelFor(m_dirtyGroups.size(), grant.parallelTasks, solveGroup);
        } else {
            for (size_t i = 0; i < m_dirtyGroups.size(); ++i) solveGroup(i);
        }
    }

    size_t threadCount() const { return m_pool.threadCount(); }
    size_t workerThreadCount() const { return m_pool.workerThreadCount(); }
    const resources::ResourceBudget& resourceBudget() const { return m_governor.budget(); }

private:
    static resources::ResourceGovernor governorForThreadCount(size_t threadCount) {
        if (threadCount == 0) return resources::ResourceGovernor{};
        resources::ResourceBudget budget =
            resources::ResourceGovernor::forProfile(resources::ResourceProfile::Desktop,
                                                     threadCount + 1).budget();
        budget.maxWorkerThreads = threadCount - 1;
        budget.maxParallelTasks = threadCount;
        return resources::ResourceGovernor(budget);
    }

    resources::ResourceGovernor m_governor;
    ThreadPool m_pool;
    std::vector<CircuitGroup*> m_dirtyGroups;
    static constexpr size_t m_parallelWorkThreshold = 250'000;
};

} // namespace lasecsimul::simulation
