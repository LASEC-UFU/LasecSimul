import type { FunctionsActivity } from "../activity.js";
import { asymptotes, findIntersections, findRoots, piecewisePoints, type Asymptotes, type PiecewisePoint } from "../calc/analysis.js";
import { parseExpression, substitute, type Ast } from "../calc/ast.js";
import { compileExpression, type CompiledExpression } from "../calc/compile.js";
import { differentiate, simplify } from "../calc/derivative.js";
import { antiderivative } from "../calc/integral.js";
import { astToMathML, escapeXml } from "../calc/mathml.js";
import { sampleFunction, type Point } from "../calc/numeric.js";
import { LabGraph } from "../graph/LabGraph.js";
import type { LabToHostMessage } from "../messages.js";
import { byId, clear, svg } from "./dom.js";
import { EditorView } from "./EditorView.js";
import { iconButton } from "./icons.js";
import type { ViewStats } from "./LimitsView.js";
import { ChartHandle, XYChart, type ChartView } from "./chart.js";
import { mountPalette } from "./palette.js";
import { StepsPanel } from "./steps.js";

export interface FunctionsViewOptions { teacher: boolean; send: (message: LabToHostMessage) => void; onSave: (activity: FunctionsActivity) => void }

const nf = (x: number, d = 4): string => (Number.isFinite(x) ? x.toLocaleString("pt-BR", { maximumFractionDigits: d }) : "—");
const BOUND = "ξ";

/** Tudo que depende de f, g e dos parâmetros (recalculado quando um deles muda). */
interface Model {
  ok: boolean;
  error?: string;
  symbolic?: Ast;
  numeric?: Ast;
  f?: CompiledExpression;
  g?: CompiledExpression;
  gAst?: Ast;
  derivative?: CompiledExpression;
  derivativeAst?: Ast;
  integral?: CompiledExpression;
  antiderivativeAst?: Ast;
  antiderivativeMethods: string[];
  asymptotes?: Asymptotes;
  roots: number[];
  intersections: Array<[number, number]>;
  pieces: PiecewisePoint[];
}

/**
 * Explorador de funções (docs/52 §4.7 e §4.4–4.6): f e g editáveis com parâmetros, gráfico com quebra
 * em descontinuidades, assíntotas (exatas para racionais), raízes e interseções, pontos abertos/fechados
 * de funções por partes, f′ simbólica, F(x) = ∫ₐˣ f (antiderivada exata quando existe; senão Simpson),
 * tabela ligada ao gráfico e um ponto arrastável com a reta tangente ou "não diferenciável aqui".
 */
export class FunctionsView {
  readonly graph = new LabGraph();
  readonly stats: ViewStats = { renders: {}, latencies: [], frames: 0 };
  private chart!: XYChart;
  private handle!: ChartHandle;
  private fEditor!: EditorView;
  private gEditor!: EditorView;
  private activeEditor!: EditorView;
  private readonly dirty = new Set<string>();
  private readonly drawables: Array<{ id: string; inputs: string[]; draw: () => void }> = [];
  private frameRequested = false;
  private disposed = false;
  private readonly authoredView: ChartView;

  constructor(private readonly root: HTMLElement, private activity: FunctionsActivity, private readonly options: FunctionsViewOptions) {
    const a = activity;
    this.authoredView = { x0: a.domain[0], x1: a.domain[1], y0: a.range[0], y1: a.range[1] };
    const g = this.graph;
    g.source("fText", a.f, { kind: "authoring" });
    g.source("gText", a.g, { kind: "authoring" });
    g.source("params", Object.fromEntries(a.parameters.map((p) => [p.name, p.value])), { kind: "authoring", equals: (x, y) => JSON.stringify(x) === JSON.stringify(y) });
    g.source("show", { ...a.show }, { kind: "view", equals: (x, y) => JSON.stringify(x) === JSON.stringify(y) });
    g.source("view", { ...this.authoredView }, { kind: "view", equals: (x, y) => JSON.stringify(x) === JSON.stringify(y) });
    g.source("x0", (a.domain[0] + a.domain[1]) / 2 + 0.5, { kind: "inspection" });
    g.derived("model", ["fText", "gText", "params", "view"], (fText: string, gText: string, params: Record<string, number>, view: ChartView) => this.buildModel(fText, gText, params, view), { equals: () => false });
    this.render();
    this.drawables.push(
      { id: "base", inputs: ["model", "show", "view"], draw: () => this.drawBase() },
      { id: "over", inputs: ["model", "show", "view", "x0"], draw: () => this.drawOver() },
      { id: "info", inputs: ["model", "show"], draw: () => this.drawInfo() },
      { id: "table", inputs: ["model", "show", "x0"], draw: () => this.drawTable() },
    );
    for (const d of this.drawables) this.dirty.add(d.id);
    this.graph.onChange((changed) => { for (const d of this.drawables) if (d.inputs.some((i) => changed.has(i))) this.dirty.add(d.id); this.requestFrame(); });
    this.requestFrame();
    options.send({ version: 1, type: "labActivate", activity });
  }

  dispose(): void { this.disposed = true; clear(this.root); }
  saved(): void { const s = document.getElementById("fnSaveStatus"); if (s) s.textContent = "Atividade gravada no projeto (salve o .lsproj para persistir)."; }

  currentActivity(): FunctionsActivity {
    const input = document.getElementById("fnQuestionInput") as HTMLInputElement | null;
    const question = (this.options.teacher ? input?.value.trim() : "") || this.activity.question;
    const params = this.graph.get<Record<string, number>>("params"), view = this.graph.get<ChartView>("view");
    return {
      ...this.activity, question, f: this.graph.get("fText"), g: this.graph.get("gText"),
      parameters: this.activity.parameters.map((p) => ({ ...p, value: params[p.name] ?? p.value })),
      show: { ...this.graph.get<FunctionsActivity["show"]>("show") },
      domain: [view.x0, view.x1], range: [view.y0, view.y1],
    };
  }

  // ------------------------------------------------------------------ modelo
  private buildModel(fText: string, gText: string, params: Record<string, number>, view: ChartView): Model {
    const v = this.activity.variable;
    const symbols = [v, ...this.activity.parameters.map((p) => p.name)];
    const empty: Model = { ok: false, antiderivativeMethods: [], roots: [], intersections: [], pieces: [] };
    let symbolic: Ast;
    try { symbolic = parseExpression(fText, symbols); } catch (err) { return { ...empty, error: `f: ${(err as Error).message}` }; }
    const bind = (ast: Ast): Ast => Object.entries(params).reduce<Ast>((acc, [name, value]) => substitute(acc, name, value), ast);
    const numeric = simplify(bind(symbolic));
    const model: Model = { ...empty, ok: true, symbolic, numeric };
    try { model.f = compileExpression(numeric, [v]); } catch (err) { return { ...empty, error: `f: ${(err as Error).message}` }; }
    if (gText.trim()) {
      try { model.gAst = simplify(bind(parseExpression(gText, symbols))); model.g = compileExpression(model.gAst, [v]); }
      catch (err) { model.error = `g: ${(err as Error).message}`; }
    }
    try { model.derivativeAst = simplify(differentiate(symbolic, v)); model.derivative = compileExpression(["D", numeric, v], [v]); } catch { /* sem regra: sem f′ */ }
    const anti = antiderivative(symbolic, v);
    if (anti) { model.antiderivativeAst = anti.ast; model.antiderivativeMethods = anti.methods; }
    model.integral = compileExpression(["Integrate", substitute(numeric, v, BOUND), ["Limits", BOUND, this.activity.integralFrom, v]], [v]);
    model.asymptotes = asymptotes(numeric, v, model.f, [view.x0, view.x1]);
    model.roots = findRoots(model.f, view.x0, view.x1);
    if (model.gAst !== undefined) model.intersections = findIntersections(numeric, model.gAst, v, [v], [0], view.x0, view.x1);
    model.pieces = piecewisePoints(numeric, v, [v], [0]);
    return model;
  }

  private value(fn: CompiledExpression | undefined, x: number): number { return fn ? fn.value([x]) : NaN; }

  // ------------------------------------------------------------------ layout
  private render(): void {
    const a = this.activity;
    const params = a.parameters.map((p) => `<label>${escapeXml(p.name)} <output id="fnOut_${p.name}">${nf(p.value, 3)}</output>
      <input id="fnParam_${p.name}" type="range" min="${p.min}" max="${p.max}" step="${p.step}" value="${p.value}" /></label>`).join("");
    const toggle = (key: keyof FunctionsActivity["show"], label: string) =>
      `<label><input type="checkbox" id="fnShow_${key}" ${a.show[key] ? "checked" : ""} /> ${label}</label>`;
    this.root.innerHTML = `
<section class="lim-question"><h1 id="fnQuestion"></h1><p class="note">Edite f e g, mova os parâmetros e arraste o ponto sobre f.</p></section>
<div id="fnSteps"></div>
<div class="lim-grid fn-grid">
  <section class="panel" aria-label="Funções e parâmetros">
    <div class="model"><span class="model-label">f(${escapeXml(a.variable)}) =</span><div id="fnF"></div><p id="fnError" class="error" role="alert"></p></div>
    <div class="model"><span class="model-label">g(${escapeXml(a.variable)}) =</span><div id="fnG"></div></div>
    <div class="sliders light">${params}</div>
    <fieldset class="toggles"><legend>Mostrar</legend>
      ${toggle("derivative", "f′")} ${toggle("integral", `F(${a.variable}) = ∫ f`)} ${toggle("asymptotes", "assíntotas")} ${toggle("roots", "raízes e interseções")} ${toggle("table", "tabela")}
    </fieldset>
    <div id="fnTeacher" class="teacher" hidden>
      <label>Pergunta <input id="fnQuestionInput" type="text" /></label>
      <p class="note">f, g, os valores dos parâmetros, os itens marcados e a vista atual viram a atividade.</p>
      <p id="fnSaveStatus" class="note" role="status"></p>
    </div>
  </section>
  <section class="panel" aria-label="Gráfico">
    <div class="plot-head"><h2>Gráfico</h2><div id="fnToolbar" class="toolbar" role="toolbar" aria-label="Vista"></div></div>
    <svg id="fnChart" class="plot" tabindex="0" aria-label="Gráfico de f e g; role a roda para zoom"></svg>
    <p id="fnPoint" class="note" aria-live="polite"></p>
  </section>
  <section class="panel" aria-label="Análise">
    <h2>Análise</h2>
    <div id="fnInfo" class="calc-result" aria-live="polite"></div>
    <table id="fnTable" aria-label="Tabela ligada ao gráfico"></table>
  </section>
</div>
<section class="calc"><div id="fnPalette" class="panel" aria-label="Teclado matemático"></div></section>`;
    byId("fnQuestion").textContent = a.question;
    byId<HTMLInputElement>("fnQuestionInput").value = a.question;
    byId("fnTeacher").hidden = !this.options.teacher;
    if (this.options.teacher) {
      const save = iconButton("save", "Gravar atividade no projeto", { id: "fnSave" });
      save.addEventListener("click", () => this.options.onSave(this.currentActivity()));
      byId("fnTeacher").appendChild(save);
    }
    new StepsPanel(byId("fnSteps"), a.steps);
    const symbols = [a.variable, ...a.parameters.map((p) => p.name)];
    const editor = (id: string, label: string, key: "fText" | "gText", initial: string, optional: boolean): EditorView => {
      const view = new EditorView(byId(id), { variable: a.variable, label, onChange: (text) => {
        if (optional && !text.trim()) { this.graph.set(key, ""); byId("fnError").textContent = ""; return; }
        try { parseExpression(text, symbols); byId("fnError").textContent = ""; this.graph.set(key, text); }
        catch (err) { byId("fnError").textContent = (err as Error).message; }
      } });
      if (initial.trim()) view.setAst(parseExpression(initial, symbols));
      return view;
    };
    this.fEditor = editor("fnF", "f", "fText", a.f, false);
    this.gEditor = editor("fnG", "g", "gText", a.g, true);
    this.activeEditor = this.fEditor;
    for (const ed of [this.fEditor, this.gEditor]) ed.host.addEventListener("focusin", () => { this.activeEditor = ed; });
    mountPalette(byId("fnPalette"), () => this.activeEditor, a.variable);
    for (const p of a.parameters) {
      byId<HTMLInputElement>(`fnParam_${p.name}`).addEventListener("input", (ev) => {
        const value = Number((ev.target as HTMLInputElement).value);
        byId(`fnOut_${p.name}`).textContent = nf(value, 3);
        this.graph.set("params", { ...this.graph.get<Record<string, number>>("params"), [p.name]: value });
      });
    }
    for (const key of ["derivative", "integral", "asymptotes", "roots", "table"] as const) {
      byId<HTMLInputElement>(`fnShow_${key}`).addEventListener("change", (ev) => this.graph.set("show", { ...this.graph.get<FunctionsActivity["show"]>("show"), [key]: (ev.target as HTMLInputElement).checked }));
    }
    const chartRoot = byId("fnChart") as unknown as SVGSVGElement;
    this.chart = new XYChart(chartRoot, { W: 600, H: 420, L: 46, R: 12, T: 18, B: 30 });
    this.chart.layer("under");
    const handles = svg("g", { "data-layer": "handles" }, chartRoot);
    this.handle = new ChartHandle(handles, {
      label: "Ponto sobre f", min: a.domain[0], max: a.domain[1], step: (a.domain[1] - a.domain[0]) / 100, color: "#ea580c",
      text: (x) => `x = ${nf(x, 3)}, f(x) = ${nf(this.value(this.graph.get<Model>("model").f, x), 4)}`,
      onChange: (x) => this.graph.set("x0", x),
    }, this.graph.get("x0"));
    let dragging = false;
    this.handle.element.addEventListener("pointerdown", (ev) => { dragging = true; chartRoot.setPointerCapture(ev.pointerId); ev.preventDefault(); });
    chartRoot.addEventListener("pointermove", (ev) => { if (dragging) this.graph.set("x0", this.chart.pointerX(ev)); });
    chartRoot.addEventListener("pointerup", () => { dragging = false; });
    chartRoot.addEventListener("wheel", (ev) => { // zoom com o ponto sob o cursor fixo
      ev.preventDefault();
      const k = ev.deltaY > 0 ? 1.2 : 1 / 1.2, x = this.chart.pointerX(ev), y = this.chart.pointerY(ev), v = this.graph.get<ChartView>("view");
      this.graph.set("view", { x0: x + (v.x0 - x) * k, x1: x + (v.x1 - x) * k, y0: y + (v.y0 - y) * k, y1: y + (v.y1 - y) * k });
    }, { passive: false });
    const zoom = (k: number) => { const v = this.graph.get<ChartView>("view"), cx = (v.x0 + v.x1) / 2, cy = (v.y0 + v.y1) / 2; this.graph.set("view", { x0: cx + (v.x0 - cx) * k, x1: cx + (v.x1 - cx) * k, y0: cy + (v.y0 - cy) * k, y1: cy + (v.y1 - cy) * k }); };
    const tools: Array<[HTMLButtonElement, () => void]> = [
      [iconButton("zoomIn", "Aproximar", { id: "fnZoomIn" }), () => zoom(1 / 1.25)],
      [iconButton("zoomOut", "Afastar", { id: "fnZoomOut" }), () => zoom(1.25)],
      [iconButton("resetView", "Restaurar a vista do professor", { id: "fnReset" }), () => this.graph.set("view", { ...this.authoredView })],
    ];
    for (const [button, action] of tools) { button.addEventListener("click", action); byId("fnToolbar").appendChild(button); }
  }

  private requestFrame(): void {
    if (this.frameRequested || this.disposed) return;
    this.frameRequested = true;
    requestAnimationFrame(() => {
      this.frameRequested = false;
      if (this.disposed) return;
      this.stats.frames++;
      for (const d of this.drawables) if (this.dirty.has(d.id)) { d.draw(); this.stats.renders[d.id] = (this.stats.renders[d.id] ?? 0) + 1; }
      this.dirty.clear();
    });
  }

  // ------------------------------------------------------------------ desenho
  private curve(group: SVGGElement, fn: CompiledExpression | undefined, attrs: Record<string, string | number>): void {
    if (!fn) return;
    const view = this.graph.get<ChartView>("view");
    const margin = (view.y1 - view.y0) * 4; // fora disso a curva é cortada (assíntotas)
    const segments = sampleFunction(fn, view.x0, view.x1, (x, y) => [this.chart.x(x), this.chart.y(Math.max(view.y0 - margin, Math.min(view.y1 + margin, y)))])
      .map((segment) => segment.map(([x, y]: Point) => [x, Math.max(view.y0 - margin, Math.min(view.y1 + margin, y))] as [number, number]));
    this.chart.path(group, segments, attrs);
  }

  private drawBase(): void {
    const model = this.graph.get<Model>("model"), show = this.graph.get<FunctionsActivity["show"]>("show");
    this.chart.setView(this.graph.get<ChartView>("view"));
    const under = this.chart.layer("under"), base = this.chart.layer("base");
    this.chart.axes(base, { xLabel: this.activity.variable, yLabel: "y" });
    if (!model.ok) return;
    if (show.asymptotes && model.asymptotes) {
      for (const x of model.asymptotes.vertical) this.chart.vLine(under, x, { stroke: "#dc2626", "stroke-dasharray": "6 4", "data-asymptote": "vertical" });
      for (const y of model.asymptotes.horizontal) this.chart.hLine(under, y, { stroke: "#dc2626", "stroke-dasharray": "6 4", "data-asymptote": "horizontal" });
      const o = model.asymptotes.oblique, v = this.chart.view;
      if (o) this.chart.path(under, [[[v.x0, o.slope * v.x0 + o.intercept], [v.x1, o.slope * v.x1 + o.intercept]]], { stroke: "#dc2626", "stroke-dasharray": "6 4", "data-asymptote": "oblique" });
    }
    if (show.integral) this.curve(base, model.integral, { stroke: "#7c3aed", "stroke-width": 2, "stroke-dasharray": "8 3", "data-series": "F" });
    if (show.derivative) this.curve(base, model.derivative, { stroke: "#0e7490", "stroke-width": 2, "stroke-dasharray": "4 3", "data-series": "df" });
    this.curve(base, model.g, { stroke: "#16a34a", "stroke-width": 2, "data-series": "g" });
    this.curve(base, model.f, { stroke: "#1d4ed8", "stroke-width": 2.5, "data-series": "f" });
    for (const piece of model.pieces) { // bolinha fechada no valor da função, aberta no outro lado
      for (const y of [piece.left, piece.right]) {
        if (!Number.isFinite(y)) continue;
        const closed = Math.abs(y - piece.value) <= 1e-9 * Math.max(1, Math.abs(y));
        this.chart.dot(base, piece.x, y, { r: 5, fill: closed ? "#1d4ed8" : "#fff", stroke: "#1d4ed8", "stroke-width": 2, "data-piece": closed ? "closed" : "open" });
      }
    }
  }

  private drawOver(): void {
    const model = this.graph.get<Model>("model"), show = this.graph.get<FunctionsActivity["show"]>("show");
    this.chart.setView(this.graph.get<ChartView>("view"));
    const over = this.chart.layer("over"), view = this.chart.view;
    const x0 = Math.max(view.x0, Math.min(view.x1, this.graph.get<number>("x0")));
    if (show.roots) {
      for (const r of model.roots) this.chart.dot(over, r, 0, { r: 4, fill: "#dc2626", "data-root": r.toFixed(6) });
      for (const [x, y] of model.intersections) this.chart.dot(over, x, y, { r: 4, fill: "#16a34a", "data-intersection": x.toFixed(6) });
    }
    const y0 = this.value(model.f, x0);
    const point = byId("fnPoint");
    if (!Number.isFinite(y0)) { point.textContent = `f(${nf(x0, 3)}) indefinida`; this.handle.update(x0, this.chart.x(x0), this.chart.y(0), view.x1); return; }
    this.handle.update(x0, this.chart.x(x0), this.chart.y(y0), view.x1);
    const d = model.derivative?.evaluate([x0]);
    if (d && d.kind === "finite") {
      const span = (view.x1 - view.x0) / 5;
      this.chart.path(over, [[[x0 - span, y0 - d.value * span], [x0 + span, y0 + d.value * span]]], { stroke: "#ea580c", "stroke-width": 2, "data-tangent": "f" });
      point.textContent = `P = (${nf(x0, 3)}; ${nf(y0, 4)}) · f′(${nf(x0, 3)}) = ${nf(d.value, 4)} (exata) · tangente y = ${nf(y0, 4)} + ${nf(d.value, 4)}(${this.activity.variable} − ${nf(x0, 3)})`;
    } else {
      const h = 1e-6 * Math.max(1, Math.abs(x0));
      const right = (this.value(model.f, x0 + h) - y0) / h, left = (y0 - this.value(model.f, x0 - h)) / h;
      point.textContent = `P = (${nf(x0, 3)}; ${nf(y0, 4)}) · não diferenciável aqui${d && d.kind === "undefined" ? ` (${d.reason})` : ""} · derivadas laterais ≈ ${nf(left, 4)} (esq.) e ${nf(right, 4)} (dir.)`;
    }
  }

  private drawInfo(): void {
    const model = this.graph.get<Model>("model"), show = this.graph.get<FunctionsActivity["show"]>("show"), box = byId("fnInfo"), v = this.activity.variable;
    byId("fnError").textContent = model.error ?? "";
    if (!model.ok || !model.numeric) { box.innerHTML = ""; return; }
    const parts: string[] = [`<p>f(${v}) = ${astToMathML(model.numeric)} <span class="note">(com os parâmetros atuais)</span></p>`];
    if (show.derivative) parts.push(model.derivativeAst !== undefined
      ? `<p>f′(${v}) = ${astToMathML(model.derivativeAst)} <span class="badge exact">derivada simbólica</span></p>`
      : `<p>f′: sem regra de derivação para esta expressão</p>`);
    if (show.integral) parts.push(model.antiderivativeAst !== undefined
      ? `<p>∫ f d${v} = ${astToMathML(model.antiderivativeAst)} + C <span class="badge exact">${escapeXml(model.antiderivativeMethods.join("; "))}</span></p><p class="note">F(${v}) = ∫ de ${nf(this.activity.integralFrom, 3)} a ${v}: tracejado roxo</p>`
      : `<p>∫ f: sem antiderivada elementar no núcleo — F(${v}) calculada por Simpson adaptativo <span class="badge numeric">numérica</span></p>`);
    if (show.asymptotes && model.asymptotes) {
      const a = model.asymptotes, list: string[] = [];
      for (const x of a.vertical) list.push(`${v} = ${nf(x, 6)}`);
      for (const y of a.horizontal) list.push(`y = ${nf(y, 6)}`);
      if (a.oblique) list.push(`y = ${nf(a.oblique.slope, 6)}${v} ${a.oblique.intercept < 0 ? "−" : "+"} ${nf(Math.abs(a.oblique.intercept), 6)}`);
      parts.push(`<p id="fnAsymptotes">Assíntotas: ${list.length ? list.join("; ") : "nenhuma na vista"} <span class="badge ${a.exact ? "exact" : "numeric"}">${a.exact ? "exata (racional)" : "evidência numérica"}</span></p>`);
    }
    if (show.roots) {
      parts.push(`<p id="fnRoots">Raízes: ${model.roots.length ? model.roots.map((r) => nf(r, 6)).join("; ") : "nenhuma na vista"} <span class="badge numeric">bisseção</span></p>`);
      if (model.g) parts.push(`<p id="fnIntersections">f = g em: ${model.intersections.length ? model.intersections.map(([x, y]) => `(${nf(x, 5)}; ${nf(y, 5)})`).join("; ") : "nenhum ponto na vista"}</p>`);
    }
    for (const piece of model.pieces) parts.push(`<p>Fronteira em ${v} = ${nf(piece.x, 4)}: ${piece.continuous ? "contínua" : `salto de ${nf(piece.left, 4)} para ${nf(piece.right, 4)}`} (bolinha cheia = valor da função)</p>`);
    box.innerHTML = parts.join("");
  }

  private drawTable(): void {
    const model = this.graph.get<Model>("model"), show = this.graph.get<FunctionsActivity["show"]>("show"), table = byId("fnTable");
    table.hidden = !show.table;
    if (!show.table || !model.f) { table.innerHTML = ""; return; }
    const [a, b] = this.activity.domain, step = this.activity.tableStep, x0 = this.graph.get<number>("x0");
    const rows: string[] = [];
    for (let x = a; x <= b + step * 1e-9 && rows.length < 41; x += step) {
      const fx = this.value(model.f, x), gx = this.value(model.g, x);
      const current = Math.abs(x - x0) < step / 2 ? ' class="current"' : "";
      rows.push(`<tr${current} data-x="${x}"><td>${nf(x, 3)}</td><td>${nf(fx, 5)}</td>${model.g ? `<td>${nf(gx, 5)}</td>` : ""}</tr>`);
    }
    table.innerHTML = `<thead><tr><th>${this.activity.variable}</th><th>f</th>${model.g ? "<th>g</th>" : ""}</tr></thead><tbody>${rows.join("")}</tbody>`;
    for (const row of Array.from(table.querySelectorAll<HTMLTableRowElement>("tbody tr"))) row.addEventListener("click", () => this.graph.set("x0", Number(row.dataset.x)));
  }
}
