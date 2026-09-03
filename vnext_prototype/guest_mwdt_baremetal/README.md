# Bare-metal ESP32 MWDT fixture

Deterministic test vehicle for the `ESP32_MWDT_BEHAVIOR` and
`ESP32_MWDT_LOAD_INDEPENDENCE` gates. Evidence and rationale live in
`orchestrator/.ai/` (`QEMU_HANDOFF.md`, `EVIDENCE.md` E097-E101).

Test-only. Nothing here is linked into, or referenced by, production code.

## Why this exists

The gates ask whether the modeled Main Watchdog Timer resets a guest that stops
feeding it, and leaves alone a guest that keeps feeding, under the ~16-session
classroom load.

Every earlier attempt used an Arduino or ESP-IDF guest. Both frameworks own
`TIMG_WDT`: they program stage configuration and feed the watchdog from their
own tick hooks, so an "unfed" precondition could never be established
(`EVIDENCE.md` E060-E063). Here the fixture is the only writer of `TIMG_WDT` in
the whole guest, because there is no framework at all.

## What it needs

Only the repo-local Xtensa toolchain:

```text
.piohome/packages/toolchain-xtensa-esp32/bin/xtensa-esp32-elf-gcc.exe
```

No Python, no ESP-IDF, no PlatformIO runtime. A full build of all eight
variants takes about two seconds.

## How it boots

QEMU's ESP32 machine has an ELF loader path (`hw/xtensa/esp32.c:1140-1172`):
`-kernel <file.elf>` loads the segments and sets the architectural entry point
directly, with no ROM or second-stage bootloader involved. `esp32_soc_reset`
re-applies that entry point on every reset, so the fixture also restarts
cleanly after a watchdog reset.

Use `-M esp32-simul`, not `-M esp32`: the plain machine asks the SoC for
`serial0/1/2` chardev properties that this fork does not declare and aborts at
startup. With no shared-memory arena mapped, `simuliface` is inert, so the run
needs no Core and no session.

## Files

| File | Purpose |
|---|---|
| `mwdt.S` | The fixture. Assemble-time parameters select timer group, stage modes, timeouts, prescaler and feed behaviour |
| `link.ld` | Places `.text` in the ESP32 IRAM window at `0x40080000` |
| `build.ps1` | Builds every variant into `build/` |
| `run_fixture.ps1` | Runs one variant on the canonical QEMU and classifies the trace |
| `run_scale.ps1` | Runs N concurrent instances of one variant; the load-independence oracle |
| `runs/` | Captured run logs |

## Variants

Built for both `tg0` (TIMER_GROUP0, the main system watchdog, the one that
receives VNEXT transport-pause compensation) and `tg1` (MWDT1):

| Variant | Behaviour | Expected |
|---|---|---|
| `fed` | configure, then feed forever | no MWDT reset |
| `unfed` | configure, never feed | MWDT reset every stage-0 timeout |
| `fed_then_starve` | configure, feed 3000 times, then stop | survives the feed phase, then resets |
| `staged_unfed` | stage 0 INT at 500 ms, stage 1 SYSRESET at 1000 ms | interrupt then system reset |

`fed_then_starve` is the **validity arm**. It is identical to `fed` up to and
including the store that enables the watchdog, so a run in which it resets
proves that the shared configuration path armed the watchdog. Never report a
`fed` result of "zero resets" without it: see `EVIDENCE.md` E101 for a run where
zero meant "the guests never booted".

## Register programming

Offsets and fields from `qemu_lasecSimul/include/hw/timer/esp32_timg.h`. TG0 is
at `0x3ff5f000`, TG1 at `0x3ff60000`.

1. `WDTPROTECT` (`0x64`) = `0x50D83AA1`, and left there — `WDTFEED` is rejected
   while the block is protected.
2. `WDTCONFIG0` (`0x48`) = 0. This also clears `FLASHBOOT_MODE_EN`, which is set
   on TIMER_GROUP0 out of reset and otherwise keeps a 650 ms SYSRESET stage
   armed. Every variant does this to TG0 first, whichever group it then targets.
3. `WDTCONFIG1` (`0x4c`) `PRESCALE` = 40000. Against the 40 MHz APB clock that
   gives a 1 kHz tick, so stage timeouts are written directly in milliseconds.
4. `WDTCONFIG2/3` (`0x50`, `0x54`) = stage 0 and stage 1 timeouts.
5. `WDTCONFIG0` = `EN | STG0 | STG1 | LEVEL_INT`, written last so the first
   armed deadline uses the stage table above.

## Running

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1

# one variant, single instance
powershell -NoProfile -ExecutionPolicy Bypass -File .\run_fixture.ps1 `
    -Variant tg0_unfed -Seconds 40 -WdtScale 1 -Trace 0

# load independence: N concurrent instances
powershell -NoProfile -ExecutionPolicy Bypass -File .\run_scale.ps1 `
    -Variant tg0_fed -Sessions 16 -Seconds 180 -WdtScale 1
```

## Two things that will mislead you

**Keep `-Trace 0`.** With `LASECSIMUL_TG0_WDT_TRACE=1` each emitted diagnostic
line costs a median 2.2 s of host time. Because `QEMU_CLOCK_VIRTUAL` follows
wall time under MTTCG-realtime, a 1 s watchdog deadline then fires at 12.7 s of
virtual time and the reset yield drops by an order of magnitude. Reset
classification does not need the trace: the `[LasecSimul][ESP32 reset]` line is
unconditional and carries `cause0`, `cause1` and `source`. See E099.

**Allow for startup.** QEMU spends about 7 s constructing this machine before
the guest executes a single instruction, and more under concurrency. A window
that is too short produces silence that looks like a pass. See E100 and E101.

## Interpreting results

`cause0=7` is `ESP32_TG0WDT_SYS_RESET`; `cause0=8` is the TIMER_GROUP1
equivalent (`hw/xtensa/esp32.c:353`). `source=MWDT_SYS_STAGE` marks a stage
routed to system reset, `source=MWDT_CPU_STAGE` one routed to a CPU reset. The
two `source=OTHER` resets at the start of every run are the ordinary cold-boot
pair.
