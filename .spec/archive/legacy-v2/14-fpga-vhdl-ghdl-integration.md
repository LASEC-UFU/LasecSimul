# 14 — FPGA / VHDL / GHDL Integration

**Status:** SPIKE / implementation may already be proceeding separately  
**Priority:** Independent external-domain track  
**Depends on:** existing Scheduler/MNA/external-process architecture

## 1. Goal

Allow a user to edit `.vhd`/`.vhdl` in VS Code, associate sources with a Generic FPGA component, compile/run with GHDL and connect VHDL ports to actual LasecSimul circuit pins.

## 2. Architecture

```text
FpgaComponent (normal IComponentModel)
      │
FpgaController
      │
GhdlBackend
      │
GhdlProcessManager + bridge
      │
GHDL + VPI
```

Mirror proven QEMU lifecycle/concurrency patterns where appropriate, without coupling FPGA ABI to QEMU ABI.

## 3. Hard invariants

- Scheduler remains in nanoseconds.
- Core remains global time authority.
- FPGA is a real circuit component with real electrical pins.
- Do not retrofit all Core digital devices with IEEE 1164 9-state logic.
- VHDL multi-valued logic stays local to FPGA boundary/diagnostics.
- GHDL process is Core-controlled.
- Webview does not run GHDL.

## 4. Spike 0 — mandatory before full infrastructure

Prove with a real supported GHDL build:

1. VPI plugin loads.
2. Top entity ports can be discovered reliably.
3. Core/bridge can drive a VHDL input.
4. Output change can be observed.
5. GHDL time can be controlled/synchronized.
6. delta-cycle behavior is understood.
7. 0/1/X/Z fidelity through the chosen VPI representation is measured.
8. shutdown/crash behavior is understood.

Do not build a large arena/cache abstraction before the critical time-control mechanism is empirically proven.

## 5. Preferred time protocol

Conceptually:

```text
Core → GHDL
ADVANCE_TO(targetTime)

GHDL processes events + all relevant delta cycles

GHDL → Core
OUTPUT_CHANGE(time, port, value)
TIME_REACHED(targetTime)
```

If VPI/GHDL constraints require a different proven mechanism, document it.

GHDL must not free-run arbitrarily ahead of the Core.

## 6. Delta cycles

At one physical timestamp, GHDL may execute multiple VHDL delta cycles.

Preferred external behavior for MVP:

- GHDL resolves its internal delta cycles;
- publish stable externally visible outputs for that physical time;
- do not create zero-width electrical pulses from internal delta-only transitions unless a future advanced mode explicitly needs them.

## 7. Logic/electrical mapping

Local enum may represent:

```text
U X 0 1 Z W L H -
```

Boundary mapping:

- `0` → electrical low driver;
- `1` → electrical high driver;
- `Z` → high impedance using existing electrical floating conventions;
- `X/U/W/-` → preserve for diagnostics/waveform and apply documented safe electrical boundary policy;
- `L/H` → weak/logic-low/high policy only after VPI fidelity is verified.

Analog circuit input to FPGA is thresholded using existing digital conventions/configuration.

## 8. Ports

Support:

- `std_logic`;
- `std_logic_vector`;
- explicit bit expansion (`data(7)` etc.) in MVP.

Preserve vector direction/index semantics.

Reuse generic subcircuit package/symbol generation for arbitrary entity ports.

## 9. GHDL configuration

VS Code setting:

```text
lasecsimul.fpga.ghdlPath
```

Resolution:
1. configured path;
2. PATH;
3. clear diagnostic.

## 10. Diagnostics

Parse compiler/analyzer/elaboration output to:

```text
file
line
column
severity
message
```

Feed existing `DiagnosticCollection("lasecsimul")`/Problems infrastructure.

## 11. Sources/persistence

Store:

- ordered VHDL source list;
- top entity;
- VHDL standard;
- generics later;
- discovered port metadata/mapping;
- relative project paths.

Do not stringify arrays/objects into scalar property fields if schema cannot represent them.

## 12. Bridge queue

Do not copy QEMU's queue depth blindly.

FPGA can change many outputs at the same timestamp. Define:

- capacity;
- overflow detection;
- backpressure or fatal/fault policy;
- counters/diagnostics;
- no silent event loss.

## 13. Tests

- combinational AND;
- D flip-flop;
- external LasecSimul Clock → counter;
- high-Z;
- delta cycles;
- timestamp ordering;
- two FPGA instances;
- FPGA + MCU shared timeline;
- invalid source diagnostics;
- missing GHDL;
- process crash/restart;
- save/reopen;
- packaging/palette.

## 14. Non-goals

- synthesis;
- place-and-route;
- bitstreams;
- OpenFPGA/Vivado/Quartus;
- Verilator in this MVP;
- global Core logic rewrite.
## Multiuser / SharedHost constraints

GHDL executable/toolchain MAY be shared read-only across users, but each `SimulationSession` MUST have a unique writable work directory.

Requirements:
- lazy start: no FPGA component means no GHDL process;
- no global `work-obj*.cf` shared between sessions;
- unique VPI/IPC endpoint per session;
- bounded queues and no busy polling;
- ResourceGovernor accounts for GHDL process cost;
- waveform files are session-local and bounded/disabled unless requested.

See specs `43`–`46`.
