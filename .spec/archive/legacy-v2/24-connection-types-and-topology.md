# 24 — Connection Types and Hybrid Topology

**Status:** NOT STARTED  
**Priority:** Foundation detail for unified canvas  
**Depends on:** `00`, current topology implementation

## 1. Goal

Define how electrical wires, signal lines and future protocol links coexist in project topology without corrupting existing Netlist assumptions.

## 2. Electrical topology remains electrical

Existing electrical topology groups component pin slots into physical nets/islands for MNA. Do not insert directed signal edges into that union-find/net grouping.

## 3. Signal topology is separate

A signal edge needs:

- source component/block ID;
- source signal port ID;
- target component/block ID;
- target signal port ID;
- optional routing visual data.

Graph direction is semantically meaningful.

## 4. Hybrid component

One placed component may expose both:

```text
ElectricalPinSpec[]
SignalPortSpec[]
ProtocolEndpointSpec[] later
```

These should share visual component identity but be registered with the correct simulation topology.

## 5. Connection validation

Electrical:
- follow existing pin compatibility.

Signal:
- output→input;
- compatible type;
- compatible vector width;
- unit compatibility policy;
- one producer unless explicit resolver block.

Protocol:
- protocol/link compatibility later.

## 6. Editing

When deleting/moving/regenerating ports:

- preserve matching stable IDs;
- remove only connections to deleted IDs;
- never reconnect by positional index silently.

## 7. Selection/routing

Reuse existing wire-routing interaction where possible, but signal arrow/direction must remain visible.

## 8. Serialization

Avoid a polymorphic “edge with optional everything” if it makes schema ambiguous. Separate topology sections may be cleaner.

The actual choice must follow current `.lsproj` schema constraints.

## 9. Tests

- electrical + signal same component;
- signal edge never affects electrical island grouping;
- delete one signal port;
- vector port width change;
- load/save mixed topology;
- copy/paste preserves internal references and remaps instance IDs;
- subcircuit boundary mixed ports.

## 10. Acceptance

A project containing an RC circuit and a disconnected signal graph loads/runs with each topology processed only by its correct domain, then an explicit adapter can bridge them.
