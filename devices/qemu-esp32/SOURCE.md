# QEMU ESP32 source

The bundled `qemu-system-xtensa.exe` is built from:

- Repository: https://github.com/josuemoraisgh/qemu_lasecSimul
- Source baseline: `721ff59` (`fix(esp32): avoid per-byte I2C ACK stalls`)
- Reference patches incorporated in the bundled runtime:
  - [`patches/0001-esp32-realtime-wdt-and-interrupt-status.patch`](patches/0001-esp32-realtime-wdt-and-interrupt-status.patch)
  - [`patches/0002-esp32-i2c-electrical-start-timing.patch`](patches/0002-esp32-i2c-electrical-start-timing.patch)
  - [`patches/0003-esp32-i2c-address-ack-burst.patch`](patches/0003-esp32-i2c-address-ack-burst.patch)
  - [`patches/0004-esp32-i2c-cancel-stale-timer.patch`](patches/0004-esp32-i2c-cancel-stale-timer.patch)

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
