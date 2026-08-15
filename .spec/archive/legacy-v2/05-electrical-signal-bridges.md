# 05 — Electrical ↔ Signal Domain Bridges

**Status:** NOT STARTED  
**Priority:** Critical unification milestone  
**Depends on:** `03`, preferably `04`

## 1. Goal

Allow signal/control/process diagrams and electrical circuits to interact explicitly and causally.

## 2. Initial adapters

### Electrical → signal

- Voltage Sensor
- Current Sensor
- Digital Level Sensor
- optional Power Sensor later

### Signal → electrical

- Controlled Voltage Source
- Controlled Current Source
- Controlled Digital Driver
- later PWM/DAC interfaces

## 3. Electrical sensor semantics

A Voltage Sensor must:

- expose electrical terminals appropriate to the measurement;
- read solved MNA voltage, not a stale UI value;
- publish a signal value after the electrical solution is stable for the current timestamp;
- avoid loading the circuit ideally, or model configurable finite input impedance if desired.

A Current Sensor must use a solver-compatible current-measurement method and not “estimate” current from unrelated data.

## 4. Controlled source semantics

A Controlled Voltage/Current Source:

- receives a signal-domain value;
- stamps the equivalent source into MNA;
- marks the electrical island dirty when its commanded value changes;
- clamps/limits only if explicit parameters say so.

## 5. Cross-domain settle

Example loop:

```text
Electrical → Voltage Sensor → Gain → Controlled Voltage Source → Electrical
```

This creates a same-time feedback loop.

MVP policy:

- detect unsupported instantaneous cross-domain algebraic loop; or
- perform a bounded settle iteration only if architecture safely supports it.

The policy must be explicit and tested. Never depend on incidental callback order.

## 6. Digital bridge

Electrical digital levels in current LasecSimul are voltage-based. Do not introduce a new global symbolic logic model just for bridges.

A Digital Level Sensor should expose configurable thresholds/hysteresis if needed, with defaults consistent with existing devices.

A Controlled Digital Driver should electrically stamp low/high/high-Z behavior using existing conductance conventions where applicable.

## 7. ADC/DAC future extension

Do not make first adapters secretly implement a full ADC/DAC. Later dedicated blocks may add:

- quantization;
- reference voltage;
- resolution;
- sampling time;
- conversion delay;
- saturation;
- signed/unsigned coding;
- noise/offset.

## 8. Units

- Voltage sensor output default unit: V.
- Current sensor: A.
- Controlled voltage input expects compatible voltage unit.
- Controlled current input expects compatible current unit.

## 9. UI

Electrical terminals and signal ports must be visibly distinguishable on the same block when mixed.

Example:

```text
        Voltage Sensor
   + o──┐
        │ [ V ] ─────► v
   - o──┘
```

## 10. Tests

- DC voltage measurement;
- transient measurement;
- current measurement;
- signal step drives controlled source at correct timestamp;
- pause/resume;
- no phantom loading for ideal sensor;
- dynamic source marks MNA dirty;
- domain-loop diagnostic;
- save/reopen mixed topology;
- existing MNA regression.

## 11. Acceptance criteria

Demonstrate:

```text
Sine signal → Controlled Voltage Source → RC circuit → Voltage Sensor → Scope
```

with the Scope showing the physically filtered RC response.
