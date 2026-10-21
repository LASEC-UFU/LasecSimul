// Ícones da biblioteca Discrete (docs/66).
import { centered, fraction, IconTable, italic, parameterLabel, rectBody, SERIF, sub, sup, svgText, glyph } from "../symbolKit.js";
import { transferFunctionIcon } from "./continuous.js";

export const discreteIcons: IconTable = {
  discrete_transfer_fcn: (g) => transferFunctionIcon(g, "z"),
  discrete_state_space: (g) => {
    const w = g.width, h = g.height;
    const size = Math.min(12, h * 0.3);
    return rectBody(g) + svgText(w / 2, h * 0.32, `${italic("x")}${sub("n+1")} = ${italic("A")}${italic("x")}${sub("n")} + ${italic("B")}${italic("u")}${sub("n")}`, { size, family: SERIF, raw: true }) +
      svgText(w / 2, h * 0.7, `${italic("y")}${sub("n")} = ${italic("C")}${italic("x")}${sub("n")} + ${italic("D")}${italic("u")}${sub("n")}`, { size, family: SERIF, raw: true });
  },
  unit_delay: (g) => rectBody(g) + fraction(g, { markup: "1", plain: "1" }, { markup: italic("z"), plain: "z" }),
  delay: (g) => {
    const length = parameterLabel(g, "DelayLength", "N", g.width * 0.4, 11);
    return rectBody(g) + centered(g, `z${sup(`-${length}`)}`, `z-${length}`, { size: Math.min(17, g.height * 0.42) });
  },
  zero_order_hold: (g) => {
    const w = g.width, h = g.height;
    return rectBody(g) + glyph(`M ${w * 0.12} ${h * 0.7} H ${w * 0.3} V ${h * 0.3} H ${w * 0.5} V ${h * 0.5} H ${w * 0.7} V ${h * 0.7} H ${w * 0.88}`);
  },
};
