#include "NotificationQueue.hpp"

#include <algorithm>
#include <stdexcept>

namespace lasecsimul::ipc {

NotificationQueue::NotificationQueue(uint64_t capacityBytes) : m_capacityBytes(capacityBytes) {
    if (capacityBytes == 0) throw std::invalid_argument("fila de notificacoes exige capacidade positiva");
}

bool NotificationQueue::pushControl(std::string serialized) {
    std::unique_lock<std::mutex> lock(m_mutex);
    if (m_stopped) return false;
    if (serialized.size() > m_capacityBytes) {
        ++m_rejectedControlNotifications;
        return false;
    }
    while (!m_telemetry.empty() && m_bytes + serialized.size() > m_capacityBytes) {
        dropOldestTelemetryLocked();
    }
    // Backpressure apenas entre mensagens confiaveis: nunca aumenta memoria e nunca descarta um
    // evento de controle ja aceito. O consumidor acorda o produtor assim que libera bytes.
    m_wake.wait(lock, [&] { return m_stopped || m_bytes + serialized.size() <= m_capacityBytes; });
    if (m_stopped) return false;
    m_bytes += serialized.size();
    m_control.push_back({NotificationLane::ReliableControl, {}, std::move(serialized)});
    updateDepthLocked();
    m_wake.notify_one();
    return true;
}

bool NotificationQueue::pushTelemetry(std::string key, std::string serialized) {
    std::lock_guard<std::mutex> lock(m_mutex);
    if (m_stopped) return false;
    if (key.empty()) throw std::invalid_argument("telemetria exige chave de stream");

    const auto existing = std::find_if(m_telemetry.begin(), m_telemetry.end(), [&](const auto& queued) {
        return queued.key == key;
    });
    if (existing != m_telemetry.end()) {
        ++m_coalescedTelemetryFrames;
        m_coalescedTelemetryBytes += existing->serialized.size();
        ++m_droppedTelemetryFrames;
        m_droppedTelemetryBytes += existing->serialized.size();
        m_bytes -= existing->serialized.size();
        m_telemetry.erase(existing);
    }

    if (serialized.size() > m_capacityBytes) {
        ++m_droppedTelemetryFrames;
        m_droppedTelemetryBytes += serialized.size();
        return false;
    }
    while (!m_telemetry.empty() && m_bytes + serialized.size() > m_capacityBytes) {
        dropOldestTelemetryLocked();
    }
    if (m_bytes + serialized.size() > m_capacityBytes) {
        ++m_droppedTelemetryFrames;
        m_droppedTelemetryBytes += serialized.size();
        return false;
    }
    m_bytes += serialized.size();
    m_telemetry.push_back({NotificationLane::LossyTelemetry, std::move(key), std::move(serialized)});
    updateDepthLocked();
    m_wake.notify_one();
    return true;
}

std::optional<QueuedNotification> NotificationQueue::waitPop() {
    std::unique_lock<std::mutex> lock(m_mutex);
    m_wake.wait(lock, [this] { return m_stopped || !m_control.empty() || !m_telemetry.empty(); });
    if (m_stopped) return std::nullopt;

    std::deque<QueuedNotification>& lane = m_control.empty() ? m_telemetry : m_control;
    QueuedNotification result = std::move(lane.front());
    lane.pop_front();
    m_bytes -= result.serialized.size();
    m_wake.notify_all();
    return result;
}

void NotificationQueue::stop() {
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        m_stopped = true;
        m_control.clear();
        m_telemetry.clear();
        m_bytes = 0;
    }
    m_wake.notify_all();
}

void NotificationQueue::resetMetrics() {
    std::lock_guard<std::mutex> lock(m_mutex);
    m_maxDepth = m_control.size() + m_telemetry.size();
    m_coalescedTelemetryFrames = 0;
    m_coalescedTelemetryBytes = 0;
    m_droppedTelemetryFrames = 0;
    m_droppedTelemetryBytes = 0;
    m_rejectedControlNotifications = 0;
}

NotificationQueue::Metrics NotificationQueue::metrics() const {
    std::lock_guard<std::mutex> lock(m_mutex);
    return {m_control.size() + m_telemetry.size(), m_maxDepth, m_bytes, m_control.size(),
            m_telemetry.size(), m_coalescedTelemetryFrames, m_coalescedTelemetryBytes,
            m_droppedTelemetryFrames, m_droppedTelemetryBytes, m_rejectedControlNotifications};
}

void NotificationQueue::dropOldestTelemetryLocked() {
    const uint64_t bytes = m_telemetry.front().serialized.size();
    m_bytes -= bytes;
    m_telemetry.pop_front();
    ++m_droppedTelemetryFrames;
    m_droppedTelemetryBytes += bytes;
}

void NotificationQueue::updateDepthLocked() {
    m_maxDepth = std::max<uint64_t>(m_maxDepth, m_control.size() + m_telemetry.size());
}

} // namespace lasecsimul::ipc
