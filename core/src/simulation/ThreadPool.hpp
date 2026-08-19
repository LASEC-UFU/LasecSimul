#pragma once

#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <exception>
#include <functional>
#include <mutex>
#include <thread>
#include <vector>

namespace lasecsimul::simulation {

/** Pool persistente que materializa workers somente quando uma concessao paralela os exige. */
class ThreadPool {
public:
    explicit ThreadPool(size_t maxWorkerThreads) : m_maxWorkerThreads(maxWorkerThreads) {}
    ThreadPool(const ThreadPool&) = delete;
    ThreadPool& operator=(const ThreadPool&) = delete;

    ~ThreadPool() {
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            m_stopping = true;
        }
        m_work.notify_all();
        for (std::thread& worker : m_workers) {
            if (worker.joinable()) worker.join();
        }
    }

    size_t workerThreadCount() const {
        return m_materializedWorkers.load(std::memory_order_acquire);
    }
    size_t threadCount() const { return workerThreadCount() + 1; }
    size_t maxThreadCount() const { return m_maxWorkerThreads + 1; }

    template <class Fn>
    void parallelFor(size_t count, size_t parallelTasks, Fn&& fn) {
        if (count == 0) return;
        const size_t participants = std::min({count, parallelTasks, m_maxWorkerThreads + 1});
        if (participants <= 1) {
            for (size_t i = 0; i < count; ++i) fn(i);
            return;
        }

        // Um mesmo pool aceita uma invocacao por vez. A thread coordenadora tambem consome indices.
        std::lock_guard<std::mutex> invocationLock(m_invocationMutex);
        ensureWorkers(participants - 1);
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            m_task = [&fn](size_t index) { fn(index); };
            m_taskCount = count;
            m_nextIndex.store(0, std::memory_order_relaxed);
            m_activeWorkers = participants - 1;
            m_workersPending = m_activeWorkers;
            m_failure = nullptr;
            ++m_generation;
        }
        m_work.notify_all();

        runPublishedTask();

        std::unique_lock<std::mutex> lock(m_mutex);
        m_done.wait(lock, [&] { return m_workersPending == 0; });
        std::exception_ptr failure = m_failure;
        m_task = {};
        lock.unlock();
        if (failure) std::rethrow_exception(failure);
    }

private:
    void ensureWorkers(size_t desired) {
        while (m_workers.size() < desired) {
            uint64_t observedGeneration;
            {
                std::lock_guard<std::mutex> lock(m_mutex);
                observedGeneration = m_generation;
            }
            const size_t index = m_workers.size();
            m_workers.emplace_back([this, index, observedGeneration] {
                workerLoop(index, observedGeneration);
            });
            m_materializedWorkers.store(m_workers.size(), std::memory_order_release);
        }
    }

    void runPublishedTask() {
        for (;;) {
            const size_t index = m_nextIndex.fetch_add(1, std::memory_order_relaxed);
            if (index >= m_taskCount) return;
            try {
                m_task(index);
            } catch (...) {
                std::lock_guard<std::mutex> lock(m_mutex);
                if (!m_failure) m_failure = std::current_exception();
            }
        }
    }

    void workerLoop(size_t workerIndex, uint64_t observedGeneration) {
        for (;;) {
            bool active = false;
            {
                std::unique_lock<std::mutex> lock(m_mutex);
                m_work.wait(lock, [&] { return m_stopping || m_generation != observedGeneration; });
                if (m_stopping) return;
                observedGeneration = m_generation;
                active = workerIndex < m_activeWorkers;
            }
            if (!active) continue;
            runPublishedTask();
            {
                std::lock_guard<std::mutex> lock(m_mutex);
                if (--m_workersPending == 0) m_done.notify_one();
            }
        }
    }

    const size_t m_maxWorkerThreads;
    std::vector<std::thread> m_workers;
    std::atomic<size_t> m_materializedWorkers{0};
    std::function<void(size_t)> m_task;
    size_t m_taskCount = 0;
    std::atomic<size_t> m_nextIndex{0};
    size_t m_workersPending = 0;
    size_t m_activeWorkers = 0;
    uint64_t m_generation = 0;
    std::exception_ptr m_failure;
    std::mutex m_invocationMutex;
    std::mutex m_mutex;
    std::condition_variable m_work;
    std::condition_variable m_done;
    bool m_stopping = false;
};

} // namespace lasecsimul::simulation
