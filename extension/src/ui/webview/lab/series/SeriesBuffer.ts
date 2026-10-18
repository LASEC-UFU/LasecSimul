import type { LabSeriesDelta, LabSeriesEvent } from "../messages.js";

/**
 * Séries do Core na Webview (docs/51 §4.2, `series.mjs` da PoC): coluna de tempo compartilhada,
 * colunas `Float64Array`, só cresce por deltas. Cálculos (cursor, Riemann, ∫) leem as linhas
 * gravadas; nada é reamostrado. Colunas derivadas aqui:
 *  - `q`: vazão líquida MÉDIA realizada no passo (tᵢ₋₁, tᵢ] sem derramamentos discretos,
 *    Δ(cumIn − cumOut − cumOverflow)/Δt -- com ela ∫q dt sobre a série é exatamente ΔV + derramamentos;
 *  - eventos `spill` (salto de cumSpill) e `boundary` com o instante EXATO de contato que o Core grava
 *    (`upperContact`/`lowerContact`); sem essas colunas, o início de transbordo/falta de água na amostra.
 */
export type DerivedEventKind = "spill" | "boundary:upper" | "boundary:lower";
export interface BufferEvent { tS: number; kind: LabSeriesEvent["kind"] | DerivedEventKind; name?: string; value?: number; volume?: number }

export class SeriesBuffer {
  private times: Float64Array = new Float64Array(1024);
  private data = new Map<string, Float64Array>();
  private size = 0;
  readonly events: BufferEvent[] = [];
  generation = -1;
  revision = 0;
  lostRows = 0;

  constructor(private readonly derivedQ = true) {}

  get length(): number { return this.size; }
  get t(): Float64Array { return this.times; }
  has(column: string): boolean { return this.data.has(column); }
  col(column: string): Float64Array {
    const values = this.data.get(column);
    if (!values) throw new RangeError(`coluna ausente: ${column}`);
    return values;
  }
  last(column: string): number { return this.size > 0 ? this.col(column)[this.size - 1]! : NaN; }
  get now(): number { return this.size > 0 ? this.times[this.size - 1]! : 0; }

  clear(): void {
    this.size = 0;
    this.events.length = 0;
    this.lostRows = 0;
    this.revision++;
  }

  ingest(delta: LabSeriesDelta): void {
    if (delta.reset || delta.generation !== this.generation) {
      this.clear();
      this.generation = delta.generation;
    }
    this.lostRows += delta.lost;
    const columns = this.derivedQ && delta.columns.includes("cumIn") ? [...delta.columns, "q"] : delta.columns;
    for (const column of columns) if (!this.data.has(column)) this.data.set(column, new Float64Array(this.times.length));
    this.reserve(this.size + delta.t.length);
    const start = this.size;
    this.times.set(delta.t, start);
    delta.columns.forEach((column, index) => this.col(column).set(delta.values[index]!, start));
    this.size += delta.t.length;
    for (const event of delta.events) this.events.push({ tS: event.tS, kind: event.kind, name: event.name, value: event.value });
    if (columns.includes("q")) this.derive(start);
    this.revision++;
  }

  private derive(start: number): void {
    const t = this.times;
    const cumIn = this.col("cumIn"), cumOut = this.col("cumOut"), cumOverflow = this.col("cumOverflow"), q = this.col("q");
    const spill = this.has("cumSpill") ? this.col("cumSpill") : undefined;
    const overflow = this.has("overflow") ? this.col("overflow") : undefined;
    const unmet = this.has("unmet") ? this.col("unmet") : undefined;
    const upperContact = this.has("upperContact") ? this.col("upperContact") : undefined;
    const lowerContact = this.has("lowerContact") ? this.col("lowerContact") : undefined;
    for (let i = start; i < this.size; i++) {
      if (i === 0 || !(t[i]! > t[i - 1]!)) { q[i] = NaN; continue; }
      q[i] = ((cumIn[i]! - cumIn[i - 1]!) - (cumOut[i]! - cumOut[i - 1]!) - (cumOverflow[i]! - cumOverflow[i - 1]!)) / (t[i]! - t[i - 1]!);
      if (spill && spill[i]! !== spill[i - 1]!) this.events.push({ tS: t[i]!, kind: "spill", volume: spill[i]! - spill[i - 1]! });
      if (upperContact) { if (upperContact[i]! >= 0 && upperContact[i] !== upperContact[i - 1]) this.events.push({ tS: upperContact[i]!, kind: "boundary:upper" }); }
      else if (overflow && overflow[i]! > 0 && !(overflow[i - 1]! > 0)) this.events.push({ tS: t[i]!, kind: "boundary:upper" });
      if (lowerContact) { if (lowerContact[i]! >= 0 && lowerContact[i] !== lowerContact[i - 1]) this.events.push({ tS: lowerContact[i]!, kind: "boundary:lower" }); }
      else if (unmet && unmet[i]! > 0 && !(unmet[i - 1]! > 0)) this.events.push({ tS: t[i]!, kind: "boundary:lower" });
    }
    this.events.sort((a, b) => a.tS - b.tS);
  }

  private reserve(rows: number): void {
    if (rows <= this.times.length) return;
    let capacity = this.times.length;
    while (capacity < rows) capacity *= 2;
    const grow = (source: Float64Array): Float64Array => { const next = new Float64Array(capacity); next.set(source.subarray(0, this.size)); return next; };
    this.times = grow(this.times);
    for (const [column, values] of this.data) this.data.set(column, grow(values));
  }

  /** Primeiro índice com t[i] >= x. */
  lowerBound(x: number): number { let lo = 0, hi = this.size; while (lo < hi) { const m = (lo + hi) >> 1; if (this.times[m]! < x) lo = m + 1; else hi = m; } return lo; }
  /** Primeiro índice com t[i] > x. */
  upperBound(x: number): number { let lo = 0, hi = this.size; while (lo < hi) { const m = (lo + hi) >> 1; if (this.times[m]! <= x) lo = m + 1; else hi = m; } return lo; }

  /** Estado (linear entre amostras). Em instantes com duas linhas, `after` escolhe a posterior. */
  linearAt(column: string, x: number, after = true): { kind: "gap" | "sample" | "interpolated"; value: number; between?: [number, number] } {
    const t = this.times, values = this.col(column);
    if (this.size === 0 || x < t[0]! || x > t[this.size - 1]!) return { kind: "gap", value: NaN };
    const i = after ? this.upperBound(x) - 1 : this.lowerBound(x);
    if (t[i] === x) return { kind: "sample", value: values[i]! };
    const [a, b] = after ? [i, i + 1] : [i - 1, i];
    const w = (x - t[a]!) / (t[b]! - t[a]!);
    return { kind: "interpolated", value: values[a]! + w * (values[b]! - values[a]!), between: [t[a]!, t[b]!] };
  }

  /** Valor do degrau que contém x: a linha i vale em (tᵢ₋₁, tᵢ]; side = +1 lado direito de x, −1 esquerdo.
   * Fronteiras a menos de 1 ns contam como a própria amostra (t = ns·1e-9 não é exato em binário). */
  stepValueAt(column: string, x: number, side: 1 | -1 = 1): number {
    if (this.size < 2) return NaN;
    const t = this.times, values = this.col(column);
    const tol = 1e-9 * Math.max(1, Math.abs(x));
    const i = side > 0 ? this.upperBound(x + tol) : this.lowerBound(x - tol);
    for (let k = Math.max(1, i); k < this.size; k++) { const v = values[k]!; if (!Number.isNaN(v) && t[k]! > t[k - 1]!) return v; }
    return NaN;
  }

  /** ∫ exata da série por degraus entre a e b (com cortes parciais). */
  stepIntegral(column: string, a: number, b: number): number {
    const t = this.times, values = this.col(column);
    let sum = 0;
    for (let k = Math.max(1, this.upperBound(a)); k < this.size && t[k - 1]! < b; k++) {
      const v = values[k]!;
      if (Number.isNaN(v)) continue;
      const lo = Math.max(a, t[k - 1]!), hi = Math.min(b, t[k]!);
      if (hi > lo) sum += v * (hi - lo);
    }
    return sum;
  }

  spillsBetween(a: number, b: number): number {
    return this.events.filter((e) => e.kind === "spill" && e.tS > a && e.tS <= b).reduce((sum, e) => sum + (e.volume ?? 0), 0);
  }
}

export type RiemannMethodName = "left" | "right" | "midpoint" | "trapezoid";

/** Soma de Riemann sobre a série por degraus; nada é decimado. */
export function riemannOnSteps(buffer: SeriesBuffer, column: string, a: number, b: number, n: number, method: RiemannMethodName) {
  const w = (b - a) / n;
  const bars: Array<{ x0: number; x1: number; height: number }> = [];
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x0 = a + i * w, x1 = x0 + w;
    let height: number;
    switch (method) {
      case "left": height = buffer.stepValueAt(column, x0, 1); break;
      case "right": height = buffer.stepValueAt(column, x1, -1); break;
      case "midpoint": height = buffer.stepValueAt(column, (x0 + x1) / 2, 1); break;
      default: height = (buffer.stepValueAt(column, x0, 1) + buffer.stepValueAt(column, x1, -1)) / 2;
    }
    bars.push({ x0, x1, height });
    sum += height * w;
  }
  return { sum, bars };
}
