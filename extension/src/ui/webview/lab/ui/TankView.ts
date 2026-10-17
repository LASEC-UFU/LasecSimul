import type { TankActivity, RiemannMethod } from "../activity.js";
import { LabGraph } from "../graph/LabGraph.js";
import type { LabPlantStatus, LabRunStatus, LabSeriesDelta, LabToHostMessage } from "../messages.js";
import { LAB_MESSAGE_VERSION } from "../messages.js";
import { SeriesBuffer, riemannOnSteps, type BufferEvent } from "../series/SeriesBuffer.js";
import { TANK_PARAMETERS, type TankParameterId, type TankParameterValues } from "../tankModel.js";
import { byId, clear, svg } from "./dom.js";
import { iconButton } from "./icons.js";
import type { ViewStats } from "./LimitsView.js";

export interface TankViewOptions {
  teacher: boolean;
  send: (message: LabToHostMessage) => void;
  onSave: (activity: TankActivity) => void;
}

const nf = (x: number, d = 3): string => (Number.isFinite(x) ? x.toLocaleString("pt-BR", { maximumFractionDigits: d }) : "—");
const GEO = { W: 640, H: 230, Lm: 54, R: 12, T: 16, B: 28 };
const SLIDERS: ReadonlyArray<{ id: TankParameterId; label: string; unit: string }> = [
  { id: "qIn", label: "Vazão de entrada", unit: " L/s" },
  { id: "qOut", label: "Vazão de saída (bomba)", unit: " L/s" },
  { id: "k", label: "Válvula k", unit: " L/(s·m)" },
  { id: "area", label: "Área do tanque A", unit: " m²" },
];

interface Sample {
  t: number;
  V: ReturnType<SeriesBuffer["linearAt"]>;
  h: ReturnType<SeriesBuffer["linearAt"]>;
  A: number; q: number; qIn: number; qOut: number; overflow: number; unmet: number;
  cumIn: number; cumOut: number; cumOverflow: number; cumSpill: number;
}
interface RiemannResult { a: number; b: number; n: number; method: RiemannMethod; sum: number; bars: Array<{ x0: number; x1: number; height: number }>; exact: number; dV: number; spills: number }

/**
 * Atividade "Tanque — da vazão à integral" (docs/53 §2). A física roda no Core (subcircuito
 * `hydraulic_tank`, acumulador conservativo); esta vista só lê as séries gravadas que o Host repassa:
 * gráficos, cursor, Riemann e equações nunca consultam estado interno. Parâmetros vão ao Core pelo
 * Host (política live/stop-required); o valor exibido é o aceito.
 */
export class TankView {
  readonly graph = new LabGraph();
  readonly buffer = new SeriesBuffer();
  readonly stats: ViewStats = { renders: {}, latencies: [], frames: 0 };
  private readonly dirty = new Set<string>();
  private readonly drawables: Array<{ id: string; inputs: string[]; draw: () => void }> = [];
  private frameRequested = false;
  private pendingInputAt: number | undefined;
  private disposed = false;
  /** Último valor aceito pelo Core para cada parâmetro (o slider volta a ele se o Host recusar). */
  private readonly accepted: TankParameterValues;
  private readonly pendingSend = new Map<TankParameterId, number>();
  private plantComponentId: string | undefined;

  constructor(private readonly root: HTMLElement, private activity: TankActivity, private readonly options: TankViewOptions) {
    this.accepted = { ...activity.parameters };
    this.renderLayout();
    this.buildGraph();
    this.buildDrawables();
    this.bindControls();
    this.requestFrame();
    options.send({ version: LAB_MESSAGE_VERSION, type: "labActivate", activity });
  }

  dispose(): void { this.disposed = true; clear(this.root); }

  // ------------------------------------------------------------------ mensagens do Host
  plant(status: LabPlantStatus): void {
    this.plantComponentId = status.state === "bound" ? status.componentId : undefined;
    this.graph.set("plant", status);
  }
  runState(status: LabRunStatus): void { this.graph.set("status", status); }
  series(delta: LabSeriesDelta): void {
    this.buffer.ingest(delta);
    this.graph.set("rev", this.buffer.revision);
  }
  parameterAccepted(id: TankParameterId, value: number): void {
    this.accepted[id] = value;
    this.graph.set("params", { ...this.accepted });
    byId("tkParamError").textContent = "";
  }
  parameterRejected(id: TankParameterId, reason: string): void {
    byId("tkParamError").textContent = reason;
    this.showParameter(id, this.accepted[id]);
  }

  currentActivity(): TankActivity {
    const questionInput = document.getElementById("tkQuestionInput") as HTMLInputElement | null;
    const question = (this.options.teacher ? questionInput?.value.trim() : "") || this.activity.question;
    const a = this.graph.get<number>("a"), b = this.graph.get<number>("b");
    return {
      ...this.activity, question, parameters: { ...this.accepted },
      riemann: { a: Math.min(a, b), b: Math.max(a, b, Math.min(a, b) + 0.01), n: this.graph.get<number>("n"), method: this.graph.get<RiemannMethod>("method") },
      ...(this.plantComponentId ? { plantComponentId: this.plantComponentId } : {}),
    };
  }

  saved(): void { const status = document.getElementById("tkSaveStatus"); if (status) status.textContent = "Atividade gravada no projeto (salve o .lsproj para persistir)."; }

  // ------------------------------------------------------------------ layout
  private renderLayout(): void {
    const a = this.activity;
    const slider = (s: (typeof SLIDERS)[number]): string => {
      const spec = TANK_PARAMETERS.find((p) => p.id === s.id)!;
      return `<label id="tkLabel_${s.id}">${s.label} <output id="tkOut_${s.id}"></output>
        <input id="tk_${s.id}" type="range" min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${a.parameters[s.id]}" /></label>`;
    };
    this.root.innerHTML = `
<section class="lim-question"><h1 id="tkQuestion"></h1>
  <p class="note">O processo roda no simulador; gráficos, cursor e Riemann leem só as séries gravadas pelo Core.</p></section>
<div id="tkPlant" class="plant-status" role="status"></div>
<main class="tank-layout">
  <section class="panel dark" aria-label="Processo">
    <h2>Processo <span id="tkStatus" class="status" role="status"></span></h2>
    <svg id="tkTank" viewBox="0 0 320 300" role="img" aria-labelledby="tkTankCaption"></svg>
    <p id="tkTankCaption" class="note"></p>
    <div class="sliders">${SLIDERS.map(slider).join("")}</div>
    <div class="config">
      <label>Saída <select id="tkMode"><option value="0">bomba (vazão imposta)</option><option value="1">válvula (q = k·h)</option></select></label>
      <label>V₀ (L) <input id="tkV0" type="number" min="0" max="400" step="1" /></label>
      <label>h<sub>máx</sub> (m) <input id="tkHMax" type="number" min="0.2" max="2" step="0.05" /></label>
      <p id="tkParamError" class="error" role="alert"></p>
    </div>
    <div id="tkRunBar" class="toolbar" role="toolbar" aria-label="Execução"></div>
    <div id="tkTeacher" class="teacher" hidden>
      <label>Pergunta <input id="tkQuestionInput" type="text" /></label>
      <p class="note">Os valores atuais dos controles e o intervalo de Riemann viram os valores iniciais da atividade.</p>
      <p id="tkSaveStatus" class="note" role="status"></p>
    </div>
  </section>
  <section class="panel" aria-label="Gráficos">
    <div class="chart-head"><h2>Nível × tempo</h2><span id="tkModeBadge" class="badge"></span></div>
    <svg id="tkChartH" class="chart" viewBox="0 0 640 230" tabindex="0" aria-label="Gráfico do nível; setas movem o cursor, Esc volta ao vivo"></svg>
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
  <div class="question"><strong>Explore:</strong> com a válvula, a área de Riemann entre a e b converge para V(b) − V(a)? E se você mudar A no meio do intervalo?
    <ul id="tkEvents" class="events" aria-label="Eventos"></ul>
  </div>
</section>`;
    byId("tkQuestion").textContent = a.question;
    byId<HTMLInputElement>("tkQuestionInput").value = a.question;
    byId("tkTeacher").hidden = !this.options.teacher;
    if (this.options.teacher) {
      const save = iconButton("save", "Gravar atividade no projeto", { id: "tkSave" });
      save.addEventListener("click", () => this.options.onSave(this.currentActivity()));
      byId("tkTeacher").appendChild(save);
    }
    for (const s of SLIDERS) this.showParameter(s.id, a.parameters[s.id]);
    this.showParameter("valve", a.parameters.valve);
    this.showParameter("v0", a.parameters.v0);
    this.showParameter("hMax", a.parameters.hMax);
  }

  // ------------------------------------------------------------------ grafo
  private buildGraph(): void {
    const g = this.graph, r = this.activity.riemann;
    g.source("rev", 0, { kind: "series" });
    g.source("status", "stopped" as LabRunStatus, { kind: "execution" });
    g.source("plant", { state: "missing" } as LabPlantStatus, { kind: "execution" });
    g.source("params", { ...this.accepted }, { kind: "parameter-mirror", equals: (x, y) => JSON.stringify(x) === JSON.stringify(y) });
    g.source("cursor", null as number | null, { kind: "inspection" });
    g.source("a", r.a, { kind: "inspection" });
    g.source("b", r.b, { kind: "inspection" });
    g.source("n", r.n, { kind: "inspection" });
    g.source("method", r.method, { kind: "inspection" });
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
      { id: "baseH", inputs: ["window", "rev", "params"], draw: () => this.drawBase("h") },
      { id: "baseQ", inputs: ["window", "rev"], draw: () => this.drawBase("q") },
      { id: "riemannBars", inputs: ["window", "riemann"], draw: () => this.drawRiemannBars() },
      { id: "overH", inputs: ["window", "inspectT", "cursor", "a", "b", "params"], draw: () => this.drawOver("h") },
      { id: "overQ", inputs: ["window", "inspectT", "cursor", "a", "b"], draw: () => this.drawOver("q") },
      { id: "tank", inputs: ["atT", "cursor", "params"], draw: () => this.drawTank() },
      { id: "equations", inputs: ["atT"], draw: () => this.drawEquations() },
      { id: "riemannText", inputs: ["riemann"], draw: () => this.drawRiemann() },
      { id: "events", inputs: ["rev"], draw: () => this.drawEvents() },
      { id: "status", inputs: ["status", "now", "cursor", "plant"], draw: () => this.drawStatus() },
      { id: "plant", inputs: ["plant"], draw: () => this.drawPlant() },
      { id: "inspect", inputs: ["method", "n"], draw: () => { byId<HTMLSelectElement>("tkMethod").value = this.graph.get("method"); byId<HTMLInputElement>("tkN").value = String(this.graph.get("n")); byId("tkNOut").textContent = String(this.graph.get("n")); } },
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
      for (const [id, value] of this.pendingSend) this.options.send({ version: LAB_MESSAGE_VERSION, type: "labSetParameter", id, value });
      this.pendingSend.clear();
    });
  }
  private markInput(): void { if (this.pendingInputAt === undefined) this.pendingInputAt = performance.now(); }

  private axes(kind: "h" | "q") {
    const { t0, t1 } = this.graph.get<{ t0: number; t1: number }>("window");
    const hMax = this.graph.get<TankParameterValues>("params").hMax;
    const [y0, y1] = kind === "h" ? [0, hMax * 1.1] : [-2.2, 2.2];
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

  /** Trechos contínuos da coluna: quebra onde A mudou (h salta na amostra seguinte) e onde houve derramamento. */
  private segments(column: "h" | "q"): Array<[number, number]> {
    const s = this.buffer, n = s.length;
    if (n === 0) return [];
    const A = s.col("A"), spill = s.col("cumSpill"), cuts: number[] = [];
    for (let i = 1; i < n; i++) {
      if (A[i] !== A[i - 1] && column === "h" && i + 1 < n) cuts.push(i + 1);
      if (spill[i] !== spill[i - 1]) cuts.push(i);
    }
    const bounds = [0, ...[...new Set(cuts)].sort((x, y) => x - y), n];
    const result: Array<[number, number]> = [];
    for (let k = 0; k + 1 < bounds.length; k++) if (bounds[k + 1]! > bounds[k]!) result.push([bounds[k]!, bounds[k + 1]!]);
    return result;
  }

  /** Envelope mín/máx por coluna de pixel (só desenho; cálculos usam todas as linhas). `holdTo`: mantém o último valor até esse t. */
  private pathFor(column: "h" | "q", i0: number, i1: number, ax: ReturnType<TankView["axes"]>, holdTo?: number): string {
    const s = this.buffer, t = s.t, values = s.col(column), columns = 600, points: Array<[number, number]> = [];
    let bucket = -1, lo = 0, hi = 0, tl = 0, th = 0, last = NaN;
    const flush = () => { if (bucket >= 0) (tl <= th ? points.push([tl, lo], [th, hi]) : points.push([th, hi], [tl, lo])); };
    for (let i = i0; i < i1; i++) {
      const v = values[i]!;
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
    const group = this.layer(kind, "base"), ax = this.axes(kind), hMax = this.graph.get<TankParameterValues>("params").hMax;
    svg("line", { x1: GEO.Lm, y1: ax.y(0), x2: GEO.W - GEO.R, y2: ax.y(0), stroke: "#94a3b8" }, group);
    svg("line", { x1: GEO.Lm, y1: GEO.T, x2: GEO.Lm, y2: GEO.H - GEO.B, stroke: "#94a3b8" }, group);
    const tStep = (ax.t1 - ax.t0) / 6;
    for (let t = 0; t <= ax.t1 + 1e-9; t += tStep) svg("text", { x: ax.x(t), y: GEO.H - 10, "text-anchor": "middle", "font-size": 11, fill: "#475569" }, group).textContent = nf(t, 0);
    const ticks = kind === "h" ? [0, hMax / 2, hMax] : [-2, -1, 0, 1, 2];
    for (const v of ticks) svg("text", { x: GEO.Lm - 6, y: ax.y(v) + 4, "text-anchor": "end", "font-size": 11, fill: "#475569" }, group).textContent = nf(v, 2);
    svg("text", { x: 6, y: 12, "font-size": 12, fill: "#0f172a" }, group).textContent = kind === "h" ? "h (m)" : "q (L/s)";
    // Título do eixo do tempo no canto superior direito: no rodapé colidia com o último rótulo.
    svg("text", { x: GEO.W - GEO.R, y: 12, "text-anchor": "end", "font-size": 12, fill: "#0f172a" }, group).textContent = "t (s)";
    if (kind === "h") svg("line", { x1: GEO.Lm, y1: ax.y(hMax), x2: GEO.W - GEO.R, y2: ax.y(hMax), stroke: "#dc2626", "stroke-dasharray": "4 3" }, group);
    const column = kind === "h" ? "h" : "q";
    const segments = this.segments(column);
    segments.forEach(([i0, i1], index) => {
      const next = segments[index + 1];
      const holdTo = kind === "h" && next ? this.buffer.t[next[0]] : undefined;
      svg("path", { d: this.pathFor(column, i0, i1, ax, holdTo), fill: "none", stroke: kind === "h" ? "#1d4ed8" : "#0e7490", "stroke-width": 2, "data-series": column }, group);
    });
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
    const live = this.graph.get<number | null>("cursor") === null, cx = ax.x(this.graph.get<number>("inspectT"));
    svg("line", { x1: cx, y1: GEO.T, x2: cx, y2: GEO.H - GEO.B, stroke: live ? "#16a34a" : "#ea580c", "stroke-width": live ? 1 : 2, "stroke-dasharray": live ? "2 3" : "6 3" }, group);
    svg("text", { x: cx + 4, y: GEO.H - GEO.B - 6, "font-size": 12, fill: live ? "#16a34a" : "#ea580c" }, group).textContent = live ? "agora" : "t";
  }

  private describeEvent(e: BufferEvent): string {
    const t = nf(e.tS, 2);
    const names: Record<string, string> = { qIn: "vazão de entrada", qOut: "vazão de saída", area: "área A", k: "válvula k", valve: "modo de saída", hMax: "h máx.", v0: "V₀" };
    if (e.kind === "parameter") return `t = ${t} s: ${names[e.name ?? ""] ?? e.name} → ${nf(e.value ?? NaN, 3)} (vale na amostra seguinte, 10 ms)`;
    if (e.kind === "spill") return `t = ${t} s: derramamento instantâneo de ${nf(e.volume ?? NaN, 3)} L (A·h_máx < V)`;
    if (e.kind === "boundary:upper") return `t = ${t} s: atingiu a borda (transborda)`;
    if (e.kind === "boundary:lower") return `t = ${t} s: esvaziou (saída sem água)`;
    return `t = ${t} s: início`;
  }

  // ------------------------------------------------------------------ processo (reconstruído das séries)
  private drawTank(): void {
    const s = this.graph.get<Sample | undefined>("atT"), root = byId("tkTank") as unknown as SVGSVGElement;
    const params = this.graph.get<TankParameterValues>("params");
    const live = this.graph.get<number | null>("cursor") === null;
    clear(root);
    const A = s?.A ?? params.area, hMax = params.hMax;
    const w = 60 + ((A - 0.03) / 0.17) * 150, x0 = 160 - w / 2, top = 40, H = 210;
    const level = s ? Math.max(0, Math.min(1, s.h.value / hMax)) : (params.v0 / (1000 * A)) / hMax;
    svg("rect", { x: x0, y: top, width: w, height: H, fill: "#0b1f3a", stroke: "#cbd5e1", "stroke-width": 3 }, root);
    svg("rect", { x: x0 + 2, y: top + H * (1 - level), width: w - 4, height: H * level, fill: "#38bdf8", "fill-opacity": 0.85, "data-level": level.toFixed(4) }, root);
    for (let k = 0; k <= 4; k++) {
      const y = top + H - (k / 4) * H;
      svg("line", { x1: x0 + w, y1: y, x2: x0 + w + 8, y2: y, stroke: "#cbd5e1" }, root);
      svg("text", { x: x0 + w + 11, y: y + 4, "font-size": 10, fill: "#e2e8f0" }, root).textContent = nf((k / 4) * hMax, 2);
    }
    svg("text", { x: x0 + w + 8, y: top - 6, "font-size": 10, fill: "#e2e8f0" }, root).textContent = "h (m)";
    svg("path", { d: `M10 22 H${x0 + 22} V${top + 14}`, stroke: "#60a5fa", "stroke-width": 6, fill: "none" }, root);
    svg("text", { x: 10, y: 14, "font-size": 12, fill: "#bfdbfe" }, root).textContent = `entrada ${nf(s?.qIn ?? params.qIn)} L/s`;
    svg("path", { d: `M${x0 + w - 10} ${top + H} V${top + H + 22} H312`, stroke: "#60a5fa", "stroke-width": 6, fill: "none" }, root);
    const outText = s && s.unmet > 0 ? `saída ${nf(s.qOut)} L/s (falta ${nf(s.unmet)})` : `saída ${nf(s?.qOut ?? NaN)} L/s`;
    svg("text", { x: 312, y: top + H + 42, "text-anchor": "end", "font-size": 12, fill: "#bfdbfe" }, root).textContent = outText;
    if (s && s.overflow > 0) {
      svg("path", { d: `M${x0 + w} ${top + 2} q 18 0 22 30 v 160`, stroke: "#f87171", "stroke-width": 4, fill: "none", "stroke-dasharray": "6 4" }, root);
      svg("text", { x: x0 + w + 6, y: top + 60, "font-size": 11, fill: "#fecaca" }, root).textContent = `transborda ${nf(s.overflow)} L/s`;
    }
    svg("text", { x: 160, y: top + H - 8, "text-anchor": "middle", "font-size": 13, fill: "#0f172a", "font-weight": 700 }, root).textContent = `V = ${nf(s?.V.value ?? params.v0, 2)} L`;
    svg("text", { x: 160, y: 296, "text-anchor": "middle", "font-size": 11, fill: "#cbd5e1" }, root).textContent = `A = ${nf(A, 3)} m²`;
    byId("tkTankCaption").textContent = !s ? "Sem dados: execute a simulação." : live ? "Ao vivo: último dado gravado pelo Core."
      : `Inspeção em t = ${nf(s.t, 2)} s — reconstrução a partir das séries gravadas; o simulador continua no presente.`;
  }

  // ------------------------------------------------------------------ equações e Riemann
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
    const status = this.graph.get<LabRunStatus>("status"), live = this.graph.get<number | null>("cursor") === null;
    const bound = this.graph.get<LabPlantStatus>("plant").state === "bound";
    byId("tkStatus").textContent = `${{ stopped: "Configuração", running: "Executando", paused: "Pausado" }[status]} · t = ${nf(this.graph.get<number>("now"), 2)} s`;
    const badge = byId("tkModeBadge");
    badge.textContent = live ? "ao vivo" : "inspeção (passado)";
    badge.className = `badge ${live ? "exact" : "numeric"}`;
    for (const id of ["tkMode", "tkV0", "tkHMax"]) {
      const input = byId<HTMLInputElement>(id);
      input.disabled = status !== "stopped";
      input.title = status !== "stopped" ? "Só muda com a simulação parada: use Reiniciar" : "";
    }
    for (const id of ["tkRun", "tkPause", "tkRestart"]) byId<HTMLButtonElement>(id).disabled = !bound;
  }

  private drawPlant(): void {
    const status = this.graph.get<LabPlantStatus>("plant"), box = byId("tkPlant");
    clear(box);
    if (status.state === "bound") { box.className = "plant-status ok"; box.textContent = `Processo ligado: ${status.label}`; return; }
    box.className = "plant-status warn";
    const text = document.createElement("span");
    text.textContent = status.state === "missing"
      ? "Este projeto ainda não tem o tanque do laboratório (Processo › Modelos › Tanque hidráulico)."
      : `Processo indisponível: ${status.message}`;
    box.appendChild(text);
    if (status.state === "missing") {
      const insert = document.createElement("button");
      insert.type = "button";
      insert.id = "tkInsertPlant";
      insert.textContent = "Inserir tanque no projeto";
      insert.addEventListener("click", () => this.options.send({ version: LAB_MESSAGE_VERSION, type: "labInsertPlant" }));
      box.appendChild(insert);
    }
  }

  // ------------------------------------------------------------------ controles
  private showParameter(id: TankParameterId, value: number): void {
    if (id === "valve") {
      byId<HTMLSelectElement>("tkMode").value = String(value);
      byId("tkLabel_qOut").hidden = value !== 0;
      byId("tkLabel_k").hidden = value !== 1;
      return;
    }
    if (id === "v0") { byId<HTMLInputElement>("tkV0").value = String(value); return; }
    if (id === "hMax") { byId<HTMLInputElement>("tkHMax").value = String(value); return; }
    const slider = SLIDERS.find((s) => s.id === id)!;
    byId<HTMLInputElement>(`tk_${id}`).value = String(value);
    byId(`tkOut_${id}`).textContent = `${nf(value, 3)}${slider.unit}`;
  }

  private requestParameter(id: TankParameterId, value: number): void {
    this.markInput();
    this.showParameter(id, value);
    this.pendingSend.set(id, value);
    this.requestFrame();
  }

  private bindControls(): void {
    for (const s of SLIDERS) byId<HTMLInputElement>(`tk_${s.id}`).addEventListener("input", (ev) => this.requestParameter(s.id, Number((ev.target as HTMLInputElement).value)));
    byId<HTMLSelectElement>("tkMode").addEventListener("change", (ev) => this.requestParameter("valve", Number((ev.target as HTMLSelectElement).value)));
    byId<HTMLInputElement>("tkV0").addEventListener("change", (ev) => this.requestParameter("v0", Number((ev.target as HTMLInputElement).value)));
    byId<HTMLInputElement>("tkHMax").addEventListener("change", (ev) => this.requestParameter("hMax", Number((ev.target as HTMLInputElement).value)));

    const bar = byId("tkRunBar");
    const buttons: Array<[HTMLButtonElement, () => void]> = [
      [iconButton("play", "Executar / retomar", { id: "tkRun" }), () => this.options.send({ version: LAB_MESSAGE_VERSION, type: "labRun" })],
      [iconButton("pause", "Pausar", { id: "tkPause" }), () => this.options.send({ version: LAB_MESSAGE_VERSION, type: "labPause" })],
      [iconButton("restart", "Reiniciar (volta aos valores iniciais da atividade)", { id: "tkRestart" }), () => this.restart()],
      [iconButton("live", "Voltar ao vivo", { id: "tkLive" }), () => this.graph.set("cursor", null)],
    ];
    for (const [button, action] of buttons) { button.addEventListener("click", action); bar.appendChild(button); }

    byId<HTMLSelectElement>("tkMethod").addEventListener("change", (ev) => { this.markInput(); this.graph.set("method", (ev.target as HTMLSelectElement).value); });
    byId<HTMLInputElement>("tkN").addEventListener("input", (ev) => { this.markInput(); this.graph.set("n", Number((ev.target as HTMLInputElement).value)); });

    let drag: "cursor" | "a" | "b" | null = null;
    for (const id of ["tkChartH", "tkChartQ"]) {
      const chart = byId(id) as unknown as SVGSVGElement;
      const tFrom = (ev: PointerEvent): number => {
        const rect = chart.getBoundingClientRect();
        const t = this.axes("h").tAt(((ev.clientX - rect.left) / rect.width) * GEO.W);
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

  private restart(): void {
    const initial = { ...this.activity.parameters };
    for (const id of Object.keys(initial) as TankParameterId[]) { this.accepted[id] = initial[id]; this.showParameter(id, initial[id]); }
    byId("tkParamError").textContent = "";
    this.graph.batch(() => { this.graph.set("cursor", null); this.graph.set("params", { ...initial }); });
    this.options.send({ version: LAB_MESSAGE_VERSION, type: "labRestart", parameters: initial });
  }
}
