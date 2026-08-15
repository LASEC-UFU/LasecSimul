# LasecSimul Roadmap Status

Update this file after every implementation milestone.

| Spec | Status | Notes |
|---|---|---|
| 00 Vision & Architecture | PLANNED | Architectural north-star |
| 01 Simulation Domain Contracts | PLANNED | Confirm against current Scheduler/Session before code |
| 02 Typed Signals / Units / Bindings | NOT STARTED | Foundation |
| 03 Signal Engine MVP | NOT STARTED | First recommended new feature |
| 04 Continuous / Discrete Solvers | NOT STARTED | After signal graph |
| 05 Electrical ↔ Signal Bridges | NOT STARTED | Major unified-canvas proof |
| 06 Process Block Library | NOT STARTED | FirstOrder/FOPDT/Tank/Valve |
| 07 Subsystems / Smart Devices | NOT STARTED | Extend existing subcircuit safely |
| 08 HART Smart Transmitter | NOT STARTED | Semantic HART first |
| 09 HART Communicator / Physical Layer | NOT STARTED | FSK deferred until semantic MVP |
| 10 Modbus Core / Server | NOT STARTED | Server/register map |
| 11 Modbus Client / Scanner / Monitor | NOT STARTED | OpenModScan-like UX |
| 12 PLC Runtime / Scan Cycle | NOT STARTED | Runtime before Ladder editor |
| 13 Ladder / IEC Languages | NOT STARTED | LD first; shared IR |
| 14 FPGA / VHDL / GHDL | SPIKE | Spike 0 should prove VPI/time assumptions |
| 15 Protocol Infrastructure | PLANNED | Extract shared parts only after HART+Modbus evidence |
| 16 Project Schema / Artifacts | PLANNED | Cross-cutting, inspect real schema first |
| 17 UI / UX / Catalog | PLANNED | Headless behavior first |
| 18 Observability / Diagnostics | PLANNED | Extend existing diagnostics |
| 19 Testing / Regression | PLANNED | Mandatory throughout |
| 20 Roadmap / Milestones | PLANNED | Sequence guide |
| 21 Example Projects | PLANNED | Add incrementally |
| 22 Agent Implementation Rules | ACTIVE | Mandatory |
| 23 FMI / Ecosystem | DEFERRED | Long-term |
| 24 Connection Types / Topology | NOT STARTED | Foundation detail |
| 25 Scope / Data / Simulation Control | NOT STARTED | Early signal UX |
| 26 Smart Instrument Variable Model | NOT STARTED | Before multiple smart instruments |
| 27 process_simul Porting Guide | PLANNED | Reference only |
| 28 PLC ↔ Modbus Integration | NOT STARTED | After both MVPs |
| 29 UART / RS-485 Physical Transport | DEFERRED | Physical layer later |
| 30 Animated Process Visualization | NOT STARTED | Simple SCADA-like visuals |
| 31 Process Visual Asset Schema | NOT STARTED | Safe SVG bindings |
| 32 Python Script Block | NOT STARTED | Signal-domain first |
| 33 Python Electrical/Process I/O | NOT STARTED | Native electrical adapter |
| 34 Python Runtime/Security | NOT STARTED | Managed worker/runtime |
| 35 Marketplace One-Click Installation | PLANNED | One architecture, deployment profiles |
| 36 Managed Toolchain Bootstrap | PLANNED | User/shared runtime |
| 37 First-Run Setup Prompt | PLANNED | Automatic/Desktop/SharedHost |
| 38 Animated Process + Python | NOT STARTED | Shared visual binding |
| 39 Marketplace Packaging/CI | PLANNED | Desktop + SharedHost release tests |
| 40 Visualization Editor UX | PLANNED | Lightweight, not full SCADA |
| 41 New Feature Test Matrix | PLANNED | End-to-end |
| 42 Architecture Decisions Addendum | ACTIVE | Cross-cutting decisions |
| 43 Performance / Concurrency / Threading | PLANNED | Bounded parallelism |
| 44 SharedHost / Resource Governor | PLANNED | Thin-client optimization |
| 45 Shared Runtime / Lab Deployment | PLANNED | One runtime per host |
| 46 Performance Benchmarks / Capacity | PLANNED | Evidence-based defaults |
| 47 Virtual Network / Multiuser Isolation | PLANNED | No host-port collisions |
| 48 Simulation Backend Local/Remote Seam | PLANNED | Remote implementation deferred |

## Current recommended next implementation milestone

**Signal Engine MVP**, unless the active FPGA/GHDL track is already in progress.

Before changing code:
- baseline current tests;
- inspect current project schema;
- inspect schematic connection representation;
- decide minimal representation for signal ports/lines that does not contaminate electrical Netlist semantics.

## Change log

| Date | Spec | Old | New | Note |
|---|---|---|---|---|
| 2026-08-15 | package | — | created | Initial architecture roadmap specs |
| 2026-08-15 | 00/35–48 | PLANNED | consolidated | SharedHost architecture consolidation; one Core, ResourceGovernor, shared runtime, virtual network, backend seam |
