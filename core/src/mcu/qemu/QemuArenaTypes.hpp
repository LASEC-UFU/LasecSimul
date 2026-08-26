#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include "lasecsimul/Types.hpp"
#include "lasecsimul/qemu_arena_abi.h"

namespace lasecsimul::mcu::qemu {

enum class QemuArenaProtocol : uint32_t {
    Environment = 0,
    V3 = 3,
    V5 = LSDN_QEMU_ARENA_ABI_MAJOR,
};

struct QemuArenaOpenOptions {
    std::string name;
    bool createIfMissing = true;
    QemuArenaProtocol protocol = QemuArenaProtocol::Environment;
};

/** Cópia dos campos da `LsdnQemuArena` no momento do `poll()` -- ver qemu_arena_abi.h pro
 * protocolo completo (registrador bruto: regAddr/regData, SIM_READ/SIM_WRITE, IRQ). */
struct QemuArenaEvent {
    uint64_t simuTimePs = 0;
    uint64_t qemuTimePs = 0;
    uint64_t regData = 0;
    uint64_t regAddr = 0;
    uint64_t irqNumber = 0;
    uint64_t irqLevel = 0;
    uint64_t simuAction = 0;
    int64_t loopTimeoutNs = 0;
    double psPerInst = 0.0;
    bool running = false;
    /** true quando veio da fila circular; false quando veio do slot síncrono legado. O ACK deve
     * seguir a origem, nunca apenas simuAction, pois QEMUs antigos também publicam SIM_FREQ no slot. */
    bool fromQueue = false;
};

struct QemuDispatchResult {
    bool matched = false;
    MemoryRegion region;
    std::string error;
};

struct QemuPollResult {
    bool hasEvent = false;
    std::optional<QemuArenaEvent> event;
    std::optional<QemuDispatchResult> dispatch;
    std::string error;
};

struct QemuI2cBurst {
    uint64_t sequence = 0;
    uint64_t timePs = 0;
    uint32_t bus = 0;
    uint32_t flags = 0;
    uint64_t periodNs = 0;
    uint32_t txLen = 0;
    uint32_t rxLen = 0;
    uint8_t tx[64]{};
};

} // namespace lasecsimul::mcu::qemu
