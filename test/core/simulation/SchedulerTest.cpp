#include "simulation/Scheduler.hpp"
#include <cassert>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
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

} // namespace

int main() {
    testOrderedEvents();
    testSameTimestampIsDeterministic();
    testDirtyDuplicateOnce();
    testResetClearsEventsAndDirty();
    testStopDoesNotBlock();
    testAsyncModeAdvancesWithoutScheduledEvents();
    testRealTimeRateCapsVirtualAdvanceWithoutFixedDelay();
    testRepeatedStartStopDoesNotLeakWorkersOrEvents();
    testControlAndTelemetryStayResponsiveDuringNonConvergentSettle();

    std::printf("OK: Scheduler ordered events, deterministic tie-break, dirty, reset, stop.\n");
    return 0;
}
