#pragma once

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <limits>
#include <mutex>
#include <queue>
#include <thread>
#include <vector>
#include "SparseSet.hpp"

namespace lasecsimul::simulation {

struct ScheduledEvent {
    uint64_t timeNs;
    uint32_t componentIndex;
    uint64_t sequence;
    std::function<void()> callback;
};

struct ScheduledEventOrder {
    bool operator()(const ScheduledEvent& a, const ScheduledEvent& b) const {
        if (a.timeNs != b.timeNs) return a.timeNs > b.timeNs;
        return a.sequence > b.sequence;
    }
};

class Scheduler {
public:
    using SettleStepFn = std::function<bool()>;
    using EventCallback = std::function<void()>;

    Scheduler(size_t componentCapacity, SettleStepFn settleStep)
        : m_dirty(componentCapacity), m_settleStep(std::move(settleStep)) {}

    ~Scheduler() { stop(); }

    void markDirty(uint32_t componentIndex) {
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            m_dirty.insert(componentIndex);
        }
        m_wake.notify_one();
    }

    void scheduleAt(uint64_t timeNs, uint32_t componentIndex);
    void scheduleAt(uint64_t timeNs, EventCallback callback);
    void scheduleEvent(uint64_t delayNs, uint32_t componentIndex);
    void scheduleEvent(uint64_t delayNs, EventCallback callback);

    bool dirty(uint32_t componentIndex) const;
    size_t dirtyCount() const;
    size_t pendingEventCount() const;
    uint64_t nowNs() const;

    // Direct access is only safe from the scheduler-owned settle callback or single-threaded tests.
    SparseSet<uint32_t>& dirtySet() { return m_dirty; }

    /** Mesmo valor de `nowNs()`, sem tomar `m_mutex` -- chamar SÓ de dentro do callback de settle
     * (que já roda com o mutex tomado pelo Scheduler, ver settleUntilStableLocked()); chamar
     * `nowNs()` de lá faria dead-lock no mesmo `std::mutex` não-reentrante. Mesma categoria de
     * `dirtySet()` acima. */
    uint64_t nowNsUnlocked() const { return m_nowNs; }

    /** Mesmo papel de `scheduleEvent(delayNs, callback)`, sem tomar `m_mutex` -- mesma categoria de
     * `nowNsUnlocked()`/`dirtySet()`: só chamar de dentro do callback de settle (stamp()/onEvent()
     * de um componente, incluindo NativeDeviceProxy -- ver hostScheduleEvent em PluginRuntime.cpp).
     * `callback` em si É invocado depois, fora dessa seção travada (ver
     * processNextEventUntilLocked: unlock -> callback() -> lock), então ele pode chamar
     * `scheduleEvent`/`markDirty` normais sem medo -- só a ENFILEIRADA aqui precisa ser unlocked. */
    void scheduleEventUnlocked(uint64_t delayNs, EventCallback callback) {
        pushEventLocked(m_nowNs + delayNs, kNoComponent, std::move(callback));
    }

    void start();
    void pause() { m_paused.store(true); }
    void resume() {
        m_paused.store(false);
        m_wake.notify_one();
    }
    void stop();
    void reset();
    void runUntil(uint64_t targetTimeNs);
    void step(uint64_t deltaNs);

    /** Duração mínima de cada ciclo de liquidação em tempo real (µs). 0 = ilimitado (default).
     * Thread-safe: lido pela thread do Scheduler, escrito pela thread de IPC. */
    void setTargetStepUs(uint64_t us) { m_targetStepUs.store(us, std::memory_order_relaxed); }
    uint64_t targetStepUs() const { return m_targetStepUs.load(std::memory_order_relaxed); }

    /** Limite de iterações não-lineares por settle cycle. 0 = ilimitado (default). */
    void setMaxNonLinearIterations(size_t n) { m_maxNonLinearIterations.store(n, std::memory_order_relaxed); }
    size_t maxNonLinearIterations() const { return m_maxNonLinearIterations.load(std::memory_order_relaxed); }

private:
    static constexpr uint32_t kNoComponent = std::numeric_limits<uint32_t>::max();

    void pushEventLocked(uint64_t timeNs, uint32_t componentIndex, EventCallback callback);
    bool processNextEventUntilLocked(std::unique_lock<std::mutex>& lock, uint64_t targetTimeNs);
    bool settleUntilStableLocked();

    SparseSet<uint32_t> m_dirty;
    std::priority_queue<ScheduledEvent, std::vector<ScheduledEvent>, ScheduledEventOrder> m_events;
    uint64_t m_nowNs = 0;
    uint64_t m_nextSequence = 0;
    SettleStepFn m_settleStep;

    std::thread m_thread;
    mutable std::mutex m_mutex;
    std::condition_variable m_wake;
    std::atomic<bool> m_running{false};
    std::atomic<bool> m_paused{false};
    std::atomic<uint64_t> m_targetStepUs{0};
    std::atomic<size_t> m_maxNonLinearIterations{0};
};

} // namespace lasecsimul::simulation
