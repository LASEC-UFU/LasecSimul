# 26 — Smart Instrument Parameter and Variable Model

**Status:** NOT STARTED  
**Priority:** Before multiple smart-instrument families  
**Depends on:** `02`, `07`

## 1. Goal

Define a reusable parameter/variable registry for smart instruments so HART, Modbus instruments and future protocols can expose the same underlying device state without duplicate copies.

## 2. Distinguish parameter categories

### Configuration parameter
Examples:
- tag;
- range;
- damping;
- polling address.

### Process variable
Examples:
- PV;
- SV;
- actual valve position.

### Commanded value
Examples:
- setpoint;
- output command.

### Diagnostic/status
Examples:
- sensor failure;
- write protect;
- device status.

### Derived value
Examples:
- percent range;
- loop current.

## 3. Canonical value ownership

One canonical device variable should feed:

```text
visual display
HART command response
Modbus register binding
signal output
diagnostics
```

Do not maintain independent PV copies for each protocol.

## 4. Metadata

Candidate:

```text
id
label
type
unit
access
persistence
min/max
runtimeTunable
quality
source/binding
```

## 5. Derived values

Use explicit dependency/evaluation functions.

Example:

```text
percentRange = (PV-LRV)/(URV-LRV)*100
loopCurrent = map(percentRange)
```

Ensure changing LRV/URV invalidates derived values immediately at a deterministic simulation point.

## 6. Protocol mapping

HART command fields and Modbus registers reference canonical variable IDs.

Vendor/device profiles may expose subsets.

## 7. Fault overlays

Fault injection should preferably alter sensor/output layers rather than overwrite configuration.

Example:
- true process PV;
- sensed PV with bias;
- transmitted digital PV;
- analog current.

Keeping these stages separate enables calibration/fault labs.

## 8. Tests

- one PV reflected consistently in UI/HART/Modbus;
- range change;
- write protect;
- derived current;
- fault bias affects correct stage;
- persistence categories;
- runtime write policy.

## 9. Acceptance

A single Smart Instrument variable registry can back at least HART Smart Transmitter behavior and one Modbus-bound smart device without duplicated canonical state.
