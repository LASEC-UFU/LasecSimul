#include "lasecsimul/CausalTrace.hpp"

#include <chrono>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <random>
#include <thread>
#ifdef _WIN32
#include <windows.h>
#else
#include <unistd.h>
#endif

namespace lasecsimul::trace {
namespace { thread_local uint64_t g_currentI2cRequest = 0; thread_local RuntimeLaunchIdentity g_runtimeIdentity{}; }
namespace {
uint64_t qpcNow(uint64_t* frequency) noexcept {
#ifdef _WIN32
    LARGE_INTEGER value{}, freq{};
    QueryPerformanceCounter(&value); QueryPerformanceFrequency(&freq);
    if (frequency) *frequency = static_cast<uint64_t>(freq.QuadPart);
    return static_cast<uint64_t>(value.QuadPart);
#else
    if (frequency) *frequency = 1000000000ull;
    return static_cast<uint64_t>(std::chrono::steady_clock::now().time_since_epoch().count());
#endif
}
uint32_t processId() noexcept {
#ifdef _WIN32
    return GetCurrentProcessId();
#else
    return static_cast<uint32_t>(getpid());
#endif
}
uint32_t threadId() noexcept {
#ifdef _WIN32
    return GetCurrentThreadId();
#else
    return static_cast<uint32_t>(std::hash<std::thread::id>{}(std::this_thread::get_id()));
#endif
}
}

Recorder& Recorder::instance() { static Recorder recorder; return recorder; }
void Recorder::setCurrentI2cRequest(uint64_t sequence) noexcept { g_currentI2cRequest = sequence; }
uint64_t Recorder::currentI2cRequest() const noexcept { return g_currentI2cRequest; }
void Recorder::setRuntimeIdentity(RuntimeLaunchIdentity identity) noexcept { g_runtimeIdentity = identity; }
RuntimeLaunchIdentity Recorder::runtimeIdentity() const noexcept { return g_runtimeIdentity; }

Recorder::Recorder() {
    const char* mode = std::getenv("LASECSIMUL_CAUSAL_TRACE");
    if (mode && std::strcmp(mode, "detailed") == 0) m_mode = Mode::Detailed;
    else if (mode && std::strcmp(mode, "counters") == 0) m_mode = Mode::Counters;
    if (m_mode == Mode::Off) return;
    m_qpcStart = qpcNow(&m_qpcFrequency);
    m_runId = m_qpcStart ^ (static_cast<uint64_t>(processId()) << 32);
    m_capacity = 1'000'000;
    m_records = new (std::nothrow) Record[m_capacity];
    if (!m_records) { m_capacity = 0; m_mode = Mode::Off; }
}

Recorder::~Recorder() { flush(); delete[] m_records; }

void Recorder::record(EventType type, uint64_t transaction, uint64_t dependency,
                      uint64_t virtualNs, uint32_t fifo, uint32_t irq,
                      uint32_t timer, uint32_t waitReason, uint64_t durationQpc) noexcept {
    if (m_mode == Mode::Off) return;
    if (m_mode == Mode::Counters && type != EventType::I2cEnter && type != EventType::I2cHandled) return;
    const uint64_t index = m_writeIndex.fetch_add(1, std::memory_order_relaxed);
    if (index >= m_capacity) { m_dropped.fetch_add(1, std::memory_order_relaxed); return; }
    Record& r = m_records[index];
    const RuntimeLaunchIdentity identity = runtimeIdentity();
    r = Record{m_runId, identity.sessionExecutionId, identity.runtimeInstanceId,
               identity.launchGeneration, transaction, index + 1, dependency, virtualNs, qpcNow(nullptr),
               processId(), threadId(), static_cast<uint16_t>(type), 0, fifo, irq, timer,
               waitReason, durationQpc, 1u, 0u, 0u};
    m_written.fetch_add(1, std::memory_order_relaxed);
    uint64_t high = m_highWatermark.load(std::memory_order_relaxed);
    while (index + 1 > high && !m_highWatermark.compare_exchange_weak(high, index + 1,
           std::memory_order_relaxed)) {}
}

void Recorder::flush() noexcept {
    if (!m_records || m_written.load(std::memory_order_relaxed) == 0) return;
    const char* path = std::getenv("LASECSIMUL_CAUSAL_TRACE_PATH");
    if (!path || !*path) path = "lasecsimul-causal.trace";
    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    if (!out) return;
    struct Header { char magic[8]; uint32_t version; uint32_t recordSize; uint64_t runId, qpcFrequency, qpcStart, written, dropped, highWatermark; };
    const Header h{{'L','S','C','T','R','C','E','1'}, 2, sizeof(Record), m_runId, m_qpcFrequency,
                   m_qpcStart, m_written.load(), m_dropped.load(), m_highWatermark.load()};
    out.write(reinterpret_cast<const char*>(&h), sizeof(h));
    out.write(reinterpret_cast<const char*>(m_records), static_cast<std::streamsize>(m_written.load() * sizeof(Record)));
}
} // namespace lasecsimul::trace
