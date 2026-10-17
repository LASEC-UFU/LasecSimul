// PoC isolada (NÃO é produção). Gravador colunar e leituras sobre séries gravadas.
// Modela o contrato proposto para SignalRecorder/SeriesStore (docs/51 §4.1–4.2): uma coluna de tempo
// compartilhada, colunas Float64Array, crescimento por blocos, nada reamostrado para cálculo.

export class Recorder {
  constructor(columns, capacity = 4096) {
    this.columns = columns;
    this.length = 0;
    this.capacity = capacity;
    this.t = new Float64Array(capacity);
    this.data = Object.fromEntries(columns.map((c) => [c, new Float64Array(capacity)]));
    this.revision = 0;
  }
  push(t, row) {
    if (this.length === this.capacity) this.#grow();
    const i = this.length++;
    this.t[i] = t;
    for (const c of this.columns) this.data[c][i] = row[c] ?? NaN;
    this.revision++;
  }
  #grow() {
    this.capacity *= 2;
    const t = new Float64Array(this.capacity); t.set(this.t); this.t = t;
    for (const c of this.columns) { const a = new Float64Array(this.capacity); a.set(this.data[c]); this.data[c] = a; }
  }
  /** Primeiro índice com t[i] >= x (busca binária). */
  lowerBound(x) { let lo = 0, hi = this.length; while (lo < hi) { const m = (lo + hi) >> 1; if (this.t[m] < x) lo = m + 1; else hi = m; } return lo; }
  /** Primeiro índice com t[i] > x. */
  upperBound(x) { let lo = 0, hi = this.length; while (lo < hi) { const m = (lo + hi) >> 1; if (this.t[m] <= x) lo = m + 1; else hi = m; } return lo; }
  /** Estado integrado (linear entre amostras). Em instantes com duas linhas (descontinuidade), "after" escolhe a posterior. */
  linearAt(col, x, after = true) {
    if (this.length === 0 || x < this.t[0] || x > this.t[this.length - 1]) return { kind: "gap", value: NaN };
    const i = after ? this.upperBound(x) - 1 : this.lowerBound(x);
    if (this.t[i] === x) return { kind: "sample", value: this.data[col][i], index: i };
    const j = after ? i + 1 : i - 1;
    const [a, b] = after ? [i, j] : [j, i];
    const w = (x - this.t[a]) / (this.t[b] - this.t[a]);
    return { kind: "interpolated", value: this.data[col][a] + w * (this.data[col][b] - this.data[col][a]), between: [this.t[a], this.t[b]] };
  }
  /**
   * Vazão média realizada por passo: a linha i vale no intervalo (t[i-1], t[i]].
   * side = +1 lê o limite à direita de x (intervalo que começa em x); -1 o limite à esquerda.
   */
  stepValueAt(col, x, side = 1) {
    if (this.length < 2) return NaN;
    const i = side > 0 ? this.upperBound(x) : this.lowerBound(x);
    for (let k = i; k < this.length; k++) { const v = this.data[col][k]; if (!Number.isNaN(v) && this.t[k] > this.t[k - 1]) return v; }
    return NaN;
  }
  /** ∫ exato da série por passos entre a e b (soma das áreas dos degraus, com cortes parciais). */
  stepIntegral(col, a, b) {
    let sum = 0;
    for (let k = Math.max(1, this.upperBound(a)); k < this.length && this.t[k - 1] < b; k++) {
      const v = this.data[col][k];
      if (Number.isNaN(v)) continue;
      const lo = Math.max(a, this.t[k - 1]), hi = Math.min(b, this.t[k]);
      if (hi > lo) sum += v * (hi - lo);
    }
    return sum;
  }
}

/** Soma de Riemann sobre a série por passos (left, right, midpoint, trapezoid). Nada é decimado. */
export function riemannOnSteps(rec, col, a, b, n, method) {
  const w = (b - a) / n, bars = [];
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x0 = a + i * w, x1 = x0 + w;
    let height;
    switch (method) {
      case "left": height = rec.stepValueAt(col, x0, 1); break;
      case "right": height = rec.stepValueAt(col, x1, -1); break;
      case "midpoint": height = rec.stepValueAt(col, (x0 + x1) / 2, 1); break;
      default: height = (rec.stepValueAt(col, x0, 1) + rec.stepValueAt(col, x1, -1)) / 2;
    }
    bars.push({ x0, x1, height });
    sum += height * w;
  }
  return { sum, bars };
}

/** Desenho: envelope min/máx por coluna de pixel (só visual; nunca usado em cálculo). */
export function envelope(rec, col, x0, x1, columns) {
  const out = [];
  const i0 = Math.max(0, rec.lowerBound(x0) - 1), i1 = Math.min(rec.length, rec.upperBound(x1) + 1);
  if (i1 - i0 <= columns * 2) { for (let i = i0; i < i1; i++) out.push([rec.t[i], rec.data[col][i]]); return out; }
  let bucket = -1, lo, hi, tlo, thi;
  const flush = () => { if (bucket >= 0) { if (tlo <= thi) out.push([tlo, lo], [thi, hi]); else out.push([thi, hi], [tlo, lo]); } };
  for (let i = i0; i < i1; i++) {
    const t = rec.t[i], v = rec.data[col][i];
    const b = Math.floor(((t - x0) / (x1 - x0)) * columns);
    if (b !== bucket) { flush(); bucket = b; lo = hi = v; tlo = thi = t; }
    else { if (v < lo) { lo = v; tlo = t; } if (v > hi) { hi = v; thi = t; } }
  }
  flush();
  return out;
}
