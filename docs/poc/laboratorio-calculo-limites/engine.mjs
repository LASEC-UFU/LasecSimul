// Prova de conceito isolada (NÃO é código de produção). Ver README.md desta pasta.
//
// Grafo de dependências, quociente incremental e amostragem para desenho. O núcleo de expressões
// (parser, operadores ∫ d/dx lim Σ Π, derivação, MathML) está em math.mjs e é reexportado aqui.
//  - grafo incremental inspirado em `GeoElement.algoUpdateSet` / `AlgorithmSet` (ordem de
//    definição = ordem topológica), acrescido de poda por igualdade de valor, que o GeoGebra não
//    faz (`AlgoElement.update()` sempre recalcula);
//  - amostragem adaptativa com quebra em descontinuidade, inspirada em `CurveSegmentPlotter`.

export {
  ExpressionError, parseExpression, compileExpression, substitute, dependsOn, differentiate, simplify,
  toPolynomial, polyEval, differenceQuotientPolynomial, formatPolynomial, astToMathML,
} from "./math.mjs";

// ---------------------------------------------------------------------------------------------
// 3. Quociente incremental numérico com classificação honesta
// ---------------------------------------------------------------------------------------------

/** Lado direito: [f(a+Δ) − f(a)]/Δ. Lado esquerdo usa Δ negativo (mesma fórmula, Δ assinado). */
export function differenceQuotient(fn, a, delta) {
  if (delta === 0) return { kind: "undefined", reason: "Δt = 0: o denominador do quociente é zero" };
  const b = a + delta;
  if (b === a) return { kind: "precision-limit", reason: "Δt abaixo da resolução de ponto flutuante em torno de a" };
  const fa = fn.evaluate([a]);
  const fb = fn.evaluate([b]);
  if (fa.kind !== "finite") return { kind: "undefined", reason: `h(a): ${fa.reason}` };
  if (fb.kind !== "finite") return { kind: "undefined", reason: `h(a+Δt): ${fb.reason}` };
  const effectiveDelta = b - a; // Δ realmente representado
  const value = (fb.value - fa.value) / effectiveDelta;
  // cancelamento catastrófico: abaixo de ~sqrt(eps)*escala o erro de arredondamento domina
  const scale = Math.max(1, Math.abs(a));
  const cancellation = Math.abs(effectiveDelta) < 1.5e-8 * scale;
  return { kind: "finite", value, deltaUsed: effectiveDelta, warning: cancellation ? "erro de arredondamento comparável ao quociente" : undefined };
}

// ---------------------------------------------------------------------------------------------
// 4. Grafo de dependências incremental
// ---------------------------------------------------------------------------------------------

const sameValue = (a, b) => Object.is(a, b) || (typeof a === "object" && a !== null && typeof b === "object" && b !== null && JSON.stringify(a) === JSON.stringify(b));

/**
 * Cada nó tem índice de definição; um nó derivado só pode depender de nós já definidos, então a
 * ordem de definição é topológica (mesmo princípio do índice de construção do GeoGebra).
 * `downstream(id)` = conjunto transitivo de dependentes, em ordem, cacheado até a topologia mudar
 * (equivalente a `algoUpdateSet`). Diferença deliberada: um nó só recalcula se algum insumo mudou
 * de VALOR nesta propagação, e só propaga se o próprio valor mudou.
 */
export class DependencyGraph {
  constructor() {
    this.nodes = new Map();
    this.downstreamCache = new Map();
    this.listeners = new Set();
    this.batchDepth = 0;
    this.pendingSources = new Set();
    this.stats = { computes: new Map(), propagations: 0 };
  }
  source(id, value, { kind = "inspection", equals = sameValue } = {}) {
    this.#define({ id, kind, inputs: [], compute: undefined, equals, value });
    return id;
  }
  derived(id, inputs, compute, { kind = "derived", equals = sameValue } = {}) {
    for (const input of inputs) if (!this.nodes.has(input)) throw new Error(`nó "${id}" depende de "${input}" ainda não definido`);
    const node = { id, kind, inputs, compute, equals, value: undefined };
    this.#define(node);
    node.value = this.#run(node);
    return id;
  }
  #define(node) {
    if (this.nodes.has(node.id)) throw new Error(`nó duplicado: ${node.id}`);
    node.index = this.nodes.size;
    node.dependents = [];
    for (const input of node.inputs) this.nodes.get(input).dependents.push(node.id);
    this.nodes.set(node.id, node);
    this.downstreamCache.clear();
  }
  #run(node) {
    this.stats.computes.set(node.id, (this.stats.computes.get(node.id) ?? 0) + 1);
    const args = node.inputs.map((i) => this.nodes.get(i).value);
    try { return node.compute(...args); } catch (error) { return { kind: "error", reason: String(error?.message ?? error) }; }
  }
  get(id) { return this.nodes.get(id).value; }
  set(id, value) {
    const node = this.nodes.get(id);
    if (!node || node.compute) throw new Error(`"${id}" não é fonte`);
    if (node.equals(node.value, value)) return;
    node.value = value;
    this.pendingSources.add(id);
    if (this.batchDepth === 0) this.#flush();
  }
  batch(fn) {
    this.batchDepth++;
    try { fn(); } finally { if (--this.batchDepth === 0) this.#flush(); }
  }
  downstream(id) {
    let cached = this.downstreamCache.get(id);
    if (cached) return cached;
    const seen = new Set();
    const stack = [...this.nodes.get(id).dependents];
    while (stack.length) { const d = stack.pop(); if (!seen.has(d)) { seen.add(d); stack.push(...this.nodes.get(d).dependents); } }
    cached = [...seen].map((d) => this.nodes.get(d)).sort((a, b) => a.index - b.index);
    this.downstreamCache.set(id, cached);
    return cached;
  }
  #flush() {
    if (this.pendingSources.size === 0) return;
    this.stats.propagations++;
    const changed = new Set(this.pendingSources);
    this.pendingSources.clear();
    const candidates = new Map();
    for (const s of changed) for (const n of this.downstream(s)) candidates.set(n.id, n);
    for (const node of [...candidates.values()].sort((a, b) => a.index - b.index)) {
      if (!node.inputs.some((i) => changed.has(i))) continue; // insumos com mesmo valor: não recalcula
      const next = this.#run(node);
      if (!node.equals(node.value, next)) { node.value = next; changed.add(node.id); }
    }
    for (const listener of this.listeners) listener(changed);
  }
  onChange(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  computeCount(id) { return this.stats.computes.get(id) ?? 0; }
}

// ---------------------------------------------------------------------------------------------
// 5. Amostragem adaptativa com quebra em descontinuidade (só para DESENHO)
// ---------------------------------------------------------------------------------------------

/**
 * Devolve segmentos [[x,y],...] em coordenadas de MUNDO. `toPx` converte para tela e define as
 * tolerâncias (distância/ângulo em pixels), como `CurveSegmentPlotter`. O resultado é exclusivamente
 * para desenho: cálculos (quociente, integral) nunca leem estes pontos.
 */
export function sampleFunction(fn, xMin, xMax, toPx, { maxDepth = 14, maxPixelDistance = 6, maxBendDeg = 8 } = {}) {
  const env = [0];
  const f = (x) => { env[0] = x; return fn.value(env); };
  const segments = [];
  let current = [];
  const flush = () => { if (current.length > 1) segments.push(current); current = []; };
  const finite = (y) => Number.isFinite(y);
  const maxBend = Math.tan((maxBendDeg * Math.PI) / 180);
  const pxDist = (a, b) => { const pa = toPx(a[0], a[1]), pb = toPx(b[0], b[1]); return Math.hypot(pb[0] - pa[0], pb[1] - pa[1]); };
  const continuous = (x0, x1) => {
    let a = x0, b = x1, ya = f(a), yb = f(b);
    if (!finite(ya) || !finite(yb)) return false;
    const initial = Math.abs(yb - ya), eps = initial * 0.9;
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
  const N0 = 64;
  const step = (xMax - xMin) / N0;
  const pushPoint = (p) => current.push(p);
  function refine(p0, p1, depth) {
    const xm = (p0[0] + p1[0]) / 2, ym = f(xm);
    const mid = [xm, ym];
    const bothFinite = finite(p0[1]) && finite(p1[1]);
    if (!bothFinite || !finite(ym)) {
      if (depth >= maxDepth) { if (finite(p1[1])) { flush(); pushPoint(p1); } else flush(); return; }
      refine(p0, mid, depth + 1); refine(mid, p1, depth + 1); return;
    }
    const d = pxDist(p0, p1);
    const a = toPx(p0[0], p0[1]), m = toPx(xm, ym), b = toPx(p1[0], p1[1]);
    const v1 = [m[0] - a[0], m[1] - a[1]], v2 = [b[0] - m[0], b[1] - m[1]];
    const cross = v1[0] * v2[1] - v1[1] * v2[0], dot = v1[0] * v2[0] + v1[1] * v2[1];
    const bendTooLarge = dot <= 0 || Math.abs(cross / dot) > maxBend;
    if (depth < maxDepth && (d > maxPixelDistance || bendTooLarge)) { refine(p0, mid, depth + 1); refine(mid, p1, depth + 1); return; }
    if (d > maxPixelDistance * 4 && !continuous(p0[0], p1[0])) { flush(); pushPoint(p1); return; } // salto/assíntota: não liga ramos
    pushPoint(p1);
  }
  let p0 = [xMin, f(xMin)];
  if (finite(p0[1])) pushPoint(p0);
  for (let i = 1; i <= N0; i++) {
    const x = i === N0 ? xMax : xMin + i * step;
    const p1 = [x, f(x)];
    refine(p0, p1, 0);
    p0 = p1;
  }
  flush();
  return segments.map((s) => s.filter((p) => finite(p[1])));
}

