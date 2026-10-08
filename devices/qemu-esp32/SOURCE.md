# QEMU ESP32 source

The bundled `qemu-system-xtensa.exe` is built from:

- Repository: https://github.com/josuemoraisgh/qemu_lasecSimul
- Source baseline: `721ff59` (`fix(esp32): avoid per-byte I2C ACK stalls`)
- Reference patches incorporated in the bundled runtime:
  - [`patches/0001-esp32-realtime-wdt-and-interrupt-status.patch`](patches/0001-esp32-realtime-wdt-and-interrupt-status.patch)
  - [`patches/0002-esp32-i2c-electrical-start-timing.patch`](patches/0002-esp32-i2c-electrical-start-timing.patch)
  - [`patches/0003-esp32-i2c-address-ack-burst.patch`](patches/0003-esp32-i2c-address-ack-burst.patch)
  - [`patches/0004-esp32-i2c-cancel-stale-timer.patch`](patches/0004-esp32-i2c-cancel-stale-timer.patch)
  - [`patches/0006-esp32-bql-free-idle-wait-and-locked-heartbeat-rearm.patch`](patches/0006-esp32-bql-free-idle-wait-and-locked-heartbeat-rearm.patch)
    (2026-09-29, commit `cdbc8ee` do fork, sobre `b211e01`)
  - [`patches/0007-esp32-read-doorbell.patch`](patches/0007-esp32-read-doorbell.patch) (`b2f487d`)
  - [`patches/0008-esp32-timg-lockless-counter-reads.patch`](patches/0008-esp32-timg-lockless-counter-reads.patch) (`9f36ff0`)
  - [`patches/0009-esp32-i2c-stop-mirror-only-after-electrical-transaction.patch`](patches/0009-esp32-i2c-stop-mirror-only-after-electrical-transaction.patch)
    (`2f244a3`)
  - [`patches/0010-vnext-i2c-submit-wait-pause.patch`](patches/0010-vnext-i2c-submit-wait-pause.patch)
    (`7ead728`)
  - [`patches/0011-vnext-precise-idle-and-i2c-wire-time.patch`](patches/0011-vnext-precise-idle-and-i2c-wire-time.patch)
    (2026-10-07, sobre `7ead728`): o laço principal do vNext-B usa a mesma espera ociosa precisa
    do transporte legado (antes cada timer sub-ms esperava ~1 ms do Windows), dormindo num timer
    de alta resolução e girando só os últimos 300 us; e a duração de uma rajada I2C conta bytes
    (9 períodos por byte), como o mailbox legado. SSD1306 a 400 kHz: 18 -> 27,6 px/s de rolagem
    (real ~29), QEMU 0,44 -> 0,81 núcleo.

The realtime MTTCG build disables only Timer Group 1's interrupt watchdog by default because it
otherwise measures host wall-time stalls instead of equivalent ESP32 progress. Timer Group 0 and
ordinary timers remain active. Deterministic mode retains literal timing; setting
`LASECSIMUL_ESP32_WDT_SCALE=1` explicitly also re-enables Timer Group 1 for realtime diagnostics.

Configure options and the executable checksum are recorded in
`bin/BUILD-PROVENANCE.txt`. The bundled build is produced from that source
baseline plus the listed patches.

As of 2026-08-26 the bundled build also includes two commits from the `qemu_lasecSimul` `main`
branch (not yet distilled into a numbered patch against the `721ff59` baseline -- see
`bin/BUILD-PROVENANCE.txt` for the exact hashes):

- `debug(xtensa,esp32): add temporary cache/PC-sampler trace instrumentation` -- diagnostic-only,
  writes trace files to `c:/tmp/`, explicitly marked for eventual removal (see the code comments and
  `.spec` 32.5.7-32.5.19 on that branch).
- `fix(esp32): stabilize interrupt watchdog and skip redundant I2C ACK reads` -- the WDT fix above,
  plus an I2C hardware-model optimization that only samples the real electrical ACK for the address
  byte after a (repeated-)START, assuming ACK for subsequent burst bytes. This reduces
  Core-round-trips-per-byte but does **not** close the throughput gap for bit-accurate 400kHz I2C
  under MTTCG -- see [`docs/39-i2c-mttcg-throughput-ceiling-2026-08-26.md`](../../docs/39-i2c-mttcg-throughput-ceiling-2026-08-26.md)
  for the full architecture writeup, what was measured, and what a real fix needs to do.

The current packaged executable additionally uses arena ABI v5 and the I2C burst mailbox implemented
in the QEMU fork at `b211e01`. It collapses a supported ESP-IDF transaction into
one Core round-trip while preserving virtual bus time, ACK/NACK status, FIFO order, clock stretching,
and electrical fallback for command lists or topologies that cannot be represented safely. The exact
source commit and executable checksum are recorded in `bin/BUILD-PROVENANCE-1H.txt`. That commit
also ends a hardware STOP command without replaying stale command registers, and retains the final
byte of a split 32-byte FIFO write until a second mailbox request completes it.

As of 2026-09-29 the packaged executable is built from `qemu_lasecSimul` commit
`cdbc8ee50a190bcbdfb7b2ba32843c05afbe32c5` (`b211e01` plus patch 0006; SHA-256 `6036D022...`, see
`bin/BUILD-PROVENANCE-1H.txt`):

- `util/main-loop.c`: the Windows precision loop of `main_loop_timeout()` waits for the next timer
  deadline without holding the BQL (zero-timeout polls of the same handles, plus an arena hook for a
  Core IRQ request or stop). The Xtensa TCG takes the BQL on every interrupt-level change
  (`HELPER(check_interrupts)`) and in `waiti`, so every FreeRTOS critical section used to compete
  with the spinning main loop. Rollback: `LASECSIMUL_QEMU_BQL_FREE_IDLE=0`.
- `util/qemu-timer.c`: `timer_reload_ns()` inserts under `active_timers_lock`. Without it the
  LasecSimul heartbeat was dropped by a race with vCPUs arming timers on the same list, a few
  seconds after boot, in part of the runs.

As of 2026-09-29 (second update) the packaged executable is built from `qemu_lasecSimul` commit
`2f244a3da6bbe4990da9d1328c94430a2a92bb55` (`cdbc8ee` plus patches 0007-0009; SHA-256
`0AD7016B...`, see `bin/BUILD-PROVENANCE-1H.txt`):

- `softmmu/simuliface.c` (0007): `readReg()` rings the Core's poll doorbell after publishing
  `SIM_READ`. The Core's poll thread only saw a read at the end of its 5 ms bounded wait, so every
  GPIO_IN read took ~5 ms with the vCPU (and the BQL) held.
- `hw/timer/esp32_timg.c`, `accel/tcg/cputlb.c`, `include/exec/memory.h` (0008): Timer Group
  counter latches and LO/HI reads run without the BQL (backport of upstream
  `memory_region_enable_lockless_io`, with a per-timer latch mutex; the register file is mapped as
  a full 4 KiB page so it does not go through `subpage_read`). `esp_timer_get_time()`/`millis()`
  loops no longer starve the main loop and the other vCPU.
- `hw/i2c/esp32_i2c.c` (0009): STOP is mirrored to the Core's electrical I2C engine only when the
  transaction opened the electrical bus (RSTART/WRITE/READ mirrored). A burst-delivered
  transaction used to end with an empty electrical START+STOP that re-solved the MCU circuit twice
  per transaction; the STOP bus time is still charged.

As of 2026-09-30 the packaged executable is built from `qemu_lasecSimul` commit
`7ead728b3d6393c63ec414915a1962aa173232ee` (SHA-256 `B77C1D0F...`). The VNEXT_B I2C
submitter pauses its vCPU while the Core computes the response. The host round trip therefore
does not consume guest driver time; the I2C peripheral's own timer still applies the simulated
wire duration after the response. The pause is armed before the request becomes visible to the
Core, preventing a response from racing ahead of the stop. A 180-second run of the supplied
`display.lsproj` and `merged.bin` had zero `ESP_ERR_INVALID_STATE` messages and display updates
through the end of the run. The previous packaged executable had four such errors in 70 seconds
with the same fixture.
