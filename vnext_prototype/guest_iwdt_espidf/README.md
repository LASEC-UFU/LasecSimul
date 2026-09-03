# Pure ESP-IDF IWDT conformance fixture

Phase-0 contract for the locally installed PlatformIO ESP-IDF package.

- ESP-IDF package: `3.40407.240606` (ESP-IDF 4.4.7)
- Watchdog: official `components/esp_system/int_wdt.c`, `WDT_MWDT1` / TG1
- Required effective configuration: `CONFIG_ESP_INT_WDT=y`,
  `CONFIG_ESP_INT_WDT_CHECK_CPU1=y`, timeout `300 ms`
- `IWDT_TEST_MODE=0`: both cores remain schedulable for 3 timeout windows;
  repeated official feeds and no reset/expiry are required.
- `IWDT_TEST_MODE=1`: after at least two feed cycles, a highest-priority task
  pinned to CPU1 emits `IWDT_INJECT_CPU1_STARVE` and prevents CPU1's tick from
  running while CPU0 remains schedulable. The expected official sequence is
  CPU1 liveness loss, stage-0 interrupt/panic attribution to CPU1, then stage-1
  system-reset fallback if panic cannot complete.

The fixture must not write TG1 registers. In particular, a CPU1-only hardware
reset is not an expected oracle for official IWDT behavior.

This project intentionally contains no Arduino, Core, VNEXT_B, I2C, session,
queue, or transport code.
