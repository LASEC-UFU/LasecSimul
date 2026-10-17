// PoC isolada (NÃO é produção). Vertical "Tanque — da vazão à integral" com área A ajustável durante
// a execução. A física vem de tank-sim.mjs (substituto do Core só para a PoC); gráficos, cursor,
// Riemann e equações leem SOMENTE as séries gravadas, nunca o estado interno do simulador.
import { DependencyGraph } from "./engine.mjs";
import { TankSim, LITER } from "./tank-sim.mjs";
import { riemannOnSteps } from "./series.mjs";
import { iconButton } from "./icons.mjs";

const $ = (id) => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";
const el = (name, attrs = {}, parent) => { const n = document.createElementNS(NS, name); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v)); parent?.appendChild(n); return n; };
const nf = (x, d = 3) => (Number.isFinite(x) ? x.toLocaleString("pt-BR", { maximumFractionDigits: d }) : "—");
const L = (x, d = 3) => nf(x / LITER, d); // m³ ou m³/s -> L ou L/s

// ------------------------------------------------------------------ modelo autorado e simulação
const authored = { A: 0.1, hMax: 1, V0: 20 * LITER, qIn: 1 * LITER, qOut: 0.4 * LITER, k: 2 * LITER, mode: "pump" };
const sim = new TankSim({ ...authored });
let speed = 5;

// ------------------------------------------------------------------ grafo de dependências
const g = new DependencyGraph();
g.source("rev", sim.rec.revision, { kind: "series" });
g.source("status", sim.status, { kind: "execution" });
g.source("cursor", null, { kind: "inspection" }); // null = ao vivo
g.source("a", 5, { kind: "inspection" });
g.source("b", 25, { kind: "inspection" });
g.source("n", 10, { kind: "inspection" });
g.source("method", "left", { kind: "inspection" });
g.derived("now", ["rev"], () => sim.rec.t[sim.rec.length - 1]);
g.derived("window", ["now"], (now) => ({ t0: 0, t1: Math.max(60, Math.ceil((now + 1) / 30) * 30) }));
g.derived("inspectT", ["cursor", "now"], (c, now) => (c === null ? now : Math.min(c, now)));
g.derived("atT", ["rev", "inspectT"], (_rev, t) => sampleAt(t));
g.derived("riemann", ["rev", "a", "b", "n", "method", "now"], (_rev, a, b, n, method, now) => {
  const B = Math.min(Math.max(a, b), now), A0 = Math.min(Math.min(a, b), B);
  if (!(B > A0)) return null;
  const r = riemannOnSteps(sim.rec, "q", A0, B, n, method);
  const exact = sim.rec.stepIntegral("q", A0, B);
  const dV = sim.rec.linearAt("V", B, true).value - sim.rec.linearAt("V", A0, false).value;
  const spills = sim.events.filter((e) => e.kind === "spill" && e.tNs * 1e-9 >= A0 && e.tNs * 1e-9 <= B).reduce((s, e) => s + e.volume, 0);
  return { a: A0, b: B, n, method, sum: r.sum, bars: r.bars, exact, dV, spills };
});
g.derived("events", ["rev"], () => sim.events.slice());

function sampleAt(t) {
  const rec = sim.rec, col = (c) => rec.linearAt(c, t, true);
  const step = (c) => rec.stepValueAt(c, t, -1);
  return {
    t, V: col("V"), h: col("h"), A: col("A").value, q: step("q"), qIn: step("inActual"), qOut: step("outActual"),
    qOutDemand: step("qOutDemand"), overflow: step("overflow"), unmet: step("unmet"),
    cumIn: col("cumIn").value, cumOut: col("cumOut").value, cumOverflow: col("cumOverflow").value, residual: col("residual").value,
  };
}

// ------------------------------------------------------------------ desenho com invalidação seletiva
const stats = { renders: {}, latencies: [], frames: 0 };
const drawables = [
  { id: "baseH", inputs: ["window", "rev"], draw: () => drawBase("h") },
  { id: "baseQ", inputs: ["window", "rev", "events"], draw: () => drawBase("q") },
  { id: "riemannBars", inputs: ["window", "riemann"], draw: drawRiemannBars },
  { id: "overH", inputs: ["window", "inspectT", "cursor", "a", "b"], draw: () => drawOver("h") },
  { id: "overQ", inputs: ["window", "inspectT", "cursor", "a", "b"], draw: () => drawOver("q") },
  { id: "tank", inputs: ["atT", "cursor"], draw: drawTank },
  { id: "equations", inputs: ["atT"], draw: drawEquations },
  { id: "riemannText", inputs: ["riemann"], draw: drawRiemann },
  { id: "eventsList", inputs: ["events"], draw: drawEvents },
  { id: "statusText", inputs: ["status", "now", "cursor"], draw: drawStatus },
  { id: "inspectControls", inputs: ["method", "n"], draw: () => { $("method").value = g.get("method"); $("n").value = String(g.get("n")); $("nOut").textContent = String(g.get("n")); } },
];
const dirty = new Set(drawables.map((d) => d.id));
let frameRequested = false, pendingInputAt;
g.onChange((changed) => { for (const d of drawables) if (d.inputs.some((i) => changed.has(i))) dirty.add(d.id); requestFrame(); });
function requestFrame() {
  if (frameRequested) return;
  frameRequested = true;
  requestAnimationFrame(() => {
    frameRequested = false; stats.frames++;
    for (const d of drawables) if (dirty.has(d.id)) { d.draw(); stats.renders[d.id] = (stats.renders[d.id] ?? 0) + 1; }
    dirty.clear();
    if (pendingInputAt !== undefined) { stats.latencies.push(performance.now() - pendingInputAt); pendingInputAt = undefined; }
  });
}
const markInput = () => { if (pendingInputAt === undefined) pendingInputAt = performance.now(); };

// ------------------------------------------------------------------ gráficos
const GEO = { W: 640, H: 230, Lm: 54, R: 12, T: 16, B: 28 };
function axes(kind) {
  const { t0, t1 } = g.get("window");
  const [y0, y1] = kind === "h" ? [0, sim.params.hMax * 1.1] : [-2.2 * LITER, 2.2 * LITER];
  const x = (t) => GEO.Lm + ((t - t0) / (t1 - t0)) * (GEO.W - GEO.Lm - GEO.R);
  const y = (v) => GEO.H - GEO.B - ((v - y0) / (y1 - y0)) * (GEO.H - GEO.T - GEO.B);
  const tAt = (px) => t0 + ((px - GEO.Lm) / (GEO.W - GEO.Lm - GEO.R)) * (t1 - t0);
  return { t0, t1, y0, y1, x, y, tAt };
}
/** Índices onde a série tem duas linhas no mesmo instante (descontinuidade): o traçado é quebrado ali. */
function splitIndices() {
  const out = [];
  for (const e of sim.events) {
    if (!(e.kind === "spill" || (e.kind === "parameter" && (e.name === "A" || e.name === "hMax")))) continue;
    const i = sim.rec.upperBound(e.tNs * 1e-9) - 1;
    if (i > 0 && sim.rec.t[i] === sim.rec.t[i - 1]) out.push(i);
  }
  return [...new Set(out)].sort((p, q) => p - q);
}
/** Envelope min/máx por coluna de pixel dentro de [i0, i1): só para desenhar. */
function pathFor(col, i0, i1, ax) {
  const rec = sim.rec, cols = 600, pts = [];
  let bucket = -1, lo, hi, tl, th;
  const flush = () => { if (bucket >= 0) (tl <= th ? pts.push([tl, lo], [th, hi]) : pts.push([th, hi], [tl, lo])); };
  for (let i = i0; i < i1; i++) {
    const v = rec.data[col][i];
    if (Number.isNaN(v)) continue;
    const t = rec.t[i], b = Math.floor(((t - ax.t0) / (ax.t1 - ax.t0)) * cols);
    if (b !== bucket) { flush(); bucket = b; lo = hi = v; tl = th = t; } else { if (v < lo) { lo = v; tl = t; } if (v > hi) { hi = v; th = t; } }
  }
  flush();
  return pts.map(([t, v], k) => `${k ? "L" : "M"}${ax.x(t).toFixed(1)} ${ax.y(v).toFixed(1)}`).join("");
}
/** Cada gráfico tem três camadas com entradas próprias: mover o cursor só redesenha "over". */
function layer(kind, name) {
  const svg = $(kind === "h" ? "chartH" : "chartQ");
  let g0 = svg.querySelector(`g[data-layer="${name}"]`);
  if (!g0) { for (const n of ["under", "base", "over"]) el("g", { "data-layer": n }, svg); g0 = svg.querySelector(`g[data-layer="${name}"]`); }
  g0.textContent = "";
  return g0;
}
function drawRiemannBars() {
  const svg = layer("q", "under"), ax = axes("q"), rm = g.get("riemann");
  if (!rm) return;
  for (const bar of rm.bars) {
    const top = Math.max(0, bar.height), bottom = Math.min(0, bar.height);
    el("rect", { x: ax.x(bar.x0), y: ax.y(top), width: Math.max(0.5, ax.x(bar.x1) - ax.x(bar.x0)), height: Math.max(0, ax.y(bottom) - ax.y(top)), fill: "#93c5fd", "fill-opacity": 0.45, stroke: "#2563eb", "stroke-width": 0.6 }, svg);
  }
}
function drawBase(kind) {
  const svg = layer(kind, "base"), ax = axes(kind);
  el("line", { x1: GEO.Lm, y1: ax.y(0), x2: GEO.W - GEO.R, y2: ax.y(0), stroke: "#94a3b8" }, svg);
  el("line", { x1: GEO.Lm, y1: GEO.T, x2: GEO.Lm, y2: GEO.H - GEO.B, stroke: "#94a3b8" }, svg);
  const tStep = (ax.t1 - ax.t0) / 6;
  for (let t = 0; t <= ax.t1 + 1e-9; t += tStep) el("text", { x: ax.x(t), y: GEO.H - 10, "text-anchor": "middle", "font-size": 11, fill: "#475569" }, svg).textContent = nf(t, 0);
  const ticks = kind === "h" ? [0, sim.params.hMax / 2, sim.params.hMax] : [-2 * LITER, -1 * LITER, 0, 1 * LITER, 2 * LITER];
  for (const v of ticks) el("text", { x: GEO.Lm - 6, y: ax.y(v) + 4, "text-anchor": "end", "font-size": 11, fill: "#475569" }, svg).textContent = kind === "h" ? nf(v, 2) : L(v, 1);
  el("text", { x: 6, y: 12, "font-size": 12, fill: "#0f172a" }, svg).textContent = kind === "h" ? "h (m)" : "q (L/s)";
  el("text", { x: GEO.W - GEO.R, y: GEO.H - 10, "text-anchor": "end", "font-size": 11, fill: "#0f172a" }, svg).textContent = "t (s)";
  if (kind === "h") el("line", { x1: GEO.Lm, y1: ax.y(sim.params.hMax), x2: GEO.W - GEO.R, y2: ax.y(sim.params.hMax), stroke: "#dc2626", "stroke-dasharray": "4 3" }, svg);
  const col = kind === "h" ? "h" : "q";
  const splits = [0, ...splitIndices(), sim.rec.length]; // série quebrada nas descontinuidades
  for (let i = 0; i + 1 < splits.length; i++) el("path", { d: pathFor(col, splits[i], splits[i + 1], ax), fill: "none", stroke: kind === "h" ? "#1d4ed8" : "#0e7490", "stroke-width": 2, "data-series": col }, svg);
  if (kind === "q") for (const e of g.get("events")) {
    const color = e.kind === "parameter" ? "#2563eb" : e.kind === "spill" ? "#dc2626" : "#d97706";
    const px = ax.x(e.tNs * 1e-9);
    el("path", { d: `M${px - 5} ${GEO.T - 10} L${px + 5} ${GEO.T - 10} L${px} ${GEO.T - 2}z`, fill: color }, svg).appendChild(el("title")).textContent = describeEvent(e);
  }
}
function drawOver(kind) {
  const svg = layer(kind, "over"), ax = axes(kind);
  for (const name of ["a", "b"]) {
    const px = ax.x(Math.min(g.get(name), ax.t1));
    el("line", { x1: px, y1: GEO.T, x2: px, y2: GEO.H - GEO.B, stroke: "#7c3aed", "stroke-width": 1.5 }, svg);
    el("text", { x: px + 4, y: GEO.T + 12, "font-size": 13, "font-weight": 700, fill: "#7c3aed" }, svg).textContent = name;
    if (kind === "q") el("circle", { cx: px, cy: GEO.T + 2, r: 7, fill: "#7c3aed", "data-handle": name }, svg);
  }
  const live = g.get("cursor") === null, cx = ax.x(g.get("inspectT"));
  el("line", { x1: cx, y1: GEO.T, x2: cx, y2: GEO.H - GEO.B, stroke: live ? "#16a34a" : "#ea580c", "stroke-width": live ? 1 : 2, "stroke-dasharray": live ? "2 3" : "6 3" }, svg);
  el("text", { x: cx + 4, y: GEO.H - GEO.B - 6, "font-size": 12, fill: live ? "#16a34a" : "#ea580c" }, svg).textContent = live ? "agora" : "t";
}
function describeEvent(e) {
  const t = nf(e.tNs * 1e-9, 3);
  if (e.kind === "parameter") return `t = ${t} s: ${e.name} ${e.name === "A" ? `${nf(e.from, 3)} → ${nf(e.to, 3)} m²` : `${L(e.from)} → ${L(e.to)} L/s`}`;
  if (e.kind === "spill") return `t = ${t} s: derramamento instantâneo de ${L(e.volume)} L (A·h_máx < V)`;
  return `t = ${t} s: ${e.kind === "boundary:upper" ? "atingiu a borda (transborda)" : "esvaziou (saída sem água)"}`;
}

// ------------------------------------------------------------------ processo (reconstruído das séries)
function drawTank() {
  const s = g.get("atT"), svg = $("tankSvg"), live = g.get("cursor") === null;
  svg.textContent = "";
  const A = s.A, w = 60 + ((A - 0.03) / 0.17) * 150, x0 = 160 - w / 2, top = 40, H = 210;
  const level = Math.max(0, Math.min(1, s.h.value / sim.params.hMax));
  el("rect", { x: x0, y: top, width: w, height: H, fill: "#0b1f3a", stroke: "#cbd5e1", "stroke-width": 3 }, svg);
  el("rect", { x: x0 + 2, y: top + H * (1 - level), width: w - 4, height: H * level, fill: "#38bdf8", "fill-opacity": 0.85 }, svg);
  for (let k = 0; k <= 4; k++) { // régua
    const y = top + H - (k / 4) * H;
    el("line", { x1: x0 + w, y1: y, x2: x0 + w + 8, y2: y, stroke: "#cbd5e1" }, svg);
    el("text", { x: x0 + w + 11, y: y + 4, "font-size": 10, fill: "#e2e8f0" }, svg).textContent = nf((k / 4) * sim.params.hMax, 2);
  }
  el("text", { x: x0 + w + 8, y: top - 6, "font-size": 10, fill: "#e2e8f0" }, svg).textContent = "h (m)";
  el("path", { d: `M10 22 H${x0 + 22} V${top + 14}`, stroke: "#60a5fa", "stroke-width": 6, fill: "none" }, svg);
  el("text", { x: 10, y: 14, "font-size": 12, fill: "#bfdbfe" }, svg).textContent = `entrada ${L(s.qIn)} L/s`;
  el("path", { d: `M${x0 + w - 10} ${top + H} V${top + H + 22} H312`, stroke: "#60a5fa", "stroke-width": 6, fill: "none" }, svg);
  const outText = Number.isFinite(s.unmet) && s.unmet > 0 ? `saída ${L(s.qOut)} L/s (falta ${L(s.unmet)})` : `saída ${L(s.qOut)} L/s`;
  el("text", { x: 312, y: top + H + 42, "text-anchor": "end", "font-size": 12, fill: "#bfdbfe" }, svg).textContent = outText;
  if (Number.isFinite(s.overflow) && s.overflow > 0) {
    el("path", { d: `M${x0 + w} ${top + 2} q 18 0 22 30 v 160`, stroke: "#f87171", "stroke-width": 4, fill: "none", "stroke-dasharray": "6 4" }, svg);
    el("text", { x: x0 + w + 6, y: top + 60, "font-size": 11, fill: "#fecaca" }, svg).textContent = `transborda ${L(s.overflow)} L/s`;
  }
  el("text", { x: 160, y: top + H - 8, "text-anchor": "middle", "font-size": 13, fill: "#0f172a", "font-weight": 700 }, svg).textContent = `V = ${L(s.V.value, 2)} L`;
  el("text", { x: 160, y: 296, "text-anchor": "middle", "font-size": 11, fill: "#cbd5e1" }, svg).textContent = `A = ${nf(A, 3)} m²`;
  $("tankCaption").textContent = live ? "Ao vivo: último dado gravado." : `Inspeção em t = ${nf(s.t, 2)} s — reconstrução a partir das séries gravadas; o simulador continua no presente.`;
}

// ------------------------------------------------------------------ equações e Riemann
function drawEquations() {
  const s = g.get("atT");
  const v = (x, d = 3) => `<mn>${L(x, d)}</mn>`;
  const qMl = `<math><mi>q</mi><mo>=</mo><msub><mi>q</mi><mtext>ent</mtext></msub><mo>−</mo><msub><mi>q</mi><mtext>saí</mtext></msub><mo>−</mo><msub><mi>q</mi><mtext>transb</mtext></msub><mo>=</mo>${v(s.qIn)}<mo>−</mo>${v(s.qOut)}<mo>−</mo>${v(s.overflow)}<mo>=</mo>${v(s.q)}<mtext> L/s</mtext></math>`;
  const vMl = `<math><mi>V</mi><mo>(</mo><mi>t</mi><mo>)</mo><mo>=</mo><msub><mi>V</mi><mn>0</mn></msub><mo>+</mo><msubsup><mo>∫</mo><mn>0</mn><mi>t</mi></msubsup><mi>q</mi><mspace width="0.17em"></mspace><mi>d</mi><mi>τ</mi><mo>−</mo><mo>∑</mo><mtext>derram.</mtext><mo>=</mo>${v(sim.acc.x0, 2)}<mo>+</mo>${v(s.cumIn - s.cumOut - s.cumOverflow + spillsUntil(s.t), 3)}<mo>−</mo>${v(spillsUntil(s.t), 3)}<mo>=</mo>${v(s.V.value, 3)}<mtext> L</mtext></math>`;
  const hMl = `<math><mi>h</mi><mo>=</mo><mfrac><mi>V</mi><mi>A</mi></mfrac><mo>=</mo><mfrac><mrow>${v(s.V.value, 3)}<mtext> L</mtext></mrow><mrow><mn>${nf(s.A, 3)}</mn><mtext> m²</mtext></mrow></mfrac><mo>=</mo><mn>${nf(s.h.value, 4)}</mn><mtext> m</mtext></math>`;
  const dhMl = `<math><mfrac><mrow><mi>d</mi><mi>h</mi></mrow><mrow><mi>d</mi><mi>t</mi></mrow></mfrac><mo>=</mo><mfrac><mi>q</mi><mi>A</mi></mfrac><mo>=</mo><mn>${nf(s.q / s.A * 100, 4)}</mn><mtext> cm/s</mtext></math>`;
  const how = s.V.kind === "interpolated" ? `interpolado entre ${nf(s.V.between[0], 2)} s e ${nf(s.V.between[1], 2)} s` : s.V.kind === "sample" ? "amostra exata" : "sem dado";
  $("equations").innerHTML = `<p>${qMl}</p><p>${vMl}</p><p>${hMl}</p><p>${dhMl} <span class="note">(vale fora das bordas e de mudanças de A)</span></p>`
    + `<p class="note">t = ${nf(s.t, 3)} s · ${how} · resíduo do balanço ${Number.isFinite(s.residual) ? s.residual.toExponential(1) : "—"} m³</p>`;
}
const small = (x) => (Math.abs(x) < 5e-5 ? x.toExponential(1) : nf(x, 4));
const spillsUntil = (t) => sim.events.filter((e) => e.kind === "spill" && e.tNs * 1e-9 <= t).reduce((sum, e) => sum + e.volume, 0);
function drawRiemann() {
  const r = g.get("riemann"), box = $("riemannResult");
  if (!r) { box.innerHTML = '<p class="note">Rode a simulação até b para comparar Riemann com ΔV.</p>'; return; }
  const names = { left: "esquerda", right: "direita", midpoint: "ponto médio", trapezoid: "trapézio" };
  box.innerHTML = `<h3>Entre a = ${nf(r.a, 2)} s e b = ${nf(r.b, 2)} s</h3>
    <p>Σ Riemann (${names[r.method]}, n = ${r.n}) = <strong>${L(r.sum, 4)} L</strong> <span class="badge numeric">aproximação</span></p>
    <p>∫ q dt da série gravada = <strong>${L(r.exact, 4)} L</strong> <span class="badge exact">exata sobre os dados</span></p>
    <p>V(b) − V(a) medido = <strong>${L(r.dV, 4)} L</strong>${r.spills > 0 ? ` = ∫ q − derramamentos (${L(r.spills, 3)} L)` : ""}</p>
    <p class="note">erro de Riemann: ${small((r.sum - r.exact) / LITER)} L · fechamento do balanço: ${((r.exact - r.spills - r.dV) / LITER).toExponential(1)} L</p>`;
}
function drawEvents() {
  const ul = $("eventsList"); ul.textContent = "";
  for (const e of g.get("events").slice(-6)) { const li = document.createElement("li"); li.textContent = describeEvent(e); ul.appendChild(li); }
}
function drawStatus() {
  const st = g.get("status"), live = g.get("cursor") === null;
  $("status").textContent = `${{ stopped: "Configuração", running: `Executando ${speed}×`, paused: "Pausado" }[st]} · t = ${nf(g.get("now"), 2)} s`;
  $("modeBadge").textContent = live ? "ao vivo" : "inspeção (passado)";
  $("modeBadge").className = `badge ${live ? "exact" : "numeric"}`;
  for (const id of ["mode", "V0", "hMax"]) { $(id).disabled = st !== "stopped"; $(id).title = st !== "stopped" ? "stop-required: use Reiniciar para alterar" : ""; }
}

// ------------------------------------------------------------------ controles do modelo (escrevem no "Core")
const sliders = { qIn: [LITER, "qInOut", " L/s"], qOut: [LITER, "qOutOut", " L/s"], k: [LITER, "kOut", " L/(s·m)"], A: [1, "AOut", " m²"] };
function showSlider(name) { const [, out, unit] = sliders[name]; $(out).textContent = `${nf(Number($(name).value), 3)}${unit}`; }
for (const [name, [scale]] of Object.entries(sliders)) {
  showSlider(name);
  $(name).addEventListener("input", () => {
    markInput(); showSlider(name);
    try { sim.setParameter(name, Number($(name).value) * scale); $("paramError").textContent = ""; } catch (e) { $("paramError").textContent = e.message; }
    if (sim.status !== "running") g.set("rev", sim.rec.revision);
  });
}
function configChange(name, value) {
  if (sim.status !== "stopped") { // recusa e volta a mostrar o valor vigente
    $("paramError").textContent = `${name} é stop-required: use Reiniciar.`;
    $(name).value = name === "mode" ? authored.mode : String(name === "V0" ? authored.V0 / LITER : authored.hMax);
    return;
  }
  authored[name] = value; sim.setParameter(name, value); $("paramError").textContent = ""; g.set("rev", sim.rec.revision);
  $("qOutLabel").hidden = authored.mode !== "pump"; $("kLabel").hidden = authored.mode !== "valve";
}
$("mode").addEventListener("change", (e) => configChange("mode", e.target.value));
$("V0").addEventListener("change", (e) => configChange("V0", Number(e.target.value) * LITER));
$("hMax").addEventListener("change", (e) => configChange("hMax", Number(e.target.value)));

// ------------------------------------------------------------------ execução
const run = $("runBar");
const buttons = [
  [iconButton("play", "Executar / retomar", { id: "play" }), () => { if (sim.status === "stopped") sim.start(); else sim.resume(); }],
  [iconButton("pause", "Pausar", { id: "pause" }), () => sim.pause()],
  [iconButton("restart", "Reiniciar (volta ao estado inicial autorado)", { id: "restart" }), () => {
    sim.restart({ ...authored });
    for (const name of Object.keys(sliders)) { $(name).value = String(name === "A" ? authored.A : authored[name] / LITER); showSlider(name); }
    g.batch(() => { g.set("cursor", null); g.set("rev", sim.rec.revision); });
  }],
  [iconButton("live", "Voltar ao vivo", { id: "live" }), () => g.set("cursor", null)],
];
for (const [b, act] of buttons) { b.addEventListener("click", () => { act(); g.set("status", sim.status); }); run.appendChild(b); }
const speedSel = document.createElement("select");
speedSel.id = "speed"; speedSel.setAttribute("aria-label", "Ritmo da simulação");
for (const s of [1, 5, 20, 100]) speedSel.add(new Option(`${s}×`, String(s), s === speed, s === speed));
speedSel.addEventListener("change", () => { speed = Number(speedSel.value); dirty.add("statusText"); requestFrame(); });
run.appendChild(speedSel);

let last = performance.now(), carry = 0;
function tick(now) {
  const dtWall = Math.min(0.1, (now - last) / 1000); last = now;
  if (sim.status === "running") {
    carry += dtWall * speed;
    const n = Math.floor(carry / 0.01);
    if (n > 0) { carry -= n * 0.01; sim.advance(Math.min(n, 20000)); g.set("rev", sim.rec.revision); }
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ------------------------------------------------------------------ inspeção (só lê séries)
$("method").addEventListener("change", (e) => { markInput(); g.set("method", e.target.value); });
$("n").addEventListener("input", (e) => { markInput(); $("nOut").textContent = e.target.value; g.set("n", Number(e.target.value)); });
let drag = null;
for (const id of ["chartH", "chartQ"]) {
  const svg = $(id);
  const tFrom = (ev) => { const r = svg.getBoundingClientRect(); return axes("h").tAt(((ev.clientX - r.left) / r.width) * GEO.W); };
  svg.addEventListener("pointerdown", (ev) => {
    const handle = ev.target.getAttribute?.("data-handle");
    drag = handle ?? "cursor";
    svg.setPointerCapture(ev.pointerId);
    markInput();
    const t = Math.max(0, Math.min(g.get("now"), tFrom(ev)));
    g.set(drag, t);
  });
  svg.addEventListener("pointermove", (ev) => { if (!drag) return; markInput(); g.set(drag, Math.max(0, Math.min(g.get("now"), tFrom(ev)))); });
  svg.addEventListener("pointerup", () => { drag = null; });
}
$("chartH").addEventListener("keydown", (e) => {
  const step = e.shiftKey ? 0.1 : 1, t = g.get("inspectT");
  if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); markInput(); g.set("cursor", Math.max(0, Math.min(g.get("now"), t + (e.key === "ArrowRight" ? step : -step)))); }
  if (e.key === "Escape") g.set("cursor", null);
});

// Exposto apenas para o e2e da PoC.
window.__tank = {
  sim, g, stats, LITER,
  advance(seconds) { sim.advance(Math.round(seconds / 0.01)); g.set("rev", sim.rec.revision); },
  setSpeed(s) { speed = s; },
};
requestFrame();
