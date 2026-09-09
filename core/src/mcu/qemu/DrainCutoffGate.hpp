#pragma once

#include <chrono>
#include <cstdint>
#include <functional>
#include <thread>
#include <vector>

namespace lasecsimul::mcu {

/* E130 (EVIDENCE.md, 2026-09-05), Fase 5/6: the measurement boundary that replaces the old
 * "poll until submitted==completed, then break" convergence wait (VnextBProductionScaleTest.cpp,
 * originally added E120) -- that scheme reads both counters fresh a second time, later, for the
 * actual pass/fail decision, with nothing pausing the guest in between; a submission accepted in
 * that gap is counted without its (not-yet-arrived) completion, producing a submissions=
 * completions+1 artifact indistinguishable from a genuine dropped completion (this is what E129's
 * B11 N=8 run actually hit).
 *
 * The fix: the caller captures each session's own submission CUTOFF once, before calling this
 * function, and never re-reads it. This function only waits for readCompletion()[i] to reach (not
 * merely equal) cutoffs[i] -- monotonic non-decreasing counters make ">=" the correct predicate,
 * never "==", since a completion can arrive between two polls without this function ever
 * observing the exact equality instant. A submission accepted after the caller's cutoff is simply
 * outside cutoffs[i]'s value and cannot affect this wait, by construction -- not because this
 * function filters it out, but because the cutoff itself was already frozen before this call.
 *
 * Deliberately generic over how completion is read (std::function, not a concrete counter type)
 * so DrainCutoffGateTest.cpp can drive it with synthetic, controllable counters instead of a real
 * QEMU/Core session -- exercising the exact scenarios in EVIDENCE.md's Fase 6 (equality
 * immediately followed by a new submission past the cutoff, one in-flight request at the cut
 * instant that completes during the wait, a genuinely lost pre-cut request that must time out)
 * deterministically and in milliseconds, without needing a live firmware run to happen to land in
 * the right timing window. */
struct DrainResult {
    bool allDrained;
    bool timedOut;
};

inline DrainResult waitForAllToDrain(const std::vector<std::function<uint64_t()>>& readCompletions,
                                      const std::vector<uint64_t>& cutoffs,
                                      std::chrono::steady_clock::time_point deadline,
                                      std::chrono::milliseconds pollInterval) {
    for (;;) {
        bool allDrained = true;
        for (size_t i = 0; i < readCompletions.size(); ++i) {
            if (readCompletions[i]() < cutoffs[i]) {
                allDrained = false;
                break;
            }
        }
        if (allDrained) {
            return {true, false};
        }
        if (std::chrono::steady_clock::now() >= deadline) {
            return {false, true};
        }
        std::this_thread::sleep_for(pollInterval);
    }
}

} // namespace lasecsimul::mcu
