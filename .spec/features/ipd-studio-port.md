---
id: FEAT-015
kind: feature
status: active
dependsOn: [FEAT-008, ARCH-001, ARCH-006]
supersedes: []
---

# IPD Studio graphical/editor port

Status date: 2026-09-21. Upstream is pinned to
`4b84fb8694bc89985872690366e8be2e32a8db2b` (`0.22.0`, 26 commits after tag `v0.22.0`) under
PolyForm Noncommercial 1.0.0.

## Goal

Port the useful current IPD Studio graphical/editor implementation into the single LasecSimul
Webview while preserving LasecSimul's Core, signal graph, HART, TDPS, PLC, DSL, subcircuits,
Inspector and persistence. Do not embed IPD as an iframe or operate a second authoritative canvas.

## Phase ledger

| Phase | Status | Evidence |
|---|---|---|
| 0 — complete repository audit | In progress | All top-level areas inventoried: 305 `src`, 7 `public`, 5 `examples`, 297 `tests`, 47 `e2e`, 17 `docs` files; build and 4,268 upstream tests executed |
| 1 — licensing foundation | Implemented with distribution caveat | Exact IPD legal files under `licenses/ipd-studio`; root notices/policy; per-item provenance. GPL/PolyForm single-work distribution remains unresolved |
| 2 — editor core | Substantially present, parity audit pending | Single host canvas supplies zoom/pan, grid/snap, selection, marquee, transformations, clipboard, undo/redo, grouping and z-order; current-IPD alignment/distribution and accessible keyboard traversal are adapted and tested |
| 3 — connections | Implemented baseline, current-IPD delta pending | AGPL router port, magnetic docking, obstacle routing, draggable vertices, gesture-end vertex cleanup, all 16 current-IPD line classes with ISA glyphs, rerouting, persistence and E2E coverage |
| 4 — symbols | Implemented | All 193 upstream `SymbolDef` entries imported plus curated HMI devices; fixed aspect prevents deformation |
| 5 — Inspector | Implemented baseline | Schema-driven graphical geometry, appearance, binding and action fields use the existing right Inspector |
| 6 — signal binding | Implemented baseline | Float/bool projection, scaling, limits, units, stable component IDs and runtime updates |
| 7 — HMI | In progress | Actual IPD-derived button/toggle/valve/tank elements, illuminated buttons, slider/actions and TDPS pilot screen |
| 8 — persistence | Implemented baseline | Graphics, routes, bindings, actions and layers survive parse/serialize and DSL round trips |
| 9 — legacy replacement | Not started | No deletion before parity tests prove one authoritative implementation |
| 10 — full validation | In progress | 56 shared-runner suites / 653 tests pass, plus standalone checks; visual galleries and upstream build/tests/license gate recorded in reports |

## Non-negotiable boundaries

- IPD copyrights and Required Notice remain attached to direct/adapted ports.
- No Firebase credential, token, hosted project identifier or private configuration is imported.
- LasecSimul simulation remains authoritative; IPD's simulation store is not a competing runtime.
- The root GPL license cannot be replaced by a noncommercial restriction over third-party GPL code.
  See `LICENSE-POLICY.md` before any public combined distribution.

## Next implementation slice

Port and test current-IPD connection refusal feedback into the existing host canvas. Preserve the
PolyForm source notice or implement against
the AGPL/native boundary only where documented.

## Aceitação

- every direct/adapted current-IPD artifact retains source file, pinned commit, license URL and
  Required Notice;
- all imported device symbols keep a fixed aspect ratio under resize unless the upstream component
  is intrinsically elastic;
- editor behavior is integrated into the single LasecSimul canvas, Inspector and project format;
- old projects reopen without silently losing components, routes, bindings, layers or actions;
- no hosted credential or cloud account configuration enters the product;
- public distribution is blocked until the GPL/PolyForm combined-work boundary described in
  `LICENSE-POLICY.md` is resolved or reviewed;
- upstream and LasecSimul test results, skipped tests and genuine failures are recorded without
  hiding platform-specific upstream failures.
