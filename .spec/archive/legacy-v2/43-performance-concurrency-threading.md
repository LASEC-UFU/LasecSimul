# 43 — Performance, Concurrency and Threading Model

**Status:** PLANNED  
**Priority:** Foundation / cross-cutting  
**Depends on:** `00`, `01`, `03`, current Core/Scheduler implementation  
**Related:** `25`, `32`, `34`, `44`, `46`, `48`

## 1. Goal

Define a concurrency model that can:

1. exploit modern multi-core desktop hardware;
2. remain deterministic;
3. avoid oversubscription;
4. scale well when many independent LasecSimul sessions run on one thin-client/shared host;
5. keep the existing Core/Scheduler authoritative;
6. prevent user-interface refresh and external runtimes from consuming CPU unnecessarily.

The central rule is:

> **Parallelism between independent simulation sessions has priority over aggressive parallelism inside one session.**

Within one session, parallel work is used only where measurements demonstrate a real benefit.

---

## 2. Non-goal

Do NOT implement:

```text
one block = one thread
one protocol endpoint = one thread
one PLC = one thread
one HART device = one thread
```

This architecture does not scale and is specifically forbidden.

---

## 3. Simulation coordinator

Every `SimulationSession` has one logical simulation coordinator.

Candidate model:

```text
SimulationSession
       │
       ▼
Simulation Coordinator
       │
       ▼
Scheduler / Virtual Time
       │
       ├── deterministic event execution
       ├── state commit
       ├── settle coordination
       └── optional parallel work dispatch
```

The exact existing thread that already owns `SimulationSession`/`Scheduler` must be inspected before changing threading.

Do not introduce a second scheduler authority.

---

## 4. Determinism contract

Different performance profiles MAY change:
- wall-clock execution speed;
- worker count;
- scheduling of independent worker tasks;
- UI refresh rate;
- telemetry batch size.

They MUST NOT change:
- simulation timestamps;
- event causality;
- block sample hits;
- PLC scan times;
- protocol timeout semantics;
- numerical integration method selected by the model;
- final committed model state, within the solver's documented deterministic floating-point tolerance.

Required invariant:

```text
same project
+ same inputs
+ same solver configuration
+ same seed
=
same simulation semantics
```

on Desktop and Shared Host profiles.

---

## 5. Worker pool

A `SimulationSession` MAY have access to a bounded worker pool.

Candidate resource interface:

```cpp
struct ParallelBudget
{
    uint32_t maxWorkers;
    bool allowParallelGraphEvaluation;
    bool allowParallelPostProcessing;
};
```

Do not hard-code hardware-concurrency usage in individual components.

Components ask a shared resource policy whether parallel execution is available.

---

## 6. Work suitable for parallelism

Good candidates include:

### 6.1 Independent signal-graph regions

Example:

```text
              ┌── Gain A ── Plant A
Source ───────┼── Gain B ── Plant B
              └── Gain C ── Plant C
```

If dependency analysis proves the three branches are independent for the current evaluation phase, they may run as parallel tasks and commit after a barrier.

### 6.2 Independent expensive model evaluations

Examples:
- independent process models;
- large lookup/equation blocks;
- independent post-processing;
- waveform decimation;
- serialization/compression outside the critical simulation path.

### 6.3 Background non-semantic tasks

Examples:
- parsing a large project while simulation is stopped;
- asset preparation;
- indexing;
- optional compilation preparation.

These tasks must never mutate simulation state without coordinator ownership.

---

## 7. Work that should normally stay on the coordinator

Examples:
- Scheduler queue mutation;
- final state commit;
- MNA settle orchestration unless the solver itself has a proven parallel implementation;
- PLC scan execution;
- HART semantic command handlers;
- Modbus semantic request processing;
- timers/counters;
- lightweight Gain/Sum/Constant blocks;
- topology changes.

A tiny arithmetic block is usually cheaper inline than dispatched through a worker queue.

---

## 8. Parallelization threshold

Every parallel execution path needs a cost threshold.

Conceptual:

```text
estimated work < threshold
    → execute inline

estimated work >= threshold
    → worker pool
```

The threshold may initially be conservative/static.

Future profiling may introduce adaptive thresholds.

No feature is accepted merely because it creates more threads.

---

## 9. MNA solver policy

The existing MNA solver remains authoritative.

MVP:
- keep matrix assembly/solve behavior unchanged unless profiling identifies a true bottleneck;
- do not refactor MNA into parallel form merely for architectural symmetry.

Future:
- consider parallel sparse factorization only after:
  - real circuit benchmarks;
  - stable solver tests;
  - deterministic/reproducibility analysis;
  - proof that third-party solver/library deployment fits thin-client licensing and packaging.

---

## 10. External-process concurrency

External engines include:
- Python worker;
- QEMU;
- GHDL;
- future FMU processes.

Rules:
1. lazy-create only if project uses the feature;
2. no busy polling;
3. use blocking/async IPC;
4. worker lifetime bound to session/project;
5. explicit shutdown;
6. bounded queues;
7. Resource Governor can deny/delay optional external process creation.

---

## 11. Python process policy

Default:

```text
one SimulationSession
        │
        └── one shared Python worker process
              ├── Python Block A
              ├── Python Block B
              └── Python Block C
```

Do NOT launch one Python process per block.

A dedicated-worker option may be added later for:
- isolation;
- heavy package conflicts;
- advanced performance cases.

It is not the default laboratory behavior.

---

## 12. GHDL/QEMU process policy

MVP:
- instantiate external process only when matching component exists and simulation starts;
- stop process on session shutdown;
- keep independent working directories per session;
- do not prelaunch toolchains at extension activation.

---

## 13. Idle policy

A stopped or paused project should consume near-zero CPU.

Forbidden:
```text
while (true) poll()
```

Preferred:
- condition variable;
- blocking pipe/socket;
- event;
- timer only when semantically required;
- OS async I/O.

---

## 14. UI independence

The UI is never part of simulation timing.

Separate:

```text
simulation event rate
telemetry publish rate
Webview render rate
```

Example:
```text
MNA / scheduler: potentially very high
Scope publication: decimated/batched
Tank animation: 10–30 FPS depending on profile
```

---

## 15. Thread ownership rules

Every mutable runtime object should have documented ownership.

At minimum specify for:
- Scheduler;
- SimulationSession;
- Netlist;
- solver state;
- signal state;
- external-process queues;
- telemetry cache.

Use:
- immutable snapshots;
- message passing;
- bounded queues;
- barriers;
- narrow locking.

Avoid coarse global locks around the whole Core.

---

## 16. Queue policy

Every cross-thread queue must define:
- producer;
- consumer;
- bounded capacity;
- overflow behavior;
- ordering guarantee;
- shutdown behavior.

For telemetry, dropping stale intermediate frames is acceptable.

For simulation commands/events, silent dropping is forbidden.

---

## 17. False sharing and allocation pressure

Performance work should consider:
- stable component storage;
- avoiding per-step heap allocations;
- reusable buffers;
- cache-friendly signal arrays;
- batched telemetry;
- avoiding thousands of tiny futures/promises.

This is especially important with many sessions on one host.

---

## 18. Performance profiles

Threading policy is selected through `ResourceGovernor`, not scattered conditionals.

Profiles:

```text
Automatic
Desktop
SharedHost
Custom
```

Example intent:

### Desktop
- coordinator: 1;
- worker budget: moderate/aggressive when workload benefits;
- full normal visualization cap.

### SharedHost
- coordinator: 1;
- worker budget: 0–2 by default;
- conservative external-process budget;
- lower UI/telemetry budget.

### Automatic
- safe default;
- detects local conditions;
- may choose Desktop unless admin policy declares SharedHost.

---

## 19. Do not use `hardware_concurrency()` directly everywhere

Only one resource-management layer should inspect CPU capacity.

Components must not independently decide:

```cpp
workers = std::thread::hardware_concurrency();
```

because 20 sessions could each claim the entire host.

---

## 20. Future adaptive resource allocation

A future host-aware governor may reduce/increase worker budgets based on:
- active session count;
- host CPU pressure;
- memory pressure;
- lab administrator limits.

Dynamic budget changes may affect throughput only, not simulation semantics.

---

## 21. Tests

### Determinism
Run identical project:
- workers = 0;
- workers = 1;
- workers = N.

Compare committed outputs within defined tolerance.

### Concurrency
- concurrent independent graph branches;
- worker exception;
- queue saturation;
- session shutdown during active task;
- pause/resume;
- project reset.

### Idle
Verify stopped/paused simulation does not busy-loop.

### Multi-session
Run many Core processes concurrently and verify:
- no IPC collision;
- no shared temp collision;
- no unbounded thread growth.

---

## 22. Acceptance criteria

This spec is satisfied when:
- no component creates an unbounded dedicated thread;
- each session has a bounded concurrency budget;
- SharedHost can keep worker count conservative;
- Desktop can exploit independent heavy work;
- worker-count changes do not change simulation semantics;
- idle CPU usage is negligible;
- multi-session benchmarks exist.
