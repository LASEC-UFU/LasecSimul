# 06 — Process Block Library

**Status:** NOT STARTED  
**Priority:** After signal/solver foundation  
**Depends on:** `02`, `03`, `04`

## 1. Goal

Provide reusable industrial-process models that make LasecSimul useful for control and instrumentation education without embedding every process model inside smart instruments.

## 2. Library levels

### Level A — generic dynamics

- Gain
- First Order
- FOPDT
- Second Order
- Integrator process
- Dead Time
- Static nonlinear curve
- Noise / disturbance
- Profile/table source

### Level B — process equipment abstractions

- Tank
- Control Valve
- Pump
- Pipe / flow restriction
- Heater / simple thermal process
- Heat exchanger simplified model

Start with Level A plus Tank and Valve.

## 3. First-order model

\[
\tau \dot{y} + y = K u
\]

Properties:

- gain `K`;
- time constant `tau`;
- initial output;
- output min/max;
- optional bias.

## 4. FOPDT

\[
G(s)=\frac{K e^{-Ls}}{\tau s+1}
\]

Properties:

- `K`;
- `tau`;
- dead time `L`;
- initial value;
- limits.

Reuse the shared delay implementation rather than creating a process-only wall-clock queue.

## 5. Tank model

Initial single-tank equation:

\[
A\frac{dh}{dt}=q_{in}-q_{out}
\]

Configurable outlet options:

- externally supplied `q_out`;
- linear resistance;
- gravity outflow \(q=C\sqrt{h}\).

Ports:

```text
qin ─► [ Tank ] ─► level
       [      ] ─► qout
```

Properties:

- cross-sectional area;
- initial level;
- min/max level;
- outlet coefficient/model;
- overflow policy.

## 6. Valve model

Signal-domain valve model:

Inputs:
- command 0–100%.

Outputs:
- position;
- flow coefficient / resulting flow depending on selected abstraction.

Properties:
- `Cv`/gain abstraction;
- equal-percentage / linear characteristic;
- travel time;
- deadband;
- stiction option later;
- fail position;
- limits.

Separate the process valve model from an electrical actuator/positioner. Hybrid subsystems may combine them later.

## 7. Disturbances and faults

Every process example should support disturbances through explicit inputs rather than hidden random changes.

Optional reusable blocks:

- bias;
- noise;
- drift;
- step disturbance;
- saturation;
- rate limiter.

## 8. Process variable metadata

Process signals should carry:

- engineering unit;
- optional min/max;
- semantic label;
- optional quality later.

Examples:
`Level [m]`, `Pressure [bar]`, `Flow [m³/h]`, `Temperature [°C]`.

## 9. Embedded model policy

Smart instruments may offer an “Embedded Process” convenience mode, but the canonical process models live in this library so:

- they can be used without HART;
- they can be combined;
- models are tested once;
- instruments remain focused on measurement/output/protocol behavior.

## 10. Tests

- analytical first-order step;
- FOPDT delay;
- tank mass balance;
- tank overflow/empty limit;
- valve characteristic;
- disturbance propagation;
- unit compatibility;
- solver-step independence within tolerance;
- reset initial state.

## 11. Demo

```text
Step → Valve → Tank → Level → Scope
```

Then closed loop:

```text
SP → PID → Valve → Tank → Level ─┐
 ↑                               │
 └───────────────────────────────┘
```

## 12. Acceptance criteria

A user can build and tune a basic level-control loop entirely inside LasecSimul's signal/process domain, with deterministic virtual-time dynamics.
