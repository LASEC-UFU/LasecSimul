# EVIDENCE LOG

> Entries are newest-first. E097 onwards were produced by the 2026-09-03
> consolidation audit. **Read the warning in E099 before trusting any timing
> number in an older entry.**

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
