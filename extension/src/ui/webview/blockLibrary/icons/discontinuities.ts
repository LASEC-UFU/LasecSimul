// Ícones da biblioteca Discontinuities (docs/66). Desenho vetorial próprio que reproduz a forma da
// característica mostrada pelos blocos do Simulink (eixos cinza, curva preta); nenhuma imagem é
// incorporada.
import { axes, Geometry, glyph, GRID, IconTable, INK, rectBody, relativePath } from "../symbolKit.js";

/** Região [x0..x1] x [y0..y1] (fração do corpo) onde vai o gráfico: os blocos Dynamic reservam a
 * esquerda para os rótulos up/u/lo e a direita para o y. */
interface Frame { x0: number; x1: number; y0: number; y1: number }
const FULL: Frame = { x0: 0, x1: 1, y0: 0, y1: 1 };
const DYNAMIC: Frame = { x0: 0.28, x1: 0.82, y0: 0.08, y1: 0.92 };

function framed(g: Geometry, frame: Frame, points: Array<[number, number]>): string {
  const mapped: Array<[number, number]> = points.map(([x, y]) => [frame.x0 + x * (frame.x1 - frame.x0), frame.y0 + y * (frame.y1 - frame.y0)]);
  return relativePath(g, mapped);
}
function frameAxes(g: Geometry, frame: Frame, inset = 0.1): string {
  if (frame === FULL) return axes(g, inset);
  return glyph(framed(g, frame, [[inset, 0.5], [1 - inset, 0.5]]) + " " + framed(g, frame, [[0.5, inset], [0.5, 1 - inset]]), GRID, 1);
}

const SATURATION: Array<[number, number]> = [[0.18, 0.78], [0.36, 0.78], [0.64, 0.22], [0.82, 0.22]];
const DEAD_ZONE: Array<[number, number]> = [[0.14, 0.9], [0.36, 0.5], [0.64, 0.5], [0.86, 0.1]];

function saturation(g: Geometry, frame: Frame): string {
  return frameAxes(g, frame) + glyph(framed(g, frame, SATURATION), INK, 1.3);
}
function deadZone(g: Geometry, frame: Frame): string {
  return frameAxes(g, frame) + glyph(framed(g, frame, DEAD_ZONE), INK, 1.3);
}
/** Curva limitada (preta) abaixo da reta ideal (cinza), com o traço tracejado da taxa. */
function rateLimiter(g: Geometry, frame: Frame): string {
  const p = (x: number, y: number) => {
    const [px, py] = [frame.x0 + x * (frame.x1 - frame.x0), frame.y0 + y * (frame.y1 - frame.y0)];
    return `${(g.width * px).toFixed(2)} ${(g.height * py).toFixed(2)}`;
  };
  return frameAxes(g, frame) +
    glyph(framed(g, frame, [[0.18, 0.88], [0.86, 0.12]]), "#c8c8c8", 1.2) +
    `<path d="M ${p(0.64, 0.12)} L ${p(0.6, 0.3)}" fill="none" stroke="${GRID}" stroke-width="1" stroke-dasharray="2 2"/>` +
    `<path d="M ${p(0.1, 0.62)} Q ${p(0.5, 0.62)} ${p(0.86, 0.14)}" fill="none" stroke="${INK}" stroke-width="1.3"/>`;
}

export const discontinuityIcons: IconTable = {
  saturation: (g) => rectBody(g) + saturation(g, FULL),
  saturation_dynamic: (g) => rectBody(g) + saturation(g, DYNAMIC),
  dead_zone: (g) => rectBody(g) + deadZone(g, FULL),
  dead_zone_dynamic: (g) => rectBody(g) + deadZone(g, DYNAMIC),
  rate_limiter: (g) => rectBody(g) + rateLimiter(g, FULL),
  rate_limiter_dynamic: (g) => rectBody(g) + rateLimiter(g, DYNAMIC),
  relay: (g) => rectBody(g) + axes(g) +
    glyph(relativePath(g, [[0.12, 0.64], [0.58, 0.64], [0.58, 0.3], [0.88, 0.3]]), INK, 1.3) +
    glyph(relativePath(g, [[0.42, 0.64], [0.42, 0.3], [0.58, 0.3]]), INK, 1.3),
  backlash: (g) => rectBody(g) + axes(g, 0.06) +
    glyph(relativePath(g, [[0.14, 0.9], [0.4, 0.36], [0.74, 0.36], [0.86, 0.1]]), INK, 1.3) +
    glyph(relativePath(g, [[0.26, 0.64], [0.6, 0.64], [0.74, 0.36]]), INK, 1.3) +
    glyph(relativePath(g, [[0.36, 0.43], [0.71, 0.43]]) + " " + relativePath(g, [[0.31, 0.53], [0.66, 0.53]]), INK, 1.1),
  coulomb_viscous_friction: (g) => rectBody(g) + axes(g) +
    glyph(relativePath(g, [[0.12, 0.86], [0.5, 0.64], [0.5, 0.36], [0.88, 0.14]]), INK, 1.3),
  quantizer: (g) => {
    // Escada pela origem: patamares horizontais ligados por degraus verticais.
    const levels = 5, dx = 0.72 / levels, dy = 0.72 / (levels - 1);
    const steps: Array<[number, number]> = [[0.14, 0.86]];
    for (let i = 0; i < levels; i++) {
      const x = 0.14 + (i + 1) * dx, y = 0.86 - i * dy;
      steps.push([x, y]);
      if (i < levels - 1) steps.push([x, y - dy]);
    }
    return rectBody(g) + axes(g) + glyph(relativePath(g, steps), INK, 1.3);
  },
  hit_crossing: (g) => {
    const w = g.width, h = g.height;
    const points: string[] = [];
    for (let i = 0; i <= 24; i++) {
      const x = 0.2 + (0.6 * i) / 24;
      const y = 0.88 - 0.72 * Math.sin((Math.PI * i) / 24);
      points.push(`${i === 0 ? "M" : "L"} ${(w * x).toFixed(2)} ${(h * y).toFixed(2)}`);
    }
    // Setas nos cruzamentos com o nível (subindo à esquerda, descendo à direita).
    const arrow = (x: number, up: boolean) => {
      const tipY = up ? 0.2 : 0.8, dir = up ? 1 : -1;
      return `M ${(w * (x - 0.05)).toFixed(2)} ${(h * (tipY + dir * 0.08)).toFixed(2)} L ${(w * x).toFixed(2)} ${(h * tipY).toFixed(2)} L ${(w * (x + 0.05)).toFixed(2)} ${(h * (tipY + dir * 0.08)).toFixed(2)}`;
    };
    return rectBody(g) + glyph(`M ${w * 0.08} ${h * 0.5} H ${w * 0.92}`, GRID, 1) + glyph(points.join(" "), INK, 1.2) +
      glyph(`M ${w * 0.26} ${h * 0.75} V ${h * 0.2} M ${w * 0.74} ${h * 0.25} V ${h * 0.8}`, INK, 1) + glyph(arrow(0.26, true) + " " + arrow(0.74, false), INK, 1);
  },
  wrap_to_zero: (g) => {
    const w = g.width, h = g.height;
    return rectBody(g) + glyph(`M ${w * 0.3} ${h * 0.12} V ${h * 0.9}`, GRID, 1) +
      `<path d="M ${w * 0.2} ${h * 0.24} H ${w * 0.66}" fill="none" stroke="${INK}" stroke-width="1.1" stroke-dasharray="3 2"/>` +
      glyph(relativePath(g, [[0.16, 0.84], [0.66, 0.24], [0.74, 0.24], [0.74, 0.84], [0.88, 0.84]]), INK, 1.3);
  },
  pwm: (g) => {
    const widths = [0.5, 0.4, 0.6, 0.45, 0.55, 0.5];
    const x0 = 0.12, period = 0.76 / widths.length;
    const points: Array<[number, number]> = [[x0, 0.64]];
    widths.forEach((duty, i) => {
      const start = x0 + i * period;
      points.push([start, 0.36], [start + duty * period, 0.36], [start + duty * period, 0.64], [start + period, 0.64]);
    });
    return rectBody(g) + glyph(relativePath(g, points), GRID, 1.1);
  },
};
