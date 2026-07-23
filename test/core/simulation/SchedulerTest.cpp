#include "simulation/Scheduler.hpp"
#include <algorithm>
#include <cassert>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <optional>
#include <thread>
#include <vector>

using lasecsimul::simulation::Scheduler;

namespace {

void testOrderedEvents() {
    std::vector<int> ran;
    Scheduler* schedulerPtr = nullptr;
    Scheduler scheduler(8, [&schedulerPtr] {
        schedulerPtr->dirtySet().clear();
        return false;
    });
    schedulerPtr = &scheduler;

    scheduler.scheduleAt(30, [&ran] { ran.push_back(3); });
    scheduler.scheduleAt(10, [&ran] { ran.push_back(1); });
    scheduler.scheduleAt(20, [&ran] { ran.push_back(2); });

    scheduler.runUntil(30);

    assert((ran == std::vector<int>{1, 2, 3}));
    assert(scheduler.nowNs() == 30);
}

void testSameTimestampIsDeterministic() {
    std::vector<int> ran;
    Scheduler* schedulerPtr = nullptr;
    Scheduler scheduler(8, [&schedulerPtr] {
        schedulerPtr->dirtySet().clear();
        return false;
    });
    schedulerPtr = &scheduler;

    scheduler.scheduleAt(10, [&ran] { ran.push_back(1); });
    scheduler.scheduleAt(10, [&ran] { ran.push_back(2); });
    scheduler.scheduleAt(10, [&ran] { ran.push_back(3); });

    scheduler.runUntil(10);

    assert((ran == std::vector<int>{1, 2, 3}));
}

void testDirtyDuplicateOnce() {
    std::vector<uint32_t> drained;
    Scheduler* schedulerPtr = nullptr;
    Scheduler scheduler(2, [&schedulerPtr, &drained] {
        drained.assign(schedulerPtr->dirtySet().dense().begin(), schedulerPtr->dirtySet().dense().end());
        schedulerPtr->dirtySet().clear();
        return false;
    });
    schedulerPtr = &scheduler;

    scheduler.markDirty(1);
    scheduler.markDirty(1);
    scheduler.runUntil(0);

    assert((drained == std::vector<uint32_t>{1}));
    assert(scheduler.dirtyCount() == 0);
}

void testResetClearsEventsAndDirty() {
    bool ran = false;
    Scheduler* schedulerPtr = nullptr;
    Scheduler scheduler(2, [&schedulerPtr] {
        schedulerPtr->dirtySet().clear();
        return false;
    });
    schedulerPtr = &scheduler;

    scheduler.markDirty(1);
    scheduler.scheduleAt(10, [&ran] { ran = true; });
    scheduler.reset();
    scheduler.runUntil(10);

    assert(!ran);
    assert(scheduler.nowNs() == 10);
    assert(scheduler.dirtyCount() == 0);
    assert(scheduler.pendingEventCount() == 0);
}

void testStopDoesNotBlock() {
    Scheduler* schedulerPtr = nullptr;
    Scheduler scheduler(2, [&schedulerPtr] {
        schedulerPtr->dirtySet().clear();
        return false;
    });
    schedulerPtr = &scheduler;

    scheduler.start();
    const auto start = std::chrono::steady_clock::now();
    scheduler.stop();
    const auto elapsed = std::chrono::steady_clock::now() - start;

    assert(elapsed < std::chrono::seconds(1));
}

void testAsyncModeAdvancesWithoutScheduledEvents() {
    Scheduler* schedulerPtr = nullptr;
    std::atomic<uint64_t> stableSteps{0};
    Scheduler scheduler(2, [&schedulerPtr] {
        schedulerPtr->dirtySet().clear();
        return false;
    });
    schedulerPtr = &scheduler;
    scheduler.setMaximumTimeStepNs(100);
    scheduler.setStableStepCallback([&](uint64_t) { ++stableSteps; });
    scheduler.start();

    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
    while (scheduler.nowNs() == 0 && std::chrono::steady_clock::now() < deadline)
        std::this_thread::yield();
    scheduler.stop();

    assert(scheduler.nowNs() > 0);
    assert(stableSteps.load() > 0);
}

void testRealTimeRateCapsVirtualAdvanceWithoutFixedDelay() {
    Scheduler* schedulerPtr = nullptr;
    Scheduler scheduler(2, [&schedulerPtr] {
        schedulerPtr->dirtySet().clear();
        return false;
    });
    schedulerPtr = &scheduler;
    scheduler.setMaximumTimeStepNs(1'000'000); // granularidade do fixture, não parâmetro do produto
    scheduler.setRealTimeRate(1.0);

    scheduler.start();
    std::this_thread::sleep_for(std::chrono::milliseconds(40));
    scheduler.stop();

    // A margem absorve a granularidade do host. Uma regressão para ilimitado avança ordens de
    // grandeza além deste limite; não se exige uma duração absoluta exata da máquina de CI.
    assert(scheduler.nowNs() > 0);
    assert(scheduler.nowNs() <= 100'000'000);
}

// Achado 2026-07-23 -- ver .claude/plans/humble-waddling-parnas.md: AdvanceLimitFn permite que
// alguém de fora (SimulationSession, seguindo o MCU mais lento da sessão) trave m_nowNs() na
// posição confirmada desse MCU mais uma folga, sem o Scheduler saber o que é um MCU. Substituiu um
// design anterior (PacingRateLimitFn, um multiplicador de taxa alimentado por uma razão suavizada
// por EMA) que falhou em teste ao vivo duas vezes -- ver doc-comment do tipo em Scheduler.hpp.
// Estes testes cobrem só o MECANISMO do teto em isolamento (nenhum MCU/QEMU envolvido) -- ver
// McuSchedulerPacingSyncTest.cpp pro comportamento fim-a-fim com um MCU sintético de verdade.
void testAdvanceLimitCapsElectricalAdvance() {
    Scheduler* schedulerPtr = nullptr;
    Scheduler scheduler(2, [&schedulerPtr] {
        schedulerPtr->dirtySet().clear();
        return false;
    });
    schedulerPtr = &scheduler;
    scheduler.setMaximumTimeStepNs(100'000);
    scheduler.setRealTimeRate(1.0);
    constexpr uint64_t kReferencePositionNs = 5'000'000; // 5ms
    scheduler.setAdvanceLimitCallback([] { return std::optional<uint64_t>(kReferencePositionNs); });

    scheduler.start();
    std::this_thread::sleep_for(std::chrono::milliseconds(80)); // bem mais que o suficiente pra calibrar e travar no teto
    scheduler.stop();

    // leadNs = clamp(2*pacingQuantumNs(), 5ms, 20ms) -- ver doc-comment de AdvanceLimitFn.
    const uint64_t leadNs = std::clamp<uint64_t>(2 * scheduler.pacingQuantumNs(), 5'000'000ULL, 20'000'000ULL);
    assert(scheduler.nowNs() > 0);
    assert(scheduler.nowNs() <= kReferencePositionNs + leadNs);
}

void testAdvanceLimitLiftsImmediatelyWhenReferenceMoves() {
    Scheduler* schedulerPtr = nullptr;
    Scheduler scheduler(2, [&schedulerPtr] {
        schedulerPtr->dirtySet().clear();
        return false;
    });
    schedulerPtr = &scheduler;
    scheduler.setMaximumTimeStepNs(100'000);
    scheduler.setRealTimeRate(1.0);
    std::atomic<uint64_t> referencePositionNs{1'000'000}; // 1ms -- teto bem apertado no inicio
    scheduler.setAdvanceLimitCallback([&referencePositionNs] {
        return std::optional<uint64_t>(referencePositionNs.load(std::memory_order_relaxed));
    });

    scheduler.start();
    std::this_thread::sleep_for(std::chrono::milliseconds(40)); // deixa travar no teto apertado
    const uint64_t cappedNowNs = scheduler.nowNs();
    assert(cappedNowNs < 30'000'000); // bem abaixo do que 40ms sem freio alcancaria

    referencePositionNs.store(500'000'000, std::memory_order_relaxed); // sobe MUITO o teto
    scheduler.notifyAdvanceLimitChanged();
    std::this_thread::sleep_for(std::chrono::milliseconds(40)); // agora deveria progredir livremente
    scheduler.stop();

    // Retomou de verdade (sem decaimento gradual nenhum pra esperar) -- nao ficou preso perto do
    // teto antigo.
    assert(scheduler.nowNs() > cappedNowNs + 20'000'000);
}

void testAdvanceLimitNulloptBehavesLikeNoHook() {
    Scheduler* schedulerPtr = nullptr;
    Scheduler scheduler(2, [&schedulerPtr] {
        schedulerPtr->dirtySet().clear();
        return false;
    });
    schedulerPtr = &scheduler;
    scheduler.setMaximumTimeStepNs(1'000'000);
    scheduler.setRealTimeRate(1.0);
    // nullopt = "nenhum MCU na sessão" -- isola a garantia de que isso se comporta EXATAMENTE como
    // se nenhum hook tivesse sido setado (mesmo limite frouxo do teste original sem hook nenhum).
    scheduler.setAdvanceLimitCallback([] { return std::optional<uint64_t>(std::nullopt); });

    scheduler.start();
    std::this_thread::sleep_for(std::chrono::milliseconds(40));
    scheduler.stop();

    assert(scheduler.nowNs() > 0);
    assert(scheduler.nowNs() <= 100'000'000);
}

void testAdvanceLimitAppliesEvenWithUnlimitedRate() {
    Scheduler* schedulerPtr = nullptr;
    Scheduler scheduler(2, [&schedulerPtr] {
        schedulerPtr->dirtySet().clear();
        return false;
    });
    schedulerPtr = &scheduler;
    scheduler.setMaximumTimeStepNs(100'000);
    scheduler.setRealTimeRate(0.0); // ilimitado
    constexpr uint64_t kReferencePositionNs = 5'000'000;
    scheduler.setAdvanceLimitCallback([] { return std::optional<uint64_t>(kReferencePositionNs); });

    scheduler.start();
    std::this_thread::sleep_for(std::chrono::milliseconds(60));
    scheduler.stop();

    // Mesmo sem pacing por taxa nenhum, o teto de posição continua valendo -- mudança deliberada
    // em relação ao hook antigo (PacingRateLimitFn só era chamado com realTimeRate()>0). Usa o teto
    // máximo da folga (20ms) porque em modo ilimitado a calibração de pacingQuantum nunca roda (ela
    // vive dentro do mesmo bloco gated em realTimeRate>0).
    assert(scheduler.nowNs() > 0);
    assert(scheduler.nowNs() <= kReferencePositionNs + 20'000'000);
}

void testAdvanceLimitNoBusySpinWhenPermanentlyCapped() {
    Scheduler* schedulerPtr = nullptr;
    std::atomic<uint64_t> hookCalls{0};
    Scheduler scheduler(2, [&schedulerPtr] {
        schedulerPtr->dirtySet().clear();
        return false;
    });
    schedulerPtr = &scheduler;
    scheduler.setMaximumTimeStepNs(100'000);
    scheduler.setRealTimeRate(1.0);
    scheduler.setAdvanceLimitCallback([&hookCalls] {
        hookCalls.fetch_add(1, std::memory_order_relaxed);
        return std::optional<uint64_t>(uint64_t{0}); // teto travado em 0 pra sempre -- nunca avança
    });

    scheduler.start();
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
    scheduler.stop();

    // Numa janela de 200ms com espera de 5ms quando sem espaço pra avançar, esperamos dezenas de
    // chamadas -- nao milhares (o que indicaria busy-spin girando sem dormir).
    assert(hookCalls.load() < 500);
}

void testRepeatedStartStopDoesNotLeakWorkersOrEvents() {
    Scheduler* schedulerPtr = nullptr;
    Scheduler scheduler(2, [&schedulerPtr] {
        schedulerPtr->dirtySet().clear();
        return false;
    });
    schedulerPtr = &scheduler;
    scheduler.setMaximumTimeStepNs(100);
    for (int cycle = 0; cycle < 100; ++cycle) {
        scheduler.start();
        const uint64_t before = scheduler.nowNs();
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
        while (scheduler.nowNs() == before && std::chrono::steady_clock::now() < deadline)
            std::this_thread::yield();
        assert(scheduler.nowNs() > before);
        scheduler.stop();
        assert(scheduler.pendingEventCount() == 0);
    }
}

void testControlAndTelemetryStayResponsiveDuringNonConvergentSettle() {
    std::atomic<int> settleCalls{0};
    Scheduler scheduler(2, [&] {
        ++settleCalls;
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
        return true; // deliberately leaves dirty set unchanged
    });
    scheduler.markDirty(1);
    scheduler.start();

    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
    while (settleCalls.load() == 0 && std::chrono::steady_clock::now() < deadline)
        std::this_thread::yield();
    assert(settleCalls.load() > 0);

    const auto telemetryStart = std::chrono::steady_clock::now();
    const auto telemetry = scheduler.trySynchronized([] { return 42; });
    const auto telemetryElapsed = std::chrono::steady_clock::now() - telemetryStart;
    assert(!telemetry);
    assert(telemetryElapsed < std::chrono::milliseconds(50));

    scheduler.pause();
    const auto stopStart = std::chrono::steady_clock::now();
    scheduler.stop();
    assert(std::chrono::steady_clock::now() - stopStart < std::chrono::seconds(1));
}

// Redesign de concorrência 2026-07-19 (ver .claude/plans/idempotent-floating-cat.md) -- cobre
// CommandDrainFn/CommandPendingFn/notifyCommandPending nos três pontos em que a worker precisa
// drenar a fila de comandos externa (SimulationSession::CommandQueue): ociosa, pausada, e presa num
// settle que nunca converge. As duas primeiras são regressão direta de um bug real encontrado
// ANTES de compilar: a implementação inicial só drenava dentro de settleUntilStableLocked(), que
// nunca é alcançado enquanto a worker está parked (ociosa OU pausada) -- editar o circuito nesses
// dois estados (o caso mais comum: montar o circuito antes de apertar "play", ou editar uma
// propriedade com a simulação pausada) travaria para sempre esperando uma iteração de settle que
// não ia acontecer.
void testCommandDrainWhileIdle() {
    std::atomic<int> drainCalls{0};
    std::atomic<bool> pending{false};
    std::atomic<bool> commandApplied{false};
    Scheduler scheduler(2, [] { return false; }); // settle: nunca fica dirty, não-op
    scheduler.setCommandDrainCallback([&] {
        ++drainCalls;
        if (pending.load()) { commandApplied.store(true); pending.store(false); }
    });
    scheduler.setCommandPendingCallback([&] { return pending.load(); });
    scheduler.start(); // events/dirty vazios -- a worker deve parar ociosa quase imediatamente

    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    pending.store(true);
    scheduler.notifyCommandPending();

    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
    while (!commandApplied.load() && std::chrono::steady_clock::now() < deadline)
        std::this_thread::yield();
    assert(commandApplied.load());

    // Sem o fix do busy-loop original (drenar SEM reavaliar se dirty/events continuam vazios antes
    // de decidir esperar de novo), a worker nunca voltaria a dormir depois deste comando -- ficaria
    // girando runUntil(mesmoInstante) pra sempre, inflando drainCalls sem limite. Um punhado de
    // chamadas extras é esperado (redrenagem antes de cada tentativa de dormir); milhares em 150ms
    // não.
    const int callsRightAfter = drainCalls.load();
    std::this_thread::sleep_for(std::chrono::milliseconds(150));
    const int callsAfterSettling = drainCalls.load();
    scheduler.stop();
    assert(callsAfterSettling - callsRightAfter < 50);
}

void testCommandDrainWhilePaused() {
    std::atomic<bool> pending{false};
    std::atomic<bool> commandApplied{false};
    Scheduler scheduler(2, [] { return false; });
    scheduler.setCommandDrainCallback([&] {
        if (pending.load()) { commandApplied.store(true); pending.store(false); }
    });
    scheduler.setCommandPendingCallback([&] { return pending.load(); });
    scheduler.start();
    scheduler.pause();
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    assert(scheduler.isPaused());

    pending.store(true);
    scheduler.notifyCommandPending();

    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
    while (!commandApplied.load() && std::chrono::steady_clock::now() < deadline)
        std::this_thread::yield();

    const bool stillPaused = scheduler.isPaused(); // drenar não deve alterar o estado de pausa
    scheduler.stop();
    assert(commandApplied.load());
    assert(stillPaused);
}

void testCommandDrainDuringNonConvergentSettle() {
    std::atomic<int> settleCalls{0};
    std::atomic<bool> pending{false};
    std::atomic<bool> commandApplied{false};
    Scheduler scheduler(2, [&] {
        ++settleCalls;
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
        return true; // nunca converge de propósito (dirty nunca esvazia)
    });
    scheduler.setCommandDrainCallback([&] {
        if (pending.load()) { commandApplied.store(true); pending.store(false); }
    });
    scheduler.markDirty(1);
    scheduler.start();

    const auto readyDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
    while (settleCalls.load() == 0 && std::chrono::steady_clock::now() < readyDeadline)
        std::this_thread::yield();
    assert(settleCalls.load() > 0);

    // O settle já está girando de verdade -- settleUntilStableLocked() já redrena a cada iteração
    // (mesmo raciocínio do check de m_stopRequested), então nem precisa de notify aqui.
    pending.store(true);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
    while (!commandApplied.load() && std::chrono::steady_clock::now() < deadline)
        std::this_thread::yield();

    scheduler.pause();
    scheduler.stop();
    assert(commandApplied.load());
}

} // namespace

int main() {
    testOrderedEvents();
    testSameTimestampIsDeterministic();
    testDirtyDuplicateOnce();
    testResetClearsEventsAndDirty();
    testStopDoesNotBlock();
    testAsyncModeAdvancesWithoutScheduledEvents();
    testRealTimeRateCapsVirtualAdvanceWithoutFixedDelay();
    testAdvanceLimitCapsElectricalAdvance();
    testAdvanceLimitLiftsImmediatelyWhenReferenceMoves();
    testAdvanceLimitNulloptBehavesLikeNoHook();
    testAdvanceLimitAppliesEvenWithUnlimitedRate();
    testAdvanceLimitNoBusySpinWhenPermanentlyCapped();
    testRepeatedStartStopDoesNotLeakWorkersOrEvents();
    testControlAndTelemetryStayResponsiveDuringNonConvergentSettle();
    testCommandDrainWhileIdle();
    testCommandDrainWhilePaused();
    testCommandDrainDuringNonConvergentSettle();

    std::printf("OK: Scheduler ordered events, deterministic tie-break, dirty, reset, stop, command queue drain (idle/paused/non-convergent).\n");
    return 0;
}
