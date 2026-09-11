# HART engine implementation status

Last updated: 2026-09-11 (Lasec HART Command DSL)

## 2026-09-11 — Lasec HART Command DSL: real parser, cross-language proof for 0x0B, 2 more real bugs fixed

Picked up an even larger-scoped task (unify the circuit DSL and HART command
authoring, complete Property Inspector across every domain, migrate the full
60-command universe, remove legacy paths, fuzz, benchmark) that is
realistically a multi-week roadmap, not a one-session deliverable. Rather
than either refuse it or fake completion, this session did real, tested work
on the piece the task itself calls "central" -- the HART Command DSL/Graph/
Compiler -- and reports the rest honestly as `IN_PROGRESS` (never claimed
`DONE` without evidence). Full accounting, including a status master table
across 20+ areas, is in `.spec/features/hart-device-engine.md` "Anexo D".

What's real and tested:

- `HartCommandJson` (Core) now accepts/serializes the FULL statement
  vocabulary (`write`/`resp`/`after`, `Set`, `If`/EQ, `Map`, `ForCodes`), not
  just the flat 4-step subset from before. Round-trip tested (parse →
  compile → execute → toJson → re-parse → re-compile → same bytes).
- A real Lasec HART Command DSL parser now exists
  (`extension/src/dsl/HartCommandDsl.ts`), reusing the SAME lexer as the
  circuit DSL (`DslParser.ts`'s `lex()`, newly exported) -- chains, slices,
  hex literals, `if/else`, `IdentityBlock` macro expansion, read-vs-write
  inferred from arrow direction. 10 new unit tests.
- **First real cross-language proof that a command is DSL-representable**:
  the DSL source equivalent to 0x0B was parsed in TypeScript, the resulting
  JSON was fixed as a literal in the Core test, and compiled/executed there
  -- producing byte-identical output (tag match AND mismatch) to the
  existing hand-authored 0x0B implementation. This is what "migrated"
  should mean per the task's own strict definition (a hand-built C++ AST
  alone doesn't count) -- previously true for 0 commands, now true for 1.
- Two more real bugs found and fixed while building/testing this (not
  hypothetical -- both caused wrong behavior or total dispatch failure):
  `UserVariable` always encoded as 4-byte Float32BE regardless of its
  declared type (UInt8/UInt16/Int16/Bool all produced wrong bytes); a custom
  command id colliding with any of the 55 fallback-only standard/vendor ids
  silently failed the ENTIRE device's command dispatch, not just that one
  command (`HartPlanCompiler::compile()` rejected the whole plan).

What's honestly still open (see Anexo D for the full list with next
actions, not vague "future work"): 54 of the remaining commands have no
real body yet; 0x00/0x01/0x03/0x21 work and have goldens but haven't
individually been proven to come from the DSL text parser yet (only 0x0B
has); no visual Command Graph editor; the DSL parser isn't wired into the
Property Inspector as an authoring surface yet; `HartSemanticEndpoint`/the
legacy `command==0/1/3` switch in `IndustrialProtocols.cpp` is still live
under `protocol.hart.transmitter`/`protocol.hart.communicator` -- confirmed
still registered in production, not removed because doing so without a
cold-migration story would break existing saved projects using those
component types (a real compatibility blocker, not laziness); Ctrl/
electrical/PLC-Modbus/plugin/Line-Tunnel Property Inspector coverage is
still un-audited property-by-property; no fuzzing, no benchmarks; no
Extension Development Host validation (no GUI available).

`hart_engine_test` (Core, MSVC Release): PASS. `npm test` (Extension):
**459/459** (up from 449; the 10 new cases are the DSL parser's), zero
regressions.

## 2026-09-11 (earlier) — Property Inspector: full bidirectional audit, 3 more real bugs found and fixed

Picked up mid-flight, concurrent, uncommitted work on the same files
(multi-profile HART support, real Signal Graph ports for Input/Output,
`HartExpr::Kind::UserVariable`, and a new whole-circuit textual DSL module
`extension/src/dsl/`). None of it was reverted. A systematic audit (not
"it compiles, ship it") found and fixed 3 more real bugs on top of that
work, all with regression tests, all green (`hart_engine_test` PASS,
`npm test` 449/449 across the whole extension suite, zero regressions):

1. `HartReferenceCatalog::installCommandPrograms(engine, additional)` used
   `unordered_map::emplace` to merge custom commands into the built-ins.
   Since `commandProgramDefinitions()` now auto-generates an "echo body"
   fallback for all 60 catalogued ids, `emplace` silently refused to
   overwrite that fallback for any custom command reusing one of those 55
   ids — it compiled, reported success, and never actually dispatched. Fixed
   to `operator[]` (overwrite).
2. `HartCommandJson::toJson()`'s switch over `HartExpr::Kind` was missing a
   case for the newly-added `UserVariable` kind, silently dropping that
   response step from the serialized JSON instead of marking it unsupported.
3. `extension/src/dsl/dslCommands.ts`'s `dslDocument` was never cleared,
   so `isDslDocumentOpen()` stayed `true` forever after the first use of
   "Editar circuito em DSL" — permanently affecting the Save/Run commit gate
   and making the flag useless for anything that needed to know whether a
   draft was *currently* open. Fixed with a `onDidCloseTextDocument` listener.

Also investigated and resolved the DSL-vs-Inspector editing-authority
conflict explicitly raised by this audit: while an unapplied DSL draft is
open, `PropertyInspectorViewProvider` now goes fully read-only (banner +
server-side mutation rejection) rather than risk a silent edit being
overwritten when the draft is applied.

Full matrix (PASS/PARTIAL/MISSING/BLOCKED_EXTERNAL per domain: Ctrl,
electrical, PLC/Modbus, plugins, Line/Tunnel, `.lssubcircuit`, save/reopen,
RUN policy, undo/redo, DSL integration) with honest reasoning for every
non-PASS item is in `.spec/features/hart-device-engine.md` "Anexo C". Short
version: HART variables/commands and the generic architecture are
genuinely solid and tested; a property-by-property audit of Ctrl/electrical/
PLC-Modbus/plugins/Line-Tunnel was NOT done this session (would need either
a large manual sweep or a Core-IPC-in-Node test harness this session didn't
build) and stays open, honestly, rather than claimed by extrapolation.

## 2026-09-11 (earlier) — Property Inspector: audited, wired end-to-end, two real pre-existing bugs fixed

The previous entry (below) left the DSL tested only in isolation
(`hart_engine_test`) -- it was never actually reachable from
`HartCommunicationComponent`, the component `protocol.hart.serial`/
`protocol.hart.udp` really use. Auditing the Property Inspector (per the
task's own warning not to assume it was done just because a file existed)
surfaced that the whole thing was inert:

- `HartReferenceCatalog::installCommandPrograms()` was never called by
  `HartCommunicationComponent` -- not even the 5 built-in DSL commands from
  the previous session were dispatchable through the component actually used.
- `hartCommandsJson` (the Inspector's Commands editor property) was written
  by `setPropertyValue` but never parsed, compiled, or installed anywhere --
  the Commands section had zero effect on the running device.
- Two real, pre-existing bugs, unrelated to the Inspector UI itself: the
  constructor never read `hartVariablesJson`/`hartCommandsJson` from the
  saved `ComponentParams`, so a saved device's variables/commands reset to
  `"[]"` on every project reopen; and `device.tag` was never populated from
  `m_tag`, so command 0x0B always compared against `plan.id`, never the
  user-configured Tag.

Fixed, extended, and tested end-to-end (not just declared): `HartCommandJson`
(new) bridges the Property Inspector's flat response-step JSON to the
semantic DSL, with compile-time diagnostics surfaced back as a read-only
`hartCommandsStatus`/`hartVariablesStatus` property; `HartDevicePlan
::VariableConfiguration` gained `role`/`type`/`direction`/`readable`/
`runtimeMutable`; a custom command id can now be declared per-device without
mutating the shared profile (`HartPlanCompiler`/`HartEngine::execute` both
updated, carefully, to keep the existing "undeclared command rejected"
isolation guarantee). The Property Inspector sidebar
(`PropertyInspectorViewProvider.ts`) was rewritten: section grouping by
`PropertySchema.group`, `select`/`readonly` editor kinds (previously only
text/number/checkbox -- `propertyFieldKindFromEditor` moved out of `main.ts`
into `batchProperties.ts` so both the canvas sheet and the sidebar share one
dispatch), a real Variables editor (stable id, role/type/direction dropdowns,
readable/writable/runtimeMutable, write-ownership hint for Input), a real
Commands editor (ordered response steps: Hex/Variable/Body/BodySlice,
add/remove/reorder, live compiler status), and a RUN-state structural-edit
guard wired through `coreLifecycle.ts::setSimulationStatus`.

`hart_engine_test` (Core, MSVC Release) and `hartInspectorSections.test.ts`
(Extension, new, 11 cases) both green; host+webview TypeScript compile clean;
no regressions in `batchProperties`/`workspace`/`paletteTree` tests.

**Honestly not done**: `write`/`after` stages and the `If`/`Map`/`ForCodes`
control-flow primitives have no UI editor yet (only flat `resp` steps);
commands can only reference the fixed built-in `HartVarId` set, not a
user-created custom variable; `direction=Input`/`Output` is stored and
validated but does not yet materialize a Signal Graph port; every gate that
requires clicking through a live VS Code Extension Development Host (visual
section layout, structural-edit-during-RUN message on screen, live undo/redo,
`.lssubcircuit` encapsulation, themes/resize) was not reproduced interactively
-- only the underlying logic was tested in isolation. Full detail, including
which of the original contract's 90 sections/14 gates are DONE vs PARTIAL vs
not attempted, is in `.spec/features/hart-device-engine.md` "Anexo B". The
HART Device Engine as a whole is still far from complete: 55 of 60 catalogued
commands have no body, and benchmarks/fuzzing/legacy removal haven't started.

## 2026-09-11 (earlier) — semantic command DSL replaces the command-0/1/3 switch; 0x0B/0x21 implemented for the first time

Prior architecture reconciled: `HartEngine`, `HartReferenceCatalog`
(60-command/11-device import), `HartPlanCompiler`, `HartTransportEndpoint`, and
the serial/UDP Core blocks from the previous agent were all preserved as-is.
The one thing genuinely missing per the corrected plan was the command
*semantics* layer: only commands 0/1/3 had bodies, hardcoded in a native
`switch` inside `HartEngine::execute` — exactly the anti-pattern
`.spec/features/hart-device-engine.md` HART-FR-005/006 forbid, and command 0/1/3's
bodies were wrong (0 returned raw ASCII of `uniqueId`, 1 was missing its unit
byte, 3 was a 4-byte placeholder).

Added, grounded in a direct audit of `hrt_transmitter_v6.py`, `hrt_type.py` and
`hart_command_registry.dart` (not the task's paraphrase alone — see
`.spec/features/hart-device-engine.md` "Anexo A"):

- `core/src/protocols/HartTypeCodec.hpp/.cpp` — `Float32BE`, `UnsignedBE`,
  `PackedAscii` codecs, characterized by round-trip, matching the real HART
  packed-ASCII algorithm.
- `core/src/protocols/HartCommandProgram.hpp/.cpp` — the semantic authoring
  IR (`HartExpr`: RequestBody/BodySlice/HexConstant/Variable/LocalCode;
  `HartStatement`: Append/Set/If-Eq/Map/ForCodes), a cold-path compiler that
  validates body-slice bounds, MAP duplicate keys, ForCodes iteration caps
  (1-64), SET write-ownership, and a static worst-case response-size bound,
  and a bounded hot-path executor (no heap allocation beyond the response
  buffer, no string/name lookup, runs write -> resp -> after in order).
- `HartEngine::setCommandProgramHook()` — a `std::function` extension point so
  `HartEngine.hpp` does not depend on the DSL module; registering a new
  compiled command never requires editing `HartEngine`.
- `HartReferenceCatalog::commandProgramDefinitions()`/`installCommandPrograms()`
  — commands 0x00, 0x01, 0x03, 0x0B, 0x21 expressed entirely via the DSL.
  **0x0B and 0x21 never had a native handler in LasecSimul before this
  change** — they are first implementations via the DSL, not migrations away
  from an existing special case, which is the strongest form of the FASE 19
  proof gate (the special-case count for these two was already zero and stays
  zero).
- Fixed two real bugs while migrating (documented, not silent): command 1 now
  includes the PV unit byte (5 bytes, was 4); command 3 now returns the real
  24-byte layout (loop current + 4x unit/value for PV/SV/TV/QV) with SV/TV/QV
  and loop current as HART's "not used" convention (unit 0xFA + IEEE-754 NaN)
  instead of fabricated numbers, since no range/multivariable model exists yet.
- `HartEngineTest.cpp` extended with byte-exact goldens for all five commands
  (including 0x0B tag match/mismatch and 0x21 known/unknown code) plus a
  direct SET/IF/MAP/ForCodes characterization program and three negative
  compiler tests (non-writable SET target, oversized body slice, runtime
  out-of-bounds slice). `hart_engine_test` (Release, MSVC): **PASS**.

Deliberately not claimed: the remaining 55 catalogued command IDs still have
no body; `HartFunctionRegistry`/tombstones/ENUM-BIT_ENUM codecs are not built;
`installCommandPrograms()`'s hook still re-parses `uniqueId`/re-encodes `tag`
per call instead of caching a per-device snapshot at `loadPlan()` time (small,
bounded, but not the "zero hot-path allocation" ideal); `HartCommunicationComponent`
is not wired to the hook; no Property Inspector UI, benchmark, or fuzz pass was
done. See "Anexo A" for the full gap list.

## 2026-09-10 entry (previous agent)

## Implemented and verified

- `core/src/protocols/HartEngine.hpp/.cpp` provides a bounded, synchronous virtual HART foundation.
- Payload reader/writer operations are bounds checked and report overflow instead of writing past capacity.
- `HartFrameCodec` provides the semantic short-frame format used by the virtual engine (delimiter, polling address, command, payload length, payload, XOR checksum) with malformed-frame and checksum rejection.
- Command handlers and device profiles are registered explicitly; duplicate registrations are rejected.
- `HartPlanCompiler` validates device IDs, profile references, bus names, polling-address range, duplicate IDs, and duplicate addresses on the same bus.
- `HartEngine::loadPlan()` repeats plan validation before resolving profiles, so callers cannot bypass compiler checks.
- Runtime dispatch selects `(bus, pollingAddress)`, allowing the same HART address on different virtual buses. The legacy address-only overload remains compatible and targets `hart-1`.
- Built-in commands 0, 1, and 3 are available when declared by the selected profile; custom declared commands can be supplied through `IHartCommandHandler` without editing the engine.
- `HartReferenceCatalog` now imports the complete 60-ID union from `process_simul`'s transmitter dispatch and command seed tables, plus all 11 reference equipment definitions and their polling addresses/device types. This is a declarative mapping, not yet a claim that every response body has been ported.
- `HartReferenceCatalog::registerGenericProfile()` and `makeDevicePlans()` create the compatible profile and all 11 independent instances for a selected virtual bus. This is the insertion point for project/subcircuit compilation.
- Each `HartDevicePlan` now accepts per-device `CommandConfiguration` entries. An instance can disable a profile-declared command or provide a bounded static response without changing the profile, dispatcher, or another device. Runtime setters cover enable/disable and response replacement; compiler rejects undeclared, duplicate, or oversized overrides.
- `HartTransportEndpoint` now provides the bounded transport-independent request/response boundary. It decodes and validates a frame, dispatches through the selected bus, re-encodes the response, and exposes counters. It deliberately performs no host I/O; serial/UDP adapters must feed it through a shared lifecycle.
- Core now registers `protocol.hart.serial` and `protocol.hart.udp` communication blocks. They own a bounded `HartTransportEndpoint` and expose editable bus/endpoint/address/device/baud-or-port properties. The `hartTransact` IPC verb accepts one bounded frame and returns one encoded response, so the existing Serial Terminal lifecycle or a shared UDP adapter can be connected without a second reader/socket per block.
- Deterministic manual MSVC test passes: `HART engine contracts: PASS`.

Commits: `aea88419`, `cb9b2336`, `db02c53f` (branch `fix/vnext-b-mwdt-hotpath-diagnostics`, pushed to `origin`).

## Deliberately not claimed yet

- This is not the complete HART specification implementation. Framing variants, long-address semantics, timing/turnaround, profile catalog, persistence, and the full command matrix remain open. The Core transport-block/IPC boundary is now present; actual host serial/UDP adapters and UI actions still need integration tests.
- The existing `HartSemanticEndpoint` and `VirtualIndustrialBus` remain unchanged for compatibility; migration to `HartEngine` must be a separate, tested step.
- No production runtime promotion or release was performed for the HART work.

## Required next work

1. Add a profile/catalog adapter for the existing HART component properties without changing the current semantic endpoint behavior.
2. Add a command-level compatibility test comparing the adapter with `HartSemanticEndpoint` for commands 0/1/3.
3. Port the 60 mapped command semantics from the reference through bounded field/function handlers, starting with the golden-vector set; do not use a monolithic switch.
4. Add a declarative profile/instance catalog for the 11 reference devices and bind their process variables.
5. Implement transport-independent request/response integration only after the adapter tests pass; keep real host I/O opt-in.
6. Add the serial-terminal adapter using the existing `CoreUartTransport` lifecycle, with no second serial reader per HART block.
7. Add one shared loopback UDP adapter/multiplexer, bounded by ResourceGovernor; never one socket/thread per device.
8. Add the two transport block manifests/UI wiring and route their frames into `HartTransportEndpoint`.
9. Run the normal Release Core build and existing protocol regression suite before any release decision.
