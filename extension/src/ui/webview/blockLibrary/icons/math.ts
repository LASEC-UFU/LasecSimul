// Ícones da biblioteca Math Operations (docs/66).
import {
  centered, escapeXml, evaluated, Geometry, glyph, GRID, IconTable, INK, italic, PAPER, parameterLabel, portY, rectBody, roundPortAngles,
  SERIF, signList, sub, sup, svgText, fraction,
} from "../symbolKit.js";

function gain(g: Geometry): string {
  const w = g.width, h = g.height;
  const value = parameterLabel(g, g.spec.id === "gain" ? "Gain" : "gain", "-K-", w * 0.55, 13);
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

export const mathIcons: IconTable = {
  gain,
  slider_gain: gain,
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
