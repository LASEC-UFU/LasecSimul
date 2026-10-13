# Connection engine

Rewritten on 2026-10-13 to follow SimulIDE's wire behaviour. The investigation, the before/after
measurements and the remaining limitations are in
[48-reengenharia-conexoes-simulide.md](48-reengenharia-conexoes-simulide.md).

## Architecture

| Module | Responsibility |
|---|---|
| `wireRouting.ts` | Pure geometry: the draft being drawn, resolving a stored route against the current endpoints, path simplification. No DOM, no `vscode`. |
| `wireTopology.ts` | Pure topology: junction nodes, splitting a wire, connecting endpoints, collapsing degree-2 nodes, electrical projection for the Core. |
| `connectionEngine.ts` | Magnetic docking of ports, and the obstacle-avoiding orthogonal router. The router runs only on request. |
| `main.ts` | Pointer/keyboard events, the transient gesture state (`wireDraft`), DOM updates. |
| `extension.ts` | Host: persistence and Core synchronisation of whatever the Webview committed. |

## Rules

1. **A wire is what was drawn.** `wire.points` holds the corners. `wirePolylinePoints` resolves them
   against the current pin/node positions and never invents a path. The same input gives the same
   output in the Webview and in the Extension host.
2. **The elbow has memory.** Between the last fixed point and the cursor there is at most one
   corner. Its first-leg axis is chosen when the cursor leaves alignment with that point (dominant
   axis) and stays locked until the cursor realigns.
3. **Moving an endpoint moves only the end.** When a pin or node moves, the neighbouring corner
   slides along the next segment's axis; the rest of the route stays. The result does not depend on
   the path the endpoint took, so dragging and coming back restores the original route. What is on
   screen when the gesture ends is stored.
4. **Crossing is not connecting.** A connection exists only through endpoint/node ids.

## Interaction

| Gesture | Result |
|---|---|
| Click a pin, a wire or a junction | Starts a wire there |
| Move | The preview follows; it is exactly the wire a click would create |
| Click empty canvas | Fixes the current corner (on a straight stretch, adds a waypoint) |
| Click or release on a pin, junction or wire | Finishes; on a wire, creates the junction at the green marker |
| Press a pin and drag | Same wire; releasing on empty canvas fixes the corner and keeps drawing |
| Right click or Backspace | Steps back one fixed corner; cancels when none is left |
| Esc | Cancels |
| Drag a segment / a corner / a junction | Moves it; neighbours stretch |
| Drag a component | Grid steps (Alt for free movement); attached wire ends follow |
| Ctrl+click a wire, Delete | Removes it; a junction left with two wires is merged away |

Committing a wire, deleting a wire, undo and redo are applied in the Webview and reach the Host
through the ordinary `projectChanged` message. The Host does not echo that state back.

## Obstacle-avoiding router

`autoRoutedWirePoints` runs the router of `connectionEngine.ts` once and returns corners to store.
It is used by the wire context menu ("Rotear desviando de componentes") and when opening a project
saved before explicit routes (`projectCommands.ts::freezeLegacyAutomaticRoutes`), so those projects
keep their previous appearance. Files saved from now on carry `visual.wireRoutes: "explicit"`.

## Verification

- `wireRouting.test.ts`, `wireTopology.test.ts`, `wireGeometry.test.ts`, `connectionEngine.test.ts`
  (part of `npm test`).
- `npm run test:wires:e2e`: the 20 comparison scenarios in real VS Code with real pointer input.
- `npm run test:wires:measure -- <label>`: elbow flips, preview fidelity, route stability, commit
  latency and handler cost, written to `test/e2e/artifacts/wire-interaction/<label>/`.
- `npm run test:connections:e2e`, `npm run test:connections:visual`,
  `npm run test:connections:performance`: unchanged.
