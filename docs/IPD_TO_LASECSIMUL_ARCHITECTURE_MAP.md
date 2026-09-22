# IPD Studio to LasecSimul architecture map

Current IPD reference: `4b84fb8694bc89985872690366e8be2e32a8db2b`.

| Capability | IPD implementation | LasecSimul production equivalent | Decision |
|---|---|---|---|
| Canvas/scene | `canvas/Canvas.tsx`, JointJS Paper/Graph, `paperSetup.ts` | one native DOM/SVG Webview in `ui/webview/main.ts` | PORT interaction behavior into the host canvas; do not embed a second application. Direct JointJS adoption remains gated by the GPL/PolyForm distribution boundary |
| Document model | `model/types.ts` (`PlantNode`, `PlantEdge`) | `CanonicalTopologyDocument`, `WebviewComponentModel` | KEEP LASEC; topology already feeds Core and persistence |
| Edge rendering and line classes | `canvas/shapes.ts`, `canvas/lineStyle.ts`, `canvas/glyphs.ts`, wide transparent wrapper | native SVG polylines/outlines/glyph groups plus 16 px segment handles; optional persisted `lineClass` | ADAPTED PORT complete for all 16 stroke classes, double jacketed pipe and repeated ISA glyphs; undefined class deliberately preserves native electrical voltage styling |
| Automatic routing | JointJS manhattan in `shapes.ts`; DOM-free `hmi/routePipes.ts` | `connectionEngine.ts` + `wireTopology.wirePolylinePoints` | ADAPTED PORT from the AGPL v0.12.1 source because it can coexist with the GPL host; current PolyForm implementation is audited and functionally compared |
| Manual vertices | `PlantEdge.vertices`, JointJS tools, `canvas/vertexClean.ts` | `WebviewWireModel.points`, corner/segment handles, `ipdVertexClean.ts` | ADAPTED PORT complete for gesture-end grid snap, off-grid endpoint axis adoption and redundant micro-bend cleanup; native route reset/removal UX retained |
| Magnetic docking | `canvas/autoConnect.ts`, `dropHandling.ts`, `interactions.ts` | indexed pin candidates + drag-to-connect in `main.ts` | Native integration exists; direct current-IPD port is the next parity pass after the license boundary is resolved |
| Port rules | `canvas/connectionRules.ts`, symbol `PortKind` | generic connection kind compatibility; existing stable pin IDs retained | FOUNDATION ADDED; semantic metadata expansion remains |
| Crossing clarity | `canvas/jumpover.ts` | explicit junctions and nonconnecting crossings | KEEP TOPOLOGY; bridge rendering remains a later visual enhancement |
| Spatial indexing | docking grid and optimized jumpover index | `WireSpatialIndex` + `PortDockIndex` | KEEP/EXTEND |
| Selection/marquee | `canvas/interactions.ts` | `main.ts` selection, marquee and mixed group movement | KEEP LASEC |
| Align/distribute | `canvas/alignment.ts` | `ipdAlignment.ts` plus the native context-menu integration | ADAPTED PORT complete for edge/center alignment and spatial center distribution; uses actual transformed LasecSimul bounds, including asymmetric rotation origins, while retaining the legacy selection-order commands |
| Keyboard canvas navigation | `canvas/keyboardNav.ts` | `ipdKeyboardNavigation.ts`, focusable native canvas and live selection announcement | ADAPTED PORT complete for Tab/Shift+Tab visual order, Escape release and no-selection arrow entry; existing 8 px / Shift-fine nudge remains native |
| Undo/redo | Zustand/Zundo store | existing snapshot history for the single canvas | KEEP LASEC |
| Inspector | React panels | current right property dock and catalog schemas | KEEP/EXTEND; never create a second inspector |
| Symbol registry | `symbols/registry.ts`, `symbols/lib/*` | data-driven `PackageDescriptor` + generic renderer | DIRECT/ADAPTED PORT complete for all 193 upstream `SymbolDef` entries, with fixed aspect and per-item provenance |
| Custom SVG/ports | IPD custom symbol workflow | package sanitizer and symbol authoring foundations | ADAPT workflow later; preserve SVG security boundary |
| HMI editor | `hmi/HmiCanvas.tsx`, widget/store modules | native `graphics.*`, bindings and TDPS screens | Direct widget ports started (buttons, illuminated button, toggle, valve, tank); continue porting interaction logic while LasecSimul simulation remains authoritative |
| Runtime/process simulation | `hmi/sim/*` | LasecSimul Core, CTRL, HART, TDPS, UserVariable | DO NOT PORT |
| Serialization | IPD versioned project JSON | `.lsproj`, `.lssubcircuit`, Lasec DSL | KEEP LASEC with backward-compatible optional geometry behavior |

The common boundary is geometry: routing, docking, waypoints, hit testing and line styles are
shared. Electrical/signal/process meaning remains outside the router and pixel crossings never create
logical connectivity.
