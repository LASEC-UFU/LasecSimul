// Ícones da biblioteca Discontinuities (docs/66).
import { axes, glyph, IconTable, INK, rectBody, relativePath } from "../symbolKit.js";

export const discontinuityIcons: IconTable = {
  saturation: (g) => rectBody(g) + axes(g) + glyph(relativePath(g, [[0.15, 0.75], [0.35, 0.75], [0.65, 0.25], [0.85, 0.25]]), INK, 1.4),
};
