# Third-party notices

## IPD Studio — current graphical ports

Portions of the graphical/HMI library are direct or adapted ports from IPD Studio revision
`4b84fb8694bc89985872690366e8be2e32a8db2b`.

Copyright © 2026 Praharsh Nagpure (https://github.com/Coldbari/IPD-Studio)

Those identified portions are licensed under the PolyForm Noncommercial License 1.0.0:
https://polyformproject.org/licenses/noncommercial/1.0.0

Affected generated symbols include the complete 193-entry `graphics.pid.*` snapshot plus
`graphics.control_valve_ipd`, `graphics.tank_ipd`, `graphics.hmi_button`,
`graphics.hmi_lamp_button`, and `graphics.hmi_toggle`. The current-IPD alignment/distribution and
keyboard-canvas navigation algorithms are also adapted in `ipdAlignment.ts` and
`ipdKeyboardNavigation.ts`; authored-wire vertex cleanup is adapted in `ipdVertexClean.ts`. Exact
IPD line classes, double-line rendering and ISA glyph placement are adapted in `ipdLineStyle.ts`.
Exact source files, classification and adaptation details are recorded in
`docs/third-party/IPD_STUDIO_PROVENANCE.md` and in each generated catalog package's `provenance`
field. Licensed palette SVG files also embed that record in their `<metadata>` element.

These portions are not relicensed by the surrounding LasecSimul project license. Use is limited to
the permissions and restrictions of PolyForm Noncommercial 1.0.0.

## IPD Studio — historical router port

The connection router port deliberately comes from the historical AGPL-3.0-only revision because
that license can coexist with the GPL host. Its provenance is documented in
`docs/third-party/IPD_STUDIO_PROVENANCE.md` and in the production source file that contains the port.

## SimulIDE — behavioural reference for wire interaction

`extension/src/ui/webview/wireRouting.ts` reproduces the wire-drawing behaviour of SimulIDE
(Santiago González and contributors; AGPL-3.0-or-later for the author's files and
GPL-3.0-or-later for other contributions, per the program's `copyright.txt`). The module is an
independent implementation written from an analysis of the program's behaviour and source code; it
contains no SimulIDE source text. The analysis is recorded in
`docs/48-reengenharia-conexoes-simulide.md`.

## OpenPLC Editor — IEC 61131-3 editor running inside LasecSimul

The PLC editor (`lasecsimul.openplcEditor`) is the frontend of OpenPLC Editor
(Autonomy-Logic/openplc-editor, tag `v4.2.8`, commit `1b1e4b64db79e84aa437b5cc3054ee923b8893a5`,
GPL-3.0), built from that pinned source by `scripts/build-openplc-workspace.js` (pin in
`scripts/openplc-workspace-pin.json`). The OpenPLC source is not stored in this repository. The
build adds the files in `plc/openplc-workspace/overlay` (VS Code platform adapter, entry point, SFC
editor, webpack configuration and the source patches listed in
`overlay/patch-loader.cjs`, applied at build time) and produces
`extension/media/openplc-workspace/`. The extension host reuses OpenPLC's project, POU and library
services and its Structured Text transpiler from the same build. Copyright © Autonomy Logic and the
OpenPLC Project contributors. The combined work is distributed under GPL-3.0-or-later, compatible
with the upstream GPL-3.0 terms; the corresponding source is the pinned upstream tag plus the
overlay in this repository.

The bundle also contains, from OpenPLC Editor's dependency tree: React, React Flow (@xyflow/react),
Radix UI, Tailwind CSS, Zustand, Immer, dnd-kit, Monaco Editor and STruC++'s browser language
server (`strucpp` npm package `v0.5.13`, GPL-3.0-or-later). Their license texts ship with the
bundle in `media/openplc-workspace/webview/*.LICENSE.txt` and `assets/*.LICENSE.txt`. The Inter
and Poppins fonts (SIL Open Font License 1.1) are packaged from `@fontsource/inter` 5.2.8 and
`@fontsource/poppins` 5.2.7 because the webview cannot load Google Fonts.

The four IEC libraries shown in the editor (Additional Function Blocks, Standard Function Blocks,
Standard Functions, OSCAT Basic) are the `.stlib` archives of the STruC++ release that LasecSimul
already ships (`scripts/strucpp-pin.json`), the same set OpenPLC Editor 4.2.8 bundles.
