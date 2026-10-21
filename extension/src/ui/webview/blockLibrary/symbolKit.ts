/**
 * Primitivas de desenho dos ícones da biblioteca de blocos equivalente ao Simulink (docs/66). Cada
 * família de blocos desenha seus ícones em `icons/<família>.ts` com estas primitivas; `blockSymbol.ts`
 * monta o pacote (corpo + setas de porta + pinos). Desenho vetorial próprio: nenhuma imagem da
 * MathWorks é incorporada; as imagens da documentação servem só de referência visual.
 */
import { BlockSpec, propertyText } from "./spec.js";
import type { ResolvedPort } from "./ports.js";
import { formatNumber, ParamValue, tryEvaluateParam } from "./paramExpr.js";

export const INK = "#000000";
export const PAPER = "#ffffff";
export const GRID = "#a0a0a0";
export const SERIF = "'Times New Roman', Times, serif";
export const SANS = "Helvetica, Arial, sans-serif";

export type Props = Record<string, string | number | boolean>;

/** Bloco em coordenadas do corpo [0..width]x[0..height]. */
export interface Geometry {
  spec: BlockSpec;
  props: Props;
  width: number;
  height: number;
  inputs: ResolvedPort[];
  outputs: ResolvedPort[];
}

/** Desenho de um ícone (corpo incluído). */
export type IconDrawer = (g: Geometry) => string;
/** Tabela id do bloco -> desenho; um arquivo por família em `icons/`. */
export type IconTable = Readonly<Record<string, IconDrawer>>;

export const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Largura aproximada de um texto (para a barra de fração e para caber no bloco). */
export function textWidth(text: string, fontSize: number, family = SANS): number {
  return text.length * fontSize * (family === SERIF ? 0.5 : 0.56);
}

export interface TextOptions { size?: number; family?: string; italic?: boolean; anchor?: string; weight?: string; raw?: boolean; color?: string }

export function svgText(x: number, y: number, content: string, options: TextOptions = {}): string {
  const size = options.size ?? 13;
  return `<text x="${x}" y="${y}" font-size="${size}" font-family="${escapeXml(options.family ?? SANS)}"${options.italic ? ' font-style="italic"' : ""}${options.weight ? ` font-weight="${options.weight}"` : ""} text-anchor="${options.anchor ?? "middle"}" dominant-baseline="central" fill="${options.color ?? INK}" stroke="none">${options.raw ? content : escapeXml(content)}</text>`;
}

export const sup = (text: string) => `<tspan baseline-shift="super" font-size="70%">${escapeXml(text)}</tspan>`;
export const sub = (text: string) => `<tspan baseline-shift="sub" font-size="70%">${escapeXml(text)}</tspan>`;
export const italic = (text: string) => `<tspan font-style="italic">${escapeXml(text)}</tspan>`;

export interface Markup { markup: string; plain: string }

/** Polinômio em potências decrescentes da variável (`s`/`z`), como o ícone do Simulink. */
export function polynomialMarkup(coefficients: number[], variable: string): Markup {
  const n = coefficients.length - 1;
  const parts: string[] = [];
  const plain: string[] = [];
  coefficients.forEach((c, index) => {
    if (c === 0) return;
    const power = n - index;
    const negative = c < 0;
    const magnitude = Math.abs(c);
    const sign = parts.length === 0 ? (negative ? "-" : "") : negative ? " - " : " + ";
    const coefficient = power > 0 && magnitude === 1 ? "" : formatNumber(magnitude);
    const variableMarkup = power === 0 ? "" : power === 1 ? italic(variable) : `${italic(variable)}${sup(String(power))}`;
    const variablePlain = power === 0 ? "" : power === 1 ? variable : `${variable}^${power}`;
    parts.push(`${escapeXml(sign)}${escapeXml(coefficient)}${variableMarkup}`);
    plain.push(`${sign}${coefficient}${variablePlain}`);
  });
  if (parts.length === 0) return { markup: "0", plain: "0" };
  return { markup: parts.join(""), plain: plain.join("") };
}

/** Fatores (s - raiz) de Zero-Pole: raiz 0 vira `s`, demais `(s - r)`. */
export function rootFactors(roots: number[], variable: string): Markup {
  if (roots.length === 0) return { markup: "1", plain: "1" };
  const markup: string[] = [];
  const plain: string[] = [];
  for (const root of roots) {
    if (root === 0) { markup.push(italic(variable)); plain.push(variable); continue; }
    const op = root > 0 ? " - " : " + ";
    markup.push(`(${italic(variable)}${escapeXml(op)}${escapeXml(formatNumber(Math.abs(root)))})`);
    plain.push(`(${variable}${op}${formatNumber(Math.abs(root))})`);
  }
  return { markup: markup.join(""), plain: plain.join("") };
}

/** Fração centralizada (numerador/denominador com barra), fonte reduzida até caber. */
export function fraction(g: Geometry, numerator: Markup, denominator: Markup, family = SERIF): string {
  let size = Math.min(16, g.height * 0.32);
  const longest = Math.max(textWidth(numerator.plain, size, family), textWidth(denominator.plain, size, family));
  if (longest > g.width - 8) size = Math.max(7, size * (g.width - 8) / longest);
  const bar = Math.min(g.width - 6, Math.max(textWidth(numerator.plain, size, family), textWidth(denominator.plain, size, family)) + 4);
  const cx = g.width / 2, cy = g.height / 2;
  return svgText(cx, cy - size * 0.62, numerator.markup, { size, family, raw: true }) +
    `<line x1="${cx - bar / 2}" y1="${cy}" x2="${cx + bar / 2}" y2="${cy}" stroke="${INK}" stroke-width="1"/>` +
    svgText(cx, cy + size * 0.68, denominator.markup, { size, family, raw: true });
}

/** Texto centralizado no corpo, reduzido até caber na largura. */
export function centered(g: Geometry, markup: string, plain: string, options: { family?: string; italic?: boolean; size?: number } = {}): string {
  let size = options.size ?? Math.min(15, g.height * 0.38);
  const width = textWidth(plain, size, options.family);
  if (width > g.width - 6) size = Math.max(6, size * (g.width - 6) / width);
  return svgText(g.width / 2, g.height / 2, markup, { size, family: options.family, italic: options.italic, raw: true });
}

/** Texto do parâmetro como digitado (o Simulink mostra a expressão, não o valor); longo demais vira
 * o marcador `-K-`/`-C-`. */
export function parameterLabel(g: Geometry, name: string, placeholder: string, maxWidth: number, size: number): string {
  const text = propertyText(g.props[name]).trim();
  return textWidth(text, size) <= maxWidth && text.length > 0 ? text : placeholder;
}

/** Valor numérico do parâmetro (literal; variáveis de workspace não resolvem aqui). */
export function evaluated(g: Geometry, name: string): ParamValue | undefined {
  return tryEvaluateParam(propertyText(g.props[name]));
}

export const rectBody = (g: Geometry) => `<rect x="0" y="0" width="${g.width}" height="${g.height}" fill="${PAPER}" stroke="${INK}" stroke-width="1"/>`;
export const glyph = (d: string, color = INK, width = 1.2) => `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linejoin="round"/>`;
/** Eixos cinza cruzando o centro (gráficos de característica: Saturation, Dead Zone, Relay...). */
export const axes = (g: Geometry, inset = 0.1) =>
  glyph(`M ${g.width * inset} ${g.height / 2} H ${g.width * (1 - inset)} M ${g.width / 2} ${g.height * inset} V ${g.height * (1 - inset)}`, GRID, 1);
/** Polilinha por pontos relativos ao corpo ([0..1] x [0..1], y para baixo). */
export function relativePath(g: Geometry, points: Array<[number, number]>): string {
  return points.map(([x, y], i) => `${i === 0 ? "M" : "L"} ${(g.width * x).toFixed(2)} ${(g.height * y).toFixed(2)}`).join(" ");
}

/** Centro vertical da porta `index` de `count` num lado do corpo. */
export const portY = (height: number, index: number, count: number) => (height * (2 * index + 1)) / (2 * count);

/** Rótulos das portas dentro do corpo (como o Simulink mostra `x0`, `up`, `lo`, `P`, `I`...): só as
 * portas cuja regra declara `label`. */
export function portLabels(g: Geometry, size = 8): string {
  const parts: string[] = [];
  g.inputs.forEach((port, index) => {
    if (port.label) parts.push(svgText(3, portY(g.height, index, g.inputs.length), port.label, { size, anchor: "start" }));
  });
  g.outputs.forEach((port, index) => {
    if (port.label) parts.push(svgText(g.width - 3, portY(g.height, index, g.outputs.length), port.label, { size, anchor: "end" }));
  });
  return parts.join("");
}

/** `|` e espaço são espaçadores visuais; número N = N vezes o primeiro símbolo. */
export function signList(text: string, symbols: string): string[] {
  const list: string[] = [];
  let symbolic = false;
  for (const ch of text) {
    if (ch === "|" || ch === " ") { symbolic = true; continue; }
    if (symbols.includes(ch)) { list.push(ch); symbolic = true; }
  }
  if (symbolic) return list;
  const count = Number(text);
  return Number.isInteger(count) && count > 0 ? Array.from({ length: count }, () => symbols[0]!) : [];
}

/** Sum redondo: cada símbolo da lista (inclusive `|`) ocupa uma posição igualmente espaçada no
 * semicírculo esquerdo, do topo (90°) à base (270°); `|` não gera porta. */
export function roundPortAngles(text: string): Array<{ angle: number; symbol: string }> {
  const symbols = [...text].filter((ch) => ch === "+" || ch === "-" || ch === "|");
  const list = symbols.length > 0 ? symbols : signList(text, "+-");
  const result: Array<{ angle: number; symbol: string }> = [];
  list.forEach((symbol, index) => {
    if (symbol === "|") return;
    const degrees = list.length === 1 ? 180 : 90 + (180 * index) / (list.length - 1);
    result.push({ angle: (degrees * Math.PI) / 180, symbol });
  });
  return result;
}

export { formatNumber, propertyText };
