# E147-J / v0.0.31 handoff

## Production fix

The VNEXT-B mailbox carries at most 32 bytes, including the I2C address byte.
The ESP32 command-list path can request 32 payload bytes, which previously made
the continuation attempt 33 bytes, return `VNEXT_WOULD_BLOCK`, and leave the
guest command pending forever. The result was ROM-only boot and an uncommitted
SSD1306 frame.

The QEMU fix splits that exact case into an ordered 31-byte payload submission
without logical STOP and a final address-plus-byte submission with logical STOP.
The command is completed only after the final STOP; the ABI and mailbox limit
are unchanged. Temporary diagnostic prints were removed from the hot path.

## Validated identities

- Promoted QEMU: `920D6E4DE78825A776E8EA3E4A5E8E1A8DF3F43393E271DAA9BA934A165AA0BF`
- Rollback QEMU: `475C0FC956E43FFC0CB83CECE0DC384457A9E1F01D2C6A3F6C21C4665C7EB23D`
- Firmware merged.bin: `1DA8BF731830B2D2D9CE6EDBB0EA208636A1DB2A79497A8DB0CC98D72864C76A`
- Firmware ELF: `1697587B58F9DF862765ADABC2F5A2E74387863438D8A6DF775196A542C9D9B6`

## Gates

- QEMU deterministic tests: DPORT 27/27, EFUSE 18/18, TIMG pause 7/7,
  WDT scale 13/13, ring classification 9/9.
- VNEXT-B attachment: 33/33; restart stress: 15/15.
- Full Release regression: 14/14, pre- and post-promotion.
- B11 post-promotion N=1: PASS; N=8: PASS, 8/8 workloads.
- Packaged VSIX: 44/44 runtime hashes, QEMU version/machine, VNEXT-B handshake
  33/33, packaged Core startup, zero orphans.
- Bundled GHDL: real backend/cache/concurrency gate PASS.

## Release

Version `0.0.31`, commit `3f6450e3`, tag `v0.0.31`.
QEMU source commit `46aa4db` was pushed to `qemu_lasecSimul/main`.
The GitHub Package Installers workflow is the authoritative final packaging
step because local bootstrapper assembly requires .NET 10; the workstation has
only .NET 8. The workflow installs .NET 10 and GHDL itself.

## Important non-findings

- Do not re-enable the old 33-byte single-submit behavior.
- Do not widen the ABI mailbox beyond 32 bytes.
- Do not treat the benchmark's unlimited-rate mode as a real-time-speed claim.
- `SINGLE_REALTIME`, `ICOUNT`, LEGACY production, and N>8 capacity remain
  outside this release certificate.
- The previous loose E147 JSON/trace dumps were exploratory outputs, not gates;
  their conclusions are consolidated here and in `EVIDENCE.md`/`NEXT_ACTION.md`.
