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

} // namespace

int main() {
    testFastCallCompletesWithinTimeout();
    testZeroTimeoutMeansNoWatchdog();
    testSlowCallTimesOutAndThreadIsAbandoned();
    std::printf("\nTodos os testes de PluginWatchdog passaram.\n");
    return 0;
}
