# 29 — UART and RS-485 Physical Transport Roadmap

**Status:** DEFERRED  
**Priority:** After semantic Modbus RTU and stable electrical/signal bridges  
**Depends on:** electrical kernel, Scheduler, Modbus RTU codec

## 1. Goal

Eventually allow real MCU/PLC UART behavior to communicate through simulated RS-485 transceivers and electrical A/B lines.

## 2. Layer separation

```text
Modbus PDU
   │
RTU ADU / CRC
   │
UART bytes
   │
UART serializer
   │
TX/RX digital electrical
   │
RS-485 transceiver
   │
A/B differential electrical network
```

Each layer must be independently testable.

## 3. UART model

Properties:
- baud;
- data bits;
- parity;
- stop bits;
- idle level;
- optional oversampling receiver;
- framing/parity errors.

Virtual bit period:

\[
T_{bit}=1/baud
\]

Convert to Scheduler ns with documented rounding.

## 4. RTU frame timing

Implement exact timing rules only after validating against authoritative Modbus serial-line documentation.

Need:
- inter-character timing;
- frame gap;
- timeout;
- baud-dependent thresholds;
- response delay.

## 5. RS-485 transceiver

Potential electrical pins:
- DI;
- RO;
- DE;
- /RE;
- A;
- B;
- VCC/GND if detailed.

MVP physical transceiver may use an ideal differential-driver model with configurable output impedance and receiver thresholds.

Later:
- failsafe bias;
- termination;
- loading;
- propagation delay;
- contention.

## 6. Bus topology

Electrical A/B wires naturally support multi-drop if modeled as actual electrical nodes. Protocol endpoint addressing remains Modbus responsibility.

## 7. MCU integration

Target lab:

```text
ESP32/QEMU UART → digital pins → MAX485-like block
                                   │
                           A/B electrical bus
                                   │
                           Modbus Server Device
```

This requires a bridge from QEMU UART/GPIO behavior consistent with the MCU model.

## 8. Performance risk

Bit-level electrical simulation at high baud rates can force much smaller Scheduler/MNA steps.

Before production implementation:
- benchmark 9600, 19200, 115200;
- estimate MNA event load;
- consider event-driven ideal digital transceiver mode vs waveform-detailed mode.

## 9. Tests

- UART byte loopback;
- parity/framing error;
- differential receiver;
- two-node RS-485 exchange;
- bus contention;
- Modbus RTU known request over full stack;
- MCU firmware interoperability later.

## 10. Acceptance

Physical transport is only considered implemented when an actual byte stream traverses UART serialization and RS-485 electrical behavior; semantic frame delivery alone remains the separate fast mode.
