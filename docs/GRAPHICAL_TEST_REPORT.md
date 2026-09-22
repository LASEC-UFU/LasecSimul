# Graphical test report

Validated on 2026-09-21 after compiling the extension with Node 24:

- `npm --prefix extension run compile` — passed.
- `npm --prefix extension test` — passed.
- `graphicsLibrary.test.ts` — 21 passed: palette categories, zero-pin behavior, vector rendering,
  fixed/variable aspect policy, circular ISA bubble under hostile resize, open-path fill safety,
  Inspector schema, tank 0/50/100%, valve states, pump/motor states, instruments, labels, flow
  arrows, HMI operator schemas, alarm states, palette icons, direct-port provenance and all 193 IPD
  P&ID entries carrying their PolyForm notice/source commit.
- `componentGeometry.test.ts` — 8 passed, including proportional device resize and independent
  elastic resize for pipes/lines.
- `graphicsBinding.test.ts` — 13 passed: Float32/boolean bindings, scaling/offset, engineering
  range, missing sources, channels, stable IDs, formatting, and `graphics.*` projection.
- `graphicsAction.test.ts` — 7 passed: typed values, stable target/property validation, toggle,
  momentary, increment, numeric input, clamping and operator-type isolation.
- `ipdAlignment.test.ts` — 7 passed: visual left/right/top/bottom edges, grid-snapped centers,
  spatial center distribution, 90-degree dimension exchange and asymmetric transformed bounds.
- `ipdKeyboardNavigation.test.ts` — 7 passed: visual-row ordering, deterministic ties, wires in the
  traversal, wrapped Tab/Shift+Tab stepping and bilingual identity/rotation/position announcements.
- `ipdVertexClean.test.ts` — 7 passed: real bends retained, grid snap, near-axis healing, off-grid
  port-axis adoption, chained vertices, duplicate/anchor removal and free-end simplification.
- `ipdLineStyle.test.ts` — 8 passed: complete 16-class registry, exact representative widths and
  dash patterns, double jacketed pipe, process-family classification, strict persistence values,
  bilingual labels, stable CSS names and ISA glyph stations clear of endpoints/corners.
- `tdpsProcessScreens.test.ts` — 10 passed: exactly 24 processes, no bitmap backgrounds, native
  screen composition, the four detailed Basic Flow HMI devices, volumetric piping, real bindings,
  z-order, save/reopen, vector bounds, and intact simulation.
- `graphicsDslRoundTrip.test.ts` — 6 passed: semantic graphics survive DSL round-trip, including
  appearance, binding, stable IDs, grouping metadata and multi-object scenes.
- `wireGeometry` tests — 20 passed, including orthogonal routes, elbows, vertices and persistence
  helpers used by native wiring.
- `connectionEngine.test.ts` — 7 passed: magnetic radius independent of zoom, nearest compatible
  docking target, process/signal family isolation, obstacle routing, authored waypoints and
  deterministic orthogonal output, including a 211-obstacle dense-scene regression.
- `wireTopology.test.ts` — 37 passed after integrating automatic routing into the canonical topology
  adapter, including an obstacle route recalculated after an endpoint move, style-preserving wire
  splits and protection against collapsing a two-style transition.

The complete extension test command also passed the existing catalog, HART, Inspector, serializer,
subcircuit, DSL, schematic, importer, and PLC regression suites.

Latest full run: 56 suites using the shared test runner reported 653 passed and 0 failed, in addition
to the standalone pretest/project checks in the same successful `npm test` command.

The pinned IPD upstream was also validated directly:

- `npm run build` — passed (540 modules transformed);
- `npm run license:check` — passed for 577 packages: 106 runtime and 471 development, with no denied
  license;
- `npm test -- --reporter=dot` — 4,260 passed, 7 skipped and 1 failed out of 4,268. The one failure
  is the upstream `tests/export/csvSafety.test.ts` path scan using `split('/src/')` on Windows; it
  returned an undefined path entry and did not indicate a product/editor failure. React `act(...)`
  warnings were also emitted by upstream HMI tests and remain upstream test hygiene work.
- `npm run license:check-ipd` in LasecSimul — six preserved legal files match their pinned SHA-256
  byte-for-byte.

Visual QA was rendered through the same catalog + Webview SVG path into
`extension/test/e2e/artifacts/graphics-library-gallery.png`. The audit caught and fixed open P&ID
paths being accidentally filled, a self-intersecting check-valve body, and heat-exchanger tubes
escaping the shell. The gallery generator is `extension/test/e2e/render-graphics-gallery.cjs`.

All 24 complete process screens were also rendered in one audit sheet at
`extension/test/e2e/artifacts/tdps-process-gallery.png`; its reproducible generator is
`extension/test/e2e/render-tdps-process-gallery.cjs`.

The first curated high-fidelity screen, `Vazao Linear Simples`, is rendered independently at
`extension/test/e2e/artifacts/tdps-basic-flow-screen.png` for full-size visual review.

All 16 current-IPD line classes are rendered in
`extension/test/e2e/artifacts/ipd-line-style-gallery.png`; the reproducible command
`npm --prefix extension run test:line-styles:visual` verifies the compiled stroke/glyph registry and
shows orthogonal corners, exact dash patterns, repeated ISA marks and the true two-stroke jacketed
pipe on one inspection sheet.

Connection-specific visual and editor-level validation also passed:

- `npm --prefix extension run test:connections:visual` generated
  `extension/test/e2e/artifacts/connection-engine-routing.png` with automatic obstacle avoidance,
  endpoint rerouting and preserved manual waypoints.
- `npm --prefix extension run test:connections:e2e` launched VS Code 1.128.0 and generated
  `extension/test/e2e/artifacts/connection-editor-e2e.png` after a real pin drag, magnetic docking,
  connection creation and endpoint move; all captured polyline segments were orthogonal before and
  after the move. The same editor session entered RUN, activated a real HMI toggle, updated
  `source.voltage` through the host property authority and verified the new value in the Inspector.

The repository-wide `npm --prefix extension run test:e2e` currently stops on its pre-existing
palette selector (`.palette-item[title^="plc.instance"]`) before reaching the canvas. This is a stale
expectation in that older scenario, not a failure in the dedicated connection E2E above; it remains
recorded here instead of being hidden by the new focused test.

The reproducible connection stress command
`npm --prefix extension run test:connections:performance` routed 120 connections through a scene
with 200 obstacles in 139.88 ms total / 1.166 ms average on Node 24.19.0 and an AMD Ryzen 9 5950X.
It also validates that every result remains orthogonal; the number is kernel-only and does not claim
an editor frame rate.
