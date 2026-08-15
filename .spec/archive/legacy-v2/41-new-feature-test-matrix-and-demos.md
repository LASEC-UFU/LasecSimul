# 41 — Test Matrix and Demos for Animated Process, Python and Installer

**Status:** NOT STARTED  
**Priority:** Required for feature completion  
**Depends on:** `19`, `30`–`40`  
**Related:** `21`

## 1. Goal

Define end-to-end demonstrations and regression gates for the new features.

---

## 2. Demo projects

Add:

```text
examples/
├── process-animated-transfer-function/
├── process-animated-tank-native/
├── process-animated-python-tank/
├── python-signal-block/
├── python-electrical-device/
└── installation-self-test/   # if useful as internal fixture
```

---

## 3. Demo A — animated transfer function

Topology:

```text
Step → Transfer Function (Tank visual) → Scope
```

Parameters:
```text
G(s) = 1/(5s+1)
display range 0..1
```

Acceptance:
- scope and animation agree.

---

## 4. Demo B — native tank

```text
Flow Source → Tank → Level Scope
```

Tank uses Tank visual.

Acceptance:
- mass balance test;
- visual level follows `h`.

---

## 5. Demo C — Python nonlinear tank

```text
Flow Source → Python Tank → Scope
```

Same Tank visual.

Acceptance:
- user script executes;
- visual independent from script implementation;
- reset returns defined state.

---

## 6. Demo D — Python electrical comparator

Circuit:
```text
DC source / potentiometer → Python voltage sense
Python digital driver → LED
```

Acceptance:
- threshold crossing changes LED;
- Python does not stamp MNA directly.

---

## 7. Demo E — Python process + circuit

Example custom transmitter:

```text
Temperature process signal
      ↓
Python transmitter model
      ↓
0–10 V electrical output
      ↓
voltmeter/load
```

Acceptance:
- mixed-domain bridge works.

---

## 8. Installer clean-machine matrix

For each platform:

```text
Marketplace/VSIX install
first-run prompt
download recommended
checksum verify
Core self-test
Python self-test
GHDL self-test
example run
```

---

## 9. Failure injection

Inject:
- corrupt runtime archive;
- missing asset;
- Python syntax error;
- Python infinite loop/timeout;
- Python process crash;
- unsupported electrical output;
- GHDL missing;
- no network;
- low disk;
- untrusted workspace.

Verify user-facing diagnostics.

---

## 10. Regression matrix

Must keep passing:
- existing MNA tests;
- Scheduler;
- MCU/QEMU;
- FPGA/GHDL once merged;
- subcircuits;
- save/load;
- device catalog;
- packaging;
- existing examples.

---

## 11. Performance metrics

Track:
- UI animation CPU with 1/10/50 visual blocks;
- IPC update rate;
- Python step latency;
- Python worker memory;
- setup download/extraction time only as CI diagnostics, not hard user promises.

---

## 12. Acceptance criteria

All new features have at least one runnable user example and one automated regression path before being marked `MVP DONE`.
