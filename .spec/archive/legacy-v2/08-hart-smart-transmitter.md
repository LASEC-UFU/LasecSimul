# 08 — HART Smart Transmitter

**Status:** NOT STARTED  
**Priority:** Instrumentation MVP after process/bridge foundation  
**Depends on:** `02`, `05`, `06`, `07`

## 1. Goal

Implement a configurable virtual **HART Smart Transmitter** that behaves like an industrial smart field instrument inside LasecSimul.

MVP focuses on:

- process variable model;
- 4–20 mA analog behavior;
- semantic HART command engine;
- device identity/configuration;
- diagnostics;
- integration with a later HART Communicator.

Physical FSK is a later milestone.

## 2. Reference implementation to study

Use `josuemoraisgh/process_simul` as **reference source code only**, especially:

- `lib/infrastructure/hart/hart_frame.dart`
- `lib/infrastructure/hart/hart_transmitter.dart`
- `lib/domain/hart/hart_command_registry.dart`
- `lib/domain/hart/hart_payload_parser.dart`
- `lib/infrastructure/hart/hart_type_converter.dart`
- `lib/data/templates/hart_commands_template.dart`
- `lib/data/templates/hart_types_template.dart`
- `lib/infrastructure/simulation/simul_tf.dart`

Do not embed Flutter/Dart and do not launch `process_simul` as a runtime dependency. Port concepts to C++20 following LasecSimul architecture.

## 3. External modes

### 3.1 Transmitter-only

```text
PV_IN ─► HART Smart Transmitter ─► LOOP+/LOOP-
```

PV comes from an external signal/process.

### 3.2 Manual

PV configured/forced from UI for protocol labs.

### 3.3 Embedded process convenience

```text
u ─► [ embedded FirstOrder/FOPDT ] ─► PV conditioning ─► transmitter
```

Use shared process models, not a separate duplicate simulator.

## 4. Variable model

At minimum expose:

- PV;
- loop current;
- percent of range;
- LRV;
- URV;
- engineering unit;
- device status;
- communication status;
- tag;
- descriptor;
- message;
- polling address;
- write protect.

Prepare for SV/TV/QV later.

## 5. Analog output

Nominal linear mapping:

\[
I_{mA}=4 + 16\frac{PV-LRV}{URV-LRV}
\]

Rules:

- validate `URV > LRV` unless device profile explicitly supports reverse action;
- clamp or alarm according to configured output policy;
- model actual electrical current through an appropriate LasecSimul source/interface;
- do not merely expose a number labelled “mA” if the block is connected electrically.

Properties:

- minimum/maximum nominal current;
- lower/upper alarm current;
- alarm direction;
- loop current enabled/multidrop behavior later.

## 6. PV conditioning

Optional:

- sensor limits;
- damping;
- zero/span;
- bias;
- clipping;
- unit/range metadata.

Damping must use Scheduler virtual time.

## 7. HART protocol engine

Candidate modules:

```text
core/src/protocols/hart/
├── HartFrame
├── HartCodec
├── HartAddress
├── HartCommandRegistry
├── HartVariableRegistry
├── HartDeviceStatus
└── HartProtocolEngine
```

Simple commands should be data-driven when practical. Custom command behavior may use handlers.

## 8. Frame semantics

Support at semantic layer:

- preamble;
- delimiter;
- short/polling address;
- long unique address;
- command;
- byte count;
- payload;
- XOR checksum;
- request/response distinction.

The `process_simul` frame implementation is useful reference, but validate behavior against the intended HART revision/specification before claiming standards compliance.

## 9. MVP commands

Prioritize common educational/useful operations:

- Read Unique Identifier;
- Read Primary Variable;
- Read Loop Current and Percent of Range;
- Read Dynamic Variables/Loop Current where supported;
- Read Tag/Descriptor/Date;
- Read sensor/range information;
- Read output information;
- Write polling address;
- Write tag/descriptor/message where supported;
- write/read LRV/URV through the appropriate command semantics;
- device status/diagnostic response.

Exact command numbers/payload layouts must be validated against the HART specification set available to the project before implementation.

## 10. Device identity

Configurable:

- manufacturer ID;
- device type;
- device ID;
- HART revision;
- hardware revision;
- software revision;
- device flags;
- requested preambles;
- final assembly number where supported.

Provide a safe Generic/Educational default profile.

## 11. Fault injection

MVP:

- PV frozen;
- PV bias;
- PV drift;
- PV noise;
- sensor failure;
- output saturation;
- fixed analog output;
- loop open (electrical behavior);
- alarm high/low;
- write protect.

Later:
- intermittent communication;
- malformed/checksum fault injection;
- device-specific statuses.

Random faults/noise must use deterministic simulation seed.

## 12. Runtime visibility

Component can display compact live data:

```text
PT-101
6.42 bar
14.27 mA
HART
```

This display is observation only, not simulation authority.

## 13. Persistence

Persist:

- identity;
- range;
- units;
- polling address;
- device profile;
- process-source mode;
- conditioning;
- fault configuration;
- public bindings.

Do not persist transient frame queues or current simulation state unless a future snapshot feature requires it.

## 14. Tests

- PV→current at 0/50/100%;
- range change changes current while PV remains constant;
- tag/identity read;
- write protect;
- polling address;
- checksum/frame parser;
- short/long address routing;
- invalid command response;
- damping virtual-time response;
- loop electrical behavior;
- sensor failure status;
- save/reopen;
- two transmitters with different addresses.

## 15. MVP demo

```text
FirstOrder Process → HART PT-101 → 4–20mA loop → Current Sensor → Scope
                          │
                          └── semantic HART communicator
```

## 16. Non-goals

- physical Bell-202 FSK in this spec;
- full vendor-specific DDL/EDD;
- WirelessHART;
- complete HART certification claim;
- external Flutter dependency.
