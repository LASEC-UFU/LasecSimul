/**
 * Elementos matemáticos de tela (`graphics.math.*`, docs/62 §6.1): gráfico de função, parâmetro,
 * equação, tabela de valores e tendência de um sinal. Vivem em qualquer página de uma Tela HMI, fora do
 * solver (`pinCount: 0`), e compartilham o ESCOPO da página: cada `graphics.math.parameter` declara um
 * nome (`a`, `b`, `k`...) que as expressões dos outros elementos usam.
 *
 * Este módulo só gera SVG a partir de propriedades + escopo (puro, testável em Node). O motor de cena
 * injeta o estado de execução como propriedades `__math_*` (ver `main.ts::runtimeSymbolProperties`), do
 * mesmo jeito que `__screen_state`/`__g_bind`. O cálculo é o do Laboratório (`lab/calc/*`): mesmo
 * parser, mesmo compilador sem `eval`, mesma amostragem adaptativa e mesmo MathML.
 */
import { dependsOn, parseExpression, substitute, type Ast } from "./lab/calc/ast.js";
import { findRoots } from "./lab/calc/analysis.js";
import { compileExpression, type CompiledExpression } from "./lab/calc/compile.js";
import { differentiate, simplify } from "./lab/calc/derivative.js";
import { astToMathML, escapeXml } from "./lab/calc/mathml.js";
import { sampleFunction } from "./lab/calc/numeric.js";

/** Passo "bonito" (1, 2, 5 × 10^k) para ~`count` marcas -- o mesmo de `lab/ui/chart.ts`, que não pode
 * ser importado aqui (este módulo também compila no Host, sem DOM). */
function niceStep(span: number, count = 6): number {
  const raw = Math.abs(span) / count;
  const power = 10 ** Math.floor(Math.log10(raw || 1));
  const unit = raw / power;
  return (unit < 1.5 ? 1 : unit < 3.5 ? 2 : unit < 7.5 ? 5 : 10) * power;
}

export const MATH_ACTIVITY_TYPE_ID = "graphics.math.activity";
export const MATH_PLOT_TYPE_ID = "graphics.math.function_plot";
export const MATH_PARAMETER_TYPE_ID = "graphics.math.parameter";
export const MATH_EQUATION_TYPE_ID = "graphics.math.equation";
export const MATH_TABLE_TYPE_ID = "graphics.math.value_table";
export const MATH_TREND_TYPE_ID = "graphics.math.trend";

/** Elementos desenhados por `mathWidgetSvg` (a atividade é um `<iframe>` do Laboratório, não SVG). */
export const MATH_WIDGET_TYPE_IDS: readonly string[] = [MATH_PLOT_TYPE_ID, MATH_PARAMETER_TYPE_ID, MATH_EQUATION_TYPE_ID, MATH_TABLE_TYPE_ID, MATH_TREND_TYPE_ID];

export const isMathTypeId = (typeId: string): boolean => typeId.startsWith("graphics.math.");
export const isMathWidgetTypeId = (typeId: string): boolean => MATH_WIDGET_TYPE_IDS.includes(typeId);

/** Caixa padrão de cada elemento (o tamanho real vem de `width`/`height`). */
export const MATH_DEFAULT_BOX: Readonly<Record<string, { width: number; height: number }>> = {
  [MATH_ACTIVITY_TYPE_ID]: { width: 1200, height: 720 },
  [MATH_PLOT_TYPE_ID]: { width: 520, height: 320 },
  [MATH_PARAMETER_TYPE_ID]: { width: 260, height: 64 },
  [MATH_EQUATION_TYPE_ID]: { width: 320, height: 64 },
  [MATH_TABLE_TYPE_ID]: { width: 240, height: 220 },
  [MATH_TREND_TYPE_ID]: { width: 520, height: 260 },
};

/** Nome válido de parâmetro: identificador simples (o parser aceita letras, dígitos e `_`). */
export const isParameterName = (name: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);

/** Escopo da página: nome do parâmetro -> valor atual. */
export type MathScope = Readonly<Record<string, number>>;

interface ScopeSource { typeId: string; properties: Record<string, unknown> }

/** Valor inicial (autorado) de cada parâmetro da página; `current` (sessão) prevalece quando existe. */
export function mathScopeOf(elements: readonly ScopeSource[], current: Readonly<Record<string, number>> = {}): Record<string, number> {
  const scope: Record<string, number> = {};
  for (const element of elements) {
    if (element.typeId !== MATH_PARAMETER_TYPE_ID) continue;
    const name = text(element.properties, "name", "");
    if (!isParameterName(name) || name in scope) continue;
    const value = current[name];
    scope[name] = typeof value === "number" && Number.isFinite(value) ? value : clampParameter(element.properties, num(element.properties, "value", 0));
  }
  return scope;
}

/** Valor do parâmetro preso à faixa e ao passo do slider. */
export function clampParameter(properties: Record<string, unknown>, value: number): number {
  const min = num(properties, "min", 0);
  const max = num(properties, "max", 10);
  const step = num(properties, "step", 0);
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  let next = Math.min(high, Math.max(low, Number.isFinite(value) ? value : low));
  if (step > 0) next = Math.min(high, low + Math.round((next - low) / step) * step);
  return Number(next.toPrecision(12));
}

/** Valor do parâmetro para uma posição horizontal `fraction` (0..1) do trilho. */
export function parameterValueAt(properties: Record<string, unknown>, fraction: number): number {
  const min = num(properties, "min", 0);
  const max = num(properties, "max", 10);
  return clampParameter(properties, min + Math.min(1, Math.max(0, fraction)) * (max - min));
}

/** Trilho do slider dentro da caixa (coordenadas locais): o motor de cena converte o clique por aqui. */
export function parameterTrack(box: { width: number; height: number }): { x0: number; x1: number; y: number } {
  return { x0: 14, x1: Math.max(15, box.width - 14), y: Math.max(30, box.height - 18) };
}

// ── Expressões ───────────────────────────────────────────────────────────────────────────────────

/** `variableIndex` = -1 quando a expressão não tem variável livre (só parâmetros). */
export interface CompiledScopeExpression { ast: Ast; fn: CompiledExpression; symbols: string[]; env: Float64Array; variableIndex: number }

/** Compila `text` na variável `variable` com os parâmetros do escopo; erro em português legível. */
export function compileInScope(textValue: string, variable: string, scope: MathScope): CompiledScopeExpression | { error: string } {
  const names = Object.keys(scope).filter((name) => name !== variable);
  const symbols = variable ? [variable, ...names] : names;
  let ast: Ast;
  try {
    ast = parseExpression(textValue, symbols);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const fn = compileExpression(ast, symbols);
  const env = new Float64Array(symbols.length);
  symbols.forEach((symbol, index) => { if (symbol !== variable) env[index] = scope[symbol] ?? 0; });
  return { ast, fn, symbols, env, variableIndex: variable ? 0 : -1 };
}

const isError = (value: CompiledScopeExpression | { error: string }): value is { error: string } => "error" in value;

/** f(x) com os parâmetros atuais; NaN quando indefinido. */
export function evaluateAt(compiled: CompiledScopeExpression, x: number): number {
  if (compiled.variableIndex >= 0) compiled.env[compiled.variableIndex] = x;
  return compiled.fn.value(compiled.env);
}

/** Expressão com os parâmetros trocados pelos valores (equação "com números"). */
export function substituteScope(ast: Ast, scope: MathScope): Ast {
  let result = ast;
  for (const [name, value] of Object.entries(scope)) result = substitute(result, name, value, differentiate);
  return tidySigns(simplify(result));
}

/** "x + −2" vira "x − 2" e "x + (−y)" vira "x − y": só a escrita muda, o valor é o mesmo. */
export function tidySigns(ast: Ast): Ast {
  if (!Array.isArray(ast)) return ast;
  const node = [ast[0], ...ast.slice(1).map(tidySigns)] as Ast & unknown[];
  if (node[0] === "Add" && node.length === 3) {
    const right = node[2] as Ast;
    if (typeof right === "number" && right < 0) return ["Subtract", node[1] as Ast, -right];
    if (Array.isArray(right) && right[0] === "Negate" && right.length === 2) return ["Subtract", node[1] as Ast, right[1] as Ast];
  }
  return node as Ast;
}

// ── Formatação ───────────────────────────────────────────────────────────────────────────────────

const nf = (value: number, decimals = 3): string =>
  Number.isFinite(value) ? value.toLocaleString("pt-BR", { maximumFractionDigits: decimals }) : "—";

function num(properties: Record<string, unknown>, key: string, fallback: number): number {
  const value = properties[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}
function text(properties: Record<string, unknown>, key: string, fallback: string): string {
  const value = properties[key];
  return typeof value === "string" ? value : fallback;
}
function flag(properties: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = properties[key];
  return typeof value === "boolean" ? value : fallback;
}
const color = (properties: Record<string, unknown>, key: string, fallback: string): string => {
  const value = text(properties, key, fallback);
  return /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]+|rgba?\([^<>"]*\))$/.test(value) ? value : fallback;
};
const fixed = (value: number): string => (Math.round(value * 100) / 100).toString();

/** Tema "Laboratório" (tokens de `media/lab/lab.css`): os elementos combinam com as atividades. */
const LAB = { panel: "#f7f9fc", line: "#cbd5e1", ink: "#0f172a", muted: "#475569", grid: "#e2e8f0", accent: "#2563eb", dark: "#10294d", light: "#e2e8f0" };

function frame(width: number, height: number, fill = LAB.panel, stroke = LAB.line): string {
  return `<rect x="0.5" y="0.5" width="${fixed(Math.max(0, width - 1))}" height="${fixed(Math.max(0, height - 1))}" rx="10" ry="10" fill="${fill}" stroke="${stroke}" stroke-width="1"/>`;
}

function message(width: number, height: number, textValue: string, fill = "#b91c1c"): string {
  return `<text x="${fixed(width / 2)}" y="${fixed(height / 2)}" text-anchor="middle" dominant-baseline="middle" font-size="12" fill="${fill}">${escapeXml(textValue)}</text>`;
}

// ── Eixos ────────────────────────────────────────────────────────────────────────────────────────

interface PlotArea { L: number; T: number; W: number; H: number; x0: number; x1: number; y0: number; y1: number }
const px = (area: PlotArea, x: number): number => area.L + ((x - area.x0) / (area.x1 - area.x0)) * area.W;
const py = (area: PlotArea, y: number): number => area.T + (1 - (y - area.y0) / (area.y1 - area.y0)) * area.H;

function axes(area: PlotArea, xLabel: string, showGrid: boolean, xFormat: (value: number) => string = (v) => nf(v, 3)): string {
  const parts: string[] = [];
  const xStep = niceStep(area.x1 - area.x0, Math.max(2, Math.round(area.W / 80)));
  const yStep = niceStep(area.y1 - area.y0, Math.max(2, Math.round(area.H / 50)));
  const bottom = area.T + area.H;
  for (let x = Math.ceil(area.x0 / xStep) * xStep; x <= area.x1 + xStep * 1e-9; x += xStep) {
    const X = fixed(px(area, x));
    if (showGrid) parts.push(`<line x1="${X}" y1="${fixed(area.T)}" x2="${X}" y2="${fixed(bottom)}" stroke="${LAB.grid}" stroke-width="1"/>`);
    parts.push(`<text x="${X}" y="${fixed(bottom + 14)}" text-anchor="middle" font-size="10" fill="${LAB.muted}">${escapeXml(xFormat(Math.abs(x) < xStep * 1e-9 ? 0 : x))}</text>`);
  }
  for (let y = Math.ceil(area.y0 / yStep) * yStep; y <= area.y1 + yStep * 1e-9; y += yStep) {
    const Y = fixed(py(area, y));
    if (showGrid) parts.push(`<line x1="${fixed(area.L)}" y1="${Y}" x2="${fixed(area.L + area.W)}" y2="${Y}" stroke="${LAB.grid}" stroke-width="1"/>`);
    parts.push(`<text x="${fixed(area.L - 5)}" y="${Y}" text-anchor="end" dominant-baseline="middle" font-size="10" fill="${LAB.muted}">${escapeXml(nf(Math.abs(y) < yStep * 1e-9 ? 0 : y, 3))}</text>`);
  }
  // Eixos x = 0 e y = 0 quando visíveis; senão a moldura da área.
  if (area.y0 <= 0 && area.y1 >= 0) parts.push(`<line x1="${fixed(area.L)}" y1="${fixed(py(area, 0))}" x2="${fixed(area.L + area.W)}" y2="${fixed(py(area, 0))}" stroke="${LAB.muted}" stroke-width="1.2"/>`);
  if (area.x0 <= 0 && area.x1 >= 0) parts.push(`<line x1="${fixed(px(area, 0))}" y1="${fixed(area.T)}" x2="${fixed(px(area, 0))}" y2="${fixed(bottom)}" stroke="${LAB.muted}" stroke-width="1.2"/>`);
  parts.push(`<rect x="${fixed(area.L)}" y="${fixed(area.T)}" width="${fixed(area.W)}" height="${fixed(area.H)}" fill="none" stroke="${LAB.line}" stroke-width="1"/>`);
  if (xLabel) parts.push(`<text x="${fixed(area.L + area.W)}" y="${fixed(bottom + 26)}" text-anchor="end" font-size="10" fill="${LAB.muted}">${escapeXml(xLabel)}</text>`);
  return parts.join("");
}

/** `sampleFunction` devolve pontos do MUNDO (o `toPx` só guia o refinamento): o caminho vai em pixels. */
function pathOf(segments: Array<Array<[number, number]>>, toPx: (x: number, y: number) => [number, number]): string {
  return segments.map((segment) => `M${segment.map(([x, y]) => toPx(x, y)).map(([x, y]) => `${fixed(x)},${fixed(y)}`).join("L")}`).join("");
}

/** Faixa em y automática (yMin == yMax): mínimo/máximo amostrado com 10 % de folga. */
function autoRange(compiled: CompiledScopeExpression[], x0: number, x1: number): [number, number] {
  let low = Infinity, high = -Infinity;
  for (const entry of compiled) {
    for (let i = 0; i <= 200; i++) {
      const y = evaluateAt(entry, x0 + ((x1 - x0) * i) / 200);
      if (!Number.isFinite(y) || Math.abs(y) > 1e9) continue;
      low = Math.min(low, y);
      high = Math.max(high, y);
    }
  }
  if (!Number.isFinite(low)) return [-1, 1];
  if (high - low < 1e-9) return [low - 1, high + 1];
  const pad = (high - low) * 0.1;
  return [low - pad, high + pad];
}

// ── Gráfico de função ────────────────────────────────────────────────────────────────────────────

export function functionPlotSvg(properties: Record<string, unknown>, box: { width: number; height: number }, scope: MathScope): string {
  const { width, height } = box;
  const title = text(properties, "title", "");
  const variable = text(properties, "variable", "x").trim() || "x";
  const expressions = [text(properties, "expression", ""), text(properties, "expression2", "")];
  const parts = [frame(width, height)];
  if (title) parts.push(`<text x="12" y="18" font-size="13" font-weight="600" fill="${LAB.ink}">${escapeXml(title)}</text>`);
  const compiled: CompiledScopeExpression[] = [];
  for (const [index, source] of expressions.entries()) {
    if (!source.trim()) continue;
    const result = compileInScope(source, variable, scope);
    if (isError(result)) {
      parts.push(message(width, height, `${index === 0 ? "f" : "g"}: ${result.error}`));
      return parts.join("");
    }
    compiled.push(result);
  }
  if (compiled.length === 0) return parts.join("") + message(width, height, "Defina a expressão f(x) nas propriedades.", LAB.muted);
  let x0 = num(properties, "xMin", -5), x1 = num(properties, "xMax", 5);
  if (!(x1 > x0)) [x0, x1] = [-5, 5];
  let y0 = num(properties, "yMin", 0), y1 = num(properties, "yMax", 0);
  if (!(y1 > y0)) [y0, y1] = autoRange(compiled, x0, x1);
  const area: PlotArea = { L: 46, T: title ? 28 : 12, W: Math.max(10, width - 46 - 12), H: Math.max(10, height - (title ? 28 : 12) - 34), x0, x1, y0, y1 };
  parts.push(axes(area, variable, flag(properties, "showGrid", true)));
  const toPx = (x: number, y: number): [number, number] => [px(area, x) - area.L, py(area, y) - area.T];
  const curves: string[] = [];
  const palette = [color(properties, "color", LAB.accent), color(properties, "color2", "#dc2626")];
  compiled.forEach((entry, index) => {
    const one = { value: (env: ArrayLike<number>) => { entry.env[0] = env[0]!; return entry.fn.value(entry.env); }, evaluate: entry.fn.evaluate };
    curves.push(`<path d="${pathOf(sampleFunction(one, x0, x1, toPx), toPx)}" fill="none" stroke="${palette[index]}" stroke-width="2.2" stroke-linejoin="round"/>`);
  });
  const f = compiled[0]!;
  if (flag(properties, "showDerivative", false)) {
    const derivative = compileExpressionAst(simplify(differentiate(f.ast, variable)), f);
    const one = { value: (env: ArrayLike<number>) => { derivative.env[0] = env[0]!; return derivative.fn.value(derivative.env); }, evaluate: derivative.fn.evaluate };
    curves.push(`<path d="${pathOf(sampleFunction(one, x0, x1, toPx), toPx)}" fill="none" stroke="#16a34a" stroke-width="1.8" stroke-dasharray="6 4"/>`);
  }
  const markers: string[] = [];
  if (flag(properties, "showRoots", false)) {
    const one = { value: (env: ArrayLike<number>) => { f.env[0] = env[0]!; return f.fn.value(f.env); }, evaluate: f.fn.evaluate };
    for (const root of findRoots(one, x0, x1)) {
      const [X, Y] = toPx(root, 0);
      markers.push(`<circle cx="${fixed(X)}" cy="${fixed(Y)}" r="4" fill="#f59e0b" stroke="${LAB.ink}" stroke-width="1"><title>raiz ≈ ${escapeXml(nf(root, 4))}</title></circle>`);
    }
  }
  // Área de desenho recortada: curvas que saem da faixa não invadem eixos nem legendas.
  parts.push(`<svg x="${fixed(area.L)}" y="${fixed(area.T)}" width="${fixed(area.W)}" height="${fixed(area.H)}" overflow="hidden">${curves.join("")}${markers.join("")}</svg>`);
  const legend = [`f(${variable}) = ${expressions[0]}`, ...(compiled.length > 1 ? [`g(${variable}) = ${expressions[1]}`] : [])];
  legend.forEach((entry, index) => {
    parts.push(`<text x="${fixed(width - 14)}" y="${fixed((title ? 18 : area.T + 14) + index * 14)}" text-anchor="end" font-size="11" fill="${palette[index]}">${escapeXml(entry)}</text>`);
  });
  return parts.join("");
}

function compileExpressionAst(ast: Ast, like: CompiledScopeExpression): CompiledScopeExpression {
  return { ast, fn: compileExpression(ast, like.symbols), symbols: like.symbols, env: Float64Array.from(like.env), variableIndex: like.variableIndex };
}

// ── Parâmetro (slider) ───────────────────────────────────────────────────────────────────────────

export function parameterSvg(properties: Record<string, unknown>, box: { width: number; height: number }, current: number | undefined): string {
  const { width, height } = box;
  const name = text(properties, "name", "a");
  const label = text(properties, "label", "") || name;
  const unit = text(properties, "unit", "");
  const decimals = Math.max(0, Math.min(8, Math.round(num(properties, "decimals", 2))));
  const min = num(properties, "min", 0), max = num(properties, "max", 10);
  const value = clampParameter(properties, current ?? num(properties, "value", 0));
  const track = parameterTrack(box);
  const fraction = max === min ? 0 : (value - Math.min(min, max)) / Math.abs(max - min);
  const thumb = track.x0 + fraction * (track.x1 - track.x0);
  const valid = isParameterName(name);
  return [
    frame(width, height, LAB.dark, "#1e3a5f"),
    `<text x="14" y="20" font-size="14" fill="${LAB.light}"><tspan font-style="italic" font-weight="600">${escapeXml(label)}</tspan> = <tspan font-weight="700" fill="#fde68a">${escapeXml(value.toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: decimals }))}</tspan>${unit ? ` ${escapeXml(unit)}` : ""}</text>`,
    valid ? "" : `<text x="${fixed(width - 12)}" y="20" text-anchor="end" font-size="10" fill="#fca5a5">nome inválido</text>`,
    `<line x1="${fixed(track.x0)}" y1="${fixed(track.y)}" x2="${fixed(track.x1)}" y2="${fixed(track.y)}" stroke="#334155" stroke-width="6" stroke-linecap="round"/>`,
    `<line x1="${fixed(track.x0)}" y1="${fixed(track.y)}" x2="${fixed(thumb)}" y2="${fixed(track.y)}" stroke="#3b82f6" stroke-width="6" stroke-linecap="round"/>`,
    `<circle class="math-parameter-thumb" cx="${fixed(thumb)}" cy="${fixed(track.y)}" r="8" fill="#f8fafc" stroke="#2563eb" stroke-width="2"/>`,
    `<text x="${fixed(track.x0)}" y="${fixed(height - 2)}" font-size="9" fill="#94a3b8">${escapeXml(nf(min, decimals))}</text>`,
    `<text x="${fixed(track.x1)}" y="${fixed(height - 2)}" text-anchor="end" font-size="9" fill="#94a3b8">${escapeXml(nf(max, decimals))}</text>`,
  ].join("");
}

// ── Equação ──────────────────────────────────────────────────────────────────────────────────────

export function equationSvg(properties: Record<string, unknown>, box: { width: number; height: number }, scope: MathScope): string {
  const { width, height } = box;
  const lhs = text(properties, "lhs", "f(x)");
  const variable = text(properties, "variable", "x").trim();
  const source = text(properties, "expression", "");
  const fontSize = Math.max(8, Math.min(96, num(properties, "fontSize", 20)));
  const parts = [frame(width, height, LAB.dark, "#1e3a5f")];
  if (!source.trim()) return parts.join("") + message(width, height, "Defina a expressão nas propriedades.", "#94a3b8");
  const compiled = compileInScope(source, variable, scope);
  if (isError(compiled)) return parts.join("") + message(width, height, compiled.error, "#fca5a5");
  const shown = flag(properties, "substitute", false) ? substituteScope(compiled.ast, scope) : compiled.ast;
  const mathml = astToMathML(shown, "inline").replace("<math ", '<math xmlns="http://www.w3.org/1998/Math/MathML" ');
  // Sem variável livre (só parâmetros), mostra também o valor: "= 3,5".
  let valuePart = "";
  if (flag(properties, "showValue", true) && (!variable || !dependsOn(compiled.ast, variable))) {
    const value = evaluateAt(compiled, 0);
    valuePart = `<span style="margin-left:.4em;color:#fde68a">= ${escapeXml(nf(value, Math.round(num(properties, "decimals", 4))))}</span>`;
  }
  parts.push(
    `<foreignObject x="0" y="0" width="${fixed(width)}" height="${fixed(height)}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="box-sizing:border-box;width:100%;height:100%;display:flex;align-items:center;justify-content:center;padding:6px 12px;color:${LAB.light};font:${fontSize}px system-ui,'Segoe UI',sans-serif;white-space:nowrap;overflow:hidden">` +
    `${lhs ? `<span style="margin-right:.3em"><i>${escapeXml(lhs)}</i> =</span>` : ""}${mathml}${valuePart}</div></foreignObject>`,
  );
  return parts.join("");
}

// ── Tabela de valores ────────────────────────────────────────────────────────────────────────────

export function valueTableSvg(properties: Record<string, unknown>, box: { width: number; height: number }, scope: MathScope): string {
  const { width, height } = box;
  const variable = text(properties, "variable", "x").trim() || "x";
  const source = text(properties, "expression", "");
  const header = text(properties, "header", "") || `f(${variable})`;
  const parts = [frame(width, height)];
  if (!source.trim()) return parts.join("") + message(width, height, "Defina a expressão nas propriedades.", LAB.muted);
  const compiled = compileInScope(source, variable, scope);
  if (isError(compiled)) return parts.join("") + message(width, height, compiled.error);
  const start = num(properties, "start", 0);
  const step = num(properties, "step", 1) || 1;
  const decimals = Math.max(0, Math.min(10, Math.round(num(properties, "decimals", 3))));
  const rowHeight = 20;
  const rows = Math.max(1, Math.min(60, Math.round(num(properties, "rows", 8)), Math.floor((height - 30) / rowHeight)));
  const mid = width / 2;
  parts.push(`<text x="${fixed(mid / 2)}" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="${LAB.ink}">${escapeXml(variable)}</text>`);
  parts.push(`<text x="${fixed(mid + mid / 2)}" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="${LAB.ink}">${escapeXml(header)}</text>`);
  parts.push(`<line x1="8" y1="27" x2="${fixed(width - 8)}" y2="27" stroke="${LAB.line}"/>`);
  parts.push(`<line x1="${fixed(mid)}" y1="8" x2="${fixed(mid)}" y2="${fixed(30 + rows * rowHeight)}" stroke="${LAB.line}"/>`);
  for (let row = 0; row < rows; row++) {
    const x = Number((start + row * step).toPrecision(12));
    const y = evaluateAt(compiled, x);
    const baseline = 30 + row * rowHeight + 14;
    parts.push(`<text x="${fixed(mid / 2)}" y="${fixed(baseline)}" text-anchor="middle" font-size="12" fill="${LAB.ink}" font-variant-numeric="tabular-nums">${escapeXml(nf(x, decimals))}</text>`);
    parts.push(`<text x="${fixed(mid + mid / 2)}" y="${fixed(baseline)}" text-anchor="middle" font-size="12" fill="${Number.isFinite(y) ? LAB.ink : "#b91c1c"}" font-variant-numeric="tabular-nums">${escapeXml(Number.isFinite(y) ? nf(y, decimals) : "indef.")}</text>`);
  }
  return parts.join("");
}

// ── Tendência de um sinal ────────────────────────────────────────────────────────────────────────

/** Amostra da tendência: instante (s, relógio da Webview) e valor já escalado pelo binding. */
export type TrendSample = readonly [number, number];

export function trendSvg(properties: Record<string, unknown>, box: { width: number; height: number }, samples: readonly TrendSample[], bind: string | undefined): string {
  const { width, height } = box;
  const title = text(properties, "title", "");
  const unit = text(properties, "bindUnit", "");
  const decimals = Math.max(0, Math.min(8, Math.round(num(properties, "bindDecimals", 2))));
  const window = Math.max(1, num(properties, "windowSeconds", 30));
  const parts = [frame(width, height)];
  if (title) parts.push(`<text x="12" y="18" font-size="13" font-weight="600" fill="${LAB.ink}">${escapeXml(title)}</text>`);
  const last = samples[samples.length - 1];
  const now = last?.[0] ?? 0;
  const visible = samples.filter(([t]) => t >= now - window);
  let y0 = num(properties, "yMin", 0), y1 = num(properties, "yMax", 0);
  if (!(y1 > y0)) {
    const values = visible.map(([, v]) => v).filter(Number.isFinite);
    const low = values.length ? Math.min(...values) : 0;
    const high = values.length ? Math.max(...values) : 1;
    const pad = Math.max((high - low) * 0.1, Math.abs(high) * 0.05, 1e-6);
    [y0, y1] = [low - pad, high + pad];
  }
  const top = title ? 28 : 12;
  const area: PlotArea = { L: 50, T: top, W: Math.max(10, width - 62), H: Math.max(10, height - top - 34), x0: -window, x1: 0, y0, y1 };
  parts.push(axes(area, "t (s)", flag(properties, "showGrid", true), (v) => nf(v, 1)));
  const lineColor = color(properties, "color", LAB.accent);
  if (visible.length > 1) {
    const points = visible.map(([t, v]) => `${fixed(px(area, t - now) - area.L)},${fixed(py(area, v) - area.T)}`).join(" ");
    parts.push(`<svg x="${fixed(area.L)}" y="${fixed(area.T)}" width="${fixed(area.W)}" height="${fixed(area.H)}" overflow="hidden"><polyline points="${points}" fill="none" stroke="${lineColor}" stroke-width="2" stroke-linejoin="round"/></svg>`);
  }
  const status = bind === "missing" ? "sem leitura" : bind === "stale" ? "dado antigo" : bind === "disconnected" ? "desconectado" : "";
  const readout = last ? `${nf(last[1], decimals)}${unit ? ` ${unit}` : ""}` : "—";
  parts.push(`<text x="${fixed(width - 12)}" y="18" text-anchor="end" font-size="13" font-weight="700" fill="${status ? "#b45309" : lineColor}">${escapeXml(status || readout)}</text>`);
  if (!text(properties, "bindSource", "")) parts.push(message(width, height, "Ligue a uma fonte (Binding › Fonte).", LAB.muted));
  return parts.join("");
}

// ── Despacho ─────────────────────────────────────────────────────────────────────────────────────

/** SVG do elemento matemático com o estado de execução injetado em `__math_*`. */
export function mathWidgetSvg(typeId: string, properties: Record<string, unknown>, box: { width: number; height: number }): string | undefined {
  const scope = (properties.__math_scope && typeof properties.__math_scope === "object" ? properties.__math_scope : {}) as MathScope;
  switch (typeId) {
    case MATH_PLOT_TYPE_ID: return functionPlotSvg(properties, box, scope);
    case MATH_PARAMETER_TYPE_ID: return parameterSvg(properties, box, typeof properties.__math_value === "number" ? properties.__math_value : undefined);
    case MATH_EQUATION_TYPE_ID: return equationSvg(properties, box, scope);
    case MATH_TABLE_TYPE_ID: return valueTableSvg(properties, box, scope);
    case MATH_TREND_TYPE_ID: return trendSvg(properties, box, Array.isArray(properties.__math_samples) ? properties.__math_samples as TrendSample[] : [], typeof properties.__g_bind === "string" ? properties.__g_bind : undefined);
    default: return undefined;
  }
}

/** Definição da atividade guardada no elemento (`activityJson`, texto JSON como os `*Json` dos dispositivos
 * HART: propriedades de componente são escalares). `undefined` quando ausente ou ilegível. */
export function activityFromProperties(properties: Record<string, unknown>): Record<string, unknown> & { kind?: unknown; id?: unknown; title?: unknown } | undefined {
  const raw = properties.activityJson;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** Placa do elemento "Atividade do Laboratório" quando o `<iframe>` ainda não cobre a área (edição, impressão). */
export function activityPlaceholderSvg(properties: Record<string, unknown>, box: { width: number; height: number }): string {
  const activity = activityFromProperties(properties);
  const title = typeof activity?.title === "string" ? activity.title : "Atividade do Laboratório";
  return [
    frame(box.width, box.height, "#0b1f3a", "#2563eb"),
    `<text x="${fixed(box.width / 2)}" y="${fixed(box.height / 2 - 6)}" text-anchor="middle" font-size="18" font-weight="600" fill="#e2e8f0">${escapeXml(title)}</text>`,
    `<text x="${fixed(box.width / 2)}" y="${fixed(box.height / 2 + 16)}" text-anchor="middle" font-size="12" fill="#93c5fd">Laboratório de Cálculo</text>`,
  ].join("");
}
