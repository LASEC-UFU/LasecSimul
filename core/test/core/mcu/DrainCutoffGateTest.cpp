/* E130 (EVIDENCE.md, 2026-09-05), Fase 6: deterministic RED/GREEN tests for the drain/cutoff gate
 * itself (mcu/qemu/DrainCutoffGate.hpp) -- exercised here against synthetic, fully-controlled
 * counters instead of a live QEMU/Core session, so every scenario below is reproducible in
 * milliseconds instead of depending on a real firmware happening to land in a specific timing
 * window. This is the RED/GREEN proof that the new watermark/cutoff scheme actually fixes the race
 * the old raw-equality convergence wait (VnextBProductionScaleTest.cpp, pre-E130) was exposed to,
 * and that it still correctly fails on a genuinely lost pre-cut request -- it does not simply
 * relax the gate until everything passes. */

#include "mcu/qemu/DrainCutoffGate.hpp"

#include <atomic>
#include <chrono>
#include <cstdint>
#include <iostream>
#include <thread>
#include <vector>

using lasecsimul::mcu::waitForAllToDrain;
using Clock = std::chrono::steady_clock;

namespace {

int failures = 0;

void expect(bool condition, const char* what) {
    if (!condition) {
        std::cerr << "FAIL: " << what << "\n";
        ++failures;
    }
}

/* Scenario 1: already equal at the instant of the cut -- the common case, must not block. */
void test_already_drained_at_cut() {
    std::atomic<uint64_t> completed{100};
    std::vector<std::function<uint64_t()>> readers{[&] { return completed.load(); }};
    std::vector<uint64_t> cutoffs{100};
    const auto start = Clock::now();
    const auto result = waitForAllToDrain(readers, cutoffs, start + std::chrono::seconds(3),
                                           std::chrono::milliseconds(10));
    const auto elapsed = Clock::now() - start;
    expect(result.allDrained && !result.timedOut, "already-drained-at-cut should report drained");
    expect(elapsed < std::chrono::milliseconds(200),
           "already-drained-at-cut should return immediately, not poll");
    std::cout << "DRAIN_GATE_TEST already_drained_at_cut PASS\n";
}

/* Scenario 2 (Fase 4/6's central case): equality observed, then a NEW submission (and its
 * completion) arrives past the cutoff. The old raw-equality convergence wait would have re-read
 * both counters and seen submitted > completed transiently; this gate must not even look at
 * anything past the frozen cutoff. */
void test_post_cut_activity_does_not_affect_gate() {
    std::atomic<uint64_t> completed{50};
    std::vector<std::function<uint64_t()>> readers{[&] { return completed.load(); }};
    std::vector<uint64_t> cutoffs{50}; // frozen BEFORE the post-cut activity below
    std::thread producer([&] {
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
        completed.fetch_add(37); // a whole new burst of post-cut submissions+completions
    });
    const auto result = waitForAllToDrain(readers, cutoffs, Clock::now() + std::chrono::seconds(3),
                                           std::chrono::milliseconds(10));
    producer.join();
    expect(result.allDrained && !result.timedOut,
           "post-cut activity must not prevent the gate from reporting drained");
    std::cout << "DRAIN_GATE_TEST post_cut_activity_does_not_affect_gate PASS\n";
}

/* Scenario 3: exactly one request in flight at the cut instant, which completes shortly after --
 * the gate must actually wait for it, not just check once and give up. */
void test_in_flight_at_cut_completes_during_drain() {
    std::atomic<uint64_t> completed{99}; // cutoff (100) is one ahead: the in-flight request
    std::vector<std::function<uint64_t()>> readers{[&] { return completed.load(); }};
    std::vector<uint64_t> cutoffs{100};
    std::thread producer([&] {
        std::this_thread::sleep_for(std::chrono::milliseconds(150));
        completed.fetch_add(1); // the in-flight request finally completes
    });
    const auto start = Clock::now();
    const auto result = waitForAllToDrain(readers, cutoffs, start + std::chrono::seconds(3),
                                           std::chrono::milliseconds(10));
    const auto elapsed = Clock::now() - start;
    producer.join();
    expect(result.allDrained && !result.timedOut,
           "in-flight-at-cut request that completes during drain must be observed as drained");
    expect(elapsed >= std::chrono::milliseconds(100),
           "gate must have actually waited for the in-flight completion, not returned instantly");
    std::cout << "DRAIN_GATE_TEST in_flight_at_cut_completes_during_drain PASS\n";
}

/* Scenario 4 (the critical negative control): a request accepted before the cut is genuinely
 * lost -- its completion counter never reaches the cutoff. The gate MUST fail (time out), not be
 * fooled into passing by any post-cut activity on the same counter. */
void test_genuinely_lost_pre_cut_request_times_out() {
    std::atomic<uint64_t> completed{99}; // will NEVER reach the cutoff of 100
    std::vector<std::function<uint64_t()>> readers{[&] { return completed.load(); }};
    std::vector<uint64_t> cutoffs{100};
    const auto result = waitForAllToDrain(readers, cutoffs, Clock::now() + std::chrono::milliseconds(300),
                                           std::chrono::milliseconds(10));
    expect(!result.allDrained && result.timedOut,
           "a genuinely lost pre-cut request must cause the gate to time out, not pass");
    std::cout << "DRAIN_GATE_TEST genuinely_lost_pre_cut_request_times_out PASS\n";
}

/* Scenario 5: a stopped/crashed session (artifactFatal-equivalent) whose completion counter is
 * simply frozen forever -- structurally identical to scenario 4 from this gate's point of view
 * (it only ever sees a counter that stops advancing), confirming the SAME timeout path covers
 * "stopped mid-drain" without needing separate logic. */
void test_frozen_counter_from_stopped_session_times_out() {
    const uint64_t frozenValue = 42;
    std::vector<std::function<uint64_t()>> readers{[&] { return frozenValue; }};
    std::vector<uint64_t> cutoffs{43};
    const auto result = waitForAllToDrain(readers, cutoffs, Clock::now() + std::chrono::milliseconds(200),
                                           std::chrono::milliseconds(10));
    expect(!result.allDrained && result.timedOut,
           "a frozen (stopped-session) counter must time out exactly like a genuine loss");
    std::cout << "DRAIN_GATE_TEST frozen_counter_from_stopped_session_times_out PASS\n";
}

/* Scenario 6: multiple sessions, only one still draining -- confirms the gate waits for ALL of
 * them, not just the first, and that a fast session doesn't mask a slow one. */
void test_multi_session_waits_for_slowest() {
    std::atomic<uint64_t> fast{10};
    std::atomic<uint64_t> slow{5};
    std::vector<std::function<uint64_t()>> readers{[&] { return fast.load(); },
                                                    [&] { return slow.load(); }};
    std::vector<uint64_t> cutoffs{10, 10};
    std::thread producer([&] {
        std::this_thread::sleep_for(std::chrono::milliseconds(80));
        slow.store(10);
    });
    const auto start = Clock::now();
    const auto result = waitForAllToDrain(readers, cutoffs, start + std::chrono::seconds(3),
                                           std::chrono::milliseconds(10));
    const auto elapsed = Clock::now() - start;
    producer.join();
    expect(result.allDrained && !result.timedOut, "multi-session gate must drain once the slow one catches up");
    expect(elapsed >= std::chrono::milliseconds(60),
           "gate must not report drained before the slow session actually catches up");
    std::cout << "DRAIN_GATE_TEST multi_session_waits_for_slowest PASS\n";
}

/* Scenario 7: one of several sessions is genuinely lost -- the whole gate must fail, a healthy
 * sibling session must not mask a lost one. */
void test_multi_session_one_lost_fails_whole_gate() {
    std::atomic<uint64_t> healthy{10};
    std::atomic<uint64_t> lost{5}; // never reaches its cutoff of 10
    std::vector<std::function<uint64_t()>> readers{[&] { return healthy.load(); },
                                                    [&] { return lost.load(); }};
    std::vector<uint64_t> cutoffs{10, 10};
    const auto result = waitForAllToDrain(readers, cutoffs, Clock::now() + std::chrono::milliseconds(200),
                                           std::chrono::milliseconds(10));
    expect(!result.allDrained && result.timedOut,
           "one genuinely lost session must fail the gate even if siblings are healthy");
    std::cout << "DRAIN_GATE_TEST multi_session_one_lost_fails_whole_gate PASS\n";
}

} // namespace

int main() {
    test_already_drained_at_cut();
    test_post_cut_activity_does_not_affect_gate();
    test_in_flight_at_cut_completes_during_drain();
    test_genuinely_lost_pre_cut_request_times_out();
    test_frozen_counter_from_stopped_session_times_out();
    test_multi_session_waits_for_slowest();
    test_multi_session_one_lost_fails_whole_gate();

    if (failures > 0) {
        std::cerr << "DRAIN_GATE_TEST " << failures << " failure(s)\n";
        return 1;
    }
    std::cout << "DRAIN_GATE_TEST ALL PASS\n";
    return 0;
}
