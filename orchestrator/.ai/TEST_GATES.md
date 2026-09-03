# TEST GATES

## Historically established

- VNEXT FOUNDATION PROTOTYPE PASS
- foundation frozen
- P9 restart managed lifecycle PASS
- P9 restart real progress PASS
- stale wait callback rejected PASS
- I2C inflight stop quiescence PASS
- I2C restart isolation PASS
- no-poll restart PASS
- dispatcher restart reuse PASS
- P9 I2C backpressure PASS
- VNEXT resource architecture PASS
- production 16-session normal scale PASS
- production 16-idle-session PASS
- failed-session resources reclaimed PASS
- explicit CPU ownership audit PASS

Re-run where required after a production semantic fix. Do not casually mark these failed because an unrelated diagnostic harness has a setup issue.

## Closed in current review

### PRODUCTION_SESSION_FAILURE_ISOLATION

Closed from E019 after reviewer approval. The canonical 16-session validation
passed all required checks. No root cause or semantic architecture change is
declared.

## Closed in current review

### PRODUCTION_COMBINED_WORKLOAD

Status: CLOSED from E021 after reviewer approval. The canonical 16-session
combined workload passed with architecture, timeout behavior, and frozen
semantics unchanged.

Final required form:

- population 16 qualifies
- kill one victim
- victim detected
- reclaim 16→15
- 15/15 survivors maintain/recover real progress
- replacement A2 admitted
- same dispatcher instance
- 15/15 survivor continuity during replacement
- A2 progress
- no wrong-session/stale/duplicate/lost semantic effects
- no unexpected reset attributable to artificial VNEXT blocking

Diagnostic 10/12-session runs may locate defects but do not replace this final gate.

### SHARED_DISPATCHER_FAIRNESS

Status: VALIDATED by E022 using the smallest existing runtime harness topology:
two concurrent VNEXT_B sessions with the shared dispatcher and failure-isolation
checks. Both sessions admitted and the survivor/replacement path completed with
same-dispatcher identity and no stale effects.

### FINAL_RESOURCE_ACCOUNTING

Status: PASS from E024. The existing `run_foundation_tests.ps1` runner and
`remaining_gates_test.cpp` completed with exit code 0, including the explicit
`FINAL_RESOURCE_ACCOUNTING PASS` result and complete foundation-suite pass.

### VNEXT_PRODUCTION_TCG_CONFIGURATION

Status: CLOSED from E025 after reviewer approval. The direct adapter target
passed default MTTCG/thread=multi and deterministic rollback assertions; the
canonical production logs use numeric `tb-size=64` with thread=multi. No
semantic change was made.

### FINAL ABI ALIGNMENT

Status: CLOSED from E026 after reviewer approval. The
shared `artifact_transport_abi.h` definitions are used by Core and the
production attachment, while QEMU's vNext-B mirror preserves the same field
order and fixed-width layout. Existing C/C++ layout checks establish event
96 B, control page 176 B, response slot 88 B, snapshot 72 B, endpoint 48 B,
region 24 B, lane 56 B, snapshot descriptor 32 B, and C2A descriptor 56 B.
No mismatch or semantic ABI change was found.

### ESP32_MWDT_LOAD_INDEPENDENCE

Status: **PASS (device level)** from E101, 2026-09-03. E027's source audit
(virtual-time/APB-based accounting, no host-time or host-scheduler input,
transport-pause compensation limited to CPU0/TG0) is now backed by a measured
16-session run: a fed bare-metal guest took zero MWDT resets across 16
concurrent canonical-QEMU instances over 180 s at the strictest
`LASECSIMUL_ESP32_WDT_SCALE=1`, while the paired unfed control reset in 16/16
instances and the validity arm proved all 16 instances armed the watchdog.

Not yet covered: the same property through the production Core/VNEXT_B path,
which is the only path that exercises the TG0/CPU0 transport-pause
compensation. See `NEXT_ACTION.md`. No semantic watchdog change was made.

### ESP32_MWDT_BEHAVIOR

Status: **PASS (device level)** from E098 + E101, 2026-09-03.

Required form - "fed survives load; unfed still resets" - demonstrated with
`vnext_prototype/guest_mwdt_baremetal`, a bare-metal fixture that is the only
writer of `TIMG_WDT` in the guest:

- unfed, single instance: 10 MWDT_SYS_STAGE resets / 40 s, TG0 `cause0=7`,
  TG1 `cause0=8` - stage mode and per-group reset routing confirmed;
- fed, single instance: 0 MWDT resets, only the cold-boot pair;
- at 16 concurrent sessions over 180 s: unfed 16/16 instances resetting,
  fed 0/16, with a validity arm proving all 16 fed-path instances armed.

This supersedes E029, which could not establish stage modes, deadlines or reset
routing because the framework guest fed the watchdog itself. No watchdog/reset
semantic change was made; the fixture is test-only and lives outside production
paths.

**Production path: OPEN.** Two real defects were found, fixed, built and
regression-tested, but they were not the cause of the residual failure.

Fixed and validated (E102, E103, E106): three unbounded per-operation
diagnostic sites produced 99.97% of all QEMU output, and the worst sat outside
the watchdog's compensated pause window. After the fix a 16-session run emits
~2,600 lines instead of 258,247, and every session's reset records survive
Core's 1 MiB retained log. The ten-test Core regression set is identical on the
patched and pre-patch binaries.

Not fixed (E105): a fed guest still takes MWDT-attributed resets under load.

```text
sessions   MWDT-attributed resets
   1, 4, 8    0
  12          2
  16          4, 0, 6, 4, 4     (five runs)
```

Clean through 8 sessions, intermittent from 12. Leading hypothesis is host CPU
oversubscription in MTTCG-realtime, not the transport - unproven. Raising
`wdt_time_scale` past its cap of 100 would be a watchdog semantic change,
frozen by DECISION-004.

Also still open, and a separate subject: official ESP-IDF IWDT *policy*
conformance. That is not what this gate asks for; conflating the two is what
caused the iterations 61-90 spiral.

## Gates after failure isolation

1. PRODUCTION_COMBINED_WORKLOAD PASS
2. SHARED_DISPATCHER_FAIRNESS PASS
3. FINAL_RESOURCE_ACCOUNTING PASS
4. VNEXT_PRODUCTION_TCG_CONFIGURATION PASS
5. final ABI alignment check
6. ESP32_MWDT_LOAD_INDEPENDENCE PASS
7. ESP32_MWDT_BEHAVIOR PASS
8. VNEXT_LEGACY_DEPENDENCY_AUDIT PASS
9. ESP32_SUPPORT_MATRIX_AUDIT PASS
10. FINAL_FIDELITY_REVIEW PASS
11. FINAL_SOURCE_AUDIT PASS
12. full final regression
13. final development QEMU SHA-256
14. historical rollback SHA unchanged
### VNEXT_LEGACY_DEPENDENCY_AUDIT

Status: CLOSED from E030 after reviewer approval. VNEXT_B and the legacy arena
are mutually exclusive, and no declared support row needs a separate VNEXT
migration.

### ESP32_SUPPORT_MATRIX_AUDIT

Status: CLOSED from E031 after reviewer approval. The
declared matrix is exhaustive for the current contract and agrees with the
ESP32 SoC composition; unsupported and limited rows remain explicit.
VNEXT_B and the legacy arena are mutually exclusive, and no declared support
row currently needs a separate VNEXT migration.

### VNEXT_TRACE / HOT-PATH DIAGNOSTIC I/O

Status: CLOSED from E044 after reviewer approval. E032 found unconditional `[VNEXT_PROBE]` writes in
`vnext_b_gpio_write()` even though `LASECSIMUL_VNEXT_TRACE` itself is opt-in.
No source change has been made; the production hot-path cleanliness gate is
not satisfied by the current source audit.

E033 narrowed the correction: every `[VNEXT_PROBE]` site is diagnostic-only,
including startup probes, and was guarded by the existing opt-in helper without
changing runtime semantics. E041-E043 provide the guarded-source/build,
trace-off silence, trace-on functional PASS, unchanged SHA, and historical
direct-QEMU trace evidence accepted by Work. No root cause or semantic change
is declared.
