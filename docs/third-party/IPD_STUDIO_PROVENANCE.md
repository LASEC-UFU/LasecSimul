# IPD Studio provenance

Audit date: 2026-09-21.

## Upstream snapshots

| Purpose | Repository | Local reference | Revision | Version | License |
|---|---|---|---|---|---|
| Current architecture reference | `https://github.com/Coldbari/IPD-Studio.git` | `external-research/ipd-studio-current` (`main`) | `4b84fb8694bc89985872690366e8be2e32a8db2b`, authored 2026-09-18 | package `0.22.0`; 26 commits after tag `v0.22.0` | PolyForm Noncommercial 1.0.0 |
| Historical router source | same upstream | `external-research/ipd-studio-agpl` (detached) | `8d8157e435d6cfffc5a4218fa45f0c4f186c4a35`, authored 2026-08-27 | package `0.12.1`; no `v0.12.1` tag exists upstream | AGPL-3.0-only |

The two directories are research checkouts, not runtime dependencies and not embedded applications.
LasecSimul does not load IPD, JointJS, React, Firebase or an IPD service at runtime.

## Reuse register

| Classification | Upstream source | Destination | What changed | Applicable license |
|---|---|---|---|---|
| `ADAPTED_PORT` | `src/hmi/routePipes.ts` at `8d8157e...` | `extension/src/ui/webview/connectionEngine.ts` | Types adapted to LasecSimul `Point`; DOM/React-free; generic rectangles; deterministic API; local-corridor filtering plus global collision validation for dense scenes; integrated with canonical topology | AGPL-3.0-only; SPDX and upstream copyright retained in file |
| `CONCEPT_ONLY` | current `src/canvas/autoConnect.ts` | docking portion of `connectionEngine.ts` and `main.ts` | Reimplemented against LasecSimul components/pins and native SVG; no JointJS/PlantNode/store code copied | LasecSimul native code; current IPD reference documented |
| `ADAPTED_PORT` | current `src/canvas/alignment.ts` | `extension/src/ui/webview/ipdAlignment.ts` and the geometry submenu in `main.ts` | IPD edge/center alignment and spatial center-distribution algorithms adapted to precomputed LasecSimul symbol bounds; additionally honors non-central rotation origins and flips while preserving the existing selection-order commands | PolyForm Noncommercial 1.0.0; SPDX, upstream copyright and pinned revision retained in the production module |
| `ADAPTED_PORT` | current `src/canvas/keyboardNav.ts` | `extension/src/ui/webview/ipdKeyboardNavigation.ts` and the focusable canvas in `main.ts` | Visual-row Tab order, wrapped forward/backward stepping, Escape release and accessible selection descriptions adapted to LasecSimul components/wires; existing arrow nudge and Inspector commands remain authoritative | PolyForm Noncommercial 1.0.0; SPDX, upstream copyright and pinned revision retained in the production module |
| `ADAPTED_PORT` | current `src/canvas/vertexClean.ts` | `extension/src/ui/webview/ipdVertexClean.ts` and wire-gesture finalization in `main.ts` | Grid snapping, near-axis adoption (including off-grid ports), duplicate removal and collinear micro-bend cleanup adapted to LasecSimul's authored interior vertices; runs only when a corner/segment drag ends | PolyForm Noncommercial 1.0.0; SPDX, upstream copyright and pinned revision retained in the production module |
| `ADAPTED_PORT` | current `src/canvas/lineStyle.ts`, `src/canvas/glyphs.ts`, `src/model/types.ts` | `extension/src/ui/webview/ipdLineStyle.ts`, native SVG rendering/menu and optional `lineClass` persistence | All 16 current line classes, stroke widths/dashes, double jacketed pipe, repeated ISA glyph stations and labels adapted without importing JointJS; existing wires remain native unless explicitly styled | PolyForm Noncommercial 1.0.0; SPDX, upstream copyright and pinned revision retained in the production module |
| `CONCEPT_ONLY` | current `src/canvas/shapes.ts`, `connectionRules.ts` | `wireTopology.ts`, `styles.css` | Port-facing route hints, wide invisible hit areas, family separation | LasecSimul native code |
| `DIRECT_PORT` | current `src/symbols/lib/valves-control.ts`, `src/symbols/lib/valves-manual.ts` | `graphics.control_valve_ipd` (REMOVIDO 2026-09-22 — superseded by `graphics.pid.cv_globe`) | The IPD 64×48 globe-control-valve body, bowtie, stem, diaphragm, positioner and fail marks were transcribed into LasecSimul's declarative vector primitives; runtime React/JointJS code was not imported | PolyForm Noncommercial 1.0.0; upstream notice retained |
| `DIRECT_PORT` | current `src/symbols/lib/vessels.ts`, `src/hmi/widgets/tank.tsx` | `graphics.tank_ipd` (REMOVIDO 2026-09-22 — superseded by `graphics.hmi.tank`) | The IPD tank shell path was ported and combined with LasecSimul's dynamic liquid binding | PolyForm Noncommercial 1.0.0; upstream notice retained |
| `ADAPTED_PORT` | current `src/hmi/widgets/button.tsx`, `lamp.tsx`, `switchw.tsx` | `scripts/generate-graphics-library.mjs` → `graphics.hmi_button`, `graphics.hmi_lamp_button`, `graphics.hmi_toggle` | Panel/bezel, illuminated state and toggle compositions adapted to the native HMI action and binding schema | PolyForm Noncommercial 1.0.0; upstream notice retained |
| `DIRECT_PORT` | current `src/symbols/types.ts`, all usable definitions in `src/symbols/lib/*.ts` | `scripts/generate-ipd-symbol-library.mjs` → 193 `graphics.pid.*` entries and 386 theme icons | Upstream `SymbolDef.render()` implementations are compiled and executed directly; their SVG geometry and parameter combinations become fixed-aspect native packages | PolyForm Noncommercial 1.0.0; source file, pinned commit, license URL and required notice retained per item and SVG |
| `ADAPTED_PORT` | current `src/hmi/theme.ts`, `src/hmi/widgets/{bar,gauge,display,tank,valve,pump,lamp,panel}.tsx`, `src/hmi/Faceplate.tsx`, `src/hmi/AlarmBanner.tsx` | `scripts/generate-ipd-hmi-library.mjs` → 10 `graphics.hmi.*` entries and 20 theme icons | The ISA-101 high-performance palette and type scale were copied value for value; each widget's geometry, proportions and state-colour semantics were transcribed from the upstream React renderer into declarative `simulidePaint` primitives driven by `graphicsBinding.ts`. Upstream React/JointJS runtime code was not imported, and the upstream process simulation (`src/hmi/sim/`: hydraulic network, process model, PI controller, ISA-18.2 alarm lifecycle, history, scenarios) was deliberately NOT ported — the LasecSimul Core remains the only engine | PolyForm Noncommercial 1.0.0; source files, pinned commit, license URL and required notice retained per item and per icon |
| `CONCEPT_ONLY` | current `src/hmi/widgets/tank.tsx`, `src/symbols/lib/valves-control.ts`, `src/symbols/lib/valves-manual.ts`, `src/symbols/lib/vessels.ts` | `graphics.tank`, `graphics.control_valve_industrial` (REMOVIDOS 2026-09-22 — superseded by the inherited IPD libraries) | Independently drawn high-detail supervisory variants informed by the audited device families; no IPD path or component source copied | LasecSimul native code; current IPD reference documented |
| `LASECSIMUL_NATIVE` | n/a | `wireTopology.ts`, `topologyDocument.ts`, host transaction and Core diff | Existing canonical nodes/conductors, explicit junctions, CAS revision and Core transaction preserved | Existing LasecSimul license |

Three earlier rows describe symbols that no longer exist. They were partial transcriptions made
before the full IPD libraries were available, and once those landed the two drawings of the same
valve or vessel were a duplication, not a choice. They were removed on 2026-09-22 and the TDPS
process screens now use the inherited symbols. The rows are kept rather than deleted: this is a
reuse register, and the fact that code was once derived from the upstream is part of the record
even after that code is gone.

The HMI widget row is an `ADAPTED_PORT` and not a `DIRECT_PORT` for a concrete reason. The P&ID
symbols could be ported directly because `SymbolDef.render(cfg)` returns finished SVG, so the
upstream renderer runs at generation time and its markup is frozen. An HMI widget is a function of
the geometry **and of the live value** (`yOf(pv)`, `angOf(pv)`, the colour against the limits);
freezing its render would produce a dead picture at a fixed value. The geometry was therefore
transcribed into the declarative IR, where the value-driven parts are expressions resolved at
runtime by LasecSimul's own binding resolver.

What was deliberately left behind is as much a part of this record as what was taken. The upstream
`src/hmi/sim/` tree is a working process simulator, and none of it was copied: LasecSimul already
has an engine, and FEAT-008 requires visualization to be a projection of telemetry rather than a
second place where the plant is computed. A ported widget therefore has `pinCount: 0`, never
reaches the solver, and carries no process-model property in its schema — a gate in
`graphicsLibrary.test.ts` asserts exactly that.

The historical router implementation was selected intentionally because that revision grants
AGPL-3.0-only rights compatible with the GPL host. The current PolyForm `routePipes.ts` has evolved
beyond the historical file, so current-only changes must not be silently copied into the AGPL port;
they require either an independently reviewable GPL-compatible implementation or a resolved
PolyForm/GPL distribution boundary.

## License handling

- Ported code carries an SPDX identifier, copyright and exact source revision in the production file.
- Current PolyForm geometry and widget composition are present only in the explicitly identified
  `DIRECT_PORT`/`ADAPTED_PORT` rows above. Their catalog records and generated palette SVG metadata
  retain the exact source revision, source files, license URL and required copyright notice.
- These portions remain limited to uses permitted by PolyForm Noncommercial 1.0.0. They are not
  relicensed by the surrounding LasecSimul project license, and their authorship is not removed.
- AGPL-3.0 and GPL-3.0 interoperability must be considered when distributing a combined build; the
  network-source obligation of AGPL applies to the adapted router. This document is technical
  provenance, not legal advice.
- Assets and dependencies are not assumed to inherit the repository license. No raster IPD asset,
  React component or JointJS runtime dependency was imported.

The upstream legal files are copied byte-for-byte under `licenses/ipd-studio/`. A distributable
release that contains these ports must include the applicable AGPL-3.0 and PolyForm Noncommercial
1.0.0 texts, the root notices, and this provenance notice. See `LICENSE-POLICY.md` for the unresolved
GPL/PolyForm combined-distribution boundary.
