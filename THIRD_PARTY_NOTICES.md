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
