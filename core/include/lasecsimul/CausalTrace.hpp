#pragma once

#include <atomic>
#include <cstdint>
#include "Types.hpp"

namespace lasecsimul::trace {

enum class Mode : uint8_t { Off = 0, Counters = 1, Detailed = 2 };

enum class EventType : uint16_t {
    CoreI2cEnter = 1, CoreI2cHandled = 2, I2cFallback = 3,
    I2cEnter = CoreI2cEnter, I2cHandled = CoreI2cHandled,
    QemuI2cRequestReady = 20, QemuI2cRequestPublished = 21,
    CoreI2cCompletionPublished = 22, QemuI2cCompletionObserved = 23,
    PollWake = 10, PollDispatch = 11, PollWait = 12,
    /* TEMPORARY, minimal diagnostic for the 2026-08-27 TG0WDT_SYS_RESET investigation, Light Pass 3 --
     * C0: request claimed by the background poll thread, before CoreI2cEnter's topology resolution.
     * Together with the existing CoreI2cEnter/CoreI2cCompletionPublished and QEMU's T0/T1/T5, this is
     * the minimum needed to decompose T1->C0 (pickup/wake), C0->C6 (Core service), C6->T5 (QEMU
     * observation). The finer device-mutex/plugin-compute breakpoints (Pass 2) were removed once Pass
     * 2 showed that segment cheap and stable in the (non-degraded) run it measured -- reduced here to
     * cut per-transaction QPC/recorder overhead, not because that segment is cleared for the
     * degradation regime, which Pass 2 never reproduced. Remove once the investigation concludes. */
    CoreI2cBurstClaimed = 30,
};

struct Record {
    uint64_t runId;
    uint64_t sessionExecutionId;
    uint64_t runtimeInstanceId;
    uint64_t launchGeneration;
    uint64_t transactionSequence;
    uint64_t eventSequence;
    uint64_t dependencySequence;
    uint64_t virtualNs;
    uint64_t qpcTicks;
    uint32_t processId;
    uint32_t threadId;
    uint16_t eventType;
    uint16_t phase;
    uint32_t fifoState;
    uint32_t irqState;
    uint32_t timerState;
    uint32_t waitReason;
    uint64_t durationQpc;
    uint32_t sourceId;
    uint16_t schemaPhase;
    uint16_t reserved0;
};
// O layout é validado no header gravado pelo recorder (recordSize); não presumimos
// padding idêntico entre toolchains.

class Recorder final {
public:
    static Recorder& instance();
    Mode mode() const noexcept { return m_mode; }
    uint64_t nextTransaction() noexcept { return m_transaction.fetch_add(1, std::memory_order_relaxed) + 1; }
    void setCurrentI2cRequest(uint64_t sequence) noexcept;
    uint64_t currentI2cRequest() const noexcept;
    void setRuntimeIdentity(RuntimeLaunchIdentity identity) noexcept;
    RuntimeLaunchIdentity runtimeIdentity() const noexcept;
    void record(EventType type, uint64_t transaction, uint64_t dependency = 0,
                uint64_t virtualNs = 0, uint32_t fifo = 0, uint32_t irq = 0,
                uint32_t timer = 0, uint32_t waitReason = 0,
                uint64_t durationQpc = 0) noexcept;
    uint64_t written() const noexcept { return m_written.load(std::memory_order_relaxed); }
    uint64_t dropped() const noexcept { return m_dropped.load(std::memory_order_relaxed); }
    uint64_t highWatermark() const noexcept { return m_highWatermark.load(std::memory_order_relaxed); }

private:
    Recorder();
    ~Recorder();
    void flush() noexcept;
    Mode m_mode{Mode::Off};
    uint64_t m_runId{0};
    uint64_t m_qpcFrequency{0};
    uint64_t m_qpcStart{0};
    uint64_t m_capacity{0};
    Record* m_records{nullptr};
    std::atomic<uint64_t> m_writeIndex{0};
    std::atomic<uint64_t> m_written{0};
    std::atomic<uint64_t> m_dropped{0};
    std::atomic<uint64_t> m_highWatermark{0};
    std::atomic<uint64_t> m_transaction{0};
};

} // namespace lasecsimul::trace
