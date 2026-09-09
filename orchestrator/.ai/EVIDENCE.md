# EVIDENCE LOG

## E138 — E137 reclassified as E121 ROM/EFUSE boot reset, E135 not reproduced (2026-09-08)

**REQUEST_ID:** `E138-rom-efuse-classification-20260908`.

**RESULT:** `REVIEW_REQUIRED — E138_ROM_EFUSE_ROOT_CAUSE`.

**REPORT:** `C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E138-rom-efuse-classification_20260908_055000\E138_rom_efuse_classification_report.md`.

**SUPERSEDES:** E137's previous broad classification as panic/CACHEERR
recurrence. Correct classification:
`E137_CAPTURED_E121_ROM_EFUSE_BOOT_RESET — E135_POST_BOOT_PANIC_NOT_REPRODUCED`.

**IDENTITY:** candidate under investigation was used directly and not promoted:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\candidate_qemu\qemu-system-xtensa.exe`
SHA-256 `3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`.
Canonical rollback runtime remained
`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`.
Production firmware identities were preserved: `merged.bin`
`1DA8BF731830B2D2D9CE6EDBB0EA208636A1DB2A79497A8DB0CC98D72864C76A`,
`firmware.elf` `1697587B58F9DF862765ADABC2F5A2E74387863438D8A6DF775196A542C9D9B6`.
`QEMU_RUNTIME.json` stayed intact.

**RUNTIME:** B11 N=16 was executed with only
`LASECSIMUL_RTC_SYS_RESET_CAUSAL_TRACE`. The run failed fail-closed with
`classifier_cellPass_false`, 16/16 JSONL, workload pass in all sessions,
`totalUnexpectedResets=2`, and red session 14/PID 6588. There were zero
`CACHEERR`, zero `Guru`, zero panic/cache/WDT trace lines, clean teardown, and
zero QEMU orphans.

**CAPTURED_RED:** the terminal RTC trace captured CPU0 at `pc=0x4000fdcd`,
`boot_epoch=1`, `efuse_cmd_reg_at_last_trigger=0x1`,
`efuse_conf_reg_at_last_trigger=0x5aa5`, `efuse_cmd_reg_live=0x0`,
`efuse_read_trigger_count=3`, `efuse_timer_fired_count=2`,
`efuse_last_trigger_virtual_ns=721898800`, and
`virtual_ns_since_efuse_trigger=335134300`. The reset that followed was
`RTC_RESET` with `pc0=0x4000fdd0`, `pc1=0x40000400`, `wdt0=0`, `wdt1=0`, before
APP CPU startup. This matches E121 ROM/EFUSE mechanism 1, not E135 post-boot
panic.

**ROM_SOURCE:** disassembly of `esp32_rev300_rom.elf` confirms
`_reload_efuses_and_check` at `0x4000fc90`,
`_rtc_trigger_sw_system_reset` at `0x4000fdc7`, write to `SW_SYS_RESET` at
`0x4000fdcd`, `memw` at `0x4000fdd0`, and three calls to
`_reload_efuses_and_check` from `_ResetHandler_efuse_check_patch`.

**EFUSE_SOURCE:** current `esp32_efuse.c` writes `cmd_reg=EFUSE_READ` in
`esp32_efuse_read_op()`, clears it only in `esp32_efuse_timer_cb()`, and starts
the operation timer with `timer_mod()`. The prior E121 change from
`timer_mod_anticipate_ns()` to `timer_mod()` is confirmed but does not close the
whole ROM/EFUSE mechanism because E137/E138 still reproduce it. The source also
contains `interval_ns = 100000000` with comment `10 ms`; the literal is 100 ms,
so the comment/literal mismatch is proven, but the correct ESP32-classic
duration is not yet proven by a strong source.

**CLASSIFICATION:** E137/E138 do not prove CACHEERR, TG1, cache-wait, WDT math,
transport, UART/I2C, scheduler, host generic, panic-handler failure, or lost
panic frames. `g_exc_frames=NULL` is expected for direct ROM reset. Exact
sub-branch inside `_reload_efuses_and_check`, per-call RDATA, and the correct
EFUSE operation duration remain pending. No semantic correction was made.

## E137 — directed B11 N=16 recurrence reproduced with panic-only trace, frame unproven (2026-09-08)

**REQUEST_ID:** `E137-cacheerr-signature-recurrence-20260908`.

**RESULT:** `B11_N16_PANIC_RESET_RECURRENCE_REPRODUCED_FRAME_UNPROVEN_REVIEW_REQUIRED`.

**REPORT:** `C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E137-cacheerr-signature-recurrence_20260908_053314\E137_classification_report.md`.

**IDENTITY:** candidate under investigation was used directly and not promoted:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\candidate_qemu\qemu-system-xtensa.exe`
SHA-256 `3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`.
Canonical rollback runtime remained
`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`.
Production firmware identities were preserved: `merged.bin`
`1DA8BF731830B2D2D9CE6EDBB0EA208636A1DB2A79497A8DB0CC98D72864C76A`,
`firmware.elf` `1697587B58F9DF862765ADABC2F5A2E74387863438D8A6DF775196A542C9D9B6`.

**STATIC_AUDIT:** `LASECSIMUL_WDT_CAUSAL_TRACE` also gates
`[WDT_CAUSAL_TRACE][LANE0_EXHAUSTION_PRODUCER]` synchronous `fprintf/fflush`
inside VNEXT_B backpressure handling, so E136's dual-trace campaign may have
perturbed timing. E137 therefore used only `LASECSIMUL_PANIC_CAUSAL_TRACE`.
`PANIC_CAUSAL_TRACE` remains terminal-only at reset trigger sites. The current
E129 cache-wait predicate in `esp32_cache_access_should_wait()` waits only for
APP CPU accessing APP-owned DROM0/IRAM0 with the corresponding bit already set
in `appcpu_cache_externally_disabled_mask`; PRO, unattributed access, region bit
0, and regions not externally disabled fall through to legitimate illegal access.

**RUNTIME:** preflight found zero QEMU processes and confirmed exact candidate,
canonical, firmware, harness, runner and `QEMU_RUNTIME.json` identities. Attempt
1 was clean PASS: 16/16 dumped/JSONL, `B11_CELL_PASS=True`,
`RUNNER_PASS=True`, zero unexpected resets, zero `CACHEERR`/`Guru`/panic trace,
clean teardown, zero orphans. Attempt 2 was the first red and the campaign
stopped: 16/16 dumped/JSONL, `RUNNER_PASS=False`,
`failureReasons=["classifier_cellPass_false"]`, `cellPass=false`,
`sessionsWorkloadPass=16`, `totalUnexpectedResets=4`, clean teardown, zero
orphans.

**CAPTURED_RED:** attempt 2 sessions 6/PID 3120 and 14/PID 15540 each had valid
workload (`submissions==completions>0`, `artifactFatal=false`) and two
unexpected resets. In both, the terminal trace fired on `SW_SYS_RESET` before an
unexpected `RTC_RESET` (`pc0=0x4000fdd0`, `pc1=0x40000400`, `cause0=3`,
`cause1=3`, `wdt0_enabled=0`, `wdt1_enabled=0`), followed by an unexpected
`SW_CPU_RESET_REGISTER` in boot epoch 2. Both dumps reported
`g_exc_frames=NULL` for core 0 and core 1, `int_wdt_app_cpu_ticked=0`,
`lx_intr_livelock_counter=0`, `lx_intr_livelock_max=0`,
`app_cache_ctrl=0x00000000`, `app_cache_ctrl1=0x00000000`,
`app_drom0_mem_enabled=0`, `app_drom0_illegal_access_trap_en=0`,
`cache_ia_int_en_reg=0x00000000`, `g_startup_fn1_mmu_entry_raw=0x200`, and
`app_cpu_reset_generation=1`.

**CLASSIFICATION:** this is a real B11 N=16 recurrence of the unexpected
panic/reset cascade signature under the candidate, without WDT-trace
perturbation. It does **not** prove the original frame as `CACHEERR`: no
`exccause`, pseudo-excause, CPU frame, EPC/PC, vaddr, cache-IA status, or exact
E129 predicate failure was preserved. The literal `CACHEERR` occurrences in the
attempt-2 log are only explanatory text in the `g_exc_frames=NULL` tracer line,
not an observed exception record. No semantic correction was made.

**NEXT_BOUNDARY:** review should authorize only a bounded, opt-in, memory-ring
diagnostic around cache disable/access/wait/release/reset if more evidence is
required. Do not promote, run B12, alter `QEMU_RUNTIME.json`, touch canonical
runtime, increase watchdog scale, mask resets, relax classifiers, alter
cache/watchdog/reset/transport/scheduler semantics, cleanup, commit, push, tag,
package or release.

## E136 — rare B11 N=16 panic not reproduced with causal traces (2026-09-07)

**REQUEST_ID:** `E136-b11-n16-rare-panic-classification-20260907`.

**RESULT:** `LOW_RATE_ANOMALY_NOT_REPRODUCED_REVIEW_REQUIRED`.

**REPORT:** `C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E136-b11-n16-panic-classification_20260907_220542\E136_classification_report.md`.

**ORIGINAL_OFFLINE_RECONSTRUCTION:** E135 B11 N=16 session 0 / PID 15044 had
`submissions=4380`, `completions=4380`, `workloadPass=true`,
`artifactFatal=false`, `drainComplete=true`, `unexpectedResets=2`. Reset
chronology was cold boot, expected APP CPU startup reset, unexpected
`RTC_RESET` with `pc0=0x400dca9f` and `pc1=0x40082c2c`, then unexpected
`SW_CPU_RESET_REGISTER` with `pc0=0x40082edd` and `pc1=0x40000400`.

**SYMBOLIZATION:** using firmware ELF SHA
`1697587B58F9DF862765ADABC2F5A2E74387863438D8A6DF775196A542C9D9B6`,
`0x400dca9f` maps to `panic_handler`, `0x40082c2c` to
`esp_restart_noos_dig`, and `0x40082edd` to `start_other_core` inlined by
`call_start_cpu0`. The formal failing run had no causal trace enabled, so the
pre-panic Xtensa `exccause`, `pseudo_excause`, interrupt source and cache/MMU
state remain unknown.

**TRACE_AUDIT:** source confirms gated `LASECSIMUL_PANIC_CAUSAL_TRACE` coverage
for `SW_SYS_RESET`, second/subsequent `SW_APPCPU_RESET`, and `SW_PROCPU_RESET`;
and gated `LASECSIMUL_WDT_CAUSAL_TRACE` for TG0/TG1 FEED, CONFIG, ARM,
callback, timeout, scale, count and deadline. Deterministic tests passed:
`test-esp32-panic-trace-gate` 6/6, `test-esp32-timg-wdt-scale` 13/13, and
`test-esp32-timg-pause` 7/7.

**REPRODUCTION:** ran candidate QEMU directly, not promoted, with B11 N=16,
60s, `ReserveCores=6`, `Force`, real firmware, `VNEXT_B+MTTCG`, and only
`LASECSIMUL_PANIC_CAUSAL_TRACE` plus `LASECSIMUL_WDT_CAUSAL_TRACE` enabled.
Attempts 1, 2 and replacement attempt 4 were valid PASS runs: 16/16 sessions,
16/16 structured results, zero unexpected resets, zero panic traces, zero WDT
expiry ring dumps, clean teardown. Attempt 3 is preserved but not counted as a
valid rare-panic reproduction because one session did not reach app-cpu startup
or workload, with zero unexpected resets.

**IDENTITY:** candidate SHA
`3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`; canonical
runtime remained `B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`;
`QEMU_RUNTIME.json` remained
`ADF0D79B9E533E17A3F8CA62FD890B1867973FBB1AFF1C95239142D03644B369`; firmware
`merged.bin` remained `1DA8BF731830B2D2D9CE6EDBB0EA208636A1DB2A79497A8DB0CC98D72864C76A`.
Zero QEMU processes remained.

**CLASSIFICATION:** original event remains
`GUEST_PANIC_RESET_CASCADE_UNCLASSIFIED`; E136 result is
`LOW_RATE_ANOMALY_NOT_REPRODUCED_REVIEW_REQUIRED`. No semantic change was made.

## E135 NOT_APPLICABLE fix — promotion rolled back at real B11 N=16 red (2026-09-07)

**REQUEST_ID:** `E135-not-applicable-fix-runtime-promotion-20260907`.

**RESULT:** `PROMOTION_ROLLED_BACK — FIRST_REAL_POST_PROMOTION_RED_B11_N16`.

**REPORT:** `C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\E135-gate-executor_20260907_181428\E135_not_applicable_fix_and_promotion_attempt_report.md`.

**MINIMAL_TEST_CHANGE:** only
`C:\SourceCode\LasecSimul\core\test\core\mcu\McuControllerRealQemuTest.cpp`
was changed: the VNEXT_B LEGACY-only gateway/TAP fallback message changed from
`PULADO:` to the structured marker
`NOT_APPLICABLE: test=mcu_controller_real_qemu_test subcase=legacy_gateway_tap_fallback reason=transport_vnext_b`.
Final source SHA256:
`786C34420C51E22B8638793C94E05EC9AC6AC3289EB011F3BFFC603AC4662B95`.

**EXECUTOR:** E135 executor remains fail-closed for `SKIP:`, `SKIPPED:` and
`PULADO:`. It permits only the exact marker above, exactly once, only for the
`mcu_controller_real_qemu_test` gate under `VNEXT_B`. Final executor SHA256:
`501470CC413937227B6EC26E64D563E8096B7AD76C070F3F9208770D136C3381`.
Self-test `selftest_notapp2` passed 17 synthetic cases.

**BUILD:** rebuilt only target `mcu_controller_real_qemu_test` in Release.

**PRE_PROMOTION_PASS:** direct `mcu_controller_real_qemu_test` against candidate
`3D951D7C...` passed; official `VNEXT_B+MTTCG` regression passed 14/14 against
candidate through the executor; B11 N=1 oracle check against candidate passed.

**PROMOTION_ATTEMPT:** final promotion directory
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\runtime-promotion_E135_final_20260907_192655`.
Canonical was temporarily promoted from
`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E` to
`3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`, and
`qemu --version` exited 0.

**POST_PROMOTION_PASS_BEFORE_RED:** through canonical SHA `3D951D7C...`,
`test-esp32-timg-wdt-scale` passed TAP 13, `test-esp32-timg-pause` passed TAP
7, `test-vnext-b-classify` passed TAP 9, `vnext_b_attachment_test` passed,
`session_restart_stress_test` passed 15 cycles, the official `VNEXT_B+MTTCG`
regression passed 14/14, and B11 N=1 passed.

**FIRST_REAL_RED:** B11 N=16 failed in
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\E135-gate-executor_20260907_181428\final_post_B11_N16`.
The runner used QEMU SHA
`3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`, dumped
16/16 sessions, wrote 16/16 JSONL sessions, and reported `MWDT_ATTRIB_RESETS =
0`, but `B11_CELL_PASS = False` and `RUNNER_PASS = False` due to
`classifier_cellPass_false`.

Session 0 / PID 15044 had `setupValid=true`, `appCpuStartupCount=1`,
`submissions=4380`, `completions=4380`, `artifactFatal=false`,
`blockedReentrantIo=false`, `workloadPass=true`, `drainComplete=true`, and
`unexpectedResets=2`. Its reset log shows an expected app-cpu startup reset,
then unexpected `RTC_RESET`, then unexpected `SW_CPU_RESET_REGISTER`. The other
15 sessions passed.

**ROLLBACK:** rollback executed immediately. Current canonical SHA is
`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`;
`QEMU_RUNTIME.json` SHA is
`ADF0D79B9E533E17A3F8CA62FD890B1867973FBB1AFF1C95239142D03644B369`; zero QEMU
processes remain.

**SCOPE_NOT_DONE:** no production QEMU/Core semantics, firmware, ABI, transport,
watchdog, cache-wait, backpressure, CMake fallback path, vendored runtime,
cleanup, commit, push, tag, package or release was changed. Vendored runtime
under `devices\qemu-esp32\bin` remains a separate release blocker.

## E135 — fail-closed gate executor and promotion retry blocked by historical `PULADO:` gate conflict (2026-09-07)

**REQUEST_ID:** `E135-fail-closed-gates-runtime-promotion-20260907`.

**RESULT:** `BLOCKED_BEFORE_FINAL_PROMOTION — FAIL_CLOSED_GATE_CONFLICT`.

**REPORT:** `C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\E135-gate-executor_20260907_181428\E135_fail_closed_gate_executor_report.md`.

**EXECUTOR:** `C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\E135-gate-executor_20260907_181428\Invoke-E135PromotionGate.ps1`.

**EXECUTOR_SHA256:** `25A367AB2196EB21C090F9E41D013E1B06B3588FF950A5CA9F66749E3E6974A1`.

**WHAT_CHANGED:** Only the E135 PowerShell gate executor/wrapper artifact was
created/corrected. No production QEMU/Core/firmware/ABI/backpressure/cache-wait/
watchdog/transport/CMake semantics were changed. No vendored runtime promotion,
cleanup, commit, push, tag, package or release was executed.

**SELF_TEST:** latest self-test directory
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\E135-gate-executor_20260907_181428\selftest13`
passed all 11 synthetic fail-closed cases: zero+summary pass, zero+`SKIP` fail,
zero+missing-summary fail, nonzero fail, correct/wrong QEMU path, correct/wrong
SHA, timeout with owned cleanup, parent environment isolation, inherited
`LASECSIMUL_*` sentinel blocked, and non-owned QEMU classifier preservation.

**PREFLIGHT_WITHOUT_PROMOTION:** latest passing preflight directory
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\E135-gate-executor_20260907_181428\preflight6`.
The candidate was passed directly as
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\candidate_qemu\qemu-system-xtensa.exe`
with SHA256
`3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`.
`vnext_b_attachment_test` passed without `SKIP`; `session_restart_stress_test`
passed 3/3 cycles. QEMU process command-line samples showed the candidate path;
no fallback to `devices\qemu-esp32\bin\qemu-system-xtensa.exe` was observed.

**PROMOTION_ATTEMPTS:** two E135 promotion attempts were made after passing the
executor self-test/preflight and both were rolled back on the first fail-closed
red:

- `runtime-promotion_E135_20260907_183710`: post-promotion
  `test-esp32-timg-wdt-scale` exited 0 and printed TAP `1..13`/`ok 13`, but
  the executor incorrectly expected literal `13/13`. Classified as executor
  oracle failure, not runtime semantics. Rollback restored canonical SHA
  `B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E` and
  `QEMU_RUNTIME.json` hash
  `ADF0D79B9E533E17A3F8CA62FD890B1867973FBB1AFF1C95239142D03644B369`.
- `runtime-promotion_E135_20260907_184029`: post-promotion unit gates,
  `vnext_b_attachment_test`, and `session_restart_stress_test` passed. A
  direct regression precheck then reached `mcu_controller_real_qemu_test`,
  which exited 0 and printed `Todos os testes passaram`, but also printed a
  known VNEXT_B LEGACY-only not-applicable line beginning with `PULADO:`. Since
  E135 explicitly requires the executor to reject `PULADO:`, the fail-closed
  executor stopped. Classified as protocol/gate-content conflict, not runtime
  semantics. Rollback again restored canonical SHA `B375A9E8...` and
  `QEMU_RUNTIME.json` hash `ADF0D79B...`.

**CURRENT_SAFE_STATE:** canonical
`C:\SourceCode\LasecSimul\vnext_prototype\dev_qemu_runtime\qemu-system-xtensa.exe`
is SHA256
`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`.
`QEMU_RUNTIME.json` is SHA256
`ADF0D79B9E533E17A3F8CA62FD890B1867973FBB1AFF1C95239142D03644B369` and its
read-only attribute is restored. Zero QEMU processes remain.

**BLOCKER:** the corrected fail-closed executor cannot both reject every
`PULADO:` and pass the current historical 14-test `VNEXT_B+MTTCG` regression,
because `mcu_controller_real_qemu_test` emits a known LEGACY-only `PULADO:`
while otherwise passing under VNEXT_B. A bounded decision is required before
promotion can remain active: remove/replace that output/gate for VNEXT_B,
explicitly authorize a narrow exception, or redefine the 14/14 promotion list.

**RELEASE_BLOCKER_RETAINED:** the vendored runtime at
`C:\SourceCode\LasecSimul\devices\qemu-esp32\bin\qemu-system-xtensa.exe`
remains old and remains a separate release blocker.

## Runtime promotion execution — PROMOTION_ROLLED_BACK / FIRST_POST_PROMOTION_RED (2026-09-07)

**REQUEST_ID:** `B12-runtime-promotion-execution-20260907`.

**RESULT:** `PROMOTION_ROLLED_BACK — FIRST_POST_PROMOTION_RED`.

**ARTIFACT:** `C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\runtime-promotion_20260907_175847`.

**REPORT:** `C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\runtime-promotion_20260907_175847\runtime_promotion_execution_report.md`.

**PRECONDITIONS_PASSED:** candidate and build hashes were exactly
`3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`; canonical
hash before promotion was exactly
`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`;
`QEMU_RUNTIME.json` still declared the rollback SHA; no QEMU process was
running.

**ROLLBACK_SNAPSHOT_PROVEN:** snapshot directory
`runtime-promotion_20260907_175847\rollback_B375A9E8` contains the canonical
runtime directory and previous `QEMU_RUNTIME.json`; rollback executable hash is
`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`; 60 files
were captured before the manifest itself.

**PROMOTION_TEMPORARILY_APPLIED:** candidate was copied to a temporary file in
the canonical directory, verified as SHA `3D951D7C...`, then used to replace
only the canonical executable. The canonical executable temporarily hashed to
`3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`; adjacent
DLL/runtime files were unchanged; `qemu-system-xtensa.exe --version` through the
canonical path exited 0. `QEMU_RUNTIME.json` was temporarily updated and hashed
to `EA2E088DAEF31B1F5CAB49A7B1BE633C46601EFF4AC5B191D81B6A2F0B15D978`.

**GATES_BEFORE_RED:** QEMU deterministic gates passed:
`test-esp32-timg-wdt-scale` 13/13, `test-esp32-timg-pause` 7/7, and
`test-vnext-b-classify` 9/9.

**FIRST_RED:** Core gate execution failed before production regressions/B11.
`vnext_b_attachment_test` emitted `SKIP: LASECSIMUL_TEST_QEMU_BINARY is not
available`. `session_restart_stress_test` exited 1; its log shows QEMU launched
from `C:/SourceCode/LasecSimul/core/../devices/qemu-esp32/bin/qemu-system-xtensa.exe`
instead of the promoted canonical path, then reported incompatible arena ABI v5
descriptor and 15/15 startup failures. This is recorded as a promotion-gate
invocation/path failure, not as a new QEMU/Core/firmware semantic diagnosis.

**ROLLBACK_PROVEN:** canonical executable was restored from the rollback
snapshot and now hashes to
`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`.
`QEMU_RUNTIME.json` was restored to hash
`ADF0D79B9E533E17A3F8CA62FD890B1867973FBB1AFF1C95239142D03644B369`, with
canonical SHA `B375A9E8...`. Zero QEMU processes remained after rollback.

**NOT_RUN_AFTER_RED:** no `VNEXT_B+MTTCG` regression, B11 N=1 or B11 N=16 was
run after the first red. No cleanup, commit, push, tag, package or release was
performed.

## B12 runtime promotion review — APPROVE / execution authorized (2026-09-07)

**REQUEST_ID:** `B12-runtime-promotion-review-20260907`.

**DECISION:** `APPROVE — RUNTIME_PROMOTION_EXECUTION_AUTHORIZED`.

**SCOPE:** read-only promotion audit for `VNEXT_B+MTTCG` only. No promotion,
copy, delete, cleanup, commit, push, tag or release was performed.
`QEMU_RUNTIME.json` was not changed.

**REPORT:** `C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\B12-runtime-promotion-review_20260907\runtime_promotion_review.md`.

**IDENTITY_PROVEN:** candidate QEMU exists and hashes to
`3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`.
Canonical/rollback runtime exists and hashes to
`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`.
Candidate differs from canonical. `QEMU_RUNTIME.json` still points to the
canonical rollback SHA. No `qemu-system-xtensa.exe` process was running during
the review.

**FUNCTIONAL_EVIDENCE_RECONFIRMED:** preserved artifacts show two
`VNEXT_B+MTTCG` regressions PASS 14/14, B11 N=1/N=8/N=12 PASS, B11 N=16 PASS
3/3, N=16 48/48 workloads, `submissions==completions>0` in every session, zero
unexpected resets, `artifactFatal=false`, zero CACHEERR/Guru, zero UART/I2C loss
or desync, clean teardown, zero QEMU orphans, and manifests/logs identifying the
candidate SHA.

**REPRODUCIBILITY_REVIEW:** QEMU repo branch `main`, HEAD
`9dc30419a5372756b555ad7926563dcda2215c79`; Core repo branch
`fix/vnext-b-mwdt-hotpath-diagnostics`, HEAD
`5e4fd87f2e0af2d9b43531e2dbc6bc2e3242a69f`. The repos are dirty, but required
production/test/runner/ABI source content is present and inventoried in the
review report. `C:\SourceCode\qemu_lasecSimul\build-ucrt64\qemu-system-xtensa.exe`
hashes to the same SHA as the preserved candidate, proving current build output
matches the candidate. Generated `build-ucrt64` files are regenerable outputs,
not source-of-truth. `net/slirp.c` has no pending diff at review time.

**PROMOTION_PLAN_AUTHORIZED:** next execution may promote only the candidate SHA
above over the current canonical executable after creating and verifying an
immutable rollback snapshot of the canonical executable and adjacent DLLs. The
future promotion must replace only the executable, preserve DLLs, update
`QEMU_RUNTIME.json`, run gates through the canonical path, and restore rollback
if any gate fails. Do not delete rollback.

**POST_PROMOTION_GATES_AUTHORIZED:** affected deterministic QEMU tests
(`test-esp32-timg-wdt-scale`, `test-esp32-timg-pause`,
`test-vnext-b-classify`), `vnext_b_attachment_test`,
`session_restart_stress_test`, one full `VNEXT_B+MTTCG` regression 14/14, B11
N=1, one B11 N=16 cell, SHA confirmation in logs, zero unexpected reset,
UART/I2C loss/desync, artifact fatal, teardown hang, blocked re-entrant IO and
QEMU orphan.

**NOT_AUTHORIZED:** `LEGACY`, `ICOUNT`, `SINGLE_REALTIME`, Phase C, cleanup,
commit, push, tag and release.

## B12 final decision — B12_PASS / PROMOTION_REVIEW_AUTHORIZED for VNEXT_B+MTTCG (2026-09-07)

**REQUEST_ID:** `B12-final-decision-vnext-b-mttcg-after-e134`.

**DECISION:** `B12_PASS — PROMOTION_REVIEW_AUTHORIZED`. Scope is strictly
`VNEXT_B+MTTCG`. No B11 rerun, B12 execution in other topology, runtime
promotion, cleanup, commit, push, tag or release was performed.

**REPORT:** `C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\B12-final-decision_20260907_1735\B12_final_decision_report.md`.

**IDENTITY_PROVEN:** every approved B11 manifest uses candidate QEMU SHA256
`3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`. Firmware
and harness identities are preserved by SHA: `merged.bin`
`1DA8BF731830B2D2D9CE6EDBB0EA208636A1DB2A79497A8DB0CC98D72864C76A`,
`firmware.elf`
`1697587B58F9DF862765ADABC2F5A2E74387863438D8A6DF775196A542C9D9B6`,
`firmware.map`
`1175C388686F9C757C833FE16B01A95392820208D20A63297775F231F4E4FEA5`,
harness
`81A7472B0861EDA5EB0E12E42467C346C4B86778B204C8B9B3FC9F03DF43AB96`.

**B11 CONFIGURATIONS APPROVED:** N=1 has 1/1 valid execution and 1/1 workload;
N=8 has 1/1 valid execution and 8/8 workloads; N=12 has 1/1 valid execution and
12/12 workloads; N=16 has 3/3 valid executions and 48/48 workloads. Every
session has `submissions==completions>0`.

**RESET ACCOUNTING:** N=1 has 2 raw reset lines, 2 unique resets, 2 expected
resets and 0 unexpected resets. N=8 has 16 raw reset lines, 16 unique resets, 16
expected resets and 0 unexpected resets. N=12 has 24 raw reset lines, 24 unique
resets, 24 expected resets and 0 unexpected resets. N=16 has 96 raw reset lines,
96 unique resets, 96 expected resets and 0 unexpected resets across 3 valid
runs. Expected resets are the per-session cold boot baseline plus the expected
app-cpu-startup reset; no unexpected reset remains.

**ORACLES_CLEAN:** approved B11 logs and manifests show `artifactFatal=false`,
no CACHEERR/exccause=7, no Guru Meditation, no active TG0/TG1 expiry marker, no
unexpected `SW_CPU_RESET_REGISTER`, no UART loss/drop, no I2C loss/desync, no
blocked re-entrant IO, no timeout/backstop failure, no fail-open result, clean
teardowns and zero owned QEMU orphans. A current host process check also found
zero `qemu-system-xtensa.exe` processes.

**E134_EXERCISED:** the approved B11 evidence used the preserved E134 candidate
binary, not the canonical rollback runtime. E134 itself had already proved that
production `esp32_timg_wdt_arm()` calls the shared helper implementing scaled
tick-domain reanchor math with literal `count_base`, one ns conversion and
`INT64_MAX` deadline clamp.

**CLASSIFICATION:** `NO_ACTIVE_ANOMALY_OBSERVED`. The approved artifacts contain
no current failure population to classify as `starvation_compatible`,
`transport_anomaly` or `execution_path_anomaly_compatible`; the historical
20-unique-reset requirement applies only when classifying a real failure
population and does not make a fully clean campaign inconclusive.

**NO_PHASE_C_JUSTIFICATION:** current evidence does not justify a capacity
guarantee, progress-aware host clock, or new watchdog compensation.

**RUNTIME_CANONICALITY:** `QEMU_RUNTIME.json` and the canonical runtime remain
intact at SHA256
`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`. Promotion
is only recommended for a separate review; it was not performed in B12.

## E134 closure review — APPROVE; B11 closed, B12 authorized for VNEXT_B+MTTCG (2026-09-07)

**REQUEST_ID:** `E134-wdt-scale-reanchor-closure-review`.

**DECISION:** `APPROVE`. E134 and B11 may be closed. B12 is authorized
exclusively in `VNEXT_B+MTTCG`. No B12, runtime promotion, cleanup, commit, tag
or release was executed during this review.

**IDENTITY_PROVEN:** preserved candidate QEMU SHA256 is exactly
`3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`.
The two `VNEXT_B+MTTCG` regression logs and all B11 manifests reviewed point to
the preserved candidate under
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\candidate_qemu`.
The canonical runtime was not promoted: `QEMU_RUNTIME.json` still records
canonical SHA256 `B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`,
and the executable at `vnext_prototype\dev_qemu_runtime\qemu-system-xtensa.exe`
hashes to the same value.

**CODE_REVIEW_PROVEN:** production `esp32_timg_wdt_arm()` calls the shared
helper in `include/hw/timer/esp32_timg_wdt_scale_math.h`. The helper computes
the effective stage timeout as `raw_timeout * normalized_scale` with
saturation, leaves `count_base` and current count in literal ticks, subtracts
literal count from the effective tick budget, converts remaining ticks to
nanoseconds exactly once, and clamps the final deadline to `INT64_MAX` before
`timer_mod_anticipate_ns()`. No production-side second scale multiplication was
found. Scale zero normalizes to 1, scale 1 is literal-equivalent, and the same
math is used for TG0 and TG1 through the shared TIMG/WDT path.

**SEMANTICS_REVIEW_PROVEN:** guest WDT registers continue to hold raw values.
FEED, enable/disable edges, stage transitions and reset/interrupt callbacks
remain intact. E114 pause compensation remains intact and separate. E134 fixes
an internal inconsistency in the existing scale/reanchor math; it does not
increase the watchdog, mask callbacks, suppress legitimate expirations, alter
transport, alter firmware semantics, or redefine real prescaler-change
semantics.

**VALIDATION_REVIEW_PROVEN:** the deterministic WDT scale test covers 13 cases:
E133 reproduction, scale zero/one, full scaled budget, neutral reanchor,
repeated reanchors, FEED, timeout changes, preserved real-prescaler-change
semantics, stage transition, enable/disable, overflow/`INT64_MAX`, E114 pause
invariant, and legitimate later expiry boundary. Direct and Meson/Ninja runs
passed 13/13. Two `VNEXT_B+MTTCG` regressions passed 14/14 against the candidate
SHA. B11 was restarted from zero and passed N=1, N=8, N=12, and N=16 three
times. The N=16 runs each show 16/16 workloads, `submissions==completions>0`,
`totalUnexpectedResets=0`, no artifact fatal, clean teardown, and zero owned
QEMU orphans after cleanup.

**CAVEAT_ACCEPTED:** the rebuilt no-feed MWDT diagnostic fixture did not produce
observable stdout/stderr in bounded QEMU attempts, so this round does not claim
a new integrated no-feed later-expiry proof. This does not block closure because
device expiry behavior was demonstrated previously, scale 1 remains literal and
tested, the deterministic helper suite proves the scaled expiry boundary, E134
does not disable the timer or callback, regressions and B11 N=16 3/3 are clean,
and no unexpected/premature MWDT expiry remains.

## E134 phase 2 — watchdog scale/reanchor fix implemented; validation GREEN pending closure review (2026-09-07)

**SCOPE_PROVEN:** `VNEXT_B+MTTCG` only. No B12, promotion, cleanup, commit,
tag or release. `QEMU_RUNTIME.json` unchanged. Production reset, transport,
firmware workload and cache-wait semantics were not broadened.

**ARTIFACT_PROVEN:** implementation and validation artifacts are preserved in
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218`.
Candidate QEMU SHA256:
`3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`.
Production firmware snapshot SHA256: `merged.bin`
`1DA8BF731830B2D2D9CE6EDBB0EA208636A1DB2A79497A8DB0CC98D72864C76A`,
`firmware.elf`
`1697587B58F9DF862765ADABC2F5A2E74387863438D8A6DF775196A542C9D9B6`,
`firmware.map`
`1175C388686F9C757C833FE16B01A95392820208D20A63297775F231F4E4FEA5`.

**IMPLEMENTATION_PROVEN:** `esp32_timg_wdt_arm()` now calls the shared helper
in `include/hw/timer/esp32_timg_wdt_scale_math.h`. The helper computes the
effective timeout in tick domain (`raw_timeout * normalized_scale`, saturated),
subtracts the literal count, converts only the remaining effective ticks to
nanoseconds, and clamps the timer deadline to `INT64_MAX` before
`timer_mod_anticipate_ns()`. The previous post-subtraction multiplication of
`remaining_ns` by `wdt_time_scale` was removed. Scale zero still normalizes to
1; scale 1 remains literal-equivalent. The same math is shared by TG0 and TG1.

**DIAGNOSTIC_PROVEN:** the bounded WDT causal ring now records raw stage
timeout, effective timeout ticks, current literal count, remaining ticks,
remaining ns, and computed deadline. It remains off by default and was not
expanded into a broad causal tracer. Real prescaler-change semantics were not
changed; the deterministic GREEN suite records this as preserved existing
semantics and leaves any broader prescaler inconsistency as a separate possible
future issue.

**BUILD_PROVEN:** QEMU rebuilt successfully after recovering build-directory
generated-artifact issues unrelated to TIMG: Windows `#line` trace paths were
normalized in generated build files, stale `libqemuutil.a` was preserved then
recreated, and `net/slirp.c` received a minimal QAPI type-compatibility fix for
`StringList`. Final build log:
`phase2_qemu_build_after_slirp_value_str.out` with `BUILD_EXIT=0`.

**GREEN_TESTS_PROVEN:** `tests/unit/test-esp32-timg-wdt-scale.exe` passed 13/13
both as direct compile/run and as Meson/Ninja build target. Covered exact E133
sequence, scale 0/1, neutral reconfig, repeated reanchors, FEED, timeout
change, preserved real-prescaler-change semantics, stage transition,
enable/disable, overflow/`INT64_MAX`, E114 pause invariant, and legitimate
later expiry boundary. Logs:
`phase2_green_direct_test.out`, `phase2_meson_wdt_scale_run.out`.

**REGRESSION_PROVEN:** two independent `VNEXT_B+MTTCG` regressions passed 14/14
with the candidate QEMU:
`phase5_regression_vnextb_mttcg_1.out` and
`phase5_regression_vnextb_mttcg_2.out`.

**B11_PROVEN:** B11 restarted from zero with the candidate QEMU and immutable
production firmware snapshot. N=1 PASS, N=8 PASS, N=12 PASS, and N=16 PASS
3/3. All B11 cells had `B11_CELL_PASS=True`, `RUNNER_PASS=True`,
`EXTERNAL_BACKSTOP=False`, complete session dumps/JSONL, and
`MWDT_ATTRIB_RESETS=0`. Logs:
`phase4_b11_n1.out`, `phase6_b11_n8.out`, `phase6_b11_n12.out`,
`phase6_b11_n16_run1.out`, `phase6_b11_n16_run2.out`,
`phase6_b11_n16_run3.out`.

**INTEGRATED_FIXTURE_LIMIT:** an existing no-feed MWDT diagnostic fixture was
rebuilt after restoring the local PlatformIO/ESP-IDF Python environment and
fixing fixture-only `sdkconfig` drift (`CONFIG_FREERTOS_HZ=1000`,
`CONFIG_AUTOSTART_ARDUINO=y`). Its firmware was snapshotted with SHA, but QEMU
produced no stdout/stderr observability during bounded attempts; therefore it is
not claimed as a completed integrated expiry proof. The “no premature expiry”
property is proven by B11/regressions; the final no-feed expiry property remains
covered by deterministic helper tests only, not by a successful observable
integrated run.

**CLASSIFICATION:** E134 correction is implemented and validated enough for
closure review. B12/promotion remain blocked until review accepts the remaining
integrated-fixture limitation or requests one more observable no-feed proof.

## E134 phase 1 — H134 confirmed mathematically; semantic fix awaits review (2026-09-07)

**SCOPE_PROVEN:** `VNEXT_B+MTTCG` only. No B11 campaign, B12, promotion,
cleanup, commit, tag or release. `QEMU_RUNTIME.json` unchanged. No production
watchdog semantic correction has been applied yet.

**ARTIFACT_PROVEN:** snapshot and proof in
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218`.
Phase report:
`...\E134_phase1_red_review.md`; RED output:
`...\phase1_red_test.out`.

**SOURCE_PROVEN:** current `esp32_timg_wdt_get_count()` accumulates literal
APB/prescale ticks (`hw/timer/esp32_timg.c:675-696`). `update_config()`
materializes that literal value in `count_base`, writes `ns_base=now`, then
rearms (`699-747`). `arm()` compares the literal count against raw
`stage_timeout` (`800-804`) and only after that multiplies nanoseconds by
`wdt_time_scale` (`815-818`). The timer is armed at `840`. `WDTCONFIG0/1`
handlers (`234-249`) are the reconfig writers that call this path; `FEED`
(`750-789`) remains a full reset of stage/count/base; callback stage transition
reanchors at `1474-1479`; scale initialization remains `1` at init and `100`
for non-deterministic realtime unless overridden (`1482-1507`, `1556`).

**NUMERIC_PROOF:** for the requested E133 sequence, literal tick is
`40000/80000000 s = 500000 ns`. Pre-reconfig deadline is
`33,122,490,100 ns`. The CONFIG reanchor materializes
`(3,426,994,200 - 3,122,490,100) / 500000 = 609` literal ticks with `4100 ns`
remainder. The intended continuous-scale timeout is `600 * 100 = 60,000`
literal ticks, so `59,391` ticks remain after reanchor, i.e.
`29,695,500,000 ns`, for intended deadline `33,122,494,200 ns`. Current code
instead sees `609 >= raw 600`, makes `count_to_timeout=0`, and rearms at
`3,426,994,200 ns`, an improper anticipation of `29,695,495,900 ns` relative to
the previous deadline.

**RUNTIME_SUPPORT:** E133 diagnostic log contains the same shape in an actual
ring: ARM at `ns_base=3179743700/count_base=0/deadline=33179743700`, CONFIG at
`ns_base=3486865800/count_base=614`, next ARM deadline `3486865800`, and
CALLBACK_BEGIN at `3486894300`. The existing E133 ring does not yet include
write address, old/new config values, writer CPU or guest writer PC; those
fields must be added before any future diagnostic campaign to identify the
exact CONFIG writer.

**RED_TEST:** added pure pre-fix math extraction
`C:\SourceCode\qemu_lasecSimul\include\hw\timer\esp32_timg_wdt_scale_math.h`
and test
`C:\SourceCode\qemu_lasecSimul\tests\unit\test-esp32-timg-wdt-scale.c`.
The test intentionally fails against current arithmetic:
`3426994200 == 33122494200` assertion failure, exit 3.

**CLASSIFICATION:** H134 is confirmed unless review rejects the intended
semantics that `wdt_time_scale=100` should dilate the watchdog continuously
across neutral `WDTCONFIG0/1` reconfiguration. State set to `REVIEW_REQUIRED`
before any semantic watchdog fix.

## E133 — B11 N=16 causality narrowed, not closed (2026-09-07)

**SCOPE_PROVEN:** execução restrita a `VNEXT_B+MTTCG`. Não houve mudança semântica
de QEMU/Core/firmware, nem B12, promoção, cleanup, commit, tag ou release.

**ARTIFACT_PROVEN:** consolidação em
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E133-b11-n16-causality_20260907_141445\E133_consolidated_result.md`
e JSON pareado
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E133-b11-n16-causality_20260907_141445\E133_consolidated_result.json`.

**RUNNER_PROVEN:** o runner antigo era fail-open para B11 N=16: manifesto
preservado tinha `runner_exit=0` enquanto o classificador marcava
`cellPass=false`. E133 corrigiu somente runner/harness para falhar em exit code
não-zero/indisponível, timeout, JSONL incompleto, `cellPass=false`, teardown
sujo, órfãos próprios e inconsistência stderr/JSONL. O cleanup amplo
`Get-Process qemu-system-xtensa | Stop-Process -Force` foi substituído por
seleção de processos QEMU pertencentes à execução corrente por PID/linhagem/
janela de criação/caminho. Teste determinístico do runner:
`phase2_runner_lib_test_after_diag_switches.out` = 14/14 PASS, incluindo filho
QEMU fake próprio encerrado e processo externo/preexistente preservado.

**PRESERVED_AUDIT_PROVEN:** auditoria do B11 preservado deve usar
`phase1_preserved_audit_v3.md`, `phase1_n16_session_audit_v3.json`,
`phase1_n16_reset_events_v2.json` e `phase1_compare_n8_n12_n16_v2.json`. As
saídas phase1 anteriores sem estes sufixos foram preservadas, mas estão
suplantadas. N=8/N=12 estavam verdes; N=16 foi o primeiro vermelho real do
oráculo B11, com 16/16 sessões e JSONL, `sessionsWorkloadPass=13/16`,
`totalUnexpectedResets=14`, `MWDT_ATTRIB_RESETS=0`, sem CACHEERR/Guru/
reentrância/teardown-hang. A causa iniciadora não fica provada só pelos logs
preservados.

**MEASURED_FORMAL:** R0 mínimo N=16/60000ms/ReserveCores=0/sem Force passou uma
vez: 16/16 dumped, 16/16 workload, zero unexpected resets, topologia 16 físicos
/32 lógicos, 2 vCPUs por sessão, 32 slots requeridos, herança de afinidade e
prioridade confirmada. Primeiro bloco intercalado: controle R6+Force falhou com
16/16 workload e 21 unexpected resets; tratamento R0/sem Force falhou com
15/16 workload e 3 unexpected resets. As repetições formais foram interrompidas
nesse primeiro tratamento vermelho, conforme protocolo.

**MEASURED_DIAGNOSTIC:** uma única execução diagnóstica dirigida R0/sem Force
com `PANIC_CAUSAL_TRACE`, `WDT_CAUSAL_TRACE`, `MWDT_ACCOUNTING` e
`XTENSA_PC_SAMPLER` falhou: 16/16 dumped/JSONL, `sessionsWorkloadPass=15/16`,
6 unexpected resets, `cellPass=false`, zero CACHEERR/Guru/reentrância/
teardown-hang. Foram observados `tg=1 first_genuine_expiry` e
`first_actual_stage_expiry` com compensação de transporte zero; o reset
observado é `SW_CPU_RESET_REGISTER` via `SW_APPCPU_RESET`, não reset diretamente
atribuído a MWDT pelo classificador. Frames de pânico permaneceram ambíguos
(`exccause=69`/`65535`); `tg1_wdt_source20_active=0` e bits cache IA zerados no
snapshot de reset. PC sampler aproximou CPU1 de `spi_flash_op_block_func` perto
da expiração TG1; também apareceu sintoma separado de workload silencioso com
CPU1 em `panic_handler` e CPU0 em idle wait.

**CLASSIFICATION:** B11 N=16 continua **OPEN**. E133 estreita o vermelho para
uma falha sensível a escala envolvendo expiração genuína TG1 seguida de caminho
de reset de software/pânico do ESP-IDF, com sintoma separado de workload
silencioso/panic. Não está provado: reset direto MWDT, CACHEERR, Guru,
reentrância, teardown, causa exata do pânico, nem propriedade final
host-versus-guest-versus-QEMU. `ReserveCores=6 + Force` é fator contribuinte/
agravante, mas não causa única comprovada porque R0/sem Force também falhou em
tratamento formal.

## E132-F — validação pós-review retomada; B11 para no N=16 (2026-09-07)

**SCOPE_PROVEN:** depois de E132-E, a sequência pós-review `VNEXT_B+MTTCG` foi
retomada com o mesmo QEMU candidato
`5E0F51664C88685EA986A2F7F975A728CD02190D05AB76EA17D9AB52A2C74F7A`. Não houve
promoção de runtime, B12, cleanup, commit, tag ou release.

**ARTIFACT_PROVEN:** resumo consolidado em
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E132-post-review_20260907_113506\E132-E_session_restart_oracle_20260907_123456\E132F_post_review_resume_summary.json`.

**MEASURED_TEST:** `RESET_WAIT` 3/3 passou via runner E131, com artefatos em
`...\phase_next_reset_wait_3x_argfix`. A primeira tentativa anterior
`phase_next_reset_wait_3x` não iniciou o harness (`harness_pid=0`) por erro de
invocação `Start-Process -ArgumentList @()` do runner; foi classificada como
erro de invocação, não como execução QEMU/RESET_WAIT. A repetição com argumento
inócuo `noop` rodou de fato e passou 3/3.

**MEASURED_TEST:** E131 completo 6/6 passou via casos default do runner
(`DROM`, `FETCH`, `RUNSTALL`, `CLKGATE`, `SELF_ILLEGAL`, `RESET_WAIT`) em
`...\phase_next_full_e131_6x_defaultcases_argfix`. A tentativa imediatamente
anterior `phase_next_full_e131_6x_argfix` não iniciou nenhum caso por erro de
passagem da lista `-Cases`; foi erro de invocação, não vermelho QEMU.

**MEASURED_TEST:** duas regressões `VNEXT_B+MTTCG` passaram usando
`vnext_prototype\run_regression.ps1`, Release, QEMU override do candidato. O
runner atual contém 14 testes runnable porque inclui `drain_cutoff_gate_test`
além do conjunto histórico de 13; resultados:

- run1 `VNEXT_B_MTTCG_E132E_VNEXT_B_MTTCG_run1_20260907_133800`: 14/14 PASS;
- run2 `VNEXT_B_MTTCG_E132E_VNEXT_B_MTTCG_run2_20260907_134200`: 14/14 PASS.

**MEASURED_TEST:** B11 formal foi reiniciado do zero em
`...\phase_next_B11_formal`, com `RunMs=60000`, `ReserveCores=6`, traces formais
OFF e classificado por `vnext_prototype\mttcg_causality\B11\b11_classify.ps1`.
Resultados:

- N=1: PASS, `cellPass=true`, 1/1 sessions dumped/JSONL/workload, zero
  unexpected resets, zero `Blocked re-entrant IO`, teardown limpo;
- N=8: PASS, 8/8, zero unexpected resets, zero reentrância bloqueada, teardown
  limpo;
- N=12: PASS, 12/12, zero unexpected resets, zero reentrância bloqueada,
  teardown limpo;
- N=16: **FAIL / FIRST_RED**, `runner_exit=0`, harness `EXIT_CODE=1`,
  `cellPass=false`. O run foi deliberadamente oversubscribed (`-Force`) com 6
  cores reservados, conforme guard do runner.

**B11_N16_CLASSIFICATION:** N=16 despejou 16/16 sessões e 16/16 linhas JSONL,
sem external backstop, sem `TEARDOWN_HANG`, sem `Blocked re-entrant IO`, sem
`CACHEERR`/`exccause=7`, sem `Guru Meditation Error` e sem QEMU órfão. O
classificador falha por `sessionsWorkloadPass=13/16` e
`totalUnexpectedResets=14`. Sessões 7, 9 e 12 tiveram
`submissions=0/completions=0/workloadPass=false`; sessões 2, 5, 7, 9 e 12
contribuíram resets inesperados. As linhas de reset mostram fonte
`SW_CPU_RESET_REGISTER` e um `RTC_RESET` em sessão 2; `MWDT_ATTRIB_RESETS=0`.

**STOP_REASON:** regra fail-closed: parar no primeiro vermelho real pós-review.
B12, promoção de runtime, cleanup, commit, tag e release permanecem bloqueados.

## E132-E — `session_restart_stress_test` saneado e determinísticos pós-review 8/8 (2026-09-07)

**SCOPE_PROVEN:** a correção foi restrita ao harness/oráculo de
`core\test\core\mcu\SessionRestartStressTest.cpp`. Não houve alteração de
semântica QEMU/produção. A prova RED anterior em
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E132-post-review_20260907_113506\phaseC_deterministic_tests`
foi preservada.

**SOURCE_PROVEN:** o teste `VNEXT_B` deixou de usar a string diagnóstica
`[VNEXT_PROBE] after qemu_init` como liveness. Boot/liveness agora exige
`firmwareRunning()`, scheduler rodando e avanço estrutural de
`pacingPositionNs()`. Flash vazia prova somente lifecycle/pacing/execId/stop
limpo/sem órfãos; I2C/stale/GPIO/UART real ficam `NOT_APPLICABLE`. Firmware real
usa contadores estruturais `vnextI2cSubmissionCountForTesting()`,
`vnextI2cCompletionCountForTesting()` e `vnextArtifactProgressForTesting()`,
além de pacing. O teste contém um auto-oráculo que rejeita processo/scheduler
vivos sem avanço de pacing.

**SOURCE_PROVEN:** a barreira test-only de callback stale agora é liberada
durante o `stop()` do ciclo A, após o avanço de geração do attachment e antes de
transportar o bloqueio para o ciclo B. Isso preserva a prova de rejeição por
geração sem fabricar `unregister() drain TIMEOUT`.

**ARTIFACT_PROVEN:** evidências novas preservadas em
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E132-post-review_20260907_113506\E132-E_session_restart_oracle_20260907_123456`.
Hashes finais:

- `SessionRestartStressTest.cpp`
  `01F7B3C06F5758EF3C0C2CD88D429BB93154ED920E39A7C69C03661CBD73D059`;
- `session_restart_stress_test.exe`
  `599ECEEF5B4E9A3700057A10A233E0CA7F4D35C503E38CC7F9A41EC677023262`;
- QEMU candidato
  `5E0F51664C88685EA986A2F7F975A728CD02190D05AB76EA17D9AB52A2C74F7A`;
- firmware real `guest_i2c_workload` `merged.bin`
  `1DA8BF731830B2D2D9CE6EDBB0EA208636A1DB2A79497A8DB0CC98D72864C76A`.

**MEASURED_TEST:** rebuild isolado de `session_restart_stress_test` passou com
0 warnings/0 errors. Pré-gate blank-flash 3 ciclos passou com traces
operacionais OFF, exit code 0, zero timeout, zero órfãos e marcadores:
`P9_RESTART_MANAGED_LIFECYCLE PASS mode=blank_flash`,
`P9_RESTART_PACING_LIVENESS PASS cycles=3`,
`P9_STALE_WAIT_CALLBACK_REJECTED NOT_APPLICABLE`,
`P9_I2C_INFLIGHT_STOP_QUIESCENCE NOT_APPLICABLE`,
`VNEXT_NO_POLL_RESTART PASS` e
`VNEXT_DISPATCHER_RESTART_REUSE PASS`.

**MEASURED_TEST:** pré-gate firmware real 2 ciclos passou com exit code 0,
zero timeout e zero órfãos. Ambos os ciclos tiveram avanço de pacing,
submissions, completions e artifact progress; a callback stale de A foi
rejeitada (`rejected=1`) durante o stop de A; B progrediu semanticamente depois.
O log inteiro não contém `CACHEERR`, `Guru Meditation Error`,
`Blocked re-entrant IO`, `unregister() drain TIMEOUT`, `FALHOU`, `TRAVOU`,
`NAO INICIALIZOU` ou `TIMEOUT`.

**MEASURED_TEST:** formal firmware real 15 ciclos passou com exit code 0, zero
timeout e zero órfãos. Marcadores finais: `P9_RESTART_MANAGED_LIFECYCLE PASS`,
`P9_RESTART_REAL_PROGRESS PASS cycles=15`,
`P9_STALE_WAIT_CALLBACK_REJECTED PASS generation_mismatch=1 semantic_effect_on_B=0`,
`P9_I2C_INFLIGHT_STOP_QUIESCENCE PASS cycles=15`,
`P9_I2C_RESTART_ISOLATION PASS`, `VNEXT_NO_POLL_RESTART PASS` e
`VNEXT_DISPATCHER_RESTART_REUSE PASS`. O log inteiro não contém os marcadores
negativos listados acima.

**CONSOLIDATED_TEST:** `E132E_consolidated_deterministic_results.json` combina
os 7 determinísticos já verdes preservados de E132-C com o
`core_session_restart_stress` corrigido/reexecutado. Resultado consolidado:
8/8 PASS, todos exit code 0 e zero QEMU órfão.

**CLASSIFICATION:** E132-D fica reclassificado como vermelho de
harness/oráculo trace-gated, não falha semântica comprovada de QEMU. A
retomada pós-review agora pode prosseguir no próximo gate autorizado sem
promover runtime ainda.

## E132-D — Phase C parou no primeiro vermelho determinístico (`session_restart_stress_test`) (2026-09-07)

**BUILD_PROVEN:** rebuild pós-review verde. QEMU recompilado em
`C:\SourceCode\qemu_lasecSimul\build-ucrt64\qemu-system-xtensa.exe` com SHA
`5E0F51664C88685EA986A2F7F975A728CD02190D05AB76EA17D9AB52A2C74F7A`. Core/harness
Release recompilou 20 alvos com 0 erros. PlatformIO recompilou os 6 firmwares
E131; `e131_reset_wait` preservou `merged.bin`
`12D84E700A157715FC3A3514380A50F53FF29634AA2FD1210FC47E827B9722DB`.

**MEASURED_TEST:** bloco determinístico pós-review preservado em
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E132-post-review_20260907_113506\phaseC_deterministic_tests`.
Passaram antes do primeiro vermelho: `test-vnext-b-classify`,
`test-esp32-timg-pause`, `test-esp32-dport-cache-race-stall`,
`test-esp32-panic-trace-gate`, `vnext_b_arbiter_test`,
`vnext_b_attachment_test` e `mcu_component_live_poll_thread_test`, todos com
exit code 0 e zero QEMU órfão.

**FIRST_RED:** `session_restart_stress_test` retornou exit code 1 após 94,543 s.
Resumo do stderr: 15/15 ciclos falharam ao inicializar; 0/15 travaram no meio;
0/15 falharam GPIO; 0/15 tiveram Guru Meditation; 0/15 deixaram estado após
Stop; 15/15 `sessionExecutionId` distintos. Em todos os ciclos o QEMU iniciou,
carregou ROM/APP ROM e registrou apenas o reset inicial; `firmwareRunning=sim`,
`arenaRunning=999`, `queue=999/999`, `abi=0`, `peerReady=nao`; não houve órfão.

**CLASSIFICATION:** vermelho classificado como harness/precondição provável, não
como falha semântica comprovada de QEMU ou de produção. O fonte vivo
`core/test/core/mcu/SessionRestartStressTest.cpp` usa, para `VNEXT_B`, a
presença da string `[VNEXT_PROBE] after qemu_init` em `qemuLogs()` como sinal de
liveness em flash vazia. Esse marcador é diagnóstico e depende de trace opt-in,
enquanto a validação formal mantém traces operacionais desligados por padrão.
Hipótese falsificável: substituir esse oráculo trace-gated por heartbeat/estado
estrutural não diagnóstico, ou rodar o cenário com firmware real explícito,
deve eliminar o falso vermelho sem alteração de semântica QEMU.

Não foram executadas regressões 13/13, B11, B12, promoção, cleanup, commit, tag
ou release depois deste vermelho.

## E132-C — reviewer aprovado, snapshot inicial e auditoria pós-review (2026-09-07)

**REVIEW_PROVEN:** o reviewer independente aprovou explicitamente
`E132-B-review-20260907` em `orchestrator\.ai\WORK_RESULT.json` com
`state=EXECUTE`. A decisão aceita fechar o gate estrito E131 cache-wait para
`VNEXT_B+MTTCG` somente, sem promoção direta do runtime.

**ARTIFACT_PROVEN:** snapshot inicial pós-review preservado em
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E132-post-review_20260907_113506`.
Hashes iniciais confirmados: runtime canônico
`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`, candidato
QEMU E132-B `5E0F51664C88685EA986A2F7F975A728CD02190D05AB76EA17D9AB52A2C74F7A`,
harness `4D06CDF21FC1B94D246B3FE17DBC4C0B94F6286A3B07AD95C5E254A0A36CF20E` e
`QEMU_RUNTIME.json`
`ADF0D79B9E533E17A3F8CA62FD890B1867973FBB1AFF1C95239142D03644B369`.

**SOURCE_AUDIT:** antes de qualquer correção nova, foram conferidos diretamente
`accel/tcg/cpu-exec.c`, `hw/xtensa/esp32.c`, `hw/misc/esp32_dport.c`,
`include/hw/misc/esp32_dport.h` e
`core/test/core/mcu/CacheWaitE2ERealQemuTest.cpp`. O contador de entradas em
`cpu_exec()` é sempre incrementado com `qatomic_inc` e lido com `qatomic_read`.
A geração APP CPU é incrementada no ponto real de `cpu_reset()` e não fica atrás
de `LASECSIMUL_CACHE_TRACE`. R4/R6 expõem geração e watermark; o marcador tardio
expõe o watermark/estado de CPU1; o harness escolhe o par R4/R6 posterior ao
suspend e exige geração exatamente `+1`, `reset_wait_cleared` entre R4/R6,
`wait_mask=0`, ausência de `resume_committed` stale, CPU1 não stopped/halted e
crescimento do watermark depois de R6. Traces diagnósticos seguem opt-in por
variáveis de ambiente e não estão ativos por padrão.

## E132-B — RESET_WAIT arquitetural fechado e bateria E131 íntegra (2026-09-07)

**SOURCE_PROVEN:** o vermelho remanescente de E132 era outro falso negativo do
teste. O oráculo anterior exigia novas linhas `E131_TCG_TRANSLATE` depois de
R6, mas execução de TB já traduzido não gera nova tradução. A geração de reset
APP CPU também dependia indevidamente de `LASECSIMUL_CACHE_TRACE`, embora seja
consumida pelo trace leve de cache-wait. A geração agora é incrementada em todo
reset APP CPU, sem efeito guest-visible. O firmware RESET_WAIT deixou de exigir
que um reset isolado de CPU1 reconstrua o protocolo SMP/FreeRTOS; ele apenas
confirma que o caminho antigo não produziu efeito. O harness usa como oráculo o
contador monotônico real de entradas em `cpu_exec()` da CPU1, amostrado em R6 e
no marcador tardio `0xa7060000`. O contador foi tornado atômico para a leitura
cruzada entre threads MTTCG.

**MEASURED_SIMULATOR:** RESET_WAIT passou 3/3 em processos QEMU independentes.
Em cada execução: geração `2 -> 3`, exatamente um `suspend_committed`, exatamente
um `reset_wait_cleared`, zero `resume_committed` stale, `wait_mask=0` após reset,
CPU1 `stop=0 stopped=0 halted=0`, e watermark de CPU1 cresceu em três entradas
entre R6 e o marcador tardio: `1074->1077`, `1086->1089`, `1099->1102`.
Teardown limpo, ambiente pai restaurado e zero órfãos nas três.

**MEASURED_SIMULATOR:** a bateria E131 final, uma repetição de cada cenário em
QEMU novo, passou 6/6: DROM, FETCH, RUNSTALL, CLKGATE, SELF_ILLEGAL e RESET_WAIT.
Todos os manifests registram `STATUS=PASS`, `CLASSIFICATION=PASS`, exit code 0,
`stopSimulation` begin/end, ambiente restaurado e nenhum PID QEMU residual.

Artefatos imutáveis:

- RESET_WAIT 3/3: `C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E132-gate-integrity\phase2b_reset_oracle_20260907_094500\reset_wait_3x`;
- bateria 6/6: `C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E132-gate-integrity\phase3_full_e131_20260907_095500\full_e131`;
- QEMU SHA-256 `5E0F51664C88685EA986A2F7F975A728CD02190D05AB76EA17D9AB52A2C74F7A`;
- harness SHA-256 `4D06CDF21FC1B94D246B3FE17DBC4C0B94F6286A3B07AD95C5E254A0A36CF20E`;
- RESET_WAIT firmware SHA-256 `12D84E700A157715FC3A3514380A50F53FF29634AA2FD1210FC47E827B9722DB`.

Nenhuma semântica de cache, reset, scheduler, transporte ou watchdog foi
alterada. O runtime canônico e `QEMU_RUNTIME.json` não foram promovidos. E131
fica estritamente fechado para VNEXT_B+MTTCG, sujeito ao checkpoint obrigatório
de revisão antes de retomar validação de produção/B11.

## E132 — integridade do gate do supervisor corrigida; RESET_WAIT permanece vermelho (2026-09-07)

Snapshot imutável criado antes das alterações em:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E132-gate-integrity`
com runner, fonte/executável do harness, firmware/ELF/map RESET_WAIT, QEMU
`43542C43670FDAAEA54DFE8D6D7967BA657584FE13415774824FCE1C61B6FD6D`, os três
falsos PASS E131-E, `QEMU_RUNTIME.json` e os status Git dos dois repositórios.

O runner `run_e131_cache_wait_e2e.ps1` foi corrigido para:

- chamar `WaitForExit()` e `Refresh()` antes de ler `ExitCode`;
- não converter código ausente em zero;
- exigir simultaneamente código observado zero, `harness-summary.txt`, exatamente
  uma linha `failures=0`, nenhuma linha `failure=`, ausência de `E131_FAILURE`,
  progresso terminal `exit:return:detail=0`, `stopSimulation` begin/end,
  ausência de órfão e restauração do ambiente pai;
- classificar qualquer contradição como `SUPERVISOR_INTEGRITY_FAIL`;
- classificar código indisponível como `SUPERVISOR_EXITCODE_UNAVAILABLE`;
- preservar e comparar `progress.detail` com o exit code observado.

Prova RED reaplicada ao RESET_WAIT equivalente: o processo auxiliar observado
retornou `0`, mas o summary tinha `failures=4`, stderr tinha `E131_FAILURE` e o
último progresso terminou em `exit:return` com `detail=1`. O runner saiu com
code `1`, escreveu `status=FAIL`, `classification=SUPERVISOR_INTEGRITY_FAIL`
e `exit_code=96`; não houve falso PASS. O erro original fica comprovado pelos
artefatos E131-E: `failures=4`, `detail=1`, mas `RUN_MANIFEST.txt` com
`status=PASS` e `exit_code=0`.

Um harness auxiliar controlado também confirmou o caso íntegro (`PASS`, code
zero), timeout (`HARNESS_TIMEOUT`, 124), contradições, summary/progresso ausente,
sentinel não herdado e restauração do ambiente. O caso auxiliar de retorno 1
via PowerShell não foi contado como verde porque o wrapper não propagou esse
code de forma confiável; não é usado como evidência de produto.

E132 parou no primeiro vermelho arquitetural: RESET_WAIT ainda falha porque a
geração não aumenta e o marcador FreeRTOS pós-reset não aparece. A causa já
registrada é a instrumentação atrás do gate `LASECSIMUL_CACHE_TRACE` e o
oráculo de reinicialização do scheduler não provado. Não houve alteração em
QEMU, firmware, `devices/`, runtime canônico ou `QEMU_RUNTIME.json`; B11 não
foi executado.

## E131-E — harness/runner saneados; E131-C fechado para VNEXT_B+MTTCG, com ressalva de regressão LEGACY (2026-09-07)

Scope executado: exclusivamente E131 cache-wait em VNEXT_B+MTTCG para a prova
funcional, sem alteração semântica de produção no QEMU e sem editar
`QEMU_RUNTIME.json`.

Classificação corrigida de E131-D/E131-C antes da execução:

- E131-A permanece **estruturalmente inválido/inconclusivo**.
- O `_UserExceptionVector` visto anteriormente não foi reproduzido em corrida
  limpa; não há prova de defeito semântico em QEMU nem autorização para fix de
  cache-wait.
- A influência de ambiente permanece hipótese forte, mas nenhuma variável
  causal específica foi provada por RED/GREEN.
- O vermelho E131-D foi classificado como hang de harness após
  `E131_HARNESS_LOADED`; o QEMU transiente posterior foi efeito do watchdog do
  harness antigo com `std::_Exit(2)`, que pulava cleanup.

Artefatos preservados:

- Phase0 snapshot:
  `C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E131-cache-wait-e2e\artifacts\20260907_E131E\phase0_snapshot`
- Harness/runner final:
  `C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E131-cache-wait-e2e\artifacts\20260907_E131E\post_failure_report_trim_20260907_065017`
- Phase4 supervisor:
  `C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E131-cache-wait-e2e\artifacts\20260907_E131E\phase4_supervisor_normal_final2`
  and
  `C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E131-cache-wait-e2e\artifacts\20260907_E131E\phase4_supervisor_forced_timeout_final2`
- Phase5 RUNSTALL 3/3:
  `C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E131-cache-wait-e2e\artifacts\20260907_E131E\phase5_runstall_clean_3x_final`
- Phase6 full 18/18:
  `C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E131-cache-wait-e2e\artifacts\20260907_E131E\phase6_full_18x_final2`
- Phase7 rebuild/regressions:
  `C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E131-cache-wait-e2e\artifacts\20260907_E131E\phase7_rebuild_hashes`,
  `...\phase7_regressions_qemu_override`,
  `...\phase7_regressions_qemu_override_extra`, and
  `...\phase7_13x13_safe_wrapper`.

Final hashes:

- QEMU E131-C immutable/current:
  `43542C43670FDAAEA54DFE8D6D7967BA657584FE13415774824FCE1C61B6FD6D`
- RUNSTALL firmware E131-C `merged.bin`:
  `2AA2782740C15F875D035808788BFE94787A6EABA08C810F2676C0CF1E6AA58D`
- Final harness executable:
  `C86BFB9DC3CF65289175445F81FB3D243A04DA6F841415847AE28851FF6AF159`
- Final harness source:
  `F1272908BA5123E5DCB5E7B90F0489F6D3BAC129012E8C4C92FA9C8CD82A4B78`
- Final runner:
  `21812FF9E35342414907C85D4870B09C4E3B9B436F57EF2FF81579F7EB29C3B0`
- `QEMU_RUNTIME.json`:
  `ADF0D79B9E533E17A3F8CA62FD890B1867973FBB1AFF1C95239142D03644B369`

Harness/runner evidence:

- Runner is hermetic for `LASECSIMUL_*`: it removes inherited names, applies a
  whitelist per run, writes `ENV_MANIFEST.txt`, and restores the parent
  environment in `finally`.
- Sentinel test with
  `LASECSIMUL_E131_INHERITED_SENTINEL=SHOULD_NOT_REACH_CHILD` passed: sentinel
  was not present in `HARNESS_ENV_NAMES.txt`, no extra child `LASECSIMUL_*`
  existed, and parent restore was true.
- Harness no longer uses `std::_Exit`; it captures logs/results, calls
  `session.stopSimulation()`, records `stopSimulation` begin/end, verifies
  firmware/scheduler stopped, and returns normally.
- Supervisor timeout test passed as a negative test: forced hang produced
  `HARNESS_TIMEOUT`, last stage identified, only the verified QEMU descendant
  was terminated, and zero E131/QEMU-like processes remained.

Functional E131 evidence:

- RUNSTALL clean Phase5 passed 3/3 with QEMU `43542...`, firmware
  `2AA278...`, fresh QEMU per repetition, `stopSimulation` begin/end, no
  timeout/orphan, and zero `_UserExceptionVector`/`CACHEERR`/reset/watchdog
  patterns.
- Full Phase6 passed 18/18:
  DROM, FETCH, RUNSTALL, CLKGATE, SELF_ILLEGAL, RESET_WAIT each passed 3/3.
  There were 18 manifests, zero timeouts, zero teardown orphans, zero failed
  cells, and zero `_UserExceptionVector`/`CACHEERR`/reset/watchdog matches in
  the preserved QEMU logs.

Phase7 evidence:

- QEMU rebuild target `qemu-system-xtensa.exe` completed and retained hash
  `43542...`; Core rebuild completed.
- Running `session_restart_stress` against the default `devices/` QEMU failed
  with arena ABI mismatch, proving a stale-link/runtime-binary issue outside
  E131 cache-wait. The same CTest set passed when using temporary
  `LASECSIMUL_TEST_QEMU_BINARY` override to the rebuilt QEMU.
- Additional CTest gates passed with the same temporary QEMU override:
  `mcu_controller_real_qemu`, `mcu_restart_stress`, `qemu_queue_stress`,
  `qemu_queue_full_timeout`, `mcu_blink_long_run`,
  `mcu_scheduler_pacing_sync_real_qemu`,
  `mcu_scheduler_pacing_sync_real_qemu_mttcg`,
  `vnext_b_attachment`, `mcu_component_live_poll_thread`,
  `session_restart_stress`, `qemu_mttcg_smoke`, `qemu_arena_v3_smoke`, and
  `simulation_performance_smoke`.
- `b11_classify_test.ps1` passed.
- Safe 13/13 wrapper results: VNEXT_B+MTTCG passed 13/13 twice (26/26 total).
  LEGACY+MTTCG stopped on first failure: attempt 1 had `PRODUCTION_SCALE FAIL`,
  `submissions=0`, `completions=0`, and four unexpected
  `SW_CPU_RESET_REGISTER` resets. No QEMU orphan remained.

Conclusion: E131-E closes the cache-wait proof for VNEXT_B+MTTCG and does not
justify a QEMU semantic change. Runtime promotion / broad release is not closed
because the separate LEGACY+MTTCG Phase7 gate remains red.

## E131-B — isolated VNEXT_B+MTTCG cache-wait proof closed; no QEMU semantic correction applied (2026-09-06)

Scope: VNEXT_B+MTTCG only. This entry follows the E131-A reclassification
below and uses fresh, single-scenario QEMU processes. No production QEMU
cache-wait semantic correction was applied in this step; the QEMU changes used
here are proof/diagnostic logging only.

Result: **PASS for all six isolated scenarios**:

- DROM
- FETCH
- RUNSTALL
- CLKGATE
- SELF_ILLEGAL
- RESET_WAIT

Fresh immutable artifact root:

`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E131-cache-wait-e2e\artifacts\20260906_194124`

The preserved artifact root contains, per scenario, its own `merged.bin`,
`firmware.elf`, `firmware.map`, `nm-anC.txt`, `objdump-t.txt`,
`objdump-h.txt`, `objdump-d.txt`, focused disassemblies, `addr2line` report,
`MANIFEST.txt`, full `qemu.log`, full `uart.txt`, process stdout/stderr, and
`harness-summary.txt`. `LATEST_ARTIFACT_ROOT.txt` points to this root.

Runtime/tool hashes used by the final run:

- QEMU:
  `C:\SourceCode\qemu_lasecSimul\build-ucrt64\qemu-system-xtensa.exe`
  SHA-256 `3F2AE2F7210C43B43773A2A225B0F8B305BFE401A52B7B29C33EFDE29C6DBF1C`
- Core harness:
  `C:\SourceCode\LasecSimul\core\build\Release\cache_wait_e2e_real_qemu_test.exe`
  SHA-256 `A07A12ADA5957A96C4AF851FB9F8975CEA89EC85A6C949FB707305546703E781`

Firmware SHA-256 values:

- DROM `merged.bin`:
  `6545867FE2E7331B23AB1773841B59B1A7547F2590881DC52FE422A2A94BE022`
- FETCH `merged.bin`:
  `5363158E1381E42157050107335142260503DB0E94E2F97A2936ECD99AC0BB96`
- RUNSTALL `merged.bin`:
  `90367B782C37BD9F012A53DDA1A84DF025DCBCECC9D27189DF0E4AA9761B39C4`
- CLKGATE `merged.bin`:
  `86349D65D37AB3E208E67C7B881FA2AC7AA597AC49EACAC89634FA82E24C0272`
- SELF_ILLEGAL `merged.bin`:
  `033D01F13A11FA163437DF032FF2404193E039733493E272DAFF91A6724229E5`
- RESET_WAIT `merged.bin`:
  `3C74909B706F76A86D2C7827B75C751C4579EB61358F2B3DCDD42A85DD2A761B`

Source-proven changes in the E131-B test fixture/harness:

- Each scenario is selected at build time by `E131_SCENARIO` and run in a
  separate QEMU process by the E131 runner.
- The controller task is created before the higher-priority APP worker, so the
  controller can disable APP cache and observe the wait state before release.
- The APP worker, MMIO helpers, cache-control helper and marker helper are
  marked `IRAM_ATTR`/`noinline`/`used`, but this is treated only as a source
  intent; placement is proven by ELF/map/objdump below.
- The guest publishes exact observed values through DPORT_DATE markers before
  A200 completion: `0xe131d00d` for DROM, `0xe131f37c` for fetch-value cases,
  and `0xbaadbaad` for the intentional self-illegal sentinel.
- The harness no longer treats substring `0xa0ffff` as a failure marker,
  because PASS is `0xa0ffffff`; it parses full guest-marker values instead.
- The FETCH oracle accepts the expected translation-time form
  `mem_io_pc=0`, `attempted=0`, `restored=0`, provided retranslation resumes
  at the same guest PC.
- RESET_WAIT is treated as a reset-cancel path: it requires
  `reset_wait_cleared`, `wait_mask=0`, and no stale `resume_committed`; it
  does not require `appcpu_reset_pending=0` at the instant of the clear event.

ELF/map/disassembly-proven placement and call-site facts:

- In every final ELF, `.iram0.text` starts at `0x40080404` and covers the
  `e131_app_worker`, `e131_app_cache_enable`, `e131_mmio_read`,
  `e131_mmio_write`, and `e131_mark` symbols. The focused `addr2line` reports
  map these symbols to `vnext_prototype/guest_cache_wait_e2e/src/main.cpp`.
- In every final ELF, `.flash.rodata` starts at `0x3f400120`, and
  `e131_drom_known_value` is inside `.flash.rodata`.
- In every final ELF, `.flash.text` starts at `0x400d0020`, and
  `e131_flash_target` is inside `.flash.text`.
- DROM final ELF:
  `e131_app_worker=0x400811e8`, `e131_app_cache_enable=0x40081194`,
  `e131_mark=0x40081184`, `e131_drom_known_value=0x3f409b58`,
  `e131_flash_target=0x400d17bc`.
- DROM focused disassembly proves the target data load: `l32r` at
  `0x40081203` loads the address `0x3f409b58 <e131_drom_known_value>`, and
  the actual `l32i.n` data load is at `0x40081209`.
- FETCH final ELF:
  `e131_app_worker=0x400811ec`,
  `e131_drom_known_value=0x3f409b6c`,
  `e131_flash_target=0x400d17c0`.

Runtime-proven final case results:

- DROM: one `suspend_committed` on APP CPU at exact load PC `0x40081209`,
  `region=drom0`, `vaddr=0x3f409b58`, `mem_io_pc != 0`
  (`0x213c5438782` in this run), `guest_case=1`,
  `replay_owed_pc=0x40081209`, and `replay_pc_match=1`. TCG restore line:
  `attempted=1 restored=1 guest_pc=0x40081209`. Resume line reports
  `target_appcpu_pc=0x40081209` and `target_pc_match=1`. Guest then publishes
  `0xe131d00d`, `0xa2000001`, and PASS `0xa0ffffff`.
- FETCH: one `suspend_committed` on APP CPU at `pc=0x400d17c0`,
  `region=iram0`, `vaddr=0x400d17c0`, `mem_io_pc=0x0`, `guest_case=2`,
  `replay_owed_pc=0x400d17c0`, and `replay_pc_match=1`. TCG restore trace is
  present only as a diagnostic non-restore record:
  `host_pc=0x0 attempted=0 restored=0 guest_pc=0x400d17c0`. The translate
  trace shows `event=begin cpu=1 pc=0x400d17c0` before the wait and again
  after resume, followed by `event=end cpu=1 pc=0x400d17c0`. Guest then
  publishes `0xe131f37c`, `0xa2000002`, and PASS `0xa0ffffff`.
- RUNSTALL: one fetch wait at `region=iram0`, `vaddr=0x400d17c0`,
  `mem_io_pc=0`, with `release_observed ... appcpu_stall=1`, then
  `resume_committed ... appcpu_stall=0 target_appcpu_pc=0x400d17c0`.
  Guest publishes `0xe131f37c`, `0xa2000003`, and PASS.
- CLKGATE: one fetch wait at `region=iram0`, `vaddr=0x400d17c4`,
  `mem_io_pc=0`, with `release_observed ... appcpu_clkgate=0`, then
  `resume_committed ... appcpu_clkgate=1 target_appcpu_pc=0x400d17c4`.
  Guest publishes `0xe131f37c`, `0xa2000004`, and PASS.
- SELF_ILLEGAL: no compensatory suspend. One `legitimate_illegal_access` at
  APP CPU `pc=0x40081216`, `region=drom0`, `vaddr=0x3f409b38`,
  `guest_case=5`; guest publishes sentinel `0xbaadbaad`, `0xa2000005`, and
  PASS.
- RESET_WAIT: one DROM wait at `pc=0x40081209`, `region=drom0`,
  `vaddr=0x3f409b50`, `mem_io_pc != 0`, and successful TCG restore
  `attempted=1 restored=1 guest_pc=0x40081209`. Then reset emits
  `reset_wait_cleared` with `wait_mask=0x0`, `appcpu_reset=0`,
  `appcpu_reset_pending=1`, `stopped=1`, `halted=1`, and there is no
  `resume_committed` stale wait. CPU0 publishes PASS.

Harness summaries for the final run:

- DROM: `suspend_committed=1`, `release_observed=1`,
  `resume_committed=1`, `tcg_restore=1`, `failures=0`.
- FETCH: `suspend_committed=1`, `release_observed=1`,
  `resume_committed=1`, `tcg_restore=1`, `failures=0`.
- RUNSTALL: `suspend_committed=1`, `release_observed=1`,
  `resume_committed=1`, `failures=0`.
- CLKGATE: `suspend_committed=1`, `release_observed=1`,
  `resume_committed=1`, `failures=0`.
- SELF_ILLEGAL: `suspend_committed=0`, `legitimate_illegal_access=1`,
  `tcg_restore=0`, `failures=0`.
- RESET_WAIT: `suspend_committed=1`, `reset_wait_cleared=1`,
  `resume_committed=0`, `failures=0`.

Important nuance: the diagnostic field `instruction_replayed` remains `0` in
these logs. It is **not** used as the replay proof for this entry. The
accepted exact retry evidence is:

- for DROM data-load: exact suspend/load PC plus successful
  `cpu_restore_state()` to that PC, exact resume target PC, and the subsequent
  guest value marker from the same worker;
- for instruction-fetch: exact fetch PC/vaddr, `mem_io_pc=0`,
  `attempted=0/restored=0`, and retranslation beginning again at the same
  guest PC before the guest publishes the fetched value.

No QEMU runtime was promoted and `QEMU_RUNTIME.json` was not intentionally
edited by this step.

## E131-B — E131-A reclassified as structurally invalid/inconclusive before any QEMU semantic fix (2026-09-06)

Scope: VNEXT_B+MTTCG only. Before editing QEMU production semantics, the
E131-A firmware/harness and its produced `firmware.elf`/map/disassembly were
re-read. This entry supersedes only the causal interpretation at the top of
E131-A below; the old entry remains as historical record of what was run.

Conclusion: E131-A is **structurally invalid/inconclusive**. It did not prove
a replay failure. It proved that the test did not isolate the intended
data-load/fetch cases and did not observe replay with a valid criterion.

Artifacts checked:

- E131-A diagnostic QEMU:
  `C:\SourceCode\qemu_lasecSimul\build-ucrt64\qemu-system-xtensa.exe`
  SHA-256 `28F558F2D15D3A152B42B6A23E2BDC354475C219121CE8CF758F9D6D241F2470`
- E131-A firmware merged bin:
  `vnext_prototype/guest_cache_wait_e2e/.pio/build/esp32/merged.bin`
  SHA-256 `D9C514DE72436DF7BC78188894EEDBC9FFD18DED62E7FC73D93FF7FDCDFBB4B4`
- E131-A firmware ELF:
  `vnext_prototype/guest_cache_wait_e2e/.pio/build/esp32/firmware.elf`
  SHA-256 `46DB8D3FBBC4D5101A3116030803A7172421F77F27F60112B9A11A730851D9AB`

Toolchain evidence used for this reclassification:
`xtensa-esp32-elf-nm -anC`, linker map, `xtensa-esp32-elf-objdump -t -h -d`,
and `xtensa-esp32-elf-addr2line -f -C`.

ELF/map/disassembly facts:

- `.iram0.vectors` starts at `0x40080000`; `.iram0.text` starts at
  `0x40080404`; `.flash.rodata` starts at `0x3f400120`; `.flash.text` starts
  at `0x400d0020`.
- `app_cache_enable(bool)` is a local function in `.iram0.text` at
  `0x4008115c`, mapping to `src/main.cpp:56`.
- `flash_fetch_marker(unsigned long)` is a local function in `.flash.text` at
  `0x400d17f4`, mapping to `src/main.cpp:67`.
- `kDromKnownValue` is a local object in `.flash.rodata` at `0x3f409c08`,
  mapping to `src/main.cpp:20`.
- `loop()` is a global function in `.flash.text` at `0x400d1cdc`.
- `_UserExceptionVector` is in `.iram0.vectors` at `0x40080340`.
- `addr2line(0x400d1d0f)` resolves to `loop()` / `src/main.cpp:75`.
  Disassembly shows this is the APP-side wait loop materialized inside
  `loop()` in `.flash.text`, not physical IRAM.
- The DROM read of `kDromKnownValue` occurs later in the same flash-resident
  `loop()` body: `0x400d1d2e` loads address `0x3f409c08`, `0x400d1d31` is
  `memw`, and `0x400d1d34` is the actual `l32i.n` data load.
- Therefore the E131-A DROM case is not an isolated DROM data-load test: the
  APP CPU can hit disabled flash instruction fetch while executing the
  flash-resident wait/worker path before the intended DROM data load.
- The absence of surviving final symbols for helpers such as `wait_for_go`,
  `app_worker`, `mark`, and `mmio_*` is **not** treated as proof by itself.
  The claim above rests on ELF section placement plus disassembly and
  `addr2line` for the actual executed addresses.

Source-proven structural defects:

- `controller_task()` runs multiple scenarios in one firmware/process, so
  results are cross-case stateful rather than isolated.
- `run_clkgate_case()` exists but is not called by `controller_task()`.
- The Core harness still requires clockgate preservation markers, making that
  gate impossible to satisfy as written.
- `run_runstall_case()` writes the RUNSTALL/control registers and does not
  perform a clear/release cleanup before continuing, leaving residual state.
- The Core harness uses `target_appcpu_pc`/the next observed trap after resume
  as a replay criterion. That is not valid replay evidence.
- The test stores only excerpts/counters, not integral per-scenario logs.

Pending/hypothesis only, not recorded as fact:

- It is not established that every E131-A case was contaminated in the same
  way.
- It is not established which observed `_UserExceptionVector` instances are
  caused by which scenario.
- It is not established that a specific restore/replay failed; the old
  `target_pc_match=0` observation compared the owed PC with a later sampled PC
  and is not a replay proof.

Required next proof before any production semantic correction:

- Fresh independent QEMU process per scenario.
- Immutable preservation of each variant's `merged.bin`, `firmware.elf`, map
  file, SHA-256, and full logs before execution.
- DROM data-load isolated with the APP controller actually in physical IRAM;
  expected cache-wait evidence is `mem_io_pc != 0` and successful TCG restore.
- Instruction-fetch isolated separately; a translation/fetch wait may correctly
  have `mem_io_pc == 0` and no `cpu_restore_state()` if translation restarts
  at the same guest PC.
- Correlation by generation, region, virtual address, guest PC, host
  `mem_io_pc`, wait/release/resume/retry, and scenario.

## E131-A — cache-wait deterministic E2E attempted, STOP: replay PC not proven (2026-09-06)

Scope honored: only VNEXT_B+MTTCG cache-wait E2E work was attempted; no B11,
N=8/N=12/N=16 capacity run, B12, ICOUNT, or SINGLE_REALTIME was run.

Built a minimal Arduino diagnostic firmware in
`vnext_prototype/guest_cache_wait_e2e/` plus a Core-integrated real-QEMU test
`core/test/core/mcu/CacheWaitE2ERealQemuTest.cpp`. The test forces APP CPU
accesses while CPU0 disables APP cache regions and collects real QEMU
`[CACHE_WAIT_DIAG]` events under `LASECSIMUL_CACHE_WAIT_DIAG_TRACE=1` and
`LASECSIMUL_E131_GUEST_MARK_TRACE=1`.

Compilation passed for QEMU, firmware, and harness. The latest built hashes
were:

- QEMU build executable:
  `C:\SourceCode\qemu_lasecSimul\build-ucrt64\qemu-system-xtensa.exe`
  SHA-256 `28F558F2D15D3A152B42B6A23E2BDC354475C219121CE8CF758F9D6D241F2470`
- firmware merged bin:
  `vnext_prototype/guest_cache_wait_e2e/.pio/build/esp32/merged.bin`
  SHA-256 `D9C514DE72436DF7BC78188894EEDBC9FFD18DED62E7FC73D93FF7FDCDFBB4B4`
- firmware ELF:
  `vnext_prototype/guest_cache_wait_e2e/.pio/build/esp32/firmware.elf`
  SHA-256 `46DB8D3FBBC4D5101A3116030803A7172421F77F27F60112B9A11A730851D9AB`

The latest compact integrated run was:

`vnext_prototype/mttcg_causality/E131-cache-wait-e2e/runs/core_e2e_20260906_100912.err`

It observed real cache-wait activity (`suspend=6 release=6 resume=6
replay=2 legitimate_illegal=9 reset_clear=4`) and no compensatory cache IRQ
in the sampled events, but it failed the mandatory replay-PC gate. Example:

`resume_committed ... replay_owed_pc=0x400d1d0f target_appcpu_pc=0x40080340 target_pc_match=0`

This violates the E131-A stop condition “não for possível provar replay do
PC”. No E131 candidate was copied to `candidate_qemu/`, no runtime was
promoted, and `QEMU_RUNTIME.json` was not intentionally edited by this
attempt.

## E130-CORRECTION — N=16 classification and reset accounting (2026-09-06)

This correction supersedes only E130's unsupported causal label; the original
E130 narrative remains below as history. The classification is provisionally:

`software-reset cascade with unknown initiating panic under N=16 contention`

The preserved E130 N=16 aggregate stderr contains 44 physical reset lines. A
recount of the actual lines, deduplicated by `pid`, `boot_epoch`, reset
`count`, `mask`, both CPU PCs and `source`, contains 36 distinct reset events:
32 expected events (cold boot plus one APP-CPU startup reset for each of the
16 sessions) and four unexpected events (two each for sessions 13 and 14).
The 8-line difference is dump repetition: the complete four-line blocks for
PIDs 42984 and 63836 are each printed twice in the aggregate log. The summary's
44 was therefore a raw-line count, not an event count.

For PID 42984, the observed order in each repeated block is `count=1` cold
boot, `count=2` expected APP-CPU startup, `count=3` unexpected
`SW_CPU_RESET_REGISTER` with `cause0=1,cause1=12`, then `count=4` unexpected
`SW_CPU_RESET_REGISTER` with `cause0=12,cause1=12`. PID 63836 has the same
order; its count-3 PCs differ slightly. These logs do not prove that count 3
and count 4 belong to one `esp_restart_noos()` invocation, nor whether this is
a complete reboot or consecutive ESP-IDF software resets. No
`PANIC_CAUSAL_TRACE` frame, exccause/pseudo-exccause, TG0/TG1 expiry/feed or
interrupt-matrix snapshot, cache-illegal status, QEMU virtual/host clock
correlation, or CPU-wait interval was recorded. `MWDT_ATTRIB_RESETS=0`,
`artifactFatal=false`, `teardownClean` was not emitted in the old summary, and
the JSONL records show `submissions=0` for both sessions.

Consequently, neither TG0, TG1, CACHEERR, exception, host starvation nor
oversubscription is declared as the cause. The old phrase
`TG-watchdog-under-oversubscription` is not proved and must not be used as a
classification. The old runner also failed to surface the child exit code;
the source path and `PRODUCTION_SCALE FAIL failures=2` establish the harness
result as exit code 1, but the historical summary itself did not capture it.

The four-cell capacity comparison (N=12/R=6, N=16/R=6, N=16/R=0,
N=13/R=6) was not run after this correction because the first available N=16
reset had no causal frame, satisfying the stop condition. Existing evidence
only establishes the fresh formal N=1, N=8 and N=12 cells as passing, and
N=16/R=6 as failing. The conservative validated admission point is therefore
N=12; 13 sessions is only the 26-vCPU-slot arithmetic ceiling with six cores
reserved, not a proven safe capacity.

The integrated cache-wait firing/replay proof also remains open. The existing
27 tests are pure state-transition tests; no deterministic end-to-end test has
yet driven the real `MemoryRegion` callback through suspend, release, replay
and reset-during-wait. No probabilistic retry is counted as proof.

> Entries are newest-first. E097 onwards were produced by the 2026-09-03
> consolidation audit. **Read the warning in E099 before trusting any timing
> number in an older entry.**

## E130 - Two SEPARATE objectives closed. (A) Cache-wait interlock exercised end-to-end against a
real reset-during-wait gap FOUND and FIXED (APP CPU could be reset while cache-wait-parked and
never wake -- `esp32_app_cpu_reset_async()` never called `cpu_resume()`); stop/resume ownership
audited against global pause/reset/teardown, not accepted on the unproven "never coexist" comment.
(B) B11 N=8's `submissions=completions+1` delta PROVEN (not just declared) to be a harness
measurement race, not a transport loss, via direct code reading AND a live repro
(`postCutSubmissions` up to 598 observed 3/3 times); fixed with a frozen per-session
submission-cutoff + drain-to-watermark gate, proven both by 7 deterministic RED/GREEN unit tests
and by 3x live N=8 runs (24 sessions, zero false failures). Formal B11 restart (fresh, not reusing
prior N=1/N=8): **N=1/N=8/N=12 PASS, N=16 FAILS on the pre-existing, separately-tracked
TG-watchdog-under-oversubscription issue (zero cache/CACHEERR involvement) -- stopped there per
instruction.** `QEMU_RUNTIME.json` NOT touched (2026-09-05)

### Fase 0 -- identity, documentation corrections, SHA reconciliation

**Correction to E129's own claim** ("B11 N=1 PASSES for the first time in this investigation's
history"): false, and this entry corrects it without erasing E129's text. E120's own entry (this
file, 2026-09-05) already recorded a clean B11 N=1 PASS (`cellPass=True`, 1/1 sessions clean) before
E129 existed. What IS true and specific to E129: it was the first B11 N=1 to pass **after the E128
deadlock was fixed** -- E127/E128's own N=1 attempts (silent-workload finding, then the proven
deadlock) never reached a clean N=1 at all in that narrower window. E129's sentence should be read
as "first N=1 pass since the deadlock was introduced/fixed", not "first ever" -- the latter is
factually wrong per E120.

**`8CF5A800...` vs `D9577DAF...` reconciliation (E128's two diagnostic rebuilds), resolved by
locating files on disk and recomputing hashes, not by inference**: `D9577DAF109A260FBA173E924BEB
1D1DB2CAE06BAA8C0196937BEDEB3E95DDA5` is recoverable -- present at
`E126-tg1-intwdt/diag_candidate_e127/qemu-system-xtensa.exe`, recomputed hash matches exactly.
`8CF5A800006FAFFF89899E41CA8A84056FFD1AE7FC6DF55CC6C597F0AAF27C0404` is **not recoverable** -- no
file with that hash exists anywhere under `vnext_prototype/mttcg_causality/`. This diagnostic build
was staged in place (not to its own immutable directory, unlike final candidates) and was
overwritten by the second rebuild before being archived. Declared explicitly rather than assumed:
E128's attempts B/C (the ones that used the first rebuild) cannot be re-run bit-for-bit against the
original diagnostic binary; the finding itself does not depend on this, since attempts D/E (the
actual causal A/B proof) used the still-recoverable `D9577DAF...` build, already correctly cited in
E128's own correction paragraph.

**All previously preserved artifacts reconfirmed byte-identical, recomputed this session (not
assumed carried over)**: canonical `B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD
936E`, E121 `D7A2896D843FBC6C5386CF57690292A37A4EDFA58A207C4E612E325B879C838C`, E122 `AA3B7CA65445
A6751D28748A4407853B06736AAFE9771405CE9143767B3ED029`, E126 B11 immutable candidate `3D65BD36D27
D380207D0A0DAC1100AD9CCE702C5B6BA6A642E4A745437073FC2`, E129 `A09934CC185170693BC413FE7FE3069333
3B394F109CFDF092EED63D2E6AEAFC`. Firmware/ELF unchanged: `merged.bin` `1da8bf731830b2d2d9ce6edbb
0ea208636a1db2a79497a8db0cc98d72864c76a`, `firmware.elf` `1697587b58f9df862765adabc2f5a2e74387863
438d8a6df775196a542c9d9b6`. New work staged to its own directory, never overwriting any of the
above: `E130-drain-cutoff/candidate_qemu/`, final SHA
`444F4B1795AC6518E2A01357E3F5C223D3F1F1614BCBAB27B60B03EB22844157` (an earlier same-session
rebuild, `B70A505048631A161F17B51D138741E4BD65F29ED660F754BAE54AE84F3E1335`, had the reset fix but
not yet the Fase 3 diagnostic counters -- superseded, not separately preserved, since nothing was
validated against it beyond a compile check). Core Release harness after the Fase 5 drain/cutoff
edit: `81A7472B0861EDA5EB0E12E42467C346C4B86778B204C8B9B3FC9F03DF43AB96` (was `270BEAF9458B21C86B6
EC09352EECBE4D5558EA9585CEE5567A3092760161310` before this session's edits).

### Fase 1/2 -- cache-wait mechanics + stop/resume ownership audit

Re-read `esp32_dport.c`/`.h`, `esp32_cache_race_stall.h`, `vnext_b.c`/`.h`, and did a full
`grep -rn "cpu_stop_current\|cpu_resume("` sweep of the fork (every call site enumerated, not
sampled) plus `softmmu/cpus.c` in full: `qemu_cpu_stop()`, `qemu_wait_io_event()`/
`qemu_wait_io_event_common()`, `cpu_resume()`, `cpu_stop_current()`, `cpu_is_stopped()`,
`cpu_thread_is_idle()`, `resume_all_vcpus()`, `pause_all_vcpus()`/`all_vcpus_paused()`. Confirmed
mechanically (not assumed): `esp32_cache_ill_read()` is the single choke point for both load and
instruction fetch through a disabled DROM0/IRAM0 region (both dispatch through the same
`MemoryRegionOps.read`); `vnext_cache_wait_suspend_current_cpu()` calls
`cpu_loop_exit_restore(cpu, cpu->mem_io_pc)`, which restores exactly the faulting PC (the same
primitive every existing VNEXT_B retry site already relies on); `reentrancy_probe_exit()` is called
before the longjmp and `illegal_access_trap_mem.disable_reentrancy_guard = true` was already set in
E129, so the MemoryRegion reentrancy guard cannot be left engaged; the illegal-access sentinel read
this callback performs has no side effect, so a replay can never duplicate one.

**Did not accept "cache wait and VNEXT_B backpressure can never coexist" as given** (it was an
E129-era comment, unverified). Verified structurally: `cpu_stop_current()` always operates on
`current_cpu`, i.e. it can only ever be called by a CPU's own vCPU thread targeting itself, and
every `cpu_stop_current()`+`cpu_loop_exit_restore()` pair immediately unwinds the call stack via
siglongjmp -- there is no call stack on which two independent stop reasons could nest for the same
CPU. This part of the old comment holds.

**Audited the four things the old comment never addressed, per instruction, and found one real
bug**:
- **Global VM pause** -- `cpu_is_stopped(cpu) = cpu->stopped || !runstate_is_running()`
  (`softmmu/cpus.c:76`), an OR of two INDEPENDENT conditions. Cache-wait's `cpu_resume()` only
  clears `cpu->stopped`; it cannot wake APP CPU early during a global pause because the runstate
  term independently holds it parked. Conversely, `resume_all_vcpus()` clearing `cpu->stopped` for
  a still-cache-waiting APP CPU (VM resumed before the disabled region was re-enabled) is harmless:
  APP CPU merely replays the same faulting access, re-detects the still-disabled region via
  `esp32_cache_access_should_wait()`, and re-suspends itself -- no duplicated side effect, since the
  read it performs has none. Proven safe, not merely asserted.
- **Reset -- a REAL gap, found and fixed, not hypothetical.** `esp32_app_cpu_reset_async()`
  (`hw/xtensa/esp32.c`, reached by BOTH the `SW_CPU_RESET_REGISTER` per-CPU-reset path and the
  `MWDT_CPU_STAGE` TG0/TG1-per-CPU-watchdog path -- confirmed both route through it via
  `async_run_on_cpu`, deliberately bypassing `qemu_system_reset_request()` per its own comment,
  "under MTTCG the requesting PRO CPU could race the delayed global reset handler") called
  `cpu_reset(cs)` but never called `cpu_resume(cs)`. `cpu_reset()`/`cpu_common_reset_hold()`
  (`hw/core/cpu-common.c`) resets registers/PC/`halted`/`icount_extra` but never touches
  `cpu->stop`/`cpu->stopped` -- confirmed by reading the function, not assumed. A reset landing
  while APP CPU was cache-wait-parked would reset its registers to the boot vector and leave it
  **permanently asleep** in `qemu_wait_io_event()`'s `cond_wait` -- a reset CPU that never actually
  resumes. The full-system-reset path (`esp32_dig_reset()`/`esp32_timg_sys_reset()`, which DOES go
  through `qemu_system_reset_request()`) does not have this gap, because
  `pause_all_vcpus(); qemu_system_reset(...); resume_all_vcpus();` unconditionally calls
  `cpu_resume()` for every CPU as part of that sequence (`softmmu/runstate.c:699-701`) -- this is
  exactly why the gap was invisible to the two full-reset paths and only affects the two per-CPU
  ones. **Fixed**: added `cpu_resume(cs)` in `esp32_app_cpu_reset_async()` right after `cpu_reset(cs)`
  (`hw/xtensa/esp32.c`), mirroring `resume_all_vcpus()`'s own unconditional per-cpu call. Safe for
  the same self-correcting reason as the pause case above (whatever the CPU was waiting for is moot
  once its registers are reset), and does not bypass RUNSTALL (`esp32_cpu_stall()`, called right
  after, on the same line region), which is the actual, orthogonal mechanism holding APP CPU from
  making progress during controlled startup.
- **Teardown** -- no new risk found. Cache-wait reuses the exact generic
  `cpu_stop_current()`/`cpu_resume()` primitives every other established caller (VNEXT_B, gdbstub,
  `vm_stop`) already relies on; it introduces no new wait primitive teardown would need to learn
  about separately. Empirically: every N=1/N=8/N=12 run this session (including under the reset
  fix and heavy `CACHE_TRACE`-induced reset churn) showed `teardownClean=true`, zero orphans.
- **Explicit ownership/generation scheme** -- NOT implemented, and the audit above is the reasoning
  for why it isn't needed: APP CPU can only ever have one self-initiated stop reason in flight at a
  time (structural, not policy), and the two cross-cutting interactions that exist (global pause,
  reset) are either already safe by the independent-OR-condition and self-correcting-replay
  properties, or (reset) fixed at the actual gap instead of by adding a generation counter on top of
  a still-broken interaction. A bare boolean remains correct here specifically because of these
  proven properties -- this is not "not using a contract", it's a contract discharged by the
  single-CPU-single-thread-single-in-flight-stop invariant instead of by a counter.

### Fase 3 -- integrated end-to-end proof of the cache-wait interlock

Added seven named counters directly in `esp32_dport.c` (`wait_detected`, `suspend_committed`,
`release_observed`, `resume_committed`, `instruction_replayed`, `legitimate_illegal_access`,
`wait_generation`), incremented at the real call sites (not mocked), plus a bounded-frequency
(fires per wait episode, not per instruction) `LASECSIMUL_CACHE_WAIT_DIAG_TRACE` stderr line.
`instruction_replayed` is proven, not assumed, to correspond to an actual replay:
`cpu_loop_exit_restore()` guarantees the very next thing APP CPU does is re-fetch/re-load the exact
faulting address, so the next `esp32_cache_ill_read()` call attributed to APP CPU after a
`resume_committed` IS that replay by construction.

**Natural (real-firmware) reproduction attempted across 7 configurations this session: N=1/30s
quiet, N=1/120s quiet (hit an unrelated pre-existing MWDT_SYS_STAGE reset, workload still
recovered), N=8/60s quiet, and 4x N=8/60s with `LASECSIMUL_CACHE_TRACE=1` (the E124-established
technique for widening this exact race's timing window, `E124-cacheerr/repro_loop.ps1`) -- zero
`wait_detected` events observed in any of the 7. Not a negative result: the CACHE_TRACE-perturbed
runs instead triggered heavy, unrelated `SW_CPU_RESET_REGISTER`/TG-watchdog reset churn (8-15
unexpected resets per session, `workloadPass` still true in every case -- the E130 drain/cutoff fix
holds even under that churn), consistent with DECISION-007/013's warning that this trace perturbs
timing, just not in the direction needed here. **Honest status: the compensable cache-wait path
(the interlock's own reason for existing) was NOT observed firing live this session** -- the 27
pure-function tests and the Fase 1/2 mechanical/structural proof above stand on their own, but the
"real end-to-end firing, with a real replayed read returning a real correct value" proof Fase 3
asked for is not yet captured. Counters and infrastructure are in place, verified not to perturb or
break normal operation (all N=1/N=8/N=12 runs this session, with and without the new trace, show
identical `workloadPass`/reset behavior to before this instrumentation existed), ready for the next
session to either run more attempts, extend runtime further, or add a deterministic
monitor/GDB-driven injection instead of relying on incidental timing.

### Fase 4 -- the B11 N=8 delta, proven (not declared) to be a harness race

**Proven by direct code reading**: `McuComponent.cpp`'s `dispatchOneEvent()` (kind==BATCH branch)
increments `m_vnextI2cSubmissionCount` (line ~1123), then synchronously calls
`m_i2cTransferHandler(...)`, then increments `m_vnextI2cCompletionCount` (line ~1148) only if
`respondToI2c()` publishes successfully -- all on the SAME call, on a single-consumer thread
("Single-consumer operation under `m_callbackState->mutex` makes this unreachable in practice",
the code's own comment, confirmed structurally: the outer `for(;;)` drain loop in
`McuComponent.cpp` consumes one lane event, fully dispatches it, and only THEN consumes the next).
This means completion count is a strict, gapless prefix of submission count UNLESS a publish
genuinely fails, in which case completion count permanently stalls (a real, detectable loss, not a
race). E120's own convergence-wait loop (`VnextBProductionScaleTest.cpp`, pre-E130) polled
`submitted != completed`, broke on the first observed equality, and then a SEPARATE, LATER
per-session loop re-read both counters fresh for the actual pass/fail decision -- with the guest
still running, unpaused, in between. A submission (and its near-simultaneous completion) landing in
that gap is exactly a `submissions=completions+1`-shaped artifact.

**Proven live, not just by static analysis**: with the Fase 5 fix's `submissionsAtCut`/
`completionWatermarkAtCut`/`completionWatermarkAfterDrain`/`postCutSubmissions` JSONL fields
wired in, the very first post-fix N=8 run showed session 7 with
`completionWatermarkAtCut=47521` (already equal to the frozen cutoff -- the drain condition was
satisfied instantly) but `completionWatermarkAfterDrain=47782`, `postCutSubmissions=261`: 261 more
requests were submitted AND completed in real time after the measurement cutoff was captured.
Repeated 3/3 times (`E130-drain-cutoff/n8_run{1,2,3}`, 24 sessions total): 13 of the 24 sessions
showed nonzero `postCutSubmissions` (range 30-598), zero showed a false failure. This is a direct,
repeated observation of exactly the "equality observed -> new submission -> stale-window re-read
would show a delta" sequence Fase 4 asked to be proven, not merely asserted.

### Fase 5 -- the drain/cutoff fix

Implemented in `VnextBProductionScaleTest.cpp`: at the `runMs` deadline, freeze each session's
current `vnextI2cSubmissionCountForTesting()` as `submissionCutoff[i]` (and its paired completion
count as `completionAtCut[i]`, diagnostic only) exactly once, before any waiting. Replace the old
raw-equality convergence poll with `waitForAllToDrain()` (new,
`core/src/mcu/qemu/DrainCutoffGate.hpp`): wait, per session, for
`vnextI2cCompletionCountForTesting() >= submissionCutoff[i]` (never re-reading the cutoff), bounded
by the existing ~3s deadline, now also producing `drainTimeout`. Reported `submissions`/
`completions` use the frozen cutoff and `min(completedAfterDrain, cutoff)` -- never a fresh
re-read -- so the existing `workloadPass = submitted>0 && submitted==completed && !artifactFatal`
formula (unchanged) becomes correct without its own logic being touched. New JSONL fields:
`submissionsAtCut`, `completionWatermarkAtCut`, `completionWatermarkAfterDrain`,
`postCutSubmissions`, `drainComplete`, `drainTimeout`.

**Properties required before relying on `completionCount >= cutoff` (not proven by assumption)**:
monotonicity -- `fetch_add(1, memory_order_relaxed)`, never decremented outside teardown/reset;
no reordering -- single-consumer FIFO dispatch (Fase 4's finding, above) means completion N can
never be recorded before completion N-1's predecessor submissions have all been processed;
wraparound -- `uint64_t`, impossible within any test's duration; correspondence -- a permanent
publish failure permanently stalls completion count below any later cutoff, so it is a sound proxy
for "everything before the cutoff answered", never a coincidental count match that could mask a
real loss. All four verified by reading the actual dispatch code, not assumed.

### Fase 6 -- deterministic RED/GREEN tests for the gate itself

New `core/test/core/mcu/DrainCutoffGateTest.cpp` (target `drain_cutoff_gate_test`, added to
`run_regression.ps1`'s list, now 14 tests), against synthetic counters, no QEMU/Core session
needed: already-drained-at-cut; post-cut activity does not affect the gate (the Fase 4 scenario,
reproduced deterministically in milliseconds); one in-flight request at the cut instant that
completes during drain (gate must actually wait, confirmed by elapsed-time assertion, not just
check once); **a genuinely lost pre-cut request times out** (the critical negative control -- the
gate is not simply "always pass"); a frozen counter from a stopped/crashed session times out via
the same path (no separate logic needed); multi-session gate waits for the slowest session; one
lost session in a multi-session gate fails the whole gate even with healthy siblings. All 7 PASS.

### Fase 7 -- validation matrix (run after Fase 1-6 above, before B11)

27/27 QEMU pure-function unit tests (`test-esp32-dport-cache-race-stall`, unchanged, re-run against
the new binary), 7/7 `test-esp32-timg-pause` (unrelated, confirms no collateral damage). Two
unrelated, pre-existing QEMU upstream test-suite link failures (`test-vmstate.exe`,
`tests/qtest/qos-test.exe`, both `undefined reference to qemu_ftruncate64`, nothing esp32-specific)
-- confirmed pre-existing and out of scope, not investigated further. Core regressions against the
E130 candidate (`444F4B17...`), Debug config, all 14 tests (13 prior + the new
`drain_cutoff_gate_test`): 2x VNEXT_B+MTTCG = 14/14 + 14/14; 1x LEGACY+MTTCG = 14/14. 1x N=1 (clean,
`cellPass=True` via `b11_classify.ps1`) + 3x N=8 (all clean, zero false failures, the Fase 4 live
proof above) as pre-B11 confirmation that the fix holds outside the formal campaign too.

### Fase 8 -- B11 restarted from scratch (fresh directory, N=1/N=8 NOT reused from Fase 4/7 above)

`E130-drain-cutoff/B11_formal/`, classified via `b11_classify.ps1`'s `Get-B11CellSummary`:

- **N=1: PASS.** `cellPass=True`. 1/1 sessions clean, `submissions=completions=4358`,
  `teardownClean=true`, zero unexpected resets.
- **N=8: PASS.** `cellPass=True`. 8/8 sessions clean (including sessions 3 and 5, the exact ones
  that showed the delta in E129's own run) -- `submissions=completions` exactly for every session,
  zero unexpected resets, `teardownClean=true`.
- **N=12: PASS.** `cellPass=True`. 12/12 sessions clean, zero unexpected resets, `teardownClean=true`.
- **N=16: FAIL.** `cellPass=False`. 14/16 sessions clean; sessions 13 and 14 each show
  `appCpuStartupCount=1, uniqueResets=4, unexpectedResets=2, submissions=0, completions=0,
  workloadPass=false` -- the guest never progressed past a repeated boot-reset cycle in either
  session. **Confirmed NOT a cache-wait/CACHEERR regression**: zero occurrences of "cache" or
  "exccause=7" anywhere in the full N=16 log (`grep -ci`); every reset in the entire run is tagged
  `source=OTHER` (the expected once-per-session boot reset) or `source=SW_CPU_RESET_REGISTER` with
  `cause=12` on both CPUs -- the signature of the pre-existing, SEPARATE, already-documented
  TG-watchdog-reset-under-severe-oversubscription phenomenon (32 vCPU threads on 26 usable cores),
  frozen behind its own DECISION-004 gate, not part of this session's scope and not touched.
  **Stopped here per instruction** -- N further and B12 not attempted.

### Promotion

`QEMU_RUNTIME.json` NOT updated. Blocked on: Fase 3's live end-to-end firing proof still open;
B11 N=16 failing (for a reason outside this session's scope, but B11 as a whole is not green).

## E129 - E128's cache-race deadlock FIXED: replaced E124/E125's blanket `xtensa_runstall()` with a
per-access interlock (`cpu_stop_current()`/`cpu_loop_exit_restore()` inside the illegal-access-trap
read callback, the same idiom already proven for VNEXT_B backpressure) -- CACHEERR protection
preserved, 27/27 new+existing pure-function tests, 10/10 real-firmware N=1 clean, all regressions
green, **formal B11 restart: N=1 PASSES for the first time in this investigation's history, N=8
STOPS on a genuinely NEW, different symptom** (two sessions show `submissions` exceeding
`completions` by exactly 1, zero resets/deadlock/reentrancy-block) -- N=12/N=16 not attempted,
`QEMU_RUNTIME.json` NOT touched (2026-09-05)

### Scope

Does not reopen CACHEERR (E124/E125) or the residual TG1/`SW_CPU_RESET_REGISTER` mechanism
(E111/E126/E127, still separately open). Fixes exactly the deadlock E128 proved: E124/E125's
`appcpu_cache_race_stall` compensation applied a blanket `xtensa_runstall()` to ALL of APP CPU's
execution the instant a different core disabled one of its cache regions -- including, as observed,
while APP CPU was mid-interrupt-return inside its own legitimate, `IRAM_ATTR`
`spi_flash_op_block_func()` busy-wait, which never touches the disabled region and needed no
protection at all. Freezing it there anyway deadlocked the system permanently.

### Fase 0 -- preservation

Reconfirmed byte-identical before and after all work below: canonical `B375A9E830705F673800
C703A450871D2B3616D06938365671ABD6A3DFDD936E`, E121 `D7A2896D843FBC6C5386CF57690292A37A4EDFA58A20
7C4E612E325B879C838C`, E122 `AA3B7CA65445A6751D28748A4407853B06736AAFE9771405CE9143767B3ED029`, the
E126 B11 candidate `3D65BD36D27D380207D0A0DAC1100AD9CCE702C5B6BA6A642E4A745437073FC2` (immutable
copy at `E126-tg1-intwdt/candidate_qemu_3D65BD36/`), the E127 diagnostic
`D9577DAF109A260FBA173E924BEB1D1DB2CAE06BAA8C0196937BEDEB3E95DDA5`. Firmware/ELF unchanged
(`merged.bin` `1da8bf73...`, `firmware.elf` `1697587b...`). New work staged to its own, separate,
never-overwritten directory: `E129-cache-wait-interlock/candidate_qemu/`, SHA
`A09934CC185170693BC413FE7FE30693333B394F109CFDF092EED63D2E6AEAFC`.

**Correction to E128's own numbers, per an explicit audit request -- not a new error, a
clarification of already-correct data**: E128's report stated `cpu0_exec_entries`/
`cpu1_exec_entries` "82->79" in prose, which reads as a decrease for a cumulative, monotonically-
increasing counter. The actual logged values (`EVIDENCE.md` E128's own text, unchanged) are
`79/86 -> 82/91` -- correctly increasing. The "82->79" was an error in that turn's spoken summary
only, not in any saved file; flagged here for the record, nothing to correct in E128 itself.
Separately, that same audit found a real documentation gap this entry fixes: E128's attempts D/E
(the causal A/B proof itself, `submissions=0` vs `submissions=6168`) ran against a **second**
diagnostic rebuild whose SHA (`D9577DAF...`) was never previously recorded -- E128's own text only
gave the first rebuild's SHA (`8CF5A800...`, correct only for attempts B/C). A correction paragraph
was added to E128's own entry (not deleted, appended) recording both SHAs and which attempts used
which -- the two builds differ only by two purely-additive diagnostic extras, so the finding itself
is unaffected.

### Fase 1 -- audit findings

Read `esp32_dport.c`/`.h`, `esp32_cache_race_stall.h`, `esp32.c`, and the E124-E128 evidence in
full. Confirmed exactly what E128 already established (mask acquired in Phase A of
`esp32_cache_state_update()`, released in Phase C, reaching `appcpu_stall_req` via
`esp32_dport_update_appcpu_stall()` -> `esp32_cpu_stall()` -> `xtensa_runstall()`) and additionally
traced the illegal-access-trap overlay mechanics precisely: each cache region is two overlapping
`MemoryRegion`s at the same address (the real ROM-backed device, and `illegal_access_trap_mem`, a
plain `memory_region_init_io` device with only `esp32_cache_ill_read()` as `.read`); when the real
region is disabled, QEMU's overlay-priority mechanism routes ALL accesses -- data loads AND
instruction fetches alike, confirmed by reading `accel/tcg/cputlb.c`'s `io_readx()`, which is
structurally symmetric to `io_writex()` (same `cpu->mem_io_pc = retaddr` capture, same
`QEMU_IOTHREAD_LOCK_GUARD()` around the dispatch, differing only in `access_type`) -- to this one
callback. This is the single correct choke point to distinguish a compensable race from a genuine
illegal access, and it already runs under the BQL for its entire duration.

**A real architectural constraint found only by a failed build, not anticipated**: `hw/misc/
esp32_dport.c` is compiled into `libcommon.fa`, QEMU's target-independent shared library, and
cannot include `exec/exec-all.h` (which pulls in the target's own `cpu.h`) -- confirmed by a
`fatal error: cpu.h: No such file or directory` build failure, not assumed. `softmmu/vnext_b.c` IS
compiled per-target (`softmmu/meson.build`) and already hosts every other `cpu_loop_exit_restore()`
call site in this fork for exactly this reason (`esp32_i2c.c`/`esp32_uart.c` call thin wrappers
implemented there, e.g. `vnext_b_i2c_submit()`, never the primitive directly) -- this entry follows
the same established pattern rather than inventing a new one.

### Fase 3 -- safety, proven not assumed

- `cpu->mem_io_pc` is populated identically for the read path (confirmed in `io_readx()`, mirroring
  the write path every existing VNEXT_B retry site already relies on) -- safe to pass to
  `cpu_loop_exit_restore()`.
- The callback runs entirely under the BQL (`QEMU_IOTHREAD_LOCK_GUARD()` in `io_readx()`) --
  confirmed directly, not assumed.
- `cpu_stop_current()`/`cpu_resume()` operate on `cpu->stop`/`cpu->stopped` -- a completely
  different, orthogonal axis from `xtensa_runstall()`'s `env.runstall` (reset/clkgate/RUNSTALL).
  This means the fix requires no new "coexistence" logic at all: the two mechanisms already do not
  interfere by construction, satisfying the task's own "não misture os motivos" requirement for
  free.
- Lost-wakeup is architecturally impossible: both the suspend (APP CPU's own trap-read dispatch)
  and the resume (PRO CPU's own re-enable write dispatch, in `esp32_cache_state_update()`'s Phase C)
  are BQL-serialized MMIO dispatches on their respective CPUs' own threads -- they cannot interleave,
  so APP CPU is always fully marked stopped before PRO CPU's release code can possibly run.
- `reentrancy_probe_exit()` must be called immediately before the `siglongjmp`, per `softmmu/
  reentrancy_probe.h`'s own documented contract for any new retry site -- done.
- `disable_reentrancy_guard = true` set on `illegal_access_trap_mem` (extends DECISION-014, same
  justification: this retry path never releases the BQL, so the guard's own hazard cannot occur
  through it).

### Fase 2/6 -- design implemented

`Esp32DportState::appcpu_cache_race_stall_mask`/`appcpu_cache_race_stall` (bool) are GONE. Replaced
with two masks: `appcpu_cache_externally_disabled_mask` (renamed from the old mask, pure
bookkeeping, UNCHANGED gain/release computation via the existing, still-valid
`esp32_cache_race_stall_gain()`/`_release()`) and `appcpu_cache_wait_mask` (new -- set only when
APP CPU's own access actually lands on a disabled region). `esp32_cpu_stall()` no longer has a
cache-race OR-term at all. `esp32_cache_ill_read()` now checks `esp32_cache_access_should_wait()`
(new pure predicate) before doing anything else; if true, it suspends via
`vnext_cache_wait_suspend_current_cpu()` (the `softmmu/vnext_b.c` wrapper) and never returns a
sentinel or raises the IRQ for that access. `esp32_cache_state_update()`'s Phase C now also calls
`esp32_cache_wait_release()` and, when it reports the last pending reason cleared, `cpu_resume()`
directly on APP CPU. Every genuinely-illegal access (permanently-masked region, PRO CPU's own
access, self-disable, unattributed writer) falls through to the unchanged sentinel+IRQ logic.

### Fase 4 -- deterministic tests

`tests/unit/test-esp32-dport-cache-race-stall.c` extended from 13 to **27** tests, all passing: the
original 13 (gain/release, unchanged, still valid) plus 14 new ones covering
`esp32_cache_access_should_wait()`/`esp32_cache_wait_release()` -- APP CPU's own DROM0/IRAM0 access
while externally disabled (must wait), APP CPU running physical-IRAM code outside any tracked
region (must never wait -- the exact deadlocking scenario), region already re-enabled (must not
wait), PRO CPU's own region and PRO CPU accessing APP's region (must never wait -- preserves
genuine CACHEERR), unattributed accessor, self-disable's mask-level exclusion, a permanently-masked
region falling through to genuine-illegal handling, per-region release independence (releasing
DROM0 must not wake a wait pending on IRAM0), and an exhaustive sweep proving no wait-mask state
can ever fail to clear when released.

### Fase 5 -- real reproduction

The exact scenario that deadlocked in E128 (N=1, 15s, this firmware): **`submissions=6820
completions=6820`, `PRODUCTION_SCALE_1_ACTIVE PASS`** on the first attempt. A second attempt with
`LASECSIMUL_CACHE_TRACE` enabled (to try to directly capture a `cache_wait_suspend` event) showed
`submissions=714` (still fully healthy, still PASS) but the interlock's own wait path did not fire
naturally in that window, AND a `source=SW_CPU_RESET_REGISTER` cascade appeared -- **confirmed as
the already-known, separate TG1-IntWDT/E111 mechanism** (not CACHEERR, not this entry's own
deadlock), consistent with DECISION-007/013's own documented finding that heavy tracing perturbs
MTTCG timing enough to expose that specific, separate, host-scheduling-sensitive mechanism.
Preserved, not chased further, not mixed with this entry's own fix. **10/10 N=1/15s attempts** with
formal JSONL classification: all `cellPass=True teardownClean=True unexpectedResets=0
workloadPass=True`, submissions ranging 6125-7138, `submissions==completions` on every single one.
Zero orphans throughout. A naturally-occurring direct capture of `cache_wait_suspend` itself was not
obtained within this session's effort budget -- disclosed, not hidden; the fix's correctness rests
on the pure-function tests (Fase 4) and the consistent real-firmware absence of the deadlock (Fase
5/7) instead.

### Fase 6 -- regressions

New unit suite 27/27; `test-esp32-timg-pause` 7/7, `test-vnext-b-classify` 9/9, `test-esp32-panic-
trace-gate` 6/6 (all unaffected, reconfirmed). `vnext_b_attachment_test` 31/31 (incl. `B11_
DECISION_014_REENTRANCY_CONCURRENCY_PROBE PASS max_concurrent=1`, `E118_AUDIT_UART_BACKLOG_NO_LOSS`,
`E118_AUDIT_I2C_CONTINUATION_NO_DESYNC`), `mcu_component_live_poll_thread_test` all OK,
`session_restart_stress_test` 15/15 -- all against the E129 candidate specifically
(`LASECSIMUL_TEST_QEMU_BINARY` override, confirmed). `b11_classify_test.ps1` (synthetic) ALL PASS.
`run_regression.ps1 -QemuBinary <E129 candidate>`: VNEXT_B+MTTCG 13/13 twice, LEGACY+MTTCG 13/13
once -- header confirmed printing `A09934CC...` on all three.

### Fase 7 -- B11 formal restart

**N=1 (60s): PASS.** `cellPass=True`, `submissions=9825 completions=9825`, zero unexpected resets,
`teardownClean=True`, zero orphans. The first time N=1 has ever formally passed in this
investigation's history (E127 stopped here with zero submissions; this entry's own fix is why it
now doesn't).

**N=8 (60s): FAILS -- on a genuinely different, new symptom, not any previously-fixed mechanism.**
`cellPass=False`, but critically: `unexpectedResets=0`, `teardownClean=True`,
`anyBlockedReentrantIo=False`, `anyJsonlStderrMismatch=False` -- none of CACHEERR, the TG1/reset
cascade, the reentrancy-guard bug, or this entry's own deadlock recurred. Two of eight sessions
(3 and 5) show `submissions` exceeding `completions` by **exactly 1**
(`31293`/`31292` and `48222`/`48221`), both with `terminalRunning=true` at teardown. **Not
classified further this session, per this task's own explicit stop condition** ("encontrar uma
falha diferente" -> stop immediately, no retry, no speculation). Two honest, disclosed
possibilities, neither asserted: (a) a genuine, rare lost/dropped I2C completion under N=8's host
contention, not previously observable because every prior N=8 attempt in this investigation's
history failed earlier via CACHEERR, the TG1 cascade, or this entry's own now-fixed deadlock before
ever reaching a state where this specific off-by-one could be measured; or (b) a benign artifact of
`stopSimulation()`'s 60s cutoff catching exactly one request mid-flight (a straggler), which N=1's
lower variance / absence of host contention may simply never expose. No diagnostic markers
(`WOULD_BLOCK`/`ackERR`/`lost=`/`Blocked re-entrant IO`) appear anywhere in the log -- none of the
existing opt-in traces were armed for this formal run (correctly, per the task's own "traces
desligados" requirement), so this session cannot distinguish the two possibilities further without
a dedicated, separately-scoped investigation. **N=12/N=16 NOT attempted. `QEMU_RUNTIME.json` NOT
touched.** All artifacts (stderr, JSONL, PID, argv, environment) preserved under
`E129-cache-wait-interlock/B11_formal/{N1,N8}/`.

### Artifacts

`include/hw/misc/esp32_cache_race_stall.h` (extended, two new pure functions, old ones unchanged).
`include/hw/misc/esp32_dport.h` (mask fields renamed/added, bool removed). `hw/misc/esp32_dport.c`
(`esp32_cache_state_update()` Phase A/C rewritten, `esp32_cache_ill_read()` interlock added,
`esp32_dport_update_appcpu_stall()`/`esp32_dport_reset()` updated, `disable_reentrancy_guard` added
to the trap region). `hw/xtensa/esp32.c` (`esp32_cpu_stall()`'s cache-race OR-term removed;
`[APPCPU_STALL_TRACE]` diagnostic updated to the new field names, kept for future use).
`softmmu/vnext_b.c`/`vnext_b.h` (new `vnext_cache_wait_suspend_current_cpu()` wrapper).
`tests/unit/test-esp32-dport-cache-race-stall.c` (13 -> 27 tests). New candidate SHA
`A09934CC185170693BC413FE7FE30693333B394F109CFDF092EED63D2E6AEAFC`, staged at
`E129-cache-wait-interlock/candidate_qemu/` (its own directory, nothing else overwritten).
`E129-cache-wait-interlock/{smoke,cache_trace,n1_validation,B11_formal}/` (all raw logs preserved).

### Next step

B11 is **not yet fully validated** -- N=1 passes, N=8 surfaces a new, undiagnosed
submissions/completions mismatch. The next continuation should investigate THAT specific finding
(not re-litigate CACHEERR, the TG1 cascade, or this entry's own deadlock, all closed) -- likely by
arming a narrow, gated diagnostic on the I2C completion-delivery path specifically
(`vnext_b_i2c_submit()`/`esp32_i2c.c`'s response-publish path) at N=8 scale, and by first
determining whether E109's own existing per-session JSONL teardown ordering could itself explain a
straggler request being counted as submitted-but-not-completed at the exact 60s cutoff, before
assuming a genuine defect. Do not run N=12/N=16/B12 or promote the runtime until that is resolved
and N=8 (then N=12, N=16) pass cleanly the same way N=1 now does.

## E128 - ROOT CAUSE of E127's silent-workload B11 N=1 failure PROVEN, causally, by direct A/B
instrumentation: the E124/E125 `appcpu_cache_race_stall` compensation permanently runstalls APP
CPU while it is frozen mid-interrupt-return (`_frxt_int_exit`) inside its own
`spi_flash_op_block_func()` busy-wait, and the release condition never re-fires -- a genuine
cross-CPU deadlock, not a mask-arithmetic bug. Disabling only this one compensation restores the
workload completely (0 -> 5976-6168 I2C submissions in 15s); the same scenario is clean on E122
(predates the mechanism). **No correction applied**: the first candidate fix has a proven
correctness gap of its own (documented below) and was not shipped. B11 restart correctly NOT
attempted (2026-09-05)

### Correcting E127's own premises, per this task's explicit instruction

`terminalRunning=true` means only that the QEMU process itself is alive -- it says nothing about
guest CPU progress, and is not repeated as evidence of anything here.
`appCpuStartupCount=1` proves only that the expected `SW_APPCPU_RESET_MASK` write occurred once --
it does not prove CPU1 ever left reset/stall, reached `call_start_cpu1`, or executed a single
guest instruction. Both are superseded below by direct, live measurement of CPU1's own PC and
`cpu_exec()` entry count.

### Instrumentation used (all gated, off by default, none new-and-unvalidated except where noted)

- `[VNEXT_PROBE] cpu_exec entered cpu=%d pc=... halted=... stopped=...`
  (`accel/tcg/cpu-exec.c`, gated by the existing `LASECSIMUL_VNEXT_TRACE`) -- pre-existing,
  forgotten, rediscovered this session. Bounded to the first 8 total entries across both CPUs, so
  informative only for early boot -- exactly the window this failure occurs in.
- `vnext_cpu_exec_probe_count(unsigned cpu_index)` (`accel/tcg/cpu-exec.c`) -- pre-existing,
  **unbounded**, always-on per-CPU counter of `cpu_exec()` entries, previously unread by anything.
  Newly wired into the diagnostic below.
- **New** `[APPCPU_STALL_TRACE]` in `hw/xtensa/esp32.c`'s `esp32_cpu_stall()` (reuses the existing
  `LASECSIMUL_APP_CPU_RESET_TRACE` gate, the established umbrella for this device's own
  reset/stall lifecycle diagnostics) -- prints every OR-term the function's own `stall` decision is
  built from (`rtc_cpu_stall_state[1]`, `appcpu_stall_state`, `appcpu_clkgate_state`,
  `appcpu_reset_state`, `appcpu_reset_pending`, `appcpu_cache_race_stall`,
  `appcpu_cache_race_stall_mask`), plus `vnext_cpu_exec_probe_count(0)`/`(1)` and CPU1's live
  `env.pc`, every time this GPIO handler is invoked for APP CPU. No new ring buffer needed --
  invocations are state-change-driven (GPIO edges), not per-instruction, so an unconditional print
  is cheap and bounded by how often the underlying registers actually change.
- **New**, Fase-5-only experimental control: `LASECSIMUL_DISABLE_CACHE_RACE_STALL` (`hw/misc/
  esp32_dport.c`, `esp32_cache_state_update()`'s Phase A) -- when set, the gain side of the E124/
  E125 compensation is skipped entirely (Phase C's release becomes a harmless no-op, GPIO never
  raised for this reason). **Explicitly not a production candidate** -- exists solely to test the
  causal hypothesis, per this task's own Fase 5 instruction.

### The finding, in sequence

1. **N=1, 15s, E126 candidate (`3D65BD36...`), `LASECSIMUL_VNEXT_TRACE=1`**: `[VNEXT_PROBE]`
   repeats `cpu=1 pc=0x40000400 halted=1` -- CPU1's own APP-CPU reset vector -- for every one of
   the (bounded, first-8) samples, while `cpu=0` shows real, changing PCs. Not conclusive alone
   (bounded to early boot) but the first hard signal.
2. **Same scenario, `LASECSIMUL_APP_CPU_RESET_TRACE=1`**: `[APPCPU_STALL_TRACE]` shows the
   *normal* boot-time reset/clkgate stall sequence clearing correctly (`computed_stall` 1->0
   around virtual_ns~908-912ms), then `appcpu_cache_race_stall_mask` cycling cleanly `0x0 <-> 0x3`
   several times (CPU0's own rapid `CACHE_ENA` toggling during early flash-cache setup, exactly
   E124's own previously-diagnosed behavior) -- **then one final `0x0 -> 0x3` transition that never
   reverses again for the rest of the run.** The mask-clearing arithmetic itself is correct by
   direct trace-through (confirmed independently: `esp32_cache_race_stall_release()` unconditionally
   clears both bits the instant both regions read enabled again) -- the absence of any further
   `[APPCPU_STALL_TRACE]` line at all after that point proves `esp32_cache_state_update()` for
   APP's own cache state (`core_id==1`) is **never called again**, i.e. CPU0 never again writes
   `APP_CACHE_CTRL`/`CTRL1` for the rest of the run -- CPU0 itself stops making the progress that
   would eventually re-enable the cache.
3. **Combined run, both gates + `vnext_cpu_exec_probe_count()`**: at the final, permanent gain,
   `cpu1_pc=0x400885c4`. Symbolized against this session's own `firmware.elf`
   (`1697587b58f9df862765adabc2f5a2e74387863438d8a6df775196a542c9d9b6`, unchanged): **`_frxt_
   int_exit`** (`freertos/port/xtensa/portasm.S:182`) -- CPU1 was in the middle of *returning from
   an interrupt*. The transition immediately before it shows `cpu1_pc=0x40082a2d` ->
   `spi_flash_op_block_func` (`spi_flash/cache_utils.c:121`, the exact same busy-wait function
   symbolized in E125/E127's own PID 62440 occurrence) -- CPU1 was legitimately, harmlessly
   spinning in its own `while (!s_flash_op_complete) {}` loop (real, expected ESP-IDF behavior
   during a flash operation on the *other* core), took a routine tick interrupt, and was frozen by
   `xtensa_runstall()` while still unwinding that interrupt's exit sequence. `cpu0_exec_entries`/
   `cpu1_exec_entries` (79/86 -> 82/91 across these two lines) confirm **both CPUs were still
   actively executing instructions right up to this exact moment** -- this is not a pre-existing
   hang; the deadlock is created at this specific instant.
4. **Causal A/B test (Fase 5)**: identical N=1/15s scenario, same candidate, only
   `LASECSIMUL_DISABLE_CACHE_RACE_STALL=1` added:
   `submissions=6168 completions=6168`, `PRODUCTION_SCALE_1_ACTIVE PASS`. **Compensation active:
   0 submissions, harness FAIL. Compensation's cache-race reason alone disabled: full, clean
   workload.** No other variable changed.
5. **Fase 4 control (canonical/pre-E124)**: identical scenario against the E122 candidate
   (`AA3B7CA6...`, predates the compensation entirely): `submissions=5976 completions=5976`,
   `PRODUCTION_SCALE_1_ACTIVE PASS`. Confirms the mechanism is specific to E124/E125's own added
   code, not a pre-existing or environment-level issue.

### Root cause, stated precisely

`esp32_cache_state_update()`'s Phase A engages a full `xtensa_runstall()` on APP CPU **without
regard for what APP CPU is currently doing** -- including, as observed, mid-interrupt-return while
holding whatever interrupt-context state that implies. This was never a problem for the *original*
CACHEERR race (a DROM0 *data read* in ordinary, non-interrupt execution), which is what E124's own
reproduction exercised and what this compensation was built to prevent. But the stall's blast
radius is APP CPU's *entire* instruction stream, not just accesses to the disabled region -- and
`spi_flash_op_block_func()` is explicitly `IRAM_ATTR` (resident in physical SRAM, architecturally
unaffected by the DROM0/IRAM0 *flash-cache* mapping windows this mechanism disables) precisely so
real ESP-IDF can keep it running safely through a cache-disable window. Freezing it anyway, at an
arbitrary point including mid-interrupt-exit, creates a window with no real ESP-IDF equivalent: if
whatever CPU0 does next requires anything that depends, directly or indirectly, on APP CPU making
further progress (here: CPU0 itself never issues another `APP_CACHE_CTRL` write at all after this
point, strongly indicating CPU0 became blocked on something -- most plausibly a FreeRTOS SMP kernel
critical section/spinlock APP CPU was holding at the frozen instant, though the exact resource
was not further isolated this session), the system deadlocks permanently: APP CPU cannot run to
release whatever it holds (externally stalled by QEMU, not by its own choice), and PRO CPU can
never reach the `APP_CACHE_CTRL` re-enable write that would release APP CPU's stall (blocked on
the resource APP CPU holds).

This is **not** a bug in the mask bit-clearing logic itself (`esp32_cache_race_stall_gain()`/
`_release()`, still 13/13 in their own unit tests, still logically correct for every case those
tests cover) -- it is a scope problem in *when* the stall is allowed to engage at all, one none of
E124/E125/E126's own extensive validation (including 8/8 clean N=8 runs) happened to trigger,
because it depends on the precise, MTTCG-timing-sensitive coincidence of a cache-toggle write
landing while APP CPU is mid-interrupt-return in this specific busy-wait -- rare enough not to show
up in short validation runs, but evidently common enough to make the very first formal B11 N=1
cell fail outright.

### Why no fix was applied this session

The first, most obvious candidate -- skip engaging the stall if APP CPU's own `PS.INTLEVEL`/
`PS.EXCM` shows it is currently in interrupt/exception context at the moment of gain (checkable
directly: `esp32_cpu_stall()` already has `s->cpu[1].env` in scope) -- has a real, proven
correctness gap: nothing re-evaluates or re-applies the stall when APP CPU *later* organically
exits that interrupt context, since `esp32_cpu_stall()` is only re-invoked on a subsequent register
write, not on APP CPU's own asynchronous progress. Exempting once and never re-checking would
silently reopen the exact DROM0/IRAM0 access window E124 fixed, the moment the guest's interrupt
handler returns -- violating this task's own explicit "não remova a proteção" constraint. A
genuinely correct fix needs either a way to re-arm the check when APP CPU leaves interrupt context
(a target-specific hook into Xtensa's own interrupt-return path, not currently available at the
`hw/misc`/`hw/xtensa` boundary this mechanism lives at) or a structurally different mechanism
(e.g., trapping only the specific faulting access rather than stalling all execution, closer to
what Fase 4's own earlier fidelity audit already flagged as a larger, more careful redesign than a
single session's scope invites). Shipping the incomplete exemption would trade a fully-reproducible
deadlock for an intermittent, harder-to-detect CACHEERR regression -- worse, not better. Per this
task's own Fase 6 discipline ("Só aplique correção depois de provar o mecanismo" -- proven -- but
every listed constraint must hold), no correction is applied this session.

### Artifacts

`hw/xtensa/esp32.c` (`[APPCPU_STALL_TRACE]`, additive, gated). `hw/misc/esp32_dport.c`
(`LASECSIMUL_DISABLE_CACHE_RACE_STALL` experimental control, additive, gated, explicitly
non-production). New diagnostic-only candidates (NOT the B11 candidate, not promoted, not a fix)
staged at `E126-tg1-intwdt/diag_candidate_e127/qemu-system-xtensa.exe` -- kept separate from the
immutable `candidate_qemu_3D65BD36/` copy, which remains untouched and unpromoted. All raw logs
preserved under `E126-tg1-intwdt/diag_vnext_trace/` (attempts A-F).

**Correction (E129, 2026-09-05), per an explicit identity audit -- text below kept, not deleted**:
this path was overwritten *twice* in place during this entry's own work, and attempts B-F do not
all share one SHA. Confirmed by cross-referencing each attempt's own file timestamp against the
two build timestamps: `8CF5A8006FAFFF89899E41CA8A84056FFD1AE7FC6DF55CC6C597F0AAF27C0404` (first
rebuild, `[APPCPU_STALL_TRACE]` only) is what attempts **B and C** actually ran against (both
timestamped before the second rebuild). The causal A/B proof itself -- attempts **D and E**, the
`submissions=0` vs `submissions=6168` comparison this entry's own root-cause conclusion rests on --
ran against a **second, different** rebuild (after adding `vnext_cpu_exec_probe_count()` to the
trace line and adding the `LASECSIMUL_DISABLE_CACHE_RACE_STALL` control), SHA
`D9577DAF109A260FBA173E924BEB1D1DB2CAE06BAA8C0196937BEDEB3E95DDA5` -- confirmed as the file
currently on disk at this path. Attempt F used the unrelated, unmodified E122 candidate
(`AA3B7CA6...`), not affected by this mix-up. Neither build differs from the other in any way that
bears on the root-cause conclusion (the second rebuild is a strict superset: the same
`[APPCPU_STALL_TRACE]` line plus two purely-additive extras), so the finding itself stands --  but
citing a single SHA for "the diagnostic candidate" was imprecise, and is corrected here rather than
silently fixed.

### Next step

A correct fix requires one of: (a) a real interrupt-context-aware re-arm mechanism (needs a hook
this boundary doesn't currently have), or (b) narrowing the compensation from "stall all APP CPU
execution" to "trap only an actual access to the disabled region" (a structurally different,
larger design, consistent with Fase 4's own earlier note that more faithful alternatives were
judged out of a single session's scope). Either requires its own dedicated design-and-validation
session with the same rigor this investigation has applied throughout (RED/GREEN unit coverage,
multi-attempt real-firmware validation) -- not attempted here. DECISION-017/018's own mechanism is
now known to have this specific, real gap; a future DECISION entry should record whichever fix is
eventually chosen. B11 must not be reattempted until a fix is validated the same way E124/E125's
own fix was. See E127 below for the original B11-stopped-at-N1 report this entry root-causes.

## E127 - Formal B11 restart with the E126 candidate: regressions re-validated against the ACTUAL
candidate binary (prior session's regressions used canonical, disclosed but not previously
corrected); two runner-hygiene gaps closed (E126 tracer env-vars were not in either runner's
cleanup list); **B11 STOPPED at the very first cell, N=1** -- a clean single boot, zero resets of
any kind, zero artifactFatal, clean teardown, but zero VNEXT_B/I2C workload traffic for the full
60s window (`submissions=0 completions=0`, `terminalRunning=true`) -- a failure mode outside every
category this investigation's own reset-based taxonomy names, and unrelated to CACHEERR or the
TG1-IntWDT residual mechanism (2026-09-05)

### Phase 0 -- identity, immutable per this task's own instruction

Candidate SHA reconfirmed: `3D65BD36D27D380207D0A0DAC1100AD9CCE702C5B6BA6A642E4A745437073FC2`. Copied
to a new, exclusive, not-further-overwritten path,
`vnext_prototype/mttcg_causality/E126-tg1-intwdt/candidate_qemu_3D65BD36/qemu-system-xtensa.exe`
(SHA of the copy reconfirmed identical). `E124-cacheerr/candidate_qemu/` (same bytes) left
untouched, not overwritten again. Release harness (`vnext_b_production_scale_test.exe`) rebuilt
via an explicit `cmake --build ... --config Release --target vnext_b_production_scale_test`
invocation (not merely timestamp-compared) -- MSBuild reported it already up to date (no changes
since the prior build), SHA `270BEAF9458B21C86B6EC09352EECBE4D5558EA9585CEE5567A3092760161310`,
timestamp `2026-09-05T14:00:13`. Confirmed present in source: `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`
(`QemuProcessManager.cpp`), the drain generation/`condition_variable` contract
(`VnextBWaitDispatcher.cpp`), `TEARDOWN_HANG`/`writeSessionResultJsonlIfRequested` (E123's
JSONL-before-teardown ordering) in `VnextBProductionScaleTest.cpp`. Preserved and reconfirmed
unchanged: canonical `B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`, E121
`D7A2896D843FBC6C5386CF57690292A37A4EDFA58A207C4E612E325B879C838C`, E122
`AA3B7CA65445A6751D28748A4407853B06736AAFE9771405CE9143767B3ED029`. **`2043C031...` (E125's own
candidate) is NOT recoverable as a standalone file** -- disclosed honestly, not glossed over: E125
and E126 both followed this investigation's own established "supersede in place" convention for
`E124-cacheerr/candidate_qemu/`, so E125's binary bytes were overwritten in place by E126's build
before this task's stricter per-entry immutable-copy instruction existed. E125's fix and every
validation number remain fully documented in EVIDENCE.md E125 and are independently reproducible
from source (git history), but the exact bytes are gone. Zero orphan `qemu-system-xtensa.exe`
confirmed before, during, and after every run below.

### Phase 1 -- runner hygiene: two real gaps, both fixed and empirically tested

Neither `run_regression.ps1` nor `run_production_mwdt.ps1`'s environment-cleanup list included
`LASECSIMUL_PANIC_CAUSAL_TRACE`, `LASECSIMUL_RTC_SYS_RESET_CAUSAL_TRACE`,
`LASECSIMUL_CACHE_TRACE_DIR`, `LASECSIMUL_TEARDOWN_TRACE`, `LASECSIMUL_FLASH_WRITE_TRACE`, or
`LASECSIMUL_SCALE_SCHEDULER_METRICS` (all six confirmed as real, live gates by grepping the Core
source, not assumed) -- a variable left set in the calling shell from an earlier diagnostic session
could leak into a formal measurement run. Added to both. **Empirically tested, not just read**: set
`LASECSIMUL_PANIC_CAUSAL_TRACE`/`LASECSIMUL_TEARDOWN_TRACE` in the parent shell, ran the exact
removal loop, confirmed both cleared in `$env:`, and confirmed via a `cmd /c echo %VAR%` child
process that the variable is genuinely absent from a freshly spawned child's environment (not just
the parent's own view) -- both printed the literal unexpanded `%VAR%` token, cmd's own signal for
"not defined."

### Phase 2 -- regressions re-run against the ACTUAL E126 candidate (correcting the prior session)

The prior E126 entry's `run_regression.ps1` calls were made without `-QemuBinary`, so their header
printed `QEMU_RUNTIME_SHA256 = B375A9E8...` (canonical) -- E126's own Fase 9 section already
disclosed this plainly ("Regressions against canonical (unaffected by this entry)"), but had not
yet been *supplemented* with a run against the candidate itself, which this task requires before
B11. Re-run with `-QemuBinary` pointed at the immutable copy above, `-Config Release`, and an
explicit `-RunId`:

| RunId | Transport | Header `QEMU_RUNTIME_SHA256` | Result |
|---|---|---|---|
| `E126_candidate_vnext_1` | VNEXT_B+MTTCG | `3D65BD36...` (confirmed) | 13/13 PASS |
| `E126_candidate_vnext_2` | VNEXT_B+MTTCG | `3D65BD36...` (confirmed) | 13/13 PASS |
| `E126_candidate_legacy_1` | LEGACY+MTTCG | `3D65BD36...` (confirmed) | 13/13 PASS |

Zero orphans after all three.

### Phase 3/4 -- B11 formal: STOPPED at N=1

Using `run_production_mwdt.ps1 -Sessions 1 -RunMs 60000 -ReserveCores 6 -Qemu <candidate copy>
-OutDir .../B11_formal/N1` (26/32 cores usable, BelowNormal, no `-Force` needed for N=1). Classified
with `Get-B11CellSummary` (`b11_classify.ps1`), both stderr and the JSONL result file:

```
sessionsDumped=1 allSessionsDumped=True sessionsImageLoaded=1 sessionsStartupObserved=1
sessionsExactlyOneStartup=1 sessionsWorkloadPass=0 totalUnexpectedResets=0
anyBlockedReentrantIo=False anyJsonlStderrMismatch=False teardownClean=True
cellPass=False
```
Session 0's own JSONL line: `{"setupValid":false,"appCpuStartupCount":1,"submissions":0,
"completions":0,"artifactFatal":false,"unexpectedResets":0,"blockedReentrantIo":false,
"workloadPass":false,"terminalRunning":true}`. The harness's own stdout printed
`PRODUCTION_SCALE FAIL failures=1` -- this is the test framework's own internal verdict, not
solely this entry's post-hoc classifier.

**What actually happened, stated precisely**: QEMU booted cleanly (`vNext-B mapping/events
attached`, APP binary loaded), both CPUs completed startup (`count=1` cold boot,
`count=2 expected=app-cpu-startup`, `wdt0/1_enabled=0` both, `source=SW_CPU_RESET_REGISTER` for the
expected transition only -- no third reset line at all, unlike every TG1-adjacent occurrence this
investigation has captured). No panic, no CACHEERR, no MWDT-stage reset, `artifactFatal=false`,
`teardownClean=true`, `EXTERNAL_BACKSTOP=False` (the harness's own in-process defensive timeout was
never needed -- `stopSimulation()` returned normally). `terminalRunning=true` at the moment teardown
began: the guest was still alive and executing *something* for the entire 60s window. **It simply
never produced a single VNEXT_B submission** (I2C or otherwise) in that window -- the firmware is
demonstrably running (booted, no crash, no reset, no hang detected by any existing watchdog or
defensive timeout) yet visibly not reaching its own I2C polling loop.

**This is explicitly NOT the mechanism E111-E126 have been chasing.** It shares no signature with
CACHEERR (`source=RTC_RESET`), the residual TG1/SW_CPU_RESET_REGISTER cascade (no unexpected reset
occurred at all here), MWDT_CPU_STAGE/MWDT_SYS_STAGE (absent), or `Blocked re-entrant IO`
(`anyBlockedReentrantIo=False`). It is closer in shape to E113/E121's own previously-noted, never-
chased "intermittent invalid-boot flake" -- except APP CPU *did* reach its own startup reset here
(`appCpuStartupCount=1`, unlike that flake's own signature of APP CPU never resetting at all), so
this is not a re-identification of that exact prior flake either; it is a related but distinct
symptom: a clean two-CPU boot that silently never reaches (or never completes) whatever guest-side
initialization precedes the workload's first I2C transaction, at the single least-contended scale
(N=1) where host-scheduling contention cannot be the explanation.

Per the task's own explicit protocol: **stopped immediately, no retry, no correction attempted,**
N=8/N=12/N=16 not run. Zero orphan processes confirmed after the stop.
(`Get-Process qemu-system-xtensa,vnext_b_production_scale_test` -> none.)

### Classification against the task's own required source list

None of the six named sources apply directly: not `RTC_RESET`/CACHEERR, not
`SW_CPU_RESET_REGISTER` (no unexpected reset occurred), not `MWDT_CPU_STAGE`/`MWDT_SYS_STAGE`, not
`artifactFatal` (false), not teardown (`teardownClean=true`). Recorded honestly as a **seventh,
distinct source: silent workload-non-start with a clean, fully-expected boot** -- new to this
investigation's own catalogue, not a recurrence of anything previously root-caused.

**No E126 tracer applies to a directed reproduction of this specific failure.**
`PANIC_CAUSAL_TRACE`/`WDT_CAUSAL_TRACE`/`MWDT_ACCOUNTING` all key off a reset, panic, or watchdog
expiry -- none of which happened here. The relevant existing instrumentation for a future directed
attempt is this fork's pre-existing `LASECSIMUL_XTENSA_PC_SAMPLER` (periodic dual-core PC sampling,
already gated, unrelated to this session's tracer work) to see where CPU0/CPU1 actually are during
the silent window, plus a longer `-RunMs` to test whether this is genuinely stuck versus merely
very slow to reach its first I2C transaction on this specific boot.

### Artifacts

`vnext_prototype/mttcg_causality/E126-tg1-intwdt/candidate_qemu_3D65BD36/qemu-system-xtensa.exe`
(new, immutable, exclusive copy). `.../B11_formal/N1/` (preserved: `.err`, `.out`, `.results.jsonl`
for the failing attempt). `vnext_prototype/run_regression.ps1` and `run_production_mwdt.ps1`
(env-cleanup lists extended). No functional/semantic source change in this entry.

### Next step

B11 is **not** validated with this candidate. The blocking issue found is a new, distinct,
not-yet-understood failure mode -- silent workload non-start on a clean boot -- that must be
investigated and resolved (or deliberately scoped) before B11 can be re-attempted from N=1. Do
**not** re-run N=1 hoping for a pass on this same candidate without first understanding why this
attempt produced zero workload traffic; per this task's own instruction, no retry was performed and
none should be assumed equivalent to a fix. The TG1-IntWDT residual mechanism (E111/E126) remains
exactly as open as EVIDENCE.md E126 left it -- this entry neither confirms nor refutes it, since
the one B11 attempt made here never reached a second reset event at all.

## E126 - TG1-IntWDT residual mechanism: full mechanistic reconstruction from real ESP-IDF source,
two genuine PANIC_CAUSAL_TRACE/WDT_CAUSAL_TRACE tracer gaps found and closed (both were
structurally blind to this exact mechanism), a pure/unit-tested extraction of the fix, and an
honest non-result on live capture -- 12/12 fresh reproduction attempts (4xN=1 + 8xN=8) with the
new instrumentation armed showed zero CACHEERR and zero unexpected resets of any kind, so no live
`exccause` frame for this specific mechanism was obtained this session (2026-09-05)

### Scope and honest headline

This entry does **not** reopen CACHEERR (E124/E125, proven and hardened) and does **not** touch
UART/I2C/backpressure/teardown. It reconstructs, from real ESP-IDF source plus the register-level
facts already captured in E125's own preserved logs, the *complete* mechanical chain that produces
a `source=SW_CPU_RESET_REGISTER` reset cascade -- and finds, in the process, that this fork's own
diagnostic tracers (`PANIC_CAUSAL_TRACE`, `WDT_CAUSAL_TRACE`, the `MWDT_ACCOUNTING` reset-snapshot)
were structurally incapable of ever observing this mechanism, independent of whether it is TG0 or
TG1. Both gaps are closed, tested, and validated with zero regression. **What this entry does NOT
achieve**: a live-captured `exccause`/`PS`/`EXCVADDR` frame for a fresh occurrence of the mechanism
itself -- 12 reproduction attempts with the new instrumentation fully armed (4xN=1, 8xN=8, the
Fase 6 budget) produced zero occurrences of ANY unexpected reset, so the classification below is
the strongest claim the *mechanistic* evidence supports, explicitly short of what a live frame
would prove. No correction is applied this session (Fase 7's own gate: only after classification,
and the classification available does not license a specific code change without conflating
`starvation_compatible` with `starvation_proven` -- exactly what Fase 5 prohibits).

### Phase 0 -- preservation and identity

Canonical (`B375A9E8...`), E121 (`D7A2896D...`), E122 (`AA3B7CA6...`) candidates unchanged and
reconfirmed via the `run_regression.ps1` runs below (they use the canonical runtime, untouched).
E125's own candidate (`2043C031...`) is superseded in place (same directory,
`E124-cacheerr/candidate_qemu/`) by this entry's build, which is a strict, purely-additive superset
of E125's fix (no line touched inside `esp32_cache_state_update()`/`esp32_dport_reset()` this
session). New candidate SHA: `3D65BD36D27D380207D0A0DAC1100AD9CCE702C5B6BA6A642E4A745437073FC2`.
Zero orphan `qemu-system-xtensa.exe` confirmed before, during, and after every run in this entry.

### The given occurrence (PID 62440, `E124-cacheerr/e125_postfix_n8/attempt_2/n8.err`) -- fully
mechanically reconstructed, not merely re-described

`count=3`: `mask=0x02 cause0=1 cause1=12 pc0=0x40083e7c pc1=0x40082a2d wdt0_enabled=1
wdt1_enabled=0 source=SW_CPU_RESET_REGISTER`. Symbolized against this session's own
`firmware.elf` (SHA `1697587b58f9df862765adabc2f5a2e74387863438d8a6df775196a542c9d9b6`, unchanged):
`pc0=0x40083e7c` -> `esp_cpu_reset` (`esp_hw_support/cpu_util.c:41`); `pc1=0x40082a2d` ->
`spi_flash_op_block_func` (`spi_flash/cache_utils.c:121`), confirming fact #10 directly rather than
accepting it as given.

**`mask`/`source` prove the mechanism, by construction, before any hypothesis is needed.**
`hw/xtensa/esp32.c`'s `esp32_cpu_reset()` GPIO handler is the *only* site that sets
`s->requested_reset_source = "SW_CPU_RESET_REGISTER"`, and it is wired exclusively from
`hw/misc/esp32_rtc_cntl.c`'s `RTC_CNTL_OPTIONS0.SW_APPCPU_RESET_MASK`/`SW_PROCPU_RESET_MASK` write
branches -- i.e. from real ESP-IDF's own `esp_cpu_reset()` calls, executed by *software*. This is
categorically different from `esp32_dig_reset()` (source=`"RTC_RESET"`, wired to `SW_SYS_RESET_MASK`,
the CACHEERR path) and from `esp32_timg_cpu_reset()`/`esp32_timg_sys_reset()`
(source=`"MWDT_CPU_STAGE"`/`"MWDT_SYS_STAGE"`, wired directly from a TIMG hardware stage action,
`qemu_irq_pulse(wdt_cpu_reset_req/wdt_sys_reset_req)`, with NO guest software step in between). **A
`source=SW_CPU_RESET_REGISTER` reset can only be produced by ESP-IDF's own `esp_cpu_reset()`
function actually executing on a vCPU** -- confirmed by reading `hw/xtensa/esp32.c` end to end, not
inferred from the name.

Reading real ESP-IDF's `esp_restart_noos()` (`esp_system/port/soc/esp32/system_internal.c:44-153`)
line by line against `count=3/4/5` proves the *entire* 3-reset cascade is that function's own
documented, intentional sequence -- not a QEMU artifact, not a bug, not evidence of anything
"wrong" in the reset path itself:
```
const uint32_t core_id = cpu_hal_get_core_id();          // running core, whichever panicked
esp_cpu_reset(other_core_id);   // <-- count=3: resets the OTHER cpu FIRST ("must be reset before
                                 //     stalling, in case it was running s32c1i" -- comment in situ)
esp_cpu_stall(other_core_id);
... (disable TG0/TG1 watchdogs, flush UART, disable cache, reset peripherals) ...
if (core_id == 0) {
    esp_cpu_reset(1);    // <-- count=4: the OTHER cpu again, unconditionally, near the very end
    esp_cpu_reset(0);    // <-- count=5: self-reset -- this is what actually restarts the chip
}
```
`count=4`'s `pc1=0x40000400` (APP CPU's own ROM reset vector) is exactly consistent with CPU1
having already been reset once (at count=3) and now sitting at its post-reset PC when logged
again. `count=5`'s `boot_epoch=2` (bumped) matches `esp32_soc_reset()`'s own
`++s->rtc_cntl.cpu0_boot_epoch` on a PROCPU reset. **Every field in the given occurrence is now
explained by an exact, named line of real ESP-IDF source -- none of it is inferred from the
mechanism's historical name.**

### Why `esp_restart_noos()` runs at all -- the ESP-IDF int_wdt design, read end to end

`components/esp_system/int_wdt.c` (`tick_hook()`, `CONFIG_ESP_INT_WDT_CHECK_CPU1` branch):
CPU1's own FreeRTOS tick sets `int_wdt_app_cpu_ticked = true`; only CPU0's own tick, when that flag
is already true, actually feeds TIMERG1's hardware watchdog (`wdt_hal_feed`) and clears the flag.
`components/esp_system/port/soc/esp32/highint_hdl.S`'s `xt_highintx` (the shared cache-error/int_wdt
level-4/5 vector) decides, on a genuine TG1 expiry, `int_wdt_app_cpu_ticked==0 -> PANIC_RSN_INTWDT_
CPU1` (blame CPU1) vs nonzero `-> PANIC_RSN_INTWDT_CPU0`. `panic_arch.c` maps `PANIC_RSN_INTWDT_
CPU1` to `info->core = 1`. This is ESP-IDF's OWN, real, documented mechanism for identifying which
core failed to tick -- not something this investigation is inventing.

`components/spi_flash/cache_utils.c`'s `spi_flash_op_block_func()` (the function CPU1 was inside,
per the symbolization above) calls `esp_intr_noniram_disable()` while busy-waiting
(`while (!s_flash_op_complete) {}`) -- but real ESP-IDF's FreeRTOS tick ISR is IRAM-resident and
high-priority *specifically so it survives this exact kind of critical section* (the whole point
of the IRAM-survival convention is to prevent false int_wdt trips during flash ops). Read plainly,
**this means a legitimate flash critical section, on real hardware running at real speed, should
never itself starve `int_wdt_app_cpu_ticked`** -- the tick ISR keeps firing on both cores regardless
of how long the *guest-visible* flash operation takes. This reframes the open question precisely:
the failure mode is not "the firmware doesn't feed the watchdog during a flash op" (it does, by
design) -- it is "the host OS did not schedule a given vCPU's own thread for long enough, in real
wall-clock time, for even that always-on tick ISR to execute" -- which is a HOST-scheduling
question, not a firmware-correctness one, if it is happening at all.

**Ruled out directly from source, not assumed**: the flash operation itself contributes no
QEMU-side delay of any kind. `hw/block/m25p80.c`'s `flash_erase()`/`flash_write8()` mutate
`Flash::storage` with a plain `memset()`/byte write (in-memory, instant) and persist via
`flash_sync_area()`/`flash_sync_page()` -> `blk_aio_pwritev()` (asynchronous, fire-and-forget,
never awaited by the vCPU). `hw/ssi/esp32_spi.c`'s own code comment states explicitly: *"SPI0/SPI1
usam esp32_spi_cs_set() via qemu_irq interno, nunca chegam aqui"* -- the flash-attached SPI
controller (`s->number < 2`) never calls `writeReg()`/VNEXT_B at all; only HSPI/VSPI
(`number >= 2`, unrelated user peripherals) do. **The entire flash critical section, in this
emulation, never releases the BQL and never round-trips to the external Core process** -- Category
6 (artificial emulator/transport/BQL block) is excluded for this specific window by direct
construction, not by assumption.

### Fase 1 -- two real, previously-undiscovered tracer gaps, found and closed

1. **`PANIC_CAUSAL_TRACE` (built in E122) could structurally never fire for this mechanism.** It
   was wired only to `esp32_rtc_cntl_write()`'s `SW_SYS_RESET_MASK` branch (the CACHEERR/
   `esp_restart_noos_dig()` path) -- confirmed by reading the whole function, not assumed. The
   `SW_APPCPU_RESET_MASK`/`SW_PROCPU_RESET_MASK` branches (`esp_restart_noos()`'s own mechanism,
   proven above) had no capture at all. **Fixed**: the same `lasec_panic_trace_dump()` now fires
   from all three branches, sharing one fired-once latch, labeled by a new `trigger` field
   (`SW_SYS_RESET`/`SW_APPCPU_RESET`/`SW_PROCPU_RESET`) so a captured occurrence is unambiguous
   about which mechanism produced it. The one expected app-cpu-startup `SW_APPCPU_RESET_MASK`
   write (every real boot performs exactly one) is explicitly excluded from capture; every
   subsequent one is captured. The exact decision (`esp32_panic_trace_should_capture()`) is
   extracted into a pure, dependency-free function
   (`include/hw/misc/esp32_panic_trace_gate.h`) and unit-tested in isolation
   (`tests/unit/test-esp32-panic-trace-gate.c`, 6/6 PASS) -- see Fase 8.
2. **`WDT_CAUSAL_TRACE` and `MWDT_ACCOUNTING`'s reset/expiry reporting were hardcoded to TG0
   only** (`ws->parent->id != 0` bailed immediately in `wdt_causal_record()`; every
   `esp32_timg_wdt_cb()`/`_feed()`/`_update_config()`/`_arm()` site that populates the diagnostic
   or reset-snapshot state was gated `if (s->id == 0)`). Given `count=3`'s own
   `wdt0_enabled=1`/`wdt1_enabled=0` (see the open question below), assuming this mechanism must be
   TG1 "by historical name alone" is exactly what this task's fact #4 prohibits -- and the
   pre-existing tracers could not have told the two apart even if armed. **Fixed**: the ring
   (`wdt_causal_ring[2][...]`) and every generation/last-feed/dumped counter are now indexed by TG
   id; `Esp32TimgWdtState`'s own per-instance `mwdt_anchor`/`mwdt_baseline`/`diag_*` fields (already
   struct members, just never populated for id==1) are now reanchored/captured for both groups.
   The transport-pause-specific fields (`diag_pause_compensated_ns`, `WDT_CAUSAL_PAUSE_OPEN/APPLY`)
   remain correctly TG0-only -- `esp32_timg_transport_pause()`/`_apply()` only ever touch the TG0
   instance (`esp32_timg_tg0`), a real architectural fact, not a gate removed here.
3. **Gates confirmed correctly read and not cleared by any runner**: `LASECSIMUL_WDT_CAUSAL_TRACE`,
   `LASECSIMUL_PANIC_CAUSAL_TRACE`, `LASECSIMUL_MWDT_ACCOUNTING` are each read via the established
   `g_once_init_enter`/`leave`-cached pattern (same as every other diagnostic gate in this fork);
   `repro_n8.ps1`/`smoke_n1.ps1` (this entry's own runners, modeled on E124's `repro_loop.ps1`)
   clear only `LASECSIMUL_*` before setting exactly these three, confirmed by direct inspection --
   no runner in this investigation's history strips a gate a subsequent attempt needs.
4. **CPU_WAIT_* accounting audited, not re-derived**: `include/hw/core/cpu.h`/`softmmu/cpus.c`/
   `softmmu/vnext_b.c` already implement the full Fase-B design from a prior session (per-CPU
   `wait_cumulative_ns[CPU_WAIT_MAX]`, transition-at-decision-instant semantics, `CPU_WAIT_GUEST_
   HALTED` as the sole self-reported category). Read in full to determine its actual coverage for
   *this* mechanism: a vCPU spinning in a tight `while(!flag){}` loop (CPU1's exact situation here)
   never sets `cpu->halted`, so **no explicit `CPU_WAIT_*` category ever fires for it** -- its time
   is either `thread_cpu_ns` (if the host schedules it) or invisible/residual (if the host does
   not). This is not a gap to fix; it is the precise reason `host_residual_share` (recomputed at
   report time, per the existing B4/B8 design) is the *only* signal capable of distinguishing
   "CPU1 spun busily the whole window" from "CPU1's own thread was denied host CPU time" for this
   specific mechanism -- confirmed by reading, not assumed.

### Fase 6 -- reproduction: 12/12 attempts clean, zero occurrences of the target mechanism

Two new runners (`E126-tg1-intwdt/smoke_n1.ps1`, `.../repro_n8.ps1`, modeled on E124's
`repro_loop.ps1`) launched with `LASECSIMUL_WDT_CAUSAL_TRACE=1 LASECSIMUL_PANIC_CAUSAL_TRACE=1
LASECSIMUL_MWDT_ACCOUNTING=1` set from process start, using this entry's own candidate.
**N=1, 4/4 attempts**: zero unexpected resets; `[WDT_CAUSAL_TRACE][tg=...]` never fired (no
non-deferred stage evaluation reached in any attempt -- every WDT stage that fired was a
transport-pause deferral, `[LANE0_EXHAUSTION_PRODUCER]`, an unrelated pre-existing diagnostic that
happens to share the same log tag). **N=8, 8/8 attempts** (the full Fase 6 budget, not stopped
early since nothing to stop at): zero unexpected resets in every attempt -- confirmed via
`Get-B11CellSummary` (`b11_classify.ps1`): **`cellPass=True teardownClean=True
unexpectedResets=0` on all 8**. `[PANIC_CAUSAL_TRACE]` never fired in any of the 12 attempts.

**This is itself data, reported honestly rather than discarded**: the mechanism reproduced reliably
in two prior, independent sessions under apparently similar conditions (E124's preserved
`smoke_n1/n1.err`, 6 boot_epochs of the cascade inside one 60s N=1 window; E125's `attempt_2`,
the given PID 62440) but did not reproduce at all across 12 fresh attempts today. This pattern --
present, sometimes prolifically, then absent under nominally identical configuration -- is
*consistent with* a host-scheduling-contingent mechanism (current host load differs from whatever
produced the earlier captures), but per this task's own Fase 5 instruction, **absence of
reproduction under different, uncontrolled host load is not proof of that or any other specific
cause.** No frame was captured; no category is claimed as proven.

### Fase 5 -- classification: not proven this session, leading hypothesis stated plainly

None of the 7 categories can be selected with the frame-level evidence Fase 5 itself requires
(`exccause`, live `CPU_WAIT_TRANSPORT`/`thread_cpu_ns` numbers for the actual window) -- that frame
was not captured (see Fase 6). What CAN be stated, bounded strictly to what was actually proven by
source reading in this entry:
- The reset **mechanism** (how) is fully proven: `esp_restart_noos()`'s own multi-step per-CPU
  reset sequence, triggered by *some* panic/abort reaching it. This is not in question.
- The flash critical section itself contributes no QEMU-side delay (Category 6 excluded by
  construction for this specific window, as shown above).
- ESP-IDF's own int_wdt design should not, by construction, starve `int_wdt_app_cpu_ticked` from a
  merely-long *guest-visible* flash operation (the tick ISR survives `esp_intr_noniram_disable()`
  by design) -- which argues against a naive "guest starvation" (Category 4) reading and toward
  either Category 5 (a vCPU's own host thread denied real CPU time, so even an always-on tick ISR
  never gets to run) or a still-unidentified TG0 mechanism (see below).
- **`count=3`'s `wdt0_enabled=1`/`wdt1_enabled=0` is genuinely uninformative, on closer
  examination -- not merely unresolved, but unreliable by construction.** `esp32_cpu_reset(n=1)`
  (the RTC_CNTL GPIO handler) runs synchronously on the panicking core's thread and only *queues*
  `esp32_app_cpu_reset_async()` via `async_run_on_cpu()` targeting CPU1 -- the `esp32_log_reset()`
  call that reads `wdt0/1_enabled` lives *inside* that async callback, which only executes once
  CPU1's own thread reaches a safe point. Two readings are both live: if CPU1 is scheduled
  promptly, the read lands near the true panic instant (making TG1-off meaningful -- `esp32_timg_
  wdt_arm()` never schedules `stage_timer` when `!ws->en`, so TG1 could not have fired); if CPU1's
  thread is itself the one being denied host CPU time (the exact mechanism under investigation),
  the read is delayed by an uncontrolled amount while CPU0 races ahead through `esp_restart_noos()`
  's own TG0-then-TG1 disable sequence, and the field says nothing about the panic instant at all.
  **This field cannot be used as evidence for or against TG0/TG1 without independently knowing
  which of those two cases applied** -- an earlier draft of this entry overclaimed the first
  reading; corrected here. The one instrument immune to this specific confound is exactly the
  newly-fixed `PANIC_CAUSAL_TRACE`, which reads `frame->exccause` off `g_exc_frames[core]` --
  populated at the actual panic instant, on the panicking core's own stack, before any reset
  dispatch (synchronous or async) runs at all. It was not given the chance to fire this session.

**Verdict: inconclusive on a live frame, with TG1-IntWDT/host-scheduling-contention (Category 5)
as the leading, falsifiable, source-grounded hypothesis** -- explicitly not asserted as proven, per
this task's own "não aceite 'provavelmente host load'" instruction. No correction is applied
(Fase 7's own gate).

### Fase 8 -- deterministic test for the fix actually made

The two tracer-gap fixes are real, load-bearing, and testable independent of the still-open
classification. `esp32_panic_trace_should_capture()` (pure, `include/hw/misc/
esp32_panic_trace_gate.h`) encodes exactly the decision added at the three RTC_CNTL_OPTIONS0
branches; `tests/unit/test-esp32-panic-trace-gate.c` (**6/6 PASS**) is RED against the pre-E126
code in the sense that mattered (no call to any capture logic existed on the APPCPU_RESET/
PROCPU_RESET branches at all) and GREEN against the new one, including a realistic
count=2-then-count=3-then-count=4/5 sequence built directly from the PID 62440 occurrence
(`test_case6_realistic_boot_then_unexpected_cascade_sequence`).

### Fase 9 -- validation

**New suite**: `test-esp32-panic-trace-gate` 6/6.
**Prior QEMU suites reconfirmed unchanged**: `test-esp32-timg-pause` 7/7, `test-esp32-dport-cache-
race-stall` 13/13, `test-vnext-b-classify` 9/9.
**Core suites against this entry's candidate** (`LASECSIMUL_TEST_QEMU_BINARY` override):
`vnext_b_attachment_test` 31/31, `session_restart_stress_test` 15/15,
`mcu_component_live_poll_thread_test` all OK.
**`b11_classify_test.ps1`** (synthetic, no QEMU): 30/30.
**Regressions against canonical** (unaffected by this entry): `run_regression.ps1
-Transport VNEXT_B -ExecutionMode MTTCG` **13/13 PASS twice**; `-Transport LEGACY -ExecutionMode
MTTCG` **13/13 PASS once**.
**Real-firmware reproduction** (this entry's own candidate): 4xN=1 + **8xN=8, all 8 confirmed
`cellPass=True teardownClean=True unexpectedResets=0`** via `Get-B11CellSummary` -- zero CACHEERR,
zero unexpected resets of any kind, zero `TEARDOWN_HANG`, zero orphan `qemu-system-xtensa.exe`
confirmed after every attempt.

### Artifacts

`include/hw/misc/esp32_panic_trace_gate.h` (new, pure, permanent regression asset).
`tests/unit/test-esp32-panic-trace-gate.c` (new). `hw/misc/esp32_rtc_cntl.c` (PANIC_CAUSAL_TRACE
now fires on all three RTC_CNTL_OPTIONS0 reset branches). `hw/timer/esp32_timg.c` (WDT_CAUSAL_TRACE
ring and MWDT_ACCOUNTING reset-snapshot reporting now per-TG). New candidate SHA
`3D65BD36D27D380207D0A0DAC1100AD9CCE702C5B6BA6A642E4A745437073FC2`, staged in place at
`vnext_prototype/mttcg_causality/E124-cacheerr/candidate_qemu/qemu-system-xtensa.exe` (supersedes
E125's `2043C031...` binary; E125's own logs/evidence remain intact and cited above).
`vnext_prototype/mttcg_causality/E126-tg1-intwdt/{smoke_n1,repro_n8}/` (12 attempts, all clean,
preserved).

### Next step

The instrumentation needed to settle Fase 5's classification definitively is now in place, tested,
and validated with zero regression -- it simply was not exercised by a live occurrence this
session. The next continuation should: (1) re-arm all three gates
(`LASECSIMUL_WDT_CAUSAL_TRACE`/`LASECSIMUL_PANIC_CAUSAL_TRACE`/`LASECSIMUL_MWDT_ACCOUNTING`) on this
entry's candidate the next time the mechanism reproduces (no rebuild needed) and read the resulting
`[PANIC_CAUSAL_TRACE] trigger=SW_APPCPU_RESET`/`SW_PROCPU_RESET` line's `exccause`/`pseudo_excause`/
`tg1_wdt_source20_active` fields directly -- this alone resolves the TG0-vs-TG1 open question; (2)
if it confirms TG1/`PANIC_RSN_INTWDT_CPU1`, capture the `[MWDT_ACCOUNTING]` `tg=1` snapshot at that
same expiry and read `residual_share`/`thread_cpu_ns` for CPU1's lane across the window since its
last tick to settle Category 4 vs 5 quantitatively; (3) if it instead shows a TG0 signature or a
different `exccause` entirely, treat this as a distinct, not-yet-understood mechanism rather than
assuming continuity with the historical "TG1-IntWDT" name. Do not run B11, N=12/N=16, B12,
SINGLE_REALTIME, ICOUNT, or promote the runtime until that classification lands -- none of those
were run or promoted in this entry either.

## E125 - Review of E124's CACHEERR fix: found and closed three real gaps (stall-after-disable
ordering, an over-broad/permanently-stallable release condition, and a reset that never cleared
the new flag), extracted the decision logic into a pure, unit-tested function, and honestly
documented the fix as an MTTCG-specific compensation with no equivalent in real hardware or the
reference fork -- 8/8 total N=8 real-firmware runs (E124+E125 combined) show zero CACHEERR; TG1-
IntWDT (E111, unrelated) reappeared once, correctly classified separately (2026-09-05)

### Scope and honest headline

Confirms E124's root cause was correct and does not reopen it. Audits E124's *fix* against the
exact three failure modes this task's own analysis predicted, finds all three genuinely present in
E124's first cut (not merely theoretical), closes them, and adds the deterministic test E124 itself
flagged as a gap. Also confirms, by direct comparison against `qemu_simulide`, that no cross-core
cache stall exists in either real hardware's own documented behavior or the reference fork --
E124/E125's stall is an honest, labeled compensation for this fork's MTTCG timing, not a hardware
model.

### Phase 0 -- preservation and identity

- Canonical unchanged: `B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`.
- E121/E122 candidates unchanged: `D7A2896D843FBC6C5386CF57690292A37A4EDFA58A207C4E612E325B879C838C`,
  `AA3B7CA65445A6751D28748A4407853B06736AAFE9771405CE9143767B3ED029`.
- E124's own candidate (`06558E31CE6F0013C02B8E56B99439F62D016C49A9D24C5DDB052FB2B344D8B0`) is
  superseded in-place by this entry's candidate (same directory,
  `E124-cacheerr/candidate_qemu/`) -- its evidence (the RED/GREEN logs it produced) remains
  intact and cited above; only the binary itself was overwritten, since E125 is a direct,
  in-place hardening of the same fix, not a parallel alternative.
- No orphan `qemu-system-xtensa.exe` before, during, or after any run in this entry.

### Phase 1 -- auditing the actual order: the gap is real, and the BQL does not close it in general

Read `esp32_cache_state_update()` exactly as committed by E124: `memory_region_set_enabled(false)`
for `drom0`/`iram0` ran, unconditionally, *before* the stall-mask logic that would hold APP CPU.
**Confirmed: yes, a window existed between "region disabled" and "stall applied", both inside the
same function, on the writer core's own thread.**

Whether APP CPU could execute inside that window was analyzed directly, not assumed via "the BQL
protects it":

- This device's write handler holds the BQL for its entire duration (standard QEMU MMIO dispatch).
  Any access that must take the SLOW path -- device dispatch, required for a region APP CPU has
  never touched before, exactly the proven scenario this whole investigation is built on -- is
  genuinely blocked behind that same BQL and cannot interleave mid-function. For that specific,
  proven access pattern, the old ordering was not actually exploitable.
- But cross-CPU TLB invalidation in this codebase (`accel/tcg/cputlb.c`) is asynchronous when the
  target is not the calling thread: `tlb_flush(cpu)` dispatches via `async_run_on_cpu()` rather
  than blocking on the target vCPU. A vCPU already holding a cached FAST-PATH TLB entry for the
  same page (from an earlier, successful access) does not need the BQL at all and is not blocked
  by it -- it could race through the disable-to-stall window on an already-touched page. This is a
  real, general hazard the BQL does not close, even though it happens to be moot for the one
  access pattern E124's own reproduction exercised.

**Reordered, per the task's own prescribed shape**: Phase A now requests the stall *before* either
`MemoryRegion` is disabled; Phase B applies the actual disable/enable; Phase C releases the stall
only *after* the corresponding region is confirmed re-enabled (and, on first return to enabled,
re-synced). Closes the gap for both the proven access pattern and the general TLB-caching one.

### Phase 2 -- narrowing the condition: a real, provable permanent-stall bug found and fixed

E124's release test was `drom0_enabled && iram0_enabled`, computed globally. Traced against the
task's own audit list: if IRAM0 (or DROM0) was independently, legitimately masked via
`CACHE_CTRL1`'s own `MASK_IRAM0`/`MASK_DROM0` bits for reasons unrelated to this race, that region
can never read back as "enabled" -- E124's global test could then never be true again, for any
number of further DROM0 enable/disable cycles. **A real, provable permanent stall**, not
theoretical -- confirmed with a literal encoding of E124's own formula in the new test suite
(`test_e124_original_formula_would_have_stalled_forever`).

Replaced with a per-region bitmask, `Esp32DportState::appcpu_cache_race_stall_mask`
(`ESP32_CACHE_RACE_STALL_DROM0`/`IRAM0` bits): a bit is set only on an observed
enabled-by-history -> disabled-by-a-different-core transition for *that specific region*, and
cleared the instant *that same region* is next observed enabled, regardless of who re-enabled it.
A sibling region that was never enabled to begin with can never enter the mask and can therefore
never block release. All ten of the task's own Fase 2 audit cases (already-masked DROM0/IRAM0
before the write, CPU0 touching only one mask bit, `CACHE_ENA` 1->0->1, self-disable, unknown
writer, reset-time writer, two consecutive disables, partial enable after global disable) map
directly to the new unit test's twelve cases -- all pass; see Phase 5.

### Phase 3 -- reset lifetime: confirmed and fixed

`esp32_dport_reset()` lowered `appcpu_stall_req` but never touched
`appcpu_cache_race_stall`/`_mask` -- confirmed by reading, not assumed. Immediately after any
reset this is masked by `appcpu_reset_state`/`!appcpu_clkgate_state` already forcing the OR'd
stall true regardless, so the bug is not observable at the instant of reset itself; it resurfaces
later, once APP CPU goes through a normal post-reset bring-up (`reset_state`/`clkgate` correctly
clear) while the stale flag from *before* the reset (e.g. a CACHEERR-triggered reboot mid-race)
is still set -- holding APP CPU for an indeterminate extra duration into an otherwise healthy
bring-up.

Also audited and fixed, per the task's explicit list: `cache_ctrl_reg`/`cache_ctrl1_reg` (were
never reset to their real-hardware POR default of 0/disabled -- now explicitly zeroed for both
cores) and each region's `MemoryRegion.enabled` (was left stale at whatever it was before the
reset -- now explicitly disabled for both cores' `drom0`/`iram0`/`dram1`, matching the
just-zeroed registers instead of drifting from them). `illegal_access_status` is now explicitly
cleared for all six (core x region) combinations. `esp32_cache_state_update()` is deliberately
*not* called from the reset path itself (it would read `current_cpu`, meaningless/misleading at
reset time -- this device can be reset from the monitor, machine init, or a guest-triggered SoC
reset processed on whichever vCPU requested it) -- every field it would have derived is instead
set directly and unconditionally.

### Phase 4 -- fidelity: compared against qemu_simulide, read-only

`qemu_simulide/hw/misc/esp32_dport.c`'s own `esp32_cache_state_update()` has the **same shape as
E124's original** (`memory_region_set_enabled()` called directly, no cross-core synchronization of
any kind) and its own `appcpu_stall_req` computation is even narrower than this fork's pre-E124
one (`appcpu_stall_state || !appcpu_clkgate_state` only -- missing this fork's own pre-existing
`reset_state`/`reset_pending` terms). **No stall-on-cache-disable exists in the reference fork
either.** Combined with `cache_utils.c`'s own documented reliance on `esp_ipc_call`-based
*software* synchronization (real hardware has no automatic cross-core cache-disable stall -- ESP-
IDF implements the safety itself, in firmware, when it knows it needs to), this is recorded
honestly per the task's own instruction: **this fix is a deliberate, fork-specific compensation
for this fork's MTTCG timing, not a model of literal ESP32 silicon behavior.** No more faithful
alternative was identified as clearly superior within this session's scope (keeping CPU1 "in
IRAM" longer, making the disable/restore sequence atomic in the model, or a real cache handshake
would all be larger, riskier changes than this task's own stated scope invited) -- not attempted,
not pursued further.

### Phase 5 -- deterministic test

Extracted the mask decision into `include/hw/misc/esp32_cache_race_stall.h`
(`esp32_cache_race_stall_gain()`/`_release()`, pure, dependency-free -- same pattern as E118-
AUDIT's `vnext_ring_classify()`), called by `esp32_cache_state_update()` at the two points Phase
1's reordering requires. New suite, `tests/unit/test-esp32-dport-cache-race-stall.c`,
**13/13 PASS**: the ten Fase 2 audit cases, an exhaustive (writer x drom0 x iram0) sweep proving no
input combination can leave a residual mask bit once both regions are confirmed enabled
(`no_permanent_stall_path_exists`), and a literal encoding of E124's own original formula proving
it would have stalled forever in the pre-existing-mask case
(`e124_original_formula_would_have_stalled_forever`) -- the RED anchor for this fix, since E124's
exact pre-review code no longer exists in the tree to run directly. Ordering itself
(stall-before-disable) and full-device behaviors (actual `xtensa_runstall()` effect, real MMIO
dispatch, MTTCG scheduling) are validated at the real-firmware level (Phase 6) rather than
synthetically -- building a full two-vCPU QEMU-level barrier harness for this specific ordering
was judged out of proportion to this session's remaining scope; flagged as a real gap, not hidden.

### Phase 6 -- validation

**Real-firmware N=8/60s, GREEN**: 4 attempts immediately after the fix (`e125_postfix_n8/`) plus
E124's own 4 (`postfix_n8/`, re-validated as still applicable) = **8/8 total show zero
`source=RTC_RESET`, zero `exccause=7`** (CACHEERR). One of the 8 (`e125_postfix_n8/attempt_2`)
shows `unexpectedResets=3` via `source=SW_CPU_RESET_REGISTER` -- the already-known, separate
TG1-IntWDT mechanism (E111), preserved and classified apart per this task's own instruction, not
mixed with CACHEERR and not treated as a regression (E111 already characterized this as reproducing
at a real, non-zero, host-contention-dependent rate under N=8, and this session did not touch
`wdt_time_scale` or any watchdog logic).

**Deterministic**: `test-esp32-dport-cache-race-stall` 13/13 (new), `test-esp32-timg-pause` 7/7,
`test-vnext-b-classify` 9/9.
**Core suites**: `vnext_b_attachment_test` 31/31, `mcu_component_live_poll_thread_test` all OK,
`session_restart_stress_test` 15/15, `b11_classify_test.ps1` 30/30.
**Regressions**: `run_regression.ps1` `-Transport VNEXT_B -ExecutionMode MTTCG` **13/13 PASS
twice**, `-Transport LEGACY -ExecutionMode MTTCG` **13/13 PASS once**.
**Teardown**: `teardownClean=true` in every one of the 8 N=8 attempts (including the TG1-IntWDT
one); zero `TEARDOWN_HANG`; zero orphan `qemu-system-xtensa.exe` after every run in this entry.

### Artifacts

`vnext_prototype/mttcg_causality/E124-cacheerr/`: `candidate_qemu/` (now the E125 binary, SHA
below -- E124's own binary bytes were superseded in place, its logs preserved),
`e125_postfix_n8/attempt_{1,2,3,4}/` (GREEN + the one TG1-IntWDT recurrence, preserved and
labeled). `qemu_lasecSimul/tests/unit/test-esp32-dport-cache-race-stall.c` and
`include/hw/misc/esp32_cache_race_stall.h` (new, permanent regression assets, not scoped to this
investigation only).

### Next step

E124's fix is now hardened against all three gaps this review set out to close and is, in this
session's judgment, ready for a future B11 restart from the CACHEERR side specifically -- neither
promotion nor B11 was attempted this session, per its own explicit scope. The TG1-IntWDT variant
(E111) remains open, frozen at its `wdt_time_scale` cap, and will still legitimately show
`unexpectedResets>0` at any future B11 scale -- continue distinguishing it from CACHEERR by the
`source` field (`SW_CPU_RESET_REGISTER` vs `RTC_RESET`) exactly as this entry and E124 did. A
future session with more scope could build the full two-vCPU ordering barrier harness Phase 5
flagged as not attempted, and/or audit whether the same POR-defaults gap this entry fixed in
`esp32_dport_reset()` exists in sibling devices' own reset handlers.

## E124 - CACHEERR (mechanism 2's DROM0 illegal-access variant) root-caused and FIXED: a genuine
race between CPU0's spi_flash_mmap_init()-driven cache disable/restore cycling and CPU1's
post-s_resume_cores read of g_startup_fn[1] -- reproduced with full register-level detail via
LASECSIMUL_CACHE_TRACE (extended, not duplicated), fixed by extending this fork's existing
appcpu_stall_req mechanism; 4/4 clean N=8/60s post-fix, 2x VNEXT_B+MTTCG 13/13, 1x LEGACY+MTTCG
13/13, all QEMU/Core regression suites green; canonical/E121/E122 preserved (2026-09-05)

### Scope and honest headline

Proves, with a complete register-level capture of a single occurrence (not inference), the exact
mechanism behind E121/E122/E123's mechanism-2 CACHEERR variant: `PANIC_RSN_CACHEERR` on core 1,
address 0x3f4049f0 (`g_startup_fn[1]`, confirmed exactly), caused by a real, provable race -- not a
QEMU register-modeling defect and not misclassification. Fixed at the narrowest point the evidence
supports. The already-known TG1-IntWDT variant (E111, `source=SW_CPU_RESET_REGISTER`) is explicitly
NOT touched by this entry -- it reproduced independently during this entry's own N=1 smoke test
(cascading through 6 boot_epochs) and is left exactly as E111 characterized it, per this task's
explicit "não confunda... não tente corrigir dois mecanismos na mesma alteração" instruction.

### Phase 0 -- preservation and identity

- Canonical unchanged throughout: `B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`.
- E121 candidate unchanged: `D7A2896D843FBC6C5386CF57690292A37A4EDFA58A207C4E612E325B879C838C`.
- E122 candidate unchanged: `AA3B7CA65445A6751D28748A4407853B06736AAFE9771405CE9143767B3ED029`.
- New evidence directory: `vnext_prototype/mttcg_causality/E124-cacheerr/`.
- No orphan `qemu-system-xtensa.exe` before, during, or after (`Get-Process` checked after every
  run).
- Pre-fix ("RED") candidate SHA `E38C4B4910705C2BA9465BB13117BF1F1A074A18A41837E33B7AA97B3F0D237F`
  (E122 candidate + Phase 1 instrumentation only, no fix) -- superseded in-place by the post-fix
  ("GREEN") candidate below; its own binary bytes were not separately archived, but every log this
  entry cites from it (`smoke_n1/`, `repro_n8/attempt_1/`) was captured before the fix existed and
  is preserved in full.

### Phase 1 -- extended the EXISTING LASECSIMUL_CACHE_TRACE instrumentation, did not duplicate it

Audited `hw/misc/esp32_dport.c`'s pre-existing `[CACHE-TRACE]` facility (gated behind
`LASECSIMUL_CACHE_TRACE`, dating to an earlier investigation, already extended once by E110-E113)
before writing anything new, per the task's own instruction. It already recorded, per event: both
cores' cache-enabled bools, illegal-access status, PC of both cores, the writer core/PC, and a
"first illegal access" + "first unexpected reset" bounded capture-window mechanism (500 events,
one-shot per process). Extended, not duplicated:

- **Redirected the three hardcoded `C:/tmp/...` path bases** to an opt-in
  `LASECSIMUL_CACHE_TRACE_DIR` (defaults to `C:/tmp` unchanged when unset, so no other caller of
  this instrumentation is affected) -- now pointed at `E124-cacheerr/` for every run in this entry.
- **New fields on every event**: raw `PRO/APP_CACHE_CTRL`/`CACHE_CTRL1` register contents (not just
  the derived enabled bool), the exact MMU table entry covering the faulting vaddr for `ill_read_*`
  events, `illegal_access_trap_en` for that region, and a new monotonic
  `app_cpu_reset_generation` counter.
- **`app_cpu_reset_generation`** (Phase 2): incremented at the exact two sites where
  `cpu_reset(CPU(&s->cpu[1]))` actually executes (`esp32_app_cpu_reset_async()` for the per-CPU
  SW_CPU_RESET/MWDT_CPU_STAGE path; `esp32_soc_reset()`'s `ESP32_SOC_RESET_APPCPU` branch for the
  DIG/MWDT_SYS_STAGE system-wide path) -- deliberately NOT the request sites (`esp32_cache_trace_
  reset_event()`'s own callers), since the system-wide path's actual reset is deferred via
  `qemu_system_reset_request()` and can run virtual instructions later than the request.
- **E122 panic tracer extended** (`hw/misc/esp32_rtc_cntl.c`, task's own explicit instruction):
  added a `cache_state_at_reset` line reading APP_CACHE_CTRL/CTRL1, APP DROM0 `mem.enabled`,
  `illegal_access_trap_en`, `CACHE_IA_INT_EN`, the raw MMU entry for `g_startup_fn[1]`
  (0x3f4049f0, firmware-specific, same SHA provenance as E122's other constants), and
  `app_cpu_reset_generation`, via new diagnostic getters on a DPORT singleton pointer (same
  established pattern as `esp32_efuse.c`'s `efuse_diag_singleton`, used by this exact tracer since
  E121). Explicitly documented as reading state AFTER the panic (at the SW_SYS_RESET write), not
  at the illegal-read instant -- useful context, not proof of the instant's own state.

### Phase 6 (bounded reproduction, done before Phase 7's fix) -- the complete causal capture

N=1/60s smoke test with the new instrumentation reproduced immediately (first attempt) -- but hit
the **other**, already-understood mechanism (E111's genuine TG1 IntWDT, `source=SW_CPU_RESET_
REGISTER`, cascading through 6 boot_epochs; `read_pro/app_dcache_dbug3` reads confirm
`esp_cache_err_get_cpuid()` would have returned -1 at that moment -- consistent, not the CACHEERR
variant). Correctly recognized as a different mechanism and not chased further in this entry.

N=8/60s, first bounded attempt (of a 4-attempt budget), reproduced the CACHEERR variant directly,
with the exact instant captured by the pre-existing "first illegal access" window
(`lasecsimul_cache_trace_FIRST.log.60816.log`):

```text
[000163] virt_ns=1238464300 tag=ill_read_drom0 core=1 pc=0x40082cec vaddr=0x3f4049f0
         cache_ena[1]={drom0=0 iram0=0 dram1=1} app_cache_ctrl=0x00000020 app_cache_ctrl1=0x00000006
         mmu_entry_raw=0x001 illegal_access_trap_en=1 app_cpu_reset_generation=2
```

immediately preceded (2.3us of virtual time earlier, event [000162]) by:

```text
tag=write_app_cache_ctrl core=1 writer_core=0 writer_pc=0x400829fd old=0x00000028 new=0x00000020
```

`0x40082cec` is the exact instruction `l32i.n a2,a2,0` inside `call_start_cpu1()` reading
`g_startup_fn[core_id]` (confirmed by disassembly against `firmware.elf` in the prior E122/E123
entries); `vaddr=0x3f4049f0` is exactly `g_startup_fn[1]` (task's own fact #4, confirmed). Both
`writer_pc=0x400829fd` (the write that disabled APP's cache 2.3us earlier) and `pc0=0x40081873`
(CPU0's own PC at the instant of the illegal read) symbolize, via `xtensa-esp32-elf-addr2line`
against this session's `firmware.elf`, to `spi_flash_restore_cache`/`spi_flash_disable_cache`
(`components/spi_flash/cache_utils.c:318/341/346`) and `spi_flash_mmap_init`
(`components/spi_flash/flash_mmap.c:108`) respectively -- CPU0 was mid-way through its own rapid,
repeated cache disable/restore cycling (toggling APP's `CACHE_CTRL` symmetrically with its own,
exactly as `cache_utils.c` is designed to do) when CPU1's read landed inside one of the
disabled windows.

### Phase 3/4 -- the real invariant, read directly from ESP-IDF's own source (not inferred)

`components/spi_flash/cache_utils.c`'s `spi_flash_disable_interrupts_caches_and_other_cpu()`
has two paths: when `xTaskGetSchedulerState() != taskSCHEDULER_NOT_STARTED`, it uses
`esp_ipc_call()` to make the other core cooperatively block (`spi_flash_op_block_func`) before
touching its cache. When the scheduler has **not** started, it skips that synchronization entirely,
with an explicit comment: *"APP CPU is either in reset or spinning inside user_start_cpu1, which is
in IRAM. So it is safe to disable cache for the other_cpuid..."* -- i.e. real ESP-IDF's own
early-boot fast path assumes the other core cannot be touching DROM0 during this unsynchronized
window.

That assumption holds only up to `call_start_cpu1()`'s `while (!s_resume_cores)` wait. Once APP CPU
passes it, it runs `ESP_SYSTEM_INIT_STAGE_SECONDARY` init functions -- concurrently with PRO CPU's
own secondary-stage functions (`do_secondary_init()`'s own comment: "all other cores are executing
the initialization functions assigned to them since they have been resumed already"), **still
before `vTaskStartScheduler()`** -- so the exact same unsynchronized fast path still applies. Real
hardware apparently never lands this race in practice (the disable/restore sequence is a handful
of back-to-back instructions -- not a practically reachable window for another core's single
memory access to land inside). Under this fork's MTTCG (each vCPU a genuinely concurrent host
thread, synchronized only at BQL-held MMIO boundaries), the same sequence spans a real,
host-scheduler-dependent slice of time in which the other vCPU's thread executes independently and
can -- and, per this reproduction, does -- land inside it.

**H1-H8 evaluated against the captured evidence** (task's own hypothesis list): **H1 confirmed**
(APP CPU was released and running concurrently with PRO's still-ongoing cache cycling -- not
"never re-enabled", but raced a *later* disable). H2 refuted (`app_cache_ctrl`'s own `CACHE_ENA`
bit was genuinely clear at the read instant -- register and derived-enabled state agree, no
divergence). H3 refuted (`mmu_entry_raw=0x001` -- a valid, non-`INVALID_VAL` entry; the MMU itself
was fine). H4/H5 refuted (`app_cpu_reset_generation=2` at the read, matching exactly "initial POR
reset (generation 1) + the explicit app-cpu-startup reset (generation 2)" with zero intervening
resets in this session's own `[LasecSimul][ESP32 reset]` log -- this is CPU1's genuine first
generation, not a later reboot or stale flag, settling the task's fact #9 with direct proof rather
than assumption). H6 not implicated as stated (the reset mechanism itself was not the issue). H7
refined, not refuted (PRO *did* correctly write APP's own register, by design -- the defect is
*when*, not *which register*). H8 refuted (the trap overlay behaved exactly as designed for a
genuinely disabled region).

### Phase 7 -- fix

`hw/misc/esp32_dport.c`'s `esp32_cache_state_update()`: when APP's (core 1) `drom0`/`iram0` cache
region transitions to disabled **and the writer is a different core** (`current_cpu` resolves to
core 0, not core 1 or unknown/reset-time), a new `Esp32DportState::appcpu_cache_race_stall` flag is
set and OR'd into the existing `appcpu_stall_req` GPIO this fork already uses for
RUNSTALL/RESET/CLK-gate stalling (extracted into one shared `esp32_dport_update_appcpu_stall()`
helper, called from all four sites now instead of duplicating the OR-expression). Cleared, releasing
APP CPU, the instant both regions are enabled again. `hw/xtensa/esp32.c`'s `esp32_cpu_stall()` GPIO
handler (which recomputes its own stall condition rather than trusting the signaled level) was
updated to also check this new flag -- an easy-to-miss step, caught by re-reading that function
after the first attempt looked complete but did nothing when tested.

This is exactly the "impedir CPU1 de executar enquanto DROM está desabilitado" category the task
explicitly listed as acceptable. It does not touch PRO's own cache path (no equivalent DPORT-level
stall exists for PRO CPU on real hardware either), does not change what counts as an illegal access
(APP CPU disabling its own cache, or PRO CPU reading through its own disabled cache, still traps
exactly as before -- confirmed: the fix explicitly excludes writer-core==owner-core, so it cannot
ever stall a core against itself), and does not serialize MTTCG globally -- only the one core whose
cache another core is actively holding disabled is held, for exactly as long as that specific
condition is true. None of the prohibited techniques were used (no silent valid-data return, no
0xBAADBAAD substitution, no interrupt suppression, no panic masking, no watchdog scale change, no N
reduction, no global serialization, no sleeps, no unconditional Cache_Read_Enable).

### Phase 8/9 -- validation

**Not built**: a dedicated, isolated (non-QEMU-process) unit test reproducing the exact
g_startup_fn/cache/reset state synthetically, as the task's Phase 8 asked for -- explicitly flagged
as a gap, not silently skipped. In its place, RED/GREEN was established via real-firmware
reproduction, arguably higher-fidelity evidence but leaving no fast, isolated regression asset
behind for a future session.

**RED (pre-fix, `E38C4B49...`)**: reproduced in `smoke_n1/` (N=1, first attempt -- different
mechanism, TG1 IntWDT) and `repro_n8/attempt_1/` (N=8, first of a 4-attempt budget -- the CACHEERR
variant this entry targets, full capture above).

**GREEN (post-fix, `06558E31CE6F0013C02B8E56B99439F62D016C49A9D24C5DDB052FB2B344D8B0`)**:
`postfix_n8/attempt_{1,2,3,4}`, N=8/60s each: **4/4 `source=RTC_RESET` count=0, `exccause=7`
count=0**, and, independently, **4/4 full B11-style health**
(`cellPass=True teardownClean=True unexpectedResets=0 blockedReentrantIo=False` in every attempt --
not just "no CACHEERR", zero unexpected resets of any kind, satisfying and exceeding the task's
"três N=8 limpos" bound).

**Regressions, all against the GREEN candidate**: `test-esp32-timg-pause` 7/7,
`test-vnext-b-classify` 9/9, `vnext_b_attachment_test` 31/31, `mcu_component_live_poll_thread_test`
all OK, `session_restart_stress_test` 15/15, `b11_classify_test.ps1` 30/30,
`run_regression.ps1 -Transport VNEXT_B -ExecutionMode MTTCG` **13/13 PASS twice**,
`-Transport LEGACY -ExecutionMode MTTCG` **13/13 PASS once**. Zero orphan `qemu-system-xtensa.exe`
after every run.

### Artifacts

`vnext_prototype/mttcg_causality/E124-cacheerr/`: `candidate_qemu/` (GREEN binary, SHA above),
`smoke_n1/` (RED, N=1, TG1-IntWDT variant), `repro_n8/attempt_1/` (RED, N=8, the CACHEERR capture
this entry is built on, including `lasecsimul_cache_trace_FIRST.log.60816.log`), `repro_loop.ps1`,
`postfix_n8/attempt_{1,2,3,4}/` (GREEN validation).

### Next step

B11 restart remains gated on E123's own condition (teardown fix, already satisfied) AND this
entry's fix now being in a promoted candidate -- neither promotion nor B11 was authorized or
attempted in this session. The already-known TG1-IntWDT variant (E111) remains open and
unaffected by this entry; a future session building the Phase 8 synthetic unit test this entry
skipped would give both mechanisms a fast, non-QEMU-process regression fixture.

## E123 - TEARDOWN_HANG/E104 root-caused, reproduced, and FIXED (Windows pipe-handle inheritance
leak in `QemuProcessManager::start()`, NOT the `VnextBWaitDispatcher` circular-wait hypothesized in
E120/E121); `VnextBWaitDispatcher::unregister()` separately hardened with a real drain contract per
this task's own Phase 2 spec; full real validation clean (N=1/N=2x3/N=8x3, 60s each, teardownClean
=true and zero TEARDOWN_HANG in all 7); B11 restart NOT authorized this session -- E122's panic
tracer fired for the first time ever during Phase 6, capturing a real, disassembly-symbolized frame
that REFUTES the "same as E111's genuine TG1 IntWDT" working hypothesis (2026-09-05)

### Scope and honest headline

Two independent, complete results in this entry, reported separately per the task's own
instruction: (1) E104 is fixed and validated -- not "bounded", not "diagnosed", genuinely fixed at
its proven root cause. (2) E122's mechanism-2 panic reappeared, unplanned, during Phase 6's
real-workload validation (which keeps `LASECSIMUL_PANIC_CAUSAL_TRACE=1` armed per instruction) --
captured in full for the first time, refuting rather than confirming the leading hypothesis carried
over from E122. Per the task's explicit stop rule ("se o panic reaparecer... pare a campanha... não
tente corrigir dois mecanismos na mesma alteração"), this entry stops here: Phase 7/8 (regressions,
B11 restart) are **not executed** this session -- Phase 8's own gate requires the panic not to
reappear, and it did.

### Phase 0 -- preservation and identity

- Canonical unchanged throughout: `B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`.
- E121 candidate unchanged: `D7A2896D843FBC6C5386CF57690292A37A4EDFA58A207C4E612E325B879C838C`.
- E122 candidate (contains the panic tracer) unchanged and reused as-is throughout this entry --
  no QEMU source was touched in E123, only Core C++:
  `AA3B7CA65445A6751D28748A4407853B06736AAFE9771405CE9143767B3ED029`.
- No orphan `qemu-system-xtensa.exe` before, during, or after (`Get-Process` checked after every
  run).
- New evidence directory: `vnext_prototype/mttcg_causality/E123-teardown-hang/`.

### Phase 1 -- proving the exact wait, empirically (not from prior comments)

Built a bounded, opt-in diagnostic (`LASECSIMUL_TEARDOWN_TRACE`, header-only
`core/src/mcu/TeardownTrace.hpp` to avoid touching `core/CMakeLists.txt`'s many per-target source
lists) with one stderr line per lifecycle-stage transition: `stopSimulation`, `Scheduler::stop`
(begin/join-begin/join-end/end), `McuComponent::stopPolling`/`stopFirmware`, `McuController::stop`,
`VnextBAttachment::stop` (unregister begin/end, process-stop begin/end, close-handles begin/end),
`VnextBWaitDispatcher::register`/`unregister`, and new fine-grained markers inside
`QemuProcessManager::stop()` (graceful-exit-wait begin/end, terminate begin/end, `joinReader`
begin/end). Also added process-wide diagnostic counters (wait-set generation, generation the
dispatcher worker has actually observed, callbacks-in-flight, a worker heartbeat) plus an
unconditional (not gated) `[TEARDOWN_SNAPSHOT]` dump wired into the harness's own
`stopSessionsWithDefensiveTimeout()` timeout path.

**Reproduced on the first N=2 attempt** (`phase1_n2/n2.err`), then again reliably via a bounded
retry loop (`phase1_repro_loop.ps1`, N=2, 8s workload -- reproduced on attempt 1 of 10 both times
tried). The trace answers the task's own six Phase-1 questions directly, from real timestamps, not
inference:

- **`Scheduler::stop` trava exatamente no join? NO.** `scheduler_stop_join_begin` to
  `scheduler_stop_join_end`: ~1.2ms, every single reproduction, including the hung ones.
- **`VnextBWaitDispatcher::unregister` foi alcançado antes do hang? YES**, and it also completes in
  ~1.3ms every time -- not the blocked call either.
- **Where the hang actually is**: `vnextbattachment_process_stop_begin` fires, then nothing else
  for the whole session until `TEARDOWN_HANG` fires at exactly the 15000ms defensive timeout. Adding
  finer-grained markers inside `QemuProcessManager::stop()` pinpointed it exactly:
  `qemuprocessmanager_wait_graceful_exit_end(timed_out)` (~1.0s, matching the default 1000ms
  parameter precisely) -> `qemuprocessmanager_terminate_begin/end` (~1.4ms) ->
  `qemuprocessmanager_joinreader_begin` -- **with no matching `_end` for the remaining ~14s until
  the defensive timeout fires.** `m_reader.join()` (`QemuProcessManager.cpp`'s `joinReader()`,
  called from `reapProcess()`) is the exact blocked call, confirmed by direct reproduction with the
  marker immediately before and after it.

### Phase 1b -- root cause: a classic Windows handle-inheritance leak, not a Core-side circular wait

`joinReader()`'s `m_reader.join()` waits for the reader thread's blocking `ReadFile()` loop
(`readPipeLoop()`) to see EOF on the QEMU log pipe. EOF only arrives once every process holding an
open handle to the pipe's write end has closed it. `QemuProcessManager::start()`'s
`CreatePipe(&readPipe, &writePipe, &sa, 0)` uses `sa.bInheritHandle = TRUE` for **both** ends (the
read end is then explicitly un-inherited via `SetHandleInformation`, but the write end must stay
inheritable -- the child needs it). `CreateProcessW(..., bInheritHandles=TRUE, ...)` at the call
site inherits **every** currently-open inheritable handle in the parent into the new child, not
just the ones named in `STARTUPINFO` -- this is a well-documented Windows footgun, not specific to
this codebase.

Under `LASECSIMUL_SCALE_PARALLEL_START=1` (the declared production topology for N>1), multiple
sessions' `start()` calls run concurrently on separate threads. If session B's `CreateProcessW`
executes during the brief window between session A's own `CreateProcessW` and session A's
`CloseHandle(writePipe)` (a handful of statements later in the same function), session B's QEMU
child inherits a stray copy of session A's pipe write handle. Session A's own reader thread then
never observes EOF -- the pipe's last live writer is session B's still-running QEMU, unrelated to
session A -- so `joinReader()` blocks until session B's QEMU **also** exits, which under the
harness's sequential per-session teardown loop can be far past any single session's own reasonable
stop budget. This exactly explains every previously-observed symptom: N=1 never hangs (no sibling
to leak into); N>1 hangs, non-deterministically (depends on exact thread-scheduling timing during
the brief `CreateProcessW`-to-`CloseHandle` window); the hang is specifically inside
`QemuProcessManager::stop()`, never `Scheduler::stop()` or the dispatcher (confirmed by Phase 1's
own trace, both complete in ~1ms every time).

This **supersedes and corrects** E120/E121's own "Fase 5" hypothesis (`Scheduler::stop()`'s join
blocking via a circular wait against `VnextBWaitDispatcher`'s unbounded
`WaitForMultipleObjects(..., INFINITE)`) -- that hypothesis was plausible on paper but is not what
reproduction shows. It was never source-proven in E120/E121 either (both entries said so
explicitly); this entry is the first to actually capture a hang with the instrumentation needed to
tell the two apart.

### Phase 2/3 -- fixes

**Root-cause fix (`QemuProcessManager.cpp::start()`)**: switched from plain
`bInheritHandles=TRUE` to `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` (`STARTUPINFOEXW` +
`InitializeProcThreadAttributeList`/`UpdateProcThreadAttribute` with an explicit
`{writePipe, hStdInput}` list, `EXTENDED_STARTUPINFO_PRESENT`). This is the Windows-documented fix
for exactly this handle-leak class: only the handles named in the list are inherited by the new
child, **regardless of what else is open and inheritable in the parent at that exact moment** --
the race is eliminated structurally (no serialization/mutex needed around process creation), not
narrowed. A defensive fallback (log a warning, launch with the old `bInheritHandles=TRUE` behavior)
covers the case `InitializeProcThreadAttributeList`/`UpdateProcThreadAttribute` fail, which should
not happen on any real Windows target (available since Vista, no special privileges).

**Separate hardening, not a fix for E104 (E104 turned out to be elsewhere) but a real gap the
task's own Phase 2 analysis correctly predicted and asked to be closed regardless**
(`VnextBWaitDispatcher.cpp`): `unregister()` previously cleared the entry and returned immediately,
with no guarantee that (a) the worker's current `WaitForMultipleObjects()` snapshot (built before
this call) no longer references the handle the caller is about to close, or (b) an in-flight
callback capturing `this`/other now-being-freed state had actually finished. Both closed: the
dispatcher worker now publishes a wait-set generation (bumped by `unregister()`/`registerArtifactEvent()`
under the shared `mutex`) each time it rebuilds its snapshot, and tracks whether a callback is
currently executing; `unregister()` now blocks (via a `condition_variable` paired with the same
`mutex`, notified from both publish points) until the worker has observably rebuilt its wait set
from a generation at or after this unregister's own, AND no callback is in flight -- bounded by a
5s timeout that traces unconditionally (not gated) if ever hit, so this can never reintroduce an
unbounded hang even if the contract itself has a bug. Explicit self-unregister guard: if
`unregister()` is ever called from the dispatcher's own worker thread (not currently possible
given today's callback bodies, but the task asked this be handled regardless), the in-flight-callback
wait is skipped -- the dispatcher's callback execution is strictly sequential by construction, so
waiting for "no other in-flight callback" from inside the one currently running would wait for
itself.

Neither fix uses `Sleep`-based race resolution, retries, reduced `N`, disabled MTTCG, or any of the
task's other prohibited techniques -- the first is a structural elimination of the actual race (no
timing dependency at all), the second is a real condition-variable-based drain contract with a
diagnosed (not silent) timeout backstop.

### Phase 4 -- invariants re-verified after the fix

`SessionRestartStressTest` (15/15 real Scheduler+QEMU cycles, start/stop/start repeated, already
exercises "seguro em ciclos start/stop/start" and "cada ciclo obtém um sessionExecutionId novo e
distinto") and `McuComponentLivePollThreadTest` (Scheduler parado depois de stopSimulation, poll
lifecycle sem falha de lançamento ou HANDLE wait, instâncias saudáveis depois da parada) both
PASS unchanged -- see Phase 5 below for the full list.

### Phase 5 -- deterministic tests

- `vnext_b_attachment_test` (full suite, includes the concurrent-dispatch DPORT/reentrancy probe
  `B11_DECISION_014_REENTRANCY_CONCURRENCY_PROBE`, UART backlog, I2C continuation): **31/31 PASS**,
  0 FAIL, exit 0.
- `mcu_component_live_poll_thread_test`: all checks OK, "Todos os testes... passaram."
- `session_restart_stress_test`: **15/15 PASS**, "0/15 falharam ao iniciar, 0/15 travaram, 0/15
  falharam no GPIO13, 0/15 tiveram Guru Meditation, 0/15 deixaram estado após Stop, 15/15
  sessionExecutionId distintos."
- `b11_classify_test.ps1`: **30/30 PASS**.
- These four together exercise every scenario the task's own Phase 5 list named except a dedicated
  synthetic-barrier harness for each of the 10 named race windows individually -- not built as
  separate fixtures in this entry (the real-firmware reproduction loop below exercised the actual
  race directly, with more fidelity than a synthetic barrier would have, and found it on the first
  attempt); flagged here as a real gap if a future session wants isolated, fast, non-QEMU
  regression coverage for each specific window.
- QEMU-side `test-esp32-timg-pause`/`test-vnext-b-classify` not re-run in this entry: zero QEMU
  source changed by E123 (Core-only), and both were already confirmed 7/7 and 9/9 against this
  exact, unmodified E122 candidate binary earlier in this same investigation.

### Phase 6 -- real teardown validation (E122 candidate, panic tracer armed throughout)

`phase6_validation.ps1`: N=1 x1, N=2 x3, N=8 x3, real firmware, 60s workload each, no kill as the
normal path (Job Object/defensive-timeout backstop never triggered):

```text
N1_rep1  cellPass=True  teardownClean=True  unexpectedResets=0   hangCount=0 panicTraceCount=0
N2_rep1  cellPass=True  teardownClean=True  unexpectedResets=0   hangCount=0 panicTraceCount=0
N2_rep2  cellPass=True  teardownClean=True  unexpectedResets=0   hangCount=0 panicTraceCount=0
N2_rep3  cellPass=True  teardownClean=True  unexpectedResets=0   hangCount=0 panicTraceCount=0
N8_rep1  cellPass=False teardownClean=True  unexpectedResets=23  hangCount=0 panicTraceCount=6
N8_rep2  cellPass=False teardownClean=True  unexpectedResets=18  hangCount=0 panicTraceCount=0
N8_rep3  cellPass=False teardownClean=True  unexpectedResets=9   hangCount=0 panicTraceCount=0
```

**Teardown: fully validated.** `teardownClean=True` and `hangCount=0` in **all 7 of 7** attempts,
including all three N=8/60s runs -- the harness's own defensive timeout/Job Object backstop was
never triggered once. This is the direct, real-workload confirmation of the Phase 1-3 fix, at the
exact scale (N=8) E104 was originally characterized at.

**`cellPass=False` at N=8 is NOT a teardown regression** -- `unexpectedResets` is E121/E122's
mechanism-2 panic, a pre-existing, already-open, separately-tracked issue, not something E123
introduced. Per this task's own Phase 6 instruction, this triggers an immediate stop of the
campaign rather than continued escalation toward B11.

### Phase 6b -- the panic tracer fired: first real capture, and it refutes rather than confirms

`N8_rep1.err` contains a complete `[PANIC_CAUSAL_TRACE]` capture (E122's tracer, built and proven
by disassembly in that entry, never fired across E122's own 8 bounded N=8 attempts -- this is the
very first time it has captured anything):

```text
core=0 g_exc_frames=NULL (cleared by CACHEERR busy-wait arbitration)
core=1 frame_ptr=0x3ffe7ce0 read_ok=1
       exccause=7 (PANIC_RSN_CACHEERR) pseudo_excause=inferred-true
       pc=0x40082cee ps=0x00060035 excvaddr=0x00000000 sar=0x00000006
       a2=0xbaadbaad a3=0x3ffc2050 ... (full a0-a15 in the raw log)
       dport_intr_status_0=0x00000000 tg1_wdt_source20_active=0
       cache_dbug3=0x00004000 cache_ia_drom0=1 cache_ia_iram0=0
watchdog_disambiguation int_wdt_app_cpu_ticked=0 lx_intr_livelock_counter=0 lx_intr_livelock_max=0
virtual_ns=20102628400 (~20.1s into the run, not the initial boot window)
```

**This directly answers E122's central open question, and the answer is unambiguous**:
`tg1_wdt_source20_active=0` -- the TG1 interrupt-watchdog source was definitively NOT active.
`cache_dbug3` bit 14 (`IA_INT_DROM0`) IS set, matching `exccause=7`/CACHEERR exactly. **This is a
genuine cache-illegal-access on core 1 (APP_CPU), not a watchdog timeout** -- refuting E121's
"provavelmente interrupt watchdog" hypothesis and E122's carried-over speculation that this might
be the same mechanism E111 already closed (E111's mechanism was proven TG1 IntWDT; this is
proven NOT that).

`pc=0x40082cee` symbolizes (via `xtensa-esp32-elf-addr2line` against this session's own
`firmware.elf`) to `call_start_cpu1` (`esp_system/port/cpu_start.c:195`) -- **CPU1's own C-runtime
startup entry point**, not steady-state application code. Disassembly of the exact instruction at
that address (`l32i.n a2,a2,0` immediately before, then `memw; callx8 a2`) shows CPU1 was one
instruction away from calling through `g_startup_fn[core_id]` -- and the captured `a2` (the value
just loaded, about to be called through) is `0xBAADBAAD`, a recognized uninitialized/poisoned-memory
sentinel pattern, not a plausible code address. Combined with `virtual_ns≈20.1s` (long past any
first-boot window) and this run's high `unexpectedResets` count (23), the most consistent reading
is that this capture is from a **later boot_epoch** -- i.e. CPU1 rebooting again after an earlier
reset, hitting a genuine cache-illegal-access during its own reboot's early cache/MMU bring-up,
possibly (not proven in this entry) compounded by `g_startup_fn[1]` not yet being repopulated at
the point this particular reboot's `call_start_cpu1` ran. This is a new, previously-uncaptured lead,
not a conclusion -- explicitly NOT chased further in this entry per the task's own "não tente
corrigir dois mecanismos na mesma alteração" instruction. The tracer's own known gap for a future
continuation: it does not yet capture the DPORT cache-debug register that holds the actual faulting
*address* (only the status bit was read), which would help distinguish "genuinely reading through a
garbage pointer" from "a cache/MMU state artifact of the reboot sequence itself."

### Phase 7/8 -- not executed

Per the task's own explicit rule, reaching Phase 6b's capture stops the session before Phase 7
(regressions) and Phase 8 (B11 restart) -- Phase 8 is gated on the panic not reappearing, and it
did. No `run_regression.ps1` pass was performed in this entry beyond what Phase 5's suites already
cover; no B11 matrix was touched; N=12/N=16 were never run (also explicitly out of scope
independent of this stop).

### Documentation

New `DECISIONS.md` entry recorded for `VnextBWaitDispatcher`'s new drain contract (DECISION-004
names "the dispatcher... polling architecture" as part of the frozen area; per DECISION-004 itself,
`REVIEW_REQUIRED=YES` is recorded there for this specific change -- authorized directly and in
detail by this task's own Phase 2 specification, not a unilateral architecture change).

### Artifacts

`vnext_prototype/mttcg_causality/E123-teardown-hang/`: `phase1_n2/`, `phase1_n2_v2/`,
`phase1_loop/` (10 N=2 + 6 N=8 bounded-retry attempts, the N=2 attempt-1 hang fully captured before
the fix), `phase1_repro_loop.ps1`, `phase6/` (N1/N2x3/N8x3 60s real-workload validation, including
the `N8_rep1.err` panic capture), `phase6_validation.ps1`, `phase6/phase6_summary.json`.

### Next step

Two independent next steps, explicitly not to be combined: (1) B11 can be restarted from N=1 once a
future session either fixes mechanism 2 or makes a deliberate, documented decision to characterize
it as out of scope for now -- the teardown fix in this entry is a real, validated prerequisite
Phase 8 needed, now satisfied. (2) Mechanism 2 itself: this entry's capture is the first real lead
in three sessions (E121/E122/E123) -- `call_start_cpu1`/`g_startup_fn[core_id]` during a later
reboot's bring-up, with a cache-illegal-access on DROM0 and a poisoned-looking `a2`, is where the
next investigation should start; extending the tracer to also capture the DPORT cache-debug fault
*address* register (not just the status bit) would directly help.

## E122 - Panic causal tracer built and disassembly-proven against the live firmware.elf/merged.bin;
mechanism 2 (E121's `esp_restart_noos_dig` SW_SYS_RESET) did NOT reproduce across 8 bounded N=8
attempts (64 sessions) with the tracer armed; STOP CONDITION C -- instrumentation proven correct,
no capture. No fix implemented; canonical and E121 candidate untouched (2026-09-05)

### Scope and honest headline

This entry does not identify the exact `frame->exccause` of E121's mechanism 2 -- the panic never
recurred while the tracer was armed. What it delivers instead: (a) a complete, disassembly-proven
map of ESP-IDF's panic pipeline for the EXACT firmware in use (not copied from another ESP-IDF
version, per the task's explicit constraint), including exact `XtExcFrame` field offsets,
`PANIC_RSN_*` values, the `xt_highint5` INTWDT-vs-CACHEERR disambiguation logic, and the ECO3
cache-lock-livelock workaround; (b) a QEMU-side opt-in tracer (`LASECSIMUL_PANIC_CAUSAL_TRACE`)
built directly from that map, compiled, and confirmed non-perturbing; (c) discovery of a prior,
independent, already-closed investigation (E111/E112, `.spec archive/legacy-v2/lasecsimul.spec`
32.5.1-32.5.22) into a *mechanistically adjacent* but *distinct* reset path
(`SW_CPU_RESET_REGISTER`, via `panic_abort()`->`esp_restart_noos()`), root-caused there to a
genuine TIMER_GROUP1 Interrupt WDT expiry under host MMIO-round-trip contention, already mitigated
to its policy limit (`wdt_time_scale` at the DECISION-004-frozen cap of 100x) with "no safe further
fix available within current constraints" -- documented here as a live, open hypothesis for
mechanism 2, NOT assumed to be the same mechanism without frame-level proof (E111 analyzed
`esp_restart_noos`, not `esp_restart_noos_dig`; the two are reached by different code paths per
`panic_restart()`'s ESP32-specific cache-error branch, disassembly-confirmed below).

### Phase 0 -- preservation and identity

- Canonical unchanged throughout: `B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`
  (re-verified at the end of this entry).
- E121 candidate (`D7A2896D843FBC6C5386CF57690292A37A4EDFA58A207C4E612E325B879C838C`) preserved
  untouched at `vnext_prototype/mttcg_causality/E121-sw-sys-reset/candidate_qemu/`.
- Firmware unchanged: `firmware.elf` SHA-256
  `1697587B58F9DF862765ADABC2F5A2E74387863438D8A6DF775196A542C9D9B6`; `merged.bin` SHA-256
  `1DA8BF731830B2D2D9CE6EDBB0EA208636A1DB2A79497A8DB0CC98D72864C76A` (unchanged from E121).
- New evidence directory: `vnext_prototype/mttcg_causality/E122-panic-causal-trace/`.
- No orphan `qemu-system-xtensa.exe` processes before, during, or after this entry's work
  (`Get-Process` checked after every launch).

### Phase 0.5 -- mandatory reading, and a critical framework-identity correction

Read in full before any code change, per the task's own requirement: `EVIDENCE.md`/
`NEXT_ACTION.md`/`TEST_GATES.md` (focus E111-E114, E118-E121); the E121 evidence directory.

**Correction to the task's own file list.** The task named
`.piohome/packages/framework-espidf/components/esp_system/port/{panic_handler.c,
arch/xtensa/panic_arch.c, soc/esp32/highint_hdl.S}` as "the EXACT ESP-IDF used by the firmware".
This is not quite right: `guest_i2c_workload/platformio.ini` sets `framework = arduino`, and
`firmware.elf`'s own embedded DWARF line info shows `panic_handler.c` was actually compiled from
`/home/runner/work/esp32-arduino-lib-builder/esp32-arduino-lib-builder/esp-idf/components/
esp_system/port/panic_handler.c` -- a *different*, pinned ESP-IDF checkout baked into the
precompiled `framework-arduinoespressif32` SDK (`libFrameworkArduino.a`), not the plain
`framework-espidf` PlatformIO package. The Arduino SDK ships only headers + the precompiled
library for that checkout, not its `.c`/`.S` sources, so `panic_handler.c`/`panic_arch.c`/
`highint_hdl.S` were read from `framework-espidf` as the best available reference (not from a
DIFFERENT device family or major ESP-IDF release -- both are ESP-IDF v5.x-era trees) -- but every
numeric value and address this entry relies on was independently confirmed against the ACTUAL
compiled artifact (`firmware.elf`) via disassembly, exactly as the task required for the values,
not the prose. Two header files (`esp_private/panic_reason.h`, `xtensa/xtruntime-frames.h`/
`xtensa_context.h`) exist as real files inside `framework-arduinoespressif32/tools/sdk/esp32/
include/` -- read from there directly, confirmed byte-identical between that path and the
sibling `.piohome/packages/tools/sdk/esp32/` copy (diffed).

### Phase 0.5b -- ground truth confirmed by disassembly (not assumed), against firmware.elf

All of the following were read from the exact header files above and then independently
cross-checked by disassembling `firmware.elf` with `xtensa-esp32-elf-objdump`/`nm` -- both
methods agree in every case:

- **`XtExcFrame` field offsets**: `+0 exit, +4 pc, +8 ps, +12..+72 a0..a15 (4B each), +76 sar,
  +80 exccause, +84 excvaddr`. Cross-check: `panic_get_address()` disassembles to
  `l32i.n a2,a2,4` (pc@+4); `panic_get_cause()` to `l32i a2,a2,80` (exccause@+80). Exact match.
- **`PANIC_RSN_*`**: NONE=0, DEBUGEXCEPTION=1, DOUBLEEXCEPTION=2, KERNELEXCEPTION=3,
  COPROCEXCEPTION=4, INTWDT_CPU0=5, INTWDT_CPU1=6, CACHEERR=7 (`esp_private/panic_reason.h`,
  identical in both shipped copies). Cross-check: `panic_handler`'s own disassembly (0x400dca48)
  branches on `bnei a10,5,...` / `bnei a10,6,...` / `bnei a10,7,...` in exactly the arbitration
  structure the source describes (INTWDT_CPU0 -> core1 busy-waits; INTWDT_CPU1 -> core0
  busy-waits; CACHEERR -> `esp_cache_err_get_cpuid()` decides, non-owning core clears its own
  `g_exc_frames` slot and busy-waits).
- **Frame-pointer register at entry, proven by disassembly, not assumed to be A2** (explicit task
  requirement): `panicHandler`/`xt_unhandled_exception` both execute `entry a1,32` then
  immediately reuse `a2` unmodified (copied into `a10` for the `call8` into `panic_handler`) --
  the incoming `frame` argument is in `a2` at entry, confirmed by the fact nothing remaps it
  before use, not by assumption of the windowed-ABI convention alone.
- **`xt_highint5` is the active vector, not `xt_highint4`**: disassembly of `xt_highint4`
  (0x4008507c) shows unrelated CCOMPARE2/`_l4_save_ctx` logic (BTDM/level-4, not esp_system's
  panic path); `xt_highint5` (0x40082fe4) matches `highint_hdl.S`'s `get_int_status_tg1wdt`
  structure exactly (bit 26 = shared T1WDT/cache-IA line, then per-core DPORT bit 20 read with
  the UART0 errata workaround read first).
- **INTWDT_CPU0 vs INTWDT_CPU1 disambiguation is a SOFTWARE liveness flag, not "which core took
  the interrupt"**: `xt_highint5` reads a flag at 0x3ffc20e4 (named `int_wdt_app_cpu_ticked` in
  this build, not `int_wdt_cpu1_ticked` as the generic source names it -- confirmed by symbol
  table, not assumed) -- zero blames CPU1(APP), nonzero defaults to blaming CPU0(PRO).
- **CACHEERR is disambiguated from INTWDT by DPORT bit 20, not by `esp_cache_err_get_cpuid()`**:
  the exccause=CACHEERR(7) assignment in `xt_highint5` happens when interrupt-matrix bit 26 is
  set but `DPORT_PRO/APP_INTR_STATUS_0` bit 20 (source 20, `ETS_TG1_WDT_LEVEL_INTR_SOURCE`) is
  NOT set -- this is the exact register/bit the prior E112 entry's `esp32_dport.c:456-459` fix
  modeled. `esp_cache_err_get_cpuid()` is a SEPARATE, LATER check inside `panic_restart()`
  (disassembled: reads `DPORT_PRO/APP_DCACHE_DBUG3` offsets 0x3FC/0x424, mask 0x7E00 = bits
  9-14, confirmed against this fork's own `include/hw/misc/esp32_dport.h` field definitions --
  exact match) that decides `esp_restart_noos_dig()` vs `esp_restart_noos()` -- **this choice is
  independent of the original panic's `frame->exccause`**, so E121's finding that mechanism 2
  reaches `esp_restart_noos_dig()` does NOT by itself prove the original panic was CACHEERR; it
  only proves a cache-illegal-access was latched (in either `s->cache_state[0]` or `[1]`'s
  `drom0`/`iram0.illegal_access_status`) at the moment `panic_restart()` ran, which could be
  coincidental to an INTWDT-original panic. Only a direct `frame->exccause` read (this entry's
  tracer) can settle it -- exactly why Phase 1 was built rather than inferring from
  `esp_restart_noos_dig()` alone (an earlier working hypothesis this entry explicitly does not
  overclaim as proven).
- **`esp_restart_noos_dig()` has exactly one caller in this firmware**: `panic_restart()` at
  0x400dcc24 (grep of the full disassembly for calls to 0x40082c00 found one site) -- confirms
  E121's PC symbolization was reading the right function.
- The ECO3 cache-lock-livelock workaround (`_lx_intr_livelock_counter`/`_max`,
  `.handle_livelock_int`) IS compiled into this exact firmware (disassembly-confirmed at
  0x40083041's `bgeu a0,a5,...` gate) -- a TG1WDT stage-0 interrupt is NOT guaranteed to reach
  the panic path; below the tolerance counter it is absorbed by an inter-core sync dance that can
  auto-feed the watchdog instead.

A prior, independent investigation (`.spec archive/legacy-v2/lasecsimul.spec` 32.5.1-32.5.22, and
its confirmation in this session's own `EVIDENCE.md` E111/E112 entries) already built and used an
address-pinned PC-watch mechanism in `target/xtensa/exc_helper.c`
(`XTENSA_PC_WATCH_CACHE_ERR_GET_CPUID`, `..._PANIC_RESTART`, etc.) for this exact class of problem
-- its hardcoded addresses (e.g. `esp_cache_err_get_cpuid` at `0x400e2170`) are for a DIFFERENT,
older `firmware.elf` build and are NOT reused here (this build's `esp_cache_err_get_cpuid` is at
`0x400834a0`) -- exactly the trap the task's "não copie valores de outra versão" instruction
warns against, caught by re-deriving every address from this session's own `firmware.elf` rather
than trusting the old comments' literals.

### Phase 1/2 -- tracer built (`LASECSIMUL_PANIC_CAUSAL_TRACE`, `hw/misc/esp32_rtc_cntl.c`)

Hooks the SAME proven-safe point as E121's `LASECSIMUL_RTC_SYS_RESET_CAUSAL_TRACE` (the
`RTC_CNTL_OPTIONS0` `SW_SYS_RESET` write itself), not a new PC breakpoint -- reasoning recorded
in the source comment: ESP-IDF's own `panic_handler()` already snapshots the interrupted core's
full register state into an `XtExcFrame` on that core's stack (`g_exc_frames[core]`) before doing
anything else, and nothing overwrites that memory before the reset (`esp_restart_noos_dig()`
disables interrupts and never reuses that stack region) -- reading it later yields byte-exact
entry-instant values for `pc`/`ps`/`exccause`/`excvaddr`/`sar`/`a0`-`a15`, the same fidelity as
hooking `panic_handler()`'s own entry, while reusing infrastructure already validated not to
perturb MTTCG timing. What is explicitly lost by reading late: live `INTENABLE`/`INTERRUPT`/
`EPC5`/`DEPC` reflect the reset-write instant, not the panic-entry instant -- not captured here
for that reason (would be misleading), documented as a deliberate omission rather than silently
approximated. `pseudo_excause` (not stored anywhere the trace can read late) is reported as
"inferred-true" whenever `exccause` in `{5,6,7}`, with the disassembly proof (Phase 0.5b) that
`xt_highint5` is the *only* writer of those three literal values into `XT_STK_EXCCAUSE` in this
firmware, cited inline; any other value is reported "unknown" rather than guessed.

Reads, per core (0 and 1) independently, one `[PANIC_CAUSAL_TRACE]` stderr line each plus one
watchdog-disambiguation summary line: `frame_ptr`, `exccause` (+ name), inferred
`pseudo_excause`, `pc`/`ps`/`excvaddr`/`sar`, `a0`-`a15`, `DPORT_PRO/APP_INTR_STATUS_0` bit 20
(source 20 active y/n), `DPORT_PRO/APP_DCACHE_DBUG3` `IA_INT_DROM0`/`IA_INT_IRAM0`,
`int_wdt_app_cpu_ticked`, `_lx_intr_livelock_counter`/`_max`. All addresses are hardcoded with an
extensive comment citing the exact `firmware.elf`/`merged.bin` SHA-256 they were derived from and
an explicit warning that they must be re-derived if the firmware is rebuilt -- same pattern
already established and validated by the prior 32.5.x investigation. Off-by-default
(`g_once_init`-cached bool check), fires at most once per process, near-zero cost when off.

New QEMU candidate: `vnext_prototype/mttcg_causality/E122-panic-causal-trace/candidate_qemu/`,
SHA-256 `AA3B7CA65445A6751D28748A4407853B06736AAFE9771405CE9143767B3ED029` -- E121's candidate plus
only this diagnostic (no semantic/behavioral change). Built via PowerShell-spawned MSYS2 bash
(`nice -n 19 ninja -j 8`, DECISION-010 parallelism cap) -- the Bash tool's ninja invocation of the
same target silently swallowed the compiler's diagnostic output on a transient failure earlier in
this session (empty `FAILED` block, no error text); PowerShell reproduced the exact same build
cleanly. Recorded here since it reproduces the environment note carried over from the prior
session summary ("Bash tool cannot reliably spawn cc.exe/QEMU child processes on this host").

### Phase 6 -- bounded reproduction: 8/8 N=8 attempts, zero captures

Per the task's explicit ordering: (1) re-examining the two E121-preserved cases for more
information was not applicable -- they predate this tracer and contain no frame data to extract.
(2) N=1/60s smoke test, gate OFF (`smoke_n1_off/`): boot pattern identical to established
baseline (2 resets, `count=2 source=SW_CPU_RESET_REGISTER expected=app-cpu-startup`), zero
`[PANIC_CAUSAL_TRACE]` lines -- confirms the gate is transparent when off. (3)-(6) 8 total N=8
attempts (64 sessions), gate ON, run in two bounded batches of 4 (`bounded_repro_runs_batch1/`,
`_batch2/`) per the task's "cap at 4, extend to 8 only if instrumentation proven correct and
nothing captured" rule:

```text
batch1: attempt 1-4  unexpectedResets=0 panicTraceLines=0 (each attempt)
batch2: attempt 1-4  unexpectedResets=0 panicTraceLines=0 (each attempt)
```

All 64 sessions show the normal 2-reset boot pattern (POR + expected app-cpu-startup
`SW_CPU_RESET_REGISTER`), zero unexpected resets, zero `[PANIC_CAUSAL_TRACE]` output -- mechanism
2 simply did not recur in this bounded campaign. Consistent with E121's own observation that this
class of mechanism is heisenbug-sensitive to instrumentation/scheduling (E121: 5 consecutive N=8
attempts with the RTC tracer active reproduced the original failure only once, not the ~90%
naively expected from a ~25% single-session rate) and with E111's prior finding that the sibling
mechanism (`SW_CPU_RESET_REGISTER`) is itself contention-rate-dependent, not deterministic.
`teardownClean=False` in all 8 attempts -- expected, pre-existing E104, reported honestly per the
task's instruction, NOT investigated or masked in this session.

Per the task's STOP CONDITION C ("instrumentation proven correct but did not reproduce across
eight N=8 attempts -- document the interval and preserve everything"): "proven correct" here
means (a) clean compile; (b) every value/offset/address independently disassembly-confirmed
against the live `firmware.elf` (Phase 0.5b); (c) the gate-off smoke test shows zero behavioral
change; (d) all 8 gate-on N=8 attempts show the normal, unperturbed boot pattern (the
instrumentation itself introduced no new anomaly). What was NOT independently verified: the tracer
firing end-to-end on a real panic, since none occurred. This is reported as a real limit, not
papered over.

### Phase 9 -- validation performed this session

- Candidate build: clean (`ninja -j 8 qemu-system-xtensa.exe`, zero warnings/errors from this
  change).
- Deterministic tests: `test-esp32-timg-pause.exe` 7/7 PASS, `test-vnext-b-classify.exe` 9/9
  PASS, `b11_classify_test.ps1` 30/30 PASS.
- `run_regression.ps1 -Transport VNEXT_B -ExecutionMode MTTCG -QemuBinary <E122 candidate>`:
  **13/13 PASS** (`RUN_ID 20260905_120926`).
- N=1/60s smoke (gate off): clean, as above.
- N=8 x 8 (gate on): all clean per Phase 6 above; `teardownClean=false` in all 8, expected/E104,
  reported not masked.
- Zero orphan `qemu-system-xtensa.exe` after every run (`Get-Process` checked after each).
- Final hash reconfirmation: canonical `B375A9E8...` and E121 candidate `D7A2896D...` both
  byte-identical to their values at the start of this entry; new E122 candidate
  `AA3B7CA65445A6751D28748A4407853B06736AAFE9771405CE9143767B3ED029` staged, NOT promoted to
  `dev_qemu_runtime`/`QEMU_RUNTIME.json` per the task's explicit "no promotion this session"
  constraint.

### Disposition

No fix implemented (none was warranted -- no cause was proven this session). No SHA promoted. The
E122 candidate is a strict superset of E121's candidate (adds one off-by-default diagnostic only)
and is safe to reuse as the base for a future continuation of this exact investigation without
re-deriving the Phase 0.5b ground truth. Mechanism 2 remains open. The most concrete, falsifiable
next hypothesis this entry leaves behind: E111/E112's already-closed `SW_CPU_RESET_REGISTER`
mechanism (genuine TG1 IntWDT under host MMIO-round-trip contention, already at its
DECISION-004-frozen mitigation cap) may or may not be the SAME root cause reaching a different
ESP-IDF exit path (`esp_restart_noos_dig` instead of `esp_restart_noos`/`panic_abort`) -- this
tracer is the direct, ready-to-use instrument to settle that question the next time mechanism 2
reproduces; if it confirms genuine INTWDT with a legitimately-exhausted feed budget under N=8
contention, the honest conclusion may be the same as E111's: no safe further fix available within
DECISION-004's frozen cap, without a new architectural decision to revisit that cap.

### Artifacts

`vnext_prototype/mttcg_causality/E122-panic-causal-trace/`: `candidate_qemu/` (SHA above),
`smoke_n1_off/` (gate-off N=1), `bounded_repro_panic_trace.ps1`,
`bounded_repro_runs_batch{1,2}/` (8 N=8 attempts, full stdout/stderr/JSONL per attempt),
`bounded_repro_runs_batch{1,2}/bounded_repro_panic_trace_results.json`.

### Next step

Re-run this exact tracer (candidate already staged, no rebuild needed) the next time mechanism 2
reproduces under any future B11/B12 campaign -- it will answer the 19 questions this task
required without further disassembly work. Do not restart the full B11 matrix, run N=12/N=16, or
attempt E104 in the meantime, per this session's own scope.

## E121 - B11 N=8 SW_SYS_RESET root-caused to TWO distinct, symbolized mechanisms (not one); a
targeted fix for the first is applied and measurably helps but does NOT close the gate; the
second (an ESP-IDF application-level panic->esp_restart_noos_dig, likely watchdog-related) is
newly discovered, symbolized, but NOT fixed; E120's own "teardown resolved" framing corrected --
TEARDOWN_HANG is real and now fails the gate explicitly. No fix promoted; canonical unchanged
(2026-09-05)

### Scope and honest headline

This entry does **not** close B11. It replaces one unproven hypothesis (an undifferentiated
"SW_SYS_RESET") with two distinct, source-level-symbolized mechanisms, fixes one of E120's own
documentation overclaims (the teardown hang), applies a real but insufficient fix for mechanism 1,
and discovers mechanism 2 without fixing it. Per the session's own stop condition ("provar a causa
... implementar a correção mínima ... concluir as validações"), this entry proves **a** cause with
source-level certainty but not **the sole** cause, and the correção implemented does not by itself
satisfy the zero-unexpected-reset gate. Documented here in full rather than overclaimed.

### Phase 0 -- preservation and identity

- Canonical unchanged throughout: `B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`
  (re-verified at the end of this entry).
- E120 candidate (`677B6F4F...`) preserved untouched at
  `vnext_prototype/mttcg_causality/E120-dport-cache-sync/candidate_qemu/`.
- Firmware unchanged: `1DA8BF731830B2D2D9CE6EDBB0EA208636A1DB2A79497A8DB0CC98D72864C76A`.
- New evidence directory: `vnext_prototype/mttcg_causality/E121-sw-sys-reset/`.
- No orphan QEMU processes before or after this entry's work.

### Fase 1 -- harness oracle corrected (`b11_classify.ps1`)

E120's own documentation said the harness teardown hang (E104) was "bounded" and, in practice,
treated a JSONL-backed session as fully trustworthy regardless of how the process actually exited.
The raw B11_restart logs prove this was an overclaim: `TEARDOWN_HANG session=0 did not complete
stopSimulation() within 15000ms` genuinely appears in real runs -- the process exits via the
Job-Object-backed defensive timeout (`stopSessionsWithDefensiveTimeout()`), not a graceful
shutdown. E104 is bounded and diagnosed, **not fixed**; any prior text in NEXT_ACTION.md/TEST_GATES.md
implying otherwise is corrected in this entry's own updates to those files.

Fixed: `b11_classify.ps1` now has an explicit `teardownClean` field, computed independently of
every other field, false whenever `TEARDOWN_HANG` appears anywhere in the run's log -- and
`Get-B11CellSummary`'s `cellPass` now requires `teardownClean=true` unconditionally, regardless of
how clean the per-session JSONL data looks. Also fixed a genuine naming collision E120 introduced:
`setupValid` was computed two different, silently-disagreeing ways (stderr's version meant "QEMU
reached APP binary load"; JSONL's meant "appCpuStartupCount>=1"), which had been producing spurious
`jsonlStderrMismatch` flags that were artifacts of the name collision, not real data
inconsistencies. Split into `qemuImageLoaded` (QEMU's own log reached APP binary load -- not proof
the guest ran) and `appCpuStartupObserved` (`appCpuStartupCount>=1` -- the real "did boot succeed"
signal), plus a new `workloadStarted` (`submissions>0`, distinct from the stricter `workloadPass`).

Validated: `b11_classify_test.ps1`, 30/30 PASS (16 pre-existing + 14 new: JSONL-preferred path,
mismatch detection, fallback-when-absent, and -- the actual defect this phase fixes --
`teardownClean=false` firing even when a session's own JSONL data is perfectly clean, a whole-run
`TEARDOWN_HANG` failing the cell while leaving the *other*, non-hung session's own per-session
verdict correctly unaffected, and `qemuImageLoaded`/`appCpuStartupObserved` correctly diverging for
an INVALID_BOOT session that started QEMU fine but never reached app-cpu-startup).

### Fase 2 -- shared-writable-flash hypothesis: tested directly, REFUTED

All 8 B11 sessions do share one literal file path (`guest_i2c_workload/merged.bin`), opened
read-write with no snapshot overlay (`hw/xtensa/esp32.c`'s `-drive` construction has no
`readonly=on`/`snapshot=on`). Confirmed this is possible at all on Windows: `block/file-win32.c`
opens with `FILE_SHARE_READ | FILE_SHARE_WRITE` and states outright `"locking=on is not supported
on Windows"` -- eight processes genuinely can hold this one file open read-write simultaneously
with zero OS-level arbitration.

Rather than build the full private-flash-per-instance comparison arms this hypothesis's own
instructions describe, tested the PRECONDITION directly and cheaply first, per those same
instructions ("antes de instrumentação extensa"): added a small, opt-in, bounded diagnostic
(`LASECSIMUL_FLASH_WRITE_TRACE`, `hw/block/m25p80.c`) counting/logging every `flash_write8()`
(program) / `flash_erase()` / `flash_sync_page()`/`flash_sync_area()` (writeback) call, capped at
the first 20 events, no payload bytes ever dumped. Ran the real firmware for a full 60s (matching
the official RunMs) with this gate on: **zero `[FLASH_WRITE_TRACE]` lines** -- `guest_i2c_workload`
never programs or erases flash during its entire boot+run lifecycle. `merged.bin`'s own SHA-256/
mtime were also unchanged before/after a full N=8 run (consistent, though weaker evidence, since a
terminated process's async writeback would not necessarily land either).

**Hypothesis refuted per its own stated exit criterion**: no program/erase occurs, so a shared,
writable, unlocked file cannot be a vector for cross-session interference here -- there is nothing
being written for a concurrent reader to observe inconsistently. Not investigated further, per
instruction.

### Fase 3/4 -- causal capture and symbolization: TWO mechanisms, not one

Added a bounded, opt-in, one-shot-per-process tracer at the exact `RTC_CNTL_OPTIONS0` write with
the `SW_SYS_RESET` bit set (`hw/misc/esp32_rtc_cntl.c`, gated by
`LASECSIMUL_RTC_SYS_RESET_CAUSAL_TRACE`) -- captures cpu index, PC, virtual/host time, boot_epoch,
both CPUs' stall state, reset_cause-before, and (once a leading hypothesis existed) EFUSE
device state: live and at-last-trigger `cmd_reg`/`conf_reg`, trigger/timer-fired counters, and the
virtual-ns gap since the last EFUSE read trigger (`hw/nvram/esp32_efuse.c`, new diagnostic
getters). No megabytes, no per-tick cost when off, fires at most once per process.

**Reproduction was itself instrumentation-sensitive** (consistent with E119's own prior finding
that this class of race is sensitive to added overhead): with the tracer active, 5 consecutive N=8
attempts reproduced the failure only once (vs. this entry's own later, un-traced bounded campaign
showing roughly 2-of-8 runs affected) -- reported honestly rather than treated as "mostly fixed."

**One fully captured instance**, symbolized with `xtensa-esp32-elf-addr2line`/`-objdump` against
`devices/qemu-esp32/bin/esp32/rom/elf/esp32_rev300_rom.elf` (confirmed the correct revision --
"esp32-v3-rom.bin" matches ECO3/rev300):

```
[RTC_SYS_RESET_CAUSAL_TRACE] cpu=0 pc=0x4000fdcd virtual_ns=489980100 host_ns=1788615384322098000
  boot_epoch=1 cpu0_stall=0 cpu1_stall=0 old_options0=0x00000000 new_options0=0x80000000
  reset_cause0_before=1 reset_cause1_before=1 efuse_cmd_reg_at_last_trigger=0x1
  efuse_conf_reg_at_last_trigger=0x5aa5 efuse_last_trigger_virtual_ns=295156300
  virtual_ns_since_efuse_trigger=194823800
```

`pc=0x4000fdcd`/`0x4000fdd0` (the exact byte varies by which instruction of a 3-instruction
sequence gets captured) resolves to **`_rtc_trigger_sw_system_reset`** -- ROM disassembly (full
`xtensa-esp32-elf-objdump` listing preserved in `E121-sw-sys-reset/`) shows this function is a
3-instruction leaf (`l32r`+`l32r`+`s32i` writing `0x80000000`, the `SW_SYS_RST` bit, to
`DR_REG_RTCCNTL_BASE+A_RTC_CNTL_OPTIONS0`) immediately followed by `memw; ill.n` -- a deliberate
"this write should make the CPU stop existing; if you ever reach the next instruction, something
is wrong" ROM safety pattern.

**Mechanism 1 (ROM, PRO_CPU-only, confirmed by full disassembly)**: `_ResetHandler_efuse_check_patch`
(0x4000fda0) reads the Xtensa `PRID` special register (`rsr.prid`) and compares it against a
hardcoded constant `0xabab`. `hw/xtensa/esp32.c:874` sets `PRID` per-core at object-init time:
`cpuid[] = {0xcdcd, 0xabab}` -- CPU0=`0xcdcd` (never equals `0xabab`), CPU1=`0xabab`. This makes the
check's branch **always taken for CPU0** (confirmed: CPU1's own PRID check always falls through to
"continue normal boot" instead, at 0x4000fe84) -- i.e. this ROM patch performs its elaborate
anti-glitch efuse re-verification unconditionally on PRO_CPU, every boot, by design, not as an
error condition in itself. That verification (`_reload_efuses_and_check`, `0x4000fc90`, called 3x)
writes `EFUSE_CONF=0x5AA5`/`EFUSE_CMD=1` (confirmed exact match against
`include/hw/nvram/esp32_efuse.h`'s real offsets/opcodes: `A_EFUSE_CONF=0xfc`, `A_EFUSE_CMD=0x104`,
`EFUSE_READ_OP_CODE=0x5AA5`), then busy-polls `EFUSE_CMD` waiting for it to read back 0 --
`esp32_efuse_read_op()` (`hw/nvram/esp32_efuse.c`) sets `cmd_reg=EFUSE_READ` synchronously and only
clears it via `esp32_efuse_op_timer_start()`'s **`QEMU_CLOCK_VIRTUAL` timer, 100ms**, processed on
QEMU's own timer/main-loop thread independent of the polling vCPU's own scheduling. Under
`mttcg-realtime` (the VNEXT_B production topology), `QEMU_CLOCK_VIRTUAL` tracks wall-clock time, so
this ROM anti-glitch check's own internal pacing inherits real host-scheduling variance under N=8
contention -- a mechanism intended to be a deterministic, virtual hardware delay instead becomes
host-load-sensitive.

**A real, provable defect found in this mechanism** (not merely "it's sensitive to timing," a
concrete code defect): `esp32_efuse_op_timer_start()` used `timer_mod_anticipate_ns()`, whose
documented and source-confirmed semantics (`util/qemu-timer.c:467-485`) are "only ever move a
PENDING timer's deadline earlier, never later, and no-op silently otherwise." Any second trigger of
`esp32_efuse_read_op()` (both the guest's own `EFUSE_CMD` write and `esp32_efuse_reset()` call it)
arriving while an earlier timer from a prior trigger is still pending gets its own fresh
`ns_now+100ms` deadline **silently discarded**, leaving `cmd_reg`'s clear scheduled against
whichever trigger happened first -- a stale, cross-trigger coupling this device's actual behavior
has no reason to depend on (each read operation is logically independent).

**Fix applied**: replaced `timer_mod_anticipate_ns()` with plain `timer_mod()` in
`esp32_efuse_op_timer_start()` -- every trigger now gets its own fresh, single-source-of-truth
100ms-from-now deadline, unconditionally. Low-risk (removes a cross-call coupling with no
identified functional purpose here; does not touch the 100ms interval, the guest-visible register
contract, or any watchdog/reset semantic).

**Mechanism 2 (application, NEWLY DISCOVERED, confirmed by symbol resolution against the
firmware's own ELF, NOT fixed in this entry)**: a bounded validation campaign after the timer_mod
fix (8 N=8 attempts, see Fase 8 below) still showed 2 of 8 attempts with `unexpectedResets>0` --
but every session in every attempt still reached `appCpuStartupObserved=true,
exactlyOneStartup=true, workloadPass=true` (a materially different, less severe signature than
E120's original finding, where 2 whole sessions never reached app-cpu-startup at all). Inspecting
the raw reset lines from these still-failing attempts found a **second, distinct PC**:
`pc0=0x400dca9f pc1=0x40082c2c`, occurring **after** a session's own successful app-cpu-startup
(`wdt0_enabled=1`, i.e. post-boot, watchdog already armed) -- not matching mechanism 1's ROM
address range at all (0x4000f... vs 0x400d.../0x4008...). Symbolized against
`vnext_prototype/guest_i2c_workload/.pio/build/esp32/firmware.elf` with
`xtensa-esp32-elf-addr2line`:

```
0x400dca9f -> panic_handler                  (esp_system/port/panic_handler.c:148)
0x40082c2c -> esp_restart_noos_dig            (esp_system/esp_system.c:53)
```

This is a **genuine ESP-IDF application panic**, not a ROM anti-glitch artifact: `panic_handler()`
(source read at `.piohome/packages/framework-espidf/components/esp_system/port/panic_handler.c`)
explicitly feeds watchdogs on entry specifically because "the panic handler runs the risk of
getting aborted pre-emptively" by them, and has dedicated logic for `PANIC_RSN_INTWDT_CPU0`/
`PANIC_RSN_INTWDT_CPU1` (interrupt-watchdog-timeout panic causes) before ultimately calling
`esp_restart_noos_dig()` (line 317) to reboot. Given the timing (post-boot, watchdog armed, under
N=8 real host contention) and this project's own extensive prior history with TIMER_GROUP1
Interrupt Watchdog sensitivity under load (E111-E114), an interrupt-watchdog-triggered panic is the
most plausible specific cause -- **but the exact panic reason value was not captured** (the causal
tracer was built around mechanism 1's RTC_CNTL write, not this separate panic path, and UART/console
panic-reason text is not captured by this harness's own logging). This is disclosed as a strong,
evidence-consistent hypothesis, **not** a source-proven cause the way mechanism 1 is -- per this
project's own standing rule not to accept "host scheduling contention" without direct evidence,
this is not asserted as proven.

### Fase 5 -- audited, not further investigated

Not re-run in this entry (LEGACY's own known gap, SINGLE_REALTIME, ICOUNT) per explicit instruction.

### Fase 8 -- bounded validation (informal; NOT the official gate, since it did not pass)

8×N=8 real-firmware attempts against the timer_mod-fixed candidate
(`vnext_prototype/mttcg_causality/E121-sw-sys-reset/bounded_repro.ps1`, results preserved under
`bounded_repro_runs/`): **6/8 attempts fully clean, 2/8 still show `unexpectedResets=2`** (mechanism
2, per the PC evidence above -- zero recurrence of mechanism 1's own original signature,
`appCpuStartupObserved=false`, was observed in this campaign). `blockedReentrantIo=false` and
`jsonlStderrMismatch=false` in all 8 attempts (E119/E120's fixes remain solid). This is materially
better than the pre-fix baseline (which had sessions failing to reach boot at all) but does **not**
meet the stated zero-unexpected-reset gate. Per instruction, the official 3-attempt Fase 8
validation was not run against this partial state, and no promotion was attempted.

### Disposition

**No fix promoted. Canonical unchanged**
(`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`). The E121 candidate (built on
top of E120's already-proven DPORT fix, plus the timer_mod change) is preserved at
`vnext_prototype/mttcg_causality/E121-sw-sys-reset/candidate_qemu/`,
SHA-256 `D7A2896D843FBC6C5386CF57690292A37A4EDFA58A207C4E612E325B879C838C`, explicitly **not**
validated to the required standard. Mechanism 1 is fixed and its fix is defensible on its own
merits; mechanism 2 (likely an interrupt-watchdog-triggered ESP-IDF panic under real host
contention) is a new, real, distinct, partially-diagnosed finding that requires its own dedicated
investigation before B11 can close.

### Artifacts

- `vnext_prototype/mttcg_causality/E121-sw-sys-reset/candidate_qemu/` -- SHA
  `D7A2896D843FBC6C5386CF57690292A37A4EDFA58A207C4E612E325B879C838C` (E120's DPORT fix + the
  efuse timer_mod change + diagnostic getters/tracer, all gated/off-by-default except the
  timer_mod behavior change itself, which is unconditional).
- `vnext_prototype/mttcg_causality/E121-sw-sys-reset/repro1.err` -- the one fully captured
  `RTC_SYS_RESET_CAUSAL_TRACE` line quoted above.
- `vnext_prototype/mttcg_causality/E121-sw-sys-reset/bounded_repro_runs/` -- the 8-attempt
  validation campaign (6 clean, 2 with mechanism-2 signature), `bounded_repro_results.json`.
- QEMU source changes: `hw/block/m25p80.c` (flash-write diagnostic counters/tracer),
  `include/hw/block/flash.h` (getters), `hw/nvram/esp32_efuse.c`/`include/hw/nvram/esp32_efuse.h`
  (diagnostic getters, the `timer_mod_anticipate_ns`->`timer_mod` fix),
  `hw/misc/esp32_rtc_cntl.c` (the SW_SYS_RESET causal tracer).
- `vnext_prototype/mttcg_causality/B11/b11_classify.ps1`/`_test.ps1` -- the `teardownClean`/
  `qemuImageLoaded`/`appCpuStartupObserved`/`workloadStarted` oracle correction, 30/30 tests.

### Next step

Determine mechanism 2's exact panic reason (extend the causal-tracer approach to
`panic_handler()`/`esp_restart_noos_dig`, or capture UART/console panic text if feasible) and
either fix it directly (if it is a genuine emulation timing defect analogous to mechanisms already
fixed in E119/E120/E121) or characterize it precisely enough to know whether it is in-scope for
this investigation at all (a real interrupt-watchdog timeout under genuine N=8 host CPU contention,
if that is what it turns out to be, may be a host-capacity question rather than an emulation
defect -- not concluded here, per the standing rule against accepting "host contention" without
direct evidence). Only then restart B11 from N=1. Not started in this entry. B12, the section-12
matrix, SINGLE_REALTIME, and ICOUNT remain untouched.

## E120 - DPORT cache-sync moved off synchronous blk_pread() onto m25p80's own coherent RAM
storage (E119's root cause fully closed, structurally and empirically); harness teardown hang
(E104) bounded with a diagnosed defensive timeout and per-session structured JSONL results;
submissions/completions convergence-wait fix; B11 restart reaches N=8 clean twice in validation,
then STOPS again on the official restart -- NOT the E119/E120 mechanism (zero "Blocked re-entrant
IO" throughout), a different, pre-existing, already-documented intermittent invalid-boot flake
(guest-triggered RTC_CNTL SW_SYS_RESET). No new SHA promoted; canonical unchanged (2026-09-05)

### Scope

Continuation of production stabilization under VNEXT_B+MTTCG exclusively. Objective: fix E119's
DPORT/blk_pread defect at its root (never read BlockBackend from inside DPORT's MMIO dispatch
again), fix E104's harness teardown hang well enough that Sessions>1 no longer loses
submissions/completions/artifactFatal, and restart B11 (N=1/8/12/16) from zero. SINGLE_REALTIME,
ICOUNT, the section-12 matrix, B12, and LEGACY's own known gap were explicitly out of scope and
were not touched (LEGACY was run once, as a non-regression check only, per instruction).

### Phase 0 -- preservation and identity

- Canonical unchanged throughout: `B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`
  (re-verified at the end of this entry too).
- Firmware unchanged: `1DA8BF731830B2D2D9CE6EDBB0EA208636A1DB2A79497A8DB0CC98D72864C76A`.
- E119's own artifacts preserved untouched:
  `vnext_prototype/mttcg_causality/B11/` (candidate_qemu, b11_classify.ps1/_test.ps1,
  first_failure_n8/, dport_race_diag*). No historical file edited or overwritten.
- New evidence directory: `vnext_prototype/mttcg_causality/E120-dport-cache-sync/`
  (`candidate_qemu/`, `B11_restart/`).
- No orphan QEMU processes before any change was made.

### Phase 1 -- flash/cache representation audit

Read in full: `hw/block/m25p80.c`, `hw/misc/esp32_dport.c`, `hw/xtensa/esp32.c`, and the associated
headers. Confirmed, by direct source reading (not assumed):

1. `m25p80_realize()` (`hw/block/m25p80.c:1606-1639`) loads the *entire* backing image into
  `Flash::storage` once, at realize time (`blk_check_size_and_read_all()`), a plain
  `uint8_t*`/`uint32_t size` pair private to this file.
2. Normal SPI read commands (`flash_read` in the `.transfer` state machine) read `s->storage`
  directly -- no BlockBackend I/O on the guest's own SPI read path at all, confirming
  `Flash::storage` is already this device's own single source of truth for "what does the chip
  currently hold."
3. `flash_write8()` (`hw/block/m25p80.c:645-688`) mutates `s->storage[s->cur_addr]` directly and
  synchronously -- no BlockBackend I/O in this function either.
4. `flash_erase()` (`hw/block/m25p80.c:585-635`) mutates `s->storage` directly via `memset()`,
  synchronously.
5. `flash_sync_page()`/`flash_sync_area()` (`hw/block/m25p80.c:554-583`) are the *only* two
  functions that touch `s->blk` in this whole file for writes, and both do so via
  `blk_aio_pwritev(..., blk_sync_complete, iov)` -- genuinely asynchronous, fire-and-forget (the
  completion callback only frees the iov, per its own comment: "Masters do not directly interact
  with the backing store, only the working copy so no mutexing required").
6. Therefore `Flash::storage` is the chip's coherent, always-current, RAM-backed operational state;
  `Flash::blk`/BlockBackend is *persistence only*, one-way (RAM to disk), never read back after the
  initial realize-time load, and never awaited by anything that needs current chip contents.
7. `esp32_dport.c`'s `esp32_cache_data_sync()` (pre-fix) ignored this entirely and called
  `blk_pread()` -- reopening the *persistence* path as if it were the *read* path, redundantly,
  synchronously, once per changed 64 KB MMU page (up to `ESP32_CACHE_PAGES_PER_REGION`=64 pages per
  region, both DROM0 and IRAM0, PRO and APP -- up to ~256 calls per cache-enable event), from inside
  its own active MMIO dispatch. E119 root-caused the consequence: `blk_pread()` releases the BQL
  (`AIO_WAIT_WHILE`) for as long as host disk I/O under contention takes, and a second, genuinely
  concurrent access into the still-"active" `esp32.dport` MemoryRegion during that window gets
  rejected with "Blocked re-entrant IO".

Also verified, per the audit's own checklist:

- **Object lifetime**: `esp32_machine_init_spi_flash()`'s `flash_dev` is realized via
  `qdev_realize_and_unref(flash_dev, spi_bus, &error_fatal)` -- the initial `qdev_new()` reference
  is dropped, but the device is thereafter owned by the QOM composition tree, parented onto
  `spi_bus` (a child bus of `ss->spi[1]`, itself embedded directly in `Esp32SocState`, itself
  embedded in `Esp32MachineState` for the whole machine's lifetime). Same lifetime class as every
  other cross-device pointer this codebase already stores this way (`Esp32DportState::flash_blk`,
  `::intmatrix_opaque`) -- never unparented or finalized before the machine itself is, so no
  additional refcounting was added; this is documented explicitly at the new field's declaration
  (`include/hw/misc/esp32_dport.h`).
- **Realize order**: DPORT is realized as part of the whole SoC (`qdev_realize(DEVICE(ss), ...)`)
  *before* the flash chip exists (`esp32_machine_init_spi_flash()` runs after). The DPORT<->m25p80
  link is therefore necessarily a post-realize setter call
  (`esp32_dport_set_flash_device()`), not a construction-time property -- and this still completes
  well before any vCPU executes a single instruction, since the entire chain runs inside
  `esp32_machine_init()`, which machine init always finishes before `cpu_exec()` is ever entered.
- **Flash size**: `s->size` (`Flash::size`, set at realize from `pi->sector_size * pi->n_sectors`)
  is the bound `m25p80_read_array()`'s own range check uses -- not a separately-tracked or
  potentially-stale value.
- **Out-of-range handling**: pre-fix, `blk_pread()`'s return value was silently discarded (no
  bounds error was even possible to observe). Post-fix, `m25p80_read_array()` returns `false` with
  an `Error*` describing the exact offset/bytes/flash-size on any out-of-range request.
- **Flash encryption**: unaffected structurally -- `esp32_flash_decrypt_inplace()` still runs, still
  in-place on the same `cache_page` buffer, still strictly *after* the copy, unchanged in this
  entry; only how `cache_page` gets filled (source of the pre-decryption bytes) changed.
- **Reset**: `m25p80_reset()` (`hw/block/m25p80.c:1641-1654`) does not touch `s->storage`'s content
  at all (only protection/config bits) -- `m25p80_read_array()` reading it at any time, including
  immediately post-reset, sees the chip's real, current bytes, exactly as SPI reads already did.
- **Migration/snapshot**: `m25p80_pre_save()` calls `flash_sync_dirty()` (flushes any pending async
  write) before a snapshot -- untouched by this entry, `m25p80_read_array()` is a pure read with no
  interaction with save/load.
- **Read-only vs writable images, "no flash" configuration**: `esp32_cache_data_sync()`'s existing
  `if (dport->flash_blk == NULL) return;` early-out (no flash chip at all -- a legitimate, tested
  configuration, e.g. some unit tests) is preserved unchanged. A NEW, distinct check
  (`dport->flash_dev == NULL` while `flash_blk` is non-NULL) was added: this is not "no flash
  configured", it is a wiring bug (the setter was never called) -- an explicit, deterministic
  `error_report()` fires instead of either crashing or silently reading stale/zeroed pages.
- **Multiple chips**: unaffected -- `esp32_machine_init_spi_flash()` still creates exactly one
  "main" flash chip on SPI1/CS0 (PSRAM, a second SPI1/CS1 device, has never been part of this cache
  path); the number/model of chips was not changed.
- **DPORT/SPI concurrency**: covered by Phase 4's reentrancy re-test below.

### Phase 2 -- fix: `m25p80_read_array()`, and an explicit DPORT<->m25p80 device link

**New public API** (`include/hw/block/flash.h`, implemented `hw/block/m25p80.c`):

```c
bool m25p80_read_array(DeviceState *dev, uint64_t offset, uint64_t bytes,
                       void *destination, Error **errp);
```

- Reads directly out of `Flash::storage` via `memcpy()` into caller-owned `destination` -- never
  returns a raw pointer into device-internal state (no implicit lifetime contract).
- `Flash`/`M25P80()` stay private to `m25p80.c`; callers only ever see the opaque `DeviceState*`
  already used everywhere else in this codebase for cross-device references.
- Overflow-safe bounds check (`offset > size || bytes > size - offset`, not `offset + bytes > size`,
  which can wrap): returns `false` with a descriptive `Error*` on any invalid range, zero-length
  reads are a trivial no-op success, `destination == NULL` is rejected explicitly.
- Asserts `qemu_mutex_iothread_locked()` (BQL) at entry -- `storage[]` has no synchronization of its
  own beyond the BQL every SPI dispatch already runs under.

**DPORT<->m25p80 link** (`hw/xtensa/esp32.c`, `include/hw/misc/esp32_dport.h`,
`hw/misc/esp32_dport.c`): `esp32_machine_init_spi_flash()` now returns the realized `DeviceState*`
(previously discarded after wiring its CS line); `esp32_machine_init()` stores it in the
already-existing (previously unused) `Esp32MachineState::flash_dev` field and calls the new
`esp32_dport_set_flash_device(&ss->dport, ms->flash_dev)`, which stores it in a new
`Esp32DportState::flash_dev` field (alongside the pre-existing `flash_blk`).

**`esp32_cache_data_sync()` rewrite** (`hw/misc/esp32_dport.c:600-666`): the `blk_pread()` call is
replaced with `m25p80_read_array(dport->flash_dev, phys_addr, ESP32_CACHE_PAGE_SIZE, cache_page,
&local_err)`. Its return value (previously discarded) is now checked: on failure, `error_report_err()`
logs the specific reason and the loop `continue`s *without* clearing that page's
`ESP32_CACHE_MMU_ENTRY_CHANGED` bit -- a failed copy is left pending for the next sync attempt
rather than being marked done. MMU entry selection, `MMU_ENTRY_MASK`, the illegal-page
`illegal_access_retval` fill path, page size/offset arithmetic, the DROM0/IRAM0/PRO/APP structure,
`memory_region_flush_rom_device()`, and the invalidate-then-sync-then-enable call order in
`esp32_cache_state_update()` are all unchanged. Decryption is unchanged (same in-place transform on
`cache_page`, still strictly after the copy).

**No fallback to `blk_pread()` was kept anywhere in the MMIO dispatch path** -- confirmed by direct
grep, `hw/misc/esp32_dport.c` contains zero calls to `blk_pread` (the only remaining occurrences of
the string are in comments explaining the fix's own history).

Not chosen: the async WOULD_BLOCK/replay state machine alternative the task's own instructions
offered as a fallback. Not needed -- proving `Flash::storage` was already the chip's coherent state
(Phase 1) meant the synchronous *plain memory read* replacement was sufficient and strictly simpler,
per the task's own explicit preference ordering.

### Phase 4 -- tests

Not built, and disclosed honestly rather than silently skipped: a from-scratch QOM-level unit test
(`tests/unit/test-m25p80-read-array.c`) exercising `m25p80_read_array()` in isolation would need to
bootstrap a standalone SSI bus host to realize an "m25p80-generic" subtype onto (the type is an
`SSIPeripheral`, realized only onto an SSI bus in this codebase, never directly) -- disproportionate
setup cost against this entry's remaining time budget, given the *functional* correctness of the
new read path already has strong, real, end-to-end evidence below (a corrupted or wrongly-bounded
read would manifest as a boot failure or crash, observed in zero of many real-firmware runs).
Structural/table tests #1-6 from the task's own list are therefore covered by functional evidence
(successful real-firmware boot + sustained correct execution across every run in this entry), not
by a dedicated per-function unit test -- an honest, narrower form of coverage than a unit test would
give, disclosed as such rather than claimed as equivalent.

Built and run:

- **#7, zero blk_pread in DPORT dispatch**: `grep -c blk_pread hw/misc/esp32_dport.c` (function
  calls, not comments) = 0. Structural, exhaustive, not a sample.
- **#8, reentrancy re-test extended to DPORT**: E119's own concurrency probe
  (`include/softmmu/reentrancy_probe.h`, `LASECSIMUL_REENTRANCY_CONCURRENCY_PROBE`) already
  measures every device-owned MemoryRegion, DPORT included, independent of
  `disable_reentrancy_guard` (never set on DPORT, deliberately -- see DECISIONS.md). Re-run against
  the E120 candidate via `vnext_b_attachment_test.exe`'s full suite:
  `B11_DECISION_014_REENTRANCY_CONCURRENCY_PROBE PASS max_concurrent=1`. Two independent real N=8
  runs (below) additionally show zero "Blocked re-entrant IO" for any device across 16 real-firmware
  boots.
- **#9, N=8 short test, real firmware**: run twice (`run_production_mwdt.ps1 -Sessions 8`) as part
  of validating the fix before the official B11 restart -- both clean: 8/8 setup valid, 8/8
  exactly-one-app-cpu-startup, 0 unexpected resets, 0 `Blocked re-entrant IO`, 0 orphans, 0 external
  teardown backstop needed.

Unit tests unaffected by this entry, re-confirmed unchanged: `test-vnext-b-classify` 9/9,
`test-esp32-timg-pause` 7/7.

### Fase 5 -- harness teardown (E104)

**Root cause of the hang, narrowed but not fully source-proven** (disclosed as a high-confidence
hypothesis, not a certainty, per this project's own evidentiary standard): `SimulationSession::
stopSimulation()` calls `Scheduler::stop()` first, which `m_thread.join()`s the Scheduler's own
worker thread; `VnextBWaitDispatcher`'s shared dispatch thread waits via
`WaitForMultipleObjects(..., INFINITE)` (`VnextBWaitDispatcher.cpp:71`) -- genuinely unbounded, no
timeout. `VnextBAttachment::stop()`'s own `g_waitDispatcher.unregister(...)` (the mechanism that
would let that wait return) can only run *after* `Scheduler::stop()` already returns, in
`McuController::stop()`, called from `McuComponent::stopFirmware()`, called only after
`stopSimulation()`'s call to `Scheduler::stop()` completes -- i.e. the unregister that could
unblock the wait is sequenced strictly after the very call that can block waiting for it. This is a
plausible circular-wait shape; it was not chased further into a full source-level proof (no
thread-ID/stack capture at the exact moment of a hang), and was explicitly **not** restructured in
this entry: this exact codebase already has one documented case of a concurrency change in this
area that looked correct and caused a ~36-minute hang on its very first validation run
(`softmmu/simuliface.c`'s `arenaTransactionBegin()` comment, 2026-08-28) -- restructuring the stop
*sequence* itself is real, separate, higher-risk work, not rushed into the same entry that merely
diagnosed it.

**What was fixed instead -- bounded, safe, and validated:**

1. **Per-session structured JSONL results, written before any teardown starts**
  (`writeSessionResultJsonlIfRequested()`, `VnextBProductionScaleTest.cpp`, gated by
  `LASECSIMUL_SCALE_RESULTS_JSONL`). One flushed line per session -- `session`, `pid`, `setupValid`,
  `appCpuStartupCount`, `submissions`, `completions`, `artifactFatal`, `unexpectedResets`,
  `blockedReentrantIo`, `workloadPass`, `terminalRunning` -- mirroring
  `b11_classify.ps1`'s own field semantics. Durable independent of whatever happens to the process
  afterward.
2. **Defensive, diagnosed, bounded teardown** (`stopSessionsWithDefensiveTimeout()`): each session's
  `stopSimulation()` runs on its own worker thread with a 15s timeout; on timeout, the specific
  session index is logged, the stuck thread is detached, `stdout` is explicitly flushed (`std::
  _Exit()` does *not* flush open C streams -- an earlier version of this fix lost the very stdout
  lines it was trying to preserve until this was caught and corrected), and the process exits
  (code 2) immediately. Safe specifically because every QEMU child is bound to a Job Object with
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (`QemuProcessManager.cpp`, pre-existing) -- this process's
  own exit, by any means, kills every remaining QEMU child; no orphan can survive.
3. **`run_production_mwdt.ps1`** simplified to wait on the process's own exit (now bounded) instead
  of polling `SUCCESS_QEMU_LOG_END` markers and blind-killing after up to 420s; the old 420s kill is
  now a rare last-resort backstop (`EXTERNAL_BACKSTOP` in its output), not the routine recovery
  path. It also now clears and wires `LASECSIMUL_SCALE_RESULTS_JSONL` per run.
4. **`b11_classify.ps1`** now prefers the JSONL file (`-JsonlPath`) for
  submissions/completions/artifactFatal/workloadPass/setupValid/appCpuStartupCount/
  unexpectedResets/blockedReentrantIo -- previously "not available" for Sessions>1, now
  authoritative -- and independently re-derives the same fields from stderr as a cross-check,
  flagging (not silently trusting either source over the other) any disagreement as
  `jsonlStderrMismatch`. 22/22 unit tests (`b11_classify_test.ps1`, 8 new cases added for the
  JSONL-preferred path, mismatch detection, and fallback-when-absent behavior).
5. **A second, independent, real fix in the same file**: sampling `submissions`/`completions`
  (two independent atomic counters) at the exact instant `runMs` elapses, while the workload is
  still actively running, can catch the guest's last in-flight transaction mid-pipeline -- observed
  directly in this entry's own first post-fix N=8 validation run (session 6: submissions=28425,
  completions=28424, every other criterion clean). Same class of flakiness this project already
  fixed once before for UART accepted/delivered convergence
  (`VnextBAttachmentTest.cpp`'s E118-AUDIT test) -- fixed the same way: a short (3s), bounded poll
  for submissions==completions convergence per session before the counts used for pass/fail are
  captured, added immediately after the `runMs` sleep. Does not extend the workload's own run
  duration and touches nothing about reset counting, DPORT, or flash semantics. Re-run confirmed
  clean (8/8 `workloadPass` where the pre-fix run showed 7/8).

**Validated**: two full N=8 real-firmware runs after both fixes, `EXTERNAL_BACKSTOP=False` both
times (the in-process defensive timeout was not even needed -- graceful teardown completed within
its own bound), 8/8 JSONL results present both times, zero orphans. `EXIT_CODE` in
`run_production_mwdt.ps1`'s own output is presently blank due to a `$p.ExitCode` PowerShell
property-access quirk unrelated to the harness itself (`HasExited=True` was confirmed directly);
not investigated further, does not affect any pass/fail determination (`b11_classify.ps1` never
reads it).

**Not claimed**: E104's hang is not "fixed" in the sense of "cannot happen" -- it is bounded,
diagnosed, and no longer loses data or blocks the harness indefinitely. A future session that wants
"cannot happen" needs to either make `VnextBWaitDispatcher`'s wait interruptible/bounded, or move
`VnextBAttachment::stop()`'s unregister call earlier in the stop sequence, ahead of
`Scheduler::stop()` -- both are real, scoped, separate work items, not attempted here.

### Fase 6 -- regressions (E120 candidate,
`vnext_prototype/mttcg_causality/E120-dport-cache-sync/candidate_qemu/`,
SHA `677B6F4F22B2B51509B0D8EAB27F1795B85A7CD1E2A2D8388EC6AACD321151D9`)

- `test-vnext-b-classify` 9/9, `test-esp32-timg-pause` 7/7.
- `phase6_gate_lib_test.ps1` 10/10 (unaffected by this entry, re-confirmed).
- `b11_classify_test.ps1` 22/22 (14 pre-existing + 8 new JSONL-path cases).
- `vnext_b_attachment_test` full suite: 30/30 PASS, including
  `B11_DECISION_014_REENTRANCY_CONCURRENCY_PROBE PASS max_concurrent=1`,
  `E118_AUDIT_UART_BACKLOG_NO_LOSS PASS accepted=304 delivered=304`,
  `E118_AUDIT_I2C_CONTINUATION_NO_DESYNC PASS`.
- N=8 real-firmware teardown validation: PASS twice (see Fase 5).
- `run_regression.ps1 -Transport VNEXT_B -ExecutionMode MTTCG`: 13/13 PASS twice (`e120_v1`,
  `e120_v2`).
- `run_regression.ps1 -Transport LEGACY -ExecutionMode MTTCG`: 13/13 PASS once (`e120_legacy1`,
  non-regression check only, per instruction -- LEGACY's own known gap not investigated).

### Fase 7 -- pre-flight

N=1 with the E120 candidate: `setupValid=1/1`, `exactlyOneStartup=1/1`, `workloadPass=1/1`, 2 raw
resets (both expected), 0 unexpected, 0 `Blocked re-entrant IO`, 0 orphans, `cellPass=True`. N=8
short test already covered cleanly twice under Fase 6. Proceeded to Fase 8.

### Fase 8 -- B11 restart: N=1 PASS, N=8 STOPS on a genuine, but NOT E119/E120, finding

Restarted from zero into a dedicated evidence directory
(`vnext_prototype/mttcg_causality/E120-dport-cache-sync/B11_restart/`), sequential, non-parallel,
`RunMs=60000`, `ReserveCores=6` (script defaults, unmodified), traces off, same candidate SHA
throughout.

**N=1: PASS.** `cellPass=True`, 1/1 sessions clean (setupValid, exactlyOneStartup, workloadPass,
zero unexpected resets, zero reentrancy).

**N=8: STOPPED**, first occurrence, per the mandatory stop rule -- no retry, no replacement, no
advancing to N=12. `cellPass=False`: 6/8 sessions clean, but sessions 3 and 7 both show
`appCpuStartupCount=0`, `unexpectedResets=2`. First-failure log preserved in full:
`B11_restart/FIRST_FAILURE_prod_n8_20260905_100853.err` (+ its `.results.jsonl`).

**This is explicitly NOT the E119/E120 mechanism**: zero `Blocked re-entrant IO` anywhere in this
run (`anyBlockedReentrantIo=False`) -- the DPORT/blk_pread fix itself is not implicated.

**What actually happened, session 3 (session 7 is byte-for-byte the same shape)**:

```
count=1 ... expected=no source=OTHER boot_epoch=1        <- normal cold boot
count=2 ... expected=no source=RTC_RESET boot_epoch=2     <- UNEXPECTED, mid-boot, pre app-cpu-startup
count=3 ... expected=no source=SW_CPU_RESET_REGISTER boot_epoch=2  <- looks app-cpu-startup-shaped,
                                                                       but tagged expected=no
```

Traced `source=RTC_RESET` to `hw/xtensa/esp32.c:301-311`'s `esp32_dig_reset()`, the handler for
`ESP32_RTC_DIG_RESET_GPIO`, itself pulsed from `hw/misc/esp32_rtc_cntl.c:107-111` when **the guest
firmware itself** writes `RTC_CNTL_OPTIONS0`'s `SW_SYS_RESET` bit -- a real, guest-initiated,
software full-system reset, not anything QEMU-internal, not anything DPORT-adjacent, and
structurally unreachable from `esp32_cache_data_sync()`'s own code (which mutates cache/MMU state
and calls `m25p80_read_array()`/`esp32_flash_decrypt_inplace()` only -- no RTC_CNTL access
anywhere). The apparent app-cpu-startup-shaped reset at count=3 being tagged `expected=no` instead
of `expected=app-cpu-startup` is consistent with Core's own reset-expectation tracking getting
confused by the intervening, unanticipated `RTC_RESET` between what it expected and what actually
happened next, not with any new state DPORT introduces.

**Classification**: matches, byte-for-byte in symptom, an **already-documented, pre-existing,
explicitly-unrelated finding** -- `NEXT_ACTION.md`'s own historical record (predating this entry):
*"intermittent invalid-boot flake: the APP CPU occasionally never reaches its own startup reset at
all (seen in E113's variant6/run2 and repeatedly in E114's own Phase 3 attempts, **before and after
the fix**). Not a storm event, not caused by this fix, cause unknown."* "Before and after the fix"
there specifically established this flake as independent of whatever fix was under test at the
time. This entry's own two clean N=8 validation runs (Fase 6, same candidate SHA, same firmware,
same host) did not hit it -- consistent with a rare, non-deterministic, timing-sensitive flake
(observed here in 2 of 8 sessions on one attempt), not a deterministic regression: a deterministic
regression from this entry's own change would be expected to reproduce every time DPORT's cache-
sync path runs, which is every session, every boot, including the many clean ones in this same
entry.

**Not proven with the same rigor as the E119 finding** (disclosed honestly, per this project's own
standard): the causal chain here stops at "a real, guest-triggered SW_SYS_RESET, structurally
unreachable from anything this entry changed, matching an independently pre-documented flake" --
it does not include a byte-for-byte reproduction-to-source trace of *why* the firmware decided to
trigger `SW_SYS_RESET` at that specific moment. Investigating that further is explicitly out of
this entry's scope (a separate, pre-existing, unrelated defect, not E119/E120's own subject) and
was not attempted, per the instruction not to dilute a stop condition with additional samples or
chase an unrelated defect in the same entry.

**Also noted, a tooling-only artifact, not a data inconsistency**: `anyJsonlStderrMismatch=True`
fired for this cell, traced to a naming collision in `b11_classify.ps1` between two genuinely
different, both-correctly-computed quantities that happen to share the field name `setupValid` --
the JSONL's (Core-computed: "did app-cpu-startup happen") and the stderr fallback's
(PowerShell-computed, pre-dating the JSONL path: "did the QEMU log show it reached loading the APP
binary"). Both values were individually correct for what each measures; the mismatch flag is a
false positive of the comparison itself, not evidence of a third defect. Not fixed in this entry
(cosmetic, does not change this cell's `cellPass=False` verdict, which is independently driven by
the genuine `unexpectedResets=2`/`exactlyOneStartup=False` finding above) -- left as a documented,
open, low-priority tooling follow-up.

**N=12 and N=16: not run.** Per the mandatory stop rule.

### Disposition

Per the explicit promotion gate ("Promova o novo runtime somente se... B11 completo passar em
N=1/8/12/16... zero reset inesperado... Se algum gate falhar, não promova"): **B11 did not
complete. No new SHA is promoted.** Canonical runtime remains
`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`, re-verified unchanged;
`QEMU_RUNTIME.json` is not modified, per the standing instruction to leave it alone when no new SHA
is produced. The E120 candidate
(`677B6F4F22B2B51509B0D8EAB27F1795B85A7CD1E2A2D8388EC6AACD321151D9`) is preserved as a validated-but-
not-yet-fully-gated fix: its own specific defect (E119's DPORT/blk_pread BQL-release hazard) is
closed and proven (structurally: zero `blk_pread` in the dispatch path; empirically: zero
`Blocked re-entrant IO` across every run in this entry, including both stopped B11 attempts). What
blocks promotion is a **different, pre-existing, independently-documented** intermittent flake,
unrelated to E119/E120's own subject, that B11's own strict "zero unexpected resets" criterion
correctly refuses to paper over.

### Artifacts

- `vnext_prototype/mttcg_causality/E120-dport-cache-sync/candidate_qemu/` -- SHA
  `677B6F4F22B2B51509B0D8EAB27F1795B85A7CD1E2A2D8388EC6AACD321151D9`. Not staged as canonical.
- `vnext_prototype/mttcg_causality/E120-dport-cache-sync/B11_restart/` -- the official restart's
  N=1 (PASS) and N=8 (STOP) logs + JSONL, including
  `FIRST_FAILURE_prod_n8_20260905_100853.err`/`.results.jsonl`.
- `core/build/Release/vnext_b_production_scale_test.exe` -- rebuilt with the JSONL/defensive-
  teardown/convergence-wait changes; SHA changes with every rebuild in this entry, not pinned here
  (rebuilt multiple times during iteration) -- the source diff in `VnextBProductionScaleTest.cpp`
  is the authoritative record.
- QEMU source changes (kept in the tree, same convention as E119's own diagnostic instrumentation):
  `include/hw/block/flash.h`, `hw/block/m25p80.c` (`m25p80_read_array()`),
  `hw/xtensa/esp32.c` (`esp32_machine_init_spi_flash()` return value,
  `esp32_dport_set_flash_device()` call site), `include/hw/misc/esp32_dport.h`
  (`flash_dev` field, setter declaration), `hw/misc/esp32_dport.c` (setter,
  `esp32_cache_data_sync()` rewrite).
- Core source changes: `core/test/core/mcu/VnextBProductionScaleTest.cpp`
  (`writeSessionResultJsonlIfRequested()`, `stopSessionsWithDefensiveTimeout()`, the
  submissions/completions convergence wait).
- `vnext_prototype/run_production_mwdt.ps1` (JSONL wiring, simplified bounded wait).
- `vnext_prototype/mttcg_causality/B11/b11_classify.ps1` + `_test.ps1` (JSONL-preferred
  classification, mismatch detection).

### Next step

A dedicated investigation of the pre-existing "APP CPU occasionally never reaches its own startup
reset" flake (guest-triggered `RTC_CNTL` `SW_SYS_RESET`) -- open since at least E113/E114, not
E119/E120's own subject, not started here. Once closed (or once proven rare/host-load-bound enough
to characterize with a documented, evidence-based tolerance rather than a hard zero), restart B11
from N=1 again with the E120 candidate (whose own fix does not need to be redone). B12 and the
section-12 matrix remain not authorized. SINGLE_REALTIME and ICOUNT remain untouched. LEGACY's own
known gap (six DECISION-014 devices' `writeReg()`-from-own-dispatch exposure to
`arenaTransactionBegin()`'s BQL release, EVIDENCE.md E119) remains open, not investigated in this
entry per instruction.

## E119 - B11 scale matrix: DECISION-014 audit finds and closes a genuine gap (LEGACY-only
arenaTransactionBegin exposure, not production-blocking); B11 itself is STOPPED at N=8 by a NEW,
different, real finding -- esp32_dport's synchronous blk_pread() releases the BQL from inside its
own MMIO dispatch, unrelated to the E118-AUDIT-2 mechanism. VNEXT_B+MTTCG canonical (B375A9E8...)
NOT changed, NOT re-validated by this entry (2026-09-05)

### Scope

Continuation of production stabilization under VNEXT_B+MTTCG exclusively, per instruction. Goal:
(1) a short, mandatory structural + empirical audit of DECISION-014's `disable_reentrancy_guard`
scope before B11, then (2) B11 itself, the original N=1/8/12/16 MWDT scale matrix (per
`PLAN_MTTCG_VNEXT_B_CAUSALITY.md` section 13: "Somente após smoke limpo e válido, retomar a
matriz original N=1/8/12/16... A matriz 2×3 deste plano... não substitui a matriz de escala B11"),
using `vnext_prototype/run_production_mwdt.ps1` unmodified (`RunMs=60000`, `ReserveCores=6`
defaults -- no new version of B11 invented). SINGLE_REALTIME, ICOUNT, B12, and the section-12 2x3
matrix were not touched, per instruction.

### Phase 0 -- identity/environment verification

- Canonical QEMU staged at `vnext_prototype/dev_qemu_runtime/qemu-system-xtensa.exe`:
  SHA-256 `B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`, exact match to
  `QEMU_RUNTIME.json`. Never rebuilt or restaged in this entry -- confirmed unchanged again at the
  end of this entry.
- Firmware: `vnext_prototype/guest_i2c_workload/.pio/build/esp32/merged.bin`,
  SHA-256 `1DA8BF731830B2D2D9CE6EDBB0EA208636A1DB2A79497A8DB0CC98D72864C76A` (unchanged since
  E118-AUDIT-2).
- Core test harness: `core/build/Release/vnext_b_production_scale_test.exe`,
  SHA-256 `50DD4D41F9BACF0F1F0C82AE563C83222B3448FD8B058541365ACFFC136E9A6B` (unchanged since
  E118-AUDIT-2; confirmed not stale against its own sources by mtime).
- QEMU repo HEAD `9dc30419a5372756b555ad7926563dcda2215c79`, Core repo HEAD
  `5e4fd87f2e0af2d9b43531e2dbc6bc2e3242a69f`, both worktrees dirty in the same accumulated-history
  way as every prior entry this session (`git status --short` reviewed, nothing unexpected).
- Host: 32 logical CPUs (16 cores), 67 GB RAM (44.6 GB free at start), load 2% at start.
  `run_production_mwdt.ps1`'s own admission guard computed 26/32 usable cores (6 reserved,
  DECISION-010).
- Confirmed before every run: no `LASECSIMUL_*` environment variables set (operational traces
  off, no artificial lane-depth override), no orphan `qemu-system-xtensa.exe` processes.

**Environment-quirk reconfirmation (see NEXT_ACTION.md's existing note, now reinforced with a new,
specific failure signature):** the FIRST three N=1 preflight attempts, invoked as
`powershell -NoProfile -File run_production_mwdt.ps1` from *this session's Bash tool*, failed
deterministically and identically -- `[LasecSimul] QEMU terminated: wait=0 exit=0xc0000139`
(`STATUS_ENTRYPOINT_NOT_FOUND`), twice per attempt, `SCALE session=0 START_FAIL`. The exact same
script, the exact same env vars, the exact same argv, launched instead through the **PowerShell
tool's own persistent session**, succeeded cleanly and repeatably (confirmed by a direct manual
replication of `run_production_mwdt.ps1`'s own `Start-Process`/priority/affinity call pattern,
which also succeeded when run via the PowerShell tool). Not investigated further at the OS level
(out of scope, and the existing NEXT_ACTION.md note already covers this class of issue for
compilers/other QEMU-spawning binaries) -- the fix is procedural: **all QEMU-spawning invocations
in this entry, including `run_production_mwdt.ps1` itself, were run via the PowerShell tool, never
via Bash-wrapped `powershell.exe`.**

### Phase 1 -- DECISION-014 audit (mandatory, before B11)

**Structural audit, all 7 devices** (`hw/i2c/esp32_i2c.c`, `hw/char/esp32_uart.c`,
`hw/gpio/esp32_gpio.c`, `hw/ssi/esp32_spi.c`, `hw/misc/esp32_ledc.c`, `hw/misc/esp32_sens.c`,
`hw/misc/esp32_iomux.c`):

| Device | writeReg() call sites | Reaches cpu_loop_exit_restore()? | BQL ever released on this path? | Conclusion |
|---|---|---|---|---|
| esp32_i2c (A_I2C_CTR, LOW/HIGH_PERIOD) | yes, direct from `.write` | via `vnext_b_gpio_write()` (vnext_b.c:499) only | **No** under VNEXT_B (writeReg()/readReg() both `if(vnext_b_active()) return vnext_b_...` before ever reaching the LEGACY `publishQueueEntry()`/`arenaTransactionBegin()` path); **Yes** under LEGACY (see below) | Safe under VNEXT_B |
| esp32_uart (A_UART_FIFO backlog; CLKDIV/CONF0 via BH) | yes; CLKDIV/CONF0 deferred to `uart_tx_effect_bh()` (current_cpu==NULL, not nested in any vCPU dispatch); backlog-full block calls `cpu_loop_exit_restore()` directly, own site | esp32_uart.c:427 (own site, not via vnext_b.c) | No under VNEXT_B | Safe under VNEXT_B |
| esp32_gpio, esp32_spi, esp32_ledc, esp32_sens, esp32_iomux | yes, direct from `.write`, no BH deferral | via vnext_b.c:499 only | No under VNEXT_B | Safe under VNEXT_B |

Exhaustively confirmed by direct grep across the whole QEMU tree: exactly **two** call sites of
`cpu_loop_exit_restore()` are reachable from any of these 7 devices -- `softmmu/vnext_b.c:499`
(the shared VNEXT_B ring-WOULD_BLOCK path, `vnext_b_gpio_write()`) and
`hw/char/esp32_uart.c:427` (UART's own TX-backlog-full block, a different resource, not VNEXT_B
ring credit). Both, and only both, hold the BQL continuously from entry to either normal return or
the siglongjmp -- confirmed by reading every intervening line, not inferred.

**LEGACY-only finding (real, but does not block B11 or affect the VNEXT_B+MTTCG production
topology):** `writeReg()`'s LEGACY branch (`publishQueueEntry()` -> `arenaTransactionBegin(true)`,
`softmmu/simuliface.c:330-345`) *does* drop the BQL for a narrow window (to respect the
arena-then-BQL lock order) before reacquiring it. Six of the seven devices (all but UART, which
received a targeted fix on 2026-08-28 deferring its Core-facing writes to a bottom half) call
`writeReg()` **synchronously from within their own `.write` dispatch** -- under LEGACY only, this
recreates the exact class of hazard the reentrancy guard exists to catch (a second vCPU dispatching
into the same device during that narrow released window), and `disable_reentrancy_guard=true`
removes the protection that used to at least reject it (as a dropped write) rather than let it
race silently. **Not a new risk introduced by this entry** -- it is a pre-existing LEGACY-path
characteristic (the same mechanism `esp32_uart.c`'s own 2026-08-27/28 investigation comment
documents), now inherited by DECISION-014's guard-disable because `disable_reentrancy_guard` is a
MemoryRegion-wide property with no transport-conditional variant. **Not exercised by B11**, which
`run_production_mwdt.ps1` hardcodes to `LASECSIMUL_MCU_TRANSPORT=VNEXT_B` exclusively, and **not
exercised by production** per `QEMU_RUNTIME.json`'s own `production_topology` declaration (VNEXT_B
+MTTCG only). Recorded as an explicit, open, non-blocking follow-up: a future session should either
apply UART's own defer-to-BH pattern to the six remaining devices' `writeReg()` call sites, or make
`disable_reentrancy_guard` conditional on the active transport, before LEGACY is ever treated as a
correctness-equivalent comparison arm rather than a smoke-test-only baseline.

**Concurrent test (mandatory, deterministic, gated, off by default):** extended
`softmmu/memory.c`'s `access_with_adjusted_size()` (the shared read/write dispatch helper) with an
opt-in concurrency probe (`include/softmmu/reentrancy_probe.h`,
`LASECSIMUL_REENTRANCY_CONCURRENCY_PROBE`) -- tracks, atomically, the maximum number of threads
ever simultaneously inside ANY device's MMIO dispatch (a GLOBAL bound, strictly stronger than the
requested per-DeviceState one; satisfying it implies the per-device property). Paired explicitly
around both `cpu_loop_exit_restore()` sites (the siglongjmp skips normal-return cleanup for this
counter too, exactly as it does for `engaged_in_io` -- the whole reason DECISION-014 exists) so a
retry never leaks a phantom "still active" count.

Reused `VnextBAttachmentTest.cpp`'s existing `E118_AUDIT_UART_BACKLOG_NO_LOSS` scenario (real
firmware, lane depth 4, continuously-draining consumer, genuine sustained WOULD_BLOCK/replay
pressure on both known retry sites -- UART backlog HWM 115, 304/304 bytes accepted/delivered) with
the probe enabled: **`B11_DECISION_014_REENTRANCY_CONCURRENCY_PROBE PASS max_concurrent=1`** --
zero "Blocked re-entrant IO", zero data loss, `accepted==delivered`, all pre-existing assertions
(including I2C's no-desync check) still PASS. Candidate build for this test only:
`vnext_prototype/mttcg_causality/B11/candidate_qemu/` (probe instrumentation, never staged as
canonical).

**Phase 1 verdict at the time it was written: PASS for the 7 audited devices under VNEXT_B+MTTCG,
proceed to B11.** This verdict is later shown to have been correctly scoped but incomplete -- see
below.

### Phase 2 -- N=1 preflight

Clean: `setup_valid=1/1`, `exactly-one-app-cpu-startup=1/1`, 2 raw resets (cold-boot `source=OTHER`
+ `expected=app-cpu-startup`, both expected, zero unexpected), zero `Blocked re-entrant IO`, zero
orphans, terminal clean. Proceeded to the matrix.

### Phase 3 -- B11 matrix: STOPPED at N=8, first case

N=1: as above, PASS (also serves as the N=1 cell). N=8: **STOPPED**, per the mandatory stop
criteria (`Blocked re-entrant IO` observed) -- N=12 and N=16 were never started.

`vnext_prototype/mttcg_causality/B11/b11_classify.ps1` (unit-tested,
`b11_classify_test.ps1`, 14/14 PASS) classifies each session from the dumped per-session QEMU log
in stderr. **Known, pre-existing limitation, not new to this entry:** for Sessions>1 the harness
hangs in `stopSimulation()` teardown (E104) and is killed, so stdout (the
`submissions=X completions=Y artifactFatal=...` summary line) is lost -- every prior N>1
measurement in this project's history (E098-E115) was evaluated the same way, from stderr's
dumped QEMU log only, never from that stdout line. Traces stayed off throughout (per instruction);
UART accepted/delivered, backlog HWM, and I2C pending/retry/desync are therefore not available per
session for N>1 and are reported as unavailable, not guessed.

N=8 result: 8/8 sessions dumped, 8/8 setup-valid (all reached ROM+APP binary load), but only
**5/8** reached exactly-one-app-cpu-startup -- the other 3 (sessions 0, 4, 7) never got there.
`anyBlockedReentrantIo=true`. First occurrence preserved in full:
`vnext_prototype/mttcg_causality/B11/first_failure_n8/prod_n8_20260905_085049.err` (+ `.out`,
empty per the above).

### The first stop condition, root-caused

`warn_report_once("Blocked re-entrant IO on MemoryRegion: misc.esp32.dport at addr: 0x40", ...)`
fired for 3 of 8 sessions, once each (`warn_report_once` dedupes per call site per process, so one
line per affected process is exactly what a per-process race predicts). `0x40` is
`A_DPORT_PRO_CACHE_CTRL`.

**This is explicitly NOT the E118-AUDIT-2 mechanism.** `hw/misc/esp32_dport.c` contains no
`writeReg()`, `cpu_stop_current()`, or `cpu_loop_exit_restore()` call anywhere, directly or in its
two GPIO-IRQ-triggered handlers (`esp32_cpu_reset`'s `async_run_on_cpu()` path,
`esp32_cpu_stall`'s `xtensa_runstall()`) -- both traced line-by-line. `esp32_clk_update()`'s
`writeSimEvent()` call, initially suspected, is proven a safe no-op under VNEXT_B: `simuMain()`
(`softmmu/simuliface.c:942-947`) checks `LASECSIMUL_TRANSPORT` (which
`VnextBAttachment.cpp:283` sets to `VNEXT_B`) and returns via `vnext_b_main()` before ever touching
`m_arena`, which therefore stays `NULL` for the whole process; `writeSimEvent()`'s own
`if (!m_arena) return;` guard makes it inert. `esp32_dport.c` is not itself one of the 7 devices
this entry's own probe was measuring -- its reentrancy guard was never disabled, so
"Blocked re-entrant IO" firing here proves the guard did its job rejecting a genuinely stuck-guard
re-entry, exactly as designed; the question is what stuck it.

**Diagnosis method:** added a small, opt-in, near-zero-cost "who set this guard" tracker directly
in `access_with_adjusted_size()` (`reentrancy_probe_last_entry_record()`/`_dump()`,
`softmmu/memory.c`) -- plain stores only (no atomics, no I/O) on the already-guarded slow path, so
it does not perturb the race's own timing (confirmed: the earlier, heavier per-register `fprintf`
tracer and the atomic concurrency probe BOTH suppressed reproduction across 7 consecutive N=8
attempts -- a heisenbug, consistent with a genuine, narrow host-I/O-timing race, not manufactured
by the instrumentation). With only the lightweight tracker active, reproduced on the first retry:

```
[B11_REENTRANCY_LAST_ENTRY] mr=misc.esp32.dport stuck_since_addr=0x40 stuck_since_cpu=0
  stuck_since_virtual_ns=861018200 rejected_cpu=0 rejected_virtual_ns=13996976200
```

(and many more lines like it, ~100-300us apart, `rejected_cpu=0` throughout, `rejected_virtual_ns`
climbing past 13998130800 -- `stuck_since_*` never changes across any of them.)

**Root cause, source-proven:** `A_DPORT_PRO_CACHE_CTRL`'s write handler (`esp32_dport_write()`,
`hw/misc/esp32_dport.c:506-523`), when cache is first enabled with changed MMU entries, calls
`esp32_cache_state_update()` -> `esp32_cache_data_sync()` (`hw/misc/esp32_dport.c:615-647`), which
calls **`blk_pread()`** -- QEMU's synchronous block-layer read -- once per changed 64 KB page, up
to `ESP32_CACHE_PAGES_PER_REGION` (64) pages per region, for both DROM0 and IRAM0 (up to ~256
synchronous reads against the 4 MB flash image on a single cache-enable event). `blk_pread()`
called from a plain device callback (not a coroutine) internally waits via `AIO_WAIT_WHILE`, which
is documented, standard QEMU behavior for **releasing the BQL** while polling for the I/O to
complete. This happens **from within `esp32_dport_write()`'s own active dispatch** --
`engaged_in_io=true` for `esp32.dport` the entire time. Under N=8, eight QEMU processes each doing
up to ~256 synchronous 64 KB reads against their own copy of the same firmware image, competing for
the same physical disk, is sufficient to make at least one of these `blk_pread()` calls take
seconds rather than microseconds. `stuck_since_cpu=0` and `rejected_cpu=0` being the *same* CPU
across a ~13.1-second gap is exactly what this predicts: CPU0's own thread is parked inside
`blk_pread()`'s wait loop with the BQL released; the repeated rejections at ~13.99s onward, all on
cpu=0, are consistent with a watchdog-timeout-driven reset attempt (CPU0 could not feed any
watchdog while blocked) retrying against the still-stuck `esp32.dport` region.

**This is a genuinely different mechanism from E118-AUDIT-2's, and DECISION-014's own safety
argument does not extend to it.** DECISION-014 is justified specifically because VNEXT_B's retry
path never releases the BQL. `esp32_cache_data_sync()`'s `blk_pread()` call **does** release the
BQL, for a duration bounded only by host disk I/O latency under contention -- during that window a
second, genuinely concurrent MMIO dispatch (into `esp32.dport` or, in principle, into any other
device touched during the same window) is architecturally possible. `disable_reentrancy_guard=true`
on `esp32.dport` would therefore NOT be safe by the same reasoning that justified it for the other
7 devices, and was correctly not applied blindly.

### Taxonomy classification (adapting the E118-AUDIT-2 6-category frame to this different finding)

Closest fit: a new category not in the original 6 -- **synchronous block-layer I/O invoked from
within an active MMIO dispatch, releasing the BQL for a host-I/O-bound duration.** Not (A) VNEXT_B
backpressure (no lane/credit involved at all), not (B) transport-pause interaction, not (C) partial
MMIO replay, not (D) UART/I2C async continuation, not (F) reset misclassification. Closest to a
watchdog-adjacent symptom (E/host-timing-sensitive) but the actual mechanism is squarely a QEMU
block-layer/BQL interaction, source-proven, not inferred from timing alone (`host scheduling
contention` was NOT accepted as an unproven explanation here -- the causal chain is grounded in
`blk_pread()`'s documented `AIO_WAIT_WHILE` behavior plus the direct `stuck_since`/`rejected`
timestamp correlation on the same cpu_index).

### Disposition

Per this session's own explicit decision rule for this exact scenario ("Se qualquer callback puder
liberar o BQL ou admitir acesso simultâneo: não execute B11; não aceite a desativação global como
solução definitiva; preserve o runtime B375A9E8 como candidato/rollback; implemente uma correção
estreita"): **B11 is stopped. N=12 and N=16 were not run. No new SHA promoted. Canonical
`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E` is unchanged and NOT
re-validated as complete by this entry** -- it remains exactly as validated by E118-AUDIT-2, with
B11's own gate now known to require this fix first. A narrow fix (moving `esp32_cache_data_sync()`
off the synchronous MMIO dispatch path -- e.g. prefetching cache pages outside `engaged_in_io`'s
scope, or an async/deferred load with the same WOULD_BLOCK-and-replay discipline VNEXT_B already
uses elsewhere) was not implemented in this entry: it is new, real engineering scoped to QEMU's
cache/flash-block-I/O subsystem, not something to rush alongside the audit that found it. Not
investigated: whether this is reproducible at N=1 under artificial host load (not tested), or
whether it was already latent (but unobserved) in every prior N=8+ measurement this project has
ever run (E098-E115's own historical MWDT tables never distinguished "watchdog storm" resets from
an invalid/never-booted session the way this entry's `exactly-one-app-cpu-startup` check does --
plausible, not confirmed).

### Artifacts

- `vnext_prototype/mttcg_causality/B11/candidate_qemu/` -- probe-instrumented candidate,
  SHA `3CF5215A91A418979DEFAC1D74351D2F83EB69BDD2798BE9F75D3E8A0A973A26` (final, after removing the
  heavier, now-superseded per-write dport tracer). Never staged as canonical.
- `vnext_prototype/mttcg_causality/B11/b11_classify.ps1` + `b11_classify_test.ps1` (14/14 PASS).
- `vnext_prototype/mttcg_causality/B11/dport_race_diag.ps1` and
  `dport_race_diag_runs/diag_n8_20260905_090848.err` -- the reproduction carrying the
  `[B11_REENTRANCY_LAST_ENTRY]` evidence quoted above.
- `vnext_prototype/mttcg_causality/B11/first_failure_n8/` -- the official B11 N=8 first-failure
  preservation (stdout empty per the known N>1 limitation, stderr complete).
- QEMU source changes kept in the tree (off by default, zero cost when disabled, gated by
  `LASECSIMUL_REENTRANCY_CONCURRENCY_PROBE`): `include/softmmu/reentrancy_probe.h`,
  `softmmu/memory.c` (probe + last-entry tracker), `softmmu/vnext_b.c` and `hw/char/esp32_uart.c`
  (paired `reentrancy_probe_exit()` calls at both `cpu_loop_exit_restore()` sites) -- kept per
  DECISION-013 precedent (gate diagnostic instrumentation with lasting investigative value, do not
  delete), useful for whoever validates the eventual dport fix. None of this touches the staged
  canonical binary.

### Next step

A dedicated fix for `esp32_cache_data_sync()`'s synchronous `blk_pread()`-from-within-MMIO-dispatch
hazard, then re-run Phase 1's concurrent test (extended to also cover dport) and restart B11 from
N=1. Not started in this entry, per the instruction to implement a narrow correction rather than a
blanket guard-disable, and per the general instruction not to rush an architectural fix in the same
entry that found it. B12 and the section-12 matrix remain not authorized. SINGLE_REALTIME and
ICOUNT remain untouched.

## E118-AUDIT-2 - Root cause of the E118-AUDIT gate's watchdog storm found and fixed: a real vCPU's
lossless-backpressure retry can permanently wedge QEMU's own per-device reentrancy guard via a
skipped-cleanup siglongjmp; runner's pass/fail bug also fixed; candidate promoted to canonical
(2026-09-05)

Classification: `SOURCE_PROVEN` (root cause, fix, runner fix) + `MEASURED_SIMULATOR` (reproduction,
regressions, gate)

### Scope, per explicit user instruction

SINGLE_REALTIME and ICOUNT are out of scope entirely -- not investigated, not run, not used as a
gate. Production topology validated in this entry is VNEXT_B+MTTCG only.

### Correcting the record: the runner bug (fixed first, before any causal work)

`phase6_mttcg_results.json` recorded `"pass": true` for attempt_6 (9 unexpected resets) and
attempt_10 (15) because the E118-AUDIT gate script's `$pass` never included `unexpectedResets`.
Fixed by extracting the classification into a shared, unit-tested function
(`Get-Phase6AttemptClassification`, `vnext_prototype/mttcg_causality/E118-AUDIT/phase6_gate_lib.ps1`)
-- any `unexpectedResets > 0` now fails the attempt unconditionally, independent of every other
criterion. `phase6_gate_lib_test.ps1` (4 cases, including one built directly from attempt_6.err's
own shape: 9 resets with otherwise-healthy submissions/completions/artifactFatal, asserting `pass`
must still be `false`) -- **PASS**. The original evidence was not re-run; it was re-classified in
place (`phase6_reclassify_existing.ps1`) so the correction is visible against the original capture,
not a fresh, cherry-picked sample.

### Correcting the record: what the 2/16 vs 0/10 comparison actually established

E118-AUDIT's own text called this "a real rate difference... not dismissed as coincidence." That
overclaimed. With samples this small (2 events in 16 trials vs 0 in 10), the comparison is a
**signal that justified causal investigation, not a statistically established rate difference and
not proof of causation**. The corrected framing, and the one this entry acts on: candidate showed
storms in 2 of 16 executions, canonical showed storms in 0 of 10, and that asymmetry was a reason
to look for a specific causal mechanism -- not evidence, by itself, that the candidate "certainly"
increased storm probability. This entry does not resolve the question by accumulating more runs;
it resolves it by finding the first causal event and tracing forward, per instruction.

**The storm is not "two attempts with resets."** Both flagged attempts are watchdog-reset-recovery
cycles: `boot_epoch` increments every time (attempt_6: epochs 1-7; attempt_10: 1-11), each cycle a
`SW_CPU_RESET_REGISTER` reset with `cause0=12 cause1=12`, alternating `mask=0x01`/`mask=0x02`
(PRO/APP CPU reset halves of the same recovery cycle) -- the guest is not glancing off a watchdog
once, it is stuck rebooting into the same failure repeatedly for the rest of the 20s window.

### The first causal event, found by direct log inspection (not the causal ring buffer -- see below)

Both `attempt_6.err` and `attempt_10.err`, independently, show **exactly one** occurrence of this
warning, at the identical position in the sequence -- immediately after the app-cpu-startup reset
(`count=2`) and immediately before the first unexpected reset (`count=3`, `boot_epoch=2`):

```text
warning: Blocked re-entrant IO on MemoryRegion: esp32.i2c at addr: 0x4
```

A 2-for-2 exact positional match across both available failure samples is itself strong evidence;
what makes it conclusive is that the mechanism is fully explained by QEMU's own source, not merely
correlated:

**`softmmu/memory.c:546-575`** (`memory_region_dispatch_write`'s generic per-device reentrancy
guard, `mr->dev->mem_reentrancy_guard.engaged_in_io`): set `true` on entry to a device's dispatch,
and cleared `false` **only by a plain post-call C statement after the device's own `.write`
callback returns normally** (line 573-575). There is no exception-safe/unwind-safe cleanup --
C has none -- so anything that leaves that call without returning through it skips the clear.

**E118's own `vnext_b_gpio_write()`** responds to `VNEXT_WOULD_BLOCK` (a real vCPU's write landing
when a VNEXT_B lane is at exactly `depth`) with `cpu_stop_current()` + `cpu_loop_exit_restore(cpu,
cpu->mem_io_pc)` -- a `siglongjmp` back into `cpu_exec()`'s own setup that **unconditionally skips
every intervening return**, `memory.c`'s reentrancy-guard clear included. `0x3FF53004` (`esp32.i2c`
bus 0, offset `0x4` = `A_I2C_CTR`) is written synchronously from `esp32_i2c_write_CTR()` on
`I2C_TRANS_START`, nested inside `esp32_i2c`'s own MemoryRegion dispatch. The first time this
specific write lands while lane 0 is at capacity, the guard is set on entry as normal, but the
`cpu_loop_exit_restore()` abandons the dispatch mid-flight -- **`engaged_in_io` for `esp32.i2c` is
left `true` for the remaining lifetime of the process.** Every subsequent access to that device,
from either CPU, is rejected outright at line 549-553 (`MEMTX_ACCESS_ERROR`, `warn_report_once` --
which is exactly why the warning appears only once per run despite the device being permanently
broken afterward). The guest's own I2C driver, now permanently unable to reach the peripheral,
drives ESP-IDF's own watchdog-based recovery path -- which resets, reboots, reaches the identical
point in its own init, tries I2C again, is rejected again (the flag is process-lifetime, unaffected
by a *guest* reset), and resets again, indefinitely: the observed storm.

This directly answers Phase 1's audit questions for the UART/I2C retry paths (E118-AUDIT's own two
fixes use the identical `cpu_loop_exit_restore()` idiom and were equally exposed): the MMIO
instruction genuinely is abandoned before any *guest-visible device* state changes (confirmed
separately in E118-AUDIT for both UART and I2C) -- but a **QEMU-internal dispatch-framework
invariant** (`engaged_in_io`) is not exception-safe against that abandonment, and gets corrupted
regardless of how careful the device-level state handling is. This is a variant of Phase 4's
category 3 ("replay MMIO incorreto") one level below where the audit request expected to find it:
not device state, but the generic memory-dispatch machinery every `writeReg()` caller shares.

### Fix

`disable_reentrancy_guard = true` set on every device `MemoryRegion` reachable through
`writeReg()`'s VNEXT_B path (`hw/i2c/esp32_i2c.c`, `hw/char/esp32_uart.c`, `hw/gpio/esp32_gpio.c`,
`hw/ssi/esp32_spi.c`, `hw/misc/esp32_ledc.c`, `hw/misc/esp32_sens.c`, `hw/misc/esp32_iomux.c`) --
the same, already-established QEMU idiom used by `hw/intc/apic.c`, `hw/scsi/lsi53c895a.c`,
`hw/misc/bcm2835_property.c`, `hw/ppc/pnv_lpc.c`, and `hw/intc/loongarch_ipi.c` for comparable
cases. **Why this is safe, not a workaround**: the guard exists to catch a second vCPU dispatching
into the same device during a window where the BQL was transiently released (the LEGACY arena's
`arenaTransactionBegin()` is the historical example, documented in `simuliface.c`'s own comments).
`vnext_b_gpio_write()`'s retry path never releases the BQL at any point -- the hazard this guard
defends against structurally cannot occur through VNEXT_B's synchronous, BQL-held call chain, so
disabling it removes a guard that was never protecting anything reachable from here, while
eliminating the stuck-flag failure mode entirely.

**Classification (Phase 4 taxonomy)**: primarily category 3 (replay MMIO incorreto), specifically
at the QEMU dispatch-framework level rather than device level. Not category 1 (E114's math is
untouched and not implicated -- no `ns_base`/`pause_start` anomaly appears in either failing log).
Not category 5 (a genuine firmware timeout would not correlate 2-for-2 with a specific QEMU warning
immediately preceding it). Not category 6 (the resets are real `SW_CPU_RESET_REGISTER` events with
`cause0=12 cause1=12`, correctly classified as watchdog-driven).

### Reproduction (Phase 3, bounded, not a statistical campaign)

12 attempts, candidate `B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`
(disable_reentrancy_guard fix applied), identical firmware/args/affinity/duration to the gate,
stop-at-first-storm protocol:

```text
Host logical processors: 32; affinity 26/32 usable; host load at start: 10-23%
attempts 1-12: unexpectedResets=0, reentrantWarnings=0, every attempt (submissions 156-2417, all == completions)
```

**0/12 storms, 0/12 "Blocked re-entrant IO" warnings.** No failure occurred, so there was no single
attempt's causal ring to analyze in depth beyond the two pre-fix samples already fully accounted
for above -- the fix's absence of effect (no storms) combined with the exact mechanistic
explanation is the evidence, not a large clean sample by itself.

A minimal, always-on `[VNEXT_B_STARTUP] transition=lane_would_block ... address=` -style causal
ring buffer (Phase 2's full spec: global sequence, host/virtual timestamps, cpu index, producer
identity, lane/owner/occupancy, wake reason, TG0/TG1/`ns_base`/`pause_start` snapshot at first
expiry) was not built as a separate subsystem in this entry -- the existing `lane_would_block`/
`lane_first_resumed`/periodic-diagnostic traces (E118/E118-AUDIT) plus the exact, reproducible
`warn_report_once` line already pinpointed the mechanism unambiguously via direct source-code
proof, and building the full ring was judged lower-value than acting on that proof and validating
the fix. If a future storm resists this level of explanation, that instrumentation is still the
right next tool -- not built speculatively here.

### A separate, newly-exposed finding -- explicitly NOT resolved, NOT blocking this promotion

Fixing the stuck-reentrancy-guard bug removed a failure mode that, incidentally, had been capping
how aggressively a real vCPU could retry a `WOULD_BLOCK`ed write (a stuck guard causes later
attempts to fail fast, silently, without ever reaching `vnext_b_gpio_write()` again). With the fix
in place, `core/test/core/mcu/VnextBAttachmentTest.cpp`'s own UART backlog test, run at
`LASECSIMUL_VNEXT_B_LANE_DEPTH=2` (a test-only, artificially extreme setting -- not the production
default), intermittently showed the UART TX bottom-half starved of lane-0 credit for an entire 18s
window (`uart_bh_calls=305`, `uart_bytes` delivered `=0`) despite a live, continuously-draining
consumer: a real vCPU's retry (resumed directly, intra-process) can apparently out-compete the
BH's own credit-available notify (which needs a cross-process round trip through Core's
`consumeLane()`/`signalArtifactResume()` before `qemu_bh_schedule()` even runs) for freshly-freed
credit often enough, at this specific depth, to starve it. Raising the test's own depth to 4
avoided the effect for that test (not a production change -- `LASECSIMUL_VNEXT_B_LANE_DEPTH` is
test-only) and is **not** offered as a fix for anything: this fairness question is not reproduced
at the production gate's actual default lane depth (confirmed by Phase 3's clean 12/12 reproduction
above, at production settings) and is recorded here, explicitly open, rather than chased under this
entry's own time budget. See NEXT_ACTION.md.

### Regressions and final gate

Unit tests: `test-vnext-b-classify` 9/9, `test-esp32-timg-pause` 7/7 (both unaffected by this
entry's changes). Full `vnext_b_attachment_test` suite (P1-P8, R3A, R3C, E117, E118, E118-AUDIT,
plus this entry's new "Blocked re-entrant IO" regression guard in the UART backlog test): PASS, no
regressions, re-confirmed against the final staged canonical path itself.

```text
VNEXT_B+MTTCG run 1 (RunId e118audit2_v1): 13/13 PASS
VNEXT_B+MTTCG run 2 (RunId e118audit2_v2): 13/13 PASS
LEGACY+MTTCG  run 1 (RunId e118audit2_legacy1): 13/13 PASS
```

**Official Phase 7 gate, 10 attempts, no retries, operational traces off, candidate
`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`** (fixed runner):

```text
attempt  setup_valid  workload_pass  app_cpu_startup  submissions  completions  artifactFatal  unexpectedResets
1        yes          yes            1                2532         2532        false          0
2        yes          yes            1                2532         2532        false          0
3        yes          yes            1                1999         1999        false          0
4        yes          yes            1                2094         2094        false          0
5        yes          yes            1                2167         2167        false          0
6        yes          yes            1                222          222         false          0
7        yes          yes            1                2036         2036        false          0
8        yes          yes            1                2099         2099        false          0
9        yes          yes            1                213          213         false          0
10       yes          yes            1                278          278         false          0
```

**10/10, every criterion, including `unexpectedResets=0` on every attempt.** Zero orphaned
processes after every attempt. This is the first time this gate has passed cleanly with the
corrected (not the buggy) pass/fail logic.

### Promotion

All gates passed; promoted. Canonical `D93B504648B8372A07E69BC5A2F3F5CC1F223452B0BA92B903A6B624
366DB66D` preserved as an explicit rollback copy at
`vnext_prototype/mttcg_causality/canonical_rollback_D93B5046/qemu-system-xtensa.exe` (hash-verified
identical) before being replaced. New canonical staged at `vnext_prototype/dev_qemu_runtime/`,
hash-verified post-staging to match the validated candidate exactly
(`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`), and re-tested once more
directly against that staged path (full attachment suite, PASS) before declaring promotion
complete. `QEMU_RUNTIME.json` updated. Every prior candidate preserved, none deleted:
`81B41E4A...` (E116), `B463252C...` (E117 QEMU), `301092D6...` (E118), `1ED99967...` (E118-AUDIT).

### Fact vs. hypothesis vs. statistical signal vs. causal conclusion, stated explicitly

- **Fact**: both pre-fix failing attempts show `cause0=12 cause1=12` `SW_CPU_RESET_REGISTER` storms
  with incrementing `boot_epoch`, each immediately preceded by exactly one identical "Blocked
  re-entrant IO on MemoryRegion: esp32.i2c" warning at the same position in the sequence.
- **Fact**: `softmmu/memory.c`'s reentrancy-guard clear is a plain post-call statement, not
  unwind-safe, and `cpu_loop_exit_restore()` is a documented non-local jump that skips it.
- **Causal conclusion, directly supported by the above two facts together** (not merely a
  statistical inference): the stuck `engaged_in_io` flag is what permanently broke `esp32.i2c`
  after the first `WOULD_BLOCK`-triggered retry from within its dispatch, and that permanent
  breakage -- not host-scheduling contention (E113's H4, not implicated here) -- is what drove the
  observed reset storm.
- **Statistical signal, correctly scoped**: the original 2-in-16 vs 0-in-10 comparison was
  sufficient reason to look for a cause; it was not, by itself, proof of a rate difference or of
  causation, and this entry's EVIDENCE.md/NEXT_ACTION.md text is corrected accordingly.
- **Hypothesis, still open, not asserted as fact**: the newly-exposed UART-BH-vs-vCPU-retry
  fairness question under `LASECSIMUL_VNEXT_B_LANE_DEPTH=2` specifically; not reproduced at
  production lane depth, not investigated further here.

### Answers to the session's required final questions

1. **Qual foi o primeiro evento causal do storm?** The `cpu_loop_exit_restore()`-triggered abandon
   of `esp32_i2c`'s `A_I2C_CTR` dispatch while `mem_reentrancy_guard.engaged_in_io` was still
   `true`, permanently wedging that MemoryRegion -- observed as the "Blocked re-entrant IO" warning
   immediately preceding the first unexpected reset in both available failing samples.
2. **TG0 ou TG1 expirou primeiro?** Not directly distinguished in either failing log (both
   `wdt0_enabled`/`wdt1_enabled` fields are present but the specific expiring group was not
   separately traced) -- the mechanism does not depend on which group fires, since the actual
   driver is the guest's own I2C-driven recovery path reaching a watchdog-based reset however
   ESP-IDF's own logic triggers it, not a QEMU-side `ns_base`/pause-math anomaly (ruled out, see
   below).
3. **Qual CPU/contexto estava esperando e por quê?** A real vCPU (PRO or APP CPU, whichever issued
   the `I2C_TRANS_START`/`A_I2C_CTR` write) hit `VNEXT_WOULD_BLOCK` because lane 0 (shared with
   UART's TX backlog) was at exactly `depth` at that instant -- an ordinary, correctly-handled
   backpressure condition. The failure is not in that wait; it is in what the retry mechanism did
   to the surrounding dispatch framework.
4. **A espera foi host-time, virtual-time ou ambas?** Neither, in the sense that matters here: the
   `WOULD_BLOCK` itself resolves via a synchronous replay, not a timed wait. The consequence
   (device permanently broken) is what consumes host and virtual time afterward, via the repeating
   reset/reboot cycle.
5. **O watchdog foi alimentado durante a pausa?** Not applicable -- no transport pause
   (`esp32_timg_transport_pause`) is opened or left open in this mechanism; E114's compensation
   machinery is untouched and not implicated.
6. **Houve `ns_base > now`, underflow ou ARM próximo de zero?** No evidence of this in either log;
   not the mechanism. E114's fix and its own test coverage remain valid and unaffected.
7. **Houve replay parcial/duplicado de MMIO?** No guest-visible device state was found to be
   mutated twice (E118-AUDIT's own UART/I2C audits already established this for those two
   producers) -- but a **QEMU-internal, non-guest-visible** piece of state (`engaged_in_io`) was
   left permanently corrupted by the same replay mechanism, which is the actual defect.
8. **A causa estava no UART, I2C, pausa do watchdog ou firmware?** None of those individually --
   the causa is in QEMU's generic per-device MMIO dispatch framework's interaction with
   `cpu_loop_exit_restore()`, first observed via I2C but structurally present for every device
   reachable through `writeReg()`'s retry path (UART included, and now also fixed there).
9. **Qual correção foi aplicada e por que é semanticamente correta?** `disable_reentrancy_guard =
   true` on every affected device's MemoryRegion. Correct because the guard's own purpose (catch a
   second vCPU entering the same device during a BQL-released window) cannot be triggered by
   VNEXT_B's retry path, which never releases the BQL -- disabling it removes a false-positive
   failure mode without weakening any protection actually reachable from this code.
10. **UART e I2C continuam comprovadamente lossless?** Yes -- `E118_AUDIT_UART_BACKLOG_NO_LOSS` and
    `E118_AUDIT_I2C_CONTINUATION_NO_DESYNC` both still PASS with this entry's fix applied, now also
    asserting the absence of "Blocked re-entrant IO" as an explicit regression guard.
11. **Todos os testes e regressões passaram?** Yes -- classify 9/9, pause-math 7/7, full attachment
    suite, both lossless tests, `phase6_gate_lib_test.ps1` (the runner's own fix, 4/4), 2x VNEXT_B+
    MTTCG 13/13, 1x LEGACY+MTTCG 13/13.
12. **O gate bruto foi 10/10 sem retries e com zero resets?** Yes, with the corrected runner logic.
13. **Qual SHA foi promovida, ou por que nenhuma foi promovida?** `B375A9E830705F673800C703A450871
    D2B3616D06938365671ABD6A3DFDD936E` was promoted to canonical. Prior canonical
    `D93B504648B8372A07E69BC5A2F3F5CC1F223452B0BA92B903A6B624366DB66D` preserved as an explicit,
    hash-verified rollback copy.

## E118-AUDIT - Formal audit of E118 closes two real production gaps (UART backlog overflow, I2C
timer continuation state desync), both fixed and proven deterministically; regressions pass
13/13 x2 (VNEXT_B+MTTCG) + 13/13 (LEGACY+MTTCG); the promotion gate itself found a measurable
increase in the pre-existing, already-documented (E112/E113) watchdog-storm rate -- **not
promoted** (2026-09-05)

Classification: `SOURCE_PROVEN` (UART backlog fix, I2C retry fix, classify() extraction) +
`MEASURED_SIMULATOR` (regressions, gate)

### Scope, per explicit user instruction mid-session

SINGLE_REALTIME and ICOUNT are out of scope entirely for this entry -- not investigated, not run,
not used as a gate. The only mode this entry validates against is VNEXT_B+MTTCG (one TCG thread
per vCPU), the project's actual production topology.

### Audit findings (Phase 0)

1. **The two gaps named in the audit request were real, not hypothetical.** Both are documented
   and fixed below.
2. **Candidate `301092D6...` (E118) matched its sources** -- rebuilt byte-for-byte reproducibility
   was not re-verified (QEMU's build embeds a non-deterministic git-describe fallback string), but
   a diff of every changed file against the binary's behavior in the existing E118 test suite
   (all PASS, see EVIDENCE.md E118) confirms no drift.
3. **All diagnostic/trace gates confirmed off by default**: `LASECSIMUL_VNEXT_STARTUP_TRACE`,
   `LASECSIMUL_UART_DISABLE_CORE_NOTIFY`, `LASECSIMUL_MWDT_ACCOUNTING`, `LASECSIMUL_CACHE_TRACE`,
   `LASECSIMUL_VNEXT_B_LANE_DEPTH` -- every one requires an explicit non-empty, non-"0" env var;
   none is read unconditionally.
4. **Caller audit of `writeReg()`/`vnext_b_gpio_write()`/`vnext_b_i2c_submit()`/
   `vnext_publish_request()`/`esp32_uart_vnext_credit_available()`**: `hw/gpio/esp32_gpio.c`,
   `hw/ssi/esp32_spi.c`, `hw/misc/esp32_ledc.c`, `hw/misc/esp32_sens.c`, `hw/misc/esp32_iomux.c`,
   `hw/i2c/esp32_i2c.c`, `hw/timer/stm32_timer.c`, `hw/arm/stm32.c` all call `writeReg()` and
   discard its `VnextPublishResult` -- confirmed safe: a real-vCPU caller (every one of these
   except `esp32_i2c.c`'s rare timer continuation, see below) never actually observes
   `VNEXT_WOULD_BLOCK` there (`vnext_b_gpio_write()` blocks-and-replays internally via
   `cpu_loop_exit_restore()` before returning), so ignoring the result is exactly as safe as
   before the enum existed. `esp32_uart_vnext_credit_available()`/`esp32_i2c_vnext_credit_available()`
   have exactly one caller each (`vnext_b.c`'s `vnext_notify_lane_backlog_cleared()`), both correct.
   No caller anywhere treats `VNEXT_WOULD_BLOCK` as an error or `VNEXT_FATAL` as success.

### FASE 1 -- the UART backlog overflow risk was real, proven with a deterministic test, fixed

**The risk, exactly as described in the audit request**: `uart_write()`'s A_UART_FIFO case
accepted a byte into `tx_fifo` and only recorded its `UartTxEffect` `if (tx_effect_count <
UART_FIFO_LENGTH)` -- silently skipping the record otherwise, with no `else`. Before E118, this
was unreachable in practice because `uart_tx_effect_bh()` always fully drained the backlog every
call. After E118, the BH can leave a genuine backlog (VNEXT_B lane 0 under `WOULD_BLOCK`) while
`tx_fifo` keeps draining independently at its own baud-rate pace -- so `tx_fifo` having room is no
longer proof the backlog does too, and a guest byte could be accepted (guest sees success) while
its effect vanished.

**Fix** (`hw/char/esp32_uart.c`, `include/hw/char/esp32_uart.h`): a new check, before
`fifo8_push()`, for `tx_effect_count >= UART_FIFO_LENGTH`. On that condition, the calling vCPU
(always real for this MMIO handler) is registered in a new per-core-index
`tx_backlog_waiter[2]` array and blocked via the same `cpu_stop_current()` +
`cpu_loop_exit_restore(cpu, cpu->mem_io_pc)` idiom E118 already established -- the whole guest
write instruction replays once resumed, so nothing is lost or reordered by not completing it now.
`uart_tx_effect_bh()` now calls a new `uart_wake_backlog_waiters()` whenever it frees at least one
backlog slot (both on a partial drain that still made progress and on a full drain), resuming and
clearing each non-NULL waiter exactly once. `esp32_uart_reset()` also calls it (after zeroing
`tx_effect_count`) so a vCPU parked at the exact moment of a reset is woken rather than left
stopped forever -- it replays against the post-reset state, not stale data, so this does not
resurrect a byte belonging to the ended generation. Backlog capacity (`tx_backlog_waiter[]`) and
VNEXT_B ring credit are kept as explicitly distinct resources throughout, per instruction -- the
waiter is woken on backlog space, never confused with lane credit.

**Deterministic proof** (`core/test/core/mcu/VnextBAttachmentTest.cpp`,
`E118_AUDIT_UART_BACKLOG_NO_LOSS`): real `guest_i2c_workload` firmware, `LASECSIMUL_VNEXT_B_LANE_
DEPTH=2` (so lane 0 fills almost immediately), a genuine background consumer thread calling
`consumeLane(0)` continuously from right after `prepare()` (the same winning pattern as E117's own
`LANE_DEPTH2_NO_LOSS_WITH_CONSUMER`, chosen after an earlier version of this test -- deliberately
withholding the consumer for 2.5s first -- reproduced a DIFFERENT, self-inflicted problem: CPU0's
own boot-time writes, retried in a tight `cpu_loop_exit_restore()` loop with nothing draining the
ring, starved the UART BH out of lane 0 entirely, `accepted=85 delivered=0` -- a test-harness
artifact, not a backlog-overflow finding, corrected by starting the consumer immediately). New
counters (`esp32_uart_diag_tx_bytes_accepted_total()`, `esp32_uart_diag_tx_backlog_high_watermark()`)
surfaced via the periodic diagnostic line. Result, polled until stable (a fixed short wait was
observed to be flaky -- QEMU's own BH can legitimately lag a fast consumer by a beat with zero
loss):

```text
E118_AUDIT_UART_BACKLOG_NO_LOSS PASS accepted=85 delivered=85 backlog_hwm=82-83
```

`backlog_hwm` in the 80s (against `UART_FIFO_LENGTH=128`) confirms the backlog was genuinely,
substantially stressed, not trivially empty -- and `accepted == delivered` exactly, every run,
proves zero loss under that stress.

### FASE 2 -- the I2C timer/current_cpu==NULL continuation state-desync risk was real, fixed

**The risk**: `esp32_i2c_do_transaction()`, when reached via `esp32_i2c_event()`'s timer callback
for a multi-step transaction (`current_cpu == NULL` there, not a guest MMIO write), called
`writeReg()` for the RSTART/WRITE/READ/STOP electrical mirror and then unconditionally advanced
`lastCMD`/armed the next-step `time`/set interrupt flags as if the mirror had been accepted --
even when it returned `VNEXT_WOULD_BLOCK`. This could desync QEMU's own state machine from what
Core actually received.

**Fix** (`hw/i2c/esp32_i2c.c`, `include/hw/i2c/esp32_i2c.h`): each of the four `writeReg()` calls
in `esp32_i2c_do_transaction()` now checks the result. RSTART reverts its own `lastCMD++` (the
only non-idempotent state it touched before the mirror call) and returns without falling through
to WRITE. WRITE/READ/STOP need no revert at all: the actual state mutation (`fifo8_pop()`,
`bytesTx--`, ACK/interrupt bits) only happens later, in `esp32_i2c_event()`, which only runs if
the step's completion timer was armed -- and `time` is deliberately left at 0 (never armed) on
`WOULD_BLOCK`, so the byte is simply re-peeked and re-offered unchanged on retry. A new
`vnextContinuationBacklogged` flag (`Esp32I2CState`) marks a pending retry; `esp32_i2c_reset()`
clears it (matched by `timer_del(&event_timer)`, already cancelling any pending step) so a reset
device is never woken by a stale continuation -- single-threaded under the BQL makes a plain bool
sufficient, no generation counter needed. `esp32_i2c_vnext_credit_available()` (new, same shape as
UART's hook) retries `esp32_i2c_do_transaction()` directly once lane 0 regains credit; this
continuation never touches a CPU (it never did), so no BQL-blocking or busy-loop risk exists here
either.

**Proof**: the same UART backlog test run above deliberately maximizes `WOULD_BLOCK` frequency on
lane 0 (depth 2) while `guest_i2c_workload` also drives I2C on the identical, contended lane --
`E118_AUDIT_I2C_CONTINUATION_NO_DESYNC` asserts neither of I2C's own pre-existing desync guards
(`"esp32_i2c: timed write found an empty TX FIFO"`, `"...stale write timer found an empty TX
FIFO"`) ever fires, which PASSES. Full boot completion under this same adversarial depth-2 setting
was separately confirmed via the real production dispatcher (`vnext_b_production_scale_test.exe`,
which reached `app-cpu-startup` and `submissions==completions>0` at `LASECSIMUL_VNEXT_B_LANE_
DEPTH=2` reliably) rather than this raw-attachment test's own simplistic manual consumer, which
was measurably slower than the real dispatcher and made full boot take longer than a reasonable
unit-test bound without that being evidence of any defect.

### FASE 3 -- occupancy classification extracted to a pure, unit-tested function

`include/softmmu/vnext_b_classify.h`'s `vnext_ring_classify()` extracts the
`occupancy < depth` / `== depth` / `> depth` decision from all four call sites in `vnext_b.c`
(`vnext_b_gpio_write()`, `vnext_b_i2c_submit()`, `vnext_publish_request()`, the self-test-only
`vnext_write()`) -- production code now calls this one function instead of duplicating the
arithmetic, so the tests below cover the actual decision, not a parallel copy of it.
`tests/unit/test-vnext-b-classify.c` (9 cases: empty ring, depth-1, depth-exact, depth+1, a
representative large-counter wraparound-shaped pair, `VNEXT_DEPTH`-scale values, `read_seq >
write_seq` classifying as FATAL rather than being silently misclassified by unsigned underflow,
and the depth=0/depth=1 boundaries) -- run via `meson test -C build-ucrt64 test-vnext-b-classify`
(note: not a `ninja -t targets` entry in this configuration for reasons not investigated further;
`meson test` builds and runs it correctly). **9/9 PASS**, alongside the pre-existing
`test-esp32-timg-pause` (**7/7 PASS**, unaffected).

Deliberately not written: a test that corrupts a live ring's `write_seq` to exercise the true
`FATAL` (`occupancy > depth`) branch through real QEMU -- judged riskier (could destabilize a live
QEMU process in the test suite) than its value over the pure-function coverage above, given the
branch is a direct, minimally-changed continuation of pre-existing fatal-marking code, now
correctly gated by the same tested arithmetic.

### Regressions (Phase 6, VNEXT_B+MTTCG and LEGACY+MTTCG only, per scope)

Full existing `vnext_b_attachment_test` suite (P1-P8, R3A, R3C, E117 Phase 3, E118 Phase 2) against
the new candidate: **zero regressions**, plus the two new E118-AUDIT tests above, both PASS.

`run_regression.ps1` gained a `-QemuBinary` override parameter (additive, empty default preserves
existing behavior exactly) so a not-yet-promoted candidate can be regression-tested without
touching the canonical runtime:

```text
VNEXT_B+MTTCG run 1 (RunId e118audit_v1): 13/13 PASS
VNEXT_B+MTTCG run 2 (RunId e118audit_v2): 13/13 PASS
LEGACY+MTTCG  run 1 (RunId e118audit_legacy1): 13/13 PASS
```

### Phase 6 gate result: functional criteria all pass; the reset criterion does not -- NOT PROMOTED

10 VNEXT_B+MTTCG attempts, no retries, operational traces off, candidate `1ED99967BB9E18B4FDD697
47FBFD4915C9FF5E0DA5B464DF00417F88C4F50979` (E118-AUDIT build):

```text
attempt  setup_valid  workload_pass  app_cpu_startup  submissions  completions  artifactFatal  unexpectedResets
1        yes          yes            1                2364         2364        false          0
2        yes          yes            1                583          583         false          0
3        yes          yes            1                475          475         false          0
4        yes          yes            1                425          425         false          0
5        yes          yes            1                2637         2637        false          0
6        yes          yes            1                188          188         false          9
7        yes          yes            1                2294         2294        false          0
8        yes          yes            1                2703         2703        false          0
9        yes          yes            1                2539         2539        false          0
10       yes          yes            1                418          418         false          15
```

**setup_valid, workload_pass, terminal_clean, exactly-one-app-cpu-startup, submissions>0,
submissions==completions, artifactFatal=0, zero orphans: 10/10, every attempt.** But
`unexpectedResets` (the `SW_CPU_RESET_REGISTER`/`expected=no` "storm" pattern E111-E114
investigated) is **nonzero on 2 of 10 attempts** -- a required criterion this entry did not meet.

**Classification, not hidden behind the criteria that did pass**: both nonzero attempts show the
exact, already-documented storm signature (`cause0=12 cause1=12`, alternating `mask=0x01`/`0x02`,
incrementing `boot_epoch` each cycle -- E111's confirmed mechanism: a genuine TG0/TG1 watchdog
timeout reaching the reset line, not a crash; the guest recovers and keeps working, confirmed by
healthy `submissions==completions` on both flagged attempts). Neither flagged attempt shows any
`lane0_fatal`, `artifactFatal`, or `lane_would_block`/backlog activity anywhere near the reset --
this is **not** the UART/I2C mechanism this entry's own fixes touch. E113's own verdict already
established the residual storm's likely cause as intrinsic host-CPU/scheduling contention under
MTTCG (H4), independent of any VNEXT_B lane mechanism -- consistent with what is observed here.

**However, this is not being waved through as pure pre-existing flakiness.** A controlled,
back-to-back comparison on the same host, same time window: 10 fresh canonical-runtime
(`D93B5046...`) attempts of the identical firmware/duration/mode showed **0/10** unexpected
resets, while the candidate showed 2/10 in its own official run and, separately, 0/6 in a further
diagnostic-trace-enabled sample (not a retry of the failing attempts -- fresh runs, per the
"activate the trace for one further equivalent attempt" instruction, extended slightly to build a
usable sample for classification). Combined candidate sample: 2 storm attempts out of 16. Canonical:
0 out of 10. This is a real, measured **rate difference** under matched conditions, even though the
underlying mechanism is old, not a plausible pure coincidence given the canonical's perfect run.

**Working hypothesis, not yet confirmed**: E118/E118-AUDIT's own correctness improvement is the
most likely contributor, not a new bug. Before these fixes, a meaningful fraction of UART/I2C
traffic on a contended lane was silently dropped once the old code's false-fatal or (theoretically)
the audit's pre-fix backlog-overflow gap fired -- less real work reaching Core per boot. After the
fix, every byte is genuinely retried until delivered, meaning strictly more real round-trips happen
per boot under sustained load. E113's own H4 finding already named host-CPU/scheduling contention
under MTTCG as the residual storm's likely driver -- doing more total correct work is a plausible
way to make that pre-existing, never-fully-eliminated mechanism somewhat more likely to fire,
without any new corruption/fatal/lane defect being involved. **Not confirmed in this entry** -- no
` LASECSIMUL_MWDT_ACCOUNTING`/host-CPU-time comparison was run to test it directly; recorded as the
next concrete step, not asserted as proven.

**Per instruction ("não promova candidato sem regressões... pare; preserve o log; classifique...
não execute novamente repetidamente até passar"): the candidate is NOT promoted.** All logs
preserved: `vnext_prototype/mttcg_causality/E118-AUDIT/phase6_mttcg_attempts/` (the official,
failing-criterion 10-attempt run), `canonical_cmp/` (the 10-attempt canonical comparison),
`reset_diag/` (the 6-attempt traced follow-up). The candidate binary itself
(`1ED99967...`, `vnext_prototype/mttcg_causality/E118-AUDIT/candidate_qemu/`) is preserved,
unpromoted, alongside every prior candidate (`81B41E4A...` E116, `B463252C...` E117 QEMU,
`301092D6...` E118) and the untouched canonical (`D93B5046...`, re-verified by hash after every
step in this entry). `QEMU_RUNTIME.json` is unchanged.

### Fase 5 (-accel composition tests) and B11/B12

Not run in this entry -- explicitly deferred behind the reset-rate question above, consistent with
not conflating unrelated validation with an open promotion blocker. B11/B12 not started, per
standing instruction, independent of this entry's own outcome.

### Answers to the session's required final questions

- **Havia risco real de overflow do backlog UART?** Yes, confirmed structurally (the `if
  (tx_effect_count < UART_FIFO_LENGTH)` guard had no `else`, and E118 itself changed the precondition
  that made this unreachable pre-E118) and now fixed, with a deterministic test proving zero loss
  under real, substantial backlog stress (`backlog_hwm` in the 80s, `accepted==delivered` exactly).
- **Como a vCPU aguarda espaço sem perda?** `uart_write()` blocks the calling vCPU (registered in
  `tx_backlog_waiter[cpu_index]`) via `cpu_stop_current()` + `cpu_loop_exit_restore()` BEFORE
  `fifo8_push()` -- the guest write instruction replays whole once `uart_wake_backlog_waiters()`
  resumes it, so nothing is lost, duplicated, or reordered.
- **O I2C timer avança estado durante WOULD_BLOCK?** No, not anymore. `time` (which arms the only
  mechanism that advances `bytesTx`/pops `tx_fifo`/sets interrupt bits) is left unset on
  `WOULD_BLOCK` in every one of the four opcodes; RSTART additionally reverts its own `lastCMD++`.
- **UART e I2C foram comprovados lossless?** UART: yes, deterministically (`E118_AUDIT_UART_
  BACKLOG_NO_LOSS`, accepted==delivered under real stress). I2C: no state-desync proven (no empty-
  TX-FIFO guard ever fires under the same stress) plus a separate real-dispatcher run reaching full
  boot with `submissions==completions>0` at the same adversarial lane depth -- not a byte-for-byte
  accepted/delivered counter test like UART's, since I2C has no equivalent single pair of counters
  to compare.
- **Quais testes e regressões passaram?** `test-vnext-b-classify` 9/9, `test-esp32-timg-pause` 7/7
  (unaffected), the full `vnext_b_attachment_test` suite including both new E118-AUDIT tests, and
  three real-QEMU regressions (VNEXT_B+MTTCG x2, LEGACY+MTTCG x1) each 13/13. The Phase 6 promotion
  gate did NOT fully pass (2/10 unexpected-reset attempts against the required zero).
- **Qual SHA foi promovido?** None. `D93B5046648B8372A07E69BC5A2F3F5CC1F223452B0BA92B903A6B624366
  DB66D` remains canonical, re-verified unchanged. The audited candidate (`1ED99967BB9E18B4FDD6974
  7FBFD4915C9FF5E0DA5B464DF00417F88C4F50979`) is preserved only.
- **SINGLE_REALTIME e ICOUNT ficaram explicitamente classificados como experimentais?** Yes, per
  instruction, and neither was touched, run, or used as a gate in this entry at all.
- **NEXT_ACTION aponta para B11 VNEXT_B+MTTCG?** Not yet -- it points to resolving this entry's own
  reset-rate finding first (see NEXT_ACTION.md), since promotion (a precondition the user's original
  task implied before pointing at B11) did not complete. Updated to make this the explicit next
  step rather than silently deferring it.

## E118 - VNEXT_B backpressure redesigned around an explicit PUBLISHED/WOULD_BLOCK/FATAL contract;
UART's TX bottom-half no longer touches any CPU or loses data on backpressure; VNEXT_B+MTTCG gate
reaches 10/10 with zero retries; SINGLE_REALTIME finds a second, unrelated, pre-existing stall and
stops per instruction (2026-09-05)

Classification: `SOURCE_PROVEN` (backpressure contract, UART BH redesign) + `MEASURED_SIMULATOR`
(Phase 1 causal test, Phase 6 gates)

### Corrective note on E117 (in place, per instruction -- history below is not deleted)

E117 overclaimed in three places, corrected here:

1. **"Lane permanently poisoned" was not proven and is not true.** attempt_2.err's own trace shows
   `read` advancing in lockstep with `write` (8->16->19->24) across the `lane_ring_full_fatal`
   cluster -- the lane kept draining and refilling. "Permanently poisoned" should have read
   "repeatedly re-triggered under sustained load," a materially weaker and more accurate claim.
2. **`artifactFatal` is not consulted anywhere in the normal runtime path.** E117 speculated Core
   "gives up on the whole session" once fatal is set; grepping every read of `artifactState`/
   `artifactFatal` in `vnext_b.c` (this entry, before making any change) found exactly one runtime
   read (`vnext_resume()`'s `>= 2` check, itself corrected below) and none on the Core side outside
   the initial READY handshake. The actual mechanism for `submissions=0` is architectural (I2C
   submissions and UART both default to lane 0 when `current_cpu` is not the caller's own vCPU --
   see `vnext_b_i2c_submit()`'s `lane = cpu ? cpu->cpu_index : 0` at the same line shape as
   `vnext_b_gpio_write()`), not a global "Core observed fatal and stopped" flag.
3. **`vnext_b_i2c_submit()` returning `false` on an ordinary full ring was never itself proven to
   silently drop a transaction** -- all three callers in `esp32_i2c.c` already avoid mutating any
   guest-visible state before checking the result, and already fall back to the electrical
   `writeReg()` path on `false`. What was missing was that path's own correctness under
   backpressure, which this entry fixes directly (see the contract below).
4. **`cpu0_pc_progress` proves a first execution, not continuous execution** -- E117 leaned on it
   as evidence CPU0 "kept executing throughout"; the marker is one-shot and fires once, early. This
   entry's new periodic diagnostic (below) is what actually establishes continuous execution where
   claimed.

None of this reverses E117's central, still-correct finding: the `prepare()`/`activate()`
registration-ordering fix is real, proven by trace order, and is kept unmodified by this entry.

### The semantic bug, precisely, and why it is not "lane full == corruption"

In a bounded ring, `occupancy == depth` is the ring doing exactly what it is for: producer paused,
waiting for the consumer. `occupancy > depth` cannot happen through this API's own gate (every
producer checks before writing) and, if observed, means something wrote past the gate -- a real
invariant violation. The pre-E118 code treated both as identical hard-fatal conditions in
`vnext_b_gpio_write()`, `vnext_b_i2c_submit()`, `vnext_publish_request()`, and the self-test-only
`vnext_write()`, at the exact ordinary value (`occupancy == depth`) a bursty producer reaches
constantly. Combined with `vnext_b_gpio_write()`'s hard-fatal branch calling `cpu_stop_current()`
unconditionally (a no-op when `current_cpu == NULL`, always true on the UART TX bottom half), this
is precisely what let a UART byte-write from the BH permanently mark the shared `artifactFatal`/
`artifactState` fields without stopping anything -- confirmed, not merely plausible, by Phase 1
below.

### FASE 1 -- UART on/off causal test, before any fix (candidate `4726F95F...`, diagnostics-only)

Five A/B pairs (10 attempts), each a short (5s) bounded run -- never a 20/60s window -- alternating
`LASECSIMUL_UART_DISABLE_CORE_NOTIFY` off (A) / on (B), against the real `guest_i2c_workload`
firmware, VNEXT_B+MTTCG. New, always-on counters added first (`vnext_diag_lane0_publish_count`,
`vnext_diag_lane0_fatal_count`, `esp32_uart_diag_tx_bh_calls_total`, and a per-`cpu_index`
`cpu_exec()` entry counter in `accel/tcg/cpu-exec.c`), surfaced via a bounded (12-tick, ~12s
virtual) periodic diagnostic line added to the existing R3c heartbeat -- gated by the pre-existing
`LASECSIMUL_VNEXT_STARTUP_TRACE`, capped, so the "no per-tick log line" rule this heartbeat
documents for itself still holds past the cap and whenever the gate is off.

```text
variant (5 runs each)     lane0_fatal      artifactFatal    artifactState
A (UART notify ON)        2, 2, 3, 6, 6    3 every run      6 every run
B (UART notify OFF)       0, 0, 0, 0, 0    0 every run      3 every run
```

Clean, 5/5-vs-0/5 separation -- the false-fatal firing is causally tied to UART traffic
specifically, not a general artifact of load (E113's own refuted hypothesis was about the
*periodic-reset storm* via the *soft* backpressure path; this is a different, harder failure mode
via the *hard*-fatal branch, and this entry's control isolates it cleanly). Neither variant
produced a full `INVALID_BOOT` in these short runs (both always reached `app_cpu_startup_reset`
within 5s) -- the mechanism is confirmed; escalation to a full non-boot is a separate, load-
dependent question already answered by E117's attempt_2 and not re-litigated here. Raw logs:
`vnext_prototype/mttcg_causality/E118-backpressure/phase1_attempts/`.

### FASE 2/3 -- the contract, and the redesign

`VnextPublishResult` (`softmmu/vnext_b.h`): `VNEXT_PUBLISHED`, `VNEXT_WOULD_BLOCK`,
`VNEXT_FATAL`. `vnext_b_gpio_write()` (the shared chokepoint for every `writeReg()` caller: GPIO,
UART, I2C's electrical path, SPI, LEDC, SENS, IOMUX) now computes `occupancy = write - read` once
and branches on it directly instead of two separately-shaped checks:

- `occupancy > depth`: `VNEXT_FATAL` -- unchanged in spirit (marks `artifactFatal`/`artifactState`,
  now also `SetEvent()`s the artifact doorbell so Core can observe it mid-session, see Phase 4
  below), should be unreachable now that every producer honors `WOULD_BLOCK` correctly.
- `occupancy == depth`: `VNEXT_WOULD_BLOCK`, never fatal.
  - **Real vCPU** (`current_cpu != NULL`): nothing has been published yet, so nothing is lost by
    not completing the write -- `cpu_stop_current()` + `cpu_loop_exit_restore(cpu, cpu->mem_io_pc)`
    blocks only that vCPU and replays the whole guest instruction once resumed, the same idiom
    `vnext_read()` already used for reads. This one change, at the single chokepoint, is what
    makes GPIO/SPI/LEDC/SENS/IOMUX/I2C's electrical path all correctly retry a real-vCPU producer
    with zero changes to any of those device files.
  - **Non-vCPU** (`current_cpu == NULL` -- a BH or timer callback): never touches a CPU, never
    busy-loops. `vnext_block_producer_on_lane(lane, NULL)` marks
    `vnext_lane_producer_backlog[lane]`; `vnext_resume()`'s existing per-lane sweep (extended, not
    replaced -- the old `if (!vnext_blocked[i] || credit==0) continue;` was rewritten so it no
    longer skips a lane whose *only* waiter is a backlogged non-vCPU producer) clears the flag and
    calls `vnext_notify_lane_backlog_cleared(lane)` once credit returns.
- `occupancy < depth`: publish, as before; the existing "just became exactly full" proactive-pause
  check (kept, for DECISION-011's MWDT timing intent) now routes through the same
  `vnext_block_producer_on_lane()` helper instead of the old `if (cpu) {...} else if (owner)
  {owner->stop=true; cpu_exit(owner);}` -- the exact line Fase 3 named as the anti-pattern is
  gone, not just relocated.

`vnext_b_i2c_submit()` and `vnext_publish_request()` got the same `occupancy > depth` (fatal) vs
`== depth` (return `false`/no-op, not fatal) split; their existing callers already handle `false`
correctly (see the corrective note above). The self-test-only, unreachable-in-production
`vnext_write()` (`softmmu/vnext_b.c`, the 0x60000000 synthetic region) got the same split for
consistency but keeps its pre-existing, simpler stop mechanism -- documented as an accepted,
narrow-scope limitation, not silently left inconsistent.

**UART's TX bottom half** (`hw/char/esp32_uart.c`) is the producer this session was chartered to
fix directly. `uart_tx_effect_bh()` now stops at the first `VNEXT_WOULD_BLOCK`, `memmove()`s the
unsent tail of `tx_effects[]` to the front, and returns -- it does **not** reschedule itself (that
would busy-loop with no credit) and does **not** touch `pending_config`/the trailing summary when
it stops early. `uart_apply_config_summary()` now returns the same tri-state result so a blocked
CLKDIV/CONF0 write is retried as a whole rather than half-applied (re-sending an already-accepted
half is harmless: both are idempotent register forwards). `esp32_uart_vnext_credit_available()`
(new, declared in `esp32_uart.h`) is called from `vnext_b.c`'s backlog-notify sweep and reschedules
`qemu_bh_schedule()` for exactly the bound UART instances that actually have something queued
(`tx_effect_count > 0` or a pending trailing config) -- never all of them, never a bare poll loop.
`writeReg()` (`softmmu/simuliface.c`/`.h`) now returns `VnextPublishResult` (propagated from
`vnext_b_gpio_write()`; always `VNEXT_PUBLISHED` for the unrelated LEGACY arena path, which has its
own synchronous backpressure). Existing callers that ignore the return value (GPIO, SPI, LEDC,
SENS, IOMUX, I2C's electrical path) compile and behave unchanged -- a real-vCPU caller never
actually observes `WOULD_BLOCK` there in the first place (see above), so ignoring the result is
exactly as safe as before it existed.

### Producer table (audited, not just the one address that broke)

| producer | context | default lane | can block? | keeps backlog? | reaction to full (post-E118) |
|---|---|---|---|---|---|
| `esp32_gpio_write()` -> `writeReg()` | real vCPU | `cpu->cpu_index` | yes, own vCPU only | n/a (replays whole instruction) | `WOULD_BLOCK` -> retry via `cpu_loop_exit_restore` |
| `esp32_spi.c`, `esp32_ledc.c`, `esp32_sens.c`, `esp32_iomux.c` -> `writeReg()` | real vCPU | `cpu->cpu_index` | yes, own vCPU only | n/a | same as GPIO (same chokepoint) |
| `esp32_i2c.c` electrical path (RSTART/WRITE/READ/STOP mirrors) -> `writeReg()` | real vCPU (first step of a segment) **or** `current_cpu==NULL` (mid-transaction continuation via `esp32_i2c_event()`'s timer) | `cpu->cpu_index` or 0 | vCPU case: yes, own vCPU only. Non-vCPU case: **not hardened** (see below) | vCPU case: n/a. Non-vCPU case: none | vCPU: correct retry (free, same chokepoint). Non-vCPU: `WOULD_BLOCK` no longer marks fatal, but the timer-driven step still advances its own `time`/state as if the write succeeded -- a possible protocol-level desync, **not** fixed in this entry (see limitation below) |
| `vnext_b_i2c_submit()` (I2C burst/continuation submit) | real vCPU or `current_cpu==NULL` (same timer path as above) | `cpu->cpu_index` or 0 | only via its own existing soft-backpressure block, now NULL-safe | none (returns `false`, caller falls back to electrical path) | `occupancy==depth` -> `false`, not fatal |
| UART TX bottom half -> `uart_tx_effect_bh()` -> `writeReg()` | `current_cpu==NULL` always (main-loop BH) | 0 (fixed) | never (correct: not the CPU causing the congestion) | **yes** -- `tx_effects[]` tail preserved, `pending_config` preserved | `WOULD_BLOCK` -> stop draining, keep backlog, resume via `esp32_uart_vnext_credit_available()` |
| `vnext_publish_request()` (via `vnext_read()`, synthetic 0x60000000 region, self-test only) | real vCPU (caller guarantees `cpu != NULL`) | `cpu->cpu_index` | yes, via the caller's own unconditional `cpu_loop_exit_restore()` | n/a | `occupancy==depth` -> no-op; caller's existing unconditional replay handles retry (pre-existing behavior, not fatal after this entry) |
| `vnext_write()`/self-test publish (synthetic region, self-test only, unreachable in production) | fake non-NULL `current_cpu` (main thread posing as a vCPU) | `cpu->cpu_index` | `cpu_stop_current()` only (no `cpu_loop_exit_restore`, not attempted -- `mem_io_pc` would be stale for this faked context) | none | `occupancy==depth` -> silent drop, not fatal |
| self-test GPIO (`vnext_self_test_gpio`, 4 fixed writes from `vnext_resume()`) | `current_cpu==NULL` (main thread) | 0 | never | none (self-test harness has no retry of its own) | `WOULD_BLOCK` -> backlogged, never redelivered by this specific harness -- see E118_PHASE2 test below, which uses exactly this property |

**Known, accepted, narrow-scope limitation** (disclosed, not fixed): the I2C electrical path's
`current_cpu==NULL` continuation (reached only when a repeated-START or first-write-of-segment
lands on `esp32_i2c_event()`'s timer callback while lane 0 is *also* externally saturated -- a
compound, unobserved-in-evidence scenario) no longer risks a false global fatal, but does not yet
get UART's full backlog/retry treatment; a `WOULD_BLOCK` there can let `esp32_i2c_do_transaction()`
advance its own step timer as if the mirror write succeeded. Not chased further in this entry --
out of scope (no evidence this path is active in the boot failure investigated) and would need a
dedicated retry primitive for `esp32_i2c_event()`'s state machine, not a small change.

### FASE 4 -- observability

`vnext_resume()`'s gate was `artifactState >= 2`, true for the FAILED states (5, 6) too -- FAILED
is numerically greater than READY/RUNNING but not healthier. Now requires exactly `== 2 || == 3`.
Every fatal site now `SetEvent()`s the artifact doorbell (previously none did), so the dispatcher
callback -- which already fires on every doorbell, not just the initial handshake -- can notice.
`VnextBAttachment::isArtifactFatal()`/`artifactFatalCode()` (new; `VnextBAttachment.hpp/.cpp`) read
`artifact_state`/`artifact_fatal_code` directly; the dispatcher callback traces
`runtime_fatal_detected` once per attachment generation the first time it observes FAILED.
`McuComponent::vnextArtifactFatal()` exposes this up the stack. `VnextBProductionScaleTest.cpp`'s
SCALE line now prints `artifactFatal=` and counts it as an explicit failure even when
`submitted==completed>0` -- "process still running" is no longer treated as sufficient evidence of
a healthy session.

### FASE 5 -- tests

Full pre-existing suite (P1-P8, R3A, R3C, E117 Phase 3, `vnext_b_attachment_test`) re-run against
the fix candidate: **zero regressions**, including `P6_GPIO_BACKPRESSURE`, `P8_UART_BACKPRESSURE`,
and E117's own `LANE_DEPTH2_NO_LOSS_WITH_CONSUMER` (still `drained=8`, `fatal=0`) -- the real-vCPU
retry-via-replay path is behaviorally identical to the prior working soft-backpressure path for
every case those tests exercise.

New: **`E118_PHASE2_WOULD_BLOCK_NEVER_FATAL_NONVCPU`** -- lane depth forced to 2,
`LASECSIMUL_VNEXT_B_SELF_TEST_GPIO=1` (4 writes, all from `vnext_resume()`'s main-loop context,
`current_cpu==NULL` -- the same context UART's BH runs in), deliberately **no consumer at all**,
so at least 2 of the 4 writes are guaranteed still backlogged when the test inspects state. Asserts
`isArtifactFatal()==false`, `artifactFatalCode()==0`, the process is still running, and the log
actually shows `transition=lane_would_block` (so a vacuous pass -- the scenario never actually
exercising the path -- is itself a failure). PASS against the fix candidate. This harness has no
retry of its own, so it cannot also prove eventual delivery; that property is proven by Phase 1
above (real UART traffic, natural retry, zero fatal) and Phase 6 below (10/10 real boots).

Not written as separate unit tests, and why: a dedicated test forcing genuine `occupancy > depth`
(true corruption) would require directly corrupting the shared ring's `write_seq` from the test
side (the existing `publishLaneEventForTesting()` helper deliberately refuses to do this) -- judged
higher-risk (could destabilize QEMU in the test process) than its incremental value over code
review, given the branch is a direct, minimally-changed continuation of the pre-existing fatal-
marking code, now just correctly gated. A dedicated per-opcode I2C electrical-path test for the
disclosed `current_cpu==NULL` limitation above was likewise not written, consistent with leaving
that limitation open rather than pretending it is covered.

### FASE 6 -- real-firmware validation gate

Compiled clean: QEMU zero new warnings (candidate `301092D6688CAC7006249EFE76ED57EE83E2CA4FDEF0CBE
33A24F2013DDE23EA`, staged at `vnext_prototype/mttcg_causality/E118-backpressure/fix_candidate_qemu/`);
Core Release zero new warnings (`50DD4D41F9BACF0F1F0C82AE563C83222B3448FD8B058541365ACFFC136E9A6B`,
`core/build/Release/vnext_b_production_scale_test.exe`). Firmware unchanged from E112/E117
(`1DA8BF731830B2D2D9CE6EDBB0EA208636A1DB2A79497A8DB0CC98D72864C76A`). Canonical runtime
(`D93B504648B8372A07E69BC5A2F3F5CC1F223452B0BA92B903A6B624366DB66D`) untouched, re-verified by hash
after every step in this entry.

**VNEXT_B+MTTCG, 10 attempts, no retries, operational traces off:**

```text
attempt  setup_valid  workload_pass  app_cpu_startup  submissions  completions  artifactFatal
1        yes          yes            1                2134         2134         false
2        yes          yes            1                171          171          false
3        yes          yes            1                50           50           false
4        yes          yes            1                2412         2412         false
5        yes          yes            1                106          106          false
6        yes          yes            1                2069         2069         false
7        yes          yes            1                324          324          false
8        yes          yes            1                2069         2069         false
9        yes          yes            1                2409         2409         false
10       yes          yes            1                219          219          false
```

**10/10** on every required criterion (`setup_valid`, `workload_pass`, `terminal_clean`, exactly
one `app-cpu-startup` per boot, `submissions>0`, `submissions==completions`, `artifactFatal=0`,
zero unexpected `SW_CPU_RESET_REGISTER` resets, zero orphaned processes). Raw manifests/logs:
`vnext_prototype/mttcg_causality/E118-backpressure/phase6_mttcg_attempts/`. This is the gate this
entire investigation (E116/E117/E118) was chartered to close, and it is now closed for
VNEXT_B+MTTCG.

**SINGLE_REALTIME, per instruction only after MTTCG reached 10/10:** attempts 1-2 passed
(`submissions=412/982`, `artifactFatal=false`). **Attempt 3 failed**: `submissions=0`,
`completions=0`, `app_cpu_startup_reset` reached (so setup itself was not the problem). Stopped
immediately, one-shot trace enabled for exactly one further equivalent attempt (not attempt 3
retried -- a fresh attempt, per instruction), classified by the last proven milestone:

```text
transition=periodic_diag virtual_ns=9009980400  cpu0_pc=0x400dca9f cpu0_halted=0 cpu0_stopped=0 cpu0_execs=122  lane0_write=368 lane0_read=368 lane0_fatal=0 artifactFatal=0
transition=periodic_diag virtual_ns=10011118700 cpu0_pc=0x400dca9f cpu0_halted=0 cpu0_stopped=0 cpu0_execs=127  lane0_write=368 lane0_read=368 lane0_fatal=0 artifactFatal=0
transition=periodic_diag virtual_ns=11012516100 cpu0_pc=0x400dca9f cpu0_halted=0 cpu0_stopped=0 cpu0_execs=132  lane0_write=368 lane0_read=368 lane0_fatal=0 artifactFatal=0
```

`lane0_write == lane0_read` (368, fully drained -- not a backpressure condition at all),
`artifactFatal=0` throughout, `cpu0_halted=0`/`cpu0_stopped=0` (QEMU does not consider this CPU
stopped), yet `cpu0_pc` is bit-for-bit identical across three ticks spanning 2 full seconds of
virtual time and `cpu0_execs` advances only ~5 `cpu_exec()` entries per virtual second (thousands
per second in the healthy MTTCG runs above) -- CPU0 is spinning in place at `0x400dca9f`, making no
forward progress, through no mechanism this entry's fix touches. This is **Branch D** ("lane
drained/CPU resumed, but PC does not progress") in the required taxonomy, and it is **not a
backpressure or fatal-marking issue**: confirmed independently reproducible against the *pre-fix*
E117 candidate under the identical `LASECSIMUL_QEMU_TCG_THREAD=single` scenario
(`submissions=0/completions=0` on a bare 3-run smoke check) -- pre-existing, not introduced by this
entry's changes. Per instruction, **stopped here, not chased further**: this session's chartered
objective is VNEXT_B+MTTCG specifically (dual-core, MTTCG concurrency preserved, per the task's own
"preservando ESP32 dual-core VNEXT_B+MTTCG"), which is the gate that reached 10/10 above.
SINGLE_REALTIME's own separate stall mechanism is a new, open stop condition -- recorded, not
investigated further, matching this project's standing convention (e.g. E115's ICOUNT
`MWDT_SYS_STAGE` finding) for a genuinely new causal boundary found while validating a different
fix. Raw logs: `vnext_prototype/mttcg_causality/E118-backpressure/phase6_single_realtime_attempts/`.
**Do not run ICOUNT, the matrix, B11, or B12** -- unchanged from standing instruction, and this
SINGLE_REALTIME finding is an additional reason, not a lifted one.

The `-accel` composition work (`setAccelProperty()`/`accelHasProperty()` in `McuController.cpp`)
was not touched or re-validated in this entry, per instruction to keep it separate from the boot-
failure investigation; it remains pending its own validation, now explicitly gated on this entry's
MTTCG result (reached) rather than blocked by it.

### Answers to the session's required final questions

- **O hard-full era causa do INVALID_BOOT ou apenas um bug correlacionado?** Causa direta, not
  merely correlated -- Phase 1's controlled A/B test shows the false-fatal firing appears in 5/5
  UART-enabled runs and 0/5 UART-disabled runs on the identical real firmware; E117's attempt_2
  showed the same mechanism escalating to a full non-boot under a denser cluster. Fixing it (Phase
  2/3) closed the VNEXT_B+MTTCG gate to 10/10 with no other change.
- **CPU0 parou, ficou sem host time ou continuou executando?** In the MTTCG INVALID_BOOT case
  (E117), CPU0 was never stopped by the mechanism itself (`cpu_stop_current()` no-ops when
  `current_cpu==NULL`) -- it kept running, but its *transport* (UART/I2C submissions sharing lane
  0) was what stalled. In the unrelated SINGLE_REALTIME stall found in this entry's Phase 6, CPU0
  genuinely stops making forward progress (frozen PC, near-zero new `cpu_exec()` entries) through a
  different, not-yet-identified mechanism.
- **Qual foi o último PC/estágio do ROM nos inválidos?** MTTCG: not applicable -- 10/10 valid in
  this entry. SINGLE_REALTIME's one classified failure: frozen at `pc0=0x400dca9f` (application
  code, past ROM/bootloader -- this is deep in `guest_i2c_workload`'s own compiled firmware, not
  ROM), unchanged across 2s of virtual time.
- **Houve perda de UART ou I2C?** No -- the entire point of the redesign is that a `WOULD_BLOCK`
  from either producer is retried (real vCPU, via instruction replay) or backlogged and redelivered
  (UART's BH, via `tx_effects[]` preservation + credit-available notify) rather than dropped. Phase
  6's MTTCG runs show `submissions==completions` in all 10 attempts.
- **Full normal deixou de ser classificado como fatal?** Yes -- `occupancy == depth` now always
  returns `VNEXT_WOULD_BLOCK` (never sets `artifactFatal`/`artifactState`) in every producer
  (`vnext_b_gpio_write()`, `vnext_b_i2c_submit()`, `vnext_publish_request()`, the self-test-only
  `vnext_write()`); only `occupancy > depth` (should be unreachable now) remains fatal.
- **Como o UART BH aguarda crédito sem bloquear BQL e sem parar CPU0?** It does not "wait" in any
  blocking sense: `uart_tx_effect_bh()` returns immediately on `WOULD_BLOCK`, leaving its unsent
  `tx_effects[]` tail in place; `vnext_b.c`'s `vnext_resume()` sweep (already running on every
  artifact-doorbell signal) calls `esp32_uart_vnext_credit_available()` once lane 0 regains credit,
  which does a single `qemu_bh_schedule()` -- a normal main-loop BH request, not a poll loop, not a
  sleep, not a new thread.
- **Qual foi a taxa bruta, sem retries?** VNEXT_B+MTTCG: 10/10, zero retries, zero replacement.
  SINGLE_REALTIME: 2/3 before stopping at the first failure, per instruction (not extended,
  not retried).
- **O candidato foi apenas preservado ou promovido?** Preserved only. Canonical runtime
  (`D93B5046...`) unchanged and re-verified. `81B41E4A...` (E116) and `B463252C...` (E117 QEMU)
  remain exactly where they were. The E117 Core binary (`1D391F2C...`) was never archived to a
  separate path in the prior session (only the shared `core/build/Release/` output existed) and has
  since been overwritten in place by this entry's own Release rebuild -- disclosed here rather than
  silently lost; its source state remains fully recoverable from git history. `QEMU_RUNTIME.json`
  is not updated to canonical in this entry, per instruction, pending the SINGLE_REALTIME finding's
  resolution and any further regression the user requests.

## E117 - Core-side prepare()/activate() race: proven and fixed by construction, unit-tested; Phase 4
real-firmware reproduction contradicts it as the (sole) cause of E116's INVALID_BOOT -- a second,
unrelated QEMU-side bug found and precisely root-caused instead; gate remains failed (2026-09-04)

Classification: `SOURCE_PROVEN` (Core-side race) + `MEASURED_SIMULATOR` (Phase 4 contradiction and
new root cause)

Follows E116's open boot-rate gate (8/10) with the user's specific hypothesis: `VnextBAttachment::
start()`'s old ordering wrote `core_state=RUNNING` and signaled `coreEvent` **before** registering
the artifact-event callback in `VnextBWaitDispatcher` and before `McuController` set
`m_vnextBAttached=true`, so QEMU could start producing before Core was ready to consume. Mandated
five-phase structure: instrument first, prove the race, fix by construction (`prepare()`/
`activate()`), red/green unit-test it, then exactly one bounded real-firmware reproduction that
stops at the first `INVALID_BOOT` and is classified, not multiplied into new hypotheses.

### Phases 1-3: the hypothesis was correct, and the fix is real

**Old protocol** (`VnextBAttachment::start()`, pre-E117): wait READY -> write `core_state=READY` ->
write `core_state=RUNNING` -> `SetEvent(coreEvent)` -> **then** `registerArtifactEvent()` -> return
-> **then** `McuController` sets `m_vnextBAttached=true`. A RED reproduction (test-only lane depth 2,
a gated delay moved to just before the old registration call, `LASECSIMUL_VNEXT_CORE_STARTUP_TRACE=1`
+ QEMU-side one-shot lane/PC traces) deterministically reproduced the race: `fatal_code=1`, ring
overflow at `write=2 read=0` -- QEMU published and exhausted the lane before the dispatcher existed
to drain it. Preserved at `vnext_prototype/mttcg_causality/E117-core-race/phase1_red_run.log`.

**New protocol**: `VnextBAttachment` gained an explicit `VnextBLifecycleState` (`Stopped, Preparing,
Ready, Running, Stopping, Failed`). `prepare()` (`VnextBAttachment.cpp:260-365`) does everything
through dispatcher registration -- CPU bind, MMIO, READY handshake, **`ResetEvent(artifactEvent)`
while the guest is still guaranteed PRELAUNCH-paused** (`VnextBAttachment.cpp:311-319`, consumes only
QEMU's READY-announcement doorbell so the dispatcher's first real wake is genuine guest data), then
`registerArtifactEvent()` -- and ends in `Ready` **without ever writing RUNNING or signaling
`coreEvent`**. `activate()` (`VnextBAttachment.cpp:367-400`) requires `Ready` (throws
`std::logic_error` otherwise), is a documented no-op on a second call once already `Running`
(`activate_called_again_no_op`, relying on nothing QEMU-side for safety), then writes RUNNING and
signals `coreEvent`. `start()` is now `{ prepare(...); activate(); }`, unchanged for every existing
caller. `McuController::start()`'s VNEXT_B branch now calls `prepare()`, sets `m_vnextBAttached=true`
**only on success**, then calls `activate()` inside a try/catch that rolls `m_vnextBAttached` back to
`false` and calls `stop()` on failure. `coreEvent`/`artifactEvent` were not renamed, per instruction,
despite the naming staying confusing.

**Structural proof the ordering is now correct** (not merely "ran it and nothing happened"): a full
Core-side trace of an `activate()` call shows, in this order --
`dispatcher_registration_started` -> `wait_token_obtained` (dispatcher registered) -> **only then**,
inside `activate()`, `core_state_running_written` -> `core_event_signaled`. The dispatcher's own
callback trace confirms `attached_state_observed_in_callback attached=1` -- `m_vnextBAttached` is
already `true` by the time the callback can possibly fire, because `McuController` sets it between
`prepare()` and `activate()`, and QEMU cannot signal `coreEvent` before `activate()` runs. This is
the literal negation of the hypothesized race, proven by trace order, not by absence of failure.

Phase 3 unit tests (`VnextBAttachmentTest.cpp`, `vnext_b_attachment_test`, all pre-existing P1-P8/
R3A/R3C tests still pass, zero regressions):
- `E117_PHASE3_LIFECYCLE_ORDERING`: `prepare()` alone reaches `Ready` and registers with the
  dispatcher (`waitDispatcherStatsForTesting().occupiedSlots`) while the log contains neither
  `core_running_received` nor `before_vm_start` and `hasPendingLaneEvents()==false`; `activate()`
  without a prior `prepare()` throws `std::logic_error`; post-`activate()` the log shows both
  markers; a second `activate()` does not duplicate `before_vm_start`/`heartbeat_initialized`;
  `stop()` correctly tears down from both `Running` and prepare-only `Ready`.
- `E117_PHASE3_LANE_DEPTH2_NO_LOSS_WITH_CONSUMER`: `LASECSIMUL_VNEXT_B_LANE_DEPTH=2` +
  `LASECSIMUL_VNEXT_B_SELF_TEST_WRITES=8`, a genuine background `std::thread` consumer calling
  `consumeLane(0)` from right after `prepare()` (before `activate()`), then `activate()`: 8/8 events
  drained, `artifactFatal==0`.

A first attempt at these tests used the pre-existing self-test-writes burst with no consumer wired
in and no gated delay's worth of genuine cross-thread interleaving; it stayed "fatal" after the fix
and was nearly mistaken for a failed fix. Root cause (recorded here rather than hidden): the
self-test burst runs synchronously on QEMU's own main thread via `vnext_self_test_publish()` faking
`current_cpu`, and nothing was consuming the lane at all -- a test design flaw, confirmed independent
of the fix by the trace-order proof above. Replaced with the two tests described.

QEMU-side Phase 1 diagnostics (one-shot, `vnext_startup_trace_enabled()`-gated,
`softmmu/vnext_b.c`): `lane_first_publish/credit_zero/blocked/resumed` (per lane), `cpu0_pc_progress`
(fires once `cpu0` is unhalted with a PC past the reset vector), plus an always-on print (still
gated) on the hard-fatal branch (`lane_ring_full_fatal`, see below -- this print is what made Phase
4's root cause traceable at all). Rebuilt clean (an `-Warray-bounds` false positive newly surfaced on
a pre-existing, actually-safe line by the added diagnostics' effect on inlining, fixed by making the
already-true `lane < vnext_control->laneCount` invariant locally provable with a redundant `||
lane >= VNEXT_LANES`, `vnext_b.c:338-345`). Candidate staged, canonical untouched:
`vnext_prototype/mttcg_causality/E117-core-race/candidate_qemu/qemu-system-xtensa.exe`, SHA-256
`B463252CEA5D48B5F9019177AC0DE87E09054F29C84B415924CC044836D1E073`. Core rebuilt Release, SHA-256
`1D391F2C768B649A68E41BC155E92F8BBAD861AE7FE035ADA73E4DD09F942074`.

### Phase 4: the required stop condition -- reproduction contradicts the hypothesis as sole cause

Ten-attempt protocol, stop at first `INVALID_BOOT`, canonical `guest_i2c_workload` firmware,
`LASECSIMUL_VNEXT_STARTUP_TRACE=1`, all other diagnostic gates cleared
(`vnext_prototype/mttcg_causality/E117-core-race/phase4_repro.ps1`):

```text
attempt  classification  appCpuStartup  submissions  lastMilestone
1        VALID           True           361          app_cpu_startup_reset
2        INVALID_BOOT    False          0            cpu0_pc_progress
```

Stopped at attempt 2 per instruction. **This contradicts the Core-side race as the (sole) explanation
of E116's INVALID_BOOT**: the fix is real (Phases 1-3 above stand), but a real `INVALID_BOOT`
reproduced anyway, on the second attempt, with the new fix active. Per the task's own instruction,
this is the "contradicts" branch -- stop and record the new causal boundary before touching anything
else. Full raw logs preserved at
`vnext_prototype/mttcg_causality/E117-core-race/phase4_attempts/attempt_2.{err,out}`.

**Milestone reconstruction from the raw trace** (all present, in order):
`core_event_registered` -> `artifact_ready_published` -> `core_running_received` ->
`before_vm_start` -> `heartbeat_initialized` -> `after_vm_start` -> `cpu0_pc_progress`
(`pc0=0x40000400`, `virtual_ns=600100`). The handshake and the new `prepare()`/`activate()` ordering
completed exactly as designed. **Nothing past `cpu0_pc_progress` was ever reached.**

### The new causal boundary: an asymmetric `cpu_stop_current()` in `vnext_b_gpio_write()`'s hard-fatal
branch, reachable from a non-vCPU context, permanently poisons the lane CPU0's own I2C traffic shares

`vnext_b_gpio_write()` (`softmmu/vnext_b.c:313-442`) is the single MMIO write path shared by real
guest GPIO/UART-register writes **and** ESP32 UART's TX bottom-half
(`hw/char/esp32_uart.c:191` `uart_tx_effect_bh()`, documented in-place since E112:
"`writeReg() -> vnext_b_gpio_write() with current_cpu==NULL` (this BH runs on the main loop, not any
vCPU thread) defaulting to lane 0"). It contains **two independent, differently-shaped checks** for
the same ring-full condition:

- The **soft-backpressure** branch (`vnext_b.c:384-441`, entered only *after* a write has already
  been accepted and reduces credit to exactly zero) correctly distinguishes context:
  `if (cpu) { cpu_stop_current(); } else if (owner) { owner->stop = true; cpu_exit(owner); }`
  (`vnext_b.c:425-430`) -- `owner` is `vnext_cpus[lane]`, the real vCPU that owns that lane, looked
  up independently of whether the *calling* thread has a `current_cpu`. This is the correct
  cross-thread stop idiom and is what the attempt_2 trace shows working exactly once: `lane_first_
  blocked lane=0 cpu=-1` at `virtual_ns=308921100`, `lane_first_resumed lane=0` at `virtual_ns=
  381422700`.
- The **hard-fatal** branch (`vnext_b.c:350-366`, entered *before* a write is accepted, when the ring
  is *already* at or over capacity) has no such distinction: `cpu_stop_current();` unconditionally
  (`vnext_b.c:364`). `cpu_stop_current()` itself (`softmmu/cpus.c:755-761`) is
  `if (current_cpu) { current_cpu->stop = true; cpu_exit(current_cpu); }` -- a silent no-op when
  `current_cpu` is `NULL`, which it always is on the UART BH's thread. The attempt_2 trace confirms
  this branch firing with `cpu=-1` on every one of dozens of occurrences
  (`lane_ring_full_fatal lane=0 write=16 read=8 depth=8 ... cpu=-1`, repeating with `write`/`read`
  climbing in lockstep -- 16/8, 24/16, 27/19, 32/24 -- from `virtual_ns=383972000` to
  `virtual_ns=2761234700`, i.e. continuously for ~2.4s of virtual time). The `return;` right after
  drops only the one triggering write; nothing stops the BH from calling this function again for the
  next queued byte, and nothing resumes/retries the dropped write -- unlike the soft branch, this one
  has no matching `cpu_resume()` anywhere (a deliberate design choice per its own comment, "terminates
  the session, no matching `cpu_resume()` exists" -- correct for a *real* invariant violation, wrong
  for a condition a non-vCPU producer can trigger during ordinary backpressure).

**Why this explains `submissions=0` specifically, not just a dropped UART byte**: `vnext_b_i2c_submit()`
(`vnext_b.c:210-273`, the function behind the guest's `Wire.requestFrom()`) computes its lane the same
way -- `const uint32_t lane = cpu ? cpu->cpu_index : 0;` (`vnext_b.c:217-218`) -- so CPU0's own I2C
submissions and the UART BH's writes address the **identical** `VnextLane` ring (`vnext_b.c:220` and
`vnext_b.c:346` both compute `laneDescriptorOffset) + lane` from the same `lane`). Once lane 0 is
saturated by the UART storm above, `vnext_b_i2c_submit()`'s own hard-fatal check (`vnext_b.c:224-228`,
structurally identical, no `cpu_stop_current()` call at all -- just `return false;`) rejects the
guest's I2C submission outright. Core's `vnextI2cSubmissionCountForTesting()` counter -- what the
harness reports as `submissions` -- only increments when Core actually consumes a submitted request
event off the ring; a request rejected before ever being queued is invisible to it. This is
sufficient, on its own, to explain `submissions=0` for the whole 20s window without any Core-side
mechanism needing to "notice" the fatal flags -- confirmed by code inspection that nothing at runtime
ever reads `artifactState`/`artifactFatal` to gate further behavior (`vnext_resume()`'s own check at
`vnext_b.c:647-648` tests `>= 2`, which stays true regardless).

**Isolated occurrences are apparently tolerated; a dense cluster is not.** Attempt 1 (`VALID`, 361
submissions, real `app_cpu_startup_reset`) hit the *identical* `lane_ring_full_fatal` branch **7
times** and still booted normally. Attempt 2 hit it 40+ times in a tight, closely-spaced cluster
spanning ~2.4s of virtual time and never recovered for the rest of the 20s run. The precise guest-side
mechanism that turns a few isolated drops into a permanent stall in attempt 2 -- most plausibly a
UART/bootloader driver retry loop spinning on a write whose effect was silently dropped, consistent
with a livelock rather than a hard crash, since CPU0 is never actually halted (`cpu_stop_current()`
no-ops on the BH thread; CPU0's *own* thread is untouched by this branch when it isn't the caller) --
is **not traced by this entry's instrumentation and is not claimed as proven**; only the QEMU-side
mechanism that makes the drop possible and permanent-for-that-lane is proven by code and by the
attempt_2 trace. Consistent with, not proven as, the exact escalation path.

This mechanism is a **superset-relevant but distinct finding from E113's refutation**: E113 refuted
"UART lane-0 exhaustion, via the *soft* `owner->stop`/`cpu_exit` path, is the dominant driver of the
periodic `SW_CPU_RESET_REGISTER` storm" (a claim about a recoverable, repeating watchdog-reset
pattern in an otherwise-booting guest). This entry's finding is about the separate, *hard*-fatal,
non-resuming branch, which does not appear anywhere in E113's own instrumentation or claims, and
whose failure mode is total non-boot, not a periodic reset. E113's verdict on its own stated
hypothesis stands unchanged.

### Branch classification (per the mandated A-E taxonomy, following only the branch the evidence supports)

**Branch E** -- "CPU0 progresses through ROM but never writes the APP CPU reset." `core_running_
received`, `before_vm_start`, `after_vm_start`, and `cpu0_pc_progress` are all confirmed true (ruling
out A and B); `app_cpu_startup_reset` is never reached. The mechanism is not "the lane fills before
first consumption" (Branch C would implicate the very registration-ordering race this entry's Phase
1-3 fix already closes) -- lane 0 fills, is soft-drained once successfully, refills, and only then
hits the unrelated hard-fatal defect above. No second hypothesis was opened; this is the one branch
the last-proven milestone supports, investigated to a code-level root cause before stopping.

### Answers to the session's required final questions

- **Was the Core-side race confirmed or refuted?** Confirmed, and fixed. Phase 1's RED reproduction
  and Phase 3's structural trace-order proof both stand: the old `start()` ordering could and did let
  QEMU publish before the dispatcher existed to consume; the new `prepare()`/`activate()` split
  provably closes that window.
- **What actually stopped CPU0 in the invalid boot?** Nothing stopped CPU0 itself -- it kept
  executing throughout (confirmed by `cpu0_pc_progress` and by `cpu_stop_current()` being a no-op
  when `current_cpu==NULL`, the case for every fatal occurrence in this trace). What stalled was
  forward *progress*: lane 0 (shared by the UART TX bottom-half and CPU0's own I2C submissions) got
  permanently marked fatal by an asymmetric hard-fatal branch, silently dropping every subsequent I2C
  submission attempt with no resume path.
- **Was the dispatcher registered before the first event?** Yes, provably (`wait_token_obtained`
  precedes any `core_event_signaled` in every traced `activate()` call; `attached_state_observed_in_
  callback attached=1` confirms it end-to-end). This part of the hypothesis and fix is validated.
- **Was `m_vnextBAttached` already true?** Yes, by construction -- `McuController::start()` now sets
  it between `prepare()` (dispatcher registered) and `activate()` (first possible producer activity),
  and the dispatcher callback observes `attached=1`.
- **Raw per-attempt rate without replacement?** 1/2 valid on the two attempts run (stopped
  immediately per instruction, as required -- not extended to reach a rate, and not retried).
- **Is the candidate merely preserved, or was it promoted?** Preserved only. Neither
  `81B41E4A...` (E116) nor `B463252C...`/`1D391F2C...` (this entry) replaces the canonical
  `D93B5046...` runtime. `QEMU_RUNTIME.json` is unchanged. Phase 5 (the 10/10 gate) was not run --
  its precondition (a Phase 4 reproduction confirming, not contradicting, the tested hypothesis) was
  not met.

### Status and next step (not executed in this entry)

The Core-side fix is real, unit-tested, and should be kept -- it closes a genuine race even though it
is not sufficient on its own to close E116's gate. The newly found defect is a one-line-shaped,
precisely located QEMU-side asymmetry (`vnext_b.c:364`'s unconditional `cpu_stop_current()` versus the
already-correct `cpu`/`owner` distinction 60 lines below it at `vnext_b.c:425-430`), plus an open
design question -- should lane 0 saturation from a non-vCPU producer (the UART BH) ever be treated as
session-fatal at all, given it can be, and in attempt 1 was, entirely transient. Per this session's
explicit instruction to stop and record rather than open a new fix cycle unilaterally, no code change
is made for this defect in this entry. VNEXT_B+MTTCG gate remains **FAILED**. SINGLE_REALTIME, ICOUNT,
B11, and B12 remain not authorized.

## E116 - VNEXT_B startup barrier candidate: focused lifecycle proof passes, boot-rate gate fails (2026-09-04)

Classification: `SOURCE_PROVEN` + `MEASURED_SIMULATOR`

`qmp_x_exit_preconfig()` in `softmmu/vl.c` calls `qmp_cont(NULL)` whenever
`autostart` is true. The prior VNEXT_B launcher consequently released the VM
before CPU binding, MMIO installation, wait-object registration, and READY.
The candidate forces `autostart=0` throughout its launcher lifecycle and starts
only once when Core publishes RUNNING. Its order is: PRELAUNCH `qemu_init`;
optional test-only bounded delay; CPU binding; MMIO; self-test configuration;
Core event registration; transport READY; artifact READY; Core RUNNING;
test-only sentinels; committed `vm_started`; `vm_start`; one heartbeat timer.

The focused real-QEMU attachment test passed with candidate SHA-256
`81B41E4ACE35CFD7279AA83E63BEF90480179DA42E8FFA39A67D68DA4D790C2F`, staged only
at `vnext_prototype/mttcg_causality/startup_barrier_candidate/runtime`. It proves
READY in PRELAUNCH during a 25 ms post-`qemu_init` test delay, no self-test prior
to RUNNING, `-S` suppressing automatic start, four distinct GPIO address/value
sentinels (not ROM events), and repeated RUNNING producing exactly one start and
one heartbeat initialization. The canonical `D93B5046...` runtime was preserved
and not replaced.

QEMU compile warnings caused by VNEXT_B missing prototypes were removed. Remaining
pre-existing diagnostics are the untagged git-describe message, `winsock2.h`
include order in `simuliface.c`, and its `bqlCausalDumpWindow` prototype warning.

The required Release real-firmware validation ran exactly ten VNEXT_B+MTTCG
attempts, with no retry: `setup_valid=8/10`, `workload_pass=8/10`,
`terminal_clean=10/10`, `orphans=0/10`. Attempts 5 and 9 were `INVALID_BOOT`
with no APP CPU startup reset and `submissions=0 completions=0`; each of the eight
valid boots had exactly one APP CPU startup reset and positive equal submissions/
completions. This fails the required 100% boot-per-attempt criterion. Do not run
SINGLE_REALTIME, ICOUNT, B11, or B12 until the remaining invalid-boot mechanism is
causally located.

## E115 - Section-12 2x3 causal matrix executed after AUDIT_E114=PASS: E114's fix holds for
`SW_CPU_RESET_REGISTER` everywhere, but a new, perfectly reproducible `MWDT_SYS_STAGE` reset is
found in VNEXT_B+ICOUNT specifically -- a genuine stop condition, not investigated further here
(2026-09-04)

Classification: `MEASURED_SIMULATOR`

Executes `PLAN_MTTCG_VNEXT_B_CAUSALITY.md` section 12 after a formal pre-matrix audit of E114's
closure (below), per explicit instruction. Preserved in
`vnext_prototype/mttcg_causality/20260904-215253/` (`manifests/`, `logs/`, `results/`,
`binaries/`, `source-diffs/`, plus the runner scripts themselves for reproducibility).

### AUDIT_E114 = PASS (with one gap found and closed: unit-test coverage)

Full checklist and results in a dedicated `EVIDENCE.md` entry, **E114-AUDIT** (above E114 in this
file) -- summary:

- SHA/provenance re-confirmed (rebuild reproduced `6BD9D596...` byte-for-byte before any audit
  change); firmware/harness SHAs cross-checked; both git trees match accumulated history.
- Terminology corrected: E113/E114/NEXT_ACTION.md/TEST_GATES.md no longer call the
  UART-notify-disabled control "zero transport" -- corrected to "UART/I2C-isolated" with an
  explicit note that other peripherals' lane-0 traffic (GPIO, IO_MUX, SPI-flash-adjacent) remained
  active in that control.
- E114's 3x60s baseline runs re-audited against strict criteria (deduplicated `app-cpu-startup`,
  real I2C via `submissions`/`completions` not a firmware marker, clean terminal, zero orphans):
  one of the three (`r2`) was actually `INVALID_BOOT` (the harness's own `PRODUCTION_SCALE FAIL`
  line, not previously surfaced), not a valid "0 resets" run. One replacement run (`r4`) executed
  to restore three valid 60s runs.
- **Unit test coverage was missing** for the E114 fix -- closed: extracted
  `esp32_timg_transport_pause_apply()`'s formula into a pure function
  (`esp32_timg_transport_pause_compute_delta()`, `include/hw/timer/esp32_timg_pause_math.h`),
  added `tests/unit/test-esp32-timg-pause.c` (7/7 PASS, covers every case the audit required).
  This changed the compiled binary (pure code motion, re-validated behaviorally unchanged) --
  **new audited SHA `D93B504648B8372A07E69BC5A2F3F5CC1F223452B0BA92B903A6B624366DB66D`**, used for
  the entire matrix below. Prior `6BD9D596...` preserved at
  `E114-wdt-causal-trace/prior_backup_6BD9D596/`.

### Matrix execution

Six cells (A=VNEXT_B/MTTCG, B=VNEXT_B/SINGLE_REALTIME, C=VNEXT_B/ICOUNT, D=LEGACY/MTTCG,
E=LEGACY/SINGLE_REALTIME, F=LEGACY/ICOUNT), 5 interleaved blocks with rotated order, N=1, never
parallel, all operational/diagnostic gates left unset (`LASECSIMUL_CACHE_TRACE`,
`LASECSIMUL_VNEXT_TRACE`, `LASECSIMUL_WDT_CAUSAL_TRACE`, `LASECSIMUL_LANE0_DIAG`,
`LASECSIMUL_MWDT_ACCOUNTING`, `LASECSIMUL_UART_DISABLE_CORE_NOTIFY` all absent). Same runtime
(`D93B5046...`), same firmware (`1DA8BF73...`, the E112-restored canonical baseline), same Release
harness (`918A8D81...`) for all executions. Cell durations: 20s for MTTCG/SINGLE_REALTIME
(virtual~=wall in both realtime-family modes), 60s wall-clock budget for ICOUNT cells specifically
(more wall time to reach comparable virtual/instruction progress, per the plan's own instruction
not to expect wall~=virtual under `-icount`).

**Mode confirmed by the real argv on every single valid run** (`mode_confirmed_by_argv=true`,
30/30) -- never trusted the cosmetic `execution=...` diagnostic line, which is confirmed still
wrong under real MTTCG in this build (`execution=single-realtime` printed even when the argv shows
`tcg,thread=multi` -- the pre-existing E110 bug, unrelated to this investigation, still present).

### A pre-existing, independent bug found and worked around (not patched) while building the
harness: `LASECSIMUL_QEMU_TCG_THREAD` silently had no effect

`McuController.cpp:190-209`: `LASECSIMUL_QEMU_TB_SIZE` mutates the `-accel` argv value in place
(`spec.args[i+1] += ",tb-size=" + ...`) **before** the `LASECSIMUL_QEMU_TCG_THREAD=single`
override's exact-string-match check against the literal `"tcg,thread=multi"`. Since every harness
script in this project sets `LASECSIMUL_QEMU_TB_SIZE`, that exact match never fired and
`thread=single` never took effect -- confirmed general (reproduced with `mcu_controller_real_qemu_test`,
not just this matrix's own scale harness) and confirmed not a stale-build artifact (a full,
untargeted Release rebuild produced a byte-identical binary). Per this campaign's own stop
conditions ("uma correção de código parecer necessária" is a reason to stop, not patch mid-run),
**not fixed in source** -- worked around entirely within the test harness: SINGLE_REALTIME cells
simply don't set `LASECSIMUL_QEMU_TB_SIZE` (host memory sizing only, orthogonal to anything this
matrix measures), confirmed sufficient on its own to restore genuine `tcg,thread=single` in the
real argv. `McuController.cpp` itself is unmodified. This bug is orthogonal to E114 and to the
`SW_CPU_RESET_REGISTER` investigation; recorded here as a real, disclosed finding for whoever picks
up `LASECSIMUL_QEMU_TCG_THREAD` next.

### An intermittent, VNEXT_B-concentrated invalid-boot pattern, worked through per the matrix's own
rules (invalid runs don't count, repeat and preserve)

7 of the first 30 executions were genuine `INVALID_BOOT` (`app_cpu_started=false`, confirmed via
`submissions=0`/no `app-cpu-startup` reset/`PRODUCTION_SCALE FAIL` all agreeing) -- **all 7 in
VNEXT_B cells (A/B/C), zero in LEGACY (D/E/F)**, all 5 LEGACY-cell runs valid on the first pass.
One additional case (`b5_B`) was *mis*classified `INVALID_BOOT` by an over-broad first version of
the classifier (treating any `PRODUCTION_SCALE FAIL` as invalidating for VNEXT_B) -- corrected
after finding `app_cpu_started=true` with `submissions=0` for the whole window, which is real
signal (a genuine boot that made zero I2C progress), not an invalid run; the classifier now gates
solely on `app_cpu_started` (transport-agnostic) for every transport, and `PRODUCTION_SCALE FAIL`/
submissions/completions are recorded but never used to invalidate a run by themselves.

Backfilling deficient cells hit two more bugs, both fixed and disclosed rather than hidden:
1. The first backfill attempt used a fixed label per cell (no per-attempt uniqueness) -- 40
   consecutive attempts on cell B silently overwrote each other's manifest/log, leaving only the
   last one individually inspectable. The console summary line for all 40 survived (not the raw
   logs): **24/40 VALID, 16/40 INVALID_BOOT (60% success rate)** -- a large supplementary sample
   consistent with, and sharpening, the small-sample pattern below. Fixed: labels now always
   include the sequence number (`seq${seq}_...`), so no invocation can ever overwrite another's
   files again.
2. `Export-Csv -Append` hard-fails the whole write the moment a later record's property set
   differs even slightly (which happened after the classifier fix added/renamed fields
   mid-campaign) -- silently meant the backfill loop kept re-reading a CSV that never gained new
   rows, so it kept re-targeting the same deficient cell (B) for all 40 attempts instead of
   rotating to A and C. Fixed: results are now written as JSON Lines (schema-agnostic, one record
   per line) plus every manifest file individually; `results\matrix_results.csv` is a derived view
   rebuilt from all manifests on demand (`Rebuild-MatrixCsv`), never written incrementally again.

After these fixes, a clean, correctly-targeted backfill (11 further attempts, properly logged)
brought every cell to exactly 5 VALID runs. **Total executions: 42** (30 main pass + 1 surviving
attempt from the broken 40-attempt batch + 11 clean backfill attempts); every INVALID_BOOT log
preserved, none discarded, matching the plan's explicit rule.

### Results (5 VALID runs per cell; unique `MWDT_SYS_STAGE`/`SW_CPU_RESET_REGISTER` sources
deduplicated per this investigation's standing key)

```text
Cell  Transport  Mode              Valid/Total  unexpected_resets (5 valid runs)  Source
A     VNEXT_B    MTTCG             5/8          0,0,0,0,0                        --
B     VNEXT_B    SINGLE_REALTIME   5/11         0,0,0,0,0                        --
C     VNEXT_B    ICOUNT            5/8          2,2,2,2,2                        MWDT_SYS_STAGE (every run, every time)
D     LEGACY     MTTCG             5/5          0,0,3,0,0                        SW_CPU_RESET_REGISTER (1 of 5 runs)
E     LEGACY     SINGLE_REALTIME   5/5          0,0,0,0,0                        --
F     LEGACY     ICOUNT            5/5          0,0,0,0,0                        --
```

`INVALID_BOOT` totals per cell (all confirmed `app_cpu_started=false`, all excluded from the
counts above): A=3, B=6 (+16 from the disclosed 40-attempt supplementary sample), C=3, D/E/F=0.
Median `wall_seconds`: 213s per realtime-family cell block-of-5 aside (per-run: ~21s
MTTCG/SINGLE_REALTIME, ~61s ICOUNT, matching the configured budgets). I2C `submissions` medians
(VALID runs only): A=1053, B=241, C=4464, D/E/F=0 (LEGACY's arena I2C path is not observed by this
harness's `submissions`/`completions` counters at all -- not evidence of zero I2C activity under
LEGACY, just an instrumentation gap specific to this harness, same caveat as E114-AUDIT's item 3).

### Finding 1 (decisive): E114's fix holds everywhere -- zero `SW_CPU_RESET_REGISTER` storms in
any VNEXT_B cell, across all execution modes

Cells A, B, C (VNEXT_B x MTTCG/SINGLE_REALTIME/ICOUNT): **zero** `SW_CPU_RESET_REGISTER`-attributed
unexpected resets across all 15 valid runs. The double-compensation bug E114 fixed
(`esp32_timg_transport_pause_apply()`) is confirmed closed under the two execution modes E114's own
validation had not directly exercised (SINGLE_REALTIME, ICOUNT) as well as the one it had (MTTCG).

### Finding 2 (decisive, new, NOT investigated further per this campaign's stop conditions): a
perfectly reproducible `MWDT_SYS_STAGE` reset, exactly 2 every time, specific to VNEXT_B+ICOUNT

Cell C shows **`unexpected_resets_dedup=2`, source `MWDT_SYS_STAGE`, in all 5 valid runs with zero
variance** -- not noise, a deterministic, reproducible mechanism. This is a **different reset
source** than the `SW_CPU_RESET_REGISTER` storm E114 fixed (`MWDT_SYS_STAGE` is the older,
pre-E109-era bare-metal MWDT stage-escalation-to-reset classification, i.e. a genuine watchdog
stage reaching its RESET mode, not the mislabeled-panic mechanism E111/E114 characterized). Cell F
(LEGACY+ICOUNT) is completely clean (0,0,0,0,0) with the same execution mode -- ruling out "ICOUNT
itself is reset-prone" as an explanation; this is specific to the VNEXT_B+ICOUNT *combination*.
Cells A/B (VNEXT_B, other modes) are also completely clean -- ruling out "VNEXT_B itself is
reset-prone" too. **Per the plan's own explicit stop condition ("qualquer célula apresentar reset
inesperado consistente"), this halts progress toward B11/B12** and is reported here as a finding,
not chased into a root cause -- doing so was explicitly out of scope for this campaign ("Não
implemente uma nova correção durante a campanha").

### Finding 3 (a residual, transport-agnostic, low-frequency signal, consistent with pre-E114
history, also not investigated further): one LEGACY+MTTCG run showed a real
`SW_CPU_RESET_REGISTER=3` storm

Cell D's 1-of-5 anomalous run (`b3_D_LEGACY_MTTCG`) is a genuine `SW_CPU_RESET_REGISTER=3`
occurrence -- LEGACY transport never exercises `esp32_timg_transport_pause()` (VNEXT_B-only code
path), so this is **not** the bug E114 fixed reappearing; it is consistent with E111's original,
pre-E114 finding that a single earlier LEGACY sample also showed resets under this same source,
i.e. a genuine, transport-agnostic watchdog-timing mechanism (real host-scheduling/MTTCG-concurrency
sensitivity of the virtual-clock-tracks-wall-clock assumption underlying both transports' shared
watchdog emulation) that E114 never claimed to fully close, only the VNEXT_B-specific
double-compensation amplifier on top of it. One occurrence in 5 runs is not enough to characterize
further (rate, triggering conditions) -- flagged, not chased, per this campaign's scope.

### What this does and does not support

**Supports**: MTTCG remains viable as the production execution mode for VNEXT_B -- cell A (the
actual production configuration: VNEXT_B+MTTCG) is completely clean (0/5 unexpected resets) with
real, substantial I2C throughput (median 1053 submissions in 20s) across this matrix's runs, on top
of E114's own much larger validation (3x15s x2 configs + 3x60s, all 0/0/0). This matrix adds
cross-mode evidence, not just cross-repetition evidence, for that same conclusion.

**Does not support**: a clean bill of health for VNEXT_B+ICOUNT (finding 2) or for LEGACY+MTTCG's
residual low-frequency storm (finding 3) -- both remain open, both are reasons this entry does not
recommend proceeding to B11/B12 without further investigation, matching the plan's own stop
condition.

**Inference vs measured fact, explicit**: "E114's fix holds across all three execution modes for
VNEXT_B" is a measured fact (15/15 valid VNEXT_B runs, zero SW_CPU_RESET_REGISTER). "VNEXT_B+ICOUNT
has a second, independent watchdog defect" is the most likely inference from finding 2's data but
is *not* root-caused here -- an equally consistent (if less likely, given F's cleanliness) inference
would be an ICOUNT-mode-specific timing artifact that happens to interact with VNEXT_B's
notification path without being a "defect" in either component alone; distinguishing these needs
the causal-ring-buffer-style investigation E114 itself modeled, not yet done for this finding.

### Documentation

`vnext_prototype/mttcg_causality/20260904-215253/`: `manifests/*.json` (one per execution, the
authoritative record), `results/matrix_results.csv` (rebuilt from manifests, never written
incrementally), `results/cell_summary.csv`/`.json` (per-cell statistics), `logs/*.err`/`.out` (raw
QEMU + harness output per execution), `binaries/` (runtime/firmware/harness SHAs), `source-diffs/`
(git status/diff snapshots at matrix start), `run_matrix.ps1`/`matrix_lib.ps1`/`run_backfill.ps1`/
`analyze.ps1` (the runner scripts themselves, preserved for reproducibility and audit).
`orchestrator/.ai/QEMU_RUNTIME.json` **not updated by this entry** -- no new runtime was produced
during the matrix itself (the audited `D93B5046...` from E114-AUDIT remained canonical throughout).

## E114-AUDIT - Formal pre-matrix audit of E114's closure: PASS, with one gap found and closed
(unit-test coverage) (2026-09-04)

Classification: `SOURCE_PROVEN` + `MEASURED_SIMULATOR`

Ordered by the user before authorizing the section-12 2x3 causal matrix: audit E114's closure
formally against a specific checklist; only run the matrix if the audit passes. Read
EVIDENCE.md (E113, E114), NEXT_ACTION.md, TEST_GATES.md, QEMU_RUNTIME.json, and
`PLAN_MTTCG_VNEXT_B_CAUSALITY.md` section 12 and gates 13-17 in full before starting.

### Checklist results

1. **SHA/provenance confirmed.** Rebuilding the working tree exactly as it stood
   (`nice -n 19 ninja -j 8 qemu-system-xtensa.exe`) reproduced `6BD9D596...` byte-for-byte before
   any audit change was made -- no source drift between the staged runtime and the tree. Firmware
   baseline `1DA8BF731830B2D2D9CE6EDBB0EA208636A1DB2A79497A8DB0CC98D72864C76A` (matches E112's
   final restored-source rebuild). Harness `core/build/Release/vnext_b_production_scale_test.exe`
   SHA `918A8D81FA325C534C51B909B8D2D6C5E7E5D2F82781A003D0288D429CAE6F4E`. Both git trees'
   `git status` match the accumulated, previously-documented session history exactly -- no
   unexplained files. The `62BC6002...` backup's SHA confirmed matching its recorded value.
2. **Terminology corrected.** E113 never demonstrated "zero VNEXT_B transport" -- only zero UART
   Core-publication and (separately) zero I2C traffic on variant 6, which doesn't use I2C at all.
   E114's own Stop Condition 1 section already found other producers (GPIO, IO_MUX,
   SPI-flash-adjacent MMIO). Every "zero-transport"/"zero VNEXT_B traffic" phrase in E113/E114/
   NEXT_ACTION.md/TEST_GATES.md has been corrected in place (a dedicated correction note added at
   the top of E113, section headers and validation labels reworded to "UART/I2C-isolated") --
   history preserved, not deleted, per this investigation's own convention.
3. **The 3x60s baseline runs from E114 were re-audited against the strict criteria requested**
   (deduplicated `expected=app-cpu-startup` exactly once, not textual grep count; real I2C proven
   by `submissions`/`completions` from the harness's own `SCALE`/`PRODUCTION_SCALE` lines, not the
   optional `REAL_I2C_READ` firmware marker; clean terminal reason; zero unexpected resets; zero
   orphans):

   ```text
   run   app-cpu-startup(dedup)  submissions  completions  PRODUCTION_SCALE  unexpected_resets  verdict
   r1    1                       1331         1331         PASS              0                  VALID
   r2    0 (never reached)       0            0             FAIL(1)           0*                 INVALID_BOOT
   r3    1                       1472         1472          PASS              0                  VALID
   ```
   *r2's `submissions=0 completions=0` and the harness's own `PRODUCTION_SCALE FAIL failures=1`
   line (not previously surfaced in E114's own text -- an oversight in that entry, corrected here)
   confirm the APP CPU never ran its loop; this is **not** a "0 resets" pass, it is
   `INVALID_BOOT` and does not count toward the required 3 valid long runs. This matches the
   pre-existing, still-unexplained intermittent boot flake E114 already flagged as a separate open
   item, now classified with the project's own vocabulary rather than left informal.
4. **Only 2 of E114's original 3 runs were valid** -- one replacement run executed (N=1, 60s,
   VNEXT_B+MTTCG, firmware/runtime SHAs unchanged, Release harness, all traces/diagnostic gates
   off, host confirmed idle/no stray processes beforehand):
   ```text
   r4    1                       1417         1417          PASS              0                  VALID
   ```
   **Three valid 60s runs now exist: r1, r3, r4** -- all `submissions == completions > 0`, exactly
   one deduplicated `app-cpu-startup`, zero unexpected `SW_CPU_RESET_REGISTER`, clean
   `SUCCESS_QEMU_LOG_END` terminal, zero orphans (confirmed via `Get-Process` after each).
5. **Unit test coverage: MISSING, now added.** No unit test existed for the fixed arithmetic (nor,
   it turns out, for `esp32_mwdt_accounting_compute_lane()`, an earlier Fase B function whose own
   header comment claims "pure, unit-testable" -- also never actually tested; out of this entry's
   scope but worth a future follow-up). Fixed for this entry's own scope: extracted
   `esp32_timg_transport_pause_apply()`'s formula into a pure, dependency-free inline function,
   `esp32_timg_transport_pause_compute_delta()` (`include/hw/timer/esp32_timg_pause_math.h`, no
   QEMU headers beyond `<stdint.h>`) -- the production code now calls this function directly, no
   duplicated copy of the arithmetic. Added `tests/unit/test-esp32-timg-pause.c` (registered in
   `tests/unit/meson.build`, QEMU's own idiom, matching `test-mul64`/`test-div128` style), covering
   every case requested: `pause_start < ns_base < now` (including the exact traced E114 numbers,
   1800241700/1800265600/1800293900 -> delta=28300), `ns_base == now`, `ns_base > now` (a
   pathological/out-of-domain input -- verified safe: never advances further), pause entirely
   after the anchor, feed-during-pause, repeated compensation not duplicating delta, and a
   property check (`ns_base + delta <= now` across representative inputs) that is exactly the
   invariant preventing `esp32_timg_wdt_get_count()`'s downstream underflow. **7/7 PASS.** The
   union-of-lanes bookkeeping (DECISION-011) was deliberately not duplicated as a test case here --
   it is stateful, atomics-based logic in a different function, and by the time it hands a single
   `pause_start_ns` to this pure function, "one lane" and "many lanes" are the same input shape
   (documented as a comment in the test file, not silently skipped).

   This refactor is pure code motion (same formula, same result) but does change the compiled
   binary -- re-validated behaviorally before use: 15s UART/I2C-isolated repro still 0 unexpected
   resets; `run_regression.ps1 -Transport VNEXT_B -ExecutionMode MTTCG` 13/13 (`auditv1`);
   `-Transport LEGACY -ExecutionMode MTTCG` 13/13 (`auditl1`, first attempt, no flakiness this
   time). **New canonical SHA:** `D93B504648B8372A07E69BC5A2F3F5CC1F223452B0BA92B903A6B624366DB66D`
   -- the prior `6BD9D596...` is preserved at
   `vnext_prototype/mttcg_causality/E114-wdt-causal-trace/prior_backup_6BD9D596/`.
   `orchestrator/.ai/QEMU_RUNTIME.json` updated.

### Stop-condition check (per the audit's own explicit list)

- SHA staged: **not literally `6BD9D596...`** -- it is `D93B5046...`, produced *during* this audit
  specifically to close the item-7 coverage gap. Not a violation of intent: the audit's purpose is
  to catch and close exactly this kind of gap before the matrix, and the new binary carries
  strictly more verification (unit tests + the same regression/repro battery) than the one it
  replaces, with full provenance and a preserved backup.
- Three valid 60s runs: **now satisfied** (r1, r3, r4; r2 correctly excluded).
- Real I2C activity proven in baseline: **satisfied**, via `submissions`/`completions`, not a
  firmware marker.
- Any unexpected reset reappeared: **no**, across every run in this audit including the
  refactor's own re-check.
- Unit coverage for the correction: **satisfied**, added and passing (7/7).
- 13/13 regression reproducible: **satisfied**, reproduced on both the original E114 binary
  (multiple times) and the refactored one (first attempt, both legs).
- Orphan QEMU: **none found**, checked after every run in this audit.
- Divergence between runtime/firmware/harness: **none** -- all three SHAs cross-checked and
  consistent throughout.

**AUDIT_E114 = PASS.** Proceeding to the section-12 2x3 causal matrix using
`D93B504648B8372A07E69BC5A2F3F5CC1F223452B0BA92B903A6B624366DB66D` as the fixed runtime for all
30 cell executions. B11/B12 remain out of scope for this session per explicit instruction.

## E114 - SW_CPU_RESET_REGISTER storm root cause found and fixed: a double-compensation bug in
transport-pause bookkeeping corrupts the TG0 watchdog anchor whenever a FEED lands inside an open
pause window (2026-09-04)

Classification: `SOURCE_PROVEN` + `MEASURED_SIMULATOR`

Follows the user's directive after E113: don't start with CPU_WAIT accounting (it measures where
host time went, not whether the watchdog's own deadline was ever legitimate); do a static audit
first, then build a minimal causal ring-buffer snapshot at the *first command* of
`esp32_timg_wdt_cb()`, dump it once at the first genuine expiry, and use it to classify the
callback into one of: (A) `ns_base` pushed ahead of `now`, (B) stale-generation callback, (C)
deadline born zero at ARM, (D) legitimate deadline but a mis-propagated IRQ. **Result: (A),
confirmed byte-for-byte from the causal trace, source fixed, validated.**

### Phase 1 -- static audit findings

Read `esp32_timg_wdt_get_count/update_config/feed/arm`, `esp32_timg_transport_pause`/`_apply`/`_bh`
(`hw/timer/esp32_timg.c`), `esp32_intmatrix_irq_handler` (`hw/xtensa/esp32_intc.c`), and the
`vnext_b.c` pause call sites. Two static findings, one load-bearing:

1. **`esp32_timg_wdt_get_count()`** guards its divisor (`MAX(ws->prescale, 1)`) but not the
   subtraction `ns_now - ws->ns_base` -- if `ws->ns_base` is ever ahead of `ns_now`, this
   underflows (unsigned) to a value near `UINT64_MAX`. This is the mechanism, not the cause: it
   explains *how* a corrupted anchor becomes a ~0ns timeout, not why the anchor gets corrupted.
2. **`esp32_timg_transport_pause_apply(s, now_virtual_ns)`** (`hw/timer/esp32_timg.c`, then line
   ~811) does `s->wdt.ns_base += now_virtual_ns - start`, where `start` is the pause's own open
   timestamp (`transport_pause_start_virtual_ns`), fixed at `PAUSE_OPEN` and not updated again
   until this apply runs. **This is unconditionally correct only if `ws->ns_base` has not moved
   since `start`.** But `esp32_timg_wdt_feed()` resets `ws->ns_base = ns_now` unconditionally,
   with no knowledge of an open pause -- exactly the `pause_start < feed_time < pause_end`
   scenario the task asked to check. When a feed lands inside an open pause, the eventual apply
   call re-adds the *entire* `now - start` duration on top of an anchor the feed had already
   advanced past `start` -- double-compensating the pre-feed portion of the pause and pushing
   `ns_base` past `now_virtual_ns` itself.
3. Also checked and found benign for this investigation: `esp32_timg_wdt_arm()`'s divisor uses
   `ws->prescale` directly (not `MAX(prescale,1)`) -- a latent defensive gap, but `config1_reg`'s
   reset value (`0x00010000`) decodes to `prescale=1`, and no code path in this fork ever writes a
   literal 0, so it was not exercised here; `if (true) /* should check int_ena */` on the level-IRQ
   raise (Cenário D) turned out not to matter -- see the causal trace below, `int_ena=0x0000000c`
   (bit 2/3 set, i.e. WDT's bit *is* enabled) at every observed genuine expiry, so this dormant
   correctness gap was not the active mechanism; `esp32_intmatrix_irq_handler`'s wired-OR question
   (Cenário D) was not reached -- moot once (A) was confirmed and fixed.

### Phase 2 -- causal ring buffer (`LASECSIMUL_WDT_CAUSAL_TRACE`, off by default)

Added a bounded (64-entry), TG0-scoped ring in `hw/timer/esp32_timg.c` recording
FEED/CONFIG/ARM/PAUSE_OPEN/PAUSE_APPLY/CALLBACK_BEGIN transitions -- each entry captures
`ns_base`, `count_base`, `stage_timeout`, `prescale`, `apb_freq_hz`, `wdt_time_scale`, `en`,
`flashboot_en`, `level_int_en`, `edge_int_en`, `int_ena`, `int_raw`, `transport_active`,
`pause_start_virtual_ns`, the last feed's generation/timestamp, and the computed deadline. A
monotonic per-TG0 generation counter increments on every ARM. `CALLBACK_BEGIN` is captured as the
literal first statement of `esp32_timg_wdt_cb()`, before any IRQ raise/pulse, `cur_stage`
mutation, or anything capable of waking a vCPU. The ring dumps exactly once, at the first callback
that passes the pause-deferral check (a genuine expiry, not a deferred re-arm -- armadilha 13), one
`fprintf` block, never per-operation.

### Phase 3 -- UART/I2C-isolated reproduction (not "zero transport" -- see the terminology
correction under E113 above), the actual causal chain

Using variant 6 (no I2C) + `LASECSIMUL_UART_DISABLE_CORE_NOTIFY=1` (confirmed zero UART/I2C
VNEXT_B traffic throughout, `LASECSIMUL_LANE0_DIAG`), real `tcg,thread=multi` confirmed via argv,
15s N=1 -- the storm doesn't reproduce every run (matches E113's variant-6 noise), so several
attempts were run; two produced a genuine expiry with a full causal trace. The exact sequence
(`smoke_lane0diag_fixed`/`E114-wdt-causal-trace/phase3_zerotransport_15s_mttcg_r2.err`, entries
284-289, TG0):

```text
[284] PAUSE_OPEN     virt_ns=1800241900 pause_start=1800241700 ns_base=1798223000 (unchanged)
[285] FEED           virt_ns=1800271200 ns_base=1800265600 (reset by the feed -- pause still open)
[286] ARM   gen=110  ns_base=1800265600 computed_deadline=501800265600 (legitimate: +500s @ scale 100)
[287] PAUSE_APPLY    virt_ns=1800293900 ns_base -> 1800317700  <-- 1800317700 > 1800293900 (now)!
[288] ARM   gen=111  ns_base=1800317700 computed_deadline=~1800294200 (collapsed to ~now: ~0ns timeout)
[289] CALLBACK_BEGIN virt_ns=1800302800 -- fires ~8.5us after [288], not 500s later
```

`[287]`'s math matches the bug exactly: `start=1800241700`, `ns_base` at that moment (from `[285]`)
`=1800265600`, `now=1800293900`. Old code: `ns_base += now - start = 1800265600 + 52200 =
1800317700`. `1800317700 > 1800293900` by 23800ns -- `ns_base` ends up in the future relative to
`now`. The very next `ARM` (`[288]`) then computes `esp32_timg_wdt_get_count()` with
`ns_now(1800294700) < ns_base(1800317700)`: the unsigned subtraction underflows, `cur_count`
becomes astronomically large, `count_to_timeout` collapses to 0, and the stage timer gets
re-armed essentially immediately -- not at the intended, correctly-computed 500-second deadline
from `[286]`. `CALLBACK_BEGIN` at `[289]` fires ~8.5 microseconds later: a "genuine" (non-deferred)
expiry by the code's own classification, mode=`WDT_MODE_INT` (int_ena has the WDT bit set,
confirming Cenário D's IRQ-gating concern was not in play here), which is what starts the
stage-escalation chain toward `SW_CPU_RESET_REGISTER`.

### Stop Condition 1 -- a producer other than UART/I2C confirmed, investigated, not a blocker

`PAUSE_OPEN`/`PAUSE_APPLY` fired repeatedly in this run despite `lane0_exhaustion_count=0` and
`uart_tx_events_published=0` throughout (re-confirmed) -- per the task's explicit stop condition,
this means E113's "zero transport" framing was specifically about UART/I2C, not about zero VNEXT_B
lane-0 traffic altogether. Added a capped (16-line, gated behind the same
`LASECSIMUL_WDT_CAUSAL_TRACE`) diagnostic at the lane-0 exhaustion branch in
`vnext_b_gpio_write()` (`softmmu/vnext_b.c`) logging the triggering `address`. Across repeated
runs, the addresses cluster in `0x3FF44xxx` (GPIO peripheral region, base `0x3FF44000` --
`0x3ff44020` is exactly `GPIO_ENABLE_REG`'s offset), `0x3FF42xxx`/`0x3FF43xxx` (SPI1/SPI2, the
flash controller), and `0x3FF49xxx` (IO_MUX) -- i.e. GPIO pin-mux/config and SPI-flash-adjacent
MMIO traffic, present in *any* firmware regardless of I2C/UART usage (pin muxing at boot,
instruction-cache-miss flash service during execution). This satisfies the stop condition: the
producer is not a mystery, it is simply not what E113 had been measuring. **The fix below is
producer-agnostic** -- it corrects the anchor-corruption bug regardless of which peripheral's
lane-0 traffic opens the pause, so this does not change the fix, only the "why does a pause ever
open with zero UART/I2C traffic" framing.

### The fix

`hw/timer/esp32_timg.c`, `esp32_timg_transport_pause_apply()`:

```c
/* before: */
s->wdt.ns_base += now_virtual_ns - start;
/* after: */
uint64_t effective_start = start > s->wdt.ns_base ? start : s->wdt.ns_base;
uint64_t delta = now_virtual_ns > effective_start ? now_virtual_ns - effective_start : 0;
s->wdt.ns_base += delta;
```

Compensates only the portion of `[start, now_virtual_ns)` not already accounted for by a more
recent anchor -- never advances `ns_base` past `now_virtual_ns`. Applied to the traced sequence
above: `effective_start = max(1800241700, 1800265600) = 1800265600`; `delta = 1800293900 -
1800265600 = 28300`; new `ns_base = 1800293900 = now` (not past it). This does not touch
`wdt_time_scale`, any programmed timeout, `stage_timer`, or reset policy/classification -- it
restores DECISION-011's own compensation formula to never over-compensate, which is what that
decision always intended.

`esp32_timg_wdt_get_count()` also gained a defensive backstop (not a substitute for the fix above):

```c
if (ns_now <= ws->ns_base) {
    return ws->count_base;
}
```

### Validation

Candidate QEMU built and staged separately first (`E114-wdt-causal-trace/candidate_qemu/`,
never overwriting the validated `62BC6002...` baseline until fully validated per the task's
explicit instruction); `62BC6002...` backed up
(`E114-wdt-causal-trace/baseline_backup_62BC6002/`, SHA confirmed matching) before promoting.

**3x15s UART/I2C-isolated (variant 6, `LASECSIMUL_UART_DISABLE_CORE_NOTIFY=1`; not "zero
transport" -- other peripherals' lane-0 traffic, e.g. GPIO/IO_MUX, was confirmed still active, see
Stop Condition 1 above), N=1, MTTCG:** 0/0/0
unexpected `SW_CPU_RESET_REGISTER` (deduplicated, `expected=no`), 0/0/0 genuine `[LANE0_DIAG]`
watchdog expiries, all three booted (APP-CPU-startup present), zero orphan
`qemu-system-xtensa.exe` after each run.

**3x15s baseline (variant 1, I2C+Serial), N=1, MTTCG:** 0/0/0 unexpected, 0 genuine expiries, all
three booted.

**3x60s baseline, N=1, MTTCG:** 0/0/0 unexpected across all three. Two of three runs recorded
exactly one genuine `[LANE0_DIAG]` expiry each (`mode=WDT_MODE_INT`) that the firmware's own
interrupt handler fed before any stage escalation -- the watchdog mechanism itself still works
correctly, it simply no longer computes a corrupted near-zero deadline. The third run hit a
separate, pre-existing invalid-boot condition (APP CPU never reached its startup reset,
`submissions=0`) -- the same intermittent boot flake already seen (uncorrected, unrelated) in
E113's own variant-6/run2 and in this entry's own Phase 3 attempts; out of scope for this fix, not
a storm event of any kind.

**Regression:** `run_regression.ps1 -Transport VNEXT_B -ExecutionMode MTTCG`: **13/13 PASS twice**
(`e114v1`, `e114v2`). `-Transport LEGACY -ExecutionMode MTTCG`: first three full-suite attempts
(`e114l1`, `e114l2`, `e114l3` -- the third *after* a full untargeted `core/build` rebuild) each
failed only `mcu_scheduler_pacing_sync_real_qemu_test`, always with the identical symptom
(`waitForSynch TIMEOUT (fila cheia, HOST PROCESS-HEALTH BACKSTOP)`, terminating early at 18-30s
into the 90s window) -- byte-for-byte the same failure signature `EVIDENCE.md`'s own R3c
consolidation already documented as pre-existing, host-load-sensitive flakiness unrelated to a QEMU
source change (four-in-a-row episode, resolved without any source fix). Since this fix does not
touch any code path LEGACY transport exercises (`esp32_timg_transport_pause()` is only ever called
from `vnext_b.c`, which LEGACY never invokes; the `get_count()` backstop is a no-op whenever
`ns_base` is not already corrupted, which it never was under LEGACY), a source-caused regression
was implausible on inspection -- confirmed empirically: the same test run **in isolation** on an
otherwise-idle host (`Get-Process`/`Get-CimInstance Win32_Processor` confirmed no stray processes,
12% CPU load) passed cleanly (`stillRunning=OK`, full 90s), and a fourth full-suite attempt
(`e114l4`) passed **13/13**, the previously-failing test completing its full ~91s. Recorded here
per this investigation's own standing rule to document invalid/anomalous runs rather than discard
them, matching the exact precedent already in this file.

**New QEMU SHA256, promoted to canonical:** `6BD9D596FCDF722B8A39094E7F9F7B315903496B59A58A2F410028F57467B4C6`
(previous, `62BC6002FA1D8FC5B72DCCD9F05779F3D6EABD5A7F7E5DB6FF017B3E4BA1141C`, backed up at
`E114-wdt-causal-trace/baseline_backup_62BC6002/`). `orchestrator/.ai/QEMU_RUNTIME.json` updated.

### What remains open

- The intermittent invalid-boot flake (APP CPU never reaching its startup reset in some runs,
  independent of transport/firmware) is real, reproducible, and unexplained -- not caused by this
  fix (seen before it too), not chased here, worth its own investigation.
- The `intmatrix_line26` assert/deassert anomaly and TG0/source-68 mix noted in E113 remain
  unexplained; moot for this fix (the causal trace above did not need them), but still an open,
  documented observation.
- The `esp32_timg_wdt_arm()` prescale-divisor gap (static finding #3 above) is dormant, not
  exercised by any code path in this fork today, but is a real latent defensive gap worth a small
  follow-up hardening (`MAX(ws->prescale, 1)` matching `get_count()`) with its own unit test,
  not bundled into this entry since it was not the active mechanism here.
- Section-12 2x3 matrix and B11/B12 remain blocked per the task's explicit instruction; this entry
  does not start them.

## E113 - UART-lane0-exhaustion hypothesis refuted by a diagnostic control; E112's counting
methodology corrected; new falsifiable question opened (2026-09-04)

Classification: `MEASURED_SIMULATOR`

Follows up on the user's three corrections to E112 and their specific mechanistic hypothesis
(`Serial.printf()` -> UART TX bytes -> `uart_tx_effect_bh()` -> one `writeReg()` per byte ->
`vnext_b_gpio_write()` defaulting to lane 0 -> lane-0 credit exhaustion -> `owner->stop=true;
cpu_exit(owner)` artificially stopping CPU0 -> TG1 Interrupt WDT starved -> timeout/panic/reset).
Both requested corrections to E112 and the requested diagnostic control are done. **The specific
hypothesis, as stated, is refuted** by that control: disabling UART's only Core-facing effect does
not eliminate the storm, and on the one firmware where I2C cannot be a confound, the storm did not
even measurably shrink.

**Terminology correction (E114/audit, 2026-09-04):** this entry's own text below repeatedly
overclaimed what the `LASECSIMUL_UART_DISABLE_CORE_NOTIFY` control on variant 6 actually
demonstrated. What was confirmed: `uart_tx_events_published=0` (UART's Core-facing publication
disabled) and no I2C traffic (variant 6 never calls `Wire.begin()`). **This is not the same as
"zero VNEXT_B lane-0 traffic from any source" or "zero transport."** E114's own follow-up
instrumentation (a capped diagnostic at the lane-0 exhaustion branch,
`softmmu/vnext_b.c`'s `vnext_b_gpio_write()`) found `PAUSE_OPEN`/`PAUSE_APPLY` firing repeatedly in
this exact configuration, from GPIO pin-mux, IO_MUX, and SPI-flash-adjacent MMIO addresses --
`esp32_timg_transport_pause()` is not UART/I2C-specific, it fires for *any* peripheral's lane-0
credit exhaustion. Every "zero VNEXT_B traffic"/"zero transport of any kind" phrase below should be
read as "zero UART-publication and zero I2C traffic (confirmed by this run's own counters), not
zero VNEXT_B lane-0 activity generally" -- left uncorrected in the body text below per this
project's convention of preserving history rather than silently rewriting it, but this note is the
authoritative correction. See EVIDENCE.md E114's "Stop Condition 1" section for the full producer
identification. This correction does not change E113's central, still-valid conclusion (the
UART-specific mechanistic hypothesis is refuted) -- it only corrects an overclaim about *why* it was
refuted.

### Correction 1 -- E112's reset counting mixed the expected once-per-boot-epoch APP-CPU-startup
reset (and, a second undercounted case, the one-time cold-boot `count=1 source=OTHER` line) into
the "storm" totals

The user is right: `SW_CPU_RESET_REGISTER` with `expected=app-cpu-startup` is the normal reset that
starts the APP CPU once per boot epoch, not a floor of unexplained resets. Re-deriving every count
in E112 from the preserved raw logs (`grep "ESP32 reset" | grep "expected=no" | grep
"source=SW_CPU_RESET_REGISTER"`, deduplicated by `count=+mask=+...+boot_epoch=`) -- and additionally
excluding the single per-run `count=1 mask=0x0f source=OTHER` line, which is also tagged
`expected=no` but is the one-time machine-init reset `qemu_system_reset_request()` fires at process
start, not a storm event either:

```text
                                       E112's original count   corrected storm count
sweep_v1_baseline_20s                        10                       9
sweep_v2_serial1000_20s                       1                       0
sweep_v3_i2c10ms_20s                          0                       0
sweep_v4_i2c100ms_20s                         0                       0
sweep_v5_noi2c_lightserial_20s                1                       0
sweep_v6_noi2c_heavyserial_20s               10                       9
confirm_v3_i2c10ms_60s run1/run2/run3       1/1/1                 0/0/0
confirm_v6_noi2c_heavyserial_60s run1/2/3   7/0/1                 6/0/0  (run2 invalid, see below)
```

The qualitative pattern E112 reported (Serial-frequency-dominant, I2C-secondary) survives this
correction and if anything sharpens: variant 3's "residual floor" of 1/1/1 disappears entirely --
it was 100% the expected startup reset, zero real storm activity at that cadence. Variant 6 remains
the only cell with any real storm signal in the confirmation set (run1=6), which the next section
addresses.

### Correction 2 -- variant 6 / run2 was an invalid execution, not a "0 resets" measurement

Confirmed directly: `confirm_v6_noi2c_heavyserial_60s_run2.err` contains exactly one `[ESP32
reset]` line for the whole 60s window (`count=1 mask=0x0f source=OTHER`, the cold-boot line) --
no `count=2 expected=app-cpu-startup` line ever appears, meaning the APP CPU never reached its own
startup reset at all. `confirm_v6_noi2c_heavyserial_60s_run2.out` shows `submissions=0
completions=0` for the entire run. E112's "7/0/1" is corrected to "6/invalid/0" -- two valid
60s measurements of variant 6 (6 and 0 storm resets), not three.

### Correction 3 -- the E112 sweep ran with `LASECSIMUL_CACHE_TRACE=1` active

Confirmed by re-reading the sweep commands: `LASECSIMUL_CACHE_TRACE=1` was set for every sweep run,
reactivating the same heavy per-event instrumentation this investigation's own E111/DECISION-013
work had gated off specifically because of its cost (E099: ~2s/line on this host). The sweep
numbers above are corrected for counting methodology but were still collected under that
instrumentation load and are not comparable 1:1 to a clean baseline. Baseline, variant 2, and
variant 6 have now been re-run with the trace off (next section) as the user asked.

### The decisive test: `LASECSIMUL_UART_DISABLE_CORE_NOTIFY` diagnostic control

Built exactly as specified: `uart_tx_effect_bh()` (`hw/char/esp32_uart.c`) keeps draining the local
TX FIFO/pacing/config-summary state unchanged, but skips every `writeReg()` call (the Core-facing
notification) when the gate is set -- so the guest-visible UART timing and FIFO occupancy are
untouched; only the VNEXT_B round-trip per byte is removed. Four always-on counters were added
first (`esp32_uart_diag_tx_bytes_total/events_published/max_batch` in `esp32_uart.c`;
`vnext_b_diag_lane0_exhaustion_count/last_exhaustion_virtual_ns` in `vnext_b.c`; `wait_max_ns[]`
added alongside the existing `wait_cumulative_ns[]` in `CPUState`), emitted as a single
`[LANE0_DIAG]` snapshot line per genuine watchdog-group expiry (gated by
`LASECSIMUL_LANE0_DIAG`, off by default) -- no per-byte logging anywhere.

**Bug found and fixed before the control test was meaningful**: the snapshot was originally gated
`if (s->id == 1)` (TIMER_GROUP1 only), on the assumption -- inherited from E111 -- that this storm
is exclusively a TG1 (Interrupt WDT) phenomenon. Re-checking E111's own reference evidence (PID
37004, `mttcg_causality/E110-hidden-cache-trace/pid_37004/lasecsimul_cache_trace.log.37004.log`)
shows `timg_wdt_expire` firing on **both** groups in the same run: 3 on `s->id==0` (TG0) vs. 1 on
`s->id==1` (TG1). A fresh run reproduced the same shape (3x TG0, 0x TG1 in one 15s window). E111's
"exclusively TG1" framing was itself built on a cherry-picked single instance, not the full picture
in its own evidence. The gate now fires for both groups (`timer_group=` field added to the line so
TG0/TG1 stay distinguishable); QEMU rebuilt and restaged, SHA256
`62BC6002FA1D8FC5B72DCCD9F05779F3D6EABD5A7F7E5DB6FF017B3E4BA1141C`
(`orchestrator/.ai/QEMU_RUNTIME.json` updated). Separately, and **not chased further in this
entry**: `intmatrix_line26` events in that same PID-37004 log show a near-even mix of source 20
(TG1WDT, 10x) and source 68 (cache-IA, 9x) -- and, more surprisingly, every single one of those 19
events (across the whole 4296-line session, not a truncated window) is a level=0 (deassertion),
never a level=1 (assertion). Neither observation blocks the hypothesis test below and both are
left as open, unexplained data points rather than a basis for further claims here.

15s smoke runs, N=1, VNEXT_B+MTTCG, Release, `LASECSIMUL_CACHE_TRACE=0`, `LASECSIMUL_LANE0_DIAG=1`,
dedup'd storm counts (`expected=no` + `source=SW_CPU_RESET_REGISTER`, cold-boot line excluded):

```text
firmware                          UART Core-notify   storm resets (15s)   lane0_exhaustion_count
                                                                            (last snapshot, of run)
variant 1 (baseline, I2C+heavy Serial)   ON                18                       44
variant 1 (baseline, I2C+heavy Serial)   OFF                9                        0
variant 6 (no I2C, heavy Serial only)    ON                 9                       29
variant 6 (no I2C, heavy Serial only)    OFF               15                        0
```

(Storm counts here are one unit higher than the "corrected storm count" definition above because
these single 15s smoke runs are reported as total unique `expected=no`+`SW_CPU_RESET_REGISTER`
lines directly from the tool output at the time; re-derivation with the exact same dedup command
used above gives baseline-ON=19->18 after removing one boundary double-count and variant6-OFF=16->15
for the same reason -- both readings point the same direction and neither changes the conclusion
below. Raw logs preserved under
`vnext_prototype/mttcg_causality/E112-factorial-firmware/smoke_lane0diag_fixed/`.)

**On variant 1 (baseline, I2C+UART mixed)**, disabling UART's Core-notify roughly halves the storm
(18 -> 9). Consistent with UART being *one* contributor, but this firmware also does I2C every
loop, so the reduction is confounded -- it does not by itself implicate UART specifically over I2C.

**On variant 6 (no I2C at all, Serial-only)**, which cleanly isolates UART as the *only* active
transport path, disabling UART's Core-notify did **not** reduce the storm -- it went from 9 to 15,
with `lane0_exhaustion_count=0` and `uart_tx_events_published=0` confirmed throughout (i.e. exactly
zero VNEXT_B lane-0 traffic occurred in that run, from any source, the whole 15s). The watchdog
groups (predominantly TG0 in both runs) still expired repeatedly and the storm was, if anything,
worse.

### Verdict on the stated hypothesis

**Refuted, as stated.** "O envio de um evento VNEXT_B por byte UART esgota a lane 0, paralisa
artificialmente CPU0 e permite que o TG1 Interrupt WDT expire" predicts the storm disappears (or at
minimum shrinks sharply) when UART's per-byte lane-0 traffic is removed entirely. On variant 6,
where that traffic was confirmed at exactly zero, the storm persisted at the same order of
magnitude. A single 15s run per cell does not establish the *quantitative* rate precisely (per the
task's own standing rule against declaring causality from one run), but refuting a hypothesis that
predicts near-elimination does not need repeated runs when the observed effect goes the wrong
direction on the very run designed to isolate it -- the mechanistic chain described (UART bytes ->
lane-0 exhaustion -> artificial CPU0 stop -> starved watchdog) is not what is driving this storm,
or is at most a minor contributor next to something else that remains active with zero VNEXT_B
traffic of any kind.

The mechanism confirmed independently in E111 (a genuine watchdog-group timeout reaching interrupt
line 26 and triggering ESP-IDF's panic/restart path) is unaffected by this finding -- what's
refuted is specifically last session's *initiating-cause* hypothesis (UART-driven lane-0
starvation), not the reset mechanism itself. The newly found TG0/TG1 mix (this entry, above) adds a
further complication to even that mechanism's description: TG0 is the *system* watchdog, and per
DECISION-011 it is the *only* group `esp32_timg_transport_pause()` ever compensates for transport
pauses -- a genuine TG0 expiry despite that compensation is more surprising than a TG1 expiry and
deserves its own look, but is out of scope for this entry.

### Next falsifiable hypothesis

**H4:** given zero VNEXT_B/lane-0 traffic still reproduces the storm on variant 6, the initiating
cause is more likely intrinsic to running this guest workload under MTTCG at all -- e.g. the raw
host-CPU cost of the guest's own instruction stream (`Serial.printf` formatting, `delay(1)`,
interrupt/timer handling) competing for host scheduling, independent of any Core round-trip.
**Falsifiable by**: the existing `CPU_WAIT_*` accounting (`LASECSIMUL_MWDT_ACCOUNTING=1`, not yet
exercised in this entry's runs -- `cpu0_wait_transport_*` read zero throughout because that gate
was off) run alongside `LASECSIMUL_LANE0_DIAG=1` on variant 6 with UART-notify OFF: if CPU0's
non-transport wait/residual time is large relative to wall time at the moment of each expiry
despite zero transport waits being open, that points at host-scheduling contention rather than any
transport mechanism; if CPU0's accounted time is fully consumed with no residual, the cause is
guest-side (execution cost or a genuine, correctly-detected slow loop), not a scheduling artifact.

Per the task's standing instruction, the section-12 2x3 matrix and B11/B12 remain blocked. No
functional change is made in this entry: E113 only corrects prior counting/scoping errors, adds
diagnostic-only instrumentation (a snapshot line + counters, no semantic change to any timer,
queue, credit, or transport behavior), and reports a refutation with its supporting data.

## E112 - Factorial firmware experiment: Serial/UART load, not I2C cadence, is the dominant driver
of the residual WDT storm; reset mechanism confirmed, initiating cause in the current workload now
substantially narrowed but not fully closed (2026-09-04)

Classification: `MEASURED_SIMULATOR`

**Correction (E113, 2026-09-04):** the counts below conflate the expected once-per-boot-epoch
APP-CPU-startup reset (and the one-time cold-boot line) into "storm" totals, and variant 6/run2
below is an invalid execution (APP CPU never booted), not a valid "0 resets" measurement. See E113
above for the corrected numbers and for the outcome of the diagnostic control this entry's own
"Next falsifiable hypothesis" (H1) called for. Left in place, uncorrected, for history.

Follows up on user correction to E111: the reset *mechanism* (genuine TG1 Interrupt WDT timeout,
mislabeled panic, `esp_restart_noos`/`esp_cpu_reset` cascade) was proven, but the *initiating
cause* in `guest_i2c_workload` was still hypothesis, not demonstrated. Two factual errors in E111
are corrected in place there (not deleted): `guest_i2c_workload/src/main.cpp` was already in this
repository, nothing needed "obtaining"; `DPORT_PRO/APP_INTR_STATUS_0` register modeling was
described as a still-open gap when it is in fact already implemented in the current tree
(`esp32_dport.c:456-459`, the 32.5.16 fix itself, committed and present). See the "Correction"
notes inline in E111 above.

### The firmware source (read in full before designing anything)

`guest_i2c_workload/src/main.cpp` (39 lines): `setup()` does one I2C write handshake to `0x3c`,
then `loop()` does, every iteration: `Wire.requestFrom(TARGET, 1, true)` (I2C read), `Serial.printf`
(formatted UART output, every single iteration), `delay(1)`. I2C and UART output are mixed in the
same ~1ms-period loop exactly as described in the correction -- confirmed by reading the file, not
inferred.

### Six firmware variants, each built, SHA-tracked, and preserved separately

`pio.exe` (`C:\Users\Administrator\.platformio\penv\Scripts\pio.exe`,
`PLATFORMIO_CORE_DIR=C:\SourceCode\LasecSimul\.piohome`) builds `guest_i2c_workload` in ~5-16s.
**Provenance note, disclosed rather than hidden**: PlatformIO/esptool's build embeds
non-deterministic content (most likely a build timestamp) -- rebuilding from *unchanged* source
produces a *different* SHA-256 every time. A first sanity rebuild (before this was known)
overwrote the canonical `merged.bin`/`firmware.elf` this whole investigation had been using
(`965DF6ED...`/`C00CA747...`) with a source-identical but differently-hashed rebuild. The exact
original bytes are not recoverable (no earlier copy existed outside `.pio/build`); the source
(`main.cpp`) was git-tracked and unmodified throughout, confirmed via `git status`/`git checkout --`
before and after, so this has no bearing on any causal conclusion, but it is recorded here plainly
rather than glossed over. Every variant below, including a fresh baseline rebuild, is preserved
under `vnext_prototype/mttcg_causality/E112-factorial-firmware/variant<N>_<name>/` with its own
`merged.bin`, `firmware.elf`, and `main.cpp.snapshot` -- the canonical project path is never relied
on again as the sole copy of anything. After all six variants, `main.cpp` was restored via
`git checkout --` (confirmed clean) and rebuilt once more so the working tree is left in a normal
state (final canonical `merged.bin` SHA-256 `1DA8BF731830B2D2D9CE6EDBB0EA208636A1DB2A79497A8DB0CC98D72864C76A`,
itself just another non-deterministic rebuild of the unchanged original source).

```text
variant  I2C cadence   Serial cadence         merged.bin SHA-256 (first 16 hex)
1 (baseline)  ~1ms     every read             48A73A455C6B4163...
2             ~1ms     every 1000 reads       BE760D2DE67E7C31...
3             ~10ms    every 100 reads        AAD2BFCD262ABACD...
4             ~100ms   every 10 reads         86825C753FB5AFCD...
5 (no I2C)    none     every 1000 reads (~1/s) 3B325871D4EF48F1...
6 (no I2C)    none     every read (heavy)     5C04A912CFE6E72C...
```

Variants 3/4 scale `SERIAL_EVERY` so the print rate stays ~1/s regardless of I2C period (100
reads x 10ms = 1s; 10 reads x 100ms = 1s), isolating I2C cadence from UART load. Variant 5/6 never
call `Wire.begin()` at all.

### Sweep (20s each, N=1, VNEXT_B+MTTCG, Release, `LASECSIMUL_CACHE_TRACE=1` +
`LASECSIMUL_SCALE_SCHEDULER_METRICS=1`)

```text
variant                          I2C     Serial        SW_CPU_RESET_REGISTER (20s)
1 baseline                       1ms     every read    10
2                                 1ms     every 1000    1
3                                10ms    every 100     0
4                               100ms    every 10      0
5 (no I2C)                      none     every 1000    1
6 (no I2C)                      none     every read    10
```

The pattern tracks Serial call *frequency* almost exactly, independent of whether I2C is present
at all: variant 1 (I2C+heavy Serial) and variant 6 (no I2C, heavy Serial) both show 10; variant 2
(I2C+light Serial) and variant 5 (no I2C, light Serial) both show 1. Variants 3/4 (I2C present but
slow, Serial light) show 0.

### Confirmation (3x60s each on the two decisive cells, N=1, VNEXT_B+MTTCG, Release, same env)

```text
variant 6 (no I2C, heavy Serial):     run1=7  run2=0  run3=1   SW_CPU_RESET_REGISTER
variant 3 (I2C 10ms, Serial light):   run1=1  run2=1  run3=1   SW_CPU_RESET_REGISTER
```

Zero orphan `qemu-system-xtensa.exe` after every run (checked each time). Two things are now
established with real 60s-scale evidence, not just the 20s sweep:

1. **Serial/UART load alone, with zero I2C traffic, reproduces the full-magnitude storm** (variant
   6 run1: 7 resets, same order of magnitude as the I2C-bearing baseline's 10/10/10/10). This
   directly falsifies "it's I2C polling cadence" as the sole or primary cause.
2. **Variant 6 is markedly less deterministic than the I2C-bearing baseline** (7, 0, 1 vs.
   baseline's rock-solid 10, 10, 10, 10 across four separate measurements in E110/E111). Removing
   I2C doesn't just lower the rate somewhat -- it removes whatever was making the baseline so
   tightly reproducible. **I2C is not the dominant factor, but this variance is evidence it is not
   fully inert either** -- the honest reading is "Serial dominates, I2C is a secondary
   contributor", not "I2C is irrelevant".
3. **Variant 3 (I2C present but slow, Serial light) is itself remarkably stable at a low rate**
   (1/1/1) -- lower than baseline by ~90%, but not zero. Whatever combination of reduced I2C
   cadence and reduced Serial verbosity variant 3 represents does not eliminate the mechanism,
   only suppresses it heavily and consistently.

### Scheduler-metrics correlation attempt -- inconclusive, and why

`Scheduler::MetricsSnapshot::maxSettleNanoseconds`/`maxSettleAtNowNs` (32.5.18/32.5.19's own
technique) was wired into `vnext_b_production_scale_test.exe` behind a new, off-by-default
`LASECSIMUL_SCALE_SCHEDULER_METRICS` env var (`session.scheduler().setProfilingEnabled(true)` at
session start, printed as `SCHEDULER_METRICS session=... maxSettleNanoseconds=... maxSettleAtNowNs=...`
per session at the end of the run -- core/test/core/mcu/VnextBProductionScaleTest.cpp, rebuilt into
the Release harness used throughout this entry). **This metric tracks only the single largest
settle call of the whole run, not a history** -- a real limitation for correlating against *several*
resets in one run. Observed: in two of the three variant-6 confirmation runs,
`maxSettleAtNowNs=0` (the largest settle happened at virtual-time zero, i.e. during boot, before
any of that run's resets) -- meaning the global max is dominated by a boot-time settle spike
unrelated to the mid-run WDT expirations, not usable evidence either way for those runs. The one
run where `maxSettleAtNowNs` was non-zero and mid-run (variant 1 sweep, ~7.7s) did not land
immediately before any of that run's three captured `timg_wdt_expire` timestamps (1.89s, 4.33s,
6.82s) -- it landed *after* the closest one. **This single-max metric, as currently exposed, cannot
confirm or refute the settle-precedes-WDT hypothesis with the data collected here.** A real test
would need a small history (last-N settle durations with their `nowNs` position, not just the
global max) correlated against every `timg_wdt_expire` in the same run -- not implemented, this
entry does not claim the negative or the positive on this specific sub-question.

### Why no functional correction is implemented in this entry

The evidence narrows "which firmware behavior" (Serial-dominant, I2C-secondary) but does not yet
identify *which specific mechanism in this fork's UART model* creates the critical-section
collision, nor confirm the Scheduler-settle hypothesis directly (see above). Per the task's
standing constraints: no change to `wdt_time_scale`, the arbiter, the heartbeat, pacing, queues,
virtual timing, or transport is justified by evidence gathered so far. Implementing a UART-model
fix without first identifying the specific collision (e.g., which register read/write inside
`esp32_uart.c` this fork routes through a slow Core round-trip, analogous to `readReg()`/
`writeReg()` for GPIO/I2C/ADC in 32.5.18-32.5.22) would be exactly the kind of speculative fix the
task explicitly prohibits ("Se for uma corrida... corrigir somente o estado/ownership
comprovadamente compartilhado de forma insegura").

### Next falsifiable hypothesis for whoever picks this up

**H1 (primary, narrowed from E111's H):** this fork's UART/`esp32_uart.c` model routes some
register access inside `Serial.printf()`'s hot path through a synchronous Core round-trip (the
same class of mechanism `readReg()`/`writeReg()` represent for LEGACY, or VNEXT_B's own response-
slot wait for whichever registers it doesn't handle purely locally), and at ~1000 calls/s this
firmware's Serial load produces enough of these round-trips to make a `Scheduler::settleUntilStableLocked()`
collision much more frequent than the July investigation's ADC-focused firmware ever exercised.
**Falsifiable by**: instrumenting UART MMIO reads/writes in `hw/char/esp32_uart.c` with the same
`cache_trace_record()`-style pattern already validated in this fork (gated behind
`LASECSIMUL_CACHE_TRACE` or a new sibling gate), and checking whether any of them route through a
round-trip mechanism at all, vs. being handled synchronously/locally with no Core dependency (in
which case H1 would be refuted and the collision must be elsewhere -- e.g. in the I2C path that
variant 6 doesn't exercise at all, yet still shows a reduced-but-nonzero storm, suggesting a
Serial-adjacent but not Serial-exclusive mechanism).

**H2 (secondary, explains variant 6's high variance and variant 3's stable-but-nonzero floor):**
I2C is a real, independent, smaller contributor to the same collision class (not merely
"irrelevant, noise from removing it") -- worth a repeat of variant 2 (I2C present, Serial reduced)
at 3x60s to see whether it, like variant 3, settles into a stable low rate or shows variant-6-style
variance; this entry only ran variant 2 once (20s).

**H3 (deferred, needs its own careful design):** the Scheduler-metrics correlation above needs a
bounded history (not just the global max) before it can confirm or refute whether
`settleUntilStableLocked()` specifically (vs. some other Core-side or QEMU-side source of delay)
is the proximate mechanism for *this* firmware's collisions.

Per the task's explicit instruction, the section-12 2x3 matrix and B11/B12 remain blocked until
this line of investigation (H1 in particular) separates I2C, Serial, and Scheduler contributions
more precisely than this entry's factorial sweep alone can.

## E111 - SW_CPU_RESET_REGISTER storm root-caused: genuine TIMER_GROUP1 Interrupt WDT timeout under
MTTCG, already diagnosed and partially mitigated by a prior investigation; not VNEXT_B-specific;
no safe further fix available within current constraints (2026-09-04)

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`

Executes the causality investigation requested after E110, restricted to: identify the producer of
the residual `SW_CPU_RESET_REGISTER` sequence and fix the minimal proven cause. Explicitly out of
scope and untouched: the section-12 2x3 matrix, B11/B12, `wdt_time_scale`, the VNEXT_B arbiter,
the heartbeat, pacing, queues/credits, virtual timing, transport. Evidence preserved under
`vnext_prototype/mttcg_causality/E110-hidden-cache-trace/` and
`vnext_prototype/mttcg_causality/E111-wdt-storm-root-cause/`.

### Errata to E110

E110's framing ("a separate, software-driven APP-CPU reset-register write loop") was a premature
generalization from a single instrumented run. This entry supersedes that characterization with a
fully evidenced one below. **E110's underlying measurements (7-8 resets/60s, the
Debug/Release build divergence, the diagnostic-string bug) remain valid and are not retracted** --
only the causal interpretation of *why* the resets happen is corrected here.

### Phase 0 -- preservation

Before any edit: `git status`/`git diff` captured for both repos
(`vnext_prototype/mttcg_causality/E111-wdt-storm-root-cause/phase0_git_status.txt`,
`phase0_qemu_source_status.txt`); zero orphan `qemu-system-xtensa.exe` confirmed (`tasklist`); the
two hidden-instrumentation files named in the task brief (PID 33576 control, PID 37004
instrumented, from E110's runs) preserved with their companion `_UNEXPECTED_RESET` and
(previously undocumented) `xtensa_exc_trace`/`xtensa_exc_trace_FIRST` files, 8 files total, SHA-256
recorded, under `vnext_prototype/mttcg_causality/E110-hidden-cache-trace/pid_{33576,37004}/`.

### The critical discovery, confirmed exactly as described in the task brief, plus one more

`hw/misc/esp32_dport.c` had `#define CACHE_TRACE_ENABLED 1` -- unconditionally active in every
build of this fork, including the canonical `dev_qemu_runtime` used for every measurement since
this whole investigation began. It writes 1.5-2MB+ per QEMU process to `C:/tmp` on every launch
(`lasecsimul_cache_trace.log.<pid>.log`, plus a `_UNEXPECTED_RESET.<pid>.log` capture on the first
reset beyond the expected app-cpu-startup one). **A second, previously undocumented instrumentation
block in `target/xtensa/exc_helper.c` (`[XTENSA-EXC-TRACE]` and `[XTENSA-PC-WATCH]`) was equally
unconditional**, writing `lasecsimul_xtensa_exc_trace.<pid>.log` and
`lasecsimul_xtensa_exc_trace_FIRST.<pid>.log` on every launch. Both blocks carry extensive
`.spec archive/legacy-v2/lasecsimul.spec` section-32.5.x provenance comments identifying them as
temporary instrumentation from an earlier, independent investigation into the same class of
problem (see below) -- "sera revertido apos a causa raiz ser confirmada", never actually reverted
or gated. `LASECSIMUL_XTENSA_PC_SAMPLER` (a separate, third mechanism, `hw/xtensa/esp32.c`) was
already correctly gated from R2 (E109) and is unaffected by this entry.

### The decisive lead: a prior, exhaustive, already-published investigation of this exact phenomenon

`C:\SourceCode\LasecSimul\.spec\archive\legacy-v2\lasecsimul.spec` sections 32.5.1 through 32.5.22
(dated 2026-07-26/28, read in full before any further action here) document a 22-round investigation
into an ESP-IDF-reported "Guru Meditation Error (Cache error)" panic-and-reboot cascade under this
exact fork's MTTCG mode, using the LEGACY transport (this predates VNEXT_B/ABI v5). Summary of its
conclusion, mechanistically confirmed against real ESP-IDF v5.5.4 source (cloned and disassembled
against the actual firmware binary, not inferred):

1. `EXCCAUSE=7`/"Cache error" is a **synthetic ESP-IDF label**, never a real CPU exception in this
   emulator (confirmed by instrumenting the only two real `EXCCAUSE`-writing sites in
   `target/xtensa/`, across ~250 tracked boots including every reproduced panic: never fires).
2. The real trigger is **CPU interrupt-matrix line 26**, shared in this ESP-IDF build between the
   cache-illegal-access interrupt and the TIMER_GROUP1 Interrupt Watchdog. ESP-IDF's own
   disambiguation logic (`get_int_status_tg1wdt` in `highint_hdl.S`) reads
   `DPORT_PRO/APP_INTR_STATUS_0_REG` bit 20 to tell them apart -- **a register this fork did not
   model at the time of the July investigation** (32.5.12 confirmed by repo-wide grep on that
   date's tree), so it always read zero and ESP-IDF always concluded "not the watchdog",
   mislabeling every genuine TG1 Interrupt WDT expiration as "Cache error" regardless of the real
   cause. **Correction (E112, 2026-09-04): this register IS modeled in the current tree**
   (`hw/misc/esp32_dport.c:456-459`, the compatibility fix 32.5.16 itself implemented and
   committed) -- the original text above described the pre-fix gap as if it were still open. It
   is not; ESP-IDF's own panic label should now correctly read "Interrupt wdt timeout" rather
   than "Cache error" for this exact mechanism. This does not change the `reset_cpu_sw`/
   `esp_cpu_reset`/`esp_restart_noos` causal chain below (that is a QEMU-fork-native reset-source
   classification, unrelated to what ESP-IDF prints to UART), only the historical framing of *why*
   line 26 was ever mislabeled. This session did not capture raw UART panic text to directly
   confirm the corrected label prints today; that remains open (see E112's falsifiable next step).
3. Direct instrumentation (32.5.13) proved the line-26 activations in real failing cycles come from
   source 20 (`ETS_TG1_WDT_LEVEL_INTR_SOURCE`), not source 68 (cache-IA) -- **the watchdog expires
   genuinely**.
4. The underlying reason it expires: `readReg()`/`writeReg()` (LEGACY's synchronous MMIO
   round-trip to the Core for any register whose value reflects the electrical simulation)
   occasionally takes up to ~1s of real wall-clock time, most often because
   `Scheduler::settleUntilStableLocked()` was holding `Scheduler::m_mutex` for the length of a slow
   Newton-iteration settle. When this coincides with a firmware critical section
   (`portENTER_CRITICAL`, interrupts disabled -- confirmed via real ESP-IDF driver source,
   `adc_oneshot_read()` in the original firmware, but the pattern is generic to any MMIO register
   touched inside any critical section, confirmed also via GPIO in 32.5.21), interrupts stay
   disabled on that core for far longer than the Interrupt WDT's budget (typically 300-400ms in
   Arduino-ESP32), and it fires for real.
5. **Two fixes were implemented, validated, and committed** as a result: (a) `Scheduler::markDirty()`
   made non-blocking (`try_lock` + a separate `m_pendingDirty` set merged in later) plus
   linearizable wakeups via an atomic generation counter, replacing `condition_variable`s that had
   a real lost-wakeup race (Core repo, commit `54b561a` region); (b) **`hw/timer/esp32_timg.c` gained
   `wdt_time_scale`**, multiplying only the Interrupt WDT's armed interval under `mttcg-realtime`
   (default/cap 100x, `LASECSIMUL_ESP32_WDT_SCALE=1` for literal-timing rollback) -- present in the
   current tree exactly as documented (`TIMG_INTERRUPT_WDT_REALTIME_SCALE_DEFAULT` = `_SCALE_MAX` =
   100, confirmed by reading the source and by every log this entire session printing
   `interrupt-wdt scale=100`). **This is precisely the mechanism `DECISIONS.md`/`TEST_GATES.md`
   already protect ("cap of 100", DECISION-004) -- it was not a new discovery, it is the reason that
   freeze exists.** With both fixes, the July investigation's own final validation battery reached
   0/200 GPIO-failure cycles (from a 4.5% baseline), using its own ADC/analogRead()-based firmware
   over LEGACY transport.

### This session's evidence: the identical mechanism, confirmed three independent times, on the current codebase

The preserved PID 37004 evidence (E110, VNEXT_B, before the gate existed) and a fresh,
gate-controlled reproduction on the rebuilt binary (PID 38484, VNEXT_B, `LASECSIMUL_CACHE_TRACE=1`
explicitly set) both show the **exact same three-event chain**, `~150-215ms` apart each time:

```text
PID 37004 (E110, pre-gate):  timg_wdt_expire@1.976s -> intmatrix_line26(source=20)@2.115s -> reset_cpu_sw@2.330s
PID 38484 (E111, post-gate): timg_wdt_expire@1.767s -> intmatrix_line26(source=20)@1.905s -> reset_cpu_sw@2.089s
```

`reset_cpu_sw`'s `writer_pc=0x40083e7a` symbolizes (via
`.piohome/packages/toolchain-xtensa-esp-elf/bin/xtensa-esp32-elf-addr2line.exe -p -f -i -a -C`
against this session's `firmware.elf`, SHA-256
`C00CA7478B454EEC7BA63B95E4C1C8CA652043283FB5E8FBBF40FC09E6DD3420`) to
`soc_ll_reset_core` (`hal/esp32/include/hal/soc_ll.h:48`) inlined into `esp_cpu_reset`
(`esp_hw_support/cpu_util.c:40`), reached from `esp_restart_noos` (`system_internal.c`), reached
from the panic handler's `panic_abort()` (`panic.c:408`, confirmed by symbolizing the
`STORE_PROHIBITED_CAUSE`/`EXCVADDR=0` self-fault `panic_abort()` deliberately triggers as its own
abort mechanism, captured in the same PID 37004 exception trace) -- exactly the software restart
sequence sections 32.5.12/32.5.13/32.5.22 already mapped end to end, now confirmed present, byte-
for-byte, in this session's VNEXT_B measurements.

### A single LEGACY comparison, and its real limits (corrected, E112)

A single targeted comparison (Fase 7 item 7's explicit allowance: "fazer somente uma comparação
dirigida", not the full matrix): the identical firmware, Release binary, N=1/60s, MTTCG, run under
LEGACY (`LASECSIMUL_MCU_TRANSPORT` left unset) instead of VNEXT_B --
`e111_legacy_control_release_n1_20260904_144421.err`: **2 `SW_CPU_RESET_REGISTER` resets**, same
`transport=legacy`, confirmed `tcg,thread=multi`. The same phenomenon reproduces under LEGACY with
the same firmware -- the mechanism itself is transport-agnostic, not invented by VNEXT_B.

**Correction (E112): the original text here overclaimed.** One N=1 sample per transport proves the
*mechanism* is common to both, but, as this entry's own next paragraph already said, it is far
below the >=20-unique-reset minimum this project's own rigor rules require before comparing
*rates* -- it does **not** establish that VNEXT_B carries no additional amplification on top of
the common mechanism. That question was left open by this entry and is still open after E112 (see
below): E112's factorial sweep varied firmware load, not transport, so it cannot speak to
transport-specific amplification either. Whoever revisits this should pair each firmware variant
against both transports before drawing a transport conclusion.

### Diagnostic hygiene fix (Fase 1/2, unconditionally worth keeping regardless of the above)

Both instrumentation blocks gated behind a single `LASECSIMUL_CACHE_TRACE` variable (off by
default), thread-safe via `g_once_init_enter`/`g_once_init_leave` (matching R2's established
pattern, `mwdt_accounting_enabled()` in `softmmu/vnext_b.c`):
`hw/misc/esp32_dport.c`'s `cache_trace_enabled()` guards `cache_trace_record()` and
`cache_trace_capture_window()` (the two ring-touching/file-writing entry points; `cache_trace_dump()`
and `esp32_cache_trace_reset_event()`/`esp32_cache_trace_generic_event()` are covered transitively).
`target/xtensa/exc_helper.c`'s `lasecsimul_diag_trace_enabled()` (same variable) guards
`xtensa_exc_trace_record()` and `HELPER(trace_watched_pc)`. `run_production_mwdt.ps1` and
`run_regression.ps1` both add `LASECSIMUL_CACHE_TRACE` to their explicit env-hygiene clear lists.

**Verified both directions, by PID, not by inference**: gate absent (PID 6540) -> zero files with
that PID anywhere under `C:/tmp` after the run; gate `=1` (PID 20292) -> `lasecsimul_cache_trace.log.20292.log`
created. No functional/device/watchdog/reset-semantic behavior changed -- confirmed by rebuilding
QEMU (UCRT64, capped parallelism per DECISION-010) and re-running the full regression suite on the
new binary: `run_regression.ps1 -Transport VNEXT_B -ExecutionMode MTTCG` **13/13 PASS twice**
(`e111v1`, `e111v2`), `-Transport LEGACY -ExecutionMode MTTCG` **13/13 PASS** (`e111l1`). New QEMU
SHA-256 `F22706B13E7860F211D1F015D10AFD1335AC53BFC767C3E3656BDCE6745D2FF6` (superseding
`A0BEAAE014ECB02DCF82CB9B4920BF478592D891C8524417CEF12A4CA0B4804D`; the old SHA is not reused per
the task's own instruction, since the binary genuinely changed).

### Testing the hidden-tracing-as-perturbation hypothesis (Fase 3) -- refuted

Three independent clean runs (gate confirmed off by PID, zero orphan processes after each,
~5s cooldown between runs, Release binary, N=1/60s, VNEXT_B+MTTCG, real firmware):

```text
run                          SW_CPU_RESET_REGISTER   source=OTHER
phase3_clean_run1            10                       1
phase3_clean_run2            10                       1
phase3_clean_run3            10                       1
phase5_traced_repro (gate=1) 10                       1
```

**Perfectly deterministic across all four runs** (not the probabilistic ~4.5%/cycle character the
July investigation found with its own ADC-only firmware) -- and *higher*, not lower, than the
7-8/60s this same firmware showed in E110's original (unconditionally-traced) measurements. This
refutes interpretation A from the task brief ("if 3/3 clean runs show zero unexpected resets,
treat the hidden trace as the perturbing candidate") outright: the hidden tracing was not
inflating the count, and removing it did not reduce it. Per interpretation B, the investigation
correctly proceeded to the causal chain above rather than stopping here.

### Why this session's rate (10/60s, deterministic) differs from the resolved investigation's rate -- SUPERSEDED by E112

This entry originally speculated here without reading `guest_i2c_workload`'s own source (it is
*in this repository*, `vnext_prototype/guest_i2c_workload/src/main.cpp` -- there was nothing to
"obtain"), and proposed a firmware-source falsifiable hypothesis rather than testing it. **E112,
immediately below in this log, runs the actual factorial experiment** (I2C cadence x Serial
verbosity x no-I2C controls) this section should have started with. Its headline finding: Serial/
UART load, not I2C polling cadence, is the dominant driver -- see E112 for the full result.

### Why no functional correction was implemented in this entry (still true after E112)

Per the task's explicit constraints and its own stop condition 2 ("bloqueio concreto documentado
com a próxima hipótese falsificável"):

- `wdt_time_scale` is already at its DECISION-004-frozen cap (100); raising it is explicitly
  forbidden by this task and by the standing decision.
- The Scheduler-side mitigation this exact mechanism already received (non-blocking `markDirty()`,
  linearizable wakeups) is already present in the current codebase -- there is no unapplied fix
  sitting in the prior investigation's notes to simply reapply.
- E112 identifies Serial/UART load as the dominant factor but does not identify a specific,
  provably-unsafe race in this fork's UART model to fix -- see E112's own "why no fix yet" section
  for what evidence is still missing before a firmware-side or QEMU-side change would be justified.

### Orphan processes, log volume

Zero orphan `qemu-system-xtensa.exe` after every run in this entry (`tasklist` checked after each).
Log volume for the gated-off runs: unchanged from E110 (the diagnostic instrumentation removal
does not touch `[LasecSimul]`-prefixed production logging at all).

## E110 - B10-R: SW_CPU_RESET_REGISTER storm persists post-R3, now shown not to be MWDT-driven (2026-09-04)

Classification: `MEASURED_SIMULATOR`

Executes `PLAN_MTTCG_VNEXT_B_CAUSALITY.md` section 13's B10-R smoke test: N=1, `LASECSIMUL_MCU_TRANSPORT=VNEXT_B`,
MTTCG, real firmware (`guest_i2c_workload/merged.bin`), traces off, control vs instrumented
(`LASECSIMUL_MWDT_ACCOUNTING`) compared, 60 s window. Binary:
`vnext_b_production_scale_test.exe`, QEMU SHA `A0BEAAE014ECB02DCF82CB9B4920BF478592D891C8524417CEF12A4CA0B4804D`
(unchanged since E109). Logs: `vnext_prototype/production_mwdt_runs/b10r_*_release_n1_*.err`.

### Two build-process findings, neither an R3 regression, both worth carrying forward

1. **A pre-existing, cosmetic diagnostic-string bug in `McuController.cpp`'s execution-mode log
   line.** The very first B10-R attempts (Debug build) all logged
   `execution=single-realtime (LASECSIMUL_QEMU_TCG_THREAD=single override, no -icount)` with
   `LASECSIMUL_QEMU_TCG_THREAD` confirmed absent from the process environment by three independent
   methods (`Get-ChildItem Env:`, a `cmd /c echo`, and comparison against `mcu_controller_real_qemu_test.exe`
   run identically, which correctly logged `execution=mttcg-realtime`). The actual QEMU argv in
   every one of these "single-realtime"-labelled runs contained `-accel tcg,thread=multi` --
   confirmed real MTTCG despite the misleading label. The label text and the actual `spec.args`
   content it is supposed to reflect have diverged; not yet root-caused, not fixed here (cosmetic,
   does not affect QEMU's actual launch), but **do not trust this specific log line's
   single-vs-mttcg claim without cross-checking the `final argv:` line's own `-accel` value** until
   it is.
2. **`core/build/Release/vnext_b_production_scale_test.exe` was stale relative to today's R0-R3c
   source** (06:48 timestamp, predating the day's changes) and had to be rebuilt
   (`cmake --build core/build --config Release --target vnext_b_production_scale_test`) before any
   B10-R number here can be trusted. `run_production_mwdt.ps1` hardcodes the Release path; nothing
   in today's R0-R3c work had exercised or rebuilt it before now. The reconfigure this triggered
   partially regenerated `core/build-canon/_deps` (~230 MB, a stale `FetchContent` source-cache
   path baked into `core/build`'s own `CMakeCache.txt` from before the Fase A promotion) as a side
   effect -- harmless, but explains why that directory reappeared after being removed in this
   session's disk-space cleanup.
3. **Debug vs Release genuinely diverge in reproducing the storm** at the same 60 s duration, same
   firmware, same QEMU binary, confirmed-identical `-accel tcg,thread=multi`: Debug builds (both
   control and instrumented arms) showed only the cold-boot reset pair, zero
   `SW_CPU_RESET_REGISTER`; Release builds (both arms, this entry's authoritative data) showed 7
   `SW_CPU_RESET_REGISTER` resets each. Consistent with a timing-sensitive race (Debug's much
   heavier instrumentation/lack of optimization shifts the window), which is itself mildly
   supportive of the plan's own MTTCG-concurrency-timing hypothesis space -- not confirmatory,
   just noted. **Use the Release build for any further B10-R-adjacent or matrix work**, matching
   `run_production_mwdt.ps1`'s own convention.

### The storm itself: still present, ~90% smaller than E108, and now shown not to be watchdog-driven

Release-build control arm (`b10r_control_release_n1_20260904_142212.err`) and instrumented arm
(`b10r_instrumented_release_n1_20260904_142447.err`), both N=1/60 s/VNEXT_B/MTTCG/real firmware:

```text
                control   instrumented
raw resets         8           8
  source=OTHER     1           1   (cold boot, expected)
  source=SW_CPU_RESET_REGISTER  7  7   (identical count -- instrumentation changes nothing)
```

Down from E108's original N=1 finding of `ESP32_RESETS=89` (all `SW_CPU_RESET_REGISTER`) at the
same duration -- roughly a 92% reduction after R3's arbiter+heartbeat work -- but **not
eliminated**. Both `boot_epoch` and repeated `expected=app-cpu-startup`/`source=SW_CPU_RESET_REGISTER`
tags across resets show the APP CPU (CPU1) repeatedly re-entering its own startup/reset sequence
within a single QEMU session (`boot_epoch` climbs 1->2->3 within the 60 s window in both arms).

**Only one `[MWDT_ACCOUNTING] event=first_actual_stage_expiry` fired in the entire 60 s
instrumented run, despite 7 `SW_CPU_RESET_REGISTER` resets.** Per the plan's own explicit
instruction ("não chamar todo `SW_CPU_RESET_REGISTER` de watchdog sem evidência do estágio MWDT"),
this is direct evidence that the storm is **not primarily a watchdog/MWDT-stage phenomenon** --
it is a separate, software-driven APP CPU reset-register write loop. The one stage-expiry sample
that did fire: `wait_invalid_transitions=0` both lanes (valid), `host_wall_ns=72000` /
`virtual_wall_ns=79900` (close, no `VM_STOPPED` divergence), B4 sum-sanity passes for both lanes.
Both lanes show `category=residual outlier=1` (lane0 window_share=0.3889 vs baseline
median=0.1162, threshold=0.2661; lane1 window_share=1.0000 vs median=0.2025, threshold=0.5179),
`transport`/`cpu` categories not outliers. This is **directionally consistent with
`starvation_compatible`** in the plan's own B8 taxonomy, but on a single sample against a
requirement of >=20 unique resets per configuration -- classify as **`inconclusive`, amostra
insuficiente**, not a finding. Note also `host_wall_ns=72000` (72 microseconds) is far below
`GetThreadTimes()`'s practical resolution (~15.6 ms ticks on Windows), so `thread_cpu_ns=0` for
both lanes in this one sample is likely a measurement-floor artifact, not evidence of zero CPU
delivery -- flagged so a future session doesn't over-read it.

Zero orphan `qemu-system-xtensa.exe` processes after either arm (`tasklist` clean both times). Log
volume: 22 lines (control), 33 lines (instrumented) -- both far under the "poucas linhas por
sessão" target.

### B10-R status and next-step guidance

B10-R's own smoke-test acceptance criteria (log volume, `wait_invalid_transitions==0`, B4 sanity,
`host_wall_ns`/`virtual_wall_ns` proximity for the one sampled window) are met. It surfaced a
substantive result the plan explicitly wants surfaced rather than smoothed over: **the residual
SW_CPU_RESET_REGISTER instability is confirmed still present post-R3, confirmed not primarily
MWDT-stage-driven, and confirmed unaffected by the accounting instrumentation itself.** Before
resuming the section-12 2x3 causal matrix or B11/B12, whoever picks this up next should decide
whether to root-cause the APP-CPU restart-loop mechanism directly (it fires far more often than
the one MWDT sample suggests, so it needs its own, non-MWDT-shaped instrumentation) rather than
folding it into the existing MWDT wait-accounting framework, which this run shows mostly does not
capture it.

## E109 - PLAN_MTTCG_VNEXT_B_CAUSALITY R0-R3c executed; B0.1 closed (2026-09-04)

Classification: `SOURCE_PROVEN` + `MEASURED_SIMULATOR`

Executes `orchestrator/.ai/PLAN_MTTCG_VNEXT_B_CAUSALITY.md` phases R0 through R3c (not the
section-12 2x3 causal matrix, and not B10-R/B11/B12 -- both remain open, see `NEXT_ACTION.md`).
Run directory: `vnext_prototype/mttcg_causality/20260904-134731/` (manifests for R0/R1/R2).

### R0/R1/R2 - baseline, explicit transport/mode, thread-safety hygiene

- R0 froze both trees' `git status --short`/`git diff`/`rev-parse HEAD` and the staged runtime
  SHA before any edit (`r0_baseline_manifest.json`).
- R1: `vnext_prototype/run_regression.ps1` gained `-Transport {LEGACY,VNEXT_B}` and
  `-ExecutionMode {MTTCG,SINGLE_REALTIME,ICOUNT}` (both `ValidateSet`, default LEGACY/MTTCG) plus
  `-RunId`; every run now prints `TRANSPORT`/`EXECUTION_MODE`/`AFFINITY`/`QEMU_RUNTIME_SHA256` in
  its header and logs to `regression_runs/<Transport>_<ExecutionMode>_<RunId>/`.
  `McuDebugLaunchTest.cpp` gained unit coverage (no real QEMU) for both dimensions being
  correctly diagnosed and mutually consistent (`execution=mttcg-realtime`/`single-realtime`, no
  stray `-icount`, `transport=legacy` vs `transport=vnext_b`).
- R2: every `static int cached = -1` lazy-init site identified by the plan
  (`mwdt_accounting_enabled()` in `softmmu/cpus.c` and `softmmu/vnext_b.c`,
  `vnext_trace_enabled()` in `softmmu/vnext_b.c`, `esp32_mwdt_accounting_enabled()` in
  `hw/timer/esp32_timg.c`) converted to `g_once_init_enter`/`g_once_init_leave`, mirroring the
  fork's own existing pattern in `accel/tcg/cpu-exec.c`'s `vnext_exec_probe_enabled()`. Diagnostic
  only -- no functional change. All 3 gates (probes/PC-sampler/MWDT-accounting silence when
  unset) confirmed empirically via `vnext_b_production_scale_test.exe` invoked directly (the
  production wrapper script unconditionally clears those env vars, so it is the wrong tool for
  gate testing). `run_regression.ps1 -Transport LEGACY -ExecutionMode MTTCG`: 13/13 (one run,
  `r2l1`, showed `waitForSynch TIMEOUT (fila cheia, HOST PROCESS-HEALTH BACKSTOP)` immediately
  after two heavy VNEXT_B regressions with no cooldown; marked `INVALID_HOST_LOAD` per the plan's
  own rigor and confirmed by two clean re-runs, `r2l2`/`r2l3`, both 13/13 on a quiet host -- this
  exact pattern recurred later in R3c, see below).

### R3a/R3b - temporal-merge arbiter

- New pure component `core/src/mcu/qemu/VnextBArbiter.{hpp,cpp}`:
  `selectNextLaneEvent(peeks, nowNs)` merges every lane's head by `(timestampNs, laneIndex)`,
  never by `lane_sequence` (which is only monotonic within one lane), and reports `ready` only
  when `timestampNs <= nowNs`, giving the caller the next wake boundary otherwise. Fully unit
  tested (`vnext_b_arbiter_test`) against the plan's own fixture
  (lane0={120,140}, lane1={100,130} -> global order 100/L1,120/L0,130/L1,140/L0), tie-break,
  future-event non-consumption, boundary equality, and empty/mixed-empty lanes.
- `VnextBAttachment` gained `peekLane`/`laneHasPending`/`hasPendingLaneEvents` (acquire-only,
  never advance `read_seq`, never signal credit) and a test-only synthetic lane-event publisher,
  letting `vnext_b_attachment_test` build deterministic two-lane interleaving fixtures that real
  QEMU timing cannot dictate precisely enough to construct.
- `McuComponent::pollAndDispatchPendingEvents()`'s VNEXT_B branch rewritten: peek every lane,
  arbitrate, defer-if-future via `schedulePollAt`, budget-bounded consume-and-dispatch
  (`kMaxEventsPerTurn=256`), safe-acknowledge with a rescan. Two real bugs found and fixed while
  wiring this in:
  1. `latestVirtualTimeNs()` never advanced for VNEXT_B (the getter only read the legacy field) --
     added `m_latestVnextBVirtualTimeNs`, combined via `max()` at read time.
  2. Critical: `stamp()` runs with `Scheduler::m_mutex` already held; the new code's first version
     called `Scheduler::scheduleAt()`, which takes the same non-recursive mutex, producing
     `std::system_error: resource deadlock would occur`. Fixed by threading a
     `bool schedulerLockHeld` parameter through `schedulePollAt`/`scheduleNextPoll`/
     `pollAndDispatchPendingEvents`, with `stamp()`'s direct call passing `true` and using
     `Scheduler::scheduleEventUnlocked()` in that branch.
- Validated with `vnext_b_production_scale_test`: 52/52 I2C submissions/completions, zero
  anomalies, sustained real activity under VNEXT_B+MTTCG. Preserved per the user's explicit
  instruction as independent validation of the arbiter, separate from R3c below -- the arbiter
  orders existing activity; the heartbeat proves advancement when none exists.

### R3c - heartbeat watermark (user-specified architecture, separate phase from R3b)

While building R3a/R3b's synthetic-vs-real test coverage, `mcu_scheduler_pacing_sync_real_qemu_test`
(deliberately blank/erased flash -- no real firmware, by design, to test Scheduler pacing
independent of firmware fidelity) stalled for the entire 90 s window under VNEXT_B+MTTCG
(`longestMcuGapMs=90009`). Root cause: VNEXT_B has no mechanism analogous to LEGACY's SIM_FREQ
heartbeat to keep pacing alive when the guest is legitimately silent (WFI, no GPIO/I2C activity) --
the blank flash's ROM bootloader fails after ~8 MMIO writes and then genuinely produces zero lane
events, which is exactly the scenario this test exists to prove pacing survives. The user was
asked how to proceed (reuse a firmware-driven heartbeat, use real firmware to hide the gap, or
implement a real VNEXT_B heartbeat) and specified, precisely: implement a monotonic virtual-time
watermark, conceptually equivalent to LEGACY's `simu_event()` (`simuliface.c:912`), that feeds
**only** `McuComponent::pacingPositionNs()` -- never `latestVirtualTimeNs()`, never the arbiter,
never electrical dispatch, never the Scheduler directly, never watchdog -- and must never be
reused from `artifact_progress_ns` (an operation counter, not a timestamp) or published as a
synthetic lane event.

Implemented exactly as specified:

- QEMU side (`softmmu/vnext_b.c`): ABI v1.1 field `artifactVirtualTimeNs` appended to
  `VnextControl`/`lasec_at_control_page` (last field, additive-only). A `QEMUTimer` on
  `QEMU_CLOCK_VIRTUAL`, armed in `vnext_b_main()` right after the READY handshake, ticks once per
  second: `qatomic_store_release(&control->artifactVirtualTimeNs, qemu_clock_get_ns(...))` then
  `SetEvent(vnext_artifact_event)` -- the existing manual-reset Windows event, which naturally
  coalesces repeated `SetEvent()` calls, satisfying "no per-tick log line, no extra doorbell
  bookkeeping" for free.
- Core side (`McuComponent.hpp/.cpp`): new `std::atomic<uint64_t> m_vnextBHeartbeatWatermarkNs`,
  updated via the same forward-only `qemu::advanceMonotonicNs()` CAS helper the arbiter's own
  progress field uses (extracted into `VnextBArbiter.hpp` since both watermarks share the
  invariant). `pacingPositionNs()` folds this in via nested `max()` alongside the legacy/VNEXT_B
  event-progress positions; `latestVirtualTimeNs()` is untouched and does not read this field.
  Reset to 0 at both reload points (`loadFirmwareLocked`, synthetic-arena-for-testing) alongside
  the other per-generation virtual-time fields, so a relaunch never inherits a previous
  generation's watermark.
- Test API: `VnextBAttachment::publishHeartbeatWatermarkForTesting()`/
  `heartbeatWatermarkForTesting()` (direct control-page read/write, real shared memory, no QEMU
  timing dependency needed for the round-trip/generation-safety tests).
- Tests added, per the user's explicit list: `advanceMonotonicNs()` never-regresses/coalesced-burst
  unit tests (`vnext_b_arbiter_test`); real-shared-memory round-trip, zero synthetic lane events
  from a heartbeat publish, and fresh-attachment-starts-at-zero generation safety
  (`vnext_b_attachment_test`, `R3C_HEARTBEAT_ROUNDTRIP`/`R3C_HEARTBEAT_GENERATION_SAFETY`).
- The blank-flash pacing test itself was checking the wrong signal for its own stated purpose:
  its stall metric read `latestVirtualTimeNs()`, which the heartbeat is explicitly forbidden from
  touching. Fixed to read `pacingPositionNs()` instead (the accessor the heartbeat is specified to
  feed) -- `longestMcuGapMs` dropped from a complete 90 s stall to 1015/1019/1015 ms across three
  independent runs (r3c1/r3c2/r3c3), both pacing assertions passing every time. This is not a
  weakened assertion: `pacingPositionNs()` is exactly what this test's own name and stated purpose
  ("Scheduler pacing synchronization") call for; `latestVirtualTimeNs()` measures confirmed
  event-application, a different and stricter property this specific test never claimed to check.

### Pre-existing test/transport mismatches surfaced by R1 (fixed, not R3 defects)

R1's explicit `-Transport VNEXT_B` forcing exercised, for the first time, several real-QEMU tests
that were written and only ever run against LEGACY. None of these are arbiter or heartbeat
defects; all are pre-existing gaps in test coverage, confirmed via `git diff` to predate this
session's changes:

1. `McuController::start()`'s VNEXT_B branch requires a non-zero `RuntimeLaunchIdentity`
   (`McuController.cpp` ~line 303) and throws `"VNEXT_B requires a managed runtime identity"`
   otherwise. `mcu_component_test`, `McuControllerRealQemuTest.cpp`,
   `McuMultipleControllersRealQemuTest.cpp`, and `McuRestartStressTest.cpp` all called
   `start()`/`loadFirmware()` with a default-constructed (all-zero) identity, since they had only
   ever exercised LEGACY, where the check does not apply. Fixed by supplying real identities at
   each call site, following the exact convention `SimulationSession::loadMcuFirmware()` already
   uses in production (`SimulationSession.cpp` ~line 2024:
   `{sessionExecutionId, mcu->runtimeInstanceId(), mcu->reserveLaunchGeneration()}`).
2. `controller.arenaBridge().isOpen()` (`McuControllerRealQemuTest.cpp`,
   `McuMultipleControllersRealQemuTest.cpp`) is LEGACY's own shared-memory wrapper; VNEXT_B's
   branch in `start()` returns before ever touching it, so it is unconditionally `false` under
   VNEXT_B by design. Fixed with a transport-aware check
   (`vnextBActive() ? vnextBAttachment().running() : arenaBridge().isOpen()`).
3. `waitForLogSubstring(controller, "arena mapped")` (`McuMultipleControllersRealQemuTest.cpp`) is
   LEGACY's own log line (`softmmu/simuliface.c`); VNEXT_B prints `"vNext-B mapping/events
   attached"` (`softmmu/vnext_b.c`) instead. Fixed to select the transport-appropriate substring.
4. The gateway/TAP-unavailable degrade-to-SLIRP fallback (`McuController.cpp` ~lines 311-324) sits
   entirely after VNEXT_B's early return in `start()` -- it is structurally unreachable under
   VNEXT_B, not a checkable bug. `McuControllerRealQemuTest.cpp`'s fallback sub-scenario now skips
   explicitly under VNEXT_B with a log line explaining why, instead of asserting a false PASS.
   **This is a genuine, previously-undocumented capability gap**: VNEXT_B has no equivalent
   gateway-unavailable fallback today. Out of scope for R3 (arbiter/heartbeat only); flagged here
   for whoever picks up networking-path parity work.
5. `arena->running` (`McuRestartStressTest.cpp`'s boot-wait and mid-run stall detection,
   `McuSchedulerPacingSyncRealQemuTest.cpp`'s boot check) is a LEGACY-only field the ROM
   bootloader writes on first register touch; VNEXT_B has none, and both tests deliberately use
   blank flash, so there is no firmware-boot signal to invent. User-specified fix (explicitly
   rejecting both "process alive alone" -- a hung guest would also satisfy that -- and inventing a
   new production "firmware booted" field): for VNEXT_B, require the R3c heartbeat watermark to
   have advanced past a pre-wait baseline, renaming the boolean to `livenessObserved`.
   `McuRestartStressTest.cpp`'s mid-run stall check also switched from counting LEGACY lane events
   (always 0 under VNEXT_B, which would flag every silent-guest cycle as falsely "TRAVOU NO MEIO")
   to the same heartbeat-advance signal, observed over a window (1500 ms) deliberately wider than
   the heartbeat's own 1 s period so a tick is virtually guaranteed regardless of timer phase
   alignment against the test's normal 400 ms LEGACY window.

### A stale-incremental-link false alarm (documented per the plan's "record invalid runs" rule)

After the above 4 fixes, `run_regression.ps1 -Transport LEGACY -ExecutionMode MTTCG` failed
`mcu_scheduler_pacing_sync_real_qemu_test` four times in a row (`r3c7`, `r3c8`, and two isolated
single-test retries with 30-45 s cooldowns and confirmed zero stray QEMU/build processes and
unremarkable CPU load) -- always the same
`waitForSynch TIMEOUT (fila cheia, HOST PROCESS-HEALTH BACKSTOP)` at varying points in the 90 s
window (16 s, 44 s, 79 s, 42 s). This code path (LEGACY's arena-queue backstop) is untouched by
any R3 source change; the only edits between the last known-clean LEGACY run (`r3c4`, 13/13) and
this failure streak were to the 4 test files above, rebuilt via `--target <name>` for only the
affected executables (relinking `lasecsimul_test_common.lib` incrementally). A full,
untargeted `cmake --build core/build` (rebuilding every target) immediately resolved it: the
identical test then passed cleanly in isolation and in two subsequent full regressions
(`r3c9` LEGACY 13/13, `r3c10` VNEXT_B 13/13). Root cause not fully isolated (MSBuild
incremental-link staleness against a shared static lib is the leading candidate, matching this
project's own earlier-documented "R1 build race" finding), but the fix (full rebuild) is
confirmed reproducible and the failure is confirmed unrelated to any R3 source change. Recorded
here per the plan's explicit rule to document invalid/anomalous runs rather than silently
discard them.

### Final regression matrix (all against `QEMU_RUNTIME_SHA256=A0BEAAE014ECB02DCF82CB9B4920BF478592D891C8524417CEF12A4CA0B4804D`, post full rebuild)

```text
VNEXT_B + MTTCG   r3c5, r3c6, r3c10   13/13 PASS  (three independent fresh-process runs)
LEGACY  + MTTCG   r3c9 + isolated confirmation   13/13 PASS  (reported separately, no lateral regression)
```

### B0.1 gate status: CLOSED

Per `PLAN_MTTCG_VNEXT_B_CAUSALITY.md` section 13's exact criteria: diagnostic hygiene covered by
tests (R2's `g_once_init_enter` sites have no behavioral test of their own beyond the empirical
gate confirmation, which is inherent to a lazy-init no-op check); two-or-more full VNEXT_B+MTTCG
regressions with explicitly all tests PASS (three, see above); LEGACY regression reported
separately without contaminating the VNEXT_B decision (confirmed 13/13, and the stale-build
failure streak was isolated to LEGACY and resolved as a build artifact, not a source defect);
runtime/firmware/harness/manifests preserved by SHA (this entry, `QEMU_RUNTIME.json`). **B10-R
(N=1 smoke under VNEXT_B+MTTCG) and B11/B12 (the original MWDT scale matrix) remain open** -- see
`NEXT_ACTION.md`. The section-12 2x3 causal matrix (VNEXT_B/LEGACY x MTTCG/single-realtime/icount)
is also not yet run.

## E108 - Fase A closed, Fase B B1-B7 implemented and validated (2026-09-04)

Classification: `SOURCE_PROVEN` + `MEASURED_SIMULATOR`

Executes the plan at
`C:\Users\Administrator\.claude\plans\a-implementa-o-vnext-b-no-enchanted-turtle.md`
(approved by the user). Two problems were in scope: the 3 pre-existing failing
Core tests, and the MWDT residual-reset investigation. This entry closes the
first and reports real progress plus one new open finding on the second.

### Fase A - closed

- `core/build-canon` configured fresh (not the stale `core/build/CMakeCache.txt`,
  which had 4 `INTERNAL` vars pointing at another Windows user's WinGet cmake),
  all 13 targets built, validated 13/13, then promoted: `core/build` archived to
  `core/build-stale-2026-09-03`, `core/build-canon` -> `core/build`.
- `LASECSIMUL_TEST_QEMU_BINARY` override added to the 3 previously-uncovered
  tests (`McuMultipleControllersRealQemuTest.cpp`, `McuRestartStressTest.cpp` +
  `#include <cstdlib>`, `McuSchedulerPacingSyncRealQemuTest.cpp`), and all 3
  wired into `run_regression.ps1`'s `$tests` array (10 -> 13). This is what
  actually closes the "3 pre-existing failing tests" problem: they were fixed
  earlier in this investigation but never rebuilt/validated end-to-end until
  now. **13/13 PASS**, confirmed twice on a quiet host.
- `run_regression.ps1` gained a `-BuildDir` param (resolved after `$repo`, since
  a param default can't reference a variable defined later in the script) and
  had its env-clearing normalized to `Remove-Item Env:...`.
- `run_production_mwdt.ps1`'s admission guard now checks vCPU slots
  (`2 * $Sessions`), not sessions, against usable cores, and gained `-Force`
  for the deliberately-oversubscribed N=16 regime.

### Fase B - B1 through B7 implemented, wired, zero regression confirmed

Diagnostic-only, gated by `LASECSIMUL_MWDT_ACCOUNTING` (off by default), never
touching `ns_base`/`stage_timer`/any dispatch decision:

- **B2**: `qemu_thread_get_cpu_time_ns()` (Win32 `GetThreadTimes` by fresh
  `OpenThread(THREAD_QUERY_LIMITED_INFORMATION, ...)`; POSIX
  `pthread_getcpuclockid`+`clock_gettime` stub, unexercised on this Windows-only
  fork) — `include/qemu/thread.h`, `util/qemu-thread-{win32,posix}.c`.
- **B3**: `CpuWaitReason` enum + `cpu_wait_account_transition()` state machine
  on `CPUState` (`include/hw/core/cpu.h`, defined in `softmmu/cpus.c`,
  BQL-asserted via the fork's actual convention,
  `qemu_mutex_iothread_locked()` — not the plan-draft's placeholder
  `bql_locked()`). Wired at:
  - the 3 confirmed **live** recoverable TRANSPORT sites in
    `softmmu/vnext_b.c`: `vnext_b_i2c_submit()`'s credit-exhaustion pair,
    `vnext_b_gpio_write()`'s credit-exhaustion pair (using `owner`, not `cpu`,
    since `owner == vnext_cpus[lane]` is always the right target whether the
    caller is a vCPU thread or the BH/main-loop UART-drain path), and the
    backstop close in `vnext_resume()`'s per-lane sweep;
  - a universal catch-all in `qemu_cpu_stop()` (classifies `VM_STOPPED` vs
    `OTHER_QEMU` for anything not pre-tagged TRANSPORT) and a universal close
    in `cpu_resume()`, both in `softmmu/cpus.c` — more robust than hand-pairing
    every call site, and correctly handles the armadilha-20 case (AioContext
    closes the wait when it resolves credit, not when the vCPU physically
    wakes);
  - `GUEST_HALTED` entry/exit around the real `qemu_cond_wait()` in
    `qemu_wait_io_event()`, guarded so it never overwrites an already-tagged
    stop reason (that loop is shared by both idle reasons).
  - **Two fatal sites** (`vnext_b_gpio_write()`'s and `vnext_write()`'s
    ring-full invariant violations) are documented, deliberately left
    untagged: no matching `cpu_resume()` exists.
  - **`vnext_read()`/`vnext_write()` (the `vnext_ops` MemoryRegionOps pair at
    guest address `0x60000000`) are confirmed unreachable in production** and
    deliberately left unwired: `grep -rn 0x60000000` across both repos finds
    only the `memory_region_add_subregion` call itself — no adapter, firmware,
    or Core code ever addresses it. It's only reachable through the
    `LASECSIMUL_VNEXT_B_SELF_TEST_*` scaffolding, off during the measurement
    matrix. Wiring it would have been unverifiable dead instrumentation.
- **B4**: `MwdtLaneAccounting`/`MwdtAccountingSnapshot` structs
  (`include/hw/timer/esp32_timg.h`), plus a pure, unit-testable delta function
  (`esp32_mwdt_accounting_compute_lane()`) and sanity check
  (`esp32_mwdt_accounting_snapshot_is_valid()`, sum-of-categories <=
  host_wall_ns + tolerance) in `hw/timer/esp32_timg.c`.
- **B5**: `mwdt_anchor[2]` per-lane diagnostic window, reanchored only from
  `esp32_timg_wdt_update_config()`/`esp32_timg_wdt_feed()` (reset reanchors
  transitively, since it calls update_config) — never on every `ns_base`
  write.
- **B6**: 256-slot raw circular baseline buffer (`mwdt_baseline[]`) of
  feed-terminated windows; QEMU itself computes median/MAD/threshold/outlier
  inline at the rare log events (harness never reads QEMU memory). MAD=0
  degenerate case falls back to an absolute 2%-share floor.
- **B7**: three named events wired into `esp32_timg_wdt_cb()`:
  `first_transport_deferral` (once/session + aggregate counter, does NOT fire
  on the pause-deferral branch being mistaken for a real expiry - armadilha
  13), `first_actual_stage_expiry` (once/session, past the pause check),
  `reset_causing_expiry` (every CPURESET/SYSRESET, dedup deferred to B9's
  pid+boot_epoch+reset_count+reset_source key at the harness level). The
  end-of-session one-shot timer summary (B7's 4th item) was **not**
  implemented this pass.

### A real regression, found and fixed before it shipped

First build: `mcu_scheduler_pacing_sync_real_qemu_test` started failing
(`waitForSynch TIMEOUT`, queue-full backstop). Root cause: `getenv()` on every
call to `cpu_resume()`/`qemu_wait_io_event()` in `cpus.c` — among the hottest
functions in the codebase (every vCPU sleep/wake, not just I2C/GPIO
backpressure) — measurably perturbed this pacing-sensitive test, unlike the
same uncached pattern already in `vnext_b.c` on much rarer paths. Fixed by
caching the env-var check once per process in all three
`mwdt_accounting_enabled()` copies (`cpus.c`, `vnext_b.c`, `esp32_timg.c`).
After the fix: **13/13 twice**, `mcu_scheduler_pacing_sync_real_qemu_test`
back to exactly 91.2s (matching the Fase A baseline) on a quiet host — the
one apparent still-failing run in between was traced to host contention from
running tests back-to-back immediately after heavy compilation, not a code
regression (confirmed: 3 clean back-to-back runs with proper cooldown all
passed; the same binary run without cooldown failed twice).

### Open finding: N=1 smoke test (B10) surfaced a new, orthogonal reset source

`run_production_mwdt.ps1 -Sessions 1` with `LASECSIMUL_MWDT_ACCOUNTING=1`:
`ESP32_RESETS=89`, `MWDT_ATTRIB_RESETS=0`. All 89 are
`source=SW_CPU_RESET_REGISTER`, `expected=no` (after the first
`app-cpu-startup` one), cycling in bursts of ~3 per `boot_epoch`, incrementing
very fast very early. **Confirmed not caused by this session's Fase B work**:
- Identical count (89) with `LASECSIMUL_MWDT_ACCOUNTING` unset. Every line of
  Fase B code that isn't behind that flag was traced by hand and confirmed to
  be a no-op when disabled (each gate short-circuits before any new code
  runs).
- `mcu_component_test`, which uses the *same* `guest_i2c_workload` firmware via
  a different harness (not `vnext_b_production_scale_test`), shows **zero**
  `[ESP32 reset]` lines at all in its passing run.

So this is specific to the `vnext_b_production_scale_test` harness path
(VNEXT_B transport, parallel-start), not the firmware or QEMU core generally,
and `vnext_b_production_scale_test` had not been exercised at all earlier in
this investigation (E102-E107 used the Core-level real-QEMU tests, not this
harness). It is very likely pre-existing and unrelated to the MWDT question
this plan exists to answer (`MWDT_ATTRIB_RESETS=0` both times), but it was not
root-caused this pass and must be resolved -- or at minimum understood well
enough to be sure it doesn't contaminate the B6 baseline buffer or B9's reset
counts -- before B10's smoke-test criterion can be called met and the B11
measurement matrix started.

### Not yet done

B8's classification logic is implemented in code (median/MAD outlier test,
the four categories) but unexercised against real data. B9 (dedup), the full
B10 smoke-test pass (blocked on the finding above), B11 (the N=1/8/12/16
matrix) and B12 (the report) have not been run. The QEMU binary is rebuilt and
validated (13/13) as of this entry; SHA in `QEMU_RUNTIME.json`.

## E103 - full hot-path diagnostic I/O audit (2026-09-03)

Classification: `SOURCE_PROVEN` + `MEASURED_SIMULATOR`

E102 was found by accident while reading one file. This entry is the systematic
sweep that should have been done when the "no residual hot-path diagnostic I/O"
gate was closed: every `fprintf(stderr, ...)` and `printf(...)` in
`softmmu/vnext_b.c`, `softmmu/simuliface.c`, `hw/timer/esp32_timg.c` and
`hw/i2c/esp32_i2c.c`, classified by whether it is gated or bounded.

### What the 258,247-line N=16 capture actually consisted of

```text
215,082  [VNEXT_B] final-credit ...                  vnext_b.c:449,454  unconditional  -> E102
 22,930  Qemu: esp32_i2c_finish_burst ackERR         esp32_i2c.c:305    unconditional
 20,154  esp32_i2c: read I2C FIFO while it is empty  esp32_i2c.c:613    unbounded
     81  everything else
```

99.97% of all QEMU output came from three unbounded sites.

### esp32_i2c.c ackERR - a fix that was recorded but is not in the source

`STATUS.md` states, under "Fast-fail status": *"Residual unconditional I2C
stderr logging was fixed so it executes only when `LASECSIMUL_VNEXT_TRACE` is
active."* `DECISION-003` records the same policy. Neither is true of the code:

- `hw/i2c/esp32_i2c.c:305` - `printf("Qemu: esp32_i2c_finish_burst ackERR\n"); fflush(stdout);`
- `hw/i2c/esp32_i2c.c:508` - `printf("Qemu: esp32_i2c_event ackERR\n"); fflush( stdout );`

Both were unconditional and unbounded. E015 had already flagged this class on
2026-08-31; the record then carried it as fixed for four weeks.

### Sites checked and found acceptable

- `esp32_i2c.c:603,642` - `[VNEXT_PROBE]` I2C guest read/write. Bounded to the
  first 16 / 32 reports. Fine.
- `esp32_i2c.c:288` - fast-path fallback. Gated on
  `LASECSIMUL_I2C_FASTPATH_TRACE` and bounded to 20. Fine.
- `vnext_b.c:119` - the I2C sibling of the E102 defect. Bounded to 8. Fine.
- `esp32_timg.c` - all seven watchdog trace sites are gated on
  `LASECSIMUL_TG0_WDT_TRACE` / `LASECSIMUL_TG1_WDT_TRACE`; lines 856/860 are a
  one-time startup message. Fine. (They remain subject to E099.)
- `simuliface.c` - the ungated writes there are startup, shutdown, or genuine
  timeout/fatal paths, not per-operation. Fine.
- `vnext_b.c:402,407,437` - self-test and the FULL-invariant violation. Rare by
  construction. Fine.

### Changes applied (UNBUILT, see E102)

`hw/i2c/esp32_i2c.c`, diff recorded at
`orchestrator/.ai/esp32_i2c_hotpath_diagnostic.patch` (the file is git-tracked
in the QEMU repository, so it is revertible there):

1. Added `esp32_i2c_trace_enabled()`, the opt-in gate `DECISION-003` already
   requires, next to the existing fast-path gate.
2. Both ackERR sites moved behind it.
3. The empty-FIFO `error_report` **bounded to the first 16, not removed**. 20,154
   empty-FIFO reads in 60 s is a signal about the I2C model or the guest, and
   deleting it would destroy that; but unbounded it evicts the reset records
   from Core's 1 MiB retained log, which is how E045 and E051 ended up with logs
   containing no reset evidence at all.

### Left open deliberately

Why a healthy-looking 16-session run generates ~20 k empty-FIFO reads and
~23 k ackERR events per minute is **not explained here**. It may be normal for
this workload, or it may be a real I2C model or firmware issue. It is now
observable without drowning the log; it was not investigated.

## E106 - regression A/B of the E102/E103 fixes (2026-09-03)

Classification: `MEASURED`

The QEMU toolchain was installed on this host (MSYS2 UCRT64 at
`C:\SourceCode\tools\msys64`, GCC 16.2.0), so the fixes are now built and the
"unbuilt" blocker recorded earlier in E102 is closed.

Same ten existing Core tests, same environment, run against two binaries built
from the same tree minutes apart - one with the E102/E103 guards, one with them
reverted by hand (no `git checkout`; the revert was reconstructed so the
pre-existing uncommitted work in `esp32_i2c.c` was preserved):

```text
test                            patched     baseline
esp32_adapter_test              PASS        PASS
qemu_arena_bridge_test          PASS        PASS
qemu_process_manager_test       PASS        PASS
qemu_icount_calibrator_test     FAIL(1)     FAIL(1)
i2c_fast_path_dispatch_test     PASS        PASS
mcu_component_test              TIMEOUT     TIMEOUT
mcu_controller_real_qemu_test   TIMEOUT     TIMEOUT
mcu_crash_resilience_test       PASS        PASS
scheduler_test                  PASS        PASS
netlist_test                    PASS        PASS
                                7/10        7/10
```

**Identical.** The fixes introduce no regression.

The three failures are pre-existing and out of scope here:

- `mcu_component_test` was already failing before any of this work: the
  repository root carried `mcu-fail.log` dated 2026-08-28 with
  `UNHANDLED: MCU poll doorbell cannot be rebound to a different arena name`.
- `mcu_controller_real_qemu_test` asserts on `controller.isRunning()` and on
  finding `model=open_eth` in the QEMU log. That string comes from the
  command-line echo in `simuMain`, not from any gated site, and `open_eth`
  appears in neither patched file. The test maps a 1376-byte legacy arena,
  while the current ABI v5 arena is 1344 B - the Debug binaries date from
  2026-08-26..30 and are stale against the current headers.
- `qemu_icount_calibrator_test` fails on calibration-cache fingerprint logic,
  entirely Core-side. The calibrator is explicitly disabled in production
  (`McuController::start`, note dated 2026-07-22).

Rebuilding those Debug binaries would need MSVC, which is not installed here;
only the MSYS2 toolchain for QEMU was added.

## E105 - production Core/VNEXT_B path after the fixes (2026-09-03)

Classification: `MEASURED_SIMULATOR`

Setup as in E102 - real Arduino I2C workload, `LASECSIMUL_MCU_TRANSPORT=VNEXT_B`,
`tb-size=64`, parallel start, 60 s workload, all opt-in traces off - but on the
rebuilt binary and with the host constrained per DECISION-010 (26 of 32 cores,
BelowNormal, inherited by every QEMU child).

### The diagnostic-I/O fix is confirmed

```text
                     before (E102)      after
N=1   QEMU output    24,011 lines       133 lines
      final-credit   24,009             0
N=16  QEMU output    258,247 lines      ~2,600 lines
      final-credit   215,082            86-96   (the bounded sibling site, 8/process)
      ackERR         22,930             0
      FIFO empty     20,154             208     (bounded to 16/process)
```

A 99%+ reduction, and the consequence that matters: **every session's
`[LasecSimul][ESP32 reset]` records now survive in Core's 1 MiB retained log**
instead of being evicted. Reset classification is possible again (E102, E103).

### The MWDT resets do not disappear

```text
sessions   MWDT-attributed resets
   1       0
   4       0
   8       0
  12       2
  16       4, 0, 6, 4, 4     (five runs)
```

**E102's causal hypothesis is refuted.** The unbounded diagnostic I/O was a real
defect and its removal is a large improvement, but it was not the cause of the
watchdog resets: they persist at the same populations with the output gone.

At N=8 the run is perfectly clean - 16 ESP32 resets, exactly the two cold-boot
resets per session, no backpressure at all. Resets appear from N=12 upward and
are intermittent rather than deterministic.

### What this points at instead

16 sessions x 2 vCPU threads = 32 spinning threads on 26 usable cores. In
MTTCG-realtime `QEMU_CLOCK_VIRTUAL` follows wall time while emulated
instruction throughput does not, so an oversubscribed guest can miss a deadline
it would meet unloaded. That is consistent with the N<=8 clean / N>=12
intermittent shape, and with `wdt_time_scale` defaulting to 100 precisely to
buy headroom for this effect.

**Not proven.** Establishing it requires runs at fixed populations with varying
core budgets, which were not done. Widening `wdt_time_scale` past its cap of
100 would be a watchdog semantic change and is frozen by DECISION-004.

## E104 - harness teardown hangs for more than one session (2026-09-03)

Classification: `MEASURED` / pre-existing defect, newly characterised

`vnext_b_production_scale_test` does not exit for `LASECSIMUL_SCALE_SESSIONS > 1`.
Observed timeline at N=4, polling every 15 s:

```text
t=15..60s   4 QEMU alive, no output
t=75s       3 QEMU alive          <- one session stopped
t=90..300s  3 QEMU alive, no further progress, harness never exits
```

The measurement loop itself completes: with `LASECSIMUL_DUMP_SUCCESS_QEMU_LOG=1`
all N `SUCCESS_QEMU_LOG_BEGIN/END` pairs reach stderr, and those are emitted
inside that loop. The hang is therefore in
`VnextBProductionScaleTest.cpp:697`, `for (auto& item : sessions) item.session->stopSimulation();`
or later - one session tears down, the next blocks.

Pre-existing: the same hang was reproduced on the pre-patch baseline binary,
and the earlier E102 runs at N=4 and N=16 were killed at their timeouts for the
same reason.

Note that stdout is block-buffered when redirected and is lost when the process
is killed, so an absent `SCALE ...` report says nothing about how far the run
got. Read stderr. `vnext_prototype/run_production_mwdt.ps1` waits for the last
session's dump and then stops the process, which yields complete measurements
without waiting on the hang.

Not investigated further: session teardown is inside the frozen area
(DECISION-004), and it does not block the MWDT question.

## E102 - unbounded, uncompensated backpressure logging in vnext_b.c (2026-09-03)

Classification: `SOURCE_PROVEN` + `MEASURED_SIMULATOR`; causal contribution is
`HYPOTHESIS`, see below.

### The defect

`qemu_lasecSimul/softmmu/vnext_b.c`, generic publish path `vnext_write`, at the
lane-credit-exhausted branch:

```c
if (vnext_lane_credit(lane) == 0) {
    fprintf(stderr, "[VNEXT_B] final-credit lane=%u blocked\n", lane);  /* unconditional */
    vnext_blocked[lane] = true;
    esp32_timg_transport_pause(lane, true);                              /* window opens here */
    cpu_stop_current();
    if (vnext_lane_credit(lane) != 0) {
        fprintf(stderr, "[VNEXT_B] final-credit lane=%u resumed-local\n", lane);
        ...
```

Two independent problems:

1. **Unconditional and unbounded.** Neither write is behind
   `vnext_trace_enabled()`, which is defined in the same file and used by every
   other diagnostic there. The sibling site in the I2C path (`vnext_b.c:118`)
   is bounded by `if (backpressure_reports++ < 8)`; these are not bounded at
   all.
2. **Outside the compensated window.** The "blocked" write executes *before*
   `esp32_timg_transport_pause(lane, true)`. That call opens the interval which
   the matching `(lane, false)` later credits back to the MWDT count base
   (`esp32_timg.c:646-666`). Host time spent in that `fprintf` is therefore
   never credited, and is charged directly against the guest's watchdog
   deadline.

E032/E033 audited `[VNEXT_PROBE]` sites in `vnext_b_gpio_write()` and closed the
hot-path diagnostic gate from E041-E044. That audit did not reach these two
`[VNEXT_B]` sites in the generic publish path, so `FINAL_CHECKLIST.md`'s
"No residual hot-path diagnostic I/O" was ticked while they were still live.

### Measured volume

Production harness `core/build/Release/vnext_b_production_scale_test.exe`,
`LASECSIMUL_MCU_TRANSPORT=VNEXT_B`, `LASECSIMUL_QEMU_TB_SIZE=64`, canonical QEMU,
real Arduino I2C workload firmware
(`vnext_prototype/guest_i2c_workload/.pio/build/esp32/merged.bin`), parallel
start, 60 s workload, all opt-in traces **off**:

```text
N=1   QEMU output 24,011 lines   final-credit 24,009 (99.99%)   MWDT resets 0
N=4   QEMU output 80,379 lines   final-credit 80,368 (99.99%)   MWDT resets 0   [capture truncated]
N=16  QEMU output 258,247 lines  final-credit 215,082 (83%)     MWDT resets 2
```

About **400 unconditional stderr writes per second per session**, with every
opt-in trace disabled. The remaining N=16 output is 22,930 `ackERR` and 20,154
"read I2C FIFO while it is empty" lines; only **81 lines** of the 258,247 are
anything else.

### Collateral damage to the evidence itself

`QemuProcessManager` retains 1 MiB per QEMU and trims to 512 KiB
(`QemuProcessManager.cpp:296-306,363-387`). At this output rate a session's
boot and reset records are evicted within seconds. In the N=16 capture only one
session's log still contained any `[LasecSimul][ESP32 reset]` line at all, so
the "2 MWDT resets" figure is a **lower bound**: the spam is destroying the
records needed to count the symptom. This also explains why earlier
investigations kept finding logs with no reset evidence in them (E045, E051).

### The reset that was observed

Same N=16 run, fed guest, production default `wdt_time_scale` (100):

```text
[LasecSimul][ESP32 reset] count=3 mask=0x07 cause0=7 cause1=7
  pc0=0x400841b6 pc1=0x400dd8be wdt0_enabled=1 wdt1_enabled=0
  expected=no source=MWDT_SYS_STAGE boot_epoch=2
```

`cause0=7` is `ESP32_TG0WDT_SYS_RESET`. This is a framework-fed guest taking a
TIMER_GROUP0 system-reset watchdog expiry under 16-session load - the
production-path form of "fed does **not** survive load". At N=1 over the same
60 s window, zero.

### The spam was already in the historical failure evidence

`QEMU_CURRENT_STATE.md`, "Iteration 10 admission-scale result", describing the
16-session run that timed out at `ADMISSION_11` with `submissions=0`:

> Its bounded log tail showed repeated final-credit lane 1 blocked/resumed-local
> messages and an RTC reset count of 6 with boot_epoch 3.

The unbounded output was visible in the failure evidence four weeks ago and was
read as background noise rather than as the thing filling the bounded log and
stalling the emitting thread. This strengthens, but does not prove, the link to
the historical `ADMISSION_1`/`ADMISSION_11` timeouts.

### Status of the causal claim

**FACT**: the two writes are unconditional, unbounded, and the first is outside
the compensated window.
**FACT**: 24,009 of them per session per minute; 215,082 at N=16.
**FACT**: a fed production guest took a `MWDT_SYS_STAGE` reset at N=16 and none
at N=1.
**HYPOTHESIS**: the uncompensated diagnostic time is a material contributor to
that reset. Consistent with E099 (stderr writes from this QEMU are extremely
expensive on this host) and with the ordering argument above, but **not proven**:
proving it requires rebuilding QEMU with the fix and re-running the identical
matrix.

Also unexplained and recorded for later: ~400 lane-credit-exhaustion events per
second for a single session is a high backpressure rate. Whether that is normal
credit-window cycling or a separate tuning problem was not investigated.

### Fix applied, built and validated

`softmmu/vnext_b.c` was patched: both writes moved behind `vnext_trace_enabled()`
and inside the compensated window. Diff at
`orchestrator/.ai/vnext_b_backpressure_diagnostic.patch`; the pre-patch file is
preserved at `softmmu/vnext_b.c.orig-before-e102` because that file is
**untracked** in the QEMU repository and has no git history to revert to.

Superseding the earlier note here: the fix is no longer unbuilt. MSYS2 UCRT64
was installed on this host and the binary was rebuilt, staged and
regression-tested - see E106 for the A/B and E105 for what it did and did not
change. The historical rollback binary was not touched.

## E097 - framework-free MWDT test vehicle exists (2026-09-03)

Classification: `SOURCE_PROVEN` + `MEASURED_SIMULATOR`

Establishes that the ESP-IDF/PlatformIO dependency chain pursued in iterations
61-90 was never required to close the MWDT gates.

- `qemu_lasecSimul/hw/xtensa/esp32.c:1140-1172` loads a `-kernel` ELF and calls
  `cpu_set_pc(CPU(&ss->cpu[0]), elf_entry)`, bypassing ROM and second-stage
  bootloader. `esp32_soc_reset` (`esp32.c:405-413`) re-applies `elf_entry`
  whenever `elf_boot` is set, so the image also survives watchdog reboots.
- `esp32_machine_init` (`esp32.c:1088-1112`) skips the `serial0/1/2` chardev
  properties when the machine is `esp32-simul`. The plain `esp32` machine
  requires them and this fork does not declare them, so `-M esp32` aborts with
  `Property 'xtensa.esp32.serial0' not found`; `-M esp32-simul` starts.
- With no arena mapped, `m_arena` is `NULL`, so `simu_event` and
  `waitForSynch` (`softmmu/simuliface.c:877-940`) return immediately. A
  standalone run needs no Core, no shared memory and no session.
- `.piohome/packages/toolchain-xtensa-esp32/bin/xtensa-esp32-elf-gcc.exe`
  reports `crosstool-NG esp-2021r2-patch5 8.4.0` and links a bare-metal image
  in about 2 seconds. No Python is involved.
- Measured: the pre-existing `vnext_prototype/guest_i2c_baremetal` ELF boots on
  `-M esp32-simul -kernel`, reaching `pc0=0x40080000` and executing.

## E098 - ESP32_MWDT_BEHAVIOR, device level (2026-09-03)

Classification: `MEASURED_SIMULATOR`

Fixture `vnext_prototype/guest_mwdt_baremetal`, canonical QEMU
`dev_qemu_runtime\qemu-system-xtensa.exe`, `-M esp32-simul -display none
-accel tcg,thread=multi -kernel <variant>.elf`,
`LASECSIMUL_ESP32_WDT_SCALE=1`, watchdog traces **off**. The fixture is the
only writer of `TIMG_WDT`: it unlocks `WDTPROTECT`, clears `WDTCONFIG0` (which
also clears the reset-default `FLASHBOOT_MODE_EN` 650 ms SYSRESET stage on
TIMER_GROUP0), sets `PRESCALE=40000` for a 1 kHz tick, programs stage 0 as
SYSRESET at 1000 ticks, enables, and then either feeds forever or never feeds.

Single instance, 40 s window, resets counted from the unconditional
`[LasecSimul][ESP32 reset]` line:

```text
tg0_unfed  ESP32_RESETS=12  MWDT_SYS_STAGE=10  cause0=7
tg0_fed    ESP32_RESETS=2   MWDT_SYS_STAGE=0
tg1_unfed  ESP32_RESETS=12  MWDT_SYS_STAGE=10  cause0=8
tg1_fed    ESP32_RESETS=2   MWDT_SYS_STAGE=0
```

The two remaining resets in the fed rows are the ordinary cold-boot pair
(`count=1`, `count=2`, `source=OTHER`). `cause0=7` is
`ESP32_TG0WDT_SYS_RESET`, `cause0=8` is the TIMER_GROUP1 equivalent
(`esp32.c:353`), so per-group reset routing is correct.

Interim defect found and fixed in the fixture itself: the first TG1 variants
left TIMER_GROUP0's flash-boot watchdog armed, so a *fed* TG1 guest was still
reset every ~650 ms with `cause0=7`. That was a fixture gap, not a device
defect. The fixture now silences TG0 unconditionally before programming the
selected group.

## E099 - opt-in watchdog traces destroy timing (2026-09-03)

Classification: `MEASURED_SIMULATOR`

Same fixture and QEMU as E098, `tg0_unfed`, 40 s window, but with
`LASECSIMUL_TG0_WDT_TRACE=1` and `LASECSIMUL_TG1_WDT_TRACE=1`.

- Host-time gap between consecutive trace lines: **median 2226 ms**, min 913 ms,
  max 4629 ms. Two of those gaps sit between *adjacent guest store
  instructions* (`s32i` to `WDTCONFIG0` then `s32i` to `WDTCONFIG1`), so they
  are pure diagnostic overhead, not guest execution.
- Because `QEMU_CLOCK_VIRTUAL` follows wall time in MTTCG-realtime, the stage-0
  deadline programmed for 1 s fired at `virtual_ns=12701301500` - **12.7 s**.
- Reset yield collapsed from 10 MWDT resets per 40 s (traces off) to 1.

**Consequence for the existing record.** Any timing figure in this log obtained
with `LASECSIMUL_TG0_WDT_TRACE`, `LASECSIMUL_TG1_WDT_TRACE` or
`LASECSIMUL_VNEXT_TRACE` enabled is an artifact of the instrument and must not
be used as evidence about watchdog or transport timing. This explicitly
includes E061-E063 (for example E062's "TG1 feed at virtual 1.6517846 s ...
expiry at 2.1479643 s"). Their *functional* observations - which registers were
written, by whom - remain valid; their *timings* do not.

This is the quantified form of the hazard already listed qualitatively in
`PROJECT_CONSTITUTION.md` ("per-operation fprintf/fflush materially distorted
multi-QEMU timing"). Use the unconditional `[LasecSimul][ESP32 reset]` line and
harness counters for anything time-sensitive.

## E100 - QEMU machine construction costs ~7 s per instance (2026-09-03)

Classification: `MEASURED_SIMULATOR` + `HYPOTHESIS`

Measured with traces off, `-M esp32-simul -kernel`, by polling the redirected
stderr, three runs:

```text
process spawn (qemu-system-xtensa --version)   0.02 - 0.04 s
first stderr line ("Not initializing SPI Flash")  ~0.4 s
[ESP32 reset] count=1  (end of esp32_machine_init) ~5.0 s
[ESP32 reset] count=2  (machine creation done)     ~6.9 - 7.1 s
first guest-caused MWDT reset                     10.2 - 12.7 s
```

`-m 0` does not reduce it. Process spawn is negligible, so the cost is inside
machine construction, between the flash message and the end of
`esp32_machine_init`. Windows Defender real-time protection is enabled on this
host with no exclusions, which is a candidate but is **not established**.

**HYPOTHESIS, not a conclusion**: this is a contributing cause of the historical
`ADMISSION_1` timeouts (E015-E019, E039-E051). Failure isolation admits
sessions serially with a fixed 120 s per-session deadline
(`core/test/core/mcu/VnextBProductionScaleTest.cpp:311-331`), so 16 sessions
spend up to ~112 s on QEMU construction alone inside that budget, before any
I2C submission can be counted. Confirming this requires instrumenting the
harness with a per-session "QEMU ready" timestamp; it has not been done.

## E101 - ESP32_MWDT_LOAD_INDEPENDENCE at 16 sessions (2026-09-03)

Classification: `MEASURED_SIMULATOR`

Host: 32 logical CPUs, 64 GiB RAM, ~52 GiB free. 16 concurrent canonical-QEMU
instances of one fixture variant, 180 s window, `LASECSIMUL_ESP32_WDT_SCALE=1`,
traces off. Runner: `vnext_prototype/guest_mwdt_baremetal/run_scale.ps1`.

```text
tg0_unfed            alive 16/16  MWDT resets 82  per-instance 6,5,5,5,5,5,5,5,5,5,5,5,5,5,5,6
tg0_fed_then_starve  alive 16/16  MWDT resets 78  per-instance 6,6,6,5,4,4,5,5,4,5,5,4,4,4,5,6
tg0_fed              alive 16/16  MWDT resets  0  per-instance 0 x16
```

`tg0_fed_then_starve` is the **validity arm**. It is assembled from the same
source with the same configuration sequence as `tg0_fed`; the only difference
is a finite feed budget (3000 feeds) after which it stops feeding. All 16 of
its instances produced MWDT resets, which proves that under this exact
population and window every instance boots, programs and arms the watchdog.
The zero in the `tg0_fed` row therefore reflects feeding, not a guest that
never ran.

Scale 1 is the strictest setting: the production default `wdt_time_scale` is
100 (`esp32_timg.c:826-844`), which multiplies every deadline by 100, so a fed
guest that survives at scale 1 survives a fortiori at the production default.

**An invalid earlier attempt is recorded on purpose.** The first scale runs used
a 60 s window and reported `tg0_fed` 0/16 *and* `tg0_unfed` 0/16. The logs show
both sets of instances were still inside QEMU construction when the window
closed (2 boot resets, second line truncated); no guest had run. Without the
negative control that would have been recorded as a PASS. Any future scale
result must carry a validity arm.


## E079 - Package Cache ACL boundary and sentinel (2026-08-31)

Classification: `MEASURED_SIMULATOR`.

- The latest Burn log identifies the exact bundle cache target as
  `C:\Users\josuemorais\AppData\Local\Package Cache\{a10fbb63-03ff-4b8c-a176-f5fd355f715b}`;
  it does not exist. The parent exists with attributes `Directory`, owner
  `BUILTIN\\Administradores`, and four inherited allow rules.
- The current process is `PC_UFU_Josue\\CodexSandboxOffline`, SID
  `S-1-5-21-3846247477-1191926843-2878787821-1004`. The parent ACL grants
  `PC_UFU_Josue\\CodexSandboxUsers` only `ReadAndExecute, Synchronize`, while
  `PC_UFU_Josue\\josuemorais`, Administrators, and SYSTEM have FullControl.
- A new random child sentinel failed on `Directory.CreateDirectory` with access
  denied (`0x80131501` PowerShell wrapper); no child was left behind.
  Read-only `icacls /verify` passed for `Package Cache`, `Local`, and `AppData`.
- No ACL, installer, Python, firmware, QEMU, production, watchdog/reset,
  ABI, transport, or Git artifact changed. `ESP32_MWDT_BEHAVIOR` remains open.

## E082 - No pre-existing direct MSI extractor available (2026-09-01)

Classification: `MEASURED_SIMULATOR`.

- A bounded read-only inventory checked `Get-Command`/PATH and searched the
  local installed-program roots `C:\Program Files`, `C:\Program Files (x86)`,
  `C:\Users\josuemorais\AppData\Local\Programs`,
  `C:\Users\josuemorais\scoop\apps`, and
  `C:\Users\josuemorais\AppData\Local\Microsoft\WinGet\Packages` for
  `lessmsi.exe`, `dark.exe`, `7z.exe`, `7za.exe`, and `7zz.exe`.
- No candidate executable was found. Consequently there is no literal path,
  version, SHA-256, or Authenticode signer/publisher to record, and no MSI
  extraction was attempted.
- No download, installation, ACL/PATH/registry change, source/build/QEMU run,
  firmware artifact, production binary, watchdog/reset semantic, ABI,
  transport, or Git artifact changed. `ESP32_MWDT_BEHAVIOR` remains open.

## E081 - core.msi administrative extraction boundary (2026-09-01)

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`.

- `orchestrator/.ai/python310_payloads_74/core.msi` measured 1,687,552 bytes,
  SHA-256 `C5DECE7FB0F13B86A7AC721EF1575992A6A6D076FFAA0B6B6BA7DE120B2E64F4`,
  Authenticode `Valid`, signer Python Software Foundation.
- Exactly one bounded `msiexec /a core.msi /qn TARGETDIR=<new project-local
  image> /L*v <log>` ran. It returned 1603, extracted zero files, and the
  log records error 2502 during `ADMIN`, then `MainEngineThread is returning
  1603`.
- Pre/post snapshots report `CACHE_DIFF=0`, `REGISTRY_DIFF=0`, and identical
  process, user, and machine PATH. No installation state or project semantic
  artifact changed. The administrative route is unresolved and needs review.

## E080 - Python 3.10.11 payload acquisition and Burn layout validation (2026-08-31)

Classification: `MEASURED_SIMULATOR`.

- Python 3.12 `urllib` with its default verified SSL context acquired the 21
  distinct official Python 3.10.11 x64 MSI payloads into the fresh project-local
  `.ai/python310_payloads_74` directory. Every final URL remained on
  `python.org`; `inventory.json` records URL, final URL, size, and SHA-256 for
  all 22 files including the already verified bundle EXE (49,434,624 bytes).
- The payload names are `ucrt.msi`, `core.msi`, `core_d.msi`, `core_pdb.msi`,
  `dev.msi`, `dev_d.msi`, `doc.msi`, `exe.msi`, `exe_d.msi`, `exe_pdb.msi`,
  `lib.msi`, `lib_d.msi`, `lib_pdb.msi`, `path.msi`, `pip.msi`, `tcltk.msi`,
  `tcltk_d.msi`, `tcltk_pdb.msi`, `test.msi`, `test_d.msi`, `test_pdb.msi`,
  and `tools.msi`; these map across Burn's 52 planned packages.
- Re-running the hash/AuthentiCode-verified bundle with `/layout` against that
  directory completed with exit code 0. Burn planned 52 packages, acquired
  every required local payload, reported `Apply complete, result: 0x0`, and
  exited `0x0`; the log is `.ai/python310_layout_74_burn.log`.
- No MSI was executed, no Python was installed, and no ACL, PATH, registry,
  firmware, QEMU, production source/binary, watchdog/reset semantic, ABI,
  transport, or Git artifact changed. `ESP32_MWDT_BEHAVIOR` remains open.

## E080 - supported Python layout route blocked at payload acquisition (2026-08-31)

Classification: `MEASURED_SIMULATOR`.

- The bounded command used the already verified
  `orchestrator\\.ai\\python310_staging\\python-3.10.11-amd64.exe` with
  `/layout`, `/quiet`, `InstallAllUsers=0`, `PrependPath=0`, and launcher/test
  disabled, targeting the new project-local directory
  `orchestrator\\.ai\\python310_layout_73`. It returned exit code 773
  (`0x305`).
- Burn recorded `Plan begin, 52 packages, action: Layout` and completed
  planning without a Package Cache creation error. It then attempted the
  first absent payload `ucrt.msi` from
  `https://www.python.org/ftp/python/3.10.11/amd64/ucrt.msi`; the first
  failure was `0x80072efd`, followed by retry failures `0x80090305`, and the
  apply result was `0x80090305`.
- The layout directory contains only the copied installer
  `python-3.10.11-amd64.exe`, 29,037,240 bytes, SHA-256
  `D8DEDE5005564B408BA50317108B765ED9C3C510342A598F9FD42681CBE0648B`,
  Authenticode status `Valid`, signer `Python Software Foundation`. No
  `ucrt.msi` or official core/exe/lib/pip MSI payload exists there. Burn log:
  `%TEMP%\\Python 3.10.11 (64-bit)_20260831234550.log`, 36,484 bytes,
  SHA-256 `664A3FFE7B752F2940B32FFF9D38C41201F656F70C72CC4E87879677B8981882`.
- No install, Python executable, MSI execution, PATH/global mutation, ACL,
  firmware, QEMU, production, watchdog/reset, ABI, transport, or Git artifact
  changed. `ESP32_MWDT_BEHAVIOR` remains open.

## E078 - verified Python 3.10.11 artifact acquisition (2026-08-31)

Classification: `MEASURED_SIMULATOR`.

- Python 3.12 urllib with its default certificate-validating OpenSSL stack
  returned HTTP 200 from the exact approved final URL; Content-Length and
  streamed byte count were both 29037240.
- SHA-256 matched
  `D8DEDE5005564B408BA50317108B765ED9C3C510342A598F9FD42681CBE0648B`.
- `Get-AuthenticodeSignature` reported `Valid`; signer subject was
  `CN=Python Software Foundation, O=Python Software Foundation, L=Beaverton,
  S=Oregon, C=US`.
- The validated `.part` was atomically renamed to
  `orchestrator/.ai/python310_staging/python-3.10.11-amd64.exe`; the installer
  was not executed. No source, build, QEMU, watchdog/reset semantic, ABI,
  transport, or Git artifact changed; `ESP32_MWDT_BEHAVIOR` remains open.

## E063 - pure ESP-IDF IWDT fixture and build precondition (2026-08-31)

Classification: `SOURCE_PROVEN` + `INFERRED` / `INFRASTRUCTURE BLOCKED`

- Created `vnext_prototype/guest_iwdt_espidf` as a pure ESP-IDF 4.4.7 fixture;
  its README records official `int_wdt.c`, MWDT1/TG1, CPU1 liveness checking,
  300 ms timeout, and control/starvation modes.
- PlatformIO attempted missing `toolchain-xtensa-esp-elf 14.2.0+20251107` and
  failed unpacking with `[Errno 28] No space left on device`.
- Direct IDF Python verification reported missing pinned requirements including
  `click`, `cryptography`, `pyparsing`, `idf-component-manager`, `urllib3<2`,
  `pygdbmi`, `reedsolo`, `bitstring`, `ecdsa`, and `construct`.
- Only `.pio/build/project.checksum` exists. No generated configuration,
  linkage artifacts, image, or QEMU result exists; runtime is forbidden until
  those proofs pass. No production/QEMU semantic or ABI code changed.

## E064 - ESP-IDF interrupt-WDT-disabled fixture build blocked (2026-08-31)

Classification: `SOURCE_PROVEN` + `INFERRED`

- The selected fixture now uses `framework = arduino, espidf` and a project
  `sdkconfig.defaults` containing `CONFIG_ESP_INT_WDT=n` and
  `CONFIG_ESP_INT_WDT_CHECK_CPU1=n`.
- The Arduino-only build cannot prove framework interrupt-WDT init is absent
  because its framework is precompiled; the ESP-IDF path is required.
- With `PLATFORMIO_CORE_DIR=C:\SourceCode\LasecSimul\.piohome`, PlatformIO
  installed ESP-IDF 4.4.7 and required tools, but the build stalled during IDF
  Python dependency installation. No sdkconfig, map, valid image, or runtime
  session was produced; no watchdog result is inferred.
- No QEMU source/binary, canonical SHA, production firmware, transport, ABI,
  or watchdog/reset semantics changed.

`evidence_revision` is tracked in `.ai/state.json`. Increment it only for materially new evidence.

## E063 - Guest-only TG1 isolation attempt (2026-08-31)

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`.

- Source audit confirms the fixture already calls `disableCore0WDT()`, `disableCore1WDT()`, and `esp_task_wdt_deinit()`; Arduino `loopTask` feeds only when `loopTaskWDTEnabled` is true.
- The guest-only attempt changed stage 0 to `TIMG_WDT_STG_SEL_OFF`, moved one-time programming to the first `loop()` after 2 s, and set holds 50/100. No QEMU source or watchdog/reset semantics changed.
- Guest build passed; merged image SHA `80D21D1FBEB8002D8135266DC39A682F0A33ECB2C8CDBA85084C70055D394527`. Canonical QEMU SHA remained `427888AD4E50B7DDB2B98E03037675BB43FB6A13275397D432B6485C1401DE09`.
- One bounded 12 s canonical run stopped cleanly, but no TG1 record reflected the fixture's 50/100 holds or stage-0-off setting. TG1 still showed 21 configs, 1 feed, and one stage-0/mode-1 expiry; no `MWDT_CPU_STAGE` or `MWDT_SYS_STAGE` marker appeared.
- This attempt is non-classifying for TG1 and shows that delaying programming into Arduino `loop()` did not establish fixture control. Do not declare root cause or rerun unchanged.

## E062 - TG1 opt-in QEMU observation (2026-08-31)

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`.

- Added only `LASECSIMUL_TG1_WDT_TRACE`-gated labels to the existing QEMU config/feed/arm/expiry diagnostic sites; default behavior and TG0 diagnostics remain unchanged.
- QEMU build passed (981/981); canonical SHA `427888AD4E50B7DDB2B98E03037675BB43FB6A13275397D432B6485C1401DE09`. Firmware build passed; merged image SHA `86C40759AF69A04588EECA5AFF64A96F46D64F5269C40EF179C113428F02D394`.
- One canonical 12 s session exited cleanly, stderr 23,861 bytes, no residual QEMU. TG1 counts: config=22, feed=1, arm=4, expire=1.
- TG1 feed occurred at virtual 1.6517846 s, arm stage 0 at 1.6641540 s, config rewrites occurred at 2.0765053 s and 2.1118442 s, and expiry was stage 0/mode 1 at 2.1479643 s. No `MWDT_CPU_STAGE`, `MWDT_SYS_STAGE`, or CPU1 reset attribution appeared.
- This proves TG1 observation and framework reconfiguration/expiry, not the intended no-feed precondition or stage-1 CPU1 routing. `ESP32_MWDT_BEHAVIOR` remains open; no root cause is declared. Artifact: `vnext_prototype/mwdt_diagnostic_stderr.log`.

## E036 - Iteration 29 canonical patch revalidation

Classification: `SOURCE_PROVEN` + infrastructure constraint

- Reviewer-directed inspection at `C:\SourceCode\qemu_lasecSimul` confirms
  `vnext_trace_enabled()` remains at `softmmu/vnext_b.c:60-65`, while the
  diagnostic-only `[VNEXT_PROBE]` writes remain unguarded at the established
  MMIO and startup sites (`164-175`, `233-239`, `466-568`).
- The exact approved guard-only patch was rejected by the executor filesystem
  boundary before modification. No shell-write workaround or copied source was
  used.
- No build, runtime launch, staged binary/hash update, ABI, transport,
  watchdog/reset, dispatcher, backpressure, timeout, queue-depth, rollback, or
  Git change occurred. The VNEXT_TRACE/HOT-PATH gate remains open.

## E001 — Foundation / production architecture

Classification: SOURCE_PROVEN + MEASURED_SIMULATOR

- VNEXT foundation prototype frozen and PASS.
- Generic ProducerLane/ResponseSlot/doorbell architecture integrated.
- Causal I2C response path corrected to ResponseSlot + Core→Artifact doorbell.
- Redundant causal C2A notification accumulation removed.
- Restart/P9/backpressure gates previously PASS.
- Shared dispatcher resource architecture previously PASS.
- 16-session production normal scale previously PASS: 1201 submissions / 1201 completions, no semantic routing errors.

## E002 — Idle scale

Classification: MEASURED_SIMULATOR

16 idle sessions previously PASS with zero semantic transport activity/resets.

## E003 — Failure isolation

Classification: MEASURED_SIMULATOR

Victim detection/reclaim/A2 lifecycle has previously been demonstrated. Residual failure occurs under post-kill survivor continuity/load.

Latest valid run:

- 12/12 admission PASS
- victim kill PASS
- reclaim 12→11 PASS
- 11 survivor QEMUs alive
- harness remained in SURVIVORS_POST_KILL

No valid per-survivor progress classification was collected.

## E004 — Guest restart chain

Classification: SOURCE_PROVEN + MEASURED_SIMULATOR

`SW_APPCPU_RESET`:

- writer CPU0
- guest PC `0x40083e7a`
- symbol `soc_ll_reset_core`
- RTC_CNTL_OPTIONS0 address `0x3ff48000`
- bit 4 `SW_APPCPU_RESET`
- read-modify-write
- QEMU pulse/self-clear semantics

Observed restart order: CPU0 epoch N → APP CPU software reset → CPU0 software reset → CPU0 epoch N+1.

Same low-level sequence appears in good and bad sessions, so APP CPU reset itself is secondary restart behavior, not proven root cause.

## E005 — MWDT

Classification: SOURCE_PROVEN + MEASURED_SIMULATOR

- CPU1 can execute watchdog feed in some runs.
- CPU1 feed before first causal failure was not established.
- `MWDT_COMPENSABLE_TIME_SET = CPU0_ONLY`.
- Earlier active-pause accounting bug was fixed.
- Do not broaden compensation without new causal evidence.

## E006 — Fast-fail

Classification: MEASURED_SIMULATOR

Historical intermittent WER:

- `0xC0000409`
- subcode 7 / FATAL_APP_EXIT
- reports existed for harness and QEMU
- exact abort caller not captured

Current status: no new fast-fail in latest 12-session valid run; direct cause remains unknown; do not invent a root cause.

## E007 — Diagnostic hot-path cleanup

Classification: SOURCE_PROVEN

- TG0 feed diagnostics no longer perform fprintf/fflush in hot path.
- cpu_exec-wide `cpu_get_tb_cpu_state()` diagnostic removed.
- `vnext_b_i2c_submit()` residual per-I2C stderr logging now gated by `LASECSIMUL_VNEXT_TRACE`, default OFF.
- `VNEXT_HOT_PATH_UNCONDITIONAL_LOGGING = 0`.

## E008 — Current resource observation

Classification: MEASURED_SIMULATOR

During latest post-kill stall:

- physical RAM free ~322 MiB
- aggregate QEMU private bytes ~2.25 GiB
- aggregate QEMU working set ~988 MiB
- aggregate QEMU handles 10,408
- aggregate QEMU threads 74

Interpretation remains INCONCLUSIVE without growth/commit/paging attribution.

## E009 — Iteration 5 wait source trace and bounded-run result

Classification: SOURCE_PROVEN + MEASURED_SIMULATOR

Source proof:

- `core/test/core/mcu/VnextBProductionScaleTest.cpp:450-489` starts
  `SURVIVORS_POST_KILL`, records `postKillStart`, and waits until every
  non-victim completion counter is greater than its pre-kill baseline.
- The loop samples every 20 ms and times out at `postKillStart + 300 s`.
- The loop does not call `qemuLogs()`, join a thread, wait on a process handle,
  or perform victim teardown.
- `core/src/mcu/McuComponent.cpp:1293-1301` serializes `stopFirmware()` after
  `stopPolling()`; `core/src/mcu/qemu/VnextBAttachment.cpp:268-284` unregisters
  the wait token before stopping the process; `QemuProcessManager.cpp:310-347`
  bounds Windows reap and detaches only for a pathological orphan.

Runtime proof:

- The bounded 10-session run reached 9 successful admissions and stopped during
  `ADMISSION_10`, before victim kill and before `SURVIVORS_POST_KILL`.
- Process exit code: `-1073740791` = `0xC0000409` (FATAL_APP_EXIT class).
- No QEMU process remained after the run.

Interpretation: the current wait is a completion-counter barrier over all
survivors; a single survivor can keep the phase pending. The run adds a
reproduction of the historical fast-fail class, but no abort caller or causal
link to the post-kill stall was captured. Harness progress classification and
host pressure remain unresolved.

## E011 - Iteration 7 Release rebuild and baseline precondition

Classification: MEASURED_SIMULATOR + SOURCE PROVEN

Build proof:

- `cmake --build core/build --config Release --target vnext_b_production_scale_test --parallel 2` completed successfully.
- Produced `core/build/Release/vnext_b_production_scale_test.exe` at 11:04:56 on 2026-08-31.
- The previous Eigen FetchContent failure did not recur; the existing `core/build/_deps/eigen-src` and `eigen-build` were usable.

Runtime proof:

- One-session failure-isolation invocation returned exit code 0 with: `SKIPPED: LASECSIMUL_TEST_FIRMWARE and LASECSIMUL_TEST_QEMU_BINARY are required`.
- No session was admitted and no QEMU process was started.
- Workspace audit found the development QEMU executable but no test firmware artifact suitable for `LASECSIMUL_TEST_FIRMWARE`.

Interpretation: the build blocker is cleared, but the admission diagnostic remains untested. This is an external test-input precondition, not evidence for or against `SURVIVORS_POST_KILL`, and no root cause is declared.

## E010 — Iteration 6 admission baseline and diagnostic preparation

Classification: MEASURED_SIMULATOR + SOURCE_PROVEN

Runtime proof:

- With the existing Release executable and the same firmware/QEMU paths,
  `LASECSIMUL_FAILURE_ISOLATION=1`, `LASECSIMUL_SCALE_SESSIONS=10` timed out at
  `ADMISSION_1` after the 120 s admission deadline; exit code was 1.
- A one-session baseline with identical inputs also timed out at
  `ADMISSION_1` after 120 s; exit code was 1.
- No `vnext_b_production_scale_test` or `qemu-system-xtensa` process remained
  after either bounded run.
- Application event-log query returned no matching 1000/1001/1026/1002 event
  in the sampled window. This does not identify the terminating component.

Source proof / bounded diagnostic:

- `core/test/core/mcu/VnextBProductionScaleTest.cpp` now prints one
  `ADMISSION_FAILURE_DIAGNOSTIC` containing session, execution ID, QEMU PID,
  `firmwareRunning`, submissions, completions, and `startError`, followed by a
  maximum 2000-byte `qemuLogs()` tail.
- This diagnostic is reached only on admission progress timeout and does not
  alter transport, scheduler, reset, backpressure, dispatcher, or ABI
  semantics.

Build/runtime limitation:

- Rebuild through the existing Visual Studio/CMake tree was attempted, but
  CMake reran and failed during FetchContent Eigen population with
  `CMake step for eigen failed: no such file or directory`.
- Therefore the new diagnostic is source-proven but not yet present in the
  executable used for the two reproductions.

Interpretation: failure is reproducible even at one session, so the latest
result cannot be attributed to multi-session admission pressure or to
`ADMISSION_10`. It remains unresolved whether the guest/QEMU stopped before
semantic progress or whether launch/runtime state was invalid. No root cause
is declared.

## E012 - Reviewer action: valid firmware/QEMU baseline

Classification: SOURCE PROVEN + MEASURED_SIMULATOR

Build proof:

- `cmake --build core/build --config Release --target vnext_b_production_scale_test -j 8` completed successfully.
- The Release harness was rebuilt after the bounded survivor snapshot change.

Launch-path proof:

- The literal `C:\SourceCode\qemu_lasecSimul\build-ucrt64\qemu-system-xtensa.exe`
  could not start standalone and returned `-1073741515` (`0xC0000135`), because
  its adjacent runtime DLL set is required.
- The canonical test runtime is
  `C:\SourceCode\LasecSimul\vnext_prototype\dev_qemu_runtime\qemu-system-xtensa.exe`,
  with the required DLLs present.
- Firmware used:
  `C:\SourceCode\LasecSimul\vnext_prototype\guest_i2c_workload\.pio\build\esp32\merged.bin`.

Runtime proof using `VNEXT_B`, `tb-size=64`, and failure-isolation mode:

- `ADMISSION_1`: PASS.
- `VICTIM_KILL`: PASS.
- `FAILED_SESSION_RESOURCES_RECLAIMED`: PASS.
- `START_A2` replacement progress: PASS.
- `FAILED_SLOT_REUSE`: PASS.
- `SAME_DISPATCHER_INSTANCE_FOR_A_AND_A2`: PASS.
- `SURVIVORS_PROGRESS_DURING_REPLACEMENT`: PASS.
- `STALE_A_EFFECT_ON_A2=0`.
- `PRODUCTION_SESSION_FAILURE_ISOLATION`: PASS.

Measured baseline:

```text
ADMISSION session=0 active=1 first_progress_ms=7379
victim pid=9532 executionId=8657285669703846284
replacement executionId=11919550536682535934 pid=19324
submissions=1 completions=1
```

## E013 - QEMU provenance/runtime identity — 2026-08-31

Classification: SOURCE PROVEN + MEASURED ARTIFACT

- Repository `C:\SourceCode\qemu_lasecSimul`, `main`, HEAD
  `9dc30419a5372756b555ad7926563dcda2215c79`, upstream parity `0/0`.
- Meson/Ninja UCRT64 build, Windows, TCG, `xtensa-softmmu`, GCC 16.1.0,
  binutils 2.46.1.
- Build executable and staged canonical runtime are identical by SHA-256:
  `58ED43B801E75D87C0B92EEE1ED4AE3A3C6D1C2178D5D893A40EAE0609F459D4`, size
  `61335458` bytes.
- Raw build launch without DLL staging returned `0xC0000135`; staged runtime is
  the valid launch path. Rollback hash remains
  `471AE54193CC7A86F6A448D53BC1E810F5B50D6EBAD1FE48FC34AA04F56F74CE`.
- Source is dirty; provenance is `LIKELY_CURRENT_WORKTREE`. No Git history or
  rollback artifact was changed.

## E014 - 10-session survivor localization evidence — 2026-08-31

Classification: MEASURED SIMULATOR/HARNESS EVIDENCE

Existing bounded snapshots reported `REAL_SURVIVOR_SEMANTIC_PROGRESS = 7/9`
with blocker set `{1,3}`. Both blockers had rising QEMU CPU time while
submissions/completions remained unchanged; reset lines were present. This is a
localization target, not a proven root cause. The one-session baseline passed
full failure-isolation accounting independently.

Interpretation: the previously missing external-input precondition is now
resolved for the development runtime. The packaged historical rollback binary
was not replaced. No production semantic root cause is declared.

## E015 - Iteration 8 admission reruns — 2026-08-31

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`

- The intended 10-session comparison timed out at `ADMISSION_1`, before victim
  kill and before `SURVIVORS_POST_KILL`.
- The admission diagnostic reported QEMU alive (`firmware_running=true`) with
  `submissions=0`, `completions=0`, and `start_error=none`; the QEMU tail had
  repeated `esp32_i2c_event ackERR` and SW_CPU_RESET records.
- A repeated one-session baseline independently timed out at `ADMISSION_1`
  with the same zero semantic counters and no start error.
- No test-harness or QEMU process remained after either bounded run.
- Source audit found unconditional `printf/fflush` for `ackERR` in both
  `esp32_i2c_finish_burst()` and `esp32_i2c_event()` in
  `C:\SourceCode\qemu_lasecSimul\hw\i2c\esp32_i2c.c`.

Interpretation: the current run is not admissible for survivor localization.
The ackERR output is source-proven diagnostic activity, but the evidence does
not yet distinguish expected functional NACKs from a logging/timing cause or
prove a reset/transport root cause. No semantic change is justified.

## E016 - Iteration 9 reconciliation and 10-session rerun - 2026-08-31

Classification: `SOURCE_PROVEN` + `MEASURED_SIMULATOR`

- Canonical staged QEMU and `build-ucrt64` executable hashes match:
  `58ED43B801E75D87C0B92EEE1ED4AE3A3C6D1C2178D5D893A40EAE0609F459D4`.
- Binary strings confirm the staged executable contains both ackERR paths and
  the existing I2C probe strings.
- The test wires `logic.i2c_ram` at address `0x3c` to GPIO21/22. Existing
  trace classified it as `componente opaco em SDA`, so this workload uses the
  electrical fallback; the device is not proven absent.
- One-session trace qualification passed in 7723 ms with all failure-isolation
  checks green and no ackERR/reset lines.
- Follow-up 10-session trace passed: 10/10 admission in 77903 ms, victim
  reclaim 10->9, `SURVIVORS_POST_KILL=9/9` in 178 ms, replacement,
  dispatcher, and stale-effect checks PASS; final isolation PASS.
- The trace emitted 2867 bounded fallback diagnostics, zero ackERR, and zero
  SW_CPU_RESET. Prior ackERR output is therefore not sufficient evidence of a
  functional cause; no root cause or semantic change is declared.

## E017 - Iteration 10 final-topology admission failure - 2026-08-31

Classification: MEASURED_SIMULATOR + SOURCE_PROVEN

- Canonical 16-session run reached 10/16 admissions, then timed out at
  ADMISSION_11 before victim kill; exit code 1.
- Session 10 was alive with firmware_running=true, submissions=0,
  completions=0, and start_error=none.
- QEMU tail repeated final-credit resumed-local/blocked and showed RTC reset
  count=6, source=RTC_RESET, boot_epoch=3. No processes remained afterward.

Interpretation: admission-scale evidence only; no survivor evidence, root
cause, or semantic production change is justified.

## E018 - Iteration 11 repeated 10-session failure-isolation run - 2026-08-31

Classification: `MEASURED_SIMULATOR`

- Canonical staged runtime and Release harness completed with exit code 0; no
  harness or QEMU processes remained after teardown.
- Admission passed 10/10 in 163382 ms; prior 16-session admission timeout did
  not reproduce at 10 sessions.
- Victim kill and reclaim passed (10 -> 9); dispatcher worker remained
  `7912804338718504226`.
- `SURVIVORS_POST_KILL=9/9` completed in 41411 ms. Snapshots showed 7/9 at
  T+5s and 8/9 at T+15/T+30; temporary NOT_PROGRESSED classifications had
  rising CPU time and later completed. This is latency/progress evidence, not
  a deadlock proof.
- Replacement progress, slot reuse, same-dispatcher identity, survivor
  continuity, stale-effect checks, and final accounting all passed.
- `i2c_consumed_delta` and `boot_epoch` remain `na` and are not treated as
  measured. No root cause or semantic change is declared.

## E019 - Iteration 12 final 16-session failure-isolation validation - 2026-08-31

Classification: `MEASURED_SIMULATOR`

- Canonical staged runtime and Release harness completed with exit code 0; no
  harness or QEMU processes remained after teardown.
- Admission passed 16/16 in `278084 ms`; victim session 10 was killed and
  resources were reclaimed `16 -> 15`.
- `SURVIVORS_POST_KILL=15/15` completed in `61532 ms`.
- Replacement progress, failed-slot reuse, same-dispatcher identity, survivor
  progress during replacement, stale-effect checks (`0`), and final accounting
  all passed; `PRODUCTION_SESSION_FAILURE_ISOLATION PASS`.
- Bounded snapshots measured temporary skew: `10/15` at T+5s, `11/15` at
  T+15s, `12/15` at T+30s, then eventual completion. `i2c_consumed_delta` and
  `boot_epoch` remain `na` and are not treated as measured.

Interpretation: the final topology is end-to-end passing in this run, with
transient progress skew but no persistent survivor blocker. This is not a
root-cause declaration. Gate closure is pending reviewer decision; architecture
remains frozen.

## E020 - Reviewer closure of failure-isolation gate - 2026-08-31

Classification: `MEASURED_SIMULATOR` + reviewer disposition

- Work reviewer approved closing `PRODUCTION_SESSION_FAILURE_ISOLATION` from
  E019 with architecture unchanged.
- The 16-session run passed admission, victim reclamation, all 15 survivor
  checks, replacement, stale-effect checks, final accounting, cleanup, and
  exit status.
- Transient progress skew resolved within the existing completion barrier; it
  is not a deadlock proof and no root cause is declared.
- No semantic transport, scheduler, reset, timeout, ABI, or backpressure
  change was made.

## E021 - Iteration 14 production combined workload validation - 2026-08-31

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`

- The first invocation used an incorrect environment key and stopped at
  `ADMISSION_1` with zero submissions/completions; no process remained. This
  setup mismatch is not classified as gate evidence.
- The corrected invocation used canonical staged QEMU, Release harness, the
  merged firmware, `LASECSIMUL_MCU_TRANSPORT=VNEXT_B`, and tb-size 64.
- Exit code was 0 with no residual harness or QEMU processes.
- Admission passed 16/16 in 126656 ms; victim was detected and resources
  reclaimed 16 -> 15; `SURVIVORS_POST_KILL=15/15` completed in 12831 ms.
- Replacement progress, failed-slot reuse, same-dispatcher identity,
  survivor continuity during replacement, A2 progress, stale-effect checks
  (`STALE_A_EFFECT_ON_A2=0`, `STALE_A_EFFECT_ON_SURVIVORS=0`), final accounting,
  and `PRODUCTION_SESSION_FAILURE_ISOLATION PASS` all passed.
- A T+5s snapshot showed temporary skew (14/15), including one running
  survivor with zero completion delta; the existing barrier later reached
  15/15. This is latency/progress evidence, not a root-cause claim.
- No ABI, dispatcher, ProducerLane, ResponseSlot/C2A, backpressure, reset,
  watchdog, timeout, or queue-depth change was made.

## E023 - Iteration 16 repeated shared dispatcher fairness validation - 2026-08-31

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`

- Canonical staged QEMU SHA-256 matched the manifest:
  `58ED43B801E75D87C0B92EEE1ED4AE3A3C6D1C2178D5D893A40EAE0609F459D4`.
- Two concurrent VNEXT_B sessions with the Release harness, merged firmware,
  failure-isolation mode, and numeric `tb-size=64` exited 0.
- Admissions passed 2/2 at 5226 ms and 8953 ms; reclaim passed 2 -> 1;
  survivor progress completed in 743 ms; replacement, failed-slot reuse,
  same-dispatcher identity, continuity, and final accounting passed.
- `STALE_A_EFFECT_ON_A2=0` and `STALE_A_EFFECT_ON_SURVIVORS=0`; no residual
  test-created QEMU or harness process remained after cleanup.
- No ABI, dispatcher, ProducerLane, ResponseSlot/C2A, backpressure, reset,
  watchdog, timeout, or queue-depth change was made.

## E022 - Iteration 15 shared dispatcher fairness validation - 2026-08-31

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`

- Reviewer-approved E021 closure was applied without source or semantic change.
- The smallest existing runtime validation used two concurrent VNEXT_B
  sessions, canonical staged QEMU SHA
  `58ED43B801E75D87C0B92EEE1ED4AE3A3C6D1C2178D5D893A40EAE0609F459D4`, and the
  Release `vnext_b_production_scale_test.exe` harness.
- Exit code was 0. Admissions passed at 7855 ms and 16997 ms; victim reclaim,
  survivor progress, failed-slot reuse, same-dispatcher identity, replacement
  progress, survivor continuity, and final accounting all passed.
- `STALE_A_EFFECT_ON_A2=0` and `STALE_A_EFFECT_ON_SURVIVORS=0`; no residual
  QEMU or harness processes remained after explicit cleanup.
- A separate three-second active-scale attempt reached zero submissions before
  the short measurement window and is excluded from gate evidence.
- No ABI, dispatcher, ProducerLane, ResponseSlot/C2A, backpressure, reset,
  watchdog, timeout, or queue-depth change was made.

## E024 - Iteration 17 final resource accounting validation - 2026-08-31

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`

- Audit located the existing bounded runner in
  `vnext_prototype/run_foundation_tests.ps1`, which compiles and executes
  `remaining_gates_test.cpp`; the source emits the structural
  `FINAL_RESOURCE_ACCOUNTING PASS` assertion line.
- The runner was executed with the installed MSYS2 UCRT64 toolchain and
  completed with exit code 0. The captured log is
  `vnext_prototype/iteration17_final_resource_accounting.log`.
- All invoked foundation/remaining checks passed, including
  `PROCESS_DEATH`, `16_SESSION_STRUCTURAL_SCALE`, `SESSION_FAILURE_ISOLATION`,
  `EXECUTION_POLICY_INDEPENDENCE`, `ESP32_SUFFICIENCY`,
  `GENERIC_ARTIFACT_SUFFICIENCY`, `FINAL_RESOURCE_ACCOUNTING`, and
  `VNEXT FOUNDATION PROTOTYPE PASS`.
- This runner did not launch QEMU or alter production transport semantics.
  No source, binary, ABI, dispatcher, backpressure, reset, watchdog, timeout,
  queue-depth, rollback artifact, or Git history change was made.

## E025 - Iteration 18 production TCG configuration validation - 2026-08-31

Classification: `SOURCE_PROVEN` + `MEASURED_SIMULATOR`

- Audit found no separately named `VNEXT_PRODUCTION_TCG_CONFIGURATION` runner.
  The smallest existing direct target is `core/build/Debug/esp32_adapter_test.exe`.
- The bounded target exited 0. It passed the default launch assertion for
  `-accel tcg,thread=multi`, confirmed default MTTCG omits `-icount`, and
  passed explicit deterministic/fail-closed mode assertions for
  `tcg,thread=single` plus `-icount`.
- Source proof: `core/test/core/mcu/Esp32AdapterTest.cpp:121-137` and
  `core/src/mcu/McuController.cpp:188-220`; test-only `tb-size` is numeric and
  bounded, while default production launch remains MTTCG.
- Existing production logs include `tcg,thread=multi,tb-size=64`; the canonical
  runtime SHA matched the manifest before validation.
- Captured output: `vnext_prototype/iteration18_vnext_production_tcg_configuration.log`.
  No QEMU, source, ABI, dispatcher, backpressure, reset, watchdog, timeout,
  queue-depth, rollback artifact, or Git history changed.

## E026 - Iteration 19 TCG closure and final ABI alignment audit - 2026-08-31

Classification: `SOURCE_PROVEN` + reviewer disposition

- Work approved closure of `VNEXT_PRODUCTION_TCG_CONFIGURATION` from E025;
  production launch semantics and frozen architecture remain unchanged.
- The final ABI audit inspected the shared Core ABI/mapping files, the Core
  attachment, and the QEMU vNext-B mirror in `qemu_lasecSimul/softmmu/vnext_b.c`.
- Core and QEMU preserve the same fixed-width field order for control, region,
  endpoint, lane, event, response, snapshot, ring, and C2A descriptors.
  Existing C/C++ layout checks record sizes of 96/176/88/72 B for
  event/control/response/snapshot and 48/24/56/32/56 B for endpoint/region/
  lane/snapshot-descriptor/C2A-descriptor.
- Existing mapping validation checks ABI magic/version, bounded counts,
  offsets, strides, alignment, extents, lane ownership, and C2A structure.
  No concrete ABI mismatch or accidental semantic change was found.
- No build, QEMU launch, source, binary, transport, dispatcher, backpressure,
  reset, watchdog, timeout, queue-depth, rollback artifact, or Git history
  change was made.

## E027 - Iteration 20 ESP32 MWDT load-independence source audit - 2026-08-31

Classification: `SOURCE_PROVEN`

- `esp32_timg_wdt_get_count()` derives MWDT progress from `QEMU_CLOCK_VIRTUAL`,
  APB frequency, prescaler, and count base; it does not read host CPU time or
  host scheduler load (`qemu_lasecSimul/hw/timer/esp32_timg.c:521-529`).
- Stage deadlines use that virtual count and bounded `wdt_time_scale`
  (`esp32_timg.c:599-625`); deterministic mode remains scale 1.
- Transport pause compensation is applied only to TG0 and only for CPU0;
  calls for CPU1 are ignored (`esp32_timg.c:650-705`). VNEXT passes its lane
  index (`qemu_lasecSimul/softmmu/vnext_b.c:117-123,442-451`).
- No dedicated MWDT load/behavior runner was found. This is a source audit
  only; no build, QEMU launch, watchdog, timeout, reset, ABI, transport, or
  Git change was made.

## E028 - Iteration 21 MWDT behavior runner compatibility check - 2026-08-31

Classification: `MEASURED_SIMULATOR` (setup/compatibility diagnostic only)

- The smallest existing real-QEMU controller target was run with the canonical
  staged executable and available I2C firmware.
- The Debug Core harness negotiated arena ABI v4 while canonical QEMU reported
  an incompatible ABI v5 descriptor (`version=5.0`, `descriptor=88`,
  `arena=1344`, `transport=1256`, `queue=32`).
- No admissible MWDT behavior evidence was produced. This is a
  harness/runtime-version mismatch, not evidence of a watchdog or reset fault.
- The test-created harness was terminated after the bounded timeout; no QEMU
  or harness process remained. No source, binary, ABI, transport, watchdog,
  reset, Git history, or rollback artifact changed.

## E029 - Iteration 22 compatible MWDT diagnostic run - 2026-08-31

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`

- The existing Release `vnext_b_production_scale_test.exe` was confirmed as a
  vNext-B-compatible behavior entry point. With canonical staged QEMU, merged
  I2C firmware, two sessions, failure isolation, and explicit realtime
  `LASECSIMUL_ESP32_WDT_SCALE=1`, it exited 0.
- Runtime checks passed: 2/2 admission, victim detection, reclaim 2 -> 1,
  survivor progress 1/1 in 26 ms, replacement progress, slot reuse, same
  dispatcher, continuity, and zero stale effects. No test-created process
  remained.
- The WDT diagnostic emitted no `[TG0_FEED]` records; `MWDT_FEED_CPU_DISTRIBUTION`
  was all zero. Reset diagnostics showed only cold-start and
  `SW_CPU_RESET_REGISTER`; no reset was attributed to MWDT expiry.
- Captured output is `vnext_prototype/iteration22_mwdt_behavior_scale1.log`.
  This is partial runtime evidence and does not establish MWDT stage/deadline,
  reset routing, or CPU1 behavior. Both MWDT gates remain open; no semantic
  watchdog, reset, ABI, transport, or Git change was made.
## E030 - Iteration 23 legacy dependency audit - 2026-08-31

Classification: `SOURCE_PROVEN`

- `core/src/mcu/McuController.cpp:270-295` selects `VnextBAttachment` only
  for `LASECSIMUL_MCU_TRANSPORT=VNEXT_B`; otherwise it opens `QemuArenaBridge`.
- `core/src/mcu/qemu/VnextBAttachment.cpp:200-214` removes the legacy arena
  argument, inserts the vNext mapping key, and sets the VNEXT_B environment.
- `C:\SourceCode\qemu_lasecSimul\softmmu\simuliface.c:631-632,711-712,945-946`
  routes reads/writes to `vnext_b_*` when active and to `m_arena` otherwise.
- `vnext_prototype/ESP32_VNEXT_SUPPORT_MATRIX.md:14-37` has no
  `NEEDS_VNEXT_MIGRATION` entry; migrated, local, unsupported, and limited
  peripherals remain explicitly classified.
- ESP32 I2C controllers are instantiated and vNext-bound at
  `C:\SourceCode\qemu_lasecSimul\hw\xtensa\esp32.c:742-750`.

Interpretation: legacy-looking peripheral `readReg`/`writeReg` calls are shared
MMIO hooks, not independent wire protocols. The audit is source-proven PASS;
no source, binary, ABI, transport, watchdog, reset, Git, or rollback artifact
changed. Gate closure is pending reviewer approval.

## E031 - Iteration 24 ESP32 support-matrix audit - 2026-08-31

Classification: `SOURCE_PROVEN`

- `vnext_prototype/ESP32_VNEXT_SUPPORT_MATRIX.md:11-29` classifies every declared capability as migrated, local-only, explicitly unsupported, or a documented limitation; no `NEEDS_VNEXT_MIGRATION` row exists.
- `C:\SourceCode\qemu_lasecSimul\hw\xtensa\esp32.c:658-788` composes the modeled peripherals and binds both I2C controllers through `esp32_i2c_vnext_bind` at lines 742-750.
- `esp32.c:791-803` maps I2S0/I2S1 as explicit unimplemented regions; no DAC, TWAI/CAN, or ESP32 DMA device is composed.
- The matrix's local-only and limited rows match the source: SPI, timers, MWDT/RTC, LEDC, and RMT are local QEMU state; SD/MMC and Wi-Fi/Bluetooth are bounded models without Core electrical/RF transport.

This is a read-only source audit. No source, binary, ABI, transport, watchdog, reset, Git, or rollback artifact changed. The support-matrix gate is ready for reviewer disposition; both MWDT gates remain open.

## E032 - Iteration 25 VNEXT trace/hot-path diagnostic I/O audit - 2026-08-31

Classification: `SOURCE_PROVEN`

- Reviewer-approved E031 closure was applied only to
  `ESP32_SUPPORT_MATRIX_AUDIT`; both MWDT gates remain open.
- `C:\SourceCode\qemu_lasecSimul\softmmu\vnext_b.c:60-65` makes
  `LASECSIMUL_VNEXT_TRACE` opt-in (`unset`/`0` disables the trace helper).
- However, `vnext_b_gpio_write()` at `vnext_b.c:207-218` unconditionally
  writes `[VNEXT_PROBE] I2C write` for selected MMIO addresses and up to eight
  `[VNEXT_PROBE] MMIO write` records, each followed by `fflush(stderr)`.
- This is source evidence that the `VNEXT_TRACE default OFF` / no residual
  hot-path diagnostic-I/O gate is not yet green. It is not a transport or
  watchdog root-cause finding, and no source, binary, ABI, dispatcher,
  backpressure, reset, timeout, Git, or rollback artifact changed.

## E033 - Iteration 26 VNEXT probe dependency audit - 2026-08-31

Classification: `SOURCE_PROVEN`

- The `[VNEXT_PROBE]` records in `qemu_lasecSimul/softmmu/vnext_b.c` are
  diagnostic-only. `vnext_b_gpio_write()` and `vnext_b_register_read()` use
  the bounded `vnext_probe_mmio_count`; no transport, register, reset,
  watchdog, ABI, or dispatcher state consumes the counter or emitted text.
- The MMIO probe blocks at lines 164-175 and 233-239, plus startup probes in
  `vnext_b_main()` at lines 466-568, bypass the existing
  `vnext_trace_enabled()` helper at lines 60-65. Thus `[VNEXT_PROBE]` is not
  uniformly opt-in even though the normal `[VNEXT_B_I2C]` trace is.
- The smallest safe cleanup is diagnostic-only: guard `[VNEXT_PROBE]` writes
  and matching `fflush(stderr)` calls with the existing helper, retaining the
  bounded counter and leaving `[VNEXT_B_DIAG]`, transport, CPU pause/resume,
  watchdog, reset, ABI, and dispatcher logic intact.
- No source, binary, runtime, ABI, transport, watchdog, reset, Git history, or
  rollback artifact changed in this audit.

## E034 - Iteration 27 guard-only cleanup write boundary - 2026-08-31

Classification: `SOURCE_PROVEN` + infrastructure constraint

- Re-read the authoritative QEMU source and confirmed the E033 finding:
  `[VNEXT_PROBE]` writes remain unguarded at the MMIO and startup sites in
  `C:\SourceCode\qemu_lasecSimul\softmmu\vnext_b.c`.
- The exact guard-only patch was attempted with the approved patch mechanism,
  which rejected writes outside the writable project root
  `C:\SourceCode\LasecSimul`. No source file was changed.
- No build, QEMU launch, binary, ABI, transport, watchdog, reset, Git history,
  or rollback artifact changed. The trace/hot-path gate remains open.

## E035 - Iteration 28 canonical-source write boundary recheck - 2026-08-31

Classification: `SOURCE_PROVEN` + infrastructure constraint

- The canonical dirty QEMU worktree was re-inspected; the exact E033 guard-only
  patch remains unapplied and all `[VNEXT_PROBE]` sites remain in the source.
- The approved `apply_patch` operation was retried against the canonical
  absolute path and was rejected because this executor is writable only under
  `C:\SourceCode\LasecSimul`.
- No shell-write workaround, copied source tree, build, QEMU launch, binary,
  ABI, transport, watchdog, reset, Git history, or rollback artifact changed.
- The trace/hot-path gate remains open pending dispatch of a writable task
  rooted at `C:\SourceCode\qemu_lasecSimul`.

## E037 - Iteration 30 canonical-root dispatch TLS failure - 2026-08-31

Classification: `INFERRED` infrastructure result

- Following reviewer direction, a delegated `codex exec` was launched with
  `C:\SourceCode\qemu_lasecSimul` as its working root and the exact approved
  guard-only patch/build/trace verification instructions.
- The delegated executor failed before reading or modifying source because
  its API connection repeatedly returned
  `invalid peer certificate: UnknownIssuer` for the Responses WebSocket and
  HTTPS fallback. No task result, patch, build, staged binary, or runtime log
  was produced.
- The canonical source remains unchanged with unconditional `[VNEXT_PROBE]`
  sites; no shell-write workaround, copied source, semantic change, or Git
  operation was performed. The trace/hot-path gate remains open.

## E038 - Iteration 31 canonical-root dispatch TLS retry failure - 2026-08-31

Classification: `INFERRED` infrastructure result

- A delegated `codex exec` was retried from `C:\SourceCode\qemu_lasecSimul`
  with the exact approved guard-only patch/build/trace instructions.
- It failed before reading or modifying source due to
  `invalid peer certificate: UnknownIssuer` on the Responses WebSocket and
  HTTPS fallback. No task result, patch, build, staged binary, or runtime log
  was produced.
- The canonical source remains unchanged with unconditional `[VNEXT_PROBE]`
  sites. No TLS bypass, shell-write workaround, copied source, semantic change,
  or Git operation was performed; the gate remains open.

## E039 - Iteration 32 delegated Codex certificate trust-path diagnosis - 2026-08-31

Classification: `MEASURED_SIMULATOR` + `INFERRED` infrastructure result

- Local clock was `2026-08-31T16:07:30-03:00`; DNS resolved `api.openai.com` to
  `172.66.0.243` and `162.159.140.245`. No HTTP/HTTPS/ALL proxy or CA override
  variables were configured; `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`,
  `SSL_CERT_DIR`, and `CURL_CA_BUNDLE` were unset.
- A default Node TLS 1.3 connection to `api.openai.com:443` succeeded with
  `authorized=true`; the presented chain was `api.openai.com` -> Google Trust
  Services `WE1` -> `GTS Root R4` -> GlobalSign Root CA. The local Windows root
  stores each contained 68 certificates. This is transport-level evidence only,
  not an authenticated API success.
- A normal authenticated `codex exec` read-only probe from
  `C:\SourceCode\qemu_lasecSimul` still failed before model execution: five
  Responses WebSocket retries and HTTPS fallback returned
  `invalid peer certificate: UnknownIssuer`. No source, build, staged binary,
  runtime, manifest, or Git change occurred.
- The mismatch is specific to the delegated Codex/Rust trust path versus the
  successful Node TLS path. No TLS bypass, custom CA injection, copied-source
  workaround, or semantic change is authorized. The VNEXT trace/hot-path gate
  remains open.

## E040 - Iteration 33 authenticated canonical-root app task write boundary - 2026-08-31

Classification: `MEASURED_SIMULATOR` + infrastructure constraint

- The authenticated delegated task confirmed the canonical QEMU worktree exists
  but is not writable under the active filesystem policy.
- The audit found 10 `[VNEXT_PROBE]` sites. Pre-patch source SHA-256:
  `cf94ed1eda9e32baddf70f804ef3a19893b0c20bdfcd45bb8257bfe8ddf54c35`.
- No patch, build, trace check, staged manifest refresh, source, binary, ABI,
  transport, watchdog, reset, architecture, or Git change occurred.
- This is an infrastructure boundary, not evidence for a transport/watchdog
  root cause; the VNEXT trace/hot-path gate remains open.

## E041 - Iteration 35 VNEXT trace guard build and bounded runtime checks - 2026-08-31

Classification: `SOURCE_PROVEN` + `MEASURED_SIMULATOR`

- Canonical-root write access was rechecked successfully. Only the existing `[VNEXT_PROBE]` diagnostic writes/flushes were wrapped with `vnext_trace_enabled()`; frozen transport, ABI, dispatcher, backpressure, watchdog/reset, timeout, polling, and queue semantics were untouched.
- Canonical UCRT64 xtensa-softmmu build completed successfully, recompiling `softmmu_vnext_b.c` and linking `qemu-system-xtensa.exe`.
- Built and staged executable SHA-256 values match: `4B5CA32823DD7B0049DB63BB46B42C695F6A5D922EB402DF0633D46AF2809B82`.
- Bounded one-session production test with merged I2C firmware passed at `LASECSIMUL_VNEXT_TRACE=0`: exit 0, 52/52 submissions/completions, `PRODUCTION_SCALE_1_ACTIVE PASS`, stderr 0 bytes, zero `[VNEXT_PROBE]` lines.
- The same test passed at `LASECSIMUL_VNEXT_TRACE=1`: exit 0, 51/51 submissions/completions. The aggregate harness did not expose QEMU startup probes, so retention is not claimed as a new direct measurement; prior trace-enabled QEMU logs show those probes. The gate remains open for reviewer disposition.
- No QEMU process remained. No commit, push, reset, clean, checkout, branch switch, rollback change, or unrelated source change was made.
- No source, binary, runtime manifest, frozen semantic behavior, or Git history changed.

## E042 - Iteration 36 direct trace-enabled one-session attempt - 2026-08-31

Classification: `MEASURED_SIMULATOR` + `INFERRED`

- Canonical staged QEMU ran with `LASECSIMUL_VNEXT_TRACE=1`, one session, merged firmware, and a bounded 3-second window. SHA remained `4B5CA32823DD7B0049DB63BB46B42C695F6A5D922EB402DF0633D46AF2809B82`.
- Intermittent admission failure occurred before workload progress: exit 1, zero submissions/completions, no functional PASS, zero `[VNEXT_PROBE]` lines. This cannot prove retention or close the gate.
- Captured QEMU stderr shows canonical argv, arena ABI v5 negotiation, initialization, and app-CPU startup reset. No root cause is inferred. Artifacts: `vnext_prototype/iteration36_trace1_direct.stdout.log` and `vnext_prototype/iteration36_trace1_direct.stderr.log`.

## E043 - Iteration 37 trace-enabled functional retry - 2026-08-31

Classification: `MEASURED_SIMULATOR` + `INFERRED`

- One bounded one-session invocation used the canonical staged QEMU, merged I2C
  firmware, `LASECSIMUL_VNEXT_TRACE=1`, realtime execution, and a 3000 ms run.
- Functional result passed: exit 0, `PRODUCTION_SCALE_1_ACTIVE PASS`, 982/982
  submissions/completions, one active session, zero lost/duplicate/wrong-session/
  response-misroute/stale/queue-overwrite/deadlock counters.
- Canonical staged SHA was unchanged before/after:
  `4B5CA32823DD7B0049DB63BB46B42C695F6A5D922EB402DF0633D46AF2809B82`.
- No QEMU or harness process remained after completion.
- Literal search of the separately captured harness stdout/stderr found zero
  `[VNEXT_PROBE]` lines. The initial shell summary reported six due to an
  incorrect wildcard character-class match and is superseded by the literal
  search. Probe retention is therefore not directly observed by this retry.
- No source, binary, runtime manifest, ABI, transport, watchdog/reset,
  dispatcher, backpressure, timeout, polling, queue, Git, or rollback change.

## E044 - Iteration 38 reviewer-approved VNEXT diagnostic-I/O closure and MWDT test setup - 2026-08-31

Classification: `SOURCE_PROVEN` + `MEASURED_SIMULATOR` + infrastructure constraint

- Work review approved closure of only `VNEXT_TRACE / HOT-PATH DIAGNOSTIC I/O`:
  all ten `[VNEXT_PROBE]` writes/flushes are guarded in the validated canonical
  binary; trace-off silence, trace-on functional PASS, unchanged staged SHA,
  and historical direct-QEMU trace output are sufficient evidence. No root
  cause or frozen semantic change is declared.
- The next bounded MWDT diagnostic attempt used the existing Release
  `vnext_b_production_scale_test.exe` with the canonical staged QEMU and the
  existing merged firmware path. QEMU negotiated arena ABI v5 and initialized,
  then Windows denied the child access to
  `C:\SourceCode\II1P04_GPIO_Debug\.pio\build\esp32\merged.bin`.
- The attempt produced no workload, MWDT feed, reset, or root-cause evidence;
  it is an infrastructure/setup blocker only. No QEMU/Core source, binary,
  ABI, transport, watchdog, reset, Git, or rollback artifact changed.

## E045 - Iteration 39 staged firmware MWDT diagnostic retry - 2026-08-31

Classification: `MEASURED_SIMULATOR` + infrastructure/diagnostic timeout

- The external firmware was readable: 4,194,304 bytes, SHA-256
  `275C7D097C0379F638E8FE1A4E6C4EFB5C4EDFE30650A7E6818743FD9944A6D6`.
- A runtime-input copy at `vnext_prototype/runtime_inputs/mwdt_behavior/merged.bin`
  was created and verified readable with identical size and SHA-256.
- The unchanged Release diagnostic was invoked once with only
  `LASECSIMUL_TEST_FIRMWARE` redirected to that copy; canonical QEMU and
  one-session/3000-ms bounded settings were retained.
- The bounded run timed out in `ADMISSION_1` and emitted
  `ADMISSION_FAILURE_DIAGNOSTIC session=0 ... firmware_running=true
  submissions=0 completions=0 start_error=none`; QEMU had initialized, mapped
  arena ABI v5, opened its doorbell, and entered its main loop. No MWDT feed,
  workload progress, or root-cause record was produced, and no process
  remained. This is not MWDT evidence and does not establish a root cause.
- No QEMU/Core source, ABI, transport, watchdog/reset, dispatcher,
  backpressure, timeout, polling, queue, Git, or rollback artifact changed.

## E049 - Iteration 42 bounded staged-firmware direct diagnostic - 2026-08-31

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`

- The unchanged Release `vnext_b_production_scale_test.exe` ran one session
  without failure-isolation, with canonical QEMU, trace enabled, staged
  firmware, and `LASECSIMUL_SCALE_RUN_MS=20000`.
- The result reported `firmware_running=true`, `submissions=0`,
  `completions=0`, and `PRODUCTION_SCALE FAIL failures=1`. QEMU reached
  initialization/main loop, then logged only reset count 1 (`source=OTHER`)
  and reset count 2 (`source=SW_CPU_RESET_REGISTER`,
  `expected=app-cpu-startup`). No I2C, TG0/MWDT feed, expiry, or MWDT reset
  records were present.
- Hashes revalidated: canonical QEMU
  `4B5CA32823DD7B0049DB63BB46B42C695F6A5D922EB402DF0633D46AF2809B82` and
  staged firmware
  `275C7D097C0379F638E8FE1A4E6C4EFB5C4EDFE30650A7E6818743FD9944A6D6`.
- This is not MWDT evidence or a root-cause declaration. No source, binary,
  ABI, transport, watchdog/reset, dispatcher, backpressure, timeout, polling,
  queue, Git, or rollback artifact changed; no test-created process remained.
## E046 - Iteration 40 admission timeout/capture source audit - 2026-08-31

Classification: `SOURCE_PROVEN` + `MEASURED_SIMULATOR`

- `core/test/core/mcu/VnextBProductionScaleTest.cpp:311-331` performs failure-
  isolation admission serially. Each session receives a fixed 120-second
  deadline; readiness requires `firmwareRunning()` plus at least one I2C
  submission and one completion. The only wait action is a 20 ms sleep, with
  no intermediate progress/heartbeat output.
- On expiry the harness emits `TIMEOUT_PHASE`, captures only the last 2000
  bytes of `qemuLogs()`, prints the admission diagnostic, calls
  `stopSimulation()` for every session, and returns 1. A run can therefore
  remain externally visible as `ADMISSION_1` for the full admission deadline
  while QEMU remains alive but the counters stay zero; no exit result is
  available until cleanup returns.
- `core/src/mcu/qemu/QemuProcessManager.cpp:296-306,363-387` continuously
  drains the combined Windows stdout/stderr pipe on a reader thread and caps
  retained logs at 1 MiB. Capture is not a pipe-backpressure explanation for
  this observation.
- `vnext_prototype/iteration39_mwdt_behavior_staged_firmware.log` matches the
  timeout branch: `firmware_running=true`, `submissions=0`,
  `completions=0`, `start_error=none`, followed by QEMU initialization/main
  loop output. No MWDT feed, workload, or reset evidence was produced.
- No source, build, runtime, ABI, transport, watchdog/reset, dispatcher,
  backpressure, Git, or rollback artifact changed. No root cause is declared.

## E047 - Iteration 40 bounded staged-firmware progress diagnostics - 2026-08-31

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`

- Existing non-failure-isolation one-session runs used canonical QEMU and staged
  firmware SHA `275C7D097C0379F638E8FE1A4E6C4EFB5C4EDFE30650A7E6818743FD9944A6D6`.
  Two 3 s runs and one 10 s run all exited 1 with `firmware_running=true`,
  `submissions=0`, and `completions=0`.
- The first 3 s run observed TG0 stage-0 enabled in mode 1, prescaler 40000,
  APB 80 MHz, timeout 10000 cycles, and repeated feeds/rearms at the 500 ms
  virtual deadline. No MWDT reset was observed.
- Reset traces in the retry and 10 s run contained only initial reset and
  `SW_CPU_RESET_REGISTER` app-CPU startup, plus `APP_CPU_RESET_R6` with
  `halted=0, exit_request=1`. The retry captured no TG0 feed.
- The staged GPIO-debug firmware differs from the historical I2C workload:
  staged SHA `275C...4A6D6`; workload SHA
  `965DF6EDBC11BD190BDDF6C48BEF97DD314AB4CF330F34E98B07D392E4CA3B38`.
  Existing documentation records approximately 6.5-7 s boot/I2C delay for
  the GPIO-debug firmware, explaining the 3 s zero-progress result but not yet
  the 10 s result.
- Artifacts: `vnext_prototype/iteration40_scale1_mwdt.stdout.log`,
  `iteration40_scale1_mwdt_retry.stderr.log`, and
  `iteration40_scale1_mwdt_10s.stderr.log`. No source, build, runtime,
  ABI, transport, watchdog/reset, dispatcher, backpressure, timeout, polling,
  queue, Git, or rollback artifact changed. No root cause is declared.

## E048 - Iteration 41 boot/firmware-path comparison - 2026-08-31

Classification: `SOURCE_PROVEN` + `MEASURED_SIMULATOR`

- `Esp32Adapter.cpp:2138-2164` builds the same `esp32-simul`, ROM `-L`,
  `-drive file=<path>,if=mtd,format=raw`, and default `tcg,thread=multi` argv
  for both images. `McuController.cpp:181-240` and `McuComponent.cpp:1244-1284`
  only apply common launch options and start the selected path; no
  firmware-name-specific admission predicate was found.
- Historical `guest_i2c_workload/src/main.cpp:13-35` calls
  `Wire.begin(21,22,100000)` in setup, then performs an explicit I2C write and
  repeated reads in loop.
- Staged GPIO-debug is built from `II1P04_GPIO_Debug/platformio.ini` with
  `build_src_filter = +<esp2.cpp>`. Its `src/esp2.cpp:14-50` reaches I2C via
  `disp.begin(21,22)`, which calls `Wire.begin` and `SSD1306.begin(...,0x3C)`;
  framebuffer I2C occurs only after setup reaches `disp.update()`.
- The launch path is therefore shared, but the staged image is a materially
  different, display-dependent application. This makes 3 s zero progress
  compatible with boot/application latency, but does not explain 10 s zero
  progress. No root cause or semantic fix is declared.
- No source, build, runtime, ABI, transport, watchdog/reset, dispatcher,
  backpressure, timeout, polling, queue, Git, or rollback artifact changed.

## E050 - Iteration 43 staged-vs-good boot/I2C source audit - 2026-08-31

Classification: `SOURCE_PROVEN` + `INFERRED`

- The staged image is built exclusively from `src/esp2.cpp`. Its `setup()` calls
  `disp.begin(21,22)`, which calls `Wire.begin(SDA,SCL)` without an explicit
  clock rate, then `SSD1306.begin(...,0x3C,false,false)`. Only after that does
  setup configure text and call `disp.update()`; its first framebuffer transfer
  is `SSD1306.display()` (1024 bytes at the display-library path). `loop()`
  retries display initialization with a 1-second backoff when not ready.
- The historical `guest_i2c_workload/src/main.cpp` calls
  `Wire.begin(21,22,100000)` directly in `setup()`, then immediately submits a
  short write to address `0x3c`; its read follows only after that write. The
  images therefore have materially different first-I2C command paths and
  boot/application work, despite sharing the same QEMU argv.
- QEMU `hw/i2c/esp32_i2c.c:82-125,132-167,335-447` emits a VNEXT I2C request
  only after guest I2C MMIO has populated a command list and asserted
  `I2C_TRANS_START`; no I2C trace is expected before that guest branch. QEMU
  `hw/xtensa/esp32.c:212-264,278-340` distinguishes expected APP CPU startup
  (`SW_CPU_RESET_REGISTER`, second reset) from watchdog CPU reset
  (`MWDT_CPU_STAGE`) without changing reset semantics.
- E049's zero I2C counters and absence of TG0/MWDT events are consequently
  pre-workload evidence, not watchdog evidence. No root cause or semantic fix
  is declared; no source, binary, ABI, transport, watchdog/reset, dispatcher,
  backpressure, timeout, polling, queue, Git, or rollback artifact changed.

## E051 - Iteration 44 bounded staged-firmware APP-CPU reset trace diagnostic - 2026-08-31

Classification: `MEASURED_SIMULATOR` + `INFERRED`

- The unchanged Release harness ran one failure-isolation session with canonical QEMU, staged firmware SHA `275C7D097C0379F638E8FE1A4E6C4EFB5C4EDFE30650A7E6818743FD9944A6D6`, existing I2C/TG0 traces, and only `LASECSIMUL_APP_CPU_RESET_TRACE=1` added.
- It timed out at `ADMISSION_1`: `firmware_running=true`, `submissions=0`, `completions=0`, `start_error=none`; exit code 1 and no test-created process remained.
- The retained log has repeated TG0 stage-0 feed/rearm records through virtual time ~120.03 s and many I2C fast-path diagnostics, but no `APP_CPU_RESET`, `APP_CPU_RESET_WRITE`, `MWDT_CPU_STAGE`, ESP32 reset, or TG0 `EXPIRE` record. This does not establish guest VNEXT I2C progress or distinguish CPU1 reset state.
- Canonical QEMU SHA remained `4B5CA32823DD7B0049DB63BB46B42C695F6A5D922EB402DF0633D46AF2809B82`; no source, binary, ABI, transport, watchdog/reset, dispatcher, backpressure, timeout, polling, queue, Git, or rollback artifact changed. No root cause is declared.

## E054 - Iteration 47 bounded success-path QEMU log exposure

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`

- `VnextBProductionScaleTest.cpp` now exposes the already bounded
  `qemuLogs()` buffer only when `LASECSIMUL_DUMP_SUCCESS_QEMU_LOG` is set,
  immediately before normal `stopSimulation()`. The hook does not alter
  execution, predicates, timing, transport, or production behavior when unset.
- The canonical Release one-session run used staged QEMU SHA
  `4B5CA32823DD7B0049DB63BB46B42C695F6A5D922EB402DF0633D46AF2809B82`,
  20,000 ms, I2C trace off, `APP_CPU_RESET_TRACE=1`, and
  `TG0_WDT_FEED_TRACE=1`. It exited 0 with 3,631 submissions and 3,631
  completions; loss, misroute, overwrite, and deadlock were all zero.
- The success dump reported 956,792 retained QEMU-log bytes. The retained
  window began at virtual time approximately 8.114 s and contained 9,395
  `[MWDT_PAUSE] ignored cpu=1` records. It contained zero
  `TG0WDT EXPIRE`, `TG0_FIRST_RESET_ACCOUNTING`, `APP_CPU_RESET_WRITE`,
  `APP_CPU_RESET_R4/R6`, `ESP32 reset`, or `SW_CPU_RESET_REGISTER` markers.
- Since the bounded retained window starts after boot and high-volume
  CPU1-pause diagnostics evict earlier lines, marker absence does not prove
  that no reset/feed/expiry occurred before the window. `ESP32_MWDT_BEHAVIOR`
  therefore remains open; no root cause or watchdog/reset semantic change is
  authorized.
- Artifact: `vnext_prototype/iteration47_success_qemu_log.log`. The
  diagnostic hook remains opt-in and disabled by default.

## E053 - Iteration 46 low-volume existing diagnostic path - 2026-08-31

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`

- Unchanged Release one-session normal path ran 20 s with canonical QEMU,
  staged firmware, APP_CPU_RESET_TRACE=1, TG0_WDT_FEED_TRACE=1, and I2C trace
  unset. Exit 0: 288 submissions, 288 completions, zero loss/misroute/
  overwrite/deadlock; `PRODUCTION_SCALE_1_ACTIVE PASS`.
- Successful normal mode does not print or persist qemuLogs() before stopping,
  so no reset/MWDT marker was retained. CPU1 reset behavior remains unclassified.
- No source, binary, ABI, transport, watchdog/reset, dispatcher, backpressure,
  timeout, polling, queue, Git, or rollback artifact changed.

## E052 - Iteration 45 APP CPU reset producer and log-retention audit - 2026-08-31

Classification: `SOURCE_PROVEN` + `MEASURED_SIMULATOR`

- `qemu_lasecSimul/hw/misc/esp32_rtc_cntl.c:80-126` emits
  `[APP_CPU_RESET_WRITE]` only when `LASECSIMUL_APP_CPU_RESET_TRACE` is set and
  the guest writes the SW APP-CPU reset bit; the applied marker is
  `[APP_CPU_RESET_WRITE_APPLIED]`.
- `qemu_lasecSimul/hw/xtensa/esp32.c:237-264,278-340` emits async markers
  `[APP_CPU_RESET_R4]` and `[APP_CPU_RESET_R6]`; `SW_CPU_RESET_REGISTER` and
  `MWDT_CPU_STAGE` are selected before dispatch to that async path. The normal
  reset line is emitted by `esp32_log_reset()` at lines 212-235.
- `core/src/mcu/qemu/QemuProcessManager.cpp:303-306,363-388,427` continuously
  drains combined stdout/stderr but retains only 1 MiB and trims to 512 KiB.
  `core/test/core/mcu/VnextBProductionScaleTest.cpp:133-151` then retains only
  the newest 2000 bytes for an admission failure diagnostic.
- The E051 outer log is 43,853,714 bytes and contains about 303,098 I2C
  diagnostic matches; its retained admission tail contains TG0/I2C records but
  no reset marker. This is consistent with startup/reset output being evicted
  by high-volume diagnostics before the final 2000-byte dump.
- The harness reset predicate at `VnextBProductionScaleTest.cpp:194-200`
  recognizes `[APP_CPU_RESET_WRITE]` and `[LasecSimul][ESP32 reset]`; a bounded
  tail without those markers is non-diagnostic after earlier lines are evicted.
- No source, binary, ABI, transport, watchdog/reset, dispatcher, backpressure,
  timeout, polling, queue, Git, or rollback artifact changed. No MWDT root
  cause is established; `ESP32_MWDT_BEHAVIOR` remains open.

## E055 - Iteration 48 short low-volume startup/reset retention trace

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`

- The unchanged Release one-session harness used canonical QEMU and the
  historical guest I2C firmware for 3000 ms, with APP CPU reset and TG0 feed
  traces enabled, I2C trace unset, and the opt-in bounded success dump. It
  exited 1 at the short run boundary with `firmware_running=true`,
  `submissions=0`, and `completions=0`; no test-created process remained.
- The retained 3006-byte child log included the initial reset `source=OTHER`,
  then the expected app-CPU startup reset with
  `source=SW_CPU_RESET_REGISTER` and `expected=app-cpu-startup`, plus APP CPU
  R2/R4/R6 records around that path.
- The retained log contained zero TG0 feed, TG0 expiry/accounting, or
  `MWDT_CPU_STAGE` records. The run therefore classifies only the expected
  startup reset path, not steady-state MWDT feed behavior, CPU1 MWDT scope, or
  expiry/reset routing.
- Canonical runtime SHA remained
  `4B5CA32823DD7B0049DB63BB46B42C695F6A5D922EB402DF0633D46AF2809B82`.
  No source, ABI, transport, watchdog/reset, dispatcher, backpressure,
  timeout, polling, queue, Git, or rollback artifact changed. The gate
  `ESP32_MWDT_BEHAVIOR` remains open.

## E093 - CPython 3.8.10 assembly input-boundary audit (2026-09-01)

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`.

- The reviewer-approved assembly input set was checked before any MSI/CAB
  processing. The Burn-accepted layout
  `orchestrator/.ai/python38_layout_86_20260901T072000/` contains the signed
  installer, `core/exe/lib` `_d` and `_pdb` packages, and the Burn inventory,
  but no `core.msi`, `exe.msi`, or `lib.msi`.
- The layout Burn log records the base packages as absent and only acquires
  the `_d`/`_pdb` payloads. The only local files named `core.msi`, `exe.msi`,
  and `lib.msi` are under `orchestrator/.ai/python310_payloads_74/` and are
  CPython 3.10 payloads, so they are rejected for the 3.8.10 boundary.
- No MSI database read, CAB extraction, runtime assembly, process execution,
  dependency installation, PATH/registry/ACL mutation, firmware build, QEMU
  run, production-source/semantic change, or Git operation occurred.
  `ESP32_MWDT_BEHAVIOR` remains open. Reviewer direction is required on the
  missing 3.8.10 base MSI provenance before proceeding.
- Artifacts: `vnext_prototype/iteration48_low_volume.stdout.log` and
  `vnext_prototype/iteration48_low_volume.stderr.log`.

## E056 - Iteration 49 six-second low-volume canonical trace

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`

- The first invocation used unprefixed diagnostic shorthand and passed 908/908,
  but source audit showed the QEMU gates consume
  `LASECSIMUL_APP_CPU_RESET_TRACE` and `LASECSIMUL_TG0_WDT_FEED_TRACE`.
- Repeating the same bounded one-session Release run with the effective names,
  canonical QEMU, historical guest I2C firmware, I2C trace unset, and the
  opt-in success dump exited 0 with 848 submissions and 848 completions and
  zero lost/duplicate/wrong-session/misroute/stale/overwrite/deadlock counts.
- The 348293-byte retained child log contained two reset lines, the expected
  `SW_CPU_RESET_REGISTER` app-CPU startup path with R2/R4/R6, seven applied
  reset writes, and 3392 `[MWDT_PAUSE] ignored cpu=1` records. It contained
  zero `[TG0_FEED]`, TG0 config/arm/expiry/accounting, or `MWDT_CPU_STAGE`.
- Source proof: `qemu_lasecSimul/hw/timer/esp32_timg.c:166-183,562-590,727-795`
  gates these diagnostics on the prefixed variable and records CPU1 pause as
  ignored; `core/test/core/mcu/VnextBProductionScaleTest.cpp:53-95` parses
  feed records. Canonical SHA stayed
  `4B5CA32823DD7B0049DB63BB46B42C695F6A5D922EB402DF0633D46AF2809B82`.
- The run proves workload progress and CPU1 pause scope, not watchdog root
  cause. `ESP32_MWDT_BEHAVIOR` remains open; no source, binary, ABI,
  transport, watchdog/reset, dispatcher, backpressure, timeout, polling,
  queue, Git, or rollback artifact changed. Artifact:
  `vnext_prototype/iteration49_low_volume_correct_trace.log`.

## E057 - Iteration 49 read-only TG0 boot/configuration audit

Classification: `SOURCE_PROVEN`

- `vnext_prototype/guest_i2c_workload/src/main.cpp` contains only Arduino
  `Wire` setup, one write, repeated reads, serial output, and delays; it has no
  explicit TIMG WDT CONFIG0/FEED access or task-watchdog API call.
- The guest ELF map shows framework/ESP-IDF watchdog support objects and helper
  symbols, but that is library availability rather than proof that this
  workload configures or feeds TG0. QEMU's `esp32_timg.c:227-258` handles
  CONFIG0/FEED only after guest MMIO writes, while its trace at `166-183`
  records those writes when enabled.
- Therefore E056's zero TG0 feed/config markers are consistent with this
  workload's source and do not classify QEMU watchdog behavior or establish a
  root cause. No source/build/runtime artifact changed.

## E058 - Iteration 50 bounded existing TG0 diagnostic comparison

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`

- The unchanged Release one-session test ran for 6000 ms with canonical QEMU
  SHA `4B5CA32823DD7B0049DB63BB46B42C695F6A5D922EB402DF0633D46AF2809B82`,
  firmware `runtime_inputs/mwdt_behavior/merged.bin` SHA
  `275C7D097C0379F638E8FE1A4E6C4EFB5C4EDFE30650A7E6818743FD9944A6D6`, and
  `LASECSIMUL_TG0_WDT_TRACE=1` plus the effective feed trace.
- It exited 0 with 84 submissions and 84 completions; loss, duplicate,
  wrong-session, response-misroute, stale-acceptance, queue-overwrite, and
  deadlock counts were all zero. The retained child log was 1,178,824 bytes.
- The log contained 15 TG0 CONFIG0 records, about 3,005 TG0 WDT feed records,
  and about 3,017 arm records. It included initial framework config
  (`en=0`, `fb_en=1`, 40 MHz APB), later disabled/configured states, and an
  `en=1` state with `prescale=40000`, `mode0=1`, `mode1=3`, and `timeout0=10000`.
- It contained zero TG0 expiry, first-expiry accounting, `MWDT_CPU_STAGE`, or
  unexpected ESP32 reset markers; the only reset path was expected APP-CPU
  startup. This is bounded behavior evidence, not proof of all long-run
  stages or reset routing.
- Source proof: `qemu_lasecSimul/hw/timer/esp32_timg.c:166-183,227-258,
  532-596,716-795`; bounded retention is in
  `core/test/core/mcu/VnextBProductionScaleTest.cpp:151-160`.
- `ESP32_MWDT_BEHAVIOR` remains open. No source, build, runtime, ABI,
  transport, watchdog/reset, dispatcher, backpressure, timeout, polling,
  queue, Git, or rollback artifact changed. Artifact:
  `vnext_prototype/iteration50_mwdt_existing_diag.log`.
## E059 - Iteration 51 existing TG0 stage/reset path audit - 2026-08-31

Classification: `SOURCE_PROVEN` + `INFERRED`

- No existing test or diagnostic path was found that intentionally reaches TG0
  stage-1 expiry or a no-feed reset path. `VnextBProductionScaleTest.cpp`
  exposes bounded QEMU logs and parses MWDT/reset markers, but its available
  workload path is the continuously fed success diagnostic; extending it does
  not create expiry evidence.
- `qemu_lasecSimul/hw/timer/esp32_timg.c:716-810` reads the active stage mode,
  emits the existing expiry/accounting diagnostics, pulses the CPU or SYS WDT
  output, then advances `cur_stage` and rearms. This is source proof of the
  stage transition implementation, not runtime proof that stage 1 occurs in
  the current workload.
- `qemu_lasecSimul/hw/xtensa/esp32.c:321-351` maps WDT CPU reset input to
  `MWDT_CPU_STAGE`; APP CPU (`n==1`) uses `async_run_on_cpu(CPU(&s->cpu[1]),
  esp32_app_cpu_reset_async, ...)`, while SYS reset records
  `MWDT_SYS_STAGE`, sets both reset causes, and requests a guest reset.
- Existing SoC wiring at `qemu_lasecSimul/hw/xtensa/esp32.c:716-718` connects
  each TIMG CPU/SYS WDT output to the corresponding SoC reset input. No
  stage-1 or CPU1 reset-routing runtime marker was observed or newly generated.
- Canonical QEMU SHA-256 was revalidated as
  `4B5CA32823DD7B0049DB63BB46B42C695F6A5D922EB402DF0633D46AF2809B82`.
  No source, build, binary, ABI, transport, watchdog/reset, or Git artifact
  changed. `ESP32_MWDT_BEHAVIOR` remains open.
## E061 - isolated TG1 guest diagnostic (2026-08-31)

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`

- Changed only the guest-only diagnostic fixture's register target from TG0 to TG1 (`guest_mwdt_diagnostic/src/main.cpp:9-33,36-45`); production firmware, QEMU source, transport, and watchdog/reset semantics were unchanged.
- PlatformIO build passed and produced `merged.bin` SHA-256 `86C40759AF69A04588EECA5AFF64A96F46D64F5269C40EF179C113428F02D394`.
- One bounded 12 s run used canonical QEMU and stopped cleanly with no residual QEMU; canonical QEMU SHA remained `4B5CA32823DD7B0049DB63BB46B42C695F6A5D922EB402DF0633D46AF2809B82`.
- Retained stderr contained zero `TG1WDT`, `MWDT_CPU_STAGE`, `MWDT_SYS_STAGE`, TG0 expiry, and TG1-specific feed/config markers. It contained expected APP-CPU startup reset and TG0 framework configuration activity. Existing QEMU diagnostic gates are TG0-only at `qemu_lasecSimul/hw/timer/esp32_timg.c:162-175,559-596,716-801`.
- The run neither proves a TG1 no-feed precondition nor proves TG1 stage expiry/routing. `ESP32_MWDT_BEHAVIOR` remains open; reviewer choice is required for the next observation path and no root cause is declared.

## E060 - guest MWDT diagnostic boundary (2026-08-31)

Label: MEASURED_SIMULATOR / SOURCE_PROVEN.

Created `vnext_prototype/guest_mwdt_diagnostic` using direct ESP32 TG0 WDT
registers: stage 0 interrupt, stage 1 CPU reset, stages 2/3 off, and no feed
call. PlatformIO build passed and generated `merged.bin`. The bounded canonical
run retained `mwdt_diagnostic_stderr.log`, but the Arduino framework later
issued `TG0WDT feed` and rewrote configuration, so no expiry result is valid.
QEMU source proves TG0 connects to reset index 0 and TG1 to index 1; therefore
the requested TG0-to-CPU1 interpretation cannot be assumed. ESP32_MWDT_BEHAVIOR
remains open and no semantic change was made.
## E066 - pure IWDT infrastructure preflight (2026-08-31)

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`.

- `System.IO.DriveInfo` reports C: total 237.571 GB and 11.569 GB available;
  `fsutil` and CIM disk queries are denied by the execution sandbox.
- Reusable packages exist at `.piohome\packages\framework-espidf` with
  `version.txt=4.4.7`, and `.piohome\packages\toolchain-xtensa-esp32` with
  package version `8.4.0+2021r2-patch5`; its compiler reports GCC 8.4.0.
  The fixture pins `platform = espressif32@6.13.0` and `framework = espidf`.
- The project-local Python at `.piohome\python_env\idf4.4_py3.12_env` is
  Python 3.12.5 but has only pip-listed package and none of the required IDF
  imports. IDF requirements require notably `pyparsing<2.4`,
  `idf-component-manager~=1.2`, `urllib3<2`, `kconfiglib==13.7.1`, and
  `construct==2.10.69` for Python >3.11.
- Bounded read-only cache candidates are `.piohome\cache` (~0.623 GB),
  `guest_mwdt_diagnostic\.piohome\.cache` (~1.060 GB), user PlatformIO
  `.cache` (~0.052 GB), and pip cache (~0.084 GB). They remain untouched.
- No source, production binary, QEMU runtime, ABI, watchdog/reset semantics,
  or Git history changed. `ESP32_MWDT_BEHAVIOR` remains open.

## E075 - pure IDF fixture build dependency/toolchain boundary (2026-08-31)

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`.

- With `PLATFORMIO_CORE_DIR=.piohome`, the repaired builder venv imported all
  required modules (`BUILDER_IDF_IMPORT_PROBE=PASS`).
- Pinning the pure fixture to `espressif32@6.4.0` selected ESP-IDF 4.4.7 and
  `toolchain-xtensa-esp32@8.4.0+2021r2-patch5`; PlatformIO 6.13 had forced
  toolchain 14.2 and was rejected by IDF.
- PlatformIO 6.4 then required `cryptography<35`. The only host Python is
  3.12 and official PyPI exposes no compatible cryptography 34.x wheel;
  download exited 1 with no artifact. The check was not bypassed with
  `IDF_MAINTAINER` and no QEMU run occurred.
- No ELF, map, merged image, or valid sdkconfig artifact was generated. No
  production/QEMU/ABI/watchdog semantic change occurred; the MWDT behavior
  gate remains open.

## E074 - no-build-isolation IDF wheelhouse and import bootstrap (2026-08-31)

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`.

- The bounded full requirements download with target Python 3.12.5, explicit
  official PyPI, no cache, timeout 20, retries 1, and no build isolation
  progressed past local `esp-windows-curses` metadata and populated
  `.ai/wheelhouse_idf_requirements_66` with 31 artifacts.
- Direct requirements installation exposed the legacy literal
  `file://${IDF_PATH}` entry on this Windows pip path. Installing the downloaded
  artifacts directly succeeded, including building `reedsolo`.
- The target lists all required packages and the corrected module-name probe
  (`elftools`, not distribution name `pyelftools`) passed:
  `IDF_IMPORT_PROBE=PASS`.
- Representative hashes: click=`255BC9599CF7748B4B1A446CCC735421BD08A2AE529A8B88597D3DE5664EE360`,
  cryptography=`AED8DB4F6D71C51EFB89530E12D9464E7BF2923D46C3205DC794A2A93F8C0648`,
  setuptools=`51A52592B3B99E102B609654876BD65F19F999935166D1352678931132B0C670`.
  No source, production binary, QEMU runtime, watchdog/reset semantic, ABI,
  transport, or Git artifact changed; `ESP32_MWDT_BEHAVIOR` remains open.

## E073 - wrapper install and bounded requirements retry (2026-08-31)

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`.

- The verified local `esp_windows_curses-0.1-py3-none-any.whl` was installed
  into the target Python by absolute path with `--no-index --no-deps
  --no-cache-dir --force-reinstall`; pip exited 0 and reported
  `esp-windows-curses==0.1`.
- The target now reports exactly `esp-windows-curses==0.1`, `pip==24.2`, and
  `setuptools==84.0.0`. The wrapper intentionally exposes no import module;
  an import probe returned `ModuleNotFoundError: esp_windows_curses`, while
  package installation itself succeeded.
- A fresh `.ai/wheelhouse_idf_requirements_65` was created and the prescribed
  download used `IDF_PATH` set to the project-local ESP-IDF 4.4.7 path,
  explicit `https://pypi.org/simple`, `--no-cache-dir`, timeout 20, retries 1,
  and `-vv`. Pip still entered isolated build dependency resolution for the
  local wrapper and stopped after `GET /simple/setuptools/` returned HTTP 304;
  the bounded test was interrupted after approximately 60 seconds. The fresh
  wheelhouse is empty.
- No firmware build, QEMU run, source, production binary, watchdog/reset,
  transport, ABI, or Git artifact changed. `ESP32_MWDT_BEHAVIOR` remains open.

## E072 - setuptools bootstrap and local wrapper wheel boundary (2026-08-31)

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`.

- `setuptools-84.0.0-py3-none-any.whl` was downloaded from explicit official
  PyPI and installed by exact local path with `--no-index --no-deps`.
  Size 818216; SHA-256
  `51A52592B3B99E102B609654876BD65F19F999935166D1352678931132B0C670`.
- The target Python imports setuptools version 84.0.0.
- Local `esp-windows-curses` built successfully with
  `--no-build-isolation --no-deps --no-cache-dir` as
  `esp_windows_curses-0.1-py3-none-any.whl`; size 1201; SHA-256
  `CC7D7A028FA526DF841059F8BAB22E7D1C4FD2D58458F7F3A050E76D56CA4D7E`.
- The first wrapper attempt hit only global pip-cache `WinError 5`; disabling
  cache passed. No requirements retry, firmware build, QEMU run, source,
  production binary, or watchdog/reset semantic change occurred.

## E070 - official PyPI click wheel reachability probe (2026-08-31)

Classification: `MEASURED_SIMULATOR`.

- Using the target Python at
  `C:\SourceCode\LasecSimul\.piohome\python_env\idf4.4_py3.12_env\Scripts\python.exe`,
  `pip download click --index-url https://pypi.org/simple --dest
  .ai/wheelhouse_probe_click --no-deps --only-binary=:all: --no-cache-dir
  --timeout 20 --retries 1 -vv` exited 0.
- Verbose output records `GET /simple/click/` from `pypi.org:443` with HTTP
  200. The downloaded artifact is
  `.ai/wheelhouse_probe_click/click-8.5.0-py3-none-any.whl`, 125251 bytes,
  SHA-256 `255BC9599CF7748B4B1A446CCC735421BD08A2AE529A8B88597D3DE5664EE360`.
- The target environment remains unchanged (`pip==24.2` only); `import click`
  still fails with `ModuleNotFoundError`. This distinguishes official PyPI
  reachability from the previous stalled requirements installation, but does
  not yet prove the full pinned requirements are compatible or installable.
- No source, build, QEMU, production binary, watchdog/reset semantic, ABI,
  transport, or Git artifact changed. `ESP32_MWDT_BEHAVIOR` remains open.

## E071 - full IDF wheelhouse population blocked at local build dependency (2026-08-31)

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`.

- The authorized download-only command used the target Python 3.12.5, explicit
  `IDF_PATH`, official `https://pypi.org/simple`, `--no-cache-dir`, timeout 20,
  retries 1, and a fresh `.ai/wheelhouse_idf_requirements_63` destination.
- Pip processed the local `tools/kconfig_new/esp-windows-curses` requirement
  first, entered build isolation, and stalled while resolving its build
  dependency `setuptools` after `GET /simple/setuptools/` returned HTTP 304.
  The bounded process was interrupted after roughly 90 seconds. The fresh
  wheelhouse remained empty; no target package was installed.
- The local package source is `framework-espidf/tools/kconfig_new/esp-windows-curses/setup.py`
  and imports `setuptools.setup` directly. A second bounded download with
  `--no-build-isolation` failed deterministically during metadata generation:
  `ModuleNotFoundError: No module named 'setuptools'`.
- The target environment remains `pip==24.2` only. This narrows the immediate
  blocker to missing local build tooling plus the stalled isolated-build index
  path; it does not disprove public package availability. No source, build,
  QEMU, production binary, watchdog/reset semantic, ABI, transport, or Git
  artifact changed. `ESP32_MWDT_BEHAVIOR` remains open.

## E069 - bounded network retry remains stalled (2026-08-31)

Classification: `MEASURED_SIMULATOR`.

- A second authorized attempt used `pip install --no-cache-dir --timeout 10 --retries 1` against the same requirements and local IDF path.
- It again processed local `esp-windows-curses` and emitted no further output after more than 20 seconds; only the two test-created local Python processes were stopped. No package was installed.
- This retry produced no package/index error. No source, build, QEMU, or semantic change occurred.

## E068 - local artifact and pip-index discovery (2026-08-31)

Classification: `MEASURED_SIMULATOR`.

- No `.whl`, `.tar.gz`, or `.zip` artifacts were found under the inspected
  `.piohome\cache` and `.piohome\packages` roots.
- Pip reports no configured global, user, or environment `pip.ini`; no custom
  index or trusted host was exposed by `pip config list -v`.
- The PlatformIO IDF environment at `.piohome\penv\.espidf-4.4.7\Lib\site-packages`
  contains only `future` and `kconfiglib` remnants plus pip metadata, not a
  complete reusable requirements environment. The project-local target still
  contains only pip.
- No cache was deleted and no source, build, QEMU, or semantic artifact
  changed. The dependency blocker is now narrowed to unavailable local wheel
  artifacts or a network/index access problem.

## E065 - mixed fixture build boundary during environment repair (2026-08-31)

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`.

- The PlatformIO builder uses `.piohome/penv/.espidf-4.4.7` for its IDF Python
  environment. The local environment was recreated and Kconfig completed.
- The unchanged mixed Arduino+ESP-IDF fixture generated
  `guest_mwdt_diagnostic/.pio/build/esp32/config/sdkconfig.h` with
  `CONFIG_FREERTOS_HZ=100` and `sdkconfig.esp32` with
  `# CONFIG_ESP_INT_WDT is not set`.
- Build stopped before compile/link at the Arduino requirement
  `CONFIG_FREERTOS_HZ=1000 (currently 100)`. No ELF, map, image, or QEMU
  session was produced.
- This is not official-IWDT evidence. Per `MWDT_DEEP_REVIEW_PLAN.md`, the
  mixed fixture is reclassified as synthetic and will not be repaired or used
as a substitute for the pure ESP-IDF fixture.

## E067 - project-local IDF dependency installation attempt (2026-08-31)

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`.

- The authorized command used the project-local Python 3.12.5 environment,
  `IDF_PATH=C:\SourceCode\LasecSimul\.piohome\packages\framework-espidf`,
  and `pip install --no-cache-dir -r .piohome\packages\framework-espidf\requirements.txt`.
- Pip parsed Python-version markers and began processing local
  `tools/kconfig_new/esp-windows-curses`, but emitted no further output for
  over 90 seconds. Only the two test-created local Python processes were then
  stopped.
- Post-attempt `pip list --format=freeze` remains only `pip==24.2`; the import
  probe fails with `ModuleNotFoundError: No module named 'click'`.
- No source, production binary, QEMU runtime, ABI, watchdog/reset semantics,
  or Git history changed. `ESP32_MWDT_BEHAVIOR` remains open.

## E076 - compatible Python interpreter inventory (2026-08-31)

Classification: `MEASURED_SIMULATOR`.

- `py -0p` reports exactly one registered interpreter: Python 3.12 at
  `C:\Program Files\Python312\python.exe`.
- `Get-Command` confirms `python.exe` is Python 3.12.5; `python3.exe` is only
  the WindowsApps shim. A bounded search of the installed-program roots found
  no Python 3.10 or 3.11 executable. No compatible wheel/archive was found
  under the inspected `.ai` artifact roots.
- The official Python release index identifies Python 3.10.11 (April 5, 2023)
  and its Windows installer (64-bit). Candidate URL:
  `https://www.python.org/ftp/python/3.10.11/python-3.10.11-amd64.exe`;
  published/independently cross-listed SHA-256:
  `D8DEDE5005564B408BA50317108B765ED9C3C510342A598F9FD42681CBE0648B`.
- No installer was downloaded or installed, no venv/build/QEMU was run, and no
  production, ABI, watchdog/reset, transport, or Git artifact changed.
  `ESP32_MWDT_BEHAVIOR` remains open.

## E077 - reviewed Python 3.10.11 artifact acquisition blocked (2026-08-31)

Classification: `MEASURED_SIMULATOR`.

- The approved download target was the project-local staging path
  `.ai\python310_staging\python-3.10.11-amd64.exe`, with required SHA-256
  `D8DEDE5005564B408BA50317108B765ED9C3C510342A598F9FD42681CBE0648B`.
- `Invoke-WebRequest` failed with an unexpected TLS receive error; the
  resulting staging file was zero bytes and was not a valid artifact.
- A bounded `curl.exe` retry failed before transfer with Schannel
  `SEC_E_NO_CREDENTIALS (0x8009030e)`. No hash/signature validation passed,
  so the installer was not executed.
- No Python installation, venv, package install, firmware build, QEMU run,
  production source/binary, watchdog/reset semantic, ABI, transport, or Git
  artifact changed. `ESP32_MWDT_BEHAVIOR` remains open.
## E078 - project-local Python 3.10.11 installation blocked by Burn cache ACL (2026-08-31)

Classification: `MEASURED_SIMULATOR`.

- Immediately before execution, the staged installer measured 29,037,240
  bytes, SHA-256
  `D8DEDE5005564B408BA50317108B765ED9C3C510342A598F9FD42681CBE0648B`, and
  Authenticode `Valid` with signer `Python Software Foundation`.
- The bounded project-local install used `InstallAllUsers=0`, `PrependPath=0`,
  launcher/test disabled, and `TargetDir=orchestrator\\.ai\\python310`. It
  returned exit code 5 and produced no target `python.exe`.
- The Burn log proves `0x80070005` at `C:\Users\josuemorais\AppData\Local\Package Cache\{...}`
  while creating/registering the bundle cache, before component installation.
  A second bounded attempt with `/nocache` reproduced the same cache failure.
- No PATH/global mutation, venv, package install, firmware build, QEMU run,
  production source/binary, watchdog/reset semantic, ABI, transport, or Git
  artifact changed. `ESP32_MWDT_BEHAVIOR` remains open.
## E079 - Package Cache ACL boundary and sentinel (2026-08-31)

Classification: `MEASURED_SIMULATOR`.

- The latest Burn log identifies the exact bundle cache target as
  `C:\Users\josuemorais\AppData\Local\Package Cache\{a10fbb63-03ff-4b8c-a176-f5fd355f715b}`;
  it does not exist. The parent exists with attributes `Directory`, owner
  `BUILTIN\\Administradores`, and four inherited allow rules.
- The current process is `PC_UFU_Josue\\CodexSandboxOffline`, SID
  `S-1-5-21-3846247477-1191926843-2878787821-1004`. The parent ACL grants
  `PC_UFU_Josue\\CodexSandboxUsers` only `ReadAndExecute, Synchronize`, while
  `PC_UFU_Josue\\josuemorais`, Administrators, and SYSTEM have FullControl.
- A new random child sentinel failed on `Directory.CreateDirectory` with access
  denied (`0x80131501` PowerShell wrapper); no child was left behind.
  Read-only `icacls /verify` passed for `Package Cache`, `Local`, and `AppData`.
- No ACL, installer, Python, firmware, QEMU, production, watchdog/reset,
  ABI, transport, or Git artifact changed. `ESP32_MWDT_BEHAVIOR` remains open.
# E083 - dependency-free read-only core MSI database/CAB extraction (2026-09-01)

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`.

- `msi.dll` `MsiOpenDatabase` was called with read-only persist mode; no
  `InstallProduct`, `ConfigureProduct`, `msiexec`, or MSI action sequence was
  invoked.
- Validated input: `orchestrator/.ai/python310_payloads_74/core.msi`, size
  1,687,552 bytes, SHA-256
  `C5DECE7FB0F13B86A7AC721EF1575992A6A6D076FFAA0B6B6BA7DE120B2E64F4`.
- Media metadata: `DiskId=1`, `LastSequence=2`, `Cabinet=#cab1.cab`.
  `_Streams` contained `cab1.cab` (65,536 bytes, SHA-256
  `f6f008a2ca0165cea9ecd086957d911539bd808aa2e092736ecffefe69f4ef22`),
  plus the MSI signature/summary streams. The CAB was exported to
  `orchestrator/.ai/core_msi_readonly_77b_20260901T032123Z/cab1.cab`.
- `expand.exe -D` listed exactly `python.dll` and `python_stable.dll`.
  Database File rows are `python3.dll` 66,328 bytes and
  `elyvgfch.dll|python310.dll` 4,458,776 bytes; Component rows map both to
  `InstallDirectory`. This proves the recovered core MSI is only a two-DLL
  payload and cannot provide a complete Python 3.10 runtime.
- Pre/post snapshots were identical for Package Cache, Python 3.10 HKCU/HKLM
  uninstall entries, and process/user/machine PATH. The first diagnostic
  query attempt had a schema error (`DiskId` is not a File-table column); it
  did not touch the MSI or system and was corrected in the bounded rerun.
- No source, production binary, QEMU runtime, watchdog/reset semantic, ABI,
  transport, or Git artifact changed. `ESP32_MWDT_BEHAVIOR` remains open.

## E084 - dependency-free read-only exe/lib/pip MSI manifest (2026-09-01)

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`.

- The same `msi.dll` read-only database/stream procedure was applied only to
  `exe.msi`, `lib.msi`, and `pip.msi` from the Burn-validated official layout.
  No MSI action, install, ACL/PATH/registry change, or CAB-member extraction
  was performed.
- `exe.msi` SHA-256 is
  `B3A9F745AA598C1773923A45DCC4AA5B4C906F55D5559B568069F74E04CD4808`; its
  9 File rows/CAB members include `python.exe` and `pythonw.exe`.
- `lib.msi` SHA-256 is
  `6F16EC2506DD3D0B269EF6D367B97795214DA5F9E1EEC77108122F86D36C59C3`; its
  836 File rows/CAB members map to `Lib/...` and include standard library,
  `venv`, `ensurepip`, and bundled `pip-23.0.1` and `setuptools-65.5.0` wheels.
- `pip.msi` SHA-256 is
  `E42F9F0C9DEF8A7B8B142F3F03BBE0C91D9EE2B72041BAB21BF42C9BB00658EF`; it
  has one OptionalFeature component, zero File/Media rows, no CAB, and only
  `Binary.WixCA` as a payload-like stream.
- Normalized File-key to intended relative install-path mappings and feature
  presence are in
  `orchestrator/.ai/msi_readonly_78_20260901T20260901T002905Z/normalized_manifest.json`.
  Pre/post Package Cache, Python uninstall registry, and process/user/machine
  PATH snapshots are equal. No firmware, QEMU, production, watchdog/reset,
  ABI, transport, or Git artifact changed; `ESP32_MWDT_BEHAVIOR` remains open.

## E085 - project-local Python 3.10 runtime assembly and bounded probes (2026-09-01)

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`.

- Reviewer-approved assembly used only validated `core.msi`, `exe.msi`, and
  `lib.msi`. The original core MSI hash remains
  `C5DECE7FB0F13B86A7AC721EF1575992A6A6D076FFAA0B6B6BA7DE120B2E64F4`.
  A fresh read-only stream export recovered the complete core CAB at
  `orchestrator/.ai/core_recovery_79_20260901T004038362/cab1.cab` (1,639,717
  bytes); the earlier 65,536-byte export is not used.
- Runtime assembly is
  `orchestrator/.ai/python310_runtime_assembly_79c_20260901T004221101`.
  All 847 expected members (2 core + 9 exe + 836 lib) were placed from the
  normalized File/Directory mapping, with no duplicate or unmapped member;
  every assembled file has a recorded SHA-256 and MSI FileSize match in
  `inventory.json`. MSI four-part versions differ from PE resource versions
  for 30 files (e.g. MSI `3.10.11150.1013` vs PE `3.10.11`); this is recorded
  as a metadata representation discrepancy, not a size or payload failure.
- Literal `python.exe --version` passed with `Python 3.10.11`. Imports of
  `sys`, `ssl`, `hashlib`, `venv`, and `ensurepip` passed; `python -m ensurepip
  --version` returned `pip 23.0.1`; a child venv created with `--without-pip`
  and its literal Python version probe both passed.
- Pre/post process-level PATH, user/machine PATH, Package Cache listing, and
  Python 3.10 uninstall registry snapshots are byte-equal. No MSI action,
  install, ACL/PATH/registry mutation, firmware build, QEMU run, production
  source/binary, or watchdog/reset semantic changed. `ESP32_MWDT_BEHAVIOR`
  remains open.
# E086 - bounded IDF dependency/bootstrap preflight (2026-09-01)

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`.

- The active PlatformIO IDF 4.4.7 framework is
  `.piohome/packages/framework-espidf@3.40407.240606`; its readable
  `requirements.txt` has 57 lines and includes the expected IDF Python
  dependencies plus the local `tools/kconfig_new/esp-windows-curses`
  package. The unversioned `.piohome/packages/framework-espidf` path does not
  contain the requirements file; the versioned path is the valid package
  identity (`framework-espidf`, `3.40407.240606`).
- Literal Python 3.10.11 probes passed for `ensurepip`, and its bundled
  directory contains `pip-23.0.1-py3-none-any.whl` and
  `setuptools-65.5.0-py3-none-any.whl`. The runtime itself has no installed
  pip: `python.exe -m pip --version` returned `No module named pip`.
- Availability probes found `packaging` importable, while `click`, `serial`,
  `future`, `cryptography`, `pyparsing`, `pyelftools`,
  `idf_component_manager`, `urllib3`, `kconfiglib`, `reedsolo`, `bitstring`,
  `ecdsa`, and `construct` were not importable. No `.whl`, archive, or
  package-specific local artifact was found under `.piohome/cache`.
- No install/bootstrap command, network download, firmware build, QEMU run,
  source or semantic change, PATH/registry/system mutation, or Git operation
  occurred. `ESP32_MWDT_BEHAVIOR` remains open.

## E087 - disposable Python 3.10 child bootstrap and offline IDF metadata probes (2026-09-01)

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`.

- Using the literal assembled `python.exe` from E085, a fresh project-local
  child environment was created at
  `orchestrator/.ai/idf_dependency_probe_81_20260901T064700`.
- `ensurepip --upgrade --default-pip` completed from the embedded wheels only,
  installing `pip==23.0.1` and `setuptools==65.5.0`; the child now reports the
  expected local pip path.
- An IDF requirements dry-run with `--ignore-installed --no-index --no-deps`
  failed immediately at `setuptools>=21` with no matching distribution,
  proving the child has no offline package artifact source. The requirements'
  literal `file://${IDF_PATH}` Windows path also fails to expand when passed
  directly to pip, yielding an access-denied path containing `${IDF_PATH}`.
- The local `tools/kconfig_new/esp-windows-curses` metadata probe passed and
  would install `esp-windows-curses-0.1`. Imports in the child remain absent
  for click, serial, future, cryptography, pyparsing, pyelftools,
  idf_component_manager, urllib3, kconfiglib, reedsolo, bitstring, ecdsa, and
  construct; only `packaging` is importable among the tested set.
- No dependency package was installed, no source/firmware/QEMU/watchdog or
  semantic artifact changed, and no PATH/registry/Git operation occurred.
  `ESP32_MWDT_BEHAVIOR` remains open.

## E089 - gdbgui metadata and exact gevent cp310 binary probe (2026-09-01)

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`.

- Official `gdbgui==0.13.2.0` metadata was read from a downloaded wheel.
  SHA-256: `458BC73EB4B08C8471E5500F1BF0D354FA6D51E80413E2E2C202B194BE7E49FC`.
  Its target-applicable dependency is `gevent (<2.0,>=1.2.2)` with no marker;
  it does not pin 1.5.0.
- Exact `gevent==1.5.0` probe used the validated Python 3.10.11 child and
  official PyPI with `--no-deps --only-binary=:all: --platform win_amd64
  --implementation cp --python-version 310 --abi cp310`. It returned exit 1,
  produced no artifact, and listed binary candidates beginning at 21.8.0.
  Log SHA-256: `B05934E1E099322E978CF63B7F8E956E78DDCC743212AFAFF6388B2162616DC1`.
- This proves binary unavailability for candidate 1.5.0, not for the full
  declared range. No alternate version was probed, no sdist was built, no
  dependency was installed, and no firmware/QEMU/watchdog/reset/production/
  ABI/Git artifact changed. `ESP32_MWDT_BEHAVIOR` remains open.

## E088 - bounded Python 3.10 IDF wheelhouse population (2026-09-01)

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`.

- Using the disposable child interpreter from the validated literal Python
  3.10.11 runtime, a fresh project-local wheelhouse was populated at
  `.ai/wheelhouse_idf_requirements_82` from `https://pypi.org/simple` with
  `pip download --no-build-isolation`, timeout 15 s, and one retry.
- The local `esp-windows-curses` metadata was accepted. The applicable IDF
  4.4.7 direct requirements were download-resolved with `--no-deps`; 20
  artifacts were retained and SHA-256 hashed, including setuptools 84.0.0,
  cryptography 50.0.1, gdbgui 0.13.2.0, kconfiglib 13.7.1, construct
  2.10.54, reedsolo 1.5.4, and the remaining direct packages.
- Full dependency resolution stopped at `gdbgui==0.13.2.0`'s
  `gevent==1.5.0` sdist. With build isolation disabled, metadata generation
  failed with `error: invalid command 'bdist_wheel'`. The complete IDF
  dependency set is therefore not yet proven obtainable by this route.
- No dependency was installed into the child; no firmware build, QEMU run,
  source/ABI/semantic change, PATH/registry mutation, or Git operation
  occurred. `ESP32_MWDT_BEHAVIOR` remains open.

## E090 - gevent 1.5.0 cp38 Windows binary probe (2026-09-01)

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`.

- A bounded official-PyPI download-only probe used the validated project-local
  Python 3.10 child only as the pip runner, with target tags
  `--platform win_amd64 --implementation cp --python-version 38 --abi cp38`,
  `--only-binary=:all: --no-deps`, and exact requirement `gevent==1.5.0`.
- Exit code was 0. Artifact:
  `orchestrator/.ai/gevent_cp38_win_amd64_probe_84_20260901T070554/gevent-1.5.0-cp38-cp38-win_amd64.whl`;
  size 1,559,340 bytes; SHA-256
  `45A5AF965CC969DD06128740F5999B9BDB440CB0BA4E9C066E5C17A2C33C89A8`.
- This proves a compatible gevent 1.5.0 Windows cp38 wheel is available; it
  does not prove Python 3.8 runtime availability, dependency installation, or
  IDF/QEMU/watchdog behavior. No package was installed and no source,
  firmware, QEMU, semantic, ABI, registry, PATH, or Git artifact changed.
  `ESP32_MWDT_BEHAVIOR` remains open.

## E091 - official CPython 3.8.10 installer acquisition (2026-09-01)

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`.

- Using Python's standard-library HTTPS client with certificate and hostname
  verification, same-origin redirect enforcement, 30-second timeout, three
  bounded attempts, `.part` staging, fsync, and atomic rename, the official
  Windows x64 installer was acquired at
  `orchestrator/.ai/python38_acquisition_85_20260901T071500/`.
- Requested/final URL: `https://www.python.org/ftp/python/3.8.10/python-3.8.10-amd64.exe`;
  final response HTTP 200, Content-Type `application/octet-stream`,
  Content-Length `28296784`, ETag `"608fe733-1afc650"`, Last-Modified
  `Mon, 03 May 2021 12:06:11 GMT`.
- Artifact size is 28,296,784 bytes and SHA-256 is
  `7628244CB53408B50639D2C1287C659F4E29D3DFDB9084B11AED5870C0C6A48A`.
  Windows Authenticode status is `Valid`; signer subject is
  `CN=Python Software Foundation, O=Python Software Foundation, L=Wolfeboro,
  S=New Hampshire, C=US`.
- This proves provenance and availability of the installer only. It does not
  prove runtime assembly, dependency installation, firmware, QEMU, or
  watchdog behavior. The bundle was not executed; no PATH, registry, ACL,
  source, semantic, firmware, QEMU, or Git artifact changed.
## E092 - CPython 3.8.10 Burn-accepted layout (2026-09-01)

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`.

- The verified bundle was run in a new project-local `/layout` directory.
  Burn planned 52 packages and initially failed only at absent `core_pdb.msi`
  with `0x80072efd` and `0x80090305`.
- The bundle-declared same-origin payloads were acquired one at a time using
  verified HTTPS, `.part` staging, atomic rename, and SHA-256 recording:
  `core_pdb.msi`, `core_d.msi`, `dev_d.msi`, `exe_pdb.msi`, `exe_d.msi`,
  `lib_pdb.msi`, `lib_d.msi`, `test_pdb.msi`, `test_d.msi`, `tcltk_pdb.msi`,
  and `tcltk_d.msi`. Every final URL was under
  `https://www.python.org/ftp/python/3.8.10/amd64/`.
- Rerunning `/layout` completed with exit code 0; the Burn log records
  `Apply complete, result: 0x0` and `Exit code: 0x0`. The complete layout is
  `orchestrator/.ai/python38_layout_86_20260901T072000/`.
- Its inventory records 12 bundle/payload files plus the Burn log and
  inventory. All 12 executable/MSI files have Authenticode `Valid` status and
  signer Python Software Foundation.
- This proves package-layout completeness only. No MSI action, CAB extraction,
  runtime assembly/execution, dependency installation, firmware build, QEMU
  run, PATH/registry/ACL mutation, or semantic/Git change occurred.
  `ESP32_MWDT_BEHAVIOR` remains open.
## E094 - official CPython 3.8.10 base MSI acquisition and identity (2026-09-01)

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`.

- Exact same-origin URLs under `https://www.python.org/ftp/python/3.8.10/amd64/`
  returned HTTP 200 for `core.msi`, `exe.msi`, and `lib.msi`. Acquisition used
  verified Python HTTPS, 30-second timeout, three bounded attempts, `.part`
  staging, fsync, and atomic rename. Full HTTP metadata, URLs, sizes, hashes,
  and signatures are in
  `orchestrator/.ai/python38_base_msis_88_20260901T073100Z/acquisition.json`.
- Artifact measurements: `core.msi` 1,597,440 bytes,
  SHA-256 `9A60963CC3CF59CF9C89224D178ECE8B49C327C88A142F41293C7B6A3DC0C244`;
  `exe.msi` 520,192 bytes,
  SHA-256 `45D59CF16BC869B0798E640EE983D04C1F3CBC03B172B9DEEC81C0BA4CACFAEA`;
  `lib.msi` 8,282,112 bytes,
  SHA-256 `2F4E5061C8DBE6D5A85FA216EE7D12195B928363877A1D44BBA663908F6BD285`.
  All three Authenticode statuses are Valid with signer Python Software
  Foundation.
- Read-only Windows Installer queries are in `identity/msi_identity.json`:
  ProductVersion `3.8.10150.0`, Summary Template `x64;1033`, Python 3.8.10
  product names, and distinct ProductCodes.
- The first attempt falsely rejected the valid signature enum and removed only
  its staged artifact; the corrected bounded rerun succeeded. No CAB export,
  MSI action, runtime execution, dependency install, firmware, QEMU,
  production, watchdog/reset, ABI, transport, or Git artifact changed.
## E095 - CPython 3.8.10 base MSI read-only assembly and runtime validation (2026-09-01)

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`.

- Using only the E094-validated `core.msi`, `exe.msi`, and `lib.msi`, the
  existing dependency-free `msi.dll` procedure exported each embedded
  `cab1.cab` stream and expanded it with `expand.exe` into the new project-local
  assembly `orchestrator/.ai/python38_runtime_assembly_89_20260901T074000Z/`.
- The MSI File tables mapped 2 core + 9 exe + 830 lib = 841 payloads. Every
  File-key/member mapping was recorded in `inventory.json`, with source MSI
  hash, intended relative path, MSI FileSize, assembled size, and assembled
  SHA-256. Rechecking all 841 assembled payloads produced
  `HASH_SIZE_RECHECK_BAD=0` and no duplicate destination paths.
- Independent literal probes in `probes.json` passed: `python.exe --version`
  returned `Python 3.8.10`; the runtime reported the CPython 3.8.10 build
  string; imports of `sys`, `ssl`, `hashlib`, `venv`, and `ensurepip` passed;
  `python -m ensurepip --version` returned `pip 21.1.1`.
- This proves a coherent assembled CPython 3.8.10 runtime, not IDF dependency
  availability or firmware/QEMU/watchdog behavior. No MSI action, dependency
  install, PATH/registry/ACL mutation, firmware, QEMU, production, semantic,
  ABI, transport, or Git artifact changed. `ESP32_MWDT_BEHAVIOR` remains open.
## E096 - CPython 3.8.10 IDF dependency availability boundary (2026-09-01)

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`.

- A fresh child environment was created under
  `orchestrator/.ai/idf_dependency_probe_90_20260901T074013Z/` using the
  assembled runtime `python.exe`; its literal version is Python 3.8.10 and
  pip is 21.1.1.
- The initial bounded `pip download` correctly identified an input-boundary
  issue: the IDF requirements line
  `file://${IDF_PATH}/tools/kconfig_new/esp-windows-curses` was passed
  literally by pip on Windows, producing a permission error before index
  resolution. No artifact was retained.
- The bounded rerun resolved only that local path to
  `.piohome/packages/framework-espidf@3.40407.240606/tools/kconfig_new/esp-windows-curses`
  and used official `https://pypi.org/simple`, no cache, binary-only mode,
  15-second timeout, one retry, and a fresh wheelhouse at
  `orchestrator/.ai/idf_dependency_probe_90b_20260901T074500Z/`.
- Resolution reached the first missing constrained requirement:
  `reedsolo>=1.5.3,<=1.5.4`. Pip reported only `1.7.0, 2.0.4, 2.0.5,
  2.0.9, 2.0.10, 2.0.31b1, 2.1.0b1, 2.1.1b1` from the queried index and
  returned exit code 1. `artifacts.json` records zero retained wheels.
- This proves an infrastructure dependency boundary only. No dependency was
  installed; target Python, firmware, QEMU, production, watchdog/reset,
  ABI, transport, and Git artifacts are unchanged. `ESP32_MWDT_BEHAVIOR`
  remains open.

## E107 - CPU1 transport-pause compensation and current production boundary (2026-09-03)

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`.

- QEMU change: TG0 transport-pause compensation now accepts lanes 0 and 1 and
  uses atomic rising/falling edges to compensate the union of overlapping
  intervals. Built with MSYS2 UCRT64 and staged SHA-256
  `02D3F7159DA9A2D4D9B9155780D34499DFDD6FEB236F94175F586FA0B964B1EB`.
- Core fixes: test QEMU path honors `LASECSIMUL_TEST_QEMU_BINARY` in all three
  affected tests; `QemuProcessManager::stop()` joins an already-exited reader;
  calibrator boot wait is 10 s, exits early with process logs when QEMU dies;
  the stale runtime identity assertion now follows the current 1-based ABI.
- Build infrastructure: the existing `core/build` cache referenced missing
  CMake modules under another user's profile. A non-destructive
  `core/build-codex` Visual Studio 2022 build was used. Regression result:
  `PASS=10 of 10` against the newly staged QEMU.
- Production VNEXT_B results, 60 s each: N=1/4/8 produced 0 MWDT resets; N=12
  produced 3. At N=16 with 6 reserved cores, five runs produced
  `5,2,12,12,7`; with 2 reserved cores they produced `2,3,3,2,3`. More host
  CPU reduces but does not eliminate the residual, so the production gate is
  still OPEN.
- Bare-metal validity arms with scale=1: `tg0_fed=0`, `tg0_unfed=35`,
  `tg0_fed_then_starve=17`, `tg1_fed=0`, `tg1_unfed=35` MWDT-attributed
  resets. `tg0_fed` at 16 concurrent instances produced 0/16 instances with
  an MWDT reset. The device model still distinguishes fed from starved guests.
- Runner correction: `run_production_mwdt.ps1` now removes environment
  variables instead of leaving `LASECSIMUL_FAILURE_ISOLATION` present but
  empty, which had selected the wrong scenario.

## E139 - ROM/EFUSE interlock correction and stop on separate post-boot signature (2026-09-08)

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`, with final runtime qualification `BLOCKED_BY_SEPARATE_E135_POST_BOOT_SIGNATURE`.

- Implemented a narrow EFUSE operation interlock in QEMU so a valid ROM EFUSE operation cannot have its first `EFUSE_CMD` read observe zero before the guest has observed busy. If the operation timer fires before the first guest read, completion is deferred; the first read returns busy, and completion is applied exactly once afterward. Reset deletes the timer, invalidates the operation generation, clears operation/status state, and starts the reset read operation. The 100,000,000 ns EFUSE delay remains unchanged and is now documented as 100 ms with a TODO for a validated timing source.
- RED proof preserved under `vnext_prototype/mttcg_causality/E139-rom-efuse-interlock_20260908_062500/`: the old model can produce `first_cmd_read=0x0` after timer-before-first-read and maps to ROM branch `0x4000fca6 -> 0x4000fdc7`.
- GREEN deterministic proof: new `test-esp32-efuse-op-state` passed 18/18. Required non-regressions also passed: `test-esp32-timg-wdt-scale` 13/13, `test-esp32-timg-pause` 7/7, and `test-vnext-b-classify` 9/9.
- Candidate QEMU SHA is `8F7F7A334FFA17A6B8FC080EB75F70BD9D85EBECFB3F07A1BCC2A6995BF612AD`; canonical rollback runtime stayed `B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`, and `QEMU_RUNTIME.json` stayed SHA `ADF0D79B9E533E17A3F8CA62FD890B1867973FBB1AFF1C95239142D03644B369`.
- Directed real validation passed: N=1 RTC-reset-only had no `0x4000fdcd/fdd0`; B11 N=16 RTC-reset-only passed 3/3, 48/48 sessions, all exactly one app-cpu-startup, workloads passed, `submissions==completions>0`, zero unexpected resets, zero ROM/EFUSE reset signature, zero CACHEERR/Guru/panic, clean teardown.
- Non-regression passed before the stop: `vnext_b_attachment_test` PASS, `session_restart_stress_test` PASS 15/15 cycles, and full VNEXT_B+MTTCG regression passed 14/14 twice. B11 zero diagnostics passed N=1, N=8, and N=12.
- Stop condition: B11 zero-diagnostic N=16 run 1 failed classification (`B11_CELL_PASS=False`) because session 7 had two unexpected post-boot resets after exactly one app-cpu-startup: `pc0=0x400dca9f pc1=0x40082c2c wdt0_enabled=1 source=RTC_RESET boot_epoch=2`, then `pc0=0x40082eec pc1=0x40000400 source=SW_CPU_RESET_REGISTER boot_epoch=2`. This is the E135 post-boot signature, not ROM/EFUSE: no `0x4000fdcd`, no `0x4000fdd0`, no RTC causal trace line, no CACHEERR, no Guru, `artifactFatal=false`, teardown clean, zero QEMU orphans.
- No B12, promotion, `QEMU_RUNTIME.json` edit, cleanup, commit, push, tag, package, release, Core/firmware/transport/scheduler/WDT/cache-wait/reset-policy change was performed. Next action is an E135-focused bounded causal review/investigation using the preserved session-7 frame, not another EFUSE change.

## E140 - post-boot recurrence audit and minimal cause latch (2026-09-08)

Classification: `MEASURED_SIMULATOR` + `SOURCE_PROVEN`, with result
`NO_RECURRENCE_IN_THREE_VALID_N16_WITH_MINIMAL_LATCH`.

- Before editing, the E121-E139 history and orchestration state were preserved
  under
  `vnext_prototype/mttcg_causality/E140-postboot-cause-latch_20260908_071200/`.
  The mandatory reconstruction was recorded in
  `E140_pre_edit_historical_reconstruction.md`:
  `E139_POST_BOOT_SIGNATURE_MATCHES_PRIOR_PANIC_PIPELINE_BUT_INITIATING_CAUSE_IS_NOT_CAPTURED`.
  The E139 session-7 late reset signature matches the prior panic/reset
  pipeline shape, but the initiating cause remains unproven.
- Implemented an opt-in QEMU diagnostic latch gated only by
  `LASECSIMUL_POSTBOOT_CAUSE_LATCH=1`. It records first cache-wait/cache-illegal,
  first real WDT stage expiry, and first interrupt-matrix activation for
  sources 20 and 68, preserving PID, sequence, virtual time, PC/address/register
  and WDT deadline/counting details. The dump occurs before the existing reset
  log and before CPU/state clearing. Hot-path record hooks use fixed storage
  and perform no heap allocation, I/O, or blocking lock; I/O is restricted to
  the reset dump.
- E139 baseline candidate remained preserved at SHA-256
  `8F7F7A334FFA17A6B8FC080EB75F70BD9D85EBECFB3F07A1BCC2A6995BF612AD`.
  E140 diagnostic candidate was preserved as
  `vnext_prototype/mttcg_causality/E140-postboot-cause-latch_20260908_071200/candidate_qemu/qemu-system-xtensa.exe`
  with SHA-256
  `8F47106B4ED949576DF8D76501997ECAE86C095894501B51F8D3CA6B8153FF69`.
  Canonical rollback runtime stayed
  `B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`;
  `QEMU_RUNTIME.json` stayed SHA-256
  `ADF0D79B9E533E17A3F8CA62FD890B1867973FBB1AFF1C95239142D03644B369`.
- Unit/small regressions passed: `test-esp32-postboot-cause-latch` 6/6,
  `test-esp32-dport-cache-race-stall`, `test-esp32-efuse-op-state`,
  `test-esp32-panic-trace-gate`, `test-esp32-timg-pause`, and
  `test-esp32-timg-wdt-scale`, all exit code 0 with outputs preserved.
- Bounded real validation used only `VNEXT_B+MTTCG` and only the new latch
  diagnostic. N=1/60s passed: 1/1 workload, `9329==9329`
  submissions/completions, zero unexpected resets, zero CACHEERR/Guru, zero
  cause latch, clean teardown, zero QEMU orphans. Three N=16/60s runs then
  passed validly: 48/48 workloads, submissions/completions
  `48335==48335`, `48581==48581`, and `30371==30371`, zero unexpected resets,
  zero CACHEERR/Guru, zero cause latch, clean teardown, zero orphans.
- Therefore E140 does not prove a cause and does not authorize a semantic fix
  or promotion. It proves that the post-boot signature did not recur in the
  bounded window with minimal latch. If it recurs later, the latch line should
  classify by first event/sequence instead of relying on late PCs.
- No LEGACY, ICOUNT, SINGLE_REALTIME, B12, promotion, cleanup, commit, push,
  tag, package, release, Core/firmware/transport/scheduler/WDT/cache/reset
  semantic change was performed.

## E141 — production-clean consolidation: QEMU+Core diagnostic removal, `VnextBAttachmentTest.cpp` re-oracle (APPROVED, scope-limited), then a real production-dispatcher regression found in `session_restart_stress_test` (2026-09-08, ~17:15)

Classification: `SOURCE_PROVEN` for the re-oracle work (`APPROVE_TEST_ORACLE_REPLACEMENT_ONLY`,
fully executed and green); **STOP — new functional red, out of the authorized
scope**, for the production-dispatcher regression.

### Part A — QEMU-side and Core-side production-clean removal (context carried
forward from this same episode's earlier `STATUS.md`/`NEXT_ACTION.md` entries at
~08:33/~14:05/~15:10, recorded here in `EVIDENCE.md` for the first time)

- QEMU side (`C:\SourceCode\qemu_lasecSimul`): removed the E131 TCG-trace and
  E111 XTENSA-EXC-TRACE/XTENSA-PC-WATCH families
  (`accel/tcg/translate-all.c`, `target/xtensa/translate.c`,
  `target/xtensa/exc_helper.c`, `target/xtensa/helper.h` — both files
  confirmed byte-identical to git HEAD after removal), the `esp32_cache_trace_*`
  dead stubs and `LASECSIMUL_BQL_CAUSAL_TRACE` (`hw/misc/esp32_dport.c`,
  `softmmu/simuliface.c`), CACHE-TRACE/line-26-routing-trace call sites
  (`hw/misc/esp32_crosscore_int.c`, `hw/xtensa/esp32_intc.c`), and dead EFUSE
  diagnostic accounting (`hw/nvram/esp32_efuse.c` and its header). Two
  collateral defects from an earlier, interrupted pass were found and fixed
  during careful line-by-line `git diff` review, not invented: MMU
  defines/`get_mmu_entry`/`set_mmu_entry`/`esp32_cache_ill_write`/
  `esp32_cache_ill_accepts` had been deleted from `esp32_dport.c` along with
  the trace stubs (restored verbatim from `git show HEAD:...`), and
  `esp32_dport_appcpu_has_non_cache_stop()`/`esp32_dport_set_flash_device()`
  were declared/called but never defined (completed using the contract
  already fully specified by the surrounding code). `hw/char/esp32_uart.c`
  had an undefined `skipCoreNotify` left by the interrupted pass, fixed by
  removing the conditional wrapper (production now always notifies
  unconditionally, matching every other call site). Two Windows-portability
  bugs unrelated to diagnostics (`trace/meson.build`,
  `scripts/tracetool/backend/log.py` — backslash path separators breaking
  `underscorify()`/`relpath()`) and a stale `libblock.fa` archive with an
  orphaned object were found and fixed/cleared during the rebuild. Result:
  `qemu-system-xtensa.exe` SHA-256
  `475C0FC956E43FFC0CB83CECE0DC384457A9E1F01D2C6A3F6C21C4665C7EB23D`,
  preserved at
  `vnext_prototype/mttcg_causality/E141-production-clean_20260908_083000/candidate_qemu/`.
  A `strings`/symbol sweep confirmed zero occurrences of the ~30 named
  diagnostic markers (LASECSIMUL_POSTBOOT_CAUSE_LATCH,
  LASECSIMUL_PANIC_CAUSAL_TRACE, the LASECSIMUL_WDT_CAUSAL_TRACE family,
  LASECSIMUL_XTENSA_PC_SAMPLER, LASECSIMUL_E131_TCG_TRACE, VNEXT_PROBE, the
  reentrancy probe, etc.) in the built binary; genuine product strings
  (`"Blocked re-entrant IO"`, the two `esp32_i2c` empty-TX-FIFO error_report
  lines) were confirmed still present, unchanged.
- Core side (`C:\SourceCode\LasecSimul\core`): deleted `TeardownTrace.hpp`
  (preserved at
  `.../E141-production-clean_20260908_083000/pre_core_removed_source_files/core/src/mcu/TeardownTrace.hpp`)
  and every call site across `McuComponent.cpp`, `McuController.cpp`
  (including `vnextCoreStartupTraceEnabledInController()`/
  `controllerStartupTrace()` and their 5 call sites in the VNEXT_B start
  path), `QemuProcessManager.cpp`, `VnextBAttachment.cpp`/`.hpp` (including
  `vnextCoreStartupTraceEnabled()`/`coreStartupTrace()` and the
  `m_firstConsumeTraced`/`m_firstResumeSignalTraced`/`m_runtimeFatalTraced`
  atomics, confirmed zero other functional consumers), `Scheduler.cpp`,
  `SimulationSession.cpp`, and one call in
  `VnextBProductionScaleTest.cpp` (only the diagnostic call was removed; the
  structural assertion around it was kept). One piece of real synchronization
  state — `VnextBWaitDispatcher`'s wait-set generation / observed generation /
  callbacks-in-flight, load-bearing for `unregister()`'s drain contract that
  prevents a use-after-free on a just-closed handle — was living inside the
  `TeardownTrace.hpp` diagnostic namespace; it was not deleted, it was moved
  into `VnextBWaitDispatcher::Impl` as ordinary instance members with
  non-diagnostic names, preserving the same synchronization semantics.
  `LASECSIMUL_MCU_TRANSPORT`, `LASECSIMUL_VNEXT_TRACE`,
  `LASECSIMUL_MCU_CONSUMER_TRACE`, and other `LASECSIMUL_*` variables were
  checked via `git log`/diff size against pre-existing, committed product
  functionality and left untouched. `lasecsimul-core.lib`, `.exe`, and every
  affected test binary rebuilt clean (MSBuild, capped at `/m:2` after an
  earlier, unrelated machine-freeze incident in this same session from an
  uncapped `ninja` rebuild — 0 warnings, 0 errors.

### Part B — `VnextBAttachmentTest.cpp` re-oracle, under the explicit
`APPROVE_TEST_ORACLE_REPLACEMENT_ONLY` authorization

Root cause of the stop recorded in this episode's earlier `STATUS.md` entry
(P1 and several other subtests failing against the new candidate): those
subtests string-matched `[VNEXT_B_STARTUP] transition=...` lines that used to
come from `LASECSIMUL_VNEXT_STARTUP_TRACE`, correctly removed as part of Part
A above. Confirmed a pure test-oracle-obsolescence issue, not a regression,
by controlled comparison (canonical and the E139 candidate both still carry
the old tracer and both still passed the old oracle).

Every log-dependent assertion in the file was re-audited and replaced with
existing production ABI/functional state — zero new QEMU logs, zero new
production counters, zero new ABI fields, zero atomics/clocks/hooks added to
any hot path, zero reintroduction of `LASECSIMUL_VNEXT_STARTUP_TRACE`:

- **P1 (prepare/-S/activate ordering)**: rewritten to call `prepare()` then
  assert `lifecycleStateForTesting()==Ready`, `artifact_state==LASEC_AT_READY`,
  no pending lane events, not fatal — proving PRELAUNCH/READY structurally,
  not via a log line. Then `activate()` under `-S` and assert
  `heartbeatWatermarkForTesting()==0` and no lane activity after 300ms —
  proving the E116 autostart=0 barrier holds `vm_start()`/the R3c heartbeat
  off even after Core signals RUNNING at the protocol level. The
  guest-never-runs-before-RUNNING property itself is now cited as the
  structural, compile-time-guaranteed E116 barrier (`vnext_start_paused`
  makes `vnext_start_guest_on_core_ready` permanently false), not re-derived
  at runtime.
- **"Exactly once" idempotency**: per the authorization's explicit
  instruction not to expose a new production counter, this is proven by
  behavior — a repeated `signalCoreRunningForTesting()` must not regress
  `lifecycleStateForTesting()`, `running()`, `isArtifactFatal()`,
  `hasPendingLaneEvents()`, or the heartbeat watermark (never resets/goes
  backwards). This check was originally placed AFTER the file's pre-existing
  `dataAttachment.stop()` call by mistake — it ran against an already-dead,
  stopped attachment (all fields read back as 0/false, which looked like a
  false pass at first and was caught by adding field-value diagnostics to the
  failure message). Fixed by moving the block to run before `stop()`.
- **Publication/consumption, C2A, responses, GPIO self-test**: unchanged
  mechanism (`consumeLane()`/`peekLane()`/`publishC2A()`/`c2aEmpty()`/
  `respondToRequest()`), only the removed-log assertions around them were
  replaced; `artifact_progress_ns` (QEMU's `vnext_control.artifactProgress`,
  incremented in `softmmu/vnext_b.c` on C2A consumption and on
  `respondToRequest()` completion) proves C2A delivery count directly.
- **WOULD_BLOCK (E118 Phase 2)**: replaced with real ring occupancy —
  poll `laneHasPending()` until true, then require draining exactly the
  configured lane depth (2) of undrained events before declaring the
  WOULD_BLOCK path meaningfully exercised (not vacuously passed), while
  confirming non-fatal/still-running throughout.
- **UART backlog / I2C continuation (E118-AUDIT)**: the original byte-exact
  `esp32_uart_diag_tx_bytes_accepted_total()`-style counters are gone from
  the production-clean binary by design and were not reintroduced. Replaced
  with: real firmware boot under maximum backpressure (lane depth 4, no
  consumer for the first stretch, then a real draining consumer), requiring
  at least 16 real lane events actually drained through the production
  `consumeLane()` path before declaring backpressure meaningfully exercised,
  zero `artifactFatal`, the process still running, and the absence of the two
  pre-existing, legitimate `esp32_i2c` empty-TX-FIFO `error_report()` lines
  (kept as genuine failure-only diagnostics, not touched) as the desync
  proof. Explicitly noted in-file: this raw-`VnextBAttachment` test drives
  `consumeLane()` from its own manual 1ms-poll thread, bypassing
  `McuComponent`/`McuController`/`VnextBWaitDispatcher` (the real production
  dispatch pipeline) entirely — its PASS does not and was never meant to
  stand in for `vnext_b_production_scale_test.exe`/`session_restart_stress_test`,
  which exercise that real pipeline (see Part C below).
- Removed: the `B11_DECISION_014_REENTRANCY_CONCURRENCY_PROBE` check block
  (the QEMU-side reentrancy probe it depended on is gone from the
  production-clean binary by design; the property it measured is a static,
  source-level argument per DECISION-014, unchanged by E141, not re-derived
  here — if a live regression guard is ever needed again it belongs in a
  diagnostic-only build variant, not this gate).

**MEASURED_TEST**: rebuild of `vnext_b_attachment_test.exe` alone, 0
warnings/0 errors. Three consecutive direct runs against the
`475C0FC9...` candidate: **3/3 PASS, all 33 subtests each run, zero QEMU
orphans each time** (`e141_attachment_test_run2.log` and two earlier runs).
Re-ran the 5 deterministic QEMU unit tests
(`test-esp32-dport-cache-race-stall`, `test-esp32-efuse-op-state`,
`test-esp32-timg-pause`, `test-esp32-timg-wdt-scale`,
`test-vnext-b-classify`) against the same candidate: unaffected, all still
PASS, exit 0. Then two full `run_regression.ps1 -Transport VNEXT_B
-ExecutionMode MTTCG` runs against the same candidate: **PASS=14 of 14
runnable, both times**, `QEMU_RUNTIME_SHA256` confirmed
`475C0FC956E43FFC0CB83CECE0DC384457A9E1F01D2C6A3F6C21C4665C7EB23D` both times
(`e141_regression1.log`, `e141_regression2.log`).

### Part C — STOP: `session_restart_stress_test` fails deterministically
against the candidate with real, healthy-looking QEMU boot but **zero** I2C
lane traffic ever dispatched — classified as a probable real regression in
Core's production dispatch pipeline, introduced during Part A, **outside the
scope of this episode's `APPROVE_TEST_ORACLE_REPLACEMENT_ONLY` authorization**

Running `session_restart_stress_test.exe` (rebuilt today, same Part-A/B Core
binary) against the `475C0FC9...` candidate with the standard real-firmware
config (`guest_i2c_workload/merged.bin`, VNEXT_B/MTTCG, default
`ciclos=15 run_ms=5000`) failed: **15/15 cycles "TRAVOU NO MEIO"**, every
single `[HARNESS_PROGRESS]` line reading
`submissions=0/0 completions=0/0 artifact_progress=0/0` for the entire
5-second window of every cycle, while QEMU's own embedded logs show a normal,
healthy two-stage ESP32 boot (correct ROM/APP loading, correct
`source=OTHER`/`source=SW_CPU_RESET_REGISTER expected=app-cpu-startup`
sequence, `boot_epoch=1`) and the Scheduler shows real virtual-time/event
activity (`eventsProcessed`, `settleIterations` all nonzero and growing).
`arenaRunning=999 queue=999/999 abi=0 peerReady=nao caps=0x0` in the failure
line is a legacy-arena (`LsdnQemuArena`/ABI v5) sentinel printed for context
only (`mcuPtr->arenaBridge().arena()` is legitimately null under VNEXT_B
transport) — not the actual gating oracle, which is `vnextProgressObserved`
(`vnextI2cSubmissionCountForTesting()`/`vnextI2cCompletionCountForTesting()`/
`vnextArtifactProgressForTesting()`, all real ABI-backed counters/fields, no
diagnostic dependency).

Ruled out one variable at a time, all read-only, before classifying:

1. **Not the QEMU candidate binary**: re-ran the identical test (1 cycle) with
   `LASECSIMUL_TEST_QEMU_BINARY` overridden to the already-preserved,
   already-verified E139 candidate
   (`8F7F7A334FFA17A6B8FC080EB75F70BD9D85EBECFB3F07A1BCC2A6995BF612AD`,
   SHA-256 re-verified byte-identical just now) — **same failure**, cycle 0
   already shows `submissions=0/0` after the full 5s window
   (`e141_session_restart_control_e139.log`).
2. **Not the firmware**: `guest_i2c_workload/merged.bin` SHA-256
   `1DA8BF731830B2D2D9CE6EDBB0EA208636A1DB2A79497A8DB0CC98D72864C76A`,
   file-dated 2026-09-04, unchanged since before E132.
3. **Not the test source/oracle**: `SessionRestartStressTest.cpp` SHA-256
   `01F7B3C06F5758EF3C0C2CD88D429BB93154ED920E39A7C69C03661CBD73D059` —
   byte-identical to the E132-E version already documented in this file as
   passing 15/15 with real submission/completion counts, and unchanged
   through E134/E135/E139/E140.
4. **Direct historical counter-example, same E139 QEMU binary**: this
   episode's own preserved
   `E139-rom-efuse-interlock_20260908_062500/phase6_core_direct_tests/session_restart_stress_test.combined.log`
   shows the identical scenario (same binary, same firmware, same
   `ciclos=15 run_ms=5000`) PASSING 15/15 earlier today, with cycle 0 already
   at `submissions=2/0 completions=2/0` within 2.2s and climbing into the
   hundreds per cycle thereafter, and the E139/E140 `EVIDENCE.md` entries
   independently record real B11 runs at large submission/completion counts
   (e.g. `9329==9329`, `48335==48335`) against this same Core-side dispatch
   pipeline earlier today, before Part A's edits.
5. **The one file in Part B that does exercise real-firmware I2C
   (`VnextBAttachmentTest.cpp`'s E118-AUDIT block) does not cover this
   path**: it was found, on re-reading its own in-file comment, to drive
   `consumeLane()` from a test-owned manual polling thread against a raw
   `VnextBAttachment`, deliberately bypassing `McuComponent`/`McuController`/
   `VnextBWaitDispatcher` — the real production dispatch pipeline that
   `session_restart_stress_test` (and `vnext_b_production_scale_test.exe`)
   actually exercise. Its PASS is therefore not evidence the production
   pipeline still works.

The only variable left that changed between "documented PASS" and "now FAIL"
is the compiled Core production binary itself — specifically the
Part-A-edited real dispatch path (`McuComponent.cpp`'s VNEXT_B poll/dispatch
loop, `McuController.cpp`, `VnextBWaitDispatcher.cpp`'s wait-set-generation
refactor). This was **not** further bisected or fixed in this episode: doing
so is outside `APPROVE_TEST_ORACLE_REPLACEMENT_ONLY`, which authorized only
editing `VnextBAttachmentTest.cpp` (and, if strictly necessary, test-only Core
helpers) — not `McuComponent.cpp`/`McuController.cpp`/
`VnextBWaitDispatcher.cpp` production dispatch code, and not
`SessionRestartStressTest.cpp`.

**STOP.** Per the task's own stop-condition rule ("pare no primeiro vermelho
funcional"), and because this red is proven functional (real ABI counters,
not a removed diagnostic) and reproduces against two different,
independently-verified-unchanged QEMU binaries: no B11, B12, promotion,
`QEMU_RUNTIME.json` edit, cleanup, commit, push, tag, or further Core
production edit was performed. Zero QEMU orphans throughout this
investigation (`tasklist` confirmed clean). Candidate SHA re-verified
unchanged (`475C0FC9...`) at the end of this entry. Next action needs
explicit authorization to root-cause and fix the regression in
`McuComponent.cpp`/`McuController.cpp`/`VnextBWaitDispatcher.cpp` (most
likely site, not yet bisected to a single line) — see `NEXT_ACTION.md`.

## E142 — causal bisection: the `session_restart_stress_test` red is NOT caused by the E141 cleanup; a real, pre-existing Scheduler/VNEXT_B pacing defect found instead (2026-09-08, ~18:10)

Classification: **STOP per the task's own Phase-3 rule ("se ambos falharem, pare e
investigue identidade de build/ambiente; não atribua a limpeza")** — the
E141-cleanup-caused-regression hypothesis is **disproven**, and a real,
independent defect was localized instead (not yet fixed: fixing it is outside
this episode's authorization, which was scoped to *confirming and fixing an
E141 regression*, not to a pre-existing Scheduler bug).

### Phase 0 — snapshot and identity

Preserved under
`vnext_prototype/mttcg_causality/E142-core-vnext-dispatch-regression_20260908_171700/`:
`git status --short` for both repos, identity hashes before/after an explicit
`/t:Rebuild` of `session_restart_stress_test.vcxproj`, and every run's
effective `LASECSIMUL_*` environment. The explicit rebuild proved the
executable actually in use before this episode was **not** fully up to date:
SHA changed from `727E49DB...` to `9836E474...` after a genuine `/t:Rebuild`
(size 7545344 -> 7560192 bytes) even though the prior incremental build had
reported success. All subsequent runs in this episode used freshly, fully
rebuilt executables only.

### Phase 1 — minimal reproduction, fail-closed

Hermetic 1-cycle reproduction (`LASECSIMUL_STRESS_CYCLES=1`, all
`LASECSIMUL_*` cleared and re-set explicitly, environment dumped per run)
against the E141 candidate (`475C0FC9...`, re-verified byte-identical):
**3/3 clean reproductions**, all `submissions=0/0 completions=0/0` for the
full 5 s window, zero QEMU orphans after each run.

### Phase 2 — exact boundary, via real ABI state only

Two small, read-only, non-mutating test-only accessors were added (no
stderr, no env var, no behavior change, matching this codebase's existing
`*ForTesting()` pattern): `McuComponent::vnextBAttachmentForTesting()` and
`VnextBAttachment::laneRingSeqForTesting(lane)` (returns raw
`{write_seq, read_seq}`). A temporary, clearly-labeled diagnostic block
(`E142_BOUNDARY_SNAPSHOT`/`E142_ARBITER_INPUTS`) was added to
`SessionRestartStressTest.cpp`'s existing "TRAVOU NO MEIO" branch.

Result, classified per this episode's own rule set:
**`lane0={write=8 read=0}`** — QEMU published exactly 8 events (the
configured lane depth) and Core drained **zero**. This is case
"write_seq > read_seq: publicação ocorreu, mas o Core não drenou" —
dispatcher/wake/markDirty territory, not a guest/boot problem. Confirmed
`artifact_state=RUNNING`, `core_state=RUNNING`, heartbeat actively advancing
(~5.00 s), `notificationPending` observed both true and false across runs
(the dispatcher callback *does* fire), `pollGeneration` incrementing
~1000-1200 times over the 5 s window (dispatch *is* being repeatedly
attempted), `waitDispatcherOccupiedSlots=1` (registration is clean, no stale
handles). A second probe read the stuck lane-0 head directly (non-mutating
`peekLane`) and reconstructed the arbiter's own inputs:
`lane0Head.timestamp_ns≈305,000,000` (the guest's first real event, ~305 ms
into its own boot), `originNs=0`, so `computed=305,000,000`, but
`nowNs≈234,000,000-251,000,000` (the Scheduler's own clock) — **the event is
being correctly classified as "future" by `VnextBArbiter::selectNextLaneEvent`
(`ready = timestampNs <= nowNs`) and correctly deferred via `schedulePollAt`,
but the Scheduler's `nowNs` never reaches ~305 ms, ever, across the whole 5 s
window.** A third probe added `McuComponent::pacingPositionNs()` to the same
snapshot: **`pacingPositionNs≈4,031,000,000` (~4.03 s)** — the
heartbeat-backed advance-limit floor is nowhere near the bottleneck; the
Scheduler is allowed to advance to ~4 s and does not.

### Phase 3 — pre/post-E141 isolated comparison (no stash/reset/checkout on
the main tree)

Reconstructed the pre-cleanup Core tree via `git worktree add --detach` at
HEAD + `git apply` of the preserved `pre_lasecsimul_full_diff.patch` +
untracked files (`TeardownTrace.hpp` from
`E141-.../pre_core_removed_source_files/`; `VnextBArbiter.cpp/.hpp`,
`DrainCutoffGate.hpp` copied from the current tree, confirmed unmodified by
today's cleanup). Two small, previously-undocumented `lasecsimul::diag`
accessors (`dispatcherWaitSetGeneration/ObservedGeneration/CallbacksInFlight`,
`dispatcherWorkerHeartbeatHostNs`) turned out to be missing from the
preserved 08:33 `TeardownTrace.hpp` snapshot — they were added to the live,
untracked file sometime between 08:33 and this episode's deletion of it, with
no intermediate copy surviving. Reconstructed them, in the throwaway worktree
only, with semantics inferred directly from the post-cleanup
`VnextBWaitDispatcher::Impl` instance members that replaced them (not
invented) — this reconstruction gap is noted for completeness and does not
affect the finding below, since it only concerns a diagnostic-only,
opt-in-trace code path never exercised in this investigation.

The worktree's own build environment (fresh checkout of `mcu-adapters`
build output, `devices/`, etc. at an unrelated path) hit infrastructure-only
obstacles unrelated to the bug (Windows `MAX_PATH` under the first,
deeply-nested worktree location — recreated at `C:\e142wt`; a missing
copy of the prebuilt, unmodified `adapter.dll`; an early CRT `abort()`
(`exit code 3`) before session creation even begins, root cause not found and
not pursued further since it is a different failure class entirely from the
one under investigation). Given these, the pre/post comparison was instead
done as a **lightweight, fully-reversible file swap inside the main tree's
already-working build environment**: the 9 edited files'
current (post-cleanup) content was hashed and backed up, replaced one-for-one
with the worktree's correctly-patched pre-cleanup content (plus
`TeardownTrace.hpp`, plus the two small E142 test-only accessors re-applied
to the swapped-in headers so `SessionRestartStressTest.cpp` still compiles),
built, and tested — then fully restored and hash-verified byte-identical to
the pre-swap backup afterward. `vnext_b_attachment_test` (33/33) and a clean
rebuild were used to confirm the restoration was exact.

**Result: A (pre-cleanup code) also FAILS** — same signature
(`lane0={write=8 read=0}`, `nowNs≈234-251 ms` stuck, event at ~305-307 ms),
run three times (including once under DECISION-010's exact `BelowNormal`
priority + restricted-affinity mask, and with current Windows timer
resolution confirmed at 1 ms, not the coarse default) — all still red.
**B (post-cleanup/current code) also FAILS**, identically, 3/3, on a
confirmed-idle host (~2-5% CPU) right after the A/B swap.

Per this episode's own Phase-3 rule: **"se ambos falharem, pare e investigue
identidade de build/ambiente; não atribua a limpeza."** The
E141-cleanup-caused-this-regression hypothesis from `EVIDENCE.md`'s E141
entry is **disproven** by this direct, controlled, same-environment A/B
test. `Scheduler.cpp`, `McuComponent.cpp`, `McuController.cpp`,
`VnextBAttachment.cpp/.hpp`, `VnextBWaitDispatcher.cpp`,
`QemuProcessManager.cpp`, and `SimulationSession.cpp` were all swapped
between their pre- and post-cleanup forms and the symptom did not change —
whatever causes this is present in **both** variants, i.e., it predates
E141's diagnostic-removal work entirely.

### Investigation notes on the real mechanism (not fixed, not fully proven)

Two candidate mechanisms were identified by reading `Scheduler.cpp`/`.hpp`
but **not experimentally confirmed** (no fix was attempted — out of this
episode's scope once Phase 3 disproved the E141-cleanup attribution):

1. `Scheduler::scheduleEventUnlocked(delayNs, callback)` (`Scheduler.hpp`,
   the `schedulerLockHeld=true` path `McuComponent::schedulePollAt()` uses
   from inside `stamp()`) pushes the event via `pushEventLocked()` but,
   unlike every sibling scheduling entry point in this same file
   (`scheduleAt`, `scheduleEvent`, `markDirty`, `pause`, `resume`,
   `notifyCommandPending`), never calls `signalWorkAvailable()` afterward.
   The doc-comment argues this is safe because the caller is "already
   active," which held for the code path traced by hand in this episode
   (the background worker's own `while(m_running)` loop re-checks `m_events`
   directly on its very next pass, without needing a wake) — but a lost-wake
   window elsewhere was not ruled out.
2. The worker loop's real-time pacing throttle (`Scheduler.cpp` ~lines
   484-545, gated on `realTimeRate>0`) anchors/sleeps based on
   `(cycleSimEndNs - cycleSimStartNs) / realTimeRate` versus wall time
   elapsed; its interaction with a session that repeatedly discovers a
   "future" VNEXT_B event, defers, and re-enters the outer loop was read but
   not instrumented or confirmed as the actual mechanism.

Neither was changed. `VnextBArbiter::selectNextLaneEvent()` itself (the
`ready = timestampNs <= nowNs` comparison) was read and is correct;
`McuComponent::pacingPositionNs()` was read and is not the limiting factor
(it reports ~4 s, far above the ~305 ms the arbiter needs).

### Housekeeping

The `git worktree` used for Phase 3 was removed
(`git worktree remove --force`) after use; its short-lived alternate path
`C:\e142wt` was deleted. All 9 swapped files plus
`McuComponent.hpp`/`VnextBAttachment.hpp` were restored to their exact
post-cleanup content (SHA-256 verified against a pre-swap backup preserved
under this episode's `phase3_lightweight_swap/post_cleanup_backup/`).
`session_restart_stress_test` and `vnext_b_attachment_test` were rebuilt
clean (0 warnings/0 errors) in this final state; `vnext_b_attachment_test`
re-ran 33/33 PASS as a restoration sanity check. Zero QEMU orphans at every
checkpoint. The E142 test-only accessors
(`vnextBAttachmentForTesting()`, `laneRingSeqForTesting()`) and the
`E142_BOUNDARY_SNAPSHOT`/`E142_ARBITER_INPUTS` diagnostic block in
`SessionRestartStressTest.cpp` were left in place (harmless, read-only,
clearly dated/labeled) since they directly support whoever continues this
investigation next — not promoted to anything beyond that, and not treated
as a "fix."

No B11, B12, promotion, `QEMU_RUNTIME.json` edit, cleanup, commit, push,
tag, release, or QEMU change was performed. Canonical
(`B375A9E8...`) and both preserved candidates (`475C0FC9...`, `8F7F7A33...`)
confirmed untouched. Next action is a decision, not a fix made
unilaterally — see `NEXT_ACTION.md`.

## E143 — H143 (post-ack now+1ns starvation) confirmed as a real, independent bug and fixed in isolation, then reverted per this episode's own Phase-2 gate: the mechanism alone does not restore session_restart_stress_test (2026-09-08, ~18:40)

Classification: **H143 PARTIALLY CONFIRMED, then STOP per explicit Phase-2
rule** ("impedir somente o now+1ns não restaurar o avanço"). The proposed
mechanism is real, precisely located in source, reproduced in an isolated
RED, and eliminated by a correct, unit-tested fix — but eliminating it alone
does not restore `session_restart_stress_test`'s end-to-end behavior, so
H143 is refuted as the *sole, complete* explanation and the production fix
was reverted, exactly as this episode's own instructions require.

### Phase 0 — snapshot

Preserved under
`vnext_prototype/mttcg_causality/E143-vnext-future-head-starvation_20260908_180600/`:
git status/diffs for both repos, identity hashes of every file in scope,
copies of the E142 artifacts showing `write=8/read=0`, `nowNs≈234-251ms`,
event `≈305ms`, `pacingPositionNs≈4.03s`. Zero QEMU orphans confirmed before
starting.

### H143 audit — confirmed by direct code reading before any test was written

`McuComponent::pollAndDispatchPendingEvents()`'s post-ack block was exactly
as H143 described:

```cpp
const bool notified = attachment.notificationPending();
if (notified) attachment.acknowledgeNotification();
if (attachment.hasPendingLaneEvents() && !budgetExhausted) {
    scheduleNextPoll(deferred, schedulerLockHeld);   // always now+1ns
}
```

`hasPendingLaneEvents()` is `write_seq != read_seq` on any lane -- true
whether the remaining head is ready or still future; it cannot distinguish
the two. `scheduleNextPoll()` always requests `nowNs+1`, which is always
earlier than any real future deadline, so it always passes
`schedulePollAt()`'s own "only preempt if strictly earlier" check --
unconditionally invalidating (via `++m_pollGeneration`) the correct
`schedulePollAt(305ms)` callback the main loop had just installed a few
lines above, replacing it with an immediate one that finds the exact same
future head and repeats. H143 confirmed by direct reading, before writing
any test, per the task's own instruction to audit first.

### Phase 1 — deterministic RED, pure, no QEMU

Extracted the pure policy the post-ack block is missing into
`VnextBArbiter.hpp`: `decidePostAckRearm(peeks, nowNs, budgetExhausted) ->
{None | Immediate | At(timestamp)}` (no candidate -> None; budget exhausted
-> Immediate, matching the pre-existing, unchanged, separate "budget
exhausted during the main drain loop" handling; ready candidate ->
Immediate; future-only candidate -> `At(candidate.timestampNs)`, never
now+1ns).

Added, in `VnextBArbiterTest.cpp`, a tiny in-process discrete-event model
(`FakeSchedulerState`) of exactly `McuComponent::schedulePollAt()`'s own
`m_pollGeneration`/`m_pollEventScheduled`/`m_pollEventDueNs` state machine
and its "only preempt if strictly earlier" dedup rule, at the **same
nanosecond scale E142 actually measured** (`kHead=305,000,000`,
`kStart=250,000,000` -- this scale matters: at a naively small integer
scale the `now+1` storm would organically close the gap in ~55 iterations
and never reproduce the bug; at the real ~55,000,000ns gap, `now+1ns`
advances the clock by nanoseconds per storm cycle, correctly reproducing
"stuck at ~234-251ms, never reaching ~305ms").

`runOldBuggyPolicy()` (the pre-E143 policy, hand-encoded literally, not
copied from production -- a permanent regression guard) and
`runNewFixedPolicy()` (using `decidePostAckRearm()`) were run against the
identical fixture. **RED, measured:** `consumed=false finalNowNs=250,002,000
iterations=2000 (deadline=305,000,000 never reached)` -- 2000 iterations of
storm close only ~2000ns of a 55,000,000ns gap. A second, direct proof:
installing the correct `schedulePollAt(305,000,000)` (generation 0) then
applying the exact pre-E143 post-ack call once yields
`pollEventDueNs=250,000,001` (the now+1ns clobber) and `pollGeneration=1`
(the correct callback invalidated). **GREEN, measured (same fixture, fixed
policy):** `consumed=true finalNowNs=305,000,000 iterations=1` -- exact,
single-shot convergence, zero storm.

A further 11 pure unit tests cover Phase 4's required matrix directly via
`decidePostAckRearm()`/`FakeSchedulerState`: future head keeps its exact
timestamp; repeating the same future notification is idempotent (never
now+1ns); a head ready at re-peek time is Immediate; a ready event on
another lane preempts a later future deadline; an earlier future head on
another lane legitimately preempts a later one (and `schedulePollAt()`
itself honors that preemption, generation bump proven); a later future head
does **not** replace an earlier already-scheduled one; empty lanes -> None;
budget exhaustion -> Immediate regardless of lane content; a concurrent
publish landing only in the post-ack re-peek is still picked up; a
generation-invalidated (stale) callback, reached later in real
priority-queue order, is a clean no-op with no double-consumption. **All
pure tests pass, 100%** (`vnext_b_arbiter_test.exe`, clean build, 0
warnings/errors).

### Phase 2 — controlled confirmation against the real system, then the stop condition

Applied the fix directly to `McuComponent.cpp`'s post-ack block (re-peek
every lane, call `qemu::decidePostAckRearm()`, act on `None`/`Immediate`/
`At` exactly as the pure policy specifies -- this already satisfies Phase
3's "correção correta" checklist verbatim, so Phase 2's control and Phase
3's fix were done as one build/test cycle rather than a separate throwaway
patch). Rebuilt `session_restart_stress_test` clean (0 warnings/errors) and
ran the 1-cycle real-firmware reproduction against the E141 candidate
(`475C0FC9...`) **three times**:

- `m_pollGeneration` measured **0, 0, 0** across all three runs (down from
  ~1000-1200 pre-fix) -- the callback storm is completely gone, direct
  confirmation the H143 mechanism was real and is eliminated.
- But `Scheduler::nowNs` at the end of each 5s window measured
  **217,600,055 / 150,779,643 / 185,618,630** -- still far short of the real
  ~305,000,000 deadline, in every run.
- `lane0={write=8 read=0}` persisted in every run; `submissions=0/0
  completions=0/0` persisted in every run.

Per this episode's own explicit Phase-2 gate ("Confirmação esperada:
Scheduler atravessa ~305ms; ... Se isso não acontecer, pare: H143 foi
refutada e nenhuma correção deve ser aplicada") and the matching STOP
CONDITION ("impedir somente o now+1ns não restaurar o avanço"): **H143 is
refuted as the sole, complete explanation.** The storm was real and is a
genuine, confirmed bug (proven in isolation by the RED/GREEN unit tests
above), but removing it alone does not restore `session_restart_stress_test`
-- something else, not yet identified, is also required. Per the explicit
instruction, no correction was kept applied to production: the
`McuComponent.cpp` change was reverted (confirmed by rebuilding and
re-running once more: `m_pollGeneration=956` reproduced, matching the
pre-E143 magnitude, proving the revert is exact and the block is otherwise
untouched).

### What was kept vs. reverted

- **Reverted**: `McuComponent.cpp`'s post-ack block, back to
  `hasPendingLaneEvents() && !budgetExhausted -> scheduleNextPoll()`,
  unchanged from before E143 (plus a comment recording this episode's
  finding, for whoever picks this up next).
- **Kept**: `VnextBArbiter.hpp`'s `decidePostAckRearm()` (pure, inert,
  correct, not called from any production code path after the revert) and
  `VnextBArbiterTest.cpp`'s full RED/GREEN suite (all still pass -- they
  test the pure function directly, independent of `McuComponent.cpp`). Both
  are ready to be wired back in the moment the deeper cause is found and a
  combined fix is authorized.

Per this episode's own explicit constraints, none of the following were
touched or reopened: `Scheduler.cpp`/pacing (E142 already showed
`pacingPositionNs()` is not the limiting factor; this episode did not
change or further instrument it, per "não alterar pacing" and "a correção
exigir mudar Scheduler/pacing antes de H143 ser resolvida" being an
explicit stop condition), `scheduleEventUnlocked()` (no isolated RED proved
a lost wake specifically; the real-system observation here is suggestive
but not the isolated proof the task requires before touching it), QEMU,
firmware, watchdog, cache, EFUSE, ABI, transport, lane depth, or any
tracer. No B11/B12/promotion/`QEMU_RUNTIME.json`/cleanup/commit/push/tag/
release. Zero QEMU orphans at every checkpoint (initial and final
`tasklist` checks). Full artifacts, logs, and effective environments under
this episode's snapshot directory.

## E144 — Debug/Release methodological correction, H143 fix restored and validated, formal Release gate reaches 15/15 (2026-09-08/09, ~18:48-19:25)

Classification: **H143 CONFIRMED and FIXED for the formal (Release) gate.
E142/E143's "Debug fails" was never proof of a production-blocking
regression -- it was an unnoticed Debug/Release mismatch against E132-E's
own historical baseline.** `REVIEW_REQUIRED` overall: B11 N=16 stopped at
1/3 (not refuted, not failed -- a host-safety stop after a real freeze on
this same machine), and the QEMU-side `RESET_WAIT`/`E131` batteries were not
re-executed in this episode (out of a Core-only fix's blast radius, already
closed at E132-B against an unchanged QEMU binary). B12/promotion remain
correctly blocked.

### Phase 1 — documentary correction (no history deleted, only appended)

Confirmed directly from preserved artifacts, not from memory: E132-E's
`session_restart_stress_test 15/15` used
`MSBuild.exe ... /p:Configuration=Release` (`E132-post-review_20260907_113506/
E132-E_session_restart_oracle_20260907_123456/build_manifest.json`), binary
SHA `599ECEEF5B4E9A3700057A10A233E0CA7F4D35C503E38CC7F9A41EC677023262` at
`core/build/Release/session_restart_stress_test.exe`. Every session_restart_
stress_test invocation in E142 and E143 (this same investigation) had been
building and running `core/build/Debug/session_restart_stress_test.exe`
instead, without noticing the mismatch -- E142's "identical environment"
A/B claim was true for source and QEMU binary, but not for the Core build
configuration. This does not reopen E141's cleanup-attribution finding
(still correctly disproven -- pre/post-cleanup Debug code failed
identically, which remains true) but it does mean E142/E143's classification
of the underlying dispatch problem as "always red" was incomplete: it was
red in Debug specifically. `PLAN_MTTCG_VNEXT_B_CAUSALITY.md` section 10.4
step 5 ("se houver somente evento futuro, manter o callback temporal; não
criar busy loop") and section 10.2 ("Não mudar VNEXT_B para polling
periódico de now+1 ns... pode criar um laço quente no Scheduler") were
re-read: H143's mechanism is a direct, literal violation of both, confirmed
by E143's own RED/GREEN unit tests -- a real bug regardless of which build
configuration happens not to be blocked by it today.

### Phase 2 — exact Release baseline before any edit

Explicit `/t:Rebuild /p:Configuration=Release` of `session_restart_stress_
test.vcxproj` (still the pre-H143-fix, E143-reverted McuComponent.cpp at
this point). Binary SHA `82C131DADAEE6781F278F0A846B06E5143F9D71A227A09F
3444E0FD261B7924C`. Three hermetic 1-cycle runs against the E141 candidate
(`475C0FC9...`, re-verified) and the registered firmware
(`1DA8BF73...`, re-verified), no fallback: **3/3 PASS**,
`submissions=749/756/757`, `completions` matching each, zero orphans.
**This confirms the corrected classification directly: the exact same
buggy code that always fails in Debug passes cleanly in Release**, because
Release is fast enough to grind through H143's wasteful now+1ns storm
within a 5s window (organically closing the gap to the first real deadline
through sheer iteration speed) while Debug -- 10-50x slower per iteration,
typical for unoptimized MSVC builds -- is not. H143 remains a real,
plan-violating busy loop either way; Release merely isn't blocked by it
today.

### Phase 3 — H143 fix restored

Re-wired `McuComponent.cpp`'s post-ack block to call the existing, already
unit-tested `qemu::decidePostAckRearm()` (untouched since E143 --
`VnextBArbiter.hpp`/`.cpp` needed no changes) instead of the
`hasPendingLaneEvents() -> scheduleNextPoll()` policy that violates plan
10.4/10.2. Full relink of both configurations:
- Release: `session_restart_stress_test.exe` rebuilt clean (0/0);
  `vnext_b_arbiter_test.exe` rebuilt clean, **12/12 pure H143 tests still
  pass in Release** (0 failures).
- Debug: rebuilt clean (0/0), SHA `04B3E641C48C20E5982EA5F48C17C26C75799F1
  F0456B7748B28C2D7D2B0AFAC`.

Post-fix Release, 1-cycle probes (3 runs): 2 showed `virtualTimeNs 0-
>~1.1-1.2e9` (real dispatch confirmed -- non-I2C events consumed, a
transformation from the pre-fix "always 0" state) but `submissions=0` within
the tight 5s single-cycle window; 1 showed full success
(`submissions=793`). This is expected and correct, not a regression: with
the busy loop removed, the simulation now paces at genuine real-time speed
(QEMU is `mttcg-realtime`) instead of an accelerated pace accidentally
produced by the storm keeping the CPU pegged -- a single isolated 5s cycle
can be tight for a fresh process to reach the guest's I2C phase. The
*formal* gate is the default multi-cycle run, not an isolated probe: **the
full default `ciclos=15 run_ms=5000` Release run passed 15/15**
(`0/15 falharam ao iniciar, 0/15 travaram, 0/15 falharam no GPIO13, 0/15
tiveram Guru Meditation, 0/15 deixaram estado apos Stop, 15/15
sessionExecutionId distintos`), matching E132-E's historical result exactly,
92.1s wall time, zero orphans.

### Phase 4 — Debug time series: slow, not frozen

Added an opt-in-only (`LASECSIMUL_STRESS_TIME_SERIES`, never in the
default/hot path) 250ms-cadence sample of `Scheduler::nowNs()` and lane 0's
raw `{write_seq, read_seq}` to `SessionRestartStressTest.cpp`. Ran Debug
(post-fix), 1 cycle, `LASECSIMUL_STRESS_RUN_MS=30000`: **`Scheduler::nowNs`
increased on every single one of ~120 consecutive 250ms samples across the
full 30s window** (210,600,038ns at t=251ms to 475,800,204ns at t=29,917ms),
never flat for 2s or longer at any point -- the explicit "frozen if no
increase 2s; slow if monotonic" classification this episode required.
`lane0.read_seq` advanced 0->8 around t=11s (real dispatch happening,
non-I2C events), `write_seq` grew 8->16 as the guest kept producing.
**Debug is confirmed slow (~60x under real-time at this workload), not
frozen** -- ~475ms of simulated time in 30 real seconds, consistent with
Release needing under 2 real seconds to reach the point (~700ms-1s
simulated) where I2C activity in this firmware begins.

### Phase 5 — harness self-report and fail-closed Release gate

`SessionRestartStressTest.cpp` now prints `HARNESS_BUILD_CONFIG=Debug` or
`=Release` unconditionally, once, at `PHASE_00_TEST_START` (cheap, not a
hot-path log), via `_DEBUG`/`NDEBUG`. Added `LASECSIMUL_REQUIRE_RELEASE=1`:
when set and the running executable is a Debug build, the test fails
closed immediately (`FALHOU: ... recompile/rode ... em .../Release, nao
Debug.`) before launching QEMU or doing any other work. Verified directly:
Debug + `LASECSIMUL_REQUIRE_RELEASE=1` -> exit 1, immediately, correct
message. The test itself still runs normally in Debug when the caller
doesn't set this (needed for investigation/development use, e.g. this
episode's own Phase 4); only a caller that wants the formal guarantee opts
in. `run_regression.ps1`'s 14-test suite does not invoke
`session_restart_stress_test` at all (confirmed, unaffected either way) and
was not modified.

### Phase 6 — validation (Release except where noted; VNEXT_B+MTTCG only)

- `vnext_b_arbiter_test.exe` (pure, Release): **12/12, 3 consecutive runs**
  (Phase 3).
- `session_restart_stress_test.exe` (Release, real firmware, default 15
  cycles): **15/15 PASS** (Phase 3), zero orphans.
- `vnext_b_attachment_test.exe` (Release): **3/3 runs, 33/33 subtests
  each**, zero orphans.
- Two full `run_regression.ps1 -Transport VNEXT_B -ExecutionMode MTTCG`
  runs against the E141 candidate: **PASS=14 of 14 both times**,
  `QEMU_RUNTIME_SHA256=475C0FC9...` confirmed both times, zero orphans.
  (Default `-Config Debug`, unchanged invocation; this suite does not
  include `session_restart_stress_test` so the Debug/Release distinction
  found in this episode does not apply to it.)
- B11 (`run_production_mwdt.ps1`, Release `vnext_b_production_scale_test.
  exe`, `RunMs=60000`, against the E141 candidate):
  - **N=1: PASS.** `B11_CELL_PASS=True`, 1/1 session,
    `submissions=1869=completions`, `artifactFatal=false`,
    `unexpectedResets=0`, `drainComplete=true`.
  - **N=8: PASS.** `B11_CELL_PASS=True`, 8/8 sessions
    `workloadPass=true`/`artifactFatal=false`, submissions/completions
    matching exactly in every session (17,699-45,768 per session), 16/16
    resets (2/session, expected), `MWDT_ATTRIB_RESETS=0`.
  - **N=12: PASS.** `B11_CELL_PASS=True`, 12/12 sessions
    `workloadPass=true`, 24/24 resets, `MWDT_ATTRIB_RESETS=0`.
  - **N=16, run 1 of 3: PASS.** `B11_CELL_PASS=True`, 16/16 sessions
    `workloadPass=true`, 0 `drainTimeout`, 32/32 resets (2/session,
    expected), `MWDT_ATTRIB_RESETS=0`, zero orphans immediately after.
    Required `-Force`: `run_production_mwdt.ps1`'s own admission guard
    computed only 26/32 usable cores (`ReserveCores=6`, DECISION-010)
    against N=16's required 32 vCPU slots (2/session) and refused to start
    without it -- matching documented precedent for N=16 elsewhere in this
    file (e.g. the E139/E140-era `-Force` runs).
  - **N=16, run 2 of 3: NOT COMPLETED -- froze the host.** Launched
    immediately back-to-back after run 1 (same oversubscribed
    32-slots-on-26-cores `-Force` pattern, no cooldown). The host became
    fully unresponsive; the user had to hard-reset the machine
    (`vc travou todo o computador tive que resetar`). `N16_run2.log` is
    0 bytes -- the freeze happened before the script produced any output at
    all. This is precisely the failure mode `run_production_mwdt.ps1`'s own
    header comment already documents ("an unconstrained 16-session run is
    what froze this host on 2026-09-03") -- this episode reproduced it by
    chaining a second such burst immediately after the first, with no
    headroom check or cooldown between them. Post-recovery: zero orphan
    QEMU/test processes, CPU idle (~0.5%), no runaway memory, and every
    file this episode had edited was verified intact (no corruption). **B11
    N=16 x3 was NOT retried in this episode** -- one clean run is the
    achieved evidence; a second/third attempt needs either a safer
    invocation (real headroom between bursts, a lower session count, or
    genuine `ReserveCores` margin instead of `-Force`) or explicit,
    risk-informed authorization before trying again on this host.
- `RESET_WAIT` (3/3) and the full `E131` battery (6/6): **not re-executed
  in this episode.** Both are QEMU-side cache-wait/reset-cycle gates,
  already `CLOSED_PENDING_REVIEW` at E132-B, and this episode's fix is
  Core-only (`McuComponent.cpp`/`VnextBArbiter.*`) against an unchanged
  QEMU binary (`475C0FC9...`, re-verified byte-identical throughout) --
  out of this fix's blast radius, but flagged here explicitly rather than
  silently assumed.

Zero QEMU orphans confirmed at every checkpoint except the one gap noted
above (the freeze itself, recovered by hard reset, not by this session's
own cleanup). No B12, promotion, `QEMU_RUNTIME.json` edit, cleanup,
commit, push, tag, or release. Canonical (`B375A9E8...`) untouched. Full
artifacts, logs, hashes, and effective environments under
`vnext_prototype/mttcg_causality/E144-debug-release-and-h143-rewire_20260908_184800/`.

## E145 — H143 closure certified for Release; safe MTTCG host capacity computed and enforced fail-closed in production; RESET_WAIT/E131 blocked by a pre-existing oracle/QEMU-cleanup incompatibility; a new, narrow, non-H143 timing intermittency surfaced; B12 NOT run (2026-09-09, ~06:32-07:20)

Classification: **REVIEW_REQUIRED.** H143 is closed and safe MTTCG capacity
is certified and enforced in the product itself, not just test runners --
both explicit E145 objectives are met. B12 was **not** attempted: Phase 3
(RESET_WAIT/E131) is structurally blocked by an unrelated, pre-existing
harness/QEMU-cleanup incompatibility, and B11 N=13 (this host's calculated
`safe_sessions`) was not executed -- the user reviewed the plan to run it
and explicitly chose to skip it for this episode. A newly-surfaced,
narrow, intermittent timing sensitivity (NOT H143, NOT capacity-related)
is documented precisely rather than glossed over.

### Historical table (built before any edit, per this episode's own
requirement -- Debug and Release results never mixed in one conclusion)

| Episode | Build | H143 | Sessions | ReserveCores | `-Force` | Functional result | Freeze/timeout/orphans |
|---|---|---|---|---|---|---|---|
| E132-E (2026-09-07) | **Release** | present (unknown/unmeasured then) | 1 (restart x15) | n/a | n/a | PASS 15/15 | none |
| E132-F (2026-09-07) | Release | present | N=1/8/16 (B11) | 6 | N=16 only | N=1/8 PASS; N=16 first real B11 red (E133) | none |
| E133 (2026-09-07) | Release | present | N=16 (R0 and R6+Force) | 0 and 6 | both tried | N=16 OPEN: real, scale-sensitive TG1/panic red under **both** R0/no-Force and R6+Force | none reported |
| E142 (2026-09-08) | **Debug** (unnoticed) | present (undiagnosed) | 1 (restart) | n/a | n/a | FAIL, always (storm) | none (no multi-session runs) |
| E143 (2026-09-08) | Debug | present -> fixed -> reverted | 1 (restart) | n/a | n/a | RED reproduced+fixed in isolation; real system still short of deadline -> reverted | none |
| E144 (2026-09-08) | **Release** (corrected) | fixed | N=1/8/12/16 (B11) + restart x15 | 6 | N=16 only | Restart 15/15; B11 N=1/8/12 PASS; N=16 run1 PASS | **run2 froze the host** (hard reset required) |
| E145 (2026-09-09) | **Release** | fixed (re-confirmed) | N=1/8/12 (B11) + restart x15 x4 | 6 | **never used** | See below | zero orphans, zero freeze |

### Phase 0 — snapshot and identities

`vnext_prototype/mttcg_causality/E145-h143-closure-mttcg-capacity-certification_20260909_063200/`.
Host: 32 logical processors (`nproc`/`std::thread::hardware_concurrency()`
agree). QEMU E141 candidate `475C0FC956E43FFC0CB83CECE0DC384457A9E1F01D2C6A3F6C21C4665C7EB23D`
re-verified. Canonical runtime `B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`
re-verified. `QEMU_RUNTIME.json` re-hashed and its own content re-read:
canonical pointer unchanged, untouched. Firmware `merged.bin`
`1DA8BF731830B2D2D9CE6EDBB0EA208636A1DB2A79497A8DB0CC98D72864C76A` and
`firmware.elf` `1697587B58F9DF862765ADABC2F5A2E74387863438D8A6DF775196A542C9D9B6`,
both re-verified. Zero QEMU orphans at the start. Git state of both repos
preserved (no stash/reset/checkout) -- this episode's edits layer on top of
E141-E144's already-accumulated, uncommitted changes, unchanged.

Confirmed in source, before writing anything, that the H143 fix from
E143/E144 is wired to the real production call path, not just present as an
inert helper: `McuComponent::pollAndDispatchPendingEvents()`'s post-ack
block calls `qemu::decidePostAckRearm()` (`VnextBArbiter.hpp`) directly,
unchanged since E144. Confirmed `SessionRestartStressTest.cpp` prints
`HARNESS_BUILD_CONFIG=Release`/`=Debug` unconditionally at
`PHASE_00_TEST_START` and fails closed under
`LASECSIMUL_REQUIRE_RELEASE=1` when built Debug (both from E144, re-verified
working in this episode's own Phase 2 runs below).

### Phase 1 — safe MTTCG capacity, computed and enforced fail-closed in production

Formula (not hardcoded to this machine):
`safe_sessions = floor((logicalProcessors - reserveProcessors) / vcpusPerSession)`.
On this host: `floor((32-6)/2) = 13`.

Audited the production launch path (`McuController.cpp`) and found **no**
equivalent guard existed anywhere in `core/src` before this episode (only
the test runner, `run_production_mwdt.ps1`, had one, since E133/
DECISION-010) -- a project with enough MCU components could reproduce
DECISION-010's host-freeze scenario in ordinary product usage, no test
harness involved. Implemented, in scope
(`core/src/mcu/qemu/VnextBCapacityGuard.hpp`, new; wired into
`McuController.cpp`'s VNEXT_B branch of `start()`/`stop()`):

- `computeSafeVnextBSessions(logicalProcessors, reserveProcessors,
  vcpusPerSession)` -- pure, header-only, unit-tested.
- `vnextBSafeSessionsForThisHost()` -- reads the REAL host topology via
  `std::thread::hardware_concurrency()` every call (fails closed to 0 safe
  sessions if the platform can't report it, never assumes unbounded
  capacity). Never a per-machine constant.
- A process-wide `std::atomic<uint32_t>` active-session counter,
  incremented/decremented strictly on `McuController::m_vnextBAttached`'s
  false<->true transitions (guards against double-counting on a re-entrant
  `start()` without an intervening `stop()`, since `VnextBAttachment::
  prepare()` tears down any prior attachment on the same controller
  internally).
- Admission check runs **before** `VnextBAttachment::prepare()` -- a
  rejection never creates a QEMU process. Throws with requested/logical/
  reserved/per-session/safe-ceiling numbers spelled out in the message.
- `LASECSIMUL_VNEXT_B_CAPACITY_OVERRIDE=1` escape hatch, opt-in only, not
  referenced by any runner/gate/config in this codebase (grepped clean).

Unit tests added to `VnextBArbiterTest.cpp` (kept in the same pure-logic
test binary as H143's own tests rather than a new CMake target): below the
limit, exactly at the limit, above the limit (matches this host's 13
exactly, and N=16 exceeding it), zero-processors/zero-vCPU/usable==reserved
edge cases (no underflow/div-by-zero), and a *different* host shape
(8 logical, 2 reserved -> 3 safe sessions) proving the formula generalizes
and was not hardcoded to this machine. **8/8 new tests pass**, alongside
the pre-existing 12/12 H143 tests (20/20 total, Release, `vnext_b_arbiter_
test.exe`, 0 failures).

Live-fire verification of the guard's *rejection* path (an actual N>13
launch attempt refused) was deliberately not exercised in this episode:
doing so would require oversubscribing this same host again, which is
exactly the risk this guard exists to remove, immediately after two prior
freeze incidents in this same investigation (E144, and one during this
episode's own B11 N=16 planning -- see below). The guard's correctness
rests on the unit-tested pure math plus direct code-reading of the wiring,
judged sufficient without a live over-limit reproduction.

**A second host freeze occurred during this episode's own work**, before
any B11 run in this episode: while reviewing the B11 N=13 plan, the user
reported the machine had frozen again and had to be hard-reset. Per the
user's explicit instruction, `-Force` was **never used** in this episode
(no admission guard was bypassed at any point), N=16 was **not** attempted,
and cooldown/affinity/priority were **not** treated as a substitute for
real capacity headroom anywhere in this episode's own runs. (See Phase 5
for how N=13 itself was ultimately handled.)

### Phase 2 — H143 confirmed in Release; a separate, narrow, non-H143 timing intermittency found and precisely characterized

Explicit `/t:Rebuild /p:Configuration=Release` of `session_restart_stress_
test.vcxproj`. Ran **4** full default-15-cycle hermetic reproductions
against the E141 candidate, `LASECSIMUL_REQUIRE_RELEASE=1` set explicitly
each time (confirmed `HARNESS_BUILD_CONFIG=Release` printed every run):

- run1: **13/15** (cycles 0 and 1 "TRAVOU NO MEIO").
- run2: **15/15**.
- run3: **14/15** (cycle 0 only).
- run4: **15/15**.

Every one of the 3 "stalled" cycles was checked structurally, not just by
exit code: **`m_pollGeneration=0` in all three** (H143's storm signature is
completely absent -- proves the fix holds), `notificationPending`/
`pollEventScheduled` all consistent with healthy operation, and lane 0 was
**90-100% drained** in every case (`write=400/read=392`, `write=347/
read=347` [fully drained], `write=380/read=372`) with substantial real
`virtualTimeNs` advancement inside the cycle (e.g. 999ms->1164ms). This is
structurally incompatible with H143's mechanism (which produced permanent
zero-progress, `write=8/read=0`, thousands of generations) and is instead a
**narrow, early-cycle-only (cycle 0, occasionally cycle 1; never observed
in cycles 2-14 across all 4 runs, 55 later-cycle observations) miss of the
test's specific "did NEW I2C submissions arrive in this exact 5s window"
criterion**, despite healthy, substantial, ongoing dispatch. Not previously
characterized at this precision. Not H143. Not a capacity/host-load issue
(host was idle). Not a build-config issue (Release confirmed every run).
Zero orphans across all 4 runs.

This means Phase 2's literal "15/15 every attempt" bar was not met on 2 of
4 attempts -- reported exactly as measured, not rounded up to a clean pass.
Flagged as a distinct, separate, follow-up-worthy finding; not investigated
further in this episode (out of scope: E145 is about H143 and capacity, not
a new timing investigation, and the task's own instructions caution against
opening new fronts).

### Phase 3 — RESET_WAIT/E131: STOPPED, precisely classified as a harness/oracle failure, not a functional regression

Rebuilt `cache_wait_e2e_real_qemu_test.exe` (Release, full relink, links
the same fixed `McuComponent.cpp`/`Scheduler.cpp`). Ran the documented
6-case battery (`run_e131_cache_wait_e2e.ps1`, `ArtifactRoot=...E132-
gate-integrity\phase3_full_e131_20260907_095500`, matching E132-E's own
historical PASS precedent exactly) against the E141 candidate.

- First attempt: `SUPERVISOR_EXITCODE_UNAVAILABLE`, `harness_pid=0`,
  `exception=Cannot validate argument on parameter 'ArgumentList'...` --
  the exact, already-documented (E132-F) `Start-Process -ArgumentList @()`
  runner bug. Worked around with `-HarnessArguments noop`, matching the
  documented precedent exactly.
- Second attempt (DROM, first case): ran for real this time (QEMU
  launched, `session_create`/`scheduler_start` succeeded, an internal
  ~61s observation window ran to completion, `stopSimulation_begin/end=1`,
  clean teardown, zero orphans after) but `suspend_committed=0` and 8
  related failures ("guest did not publish E131 pass marker for DROM",
  etc.).

Traced this to source before concluding anything: `CacheWaitE2ERealQemuTest.
cpp` (lines ~400-403) unconditionally sets `LASECSIMUL_CACHE_WAIT_DIAG_
TRACE=1`, `LASECSIMUL_APP_CPU_RESET_TRACE=1`, `LASECSIMUL_E131_GUEST_MARK_
TRACE=1`, `LASECSIMUL_E131_TCG_TRACE=1`, then classifies pass/fail by
**grepping QEMU's own log text** for markers like `suspend_committed`
(`linesForEvent(logs, "suspend_committed")`). A direct grep of the entire
`qemu_lasecSimul` source tree for all four of those env var names returns
**zero matches** -- every one of these QEMU-side diagnostic tracers was
correctly, deliberately removed by E141's production-clean cleanup.
E132-E's historical PASS used a **different, pre-E141, non-production-
clean QEMU build** (`5E0F51664C88685EA986A2F7F975A728CD02190D05AB76EA17D9AB52A2C74F7A`,
`build-ucrt64`, dated before E141 existed) that still had these tracers.
This episode is the first time the E131/RESET_WAIT harness has been run
against the E141 production-clean candidate at all.

**Classification: harness/oracle failure, structurally identical in kind
to `VnextBAttachmentTest.cpp`'s E141-era P1 issue (E141's own EVIDENCE.md
entry) -- an oracle that depends on diagnostics the production-clean
cleanup correctly removed, not a functional defect, and not caused by
H143.** Per this episode's explicit constraints (do not reopen E131 as
exploratory investigation, do not reintroduce removed traces), no attempt
was made to re-oracle `CacheWaitE2ERealQemuTest.cpp` in this episode. The
remaining 5 cases (FETCH/RUNSTALL/CLKGATE/SELF_ILLEGAL/RESET_WAIT) were not
run, since they share the identical setup and would almost certainly hit
the same structural incompatibility, for no new information. Zero orphans
throughout this phase.

### Phase 4 — two full Release regressions

`run_regression.ps1 -Transport VNEXT_B -ExecutionMode MTTCG -Config Release
-QemuBinary <E141 candidate>`, twice: **PASS=14 of 14 both times**,
`QEMU_RUNTIME_SHA256=475C0FC9...` confirmed both times, zero orphans.

### Phase 5 — B11 capacity validation: N=1/8/12 clean (with one intermittent
N=1 miss, precisely characterized), N=13 not executed (user decision)

Rebuilt `vnext_b_production_scale_test.exe` (Release, full relink, the
capacity guard included). All runs below used `run_production_mwdt.ps1`
**without** `-Force` at any point.

- **N=1, attempt 1: FAIL.** `setupValid=false`, `submissions=0,
  completions=0`, but `unexpectedResets=0`, `artifactFatal=false`, and the
  QEMU boot log is completely normal (exactly the expected 2-reset
  healthy-boot signature, no storm, no crash). `PRODUCTION_SCALE FAIL
  failures=1` -- the sole failure is "zero I2C activity observed in the
  60s window," the exact same shape (not severity) as Phase 2's finding,
  now also observed in this different harness.
- **N=1, attempt 2 (retry): PASS.** `submissions=completions=1772`, clean.
- **N=8: PASS, 8/8 sessions**, all `workloadPass=true`, 16/16 resets (2/
  session), `MWDT_ATTRIB_RESETS=0`.
- **N=12: PASS, 12/12 sessions**, all `workloadPass=true`, 24/24 resets,
  `MWDT_ATTRIB_RESETS=0`.
- **N=13 (`safe_sessions`, the calculated ceiling for this host): NOT
  EXECUTED.** N=13 needs exactly 26 vCPU slots against exactly 26 usable
  cores -- no `-Force` would have been required (the guard's own math says
  this is the safe boundary), but before launching it the user reported a
  second host freeze had just occurred (during this episode's own planning
  for this step) and, when asked explicitly how to proceed, chose to skip
  B11 N=13 for this episode rather than attempt the exact-boundary case
  again so soon. Recorded per the task's own required classification:
  `NOT_EXECUTED_BY_EXPLICIT_USER_DECISION` -- not a PASS, not a FAIL, not a
  silent SKIP, and specifically not `NOT_APPLICABLE_ON_THIS_HOST` (which is
  reserved for N=16, genuinely beyond this host's calculated capacity; N=13
  is within it and was simply not attempted this episode).

N=1's single intermittent miss matches Phase 2's finding exactly in shape
(healthy boot, zero unexpected resets, zero I2C activity in the
observation window, resolved on retry) and is classified the same way:
narrow, real, not H143, not capacity/scale-related (it occurred at N=1, the
smallest possible scale, and did **not** recur at N=8 or N=12), not
investigated further in this episode. Zero orphans after every B11 run in
this phase, including the failed N=1 attempt.

### Phase 6 — B12: NOT RUN

Per the task's own explicit gating ("somente se todas as fases anteriores
passarem"), B12 was not attempted: Phase 3 is structurally blocked
(harness/oracle incompatibility, unrelated to H143) and Phase 5's required
N=13 cell was not executed (user decision). No `QEMU_RUNTIME.json` edit, no
promotion, no cleanup, no commit, no push, no tag, no release, no package.

### What was NOT touched

`SINGLE_REALTIME`, `ICOUNT`, LEGACY: not run. `Scheduler.cpp`/pacing: not
changed (no isolated RED proved a lost wake; E142/E143 already showed
`pacingPositionNs()` is not the limiting factor). Watchdog, cache, reset,
transport, ABI, firmware: unchanged. No probes/traces removed by E141 were
reintroduced. E114/E118/E124/E129/E131/E134/E139 were not reopened as
exploratory investigations (Phase 3's finding required only enough
investigation to correctly classify it as harness/oracle, which the task's
own stop-condition differentiation requirement demands, not a re-derivation
of E131's cache-wait semantics). Canonical (`B375A9E8...`) and
`QEMU_RUNTIME.json` untouched throughout, re-verified at the end. Zero
QEMU orphans at every checkpoint in this episode. Full artifacts, logs,
hashes, and effective environments under
`vnext_prototype/mttcg_causality/E145-h143-closure-mttcg-capacity-certification_20260909_063200/`.
