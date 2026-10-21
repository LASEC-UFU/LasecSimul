// Ícones da biblioteca Logic and Bit Operations (docs/66). Desenho vetorial próprio: texto do
// operador como o Simulink mostra, portas lógicas no formato "distinctive" (símbolo IEEE) e os
// glifos do Interval Test / Combinatorial Logic.
import { centered, escapeXml, evaluated, formatNumber, Geometry, glyph, GRID, IconTable, INK, PAPER, parameterLabel, rectBody, relativePath, svgText } from "../symbolKit.js";

const OPERATOR_TEXT: Record<string, string> = { "<=": "≤", ">=": "≥", "==": "==", "~=": "~=", "<": "<", ">": ">" };

/** Porta lógica no formato distinctive; operadores negados ganham o círculo na saída. */
function gate(g: Geometry, op: string): string {
  const w = g.width, h = g.height;
  const inverted = op === "NAND" || op === "NOR" || op === "NXOR" || op === "NOT";
  const r = inverted ? Math.min(w, h) * 0.08 : 0;
  const right = w - 2 * r;
  const shape = (d: string) => `<path d="${d}" fill="${PAPER}" stroke="${INK}" stroke-width="1.2" stroke-linejoin="round"/>`;
  let body: string;
  if (op === "NOT") {
    body = shape(`M 0 ${h * 0.1} L ${right} ${h / 2} L 0 ${h * 0.9} Z`);
  } else if (op === "AND" || op === "NAND") {
    const half = right / 2;
    body = shape(`M 0 0 H ${half} A ${half} ${h / 2} 0 0 1 ${half} ${h} H 0 Z`);
  } else {
    const x0 = op === "XOR" || op === "NXOR" ? w * 0.12 : 0;
    body = shape(`M ${x0} 0 Q ${x0 + (right - x0) * 0.6} 0 ${right} ${h / 2} Q ${x0 + (right - x0) * 0.6} ${h} ${x0} ${h} Q ${x0 + (right - x0) * 0.3} ${h / 2} ${x0} 0 Z`);
    if (x0 > 0) body += glyph(`M 0 0 Q ${(right - x0) * 0.3} ${h / 2} 0 ${h}`, INK, 1.2);
  }
  if (inverted) body += `<circle cx="${right + r}" cy="${h / 2}" r="${r}" fill="${PAPER}" stroke="${INK}" stroke-width="1.2"/>`;
  return body;
}

function logicalOperator(g: Geometry): string {
  const op = String(g.props.Operator ?? "AND");
  if (g.props.IconShape === "distinctive") return gate(g, op);
  return rectBody(g) + centered(g, escapeXml(op), op, { size: Math.min(13, g.height * 0.3) });
}

function relational(g: Geometry): string {
  const op = String(g.props.Operator ?? "<=");
  const label = OPERATOR_TEXT[op] ?? op;
  const symbol = label.length === 1;
  return rectBody(g) + centered(g, escapeXml(label), label, { size: symbol ? Math.min(22, g.height * 0.46) : Math.min(13, g.height * 0.3) });
}

/** `relop constante` como no ícone do Simulink (valor numérico formatado; expressão longa vira `C`). */
function compare(g: Geometry, constant: string): string {
  const op = String(g.props.relop ?? "<=");
  const text = `${op} ${constant}`;
  return rectBody(g) + centered(g, escapeXml(text), text, { size: Math.min(14, g.height * 0.36) });
}
function constantText(g: Geometry): string {
  const value = evaluated(g, "const");
  if (value && value.data.length === 1) return formatNumber(value.data[0]!);
  return parameterLabel(g, "const", "C", g.width * 0.45, 13);
}

/** Texto em linhas centradas (Detect Fall/Rise: três linhas). */
function lines(g: Geometry, rows: string[]): string {
  const size = Math.min(13, (g.height * 0.8) / rows.length);
  return rectBody(g) + rows.map((row, i) => svgText(g.width / 2, (g.height * (2 * i + 1)) / (2 * rows.length), row, { size })).join("");
}

/** Pulso retangular sobre eixos cinza (Interval Test); `x0` reserva espaço para rótulos. */
function interval(g: Geometry, x0: number, x1: number): string {
  const span = x1 - x0;
  const at = (x: number) => x0 + x * span;
  return rectBody(g) + glyph(relativePath(g, [[at(0.36), 0.12], [at(0.36), 0.88]]) + " " + relativePath(g, [[at(0.06), 0.72], [at(0.94), 0.72]]), GRID, 1) +
    glyph(relativePath(g, [[at(0.06), 0.68], [at(0.3), 0.68], [at(0.3), 0.28], [at(0.6), 0.28], [at(0.6), 0.68], [at(0.94), 0.68]]), INK, 1.3);
}

export const logicIcons: IconTable = {
  logical_operator: logicalOperator,
  relational_operator: relational,
  compare_to_constant: (g) => compare(g, constantText(g)),
  compare_to_zero: (g) => compare(g, "0"),
  detect_change: (g) => lines(g, ["U ~= U/z"]),
  detect_decrease: (g) => lines(g, ["U < U/z"]),
  detect_increase: (g) => lines(g, ["U > U/z"]),
  detect_fall_negative: (g) => lines(g, ["U < 0", "& NOT", "U/z < 0"]),
  detect_fall_nonpositive: (g) => lines(g, ["U <= 0", "& NOT", "U/z <= 0"]),
  detect_rise_nonnegative: (g) => lines(g, ["U >= 0", "& NOT", "U/z >= 0"]),
  detect_rise_positive: (g) => lines(g, ["U > 0", "& NOT", "U/z > 0"]),
  interval_test: (g) => interval(g, 0, 1),
  interval_test_dynamic: (g) => interval(g, 0.3, 0.84),
  combinatorial_logic: (g) => {
    const w = g.width, h = g.height;
    const bracket = `M ${w * 0.24} ${h * 0.2} H ${w * 0.16} V ${h * 0.8} H ${w * 0.24} M ${w * 0.76} ${h * 0.2} H ${w * 0.84} V ${h * 0.8} H ${w * 0.76}`;
    const ticks: string[] = [];
    for (const x of [0.38, 0.5, 0.62]) for (const y of [0.3, 0.5, 0.7]) ticks.push(`M ${w * x} ${h * (y - 0.06)} V ${h * (y + 0.06)}`);
    return rectBody(g) + glyph(bracket, GRID, 1.6) + glyph(ticks.join(" "), GRID, 1.6);
  },
};
