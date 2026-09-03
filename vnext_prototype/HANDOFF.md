# LasecSimul Artifact Transport vNext-B - foundation handoff

Status: **VNEXT FOUNDATION PROTOTYPE PASS**

Final document status:

**VNEXT FOUNDATION PROTOTYPE PASS**

**FOUNDATION FROZEN**

## Scope and ownership

This document records the completed isolated foundation prototype only. No Core or QEMU production integration is part of this handoff.

The transport primitives are CONTROL, EVENT, BATCH, RESPONSE and SNAPSHOT. There are exactly two semantic doorbell directions: Artifact -> Core and Core -> Artifact. Shared memory is the semantic source of truth; Events provide normal wake/liveness. The model is one true SPSC Q2C ProducerLane per producer and one true SPSC async C2A ring, with no transport mutex, dynamic waiter registry, per-device mailbox, busy-spin or BQL-held wait.

Core/session ownership covers immutable execution and layout fields. Runtime state has split Core and Artifact writers, with both failures observable. Response waiters return locally on execution change, peer failure or shutdown. All timestamps are uint64 nanoseconds relative to execution_id.

The wire header is C-compatible and fixed-width/POD. `include/shared_atomic.h` is the normative access contract for aligned uint32_t/uint64_t storage and sequentially consistent operations. No mutex fallback exists. The local first implementation is host-native/little-endian.

## Authoritative gate closure

WIRE_CONTAINER_VALIDATION PASS

MAPPING_VIEW_ROUNDTRIP PASS

C2A PASS

FAULT_INJECTION_RECOVERY PASS

STALE_EXECUTION PASS

P10_COMBINED PASS

LANE_LOCAL_BACKPRESSURE PASS

PROCESS_DEATH PASS

16_SESSION_STRUCTURAL_SCALE PASS

SESSION_FAILURE_ISOLATION PASS

EXECUTION_POLICY_INDEPENDENCE PASS

ESP32_SUFFICIENCY PASS

GENERIC_ARTIFACT_SUFFICIENCY PASS

FINAL_RESOURCE_ACCOUNTING PASS

The separate doorbell concepts are:

- cross-process Windows doorbell PASS
- fault-injection notification recovery PASS

The complete wire-container validator rejects malformed containers, unknown mandatory capabilities, invalid ResponseSlot and region offset/count/stride/alignment/extent/max relationships, invalid endpoint/lane/response/snapshot counts, invalid snapshot references, invalid Q2C/C2A relationships, and overlapping regions. Invalid mappings produce no MappingView.

MappingView reconstructs endpoint views, producer lanes, Q2C metadata and slots, response slots, snapshots, and C2A metadata and slots from only mapping base and mapping size after complete validation.

Stale execution payloads, response slots, snapshots, C2A entries, generations, lifecycle/progress/fatal state, and waiter completions are rejected after execution_id changes.

## Measured layout and resources

`mapping_layout.hpp` calculates a checked, 64-byte-aligned serialized container containing endpoint, lane, snapshot, ring metadata, response, Q2C and C2A regions. Final measured builder values:

- Tiny: 7168 B
- ESP32-like: 12352 B
- 4-lane: 21248 B

Wire sizes are: event 96 bytes, control page 176 bytes, response slot 88 bytes, snapshot 72 bytes, endpoint descriptor 48 bytes, region descriptor 24 bytes, lane descriptor 56 bytes, snapshot descriptor 32 bytes, and C2A descriptor 56 bytes.

Native resources are two named Windows Event kernel objects per transport direction pair; there are no per-lane or per-endpoint Event objects and no shared transport mutexes. Normal waits use INFINITE after state publication, SetEvent, ResetEvent and predicate/generation recheck. Finite timeout is limited to explicit fault-injection recovery.

Creation limits are 16 lanes, 64 endpoints, 16 response slots, 64 snapshots, lane/C2A depth 1024, event payload 64 bytes, and 16 BATCH segments.

## Authoritative runner output

The final `run_foundation_tests.ps1` output was:

```text
C layout PASS
C++ layout PASS
vnext synthetic PASS
cross-process doorbell PASS
foundation verification PASS
mapping validation PASS
mapping layout PASS 7168 12352 21248
WIRE_CONTAINER_VALIDATION PASS
idle wake policy PASS
C2A PASS
FAULT_INJECTION_RECOVERY PASS
cross-process snapshot PASS
MAPPING_VIEW_ROUNDTRIP PASS
STALE_EXECUTION PASS
P10_COMBINED PASS
LANE_LOCAL_BACKPRESSURE PASS
PROCESS_DEATH PASS
16_SESSION_STRUCTURAL_SCALE PASS
SESSION_FAILURE_ISOLATION PASS
EXECUTION_POLICY_INDEPENDENCE PASS
ESP32_SUFFICIENCY PASS
GENERIC_ARTIFACT_SUFFICIENCY PASS
FINAL_RESOURCE_ACCOUNTING PASS
VNEXT FOUNDATION PROTOTYPE PASS
```

Authoritative suite entry point: `powershell -ExecutionPolicy Bypass -File .\run_foundation_tests.ps1`.

No further foundation gates are pending. The foundation is frozen. No commit or push was performed.
