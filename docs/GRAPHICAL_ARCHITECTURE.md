# Native Graphical architecture

The Graphical library is implemented as ordinary, zero-pin LasecSimul catalog components under
`graphics.*`. This keeps one canvas, one selection/drag/rotation/undo/redo/persistence path, and
ensures graphics never enter the electrical/signal solver.

The catalog is data-driven: each symbol declares a `PackageDescriptor` with vector shapes, bounds,
styles, state projections, property schema, palette folder, and icon. The generic renderer in
`extension/src/ui/webview/componentSymbols.ts` and `simulidePaint.ts` handles the same primitives
for all symbols; new symbols do not require a renderer class.

## Resize invariant

Every `simulidePaint` graphic declares one of two explicit aspect policies:

- `fixed`: process devices (vessels, valves, pumps, motors, ISA instruments, indicators and flow
  elements) are mapped first to an approved `referenceSize` and then resized with one uniform
  factor. Extra room is centered, so circles stay circular, vessel heads keep their curvature and
  line angles/stroke relationships are never distorted. The editor exposes corner handles only.
- `variable`: genuinely elastic scene elements (straight pipe, signal line, generic equipment,
  connector arrow and label) recompute their geometry from the instance width/height and retain all
  eight resize handles.

This policy is enforced both in `simulidePaint.ts` (rendering) and `componentGeometry.ts`/`main.ts`
(interaction), so malformed legacy dimensions cannot deform the rendered device and new edits
cannot introduce a different aspect ratio.

Palette path: `Miscellaneous/Miscelâneos -> Graphical/Gráfico -> category`. Current categories cover
basic shapes, piping, tanks/vessels, valves, pumps/motors, instrumentation, indicators, flow,
process equipment, connections, and labels.

Instances reuse the standard component model for selection, movement, rotation, copy/paste,
serialization, save/reopen, z-order/layer in TDPS scenes, and Inspector properties. Dynamic state is
projected into generic numeric/text/fill/visible expressions. Bindings are protocol-independent and
refer to stable source component IDs; HART, CTRL, and TDPS remain separate simulation concerns.

The implementation intentionally does not add draw.io as a runtime dependency. Draw.io is an
external reference and its audited primitive vocabulary informed the native schema.
