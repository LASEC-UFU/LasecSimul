// Ícones da biblioteca Math Operations (docs/66). Desenho vetorial próprio, no arranjo dos ícones da
// documentação oficial (que servem só de referência visual).
import {
  centered, escapeXml, evaluated, Geometry, glyph, GRID, IconTable, INK, italic, PAPER, parameterLabel, portY, rectBody, roundPortAngles,
  SERIF, signList, sub, sup, svgText, fraction, propertyText,
} from "../symbolKit.js";
import { sineWave } from "./sources.js";

function gain(g: Geometry): string {
  const w = g.width, h = g.height;
  const value = parameterLabel(g, "Gain", "-K-", w * 0.55, 13);
  return `<polygon points="0,0 ${w},${h / 2} 0,${h}" fill="${PAPER}" stroke="${INK}" stroke-width="1"/>` +
    svgText(w * 0.32, h / 2, value, { size: Math.min(13, h * 0.32) });
}

function sum(g: Geometry): string {
  const w = g.width, h = g.height;
  const signs = signList(String(g.props.Inputs ?? ""), "+-");
  if (g.props.IconShape === "round") {
    const r = Math.min(w, h) / 2;
    const marks = roundPortAngles(String(g.props.Inputs ?? "")).map(({ angle, symbol }) => {
      const x = w / 2 + Math.cos(angle) * r * 0.55, y = h / 2 - Math.sin(angle) * r * 0.55;
      return svgText(x, y, symbol === "-" ? "−" : "+", { size: r * 0.85 });
    });
    return `<circle cx="${w / 2}" cy="${h / 2}" r="${r}" fill="${PAPER}" stroke="${INK}" stroke-width="1"/>` + marks.join("");
  }
  if (signs.length === 1) return rectBody(g) + centered(g, "Σ", "S", { size: h * 0.55 });
  const marks = g.inputs.map((_, index) => svgText(9, portY(h, index, g.inputs.length), signs[index] === "-" ? "−" : "+", { size: 14 }));
  return rectBody(g) + marks.join("");
}

function product(g: Geometry): string {
  const h = g.height;
  const ops = signList(String(g.props.Inputs ?? ""), "*/");
  if (ops.length === 1) return rectBody(g) + centered(g, "Π", "P", { size: h * 0.55 });
  if (!ops.includes("/")) return rectBody(g) + centered(g, "×", "x", { size: h * 0.4 });
  const marks = g.inputs.map((_, index) => svgText(9, portY(h, index, g.inputs.length), ops[index] === "/" ? "÷" : "×", { size: 13 }));
  return rectBody(g) + marks.join("");
}

function sqrt(g: Geometry): string {
  const h = g.height;
  const op = String(g.props.Operator ?? "sqrt");
  const root = `√${"<tspan text-decoration=\"overline\">"}${italic("u")}</tspan>`;
  if (op === "signedSqrt") return rectBody(g) + centered(g, `±√|${italic("u")}|`, "+-v|u|", { family: SERIF, size: Math.min(16, h * 0.4) });
  if (op === "rSqrt") return rectBody(g) + fraction(g, { markup: "1", plain: "1" }, { markup: root, plain: "vu" });
  return rectBody(g) + centered(g, root, "vu", { family: SERIF, size: Math.min(18, h * 0.45) });
}

function mathFunction(g: Geometry): string {
  const op = String(g.props.Operator ?? "exp");
  const labels: Record<string, [string, string]> = {
    exp: [`e${sup("u")}`, "eu"], log: ["log", "log"], "2^u": [`2${sup("u")}`, "2u"], "10^u": [`10${sup("u")}`, "10u"],
    log10: [`log${sub("10")}`, "log10"], "magnitude^2": [`|u|${sup("2")}`, "|u|2"], square: [`u${sup("2")}`, "u2"],
    pow: [`u${sup("v")}`, "uv"], conj: [`u${sup("*")}`, "u*"], reciprocal: ["1/u", "1/u"], hypot: ["hypot", "hypot"],
    rem: ["rem", "rem"], mod: ["mod", "mod"], transpose: [`u${sup("T")}`, "uT"], hermitian: [`u${sup("H")}`, "uH"],
  };
  const [markup, plain] = labels[op] ?? [escapeXml(op), op];
  return rectBody(g) + centered(g, markup, plain, { size: Math.min(13, g.height * 0.32) });
}

/** Weighted Sample Time Math: a equação da operação, com Ts e o peso w (como o ícone oficial). */
function weightedSampleTimeMath(g: Geometry): string {
  const ts = `${italic("T")}${sub("s")}`, u = italic("u"), w = italic("w");
  const labels: Record<string, [string, string]> = {
    "+": [`${u} + ${ts} * ${w}`, "u + Ts * w"], "-": [`${u} − ${ts} * ${w}`, "u - Ts * w"], "*": [`${u} * ${ts} * ${w}`, "u * Ts * w"],
    "/": [`${u} / (${ts} * ${w})`, "u / (Ts * w)"], "Ts Only": [`${ts} * ${w}`, "Ts * w"], "1/Ts Only": [`1 / (${ts} * ${w})`, "1 / (Ts * w)"],
  };
  const [markup, plain] = labels[propertyText(g.props.TsampMathOp)] ?? labels["+"]!;
  return rectBody(g) + centered(g, markup, plain, { family: SERIF, size: Math.min(18, g.height * 0.5) });
}

/** Matrix Concatenate: dois blocos em perspectiva e a dimensão de concatenação no canto. */
function matrixConcatenate(g: Geometry): string {
  const w = g.width, h = g.height;
  const cube = (x: number, y: number, s: number) => {
    const d = s * 0.35;
    const X = (v: number) => (w * v).toFixed(2), Y = (v: number) => (h * v).toFixed(2);
    return `<path d="M ${X(x)} ${Y(y + d)} H ${X(x + s)} V ${Y(y + d + s)} H ${X(x)} Z" fill="#e6e6e6" stroke="${INK}" stroke-width="0.8"/>` +
      `<path d="M ${X(x)} ${Y(y + d)} L ${X(x + d)} ${Y(y)} H ${X(x + s + d)} L ${X(x + s)} ${Y(y + d)} Z" fill="#f4f4f4" stroke="${INK}" stroke-width="0.8"/>` +
      `<path d="M ${X(x + s)} ${Y(y + d)} L ${X(x + s + d)} ${Y(y)} V ${Y(y + s)} L ${X(x + s)} ${Y(y + d + s)} Z" fill="#cfcfcf" stroke="${INK}" stroke-width="0.8"/>`;
  };
  const dimension = propertyText(g.props.Mode) === "Vector" ? "1" : parameterLabel(g, "ConcatenateDimension", "d", w * 0.3, 10);
  return rectBody(g) + cube(0.36, 0.1, 0.34) + cube(0.1, 0.32, 0.34) +
    svgText(w * 0.9, h * 0.85, escapeXml(dimension), { size: Math.min(10, h * 0.24), anchor: "end", raw: true });
}

export const mathIcons: IconTable = {
  gain,
  slider_gain: (g) => {
    const value = parameterLabel(g, "gain", "-K-", g.width - 6, 13);
    return rectBody(g) + centered(g, escapeXml(value), value, { size: Math.min(13, g.height * 0.38) });
  },
  dot_product: (g) => rectBody(g) + `<circle cx="${g.width / 2}" cy="${g.height / 2}" r="${Math.min(g.width, g.height) * 0.06}" fill="${INK}"/>`,
  weighted_sample_time_math: weightedSampleTimeMath,
  minmax_running_resettable: (g) => {
    const op = propertyText(g.props.Function) === "max" ? "max(u,y)" : "min(u,y)";
    return rectBody(g) + centered(g, op, op, { size: Math.min(11, g.height * 0.28) });
  },
  sine_wave_function: (g) => sineWave(g, true),
  vector_concatenate: (g) => `<rect x="0" y="0" width="${g.width}" height="${g.height}" fill="${PAPER}" stroke="${INK}" stroke-width="1.2"/>`,
  matrix_concatenate: matrixConcatenate,
  assignment: (g) => rectBody(g) + centered(g, "A", "A", { size: Math.min(13, g.height * 0.3) }),
  reshape: (g) => rectBody(g) + centered(g, "U( : )", "U( : )", { size: Math.min(12, g.height * 0.34) }),
  sum,
  product,
  bias: (g) => {
    const bias = parameterLabel(g, "Bias", "-C-", g.width - 14, 13);
    const text = bias.startsWith("-") ? bias : `+${bias}`;
    return rectBody(g) + centered(g, escapeXml(text), text);
  },
  abs: (g) => rectBody(g) + centered(g, `|${italic("u")}|`, "|u|", { family: SERIF, size: Math.min(18, g.height * 0.45) }),
  unary_minus: (g) => rectBody(g) + centered(g, `-${italic("u")}`, "-u", { family: SERIF, size: Math.min(18, g.height * 0.45) }),
  sign: (g) => {
    const w = g.width, h = g.height;
    return rectBody(g) + glyph(`M ${w * 0.1} ${h / 2} H ${w * 0.9} M ${w / 2} ${h * 0.1} V ${h * 0.9}`, GRID, 1) +
      glyph(`M ${w * 0.15} ${h * 0.7} H ${w / 2} V ${h * 0.3} H ${w * 0.85}`, INK, 1.6);
  },
  sqrt,
  math_function: mathFunction,
  trigonometric_function: (g) => {
    const op = String(g.props.Operator ?? "sin");
    return rectBody(g) + centered(g, escapeXml(op), op, { size: Math.min(15, g.height * 0.38) });
  },
  rounding_function: (g) => {
    const op = String(g.props.Operator ?? "floor");
    return rectBody(g) + centered(g, escapeXml(op), op, { family: SERIF, size: Math.min(17, g.height * 0.42) });
  },
  minmax: (g) => {
    const op = String(g.props.Function ?? "min");
    return rectBody(g) + centered(g, escapeXml(op), op, { size: Math.min(12, g.height * 0.3) });
  },
  polynomial: (g) => {
    const w = g.width, h = g.height;
    const order = Math.max(0, (evaluated(g, "coefs")?.data.length ?? 1) - 1);
    const size = Math.min(11, h * 0.26);
    return rectBody(g) + svgText(w / 2, h * 0.34, `${italic("P")}(${italic("u")})`, { size, family: SERIF, raw: true }) +
      svgText(w / 2, h * 0.68, `${italic("O")}(${italic("P")}) = ${order}`, { size, family: SERIF, raw: true });
  },
};
