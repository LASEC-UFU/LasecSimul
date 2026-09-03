#include "VnextBAttachment.hpp"
#include <algorithm>
#include <atomic>
#include <cstring>
#include <stdexcept>
#include <string>
#include <thread>
#include <chrono>
#include <cstdlib>
#include <condition_variable>
#include <mutex>

#ifdef _WIN32
#include <windows.h>
#endif

namespace lasecsimul::mcu::qemu {
namespace {

struct TestWaitCallbackBarrier {
    std::mutex mutex;
    std::condition_variable condition;
    bool armed = false;
    bool entered = false;
    bool released = false;
    bool completed = false;
    uint64_t staleRejected = 0;
};

TestWaitCallbackBarrier g_testWaitCallbackBarrier;

VnextBWaitDispatcher g_waitDispatcher;

uint64_t align64(uint64_t value) { return (value + 63u) & ~uint64_t(63u); }
uint32_t configuredLaneDepth() {
    const char* text = std::getenv("LASECSIMUL_VNEXT_B_LANE_DEPTH");
    if (!text || !*text) return 8;
    char* end = nullptr;
    const unsigned long value = std::strtoul(text, &end, 10);
    if (!end || *end || value < 2 || value > 1024 || (value & (value - 1)) != 0) return 8;
    return static_cast<uint32_t>(value);
}
std::string safeName(std::string_view text) {
    std::string out;
    for (char c : text) out.push_back((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                                      (c >= '0' && c <= '9') || c == '-' ? c : '_');
    return out.empty() ? "anonymous" : out;
}

uint64_t makeLayout(uint32_t lanes, uint32_t endpoints, uint32_t responses,
                    uint32_t snapshots, uint32_t laneDepth, uint32_t c2aDepth,
                    std::vector<uint64_t>& q2c) {
    uint64_t at = sizeof(lasec_at_control_page);
    auto add = [&](uint64_t bytes) { at = align64(at); const uint64_t result = at; at += bytes; return result; };
    add(uint64_t(endpoints) * sizeof(lasec_at_endpoint_descriptor));
    const uint64_t laneDescriptors = add(uint64_t(lanes) * sizeof(lasec_at_lane_descriptor));
    const uint64_t laneMetadata = add(uint64_t(lanes) * sizeof(lasec_at_ring_header));
    const uint64_t responsesOffset = add(uint64_t(responses) * sizeof(lasec_at_response_slot));
    const uint64_t snapshotsDesc = add(uint64_t(snapshots) * sizeof(lasec_at_snapshot_descriptor));
    const uint64_t snapshotsOffset = add(uint64_t(snapshots) * sizeof(lasec_at_snapshot));
    const uint64_t c2aDesc = add(sizeof(lasec_at_c2a_descriptor));
    const uint64_t c2aMetadata = add(sizeof(lasec_at_ring_header));
    q2c.clear(); for (uint32_t i = 0; i < lanes; ++i) q2c.push_back(add(uint64_t(laneDepth) * sizeof(lasec_at_event)));
    const uint64_t c2aSlots = add(uint64_t(c2aDepth) * sizeof(lasec_at_event));
    (void)laneDescriptors; (void)laneMetadata; (void)responsesOffset; (void)snapshotsDesc;
    (void)snapshotsOffset; (void)c2aDesc; (void)c2aMetadata; (void)c2aSlots;
    return align64(at);
}

void buildContainer(uint8_t* base, uint64_t total, uint64_t executionId, uint32_t depth) {
    constexpr uint32_t lanes = 2, endpoints = 1, responses = 2, snapshots = 1;
    constexpr uint32_t c2aDepth = 2;
    std::vector<uint64_t> q2c;
    uint64_t at = sizeof(lasec_at_control_page);
    auto add = [&](uint64_t bytes) { at = align64(at); uint64_t result = at; at += bytes; return result; };
    const uint64_t endpointsOffset = add(sizeof(lasec_at_endpoint_descriptor));
    const uint64_t laneDescOffset = add(lanes * sizeof(lasec_at_lane_descriptor));
    const uint64_t laneMetaOffset = add(lanes * sizeof(lasec_at_ring_header));
    const uint64_t responseOffset = add(responses * sizeof(lasec_at_response_slot));
    const uint64_t snapshotDescOffset = add(sizeof(lasec_at_snapshot_descriptor));
    const uint64_t snapshotOffset = add(sizeof(lasec_at_snapshot));
    const uint64_t c2aDescOffset = add(sizeof(lasec_at_c2a_descriptor));
    const uint64_t c2aMetaOffset = add(sizeof(lasec_at_ring_header));
    for (uint32_t i = 0; i < lanes; ++i) q2c.push_back(add(depth * sizeof(lasec_at_event)));
    const uint64_t c2aOffset = add(c2aDepth * sizeof(lasec_at_event));
    std::memset(base, 0, static_cast<size_t>(total));
    auto* c = reinterpret_cast<lasec_at_control_page*>(base);
    c->magic = LASEC_AT_MAGIC; c->abi_major = LASEC_AT_ABI_MAJOR; c->abi_minor = LASEC_AT_ABI_MINOR;
    c->mapping_bytes = total; c->execution_id = executionId; c->lane_count = lanes;
    c->response_slot_count = responses; c->descriptor_count = endpoints; c->descriptor_capacity = endpoints;
    c->descriptor_offset = endpointsOffset; c->endpoint_count = endpoints; c->snapshot_count = snapshots;
    c->lane_descriptor_offset = laneDescOffset; c->response_slot_offset = responseOffset;
    c->snapshot_descriptor_offset = snapshotDescOffset; c->snapshot_offset = snapshotOffset;
    c->c2a_descriptor_offset = c2aDescOffset;
    auto* ep = reinterpret_cast<lasec_at_endpoint_descriptor*>(base + endpointsOffset);
    ep[0] = {0, 1, q2c[0], 0, snapshotOffset, depth, sizeof(lasec_at_event), LASEC_AT_EVENT_PAYLOAD, 0};
    auto* ld = reinterpret_cast<lasec_at_lane_descriptor*>(base + laneDescOffset);
    for (uint32_t i = 0; i < lanes; ++i) {
        ld[i].metadata = {laneMetaOffset + i * sizeof(lasec_at_ring_header), sizeof(lasec_at_ring_header), sizeof(lasec_at_ring_header), 1};
        ld[i].events = {q2c[i], depth * sizeof(lasec_at_event), sizeof(lasec_at_event), depth};
        ld[i].depth = depth; ld[i].event_stride = sizeof(lasec_at_event);
    }
    auto* sd = reinterpret_cast<lasec_at_snapshot_descriptor*>(base + snapshotDescOffset);
    sd[0].storage = {snapshotOffset, sizeof(lasec_at_snapshot), sizeof(lasec_at_snapshot), 1};
    sd[0].schema_id = 1;
    auto* c2a = reinterpret_cast<lasec_at_c2a_descriptor*>(base + c2aDescOffset);
    c2a->metadata = {c2aMetaOffset, sizeof(lasec_at_ring_header), sizeof(lasec_at_ring_header), 1};
    c2a->events = {c2aOffset, c2aDepth * sizeof(lasec_at_event), sizeof(lasec_at_event), c2aDepth};
    c2a->depth = c2aDepth; c2a->event_stride = sizeof(lasec_at_event);
    c->core_state = LASEC_AT_STARTING;
}

} // namespace

VnextBWaitDispatcherStats VnextBAttachment::waitDispatcherStatsForTesting() {
    return g_waitDispatcher.statsForTesting();
}

void armVnextBTestWaitCallbackBarrier() {
    std::lock_guard lock(g_testWaitCallbackBarrier.mutex);
    g_testWaitCallbackBarrier.armed = true;
    g_testWaitCallbackBarrier.entered = false;
    g_testWaitCallbackBarrier.released = false;
    g_testWaitCallbackBarrier.completed = false;
    g_testWaitCallbackBarrier.staleRejected = 0;
}

bool waitVnextBTestStaleWaitCallbackRejected(std::chrono::milliseconds timeout) {
    std::unique_lock lock(g_testWaitCallbackBarrier.mutex);
    return g_testWaitCallbackBarrier.condition.wait_for(lock, timeout, [] {
        return g_testWaitCallbackBarrier.completed;
    });
}

bool waitVnextBTestWaitCallbackEntered(std::chrono::milliseconds timeout) {
    std::unique_lock lock(g_testWaitCallbackBarrier.mutex);
    return g_testWaitCallbackBarrier.condition.wait_for(lock, timeout, [] {
        return g_testWaitCallbackBarrier.entered;
    });
}

void releaseVnextBTestWaitCallbackBarrier() {
    {
        std::lock_guard lock(g_testWaitCallbackBarrier.mutex);
        g_testWaitCallbackBarrier.released = true;
    }
    g_testWaitCallbackBarrier.condition.notify_all();
}

uint64_t vnextBTestStaleWaitCallbackCount() {
    std::lock_guard lock(g_testWaitCallbackBarrier.mutex);
    return g_testWaitCallbackBarrier.staleRejected;
}


class VnextBAttachment::Impl {
public:
#ifdef _WIN32
    HANDLE mapping = nullptr, coreEvent = nullptr, artifactEvent = nullptr;
    void* view = nullptr; uint64_t size = 0;
#endif
    QemuProcessManager process;
    uint64_t waitToken = 0;
};

VnextBAttachment::VnextBAttachment() : m_impl(std::make_unique<Impl>()) {}
VnextBAttachment::~VnextBAttachment() { stop(); }

void VnextBAttachment::start(QemuLaunchSpec spec, uint64_t executionId,
                             std::string_view sessionId, std::string_view mcuId,
                             std::function<void()> notificationWake) {
    stop();
    m_notificationPending.store(false, std::memory_order_release);
    const uint64_t attachmentGeneration =
        m_attachmentGeneration.fetch_add(1, std::memory_order_acq_rel) + 1;
    if (!executionId) throw std::invalid_argument("vNext-B executionId is zero");
    const std::string prefix = "LasecSimul-vnextb-" + safeName(sessionId) + "-" + safeName(mcuId) + "-" + std::to_string(executionId);
    m_mappingName = prefix + "-mapping";
    m_coreEventName = prefix + "-artifact-to-core";
    m_artifactEventName = prefix + "-core-to-artifact";
#ifdef _WIN32
    std::vector<uint64_t> layoutScratch;
    const uint32_t laneDepth = configuredLaneDepth();
    m_impl->size = makeLayout(2, 1, 2, 1, laneDepth, 2, layoutScratch);
    m_impl->mapping = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE,
                                          DWORD(m_impl->size >> 32), DWORD(m_impl->size),
                                          std::wstring(m_mappingName.begin(), m_mappingName.end()).c_str());
    if (!m_impl->mapping) throw std::runtime_error("vNext-B mapping creation failed");
    m_impl->view = MapViewOfFile(m_impl->mapping, FILE_MAP_ALL_ACCESS, 0, 0, m_impl->size);
    if (!m_impl->view) throw std::runtime_error("vNext-B mapping view failed");
    buildContainer(static_cast<uint8_t*>(m_impl->view), m_impl->size, executionId, laneDepth);
    const std::wstring coreName(m_coreEventName.begin(), m_coreEventName.end());
    const std::wstring artifactName(m_artifactEventName.begin(), m_artifactEventName.end());
    m_impl->coreEvent = CreateEventW(nullptr, TRUE, FALSE, coreName.c_str());
    // Artifact->Core is a level-triggered doorbell. The shared dispatcher resets it before the
    // callback, so a publication concurrent with callback execution re-signals it safely.
    m_impl->artifactEvent = CreateEventW(nullptr, TRUE, FALSE, artifactName.c_str());
    if (!m_impl->coreEvent || !m_impl->artifactEvent) throw std::runtime_error("vNext-B Event creation failed");
    if (!vnext::validateMappingView(m_impl->view, m_impl->size, m_view)) throw std::runtime_error("vNext-B mapping validation failed");
    // McuController's common launch builder prepends the legacy arena key. Remove that
    // positional argument before selecting VNEXT_B so the QEMU entry point receives only the
    // vNext mapping key and ordinary QEMU options; the legacy arena is never opened.
    if (!spec.args.empty() && spec.args.front() == std::string(sessionId)) spec.args.erase(spec.args.begin());
    // The adapter also exposes a conventional argv[0] for the legacy launcher. VNEXT_B already
    // supplies the mapping key as argv[1] to vnext_b_main; leaving this executable name in the
    // ordinary QEMU argument vector makes qemu_init interpret it as a positional image path.
    if (!spec.args.empty() && (spec.args.front() == "qemu-system-xtensa" ||
                               spec.args.front() == spec.binary)) spec.args.erase(spec.args.begin());
    spec.args.insert(spec.args.begin(), m_mappingName);
    spec.environment.emplace_back("LASECSIMUL_TRANSPORT", "VNEXT_B");
    spec.environment.emplace_back("LASECSIMUL_VNEXT_B_CORE_EVENT", m_coreEventName);
    spec.environment.emplace_back("LASECSIMUL_VNEXT_B_ARTIFACT_EVENT", m_artifactEventName);
    spec.diagnostics += "[LasecSimul] vNext-B mapping/events attached\n";
    m_impl->process.start(spec);
    auto* c = const_cast<lasec_at_control_page*>(m_view.control);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (std::chrono::steady_clock::now() < deadline && m_impl->process.isRunning()) {
        const uint32_t state = std::atomic_ref<uint32_t>(c->artifact_state).load(std::memory_order_acquire);
        if (state == LASEC_AT_READY) break;
        if (state == LASEC_AT_FAILED ||
            std::atomic_ref<uint32_t>(c->artifact_fatal_code).load(std::memory_order_acquire) != 0) {
            stop();
            throw std::runtime_error("vNext-B QEMU rejected mapping or execution");
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    if (!m_impl->process.isRunning() ||
        std::atomic_ref<uint32_t>(c->artifact_state).load(std::memory_order_acquire) != LASEC_AT_READY) {
        const std::string logs = m_impl->process.logs();
        stop();
        throw std::runtime_error("vNext-B QEMU READY handshake timeout: " + logs);
    }
    std::atomic_ref<uint32_t>(c->core_state).store(LASEC_AT_READY, std::memory_order_release);
    std::atomic_ref<uint32_t>(c->core_state).store(LASEC_AT_RUNNING, std::memory_order_release);
    SetEvent(m_impl->coreEvent);
    m_impl->waitToken = g_waitDispatcher.registerArtifactEvent(
        m_impl->artifactEvent, [this, attachmentGeneration, notificationWake = std::move(notificationWake)] {
            {
                std::unique_lock lock(g_testWaitCallbackBarrier.mutex);
                if (g_testWaitCallbackBarrier.armed) {
                    g_testWaitCallbackBarrier.armed = false;
                    g_testWaitCallbackBarrier.entered = true;
                    g_testWaitCallbackBarrier.condition.notify_all();
                    g_testWaitCallbackBarrier.condition.wait(lock, [] {
                        return g_testWaitCallbackBarrier.released;
                    });
                }
            }
            if (m_attachmentGeneration.load(std::memory_order_acquire) == attachmentGeneration) {
                m_notificationPending.store(true, std::memory_order_release);
                if (notificationWake) notificationWake();
            } else {
                std::lock_guard lock(g_testWaitCallbackBarrier.mutex);
                ++g_testWaitCallbackBarrier.staleRejected;
                g_testWaitCallbackBarrier.completed = true;
                g_testWaitCallbackBarrier.condition.notify_all();
            }
        });
    if (!m_impl->waitToken) {
        stop();
        throw std::runtime_error("vNext-B wait dispatcher registration capacity exhausted");
    }
#else
    (void)spec; throw std::runtime_error("vNext-B attachment requires Windows named objects");
#endif
}

void VnextBAttachment::stop() {
    if (!m_impl) return;
    m_attachmentGeneration.fetch_add(1, std::memory_order_acq_rel);
    if (m_impl->waitToken) {
        g_waitDispatcher.unregister(m_impl->waitToken);
        m_impl->waitToken = 0;
    }
    m_impl->process.stop();
#ifdef _WIN32
    if (m_impl->view) UnmapViewOfFile(m_impl->view);
    if (m_impl->mapping) CloseHandle(m_impl->mapping);
    if (m_impl->coreEvent) CloseHandle(m_impl->coreEvent);
    if (m_impl->artifactEvent) CloseHandle(m_impl->artifactEvent);
    m_impl->view = nullptr; m_impl->mapping = nullptr; m_impl->coreEvent = nullptr; m_impl->artifactEvent = nullptr;
#endif
    m_view = {};
}
bool VnextBAttachment::running() const { return m_impl && m_impl->process.isRunning(); }
uint64_t VnextBAttachment::processIdForTesting() const {
    return m_impl ? m_impl->process.processId() : 0;
}
std::string VnextBAttachment::logs() const { return m_impl ? m_impl->process.logs() : std::string{}; }

std::optional<lasec_at_event> VnextBAttachment::consumeLane(uint32_t lane) {
#ifdef _WIN32
    if (!m_impl || !m_impl->view || lane >= m_view.control->lane_count) return std::nullopt;
    const auto& d = m_view.lanes[lane];
    auto* meta = reinterpret_cast<lasec_at_ring_header*>(static_cast<uint8_t*>(m_impl->view) + d.metadata.offset);
    const uint64_t read = std::atomic_ref<uint64_t>(meta->read_seq).load(std::memory_order_relaxed);
    const uint64_t write = std::atomic_ref<uint64_t>(meta->write_seq).load(std::memory_order_acquire);
    if (read == write) return std::nullopt;
    const auto* slot = reinterpret_cast<const lasec_at_event*>(static_cast<const uint8_t*>(m_impl->view) + d.events.offset) +
                       (read & (d.depth - 1));
    lasec_at_event event = *slot;
    std::atomic_ref<uint64_t>(meta->read_seq).store(read + 1, std::memory_order_release);
    signalArtifactResume();
    return event;
#else
    (void)lane; return std::nullopt;
#endif
}

bool VnextBAttachment::publishC2A(uint64_t value) {
#ifdef _WIN32
    if (!m_impl || !m_impl->view || !m_view.c2a) return false;
    auto* meta = reinterpret_cast<lasec_at_ring_header*>(static_cast<uint8_t*>(m_impl->view) + m_view.c2a->metadata.offset);
    const uint64_t write = std::atomic_ref<uint64_t>(meta->write_seq).load(std::memory_order_relaxed);
    const uint64_t read = std::atomic_ref<uint64_t>(meta->read_seq).load(std::memory_order_acquire);
    if (write - read >= m_view.c2a->depth) return false;
    auto* slot = reinterpret_cast<lasec_at_event*>(static_cast<uint8_t*>(m_impl->view) + m_view.c2a->events.offset) +
                 (write & (m_view.c2a->depth - 1));
    std::memset(slot, 0, sizeof(*slot));
    slot->timestamp_ns = write;
    slot->kind = 2;
    slot->endpoint_id = 0;
    slot->payload_bytes = sizeof(value);
    std::memcpy(slot->payload, &value, sizeof(value));
    slot->lane_sequence = write;
    std::atomic_ref<uint64_t>(meta->write_seq).store(write + 1, std::memory_order_release);
    signalArtifactResume();
    return true;
#else
    (void)value; return false;
#endif
}

bool VnextBAttachment::publishRegisterResult(uint64_t address, uint64_t value) {
#ifdef _WIN32
    if (!m_impl || !m_impl->view || !m_view.c2a) return false;
    auto* meta = reinterpret_cast<lasec_at_ring_header*>(static_cast<uint8_t*>(m_impl->view) + m_view.c2a->metadata.offset);
    const uint64_t write = std::atomic_ref<uint64_t>(meta->write_seq).load(std::memory_order_relaxed);
    const uint64_t read = std::atomic_ref<uint64_t>(meta->read_seq).load(std::memory_order_acquire);
    if (write - read >= m_view.c2a->depth) return false;
    auto* slot = reinterpret_cast<lasec_at_event*>(static_cast<uint8_t*>(m_impl->view) + m_view.c2a->events.offset) +
                 (write & (m_view.c2a->depth - 1));
    std::memset(slot, 0, sizeof(*slot));
    slot->timestamp_ns = write;
    slot->kind = 10;
    slot->endpoint_id = 0;
    slot->payload_bytes = sizeof(address) + sizeof(value);
    std::memcpy(slot->payload, &address, sizeof(address));
    std::memcpy(slot->payload + sizeof(address), &value, sizeof(value));
    slot->lane_sequence = write;
    std::atomic_ref<uint64_t>(meta->write_seq).store(write + 1, std::memory_order_release);
    signalArtifactResume();
    return true;
#else
    (void)address; (void)value; return false;
#endif
}

bool VnextBAttachment::respondToRequest(uint32_t lane, uint64_t responseValue) {
#ifdef _WIN32
    if (!m_impl || !m_impl->view || lane >= m_view.control->lane_count) return false;
    auto request = consumeLane(lane);
    if (!request || request->kind != 3 ||
        (request->payload_bytes != sizeof(uint64_t) && request->payload_bytes != 2 * sizeof(uint64_t))) return false;
    uint64_t requestSeq = 0;
    std::memcpy(&requestSeq, request->payload, sizeof(requestSeq));
    if (requestSeq == 0) return false;
    return respondToRequest(lane, requestSeq, responseValue);
#else
    (void)lane; (void)responseValue; return false;
#endif
}

bool VnextBAttachment::respondToRequest(uint32_t lane, uint64_t requestSeq, uint64_t responseValue) {
#ifdef _WIN32
    if (!m_impl || !m_impl->view || lane >= m_view.control->lane_count || requestSeq == 0) return false;
    auto* slot = const_cast<lasec_at_response_slot*>(m_view.responses + lane);
    const uint64_t oldRequest = std::atomic_ref<uint64_t>(slot->request_seq).load(std::memory_order_acquire);
    if (oldRequest != requestSeq) return false;
    slot->status = 0;
    slot->payload_bytes = sizeof(responseValue);
    std::memcpy(slot->payload, &responseValue, sizeof(responseValue));
    std::atomic_ref<uint64_t>(slot->response_seq).store(requestSeq, std::memory_order_release);
    std::atomic_ref<uint64_t>(const_cast<uint64_t&>(m_view.control->core_progress_ns)).fetch_add(1, std::memory_order_release);
    signalArtifactResume();
    return true;
#else
    (void)lane; (void)requestSeq; (void)responseValue; return false;
#endif
}

bool VnextBAttachment::respondToI2c(uint32_t lane, uint64_t requestSeq, const I2cTransferResult& result,
                                    std::span<const uint8_t> rxData) {
#ifdef _WIN32
    if (!m_impl || !m_impl->view || lane >= m_view.control->lane_count || requestSeq == 0) return false;
    auto* slot = const_cast<lasec_at_response_slot*>(m_view.responses + lane);
    if (std::atomic_ref<uint64_t>(slot->request_seq).load(std::memory_order_acquire) != requestSeq) return false;
    uint8_t payload[LASEC_AT_EVENT_PAYLOAD]{};
    const uint32_t status = (result.handled ? 1u : 0u) | (result.addressAck ? 2u : 0u);
    const uint32_t rx = std::min<uint32_t>(result.rxSize, 32u);
    std::memcpy(payload, &status, sizeof(status));
    std::memcpy(payload + 4, &result.firstNack, sizeof(result.firstNack));
    std::memcpy(payload + 8, &result.stretchNs, sizeof(result.stretchNs));
    std::memcpy(payload + 16, &rx, sizeof(rx));
    if (rx) std::memcpy(payload + 20, rxData.data(), std::min<uint32_t>(rx, static_cast<uint32_t>(rxData.size())));
    slot->status = 0;
    slot->payload_bytes = 20 + rx;
    std::memcpy(slot->payload, payload, slot->payload_bytes);
    std::atomic_ref<uint64_t>(slot->response_seq).store(requestSeq, std::memory_order_release);
    // I2C completion is authoritative in ResponseSlot. C2A remains reserved for
    // independent asynchronous Core->Artifact events; allocating a requestSeq-only
    // C2A item here would make causal completion depend on unrelated async capacity.
    signalArtifactResume();
    return true;
#else
    (void)lane; (void)requestSeq; (void)result; (void)rxData; return false;
#endif
}

bool VnextBAttachment::c2aEmpty() const {
#ifdef _WIN32
    if (!m_impl || !m_impl->view || !m_view.c2a) return false;
    const auto* meta = reinterpret_cast<const lasec_at_ring_header*>(static_cast<const uint8_t*>(m_impl->view) + m_view.c2a->metadata.offset);
    return std::atomic_ref<const uint64_t>(meta->read_seq).load(std::memory_order_acquire) ==
           std::atomic_ref<const uint64_t>(meta->write_seq).load(std::memory_order_acquire);
#else
    return false;
#endif
}

bool VnextBAttachment::readSnapshot(uint8_t* out, size_t bytes) const {
#ifdef _WIN32
    if (!m_impl || !m_impl->view || !m_view.snapshots || !out || bytes > LASEC_AT_SNAPSHOT_BYTES) return false;
    const auto& d = m_view.snapshots[0].storage;
    const auto* snapshot = reinterpret_cast<const lasec_at_snapshot*>(static_cast<const uint8_t*>(m_impl->view) + d.offset);
    for (unsigned attempt = 0; attempt < 64; ++attempt) {
        const uint64_t before = std::atomic_ref<const uint64_t>(snapshot->publish_seq).load(std::memory_order_acquire);
        if (before & 1) continue;
        for (size_t i = 0; i < bytes; i += sizeof(uint64_t)) {
            uint64_t word = 0;
            const size_t chunk = (bytes - i) < sizeof(word) ? (bytes - i) : sizeof(word);
            std::memcpy(&word, snapshot->data + i, chunk);
            std::memcpy(out + i, &word, chunk);
        }
        const uint64_t after = std::atomic_ref<const uint64_t>(snapshot->publish_seq).load(std::memory_order_acquire);
        if (before == after) return true;
    }
#else
    (void)out; (void)bytes;
#endif
    return false;
}

void VnextBAttachment::signalArtifactResume() {
#ifdef _WIN32
    if (m_impl && m_impl->coreEvent) SetEvent(m_impl->coreEvent);
#endif
}

uint64_t VnextBAttachment::artifactProgressForTesting() const noexcept {
#ifdef _WIN32
    if (!m_impl || !m_impl->view || !m_view.control) return 0;
    return std::atomic_ref<const uint64_t>(m_view.control->artifact_progress_ns).load(std::memory_order_acquire);
#else
    return 0;
#endif
}

} // namespace lasecsimul::mcu::qemu
