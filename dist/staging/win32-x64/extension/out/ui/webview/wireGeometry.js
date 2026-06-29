"use strict";
/** Geometria pura de fio ortogonal — sem DOM, sem `vscode.*`, só `Point` → `Point[]`. Extraído de
 * `main.ts` para poder ser testado isoladamente (ver Épico E do roadmap de pendências). */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WIRE_GRID_SIZE = void 0;
exports.snapToWireGrid = snapToWireGrid;
exports.snapCoordinate = snapCoordinate;
exports.samePoint = samePoint;
exports.appendPoint = appendPoint;
exports.normalizeOrthogonalPath = normalizeOrthogonalPath;
exports.orthogonalSegmentPoints = orthogonalSegmentPoints;
exports.buildOrthogonalPath = buildOrthogonalPath;
exports.WIRE_GRID_SIZE = 24;
function snapToWireGrid(point, gridSize = exports.WIRE_GRID_SIZE) {
    return {
        x: Math.round(point.x / gridSize) * gridSize,
        y: Math.round(point.y / gridSize) * gridSize,
    };
}
function snapCoordinate(value, step) {
    return Math.round(value / step) * step;
}
function samePoint(a, b) {
    return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;
}
function appendPoint(points, point) {
    if (points.length === 0 || !samePoint(points[points.length - 1], point))
        points.push(point);
}
function normalizeOrthogonalPath(points) {
    if (points.length <= 2)
        return points.map((point) => ({ ...point }));
    const deduped = [];
    for (const point of points)
        appendPoint(deduped, point);
    if (deduped.length <= 2)
        return deduped;
    const normalized = [deduped[0]];
    for (let index = 1; index < deduped.length - 1; index += 1) {
        const prev = normalized[normalized.length - 1];
        const current = deduped[index];
        const next = deduped[index + 1];
        const sameX = Math.abs(prev.x - current.x) < 0.5 && Math.abs(current.x - next.x) < 0.5;
        const sameY = Math.abs(prev.y - current.y) < 0.5 && Math.abs(current.y - next.y) < 0.5;
        if (sameX || sameY)
            continue;
        normalized.push(current);
    }
    normalized.push(deduped[deduped.length - 1]);
    return normalized;
}
function orthogonalSegmentPoints(fromPos, toPos) {
    if (samePoint(fromPos, toPos))
        return [fromPos];
    if (Math.abs(fromPos.x - toPos.x) < 0.5 || Math.abs(fromPos.y - toPos.y) < 0.5) {
        return [fromPos, toPos];
    }
    const dx = toPos.x - fromPos.x;
    const dy = toPos.y - fromPos.y;
    const elbow = Math.abs(dx) > Math.abs(dy) ? { x: toPos.x, y: fromPos.y } : { x: fromPos.x, y: toPos.y };
    return [fromPos, elbow, toPos];
}
function buildOrthogonalPath(anchors) {
    if (anchors.length === 0)
        return [];
    const path = [anchors[0]];
    for (let index = 1; index < anchors.length; index++) {
        const fromPos = path[path.length - 1];
        const toPos = anchors[index];
        const segment = orthogonalSegmentPoints(fromPos, toPos);
        for (const point of segment.slice(1))
            appendPoint(path, point);
    }
    return path;
}
//# sourceMappingURL=wireGeometry.js.map