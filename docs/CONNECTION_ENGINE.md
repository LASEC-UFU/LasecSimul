# Common connection engine

## Architecture

`connectionEngine.ts` is a pure geometry kernel. It provides:

- screen-stable magnetic docking radius and a per-gesture spatial hash of ports;
- semantic family compatibility without knowledge of HART, CTRL or TDPS;
- orthogonal obstacle routing using a visibility grid and Dijkstra search;
- progressive local-obstacle corridors with whole-scene collision validation, preventing the
  upstream 40k-cell safety limit from degrading dense scenes into a line through equipment;
- direction-aware port exit stubs and a bend penalty;
- authored-waypoint orthogonalization and deterministic path collapse.

`wireTopology.ts` adapts the kernel to LasecSimul components. It resolves stable endpoint IDs,
derives port orientation from the authored pin position plus rotation/flip, computes transformed
component bounds, and supplies obstacles. `main.ts` owns gesture/render state. The Extension host
remains the authority for atomic topology edits and the Core remains the simulation authority.

## Geometry versus semantics

The router receives only endpoints, directions, rectangles and waypoint coordinates. It never sees
simulation component types or variable/protocol details. The current electrical conductor uses this
geometry first. Future `ProcessPipe` and `GraphicalConnector` objects can share it while retaining
separate model/runtime semantics.

Crossing polylines do not connect. A logical connection exists only through canonical endpoint/node
IDs. T junctions and fan-out therefore remain explicit.

## Route modes and compatibility

- `wire.points` present: manual route. Coordinates persist through `.lsproj`/`.lssubcircuit` as before.
- no `wire.points`: automatic route. It is regenerated from current port locations and obstacles, so
  moving or rotating a component keeps the endpoint attached and reroutes the line.
- legacy projects continue to open without schema changes. Existing persisted vertices remain manual;
  new connections with no authored bend are automatic.
- the connection context menu can reset a manual route to automatic or remove a route point.

## Interaction

Both workflows remain available:

1. click a source pin and click a destination;
2. press a source pin, drag, enter the magnetic radius and release.

During a gesture compatible ports are revealed, the nearest port gets a green docking halo, and the
preview snaps to its exact anchor. The radius is expressed in screen pixels and compensated for zoom.
The final drop reuses `requestConnectEndpoints`; no preview or half-split is persisted.

Connection selection uses wide invisible segment handles, not pixel-perfect line clicks. Existing
segment/corner dragging, keyboard nudging, group movement, undo/redo and save/reopen continue to use
the same history and persistence paths.

## Verification

- `connectionEngine.test.ts`: seven deterministic kernel tests covering zoom-stable docking,
  compatibility, obstacle avoidance, orthogonality, authored waypoints, repeatable output and a
  211-obstacle dense-scene regression.
- `wireTopology.test.ts`: 35 adapter/topology tests, including production-adapter rerouting after
  an endpoint moves around an intervening component.
- `wireGeometry.test.ts`: 20 interaction/persistence geometry tests.
- `npm run test:connections:visual`: three visual states (automatic obstacle route, endpoint moved,
  and persistent manual waypoints).
- `npm run test:connections:e2e`: launches VS Code 1.128, creates a connection by dragging between
  real Webview pins, checks the docking halo, checks every segment for orthogonality, moves an
  endpoint and verifies that the route changes and remains orthogonal.
- `npm run test:connections:performance`: reproducible 200-object/120-connection routing benchmark.
  On Node 24.19.0 / Ryzen 9 5950X a recorded run completed in 139.88 ms total (1.166 ms per connection); this is
  kernel routing time, not an end-to-end frame-rate claim.
