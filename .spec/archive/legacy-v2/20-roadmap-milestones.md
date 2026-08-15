# 20 — Incremental Roadmap and Milestones

**Status:** PLANNED  
**Purpose:** implementation sequence, not calendar commitment

## Guiding rule

Each milestone must produce a small, demonstrable capability. Do not open five foundational refactors in parallel.

## Phase 0 — Baseline and architecture guards

Deliverables:
- document current Core/Extension lifecycle;
- baseline tests green;
- identify exact persistence extension points;
- establish spec/status discipline;
- no feature code required.

Gate:
- existing electrical + MCU projects validated.

## Phase 1 — Signal Engine Slice

Implement:
- signal ports/lines;
- Constant;
- Step;
- Gain;
- Sum;
- Display;
- scheduler integration;
- persistence.

Demo:
```text
Step → Gain → Display
```

Gate:
- signal-only project runs headlessly.

## Phase 2 — Scope + basic continuous dynamics

Implement:
- Scope telemetry batching;
- Integrator;
- state-space foundation;
- Transfer Function;
- fixed-step solver.

Demo:
```text
Step → 1/(5s+1) → Scope
```

## Phase 3 — Discrete/sample-time foundation

Implement:
- SampleTime;
- Unit Delay;
- ZOH;
- discrete integrator;
- multirate Scheduler events.

Demo:
continuous plant + sampled controller stub.

## Phase 4 — Electrical ↔ signal bridge

Implement:
- Voltage Sensor;
- Current Sensor;
- Controlled Voltage Source;
- Controlled Current Source.

Demo:
```text
Sine → Controlled V Source → RC → Voltage Sensor → Scope
```

This is the major “one canvas” proof.

## Phase 5 — Process library MVP

Implement:
- First Order;
- FOPDT;
- Tank;
- Valve;
- Saturation/Rate Limiter/Noise as required.

Demo:
closed-loop tank level simulation.

## Phase 6 — Hybrid Subsystem foundation

Implement:
- signal ports in subsystem;
- mixed internal topology;
- stable external symbol generation;
- exported parameters.

Demo:
pack process/controller/bridge into one reusable subsystem.

## Phase 7 — HART semantic MVP

Implement:
- HART variable/device engine;
- Smart Transmitter;
- 4–20 mA analog mapping;
- semantic communicator;
- core universal/common commands needed for demo.

Demo:
Tank level → HART transmitter → loop + communicator.

## Phase 8 — Modbus semantic MVP

Implement:
- data model;
- server;
- FC01/02/03/04/05/06/15/16;
- client/scanner;
- bindings;
- trace.

Demo:
Tank level in Input Register; scanner reads; Holding Register changes SP.

## Phase 9 — PLC Runtime before editor

Implement:
- Generic PLC;
- scan cycle;
- input/output images;
- IR;
- digital I/O;
- TON/CTU;
- program fixture loaded without Ladder editor.

Demo:
I0 AND NOT I1 → Q0 with scan time.

## Phase 10 — Ladder Editor

Implement:
- contact/coil/branch/TON;
- compile to shared IR;
- online monitoring;
- diagnostics.

Demo:
PLC controls a process actuator.

## Parallel Track — FPGA/VHDL

Proceed independently after GHDL/VPI Spike 0, respecting shared Scheduler and MNA contracts.

Integrate with roadmap demos after stable.

## Phase 11 — PLC + Modbus integration

- PLC Modbus client/server service;
- scan/communication scheduling;
- register ↔ PLC variable bindings.

Demo:
PLC polls virtual VFD/process over Modbus.

## Phase 12 — Detailed physical industrial communications

Possible order:
1. semantic RTU framing;
2. UART model;
3. RS-485 transceiver/network;
4. physical Modbus RTU;
5. HART modem/FSK physical mode.

Do not implement physical fidelity before semantic protocol behavior is correct.

## Phase 13 — More IEC languages

- Structured Text;
- FBD;
- SFC;
- common IR/runtime;
- PLCopen interchange research.

## Phase 14 — Ecosystem / FMU

- FMI feasibility spike;
- FMU co-simulation import;
- external model synchronization.

## Dependencies summary

```text
Signal Engine
   ├── Continuous/Discrete
   ├── Process
   ├── Electrical Bridges
   │      └── Smart Instruments
   │             └── HART
   └── PLC I/O foundation
          └── PLC runtime
                 └── Ladder

Bindings
   ├── HART variables
   └── Modbus register map

Scheduler
   ├── all signal timing
   ├── PLC scans
   ├── protocol timing
   ├── QEMU
   └── GHDL
```

## Release discipline

Each phase:
- investigation/map existing code;
- spike only if technical risk warrants;
- production implementation;
- tests;
- example;
- docs;
- packaging;
- update `STATUS.md`.

No phase is required to wait for every later UI enhancement.
## Cross-cutting track — Performance and SharedHost

This track runs alongside feature milestones.

### P0 — Baseline
- headless benchmark harness;
- thread/process/memory counters;
- idle CPU measurement.

### P1 — Resource policy
- bounded worker pool;
- `ResourceGovernor`;
- Desktop/SharedHost profiles;
- no component-owned unbounded threads.

### P2 — UI/data efficiency
- Scope ring buffers/decimation;
- telemetry batching;
- process-visual FPS budgets.

### P3 — Shared runtime
- `RuntimeResolver`;
- user vs machine/shared runtime;
- unique session workdirs;
- lab self-test.

### P4 — Virtual networking
- session virtual network;
- semantic Modbus TCP default;
- explicit host bridge.

### P5 — Capacity validation
- multi-session lab benchmark;
- publish tested capacity report for target hosts.

### P6 — Future remote seam
- isolate current local IPC behind `SimulationBackend`;
- do not implement remote server yet.

See specs `43`–`48`.

## Deployment invariant

No milestone may introduce a feature that only works because Desktop and SharedHost use separate simulation engines.

A `.lsproj` must remain portable between profiles.
