# 09 — HART Communicator and Physical Layer

**Status:** NOT STARTED  
**Priority:** After HART transmitter semantic MVP  
**Depends on:** `08`

## 1. Goal

Add an in-simulator HART master/communicator experience comparable to a field communicator, then optionally add detailed physical FSK transport.

## 2. HART Communicator block

External visual:

```text
┌────────────────┐
│ HART           │
│ Communicator   │
└───────┬────────┘
        │ protocol/loop coupling
```

Double-click opens a dedicated panel.

## 3. Communicator UI

### Device page

- tag;
- manufacturer;
- device type;
- unique ID;
- revisions;
- polling address.

### Process page

- PV;
- PV unit;
- percent range;
- loop current;
- SV/TV/QV later.

### Configuration page

- LRV/URV;
- damping;
- unit where command support exists;
- tag/descriptor/message;
- polling address;
- write protect state.

### Diagnostics page

- response/device status;
- communication errors;
- instrument diagnostics;
- active faults.

### Raw page

Show timestamped request/response:

```text
TX  12.000000 s  FF FF ... 
RX  12.023000 s  FF FF ...
```

Also show parsed fields.

## 4. Semantic protocol mode

Implement first.

The protocol endpoint exchanges HART frames/PDUs through Core-managed simulation events without synthesizing an analog 1200/2200 Hz waveform.

Benefits:

- fast tests;
- easy deterministic fault injection;
- useful for command/configuration labs;
- decouples application-layer correctness from physical modem complexity.

## 5. Physical HART mode

Later, support an electrical 4–20 mA loop with HART FSK superimposed.

Requirements before implementation:

- verify exact physical-layer levels, frequencies, timing and modem behavior against available HART physical-layer specification;
- define the electrical coupling model;
- define modem RX thresholds/filtering;
- ensure Scheduler/MNA step requirements are computationally practical.

Do not fake physical mode by merely labeling semantic frames “FSK”.

## 6. Physical architecture candidate

```text
HartProtocolEngine
      │ frames/bits
      ▼
HartModem
      │ modulated command
      ▼
Electrical Loop Interface
      │
LOOP+ / LOOP-
```

At receiver:

```text
Electrical waveform → modem demodulator → frame decoder → protocol engine
```

## 7. Two masters

Plan for primary/secondary master roles if needed, but do not implement advanced arbitration before MVP requirements demand it.

## 8. Multidrop

Later milestone:

- multiple field devices on one loop;
- polling addresses;
- analog current behavior appropriate to multidrop;
- master scans addresses.

## 9. Fault injection

Semantic:
- bad checksum;
- no response;
- delayed response;
- invalid address;
- unsupported command;
- device busy.

Physical later:
- attenuation;
- noise;
- loop loading;
- low signal amplitude.

All delays are virtual-time delays.

## 10. Tests

Semantic:
- discovery/read ID;
- read PV;
- write config;
- timeout;
- bad checksum;
- two addressed devices;
- raw frame log timestamps.

Physical later:
- encode/decode known bit sequence;
- valid frame over electrical loop;
- noise tolerance;
- collision/unsupported condition behavior.

## 11. Acceptance criteria

Semantic MVP: user can connect/configure a communicator to one or more simulated HART devices, read/write supported values and inspect raw parsed transactions.

Physical milestone is separately accepted only after waveform-level end-to-end tests.
