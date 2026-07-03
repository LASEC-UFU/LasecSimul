#include "Scheduler.hpp"
#include <chrono>
#include <utility>

namespace lasecsimul::simulation {

void Scheduler::pushEventLocked(uint64_t timeNs, uint32_t componentIndex, EventCallback callback) {
    m_events.push({timeNs, componentIndex, m_nextSequence++, std::move(callback)});
}

void Scheduler::scheduleAt(uint64_t timeNs, uint32_t componentIndex) {
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        pushEventLocked(timeNs, componentIndex, {});
    }
    m_wake.notify_one();
}

void Scheduler::scheduleAt(uint64_t timeNs, EventCallback callback) {
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        pushEventLocked(timeNs, kNoComponent, std::move(callback));
    }
    m_wake.notify_one();
}

void Scheduler::scheduleEvent(uint64_t delayNs, uint32_t componentIndex) {
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        pushEventLocked(m_nowNs + delayNs, componentIndex, {});
    }
    m_wake.notify_one();
}

void Scheduler::scheduleEvent(uint64_t delayNs, EventCallback callback) {
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        pushEventLocked(m_nowNs + delayNs, kNoComponent, std::move(callback));
    }
    m_wake.notify_one();
}

size_t Scheduler::pendingEventCount() const {
    std::lock_guard<std::mutex> lock(m_mutex);
    return m_events.size();
}

bool Scheduler::dirty(uint32_t componentIndex) const {
    std::lock_guard<std::mutex> lock(m_mutex);
    return m_dirty.contains(componentIndex);
}

size_t Scheduler::dirtyCount() const {
    std::lock_guard<std::mutex> lock(m_mutex);
    return m_dirty.size();
}

uint64_t Scheduler::nowNs() const {
    std::lock_guard<std::mutex> lock(m_mutex);
    return m_nowNs;
}

bool Scheduler::settleUntilStableLocked() {
    bool hadWork = false;
    const size_t maxIter = m_maxNonLinearIterations.load(std::memory_order_relaxed);
    size_t iter = 0;
    while (!m_dirty.empty()) {
        if (maxIter > 0 && iter >= maxIter) break;
        ++iter;
        hadWork = true;
        if (!m_settleStep || !m_settleStep()) break;
    }
    return hadWork;
}

bool Scheduler::processNextEventUntilLocked(std::unique_lock<std::mutex>& lock, uint64_t targetTimeNs) {
    if (m_events.empty() || m_events.top().timeNs > targetTimeNs) return false;

    ScheduledEvent event = m_events.top();
    m_events.pop();
    m_nowNs = event.timeNs;

    if (event.componentIndex != kNoComponent) m_dirty.insert(event.componentIndex);

    if (event.callback) {
        EventCallback callback = std::move(event.callback);
        lock.unlock();
        callback();
        lock.lock();
    }

    return true;
}

void Scheduler::runUntil(uint64_t targetTimeNs) {
    std::unique_lock<std::mutex> lock(m_mutex);

    while (m_running.load() || !m_thread.joinable()) {
        settleUntilStableLocked();
        if (!processNextEventUntilLocked(lock, targetTimeNs)) break;
    }

    settleUntilStableLocked();
    if (m_nowNs < targetTimeNs) m_nowNs = targetTimeNs;
}

void Scheduler::step(uint64_t deltaNs) {
    uint64_t targetTimeNs = 0;
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        targetTimeNs = m_nowNs + deltaNs;
    }
    runUntil(targetTimeNs);
}

void Scheduler::reset() {
    stop();

    std::lock_guard<std::mutex> lock(m_mutex);
    m_dirty.clear();
    m_events = {};
    m_nowNs = 0;
    m_nextSequence = 0;
    m_paused.store(false);
}

void Scheduler::start() {
    if (m_running.exchange(true)) return;

    m_thread = std::thread([this] {
        while (m_running.load()) {
            if (m_paused.load()) {
                std::unique_lock<std::mutex> lock(m_mutex);
                m_wake.wait_for(lock, std::chrono::milliseconds(50));
                continue;
            }

            bool processedEvent = false;
            {
                std::unique_lock<std::mutex> lock(m_mutex);
                settleUntilStableLocked();

                if (!m_events.empty()) {
                    const uint64_t nextTimeNs = m_events.top().timeNs;
                    processNextEventUntilLocked(lock, nextTimeNs);
                    processedEvent = true;
                }

                if (!processedEvent && m_dirty.empty())
                    m_wake.wait_for(lock, std::chrono::milliseconds(10));
            }

            if (processedEvent) {
                const uint64_t stepUs = m_targetStepUs.load(std::memory_order_relaxed);
                if (stepUs > 0) std::this_thread::sleep_for(std::chrono::microseconds(stepUs));
            }
        }
    });
}

void Scheduler::stop() {
    m_running.store(false);
    m_wake.notify_all();
    if (m_thread.joinable() && m_thread.get_id() != std::this_thread::get_id()) m_thread.join();
}

} // namespace lasecsimul::simulation
