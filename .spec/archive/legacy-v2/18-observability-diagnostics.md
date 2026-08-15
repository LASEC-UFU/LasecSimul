# 18 — Observability, Diagnostics and Trace Infrastructure

**Status:** PLANNED  
**Priority:** Cross-cutting  
**Depends on:** current diagnostics/logging system

## 1. Goal

Make multi-domain simulations diagnosable without turning every component into a console spam source.

## 2. Diagnostic layers

### Build/configuration

- invalid block parameter;
- missing file/tool;
- VHDL compile error;
- PLC compile error;
- invalid register map.

### Runtime

- solver non-convergence;
- algebraic loop;
- PLC watchdog/fault;
- GHDL/QEMU crash;
- protocol timeout;
- HART/Modbus exception;
- binding target missing.

### Trace

High-volume optional:
- protocol frames;
- PLC scans;
- signal samples;
- solver debug;
- external bridge events.

## 3. Structured diagnostic model

Candidate:

```text
code
severity
domain
componentId
message
file?
line?
column?
timestampNs?
details?
dedupeKey?
```

Map source diagnostics into existing VS Code `DiagnosticCollection("lasecsimul")`.

## 4. Source-location support

Required for:

- GHDL;
- future ST parser/compiler;
- PLC artifact parser;
- imported configuration file.

Use real file/line/column ranges rather than `(0,0)` placeholders when tools provide them.

## 5. Runtime health states

Reusable concept may include:

```text
OK
STARTING
RUNNING
LAGGING
FAULTED
STOPPED
```

Only generalize if it maps cleanly to existing MCU health and new external devices.

## 6. Protocol trace

Each transaction can expose:

- virtual timestamp;
- protocol;
- source/destination;
- raw bytes;
- parsed summary;
- response status;
- latency.

Keep trace collection bounded/configurable.

## 7. Scope/data logging

High-rate telemetry should use:

- batching;
- ring buffers;
- decimation;
- subscription-based selection.

Do not emit one IPC JSON message per sample at high frequency if batching is possible.

## 8. Reproducibility

Runtime log header should optionally record:

- LasecSimul version/commit;
- simulation settings;
- random seed;
- GHDL/QEMU versions where relevant;
- project schema version.

Useful for bug reports.

## 9. Tests

- diagnostic dedupe;
- source range;
- runtime timestamp;
- external crash surfaces once;
- trace bounded memory;
- high-rate sample batch;
- clearing diagnostics after correction;
- project close clears relevant diagnostics.

## 10. Acceptance criteria

For every major domain fault, the user can answer:
- what failed;
- where;
- at what virtual time if relevant;
- whether simulation continued;
- how to correct it.
