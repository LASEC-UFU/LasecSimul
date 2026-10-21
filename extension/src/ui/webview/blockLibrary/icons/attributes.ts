// Ícones da biblioteca Signal Attributes (docs/66). Desenho vetorial próprio, só com a referência
// visual dos ícones da documentação ([valor] do IC, "convert", "same DT", buffers da Rate
// Transition, régua da Unit Conversion, Ts*w do Weighted Sample Time...).
import {
  centered, Geometry, glyph, GRID, IconTable, INK, italic, PAPER, propertyText, rectBody, SANS, SERIF, sub, svgText, textWidth,
} from "../symbolKit.js";

/** Texto do parâmetro como digitado, ou o marcador quando longo demais para o corpo. */
function shown(g: Geometry, name: string, fallback: string, size: number, maxWidth: number): string {
  const text = propertyText(g.props[name]).trim();
  return text.length > 0 && textWidth(text, size) <= maxWidth ? text : fallback;
}

function ic(g: Geometry): string {
  const w = g.width, h = g.height;
  const size = Math.min(12, h * 0.26);
  const value = shown(g, "Value", "IC", size, w - 6);
  return rectBody(g) + glyph(`M 0 ${h / 2} H ${w}`, INK, 1) + svgText(w / 2, h * 0.3, `[${value}]`, { size });
}

function signalConversion(g: Geometry): string {
  const w = g.width, h = g.height;
  const s = Math.max(3, Math.min(w, h) * 0.16);
  const parts = [rectBody(g)];
  const lx = w * 0.22, rx = w * 0.72;
  for (let i = 0; i < 3; ++i) {
    const y = h * (0.22 + 0.28 * i);
    const ry = h / 2 + (i - 1) * s;
    parts.push(glyph(`M ${lx + s / 2} ${y} L ${rx - s / 2} ${ry}`, INK, 1));
    parts.push(`<rect x="${lx - s / 2}" y="${y - s / 2}" width="${s}" height="${s}" fill="${GRID}" stroke="${INK}" stroke-width="0.8"/>`);
    parts.push(`<rect x="${rx - s / 2}" y="${ry - s / 2}" width="${s}" height="${s}" fill="${GRID}" stroke="${INK}" stroke-width="0.8"/>`);
  }
  return parts.join("");
}

/** Rate Transition: buffer de origem e de destino com a transferência entre eles (setas cinza). */
function rateTransition(g: Geometry): string {
  const w = g.width, h = g.height;
  const bw = w * 0.24, bh = h * 0.16, by = h * 0.72;
  const buffer = (x: number) => {
    const cells = [1, 2, 3].map((k) => `M ${x + (bw * k) / 4} ${by} V ${by + bh}`).join(" ");
    return `<rect x="${x}" y="${by}" width="${bw}" height="${bh}" fill="${PAPER}" stroke="${INK}" stroke-width="1"/>` + glyph(cells, INK, 0.8);
  };
  const lx = w * 0.12, rx = w * 0.64;
  return rectBody(g) +
    `<rect x="${w * 0.36}" y="${h * 0.12}" width="${w * 0.28}" height="${h * 0.16}" fill="${PAPER}" stroke="${INK}" stroke-width="1"/>` +
    glyph(`M ${w * 0.12} ${h * 0.5} H ${w * 0.88}`, INK, 1) +
    glyph(`M ${lx + bw / 2} ${by} V ${h * 0.34} M ${lx + bw / 2 - 2.5} ${h * 0.38} L ${lx + bw / 2} ${h * 0.34} L ${lx + bw / 2 + 2.5} ${h * 0.38}`, GRID, 1) +
    glyph(`M ${rx + bw / 2} ${h * 0.34} V ${by - 2} M ${rx + bw / 2 - 2.5} ${by - 6} L ${rx + bw / 2} ${by - 2} L ${rx + bw / 2 + 2.5} ${by - 6}`, GRID, 1) +
    buffer(lx) + buffer(rx);
}

function probe(g: Geometry): string {
  const items: string[] = [];
  if (g.props.ProbeWidth !== false) items.push("W:0");
  if (g.props.ProbeSampleTime !== false) items.push("Ts:");
  if (g.props.ProbeComplexSignal !== false) items.push("C:0");
  if (g.props.ProbeSignalDimensions !== false) items.push("D:[0]");
  const text = items.join(", ");
  return rectBody(g) + (text ? centered(g, text, text, { size: Math.min(11, g.height * 0.3) }) : "");
}

/** Signal Specification: "inherit" com tudo herdado; senão os atributos especificados. */
function signalSpecification(g: Geometry): string {
  const parts: string[] = [];
  const type = propertyText(g.props.OutDataTypeStr).trim();
  if (type && !type.startsWith("Inherit")) parts.push(type);
  const dims = propertyText(g.props.Dimensions).trim();
  if (dims && dims !== "-1") parts.push(dims.startsWith("[") ? dims : `[${dims}]`);
  const unit = propertyText(g.props.Unit).trim();
  if (unit && unit !== "inherit") parts.push(unit);
  const text = parts.length > 0 ? parts.join(", ") : "inherit";
  return rectBody(g) + centered(g, text, text, { size: Math.min(12, g.height * 0.4) });
}

function unitConversion(g: Geometry): string {
  const w = g.width, h = g.height;
  const ticks: string[] = [];
  for (let k = 0; k <= 6; ++k) {
    const x = w * (0.1 + (0.8 * k) / 6);
    const long = k === 0 || k === 6;
    ticks.push(`M ${x} 0 V ${h * (long ? 0.32 : 0.18)} M ${x} ${h} V ${h * (long ? 0.68 : 0.82)}`);
  }
  return rectBody(g) + glyph(ticks.join(" "), INK, 1) +
    glyph(`M ${w * 0.44} ${h / 2} H ${w * 0.56} M ${w * 0.52} ${h / 2 - 2} L ${w * 0.56} ${h / 2} L ${w * 0.52} ${h / 2 + 2}`, INK, 1.2);
}

/** Weighted Sample Time: equação da operação (w omitido quando 1, como no Simulink). */
function weightedSampleTime(g: Geometry): string {
  const op = String(g.props.TsampMathOp ?? "Ts Only");
  const weight = propertyText(g.props.weightValue).trim();
  const unit = weight === "1" || weight === "1.0" || weight === "";
  const ts = `${italic("T")}${sub("s")}`;
  const weighted = unit ? ts : `${ts} * ${italic("w")}`;
  const weightedPlain = unit ? "Ts" : "Ts * w";
  const table: Record<string, [string, string]> = {
    "Ts Only": [weighted, weightedPlain],
    "1/Ts Only": [unit ? `1/${ts}` : `1/(${weighted})`, `1/(${weightedPlain})`],
    "+": [`${italic("u")} + ${weighted}`, `u + ${weightedPlain}`],
    "-": [`${italic("u")} - ${weighted}`, `u - ${weightedPlain}`],
    "*": [`${italic("u")} * ${weighted}`, `u * ${weightedPlain}`],
    "/": [`${italic("u")} / ${unit ? ts : `(${weighted})`}`, `u / (${weightedPlain})`],
  };
  const [markup, plain] = table[op] ?? table["Ts Only"]!;
  return rectBody(g) + centered(g, markup, plain, { family: SERIF, size: Math.min(20, g.height * 0.3) });
}

function width(g: Geometry): string {
  const w = g.width, h = g.height;
  const y = h * 0.62;
  return rectBody(g) + glyph(`M 0 ${y} H ${w}`, GRID, 1.4) + glyph(`M ${w * 0.4} ${y + h * 0.16} L ${w * 0.6} ${y - h * 0.16}`, INK, 1) +
    svgText(w / 2, h * 0.28, "-1", { size: Math.min(11, h * 0.36) });
}

const twoLines = (first: string, second: string, family = SANS, scale = 0.26, max = 13) => (g: Geometry) => {
  const size = Math.min(max, g.height * scale, (g.width - 6) / (Math.max(first.length, second.length) * (family === SERIF ? 0.5 : 0.56)));
  return rectBody(g) + svgText(g.width / 2, g.height * 0.32, first, { size, family }) + svgText(g.width / 2, g.height * 0.68, second, { size, family });
};

export const attributeIcons: IconTable = {
  ic,
  signal_conversion: signalConversion,
  data_type_conversion: (g) => rectBody(g) + centered(g, "convert", "convert", { family: SERIF, size: Math.min(15, g.height * 0.5) }),
  data_type_conversion_inherited: (g) => rectBody(g) + centered(g, "Convert", "Convert", { size: Math.min(12, g.height * 0.3) }),
  data_type_duplicate: twoLines("same", "DT", SERIF, 0.34, 30),
  data_type_propagation: (g) => rectBody(g),
  data_type_scaling_strip: twoLines("Scaling", "Strip"),
  probe,
  rate_transition: rateTransition,
  signal_specification: signalSpecification,
  unit_conversion: unitConversion,
  weighted_sample_time: weightedSampleTime,
  width,
};
