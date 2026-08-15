# 04 — Continuous and Discrete Solvers

**Status:** NOT STARTED  
**Priority:** After Signal Engine MVP  
**Depends on:** `03-signal-engine-mvp.md`

## 1. Goal

Add stateful continuous and discrete dynamic systems suitable for control/process education.

## 2. Initial continuous blocks

- Integrator
- State Space
- Transfer Function
- Derivative with practical filtering/limitations documented
- Transport Delay
- First-order block (may live in process library but uses same solver)

## 3. Initial discrete blocks

- Unit Delay
- Zero-Order Hold
- Discrete Integrator
- Discrete Transfer Function
- Discrete PID later

## 4. Continuous model representation

Prefer converting higher-level linear blocks to a shared state-space representation:

\[
\dot{x}=Ax+Bu
\]

\[
y=Cx+Du
\]

Transfer function conversion must validate:

- denominator non-empty;
- leading coefficient non-zero;
- proper/improper numerator handling;
- numerical scaling;
- initial state.

## 5. Numerical methods

Implementation order:

1. explicit Euler — useful as baseline/test only;
2. RK2 or midpoint;
3. RK4 as first practical fixed-step method;
4. adaptive RK only after stable fixed-step integration exists.

Do not implement a stiff solver in MVP.

Solver selection should be project/session configuration or domain setting, not hard-coded per block.

## 6. Step-size policy

The continuous solver's step is constrained by:

- configured maximum step;
- next Scheduler event;
- next discrete sample hit;
- next external-domain synchronization boundary;
- known discontinuity (Step event);
- transport-delay sample requirements where applicable.

Never integrate across a known event without stopping at the event boundary.

## 7. Continuous ↔ discrete interaction

Example:

```text
Continuous Plant → ZOH/ADC → Discrete PID → held actuator → Plant
```

The ZOH samples at exact Scheduler timestamps. The held output remains constant between updates.

## 8. Initial conditions

Every stateful block must define:

- default state;
- user-configurable initial condition;
- reset behavior;
- restart behavior;
- state persistence policy (normally simulation state is not persisted in project unless explicit snapshot feature exists).

## 9. Transport delay

MVP can use timestamped history/interpolation:

- retain only history needed for maximum delay;
- support constant delay parameter;
- define interpolation mode;
- react correctly to reset.

Avoid wall-clock queues.

## 10. Derivative

Ideal derivative amplifies noise and introduces discontinuity issues. MVP should either:

- clearly label it ideal/numerical and constrain usage; or
- implement a filtered derivative parameter.

The UI/documentation must not imply physically perfect differentiators.

## 11. Algebraic loops

Phase 1:
- detect and reject unsupported algebraic loops.

Phase 2:
- solve simple scalar/multivariable algebraic loops iteratively;
- configurable tolerance and maximum iterations;
- diagnostic on non-convergence.

Do not let block ordering accidentally become the “solver”.

## 12. Process simulation reference

The `process_simul` repository contains a transfer-function → discrete state-space implementation and fixed-step Euler simulation. Treat it as a **behavioral/code reference to study**, not a runtime dependency. Port concepts selectively to C++ and improve them where needed for Scheduler integration.

## 13. Numerical diagnostics

Surface:

- NaN/Inf state;
- unstable/diverging state beyond configured limit;
- invalid coefficients;
- solver non-convergence;
- step-size underflow;
- algebraic-loop non-convergence.

## 14. Tests

Analytical comparison:

- integrator under constant input;
- first-order step response;
- second-order response;
- state-space known solution;
- transfer-function DC gain;
- discrete unit delay;
- ZOH timing;
- event at integration boundary;
- pause/resume without numerical jump;
- deterministic accelerated simulation;
- transport delay exact timing;
- invalid model diagnostics.

Use tolerances appropriate to chosen solver and step.

## 15. Acceptance criteria

A closed-loop signal-domain PID + linear plant can simulate reproducibly with configurable virtual-time step behavior, without electrical components and without using wall-clock time.
