#pragma once

#include <atomic>
#include <cstdint>
#include <span>

namespace lasecsimul::mcu::qemu {

// Shared by every monotonic-watermark field this file's users maintain
// (McuComponent::m_latestVnextBVirtualTimeNs, m_vnextBHeartbeatWatermarkNs): a lock-free,
// forward-only advance. Returns true only if `candidate` was strictly newer than the
// previously-stored value and the store took effect -- callers use that to decide whether to
// also call Scheduler::notifyAdvanceLimitChanged(). Never regresses: a candidate that is not
// strictly greater than the current value is silently ignored, which is what makes repeated
// (coalesced) publishes of the same or an older value safe to call unconditionally.
inline bool advanceMonotonicNs(std::atomic<uint64_t>& stored, uint64_t candidate) {
    uint64_t observed = stored.load(std::memory_order_relaxed);
    while (candidate > observed) {
        if (stored.compare_exchange_weak(observed, candidate, std::memory_order_relaxed)) {
            return true;
        }
    }
    return false;
}

// PLAN_MTTCG_VNEXT_B_CAUSALITY.md sections 9.2/9.3/10.1: pure, unit-testable temporal-merge
// arbiter for VNEXT_B's per-lane rings. Deliberately has no dependency on VnextBAttachment,
// QEMU, or any I/O -- it only picks which lane's head event should be dispatched next, given
// a peek of every lane's head and the Scheduler's current time. The actual consume/dispatch
// side effects stay in McuComponent; this function decides ordering only.
//
// Ordering invariant (armadilha called out explicitly in the plan): lane_sequence is monotonic
// only *within* its own lane, so it must never be used to compare events from different lanes.
// The merge key is (timestampNs, laneIndex) -- laneIndex only breaks a genuine timestamp tie,
// deterministically, never as the primary key.

struct VnextBLanePeek {
    bool present = false;
    uint64_t timestampNs = 0;
};

struct VnextBArbiterDecision {
    // False when every lane is empty: nothing to do, no future boundary either.
    bool hasCandidate = false;
    // Index into the `peeks` span passed to selectNextLaneEvent(), valid only if hasCandidate.
    uint32_t lane = 0;
    uint64_t timestampNs = 0;
    // True: the candidate's timestampNs <= nowNs, the caller should consume+dispatch this lane's
    // head now. False: the candidate exists but is in the future: the caller must NOT consume
    // it, and should instead treat `timestampNs` as the next wake boundary (schedule a callback
    // for exactly that instant; do not poll early, do not busy-loop).
    bool ready = false;
};

// Picks the single lane whose head should be considered next, across every lane, by the
// (timestampNs, laneIndex) key described above. Never consumes/mutates anything -- pure
// selection over the peeks already taken by the caller.
VnextBArbiterDecision selectNextLaneEvent(std::span<const VnextBLanePeek> peeks, uint64_t nowNs);

// E143 (EVIDENCE.md, 2026-09-08): pure, unit-testable policy for the rearm decision
// McuComponent::pollAndDispatchPendingEvents() must make AFTER acknowledging
// notificationPending() and re-peeking every lane -- the exact point H143 identified as the
// bug. hasPendingLaneEvents() alone (write_seq != read_seq) cannot distinguish "the remaining
// head is ready now" from "the remaining head is still in the future"; treating both cases the
// same way (an unconditional now+1ns reschedule) starves a legitimately-scheduled future
// callback forever, because now+1ns is always earlier than any real future deadline and so
// always wins schedulePollAt()'s own "only preempt if strictly earlier" generation-bump check.
enum class VnextBRearmAction {
    None,      // no candidate on any lane: do not reschedule anything.
    Immediate, // a candidate is ready now (post-ack re-arbitration found one, or the turn's
               // drain budget was exhausted): request an immediate continuation.
    At,        // a candidate exists but is still in the future: (re)schedule for exactly its
               // timestamp, never earlier. Never becomes now+1ns.
};

struct VnextBRearmDecision {
    VnextBRearmAction action = VnextBRearmAction::None;
    // Only meaningful when action == At.
    uint64_t atTimestampNs = 0;
};

// budgetExhausted takes priority (matches McuComponent's existing, unchanged "budget exhausted
// during the main drain loop" handling): the caller must keep making progress on this backlog
// regardless of what re-arbitration would otherwise say, so it is always Immediate. Otherwise:
// no candidate -> None; a candidate whose timestampNs <= nowNs -> Immediate; a strictly-future
// candidate -> At(candidate.timestampNs). Never returns Immediate for a future-only candidate.
inline VnextBRearmDecision decidePostAckRearm(std::span<const VnextBLanePeek> peeks, uint64_t nowNs,
                                               bool budgetExhausted) {
    if (budgetExhausted) return {VnextBRearmAction::Immediate, 0};
    const VnextBArbiterDecision decision = selectNextLaneEvent(peeks, nowNs);
    if (!decision.hasCandidate) return {VnextBRearmAction::None, 0};
    if (decision.ready) return {VnextBRearmAction::Immediate, 0};
    return {VnextBRearmAction::At, decision.timestampNs};
}

} // namespace lasecsimul::mcu::qemu
