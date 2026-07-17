#include "Scheduler.hpp"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <utility>

namespace lasecsimul::simulation {

void Scheduler::pushEventLocked(uint64_t timeNs, uint32_t componentIndex, EventCallback callback) {
    m_events.push({timeNs, componentIndex, m_nextSequence++, std::move(callback)});
    m_pendingEventSnapshot.store(m_events.size(), std::memory_order_relaxed);
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

bool Scheduler::settleUntilStableLocked() {
    const bool profile = m_profilingEnabled.load(std::memory_order_relaxed);
    const auto profileStart = profile ? std::chrono::steady_clock::now() : std::chrono::steady_clock::time_point{};
    bool hadWork = false;
    const size_t maxIter = m_maxNonLinearIterations.load(std::memory_order_relaxed);
    size_t iter = 0;
    while (!m_dirty.empty()) {
        if (maxIter > 0 && iter >= maxIter) break;
        // SimulIDE also checks its state inside solveCircuit(), not only in the outer loop.
        if (m_stopRequested.load(std::memory_order_acquire) ||
            m_paused.load(std::memory_order_acquire)) break;
        ++iter;
        if (profile) m_settleIterations.fetch_add(1, std::memory_order_relaxed);
        hadWork = true;
        if (!m_settleStep || !m_settleStep()) break;
    }
    m_lastSettleConverged = m_dirty.empty();
    if (profile) {
        const auto elapsed = std::chrono::steady_clock::now() - profileStart;
        m_settleNanoseconds.fetch_add(
            static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(elapsed).count()),
            std::memory_order_relaxed);
    }
    return hadWork;
}

bool Scheduler::processNextEventUntilLocked(std::unique_lock<std::mutex>& lock, uint64_t targetTimeNs) {
    if (m_events.empty() || m_events.top().timeNs > targetTimeNs) return false;

    ScheduledEvent event = m_events.top();
    m_events.pop();
    m_pendingEventSnapshot.store(m_events.size(), std::memory_order_relaxed);
    if (m_profilingEnabled.load(std::memory_order_relaxed))
        m_eventsProcessed.fetch_add(1, std::memory_order_relaxed);
    m_nowNs = event.timeNs;
    m_nowSnapshotNs.store(m_nowNs, std::memory_order_release);

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
    const bool initialWork = settleUntilStableLocked();
    if (initialWork && m_lastSettleConverged && m_stableStep) m_stableStep(m_nowNs);

    while (m_nowNs < targetTimeNs) {
        if (m_stopRequested.load(std::memory_order_acquire) ||
            m_paused.load(std::memory_order_acquire)) break;
        uint64_t nextTime = targetTimeNs;
        const uint64_t maxStep = m_maximumTimeStepNs.load(std::memory_order_relaxed);
        const uint64_t selectedStep = m_adaptiveTimeStep && m_currentTimeStepNs > 0
            ? std::min(maxStep, m_currentTimeStepNs) : maxStep;
        if (selectedStep > 0 && targetTimeNs - m_nowNs > selectedStep) nextTime = m_nowNs + selectedStep;
        if (!m_events.empty() && m_events.top().timeNs < nextTime) nextTime = m_events.top().timeNs;

        const uint64_t previousTime = m_nowNs;
        const bool eventBoundary = !m_events.empty() && m_events.top().timeNs == nextTime;
        m_nowNs = nextTime;
        m_nowSnapshotNs.store(m_nowNs, std::memory_order_release);
        if (m_beginTimeStep && nextTime > previousTime) m_beginTimeStep(previousTime, nextTime);

        while (!m_events.empty() && m_events.top().timeNs <= nextTime) {
            if (m_stopRequested.load(std::memory_order_acquire) ||
                m_paused.load(std::memory_order_acquire)) break;
            processNextEventUntilLocked(lock, nextTime);
        }
        settleUntilStableLocked();
        bool accepted = true;
        if (m_commitTimeStep && nextTime > previousTime) {
            const TimeStepDecision decision = m_commitTimeStep(previousTime, nextTime, eventBoundary);
            accepted = decision.accept;
            const uint64_t attempted = nextTime - previousTime;
            if (!decision.accept && !eventBoundary && attempted > m_minimumTimeStepNs) {
                m_nowNs = previousTime;
                m_nowSnapshotNs.store(m_nowNs, std::memory_order_release);
                const double factor = std::clamp(0.9 / std::sqrt(std::max(decision.errorRatio, 1e-12)), 0.2, 0.8);
                m_currentTimeStepNs = std::max<uint64_t>(m_minimumTimeStepNs,
                    static_cast<uint64_t>(static_cast<double>(attempted) * factor));
                continue;
            }
            if (m_adaptiveTimeStep) {
                const double factor = decision.errorRatio > 1e-12
                    ? std::clamp(0.9 / std::sqrt(decision.errorRatio), 0.5, 2.0) : 2.0;
                m_currentTimeStepNs = std::clamp<uint64_t>(
                    static_cast<uint64_t>(static_cast<double>(attempted) * factor), m_minimumTimeStepNs, maxStep);
            }
        }
        if (accepted && m_lastSettleConverged && m_stableStep) m_stableStep(m_nowNs);
        if (accepted && m_profilingEnabled.load(std::memory_order_relaxed))
            m_timeSteps.fetch_add(1, std::memory_order_relaxed);
    }
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
    m_pendingEventSnapshot.store(0, std::memory_order_relaxed);
    m_nowNs = 0;
    m_nowSnapshotNs.store(0, std::memory_order_release);
    m_nextSequence = 0;
    m_paused.store(false);
}

void Scheduler::start() {
    if (m_running.exchange(true)) return;
    m_stopRequested.store(false);

    m_thread = std::thread([this] {
        // Mede a granularidade efetiva de espera do host. No Windows ela pode ser muito maior que
        // a resolução anunciada por steady_clock; dormir a cada passo de 100 us faria cada passo
        // custar ~15,6 ms. O pacing acumula avanço até esta granularidade, sem alterar o passo.
        std::chrono::steady_clock::duration pacingQuantum{1};
        bool pacingCalibrated = false;
        auto pacingWallOrigin = std::chrono::steady_clock::now();
        uint64_t pacingSimOriginNs = nowNs();

        while (m_running.load()) {
            if (m_paused.load()) {
                std::unique_lock<std::mutex> lock(m_mutex);
                m_wake.wait(lock, [this] {
                    return !m_running.load(std::memory_order_acquire) ||
                           !m_paused.load(std::memory_order_acquire);
                });
                continue;
            }

            const auto cycleStart = std::chrono::steady_clock::now();
            const uint64_t cycleSimStartNs = nowNs();
            uint64_t targetTimeNs = 0;
            {
                std::unique_lock<std::mutex> lock(m_mutex);
                const uint64_t configuredStepNs = m_maximumTimeStepNs.load(std::memory_order_relaxed);
                if (configuredStepNs == 0) {
                    if (m_events.empty() && m_dirty.empty()) {
                        m_wake.wait(lock, [this] {
                            return !m_running.load(std::memory_order_acquire) ||
                                   m_paused.load(std::memory_order_acquire) || !m_events.empty() || !m_dirty.empty();
                        });
                        continue;
                    }
                    targetTimeNs = m_events.empty() ? m_nowNs : m_events.top().timeNs;
                } else {
                    targetTimeNs = configuredStepNs > std::numeric_limits<uint64_t>::max() - m_nowNs
                        ? std::numeric_limits<uint64_t>::max() : m_nowNs + configuredStepNs;
                }
            }

            // Usa exatamente o mesmo caminho do modo síncrono: callbacks transientes, passo
            // adaptativo, eventos com timestamp, settle e aquisição de instrumentos.
            runUntil(targetTimeNs);

            const double realTimeRate = m_realTimeRate.load(std::memory_order_relaxed);
            const uint64_t cycleSimEndNs = nowNs();
            if (realTimeRate > 0.0 && cycleSimEndNs > cycleSimStartNs) {
                if (!pacingCalibrated) {
                    // Uma solicitação não nula revela a resolução real do scheduler do SO; em
                    // particular, 1 ns pode retornar imediatamente e não medir o tick do Windows.
                    const auto probeStart = std::chrono::steady_clock::now();
                    std::this_thread::sleep_for(std::chrono::milliseconds(1));
                    pacingQuantum = std::max(
                        std::chrono::steady_clock::now() - probeStart,
                        std::chrono::steady_clock::duration{1});
                    pacingCalibrated = true;
                    pacingWallOrigin = std::chrono::steady_clock::now();
                    pacingSimOriginNs = cycleSimEndNs;
                    continue;
                }
                const auto now = std::chrono::steady_clock::now();
                const long double requiredWallNs = static_cast<long double>(cycleSimEndNs - pacingSimOriginNs) / realTimeRate;
                const auto requiredElapsed = std::chrono::duration_cast<std::chrono::steady_clock::duration>(
                    std::chrono::duration<long double, std::nano>(requiredWallNs));
                const auto actualElapsed = now - pacingWallOrigin;

                if (actualElapsed > requiredElapsed + pacingQuantum) {
                    // Boot/CPU/QEMU ficou para trás: ancora no estado atual em vez de acelerar a
                    // 200% para "recuperar" tempo que o usuário não viu.
                    pacingWallOrigin = now;
                    pacingSimOriginNs = cycleSimEndNs;
                } else if (requiredElapsed > actualElapsed && requiredElapsed - actualElapsed >= pacingQuantum) {
                    const auto deadline = pacingWallOrigin + requiredElapsed;
                    const auto remaining = requiredElapsed - actualElapsed;
                    // Usa espera do SO só na parcela que excede a granularidade medida; o trecho
                    // final usa yield cooperativo. Isso evita tanto busy-wait longo quanto o
                    // oversleep de um tick inteiro que limitava 1x a aproximadamente 0,6x.
                    if (remaining >= pacingQuantum * 2) {
                        std::unique_lock<std::mutex> pacingLock(m_pacingMutex);
                        m_pacingWake.wait_until(pacingLock, deadline - pacingQuantum, [this] {
                            return !m_running.load(std::memory_order_acquire) ||
                                   m_paused.load(std::memory_order_acquire);
                        });
                    }
                    while (m_running.load(std::memory_order_acquire) &&
                           !m_paused.load(std::memory_order_acquire) &&
                           std::chrono::steady_clock::now() < deadline) {
                        std::this_thread::yield();
                    }
                }
            } else if (realTimeRate <= 0.0) {
                pacingWallOrigin = std::chrono::steady_clock::now();
                pacingSimOriginNs = cycleSimEndNs;
            }
            const auto legacyDelay = std::chrono::duration_cast<std::chrono::steady_clock::duration>(
                std::chrono::microseconds(m_targetStepUs.load(std::memory_order_relaxed)));
            if (legacyDelay > std::chrono::steady_clock::duration::zero()) {
                std::unique_lock<std::mutex> pacingLock(m_pacingMutex);
                m_pacingWake.wait_until(pacingLock, cycleStart + legacyDelay, [this] {
                    return !m_running.load(std::memory_order_acquire) ||
                           m_paused.load(std::memory_order_acquire);
                });
            }
        }
    });
}

void Scheduler::stop() {
    m_stopRequested.store(true);
    m_running.store(false);
    m_wake.notify_all();
    m_pacingWake.notify_all();
    if (m_thread.joinable() && m_thread.get_id() != std::this_thread::get_id()) m_thread.join();
    // A worker thread já terminou (join acima) -- rearma pra não quebrar chamadores SÍNCRONOS de
    // step()/runUntil() feitos depois deste stop() e antes do próximo start() (ex.: `setPauseCondition`
    // resolvendo topologia via `step(0)` enquanto a simulação está parada, ver comentário em Scheduler.hpp).
    m_stopRequested.store(false);
}

} // namespace lasecsimul::simulation
