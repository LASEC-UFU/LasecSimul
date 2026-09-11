# HART engine implementation status

Last updated: 2026-09-10

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
- Deterministic manual MSVC test passes: `HART engine contracts: PASS`.

Commits: `aea88419`, `cb9b2336`, `db02c53f` (branch `fix/vnext-b-mwdt-hotpath-diagnostics`, pushed to `origin`).

## Deliberately not claimed yet

- This is not the complete HART specification implementation. Serial/TCP transports, framing variants, long-address semantics, timing/turnaround, profile catalog, UI/editor integration, persistence, and the full command matrix remain open.
- The existing `HartSemanticEndpoint` and `VirtualIndustrialBus` remain unchanged for compatibility; migration to `HartEngine` must be a separate, tested step.
- No production runtime promotion or release was performed for the HART work.

## Required next work

1. Add a profile/catalog adapter for the existing HART component properties without changing the current semantic endpoint behavior.
2. Add a command-level compatibility test comparing the adapter with `HartSemanticEndpoint` for commands 0/1/3.
3. Port the 60 mapped command semantics from the reference through bounded field/function handlers, starting with the golden-vector set; do not use a monolithic switch.
4. Add a declarative profile/instance catalog for the 11 reference devices and bind their process variables.
5. Implement transport-independent request/response integration only after the adapter tests pass; keep real host I/O opt-in.
6. Run the normal Release Core build and existing protocol regression suite before any release decision.
