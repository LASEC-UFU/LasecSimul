# 15 — Protocol Infrastructure

**Status:** PLANNED  
**Priority:** Introduce only as HART/Modbus reveal proven commonality  
**Depends on:** HART/Modbus investigations

## 1. Goal

Avoid duplicated plumbing across HART, Modbus and future industrial protocols while explicitly avoiding an over-general “universal protocol framework”.

## 2. Generalization threshold

Only extract a shared abstraction when at least two implemented protocols need materially the same behavior.

Likely candidates:

- endpoint identity;
- transaction timestamp/logging;
- fault injection hooks;
- protocol trace/monitor events;
- deterministic simulated latency;
- common diagnostics envelope.

Protocol-specific encoding, address models and timing remain protocol-specific.

## 3. Candidate shared concepts

### ProtocolEndpointId

Stable project/runtime identity.

### ProtocolTraceEvent

```text
timestampNs
protocol
sourceEndpoint
destinationEndpoint
direction
rawBytes optional
summary
severity/status
correlationId optional
```

### Fault profile interface

A small hook may support:

- delay;
- drop;
- corruption;
- forced exception/error.

Do not force HART analog physical faults and Modbus TCP faults into the same detailed schema.

## 4. Semantic link

A semantic protocol link is an internal simulated transport that can deliver a frame/message at Scheduler timestamps without physical waveforms.

Potential uses:

- HART application-layer labs;
- Modbus TCP-like internal networks;
- fast PLC/process integration.

It must not be mislabeled as physical Ethernet/RS-485/HART FSK.

## 5. Physical transports

Physical transports remain explicit components/adapters:

- UART;
- RS-485 transceiver;
- electrical A/B line;
- HART modem;
- 4–20 mA loop.

This separation enables both fast semantic simulation and detailed physical labs.

## 6. Protocol monitor

A generic trace viewer may consume `ProtocolTraceEvent` after both HART and Modbus implement trace publication.

Protocol-specific parsers provide detail panels.

## 7. Timing

All internal semantic delays/timeouts are Scheduler virtual time.

External real sockets are a different interoperability mode and must be labelled as such. They may require real-time pacing or asynchronous buffering and cannot define the simulation's time authority.

## 8. Security and robustness

Protocol parsers must:

- validate lengths before indexing;
- cap buffers;
- reject malformed frames safely;
- avoid unbounded allocations from length fields;
- never crash Core on external network input;
- expose parser errors diagnostically with rate limiting.

## 9. Tests

- two protocols can publish traces through common envelope if extracted;
- dropped/delayed semantic message;
- malformed external frame cannot crash;
- monitor subscription does not change simulation behavior;
- endpoint deletion invalidates links cleanly.

## 10. Future protocol candidates

Only after current roadmap:

- CAN / CANopen;
- OPC UA;
- EtherNet/IP educational abstractions;
- PROFINET/PROFIBUS only with realistic scope;
- MQTT for IoT labs.

Each future protocol gets its own spec and standards/license review.
