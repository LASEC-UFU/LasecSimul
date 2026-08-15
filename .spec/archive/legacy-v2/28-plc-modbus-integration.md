# 28 — PLC ↔ Modbus Integration

**Status:** NOT STARTED  
**Priority:** After PLC runtime and Modbus MVP  
**Depends on:** `10`, `11`, `12`

## 1. Goal

Allow the Generic PLC to participate in Modbus as client/master and/or server/slave without duplicating the Modbus engine inside the PLC runtime.

## 2. Architecture

```text
PLC Runtime
   │
PLC Communication Service
   │
shared Modbus Client/Server Engine
   │
semantic or physical transport
```

PLC code never reimplements CRC/MBAP/function decoding.

## 3. Server mode

Expose selected PLC variables in a register map.

Examples:

```text
Holding 40001 ↔ PLC.SP
Holding 40003 ↔ PLC.Kp
Input   30001 ← PLC.Level
Coil    00001 ↔ PLC.PumpCmd
Discrete 10001 ← PLC.Alarm
```

Writes occur at a documented PLC/communications phase.

## 4. Client mode

Two possible programming models:

### Configured cyclic exchange

Project config says:
- target;
- FC;
- source/destination variable;
- poll period.

Good for MVP.

### IEC-style communication function block later

Conceptually:
```text
MB_READ
MB_WRITE
```

Executed through PLC runtime state machine, not blocking Core thread.

## 5. Scan interaction

Define exact semantics.

Recommended MVP:

1. read physical inputs;
2. complete/apply Modbus responses due before scan execution;
3. execute PLC program;
4. update outputs;
5. issue configured communication requests;
6. requests/responses continue as Scheduler events;
7. next scan consumes completed data.

No synchronous socket wait inside scan.

## 6. Status variables

Expose:
- busy;
- done/new data;
- error;
- exception code;
- timeout;
- last update timestamp/age.

## 7. Timeout

Use Scheduler virtual time for internal simulated targets.

For real external Modbus TCP interoperability, use a clearly separate real-time adapter and convert result into PLC communication state safely.

## 8. Register encoding

PLC variable type ↔ register representation requires explicit mapping:
- INT/UINT;
- DINT/UDINT;
- REAL;
- BOOL;
- word order;
- scaling.

No implicit host-endian memcpy.

## 9. Tests

- server exposes PLC variable;
- client reads simulated server;
- client writes server setpoint;
- response arriving between scans only becomes program-visible according to documented phase;
- timeout;
- exception;
- two requests;
- scan does not block;
- stop cancels communication safely.

## 10. Acceptance

A Ladder/IR PLC can control a simulated Modbus device and expose its own process variables to a Modbus Scanner in the same project with deterministic scan/communication timing.
## Virtual-network default for multiuser environments

For Modbus TCP simulation, the default transport SHOULD be the per-`SimulationSession` virtual network defined in spec `47`.

Do not bind a real host TCP port merely because a device has an IP address/port in the simulated diagram.

Real host exposure is an explicit adapter/mode and may be disabled by SharedHost administrator policy.
