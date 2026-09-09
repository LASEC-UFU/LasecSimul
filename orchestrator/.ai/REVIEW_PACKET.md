# REVIEW PACKET — E140 post-boot cause-latch audit

REQUEST_ID: `E140-postboot-cause-latch-20260908`

## Decision requested

Review the E140 diagnostic result:

`NO_RECURRENCE_IN_THREE_VALID_N16_WITH_MINIMAL_LATCH`

and decide whether the opt-in latch candidate should be retained, adjusted, or
removed before any future B12/promotion path.

This packet does not request B12, runtime promotion, package, release, cleanup,
commit, push, or tag.

## Current result

`DIAGNOSTIC_COMPLETE — NO_RECURRENCE_IN_THREE_VALID_N16_WITH_MINIMAL_LATCH`

E140 did not capture a new initiating cause because the post-boot signature did
not recur in the authorized bounded window.

Mandatory historical declaration:

`E139_POST_BOOT_SIGNATURE_MATCHES_PRIOR_PANIC_PIPELINE_BUT_INITIATING_CAUSE_IS_NOT_CAPTURED`

## Main report

`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E140-postboot-cause-latch_20260908_071200\E140_postboot_cause_latch_report.md`

Report SHA-256:

`2EE31B6629B84A9CB75096BFAD07A870ABDACBBF0AFBFB1EC6DD4D808ACBD7C3`

## Identity

| Artifact | SHA-256 | Result |
|---|---|---|
| E139 baseline candidate QEMU | `8F7F7A334FFA17A6B8FC080EB75F70BD9D85EBECFB3F07A1BCC2A6995BF612AD` | preserved |
| E140 diagnostic candidate QEMU | `8F47106B4ED949576DF8D76501997ECAE86C095894501B51F8D3CA6B8153FF69` | preserved |
| E134 candidate QEMU | `3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6` | prior candidate preserved |
| Canonical rollback runtime | `B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E` | intact |
| `QEMU_RUNTIME.json` | `ADF0D79B9E533E17A3F8CA62FD890B1867973FBB1AFF1C95239142D03644B369` | intact |
| Firmware `merged.bin` | `1DA8BF731830B2D2D9CE6EDBB0EA208636A1DB2A79497A8DB0CC98D72864C76A` | confirmed |
| Firmware `firmware.elf` | `1697587B58F9DF862765ADABC2F5A2E74387863438D8A6DF775196A542C9D9B6` | confirmed |

## What changed

E140 added an opt-in diagnostic latch only:

- `C:\SourceCode\qemu_lasecSimul\include\hw\misc\esp32_postboot_cause_latch.h`
- `C:\SourceCode\qemu_lasecSimul\hw\misc\esp32_postboot_cause_latch.c`
- `C:\SourceCode\qemu_lasecSimul\tests\unit\test-esp32-postboot-cause-latch.c`

Integration points:

- `C:\SourceCode\qemu_lasecSimul\hw\misc\esp32_dport.c`
- `C:\SourceCode\qemu_lasecSimul\hw\timer\esp32_timg.c`
- `C:\SourceCode\qemu_lasecSimul\hw\xtensa\esp32_intc.c`
- `C:\SourceCode\qemu_lasecSimul\hw\xtensa\esp32.c`
- `C:\SourceCode\qemu_lasecSimul\hw\misc\meson.build`
- `C:\SourceCode\qemu_lasecSimul\tests\unit\meson.build`

The latch is gated by `LASECSIMUL_POSTBOOT_CAUSE_LATCH=1`. Hot-path record
hooks use fixed state and do not perform heap allocation, I/O, or blocking
locking. The single structured `[POSTBOOT_CAUSE_LATCH]` dump is emitted only at
reset dump time, before the existing reset log and before clearing state/CPU.

Patch preserved:

`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E140-postboot-cause-latch_20260908_071200\E140_qemu_source_diff.patch`

Patch SHA-256:

`B13095C69D142E875A1D5A82C41223ED32199051FE34765A3E7A1E8F58A77DB1`

No Core, firmware, transport, scheduler, WDT scale, cache-wait semantics,
reset policy, B12, promotion, `QEMU_RUNTIME.json`, cleanup, commit, push, tag,
package, or release change was made.

## Validation passed

Small tests, all exit code 0:

- `test-esp32-postboot-cause-latch` 6/6
- `test-esp32-dport-cache-race-stall`
- `test-esp32-efuse-op-state`
- `test-esp32-panic-trace-gate`
- `test-esp32-timg-pause`
- `test-esp32-timg-wdt-scale`

Bounded real validation with only `LASECSIMUL_POSTBOOT_CAUSE_LATCH=1`:

- N=1/60s: 1/1 workload, `9329==9329` submissions/completions, zero
  unexpected resets, zero CACHEERR/Guru, zero real cause latch, clean teardown,
  zero orphans.
- N=16/60s run1: 16/16 workloads, `48335==48335`
  submissions/completions, zero unexpected resets, zero CACHEERR/Guru, zero
  real cause latch, clean teardown, zero orphans.
- N=16/60s run2: 16/16 workloads, `48581==48581`
  submissions/completions, zero unexpected resets, zero CACHEERR/Guru, zero
  real cause latch, clean teardown, zero orphans.
- N=16/60s run3: 16/16 workloads, `30371==30371`
  submissions/completions, zero unexpected resets, zero CACHEERR/Guru, zero
  real cause latch, clean teardown, zero orphans.

Consolidated matrix:

`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E140-postboot-cause-latch_20260908_071200\E140_run_matrix.json`

## Review question

Confirm whether E140 may be closed as a bounded diagnostic audit with no
recurrence, while preserving the historical initiating cause as uncaptured.

Do not infer that the rare post-boot signature is fixed. Do not authorize B12
or runtime promotion from this packet unless a separate promotion review does
so explicitly.
