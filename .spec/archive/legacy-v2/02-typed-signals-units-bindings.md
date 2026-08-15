# 02 — Typed Signals, Units and Bindings

**Status:** PLANNED  
**Priority:** Foundation for signal/process/PLC/protocol integration  
**Depends on:** `00`, `01`

## 1. Goal

Create a typed signal/value model that is expressive enough for control/process blocks, PLC integration and protocol register bindings without prematurely building a full symbolic type system.

## 2. MVP value types

At minimum:

```text
Bool
Int32
UInt32
Int64
UInt64
Real64
String       (configuration/protocol use; not necessarily high-rate signal)
RealVector   (bounded/dynamic vector for future buses)
```

Potential later types:

```text
Complex
Matrix
Enum
BitVector
ByteArray
Struct/Bus
```

Do not use `std::variant` or a custom tagged union blindly if an existing Core value/property type already satisfies the need. Inspect first.

## 3. Signal port metadata

Candidate model:

```cpp
struct SignalPortSpec {
    std::string id;           // stable persistence id
    std::string label;
    SignalDirection direction;
    SignalDataType type;
    UnitSpec unit;
    std::optional<size_t> width;
};
```

Important:

- port IDs must remain stable across visual regeneration;
- labels may change without breaking topology;
- vector width changes must have explicit topology migration behavior;
- type incompatibility must be diagnosed at connect time when possible.

## 4. Units

MVP units should be metadata plus compatibility/conversion for a curated engineering set, not a full computer algebra system.

Suggested dimensions:

- dimensionless / percent;
- voltage;
- current;
- resistance;
- time;
- frequency;
- pressure;
- temperature;
- length/level;
- flow;
- rotational speed;
- mass;
- angle.

Examples:

```text
V, mV
A, mA
s, ms
Hz
Pa, kPa, MPa, bar, psi
°C, K
m, cm, mm
%, 1
rpm
m³/h, L/min
```

Rules:

- units are optional;
- compatible units may auto-convert if the conversion is unambiguous;
- incompatible units should warn or reject based on strictness setting;
- affine units (°C ↔ K) require explicit offset handling;
- protocol raw register values may have scale/offset independent of physical unit conversion.

## 5. Signal line semantics

A signal line is:

- directed;
- one logical source to one or more sinks;
- typed;
- timestamped logically by the simulation step/event;
- not an electrical node;
- optionally carries quality/status metadata later.

MVP may enforce one producer. Multi-producer resolution is deferred.

## 6. Binding model

Protocols and instruments need to bind external/register values to internal simulation values.

Candidate:

```cpp
struct ValueBinding {
    BindingTargetKind kind;
    std::string targetId;     // stable component/block/variable id
    std::string portOrPath;   // e.g. "output", "Level", "PID.Kp"
    BindingMode mode;         // read, write, read-write
    Conversion conversion;
};
```

Supported initial target kinds:

- constant/static value;
- signal;
- process variable;
- block parameter explicitly marked runtime-writable;
- PLC variable;
- smart-instrument variable.

Do not expose arbitrary internal C++ fields through string reflection.

## 7. Conversion

Register/instrument bindings may require:

```text
engineering = raw * scale + offset
```

and type/byte conversion separately.

Keep these layers distinct:

1. transport representation;
2. protocol data type;
3. scaling/offset;
4. engineering unit;
5. simulation signal type.

## 8. Quality metadata

Design room for future:

```text
GOOD
UNCERTAIN
BAD
STALE
SIMULATED
FORCED
```

MVP need not propagate quality through all blocks, but HART/PLC/SCADA work will benefit from a future quality bitset. Do not bake `double` as the only signal representation.

## 9. Runtime-writable parameters

Every block parameter must declare:

- configuration-only;
- runtime-tunable;
- state-resetting;
- topology-affecting;
- pin-count-affecting.

A Modbus write to a parameter must respect the same policy as editing it in UI.

## 10. Persistence

Signal and binding data must use stable IDs. Never persist pointers, array indexes that can reorder, or display labels as topology identity.

## 11. Tests

- all MVP type round-trips;
- compatible unit conversion;
- incompatible-unit rejection/warning;
- scale+offset conversion;
- one source → multiple sinks;
- save/reopen preserves port IDs;
- deleting bound target invalidates binding cleanly;
- protocol write to non-writable parameter returns appropriate error;
- vector width mismatch diagnostic.

## 12. Non-goals

- full Modelica unit inference;
- symbolic dimensional analysis;
- unrestricted reflection;
- arbitrary nested structs in first MVP.
