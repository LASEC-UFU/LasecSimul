# QEMU ESP32 source

The bundled `qemu-system-xtensa.exe` is built from:

- Repository: https://github.com/josuemoraisgh/qemu_lasecSimul
- Source commit: `448559e` (`fix(esp32): stabilize interrupt watchdog and I2C timing`)
- Reference patches incorporated in that commit:
  - [`patches/0001-esp32-realtime-wdt-and-interrupt-status.patch`](patches/0001-esp32-realtime-wdt-and-interrupt-status.patch)
  - [`patches/0002-esp32-i2c-electrical-start-timing.patch`](patches/0002-esp32-i2c-electrical-start-timing.patch)

Configure options and the executable checksum are recorded in
`bin/BUILD-PROVENANCE.txt`. The release build is produced from that clean commit
and does not contain the diagnostic tracing used during the investigation.
