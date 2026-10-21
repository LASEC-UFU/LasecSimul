// Ícones da biblioteca Sinks (docs/66).
import { glyph, IconTable, INK, rectBody } from "../symbolKit.js";

export const sinkIcons: IconTable = {
  scope: (g) => rectBody(g) + `<rect x="${g.width * 0.18}" y="${g.height * 0.12}" width="${g.width * 0.64}" height="${g.height * 0.42}" rx="${g.width * 0.08}" fill="none" stroke="${INK}" stroke-width="1.4"/>`,
  display: (g) => rectBody(g) + `<rect x="3" y="${g.height * 0.22}" width="${g.width - 6}" height="${g.height * 0.56}" fill="none" stroke="${INK}" stroke-width="1"/>`,
  terminator: (g) => glyph(`M 0 ${g.height / 2} H ${g.width * 0.45} M ${g.width * 0.95} ${g.height * 0.15} H ${g.width * 0.45} V ${g.height * 0.85} H ${g.width * 0.95}`, INK, 1.6),
};
