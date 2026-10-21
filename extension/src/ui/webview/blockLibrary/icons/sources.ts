// Ícones da biblioteca Sources (docs/66).
import { centered, escapeXml, Geometry, glyph, GRID, IconTable, INK, PAPER, parameterLabel, rectBody, SERIF } from "../symbolKit.js";

function sineWave(g: Geometry): string {
  const w = g.width, h = g.height;
  const points: string[] = [];
  for (let i = 0; i <= 24; i++) {
    const x = w * 0.15 + (w * 0.7 * i) / 24;
    const y = h / 2 - Math.sin((2 * Math.PI * i) / 24) * h * 0.3;
    points.push(`${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`);
  }
  return rectBody(g) + glyph(`M ${w * 0.1} ${h / 2} H ${w * 0.9}`, GRID, 1) + glyph(points.join(" "));
}

export const sourceIcons: IconTable = {
  constant: (g) => {
    const value = parameterLabel(g, "Value", "-C-", g.width - 6, 13);
    return rectBody(g) + centered(g, escapeXml(value), value);
  },
  ground: (g) => {
    const w = g.width, h = g.height;
    return glyph(`M ${w} ${h / 2} H ${w * 0.35} V ${h * 0.72} M ${w * 0.05} ${h * 0.72} H ${w * 0.65} M ${w * 0.15} ${h * 0.84} H ${w * 0.55} M ${w * 0.25} ${h * 0.96} H ${w * 0.45}`, INK, 1.4);
  },
  step: (g) => rectBody(g) + glyph(`M ${g.width * 0.15} ${g.height * 0.8} H ${g.width * 0.5} V ${g.height * 0.2} H ${g.width * 0.85}`),
  ramp: (g) => rectBody(g) + glyph(`M ${g.width * 0.12} ${g.height * 0.82} H ${g.width * 0.32} L ${g.width * 0.85} ${g.height * 0.18}`),
  sine_wave: sineWave,
  clock: (g) => {
    const w = g.width, h = g.height;
    const r = Math.min(w, h) * 0.42;
    return `<circle cx="${w / 2}" cy="${h / 2}" r="${r}" fill="${PAPER}" stroke="${INK}" stroke-width="1"/>` +
      glyph(`M ${w / 2} ${h / 2 - r * 0.7} V ${h / 2} H ${w / 2 + r * 0.6}`);
  },
  digital_clock: (g) => rectBody(g) + centered(g, "12:34", "12:34", { family: SERIF }),
};
