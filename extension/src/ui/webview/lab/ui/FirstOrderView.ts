import type { FirstOrderActivity } from "../activity.js";
import { LabGraph } from "../graph/LabGraph.js";
import type { LabPlantStatus, LabRunStatus, LabSeriesDelta, LabToHostMessage } from "../messages.js";
import type { ParameterValues } from "../plants.js";
import { byId, clear, svg } from "./dom.js";
import { iconButton } from "./icons.js";
import type { ViewStats } from "./LimitsView.js";
import { XYChart } from "./chart.js";
import { ProcessShell } from "./processShell.js";
import { StepsPanel } from "./steps.js";

export interface FirstOrderViewOptions { teacher: boolean; send: (message: LabToHostMessage) => void; onSave: (activity: FirstOrderActivity) => void }

const nf = (x: number, d = 4): string => (Number.isFinite(x) ? x.toLocaleString("pt-BR", { maximumFractionDigits: d }) : "—");

/** Trecho de resposta desde o último degrau: início, valor nesse instante e valor final. */
interface Segment { t0: number; y0: number; yInf: number; tau: number; K: number; u: number }

/**
 * Experimento D (docs/53 §1): degrau u num bloco de primeira ordem no Core. Mostra y(t) gravado, o valor
 * final K·u, a linha de 63,2 % e a tangente no início do degrau (cruza o valor final em t₀ + τ); no
 * cursor compara dy/dt do modelo, (K·u − y)/τ, com a derivada medida nas amostras.
 */
export class FirstOrderView {
  readonly graph = new LabGraph();
  readonly shell: ProcessShell;
  readonly stats: ViewStats = { renders: {}, latencies: [], frames: 0 };
  private chart!: XYChart;
  private readonly dirty = new Set<string>();
  private readonly drawables: Array<{ id: string; inputs: string[]; draw: () => void }> = [];
  private frameRequested = false;
  private disposed = false;

  constructor(private readonly root: HTMLElement, private activity: FirstOrderActivity, private readonly options: FirstOrderViewOptions) {
    this.shell = new ProcessShell("fo", activity, this.graph, options.send);
    this.render();
    this.graph.source("cursor", null as number | null, { kind: "inspection" });
    this.graph.derived("now", ["rev"], () => this.buffer.now);
    this.graph.derived("window", ["now", "params"], (now: number, p: ParameterValues) => ({ t1: Math.max(6 * p.tau!, Math.ceil((now + 1) / 10) * 10) }), { equals: (x, y) => JSON.stringify(x) === JSON.stringify(y) });
    this.graph.derived("inspectT", ["cursor", "now"], (cursor: number | null, now: number) => (cursor === null ? now : Math.min(cursor, now)));
    this.drawables.push(
      { id: "chart", inputs: ["rev", "window", "params"], draw: () => this.drawChart() },
      { id: "over", inputs: ["rev", "window", "inspectT", "cursor", "params"], draw: () => this.drawOver() },
      { id: "block", inputs: ["rev", "params", "inspectT"], draw: () => this.drawBlock() },
      { id: "equations", inputs: ["rev", "inspectT", "params"], draw: () => this.drawEquations() },
      { id: "status", inputs: ["status", "now", "plant"], draw: () => this.shell.drawStatus(byId("foStatus"), this.graph.get("now")) },
      { id: "plant", inputs: ["plant"], draw: () => this.shell.drawPlant(byId("foPlant")) },
    );
    for (const d of this.drawables) this.dirty.add(d.id);
    this.graph.onChange((changed) => { for (const d of this.drawables) if (d.inputs.some((i) => changed.has(i))) this.dirty.add(d.id); this.requestFrame(); });
    this.requestFrame();
    options.send({ version: 1, type: "labActivate", activity });
  }

  get buffer() { return this.shell.buffer; }
  dispose(): void { this.disposed = true; this.shell.dispose(); clear(this.root); }
  plant(status: LabPlantStatus): void { this.shell.plant(status); }
  runState(status: LabRunStatus): void { this.shell.runState(status); }
  series(delta: LabSeriesDelta): void { this.shell.series(delta); }
  parameterAccepted(id: string, value: number): void { this.shell.parameterAccepted(id, value); }
  parameterRejected(id: string, reason: string): void { this.shell.parameterRejected(id, reason); }
  saved(): void { const s = document.getElementById("foSaveStatus"); if (s) s.textContent = "Atividade gravada no projeto (salve o .lsproj para persistir)."; }

  currentActivity(): FirstOrderActivity {
    const input = document.getElementById("foQuestionInput") as HTMLInputElement | null;
    const question = (this.options.teacher ? input?.value.trim() : "") || this.activity.question;
    return { ...this.activity, question, parameters: { ...this.shell.accepted }, ...(this.shell.plantComponentId ? { plantComponentId: this.shell.plantComponentId } : {}) };
  }

  private render(): void {
    this.root.innerHTML = `
<section class="lim-question"><h1 id="foQuestion"></h1><p class="note">Degrau u num bloco K/(τs + 1) que roda no simulador; os gráficos leem as séries gravadas.</p></section>
<div id="foPlant" class="plant-status" role="status"></div>
<div id="foSteps"></div>
<main class="tank-layout">
  <section class="panel dark" aria-label="Processo">
    <h2>Processo <span id="foStatus" class="status" role="status"></span></h2>
    <svg id="foBlock" viewBox="0 0 320 170" role="img" aria-label="Diagrama de blocos com os valores atuais"></svg>
    ${this.shell.controlsHtml()}
    <div id="foTeacher" class="teacher" hidden>
      <label>Pergunta <input id="foQuestionInput" type="text" /></label>
      <p id="foSaveStatus" class="note" role="status"></p>
    </div>
  </section>
  <section class="panel" aria-label="Resposta y(t)">
    <div class="chart-head"><h2>Resposta y(t)</h2><span class="note">clique no gráfico para inspecionar; ⟲ ao vivo</span></div>
    <svg id="foChart" class="chart" tabindex="0" aria-label="y(t) gravado, valor final, 63,2 % e tangentes; setas movem o cursor"></svg>
    <div id="foMeasure" class="calc-result" aria-live="polite"></div>
  </section>
</main>
<section class="tank-bottom"><div id="foEquations" class="equations" aria-live="polite"></div></section>`;
    byId("foQuestion").textContent = this.activity.question;
    byId<HTMLInputElement>("foQuestionInput").value = this.activity.question;
    byId("foTeacher").hidden = !this.options.teacher;
    if (this.options.teacher) {
      const save = iconButton("save", "Gravar atividade no projeto", { id: "foSave" });
      save.addEventListener("click", () => this.options.onSave(this.currentActivity()));
      byId("foTeacher").appendChild(save);
    }
    new StepsPanel(byId("foSteps"), this.activity.steps);
    this.chart = new XYChart(byId("foChart") as unknown as SVGSVGElement);
    this.shell.bind(() => this.graph.set("cursor", null));
    const chartRoot = byId("foChart");
    chartRoot.addEventListener("pointerdown", (ev) => this.graph.set("cursor", Math.max(0, Math.min(this.graph.get<number>("now"), this.chart.pointerX(ev)))));
    chartRoot.addEventListener("keydown", (ev) => {
      const t = this.graph.get<number>("inspectT"), step = ev.shiftKey ? 0.1 : 1;
      if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") { ev.preventDefault(); this.graph.set("cursor", Math.max(0, Math.min(this.graph.get<number>("now"), t + (ev.key === "ArrowRight" ? step : -step)))); }
      if (ev.key === "Escape") this.graph.set("cursor", null);
    });
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

  /** Trecho vigente no instante t: começa no último degrau de u (evento) até t. */
  segmentAt(t: number): Segment | undefined {
    const s = this.buffer;
    if (s.length === 0) return undefined;
    const p = this.graph.get<ParameterValues>("params");
    const changes = s.events.filter((e) => e.kind === "parameter" && e.name === "u" && e.tS <= t);
    const t0 = changes.length ? changes[changes.length - 1]!.tS + 0.01 : s.t[0]!; // vale na amostra seguinte (10 ms)
    const y0 = s.linearAt("y", Math.min(t0, s.now)).value;
    const u = s.stepValueAt("u", t, -1);
    const uNow = Number.isFinite(u) ? u : s.col("u")[0]!;
    return { t0, y0, yInf: p.K! * uNow, tau: p.tau!, K: p.K!, u: uNow };
  }

  private axesView(): void {
    const s = this.buffer, { t1 } = this.graph.get<{ t1: number }>("window"), p = this.graph.get<ParameterValues>("params");
    let lo = Math.min(0, p.y0!, p.K! * p.u!), hi = Math.max(0, p.y0!, p.K! * p.u!);
    if (s.length) { const y = s.col("y"); for (let i = 0; i < s.length; i++) { lo = Math.min(lo, y[i]!); hi = Math.max(hi, y[i]!); } }
    const pad = (hi - lo || 1) * 0.15;
    this.chart.setView({ x0: 0, x1: t1, y0: lo - pad, y1: hi + pad });
  }

  private drawChart(): void {
    this.axesView();
    const base = this.chart.layer("base"), s = this.buffer;
    this.chart.axes(base, { xLabel: "t (s)", yLabel: "y", xDecimals: 1, yDecimals: 2 });
    if (s.length === 0) return;
    const points: Array<[number, number]> = [];
    const y = s.col("y");
    const stride = Math.max(1, Math.floor(s.length / 1500));
    for (let i = 0; i < s.length; i += stride) points.push([s.t[i]!, y[i]!]);
    points.push([s.t[s.length - 1]!, y[s.length - 1]!]);
    this.chart.path(base, [points], { stroke: "#1d4ed8", "stroke-width": 2, "data-series": "y" });
    for (const e of s.events.filter((ev) => ev.kind === "parameter")) this.chart.vLine(base, e.tS, { stroke: "#2563eb", "stroke-dasharray": "2 3", "data-event": "parameter" });
  }

  private drawOver(): void {
    this.axesView();
    const over = this.chart.layer("over"), s = this.buffer, t = this.graph.get<number>("inspectT"), live = this.graph.get<number | null>("cursor") === null;
    const seg = this.segmentAt(t);
    const measure = byId("foMeasure");
    if (!seg) { measure.innerHTML = '<p class="note">Execute para ver a resposta.</p>'; return; }
    const target = seg.y0 + (1 - Math.exp(-1)) * (seg.yInf - seg.y0);
    this.chart.hLine(over, seg.yInf, { stroke: "#dc2626", "stroke-dasharray": "6 4", "data-line": "final" });
    this.chart.text(over, this.chart.view.x1, seg.yInf, `y∞ = K·u = ${nf(seg.yInf, 3)}`, { "text-anchor": "end", dy: -4, fill: "#b91c1c" });
    this.chart.hLine(over, target, { stroke: "#7c3aed", "stroke-dasharray": "3 3", "data-line": "63" });
    this.chart.text(over, this.chart.view.x0, target, "63,2 % do salto", { dx: 60, dy: -4, fill: "#6d28d9" });
    // tangente no início do degrau: inclinação (y∞ − y0)/τ, cruza y∞ em t0 + τ
    const slope0 = (seg.yInf - seg.y0) / seg.tau;
    this.chart.path(over, [[[seg.t0, seg.y0], [seg.t0 + seg.tau, seg.y0 + slope0 * seg.tau]]], { stroke: "#ea580c", "stroke-width": 1.5, "data-tangent": "start" });
    this.chart.vLine(over, seg.t0 + seg.tau, { stroke: "#ea580c", "stroke-dasharray": "2 2" });
    this.chart.text(over, seg.t0 + seg.tau, this.chart.view.y0, "t₀ + τ", { dx: 4, dy: -6, fill: "#9a3412" });
    // cursor
    this.chart.vLine(over, t, { stroke: live ? "#16a34a" : "#ea580c", "stroke-dasharray": live ? "2 3" : "6 3" });
    const yt = s.linearAt("y", t).value;
    if (Number.isFinite(yt)) this.chart.dot(over, t, yt, { fill: "#0f172a" });
    // instante em que y cruza 63,2 % (dos dados, interpolado)
    let t63 = NaN;
    const y = s.col("y");
    for (let i = Math.max(1, s.lowerBound(seg.t0)); i < s.length && s.t[i]! <= t + 1e-9; i++) {
      const a = y[i - 1]! - target, b = y[i]! - target;
      if (a === 0) { t63 = s.t[i - 1]!; break; }
      if (Math.sign(a) !== Math.sign(b)) { t63 = s.t[i - 1]! + (s.t[i]! - s.t[i - 1]!) * (a / (a - b)); break; }
    }
    const crossing = Number.isFinite(t63) ? `y cruza 63,2 % em t = ${nf(t63, 3)} s → t − t₀ = ${nf(t63 - seg.t0, 3)} s; τ = ${nf(seg.tau, 3)} s` : "y ainda não cruzou 63,2 % do salto";
    measure.innerHTML = `<p id="foT63">${crossing}</p>`;
  }

  private drawBlock(): void {
    const root = byId("foBlock") as unknown as SVGSVGElement, p = this.graph.get<ParameterValues>("params"), s = this.buffer;
    clear(root);
    const t = this.graph.get<number>("inspectT");
    const u = s.length ? s.stepValueAt("u", t, -1) : p.u!, y = s.length ? s.linearAt("y", t).value : p.y0!;
    svg("line", { x1: 20, y1: 85, x2: 105, y2: 85, stroke: "#60a5fa", "stroke-width": 3 }, root);
    svg("rect", { x: 105, y: 45, width: 110, height: 80, fill: "#0b1f3a", stroke: "#cbd5e1", "stroke-width": 2 }, root);
    svg("text", { x: 160, y: 80, "text-anchor": "middle", "font-size": 15, fill: "#e2e8f0" }, root).textContent = `${nf(p.K!, 2)}`;
    svg("line", { x1: 125, y1: 88, x2: 195, y2: 88, stroke: "#e2e8f0" }, root);
    svg("text", { x: 160, y: 108, "text-anchor": "middle", "font-size": 14, fill: "#e2e8f0" }, root).textContent = `${nf(p.tau!, 2)}s + 1`;
    svg("line", { x1: 215, y1: 85, x2: 300, y2: 85, stroke: "#60a5fa", "stroke-width": 3 }, root);
    svg("text", { x: 20, y: 72, "font-size": 13, fill: "#bfdbfe" }, root).textContent = `u = ${nf(Number.isFinite(u) ? u : p.u!, 3)}`;
    svg("text", { x: 300, y: 72, "text-anchor": "end", "font-size": 13, fill: "#bfdbfe" }, root).textContent = `y = ${nf(y, 4)}`;
    svg("text", { x: 160, y: 155, "text-anchor": "middle", "font-size": 11, fill: "#cbd5e1" }, root).textContent = `y₀ = ${nf(p.y0!, 3)} · t = ${nf(t, 2)} s`;
  }

  private drawEquations(): void {
    const box = byId("foEquations"), s = this.buffer, t = this.graph.get<number>("inspectT"), seg = this.segmentAt(t);
    if (!seg || s.length < 3) { box.innerHTML = '<p class="note">As equações mostram os valores no cursor assim que houver dados.</p>'; return; }
    const y = s.linearAt("y", t).value;
    const model = (seg.yInf - y) / seg.tau;
    const i = Math.min(s.length - 1, Math.max(1, s.upperBound(t) - 1));
    const measured = (s.col("y")[i]! - s.col("y")[i - 1]!) / (s.t[i]! - s.t[i - 1]!);
    const analytic = seg.yInf + (seg.y0 - seg.yInf) * Math.exp(-(t - seg.t0) / seg.tau);
    const m = (x: number, d = 4) => `<mn>${nf(x, d)}</mn>`;
    box.innerHTML = `<p><math><mi>y</mi><mo>(</mo><mi>t</mi><mo>)</mo><mo>=</mo><mi>K</mi><mi>u</mi><mo>+</mo><mo>(</mo><msub><mi>y</mi><mn>0</mn></msub><mo>−</mo><mi>K</mi><mi>u</mi><mo>)</mo><msup><mi>e</mi><mrow><mo>−</mo><mo>(</mo><mi>t</mi><mo>−</mo><msub><mi>t</mi><mn>0</mn></msub><mo>)</mo><mo>/</mo><mi>τ</mi></mrow></msup><mo>=</mo>${m(analytic)}</math>
        <span class="badge exact">analítico</span> · gravado ${nf(y, 6)} <span class="badge numeric">dado do simulador</span></p>
      <p><math><mfrac><mrow><mi>d</mi><mi>y</mi></mrow><mrow><mi>d</mi><mi>t</mi></mrow></mfrac><mo>=</mo><mfrac><mrow><mi>K</mi><mi>u</mi><mo>−</mo><mi>y</mi></mrow><mi>τ</mi></mfrac><mo>=</mo>${m(model)}</math>
        <span class="badge exact">modelo</span> · quociente das amostras ${nf(measured, 4)} <span class="badge numeric">dos dados, Δt = ${nf(s.t[i]! - s.t[i - 1]!, 3)} s</span></p>
      <p class="note">t = ${nf(t, 3)} s · degrau em t₀ = ${nf(seg.t0, 3)} s · a tangente em t₀ cruza y∞ em t₀ + τ = ${nf(seg.t0 + seg.tau, 3)} s</p>`;
  }
}
