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

    Scheduler(size_t componentCapacity, SettleStepFn settleStep)
        : m_dirty(componentCapacity), m_settleStep(std::move(settleStep)) {}

    void setTimeStepCallbacks(TimeStepBeginFn begin, TimeStepCommitFn commit) {
        m_beginTimeStep = std::move(begin);
        m_commitTimeStep = std::move(commit);
    }
    void setStableStepCallback(StableStepFn callback) { m_stableStep = std::move(callback); }
    void setCommandDrainCallback(CommandDrainFn callback) { m_commandDrain = std::move(callback); }
    void setCommandPendingCallback(CommandPendingFn callback) { m_commandPending = std::move(callback); }
    void setAdvanceLimitCallback(AdvanceLimitFn callback) { m_advanceLimit = std::move(callback); }
    /** Acorda a worker se ela estiver parked (ociosa ou pausada) -- chamada pela thread de IPC depois
     * de empurrar um comando na fila (`SimulationSession::enqueueCommand`). CORREÇÃO 2026-07-27: o
     * comentário antigo aqui argumentava que notificar sem segurar `m_mutex` era seguro porque
     * `wait(lock, predicate)` reavalia o predicado no início -- reproduzido ao vivo (.spec 32.5.5,
     * repro dedicado) que esse argumento é FALSO em geral: existe uma janela real, dentro de uma
     * ÚNICA chamada a `wait(lock, predicate)`, entre o predicado ser avaliado falso e a worker
     * efetivamente registrar a espera -- se quem muda o estado do predicado notifica nessa janela
     * SEM segurar o mesmo mutex, o notify não acorda ninguém (a worker ainda não estava registrada)
     * e a espera de baixo nível que a worker faz em seguida nunca mais recebe outro. Ver
     * `Scheduler::stop()`, corrigido com essa evidência (segura `m_mutex` só pra trocar `m_running`,
     * ver comentário lá). `pause()`/`resume()` têm a MESMA classe de risco teórico mas NÃO foram
     * corrigidos da mesma forma -- fazer isso reabre um deadlock diferente contra um settle não-
     * convergente (ver comentário de `pause()`); nenhuma reprodução ao vivo confirmou a perda de
     * wakeup nesses dois, ao contrário do de `stop()`. Esta função (`notifyCommandPending`) também
     * NÃO foi corrigida (o estado do predicado aqui, `CommandPendingFn`, pertence à fila de comandos
     * externa, fora do `m_mutex` deste Scheduler -- corrigir exigiria uma API nova pra quem enfileira
     * o comando também segurar este mutex, mudança maior, fora do escopo do achado de 32.5.5) --
     * risco residual documentado: um comando enfileirado pode, em teoria, esperar até o próximo
     * wakeup incidental (evento/dirty/pause/stop) em vez de ser atendido na hora. */
    void notifyCommandPending() { m_wake.notify_one(); }
    /** Acorda a worker se ela estiver esperando o `AdvanceLimitFn` avançar (ver ramo "sem espaço pra
     * avançar" em `start()`) -- chamada por quem preenche o hook assim que a posição de referência
     * realmente muda (ex.: `McuComponent::pollStepLocked()`, logo após avançar
     * `m_latestVirtualTimePs`). Sem lock, mesma justificativa de `notifyCommandPending()` -- quem
     * espera usa `wait_for(lock, duração, predicado)`, então mesmo um notify perdido só custa até
     * a próxima verificação por tempo (curta, ver a duração usada em `start()`), nunca trava. */
    void notifyAdvanceLimitChanged() { m_pacingWake.notify_all(); }
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
        m_maxSettleNanoseconds.store(0, std::memory_order_relaxed);
        m_maxSettleAtNowNs.store(0, std::memory_order_relaxed);
    }
    MetricsSnapshot metrics() const {
        return {m_profilingEnabled.load(std::memory_order_relaxed),
                m_eventsProcessed.load(std::memory_order_relaxed),
                m_timeSteps.load(std::memory_order_relaxed),
                m_settleIterations.load(std::memory_order_relaxed),
                m_settleNanoseconds.load(std::memory_order_relaxed),
                m_pendingEventSnapshot.load(std::memory_order_relaxed),
                m_maxSettleNanoseconds.load(std::memory_order_relaxed),
                m_maxSettleAtNowNs.load(std::memory_order_relaxed)};
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
    /** Achado ao vivo 2026-07-27 (.spec 32.5.5): cheguei a proteger esta troca com `m_mutex`, igual
     * ao fix de `Scheduler::stop()` -- mas isso reabre um DEADLOCK diferente, também reproduzido ao
     * vivo: `settleUntilStableLocked()` pode segurar `m_mutex` por um tempo arbitrariamente longo
     * (settle que nunca converge, ver seu doc-comment) e só o solta ao ver `m_paused`/
     * `m_stopRequested` num POLL sem lock -- exatamente pra permitir que `pause()`/`stop()`
     * interrompam esse laço de fora. Se `pause()` precisar do MESMO `m_mutex` pra setar `m_paused`,
     * ela nunca consegue rodar enquanto o settle não converge (só converge vendo `m_paused`, que só
     * muda depois que `pause()` conseguir o lock) -- ciclo fechado, sem saída. `stop()` escapa desse
     * ciclo porque `m_stopRequested` (não tocado por este achado, sempre foi lock-free) já é
     * suficiente pra destravar o settle ANTES do `lock_guard` daquela função rodar. `pause()`/
     * `resume()` continuam lock-free de propósito -- o risco teórico de wakeup perdido (mesma classe
     * do achado de `stop()`) fica documentado como residual: nenhuma reprodução ao vivo o confirmou
     * aqui, ao contrário do de `stop()`. */
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
    bool processNextEventUntilLocked(std::unique_lock<std::mutex>& lock, uint64_t targetTimeNs);
    bool settleUntilStableLocked(std::unique_lock<std::mutex>& lock);

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
    AdvanceLimitFn m_advanceLimit;

    std::thread m_thread;
    std::atomic<std::thread::id> m_workerThreadId{};
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
    std::atomic<uint64_t> m_pacingQuantumNs{1};
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
