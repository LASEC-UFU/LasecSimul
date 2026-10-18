import type { AxisActivity } from "../activity.js";
import { parseExpression, type Ast } from "../calc/ast.js";
import { compileExpression, type CompiledExpression } from "../calc/compile.js";
import { differentiate } from "../calc/derivative.js";
import { astToMathML } from "../calc/mathml.js";
import { LabGraph } from "../graph/LabGraph.js";
import type { LabToHostMessage } from "../messages.js";
import { byId, clear, svg } from "./dom.js";
import { iconButton } from "./icons.js";
import type { ViewStats } from "./LimitsView.js";
import { ChartHandle, XYChart } from "./chart.js";
import { StepsPanel } from "./steps.js";

export interface AxisViewOptions { teacher: boolean; send: (message: LabToHostMessage) => void; onSave: (activity: AxisActivity) => void }

const nf = (x: number, d = 4): string => (Number.isFinite(x) ? x.toLocaleString("pt-BR", { maximumFractionDigits: d }) : "—");
const SYMBOLS = ["t", "L", "T"];
const GEO = { W: 640, H: 170, L: 60, R: 12, T: 16, B: 26 };

/**
 * Experimento C (docs/53 §1): eixo com trajetória S x(t) = L(3τ² − 2τ³), τ = t/T, só na Webview (sem
 * solver). v e a são derivadas SIMBÓLICAS exatas do polinômio; a tabela mostra o quociente central
 * convergindo para v(t₀); a reta tangente aproxima x perto de t₀. x, v e a compartilham o cursor.
 */
export class AxisView {
  readonly graph = new LabGraph();
  readonly stats: ViewStats = { renders: {}, latencies: [], frames: 0 };
  private readonly charts: Record<"x" | "v" | "a", XYChart>;
  private handle!: ChartHandle;
  private readonly dirty = new Set<string>();
  private readonly drawables: Array<{ id: string; inputs: string[]; draw: () => void }> = [];
  private frameRequested = false;
  private disposed = false;
  private animation = 0;
  readonly functions: { x: Ast; v: Ast; a: Ast; fx: CompiledExpression; fv: CompiledExpression; fa: CompiledExpression };

  constructor(private readonly root: HTMLElement, private activity: AxisActivity, private readonly options: AxisViewOptions) {
    const x = parseExpression("L*(3*(t/T)^2 - 2*(t/T)^3)", SYMBOLS);
    const v = differentiate(x, "t"), a = differentiate(v, "t");
    this.functions = { x, v, a, fx: compileExpression(x, SYMBOLS), fv: compileExpression(v, SYMBOLS), fa: compileExpression(a, SYMBOLS) };
    this.render();
    this.charts = {
      x: new XYChart(byId("axChartX") as unknown as SVGSVGElement, GEO),
      v: new XYChart(byId("axChartV") as unknown as SVGSVGElement, GEO),
      a: new XYChart(byId("axChartA") as unknown as SVGSVGElement, GEO),
    };
    for (const chart of Object.values(this.charts)) chart.layer("under");
    const handles = svg("g", { "data-layer": "handles" }, this.charts.x.root);
    this.handle = new ChartHandle(handles, {
      label: "Instante t₀ da tangente", min: 0, max: activity.T, step: activity.T / 40, color: "#ea580c",
      text: (t0) => `t₀ = ${nf(t0, 2)} s, x = ${nf(this.at("x", t0), 2)} mm`, onChange: (t0) => this.graph.set("t0", t0),
    }, activity.t0);
    this.graph.source("L", activity.L, { kind: "authoring" });
    this.graph.source("T", activity.T, { kind: "authoring" });
    this.graph.source("t0", activity.t0, { kind: "inspection" });
    this.graph.source("cursor", activity.t0, { kind: "inspection" });
    this.drawables.push(
      { id: "charts", inputs: ["L", "T"], draw: () => this.drawCharts() },
      { id: "over", inputs: ["L", "T", "t0", "cursor"], draw: () => this.drawOver() },
      { id: "axis", inputs: ["L", "T", "cursor"], draw: () => this.drawAxis() },
      { id: "table", inputs: ["L", "T", "t0"], draw: () => this.drawTable() },
    );
    for (const d of this.drawables) this.dirty.add(d.id);
    this.graph.onChange((changed) => { for (const d of this.drawables) if (d.inputs.some((i) => changed.has(i))) this.dirty.add(d.id); this.requestFrame(); });
    this.requestFrame();
    options.send({ version: 1, type: "labActivate", activity });
  }

  dispose(): void { this.disposed = true; if (this.animation) cancelAnimationFrame(this.animation); clear(this.root); }
  saved(): void { const s = document.getElementById("axSaveStatus"); if (s) s.textContent = "Atividade gravada no projeto (salve o .lsproj para persistir)."; }

  currentActivity(): AxisActivity {
    const input = document.getElementById("axQuestionInput") as HTMLInputElement | null;
    const question = (this.options.teacher ? input?.value.trim() : "") || this.activity.question;
    return { ...this.activity, question, L: this.graph.get("L"), T: this.graph.get("T"), t0: Math.min(this.graph.get<number>("t0"), this.graph.get<number>("T")) };
  }

  /** Valor exato (derivada simbólica) de x, v ou a no instante t. */
  at(kind: "x" | "v" | "a", t: number): number {
    const env = [t, this.graph.get<number>("L") ?? this.activity.L, this.graph.get<number>("T") ?? this.activity.T];
    return (kind === "x" ? this.functions.fx : kind === "v" ? this.functions.fv : this.functions.fa).value(env);
  }

  private render(): void {
    const a = this.activity;
    this.root.innerHTML = `
<section class="lim-question"><h1 id="axQuestion"></h1><p class="note">Trajetória prescrita (sem simulador): x, v e a vêm do mesmo polinômio; v e a por derivada simbólica exata.</p></section>
<div id="axSteps"></div>
<main class="tank-layout">
  <section class="panel dark" aria-label="Eixo">
    <h2>Eixo</h2>
    <svg id="axAxis" viewBox="0 0 320 120" role="img" aria-label="Carro sobre o trilho na posição do cursor"></svg>
    <div class="sliders">
      <label>Curso L <output id="axLOut"></output><input id="axL" type="range" min="20" max="1000" step="10" value="${a.L}" /></label>
      <label>Duração T <output id="axTOut"></output><input id="axT" type="range" min="1" max="20" step="0.5" value="${a.T}" /></label>
      <label>Cursor t <output id="axCursorOut"></output><input id="axCursor" type="range" min="0" max="${a.T}" step="0.01" value="${a.t0}" /></label>
    </div>
    <div class="toolbar" id="axRunBar"></div>
    <div id="axFormulas" class="equations"></div>
    <div id="axTeacher" class="teacher" hidden>
      <label>Pergunta <input id="axQuestionInput" type="text" /></label>
      <p id="axSaveStatus" class="note" role="status"></p>
    </div>
  </section>
  <section class="panel" aria-label="x, v e a">
    <h2>x(t) com a tangente em t₀ (arraste o ponto laranja)</h2>
    <svg id="axChartX" class="chart" tabindex="0" aria-label="posição"></svg>
    <h2>v(t) = x′(t)</h2>
    <svg id="axChartV" class="chart" aria-label="velocidade"></svg>
    <h2>a(t) = v′(t)</h2>
    <svg id="axChartA" class="chart" aria-label="aceleração"></svg>
  </section>
</main>
<section class="tank-bottom">
  <div id="axValues" class="equations" aria-live="polite"></div>
  <div><h3>Quociente central em t₀</h3><table id="axTable"></table></div>
  <div id="axTangent" class="calc-result" aria-live="polite"></div>
</section>`;
    byId("axQuestion").textContent = a.question;
    byId<HTMLInputElement>("axQuestionInput").value = a.question;
    byId("axTeacher").hidden = !this.options.teacher;
    if (this.options.teacher) {
      const save = iconButton("save", "Gravar atividade no projeto", { id: "axSave" });
      save.addEventListener("click", () => this.options.onSave(this.currentActivity()));
      byId("axTeacher").appendChild(save);
    }
    new StepsPanel(byId("axSteps"), a.steps);
    const bind = (id: string, key: string) => byId<HTMLInputElement>(id).addEventListener("input", (ev) => this.graph.set(key, Number((ev.target as HTMLInputElement).value)));
    bind("axL", "L"); bind("axT", "T"); bind("axCursor", "cursor");
    const play = iconButton("play", "Animar de 0 a T", { id: "axPlay" });
    play.addEventListener("click", () => this.animate());
    byId("axRunBar").appendChild(play);
    byId("axFormulas").innerHTML = ["x", "v", "a"].map((k) => `<p>${k}(t) = ${astToMathML(this.functions[k as "x" | "v" | "a"])}</p>`).join("");
    for (const id of ["axChartX", "axChartV", "axChartA"]) {
      byId(id).addEventListener("pointerdown", (ev) => {
        if ((ev.target as Element).getAttribute("role") === "slider") return;
        const chart = this.charts[id === "axChartX" ? "x" : id === "axChartV" ? "v" : "a"];
        this.graph.set("cursor", Math.max(0, Math.min(this.graph.get<number>("T"), chart.pointerX(ev))));
      });
    }
    let dragging = false;
    queueMicrotask(() => {
      this.handle.element.addEventListener("pointerdown", (ev) => { dragging = true; this.charts.x.root.setPointerCapture(ev.pointerId); ev.preventDefault(); });
      this.charts.x.root.addEventListener("pointermove", (ev) => { if (dragging) this.graph.set("t0", Math.max(0, Math.min(this.graph.get<number>("T"), this.charts.x.pointerX(ev)))); });
      this.charts.x.root.addEventListener("pointerup", () => { dragging = false; });
    });
  }

  private animate(): void {
    if (this.animation) cancelAnimationFrame(this.animation);
    const T = this.graph.get<number>("T"), start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(T, (now - start) / 1000);
      this.graph.set("cursor", t);
      this.animation = t < T ? requestAnimationFrame(tick) : 0;
    };
    this.animation = requestAnimationFrame(tick);
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

  private views(): void {
    const L = this.graph.get<number>("L"), T = this.graph.get<number>("T");
    const vmax = 1.5 * L / T, amax = 6 * L / T ** 2;
    this.charts.x.setView({ x0: 0, x1: T, y0: -0.08 * L, y1: 1.12 * L });
    this.charts.v.setView({ x0: 0, x1: T, y0: -0.1 * vmax, y1: 1.15 * vmax });
    this.charts.a.setView({ x0: 0, x1: T, y0: -1.15 * amax, y1: 1.15 * amax });
  }

  private drawCharts(): void {
    this.views();
    const T = this.graph.get<number>("T");
    const ts = Array.from({ length: 241 }, (_, k) => (k / 240) * T);
    const style: Record<"x" | "v" | "a", [string, string]> = { x: ["#1d4ed8", "x (mm)"], v: ["#0e7490", "v (mm/s)"], a: ["#7c3aed", "a (mm/s²)"] };
    for (const kind of ["x", "v", "a"] as const) {
      const chart = this.charts[kind], base = chart.layer("base");
      chart.axes(base, { xLabel: "t (s)", yLabel: style[kind][1], xDecimals: 1, yDecimals: 0 });
      chart.path(base, [ts.map((t) => [t, this.at(kind, t)] as [number, number])], { stroke: style[kind][0], "stroke-width": 2, "data-series": kind });
    }
    byId("axLOut").textContent = `${nf(this.graph.get("L"), 0)} mm`;
    byId("axTOut").textContent = `${nf(this.graph.get("T"), 1)} s`;
    byId<HTMLInputElement>("axCursor").max = String(T);
  }

  private drawOver(): void {
    this.views();
    const T = this.graph.get<number>("T"), t0 = Math.min(this.graph.get<number>("t0"), T), t = Math.min(this.graph.get<number>("cursor"), T);
    for (const kind of ["x", "v", "a"] as const) {
      const chart = this.charts[kind], over = chart.layer("over");
      chart.vLine(over, t, { stroke: "#16a34a", "stroke-dasharray": "3 3" });
      chart.dot(over, t, this.at(kind, t), { fill: "#16a34a", r: 4 });
      if (kind === "x") {
        const x0 = this.at("x", t0), v0 = this.at("v", t0), span = T / 4;
        chart.path(over, [[[t0 - span, x0 - v0 * span], [t0 + span, x0 + v0 * span]]], { stroke: "#ea580c", "stroke-width": 2, "data-tangent": "x" });
        this.handle.update(t0, chart.x(t0), chart.y(x0), T);
      }
    }
    byId("axCursorOut").textContent = `${nf(t, 2)} s`;
    byId<HTMLInputElement>("axCursor").value = String(t);
    const values = (["x", "v", "a"] as const).map((k) => `${k}(${nf(t, 2)}) = ${nf(this.at(k, t), 3)}`).join(" · ");
    byId("axValues").innerHTML = `<p id="axCursorValues">${values} <span class="badge exact">exato (derivada simbólica)</span></p>
      <p class="note">v = 0 em t = 0 e t = T; |v| máxima e a = 0 em t = T/2 = ${nf(T / 2, 2)} s; |a| máxima nos extremos.</p>`;
    const h = T / 10, approx = this.at("x", t0) + this.at("v", t0) * h, real = this.at("x", t0 + h);
    byId("axTangent").innerHTML = `<p>Tangente em t₀ = ${nf(t0, 2)} s: x(t₀ + ${nf(h, 2)}) ≈ ${nf(approx, 3)} mm; real ${nf(real, 3)} mm; erro ${nf(real - approx, 4)} mm</p>
      <p class="note">o erro da aproximação linear cai como h² perto de t₀</p>`;
  }

  private drawAxis(): void {
    const root = byId("axAxis") as unknown as SVGSVGElement, L = this.graph.get<number>("L"), t = Math.min(this.graph.get<number>("cursor"), this.graph.get<number>("T"));
    clear(root);
    const x = this.at("x", t), px = 30 + (Math.max(0, Math.min(L, x)) / L) * 260;
    svg("line", { x1: 30, y1: 80, x2: 290, y2: 80, stroke: "#cbd5e1", "stroke-width": 4 }, root);
    for (let k = 0; k <= 4; k++) {
      const gx = 30 + (k / 4) * 260;
      svg("line", { x1: gx, y1: 84, x2: gx, y2: 92, stroke: "#cbd5e1" }, root);
      svg("text", { x: gx, y: 106, "text-anchor": "middle", "font-size": 10, fill: "#e2e8f0" }, root).textContent = nf((k / 4) * L, 0);
    }
    svg("rect", { x: px - 18, y: 52, width: 36, height: 24, rx: 4, fill: "#38bdf8", stroke: "#e0f2fe", "data-axis-x": x.toFixed(3) }, root);
    svg("text", { x: px, y: 44, "text-anchor": "middle", "font-size": 12, fill: "#bfdbfe" }, root).textContent = `x = ${nf(x, 1)} mm`;
  }

  private drawTable(): void {
    const t0 = Math.min(this.graph.get<number>("t0"), this.graph.get<number>("T")), exact = this.at("v", t0);
    const rows = [1, 0.1, 0.01, 0.001].map((h) => {
      const q = (this.at("x", t0 + h) - this.at("x", t0 - h)) / (2 * h);
      return `<tr><td>${nf(h, 3)}</td><td>${nf(q, 6)}</td><td>${(q - exact).toExponential(2)}</td></tr>`;
    });
    byId("axTable").innerHTML = `<thead><tr><th>h (s)</th><th>[x(t₀+h) − x(t₀−h)]/2h</th><th>− v(t₀)</th></tr></thead><tbody>${rows.join("")}</tbody>
      <tfoot><tr><td colspan="3">v(t₀) = <strong id="axExactV">${nf(exact, 6)}</strong> mm/s <span class="badge exact">exata</span></td></tr></tfoot>`;
  }
}
