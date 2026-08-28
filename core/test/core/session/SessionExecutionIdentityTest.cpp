#include <cstdio>
#include <unordered_set>
#include <thread>
#include "plugins/GlobalPluginCache.hpp"
#include "session/SimulationSession.hpp"

using lasecsimul::plugins::GlobalPluginCache;
using lasecsimul::session::SimulationSession;

int main() {
    int failures = 0;
    auto check = [&](bool ok, const char* msg) { if (!ok) { std::fprintf(stderr, "FAIL: %s\n", msg); ++failures; } };

    GlobalPluginCache cache;
    SimulationSession s(cache);
    check(!s.runtimeState().executionActive && s.runtimeState().sessionExecutionId == 0,
          "sessao inicia inativa");
    s.beginExecutionIfNeeded();
    const auto first = s.runtimeState().sessionExecutionId;
    check(s.runtimeState().executionActive && first != 0, "start cria ID valido");
    s.beginExecutionIfNeeded();
    check(s.runtimeState().sessionExecutionId == first, "start idempotente");
    s.scheduler().start();
    s.scheduler().pause();
    const auto paused = s.runtimeState().sessionExecutionId;
    s.scheduler().resume();
    check(paused == first && s.runtimeState().sessionExecutionId == first, "pause/resume preserva ID");
    s.stopSimulation();
    check(!s.runtimeState().executionActive && s.runtimeState().sessionExecutionId == first,
          "stop inativa sem apagar diagnostico");
    s.beginExecutionIfNeeded();
    const auto second = s.runtimeState().sessionExecutionId;
    check(second != 0 && second != first, "stop/start gera ID novo");
    s.stopSimulation();

    std::unordered_set<uint64_t> ids;
    for (int i = 0; i < 100; ++i) {
        s.beginExecutionIfNeeded();
        const auto id = s.runtimeState().sessionExecutionId;
        check(id != 0 && ids.insert(id).second, "ciclos nao reutilizam ID");
        s.stopSimulation();
    }
    GlobalPluginCache cache2;
    SimulationSession other(cache2);
    other.beginExecutionIfNeeded();
    check(other.runtimeState().sessionExecutionId != s.runtimeState().sessionExecutionId,
          "sessoes independentes nao colidem");

    SimulationSession concurrent(cache);
    std::thread a([&] { concurrent.beginExecutionIfNeeded(); });
    std::thread b([&] { concurrent.beginExecutionIfNeeded(); });
    a.join(); b.join();
    check(concurrent.runtimeState().executionActive, "start concorrente deixa execucao ativa");
    check(concurrent.runtimeState().sessionExecutionId != 0, "start concorrente usa um ID valido");
    concurrent.stopSimulation();

    SimulationSession failed(cache);
    failed.beginExecutionIfNeeded();
    const auto failedId = failed.runtimeState().sessionExecutionId;
    failed.scheduler().setFailNextStartForTesting(true);
    bool threw = false;
    try { failed.scheduler().start(); } catch (...) { threw = true; }
    failed.abortExecutionIfCurrent(failedId);
    check(threw && !failed.runtimeState().executionActive, "falha de start deixa estado inativo");
    failed.beginExecutionIfNeeded();
    check(failed.runtimeState().executionActive && failed.runtimeState().sessionExecutionId != failedId,
          "retry apos falha recebe ID novo");
    failed.stopSimulation();

    SimulationSession race(cache);
    std::thread starter([&] { race.beginExecutionIfNeeded(); });
    std::thread stopper([&] { race.stopSimulation(); });
    starter.join(); stopper.join();
    check(!race.runtimeState().executionActive || race.runtimeState().sessionExecutionId != 0,
          "start/stop concorrente termina em estado coerente");
    return failures == 0 ? 0 : 1;
}
