# 11 — Modbus Client, Scanner and Monitor

**Status:** NOT STARTED  
**Priority:** After Modbus server core  
**Depends on:** `10`

## 1. Goal

Implement an OpenModScan-like master/client interface and a passive diagnostic monitor.

## 2. Components

### Modbus Client / Scanner

Actively sends requests.

### Modbus Monitor

Observes internal semantic bus/transactions without changing traffic.

Do not combine them into a single object with ambiguous active/passive behavior.

## 3. Client configuration

- transport: Internal/TCP/RTU semantic;
- target endpoint;
- Unit ID;
- request function;
- start address;
- quantity;
- poll interval;
- timeout;
- retries;
- decode data type;
- byte/word order.

## 4. Operations

- Read Once;
- Start/Stop Polling;
- Write Single;
- Write Multiple;
- Scan Unit IDs;
- Scan address range with safety limits;
- custom raw request later.

## 5. Poll scheduling

Internal simulated polling must use Scheduler time:

```text
t = 0 ms request
t = 100 ms request
t = 200 ms request
```

If a real external TCP socket is used, define a separate real-time interoperability mode rather than mixing wall-clock callbacks into deterministic simulation.

## 6. Response model

Expose:

- success;
- exception code;
- timeout;
- malformed response;
- transaction mismatch;
- decoded values;
- raw bytes;
- request and response virtual timestamps;
- measured simulated response latency.

## 7. Scanner UI

Suggested tabs:

### Connection
target, Unit ID, transport.

### Request
FC, start address, quantity, poll interval.

### Data
table with:
- address;
- raw register(s);
- decoded value;
- engineering value;
- timestamp/status.

### Raw
TX/RX hex + parsed fields.

### Scan
Unit ID/address scan controls.

## 8. Monitor

Capture internal transactions:

```text
12.000000  Client1 → VFD1  FC03 addr=0 qty=4
12.003500  VFD1 → Client1  OK 8 bytes
```

Filtering:

- endpoint;
- Unit ID;
- function;
- error only.

Export trace later.

## 9. Physical Modbus RTU roadmap

Later:

```text
PLC/Client UART
    │
RS-485 transceiver
    │
A/B electrical pair
    │
RS-485 transceiver
    │
Modbus Server
```

Requirements:

- UART bit timing;
- baud/data/parity/stop;
- inter-character/frame gap;
- CRC;
- transceiver enable/direction;
- line termination/biasing if physically modeled;
- Scheduler virtual timing.

This physical mode enables real MCU/QEMU firmware UART code to communicate with a simulated Modbus device.

## 10. Fault labs

Client should make it easy to demonstrate:

- timeout;
- CRC error;
- wrong parity/baud in physical mode;
- wrong Unit ID;
- illegal function;
- illegal address;
- byte-order mismatch;
- scale mismatch;
- delayed server.

## 11. Tests

- read/poll;
- write;
- timeout;
- retry count;
- exception display;
- scan finds expected IDs;
- scanner respects max range/rate;
- monitor sees traffic but does not alter it;
- raw frame parser;
- save/reopen client configuration.

## 12. Acceptance criteria

A user can configure a Modbus Server Device, connect a Modbus Client/Scanner, poll live process values, write a setpoint and inspect raw/parsed traffic inside the same LasecSimul project.
## Virtual-network default for multiuser environments

For Modbus TCP simulation, the default transport SHOULD be the per-`SimulationSession` virtual network defined in spec `47`.

Do not bind a real host TCP port merely because a device has an IP address/port in the simulated diagram.

Real host exposure is an explicit adapter/mode and may be disabled by SharedHost administrator policy.
