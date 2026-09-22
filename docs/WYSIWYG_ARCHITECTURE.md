# WYSIWYG editor architecture

LasecSimul uses one editor, not an embedded IPD application. The existing Webview supplies Palette,
Canvas and Inspector for schematic and zero-pin `graphics.*` objects alike.

The production flow is:

`catalog registry -> palette tree -> WebviewComponentModel -> native SVG renderer -> selection/transform -> right Inspector -> project serializer -> runtime bindings`

Key invariants:

- circuit devices and supervisory graphics share selection, drag, resize, rotate, copy/paste,
  marquee, undo/redo, zoom/pan and persistence;
- graphical objects never enter electrical or process simulation merely because they are visible;
- fixed-aspect industrial devices scale uniformly; only declared elastic graphics stretch by axis;
- the right Inspector is schema-driven and remains the sole property editor;
- dynamic graphics use stable component-ID bindings and targeted runtime property projection;
- the common connection geometry is independent of signal/process semantics.

The current native symbol and binding details are documented in
[`GRAPHICAL_ARCHITECTURE.md`](GRAPHICAL_ARCHITECTURE.md) and
[`GRAPHICAL_BINDINGS.md`](GRAPHICAL_BINDINGS.md). Current TDPS coverage is in
[`TDPS_WYSIWYG_COVERAGE.md`](TDPS_WYSIWYG_COVERAGE.md).

Implemented now: data-driven vector symbols, non-deforming resize, native TDPS scenes, graphical
bindings, automatic/manual orthogonal wires, magnetic pin docking, connection hit areas and the
existing edit/run simulation lifecycle, multi-selection/grouping, alignment, z-order commands and
generic operator Actions. The compiled-free custom SVG port editor remains a genuine later phase;
it is not claimed complete.
