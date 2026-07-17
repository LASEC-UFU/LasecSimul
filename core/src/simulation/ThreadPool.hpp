#pragma once
#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <cstddef>
#include <functional>
#include <exception>
#include <mutex>
#include <thread>
#include <vector>

namespace lasecsimul::simulation {
class ThreadPool {
public:
    explicit ThreadPool(size_t requested = 0) {
        const size_t detected = std::max<size_t>(1, std::thread::hardware_concurrency());
        // O modo automático segue o hardware disponível. A decisão de despachar trabalho para o
        // pool continua adaptativa no MnaSolver; manter um teto fixo aqui deixava máquinas maiores
        // artificialmente subutilizadas e contrariava a configuração sem hardcode por plataforma.
        m_concurrency = requested == 0 ? detected : std::max<size_t>(1, requested);
        // A thread que chamou parallelFor também trabalha. Criar `concurrency` workers aqui
        // acrescentava um participante e sobrecarregava o hardware em um núcleo.
        m_workers.reserve(m_concurrency - 1);
        for (size_t i = 1; i < m_concurrency; ++i) m_workers.emplace_back([this] { workerLoop(); });
    }
    ThreadPool(const ThreadPool&) = delete;
    ThreadPool& operator=(const ThreadPool&) = delete;
    ~ThreadPool() {
        { std::lock_guard<std::mutex> lock(m_mutex); m_stopping = true; }
        m_work.notify_all();
        for (std::thread& worker : m_workers) if (worker.joinable()) worker.join();
    }
    size_t threadCount() const { return m_concurrency; }

    template <class Fn> void parallelFor(size_t count, Fn&& fn) {
        if (count == 0) return;
        if (count == 1 || m_concurrency == 1) {
            for (size_t i = 0; i < count; ++i) fn(i);
            return;
        }

        // MnaSolver não invoca o mesmo pool concorrentemente; o mutex documenta e protege esse
        // contrato caso outro consumidor apareça no futuro.
        std::lock_guard<std::mutex> invocationLock(m_invocationMutex);
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            m_task = [&fn](size_t index) { fn(index); };
            m_taskCount = count;
            m_nextIndex.store(0, std::memory_order_relaxed);
            m_workersPending = m_workers.size();
            m_failure = nullptr;
            ++m_generation;
        }
        m_work.notify_all();

        // Work sharing: além de evitar um worker extra, ajuda o lote pequeno a terminar antes que
        // todos os demais workers tenham sequer acordado.
        runPublishedTask();

        std::unique_lock<std::mutex> lock(m_mutex);
        m_done.wait(lock, [&] { return m_workersPending == 0; });
        std::exception_ptr failure = m_failure;
        m_task = {};
        lock.unlock();
        if (failure) std::rethrow_exception(failure);
    }
private:
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

    void workerLoop() {
        uint64_t observedGeneration = 0;
        for (;;) {
            {
                std::unique_lock<std::mutex> lock(m_mutex);
                m_work.wait(lock, [&] { return m_stopping || m_generation != observedGeneration; });
                if (m_stopping) return;
                observedGeneration = m_generation;
            }
            runPublishedTask();
            {
                std::lock_guard<std::mutex> lock(m_mutex);
                if (--m_workersPending == 0) m_done.notify_one();
            }
        }
    }

    size_t m_concurrency = 1;
    std::vector<std::thread> m_workers;
    std::function<void(size_t)> m_task;
    size_t m_taskCount = 0;
    std::atomic<size_t> m_nextIndex{0};
    size_t m_workersPending = 0;
    uint64_t m_generation = 0;
    std::exception_ptr m_failure;
    std::mutex m_invocationMutex;
    std::mutex m_mutex;
    std::condition_variable m_work;
    std::condition_variable m_done;
    bool m_stopping = false;
};
} // namespace lasecsimul::simulation
