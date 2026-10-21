// Ícones da biblioteca Sources (docs/66). Desenho vetorial próprio, no arranjo dos ícones da
// documentação oficial (que servem só de referência visual).
import { centered, escapeXml, Geometry, glyph, GRID, IconTable, INK, PAPER, parameterLabel, rectBody, relativePath, SANS, SERIF, svgText } from "../symbolKit.js";

/** Um período de seno sobre o eixo horizontal cinza (Sine Wave; Sine Wave Function acrescenta o eixo vertical). */
export function sineWave(g: Geometry, verticalAxis = false): string {
  const w = g.width, h = g.height;
  const points: string[] = [];
  const start = verticalAxis ? 0.25 : 0.15, span = verticalAxis ? 0.67 : 0.7;
  for (let i = 0; i <= 32; i++) {
    const x = w * start + (w * span * i) / 32;
    const y = h / 2 - Math.sin((2 * Math.PI * i) / 32) * h * (verticalAxis ? 0.4 : 0.32);
    points.push(`${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`);
  }
  const axes = `M ${w * (verticalAxis ? 0.22 : 0.1)} ${h / 2} H ${w * 0.95}` + (verticalAxis ? ` M ${w * 0.25} ${h * 0.06} V ${h * 0.94}` : "");
  return rectBody(g) + glyph(axes, GRID, 1) + glyph(points.join(" "));
}

/** Curva por pontos relativos (x, y em [0..1], y para baixo). */
const trace = (g: Geometry, points: Array<[number, number]>, width = 1.2) => glyph(relativePath(g, points), INK, width);

/** Eixos cinza em L (canto inferior esquerdo) dos ícones de ruído. */
const plotAxes = (g: Geometry) => glyph(relativePath(g, [[0.12, 0.08], [0.12, 0.88], [0.92, 0.88]]), GRID, 1);

function chirp(g: Geometry): string {
  const points: Array<[number, number]> = [];
  for (let i = 0; i <= 160; i++) {
    const u = i / 160;
    points.push([0.12 + 0.76 * u, 0.5 - 0.32 * Math.sin(2 * Math.PI * (1.0 * u + 3.5 * u * u))]);
  }
  return rectBody(g) + trace(g, points, 1);
}

/** Escada de contagem (Counter Free-Running/Limited): dois grupos de degraus que voltam a zero. */
const COUNT_STEPS: Array<[number, number]> = [[0.14, 0.82], [0.24, 0.82], [0.24, 0.62], [0.33, 0.62], [0.33, 0.42], [0.42, 0.42], [0.42, 0.82], [0.52, 0.82], [0.52, 0.62],
    [0.61, 0.62], [0.61, 0.42], [0.7, 0.42], [0.7, 0.24], [0.8, 0.24]];

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
  sine_wave: (g) => sineWave(g),
  clock: (g) => {
    const w = g.width, h = g.height;
    const r = Math.min(w, h) * 0.42;
    return `<circle cx="${w / 2}" cy="${h / 2}" r="${r}" fill="${PAPER}" stroke="${INK}" stroke-width="1"/>` +
      glyph(`M ${w / 2} ${h / 2 - r * 0.7} V ${h / 2} H ${w / 2 + r * 0.6}`);
  },
  digital_clock: (g) => rectBody(g) + centered(g, "12:34", "12:34", { family: SERIF, size: Math.min(20, g.height * 0.55) }),
  pulse_generator: (g) => rectBody(g) + trace(g, [[0.12, 0.78], [0.22, 0.78], [0.22, 0.22], [0.38, 0.22], [0.38, 0.78], [0.52, 0.78], [0.52, 0.22],
    [0.68, 0.22], [0.68, 0.78], [0.86, 0.78]]),
  signal_generator: (g) => {
    const w = g.width, h = g.height;
    const knob = (x: number) => `<rect x="${(w * x).toFixed(2)}" y="${(h * 0.2).toFixed(2)}" width="${(w * 0.11).toFixed(2)}" height="${(h * 0.15).toFixed(2)}" rx="${(w * 0.03).toFixed(2)}" fill="none" stroke="${INK}" stroke-width="1"/>`;
    const dial = (x: number) => `<ellipse cx="${(w * x).toFixed(2)}" cy="${(h * 0.58).toFixed(2)}" rx="${(w * 0.045).toFixed(2)}" ry="${(h * 0.07).toFixed(2)}" fill="none" stroke="${INK}" stroke-width="1"/>`;
    return rectBody(g) + knob(0.2) + knob(0.355) + knob(0.51) + knob(0.665) + dial(0.29) + dial(0.45);
  },
  repeating_sequence: (g) => rectBody(g) + trace(g, [[0.15, 0.82], [0.38, 0.18], [0.38, 0.82], [0.61, 0.18], [0.61, 0.82], [0.84, 0.18]]),
  repeating_sequence_interpolated: (g) => rectBody(g) + trace(g, [[0.16, 0.18], [0.16, 0.74], [0.4, 0.26], [0.56, 0.56], [0.86, 0.72]]),
  repeating_sequence_stair: (g) => rectBody(g) + trace(g, [[0.15, 0.82], [0.15, 0.22], [0.27, 0.22], [0.27, 0.56], [0.4, 0.56], [0.4, 0.3], [0.53, 0.3],
    [0.53, 0.7], [0.68, 0.7], [0.68, 0.46], [0.85, 0.46]]),
  chirp_signal: chirp,
  random_number: (g) => rectBody(g) + plotAxes(g) + trace(g, [[0.15, 0.55], [0.22, 0.6], [0.3, 0.75], [0.4, 0.15], [0.5, 0.2], [0.58, 0.72], [0.66, 0.12],
    [0.75, 0.8], [0.82, 0.85], [0.88, 0.7]], 1),
  uniform_random_number: (g) => rectBody(g) + plotAxes(g) + trace(g, [[0.15, 0.82], [0.24, 0.12], [0.32, 0.65], [0.4, 0.58], [0.48, 0.28], [0.55, 0.52],
    [0.62, 0.4], [0.7, 0.8], [0.78, 0.1], [0.84, 0.45], [0.9, 0.55]], 1),
  band_limited_white_noise: (g) => rectBody(g) + trace(g, [[0.14, 0.62], [0.24, 0.62], [0.24, 0.78], [0.32, 0.78], [0.32, 0.4], [0.4, 0.4], [0.4, 0.55],
    [0.48, 0.55], [0.48, 0.22], [0.56, 0.22], [0.56, 0.4], [0.64, 0.4], [0.64, 0.3], [0.72, 0.3], [0.72, 0.48], [0.86, 0.48]]),
  counter_free_running: (g) => rectBody(g) + trace(g, COUNT_STEPS),
  counter_limited: (g) => rectBody(g) + trace(g, COUNT_STEPS.map(([x, y]) => [x, 0.25 + y * 0.7] as [number, number])) +
    svgText(g.width * 0.08, g.height * 0.16, "lim", { size: Math.min(10, g.height * 0.26), family: SANS, anchor: "start" }),
};
