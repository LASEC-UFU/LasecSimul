# QEMU build and runtime provenance

## E145 state — QEMU unchanged; E141 candidate re-certified for Release+H143 with a computed, enforced safe MTTCG capacity; still unpromoted (2026-09-09)

QEMU itself was not touched in E145 (out of scope). Current canonical
development runtime remains:
`C:\SourceCode\LasecSimul\vnext_prototype\dev_qemu_runtime\qemu-system-xtensa.exe`
SHA256 `B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`,
re-verified unchanged.

`QEMU_RUNTIME.json` SHA256 `ADF0D79B9E533E17A3F8CA62FD890B1867973FBB1AFF1C95239142D03644B369`,
re-verified unchanged; its own `canonical_executable_sha256` field still
points at the same canonical above.

E141 production-clean candidate remains preserved and **still unpromoted**:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E141-production-clean_20260908_083000\candidate_qemu\qemu-system-xtensa.exe`
SHA256 `475C0FC956E43FFC0CB83CECE0DC384457A9E1F01D2C6A3F6C21C4665C7EB23D`,
re-verified unchanged. This episode (E145) closed the Core-side H143
finding against this exact candidate (Release: two full 15-cycle restart
runs clean, two full 14/14 regressions, B11 N=1/8/12 clean) and implemented
a production-path capacity guard limiting concurrent VNEXT_B sessions to
this host's computed safe ceiling (13). RESET_WAIT/E131 could not be
validated against this candidate in this episode -- the harness's own
oracle depends on QEMU diagnostics E141 correctly removed; see EVIDENCE.md
E145 and TEST_GATES.md.

E145 artifacts:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E145-h143-closure-mttcg-capacity-certification_20260909_063200`.

No promotion, B12, cleanup, commit, push, tag, package or release was
executed in E145. Next step is a decision on the two open findings
(RESET_WAIT/E131 oracle gap; a narrow early-cycle timing intermittency) and
on B11 N=13 before any further B12 attempt -- see NEXT_ACTION.md.

## E138 state — candidate remains unpromoted after ROM/EFUSE reclassification (2026-09-08)

Current canonical development runtime remains:
`C:\SourceCode\LasecSimul\vnext_prototype\dev_qemu_runtime\qemu-system-xtensa.exe`
SHA256 `B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`.

Authoritative runtime manifest remains:
`C:\SourceCode\LasecSimul\orchestrator\.ai\QEMU_RUNTIME.json`
SHA256 `ADF0D79B9E533E17A3F8CA62FD890B1867973FBB1AFF1C95239142D03644B369`,
unchanged.

E134/E135 candidate remains preserved and unpromoted:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\candidate_qemu\qemu-system-xtensa.exe`
SHA256 `3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`.

E138 artifacts:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E138-rom-efuse-classification_20260908_055000`.

No promotion, B12, cleanup, commit, push, tag, package or release was executed
in E138. The next step is review before any semantic EFUSE fix or runtime
promotion.

## E136 state — candidate remains unpromoted after rare panic non-reproduction (2026-09-07)

Current canonical development runtime remains:
`C:\SourceCode\LasecSimul\vnext_prototype\dev_qemu_runtime\qemu-system-xtensa.exe`
SHA256 `B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`.

Authoritative runtime manifest remains:
`C:\SourceCode\LasecSimul\orchestrator\.ai\QEMU_RUNTIME.json`
SHA256 `ADF0D79B9E533E17A3F8CA62FD890B1867973FBB1AFF1C95239142D03644B369`,
read-only.

E134/E135 candidate remains preserved and unpromoted:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\candidate_qemu\qemu-system-xtensa.exe`
SHA256 `3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`.

E136 artifacts:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E136-b11-n16-panic-classification_20260907_220542`.

No QEMU processes remain.

## E135 NOT_APPLICABLE retry — canonical restored after B11 N=16 red (2026-09-07)

Current canonical development runtime:
`C:\SourceCode\LasecSimul\vnext_prototype\dev_qemu_runtime\qemu-system-xtensa.exe`
is restored to rollback SHA256
`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`.

Authoritative runtime manifest:
`C:\SourceCode\LasecSimul\orchestrator\.ai\QEMU_RUNTIME.json`
is restored to SHA256
`ADF0D79B9E533E17A3F8CA62FD890B1867973FBB1AFF1C95239142D03644B369` and remains
read-only.

E134/E135 candidate remains preserved at:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\candidate_qemu\qemu-system-xtensa.exe`
with SHA256
`3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`.

E135 executor after NOT_APPLICABLE fix:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\E135-gate-executor_20260907_181428\Invoke-E135PromotionGate.ps1`
with SHA256
`501470CC413937227B6EC26E64D563E8096B7AD76C070F3F9208770D136C3381`.

The final E135 promotion attempt passed candidate preflight, official
`VNEXT_B+MTTCG` 14/14, QEMU unit gates, Core attachment/restart gates and B11
N=1 through canonical `3D951D7C...`, then rolled back at B11 N=16 because the
B11 classifier reported `classifier_cellPass_false`.

Zero QEMU processes remained after rollback. The vendored runtime at
`C:\SourceCode\LasecSimul\devices\qemu-esp32\bin\qemu-system-xtensa.exe`
remains old and is still a separate release blocker.

## E135 fail-closed executor state — promotion currently rolled back (2026-09-07)

Current canonical development runtime:
`C:\SourceCode\LasecSimul\vnext_prototype\dev_qemu_runtime\qemu-system-xtensa.exe`
is restored to rollback SHA256
`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`.

`QEMU_RUNTIME.json` is restored to SHA256
`ADF0D79B9E533E17A3F8CA62FD890B1867973FBB1AFF1C95239142D03644B369` and remains
read-only.

E135 candidate remains preserved at:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\candidate_qemu\qemu-system-xtensa.exe`
with SHA256
`3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`.

E135 executor:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\E135-gate-executor_20260907_181428\Invoke-E135PromotionGate.ps1`
with SHA256
`25A367AB2196EB21C090F9E41D013E1B06B3588FF950A5CA9F66749E3E6974A1`.

Promotion attempts were rolled back because of executor/gate-content conflicts,
not candidate runtime semantics. The unresolved blocker is that E135 requires
rejecting `PULADO:`, while the current historical 14-test VNEXT_B+MTTCG
regression includes a passing `mcu_controller_real_qemu_test` that emits a
known LEGACY-only `PULADO:` line.

Zero QEMU processes remained after rollback.

## Update E132-B-review approved (2026-09-07)

Reviewer independente aprovou `E132-B-review-20260907` em
`orchestrator\.ai\WORK_RESULT.json` (`state=EXECUTE`). A aprovação fecha E131
estritamente para `VNEXT_B+MTTCG`, mas não promove runtime por si só.

Snapshot inicial pós-review preservado em
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E132-post-review_20260907_113506`.
Ele contém status Git dos dois repositórios, variáveis `LASECSIMUL_*`, processos
QEMU iniciais e cópias/hash do runtime canônico `B375A9E8...`, do candidato
E132-B `5E0F5166...`, do harness `4D06CDF...` e do teste de escala
`81A7472...`.

Auditoria de fonte E132-B antes de rebuild: geração APP CPU é incrementada no
ponto real de `cpu_reset()` e não depende de `LASECSIMUL_CACHE_TRACE`; o
watermark usado para provar execução pós-R6 é o contador atômico
`vnext_cpu_exec_probe_count()`; R4/R6 registram geração e watermark; o marcador
tardio registra watermark/estado de CPU1; o harness seleciona o par R4/R6
posterior ao suspend, exige geração `+1`, `reset_wait_cleared` ordenado,
`wait_mask=0`, ausência de `resume_committed` stale, CPU1 não stopped/halted e
crescimento real do watermark depois de R6. Traces diagnósticos permanecem
gated por ambiente e OFF por padrão.

## Update E132-B (2026-09-07)

O build QEMU de diagnóstico avaliado tem SHA-256
`5E0F51664C88685EA986A2F7F975A728CD02190D05AB76EA17D9AB52A2C74F7A` e está
preservado sob `vnext_prototype\mttcg_causality\E132-gate-integrity`.
RESET_WAIT passou 3/3 e a bateria E131 passou 6/6. O runtime canônico continua
`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`;
`QEMU_RUNTIME.json` não foi alterado. Estado: revisão obrigatória antes de
qualquer regressão ampla, B11 ou promoção.

Consolidated 2026-09-03. This file used to be a third iteration diary that
duplicated `STATUS.md`; that history now lives only in `STATUS.md`, and only
the build/runtime provenance is kept here because rebuilding QEMU is currently
the project's single blocker.

`QEMU_RUNTIME.json` is authoritative for the current canonical hash. The SHA
recorded in the old version of this file
(`58ED43B801E75D87C0B92EEE1ED4AE3A3C6D1C2178D5D893A40EAE0609F459D4`) was
superseded at iteration 54 and is historical only.

## Source repository

- Path: `C:\SourceCode\qemu_lasecSimul`
- Remote: `https://github.com/josuemoraisgh/qemu_lasecSimul.git`
- Branch: `main`, upstream `origin/main`, ahead/behind `0 0`, not detached
- HEAD: `9dc30419a5372756b555ad7926563dcda2215c79` (2026-08-28T19:59:31-03:00)
- Submodules: none
- Worktree: **dirty**

The dirty worktree carries pre-existing tracked edits in the QEMU transport,
ESP32 peripheral, reset/timing and build-registration files, and the untracked
`softmmu/vnext_b.c` / `softmmu/vnext_b.h`. Files under `build-ucrt64` are also
dirty or untracked. None of that was reverted.

Changes made on 2026-09-03 (diagnostic fixes plus CPU1 pause compensation, see
E102/E103/E107):

| File | Tracked? | Revert |
|---|---|---|
| `softmmu/vnext_b.c` | no | `softmmu/vnext_b.c.orig-before-e102`, plus `vnext_b_backpressure_diagnostic.patch` |
| `hw/i2c/esp32_i2c.c` | yes | `git checkout`, plus `esp32_i2c_hotpath_diagnostic.patch` |
| `hw/timer/esp32_timg.c` and `include/hw/timer/esp32_timg.h` | yes | manually revert the DECISION-011/E107 union-window hunks |

## How the canonical runtime is built

The MSYS2 UCRT64 environment described below **is installed on this host** at
`C:\SourceCode\tools\msys64` (installed 2026-09-03 from the official
`msys2-base-x86_64` archive). The path matters: `build-ucrt64/build.ninja`
hardcodes it, so installing elsewhere would require reconfiguring meson.

- Build directory: `C:\SourceCode\qemu_lasecSimul\build-ucrt64`
- Target: `qemu-system-xtensa.exe`
- Build system: Meson + Ninja
- Host config: Windows UCRT64, `CONFIG_WIN32=y`, `CONFIG_TCG=1`,
  `TARGET_DIRS=xtensa-softmmu`
- Compiler: GCC 16.2.0 (MSYS2); Binutils 2.47
- Cap parallelism: `nice -n 19 ninja -j 8 ...` (DECISION-010)
- Configure options already applied in `build-ucrt64`:
  `-Dgtk=disabled -Dsdl=disabled -Dvnc=disabled -Dcurses=disabled
  -Dgcrypt=enabled -Dslirp=enabled -Db_pie=false -Ddocs=disabled`
- Build command (from an MSYS2 UCRT64 shell, in the build dir):
  `nice -n 19 ninja -j 8 qemu-system-xtensa.exe`

If a build is interrupted (power loss, kill) it can leave zero-byte objects and
NUL-filled generated headers that then fail to link with thousands of
`undefined reference to visit_type_*`. Recovery is `ninja -t clean` followed by a
full rebuild. See DECISION-010.

Because the build includes the untracked VNEXT source and the modified tracked
files, any resulting hash is attributable to the current dirty worktree. Exact
historical binary provenance is not claimed beyond build/runtime hash equality.

## Staging the runtime (DECISION-001)

The raw `build-ucrt64` executable is **not** a standalone runtime: launched
without its adjacent DLLs it returns `0xC0000135`. The canonical test runtime is
the staged copy at

```text
C:\SourceCode\LasecSimul\vnext_prototype\dev_qemu_runtime\qemu-system-xtensa.exe
```

which carries the same SHA-256 as the build executable plus the MSYS2 UCRT64 DLL
set beside it. After any rebuild, restage **with** those DLLs and update
`canonical_executable_sha256` in `QEMU_RUNTIME.json`.

Current staged/build executable SHA-256 after E107:
`02D3F7159DA9A2D4D9B9155780D34499DFDD6FEB236F94175F586FA0B964B1EB`
(staged 2026-09-03T18:38:34-03:00). The immediately previous canonical hash
was `5C621E0B577F648CE665B33CB92F5A214EA5981ADCA369852A3FD8514B1EE2CF`.

## Rollback artifact (DECISION-002)

`C:\SourceCode\LasecSimul\devices\qemu-esp32\bin\qemu-system-xtensa.exe` remains
unchanged at SHA-256
`471AE54193CC7A86F6A448D53BC1E810F5B50D6EBAD1FE48FC34AA04F56F74CE`. It is never
substituted for the canonical runtime.

## Launch shape

Production launch is `-M esp32-simul`, MTTCG (`-accel tcg,thread=multi`), with
Core injecting numeric `tb-size=64`, and the shared-memory arena key passed as
`argv[1]` (`softmmu/main.c`, `simuliface.c::simuMain`).

For standalone device-level work, `-M esp32-simul ... -kernel <file.elf>` boots a
bare-metal image with no Core and no arena — see `QEMU_HANDOFF.md` section 4 and
`vnext_prototype/guest_mwdt_baremetal/README.md`.
# QEMU current state — E134 phase 1 review checkpoint (2026-09-07)

Current active checkpoint: **REVIEW_REQUIRED** for E134 watchdog
scale/reanchor correction.

E134 has confirmed, without applying the semantic fix, that the current TIMG
watchdog implementation mixes literal tick accounting with scaled armed
deadline arithmetic. `get_count()` accumulates literal ticks; `update_config()`
stores that literal count in `count_base`; `arm()` subtracts it from raw
`stage_timeout` before multiplying nanoseconds by `wdt_time_scale`.

RED proof artifact:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218`.

No runtime has been promoted. `QEMU_RUNTIME.json` still points to canonical
runtime SHA `B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`.
The E133 candidate SHA remains
`5E0F51664C88685EA986A2F7F975A728CD02190D05AB76EA17D9AB52A2C74F7A`.

Do not run B11/B12 or promote runtime until the review packet is resolved and,
if approved, the E134 validation stack passes.
# E134 current QEMU state — implemented candidate, closure review pending (2026-09-07)

`VNEXT_B+MTTCG` E134 watchdog scale/reanchor correction is implemented in the
QEMU source tree and built as candidate:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\candidate_qemu\qemu-system-xtensa.exe`
SHA256 `3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`.

Do not replace `vnext_prototype\dev_qemu_runtime\qemu-system-xtensa.exe` yet.
Do not run B12/promotion/cleanup/commit/tag/release until E134 closure review is
approved.

Validation status: deterministic WDT scale 13/13 PASS, QEMU build PASS, two
`VNEXT_B+MTTCG` regressions 14/14 PASS, B11 N=1/N=8/N=12 PASS and N=16 PASS
3/3. Remaining caveat: no successful observable no-feed integrated expiry run.
# E137 current QEMU state — review required after panic-only B11 N=16 red (2026-09-08)

The E134 candidate QEMU remains an unpromoted candidate:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\candidate_qemu\qemu-system-xtensa.exe`
SHA256 `3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`.

E137 reproduced a B11 N=16 red with this candidate, real firmware,
`VNEXT_B+MTTCG`, `ReserveCores=6`, `Force`, and only
`LASECSIMUL_PANIC_CAUSAL_TRACE`. The WDT causal trace was deliberately not
enabled because source audit shows it also emits bounded synchronous
`[LANE0_EXHAUSTION_PRODUCER]` messages from VNEXT_B backpressure.

The reproduced red proves a terminal `SW_SYS_RESET`/unexpected `RTC_RESET`
cascade but not the original exception frame: `g_exc_frames=NULL` for both
cores. No semantic fix is currently justified. `QEMU_RUNTIME.json` still points
to canonical runtime SHA `B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`;
do not promote or run B12 before review.
