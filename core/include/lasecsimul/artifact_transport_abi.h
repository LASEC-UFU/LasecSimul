#ifndef LASECSIMUL_ARTIFACT_TRANSPORT_ABI_H
#define LASECSIMUL_ARTIFACT_TRANSPORT_ABI_H

#include <stdint.h>

#define LASEC_AT_MAGIC UINT64_C(0x4C415443564E4251)
#define LASEC_AT_ABI_MAJOR 1u
#define LASEC_AT_ABI_MINOR 2u
#define LASEC_AT_MAX_LANES 16u
#define LASEC_AT_MAX_ENDPOINTS 64u
#define LASEC_AT_MAX_RESPONSES 16u
#define LASEC_AT_MAX_SNAPSHOTS 64u
#define LASEC_AT_EVENT_PAYLOAD 64u
#define LASEC_AT_SNAPSHOT_BYTES 64u
#define LASEC_AT_BATCH_MAX_SEGMENTS 16u
#define LASEC_AT_KIND_READ_REQUEST 3u
#define LASEC_AT_KIND_WRITE 10u
#define LASEC_AT_KIND_BATCH 11u

typedef enum lasec_at_state { LASEC_AT_CREATED=0, LASEC_AT_STARTING=1,
    LASEC_AT_READY=2, LASEC_AT_RUNNING=3, LASEC_AT_STOPPING=4,
    LASEC_AT_STOPPED=5, LASEC_AT_FAILED=6 } lasec_at_state;

typedef struct lasec_at_event {
    uint64_t timestamp_ns, lane_sequence;
    uint32_t kind, flags, endpoint_id, payload_bytes;
    uint8_t payload[LASEC_AT_EVENT_PAYLOAD];
} lasec_at_event;

typedef struct lasec_at_region_descriptor {
    uint64_t offset, bytes;
    uint32_t stride, count;
} lasec_at_region_descriptor;
typedef struct lasec_at_endpoint_descriptor {
    uint32_t endpoint_id, kind;
    uint64_t q2c_offset, c2a_offset, snapshot_offset;
    uint32_t q2c_depth, event_stride, payload_limit, reserved;
} lasec_at_endpoint_descriptor;
typedef struct lasec_at_lane_descriptor {
    lasec_at_region_descriptor metadata, events;
    uint32_t depth, event_stride;
} lasec_at_lane_descriptor;
typedef struct lasec_at_snapshot_descriptor {
    lasec_at_region_descriptor storage;
    uint32_t schema_id, reserved;
} lasec_at_snapshot_descriptor;
typedef struct lasec_at_c2a_descriptor {
    lasec_at_region_descriptor metadata, events;
    uint32_t depth, event_stride;
} lasec_at_c2a_descriptor;
typedef struct lasec_at_control_page {
    uint64_t magic;
    uint32_t abi_major, abi_minor;
    uint64_t mapping_bytes, execution_id;
    uint32_t lane_count, response_slot_count, descriptor_count, descriptor_capacity;
    uint64_t descriptor_offset, q2c_offset, c2a_offset, snapshot_offset;
    uint64_t core_progress_ns, artifact_progress_ns;
    uint32_t core_state, artifact_state, core_fatal_code, artifact_fatal_code;
    uint64_t core_fatal_seq, artifact_fatal_seq, capability_bits;
    uint32_t endpoint_count, snapshot_count;
    uint64_t lane_descriptor_offset, response_slot_offset;
    uint64_t snapshot_descriptor_offset, c2a_descriptor_offset;
    /* ABI v1.1. Monotonic QEMU_CLOCK_VIRTUAL watermark, published periodically by a QEMUTimer
     * independent of any lane/endpoint activity -- conceptually equivalent to the legacy
     * transport's simu_event() heartbeat, but never published as a lane event and never causes
     * an electrical/dispatch effect. Store-release on the QEMU side, load-acquire on the Core
     * side. Consumed ONLY by McuComponent::pacingPositionNs() as a safe-frontier floor for
     * Scheduler::AdvanceLimitFn -- proves virtual time has genuinely elapsed even when the guest
     * is legitimately silent (WFI, no GPIO/I2C), so the Scheduler's pacing never mistakes an idle
     * guest for a stalled one. Must never feed McuComponent::latestVirtualTimeNs() (that getter
     * measures confirmed *applied* events, not mere elapsed time) and must never be read by the
     * VnextBArbiter or dispatched as if it were guest activity. */
    uint64_t artifact_virtual_time_ns;
    /* ABI v1.2 -- exact lockstep (Core sets `lockstep` before the artifact starts; QEMU honours it
     * only when it runs with -icount, i.e. its virtual clock is instruction-counted). All times are
     * on the artifact's virtual timeline (Core time minus the session origin).
     *  - The artifact never runs past `core_horizon_ns` (the next Core event that may change what
     *    the guest observes asynchronously: an armed GPIO interrupt, an I2C reply...) and holds its
     *    vCPUs, virtual clock frozen, whenever it needs the Core: on reaching that horizon, on a GPIO_IN
     *    read at or after `core_input_horizon_ns` (the next Core event of any kind -- it may move a
     *    pad) or after a write it has not synced yet, and right after a register write whose
     *    consequences the Core may deliver at once (any write while a GPIO interrupt is armed, and
     *    writes to peripherals other than GPIO/IO_MUX/UART/SPI/LEDC). To request a
     *    sync it stores artifact_virtual_time_ns = the instant it holds at, then increments
     *    `artifact_sync_seq` (release).
     *  - The Core never advances past artifact_virtual_time_ns. After processing every event up to
     *    an instant it stores core_horizon_ns, core_time_ns and then core_sync_seq = the
     *    artifact_sync_seq it had observed before reading the lanes (release).
     *  - The artifact releases the hold when core_sync_seq == artifact_sync_seq and core_time_ns
     *    reaches its instant; it first consumes responses and C2A, so inputs land at that instant.
     * Real-time lockstep (`lockstep_realtime` nonzero, also set before the artifact starts): with
     * every publish the Core also stores `core_realtime_schedule_ns`, the instant the simulation
     * should be at by its real-time pacing (0 = no pacing). When the host cannot execute the guest
     * fast enough to keep that schedule, the artifact stretches the virtual time of each instruction
     * (as if the CPU had wait states) instead of letting the whole simulation fall behind; it returns
     * to one instruction per CPU cycle as soon as the host keeps up. Timers, peripherals and every
     * Core sync stay on the same virtual timeline -- only instruction timing changes. The artifact
     * publishes the stretch it applies in `artifact_cpu_dilation_q16` (Q16.16, 65536 = exact). */
    uint64_t artifact_sync_seq;
    uint64_t core_sync_seq;
    uint64_t core_time_ns;
    uint64_t core_horizon_ns;
    uint64_t core_input_horizon_ns;
    uint32_t lockstep, lockstep_realtime;
    uint64_t core_realtime_schedule_ns;
    uint32_t artifact_cpu_dilation_q16, artifact_reserved;
} lasec_at_control_page;
typedef struct lasec_at_response_slot {
    uint64_t request_seq, response_seq;
    int32_t status;
    uint32_t payload_bytes;
    uint8_t payload[LASEC_AT_EVENT_PAYLOAD];
} lasec_at_response_slot;
typedef struct lasec_at_ring_header { uint64_t write_seq, read_seq; } lasec_at_ring_header;
typedef struct lasec_at_snapshot {
    uint64_t publish_seq;
    uint8_t data[LASEC_AT_SNAPSHOT_BYTES];
} lasec_at_snapshot;

#endif
