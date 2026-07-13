#pragma once
#include <algorithm>
#include <condition_variable>
#include <cstddef>
#include <functional>
#include <exception>
#include <mutex>
#include <queue>
#include <thread>
#include <vector>

namespace lasecsimul::simulation {
class ThreadPool {
public:
    explicit ThreadPool(size_t requested = 0) {
        const size_t detected = std::max<size_t>(1, std::thread::hardware_concurrency());
        // Mais threads que nucleos fisicos raramente ajudam Eigen e ampliam stack/contencao.
        const size_t automatic = std::min<size_t>(detected, 16);
        const size_t count = requested == 0 ? automatic : std::max<size_t>(1, requested);
        m_workers.reserve(count);
        for (size_t i = 0; i < count; ++i) m_workers.emplace_back([this] { workerLoop(); });
    }
    ThreadPool(const ThreadPool&) = delete;
    ThreadPool& operator=(const ThreadPool&) = delete;
    ~ThreadPool() {
        { std::lock_guard<std::mutex> lock(m_mutex); m_stopping = true; }
        m_work.notify_all();
        for (std::thread& worker : m_workers) if (worker.joinable()) worker.join();
    }
    size_t threadCount() const { return m_workers.size(); }

    template <class Fn> void parallelFor(size_t count, Fn&& fn) {
        if (count == 0) return;
        if (count == 1 || m_workers.size() == 1) {
            for (size_t i = 0; i < count; ++i) fn(i);
            return;
        }
        std::mutex doneMutex;
        std::condition_variable done;
        size_t remaining = count;
        std::exception_ptr failure;
        for (size_t i = 0; i < count; ++i) enqueue([&, i] {
            try { fn(i); }
            catch (...) {
                std::lock_guard<std::mutex> lock(doneMutex);
                if (!failure) failure = std::current_exception();
            }
            {
                std::lock_guard<std::mutex> lock(doneMutex);
                --remaining;
                // Notifica ainda sob o mutex: quem espera so pode destruir estes objetos depois
                // que esta task liberar o lock e nao voltar a toca-los.
                done.notify_one();
            }
        });
        std::unique_lock<std::mutex> lock(doneMutex);
        done.wait(lock, [&] { return remaining == 0; });
        if (failure) std::rethrow_exception(failure);
    }
private:
    void enqueue(std::function<void()> task) {
        { std::lock_guard<std::mutex> lock(m_mutex); m_tasks.push(std::move(task)); }
        m_work.notify_one();
    }
    void workerLoop() {
        for (;;) {
            std::function<void()> task;
            {
                std::unique_lock<std::mutex> lock(m_mutex);
                m_work.wait(lock, [&] { return m_stopping || !m_tasks.empty(); });
                if (m_stopping && m_tasks.empty()) return;
                task = std::move(m_tasks.front()); m_tasks.pop();
            }
            task();
        }
    }
    std::vector<std::thread> m_workers;
    std::queue<std::function<void()>> m_tasks;
    std::mutex m_mutex;
    std::condition_variable m_work;
    bool m_stopping = false;
};
} // namespace lasecsimul::simulation
