# 10 — Modbus Core and Server Device

**Status:** NOT STARTED  
**Priority:** Industrial communications MVP  
**Depends on:** `02`, `15` recommended

## 1. Goal

Implement an OpenModSim-like **Modbus Server Device** integrated with LasecSimul values/processes, with a reusable Modbus protocol core.

## 2. Core modules candidate

```text
core/src/protocols/modbus/
├── ModbusPdu
├── ModbusAdu
├── ModbusFunctionRegistry
├── ModbusDataModel
├── ModbusRegisterMap
├── ModbusCodec
├── ModbusCrc16
├── ModbusMbap
├── ModbusServerEngine
└── transports/
    ├── ModbusTcpTransport
    └── ModbusRtuTransport
```

File names must follow current Core conventions after repository inspection.

## 3. Data model

Four spaces:

- Coils;
- Discrete Inputs;
- Holding Registers;
- Input Registers.

Internally store canonical zero-based addresses. UI may display conventional reference notation (`00001`, `10001`, `30001`, `40001`) but must make the distinction clear to avoid off-by-one confusion.

## 4. Register entry metadata

Candidate:

```cpp
struct ModbusEntry {
    ModbusTable table;
    uint16_t address;
    std::string name;
    std::string description;

    ModbusDataType dataType;
    ByteOrder byteOrder;
    WordOrder wordOrder;

    double scale;
    double offset;
    UnitSpec unit;

    AccessMode access;
    std::optional<ValueBinding> binding;
    ValueSource valueSource;
};
```

## 5. Data types

Initial:

- BOOL;
- UINT16;
- INT16;
- UINT32;
- INT32;
- FLOAT32.

Then:

- FLOAT64;
- ASCII;
- STRING;
- BITFIELD;
- raw registers.

Multi-register values must define exact address occupancy and endianness.

## 6. Byte/word order

Support common representations explicitly. Do not use vague labels alone; preview resulting bytes/registers in UI.

Examples:

```text
ABCD
CDAB
BADC
DCBA
```

For 16-bit values, byte swap can be separate.

## 7. Scaling

For numeric engineering values:

\[
Engineering = Raw \times Scale + Offset
\]

Writable bindings require inverse conversion with rounding/saturation/error policy.

## 8. Value sources

Inspired by useful OpenModSim patterns, support:

- Constant;
- Bound Signal;
- Bound Process Variable;
- Expression;
- Random;
- Increment;
- Decrement;
- Toggle;
- Sine;
- Ramp.

Random is deterministic under simulation seed.

Value generators use virtual time.

## 9. Binding

Example:

```text
Input Register 30001 → Tank.Level (read)
Holding Register 40001 ↔ PID.Setpoint (read/write)
Coil 00001 ↔ PumpEnable
```

Writes must pass through runtime-writable parameter policy.

## 10. Function codes

MVP candidates:

- FC01 Read Coils;
- FC02 Read Discrete Inputs;
- FC03 Read Holding Registers;
- FC04 Read Input Registers;
- FC05 Write Single Coil;
- FC06 Write Single Register;
- FC15 Write Multiple Coils;
- FC16 Write Multiple Registers.

Add exception responses:

- Illegal Function;
- Illegal Data Address;
- Illegal Data Value;
- Server Device Failure;
- Server Device Busy where applicable.

Validate exact protocol encoding against authoritative Modbus documentation during implementation.

## 11. Modbus TCP

First transport recommended because it avoids physical serial timing.

Implement:

- MBAP header;
- transaction ID;
- protocol ID validation;
- length;
- Unit ID;
- PDU.

Two possible modes:

1. **Internal semantic transport** between LasecSimul components — deterministic and fast.
2. **Real localhost TCP endpoint** for interoperability with external tools.

If external TCP is added, clearly distinguish wall-clock network I/O from simulation-time semantics. External clients cannot be assumed to run on accelerated virtual time.

## 12. RTU semantic transport

Add framing/CRC as a protocol-level milestone before physical RS-485:

- address;
- function;
- data;
- CRC16;
- virtual baud/timing model later.

## 13. Server UI

Double-click:

```text
MODBUS SERVER — MB_DEVICE_1

Protocol: TCP
Unit ID: 1

Type      Address Name       Type    Value   Binding
Holding   40001   Setpoint   Float   50.0    PID.SP
Input     30001   Level      Float   72.4    Tank.Level
Coil      00001   Pump       Bool    ON      PumpEnable
```

Actions:
- add/edit/delete;
- import/export map later;
- force value;
- inspect raw bytes;
- enable fault.

## 14. Fault injection

- response delay;
- dropped response percentage;
- exception response;
- illegal address region;
- busy/failure;
- frozen register;
- CRC corruption (RTU);
- wrong Unit ID behavior.

## 15. Tests

- all MVP FCs;
- exception responses;
- float across two registers;
- endianness;
- scaling;
- bound signal read;
- holding register write updates bound target;
- non-writable target rejected;
- CRC known vectors;
- MBAP transaction matching;
- two Unit IDs;
- deterministic value generator;
- save/reopen register map.

## 16. Acceptance criteria

A simulated process variable can appear in a Modbus register map and be read by a LasecSimul Modbus client; a writable register can modify a real simulation parameter.
## Virtual-network default for multiuser environments

For Modbus TCP simulation, the default transport SHOULD be the per-`SimulationSession` virtual network defined in spec `47`.

Do not bind a real host TCP port merely because a device has an IP address/port in the simulated diagram.

Real host exposure is an explicit adapter/mode and may be disabled by SharedHost administrator policy.
