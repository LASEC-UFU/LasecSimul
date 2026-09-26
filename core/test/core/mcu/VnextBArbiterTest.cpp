// PLAN_MTTCG_VNEXT_B_CAUSALITY.md sections 9.2 ("ordenacao global") and 9.3 ("evento futuro").
// Pure unit tests for VnextBArbiter::selectNextLaneEvent(): no QEMU, no shared memory, no I/O --
// this is the isolated decision logic McuComponent::pollAndDispatchPendingEvents() is missing
// today (see EVIDENCE.md / r2_hygiene_manifest.json: mcu_scheduler_pacing_sync_real_qemu_test
// stalls for the full 90s test duration under VNEXT_B+MTTCG, reproduced twice).
#include "mcu/qemu/VnextBArbiter.hpp"
#include <algorithm>
#include <array>
#include <atomic>
#include <cstdio>
#include <deque>
#include <thread>
#include <utility>
#include <vector>

using namespace lasecsimul::mcu::qemu;

namespace {

int failures = 0;

#define TEST_ASSERT(expr, msg) \
    do { \
        if (!(expr)) { \
            std::fprintf(stderr, "  FALHOU: %s -- %s\n", msg, #expr); \
            failures++; \
        } else { \
            std::fprintf(stderr, "  OK: %s\n", msg); \
        } \
    } while (false)

// E143 (EVIDENCE.md, 2026-09-08; H143): a tiny, in-process, discrete-event model of exactly the
// scheduling primitives McuComponent::schedulePollAt()/scheduleNextPoll() use
// (m_pollGeneration/m_pollEventScheduled/m_pollEventDueNs and the "only preempt if the new
// target is strictly earlier" dedup rule) plus a nowNs that only ever advances by jumping
// straight to the next queued callback's timestamp -- exactly like the real
// Scheduler::runUntil()'s event-priority-queue jump, never a fixed tick. No QEMU, no Attachment,
// no Scheduler dependency: pure enough to prove or disprove H143 in isolation.
struct FakeSchedulerState {
    uint64_t nowNs = 0;
    uint64_t pollGeneration = 0;
    bool pollEventScheduled = false;
    uint64_t pollEventDueNs = 0;
    std::vector<std::pair<uint64_t, uint64_t>> events; // (timeNs, generationAtScheduleTime)
    uint64_t callbacksFired = 0;   // generation still matched when popped: a real, live poll
    uint64_t callbacksStale = 0;   // generation had moved on: the exact E123/E143 no-op path

    // Mirrors McuComponent::schedulePollAt() exactly (EVIDENCE.md E143): a request for a target
    // that is not strictly earlier than what's already scheduled is silently dropped; a request
    // for a strictly earlier target bumps the generation (making the old callback a future no-op)
    // and takes over.
    void schedulePollAt(uint64_t timeNs) {
        if (pollEventScheduled) {
            if (timeNs >= pollEventDueNs) return;
            ++pollGeneration;
        }
        pollEventScheduled = true;
        pollEventDueNs = timeNs;
        events.push_back({timeNs, pollGeneration});
    }
    // Mirrors McuComponent::scheduleNextPoll(): always "right now, +1ns" -- by construction
    // always earlier than any real future deadline, which is exactly the trap H143 identifies.
    void scheduleNextPoll() { schedulePollAt(nowNs + 1); }

    // Pops the earliest queued callback and advances nowNs directly to it (never a fixed step),
    // then fires it only if its captured generation is still current -- a stale one is the exact
    // no-op onPollEvent()'s own generation check already guards against.
    bool fireNext() {
        if (events.empty()) return false;
        const auto it = std::min_element(events.begin(), events.end());
        const auto [timeNs, generation] = *it;
        events.erase(it);
        nowNs = timeNs;
        if (generation != pollGeneration) { ++callbacksStale; return false; }
        pollEventScheduled = false;
        pollEventDueNs = 0;
        ++callbacksFired;
        return true;
    }
};

// The exact fixture E142 measured: a single lane, one head sitting at timestampNs=305 (ms-as-ns
// scale collapsed to small integers for test clarity; the ratio/logic is identical), Scheduler
// starting at nowNs=250 -- i.e. the head is 55 "ms" in the future, never consumed until nowNs
// reaches it. Returns {consumed, iterations spent, final nowNs}.
struct RearmSimResult {
    bool consumed = false;
    uint64_t iterations = 0;
    uint64_t finalNowNs = 0;
};

// Reproduces the PRE-E143 production policy verbatim: after the main peek/arbitrate loop defers
// a future head via schedulePollAt(), the post-ack block used hasPendingLaneEvents() -- true
// whenever write_seq != read_seq, with NO regard for ready-vs-future -- to unconditionally call
// scheduleNextPoll() (now+1ns). This is H143's hypothesis, encoded literally, not copied from
// production (McuComponent.cpp is fixed by this same episode; this stands as a permanent
// regression guard against the bug reappearing there).
RearmSimResult runOldBuggyPolicy(uint64_t headTimestampNs, uint64_t startNowNs, uint64_t maxIterations) {
    FakeSchedulerState s;
    s.nowNs = startNowNs;
    RearmSimResult result;
    for (; result.iterations < maxIterations; ++result.iterations) {
        const VnextBLanePeek peek{true, headTimestampNs};
        const auto decision = selectNextLaneEvent(std::span<const VnextBLanePeek>(&peek, 1), s.nowNs);
        if (decision.hasCandidate && decision.ready) { result.consumed = true; break; }
        if (decision.hasCandidate && !decision.ready) {
            s.schedulePollAt(decision.timestampNs);
        }
        // Post-ack, pre-E143: hasPendingLaneEvents() alone -- the ring still has the same
        // unconsumed head, so this is unconditionally true, regardless of ready/future.
        constexpr bool hasPendingLaneEventsPreE143 = true;
        if (hasPendingLaneEventsPreE143) {
            s.scheduleNextPoll(); // the bug: always now+1ns, always preempts the real deadline.
        }
        if (!s.fireNext()) continue; // stale callback: matches the real no-op path, keep going.
    }
    result.finalNowNs = s.nowNs;
    return result;
}

// The E143 fix, using the new pure decidePostAckRearm() policy at the exact same call site.
RearmSimResult runNewFixedPolicy(uint64_t headTimestampNs, uint64_t startNowNs, uint64_t maxIterations) {
    FakeSchedulerState s;
    s.nowNs = startNowNs;
    RearmSimResult result;
    for (; result.iterations < maxIterations; ++result.iterations) {
        const VnextBLanePeek peek{true, headTimestampNs};
        const auto decision = selectNextLaneEvent(std::span<const VnextBLanePeek>(&peek, 1), s.nowNs);
        if (decision.hasCandidate && decision.ready) { result.consumed = true; break; }
        if (decision.hasCandidate && !decision.ready) {
            s.schedulePollAt(decision.timestampNs);
        }
        const VnextBLanePeek postAckPeek{true, headTimestampNs};
        const auto rearm = decidePostAckRearm(std::span<const VnextBLanePeek>(&postAckPeek, 1), s.nowNs,
                                               /*budgetExhausted=*/false);
        switch (rearm.action) {
            case VnextBRearmAction::None: break;
            case VnextBRearmAction::Immediate: s.scheduleNextPoll(); break;
            case VnextBRearmAction::At: s.schedulePollAt(rearm.atTimestampNs); break;
        }
        if (!s.fireNext()) continue;
    }
    result.finalNowNs = s.nowNs;
    return result;
}

} // namespace

int main() {
    std::fprintf(stderr, "=== VnextBArbiterTest ===\n");

    // section 9.2: two lanes, lane0={120,140}, lane1={100,130}, mandatory order
    // 100/L1, 120/L0, 130/L1, 140/L0. This is the exact fixture named in the plan.
    {
        std::deque<uint64_t> lane0{120, 140};
        std::deque<uint64_t> lane1{100, 130};
        std::vector<std::pair<uint64_t, uint32_t>> dispatched; // (timestampNs, lane)
        const uint64_t nowNs = 1'000'000; // far in the future: every head is "ready" for this test
        for (;;) {
            std::array<VnextBLanePeek, 2> peeks{};
            peeks[0] = lane0.empty() ? VnextBLanePeek{} : VnextBLanePeek{true, lane0.front()};
            peeks[1] = lane1.empty() ? VnextBLanePeek{} : VnextBLanePeek{true, lane1.front()};
            const auto decision = selectNextLaneEvent(peeks, nowNs);
            if (!decision.hasCandidate) break;
            TEST_ASSERT(decision.ready, "9.2 fixture: candidate should be ready (nowNs far in the future)");
            dispatched.emplace_back(decision.timestampNs, decision.lane);
            (decision.lane == 0 ? lane0 : lane1).pop_front();
        }
        const std::vector<std::pair<uint64_t, uint32_t>> expected = {
            {100, 1}, {120, 0}, {130, 1}, {140, 0}
        };
        TEST_ASSERT(dispatched == expected,
                    "9.2 global order across lanes follows (timestampNs, laneId), never lane-index bias");
    }

    // Tie-break: equal timestampNs across lanes must resolve deterministically by lane index,
    // never by lane_sequence (this arbiter doesn't even see lane_sequence -- by construction it
    // cannot make that mistake, but assert the documented tie-break explicitly).
    {
        std::array<VnextBLanePeek, 3> peeks{
            VnextBLanePeek{true, 500}, VnextBLanePeek{true, 500}, VnextBLanePeek{true, 500}
        };
        const auto decision = selectNextLaneEvent(peeks, 999999);
        TEST_ASSERT(decision.hasCandidate && decision.ready && decision.lane == 0,
                    "tied timestamps break deterministically toward the lowest lane index");
    }

    // section 9.3: "evento futuro". Scheduler at nowNs=100, heads at 120/130 -- nothing may be
    // consumed, and the earliest head (120, lane0) must be reported as the next boundary so the
    // caller can schedule a callback for exactly that instant instead of busy-polling.
    {
        std::array<VnextBLanePeek, 2> peeks{
            VnextBLanePeek{true, 120}, VnextBLanePeek{true, 130}
        };
        const auto decision = selectNextLaneEvent(peeks, 100);
        TEST_ASSERT(decision.hasCandidate, "9.3 future event: a candidate boundary must still be reported");
        TEST_ASSERT(!decision.ready, "9.3 future event: must not be marked ready when timestampNs > nowNs");
        TEST_ASSERT(decision.lane == 0 && decision.timestampNs == 120,
                    "9.3 future event: earliest head (120, lane0) is the reported boundary, not 130");
    }

    // Boundary equality: nowNs exactly equal to the head's timestamp must be ready (a scheduled
    // callback firing at exactly the boundary must be able to consume it, not defer forever).
    {
        std::array<VnextBLanePeek, 1> peeks{VnextBLanePeek{true, 250}};
        const auto decision = selectNextLaneEvent(peeks, 250);
        TEST_ASSERT(decision.hasCandidate && decision.ready,
                    "nowNs == timestampNs is ready, not still-future (off-by-one boundary check)");
    }

    // Empty lanes (no lanes present at all) report no candidate, not a spurious ready decision.
    {
        std::array<VnextBLanePeek, 2> peeks{};
        const auto decision = selectNextLaneEvent(peeks, 12345);
        TEST_ASSERT(!decision.hasCandidate, "all-empty lanes produce no candidate");
    }

    // Mixed: one lane empty, the other has a ready past event -- must select the present lane,
    // not be confused by the empty one occupying a lower index.
    {
        std::array<VnextBLanePeek, 2> peeks{VnextBLanePeek{}, VnextBLanePeek{true, 42}};
        const auto decision = selectNextLaneEvent(peeks, 100);
        TEST_ASSERT(decision.hasCandidate && decision.ready && decision.lane == 1,
                    "an empty lane at index 0 must not block selecting a ready event at index 1");
    }

    // R3c (heartbeat watermark): advanceMonotonicNs() is the shared forward-only primitive both
    // McuComponent::m_latestVnextBVirtualTimeNs and m_vnextBHeartbeatWatermarkNs use. Tested here
    // in isolation, matching the user's explicit requirement that the watermark never regress
    // and that repeated (coalesced) publishes of the same/an older value are safe.
    {
        std::atomic<uint64_t> watermark{0};
        TEST_ASSERT(advanceMonotonicNs(watermark, 100) == true,
                    "first advance from 0 to 100 succeeds and reports true");
        TEST_ASSERT(watermark.load() == 100, "stored value is now 100");

        TEST_ASSERT(advanceMonotonicNs(watermark, 50) == false,
                    "a smaller candidate (regression) is rejected");
        TEST_ASSERT(watermark.load() == 100, "value did not regress to 50");

        TEST_ASSERT(advanceMonotonicNs(watermark, 100) == false,
                    "an equal candidate (coalesced/duplicate tick) is a no-op, not an error");
        TEST_ASSERT(watermark.load() == 100, "value unchanged by a duplicate tick");

        // Several coalesced ticks arriving as a burst (e.g. the doorbell fired once for multiple
        // heartbeat publishes that happened before the Core got scheduled) must not lose the
        // final, largest value -- and every intermediate one must be handled safely regardless
        // of arrival order.
        TEST_ASSERT(advanceMonotonicNs(watermark, 150) == true, "burst tick 1: 100 -> 150");
        TEST_ASSERT(advanceMonotonicNs(watermark, 120) == false, "burst tick 2 (stale, out of order): rejected");
        TEST_ASSERT(advanceMonotonicNs(watermark, 999) == true, "burst tick 3: 150 -> 999");
        TEST_ASSERT(watermark.load() == 999, "final value reflects the largest tick in the burst, none lost");

        TEST_ASSERT(advanceMonotonicNs(watermark, 0) == false,
                    "a zero candidate (e.g. a fresh session's still-unset field) never regresses an armed watermark");
    }

    // ==== E143 (EVIDENCE.md, 2026-09-08; H143) ====
    // session_restart_stress_test's real-firmware red (E142): lane 0 fills to write_seq=8,
    // read_seq stays 0 for the entire 5s window, despite the arbiter, dispatcher, and heartbeat
    // all functioning correctly. E142 localized the boundary to McuComponent's post-ack rearm
    // using hasPendingLaneEvents() (write_seq!=read_seq, blind to ready-vs-future) to decide
    // whether to reschedule -- this reproduces and then fixes that exact policy, entirely
    // pure/in-process (no QEMU, no Attachment, no real Scheduler).

    // Phase 1 RED: the E142 fixture, at the SAME nanosecond scale E142 actually measured
    // (~305,000,000 vs ~250,000,000, i.e. a ~55ms gap) -- this scale matters: scheduleNextPoll()
    // always requests nowNs+1 (one nanosecond), which is only a meaningful "advance" if the gap
    // to the real deadline is itself nanosecond-scale. At the real ~55,000,000ns gap, a storm of
    // now+1ns reschedules advances nowNs by a few thousand nanoseconds at most -- negligible,
    // exactly reproducing E142's observed "stuck at ~234-251ms, never reaching ~305ms".
    {
        constexpr uint64_t kHead = 305'000'000, kStart = 250'000'000, kBound = 2000;
        const RearmSimResult red = runOldBuggyPolicy(kHead, kStart, kBound);
        TEST_ASSERT(!red.consumed,
                    "H143 RED: the pre-E143 policy never consumes the future head within a generous bound");
        TEST_ASSERT(red.finalNowNs < kStart + 100'000,
                    "H143 RED: Scheduler::nowNs creeps by at most a few thousand ns of now+1ns storm, "
                    "never meaningfully closing the ~55,000,000ns gap to the real deadline");
        TEST_ASSERT(red.iterations >= kBound,
                    "H143 RED: the loop runs to the iteration bound instead of converging (callback storm)");
        std::fprintf(stderr,
                      "  H143 RED measured: consumed=%d finalNowNs=%llu iterations=%llu "
                      "(deadline=%llu never reached)\n",
                      red.consumed, static_cast<unsigned long long>(red.finalNowNs),
                      static_cast<unsigned long long>(red.iterations),
                      static_cast<unsigned long long>(kHead));
    }

    // Phase 1 RED, direct proof of "substituição indevida por now+1ns": schedule the correct
    // 305,000,000 deadline, then apply the pre-E143 post-ack policy once and confirm it is
    // clobbered by a now+1ns reschedule.
    {
        FakeSchedulerState s;
        s.nowNs = 250'000'000;
        s.schedulePollAt(305'000'000);
        TEST_ASSERT(s.pollEventDueNs == 305'000'000 && s.pollGeneration == 0,
                    "H143 RED setup: the correct future deadline (305,000,000) is installed first, generation 0");
        s.scheduleNextPoll(); // the exact pre-E143 post-ack call, unconditional
        TEST_ASSERT(s.pollEventDueNs == 250'000'001,
                    "H143 RED: scheduleNextPoll(now+1ns) overwrote the real 305,000,000 deadline with "
                    "now+1ns (250,000,001)");
        TEST_ASSERT(s.pollGeneration == 1,
                    "H143 RED: overwriting a still-future, not-yet-due deadline bumped the generation, "
                    "invalidating the correct 305,000,000 callback (it will fire as a stale no-op)");
    }

    // Phase 5/GREEN: the same exact fixture, fixed policy -- must converge immediately (one
    // schedule to the real deadline, one fire, exactly one consume), no storm, no wasted
    // generations, regardless of the gap's magnitude.
    {
        constexpr uint64_t kHead = 305'000'000, kStart = 250'000'000, kBound = 2000;
        const RearmSimResult green = runNewFixedPolicy(kHead, kStart, kBound);
        TEST_ASSERT(green.consumed, "H143 GREEN: the fixed policy consumes the head exactly once");
        TEST_ASSERT(green.finalNowNs == kHead,
                    "H143 GREEN: Scheduler::nowNs lands exactly on the real deadline, not before/after");
        TEST_ASSERT(green.iterations <= 2,
                    "H143 GREEN: converges in at most 2 iterations (schedule once, fire once) -- no storm");
        std::fprintf(stderr,
                      "  H143 GREEN measured: consumed=%d finalNowNs=%llu iterations=%llu\n",
                      green.consumed, static_cast<unsigned long long>(green.finalNowNs),
                      static_cast<unsigned long long>(green.iterations));
    }

    // Phase 4, item 1+2: decidePostAckRearm() on a future head returns At(exact timestamp),
    // never Immediate -- and repeating the identical notification/re-peek never produces
    // now+1ns (calling it twice in a row with the same still-unconsumed future head must be
    // idempotent, not escalate toward now+1ns).
    {
        const VnextBLanePeek futureHead{true, 305};
        const auto first = decidePostAckRearm(std::span<const VnextBLanePeek>(&futureHead, 1), 250, false);
        TEST_ASSERT(first.action == VnextBRearmAction::At && first.atTimestampNs == 305,
                    "item 1: a future head keeps the rearm at its exact timestamp, not now+1ns");
        const auto second = decidePostAckRearm(std::span<const VnextBLanePeek>(&futureHead, 1), 250, false);
        TEST_ASSERT(second.action == VnextBRearmAction::At && second.atTimestampNs == 305,
                    "item 2: repeating the same future-head notification is idempotent (still At(305))");
    }

    // Phase 4, item 3: a head that has become ready by the time of the post-ack re-peek (nowNs
    // advanced past it via some other path) requests an immediate continuation.
    {
        const VnextBLanePeek readyHead{true, 305};
        const auto rearm = decidePostAckRearm(std::span<const VnextBLanePeek>(&readyHead, 1), 305, false);
        TEST_ASSERT(rearm.action == VnextBRearmAction::Immediate,
                    "item 3: a head ready at re-peek time requests an immediate continuation");
    }

    // Phase 4, item 4+5: a concurrently-published, EARLIER candidate (ready on another lane, or
    // simply an earlier future head) legitimately preempts a later future deadline -- this is the
    // one case where clobbering an existing schedule is correct, and it happens automatically
    // because selectNextLaneEvent() always picks the globally-earliest timestamp.
    {
        // item 4: lane0 future at 305, lane1 ready now at 200 -- must select lane1, Immediate.
        std::array<VnextBLanePeek, 2> peeksReadyElsewhere{VnextBLanePeek{true, 305}, VnextBLanePeek{true, 200}};
        const auto rearmReady = decidePostAckRearm(
            std::span<const VnextBLanePeek>(peeksReadyElsewhere.data(), 2), 250, false);
        TEST_ASSERT(rearmReady.action == VnextBRearmAction::Immediate,
                    "item 4: a ready event on another lane preempts a later future deadline (Immediate)");

        // item 5: lane0 future at 305, lane1 future at 280 (earlier, still future) -- must
        // select lane1's 280, not stay at 305.
        std::array<VnextBLanePeek, 2> peeksEarlierFuture{VnextBLanePeek{true, 305}, VnextBLanePeek{true, 280}};
        const auto rearmEarlier = decidePostAckRearm(
            std::span<const VnextBLanePeek>(peeksEarlierFuture.data(), 2), 250, false);
        TEST_ASSERT(rearmEarlier.action == VnextBRearmAction::At && rearmEarlier.atTimestampNs == 280,
                    "item 5: an earlier future head on another lane preempts a later future deadline");

        // And schedulePollAt() itself must actually honor that preemption (strictly earlier ->
        // generation bump), never a no-op.
        FakeSchedulerState s;
        s.nowNs = 250;
        s.schedulePollAt(305);
        s.schedulePollAt(280);
        TEST_ASSERT(s.pollEventDueNs == 280 && s.pollGeneration == 1,
                    "item 5b: schedulePollAt() itself preempts 305 with the strictly-earlier 280");
    }

    // Phase 4, item 6: a future head that is LATER than what's already scheduled must NOT
    // replace it (this is what makes the E143 fix safe: re-arbitrating after every ack cannot
    // regress an already-correct, nearer deadline).
    {
        FakeSchedulerState s;
        s.nowNs = 250;
        s.schedulePollAt(305);
        const uint64_t generationBefore = s.pollGeneration;
        s.schedulePollAt(400); // later than the already-scheduled 305
        TEST_ASSERT(s.pollEventDueNs == 305 && s.pollGeneration == generationBefore,
                    "item 6: a later future head does not replace an earlier already-scheduled deadline");
    }

    // Phase 4, item 7: no candidate on any lane (all empty) -> None, never schedules anything.
    {
        std::array<VnextBLanePeek, 2> emptyPeeks{};
        const auto rearm = decidePostAckRearm(std::span<const VnextBLanePeek>(emptyPeeks.data(), 2), 250, false);
        TEST_ASSERT(rearm.action == VnextBRearmAction::None,
                    "item 7: an empty lane (no candidate at all) does not reschedule anything");
    }

    // Phase 4, item 8: budget exhaustion always requests an immediate continuation, regardless
    // of what the lanes currently show (even a future-only head, even empty lanes) -- this
    // preserves the pre-existing, already-correct "must not abandon backlog" contract.
    {
        const VnextBLanePeek futureHead{true, 305};
        const auto rearmFuture = decidePostAckRearm(std::span<const VnextBLanePeek>(&futureHead, 1), 250, true);
        TEST_ASSERT(rearmFuture.action == VnextBRearmAction::Immediate,
                    "item 8a: budget exhaustion forces Immediate even with only a future head present");
        std::array<VnextBLanePeek, 2> emptyPeeks{};
        const auto rearmEmpty = decidePostAckRearm(std::span<const VnextBLanePeek>(emptyPeeks.data(), 2), 250, true);
        TEST_ASSERT(rearmEmpty.action == VnextBRearmAction::Immediate,
                    "item 8b: budget exhaustion forces Immediate even with empty lanes");
    }

    // Phase 4, item 9: a concurrent publish that lands between the drain loop's last check and
    // the ack (a genuinely new, ready event appearing only in the post-ack re-peek) must still be
    // picked up -- the re-arbitration re-peeks fresh, so it cannot miss this.
    {
        // Simulates: main loop saw lane1 empty, but by post-ack re-peek time a fresh ready event
        // has landed on it (e.g. a second I2C request queued right behind the first).
        std::array<VnextBLanePeek, 2> peeksConcurrentPublish{VnextBLanePeek{true, 305}, VnextBLanePeek{true, 240}};
        const auto rearm = decidePostAckRearm(
            std::span<const VnextBLanePeek>(peeksConcurrentPublish.data(), 2), 250, false);
        TEST_ASSERT(rearm.action == VnextBRearmAction::Immediate,
                    "item 9: a concurrently-published ready event is picked up by the post-ack re-peek, not lost");
    }

    // Phase 4, item 10: a stale (generation-invalidated) callback remains a pure no-op. Schedule
    // 305 (generation 0), then a strictly-earlier legitimate preemption to 200 (generation bumps
    // to 1) -- the queue now holds both the live (200, gen1) entry and the now-obsolete
    // (305, gen0) one left over from before the preemption. The live, nearer entry fires first
    // (real priority-queue order); the old one, reached later, must no-op, not double-fire.
    {
        FakeSchedulerState s;
        s.nowNs = 250;
        s.schedulePollAt(305); // generation 0, due 305
        s.schedulePollAt(200); // strictly earlier -> generation bumps to 1, due 200
        TEST_ASSERT(s.events.size() == 2,
                    "item 10a setup: both the superseded (305,gen0) and live (200,gen1) entries are queued");
        TEST_ASSERT(s.fireNext() && s.callbacksFired == 1 && s.nowNs == 200,
                    "item 10b: the live, nearer (200, generation1) entry fires normally");
        TEST_ASSERT(!s.fireNext(),
                    "item 10c: the leftover (305, generation0) entry, reached afterward, is recognized as stale");
        TEST_ASSERT(s.callbacksStale == 1 && s.callbacksFired == 1 && s.nowNs == 305,
                    "item 10d: exactly one stale no-op, exactly one real fire -- no double consumption");
    }

    if (failures == 0) {
        std::fprintf(stderr, "\nTodos os testes passaram.\n");
        return 0;
    }
    std::fprintf(stderr, "\n%d teste(s) FALHARAM.\n", failures);
    return 1;
}
