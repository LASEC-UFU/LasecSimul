# 21 — Example and Demonstration Projects

**Status:** PLANNED  
**Priority:** Added with each milestone

## 1. Purpose

Examples are executable acceptance artifacts and teaching material, not screenshots.

## 2. Signal basics

### `examples/signals-step-gain`

```text
Step → Gain → Scope
```

Teaches:
- signal line;
- virtual time;
- scope.

### `examples/control-first-order`

```text
Step → Transfer Function → Scope
```

## 3. Electrical + signal

### `examples/hybrid-rc-control`

```text
Sine → Controlled Voltage Source → RC → Voltage Sensor → Scope
```

Proves domain bridge.

## 4. Process

### `examples/process-tank-level`

```text
Inflow → Tank → Level
```

### `examples/process-pid-tank`

```text
SP → PID → Valve → Tank → Level feedback
```

## 5. HART

### `examples/hart-smart-transmitter`

```text
FirstOrder PV → HART PT-101 → 4–20mA loop
                         └→ HART Communicator
```

Exercises:
- tag;
- range;
- current;
- range write;
- diagnostic fault.

### `examples/hart-fault-lab`

Bias/freeze/sensor-failure scenarios.

## 6. Modbus

### `examples/modbus-tank-server`

Registers:
- 30001 Level;
- 30003 Flow;
- 40001 Setpoint;
- 00001 PumpEnable.

Client scanner polls and writes.

### `examples/modbus-endianness-lab`

Same float interpreted under different word orders.

## 7. PLC

### `examples/plc-basic-io`

Pushbutton → PLC I0 → Ladder → Q0 → lamp/relay.

### `examples/plc-tank-control`

PLC reads level and controls valve/pump.

## 8. Integrated automation lab

Long-term flagship:

```text
Tank Process
   │ PV
HART LT-101
   │ 4–20mA + HART
PLC AI
   │
Ladder/PID logic
   │
Modbus TCP
   ├→ Scanner/SCADA
   └→ Virtual VFD
          │
        Pump
          └→ Tank inflow
```

Potential MCU/FPGA variant later.

## 9. FPGA

### `examples/fpga-vhdl-counter`

LasecSimul Clock → GHDL VHDL counter → LEDs.

### `examples/fpga-mcu-mixed`

Only after both domains stable.

## 10. Requirements for every example

- project opens without absolute developer paths;
- README states prerequisites;
- expected behavior;
- simulation duration/settings;
- screenshot optional, never sole verification;
- CI/headless smoke where possible;
- intentionally small enough for teaching.

## 11. Acceptance

Examples must be kept current with schema migrations and used as packaging smoke fixtures.
