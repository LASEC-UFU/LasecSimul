# 12 — Generic PLC Runtime and Scan Cycle

**Status:** NOT STARTED  
**Priority:** Major future domain  
**Depends on:** `02`, `03`, `05`; Modbus optional

## 1. Goal

Implement a generic educational PLC block with realistic scan semantics, dynamic I/O and a runtime independent of any one graphical/textual IEC language.

## 2. External block

```text
       PLC-1
 ┌────────────────┐
I0│                │Q0
I1│ Generic PLC    │Q1
  │                │
AI0                │AO0
 └────────────────┘
```

Double-click opens the PLC project/program interface.

## 3. Scan cycle

The runtime must model:

1. **Read Inputs** into input image;
2. **Execute Program** against stable input image;
3. **Update Outputs** from output image;
4. **Communication/housekeeping** if modeled;
5. schedule next scan.

Configurable:

- scan period;
- startup delay;
- watchdog later.

All times are Scheduler virtual time.

## 4. Input image/output image

During program execution:

- direct physical input changes do not unpredictably mutate the input image halfway through the scan;
- program writes target the output image;
- physical outputs update at the defined output phase.

If direct/peripheral I/O instructions are later supported, make them explicit exceptions.

## 5. Generic PLC memory

Initial variable areas:

- BOOL;
- INT/DINT;
- UINT/UDINT;
- REAL;
- timer/counter instances.

Names are primary. Optional address-style aliases can be supported for education.

Avoid copying proprietary vendor memory addressing as the canonical model.

## 6. Timers and counters

At minimum:

- TON;
- TOF;
- TP;
- CTU;
- CTD;
- R_TRIG;
- F_TRIG.

Timer elapsed time derives from virtual timestamps, not number of scans alone and not wall-clock time.

Define edge cases:

- scan larger than preset time;
- pause;
- reset;
- preset changed at runtime;
- input toggles between scans.

## 7. Digital input electrical interface

Configurable per channel/group:

- nominal voltage;
- ON threshold;
- OFF threshold/hysteresis;
- input impedance;
- inversion;
- debounce/filter time later.

The runtime sees BOOL after the electrical interface.

## 8. Digital outputs

Configurable types later:

- logic/ideal;
- relay;
- PNP;
- NPN.

MVP can start with an ideal educational digital interface if clearly labelled, then add electrical models.

## 9. Analog inputs

Modes:

- 0–10 V;
- ±10 V later;
- 4–20 mA;
- raw signal-domain input for fast process simulation.

Parameters:

- range;
- resolution;
- scaling;
- clipping;
- sample/conversion time;
- fault values.

Analog output similarly.

## 10. Dynamic I/O

PLC properties:

```text
Digital Inputs
Digital Outputs
Analog Inputs
Analog Outputs
```

Changing counts must reuse existing pin re-registration semantics if compatible.

Stable channel IDs are required to avoid silently rewiring topology.

## 11. Program runtime

Do not tie runtime directly to Ladder AST.

Preferred pipeline:

```text
LD / ST / FBD / SFC
        │
        ▼
      PLC IR
        │
        ▼
   PLC Runtime
```

The runtime executes IR/data structures representing operations, variables and standard function blocks.

## 12. Modbus integration

Later PLC communication can include:

- Modbus Client instructions/services;
- Modbus Server memory mapping;
- communications update phase.

Do not require Modbus to complete basic PLC scan MVP.

## 13. Persistence

Candidate `.lsplc` project artifact may contain:

- schema version;
- PLC configuration;
- variables;
- I/O channels;
- POUs;
- tasks;
- programs;
- language/source representation;
- compiled IR cache optional but never sole source of truth.

Before adding extension, inspect project artifact conventions.

## 14. Tests

- input sampled once per scan;
- output updates after program phase;
- 10 ms scan exact timestamps;
- pause/resume;
- scan-time change policy;
- TON timing;
- edge trigger;
- counter;
- electrical threshold behavior;
- analog scaling;
- dynamic I/O save/reopen;
- invalid program refuses to start PLC but not whole Core;
- two PLC instances independent.

## 15. MVP acceptance

A Generic PLC runs a simple internally supplied IR program such as:

```text
Q0 := I0 AND NOT I1
```

with configurable virtual scan time and real LasecSimul I/O channels, before the Ladder editor is implemented.
