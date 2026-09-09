# TEST GATES

## E138 ROM/EFUSE classification gate — REVIEW REQUIRED (2026-09-08)

Status: **REVIEW_REQUIRED — E138_ROM_EFUSE_ROOT_CAUSE**.

Artifact:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E138-rom-efuse-classification_20260908_055000`.

Gate outcome:

- mandatory identity/preflight PASS for candidate, canonical rollback, firmware
  `merged.bin`, firmware ELF and intact `QEMU_RUNTIME.json`;
- ROM disassembly PASS for `_reload_efuses_and_check`,
  `_rtc_trigger_sw_system_reset`, `SW_SYS_RESET` write at `0x4000fdcd`, `memw`
  at `0x4000fdd0`, and three reload calls;
- B11 N=16 with only `LASECSIMUL_RTC_SYS_RESET_CAUSAL_TRACE`: FAIL as expected
  for capture, 16/16 JSONL, workload pass in all sessions, one red session,
  clean teardown and zero orphans;
- causal classification PASS: E137/E138 are E121 ROM/EFUSE boot resets and do
  not reproduce E135 post-boot panic;
- semantic fix gate NOT CREATED: exact EFUSE sub-branch, per-call RDATA and
  correct ESP32-classic operation duration remain pending.

Blocked until review: semantic EFUSE fix, B12, promotion, QEMU runtime canonical
update, release packaging, and cache/TG1/WDT/transport/scheduler investigations.

## E137 B11 N=16 recurrence classification gate — REVIEW REQUIRED (2026-09-08)

Status: **B11_N16_PANIC_RESET_RECURRENCE_REPRODUCED_FRAME_UNPROVEN_REVIEW_REQUIRED**.

Artifact:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E137-cacheerr-signature-recurrence_20260908_053314`.

Gate outcome:

- preflight identity and zero-QEMU check PASS;
- static WDT-trace perturbation audit PASS;
- static E129 cache-wait predicate table produced;
- B11 N=16 attempt 1, panic-only: PASS, 16/16, zero unexpected resets;
- B11 N=16 attempt 2, panic-only: FAIL, 16/16 dumped/JSONL, `cellPass=false`,
  `totalUnexpectedResets=4`, sessions 6 and 14 red;
- campaign stopped on first red as required;
- teardown clean and zero QEMU orphans after each attempt;
- no deterministic RED/GREEN fix gate was created and no semantic fix is
  authorized by this classification alone.

Blocked until review: B12, promotion, QEMU runtime canonical update, release
packaging, and any semantic change to cache/watchdog/reset/transport/scheduler.

## E136 B11 N=16 rare panic classification gate — REVIEW REQUIRED (2026-09-07)

Status: **LOW_RATE_ANOMALY_NOT_REPRODUCED_REVIEW_REQUIRED**.

Artifact:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E136-b11-n16-panic-classification_20260907_220542`.

Passed deterministic trace gates:

- `test-esp32-panic-trace-gate`: PASS, 6 subtests;
- `test-esp32-timg-wdt-scale`: PASS, 13 subtests;
- `test-esp32-timg-pause`: PASS, 7 subtests.

Directed B11 N=16 attempts using candidate `3D951D7C...`, real firmware,
`VNEXT_B+MTTCG`, `ReserveCores=6`, `Force`, and only panic/WDT causal traces:

- attempt 1: valid PASS, 16/16, zero unexpected resets;
- attempt 2: valid PASS, 16/16, zero unexpected resets;
- attempt 3: invalid for rare-panic classification because one session did not
  reach app-cpu startup/workload; preserved, zero unexpected resets;
- attempt 4 replacement: valid PASS, 16/16, zero unexpected resets.

No `PANIC_CAUSAL_TRACE` frame and no WDT expiry ring dump occurred in the three
valid attempts. This does not prove the original cause; it proves non-
reproduction within the bounded E136 campaign.

Promotion/B12 remain blocked pending review.

## E135 NOT_APPLICABLE promotion retry — ROLLED BACK on real B11 N=16 red (2026-09-07)

Status: **PROMOTION_ROLLED_BACK — FIRST_REAL_POST_PROMOTION_RED_B11_N16**.

Executor:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\E135-gate-executor_20260907_181428\Invoke-E135PromotionGate.ps1`.

Executor SHA256:
`501470CC413937227B6EC26E64D563E8096B7AD76C070F3F9208770D136C3381`.

Source marker change:

- file:
  `C:\SourceCode\LasecSimul\core\test\core\mcu\McuControllerRealQemuTest.cpp`;
- SHA256:
  `786C34420C51E22B8638793C94E05EC9AC6AC3289EB011F3BFFC603AC4662B95`;
- changed only the VNEXT_B LEGACY-only gateway/TAP fallback message from
  `PULADO:` to the exact structured marker
  `NOT_APPLICABLE: test=mcu_controller_real_qemu_test subcase=legacy_gateway_tap_fallback reason=transport_vnext_b`.

Fail-closed executor policy:

- rejects any `SKIP:`, `SKIPPED:` or `PULADO:`;
- rejects every `NOT_APPLICABLE` except the exact marker above;
- allows that exact marker only once, only for `mcu_controller_real_qemu_test`,
  only under `VNEXT_B`;
- still requires exit code zero, `Todos os testes passaram`, QEMU actually
  launched and expected QEMU SHA.

Passed gates before final promotion:

- executor synthetic self-test: PASS, 17 cases;
- rebuilt only `mcu_controller_real_qemu_test`;
- direct `mcu_controller_real_qemu_test` against candidate `3D951D7C...`: PASS;
- official `VNEXT_B+MTTCG` regression 14/14 against candidate `3D951D7C...`:
  PASS;
- B11 N=1 oracle check against candidate `3D951D7C...`: PASS.

Post-promotion gates through canonical `3D951D7C...`:

- `test-esp32-timg-wdt-scale`: PASS TAP 13;
- `test-esp32-timg-pause`: PASS TAP 7;
- `test-vnext-b-classify`: PASS TAP 9;
- `vnext_b_attachment_test`: PASS;
- `session_restart_stress_test`: PASS 15 cycles;
- official `VNEXT_B+MTTCG` regression: PASS 14/14;
- B11 N=1: PASS;
- B11 N=16: **FAIL**.

B11 N=16 failure artifact:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\E135-gate-executor_20260907_181428\final_post_B11_N16`.

Observed B11 N=16 result:

- QEMU SHA:
  `3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`;
- `SESSIONS_DUMPED = 16 / 16`;
- `JSONL_SESSIONS = 16 / 16`;
- `EXIT_CODE = 0`;
- `MWDT_ATTRIB_RESETS = 0`;
- `B11_CELL_PASS = False`;
- `RUNNER_PASS = False`;
- `RUNNER_FAILURES = classifier_cellPass_false`.

Rollback gate:

- canonical runtime restored to
  `B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`;
- `QEMU_RUNTIME.json` restored to
  `ADF0D79B9E533E17A3F8CA62FD890B1867973FBB1AFF1C95239142D03644B369`;
- `QEMU_RUNTIME.json` remains read-only;
- zero QEMU processes remain.

Do not promote again until the B11 N=16 red is classified. No B12, cleanup,
commit, push, tag, package or release is authorized.

## E135 fail-closed promotion gate — BLOCKED on historical `PULADO:` conflict (2026-09-07)

Status: **BLOCKED_BEFORE_FINAL_PROMOTION — FAIL_CLOSED_GATE_CONFLICT**.

Executor:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\E135-gate-executor_20260907_181428\Invoke-E135PromotionGate.ps1`.

Report:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\E135-gate-executor_20260907_181428\E135_fail_closed_gate_executor_report.md`.

Self-test and preflight:

- executor self-test: PASS, 11 synthetic fail-closed cases;
- direct candidate preflight: PASS, `vnext_b_attachment_test` and
  `session_restart_stress_test` 3/3, candidate SHA
  `3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`;
- no fallback to `devices/qemu-esp32\bin\qemu-system-xtensa.exe` observed in
  the passing preflight.

Promotion status:

- two E135 dev-runtime promotion attempts were rolled back at first fail-closed
  red;
- current canonical executable remains rollback SHA
  `B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`;
- `QEMU_RUNTIME.json` remains rollback hash
  `ADF0D79B9E533E17A3F8CA62FD890B1867973FBB1AFF1C95239142D03644B369`;
- zero QEMU processes remain.

Gate conflict:

- E135 requires rejecting `PULADO:`;
- the historical 14-test `VNEXT_B+MTTCG` regression includes
  `mcu_controller_real_qemu_test`;
- that test exits 0 and prints `Todos os testes passaram`, but also prints a
  known VNEXT_B `PULADO:` line for a LEGACY-only gateway/TAP fallback subcase;
- therefore the corrected fail-closed executor cannot truthfully pass the
  current 14/14 regression without a gate-content/protocol decision.

Required next decision: remove/replace that VNEXT_B-not-applicable `PULADO:`
from the gate, explicitly authorize a narrow exception, or redefine the 14/14
promotion list. Do not promote again before that decision.

## Runtime promotion execution gate — ROLLED BACK at first red (2026-09-07)

Status: **PROMOTION_ROLLED_BACK — FIRST_POST_PROMOTION_RED**.

Artifact:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\runtime-promotion_20260907_175847`.

Passed before red:

- `test-esp32-timg-wdt-scale`: PASS 13/13;
- `test-esp32-timg-pause`: PASS 7/7;
- `test-vnext-b-classify`: PASS 9/9;
- canonical replacement/load step: PASS temporarily, SHA `3D951D7C...`,
  adjacent DLLs unchanged, `qemu --version` exit 0.

First red:

- `vnext_b_attachment_test`: SKIP, `LASECSIMUL_TEST_QEMU_BINARY` unavailable;
- `session_restart_stress_test`: FAIL exit 1; launched
  `devices/qemu-esp32/bin/qemu-system-xtensa.exe` instead of promoted canonical
  runtime and hit incompatible arena ABI v5 handshake timeout; 15/15 cycles
  failed to start.

Rollback result:

- canonical executable restored to SHA
  `B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`;
- `QEMU_RUNTIME.json` restored to rollback state;
- zero QEMU processes remain.

Later gates not run: full `VNEXT_B+MTTCG` regression, B11 N=1 and B11 N=16.
Do not treat promotion as complete.

## Runtime promotion review gate — APPROVED for bounded execution (2026-09-07)

Status: **APPROVE — RUNTIME_PROMOTION_EXECUTION_AUTHORIZED**.

Review request ID: `B12-runtime-promotion-review-20260907`.

Report:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\B12-runtime-promotion-review_20260907\runtime_promotion_review.md`.

Candidate SHA256:
`3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`.

Rollback/canonical SHA256:
`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`.

Promotion execution is authorized, but not performed by this review. The future
execution must snapshot rollback, stage/verify candidate, replace only the
canonical executable, preserve DLLs, update `QEMU_RUNTIME.json`, and run gates
through the canonical path. Restore rollback automatically on any gate failure.

Required post-promotion gates, `VNEXT_B+MTTCG` only:

- `test-esp32-timg-wdt-scale`;
- `test-esp32-timg-pause`;
- `test-vnext-b-classify`;
- `vnext_b_attachment_test`;
- `session_restart_stress_test`;
- one full `VNEXT_B+MTTCG` regression 14/14;
- B11 N=1;
- one B11 N=16 cell;
- SHA confirmation in headers/logs;
- zero unexpected reset, UART/I2C loss/desync, artifact fatal, teardown hang,
  blocked re-entrant IO and QEMU orphan.

Do not run `LEGACY`, `ICOUNT`, `SINGLE_REALTIME`, Phase C, cleanup, commit,
push, tag or release as part of promotion.

## B12 final decision gate — PASS for VNEXT_B+MTTCG (2026-09-07)

Status: **B12_PASS — PROMOTION_REVIEW_AUTHORIZED**.

Report:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\B12-final-decision_20260907_1735\B12_final_decision_report.md`.

Candidate QEMU SHA256:
`3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`.

Gate summary:

- B11 N=1: 1/1 execution valid, 1/1 workload, 2 raw/unique expected resets, 0
  unexpected resets;
- B11 N=8: 1/1 execution valid, 8/8 workloads, 16 raw/unique expected resets, 0
  unexpected resets;
- B11 N=12: 1/1 execution valid, 12/12 workloads, 24 raw/unique expected
  resets, 0 unexpected resets;
- B11 N=16: 3/3 executions valid, 48/48 workloads, 96 raw/unique expected
  resets, 0 unexpected resets.

All approved B11 sessions have `submissions==completions>0`,
`artifactFatal=false`, no blocked re-entrant IO, no UART/I2C loss/desync, no
CACHEERR/Guru/TG expiry/unexpected SW reset marker, no timeout/fail-open marker,
clean teardown and zero owned QEMU orphans. Operational traces were off.

Classification: `NO_ACTIVE_ANOMALY_OBSERVED`. No Phase C capacity, clock, or new
watchdog compensation is justified by current B11/B12 evidence.

Promotion is not executed by this gate. A separate promotion review is now
authorized for the candidate SHA above. The canonical runtime and
`QEMU_RUNTIME.json` remain intact at SHA256
`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`.

## E134 closure — APPROVED; B11 closed, B12 authorized only for VNEXT_B+MTTCG (2026-09-07)

Status: **APPROVED** for E134/B11 closure.

Review request ID: `E134-wdt-scale-reanchor-closure-review`.

Candidate QEMU SHA256:
`3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`.

Gate result:

- deterministic WDT scale test: PASS 13/13 direct and Meson/Ninja;
- `VNEXT_B+MTTCG` regression run 1: PASS 14/14 using candidate SHA;
- `VNEXT_B+MTTCG` regression run 2: PASS 14/14 using candidate SHA;
- B11 N=1: PASS from zero;
- B11 N=8: PASS from zero;
- B11 N=12: PASS from zero;
- B11 N=16: PASS 3/3 from zero;
- each N=16 run: 16/16 workloads, `submissions==completions>0`,
  `totalUnexpectedResets=0`, no artifact fatal, no blocked reentrant IO, clean
  teardown, zero owned QEMU orphans after cleanup;
- runtime canonicity: `QEMU_RUNTIME.json` and the canonical runtime remain on
  SHA256 `B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`;
  no promotion performed during review.

Caveat: no new integrated no-feed later-expiry proof is claimed because the
rebuilt fixture produced no observable stdout/stderr in bounded QEMU attempts.
The caveat is accepted as non-blocking for E134/B11 closure.

B12 is now authorized exclusively for `VNEXT_B+MTTCG`. Runtime promotion remains
a separate explicit step after B12; preserve the canonical runtime as rollback.

## E134 watchdog scale/reanchor — IMPLEMENTED / REVIEW_REQUIRED for closure (2026-09-07)

Status: **IMPLEMENTED, GREEN so far, pending closure review before B12/promotion**.

Validated artifacts under
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218`.
Candidate QEMU SHA256:
`3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`.

Required checks completed:

- QEMU candidate build: PASS (`phase2_qemu_build_after_slirp_value_str.out`);
- direct deterministic WDT scale test: PASS 13/13
  (`phase2_green_direct_test.out`);
- Meson/Ninja WDT scale test: PASS 13/13
  (`phase2_meson_wdt_scale_run.out`);
- `VNEXT_B+MTTCG` regression run 1: PASS 14/14;
- `VNEXT_B+MTTCG` regression run 2: PASS 14/14;
- B11 N=1: PASS, `B11_CELL_PASS=True`, `MWDT_ATTRIB_RESETS=0`;
- B11 N=8: PASS, `B11_CELL_PASS=True`, `MWDT_ATTRIB_RESETS=0`;
- B11 N=12: PASS, `B11_CELL_PASS=True`, `MWDT_ATTRIB_RESETS=0`;
- B11 N=16 run 1: PASS, `B11_CELL_PASS=True`, `MWDT_ATTRIB_RESETS=0`;
- B11 N=16 run 2: PASS, `B11_CELL_PASS=True`, `MWDT_ATTRIB_RESETS=0`;
- B11 N=16 run 3: PASS, `B11_CELL_PASS=True`, `MWDT_ATTRIB_RESETS=0`.

Remaining caveat for review: a no-feed MWDT diagnostic firmware was rebuilt and
snapshotted, but bounded QEMU attempts produced no observable UART/stderr trace;
do not count it as a completed integrated “later expiry” proof. The later
expiry boundary is covered by deterministic helper tests; production/B11 proves
absence of premature MWDT-attributed expiry after the E134 correction.

B12, runtime promotion, cleanup, commit, tag and release remain blocked pending
closure review.

## E134 watchdog scale/reanchor — REVIEW_REQUIRED after RED proof (2026-09-07)

Status: **OPEN / REVIEW_REQUIRED**.

H134 is confirmed at the arithmetic/source level: `wdt_time_scale=100` currently
scales only the armed nanosecond interval after `arm()` subtracts literal
`count_base` from raw `stage_timeout`. A neutral `WDTCONFIG0/1` reanchor can
therefore materialize `609` literal ticks and collapse a scaled 30s budget to
zero because `609 >= raw 600`.

RED test added and failing by design:

- `include/hw/timer/esp32_timg_wdt_scale_math.h`;
- `tests/unit/test-esp32-timg-wdt-scale.c`;
- output: `E134-wdt-scale-reanchor_20260907_152218\phase1_red_test.out`;
- assertion: current deadline `3426994200`, expected scaled deadline
  `33122494200`.

No semantic watchdog fix has been applied yet. B11 restart, B12, runtime
promotion and release gates remain blocked pending review.

## E133 B11 N=16 causality — OPEN / narrowed but not closed (2026-09-07)

Status: **OPEN**. B12, runtime promotion, cleanup, commit, tag and release
remain blocked.

Runner/harness gate: **CLOSED for fail-closed truth correction**. E133 fixed the
B11 runner so it no longer reports success when `cellPass=false`, and removed
the broad non-owned QEMU kill. Deterministic runner tests passed 14/14 in
`phase2_runner_lib_test_after_diag_switches.out`.

B11 N=16 formal evidence:

- initial R0/ReserveCores=0/no Force: PASS, 16/16 workload, 0 unexpected resets;
- block01 R6+Force control: FAIL, 16/16 workload, 21 unexpected resets;
- block01 R0/no Force treatment: FAIL, 15/16 workload, 3 unexpected resets.

All formal runs recorded host topology and confirmed QEMU child affinity/
priority inheritance. Repetitions stopped at the first treatment red as
required.

Diagnostic evidence: one directed R0/no Force diagnostic with panic/WDT/MWDT
accounting/PC sampler observed TG1 genuine expiry and
`first_actual_stage_expiry`, followed by guest software reset/panic path
(`SW_CPU_RESET_REGISTER`, `SW_APPCPU_RESET`). No CACHEERR/Guru/blocked
re-entrant IO/teardown-hang was observed; classifier MWDT-attributed reset
count remains 0. Exact panic cause and first guest causal frame remain pending.

## E132-F post-review validation / B11 — STOPPED at N=16 first red (2026-09-07)

Status: **OPEN / STOPPED at first real red**.

Post-review `VNEXT_B+MTTCG` progressed past E132-E:

- deterministic post-review: 8/8 PASS;
- RESET_WAIT: 3/3 PASS;
- E131 full: 6/6 PASS;
- two `VNEXT_B+MTTCG` regression runs: 14/14 PASS and 14/14 PASS;
- B11 formal: N=1 PASS, N=8 PASS, N=12 PASS, N=16 FAIL.

N=16 evidence: `cellPass=false`, harness exit code 1, 16/16 sessions dumped,
16/16 JSONL, `sessionsWorkloadPass=13/16`, `totalUnexpectedResets=14`,
`MWDT_ATTRIB_RESETS=0`, no `CACHEERR`/`exccause=7`, no `Guru Meditation Error`,
no `Blocked re-entrant IO`, no `TEARDOWN_HANG`, zero residual QEMU process.

B12, runtime promotion, cleanup, commit, tag and release remain blocked until
the N=16 cause is classified and resolved or explicitly dispositioned by review.

## E132-E deterministic restart sanitation — CLOSED for post-review deterministic gate (2026-09-07)

Status: **CLOSED for `VNEXT_B+MTTCG` deterministic restart harness**.

`session_restart_stress_test` foi corrigido somente no contrato/oráculo:
`VNEXT_B` não depende mais de `[VNEXT_PROBE]` trace-gated para liveness.
Blank-flash agora prova lifecycle/pacing/execId/stop limpo/sem órfãos e marca
I2C/stale como `NOT_APPLICABLE`; firmware real exige pacing,
submissions/completions I2C e artifact progress por contadores estruturais.

Evidência:

- artefatos:
  `C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E132-post-review_20260907_113506\E132-E_session_restart_oracle_20260907_123456`;
- rebuild isolado de `session_restart_stress_test`: PASS, 0 warnings/0 errors;
- blank-flash 3 ciclos: PASS, zero timeout, zero órfão;
- firmware real 2 ciclos: PASS, stale callback rejeitada por geração e B com
  progresso estrutural real;
- formal firmware real 15 ciclos: PASS, `P9_RESTART_REAL_PROGRESS PASS
  cycles=15`, `P9_I2C_INFLIGHT_STOP_QUIESCENCE PASS cycles=15`, zero timeout,
  zero órfão e sem marcadores negativos;
- consolidado E132 determinístico: 8/8 PASS, reaproveitando os 7 verdes já
  preservados e rerodando somente o primeiro vermelho corrigido.

This does not promote `QEMU_RUNTIME.json` and does not authorize `LEGACY`,
`SINGLE_REALTIME` or `ICOUNT`.

## E132-D deterministic post-review — BLOCKED by first red (2026-09-07)

Status: **SUPERSEDED by E132-E**.

Rebuild QEMU/Core/firmware passou, e 7 determinísticos passaram com zero órfãos.
O primeiro vermelho foi `session_restart_stress_test` (exit code 1): 15/15
ciclos `VNEXT_B` com flash vazia não observaram liveness porque o teste depende
do marcador diagnóstico `[VNEXT_PROBE] after qemu_init`, com traces formais OFF.
Classificação atual: harness/precondição provável; falha de produção não
comprovada. E132-E saneou esse oráculo e reexecutou o menor teste causal.

## E132-C post-review validation — OPEN (2026-09-07)

Status: **OPEN / RUNNING** para `VNEXT_B+MTTCG`.

Reviewer aprovou `E132-B-review-20260907`, convertendo E131 de
`CLOSED_PENDING_REVIEW` para fechado no escopo estrito `VNEXT_B+MTTCG`.
Snapshot inicial e auditoria de fonte pós-review foram preservados. Próximos
gates formais: rebuild controlado, testes determinísticos afetados, RESET_WAIT
3/3, E131 6/6, duas regressões `VNEXT_B+MTTCG` 13/13 e B11 N=1/8/12/16.

Permanece proibido misturar resultados `LEGACY`, `SINGLE_REALTIME` ou `ICOUNT`
com este gate de produção.

## E132-B RESET_WAIT / E131 estrito — CLOSED_PENDING_REVIEW (2026-09-07)

Status: **CLOSED for VNEXT_B+MTTCG after reviewer approval**.

- supervisor fail-closed preservado;
- RESET_WAIT arquitetural 3/3;
- geração APP CPU `2->3` em todas as repetições;
- prova de execução CPU1 após R6 por watermark `cpu_exec`: +3 em todas;
- zero replay stale, espera residual, timeout, teardown sujo ou órfão;
- bateria final E131 6/6 em processos QEMU independentes.

O fechamento não promove runtime e não declara B11 aprovado.

## E131-E cache-wait E2E proof gate — CLOSED for VNEXT_B+MTTCG; broad promotion gate OPEN (2026-09-07)

## E132 gate-integrity correction — supervisor green, RESET_WAIT OPEN (2026-09-07)

Status: **OPEN**. O supervisor agora cruza exit code observado, summary,
progresso terminal, stderr, teardown, órfãos e ambiente. A reaplicação do
RESET_WAIT histórico foi corretamente classificada como
`SUPERVISOR_INTEGRITY_FAIL`; nenhum PASS é aceito com `failures>0`,
`E131_FAILURE` ou `detail=1`.

O gate arquitetural RESET_WAIT permanece vermelho: geração APP CPU não aumenta
e não há prova válida de progresso FreeRTOS pós-reset. E131-E não pode ser
fechada estritamente, e nenhuma bateria final ou promoção é autorizada.

Status: **CLOSED for E131 cache-wait under VNEXT_B+MTTCG**.

Status: **OPEN for broad runtime promotion/release**, because a separate
LEGACY+MTTCG regression remains red and the default `devices/` QEMU is stale
relative to the rebuilt Core/QEMU ABI.

Closure evidence for E131-E:

- Harness/runner are sanitized: no `std::_Exit`, explicit
  `session.stopSimulation()`, progress JSONL, hermetic `LASECSIMUL_*`
  whitelist, sentinel leak test, parent environment restore, external timeout
  supervision, and PID/descendant-only QEMU termination.
- Phase4 supervisor passed: normal DROM returned cleanly with
  `stopSimulation` begin/end and zero orphan; forced timeout was classified as
  `HARNESS_TIMEOUT`, with only the verified QEMU descendant killed.
- Phase5 RUNSTALL passed 3/3 using QEMU `43542...` and firmware `2AA278...`.
- Phase6 full battery passed 18/18:
  DROM, FETCH, RUNSTALL, CLKGATE, SELF_ILLEGAL, RESET_WAIT each passed 3/3 in
  fresh QEMU processes. Manifests show zero timeouts, zero teardown orphans,
  zero failed cells, parent restore true, no extra child `LASECSIMUL_*`, and
  `stopSimulation` begin/end for every cell.
- Full Phase6 QEMU logs contained zero `_UserExceptionVector`, zero
  `CACHEERR`, and zero reset/watchdog matches.

Phase7 status:

- Core rebuild passed.
- QEMU rebuild target `qemu-system-xtensa.exe` passed and retained hash
  `43542C43670FDAAEA54DFE8D6D7967BA657584FE13415774824FCE1C61B6FD6D`.
- Default `devices/` QEMU caused `session_restart_stress` ABI mismatch and is
  therefore not a valid promotion proof.
- With temporary QEMU override to the rebuilt binary, selected real-QEMU CTest
  gates and smokes passed, and `b11_classify_test.ps1` passed.
- VNEXT_B+MTTCG production-scale safe wrapper passed 13/13 twice.
- LEGACY+MTTCG production-scale safe wrapper failed on attempt 1 with
  `submissions=0`, `completions=0`, and four unexpected
  `SW_CPU_RESET_REGISTER` resets. Stop there; do not proceed to B11/N16/B12
  from this gate.

No QEMU semantic change or `QEMU_RUNTIME.json` update is authorized by E131-E.

## E131-B cache-wait E2E proof gate — CLOSED for isolated VNEXT_B+MTTCG proof (2026-09-06)

Status: **CLOSED for proof**, not a runtime-promotion decision.

Final artifact root:

`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E131-cache-wait-e2e\artifacts\20260906_194124`

Final result: all six isolated scenarios pass in fresh QEMU processes:
DROM, FETCH, RUNSTALL, CLKGATE, SELF_ILLEGAL, RESET_WAIT.

Closure evidence:

- Per-scenario immutable preservation exists for `merged.bin`, `firmware.elf`,
  `firmware.map`, SHA-256 values, full `qemu.log`, full `uart.txt`,
  `nm-anC.txt`, `objdump -t/-h/-d`, focused disassemblies, and `addr2line`.
- DROM data-load is isolated: APP worker/control helpers are proven in
  `.iram0.text`; `e131_drom_known_value` is proven in `.flash.rodata`; the
  exact load PC is proven by focused disassembly; runtime shows
  `region=drom0`, exact `vaddr`, `mem_io_pc != 0`, and successful TCG restore
  to the exact load PC.
- FETCH is isolated: `e131_flash_target` is proven in `.flash.text`; runtime
  shows `region=iram0`, exact target `vaddr`, `mem_io_pc=0`,
  `attempted=0/restored=0`, and translation begins again at the same guest PC.
- RUNSTALL and CLKGATE are independently classified and preserve their
  orthogonal hold state across cache-wait release until explicitly released.
- SELF_ILLEGAL produces `legitimate_illegal_access`, not compensatory suspend,
  and publishes the sentinel `0xbaadbaad`.
- RESET_WAIT clears the pending cache wait with `wait_mask=0` and no stale
  `resume_committed`.

Important nuance: the old E131-A `target_pc_match=0` observation remains
invalid as replay evidence. The E131-B proof uses exact PC/vaddr/region/
restore/retranslation/value-marker correlation. The diagnostic
`instruction_replayed` counter still reads `0` and is not the closure oracle.

No QEMU runtime promotion follows from this gate by itself, and
`QEMU_RUNTIME.json` must remain unchanged unless a separate promotion gate is
explicitly opened and satisfied.

## Superseded E131-B cache-wait E2E proof gate — OPEN, E131-A invalid/inconclusive (2026-09-06)

Superseded by the CLOSED E131-B proof-gate entry above. E131-A is superseded
as a structurally invalid/inconclusive test. The old
`target_pc_match=0` observation must not be used as proof of a replay failure:
it compared an owed PC with a later sampled APP CPU PC, which is not a replay
criterion.

The cache-wait end-to-end gate remains OPEN until all of the following are
true under VNEXT_B+MTTCG:

- Each scenario runs in a fresh QEMU process, with no shared residual firmware
  or QEMU state.
- Each scenario's `merged.bin`, `firmware.elf`, linker map, SHA-256 values and
  full logs are preserved immutably before execution.
- DROM data-load is isolated with the APP controller in physical IRAM,
  confirmed by `nm -anC`, linker map, `objdump -t -h -d`, `addr2line`, and
  call-site inspection. Passing evidence requires the wait to be on the DROM
  data load with `mem_io_pc != 0` and successful TCG restore.
- Instruction-fetch is isolated separately. Passing evidence may include
  `mem_io_pc == 0` and no `cpu_restore_state()` if translation/fetch is shown
  to restart at the same guest PC.
- Replay/retry correctness is proved at the exact suspend/resume/first-retry
  point by correlation fields, not by a later sampled PC.
- RUNSTALL, clockgate, reset-during-wait, self-illegal and any global-pause
  scenario are classified independently and do not contaminate the DROM/fetch
  proof.

## E131-A cache-wait deterministic E2E — OPEN / STOP (2026-09-06)

The E131-A integrated deterministic proof is not green and no candidate is
produced. The new minimal firmware and Core real-QEMU harness observed real
cache-wait activity under VNEXT_B+MTTCG, but failed the mandatory replay-PC
criterion: `resume_committed` can report `target_pc_match=0`
(`replay_owed_pc=0x400d1d0f`, `target_appcpu_pc=0x40080340` in the latest
compact run). Per the explicit stop conditions, do not proceed to candidate
copy, B11/capacity/B12, ICOUNT, or SINGLE_REALTIME from this state.

## E130 correction — current B11 gate status (2026-09-06)

The E130 N=16 result is not proven to be
`TG-watchdog-under-oversubscription`. Its provisional classification is
`software-reset cascade with unknown initiating panic under N=16 contention`.
The evidence is 44 raw reset lines and 36 deduplicated events (dedup key:
PID, boot epoch, reset count, mask, both CPU PCs and source), with four
unexpected events total. No TG0/TG1, CACHEERR, exception or host-starvation
gate may be closed from this log. The old E130 block below is retained as
history and is superseded by this correction.

The fresh formal cells already completed remain N=1 PASS, N=8 PASS and N=12
PASS; N=16/R=6 FAIL is open and causal. The requested N=12/R=6, N=16/R=6,
N=16/R=0 and N=13/R=6 comparison is not executed because the first N=16
failure had no causal frame. Capacity policy therefore remains undecided.
The cache-wait integrated end-to-end gate is also OPEN: the 27 pure tests and
structural audit do not prove the real suspend/release/replay path or reset
during wait. `QEMU_RUNTIME.json` must remain unchanged.

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

### VNEXT_B startup barrier + backpressure -- VNEXT_B+MTTCG gate

Status: **CLOSED, canonical runtime PROMOTED (E118-AUDIT-2, 2026-09-05)**. Four compounding root
causes identified and fixed across E117/E118/E118-AUDIT/E118-AUDIT-2: (1) E117's Core-side
`prepare()`/`activate()` registration-ordering race (see below, kept, unmodified since); (2) E118's
QEMU-side backpressure defect -- an ordinary full ring (`occupancy==depth`) treated identically to
genuine corruption (`occupancy>depth`), fixed with an explicit `VNEXT_PUBLISHED`/`VNEXT_WOULD_
BLOCK`/`VNEXT_FATAL` contract; (3) E118-AUDIT's UART backlog-overflow and I2C timer-continuation
desync gaps, both fixed with block-and-replay (UART) / leave-unarmed-and-retry (I2C) discipline;
(4) **E118-AUDIT-2's root cause of the E118-AUDIT gate's watchdog storm** -- `vnext_b_gpio_write()`'s
`cpu_loop_exit_restore()` retry, when triggered from inside a reentrancy-guarded device's own
dispatch (observed: `esp32_i2c`'s `A_I2C_CTR` write), skips `softmmu/memory.c`'s normal-return
clear of `mem_reentrancy_guard.engaged_in_io`, permanently wedging that device with "Blocked
re-entrant IO" for the rest of the process -- which is what actually drove the observed reset
storm, not host-scheduling contention. Fixed via `disable_reentrancy_guard = true` on every device
MemoryRegion reachable through this retry path (I2C, UART, GPIO, SPI, LEDC, SENS, IOMUX). See
EVIDENCE.md E118/E118-AUDIT/E118-AUDIT-2 for the full contract, producer audit table, causal proof,
and the corrected (not overclaimed) statistical framing of the 2/16-vs-0/10 signal that motivated
this investigation.

**The 10-attempt promotion gate passed cleanly with the fix and the ALSO-fixed runner**: all
functional criteria 10/10 (setup, workload, exactly-one-app-cpu-startup, submissions==completions>0,
artifactFatal=0, zero orphans) **and unexpectedResets=0 on every attempt** -- the gate runner's own
pass/fail bug (never checking `unexpectedResets`, so E118-AUDIT's two storm attempts were recorded
`"pass": true`) is also fixed, unit-tested (`phase6_gate_lib_test.ps1`), and the original evidence
re-classified in place to correct the record. **Canonical runtime PROMOTED**:
`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`. Prior canonical
`D93B504648B8372A07E69BC5A2F3F5CC1F223452B0BA92B903A6B624366DB66D` preserved as an explicit,
hash-verified rollback copy.

**A separate, narrower, explicitly open finding, not blocking this promotion**: fixing the
stuck-guard bug exposed a fairness question between a real vCPU's now-persistent retry and the
UART BH's own credit-available notify, reproduced only at an artificially tiny, test-only
`LASECSIMUL_VNEXT_B_LANE_DEPTH=2` -- not at the production gate's actual default lane depth
(confirmed clean by a 12/12 bounded reproduction at production settings). Recorded, not chased.

**Not in scope for this gate at all, per explicit instruction**: SINGLE_REALTIME (E118's own
finding: a second, unrelated, pre-existing stall, CPU0 frozen at a fixed PC with lane 0 fully
drained -- confirmed pre-existing, not a regression, not investigated further) and ICOUNT (open
`MWDT_SYS_STAGE` finding from E115). Neither was touched, run, or used as a gate in E118-AUDIT,
E118-AUDIT-2, or E119. The `-accel` composition work (`setAccelProperty()`/`accelHasProperty()`)
remains unvalidated, explicitly deferred.

### B11 (VNEXT_B+MTTCG scale matrix N=1/8/12/16) -- OPEN, E119's dport defect CLOSED, mechanism 2's
CACHEERR variant FIXED and HARDENED (E124/E125), the E128 cache-race deadlock FIXED (E129), a
reset-during-cache-wait deadlock gap FOUND and FIXED (E130), the B11 N=8 submissions/completions
delta PROVEN to be a harness race and FIXED with a drain/cutoff gate (E130), TG1-IntWDT variant
(E111) mechanistically reconstructed but NOT yet frame-confirmed (E126); **formal B11 restart
(fresh, E130): N=1/N=8/N=12 PASS; N=16 FAILS on the separate, pre-existing
TG-watchdog-under-oversubscription issue (zero cache/CACHEERR involvement)** -- B11 NOT yet
complete (E121 2026-09-05, E122 2026-09-05, E123 2026-09-05, E124 2026-09-05, E125 2026-09-05,
E126 2026-09-05, E127 2026-09-05, E128 2026-09-05, E129 2026-09-05, E130 2026-09-05)

**E130 update**: two objectives. (A) Audited cache-wait's `cpu_stop_current()`/`cpu_resume()`
against global pause/reset/teardown instead of trusting E129's own unverified "never coexist"
comment -- found and fixed a real gap: `esp32_app_cpu_reset_async()` (the per-CPU
`SW_CPU_RESET_REGISTER`/`MWDT_CPU_STAGE` reset path, deliberately bypassing
`qemu_system_reset_request()`'s own `resume_all_vcpus()` safety net) never called `cpu_resume()`,
so a reset landing while APP CPU was cache-wait-parked would reset its registers and leave it
permanently asleep. Fixed with one `cpu_resume(cs)` call. (B) Proved -- by reading
`McuComponent.cpp`'s single-consumer dispatch loop and by 3x live N=8 reproduction
(`postCutSubmissions` up to 598 observed) -- that E129's N=8 `submissions=completions+1` delta was
E120's own convergence-wait loop re-reading counters after a fresh guest submission landed in the
gap between "equality observed" and "final read", not a transport loss. Fixed with a frozen
per-session submission cutoff + drain-to-watermark gate, proven by 7 deterministic RED/GREEN tests
(`drain_cutoff_gate_test`, now in the 14-test regression list) including a genuinely-lost-request
negative control. **Formal B11 restart (fresh directory, not reusing prior N=1/N=8): N=1/N=8/N=12
PASS** (N=8's sessions 3/5, the ones that showed the delta before, now show `submissions=completions`
exactly). **N=16 FAILS**: 2/16 sessions never progress past a repeated boot-reset cycle
(`submissions=0`); confirmed zero cache/CACHEERR involvement (zero "cache"/`exccause=7` in the
log; reset signature matches the separate, already-documented TG-watchdog-oversubscription issue).
Stopped there per instruction. The cache-wait interlock's live end-to-end firing was NOT captured
this session despite 7 reproduction attempts (including the E124-established `CACHE_TRACE`
timing-widening technique) -- open for the next session. See EVIDENCE.md E130.

**E129 update**: fixed the deadlock E128 proved -- E124/E125's `appcpu_cache_race_stall`
compensation applied a blanket `xtensa_runstall()` to ALL of APP CPU's execution whenever a
different core disabled one of its cache regions, including while APP CPU was mid-interrupt-return
inside its own legitimate, `IRAM_ATTR` `spi_flash_op_block_func()` busy-wait, which never touches
the disabled region at all. Replaced with a per-access interlock: only a load/fetch that actually
lands on the disabled region now suspends (`cpu_stop_current()`/`cpu_loop_exit_restore()` inside
`hw/misc/esp32_dport.c`'s `esp32_cache_ill_read()` -- the same idiom already proven safe for VNEXT_B
backpressure, never releases the BQL, coexists safely with reset/clkgate/RUNSTALL on their own
orthogonal axis). Found by a failed build (not anticipated) that `esp32_dport.c` cannot include
`exec/exec-all.h` directly (target-independent shared library) -- the actual suspend call lives in
a new `softmmu/vnext_b.c` wrapper, matching the established per-target-call-site pattern
`esp32_i2c.c`/`esp32_uart.c` already use. **Validated**: unit tests 13->27 (all pass); the exact
scenario that showed `submissions=0` in E128 now shows `submissions=6820`; **10/10 fresh N=1/15s
attempts clean** (`cellPass=True`, `submissions==completions>0`, zero unexpected resets, zero
orphans); all Core suites + 3x `run_regression.ps1` 13/13 green against the actual candidate SHA.
**Formal B11: N=1 PASSES** (`submissions=9825`, zero unexpected resets) -- the first time ever;
E127 stopped at exactly this cell with zero submissions. **N=8 STOPS on a different, new symptom**:
`unexpectedResets=0`, `teardownClean=True`, `anyBlockedReentrantIo=False` -- none of the previously-
fixed mechanisms recurred -- but two of eight sessions show `submissions` exceeding `completions`
by exactly 1. Per protocol, stopped immediately, no retry, N=12/N=16 not attempted, runtime not
promoted. Two honest, undecided possibilities recorded (a genuine rare lost completion under N=8
host contention never previously observable, since every prior N=8 attempt failed earlier for
another reason; or a benign 60s-teardown-cutoff straggler) -- not resolved this session. See
EVIDENCE.md E129 for the full account, including a documentation correction to E128's own SHA
citation (attempts D/E used a second rebuild whose SHA E128 never recorded).

**E128 update**: root-caused E127's silent-workload N=1 failure via direct causal instrumentation
(a new gated `[APPCPU_STALL_TRACE]` in `esp32_cpu_stall()`, reusing the existing
`LASECSIMUL_APP_CPU_RESET_TRACE` gate, plus the pre-existing-but-forgotten `[VNEXT_PROBE]`/
`vnext_cpu_exec_probe_count()`). **The E124/E125 `appcpu_cache_race_stall` compensation
permanently runstalls APP CPU** when the stall happens to engage while APP CPU is mid-interrupt-
return (`_frxt_int_exit`) inside its own legitimate `spi_flash_op_block_func()` busy-wait (an
`IRAM_ATTR` function, architecturally unaffected by the very DROM0/IRAM0 flash-cache windows being
disabled) -- freezing APP CPU there deadlocks the system, since PRO CPU never again writes
`APP_CACHE_CTRL` to release it (most plausibly blocked itself on a FreeRTOS kernel resource APP
CPU was holding at the frozen instant). Proven with a narrow, gated, explicitly non-production
experimental control (`LASECSIMUL_DISABLE_CACHE_RACE_STALL=1`): disabling only this one
compensation reason restores the workload from 0 to 6168 I2C submissions in the same 15s scenario;
the identical scenario is clean against E122 (predates the mechanism, 5976 submissions). **No fix
applied**: the obvious candidate (skip the stall when APP CPU is in interrupt context) has its own
proven gap -- nothing re-arms the stall when APP CPU later exits that interrupt context, which
would silently reopen the exact CACHEERR window E124 closed. A correct fix needs a genuinely new
mechanism (interrupt-return hook, or trap-the-access instead of stall-all-execution), out of this
session's scope. B11 remains blocked until that fix is designed and validated with the same rigor
E124/E125 required. See EVIDENCE.md E128.

**E127 update**: executed the formal B11 restart with the E126 candidate (copied to an immutable,
exclusive path, SHA reconfirmed `3D65BD36...`), after first re-validating regressions against that
*actual* candidate binary (the prior E126 session's regressions had used canonical, disclosed at
the time -- `-QemuBinary` now confirmed the candidate's own SHA in the header on all three runs:
VNEXT_B+MTTCG 13/13 x2, LEGACY+MTTCG 13/13 x1) and closing two runner-hygiene gaps (`run_regression
.ps1`/`run_production_mwdt.ps1` now strip the E122/E126 causal-tracer and E123 teardown-trace env
vars before launching, empirically confirmed via a real child-process check). **N=1, the very first
formal cell, failed**: a fully clean boot (both CPUs started exactly once, zero resets beyond the
two expected ones, `artifactFatal=false`, `teardownClean=true`, zero orphans) that nonetheless
produced **zero VNEXT_B/I2C workload traffic for the entire 60s window**
(`submissions=0 completions=0`, `terminalRunning=true`) -- the harness's own internal verdict was
`PRODUCTION_SCALE FAIL failures=1`. This is explicitly **not** CACHEERR, not the TG1/`SW_CPU_
RESET_REGISTER` cascade (no unexpected reset occurred here at all), not `MWDT_CPU_STAGE`/
`MWDT_SYS_STAGE`, and not `Blocked re-entrant IO` -- a new failure mode outside this
investigation's own reset-based taxonomy, related to but distinct from E113/E121's previously-
unchased "invalid-boot flake" (APP CPU *did* complete startup here, unlike that flake's own
signature). Per protocol: stopped immediately, no retry, no correction, N=8/N=12/N=16 not run.
None of the E126 tracers (`PANIC_CAUSAL_TRACE`/`WDT_CAUSAL_TRACE`/`MWDT_ACCOUNTING`) apply to a
directed reproduction of this specific failure, since no reset/panic/watchdog event occurred --
`LASECSIMUL_XTENSA_PC_SAMPLER` (pre-existing, unrelated to this session) is the relevant instrument
for a future attempt. See EVIDENCE.md E127 for the full account, including the honest disclosure
that E125's own candidate SHA (`2043C031...`) is no longer recoverable as a standalone binary
(overwritten in place before this task's stricter immutable-copy requirement existed).

**E126 update**: set out to close the residual TG1-IntWDT mechanism (E111, `source=SW_CPU_RESET_
REGISTER`) under VNEXT_B+MTTCG, without reopening CACHEERR/teardown/UART/I2C/backpressure. Read
real ESP-IDF source (`esp_restart_noos()`, `int_wdt.c`'s CPU1-tick-blame design, `highint_hdl.S`'s
TG1WDT/CACHEERR disambiguation) end to end and proved the given occurrence's (E125's own
`attempt_2`, PID 62440) `count=3/4/5` cascade is exactly `esp_restart_noos()`'s own documented
per-CPU reset sequence -- not a QEMU artifact. Found and fixed two real, previously-undiscovered
tracer gaps: (1) `PANIC_CAUSAL_TRACE` (E122) was wired only to the `SW_SYS_RESET` branch (CACHEERR)
-- structurally blind to the `SW_APPCPU_RESET`/`SW_PROCPU_RESET` branches this mechanism actually
uses; now fires on all three, via a new pure/unit-tested function
(`esp32_panic_trace_should_capture()`, 6/6 PASS). (2) `WDT_CAUSAL_TRACE`/`MWDT_ACCOUNTING`'s
reset-snapshot reporting was hardcoded to TG0 only, despite this task's own instruction not to
assume TG1 by historical name and PID 62440's own ambiguous `wdt0_enabled=1`/`wdt1_enabled=0`
snapshot -- now per-TG. Also proved directly from source (`hw/block/m25p80.c`, `hw/ssi/esp32_spi.c`)
that the flash critical section CPU1 was inside never releases the BQL or touches VNEXT_B, excluding
Category 6 (artificial emulator block) for that window by construction. **12 fresh reproduction
attempts (4xN=1 + 8xN=8) with all three tracers armed came back completely clean** -- zero
unexpected resets, zero CACHEERR, `cellPass=True teardownClean=True unexpectedResets=0` on all 8
N=8 attempts -- so no live `exccause` frame for this mechanism was captured this session.
**Classification is reported as inconclusive on a live frame**, with TG1-IntWDT/host-scheduling-
contention stated as the leading, source-grounded but unproven hypothesis; no functional correction
was applied (Fase 7's own gate: only after classification). New candidate (supersedes E125's binary
in place, same directory): `3D65BD36D27D380207D0A0DAC1100AD9CCE702C5B6BA6A642E4A745437073FC2`. See
EVIDENCE.md E126 for the full mechanistic reconstruction and the next continuation's exact
instructions (re-arm the three gates on this candidate the next time the mechanism reproduces).

**E125 update**: reviewed E124's fix for race-freedom, permanent-stall risk, and reset lifetime, per
its own explicit charter -- did **not** reopen the CACHEERR root cause, which is treated as proven.
Found and closed three real gaps in `esp32_cache_state_update()`/`esp32_dport_reset()`: (1) the
region disable ran *before* the stall was requested -- read `accel/tcg/cputlb.c` directly (not
assumed) to show the BQL does not close this window in general, since cross-CPU `tlb_flush()` uses
`async_run_on_cpu()`; reordered to request-stall / apply-region-change / release-after-confirmed
so both the proven access pattern and the general TLB-caching case are covered; (2) the release
condition was a global `drom0_enabled && iram0_enabled` that could never fire again once either
region was independently, legitimately masked -- a real, provable permanent stall, replaced with a
per-region bitmask (`appcpu_cache_race_stall_mask`) that tracks only true transitions caused by a
different core and clears per-region; (3) `esp32_dport_reset()` never cleared the new flag/mask nor
the cache registers/`MemoryRegion.enabled`/`illegal_access_status` -- now explicitly reset for both
cores. Added the deterministic unit test E124 itself flagged as missing: a pure, dependency-free
extraction of the mask logic (`include/hw/misc/esp32_cache_race_stall.h`) plus
`test-esp32-dport-cache-race-stall` (13/13 PASS, including a literal RED encoding of E124's original
formula proving it would have stalled forever in the pre-existing-mask case). Fase 4 fidelity check
against `qemu_simulide` (read-only, no code copied) confirms neither real hardware's documented
behavior nor the reference fork has any automatic cross-core cache stall -- **this fix is recorded
honestly as an MTTCG-specific compensation, not a model of literal silicon behavior**. Validated: 4
more N=8/60s real-firmware attempts, combined with E124's own 4, = **8/8 total zero CACHEERR**; one
attempt shows the separate, already-known TG1-IntWDT mechanism (E111), correctly classified apart,
not mixed in, watchdog untouched. New candidate (supersedes E124's binary in place, same directory):
`2043C031AAD3265CC599B9256D5E78AF2C9C90532A06A3076506C622085C1CD3`. See DECISION-018 and
EVIDENCE.md E125 for the full account.

**E124 update**: the CACHEERR variant of mechanism 2 (`PANIC_RSN_CACHEERR`, `source=RTC_RESET`) is
now **fixed**, root-caused with a complete register-level capture (not inference): a genuine race
between CPU0's `spi_flash_mmap_init()`-driven cache disable/restore cycling and CPU1's
post-`s_resume_cores` read of `g_startup_fn[1]` (DROM0 `0x3f4049f0`) -- real ESP-IDF's own
`spi_flash_disable_interrupts_caches_and_other_cpu()` assumes the other core cannot be touching
DROM0 during its unsynchronized, scheduler-not-started fast path, an assumption this fork's MTTCG
timing can violate once APP CPU has passed `s_resume_cores` but the scheduler still hasn't started.
Fixed by extending the existing `appcpu_stall_req` mechanism to hold APP CPU while a *different*
core has its cache disabled (`hw/misc/esp32_dport.c` + `hw/xtensa/esp32.c`) -- no global MTTCG
serialization, no change to legitimate illegal-access detection. Validated: 4/4 clean N=8/60s
(zero CACHEERR, zero unexpected resets of any kind), full QEMU/Core regression suites green
(`test-esp32-timg-pause` 7/7, `test-vnext-b-classify` 9/9, `vnext_b_attachment_test` 31/31,
`mcu_component_live_poll_thread_test` all OK, `session_restart_stress_test` 15/15,
`b11_classify_test.ps1` 30/30, `run_regression.ps1` VNEXT_B+MTTCG 13/13 x2, LEGACY+MTTCG 13/13 x1).
Gap flagged (not silently skipped): no dedicated synthetic unit test was built for this exact race;
RED/GREEN relied on real-firmware reproduction instead. **The already-known, separate TG1-IntWDT
variant (E111, `source=SW_CPU_RESET_REGISTER`) is untouched and reproduced again, unprompted,
during this entry's own N=1 smoke test** -- not a regression, the same mechanism E111 already
froze at its `wdt_time_scale` cap. B11 restart is still not authorized/attempted this session; when
it does restart, a residual `unexpectedResets>0` at N=8/12/16 must be checked against its
`source` field to tell the TG1-IntWDT variant (already understood, not a new finding) apart from
any genuinely new mechanism. See EVIDENCE.md E124 for the full capture and H1-H8 evaluation.

**E123 update**: `TEARDOWN_HANG`/E104 -- one of B11's own prerequisite gates -- is now genuinely
**fixed**, not merely bounded. Root cause reproduced directly (`LASECSIMUL_TEARDOWN_TRACE`
instrumentation, not inference): a Windows `CreateProcessW(bInheritHandles=TRUE)` handle-inheritance
leak in `QemuProcessManager::start()`, where a concurrently-launched sibling session (N>1,
`LASECSIMUL_SCALE_PARALLEL_START=1`) could inherit a stray copy of this session's QEMU-log-pipe
write handle, leaving `joinReader()`'s `m_reader.join()` (no timeout) blocked until the sibling's
QEMU also exited. **This supersedes E120/E121's own `Scheduler::stop()`/`VnextBWaitDispatcher`
circular-wait hypothesis** -- that theory was plausible but never source-proven, and direct
reproduction shows both of those complete in ~1ms every time; the real block was always inside
`QemuProcessManager::stop()`. Fixed via `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`
(structural elimination, no serialization/timing dependency). `VnextBWaitDispatcher::unregister()`
was separately hardened with a real drain contract (wait-set generation + callback-in-flight,
condition_variable-based, 5s traced-not-silent timeout backstop) -- a real gap independent of
whether it caused the observed hangs. Validated: N=1/N=2x3/N=8x3, real firmware, 60s each,
`teardownClean=true` and zero `TEARDOWN_HANG` in **7 of 7**, defensive-timeout/Job-Object backstop
never triggered. `SessionRestartStressTest` 15/15, `vnext_b_attachment_test` 31/31,
`mcu_component_live_poll_thread_test` all OK, `b11_classify_test.ps1` 30/30 -- see EVIDENCE.md E123.

**B11 restart remains not authorized**: during the N=8/60s validation above, E122's panic tracer
captured its first-ever real frame -- `exccause=7`/`PANIC_RSN_CACHEERR` on core 1,
`tg1_wdt_source20_active=0` (definitively NOT the interrupt watchdog), `pc` at `call_start_cpu1`
with `a2=0xBAADBAAD` about to be called through as `g_startup_fn[core_id]`, `virtual_ns≈20.1s`
(a later reboot, not first boot). Per this task's own stop rule, the E123 session ended here rather
than proceeding to B11 -- mechanism 2 must be resolved (or a deliberate scope decision made and
documented) before B11 restarts. See EVIDENCE.md E123 Phase 6b.

Status: **OPEN.** A mandatory pre-B11 audit of DECISION-014's scope (Phase 1) passed for all 7
already-fixed devices under VNEXT_B+MTTCG, by direct source proof (only 2 `cpu_loop_exit_restore()`
call sites reachable from any of them, both BQL-held throughout) plus an empirical concurrent test
(`max_concurrent=1` under sustained real contention) -- see EVIDENCE.md E119. It also found a real,
non-blocking, LEGACY-only gap (six of the seven devices still call `writeReg()` synchronously from
within their own dispatch, and LEGACY's `arenaTransactionBegin()` briefly releases the BQL there),
not exercised by B11 or by the declared production topology, recorded as an open follow-up, not
investigated in E120 either.

E119's own finding is now **CLOSED**: `esp32_cache_data_sync()` no longer calls `blk_pread()` at
all (structurally confirmed: zero occurrences in `hw/misc/esp32_dport.c`'s dispatch path) -- it
reads the m25p80 flash chip's own coherent, always-current RAM storage directly via a new public
API, `m25p80_read_array()` (`hw/block/m25p80.c`/`include/hw/block/flash.h`), proven by source
reading to be the same array the chip's own SPI program/erase commands already mutate synchronously
(BlockBackend was always persistence-only, never the read-back path). Proven empirically too: zero
`Blocked re-entrant IO` across every run in E120, including two clean real-firmware N=8 runs before
the official B11 restart. `esp32_dport`'s reentrancy guard was correctly left enabled throughout
(this fix removes the BQL release itself, rather than suppressing its symptom).

B11 was **restarted from N=1** with the E120 candidate: **N=1 PASS**, **N=8 STOPPED** again --
`anyBlockedReentrantIo=False` throughout, confirming this is NOT E119/E120's own mechanism. E121
root-caused this to **two distinct, source-level-symbolized mechanisms**, not the single
"pre-existing flake" E120 provisionally called it:

1. **ROM, PRO_CPU-only anti-glitch efuse recheck** (`_rtc_trigger_sw_system_reset`/
   `_reload_efuses_and_check`, confirmed via `xtensa-esp32-elf-objdump` against the real
   `esp32_rev300_rom.elf`) -- fires unconditionally on CPU0 every boot by ROM design, but its
   100ms `QEMU_CLOCK_VIRTUAL` poll delay (`hw/nvram/esp32_efuse.c`) had a real, provable defect:
   `timer_mod_anticipate_ns()`'s "never push a pending deadline later" semantics silently
   discarding a fresh trigger's own deadline. **Fixed**: `timer_mod()` instead.
2. **ESP-IDF application panic** (`panic_handler`->`esp_restart_noos_dig`, symbolized against the
   firmware's own ELF), occurring post-boot with the watchdog already armed -- **newly
   discovered, NOT fixed**. Most plausibly (not proven) an interrupt-watchdog timeout under real
   N=8 host contention, per `panic_handler.c`'s own dedicated `PANIC_RSN_INTWDT_CPU0/1` handling
   and this project's extensive prior history with TG1 IWDT sensitivity under load (E111-E114) --
   the exact panic reason was not captured in this entry.

**E122 update**: built `LASECSIMUL_PANIC_CAUSAL_TRACE` (`hw/misc/esp32_rtc_cntl.c`), reading
ESP-IDF's own `XtExcFrame` (exccause/pc/ps/excvaddr/a0-a15/sar) plus the DPORT INTWDT/CACHEERR
disambiguation state directly from guest memory at the SW_SYS_RESET write, with every address/
offset/`PANIC_RSN_*` value independently confirmed by disassembling this session's own
`firmware.elf` (not copied from another ESP-IDF version or firmware build). The tracer did **not**
fire across 8 bounded N=8 attempts (64 sessions, gate on) -- mechanism 2 simply did not reproduce.
Per the task's STOP CONDITION C, closed for this session with the instrumentation proven correct
(clean compile, disassembly-matched addresses, zero behavioral perturbation in the gate-off smoke
test and all 8 gate-on campaigns) but no capture. **The exact panic reason for mechanism 2 remains
unproven** -- "most plausibly an interrupt-watchdog timeout" above is still only a hypothesis, now
with a ready-to-use instrument (no rebuild needed) to settle it the next time it reproduces. See
EVIDENCE.md E122 for the full disassembly-level ground truth and a concrete, falsifiable candidate
explanation (E111/E112's already-closed, DECISION-004-capped `SW_CPU_RESET_REGISTER` mechanism, a
*different* ESP-IDF exit path that may or may not share the same root cause -- not assumed either
way without frame-level proof).

A bounded 8×N=8 validation campaign (E121) with mechanism 1's fix applied: 6/8 attempts fully clean, 2/8
still show `unexpectedResets=2` (mechanism 2's signature -- every session in every attempt still
reached `appCpuStartupObserved=true`, a materially better but still non-passing result). **Does
not meet the zero-unexpected-reset gate. Not promoted.** N=12/N=16 not run. No SHA promoted;
canonical `B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E` unchanged. The E121
candidate (`D7A2896D843FBC6C5386CF57690292A37A4EDFA58A207C4E612E325B879C838C`) is preserved. B12
and the section-12 matrix remain **not authorized** until B11 passes.

Separately, E104's harness teardown hang (Sessions>1) is bounded and diagnosed, **not eliminated**
(the exact circular-wait hypothesis was not restructured, per this codebase's own documented
caution about unproven concurrency changes in this area) via a 15s-per-session defensive timeout
plus a flushed, structured per-session JSONL result written before any teardown starts -- N>1
measurements no longer report submissions/completions/artifactFatal as "not available." **E121
correction**: `TEARDOWN_HANG` genuinely fires in real runs (confirmed in the raw B11_restart logs)
-- this is a forced exit via the Job-Object-backed defensive timeout, not a graceful shutdown, and
`b11_classify.ps1` now has an explicit `teardownClean` field that fails the cell whenever it
occurs, independent of how clean the per-session JSONL data looks (a gap in E120's own oracle,
which could previously score a hung-teardown run as fully clean). See EVIDENCE.md E121 for the
full mechanism and every test result.

### E117 Core-side prepare()/activate() race

Status: FIX CONFIRMED AND UNIT-TESTED, kept unmodified by E118 -- see above for
the second (now also fixed) defect this alone did not close. `VnextBAttachment::
prepare()`/`activate()` provably closes the specific registration-ordering race
(dispatcher registered and `m_vnextBAttached=true` strictly before `coreEvent`
is signaled) -- structural trace-order proof plus `E117_PHASE3_LIFECYCLE_
ORDERING` and `E117_PHASE3_LANE_DEPTH2_NO_LOSS_WITH_CONSUMER` in
`vnext_b_attachment_test`, both PASS, zero regressions in the pre-existing
P1-P8/R3A/R3C suite (nor in E118's own additions -- see above).

### B0.1 (VNEXT_B/MTTCG diagnostic hygiene + causal consumer)

Status: CLOSED from E109, 2026-09-04. `PLAN_MTTCG_VNEXT_B_CAUSALITY.md` phases R0-R3c executed:
explicit transport/execution-mode in the harness (R1), thread-safe lazy-init hygiene for every
`static int cached` site (R2, diagnostic-only), a unit-tested temporal-merge arbiter replacing
lane-index-biased VNEXT_B consumption (R3a/R3b), and a pacing-only `QEMU_CLOCK_VIRTUAL` heartbeat
watermark (R3c, DECISION-012) proving virtual-time advancement for legitimately silent guests.

Closure criteria met: three independent fresh-process `run_regression.ps1 -Transport VNEXT_B
-ExecutionMode MTTCG` runs (r3c5, r3c6, r3c10) all 13/13 PASS; LEGACY+MTTCG reported separately,
13/13 PASS (r3c9), no lateral regression; runtime/firmware/harness/manifests preserved by SHA
(`QEMU_RUNTIME.json`, `QEMU_RUNTIME_SHA256=A0BEAAE014ECB02DCF82CB9B4920BF478592D891C8524417CEF12A4CA0B4804D`).
A 4-run LEGACY failure streak during this closure (`waitForSynch TIMEOUT`) was isolated to a stale
incremental link, not a source defect -- resolved by a full rebuild, documented in E109 rather
than discarded.

**Not closed by this gate:** B10-R (N=1 MWDT smoke under VNEXT_B+MTTCG), B11/B12 (the original
MWDT N=1/8/12/16 scale matrix), and the plan's own section-12 2x3 causal matrix
(VNEXT_B/LEGACY x MTTCG/single-realtime/icount) are all still open. See `NEXT_ACTION.md`.

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

**Production path: PASS as of E114 (2026-09-04).** Two real defects were
found and fixed earlier (E102/E103/E106) but were not the cause of the
residual failure; the actual cause (a pause-compensation arithmetic bug,
E114) is now found, fixed, and validated -- see the E114 update below for
the full account and validation numbers. Historical narrative below
(E107-E113) preserved for the record.

Fixed and validated (E102, E103, E106): three unbounded per-operation
diagnostic sites produced 99.97% of all QEMU output, and the worst sat outside
the watchdog's compensated pause window. After the fix a 16-session run emits
~2,600 lines instead of 258,247, and every session's reset records survive
Core's 1 MiB retained log. The ten-test Core regression set is identical on the
patched and pre-patch binaries.

Still open after CPU1 compensation (E107): a fed guest still takes
MWDT-attributed resets under load.

```text
sessions   MWDT-attributed resets
   1, 4, 8    0
  12          3
  16, reserve 6 cores   5, 2, 12, 12, 7
  16, reserve 2 cores   2, 3, 3, 2, 3
```

Clean through 8 sessions, intermittent from 12. Extra host CPU reduces but
does not eliminate the residual; CPU1 transport-pause compensation is now
present and likewise did not close the gate.

**Update from E110 (B10-R, post R3a-R3c arbiter+heartbeat, 2026-09-04):** the
above table predates R3's causal-consumer fix (DECISION-012). A fresh N=1/60s
measurement on the current source shows the residual reset count down ~92%
(7 vs. the original 89), but still present -- and, new this entry, **shown
not to be primarily MWDT-stage-driven**: only 1 of 8 resets in an
instrumented run correlated with an actual `first_actual_stage_expiry`
event. E110's own framing of the other 7 as "a separate, software-driven
APP-CPU restart loop" was superseded by E111 below.

**Update from E111 (root-cause investigation, 2026-09-04):** the residual
resets are **the genuine TIMER_GROUP1 Interrupt Watchdog timeout
mechanism**, already fully diagnosed by an independent, 22-round prior
investigation (`.spec/archive/legacy-v2/lasecsimul.spec` 32.5.1-32.5.22,
2026-07-26/28) and already at the limit of its existing mitigation
(`wdt_time_scale`'s DECISION-004-frozen cap of 100, plus an already-committed
`Scheduler::markDirty()` non-blocking-publish fix). Confirmed via a
byte-for-byte matching `timg_wdt_expire` -> `intmatrix_line26`(source=20) ->
`reset_cpu_sw`(`esp_cpu_reset`/`esp_restart_noos`/`panic_abort`) chain,
captured twice on this session's own binaries. A single LEGACY-transport
sample (2 resets/60s vs. VNEXT_B's 10, one run each) showed the *mechanism*
is not VNEXT_B-exclusive, but does **not** establish that VNEXT_B carries no
amplification on top of it -- E111's original text overclaimed this,
corrected in `EVIDENCE.md`. Three clean baseline runs with a
previously-unconditional, now-gated diagnostic trace
(`LASECSIMUL_CACHE_TRACE`, DECISION-013) turned off show the identical,
perfectly deterministic 10/60s rate -- ruling out that hidden instrumentation
as the cause.

**Update from E112 (factorial firmware experiment, 2026-09-04):** ran the
actual experiment E111 had only proposed. `guest_i2c_workload/src/main.cpp`
(already in this repo) drives I2C and Serial together every ~1ms. Six
firmware variants isolating I2C cadence from Serial verbosity, each
SHA-preserved separately, show **Serial/UART call frequency correlates with
the storm, not I2C polling cadence**: reducing only Serial output dropped
resets sharply at unchanged I2C cadence; heavy Serial with **zero I2C
traffic** still reproduced storm-magnitude resets in one of three 60s
confirmation runs. E112's own counting mixed the expected
once-per-boot-epoch APP-CPU-startup reset into these totals -- see E113's
correction for the real numbers (variant 3 is actually 0/0/0, not 1/1/1;
variant 6's run2 was an invalid execution, not "0 resets").

**Update from E113 (diagnostic control, 2026-09-04):** built
`LASECSIMUL_UART_DISABLE_CORE_NOTIFY` to test E112's H1 directly (does
removing UART's per-byte VNEXT_B Core notification, while leaving local FIFO
timing untouched, eliminate the storm?). On variant 6 (no I2C, UART the only
possible transport source), it did not -- with confirmed zero VNEXT_B lane-0
traffic for the entire run, the storm persisted at the same order of
magnitude. **H1 (UART-lane0-exhaustion-starves-the-watchdog) is refuted.**
Also found and fixed: the new `[LANE0_DIAG]` snapshot was originally scoped
to TIMER_GROUP1 only, on the same TG1-exclusive assumption E111's write-up
made -- re-checking E111's own evidence shows `timg_wdt_expire` firing on
**both** TG0 and TG1 (majority TG0).

**Update from E114 (causal ring buffer + fix, 2026-09-04) -- PRODUCTION PATH
GATE NOW PASS.** Root cause found: `esp32_timg_transport_pause_apply()`
double-compensated a transport pause whenever a WDT FEED landed between the
pause opening and the apply call running -- the feed resets `ws->ns_base`
unconditionally with no knowledge of the open pause, so the old formula
(`ns_base += now - pause_start`) re-added the *entire* pause duration on top
of an anchor the feed had already advanced, pushing `ns_base` past the
current virtual time. The next `esp32_timg_wdt_get_count()` call underflowed
(unsigned), collapsing the following ARM's computed timeout to ~0ns --
confirmed byte-for-byte via a new bounded causal trace
(`LASECSIMUL_WDT_CAUSAL_TRACE`). Fixed by compensating only the pause
interval not already covered by a more recent anchor
(`effective_start = max(pause_start, ns_base)`), plus a defensive backstop in
`get_count()`. Does not touch `wdt_time_scale`, any programmed timeout,
`stage_timer` semantics, or reset classification/policy.

**Validated**: 3x15s UART/I2C-isolated (variant 6, confirmed-zero UART
publication and no I2C traffic -- not "zero VNEXT_B traffic": other
peripherals' lane-0 activity, e.g. GPIO/IO_MUX, remained active, see
EVIDENCE.md E113's terminology correction and E114's Stop Condition 1),
3x15s baseline, 3x60s baseline -- **0/0/0 unexpected
`SW_CPU_RESET_REGISTER` across every run**; two 60s runs recorded one
genuine watchdog interrupt each, correctly fed by the firmware before any
escalation, proving the watchdog mechanism itself still functions, just no
longer corrupted. Full regression: VNEXT_B+MTTCG 13/13 twice, LEGACY+MTTCG
13/13 (after investigating and explaining three prior host-load-flaky
attempts on one unrelated, pre-existing-pattern test -- see EVIDENCE.md
E114). New canonical QEMU SHA
`6BD9D596FCDF722B8A39094E7F9F7B315903496B59A58A2F410028F57467B4C6`.

Not UART, not I2C, not host-scheduling cost (H1/H4 both superseded) -- those
were correlated symptoms (any peripheral's lane-0 traffic could open the
pause that triggered the bug), not the mechanism. See `NEXT_ACTION.md` and
`EVIDENCE.md` E111/E112/E113/E114.

Raising
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

### E139 ROM/EFUSE interlock gate

Status: `REVIEW_REQUIRED / BLOCKED_FOR_PROMOTION`.

The EFUSE-specific gate passed: RED old-model proof, new EFUSE unit 18/18, N=1 RTC-only real boot, and B11 N=16 RTC-only 3/3 all validate that the ROM/EFUSE boot-reset signature is not reproduced by the E139 candidate (`8F7F7A334FFA17A6B8FC080EB75F70BD9D85EBECFB3F07A1BCC2A6995BF612AD`). Required non-regressions also passed before the stop: WDT scale 13/13, TIMG pause 7/7, VNEXT_B classify 9/9, `vnext_b_attachment_test`, `session_restart_stress_test`, and two VNEXT_B+MTTCG regressions 14/14.

Promotion/B12 is blocked because B11 zero diagnostics N=16 run 1 reproduced a separate post-boot E135 signature in session 7 (`pc0=0x400dca9f`, `pc1=0x40082c2c`, `source=RTC_RESET`, `boot_epoch=2`, WDT0 enabled), followed by `SW_CPU_RESET_REGISTER`. That failure is not ROM/EFUSE and must be handled as a separate E135 causal gate. The canonical runtime and `QEMU_RUNTIME.json` are unchanged.

### E140 post-boot cause-latch diagnostic gate

Status: `DIAGNOSTIC_COMPLETE / NO_RECURRENCE_IN_BOUNDED_WINDOW / NO_PROMOTION_AUTHORIZED`.

E140 added a minimal opt-in latch behind
`LASECSIMUL_POSTBOOT_CAUSE_LATCH=1` to capture first cause before reset cleanup
for cache wait/cache illegal, WDT stage expiry, and interrupt-matrix sources 20
and 68. Unit/small regressions passed, including the new
`test-esp32-postboot-cause-latch` and the existing cache/WDT/EFUSE/panic-gate
coverage.

Bounded real validation passed with only the latch enabled:

- N=1/60s: 1/1 workload, `submissions==completions>0`, zero unexpected reset,
  zero CACHEERR/Guru, zero real cause latch, clean teardown, zero orphans.
- N=16/60s x3: 48/48 workloads, `submissions==completions>0`, zero unexpected
  reset, zero CACHEERR/Guru, zero real cause latch, clean teardown, zero
  orphans.

This gate does not close the historical initiating cause. It only proves that
the rare post-boot signature was not reproduced in the authorized bounded
window with the minimal latch active. Any future recurrence must be classified
from the first latch event/sequence; late `pc0=0x400dca9f` and
`pc1=0x40082c2c` alone remain insufficient.

No B12, runtime promotion, canonical replacement, package/release, LEGACY,
ICOUNT, SINGLE_REALTIME, or semantic QEMU/Core/firmware change is authorized by
this gate.

### E141 production-clean consolidation gate

Status: `PARTIAL_PASS / STOP — NEW FUNCTIONAL RED OUTSIDE AUTHORIZED SCOPE`.

QEMU-side and Core-side diagnostic-instrumentation removal (candidate
`475C0FC956E43FFC0CB83CECE0DC384457A9E1F01D2C6A3F6C21C4665C7EB23D`) is
complete; a string/symbol absence sweep confirmed the ~30 named diagnostic
markers are gone from the built binary. Under the explicit
`APPROVE_TEST_ORACLE_REPLACEMENT_ONLY` authorization, `VnextBAttachmentTest.cpp`
was fully re-oracled off the removed `[VNEXT_B_STARTUP]`/
`LASECSIMUL_VNEXT_STARTUP_TRACE` log lines onto existing production ABI/state
(lifecycle state, `artifact_state`, the R3c heartbeat watermark, real ring
occupancy, `artifact_progress_ns`) with zero new logs/counters/ABI
fields/hot-path hooks. **PASSED: 3/3 clean runs, 33/33 subtests each, zero
QEMU orphans** (see `EVIDENCE.md`'s E141 Part B). The 5 deterministic QEMU
unit tests and two full `run_regression.ps1 -Transport VNEXT_B -ExecutionMode
MTTCG` runs (14/14 both times, SHA confirmed) also passed against the
candidate afterward.

**Gate does not pass overall.** The next step in the task's own validation
sequence, `session_restart_stress_test`, failed 15/15 cycles with real
firmware: zero I2C lane traffic (`submissions=0/0 completions=0/0
artifact_progress=0/0`) for the entire run despite a normal-looking QEMU boot.
Classified (see `EVIDENCE.md` Part C) as a probable real regression in Core's
production VNEXT_B dispatch pipeline (`McuComponent.cpp`/`McuController.cpp`/
`VnextBWaitDispatcher.cpp`, all edited during this episode's diagnostic
removal) — proven NOT explained by the QEMU binary (identical failure
reproduced against the independently-verified-unchanged E139 candidate,
which this same episode's own preserved log shows PASSING 15/15 earlier
today against the same firmware/test source), NOT the firmware (unchanged
SHA), and NOT the test oracle itself (test source byte-identical to a
previously-passing version). This is a genuine functional red, and fixing
the suspected files is outside `APPROVE_TEST_ORACLE_REPLACEMENT_ONLY`'s scope
(limited to `VnextBAttachmentTest.cpp`), so no fix was attempted.

No B11, B12, promotion, `QEMU_RUNTIME.json` edit, cleanup, commit, push, tag,
release, or further Core production edit is authorized until this regression
is explicitly authorized for investigation/fix and resolved.

### E142 causal-bisection gate — E141-cleanup hypothesis DISPROVEN; real defect is pre-existing

Status: **STOP / HYPOTHESIS_DISPROVEN / NEW_UNFIXED_DEFECT_PREDATES_E141**.

A controlled, same-environment A/B test (pre-E141-cleanup Core code vs.
current post-cleanup code, both built and run against the identical E141
candidate QEMU binary, identical firmware, identical priority/affinity)
found **both variants fail identically**: `session_restart_stress_test`'s
lane 0 fills to its configured depth (`write_seq=8`) and Core never drains a
single event (`read_seq=0`) for the whole 5 s window, every time. Per this
task's own Phase-3 rule ("se ambos falharem... não atribua a limpeza"), the
E141 diagnostic-removal cleanup is **not** the cause of this regression —
whatever is wrong predates it.

Root boundary located precisely (read-only instrumentation, no diagnostic
markers involved): the first real guest event sits at
`timestamp_ns≈305 ms` (QEMU-relative), `VnextBArbiter` correctly classifies
it as not-yet-ready because the Core `Scheduler`'s own `nowNs()` never
exceeds ~234-251 ms — despite `McuComponent::pacingPositionNs()` (the
advance-limit floor) reporting ~4.03 s, i.e., the pacing/advance-limit
mechanism is *not* the bottleneck. Two unconfirmed candidate mechanisms are
recorded in `EVIDENCE.md`'s E142 entry (`Scheduler::scheduleEventUnlocked()`
never calling `signalWorkAvailable()`, unlike every sibling entry point; the
real-time pacing throttle's interaction with repeated future-event
deferrals) but neither was instrumented/confirmed, and no fix was attempted
— out of scope once the E141 attribution was disproven.

`VnextBAttachmentTest.cpp` (33/33), the two prior 14/14 regressions, and the
5 deterministic QEMU unit tests all remain green and unaffected — this
defect is specific to the real production dispatch pipeline under
`session_restart_stress_test`'s real-firmware, restart-stress scenario.

No B11, B12, promotion, `QEMU_RUNTIME.json` edit, cleanup, commit, push,
tag, release, or Scheduler/dispatch production fix is authorized by this
gate. Next action is a scope decision (see `NEXT_ACTION.md`), not a fix made
unilaterally.

### E143 H143 gate — mechanism confirmed and fixed in isolation, then reverted (Phase-2 gate not met)

Status: **H143_PARTIALLY_CONFIRMED / STOP / FIX_REVERTED_PER_EXPLICIT_RULE**.

`McuComponent::pollAndDispatchPendingEvents()`'s post-ack block
(`hasPendingLaneEvents() && !budgetExhausted -> scheduleNextPoll()`, i.e.
always `now+1ns`) was audited directly, confirmed to unconditionally
preempt (via `m_pollGeneration` bump) a correctly-installed
`schedulePollAt(futureDeadline)` callback whenever the same still-undrained
future head remains after the ack -- exactly H143's hypothesis. A pure,
unit-tested policy function (`VnextBArbiter::decidePostAckRearm()`)
replacing it converged in a controlled RED/GREEN simulation at E142's exact
measured scale: RED (old policy) stuck at `finalNowNs=250,002,000` after
2000 iterations, deadline `305,000,000` never reached; GREEN (new policy)
converged in 1 iteration, `finalNowNs=305,000,000` exactly, consumed once.
12 pure tests total, all pass (`vnext_b_arbiter_test.exe`, 0
warnings/errors).

Applied to production and tested against the real E141 candidate 3 times:
`m_pollGeneration=0` in all 3 (storm eliminated, confirming the mechanism),
but `Scheduler::nowNs` still never reached the real ~305ms deadline in any
of the 3 runs (217.6ms / 150.8ms / 185.6ms measured), and
`submissions=0/0 completions=0/0` persisted in all 3. Per this episode's
own explicit Phase-2 gate and stop condition, H143 is refuted as the sole,
complete explanation, and the production fix (`McuComponent.cpp`) was
reverted -- confirmed exact by rebuilding and reproducing the original
storm (`m_pollGeneration=956`) once more.

The pure fix (`VnextBArbiter::decidePostAckRearm()` + its full RED/GREEN
test suite) remains in the tree, correct and unit-tested, but unused by
production code. `Scheduler.cpp`/pacing and `scheduleEventUnlocked()` were
explicitly NOT touched, per this episode's own constraints (no isolated RED
proved a lost wake there specifically).

No B11, B12, promotion, `QEMU_RUNTIME.json` edit, cleanup, commit, push,
tag, or release. Next action is a decision on how to investigate the
deeper, still-unidentified cause (see `NEXT_ACTION.md`), not a fix made
unilaterally.

### E144 H143 gate, corrected — Release formal gate GREEN; B11 N=16 incomplete after a host freeze

Status: **REVIEW_REQUIRED — H143 FIXED AND VALIDATED FOR RELEASE; B11 N=16
STOPPED AT 1/3 FOR HOST SAFETY; QEMU-side RESET_WAIT/E131 not re-run**.

E142/E143's classification is corrected: E132-E's historical
`session_restart_stress_test 15/15` ran a **Release** build; E142/E143 had
been running **Debug** without noticing. A Release baseline taken before
any E144 edit passed 3/3 (1-cycle) even with the still-unfixed H143 bug
present, proving Release simply isn't blocked by the busy loop today (fast
enough to grind past it), while Debug is. H143 itself is real regardless --
a direct, literal violation of `PLAN_MTTCG_VNEXT_B_CAUSALITY.md` section
10.4 step 5 and section 10.2 -- and was re-fixed using the already-tested
`decidePostAckRearm()` from E143 (no design change).

Post-fix: `vnext_b_arbiter_test` 12/12 (Release); `session_restart_stress_
test` (Release, default 15-cycle) **15/15**, matching E132-E exactly;
`vnext_b_attachment_test` (Release) 3/3 runs, 33/33 each; two full
`VNEXT_B+MTTCG` regressions 14/14 each; B11 N=1/N=8/N=12 all clean
(`workloadPass=true` every session, `submissions==completions` every
session, `MWDT_ATTRIB_RESETS=0`). A Debug time series (30s, 250ms cadence)
proved Debug is slow, not frozen: `Scheduler::nowNs` increases on every
sample, never flat >=2s.

**B11 N=16 reached only 1 of the required 3 valid runs.** Run 1 passed
cleanly (16/16 sessions, 32/32 resets, 0 MWDT-attributed). Launching run 2
immediately afterward (same `-Force`-oversubscribed 32-vCPU-slots-on-26-
cores pattern, no cooldown) froze the host; the user had to hard-reset the
machine. This matches `run_production_mwdt.ps1`'s own documented prior
freeze incident. Not retried this episode. Post-recovery: zero orphans,
idle CPU, all E144-edited files verified intact.

`RESET_WAIT` (3/3) and `E131` (6/6) -- QEMU-side, already closed at
E132-B, unchanged QEMU binary -- were not re-executed (Core-only fix,
explicitly out of this episode's blast radius, flagged rather than
assumed).

No B12, promotion, `QEMU_RUNTIME.json` edit, cleanup, commit, push, tag,
or release. Next action: either accept the current evidence (N=1/8/12
clean, N=16 1/3 clean with a documented, non-test-related stop) as
sufficient for closure review, or explicitly authorize a safer B11 N=16
retry (real cooldown/headroom, not immediate back-to-back bursts) -- see
`NEXT_ACTION.md`.

### E145 — H143 closed for Release; safe MTTCG capacity computed AND enforced in production; RESET_WAIT/E131 blocked by a pre-existing, unrelated oracle issue; B12 not run

Status: **REVIEW_REQUIRED — H143_CLOSED, CAPACITY_GUARD_SHIPPED, B12_NOT_ATTEMPTED**.

H143 re-confirmed fixed and wired to production (`McuComponent.cpp` calls
`qemu::decidePostAckRearm()` directly). A production-path capacity guard
(`VnextBCapacityGuard.hpp` + `McuController.cpp`) now computes
`safe_sessions` from the real host topology and refuses, fail-closed,
before any QEMU process starts, to admit more VNEXT_B sessions than the
host can safely carry -- this host: 13. 20/20 pure unit tests pass
(12 H143 + 8 new capacity-guard cases, below/at/above the limit, edge
cases, and a second host shape proving the formula isn't hardcoded).

Four full 15-cycle Release `session_restart_stress_test` runs: 2/4 clean
15/15, 2/4 with 1-2 early-cycle-only misses -- every miss showed
**zero H143 storm signature** (`m_pollGeneration=0`) and 90-100% real lane
drainage, i.e. structurally NOT H143, a separate/narrower/new finding.
Two full Release `VNEXT_B+MTTCG` regressions: 14/14 both times. B11
(Release, `-Force` never used): N=1 one intermittent miss (same shape as
the restart-test finding, resolved on retry) then PASS; N=8 8/8 PASS;
N=12 12/12 PASS; **N=13 (this host's calculated safe ceiling) was not
executed** -- the user, informed of a second host freeze that occurred
during this episode's own planning, explicitly chose to skip it for this
episode rather than attempt the exact-boundary case again immediately.

**RESET_WAIT/E131 could not be validated**: `cache_wait_e2e_real_qemu_
test.exe`'s own pass/fail oracle depends on QEMU-side diagnostic env vars
(`LASECSIMUL_E131_TCG_TRACE` and 3 others) and log-grepping for markers
those diagnostics used to produce -- all four confirmed absent from the
entire `qemu_lasecSimul` tree (E141 removed them correctly). E132-E's
historical E131 PASS used a different, pre-E141, non-production-clean QEMU
build. This is the first time E131/RESET_WAIT has run against the E141
candidate at all, and it surfaces a harness/oracle incompatibility --
**not** a functional regression, **not** caused by H143. Not fixed in this
episode (out of scope: reopening E131 as exploratory investigation and
reintroducing removed traces are both explicitly forbidden).

Per the task's own gating, **B12 was not attempted**: Phase 3 is
structurally blocked and Phase 5's N=13 cell was not executed. No
`QEMU_RUNTIME.json` edit, promotion, cleanup, commit, push, tag, release,
or package. Zero QEMU orphans at every checkpoint, including through a
second host freeze this episode itself did not cause (it occurred during
planning, before any N=13 command was ever issued -- `-Force` was never
used in this episode).

Next action is a decision on the two newly-surfaced, separate findings
(the early-cycle/N=1 timing intermittency; the E131/RESET_WAIT oracle
incompatibility) and on whether/when to attempt B11 N=13 -- see
`NEXT_ACTION.md`. Not a fix to make unilaterally.
