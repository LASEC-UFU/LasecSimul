# 00 — Vision and Target Architecture

**Status:** PLANNED  
**Priority:** Foundation  
**Depends on:** current LasecSimul architecture only  
**Blocks:** most later specs

## 1. Goal

Evolve LasecSimul into a **unified engineering simulation canvas** where electrical networks, block-diagram control logic, process dynamics, industrial instruments, PLCs, MCU firmware and HDL models can coexist in one project while preserving domain-correct simulation semantics.

The desired experience is:

```text
Step → PID → DAC → electrical driver → actuator → process
  ↑                                             │
  └──── PLC / MCU / FPGA / HART / Modbus ◄─────┘
```

The visual diagram is unified. The numerical semantics are not.

## 2. Existing foundations that must remain authoritative

The implementation must begin by inspecting and reusing the real repository. The currently known architecture includes:

- VS Code Extension / Webview in TypeScript;
- native Core in C++20;
- `SimulationSession`;
- `Netlist`;
- MNA solver;
- `Scheduler` using a nanosecond virtual timeline;
- component instances implementing the existing component model contract;
- plugin/device manifests;
- Extension ↔ Core newline-delimited JSON IPC over local OS transport;
- MCU/QEMU integration via `McuComponent`, controller, process manager and arena bridge;
- subcircuit/project persistence;
- generic subcircuit symbol/package generation.

If repository names or locations have changed, the implementation must adapt to current reality rather than force these historical names.

## 3. Target domain model

```text
                            SimulationSession
                                  │
                           Global Scheduler
                         (virtual time, ns)
                                  │
        ┌─────────────────────────┼────────────────────────┐
        │                         │                        │
        ▼                         ▼                        ▼
 Electrical Domain          Signal Domain           External Domains
     MNA                    continuous /           MCU(QEMU), FPGA(GHDL)
 analog + electrical        discrete / event
 digital behavior                 │
        │                         ▼
        │                   Process Models
        │
        ├───────── explicit domain adapters ───────────────┐
        │                                                  │
        ▼                                                  ▼
 Instrumentation / I/O                                 Protocols / PLC
```

### 3.1 Electrical domain

Owns physical electrical nodes and MNA behavior:

- voltage;
- current;
- impedance/conductance;
- KCL/KVL;
- electrical sources;
- transistor/op-amp/passive models;
- physical digital I/O behavior represented electrically.

No global rewrite of the existing electrical kernel is allowed merely to support signal blocks.

### 3.2 Signal domain

Owns directed value propagation:

- scalar and typed signals;
- combinational blocks;
- continuous states;
- discrete states;
- sample times;
- event-driven blocks;
- control algorithms;
- process models.

It must not require MNA nodes for a pure signal-only model.

### 3.3 Process domain

Built primarily on the signal/state engine rather than as a separate unrelated scheduler. It adds domain-specific models and engineering semantics:

- first-order/FOPDT;
- tanks;
- valves;
- pumps;
- pipes;
- heat/process blocks;
- disturbances;
- physical units and limits.

### 3.4 External simulation domains

Examples:

- QEMU MCU;
- GHDL FPGA/VHDL;
- future FMU/FMI.

These domains must be synchronized with LasecSimul virtual time and must never free-run in a way that violates causality.

### 3.5 PLC domain

A deterministic scan-based runtime synchronized by the Scheduler:

- input image;
- program execution;
- output image;
- timers/counters;
- communication service;
- later IEC language editors compiling to a shared IR.

### 3.6 Protocol / instrumentation domain

Reusable protocol engines and smart devices:

- HART;
- Modbus;
- later CAN/CANopen/etc.

Protocol state and physical transport are separate concerns so semantic simulation can exist before detailed physical transceiver simulation.

## 4. One canvas, multiple connection semantics

The editor must eventually recognize at least:

1. **Electrical wire** — physical, bidirectional, electrical node connection.
2. **Signal line** — directed typed data connection.
3. **Protocol/network link** — optional later semantic connection type for buses/networks.
4. **Visual grouping/subsystem boundary** — not itself a simulation connection.

Do not overload one wire type with hidden behavior.

## 5. Explicit bridges

Examples:

```text
Electrical → Voltage Sensor → Real signal
Real signal → Controlled Voltage Source → Electrical

Electrical 4–20 mA → PLC AI → PLC REAL/INT
PLC AO → current-output interface → Electrical

Process PV → HART Transmitter → electrical loop + HART data
```

Adapters are essential because they make domain changes visible, debuggable and teachable.

## 6. Scheduler authority

The existing Scheduler remains the global time authority. The architectural contract is:

- all scheduled simulation events have a virtual timestamp;
- continuous numerical integration is advanced only over permitted intervals;
- discrete sample hits are Scheduler events;
- PLC scans are Scheduler events;
- protocol timeouts and RTU frame gaps use virtual time;
- GHDL/QEMU synchronization uses virtual time;
- Webview repaint cadence is never simulation cadence.

The initial global unit remains **nanoseconds**. Individual external protocols may use finer internal timestamps, but conversion must happen at boundaries with an explicit rounding policy.

## 7. Execution phases

A future stable step may conceptually require:

1. apply due external/domain events;
2. sample/update discrete input interfaces;
3. evaluate signal graph segments that are due;
4. advance continuous state as required;
5. settle electrical MNA;
6. propagate electrical threshold/sensor changes;
7. repeat local settle until stable or iteration limit;
8. publish observation/diagnostic updates.

The exact ordering must be derived from current Scheduler behavior through a dedicated implementation investigation. This spec defines requirements, not permission to replace the existing settle loop.

## 8. Major architectural risks

### 8.1 Circular cross-domain dependencies

Example:

```text
electrical voltage → sensor → PID → controlled source → same electrical network
```

This is an algebraic loop spanning domains. MVP behavior must detect unsupported zero-delay loops and report them rather than silently oscillating or relying on arbitrary evaluation order.

### 8.2 Hidden wall-clock behavior

Any process block, timer, protocol timeout or PLC TON driven by OS time will make accelerated/paused simulation incorrect.

### 8.3 Premature universal abstraction

A generic “everything is a node and solver” architecture is specifically out of scope. Preserve pragmatic domain-specific engines with small explicit interfaces.

### 8.4 Persistence drift

New domain data must be versioned. Existing `.lsproj` and `.lssubcircuit` projects must continue loading.

## 9. Acceptance criteria

Architecture foundation is accepted when:

- a pure electrical project behaves unchanged;
- a pure signal graph can execute without MNA participation;
- a signal can control one electrical source through an explicit adapter;
- an electrical sensor can feed a signal block;
- simulation pause/resume/step uses the same Scheduler timeline for both domains;
- save/reopen preserves both connection types;
- existing MCU/QEMU regression suite remains green;
- no Webview timer is required for simulation correctness.
## 10. One architecture, multiple deployment profiles

LasecSimul MUST NOT fork into separate `DesktopEngine` and `ServerEngine` implementations.

The invariant is:

```text
                    LasecSimul Core
                         │
                  SimulationSession
                         │
                     Scheduler
                         │
      ┌──────────────────┼──────────────────┐
      │                  │                  │
    Desktop          Shared Host         Future Remote
    policy             policy               policy
```

Desktop and Shared Host use the same local Core and simulation semantics. They differ only in resource/deployment policy.

Supported deployment profiles:

```text
Automatic
PersonalDesktop
SharedHost
Custom
```

The normal first-run experience SHOULD default to `Automatic`.

SharedHost means many independent user sessions on one physical machine. It is not the same as a future true network client/server backend.

### 10.1 Resource Governor

Cross-cutting services must obtain resource limits from a central `ResourceGovernor` instead of calling hardware concurrency or creating threads independently.

The governor may control:

- worker threads;
- external-process budget;
- telemetry frequency;
- visualization FPS;
- Scope/history memory;
- caches;
- log retention.

Resource policy may change throughput but MUST NOT alter simulation semantics.

See specs `43` and `44`.

### 10.2 Runtime Resolver

External toolchains such as Python/GHDL must be located through one runtime-resolution layer supporting:

- user-managed Desktop runtime;
- shared read-only laboratory runtime;
- explicit override;
- bundled runtime.

See spec `45`.

### 10.3 Simulation Backend seam

The Extension↔Core boundary SHOULD be represented through a backend abstraction compatible with the existing IPC design.

Initial:
```text
LocalSimulationBackend
```

Future, deferred:
```text
RemoteSimulationBackend
```

The future remote backend must not require a second simulation Core.

See spec `48`.

### 10.4 Multiuser isolation

Every session owns unique:

- IPC endpoint;
- temporary directory;
- Python state;
- GHDL work directory;
- QEMU temporary state;
- logs;
- virtual network namespace.

Read-only runtime binaries/assets may be shared.

See specs `45` and `47`.

### 10.5 Performance principle

The preferred optimization hierarchy is:

```text
1. efficient single-session algorithms
2. bounded/lazy external runtimes
3. parallelism between independent sessions
4. selective measured parallelism inside a session
5. only then more aggressive solver-specific parallel work
```

Never use `one component = one thread`.
