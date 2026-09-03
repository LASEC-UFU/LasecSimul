# FINAL CHECKLIST

Do not mark COMPLETE until all applicable items are closed.

Last reconciled 2026-09-03. Items previously left unticked despite an approved
closure in `TEST_GATES.md` are now ticked, with the discrepancy noted; the
`MWDT_DEEP_REVIEW_PLAN.md` section 4 request to reconcile the two files
administratively is discharged here.

- [x] PRODUCTION_SESSION_FAILURE_ISOLATION PASS — closed from E019 (was
      unticked here while `TEST_GATES.md` recorded reviewer closure)
- [x] PRODUCTION_COMBINED_WORKLOAD PASS
- [x] SHARED_DISPATCHER_FAIRNESS PASS
- [x] FINAL_RESOURCE_ACCOUNTING PASS — closed from E024 (same discrepancy)
- [x] Production launch is MTTCG/thread=multi
- [x] Production tb-size is numeric 64, not 64M
- [x] VNEXT_TRACE default OFF — closed from E041-E044
- [x] ABI final aligned; no accidental semantic ABI change — closed from E026
- [x] ESP32_MWDT_LOAD_INDEPENDENCE PASS *(device level, E101)*
- [x] ESP32_MWDT_BEHAVIOR PASS — fed survives load; unfed still resets
      *(device level, E098 + E101)*
- [ ] ESP32_MWDT_BEHAVIOR through the production Core/VNEXT_B path - OPEN.
      Clean at 1/4/8 sessions; intermittent MWDT resets at 12 and 16 (E105).
      The two diagnostic-I/O defects behind the original theory are fixed,
      built and regression-tested (E102, E103, E106) but were not the cause.
- [x] VNEXT_LEGACY_DEPENDENCY_AUDIT PASS — closed from E030
- [ ] NEW VNEXT-CAUSED LEGACY REGRESSIONS = 0
- [x] ESP32_SUPPORT_MATRIX_AUDIT PASS
- [ ] FINAL_FIDELITY_REVIEW PASS
- [ ] FINAL_SOURCE_AUDIT PASS
- [x] No residual hot-path diagnostic I/O - reopened then closed 2026-09-03.
      The E041-E044 closure had audited `[VNEXT_PROBE]` tags only and missed
      the unconditional `[VNEXT_B]` backpressure writes and the `esp32_i2c.c`
      ackERR sites. A full sweep of every `fprintf`/`printf` in `vnext_b.c`,
      `esp32_i2c.c`, `esp32_timg.c` and `simuliface.c` is recorded in E103;
      the remaining ungated writes are startup, shutdown or fatal paths.
- [x] No thread=single production workaround
- [x] No `tb-size=64M`
- [ ] No polling/fallback/busy-spin correctness path
- [ ] No BQL-held peer wait
- [ ] No dynamic waiter/unbounded transport queue
- [ ] No causal I2C C2A regression
- [ ] No test-only bypass leaked into production
- [x] Current development QEMU final SHA recorded - `5C621E0B577F648CE665B33CB92F5A214EA5981ADCA369852A3FD8514B1EE2CF` in `QEMU_RUNTIME.json`
- [x] Historical rollback SHA remains
      `471AE54193CC7A86F6A448D53BC1E810F5B50D6EBAD1FE48FC34AA04F56F74CE`
- [ ] Final report written
- [ ] `PRODUCTION VNEXT_B ESP32 INTEGRATION PASS`
- [ ] `VNEXT_B ESP32 PRODUCTION IMPLEMENTATION COMPLETE`

## Deferred, not part of this definition of done

- Official ESP-IDF IWDT *policy* conformance. This is a different subject from
  the two MWDT gates above, which are about the QEMU device model. Treating
  them as the same thing is what caused the iterations 61-90 spiral; see the
  postmortem in `CLOSED_HYPOTHESES.md`. Do not add it to this checklist without
  an explicit decision.

Git remains untouched unless explicitly authorized by the user.
