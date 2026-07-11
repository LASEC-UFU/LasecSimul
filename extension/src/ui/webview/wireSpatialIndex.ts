import { Point } from "./wireGeometry.js";

export interface IndexedSegment { wireId: string; segmentIndex: number; from: Point; to: Point; }
export interface IndexedConnectionPoint { id: string; kind: "pin" | "junction"; componentId: string; pinId?: string; point: Point; }

/** Spatial hash mutável. Inserção/query são proporcionais às células tocadas, não ao circuito. */
export class WireSpatialIndex {
  private readonly cells = new Map<string, IndexedSegment[]>();
  private readonly keysByWire = new Map<string, Set<string>>();
  private readonly pointsByCell = new Map<string, IndexedConnectionPoint[]>();
  private readonly cellByPointId = new Map<string, string>();
  constructor(readonly cellSize = 64) {
    if (!(cellSize > 0)) throw new Error("cellSize precisa ser positivo");
  }
  private key(x: number, y: number): string { return `${Math.floor(x / this.cellSize)}:${Math.floor(y / this.cellSize)}`; }
  removeWire(wireId: string): void {
    for (const key of this.keysByWire.get(wireId) ?? []) {
      const remaining = (this.cells.get(key) ?? []).filter((segment) => segment.wireId !== wireId);
      if (remaining.length) this.cells.set(key, remaining); else this.cells.delete(key);
    }
    this.keysByWire.delete(wireId);
  }
  upsertWire(wireId: string, points: readonly Point[]): void {
    this.removeWire(wireId);
    const wireKeys = new Set<string>();
    for (let i = 0; i + 1 < points.length; i += 1) {
      const from = points[i]!; const to = points[i + 1]!;
      const minX = Math.min(from.x, to.x); const maxX = Math.max(from.x, to.x);
      const minY = Math.min(from.y, to.y); const maxY = Math.max(from.y, to.y);
      for (let x = Math.floor(minX / this.cellSize); x <= Math.floor(maxX / this.cellSize); x += 1) {
        for (let y = Math.floor(minY / this.cellSize); y <= Math.floor(maxY / this.cellSize); y += 1) {
          const key = `${x}:${y}`; wireKeys.add(key);
          const bucket = this.cells.get(key) ?? [];
          bucket.push({ wireId, segmentIndex: i, from, to }); this.cells.set(key, bucket);
        }
      }
    }
    this.keysByWire.set(wireId, wireKeys);
  }
  queryPoint(point: Point, tolerance: number): IndexedSegment[] {
    const found = new Map<string, IndexedSegment>();
    const minX = Math.floor((point.x - tolerance) / this.cellSize); const maxX = Math.floor((point.x + tolerance) / this.cellSize);
    const minY = Math.floor((point.y - tolerance) / this.cellSize); const maxY = Math.floor((point.y + tolerance) / this.cellSize);
    for (let x = minX; x <= maxX; x += 1) for (let y = minY; y <= maxY; y += 1) {
      for (const segment of this.cells.get(`${x}:${y}`) ?? []) found.set(`${segment.wireId}:${segment.segmentIndex}`, segment);
    }
    return [...found.values()];
  }
  upsertConnectionPoint(item: IndexedConnectionPoint): void {
    this.removeConnectionPoint(item.id);
    const key = this.key(item.point.x, item.point.y);
    const bucket = this.pointsByCell.get(key) ?? []; bucket.push(item);
    this.pointsByCell.set(key, bucket); this.cellByPointId.set(item.id, key);
  }
  removeConnectionPoint(id: string): void {
    const key = this.cellByPointId.get(id); if (!key) return;
    const remaining = (this.pointsByCell.get(key) ?? []).filter((item) => item.id !== id);
    if (remaining.length) this.pointsByCell.set(key, remaining); else this.pointsByCell.delete(key);
    this.cellByPointId.delete(id);
  }
  queryConnectionPoints(point: Point, tolerance: number): IndexedConnectionPoint[] {
    const found: IndexedConnectionPoint[] = [];
    const minX = Math.floor((point.x - tolerance) / this.cellSize); const maxX = Math.floor((point.x + tolerance) / this.cellSize);
    const minY = Math.floor((point.y - tolerance) / this.cellSize); const maxY = Math.floor((point.y + tolerance) / this.cellSize);
    for (let x = minX; x <= maxX; x += 1) for (let y = minY; y <= maxY; y += 1) for (const item of this.pointsByCell.get(`${x}:${y}`) ?? []) {
      if (Math.hypot(item.point.x - point.x, item.point.y - point.y) <= tolerance) found.push(item);
    }
    return found;
  }
  clear(): void { this.cells.clear(); this.keysByWire.clear(); this.pointsByCell.clear(); this.cellByPointId.clear(); }
}
