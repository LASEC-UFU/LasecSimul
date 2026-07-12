import { Point } from "./wireGeometry.js";

export interface IndexedSegment { wireId: string; segmentIndex: number; from: Point; to: Point; }

/** Spatial hash mutável de SEGMENTOS de fio (usado pra achar o fio sob um ponto, ex:
 * auto-junção ao arrastar um componente perto de um fio existente, ver
 * `main.ts::maybeAutoJunctionForDraggedComponents`). Inserção/query são proporcionais às células
 * tocadas, não ao circuito inteiro. Não indexa pontos de conexão (pino/junção) -- essa metade da
 * API existiu só pra sustentar `wireTopology.ts::findAtPosition`/`buildWireSpatialIndex`, removidos
 * por serem código morto (nenhum call site fora dos próprios testes, ver `.spec` seção 25.10):
 * cada tipo de alça interativa (pino/segmento/canto/junção) já tem seu próprio elemento DOM com
 * hit-test nativo do browser, nunca precisou de um hit-test manual genérico. */
export class WireSpatialIndex {
  private readonly cells = new Map<string, IndexedSegment[]>();
  private readonly keysByWire = new Map<string, Set<string>>();
  constructor(readonly cellSize = 64) {
    if (!(cellSize > 0)) throw new Error("cellSize precisa ser positivo");
  }
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
}
