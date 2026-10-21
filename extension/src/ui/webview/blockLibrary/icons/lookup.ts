// Ícones da biblioteca Lookup Tables (docs/66). Desenho vetorial próprio: título `N-D T(u)` /
// `T(k,f)` / `T[k]` com o número de dimensões da instância, curvas de tabela e grade de índices.
import { evaluated, Geometry, glyph, GRID, IconTable, INK, PAPER, portY, rectBody, relativePath, svgText } from "../symbolKit.js";

/** Número de dimensões da instância (texto do parâmetro quando não é número). */
function dimensions(g: Geometry): string {
  const value = evaluated(g, "NumberOfTableDimensions");
  return value && value.data.length === 1 && Number.isInteger(value.data[0]) ? String(value.data[0]) : "n";
}

function title(g: Geometry, text: string, x = 0.58): string {
  return svgText(g.width * x, g.height * 0.13, text, { size: Math.min(12, g.height * 0.2) });
}

/** Rótulos u1..uN das entradas de coordenada (portas da regra de repetição, sem rótulo próprio). */
function coordinateLabels(g: Geometry): string {
  if (g.props.UseOneInputPortForAllInputData === true) return "";
  const coordinates = g.inputs.filter((port) => /^in\d+$/.test(port.id) && !port.label);
  if (coordinates.length < 2) return "";
  return coordinates.map((port) => {
    const index = g.inputs.indexOf(port);
    return svgText(3, portY(g.height, index, g.inputs.length), `u${port.id.slice(2)}`, { size: Math.min(10, g.height * 0.16), anchor: "start" });
  }).join("");
}

/** Leque de retas (tabela 2-D) a partir de um vértice comum. */
function fan(g: Geometry, x0: number, ends: number[]): string {
  return ends.map((y) => glyph(relativePath(g, [[x0, 0.86], [x0 + 0.22, 0.42], [0.92, y]]), INK, 1.2)).join("");
}

function lookupNd(g: Geometry): string {
  const n = dimensions(g);
  const labelled = g.inputs.some((port) => port.label) || (n !== "1" && g.props.UseOneInputPortForAllInputData !== true);
  const x0 = labelled ? 0.3 : 0.14;
  const axes = glyph(relativePath(g, [[x0, 0.24], [x0, 0.88], [0.94, 0.88]]), GRID, 1);
  let plot: string;
  if (n === "1") {
    const points: Array<[number, number]> = [];
    for (let i = 0; i <= 20; i++) {
      const s = i / 20;
      points.push([x0 + s * (0.86 - x0), 0.86 - 0.54 / (1 + Math.exp(-12 * (s - 0.45)))]);
    }
    plot = glyph(relativePath(g, points), INK, 1.3);
  } else if (n === "2") {
    plot = fan(g, x0 + 0.02, [0.3, 0.42, 0.62]);
  } else {
    const page = (dx: number, dy: number) =>
      `<rect x="${g.width * (x0 + 0.06 + dx)}" y="${g.height * (0.34 - dy)}" width="${g.width * (0.56 - x0 * 0.4)}" height="${g.height * 0.52}" fill="${PAPER}" stroke="${GRID}" stroke-width="1"/>`;
    plot = page(0.08, 0.08) + page(0.04, 0.04) + page(0, 0) + fan(g, x0 + 0.02, [0.36, 0.46, 0.6]);
  }
  return rectBody(g) + title(g, `${n}-D T(u)`) + axes + plot + coordinateLabels(g);
}

function prelookup(g: Geometry): string {
  const w = g.width, h = g.height;
  const dot = (x: number) => `<circle cx="${w * x}" cy="${h * 0.5}" r="${Math.max(1.6, w * 0.025)}" fill="${INK}"/>`;
  return rectBody(g) +
    glyph(relativePath(g, [[0.38, 0.22], [0.58, 0.22], [0.58, 0.48]]), GRID, 1) +
    glyph(relativePath(g, [[0.18, 0.5], [0.84, 0.5]]), INK, 1.2) + dot(0.38) + dot(0.7) + dot(0.8) +
    svgText(w * 0.38, h * 0.36, "k", { size: Math.min(11, h * 0.2), italic: true }) +
    svgText(w * 0.48, h * 0.7, "f", { size: Math.min(11, h * 0.2), italic: true }) +
    glyph(relativePath(g, [[0.3, 0.7], [0.4, 0.7]]) + " " + relativePath(g, [[0.56, 0.7], [0.66, 0.7]]), GRID, 1);
}

function interpolation(g: Geometry): string {
  const n = dimensions(g);
  const curves: string[] = [];
  for (let c = 0; c < 6; c++) {
    const top = 0.3 + c * 0.1;
    const points: Array<[number, number]> = [];
    for (let i = 0; i <= 12; i++) {
      const s = i / 12;
      points.push([0.38 + s * 0.56, 0.88 - (0.88 - top) * Math.sqrt(s)]);
    }
    curves.push(glyph(relativePath(g, points), INK, 1));
  }
  return rectBody(g) + title(g, `${n}-D T(k,f)`, 0.62) + glyph(relativePath(g, [[0.36, 0.24], [0.36, 0.9], [0.94, 0.9]]), GRID, 1) + curves.join("");
}

function direct(g: Geometry): string {
  const n = dimensions(g);
  const w = g.width, h = g.height;
  const x = 0.2, y = 0.3, size = 0.6, cell = size / 3;
  const grid: string[] = [];
  for (let i = 0; i <= 3; i++) {
    grid.push(`M ${w * (x + i * cell)} ${h * y} V ${h * (y + size)}`, `M ${w * x} ${h * (y + i * cell)} H ${w * (x + size)}`);
  }
  const highlight = `<rect x="${w * (x + cell)}" y="${h * (y + cell)}" width="${w * cell}" height="${h * cell}" fill="#c8c8c8" stroke="none"/>`;
  const depth = n !== "1" && n !== "2"
    ? glyph(`M ${w * x} ${h * y} L ${w * (x + 0.12)} ${h * (y - 0.1)} H ${w * (x + size + 0.12)} V ${h * (y + size - 0.1)} L ${w * (x + size)} ${h * (y + size)} M ${w * (x + size)} ${h * y} L ${w * (x + size + 0.12)} ${h * (y - 0.1)}`, INK, 1)
    : "";
  return rectBody(g) + title(g, `${n}-D T[k]`, 0.5) + highlight + glyph(grid.join(" "), INK, 1) + depth;
}

export const lookupIcons: IconTable = {
  lookup_nd: lookupNd,
  prelookup,
  interpolation_using_prelookup: interpolation,
  direct_lookup_nd: direct,
  lookup_table_dynamic: (g) => rectBody(g),
};
