// Ícones da biblioteca Continuous (docs/66). Desenho vetorial próprio, com as imagens da
// documentação só como referência visual (forma do corpo, glifo, texto e rótulos das portas).
import { linear } from "../paramExpr.js";
import {
  escapeXml, evaluated, formatNumber, fraction, Geometry, glyph, GRID, IconTable, INK, italic, Markup, polynomialMarkup, portY, propertyText,
  rectBody, rootFactors, SANS, SERIF, sup, svgText,
} from "../symbolKit.js";

/** Transfer Fcn contínua (`s`) ou discreta (`z`): polinômios do parâmetro, como o Simulink mostra. */
export function transferFunctionIcon(g: Geometry, variable: "s" | "z"): string {
  const fromPort = (name: string) => propertyText(g.props[name]) === "Input port";
  const num = fromPort("NumeratorSource") ? undefined : evaluated(g, "Numerator");
  const den = fromPort("DenominatorSource") ? undefined : evaluated(g, "Denominator");
  const numerator: Markup = num && num.rows <= 1 ? polynomialMarkup(linear(num), variable) : { markup: `num(${italic(variable)})`, plain: `num(${variable})` };
  const denominator: Markup = den ? polynomialMarkup(linear(den), variable) : { markup: `den(${italic(variable)})`, plain: `den(${variable})` };
  return rectBody(g) + fraction(g, numerator, denominator);
}

/** Glifo do reset externo junto da porta `reset` (degrau com seta, como o ícone do Simulink). */
export function resetGlyph(g: Geometry, mode: string): string {
  const index = g.inputs.findIndex((port) => port.id === "reset");
  if (index < 0) return "";
  const y = portY(g.height, index, g.inputs.length);
  const x = 3;
  const m = mode.toLowerCase();
  const up = `M ${x} ${y + 3} H ${x + 3} V ${y - 3} H ${x + 6} M ${x + 1.5} ${y - 0.5} L ${x + 3} ${y - 2.5} L ${x + 4.5} ${y - 0.5}`;
  const down = `M ${x} ${y - 3} H ${x + 3} V ${y + 3} H ${x + 6} M ${x + 1.5} ${y + 0.5} L ${x + 3} ${y + 2.5} L ${x + 4.5} ${y + 0.5}`;
  const either = `M ${x} ${y + 3} H ${x + 2} V ${y - 3} H ${x + 5} V ${y + 3} H ${x + 7}`;
  const level = `M ${x} ${y + 3} H ${x + 2} V ${y - 3} H ${x + 7}`;
  const d = m === "rising" ? up : m === "falling" ? down : m === "either" ? either : level;
  return glyph(d, INK, 0.9);
}

/** Rótulo `u` na primeira entrada quando o bloco tem outras portas rotuladas (Delay, filtros). */
export function inputULabel(g: Geometry): string {
  if (g.inputs.length < 2 || g.inputs[0]!.label) return "";
  return svgText(3, portY(g.height, 0, g.inputs.length), "u", { size: 8, anchor: "start" });
}

/** Onda atrasada (Transport Delay e atrasos variáveis): seno cinza (entrada) e o mesmo seno preto
 * começando depois de um trecho reto (saída atrasada). */
function delayedWave(g: Geometry): string {
  const w = g.width, h = g.height;
  const x0 = w * 0.12, x1 = w * 0.9;
  const point = (i: number, shift: number) => {
    const x = x0 + ((x1 - x0) * i) / 32;
    const phase = (2 * Math.PI * i) / 18 - shift;
    return { x, y: h * 0.5 - Math.sin(phase) * h * 0.3 };
  };
  const path = (shift: number, startIndex: number) => {
    const parts: string[] = [];
    for (let i = startIndex; i <= 32; i++) {
      const p = point(i, shift);
      parts.push(`${parts.length === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`);
    }
    return parts.join(" ");
  };
  const delayIndex = 6;
  const start = point(delayIndex, (2 * Math.PI * delayIndex) / 18);
  const flat = `M ${x0.toFixed(2)} ${start.y.toFixed(2)} H ${start.x.toFixed(2)} `;
  return glyph(path(0, 0), GRID, 1) + glyph(flat + path((2 * Math.PI * delayIndex) / 18, delayIndex).replace(/^M/, "L"), INK, 1.1) +
    glyph(`M ${x0} ${h * 0.5} H ${x1}`, GRID, 0.6);
}

export const continuousIcons: IconTable = {
  integrator: (g) => rectBody(g) + fraction(g, { markup: "1", plain: "1" }, { markup: "s", plain: "s" }, SANS) +
    resetGlyph(g, propertyText(g.props.ExternalReset)),
  second_order_integrator: (g) => rectBody(g) + fraction(g, { markup: "1", plain: "1" }, { markup: `s${sup("2")}`, plain: "s2" }, SANS) +
    resetGlyph(g, propertyText(g.props.ExternalReset)),
  transfer_fcn: (g) => transferFunctionIcon(g, "s"),
  zero_pole: (g) => {
    const zeros = evaluated(g, "Zeros"), poles = evaluated(g, "Poles"), gain = evaluated(g, "Gain");
    const k = gain && gain.data.length === 1 && gain.data[0] !== 1 ? formatNumber(gain.data[0]!) : "";
    const numerator = zeros ? rootFactors(linear(zeros), "s") : { markup: `zeros(${italic("s")})`, plain: "zeros(s)" };
    const denominator = poles ? rootFactors(linear(poles), "s") : { markup: `poles(${italic("s")})`, plain: "poles(s)" };
    return rectBody(g) + fraction(g, { markup: `${escapeXml(k)}${numerator.markup}`, plain: `${k}${numerator.plain}` }, denominator);
  },
  state_space: (g) => {
    const w = g.width, h = g.height;
    const size = Math.min(12, h * 0.3, w / 7);
    return rectBody(g) + svgText(w / 2, h * 0.32, `${italic("ẋ")} = ${italic("A")}${italic("x")} + ${italic("B")}${italic("u")}`, { size, family: SERIF, raw: true }) +
      svgText(w / 2, h * 0.7, `${italic("y")} = ${italic("C")}${italic("x")} + ${italic("D")}${italic("u")}`, { size, family: SERIF, raw: true });
  },
  descriptor_state_space: (g) => {
    const w = g.width, h = g.height;
    const size = Math.min(12, h * 0.3, w / 7.5);
    return rectBody(g) + svgText(w / 2, h * 0.32, `${italic("E")}${italic("ẋ")} = ${italic("A")}${italic("x")} + ${italic("B")}${italic("u")}`, { size, family: SERIF, raw: true }) +
      svgText(w / 2, h * 0.7, `${italic("y")} = ${italic("C")}${italic("x")} + ${italic("D")}${italic("u")}`, { size, family: SERIF, raw: true });
  },
  transport_delay: (g) => rectBody(g) + delayedWave(g),
  variable_time_delay: (g) => rectBody(g) + delayedWave(g),
  variable_transport_delay: (g) => rectBody(g) + delayedWave(g),
  derivative: (g) => rectBody(g) + fraction(g, { markup: "Δu", plain: "du" }, { markup: `Δ${italic("t")}`, plain: "dt" }),
  first_order_hold: (g) => {
    const w = g.width, h = g.height;
    const points: Array<[number, number]> = [[0.18, 0.72], [0.3, 0.72], [0.45, 0.4], [0.55, 0.3], [0.68, 0.52], [0.82, 0.42]];
    return rectBody(g) + glyph(points.map(([x, y], i) => `${i === 0 ? "M" : "L"} ${(w * x).toFixed(2)} ${(h * y).toFixed(2)}`).join(" "), INK, 1.1);
  },
};
