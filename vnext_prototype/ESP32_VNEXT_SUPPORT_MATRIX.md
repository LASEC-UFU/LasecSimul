# ESP32/vNext-B support matrix

Source basis: `qemu_lasecSimul/hw/xtensa/esp32.c` device composition and the
corresponding QEMU peripheral sources.  “Migrated” means that externally
observable MMIO state uses the generic vNext-B MMIO/event path where required;
it does not mean that every peripheral is electrically modeled at transistor
level.

| Capability | Classification | QEMU source | Core counterpart / path | Current evidence |
|---|---|---|---|---|
| CPU0/CPU1, reset/startup, ROM/flash, ELF | ALREADY_MIGRATED_VNEXT | `hw/xtensa/esp32.c`, Xtensa target | `McuComponent`, QEMU process lifecycle | Real guest restart and lifecycle PASS |
| MMU/cache/memory map, interrupt matrix, cross-core IRQ | LOCAL_ONLY_NO_TRANSPORT_REQUIRED | `hw/xtensa/esp32.c`, `esp32_intc.c`, `esp32_dport.c`, cache sources | None; local QEMU state | Local CPU/device behavior |
| GPIO, IO-MUX, GPIO Matrix | ALREADY_MIGRATED_VNEXT | `hw/gpio/esp32_gpio.c`, `hw/misc/esp32_iomux.c` | `QemuModuleProxy`, generic MMIO events | P1-P7 and real guest PASS |
| UART0/1/2 TX/RX | ALREADY_MIGRATED_VNEXT | `hw/char/esp32_uart.c` | UART module and generic MMIO/C2A path | P8 and real guest PASS |
| I2C0/1 | ALREADY_MIGRATED_VNEXT | `hw/i2c/esp32_i2c.c` | I2C transfer handler, BATCH, Response/C2A | P9 and real guest PASS |
| SPI0/1/2 | LOCAL_ONLY_NO_TRANSPORT_REQUIRED | `hw/ssi/esp32_spi.c` | Local SPI module only for modeled electrical pins | No external SPI Core device in current contract |
| FRC timers / Timer Groups | LOCAL_ONLY_NO_TRANSPORT_REQUIRED | `hw/timer/esp32_frc_timer.c`, `esp32_timg.c` | Scheduler/IRQ only when exposed to Core | Hardware virtual-time timers; no transport polling |
| MWDT / reset sources / RTC control | LOCAL_ONLY_NO_TRANSPORT_REQUIRED | `hw/xtensa/esp32.c`, `hw/misc/esp32_rtc_cntl.c` | Lifecycle/reset ownership remains QEMU | Existing watchdog behavior preserved |
| LEDC / PWM | LOCAL_ONLY_NO_TRANSPORT_REQUIRED | `hw/misc/esp32_ledc.c` | GPIO/electrical routing module | P7 adapter/reference evidence |
| RMT | LOCAL_ONLY_NO_TRANSPORT_REQUIRED | `hw/ssi/esp32_rmt.c` | GPIO/electrical routing only | No independent Core transport endpoint |
| ADC / touch sensor model | ALREADY_MIGRATED_VNEXT | `hw/misc/esp32_sens.c` | Generic MMIO read/write to Core ADC module where connected | Adapter ADC tests PASS |
| DAC | NOT_IMPLEMENTED_IN_CURRENT_MODEL | No DAC device in ESP32 composition | None | Not in declared support contract |
| I2S0/1 | NOT_IMPLEMENTED_IN_CURRENT_MODEL | `esp32.c` maps unimplemented regions | None | Explicit unimplemented MMIO region |
| TWAI/CAN | NOT_IMPLEMENTED_IN_CURRENT_MODEL | No ESP32 TWAI device in composition | None | Out of current contract |
| SD/MMC | SUPPORTED_WITH_DOCUMENTED_LIMITATION | `hw/sd/dwc_sdmmc.c`, `esp32.c` | Local QEMU SD path; no Core electrical model | Device exists; external-card scope limited |
| DMA-like paths | NOT_IMPLEMENTED_IN_CURRENT_MODEL | No ESP32 DMA device in composition | None | No transport migration target |
| Wi-Fi/Bluetooth/PHY/RF | SUPPORTED_WITH_DOCUMENTED_LIMITATION | `hw/misc/esp32_wifi.c`, PHY/FE sources | No Core RF transport | Network/RF behavior outside current contract |
| RNG, AES, SHA, RSA, eFuse, flash encryption | LOCAL_ONLY_NO_TRANSPORT_REQUIRED | corresponding `hw/misc`/`hw/nvram` sources | Local QEMU state | No external electrical semantics |
| Framebuffer/RGB and unimplemented peripheral windows | SUPPORTED_WITH_DOCUMENTED_LIMITATION | `esp32.c`, RGB/unimp sources | No generic transport needed | Explicitly bounded model |

## Dependency decision

There is no current `NEEDS_VNEXT_MIGRATION` entry among the peripherals in the
declared support contract.  Existing legacy-looking `readReg`/`writeReg` calls
in ADC, GPIO, UART, LEDC, and I2C are routed by `simuliface.c` to the generic
vNext-B register/event path when vNext-B is active; they are not separate
device-specific wire protocols.  SPI/RMT/LEDC/timers are local unless an
external Core/electrical endpoint is explicitly added to the support contract.

The unsupported rows remain explicit `NOT_IMPLEMENTED_IN_CURRENT_MODEL` or
documented limitations; they are not silently claimed as migrated.
