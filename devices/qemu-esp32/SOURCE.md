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

As of 2026-10-31 the packaged executable is built from `7ead728` plus patches 0011-0021, applied in
order on the uncommitted working tree of `qemu_lasecSimul-invalid-state` (the chain re-applied
reproduces that tree exactly; SHA-256 `AF7DAA07E6...`, see `bin/BUILD-PROVENANCE-1H.txt`). 0011-0015
are summarized in `orchestrator/.ai/QEMU_RUNTIME.json` (`promotion_note_v0104`). 0016:

- `softmmu/icount.c`, `accel/tcg/tcg-accel-ops-icount.c`, `accel/tcg/tcg-accel-ops-rr.c`,
  `softmmu/cpus.c`, `softmmu/vnext_b.c`: one virtual clock per vCPU. Single-threaded TCG runs the two
  cores in turn and stock icount charged both cores' instructions to the one clock, so with both
  busy each core ran at half speed (a loop: 75.8 ms on one core alone, 140-151 ms with the other
  busy; now 75.3 ms in both cases). Outside guest execution `QEMU_CLOCK_VIRTUAL` is the clock of the
  slowest vCPU that is not halted nor suspended by a device model (flash-cache wait, full lane, I2C
  reply); while both run, neither gets more than 10 us ahead; in lockstep
  a vCPU ahead of the other that needs a sync waits until the other reaches that instant.
- `hw/nvram/esp32_efuse.c`: a blank `CK8M_FREQ` reads 80 (RC_FAST in 100 kHz units, as modeled by
  `esp32_timg`). The boot ROM computes the crystal from it; with 0 it assumed 26 MHz and the boot
  banner left the UART0 pad at 177 kbaud instead of 115200.
- `softmmu/vnext_b.c`: a UART RX byte from the Core (C2A kind 2) goes to the UART it names.
- `hw/misc/esp32_ledc.c`, `hw/xtensa/esp32.c`: LEDC hardware fade (`DUTY_INC/NUM/CYCLE/SCALE`) with
  the `DUTY_CHNG_END` interrupt wired to the interrupt matrix; `DUTY_R` reads the duty in effect.
- `hw/i2c/esp32_i2c.c`: a STOP with no data list (the bus held after a transfer without STOP) goes to
  the Core as a STOP-only burst, so SDA/SCL return high as on the chip.

0017 (`hw/ssi/esp32_spi.c`, `include/hw/misc/esp32_flash_enc.h`): a USR command on HSPI/VSPI no
longer goes through the flash-encryption block (only the flash controllers SPI0/SPI1 do, as on the
chip), and the flash-encryption device is resolved once instead of walking the whole QOM tree
(`object_resolve_path_type`) on every command. In a byte-by-byte `SPI.transfer()` loop that lookup
was 44.8% of the vCPU thread.

0018 (`target/xtensa/helper.c`, `target/xtensa/cpu.c`, `target/xtensa/cpu.h`): RUNSTALL is a level on
the core's input, and releasing it now lets the core go on as it was -- running, or still in WAITI
until an interrupt. `xtensa_runstall()` halted the core with `CPU_INTERRUPT_HALT`; when the core did not
execute during the stall (the single-threaded RR loop never runs a halted core, and the ESP32 flash-cache
wait also holds it), that request was still pending at the release and halted it again, until an
interrupt above PS.INTLEVEL arrived: about a tick late, or forever with interrupts masked. The release
also ended a WAITI with no interrupt. The code came from upstream QEMU. Found by the rewritten
`cache_wait_e2e_real_qemu` (RUNSTALL scenario: 100 of 100 runs failed before, 100 of 100 passed after).

0019 (`softmmu/icount.c`): with per-vCPU clocks (0016) a vCPU that reached its quantum ahead of the
other is flagged as waiting for it, and that flag blocks the icount warp. Whether it still waits was
decided against `icount_global_ns`, which is recomputed only when a vCPU runs. A core flagged that way
that then executed WAITI kept the flag; when an interrupt woke it while the other core stayed halted,
the stale global clock still put it ahead, so both cores looked idle, the warp stayed blocked and
nothing ran again. Now a vCPU waits only while another vCPU on the timeline is behind it and can run,
decided from the vCPUs themselves; a vCPU halted with nothing to do waits for nobody. Seen as the class
sketch (II1P06) freezing right after boot, both cores in `esp_pm_impl_waiti`, in 15 of 104 sessions run
8 at a time on 0018 and 2 of 16 on 0017; 0 of 48 after the fix.

0020 (`softmmu/vnext_b.c`, `softmmu/icount.c`, `include/sysemu/cpu-timers.h`): the real-time
controller (`vnext_rt_step`) raises the instruction stretch only while the simulation loses pace,
never to recover lag already accrued, and only by what the instructions of vCPUs busy the whole window
(>= 90% of its virtual time executing, counted per vCPU by `icount_take_cpu_activity`) can give back.
When even no instruction time would not keep pace, it no longer raises the factor. Before, a 1 s boot
lag made it stretch an event-driven guest (95-99% in WAITI) to 54x, and a `Serial.print()` burst at
115200 got gaps of up to 290 ms of firmware time.

0021 (`hw/misc/esp32_dport.c`, `include/hw/misc/esp32_dport.h`, `hw/xtensa/esp32.c`,
`target/xtensa/helper.c`, `target/xtensa/cpu.h`): the flash/PSRAM cache windows stay mapped; turning
a core's cache off closes a gate, and that core's TLB fills for the window go to the region's
illegal-access trap, now at `0x10000000` (reserved on the ESP32), through the new
`xtensa_tlb_fill_paddr` hook. A gate change only flushes that core's TLB. Before, each change was
`memory_region_set_enabled()`, a rebuild of the whole memory map (~2 ms of host time), and ESP-IDF
toggles both caches around every flash operation. Each enable also invalidated the translated code of
the whole 4 MB window; the cache sync now rewrites, and invalidates code of, only the pages whose bytes
changed. NVS init at boot ran at 0.2-0.3 MIPS and left the simulation up to 1 s behind real time; the
peak is now 145-163 ms. The cache-wait semantics are unchanged (same trap handler); the E131 test
passes 100 of 100 with 4 at a time.

As of 2026-11-01 the packaged executable adds patch 0022 (chain 0011-0022 re-applied reproduces the
working tree exactly; SHA-256 `9D3DC29908...`, see `bin/BUILD-PROVENANCE-1H.txt`). It is the first
batch of the ESP32 peripheral-fidelity audit:

- Peripherals that were unmapped -- the first access raised LoadStorePIFAddrError (Guru Meditation) --
  now exist: PCNT (`hw/misc/esp32_pcnt.c`, irq 48), MCPWM0/1 (`hw/misc/esp32_mcpwm.c`, irq 39/40) and
  TWAI/CAN (`hw/misc/esp32_twai.c`, irq 45). The counting, the waveforms and the CAN protocol run in the
  Core's ESP32 adapter, at the pads; these models keep the registers, read the Core's state from the
  vNext-B snapshot (now 128 bytes: PCNT counts, MCPWM timer status, TWAI SR/TEC/REC) and take its events
  through C2A. TWAI keeps the 64-byte RX FIFO with a per-message overrun flag, the IR and the ALC/ECC
  arming, and `DPORT_PERIP_RST_EN.TWAI_RST` resets it (ESP-IDF pulses it at install and in its errata
  workarounds).
- `hw/ssi/esp32_spi.c`: HSPI/VSPI receive. MISO was never read: the bytes the Core samples now land in
  W0-W15 (half and full duplex, `USR_MISO_HIGHPART`, `RD_BYTE_ORDER`, `RD_BIT_ORDER`), and a W read waits
  for the bytes the wire has already finished. The SCK period is computed in ps (12.5 ns at 80 MHz
  rounded to 12 ns before, a 4% fast clock).
- `hw/misc/esp32_sens.c`: `analogRead()` returned 0 in VNEXT_B. SENS keeps its registers with their
  reset values, and MEAS1/MEAS2 return the inverse of ESP-IDF's line-fitting curve (Vref 1100 mV, the
  11 dB lookup table) for the pad voltage in the snapshot, at the configured width and attenuation.
- `hw/ssi/esp32_rmt.c`: RMT TX rewritten per channel (items read at their start, wrap with TX_THR,
  TX_END, continuous mode, carrier); the items go to the Core, which drives the pads. Before they went
  to an internal SSI device at a fixed 1250 ns per item and never reached a pin.
- `hw/xtensa/esp32_intc.c`: each CPU interrupt line is the OR of every source mapped to it.
- `hw/timer/esp32_timg.c`: the watchdog scale defaults to 1 (it was x100 in every session once the
  adapter stopped setting the execution mode); `LASECSIMUL_ESP32_WDT_SCALE` still overrides it.
- `hw/misc/esp32_rtc_cntl.c`, `hw/xtensa/esp32.c`, `hw/timer/esp32_frc_timer.c`: the SoC starts on the
  XTAL clock and the RTC reset restores it; every FRC timer gets the APB frequency (only the first did).
- No ESP32-specific build warnings remain (`softmmu/simuliface.c`, `softmmu/runstate.c`,
  `include/qemu/main-loop.h`, the UART/TIMG/INTC models).

Measured on `9D3DC29908`: the external-QEMU battery 28 of 28, one at a time, including the new
`mcu_spi_miso`, `mcu_adc`, `mcu_rmt`, `mcu_pcnt`, `mcu_mcpwm`, `mcu_twai` (five CAN frames bit-exact on
the wire; TEC stops at 128 with no ACK) and `mcu_twai_bus` (two ESP32s: ACK, replies, arbitration); the
class project II1P06 with 8 sessions at once, 8 of 8 at 1.000-1.019x real time with all 23 display lines.

As of 2026-11-02 the packaged executable adds patch 0023 (chain 0011-0023 re-applied reproduces the
working tree exactly; SHA-256 `512C581F5F...`, see `bin/BUILD-PROVENANCE-1H.txt`), the second batch of
the audit:

- `hw/ssi/esp32_spi.c`: HSPI/VSPI do the command, address, dummy and data phases (half and full duplex)
  with bit lengths, CPOL/CPHA in all four modes (the edges are the adapter's), the trans-done interrupt
  and lldesc DMA in and out (irq 52-54), from the chip's reset values (`SPI_CLOCK` 0x80003043,
  `SPI_USER` 0x80000040); the period comes from the APB at each transaction.
- `softmmu/vnext_b.c`: with an interrupt the Core models armed (snapshot byte 100) the soft writes hold
  the guest too, so an edge they produce reaches a capture at its instant.
- Resets with the chip's scope (`hw/xtensa/esp32.c`, `hw/misc/esp32_dport.c`): a digital reset also
  resets LEDC, PCNT, MCPWM, TWAI and SENS and tells the Core (0x3FF48FFC); a CPU reset (`esp_restart()`)
  resets only the CPUs; `DPORT_PERIP_RST_EN` resets each peripheral on both edges of its bit
  (`perip-rst` lines) and goes to the Core's adapter module at the register.
- `hw/char/esp32_uart.c`: each FIFO, CLKDIV and CONF0 store reaches the Core from the vCPU at its
  instant (a bottom half used to publish them later, and the guest saw the UART idle while the Core was
  still sending: a reset right after a flush cut the output). The TX side paces the same frames as the
  Core, with `ST_UTX_OUT`, `TXFIFO_CNT` without the byte in the shifter and a latched `TX_DONE` (it was
  inverted); CONF0 resets to 0x0800001C.
- `hw/nvram/esp32_efuse.c`: a read takes 10 us. It was a 100 ms placeholder, three of them per boot.
- Sleep (`hw/misc/esp32_rtc_cntl.c`, the new `hw/misc/esp32_rtcio.c`, `hw/timer/esp32_timg.c`,
  `hw/timer/esp32_frc_timer.c`, `hw/gpio/esp32_gpio.c`):
  - deep sleep wakes on the RTC timer, ext0 and ext1, as a DEEPSLEEP_RESET that keeps RTC memory and
    time; the RTC memory CRC engine the ROM polls exists; the timer-group watchdogs are off with the
    digital domain;
  - light sleep wakes on the timer, ext0 and GPIO; CCOUNT (with CCOMPARE), TIMG and FRC hold while the
    clocks are gated;
  - a change of the APB clock no longer recounts the timers' whole time at the new rate.
- `hw/xtensa/esp32.c`: the RTC FAST data view also reaches the APP CPU (ESP-IDF reads RTC_FAST_ATTR data
  in `esp_sleep_start()` from the core that sleeps).
- `softmmu/simuliface.c`: a legacy `writeReg()` inside `qemu_init()` (the power-on reset) publishes
  nothing instead of aborting on the uninitialized arena lock.
- Diagnostics, off by default: `LASECSIMUL_UART_TRACE`, `LASECSIMUL_RTC_TRACE`, `LASECSIMUL_PC_SAMPLE=N`.

Measured on `512C581F5F`: the external-QEMU battery 31 of 31, one at a time, including the new
`mcu_spi_modes`, `mcu_soc_reset` (CPU reset keeps PCNT and PWM; `periph_module_reset()` and the system
reset reset them), `mcu_deep_sleep` and `mcu_light_sleep`; `mcu_twai_bus` takes 13 s (it was about
150 s, most of it the eFuse waits); the class project II1P06 with 8 sessions at once, 8 of 8 at
0.993-1.014x real time with every LCD sample right.

As of 2026-11-02 the packaged executable adds patch 0024 (chain 0011-0024 re-applied reproduces the
working tree exactly; SHA-256 `8864A0CA40...`, see `bin/BUILD-PROVENANCE-1H.txt`), the third batch of
the audit. It ships with `mcu_abi` 3.5 (`get_pin_analog`) and the adapter's RtcIo and Soc modules.

- `hw/misc/esp32_sens.c`: the touch sensor. The measurement FSM (sleep, XPD, window) counts
  T * I * slope / (2 * (20 pF + C_ext) * dV), with I = 1.72 uA per slope step and dV from `TOUCH_CFG`.
  The Core measures C_ext on each pad's net and returns it through the snapshot before the window ends.
  Channels 8 and 9 are swapped as on the chip. The threshold interrupt and the deep-sleep touch wakeup
  (`hw/misc/esp32_rtc_cntl.c`) work too. Before, the count was a fixed ~1500 with noise.
- `hw/misc/esp32_rtcio.c`: `RTC_GPIO_OUT`, `RTC_GPIO_ENABLE` and the pad registers go to the Core, where a
  pad muxed to the RTC domain loses the digital output and the RTC GPIO drives it with the RUE/RDE pulls.
  The DACs come out on GPIO25/26 at 3.3 * D / 255 through 20 Ohm. The resync of every RTC IO register at a
  digital reset is gone (the adapter resets the digital domain itself and keeps the RTC one).
- `hw/char/esp32_uart.c`: the whole frame format (parity, 5-8 data bits, 1/1.5/2 stop bits,
  `RS485_CONF` DL0/DL1), paced with the Core's integer formula; the receive errors the Core sees on the
  wire latch `PARITY_ERR`, `FRM_ERR` and `BRK_DET` (C2A payload byte 2), a full FIFO `RXFIFO_OVF`; the
  TX break (`TXD_BRK`, `TX_BRK_NUM`, `TX_BRK_DONE`); `uart_write_bytes_with_break()` waited forever before.

Measured on `8864A0CA40`: the external-QEMU battery 34 of 34, one at a time, including the new
`mcu_touch` (bare pad 70, 100 pF 11, 470 pF 2; the deep-sleep touch wakeup), `mcu_dac` (codes
64/128/192 at 828/1656/2485 mV) and `mcu_uart_format` (seven formats timed to the frame length, the
three receive errors, the break, the inversion); the class project II1P06 with 8 sessions at once, 8 of 8
at 1.000-1.002x real time with all 23 display lines.

As of 2026-11-02 the packaged executable adds patch 0025 (chain 0011-0025 re-applied reproduces the
working tree exactly; SHA-256 `5B26C905C6...`, see `bin/BUILD-PROVENANCE-1H.txt`), the fourth batch of
the audit. It ships with the adapter's I2S DAC stream, I2S ADC sampler and I2C slave engine.

- The new `hw/misc/esp32_i2s.c`: I2S0/I2S1 (they were unimplemented stubs, and `i2s_write()`/`i2s_read()`
  waited forever for the DMA). The TRM's reset values; an exact rational entry period from PLL_F160M or the
  APLL; TX lldesc DMA through the 64-entry FIFO (`OUT_DONE`, `OUT_EOF` per `OUT_EOF_MODE`, `OUT_TOTAL_EOF`),
  RX DMA (`IN_DONE`, `IN_SUC_EOF` per `RXEOF_NUM`), the CPU FIFO mode; RX reads the DIN pin's level. The
  built-in DAC mode sends each sample to the Core with its instant; the built-in ADC mode converts the
  voltages the Core sampled at the sample instants.
- The new `hw/misc/esp32_apbctrl.c`: APB_CTRL with its registers (it was a stub; DATE keeps the ECO3
  marker), the SAR ADC digital controller among them.
- `hw/misc/esp32_ana.c`: the analog I2C host register of the APLL keeps its registers and reads the
  calibration as done (`use_apll` hung in `rtc_clk_apll_coeff_set()`); they set the APLL frequency.
- `hw/nvram/esp32_efuse.c`: without an eFuse image, the factory fuses of an ESP32-D0WD-V3 (rev1, rev2, the
  D0WD package). It read as revision 0, and ESP-IDF ran its rev-0 workarounds.
- `hw/i2c/esp32_i2c.c`: the slave mode (the bus is the Core's engine): `SLAVE_ADDR`, the FIFOs and
  thresholds, `TRANS_COMPLETE`, `STATUS.SLAVE_RW` and `SCL_MAIN_STATE_LAST`; `I2C_CTR` resets to 0x3.

Measured on `5B26C905C6`: the external-QEMU battery 38 of 38, one at a time, including the new `mcu_i2s`,
`mcu_i2s_dac`, `mcu_i2s_adc` and `mcu_i2c_slave` (two ESP32s); the class project II1P06 with 8 sessions at
once, 8 of 8 at 1.000x real time with all 23 display lines.

As of 2026-11-02 the packaged executable adds patch 0026 (chain 0011-0026 re-applied reproduces the
working tree exactly; SHA-256 `62193BC173...`, see `bin/BUILD-PROVENANCE-1H.txt`), the fifth batch of the
audit (item 13). It ships with the adapter's APB_CLK report.

- `hw/xtensa/esp32.c`, `hw/misc/esp32_apbctrl.c`: `APB_CTRL_SYSCLK_CONF.PRE_DIV_CNT` divides XTAL and
  RC_FAST (`setCpuFrequencyMhz(20)` and `(10)` stayed at 40 MHz); the APLL is a CPU source too. Each change of
  APB_CLK goes to the Core, whose LEDC, PCNT filter, MCPWM capture, TWAI, I2C and UARTs counted 80 MHz always.
- `hw/char/esp32_uart.c`: a UART on APB takes the new bit time at the change; the Core gets the raw divider
  and computes the same integer value.
- `hw/i2c/esp32_i2c.c`: the SCL period follows the APB; it is sent to the Core before it is stored (a replayed
  store never sent it again).

Measured on `62193BC173`: the external-QEMU battery 39 of 39 one at a time (with `esp32_adapter` reporting the
80 MHz APB before its LEDC checks, and one rerun of `mcu_scheduler_pacing_sync_real_qemu`), including the new
`mcu_cpu_freq`; the class project II1P06 with 8 sessions at once, third run 7 of 8 at 1.000x and one at
1.025x.

As of 2026-11-02 the packaged executable adds patch 0027 (chain 0011-0027 re-applied reproduces the
working tree modulo Windows CRLF conversion; SHA-256 `F59B3C15EE57...`, see `bin/BUILD-PROVENANCE-1H.txt`),
the RMT receiver (item 3b) of the ESP32 peripheral-fidelity audit:

- `hw/ssi/esp32_rmt.c`, `softmmu/vnext_b.c`: RMT RX configuration and incoming Core events update the RX RAM,
  write pointer, used count, status, and RX_END/ERR interrupt bits. `MEM_WR_RST` resets the pointer; `RX_EN` is
  CONF1 bit 1 and `MEM_WR_RST` bit 2, as in the TRM.
- The Core adapter applies the RMT filter in APB cycles and ends a receive after `IDLE_THRES`, with a hard
  wakeup at the event deadline. The ESP32 original has no carrier demodulation on RX or ping-pong mode (both
  are S2-and-later features); tick rounding has no counter-phase model.

Measured on `F59B3C15EE57`: the external-QEMU battery passed 40/40 tests one at a time, including `mcu_rmt_rx`;
three II1P06 class runs with 8 concurrent sessions all measured 1.000x-1.005x, with 22-23 correct LCD/PCD
lines per session.


As of 2026-11-02 the packaged executable adds patch 0028 (chain 0011-0028 re-applied modulo Windows CRLF conversion; SHA-256 `55D1F3461999...`, see `bin/BUILD-PROVENANCE-1H.txt`), light-sleep peripheral clock gating (item 6b):

- QEMU publishes Soc register `0x3FF48FF4` before stalling on light-sleep entry; bit 0 gates the digital clock and bit 1 reports RTC8M retention from `RTC_CNTL_CLK_CONF.CK8M_FORCE_PU`. Wake restores the Core clock first, retrying if the Core lane is full.
- The adapter freezes APB/REF_TICK LEDC, PCNT filtering/counting, MCPWM, RMT TX/RX, TWAI, UART, I2C and SPI; it shifts scheduled deadlines on wake. Low-speed LEDC timers sourced by RTC8M keep running only when the IDF retained RTC8M.
- Measured: the 50 ms `mcu_light_sleep_periph` firmware configured both LEDC sources and verified PCNT did not accumulate during sleep (at most two wake-boundary edges); it does not directly observe the RTC8M output during sleep.

Measured on `55D1F3461999`: the external-QEMU battery passed 41/41 tests one at a time, including both light-sleep tests; three II1P06 runs with 8 sessions each: A and C all 1.000x, B six 1.000x plus 0.995x and 1.022x, with 22-23 correct LCD/PCD lines per session.


As of 2026-11-02 the packaged executable adds patch 0029 (chain 0011-0029; SHA-256 `8C8502DBB27E13664CCD127DE9DBAD2F59313DE7EA312999656811EE760ECFD3`, see `bin/BUILD-PROVENANCE-1H.txt`), DAC cosine generator (item 8):

- QEMU forwards `SENS_SAR_DAC_CTRL1/2` writes to the adapter before storing guest state, preserving VNEXT_B replay ordering. The adapter models RTC8M `FSTEP`, per-channel CW selection, scale, DC offset, phase and the four bit-inversion modes, and routes the cosine output to DAC1/2.
- `mcu_dac_cw` configures both channels at 1 kHz with opposite phase, samples the outputs through ADC1 and checks amplitude and negative cross-correlation. It passed, as did `mcu_dac` and `mcu_i2s_dac`.
- Measured: external-QEMU battery 42/42 tests one at a time; three II1P06 runs with 8 sessions each ranged 0.993x-1.018x, with 22-23 correct LCD/PCD lines per session.
- DAC-specific current limiting remains unmodeled: the consulted ESP-IDF 4.4 guide/source and ESP32 datasheet do not specify a DAC current clamp.


Paired Core/adapter/device candidate validated with QEMU `8C8502DB` (same QEMU 0029 binary):

- Core item 17: peer lookahead is 10 us. `mcu_twai_bus` passed in 5 s vs 13 s recorded at the 1 us baseline; `mcu_i2c_slave` remained 152 s. Larger 100 us/1 ms experiments were rejected after repeatable TWAI bus errors.
- SPI item 1b: ABI 4.2+ slave byte exchange returns MISO to the ESP32; the topology pair includes the MISO node. The mode is allowed only when clock/MOSI/MISO are otherwise unobserved and no `logic.shift_reg` q0-q7 output is instrumented; otherwise it falls back to bit edges. `mcu_spi_miso` produced 54,528 correct bytes in 8,010 ms wall (2,859 ms simulated) in byte mode, versus 10,560 correct bytes in 8,003 ms (571 ms simulated) forced bit-by-bit, approximately 5x faster.
- Final battery remained 42/42 PASS. Final II1P06 class runs with 8 sessions each: A 0.999x-1.000x, B 1.000x, C 0.973x-1.003x; 22-23 correct LCD/PCD lines per session.
