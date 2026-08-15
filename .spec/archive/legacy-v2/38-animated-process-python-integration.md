# 38 — Animated Process + Python Integration

**Status:** NOT STARTED  
**Priority:** After `30`, `32`, `33`  
**Depends on:** `30`, `31`, `32`, `33`  
**Related:** `06`, `21`, `41`

## 1. Goal

Allow a Python-defined process model to use the same animated process visualization infrastructure as native transfer-function/process blocks.

This demonstrates that visualization is model-independent.

---

## 2. Architecture

```text
Python Process Block
    ↓ outputs
Signal Engine
    ↓
Visualization Binding
    ↓
Tank / Heater / Flame / Gauge
```

No Python-specific renderer is allowed.

---

## 3. Example — Python Tank

Script outputs:

```text
level [m]
qout [m3/s]
```

Visualization bindings:

```text
level → tank.fill
level → value.text
qout  → outlet visual indicator (optional)
```

---

## 4. Example canvas

```text
Flow Source ─► [ Python Tank ]
                    │
                    ├──► level ─► PID/Scope
                    └──► qout

Visual:
┌────────────────┐
│      Tank      │
│  █████████     │
│  █████████     │
│  3.4 m         │
└────────────────┘
```

---

## 5. Example — Python furnace

Inputs:
- fuel command;
- ambient temperature.

Outputs:
- temperature;
- flame intensity.

Visual bindings:
```text
temperature → temperature display
flameIntensity → flameIntensity
```

---

## 6. Visual schema must not depend on code internals

Only declared Python outputs are bindable.

Forbidden:
```text
state["private_internal_variable"] accessed directly by Webview
```

unless the variable is explicitly published through a runtime state/output contract.

---

## 7. Output metadata

Python block port metadata should allow:

```text
name
type
unit
display min/max
semantic role
```

Example:

```text
level
float64
m
0..5
process.level
```

Semantic role can help UI propose a Tank binding automatically later.

---

## 8. Automatic template suggestions

Optional enhancement:

If output semantic type is:
```text
process.level
```
suggest:
```text
Tank
```

If:
```text
process.temperature
```
suggest:
```text
Thermometer / Heater
```

Suggestion is UI-only; user remains in control.

---

## 9. Fault display

If Python block faults:
- freeze visual at last valid state;
- show fault badge;
- tooltip includes Python diagnostic;
- do not keep visually animating as if healthy.

---

## 10. Acceptance criteria

A Python-defined nonlinear tank model can be displayed using the same Tank visual template used by a native transfer-function process block.
