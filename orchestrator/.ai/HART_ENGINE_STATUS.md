# HART engine implementation status

Last updated: 2026-09-11 (Property Inspector)

## 2026-09-11 — Property Inspector: audited, wired end-to-end, two real pre-existing bugs fixed

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
