#pragma once

// E147-B (EVIDENCE.md, 2026-09-10): bounded, opt-in (LASECSIMUL_SETTLE_PROVENANCE=1, off by
// default -- zero cost when unset) causal-provenance counters for the real-project settle storm
// investigation (903k settleIterations / 15s, ~1 componentStamp per iteration). Answers "who
// keeps marking dirty" without a line-per-iteration trace: aggregated per-(origin,
// componentIndex) counts, plus a small fixed-size ring of the most recent dirty-insertion
// events for temporal-causality proof (question: does a single VNEXT_B wake cause hundreds of
// settle iterations, or does the electrical network re-mark itself?). Diagnostic-only; never
// referenced by production admission/scheduling logic.

#include <array>
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <mutex>

namespace lasecsimul::simulation::diag {

enum class DirtyOrigin : uint8_t {
    ExternalMarkDirty = 0, // McuComponent's VNEXT_B notificationWake -> Scheduler::markDirty()
    PendingDirtyMerge = 1, // mergePendingDirtyLocked()
    VoltageListener = 2,   // settleStep()'s node-voltage-changed -> listenersByNode reinsertion
    ModuleWakeup = 3,      // scheduled module/event callback
    FirmwareLoad = 4,      // one-time markDirty right after loadFirmwareLocked()
    Other = 5,
    kCount = 6,
};

inline bool provenanceEnabled() {
    static const bool enabled = [] {
        const char* v = std::getenv("LASECSIMUL_SETTLE_PROVENANCE");
        return v && *v && v[0] != '0';
    }();
    return enabled;
}

struct RingEntry {
    uint64_t sequence = 0;
    uint64_t schedulerNowNs = 0;
    DirtyOrigin origin = DirtyOrigin::Other;
    uint32_t componentIndex = UINT32_MAX;
    uint32_t node = UINT32_MAX;
    double oldV = 0, newV = 0, delta = 0;
};

class ProvenanceTracker {
public:
    static constexpr size_t kMaxComponents = 128;
    static constexpr size_t kRingSize = 256;

    static ProvenanceTracker& instance() {
        static ProvenanceTracker tracker;
        // Registers exactly once, lazily, the first time the tracker is actually touched --
        // prints the summary once at process exit regardless of which binary/teardown path used
        // it (test harness, packaged lasecsimul-core.exe driven by
        // scripts/benchmark-real-esp32.mjs, etc.). No-op when LASECSIMUL_SETTLE_PROVENANCE is
        // unset (provenanceEnabled() short-circuits both this and printSummaryIfEnabled()).
        static const bool registered = [] {
            if (provenanceEnabled()) std::atexit([] { ProvenanceTracker::instance().printSummaryIfEnabled(); });
            return true;
        }();
        (void)registered;
        return tracker;
    }

    void recordDirty(DirtyOrigin origin, uint32_t componentIndex, uint64_t nowNs,
                      uint32_t node = UINT32_MAX, double oldV = 0, double newV = 0) {
        if (!provenanceEnabled()) return;
        const size_t o = static_cast<size_t>(origin);
        m_originTotals[o].fetch_add(1, std::memory_order_relaxed);
        if (componentIndex < kMaxComponents)
            m_perComponentOrigin[componentIndex][o].fetch_add(1, std::memory_order_relaxed);
        const uint64_t seq = m_sequence.fetch_add(1, std::memory_order_relaxed);
        std::lock_guard<std::mutex> lock(m_ringMutex);
        m_ring[seq % kRingSize] = RingEntry{seq, nowNs, origin, componentIndex, node, oldV, newV, newV - oldV};
    }

    void recordWakeCallback(bool stale) {
        if (!provenanceEnabled()) return;
        (stale ? m_staleWakeCallbacks : m_wakeCallbacks).fetch_add(1, std::memory_order_relaxed);
    }

    void recordStampEntry(uint32_t componentIndex) {
        if (!provenanceEnabled()) return;
        m_stampEntries.fetch_add(1, std::memory_order_relaxed);
        if (componentIndex < kMaxComponents)
            m_perComponentStamps[componentIndex].fetch_add(1, std::memory_order_relaxed);
    }

    void recordHeartbeatSample(bool advanced, uint64_t heartbeatNowNs) {
        if (!provenanceEnabled()) return;
        (advanced ? m_heartbeatAdvanced : m_heartbeatStagnant).fetch_add(1, std::memory_order_relaxed);
        m_lastHeartbeatNowNs.store(heartbeatNowNs, std::memory_order_relaxed);
        uint64_t previousMin = m_minHeartbeatNowNs.load(std::memory_order_relaxed);
        while (heartbeatNowNs < previousMin &&
               !m_minHeartbeatNowNs.compare_exchange_weak(previousMin, heartbeatNowNs, std::memory_order_relaxed)) {}
        uint64_t previousMax = m_maxHeartbeatNowNs.load(std::memory_order_relaxed);
        while (heartbeatNowNs > previousMax &&
               !m_maxHeartbeatNowNs.compare_exchange_weak(previousMax, heartbeatNowNs, std::memory_order_relaxed)) {}
    }

    void recordPollOutcome(bool consumedRealEvent, bool foundFutureEvent, bool foundNothing) {
        if (!provenanceEnabled()) return;
        if (consumedRealEvent) m_pollConsumedReal.fetch_add(1, std::memory_order_relaxed);
        if (foundFutureEvent) m_pollFoundFuture.fetch_add(1, std::memory_order_relaxed);
        if (foundNothing) m_pollFoundNothing.fetch_add(1, std::memory_order_relaxed);
    }

    // E147-B: bounded (kMaxAddresses slots, linear-probed) histogram of MMIO addresses seen on
    // the kind==3 direct-register-read VNEXT_B request path -- distinguishes "firmware spinning
    // on one hot register" from "many distinct addresses, no single hot spot".
    void recordMmioRead(uint64_t address) {
        if (!provenanceEnabled()) return;
        std::lock_guard<std::mutex> lock(m_mmioMutex);
        for (auto& slot : m_mmioAddressCounts) {
            if (slot.first == address) { ++slot.second; return; }
            if (slot.first == 0 && slot.second == 0) { slot.first = address; slot.second = 1; return; }
        }
        m_mmioOverflow.fetch_add(1, std::memory_order_relaxed);
    }

    // E147-D: which lane-ring event `kind` values are actually dispatched (kind==3 direct read,
    // kind==LASEC_AT_KIND_BATCH I2C, kind==10 GPIO write, others) -- kind==3 was already proven
    // to be zero; this settles which OTHER producer dominates instead of guessing.
    void recordDispatchedEventKind(uint16_t kind) {
        if (!provenanceEnabled()) return;
        if (kind < kMaxKinds) m_eventKindCounts[kind].fetch_add(1, std::memory_order_relaxed);
        else m_eventKindOverflow.fetch_add(1, std::memory_order_relaxed);
    }

    // E147-D: bounded histogram of GPIO register addresses written via kind==10 events -- same
    // shape as recordMmioRead, separate table (a different physical address space/traffic class).
    void recordGpioWrite(uint64_t address) {
        if (!provenanceEnabled()) return;
        std::lock_guard<std::mutex> lock(m_gpioMutex);
        for (auto& slot : m_gpioAddressCounts) {
            if (slot.first == address) { ++slot.second; return; }
            if (slot.first == 0 && slot.second == 0) { slot.first = address; slot.second = 1; return; }
        }
        m_gpioOverflow.fetch_add(1, std::memory_order_relaxed);
    }

    void printSummaryIfEnabled() const {
        if (!provenanceEnabled()) return;
        static const char* kNames[] = {"ExternalMarkDirty", "PendingDirtyMerge", "VoltageListener",
                                        "ModuleWakeup", "FirmwareLoad", "Other"};
        std::fprintf(stderr, "[SETTLE_PROVENANCE] wakeCallbacks=%llu staleWakeCallbacks=%llu "
                     "stampEntries=%llu pollConsumedReal=%llu pollFoundFuture=%llu pollFoundNothing=%llu\n",
                     static_cast<unsigned long long>(m_wakeCallbacks.load()),
                     static_cast<unsigned long long>(m_staleWakeCallbacks.load()),
                     static_cast<unsigned long long>(m_stampEntries.load()),
                     static_cast<unsigned long long>(m_pollConsumedReal.load()),
                     static_cast<unsigned long long>(m_pollFoundFuture.load()),
                     static_cast<unsigned long long>(m_pollFoundNothing.load()));
        for (size_t o = 0; o < static_cast<size_t>(DirtyOrigin::kCount); ++o) {
            std::fprintf(stderr, "[SETTLE_PROVENANCE] origin=%s total=%llu\n", kNames[o],
                         static_cast<unsigned long long>(m_originTotals[o].load()));
        }
        std::fprintf(stderr, "[SETTLE_PROVENANCE] heartbeatAdvanced=%llu heartbeatStagnant=%llu "
                     "lastHeartbeatNowNs=%llu minHeartbeatNowNs=%llu maxHeartbeatNowNs=%llu\n",
                     static_cast<unsigned long long>(m_heartbeatAdvanced.load()),
                     static_cast<unsigned long long>(m_heartbeatStagnant.load()),
                     static_cast<unsigned long long>(m_lastHeartbeatNowNs.load()),
                     static_cast<unsigned long long>(m_minHeartbeatNowNs.load()),
                     static_cast<unsigned long long>(m_maxHeartbeatNowNs.load()));
        for (size_t c = 0; c < kMaxComponents; ++c) {
            uint64_t stamps = m_perComponentStamps[c].load(std::memory_order_relaxed);
            if (stamps == 0) continue;
            std::fprintf(stderr, "[SETTLE_PROVENANCE] component=%zu stampEntries=%llu", c,
                         static_cast<unsigned long long>(stamps));
            for (size_t o = 0; o < static_cast<size_t>(DirtyOrigin::kCount); ++o) {
                const uint64_t v = m_perComponentOrigin[c][o].load(std::memory_order_relaxed);
                if (v) std::fprintf(stderr, " %s=%llu", kNames[o], static_cast<unsigned long long>(v));
            }
            std::fprintf(stderr, "\n");
        }
        {
            std::lock_guard<std::mutex> lock(m_mmioMutex);
            for (const auto& [address, count] : m_mmioAddressCounts) {
                if (count == 0) continue;
                std::fprintf(stderr, "[SETTLE_PROVENANCE_MMIO] address=0x%llx count=%llu\n",
                             static_cast<unsigned long long>(address), static_cast<unsigned long long>(count));
            }
            const uint64_t overflow = m_mmioOverflow.load(std::memory_order_relaxed);
            if (overflow) std::fprintf(stderr, "[SETTLE_PROVENANCE_MMIO] overflow(distinct addresses beyond %zu slots)=%llu\n",
                                        kMaxAddresses, static_cast<unsigned long long>(overflow));
        }
        for (size_t k = 0; k < kMaxKinds; ++k) {
            const uint64_t v = m_eventKindCounts[k].load(std::memory_order_relaxed);
            if (v) std::fprintf(stderr, "[SETTLE_PROVENANCE_KIND] kind=%zu count=%llu\n", k, static_cast<unsigned long long>(v));
        }
        {
            const uint64_t kindOverflow = m_eventKindOverflow.load(std::memory_order_relaxed);
            if (kindOverflow) std::fprintf(stderr, "[SETTLE_PROVENANCE_KIND] overflow(kind>=%zu)=%llu\n",
                                            kMaxKinds, static_cast<unsigned long long>(kindOverflow));
        }
        {
            std::lock_guard<std::mutex> lock(m_gpioMutex);
            for (const auto& [address, count] : m_gpioAddressCounts) {
                if (count == 0) continue;
                std::fprintf(stderr, "[SETTLE_PROVENANCE_GPIO] address=0x%llx count=%llu\n",
                             static_cast<unsigned long long>(address), static_cast<unsigned long long>(count));
            }
            const uint64_t overflow = m_gpioOverflow.load(std::memory_order_relaxed);
            if (overflow) std::fprintf(stderr, "[SETTLE_PROVENANCE_GPIO] overflow(distinct addresses beyond %zu slots)=%llu\n",
                                        kMaxAddresses, static_cast<unsigned long long>(overflow));
        }
        std::lock_guard<std::mutex> lock(m_ringMutex);
        const uint64_t total = m_sequence.load(std::memory_order_relaxed);
        const size_t count = std::min<uint64_t>(total, kRingSize);
        const uint64_t start = total > kRingSize ? total - kRingSize : 0;
        std::fprintf(stderr, "[SETTLE_PROVENANCE] ring last %zu of %llu total dirty-insertion events:\n",
                     count, static_cast<unsigned long long>(total));
        for (uint64_t s = start; s < total; ++s) {
            const RingEntry& e = m_ring[s % kRingSize];
            std::fprintf(stderr, "[SETTLE_PROVENANCE_RING] seq=%llu nowNs=%llu origin=%s component=%u node=%u "
                         "oldV=%.12g newV=%.12g delta=%.12g\n",
                         static_cast<unsigned long long>(e.sequence), static_cast<unsigned long long>(e.schedulerNowNs),
                         kNames[static_cast<size_t>(e.origin)], e.componentIndex, e.node, e.oldV, e.newV, e.delta);
        }
    }

private:
    std::array<std::atomic<uint64_t>, static_cast<size_t>(DirtyOrigin::kCount)> m_originTotals{};
    std::array<std::array<std::atomic<uint64_t>, static_cast<size_t>(DirtyOrigin::kCount)>, kMaxComponents> m_perComponentOrigin{};
    std::array<std::atomic<uint64_t>, kMaxComponents> m_perComponentStamps{};
    std::atomic<uint64_t> m_wakeCallbacks{0};
    std::atomic<uint64_t> m_staleWakeCallbacks{0};
    std::atomic<uint64_t> m_stampEntries{0};
    std::atomic<uint64_t> m_pollConsumedReal{0};
    std::atomic<uint64_t> m_pollFoundFuture{0};
    std::atomic<uint64_t> m_pollFoundNothing{0};
    std::atomic<uint64_t> m_heartbeatAdvanced{0};
    std::atomic<uint64_t> m_heartbeatStagnant{0};
    std::atomic<uint64_t> m_lastHeartbeatNowNs{0};
    std::atomic<uint64_t> m_minHeartbeatNowNs{UINT64_MAX};
    std::atomic<uint64_t> m_maxHeartbeatNowNs{0};
    static constexpr size_t kMaxAddresses = 32;
    mutable std::array<std::pair<uint64_t, uint64_t>, kMaxAddresses> m_mmioAddressCounts{};
    std::atomic<uint64_t> m_mmioOverflow{0};
    mutable std::mutex m_mmioMutex;
    static constexpr size_t kMaxKinds = 16;
    std::array<std::atomic<uint64_t>, kMaxKinds> m_eventKindCounts{};
    std::atomic<uint64_t> m_eventKindOverflow{0};
    mutable std::array<std::pair<uint64_t, uint64_t>, kMaxAddresses> m_gpioAddressCounts{};
    std::atomic<uint64_t> m_gpioOverflow{0};
    mutable std::mutex m_gpioMutex;
    std::atomic<uint64_t> m_sequence{0};
    mutable std::array<RingEntry, kRingSize> m_ring{};
    mutable std::mutex m_ringMutex;
};

} // namespace lasecsimul::simulation::diag
