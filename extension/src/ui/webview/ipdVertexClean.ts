// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright © 2026 Praharsh Nagpure — IPD Studio. Noncommercial use only;
// commercial use requires a paid license (see licenses/ipd-studio/COMMERCIAL-LICENSE.md).
// Adapted for LasecSimul from IPD Studio src/canvas/vertexClean.ts at
// 4b84fb8694bc89985872690366e8be2e32a8db2b.

import type { Point } from "./wireGeometry.js";

const snap8 = (value: number): number => Math.round(value / 8) * 8 || 0;

function segmentDistance(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0
    ? 0
    : Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(start.x + t * dx - point.x, start.y + t * dy - point.y);
}

/**
 * Cleans authored wire vertices at gesture end. Besides grid snapping, a
 * vertex adopts a nearby neighbor axis before redundant bends are removed.
 * This is what heals tiny permanent jogs against off-grid component ports.
 */
export function cleanIpdWireVertices(
  raw: readonly Point[],
  source: Point | null,
  target: Point | null,
  axisTolerance = 6,
  lineTolerance = 3,
): Point[] {
  let points = raw.map((point) => ({ x: snap8(point.x), y: snap8(point.y) }));

  for (let pass = 0; pass < 2; pass += 1) {
    points = points.map((point, index) => {
      const neighbors = [index === 0 ? source : points[index - 1]!, index === points.length - 1 ? target : points[index + 1]!];
      let { x, y } = point;
      for (const neighbor of neighbors) {
        if (!neighbor) continue;
        if (Math.abs(x - neighbor.x) <= axisTolerance) x = neighbor.x;
        if (Math.abs(y - neighbor.y) <= axisTolerance) y = neighbor.y;
      }
      return { x, y };
    });
  }

  let removed = true;
  while (removed) {
    removed = false;
    for (let index = 0; index < points.length; index += 1) {
      const previous = index === 0 ? source : points[index - 1]!;
      const next = index === points.length - 1 ? target : points[index + 1]!;
      const vertex = points[index]!;
      const onAnchor =
        (previous && previous.x === vertex.x && previous.y === vertex.y) ||
        (next && next.x === vertex.x && next.y === vertex.y);
      const collinear = previous && next && segmentDistance(vertex, previous, next) <= lineTolerance;
      if (!onAnchor && !collinear) continue;
      points.splice(index, 1);
      removed = true;
      break;
    }
  }
  return points;
}
