#pragma once

#include <atomic>
#include <condition_variable>
#include <cmath>
#include <cstdint>
#include <functional>
#include <limits>
#include <mutex>
#include <optional>
#include <queue>
#include <stdexcept>
#include <thread>
#include <type_traits>
#include <utility>
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
    struct MetricsSnapshot {
        bool enabled = false;
        uint64_t eventsProcessed = 0;
        uint64_t timeSteps = 0;
        uint64_t settleIterations = 0;
        uint64_t settleNanoseconds = 0;
        uint64_t pendingEvents = 0;
    };
    struct TimeStepDecision { bool accept = true; double errorRatio = 0.0; };
    using SettleStepFn = std::function<bool()>;
    using EventCallback = std::function<void()>;
    using TimeStepBeginFn = std::function<void(uint64_t, uint64_t)>;
    using TimeStepCommitFn = std::function<TimeStepDecision(uint64_t, uint64_t, bool)>;
    using StableStepFn = std::function<void(uint64_t)>;
    /** Redesign de concorrência 2026-07-19 (ver .claude/plans/idempotent-floating-cat.md) -- chamado
     * pela thread do Scheduler em TRÊS pontos seguros: dentro de `settleUntilStableLocked()` (antes
     * do laço e a cada iteração dele, cobrindo tanto "settle rápido" quanto "settle que nunca
     * converge", mesmo raciocínio já usado pelo check de `m_stopRequested` logo abaixo) e no início
     * do ramo pausado de `start()` (uma simulação pausada continua com a worker viva, só parada de
     * avançar tempo -- sem drenar ali, editar uma propriedade com a simulação pausada travaria pra
     * sempre esperando uma iteração de settle que não vai acontecer). Nunca chamado pela thread de
     * IPC. Drena a fila de comandos externa (`SimulationSession::CommandQueue`) e aplica cada um.
     * `Scheduler` não sabe o que é um "comando" nem depende de `SimulationSession` -- só chama o
     * callback, mantendo a mesma separação de responsabilidades de `SettleStepFn`/`StableStepFn`.
     * IMPORTANTE: nada disto ajuda quando a worker não existe (antes do primeiro `start()`, ou
     * depois de `stop()`) -- nesse caso `SimulationSession::enqueueCommand` detecta `!isRunning()` e
     * aplica o comando direto na thread de IPC (seguro: sem worker, não há com quem competir). */
    using CommandDrainFn = std::function<void()>;
    /** Predicado companheiro de `CommandDrainFn` -- usado SÓ pra decidir se a worker deve continuar
     * ociosa/pausada ou acordar (ver `m_wake.wait(lock, predicate)` em `start()`). Sem isto, um
     * comando chegando enquanto a worker está parked (ociosa ou pausada) ficaria esperando o próximo
     * evento/dirty "de verdade" pra ser notado, o que pode nunca acontecer numa simulação pausada. */
    using CommandPendingFn = std::function<bool()>;

    Scheduler(size_t componentCapacity, SettleStepFn settleStep)
        : m_dirty(componentCapacity), m_settleStep(std::move(settleStep)) {}

    void setTimeStepCallbacks(TimeStepBeginFn begin, TimeStepCommitFn commit) {
        m_beginTimeStep = std::move(begin);
        m_commitTimeStep = std::move(commit);
    }
    void setStableStepCallback(StableStepFn callback) { m_stableStep = std::move(callback); }
    void setCommandDrainCallback(CommandDrainFn callback) { m_commandDrain = std::move(callback); }
    void setCommandPendingCallback(CommandPendingFn callback) { m_commandPending = std::move(callback); }
    /** Acorda a worker se ela estiver parked (ociosa ou pausada) -- chamada pela thread de IPC depois
     * de empurrar um comando na fila (`SimulationSession::enqueueCommand`). Notificar sem segurar
     * `m_mutex` é seguro aqui porque quem espera usa `wait(lock, predicate)`: mesmo que o notify
     * chegue antes da worker (re)entrar em `wait`, o predicado é reavaliado no início e já vai
     * enxergar o comando pendente (`CommandPendingFn` consulta a fila com o mutex dela própria, não
     * o do Scheduler) -- não depende de ordering entre os dois mutexes. */
    void notifyCommandPending() { m_wake.notify_one(); }
    void setMaximumTimeStepNs(uint64_t ns) { m_maximumTimeStepNs.store(ns, std::memory_order_relaxed); }
    uint64_t maximumTimeStepNs() const { return m_maximumTimeStepNs.load(std::memory_order_relaxed); }
    void configureAdaptiveTimeStep(uint64_t initialNs, uint64_t minimumNs, bool adaptive) {
        m_currentTimeStepNs = initialNs;
        m_minimumTimeStepNs = minimumNs;
        m_adaptiveTimeStep = adaptive;
    }

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
    void setProfilingEnabled(bool enabled) { m_profilingEnabled.store(enabled, std::memory_order_relaxed); }
    void resetMetrics() {
        m_eventsProcessed.store(0, std::memory_order_relaxed);
        m_timeSteps.store(0, std::memory_order_relaxed);
        m_settleIterations.store(0, std::memory_order_relaxed);
        m_settleNanoseconds.store(0, std::memory_order_relaxed);
    }
    MetricsSnapshot metrics() const {
        return {m_profilingEnabled.load(std::memory_order_relaxed),
                m_eventsProcessed.load(std::memory_order_relaxed),
                m_timeSteps.load(std::memory_order_relaxed),
                m_settleIterations.load(std::memory_order_relaxed),
                m_settleNanoseconds.load(std::memory_order_relaxed),
                m_pendingEventSnapshot.load(std::memory_order_relaxed)};
    }
    /** Snapshot lock-free: telemetry must never queue ahead of a stop IPC request. */
    uint64_t nowNs() const { return m_nowSnapshotNs.load(std::memory_order_acquire); }
    template <class Fn> decltype(auto) synchronized(Fn&& fn) const {
        std::lock_guard<std::mutex> lock(m_mutex);
        return std::forward<Fn>(fn)();
    }
    template <class Fn>
    auto trySynchronized(Fn&& fn) const -> std::optional<std::invoke_result_t<Fn>> {
        std::unique_lock<std::mutex> lock(m_mutex, std::try_to_lock);
        if (!lock.owns_lock()) return std::nullopt;
        std::optional<std::invoke_result_t<Fn>> result;
        result.emplace(std::invoke(std::forward<Fn>(fn)));
        return result;
    }

    // Direct access is only safe from the scheduler-owned settle callback or single-threaded tests.
    SparseSet<uint32_t>& dirtySet() { return m_dirty; }

    /** Mesmo valor de `nowNs()`, sem tomar `m_mutex` -- chamar SÓ de dentro do callback de settle
     * (que já roda com o mutex tomado pelo Scheduler, ver settleUntilStableLocked()); chamar
     * `nowNs()` de lá faria dead-lock no mesmo `std::mutex` não-reentrante. Mesma categoria de
     * `dirtySet()` acima. */
    uint64_t nowNsUnlocked() const { return m_nowNs; }
    bool lastSettleConvergedUnlocked() const { return m_lastSettleConverged; }

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
    void pause() {
        m_paused.store(true, std::memory_order_release);
        m_wake.notify_all();
        m_pacingWake.notify_all();
    }
    void resume() {
        m_paused.store(false);
        m_wake.notify_one();
    }
    void stop();
    /** Leitura pura -- usada por `Probe::pauseOnChange` em teste (confirma que `pause()` chamado de
     * dentro do próprio `stamp()` realmente registra) e por qualquer chamador externo que precise
     * saber o estado sem se inscrever em notificação nenhuma. */
    bool isPaused() const { return m_paused.load(); }
    bool isRunning() const { return m_running.load(std::memory_order_acquire); }
    void reset();
    void runUntil(uint64_t targetTimeNs);
    void step(uint64_t deltaNs);

    /** Duração mínima de cada ciclo de liquidação em tempo real (µs). 0 = ilimitado (default).
     * Thread-safe: lido pela thread do Scheduler, escrito pela thread de IPC. */
    void setTargetStepUs(uint64_t us) { m_targetStepUs.store(us, std::memory_order_relaxed); }
    uint64_t targetStepUs() const { return m_targetStepUs.load(std::memory_order_relaxed); }

    /** Limite de avanço virtual por tempo de parede. 1 = tempo real; 0 = ilimitado. A espera é
     * derivada do avanço realmente realizado em cada ciclo, portanto funciona com passo adaptativo
     * e não depende de frequência, quantidade de eventos ou um delay fixo. */
    void setRealTimeRate(double rate) {
        if (!std::isfinite(rate) || rate < 0.0) throw std::invalid_argument("realTimeRate invalido");
        m_realTimeRate.store(rate, std::memory_order_relaxed);
    }
    double realTimeRate() const { return m_realTimeRate.load(std::memory_order_relaxed); }

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
    std::atomic<uint64_t> m_nowSnapshotNs{0};
    uint64_t m_nextSequence = 0;
    SettleStepFn m_settleStep;
    TimeStepBeginFn m_beginTimeStep;
    TimeStepCommitFn m_commitTimeStep;
    StableStepFn m_stableStep;
    CommandDrainFn m_commandDrain;
    CommandPendingFn m_commandPending;

    std::thread m_thread;
    mutable std::mutex m_mutex;
    std::condition_variable m_wake;
    std::mutex m_pacingMutex;
    std::condition_variable m_pacingWake;
    std::atomic<bool> m_running{false};
    std::atomic<bool> m_paused{false};
    /** Setada por `stop()` ANTES de `m_thread.join()`, checada dentro de `settleUntilStableLocked()`
     * -- sem isso, um circuito que nunca converge/estabiliza (oscilação sustentada entre dois
     * estados, ex.: realimentação positiva sem atraso de propagação suficiente) prende a thread do
     * Scheduler para sempre dentro do `while (!m_dirty.empty())` daquela função: `m_running` só é
     * checado no topo do laço externo de `start()` (nunca visitado de novo enquanto preso ali dentro),
     * então `stop()` bloqueia pra sempre em `join()` -- o botão "Parar" da UI nunca responde, e (como
     * `settleUntilStableLocked` roda com `m_mutex` travado) nenhuma outra requisição IPC que precise
     * do mutex (ex.: `getSimulationTime`) responde também, travando o pipe inteiro (bug relatado
     * 2026-07-17: "Run" preso em progresso baixo + "Parar" sem resposta). True só enquanto uma
     * chamada a `stop()` está ativamente esperando a worker thread terminar (`start()` zera ao
     * começar, `stop()` rearma pra `false` depois que `join()` retorna) -- chamadores síncronos de
     * `runUntil()`/`step()` fora desse instante (ex.: `setPauseCondition` resolvendo topologia via
     * `step(0)` enquanto a simulação está parada) nunca veem esta flag true, então o comportamento
     * deles não muda. */
    std::atomic<bool> m_stopRequested{false};
    std::atomic<uint64_t> m_targetStepUs{0};
    std::atomic<double> m_realTimeRate{0.0};
    std::atomic<size_t> m_maxNonLinearIterations{0};
    std::atomic<uint64_t> m_maximumTimeStepNs{0};
    std::atomic<bool> m_profilingEnabled{false};
    std::atomic<uint64_t> m_eventsProcessed{0};
    std::atomic<uint64_t> m_timeSteps{0};
    std::atomic<uint64_t> m_settleIterations{0};
    std::atomic<uint64_t> m_settleNanoseconds{0};
    std::atomic<uint64_t> m_pendingEventSnapshot{0};
    uint64_t m_currentTimeStepNs = 0;
    uint64_t m_minimumTimeStepNs = 1;
    bool m_adaptiveTimeStep = false;
    bool m_lastSettleConverged = true;
};

} // namespace lasecsimul::simulation
