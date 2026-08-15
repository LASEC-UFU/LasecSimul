# 03 — Signal Engine MVP

**Status:** NOT STARTED  
**Priority:** Highest new simulation-domain milestone  
**Depends on:** `00`, `01`, `02`

## 1. Goal

Implement the smallest useful Simulink-style directed signal engine inside LasecSimul without modifying electrical MNA semantics.

The first demo must be:

```text
Step → Gain → Sum → Display
```

and then:

```text
Sine → Gain → Scope
```

all running under the existing Scheduler virtual time.

## 2. MVP blocks

### Sources

- Constant
- Step
- Ramp
- Sine

### Math

- Gain
- Sum
- Product (optional in first slice)

### Sinks

- Display
- Scope/log sink

### Utility

- Signal Probe
- Signal Terminator if needed for diagnostics

## 3. Graph model

Candidate concepts:

```text
SignalGraph
SignalBlockInstance
SignalPort
SignalConnection
SignalValue
```

The graph must:

- validate directed connections;
- topologically order acyclic combinational regions;
- mark downstream blocks dirty on input change;
- identify cycles;
- preserve stable IDs in persistence;
- coexist with components on the same visual canvas.

## 4. Evaluation model

### 4.1 Pure combinational blocks

A Gain/Sum evaluates when a source input changes or a relevant parameter changes.

### 4.2 Time-dependent source blocks

A Sine/Ramp/Step requests future evaluation according to an explicit sample/evaluation policy.

Do **not** tie updates to Webview frame rate.

### 4.3 Continuous preview vs numerical truth

Scope rendering can decimate visual samples, but the underlying simulation values remain Scheduler-driven.

## 5. Sample time

Initial `SampleTime` model:

```cpp
enum class SampleTimeKind {
    Continuous,
    Discrete,
    Inherited,
    EventDriven
};

struct SampleTime {
    SampleTimeKind kind;
    uint64_t periodNs;
    uint64_t offsetNs;
};
```

For MVP:

- Constant: EventDriven/configuration-time.
- Step: event at step timestamp.
- Ramp/Sine: either explicit discrete sample time first, or continuous-source evaluation requested by downstream continuous solver.
- Gain/Sum: Inherited/EventDriven.
- Display: Inherited.

Avoid pretending a continuous sine is numerically continuous if sampled at a fixed UI interval. Label semantics correctly.

## 6. Algebraic cycles

MVP behavior:

- detect zero-delay cycles in pure signal graph;
- report a structured diagnostic listing participating blocks/connections;
- refuse start or fault that region.

Later iterative algebraic-loop solving is covered in solver spec.

## 7. Parameters

Examples:

### Constant
- value
- type
- unit

### Step
- initial value
- final value
- step time

### Sine
- amplitude
- bias
- frequency
- phase
- sample time/evaluation mode

### Gain
- gain

### Sum
- sign pattern, e.g. `++-`
- dynamic input count

Reuse current dynamic pin infrastructure if it can represent signal ports without conflating electrical pins. If not, add a signal-specific port description with shared visual-generation helpers.

## 8. Scheduler integration

Create no second independent clock.

The Signal Engine must:

- schedule sample hits through the Scheduler;
- pause/resume exactly with simulation;
- stop/reset state;
- support `step(deltaNs)` deterministically;
- not drift against electrical/MCU/FPGA time.

## 9. UI

Palette candidate:

```text
Control & Signals
├── Sources
│   ├── Constant
│   ├── Step
│   ├── Ramp
│   └── Sine
├── Math
│   ├── Gain
│   └── Sum
└── Sinks
    ├── Display
    └── Scope
```

Signal lines should be visually directional and distinguishable from electrical wires.

Do not duplicate the entire schematic engine. Extend it to render multiple connection semantics.

## 10. IPC

The Extension should not simulate blocks. IPC should expose the minimum required state/telemetry:

- project graph changes;
- simulation start/stop/step through existing commands;
- signal value observations;
- scope sample batches;
- diagnostics.

Use batching for high-rate scope data.

## 11. Performance targets

Initial reasonable targets to validate:

- 1,000 simple scalar blocks;
- 2,000 signal connections;
- 10,000 simulated discrete events/s in headless tests;
- no O(N²) reevaluation for one local input change.

These are engineering smoke targets, not hard product guarantees.

## 12. Tests

- Constant→Gain numeric correctness;
- Step transition exactly at configured virtual time;
- Sum signs;
- Sine sample determinism;
- pause/resume;
- simulation step;
- graph cycle detection;
- fan-out;
- disconnected input defaults/errors;
- delete block cancels pending events;
- save/reopen graph;
- electrical-only regression unchanged.

## 13. MVP acceptance

A user can build a pure signal-flow diagram, run/pause/step it, see numerical output/scope samples and save/reopen it without involving the MNA solver.
