# NEXT ACTION

## E147-J follow-up (2026-09-10)

The second UART retry ordering window is now covered by
`vnext_b_note_nonvcpu_backlog()`: UART/I2C arm the token only after preserving
pending state, and UART uses an idle BH rearm when credit is already available.
The deterministic test is 2/2. The diagnostic real run still stops at the ROM
banner, so the candidate is not promotable. Next action is one bounded GREEN
run on EININDI01 and one on II1P04 with the diagnostic runtime, then the
VNEXT_B+MTTCG regression. Do not touch scheduler/settle/HART or promote until
both projects produce application UART/display progress.

## E147-J — RED reproduzido e correção mínima aplicada; validação real pendente (2026-09-10)

O RED determinístico da corrida de crédito/backlog UART está preservado em
`vnext_prototype/mttcg_causality/E147-J-uart-lost-wake/RED_output.txt` e no
teste `qemu_lasecSimul/tests/unit/test-vnext-b-uart-backlog.c`.

A correção mínima mantém o token de backlog de produtores não-vCPU armado até o
caller preservar o efeito pendente; somente o sweep `vnext_resume()` limpa o
token, libera a pausa e agenda o BH. O teste unitário passa 1/1 e o QEMU
recompila, mas ainda faltam: executar o projeto EININDI01, confirmar UART além
do banner, executar II1P04 e EININDI01, regressões VNEXT_B+MTTCG, e só então
considerar candidato. Não promover runtime nem iniciar B12 antes desses gates.

O primeiro run real após a correção ainda terminou com ROM-only:
`bytePublished=229`, `wouldBlockTotal=3`, `bhEntries=128` e
`tx_effect_count(final)=1`; `nonvcpuImmediateCreditRace=0`. Portanto o RED
isolado foi corrigido, mas existe uma segunda falha no ciclo BH/credit após
novos `WOULD_BLOCK`s. A próxima prova deve registrar a sequência por instância
(`BH enter -> publish -> WOULD_BLOCK -> backlog armed -> credit notify -> BH
enter`) e o estado do ring em cada transição. Não alterar HART, settle ou
scheduler para tentar contornar esse segundo problema.

## HART Device Engine — próximo track, bloqueado até fechar E147 (2026-09-10)

O material `C:\Users\Administrator\Desktop\hart-device-engine.md` foi
incorporado na especificação canônica [FEAT-013](../../.spec/features/hart-device-engine.md).
O documento original usava `FEAT-012`, mas esse ID já pertence à biblioteca
TDPS; não alterar IDs existentes.

Ordem obrigatória:

1. fechar o defeito atual de VNEXT_B/MTTCG observado em E147 (UART/backpressure
   e o byte final não entregue), com RED isolado, correção mínima, GREEN e
   regressão; não iniciar HART durante essa investigação;
2. somente após o release VNEXT_B estabilizado, executar FEAT-013 Fase 0:
   caracterizar `core/src/protocols/IndustrialProtocols.*`, FEAT-009, testes
   HART e golden vectors sem alterar comportamento;
3. então implementar os contratos HART em fases (profile/plan/runtime,
   compiler, engine virtual, perfis, autoria e somente depois adaptadores reais)
   conforme `.spec/features/hart-device-engine.md`.

O HART deve permanecer planejado e inerte agora: não criar threads, sockets,
timers ou transporte físico e não misturar sua implementação com QEMU, UART,
VNEXT_B, scheduler ou o runtime canônico. O gate arquitetural será a execução
de múltiplos perfis/instâncias em uma sessão e em SharedHost sem recursos por
dispositivo, com FEAT-009 preservada.

## E145 — H143 closed and capacity-guarded in production; two new narrow findings need a decision; B12 not attempted (2026-09-09, ~06:32-07:20)

Result: **REVIEW_REQUIRED — decision needed, not a fix to make unilaterally.**

H143 is closed for the formal (Release) gate, confirmed wired to
production. This host's safe MTTCG capacity (13 sessions) is now computed
from real topology and enforced fail-closed in `McuController::start()`
itself, not just in test runners -- closing the gap that let E144's B11
N=16 (`-Force`, oversubscribed) freeze the host. Full account in
`EVIDENCE.md`'s new E145 entry and `TEST_GATES.md`.

Two things are NOT closed:

1. **RESET_WAIT/E131 cannot currently be validated against the E141
   production-clean candidate.** `cache_wait_e2e_real_qemu_test.exe`'s own
   oracle depends on 4 QEMU-side diagnostic env vars/log markers that E141
   correctly removed; E132-E's historical PASS used a different, pre-E141
   QEMU build. This is a harness/oracle problem, not a functional
   regression, not caused by H143 -- but it means E131/RESET_WAIT is an
   **open gap** in this production-clean candidate's validation, not
   silently assumed fine.
2. **A narrow, real, intermittent timing sensitivity** was found in both
   `session_restart_stress_test` (2/4 fifteen-cycle runs had 1-2 misses,
   always cycle 0/1 only) and B11 N=1 (1 of 2 attempts). Every instance
   showed a completely healthy QEMU boot, zero H143 storm signature, and
   (where measurable) 90-100% real dispatch -- i.e. NOT H143, NOT a
   capacity/scale issue (didn't recur at N=8/N=12), NOT a build-config
   issue. Not investigated further in this episode (out of scope for a
   H143/capacity-focused closure).

**B11 N=13** (this host's calculated safe ceiling, would need no `-Force`)
was not executed: a second host freeze occurred during this episode's own
planning for that step (before any N=13 command was issued -- `-Force` was
never used in this episode), and when asked explicitly how to proceed the
user chose to skip N=13 for this episode.

Per the task's own gating, B12 was correspondingly not attempted. No
`QEMU_RUNTIME.json` edit, promotion, cleanup, commit, push, tag, release,
or package.

Next exact action -- a decision:

1. authorize a narrowly-scoped follow-up to re-oracle `CacheWaitE2ERealQemuTest.
   cpp` (replace log-grepped diagnostic markers with real ABI/functional
   state, the same pattern already used successfully for
   `VnextBAttachmentTest.cpp` in E141) so RESET_WAIT/E131 can be validated
   against the production-clean candidate; or accept it as a known,
   documented gap for now; or
2. authorize investigating the early-cycle/N=1 timing intermittency
   specifically (its own small, bounded episode -- not reopening E131/
   E134/etc.), or accept it as a known, bounded, non-blocking finding; or
3. decide when/how to attempt B11 N=13 -- same session (with explicit
   go-ahead), a fresh session after confirming host stability, or skip it
   entirely and accept N=1/8/12 as sufficient capacity evidence; or
4. some other explicitly-approved path.

Do not run B12 or promote the runtime until these are resolved or
explicitly accepted. Do not attempt B11 N=16 on this host (calculated
`NOT_APPLICABLE_ON_THIS_HOST` -- would need >=38 logical processors). Do
not use `-Force` or bypass the new capacity guard outside a deliberate,
human-supervised, explicitly-approved experiment.

## E144 — H143 fixed and validated for Release; B11 N=16 incomplete after a host freeze; decision needed on how to close (2026-09-08/09, ~18:48-19:25)

Result: **REVIEW_REQUIRED — decision needed, not a fix to make
unilaterally.**

E142/E143's classification is corrected: E132-E's historical
`session_restart_stress_test 15/15` was a **Release** build; E142/E143 had
been rebuilding and running **Debug**. H143 (the post-ack `now+1ns`
starvation of a correctly-scheduled future callback, violating
`PLAN_MTTCG_VNEXT_B_CAUSALITY.md` sections 10.2/10.4 step 5) is real and
was re-fixed using the already-tested `decidePostAckRearm()` from E143 (no
design change needed). Full validation:

- `vnext_b_arbiter_test` 12/12 pure H143 tests (Release).
- `session_restart_stress_test` (Release, default 15-cycle): **15/15**,
  matching E132-E exactly.
- `vnext_b_attachment_test` (Release): 3/3 runs, 33/33 subtests each.
- Two full `VNEXT_B+MTTCG` regressions: 14/14 each.
- B11 N=1, N=8, N=12: all clean (`workloadPass=true` every session,
  `submissions==completions` every session, `MWDT_ATTRIB_RESETS=0`).
- A Debug 30s time series (250ms cadence) proved Debug is slow (~60x under
  real time at this workload), never frozen (`Scheduler::nowNs` advances on
  every sample).
- Added `HARNESS_BUILD_CONFIG=Debug/Release` self-report and a
  `LASECSIMUL_REQUIRE_RELEASE=1` fail-closed gate to
  `SessionRestartStressTest.cpp`, verified working.

**B11 N=16 reached only 1 of the required 3 valid runs.** Run 1 passed
cleanly. Launching run 2 immediately afterward (same `-Force`-oversubscribed
pattern, no cooldown) **froze the host** -- the user had to hard-reset the
machine. This reproduced a failure mode `run_production_mwdt.ps1`'s own
header comment already documents from 2026-09-03. Not retried this
episode. Post-recovery: zero orphans, idle CPU, all E144-edited files
verified intact (no corruption from the freeze).

`RESET_WAIT` (3/3) and the full `E131` battery (6/6) were not re-executed:
QEMU-side, already closed at E132-B, unchanged QEMU binary, out of this
Core-only fix's blast radius -- flagged explicitly, not silently assumed
clean.

Full account in `EVIDENCE.md`'s new E144 entry and `TEST_GATES.md`.

Next exact action — a decision:

1. accept the current evidence (N=1/8/12 B11 clean, N=16 1/3 clean with a
   host-safety stop unrelated to any test failure, Release formal gate
   15/15, everything else green) as sufficient to close E141-E144's
   `submissions=0/completions=0` investigation and move to a separate
   production-readiness review (still not B12/promotion -- a review step,
   per this episode's own instruction to stop there); or
2. authorize a specifically safer B11 N=16 retry protocol before accepting
   closure -- e.g. real cooldown between bursts, a genuine `ReserveCores`
   margin instead of `-Force`, or running N=16 in isolation with nothing
   else active and active monitoring -- understanding the real risk just
   demonstrated on this host; or
3. authorize re-executing `RESET_WAIT`/`E131` explicitly, if their QEMU-side
   scope is judged still relevant to this closure; or
4. some other explicitly-approved path.

Do not run B12 or promote the runtime. Do not attempt B11 N=16 again
without explicit authorization given the just-demonstrated host risk.

## E143 — H143's mechanism confirmed but insufficient; fix reverted per explicit rule; deeper cause still open (2026-09-08, ~18:40)

Result: **STOP — decision needed on how to investigate further, not a fix to
make unilaterally.**

H143 (a specific, precisely-located bug in
`McuComponent::pollAndDispatchPendingEvents()`'s post-ack rearm: an
unconditional `now+1ns` reschedule that always preempts a correctly-installed
future-deadline callback) was audited, reproduced in an isolated pure
RED/GREEN test suite (`VnextBArbiterTest.cpp`, 12/12 pass, matching E142's
exact measured nanosecond scale), fixed with a pure policy function
(`VnextBArbiter::decidePostAckRearm()`), and applied to production. Against
the real E141 candidate, 3 runs confirmed the callback storm this mechanism
predicted is completely eliminated (`m_pollGeneration=0`, down from
~1000-1200) — but `Scheduler::nowNs` still never reached the real ~305ms
deadline in any of the 3 runs, and I2C submissions/completions stayed at
zero in all 3. Per this episode's own explicit Phase-2 gate and stop
condition, **H143 is refuted as the sole, complete explanation**, and the
production fix was reverted (confirmed exact: re-running afterward
reproduced the original storm, `m_pollGeneration=956`).

Full account in `EVIDENCE.md`'s new E143 entry and `TEST_GATES.md`. Kept in
the tree: `VnextBArbiter::decidePostAckRearm()` (pure, correct, unused by
production after the revert) and its full test suite in
`VnextBArbiterTest.cpp` — ready to be wired back in once the deeper cause
is found, since eliminating the storm is very likely still a necessary (if
not sufficient) part of any real fix.

**What this rules in/out for the next investigation**: `pacingPositionNs()`
is confirmed (again, independently of E142) not the limiting factor. The
storm's removal, paradoxically, makes the remaining problem *cleaner* to
study: with `m_pollGeneration=0`, there is now exactly ONE scheduled
callback (at the real ~305ms deadline) and nothing else churning — so
whatever is preventing `Scheduler::nowNs` from reaching it is now isolated
from H143's noise. The two candidate mechanisms E142 already flagged
(`Scheduler::scheduleEventUnlocked()` never calling `signalWorkAvailable()`;
the real-time pacing throttle's interaction with the outer worker loop)
remain the most likely next leads, but neither has an isolated RED yet —
this episode's own rules require one before touching `Scheduler.cpp`.

Next exact action — a decision:

1. authorize a NEW, narrowly-scoped episode to build an isolated RED
   specifically for `Scheduler::scheduleEventUnlocked()`'s missing
   `signalWorkAvailable()` call (a pure or lightly-mocked Scheduler-level
   test, not touching VNEXT_B code at all) before touching `Scheduler.cpp`
   itself, exactly as this episode's constraints anticipated; or
2. authorize re-applying the H143 fix (`decidePostAckRearm()`, already
   written and tested) together with whatever the Scheduler-level
   investigation finds, as a combined fix, once both are proven; or
3. some other explicitly-approved path (e.g. deprioritizing
   `session_restart_stress_test` entirely, on the understanding that this
   is a deeper, cross-cutting Scheduler concern, not a VNEXT_B-specific
   one).

Do not touch `Scheduler.cpp`, do not add sleeps/polling, and do not run
B11/B12/promotion until this decision is made.

## E142 — E141-cleanup hypothesis disproven; a real, pre-existing Scheduler/VNEXT_B defect needs a scope decision (2026-09-08, ~18:10)

Result: **STOP — decision needed, not a fix to make unilaterally.**

`session_restart_stress_test`'s red (see this file's ~17:15 entry below) was
bisected exactly per the requested methodology: pre-E141-cleanup Core code
was reconstructed in a throwaway `git worktree` and A/B-tested against the
current post-cleanup code, in the same environment (same QEMU candidate,
firmware, and DECISION-010 priority/affinity). **Both failed identically.**
This disproves the working hypothesis that E141's diagnostic-instrumentation
removal caused this regression — full account in `EVIDENCE.md`'s new E142
entry and `TEST_GATES.md`.

The real boundary is precisely located: `VnextBArbiter` correctly refuses to
dispatch the guest's first lane-0 event (`timestamp_ns≈305ms`) because
`Scheduler::nowNs()` never reaches that point, staying stuck at
~234-251ms for the entire 5s test window — even though
`McuComponent::pacingPositionNs()` (the advance-limit floor) reports ~4.03s,
proving the pacing/advance-limit cap is not what's blocking progress. Two
candidate mechanisms were identified by reading `Scheduler.cpp`/`.hpp` but
NOT instrumented or confirmed:

1. `Scheduler::scheduleEventUnlocked()` (used by
   `McuComponent::schedulePollAt()`'s `schedulerLockHeld=true` path, i.e.
   from inside `stamp()`) never calls `signalWorkAvailable()` after pushing
   an event, unlike `scheduleAt`/`scheduleEvent`/`markDirty`/`pause`/
   `resume`/`notifyCommandPending` — all of which do. A hand-traced code
   path suggested this specific omission is currently harmless (the
   background worker's `while(m_running)` loop re-checks `m_events` directly
   on its next pass without needing a wake), but a lost-wake window
   elsewhere was not ruled out.
2. The worker loop's real-time pacing throttle (`Scheduler.cpp`, gated on
   `realTimeRate>0`) and its interaction with a session that repeatedly
   discovers a "future" VNEXT_B event, defers via `schedulePollAt`, and
   re-enters the outer loop.

Neither was changed. This is a genuinely different, pre-existing defect —
not something today's `APPROVE_TEST_ORACLE_REPLACEMENT_ONLY`-style
QEMU-diagnostic-cleanup authorization covers, and not something to fix
unilaterally given it touches `Scheduler.cpp` (shared, load-bearing
scheduling code well beyond VNEXT_B).

Housekeeping already done: the `git worktree` was removed; all 9
temporarily-swapped files plus `McuComponent.hpp`/`VnextBAttachment.hpp`
were restored and SHA-256-verified against a pre-swap backup;
`session_restart_stress_test` and `vnext_b_attachment_test` rebuilt clean
and `vnext_b_attachment_test` re-confirmed 33/33 PASS; zero QEMU orphans
throughout. The E142 test-only accessors and boundary-snapshot diagnostic
block were left in `McuComponent.hpp`/`VnextBAttachment.hpp`/
`SessionRestartStressTest.cpp` (harmless, read-only, dated/labeled) to
support whichever investigation comes next.

Next exact action — a decision:

1. authorize instrumenting/confirming one of the two candidate mechanisms
   above in `Scheduler.cpp` directly (not VNEXT_B-specific code), given its
   blast radius extends to every Scheduler consumer, not just VNEXT_B; or
2. deprioritize `session_restart_stress_test` specifically and continue the
   rest of the E141 production-clean validation sequence (B11 N=1/8/12/16,
   the two 14/14 regressions already passed, etc.) on the understanding that
   this defect is pre-existing and not part of what E141 needs to prove
   clean — but note `session_restart_stress_test` was an explicit step in
   the user's own validation sequence, so skipping it needs explicit
   sign-off, not an assumption; or
3. some other explicitly-approved path.

Do not touch `Scheduler.cpp`'s scheduling logic, do not add sleeps/polling,
and do not run B11/B12/promotion until this decision is made.

## E141 production-clean — attachment-test re-oracle done; blocked on a NEW real regression, out of scope (2026-09-08, ~17:15)

Result: **STOP — new functional red in `session_restart_stress_test`,
outside the `APPROVE_TEST_ORACLE_REPLACEMENT_ONLY` authorization.**

The prior blocker (this file's ~15:10 entry below) is resolved:
`VnextBAttachmentTest.cpp` was fully re-oracled per the user's explicit
authorization and now passes 3/3 clean runs (33/33 subtests each, zero QEMU
orphans) against the `475C0FC9...` candidate with zero new
logs/counters/ABI fields/hot-path hooks and zero reintroduction of the
removed tracer. The 5 deterministic QEMU unit tests and two full
`VNEXT_B+MTTCG` regressions (14/14 both times) also passed afterward. Full
account in `EVIDENCE.md`'s new E141 Part B entry.

Continuing the user's own validation sequence to the next step
(`session_restart_stress_test`) surfaced a new, real, functional red: 15/15
cycles fail with real firmware, zero I2C lane traffic
(`submissions=0/0 completions=0/0`) for the whole run, even though QEMU's own
boot looks normal. This was isolated (read-only) to very likely be a
regression in Core's production VNEXT_B dispatch pipeline
(`McuComponent.cpp`/`McuController.cpp`/`VnextBWaitDispatcher.cpp`) —
introduced during this same episode's earlier diagnostic-removal pass
(Part A, ~14:05), not by the QEMU binary, not by the firmware, and not by
the test oracle. Full evidence chain (four independent, read-only
eliminations) in `EVIDENCE.md`'s new E141 Part C entry and in
`TEST_GATES.md`.

**This is out of today's authorized scope.** `APPROVE_TEST_ORACLE_REPLACEMENT_ONLY`
authorized editing `VnextBAttachmentTest.cpp` only (and, if strictly
necessary, test-only Core helpers) — not the production dispatch files that
are the prime suspects, and not `SessionRestartStressTest.cpp`. No fix was
attempted. No B11, B12, promotion, `QEMU_RUNTIME.json` edit, cleanup,
commit, push, tag, or release was performed; the candidate SHA
(`475C0FC9...`) was re-verified unchanged and zero QEMU orphans remain.

Next exact action — a decision, not a fix to make unilaterally:

1. authorize root-causing and fixing the suspected regression in
   `McuComponent.cpp`/`McuController.cpp`/`VnextBWaitDispatcher.cpp` (not yet
   bisected to a single line — the wait-dispatcher generation refactor and
   the TeardownTrace-call removals in the VNEXT_B poll/dispatch loop are the
   most likely sites, since both received structural edits today, not just
   deletions); or
2. request a narrower, isolated bisection first (e.g. temporarily reverting
   only today's `McuComponent.cpp`/`McuController.cpp`/
   `VnextBWaitDispatcher.cpp` edits via `git stash` on just those paths,
   rebuilding, and re-running `session_restart_stress_test` once to confirm
   the exact culprit file before touching anything) — not yet done because
   it exceeds today's scope without explicit sign-off; or
3. some other explicitly-approved path.

Do not run B11/B12/promotion until this is resolved. Do not touch
`SessionRestartStressTest.cpp`'s own oracle logic on the assumption it is a
harness bug — the evidence gathered points at production code, not the
harness (test source is byte-identical to a version already proven to pass
against this exact QEMU binary and firmware earlier today).

## E141 production-clean — blocked on a test-oracle decision, not a regression (2026-09-08, ~15:10)

Result: **REVIEW_REQUIRED — TEST_ORACLE_DEPENDS_ON_REMOVED_DIAGNOSTIC**.

See `STATUS.md`'s same-timestamp entry for the full account. Both QEMU-side
and Core-side production-clean work are now complete and verified (build +
unit tests + string-absence sweep on the QEMU side; build + the same unit
tests plus the reentrancy/dispatcher-generation refactor on the Core side).

The blocker: `core/test/core/mcu/VnextBAttachmentTest.cpp` — at minimum its
`P1` and `E117_PHASE3_LIFECYCLE_ORDERING` subtests, plus several data-path
subtests (P2/P6/P7/P8-family) that read per-session UART/lane counters —
determine pass/fail by string-matching `[VNEXT_B_STARTUP] transition=...`
lines in the QEMU child process's own stdout. That output comes from
`LASECSIMUL_VNEXT_STARTUP_TRACE`, a diagnostic already correctly removed (by
the interrupted E141 session, before this continuation started) as one of
the items the task explicitly names for removal. Proven not a regression via
controlled comparison against canonical and the E139 candidate (both still
carry the old tracer, both still pass) and via direct source search
confirming the tracer is genuinely gone from `qemu_lasecSimul` now.

Next exact action — a decision, not a fix I should make unilaterally, per the
task's own section-14 stop condition ("a test depends exclusively on
investigation-log output and no safe functional oracle exists"): choose one
of

1. design a non-diagnostic, production-observable replacement for the
   specific ordering invariant these subtests protect (READY published while
   QEMU is still PRELAUNCH-paused and the guest has not executed; activate()
   actually releases it) and for the periodic UART/lane counters, then
   rewrite the affected oracles to use that instead of log parsing; or
2. accept `vnext_b_attachment_test` as a diagnostic-build-only test (matching
   the task's own guidance for E131-style tests in section 8) and gate the
   affected subtests behind a non-default diagnostic configuration rather
   than requiring them to pass against the production-clean binary; or
3. some other explicitly-approved path.

Do not reintroduce `LASECSIMUL_VNEXT_STARTUP_TRACE`/`[VNEXT_B_STARTUP]`, and
do not hand-patch the test's oracles without that decision. Only after it is
made should the section-9 short validation battery, B11 N=1/8/12/16 x5, the
comparison campaign, B12, and promotion proceed.

Candidate binary: SHA256
`475C0FC956E43FFC0CB83CECE0DC384457A9E1F01D2C6A3F6C21C4665C7EB23D`, preserved
at
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E141-production-clean_20260908_083000\candidate_qemu\`.
Zero QEMU orphans. Canonical rollback
`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E` and
`QEMU_RUNTIME.json` untouched throughout. No cleanup, commit, push, tag, or
release performed.

## E141 production-clean — QEMU side done, continue with Core-side diagnostics (2026-09-08, ~14:05)

Result: **IN_PROGRESS — QEMU_SIDE_CLEAN_CORE_SIDE_PENDING**.

See `STATUS.md`'s E141 entry (same timestamp) for the full account of what was
found and fixed in this continuation, including 3 genuine functional
regressions caught and repaired (not diagnostics) and 2 real Windows build-
portability bugs fixed in the QEMU meson/tracetool system.

Candidate binary: `qemu-system-xtensa.exe`, SHA256
`475C0FC956E43FFC0CB83CECE0DC384457A9E1F01D2C6A3F6C21C4665C7EB23D`, preserved
at
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E141-production-clean_20260908_083000\candidate_qemu\`.
Builds clean, runs, passes all 5 deterministic QEMU unit tests, and passes a
string/symbol absence sweep for every diagnostic marker named in the task's
section-7 minimum list plus everything additional removed this session.

Next exact action: audit and remove the Core-side (C++) diagnostic
instrumentation identified but not yet touched —
`C:\SourceCode\LasecSimul\core\src\mcu\TeardownTrace.hpp` and its ~48 call
sites across `McuComponent.cpp`, `McuController.cpp`,
`qemu\QemuProcessManager.cpp`, `qemu\VnextBAttachment.cpp`,
`qemu\VnextBWaitDispatcher.cpp`; the `LASECSIMUL_VNEXT_CORE_STARTUP_TRACE`-
gated `[VNEXT_CORE_STARTUP]`/`[VNEXT_CORE]`/`[VNEXT_CORE_I2C]` traces in
`VnextBAttachment.cpp`/`McuController.cpp`; the `LASECSIMUL_MCU_TRANSPORT`
diagnostic read in `McuController.cpp`. Use the same method already applied to
QEMU: classify each item functional-vs-diagnostic with source citations before
removing, preserve any legitimate functional logic found entangled with a
diagnostic (do not assume — check for zero-caller dead code the way
`esp32_dport_appcpu_has_non_cache_stop()` and `esp32_cache_ill_write()` turned
out to be two different things this session). After Core-side removal,
rebuild Core (separate MSVC/CMake build, not the QEMU MinGW one), then run the
section-9 short validation battery, then B11 N=1/8/12/16 with five valid
consecutive N=16 runs, then the bounded instrumented-vs-clean comparison
(section 11, only after production-clean is green), then B12, then a separate
promotion review. Do not promote before all of that; do not touch
`QEMU_RUNTIME.json` or the canonical runtime until an explicit, separate
promotion step. Canonical rollback
`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E` remains
untouched throughout.

## E138 ROM/EFUSE root-cause classification — review required (2026-09-08)

Result: **REVIEW_REQUIRED — E138_ROM_EFUSE_ROOT_CAUSE**.

Report:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E138-rom-efuse-classification_20260908_055000\E138_rom_efuse_classification_report.md`.

Review packet:
`C:\SourceCode\LasecSimul\orchestrator\.ai\REVIEW_PACKET.md`.

Current classification:
`E137_CAPTURED_E121_ROM_EFUSE_BOOT_RESET — E135_POST_BOOT_PANIC_NOT_REPRODUCED`.
E137 sessions 6/PID 3120 and 14/PID 15540, plus E138 session 14/PID 6588,
match the E121 ROM/EFUSE boot-reset path: boot epoch 1, APP CPU startup not
observed, WDTs disabled, `pc0=0x4000fdd0`, `pc1=0x40000400`, and terminal
SW_SYS_RESET at ROM PC `0x4000fdcd`. This corrects the prior E137 classification
and does not reproduce the E135 post-boot panic.

Next exact action: review E138 and decide whether to authorize the single
bounded EFUSE memory ring needed to prove the exact `_reload_efuses_and_check`
sub-branch, per-call RDATA, and timer/CMD ordering. Do not implement semantic
EFUSE duration changes, do not run B12, do not promote, do not edit
`QEMU_RUNTIME.json`, and do not investigate cache/TG1/WDT/transport/scheduler
before review.

## E137 B11 N=16 panic/reset recurrence — review required after panic-only red (2026-09-08)

Result: **B11_N16_PANIC_RESET_RECURRENCE_REPRODUCED_FRAME_UNPROVEN_REVIEW_REQUIRED**.

Report:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E137-cacheerr-signature-recurrence_20260908_053314\E137_classification_report.md`.

Review packet:
`C:\SourceCode\LasecSimul\orchestrator\.ai\REVIEW_PACKET.md`.

Current classification: E137 reproduced a real `VNEXT_B+MTTCG` B11 N=16 red
with only `LASECSIMUL_PANIC_CAUSAL_TRACE`, proving the rare panic/reset cascade
can recur without `LASECSIMUL_WDT_CAUSAL_TRACE` perturbation. The initiating
terminal trigger captured in the reproduction is `SW_SYS_RESET`, followed by
unexpected `RTC_RESET` and then `SW_CPU_RESET_REGISTER`. The original exception
frame was not preserved (`g_exc_frames=NULL` on both cores), so CACHEERR,
TG0/TG1, host scheduling, exact CPU, exccause/pseudo-excause, vaddr and the
specific E129 predicate failure remain unproven.

Next exact action: review E137 and decide whether to authorize the minimal
bounded diagnostic ring proposed in the report. Do not run more B11 sampling
blindly, do not run B12, do not promote, do not edit `QEMU_RUNTIME.json`, and do
not change cache/watchdog/reset/transport/scheduler semantics before review.

## E136 rare B11 N=16 panic — review required after non-reproduction (2026-09-07)

Result: **LOW_RATE_ANOMALY_NOT_REPRODUCED_REVIEW_REQUIRED**.

Report:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E136-b11-n16-panic-classification_20260907_220542\E136_classification_report.md`.

Review packet:
`C:\SourceCode\LasecSimul\orchestrator\.ai\REVIEW_PACKET.md`.

Current classification: original E135 session 0 remains
`GUEST_PANIC_RESET_CASCADE_UNCLASSIFIED`. The formal failing run proved a real
panic/reset cascade but did not have causal trace enabled; E136 did not
reproduce the event in three valid trace-enabled N=16 attempts.

Next exact action: review must decide whether to accept this low-rate anomaly
classification, authorize one more bounded diagnostic campaign, or require a
minimal trace/startup-validity coverage improvement. Do not promote, do not run
B12, and do not alter QEMU/Core/firmware/transport/watchdog/cache/reset/
scheduler semantics before review.

## E135 NOT_APPLICABLE fix — promotion rolled back at real B11 N=16 red (2026-09-07)

Result: **PROMOTION_ROLLED_BACK — FIRST_REAL_POST_PROMOTION_RED_B11_N16**.

Report:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\E135-gate-executor_20260907_181428\E135_not_applicable_fix_and_promotion_attempt_report.md`.

What changed:

- only the VNEXT_B LEGACY-only gateway/TAP fallback message in
  `C:\SourceCode\LasecSimul\core\test\core\mcu\McuControllerRealQemuTest.cpp`
  was changed from `PULADO:` to
  `NOT_APPLICABLE: test=mcu_controller_real_qemu_test subcase=legacy_gateway_tap_fallback reason=transport_vnext_b`;
- E135 executor remains fail-closed for `SKIP:`, `SKIPPED:` and `PULADO:`;
- it accepts only the exact `NOT_APPLICABLE` marker above, exactly once, only
  for `mcu_controller_real_qemu_test` under `VNEXT_B`;
- no QEMU/Core/firmware/transport/ABI semantics were changed.

Validated before promotion:

- executor self-test passed 17 synthetic allowed/forbidden cases;
- rebuilt only `mcu_controller_real_qemu_test`;
- direct `mcu_controller_real_qemu_test` passed against candidate
  `3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`;
- official `VNEXT_B+MTTCG` regression passed 14/14 against that candidate;
- B11 N=1 oracle check passed against that candidate.

Promotion attempt:

- final promotion artifact:
  `C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\runtime-promotion_E135_final_20260907_192655`;
- canonical was temporarily promoted from `B375A9E8...` to `3D951D7C...`;
- post-promotion gates passed through canonical `3D951D7C...` until B11 N=16:
  three QEMU unit tests, `vnext_b_attachment_test`,
  `session_restart_stress_test`, official regression 14/14, and B11 N=1.

First real red:

- B11 N=16 failed in
  `C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\E135-gate-executor_20260907_181428\final_post_B11_N16`;
- QEMU SHA was the candidate `3D951D7C...`;
- 16/16 sessions were dumped and 16/16 JSONL sessions were present;
- `MWDT_ATTRIB_RESETS = 0`, but `B11_CELL_PASS = False` and
  `RUNNER_PASS = False` due to `classifier_cellPass_false`;
- session 0 reported two unexpected resets after otherwise valid workload
  counters.

Current safe state:

- canonical runtime restored to SHA256
  `B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`;
- `QEMU_RUNTIME.json` restored to SHA256
  `ADF0D79B9E533E17A3F8CA62FD890B1867973FBB1AFF1C95239142D03644B369`;
- `QEMU_RUNTIME.json` read-only attribute is restored;
- zero QEMU processes remain.

Next exact action: diagnose only the B11 N=16 real red from
`final_post_B11_N16` and decide whether it is an E134 candidate issue, B11
classifier/oracle issue, or pre-existing stress instability. Do not retry
promotion blindly and do not run B12/promotion while the canonical remains
rolled back.

Do not cleanup, commit, push, tag, package or release. The vendored runtime at
`C:\SourceCode\LasecSimul\devices\qemu-esp32\bin\qemu-system-xtensa.exe`
remains old and continues blocking packaged release.

## E135 fail-closed promotion retry — BLOCKED before final promotion (2026-09-07)

Result: **BLOCKED_BEFORE_FINAL_PROMOTION — FAIL_CLOSED_GATE_CONFLICT**.

Report:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\E135-gate-executor_20260907_181428\E135_fail_closed_gate_executor_report.md`.

Executor:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\E135-gate-executor_20260907_181428\Invoke-E135PromotionGate.ps1`.

Executor SHA256:
`25A367AB2196EB21C090F9E41D013E1B06B3588FF950A5CA9F66749E3E6974A1`.

What succeeded:

- fail-closed executor self-test passed in `selftest13`;
- candidate direct preflight passed in `preflight6`:
  `vnext_b_attachment_test` PASS and `session_restart_stress_test` PASS 3/3;
- candidate/canonical SHA used in successful preflight and attempted promotion:
  `3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`;
- post-promotion Core gates passed during
  `runtime-promotion_E135_20260907_184029`: QEMU unit gates, attachment, and
  session restart 15 cycles.

Why promotion is not active:

- the E135 executor correctly rejects `PULADO:` by explicit request;
- the current historical `VNEXT_B+MTTCG` 14-test regression includes
  `mcu_controller_real_qemu_test`;
- that test exits 0 and prints `Todos os testes passaram`, but also emits a
  known VNEXT_B line beginning with `PULADO:` for a LEGACY-only gateway/TAP
  fallback subcase;
- therefore the corrected fail-closed gate cannot both reject `PULADO:` and
  pass the current 14/14 regression list without a protocol/gate-content
  decision.

Current safe state:

- canonical runtime restored to SHA256
  `B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`;
- `QEMU_RUNTIME.json` restored to SHA256
  `ADF0D79B9E533E17A3F8CA62FD890B1867973FBB1AFF1C95239142D03644B369`;
- `QEMU_RUNTIME.json` read-only attribute restored;
- zero QEMU processes remain.

Next exact action: choose one bounded path before attempting another promotion:

1. update/replace the VNEXT_B regression gate so the 14/14 promotion suite has
   no `PULADO:` output; or
2. explicitly authorize a narrow exception for the known LEGACY-only `PULADO:`
   line in `mcu_controller_real_qemu_test`; or
3. redefine the E135 14/14 promotion list to exclude that LEGACY-only
   not-applicable subcase.

Do not promote again until that decision is made. Do not change QEMU/Core
semantics, firmware, ABI, backpressure, cache-wait, watchdog, transport, CMake
compiled fallback paths, vendored runtime, cleanup, commit, push, tag, package
or release.

The vendored runtime at
`C:\SourceCode\LasecSimul\devices\qemu-esp32\bin\qemu-system-xtensa.exe`
remains old and remains a separate release blocker.

## Runtime promotion execution — ROLLED BACK at first post-promotion red (2026-09-07)

Result: **PROMOTION_ROLLED_BACK — FIRST_POST_PROMOTION_RED**.

Execution artifact:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\runtime-promotion_20260907_175847`.

Report:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\runtime-promotion_20260907_175847\runtime_promotion_execution_report.md`.

What succeeded:

- preconditions passed: candidate/build SHA
  `3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`,
  canonical SHA
  `B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`,
  `QEMU_RUNTIME.json` on rollback and zero QEMU running;
- rollback snapshot created in `rollback_B375A9E8`, 60 files, executable hash
  verified;
- candidate was staged via temp file and canonical executable temporarily
  reached SHA `3D951D7C...`;
- adjacent DLLs were unchanged and `qemu --version` through canonical exited 0;
- `QEMU_RUNTIME.json` was temporarily updated, hash
  `EA2E088DAEF31B1F5CAB49A7B1BE633C46601EFF4AC5B191D81B6A2F0B15D978`;
- QEMU deterministic gates passed:
  `test-esp32-timg-wdt-scale` 13/13,
  `test-esp32-timg-pause` 7/7,
  `test-vnext-b-classify` 9/9.

First red:

- `vnext_b_attachment_test` did not exercise and emitted
  `SKIP: LASECSIMUL_TEST_QEMU_BINARY is not available`;
- `session_restart_stress_test` exited 1;
- the failure log shows QEMU launched from
  `C:/SourceCode/LasecSimul/core/../devices/qemu-esp32/bin/qemu-system-xtensa.exe`,
  not from the promoted canonical runtime;
- QEMU reported incompatible arena ABI v5 descriptor and 15/15 cycles failed to
  start.

Rollback completed:

- canonical executable restored to SHA
  `B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`;
- `QEMU_RUNTIME.json` restored to hash
  `ADF0D79B9E533E17A3F8CA62FD890B1867973FBB1AFF1C95239142D03644B369` and
  canonical SHA `B375A9E8...`;
- zero QEMU processes remain.

Later gates were not run: no `VNEXT_B+MTTCG` regression, no B11 N=1, no B11
N=16. No code was changed to respond to the red.

Next exact action: review/correct the promotion gate invocation so the Core
tests use the promoted canonical runtime path, especially
`LASECSIMUL_TEST_QEMU_BINARY` and the session restart QEMU path resolution, then
restart the same controlled promotion from the restored rollback state. Do not
change production semantics, cleanup, commit, push, tag, package or release.

## Runtime promotion review — APPROVED, execute bounded promotion next (2026-09-07)

Review request ID: `B12-runtime-promotion-review-20260907`.

Decision: **APPROVE — RUNTIME_PROMOTION_EXECUTION_AUTHORIZED**.

Report:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\B12-runtime-promotion-review_20260907\runtime_promotion_review.md`.

This was read-only. No promotion, copy, delete, cleanup, commit, push, tag or
release was performed. `QEMU_RUNTIME.json` was not changed.

Promote only:
candidate SHA256
`3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`
over canonical executable SHA256
`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`.

Promotion procedure authorized:

1. verify candidate SHA and canonical rollback SHA;
2. create immutable snapshot of canonical `qemu-system-xtensa.exe` plus adjacent
   DLLs;
3. verify snapshot executable SHA;
4. copy candidate to a temporary file inside the canonical runtime directory;
5. verify temporary file SHA;
6. replace only the canonical executable;
7. preserve all adjacent DLLs;
8. update `QEMU_RUNTIME.json` with new SHA, source provenance, topology and
   evidence;
9. run post-promotion gates via the canonical path only;
10. automatically restore rollback if any gate fails.

Authorized post-promotion gates, `VNEXT_B+MTTCG` only:

- affected deterministic QEMU tests: `test-esp32-timg-wdt-scale`,
  `test-esp32-timg-pause`, `test-vnext-b-classify`;
- `vnext_b_attachment_test`;
- `session_restart_stress_test`;
- one complete `VNEXT_B+MTTCG` regression, 14/14 required;
- B11 N=1 smoke;
- one B11 N=16 cell;
- SHA confirmation in headers/logs;
- zero unexpected reset, UART/I2C loss/desync, artifact fatal, teardown hang,
  blocked re-entrant IO and QEMU orphan.

Do not run `LEGACY`, `ICOUNT`, `SINGLE_REALTIME`, Phase C, cleanup, commit,
push, tag or release in the promotion execution.

## B12 final decision — PASS; promotion review authorized for VNEXT_B+MTTCG (2026-09-07)

B12 result: **B12_PASS — PROMOTION_REVIEW_AUTHORIZED**.

Report:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\B12-final-decision_20260907_1735\B12_final_decision_report.md`.

Scope remains `VNEXT_B+MTTCG` only. B12 did not run or require `LEGACY`,
`ICOUNT`, `SINGLE_REALTIME`, the historical 2x3 matrix, or Phase C.

Audited candidate:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\candidate_qemu\qemu-system-xtensa.exe`
with SHA256
`3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`.

Approved B11 evidence:

- N=1: 1/1 valid execution, 1/1 workload, 2 raw/unique expected resets, 0
  unexpected resets;
- N=8: 1/1 valid execution, 8/8 workloads, 16 raw/unique expected resets, 0
  unexpected resets;
- N=12: 1/1 valid execution, 12/12 workloads, 24 raw/unique expected resets, 0
  unexpected resets;
- N=16: 3/3 valid executions, 48/48 workloads, 96 raw/unique expected resets,
  0 unexpected resets.

All sessions have `submissions==completions>0`, `artifactFatal=false`, no
transport failure, clean teardown and zero owned QEMU orphans. Approved logs
show no active `CACHEERR`, Guru, TG0/TG1 expiry, unexpected
`SW_CPU_RESET_REGISTER`, UART loss, I2C loss/desync, blocked re-entrant IO,
timeout or fail-open marker.

Classification: **NO_ACTIVE_ANOMALY_OBSERVED**. There is no current failure
population to classify as starvation-compatible, transport anomaly, or
execution-path anomaly; Phase C capacity/clock/watchdog-compensation options are
not justified by current evidence.

Next exact action: perform a separate promotion review for the candidate SHA
above. Do not promote during this handoff itself. Preserve the canonical runtime
and `QEMU_RUNTIME.json` as rollback at SHA256
`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E` until a
separate promotion step is explicitly approved and recorded.

## E134 closure review — APPROVE; B12 authorized only for VNEXT_B+MTTCG (2026-09-07)

Review request ID: `E134-wdt-scale-reanchor-closure-review`.

Decision: **APPROVE**. E134 and B11 may be closed. B12 is authorized
exclusively for `VNEXT_B+MTTCG`. This review did not execute B12 and did not
promote the runtime.

Use only the preserved E134 candidate QEMU:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\candidate_qemu\qemu-system-xtensa.exe`
with SHA256
`3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`.

Preserve the canonical runtime as rollback. `QEMU_RUNTIME.json` and the
canonical executable remain pointed at SHA256
`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`; do not
rewrite them except in a separate, explicit promotion step after B12.

The accepted caveat is narrow: the rebuilt no-feed MWDT fixture did not produce
observable stdout/stderr in bounded QEMU attempts, so this review does not
claim a new integrated no-feed later-expiry proof. It is not blocking because
prior expiry behavior exists, scale 1 remains literal, the deterministic E134
suite proves the scaled expiry boundary, the correction does not disable
timers/callbacks, and all regressions/B11 evidence are clean.

## E134 — REVIEW_REQUIRED for closure before B12/promotion (2026-09-07)

E134 foi implementada e validada em `VNEXT_B+MTTCG`, mas a próxima ação ainda é
review de fechamento antes de qualquer B12/promoção.

Artefato:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218`.

Ler primeiro:

- `orchestrator\.ai\EVIDENCE.md` seção “E134 phase 2”;
- `orchestrator\.ai\REVIEW_PACKET.md`;
- `include\hw\timer\esp32_timg_wdt_scale_math.h`;
- `hw\timer\esp32_timg.c`;
- `tests\unit\test-esp32-timg-wdt-scale.c`;
- `net\slirp.c` somente para auditar o ajuste compilatório QAPI fora de E134.

Status validado:

1. helper integrado diretamente a `esp32_timg_wdt_arm()`;
2. deadline limitado a `INT64_MAX`;
3. escala zero normalizada para 1;
4. escala 1 literal-equivalente;
5. reconfiguração neutra preservada dentro de menos de um tick literal;
6. mudança real de prescaler preserva a semântica existente e fica registrada
   como possível inconsistência separada, não corrigida por E134;
7. teste unitário/Meson 13/13 PASS;
8. duas regressões `VNEXT_B+MTTCG` 14/14 PASS;
9. B11: N=1 PASS, N=8 PASS, N=12 PASS, N=16 PASS 3/3.

Limitação honesta: a tentativa integrada com fixture MWDT no-feed não produziu
stdout/stderr observável e foi classificada como inconclusiva; não registrar
como prova integrada de expiração final. A ausência de expiração prematura está
provada pelos gates de produção/B11, e a fronteira de expiração legítima está
provada pelo teste determinístico do helper.

Próxima ação exata: solicitar review de fechamento E134. Se aprovado, o review
pode liberar B12/promoção em uma etapa posterior explícita. Se rejeitado,
executar somente a prova adicional indicada pelo review. Não executar B12,
promoção, cleanup, commit, tag, release, LEGACY, ICOUNT ou SINGLE_REALTIME sem
nova autorização.

## E134 phase 1 — REVIEW_REQUIRED before watchdog scale/reanchor semantic fix (2026-09-07)

H134 foi confirmada matematicamente e por teste RED, mas a correção altera
semântica interna do watchdog e precisa de review antes de ser aplicada.

Artefato:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218`.

Ler primeiro:

- `...\E134_phase1_red_review.md`;
- `orchestrator\.ai\REVIEW_PACKET.md`;
- `hw\timer\esp32_timg.c`;
- `include\hw\timer\esp32_timg_wdt_scale_math.h`;
- `tests\unit\test-esp32-timg-wdt-scale.c`.

Pergunta ao review: autorizar a correção para representar o timeout efetivo no
domínio de ticks escalados, mantendo `count_base` literal, registradores guest
brutos, escala 1 literal, FEED/reset/stage modes intactos, e removendo a
segunda multiplicação de `ns_to_timeout` por `wdt_time_scale`.

Se aprovado, próxima ação exata:

1. alterar o helper puro para `effective_stage_timeout = raw * scale` saturado;
2. fazer `esp32_timg_wdt_arm()` chamar o helper diretamente;
3. ampliar o ring causal bounded/off-by-default para raw/effective timeout,
   literal count, remaining ticks, old/new deadline, endereço CONFIG, old/new
   value, CPU escritora e PC guest;
4. executar as camadas de validação E134 antes de retomar B11 do zero.

Se rejeitado, preservar a decisão e não improvisar mitigação. Não executar B11,
B12, promoção, cleanup, commit, tag, release, LEGACY, ICOUNT ou SINGLE_REALTIME
enquanto o review estiver pendente.

## E133 — B11 N=16 permanece aberto; próxima ação é prova causal dirigida (2026-09-07)

Estado após E133: runner/harness foi saneado sem mudança semântica de
QEMU/Core/firmware. O runner agora falha fechado quando `cellPass=false`,
timeout, exit code ausente/não-zero, JSONL incompleto, teardown sujo, órfão
próprio ou inconsistência stderr/JSONL; cleanup de QEMU foi limitado a filhos
pertencentes à execução corrente. Teste determinístico do runner: 14/14 PASS.

Artefato E133:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E133-b11-n16-causality_20260907_141445`.
Resumo consolidado:
`...\E133_consolidated_result.md` e `...\E133_consolidated_result.json`.

Classificação atual: B11 N=16 está **OPEN / causalidade incompleta**. O vermelho
foi estreitado para falha sensível a escala com expiração genuína TG1 observada
em diagnóstico, seguida por caminho guest de reset de software/pânico
(`SW_CPU_RESET_REGISTER` / `SW_APPCPU_RESET`). O classificador continua com
`MWDT_ATTRIB_RESETS=0`; não há prova de CACHEERR, Guru, reentrância ou
teardown-hang. O quadro de pânico é ambíguo e há sintoma separado de sessão sem
workload com CPU1 em `panic_handler`.

Próxima ação exclusiva: construir uma prova dirigida do ponto causal entre a
primeira expiração TG1 genuína e a decisão guest de `SW_APPCPU_RESET`, incluindo
correlação por sessão/PID/boot_epoch/PC/amostras imediatamente anteriores. Se a
correção exigida for semântica de QEMU/Core/firmware, preparar prova mínima e
review antes de editar.

Não executar B12, promoção, cleanup, commit, tag, release, `LEGACY`,
`SINGLE_REALTIME` ou `ICOUNT`. Não classificar o caso como MWDT direto,
CACHEERR, reentrância, teardown ou simples oversubscription sem evidência
adicional.

## E132-F — parar no primeiro vermelho B11 N=16; classificar antes de qualquer promoção (2026-09-07)

Sequência pós-review retomada depois de E132-E:

- determinísticos consolidados: 8/8 PASS;
- RESET_WAIT: 3/3 PASS;
- E131 completo: 6/6 PASS;
- regressões `VNEXT_B+MTTCG`: duas passagens 14/14 PASS cada uma;
- B11 formal: N=1 PASS, N=8 PASS, N=12 PASS, **N=16 FAIL/FIRST_RED**.

Artefato principal:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E132-post-review_20260907_113506\E132-E_session_restart_oracle_20260907_123456\E132F_post_review_resume_summary.json`.

Próxima ação exclusiva: investigar/classificar o B11 N=16 vermelho preservado
em `...\phase_next_B11_formal\N16` antes de qualquer nova tentativa. Não tratar
como MWDT/CACHEERR/reentrância por inferência: a evidência medida mostra
`MWDT_ATTRIB_RESETS=0`, `CACHEERR=0`, `Guru=0`, `Blocked re-entrant IO=0`,
`TEARDOWN_HANG=0`, zero QEMU órfão, mas `totalUnexpectedResets=14` e
`sessionsWorkloadPass=13/16`, com sessões 7/9/12 sem workload.

Não executar B12, promoção, cleanup, commit, tag, release, `LEGACY`,
`SINGLE_REALTIME` ou `ICOUNT`. Não retry N=16 às cegas; primeiro comparar o log
N=16 com N=12/N=8 e classificar causa por reset/source/session/boot_epoch.

## E132-E — retomar validação pós-review após saneamento do restart (2026-09-07)

`session_restart_stress_test` foi saneado sem mudança semântica QEMU/produção.
O primeiro vermelho E132-D está reclassificado como harness/oráculo trace-gated.
Evidência preservada em
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E132-post-review_20260907_113506\E132-E_session_restart_oracle_20260907_123456`.

Resultado: rebuild isolado verde; blank-flash 3 ciclos verde; firmware real
2 ciclos verde; formal firmware real 15 ciclos verde; todos com traces
operacionais OFF, zero timeout, zero QEMU órfão e sem marcadores negativos. O
manifesto consolidado `E132E_consolidated_deterministic_results.json` fecha os
determinísticos pós-review em 8/8 PASS, preservando os 7 verdes anteriores e
rerodando somente o menor teste causal corrigido.

Próxima ação: continuar a sequência pós-review estrita `VNEXT_B+MTTCG` com o
mesmo QEMU candidato SHA
`5E0F51664C88685EA986A2F7F975A728CD02190D05AB76EA17D9AB52A2C74F7A`: executar
RESET_WAIT 3/3 e E131 6/6 conforme E132-C, depois duas regressões
`VNEXT_B+MTTCG` 13/13, e só então reiniciar B11 do zero em N=1/8/12/16, sempre
parando no primeiro vermelho.

Ainda não executar `LEGACY`, `SINGLE_REALTIME` ou `ICOUNT`. Ainda não promover
runtime, limpar artefatos, commitar, taguear ou publicar.

## E132-D — corrigir primeiro vermelho determinístico antes de prosseguir (2026-09-07)

Phase C parou corretamente no primeiro vermelho: `session_restart_stress_test`
falhou com exit code 1. A evidência aponta para oráculo de harness/precondição,
não para falha semântica de QEMU: em `VNEXT_B` com flash vazia, o teste exige a
string diagnóstica `[VNEXT_PROBE] after qemu_init`, mas a validação formal roda
com `LASECSIMUL_VNEXT_TRACE` desligado.

Próxima ação exclusiva: sanear esse oráculo para liveness não dependente de
trace opt-in (heartbeat/estado estrutural já disponível) ou tornar o firmware
real uma precondição explícita do cenário; preservar a prova RED atual e
reexecutar somente o menor teste causal. Não executar regressões, B11, B12,
promoção, cleanup, commit, tag ou release antes desse vermelho estar resolvido.

## E132-C — executar validação pós-review autorizada (2026-09-07)

Reviewer independente aprovou `E132-B-review-20260907`; E131 fica fechado
estritamente para `VNEXT_B+MTTCG`, sem promoção direta do runtime. Snapshot
inicial: `C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E132-post-review_20260907_113506`.

Próxima ação: rebuild controlado de QEMU/Core/harness/firmware necessário,
preservar hashes e executar os testes determinísticos afetados, RESET_WAIT 3/3
e E131 6/6. Se verde, executar duas regressões `VNEXT_B+MTTCG` 13/13 com o
mesmo SHA e reiniciar B11 do zero em N=1/8/12/16, parando no primeiro vermelho.

Não executar `LEGACY`, `SINGLE_REALTIME` ou `ICOUNT`. Não promover runtime,
limpar artefatos, commitar, taguear ou publicar antes de B11/B12 e auditoria
final verdes.

## E132-B — REVIEW_REQUIRED antes de retomar B11 (2026-09-07)

E132-B corrigiu somente diagnóstico/oráculo e fechou RESET_WAIT 3/3, seguido
pela bateria E131 completa 6/6 em processos independentes, sem timeout, teardown
sujo ou órfão. O QEMU avaliado tem SHA `5E0F5166...`; nenhum runtime foi promovido
e `QEMU_RUNTIME.json` permanece apontando ao canônico `B375A9E8...`.

Próxima ação executável depende da revisão: aceitar ou rejeitar o fechamento
estrito de E131 para VNEXT_B+MTTCG. Se aceito, executar primeiro os testes
determinísticos afetados e duas regressões VNEXT_B+MTTCG 13/13 com o mesmo SHA;
somente então reiniciar B11 desde N=1, parando na primeira célula vermelha. Não
executar LEGACY, SINGLE_REALTIME, ICOUNT, N=16 isolado ou promoção antes disso.

## E132 bloqueada no primeiro vermelho (2026-09-07)

O supervisor E131 foi endurecido e não aceita mais PASS por exit code isolado.
O snapshot está em
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E132-gate-integrity`.
A prova RED do RESET_WAIT terminou em `SUPERVISOR_INTEGRITY_FAIL` e code 96:
summary/progresso/stderr contradizem o code observado.

Próximo passo autorizado, e somente ele: corrigir a instrumentação diagnóstica
da geração APP CPU e substituir o oráculo FreeRTOS por evidência arquitetural
de cancelamento/progresso pós-reset. Depois rebuild e no máximo três RESET_WAIT.
Não executar bateria E131 final, B11, N=16, LEGACY, SINGLE_REALTIME ou ICOUNT
enquanto RESET_WAIT não passar 3/3. Não alterar runtime ou manifesto.

## E131-E completed next action — cache-wait VNEXT_B+MTTCG closed; investigate LEGACY gate separately (2026-09-07)

E131-E completed the requested harness/runner sanitation and re-ran the
conditioned E131-C proof.

Do **not** implement a QEMU cache-wait semantic correction from E131-A/C/D.
The valid classification is:

- E131-A: structurally invalid/inconclusive.
- First E131-C/D red observations: not reproduced as clean QEMU semantic
  failures; environment/harness influence remains a hypothesis, not a proven
  causal variable.
- E131-E: cache-wait behavior under VNEXT_B+MTTCG is closed by fresh,
  hermetic, per-scenario processes and full artifact preservation.

Use these artifact roots for follow-up:

- Final 18/18 E131 cache-wait:
  `C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E131-cache-wait-e2e\artifacts\20260907_E131E\phase6_full_18x_final2`
- Supervisor/harness sanity:
  `C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E131-cache-wait-e2e\artifacts\20260907_E131E\phase4_supervisor_normal_final2`
  and
  `...\phase4_supervisor_forced_timeout_final2`
- Phase7 regression evidence:
  `C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E131-cache-wait-e2e\artifacts\20260907_E131E\phase7_13x13_safe_wrapper`

Next action is **not** B11/N16/B12. If more work is requested, isolate the
separate LEGACY+MTTCG regression: first attempt of the safe 13/13 wrapper
failed with `submissions=0` and four unexpected `SW_CPU_RESET_REGISTER` resets,
while VNEXT_B+MTTCG passed 26/26 and the E131 cache-wait battery passed 18/18.
Also note the stale default `devices/qemu-esp32/bin/qemu-system-xtensa.exe`
ABI mismatch; any runtime binary promotion/copy must be an explicit separate
gate. `QEMU_RUNTIME.json` remains unchanged.

## E131-B completed next action — proof is green; do not apply a QEMU semantic correction from E131-A (2026-09-06)

E131-B has now rebuilt and validated the cache-wait E2E proof under
VNEXT_B+MTTCG with fresh QEMU processes per scenario and immutable per-scenario
firmware/ELF/map/log preservation.

Final artifact root:

`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E131-cache-wait-e2e\artifacts\20260906_194124`

Final run summary:

`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E131-cache-wait-e2e\artifacts\20260906_194124\runs\E131_RUN_SUMMARY.txt`

All six scenarios passed: DROM, FETCH, RUNSTALL, CLKGATE, SELF_ILLEGAL, and
RESET_WAIT.

Do **not** implement a QEMU semantic correction based on E131-A. E131-A remains
classified as structurally invalid/inconclusive. E131-B proves the isolated
cache-wait behavior with the current semantic path plus diagnostic
instrumentation:

- DROM data-load: isolated, APP-side controller/worker in IRAM, DROM value in
  `.flash.rodata`, exact load PC proven by disassembly, `mem_io_pc != 0`, and
  successful TCG restore.
- FETCH: isolated instruction-fetch wait, `mem_io_pc=0`,
  `attempted=0/restored=0`, and translation begins again at the same guest PC.
- RUNSTALL/CLKGATE: wait release preserves the orthogonal hold state until
  that hold is explicitly released.
- SELF_ILLEGAL: intentional self-disable stays legitimate illegal, not
  compensatory suspend.
- RESET_WAIT: reset cancels the pending wait (`wait_mask=0`) without stale
  `resume_committed`.

Remaining caution: `instruction_replayed` is still not a useful proof counter
in these logs; use the exact PC/vaddr/restore/retranslation/value-marker
evidence recorded in `EVIDENCE.md` E131-B instead.

Next work should return to the broader open gates only if explicitly directed:
B11/N=16 capacity/reset classification, B12, ICOUNT, SINGLE_REALTIME, or
runtime promotion remain separate and are not authorized by E131-B alone.

## Superseded E131-B next action — rebuild the proof, not QEMU production semantics yet (2026-09-06)

Superseded by the completed E131-B entry above. E131-A has been superseded as
**structurally invalid/inconclusive**. Do not
treat its `target_pc_match=0` result as a proven replay failure. The valid
classification is:

- Source-proven: shared process across scenarios; `run_clkgate_case()` not
  called; harness still requires clockgate; RUNSTALL case lacks cleanup;
  replay criterion uses a later sampled PC; full logs are not preserved.
- ELF/disassembly-proven: the APP-side wait/worker path is materialized inside
  `loop()` in `.flash.text`; `0x400d1d0f` maps to `loop()` /
  `src/main.cpp:75`; the intended DROM load of `kDromKnownValue` at
  `0x3f409c08` occurs only later at `0x400d1d34`; therefore E131-A's DROM
  case is not an isolated data-load test.
- Pending/hypothesis: exact cause of each `_UserExceptionVector`; whether any
  specific restore/replay failed; whether every case was contaminated in the
  same manner.

Next action remains VNEXT_B+MTTCG only:

1. Rebuild the guest proof so each scenario runs in a fresh QEMU process.
2. Preserve each variant immutably before execution: `merged.bin`,
   `firmware.elf`, linker map, SHA-256, QEMU SHA, harness/source hash, and full
   log.
3. First prove DROM data-load with the APP controller actually in physical
   IRAM via `nm -anC`, linker map, `objdump -t -h -d`, `addr2line`, and call
   site inspection. Expected result: wait on DROM data load with
   `mem_io_pc != 0` and successful `cpu_restore_state()`.
4. Separately prove instruction-fetch. For translation/fetch, `mem_io_pc == 0`
   may be correct; do not demand `cpu_restore_state()` if the translation is
   shown to restart at the same guest PC.
5. Instrument only as needed for proof correlation by CPU, generation, region,
   vaddr, guest PC, host `mem_io_pc`, wait/release/resume/retry/cancel/reset
   reason, and scenario. Do not alter production cache-wait semantics before a
   valid isolated RED/GREEN exists.

## E131-A stop state (2026-09-06)

Do not create/promote an E131 QEMU candidate from the current work. The
deterministic VNEXT_B+MTTCG cache-wait E2E harness was built and did trigger
real wait/release/resume activity, but the required replay-PC property failed:
at least one `resume_committed` reported `target_pc_match=0`, e.g.
`replay_owed_pc=0x400d1d0f` while `target_appcpu_pc=0x40080340`.

Next directed action should start from this failure, not from B11/capacity:
prove why APP CPU's target PC can move to `0x40080340` while a cache-wait is
owed, or replace the stop/replay mechanism with one that records and restores
the replay PC through a target-correct path. Keep scope VNEXT_B+MTTCG unless a
new instruction explicitly authorizes broader modes.

## E130 correction / current stop state (2026-09-06)

The immediately following E130 section is retained as historical narrative,
but its N=16 causal label is withdrawn. The only supported classification of
the two failing sessions is:

`software-reset cascade with unknown initiating panic under N=16 contention`

The aggregate log has 44 raw reset lines and 36 deduplicated events. PIDs
42984 and 63836 each contribute a repeated four-line block; deduplication uses
PID, boot epoch, reset count, mask, both PCs and source. The old empty
`EXIT_CODE` field is a runner defect; the harness failure is semantically exit
code 1 (`PRODUCTION_SCALE FAIL failures=2`). No causal frame exists, so no
TG0/TG1, CACHEERR, exception, watchdog or host-starvation conclusion is
allowed. Do not run the four capacity cells, another N=16 attempt, B12,
ICOUNT or SINGLE_REALTIME until a directed diagnostic produces a complete
first-reset frame; this follows the explicit stop conditions.

The cache-wait path has only pure tests and structural review so far. A
deterministic end-to-end test remains required; do not substitute more random
campaign attempts. `QEMU_RUNTIME.json` remains untouched. The runner changes
must preserve the production environment hygiene, record QEMU/firmware/ELF/
harness hashes, and report raw and deduplicated reset counts separately.

## Set 2026-09-05 after E130: N=8 delta PROVEN to be a harness measurement race (not transport
## loss), fixed with a drain/cutoff gate; a real reset-during-cache-wait deadlock gap FOUND and
## FIXED; formal B11 restart N=1/N=8/N=12 PASS, N=16 FAILS on the separate, pre-existing
## TG-watchdog-oversubscription issue (zero cache/CACHEERR involvement) -- runtime still not promoted

**Two objectives closed.** (A) Ownership/coexistence of the E129 cache-wait stop with global
pause/reset/teardown was audited instead of trusted on the old unverified comment -- found and
fixed a real gap: `esp32_app_cpu_reset_async()` (`hw/xtensa/esp32.c`, the per-CPU
`SW_CPU_RESET_REGISTER`/`MWDT_CPU_STAGE` reset path) never called `cpu_resume()`, so a reset landing
while APP CPU was cache-wait-parked would reset its registers and leave it permanently asleep.
Fixed with one `cpu_resume(cs)` call, mirroring what `resume_all_vcpus()` already does for the
full-system-reset path. (B) E129's B11 N=8 `submissions=completions+1` delta was proven, by reading
`McuComponent.cpp`'s single-consumer dispatch loop AND by 3x live N=8 reproduction
(`postCutSubmissions` up to 598 observed), to be E120's own convergence-wait loop re-reading
counters after a fresh guest submission landed in the gap -- not a transport loss. Fixed with a
frozen per-session submission cutoff + drain-to-watermark gate
(`core/src/mcu/qemu/DrainCutoffGate.hpp`), proven by 7 deterministic RED/GREEN tests
(`drain_cutoff_gate_test`, now in `run_regression.ps1`'s 14-test list) including the critical
negative control (a genuinely lost pre-cut request still times out the gate).

**Formal B11 restart, fresh (not reusing E129's or this session's own exploratory N=1/N=8 runs)**:
N=1 PASS, N=8 PASS (the exact sessions that showed the delta before now show
`submissions=completions` exactly), N=12 PASS, **N=16 FAILS** -- 2 of 16 sessions never progress
past a repeated boot-reset cycle (`submissions=0`, 2 unexpected resets each). Confirmed NOT a
cache-wait/CACHEERR regression: zero "cache"/`exccause=7` anywhere in the log; the reset signature
(`source=SW_CPU_RESET_REGISTER`, `cause=12`) matches the pre-existing, separately-tracked
TG-watchdog-reset-under-oversubscription issue (32 vCPU threads on 26 usable cores), frozen behind
its own DECISION-004 gate. Stopped there per instruction -- no B12, no further N.

**Still open, honestly**: the cache-wait interlock's real, live "fires end-to-end with a correct
replayed read" proof was NOT captured this session -- 7 reproduction attempts (quiet N=1/N=8 at
various durations, plus 4x N=8 with `LASECSIMUL_CACHE_TRACE=1`, the E124-established
timing-widening technique) all showed zero `wait_detected` events. The 27 pure-function tests and
the Fase 1/2 structural proof (EVIDENCE.md E130) stand on their own, but this specific live-fire
proof is future work: either more attempts, longer runtime, or a deterministic monitor/GDB-driven
register write instead of relying on incidental timing.

**Next step**: (1) get a live firing of the cache-wait interlock (see above) to close Fase 3
properly; (2) the N=16 TG-watchdog failure is a SEPARATE, already-documented issue (see the
`SharedHostCapacity`/capacity-governance direction sketched in an earlier, unrelated planning pass)
-- do not conflate it with cache-wait or the drain/cutoff work, and do not attempt a fix without
its own DECISION-004-gated review. `QEMU_RUNTIME.json` NOT promoted: blocked on both the open Fase 3
proof and B11 N=16 failing (for a reason outside E129/E130's own scope, but B11 as a whole isn't
green). See EVIDENCE.md E130.

## Superseded 2026-09-05 (E129, before E130): E128's cache-race DEADLOCK FIXED (per-access interlock
## replaces the blanket runstall); B11 formal N=1 PASSES for the first time ever; N=8 STOPS on a
## genuinely new, undiagnosed submissions/completions off-by-one (zero resets, zero deadlock, zero
## reentrancy block) -- N=12/N=16 not attempted, runtime not promoted

**The E128 deadlock is fixed and validated.** E124/E125's `appcpu_cache_race_stall` compensation
applied a blanket `xtensa_runstall()` to ALL of APP CPU's execution whenever a different core
disabled one of its cache regions -- including, as E128 proved, while APP CPU was mid-interrupt-
return inside its own legitimate `spi_flash_op_block_func()` busy-wait (`IRAM_ATTR`, architecturally
unaffected by the disabled region), deadlocking it permanently. Fixed by replacing the blanket
stall with a per-access interlock: only a load/fetch that actually LANDS on a disabled region now
suspends (via `cpu_stop_current()`/`cpu_loop_exit_restore()`, the exact idiom already proven safe
for VNEXT_B backpressure throughout this fork -- never releases the BQL, so it coexists safely with
reset/clkgate/RUNSTALL on their own orthogonal axis), implemented in `hw/misc/esp32_dport.c`'s
`esp32_cache_ill_read()` (the illegal-access-trap callback every access to a disabled region already
passed through). A real architectural constraint was found by a failed build, not anticipated:
`esp32_dport.c` compiles into QEMU's target-independent shared library and cannot include
`exec/exec-all.h` directly -- the actual suspend call lives in a thin wrapper in `softmmu/vnext_b.c`
(already compiled per-target and already home to every other such call site), matching the
established `esp32_i2c.c`/`esp32_uart.c` pattern exactly.

**Validated thoroughly**: unit tests 13->27 (all passing, covering the exact deadlocking scenario
and its inverse); the identical N=1/15s scenario that showed `submissions=0` in E128 now shows
`submissions=6820` on the first attempt; **10/10 fresh N=1/15s attempts all clean**
(`cellPass=True`, `submissions==completions>0`, zero unexpected resets, zero orphans); all Core
suites and 3x `run_regression.ps1` (13/13 each) green against the actual candidate SHA
(`A09934CC185170693BC413FE7FE30693333B394F109CFDF092EED63D2E6AEAFC`).

**Formal B11 restart: N=1 PASSES** (`submissions=9825`, zero unexpected resets) -- the first time
this has ever happened in this investigation's history; E127 stopped at exactly this cell with zero
submissions. **N=8 STOPS**, but on a genuinely different, previously-unseen symptom: zero resets,
zero deadlock, zero `Blocked re-entrant IO`, yet two of eight sessions show `submissions` exceeding
`completions` by exactly 1. Per this task's own explicit stop condition ("encontrar uma falha
diferente"), stopped immediately -- no retry, no specul-fix, N=12/N=16 not attempted,
`QEMU_RUNTIME.json` not touched. Two honest possibilities recorded, neither asserted: a genuine rare
lost completion under N=8 host contention that no prior N=8 attempt in this investigation's history
ever survived long enough to observe (every one previously failed earlier via CACHEERR, the TG1
cascade, or this entry's own now-fixed deadlock); or a benign artifact of the 60s teardown cutoff
catching one request mid-flight. No existing diagnostic was armed for this formal run (correctly,
per "traces desligados") to distinguish the two.

**Preserved**: all five prior candidate SHAs (canonical, E121, E122, E126's `3D65BD36...` immutable
copy, E127's diagnostic `D9577DAF...`) reconfirmed byte-identical. New candidate staged to its own
directory, `E129-cache-wait-interlock/candidate_qemu/`, nothing else overwritten.

**Next step**: investigate the N=8 submissions/completions mismatch specifically (a narrow, gated
diagnostic on `vnext_b_i2c_submit()`/`esp32_i2c.c`'s response-publish path at N=8 scale is the
natural next instrument) -- do not re-open CACHEERR, the TG1 cascade, or this entry's own deadlock,
all closed. Only after N=8 (then N=12, N=16) pass as cleanly as N=1 now does should B11 be
considered complete or the runtime promoted. See EVIDENCE.md E129.

## Superseded 2026-09-05 (E128, before E129): ROOT CAUSE of E127's silent-workload B11 N=1 failure PROVEN causally
## -- the E124/E125 cache-race-stall compensation deadlocks APP CPU permanently when it engages
## while APP CPU is mid-interrupt-return inside its own spi_flash_op_block_func() busy-wait; NO FIX
## applied (the obvious candidate has its own proven correctness gap); B11 restart still blocked

**This is not a new, unrelated failure -- it is the E124/E125 fix itself, causally proven.** Four
independent, correlated data points, all from direct instrumentation (not inference): (1) CPU1's
PC never leaves its own reset vector in the bounded early-boot probe; (2)
`appcpu_cache_race_stall_mask` cycles cleanly `0x0<->0x3` several times (matching CPU0's own
known rapid `CACHE_ENA` toggling) then gets stuck at `0x3` forever, with zero further
`[APPCPU_STALL_TRACE]` lines after that point -- proving CPU0 itself never writes `APP_CACHE_CTRL`
again for the rest of the run; (3) the exact PC at the permanent stall is `_frxt_int_exit`
(FreeRTOS Xtensa interrupt-return assembly), immediately after CPU1 was in
`spi_flash_op_block_func` (its own, legitimate, `IRAM_ATTR` busy-wait during a real flash
operation) -- CPU1 took a routine tick interrupt and was frozen by `xtensa_runstall()` mid-return;
(4) a narrow, gated, non-production experimental control
(`LASECSIMUL_DISABLE_CACHE_RACE_STALL=1`) that disables only this one compensation reason restores
the workload completely (`submissions=6168` vs `0` in the same 15s scenario) -- and the identical
scenario is clean against E122 (`AA3B7CA6...`, predates the compensation), confirming the
mechanism is specific to E124/E125's own added code.

**Mechanism**: the compensation halts APP CPU's *entire* instruction stream via `xtensa_runstall()`
whenever a different core disables its cache -- not just accesses to the disabled region.
`spi_flash_op_block_func()` is `IRAM_ATTR` (physical SRAM, architecturally unaffected by the
DROM0/IRAM0 *flash-cache* windows being disabled) precisely so real ESP-IDF can keep running it
through a cache-disable window -- freezing it anyway, mid-interrupt-return, creates a deadlock with
no real-hardware equivalent: APP CPU cannot run to release whatever it holds at that frozen
instant (most plausibly a FreeRTOS SMP kernel critical section/spinlock, not further isolated this
session), and PRO CPU can never reach the `APP_CACHE_CTRL` re-enable write that would release APP
CPU's stall, because PRO CPU itself is blocked on the resource APP CPU holds.

**No correction applied.** The obvious fix (skip engaging the stall if APP CPU's `PS.INTLEVEL`/
`PS.EXCM` shows it's currently in interrupt/exception context) has a proven gap: nothing re-arms
or re-applies the stall when APP CPU later organically exits that interrupt context, since
`esp32_cpu_stall()` only re-evaluates on a subsequent register write, not on APP CPU's own
asynchronous progress -- shipping this would trade a fully-reproducible deadlock for an
intermittent, harder-to-detect reopening of the exact CACHEERR window E124 fixed. A genuinely
correct fix needs either a target-specific interrupt-return hook (not available at this
hw/misc-hw/xtensa boundary today) or a structurally different mechanism (trap only the actual
faulting access, rather than stalling all execution) -- both larger, more careful redesigns than
fit safely in one session, consistent with E124's own earlier fidelity-audit note that more
faithful alternatives were out of scope at the time.

**Preserved**: canonical `B375A9E8...`, E121 `D7A2896D...`, E122 `AA3B7CA6...` (used as the clean
control), E126 `3D65BD36...` (immutable copy, untouched, NOT the source of this finding -- the
diagnostic builds used for this entry are staged separately at
`E126-tg1-intwdt/diag_candidate_e127/`, SHA `8CF5A800...`, explicitly not a B11 candidate).
`E127-tg1-intwdt/B11_formal/N1/` (the original failing attempt) untouched. `2043C031...` (E125)
remains not recoverable as a standalone file, as already disclosed in E127.

**Next step**: design and validate a correct fix (interrupt-context-aware re-arm, or a
trap-the-access redesign), with the same RED/GREEN unit-test + multi-attempt real-firmware
validation rigor E124/E125 themselves required -- not attempted this session. Only after that
should B11 restart from N=1. Do not run N=8/N=12/N=16/B12/SINGLE_REALTIME/ICOUNT, and do not
attempt a quick interrupt-context exemption without also solving the re-arm problem identified
above. See EVIDENCE.md E128.

## Superseded 2026-09-05 (E127, before E128): formal B11 restart with the E126 candidate STOPPED at N=1 -- a new,
## distinct blocking failure (silent workload non-start on a clean boot), unrelated to CACHEERR or
## TG1-IntWDT; regressions re-validated against the actual candidate SHA (prior session used
## canonical); N=8/N=12/N=16 NOT attempted

**Corrects the prior session's incomplete validation**: E126's own regression runs used the
canonical runtime (disclosed at the time, not hidden), not the E126 candidate itself. Re-run with
`-QemuBinary` against an immutable copy of the candidate
(`E126-tg1-intwdt/candidate_qemu_3D65BD36/qemu-system-xtensa.exe`, SHA reconfirmed
`3D65BD36D27D380207D0A0DAC1100AD9CCE702C5B6BA6A642E4A745437073FC2`): VNEXT_B+MTTCG 13/13 twice,
LEGACY+MTTCG 13/13 once, header confirmed printing the candidate's own SHA every time. Also closed
two runner-hygiene gaps: `run_regression.ps1`/`run_production_mwdt.ps1` did not strip
`LASECSIMUL_PANIC_CAUSAL_TRACE`/`LASECSIMUL_RTC_SYS_RESET_CAUSAL_TRACE`/
`LASECSIMUL_CACHE_TRACE_DIR`/`LASECSIMUL_TEARDOWN_TRACE`/`LASECSIMUL_FLASH_WRITE_TRACE`/
`LASECSIMUL_SCALE_SCHEDULER_METRICS` from the environment before launching a formal run -- fixed,
empirically confirmed (a variable set in the parent shell is genuinely absent from a spawned
child's environment, not just the parent's own `$env:` view).

**B11 formal STOPPED at N=1, the very first cell.** Not a retry-away flake to wave off, and
explicitly NOT the TG1/CACHEERR mechanism this candidate exists to close: QEMU booted cleanly, both
CPUs completed startup exactly once, zero resets beyond the two expected ones, `artifactFatal=false`,
`teardownClean=true`, zero orphans -- but the guest produced **zero VNEXT_B/I2C workload traffic for
the entire 60s window** (`submissions=0 completions=0`, `terminalRunning=true` -- the guest was
still alive and executing something, just never reaching its own I2C polling loop). The harness's
own internal verdict printed `PRODUCTION_SCALE FAIL failures=1`. This shares no signature with
CACHEERR, the TG1/`SW_CPU_RESET_REGISTER` cascade (no unexpected reset occurred at all here),
`MWDT_CPU_STAGE`/`MWDT_SYS_STAGE`, or `Blocked re-entrant IO` -- it is a **new, seventh failure
category**, distinct from (though structurally reminiscent of) E113/E121's own previously-
unchased "intermittent invalid-boot flake" (that flake's signature was APP CPU never resetting at
all; here APP CPU *did* complete its startup reset). Per this task's own explicit protocol: stopped
immediately, no retry attempted, no correction applied, N=8/N=12/N=16 not run.

**No E126 tracer applies to a directed reproduction of this specific failure** -- `PANIC_CAUSAL_
TRACE`/`WDT_CAUSAL_TRACE`/`MWDT_ACCOUNTING` all key off a reset/panic/watchdog event, none of which
occurred here. A future directed attempt should reach instead for this fork's pre-existing
`LASECSIMUL_XTENSA_PC_SAMPLER` (dual-core PC sampling) to see where both CPUs actually are during
the silent window, and consider whether a longer `-RunMs` distinguishes "genuinely stuck" from
"very slow to reach its first I2C transaction on this particular boot."

**Preserved, not cleaned up**: `.../B11_formal/N1/` (stderr, stdout, JSONL for the failing attempt);
all five candidate SHAs (`B375A9E8...` canonical, `D7A2896D...` E121, `AA3B7CA6...` E122,
`2043C031...` E125 -- disclosed as no longer recoverable as a standalone file, see EVIDENCE.md E127
Phase 0 -- and `3D65BD36...` E126, now also preserved as an immutable copy separate from
`E124-cacheerr/candidate_qemu/`). `QEMU_RUNTIME.json` untouched; no promotion. B11 is **not**
validated with this candidate.

**Next step**: investigate the silent-workload-non-start failure directly (PC sampling of both
cores during a fresh N=1 attempt, comparing a hung attempt against a healthy one) before
re-attempting B11 from N=1. Do not assume this is the same mechanism as TG1/CACHEERR without
evidence -- treat it as its own, separately-scoped investigation. See EVIDENCE.md E127.

## Superseded 2026-09-05 (E126, before E127): TG1-IntWDT residual mechanism fully reconstructed mechanistically from
## real ESP-IDF source; two real PANIC_CAUSAL_TRACE/WDT_CAUSAL_TRACE tracer gaps found and closed
## (both were structurally blind to this mechanism); 12/12 fresh reproduction attempts (4xN=1 +
## 8xN=8) came back completely clean -- no live frame captured, classification remains open

**Not a regression, not a reopening of CACHEERR/teardown.** This entry read `esp_restart_noos()`
(real ESP-IDF, `esp_system/port/soc/esp32/system_internal.c`), `int_wdt.c`'s CPU1-tick-blame logic,
and `highint_hdl.S`'s TG1WDT/CACHEERR disambiguation end to end, and proved -- not inferred -- that
the given occurrence's (`e125_postfix_n8/attempt_2`, PID 62440) `count=3/4/5` cascade is exactly
`esp_restart_noos()`'s own documented "reset other CPU, disable both watchdogs, reset other CPU
again, reset self" sequence, triggered by *some* panic reaching it. `source=SW_CPU_RESET_REGISTER`
is proven, by reading `hw/xtensa/esp32.c`, to be produced *only* by ESP-IDF's own `esp_cpu_reset()`
software calls -- categorically distinct from a direct TIMG hardware stage action.

**Two real, previously-undiscovered tracer gaps found and fixed**: (1) `PANIC_CAUSAL_TRACE` (E122)
was wired *only* to the `SW_SYS_RESET` branch (the CACHEERR path) -- structurally blind to the
`SW_APPCPU_RESET`/`SW_PROCPU_RESET` branches this mechanism actually uses; now fires on all three,
labeled by trigger, skipping only the one expected app-cpu-startup write. The exact decision is a
new pure function, `esp32_panic_trace_should_capture()` (`include/hw/misc/
esp32_panic_trace_gate.h`), unit-tested (`test-esp32-panic-trace-gate`, 6/6 PASS). (2)
`WDT_CAUSAL_TRACE`/`MWDT_ACCOUNTING`'s reset-snapshot reporting was hardcoded to TG0 only -- given
the mandatory instruction not to assume TG1 by historical name alone, and PID 62440's own
`wdt0_enabled=1`/`wdt1_enabled=0` snapshot, this was a real gap; now per-TG.

**Also proven from source, ruling out one whole category directly**: `hw/block/m25p80.c`'s
program/erase path never releases the BQL or touches VNEXT_B (`memset()` + async
`blk_aio_pwritev()`); `hw/ssi/esp32_spi.c`'s own comment confirms the flash-attached SPI controller
(`number < 2`) never calls `writeReg()`/VNEXT_B at all (only HSPI/VSPI, `number >= 2`, do). The
flash critical section CPU1 was inside (`spi_flash_op_block_func`, confirmed by symbolizing
`pc1=0x40082a2d` against this session's own `firmware.elf`) contributes zero artificial QEMU-side
delay -- Category 6 is excluded for this window by construction, not assumption. Also: ESP-IDF's
own FreeRTOS tick ISR is IRAM-resident specifically so it survives the critical section's
`esp_intr_noniram_disable()`, meaning a merely-long *guest-visible* flash op should not, by design,
starve the int_wdt tick-blame flag on real hardware -- pointing the open question toward a vCPU's
own *host* thread being denied real CPU time (Category 5) rather than naive guest starvation
(Category 4), if the TG1 hypothesis is even the right one at all (see below).

**No live frame was captured this session.** 12 fresh reproduction attempts with all three tracers
armed from process start (4xN=1, 8xN=8 -- the full Fase 6 budget) came back **completely clean**:
zero unexpected resets, zero CACHEERR, `cellPass=True teardownClean=True unexpectedResets=0` on
every one of the 8 N=8 attempts (`Get-B11CellSummary`). The mechanism reproduced reliably in two
prior sessions (E124's preserved `smoke_n1` log, 6 boot_epochs in one 60s window; E125's own
attempt_2/PID 62440) but not once in these 12 fresh attempts today -- consistent with, but not
proof of, host-load-dependent non-determinism. **Classification is therefore reported as
inconclusive on a live frame**, with TG1-IntWDT/host-scheduling-contention stated as the leading,
falsifiable, source-grounded hypothesis -- explicitly not asserted as proven ("não aceite
'provavelmente host load'"). No functional correction applied (Fase 7's gate: only after
classification, and none was earned with the confidence a code change would require).

**Validated, zero regression**: new suite 6/6; all prior QEMU unit suites unchanged (7/7, 13/13,
9/9); `vnext_b_attachment_test` 31/31, `session_restart_stress_test` 15/15,
`mcu_component_live_poll_thread_test` all OK against this entry's own candidate;
`b11_classify_test.ps1` 30/30; `run_regression.ps1` VNEXT_B+MTTCG 13/13 x2, LEGACY+MTTCG 13/13 x1
(canonical, unaffected); zero orphans throughout.

New QEMU candidate staged, NOT promoted (supersedes E125's binary in place, same directory --
E125's own evidence is preserved in EVIDENCE.md, only the binary bytes were replaced by this
strictly-additive superset): `3D65BD36D27D380207D0A0DAC1100AD9CCE702C5B6BA6A642E4A745437073FC2`
(`vnext_prototype/mttcg_causality/E124-cacheerr/candidate_qemu/`). Canonical unchanged
(`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`); E121/E122 candidates
unchanged (`D7A2896D843FBC6C5386CF57690292A37A4EDFA58A207C4E612E325B879C838C`,
`AA3B7CA65445A6751D28748A4407853B06736AAFE9771405CE9143767B3ED029`).

**Next step**: re-arm all three gates on this candidate the next time the mechanism reproduces (no
rebuild needed) and read the `[PANIC_CAUSAL_TRACE]` frame's `exccause`/`tg1_wdt_source20_active` --
this alone resolves the open TG0-vs-TG1 question; then read the matching `[MWDT_ACCOUNTING]`
`residual_share`/`thread_cpu_ns` to settle guest-vs-host starvation quantitatively. Do not run B11,
N=12/N=16, B12, SINGLE_REALTIME, ICOUNT, or promote the runtime before that. See EVIDENCE.md E126.

## Superseded 2026-09-05 (E125, before E126): E124's CACHEERR fix reviewed and HARDENED (three real gaps closed:
## stall-after-disable ordering, an over-broad/permanently-stallable release condition, reset never
## clearing the flag); deterministic unit test added; TG1-IntWDT (E111) reappeared once during
## validation, correctly classified separately; B11 restart still not attempted this session

**E124's root cause is not reopened -- it is proven.** This entry is a review of the *fix's own*
robustness, per its own explicit charter. Three real gaps were found, not merely theorized, all in
`hw/misc/esp32_dport.c`'s `esp32_cache_state_update()`/`esp32_dport_reset()`:

1. **Stall-after-disable ordering.** E124's original code disabled the `drom0`/`iram0`
   `MemoryRegion`s *before* requesting the stall. Read `accel/tcg/cputlb.c` directly rather than
   assuming the BQL closes this window: cross-CPU `tlb_flush()` dispatches via
   `async_run_on_cpu()` (asynchronous), so a vCPU already holding a cached fast-path TLB entry for
   the affected page is not serialized against the writer by the BQL and could in principle race
   through the old ordering's window -- moot for the exact access pattern E124 reproduced (which
   must take the BQL-guarded slow path), but a real, general gap regardless. **Fixed**: reordered
   into Phase A (request stall) / Phase B (apply the actual region enable/disable) / Phase C
   (release only after the same region is confirmed re-enabled).
2. **Over-broad, provably-permanent-stall release condition.** E124's release test was global
   (`drom0_enabled && iram0_enabled`); if either region was independently, legitimately masked via
   `CACHE_CTRL1` for reasons unrelated to the race, that global test could never be true again for
   any number of further cycles -- a real, provable permanent stall, not theoretical (encoded
   literally as a RED test, see below). **Fixed**: replaced the single bool with a per-region
   bitmask (`Esp32DportState::appcpu_cache_race_stall_mask`, bits `ESP32_CACHE_RACE_STALL_DROM0`/
   `IRAM0`) that only tracks true enabled->disabled transitions caused by a *different* core and
   clears the instant that *same* region is next observed enabled, immune to a sibling's permanent
   masking.
3. **Reset lifetime.** `esp32_dport_reset()` lowered `appcpu_stall_req` but never cleared the new
   flag/mask, nor `cache_ctrl_reg`/`cache_ctrl1_reg`/`MemoryRegion.enabled`/`illegal_access_status`
   -- masked immediately after reset by `appcpu_reset_state` already forcing the OR true, but
   resurfaces later once a normal post-reset bring-up clears `reset_state`/`clkgate` while a stale
   pre-reset flag is still set. **Fixed**: all of these are now explicitly, unconditionally reset
   for both cores (deliberately not routed through `esp32_cache_state_update()`, since
   `current_cpu` is meaningless at reset time).

**Fase 4 fidelity finding, recorded honestly per the task's own instruction**: `qemu_simulide`'s own
`esp32_cache_state_update()` has no cross-core cache stall of any kind, and ESP-IDF's own
`cache_utils.c` documents relying on *software* (`esp_ipc_call`) synchronization, not an automatic
hardware stall. **This fix is a deliberate, fork-specific MTTCG-timing compensation, not a model of
literal ESP32 silicon behavior.** No more faithful alternative was judged worth pursuing in this
session's scope.

**Deterministic test added** (the gap E124 itself flagged): `include/hw/misc/esp32_cache_race_stall.h`
(pure, dependency-free extraction of the mask decision logic) +
`tests/unit/test-esp32-dport-cache-race-stall.c` (13/13 PASS), including a literal RED encoding of
E124's original formula proving it would have stalled forever in the pre-existing-mask case. Full
device-level ordering/`xtensa_runstall()` behavior is still validated only at the real-firmware
level, not via a synthetic two-vCPU barrier harness -- disclosed as a real, not-hidden gap.

**Validated**: 4 more N=8/60s real-firmware attempts (`e125_postfix_n8/`) combined with E124's own 4
(`postfix_n8/`) = **8/8 total, zero CACHEERR**. One of the 8 shows the already-known, separate
TG1-IntWDT mechanism (E111, `source=SW_CPU_RESET_REGISTER`) -- preserved and classified apart, not
mixed with CACHEERR, watchdog untouched this session per instruction. New unit suite 13/13; all
prior QEMU/Core suites and regressions green (see EVIDENCE.md E125 for the full numbers); zero
orphans; `teardownClean=true` throughout.

New QEMU candidate staged, NOT promoted (supersedes E124's binary in place, same directory --
E124's own logs/evidence are preserved, only the binary bytes were replaced by this direct
hardening of the same fix): `2043C031AAD3265CC599B9256D5E78AF2C9C90532A06A3076506C622085C1CD3`
(`vnext_prototype/mttcg_causality/E124-cacheerr/candidate_qemu/`). Canonical unchanged
(`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`); E121/E122 candidates
unchanged (`D7A2896D843FBC6C5386CF57690292A37A4EDFA58A207C4E612E325B879C838C`,
`AA3B7CA65445A6751D28748A4407853B06736AAFE9771405CE9143767B3ED029`).

**B11 restart**: still not attempted this session (out of scope per the task). E124's fix is now
hardened against all three gaps this review set out to close and, in this session's judgment, ready
for a future B11 restart from the CACHEERR side -- the TG1-IntWDT variant remains a separate, open,
already-frozen (DECISION-004) item that will still legitimately show `unexpectedResets>0` at scale.
See DECISION-018 for the recorded semantic-adjacent changes (mask replaces bool, reordering, reset
fix) and EVIDENCE.md E125 for the full account and all 15 mandatory answers.

## Superseded 2026-09-05 (E124, before E125): mechanism 2's CACHEERR variant root-caused and FIXED; TG1-IntWDT
## variant (E111) remains open, untouched, and confirmed still reproducible; B11 restart still not
## promoted this session

**CACHEERR is fixed.** Root cause (reproduced with full register-level detail, not inferred): CPU1
(APP), on its genuine first generation right after passing `call_start_cpu1()`'s `s_resume_cores`
wait, read `g_startup_fn[1]` (DROM0 vaddr `0x3f4049f0`) at the exact virtual instant CPU0 (PRO) --
executing `spi_flash_mmap_init()` -> `spi_flash_disable_cache()`/`spi_flash_restore_cache()`
(`components/spi_flash/cache_utils.c`) -- had just cleared `APP_CACHE_CTRL`'s `CACHE_ENA` bit as
part of its own rapid, repeated disable/restore cycling. Real ESP-IDF's own
`spi_flash_disable_interrupts_caches_and_other_cpu()` documents the assumption being violated:
its scheduler-not-started fast path skips cross-core IPC synchronization because "APP CPU is either
in reset or spinning inside `call_start_cpu1`, which is in IRAM" -- true only up to
`s_resume_cores`; APP CPU's own `ESP_SYSTEM_INIT_STAGE_SECONDARY` functions run concurrently with
PRO's, still before `vTaskStartScheduler()`, so the same unsynchronized fast path still applies
after release. Real hardware apparently never lands this race (the disable/restore sequence is a
handful of instructions); this fork's MTTCG (genuinely concurrent vCPU host threads) can and did.
Fixed by extending the existing `appcpu_stall_req` mechanism (`hw/misc/esp32_dport.c`'s
`esp32_cache_state_update()` + `hw/xtensa/esp32.c`'s `esp32_cpu_stall()`): APP CPU is held exactly
while a *different* core has its cache disabled, released the instant it's re-enabled -- no global
MTTCG serialization, no change to what counts as an illegal access.

**Validated**: 4/4 clean N=8/60s real-firmware runs post-fix (zero CACHEERR, zero unexpected resets
of any kind), `test-esp32-timg-pause` 7/7, `test-vnext-b-classify` 9/9, `vnext_b_attachment_test`
31/31, `mcu_component_live_poll_thread_test` all OK, `session_restart_stress_test` 15/15,
`b11_classify_test.ps1` 30/30, `run_regression.ps1` VNEXT_B+MTTCG 13/13 x2, LEGACY+MTTCG 13/13 x1.
**Gap, explicitly flagged, not silently skipped**: no dedicated synthetic (non-QEMU-process) unit
test was built for this exact race, as the task's own Phase 8 asked for -- RED/GREEN was
established via real-firmware reproduction instead (arguably higher-fidelity, but leaves no fast
regression fixture behind).

**The already-known, separate TG1-IntWDT variant (E111) is untouched and still reproduces** --
found again, unprompted, during this entry's own N=1 smoke test (cascaded through 6 boot_epochs,
`source=SW_CPU_RESET_REGISTER`). This is NOT a regression introduced here; it is the same
mechanism E111 already characterized and already mitigated to its `wdt_time_scale`
DECISION-004-frozen cap, with "no safe further fix available within current constraints" per E111's
own conclusion. Do not conflate it with CACHEERR when B11 is eventually restarted -- both may
produce `unexpectedResets>0` but are structurally distinct (`source=RTC_RESET` vs
`source=SW_CPU_RESET_REGISTER`), and this fix only closes the CACHEERR one.

**B11 restart**: still not attempted this session (out of scope per the task). Both of E123's
teardown fix and this entry's CACHEERR fix are now real prerequisites satisfied for a future B11
restart -- but the TG1-IntWDT variant, if it manifests during a real B11 N=8/N=12/N=16 campaign,
will still legitimately show `unexpectedResets>0` and should be judged against E111's own
already-established, already-frozen conclusion, not treated as a new finding.

New QEMU candidate staged, NOT promoted:
`06558E31CE6F0013C02B8E56B99439F62D016C49A9D24C5DDB052FB2B344D8B0`
(`vnext_prototype/mttcg_causality/E124-cacheerr/candidate_qemu/`). Canonical unchanged
(`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`); E121/E122 candidates
unchanged (`D7A2896D843FBC6C5386CF57690292A37A4EDFA58A207C4E612E325B879C838C`,
`AA3B7CA65445A6751D28748A4407853B06736AAFE9771405CE9143767B3ED029`).

## Superseded 2026-09-05 (E123, before E124): E104/TEARDOWN_HANG FIXED and validated; mechanism 2 captured for the
## first time (refutes the IntWDT hypothesis); B11 restart NOT authorized this session

**E104 is fixed, not just bounded.** Root cause (reproduced with real instrumentation, not
inferred): `QemuProcessManager::start()` created its QEMU log pipe with a plain
`bInheritHandles=TRUE` `CreateProcessW` call, which inherits *every* open inheritable handle in the
Core process, not just the ones each child needs. Under `LASECSIMUL_SCALE_PARALLEL_START=1`
(production topology for N>1), a sibling session's concurrent `CreateProcessW` could inherit a
stray copy of this session's pipe write handle during the brief window before this session's own
`CloseHandle(writePipe)` ran -- leaving `QemuProcessManager::joinReader()`'s `m_reader.join()`
(no timeout) blocked until the sibling's QEMU *also* exited, which is exactly the previously-
hypothesized-but-never-proven E104 hang. Fixed with `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`
(`STARTUPINFOEXW`), which makes only the intended handles inheritable regardless of what else is
open in the parent -- eliminates the race structurally, no serialization needed. Separately,
`VnextBWaitDispatcher::unregister()` was hardened with a real wait-set-drain +
callback-in-flight-drain contract (condition_variable-based, 5s traced timeout backstop) per this
task's own Phase 2 spec -- a real, independently-provable gap the earlier E120/E121 hypothesis
correctly flagged, even though it turned out NOT to be what caused the observed hangs.

**Validated**: N=1 x1, N=2 x3, N=8 x3, real firmware, 60s workload each -- `teardownClean=true` and
zero `TEARDOWN_HANG` in **all 7 of 7**, defensive-timeout/Job-Object backstop never triggered once.
`SessionRestartStressTest` 15/15, `vnext_b_attachment_test` 31/31, `mcu_component_live_poll_thread_test`
all OK, `b11_classify_test.ps1` 30/30.

**B11 restart is explicitly NOT authorized this session.** During the N=8 real-workload validation
above, E122's panic-causal tracer fired for the first time ever (never captured anything across
E122's own 8 bounded attempts) -- per this task's own stop rule, the campaign stopped immediately
rather than proceeding to Phase 7/8. The capture **refutes** the working hypothesis carried over
from E121/E122 ("provavelmente interrupt watchdog"): `tg1_wdt_source20_active=0`, `exccause=7`
(genuine `PANIC_RSN_CACHEERR`, `cache_ia_drom0=1` confirms it), on core 1. `frame->pc` symbolizes to
`call_start_cpu1` (CPU1's own boot entry point) with `a2=0xBAADBAAD` (a poisoned-memory sentinel,
not a plausible address) about to be called through as `g_startup_fn[core_id]` -- at
`virtual_ns≈20.1s`, long past first boot, suggesting this is CPU1 re-booting after an earlier reset
and hitting a genuine cache-illegal-access during that reboot's own bring-up. New lead, not a
conclusion -- not chased further this session. See EVIDENCE.md E123 Phase 6b for the full capture
and reasoning, including the tracer's own known gap (doesn't yet capture the DPORT fault *address*
register, only the status bit).

**Next step, two independent tracks**: (1) B11 can restart from N=1 once mechanism 2 is either
fixed or a deliberate scope decision is made and documented -- the teardown fix satisfies the
prerequisite Phase 8 needed. (2) Mechanism 2: start from `call_start_cpu1`/`g_startup_fn[core_id]`
during a later reboot's CPU1 bring-up; extend the tracer to also read the DPORT cache-debug fault
address register (not just the status bit). Do not combine these two into one investigation.

Canonical unchanged (`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`); E121
candidate unchanged (`D7A2896D843FBC6C5386CF57690292A37A4EDFA58A207C4E612E325B879C838C`); E122
candidate unchanged and still the correct base to build on
(`AA3B7CA65445A6751D28748A4407853B06736AAFE9771405CE9143767B3ED029`) -- E123 touched only Core C++
(`QemuProcessManager.cpp`, `VnextBWaitDispatcher.cpp`, plus opt-in tracing in
`SimulationSession.cpp`/`Scheduler.cpp`/`McuComponent.cpp`/`McuController.cpp`), no QEMU source.

## Superseded 2026-09-05 (E122, before E123): mechanism 2 tracer built and disassembly-proven, did not reproduce

E122 built `LASECSIMUL_PANIC_CAUSAL_TRACE` (`hw/misc/esp32_rtc_cntl.c`), a QEMU-side diagnostic
that reads ESP-IDF's own `XtExcFrame` (exccause/pc/ps/excvaddr/a0-a15/sar) plus the DPORT
INTWDT/CACHEERR disambiguation state directly from guest memory at the SW_SYS_RESET write --
every address/offset/PANIC_RSN value it uses was independently confirmed by disassembling this
session's own `firmware.elf` (not copied from another ESP-IDF version or an older firmware build
-- see EVIDENCE.md E122 Phase 0.5b for the full cross-check, including a correction: the firmware
actually builds via `framework-arduinoespressif32`/Arduino core, not the plain `framework-espidf`
package the task named). **The tracer never fired**: 8 bounded N=8 attempts (64 sessions total,
gate on) reproduced zero unexpected resets. Per the task's own STOP CONDITION C, this session ends
here with the instrumentation proven correct (clean compile, disassembly-matched addresses, zero
behavioral perturbation in both the gate-off smoke test and all 8 gate-on campaigns) but no capture
to report. **Mechanism 2 remains open, exact cause still unproven.**

New candidate staged, NOT promoted: `AA3B7CA65445A6751D28748A4407853B06736AAFE9771405CE9143767B3ED029`
(`vnext_prototype/mttcg_causality/E122-panic-causal-trace/candidate_qemu/`) -- E121's candidate
plus only this diagnostic, safe to reuse as-is for a future continuation. Canonical unchanged
(`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`); E121 candidate unchanged
(`D7A2896D843FBC6C5386CF57690292A37A4EDFA58A207C4E612E325B879C838C`).

**A concrete, falsifiable lead for the next continuation**, found while reading the required
files: a prior, independent, already-CLOSED investigation (E111/E112, `.spec archive/legacy-v2/
lasecsimul.spec` 32.5.1-32.5.22) root-caused a *mechanistically adjacent* reset
(`SW_CPU_RESET_REGISTER`, via `panic_abort()`->`esp_restart_noos()` -- NOT the same ESP-IDF exit
path as E121's `esp_restart_noos_dig()`, confirmed by disassembly they diverge inside
`panic_restart()`) to a **genuine TIMER_GROUP1 Interrupt WDT expiry**, caused by `readReg()`/
`writeReg()` MMIO round-trips occasionally blocking ~1s on `Scheduler::settleUntilStableLocked()`
while a firmware critical section has interrupts disabled -- already mitigated to its policy limit
(`wdt_time_scale` at the DECISION-004-frozen cap of 100x), with E111's own conclusion: "no safe
further fix available within current constraints." **Whoever picks this up next should NOT assume
mechanism 2 is this same mechanism without frame-level proof** (this entry's tracer is exactly the
tool needed to check) -- but should also not be surprised if it is, since if so, the honest
conclusion may again be "no further fix without revisiting DECISION-004," not a fresh emulation
defect to chase. Next step: re-arm `LASECSIMUL_PANIC_CAUSAL_TRACE=1` on the E122 candidate the next
time a B11/B12-style N=8 campaign runs (no rebuild needed), and read the resulting
`[PANIC_CAUSAL_TRACE]` line the moment mechanism 2 recurs. Do not restart the full B11 matrix, run
N=12/N=16/B12/SINGLE_REALTIME/ICOUNT, or attempt E104 before that. See EVIDENCE.md E122 for the
full disassembly-level ground truth (exact `XtExcFrame` offsets, `PANIC_RSN_*` values, the
`xt_highint5` INTWDT/CACHEERR disambiguation logic, the ECO3 livelock workaround) so it does not
need to be re-derived.

## Post-production cleanup hold (user decision, 2026-09-05)

Do **not** delete or prune any of the `C:\SourceCode\qemu*` trees while the current
VNEXT_B+MTTCG investigation, B11/B12 validation, and final production-runtime promotion are still
open.  After a production version is conclusively validated and promoted, perform a separate,
controlled cleanup pass.  Preserve at minimum `C:\SourceCode\qemu_lasecSimul` (the active source
tree) and `C:\SourceCode\qemu_simulide` (the user's reference/model tree).  Before removing the
older investigation worktrees (`qemu_lasecSimul-i2c-fix`, `qemu_patch_verify`, `qemu-a`,
`qemu-audit`, `qemu-d2`, `qemu-d2b`), export any unique source changes as compact patches,
inventory and preserve genuinely unique untracked files (especially under `qemu-audit`), verify
that no evidence document or production manifest depends on them, and remove their Git worktree
metadata safely.  This cleanup is explicitly deferred and must not be mixed into the active
correctness investigation.

Set 2026-09-05 after E121 (below): **correction to E120's own documentation** -- E104's harness
teardown hang is bounded and diagnosed, **not fixed/resolved**. `TEARDOWN_HANG session=N did not
complete stopSimulation() within 15000ms` genuinely fires in real runs (the process exits via the
Job-Object-backed defensive timeout, not a graceful shutdown); any earlier phrasing here or in
TEST_GATES.md implying "teardown resolved" or "zero timeout" was an overclaim, now corrected --
`b11_classify.ps1` has an explicit `teardownClean` field that fails the cell whenever this occurs,
independent of how clean the per-session JSONL data looks.

E121 also root-caused the B11 N=8 stop (E119-AUDIT/E120's own restart) to **two distinct,
source-level-symbolized mechanisms**, not one: (1) a ROM-level, PRO_CPU-only secure-boot anti-glitch
efuse recheck (`_rtc_trigger_sw_system_reset`/`_reload_efuses_and_check`, confirmed via
`xtensa-esp32-elf-objdump` against the real ROM ELF) whose 100ms `QEMU_CLOCK_VIRTUAL` polling delay
had a real, provable defect (`timer_mod_anticipate_ns`'s "never push a pending deadline later"
semantics silently discarding a fresh trigger's own deadline) -- **fixed** (`timer_mod` instead);
and (2) a **newly discovered, NOT fixed** ESP-IDF application-level panic
(`panic_handler`->`esp_restart_noos_dig`, symbolized against the firmware's own ELF), occurring
post-boot with the watchdog already armed, most plausibly (not yet proven) an interrupt-watchdog
timeout under genuine N=8 host contention. A bounded 8×N=8 validation campaign with mechanism 1's
fix applied showed 6/8 clean, 2/8 still affected by mechanism 2 -- **does not meet the zero-
unexpected-reset gate; not promoted**. **No new SHA promoted; canonical unchanged**
(`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`). **Next step: determine
mechanism 2's exact panic reason and either fix it or characterize whether it is in-scope (a real
watchdog timeout under genuine host contention, if that is what it is, may be a host-capacity
question rather than an emulation defect -- not concluded), then restart B11 from N=1 with the E121
candidate** (`D7A2896D843FBC6C5386CF57690292A37A4EDFA58A207C4E612E325B879C838C`, preserved). Not
started in this session. See EVIDENCE.md E121 for the full mechanism, every test result, and the
exact source locations.

Earlier history, preserved: `PLAN_MTTCG_VNEXT_B_CAUSALITY.md` R0-R3c (E109), B10-R
(E110), the SW_CPU_RESET_REGISTER root-cause investigation
(E111/E112/E113/E114 -- **fixed and validated**), a formal audit of E114's
closure (**E114-AUDIT = PASS**, one gap found and closed: unit-test
coverage, new runtime SHA `D93B5046...`), the section-12 2x3 causal
matrix (**E115**), the E116 startup-barrier candidate (8/10 boots), the E117
Core-side race investigation, the E118 backpressure redesign, a formal audit
of E118 that closed two further real gaps but left the promotion gate
blocked (E118-AUDIT), and a second audit that found and fixed the actual
root cause of that block and **promoted a new canonical runtime**
(**E118-AUDIT-2**). There is **no external blocker**: the MSYS2
UCRT64 toolchain is installed, QEMU rebuilds here (see the note below on
using PowerShell, not the Bash tool, to invoke `ninja`/`cc`/any test binary
that spawns QEMU as a child process in this environment -- **E119 reconfirmed this applies to
`run_production_mwdt.ps1` itself too, not just compilers**), and `pio.exe`
(`C:\Users\Administrator\.platformio\penv\Scripts\pio.exe`,
`PLATFORMIO_CORE_DIR=C:\SourceCode\LasecSimul\.piohome`) builds
`guest_i2c_workload` in ~5-16s.

## E119 result -- DECISION-014 audit PASS (7 devices, VNEXT_B); B11 STOPPED at N=8 by a new,
different BQL-release finding in esp32_dport (see EVIDENCE.md E119 for the full mechanism)

Phase 1 (mandatory pre-B11 audit): all 7 DECISION-014 devices proven safe under VNEXT_B+MTTCG by
direct source construction (exactly 2 `cpu_loop_exit_restore()` call sites reachable from any of
them, both BQL-held throughout) plus an empirical concurrent test (`max_concurrent=1` under real
sustained WOULD_BLOCK/replay contention). A real but non-blocking LEGACY-only gap was also found
(6 of 7 devices still call `writeReg()` synchronously from within their own dispatch, and LEGACY's
`arenaTransactionBegin()` does briefly release the BQL there) -- not exercised by B11 or by the
declared production topology, recorded as an open follow-up.

B11 itself reached N=8 and stopped on the first mandatory stop condition (`Blocked re-entrant IO`,
3 of 8 sessions). Root-caused, NOT the E118-AUDIT-2 mechanism: `esp32_dport.c` has no `writeReg()`/
`cpu_loop_exit_restore()` anywhere; the actual cause is `esp32_cache_data_sync()`'s synchronous
`blk_pread()` (up to ~256 calls per cache-enable event) releasing the BQL via QEMU's own
`AIO_WAIT_WHILE` while `esp32.dport`'s dispatch is still "active" -- proven by a lightweight,
unconditional last-entry tracker showing the SAME cpu (0) both setting the guard at
virtual_ns=861018200 and being rejected repeatedly starting 13.1 seconds later. Disabling dport's
reentrancy guard would NOT be safe here (unlike the 7 audited devices) since this path genuinely
releases the BQL. No SHA promoted; canonical unchanged. See EVIDENCE.md E119 for the full
mechanism, the taxonomy classification, and every artifact/SHA.

## E118-AUDIT-2 result -- root cause found and fixed; VNEXT_B+MTTCG canonical runtime PROMOTED

**Root cause of E118-AUDIT's watchdog storm, found by direct log inspection + source-code proof,
not statistics.** Both of E118-AUDIT's failing attempts showed one identical warning at the exact
same position -- immediately after app-cpu-startup, immediately before the first unexpected reset:
`Blocked re-entrant IO on MemoryRegion: esp32.i2c at addr: 0x4`. `softmmu/memory.c`'s generic
per-device reentrancy guard (`mr->dev->mem_reentrancy_guard.engaged_in_io`) is set `true` on entry
to a device's dispatch and cleared only by a plain post-call statement on a *normal* return --
`vnext_b_gpio_write()`'s `WOULD_BLOCK` response, `cpu_stop_current()` + `cpu_loop_exit_restore()`,
is a `siglongjmp` that skips that cleanup unconditionally. The first time this fired from inside
`esp32_i2c`'s own dispatch (a real vCPU's `A_I2C_CTR` write landing when lane 0 was at capacity),
`engaged_in_io` was left stuck `true` for the rest of the process -- every later I2C access was
silently rejected, and the guest's own I2C-driven watchdog recovery path is what produced the
observed reset storm (not host-scheduling contention -- E113's H4 is not implicated here).

**Fixed**: `disable_reentrancy_guard = true` on every device MemoryRegion reachable through
`writeReg()`'s VNEXT_B/`cpu_loop_exit_restore()` path (`hw/i2c/esp32_i2c.c`,
`hw/char/esp32_uart.c`, `hw/gpio/esp32_gpio.c`, `hw/ssi/esp32_spi.c`, `hw/misc/esp32_ledc.c`,
`hw/misc/esp32_sens.c`, `hw/misc/esp32_iomux.c`) -- the same idiom already used elsewhere in QEMU
for comparable cases, safe here because this retry path never releases the BQL, so the cross-vCPU
race the guard defends against cannot occur through it.

**Validated**: 12/12 bounded reproduction attempts clean (0 storms, 0 reentrancy warnings) vs the
pre-fix combined sample of 2 storms in 16; `test-vnext-b-classify` 9/9; `test-esp32-timg-pause`
7/7; full `vnext_b_attachment_test` suite incl. a new "Blocked re-entrant IO" regression guard;
2x VNEXT_B+MTTCG regression 13/13; 1x LEGACY+MTTCG regression 13/13; official Phase 7 gate
**10/10, zero retries, unexpectedResets=0 on every attempt** (using the also-fixed runner, below).

**Also fixed**: the E118-AUDIT gate runner's own pass/fail bug -- `unexpectedResets` was never
part of its `$pass` calculation, so attempts 6 and 10 (9 and 15 unexpected resets) were incorrectly
recorded `"pass": true`. Extracted to a shared, unit-tested `Get-Phase6AttemptClassification`
(`vnext_prototype/mttcg_causality/E118-AUDIT/phase6_gate_lib.ps1` +
`phase6_gate_lib_test.ps1`, 4/4 passing, one case built directly from `attempt_6.err`'s own
shape). The original evidence was re-classified in place, not re-run, to correct the record
honestly.

**Corrected documentation overclaim**: the prior "2/16 vs 0/10... a real rate difference, not
dismissed as coincidence" language is corrected -- that comparison was a signal justifying causal
investigation, not a statistically established rate difference or proof of causation. The actual
resolution came from tracing the first causal event via two exact log matches plus direct QEMU
source-code proof, not from accumulating more runs. See EVIDENCE.md E118-AUDIT-2's own "fact vs.
hypothesis vs. statistical signal vs. causal conclusion" section.

**New, separate, explicitly open finding (not blocking this promotion)**: fixing the stuck-guard
bug exposed a narrower fairness question -- at an artificially tiny, test-only
`LASECSIMUL_VNEXT_B_LANE_DEPTH=2` (not the production default), a real vCPU's now-persistent
`WOULD_BLOCK` retry can out-compete the UART TX bottom-half's own cross-process credit-available
notify often enough to starve it for an extended window. Not reproduced at the production gate's
actual default lane depth (Phase 3's 12/12 clean reproduction above used production settings).
Recorded here as an open item for whoever next touches UART backlog fairness under extreme test
configurations -- not chased in this entry, not a production defect as far as this entry's own
evidence shows.

**PROMOTED.** New canonical: `B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`,
staged at `vnext_prototype/dev_qemu_runtime/qemu-system-xtensa.exe`, hash-verified post-staging and
re-tested directly against that path. Prior canonical `D93B504648B8372A07E69BC5A2F3F5CC1F223452B0
BA92B903A6B624366DB66D` preserved as an explicit rollback copy at
`vnext_prototype/mttcg_causality/canonical_rollback_D93B5046/qemu-system-xtensa.exe`. Every prior
candidate preserved, none deleted. `QEMU_RUNTIME.json` updated.

**Next step: B11, exclusively under VNEXT_B+MTTCG.** Not started in this session, per instruction.
Do not start B12 or the section-12 matrix without B11 first. Do not touch SINGLE_REALTIME or
ICOUNT -- both remain explicitly experimental/diagnostic, with their own separate, still-open,
not-investigated-here findings (SINGLE_REALTIME: a pre-existing CPU0-frozen-PC stall, EVIDENCE.md
E118; ICOUNT: an open `MWDT_SYS_STAGE` reset, EVIDENCE.md E115).

## Environment note (2026-09-05): use PowerShell, not Bash, for anything that spawns a child
process (compilers, test binaries that launch QEMU)

Discovered while building E118: in this session's Bash tool, `cc.exe` (even a trivial one-line
file) and the C++ test harness spawning QEMU both fail silently -- exit code 1 (or QEMU's own
`0xc0000139`), zero bytes on stdout/stderr, `dangerouslyDisableSandbox` does not change this. The
identical commands succeed immediately via the PowerShell tool. Not investigated further (out of
scope for E118) -- just route `ninja`, direct `cc` invocations, and any `*_test.exe` that launches
QEMU through PowerShell from now on.

## E118 result -- VNEXT_B+MTTCG backpressure fixed, gate reaches 10/10; SINGLE_REALTIME finds an
unrelated, pre-existing stall and stops per instruction

Root cause confirmed and fixed: `vnext_b_gpio_write()`/`vnext_b_i2c_submit()`/
`vnext_publish_request()` treated an ordinary full ring (`occupancy == depth`) identically to
genuine corruption (`occupancy > depth`) -- both hard-fatal. Now: `occupancy == depth` returns
`VNEXT_WOULD_BLOCK` (never fatal); a real vCPU blocks itself and retries via
`cpu_loop_exit_restore()` (zero event loss, zero changes needed in any other device file); a
non-vCPU producer (UART's TX BH, `current_cpu==NULL`) never touches a CPU, keeps its unsent
`tx_effects[]` backlog, and is woken by a new `esp32_uart_vnext_credit_available()` notify from
`vnext_b.c`'s existing resume sweep. Only `occupancy > depth` remains fatal (now also wakes Core's
dispatcher via `SetEvent()`, and `vnext_resume()`'s own `artifactState>=2` gate -- which used to
also match the FAILED states 5/6 -- now requires exactly READY/RUNNING). See EVIDENCE.md E118 for
the full contract, the producer audit table, Phase 1's UART on/off causal confirmation (5/5 vs
0/5), and the disclosed narrow limitation (I2C's rare `current_cpu==NULL` mid-transaction
continuation is not yet given UART's full backlog treatment).

**VNEXT_B+MTTCG: 10/10, zero retries** -- `setup_valid`, `workload_pass`, `terminal_clean`, exactly
one `app-cpu-startup`, `submissions>0`, `submissions==completions`, `artifactFatal=0` on every
attempt. **This is the gate E116/E117/E118 existed to close, and it is closed.**

**SINGLE_REALTIME: stopped at attempt 3 of 10** (2 passed first) -- a genuinely different,
pre-existing stall (CPU0 frozen at a fixed PC, `cpu0_pc=0x400dca9f`, for 2s+ of virtual time;
`lane0_write==lane0_read` fully drained, `artifactFatal=0` throughout -- **not** a backpressure or
fatal-marking issue). Confirmed reproducible against the pre-E118 candidate too under the identical
`LASECSIMUL_QEMU_TCG_THREAD=single` scenario, so this is not a regression introduced by this entry.
Per instruction, not chased further: this is a new, separate stop condition (Branch D in the
required taxonomy), recorded and left open. **Do not run ICOUNT, the matrix, B11, or B12.**

Candidates preserved, none promoted: canonical runtime `D93B5046...` unchanged (re-verified by
hash); `81B41E4A...` (E116) and `B463252C...` (E117 QEMU) untouched; new E118 QEMU candidate
`301092D6...` (`vnext_prototype/mttcg_causality/E118-backpressure/fix_candidate_qemu/`); Core
Release `50DD4D41...` (`core/build/Release/`, the shared build-output path -- the prior E117 Core
binary was never archived separately and has been superseded in place, disclosed in EVIDENCE.md
E118 rather than silently lost; fully recoverable from git history). `QEMU_RUNTIME.json` not
updated to canonical, per instruction, pending the SINGLE_REALTIME finding and any further
regression the user requests. The `-accel` composition work (`setAccelProperty()`/
`accelHasProperty()`) remains unvalidated, explicitly deferred, now unblocked by (not blocking) the
MTTCG result above.

## E117 (superseded by E118 above; kept for history) -- Core-side race fixed and unit-tested, but a
second, unrelated QEMU-side bug still causes real INVALID_BOOT

`VnextBAttachment::prepare()`/`activate()` (dispatcher registered, and
`McuController::m_vnextBAttached` set, strictly before `coreEvent` is ever
signaled) closes the specific registration-ordering race hypothesized for
E116 -- proven by trace order and by a 2-test suite (`vnext_b_attachment_
test`), no regressions. Keep this fix; it is real. It did **not**, alone,
close E116's gate: attempt 2 of a bounded Phase 4 reproduction still
produced a real `INVALID_BOOT` (`submissions=0`, `app_cpu_startup_reset`
never reached). Root cause found and precisely located (see EVIDENCE.md
E117): `vnext_b_gpio_write()`'s hard-fatal ring-full branch
(`softmmu/vnext_b.c:350-366`) unconditionally calls `cpu_stop_current()`
without the `cpu`/`owner` context distinction the soft-backpressure branch
20 lines below it already gets right (`vnext_b.c:425-430`) -- when hit from
ESP32 UART's TX bottom-half (`current_cpu==NULL` there, by design, per
E112's own comment in `hw/char/esp32_uart.c`), the stop call silently
no-ops, the triggering write is dropped with no resume path, and because
CPU0's own I2C submissions (`vnext_b_i2c_submit()`) share the exact same
lane-0 ring, every subsequent `Wire.requestFrom()` from the guest is also
silently rejected for the rest of the run. Isolated occurrences appear
tolerated (attempt 1: 7 occurrences, booted fine, 361 submissions); a dense
cluster (attempt 2: 40+ occurrences over ~2.4s virtual time) did not
recover. Do not fix this unilaterally without direction -- it is a new
scope beyond what E117 was chartered to touch, and there is an open design
question (should lane-0 saturation from a non-vCPU producer ever be
session-fatal at all, given it is sometimes transient) that the mechanical
fix alone does not resolve. Do not run Phase 5 (10/10 gate),
SINGLE_REALTIME, ICOUNT, B11, or B12 until this is closed. Candidates
preserved, neither promoted: `81B41E4A...` (E116) and
`B463252C.../1D391F2C...` (E117 QEMU/Core). Canonical runtime unchanged
(`D93B5046...`).

## E116 (superseded by E118 above; kept for history) -- startup barrier needs invalid-boot root cause

The startup-barrier candidate passes its deterministic PRELAUNCH/READY/RUNNING/
`-S` fixture but reached only 8/10 valid VNEXT_B+MTTCG real-firmware boots.
Attempts 5 and 9 had no APP CPU startup reset and zero submissions/completions.
The candidate runtime is preserved outside canonical staging as
`81B41E4ACE35CFD7279AA83E63BEF90480179DA42E8FFA39A67D68DA4D790C2F`.
Investigate this remaining invalid-boot mechanism before running SINGLE_REALTIME,
ICOUNT, B11, or B12; do not hide it with retries.

## E115 result -- section-12 matrix run; E114's fix confirmed across all VNEXT_B modes, but a NEW consistent reset found in VNEXT_B+ICOUNT -- B11/B12 still blocked

Full matrix (6 cells x 5 valid runs, 42 total executions incl. invalid-boot
retries) run after AUDIT_E114=PASS. **Zero `SW_CPU_RESET_REGISTER` storms in
any VNEXT_B cell, any execution mode** (A/B/C: 15/15 valid runs clean) --
E114's fix confirmed to generalize beyond the MTTCG-only validation it
originally received. **But**: cell C (VNEXT_B+ICOUNT) shows a perfectly
reproducible `MWDT_SYS_STAGE=2` reset in **all 5** valid runs, zero variance
-- a different reset source than the storm E114 fixed, specific to the
VNEXT_B+ICOUNT combination (cell F, LEGACY+ICOUNT, is completely clean with
the same mode, ruling out "ICOUNT is reset-prone" generally; cells A/B,
VNEXT_B under other modes, are also clean, ruling out "VNEXT_B is
reset-prone" generally). Not root-caused in this entry -- explicitly out of
scope per the matrix's own stop conditions ("uma correção de código parecer
necessária" / "qualquer célula apresentar reset inesperado consistente" are
both hard stops before B11/B12). Separately, cell D (LEGACY+MTTCG) showed
one (1-of-5) genuine `SW_CPU_RESET_REGISTER=3` occurrence -- LEGACY never
exercises the code E114 fixed, so this is a *different*, residual,
transport-agnostic mechanism, consistent with E111's original pre-E114
finding on a single earlier LEGACY sample; one occurrence isn't enough to
characterize further. Also found, disclosed, and worked around without a
source fix: `LASECSIMUL_QEMU_TCG_THREAD=single` has been silently broken by
an unrelated `LASECSIMUL_QEMU_TB_SIZE`/`McuController.cpp:190-209`
interaction (string-mutation-before-exact-match bug) for as long as both
env vars have been set together across this whole project's test scripts --
worked around in the matrix harness by not setting `TB_SIZE` for
SINGLE_REALTIME cells; `McuController.cpp` itself is unmodified. See
`EVIDENCE.md` E115 (and E114-AUDIT above E114) for full data, every
manifest, and the exact bugs found/fixed in the matrix tooling itself along
the way (schema-fragile CSV appends, non-unique backfill labels).

**B11/B12 remain blocked** -- not just "not yet started" but positively
blocked by findings 2 and 3 above, per the plan's own explicit stop
conditions. The next action is a dedicated root-cause investigation of
finding 2 (VNEXT_B+ICOUNT's `MWDT_SYS_STAGE` reset), using the same
causal-ring-buffer methodology E114 used for the original storm -- not
started here.

## E114 result -- SW_CPU_RESET_REGISTER storm ROOT-CAUSED AND FIXED

The genuine mechanism: `esp32_timg_transport_pause_apply()`
(`hw/timer/esp32_timg.c`) double-compensated a transport pause whenever a WDT
FEED landed between the pause opening and this apply call running (the feed
resets `ws->ns_base` unconditionally, with no knowledge of the open pause).
The old formula re-added the *entire* pause duration on top of an anchor the
feed had already advanced, pushing `ns_base` past the current virtual time.
The next `esp32_timg_wdt_get_count()` call then underflowed (unsigned
subtraction), collapsing the next ARM's computed timeout to ~0ns and firing
the watchdog callback microseconds later instead of at its real, correctly-
computed multi-second deadline -- this is what produced the storm, at both
TG0 and TG1, independent of workload or transport. Confirmed byte-for-byte
via a new causal ring-buffer trace (`LASECSIMUL_WDT_CAUSAL_TRACE`, off by
default) built specifically to capture this. Fixed with a minimal,
producer-agnostic correction (compensate only the pause interval not already
covered by a more recent anchor) plus a defensive backstop in
`get_count()`. Fully validated: 3x15s UART/I2C-isolated (not "zero
transport" -- see EVIDENCE.md E113's terminology correction), 3x15s
baseline, 3x60s baseline all show 0/0/0 unexpected resets; full VNEXT_B+MTTCG regression
13/13 twice, LEGACY+MTTCG 13/13 (after investigating and explaining
pre-existing host-load flakiness on one unrelated test, documented in
EVIDENCE.md rather than dismissed). New canonical QEMU SHA
`6BD9D596FCDF722B8A39094E7F9F7B315903496B59A58A2F410028F57467B4C6`. See
`EVIDENCE.md` E114 for the full causal trace, the exact fix, and every
validation run's numbers.

**This closes the SW_CPU_RESET_REGISTER investigation line (H1-H4 below are
superseded).** What was previously E112/E113's "initiating cause" hunt (was
it UART? I2C? host scheduling?) turned out to be none of those -- it was a
bookkeeping bug in the pause-compensation arithmetic itself, triggerable by
*any* peripheral's lane-0 traffic (UART, I2C, GPIO pin-mux, SPI-flash-
adjacent MMIO all confirmed as possible openers), not a property of any one
workload. Two things remain genuinely open, unrelated to this fix (see
EVIDENCE.md E114's "what remains open"): an intermittent invalid-boot flake
(APP CPU occasionally never reaches its own startup reset, seen before and
after this fix, cause unknown) and a dormant `esp32_timg_wdt_arm()`
prescale-divisor defensive gap (not exercised by any code path today, worth
a small follow-up hardening with its own unit test). The section-12 2x3
matrix and B11/B12 were kept blocked throughout this investigation per
explicit instruction; a future session can now reasonably reconsider
whether the storm-shaped blocker on them still applies, since its root
cause is fixed -- that decision was not made in this entry.

## E113 result -- E112's H1 (UART lane-0 exhaustion) tested directly and refuted; counting errors in E112 corrected (historical -- superseded by E114 above)

A diagnostic control (`LASECSIMUL_UART_DISABLE_CORE_NOTIFY`) was built exactly
to test E112's H1/the user's specific hypothesis: does removing UART's
per-byte VNEXT_B Core notification (while leaving the guest-visible UART FIFO
and local timing untouched) eliminate the storm? On variant 6 (no I2C at all
-- the only firmware where UART is the *sole* possible transport source),
it did not: with `uart_tx_events_published=0` and
`vnext_b_diag_lane0_exhaustion_count=0` confirmed for the entire run (i.e.
zero VNEXT_B lane-0 traffic from any source), the watchdog storm persisted at
the same order of magnitude it had with the notification enabled. **H1, as
specifically stated, is refuted.** See EVIDENCE.md E113 for the full data,
the counters added to make this testable cheaply (no per-event logging), and
the new falsifiable hypothesis this opens (H4: intrinsic MTTCG host-CPU/
scheduling cost of the guest's own instruction stream, not any transport
mechanism -- testable with the existing `LASECSIMUL_MWDT_ACCOUNTING`
wait-accounting infrastructure, not yet exercised together with this
investigation's other gates).

E113 also corrects three counting/scoping errors E112 had:
`SW_CPU_RESET_REGISTER` tagged `expected=app-cpu-startup` (and the one-time
`count=1 source=OTHER` cold-boot line) were being counted as "storm" resets;
once excluded, variant 3's reported "1/1/1 residual floor" is actually 0/0/0.
Variant 6's three 60s confirmation runs were not three valid measurements --
run2 never got the APP CPU to boot at all (invalid execution, not "0
resets"). The E112 sweep also ran with `LASECSIMUL_CACHE_TRACE=1` active,
confounding it with the same heavy instrumentation E111 had gated off;
baseline/variant2/variant6 have now been spot-checked with the trace off
(E113) though not yet at the full 3x60s scale for variant 2 specifically.

The `[LANE0_DIAG]` snapshot instrumentation built for this test was
originally scoped to fire only for TIMER_GROUP1 (the Interrupt WDT), on the
assumption -- inherited uncritically from E111 -- that this storm is
exclusively a TG1 phenomenon. It is not: re-checking E111's own reference
evidence shows `timg_wdt_expire` firing on **both** TG0 and TG1 in the same
run (majority TG0, in fact). The gate now fires for both groups. This means
**E111's causal-chain write-up ("byte-for-byte... TG1 Interrupt WDT
expires...") was itself built on a cherry-picked single instance of its own
evidence, not the full picture** -- worth keeping in mind when reading E111
directly; E113 is the more complete account of what that evidence actually
shows.

## E111/E112 result -- reset mechanism proven, initiating cause narrowed but E112's H1 refuted by E113, see above

The `SW_CPU_RESET_REGISTER` storm E110 found is **the genuine TIMER_GROUP1
Interrupt Watchdog timeout mechanism a prior, independent, 22-round
investigation already fully diagnosed** in
`.spec/archive/legacy-v2/lasecsimul.spec` sections 32.5.1-32.5.22
(2026-07-26/28): a real Interrupt WDT expiration gets mislabeled "Cache
error" by a shared-interrupt-line disambiguation quirk in ESP-IDF (the
`DPORT_PRO/APP_INTR_STATUS_0` register that quirk depends on **is** modeled
in the current tree, `esp32_dport.c:456-459` -- E111 wrongly described this
as still-missing, corrected in EVIDENCE.md); the WDT expires because a Core
round-trip (register read/write reflecting the electrical sim) occasionally
coincides with a firmware critical section, and under `mttcg-realtime` that
occasional real-time stall exceeds the Interrupt WDT's budget. Two
mitigations from that investigation are already present and already at their
limit: `Scheduler::markDirty()`'s non-blocking publish (committed) and
`wdt_time_scale` at its **DECISION-004-frozen cap of 100**.

**E112 ran the actual factorial experiment E111 had only hypothesized about**
(`guest_i2c_workload/src/main.cpp` was already in this repo -- nothing needed
obtaining). Six firmware variants (I2C cadence x Serial verbosity x no-I2C
controls), each built and SHA-preserved separately under
`vnext_prototype/mttcg_causality/E112-factorial-firmware/`. Headline result:
**Serial/UART call frequency, not I2C polling cadence, is the dominant
driver** -- reducing only Serial output (same I2C cadence) dropped resets
from 10 to 1 in a 20s window; heavy Serial with **zero I2C traffic at all**
reproduced the full storm (up to 10 resets) at least once in 3x60s
confirmation, though with much higher run-to-run variance than the
I2C-bearing baseline's rock-solid 10/10/10/10 -- meaning I2C is a real
secondary contributor, not irrelevant noise. E111's LEGACY-vs-VNEXT_B
comparison (2 vs 10 resets, one sample each) proved the mechanism is
transport-agnostic but was overclaimed as "ruling out" VNEXT_B
amplification -- corrected in EVIDENCE.md; that question is still open and
E112 did not test it (it varied firmware load, not transport). See
EVIDENCE.md E111 (byte-for-byte `timg_wdt_expire` -> `intmatrix_line26`
(source=20) -> `reset_cpu_sw` chain) and E112 (the factorial data and its
three falsifiable next hypotheses: H1 a UART-model round-trip in
`hw/char/esp32_uart.c`, H2 I2C's independent secondary contribution, H3 a
proper bounded-history Scheduler-settle correlation instead of E112's
inconclusive single-max attempt).

**Along the way**: a second, previously-undocumented always-on diagnostic
block (`target/xtensa/exc_helper.c`'s `[XTENSA-EXC-TRACE]`/`[XTENSA-PC-WATCH]`,
alongside the already-known `[CACHE-TRACE]` in `esp32_dport.c`) was found and
gated behind `LASECSIMUL_CACHE_TRACE` (DECISION-013) -- confirmed to not be
the cause (3 clean baseline runs with the gate off reproduced the storm
identically, actually slightly higher than the traced runs), but worth
keeping gated regardless of that negative result.

## B10-R result (E110) -- superseded by E111 above for causal interpretation

The SW_CPU_RESET_REGISTER storm was still present under genuine VNEXT_B+MTTCG
with real firmware after R3 -- reduced ~92% from E108's original 89
resets/60s down to 7/60s, but not gone. E110's own framing of this as "a
separate, software-driven APP-CPU reset-register write loop" was a premature
generalization from a single run -- E111 above supersedes that with the full
causal chain. E110's raw measurements (the reset counts, the Debug/Release
build divergence, the `execution=...` diagnostic-string bug) remain valid.
Two build-process gotchas surfaced: `core/build/Release/vnext_b_production_scale_test.exe`
was stale (rebuild it before trusting any number from it), and Debug vs
Release genuinely diverge in reproducing the storm at the same duration
(Debug: none; Release: 7-10/60s) -- **use Release for any further work in
this area**, matching `run_production_mwdt.ps1`'s own convention. Full detail
in EVIDENCE.md E110/E111.

## Where we are

- The original MWDT plan's Fase A/B (E108) closed the "3 pre-existing failing
  tests" problem and delivered diagnostic-only MWDT wait-accounting
  instrumentation, gated off by default.
- `orchestrator/.ai/PLAN_MTTCG_VNEXT_B_CAUSALITY.md` phases **R0 through R3c
  are executed and closed** (E109): explicit transport/execution-mode in the
  harness, thread-safe lazy-init hygiene, a unit-tested temporal-merge
  arbiter replacing VNEXT_B's lane-index-biased consumption, and a
  pacing-only heartbeat watermark (DECISION-012) proving virtual-time
  advancement for legitimately silent guests. **B0.1 is CLOSED**
  (`TEST_GATES.md`): three independent VNEXT_B+MTTCG regressions and one
  LEGACY+MTTCG regression, all 13/13.
- Along the way, R1's explicit `-Transport VNEXT_B` forcing surfaced (and
  this session fixed) several pre-existing test/transport mismatches --
  4 real-QEMU tests had never been exercised against VNEXT_B before. One
  genuine capability gap was found and left unfixed (out of R3's scope):
  **VNEXT_B has no gateway/TAP-unavailable degrade-to-SLIRP fallback**,
  unlike LEGACY (`McuController.cpp` ~lines 311-324, structurally
  unreachable after VNEXT_B's early return in `start()`). See E109 for the
  full list.
- Also unresolved, explicitly out of R3's scope: `McuSchedulerPacingSyncRealQemuTest.cpp`'s
  `booted` check is now transport-aware and correct (E109); this note in
  earlier drafts about it being an open cosmetic bug is superseded.

## Next action, in order — the storm is fixed; remaining items are lower-priority follow-ups, then the 2x3 matrix, then B11/B12

Per the plan's own section 13 gate ("não avançar para a matriz B11 enquanto
B0.1 e o smoke B10-R não estiverem fechados") -- **B10-R (E110) and the
SW_CPU_RESET_REGISTER root-cause investigation are CLOSED as of E114**: the
double-compensation bug in `esp32_timg_transport_pause_apply()` is found,
fixed, and validated (0/0/0 unexpected resets across 9 short runs + full
regression). H1 (UART lane-0 exhaustion, E112/E113) and H4 (host-scheduling
cost, E113) are both superseded -- neither was the actual cause, which was
a pause-compensation arithmetic bug independent of workload or transport.

1. **(Optional, low priority) E112's H2**: repeat variant 2 (I2C present at
   ~1ms, Serial reduced to ~1/s) at 3x60s on the E114-fixed runtime -- now
   that the arithmetic bug is fixed, this would characterize any remaining,
   genuinely-load-driven watchdog interrupt rate (not resets -- E114's own
   3x60s baseline runs already show occasional genuine `WDT_MODE_INT`
   interrupts that the firmware correctly feeds) rather than search for an
   initiating cause, which is no longer the open question.
2. **(Optional, low priority) E112's H3**: the Scheduler-settle
   bounded-history correlation was never implemented; still a reasonable
   general-purpose diagnostic to have, but no longer motivated by an open
   causal question.
3. **(Small, well-scoped) harden `esp32_timg_wdt_arm()`'s prescale divisor**:
   E114's static audit found it uses `ws->prescale` directly instead of
   `MAX(ws->prescale, 1)` like `get_count()` -- dormant today (reset value
   decodes to prescale=1, nothing in this fork writes a literal 0), but a
   real defensive gap. Small fix, needs its own unit test, not urgent.
4. **(Separate, unrelated) intermittent invalid-boot flake**: the APP CPU
   occasionally never reaches its own startup reset at all (seen in E113's
   variant6/run2 and repeatedly in E114's own Phase 3 attempts, before and
   after the fix). Not a storm event, not caused by this fix, cause unknown
   -- worth its own investigation if it recurs often enough to matter.
5. **Section-12 2x3 causal matrix** (VNEXT_B/LEGACY x MTTCG/single-realtime/
   icount, A-F cells, >=5 interleaved blocks, rotated cell order per block,
   never run in parallel). This is the plan's own primary deliverable for
   its stated objective (determine whether resets/stalls come from MTTCG
   concurrency, clock-domain change, or VNEXT_B consumer defects) -- distinct
   from B11's scale matrix, and not yet started. Expect this to be a
   substantial, multi-hour real-QEMU measurement campaign; budget a session
   for it specifically rather than folding it into other work. This
   investigation kept the matrix and B11/B12 blocked throughout per explicit
   instruction; now that the storm's root cause is fixed, a future session
   can reasonably decide whether that block still needs to hold -- not
   decided in this entry.
6. **B11/B12**: resume the original N=1/8/12/16 MWDT scale matrix only after
   5 is closed by this document's own gates.

## Rules for these runs

- Traces off (E099: ~2 s per emitted line).
- Constrain priority and affinity -- the runners do it for you (DECISION-010).
- Every scale result carries a validity arm (DECISION-008).
- Allow for the ~7 s per-instance QEMU construction cost (E100).
- This host's timing-sensitive tests are measurably perturbed by concurrent
  load and by long unbroken sequences of heavy real-QEMU runs. E109 hit a
  4-run failure streak that looked like host-load noise but was actually a
  **stale incremental link** against the shared test-support static lib
  (`lasecsimul_test_common.lib`) after a targeted `--target <name>` rebuild;
  a full untargeted `cmake --build core/build` resolved it immediately. If a
  real-QEMU test fails in a way that doesn't implicate the source you just
  changed, do a full rebuild before spending time on host-load theories.
- Don't chain heavy real-QEMU runs back-to-back without a few seconds' gap
  and a stray-process check between them.
- Before trusting any `vnext_b_production_scale_test.exe` result, rebuild
  the config you're about to use (E110 found the Release build stale by a
  full day's worth of R0-R3c source changes) and confirm the actual `-accel`
  value in the `final argv:` log line -- the `[LasecSimul] execution=...`
  diagnostic line has an unresolved bug (E110) where it can claim
  `single-realtime` even when the real argv used `tcg,thread=multi`.
- Use the **Release** build specifically for anything touching the
  SW_CPU_RESET_REGISTER storm (E110: Debug did not reproduce it at all in a
  matched N=1/60s comparison, Release did, 7-10/60s).
- The QEMU fork carries prior investigation instrumentation
  (`[CACHE-TRACE]`/`[XTENSA-EXC-TRACE]`/`[XTENSA-PC-WATCH]`) gated behind
  `LASECSIMUL_CACHE_TRACE` (DECISION-013, E111) -- off by default, matching
  the other diagnostic gates. Turn it on deliberately (one run at a time) if
  investigating a reset chain; it writes 1.5-2MB+/process to `C:/tmp` when
  on, so don't leave it on for a full regression/matrix run.

## Also open, in rough priority order

1. **SW_CPU_RESET_REGISTER -- CLOSED (E114)** / section-12 matrix / B11-B12
   -- see above. The storm's actual cause was a double-compensation
   arithmetic bug in `esp32_timg_transport_pause_apply()`, fixed and
   validated. Not UART, not I2C, not host-scheduling cost -- those were all
   correlated symptoms (anything generating lane-0 traffic could open the
   pause that triggered the bug), not the mechanism itself. Only the matrix/
   B11-B12 gate and the two small unrelated follow-ups above remain.
2. **McuController.cpp's execution-mode diagnostic-string bug** (E110): the
   logged `execution=...` line can read `single-realtime
   (LASECSIMUL_QEMU_TCG_THREAD=single override, no -icount)` even when
   `LASECSIMUL_QEMU_TCG_THREAD` is confirmed absent from the process
   environment and the actual QEMU argv used `tcg,thread=multi`. Cosmetic
   (doesn't affect the real launch), reproduced specifically on
   `vnext_b_production_scale_test.exe`; not yet root-caused. Low priority,
   but worth fixing before it misleads a future evidence-gathering session.
3. **VNEXT_B gateway/TAP fallback capability gap** (E109) -- LEGACY degrades
   to isolated SLIRP when the configured gateway/TAP is unavailable; VNEXT_B
   has no equivalent and would instead attempt to connect to the
   unavailable backend directly. Not exercised by any current production
   path finding (network mode defaults to `disabled`), but worth deciding
   whether to implement before VNEXT_B fully replaces LEGACY.
4. **Harness teardown hang** (E104). `vnext_b_production_scale_test` never
   exits for more than one session; it blocks in `stopSimulation()` at
   `VnextBProductionScaleTest.cpp:697`. Pre-existing, reproduced on the
   pre-patch binary. It does not affect measurements, but it makes the harness
   unusable unattended.
5. **Attribute the ~7 s `qemu_init` cost** (E100) and test whether 16 x 7 s of
   serial machine construction explains the historical `ADMISSION_1` timeouts.
   Add a per-session "QEMU ready" timestamp to the harness diagnostic.
6. **Explain the backpressure rate.** ~400 lane-credit exhaustions per second
   at one session, but none at all at eight (E105). That inversion is odd and
   was not investigated.

## Current next action after E140 (2026-09-08)

Do not run B12 or promote yet. E139's ROM/EFUSE interlock remains implemented
and causally validated, but the separate E139/E135 post-boot signature still
does not have an initiating cause captured. E140 added only an opt-in diagnostic
cause latch and proved that the signature did not recur in the bounded
validation window.

E140 formal status:
`NO_RECURRENCE_IN_THREE_VALID_N16_WITH_MINIMAL_LATCH`.

Preserved identities:

- E139 baseline candidate:
  `8F7F7A334FFA17A6B8FC080EB75F70BD9D85EBECFB3F07A1BCC2A6995BF612AD`.
- E140 diagnostic candidate:
  `8F47106B4ED949576DF8D76501997ECAE86C095894501B51F8D3CA6B8153FF69`.
- Canonical rollback runtime:
  `B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`.
- `QEMU_RUNTIME.json` unchanged:
  `ADF0D79B9E533E17A3F8CA62FD890B1867973FBB1AFF1C95239142D03644B369`.

Next safe choices are:

1. Review E140 and decide whether the diagnostic latch should remain as a
   reviewable candidate, be adjusted, or be removed before any promotion path.
2. If another post-boot reset recurs, classify from the first
   `[POSTBOOT_CAUSE_LATCH]` event and sequence, not from late panic/restart
   PCs alone.
3. If proceeding toward B12 later, use only an explicitly approved runtime
   candidate and keep the canonical rollback intact until the promotion review
   authorizes replacement.

Do not classify the historical E139 session-7 failure as ROM/EFUSE, CACHEERR,
or WDT without a first-cause record. Do not retry long B11 campaigns blindly.

## E147-J candidate status (2026-09-10)

The VNEXT-B I2C continuation fix is implemented in the QEMU candidate
`920D6E4DE78825A776E8EA3E4A5E8E1A8DF3F43393E271DAA9BA934A165AA0BF`.
It splits the 32-byte guest write that exceeds the 32-byte mailbox once the
address byte is included, preserving command completion until the final
logical STOP. II1P04 now reaches a live OLED in repeated VNEXT-B runs.

Current validation: QEMU/Core focused tests pass; session restart is 15/15;
VNEXT-B+MTTCG Release regression is 14/14; B11 N=1 and N=8 (15 s and 60 s)
pass with zero unexpected resets and zero orphans. The canonical runtime
remains `475C0FC9...` and was not promoted. Candidate SHA is not production
until the package gate has run with the CI-provided GHDL runtime and a separate
promotion review authorizes replacement.
