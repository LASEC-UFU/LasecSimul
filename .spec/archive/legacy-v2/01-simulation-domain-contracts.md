# 01 — Simulation Domain Contracts

**Status:** PLANNED  
**Priority:** Foundation  
**Depends on:** `00-vision-and-architecture.md`

## 1. Purpose

Define the smallest contracts required for multiple simulation domains to coexist without creating a monolithic solver architecture.

## 2. Principle

A simulation domain needs only enough interface to:

- declare its dependencies;
- be initialized/reset;
- know the current virtual time;
- expose its next required time/event if applicable;
- advance to an authorized time;
- report changed outputs;
- request re-evaluation/settling;
- stop safely.

Do not force all domains to implement identical numerical semantics.

## 3. Candidate contracts

Names below are illustrative and must be reconciled with real repository interfaces.

### 3.1 Time participant

```cpp
class ITimelineParticipant {
public:
    virtual ~ITimelineParticipant() = default;

    // If the participant constrains how far the Scheduler may advance,
    // return that bound in Scheduler nanoseconds.
    virtual std::optional<uint64_t> pacingPositionNs() const = 0;
};
```

Only extract this if at least MCU and another domain demonstrably need the same semantics. A lockstep FPGA may not need MCU-style pacing.

### 3.2 Signal block

```cpp
class ISignalBlock {
public:
    virtual void initialize(const SimulationContext&) = 0;
    virtual void reset(const SimulationContext&) = 0;

    virtual void evaluateOutputs(SignalEvalContext&) = 0;

    // State update for discrete/stateful blocks.
    virtual void updateState(SignalUpdateContext&) {}

    virtual SampleTime sampleTime() const = 0;
};
```

Avoid assuming every block has `double` input/output.

### 3.3 Continuous state provider

```cpp
class IContinuousStateModel {
public:
    virtual size_t stateCount() const = 0;
    virtual void getState(span<double>) const = 0;
    virtual void setState(span<const double>) = 0;
    virtual void derivatives(
        double tSeconds,
        span<const double> x,
        span<double> dxdt
    ) = 0;
};
```

The actual implementation may use a graph-level state vector for performance.

### 3.4 Domain adapter

Adapters should be ordinary components with explicit electrical and/or signal ports. Do not create invisible global converters.

## 4. Lifecycle contract

Every stateful domain object must define behavior for:

- project load;
- first simulation start;
- pause;
- resume;
- single-step;
- stop;
- restart;
- project close;
- component removal while stopped;
- property modification while stopped;
- property modification while running, if allowed.

For state-changing properties, specify whether they:

- apply immediately;
- require domain restart;
- require full simulation restart;
- require pin re-registration;
- are rejected while running.

## 5. Determinism

Given the same:

- project;
- initial state;
- random seed;
- simulation settings;
- external binary versions where relevant;

the simulation should produce the same logical result.

All random/noise blocks must use a simulation-seeded PRNG, never ambient OS randomness by default.

## 6. Event ordering

Events with the same timestamp require deterministic tie-breaking. Reuse the Scheduler's existing `(time, sequence)` or equivalent ordering.

Cross-domain rules must be documented. For example:

- a PLC scan samples the input image at a defined point;
- an electrical change generated at the same timestamp as a PLC scan must have deterministic before/after semantics;
- HART/Modbus protocol events at the same time must preserve byte/frame ordering;
- FPGA delta cycles must settle internally before stable external outputs are published.

## 7. Dirty propagation

Signal-domain dirty propagation should mirror the spirit of existing electrical dirty-set logic without conflating data structures.

A block should be reevaluated only when:

- an input changes;
- its discrete sample time hits;
- an internal scheduled event occurs;
- a continuous solver requires output evaluation;
- a parameter affecting outputs changes.

Avoid global reevaluation of all signal blocks at every electrical MNA iteration.

## 8. Failure isolation

A domain failure must be scoped:

- invalid Transfer Function → block diagnostic;
- algebraic loop → graph diagnostic;
- GHDL crash → FPGA component faulted;
- Modbus malformed frame → protocol diagnostic;
- PLC invalid program → PLC faulted/not started;
- an error in one external process must not terminate the Core.

## 9. Threading

Default rule:

- Scheduler/SimulationSession remains the single writer of simulation state;
- background threads may receive external data but must marshal state changes into the Scheduler-safe mechanism already used by MCU integration;
- lock ordering must be documented;
- never call Scheduler callbacks while holding a bridge mutex if that can invert the Scheduler lock order.

## 10. Tests

Required architectural tests:

- deterministic same-timestamp event ordering;
- pause freezes virtual-time behavior;
- resume continues without resetting state;
- stop/restart resets according to each domain contract;
- removing a component does not leave scheduled callbacks referencing freed memory;
- external background callback during stop is safely ignored/cancelled;
- signal-only graph executes without creating an electrical island;
- electrical-only project follows the exact previous path.

## 11. Acceptance criteria

No new domain is allowed to bypass these lifecycle/time invariants merely because its local implementation is simpler.
