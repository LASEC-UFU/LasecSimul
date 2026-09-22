# Graphical symbols

The canonical symbol model and registry are documented in
[`GRAPHICAL_ARCHITECTURE.md`](GRAPHICAL_ARCHITECTURE.md). That document covers `PackageDescriptor`,
generic vector rendering, palette registration, aspect policies and runtime separation.

Current inventory: 242 `graphics.*` catalog entries: 34 curated/native supervisory entries, five
legacy basic shapes, the complete 193-symbol IPD P&ID snapshot and 10 supervisory widgets ported
from the IPD HMI Studio. Piping, signal lines, labels, ISA instrument bubbles, value displays,
controller faceplates and level bars are native — the IPD has no counterpart for them. Vessels,
valves and pumps are the IPD-inherited ones.

**One device family, one symbol.** Hand-drawn native duplicates of vessels, valves and pumps were
removed once the full IPD libraries were available; the TDPS process screens use the inherited
widgets. A device that exists in both a static catalog entry and a `.lsdevice` manifest is a
duplicate ID, not a choice: `devices/library.json` owns its 80 devices through their manifests, and
`deviceUniqueness.test.ts` now asserts that over the real repository data.

Only the VISUAL layer of the HMI Studio was taken. Its process simulator — hydraulic network,
process model, PI controller, ISA-18.2 alarm lifecycle, history and scenarios — was deliberately not
ported: the LasecSimul Core remains the only engine, and every graphical entry keeps `pinCount: 0`
so it can never reach the solver. See [`46-hmi-ipd-incorporacao.md`](46-hmi-ipd-incorporacao.md).

Every IPD-derived entry records its exact source file, pinned commit, PolyForm Noncommercial license
and required notice in the catalog and generated SVG metadata.
