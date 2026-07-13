#pragma once

#include <cstdio>
#include <vector>
#include "CircuitGroup.hpp"
#include "ThreadPool.hpp"

namespace lasecsimul::simulation {

/** Resolve grupos eletricamente independentes num pool persistente. */
class MnaSolver {
public:
    explicit MnaSolver(size_t threadCount = 0) : m_pool(threadCount) {}

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
        if (m_dirtyGroups.size() > 1 && estimatedWork >= m_parallelWorkThreshold) {
            m_pool.parallelFor(m_dirtyGroups.size(), solveGroup);
        } else {
            for (size_t i = 0; i < m_dirtyGroups.size(); ++i) solveGroup(i);
        }
    }

    size_t threadCount() const { return m_pool.threadCount(); }

private:
    ThreadPool m_pool;
    std::vector<CircuitGroup*> m_dirtyGroups;
    static constexpr size_t m_parallelWorkThreshold = 250'000;
};

} // namespace lasecsimul::simulation
