/**
 * Janela do bloco Scope (`sl.scope`, docs/66): sinais das entradas no tempo, gravados no Core pela
 * assinatura de séries (ADR 0012) e desenhados com o `XYChart` do Laboratório (mesmo motor de gráfico,
 * sem segundo componente de plotagem). Parâmetros do bloco: `TimeSpan` (Auto = tudo; número = janela,
 * com `TimeSpanOverrunAction` Wrap/Scroll), `YLimits` + `AxesScaling` (Manual/Auto/Updates), `ShowGrid`,
 * `ShowLegend`, `Title`, `YLabel`.
 */
import { XYChart, type ChartGeometry } from "../lab/ui/chart.js";
import { svg } from "../lab/ui/dom.js";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

interface ScopeChannel { id: string; label: string }
interface ScopeParams { TimeSpan?: string; TimeSpanOverrunAction?: string; TimeUnits?: string; TimeDisplayOffset?: string; TimeAxisLabels?: string; ShowTimeAxisLabel?: boolean; YLimits?: string; AxesScaling?: string; AxesScalingNumUpdates?: string; ShowGrid?: boolean; ShowLegend?: boolean; Title?: string; YLabel?: string; DataLoggingLimitDataPoints?: boolean; DataLoggingMaxPoints?: string; DataLoggingDecimateData?: boolean; DataLoggingDecimation?: string }
type HostMessage =
  | { type: "init"; title: string; channels: ScopeChannel[]; params: ScopeParams }
  | { type: "delta"; reset: boolean; t: number[]; columns: number[][] }
  | { type: "status"; text: string };

const vscode = acquireVsCodeApi();
const COLORS = ["#d4a017", "#1f77b4", "#d62728", "#2ca02c", "#9467bd", "#17becf", "#e377c2", "#8c564b"];
const GEOMETRY: ChartGeometry = { W: 900, H: 420, L: 64, R: 16, T: 22, B: 34 };

let channels: ScopeChannel[] = [];
let params: ScopeParams = {};
let times: number[] = [];
let values: number[][] = [];
let paused = false;
let autoscaleOnce = false;
let updates = 0;
let frozenY: [number, number] | undefined;
let drawPending = false;
let sampleIndex = 0;

const app = document.getElementById("app")!;
const header = document.createElement("header");
const title = document.createElement("h1");
const status = document.createElement("span");
status.className = "status";
const buttons = document.createElement("div");
buttons.className = "actions";
const autoscaleButton = document.createElement("button");
autoscaleButton.textContent = "Autoescala";
autoscaleButton.title = "Ajusta os eixos aos dados (como \"Scale Y-axes limits\" do Scope)";
autoscaleButton.addEventListener("click", () => { autoscaleOnce = true; scheduleDraw(true); });
const pauseButton = document.createElement("button");
pauseButton.textContent = "Congelar";
pauseButton.addEventListener("click", () => { paused = !paused; pauseButton.textContent = paused ? "Continuar" : "Congelar"; scheduleDraw(); });
buttons.append(autoscaleButton, pauseButton);
const clearButton = document.createElement("button");
clearButton.textContent = "Limpar";
clearButton.addEventListener("click", () => { times = []; values = channels.map(() => []); updates = 0; sampleIndex = 0; frozenY = undefined; scheduleDraw(true); });
buttons.append(clearButton);
header.append(title, buttons, status);
const legend = document.createElement("div");
legend.className = "legend";
const plot = svg("svg", { class: "plot", role: "img" }, app) as unknown as SVGSVGElement;
app.prepend(header);
app.append(legend);
const chart = new XYChart(plot, GEOMETRY);

function parseLimits(text: string | undefined): [number, number] | undefined {
  const values = (text ?? "").replace(/[[\]]/g, "").split(/[\s,;]+/).filter(Boolean).map(Number);
  return values.length === 2 && values.every(Number.isFinite) && values[1]! > values[0]! ? [values[0]!, values[1]!] : undefined;
}

/** Janela de tempo: Auto = tudo; número = os últimos `span` s (Scroll) ou a faixa corrente (Wrap). */
function timeWindow(): [number, number] {
  const last = times.length > 0 ? times[times.length - 1]! : 0;
  const span = Number(params.TimeSpan);
  if (!(span > 0)) return [0, Math.max(last, 1e-9)];
  if (params.TimeSpanOverrunAction === "Scroll") return [Math.max(0, last - span), Math.max(span, last)];
  let start = Math.floor(last / span) * span;
  if (last > 0 && Math.abs(last - start) < 1e-12) start = Math.max(0, start - span);
  return [start, start + span];
}

function dataRange(t0: number, t1: number): [number, number] {
  let low = Infinity, high = -Infinity;
  for (let i = 0; i < times.length; i++) {
    if (times[i]! < t0 || times[i]! > t1) continue;
    for (const column of values) { const v = column[i]!; if (Number.isFinite(v)) { low = Math.min(low, v); high = Math.max(high, v); } }
  }
  if (!Number.isFinite(low)) return [-1, 1];
  if (low === high) return [low - Math.max(1, Math.abs(low)) * 0.1, high + Math.max(1, Math.abs(high)) * 0.1];
  const margin = (high - low) * 0.08;
  return [low - margin, high + margin];
}

function yRange(t0: number, t1: number): [number, number] {
  const scaling = params.AxesScaling ?? "Manual";
  if (autoscaleOnce) { frozenY = dataRange(t0, t1); autoscaleOnce = false; }
  if (scaling === "Auto") return dataRange(t0, t1);
  if (frozenY) return frozenY;
  if (scaling === "Updates") {
    const limit = Number(params.AxesScalingNumUpdates ?? 10);
    if (updates <= (Number.isFinite(limit) ? limit : 10)) return dataRange(t0, t1);
    frozenY = dataRange(t0, t1);
    return frozenY;
  }
  return parseLimits(params.YLimits) ?? [-10, 10];
}

/** Pontos de uma coluna na janela, decimados por mínimo/máximo por coluna de pixels. */
function decimated(column: number[], t0: number, t1: number): Array<Array<readonly [number, number]>> {
  const buckets = GEOMETRY.W - GEOMETRY.L - GEOMETRY.R;
  const segments: Array<Array<readonly [number, number]>> = [];
  let current: Array<readonly [number, number]> = [];
  let bucket = -1, minPoint: readonly [number, number] | undefined, maxPoint: readonly [number, number] | undefined;
  const flush = () => {
    if (minPoint && maxPoint) {
      if (minPoint[0] <= maxPoint[0]) current.push(minPoint, maxPoint); else current.push(maxPoint, minPoint);
    }
    minPoint = maxPoint = undefined;
  };
  for (let i = 0; i < times.length; i++) {
    const t = times[i]!;
    if (t < t0 || t > t1) continue;
    const v = column[i]!;
    if (!Number.isFinite(v)) { flush(); if (current.length > 0) segments.push(current); current = []; continue; }
    const b = Math.floor(((t - t0) / (t1 - t0 || 1)) * buckets);
    if (b !== bucket) { flush(); bucket = b; }
    if (!minPoint || v < minPoint[1]) minPoint = [t, v];
    if (!maxPoint || v > maxPoint[1]) maxPoint = [t, v];
  }
  flush();
  if (current.length > 0) segments.push(current);
  return segments;
}

function draw(): void {
  drawPending = false;
  const [t0, t1] = timeWindow();
  const [y0, y1] = yRange(t0, t1);
  chart.setView({ x0: t0, x1: t1 > t0 ? t1 : t0 + 1, y0, y1 });
  const base = chart.layer("base");
  const offset = Number(params.TimeDisplayOffset ?? 0);
  const unit = params.TimeUnits === "Seconds" ? "s" : params.TimeUnits === "Metric" ? "s" : "";
  const showTime = params.ShowTimeAxisLabel === true && params.TimeAxisLabels !== "None";
  chart.axes(base, { xLabel: showTime ? `Tempo${unit ? ` (${unit})` : ""}` : "", yLabel: params.YLabel ?? "", showGrid: params.ShowGrid !== false, xTickOffset: Number.isFinite(offset) ? offset : 0 });
  values.forEach((column, index) => chart.path(base, decimated(column, t0, t1), { stroke: COLORS[index % COLORS.length]!, "stroke-width": 1.6 }));
  const last = times.length - 1;
  status.textContent = last >= 0 ? `t = ${times[last]!.toFixed(3)} s | ${times.length} amostras${paused ? " (congelado)" : ""}` : "aguardando a simulação";
}

function scheduleDraw(force = false): void {
  if (drawPending || (paused && !force)) return;
  drawPending = true;
  requestAnimationFrame(draw);
}

function renderLegend(): void {
  legend.innerHTML = "";
  legend.hidden = params.ShowLegend !== true;
  channels.forEach((channel, index) => {
    const item = document.createElement("span");
    item.className = "item";
    const swatch = document.createElement("i");
    swatch.style.background = COLORS[index % COLORS.length]!;
    item.append(swatch, document.createTextNode(channel.label));
    legend.append(item);
  });
}

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  if (message.type === "init") {
    channels = message.channels;
    params = message.params;
    const custom = (params.Title ?? "").trim();
    title.textContent = custom && custom !== "%<SignalLabel>" ? custom : message.title;
    times = [];
    values = channels.map(() => []);
    updates = 0;
    sampleIndex = 0;
    frozenY = undefined;
    renderLegend();
    scheduleDraw();
  } else if (message.type === "delta") {
    if (message.reset) { times = []; values = channels.map(() => []); updates = 0; sampleIndex = 0; frozenY = undefined; }
    const requestedDecimation = Math.floor(Number(params.DataLoggingDecimation ?? 2));
    const decimation = params.DataLoggingDecimateData === true && Number.isFinite(requestedDecimation) ? Math.max(1, requestedDecimation) : 1;
    const selected = message.t.map((_, i) => i).filter((i) => (sampleIndex + i) % decimation === 0);
    times.push(...selected.map((i) => message.t[i]!));
    message.columns.forEach((column, index) => values[index]?.push(...selected.map((i) => column[i] ?? NaN)));
    sampleIndex += message.t.length;
    if (params.DataLoggingLimitDataPoints === true) {
      const requestedLimit = Math.floor(Number(params.DataLoggingMaxPoints ?? 5000));
      const limit = Number.isFinite(requestedLimit) ? Math.max(16, requestedLimit) : 5000;
      if (times.length > limit) { const drop = times.length - limit; times.splice(0, drop); values.forEach((column) => column.splice(0, drop)); }
    }
    updates++;
    scheduleDraw();
  } else if (message.type === "status") {
    status.textContent = message.text;
  }
});

vscode.postMessage({ type: "ready" });
