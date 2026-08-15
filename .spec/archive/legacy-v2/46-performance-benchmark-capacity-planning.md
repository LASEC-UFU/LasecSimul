# 46 — Performance Benchmarks and Capacity Planning

**Status:** PLANNED  
**Priority:** Required before claiming lab capacity  
**Depends on:** `19`, `43`, `44`, `45`  
**Related:** `25`, `30`, `32`, `39`

## 1. Goal

Create reproducible benchmarks to decide:
- default worker count;
- SharedHost budgets;
- visual FPS;
- Scope limits;
- supported concurrent-session counts;
- where optimization effort is actually needed.

Never claim "supports N students" without benchmark evidence on a defined host.

---

## 2. Measurement philosophy

Measure:
- throughput;
- latency;
- CPU;
- memory;
- process/thread count;
- IPC traffic;
- UI responsiveness;
- simulation semantic correctness.

Do not optimize solely from intuition.

---

## 3. Benchmark tiers

### Tier A — Core-only headless

No Webview.

Measures:
- Scheduler;
- MNA;
- signal engine;
- process models;
- PLC/protocol semantic engines.

### Tier B — Core + extension telemetry

Measures IPC and serialization.

### Tier C — Full UI

Measures:
- Scope;
- animated process graphics;
- property updates.

### Tier D — External runtimes

Projects with:
- Python;
- QEMU;
- GHDL.

### Tier E — Multi-session SharedHost

Many independent VS Code/Core sessions.

---

## 4. Standard benchmark projects

Create deterministic fixtures.

### B1 — Small electrical
Representative analog/digital circuit.

### B2 — Large electrical
Hundreds/thousands of components if realistic.

### B3 — Signal/control
Large independent block graph.

### B4 — Continuous process
Several transfer functions/tanks/PIDs.

### B5 — PLC
Large Ladder/IR scan load.

### B6 — HART/Modbus semantic
Many endpoints.

### B7 — Animated process
10/50/100 visual blocks.

### B8 — Scope stress
High-rate signals and long run.

### B9 — Python
Many Python blocks in one shared worker.

### B10 — FPGA/MCU
GHDL/QEMU external-process stress.

### B11 — Mixed automation
Tank + HART + PLC + Modbus + circuit + Python.

---

## 5. Key metrics

Per session:
- wall time for simulated interval;
- real-time factor;
- average/p95 step time;
- memory RSS/private bytes;
- thread count;
- process count;
- telemetry bytes/s;
- Scope samples retained;
- UI FPS;
- command latency.

Host:
- total CPU utilization;
- context switches where measurable;
- memory pressure;
- swap/pagefile activity;
- total process/thread count;
- aggregate sessions completed/hour.

---

## 6. Worker scaling test

For the same project run:

```text
workers = 0
workers = 1
workers = 2
workers = 4
workers = 8...
```

Record:
- speedup;
- overhead;
- determinism.

Choose default based on actual curve.

If workers=4 is slower than workers=1 for normal projects, do not use 4 by default.

---

## 7. Thin-client concurrency matrix

Example methodology:

```text
1 active session
2
4
8
12
16
20
...
```

At each level mix:
- editing/idle sessions;
- simple simulation;
- medium simulation;
- heavy external-runtime simulation.

Capacity is not one number; publish tested profiles.

---

## 8. Memory capacity

Estimate:
```text
base VS Code session
+ extension
+ Core
+ project state
+ optional Python/QEMU/GHDL
+ Scope/history
```

Set SharedHost budgets below the point that causes paging.

Paging can destroy simulation responsiveness.

---

## 9. UI benchmark

Animated process rendering:
- 10 FPS;
- 15 FPS;
- 30 FPS.

Measure:
- CPU/GPU where accessible;
- message rate;
- perceived usability.

SharedHost default should be the lowest rate that remains visually useful.

---

## 10. Scope benchmark

Test:
- 1k;
- 10k;
- 100k;
- 1M+ produced samples.

UI should receive decimated data appropriate to viewport.

Benchmark different decimation algorithms for preserving extrema.

---

## 11. External-runtime benchmark

Python:
- one process/session;
- N block instances;
- small vs heavy scripts.

GHDL:
- compile cost;
- simulation runtime;
- memory;
- waveform enabled/disabled.

QEMU:
- process baseline;
- active MCU simulation cost.

---

## 12. Startup benchmark

Measure:
- extension activation;
- Core launch;
- project open;
- first run;
- lazy Python launch;
- lazy GHDL launch.

Do not prelaunch runtimes merely to improve one benchmark.

---

## 13. Regression thresholds

CI performance tests may use broad thresholds to catch catastrophic regression.

Example concepts:
- memory must not grow without bound;
- thread count must stay within budget;
- paused CPU must remain low;
- telemetry queue must stay bounded.

Avoid flaky microsecond-level hard gates on shared CI runners.

---

## 14. Capacity report

Generate versioned report:

```text
LasecSimul version
host CPU
logical/physical cores
RAM
OS
runtime versions
profile
project mix
maximum tested concurrent sessions
CPU/memory at load
known bottlenecks
```

---

## 15. Hardware classes

Maintain indicative classes only after testing:

```text
Entry Desktop
Standard Desktop
Workstation
Lab Shared Host Small
Lab Shared Host Medium
Lab Shared Host Large
```

Do not hard-code vendor/model assumptions in product logic.

---

## 16. Acceptance criteria

Performance profiles and lab concurrency recommendations are derived from repeatable benchmark data, not arbitrary thread counts.
