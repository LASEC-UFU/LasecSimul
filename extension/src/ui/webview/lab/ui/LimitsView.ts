import type { LimitsActivity } from "../activity.js";
import { epsilonDelta, type EpsilonDeltaResult } from "../calc/analysis.js";
import { parseExpression, substitute, type Ast, type UserFunction } from "../calc/ast.js";
import { compileExpression, type CompiledExpression, type Evaluation } from "../calc/compile.js";
import { differentiate, simplify } from "../calc/derivative.js";
import { astToMathML, escapeXml } from "../calc/mathml.js";
import { differenceQuotient, sampleFunction, type Point, type QuotientResult } from "../calc/numeric.js";
import { differenceQuotientPolynomial, formatPolynomial, toPolynomial } from "../calc/poly.js";
import { LabGraph } from "../graph/LabGraph.js";
import { byId, clear, digitsFor, fmt, svg } from "./dom.js";
import { EditorView } from "./EditorView.js";
import { ICONS, iconButton } from "./icons.js";
import { mountPalette } from "./palette.js";
import { XYChart } from "./chart.js";
import { StepsPanel } from "./steps.js";

interface View { xMin: number; xMax: number; yMin: number; yMax: number }
interface Transform { v: View; W: number; H: number; L: number; R: number; T: number; B: number; toPx: (x: number, y: number) => Point; toWorldX: (px: number) => number }
interface Row { d: number; right: QuotientResult; left: QuotientResult }
type CalcResult =
  | { kind: "error"; reason: string }
  | { kind: "derivative"; variable: string; derivative: Ast; at: Evaluation; a: number }
  | { kind: "value"; result: Evaluation };

export interface LimitsViewOptions {
  teacher: boolean;
  onSave: (activity: LimitsActivity) => void;
}

/** Estatísticas expostas para testes de interface (renders por desenhável, latências). */
export interface ViewStats { renders: Record<string, number>; latencies: number[]; frames: number }

/**
 * Atividade "Limites" (docs/56): P fixo, Q arrastável restrito à curva por parâmetro, secante, tangente exata
 * para polinômios, tabela bilateral, Δt = 0 indefinido, editor do modelo e calculadora de Cálculo.
 * Desenho coalescido por requestAnimationFrame e invalidado só pelos insumos que mudaram (LabGraph).
 */
export class LimitsView {
  readonly graph = new LabGraph();
  readonly stats: ViewStats = { renders: {}, latencies: [], frames: 0 };
  private readonly dirty = new Set<string>();
  private frameRequested = false;
  private pendingInputAt: number | undefined;
  private dragging = false;
  private authoringView: View;
  private modelEditor!: EditorView;
  private calcEditor!: EditorView;
  private activeEditor!: EditorView;
  private readonly drawables: Array<{ id: string; inputs: string[]; draw: () => void }> = [];
  private disposed = false;

  constructor(private readonly root: HTMLElement, private activity: LimitsActivity, private readonly options: LimitsViewOptions) {
    this.authoringView = { xMin: activity.domain[0] - 0.3, xMax: activity.domain[1] + 0.6, yMin: -1, yMax: 10 };
    this.renderLayout();
    this.buildGraph();
    this.buildDrawables();
    this.bindInteraction();
    this.buildEditors();
    this.buildEpsilonDelta();
    new StepsPanel(byId("limSteps"), this.activity.steps);
    this.requestFrame();
  }

  dispose(): void { this.disposed = true; clear(this.root); }

  // ------------------------------------------------------------------ ε–δ (M7)
  /** Quociente q(Δ) = [H(a+Δ) − H(a)]/Δ com H = modelo (ou o contraexemplo com salto em a); L = limite exato
   * do modelo quando polinomial, senão a avaliação de lim do núcleo. δ é a maior faixa verificada por amostras. */
  private buildEpsilonDelta(): void {
    const g = this.graph, v = this.activity.variable;
    g.source("epsilon", this.activity.epsilon, { kind: "inspection" });
    g.source("counter", false, { kind: "inspection" });
    g.derived("quotientFn", ["ast", "a", "counter"], (ast: Ast, a: number, counter: boolean) => {
      const model: Ast = counter ? ["If", ["Less", v, a], ast, ["Add", ast, 1]] : ast;
      const at = (x: Ast): Ast => substitute(model, v, x);
      return compileExpression(["Divide", ["Subtract", at(["Add", a, "Δ"]), at(a)], "Δ"], ["Δ"]);
    }, { equals: Object.is });
    g.derived("limitL", ["exactQuotient", "ast", "a"], (exact: number[] | null, ast: Ast, a: number) => {
      if (exact) return exact[0] ?? NaN;
      const at = (x: Ast): Ast => substitute(ast, v, x);
      const r = compileExpression(["Limit", ["Divide", ["Subtract", at(["Add", a, "Δ"]), at(a)], "Δ"], "Δ", 0, 0], []).evaluate([]);
      return r.kind === "finite" ? r.value : NaN;
    });
    g.derived("epsDelta", ["quotientFn", "limitL", "epsilon"], (fn: CompiledExpression, L: number, eps: number) => epsilonDelta(fn, 0, L, eps, 1), { equals: () => false });
    const chart = new XYChart(byId("limEpsChart") as unknown as SVGSVGElement, { W: 600, H: 240, L: 50, R: 12, T: 18, B: 30 });
    const draw = (): void => {
      const fn = g.get<CompiledExpression>("quotientFn"), L = g.get<number>("limitL"), eps = g.get<number>("epsilon"), r = g.get<EpsilonDeltaResult>("epsDelta");
      const span = Math.max(1, Math.abs(L)) * 0.6 + eps * 2;
      chart.setView({ x0: -1, x1: 1, y0: (Number.isFinite(L) ? L : 0) - span, y1: (Number.isFinite(L) ? L : 0) + span });
      const under = chart.layer("under"), base = chart.layer("base"), over = chart.layer("over");
      if (Number.isFinite(L)) svg("rect", { x: chart.x(-1), y: chart.y(L + eps), width: chart.x(1) - chart.x(-1), height: chart.y(L - eps) - chart.y(L + eps), fill: "#dcfce7", "data-band": "epsilon" }, under);
      if (r.kind === "delta") svg("rect", { x: chart.x(-r.delta), y: chart.geo.T, width: chart.x(r.delta) - chart.x(-r.delta), height: chart.geo.H - chart.geo.T - chart.geo.B, fill: "#dbeafe", "fill-opacity": 0.6, "data-band": "delta" }, under);
      chart.axes(base, { xLabel: `Δ${v}`, yLabel: "q(Δ)" });
      const xs = Array.from({ length: 401 }, (_, k) => -1 + k / 200).filter((x) => x !== 0);
      const left = xs.filter((x) => x < 0).map((x) => [x, fn.value([x])] as [number, number]).filter(([, y]) => Number.isFinite(y));
      const right = xs.filter((x) => x > 0).map((x) => [x, fn.value([x])] as [number, number]).filter(([, y]) => Number.isFinite(y));
      chart.path(base, [left, right], { stroke: "#1d4ed8", "stroke-width": 2, "data-series": "quotient" });
      if (Number.isFinite(L)) {
        chart.dot(over, 0, L, { r: 5, fill: "#fff", stroke: "#1d4ed8", "stroke-width": 2 }); // Δ = 0 fora do domínio
        chart.hLine(over, L, { stroke: "#16a34a", "stroke-dasharray": "4 3" });
      }
      if (r.kind === "none" && Number.isFinite(r.witness)) chart.dot(over, r.witness, fn.value([r.witness]), { r: 5, fill: "#dc2626", "data-witness": "1" });
      byId("limEpsOut").textContent = fmt(eps, 4);
      byId<HTMLInputElement>("limEps").value = String(Math.log10(eps));
      byId("limEpsResult").innerHTML = !Number.isFinite(L)
        ? "<p>sem L: o limite do quociente não foi encontrado</p>"
        : r.kind === "delta"
          ? `<p id="limDelta">Para ε = ${fmt(eps, 4)}: δ = <strong>${fmt(r.delta, 4)}</strong> funciona (L = ${fmt(L, 6)})</p><p class="note">verificado em ${r.samples} amostras de 0 &lt; |Δ| &lt; δ — evidência numérica, não prova</p>`
          : `<p id="limDelta">Nenhum δ serve para ε = ${fmt(eps, 4)}: perto de Δ = 0 há ${fmt(r.witness, 6)} com |q − L| = ${fmt(r.gap, 4)} ≥ ε.</p><p class="note">${escapeXml(r.reason)}</p>`;
    };
    this.drawables.push({ id: "epsilon", inputs: ["epsDelta", "quotientFn", "limitL", "epsilon"], draw });
    this.dirty.add("epsilon");
    byId<HTMLInputElement>("limEps").addEventListener("input", (ev) => { this.markInput(); g.set("epsilon", Number((10 ** Number((ev.target as HTMLInputElement).value)).toPrecision(3))); });
    byId<HTMLInputElement>("limCounter").addEventListener("change", (ev) => g.set("counter", (ev.target as HTMLInputElement).checked));
  }

  // ------------------------------------------------------------------ layout
  private renderLayout(): void {
    const a = this.activity;
    const yx = `${a.units.y}/${a.units.x}`;
    this.root.innerHTML = `
<section class="lim-question"><h1 id="limQuestion">${escapeXml(a.question)}</h1>
  <p class="note">Aproxime Q de P pelos dois lados e observe a tendência.</p></section>
<div id="limSteps"></div>
<div class="lim-grid">
  <section class="panel dark" aria-label="Processo reconstruído pelo modelo">
    <svg id="limTank" viewBox="0 0 200 320" role="img" aria-labelledby="limTankLabel"></svg>
    <p id="limTankLabel" class="note"></p>
    <div class="model">
      <span class="model-label">Modelo: <math><mrow><mi>h</mi><mo>(</mo><mi>${escapeXml(a.variable)}</mi><mo>)</mo><mo>=</mo></mrow></math></span>
      <div id="limModelEditor"></div>
      <p id="limModelError" class="error" role="alert"></p>
      <small>${escapeXml(a.variable)} em ${escapeXml(a.units.x)} · h em ${escapeXml(a.units.y)}</small>
    </div>
    <div id="limTeacher" class="teacher" hidden>
      <label>Pergunta <input id="limQuestionInput" type="text" /></label>
      <label>a <input id="limAInput" type="number" step="0.1" /></label>
      <label>domínio <input id="limD0" type="number" step="0.5" /> a <input id="limD1" type="number" step="0.5" /></label>
      <p id="limSaveStatus" class="note" role="status"></p>
    </div>
  </section>
  <section class="panel" aria-label="Gráfico">
    <div class="plot-head"><h2>Dois pontos cada vez mais próximos</h2><div id="limToolbar" class="toolbar" role="toolbar" aria-label="Ferramentas do gráfico"></div></div>
    <svg id="limPlot" class="plot" viewBox="0 0 600 420"></svg>
    <div class="controls">
      <fieldset><legend>Lado</legend>
        <label><input type="radio" name="limSide" value="1" checked /> <span class="ic">${ICONS.sideRight}</span> pela direita (Δ${escapeXml(a.variable)} &gt; 0)</label>
        <label><input type="radio" name="limSide" value="-1" /> <span class="ic">${ICONS.sideLeft}</span> pela esquerda (Δ${escapeXml(a.variable)} &lt; 0)</label>
      </fieldset>
      <label>|Δ${escapeXml(a.variable)}| (escala log) <input id="limDtSlider" type="range" min="-3" max="0" step="0.01" /></label>
      <label>|Δ${escapeXml(a.variable)}| = <input id="limDtInput" type="number" min="0" max="2" step="0.001" inputmode="decimal" /></label>
    </div>
    <p id="limDtValue" class="note" aria-live="polite"></p>
  </section>
  <section class="panel" aria-label="Velocidade média">
    <h2>Taxa média</h2>
    <table><thead><tr><th scope="col">Δ${escapeXml(a.variable)} (${escapeXml(a.units.x)})</th><th scope="col" class="right">Pela direita (${escapeXml(yx)})</th><th scope="col" class="left">Pela esquerda (${escapeXml(yx)})</th></tr></thead>
      <tbody id="limTable"></tbody></table>
    <p class="limit" id="limLimit"></p>
    <p class="warning" id="limWarning" role="status"></p>
  </section>
</div>
<section class="calc" aria-label="Calculadora de Cálculo">
  <div class="panel">
    <h2>Calculadora — limite, derivada, integral e somatório sobre h</h2>
    <div id="limCalcEditor"></div>
    <div id="limCalcResult" class="calc-result" aria-live="polite"></div>
    <div id="limExamples" class="examples" aria-label="Exemplos"></div>
  </div>
  <div id="limPalette" class="panel" aria-label="Teclado matemático"></div>
</section>
<footer class="lim-footer"><p id="limEquation" class="equation" aria-live="polite"></p></footer>
<section class="calc eps" aria-label="ε–δ">
  <div class="panel">
    <h2>ε–δ: o quociente fica a menos de ε de L sempre que 0 &lt; |Δ${escapeXml(a.variable)}| &lt; δ?</h2>
    <svg id="limEpsChart" class="chart" aria-label="Quociente em função de Δ, faixa L ± ε e faixa ± δ"></svg>
  </div>
  <div class="panel">
    <label>ε <output id="limEpsOut"></output><input id="limEps" type="range" min="-3" max="0.5" step="0.01" aria-label="ε (escala log)" /></label>
    <label><input type="checkbox" id="limCounter" /> contraexemplo pronto: h com salto de 1 em ${escapeXml(a.variable)} = a</label>
    <div id="limEpsResult" class="calc-result" aria-live="polite"></div>
  </div>
</section>`;
  }

  // ------------------------------------------------------------------ grafo
  private buildGraph(): void {
    const g = this.graph, a = this.activity, v = a.variable;
    g.source("expr", a.model, { kind: "authoring" });
    g.source("a", a.a, { kind: "authoring" });
    g.source("domain", a.domain, { kind: "authoring" });
    g.source("rows", a.rows, { kind: "authoring" });
    g.source("dt", a.initialDelta, { kind: "inspection" });
    g.source("view", this.authoringView, { kind: "view" });
    g.derived("ast", ["expr"], (text: string) => parseExpression(text, [v]));
    g.derived("fn", ["ast"], (ast: Ast) => compileExpression(ast, [v]), { equals: Object.is });
    g.derived("poly", ["ast"], (ast: Ast) => toPolynomial(ast, v) ?? null);
    g.derived("P", ["fn", "a"], (fn: CompiledExpression, t: number) => ({ t, h: fn.value([t]) }));
    g.derived("Q", ["fn", "a", "dt"], (fn: CompiledExpression, t: number, dt: number) => ({ t: t + dt, h: fn.value([t + dt]) }));
    g.derived("quotient", ["fn", "a", "dt"], (fn: CompiledExpression, t: number, dt: number) => differenceQuotient(fn, t, dt));
    g.derived("exactQuotient", ["poly", "a"], (poly: number[] | null, t: number) => (poly ? differenceQuotientPolynomial(poly, t) : null));
    g.derived("tableRows", ["fn", "a", "rows"], (fn: CompiledExpression, t: number, rows: number[]): Row[] =>
      rows.map((d) => ({ d, right: differenceQuotient(fn, t, d), left: differenceQuotient(fn, t, -d) })));
    g.derived("transform", ["view"], (view: View): Transform => {
      const W = 600, H = 420, L = 56, R = 12, T = 12, B = 36;
      const sx = (W - L - R) / (view.xMax - view.xMin), sy = (H - T - B) / (view.yMax - view.yMin);
      return { v: view, W, H, L, R, T, B, toPx: (x, y) => [L + (x - view.xMin) * sx, H - B - (y - view.yMin) * sy], toWorldX: (px) => view.xMin + (px - L) / sx };
    }, { equals: Object.is });
    g.derived("curve", ["fn", "transform", "domain"], (fn: CompiledExpression, tr: Transform, d: [number, number]) =>
      sampleFunction(fn, Math.max(d[0], tr.v.xMin), Math.min(d[1], tr.v.xMax), tr.toPx));
    g.source("calcText", this.defaultCalc(), { kind: "inspection" });
    g.derived("calcResult", ["calcText", "ast", "a"], (text: string, model: Ast, t: number): CalcResult => {
      const functions: Record<string, UserFunction> = { h: { param: v, ast: model } };
      let ast: Ast;
      try { ast = parseExpression(text, [], { functions }); } catch (error) { return { kind: "error", reason: error instanceof Error ? error.message : String(error) }; }
      if (Array.isArray(ast) && ast[0] === "D") {
        const variable = ast[2] as string;
        try {
          const derivative = simplify(differentiate(ast[1] as Ast, variable));
          return { kind: "derivative", variable, derivative, at: compileExpression(derivative, [variable]).evaluate([t]), a: t };
        } catch (error) { return { kind: "error", reason: error instanceof Error ? error.message : String(error) }; }
      }
      try { return { kind: "value", result: compileExpression(ast, []).evaluate([]) }; } catch (error) { return { kind: "error", reason: error instanceof Error ? error.message : String(error) }; }
    });
    this.authoringView = this.fitView();
    g.set("view", this.authoringView);
  }

  private defaultCalc(): string { const v = this.activity.variable; return `Limit(Δ${v}, 0, 0, (h(${this.activity.a}+Δ${v})-h(${this.activity.a}))/Δ${v})`; }

  private fitView(): View {
    const fn = this.graph.get<CompiledExpression>("fn"), [d0, d1] = this.activity.domain;
    let lo = 0, hi = 1;
    for (let i = 0; i <= 200; i++) { const y = fn.value([d0 + ((d1 - d0) * i) / 200]); if (Number.isFinite(y)) { lo = Math.min(lo, y); hi = Math.max(hi, y); } }
    const pad = (hi - lo) * 0.08 || 1;
    return { xMin: d0 - 0.3, xMax: d1 + 0.6, yMin: lo - pad, yMax: hi + pad };
  }

  // ------------------------------------------------------------------ desenho
  private buildDrawables(): void {
    const plot = byId("limPlot") as unknown as SVGSVGElement;
    const layers = Object.fromEntries(["axes", "curve", "tangent", "secant", "guides", "points"].map((id) => [id, svg("g", { "data-layer": id }, plot)])) as Record<string, SVGGElement>;
    const pointsLayer = layers.points as SVGGElement;
    const p = svg("circle", { r: 6, fill: "#1e3a8a" }, pointsLayer);
    const pLabel = svg("text", { "text-anchor": "end", "font-size": 13, fill: "#1e3a8a" }, pointsLayer);
    const q = svg("circle", { r: 9, tabindex: 0, role: "slider", id: "limQ", "aria-label": "Ponto Q sobre a curva", "aria-valuemin": this.activity.domain[0], "aria-valuemax": this.activity.domain[1] }, pointsLayer);
    const qLabel = svg("text", { "font-size": 13, fill: "#7c2d12" }, pointsLayer);
    this.attachDrag(q);
    const add = (id: string, inputs: string[], draw: () => void): void => { this.drawables.push({ id, inputs, draw }); this.dirty.add(id); };
    add("axes", ["transform"], () => this.drawAxes(layers.axes as SVGGElement));
    add("curve", ["curve", "transform"], () => this.drawCurve(layers.curve as SVGGElement));
    add("tangent", ["P", "exactQuotient", "transform"], () => this.drawTangent(layers.tangent as SVGGElement));
    add("secant", ["P", "Q", "quotient", "transform"], () => this.drawSecant(layers.secant as SVGGElement));
    add("guides", ["P", "Q", "transform"], () => this.drawGuides(layers.guides as SVGGElement));
    add("points", ["P", "Q", "transform"], () => this.drawPoints(p, pLabel, q, qLabel));
    add("table", ["tableRows", "dt", "quotient"], () => this.drawTable());
    add("limit", ["exactQuotient", "quotient"], () => this.drawLimit());
    add("equation", ["a", "dt", "quotient", "exactQuotient", "P", "Q"], () => this.drawEquation());
    add("tank", ["Q", "view"], () => this.drawTank());
    add("controls", ["dt"], () => this.syncControls());
    add("calc", ["calcResult"], () => this.drawCalc());
    this.graph.onChange((changed) => {
      for (const d of this.drawables) if (d.inputs.some((i) => changed.has(i))) this.dirty.add(d.id);
      this.requestFrame();
    });
  }

  private requestFrame(): void {
    if (this.frameRequested || this.disposed) return;
    this.frameRequested = true;
    requestAnimationFrame(() => {
      this.frameRequested = false;
      if (this.disposed) return;
      this.stats.frames++;
      for (const d of this.drawables) {
        if (!this.dirty.has(d.id)) continue;
        d.draw();
        this.stats.renders[d.id] = (this.stats.renders[d.id] ?? 0) + 1;
      }
      this.dirty.clear();
      if (this.pendingInputAt !== undefined) { this.stats.latencies.push(performance.now() - this.pendingInputAt); this.pendingInputAt = undefined; }
    });
  }
  private markInput(): void { if (this.pendingInputAt === undefined) this.pendingInputAt = performance.now(); }

  private tr(): Transform { return this.graph.get<Transform>("transform"); }
  private drawAxes(g: SVGGElement): void {
    clear(g);
    const tr = this.tr(), a = this.activity;
    const [x0, y0] = tr.toPx(Math.max(tr.v.xMin, Math.min(tr.v.xMax, 0)), Math.max(tr.v.yMin, Math.min(tr.v.yMax, 0)));
    svg("line", { x1: tr.L, y1: y0, x2: tr.W - tr.R, y2: y0, stroke: "#334155" }, g);
    svg("line", { x1: x0, y1: tr.T, x2: x0, y2: tr.H - tr.B, stroke: "#334155" }, g);
    const nice = (span: number): number => { const raw = span / 6, mag = 10 ** Math.floor(Math.log10(raw)); return [1, 2, 5, 10].map((k) => k * mag).find((s) => s >= raw) ?? raw; };
    const xs = nice(tr.v.xMax - tr.v.xMin), ys = nice(tr.v.yMax - tr.v.yMin);
    for (let t = Math.ceil(tr.v.xMin / xs) * xs; t <= tr.v.xMax; t += xs) {
      const [px] = tr.toPx(t, 0);
      svg("line", { x1: px, y1: y0 - 4, x2: px, y2: y0 + 4, stroke: "#334155" }, g);
      svg("text", { x: px, y: y0 + 18, "text-anchor": "middle", "font-size": 12, fill: "#334155" }, g).textContent = fmt(t, 4);
    }
    for (let y = Math.ceil(tr.v.yMin / ys) * ys; y <= tr.v.yMax; y += ys) {
      const [, py] = tr.toPx(0, y);
      svg("text", { x: tr.L - 6, y: py + 4, "text-anchor": "end", "font-size": 12, fill: "#334155" }, g).textContent = fmt(y, 4);
    }
    svg("text", { x: tr.W - tr.R, y: y0 - 8, "text-anchor": "end", "font-size": 13, fill: "#0f172a" }, g).textContent = `${a.variable} (${a.units.x})`;
    svg("text", { x: tr.L + 6, y: tr.T + 12, "font-size": 13, fill: "#0f172a" }, g).textContent = `h (${a.units.y})`;
  }
  private drawCurve(g: SVGGElement): void {
    clear(g);
    const tr = this.tr();
    for (const seg of this.graph.get<Point[][]>("curve")) {
      const d = seg.map(([x, y], i) => { const [px, py] = tr.toPx(x, y); return `${i ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)}`; }).join("");
      svg("path", { d, fill: "none", stroke: "#2563eb", "stroke-width": 2.5 }, g);
    }
  }
  private lineThrough(g: SVGGElement, t0: number, h0: number, slope: number, attrs: Record<string, string | number>): void {
    const tr = this.tr();
    const [x1, y1] = tr.toPx(tr.v.xMin, h0 + slope * (tr.v.xMin - t0));
    const [x2, y2] = tr.toPx(tr.v.xMax, h0 + slope * (tr.v.xMax - t0));
    svg("line", { x1, y1, x2, y2, ...attrs }, g);
  }
  private drawTangent(g: SVGGElement): void {
    clear(g);
    const exact = this.graph.get<number[] | null>("exactQuotient"), P = this.graph.get<{ t: number; h: number }>("P");
    if (!exact || !Number.isFinite(P.h)) return; // sem forma exata, não desenha tangente (não finge)
    this.lineThrough(g, P.t, P.h, exact[0] ?? 0, { stroke: "#0e7490", "stroke-width": 1.5, "stroke-dasharray": "2 4" });
  }
  private drawSecant(g: SVGGElement): void {
    clear(g);
    const q = this.graph.get<QuotientResult>("quotient"), P = this.graph.get<{ t: number; h: number }>("P"), Q = this.graph.get<{ t: number; h: number }>("Q");
    if (q.kind !== "finite") return;
    this.lineThrough(g, P.t, P.h, q.value, { stroke: Q.t >= P.t ? "#c2410c" : "#1d4ed8", "stroke-width": 2, "stroke-dasharray": "8 5" });
  }
  private drawGuides(g: SVGGElement): void {
    clear(g);
    const tr = this.tr(), P = this.graph.get<{ t: number; h: number }>("P"), Q = this.graph.get<{ t: number; h: number }>("Q");
    if (!Number.isFinite(P.h) || !Number.isFinite(Q.h)) return;
    const [px, py] = tr.toPx(P.t, P.h), [qx, qy] = tr.toPx(Q.t, Q.h);
    svg("line", { x1: px, y1: py, x2: qx, y2: py, stroke: "#64748b", "stroke-dasharray": "3 3" }, g);
    svg("line", { x1: qx, y1: py, x2: qx, y2: qy, stroke: "#64748b", "stroke-dasharray": "3 3" }, g);
    svg("text", { x: (px + qx) / 2, y: py + 16, "text-anchor": "middle", "font-size": 12, fill: "#334155" }, g).textContent = `Δ${this.activity.variable}`;
    svg("text", { x: qx + 6, y: (py + qy) / 2, "font-size": 12, fill: "#334155" }, g).textContent = "Δh";
  }
  /** Pontos atualizados NO LUGAR: o foco do teclado permanece em Q e não há recriação de nós por quadro. */
  private drawPoints(p: SVGCircleElement, pLabel: SVGTextElement, q: SVGCircleElement, qLabel: SVGTextElement): void {
    const tr = this.tr(), P = this.graph.get<{ t: number; h: number }>("P"), Q = this.graph.get<{ t: number; h: number }>("Q");
    const [px, py] = tr.toPx(P.t, Number.isFinite(P.h) ? P.h : 0), [qx, qy] = tr.toPx(Q.t, Number.isFinite(Q.h) ? Q.h : 0);
    p.setAttribute("cx", String(px)); p.setAttribute("cy", String(py));
    pLabel.setAttribute("x", String(px - 10)); pLabel.setAttribute("y", String(py - 10));
    pLabel.textContent = `P(${fmt(P.t)}; ${fmt(P.h)})`;
    const right = Q.t >= P.t;
    q.setAttribute("cx", String(qx)); q.setAttribute("cy", String(qy));
    q.setAttribute("fill", right ? "#c2410c" : "#1d4ed8");
    q.setAttribute("aria-valuenow", Q.t.toFixed(3));
    q.setAttribute("aria-valuetext", `Q em ${this.activity.variable} = ${fmt(Q.t)} ${this.activity.units.x}, h = ${fmt(Q.h)} ${this.activity.units.y}`);
    // rótulo de Q do lado oposto ao de P para não sobrepor quando Δ é pequeno
    qLabel.setAttribute("x", String(qx + (right ? 12 : -12)));
    qLabel.setAttribute("y", String(qy + (Math.abs(qx - px) < 60 ? 22 : -10)));
    qLabel.setAttribute("text-anchor", right ? "start" : "end");
    qLabel.textContent = `Q(${fmt(Q.t)}; ${fmt(Q.h)})`;
  }
  private cell(r: QuotientResult, d: number): string { return r.kind === "finite" ? fmt(r.value, digitsFor(d) + 2) : "indefinido"; }
  private drawTable(): void {
    const body = byId("limTable"), rows = this.graph.get<Row[]>("tableRows"), dt = this.graph.get<number>("dt"), q = this.graph.get<QuotientResult>("quotient");
    body.textContent = "";
    const add = (label: string, right: string, left: string, current: boolean): void => {
      const tr = document.createElement("tr");
      if (current) tr.className = "current";
      for (const [text, cls] of [[label, ""], [right, "right"], [left, "left"]] as const) {
        const td = document.createElement("td");
        td.textContent = text;
        if (cls) td.className = cls;
        tr.appendChild(td);
      }
      body.appendChild(tr);
    };
    for (const r of rows) add(fmt(r.d), this.cell(r.right, r.d), this.cell(r.left, r.d), false);
    add(`atual: ${fmt(Math.abs(dt))}`, dt > 0 ? this.cell(q, dt) : "", dt < 0 ? this.cell(q, dt) : "", true);
  }
  private drawLimit(): void {
    const exact = this.graph.get<number[] | null>("exactQuotient"), q = this.graph.get<QuotientResult>("quotient"), u = `${this.activity.units.y}/${this.activity.units.x}`;
    const box = byId("limLimit");
    box.textContent = "";
    const big = document.createElement("span");
    big.textContent = exact ? `→ ${fmt(exact[0] ?? NaN)} ${u} ←` : "sem forma exata";
    const small = document.createElement("small");
    small.textContent = exact ? `limite exato: termo constante do quociente (h é polinomial)` : "use a calculadora: evidência numérica não é demonstração";
    box.append(big, small);
    byId("limWarning").textContent = q.kind === "undefined" ? `⚠ ${q.reason}. O quociente não existe; o limite é outro objeto.`
      : q.kind === "precision-limit" ? `⚠ ${q.reason}.` : q.warning ? `⚠ ${q.warning}.` : "";
  }
  private drawEquation(): void {
    const a = this.graph.get<number>("a"), dt = this.graph.get<number>("dt"), q = this.graph.get<QuotientResult>("quotient");
    const exact = this.graph.get<number[] | null>("exactQuotient"), P = this.graph.get<{ h: number }>("P"), Q = this.graph.get<{ h: number }>("Q");
    const v = this.activity.variable, u = `${this.activity.units.y}/${this.activity.units.x}`;
    const exactText = exact ? `= ${formatPolynomial(exact, `Δ${v}`)} (Δ${v} ≠ 0)` : "";
    const valueText = q.kind === "finite" ? ` = ${fmt(q.value, digitsFor(dt) + 2)} ${u}` : " — indefinido";
    byId("limEquation").textContent = `Δh/Δ${v} = [h(${fmt(a)}+Δ${v}) − h(${fmt(a)})]/Δ${v} ${exactText}; com Δ${v} = ${fmt(dt)}: (${fmt(Q.h)} − ${fmt(P.h)})/${fmt(dt)}${valueText}`;
  }
  private drawTank(): void {
    const tank = byId("limTank") as unknown as SVGSVGElement, Q = this.graph.get<{ t: number; h: number }>("Q"), view = this.graph.get<View>("view");
    clear(tank);
    const level = Math.max(0, Math.min(1, Q.h / Math.max(1e-9, view.yMax)));
    svg("rect", { x: 40, y: 20, width: 120, height: 260, rx: 8, fill: "none", stroke: "#94a3b8", "stroke-width": 3 }, tank);
    svg("rect", { x: 43, y: 20 + 260 * (1 - (Number.isFinite(level) ? level : 0)), width: 114, height: 260 * (Number.isFinite(level) ? level : 0), fill: "#38bdf8", opacity: 0.8 }, tank);
    svg("text", { x: 100, y: 305, "text-anchor": "middle", "font-size": 14, fill: "#e2e8f0" }, tank).textContent = `h(${fmt(Q.t)}) = ${fmt(Q.h)} ${this.activity.units.y}`;
    byId("limTankLabel").textContent = "Reconstrução pelo modelo no instante de Q (inspeção, não estado do simulador).";
  }
  private syncControls(): void {
    const dt = this.graph.get<number>("dt"), mag = Math.abs(dt);
    const slider = byId<HTMLInputElement>("limDtSlider"), input = byId<HTMLInputElement>("limDtInput");
    if (mag > 0 && document.activeElement !== slider) slider.value = String(Math.log10(Math.min(1, Math.max(1e-3, mag))));
    if (document.activeElement !== input) input.value = String(Number(mag.toPrecision(6)));
    for (const r of Array.from(document.querySelectorAll<HTMLInputElement>("input[name=limSide]"))) if (dt !== 0) r.checked = Number(r.value) === Math.sign(dt);
    byId("limDtValue").textContent = `Δ${this.activity.variable} = ${fmt(dt)} ${this.activity.units.x} (${dt > 0 ? "pela direita" : dt < 0 ? "pela esquerda" : "Q sobre P"})`;
  }
  private badge(r: { exact?: boolean; methods?: string[] }): string {
    return `<span class="badge ${r.exact ? "exact" : "numeric"}">${r.exact ? "exato" : "aproximação numérica"}</span> <span class="method">${escapeXml((r.methods ?? []).join("; "))}</span>`;
  }
  private drawCalc(): void {
    const res = this.graph.get<CalcResult>("calcResult"), box = byId("limCalcResult");
    if (res.kind === "error") {
      box.textContent = "";
      const p = document.createElement("p");
      p.className = "error";
      const empty = this.calcEditor?.emptyFields() ?? 0;
      p.textContent = empty ? `Complete ${empty} campo(s) vazio(s).` : res.reason;
      box.append(p);
      return;
    }
    if (res.kind === "derivative") {
      const v = escapeXml(res.variable);
      box.innerHTML = `<p><math><mrow><mfrac><mi>d</mi><mrow><mi>d</mi><mi>${v}</mi></mrow></mfrac><mo>=</mo></mrow></math> ${astToMathML(res.derivative)} <span class="badge exact">exata</span> <span class="method">derivada simbólica (regras)</span></p>`
        + `<p>em ${v} = ${fmt(res.a)}: <strong>${res.at.kind === "finite" ? fmt(res.at.value, 10) : "indefinida"}</strong>${res.at.kind === "finite" ? "" : ` — ${escapeXml(res.at.reason)}`}</p>`;
      return;
    }
    const r = res.result;
    box.innerHTML = r.kind === "finite"
      ? `<p class="calc-value">= <strong>${fmt(r.value, 10)}</strong> ${this.badge(r)}</p>`
      : `<p class="calc-value">não existe / indefinido ${this.badge({ exact: !r.methods.some((m) => m.startsWith("evidência")), methods: r.methods })}</p><p class="note">${escapeXml(r.reason)}</p>`;
  }

  // ------------------------------------------------------------------ interação (inspeção: nunca escreve no simulador)
  private setDt(dt: number): void { this.markInput(); this.graph.set("dt", dt); }
  private sideSign(): number { return Number(document.querySelector<HTMLInputElement>("input[name=limSide]:checked")?.value ?? 1); }
  private plotX(e: PointerEvent | WheelEvent): number { const r = byId("limPlot").getBoundingClientRect(); return ((e.clientX - r.left) / r.width) * 600; }
  private attachDrag(handle: SVGCircleElement): void {
    handle.addEventListener("pointerdown", (e) => { this.dragging = true; byId("limPlot").setPointerCapture(e.pointerId); e.preventDefault(); });
    handle.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 0.001 : 0.05, dt = this.graph.get<number>("dt");
      const map: Record<string, number> = { ArrowRight: dt + step, ArrowUp: dt + step, ArrowLeft: dt - step, ArrowDown: dt - step, Home: this.activity.domain[0] - this.graph.get<number>("a"), End: this.activity.domain[1] - this.graph.get<number>("a") };
      const next = map[e.key];
      if (next === undefined) return;
      e.preventDefault();
      this.setDt(Number(next.toFixed(6)));
    });
  }
  private bindInteraction(): void {
    const plot = byId("limPlot");
    plot.addEventListener("pointermove", (e) => {
      if (!this.dragging) return;
      const [d0, d1] = this.graph.get<[number, number]>("domain");
      const t = Math.min(d1, Math.max(d0, this.tr().toWorldX(this.plotX(e)))); // restrição ao domínio, por parâmetro
      this.setDt(t - this.graph.get<number>("a"));
    });
    plot.addEventListener("pointerup", () => { this.dragging = false; });
    plot.addEventListener("wheel", (e) => {
      e.preventDefault();
      const v = this.tr().v, x = this.tr().toWorldX(this.plotX(e)), k = e.deltaY < 0 ? 0.8 : 1.25;
      this.graph.set("view", { ...v, xMin: x - (x - v.xMin) * k, xMax: x + (v.xMax - x) * k });
    }, { passive: false });
    byId<HTMLInputElement>("limDtSlider").addEventListener("input", (e) => this.setDt(this.sideSign() * 10 ** Number((e.target as HTMLInputElement).value)));
    byId<HTMLInputElement>("limDtInput").addEventListener("change", (e) => { const v = Number((e.target as HTMLInputElement).value); if (Number.isFinite(v) && v >= 0) this.setDt(this.sideSign() * v); });
    for (const r of Array.from(document.querySelectorAll<HTMLInputElement>("input[name=limSide]"))) r.addEventListener("change", () => this.setDt(this.sideSign() * (Math.abs(this.graph.get<number>("dt")) || this.activity.initialDelta)));
    const toolbar = byId("limToolbar");
    const zoom = (k: number): void => { const v = this.graph.get<View>("view"), c = (v.xMin + v.xMax) / 2; this.graph.set("view", { ...v, xMin: c - (c - v.xMin) * k, xMax: c + (v.xMax - c) * k }); };
    const tools: Array<[HTMLButtonElement, (b: HTMLButtonElement) => void]> = [
      [iconButton("zoomIn", "Aproximar (zoom +)"), () => zoom(0.8)],
      [iconButton("zoomOut", "Afastar (zoom −)"), () => zoom(1.25)],
      [iconButton("resetView", "Restaurar vista", { id: "limResetView" }), () => this.graph.set("view", this.authoringView)],
      [iconButton("deltaZero", "Δ = 0 (Q sobre P)", { id: "limZero" }), () => this.setDt(0)],
      [iconButton("keyboard", "Mostrar/ocultar teclado matemático", { id: "limKbd", pressed: true }), (b) => { const hidden = byId("limPalette").toggleAttribute("hidden"); b.setAttribute("aria-pressed", String(!hidden)); }],
    ];
    if (this.options.teacher) tools.push([iconButton("save", "Gravar atividade no projeto", { id: "limSave" }), () => this.save()]);
    for (const [button, action] of tools) { button.addEventListener("click", () => action(button)); toolbar.appendChild(button); }
    byId("limTeacher").hidden = !this.options.teacher;
    if (this.options.teacher) {
      byId<HTMLInputElement>("limQuestionInput").value = this.activity.question;
      byId<HTMLInputElement>("limAInput").value = String(this.activity.a);
      byId<HTMLInputElement>("limD0").value = String(this.activity.domain[0]);
      byId<HTMLInputElement>("limD1").value = String(this.activity.domain[1]);
      byId<HTMLInputElement>("limQuestionInput").addEventListener("input", (e) => { byId("limQuestion").textContent = (e.target as HTMLInputElement).value; });
      byId<HTMLInputElement>("limAInput").addEventListener("change", (e) => {
        const a = Number((e.target as HTMLInputElement).value), [d0, d1] = this.graph.get<[number, number]>("domain");
        if (Number.isFinite(a) && a >= d0 && a <= d1) this.graph.set("a", a);
      });
      const domainChange = (): void => {
        const d0 = Number(byId<HTMLInputElement>("limD0").value), d1 = Number(byId<HTMLInputElement>("limD1").value);
        if (!(Number.isFinite(d0) && Number.isFinite(d1) && d1 > d0)) return;
        this.activity = { ...this.activity, domain: [d0, d1] };
        this.graph.batch(() => { this.graph.set("domain", [d0, d1]); this.authoringView = this.fitView(); this.graph.set("view", this.authoringView); });
      };
      byId("limD0").addEventListener("change", domainChange);
      byId("limD1").addEventListener("change", domainChange);
    }
  }

  /** Atividade com o que está na tela agora (modelo, a, domínio, pergunta) — usada ao trocar de modo. */
  currentActivity(): LimitsActivity {
    const questionInput = document.getElementById("limQuestionInput") as HTMLInputElement | null;
    const question = (this.options.teacher ? questionInput?.value.trim() : "") || this.activity.question;
    return { ...this.activity, question, model: this.graph.get<string>("expr"), a: this.graph.get<number>("a"), domain: this.graph.get<[number, number]>("domain"), epsilon: this.graph.get<number>("epsilon") };
  }

  private save(): void {
    const updated = this.currentActivity();
    this.activity = updated;
    byId("limSaveStatus").textContent = "Gravando…";
    this.options.onSave(updated);
  }

  /** Confirmação do host após gravar. */
  saved(): void { const s = document.getElementById("limSaveStatus"); if (s) s.textContent = "Atividade gravada no projeto (salve o .lsproj para persistir)."; }

  // ------------------------------------------------------------------ editores
  private buildEditors(): void {
    const v = this.activity.variable;
    this.modelEditor = new EditorView(byId("limModelEditor"), {
      variable: v, label: "Modelo h",
      onChange: (text) => {
        try {
          compileExpression(parseExpression(text, [v]), [v]); // valida antes de tocar no grafo
          byId("limModelError").textContent = "";
          this.markInput();
          this.graph.set("expr", text); // propaga já: fitView precisa da função nova
          this.authoringView = this.fitView();
          this.graph.set("view", this.authoringView);
        } catch (error) {
          const empty = this.modelEditor?.emptyFields() ?? 0;
          byId("limModelError").textContent = empty ? `Complete ${empty} campo(s) vazio(s).` : error instanceof Error ? error.message : String(error);
        }
      },
    });
    try { this.modelEditor.setAst(this.graph.get<Ast>("ast")); } catch (error) { byId("limModelError").textContent = String(error); }
    this.calcEditor = new EditorView(byId("limCalcEditor"), { variable: "x", label: "Calculadora", onChange: (text) => { this.markInput(); this.graph.set("calcText", text); } });
    this.loadCalc(this.defaultCalc());
    this.activeEditor = this.modelEditor;
    for (const ed of [this.modelEditor, this.calcEditor]) ed.host.addEventListener("focusin", () => { this.activeEditor = ed; });
    mountPalette(byId("limPalette"), () => this.activeEditor, v);
    const a = this.activity.a, examples: Array<[string, string]> = [
      ["quociente → limite", this.defaultCalc()],
      [`∫ h de ${fmt(this.activity.domain[0])} a ${fmt(a)}`, `Integrate(${v}, ${this.activity.domain[0]}, ${a}, h(${v}))`],
      [`d/d${v} h`, `D(${v}, h(${v}))`],
      ["Σ Riemann (n = 8)", `Sum(k, 0, 7, h(${this.activity.domain[0]}+k*${(a - this.activity.domain[0]) / 8})*${(a - this.activity.domain[0]) / 8})`],
      ["lim sen x / x", "Limit(x, 0, 0, sin(x)/x)"],
      ["lim |x| / x", "Limit(x, 0, 0, abs(x)/x)"],
      ["lim 1/x (x→0⁺)", "Limit(x, 0, 1, 1/x)"],
    ];
    for (const [label, text] of examples) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.addEventListener("click", () => this.loadCalc(text));
      byId("limExamples").appendChild(b);
    }
  }
  private loadCalc(text: string): void {
    const functions: Record<string, UserFunction> = { h: { param: this.activity.variable, ast: this.graph.get<Ast>("ast") } };
    try { this.calcEditor.setAst(parseExpression(text, [], { keepCalls: true, functions })); } catch (error) { byId("limCalcResult").textContent = String(error); }
  }
}
