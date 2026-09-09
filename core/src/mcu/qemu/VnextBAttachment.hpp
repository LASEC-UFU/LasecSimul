#pragma once

#include "lasecsimul/Types.hpp"
#include "lasecsimul/artifact_mapping.hpp"
#include "QemuProcessManager.hpp"
#include "VnextBWaitDispatcher.hpp"
#include <atomic>
#include <chrono>
#include <memory>
#include <functional>
#include <optional>
#include <string>
#include <span>
#include <utility>
#include <vector>

namespace lasecsimul::mcu::qemu {

void armVnextBTestWaitCallbackBarrier();
bool waitVnextBTestWaitCallbackEntered(std::chrono::milliseconds timeout);
bool waitVnextBTestStaleWaitCallbackRejected(std::chrono::milliseconds timeout);
void releaseVnextBTestWaitCallbackBarrier();
uint64_t vnextBTestStaleWaitCallbackCount();

// E117 (EVIDENCE.md, 2026-09-04): explicit lifecycle for the two-phase startup protocol that
// closes the Core-side ordering race (READY/RUNNING/SetEvent(coreEvent) used to happen before
// g_waitDispatcher::registerArtifactEvent(), letting QEMU produce past the lane before Core could
// ever drain it -- see the Phase 1 causal-ring writeup and the deterministic RED reproduction in
// VnextBAttachmentTest.cpp). Deliberately an explicit enum, not a handful of booleans that could
// represent an impossible combination.
enum class VnextBLifecycleState {
    Stopped,     // no attachment, or stop() has fully torn one down
    Preparing,   // prepare() is in flight: process launched, waiting on QEMU's READY handshake
    Ready,       // prepare() succeeded: dispatcher registered, waitToken valid, QEMU still
                 // PRELAUNCH-blocked (never released) -- safe to expose to a consumer now
    Running,     // activate() succeeded: core_state=RUNNING written, coreEvent signaled, QEMU is
                 // free to run
    Stopping,    // stop() is in flight (guards against reentrant stop() from within a callback)
    Failed,      // prepare()/activate() threw; the attachment must be stop()'d before reuse
};

class VnextBAttachment {
public:
    static VnextBWaitDispatcherStats waitDispatcherStatsForTesting();
    VnextBAttachment();
    ~VnextBAttachment();
    VnextBAttachment(const VnextBAttachment&) = delete;

    // Convenience wrapper: prepare() followed immediately by activate(). Every existing caller
    // that doesn't care about the two-phase split (nearly all of VnextBAttachmentTest.cpp) can
    // keep using this unchanged -- it is not deprecated, just no longer the only entry point.
    // attachedStateForDiagnostics: reserved caller-supplied accessor for the caller's own
    // "attachment is usable" flag, without this class needing to know McuController's internal
    // state. Currently unused by this class's own logic.
    void start(QemuLaunchSpec spec, uint64_t executionId,
               std::string_view sessionId, std::string_view mcuId,
               std::function<void()> notificationWake = {},
               std::function<bool()> attachedStateForDiagnostics = {});

    // Phase 1: launches QEMU, completes the READY handshake, writes core_state=READY, registers
    // the artifact-event dispatcher, and confirms the wait token -- all while QEMU remains
    // PRELAUNCH-blocked (E116's autostart=0 + coreEvent-gated vm_start(), unmodified by this
    // entry) and therefore cannot produce a single lane event yet. Never writes core_state=RUNNING
    // and never signals coreEvent. Throws (state becomes Failed) on any handshake/registration
    // failure; the caller must still call stop() to release resources -- prepare() does not
    // implicitly roll back.
    void prepare(QemuLaunchSpec spec, uint64_t executionId,
                 std::string_view sessionId, std::string_view mcuId,
                 std::function<void()> notificationWake = {},
                 std::function<bool()> attachedStateForDiagnostics = {});
    // Phase 2: requires state()==Ready (a prior successful prepare(), not yet activated).
    // Idempotent-safe to call twice by contract, but the second call is a no-op logged under the
    // trace gate rather than silently repeated -- it must never create a second process or a
    // second dispatcher registration. Writes core_state=RUNNING, then signals coreEvent: by this
    // point the dispatcher is already registered and the caller has already had the chance to
    // mark the attachment usable, so QEMU cannot get ahead of the consumer.
    void activate();
    VnextBLifecycleState lifecycleStateForTesting() const noexcept { return m_state; }
    void stop();
    bool running() const;
    uint64_t processIdForTesting() const;
    std::string logs() const;
    const vnext::MappingView& view() const { return m_view; }
    const std::string& mappingName() const { return m_mappingName; }
    const std::string& coreEventName() const { return m_coreEventName; }
    const std::string& artifactEventName() const { return m_artifactEventName; }
    std::optional<lasec_at_event> consumeLane(uint32_t lane);
    // PLAN_MTTCG_VNEXT_B_CAUSALITY.md section 9.1: peek copies the head with acquire but
    // never advances read_seq and never signals credit -- safe to call any number of times
    // without side effects, so an arbiter can inspect every lane's head before deciding which
    // one to actually consume(). laneHasPending()/hasPendingLaneEvents() answer "is there
    // something to look at" without materializing the event.
    std::optional<lasec_at_event> peekLane(uint32_t lane) const;
    bool laneHasPending(uint32_t lane) const;
    bool hasPendingLaneEvents() const;
    // Test-only synthetic producer: writes directly into a lane's ring as if QEMU had, with a
    // caller-chosen timestamp_ns -- real QEMU timing cannot be dictated precisely enough to
    // build deterministic two-lane interleaving fixtures (R3a synthetic tests need exact
    // timestamps like lane0={120,140}, lane1={100,130}). Never called from production code.
    bool publishLaneEventForTesting(uint32_t lane, uint64_t timestampNs, uint32_t kind,
                                     std::span<const uint8_t> payload);
    // R3c test-only heartbeat injector: writes directly into
    // control->artifact_virtual_time_ns as vnext_heartbeat_cb() would, with a caller-chosen
    // value -- real QEMU virtual-clock timing cannot be dictated precisely enough to build
    // deterministic never-regresses/coalesced-ticks fixtures. Never called from production code.
    bool publishHeartbeatWatermarkForTesting(uint64_t virtualTimeNs);
    uint64_t heartbeatWatermarkForTesting() const;
    bool publishC2A(uint64_t value);
    bool publishRegisterResult(uint64_t address, uint64_t value);
    bool respondToRequest(uint32_t lane, uint64_t responseValue);
    bool respondToRequest(uint32_t lane, uint64_t requestSeq, uint64_t responseValue);
    bool respondToI2c(uint32_t lane, uint64_t requestSeq, const I2cTransferResult& result,
                      std::span<const uint8_t> rx);
    bool c2aEmpty() const;
    bool readSnapshot(uint8_t* out, size_t bytes) const;
    void signalArtifactResume();
    void signalCoreRunningForTesting();
    bool notificationPending() const noexcept { return m_notificationPending.load(std::memory_order_acquire); }
    void acknowledgeNotification() noexcept { m_notificationPending.store(false, std::memory_order_release); }
    uint64_t artifactProgressForTesting() const noexcept;
    // E118 (EVIDENCE.md, 2026-09-05): runtime fatal detection -- artifact_state can become
    // LASEC_AT_FAILED at any point *during* a running session (a genuine VNEXT_FATAL ring-
    // invariant violation on the QEMU side), not only during the initial READY handshake that
    // start()/prepare() already check. Callers that treat "process still running" as "healthy"
    // (e.g. McuController::firmwareRunning()-style checks, the production-scale test harness)
    // must also check this -- a FAILED artifact with a live process is not a valid boot. Cheap,
    // diagnostic-safe: one atomic load each, no lock, callable from any thread.
    bool isArtifactFatal() const;
    uint32_t artifactFatalCode() const;
    // E142 (EVIDENCE.md, 2026-09-08): read-only, non-mutating ring-boundary diagnostic for the
    // causal bisection of the session_restart_stress_test regression -- {write_seq, read_seq} for
    // a lane, straight from the shared control page, so a caller can classify "guest never
    // published" (write_seq==0) vs "published but Core never drained" (write_seq>read_seq)
    // without disturbing consumeLane()/peekLane()'s own state. Never called from production code.
    std::pair<uint64_t, uint64_t> laneRingSeqForTesting(uint32_t lane) const;

private:
    class Impl;
    std::unique_ptr<Impl> m_impl;
    vnext::MappingView m_view{};
    std::string m_mappingName, m_coreEventName, m_artifactEventName;
    std::atomic<bool> m_notificationPending{false};
    std::atomic<uint64_t> m_attachmentGeneration{0};
    VnextBLifecycleState m_state{VnextBLifecycleState::Stopped};
};

} // namespace lasecsimul::mcu::qemu
