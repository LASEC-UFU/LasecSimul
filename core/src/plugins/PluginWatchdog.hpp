#pragma once

#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include "CrashGuard.hpp"

namespace lasecsimul::plugins {

/** Resultado de uma chamada vigiada por `PluginWatchdog`. Ver
 * .spec/archive/legacy-v2/lasecsimul-native-devices.spec, seção 13: convenção cooperativa (`yield_check`, fora do
 * escopo desta classe -- é o SDK do plugin que chamaria isso, não o host) + watchdog por thread
 * reservada (esta classe) + abandono da thread após N timeouts consecutivos (decisão de quem chama,
 * ver `NativeDeviceProxy::postStep`). */
enum class WatchdogOutcome { Completed, Crashed, TimedOut };

/**
 * Executa `fn` (envolvida em `CrashGuard`) numa thread reservada e espera até `timeoutMs`
 * (seção 13, item 2). A thread é criada na primeira chamada e reaproveitada nas seguintes: antes
 * (até 2026-10-29) cada chamada criava e juntava uma `std::thread` nova, e com o `post_step` de
 * cada device a ~60 Hz isso custava ~3% do tempo de parede do Scheduler com dois displays, e
 * crescia com cada porta lógica do circuito.
 *
 * Se a chamada não terminar a tempo, a thread NUNCA é forçada a parar (`TerminateThread`/
 * `pthread_cancel` corrompem heap/locks -- proibidos pela spec). Ela continua sendo a thread desta
 * instância: a próxima chamada espera ela liberar (dentro do próprio `timeoutMs`) e, se ainda
 * estiver presa, volta `TimedOut` sem entrar de novo no plugin -- nunca duas chamadas da mesma
 * instância rodando ao mesmo tempo, e no máximo uma thread presa por instância. A thread presa só
 * é desanexada (`detach`) quando a instância é encerrada (`shutdown`/destrutor), item 3 da seção.
 *
 * `fn` é copiada para a thread e pode começar ou terminar depois de um `TimedOut`: o que ela
 * captura tem que continuar válido até lá (capture por valor, nunca uma variável da pilha de quem
 * chamou por referência). Quem chama decide a política de "lagging" vs "faulted" a partir do
 * `WatchdogOutcome` -- esta classe só mede tempo, não acumula estado de saúde.
 */
class PluginWatchdog {
public:
    explicit PluginWatchdog(std::string typeId) : m_typeId(std::move(typeId)) {}
    PluginWatchdog(const PluginWatchdog&) = delete;
    PluginWatchdog& operator=(const PluginWatchdog&) = delete;
    ~PluginWatchdog() { shutdown(); }

    WatchdogOutcome run(uint32_t timeoutMs, const std::function<void()>& fn) {
        if (timeoutMs == 0) {
            // sem orçamento de tempo declarado no manifesto -- chamada direta, sem thread extra
            // (comportamento de hoje, preservado pra quem não opta no watchdog).
            return CrashGuard::call(m_typeId, fn) ? WatchdogOutcome::Completed : WatchdogOutcome::Crashed;
        }

        const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
        if (!m_worker.joinable()) start();
        State& state = *m_state;
        const auto idle = [&state] { return state.finished == state.posted; };

        std::unique_lock<std::mutex> lock(state.mutex);
        // Chamada anterior que estourou o tempo ainda dentro do plugin: espera ela, nunca entra em
        // paralelo na mesma instância.
        if (!state.done.wait_until(lock, deadline, idle)) return WatchdogOutcome::TimedOut;
        state.job = fn;
        ++state.posted;
        lock.unlock();
        state.wake.notify_one();
        lock.lock();
        if (!state.done.wait_until(lock, deadline, idle)) return WatchdogOutcome::TimedOut;
        return state.crashed ? WatchdogOutcome::Crashed : WatchdogOutcome::Completed;
    }

    /** Encerra a thread reservada: junta se estiver livre; se estiver presa no plugin, desanexa
     * (seção 13, item 3) e descarta a chamada que ainda nem começou. Idempotente; quem é dono de
     * um handle de plugin chama isto ANTES de destruir o handle. */
    void shutdown() {
        if (!m_worker.joinable()) return;
        bool idle = false;
        {
            std::lock_guard<std::mutex> lock(m_state->mutex);
            m_state->stop = true;
            idle = m_state->finished == m_state->posted;
        }
        m_state->wake.notify_one();
        if (idle) {
            m_worker.join();
        } else {
            m_worker.detach(); // ver docstring da classe: nunca TerminateThread/pthread_cancel
        }
        m_state.reset();
    }

    /** Chamada única, numa thread só dela (create/destroy e outras chamadas frias, ver
     * `NativeMcuAdapterProxy`): mesma semântica de `run`, a thread não é reaproveitada. */
    static WatchdogOutcome call(const std::string& typeId, uint32_t timeoutMs, const std::function<void()>& fn) {
        PluginWatchdog watchdog(typeId);
        return watchdog.run(timeoutMs, fn);
    }

private:
    struct State {
        std::mutex mutex;
        std::condition_variable wake; // chamada postada ou shutdown
        std::condition_variable done; // chamada terminou
        std::function<void()> job;
        uint64_t posted = 0;
        uint64_t finished = 0;
        bool crashed = false;
        bool stop = false;
    };

    void start() {
        m_state = std::make_shared<State>();
        // A thread guarda a própria referência ao estado: desanexada, ela continua válida até
        // terminar, mesmo depois que esta instância sumir.
        m_worker = std::thread([state = m_state, typeId = m_typeId] {
            std::unique_lock<std::mutex> lock(state->mutex);
            for (;;) {
                state->wake.wait(lock, [&state] { return state->stop || state->finished != state->posted; });
                if (state->stop) return;
                std::function<void()> job = std::move(state->job);
                lock.unlock();
                const bool ok = CrashGuard::call(typeId, job);
                job = nullptr;
                lock.lock();
                state->crashed = !ok;
                state->finished = state->posted;
                state->done.notify_all();
            }
        });
    }

    std::string m_typeId;
    std::shared_ptr<State> m_state;
    std::thread m_worker;
};

} // namespace lasecsimul::plugins
