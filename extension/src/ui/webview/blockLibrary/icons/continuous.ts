// Ícones da biblioteca Continuous (docs/66).
import { linear } from "../paramExpr.js";
import { evaluated, formatNumber, fraction, Geometry, glyph, GRID, IconTable, INK, italic, Markup, polynomialMarkup, rectBody, rootFactors, SERIF, svgText, escapeXml } from "../symbolKit.js";

/** Transfer Fcn contínua (`s`) ou discreta (`z`): polinômios do parâmetro, como o Simulink mostra. */
export function transferFunctionIcon(g: Geometry, variable: "s" | "z"): string {
  const num = evaluated(g, "Numerator"), den = evaluated(g, "Denominator");
  const numerator: Markup = num && num.rows <= 1 ? polynomialMarkup(linear(num), variable) : { markup: `num(${italic(variable)})`, plain: `num(${variable})` };
  const denominator: Markup = den ? polynomialMarkup(linear(den), variable) : { markup: `den(${italic(variable)})`, plain: `den(${variable})` };
  return rectBody(g) + fraction(g, numerator, denominator);
}

export const continuousIcons: IconTable = {
  integrator: (g) => rectBody(g) + fraction(g, { markup: "1", plain: "1" }, { markup: italic("s"), plain: "s" }),
  transfer_fcn: (g) => transferFunctionIcon(g, "s"),
  zero_pole: (g) => {
    const zeros = evaluated(g, "Zeros"), poles = evaluated(g, "Poles"), gain = evaluated(g, "Gain");
    const k = gain && gain.data.length === 1 && gain.data[0] !== 1 ? formatNumber(gain.data[0]!) : "";
    const numerator = zeros ? rootFactors(linear(zeros), "s") : { markup: "Z(s)", plain: "Z(s)" };
    const denominator = poles ? rootFactors(linear(poles), "s") : { markup: "P(s)", plain: "P(s)" };
    return rectBody(g) + fraction(g, { markup: `${escapeXml(k)}${numerator.markup}`, plain: `${k}${numerator.plain}` }, denominator);
  },
  state_space: (g) => {
    const w = g.width, h = g.height;
    const size = Math.min(12, h * 0.3);
    return rectBody(g) + svgText(w / 2, h * 0.32, `${italic("ẋ")} = ${italic("A")}${italic("x")} + ${italic("B")}${italic("u")}`, { size, family: SERIF, raw: true }) +
      svgText(w / 2, h * 0.7, `${italic("y")} = ${italic("C")}${italic("x")} + ${italic("D")}${italic("u")}`, { size, family: SERIF, raw: true });
  },
  transport_delay: (g) => {
    const w = g.width, h = g.height;
    const wave = (shift: number, color: string) => {
      const points: string[] = [];
      for (let i = 0; i <= 24; i++) {
        const x = w * 0.08 + (w * 0.84 * i) / 24;
        const y = h / 2 - Math.sin((2 * Math.PI * i) / 16 - shift) * h * 0.32;
        points.push(`${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`);
      }
      return glyph(points.join(" "), color, 1.1);
    };
    return rectBody(g) + wave(0, GRID) + wave(1.6, INK);
  },
  derivative: (g) => rectBody(g) + fraction(g, { markup: "Δu", plain: "du" }, { markup: "Δt", plain: "dt" }),
};
