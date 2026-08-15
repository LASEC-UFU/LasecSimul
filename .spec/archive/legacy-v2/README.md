# LasecSimul `.spec` — Consolidated Architecture Roadmap

**Edition:** 2026-08-15 / specs `00–48`  
**Purpose:** incremental implementation reference for LasecSimul.

This folder defines the intended evolution of LasecSimul into a unified engineering simulation environment for:

- analog and digital electrical circuits;
- signal-flow/control blocks;
- continuous/discrete process simulation;
- simple SCADA-like animated process visualization;
- smart instrumentation and HART;
- Modbus server/client/scanner/monitor;
- PLC runtime and Ladder/IEC languages;
- Python-programmable blocks;
- MCU/QEMU;
- FPGA/VHDL/GHDL;
- future FMI/FMU;
- Desktop, SharedHost/thin-client and future remote-backend deployment.

## Architectural north-star

```text
                        LasecSimul
                            │
                   One Engineering Canvas
                            │
                     SimulationSession
                            │
                      Global Scheduler
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
    Electrical          Signal/Process       PLC/Protocols
      MNA                   ODE/state         deterministic
        │                   │                   │
        └────────────── explicit bridges ───────┘
                            │
                   External participants
                     Python/QEMU/GHDL
                            │
                   ResourceGovernor
                            │
               ┌────────────┴────────────┐
               │                         │
          Desktop policy            SharedHost policy
```

There is **one Core architecture**.

Desktop and SharedHost do not have separate physics/schedulers.

## Critical invariants

1. Core/Scheduler owns simulation time.
2. MNA remains electrical authority.
3. Signal connections and electrical wires are semantically different.
4. Cross-domain bridges are explicit.
5. Process/PLC/protocol time never uses wall-clock time.
6. UI animation/render FPS never controls simulation fidelity.
7. Python cannot directly stamp MNA.
8. External runtimes are lazy and isolated.
9. One component does not imply one thread/process.
10. SharedHost favors host-wide throughput over one session consuming all CPU.
11. Performance policy may change throughput, never simulation semantics.
12. Shared runtime binaries may be reused; mutable state is per session.
13. Simulated Modbus TCP uses virtual networking by default.
14. Future remote client/server uses the same Core behind a backend boundary.
15. Coding agents must inspect the actual repository before introducing abstractions.

## Suggested reading order

### Foundation
1. `00-vision-and-architecture.md`
2. `01-simulation-domain-contracts.md`
3. `02-typed-signals-units-bindings.md`
4. `24-connection-types-and-topology.md`
5. `43-performance-concurrency-threading.md`
6. `44-thin-client-multiuser-resource-governor.md`

### Signal/process
7. `03-signal-engine-mvp.md`
8. `04-continuous-discrete-solvers.md`
9. `05-electrical-signal-bridges.md`
10. `06-process-block-library.md`
11. `25-scope-data-and-simulation-control.md`
12. `30-animated-process-visualization.md`
13. `31-process-visual-asset-and-animation-schema.md`
14. `40-process-visualization-editor-ux.md`

### Subsystems/instrumentation
15. `07-subsystems-and-smart-devices.md`
16. `26-smart-instrument-parameter-model.md`
17. `08-hart-smart-transmitter.md`
18. `09-hart-communicator-physical-layer.md`
19. `27-process-simul-reference-porting.md`

### Modbus / networking
20. `10-modbus-core-server.md`
21. `11-modbus-client-scanner-monitor.md`
22. `15-protocol-infrastructure.md`
23. `29-uart-rs485-physical-transport.md`
24. `47-virtual-network-multiuser-isolation.md`

### PLC
25. `12-plc-runtime-scan-cycle.md`
26. `13-ladder-and-iec-languages.md`
27. `28-plc-modbus-integration.md`

### Python
28. `32-python-script-block.md`
29. `33-python-electrical-and-process-io-bridge.md`
30. `34-python-runtime-security-and-dependencies.md`
31. `38-animated-process-python-integration.md`

### FPGA
32. `14-fpga-vhdl-ghdl-integration.md`

### Distribution / laboratories
33. `35-marketplace-one-click-installation.md`
34. `36-managed-toolchain-bootstrap.md`
35. `37-first-run-onboarding-and-setup-prompt.md`
36. `45-shared-runtime-laboratory-deployment.md`
37. `39-marketplace-release-packaging-and-ci.md`
38. `46-performance-benchmark-capacity-planning.md`
39. `48-simulation-backend-local-remote-abstraction.md`

### Cross-cutting / future
40. `16-project-schema-artifacts.md`
41. `17-ui-ux-canvas-catalog.md`
42. `18-observability-diagnostics.md`
43. `19-testing-regression-strategy.md`
44. `20-roadmap-milestones.md`
45. `21-example-projects.md`
46. `22-agent-implementation-rules.md`
47. `23-future-fmi-and-ecosystem.md`
48. `41-new-feature-test-matrix-and-demos.md`
49. `42-architecture-decisions-addendum.md`
50. `DECISIONS.md`
51. `STATUS.md`
52. `99-spec-template.md`

## Deployment profiles

Normal first-run choice:

```text
● Automatic — Recommended
○ Personal computer / workstation
○ Shared laboratory / thin-client host
○ Advanced / custom
```

This chooses policy, not a different simulator.

### Personal Desktop
- user-managed runtime;
- larger worker/render/history budgets as appropriate.

### SharedHost
- machine-shared read-only runtime;
- isolated per-session mutable state;
- conservative bounded workers;
- lower visual/telemetry budgets;
- virtual networks;
- lazy Python/QEMU/GHDL.

### Future Remote
Deferred. The eventual remote service should implement `RemoteSimulationBackend` against the same Core semantics.

## Status vocabulary

| Status | Meaning |
|---|---|
| `NOT STARTED` | No implementation started |
| `SPIKE` | Technical feasibility experiment only |
| `PLANNED` | Design accepted; implementation not started |
| `IMPLEMENTING` | Production implementation in progress |
| `BLOCKED` | Blocked by prerequisite |
| `MVP DONE` | MVP acceptance criteria satisfied |
| `DONE` | Current spec fully satisfied |
| `DEFERRED` | Explicitly postponed |
| `ACTIVE` | Ongoing policy/rules document |

## Definition of Done

A feature is not `MVP DONE` until:
- repository baseline/regressions pass;
- headless tests exist;
- persistence works where relevant;
- diagnostics are actionable;
- packaging is checked;
- SharedHost isolation/resource implications are considered;
- no unbounded thread/process/history behavior is introduced;
- performance profile does not change semantics;
- at least one runnable example exists.

## Agent usage

Always give an implementation agent:
1. `README.md`;
2. `22-agent-implementation-rules.md`;
3. `DECISIONS.md`;
4. `STATUS.md`;
5. the small set of specs for the current milestone.

Do not ask one agent session to implement all specs at once.

Candidate class/file names in these specs are architectural suggestions. The real repository is authoritative.
