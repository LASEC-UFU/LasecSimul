// Ícones da biblioteca Signal Routing (docs/66). Desenho vetorial próprio, só com a referência
// visual dos ícones da documentação (barra do Mux/Demux, braço de chave do Switch/Multiport Switch,
// terminais da Manual Switch, mapeamento de elementos do Selector).
import {
  centered, evaluated, Geometry, glyph, GRID, IconTable, INK, PAPER, portY, propertyText, rectBody, SERIF, svgText,
} from "../symbolKit.js";

const bar = (g: Geometry) => `<rect x="0" y="0" width="${g.width}" height="${g.height}" fill="${INK}" stroke="${INK}" stroke-width="1"/>`;
const dot = (x: number, y: number, r: number, filled = false) =>
  `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${r}" fill="${filled ? INK : PAPER}" stroke="${INK}" stroke-width="1"/>`;
const square = (x: number, y: number, s: number, filled = true) =>
  `<rect x="${(x - s / 2).toFixed(2)}" y="${(y - s / 2).toFixed(2)}" width="${s}" height="${s}" fill="${filled ? INK : PAPER}" stroke="${INK}" stroke-width="1"/>`;

/** Mux/Demux: barra preta (bar), caixa com o nome (none) ou caixa com os nomes dos sinais (signals). */
function muxLike(name: string) {
  return (g: Geometry): string => {
    const option = String(g.props.DisplayOption ?? "bar");
    if (option === "bar") return bar(g);
    if (option === "signals") {
      const size = Math.min(8, g.height / Math.max(1, g.inputs.length) * 0.6);
      return rectBody(g) + g.inputs.map((_, index) => svgText(2, portY(g.height, index, g.inputs.length), `signal${index + 1}`, { size, anchor: "start" })).join("");
    }
    return rectBody(g) + centered(g, name, name, { size: Math.min(11, g.height * 0.3) });
  };
}

/** Texto do critério do Switch como no ícone: `> 0`, `>= 0`, `~= 0`. */
function switchCriterion(g: Geometry): string {
  const criteria = String(g.props.Criteria ?? "u2 > Threshold");
  if (criteria === "u2 ~= 0") return "~= 0";
  const threshold = propertyText(g.props.Threshold).trim() || "0";
  const shown = threshold.length > 6 ? "Th" : threshold;
  return `${criteria === "u2 >= Threshold" ? ">=" : ">"} ${shown}`;
}

function switchIcon(g: Geometry): string {
  const w = g.width, h = g.height;
  const y1 = portY(h, 0, 3), y2 = portY(h, 1, 3), y3 = portY(h, 2, 3);
  const cx = w * 0.45, r = Math.max(1.6, h * 0.035), size = Math.min(13, h * 0.22);
  const lines = glyph(`M 0 ${y1} H ${cx - r} M 0 ${y3} H ${cx - r} M 0 ${y2} H ${w * 0.16} M ${w * 0.16} ${y2 - h * 0.09} V ${y2 + h * 0.09}`, GRID, 1) +
    glyph(`M ${cx + r * 0.7} ${y1 + r * 0.7} L ${w * 0.75} ${y2} H ${w}`, INK, 1);
  return rectBody(g) + lines + dot(cx, y1, r) + dot(cx, y3, r) +
    svgText(w * 0.22, y2, switchCriterion(g), { size, anchor: "start" }) +
    svgText(cx + r + 2, y1 - size * 0.15, "T", { size, anchor: "start" }) + svgText(cx + r + 2, y3, "F", { size, anchor: "start" });
}

/** Índices das portas de dados como o ícone mostra (contíguos 0/1-based ou a lista dada). */
function dataPortLabels(g: Geometry, count: number): string[] {
  const order = String(g.props.DataPortOrder ?? "One-based contiguous");
  if (order === "Specify indices") {
    const text = propertyText(g.props.DataPortIndices).trim();
    const inner = text.startsWith("{") && text.endsWith("}") ? text.slice(1, -1) : text.replace(/^\[|\]$/g, "");
    const parts = inner.split(/[,\s]+/).filter((part) => part.length > 0);
    return Array.from({ length: count }, (_, i) => parts[i] ?? "");
  }
  const base = order === "Zero-based contiguous" ? 0 : 1;
  return Array.from({ length: count }, (_, i) => String(base + i));
}

function multiportSwitch(g: Geometry): string {
  const w = g.width, h = g.height;
  const total = g.inputs.length;
  const additional = g.inputs.some((port) => port.id === "default");
  const dataCount = total - 1 - (additional ? 1 : 0);
  const labels = dataPortLabels(g, dataCount);
  const yc = portY(h, 0, total);
  const size = Math.min(12, h / Math.max(2, total) * 0.5);
  const s = Math.max(3, Math.min(6, h * 0.06));
  const sx = w * 0.4;
  const parts: string[] = [rectBody(g), glyph(`M 0 ${yc} H ${w * 0.3} M ${w * 0.3} ${yc - h * 0.05} V ${yc + h * 0.06}`, INK, 1.2)];
  if (dataCount === 1 && !additional) {
    // Index Vector: um único vetor de dados; o braço sobe até a saída.
    const yd = portY(h, 1, total), yo = h * 0.45;
    parts.push(glyph(`M 0 ${yd} H ${sx}`, GRID, 1.6), square(sx, yd, s, true), glyph(`M ${sx} ${yd} L ${w * 0.78} ${yo} H ${w}`, INK, 1));
    parts.push(svgText(3, (yc + yd) / 2, labels[0] ?? "0", { size, anchor: "start" }));
    return parts.join("");
  }
  for (let i = 0; i < total - 1; ++i) {
    const y = portY(h, i + 1, total);
    parts.push(glyph(`M 0 ${y} H ${sx}`, GRID, 1.6), square(sx, y, s, true));
    const isDefault = additional ? i === total - 2 : i === dataCount - 1;
    const label = additional && i === total - 2 ? "" : `${isDefault ? "*," : ""}${labels[i] ?? ""}`;
    if (label) parts.push(svgText(3, y - (h / total) * 0.42, label, { size, anchor: "start" }));
  }
  const yFirst = portY(h, 1, total), yo = h / 2;
  parts.push(glyph(`M ${sx} ${yFirst} L ${w * 0.75} ${yo} H ${w}`, INK, 1));
  return parts.join("");
}

function manualSwitch(g: Geometry): string {
  const w = g.width, h = g.height;
  const y1 = portY(h, 0, 2), y2 = portY(h, 1, 2), yo = h / 2;
  const r = Math.max(1.8, h * 0.05);
  const xi = w * 0.25, xo = w * 0.62;
  const selected = propertyText(g.props.sw).trim() === "0" ? y2 : y1;
  return glyph(`M 0 ${y1} H ${xi - r} M 0 ${y2} H ${xi - r} M ${xo + r} ${yo} H ${w}`, INK, 1) +
    glyph(`M ${xi} ${selected} L ${xo} ${yo}`, INK, 1.2) + dot(xi, y1, r) + dot(xi, y2, r) + dot(xo, yo, r);
}

/** Selector: elementos da entrada à esquerda (cheios = selecionados), da saída à direita, ligados
 * pelo mapeamento dos índices (Index vector (dialog)); nos demais modos, mapeamento genérico. */
function selector(g: Geometry): string {
  const w = g.width, h = g.height;
  const option = String(g.props.IndexOptions ?? "Index vector (dialog)");
  const declared = evaluated(g, "InputPortWidth")?.data[0];
  const inputCount = declared !== undefined && Number.isInteger(declared) && declared >= 1 && declared <= 8 ? declared : 3;
  const base = g.props.IndexMode === "Zero-based" ? 0 : 1;
  let map: number[] = [];
  if (option === "Index vector (dialog)") {
    const indices = evaluated(g, "Indices")?.data ?? [];
    map = indices.map((index) => index - base).filter((index) => Number.isInteger(index) && index >= 0 && index < inputCount).slice(0, 8);
  } else if (option === "Select all") {
    map = Array.from({ length: inputCount }, (_, i) => i);
  } else {
    map = [0, inputCount - 1].filter((v, i, all) => all.indexOf(v) === i);
  }
  const s = Math.max(3, Math.min(7, h / (2.2 * Math.max(inputCount, map.length, 1))));
  const left = w * 0.18, right = w * 0.82;
  const yIn = (i: number) => h * (0.15 + (0.7 * (i + 0.5)) / inputCount);
  const yOut = (j: number) => h * (0.15 + (0.7 * (j + 0.5)) / Math.max(1, map.length));
  const parts: string[] = [rectBody(g)];
  for (let i = 0; i < inputCount; ++i) parts.push(square(left, yIn(i), s, map.includes(i)));
  map.forEach((i, j) => {
    parts.push(glyph(`M ${left} ${yIn(i)} L ${right} ${yOut(j)}`, INK, 1));
    parts.push(square(right, yOut(j), s, true));
  });
  return parts.join("");
}

export const routingIcons: IconTable = {
  mux: muxLike("Mux"),
  demux: muxLike("Demux"),
  switch: switchIcon,
  multiport_switch: multiportSwitch,
  manual_switch: manualSwitch,
  selector,
  merge: (g) => rectBody(g) + centered(g, "merge", "merge", { family: SERIF, size: Math.min(15, g.height * 0.35) }),
  environment_controller: (g) => rectBody(g),
};
