// PoC isolada (NÃO é produção). Interface da atividade de limites sobre o núcleo de engine.mjs.
// Demonstra: invalidação seletiva por dependência, desenho coalescido por requestAnimationFrame
// (como `Drawable.setNeedsUpdate` + `EuclidianViewW.doRepaint`), ponto restrito à curva
// (como `GeoFunction.pointChanged`: x do ponteiro, y = h(x), domínio limitado), transformação
// mundo<->tela (como `EuclidianView.toScreenCoordX/toRealWorldCoordX`) e inspeção sem escrita no Core.
import {
  parseExpression, compileExpression, toPolynomial, differenceQuotientPolynomial, formatPolynomial,
  differenceQuotient, DependencyGraph, sampleFunction, astToMathML, differentiate, simplify,
} from "./engine.mjs";
import { MathEditor } from "./editor.mjs";
import { mountPalette } from "./palette.mjs";
import { ICONS, iconButton } from "./icons.mjs";

const SVG = "http://www.w3.org/2000/svg";
const $ = (id) => document.getElementById(id);
const el = (name, attrs = {}, parent) => {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent?.appendChild(node);
  return node;
};
const fmt = (x, digits = 6) => (Number.isFinite(x) ? Number(x.toPrecision(Math.max(digits, 1))).toLocaleString("pt-BR", { maximumFractionDigits: 6 }) : "—");

// Ponte "Core" simulada: a inspeção NUNCA deve chamá-la. O e2e confere o contador.
const coreBridge = { writes: 0, setParameter() { this.writes++; } };

// ---------------------------------------------------------------- grafo da atividade
const graph = new DependencyGraph();
graph.source("expr", "0.5t^2", { kind: "authoring" });
graph.source("a", 4, { kind: "authoring" });
graph.source("domain", [0, 6], { kind: "authoring" });
graph.source("dt", 0.5, { kind: "inspection" });
graph.source("view", { xMin: -0.3, xMax: 6.6, yMin: -1.5, yMax: 22 }, { kind: "view" });

graph.derived("ast", ["expr"], (text) => parseExpression(text, ["t"]));
graph.derived("fn", ["ast"], (ast) => compileExpression(ast, ["t"]), { equals: Object.is });
graph.derived("poly", ["ast"], (ast) => toPolynomial(ast, "t") ?? null);
graph.derived("P", ["fn", "a"], (fn, a) => ({ t: a, h: fn.value([a]) }));
graph.derived("Q", ["fn", "a", "dt"], (fn, a, dt) => ({ t: a + dt, h: fn.value([a + dt]) }));
graph.derived("quotient", ["fn", "a", "dt"], (fn, a, dt) => differenceQuotient(fn, a, dt));
graph.derived("exactQuotient", ["poly", "a"], (poly, a) => (poly ? differenceQuotientPolynomial(poly, a) : null));
graph.derived("tableRows", ["fn", "a"], (fn, a) => [1, 0.1, 0.01].map((d) => ({ d, right: differenceQuotient(fn, a, d), left: differenceQuotient(fn, a, -d) })));
graph.derived("transform", ["view"], (v) => {
  const W = 600, H = 420, L = 48, R = 12, T = 12, B = 36;
  const sx = (W - L - R) / (v.xMax - v.xMin), sy = (H - T - B) / (v.yMax - v.yMin);
  return {
    v, W, H, L, R, T, B,
    toPx: (x, y) => [L + (x - v.xMin) * sx, H - B - (y - v.yMin) * sy],
    toWorldX: (px) => v.xMin + (px - L) / sx,
  };
}, { equals: Object.is });
graph.derived("curve", ["fn", "transform", "domain"], (fn, tr, [d0, d1]) => sampleFunction(fn, Math.max(d0, tr.v.xMin), Math.min(d1, tr.v.xMax), tr.toPx));

// Calculadora: depende do texto, do modelo h e de a; recalcula sozinha quando o modelo muda.
const CALC_START = "Limit(Δt, 0, 0, (h(4+Δt)-h(4))/Δt)";
graph.source("calcText", CALC_START, { kind: "inspection" });
graph.derived("calcResult", ["calcText", "ast", "a"], (text, modelAst, a) => {
  const functions = { h: { param: "t", ast: modelAst } };
  let ast;
  try { ast = parseExpression(text, [], { functions }); } catch (error) { return { kind: "error", reason: error.message }; }
  if (Array.isArray(ast) && ast[0] === "D") { // derivada no topo: mostra a função derivada e o valor em a
    const derivative = simplify(differentiate(ast[1], ast[2]));
    return { kind: "derivative", variable: ast[2], derivative, at: compileExpression(derivative, [ast[2]]).evaluate([a]), a };
  }
  return { kind: "value", result: compileExpression(ast, []).evaluate([]) };
});

// ---------------------------------------------------------------- desenháveis com invalidação seletiva
const stats = { renders: {}, latencies: [], frames: 0 };
const plot = $("plot");
const layers = Object.fromEntries(["axes", "curve", "tangent", "secant", "guides", "points"].map((id) => [id, el("g", { id: `layer-${id}` }, plot)]));
const tank = $("tank");

const drawables = [
  { id: "axes", inputs: ["transform"], draw: drawAxes },
  { id: "curve", inputs: ["curve", "transform"], draw: drawCurve },
  { id: "tangent", inputs: ["P", "exactQuotient", "transform"], draw: drawTangent },
  { id: "secant", inputs: ["P", "Q", "quotient", "transform"], draw: drawSecant },
  { id: "guides", inputs: ["P", "Q", "transform"], draw: drawGuides },
  { id: "points", inputs: ["P", "Q", "transform"], draw: drawPoints },
  { id: "table", inputs: ["tableRows", "dt", "quotient"], draw: drawTable },
  { id: "limit", inputs: ["exactQuotient", "quotient"], draw: drawLimit },
  { id: "equation", inputs: ["a", "dt", "quotient", "exactQuotient", "P", "Q"], draw: drawEquation },
  { id: "tank", inputs: ["Q", "view"], draw: drawTank },
  { id: "controls", inputs: ["dt"], draw: syncControls },
  { id: "calc", inputs: ["calcResult"], draw: drawCalc },
];
const dirty = new Set(drawables.map((d) => d.id));
let frameRequested = false;
let pendingInputAt;
graph.onChange((changed) => {
  for (const d of drawables) if (d.inputs.some((i) => changed.has(i))) dirty.add(d.id);
  requestFrame();
});
function requestFrame() {
  if (frameRequested) return;
  frameRequested = true;
  requestAnimationFrame(() => {
    frameRequested = false;
    stats.frames++;
    for (const d of drawables) {
      if (!dirty.has(d.id)) continue;
      d.draw(...d.inputs.map((i) => graph.get(i)));
      stats.renders[d.id] = (stats.renders[d.id] ?? 0) + 1;
    }
    dirty.clear();
    if (pendingInputAt !== undefined) { stats.latencies.push(performance.now() - pendingInputAt); pendingInputAt = undefined; }
  });
}
const markInput = () => { if (pendingInputAt === undefined) pendingInputAt = performance.now(); };

function clear(g) { while (g.firstChild) g.firstChild.remove(); }
function drawAxes(tr) {
  const g = layers.axes; clear(g);
  const [x0, y0] = tr.toPx(0, 0);
  el("line", { x1: tr.L, y1: y0, x2: tr.W - tr.R, y2: y0, stroke: "#334155" }, g);
  el("line", { x1: x0, y1: tr.T, x2: x0, y2: tr.H - tr.B, stroke: "#334155" }, g);
  for (let t = Math.ceil(tr.v.xMin); t <= tr.v.xMax; t++) {
    const [px] = tr.toPx(t, 0);
    el("line", { x1: px, y1: y0 - 4, x2: px, y2: y0 + 4, stroke: "#334155" }, g);
    el("text", { x: px, y: y0 + 18, "text-anchor": "middle", "font-size": 12, fill: "#334155" }, g).textContent = String(t);
  }
  const span = tr.v.yMax - tr.v.yMin, raw = span / 6, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((k) => k * mag).find((s) => s >= raw); // passo "redondo" com ~6 marcas
  for (let h = Math.ceil(tr.v.yMin / step) * step; h <= tr.v.yMax; h += step) {
    const [, py] = tr.toPx(0, h);
    el("text", { x: x0 - 8, y: py + 4, "text-anchor": "end", "font-size": 12, fill: "#334155" }, g).textContent = fmt(h, 4);
  }
  el("text", { x: tr.W - tr.R, y: y0 - 8, "text-anchor": "end", "font-size": 13, fill: "#0f172a" }, g).textContent = "t (s)";
  el("text", { x: x0 + 6, y: tr.T + 12, "font-size": 13, fill: "#0f172a" }, g).textContent = "h (cm)";
}
function drawCurve(segments) {
  const g = layers.curve; clear(g);
  const tr = graph.get("transform");
  for (const seg of segments) {
    const d = seg.map(([x, y], i) => { const [px, py] = tr.toPx(x, y); return `${i ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)}`; }).join("");
    el("path", { d, fill: "none", stroke: "#2563eb", "stroke-width": 2.5 }, g);
  }
}
function lineThrough(tr, t0, h0, slope, attrs, g) {
  const xa = tr.v.xMin, xb = tr.v.xMax;
  const [p1x, p1y] = tr.toPx(xa, h0 + slope * (xa - t0));
  const [p2x, p2y] = tr.toPx(xb, h0 + slope * (xb - t0));
  el("line", { x1: p1x, y1: p1y, x2: p2x, y2: p2y, ...attrs }, g);
}
function drawTangent(P, exact, tr) {
  const g = layers.tangent; clear(g);
  if (!exact) return; // sem caminho exato, a PoC não desenha tangente (não finge)
  lineThrough(tr, P.t, P.h, exact[0], { stroke: "#0e7490", "stroke-width": 1.5, "stroke-dasharray": "2 4" }, g);
}
function drawSecant(P, Q, q, tr) {
  const g = layers.secant; clear(g);
  if (q.kind !== "finite") return;
  lineThrough(tr, P.t, P.h, q.value, { stroke: Q.t >= P.t ? "#c2410c" : "#1d4ed8", "stroke-width": 2, "stroke-dasharray": "8 5" }, g);
}
function drawGuides(P, Q, tr) {
  const g = layers.guides; clear(g);
  const [px, py] = tr.toPx(P.t, P.h), [qx, qy] = tr.toPx(Q.t, Q.h);
  el("line", { x1: px, y1: py, x2: qx, y2: py, stroke: "#64748b", "stroke-dasharray": "3 3" }, g);
  el("line", { x1: qx, y1: py, x2: qx, y2: qy, stroke: "#64748b", "stroke-dasharray": "3 3" }, g);
  el("text", { x: (px + qx) / 2, y: py + 16, "text-anchor": "middle", "font-size": 12, fill: "#334155" }, g).textContent = "Δt";
  el("text", { x: qx + 6, y: (py + qy) / 2, "font-size": 12, fill: "#334155" }, g).textContent = "Δh";
}
// Pontos são atualizados NO LUGAR (como um Drawable reaproveitado): o elemento focado continua
// focado durante teclado/arraste e não há recriação de nós DOM por quadro.
const points = (() => {
  const g = layers.points;
  const p = el("circle", { r: 6, fill: "#1e3a8a" }, g);
  const pLabel = el("text", { "text-anchor": "end", "font-size": 13, fill: "#1e3a8a" }, g);
  const q = el("circle", { r: 9, tabindex: 0, role: "slider", id: "qHandle", "aria-label": "Ponto Q sobre a curva", "aria-valuemin": 0, "aria-valuemax": 6 }, g);
  const qLabel = el("text", { "font-size": 13, fill: "#7c2d12" }, g);
  attachDrag(q);
  return { p, pLabel, q, qLabel };
})();
function drawPoints(P, Q, tr) {
  const [px, py] = tr.toPx(P.t, P.h), [qx, qy] = tr.toPx(Q.t, Q.h);
  points.p.setAttribute("cx", px); points.p.setAttribute("cy", py);
  points.pLabel.setAttribute("x", px - 10); points.pLabel.setAttribute("y", py - 10);
  points.pLabel.textContent = `P(${fmt(P.t)}; ${fmt(P.h)})`;
  points.q.setAttribute("cx", qx); points.q.setAttribute("cy", qy);
  points.q.setAttribute("fill", Q.t >= P.t ? "#c2410c" : "#1d4ed8");
  points.q.setAttribute("aria-valuenow", Q.t.toFixed(3));
  points.q.setAttribute("aria-valuetext", `Q em t = ${fmt(Q.t)} s, h = ${fmt(Q.h)} cm`);
  points.qLabel.setAttribute("x", qx + 12); points.qLabel.setAttribute("y", qy - 10);
  points.qLabel.textContent = `Q(${fmt(Q.t)}; ${fmt(Q.h)})`;
}
function cellValue(r) { return r.kind === "finite" ? fmt(r.value, 6) : "indefinido"; }
function drawTable(rows, dt, q) {
  const body = $("tableBody"); body.textContent = "";
  const add = (label, right, left, current) => {
    const tr = document.createElement("tr"); if (current) tr.className = "current";
    for (const [text, cls] of [[label, ""], [right, "right"], [left, "left"]]) { const td = document.createElement("td"); td.textContent = text; if (cls) td.className = cls; tr.appendChild(td); }
    body.appendChild(tr);
  };
  for (const r of rows) add(fmt(r.d), cellValue(r.right), cellValue(r.left), false);
  const side = dt > 0 ? "right" : dt < 0 ? "left" : "none";
  add(`atual: ${fmt(Math.abs(dt))}`, side === "right" ? cellValue(q) : "", side === "left" ? cellValue(q) : "", true);
}
function drawLimit(exact, q) {
  $("limit").innerHTML = "";
  const big = document.createElement("span"); big.textContent = exact ? `→ ${fmt(exact[0])} cm/s ←` : "sem forma exata";
  const small = document.createElement("small");
  small.textContent = exact ? "limite exato: termo constante de [h(4+Δt)−h(4)]/Δt (h é polinomial)" : "apenas evidência numérica — não é demonstração";
  $("limit").append(big, small);
  $("warning").textContent = q.kind === "undefined" ? `⚠ ${q.reason}. O quociente não existe; o limite é outro objeto.`
    : q.kind === "precision-limit" ? `⚠ ${q.reason}.` : q.warning ? `⚠ ${q.warning}.` : "";
}
function drawEquation(a, dt, q, exact, P, Q) {
  const exactText = exact ? `= ${formatPolynomial(exact, "Δt")} (Δt ≠ 0)` : "";
  const valueText = q.kind === "finite" ? ` = ${fmt(q.value, 6)} cm/s` : " — indefinido";
  $("equation").textContent = `Δh/Δt = [h(${fmt(a)}+Δt) − h(${fmt(a)})]/Δt ${exactText}; com Δt = ${fmt(dt)}: (${fmt(Q.h)} − ${fmt(P.h)})/${fmt(dt)}${valueText}`;
}
function drawTank(Q, view) {
  clear(tank);
  const hMax = Math.max(1e-9, view.yMax), level = Math.max(0, Math.min(1, Q.h / hMax)); // altura do desenho = topo da vista
  el("rect", { x: 40, y: 20, width: 120, height: 260, rx: 8, fill: "none", stroke: "#94a3b8", "stroke-width": 3 }, tank);
  el("rect", { x: 43, y: 20 + 260 * (1 - level), width: 114, height: 260 * level, fill: "#38bdf8", opacity: 0.8 }, tank);
  el("text", { x: 100, y: 305, "text-anchor": "middle", "font-size": 14, fill: "#e2e8f0" }, tank).textContent = `h(${fmt(Q.t)}) = ${fmt(Q.h)} cm`;
  $("tankLabel").textContent = "Reconstrução pelo modelo no instante de Q (inspeção, não estado do simulador).";
}
function syncControls(dt) {
  const mag = Math.abs(dt);
  const slider = $("dtSlider"), input = $("dtInput");
  if (mag > 0 && document.activeElement !== slider) slider.value = String(Math.log10(Math.min(1, Math.max(1e-3, mag))));
  if (document.activeElement !== input) input.value = String(Number(mag.toPrecision(6)));
  for (const r of document.querySelectorAll("input[name=side]")) if (dt !== 0) r.checked = Number(r.value) === Math.sign(dt);
  $("dtValue").textContent = `Δt = ${fmt(dt, 6)} s (${dt > 0 ? "pela direita" : dt < 0 ? "pela esquerda" : "Q sobre P"})`;
}

function badge(r) {
  const exact = r.exact ? "exato" : "aproximação numérica";
  return `<span class="badge ${r.exact ? "exact" : "numeric"}">${exact}</span> <span class="method">${(r.methods ?? []).join("; ")}</span>`;
}
function drawCalc(res) {
  const box = $("calcResult");
  if (res.kind === "error") { box.innerHTML = ""; const p = document.createElement("p"); p.className = "error"; p.textContent = calcEditor?.emptyFields() ? `Complete ${calcEditor.emptyFields()} campo(s) vazio(s).` : res.reason; box.append(p); return; }
  if (res.kind === "derivative") {
    const v = res.variable;
    box.innerHTML = `<p><math><mrow><mfrac><mi>d</mi><mrow><mi>d</mi><mi>${v}</mi></mrow></mfrac><mo>=</mo></mrow></math> ${astToMathML(res.derivative)} <span class="badge exact">exata</span> <span class="method">derivada simbólica (regras)</span></p>`
      + `<p>em ${v} = ${fmt(res.a)}: <strong>${res.at.kind === "finite" ? fmt(res.at.value) : "indefinida"}</strong>${res.at.kind === "finite" ? "" : " — " + res.at.reason}</p>`;
    return;
  }
  const r = res.result;
  box.innerHTML = r.kind === "finite"
    ? `<p class="calc-value">= <strong>${Number(r.value.toPrecision(10)).toLocaleString("pt-BR", { maximumFractionDigits: 10 })}</strong> ${badge(r)}</p>`
    : `<p class="calc-value">não existe / indefinido ${badge({ exact: !r.methods?.some((m) => m.startsWith("evidência")), methods: r.methods })}</p><p class="note">${r.reason}</p>`;
}

// ---------------------------------------------------------------- interação
const sideSign = () => Number(document.querySelector("input[name=side]:checked").value);
function setDt(dt) { markInput(); graph.set("dt", dt); }
function svgPointX(event) {
  const rect = plot.getBoundingClientRect();
  return ((event.clientX - rect.left) / rect.width) * 600;
}
let dragging = false;
function attachDrag(handle) {
  handle.addEventListener("pointerdown", (e) => { dragging = true; plot.setPointerCapture(e.pointerId); e.preventDefault(); });
  handle.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 0.001 : 0.05, dt = graph.get("dt");
    const map = { ArrowRight: dt + step, ArrowUp: dt + step, ArrowLeft: dt - step, ArrowDown: dt - step, Home: -graph.get("a"), End: 2 };
    if (!(e.key in map)) return;
    e.preventDefault();
    setDt(Number(map[e.key].toFixed(6)));
  });
}
plot.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const tr = graph.get("transform"), [d0, d1] = graph.get("domain");
  const t = Math.min(d1, Math.max(d0, tr.toWorldX(svgPointX(e)))); // restrição ao domínio, como GeoFunction.pointChanged
  setDt(t - graph.get("a"));
});
plot.addEventListener("pointerup", () => { dragging = false; });
plot.addEventListener("wheel", (e) => { // zoom com o tempo sob o cursor invariável
  e.preventDefault();
  const tr = graph.get("transform"), v = tr.v, x = tr.toWorldX(svgPointX(e)), k = e.deltaY < 0 ? 0.8 : 1.25;
  graph.set("view", { ...v, xMin: x - (x - v.xMin) * k, xMax: x + (v.xMax - x) * k });
}, { passive: false });
$("dtSlider").addEventListener("input", (e) => setDt(sideSign() * 10 ** Number(e.target.value)));
$("dtInput").addEventListener("change", (e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v >= 0) setDt(sideSign() * v); });
for (const r of document.querySelectorAll("input[name=side]")) r.addEventListener("change", () => setDt(sideSign() * (Math.abs(graph.get("dt")) || 0.5)));
// Barra de ferramentas com ícones próprios.
let authoringView = { xMin: -0.3, xMax: 6.6, yMin: -1.5, yMax: 22 };
const toolbar = $("toolbar");
const zoom = (k) => { const v = graph.get("view"), c = (v.xMin + v.xMax) / 2; graph.set("view", { ...v, xMin: c - (c - v.xMin) * k, xMax: c + (v.xMax - c) * k }); };
const tools = [
  [iconButton("zoomIn", "Aproximar (zoom +)"), () => zoom(0.8)],
  [iconButton("zoomOut", "Afastar (zoom −)"), () => zoom(1.25)],
  [iconButton("resetView", "Restaurar vista", { id: "resetView" }), () => graph.set("view", authoringView)],
  [iconButton("deltaZero", "Δt = 0 (Q sobre P)", { id: "zeroBtn" }), () => setDt(0)],
  [iconButton("keyboard", "Mostrar/ocultar teclado matemático", { id: "kbdBtn", pressed: true }), (b) => { const hidden = $("palette").toggleAttribute("hidden"); b.setAttribute("aria-pressed", String(!hidden)); }],
];
for (const [button, action] of tools) { button.addEventListener("click", () => action(button)); toolbar.appendChild(button); }
$("iconRight").innerHTML = ICONS.sideRight;
$("iconLeft").innerHTML = ICONS.sideLeft;

// Editores de equação (implementação própria) e teclado compartilhado.
function fitView(fn) {
  const [d0, d1] = graph.get("domain");
  let lo = 0, hi = 1;
  for (let i = 0; i <= 200; i++) { const y = fn.value([d0 + ((d1 - d0) * i) / 200]); if (Number.isFinite(y)) { lo = Math.min(lo, y); hi = Math.max(hi, y); } }
  const pad = (hi - lo) * 0.08 || 1;
  return { xMin: d0 - 0.3, xMax: d1 + 0.6, yMin: lo - pad, yMax: hi + pad };
}
const modelEditor = new MathEditor($("modelEditor"), {
  variable: "t", label: "Modelo h de t",
  onChange(text) {
    try {
      const ast = parseExpression(text, ["t"]);
      const fn = compileExpression(ast, ["t"]);
      $("modelError").textContent = "";
      markInput();
      graph.batch(() => { graph.set("expr", text); authoringView = fitView(fn); graph.set("view", authoringView); });
    } catch (error) {
      const empty = modelEditor?.emptyFields();
      $("modelError").textContent = empty ? `Complete ${empty} campo(s) vazio(s).` : error.message;
    }
  },
});
modelEditor.setAst(graph.get("ast"));
const calcEditor = new MathEditor($("calcEditor"), { variable: "x", label: "Calculadora", onChange: (text) => { markInput(); graph.set("calcText", text); } });
const loadCalc = (text) => calcEditor.setAst(parseExpression(text, [], { keepCalls: true, functions: { h: { param: "t", ast: graph.get("ast") } } }));
loadCalc(CALC_START);
let activeEditor = modelEditor;
for (const ed of [modelEditor, calcEditor]) ed.host.addEventListener("focusin", () => { activeEditor = ed; });
mountPalette($("palette"), () => activeEditor, "t");
const EXAMPLES = [
  ["quociente → 4", CALC_START],
  ["∫₀⁴ h", "Integrate(t, 0, 4, h(t))"],
  ["d/dt h", "D(t, h(t))"],
  ["Σ Riemann (n = 8)", "Sum(k, 0, 7, h(k/2)*0.5)"],
  ["lim sen x / x", "Limit(x, 0, 0, sin(x)/x)"],
  ["lim |x| / x", "Limit(x, 0, 0, abs(x)/x)"],
  ["lim 1/x (x→0⁺)", "Limit(x, 0, 1, 1/x)"],
];
for (const [label, text] of EXAMPLES) {
  const b = document.createElement("button"); b.type = "button"; b.textContent = label;
  b.addEventListener("click", () => loadCalc(text));
  $("examples").appendChild(b);
}

// Exposto apenas para o e2e da PoC.
window.__poc = { graph, stats, coreBridge, setDt, computeCount: (id) => graph.computeCount(id), modelEditor, calcEditor, loadCalc };
requestFrame();
