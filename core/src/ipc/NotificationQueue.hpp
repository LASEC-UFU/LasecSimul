#pragma once

#include <condition_variable>
#include <cstdint>
#include <deque>
#include <mutex>
#include <optional>
#include <string>

namespace lasecsimul::ipc {

enum class NotificationLane : uint8_t {
    ReliableControl,
    LossyTelemetry,
};

struct QueuedNotification {
    NotificationLane lane = NotificationLane::ReliableControl;
    std::string key;
    std::string serialized;
};

class NotificationQueue {
public:
    struct Metrics {
        uint64_t depth = 0;
        uint64_t maxDepth = 0;
        uint64_t bytes = 0;
        uint64_t controlDepth = 0;
        uint64_t telemetryDepth = 0;
        uint64_t coalescedTelemetryFrames = 0;
        uint64_t coalescedTelemetryBytes = 0;
        uint64_t droppedTelemetryFrames = 0;
        uint64_t droppedTelemetryBytes = 0;
        uint64_t rejectedControlNotifications = 0;
    };

    explicit NotificationQueue(uint64_t capacityBytes);

    bool pushControl(std::string serialized);
    bool pushTelemetry(std::string key, std::string serialized);
    std::optional<QueuedNotification> waitPop();
    void stop();
    void resetMetrics();
    Metrics metrics() const;
    uint64_t capacityBytes() const { return m_capacityBytes; }

private:
    void dropOldestTelemetryLocked();
    void updateDepthLocked();

    const uint64_t m_capacityBytes;
    mutable std::mutex m_mutex;
    std::condition_variable m_wake;
    std::deque<QueuedNotification> m_control;
    std::deque<QueuedNotification> m_telemetry;
    uint64_t m_bytes = 0;
    uint64_t m_maxDepth = 0;
    uint64_t m_coalescedTelemetryFrames = 0;
    uint64_t m_coalescedTelemetryBytes = 0;
    uint64_t m_droppedTelemetryFrames = 0;
    uint64_t m_droppedTelemetryBytes = 0;
    uint64_t m_rejectedControlNotifications = 0;
    bool m_stopped = false;
};

} // namespace lasecsimul::ipc
