# 48 — Simulation Backend Abstraction: Local Today, Remote Future

**Status:** PLANNED  
**Priority:** Architectural seam only; remote implementation deferred  
**Depends on:** `00`, current Extension↔Core IPC  
**Related:** `43`, `44`, `45`, `47`

## 1. Goal

Keep one simulation architecture while leaving a clean path for a future true client/server deployment in which VS Code/UI and Simulation Core run on different machines.

Today:
```text
VS Code Extension → Local Core
```

Future:
```text
VS Code Extension → Remote Simulation Service → Core session
```

Do not build the remote service now unless a separate roadmap approves it.

---

## 2. Key decision

There is one:
- project model;
- Core;
- Scheduler;
- MNA solver;
- signal/process engine;
- PLC runtime;
- protocol engines.

The local/remote distinction belongs at the transport/backend boundary.

---

## 3. Candidate interface

Extension-side abstraction:

```text
SimulationBackend
├── startSession
├── stopSession
├── loadProject/model
├── run
├── pause
├── step
├── reset
├── applyMutation
├── subscribeTelemetry
├── requestDiagnostics
└── dispose
```

Initial implementation:
```text
LocalSimulationBackend
```

Future:
```text
RemoteSimulationBackend
```

Exact methods must map to current IPC protocol instead of forcing a rewrite.

---

## 4. Local backend

Uses:
- named pipe on Windows;
- AF_UNIX/socket equivalent on Unix;
- local Core process manager.

This remains the standard Desktop and SharedHost implementation.

---

## 5. SharedHost is still local backend

Important:

```text
Thin client/shared host
≠
RemoteSimulationBackend
```

In the described laboratory:
- each user session starts a local Core on the same shared OS host;
- ResourceGovernor controls resource usage;
- shared read-only runtimes reduce duplication.

---

## 6. Remote backend future use case

Possible future lab:

```text
Student PC
  VS Code/UI
      │ network
      ▼
LasecSimul Simulation Server
      ├── Session A
      ├── Session B
      └── Session C
```

This is a true client/server architecture.

---

## 7. Protocol design requirements

Current local IPC should evolve with:
- explicit protocol version;
- request IDs;
- session IDs;
- capability negotiation;
- bounded telemetry messages;
- deterministic command semantics.

These are useful locally too.

Do not assume transport security requirements are the same for local and remote.

---

## 8. Serialization boundary

Keep Extension↔Core messages free of:
- raw pointers;
- process-local handles;
- platform-specific memory addresses.

Use stable IDs and serializable values.

This makes remote evolution possible.

---

## 9. File handling

Local backend may refer to local workspace files.

Remote backend will eventually need:
- upload/sync;
- content hashes;
- artifact handling;
- source mapping for diagnostics.

Do not implement this prematurely, but avoid APIs that assume Core can always open arbitrary client filesystem paths without mediation.

---

## 10. Telemetry

Backend abstraction should expose logical telemetry.

Local backend may use efficient local transport.

Remote future backend may:
- compress;
- decimate;
- batch;
- use streaming protocol.

Same consumer UI.

---

## 11. Runtime ownership

Local:
- extension/process manager starts Core.

Remote:
- server/session manager starts Core/session.

Simulation semantics inside Core stay identical.

---

## 12. Authentication/security future

Remote implementation will require:
- authentication;
- authorization;
- TLS;
- quotas;
- tenant isolation;
- server-side runtime policies.

These are explicitly DEFERRED.

Do not add insecure remote listening socket as a shortcut.

---

## 13. ResourceGovernor relationship

Local Desktop:
```text
ResourceGovernor → desktop budget
```

Local SharedHost:
```text
ResourceGovernor → lab budget
```

Remote Server future:
```text
server quota manager
      ↓
ResourceGovernor per session
```

Same Core contract.

---

## 14. Project portability

A `.lsproj` must not encode:

```text
runMode = desktop-only
```

or:
```text
server-specific physics
```

The same project can be opened in:
- Desktop;
- SharedHost;
- future Remote backend.

Deployment preferences are user/admin settings, not core project semantics unless an external-resource binding explicitly requires them.

---

## 15. Acceptance criteria for current roadmap

Current implementation only needs:
- clear backend seam around existing local IPC/process management;
- no unnecessary remote code;
- tests proving Local backend behavior unchanged.

Remote service remains deferred until separately specified.
