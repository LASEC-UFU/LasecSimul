// Ícones da biblioteca Discrete (docs/66). Desenho vetorial próprio, com as imagens da documentação
// só como referência visual (forma do corpo, glifo, texto e rótulos das portas).
import { linear } from "../paramExpr.js";
import {
  centered, escapeXml, evaluated, formatNumber, fraction, Geometry, glyph, GRID, IconTable, INK, italic, Markup, parameterLabel,
  propertyText, rectBody, relativePath, rootFactors, SANS, SERIF, sub, sup, svgText,
} from "../symbolKit.js";
import { inputULabel, resetGlyph, transferFunctionIcon } from "./continuous.js";

const plain = (text: string): Markup => ({ markup: escapeXml(text), plain: text });

/** Polinômio em potências crescentes de z^-1 (convenção DSP do Discrete Filter/FIR): `1+0.5z^-1`. */
function inversePolynomial(coefficients: number[]): Markup {
  const markup: string[] = [];
  const text: string[] = [];
  coefficients.forEach((c, power) => {
    if (c === 0) return;
    const sign = markup.length === 0 ? (c < 0 ? "-" : "") : c < 0 ? "-" : "+";
    const magnitude = Math.abs(c);
    const coefficient = power > 0 && magnitude === 1 ? "" : formatNumber(magnitude);
    markup.push(`${escapeXml(sign + coefficient)}${power === 0 ? "" : `z${sup(`-${power}`)}`}`);
    text.push(`${sign}${coefficient}${power === 0 ? "" : `z-${power}`}`);
  });
  return markup.length === 0 ? plain("0") : { markup: markup.join(""), plain: text.join("") };
}

/** `z-0.75`, `z+0.5`, `z` (zero/polo real como os ícones mascarados mostram). */
function zMinus(value: number | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  if (value === 0) return "z";
  return value > 0 ? `z-${formatNumber(value)}` : `z+${formatNumber(-value)}`;
}

function scalarOf(g: Geometry, name: string): number | undefined {
  const value = evaluated(g, name);
  return value && value.data.length === 1 ? value.data[0] : undefined;
}

function sansFraction(g: Geometry, numerator: string, denominator: string): string {
  return rectBody(g) + fraction(g, plain(numerator), plain(denominator), SANS);
}

function delay(g: Geometry): string {
  const fromPort = propertyText(g.props.DelayLengthSource) === "Input port";
  const length = fromPort ? "d" : parameterLabel(g, "DelayLength", "N", g.width * 0.4, 11);
  const size = Math.min(17, g.height * 0.42);
  return rectBody(g) + svgText(g.width * 0.58, g.height / 2, `z${sup(`-${length}`)}`, { size, family: SANS, raw: true }) +
    inputULabel(g) + resetGlyph(g, propertyText(g.props.ExternalReset));
}

function discreteIntegrator(g: Geometry): string {
  const method = propertyText(g.props.IntegratorMethod);
  const t = method.startsWith("Accumulation") ? "" : " Ts";
  let numerator = `K${t}`, denominator = "z-1";
  if (method.endsWith("Backward Euler")) numerator = `K${t} z`;
  else if (method.endsWith("Trapezoidal")) { numerator = `K${t} (z+1)`; denominator = "2(z-1)"; }
  return sansFraction(g, numerator, denominator) + resetGlyph(g, propertyText(g.props.ExternalReset));
}

function discreteFilter(g: Geometry): string {
  const fromPort = (name: string) => propertyText(g.props[name]) === "Input port";
  const num = fromPort("NumeratorSource") ? undefined : evaluated(g, "Numerator");
  const den = fromPort("DenominatorSource") ? undefined : evaluated(g, "Denominator");
  const numerator = num && num.rows <= 1 ? inversePolynomial(linear(num)) : plain("Num(z)");
  const denominator = den ? inversePolynomial(linear(den)) : plain("Den(z)");
  return rectBody(g) + fraction(g, numerator, denominator, SANS) + inputULabel(g) + resetGlyph(g, propertyText(g.props.ExternalReset));
}

function firFilter(g: Geometry): string {
  const coefficients = propertyText(g.props.CoefSource) === "Input port" ? undefined : evaluated(g, "Coefficients");
  const numerator = coefficients && coefficients.rows <= 1 ? inversePolynomial(linear(coefficients)) : plain("Num(z)");
  return rectBody(g) + fraction(g, numerator, plain("1"), SANS) + inputULabel(g) + resetGlyph(g, propertyText(g.props.ExternalReset));
}

function stateSpaceEquations(g: Geometry): string {
  const w = g.width, h = g.height;
  const size = Math.min(12, h * 0.3, w / 9);
  return rectBody(g) +
    svgText(w / 2, h * 0.32, `${italic("x")}${sub("n+1")} = ${italic("A")}${italic("x")}${sub("n")} + ${italic("B")}${italic("u")}${sub("n")}`, { size, family: SERIF, raw: true }) +
    svgText(w / 2, h * 0.7, `${italic("y")}${sub("n")} = ${italic("C")}${italic("x")}${sub("n")} + ${italic("D")}${italic("u")}${sub("n")}`, { size, family: SERIF, raw: true });
}

export const discreteIcons: IconTable = {
  unit_delay: (g) => rectBody(g) + fraction(g, plain("1"), { markup: italic("z"), plain: "z" }),
  delay,
  memory: (g) => {
    // Laço de memória: retângulo aberto com seta voltando para baixo (o glifo do Simulink).
    const w = g.width, h = g.height;
    return rectBody(g) + glyph(relativePath(g, [[0.62, 0.72], [0.8, 0.72], [0.8, 0.28], [0.25, 0.28], [0.25, 0.68]]), INK, 1.1) +
      glyph(`M ${w * 0.19} ${h * 0.6} L ${w * 0.25} ${h * 0.72} L ${w * 0.31} ${h * 0.6}`, INK, 1.1);
  },
  zero_order_hold: (g) => rectBody(g) + glyph(relativePath(g, [[0.1, 0.72], [0.28, 0.72], [0.28, 0.22], [0.45, 0.22], [0.45, 0.5], [0.62, 0.5],
    [0.62, 0.68], [0.88, 0.68]]), INK, 1.1),
  discrete_time_integrator: discreteIntegrator,
  discrete_transfer_fcn: (g) => transferFunctionIcon(g, "z") + inputULabel(g) + resetGlyph(g, propertyText(g.props.ExternalReset)),
  discrete_filter: discreteFilter,
  discrete_fir_filter: firFilter,
  discrete_state_space: stateSpaceEquations,
  fixed_point_state_space: (g) => {
    // Ícone do bloco de ponto fixo: equação de saída em cima, notação x(n), fonte sem serifa.
    const w = g.width, h = g.height;
    const size = Math.min(10, h * 0.26, w / 11);
    return rectBody(g) + svgText(w / 2, h * 0.34, "y(n)=Cx(n)+Du(n)", { size, family: SANS }) + svgText(w / 2, h * 0.66, "x(n+1)=Ax(n)+Bu(n)", { size, family: SANS });
  },
  discrete_zero_pole: (g) => {
    const zeros = evaluated(g, "Zeros"), poles = evaluated(g, "Poles"), gain = evaluated(g, "Gain");
    const k = gain && gain.data.length === 1 && gain.data[0] !== 1 ? formatNumber(gain.data[0]!) : "";
    const numerator = zeros ? rootFactors(linear(zeros), "z") : { markup: `zeros(${italic("z")})`, plain: "zeros(z)" };
    const denominator = poles ? rootFactors(linear(poles), "z") : { markup: `poles(${italic("z")})`, plain: "poles(z)" };
    return rectBody(g) + fraction(g, { markup: `${escapeXml(k)}${numerator.markup}`, plain: `${k}${numerator.plain}` }, denominator);
  },
  discrete_derivative: (g) => sansFraction(g, "K (z-1)", "Ts z"),
  difference: (g) => sansFraction(g, "z-1", "z"),
  transfer_fcn_first_order: (g) => {
    const p = scalarOf(g, "PoleZ");
    return sansFraction(g, p === undefined ? "(1-p)z" : `${formatNumber(1 - p)}z`, zMinus(p, "z-p"));
  },
  transfer_fcn_lead_or_lag: (g) => sansFraction(g, zMinus(scalarOf(g, "ZeroZ"), "z-zero"), zMinus(scalarOf(g, "PoleZ"), "z-pole")),
  transfer_fcn_real_zero: (g) => sansFraction(g, zMinus(scalarOf(g, "ZeroZ"), "z-zero"), "z"),
  tapped_delay: (g) => {
    const n = parameterLabel(g, "NumDelays", "N", g.width - 6, 11);
    const size = Math.min(12, g.height * 0.3);
    return rectBody(g) + svgText(g.width / 2, g.height * 0.3, n, { size, family: SANS }) + svgText(g.width / 2, g.height * 0.62, "Delays", { size, family: SANS });
  },
  conditional_hold: (g) => rectBody(g) + centered(g, "Conditional Hold", "Conditional Hold", { size: Math.min(12, g.height * 0.32) }),
  propagation_delay: (g) => {
    // Pulso de entrada (preto) e o mesmo pulso atrasado (tracejado), com setas do atraso.
    const w = g.width, h = g.height;
    const pulse = relativePath(g, [[0.2, 0.72], [0.28, 0.72], [0.28, 0.3], [0.44, 0.3], [0.44, 0.72], [0.58, 0.72], [0.58, 0.3], [0.66, 0.3], [0.66, 0.72], [0.72, 0.72]]);
    const delayed = relativePath(g, [[0.4, 0.25], [0.53, 0.25], [0.53, 0.62], [0.72, 0.62], [0.72, 0.25], [0.8, 0.25], [0.8, 0.62], [0.88, 0.62]]);
    const arrows = `M ${w * 0.29} ${h * 0.42} H ${w * 0.39} M ${w * 0.36} ${h * 0.39} L ${w * 0.39} ${h * 0.42} L ${w * 0.36} ${h * 0.45}` +
      ` M ${w * 0.29} ${h * 0.56} H ${w * 0.39} M ${w * 0.36} ${h * 0.53} L ${w * 0.39} ${h * 0.56} L ${w * 0.36} ${h * 0.59}`;
    return rectBody(g) + `<path d="${delayed}" fill="none" stroke="${GRID}" stroke-width="1" stroke-dasharray="3 2"/>` + glyph(pulse, INK, 1.2) + glyph(arrows, GRID, 0.8);
  },
  transfer_fcn_direct_form_ii: (g) => {
    const num = evaluated(g, "NumCoefVec"), den = evaluated(g, "DenCoefVec");
    const numerator = num ? inversePolynomial(linear(num)) : plain("Num(z)");
    const denominator = den ? inversePolynomial([1, ...linear(den)]) : plain("Den(z)");
    return rectBody(g) + fraction(g, numerator, denominator, SANS);
  },
  transfer_fcn_direct_form_ii_time_varying: (g) => {
    const size = Math.min(11, g.height * 0.24);
    return rectBody(g) + svgText(g.width * 0.55, g.height * 0.36, "Direct", { size, family: SANS }) +
      svgText(g.width * 0.55, g.height * 0.62, "Form II", { size, family: SANS });
  },
};
