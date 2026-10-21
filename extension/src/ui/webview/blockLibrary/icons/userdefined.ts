// Ícones da biblioteca User-Defined Functions (docs/66).
import { centered, IconTable, italic, rectBody } from "../symbolKit.js";

export const userDefinedIcons: IconTable = {
  fcn: (g) => rectBody(g) + centered(g, `f(${italic("u")})`, "f(u)", { size: Math.min(12, g.height * 0.32) }),
};
