# 27 — `process_simul` Reference-Code Porting Guide

**Status:** PLANNED / reference-only  
**Purpose:** identify reusable concepts without creating a runtime dependency

## 1. Source repository

Reference:
`josuemoraisgh/process_simul`

The repository is useful because it already contains HART framing, command dispatch, type conversion, command/type seed tables and transfer-function simulation.

The goal is to **study and port concepts**, not copy the Flutter application architecture into LasecSimul.

## 2. Files to inspect

### HART frame

`lib/infrastructure/hart/hart_frame.dart`

Concepts:
- preamble;
- delimiter;
- short/long address;
- command;
- byte count;
- payload;
- XOR checksum;
- streaming decoder;
- bounded frame length.

Port target:
- C++ value type/parser/encoder with robust bounds checks and tests.

### HART transmitter

`lib/infrastructure/hart/hart_transmitter.dart`

Concepts:
- command dispatch;
- device variable map;
- write callbacks;
- command-specific handlers.

Port target:
- `HartProtocolEngine` + command registry/handlers.

Improvement:
- avoid one giant switch for declarative commands when a command table can describe response/write fields.

### HART command registry

`lib/domain/hart/hart_command_registry.dart`

Study extensibility pattern and command-handler ownership.

### Payload/type conversion

`lib/domain/hart/hart_payload_parser.dart`
`lib/infrastructure/hart/hart_type_converter.dart`

Port only formats required by verified HART commands.

### HART command template

`lib/data/templates/hart_commands_template.dart`

Useful concept:
```text
command
description
request fields
response fields
write fields
```

Validate every supported production definition against the intended HART specification rather than assuming the seed table is normative.

### HART type template

`lib/data/templates/hart_types_template.dart`

Useful reference for:
- primitive types;
- engineering-unit codes;
- manufacturer/device codes;
- alarm/write-protect enums.

Treat as seed/reference, not unquestioned authoritative standard.

### HART communication

`lib/infrastructure/hart/hart_comm.dart`

Concepts:
- route by polling address;
- route by unique long address;
- frame→device dispatch;
- response framing.

Do not port Dart socket server architecture directly into Scheduler semantic transport.

### Transfer-function simulation

`lib/infrastructure/simulation/simul_tf.dart`

Concepts:
- transfer function specification;
- state-space conversion;
- state update.

Do not port:
- `Timer.periodic` simulation timing;
- fixed UI/application timer as numerical authority.

In LasecSimul:
- use shared Continuous/Discrete solver;
- Scheduler time;
- process block registry.

## 3. What not to port

- Flutter UI;
- Riverpod/notifier/application-state model;
- SQLite merely because reference app uses it;
- Dart `Timer.periodic` simulation loop;
- TCP server as the only HART transport;
- raw hex string as canonical internal engineering value;
- giant command switch if data-driven mapping is sufficient.

## 4. Porting sequence

1. write tests for desired HART frame behavior;
2. implement C++ frame codec;
3. implement canonical Smart Instrument variable registry;
4. implement type conversion for required commands;
5. implement command registry;
6. implement semantic endpoint;
7. connect Smart Transmitter;
8. compare outputs to selected reference fixtures;
9. validate against standards/spec files available to the project.

## 5. License review

Before copying any nontrivial source code verbatim:
- inspect repository license;
- prefer clean reimplementation from behavior/specification;
- record provenance.

## 6. Acceptance

LasecSimul HART implementation can reproduce chosen reference interactions through native C++ Core behavior with zero Dart/Flutter runtime dependency.
