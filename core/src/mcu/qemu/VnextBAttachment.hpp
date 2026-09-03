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
#include <vector>

namespace lasecsimul::mcu::qemu {

void armVnextBTestWaitCallbackBarrier();
bool waitVnextBTestWaitCallbackEntered(std::chrono::milliseconds timeout);
bool waitVnextBTestStaleWaitCallbackRejected(std::chrono::milliseconds timeout);
void releaseVnextBTestWaitCallbackBarrier();
uint64_t vnextBTestStaleWaitCallbackCount();

class VnextBAttachment {
public:
    static VnextBWaitDispatcherStats waitDispatcherStatsForTesting();
    VnextBAttachment();
    ~VnextBAttachment();
    VnextBAttachment(const VnextBAttachment&) = delete;

    void start(QemuLaunchSpec spec, uint64_t executionId,
               std::string_view sessionId, std::string_view mcuId,
               std::function<void()> notificationWake = {});
    void stop();
    bool running() const;
    uint64_t processIdForTesting() const;
    std::string logs() const;
    const vnext::MappingView& view() const { return m_view; }
    const std::string& mappingName() const { return m_mappingName; }
    const std::string& coreEventName() const { return m_coreEventName; }
    const std::string& artifactEventName() const { return m_artifactEventName; }
    std::optional<lasec_at_event> consumeLane(uint32_t lane);
    bool publishC2A(uint64_t value);
    bool publishRegisterResult(uint64_t address, uint64_t value);
    bool respondToRequest(uint32_t lane, uint64_t responseValue);
    bool respondToRequest(uint32_t lane, uint64_t requestSeq, uint64_t responseValue);
    bool respondToI2c(uint32_t lane, uint64_t requestSeq, const I2cTransferResult& result,
                      std::span<const uint8_t> rx);
    bool c2aEmpty() const;
    bool readSnapshot(uint8_t* out, size_t bytes) const;
    void signalArtifactResume();
    bool notificationPending() const noexcept { return m_notificationPending.load(std::memory_order_acquire); }
    void acknowledgeNotification() noexcept { m_notificationPending.store(false, std::memory_order_release); }
    uint64_t artifactProgressForTesting() const noexcept;

private:
    class Impl;
    std::unique_ptr<Impl> m_impl;
    vnext::MappingView m_view{};
    std::string m_mappingName, m_coreEventName, m_artifactEventName;
    std::atomic<bool> m_notificationPending{false};
    std::atomic<uint64_t> m_attachmentGeneration{0};
};

} // namespace lasecsimul::mcu::qemu
