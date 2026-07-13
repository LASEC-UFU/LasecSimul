/**
 * Geometria afim comum do editor.
 *
 * A posição persistida do componente é a origem local do item, como `QGraphicsItem::pos()`.
 * Espelhamento e rotação acontecem em coordenadas locais, em torno de um único pivô; só depois
 * o ponto é transladado para a cena. Renderer, hit-test e fios devem usar estas funções.
 */

import { Point, snapCoordinate } from "./wireGeometry.js";

export interface GeometrySize {
  width: number;
  height: number;
}

export interface GeometryRect extends Point, GeometrySize {}

export interface LocalTransform {
  size: GeometrySize;
  rotation: 0 | 90 | 180 | 270;
  flipH?: boolean;
  flipV?: boolean;
  origin?: Point;
}

export interface SceneTransform extends LocalTransform {
  position: Point;
}

export function transformOrigin(transform: LocalTransform): Point {
  return transform.origin ?? { x: transform.size.width / 2, y: transform.size.height / 2 };
}

export function mirrorLocalPoint(point: Point, transform: LocalTransform): Point {
  const pivot = transformOrigin(transform);
  return {
    x: transform.flipH ? 2 * pivot.x - point.x : point.x,
    y: transform.flipV ? 2 * pivot.y - point.y : point.y,
  };
}

export function rotateLocalPoint(point: Point, transform: LocalTransform): Point {
  const pivot = transformOrigin(transform);
  const dx = point.x - pivot.x;
  const dy = point.y - pivot.y;
  switch (transform.rotation) {
    case 90: return { x: pivot.x - dy, y: pivot.y + dx };
    case 180: return { x: pivot.x - dx, y: pivot.y - dy };
    case 270: return { x: pivot.x + dy, y: pivot.y - dx };
    default: return { x: point.x, y: point.y };
  }
}

/** Mesma ordem de `QGraphicsItem`: transform local (flip), rotação e translação de cena. */
export function transformLocalPoint(point: Point, transform: LocalTransform): Point {
  return rotateLocalPoint(mirrorLocalPoint(point, transform), transform);
}

export function localToScene(point: Point, transform: SceneTransform): Point {
  const local = transformLocalPoint(point, transform);
  return { x: transform.position.x + local.x, y: transform.position.y + local.y };
}

export function sceneToLocal(point: Point, transform: SceneTransform): Point {
  const pivot = transformOrigin(transform);
  const translated = { x: point.x - transform.position.x, y: point.y - transform.position.y };
  const inverseRotation = ((360 - transform.rotation) % 360) as 0 | 90 | 180 | 270;
  const unrotated = rotateLocalPoint(translated, { ...transform, rotation: inverseRotation, flipH: false, flipV: false, origin: pivot });
  return mirrorLocalPoint(unrotated, { ...transform, rotation: 0, origin: pivot });
}

export function transformedLocalBounds(transform: LocalTransform): GeometryRect {
  const corners = [
    { x: 0, y: 0 },
    { x: transform.size.width, y: 0 },
    { x: transform.size.width, y: transform.size.height },
    { x: 0, y: transform.size.height },
  ].map((point) => transformLocalPoint(point, transform));
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

export function svgLocalTransform(transform: LocalTransform): string {
  const pivot = transformOrigin(transform);
  return `translate(${pivot.x} ${pivot.y}) rotate(${transform.rotation}) scale(${transform.flipH ? -1 : 1} ${transform.flipV ? -1 : 1}) translate(${-pivot.x} ${-pivot.y})`;
}

export function snapScenePoint(point: Point, gridSize: number): Point {
  return { x: snapCoordinate(point.x, gridSize), y: snapCoordinate(point.y, gridSize) };
}
