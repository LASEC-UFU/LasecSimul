# PROJECT CONSTITUTION — LasecSimul VNEXT_B / ESP32

## Goal

Finish production VNEXT_B ESP32 integration while preserving ESP32 functional/timing fidelity and supporting the shared-host classroom target of approximately 16 isolated sessions.

## Fundamental rules

1. Core remains the causal arbiter.
2. ProducerLane means ownership/order, NOT an OS thread.
3. QEMU must never synchronously wait for Core while holding BQL.
4. No queue overwrite.
5. No busy-spin.
6. No normal fallback polling.
7. No per-device/session/lane/endpoint transport thread.
8. No unbounded worker/waiter/queue.
9. Doorbells carry no semantic state; shared memory is authoritative.
10. Causal response = ResponseSlot + Core→Artifact doorbell. Do not recreate redundant causal I2C C2A notifications.
11. Local bounded backpressure = `STOP_AFTER_SUCCESSFUL_FINAL_CREDIT_PUBLICATION`.
12. Exactly-once publication/replay semantics must remain intact.
13. Faster != more faithful. Fidelity wins.

## Generic VNEXT transport constitution

Primitives: CONTROL, EVENT, BATCH, RESPONSE, SNAPSHOT.

C2A is the generic asynchronous/event channel, not a sixth semantic primitive.

ESP32 ProducerLanes correspond to CPU0/CPU1 logical producer ownership. Lane != thread.

C2A is SPSC: Core sole producer, one logical QEMU consumer.

Exactly two semantic doorbells per attachment:

- Artifact→Core
- Core→Artifact

## Intended resource architecture

- one shared `VnextBWaitDispatcher` thread per Core process;
- fixed dispatcher capacity;
- one Artifact→Core registration per attachment;
- two semantic events per attachment;
- one mapping per attachment;
- VNEXT timers = 0;
- transport threads per device/lane/endpoint/session = 0;
- dynamic waiter map = 0;
- unbounded transport queue = 0;
- semantic shared mutex = 0.

## Historical hazards — DO NOT REPEAT

- Releasing BQL during synchronous Core wait caused reentrant device access.
- Holding BQL through arenaOrderLock caused a severe hang.
- Redundant causal I2C C2A tokens accumulated until ring FULL.
- Per-operation fprintf/fflush materially distorted multi-QEMU timing.
- `tb-size=64M` was invalid/ignored in the historical configuration. Use numeric `64`.
- CPU1 MWDT compensation has NOT been causally justified.
- Reset masks identify reset domains; source/caller must be traced.

## Current production launch intent

- MTTCG / `thread=multi`
- `LASECSIMUL_QEMU_TB_SIZE=64`
- effective `tb-size=64`
- `LASECSIMUL_VNEXT_TRACE` OFF by default
- historical rollback QEMU untouched

Historical rollback SHA-256:

`471AE54193CC7A86F6A448D53BC1E810F5B50D6EBAD1FE48FC34AA04F56F74CE`

## Fidelity triangle

REAL HARDWARE ↔ REFERENCE/LEGACY ↔ VNEXT/FAST

Legacy/reference is comparative evidence, not an oracle.

## Completion

Do not emit `PRODUCTION VNEXT_B ESP32 INTEGRATION PASS` or `VNEXT_B ESP32 PRODUCTION IMPLEMENTATION COMPLETE` until every applicable item in `.ai/FINAL_CHECKLIST.md` is green.
