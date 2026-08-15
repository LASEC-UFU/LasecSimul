# 44 — Thin Client / Shared Host and Resource Governor

**Status:** PLANNED  
**Priority:** Foundation for laboratory deployment  
**Depends on:** `43`  
**Related:** `25`, `30`, `35`, `45`, `46`, `48`

## 1. Goal

Support the laboratory architecture where many students execute independent LasecSimul sessions on one shared host while the fact that hardware is shared remains operationally unobtrusive.

The same LasecSimul Core must serve:
- personal workstation;
- notebook;
- powerful desktop;
- shared Windows/Linux host;
- future remote simulation server.

There are not separate simulation engines.

---

## 2. Terminology

Use:

```text
Shared Host / Thin Client
```

for:
- many user sessions;
- one physical host;
- each user runs independent VS Code/LasecSimul session.

Reserve:

```text
Client / Server
```

for the future topology where UI and simulation Core are intentionally separated across machines.

---

## 3. ResourceGovernor

Introduce a cross-cutting policy service.

Candidate:

```text
ResourceGovernor
├── CPU budget
├── memory budget
├── telemetry budget
├── UI/render budget
├── history budget
├── external-process budget
└── cache budget
```

It does not own simulation semantics.

---

## 4. Deployment Profile vs Performance Profile

Keep two concepts separate.

### Deployment profile

```text
Automatic
PersonalDesktop
SharedHost
Custom
```

Answers:
- where runtimes live;
- whether host is multiuser;
- isolation rules;
- default resource policy.

### Performance profile

```text
Automatic
Balanced
Performance
Conservative
Custom
```

Answers:
- worker limits;
- visual FPS;
- telemetry limits;
- memory/history budgets.

A SharedHost will normally default to Conservative/Balanced.

A PersonalDesktop normally defaults to Balanced/Performance.

---

## 5. Administrator policy

A laboratory administrator must be able to define machine-wide policy so students are not repeatedly asked to choose.

Possible managed configuration source:
- machine-level configuration file;
- VS Code managed setting;
- installer/deployment config;
- environment defined by lab deployment.

Example conceptual policy:

```json
{
  "deploymentProfile": "shared-host",
  "performanceProfile": "conservative",
  "maxWorkerThreadsPerSession": 1,
  "maxExternalProcessesPerSession": 4,
  "maxVisualFps": 15,
  "scopeMemoryMiB": 32,
  "simulationMemoryMiB": 512,
  "sharedRuntimeRoot": "C:\\ProgramData\\LasecSimul\\runtime"
}
```

Exact values are deployment examples, not universal defaults.

---

## 6. Default SharedHost behavior

Candidate baseline:
- one coordinator;
- 0–1 optional worker initially;
- lazy Python/QEMU/GHDL;
- process visualization 10–15 FPS cap;
- bounded Scope history;
- bounded logs;
- bounded telemetry queues;
- no background compiler/runtime unless used.

The real defaults must be benchmark-driven by spec `46`.

---

## 7. CPU budget

ResourceGovernor exposes:
- maximum workers;
- maximum parallel tasks;
- optional CPU-weight hint.

Do not set hard CPU affinity by default.

OS scheduler should distribute independent Core processes naturally.

Affinity/CPU sets may be an administrator-only future feature if real lab benchmarks justify it.

---

## 8. Memory budget

Every session must avoid unbounded growth.

Budget categories:
- simulation state;
- Scope history;
- protocol logs;
- trace data;
- Python IPC buffers;
- GHDL waveform storage;
- compilation cache;
- visualization telemetry.

When a soft budget is reached:
- trim discardable history;
- decimate telemetry;
- warn when appropriate.

Do not silently discard semantic simulation state.

---

## 9. Scope policy

Scope is a major potential memory/UI cost.

SharedHost:
- ring buffers;
- automatic decimation;
- bounded history;
- viewport-aware data transfer.

Never send one million samples to draw a 1500-pixel chart.

---

## 10. Visualization policy

Tank/flame/temperature animations:
- latest-state visualization;
- profile-controlled FPS;
- batched updates;
- decorative animation may be reduced under load.

Reducing visual FPS must not reduce process simulation fidelity.

---

## 11. Logs and protocol monitors

HART/Modbus/PLC/Python logs:
- bounded buffers;
- optional capture-to-file explicitly enabled;
- UI shows recent window;
- no unbounded in-memory append.

---

## 12. External processes

ResourceGovernor should account for:
- Python worker;
- QEMU instances;
- GHDL instances;
- future FMU workers.

If a project requires more external processes than policy allows:
- report clearly;
- allow admin/user override if permitted;
- never silently skip components.

---

## 13. SharedHost detection

Automatic detection can use hints, but MUST NOT rely on unreliable guessing alone.

Preferred priority:
1. administrator policy explicitly declares SharedHost;
2. explicit user selection;
3. safe automatic default;
4. hardware heuristics only as secondary information.

The simulator must not assume "many CPU cores = server".

---

## 14. User experience

Student should normally see:
```text
Run
Pause
Stop
```

not:
```text
CPU budget
thread pool
server quota
```

Advanced resource details belong in:
- diagnostics;
- settings;
- administrator setup.

---

## 15. Fairness

MVP fairness relies primarily on:
- per-session worker caps;
- lazy external processes;
- bounded memory;
- OS scheduler.

Future host daemon may coordinate dynamic fairness across sessions, but that is not needed for the first SharedHost deployment.

---

## 16. Session identity

Each session requires unique identity for:
- IPC;
- temp directory;
- Python state;
- GHDL workdir;
- QEMU artifacts;
- log paths;
- runtime sockets;
- virtual network namespaces.

Candidate identity:
```text
user/session/process/random-id
```

Do not rely only on project filename.

---

## 17. Resource diagnostics

`LasecSimul: Show Performance Diagnostics` should display:

```text
Deployment profile
Performance profile
Coordinator thread
Worker budget
Current worker utilization
Memory budget/current use
Scope history use
Telemetry queue
Python process status
QEMU/GHDL process count
UI FPS cap
Runtime paths
```

---

## 18. Graceful degradation

Under host pressure:
- reduce UI refresh;
- reduce retained history;
- reduce future optional parallelism;
- postpone noncritical indexing.

Never:
- change sample time;
- skip PLC scans;
- skip HART/Modbus semantic events;
- change solver tolerances without explicit user configuration.

---

## 19. Lab acceptance test

Representative host test:
- N simultaneous VS Code/LasecSimul sessions;
- mixture of paused, simple and complex projects;
- independent Python/GHDL use;
- all projects remain responsive;
- no cross-session collision;
- host avoids pathological thread/memory explosion.

N is established by capacity planning, not hard-coded in this spec.

---

## 20. Acceptance criteria

SharedHost profile is accepted when many sessions can coexist without each session claiming all CPU cores, without unbounded memory growth and without any change in simulation semantics compared with Desktop.
