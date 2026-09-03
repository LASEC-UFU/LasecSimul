#pragma once
// TEMPORARY diagnostic instrumentation (2026-08-29, restart-stress QUEUE-FULL host-error-shutdown
// investigation) -- traces the Core-side arena CONSUMER (background poll thread / dispatch path)
// to answer "why did Core stop draining the queue before it hit 32/32". Opt-in via
// LASECSIMUL_MCU_CONSUMER_TRACE=1 (unset by default -- zero behavioral/perf impact on any other
// test or production run). Bounded ring buffer, lock-free append, no allocation per entry, no
// blocking, no new threads, no synchronous disk flush -- dump() only called on
// queue-full/termination/test-failure, never per-operation. Not wired into CMakeLists as a
// standalone TU; header-only so no build-system change is needed. Remove once the investigation
// concludes -- never commit.
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>
#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace lasecsimul::mcu::diag {

enum class ConsumerTraceEvent : uint8_t {
    ThreadStart,
    ThreadStop,
    ArenaBind,
    ArenaUnbind,
    D0_Wake,
    D1_LoopEnter,
    D2_ReadIndexObserved,
    D3_ProcessBegin,
    D4_ProcessEnd,
    D5_ReadIndexAdvanced,
    D6_LoopExit,
    WaitBegin,
    WaitEnd,
    PressureCheckpoint,
};

inline const char* eventName(ConsumerTraceEvent ev) {
    switch (ev) {
        case ConsumerTraceEvent::ThreadStart: return "ThreadStart";
        case ConsumerTraceEvent::ThreadStop: return "ThreadStop";
        case ConsumerTraceEvent::ArenaBind: return "ArenaBind";
        case ConsumerTraceEvent::ArenaUnbind: return "ArenaUnbind";
        case ConsumerTraceEvent::D0_Wake: return "D0_Wake";
        case ConsumerTraceEvent::D1_LoopEnter: return "D1_LoopEnter";
        case ConsumerTraceEvent::D2_ReadIndexObserved: return "D2_ReadIndexObserved";
        case ConsumerTraceEvent::D3_ProcessBegin: return "D3_ProcessBegin";
        case ConsumerTraceEvent::D4_ProcessEnd: return "D4_ProcessEnd";
        case ConsumerTraceEvent::D5_ReadIndexAdvanced: return "D5_ReadIndexAdvanced";
        case ConsumerTraceEvent::D6_LoopExit: return "D6_LoopExit";
        case ConsumerTraceEvent::WaitBegin: return "WaitBegin";
        case ConsumerTraceEvent::WaitEnd: return "WaitEnd";
        case ConsumerTraceEvent::PressureCheckpoint: return "PressureCheckpoint";
    }
    return "?";
}

struct ConsumerTraceEntry {
    uint64_t tsNs = 0;
    uint64_t sessionExecutionId = 0;
    uint64_t queueWriteIndex = 0;
    uint64_t queueReadIndex = 0;
    // Meaning depends on event: opcode/regAddr for D2-D4, wait duration ns for WaitEnd,
    // lock-owner thread id (best-effort, 0 if unknown) for WaitEnd.
    uint64_t extra = 0;
    uint64_t extra2 = 0;
    uint32_t threadId = 0;
    ConsumerTraceEvent event{};
};

constexpr size_t kConsumerTraceCapacity = 16384;

inline bool traceEnabled() {
    static const bool enabled = [] {
        const char* v = std::getenv("LASECSIMUL_MCU_CONSUMER_TRACE");
        return v && *v && v[0] != '0';
    }();
    return enabled;
}

// Function-local statics inside an `inline` function are a single shared entity across every
// translation unit that includes this header (standard C++, not a per-TU copy) -- this is what
// makes one shared ring buffer work without a dedicated .cpp/CMake target.
inline std::array<ConsumerTraceEntry, kConsumerTraceCapacity>& ring() {
    static std::array<ConsumerTraceEntry, kConsumerTraceCapacity> storage{};
    return storage;
}
inline std::atomic<uint64_t>& writeCursor() {
    static std::atomic<uint64_t> cursor{0};
    return cursor;
}
// Wait-threshold violations get their own (much smaller) ring so a burst of normal D0-D6 traffic
// never evicts the handful of wait events that actually matter.
constexpr size_t kWaitTraceCapacity = 512;
inline std::array<ConsumerTraceEntry, kWaitTraceCapacity>& waitRing() {
    static std::array<ConsumerTraceEntry, kWaitTraceCapacity> storage{};
    return storage;
}
inline std::atomic<uint64_t>& waitWriteCursor() {
    static std::atomic<uint64_t> cursor{0};
    return cursor;
}

inline uint64_t monotonicNs() {
    return static_cast<uint64_t>(std::chrono::steady_clock::now().time_since_epoch().count());
}

inline uint32_t currentThreadId() {
#ifdef _WIN32
    return static_cast<uint32_t>(::GetCurrentThreadId());
#else
    return 0;
#endif
}

inline void trace(ConsumerTraceEvent ev, uint64_t sessionExecutionId, uint64_t queueWriteIndex,
                   uint64_t queueReadIndex, uint64_t extra = 0) {
    if (!traceEnabled()) return;
    const uint64_t idx = writeCursor().fetch_add(1, std::memory_order_relaxed) % kConsumerTraceCapacity;
    ConsumerTraceEntry& e = ring()[idx];
    e.tsNs = monotonicNs();
    e.sessionExecutionId = sessionExecutionId;
    e.queueWriteIndex = queueWriteIndex;
    e.queueReadIndex = queueReadIndex;
    e.extra = extra;
    e.extra2 = 0;
    e.threadId = currentThreadId();
    e.event = ev;
}

// Only call after a wait you've already measured exceeds your own threshold -- this function
// itself does no timing/branching beyond the ring append, so it's safe on the rare/slow path.
inline void traceWait(uint64_t sessionExecutionId, uint64_t waitStartNs, uint64_t waitEndNs,
                       uint32_t ownerThreadIdIfKnown) {
    if (!traceEnabled()) return;
    const uint64_t idx = waitWriteCursor().fetch_add(1, std::memory_order_relaxed) % kWaitTraceCapacity;
    ConsumerTraceEntry& e = waitRing()[idx];
    e.tsNs = waitStartNs;
    e.sessionExecutionId = sessionExecutionId;
    e.queueWriteIndex = 0;
    e.queueReadIndex = 0;
    e.extra = waitEndNs - waitStartNs; // duration ns
    e.extra2 = ownerThreadIdIfKnown;
    e.threadId = currentThreadId();
    e.event = ConsumerTraceEvent::WaitEnd;
}

// ---------------------------------------------------------------------------------------------
// Round 2 (terminal queue-pressure investigation): occupancy==32 alone is NOT the fatal event --
// two captured instances both recovered while actively cycling. The dump-on-first-32 trigger from
// round 1 is retired (see below); it fired on benign transient bursts and never on a real terminal
// window. This round tracks SUSTAINED pressure (occupancy>=28) with cheap, no-I/O bookkeeping, and
// only does real I/O (fprintf) at three low-cost checkpoints (mark/copy state, not full dump) plus
// the one real dump, which stays wired to the EXISTING test-level failure sites (TRAVOU NO
// MEIO/NAO INICIALIZOU in SessionRestartStressTest.cpp) -- that already satisfies "dump immediately
// on failure/QEMU host-error termination" without a second trigger mechanism here.
// ---------------------------------------------------------------------------------------------

constexpr uint64_t kPressureOccupancyThreshold = 28;

struct PressureState {
    std::atomic<uint64_t> startHostNs{0};   // 0 = not currently under pressure
    std::atomic<uint64_t> maxOccupancy{0};
    std::atomic<uint32_t> checkpointsFired{0}; // bit0=500ms bit1=1500ms bit2=2500ms
};
inline PressureState& pressureState() {
    static PressureState state{};
    return state;
}

// Lightweight checkpoint marker -- just a ring append via trace() (already O(1), no I/O), tagged
// with which threshold and the duration/occupancy observed. Call on every poll; internally only
// acts when occupancy>=28 and a not-yet-fired threshold is newly crossed.
inline void updatePressure(uint64_t occupancy, uint64_t nowHostNs, uint64_t sessionExecutionId,
                            uint64_t queueWriteIndex, uint64_t queueReadIndex) {
    if (!traceEnabled()) return;
    PressureState& ps = pressureState();
    if (occupancy < kPressureOccupancyThreshold) {
        // Reset -- this episode of pressure (if any) resolved without reaching a further
        // checkpoint; the next rise above threshold starts a fresh episode/timer.
        ps.startHostNs.store(0, std::memory_order_relaxed);
        ps.maxOccupancy.store(0, std::memory_order_relaxed);
        ps.checkpointsFired.store(0, std::memory_order_relaxed);
        return;
    }
    uint64_t start = ps.startHostNs.load(std::memory_order_relaxed);
    if (start == 0) {
        start = nowHostNs;
        ps.startHostNs.store(start, std::memory_order_relaxed);
        ps.maxOccupancy.store(occupancy, std::memory_order_relaxed);
        ps.checkpointsFired.store(0, std::memory_order_relaxed);
        return; // just entered pressure -- nothing to checkpoint yet
    }
    uint64_t prevMax = ps.maxOccupancy.load(std::memory_order_relaxed);
    if (occupancy > prevMax) ps.maxOccupancy.store(occupancy, std::memory_order_relaxed);
    const uint64_t durationNs = nowHostNs - start;
    static constexpr uint64_t kThresholdsNs[3] = {500'000'000ull, 1'500'000'000ull, 2'500'000'000ull};
    uint32_t fired = ps.checkpointsFired.load(std::memory_order_relaxed);
    for (int i = 0; i < 3; ++i) {
        const uint32_t bit = 1u << i;
        if ((fired & bit) != 0) continue;
        if (durationNs < kThresholdsNs[i]) continue;
        if ((ps.checkpointsFired.fetch_or(bit, std::memory_order_acq_rel) & bit) != 0) continue; // lost race
        // extra = durationNs (bottom 61 bits are plenty; encode checkpoint index in top bits is
        // unnecessary -- the event name plus this file's dump() timestamp math already disambiguate).
        trace(ConsumerTraceEvent::PressureCheckpoint, sessionExecutionId, queueWriteIndex, queueReadIndex,
              durationNs);
    }
}

// Tracks the specific queue HEAD entry (identified by its readIndex -- unchanged readIndex means
// it's the same undispatched entry) across repeated DeferredFuture observations, so we can report
// first/last-seen timestamps, repeat count, and its eventNs/opcode without re-deriving it from the
// raw D2/D6 stream by hand.
struct HeadBlockState {
    std::atomic<uint64_t> currentReadIndex{UINT64_MAX};
    std::atomic<uint64_t> firstSeenHostNs{0};
    std::atomic<uint64_t> lastSeenHostNs{0};
    std::atomic<uint64_t> repeatCount{0};
    std::atomic<uint64_t> eventNs{0};
    std::atomic<uint64_t> firstNowNs{0};  // round 7: nowNs at the FIRST observation of this head
    std::atomic<uint64_t> lastNowNs{0};
    std::atomic<uint32_t> opcode{0};
    // round 7 (blocking-head identity/audit): regAddr + owning module identity, captured once at
    // first-seen (regAddr never changes for a given queue entry). moduleKind mirrors
    // lasecsimul::ModuleKind's underlying values (Gpio=0..Pwm=8); 0xFFFFFFFF = no owning module
    // resolved (e.g. address not currently claimed by any QemuModule).
    std::atomic<uint64_t> regAddr{0};
    std::atomic<uint32_t> moduleKind{0xFFFFFFFFu};
    std::atomic<uint32_t> moduleIndex{0};
};
inline HeadBlockState& headBlockState() {
    static HeadBlockState state{};
    return state;
}

// round 7: full per-repeat lifecycle of the CURRENT head only -- auto-resets (cursor back to 0)
// whenever the head changes, so it always holds the complete repeat sequence of whichever entry is
// presently stuck (or was most recently stuck), never evicted by unrelated entries' traffic the
// way the shared DeferredFuture ring can be under high overall D2 volume.
struct HeadRepeatEntry {
    uint64_t repeatIndex = 0;
    uint64_t hostTsNs = 0;
    uint64_t nowNs = 0;
    uint64_t eventNs = 0;
    uint64_t occupancy = 0;
};
constexpr size_t kHeadRepeatCapacity = 4096; // far more than the ~195 repeats observed so far
inline std::array<HeadRepeatEntry, kHeadRepeatCapacity>& headRepeatRing() {
    static std::array<HeadRepeatEntry, kHeadRepeatCapacity> storage{};
    return storage;
}
inline std::atomic<uint64_t>& headRepeatCursor() {
    static std::atomic<uint64_t> cursor{0};
    return cursor;
}

// Call every time pollStepLocked() takes the DeferredFuture branch (head event's eventNs is still
// ahead of Scheduler::nowNs()). Also appends a full-detail entry to a small dedicated ring (nowNs,
// eventNs, delta, opcode, occupancy) -- separate from the main D0-D6 ring so this specific,
// causally-central data survives even if the main ring wraps under high D0-D6 traffic.
struct DeferredFutureEntry {
    uint64_t tsNs = 0;
    uint64_t nowNs = 0;
    uint64_t eventNs = 0;
    uint64_t deltaNs = 0; // eventNs - nowNs
    uint64_t occupancy = 0;
    uint64_t queueReadIndex = 0;
    uint64_t nextPendingEventNs = 0;
    uint32_t opcode = 0;
};
constexpr size_t kDeferredFutureCapacity = 4096;
inline std::array<DeferredFutureEntry, kDeferredFutureCapacity>& deferredFutureRing() {
    static std::array<DeferredFutureEntry, kDeferredFutureCapacity> storage{};
    return storage;
}
inline std::atomic<uint64_t>& deferredFutureCursor() {
    static std::atomic<uint64_t> cursor{0};
    return cursor;
}
inline void traceDeferredFuture(uint64_t nowNs, uint64_t eventNs, uint64_t occupancy,
                                 uint64_t queueReadIndex, uint64_t nextPendingEventNs, uint32_t opcode,
                                 uint64_t regAddr = 0, uint32_t moduleKind = 0xFFFFFFFFu, uint32_t moduleIndex = 0) {
    if (!traceEnabled()) return;
    const uint64_t hostNs = monotonicNs();
    const uint64_t idx = deferredFutureCursor().fetch_add(1, std::memory_order_relaxed) % kDeferredFutureCapacity;
    DeferredFutureEntry& e = deferredFutureRing()[idx];
    e.tsNs = hostNs;
    e.nowNs = nowNs;
    e.eventNs = eventNs;
    e.deltaNs = eventNs > nowNs ? eventNs - nowNs : 0;
    e.occupancy = occupancy;
    e.queueReadIndex = queueReadIndex;
    e.nextPendingEventNs = nextPendingEventNs;
    e.opcode = opcode;

    // Same-head tracking, all under the caller's existing CallbackState::mutex (pollStepLocked's
    // documented precondition) -- no compound-update race despite plain sequential atomic stores.
    HeadBlockState& hb = headBlockState();
    uint64_t repeatIndex;
    if (hb.currentReadIndex.load(std::memory_order_relaxed) != queueReadIndex) {
        hb.currentReadIndex.store(queueReadIndex, std::memory_order_relaxed);
        hb.firstSeenHostNs.store(hostNs, std::memory_order_relaxed);
        hb.repeatCount.store(1, std::memory_order_relaxed);
        hb.eventNs.store(eventNs, std::memory_order_relaxed);
        hb.firstNowNs.store(nowNs, std::memory_order_relaxed);
        hb.opcode.store(opcode, std::memory_order_relaxed);
        hb.regAddr.store(regAddr, std::memory_order_relaxed);
        hb.moduleKind.store(moduleKind, std::memory_order_relaxed);
        hb.moduleIndex.store(moduleIndex, std::memory_order_relaxed);
        repeatIndex = 0;
        headRepeatCursor().store(0, std::memory_order_relaxed); // new head -- restart the lifecycle ring
    } else {
        repeatIndex = hb.repeatCount.fetch_add(1, std::memory_order_relaxed);
    }
    hb.lastSeenHostNs.store(hostNs, std::memory_order_relaxed);
    hb.lastNowNs.store(nowNs, std::memory_order_relaxed);

    if (repeatIndex < kHeadRepeatCapacity) {
        HeadRepeatEntry& re = headRepeatRing()[repeatIndex];
        re.repeatIndex = repeatIndex;
        re.hostTsNs = hostNs;
        re.nowNs = nowNs;
        re.eventNs = eventNs;
        re.occupancy = occupancy;
        headRepeatCursor().store(repeatIndex + 1, std::memory_order_relaxed);
    }
}

// TEMPORARY (round 2): a pre-existing, still-OPEN/SECONDARY crash (exit code 3, not investigated
// per instruction) has repeatedly cut the stderr-piped dump off after only a handful of lines,
// regardless of what's printed first -- consistent with something timing/event-based unrelated to
// print content, not something reorder alone can dodge. This one-time-per-process, synchronous
// file write (opened, written, closed immediately -- never held open, no per-checkpoint use, only
// called from the same place dump() already is) is a more crash-resistant persistence path: a
// small local file write completes far faster than growing a piped, cross-process stderr capture,
// so it's more likely to land before whatever the secondary crash's trigger is. Path overridable
// via LASECSIMUL_MCU_CONSUMER_TRACE_FILE; defaults next to the working directory.
inline void dumpToFile(size_t maxEntries = 300);
inline void dumpSchedulerIterations(std::FILE* out, size_t maxEntries = 2000);
inline void dumpSettleCalls(std::FILE* out, size_t maxEntries = 4000);
inline void dumpSettleStepPhases(std::FILE* out, size_t maxEntries = 4000);
inline void dumpComponentStamps(std::FILE* out, size_t maxEntries = 20000);
inline void dumpSolverGroups(std::FILE* out, size_t maxEntries = 4000);
inline void dumpMnaSolverOuter(std::FILE* out, size_t maxEntries = 4000);
inline void dumpNextTimeLimiterStats(std::FILE* out);
inline void dumpHeadRepeats(std::FILE* out);
inline void dumpAddressWatchDetailed(std::FILE* out);
inline void dumpBacklogHorizon(std::FILE* out);

// Dumps the last `maxEntries` D0-D6 events (chronological) plus every recorded wait-threshold
// violation, to `out`. Intended to be called ONLY on queue-full/termination/test-failure -- never
// per-operation. fprintf to an already-open stderr is the only I/O here (no fopen/flush-to-disk
// beyond what fprintf/stderr already does unbuffered).
inline void dump(std::FILE* out, size_t maxEntries = 50) {
    if (!traceEnabled()) {
        std::fprintf(out, "[ConsumerTrace] LASECSIMUL_MCU_CONSUMER_TRACE not enabled -- no trace captured\n");
        return;
    }
    const uint64_t total = writeCursor().load(std::memory_order_relaxed);
    const uint64_t count = total < kConsumerTraceCapacity ? total : kConsumerTraceCapacity;
    const uint64_t take = count < maxEntries ? count : maxEntries;
    const uint64_t startOrdinal = total - take;
    std::fprintf(out, "[ConsumerTrace] === last %llu D0-D6 events (of %llu total recorded) ===\n",
                 static_cast<unsigned long long>(take), static_cast<unsigned long long>(total));
    for (uint64_t ord = startOrdinal; ord < total; ++ord) {
        const ConsumerTraceEntry& e = ring()[ord % kConsumerTraceCapacity];
        std::fprintf(out,
            "  [%llu] ts=%llu tid=%u execId=%llu ev=%-20s qW=%llu qR=%llu occ=%llu extra=0x%llx\n",
            static_cast<unsigned long long>(ord), static_cast<unsigned long long>(e.tsNs), e.threadId,
            static_cast<unsigned long long>(e.sessionExecutionId), eventName(e.event),
            static_cast<unsigned long long>(e.queueWriteIndex), static_cast<unsigned long long>(e.queueReadIndex),
            static_cast<unsigned long long>(e.queueWriteIndex - e.queueReadIndex),
            static_cast<unsigned long long>(e.extra));
    }
    const uint64_t waitTotal = waitWriteCursor().load(std::memory_order_relaxed);
    const uint64_t waitCount = waitTotal < kWaitTraceCapacity ? waitTotal : kWaitTraceCapacity;
    std::fprintf(out, "[ConsumerTrace] === %llu wait-threshold-violation events (of %llu total recorded) ===\n",
                 static_cast<unsigned long long>(waitCount), static_cast<unsigned long long>(waitTotal));
    const uint64_t waitStart = waitTotal - waitCount;
    for (uint64_t ord = waitStart; ord < waitTotal; ++ord) {
        const ConsumerTraceEntry& e = waitRing()[ord % kWaitTraceCapacity];
        std::fprintf(out,
            "  [wait %llu] start=%llu tid=%u execId=%llu durationNs=%llu ownerTidIfKnown=%llu\n",
            static_cast<unsigned long long>(ord), static_cast<unsigned long long>(e.tsNs), e.threadId,
            static_cast<unsigned long long>(e.sessionExecutionId), static_cast<unsigned long long>(e.extra),
            static_cast<unsigned long long>(e.extra2));
    }
    const uint64_t dfTotal = deferredFutureCursor().load(std::memory_order_relaxed);
    const uint64_t dfCount = dfTotal < kDeferredFutureCapacity ? dfTotal : kDeferredFutureCapacity;
    const uint64_t dfTake = dfCount < 300 ? dfCount : 300;
    const uint64_t dfStart = dfTotal - dfTake;
    std::fprintf(out, "[ConsumerTrace] === last %llu DeferredFuture events (of %llu total recorded) ===\n",
                 static_cast<unsigned long long>(dfTake), static_cast<unsigned long long>(dfTotal));
    for (uint64_t ord = dfStart; ord < dfTotal; ++ord) {
        const DeferredFutureEntry& e = deferredFutureRing()[ord % kDeferredFutureCapacity];
        std::fprintf(out,
            "  [df %llu] ts=%llu nowNs=%llu eventNs=%llu deltaNs=%llu occ=%llu qR=%llu"
            " nextPendingEventNs=%llu opcode=0x%x\n",
            static_cast<unsigned long long>(ord), static_cast<unsigned long long>(e.tsNs),
            static_cast<unsigned long long>(e.nowNs), static_cast<unsigned long long>(e.eventNs),
            static_cast<unsigned long long>(e.deltaNs), static_cast<unsigned long long>(e.occupancy),
            static_cast<unsigned long long>(e.queueReadIndex),
            static_cast<unsigned long long>(e.nextPendingEventNs), e.opcode);
    }

    const HeadBlockState& hb = headBlockState();
    const uint64_t hbFirst = hb.firstSeenHostNs.load(std::memory_order_relaxed);
    const uint64_t hbLast = hb.lastSeenHostNs.load(std::memory_order_relaxed);
    std::fprintf(out,
        "[ConsumerTrace] === current blocked-head state ===\n"
        "  queueReadIndex=%llu firstSeenHostNs=%llu lastSeenHostNs=%llu spanNs=%llu"
        " repeatCount=%llu eventNs=%llu firstNowNs=%llu lastNowNs=%llu"
        " gapAtFirst=%lld gapAtLast=%lld opcode=0x%x regAddr=0x%llx moduleKind=%u moduleIndex=%u\n",
        static_cast<unsigned long long>(hb.currentReadIndex.load(std::memory_order_relaxed)),
        static_cast<unsigned long long>(hbFirst), static_cast<unsigned long long>(hbLast),
        static_cast<unsigned long long>(hbLast >= hbFirst ? hbLast - hbFirst : 0),
        static_cast<unsigned long long>(hb.repeatCount.load(std::memory_order_relaxed)),
        static_cast<unsigned long long>(hb.eventNs.load(std::memory_order_relaxed)),
        static_cast<unsigned long long>(hb.firstNowNs.load(std::memory_order_relaxed)),
        static_cast<unsigned long long>(hb.lastNowNs.load(std::memory_order_relaxed)),
        static_cast<long long>(hb.eventNs.load(std::memory_order_relaxed)) - static_cast<long long>(hb.firstNowNs.load(std::memory_order_relaxed)),
        static_cast<long long>(hb.eventNs.load(std::memory_order_relaxed)) - static_cast<long long>(hb.lastNowNs.load(std::memory_order_relaxed)),
        hb.opcode.load(std::memory_order_relaxed),
        static_cast<unsigned long long>(hb.regAddr.load(std::memory_order_relaxed)),
        hb.moduleKind.load(std::memory_order_relaxed), hb.moduleIndex.load(std::memory_order_relaxed));

    const PressureState& ps = pressureState();
    std::fprintf(out,
        "[ConsumerTrace] === current pressure state (occupancy>=%llu) ===\n"
        "  startHostNs=%llu maxOccupancy=%llu checkpointsFired=0x%x\n",
        static_cast<unsigned long long>(kPressureOccupancyThreshold),
        static_cast<unsigned long long>(ps.startHostNs.load(std::memory_order_relaxed)),
        static_cast<unsigned long long>(ps.maxOccupancy.load(std::memory_order_relaxed)),
        ps.checkpointsFired.load(std::memory_order_relaxed));

    std::fflush(out);
}

inline void dumpToFile(size_t maxEntries) {
    if (!traceEnabled()) return;
    const char* path = std::getenv("LASECSIMUL_MCU_CONSUMER_TRACE_FILE");
    const std::string resolvedPath = (path && *path) ? path : "consumer_trace_dump.txt";
    std::FILE* f = std::fopen(resolvedPath.c_str(), "w");
    if (!f) return; // best-effort -- never let a diagnostic failure affect the caller
    dump(f, maxEntries);
    dumpSchedulerIterations(f, /*maxEntries=*/2000);
    dumpSettleCalls(f, /*maxEntries=*/4000);
    dumpSettleStepPhases(f, /*maxEntries=*/4000);
    dumpComponentStamps(f, /*maxEntries=*/20000);
    dumpSolverGroups(f, /*maxEntries=*/4000);
    dumpMnaSolverOuter(f, /*maxEntries=*/4000);
    dumpHeadRepeats(f);
    dumpAddressWatchDetailed(f);
    dumpBacklogHorizon(f);
    dumpNextTimeLimiterStats(f);
    std::fclose(f);
}

// ---------------------------------------------------------------------------------------------
// Round 3 (settle-cost / adaptive-timestep investigation): round 2 confirmed the queue-saturation
// MECHANISM (Scheduler::nowNs() advancement collapses to ~1/1300-1/1800 of real time for a
// sustained multi-second window). This round instruments Scheduler::runUntil()'s own per-iteration
// state to find out WHY that collapse happens -- timestep shrinkage (S1), settle-call cost blowup
// (S2), both (S3), or neither (S4). Same opt-in gate (LASECSIMUL_MCU_CONSUMER_TRACE), same
// ring-buffer/no-per-op-I/O discipline. Correlate with round 2's arena-pressure data by host
// timestamp (both use monotonicNs() from the same steady_clock) rather than coupling Scheduler to
// arena/MCU internals directly.
// ---------------------------------------------------------------------------------------------

struct SchedulerIterEntry {
    uint64_t hostTsNs = 0;
    uint64_t nowNsBefore = 0;
    uint64_t nowNsAfter = 0;
    uint64_t currentTimeStepNs = 0;   // m_currentTimeStepNs at the START of this iteration
    uint64_t maximumTimeStepNs = 0;   // m_maximumTimeStepNs (configured ceiling)
    uint64_t targetTimeNs = 0;        // this runUntil() call's overall target
    uint64_t nextTime = 0;            // this iteration's chosen nextTime (event/step/target, whichever nearest)
    uint64_t settleDurationNs = 0;    // wall time spent in settleUntilStableLocked() calls this iteration (summed)
    uint64_t settleIterationsDelta = 0; // m_settleIterations delta this iteration (proxy for per-call iter count)
    double errorRatio = 0.0;          // TimeStepDecision::errorRatio, if a commit callback exists
    uint8_t settleConverged = 0;      // m_lastSettleConverged after this iteration's settle(s)
    uint8_t commitAccepted = 1;       // TimeStepDecision::accept; 1 (unchanged) if no commit callback registered
    uint8_t hasCommitCallback = 0;    // whether m_commitTimeStep is even set (FPGA/GHDL lockstep only)
    uint8_t eventBoundary = 0;        // whether nextTime landed exactly on a scheduled event
};

constexpr size_t kSchedulerIterCapacity = 8192;
inline std::array<SchedulerIterEntry, kSchedulerIterCapacity>& schedulerIterRing() {
    static std::array<SchedulerIterEntry, kSchedulerIterCapacity> storage{};
    return storage;
}
inline std::atomic<uint64_t>& schedulerIterCursor() {
    static std::atomic<uint64_t> cursor{0};
    return cursor;
}
inline void traceSchedulerIter(const SchedulerIterEntry& partial) {
    if (!traceEnabled()) return;
    const uint64_t idx = schedulerIterCursor().fetch_add(1, std::memory_order_relaxed) % kSchedulerIterCapacity;
    SchedulerIterEntry& e = schedulerIterRing()[idx];
    e = partial;
    e.hostTsNs = monotonicNs();
}

inline void dumpSchedulerIterations(std::FILE* out, size_t maxEntries) {
    const uint64_t total = schedulerIterCursor().load(std::memory_order_relaxed);
    const uint64_t count = total < kSchedulerIterCapacity ? total : kSchedulerIterCapacity;
    const uint64_t take = count < maxEntries ? count : maxEntries;
    const uint64_t start = total - take;
    std::fprintf(out, "[ConsumerTrace] === last %llu Scheduler::runUntil() iterations (of %llu total recorded) ===\n",
                 static_cast<unsigned long long>(take), static_cast<unsigned long long>(total));
    for (uint64_t ord = start; ord < total; ++ord) {
        const SchedulerIterEntry& e = schedulerIterRing()[ord % kSchedulerIterCapacity];
        std::fprintf(out,
            "  [si %llu] ts=%llu nowNs=%llu->%llu step=%llu maxStep=%llu target=%llu next=%llu"
            " settleNs=%llu settleIters=%llu conv=%u accept=%u hasCommit=%u errRatio=%.6f evtBoundary=%u\n",
            static_cast<unsigned long long>(ord), static_cast<unsigned long long>(e.hostTsNs),
            static_cast<unsigned long long>(e.nowNsBefore), static_cast<unsigned long long>(e.nowNsAfter),
            static_cast<unsigned long long>(e.currentTimeStepNs), static_cast<unsigned long long>(e.maximumTimeStepNs),
            static_cast<unsigned long long>(e.targetTimeNs), static_cast<unsigned long long>(e.nextTime),
            static_cast<unsigned long long>(e.settleDurationNs), static_cast<unsigned long long>(e.settleIterationsDelta),
            e.settleConverged, e.commitAccepted, e.hasCommitCallback, e.errorRatio, e.eventBoundary);
    }
    std::fflush(out);
}

// ---------------------------------------------------------------------------------------------
// Round 4 (CPU-cost vs. wall-clock starvation): round 3 confirmed S2 (settle cost explosion,
// bimodal: settleIters=0 near-instant, settleIters=2 costs ~1.2-2.6ms wall) but could not tell
// whether that wall-clock cost is genuine solver CPU work (H1) or the thread being descheduled
// while doing almost no work (H2/starvation). This round adds per-settle-call CURRENT-THREAD CPU
// time (GetThreadTimes on the pseudo-handle for the calling thread, never another thread) next to
// the wall-clock measurement already taken -- no sampling thread, no ETW, same
// LASECSIMUL_MCU_CONSUMER_TRACE=1 gate, same ring-buffer/no-per-op-I/O discipline.
// ---------------------------------------------------------------------------------------------

#ifdef _WIN32
// FIRST ATTEMPT (kept only as a comment, not used): GetThreadTimes() -- discovered empirically to
// be quantized to Windows' system clock tick (~15.625ms, confirmed by observing thread-CPU deltas
// landing on EXACTLY 0 or EXACTLY 15,625,000ns, nothing between), which is coarser than the
// 1.2-2.6ms settle durations this round needs to resolve -- unusable for this measurement, not a
// finding about the settle calls themselves. QueryThreadCycleTime() (still a single direct WinAPI
// call on the calling thread's own pseudo-handle -- not a sampling thread, not ETW) reports actual
// CPU cycles consumed, with far finer resolution. Converted to an ns-equivalent via a one-time
// calibration (busy-spin ~5ms measuring both steady_clock and cycle count) -- an estimate (CPU
// frequency can vary under turbo/throttling) but far better than the ~15ms floor above, and only
// deltas are used by callers, so the calibration's absolute-origin imprecision cancels out.
inline double cyclesPerNs() {
    static const double ratio = [] {
        ULONG64 c0 = 0;
        QueryThreadCycleTime(GetCurrentThread(), &c0);
        const auto t0 = std::chrono::steady_clock::now();
        volatile uint64_t sink = 0;
        while (std::chrono::steady_clock::now() - t0 < std::chrono::milliseconds(5)) { ++sink; }
        ULONG64 c1 = 0;
        QueryThreadCycleTime(GetCurrentThread(), &c1);
        const auto t1 = std::chrono::steady_clock::now();
        const uint64_t dNs = static_cast<uint64_t>(
            std::chrono::duration_cast<std::chrono::nanoseconds>(t1 - t0).count());
        const uint64_t dCycles = c1 - c0;
        return (dNs > 0 && dCycles > 0) ? static_cast<double>(dCycles) / static_cast<double>(dNs) : 1.0;
    }();
    return ratio;
}
// Sum of kernel+user CPU cycles for the CALLING thread only, converted to an ns-equivalent via the
// one-time calibration above. Monotonically increasing since thread start -- callers take deltas.
inline uint64_t currentThreadCpuTimeNs() {
    ULONG64 cycles = 0;
    if (!QueryThreadCycleTime(GetCurrentThread(), &cycles)) return 0;
    const double cpn = cyclesPerNs();
    return cpn > 0.0 ? static_cast<uint64_t>(static_cast<double>(cycles) / cpn) : 0;
}
inline uint64_t currentProcessCpuTimeNs() {
    FILETIME creation{}, exit{}, kernel{}, user{};
    if (!GetProcessTimes(GetCurrentProcess(), &creation, &exit, &kernel, &user)) return 0;
    const uint64_t kernel100ns = (static_cast<uint64_t>(kernel.dwHighDateTime) << 32) | kernel.dwLowDateTime;
    const uint64_t user100ns = (static_cast<uint64_t>(user.dwHighDateTime) << 32) | user.dwLowDateTime;
    return (kernel100ns + user100ns) * 100;
}
inline uint32_t logicalCpuCount() {
    SYSTEM_INFO info{};
    GetSystemInfo(&info);
    return info.dwNumberOfProcessors;
}
#else
inline uint64_t currentThreadCpuTimeNs() { return 0; }
inline uint64_t currentProcessCpuTimeNs() { return 0; }
inline uint32_t logicalCpuCount() { return 0; }
#endif

struct SettleCallEntry {
    uint64_t hostTsNs = 0;
    uint64_t wallDurationNs = 0;
    uint64_t threadCpuDurationNs = 0;
    uint64_t nowNsBefore = 0;
    uint64_t nowNsAfter = 0;
    uint64_t timestepAtCall = 0;
    uint64_t settleIterationsDelta = 0;
};

constexpr size_t kSettleCallCapacity = 8192;
inline std::array<SettleCallEntry, kSettleCallCapacity>& settleCallRing() {
    static std::array<SettleCallEntry, kSettleCallCapacity> storage{};
    return storage;
}
inline std::atomic<uint64_t>& settleCallCursor() {
    static std::atomic<uint64_t> cursor{0};
    return cursor;
}
inline void traceSettleCall(SettleCallEntry entry) {
    if (!traceEnabled()) return;
    entry.hostTsNs = monotonicNs();
    const uint64_t idx = settleCallCursor().fetch_add(1, std::memory_order_relaxed) % kSettleCallCapacity;
    settleCallRing()[idx] = entry;
}

inline void dumpSettleCalls(std::FILE* out, size_t maxEntries) {
    const uint64_t total = settleCallCursor().load(std::memory_order_relaxed);
    const uint64_t count = total < kSettleCallCapacity ? total : kSettleCallCapacity;
    const uint64_t take = count < maxEntries ? count : maxEntries;
    const uint64_t start = total - take;
    std::fprintf(out, "[ConsumerTrace] === last %llu settleUntilStableLocked() calls (of %llu total recorded) ===\n",
                 static_cast<unsigned long long>(take), static_cast<unsigned long long>(total));
    for (uint64_t ord = start; ord < total; ++ord) {
        const SettleCallEntry& e = settleCallRing()[ord % kSettleCallCapacity];
        const int64_t offCpuNs = static_cast<int64_t>(e.wallDurationNs) - static_cast<int64_t>(e.threadCpuDurationNs);
        const double cpuShare = e.wallDurationNs > 0
            ? static_cast<double>(e.threadCpuDurationNs) / static_cast<double>(e.wallDurationNs) : 0.0;
        std::fprintf(out,
            "  [sc %llu] ts=%llu wallNs=%llu cpuNs=%llu offCpuNs=%lld cpuShare=%.4f"
            " nowNs=%llu->%llu step=%llu settleIters=%llu\n",
            static_cast<unsigned long long>(ord), static_cast<unsigned long long>(e.hostTsNs),
            static_cast<unsigned long long>(e.wallDurationNs), static_cast<unsigned long long>(e.threadCpuDurationNs),
            static_cast<long long>(offCpuNs), cpuShare,
            static_cast<unsigned long long>(e.nowNsBefore), static_cast<unsigned long long>(e.nowNsAfter),
            static_cast<unsigned long long>(e.timestepAtCall), static_cast<unsigned long long>(e.settleIterationsDelta));
    }
    const uint64_t processCpuNs = currentProcessCpuTimeNs();
    const uint32_t cpuCount = logicalCpuCount();
    std::fprintf(out,
        "[ConsumerTrace] === host context at dump time ===\n"
        "  coreProcessCpuTimeNs=%llu logicalCpuCount=%u"
        " (QEMU process CPU not captured -- no existing accessor to its process handle from this"
        " TU without adding new coupling, out of scope this round)\n",
        static_cast<unsigned long long>(processCpuNs), cpuCount);
    std::fflush(out);
}

// ---------------------------------------------------------------------------------------------
// Round 5 (internal settle-cost attribution): round 4 confirmed H1 (settleIters=2 costs ~2ms of
// genuine CPU, not scheduling starvation). This round decomposes THAT cost by phase, following the
// real call chain: Scheduler::settleUntilStableLocked() -> SimulationSession::settleStep() ->
// {rebuildTopologyIfNeeded, the component-stamping loop, MnaSolver::solve() (itself ->
// CircuitGroup::factor()/solve()), the voltage-change/digital-edge propagation loop, the
// nonlinear-convergence check}. Same QueryThreadCycleTime()-based CPU timing validated in round 4,
// same bounded-ring/no-per-op-I/O discipline, same opt-in gate.
// ---------------------------------------------------------------------------------------------

inline std::atomic<uint64_t>& settleStepSequence() {
    static std::atomic<uint64_t> seq{0};
    return seq;
}
inline uint64_t nextSettleStepSequence() { return settleStepSequence().fetch_add(1, std::memory_order_relaxed); }

struct SettleStepPhaseEntry {
    uint64_t hostTsNs = 0;
    uint64_t settleStepSeq = 0;
    uint64_t totalCpuNs = 0;
    uint64_t topologyCpuNs = 0;      // rebuildTopologyIfNeeded()+rebuildSignalRoutesIfNeeded()
    uint64_t stampingCpuNs = 0;      // the component->stamp() loop (all components this round, summed)
    uint64_t stampedComponentCount = 0;
    uint64_t mnaSolveCpuNs = 0;      // m_mnaSolver.solve(...) as a whole (see SolverGroupEntry for factor/solve split)
    uint64_t propagationCpuNs = 0;   // voltage-change listener loop + digital-edge onEvent() loop
    uint64_t convergenceCpuNs = 0;   // nonlinear-convergence check loop
    uint64_t miscCpuNs = 0;          // dirtySet bookkeeping, everything not in the phases above
};
constexpr size_t kSettleStepPhaseCapacity = 8192;
inline std::array<SettleStepPhaseEntry, kSettleStepPhaseCapacity>& settleStepPhaseRing() {
    static std::array<SettleStepPhaseEntry, kSettleStepPhaseCapacity> storage{};
    return storage;
}
inline std::atomic<uint64_t>& settleStepPhaseCursor() {
    static std::atomic<uint64_t> cursor{0};
    return cursor;
}
inline void traceSettleStepPhase(SettleStepPhaseEntry entry) {
    if (!traceEnabled()) return;
    entry.hostTsNs = monotonicNs();
    const uint64_t idx = settleStepPhaseCursor().fetch_add(1, std::memory_order_relaxed) % kSettleStepPhaseCapacity;
    settleStepPhaseRing()[idx] = entry;
}

struct ComponentStampEntry {
    uint64_t settleStepSeq = 0;
    uint32_t componentIndex = 0;
    uint64_t cpuNs = 0;
};
constexpr size_t kComponentStampCapacity = 65536;
inline std::array<ComponentStampEntry, kComponentStampCapacity>& componentStampRing() {
    static std::array<ComponentStampEntry, kComponentStampCapacity> storage{};
    return storage;
}
inline std::atomic<uint64_t>& componentStampCursor() {
    static std::atomic<uint64_t> cursor{0};
    return cursor;
}
inline void traceComponentStamp(uint64_t settleStepSeq, uint32_t componentIndex, uint64_t cpuNs) {
    if (!traceEnabled()) return;
    const uint64_t idx = componentStampCursor().fetch_add(1, std::memory_order_relaxed) % kComponentStampCapacity;
    componentStampRing()[idx] = ComponentStampEntry{settleStepSeq, componentIndex, cpuNs};
}

struct SolverGroupEntry {
    uint64_t settleStepSeq = 0;
    uint64_t matrixDimension = 0;    // CircuitGroup::totalSize()
    uint8_t admittanceChangedBeforeFactor = 0; // whether factor() actually ran this call
    uint64_t factorCpuNs = 0;
    uint64_t solveCpuNs = 0;
};
constexpr size_t kSolverGroupCapacity = 8192;
inline std::array<SolverGroupEntry, kSolverGroupCapacity>& solverGroupRing() {
    static std::array<SolverGroupEntry, kSolverGroupCapacity> storage{};
    return storage;
}
inline std::atomic<uint64_t>& solverGroupCursor() {
    static std::atomic<uint64_t> cursor{0};
    return cursor;
}
inline void traceSolverGroup(const SolverGroupEntry& entry) {
    if (!traceEnabled()) return;
    const uint64_t idx = solverGroupCursor().fetch_add(1, std::memory_order_relaxed) % kSolverGroupCapacity;
    solverGroupRing()[idx] = entry;
}

inline void dumpSettleStepPhases(std::FILE* out, size_t maxEntries) {
    const uint64_t total = settleStepPhaseCursor().load(std::memory_order_relaxed);
    const uint64_t count = total < kSettleStepPhaseCapacity ? total : kSettleStepPhaseCapacity;
    const uint64_t take = count < maxEntries ? count : maxEntries;
    const uint64_t start = total - take;
    std::fprintf(out, "[ConsumerTrace] === last %llu settleStep() phase breakdowns (of %llu total recorded) ===\n",
                 static_cast<unsigned long long>(take), static_cast<unsigned long long>(total));
    for (uint64_t ord = start; ord < total; ++ord) {
        const SettleStepPhaseEntry& e = settleStepPhaseRing()[ord % kSettleStepPhaseCapacity];
        std::fprintf(out,
            "  [ph %llu] seq=%llu ts=%llu total=%llu topology=%llu stamping=%llu(n=%llu)"
            " mnaSolve=%llu propagation=%llu convergence=%llu misc=%llu\n",
            static_cast<unsigned long long>(ord), static_cast<unsigned long long>(e.settleStepSeq),
            static_cast<unsigned long long>(e.hostTsNs), static_cast<unsigned long long>(e.totalCpuNs),
            static_cast<unsigned long long>(e.topologyCpuNs), static_cast<unsigned long long>(e.stampingCpuNs),
            static_cast<unsigned long long>(e.stampedComponentCount), static_cast<unsigned long long>(e.mnaSolveCpuNs),
            static_cast<unsigned long long>(e.propagationCpuNs), static_cast<unsigned long long>(e.convergenceCpuNs),
            static_cast<unsigned long long>(e.miscCpuNs));
    }
    std::fflush(out);
}

inline void dumpComponentStamps(std::FILE* out, size_t maxEntries) {
    const uint64_t total = componentStampCursor().load(std::memory_order_relaxed);
    const uint64_t count = total < kComponentStampCapacity ? total : kComponentStampCapacity;
    const uint64_t take = count < maxEntries ? count : maxEntries;
    const uint64_t start = total - take;
    std::fprintf(out, "[ConsumerTrace] === last %llu component stamp() calls (of %llu total recorded) ===\n",
                 static_cast<unsigned long long>(take), static_cast<unsigned long long>(total));
    for (uint64_t ord = start; ord < total; ++ord) {
        const ComponentStampEntry& e = componentStampRing()[ord % kComponentStampCapacity];
        std::fprintf(out, "  [cs %llu] seq=%llu componentIndex=%u cpuNs=%llu\n",
            static_cast<unsigned long long>(ord), static_cast<unsigned long long>(e.settleStepSeq),
            e.componentIndex, static_cast<unsigned long long>(e.cpuNs));
    }
    std::fflush(out);
}

// TEMPORARY (round 5b): the settleStep-level mnaSolveCpuNs (whole m_mnaSolver.solve() call) and
// the per-group factor+solve CPU (SolverGroupEntry) disagreed by roughly 20-25x in the first pass
// of this round's data -- factor/solve themselves are cheap, so the gap must be in MnaSolver::
// solve()'s own surrounding code (building the dirty-group list, the resource-governor parallel-
// dispatch decision, or the dispatch mechanism itself). This captures those outer phases
// separately to localize it precisely instead of leaving "mnaSolve" as one unresolved lump.
struct MnaSolverOuterEntry {
    uint64_t settleStepSeq = 0;
    uint64_t groupsTotal = 0;
    uint64_t dirtyGroupsCount = 0;
    uint64_t setupCpuNs = 0;           // building m_dirtyGroups + estimatedWork
    uint64_t grantDecisionCpuNs = 0;   // m_governor.grantParallelTasks(...)
    uint8_t usesWorkers = 0;
    uint64_t dispatchCpuNs = 0;        // parallelFor(...) or the sequential for-loop, whichever ran
};
constexpr size_t kMnaSolverOuterCapacity = 8192;
inline std::array<MnaSolverOuterEntry, kMnaSolverOuterCapacity>& mnaSolverOuterRing() {
    static std::array<MnaSolverOuterEntry, kMnaSolverOuterCapacity> storage{};
    return storage;
}
inline std::atomic<uint64_t>& mnaSolverOuterCursor() {
    static std::atomic<uint64_t> cursor{0};
    return cursor;
}
inline void traceMnaSolverOuter(const MnaSolverOuterEntry& entry) {
    if (!traceEnabled()) return;
    const uint64_t idx = mnaSolverOuterCursor().fetch_add(1, std::memory_order_relaxed) % kMnaSolverOuterCapacity;
    mnaSolverOuterRing()[idx] = entry;
}
inline void dumpMnaSolverOuter(std::FILE* out, size_t maxEntries) {
    const uint64_t total = mnaSolverOuterCursor().load(std::memory_order_relaxed);
    const uint64_t count = total < kMnaSolverOuterCapacity ? total : kMnaSolverOuterCapacity;
    const uint64_t take = count < maxEntries ? count : maxEntries;
    const uint64_t start = total - take;
    std::fprintf(out, "[ConsumerTrace] === last %llu MnaSolver::solve() outer phases (of %llu total recorded) ===\n",
                 static_cast<unsigned long long>(take), static_cast<unsigned long long>(total));
    for (uint64_t ord = start; ord < total; ++ord) {
        const MnaSolverOuterEntry& e = mnaSolverOuterRing()[ord % kMnaSolverOuterCapacity];
        std::fprintf(out,
            "  [mo %llu] seq=%llu groupsTotal=%llu dirty=%llu setupCpuNs=%llu grantDecisionCpuNs=%llu"
            " usesWorkers=%u dispatchCpuNs=%llu\n",
            static_cast<unsigned long long>(ord), static_cast<unsigned long long>(e.settleStepSeq),
            static_cast<unsigned long long>(e.groupsTotal), static_cast<unsigned long long>(e.dirtyGroupsCount),
            static_cast<unsigned long long>(e.setupCpuNs), static_cast<unsigned long long>(e.grantDecisionCpuNs),
            e.usesWorkers, static_cast<unsigned long long>(e.dispatchCpuNs));
    }
    std::fflush(out);
}

inline void dumpSolverGroups(std::FILE* out, size_t maxEntries) {
    const uint64_t total = solverGroupCursor().load(std::memory_order_relaxed);
    const uint64_t count = total < kSolverGroupCapacity ? total : kSolverGroupCapacity;
    const uint64_t take = count < maxEntries ? count : maxEntries;
    const uint64_t start = total - take;
    std::fprintf(out, "[ConsumerTrace] === last %llu MNA solver group solves (of %llu total recorded) ===\n",
                 static_cast<unsigned long long>(take), static_cast<unsigned long long>(total));
    for (uint64_t ord = start; ord < total; ++ord) {
        const SolverGroupEntry& e = solverGroupRing()[ord % kSolverGroupCapacity];
        std::fprintf(out, "  [sg %llu] seq=%llu dim=%llu admittanceChanged=%u factorCpuNs=%llu solveCpuNs=%llu\n",
            static_cast<unsigned long long>(ord), static_cast<unsigned long long>(e.settleStepSeq),
            static_cast<unsigned long long>(e.matrixDimension), e.admittanceChangedBeforeFactor,
            static_cast<unsigned long long>(e.factorCpuNs), static_cast<unsigned long long>(e.solveCpuNs));
    }
    std::fflush(out);
}

inline void dumpHeadRepeats(std::FILE* out) {
    const uint64_t total = headRepeatCursor().load(std::memory_order_relaxed);
    const uint64_t count = total < kHeadRepeatCapacity ? total : kHeadRepeatCapacity;
    std::fprintf(out, "[ConsumerTrace] === full repeat lifecycle of current/most-recent head (%llu entries) ===\n",
                 static_cast<unsigned long long>(count));
    for (uint64_t i = 0; i < count; ++i) {
        const HeadRepeatEntry& e = headRepeatRing()[i];
        std::fprintf(out, "  [hr %llu] hostTsNs=%llu nowNs=%llu eventNs=%llu gapNs=%lld occ=%llu\n",
            static_cast<unsigned long long>(e.repeatIndex), static_cast<unsigned long long>(e.hostTsNs),
            static_cast<unsigned long long>(e.nowNs), static_cast<unsigned long long>(e.eventNs),
            static_cast<long long>(e.eventNs) - static_cast<long long>(e.nowNs),
            static_cast<unsigned long long>(e.occupancy));
    }
    std::fflush(out);
}

// ---------------------------------------------------------------------------------------------
// Round 8 (healthy-vs-terminal baseline for the I2C0 0x3ff53058 write): per-cycle-reset, bounded
// rings -- no per-event textual dump on healthy cycles, only aggregate stats computed on demand.
// Hardcoded to the one address round 7 identified as the terminal blocking entry; this is a
// targeted, temporary probe, not a general facility.
// ---------------------------------------------------------------------------------------------

constexpr uint64_t kWatchedRegAddr = 0x3ff53058ull;

struct AddressWatchEntry {
    uint64_t seq = 0;
    uint64_t eventNs = 0;
    uint64_t nowNs = 0;
    uint64_t gapNs = 0; // eventNs - nowNs (0 if not future)
    uint64_t occupancy = 0;
    uint64_t readIndex = 0;
    uint64_t writeIndex = 0;
    uint64_t simuTimePs = 0;
};
constexpr size_t kAddressWatchCapacity = 4096;
inline std::array<AddressWatchEntry, kAddressWatchCapacity>& addressWatchRing() {
    static std::array<AddressWatchEntry, kAddressWatchCapacity> storage{};
    return storage;
}
inline std::atomic<uint64_t>& addressWatchCursor() {
    static std::atomic<uint64_t> cursor{0};
    return cursor;
}
inline void resetAddressWatchForNewCycle() {
    addressWatchCursor().store(0, std::memory_order_relaxed);
}
// Call whenever pollStepLocked() observes a head entry -- filters to kWatchedRegAddr internally,
// so the caller doesn't need its own branch. Appends only (no per-event I/O).
inline void traceAddressWatch(uint64_t regAddr, uint64_t eventNs, uint64_t nowNs, uint64_t occupancy,
                               uint64_t readIndex, uint64_t writeIndex, uint64_t simuTimePs) {
    if (!traceEnabled() || regAddr != kWatchedRegAddr) return;
    const uint64_t idx = addressWatchCursor().fetch_add(1, std::memory_order_relaxed);
    if (idx >= kAddressWatchCapacity) return; // per-cycle ring -- reset at next ArenaBind, not wrapped mid-cycle
    AddressWatchEntry& e = addressWatchRing()[idx];
    e.seq = idx;
    e.eventNs = eventNs;
    e.nowNs = nowNs;
    e.gapNs = eventNs > nowNs ? eventNs - nowNs : 0;
    e.occupancy = occupancy;
    e.readIndex = readIndex;
    e.writeIndex = writeIndex;
    e.simuTimePs = simuTimePs;
}

// round 8: backlog horizon -- head vs tail eventNs whenever occupancy is elevated (reuses the
// existing kPressureOccupancyThreshold=28 gate). Same per-cycle-reset discipline.
struct BacklogHorizonEntry {
    uint64_t hostTsNs = 0;
    uint64_t headEventNs = 0;
    uint64_t tailEventNs = 0;
    uint64_t spanNs = 0; // tailEventNs - headEventNs
    uint64_t occupancy = 0;
};
constexpr size_t kBacklogHorizonCapacity = 2048;
inline std::array<BacklogHorizonEntry, kBacklogHorizonCapacity>& backlogHorizonRing() {
    static std::array<BacklogHorizonEntry, kBacklogHorizonCapacity> storage{};
    return storage;
}
inline std::atomic<uint64_t>& backlogHorizonCursor() {
    static std::atomic<uint64_t> cursor{0};
    return cursor;
}
inline void resetBacklogHorizonForNewCycle() {
    backlogHorizonCursor().store(0, std::memory_order_relaxed);
}
inline void traceBacklogHorizon(uint64_t occupancy, uint64_t headEventNs, uint64_t tailEventNs) {
    if (!traceEnabled() || occupancy < kPressureOccupancyThreshold) return;
    const uint64_t idx = backlogHorizonCursor().fetch_add(1, std::memory_order_relaxed);
    if (idx >= kBacklogHorizonCapacity) return;
    BacklogHorizonEntry& e = backlogHorizonRing()[idx];
    e.hostTsNs = monotonicNs();
    e.headEventNs = headEventNs;
    e.tailEventNs = tailEventNs;
    e.spanNs = tailEventNs > headEventNs ? tailEventNs - headEventNs : 0;
    e.occupancy = occupancy;
}

inline void resetPerCycleWatchesForTesting() {
    resetAddressWatchForNewCycle();
    resetBacklogHorizonForNewCycle();
}

// Aggregate-only summary for a healthy (non-failing) cycle -- one compact line, no per-event dump.
// Computes median/p95/max in-place via partial sort of a small local copy (ring is at most 4096
// entries -- this is a one-shot O(n log n) at cycle-end, not a hot-path cost).
inline void printAddressWatchSummary(int cycle) {
    if (!traceEnabled()) return;
    const uint64_t count = addressWatchCursor().load(std::memory_order_relaxed);
    const uint64_t n = count < kAddressWatchCapacity ? count : kAddressWatchCapacity;
    if (n == 0) {
        std::fprintf(stderr, "  ciclo %d: I2C0-WATCH 0x3ff53058 count=0 (no occurrences this cycle)\n", cycle);
        return;
    }
    std::vector<uint64_t> gaps;
    std::vector<uint64_t> occs;
    gaps.reserve(n);
    occs.reserve(n);
    for (uint64_t i = 0; i < n; ++i) {
        gaps.push_back(addressWatchRing()[i].gapNs);
        occs.push_back(addressWatchRing()[i].occupancy);
    }
    std::sort(gaps.begin(), gaps.end());
    std::sort(occs.begin(), occs.end());
    const auto pct = [&](const std::vector<uint64_t>& v, double p) {
        size_t idx = static_cast<size_t>(p * static_cast<double>(v.size() - 1));
        return v[idx];
    };
    std::fprintf(stderr,
        "  ciclo %d: I2C0-WATCH 0x3ff53058 count=%llu gapNs[median=%llu p95=%llu p99=%llu max=%llu]"
        " occ[median=%llu max=%llu]\n",
        cycle, static_cast<unsigned long long>(n),
        static_cast<unsigned long long>(pct(gaps, 0.5)), static_cast<unsigned long long>(pct(gaps, 0.95)),
        static_cast<unsigned long long>(pct(gaps, 0.99)), static_cast<unsigned long long>(gaps.back()),
        static_cast<unsigned long long>(pct(occs, 0.5)), static_cast<unsigned long long>(occs.back()));
}

inline void dumpAddressWatchDetailed(std::FILE* out) {
    const uint64_t count = addressWatchCursor().load(std::memory_order_relaxed);
    const uint64_t n = count < kAddressWatchCapacity ? count : kAddressWatchCapacity;
    std::fprintf(out, "[ConsumerTrace] === I2C0 0x3ff53058 watch, this cycle (%llu occurrences) ===\n",
                 static_cast<unsigned long long>(n));
    // Top 20 by gap, preserved explicitly (not just the tail of the ring).
    std::vector<size_t> order(n);
    for (size_t i = 0; i < n; ++i) order[i] = i;
    std::sort(order.begin(), order.end(), [](size_t a, size_t b) {
        return addressWatchRing()[a].gapNs > addressWatchRing()[b].gapNs;
    });
    const size_t top = n < 20 ? n : 20;
    std::fprintf(out, "  --- top %zu by gapNs ---\n", top);
    for (size_t i = 0; i < top; ++i) {
        const AddressWatchEntry& e = addressWatchRing()[order[i]];
        std::fprintf(out, "  [aw seq=%llu] eventNs=%llu nowNs=%llu gapNs=%llu occ=%llu rIdx=%llu wIdx=%llu simuTimePs=%llu\n",
            static_cast<unsigned long long>(e.seq), static_cast<unsigned long long>(e.eventNs),
            static_cast<unsigned long long>(e.nowNs), static_cast<unsigned long long>(e.gapNs),
            static_cast<unsigned long long>(e.occupancy), static_cast<unsigned long long>(e.readIndex),
            static_cast<unsigned long long>(e.writeIndex), static_cast<unsigned long long>(e.simuTimePs));
    }
    std::fprintf(out, "  --- chronological (first 50, last 50) ---\n");
    const auto printOne = [&](uint64_t i) {
        const AddressWatchEntry& e = addressWatchRing()[i];
        std::fprintf(out, "  [aw seq=%llu] eventNs=%llu nowNs=%llu gapNs=%llu occ=%llu rIdx=%llu wIdx=%llu simuTimePs=%llu\n",
            static_cast<unsigned long long>(e.seq), static_cast<unsigned long long>(e.eventNs),
            static_cast<unsigned long long>(e.nowNs), static_cast<unsigned long long>(e.gapNs),
            static_cast<unsigned long long>(e.occupancy), static_cast<unsigned long long>(e.readIndex),
            static_cast<unsigned long long>(e.writeIndex), static_cast<unsigned long long>(e.simuTimePs));
    };
    for (uint64_t i = 0; i < n && i < 50; ++i) printOne(i);
    if (n > 100) std::fprintf(out, "  ...\n");
    for (uint64_t i = (n > 50 ? n - 50 : 0); i < n; ++i) printOne(i);
    std::fflush(out);
}

inline void dumpBacklogHorizon(std::FILE* out) {
    const uint64_t count = backlogHorizonCursor().load(std::memory_order_relaxed);
    const uint64_t n = count < kBacklogHorizonCapacity ? count : kBacklogHorizonCapacity;
    std::fprintf(out, "[ConsumerTrace] === backlog horizon (occupancy>=%llu), this cycle (%llu samples) ===\n",
                 static_cast<unsigned long long>(kPressureOccupancyThreshold), static_cast<unsigned long long>(n));
    const uint64_t take = n < 100 ? n : 100;
    const uint64_t start = n - take;
    for (uint64_t i = start; i < n; ++i) {
        const BacklogHorizonEntry& e = backlogHorizonRing()[i];
        std::fprintf(out, "  [bh %llu] hostTsNs=%llu headEventNs=%llu tailEventNs=%llu spanNs=%llu occ=%llu\n",
            static_cast<unsigned long long>(i), static_cast<unsigned long long>(e.hostTsNs),
            static_cast<unsigned long long>(e.headEventNs), static_cast<unsigned long long>(e.tailEventNs),
            static_cast<unsigned long long>(e.spanNs), static_cast<unsigned long long>(e.occupancy));
    }
    std::fflush(out);
}

// ---------------------------------------------------------------------------------------------
// Round 9 (Option C audit: safe-frontier / wakeup-step policy) -- classifies WHICH term won the
// nextTime = min(targetTimeNs, nowNs+selectedStep, m_events.top().timeNs) computation in
// Scheduler::runUntil(), per pressure phase (P0 healthy / P1 pre-pressure / P2 terminal pressure,
// keyed off the SAME occupancy thresholds already used by the pressure tracker). Aggregate
// counters only -- no per-step dump. A small bounded reservoir retains deadline-distance samples
// for EVENT-limited iterations specifically (the case of interest), tagged by the winning event's
// componentIndex (kNoComponent for every lambda-scheduled callback, e.g. McuComponent's own arena
// poll -- see schedulePollAt() -- since it doesn't use the componentIndex-tagged overload; a
// real, non-kNoComponent value would mean a genuinely different, component-attributed source).
// ---------------------------------------------------------------------------------------------

enum class NextTimeLimiter : uint8_t { Target = 0, Step = 1, Event = 2 };
enum class PressurePhase : uint8_t { Healthy = 0, PrePressure = 1, Terminal = 2 };

// Updated (not read) from McuComponent's existing updatePressure() call site -- reused, not a new
// call site. Scheduler.cpp only READS this; it never touches arena/occupancy state directly,
// preserving the existing architectural separation.
inline std::atomic<uint8_t>& currentPressurePhase() {
    static std::atomic<uint8_t> phase{static_cast<uint8_t>(PressurePhase::Healthy)};
    return phase;
}
inline void updatePressurePhaseForTesting(uint64_t occupancy) {
    if (!traceEnabled()) return;
    PressurePhase p = PressurePhase::Healthy;
    if (occupancy >= kPressureOccupancyThreshold) p = PressurePhase::Terminal;       // >=28
    else if (occupancy >= 16) p = PressurePhase::PrePressure;                        // [16,28)
    currentPressurePhase().store(static_cast<uint8_t>(p), std::memory_order_relaxed);
}

constexpr size_t kLimiterCounterSlots = 3 /*phase*/ * 3 /*limiter*/;
inline std::array<std::atomic<uint64_t>, kLimiterCounterSlots>& limiterCounters() {
    static std::array<std::atomic<uint64_t>, kLimiterCounterSlots> counters{};
    return counters;
}
inline void traceNextTimeLimiter(NextTimeLimiter limiter) {
    if (!traceEnabled()) return;
    const uint8_t phase = currentPressurePhase().load(std::memory_order_relaxed);
    const size_t idx = static_cast<size_t>(phase) * 3 + static_cast<size_t>(limiter);
    limiterCounters()[idx].fetch_add(1, std::memory_order_relaxed);
}

struct EventLimiterSample {
    uint64_t deadlineDistanceNs = 0; // m_events.top().timeNs - nowNs at the moment it won
    uint32_t componentIndex = 0;     // kNoComponent (UINT32_MAX) for lambda-scheduled callbacks
    uint8_t phase = 0;
};
constexpr size_t kEventLimiterSampleCapacity = 8192;
inline std::array<EventLimiterSample, kEventLimiterSampleCapacity>& eventLimiterSamples() {
    static std::array<EventLimiterSample, kEventLimiterSampleCapacity> storage{};
    return storage;
}
inline std::atomic<uint64_t>& eventLimiterSampleCursor() {
    static std::atomic<uint64_t> cursor{0};
    return cursor;
}
inline void traceEventLimiterSample(uint64_t deadlineDistanceNs, uint32_t componentIndex) {
    if (!traceEnabled()) return;
    const uint64_t idx = eventLimiterSampleCursor().fetch_add(1, std::memory_order_relaxed) % kEventLimiterSampleCapacity;
    EventLimiterSample& e = eventLimiterSamples()[idx];
    e.deadlineDistanceNs = deadlineDistanceNs;
    e.componentIndex = componentIndex;
    e.phase = currentPressurePhase().load(std::memory_order_relaxed);
}

inline const char* phaseName(uint8_t p) {
    switch (static_cast<PressurePhase>(p)) {
        case PressurePhase::Healthy: return "P0_healthy";
        case PressurePhase::PrePressure: return "P1_pre_pressure";
        case PressurePhase::Terminal: return "P2_terminal";
    }
    return "?";
}
inline const char* limiterName(uint8_t l) {
    switch (static_cast<NextTimeLimiter>(l)) {
        case NextTimeLimiter::Target: return "targetTime";
        case NextTimeLimiter::Step: return "selectedStep";
        case NextTimeLimiter::Event: return "events.top";
    }
    return "?";
}

inline void dumpNextTimeLimiterStats(std::FILE* out) {
    std::fprintf(out, "[ConsumerTrace] === nextTime limiter distribution by pressure phase ===\n");
    for (uint8_t phase = 0; phase < 3; ++phase) {
        uint64_t total = 0;
        uint64_t counts[3];
        for (uint8_t lim = 0; lim < 3; ++lim) {
            counts[lim] = limiterCounters()[static_cast<size_t>(phase) * 3 + lim].load(std::memory_order_relaxed);
            total += counts[lim];
        }
        if (total == 0) {
            std::fprintf(out, "  %s: no iterations recorded\n", phaseName(phase));
            continue;
        }
        std::fprintf(out, "  %s: total=%llu target=%llu (%.2f%%) step=%llu (%.2f%%) event=%llu (%.2f%%)\n",
            phaseName(phase), static_cast<unsigned long long>(total),
            static_cast<unsigned long long>(counts[0]), 100.0 * static_cast<double>(counts[0]) / static_cast<double>(total),
            static_cast<unsigned long long>(counts[1]), 100.0 * static_cast<double>(counts[1]) / static_cast<double>(total),
            static_cast<unsigned long long>(counts[2]), 100.0 * static_cast<double>(counts[2]) / static_cast<double>(total));
    }

    const uint64_t sampleTotal = eventLimiterSampleCursor().load(std::memory_order_relaxed);
    const uint64_t sampleCount = sampleTotal < kEventLimiterSampleCapacity ? sampleTotal : kEventLimiterSampleCapacity;
    std::fprintf(out, "[ConsumerTrace] === event-limiter deadline-distance samples (%llu of %llu total) ===\n",
                 static_cast<unsigned long long>(sampleCount), static_cast<unsigned long long>(sampleTotal));
    // Bucket by (phase, componentIndex) -- in this circuit there are at most a handful of distinct
    // componentIndex values (kNoComponent dominant expected; see doc-comment above).
    struct Bucket { uint8_t phase; uint32_t componentIndex; std::vector<uint64_t> distances; };
    std::vector<Bucket> buckets;
    for (uint64_t i = 0; i < sampleCount; ++i) {
        const EventLimiterSample& s = eventLimiterSamples()[i];
        Bucket* found = nullptr;
        for (Bucket& b : buckets) {
            if (b.phase == s.phase && b.componentIndex == s.componentIndex) { found = &b; break; }
        }
        if (!found) { buckets.push_back(Bucket{s.phase, s.componentIndex, {}}); found = &buckets.back(); }
        found->distances.push_back(s.deadlineDistanceNs);
    }
    for (Bucket& b : buckets) {
        std::sort(b.distances.begin(), b.distances.end());
        const size_t n = b.distances.size();
        const auto pct = [&](double p) { return b.distances[static_cast<size_t>(p * static_cast<double>(n - 1))]; };
        std::fprintf(out,
            "  phase=%s componentIndex=%s count=%zu deadlineDistanceNs[median=%llu p95=%llu max=%llu]\n",
            phaseName(b.phase), b.componentIndex == 0xFFFFFFFFu ? "kNoComponent(lambda)" : std::to_string(b.componentIndex).c_str(),
            n, static_cast<unsigned long long>(pct(0.5)), static_cast<unsigned long long>(pct(0.95)),
            static_cast<unsigned long long>(b.distances.back()));
    }
    std::fflush(out);
}

} // namespace lasecsimul::mcu::diag
