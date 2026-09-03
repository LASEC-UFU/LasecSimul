#include "VnextBWaitDispatcher.hpp"

#include <atomic>
#include <array>
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
            }
            const DWORD result = WaitForMultipleObjects(static_cast<DWORD>(handles.size()), handles.data(), FALSE, INFINITE);
            if (result == WAIT_OBJECT_0) { ResetEvent(wake); continue; }
            if (result < WAIT_OBJECT_0 + handles.size()) {
                const size_t index = result - WAIT_OBJECT_0 - 1;
                // Rearm before invoking user code. A publication concurrent with the callback
                // then leaves the manual-reset doorbell signaled and is observed by the next
                // wait; resetting after the callback would create a lost-wake window.
                ResetEvent(handles[index]);
                Callback callback;
                {
                    std::lock_guard lock(mutex);
                    for (const Entry& entry : entries) {
                        if (entry.token == tokens[index]) {
                            callback = entry.callback;
                            break;
                        }
                    }
                    if (index < slots.size())
                        nextStartSlot = (slots[index] + 1) % kMaxRegistrations;
                }
                if (callback) callback();
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
#ifdef _WIN32
        SetEvent(m_impl->wake);
#endif
        return token;
    }
    return 0;
}

void VnextBWaitDispatcher::unregister(uint64_t token) {
    std::lock_guard lock(m_impl->mutex);
    for (auto& entry : m_impl->entries) {
        if (entry.token != token) continue;
        entry.callback = {};
        entry.handle = nullptr;
        entry.token = 0;
        break;
    }
#ifdef _WIN32
    SetEvent(m_impl->wake);
#endif
}

VnextBWaitDispatcherStats VnextBWaitDispatcher::statsForTesting() const {
    return m_impl->stats();
}

} // namespace lasecsimul::mcu::qemu
