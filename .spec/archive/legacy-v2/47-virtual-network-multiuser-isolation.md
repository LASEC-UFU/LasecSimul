# 47 — Virtual Networks and Multiuser Isolation

**Status:** PLANNED  
**Priority:** High before broad Modbus TCP/network expansion  
**Depends on:** `10`, `11`, `15`, `24`, `44`  
**Related:** `29`, `45`, `48`

## 1. Goal

Allow networked industrial simulation without host-port/IP collisions when many users run identical projects on the same shared machine.

Default network communication between simulated components should be virtual/in-process where possible.

---

## 2. Problem

Twenty students may all open a project containing:

```text
PLC: 192.168.0.10
VFD: 192.168.0.20
Modbus TCP port 502
```

Those addresses must coexist independently.

They must NOT all bind the real host TCP port 502.

---

## 3. Virtual network namespace

Each `SimulationSession` owns an isolated virtual network domain.

Concept:

```text
SimulationSession A
└── VirtualNetwork A
    ├── 192.168.0.10
    └── 192.168.0.20

SimulationSession B
└── VirtualNetwork B
    ├── 192.168.0.10
    └── 192.168.0.20
```

No collision.

---

## 4. Semantic Modbus TCP

Default Modbus TCP should use semantic virtual transport:

```text
Modbus Client
     ↓
VirtualNetwork / ProtocolTransport
     ↓
Modbus Server
```

It should preserve:
- address;
- Unit ID;
- TCP-like endpoint identity;
- request/response timing model where configured.

It does not require a real OS socket.

---

## 5. Host exposure is explicit

A component/network may expose a real host socket only when user chooses an explicit mode:

```text
Network Mode:
● Virtual
○ Expose to Host
○ Connect to External Host
```

Host exposure must:
- obey Workspace Trust/security policy;
- handle port conflicts;
- display bound endpoint;
- be disable-able by lab administrator.

---

## 6. SharedHost policy

Laboratory default:
```text
Virtual only
```

Administrator may disable:
- listening sockets;
- outbound external network;
- arbitrary host bridging.

This prevents:
- collisions;
- accidental LAN traffic;
- students interfering with each other.

---

## 7. Network identity

Within virtual network support:
- IPv4-like addresses initially;
- logical endpoint name;
- port;
- protocol.

The virtual address is simulation metadata, not necessarily an OS interface address.

---

## 8. Timing

Semantic virtual transport uses Scheduler virtual time.

Possible parameters:
- latency;
- jitter with deterministic seed;
- packet loss;
- timeout;
- bandwidth later.

Wall-clock socket timing is not used for internal virtual communication.

---

## 9. Fault injection

Useful educational options:
- packet drop;
- delay;
- duplicate;
- connection unavailable;
- server timeout;
- malformed frame where protocol permits testing.

All deterministic under seed/configuration.

---

## 10. Real external network bridge

Future explicit adapter:

```text
Virtual Network
      ↕
Host Network Bridge
      ↕
real device / external simulator
```

This adapter introduces wall-clock/real-world synchronization concerns and must be separately designed.

Do not let normal virtual devices accidentally open sockets.

---

## 11. HART/serial relation

This spec is primarily for Ethernet/network protocols.

Serial buses use their own virtual bus/physical transport models:
- UART;
- RS-485;
- HART loop.

Same isolation principle applies.

---

## 12. Future protocols

Virtual network should be extensible for:
- Modbus TCP;
- OPC UA;
- MQTT;
- EtherNet/IP;
- other Ethernet-based training protocols.

Do not prematurely model full Ethernet frames if protocol-level semantic transport is sufficient.

---

## 13. Monitor/sniffer

A virtual network monitor may subscribe to:
- requests;
- responses;
- endpoint connect/disconnect;
- errors.

It should not consume real host network traffic unless a host bridge is explicitly active.

---

## 14. Session cleanup

Virtual endpoints disappear with `SimulationSession`.

No lingering host ports.

Host bridge sockets:
- close on stop/shutdown;
- unique ownership;
- robust crash cleanup where possible.

---

## 15. Tests

- same virtual IP/port in 20 sessions;
- no cross-session delivery;
- request ordering;
- simulated latency;
- timeout;
- packet drop seed reproducibility;
- host exposure conflict;
- admin policy blocks external network;
- project save/reopen.

---

## 16. Acceptance criteria

Two or more simultaneous users can run identical Modbus TCP addressing without any OS port conflict or cross-session communication, because virtual networking is the default.
