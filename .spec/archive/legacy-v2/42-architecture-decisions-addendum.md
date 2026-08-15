# 42 — Architecture Decisions Addendum: Visual Process, Python and Installation

**Status:** DECISION RECORD  
**Applies to:** specs `30`–`41`

## ADR-30.1 — Visualization is not simulation

Decision:
- process animation is a one-way projection of simulation state.

Rationale:
- preserves deterministic physics;
- prevents Webview from becoming a solver;
- allows multiple visual representations of the same model.

---

## ADR-30.2 — Simple SCADA-like visualization, not full SCADA

Decision:
- implement templates/bindings first;
- no full screen designer, historian, alarm server, OPC stack, arbitrary scripts.

---

## ADR-31.1 — SVG is preferred

Decision:
- built-in animated process visuals use safe SVG templates;
- custom SVG is sanitized;
- no script inside SVG.

---

## ADR-32.1 — Python runs out-of-process

Decision:
- managed child process/worker for MVP;
- do not embed CPython in Core initially.

---

## ADR-32.2 — Core remains simulation authority

Decision:
- Python receives scheduled values/time and returns outputs;
- Core Scheduler owns virtual time;
- Core owns topology and electrical stamping.

---

## ADR-33.1 — Python cannot stamp MNA directly

Decision:
- electrical Python outputs are requests translated by native adapters.

---

## ADR-33.2 — Python electrical behavior is sampled/discrete in MVP

Decision:
- no Python callback inside Newton/MNA inner loop.

---

## ADR-34.1 — Workspace Trust required for workspace script execution

Decision:
- untrusted project code is never auto-executed.

---

## ADR-35.1 — Marketplace install must lead to one guided setup

Decision:
- normal user should not manually install Python or GHDL;
- first-run prompt provisions managed toolchains.

---

## ADR-35.2 — No PATH/admin mutation

Decision:
- runtime stays in extension-managed storage;
- tools are invoked by absolute path.

---

## ADR-36.1 — Runtime downloads are pinned and verified

Decision:
- exact version + SHA-256 + health probe;
- transactional staging and rollback.

---

## ADR-36.2 — Platform-specific VSIX packages

Decision:
- use per-platform Marketplace packages where native content differs.

---

## ADR-35.3 — External editor extensions are optional

Decision:
- Python/VHDL editor extensions may be recommended;
- LasecSimul runtime does not depend on them for basic simulation.

---

## ADR-38.1 — One visualization system for native and Python processes

Decision:
- Python blocks publish typed outputs;
- existing visualization binding consumes those outputs;
- no Python-only UI renderer.
## ADR-43.1 — No one-thread-per-block model

Decision:
- one simulation coordinator;
- bounded optional worker pool;
- components do not own arbitrary thread counts.

## ADR-44.1 — One architecture for Desktop and SharedHost

Decision:
- same Core, Scheduler and project semantics;
- different deployment/resource policies only.

## ADR-44.2 — SharedHost optimizes aggregate throughput

Decision:
- conservative per-session worker budgets;
- let independent Core processes provide natural host parallelism.

## ADR-45.1 — Laboratory toolchains are shared read-only

Decision:
- Python/GHDL runtimes may be installed once per host;
- mutable state is always per session.

## ADR-47.1 — Virtual network by default

Decision:
- Modbus TCP and future simulated Ethernet endpoints do not bind real host ports unless explicitly exposed.

## ADR-48.1 — Prepare a backend seam, defer remote server

Decision:
- existing local IPC remains normal;
- a future RemoteSimulationBackend reuses the same simulation Core.
