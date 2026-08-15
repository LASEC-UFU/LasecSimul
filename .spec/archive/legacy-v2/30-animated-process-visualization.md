# 30 — Animated Process Visualization Block

**Status:** NOT STARTED  
**Priority:** High after `06-process-block-library.md` and `17-ui-ux-canvas-catalog.md`  
**Depends on:** `02`, `03`, `04`, `06`, `17`, `24`, `25`  
**Related:** `31`, `32`, `38`, `41`

## 1. Goal

Add a simple SCADA-like visual representation to process/control blocks without turning LasecSimul into a full SCADA package.

The primary use case is:

```text
Signal/Process Model
        │
        ▼
┌─────────────────────────────┐
│ Transfer Function / Process │
│                             │
│      visual: Tank           │
│      █████████  72 %        │
│                             │
└─────────────────────────────┘
        │
        ▼
      output
```

The user must be able to:

1. place a process block on the existing LasecSimul canvas;
2. configure a transfer function or another supported process model;
3. choose a simple visual representation, such as:
   - tank;
   - vessel;
   - thermometer/temperature column;
   - heater;
   - furnace;
   - flame;
   - pump/fan rotation;
   - valve position;
   - lamp/status indicator;
   - generic numeric display;
4. bind one or more model values to visual properties;
5. see the visual update while the simulation runs;
6. optionally use a project-local custom SVG;
7. save/reopen the project and preserve the visualization configuration.

The visualization MUST NOT become a second source of simulation truth. The simulation model drives the visual representation, never the reverse in the MVP.

---

## 2. Fundamental architectural rule

Separate:

```text
Simulation Model
    ↓
State / Output values
    ↓
Visualization Binding
    ↓
Renderer
```

Never implement:

```text
SVG animation
    ↓
simulation state
```

for the MVP.

This separation allows the same process dynamics to be displayed as:

- ordinary rectangular transfer-function block;
- tank;
- furnace;
- heater;
- custom project SVG;

without changing the equations.

---

## 3. Candidate component concept

Candidate name:

```text
VisualProcessBlock
```

or, if it better fits the current component architecture:

```text
TransferFunctionProcessBlock + ProcessVisualizationDescriptor
```

The agent MUST inspect the current repository before fixing class names.

Preferred composition:

```text
IComponentModel / process model
            │
            ├── model properties
            ├── signal ports
            └── runtime outputs
                    │
                    ▼
          VisualizationDescriptor
                    │
                    ▼
             Webview renderer
```

Do not add rendering code to the Core solver.

---

## 4. First MVP model

The first version SHOULD support a SISO continuous transfer function:

\[
G(s) = \frac{b_0 s^m + b_1 s^{m-1} + ... + b_m}
            {a_0 s^n + a_1 s^{n-1} + ... + a_n}
\]

Properties:

- numerator coefficients;
- denominator coefficients;
- initial output;
- optional output min/max;
- engineering unit;
- display range;
- visual template;
- visual binding source.

Example:

```text
Numerator:   [1]
Denominator: [10, 1]

G(s) = 1 / (10s + 1)
```

The existing continuous/discrete solver infrastructure from specs `03` and `04` SHOULD be reused.

Do not build a transfer-function integrator inside the Webview.

---

## 5. Recommended initial templates

### 5.1 Tank

Dynamic fields:

- liquid fill level;
- optional numeric level;
- optional inlet-flow indicator;
- optional outlet-flow indicator;
- optional alarm overlay.

Primary binding:

```text
output.y -> tank.fill
```

Mapping example:

```text
0.0 m  -> 0 %
5.0 m  -> 100 %
```

### 5.2 Temperature / thermometer

Dynamic fields:

- column height;
- numeric value;
- optional normalized visual state.

Example:

```text
20 °C  -> 0 %
120 °C -> 100 %
```

### 5.3 Heater / furnace

Dynamic fields:

- temperature display;
- flame size;
- flame opacity;
- optional heater energized indicator.

The actual thermal equation remains in the simulation model.

### 5.4 Flame

Dynamic fields:

- height/scale;
- opacity;
- on/off;
- optional deterministic visual flicker.

Flicker MUST be decorative only and MUST NOT affect simulation state.

### 5.5 Valve

Dynamic fields:

- stem position;
- opening percentage;
- optional flow text.

### 5.6 Pump / fan

Dynamic fields:

- rotation angle;
- active/inactive;
- speed-normalized visual rotation.

### 5.7 Generic gauge

Dynamic fields:

- bar fill;
- needle angle;
- numeric text;
- status state.

---

## 6. Visualization bindings

A visualization binding maps a model value to a visual channel.

Example conceptual schema:

```json
{
  "source": "output.y",
  "target": "tank.fill",
  "transform": {
    "inputMin": 0.0,
    "inputMax": 5.0,
    "outputMin": 0.0,
    "outputMax": 1.0,
    "clamp": true
  }
}
```

Supported source candidates:

- component output port;
- component internal published state;
- component property only if explicitly marked runtime-readable;
- signal binding.

Do not allow arbitrary JavaScript expressions.

---

## 7. Built-in animation channels

The MVP renderer SHOULD understand a limited set of semantic animation channels:

```text
fill
height
width
translateX
translateY
rotation
scale
opacity
visibility
text
needleAngle
liquidLevel
flameIntensity
valvePosition
rotationSpeed
statusClass
```

The exact renderer implementation may translate these semantic channels into SVG/CSS transforms.

---

## 8. Numeric mapping

Every continuous visual binding SHOULD support:

- input min;
- input max;
- output min;
- output max;
- clamp;
- invert;
- optional deadband;
- optional smoothing for visual rendering only.

Visual smoothing MUST NOT alter the simulation value.

Example:

```text
simulation level = 3.5 m
display range    = 0..5 m
normalized       = 0.70
tank fill        = 70 %
```

---

## 9. Runtime data flow

Recommended:

```text
Core simulation
   ↓
runtime value notification / existing telemetry path
   ↓
Extension state cache
   ↓
batched/throttled Webview update
   ↓
SVG renderer
```

Requirements:

- do not send one IPC message for every SVG frame;
- do not repaint at the solver frequency;
- UI update frequency configurable/capped;
- suggested default visual refresh: 20–30 FPS maximum;
- simulation may run much faster/slower than wall time;
- renderer displays latest sampled state;
- UI must not backpressure the Scheduler.

---

## 10. Simulation time vs animation time

Distinguish:

```text
simulation time
wall-clock/UI frame time
```

The animation is a visualization of simulation state.

For state-derived graphics such as tank level:
- use latest simulated value.

For decorative animation such as flame flicker or pump rotation:
- base the deterministic phase on simulation time when practical;
- otherwise use UI time only if it is explicitly decorative.

Never use decorative UI time to advance a physical/process equation.

---

## 11. Interaction policy

MVP:
- visualization is read-only during RUN;
- component remains selectable/movable;
- double-click opens properties;
- right-click offers visual settings.

Future:
- SCADA-style clickable controls;
- setpoint entry;
- operator pushbuttons;
- HMI screen designer.

Those future interactions SHOULD use explicit signal bindings, not hidden mutation of process state.

---

## 12. Property panel proposal

Example:

```text
Model
  Type: Transfer Function
  Numerator:   1
  Denominator: 10, 1
  Initial value: 0
  Output unit: m

Visualization
  Template: Tank
  Animated value: Output Y
  Display min: 0
  Display max: 5
  Unit label: m
  Show numeric value: yes
  Show name: yes

Rendering
  Refresh limit: Automatic
  Clamp visual range: yes
```

---

## 13. Component size and layout

The visual process block SHOULD support:

- predefined size;
- resize handles if current canvas architecture permits;
- min/max dimensions;
- aspect-ratio lock for templates where necessary;
- pin positions independent from SVG internal geometry;
- labels and signal ports outside the animated area.

Pins MUST remain stable when the visual template changes whenever possible.

---

## 14. Save/load

Project persistence must include:

- selected model;
- model parameters;
- selected visual template;
- visual bindings;
- custom asset reference if used;
- size/layout;
- display range;
- numeric label configuration.

Prefer project-relative paths for project-owned custom assets.

---

## 15. Fault behavior

If the visualization asset fails:
- simulation MUST continue;
- show generic fallback block;
- surface a non-fatal diagnostic.

If the simulation model fails:
- visual block shows fault badge;
- animation freezes or displays last valid value;
- do not hide the simulation fault.

---

## 16. Scope boundaries

MVP explicitly excludes:

- full SCADA screen editor;
- alarms historian;
- OPC UA;
- remote HMI deployment;
- arbitrary HTML/JavaScript inside user process visuals;
- scriptable SVG;
- animation controlling the physics;
- 3D rendering.

---

## 17. Tests

Unit:
- normalization;
- clamp;
- inverted ranges;
- multiple bindings;
- invalid range handling;
- serialization.

UI:
- tank fill tracks value;
- thermometer tracks value;
- flame on/off tracks value;
- valve position tracks command;
- change template without changing model state;
- project reopen restores bindings.

Regression:
- nonvisual transfer-function block still works;
- UI refresh never changes solver result;
- paused simulation stops state changes;
- zoom/pan does not corrupt animation.

---

## 18. Acceptance demo A — transfer-function tank

```text
Step ─► [ G(s)=1/(10s+1), visual=Tank ] ─► Scope
```

Expected:
- output follows first-order response;
- tank liquid level follows output;
- numeric value and scope agree.

---

## 19. Acceptance demo B — temperature

```text
Step ─► [ Thermal TF, visual=Heater ] ─► Temperature display
```

Expected:
- temperature rises smoothly;
- visual temperature channel follows output;
- heater/flame visualization can represent the same value or a second input.

---

## 20. Acceptance criteria

This spec is accepted when a user can place one transfer-function process block, choose `Tank`, configure `G(s)`, run the simulation, and visually observe tank level moving consistently with the actual simulated output, with no physics implemented in the Webview.
## 21. Resource-profile rendering

The visual refresh rate is controlled by `ResourceGovernor`.

Typical intent:
- PersonalDesktop: up to normal 20–30 FPS cap;
- SharedHost: approximately 10–15 FPS by default, benchmark-adjusted;
- Automatic: policy-selected.

The renderer always displays latest available simulated state.

A lower visualization FPS MUST NOT:
- change transfer-function integration;
- change Tank equations;
- skip PLC scans;
- change protocol events.

Decorative flame/pump effects may be reduced or disabled under conservative resource policy.
