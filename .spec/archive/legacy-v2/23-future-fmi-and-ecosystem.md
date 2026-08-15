# 23 — Future FMI/FMU and External Model Ecosystem

**Status:** DEFERRED  
**Priority:** Long-term  
**Depends on:** stable multi-domain Scheduler and signal engine

## 1. Goal

Prepare, without prematurely implementing, for importing external simulation models through FMI/FMUs and other interoperable model formats.

## 2. Why FMI later

A stable co-simulation contract could allow:

```text
Modelica/other tool → FMU → LasecSimul
```

Use cases:

- complex process plant;
- thermal/mechanical model;
- vendor-neutral plant model;
- research model.

## 3. Prerequisites

Do not start until:

- Signal Engine stable;
- Scheduler can coordinate multiple domains;
- explicit `advanceTo`-style participant semantics understood;
- typed variable bindings exist;
- robust external failure/diagnostics exist.

## 4. Feasibility spike

Investigate:

- FMI version target;
- Co-Simulation vs Model Exchange;
- platform binary loading;
- variable type mapping;
- event mode;
- rollback requirements;
- step negotiation;
- FMU extraction/cache/security;
- licensing.

## 5. Integration concept

```text
FmuComponent
  │
FmiRuntime
  │
Signal ports / parameters
  │
Scheduler synchronization
```

FMU inputs/outputs should be signal ports first. Physical electrical FMUs require explicit adapters or future physical-domain integration.

## 6. Time

Core remains coordinator unless a different FMI mode explicitly requires negotiation.

Never let external FMU wall-clock control the simulation.

## 7. Security

FMUs can contain native binaries. Treat them as executable content:

- explicit user trust;
- controlled extraction path;
- no silent internet fetch;
- crash/error containment where practical.

## 8. Non-goals now

- implement FMI;
- build Modelica compiler;
- promise Simulink model import;
- claim arbitrary FMU compatibility.

This spec exists to prevent current architecture from accidentally making future co-simulation impossible.
