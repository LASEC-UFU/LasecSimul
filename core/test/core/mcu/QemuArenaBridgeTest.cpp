#include "mcu/qemu/QemuArenaBridge.hpp"
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
    bridge.open(QemuArenaOpenOptions{uniqueArenaName(), true});
    assert(bridge.isOpen());
    assert(bridge.arena() != nullptr);

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
    bridge.open(QemuArenaOpenOptions{uniqueArenaName(), true});
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
    bridge.open(QemuArenaOpenOptions{uniqueArenaName(), true});

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
    bridge.open(QemuArenaOpenOptions{uniqueArenaName(), true});
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
    bridge.open(QemuArenaOpenOptions{uniqueArenaName(), true});

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

} // namespace

int main() {
    testOpenPollAndAcknowledge();
    testDispatchUsesSortedRegions();
    testPollWithDispatch();
    testQueueMultipleEntriesDrainInOrder();
    testPollReadAcknowledgesViaQemuAction();
    testLegacySlotAckNeverConsumesNewQueueEntry();
    std::printf("OK: QemuArenaBridge open, poll and dispatch passed.\n");
    return 0;
}
