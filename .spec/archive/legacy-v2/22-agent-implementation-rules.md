# 22 — Rules for Coding Agents Implementing These Specs

**Status:** ACTIVE  
**Priority:** Mandatory

## 1. Investigate before modifying

Before writing production code for any spec:

1. inspect the current repository tree;
2. locate existing classes/files that already solve adjacent problems;
3. map the spec's candidate concepts to real existing abstractions;
4. identify tests and packaging paths;
5. report architectural reuse plan;
6. only then implement.

Do not assume this spec's candidate file/class names already exist or must be created.

## 2. Reuse priority

Always prefer:

```text
reuse existing architecture
>
generalize a demonstrably common abstraction
>
create new infrastructure
```

## 3. Protect existing domains

Every implementation must preserve:

- electrical/MNA behavior;
- Scheduler behavior unless deliberately extended;
- MCU/QEMU integration;
- existing plugins/devices;
- subcircuits;
- old projects;
- extension IPC compatibility or explicit version migration.

## 4. No speculative refactors

Do not:
- rewrite Scheduler for elegance;
- replace MNA;
- create a universal graph engine before a concrete requirement;
- merge QEMU/GHDL process managers into a complex base class merely because both launch processes;
- invent a new catalog system when `folderPath`/registered sources already work.

## 5. Virtual time

All simulated timing uses Scheduler time.

Forbidden as simulation truth:
- wall-clock timers;
- sleeps;
- UI intervals;
- OS clock.

Allowed:
- wall-clock only for process watchdog/real external I/O orchestration, clearly separated from simulated time.

## 6. Changes in small commits

Each numbered implementation slice should:

- compile;
- run relevant tests;
- keep baseline green;
- be reviewable.

Do not mix:
- architecture refactor;
- UI redesign;
- schema migration;
- unrelated cleanup

in one commit unless inseparable.

## 7. Spike policy

Use a spike when an external technical assumption could invalidate architecture.

Examples:
- GHDL VPI time control;
- physical HART modem feasibility at MNA timestep;
- FMU synchronization.

A spike:
- can be throwaway;
- is not production API;
- must record findings;
- should precede large infrastructure.

## 8. Persistence

Before storing structured data:
- inspect current property schema;
- do not JSON-stringify arrays/maps as a shortcut;
- add versioned schema fields or artifact format if justified;
- add round-trip tests.

## 9. Concurrency

If background threads are used:
- document ownership;
- marshal simulation-state mutation onto existing safe path;
- preserve lock ordering;
- cancel/join safely on stop/destruction;
- test crash/stop race.

Use MCU deferred-Scheduler-call pattern as reference where relevant.

## 10. Diagnostics

Every failure path must answer:
- component/artifact;
- reason;
- corrective action if known.

Source tools must emit Problems entries with location where available.

## 11. External dependencies

Do not silently download/run arbitrary binaries.

For GHDL/tool paths:
- setting;
- PATH;
- clear missing-tool diagnostic.

For optional external tools, tests may skip cleanly with explicit reason.

## 12. Standards claims

HART, Modbus and IEC behavior must be verified against authoritative specifications before claiming compliance.

Reference/open-source implementations are useful for architecture/tests, but do not copy incompatible licensed code and do not treat one implementation as the standard itself.

## 13. User-facing parity

A feature is not complete if:
- Core supports it but palette cannot add it;
- palette adds it but packaged Core cannot instantiate it;
- editor config exists but save/reopen loses it;
- UI displays live values computed only in TypeScript.

## 14. Required report after each milestone

Report:

### Files changed
List paths.

### Architectural decisions
What was reused vs added.

### Tests executed
Commands and results.

### Functional demo
What can now be demonstrated.

### Known limitations
Explicit.

### Manual verification
Only items genuinely not headlessly verifiable.

### STATUS update
Which spec moved state.

## 15. Stop conditions

Do not continue deeper implementation if:
- baseline regression appears;
- critical external spike disproves core assumption;
- persistence format cannot represent required state safely;
- concurrency lifecycle is not understood.

Resolve/adjust architecture first.

## 16. No implementation-by-document-only

If instructed to implement a milestone, do not stop after another analysis plan unless blocked by a demonstrable technical constraint. The specs already provide the plan; produce working code incrementally.
