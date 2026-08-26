#include "mcu/qemu/QemuArenaBridge.hpp"
#include <atomic>
#include <array>
#include <cassert>
#include <chrono>
#include <cstdio>
#include <string>
#include <vector>

using namespace lasecsimul;
using namespace lasecsimul::mcu::qemu;

namespace {

std::string uniqueArenaName() {
    return "lasecsimul-arena-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
}

/** PERF-13 (protocolo v3, ver qemu_arena_abi.h): publica uma entrada na fila de escritas/
 * heartbeat -- mesmo mecanismo que simuliface.c::pushQueueEntry() usa do lado QEMU real. */
void pushQueueEntry(LsdnQemuArena& arena, uint64_t addr, uint64_t data, uint64_t action, uint64_t simuTimePs) {
    const uint64_t slot = arena.queueWriteIndex % LSDN_QEMU_ARENA_QUEUE_DEPTH;
    arena.queue[slot].regAddr = addr;
    arena.queue[slot].regData = data;
    arena.queue[slot].simuAction = action;
    arena.queue[slot].simuTime = simuTimePs;
    arena.queueWriteIndex++;
}

void testOpenPollAndAcknowledge() {
    QemuArenaBridge bridge;
    bridge.open(QemuArenaOpenOptions{
        uniqueArenaName(), true, QemuArenaProtocol::V5});
    assert(bridge.isOpen());
    assert(bridge.arena() != nullptr);
    assert(bridge.protocolMajor() == LSDN_QEMU_ARENA_ABI_MAJOR);
    assert(bridge.descriptor() != nullptr);
    assert(bridge.descriptor()->magic == LSDN_QEMU_ARENA_ABI_MAGIC);
    assert(bridge.descriptor()->descriptorSize ==
           sizeof(LsdnQemuArenaDescriptor));
    assert(bridge.descriptor()->arenaSize == sizeof(LsdnQemuArenaV5Mapping));
    assert(bridge.descriptor()->transportSize == sizeof(LsdnQemuArena));
    assert(bridge.descriptor()->queueDepth == LSDN_QEMU_ARENA_QUEUE_DEPTH);
    assert(bridge.descriptor()->coreCapabilities ==
           LSDN_QEMU_ARENA_CAPABILITIES);
    assert(bridge.descriptor()->coreReady == 1);
    assert(!bridge.peerReady());

    auto* descriptor =
        const_cast<LsdnQemuArenaDescriptor*>(bridge.descriptor());
    descriptor->qemuCapabilities = LSDN_QEMU_ARENA_CAPABILITIES;
    descriptor->negotiatedCapabilities = LSDN_QEMU_ARENA_CAPABILITIES;
    std::atomic_ref<uint64_t>(descriptor->qemuReady)
        .store(1, std::memory_order_release);
    assert(bridge.peerReady());
    assert(bridge.negotiatedCapabilities() ==
           LSDN_QEMU_ARENA_CAPABILITIES);

    bridge.arena()->qemuTime = 7;
    bridge.arena()->running = true;
    pushQueueEntry(*bridge.arena(), 0x40000000, 0x1234, LSDN_SIM_FREQ, 42);

    const QemuPollResult result = bridge.poll();
    assert(result.hasEvent);
    assert(result.event.has_value());
    assert(result.event->simuTimePs == 42);
    assert(result.event->regData == 0x1234);
    assert(bridge.arena()->queueReadIndex != bridge.arena()->queueWriteIndex); // poll() não confirma por si só

    bridge.acknowledgeWrite();
    assert(bridge.arena()->queueReadIndex == bridge.arena()->queueWriteIndex);

    bridge.close();
    assert(!bridge.isOpen());
}

void testDispatchUsesSortedRegions() {
    QemuArenaBridge bridge;
    const std::vector<MemoryRegion> regions = {
        MemoryRegion{0x3000, 0x30ff, ModuleKind::Spi, 1},
        MemoryRegion{0x1000, 0x10ff, ModuleKind::Gpio, 0},
        MemoryRegion{0x2000, 0x20ff, ModuleKind::I2c, 0},
    };
    bridge.setMemoryRegions(regions);

    const QemuDispatchResult gpio = bridge.dispatch(0x1080);
    assert(gpio.matched);
    assert(gpio.region.moduleKind == ModuleKind::Gpio);
    assert(gpio.region.moduleIndex == 0);

    const QemuDispatchResult spi = bridge.dispatch(0x3001);
    assert(spi.matched);
    assert(spi.region.moduleKind == ModuleKind::Spi);
    assert(spi.region.moduleIndex == 1);

    const QemuDispatchResult missing = bridge.dispatch(0x4000);
    assert(!missing.matched);
    assert(!missing.error.empty());
}

void testPollWithDispatch() {
    QemuArenaBridge bridge;
    bridge.setMemoryRegions(std::vector<MemoryRegion>{MemoryRegion{0x1000, 0x10ff, ModuleKind::Usart, 2}});
    bridge.open(QemuArenaOpenOptions{
        uniqueArenaName(), true, QemuArenaProtocol::V5});
    pushQueueEntry(*bridge.arena(), 0x1004, 0xAB, LSDN_SIM_WRITE, 1);

    const QemuPollResult result = bridge.poll();
    assert(result.hasEvent);
    assert(result.dispatch.has_value());
    assert(result.dispatch->matched);
    assert(result.dispatch->region.moduleKind == ModuleKind::Usart);

    bridge.acknowledgeWrite();
    assert(bridge.arena()->queueReadIndex == bridge.arena()->queueWriteIndex);
}

void testQueueMultipleEntriesDrainInOrder() {
    // PERF-13: prova que a fila realmente comporta N entradas pendentes (não mais 1 slot só) e
    // que poll()/acknowledgeWrite() as drenam na ordem em que foram publicadas.
    QemuArenaBridge bridge;
    bridge.setMemoryRegions(std::vector<MemoryRegion>{MemoryRegion{0x1000, 0x10ff, ModuleKind::Gpio, 0}});
    bridge.open(QemuArenaOpenOptions{
        uniqueArenaName(), true, QemuArenaProtocol::V5});

    pushQueueEntry(*bridge.arena(), 0x1004, 0x11, LSDN_SIM_WRITE, 10);
    pushQueueEntry(*bridge.arena(), 0x1008, 0x22, LSDN_SIM_WRITE, 20);
    pushQueueEntry(*bridge.arena(), 0x100C, 0x33, LSDN_SIM_WRITE, 30);
    assert(bridge.arena()->queueWriteIndex - bridge.arena()->queueReadIndex == 3);

    const QemuPollResult first = bridge.poll();
    assert(first.hasEvent && first.event->regData == 0x11 && first.event->simuTimePs == 10);
    bridge.acknowledgeWrite();

    const QemuPollResult second = bridge.poll();
    assert(second.hasEvent && second.event->regData == 0x22 && second.event->simuTimePs == 20);
    bridge.acknowledgeWrite();

    const QemuPollResult third = bridge.poll();
    assert(third.hasEvent && third.event->regData == 0x33 && third.event->simuTimePs == 30);
    bridge.acknowledgeWrite();

    assert(bridge.arena()->queueReadIndex == bridge.arena()->queueWriteIndex);
    const QemuPollResult empty = bridge.poll();
    assert(!empty.hasEvent);
}

void testPollReadAcknowledgesViaQemuAction() {
    QemuArenaBridge bridge;
    bridge.setMemoryRegions(std::vector<MemoryRegion>{MemoryRegion{0x1000, 0x10ff, ModuleKind::Gpio, 0}});
    bridge.open(QemuArenaOpenOptions{
        uniqueArenaName(), true, QemuArenaProtocol::V5});
    bridge.arena()->simuTime = 1;
    bridge.arena()->simuAction = LSDN_SIM_READ;
    bridge.arena()->regAddr = 0x103C;

    const QemuPollResult result = bridge.poll();
    assert(result.hasEvent);
    assert(result.dispatch->matched);

    bridge.acknowledgeRead(0xCAFEu);
    assert(bridge.arena()->regData == 0xCAFEu);
    assert(bridge.arena()->qemuAction == LSDN_SIM_READ);
    assert(bridge.arena()->simuTime == 0);
}

void testLegacySlotAckNeverConsumesNewQueueEntry() {
    QemuArenaBridge bridge;
    bridge.open(QemuArenaOpenOptions{
        uniqueArenaName(), true, QemuArenaProtocol::V5});

    // Reproduz a corrida real: QEMU antigo publica SIM_FREQ no slot; depois do poll() e antes do
    // ACK chega uma escrita na fila. O ACK do slot não pode avançar queueReadIndex.
    bridge.arena()->simuTime = 100;
    bridge.arena()->simuAction = LSDN_SIM_FREQ;
    bridge.arena()->regAddr = 80'000'000;
    bridge.arena()->regData = 240'000'000;

    const QemuPollResult legacy = bridge.poll();
    assert(legacy.hasEvent && legacy.event.has_value());
    assert(!legacy.event->fromQueue);

    pushQueueEntry(*bridge.arena(), 0x3FF49038, 0x2A00, LSDN_SIM_WRITE, 101);
    bridge.acknowledgeEventSlot();
    assert(bridge.arena()->simuTime == 0);
    assert(bridge.arena()->queueReadIndex == 0);
    assert(bridge.arena()->queueWriteIndex == 1);

    const QemuPollResult queued = bridge.poll();
    assert(queued.hasEvent && queued.event.has_value());
    assert(queued.event->fromQueue);
    assert(queued.event->regAddr == 0x3FF49038);
    assert(queued.event->regData == 0x2A00);
    bridge.acknowledgeWrite();
    assert(bridge.arena()->queueReadIndex == bridge.arena()->queueWriteIndex);
}

void testI2cMailboxRoundTrip() {
    QemuArenaBridge bridge;
    bridge.open(QemuArenaOpenOptions{
        uniqueArenaName(), true, QemuArenaProtocol::V5});
    LsdnQemuArena& arena = *bridge.arena();
    arena.i2cTimePs = 123'456;
    arena.i2cBus = 1;
    arena.i2cFlags = 1u | 2u | 4u;
    arena.i2cPeriodNs = 2'500;
    arena.i2cTxLen = 3;
    arena.i2cRxLen = 2;
    arena.i2cTx[0] = 0x85;
    arena.i2cTx[1] = 0x10;
    arena.i2cTx[2] = 0x20;
    std::atomic_ref<uint64_t>(arena.i2cRequestSeq)
        .store(7, std::memory_order_release);

    const auto pending = bridge.pollI2cBurst();
    assert(pending.has_value());
    assert(pending->sequence == 7 && pending->timePs == 123'456);
    assert(pending->bus == 1 && pending->flags == 7 && pending->periodNs == 2'500);
    assert(pending->txLen == 3 && pending->rxLen == 2);
    assert(pending->tx[0] == 0x85 && pending->tx[1] == 0x10 && pending->tx[2] == 0x20);

    const std::array<uint8_t, 2> rx{0xAB, 0xCD};
    bridge.completeI2cBurst(7, 3u, UINT32_MAX, rx, 900);
    assert(std::atomic_ref<uint64_t>(arena.i2cResponseSeq)
               .load(std::memory_order_acquire) == 7);
    assert(arena.i2cStatus == 3u && arena.i2cFirstNack == UINT32_MAX);
    assert(arena.i2cRxLen == 2 && arena.i2cRx[0] == 0xAB && arena.i2cRx[1] == 0xCD);
    assert(arena.i2cStretchNs == 900);
    assert(!bridge.pollI2cBurst().has_value());
}

void testV3RollbackKeepsLegacyPayload() {
    QemuArenaBridge bridge;
    bridge.open(QemuArenaOpenOptions{
        uniqueArenaName(), true, QemuArenaProtocol::V3});
    assert(bridge.isOpen());
    assert(bridge.protocolMajor() == 3);
    assert(bridge.descriptor() == nullptr);
    assert(bridge.negotiatedCapabilities() == 0);

    bridge.arena()->running = 1;
    assert(bridge.peerReady());
    pushQueueEntry(*bridge.arena(), 0x1000, 0x55, LSDN_SIM_WRITE, 7);
    const QemuPollResult result = bridge.poll();
    assert(result.hasEvent && result.event->regData == 0x55);
    bridge.acknowledgeWrite();
    assert(bridge.arena()->queueReadIndex ==
           bridge.arena()->queueWriteIndex);
}

void testV5RejectsMissingRequiredCapability() {
    QemuArenaBridge bridge;
    bridge.open(QemuArenaOpenOptions{
        uniqueArenaName(), true, QemuArenaProtocol::V5});
    auto* descriptor =
        const_cast<LsdnQemuArenaDescriptor*>(bridge.descriptor());
    const uint64_t incomplete =
        LSDN_QEMU_ARENA_CAPABILITIES &
        ~LSDN_QEMU_ARENA_CAP_MTTCG_MPSC_SERIALIZED;
    descriptor->qemuCapabilities = incomplete;
    descriptor->negotiatedCapabilities = incomplete;
    std::atomic_ref<uint64_t>(descriptor->qemuReady)
        .store(1, std::memory_order_release);

    const QemuPollResult result = bridge.poll();
    assert(!result.hasEvent);
    assert(!result.error.empty());
}

} // namespace

int main() {
    testOpenPollAndAcknowledge();
    testDispatchUsesSortedRegions();
    testPollWithDispatch();
    testQueueMultipleEntriesDrainInOrder();
    testPollReadAcknowledgesViaQemuAction();
    testLegacySlotAckNeverConsumesNewQueueEntry();
    testI2cMailboxRoundTrip();
    testV3RollbackKeepsLegacyPayload();
    testV5RejectsMissingRequiredCapability();
    std::printf(
        "OK: QemuArenaBridge ABI v5, rollback v3, mailbox, poll and dispatch passed.\n");
    return 0;
}
