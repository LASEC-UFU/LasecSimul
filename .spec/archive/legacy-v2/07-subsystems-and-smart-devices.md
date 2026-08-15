# 07 — Hybrid Subsystems and Smart Devices

**Status:** NOT STARTED  
**Priority:** Foundation for HART/PLC packaged devices  
**Depends on:** current subcircuit system, `02`–`06`

## 1. Goal

Evolve the existing subcircuit concept into a generalized **Subsystem** capable of encapsulating electrical and signal/process contents while preserving compatibility with existing `.lssubcircuit` behavior.

Also define a specialization called **Smart Instrument / Smart Device** for packaged industrial devices with runtime configuration, diagnostics and protocol engines.

## 2. Do not rewrite subcircuits

First inspect:

- `.lssubcircuit` schema;
- subcircuit editor;
- interface tunnel/pin model;
- generic symbol/package generation;
- palette registration;
- persistence and migration.

Prefer schema extension/versioning or composition over a second parallel editor.

## 3. Generalized Subsystem concept

A Subsystem may contain:

- electrical components/wires;
- signal blocks/lines;
- domain adapters;
- process models;
- protocol endpoints;
- MCU/FPGA components where technically valid;
- nested subsystems with recursion guards.

External interface may expose different port kinds.

Candidate:

```text
SubsystemPort
├── Electrical
├── SignalIn
├── SignalOut
└── Protocol/Bus (future)
```

## 4. WYSIWYG interface

Reuse existing movable tunnel/interface-pin behavior and generic symbol generation.

Requirements:

- stable external pin IDs;
- regenerate visual package without breaking topology;
- explicit port ordering;
- user-editable labels;
- signal direction indicated visually;
- mixed-domain port styles.

## 5. Smart Device specialization

A Smart Device adds metadata and runtime services:

```text
SmartDevice
├── subsystem contents
├── device identity
├── runtime parameters
├── diagnostics/status
├── protocol engines
├── variable registry
└── optional profile/template
```

It is a specialization, not necessarily a C++ inheritance tree.

## 6. HART Smart Transmitter use case

External:

```text
       PT-101
   ┌────────────┐
PV ►│ HART Smart│
   │Transmitter │
   └────┬───┬───┘
      LOOP+ LOOP-
```

Internal:

```text
PV → scaling/damping → variable registry
                      ├→ 4–20mA output
                      └→ HART Device Engine
```

Optional embedded process sits before PV conditioning.

## 7. Virtual VFD use case

```text
Modbus registers → command/parameters → Motor Process Model
Motor state → status/speed/current → Modbus registers
```

The same subsystem foundation should support both HART transmitter and Modbus VFD without hardcoding either into the editor.

## 8. Encapsulation boundaries

A subsystem must explicitly define which internal values can be externally bound/configured.

No arbitrary access to all internal block fields.

Candidate export categories:

- public parameter;
- runtime variable;
- diagnostic;
- protocol-bound variable;
- visual-only metadata.

## 9. Profile/template format

Do not immediately invent many new file extensions.

Evaluate:

1. extend `.lssubcircuit` with typed metadata;
2. use `.lsdevice` to package a smart subsystem;
3. only introduce `.lshart`/`.lsinstrument` if a strong persistence boundary exists.

Follow the project single-file principle and avoid duplicated catalog/config state.

## 10. Runtime lifecycle

On start:

1. instantiate internal graph/components;
2. resolve bindings;
3. initialize variable registry;
4. initialize protocol engine;
5. initialize embedded process if enabled;
6. stamp/evaluate external interfaces.

On stop/restart:
- cancel all scheduled callbacks;
- reset states according to project semantics;
- preserve configuration, not transient runtime state.

## 11. Tests

- mixed subsystem save/reopen;
- electrical + signal internal topology;
- external signal port;
- external electrical port;
- nested subsystem;
- stable pin IDs after symbol regeneration;
- broken binding diagnostic;
- deleting internal exported target;
- palette packaging;
- backward-load old `.lssubcircuit`.

## 12. Acceptance criteria

A hybrid subsystem can encapsulate at least one signal block and one electrical-domain adapter and appear externally as one component with stable ports.
