#pragma once

#include <cstdint>
#include <functional>
#include <memory>

namespace lasecsimul::mcu::qemu {

struct VnextBWaitDispatcherStats {
    size_t occupiedSlots = 0;
    uint64_t workerIdentity = 0;
};

class VnextBWaitDispatcher {
public:
    using Callback = std::function<void()>;

    VnextBWaitDispatcher();
    ~VnextBWaitDispatcher();
    VnextBWaitDispatcher(const VnextBWaitDispatcher&) = delete;
    VnextBWaitDispatcher& operator=(const VnextBWaitDispatcher&) = delete;

    // One bounded process-wide wait context services fixed attachment slots. It never consumes
    // Q2C; the callback only transfers ownership of the wake to the Core execution context.
    uint64_t registerArtifactEvent(void* nativeHandle, Callback callback);
    void unregister(uint64_t token);
    VnextBWaitDispatcherStats statsForTesting() const;

private:
    class Impl;
    std::unique_ptr<Impl> m_impl;
};

} // namespace lasecsimul::mcu::qemu
