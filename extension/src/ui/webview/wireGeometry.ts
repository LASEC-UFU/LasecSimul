/** Geometria pura de fio ortogonal — sem DOM, sem `vscode.*`, só `Point` → `Point[]`. Extraído de
 * `main.ts` para poder ser testado isoladamente (ver Épico E do roadmap de pendências). */

export type Point = { x: number; y: number };

export const WIRE_GRID_SIZE = 8;

export function snapToWireGrid(point: Point, gridSize: number = WIRE_GRID_SIZE): Point {
  return {
    x: Math.round(point.x / gridSize) * gridSize,
    y: Math.round(point.y / gridSize) * gridSize,
  };
}

export function snapCoordinate(value: number, step: number): number {
  return Math.round(value / step) * step;
}

export function samePoint(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;
}

export function appendPoint(points: Point[], point: Point): void {
  if (points.length === 0 || !samePoint(points[points.length - 1]!, point)) points.push(point);
}

export function normalizeOrthogonalPath(points: Point[]): Point[] {
  if (points.length <= 2) return points.map((point) => ({ ...point }));

  const deduped: Point[] = [];
  for (const point of points) appendPoint(deduped, point);
  if (deduped.length <= 2) return deduped;

  const normalized: Point[] = [deduped[0]!];
  for (let index = 1; index < deduped.length - 1; index += 1) {
    const prev = normalized[normalized.length - 1]!;
    const current = deduped[index]!;
    const next = deduped[index + 1]!;
    const sameX = Math.abs(prev.x - current.x) < 0.5 && Math.abs(current.x - next.x) < 0.5;
    const sameY = Math.abs(prev.y - current.y) < 0.5 && Math.abs(current.y - next.y) < 0.5;
    if (sameX || sameY) continue;
    normalized.push(current);
  }
  normalized.push(deduped[deduped.length - 1]!);
  return normalized;
}

export function orthogonalSegmentPoints(fromPos: Point, toPos: Point): Point[] {
  if (samePoint(fromPos, toPos)) return [fromPos];
  if (Math.abs(fromPos.x - toPos.x) < 0.5 || Math.abs(fromPos.y - toPos.y) < 0.5) {
    return [fromPos, toPos];
  }
  const dx = toPos.x - fromPos.x;
  const dy = toPos.y - fromPos.y;
  const elbow = Math.abs(dx) > Math.abs(dy) ? { x: toPos.x, y: fromPos.y } : { x: fromPos.x, y: toPos.y };
  return [fromPos, elbow, toPos];
}

export function buildOrthogonalPath(anchors: Point[]): Point[] {
  if (anchors.length === 0) return [];
  const path: Point[] = [anchors[0]!];
  for (let index = 1; index < anchors.length; index++) {
    const fromPos = path[path.length - 1]!;
    const toPos = anchors[index]!;
    const segment = orthogonalSegmentPoints(fromPos, toPos);
    for (const point of segment.slice(1)) appendPoint(path, point);
  }
  return path;
}

/** Ponto mais próximo de `point` sobre o segmento ortogonal `from`-`to` (clamped aos limites do
 * segmento) -- como o segmento é sempre axis-aligned, isso equivale à projeção ponto-segmento
 * completa (mesma simplificação que `ConnectorLine::connectToWire` do SimulIDE usa). */
export function nearestPointOnOrthogonalSegment(point: Point, from: Point, to: Point): Point {
  if (Math.abs(from.x - to.x) < 0.5) {
    return {
      x: from.x,
      y: Math.max(Math.min(point.y, Math.max(from.y, to.y)), Math.min(from.y, to.y)),
    };
  }
  return {
    x: Math.max(Math.min(point.x, Math.max(from.x, to.x)), Math.min(from.x, to.x)),
    y: from.y,
  };
}

/** Igual a `nearestPointOnOrthogonalSegment`, mas arredonda a coordenada livre pro grid antes de
 * clampar -- usado tanto pra iniciar quanto pra terminar uma derivação no meio de um fio, garantindo
 * que os dois gestos concordem no ponto exato de split. */
export function nearestSnappedPointOnOrthogonalSegment(point: Point, from: Point, to: Point, step: number): Point {
  const nearest = nearestPointOnOrthogonalSegment(point, from, to);
  if (Math.abs(from.x - to.x) < 0.5) {
    return {
      x: from.x,
      y: Math.max(Math.min(snapCoordinate(nearest.y, step), Math.max(from.y, to.y)), Math.min(from.y, to.y)),
    };
  }

  return {
    x: Math.max(Math.min(snapCoordinate(nearest.x, step), Math.max(from.x, to.x)), Math.min(from.x, to.x)),
    y: from.y,
  };
}

export function squaredDistance(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/** Índice do canto (ponto intermediário, nunca a primeira/última extremidade) dentro de `tolerance`
 * px de `point`, medido a partir das duas pontas do segmento `segmentIndex`. Usado pra decidir se um
 * clique perto de um canto existente deveria selecionar/reusar aquele canto em vez do meio do
 * segmento. */
export function wireCornerIndexNearSegmentPoint(points: Point[], segmentIndex: number, point: Point, tolerance = 8): number | undefined {
  const from = points[segmentIndex];
  const to = points[segmentIndex + 1];
  if (!from || !to) return undefined;

  const distanceFrom = Math.hypot(point.x - from.x, point.y - from.y);
  if (distanceFrom <= tolerance && segmentIndex > 0) return segmentIndex;

  const distanceTo = Math.hypot(point.x - to.x, point.y - to.y);
  if (distanceTo <= tolerance && segmentIndex + 1 < points.length - 1) return segmentIndex + 1;

  return undefined;
}

/** Variante usada ao TERMINAR uma conexão sobre um segmento: snapa pro canto vizinho quando o clique
 * está a menos de `tolerance` px dele NO EIXO do segmento (não distância euclidiana) -- espelha o
 * "within 8px along the line's own axis" do SimulIDE (`ConnectorLine::connectToWire`), pra evitar
 * criar um canto redundante colado num já existente. */
export function wireConnectCornerIndexLikeSimulIDE(
  points: Point[],
  segmentIndex: number,
  point: Point,
  tolerance = 8
): number | undefined {
  const from = points[segmentIndex];
  const to = points[segmentIndex + 1];
  if (!from || !to) return undefined;

  const isHorizontal = Math.abs(from.y - to.y) < 0.5;
  const isVertical = Math.abs(from.x - to.x) < 0.5;
  if (!isHorizontal && !isVertical) return undefined;

  if (isHorizontal) {
    if (Math.abs(point.x - to.x) < tolerance && segmentIndex < points.length - 2) return segmentIndex + 1;
    if (Math.abs(point.x - from.x) < tolerance && segmentIndex > 0) return segmentIndex;
    return undefined;
  }

  if (Math.abs(point.y - to.y) < tolerance && segmentIndex < points.length - 2) return segmentIndex + 1;
  if (Math.abs(point.y - from.y) < tolerance && segmentIndex > 0) return segmentIndex;
  return undefined;
}

/** Reposiciona o segmento ortogonal `segmentIndex` (entre `fullPoints[segmentIndex]` e
 * `fullPoints[segmentIndex+1]`) pra `coordinate` no eixo perpendicular à sua direção, e normaliza o
 * resultado (remove cotovelos redundantes que o arrasto possa ter criado/desfeito). */
export function moveOrthogonalWireSegment(fullPoints: Point[], segmentIndex: number, coordinate: number): Point[] {
  const moved = fullPoints.map((point) => ({ ...point }));
  const from = moved[segmentIndex];
  const to = moved[segmentIndex + 1];
  if (!from || !to) return moved;

  if (Math.abs(from.y - to.y) < 0.5) {
    from.y = coordinate;
    to.y = coordinate;
  } else if (Math.abs(from.x - to.x) < 0.5) {
    from.x = coordinate;
    to.x = coordinate;
  }
  return normalizeOrthogonalPath(moved);
}

/** Move o canto `pointIndex` pra `target`, arrastando os segmentos vizinhos junto (mantendo-os
 * ortogonais) e normalizando o resultado. */
export function moveOrthogonalWireCorner(fullPoints: Point[], pointIndex: number, target: Point): Point[] {
  const moved = fullPoints.map((point) => ({ ...point }));
  const prev = moved[pointIndex - 1];
  const current = moved[pointIndex];
  const next = moved[pointIndex + 1];
  if (!prev || !current || !next) return moved;

  const prevVertical = Math.abs(prev.x - current.x) < 0.5;
  const nextVertical = Math.abs(current.x - next.x) < 0.5;
  current.x = target.x;
  current.y = target.y;

  if (prevVertical) prev.x = target.x;
  else prev.y = target.y;

  if (nextVertical) next.x = target.x;
  else next.y = target.y;

  return normalizeOrthogonalPath(moved);
}

/** Divide a polilinha completa `fullPoints` (já incluindo as duas extremidades reais, ex.
 * `wirePolylinePoints(wire)`) em dois trechos de pontos INTERMEDIÁRIOS (sem as extremidades) em torno
 * de `splitPoint`, projetado no segmento mais próximo. `splitPoint` deve já estar snapado/projetado
 * sobre a polilinha (ver `nearestSnappedPointOnOrthogonalSegment`) -- se não estiver a menos de 1px²
 * de algum segmento, devolve dois arrays vazios (nenhum split possível). Pura: não lê `state`. */
export function splitWireRouteAtPoint(fullPoints: Point[], splitPoint: Point): { first: Point[]; second: Point[] } {
  if (fullPoints.length < 2) return { first: [], second: [] };

  const withSplit: Point[] = [fullPoints[0]!];
  let inserted = false;
  for (let index = 1; index < fullPoints.length; index += 1) {
    const from = withSplit[withSplit.length - 1]!;
    const to = fullPoints[index]!;
    if (!inserted) {
      const nearest = nearestPointOnOrthogonalSegment(splitPoint, from, to);
      if (squaredDistance(nearest, splitPoint) < 1) {
        appendPoint(withSplit, nearest);
        if (!samePoint(nearest, to)) appendPoint(withSplit, to);
        inserted = true;
        continue;
      }
    }
    appendPoint(withSplit, to);
  }

  const splitIndex = withSplit.findIndex((point) => samePoint(point, splitPoint));
  if (splitIndex <= 0 || splitIndex >= withSplit.length - 1) return { first: [], second: [] };
  return {
    first: withSplit.slice(1, splitIndex),
    second: withSplit.slice(splitIndex + 1, withSplit.length - 1),
  };
}
