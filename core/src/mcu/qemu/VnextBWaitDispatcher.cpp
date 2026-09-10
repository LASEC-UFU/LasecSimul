#include "VnextBWaitDispatcher.hpp"

#include <atomic>
#include <array>
#include <chrono>
#include <condition_variable>
#include <mutex>
#include <thread>
#include <vector>
#include <functional>

#ifdef _WIN32
#include <windows.h>
#endif

namespace lasecsimul::mcu::qemu {

class VnextBWaitDispatcher::Impl {
public:
    // One slot is reserved for the dispatcher wake Event. The remaining fixed slots are the
    // maximum number of attachment Events that WaitForMultipleObjects can wait on at once.
#ifdef _WIN32
    static constexpr size_t kMaxRegistrations = MAXIMUM_WAIT_OBJECTS - 1;
#else
    static constexpr size_t kMaxRegistrations = 63;
#endif
    struct Entry { void* handle = nullptr; Callback callback; uint64_t token = 0; };
    mutable std::mutex mutex;
    std::array<Entry, kMaxRegistrations> entries{};
    std::atomic<bool> stopping{false};
    uint64_t nextToken = 1;
    size_t nextStartSlot = 0;
    // E123 Phase 2 (EVIDENCE.md, 2026-09-05): drain contract for unregister() -- see unregister()'s
    // own comment for what this guarantees and why. Paired with Impl::mutex (the SAME lock run()
    // already takes to snapshot the wait set / look up a callback), not a separate lock -- avoids
    // introducing a second lock order to reason about.
    std::condition_variable drainCv;
    // Wait-set generation protocol backing unregister()'s drain contract: waitSetGeneration is
    // bumped (under mutex) by register/unregister; run() publishes the generation its current
    // WaitForMultipleObjects() snapshot was built from into waitSetObservedGeneration (also under
    // mutex); callbacksInFlight tracks whether the worker is currently executing a callback. All
    // three are load-bearing for unregister()'s wait predicate below, not diagnostic output --
    // instance state (not global) since each dispatcher has its own independent wait set.
    std::atomic<uint64_t> waitSetGeneration{0};
    std::atomic<uint64_t> waitSetObservedGeneration{0};
    std::atomic<uint64_t> callbacksInFlight{0};

    VnextBWaitDispatcherStats stats() const {
        std::lock_guard lock(mutex);
        VnextBWaitDispatcherStats result;
        for (const auto& entry : entries) result.occupiedSlots += entry.handle ? 1u : 0u;
#ifdef _WIN32
        result.workerIdentity = static_cast<uint64_t>(std::hash<std::thread::id>{}(worker.get_id()));
#endif
        return result;
    }
#ifdef _WIN32
    HANDLE wake = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    std::thread worker{[this] { run(); }};

    ~Impl() {
        stopping.store(true, std::memory_order_release);
        SetEvent(wake);
        if (worker.joinable()) worker.join();
        CloseHandle(wake);
    }

    void run() {
        while (!stopping.load(std::memory_order_acquire)) {
            std::vector<HANDLE> handles{wake};
            std::vector<uint64_t> tokens;
            std::vector<size_t> slots;
            uint64_t builtFromGeneration = 0;
            {
                std::lock_guard lock(mutex);
                // WaitForMultipleObjects returns the lowest-index signaled handle. Rotate the
                // fixed table so a continuously signaled attachment cannot starve later slots.
                for (size_t offset = 0; offset < kMaxRegistrations; ++offset) {
                    const size_t slot = (nextStartSlot + offset) % kMaxRegistrations;
                    const Entry& entry = entries[slot];
                    if (!entry.handle) continue;
                    if (handles.size() == MAXIMUM_WAIT_OBJECTS) break;
                    handles.push_back(static_cast<HANDLE>(entry.handle));
                    tokens.push_back(entry.token);
                    slots.push_back(slot);
                }
                // E123 Phase 2 (EVIDENCE.md, 2026-09-05): the handle list above is a SNAPSHOT taken
                // under `mutex`. Publishing the CURRENT wait-set generation here, still under the
                // same lock that unregister() also takes, means: by the time this store is visible,
                // the snapshot in `handles` reflects every unregister() that completed-and-returned
                // before this instant. unregister() blocks on this generation being observed before
                // returning -- see unregister()'s own comment for the full drain contract.
                builtFromGeneration = waitSetGeneration.load(std::memory_order_acquire);
                // Publish under the SAME lock unregister()'s waiters reacquire before rechecking
                // their predicate -- the standard pattern to avoid a lost wakeup between "state
                // updated" and "waiter starts blocking" (see unregister()'s own comment).
                waitSetObservedGeneration.store(builtFromGeneration, std::memory_order_release);
            }
            drainCv.notify_all();
            const DWORD result = WaitForMultipleObjects(static_cast<DWORD>(handles.size()), handles.data(), FALSE, INFINITE);
            if (result == WAIT_OBJECT_0) { ResetEvent(wake); continue; }
            if (result < WAIT_OBJECT_0 + handles.size()) {
                // E147-E (EVIDENCE.md, 2026-09-10): off-by-one root cause of the E147-B/C/D
                // wake-storm investigation. `handles[0]` is the dispatcher's own internal `wake`
                // Event, NOT an attachment -- `tokens`/`slots` only ever hold attachment entries
                // (see the loop above), so `attachmentIndex` (0-based within tokens/slots) and
                // `handleIndex` (1-based within handles, offset by the reserved wake slot) are
                // two DIFFERENT indices and must never be used interchangeably. The previous code
                // used the same `index` for both, so ResetEvent() reset the wrong handle for
                // EVERY attachment (one slot too early -- attachment 0's real handle at
                // handles[1] was left untouched while handles[0]==wake got reset instead, and
                // similarly for every other slot) -- the true attachment Event stayed signaled
                // forever, so the next WaitForMultipleObjects() returned immediately for it again
                // in an unbounded loop. Proven by VnextBWaitDispatcherTest.cpp's RED-1/RED-2
                // (single- and two-attachment cases) before this fix, both green after it.
                const size_t attachmentIndex = static_cast<size_t>(result - WAIT_OBJECT_0 - 1);
                const size_t handleIndex = attachmentIndex + 1;
                if (attachmentIndex >= tokens.size() || attachmentIndex >= slots.size() ||
                    handleIndex >= handles.size()) {
                    // Cannot happen given WaitForMultipleObjects()'s own contract (result is
                    // always within [0, handles.size())), but fail loudly rather than silently
                    // indexing out of bounds if that contract is ever violated.
                    std::fprintf(stderr,
                                  "[VnextBWaitDispatcher] BUG: attachmentIndex=%zu handleIndex=%zu "
                                  "out of bounds (tokens=%zu slots=%zu handles=%zu)\n",
                                  attachmentIndex, handleIndex, tokens.size(), slots.size(), handles.size());
                    std::fflush(stderr);
                    continue;
                }
                // Rearm before invoking user code. A publication concurrent with the callback
                // then leaves the manual-reset doorbell signaled and is observed by the next
                // wait; resetting after the callback would create a lost-wake window.
                if (!ResetEvent(handles[handleIndex])) {
                    std::fprintf(stderr,
                                  "[VnextBWaitDispatcher] ResetEvent failed for handleIndex=%zu "
                                  "GetLastError=%lu\n",
                                  handleIndex, static_cast<unsigned long>(GetLastError()));
                    std::fflush(stderr);
                }
                Callback callback;
                {
                    std::lock_guard lock(mutex);
                    for (const Entry& entry : entries) {
                        if (entry.token == tokens[attachmentIndex]) {
                            callback = entry.callback;
                            break;
                        }
                    }
                    nextStartSlot = (slots[attachmentIndex] + 1) % kMaxRegistrations;
                }
                if (callback) {
                    callbacksInFlight.fetch_add(1, std::memory_order_acq_rel);
                    callback();
                    {
                        // Same reasoning as the wait-set generation publish above: decrement under
                        // the lock unregister()'s waiters reacquire, then notify.
                        std::lock_guard lock(mutex);
                        callbacksInFlight.fetch_sub(1, std::memory_order_acq_rel);
                    }
                    drainCv.notify_all();
                }
            }
        }
    }
#else
    ~Impl() = default;
#endif
};

VnextBWaitDispatcher::VnextBWaitDispatcher() : m_impl(std::make_unique<Impl>()) {}
VnextBWaitDispatcher::~VnextBWaitDispatcher() = default;

uint64_t VnextBWaitDispatcher::registerArtifactEvent(void* nativeHandle, Callback callback) {
    if (!nativeHandle || !callback) return 0;
    std::lock_guard lock(m_impl->mutex);
    const auto token = m_impl->nextToken++;
    for (auto& entry : m_impl->entries) {
        if (entry.handle) continue;
        entry.handle = nativeHandle;
        entry.callback = std::move(callback);
        entry.token = token;
        m_impl->waitSetGeneration.fetch_add(1, std::memory_order_acq_rel);
#ifdef _WIN32
        SetEvent(m_impl->wake);
#endif
        return token;
    }
    return 0;
}

void VnextBWaitDispatcher::unregister(uint64_t token) {
    std::unique_lock lock(m_impl->mutex);
    for (auto& entry : m_impl->entries) {
        if (entry.token != token) continue;
        entry.callback = {};
        entry.handle = nullptr;
        entry.token = 0;
        break;
    }
    // Bump the generation while still holding `mutex` -- run()'s wait-set snapshot reads/publishes
    // this generation under the SAME lock, so any snapshot built AFTER this point is guaranteed not
    // to reference the handle just cleared.
    const uint64_t newGeneration =
        m_impl->waitSetGeneration.fetch_add(1, std::memory_order_acq_rel) + 1;
#ifdef _WIN32
    SetEvent(m_impl->wake);
#endif

#ifdef _WIN32
    // E123 Phase 2 (EVIDENCE.md, 2026-09-05): the actual E104 TEARDOWN_HANG was proven (Phase 1) to
    // be a DIFFERENT defect (QemuProcessManager's pipe-handle inheritance, fixed separately) -- this
    // dispatcher itself was never observed to hang in reproduction. It nonetheless had two real,
    // separately provable gaps the task's own analysis called for: (1) a caller of unregister()
    // could proceed to close/free something (e.g. VnextBAttachment::stop()'s CloseHandle on the
    // just-unregistered artifactEvent) while the worker's CURRENT WaitForMultipleObjects() call was
    // still built from a snapshot that includes that handle; (2) a caller could destroy state a
    // still-in-flight callback captures (e.g. `this`) with no guarantee the callback had returned.
    // Both are closed here: unregister() now blocks until the worker has observably rebuilt its
    // wait set from a generation >= this one AND no callback is currently executing -- so by the
    // time this function returns, neither hazard can occur for anything the caller does next.
    //
    // Self-unregister guard: if this is somehow called FROM the dispatcher's own worker thread
    // (e.g. a future callback body decides to unregister its own or another token), waiting for
    // "no callback in flight" would wait for ITSELF and deadlock -- the dispatcher is strictly
    // single-threaded/sequential in its callback execution (run() never invokes two callbacks
    // concurrently), so from the worker thread's own perspective there is, by construction, no
    // OTHER in-flight callback to wait for; only the wait-set generation condition still applies
    // (the worker's NEXT snapshot, taken after this callback returns and the loop repeats, will
    // already reflect this unregister()).
    const bool calledFromWorkerThread = m_impl->worker.get_id() == std::this_thread::get_id();
    constexpr auto kDrainTimeout = std::chrono::seconds(5);
    const auto predicate = [this, newGeneration, calledFromWorkerThread] {
        const bool generationObserved =
            m_impl->waitSetObservedGeneration.load(std::memory_order_acquire) >= newGeneration;
        if (calledFromWorkerThread) return generationObserved;
        const bool noCallbackInFlight =
            m_impl->callbacksInFlight.load(std::memory_order_acquire) == 0;
        return generationObserved && noCallbackInFlight;
    };
    const bool drained = m_impl->drainCv.wait_for(lock, kDrainTimeout, predicate);
    if (!drained) {
        // Never hang forever, even here -- but this is NOT a silent fallback to the old racy
        // behavior: it is reported unconditionally because hitting this in practice means the
        // drain contract itself has a bug and the caller is about to proceed exactly as unsafely
        // as before this fix.
        std::fprintf(stderr,
                      "[VnextBWaitDispatcher] unregister() drain TIMEOUT newGeneration=%llu "
                      "observedGeneration=%llu inFlight=%llu fromWorker=%d\n",
                      static_cast<unsigned long long>(newGeneration),
                      static_cast<unsigned long long>(
                          m_impl->waitSetObservedGeneration.load(std::memory_order_acquire)),
                      static_cast<unsigned long long>(
                          m_impl->callbacksInFlight.load(std::memory_order_acquire)),
                      calledFromWorkerThread ? 1 : 0);
        std::fflush(stderr);
    }
    lock.unlock();
#else
    lock.unlock();
#endif
}

VnextBWaitDispatcherStats VnextBWaitDispatcher::statsForTesting() const {
    return m_impl->stats();
}

} // namespace lasecsimul::mcu::qemu
