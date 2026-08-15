# 33 — Python Electrical and Process I/O Bridge

**Status:** NOT STARTED  
**Priority:** After `32` signal-domain MVP  
**Depends on:** `05`, `24`, `32`  
**Related:** `03`, `18`, `34`

## 1. Goal

Define exactly how Python interacts with both process signals and electrical circuits.

The critical principle is that Python code expresses behavior, while the native Core preserves electrical solver ownership.

---

## 2. Two I/O families

### Process/signal

```text
Signal source
    ↓ typed value
Python Signal Block
    ↓ typed value
Signal sink
```

### Electrical

```text
Circuit node voltage/current observation
    ↓ sampled values
Python Electrical Device
    ↓ requested drive state
Native electrical adapter
    ↓ MNA stamps
Circuit
```

---

## 3. Electrical input types

MVP supported observations:

### Voltage input

Two-terminal differential:

```text
V = V(pin+) - V(pin-)
```

or single-ended against reference/ground.

### Digital sense input

Native Core converts voltage using configured thresholds:

```text
LOW / HIGH
```

Optional hysteresis.

Python receives logical value, not raw threshold logic implementation.

### Current observation

Only when existing component architecture can safely provide a defined branch current.

Do not invent fragile current probing in MVP if infrastructure does not support it.

---

## 4. Electrical output modes

The Python block may request one of a limited set of output models.

### 4.1 Voltage driver

Python output:

```json
{
  "mode": "voltage",
  "value": 3.3,
  "seriesResistance": 10.0
}
```

Core stamps an appropriate Thevenin-like/voltage-source model using existing facilities.

### 4.2 Current driver

Python output:

```json
{
  "mode": "current",
  "value": 0.012
}
```

Core stamps current source.

### 4.3 Conductance/resistance

Python output:

```json
{
  "mode": "resistance",
  "value": 1000.0
}
```

or conductance equivalent.

### 4.4 Digital driver

Python output:

```text
LOW
HIGH
Z
```

Core translates:
- LOW → configured electrical low drive;
- HIGH → configured electrical high drive;
- Z → high impedance.

Reuse existing digital electrical behavior where possible.

---

## 5. No direct matrix access

Forbidden Python APIs:

```text
solver.matrix
solver.setNodeVoltage(...)
netlist.nodes[]
stamp(...)
```

The native bridge validates all outputs before they reach the solver.

---

## 6. Sampled electrical behavior

Python execution is discrete.

Recommended sequence at a scheduled Python tick:

```text
1. Core has a converged electrical state.
2. Native Python device samples configured electrical inputs.
3. Inputs are sent to Python worker.
4. Python computes next outputs.
5. Returned outputs update native device state.
6. Component marks simulation dirty / schedules required settle.
7. Native stamp() represents new drive on next electrical settle.
```

This matches the existing Core ownership model better than executing Python inside MNA iterations.

---

## 7. Algebraic loops

A Python electrical device MUST be treated as a sampled external/discrete element in the MVP.

Example problematic loop:

```text
node voltage → Python → ideal voltage source → same node
```

Do not attempt iterative Python/MNA co-solution initially.

If user creates such topology:
- behavior follows the block's sample/hold semantics;
- document one-sample delay/effective discrete behavior.

---

## 8. Sample period

Properties:

```text
samplePeriod
initialOutput
inputSampling
safeOutputOnFault
```

Provide sensible unit-aware UI.

The Core scheduler remains the source of simulation time.

---

## 9. Electrical input schema example

```json
{
  "inputs": [
    {
      "name": "vin",
      "kind": "electrical-voltage",
      "positivePin": "VIN+",
      "negativePin": "VIN-",
      "unit": "V"
    }
  ]
}
```

Actual storage should follow current LasecSimul schema conventions.

---

## 10. Electrical output schema example

```json
{
  "outputs": [
    {
      "name": "vout",
      "kind": "electrical-voltage-driver",
      "pinPositive": "OUT",
      "pinNegative": "GND",
      "defaultSeriesResistance": 10.0
    }
  ]
}
```

---

## 11. Mixed-domain Python device

Future/optional:

A single Python script may have:
- signal inputs;
- signal outputs;
- electrical sensed inputs;
- electrical driven outputs.

Example custom transmitter:

```text
Process temperature ─► Python
                      │
                      ├──► 4–20 mA electrical output
                      └──► alarm signal
```

MVP can implement the same backend even if UI exposes separate palette variants first.

---

## 12. Example — comparator

Python receives sampled voltage:

```python
def step(ctx, inputs, state):
    high = inputs["vin"] > 2.5
    return {
        "outputs": {
            "dout": "HIGH" if high else "LOW"
        },
        "state": state
    }
```

Core maps to electrical driver.

---

## 13. Example — custom sensor

```text
Process temperature signal
        ↓
Python mixed-domain model
        ↓
electrical 0–10 V output
```

Python:

```python
def step(ctx, inputs, state):
    t = inputs["temperature"]
    v = max(0.0, min(10.0, (t / 100.0) * 10.0))
    return {
        "outputs": {
            "voltageOut": {
                "mode": "voltage",
                "value": v
            }
        },
        "state": state
    }
```

---

## 14. Validation

Native bridge MUST reject:
- NaN;
- Inf;
- negative resistance if unsupported;
- out-of-range drive mode;
- unknown output;
- wrong type;
- malformed dictionary;
- missing required field.

Diagnostics must identify:
- component ID;
- script file;
- output name;
- invalid value.

---

## 15. Safe fault state

Per output configure:

```text
hold-last
zero
high-z
configured-safe-value
```

MVP recommended defaults:
- digital electrical → Z;
- voltage/current electrical → zero drive or high impedance where implementation permits;
- process signal → last valid value OR stop simulation based on global policy.

For educational determinism, defaulting to stop/pause with clear error is acceptable.

---

## 16. Tests

Electrical:
- sample known voltage;
- digital threshold;
- drive voltage;
- drive current;
- high-Z;
- fault safe state;
- reset.

Process:
- float/bool/int ports;
- unit validation;
- sample timing;
- mixed signal + electrical bridge.

Regression:
- no Python can corrupt solver memory;
- worker crash does not crash Core;
- MNA behavior unchanged when Python blocks absent.

---

## 17. Acceptance criteria

Python can observe circuit state and request safe native electrical drives while all matrix stamping remains native, validated, and deterministic relative to the Scheduler.
