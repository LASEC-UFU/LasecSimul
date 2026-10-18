import type { RiemannMethod, TankActivity } from "../activity.js";
import { LabGraph } from "../graph/LabGraph.js";
import type { LabPlantStatus, LabRunStatus, LabSeriesDelta, LabToHostMessage } from "../messages.js";
import type { ParameterValues } from "../plants.js";
import { riemannOnSteps, type BufferEvent } from "../series/SeriesBuffer.js";
import { byId, clear, svg } from "./dom.js";
import { iconButton } from "./icons.js";
import type { ViewStats } from "./LimitsView.js";
import { ProcessShell } from "./processShell.js";
import { StepsPanel } from "./steps.js";

export interface ProcessViewOptions {
  teacher: boolean;
  send: (message: LabToHostMessage) => void;
  onSave: (activity: TankActivity) => void;
}

const nf = (x: number, d = 3): string => (Number.isFinite(x) ? x.toLocaleString("pt-BR", { maximumFractionDigits: d }) : "—");
const GEO = { W: 640, H: 230, Lm: 54, R: 12, T: 16, B: 28 };
/** Gráfico 1: nível, volume ou a acumulada V0 + ∫q (Teorema Fundamental). */
type FirstChart = "h" | "V" | "ftc";

interface Sample {
  t: number;
  V: ReturnType<ProcessShell["buffer"]["linearAt"]>;
  h: ReturnType<ProcessShell["buffer"]["linearAt"]>;
  A: number; q: number; qIn: number; qOut: number; overflow: number; unmet: number;
  cumIn: number; cumOut: number; cumOverflow: number; cumSpill: number;
}
interface RiemannResult { a: number; b: number; n: number; method: RiemannMethod; sum: number; bars: Array<{ x0: number; x1: number; height: number }>; exact: number; dV: number; spills: number }

/**
 * Atividade "Tanque — da vazão à integral" (docs/53 §2). A física roda no Core (subcircuito
 * `hydraulic_tank`, acumulador conservativo); esta vista só lê as séries gravadas que o Host repassa:
 * gráficos, cursor, Riemann e equações nunca consultam estado interno.
 */
export class TankView {
  readonly graph = new LabGraph();
  readonly shell: ProcessShell;
  readonly stats: ViewStats = { renders: {}, latencies: [], frames: 0 };
  private readonly dirty = new Set<string>();
  private readonly drawables: Array<{ id: string; inputs: string[]; draw: () => void }> = [];
  private frameRequested = false;
  private pendingInputAt: number | undefined;
  private disposed = false;

  constructor(private readonly root: HTMLElement, private activity: TankActivity, private readonly options: ProcessViewOptions) {
    this.shell = new ProcessShell("tk", activity, this.graph, options.send, () => this.markInput());
    this.renderLayout();
    this.buildGraph();
    this.buildDrawables();
    this.bindControls();
    this.requestFrame();
    options.send({ version: 1, type: "labActivate", activity });
  }

  get buffer() { return this.shell.buffer; }

  dispose(): void { this.disposed = true; this.shell.dispose(); clear(this.root); }

  // ------------------------------------------------------------------ mensagens do Host
  plant(status: LabPlantStatus): void { this.shell.plant(status); }
  runState(status: LabRunStatus): void { this.shell.runState(status); }
  series(delta: LabSeriesDelta): void { this.shell.series(delta); }
  parameterAccepted(id: string, value: number): void { this.shell.parameterAccepted(id, value); }
  parameterRejected(id: string, reason: string): void { this.shell.parameterRejected(id, reason); }

  currentActivity(): TankActivity {
    const questionInput = document.getElementById("tkQuestionInput") as HTMLInputElement | null;
    const question = (this.options.teacher ? questionInput?.value.trim() : "") || this.activity.question;
    const a = this.graph.get<number>("a"), b = this.graph.get<number>("b");
    return {
      ...this.activity, question, parameters: { ...this.shell.accepted },
      riemann: { a: Math.min(a, b), b: Math.max(a, b, Math.min(a, b) + 0.01), n: this.graph.get<number>("n"), method: this.graph.get<RiemannMethod>("method") },
      ...(this.shell.plantComponentId ? { plantComponentId: this.shell.plantComponentId } : {}),
    };
  }

  saved(): void { const status = document.getElementById("tkSaveStatus"); if (status) status.textContent = "Atividade gravada no projeto (salve o .lsproj para persistir)."; }

  // ------------------------------------------------------------------ layout
  private renderLayout(): void {
    this.root.innerHTML = `
<section class="lim-question"><h1 id="tkQuestion"></h1>
  <p class="note">O processo roda no simulador; gráficos, cursor e Riemann leem só as séries gravadas pelo Core.</p></section>
<div id="tkPlant" class="plant-status" role="status"></div>
<div id="tkSteps"></div>
<main class="tank-layout">
  <section class="panel dark" aria-label="Processo">
    <h2>Processo <span id="tkStatus" class="status" role="status"></span></h2>
    <svg id="tkTank" viewBox="0 0 320 300" role="img" aria-labelledby="tkTankCaption"></svg>
    <p id="tkTankCaption" class="note"></p>
    ${this.shell.controlsHtml()}
    <div id="tkTeacher" class="teacher" hidden>
      <label>Pergunta <input id="tkQuestionInput" type="text" /></label>
      <p class="note">Os valores atuais dos controles e o intervalo de Riemann viram os valores iniciais da atividade.</p>
      <p id="tkSaveStatus" class="note" role="status"></p>
    </div>
  </section>
  <section class="panel" aria-label="Gráficos">
    <div class="chart-head"><h2 id="tkChartTitle">Nível × tempo</h2>
      <label>gráfico <select id="tkFirstChart"><option value="h">h(t)</option><option value="V">V(t)</option><option value="ftc">V₀ + ∫q (TFC)</option></select></label>
      <span id="tkModeBadge" class="badge"></span></div>
    <svg id="tkChartH" class="chart" viewBox="0 0 640 230" tabindex="0" aria-label="Gráfico 1; setas movem o cursor, Esc volta ao vivo"></svg>
    <div class="chart-head"><h2>Vazão líquida × tempo + Riemann</h2>
      <label>método <select id="tkMethod"><option value="left">esquerda</option><option value="right">direita</option><option value="midpoint">ponto médio</option><option value="trapezoid">trapézio</option></select></label>
      <label>n <input id="tkN" type="range" min="1" max="200" step="1" /><output id="tkNOut"></output></label>
    </div>
    <svg id="tkChartQ" class="chart" viewBox="0 0 640 230" aria-label="Vazão líquida com retângulos de Riemann entre a e b (arraste a e b)"></svg>
  </section>
</main>
<section class="tank-bottom">
  <div id="tkEquations" class="equations" aria-live="polite"></div>
  <div id="tkRiemann" class="riemann" aria-live="polite"></div>
  <div class="question"><strong>Eventos</strong>
    <ul id="tkEvents" class="events" aria-label="Eventos"></ul>
  </div>
</section>`;
    byId("tkQuestion").textContent = this.activity.question;
    byId<HTMLInputElement>("tkQuestionInput").value = this.activity.question;
    byId("tkTeacher").hidden = !this.options.teacher;
    if (this.options.teacher) {
      const save = iconButton("save", "Gravar atividade no projeto", { id: "tkSave" });
      save.addEventListener("click", () => this.options.onSave(this.currentActivity()));
      byId("tkTeacher").appendChild(save);
    }
    new StepsPanel(byId("tkSteps"), this.activity.steps);
  }

  // ------------------------------------------------------------------ grafo
  private buildGraph(): void {
    const g = this.graph, r = this.activity.riemann;
    g.source("cursor", null as number | null, { kind: "inspection" });
    g.source("a", r.a, { kind: "inspection" });
    g.source("b", r.b, { kind: "inspection" });
    g.source("n", r.n, { kind: "inspection" });
    g.source("method", r.method, { kind: "inspection" });
    g.source("firstChart", "h" as FirstChart, { kind: "view" });
    g.derived("now", ["rev"], () => this.buffer.now);
    g.derived("window", ["now"], (now: number) => ({ t0: 0, t1: Math.max(60, Math.ceil((now + 1) / 30) * 30) }), { equals: (x, y) => JSON.stringify(x) === JSON.stringify(y) });
    g.derived("inspectT", ["cursor", "now"], (cursor: number | null, now: number) => (cursor === null ? now : Math.min(cursor, now)));
    g.derived("atT", ["rev", "inspectT"], (_rev: number, t: number) => this.sampleAt(t), { equals: () => false });
    g.derived("riemann", ["rev", "a", "b", "n", "method", "now"], (_rev: number, a: number, b: number, n: number, method: RiemannMethod, now: number) =>
      this.riemann(a, b, n, method, now), { equals: () => false });
  }

  private sampleAt(t: number): Sample | undefined {
    const s = this.buffer;
    if (s.length === 0) return undefined;
    const linear = (c: string) => s.linearAt(c, t, true);
    const step = (c: string) => s.stepValueAt(c, t, -1);
    return {
      t, V: linear("V"), h: linear("h"), A: linear("A").value, q: step("q"), qIn: step("inActual"), qOut: step("outActual"),
      overflow: step("overflow"), unmet: step("unmet"), cumIn: linear("cumIn").value, cumOut: linear("cumOut").value,
      cumOverflow: linear("cumOverflow").value, cumSpill: linear("cumSpill").value,
    };
  }

  private riemann(a: number, b: number, n: number, method: RiemannMethod, now: number): RiemannResult | undefined {
    const B = Math.min(Math.max(a, b), now), A0 = Math.min(Math.min(a, b), B);
    if (!(B > A0) || this.buffer.length < 2) return undefined;
    const r = riemannOnSteps(this.buffer, "q", A0, B, n, method);
    const exact = this.buffer.stepIntegral("q", A0, B);
    const dV = this.buffer.linearAt("V", B, true).value - this.buffer.linearAt("V", A0, false).value;
    return { a: A0, b: B, n, method, sum: r.sum, bars: r.bars, exact, dV, spills: this.buffer.spillsBetween(A0, B) };
  }

  // ------------------------------------------------------------------ desenho com invalidação seletiva
  private buildDrawables(): void {
    this.drawables.push(
      { id: "baseH", inputs: ["window", "rev", "params", "firstChart"], draw: () => this.drawBase("h") },
      { id: "baseQ", inputs: ["window", "rev"], draw: () => this.drawBase("q") },
      { id: "riemannBars", inputs: ["window", "riemann"], draw: () => this.drawRiemannBars() },
      { id: "overH", inputs: ["window", "inspectT", "cursor", "a", "b", "params", "firstChart", "rev"], draw: () => this.drawOver("h") },
      { id: "overQ", inputs: ["window", "inspectT", "cursor", "a", "b"], draw: () => this.drawOver("q") },
      { id: "tank", inputs: ["atT", "cursor", "params"], draw: () => this.drawTank() },
      { id: "equations", inputs: ["atT"], draw: () => this.drawEquations() },
      { id: "riemannText", inputs: ["riemann"], draw: () => this.drawRiemann() },
      { id: "events", inputs: ["rev"], draw: () => this.drawEvents() },
      { id: "status", inputs: ["status", "now", "cursor", "plant"], draw: () => this.drawStatus() },
      { id: "plant", inputs: ["plant"], draw: () => this.shell.drawPlant(byId("tkPlant")) },
      { id: "inspect", inputs: ["method", "n", "firstChart"], draw: () => {
        byId<HTMLSelectElement>("tkMethod").value = this.graph.get("method");
        byId<HTMLInputElement>("tkN").value = String(this.graph.get("n"));
        byId("tkNOut").textContent = String(this.graph.get("n"));
        const chart = this.graph.get<FirstChart>("firstChart");
        byId<HTMLSelectElement>("tkFirstChart").value = chart;
        byId("tkChartTitle").textContent = chart === "h" ? "Nível × tempo" : chart === "V" ? "Volume × tempo" : "Acumulada V₀ + ∫q × tempo (TFC)";
      } },
    );
    for (const d of this.drawables) this.dirty.add(d.id);
    this.graph.onChange((changed) => {
      for (const d of this.drawables) if (d.inputs.some((input) => changed.has(input))) this.dirty.add(d.id);
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
      for (const d of this.drawables) if (this.dirty.has(d.id)) { d.draw(); this.stats.renders[d.id] = (this.stats.renders[d.id] ?? 0) + 1; }
      this.dirty.clear();
      if (this.pendingInputAt !== undefined) { this.stats.latencies.push(performance.now() - this.pendingInputAt); this.pendingInputAt = undefined; }
    });
  }
  private markInput(): void { if (this.pendingInputAt === undefined) this.pendingInputAt = performance.now(); }

  /** Coluna e faixa do gráfico 1. A acumulada do TFC é V₀ + (cumIn − cumOut − cumOverflow): ∫q, sem os derramamentos. */
  private firstColumn(): { column: string; label: string; range: [number, number] } {
    const params = this.graph.get<ParameterValues>("params"), chart = this.graph.get<FirstChart>("firstChart");
    if (chart === "h") return { column: "h", label: "h (m)", range: [0, params.hMax! * 1.1] };
    const vmax = 1000 * 0.2 * params.hMax!;
    return { column: chart === "V" ? "V" : "integral", label: chart === "V" ? "V (L)" : "V₀ + ∫q (L)", range: [0, Math.max(vmax, 10)] };
  }

  private axes(kind: "h" | "q") {
    const { t0, t1 } = this.graph.get<{ t0: number; t1: number }>("window");
    const [y0, y1] = kind === "h" ? this.firstColumn().range : [-2.2, 2.2];
    const x = (t: number) => GEO.Lm + ((t - t0) / (t1 - t0)) * (GEO.W - GEO.Lm - GEO.R);
    const y = (v: number) => GEO.H - GEO.B - ((v - y0) / (y1 - y0)) * (GEO.H - GEO.T - GEO.B);
    const tAt = (px: number) => t0 + ((px - GEO.Lm) / (GEO.W - GEO.Lm - GEO.R)) * (t1 - t0);
    return { t0, t1, y0, y1, x, y, tAt };
  }

  private layer(kind: "h" | "q", name: "under" | "base" | "over"): SVGGElement {
    const root = byId(kind === "h" ? "tkChartH" : "tkChartQ") as unknown as SVGSVGElement;
    let group = root.querySelector<SVGGElement>(`g[data-layer="${name}"]`);
    if (!group) {
      for (const n of ["under", "base", "over"]) svg("g", { "data-layer": n }, root);
      group = root.querySelector<SVGGElement>(`g[data-layer="${name}"]`)!;
    }
    clear(group);
    return group;
  }

  /** Valor da coluna do gráfico 1 na linha i (a acumulada do TFC é derivada aqui). */
  private firstValue(column: string, i: number): number {
    const s = this.buffer;
    if (column !== "integral") return s.col(column)[i]!;
    return s.col("V")[0]! + s.col("cumIn")[i]! - s.col("cumOut")[i]! - s.col("cumOverflow")[i]!;
  }

  /** Trechos contínuos: quebra onde A mudou (h salta na amostra seguinte) e onde houve derramamento. */
  private segments(column: string): Array<[number, number]> {
    const s = this.buffer, n = s.length;
    if (n === 0) return [];
    const A = s.col("A"), spill = s.col("cumSpill"), cuts: number[] = [];
    for (let i = 1; i < n; i++) {
      if (A[i] !== A[i - 1] && column === "h" && i + 1 < n) cuts.push(i + 1);
      if (spill[i] !== spill[i - 1] && column !== "integral") cuts.push(i);
    }
    const bounds = [0, ...[...new Set(cuts)].sort((x, y) => x - y), n];
    const result: Array<[number, number]> = [];
    for (let k = 0; k + 1 < bounds.length; k++) if (bounds[k + 1]! > bounds[k]!) result.push([bounds[k]!, bounds[k + 1]!]);
    return result;
  }

  /** Envelope mín/máx por coluna de pixel (só desenho). `holdTo`: mantém o último valor até esse t. */
  private pathFor(column: string, i0: number, i1: number, ax: ReturnType<TankView["axes"]>, holdTo?: number): string {
    const t = this.buffer.t, columns = 600, points: Array<[number, number]> = [];
    let bucket = -1, lo = 0, hi = 0, tl = 0, th = 0, last = NaN;
    const flush = () => { if (bucket >= 0) (tl <= th ? points.push([tl, lo], [th, hi]) : points.push([th, hi], [tl, lo])); };
    for (let i = i0; i < i1; i++) {
      const v = column === "q" ? this.buffer.col("q")[i]! : this.firstValue(column, i);
      if (Number.isNaN(v)) continue;
      last = v;
      const b = Math.floor(((t[i]! - ax.t0) / (ax.t1 - ax.t0)) * columns);
      if (b !== bucket) { flush(); bucket = b; lo = hi = v; tl = th = t[i]!; } else { if (v < lo) { lo = v; tl = t[i]!; } if (v > hi) { hi = v; th = t[i]!; } }
    }
    flush();
    if (holdTo !== undefined && Number.isFinite(last)) points.push([holdTo, last]);
    return points.map(([x, v], k) => `${k ? "L" : "M"}${ax.x(x).toFixed(1)} ${ax.y(v).toFixed(1)}`).join("");
  }

  private drawBase(kind: "h" | "q"): void {
    const group = this.layer(kind, "base"), ax = this.axes(kind), params = this.graph.get<ParameterValues>("params");
    const first = this.firstColumn();
    svg("line", { x1: GEO.Lm, y1: ax.y(0), x2: GEO.W - GEO.R, y2: ax.y(0), stroke: "#94a3b8" }, group);
    svg("line", { x1: GEO.Lm, y1: GEO.T, x2: GEO.Lm, y2: GEO.H - GEO.B, stroke: "#94a3b8" }, group);
    const tStep = (ax.t1 - ax.t0) / 6;
    for (let t = 0; t <= ax.t1 + 1e-9; t += tStep) svg("text", { x: ax.x(t), y: GEO.H - 10, "text-anchor": "middle", "font-size": 11, fill: "#475569" }, group).textContent = nf(t, 0);
    const ticks = kind === "h" ? [first.range[0], (first.range[0] + first.range[1]) / 2, first.range[1] / 1.1] : [-2, -1, 0, 1, 2];
    for (const v of ticks) svg("text", { x: GEO.Lm - 6, y: ax.y(v) + 4, "text-anchor": "end", "font-size": 11, fill: "#475569" }, group).textContent = nf(v, 2);
    svg("text", { x: 6, y: 12, "font-size": 12, fill: "#0f172a" }, group).textContent = kind === "h" ? first.label : "q (L/s)";
    // Título do eixo do tempo no canto superior direito: no rodapé colidia com o último rótulo.
    svg("text", { x: GEO.W - GEO.R, y: 12, "text-anchor": "end", "font-size": 12, fill: "#0f172a" }, group).textContent = "t (s)";
    if (kind === "h" && first.column === "h") svg("line", { x1: GEO.Lm, y1: ax.y(params.hMax!), x2: GEO.W - GEO.R, y2: ax.y(params.hMax!), stroke: "#dc2626", "stroke-dasharray": "4 3" }, group);
    if (this.buffer.length === 0) return;
    const column = kind === "h" ? first.column : "q";
    const segments = this.segments(column);
    segments.forEach(([i0, i1], index) => {
      const next = segments[index + 1];
      const holdTo = kind === "h" && column === "h" && next ? this.buffer.t[next[0]] : undefined;
      svg("path", { d: this.pathFor(column, i0, i1, ax, holdTo), fill: "none", stroke: kind === "h" ? "#1d4ed8" : "#0e7490", "stroke-width": 2, "data-series": column }, group);
    });
    if (kind === "h" && column === "integral") { // no TFC, V(t) medido tracejado ao lado da acumulada: diferem pelos derramamentos
      svg("path", { d: this.pathFor("V", 0, this.buffer.length, ax), fill: "none", stroke: "#64748b", "stroke-width": 1.5, "stroke-dasharray": "5 4", "data-series": "V" }, group);
    }
    if (kind === "q") for (const e of this.buffer.events) {
      if (e.kind === "start") continue;
      const color = e.kind === "parameter" ? "#2563eb" : e.kind === "spill" ? "#dc2626" : "#d97706";
      const px = ax.x(e.tS);
      const marker = svg("path", { d: `M${px - 5} ${GEO.T - 10} L${px + 5} ${GEO.T - 10} L${px} ${GEO.T - 2}z`, fill: color, "data-event": e.kind }, group);
      svg("title", {}, marker).textContent = this.describeEvent(e);
    }
  }

  private drawRiemannBars(): void {
    const group = this.layer("q", "under"), ax = this.axes("q"), r = this.graph.get<RiemannResult | undefined>("riemann");
    if (!r) return;
    for (const bar of r.bars) {
      if (!Number.isFinite(bar.height)) continue;
      const top = Math.max(0, bar.height), bottom = Math.min(0, bar.height);
      svg("rect", { x: ax.x(bar.x0), y: ax.y(top), width: Math.max(0.5, ax.x(bar.x1) - ax.x(bar.x0)), height: Math.max(0, ax.y(bottom) - ax.y(top)),
        fill: "#93c5fd", "fill-opacity": 0.45, stroke: "#2563eb", "stroke-width": 0.6, "data-riemann": "bar" }, group);
    }
  }

  private drawOver(kind: "h" | "q"): void {
    const group = this.layer(kind, "over"), ax = this.axes(kind);
    for (const name of ["a", "b"] as const) {
      const px = ax.x(Math.min(this.graph.get<number>(name), ax.t1));
      svg("line", { x1: px, y1: GEO.T, x2: px, y2: GEO.H - GEO.B, stroke: "#7c3aed", "stroke-width": 1.5 }, group);
      svg("text", { x: px + 4, y: GEO.T + 12, "font-size": 13, "font-weight": 700, fill: "#7c3aed" }, group).textContent = name;
      if (kind === "q") svg("circle", { cx: px, cy: GEO.T + 2, r: 7, fill: "#7c3aed", "data-handle": name }, group);
    }
    const live = this.graph.get<number | null>("cursor") === null, t = this.graph.get<number>("inspectT"), cx = ax.x(t);
    svg("line", { x1: cx, y1: GEO.T, x2: cx, y2: GEO.H - GEO.B, stroke: live ? "#16a34a" : "#ea580c", "stroke-width": live ? 1 : 2, "stroke-dasharray": live ? "2 3" : "6 3" }, group);
    svg("text", { x: cx + 4, y: GEO.H - GEO.B - 6, "font-size": 12, fill: live ? "#16a34a" : "#ea580c" }, group).textContent = live ? "agora" : "t";
    // TFC: tangente à acumulada no cursor com inclinação q(t) -- a mesma reta que a derivada desenharia.
    if (kind === "h" && this.firstColumn().column === "integral" && this.buffer.length > 1) {
      const s = this.sampleAt(t);
      if (s && Number.isFinite(s.q)) {
        const y = this.buffer.col("V")[0]! + s.cumIn - s.cumOut - s.cumOverflow, span = (ax.t1 - ax.t0) / 8;
        svg("line", { x1: ax.x(t - span), y1: ax.y(y - s.q * span), x2: ax.x(t + span), y2: ax.y(y + s.q * span), stroke: "#ea580c", "stroke-width": 2, "data-tangent": "ftc" }, group);
        svg("text", { x: ax.x(t) + 6, y: ax.y(y) - 8, "font-size": 12, fill: "#9a3412" }, group).textContent = `inclinação = q(t) = ${nf(s.q, 3)} L/s`;
      }
    }
  }

  private describeEvent(e: BufferEvent): string {
    const t = nf(e.tS, 3);
    const names: Record<string, string> = { qIn: "vazão de entrada", qOut: "vazão de saída", area: "área A", k: "válvula k", torr: "orifício c", outlet: "saída", hMax: "h máx.", v0: "V₀" };
    if (e.kind === "parameter") return `t = ${t} s: ${names[e.name ?? ""] ?? e.name} → ${nf(e.value ?? NaN, 3)} (vale na amostra seguinte, 10 ms)`;
    if (e.kind === "spill") return `t = ${t} s: derramamento instantâneo de ${nf(e.volume ?? NaN, 3)} L (A·h_máx < V)`;
    if (e.kind === "boundary:upper") return `t = ${t} s: atingiu a borda (transborda) — instante exato do Core`;
    if (e.kind === "boundary:lower") return `t = ${t} s: esvaziou (saída sem água) — instante exato do Core`;
    return `t = ${t} s: início`;
  }

  // ------------------------------------------------------------------ processo (reconstruído das séries)
  private drawTank(): void {
    const s = this.graph.get<Sample | undefined>("atT"), root = byId("tkTank") as unknown as SVGSVGElement;
    const params = this.graph.get<ParameterValues>("params");
    const live = this.graph.get<number | null>("cursor") === null;
    clear(root);
    const A = s?.A ?? params.area!, hMax = params.hMax!;
    const w = 60 + ((A - 0.03) / 0.17) * 150, x0 = 160 - w / 2, top = 40, H = 210;
    const level = s ? Math.max(0, Math.min(1, s.h.value / hMax)) : Math.min(1, (params.v0! / (1000 * A)) / hMax);
    svg("rect", { x: x0, y: top, width: w, height: H, fill: "#0b1f3a", stroke: "#cbd5e1", "stroke-width": 3 }, root);
    svg("rect", { x: x0 + 2, y: top + H * (1 - level), width: w - 4, height: H * level, fill: "#38bdf8", "fill-opacity": 0.85, "data-level": level.toFixed(4) }, root);
    for (let k = 0; k <= 4; k++) {
      const y = top + H - (k / 4) * H;
      svg("line", { x1: x0 + w, y1: y, x2: x0 + w + 8, y2: y, stroke: "#cbd5e1" }, root);
      svg("text", { x: x0 + w + 11, y: y + 4, "font-size": 10, fill: "#e2e8f0" }, root).textContent = nf((k / 4) * hMax, 2);
    }
    svg("text", { x: x0 + w + 8, y: top - 6, "font-size": 10, fill: "#e2e8f0" }, root).textContent = "h (m)";
    svg("path", { d: `M10 22 H${x0 + 22} V${top + 14}`, stroke: "#60a5fa", "stroke-width": 6, fill: "none" }, root);
    svg("text", { x: 10, y: 14, "font-size": 12, fill: "#bfdbfe" }, root).textContent = `entrada ${nf(s?.qIn ?? params.qIn!)} L/s`;
    svg("path", { d: `M${x0 + w - 10} ${top + H} V${top + H + 22} H312`, stroke: "#60a5fa", "stroke-width": 6, fill: "none" }, root);
    const outText = s && s.unmet > 0 ? `saída ${nf(s.qOut)} L/s (falta ${nf(s.unmet)})` : `saída ${nf(s?.qOut ?? NaN)} L/s`;
    svg("text", { x: 312, y: top + H + 42, "text-anchor": "end", "font-size": 12, fill: "#bfdbfe" }, root).textContent = outText;
    if (s && s.overflow > 0) {
      svg("path", { d: `M${x0 + w} ${top + 2} q 18 0 22 30 v 160`, stroke: "#f87171", "stroke-width": 4, fill: "none", "stroke-dasharray": "6 4" }, root);
      svg("text", { x: x0 + w + 6, y: top + 60, "font-size": 11, fill: "#fecaca" }, root).textContent = `transborda ${nf(s.overflow)} L/s`;
    }
    svg("text", { x: 160, y: top + H - 8, "text-anchor": "middle", "font-size": 13, fill: "#0f172a", "font-weight": 700 }, root).textContent = `V = ${nf(s?.V.value ?? params.v0!, 2)} L`;
    svg("text", { x: 160, y: 296, "text-anchor": "middle", "font-size": 11, fill: "#cbd5e1" }, root).textContent = `A = ${nf(A, 3)} m²`;
    byId("tkTankCaption").textContent = !s ? "Sem dados: execute a simulação." : live ? "Ao vivo: último dado gravado pelo Core."
      : `Inspeção em t = ${nf(s.t, 2)} s — reconstrução a partir das séries gravadas; o simulador continua no presente.`;
  }

  private drawEquations(): void {
    const s = this.graph.get<Sample | undefined>("atT"), box = byId("tkEquations");
    if (!s) { box.innerHTML = '<p class="note">As equações mostram os valores no cursor assim que houver dados.</p>'; return; }
    const v = (x: number, d = 3) => `<mn>${nf(x, d)}</mn>`;
    const V0 = this.buffer.length > 0 ? this.buffer.col("V")[0]! : NaN;
    const integral = s.cumIn - s.cumOut - s.cumOverflow;
    const qMl = `<math><mi>q</mi><mo>=</mo><msub><mi>q</mi><mtext>ent</mtext></msub><mo>−</mo><msub><mi>q</mi><mtext>saí</mtext></msub><mo>−</mo><msub><mi>q</mi><mtext>transb</mtext></msub><mo>=</mo>${v(s.qIn)}<mo>−</mo>${v(s.qOut)}<mo>−</mo>${v(s.overflow)}<mo>=</mo>${v(s.q)}<mtext> L/s</mtext></math>`;
    const vMl = `<math><mi>V</mi><mo>(</mo><mi>t</mi><mo>)</mo><mo>=</mo><msub><mi>V</mi><mn>0</mn></msub><mo>+</mo><msubsup><mo>∫</mo><mn>0</mn><mi>t</mi></msubsup><mi>q</mi><mspace width="0.17em"></mspace><mi>d</mi><mi>τ</mi><mo>−</mo><mo>∑</mo><mtext>derram.</mtext><mo>=</mo>${v(V0, 2)}<mo>+</mo>${v(integral)}<mo>−</mo>${v(s.cumSpill)}<mo>=</mo>${v(s.V.value)}<mtext> L</mtext></math>`;
    const hMl = `<math><mi>h</mi><mo>=</mo><mfrac><mi>V</mi><mi>A</mi></mfrac><mo>=</mo><mfrac><mrow>${v(s.V.value)}<mtext> L</mtext></mrow><mrow><mn>${nf(s.A, 3)}</mn><mtext> m²</mtext></mrow></mfrac><mo>=</mo><mn>${nf(s.h.value, 4)}</mn><mtext> m</mtext></math>`;
    const dhMl = `<math><mfrac><mrow><mi>d</mi><mi>h</mi></mrow><mrow><mi>d</mi><mi>t</mi></mrow></mfrac><mo>=</mo><mfrac><mi>q</mi><mi>A</mi></mfrac><mo>=</mo><mn>${nf(s.q / s.A / 10, 4)}</mn><mtext> cm/s</mtext></math>`;
    const how = s.V.kind === "interpolated" ? `interpolado entre ${nf(s.V.between![0], 2)} s e ${nf(s.V.between![1], 2)} s` : s.V.kind === "sample" ? "amostra gravada" : "sem dado";
    const residual = s.V.value - V0 - (integral - s.cumSpill);
    box.innerHTML = `<p>${qMl}</p><p>${vMl}</p><p>${hMl}</p><p>${dhMl} <span class="note">(vale fora das bordas e de mudanças de A)</span></p>`
      + `<p class="note">t = ${nf(s.t, 3)} s · ${how} · resíduo do balanço ${Number.isFinite(residual) ? residual.toExponential(1) : "—"} L</p>`;
  }

  private drawRiemann(): void {
    const r = this.graph.get<RiemannResult | undefined>("riemann"), box = byId("tkRiemann");
    if (!r) { box.innerHTML = '<p class="note">Rode a simulação até b para comparar Riemann com ΔV.</p>'; return; }
    const names: Record<RiemannMethod, string> = { left: "esquerda", right: "direita", midpoint: "ponto médio", trapezoid: "trapézio" };
    const small = (x: number) => (Math.abs(x) < 5e-5 ? x.toExponential(1) : nf(x, 4));
    box.innerHTML = `<h3>Entre a = ${nf(r.a, 2)} s e b = ${nf(r.b, 2)} s</h3>
      <p>Σ Riemann (${names[r.method]}, n = ${r.n}) = <strong id="tkRiemannSum">${nf(r.sum, 4)} L</strong> <span class="badge numeric">aproximação</span></p>
      <p>∫ q dt da série gravada = <strong id="tkRiemannExact">${nf(r.exact, 4)} L</strong> <span class="badge exact">exata sobre os dados</span></p>
      <p>V(b) − V(a) medido = <strong id="tkRiemannDV">${nf(r.dV, 4)} L</strong>${r.spills > 0 ? ` = ∫ q − derramamentos (${nf(r.spills, 3)} L)` : ""}</p>
      <p class="note">erro de Riemann: ${small(r.sum - r.exact)} L · fechamento do balanço: ${(r.exact - r.spills - r.dV).toExponential(1)} L</p>`;
  }

  private drawEvents(): void {
    const list = byId("tkEvents");
    clear(list);
    for (const e of this.buffer.events.filter((event) => event.kind !== "start").slice(-6)) {
      const item = document.createElement("li");
      item.textContent = this.describeEvent(e);
      list.appendChild(item);
    }
  }

  private drawStatus(): void {
    const live = this.graph.get<number | null>("cursor") === null;
    this.shell.drawStatus(byId("tkStatus"), this.graph.get<number>("now"));
    const badge = byId("tkModeBadge");
    badge.textContent = live ? "ao vivo" : "inspeção (passado)";
    badge.className = `badge ${live ? "exact" : "numeric"}`;
  }

  // ------------------------------------------------------------------ controles
  private bindControls(): void {
    this.shell.bind(() => this.graph.set("cursor", null));
    byId<HTMLSelectElement>("tkMethod").addEventListener("change", (ev) => { this.markInput(); this.graph.set("method", (ev.target as HTMLSelectElement).value); });
    byId<HTMLInputElement>("tkN").addEventListener("input", (ev) => { this.markInput(); this.graph.set("n", Number((ev.target as HTMLInputElement).value)); });
    byId<HTMLSelectElement>("tkFirstChart").addEventListener("change", (ev) => this.graph.set("firstChart", (ev.target as HTMLSelectElement).value));

    let drag: "cursor" | "a" | "b" | null = null;
    for (const id of ["tkChartH", "tkChartQ"]) {
      const chart = byId(id) as unknown as SVGSVGElement;
      const tFrom = (ev: PointerEvent): number => {
        const rect = chart.getBoundingClientRect();
        const t = this.axes("q").tAt(((ev.clientX - rect.left) / rect.width) * GEO.W);
        return Math.max(0, Math.min(this.graph.get<number>("now"), t));
      };
      chart.addEventListener("pointerdown", (ev) => {
        const handle = (ev.target as Element).getAttribute?.("data-handle");
        drag = handle === "a" || handle === "b" ? handle : "cursor";
        chart.setPointerCapture(ev.pointerId);
        this.markInput();
        this.graph.set(drag, tFrom(ev));
      });
      chart.addEventListener("pointermove", (ev) => { if (!drag) return; this.markInput(); this.graph.set(drag, tFrom(ev)); });
      chart.addEventListener("pointerup", () => { drag = null; });
    }
    byId("tkChartH").addEventListener("keydown", (ev) => {
      const step = ev.shiftKey ? 0.1 : 1, t = this.graph.get<number>("inspectT");
      if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
        ev.preventDefault();
        this.markInput();
        this.graph.set("cursor", Math.max(0, Math.min(this.graph.get<number>("now"), t + (ev.key === "ArrowRight" ? step : -step))));
      }
      if (ev.key === "Escape") this.graph.set("cursor", null);
    });
  }
}
