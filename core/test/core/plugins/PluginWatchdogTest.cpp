#include "plugins/PluginWatchdog.hpp"
#include <atomic>
#include <chrono>
#include <cstdio>
#include <thread>
// assert() é a verificação deste teste. Em Release o CMake define NDEBUG e cada assert() viraria
// no-op: o baseline noturno (Release) aprovava o teste sem checar nada. <assert.h> redefine
// assert() conforme NDEBUG a cada inclusão; por isso vem depois dos outros includes.
#undef NDEBUG
#include <assert.h>

using lasecsimul::plugins::PluginWatchdog;
using lasecsimul::plugins::WatchdogOutcome;

namespace {

void testFastCallCompletesWithinTimeout() {
    int counter = 0;
    const WatchdogOutcome outcome = PluginWatchdog::call("test.fast", 200, [&] { counter++; });
    assert(outcome == WatchdogOutcome::Completed);
    assert(counter == 1);
    std::printf("OK: chamada rapida termina como Completed dentro do timeout.\n");
}

void testZeroTimeoutMeansNoWatchdog() {
    int counter = 0;
    // timeoutMs == 0 -> chamada direta, sem thread extra (ver docstring de PluginWatchdog::call).
    const WatchdogOutcome outcome = PluginWatchdog::call("test.notimeout", 0, [&] { counter++; });
    assert(outcome == WatchdogOutcome::Completed);
    assert(counter == 1);
    std::printf("OK: stepTimeoutMs=0 roda direto, sem watchdog.\n");
}

void testSlowCallTimesOutAndThreadIsAbandoned() {
    std::atomic<bool> finallyRan{false};
    const WatchdogOutcome outcome = PluginWatchdog::call("test.slow", 50, [&] {
        std::this_thread::sleep_for(std::chrono::milliseconds(300));
        finallyRan.store(true);
    });
    assert(outcome == WatchdogOutcome::TimedOut);
    assert(!finallyRan.load()); // ainda não deu tempo de terminar quando o watchdog desistiu
    std::printf("OK: chamada lenta excede o timeout e volta como TimedOut sem esperar o fim.\n");

    // A thread abandonada continua existindo (detach, nunca TerminateThread) -- espera ela
    // terminar de verdade antes de sair do processo de teste, só pra não vazar um sleep pendente
    // que sobreviveria ao processo (não é parte do contrato, é higiene do teste).
    std::this_thread::sleep_for(std::chrono::milliseconds(400));
    assert(finallyRan.load());
    std::printf("OK: thread desanexada termina sozinha depois, sem ter sido morta a força.\n");
}

// post_step de cada device a ~60 Hz: uma thread nova por chamada custava ~3% do Scheduler com dois
// displays. A instância tem que reaproveitar a mesma thread reservada.
void testReservedThreadIsReused() {
    PluginWatchdog watchdog("test.reused");
    std::thread::id first{};
    bool sameThread = true;
    int counter = 0;
    for (int i = 0; i < 200; ++i) {
        std::thread::id seen{};
        const WatchdogOutcome outcome = watchdog.run(200, [&seen, &counter] {
            seen = std::this_thread::get_id();
            counter++;
        });
        assert(outcome == WatchdogOutcome::Completed);
        if (i == 0) {
            first = seen;
        } else {
            sameThread = sameThread && seen == first;
        }
    }
    assert(counter == 200);
    assert(first != std::this_thread::get_id());
    assert(sameThread);
    std::printf("OK: 200 chamadas na mesma thread reservada, fora da thread de quem chama.\n");
}

// Seção 13 da spec: a thread presa continua sendo a do device. A chamada seguinte espera dentro do
// próprio orçamento e volta TimedOut sem entrar de novo no plugin; quando a presa volta, o device
// segue na mesma thread.
void testStuckThreadIsNeverReentered() {
    PluginWatchdog watchdog("test.stuck");
    std::atomic<bool> stuckDone{false};
    std::atomic<int> entries{0};
    std::thread::id stuckThread{};
    WatchdogOutcome outcome = watchdog.run(50, [&] {
        stuckThread = std::this_thread::get_id();
        std::this_thread::sleep_for(std::chrono::milliseconds(300));
        stuckDone.store(true);
    });
    assert(outcome == WatchdogOutcome::TimedOut);

    const auto start = std::chrono::steady_clock::now();
    outcome = watchdog.run(50, [&] { entries++; });
    const auto waited = std::chrono::steady_clock::now() - start;
    assert(outcome == WatchdogOutcome::TimedOut);
    assert(entries.load() == 0);
    assert(waited >= std::chrono::milliseconds(40));
    assert(waited < std::chrono::milliseconds(250));
    std::printf("OK: com a thread presa, a chamada seguinte volta TimedOut sem entrar no plugin.\n");

    for (int i = 0; i < 100 && !stuckDone.load(); ++i) std::this_thread::sleep_for(std::chrono::milliseconds(10));
    assert(stuckDone.load());
    std::thread::id resumed{};
    outcome = watchdog.run(200, [&] {
        resumed = std::this_thread::get_id();
        entries++;
    });
    assert(outcome == WatchdogOutcome::Completed);
    assert(entries.load() == 1);
    assert(resumed == stuckThread);
    std::printf("OK: quando a chamada presa volta, o device segue na mesma thread reservada.\n");
}

#if defined(_WIN32)
// CrashGuard roda dentro da thread reservada: um crash vira Crashed e a thread continua servindo.
void testCrashKeepsReservedThreadUsable() {
    PluginWatchdog watchdog("test.crash");
    WatchdogOutcome outcome = watchdog.run(200, [] {
        volatile int* volatile target = nullptr;
        *target = 1;
    });
    assert(outcome == WatchdogOutcome::Crashed);
    int counter = 0;
    outcome = watchdog.run(200, [&counter] { counter++; });
    assert(outcome == WatchdogOutcome::Completed);
    assert(counter == 1);
    std::printf("OK: crash dentro da thread reservada volta Crashed e a thread segue servindo.\n");
}
#endif

// shutdown() com a thread presa desanexa sem esperar (item 3 da seção 13), e ela termina sozinha.
void testShutdownAbandonsStuckThreadWithoutWaiting() {
    std::atomic<bool> finallyRan{false};
    {
        PluginWatchdog watchdog("test.shutdown");
        const WatchdogOutcome outcome = watchdog.run(20, [&finallyRan] {
            std::this_thread::sleep_for(std::chrono::milliseconds(300));
            finallyRan.store(true);
        });
        assert(outcome == WatchdogOutcome::TimedOut);
        const auto start = std::chrono::steady_clock::now();
        watchdog.shutdown();
        assert(std::chrono::steady_clock::now() - start < std::chrono::milliseconds(100));
        assert(!finallyRan.load());
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(400));
    assert(finallyRan.load());
    std::printf("OK: shutdown desanexa a thread presa sem esperar, e ela termina sozinha depois.\n");
}

} // namespace

int main() {
    testFastCallCompletesWithinTimeout();
    testZeroTimeoutMeansNoWatchdog();
    testSlowCallTimesOutAndThreadIsAbandoned();
    testReservedThreadIsReused();
    testStuckThreadIsNeverReentered();
#if defined(_WIN32)
    testCrashKeepsReservedThreadUsable();
#endif
    testShutdownAbandonsStuckThreadWithoutWaiting();
    std::printf("\nTodos os testes de PluginWatchdog passaram.\n");
    return 0;
}
