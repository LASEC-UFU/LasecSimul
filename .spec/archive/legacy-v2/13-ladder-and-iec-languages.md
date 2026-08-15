# 13 — Ladder Editor and IEC-style Languages

**Status:** NOT STARTED  
**Priority:** After PLC runtime  
**Depends on:** `12`

## 1. Goal

Provide a Ladder Diagram editor for the Generic PLC, then extend toward Structured Text, Function Block Diagram and SFC using one shared runtime/IR.

The product should be standards-inspired/compatible where practical, but must not claim full IEC 61131-3 compliance until verified.

## 2. Ladder MVP

Elements:

- normally open contact;
- normally closed contact;
- coil;
- set/reset coil;
- branch;
- TON;
- TOF;
- CTU;
- compare;
- simple arithmetic/function block call later.

## 3. Editor interaction

Within PLC editor:

- rung numbers;
- grid/snap;
- left/right rails;
- drag/drop instruction palette;
- wire/branch editing;
- inline variable names;
- live validation;
- execution highlighting in simulation;
- online value display;
- force/watch controls later.

Do not overload the main electrical schematic editor with Ladder-specific semantics. It can share rendering primitives but should be a dedicated PLC program editor view.

## 4. Ladder semantic model

Persist semantic elements, not only SVG positions.

Example:

```text
Rung
├── nodes/instructions
├── connections/branches
├── variable references
└── layout
```

Compile to PLC IR.

## 5. PLC IR

The IR should support:

- boolean logic;
- assignments;
- branches/control;
- arithmetic;
- comparisons;
- calls to standard function blocks;
- timer/counter instances;
- variable load/store.

Example Ladder:

```text
|----[ I0 ]----[/ I1 ]----------------( Q0 )----|
```

Possible IR:

```text
tmp0 = LOAD_BOOL I0
tmp1 = LOAD_BOOL I1
tmp2 = NOT tmp1
tmp3 = AND tmp0 tmp2
STORE_BOOL Q0 tmp3
```

Exact IR design should optimize clarity/determinism first.

## 6. Structured Text later

ST should compile to the same IR.

Initial subset:

- assignment;
- IF/ELSIF/ELSE;
- arithmetic/boolean expressions;
- function block calls;
- basic loops only with execution safeguards.

Need parser with source locations for diagnostics.

## 7. FBD later

Signal-like graphical representation can reuse some block-diagram canvas primitives, but FBD uses PLC task/scan semantics and typed PLC variables. Do not assume generic Signal Engine blocks are automatically IEC function blocks.

## 8. SFC later

Represent:

- steps;
- transitions;
- actions;
- active-step state.

Execute under PLC task semantics.

## 9. Tasks

Future PLC project may include:

- cyclic task;
- event task;
- priority.

MVP: one cyclic task tied to scan time.

## 10. Diagnostics

Must include source/rung location:

- undefined variable;
- type mismatch;
- invalid branch;
- coil conflict warning;
- duplicate variable;
- invalid function block arguments;
- unsupported construct;
- runaway ST loop protection.

## 11. Online monitoring

At runtime:

- green/active power flow style optional;
- variable value tooltips;
- timer ET/Q;
- counter CV/Q;
- current scan time;
- PLC RUN/STOP/FAULT.

UI polling is observational only.

## 12. Interchange

Plan data model so future PLCopen XML / IEC interchange can map sensibly. Do not implement import/export in MVP.

## 13. Tests

- rung compile;
- NO/NC;
- branches;
- coils;
- TON/CTU mapping;
- same logical program in LD and ST produces equivalent IR/runtime result later;
- malformed ladder diagnostics;
- save/reopen visual layout + semantics;
- source locations.

## 14. Acceptance criteria

A user can double-click a Generic PLC, create a Ladder program controlling at least digital I/O and TON, run the main simulation, and see deterministic scan-based behavior.
