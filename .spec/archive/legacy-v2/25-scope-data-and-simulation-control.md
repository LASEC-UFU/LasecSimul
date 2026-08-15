# 25 — Scope, Data Acquisition and Simulation Control

**Status:** NOT STARTED  
**Priority:** Early signal-engine UX  
**Depends on:** `03`, existing simulation commands

## 1. Goal

Provide reliable observation of signal/process/electrical values without making visualization control numerical simulation.

## 2. Sampling vs rendering

Distinguish:

- simulation sample/event timestamps;
- acquisition subscription;
- IPC batching;
- render frame rate.

A 60 Hz Webview repaint must not imply a 16.67 ms simulation step.

## 3. Scope sources

Initial:
- signal port;
- electrical Voltage Sensor output;
- electrical Current Sensor output.

Later:
- PLC variable;
- HART variable;
- Modbus decoded register;
- protocol event marker.

## 4. Acquisition

Core maintains bounded acquisition buffers per active subscription or a shared efficient recorder.

Each sample:

```text
timestampNs
value
quality optional
```

Batch over IPC.

## 5. Decimation

Rendering may use:
- min/max bucket;
- point thinning;
- visible-range downsampling.

Never discard simulation events needed by other components just because plot is decimated.

## 6. Trigger

Later:
- rising/falling threshold;
- single/continuous;
- pre-trigger history.

## 7. Simulation controls

Existing controls remain authoritative:
- Run;
- Pause;
- Resume;
- Stop;
- Step.

Future speed controls:
- as-fast-as-possible;
- real-time paced;
- slower/faster factor.

Real-time pacing is optional presentation/orchestration; virtual timestamps remain truth.

## 8. Export

Later CSV:
- explicit timestamp unit;
- signal names;
- units;
- simulation metadata.

## 9. Tests

- timestamp monotonicity;
- pause stops new simulated samples;
- restart resets acquisition per policy;
- high-rate batching;
- bounded memory;
- UI decimation does not alter source value sequence.

## 10. Acceptance

Signal/process examples can be quantitatively inspected and compared without coupling solver step to Webview redraw.
## SharedHost performance policy

Scope storage/rendering is governed by `ResourceGovernor`.

Requirements:
- ring/bounded history;
- viewport-aware decimation;
- batched telemetry;
- UI receives far fewer points than raw solver production rate when appropriate;
- reducing rendered points/FPS must not alter simulation state;
- protocol/log windows also remain bounded.

See specs `43`, `44`, `46`.
