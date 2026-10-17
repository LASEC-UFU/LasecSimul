import type { CompiledExpression } from "./compile.js";

export type QuotientResult =
  | { kind: "finite"; value: number; deltaUsed: number; warning?: string }
  | { kind: "undefined"; reason: string }
  | { kind: "precision-limit"; reason: string };

/** [f(a+Δ) − f(a)]/Δ com Δ assinado (Δ > 0 direita, Δ < 0 esquerda) e classificação honesta. */
export function differenceQuotient(fn: CompiledExpression, a: number, delta: number): QuotientResult {
  if (delta === 0) return { kind: "undefined", reason: "Δt = 0: o denominador do quociente é zero" };
  const b = a + delta;
  if (b === a) return { kind: "precision-limit", reason: "Δt abaixo da resolução de ponto flutuante em torno de a" };
  const fa = fn.evaluate([a]);
  const fb = fn.evaluate([b]);
  if (fa.kind !== "finite") return { kind: "undefined", reason: `h(a): ${fa.reason}` };
  if (fb.kind !== "finite") return { kind: "undefined", reason: `h(a+Δt): ${fb.reason}` };
  const effective = b - a; // Δ realmente representado em ponto flutuante
  const value = (fb.value - fa.value) / effective;
  // abaixo de ~sqrt(eps)·escala, o arredondamento domina o quociente
  const cancellation = Math.abs(effective) < 1.5e-8 * Math.max(1, Math.abs(a));
  return cancellation
    ? { kind: "finite", value, deltaUsed: effective, warning: "erro de arredondamento comparável ao quociente" }
    : { kind: "finite", value, deltaUsed: effective };
}

export type Point = [number, number];

/**
 * Amostragem adaptativa só para DESENHO (cálculos nunca leem estes pontos). Bisseção até ≤ maxPixelDistance
 * e ângulo ≤ maxBendDeg na tela; segmentos são quebrados onde a função é indefinida ou onde a distância
 * não encolhe sob bisseção (salto/assíntota) — mesma ideia do `CurveSegmentPlotter` do GeoGebra.
 */
export function sampleFunction(
  fn: CompiledExpression, xMin: number, xMax: number, toPx: (x: number, y: number) => Point,
  { maxDepth = 14, maxPixelDistance = 6, maxBendDeg = 8 } = {},
): Point[][] {
  const env = new Float64Array(1);
  const f = (x: number): number => { env[0] = x; return fn.value(env); };
  const segments: Point[][] = [];
  let current: Point[] = [];
  const flush = (): void => { if (current.length > 1) segments.push(current); current = []; };
  const finite = (y: number): boolean => Number.isFinite(y);
  const maxBend = Math.tan((maxBendDeg * Math.PI) / 180);
  const continuous = (x0: number, x1: number): boolean => {
    let a = x0, b = x1, ya = f(a), yb = f(b);
    if (!finite(ya) || !finite(yb)) return false;
    const eps = Math.abs(yb - ya) * 0.9;
    let dist = Infinity;
    for (let it = 0; it < 12 && dist > eps; it++) {
      const m = (a + b) / 2, ym = f(m);
      if (!finite(ym)) return false;
      const dl = Math.abs(ym - ya), dr = Math.abs(yb - ym);
      if (dl > dr) { dist = dl; b = m; yb = ym; } else { dist = dr; a = m; ya = ym; }
      if (b - a < 1e-12 * Math.max(1, Math.abs(a))) break;
    }
    return dist <= eps;
  };
  function refine(p0: Point, p1: Point, depth: number): void {
    const xm = (p0[0] + p1[0]) / 2, ym = f(xm);
    const mid: Point = [xm, ym];
    if (!finite(p0[1]) || !finite(p1[1]) || !finite(ym)) {
      if (depth >= maxDepth) { flush(); if (finite(p1[1])) current.push(p1); return; }
      refine(p0, mid, depth + 1); refine(mid, p1, depth + 1);
      return;
    }
    const a = toPx(p0[0], p0[1]), m = toPx(xm, ym), b = toPx(p1[0], p1[1]);
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const v1 = [m[0] - a[0], m[1] - a[1]] as const, v2 = [b[0] - m[0], b[1] - m[1]] as const;
    const cross = v1[0] * v2[1] - v1[1] * v2[0], dot = v1[0] * v2[0] + v1[1] * v2[1];
    const bendTooLarge = dot <= 0 || Math.abs(cross / dot) > maxBend;
    if (depth < maxDepth && (d > maxPixelDistance || bendTooLarge)) { refine(p0, mid, depth + 1); refine(mid, p1, depth + 1); return; }
    if (d > maxPixelDistance * 4 && !continuous(p0[0], p1[0])) { flush(); current.push(p1); return; } // não liga ramos
    current.push(p1);
  }
  const n0 = 64;
  let p0: Point = [xMin, f(xMin)];
  if (finite(p0[1])) current.push(p0);
  for (let i = 1; i <= n0; i++) {
    const x = i === n0 ? xMax : xMin + (i * (xMax - xMin)) / n0;
    const p1: Point = [x, f(x)];
    refine(p0, p1, 0);
    p0 = p1;
  }
  flush();
  return segments.map((s) => s.filter((p) => finite(p[1])));
}
