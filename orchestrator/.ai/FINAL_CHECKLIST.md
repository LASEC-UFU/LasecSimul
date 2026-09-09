# FINAL CHECKLIST

Do not mark COMPLETE until all applicable items are closed.

Reconciled checkpoint 2026-09-07 runtime promotion execution: promoção
controlada foi tentada e revertida automaticamente no primeiro vermelho
pós-promoção. O candidato `3D951D7C...` chegou temporariamente ao canônico e
três gates QEMU passaram, mas `vnext_b_attachment_test` não exercitou por falta
de `LASECSIMUL_TEST_QEMU_BINARY` e `session_restart_stress_test` lançou
`devices/qemu-esp32/bin/qemu-system-xtensa.exe` em vez do canônico promovido,
falhando 15/15 ciclos por ABI v5 incompatível. Rollback restaurou canônico e
`QEMU_RUNTIME.json` para `B375A9E8...`, zero QEMU órfão. Promoção, package,
tag, workflow, release, commit, push e cleanup permanecem abertos.

Reconciled checkpoint 2026-09-07 B12: E134 e B11 estão fechados para
`VNEXT_B+MTTCG`; B12 concluiu **B12_PASS — PROMOTION_REVIEW_AUTHORIZED** por
auditoria offline dos artefatos aprovados. B11 aprovado: N=1 1/1, N=8 1/1,
N=12 1/1, N=16 3/3, todos com workloads válidos, `submissions==completions>0`,
zero resets inesperados, zero `artifactFatal`, teardowns limpos e zero QEMU
órfão. Classificação: `NO_ACTIVE_ANOMALY_OBSERVED`. Não houve promoção,
package, tag, workflow, release, commit, push ou cleanup. `QEMU_RUNTIME.json`
e o runtime canônico permanecem intactos em SHA256
`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`.
Próxima etapa é review separado de promoção do candidato
`3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`.

Reconciled checkpoint 2026-09-07 E132-F: após E132-E, a validação pós-review
`VNEXT_B+MTTCG` passou determinísticos 8/8, RESET_WAIT 3/3, E131 6/6, duas
regressões 14/14 e B11 N=1/N=8/N=12. B11 N=16 é o primeiro vermelho atual:
`cellPass=false`, 14 resets inesperados, 13/16 workloads, sem MWDT atribuído,
sem CACHEERR/Guru/reentrância/teardown hang e zero QEMU órfão. Portanto B11,
B12, promoção, package, tag, workflow e release continuam abertos.

Reconciled checkpoint 2026-09-07 E132-E: o primeiro vermelho determinístico
pós-review (`session_restart_stress_test`) foi saneado exclusivamente no
harness/oráculo, sem mudança semântica QEMU/produção. Determinísticos
pós-review consolidados em 8/8 PASS; blank-flash 3/3, firmware real 2/2 e
formal real 15/15 passaram com traces operacionais OFF, zero timeout e zero
QEMU órfão. Este checkpoint não promove runtime e não fecha B11, B12,
promoção, package, tag, workflow ou release.

Reconciled checkpoint 2026-09-07 E132-D: reviewer aprovou E131 estrito para
`VNEXT_B+MTTCG`, mas a validação pós-review parou no primeiro vermelho
determinístico (`session_restart_stress_test`). Portanto B11, B12, promoção,
package, tag, workflow e release continuam abertos. O vermelho atual é
classificado como provável oráculo/harness trace-gated, não como suporte de
produção aprovado nem como falha semântica QEMU comprovada.

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
- [x] ESP32_MWDT_BEHAVIOR through the production Core/VNEXT_B path — closed
      for `VNEXT_B+MTTCG` by E134/B11/B12. Approved B11 evidence has N=1,
      N=8, N=12 and N=16 3/3 with zero unexpected resets and no active MWDT
      anomaly. Historical non-production/topology caveats remain outside this
      production gate.
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
- [x] Current development QEMU final SHA recorded - `02D3F7159DA9A2D4D9B9155780D34499DFDD6FEB236F94175F586FA0B964B1EB` in `QEMU_RUNTIME.json`
- [x] Historical rollback SHA remains
      `471AE54193CC7A86F6A448D53BC1E810F5B50D6EBAD1FE48FC34AA04F56F74CE`
- [x] Final report written — B12 final decision report written 2026-09-07:
      `vnext_prototype/mttcg_causality/E134-wdt-scale-reanchor_20260907_152218/B12-final-decision_20260907_1735/B12_final_decision_report.md`
- [ ] `PRODUCTION VNEXT_B ESP32 INTEGRATION PASS`
- [ ] `VNEXT_B ESP32 PRODUCTION IMPLEMENTATION COMPLETE`

## Deferred, not part of this definition of done

- Official ESP-IDF IWDT *policy* conformance. This is a different subject from
  the two MWDT gates above, which are about the QEMU device model. Treating
  them as the same thing is what caused the iterations 61-90 spiral; see the
  postmortem in `CLOSED_HYPOTHESES.md`. Do not add it to this checklist without
  an explicit decision.

Git remains untouched unless explicitly authorized by the user.
