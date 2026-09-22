// SPDX-License-Identifier: AGPL-3.0-only
// Copyright © 2026 Praharsh Nagpure — IPD Studio.
// Router adapted for LasecSimul from IPD Studio src/hmi/routePipes.ts at the
// AGPL-3.0-only v0.12.1 commit 8d8157e435d6cfffc5a4218fa45f0c4f186c4a35.
// The same router remains byte-equivalent (apart from its license header) at
// current commit 4b84fb8694bc89985872690366e8be2e32a8db2b. Magnetic docking is
// a LasecSimul-native, framework-independent implementation of the current
// IPD interaction concept, not a copy of its JointJS/PlantNode implementation.

/**
 * Common connection geometry used by electrical/signal wires today and by
 * process/graphical connections in the WYSIWYG editor. This module knows only
 * about points, rectangles, port directions and compatibility categories. It
 * deliberately does not know about the Core, HART, CTRL, TDPS or DOM/SVG.
 */

import type { Point } from "./wireGeometry.js";

export type ConnectionDirection = "left" | "right" | "top" | "bottom";
export type ConnectionPortKind = "electrical" | "signal" | "process" | "graphical" | "any";

export interface ConnectionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ConnectionRouteEnd extends Point {
  direction?: ConnectionDirection;
}

export interface DockPort {
  ownerId: string;
  portId: string;
  point: Point;
  direction?: ConnectionDirection;
  kind?: ConnectionPortKind;
}

export interface MagneticDock {
  port: DockPort;
  distance: number;
}

export interface PortDockIndex {
  readonly cellSize: number;
  readonly cells: ReadonlyMap<string, readonly DockPort[]>;
}

export const DOCK_SCREEN_PX = 18;
const MIN_SCENE_DOCK_RADIUS = 6;
const MAX_SCENE_DOCK_RADIUS = 48;
const ROUTER_PADDING = 8;
const ROUTER_STUB = 12;
const ROUTER_BEND_COST = 48;
const EPSILON = 0.01;

const DX: Record<ConnectionDirection, number> = { left: -1, right: 1, top: 0, bottom: 0 };
const DY: Record<ConnectionDirection, number> = { left: 0, right: 0, top: -1, bottom: 1 };
const OPPOSITE: Record<ConnectionDirection, ConnectionDirection> = {
  left: "right",
  right: "left",
  top: "bottom",
  bottom: "top",
};
const DIRECTIONS: ConnectionDirection[] = ["left", "right", "top", "bottom"];

/** Keeps docking reach visually constant while zooming, as in IPD Studio. */
export function magneticDockRadius(zoom: number): number {
  const scale = zoom > 0 ? zoom : 1;
  return Math.min(MAX_SCENE_DOCK_RADIUS, Math.max(MIN_SCENE_DOCK_RADIUS, DOCK_SCREEN_PX / scale));
}

export function connectionKindsCompatible(a: ConnectionPortKind = "any", b: ConnectionPortKind = "any"): boolean {
  if (a === "any" || b === "any") return true;
  if (a === b) return true;
  // Electrical is the existing broad LasecSimul conductor family. A future
  // process port never connects to it merely because both happen to overlap.
  return (a === "electrical" && b === "signal") || (a === "signal" && b === "electrical");
}

function dockCellKey(x: number, y: number, cellSize: number): string {
  return `${Math.floor(x / cellSize)}:${Math.floor(y / cellSize)}`;
}

/** Spatial hash built once per connection gesture, not once per pointermove. */
export function buildPortDockIndex(ports: readonly DockPort[], cellSize = 64): PortDockIndex {
  if (!(cellSize > 0)) throw new Error("cellSize precisa ser positivo");
  const cells = new Map<string, DockPort[]>();
  for (const port of ports) {
    const key = dockCellKey(port.point.x, port.point.y, cellSize);
    const bucket = cells.get(key);
    if (bucket) bucket.push(port);
    else cells.set(key, [port]);
  }
  return { cellSize, cells };
}

/** Nearest compatible port in a screen-stable magnetic radius. */
export function findMagneticDock(
  point: Point,
  index: PortDockIndex,
  radius: number,
  source?: Pick<DockPort, "ownerId" | "portId" | "kind">
): MagneticDock | undefined {
  const cx = Math.floor(point.x / index.cellSize);
  const cy = Math.floor(point.y / index.cellSize);
  const reach = Math.max(1, Math.ceil(radius / index.cellSize));
  let best: MagneticDock | undefined;
  for (let gx = cx - reach; gx <= cx + reach; gx += 1) {
    for (let gy = cy - reach; gy <= cy + reach; gy += 1) {
      for (const candidate of index.cells.get(`${gx}:${gy}`) ?? []) {
        if (source && candidate.ownerId === source.ownerId) continue;
        if (source && !connectionKindsCompatible(source.kind ?? "any", candidate.kind ?? "any")) continue;
        const distance = Math.hypot(candidate.point.x - point.x, candidate.point.y - point.y);
        if (distance > radius) continue;
        if (!best || distance < best.distance - EPSILON ||
          (Math.abs(distance - best.distance) <= EPSILON && `${candidate.ownerId}/${candidate.portId}` < `${best.port.ownerId}/${best.port.portId}`)) {
          best = { port: candidate, distance };
        }
      }
    }
  }
  return best;
}

function inflate(rect: ConnectionRect, by: number): ConnectionRect {
  return { x: rect.x - by, y: rect.y - by, width: rect.width + 2 * by, height: rect.height + 2 * by };
}

function containsPoint(rect: ConnectionRect, point: Point): boolean {
  return point.x > rect.x + EPSILON && point.x < rect.x + rect.width - EPSILON &&
    point.y > rect.y + EPSILON && point.y < rect.y + rect.height - EPSILON;
}

function rectanglesIntersect(a: ConnectionRect, b: ConnectionRect): boolean {
  return a.x <= b.x + b.width && a.x + a.width >= b.x &&
    a.y <= b.y + b.height && a.y + a.height >= b.y;
}

/** Strict-interior overlap; travelling exactly along an obstacle boundary is valid. */
export function orthogonalSegmentCrossesRect(a: Point, b: Point, rect: ConnectionRect): boolean {
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  return x0 < rect.x + rect.width - EPSILON && x1 > rect.x + EPSILON &&
    y0 < rect.y + rect.height - EPSILON && y1 > rect.y + EPSILON;
}

/** Removes duplicate and collinear interior points without changing endpoints. */
export function collapseConnectionPath(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const point of points) {
    const previous = out[out.length - 1];
    if (previous && Math.abs(previous.x - point.x) < EPSILON && Math.abs(previous.y - point.y) < EPSILON) continue;
    out.push({ x: point.x, y: point.y });
  }
  for (let index = out.length - 2; index >= 1; index -= 1) {
    const a = out[index - 1]!;
    const b = out[index]!;
    const c = out[index + 1]!;
    if ((Math.abs(a.x - b.x) < EPSILON && Math.abs(b.x - c.x) < EPSILON) ||
      (Math.abs(a.y - b.y) < EPSILON && Math.abs(b.y - c.y) < EPSILON)) out.splice(index, 1);
  }
  return out;
}

function stubOut(end: ConnectionRouteEnd, blocks: readonly ConnectionRect[]): Point {
  if (!end.direction) return { x: end.x, y: end.y };
  let x = end.x + DX[end.direction] * ROUTER_STUB;
  let y = end.y + DY[end.direction] * ROUTER_STUB;
  for (let index = 0; index < 15 && blocks.some((rect) => containsPoint(rect, { x, y })); index += 1) {
    x += DX[end.direction] * 8;
    y += DY[end.direction] * 8;
  }
  return { x, y };
}

function sortedUnique(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const result: number[] = [];
  for (const value of sorted) {
    if (result.length === 0 || value - result[result.length - 1]! > EPSILON) result.push(value);
  }
  return result;
}

class MinHeap {
  private readonly keys: number[] = [];
  private readonly values: number[] = [];

  push(key: number, value: number): void {
    this.keys.push(key);
    this.values.push(value);
    let index = this.keys.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.keys[parent]! <= this.keys[index]!) break;
      [this.keys[parent], this.keys[index]] = [this.keys[index]!, this.keys[parent]!];
      [this.values[parent], this.values[index]] = [this.values[index]!, this.values[parent]!];
      index = parent;
    }
  }

  pop(): number | undefined {
    if (this.keys.length === 0) return undefined;
    const top = this.values[0];
    const lastKey = this.keys.pop()!;
    const lastValue = this.values.pop()!;
    if (this.keys.length > 0) {
      this.keys[0] = lastKey;
      this.values[0] = lastValue;
      let index = 0;
      for (;;) {
        const left = 2 * index + 1;
        const right = left + 1;
        let smallest = index;
        if (left < this.keys.length && this.keys[left]! < this.keys[smallest]!) smallest = left;
        if (right < this.keys.length && this.keys[right]! < this.keys[smallest]!) smallest = right;
        if (smallest === index) break;
        [this.keys[smallest], this.keys[index]] = [this.keys[index]!, this.keys[smallest]!];
        [this.values[smallest], this.values[index]] = [this.values[index]!, this.values[smallest]!];
        index = smallest;
      }
    }
    return top;
  }

  get size(): number { return this.keys.length; }
}

/** Dijkstra over an orthogonal visibility grid, with a turn penalty for stable low-bend paths. */
function visibilityGridRoute(a: ConnectionRouteEnd, b: ConnectionRouteEnd, blocks: readonly ConnectionRect[]): Point[] | undefined {
  const sourceStub = stubOut(a, blocks);
  const targetStub = stubOut(b, blocks);
  const xs = [sourceStub.x, targetStub.x, a.x, b.x, (sourceStub.x + targetStub.x) / 2];
  const ys = [sourceStub.y, targetStub.y, a.y, b.y, (sourceStub.y + targetStub.y) / 2];
  for (const rect of blocks) {
    xs.push(rect.x, rect.x + rect.width);
    ys.push(rect.y, rect.y + rect.height);
  }
  const xGrid = sortedUnique(xs);
  const yGrid = sortedUnique(ys);
  if (xGrid.length * yGrid.length > 40_000) return undefined;

  const indexOf = (values: readonly number[], value: number): number => values.findIndex((entry) => Math.abs(entry - value) < EPSILON);
  const sourceX = indexOf(xGrid, sourceStub.x);
  const sourceY = indexOf(yGrid, sourceStub.y);
  const targetX = indexOf(xGrid, targetStub.x);
  const targetY = indexOf(yGrid, targetStub.y);
  if (sourceX < 0 || sourceY < 0 || targetX < 0 || targetY < 0) return undefined;

  const verticalBlocked = xGrid.map((x) => yGrid.map((_, y) => y + 1 < yGrid.length && blocks.some((rect) =>
    x > rect.x + EPSILON && x < rect.x + rect.width - EPSILON &&
    yGrid[y]! >= rect.y - EPSILON && yGrid[y + 1]! <= rect.y + rect.height + EPSILON)));
  const horizontalBlocked = yGrid.map((y) => xGrid.map((_, x) => x + 1 < xGrid.length && blocks.some((rect) =>
    y > rect.y + EPSILON && y < rect.y + rect.height - EPSILON &&
    xGrid[x]! >= rect.x - EPSILON && xGrid[x + 1]! <= rect.x + rect.width + EPSILON)));

  const yCount = yGrid.length;
  const stateOf = (x: number, y: number, direction: number): number => (x * yCount + y) * 4 + direction;
  const distances = new Map<number, number>();
  const previous = new Map<number, number>();
  const heap = new MinHeap();
  const seeds = a.direction ? [DIRECTIONS.indexOf(a.direction)] : [0, 1, 2, 3];
  for (const direction of seeds) {
    const state = stateOf(sourceX, sourceY, direction);
    distances.set(state, 0);
    heap.push(0, state);
  }

  const forbiddenArrival = b.direction ? DIRECTIONS.indexOf(b.direction) : -1;
  let goal = -1;
  while (heap.size > 0) {
    const state = heap.pop()!;
    const currentCost = distances.get(state)!;
    const directionIndex = state % 4;
    const y = ((state - directionIndex) / 4) % yCount;
    const x = ((state - directionIndex) / 4 - y) / yCount;
    if (x === targetX && y === targetY) {
      if (directionIndex === forbiddenArrival && distances.size > seeds.length) continue;
      goal = state;
      break;
    }
    for (let nextDirection = 0; nextDirection < 4; nextDirection += 1) {
      const direction = DIRECTIONS[nextDirection]!;
      if (direction === OPPOSITE[DIRECTIONS[directionIndex]!]) continue;
      let nextX = x;
      let nextY = y;
      let step = 0;
      if (direction === "left") {
        if (x === 0 || horizontalBlocked[y]![x - 1]) continue;
        nextX -= 1;
        step = xGrid[x]! - xGrid[nextX]!;
      } else if (direction === "right") {
        if (x === xGrid.length - 1 || horizontalBlocked[y]![x]) continue;
        nextX += 1;
        step = xGrid[nextX]! - xGrid[x]!;
      } else if (direction === "top") {
        if (y === 0 || verticalBlocked[x]![y - 1]) continue;
        nextY -= 1;
        step = yGrid[y]! - yGrid[nextY]!;
      } else {
        if (y === yGrid.length - 1 || verticalBlocked[x]![y]) continue;
        nextY += 1;
        step = yGrid[nextY]! - yGrid[y]!;
      }
      const cost = currentCost + step + (nextDirection === directionIndex ? 0 : ROUTER_BEND_COST);
      const nextState = stateOf(nextX, nextY, nextDirection);
      if (cost < (distances.get(nextState) ?? Infinity)) {
        distances.set(nextState, cost);
        previous.set(nextState, state);
        heap.push(cost, nextState);
      }
    }
  }
  if (goal < 0) return undefined;

  const path: Point[] = [];
  for (let state: number | undefined = goal; state !== undefined; state = previous.get(state)) {
    const directionIndex = state % 4;
    const y = ((state - directionIndex) / 4) % yCount;
    const x = ((state - directionIndex) / 4 - y) / yCount;
    path.unshift({ x: xGrid[x]!, y: yGrid[y]! });
  }
  return [{ x: a.x, y: a.y }, sourceStub, ...path, targetStub, { x: b.x, y: b.y }];
}

/**
 * Automatic orthogonal route. Obstacles are inflated; endpoint owner boxes
 * remain uninflated so the route can leave/enter through their real ports.
 */
export function routeOrthogonalConnection(
  a: ConnectionRouteEnd,
  b: ConnectionRouteEnd,
  obstacles: readonly ConnectionRect[],
  endpointBoxes: readonly ConnectionRect[] = []
): Point[] {
  if (a.direction && b.direction && b.direction === OPPOSITE[a.direction]) {
    const horizontal = a.direction === "left" || a.direction === "right";
    const offset = horizontal ? Math.abs(a.y - b.y) : Math.abs(a.x - b.x);
    const toward = horizontal ? Math.sign(b.x - a.x) === DX[a.direction] : Math.sign(b.y - a.y) === DY[a.direction];
    const span = horizontal ? Math.abs(b.x - a.x) : Math.abs(b.y - a.y);
    if (offset <= 1 && toward && span <= 120) return [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
  }
  const inflatedObstacles = obstacles.map((rect) => inflate(rect, ROUTER_PADDING));
  const allBlocks = [...inflatedObstacles, ...endpointBoxes];

  // The IPD visibility grid deliberately caps itself at 40k cells. A dense
  // supervisory scene can exceed that cap merely because of distant devices,
  // even when only two nearby obstacles matter to this connection. Grow a
  // deterministic local corridor, then validate the candidate against every
  // obstacle so filtering can never permit a visual collision.
  for (const margin of [64, 128, 256, 512, Number.POSITIVE_INFINITY]) {
    const corridor: ConnectionRect = Number.isFinite(margin)
      ? {
          x: Math.min(a.x, b.x) - margin,
          y: Math.min(a.y, b.y) - margin,
          width: Math.abs(b.x - a.x) + 2 * margin,
          height: Math.abs(b.y - a.y) + 2 * margin,
        }
      : { x: -Infinity, y: -Infinity, width: Infinity, height: Infinity };
    const localObstacles = Number.isFinite(margin)
      ? inflatedObstacles.filter((rect) => rectanglesIntersect(rect, corridor))
      : inflatedObstacles;
    const routed = visibilityGridRoute(a, b, [...localObstacles, ...endpointBoxes]);
    if (!routed) continue;
    const globallyClear = routed.slice(0, -1).every((point, index) =>
      !inflatedObstacles.some((rect) => orthogonalSegmentCrossesRect(point, routed[index + 1]!, rect)));
    if (globallyClear) return collapseConnectionPath(routed);
  }
  return collapseConnectionPath([{ x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y }]);
}

/** Keeps authored waypoints while choosing the obstacle-safe elbow order between them. */
export function orthogonalizeConnectionWaypoints(points: readonly Point[], obstacles: readonly ConnectionRect[]): Point[] {
  if (points.length === 0) return [];
  const blocks = obstacles.map((rect) => inflate(rect, ROUTER_PADDING));
  const result: Point[] = [{ ...points[0]! }];
  for (let index = 1; index < points.length; index += 1) {
    const a = result[result.length - 1]!;
    const b = points[index]!;
    if (Math.abs(b.x - a.x) > 0.5 && Math.abs(b.y - a.y) > 0.5) {
      const horizontalFirst = { x: b.x, y: a.y };
      const verticalFirst = { x: a.x, y: b.y };
      const clear = (middle: Point): boolean => !blocks.some((rect) =>
        orthogonalSegmentCrossesRect(a, middle, rect) || orthogonalSegmentCrossesRect(middle, b, rect));
      result.push(clear(horizontalFirst) || !clear(verticalFirst) ? horizontalFirst : verticalFirst);
    }
    result.push({ ...b });
  }
  return collapseConnectionPath(result);
}
