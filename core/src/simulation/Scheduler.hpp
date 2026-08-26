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
        /** Duração da MAIOR chamada individual de settleUntilStableLocked(), não a soma acumulada
         * (settleNanoseconds acima). Adicionado 2026-07-27 (.spec 32.5.18) -- diagnosticar se uma
         * ÚNICA chamada de settle segurando m_mutex por muito tempo (circuito lento pra convergir)
         * é a causa dos saltos de ~0,7-1,1s de tempo virtual observados do lado QEMU logo antes do
         * watchdog do TIMER_GROUP1 expirar genuinamente. */
        uint64_t maxSettleNanoseconds = 0;
        /** m_nowNs (tempo virtual do Scheduler) no INÍCIO da chamada de settle que produziu
         * maxSettleNanoseconds acima. Adicionado 2026-07-27 (.spec 32.5.19) -- correlacionar esse
         * settle mais lento com saltos de tempo virtual/waits do lado QEMU exige saber ONDE na
         * timeline ele ocorreu, não só quanto durou. */
        uint64_t maxSettleAtNowNs = 0;
        /** Ver m_advanceLimitWaitCount/m_advanceLimitWaitNanoseconds. */
        uint64_t advanceLimitWaitCount = 0;
        uint64_t advanceLimitWaitNanoseconds = 0;
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
    /** Retorna a posição de referência (ns, na timeline deste Scheduler) do participante mais
     * lento a acompanhar -- `nullopt` = "sem referência agora" (ninguém a acompanhar). Mesma
     * categoria de hook que CommandDrainFn/CommandPendingFn: o Scheduler não sabe o que preenche
     * este valor (um MCU mais lento, ou qualquer outro participante futuro), só usa como TETO
     * ABSOLUTO sobre até onde `m_nowNs` pode avançar nesta iteração -- a folga permitida acima
     * dessa posição é calculada aqui dentro (ver `m_pacingQuantumNs`/uso em `start()`), não somada
     * por quem preenche o hook. Chamada pela própria thread do Scheduler, uma vez por ciclo,
     * incondicionalmente (mesmo com `realTimeRate()==0`/ilimitado -- isto é uma garantia de
     * corretude, não um modo de pacing). Achado 2026-07-23: o solver elétrico tem um "tique"
     * próprio via `setMaximumTimeStepNs()`, independente de qualquer MCU -- por isso ele corre à
     * frente de um MCU emulado mais lento (QEMU/-icount gargalado pela vazão real de instruções do
     * host) em vez de esperar por ele. Substituiu um design anterior (`PacingRateLimitFn`, um
     * multiplicador de taxa alimentado por uma razão suavizada por EMA) que falhou em teste ao vivo
     * duas vezes: a própria medição de taxa interferia na cadência de amostragem (desacelerar fazia
     * o laço dormir mais, amostrando com menos frequência e mais ruído, subestimando a taxa real do
     * MCU -- um ciclo de realimentação estrutural). Um teto de POSIÇÃO absoluta não tem esse
     * problema: é uma comparação direta entre dois valores, sem janela nem suavização nenhuma. */
    using AdvanceLimitFn = std::function<std::optional<uint64_t>()>;
    using BeforeExecutionFn = std::function<void()>;

    Scheduler(size_t componentCapacity, SettleStepFn settleStep)
        : m_dirty(componentCapacity), m_pendingDirty(componentCapacity),
          m_settleStep(std::move(settleStep)) {}

    void setTimeStepCallbacks(TimeStepBeginFn begin, TimeStepCommitFn commit) {
        m_beginTimeStep = std::move(begin);
        m_commitTimeStep = std::move(commit);
    }
    void setStableStepCallback(StableStepFn callback) { m_stableStep = std::move(callback); }
    void setCommandDrainCallback(CommandDrainFn callback) { m_commandDrain = std::move(callback); }
    void setCommandPendingCallback(CommandPendingFn callback) { m_commandPending = std::move(callback); }
    void setAdvanceLimitCallback(AdvanceLimitFn callback) { m_advanceLimit = std::move(callback); }
    void setBeforeExecutionCallback(BeforeExecutionFn callback) { m_beforeExecution = std::move(callback); }
    /** Acorda a worker se ela estiver parked (ociosa ou pausada) depois que a thread de IPC publica
     * um comando. Usa um contador atômico, não condition_variable: `atomic::wait(valor)` verifica o
     * valor como parte do próprio protocolo de espera, portanto um notify ocorrido entre a última
     * inspeção da fila e o bloqueio de baixo nível não pode ser perdido (ver .spec 32.5.22). */
    void notifyCommandPending() { signalWorkAvailable(); }
    /** Acorda a worker se ela estiver esperando o `AdvanceLimitFn` avançar (ver ramo "sem espaço pra
     * avançar" em `start()`) -- chamada por quem preenche o hook assim que a posição de referência
     * realmente muda (ex.: `McuComponent::pollStepLocked()`, logo após avançar
     * `m_latestVirtualTimePs`).
     *
     * Bug real corrigido (achado por instrumentação, sessão de investigação de desempenho I2C):
     * antes desta correção o predicado de `wait_for()` em `start()` só checava `!m_running`/
     * `m_paused` -- nenhuma condição relacionada a "a posição de referência avançou" -- então este
     * `notify_all()` acordava a thread, o predicado reavaliava falso (ainda rodando, não pausado) e
     * ela voltava a dormir até o timeout de 5ms INTEIRO se esgotar, sempre, não só numa corrida rara.
     * Sob I2C bit-banged a 400kHz (milhares de avanços pequenos de posição por frame), isso custava
     * 5ms REAIS por avanço -- centenas de vezes por frame, segundos por frame. `m_advanceLimitGeneration`
     * é o mesmo padrão de contador que `m_workGeneration`/`signalWorkAvailable()` já usa (documentado
     * ali como necessário justamente pra eliminar essa classe de wakeup perdido): incrementado aqui,
     * conferido pelo predicado -- agora um notify de verdade acorda a espera quase imediatamente, e o
     * timeout de 5ms volta a ser só uma rede de segurança, não o caminho comum. */
    void notifyAdvanceLimitChanged() {
        m_advanceLimitGeneration.fetch_add(1, std::memory_order_release);
        m_pacingWake.notify_all();
    }
    void setMaximumTimeStepNs(uint64_t ns) { m_maximumTimeStepNs.store(ns, std::memory_order_relaxed); }
    uint64_t maximumTimeStepNs() const { return m_maximumTimeStepNs.load(std::memory_order_relaxed); }
    void configureAdaptiveTimeStep(uint64_t initialNs, uint64_t minimumNs, bool adaptive) {
        m_currentTimeStepNs = initialNs;
        m_minimumTimeStepNs = minimumNs;
        m_adaptiveTimeStep = adaptive;
    }

    ~Scheduler() { stop(); }

    void markDirty(uint32_t componentIndex) {
        // Caminho comum: publica direto sob o mutex do Scheduler, preservando a mesma sincronização
        // do condition_variable que sempre existiu. Se uma iteração elétrica longa já monopoliza
        // esse mutex, não bloqueia a thread produtora (em especial o poll da arena QEMU): desvia a
        // marcação para m_pendingDirty, cujo mutex só protege uma inserção O(1). Como try_lock()
        // só falha enquanto outra thread segura m_mutex, a worker não pode estar dormindo na janela
        // vulnerável a notify perdido; antes de qualquer espera ela incorpora a fila pendente.
        std::unique_lock<std::mutex> schedulerLock(m_mutex, std::try_to_lock);
        if (schedulerLock.owns_lock()) {
            m_dirty.insert(componentIndex);
        } else {
            std::lock_guard<std::mutex> pendingLock(m_pendingDirtyMutex);
            m_pendingDirty.insert(componentIndex);
        }
        signalWorkAvailable();
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
        m_maxSettleNanoseconds.store(0, std::memory_order_relaxed);
        m_maxSettleAtNowNs.store(0, std::memory_order_relaxed);
        m_advanceLimitWaitCount.store(0, std::memory_order_relaxed);
        m_advanceLimitWaitNanoseconds.store(0, std::memory_order_relaxed);
    }
    MetricsSnapshot metrics() const {
        return {m_profilingEnabled.load(std::memory_order_relaxed),
                m_eventsProcessed.load(std::memory_order_relaxed),
                m_timeSteps.load(std::memory_order_relaxed),
                m_settleIterations.load(std::memory_order_relaxed),
                m_settleNanoseconds.load(std::memory_order_relaxed),
                m_pendingEventSnapshot.load(std::memory_order_relaxed),
                m_maxSettleNanoseconds.load(std::memory_order_relaxed),
                m_maxSettleAtNowNs.load(std::memory_order_relaxed),
                m_advanceLimitWaitCount.load(std::memory_order_relaxed),
                m_advanceLimitWaitNanoseconds.load(std::memory_order_relaxed)};
    }
    /** Snapshot lock-free: telemetry must never queue ahead of a stop IPC request. */
    uint64_t nowNs() const { return m_nowSnapshotNs.load(std::memory_order_acquire); }
    /** Incrementada somente quando reset() descarta a fila inteira de callbacks. */
    uint64_t resetGeneration() const { return m_resetGeneration.load(std::memory_order_acquire); }
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
    /** Pause/resume continuam lock-free para poder interromper um settle não convergente sem esperar
     * pelo mutex que esse mesmo settle segura. signalWorkAvailable() elimina a antiga janela de
     * wakeup perdido sem reintroduzir o deadlock (ver .spec 32.5.22). */
    void pause() {
        m_paused.store(true, std::memory_order_release);
        signalWorkAvailable();
        m_pacingWake.notify_all();
    }
    void resume() {
        m_paused.store(false, std::memory_order_release);
        signalWorkAvailable();
    }
    void stop();
    /** Leitura pura -- usada por `Probe::pauseOnChange` em teste (confirma que `pause()` chamado de
     * dentro do próprio `stamp()` realmente registra) e por qualquer chamador externo que precise
     * saber o estado sem se inscrever em notificação nenhuma. */
    bool isPaused() const { return m_paused.load(); }
    bool isRunning() const { return m_running.load(std::memory_order_acquire); }
    /** `true` quando chamado de dentro da própria thread do Scheduler (ex.: de dentro de
     * `onPollEvent()` do MCU, que roda como callback síncrono de `scheduleAt`). Usado por
     * `SimulationSession::enqueueCommand` pra aplicar o comando direto em vez de empurrar na fila e
     * bloquear em `future.get()` esperando a própria thread que está executando isto agora --
     * bug real de desempenho encontrado 2026-07-19 perfilando o Core ao vivo: `runViaCommandQueue`
     * aloca uma `std::promise` por chamada e sempre passa pela fila, mesmo quando quem chamou já é a
     * única thread que a drena, sem nenhum outro consumidor concorrente possível nesse caso. Só
     * setada no início da lambda de `start()`, antes de qualquer outro trabalho -- lida sem lock
     * porque `std::thread::id` é trivialmente copiável e só é escrita uma vez antes de `m_running`
     * virar visível para outras threads. */
    bool isCurrentThreadWorker() const {
        return std::this_thread::get_id() == m_workerThreadId.load(std::memory_order_acquire);
    }
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
    /** Granularidade de espera do host, calibrada uma vez por `start()` (mesma sonda `sleep_for(1ms)`
     * que já mede isto pra pacing de `realTimeRate`) -- só telemetria/teste determinístico. Usada
     * internamente pra derivar a folga permitida acima da posição de `AdvanceLimitFn` (ver seu
     * doc-comment): hosts com granularidade pequena ficam com folga pequena, hosts mais ruidosos
     * recebem mais margem, sempre dentro de `[kMinAdvanceLeadNs, kMaxAdvanceLeadNs]`. Fica em `1`
     * (nanosegundo) até a primeira calibração completar. */
    uint64_t pacingQuantumNs() const { return m_pacingQuantumNs.load(std::memory_order_relaxed); }

    /** Limite de iterações não-lineares por settle cycle. 0 = ilimitado (default). */
    void setMaxNonLinearIterations(size_t n) { m_maxNonLinearIterations.store(n, std::memory_order_relaxed); }
    size_t maxNonLinearIterations() const { return m_maxNonLinearIterations.load(std::memory_order_relaxed); }

private:
    static constexpr uint32_t kNoComponent = std::numeric_limits<uint32_t>::max();
    /** Faixa permitida pra folga derivada de `pacingQuantumNs()` acima da posição de
     * `AdvanceLimitFn` (ver `leadNs = clamp(2*pacingQuantumNs(), kMinAdvanceLeadNs, kMaxAdvanceLeadNs)`
     * em `start()`) -- piso evita que hosts com granularidade minúscula fiquem "piscando" o teto a
     * cada ciclo; teto garante que a defasagem nunca reabre grande o bastante pra reproduzir o
     * sintoma que este recurso existe pra evitar, mesmo em hosts muito ruidosos. Ponto de partida a
     * refinar com medição ao vivo, não considerado definitivo. */
    static constexpr uint64_t kMinAdvanceLeadNs = 5'000'000;  // 5ms
    static constexpr uint64_t kMaxAdvanceLeadNs = 20'000'000; // 20ms

    void pushEventLocked(uint64_t timeNs, uint32_t componentIndex, EventCallback callback);
    void signalWorkAvailable() {
        m_workGeneration.fetch_add(1, std::memory_order_release);
        m_workGeneration.notify_all();
    }
    bool processNextEventUntilLocked(std::unique_lock<std::mutex>& lock, uint64_t targetTimeNs);
    bool settleUntilStableLocked(std::unique_lock<std::mutex>& lock);
    /** Incorpora marcações feitas pelo caminho não bloqueante de markDirty(). Requer m_mutex. */
    bool mergePendingDirtyLocked();

    SparseSet<uint32_t> m_dirty;
    /** Produtores que encontram m_mutex ocupado publicam aqui para nunca bloquear o consumo da
     * arena QEMU atrás de uma iteração cara do solver. Só o Scheduler move itens daqui para
     * m_dirty; duplicatas continuam colapsadas pela mesma semântica de SparseSet. */
    SparseSet<uint32_t> m_pendingDirty;
    mutable std::mutex m_pendingDirtyMutex;
    std::priority_queue<ScheduledEvent, std::vector<ScheduledEvent>, ScheduledEventOrder> m_events;
    uint64_t m_nowNs = 0;
    std::atomic<uint64_t> m_nowSnapshotNs{0};
    std::atomic<uint64_t> m_resetGeneration{0};
    uint64_t m_nextSequence = 0;
    SettleStepFn m_settleStep;
    TimeStepBeginFn m_beginTimeStep;
    TimeStepCommitFn m_commitTimeStep;
    StableStepFn m_stableStep;
    CommandDrainFn m_commandDrain;
    CommandPendingFn m_commandPending;
    AdvanceLimitFn m_advanceLimit;
    BeforeExecutionFn m_beforeExecution;

    std::thread m_thread;
    std::atomic<std::thread::id> m_workerThreadId{};
    mutable std::mutex m_mutex;
    /** Geração monotônica do trabalho publicado. Ao contrário de condition_variable, atomic::wait
     * não perde um sinal que chegue antes de a worker efetivamente bloquear. */
    std::atomic<uint64_t> m_workGeneration{0};
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
    std::atomic<uint64_t> m_pacingQuantumNs{1};
    /** Ver doc-comment de notifyAdvanceLimitChanged() acima. */
    std::atomic<uint64_t> m_advanceLimitGeneration{0};
    /** Instrumentação temporária (investigação de desempenho I2C) -- quantas vezes o ramo
     * "advanceLimited" esperou, e quanto tempo real cada wait_for() realmente levou (soma). Antes
     * da correção de notifyAdvanceLimitChanged(), cada ocorrência pagava ~5ms cheios; depois, só
     * paga o tempo real até o próximo avanço genuíno. */
    std::atomic<uint64_t> m_advanceLimitWaitCount{0};
    std::atomic<uint64_t> m_advanceLimitWaitNanoseconds{0};
    std::atomic<size_t> m_maxNonLinearIterations{0};
    std::atomic<uint64_t> m_maximumTimeStepNs{0};
    std::atomic<bool> m_profilingEnabled{false};
    std::atomic<uint64_t> m_eventsProcessed{0};
    std::atomic<uint64_t> m_timeSteps{0};
    std::atomic<uint64_t> m_settleIterations{0};
    std::atomic<uint64_t> m_settleNanoseconds{0};
    std::atomic<uint64_t> m_maxSettleNanoseconds{0};
    std::atomic<uint64_t> m_maxSettleAtNowNs{0};
    std::atomic<uint64_t> m_pendingEventSnapshot{0};
    uint64_t m_currentTimeStepNs = 0;
    uint64_t m_minimumTimeStepNs = 1;
    bool m_adaptiveTimeStep = false;
    bool m_lastSettleConverged = true;
};

} // namespace lasecsimul::simulation
