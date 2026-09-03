# START HERE - LasecSimul VNEXT_B / ESP32

Single entry point for this work. Read this file first, then only the sections
of `STATUS.md` / `EVIDENCE.md` it points you at. Everything else in this folder
is supporting detail.

Last consolidated: **2026-09-03** (full re-audit of the `.ai` notebook against
source and fresh measurements).

---

## 1. What are we trying to solve?

Finish the production **VNEXT_B ESP32 integration** so that roughly 16 isolated
QEMU sessions run on one shared classroom host without losing ESP32
functional/timing fidelity. Definition of done is `FINAL_CHECKLIST.md`.

Almost all of that checklist was already green before this consolidation. The
work had been stuck for weeks on **one** remaining behavioural gate:

```text
ESP32_MWDT_BEHAVIOR  - fed survives load; unfed still resets
ESP32_MWDT_LOAD_INDEPENDENCE
```

## 2. What is the state right now?

**Device level: both MWDT gates PASS.** Proven with a framework-free bare-metal
fixture (E097-E101), reproduced on the rebuilt binary.

**Production Core/VNEXT_B path: still OPEN, but the picture is now clear.**

Two real defects were found and fixed, and the fixes are **built, staged and
regression-tested** (the earlier "no C toolchain" blocker is closed - MSYS2
UCRT64 is installed at `C:\SourceCode\tools\msys64`):

- `softmmu/vnext_b.c` emitted an unconditional, unbounded `fprintf(stderr)` on
  the lane-credit backpressure path, positioned *before*
  `esp32_timg_transport_pause(lane, true)` so its host time was charged to the
  guest watchdog instead of credited back (E102).
- `hw/i2c/esp32_i2c.c` had two unconditional per-operation `ackERR` writes -
  the ones `STATUS.md` and `DECISION-003` both recorded as already fixed - plus
  an unbounded empty-FIFO report (E103).

Together those three sites produced **99.97% of all QEMU output**. After the
fix, a 16-session run emits ~2,600 lines instead of 258,247, and the decisive
consequence is that **every session's reset records now survive Core's 1 MiB
retained log** instead of being evicted. That is why earlier investigations kept
finding logs with no reset evidence in them (E045, E051).

**But the watchdog resets did not go away**, so E102's causal hypothesis is
refuted (E105):

```text
sessions   MWDT-attributed resets
   1, 4, 8    0
  12          2
  16          4, 0, 6, 4, 4     (five runs)
```

Clean through 8 sessions; intermittent from 12 upward. The remaining suspect is
host CPU oversubscription in MTTCG-realtime - `QEMU_CLOCK_VIRTUAL` follows wall
time while emulated throughput does not - not the transport and not the
diagnostics. **Unproven**; see section 8.

Regression status: the same ten Core tests give **identical results** on the
patched and pre-patch binaries (7/10, three pre-existing failures), so the
fixes introduce nothing new (E106).

### Why it stayed stuck for weeks

None of that was visible earlier, because the investigation could not run the
experiment at all. It was a **test-vehicle problem**: there was no guest
firmware that could be trusted to *not* feed the watchdog.
Every earlier attempt used the Arduino or ESP-IDF framework, which owns and
feeds `TIMG_WDT` itself, so no "unfed" precondition could ever be established
(E060-E063). Trying to build a framework-free ESP-IDF fixture then consumed
**iterations 61-90 (~30 iterations over two days) entirely on Python packaging**
and produced zero watchdog evidence.

The fix was to stop needing a framework at all. See section 4.

## 3. What was already settled before this (do not redo)

Closed and reviewer-approved: `PRODUCTION_SESSION_FAILURE_ISOLATION`,
`PRODUCTION_COMBINED_WORKLOAD`, `SHARED_DISPATCHER_FAIRNESS`,
`FINAL_RESOURCE_ACCOUNTING`, `VNEXT_PRODUCTION_TCG_CONFIGURATION`,
`FINAL ABI ALIGNMENT`, `VNEXT_LEGACY_DEPENDENCY_AUDIT`,
`ESP32_SUPPORT_MATRIX_AUDIT`, `VNEXT_TRACE / HOT-PATH DIAGNOSTIC I/O`.

Frozen architecture (`PROJECT_CONSTITUTION.md`) is unchanged and was **not**
touched by this work: ABI v5, dispatcher, ProducerLane, ResponseSlot/C2A,
backpressure, watchdog/reset policy, queue depth, canonical runtime, rollback
artifact, Git history.

## 4. The thing previous agents missed

Three facts, all verifiable in this repository, none of which required any
Python, ESP-IDF, or PlatformIO runtime:

1. **`hw/xtensa/esp32.c:1140-1172` implements a `-kernel <elf>` boot path.**
   It loads an ELF and sets the architectural entry point directly, bypassing
   the ROM and second-stage bootloader. `esp32_soc_reset` re-applies
   `elf_entry` on every reset, so a bare-metal ELF also survives reboots.
2. **A working bare-metal Xtensa build already existed in the repo**
   (`vnext_prototype/guest_i2c_baremetal`). It needs only
   `xtensa-esp32-elf-gcc` + `objcopy` from
   `.piohome/packages/toolchain-xtensa-esp32`, which are present and working.
   Build time: about 2 seconds.
3. **`-M esp32-simul` runs standalone.** It skips the `serial0/1/2` chardev
   properties that the plain `esp32` machine requires (and which this fork does
   not declare), and with no arena mapped `m_arena` is `NULL`, so `simu_event`
   and `waitForSynch` return immediately. No Core, no shared memory, no session.

Together these give a deterministic, framework-free MWDT oracle that builds in
seconds. That is the vehicle the investigation lacked for four weeks.

## 5. Evidence that the gates now pass

Fixture: `vnext_prototype/guest_mwdt_baremetal` (fixture source, build and
runner scripts; see its `README.md`). All runs use the canonical QEMU
`dev_qemu_runtime\qemu-system-xtensa.exe`, `-accel tcg,thread=multi`,
`LASECSIMUL_ESP32_WDT_SCALE=1` (literal timing, the strictest case), and the
opt-in watchdog traces **off** (see section 6).

Three-arm experiment at the 16-session classroom population, 180 s window:

| Arm | Guest behaviour | MWDT resets | Instances resetting |
|---|---|---|---|
| `tg0_unfed` - negative control | configure, never feed | 82 | **16/16** |
| `tg0_fed_then_starve` - validity | configure, feed 3000x, then starve | 78 | **16/16** |
| `tg0_fed` - positive | configure, feed forever | **0** | **0/16** |

The validity arm is byte-identical to the positive arm up to and including the
instruction that enables the watchdog; only the feed budget differs. All 16 of
its instances armed and reset, so the positive arm's zero cannot be a guest
that never ran. That is the check every previous "PASS" lacked.

Single-instance reset routing, 40 s window each:

| Variant | MWDT resets | `cause0` |
|---|---|---|
| `tg0_unfed` | 10 | 7 = `ESP32_TG0WDT_SYS_RESET` |
| `tg1_unfed` | 10 | 8 = `ESP32_TG1WDT_SYS_RESET` |
| `tg0_fed` | 0 | - |
| `tg1_fed` | 0 | - |

## 6. Two measurement hazards found on the way

**H1 - the opt-in watchdog traces cost about 2 s per line and destroy timing.**
With `LASECSIMUL_TG0_WDT_TRACE=1`, the host gap between two *adjacent guest
store instructions* was median **2.23 s** (min 0.91 s, max 4.63 s). Because
`QEMU_CLOCK_VIRTUAL` tracks wall time in MTTCG-realtime, a 1 s watchdog
deadline fired at **12.7 s of virtual time**. The same fixture with traces off
produced 10 resets in 40 s.

Consequence: **every timing number in `EVIDENCE.md` collected with
`LASECSIMUL_TG0_WDT_TRACE` / `LASECSIMUL_TG1_WDT_TRACE` / `LASECSIMUL_VNEXT_TRACE`
enabled is invalid as a timing measurement** - E062's "TG1 feed at 1.65 s,
expiry at 2.15 s" among them. Use the unconditional `[LasecSimul][ESP32 reset]`
line and the harness counters instead. This is the quantification of the hazard
`PROJECT_CONSTITUTION.md` already listed qualitatively.

**H2 - `qemu_init` costs about 7 s per instance before any guest code runs.**
Measured, traces off: first stderr output at 0.4 s, `[ESP32 reset] count=1` at
5.0 s, `count=2` at 6.9 s, first guest-caused watchdog reset at 10.2-12.7 s.
Process spawn itself is 0.03 s, so this is machine construction, not image
loading. `-m 0` does not help.

This is a strong candidate explanation for the historical `ADMISSION_1`
timeouts (E015-E019, E039-E051): failure isolation admits sessions **serially**
with a fixed 120 s per-session deadline
(`VnextBProductionScaleTest.cpp:311-331`), and 16 x 7 s = 112 s of pure QEMU
construction sits inside that budget before any I2C submission can happen.
**Not yet proven** - see section 8.

## 7. Do not repeat

- Do not build an ESP-IDF or Arduino fixture to test watchdog *hardware*
  behaviour. The framework owns and feeds `TIMG_WDT`; that is what defeated
  E060-E063. Use `vnext_prototype/guest_mwdt_baremetal`.
- Do not resume the CPython 3.8/3.10 MSI assembly route. It is closed. See the
  postmortem in `CLOSED_HYPOTHESES.md`.
- Do not use the opt-in TG/VNEXT traces to measure time. See H1.
- Do not run more than a few concurrent QEMU instances unconstrained. The
  fixture guest never idles; an unconstrained 32-instance run froze this host
  and forced a power-off, which corrupted an in-flight build. See DECISION-010;
  the runners now cap priority and affinity for you.
- Do not `git checkout` a file in the QEMU worktree to undo an edit.
  `softmmu/vnext_b.c` is untracked and several tracked files carry
  pre-existing uncommitted work; reverting through git destroys it.
- Do not audit "hot-path diagnostic I/O" by grepping for one tag. E032/E033
  checked `[VNEXT_PROBE]` and closed the gate; the unconditional `[VNEXT_B]`
  writes in the generic publish path survived that audit for weeks (E102).
- Do not declare a scale run PASS without a validity arm proving the guests
  actually reached the condition under test. A first attempt here reported
  "0 MWDT resets at 16 sessions" that was pure startup starvation: the guests
  never booted inside the window. The negative control caught it.

## 8. What is still open

1. **Why a fed guest still takes MWDT resets at 12+ sessions.** The leading
   hypothesis is host CPU oversubscription (16 sessions x 2 vCPU threads on 26
   usable cores), not the transport. Testing it means fixed populations against
   varying core budgets. Note that raising `wdt_time_scale` past its cap of 100
   would be a watchdog semantic change, frozen by DECISION-004 - request review
   before touching it.
2. **`vnext_b_production_scale_test` never exits for more than one session**
   (E104). It hangs in `stopSimulation()` teardown at
   `VnextBProductionScaleTest.cpp:697`. Pre-existing - reproduced on the
   pre-patch binary. Measurements are unaffected because the measurement loop
   completes first; `run_production_mwdt.ps1` works around it.
3. **Three pre-existing Core test failures** (E106): `mcu_component_test`,
   `mcu_controller_real_qemu_test`, `qemu_icount_calibrator_test`. The Debug
   test binaries date from 2026-08-26..30 and are stale against the current
   headers; rebuilding them needs MSVC, which is not installed (only the MSYS2
   toolchain for QEMU was added).
4. **H2 root cause.** The ~7 s per-instance `qemu_init` cost (E100) is measured
   but not attributed, and its link to the historical `ADMISSION_1` timeouts is
   a hypothesis.
5. **High backpressure rate.** ~400 lane-credit-exhaustion events per second
   for a single session (E102); at N=8 there are none at all (E105). Whether
   that is normal credit-window cycling was not investigated.
6. Remaining unticked items in `FINAL_CHECKLIST.md`.
7. Intermittent `0xC0000409` / FATAL_APP_EXIT - unchanged, still unreproduced.

## 9. Where things are

| What | Path |
|---|---|
| MWDT fixture + runners | `vnext_prototype/guest_mwdt_baremetal/` |
| Fixture run logs | `vnext_prototype/guest_mwdt_baremetal/runs/` |
| Canonical QEMU runtime | `vnext_prototype/dev_qemu_runtime/qemu-system-xtensa.exe` |
| QEMU source | `C:\SourceCode\qemu_lasecSimul` (branch `main`, dirty) |
| Xtensa toolchain | `.piohome/packages/toolchain-xtensa-esp32/bin` |
| Production scale harness | `core/test/core/mcu/VnextBProductionScaleTest.cpp` |
| Watchdog device model | `qemu_lasecSimul/hw/timer/esp32_timg.c` |
| ELF boot path | `qemu_lasecSimul/hw/xtensa/esp32.c:1140-1172` |

`QEMU_RUNTIME.json` holds the canonical runtime hash and provenance.
