# Decisions

## DECISION-038 — E137 classification corrected to E121 ROM/EFUSE boot reset

**Status:** REVIEW REQUIRED — semantic fix not authorized.
**Date:** 2026-09-08
**Evidence:** E138 ROM/EFUSE classification report
**Request ID:** `E138-rom-efuse-classification-20260908`

E138 supersedes the prior E137 broad panic/CACHEERR classification. E137
sessions 6/PID 3120 and 14/PID 15540, plus E138 session 14/PID 6588, are
classified as E121 ROM/EFUSE boot reset:

`E137_CAPTURED_E121_ROM_EFUSE_BOOT_RESET — E135_POST_BOOT_PANIC_NOT_REPRODUCED`.

The candidate `3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`
was used directly and not promoted. Canonical rollback
`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E` and
`QEMU_RUNTIME.json` remained unchanged.

Review is required before any semantic EFUSE fix. The approved next diagnostic,
if review requires more proof, should be limited to a bounded opt-in EFUSE
memory ring that proves exact ROM sub-branch, per-call RDATA, and timer/CMD
ordering. Cache/TG1/WDT/transport/scheduler investigations, B12 and promotion
remain blocked.

## DECISION-037 — Runtime promotion rolled back on first post-promotion red

**Status:** ACTIVE — canonical runtime restored to rollback; promotion not complete.
**Date:** 2026-09-07
**Evidence:** Runtime promotion execution
**Request ID:** `B12-runtime-promotion-execution-20260907`

The controlled runtime promotion was attempted under the approved
`VNEXT_B+MTTCG` scope, then automatically rolled back on the first
post-promotion red.

Preconditions passed and the candidate was temporarily promoted: candidate/build
SHA `3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`, prior
canonical SHA `B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`,
rollback snapshot created and verified, DLLs preserved, and canonical
`qemu --version` exited 0. QEMU deterministic gates then passed:
WDT scale 13/13, TIMG pause 7/7 and VNEXT_B classify 9/9.

The first red was in the Core gate sequence, before regressions or B11:
`vnext_b_attachment_test` skipped because `LASECSIMUL_TEST_QEMU_BINARY` was not
available, and `session_restart_stress_test` launched
`devices/qemu-esp32/bin/qemu-system-xtensa.exe` rather than the promoted
canonical runtime, causing incompatible arena ABI v5 handshake timeout and
15/15 startup failures.

Per protocol, no retry or code fix was attempted in the same task. The canonical
runtime and `QEMU_RUNTIME.json` were restored to SHA
`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`; zero QEMU
processes remain. Promotion is not complete.

Next decision/action should correct the promotion gate invocation/path so the
Core post-promotion gates exercise the promoted canonical runtime, then restart
the controlled promotion from the restored rollback state.

## DECISION-036 — APPROVE runtime promotion execution after B12

**Status:** ACTIVE — bounded runtime promotion execution authorized, not yet performed.
**Date:** 2026-09-07
**Evidence:** B12 runtime promotion review
**Request ID:** `B12-runtime-promotion-review-20260907`

Runtime promotion execution is approved for `VNEXT_B+MTTCG` only. The approved
candidate SHA is
`3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`; the current
canonical rollback SHA is
`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`.

The review was read-only. It did not promote, copy, delete, cleanup, commit,
push, tag or release, and it did not modify `QEMU_RUNTIME.json`.

Promotion is authorized only with a controlled procedure: verify candidate and
canonical SHA, snapshot the current canonical executable plus adjacent DLLs,
verify rollback snapshot, stage the candidate as a temporary file in the
canonical directory, verify the staged SHA, replace only the executable,
preserve DLLs, update `QEMU_RUNTIME.json`, run bounded post-promotion gates
through the canonical path, and restore rollback automatically if any gate
fails. Rollback must not be deleted after promotion.

Post-promotion gates are limited to affected deterministic QEMU tests,
`vnext_b_attachment_test`, `session_restart_stress_test`, one full
`VNEXT_B+MTTCG` regression 14/14, B11 N=1, one B11 N=16 cell, SHA confirmation,
and zero unexpected reset/loss/desync/fatal/teardown-hang/reentrancy/orphan.

The dirty-tree audit is acceptable for promotion execution because all required
production/test/runner/ABI sources are present and inventoried, and the current
`build-ucrt64` executable hashes byte-identical to the preserved candidate. The
subsequent commit must include the inventoried source set; this decision does
not authorize commit/push/tag/release.

`LEGACY`, `ICOUNT`, `SINGLE_REALTIME`, Phase C and the historical 2x3 matrix are
not authorized by this decision.

## DECISION-035 — B12_PASS: promotion review authorized for VNEXT_B+MTTCG

**Status:** ACTIVE — B12 passed; runtime promotion requires separate review.
**Date:** 2026-09-07
**Evidence:** B12 final decision report after E134/B11 closure
**Request ID:** `B12-final-decision-vnext-b-mttcg-after-e134`

B12 passes for the production topology `VNEXT_B+MTTCG` only. The approved B11
artifact set contains no current active anomaly: all sessions across N=1, N=8,
N=12 and N=16 have workload progress, `submissions==completions>0`, zero
unexpected resets, no artifact fatal, clean teardown and zero owned QEMU
orphans.

The approved B11 executions all used candidate QEMU SHA256
`3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`, with
firmware/harness identities preserved by SHA. The current canonical runtime
remains SHA256
`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E` and remains
the rollback. `QEMU_RUNTIME.json` was not changed by B12.

Classification is `NO_ACTIVE_ANOMALY_OBSERVED`. There is no current population
of failures to classify as starvation-compatible, transport anomaly, or
execution-path anomaly. The historical requirement for 20 unique resets applies
to causal classification of a failure population and is not a blocker for a
fully clean campaign.

No capacity guarantee, progress-aware host clock, or new watchdog compensation
is justified by current evidence. Phase C is not started by this decision.

Recommendation: authorize a separate promotion review for the preserved E134
candidate. This B12 decision does not itself promote the runtime and does not
authorize cleanup, commit, push, tag, release, or non-`VNEXT_B+MTTCG` gates.

## DECISION-034 — APPROVE: E134/B11 closure; B12 authorized for VNEXT_B+MTTCG

**Status:** ACTIVE — E134 and B11 closed; B12 authorized only for `VNEXT_B+MTTCG`.
**Date:** 2026-09-07
**Evidence:** E134 closure review
**Request ID:** `E134-wdt-scale-reanchor-closure-review`

The E134 closure review is approved. E134 corrects an internal inconsistency in
the existing watchdog scale/reanchor behavior: the effective timeout is now
computed in scaled tick domain, while `count_base` remains literal and guest
registers remain raw. This does not increase the watchdog, mask callbacks,
suppress legitimate expirations, or change transport/reset/firmware semantics.

The approved candidate QEMU SHA256 is
`3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`. Production
uses the shared helper directly from `esp32_timg_wdt_arm()`, clamps deadlines to
`INT64_MAX`, normalizes scale zero to 1, keeps scale 1 literal-equivalent, uses
the same math for TG0 and TG1, and leaves E114 pause compensation intact.

Validation is sufficient for closure: deterministic WDT scale tests passed
13/13 direct and via Meson/Ninja; two `VNEXT_B+MTTCG` regressions passed 14/14
using the candidate SHA; B11 was restarted from zero and passed N=1, N=8, N=12,
and N=16 three times with 16/16 workloads, submissions equal to completions,
zero unexpected resets, no artifact fatal, clean teardown and zero owned QEMU
orphans.

Accepted caveat: the rebuilt no-feed MWDT fixture did not emit observable
stdout/stderr in bounded QEMU attempts, so no new integrated no-feed
later-expiry proof is claimed in this round. This is not blocking because prior
device expiry behavior exists, scale 1 remains literal and tested, the
deterministic suite proves the scaled later-expiry boundary, E134 does not
disable timers/callbacks, and production regressions/B11 are clean.

B12 is authorized exclusively for `VNEXT_B+MTTCG`. Runtime promotion is not
authorized as part of this review and remains a separate explicit post-B12
decision. Preserve the current canonical runtime as rollback.

## DECISION-033 — APPROVED/IMPLEMENTED: WDT scale must not collapse across neutral reanchor

**Status:** ACTIVE — implementation complete; closure review required before B12/promotion.
**Date:** 2026-09-07
**Evidence:** E134 phase 1 and phase 2

E134 phase 1 confirms a source/math inconsistency in the current watchdog
implementation: `esp32_timg_wdt_get_count()` accumulates literal APB/prescale
ticks, `esp32_timg_wdt_update_config()` materializes that literal count into
`count_base`, and `esp32_timg_wdt_arm()` compares it with raw `stage_timeout`
before multiplying nanoseconds by `wdt_time_scale`. With scale 100, a neutral
reconfiguration can therefore collapse a deadline that should still be tens of
seconds away.

The requested E133 sequence reconstructs to current rearmed deadline
`3,426,994,200 ns` versus intended scaled deadline `33,122,494,200 ns`. A RED
test now preserves this failure in
`tests/unit/test-esp32-timg-wdt-scale.c`.

Review approved the semantic correction. The implemented policy represents the
effective stage timeout in scaled ticks while leaving `count_base` literal,
guest-visible registers raw, scale 1 literal, FEED/stage/reset modes intact,
and E114 pause compensation intact. Deadlines passed to
`timer_mod_anticipate_ns()` are clamped to `INT64_MAX`. The same helper is used
directly by production `esp32_timg_wdt_arm()` and by deterministic tests.

Validation completed: WDT scale test 13/13 PASS, QEMU candidate build PASS, two
`VNEXT_B+MTTCG` regressions 14/14 PASS, B11 N=1/N=8/N=12 PASS and N=16 PASS
3/3 with `MWDT_ATTRIB_RESETS=0`.

Known caveat: the rebuilt no-feed MWDT diagnostic fixture did not produce
observable stdout/stderr in bounded QEMU attempts, so it is not counted as a
completed integrated later-expiry proof. Any true prescaler-change semantic
revision is explicitly out of E134 and remains a separate possible issue.

## DECISION-032 — E133 narrows B11 N=16 but does not authorize B12/promotion

**Status:** ACTIVE — B11 causal closure remains open.
**Date:** 2026-09-07
**Evidence:** E133

E133 corrected only runner/harness truth and cleanup behavior, not QEMU/Core/
firmware semantics. The old B11 runner was fail-open (`runner_exit=0` with
`cellPass=false`); the new runner fails closed and its deterministic tests pass
14/14, including owned-process cleanup and non-owned-process preservation.

The N=16 first red remains a real B11 oracle failure. E133 narrows the observed
failure to a scale-sensitive TG1 watchdog expiry followed by ESP-IDF guest
software reset/panic path (`SW_CPU_RESET_REGISTER` / `SW_APPCPU_RESET`), with a
separate silent-workload/panic symptom. This is not sufficient to classify the
root cause as direct MWDT reset, CACHEERR, reentrancy, teardown, or simple
oversubscription: `MWDT_ATTRIB_RESETS=0`, no CACHEERR/Guru/reentrancy/
teardown-hang was observed, and R0/no Force failed once after an initial R0 pass.

Consequence: B11 remains open. Do not run B12, promote runtime, cleanup, commit,
tag or release until the causal gap between TG1 expiry and guest software reset/
silent workload is proven and either fixed or explicitly dispositioned by
review.

## DECISION-031 — B11 N=16 vermelho bloqueia B12/promoção apesar de N=1/8/12 verdes

**Status:** ACTIVE — fail-closed no primeiro vermelho B11 pós-review.
**Date:** 2026-09-07
**Evidence:** E132-F

A sequência pós-review `VNEXT_B+MTTCG` avançou com determinísticos 8/8,
RESET_WAIT 3/3, E131 6/6, duas regressões 14/14 e B11 N=1/N=8/N=12 verdes.
Mesmo assim, B11 não está fechado: N=16 falhou com `cellPass=false`, 14 resets
inesperados e 13/16 workloads passando. A falha não deve ser classificada por
atalho como MWDT, CACHEERR, reentrância ou teardown, porque os marcadores
medidos foram `MWDT_ATTRIB_RESETS=0`, `CACHEERR=0`, `Guru=0`,
`Blocked re-entrant IO=0` e `TEARDOWN_HANG=0`.

Consequência: não executar B12, promoção de runtime, cleanup, commit, tag,
release, `LEGACY`, `SINGLE_REALTIME` ou `ICOUNT` enquanto o N=16 preservado não
for classificado/endereçado por evidência.

## DECISION-030 — restart VNEXT_B usa liveness estrutural, não logs diagnósticos

**Status:** ACTIVE — E132-D saneado; validação pós-review pode prosseguir sem promoção.
**Date:** 2026-09-07
**Evidence:** E132-E

`session_restart_stress_test` em `VNEXT_B+MTTCG` deve provar boot/liveness por
estado estrutural: `firmwareRunning()`, scheduler rodando e avanço de
`pacingPositionNs()`. Quando roda com flash vazia, o teste prova somente
lifecycle/pacing/execId/stop limpo/sem órfãos; não deve exigir I2C/stale/GPIO ou
workload UART real. Quando roda com firmware real, deve exigir progresso
estrutural por contadores de submissions/completions I2C e artifact progress.
Logs diagnósticos como `[VNEXT_PROBE]` não são oráculo formal.

E132-E fechou o primeiro vermelho determinístico sem mudança semântica de
QEMU/produção: blank 3 ciclos, real 2 ciclos e formal real 15 ciclos passaram
com traces operacionais OFF, zero timeout e zero QEMU órfão. Isso permite
retomar a sequência pós-review, mas ainda não autoriza promoção de runtime,
release, `LEGACY`, `SINGLE_REALTIME` ou `ICOUNT`.

## DECISION-029 — teste de restart VNEXT_B não pode depender de trace opt-in

**Status:** SUPERSEDED by DECISION-030 / E132-E.
**Date:** 2026-09-07
**Evidence:** E132-D

Um teste formal `VNEXT_B+MTTCG` não pode usar a presença de uma linha
diagnóstica gated por ambiente (`[VNEXT_PROBE] after qemu_init`) como oráculo de
liveness quando a própria política de validação exige traces operacionais OFF
por padrão. O vermelho de `session_restart_stress_test` deve ser tratado como
harness/precondição provável até que o oráculo seja substituído por sinal
estrutural não diagnóstico ou por firmware real explícito. Não há autorização
para avançar regressão, B11, B12, promoção ou release enquanto este primeiro
vermelho não for saneado e retestado.

## DECISION-028 — reviewer fecha E131 somente para VNEXT_B+MTTCG; validação pós-review segue

**Status:** ACTIVE — E131 fechado para `VNEXT_B+MTTCG`; promoção ainda bloqueada por gates posteriores.
**Date:** 2026-09-07
**Evidence:** E132-C

`WORK_RESULT.json` com `request_id=E132-B-review-20260907` aprovou o fechamento
estrito de E131. Essa decisão não certifica `LEGACY`, `SINGLE_REALTIME` nem
`ICOUNT`, e não promove o runtime canônico. O próximo caminho autorizado é:
rebuild controlado, determinísticos afetados, RESET_WAIT 3/3, E131 6/6, duas
regressões `VNEXT_B+MTTCG` 13/13 e B11 desde N=1, sempre parando no primeiro
vermelho real.

## DECISION-027 — oráculo RESET_WAIT usa progresso de execução, não tradução nem FreeRTOS

**Status:** ACTIVE — fechamento E131 VNEXT_B+MTTCG aprovado por reviewer.
**Date:** 2026-09-07
**Evidence:** E132-B

O oráculo arquitetural aceito para RESET_WAIT é: geração APP CPU aumenta
exatamente uma vez; a espera antiga é cancelada sem `resume_committed` stale;
CPU1 está livre em R6; e seu contador monotônico de entradas em `cpu_exec()`
cresce antes do marcador tardio do cenário. Novas traduções TCG não são
obrigatórias porque TBs existentes podem executar sem retradução. Progresso de
task FreeRTOS também não é obrigatório porque um reset isolado da APP CPU não
reconstrói por si só o protocolo completo de boot SMP do firmware.

Com 3/3 RESET_WAIT e 6/6 na bateria completa, E131 pode ser fechado para
VNEXT_B+MTTCG após revisão. Isto não autoriza promoção, B11, LEGACY nem mudança
semântica adicional.

## DECISION-026 — E132 torna o supervisor fail-closed; RESET_WAIT ainda bloqueia o fechamento

**Status:** ACTIVE — supervisor corrigido; E131 e promoção permanecem abertos.
**Date:** 2026-09-07
**Evidence:** E132

O runner não pode declarar PASS apenas pelo exit code. A decisão exige código
observado após `WaitForExit()`/`Refresh()`, summary presente e sem falhas,
stderr sem `E131_FAILURE`, último progresso `exit:return:detail=0`, begin/end de
`stopSimulation`, ausência de órfão e ambiente pai restaurado. Contradições são
`SUPERVISOR_INTEGRITY_FAIL`; exit code indisponível é
`SUPERVISOR_EXITCODE_UNAVAILABLE`.

A reaplicação do RESET_WAIT preservado provou que o antigo manifesto era falso:
summary com quatro falhas e progresso terminal `detail=1` não pode mais virar
PASS. O gate funcional continua bloqueado pela geração de reset não incrementada
e pelo oráculo FreeRTOS pós-reset não justificado. Nenhuma semântica QEMU foi
alterada e `QEMU_RUNTIME.json` continua intocado.

## DECISION-025 — E131-E closes cache-wait for VNEXT_B+MTTCG, but does not promote runtime or change QEMU semantics

**Status:** ACTIVE — proof closure only for E131 cache-wait VNEXT_B+MTTCG; broad promotion remains blocked.
**Date:** 2026-09-07
**Evidence:** E131-E

E131-E supersedes the unsafe interpretation of the E131-C/D red observations.
The correct classification is that E131-A was structurally
invalid/inconclusive, E131-D did not demonstrate a QEMU semantic defect, and
the observed post-D transient QEMU was a harness cleanup artifact caused by the
old internal `std::_Exit` watchdog path.

The cache-wait proof is accepted for VNEXT_B+MTTCG because the final harness
and runner:

- use fresh, independent QEMU processes per scenario;
- preserve `merged.bin`, `firmware.elf`, linker map, hashes, stdout/stderr,
  UART, QEMU log, progress JSONL, and environment manifests;
- prove hermetic `LASECSIMUL_*` handling and parent environment restoration;
- call `session.stopSimulation()` and return normally instead of using
  `std::_Exit`;
- passed RUNSTALL 3/3 and the full six-scenario cache-wait battery 18/18.

This decision does **not** authorize any QEMU semantic change. It also does
**not** authorize copying/promoting the rebuilt QEMU into the runtime/device
location or editing `QEMU_RUNTIME.json`.

Broad runtime promotion remains open because Phase7 exposed independent issues:
the default `devices/` QEMU is stale relative to the current arena ABI, and the
separate LEGACY+MTTCG production-scale gate failed at attempt 1 with zero
submissions and unexpected `SW_CPU_RESET_REGISTER` resets. Those are separate
follow-up problems, not E131 cache-wait proof blockers for VNEXT_B+MTTCG.

## DECISION-024 — E131-B closes the isolated cache-wait proof without authorizing a production semantic change

**Status:** ACTIVE — evidence/proof closure only; no runtime promotion.
**Date:** 2026-09-06
**Evidence:** E131-B

E131-B validates the isolated cache-wait end-to-end behavior under
VNEXT_B+MTTCG using fresh QEMU processes per scenario and immutable
per-scenario artifact preservation. This closes the proof gate that E131-A
failed to satisfy, but it does **not** authorize a production semantic change
or runtime promotion.

The accepted proof basis is the exact artifact/log correlation recorded in
`EVIDENCE.md` E131-B:

- ELF/map/objdump/addr2line prove placement of the controller/worker/helper
  code in `.iram0.text`, the DROM value in `.flash.rodata`, and the fetch
  target in `.flash.text`.
- DROM data-load proof requires `mem_io_pc != 0` and successful TCG restore
  to the exact disassembled load PC.
- Instruction-fetch proof accepts `mem_io_pc == 0` and
  `attempted=0/restored=0` when translation demonstrably begins again at the
  same guest PC.
- RUNSTALL, CLKGATE, SELF_ILLEGAL and RESET_WAIT remain separate
  classifications; none may be used to contaminate or shortcut the DROM/FETCH
  proof.

The `instruction_replayed` diagnostic counter is not currently authoritative
for this gate. Future sessions must not regress to E131-A's invalid criterion
of comparing an owed PC to a later sampled APP CPU PC.

`QEMU_RUNTIME.json` remains outside this decision. Promotion still requires a
separate directed promotion gate.

## DECISION-023 — E131-A replay-PC evidence is invalid; future cache-wait E2E proof must separate data-load from fetch

**Status:** ACTIVE — test/evidence discipline only; no production semantic
change is authorized by this decision.
**Date:** 2026-09-06
**Evidence:** E131-B

E131-A's `target_pc_match=0` failure is not valid evidence of a replay
failure. `target_appcpu_pc` was a later sampled APP CPU PC, not the guest PC at
the exact first retry/retranslation point. A later `_UserExceptionVector` or
other sampled PC can be a consequence of many paths and must not be used as
the replay criterion.

Future VNEXT_B+MTTCG cache-wait E2E proof must classify evidence as:

- source-proven;
- ELF/map/disassembly-proven;
- hypothesis/pending.

The absence of a simple symbol is not proof that a helper was inlined or that
it resides in IRAM. Placement must be confirmed with `xtensa-esp32-elf-nm
-anC`, linker map, `objdump -t -h -d`, `addr2line`, and call-site/address
inspection. `extern "C"`, `IRAM_ATTR`, `noinline`, and `used` may help shape
or retain a symbol, but they are not final proof of where execution actually
occurs. The ELF/map/disassembly is authoritative.

For the DROM data-load gate, the APP-side controller must be proven to execute
from physical IRAM before the target DROM access. Passing evidence requires a
cache-wait on the DROM data load itself, with `mem_io_pc != 0` and successful
TCG restore.

For the instruction-fetch gate, a wait observed during translation/fetch may
correctly have `mem_io_pc == 0`; requiring `cpu_restore_state()` in that case
is wrong if the evidence shows translation restarts at the same guest PC.

Every scenario must run in a fresh QEMU process and preserve its own
`merged.bin`, `firmware.elf`, map file, SHA-256 values and full logs before
execution. Shared-process multi-scenario runs are useful for smoke testing but
cannot close this gate.

## DECISION-022 — every reset path reaching a `cpu_stop_current()`-parkable CPU must itself call
`cpu_resume()`; the B11 measurement gate uses a frozen per-session cutoff, never a live re-read

**Status:** ACTIVE — `REVIEW_REQUIRED=YES` carries forward from DECISION-017/018/020/021 for the
reset-path fix (touches the same cache-wait/reset interaction that gate protects); the
measurement-gate change is test-infrastructure only, no `REVIEW_REQUIRED` (does not touch guest-
visible semantics).
**Date:** 2026-09-05
**Evidence:** E130

**Part 1 — reset must resume a parked CPU.** `hw/xtensa/esp32.c`'s `esp32_app_cpu_reset_async()`
(reached by the per-CPU `SW_CPU_RESET_REGISTER` and `MWDT_CPU_STAGE` reset paths, both deliberately
routed via `async_run_on_cpu()` instead of `qemu_system_reset_request()` — "under MTTCG the
requesting PRO CPU could race the delayed global reset handler", the code's own comment) called
`cpu_reset(cs)` but never `cpu_resume(cs)`. `cpu_reset()`/`cpu_common_reset_hold()`
(`hw/core/cpu-common.c`) resets registers/PC/`halted` but never touches `cpu->stop`/`cpu->stopped`
— confirmed by reading the function. A reset landing while the target CPU was
`cpu_stop_current()`-parked (DECISION-021's cache-wait interlock, or a VNEXT_B backpressure stop)
would reset its registers to the boot vector and leave it **permanently asleep** in
`qemu_wait_io_event()`. The two full-system-reset paths (`esp32_dig_reset()`/
`esp32_timg_sys_reset()`) never had this gap, because they go through
`qemu_system_reset_request()`'s own `pause_all_vcpus(); qemu_system_reset(...); resume_all_vcpus();`
sequence, which unconditionally calls `cpu_resume()` for every CPU. **Fixed**: added
`cpu_resume(cs)` in `esp32_app_cpu_reset_async()` right after `cpu_reset(cs)`, mirroring
`resume_all_vcpus()`'s own unconditional per-cpu call. Safe because whatever the CPU was waiting
for is moot once its registers are reset (a spurious extra wake-and-resuspend cycle at worst, no
duplicated side effect — the same self-correcting property DECISION-021's replay design already
relies on), and it does not bypass RUNSTALL (`esp32_cpu_stall()`, called immediately after on the
same code path), which remains the actual, orthogonal mechanism holding APP CPU from making
progress during controlled startup.

**A future session adding any new `cpu_stop_current()` site to this fork must verify**: every reset
path that can reach a CPU parked by that new site also calls `cpu_resume()` for it — do not assume
the full-system-reset path's `resume_all_vcpus()` covers a narrower, per-CPU-only reset path just
because it happens to share a name or a nearby code region. `grep -rn "cpu_stop_current\|cpu_resume("`
the whole fork and trace each reset trigger's actual call graph; do not infer coverage from a
reset's `source=` tag alone.

**Part 2 — the B11 harness measures against a frozen cutoff, never a live re-read.** E120's own
convergence-wait loop (`VnextBProductionScaleTest.cpp`) polled `submitted != completed`, broke on
the first observed equality, then a SEPARATE, LATER loop re-read both counters fresh for the actual
pass/fail decision — with the guest still running, unpaused, in between. Proven (E130, by reading
`McuComponent.cpp`'s single-consumer dispatch loop and by live repro,`postCutSubmissions` up to 598
observed 3/3 times) to produce exactly a `submissions=completions+1`-shaped artifact whenever a new
guest submission (and its near-simultaneous completion) landed in that gap — not a transport loss.
**Fixed**: `core/src/mcu/qemu/DrainCutoffGate.hpp`'s `waitForAllToDrain()` — each session's
submission count is captured ONCE, at the measurement deadline, as `submissionCutoff[i]`, never
re-read; the gate then waits (bounded) for `completionCount >= submissionCutoff[i]`. Reported
`submissions`/`completions` always derive from that frozen cutoff, never from a fresh counter read.

**A future session touching this measurement path must preserve**: never re-read a session's
submission count after the cutoff is captured, for any purpose that feeds the pass/fail decision or
the JSONL record — a "just check both counters again" fix reintroduces exactly this bug. The
`completionCount >= cutoff` predicate depends on the underlying transport being single-consumer,
strictly-ordered per session (verified for this pipeline in E130) — if that pipeline is ever changed
to process a session's requests out of order or across multiple consumer threads, this predicate's
soundness must be re-verified, not assumed to still hold.

**Not yet closed by this decision**: the cache-wait interlock's live end-to-end firing (a real
`wait_detected`→`suspend_committed`→`resume_committed`→`instruction_replayed` sequence observed in
a real run, not just proven structurally) was not captured this session despite 7 reproduction
attempts. B11 N=16 also fails, but for a reason outside this decision's scope entirely (the
separate, pre-existing TG-watchdog-under-oversubscription issue) — see EVIDENCE.md E130.

## DECISION-021 — DECISION-020's deadlock is FIXED: the cache-race compensation is a per-access
interlock (suspend-on-actual-fault, not blanket runstall), not a CPU-wide stall

**Status:** ACTIVE — `REVIEW_REQUIRED=YES` carries forward from DECISION-017/018/020 (same
mechanism). Supersedes DECISION-020's "no fix yet" status; DECISION-020's own account of the
deadlock is kept, unmodified, as the historical record of what was proven and why the obvious fix
was rejected.
**Date:** 2026-09-05
**Evidence:** E129 (fixing E128, which DECISION-020 recorded)

`hw/misc/esp32_dport.c`'s `esp32_cache_state_update()` no longer calls
`esp32_dport_update_appcpu_stall()`/engages `xtensa_runstall()` for the cache-race reason at all.
Instead: `Esp32DportState::appcpu_cache_externally_disabled_mask` (renamed from
`appcpu_cache_race_stall_mask`, same gain/release computation, now PURE bookkeeping) records which
of APP CPU's own regions a different core currently holds disabled; a second mask,
`appcpu_cache_wait_mask`, is set only when APP CPU's own load or instruction fetch actually LANDS
on a region in that state — checked inside `esp32_cache_ill_read()`, the illegal-access-trap
`MemoryRegion`'s own read callback, which every access to a disabled DROM0/IRAM0 region (genuinely
illegal or merely compensable) already passes through. Only that specific access suspends, via
`cpu_stop_current()` + `cpu_loop_exit_restore(cpu, cpu->mem_io_pc)` — the same idiom this fork
already uses throughout for VNEXT_B backpressure replay (`softmmu/vnext_b.c`), proven safe there
across dozens of prior sessions: it never releases the BQL, so it coexists without any new
"coexistence logic" alongside reset/clkgate/RUNSTALL, which remain entirely on the separate
`env.runstall`/`appcpu_stall_req` axis this mechanism no longer touches. APP CPU's own unrelated
execution (e.g. `spi_flash_op_block_func()`'s `IRAM_ATTR` busy-wait, architecturally outside the
disabled flash-cache windows) is never stalled — closing the exact deadlock DECISION-020 recorded,
since that busy-wait can now run to completion regardless of what DPORT's cache-control registers
are doing at the same moment.

**A genuine architectural constraint, discovered by a failed build, not anticipated**:
`hw/misc/esp32_dport.c` compiles into `libcommon.fa` (QEMU's target-independent shared library) and
cannot `#include "exec/exec-all.h"` (which pulls in the target's own `cpu.h`) — confirmed by a
`fatal error: cpu.h: No such file or directory`, not assumed from documentation. The actual
`cpu_stop_current()`/`cpu_loop_exit_restore()` call therefore lives in a new thin wrapper,
`vnext_cache_wait_suspend_current_cpu()` (`softmmu/vnext_b.c`, declared in `vnext_b.h`) — `vnext_b.c`
is compiled per-target (`softmmu/meson.build`) and is already the established home for every other
such call site in this fork (`esp32_i2c.c`/`esp32_uart.c` call their own thin wrappers there, never
the primitive directly, for the identical reason).

**Validated**: `tests/unit/test-esp32-dport-cache-race-stall.c` grew from 13 to 27 tests (14 new,
covering the exact deadlocking scenario — APP CPU running physical-IRAM code outside any tracked
region must never wait — and its inverse, plus PRO-CPU/self-disable/permanently-masked/unattributed
exclusions and per-region release independence); the identical real-firmware scenario that showed
`submissions=0` under the old mechanism now shows `submissions=6820`+; 10/10 fresh N=1 real-firmware
attempts clean; the formal B11 N=1 cell now passes for the first time in this investigation's
history. `esp32_cache_race_stall_gain()`/`_release()` (the mask-computation pure functions) are
UNCHANGED and remain correct — DECISION-017/018's own bit-clearing arithmetic was never the bug;
only what that bookkeeping was allowed to do (a blanket CPU stall) was.

**A future session touching this mechanism must preserve**: the per-access scoping (never
reintroduce a blanket `xtensa_runstall()`/`appcpu_stall_req` term for this reason); the orthogonal
separation from reset/clkgate/RUNSTALL (`cpu_stop_current()`/`cpu_resume()`, never `env.runstall`,
for this specific compensation); `esp32_dport.c`'s own inability to include target-specific headers
(any future primitive it needs from `exec/exec-all.h`/`sysemu/cpus.h` must go through a
`softmmu/vnext_b.c` wrapper, not a direct include); and `disable_reentrancy_guard = true` on
`illegal_access_trap_mem` (extends DECISION-014 to an eighth device/region, same justification: this
retry path never releases the BQL).

**Not yet closed**: the formal B11 N=8 cell stopped on a different, new, undiagnosed
submissions/completions mismatch (two of eight sessions off by exactly one completion) — unrelated
to this mechanism (zero resets, zero deadlock, zero reentrancy-block observed), not investigated in
this entry, and not to be conflated with the cache-race deadlock this decision closes. See
EVIDENCE.md E129's own "Next step" for how that should be approached.

## DECISION-020 — DECISION-017/018's cache-race-stall compensation has a proven deadlock gap; NOT
fixed yet, B11 blocked until it is

**Status:** OPEN FINDING, not a decision to act on yet — recorded so no future session mistakes
DECISION-017/018's mechanism for settled. `REVIEW_REQUIRED=YES` carries forward from those entries.
**Date:** 2026-09-05
**Evidence:** E128 (root-causing E127)

DECISION-017/018's `appcpu_cache_race_stall` compensation (`hw/misc/esp32_dport.c`'s
`esp32_cache_state_update()`, `hw/xtensa/esp32.c`'s `esp32_cpu_stall()`) is now proven, by direct
causal instrumentation and a controlled A/B test (not inference), to deadlock APP CPU permanently
when the stall happens to engage while APP CPU is mid-interrupt-return
(`_frxt_int_exit`) inside its own legitimate, `IRAM_ATTR` `spi_flash_op_block_func()` busy-wait —
freezing it there via `xtensa_runstall()` with no real-hardware equivalent, since that function is
architecturally unaffected by the DROM0/IRAM0 flash-cache windows the compensation disables. PRO
CPU then never issues the `APP_CACHE_CTRL` re-enable write that would release the stall, most
plausibly because PRO CPU itself becomes blocked on a FreeRTOS kernel resource APP CPU was holding
at the frozen instant. This is a **real, reproducible defect in the currently-shipped mechanism**,
not a theoretical concern — it is exactly what stopped the very first formal B11 cell (N=1).

**No fix is recorded here because none has been validated.** The obvious candidate — skip engaging
the stall when APP CPU's `PS.INTLEVEL`/`PS.EXCM` shows it is currently in interrupt/exception
context — has its own proven gap: nothing re-arms or re-applies the stall when APP CPU later
organically exits that interrupt context, since `esp32_cpu_stall()` only re-evaluates on a
subsequent register write, not on APP CPU's own asynchronous progress. Shipping it would trade a
fully-reproducible deadlock for an intermittent, harder-to-detect reopening of the exact CACHEERR
window E124 fixed — not an acceptable trade. A correct fix needs either a target-specific
interrupt-return hook (not available at the `hw/misc`/`hw/xtensa` boundary this mechanism lives at
today) or a structurally different mechanism (trap only the specific faulting access, rather than
stalling all APP CPU execution) — both larger redesigns than fit safely in one session.

**A future session designing that fix must preserve**: the actual CACHEERR protection (a
different core's disable of APP's own DROM0/IRAM0 must still prevent APP CPU from *reading* the
disabled region); MTTCG's per-vCPU-thread model (no global serialization); the existing mask's
correct bit-clearing arithmetic (`esp32_cache_race_stall_gain()`/`_release()`, still valid, still
13/13 in their own unit tests — the bug is in *when* the stall is allowed to engage, not in the
mask logic itself); reset-time cleanup (E125's own fix, still correct). **B11 must not be
reattempted until that fix exists and is validated with the same RED/GREEN + multi-attempt
real-firmware rigor E124/E125's own fixes required.**

## DECISION-019 — PANIC_CAUSAL_TRACE and WDT_CAUSAL_TRACE/MWDT_ACCOUNTING extended to cover the
SW_CPU_RESET_REGISTER reset path and TIMER_GROUP1, not just SW_SYS_RESET and TIMER_GROUP0

**Status:** ACTIVE — diagnostic-only, no semantic/functional change (same basis as DECISION-013);
recorded for continuity per that precedent, not because DECISION-004's `REVIEW_REQUIRED` gate
applies (no watchdog/reset/backpressure/ABI/scheduler semantic was touched).
**Date:** 2026-09-05
**Evidence:** E126

Two purely-additive extensions to existing, opt-in (off-by-default) diagnostics, both in
`hw/misc/esp32_rtc_cntl.c` / `hw/timer/esp32_timg.c`:

1. **`PANIC_CAUSAL_TRACE`** (E122) now also captures on `RTC_CNTL_OPTIONS0`'s
   `SW_APPCPU_RESET_MASK`/`SW_PROCPU_RESET_MASK` write branches, not only `SW_SYS_RESET_MASK`. The
   first branch was the only one wired since E122, because it was the only one needed for the
   CACHEERR investigation (`esp_restart_noos_dig()`'s mechanism); E126 found this left the
   `SW_CPU_RESET_REGISTER` mechanism (`esp_restart_noos()`, resetting each CPU individually)
   structurally unobservable by this tracer. The three branches now share one fired-once latch,
   labeled by a `trigger` field; the decision of which write should capture (skipping the one
   expected per-boot `SW_APPCPU_RESET_MASK` write, capturing every other occurrence) is a pure,
   unit-tested function, `esp32_panic_trace_should_capture()`
   (`include/hw/misc/esp32_panic_trace_gate.h`,
   `tests/unit/test-esp32-panic-trace-gate.c`, 6/6 PASS).
2. **`WDT_CAUSAL_TRACE`'s ring and `MWDT_ACCOUNTING`'s reset/expiry snapshot reporting** are now
   per-TIMER_GROUP (indexed by `id`, 0 or 1) rather than hardcoded to TIMER_GROUP0 only. The
   transport-pause-specific fields/events remain TG0-only, correctly — `esp32_timg_transport_
   pause()`/`_apply()` only ever operate on the TG0 instance, a real architectural fact rather than
   an arbitrary gate.

**Why**: E126's own task charter explicitly prohibited assuming the residual `SW_CPU_RESET_
REGISTER` mechanism (historically called "TG1-IntWDT") is actually TIMER_GROUP1 by name alone. A
given occurrence (E125's `attempt_2`, PID 62440) showed `wdt0_enabled=1`/`wdt1_enabled=0` at the
reset itself — genuinely ambiguous without a live frame. Both tracers were structurally incapable
of resolving this ambiguity even if armed, independent of which TG or mechanism turns out to be
correct: `PANIC_CAUSAL_TRACE` because it was wired to the wrong register branch entirely;
`WDT_CAUSAL_TRACE`/`MWDT_ACCOUNTING` because TG1 was never populated at all. Both gaps are real,
proven by reading the code (not merely theorized), and are closed here independent of the
mechanism's still-open classification (see EVIDENCE.md E126) — the fix is valuable regardless of
which TG or category the mechanism eventually turns out to be.

**Validated**: no regression in 12 fresh reproduction attempts (4×N=1, 8×N=8, all clean), the full
Core/QEMU regression matrix, and the new unit suite. No candidate promoted; canonical unchanged.

A future session touching either tracer should preserve: `PANIC_CAUSAL_TRACE`'s three-branch
coverage (do not narrow back to `SW_SYS_RESET` only); `WDT_CAUSAL_TRACE`/`MWDT_ACCOUNTING`'s
per-TG indexing (do not reintroduce a bare `id == 0` gate on the reset-snapshot/ring-dump paths);
and the transport-pause fields' correct TG0-only scoping (do not extend those specifically to TG1
without first proving `esp32_timg_transport_pause()` actually needs to operate on it, which it
does not today).

## DECISION-018 — DECISION-017's stall condition is a per-region mask, ordered before the region
change, and explicitly cleared on reset; recorded as MTTCG compensation, not modeled hardware

**Status:** ACTIVE — `REVIEW_REQUIRED=YES` per DECISION-004, same basis as DECISION-017 (this is a
direct hardening of that same mechanism, authorized by the E125 task's own charter to review and
narrow E124's fix before any B11 restart). Refines DECISION-017; does not reverse it.
**Date:** 2026-09-05
**Evidence:** E125

Three changes to the mechanism DECISION-017 introduced, all inside
`hw/misc/esp32_dport.c`'s `esp32_cache_state_update()`/`esp32_dport_reset()`:

1. **Ordering.** The stall is now requested (Phase A) *before* either `drom0`/`iram0`
   `MemoryRegion` is disabled (Phase B), and released (Phase C) only after the same region is
   confirmed re-enabled — E124's original code disabled the region first. Reading
   `accel/tcg/cputlb.c` directly (not assumed) shows the BQL does not close this window in
   general: cross-CPU `tlb_flush()` dispatches via `async_run_on_cpu()`, so a vCPU already holding
   a cached fast-path TLB entry for the affected page is not serialized against the writer by the
   BQL alone. Moot for the exact access pattern E124's own reproduction exercised (which must take
   the BQL-guarded device-dispatch slow path), but a real, general gap in the original ordering.
2. **Condition.** `Esp32DportState::appcpu_cache_race_stall` (a single bool, released only when
   `drom0_enabled && iram0_enabled` globally) is now backed by
   `appcpu_cache_race_stall_mask` (bits `ESP32_CACHE_RACE_STALL_DROM0`/`IRAM0`, defined in the new
   `include/hw/misc/esp32_cache_race_stall.h` and aliased into `esp32_dport.h`). A bit is set only
   on an observed enabled→disabled transition of *that* region caused by a *different* core
   (`esp32_cache_race_stall_gain()`), and cleared the instant *that same* region is next observed
   enabled regardless of who re-enabled it (`esp32_cache_race_stall_release()`). The bool is kept
   as a cached `mask != 0` value so `esp32.c`'s `esp32_cpu_stall()` needs no change. E124's global
   condition could never release once either region was independently, legitimately masked via
   `CACHE_CTRL1` for reasons unrelated to the race — a real, provable permanent stall, not
   theoretical (see the RED test below).
3. **Reset lifetime.** `esp32_dport_reset()` previously lowered `appcpu_stall_req` but never
   cleared the flag/mask, nor `cache_ctrl_reg`/`cache_ctrl1_reg`/`MemoryRegion.enabled`/
   `illegal_access_status` for either core. All of these are now explicitly, unconditionally reset
   — deliberately *not* routed through `esp32_cache_state_update()`, since `current_cpu` is
   meaningless (and potentially misleading) at reset time.

**New regression asset**: `include/hw/misc/esp32_cache_race_stall.h`'s two functions are pure and
dependency-free, unit-tested in isolation by
`tests/unit/test-esp32-dport-cache-race-stall.c` (13/13 PASS) — the exhaustive case
(`test_no_permanent_stall_path_exists`) proves no writer/old/new combination can leave a residual
mask bit once both regions are confirmed enabled, and `test_e124_original_formula_would_have_
stalled_forever` encodes E124's original global condition literally, as a permanent RED anchor,
since E124's own pre-review code no longer exists in the tree to call directly.

**Fidelity, recorded honestly per this task's own instruction**: read-only comparison against
`qemu_simulide/hw/misc/esp32_dport.c` shows no cross-core cache-disable stall of any kind in that
reference fork either, and ESP-IDF's own `components/spi_flash/cache_utils.c` documents relying on
*software* (`esp_ipc_call`) cross-core synchronization rather than an automatic hardware stall.
**DECISION-017/018's mechanism is therefore a deliberate, fork-specific compensation for this
fork's MTTCG timing, not a model of literal ESP32 silicon behavior.** No code was copied from
`qemu_simulide`; no more faithful alternative (keeping CPU1 resident in IRAM longer, a real cache
handshake, an atomic disable/restore sequence) was judged worth pursuing over this fix within this
review's scope.

A future session touching this mechanism should preserve: the per-region mask (never regress to a
single global "fully enabled" bool); the Phase A/B/C ordering (never disable a region before
requesting the stall it may require); and explicit reset of the mask/bool/registers/MemoryRegion
state (never rely on `esp32_cache_state_update()` at reset time). See EVIDENCE.md E125 for the full
account, the BQL/`async_run_on_cpu` proof, and all validation numbers.

## DECISION-017 — APP CPU is held (DPORT-level stall) while a different core holds its cache disabled

**Status:** ACTIVE — `REVIEW_REQUIRED=YES` per DECISION-004 (touches reset/cache semantics named in
DECISION-004's frozen area). Authorized directly by the E124 task brief's own Fase 7 (explicitly
listing "impedir CPU1 de executar enquanto DROM está desabilitado" as an acceptable fix category) —
recorded here per DECISION-004's requirement, not as a request for further approval.
**Date:** 2026-09-05
**Evidence:** E124

`hw/misc/esp32_dport.c`'s `esp32_cache_state_update()` now holds APP CPU (core 1) via this fork's
existing `appcpu_stall_req` mechanism whenever a *different* core (identified via `current_cpu`,
never core 1 itself or an unknown/reset-time writer) disables APP's own `drom0` or `iram0` cache
region, releasing it the instant both are enabled again. A new `Esp32DportState::
appcpu_cache_race_stall` flag participates in the same OR-of-reasons `appcpu_stall_req` already
computes for RUNSTALL/RESET/CLK-gate stalling (extracted into a shared
`esp32_dport_update_appcpu_stall()` helper); `hw/xtensa/esp32.c`'s `esp32_cpu_stall()` GPIO handler
(which recomputes its own stall condition rather than trusting the signaled level) was updated to
also check this flag.

**Why**: root-caused in E124 with a complete register-level capture — CPU0 (PRO), executing real
ESP-IDF's `spi_flash_mmap_init()` → `spi_flash_disable_cache()`/`spi_flash_restore_cache()`
(`components/spi_flash/cache_utils.c`), rapidly and repeatedly toggles `APP_CACHE_CTRL` (by design,
mirroring its own cache state onto APP's for multi-core safety) during early boot, relying on real
ESP-IDF's own documented assumption (`spi_flash_disable_interrupts_caches_and_other_cpu()`'s
scheduler-not-started fast path) that "APP CPU is either in reset or spinning inside
`call_start_cpu1`, which is in IRAM" — true only up to `s_resume_cores`. Once APP CPU passes that
wait it runs `ESP_SYSTEM_INIT_STAGE_SECONDARY` functions concurrently with PRO, still before
`vTaskStartScheduler()`, so the same unsynchronized fast path still applies — and under this fork's
MTTCG (genuinely concurrent vCPU host threads), APP CPU's own DROM0 read can land inside one of
PRO's transient disable windows, something real hardware's much tighter instruction-level timing
apparently never lands in practice. This is not a QEMU register-modeling bug (the disabled-region
trap behaved exactly as designed) and not a misclassification — it is a genuine race this fork's
timing model exposes that real hardware's timing does not.

**What this does NOT do**: it does not touch PRO CPU's own cache path (no equivalent DPORT-level
stall exists for PRO on real hardware either); it does not change what counts as an illegal access
(APP CPU disabling its own cache, or PRO CPU reading its own disabled cache, still traps exactly as
before — the fix explicitly excludes writer-core==owner-core so a core can never be stalled against
itself); it does not serialize MTTCG globally — only the one core whose cache another core is
actively holding disabled is held, for exactly as long as that condition is true.

A future session touching `esp32_cache_state_update()`, `esp32_cpu_stall()`, or
`appcpu_stall_req`'s wiring should preserve this contract: any new stall reason added to one side
of the OR-expression (`esp32_dport_update_appcpu_stall()` in `esp32_dport.c`) must also be added to
`esp32_cpu_stall()`'s own independent recomputation in `esp32.c` — the two are not automatically
kept in sync (this was the exact mistake made and caught during E124's own implementation, before
the fix was found to have zero effect on first test).

## DECISION-016 — VnextBWaitDispatcher::unregister() is a blocking drain, not fire-and-forget;
QemuProcessManager child processes launch with an explicit inherited-handle list

**Status:** ACTIVE — `REVIEW_REQUIRED=YES` per DECISION-004 (this touches "the dispatcher... polling
architecture", named in DECISION-004's frozen area). Authorized directly and in detail by the E123
task brief itself (Fase 2/3's explicit spec for a wait-set-drain + callback-in-flight-drain
contract on `VnextBWaitDispatcher::unregister()`), not a unilateral architecture change — recorded
here per DECISION-004's own requirement, not as a request for further approval.
**Date:** 2026-09-05
**Evidence:** E123

Two related but separately-justified lifecycle contract changes, both in
`core/src/mcu/qemu/`:

1. **`VnextBWaitDispatcher::unregister(token)` now blocks until drained.** Previously it cleared
   the entry and returned immediately, with no guarantee that (a) the dispatcher worker's
   already-in-flight `WaitForMultipleObjects()` snapshot (built before the call) had stopped
   referencing the handle, or (b) an in-flight callback capturing state the caller is about to free
   (e.g. `VnextBAttachment::stop()`'s subsequent `CloseHandle`/`this`-invalidation) had finished.
   Both are now guaranteed on return: the worker publishes a wait-set generation each time it
   rebuilds its snapshot and tracks whether a callback is currently executing, both under the same
   `mutex`; `unregister()` waits (via `condition_variable`, notified from both publish points) until
   the observed generation is at or past its own and no callback is in flight, bounded by a 5s
   timeout that is traced unconditionally (never silently swallowed) if ever hit. Self-unregister
   (called from the dispatcher's own worker thread) skips the in-flight-callback wait, since the
   dispatcher's callback execution is strictly sequential by construction — waiting for "no other
   in-flight callback" from inside the one currently running would deadlock against itself.
2. **`QemuProcessManager::start()` launches each QEMU child with `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`**
   (`STARTUPINFOEXW`) instead of a plain `bInheritHandles=TRUE` `CreateProcessW` call — only the
   handles named in the list (the log pipe's write end, stdin) are inherited by the new child,
   regardless of what else happens to be open and inheritable in the parent process at that exact
   moment.

Neither change alters the VNEXT ABI, wire protocol, backpressure semantics, or reset semantics —
both are process-/thread-lifecycle hardening. (1) makes a previously-unsafe API safe under
concurrent use; (2) eliminates a Windows handle-inheritance race between concurrently-launched
sibling QEMU processes. Both were proven necessary by direct, reproduced evidence (see EVIDENCE.md
E123) — (2) was the actual, confirmed root cause of the long-standing `TEARDOWN_HANG`/E104 defect;
(1) was a real, independently-provable gap that did not turn out to be E104's cause but is closed
regardless per the task's own instruction.

A future session touching either `VnextBWaitDispatcher` or `QemuProcessManager`'s process-launch
path should preserve both contracts: do not revert `unregister()` to fire-and-forget, and do not
revert `start()` to plain `bInheritHandles=TRUE` without re-deriving why (see E123's Phase 1b for
the exact reproduction).

## DECISION-015 — DPORT reads flash cache pages from m25p80's own coherent RAM state, never from BlockBackend inside MMIO dispatch

**Status:** ACTIVE
**Date:** 2026-09-05
**Evidence:** E120

`esp32_dport.c`'s `esp32_cache_data_sync()` (the DROM0/IRAM0 cache-fill path, run whenever the
guest enables or reconfigures the instruction/data cache) now fills each 64 KB cache page via a new
public API, `m25p80_read_array(DeviceState *dev, uint64_t offset, uint64_t bytes, void
*destination, Error **errp)` (`hw/block/m25p80.c`, declared in `include/hw/block/flash.h`), instead
of calling `blk_pread()` against the flash chip's `BlockBackend` directly.

The underlying fact this decision rests on, established by reading `hw/block/m25p80.c` in full: the
m25p80 device model already maintains its *own* coherent, RAM-backed copy of the chip's contents
(`Flash::storage`, loaded once at realize from the backing image) — every guest-visible SPI
program/erase command (`flash_write8()`, `flash_erase()`) mutates this array directly and
synchronously, and every guest-visible SPI *read* command already reads back from this same array.
`BlockBackend`/`Flash::blk` is, and always was, a one-way, asynchronous *persistence* path
(`flash_sync_page()`/`flash_sync_area()`, via `blk_aio_pwritev()`) — never read back after the
initial load, and never awaited by anything that needs the chip's current contents. DPORT's cache
model calling `blk_pread()` was therefore always redundant with a state the chip already held
coherently in memory, not a necessary second source of truth.

That redundant `blk_pread()` call, issued from inside `esp32_dport_write()`'s own active MMIO
dispatch (once per changed 64 KB MMU page, up to ~256 times per cache-enable event), is what
E119 root-caused as the actual mechanism behind the `Blocked re-entrant IO` watchdog-adjacent
storm found auditing B11: `blk_pread()`, called outside a coroutine, waits via QEMU's own
`AIO_WAIT_WHILE`, which releases the BQL for as long as host disk I/O under contention takes,
while `esp32.dport`'s reentrancy guard is still engaged — a second, genuinely concurrent access
into the same still-"active" region during that window is rejected. Reading `Flash::storage`
directly is plain, synchronous memory access with no I/O and no BQL interaction at all, so this
hazard cannot occur through it.

This is **not** the same situation DECISION-014 addressed. DECISION-014 disabled the reentrancy
guard on seven devices specifically because their own retry path (VNEXT_B's `cpu_stop_current()` +
`cpu_loop_exit_restore()`) never releases the BQL — the guard was firing on a false positive with
no real hazard behind it. Here, the guard was firing on a **real** hazard (a genuine BQL release
from inside active MMIO dispatch); `esp32_dport`'s reentrancy guard is therefore explicitly **left
enabled** — the fix removes the BQL release itself rather than suppressing the guard that correctly
caught it. Do not disable `esp32_dport`'s `disable_reentrancy_guard` as a shortcut for this or any
future finding without first proving, the same way DECISION-014 did for its own seven devices, that
every reachable code path genuinely never releases the BQL.

Wiring: `hw/xtensa/esp32.c`'s `esp32_machine_init_spi_flash()` now returns the realized flash
`DeviceState*` (previously discarded once its chip-select GPIO was connected); `esp32_machine_init()`
stores it in the already-declared-but-previously-unused `Esp32MachineState::flash_dev` field and
calls the new `esp32_dport_set_flash_device()` to hand it to DPORT, completing before any vCPU
executes a single instruction (this link is necessarily a post-realize setter call, not a
construction-time property, because DPORT is realized as part of the whole SoC before the flash
chip exists). Any future device that needs a coherent snapshot of the flash chip's current
contents should use this same API rather than reaching for `BlockBackend`/`blk_pread()` directly.

## DECISION-014 — VNEXT_B's synchronous retry path is exempt from the per-device MMIO reentrancy guard

**Status:** ACTIVE
**Date:** 2026-09-05
**Evidence:** E118-AUDIT-2

Every device `MemoryRegion` reachable through `writeReg()`'s VNEXT_B `cpu_stop_current()` +
`cpu_loop_exit_restore()` retry path (`hw/i2c/esp32_i2c.c`, `hw/char/esp32_uart.c`,
`hw/gpio/esp32_gpio.c`, `hw/ssi/esp32_spi.c`, `hw/misc/esp32_ledc.c`, `hw/misc/esp32_sens.c`,
`hw/misc/esp32_iomux.c`) now sets `disable_reentrancy_guard = true` on its `iomem`, immediately
after `memory_region_init_io()`. This is the same idiom already used upstream by
`hw/intc/apic.c`, `hw/scsi/lsi53c895a.c`, `hw/misc/bcm2835_property.c`, `hw/ppc/pnv_lpc.c`, and
`hw/intc/loongarch_ipi.c` — not a new mechanism, an extension of an existing one to a new class of
caller.

`softmmu/memory.c`'s generic per-device reentrancy guard
(`mr->dev->mem_reentrancy_guard.engaged_in_io`) exists to reject a second vCPU dispatching into
the same device while the BQL is released mid-callback (LEGACY's `arenaTransactionBegin()` is the
motivating case elsewhere in this codebase). It is set `true` on entry and cleared `false` only by
a plain post-call C statement after the device's own `.write` callback returns normally.
`cpu_loop_exit_restore()`'s `siglongjmp` — the mechanism E118 introduced for a vCPU to block and
replay a whole MMIO instruction on `VNEXT_WOULD_BLOCK` — unconditionally skips that cleanup when
triggered from inside a guarded device's own dispatch, permanently wedging the guard `true` for
the rest of the process (root cause of the E118-AUDIT watchdog-storm gate failures; see EVIDENCE.md
E118-AUDIT-2 for the full mechanism and the 2-for-2 log correlation that proved it).

Disabling the guard on these seven devices is judged safe, not a blanket suppression, because
VNEXT_B's retry path never releases the BQL between the stop and the replay — the specific hazard
the guard defends against (a second vCPU entering the same device during a BQL-released window)
cannot occur through this call chain. Any future device wired into the VNEXT_B `writeReg()` retry
path must receive the same `disable_reentrancy_guard = true` treatment, and any future addition of
a BQL-releasing callback to one of these seven devices' own `.write` handlers would invalidate this
reasoning and must be reviewed against it before merging.

## DECISION-013 — Prior-investigation diagnostic instrumentation gated, not deleted

**Status:** ACTIVE
**Date:** 2026-09-04
**Evidence:** E111

`hw/misc/esp32_dport.c`'s `[CACHE-TRACE]` block and `target/xtensa/exc_helper.c`'s
`[XTENSA-EXC-TRACE]`/`[XTENSA-PC-WATCH]` blocks (temporary instrumentation from the
`.spec/archive/legacy-v2/lasecsimul.spec` section-32.5.x investigation, 2026-07-26/28) were found
unconditionally active in the canonical `dev_qemu_runtime` binary, writing 1.5-2MB+ per QEMU
process to `C:/tmp` on every launch regardless of need. Rather than deleting this instrumentation
(it remains genuinely useful for any future round of this same class of investigation, and its own
code comments document real, hard-won lessons about throttling/ring-buffer sizing that would be
lost), it is gated behind `LASECSIMUL_CACHE_TRACE` (off by default, same
`g_once_init_enter`/`leave` pattern as every other diagnostic gate in this fork). Both directions
verified by PID, not by inference. `LASECSIMUL_XTENSA_PC_SAMPLER` (a separate, third mechanism)
was already correctly gated and is unaffected. No watchdog/reset/backpressure/queue-depth/
arbiter/heartbeat semantic changed; confirmed by a clean 13/13 regression (VNEXT_B+MTTCG twice,
LEGACY+MTTCG once) on the rebuilt binary.

## DECISION-001 — Canonical development QEMU runtime

**Status:** ACTIVE / FROZEN  
**Evidence:** SOURCE PROVEN + MEASURED RUNTIME

The canonical test executable is the staged runtime copy under
`C:\SourceCode\LasecSimul\vnext_prototype\dev_qemu_runtime`. It has the same
SHA-256 as the `build-ucrt64` executable and includes the adjacent MSYS2 UCRT64
DLL set required for standalone launch. The raw build executable is not a
standalone runtime and returned `0xC0000135` when launched without those DLLs.
The packaged historical rollback executable is not substituted.

## DECISION-002 — Historical rollback binary preservation

**Status:** ACTIVE / FROZEN  
**Evidence:** MEASURED HASH

`devices/qemu-esp32/bin/qemu-system-xtensa.exe` remains unchanged as the
rollback artifact with SHA-256
`471AE54193CC7A86F6A448D53BC1E810F5B50D6EBAD1FE48FC34AA04F56F74CE`.

## DECISION-003 — Diagnostic logging policy

**Status:** ACTIVE  
**Evidence:** SOURCE PROVEN

Per-operation I2C diagnostic output is gated by `LASECSIMUL_VNEXT_TRACE` and
is off by default. This is diagnostic-only; no transport, ABI, scheduler,
backpressure, or reset semantic change is inferred from it.

## DECISION-004 — Architecture remains frozen during localization

**Status:** ACTIVE / FROZEN  
**Evidence:** DERIVED FROM FROZEN CONTRACT

Do not change the VNEXT ABI, dispatcher, ProducerLane, ResponseSlot/C2A,
backpressure, reset semantics, or polling architecture while the remaining
survivor localization is being compared. Any semantic production change must
first set `REVIEW_REQUIRED=YES`.

## DECISION-005 — Handoff persistence

**Status:** ACTIVE  
**Evidence:** PROCESS DECISION

Every future session must update the handoff/state documents with exact
current paths, hashes, commands, results, blocker, and next action,
independent of the value of `REVIEW_REQUIRED`.

## DECISION-006 — Bare-metal fixtures are the oracle for device-level watchdog behaviour

**Status:** ACTIVE
**Date:** 2026-09-03
**Evidence:** E097, E098, E101

Watchdog *hardware model* behaviour is tested with
`vnext_prototype/guest_mwdt_baremetal`, a framework-free Xtensa image booted
through QEMU's `-kernel` ELF path. Arduino and ESP-IDF guests are rejected for
this purpose: their frameworks own and feed `TIMG_WDT`, so no unfed
precondition can be established (E060-E063).

The fixture builds with `xtensa-esp32-elf-gcc` + `objcopy` only, in about two
seconds, with no Python, ESP-IDF or PlatformIO runtime.

This decision is scoped to *device* behaviour. Official ESP-IDF IWDT *policy*
conformance, if it is ever required, is a separate subject and a separate
fixture.

## DECISION-007 — Diagnostic traces are not a timing instrument

**Status:** ACTIVE
**Date:** 2026-09-03
**Evidence:** E099

`LASECSIMUL_TG0_WDT_TRACE`, `LASECSIMUL_TG1_WDT_TRACE` and
`LASECSIMUL_VNEXT_TRACE` cost a median 2.2 s per emitted line on this host and
shift the MTTCG-realtime virtual clock by an order of magnitude. They may be
used to answer *what happened*; they may not be used to answer *when*.

Timing and reset classification use the unconditional
`[LasecSimul][ESP32 reset]` line and harness counters.

## DECISION-008 — Every scale result carries a validity arm

**Status:** ACTIVE
**Date:** 2026-09-03
**Evidence:** E101

A multi-session run may not be recorded as PASS on the absence of a symptom
alone. It must include an arm that shares the code path under test and is
expected to produce the symptom, demonstrating that each instance actually
reached the condition being measured.

Rationale: the first 16-session run in E101 showed zero MWDT resets for both
the fed and the unfed variant, because at a 60 s window no guest had finished
QEMU construction. Without the control that would have been recorded as a PASS.

## DECISION-009 — The CPython / ESP-IDF assembly route is closed

**Status:** CLOSED
**Date:** 2026-09-03
**Evidence:** `CLOSED_HYPOTHESES.md` postmortem

Iterations 61-90 are terminated with no result. Do not acquire, extract or
assemble CPython runtimes, and do not resume IDF wheelhouse work, in service of
the MWDT gates. The ~452 MB of artifacts in this folder and the ~16 MB of
wheelhouses under the repository-root `.ai/` were **deleted on 2026-09-03**
together with the acquisition scripts; the postmortem in
`CLOSED_HYPOTHESES.md` is the surviving record.

If an ESP-IDF build is ever genuinely required for a different reason, the
starting point is that `.piohome/python_env/idf4.4_py3.12_env` is broken only
because its base interpreter path (`C:\Program Files\Python312`) no longer
exists; a working CPython 3.12 is present at
`C:\Users\Administrator\AppData\Local\Programs\Python\Python312`, and
`.ai/wheelhouse_idf_requirements_66/` already holds a complete cp312 wheelhouse
that was proven to install (E066).

## DECISION-010 — Test runs must leave the host usable

**Status:** ACTIVE
**Date:** 2026-09-03
**Evidence:** incident below, plus E100/E101 run shapes

The bare-metal fixture guest is a tight infinite loop: every emulated vCPU
thread holds a core at 100% and never yields. Multi-session runs therefore
consume exactly as much CPU as they are allowed to, for the whole window.

**Incident.** A 32-instance run on this 32-core host, at normal priority with
no affinity restriction, left nothing for the interactive session. Display and
input stopped responding and the machine had to be powered off at the wall.
The power-off truncated an in-flight QEMU build, leaving zero-byte object files
and NUL-filled generated headers (`qapi/qapi-introspect.h`,
`qapi/qapi-events-cryptodev.h`, `qapi/qapi-events-cxl.h`), which then failed to
link with thousands of `undefined reference to visit_type_*`. Recovery required
`ninja -t clean` and a full rebuild.

**Rules.**

1. Every QEMU process launched by a test runner is set to `Idle` priority.
2. Multi-session runners confine guests with a processor-affinity mask that
   leaves cores free for the OS. `run_scale.ps1` reserves 6 of 32 by default
   (`-ReserveCores`) and refuses a population larger than the usable cores
   unless `-Force` is passed.
3. Builds cap parallelism. Use `ninja -j 8` under `nice -n 19`, never bare
   `ninja` — its default of cores+2 saturates the machine just as badly as the
   test runs do.
4. These limits change scheduling, not semantics. A fed guest that survives on
   26 confined cores survives on 32 unconfined ones; the watchdog deadlines come
   from `QEMU_CLOCK_VIRTUAL`, not from host CPU share.

## DECISION-012 — VNEXT_B consumption is now a temporal-merge arbiter, plus a pacing-only heartbeat

**Status:** ACTIVE
**Date:** 2026-09-04
**Evidence:** E109

`McuComponent::pollAndDispatchPendingEvents()`'s VNEXT_B branch no longer walks lane 0 then lane 1
unconditionally. It peeks every lane's head, selects the next event globally by
`(timestampNs, laneIndex)` via the new pure `VnextBArbiter::selectNextLaneEvent()`, and defers
(schedules a callback for the exact boundary, does not busy-poll) when the earliest candidate is
still in the future relative to the Scheduler's clock. This replaces implicit lane-index bias with
explicit, unit-tested global ordering.

Separately, VNEXT_B gained a monotonic `QEMU_CLOCK_VIRTUAL` watermark
(`artifact_virtual_time_ns`, ABI v1.1, additive field), published once per second by a QEMUTimer
and consumed **only** by `McuComponent::pacingPositionNs()`. It has no electrical effect, does not
feed `latestVirtualTimeNs()`, does not advance the Scheduler directly, does not touch watchdog
semantics, and does not participate in the arbiter's ordering. It exists solely to prove virtual-
time advancement to pacing consumers when a guest is legitimately silent (WFI, no GPIO/I2C
activity) — the case a firmware-driven heartbeat can never accidentally paper over. `wdt_time_scale`,
programmed timeout, `stage_timer`, reset policy, queue depth, and the 3 s backstop are all
unchanged.

Both changes are scoped to VNEXT_B; LEGACY is untouched (confirmed by repeated 13/13 LEGACY+MTTCG
regressions with no change in behavior). This decision reopens `orchestrator/.ai/TEST_GATES.md`'s
B0.1 gate as CLOSED per E109; B10-R/B11/B12 (the original MWDT scale matrix) and the plan's own
2x3 causal matrix remain open.

## DECISION-011 — TG0 transport-pause compensation covers both CPU lanes

**Status:** ACTIVE; production gate remains OPEN
**Date:** 2026-09-03
**Evidence:** E107

`esp32_timg_transport_pause()` now accepts CPU0 and CPU1. A per-lane
participation bitmap plus an atomic active-lane count maintains one shared TG0
pause window: the 0-to-1 edge opens it and the 1-to-0 edge closes it. Therefore
overlapping pauses are compensated as the union of intervals, never their sum.

This is causally bounded to VNEXT_B credit exhaustion; ordinary guest hangs do
not enter the pause API and remain detectable. The change passed the 10-test
Core regression and the bare-metal fed/unfed validity arms. It did not close
the production gate: residual TG0 resets remain at 12 and 16 sessions, so no
claim is made that CPU1 compensation solves all host-load false positives.

**Correction (E114, 2026-09-04):** the union-window compensation formula this
decision introduced had a latent double-compensation bug, later identified as
the actual root cause of the residual `SW_CPU_RESET_REGISTER` storm this
decision's own last paragraph anticipated might remain. `esp32_timg_wdt_feed()`
resets `ws->ns_base` unconditionally, with no knowledge of an open pause; when
a feed landed between the pause opening and `esp32_timg_transport_pause_apply()`
running, the old formula (`ns_base += now - pause_start`) re-added the full
pause duration on top of an anchor the feed had already advanced, pushing
`ns_base` past the current virtual time and corrupting the watchdog's next
computed deadline to ~0ns. Fixed by compensating only the unaccounted portion
(`effective_start = max(pause_start, ns_base)`) -- this decision's intent (union
of overlapping pause intervals, never double-counted) is unchanged; only the
arithmetic implementing it was corrected. See EVIDENCE.md E114 for the full
causal trace and validation.

## DECISION-039 — VNEXT_B production launch path must fail closed on host MTTCG capacity

**Status:** ACTIVE
**Date:** 2026-09-09
**Evidence:** E133 (B11 N=16 already OPEN, scale-sensitive, before this episode),
E144 (a live host freeze from an oversubscribed, `-Force`d B11 N=16 burst),
E145.

DECISION-010 already established that an unconfined multi-session MTTCG run
can freeze the host, and gave `run_production_mwdt.ps1` an admission guard
for it (`-ReserveCores`/`-Sessions` vs. usable cores, refuses without
`-Force`). That guard lived only in the test runner. Nothing stopped the
*product's own* launch path (`McuController::start()`'s VNEXT_B branch) from
starting more concurrent MTTCG sessions than the same host could safely
carry -- a project with enough MCU components could reproduce the exact
freeze DECISION-010 documents, with no test harness involved at all.

E145 closes that gap: `McuController::start()` now computes
`safe_sessions = floor((logicalProcessors - reserveProcessors) / vcpusPerSession)`
from the **real, live host topology** (`std::thread::hardware_concurrency()`,
never a hardcoded constant -- `core/src/mcu/qemu/VnextBCapacityGuard.hpp`),
using the same 6-processor reserve and 2-vCPU-per-session accounting
`run_production_mwdt.ps1` already uses, and refuses (throws, before any
QEMU process is created) to start a session that would push the process-wide
active-session count past that ceiling. An escape hatch
(`LASECSIMUL_VNEXT_B_CAPACITY_OVERRIDE=1`) exists for a deliberate,
human-supervised experiment only -- it must never be set by any test runner,
gate, or production configuration. On the 32-logical-processor host this
episode measured, `safe_sessions=13`; B11 N=16 remains classified
`NOT_APPLICABLE_ON_THIS_HOST` (this host would need >=38 logical processors
to run N=16 safely), not forced, not retried after the freeze this episode's
predecessor caused.
