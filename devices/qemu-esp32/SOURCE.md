# QEMU ESP32 source

The bundled `qemu-system-xtensa.exe` is built from:

- Repository: https://github.com/josuemoraisgh/qemu_lasecSimul
- Source baseline: `721ff59` (`fix(esp32): avoid per-byte I2C ACK stalls`)
- Reference patches incorporated in the bundled runtime:
  - [`patches/0001-esp32-realtime-wdt-and-interrupt-status.patch`](patches/0001-esp32-realtime-wdt-and-interrupt-status.patch)
  - [`patches/0002-esp32-i2c-electrical-start-timing.patch`](patches/0002-esp32-i2c-electrical-start-timing.patch)
  - [`patches/0003-esp32-i2c-address-ack-burst.patch`](patches/0003-esp32-i2c-address-ack-burst.patch)
  - [`patches/0004-esp32-i2c-cancel-stale-timer.patch`](patches/0004-esp32-i2c-cancel-stale-timer.patch)

Configure options and the executable checksum are recorded in
`bin/BUILD-PROVENANCE.txt`. The bundled build is produced from that source
baseline plus the listed patches.
