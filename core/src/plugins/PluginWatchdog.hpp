#pragma once

#include <chrono>
#include <condition_variable>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include "CrashGuard.hpp"

namespace lasecsimul::plugins {

/** Resultado de uma chamada vigiada por `PluginWatchdog::call`. Ver
 * .spec/archive/legacy-v2/lasecsimul-native-devices.spec, seção 13: convenção cooperativa (`yield_check`, fora do
 * escopo desta classe -- é o SDK do plugin que chamaria isso, não o host) + watchdog por thread
 * dedicada (esta classe) + abandono da thread após N timeouts consecutivos (decisão de quem chama,
 * ver `NativeDeviceProxy::postStep`). */
enum class WatchdogOutcome { Completed, Crashed, TimedOut };

/**
 * Executa `fn` (já envolvida em `CrashGuard` por quem chama, ou diretamente -- ver overload) numa
 * thread dedicada e espera até `timeoutMs`. Se a chamada não terminar a tempo, a thread NUNCA é
 * forçada a parar (`TerminateThread`/`pthread_cancel` corrompem heap/locks -- proibidos pela spec);
 * em vez disso é desanexada (`detach`) e continua existindo até terminar por conta própria ou até o
 * processo Core encerrar. Quem chama decide a política de "lagging" vs "faulted" a partir do
 * `WatchdogOutcome` (ver seção 13, itens 2 e 3) -- esta classe só mede tempo, não acumula estado.
 */
class PluginWatchdog {
public:
    static WatchdogOutcome call(const std::string& typeId, uint32_t timeoutMs, const std::function<void()>& fn) {
        if (timeoutMs == 0) {
            // sem orçamento de tempo declarado no manifesto -- chamada direta, sem thread extra
            // (comportamento de hoje, preservado pra quem não opta no watchdog).
            return CrashGuard::call(typeId, fn) ? WatchdogOutcome::Completed : WatchdogOutcome::Crashed;
        }

        auto state = std::make_shared<SharedState>();
        std::thread worker([state, typeId, fn] {
            const bool ok = CrashGuard::call(typeId, fn);
            {
                std::lock_guard<std::mutex> lock(state->mutex);
                state->done = true;
                state->crashed = !ok;
            }
            state->cv.notify_all();
        });

        std::unique_lock<std::mutex> lock(state->mutex);
        const bool finishedInTime =
            state->cv.wait_for(lock, std::chrono::milliseconds(timeoutMs), [&state] { return state->done; });

        if (!finishedInTime) {
            worker.detach(); // ver docstring da classe: nunca TerminateThread/pthread_cancel
            return WatchdogOutcome::TimedOut;
        }
        lock.unlock();
        worker.join();
        return state->crashed ? WatchdogOutcome::Crashed : WatchdogOutcome::Completed;
    }

private:
    struct SharedState {
        std::mutex mutex;
        std::condition_variable cv;
        bool done = false;
        bool crashed = false;
    };
};

} // namespace lasecsimul::plugins
