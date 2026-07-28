# QEMU ESP32 source

The bundled `qemu-system-xtensa.exe` is built from:

- Repository: https://github.com/josuemoraisgh/qemu_lasecSimul
- Base commit: `3674866`
- Local release patch: [`patches/0001-esp32-realtime-wdt-and-interrupt-status.patch`](patches/0001-esp32-realtime-wdt-and-interrupt-status.patch)

Configure options and the executable checksum are recorded in
`bin/BUILD-PROVENANCE.txt`. The release build is produced from a clean worktree
and does not contain the diagnostic tracing used during the investigation.
