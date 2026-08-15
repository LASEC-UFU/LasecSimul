# 19 — Testing and Regression Strategy

**Status:** PLANNED  
**Priority:** Mandatory for every milestone

## 1. Principle

Every new domain increases cross-domain failure modes. Tests are part of architecture, not post-implementation cleanup.

## 2. Test layers

### Unit
Pure parsers, models, codecs, mathematical blocks.

### Core integration
Scheduler + domain engine + component.

### Cross-domain
Signal↔electrical, PLC↔process, protocol↔binding, FPGA↔electrical.

### Persistence
Load/save/reload golden projects.

### External runtime
Real GHDL/QEMU where installed; clean skip where intentionally optional.

### Extension
DTO, diagnostics, catalog, editors, IPC.

### Manual GUI smoke
Only for behavior impossible to validate headlessly.

## 3. Required regression baseline

Before each major milestone capture/pass existing:

- Core tests;
- Scheduler tests;
- MNA tests;
- component/device tests;
- subcircuit tests;
- MCU/QEMU tests;
- extension tests;
- packaging checks.

Do not “fix” regressions by weakening unrelated tests.

## 4. Virtual-time tests

Must test:

- pause;
- resume;
- exact event timestamp;
- same-time ordering;
- step simulation;
- accelerated virtual time;
- reset;
- component deletion with pending event.

No tests should rely on `sleep()` for simulated behavior. Sleeps may be used only for real process/network orchestration with generous deterministic bounds.

## 5. Golden numerical tests

Control/process:
- analytical first-order;
- integrator;
- state space;
- PID simple loop;
- tank mass balance.

Tolerance and solver settings must be explicit.

## 6. Protocol golden tests

HART:
- known frame parse/build;
- checksum;
- addressing;
- command payload.

Modbus:
- CRC known vectors;
- MBAP/PDU;
- function codes;
- exceptions;
- endianness/scaling.

Use authoritative vectors when license permits redistribution, otherwise derived fixtures with clear provenance.

## 7. PLC tests

- scan image semantics;
- timers;
- counters;
- Ladder→IR;
- same program result across language frontends later;
- electrical I/O thresholds.

## 8. FPGA tests

- real GHDL optional integration;
- synthetic bridge tests always;
- process crash;
- delta-cycle timing;
- multi-instance.

## 9. Stress

Candidate tests:

- 1,000 signal blocks;
- 10,000 register entries (data structure performance);
- 100 PLC scans with many I/O;
- many scheduled events;
- stop/restart loops;
- rapid component add/remove while stopped;
- two external processes.

## 10. Fuzz/robustness

Good candidates:

- Modbus frame decoder;
- HART frame decoder;
- project schema parser;
- PLC source parser later.

At minimum property-based/random malformed inputs should prove no crashes/out-of-bounds.

## 11. Persistence matrix

Keep fixtures for:
- prior schema versions;
- electrical-only;
- signal-only;
- hybrid;
- HART;
- Modbus;
- PLC;
- FPGA.

## 12. CI policy

Real external tools:
- fast synthetic tests always;
- optional real GHDL/QEMU test job when toolchain is available;
- never silently pass because executable is missing unless test explicitly reports `SKIPPED: missing tool`.

## 13. Manual acceptance checklist

For each user-facing milestone:

- palette entry;
- drag/drop;
- configure;
- connect;
- run;
- pause;
- stop;
- save;
- close;
- reopen;
- rerun;
- intentionally break configuration;
- verify diagnostic.

## 14. Definition of failure

A feature is not acceptable if:
- it only works after editor refresh;
- stop leaks a process/thread;
- save/reopen loses mapping;
- UI display is correct but Core state differs;
- accelerated simulation changes logical result unexpectedly.
