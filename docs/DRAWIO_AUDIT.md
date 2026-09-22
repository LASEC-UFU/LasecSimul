# Draw.io audit

Audited upstream: `https://github.com/jgraph/drawio`, branch `dev`, commit
`744cb5420fdf126efd7a09b1d7082ca3e12c0841`, checked out at
`C:\SourceCode\external-research\drawio` on 2026-09-21.

The current tree is `src/main/webapp/stencils/pid/*.xml`. It contains 24 P&ID stencil files and
478 `<shape>` definitions. The full machine-readable inventory is in `drawio-symbol-inventory.json`;
the grouped report is `DRAWIO_SYMBOL_INVENTORY.md`.

## Representation found

Each file contains `<shape>` definitions with a name, nominal width/height, optional connection
constraints, and drawing split into background and foreground. The useful primitive subset is
declarative: move, line, arc, close, rect, ellipse, path/polyline, fill/stroke, and constraints.
This corresponds to the existing LasecSimul `PackageDescriptor`/`PackageShape` and
`simulidePaint` data model.

## Native adaptation

The production implementation uses the existing generic vector renderer and JSON catalog entries.
It does not embed draw.io, load its XML at runtime, import its editor, or ship its stencil files.
Pipe routing remains a LasecSimul object and bindings resolve through existing component readouts
by stable component ID.
