# Architecture Decisions Register

This file records decisions already made during design discussions so future implementation agents do not repeatedly reopen them without new evidence.

## D-001 — One Canvas, Multiple Simulation Domains

**Decision:** accepted.

LasecSimul will use one main engineering canvas, but electrical, signal/process, PLC and external simulation domains keep domain-correct numerical semantics.

**Do not:** force signal blocks into MNA simply to share a solver.

## D-002 — Scheduler remains the virtual-time authority

**Decision:** accepted.

The existing Core Scheduler coordinates simulated time. Current base unit remains nanoseconds.

**Do not:** introduce a second independent clock or use wall-clock timers for process/PLC/protocol semantics.

## D-003 — Electrical and signal connections are distinct

**Decision:** accepted.

Electrical wire = physical network. Signal line = directed typed value flow.

Bridges are explicit components.

## D-004 — Electrical MNA model stays intact

**Decision:** accepted.

New signal/process functionality does not justify replacing the existing electrical solver.

## D-005 — Subcircuit evolves toward hybrid Subsystem

**Decision:** accepted direction, implementation mechanism still requires repository/schema inspection.

Reuse current subcircuit editor, interface tunnels and symbol-generation machinery.

## D-006 — Smart Instrument is a specialized subsystem concept

**Decision:** accepted.

`HART Smart Transmitter` is a ready-made Smart Instrument. HART protocol logic is a reusable internal engine, not the entire instrument.

## D-007 — Process models live in shared Process library

**Decision:** accepted.

HART may offer embedded-process convenience, but canonical FirstOrder/FOPDT/Tank/Valve models are shared.

## D-008 — HART semantic mode before physical FSK

**Decision:** accepted.

Implement device variables/commands/communicator and 4–20 mA behavior before a waveform-level modem.

## D-009 — `process_simul` is reference code only

**Decision:** accepted.

Port useful concepts from Dart to C++20. Do not run Flutter/Dart as a LasecSimul dependency.

## D-010 — Modbus server + client/scanner + monitor family

**Decision:** accepted.

Server resembles useful OpenModSim workflows; client/scanner resembles OpenModScan workflows; monitor is passive.

## D-011 — Modbus bindings are first-class

**Decision:** accepted.

A register can bind to actual simulation variables/parameters with explicit read/write policy, scaling and type conversion.

## D-012 — Semantic protocol before detailed physical serial network

**Decision:** accepted.

Modbus TCP/internal semantic behavior comes before detailed UART/RS-485 physical simulation.

## D-013 — Generic PLC runtime before Ladder editor

**Decision:** accepted.

Prove scan semantics and shared PLC IR first. Ladder is a frontend, not the runtime.

## D-014 — Shared PLC IR for LD/ST/FBD/SFC

**Decision:** accepted direction.

Avoid separate execution engines per language.

## D-015 — FPGA uses GHDL and mirrors external-process lessons

**Decision:** accepted.

Keep Scheduler ns and MNA behavior. GHDL/VPI must pass a real feasibility spike, especially time control.

## D-016 — FPGA 9-state logic is local

**Decision:** accepted.

Do not retrofit the full Core with a symbolic 9-state digital system for FPGA MVP.

## D-017 — FMI/FMU is future work

**Decision:** deferred.

Leave architecture open but do not implement until signal/domain coordination is stable.

## D-018 — One Core architecture for Desktop and SharedHost

**Decision:** accepted.

Do not create separate Desktop and laboratory simulation engines.

The same Core/Scheduler/project semantics run under different resource/deployment policies.

## D-019 — SharedHost is not a true remote client/server backend

**Decision:** accepted.

The current laboratory architecture is many local user sessions on one host.

Use the term `Shared laboratory / thin-client host`.

A future remote Core is a separate backend transport capability, not a second physics engine.

## D-020 — ResourceGovernor is the concurrency/resource authority

**Decision:** accepted.

Components do not independently consume all hardware concurrency.

The governor controls worker, memory, telemetry, rendering and external-process budgets.

## D-021 — Parallel sessions before aggressive per-session threading

**Decision:** accepted.

In SharedHost deployments prioritize total host throughput and fairness.

Do not create one thread per block/device/protocol.

## D-022 — Performance profiles cannot change simulation semantics

**Decision:** accepted.

Desktop/SharedHost may differ in throughput, UI FPS, history retention and worker count, not in virtual-time behavior or model equations.

## D-023 — Shared read-only runtime for laboratories

**Decision:** accepted.

Python/GHDL/tool binaries may be installed once per host and shared read-only.

All mutable per-project/per-session state remains isolated.

## D-024 — One Python worker per session by default

**Decision:** accepted.

Do not launch one Python process per Python Block.

## D-025 — External runtimes are lazy

**Decision:** accepted.

No Python component → no Python worker.  
No FPGA component → no GHDL process.  
No MCU component → no QEMU process.

## D-026 — Virtual network is default for simulated Ethernet protocols

**Decision:** accepted direction.

Identical Modbus TCP addresses/ports in different sessions must not collide.

Real OS sockets require explicit host-network exposure.

## D-027 — Local/remote difference belongs behind SimulationBackend

**Decision:** accepted direction.

Current implementation is `LocalSimulationBackend`.

A future `RemoteSimulationBackend` must reuse the same Core and remain deferred until separately approved.

## D-028 — Installation chooses policy, not product variant

**Decision:** accepted.

First-run may ask Automatic / Personal Desktop / Shared Laboratory / Advanced.

The choice does not install different simulation codebases.

## Open decisions requiring evidence

1. Exact C++/Core abstraction for signal graph.
2. Exact `.lsproj` schema extension layout.
3. Whether `.lsplc` deserves its own artifact extension.
4. Whether Smart Instrument needs a new artifact extension or can use enhanced `.lssubcircuit`/`.lsdevice`.
5. Exact signal-port representation vs existing component pin structures.
6. Physical HART modem fidelity/solver feasibility.
7. Detailed Modbus RTU physical-line model.
8. Algebraic-loop solver strategy after detection-only MVP.
9. GHDL time-control mechanism proven by Spike 0.
10. Default SharedHost resource budgets after benchmarks.
11. Exact administrator policy/configuration mechanism.
12. Whether host-wide dynamic resource coordination needs a daemon after MVP.
13. Exact SimulationBackend API mapping to current IPC.

Changing an accepted decision should add a new decision entry explaining new evidence and migration impact.
