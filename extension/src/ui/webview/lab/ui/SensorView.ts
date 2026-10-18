import type { SensorActivity } from "../activity.js";
import { LabGraph } from "../graph/LabGraph.js";
import type { LabPlantStatus, LabRunStatus, LabSeriesDelta, LabToHostMessage } from "../messages.js";
import type { ParameterValues } from "../plants.js";
import { byId, clear, svg } from "./dom.js";
import { iconButton } from "./icons.js";
import type { ViewStats } from "./LimitsView.js";
import { ChartHandle, XYChart } from "./chart.js";
import { ProcessShell } from "./processShell.js";
import { StepsPanel } from "./steps.js";

export interface SensorViewOptions { teacher: boolean; send: (message: LabToHostMessage) => void; onSave: (activity: SensorActivity) => void }

const nf = (x: number, d = 3): string => (Number.isFinite(x) ? x.toLocaleString("pt-BR", { maximumFractionDigits: d }) : "—");
const SAT_LOW = 3.8, SAT_HIGH = 20.5;
const raw = (p: number, v: ParameterValues): number => 4 + (16 * (p - v.pmin!)) / (v.pmax! - v.pmin!);
const loop = (p: number, v: ParameterValues): number => Math.min(SAT_HIGH, Math.max(SAT_LOW, raw(p, v)));

/**
 * Experimento A (docs/53 §1): transmissor 4–20 mA como função afim, calculado no Core. A reta I(P) vem
 * do modelo (exata); o ponto vem do simulador. Mostra a saturação 3,8–20,5 mA, o valor bruto fora da
 * faixa, a inversa P(I) e a tabela P → I.
 */
export class SensorView {
  readonly graph = new LabGraph();
  readonly shell: ProcessShell;
  readonly stats: ViewStats = { renders: {}, latencies: [], frames: 0 };
  private chart!: XYChart;
  private handle!: ChartHandle;
  private readonly dirty = new Set<string>();
  private readonly drawables: Array<{ id: string; inputs: string[]; draw: () => void }> = [];
  private frameRequested = false;
  private disposed = false;

  constructor(private readonly root: HTMLElement, private activity: SensorActivity, private readonly options: SensorViewOptions) {
    this.shell = new ProcessShell("sn", activity, this.graph, options.send);
    this.render();
    this.drawables.push(
      { id: "chart", inputs: ["params"], draw: () => this.drawChart() },
      { id: "point", inputs: ["rev", "params"], draw: () => this.drawPoint() },
      { id: "readout", inputs: ["rev", "params"], draw: () => this.drawReadout() },
      { id: "status", inputs: ["status", "rev", "plant"], draw: () => this.shell.drawStatus(byId("snStatus"), this.buffer.now) },
      { id: "plant", inputs: ["plant"], draw: () => this.shell.drawPlant(byId("snPlant")) },
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
  saved(): void { const s = document.getElementById("snSaveStatus"); if (s) s.textContent = "Atividade gravada no projeto (salve o .lsproj para persistir)."; }

  currentActivity(): SensorActivity {
    const input = document.getElementById("snQuestionInput") as HTMLInputElement | null;
    const question = (this.options.teacher ? input?.value.trim() : "") || this.activity.question;
    return { ...this.activity, question, parameters: { ...this.shell.accepted }, ...(this.shell.plantComponentId ? { plantComponentId: this.shell.plantComponentId } : {}) };
  }

  private render(): void {
    this.root.innerHTML = `
<section class="lim-question"><h1 id="snQuestion"></h1><p class="note">A corrente é calculada no simulador; a reta é o modelo afim, o ponto é a leitura do Core.</p></section>
<div id="snPlant" class="plant-status" role="status"></div>
<div id="snSteps"></div>
<main class="tank-layout">
  <section class="panel dark" aria-label="Transmissor">
    <h2>Transmissor <span id="snStatus" class="status" role="status"></span></h2>
    <div id="snReadout" class="sensor-readout" aria-live="polite"></div>
    ${this.shell.controlsHtml()}
    <div id="snTeacher" class="teacher" hidden>
      <label>Pergunta <input id="snQuestionInput" type="text" /></label>
      <p id="snSaveStatus" class="note" role="status"></p>
    </div>
  </section>
  <section class="panel" aria-label="I(P)">
    <div class="chart-head"><h2>Corrente × pressão</h2><span class="note">arraste o ponto (ou use as setas) para mudar P</span></div>
    <svg id="snChart" class="chart" aria-label="Reta I(P) com saturação; ponto medido no simulador"></svg>
    <table id="snTable" aria-label="Tabela P → I"></table>
  </section>
</main>
<section class="tank-bottom"><div id="snEquations" class="equations" aria-live="polite"></div></section>`;
    byId("snQuestion").textContent = this.activity.question;
    byId<HTMLInputElement>("snQuestionInput").value = this.activity.question;
    byId("snTeacher").hidden = !this.options.teacher;
    if (this.options.teacher) {
      const save = iconButton("save", "Gravar atividade no projeto", { id: "snSave" });
      save.addEventListener("click", () => this.options.onSave(this.currentActivity()));
      byId("snTeacher").appendChild(save);
    }
    new StepsPanel(byId("snSteps"), this.activity.steps);
    const chartRoot = byId("snChart") as unknown as SVGSVGElement;
    this.chart = new XYChart(chartRoot);
    this.chart.setView({ x0: 0, x1: 300, y0: 0, y1: 24 });
    this.chart.layer("under");
    const handles = svg("g", { "data-layer": "handles" }, chartRoot);
    this.handle = new ChartHandle(handles, {
      label: "Pressão P no gráfico", min: 0, max: 300, step: 5, color: "#ea580c",
      text: (p) => `P = ${nf(p, 1)} kPa, I = ${nf(loop(p, this.shell.accepted), 3)} mA`,
      onChange: (p) => this.shell.requestParameter("p", Math.round(p)),
    }, this.shell.accepted.p!);
    let dragging = false;
    this.handle.element.addEventListener("pointerdown", (ev) => { dragging = true; chartRoot.setPointerCapture(ev.pointerId); ev.preventDefault(); });
    chartRoot.addEventListener("pointermove", (ev) => { if (dragging) this.shell.requestParameter("p", Math.round(Math.min(300, Math.max(0, this.chart.pointerX(ev))))); });
    chartRoot.addEventListener("pointerup", () => { dragging = false; });
    this.shell.bind(() => undefined);
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

  /** Última leitura do Core (P, I, I bruto) ou undefined sem dados. */
  private reading(): { p: number; i: number; iRaw: number } | undefined {
    const s = this.buffer;
    if (s.length === 0) return undefined;
    return { p: s.last("p"), i: s.last("i"), iRaw: s.last("iRaw") };
  }

  private drawChart(): void {
    const v = this.graph.get<ParameterValues>("params"), c = this.chart;
    const under = c.layer("under"), base = c.layer("base");
    svg("rect", { x: c.x(0), y: c.y(24), width: c.x(300) - c.x(0), height: c.y(SAT_HIGH) - c.y(24), fill: "#fee2e2" }, under);
    svg("rect", { x: c.x(0), y: c.y(SAT_LOW), width: c.x(300) - c.x(0), height: c.y(0) - c.y(SAT_LOW), fill: "#fee2e2" }, under);
    c.axes(base, { xLabel: "P (kPa)", yLabel: "I (mA)", xDecimals: 0, yDecimals: 1 });
    const xs = Array.from({ length: 301 }, (_, k) => k);
    c.path(base, [xs.map((p) => [p, raw(p, v)] as [number, number]).filter(([, i]) => i >= 0 && i <= 24)], { stroke: "#94a3b8", "stroke-width": 1.5, "stroke-dasharray": "6 4", "data-series": "raw" });
    c.path(base, [xs.map((p) => [p, loop(p, v)] as [number, number])], { stroke: "#1d4ed8", "stroke-width": 2.5, "data-series": "loop" });
    for (const [p, label] of [[v.pmin!, "Pmin"], [v.pmax!, "Pmax"]] as const) {
      c.vLine(base, p, { stroke: "#64748b", "stroke-dasharray": "3 3" });
      c.text(base, p, 1, label, { "text-anchor": "middle", fill: "#475569", "font-size": 11 });
    }
    c.hLine(base, 12, { stroke: "#16a34a", "stroke-dasharray": "2 3" });
    const p12 = v.pmin! + ((12 - 4) * (v.pmax! - v.pmin!)) / 16;
    c.dot(base, p12, 12, { fill: "#16a34a", r: 4 });
    c.text(base, p12, 12, `12 mA ⇐ P = ${nf(p12, 1)} kPa`, { dx: 8, dy: -6, fill: "#166534", "font-size": 11 });
    this.drawTable(v);
  }

  private drawPoint(): void {
    const over = this.chart.layer("over"), v = this.graph.get<ParameterValues>("params"), r = this.reading();
    const p = r?.p ?? v.p!, i = r?.i ?? loop(v.p!, v);
    this.handle.update(p, this.chart.x(p), this.chart.y(i));
    if (r && r.iRaw !== r.i && r.iRaw >= 0 && r.iRaw <= 24) {
      this.chart.dot(over, r.p, r.iRaw, { fill: "none", stroke: "#dc2626", "stroke-width": 2, r: 6 });
      this.chart.path(over, [[[r.p, r.i], [r.p, r.iRaw]]], { stroke: "#dc2626", "stroke-dasharray": "2 2" });
    }
  }

  private drawReadout(): void {
    const r = this.reading(), v = this.graph.get<ParameterValues>("params"), box = byId("snReadout");
    if (!r) { box.innerHTML = `<p class="big">I = ${nf(loop(v.p!, v), 3)} mA</p><p class="note">modelo; execute para ler o simulador</p>`; }
    else {
      const saturated = r.iRaw > SAT_HIGH || r.iRaw < SAT_LOW;
      box.innerHTML = `<p class="big" id="snCurrent">I = ${nf(r.i, 3)} mA</p>
        <p>P = ${nf(r.p, 1)} kPa ${saturated ? `<span class="badge numeric" id="snSaturated">saturado</span> valor sem saturação ${nf(r.iRaw, 3)} mA` : '<span class="badge exact">dentro da faixa</span>'}</p>`;
    }
    const m = (x: number, d = 3) => `<mn>${nf(x, d)}</mn>`;
    byId("snEquations").innerHTML = `<p><math><mi>I</mi><mo>=</mo><mn>4</mn><mo>+</mo><mn>16</mn><mo>·</mo><mfrac><mrow><mi>P</mi><mo>−</mo>${m(v.pmin!, 1)}</mrow><mrow>${m(v.pmax!, 1)}<mo>−</mo>${m(v.pmin!, 1)}</mrow></mfrac></math>
      <span class="note">ganho ${nf(16 / (v.pmax! - v.pmin!), 4)} mA/kPa · offset ${nf(4 - (16 * v.pmin!) / (v.pmax! - v.pmin!), 3)} mA</span></p>
      <p><math><mi>P</mi><mo>(</mo><mi>I</mi><mo>)</mo><mo>=</mo>${m(v.pmin!, 1)}<mo>+</mo><mfrac><mrow><mo>(</mo><mi>I</mi><mo>−</mo><mn>4</mn><mo>)</mo><mo>(</mo>${m(v.pmax!, 1)}<mo>−</mo>${m(v.pmin!, 1)}<mo>)</mo></mrow><mn>16</mn></mfrac></math>
      <span class="note">inversa (vale só entre 3,8 e 20,5 mA)</span></p>`;
  }

  private drawTable(v: ParameterValues): void {
    const table = byId("snTable");
    const rows = [v.pmin!, (v.pmin! + v.pmax!) / 2, v.pmax!, v.pmax! * 1.2].map((p) => {
      const i = loop(p, v), r = raw(p, v);
      return `<tr><td>${nf(p, 1)}</td><td>${nf(i, 3)}</td><td>${i !== r ? `saturado (${nf(r, 3)})` : "—"}</td></tr>`;
    });
    table.innerHTML = `<thead><tr><th>P (kPa)</th><th>I (mA)</th><th>observação</th></tr></thead><tbody>${rows.join("")}</tbody>`;
  }
}
