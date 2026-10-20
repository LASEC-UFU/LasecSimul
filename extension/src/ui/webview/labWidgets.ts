/**
 * Elementos de tela do Laboratório (docs/65 §3.9): cartão, gráfico de série do processo, tanque de
 * processo, parâmetro da planta, controles da simulação e leitura. Compõem telas no estilo do doc 55
 * (processo em tempo real, gráficos com tangente/secante/Riemann, equações, "Explore") com elementos que o
 * próprio professor coloca e configura -- nada fica preso dentro de uma atividade.
 *
 * Como `mathWidgets.ts`: só gera SVG a partir das propriedades + estado de execução injetado pela cena
 * (`__plant_buffer`, `__plant_params`, `__sim_status`, `__chart_state`...; ver `main.ts`). Os dados de
 * planta vêm da MESMA gravação que as atividades usam (uma por planta, `lab/plantRecordings.ts`).
 */
import { escapeXml } from "./lab/calc/mathml.js";
import { PLANTS, type PlantParameterSpec, type PlantSpec } from "./lab/plants.js";
import { riemannOnSteps, type RiemannMethodName, type SeriesBuffer } from "./lab/series/SeriesBuffer.js";

export const MATH_CARD_TYPE_ID = "graphics.math.card";
export const MATH_SERIES_CHART_TYPE_ID = "graphics.math.series_chart";
export const MATH_PROCESS_TANK_TYPE_ID = "graphics.math.process_tank";
export const MATH_PLANT_PARAMETER_TYPE_ID = "graphics.math.plant_parameter";
export const MATH_SIM_CONTROLS_TYPE_ID = "graphics.math.sim_controls";
export const MATH_READOUT_TYPE_ID = "graphics.math.readout";

export const LAB_WIDGET_TYPE_IDS: readonly string[] = [
  MATH_CARD_TYPE_ID, MATH_SERIES_CHART_TYPE_ID, MATH_PROCESS_TANK_TYPE_ID, MATH_PLANT_PARAMETER_TYPE_ID, MATH_SIM_CONTROLS_TYPE_ID, MATH_READOUT_TYPE_ID,
];

/** Elementos que leem uma planta (`plantComponentId`): a tela assina a gravação dela. */
export const PLANT_WIDGET_TYPE_IDS: readonly string[] = [MATH_SERIES_CHART_TYPE_ID, MATH_PROCESS_TANK_TYPE_ID, MATH_PLANT_PARAMETER_TYPE_ID, MATH_READOUT_TYPE_ID, MATH_SIM_CONTROLS_TYPE_ID];

/** Elementos que respondem ao ponteiro na operação. */
export const INTERACTIVE_LAB_WIDGET_TYPE_IDS: readonly string[] = [MATH_SERIES_CHART_TYPE_ID, MATH_PLANT_PARAMETER_TYPE_ID, MATH_SIM_CONTROLS_TYPE_ID];

export const LAB_WIDGET_DEFAULT_BOX: Readonly<Record<string, { width: number; height: number }>> = {
  [MATH_CARD_TYPE_ID]: { width: 380, height: 200 },
  [MATH_SERIES_CHART_TYPE_ID]: { width: 640, height: 320 },
  [MATH_PROCESS_TANK_TYPE_ID]: { width: 340, height: 380 },
  [MATH_PLANT_PARAMETER_TYPE_ID]: { width: 300, height: 72 },
  [MATH_SIM_CONTROLS_TYPE_ID]: { width: 480, height: 64 },
  [MATH_READOUT_TYPE_ID]: { width: 220, height: 60 },
};

// ── Propriedades ─────────────────────────────────────────────────────────────────────────────────

type Props = Record<string, unknown>;
interface Box { width: number; height: number }

function num(p: Props, key: string, fallback: number): number {
  const value = p[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}
const str = (p: Props, key: string, fallback: string): string => (typeof p[key] === "string" ? p[key] as string : fallback);
const flag = (p: Props, key: string, fallback: boolean): boolean => (typeof p[key] === "boolean" ? p[key] as boolean : fallback);
function color(p: Props, key: string, fallback: string): string {
  const value = str(p, key, fallback);
  return /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]+|rgba?\([^<>"]*\))$/.test(value) ? value : fallback;
}
const f = (value: number): string => (Math.round(value * 100) / 100).toString();
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** Número em pt-BR com até `decimals` casas (sem zeros à direita). */
export function fmt(value: number, decimals = 3): string {
  if (!Number.isFinite(value)) return "—";
  const magnitude = Math.abs(value);
  const digits = magnitude >= 1000 ? Math.min(decimals, 1) : magnitude >= 100 ? Math.min(decimals, 2) : decimals;
  return value.toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

/** Identificador estável de uma definição (`<linearGradient>`, `<clipPath>`...) a partir do conteúdo: dois
 * elementos com a mesma definição podem dividir o id sem trocar o desenho de nenhum. */
function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
class Defs {
  private readonly items = new Map<string, string>();
  add(kind: string, body: (id: string) => string): string {
    const id = `lw-${kind}-${hash(body("§"))}`;
    if (!this.items.has(id)) this.items.set(id, body(id));
    return id;
  }
  toString(): string { return this.items.size ? `<defs>${[...this.items.values()].join("")}</defs>` : ""; }
}

/** Tema do Laboratório (doc 55): azul-marinho, cartões com degradê, gráficos claros. */
export const LAB_THEME = {
  ink: "#e8eef8", muted: "#9fb1c9", faint: "#64748b",
  cardTop: "#173562", cardBottom: "#0f2447", cardStroke: "rgba(148,163,184,0.24)",
  lightTop: "#ffffff", lightBottom: "#f2f6fb", lightStroke: "#d6e0ec", lightInk: "#0f172a", lightMuted: "#475569", grid: "#e6ecf3",
  blue: "#2563eb", sky: "#38bdf8", orange: "#f97316", teal: "#14b8a6", green: "#22c55e", violet: "#7c3aed", amber: "#f59e0b", red: "#ef4444",
} as const;

function shadow(defs: Defs, strength = 0.35): string {
  return defs.add("shadow", (id) => `<filter id="${id}" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="6" stdDeviation="8" flood-color="#020617" flood-opacity="${strength}"/></filter>`);
}

type CardVariant = "dark" | "light" | "glass" | "accent";

function cardBackground(defs: Defs, box: Box, variant: CardVariant, accent: string, radius = 16): string {
  const { width: W, height: H } = box;
  const rect = (fill: string, stroke: string): string =>
    `<rect x="0.75" y="0.75" width="${f(Math.max(0, W - 1.5))}" height="${f(Math.max(0, H - 1.5))}" rx="${radius}" ry="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="1.2" filter="url(#${shadow(defs)})"/>`;
  if (variant === "light") {
    const g = defs.add("light", (id) => `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${LAB_THEME.lightTop}"/><stop offset="1" stop-color="${LAB_THEME.lightBottom}"/></linearGradient>`);
    return rect(`url(#${g})`, LAB_THEME.lightStroke);
  }
  if (variant === "glass") return rect("rgba(255,255,255,0.06)", "rgba(255,255,255,0.16)");
  const g = defs.add("card", (id) => `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${LAB_THEME.cardTop}"/><stop offset="1" stop-color="${LAB_THEME.cardBottom}"/></linearGradient>`);
  const base = rect(`url(#${g})`, LAB_THEME.cardStroke);
  // Brilho no topo (vidro) e, no "accent", a faixa colorida à esquerda.
  const shine = `<rect x="2" y="2" width="${f(Math.max(0, W - 4))}" height="${f(Math.min(H * 0.35, 60))}" rx="${radius - 2}" fill="rgba(255,255,255,0.035)"/>`;
  if (variant !== "accent") return base + shine;
  return base + shine + `<rect x="0.75" y="${f(radius * 0.6)}" width="4" height="${f(Math.max(0, H - radius * 1.2))}" rx="2" fill="${accent}"/>`;
}

// ── Ícones (24 × 24, traço) ──────────────────────────────────────────────────────────────────────

export const LAB_ICONS: Readonly<Record<string, string>> = {
  process: '<path d="M6 4h12v15a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2z"/><path d="M6 12c2 1.2 4 1.2 6 0s4-1.2 6 0"/><path d="M3 7h3M18 16h3"/>',
  drop: '<path d="M12 3c3.5 4.2 6 7.4 6 10.5A6 6 0 0 1 6 13.5C6 10.4 8.5 7.2 12 3z"/><path d="M9 14.5a3 3 0 0 0 3 3"/>',
  pump: '<circle cx="11" cy="13" r="6"/><path d="M11 7V4h7"/><path d="M11 13l3.5-2M11 13l-3.5-2M11 13v4"/><path d="M4 21h14"/>',
  area: '<ellipse cx="12" cy="6" rx="7" ry="2.5"/><path d="M5 6v11c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6"/><path d="M5 11.5c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/>',
  valve: '<path d="M4 8v8l8-4zM20 8v8l-8-4z"/><path d="M12 12V5M9 5h6"/>',
  gauge: '<path d="M4 16a8 8 0 1 1 16 0"/><path d="M12 16l4-5"/><path d="M4 20h16"/>',
  step: '<path d="M3 18h6V8h12"/><path d="M15 5l3 3-3 3"/>',
  bulb: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>',
  chart: '<path d="M4 20V4M4 20h16"/><path d="M7 16c3-7 6-8 9-4s3 2 4-4"/>',
  sigma: '<path d="M18 5H6l6 7-6 7h12"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  question: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.3 2.4c-.5.2-.8.7-.8 1.2V14M12 17.5v.5"/>',
  play: '<path d="M8 5v14l11-7z"/>',
  flow: '<path d="M3 9h12M3 15h12"/><path d="M15 6l5 6-5 6"/>',
  thermo: '<path d="M10 14V5a2 2 0 1 1 4 0v9a4 4 0 1 1-4 0z"/><path d="M12 9v7"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
};

function icon(name: string, x: number, y: number, size: number, stroke: string, width = 2): string {
  const body = LAB_ICONS[name];
  if (!body) return "";
  const scale = size / 24;
  return `<g transform="translate(${f(x)} ${f(y)}) scale(${f(scale)})" fill="none" stroke="${stroke}" stroke-width="${f(width / Math.max(scale, 0.3))}" stroke-linecap="round" stroke-linejoin="round">${body}</g>`;
}

/** Quebra de linha aproximada (largura média de caractere da Segoe UI ≈ 0,53 em). */
export function wrapText(value: string, maxWidth: number, fontSize: number): string[] {
  const perLine = Math.max(4, Math.floor(maxWidth / (fontSize * 0.53)));
  const lines: string[] = [];
  for (const paragraph of value.split(/\r?\n/)) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (!line) line = word;
      else if ((line + " " + word).length <= perLine) line += " " + word;
      else { lines.push(line); line = word; }
    }
    lines.push(line);
  }
  return lines;
}

const SANS = "'Segoe UI', system-ui, sans-serif";

/** Duração (s) das animações de `styles.css` (bloco lab-widgets). */
const ANIMATION_SECONDS: Readonly<Record<string, number>> = { "lw-wave": 2.4, "lw-flow": 0.6, "lw-spin": 0.9, "lw-bubble": 2.2, "lw-pulse": 1.6 };

/** Classe + atraso negativo pela hora: a cena redesenha o elemento a cada quadro de telemetria e a animação
 * continua da mesma fase, em vez de recomeçar a cada redesenho. */
function animation(name: string, offsetSeconds = 0, extraStyle = ""): string {
  const duration = ANIMATION_SECONDS[name] ?? 1;
  const phase = ((Date.now() / 1000 + offsetSeconds) % duration + duration) % duration;
  return ` class="${name}" style="animation-delay:-${phase.toFixed(3)}s;${extraStyle}"`;
}
const MATH_FONT = "'Cambria Math', 'STIX Two Math', 'Times New Roman', serif";

// ── Cartão ───────────────────────────────────────────────────────────────────────────────────────

/** Painel com título (ícone opcional) e texto: "Processo em tempo real", "Explore:", uma pergunta. */
export function cardSvg(p: Props, box: Box): string {
  const defs = new Defs();
  const { width: W, height: H } = box;
  const variant = (["dark", "light", "glass", "accent"].includes(str(p, "variant", "dark")) ? str(p, "variant", "dark") : "dark") as CardVariant;
  const accent = color(p, "accentColor", LAB_THEME.sky);
  const title = str(p, "title", "");
  const body = str(p, "text", "");
  const iconName = str(p, "icon", "none");
  const titleSize = clamp(num(p, "titleSize", 18), 8, 72);
  const textSize = clamp(num(p, "textSize", 15), 8, 72);
  const titleStyle = str(p, "titleStyle", "pill");
  const ink = variant === "light" ? LAB_THEME.lightInk : LAB_THEME.ink;
  const muted = variant === "light" ? LAB_THEME.lightMuted : "#c7d4e6";
  const parts = [cardBackground(defs, box, variant, accent)];
  let y = 18;
  if (title) {
    const hasIcon = iconName !== "none" && Boolean(LAB_ICONS[iconName]);
    const iconSize = titleSize * 1.25;
    const titleColor = titleStyle === "accent" ? accent : ink;
    const titleWidth = title.length * titleSize * 0.56 + (hasIcon ? iconSize + 10 : 0);
    if (titleStyle === "pill") {
      parts.push(`<rect x="14" y="12" width="${f(titleWidth + 26)}" height="${f(titleSize * 1.9)}" rx="${f(titleSize * 0.6)}" fill="${variant === "light" ? "#e8eef7" : "rgba(4,14,32,0.55)"}" stroke="${variant === "light" ? "#d5dfeb" : "rgba(148,163,184,0.18)"}"/>`);
    }
    const cy = 12 + titleSize * 0.95;
    let tx = 27;
    if (hasIcon) { parts.push(icon(iconName, tx, cy - iconSize / 2, iconSize, accent, 2)); tx += iconSize + 9; }
    parts.push(`<text x="${f(tx)}" y="${f(cy)}" dominant-baseline="central" font-family="${SANS}" font-size="${f(titleSize)}" font-weight="700" fill="${titleColor}">${escapeXml(title)}</text>`);
    y = 12 + titleSize * 1.9 + 14;
  }
  if (body) {
    const lines = wrapText(body, W - 40, textSize);
    const lineHeight = textSize * 1.38;
    lines.forEach((line, index) => {
      parts.push(`<text x="27" y="${f(y + textSize + index * lineHeight)}" font-family="${SANS}" font-size="${f(textSize)}" fill="${muted}">${escapeXml(line)}</text>`);
    });
  }
  return defs.toString() + parts.join("");
}

// ── Planta: canais e parâmetros ──────────────────────────────────────────────────────────────────

/** Nome, símbolo e unidade de cada série de planta (e da vazão líquida `q` derivada no tanque). */
export const PLANT_CHANNEL_INFO: Readonly<Record<string, { label: string; symbol: string; unit: string }>> = {
  V: { label: "volume do tanque", symbol: "V", unit: "L" },
  h: { label: "nível do tanque", symbol: "h", unit: "m" },
  A: { label: "área do tanque", symbol: "A", unit: "m²" },
  q: { label: "vazão líquida", symbol: "q", unit: "L/s" },
  inActual: { label: "vazão de entrada", symbol: "qₑ", unit: "L/s" },
  outActual: { label: "vazão de saída", symbol: "qₛ", unit: "L/s" },
  qOutDemand: { label: "saída pedida", symbol: "qₛ*", unit: "L/s" },
  overflow: { label: "transbordo", symbol: "q_tr", unit: "L/s" },
  cumIn: { label: "volume que entrou", symbol: "∫qₑ", unit: "L" },
  cumOut: { label: "volume que saiu", symbol: "∫qₛ", unit: "L" },
  y: { label: "saída", symbol: "y", unit: "" },
  u: { label: "entrada (degrau)", symbol: "u", unit: "" },
  p: { label: "pressão", symbol: "P", unit: "kPa" },
  i: { label: "corrente no laço", symbol: "I", unit: "mA" },
  iRaw: { label: "corrente sem saturação", symbol: "I*", unit: "mA" },
};

export const displayUnit = (unit: string): string => (unit === "m2" ? "m²" : unit === "1" ? "" : unit);

/** Unidade da integral no tempo (L/s · s = L). */
function integralUnit(unit: string): string {
  const match = /^(.*)\/s$/.exec(unit);
  return match ? match[1]! : unit ? `${unit}·s` : "s";
}

export interface PlantRuntime {
  buffer?: SeriesBuffer;
  parameters: Record<string, number>;
  error?: string;
  status: "running" | "paused" | "stopped";
}

export function plantRuntimeOf(p: Props): PlantRuntime {
  const buffer = p.__plant_buffer as SeriesBuffer | undefined;
  const parameters = (p.__plant_params && typeof p.__plant_params === "object" ? p.__plant_params : {}) as Record<string, number>;
  const status = p.__sim_status === "running" || p.__sim_status === "paused" ? p.__sim_status : "stopped";
  return { buffer: buffer && typeof buffer.length === "number" ? buffer : undefined, parameters, error: typeof p.__plant_error === "string" ? p.__plant_error : undefined, status };
}

export function plantSpecByKind(kind: unknown): PlantSpec | undefined {
  return typeof kind === "string" && kind in PLANTS ? PLANTS[kind as keyof typeof PLANTS] : undefined;
}

/** Último valor gravado de um canal (ou NaN). */
function lastValue(buffer: SeriesBuffer | undefined, channel: string): number {
  return buffer && buffer.length > 0 && buffer.has(channel) ? buffer.last(channel) : NaN;
}

function centered(W: number, H: number, value: string, fill: string, size = 14): string {
  return `<text x="${f(W / 2)}" y="${f(H / 2)}" text-anchor="middle" dominant-baseline="central" font-family="${SANS}" font-size="${size}" fill="${fill}">${escapeXml(value)}</text>`;
}

// ── Gráfico de série do processo ─────────────────────────────────────────────────────────────────

export interface ChartState { cursor?: number; a?: number; b?: number }

export interface SeriesChartFrame {
  area: { L: number; T: number; W: number; H: number };
  t0: number;
  t1: number;
  y0: number;
  y1: number;
  /** Instante do cursor, de a e de b (já resolvidos: cursor "no presente" = agora). */
  cursor: number;
  a: number;
  b: number;
}

function niceStep(span: number, count = 6): number {
  const raw = Math.abs(span) / count;
  const power = 10 ** Math.floor(Math.log10(raw || 1));
  const unit = raw / power;
  return (unit < 1.5 ? 1 : unit < 3.5 ? 2 : unit < 7.5 ? 5 : 10) * power;
}
/** Teto "bonito" (1, 2, 2.5, 5 × 10^k): o eixo do tempo cresce aos saltos, sem tremer a cada quadro. */
function niceCeil(value: number): number {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const unit of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (unit * power >= value - 1e-12) return unit * power;
  return 10 * power;
}

/** Geometria do gráfico (também usada pela cena para levar o ponteiro ao tempo). */
export function seriesChartFrame(p: Props, box: Box, buffer: SeriesBuffer | undefined, state: ChartState = {}): SeriesChartFrame {
  const { width: W, height: H } = box;
  const title = str(p, "title", "");
  const top = title ? 64 : 22;
  const area = { L: 62, T: top, W: Math.max(20, W - 62 - 22), H: Math.max(20, H - top - 44) };
  const channel = str(p, "channel", "h");
  const now = buffer && buffer.length > 0 ? buffer.now : 0;
  const windowSeconds = num(p, "windowSeconds", 0);
  const minSpan = Math.max(1, num(p, "minSeconds", 10));
  const span = Math.max(minSpan, now * 1.02);
  const tStep = niceStep(span, 6);
  let t0 = 0, t1 = Math.max(niceCeil(minSpan), Math.ceil(span / tStep - 1e-9) * tStep);
  if (windowSeconds > 0) { t1 = Math.max(windowSeconds, now); t0 = Math.max(0, t1 - windowSeconds); }
  let y0 = num(p, "yMin", 0), y1 = num(p, "yMax", 0);
  if (!(y1 > y0)) {
    let low = Infinity, high = -Infinity;
    if (buffer && buffer.has(channel) && interpolationOf(channel) === "step-average") {
      // A mesma média por coluna do desenho: a escala não se estica por linhas de evento que não aparecem.
      const { sum, weight } = stepAverageColumns(buffer, channel, t0, t1, Math.max(1, Math.ceil(area.W)));
      for (let column = 0; column < sum.length; column++) {
        if (weight[column]! < 1e-9) continue;
        const value = sum[column]! / weight[column]!;
        low = Math.min(low, value); high = Math.max(high, value);
      }
    } else if (buffer && buffer.has(channel)) {
      const t = buffer.t, v = buffer.col(channel);
      for (let i = buffer.lowerBound(t0); i < buffer.length && t[i]! <= t1; i++) {
        const value = v[i]!;
        if (!Number.isFinite(value)) continue;
        low = Math.min(low, value); high = Math.max(high, value);
      }
    }
    if (!Number.isFinite(low)) { low = 0; high = 1; }
    if (flag(p, "includeZero", true)) { low = Math.min(low, 0); high = Math.max(high, 0); }
    if (high - low < 1e-9) { high += Math.max(Math.abs(high) * 0.1, 1e-3); low -= Math.max(Math.abs(low) * 0.1, low === 0 ? 0 : 1e-3); }
    const step = niceStep(high - low, 5);
    // Limites em múltiplos do passo; um mínimo exato (ex.: 0) fica como está, sem descer um passo.
    y0 = Math.floor(low / step + 1e-9) * step;
    y1 = Math.ceil(high / step - 1e-9) * step;
    if (y1 - high < step * 0.08) y1 += step * 0.5;
  }
  const followCursor = (value: number | undefined): number => (value === undefined || value < 0 ? now : value);
  const cursor = clamp(followCursor(state.cursor ?? num(p, "cursor", -1)), t0, Math.max(t0, now));
  let a = state.a ?? num(p, "a", 0);
  let b = followCursor(state.b ?? num(p, "b", -1));
  a = clamp(a, 0, Math.max(0, now));
  b = clamp(b, 0, Math.max(0, now));
  if (b < a) [a, b] = [b, a];
  return { area, t0, t1, y0, y1, cursor, a, b };
}

/** Como cada série vale entre amostras (`plants.ts`); a vazão líquida `q` derivada é média por passo. */
function interpolationOf(channel: string): "linear" | "zoh" | "step-average" {
  if (channel === "q") return "step-average";
  for (const plant of Object.values(PLANTS)) {
    const found = plant.series.find((candidate) => candidate.id === channel);
    if (found) return found.interpolation;
  }
  return "linear";
}

/** Média ponderada pelo tempo de uma série por passo em `columns` colunas iguais de [t0, t1]. */
function stepAverageColumns(buffer: SeriesBuffer, channel: string, t0: number, t1: number, columns: number): { sum: Float64Array; weight: Float64Array } {
  const t = buffer.t, v = buffer.col(channel);
  const sum = new Float64Array(columns), weight = new Float64Array(columns);
  const perSecond = columns / (t1 - t0);
  for (let i = Math.max(1, buffer.upperBound(t0)); i < buffer.length && t[i - 1]! < t1; i++) {
    const value = v[i]!;
    if (!Number.isFinite(value) || !(t[i]! > t[i - 1]!)) continue;
    let a = (Math.max(t0, t[i - 1]!) - t0) * perSecond, b = (Math.min(t1, t[i]!) - t0) * perSecond;
    while (b > a) {
      const column = Math.min(columns - 1, Math.floor(a)), end = Math.min(b, column + 1);
      sum[column]! += value * (end - a); weight[column]! += end - a;
      a = end;
    }
  }
  return { sum, weight };
}

/** Média por passo: em cada coluna de pixel, a média PONDERADA pelo tempo (a mesma integral da série), em
 * degraus -- linhas extras de um evento no meio de um passo não viram picos. */
function stepAveragePath(buffer: SeriesBuffer, channel: string, frame: SeriesChartFrame, X: (t: number) => number, Y: (v: number) => number): string {
  const x0 = X(frame.t0), columns = Math.max(1, Math.ceil(X(frame.t1) - x0));
  const { sum, weight } = stepAverageColumns(buffer, channel, frame.t0, frame.t1, columns);
  const parts: string[] = [];
  let pen = false;
  for (let column = 0; column < columns; column++) {
    if (weight[column]! < 1e-9) { pen = false; continue; }
    const y = f(Y(sum[column]! / weight[column]!));
    parts.push(`${pen ? "L" : "M"}${f(x0 + column)},${y}H${f(x0 + column + 1)}`);
    pen = true;
  }
  return parts.join("");
}

/** Valor mantido: degraus (horizontal até a próxima amostra, depois vertical), sem repetir valores iguais. */
function zohPath(buffer: SeriesBuffer, channel: string, frame: SeriesChartFrame, X: (t: number) => number, Y: (v: number) => number): string {
  const t = buffer.t, v = buffer.col(channel);
  const start = Math.max(0, buffer.lowerBound(frame.t0) - 1), end = Math.min(buffer.length, buffer.upperBound(frame.t1) + 1);
  const parts: string[] = [];
  let last = NaN;
  for (let i = start; i < end; i++) {
    const value = v[i]!;
    if (!Number.isFinite(value)) { last = NaN; continue; }
    if (!Number.isFinite(last)) parts.push(`M${f(X(t[i]!))},${f(Y(value))}`);
    else if (value !== last) parts.push(`H${f(X(t[i]!))}V${f(Y(value))}`);
    last = value;
  }
  if (Number.isFinite(last) && end > start) parts.push(`H${f(X(t[end - 1]!))}`);
  return parts.join("");
}

/** Curva por colunas de pixel (mínimo e máximo de cada coluna): milhares de linhas sem perder picos. */
function seriesPath(buffer: SeriesBuffer, channel: string, frame: SeriesChartFrame, X: (t: number) => number, Y: (v: number) => number): string {
  const interpolation = interpolationOf(channel);
  if (interpolation === "step-average") return stepAveragePath(buffer, channel, frame, X, Y);
  if (interpolation === "zoh") return zohPath(buffer, channel, frame, X, Y);
  const t = buffer.t, v = buffer.col(channel);
  const start = Math.max(0, buffer.lowerBound(frame.t0) - 1);
  const end = Math.min(buffer.length, buffer.upperBound(frame.t1) + 1);
  const parts: string[] = [];
  let pen = false;
  let column = NaN, low = 0, high = 0, firstY = 0, lastY = 0;
  const flush = (): void => {
    if (!Number.isFinite(column)) return;
    parts.push(`${pen ? "L" : "M"}${f(column)},${f(firstY)}`);
    if (high - low > 0.6) parts.push(`L${f(column)},${f(low)}L${f(column)},${f(high)}`);
    parts.push(`L${f(column)},${f(lastY)}`);
    pen = true;
  };
  for (let i = start; i < end; i++) {
    const value = v[i]!;
    if (!Number.isFinite(value)) { flush(); column = NaN; pen = false; continue; }
    const x = Math.round(X(t[i]!) * 2) / 2, y = Y(value);
    if (x !== column) { flush(); column = x; low = high = firstY = lastY = y; continue; }
    low = Math.min(low, y); high = Math.max(high, y); lastY = y;
  }
  flush();
  return parts.join("");
}

/** Derivada no instante t pela própria série (diferença central de ±h, ou para trás no presente). */
function slopeAt(buffer: SeriesBuffer, channel: string, t: number, span: number): number {
  const h = Math.max(span / 300, 0.02);
  const lo = Math.max(buffer.t[0] ?? 0, t - h), hi = Math.min(buffer.now, t + h);
  if (!(hi > lo)) return NaN;
  const vLo = buffer.linearAt(channel, lo, true).value, vHi = buffer.linearAt(channel, hi, false).value;
  return (vHi - vLo) / (hi - lo);
}

const RIEMANN_LABEL: Record<RiemannMethodName, string> = { left: "esquerda", right: "direita", midpoint: "ponto médio", trapezoid: "trapézio" };

/** Gráfico de uma série gravada da planta com reta tangente, secante e soma de Riemann. */
export function seriesChartSvg(p: Props, box: Box): string {
  const defs = new Defs();
  const { width: W, height: H } = box;
  const runtime = plantRuntimeOf(p);
  const buffer = runtime.buffer;
  const variant = str(p, "variant", "light") === "dark" ? "dark" : "light";
  const dark = variant === "dark";
  const ink = dark ? LAB_THEME.ink : LAB_THEME.lightInk;
  const muted = dark ? LAB_THEME.muted : LAB_THEME.lightMuted;
  const grid = dark ? "rgba(148,163,184,0.16)" : LAB_THEME.grid;
  const axis = dark ? "#9fb1c9" : "#334155";
  const channel = str(p, "channel", "h");
  const info = PLANT_CHANNEL_INFO[channel] ?? { label: channel, symbol: channel, unit: "" };
  const unit = str(p, "unit", "") || info.unit;
  const symbol = str(p, "symbol", "") || info.symbol;
  const curveColor = color(p, "color", LAB_THEME.blue);
  const title = str(p, "title", "");
  const parts = [cardBackground(defs, box, dark ? "dark" : "light", curveColor)];
  if (title) parts.push(`<text x="22" y="38" font-family="${SANS}" font-size="${f(clamp(num(p, "titleSize", 22), 10, 48))}" font-weight="700" fill="${ink}">${escapeXml(title)}</text>`);
  if (runtime.error) return defs.toString() + parts.join("") + centered(W, H, runtime.error, LAB_THEME.red, 13);
  if (!str(p, "plantComponentId", "")) return defs.toString() + parts.join("") + centered(W, H, "Escolha a planta (Componente › Planta).", muted, 13);

  const state = (p.__chart_state && typeof p.__chart_state === "object" ? p.__chart_state : {}) as ChartState;
  const frame = seriesChartFrame(p, box, buffer, state);
  const { area } = frame;
  const X = (t: number): number => area.L + ((t - frame.t0) / (frame.t1 - frame.t0)) * area.W;
  const Y = (v: number): number => area.T + (1 - (v - frame.y0) / (frame.y1 - frame.y0)) * area.H;
  const bottom = area.T + area.H, right = area.L + area.W;

  // Grade e marcas
  const axisParts: string[] = [];
  const xStep = niceStep(frame.t1 - frame.t0, Math.max(3, Math.round(area.W / 90)));
  const cursorShown = (flag(p, "showTangent", false) || flag(p, "showCursor", true)) && buffer !== undefined && buffer.length > 1;
  for (let x = Math.ceil(frame.t0 / xStep) * xStep; x <= frame.t1 + xStep * 1e-6; x += xStep) {
    const px = X(x);
    axisParts.push(`<line x1="${f(px)}" y1="${f(area.T)}" x2="${f(px)}" y2="${f(bottom)}" stroke="${grid}"/>`);
    if (cursorShown && Math.abs(px - X(frame.cursor)) < 46) continue;
    axisParts.push(`<text x="${f(px)}" y="${f(bottom + 18)}" text-anchor="middle" font-family="${SANS}" font-size="12" fill="${muted}">${escapeXml(fmt(x, 2))}</text>`);
  }
  const yStep = niceStep(frame.y1 - frame.y0, Math.max(2, Math.round(area.H / 55)));
  for (let y = Math.ceil(frame.y0 / yStep - 1e-9) * yStep; y <= frame.y1 + yStep * 1e-6; y += yStep) {
    const py = Y(y);
    axisParts.push(`<line x1="${f(area.L)}" y1="${f(py)}" x2="${f(right)}" y2="${f(py)}" stroke="${grid}"/>`);
    axisParts.push(`<text x="${f(area.L - 8)}" y="${f(py)}" text-anchor="end" dominant-baseline="central" font-family="${SANS}" font-size="12" fill="${muted}">${escapeXml(fmt(Math.abs(y) < yStep * 1e-6 ? 0 : y, 3))}</text>`);
  }
  // Eixos com seta (como no quadro): y à esquerda, t embaixo (ou em y = 0).
  const zeroY = frame.y0 <= 0 && frame.y1 >= 0 ? Y(0) : bottom;
  axisParts.push(`<path d="M${f(area.L)},${f(bottom + 4)}V${f(area.T - 10)}" stroke="${axis}" stroke-width="1.6" fill="none"/>`);
  axisParts.push(`<path d="M${f(area.L - 4)},${f(area.T - 4)}L${f(area.L)},${f(area.T - 12)}L${f(area.L + 4)},${f(area.T - 4)}z" fill="${axis}"/>`);
  axisParts.push(`<path d="M${f(area.L - 4)},${f(zeroY)}H${f(right + 10)}" stroke="${axis}" stroke-width="1.6" fill="none"/>`);
  axisParts.push(`<path d="M${f(right + 4)},${f(zeroY - 4)}L${f(right + 12)},${f(zeroY)}L${f(right + 4)},${f(zeroY + 4)}z" fill="${axis}"/>`);
  const yLabel = str(p, "yLabel", "") || `${symbol}${unit ? ` (${unit})` : ""}`;
  axisParts.push(`<text x="${f(area.L + 10)}" y="${f(area.T - 6)}" font-family="${MATH_FONT}" font-style="italic" font-size="15" fill="${ink}">${escapeXml(yLabel)}</text>`);
  axisParts.push(`<text x="${f(right)}" y="${f(bottom + 34)}" text-anchor="end" font-family="${MATH_FONT}" font-style="italic" font-size="15" fill="${ink}">t (s)</text>`);
  parts.push(axisParts.join(""));

  const ready = buffer !== undefined && buffer.length > 1 && buffer.has(channel);
  if (!ready) {
    const waiting = runtime.status === "stopped" ? "Execute a simulação (▶) para gravar a série." : "Aguardando a série do simulador…";
    return defs.toString() + parts.join("") + centered(area.L + area.W / 2, area.T * 2 + area.H, waiting, muted, 14);
  }

  const clip = defs.add("clip", (id) => `<clipPath id="${id}"><rect x="${f(area.L)}" y="${f(area.T - 2)}" width="${f(area.W)}" height="${f(area.H + 4)}"/></clipPath>`);
  const plot: string[] = [];
  const legend: Array<{ swatch: string; label: string }> = [];
  const curveLabel = str(p, "curveLabel", "") || `${symbol}(t) – ${info.label}`;
  const showRiemann = flag(p, "showRiemann", false);
  const showArea = flag(p, "showArea", false) || showRiemann;
  const showTangent = flag(p, "showTangent", false);
  const showSecant = flag(p, "showSecant", false);
  const method = (["left", "right", "midpoint", "trapezoid"].includes(str(p, "riemannMethod", "left")) ? str(p, "riemannMethod", "left") : "left") as RiemannMethodName;
  const n = Math.round(clamp(num(p, "riemannN", 12), 1, 400));
  const readouts: string[] = [];
  const hasInterval = frame.b - frame.a > 1e-6;

  if (showArea && hasInterval) {
    // Área exata sob a série entre a e b (degraus gravados), por baixo dos retângulos.
    const t = buffer.t, v = buffer.col(channel);
    const points: string[] = [`M${f(X(frame.a))},${f(Y(0))}`];
    for (let i = Math.max(1, buffer.upperBound(frame.a)); i < buffer.length && t[i - 1]! < frame.b; i++) {
      const value = v[i]!;
      if (!Number.isFinite(value)) continue;
      const x0 = Math.max(frame.a, t[i - 1]!), x1 = Math.min(frame.b, t[i]!);
      points.push(`L${f(X(x0))},${f(Y(value))}L${f(X(x1))},${f(Y(value))}`);
    }
    points.push(`L${f(X(frame.b))},${f(Y(0))}Z`);
    plot.push(`<path d="${points.join("")}" fill="${curveColor}" fill-opacity="0.12" stroke="none"/>`);
    const exact = buffer.stepIntegral(channel, frame.a, frame.b);
    legend.push({ swatch: `<rect width="18" height="11" y="-6" fill="${curveColor}" fill-opacity="0.18"/>`, label: `Área = ∫ ${symbol}(τ) dτ` });
    readouts.push(`∫ = ${fmt(exact, 4)}${integralUnit(unit) ? ` ${integralUnit(unit)}` : ""}`);
  }
  if (showRiemann && hasInterval) {
    const { sum, bars } = riemannOnSteps(buffer, channel, frame.a, frame.b, n, method);
    for (const bar of bars) {
      if (!Number.isFinite(bar.height)) continue;
      const x0 = X(bar.x0), x1 = X(bar.x1), y = Y(bar.height), y0 = Y(0);
      plot.push(`<rect x="${f(x0)}" y="${f(Math.min(y, y0))}" width="${f(Math.max(0.5, x1 - x0))}" height="${f(Math.abs(y0 - y))}" fill="#93c5fd" fill-opacity="0.55" stroke="${LAB_THEME.blue}" stroke-width="1"/>`);
    }
    legend.push({ swatch: `<rect width="18" height="11" y="-6" fill="#93c5fd" fill-opacity="0.7" stroke="${LAB_THEME.blue}"/>`, label: "Retângulos de Riemann" });
    readouts.unshift(`Σ ${RIEMANN_LABEL[method]}, n = ${n}: ${fmt(sum, 4)}${integralUnit(unit) ? ` ${integralUnit(unit)}` : ""}`);
  }
  plot.push(`<path d="${seriesPath(buffer, channel, frame, X, Y)}" fill="none" stroke="${curveColor}" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>`);
  legend.unshift({ swatch: `<line x1="0" x2="18" stroke="${curveColor}" stroke-width="3" stroke-linecap="round"/>`, label: curveLabel });

  // Eventos de parâmetro (mudança feita durante a execução)
  if (flag(p, "showEvents", true)) {
    for (const event of buffer.events) {
      if (event.kind !== "parameter" || event.tS < frame.t0 || event.tS > frame.t1) continue;
      plot.push(`<line x1="${f(X(event.tS))}" y1="${f(area.T)}" x2="${f(X(event.tS))}" y2="${f(bottom)}" stroke="${LAB_THEME.violet}" stroke-opacity="0.45" stroke-dasharray="2 4"/>`);
    }
  }
  if (showSecant && hasInterval) {
    const va = buffer.linearAt(channel, frame.a).value, vb = buffer.linearAt(channel, frame.b).value;
    if (Number.isFinite(va) && Number.isFinite(vb)) {
      const slope = (vb - va) / (frame.b - frame.a);
      const extend = (frame.t1 - frame.t0) * 0.04;
      const ta = Math.max(frame.t0, frame.a - extend), tb = Math.min(frame.t1, frame.b + extend);
      plot.push(`<line x1="${f(X(ta))}" y1="${f(Y(va + slope * (ta - frame.a)))}" x2="${f(X(tb))}" y2="${f(Y(va + slope * (tb - frame.a)))}" stroke="${dark ? "#cbd5e1" : "#334155"}" stroke-width="1.8" stroke-dasharray="7 5"/>`);
      for (const [tt, vv] of [[frame.a, va], [frame.b, vb]] as const) plot.push(`<circle cx="${f(X(tt))}" cy="${f(Y(vv))}" r="4.5" fill="${dark ? "#e2e8f0" : "#334155"}"/>`);
      legend.push({ swatch: `<line x1="0" x2="18" stroke="${dark ? "#cbd5e1" : "#334155"}" stroke-width="2" stroke-dasharray="5 3"/>`, label: "Reta secante" });
      readouts.push(`Δ${symbol}/Δt = ${fmt(slope, 4)}${unit ? ` ${unit}/s` : ""}`);
    }
  }
  if (showTangent) {
    const value = buffer.linearAt(channel, frame.cursor).value;
    const slope = slopeAt(buffer, channel, frame.cursor, frame.t1 - frame.t0);
    if (Number.isFinite(value) && Number.isFinite(slope)) {
      const half = (frame.t1 - frame.t0) * 0.14;
      const ta = Math.max(frame.t0, frame.cursor - half), tb = Math.min(frame.t1, frame.cursor + half);
      plot.push(`<line x1="${f(X(ta))}" y1="${f(Y(value + slope * (ta - frame.cursor)))}" x2="${f(X(tb))}" y2="${f(Y(value + slope * (tb - frame.cursor)))}" stroke="${LAB_THEME.orange}" stroke-width="2.6" stroke-linecap="round"/>`);
      // Rótulo acima da ponta mais alta da tangente, sem sair da área.
      const ends = [[ta, value + slope * (ta - frame.cursor)], [tb, value + slope * (tb - frame.cursor)]] as const;
      const [tt, vv] = Y(ends[0][1]) < Y(ends[1][1]) ? ends[0] : ends[1];
      const text = `Inclinação = d${symbol}/dt ≈ ${fmt(slope, 4)}${unit ? ` ${unit}/s` : ""}`;
      const width = text.length * 7.4;
      const lx = clamp(X(tt) - width / 2, area.L + 6, right - width - 6);
      plot.push(`<text x="${f(lx)}" y="${f(clamp(Y(vv) - 16, area.T + 30, bottom - 8))}" font-family="${SANS}" font-size="14" font-weight="600" fill="${LAB_THEME.orange}" stroke="${dark ? "#0f2447" : "#ffffff"}" stroke-width="4" paint-order="stroke">${escapeXml(text)}</text>`);
      legend.push({ swatch: `<line x1="0" x2="18" stroke="${LAB_THEME.orange}" stroke-width="3" stroke-linecap="round"/>`, label: `Reta tangente (d${symbol}/dt)` });
    }
  }
  // Cursor (instante inspecionado) com o ponto sobre a curva
  if (showTangent || flag(p, "showCursor", true)) {
    const value = buffer.linearAt(channel, frame.cursor).value;
    plot.push(`<line x1="${f(X(frame.cursor))}" y1="${f(area.T)}" x2="${f(X(frame.cursor))}" y2="${f(bottom)}" stroke="${dark ? "#94a3b8" : "#475569"}" stroke-width="1.2" stroke-dasharray="5 4"/>`);
    if (Number.isFinite(value)) plot.push(`<circle cx="${f(X(frame.cursor))}" cy="${f(Y(value))}" r="6" fill="${curveColor}" stroke="#ffffff" stroke-width="2.5"/>`);
    parts.push(`<text x="${f(X(frame.cursor))}" y="${f(bottom + 18)}" text-anchor="middle" font-family="${MATH_FONT}" font-style="italic" font-size="15" font-weight="700" fill="${curveColor}" stroke="${dark ? "#0f2447" : "#ffffff"}" stroke-width="5" paint-order="stroke">t = ${escapeXml(fmt(frame.cursor, 2))}</text>`);
  }
  // Intervalo [a, b] com alças para arrastar (as alças ficam fora do recorte: em t = 0 não somem)
  const handles: string[] = [];
  if ((showRiemann || showSecant || showArea) && hasInterval) {
    for (const [name, tt] of [["a", frame.a], ["b", frame.b]] as const) {
      plot.push(`<line x1="${f(X(tt))}" y1="${f(area.T)}" x2="${f(X(tt))}" y2="${f(bottom)}" stroke="${LAB_THEME.violet}" stroke-width="1.8"/>`);
      handles.push(`<circle cx="${f(X(tt))}" cy="${f(area.T + 11)}" r="9" fill="${LAB_THEME.violet}" stroke="#ffffff" stroke-width="2"/>`);
      handles.push(`<text x="${f(X(tt))}" y="${f(area.T + 11)}" text-anchor="middle" dominant-baseline="central" font-family="${MATH_FONT}" font-style="italic" font-size="13" font-weight="700" fill="#ffffff">${name}</text>`);
    }
  }
  parts.push(`<g clip-path="url(#${clip})">${plot.join("")}</g>`, handles.join(""));

  if (readouts.length) {
    parts.push(`<text x="${f(W - 22)}" y="38" text-anchor="end" font-family="${SANS}" font-size="13.5" font-weight="600" fill="${muted}">${escapeXml(readouts.join("   ·   "))}</text>`);
  }
  if (flag(p, "showLegend", true) && legend.length) {
    const rowH = 22, lw = Math.max(...legend.map((row) => row.label.length)) * 7.6 + 50, lh = legend.length * rowH + 12;
    const corners: Array<[number, number]> = [[right - lw - 8, bottom - lh - 10], [right - lw - 8, area.T + 26], [area.L + 10, area.T + 26], [area.L + 10, bottom - lh - 10]];
    const position = str(p, "legendPosition", "auto");
    const fixedCorner = { "bottom-right": 0, "top-right": 1, "top-left": 2, "bottom-left": 3 }[position];
    // Automático: o canto que a curva menos atravessa.
    const crowding = ([cx0, cy0]: [number, number]): number => {
      let hits = 0;
      for (let k = 0; k <= 24; k++) {
        const tt = frame.t0 + ((cx0 + (lw * k) / 24 - area.L) / area.W) * (frame.t1 - frame.t0);
        const vv = buffer.linearAt(channel, tt).value;
        if (!Number.isFinite(vv)) continue;
        // Com área ou retângulos, conta tudo entre a curva e o zero dentro de [a, b].
        const filled = showArea && hasInterval && tt >= frame.a && tt <= frame.b;
        const top = Math.min(Y(vv), filled ? Y(0) : Y(vv)), low = Math.max(Y(vv), filled ? Y(0) : Y(vv));
        if (low >= cy0 - 8 && top <= cy0 + lh + 8) hits++;
      }
      return hits;
    };
    const [lx, ly] = fixedCorner !== undefined ? corners[fixedCorner]! : corners.reduce((best, corner) => (crowding(corner) < crowding(best) ? corner : best));
    parts.push(`<g transform="translate(${f(lx)} ${f(ly)})"><rect width="${f(lw)}" height="${f(lh)}" rx="8" fill="${dark ? "rgba(8,20,40,0.82)" : "rgba(255,255,255,0.92)"}" stroke="${dark ? "rgba(148,163,184,0.25)" : "#d6e0ec"}"/>${legend.map((row, index) =>
      `<g transform="translate(12 ${f(17 + index * rowH)})">${row.swatch}<text x="28" y="0" dominant-baseline="central" font-family="${SANS}" font-size="13" fill="${ink}">${escapeXml(row.label)}</text></g>`).join("")}</g>`);
  }
  return defs.toString() + parts.join("");
}

// ── Tanque de processo ───────────────────────────────────────────────────────────────────────────

/** Tanque vetorial animado: vidro e aço, líquido com superfície, régua de nível, jatos de entrada e saída. */
export function processTankSvg(p: Props, box: Box): string {
  const defs = new Defs();
  const { width: W, height: H } = box;
  const runtime = plantRuntimeOf(p);
  const buffer = runtime.buffer;
  const params = runtime.parameters;
  const running = runtime.status === "running";
  const plantBound = Boolean(str(p, "plantComponentId", ""));
  const liquid = color(p, "liquidColor", "#1e88e5");
  const showScale = flag(p, "showScale", true);
  const showValues = flag(p, "showValues", true);

  // Dados: da planta (h/V/A/vazões) ou do binding genérico (valor em %)
  const hMax = num(p, "scaleMax", 0) > 0 ? num(p, "scaleMax", 1) : params.hMax ?? 1;
  const h = plantBound ? lastValue(buffer, "h") : NaN;
  const genericPercent = !plantBound ? num(p, "__g_value", num(p, "value", 50)) : NaN;
  const fraction = clamp(plantBound ? (Number.isFinite(h) ? h / hMax : (params.v0 ?? 0) / 1000 / (params.area ?? 0.1) / hMax) : genericPercent / 100, 0, 1);
  const recorded = plantBound && buffer !== undefined && buffer.length > 0;
  // Sem série gravada (antes de executar), o que a planta vai usar: V₀ e as vazões configuradas.
  const volume = plantBound ? (recorded ? lastValue(buffer, "V") : params.v0 ?? NaN) : NaN;
  const areaValue = plantBound ? (Number.isFinite(lastValue(buffer, "A")) ? lastValue(buffer, "A") : params.area ?? NaN) : NaN;
  const inFlow = plantBound ? (recorded && Number.isFinite(lastValue(buffer, "inActual")) ? lastValue(buffer, "inActual") : params.qIn ?? 0) : 0;
  const outFlow = plantBound ? (recorded && Number.isFinite(lastValue(buffer, "outActual")) ? lastValue(buffer, "outActual") : params.qOut ?? 0) : 0;
  // Jato e fluxo só com água correndo de fato (executando, ou pausado com a última vazão gravada).
  const flowing = recorded && runtime.status !== "stopped";
  const overflow = plantBound ? lastValue(buffer, "overflow") : NaN;
  const unmet = plantBound ? lastValue(buffer, "unmet") : NaN;
  const outlet = Math.round(params.outlet ?? num(p, "outletKind", 0));

  // Geometria (proporcional à caixa)
  const bodyX = W * 0.2, bodyW = W * 0.46, cx = bodyX + bodyW / 2;
  const bodyTop = H * 0.2, bodyBottom = H * 0.78;
  const ry = Math.max(4, bodyW * 0.11);
  const levelY = bodyBottom - fraction * (bodyBottom - bodyTop);
  const steel = defs.add("steel", (id) => `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#6b7280"/><stop offset="0.18" stop-color="#e5e7eb"/><stop offset="0.45" stop-color="#9ca3af"/><stop offset="0.75" stop-color="#d1d5db"/><stop offset="1" stop-color="#4b5563"/></linearGradient>`);
  const steelV = defs.add("steelv", (id) => `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f3f4f6"/><stop offset="0.45" stop-color="#9ca3af"/><stop offset="1" stop-color="#4b5563"/></linearGradient>`);
  const glass = defs.add("glass", (id) => `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffffff" stop-opacity="0.30"/><stop offset="0.12" stop-color="#ffffff" stop-opacity="0.10"/><stop offset="0.55" stop-color="#ffffff" stop-opacity="0.04"/><stop offset="0.9" stop-color="#ffffff" stop-opacity="0.16"/><stop offset="1" stop-color="#ffffff" stop-opacity="0.06"/></linearGradient>`);
  const water = defs.add("water", (id) => `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7dd3fc" stop-opacity="0.92"/><stop offset="0.45" stop-color="${liquid}" stop-opacity="0.88"/><stop offset="1" stop-color="#1e3a8a" stop-opacity="0.95"/></linearGradient>`);
  const waterSide = defs.add("waterside", (id) => `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffffff" stop-opacity="0.28"/><stop offset="0.2" stop-color="#ffffff" stop-opacity="0"/><stop offset="0.85" stop-color="#000000" stop-opacity="0"/><stop offset="1" stop-color="#000000" stop-opacity="0.22"/></linearGradient>`);
  const stream = defs.add("stream", (id) => `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#bae6fd" stop-opacity="0.75"/><stop offset="0.5" stop-color="#38bdf8" stop-opacity="0.95"/><stop offset="1" stop-color="#0284c7" stop-opacity="0.8"/></linearGradient>`);
  const interior = `M${f(bodyX)},${f(bodyTop)}V${f(bodyBottom)}A${f(bodyW / 2)},${f(ry)} 0 0 0 ${f(bodyX + bodyW)},${f(bodyBottom)}V${f(bodyTop)}Z`;
  const clip = defs.add("tankclip", (id) => `<clipPath id="${id}"><path d="${interior}"/></clipPath>`);
  const parts: string[] = [];
  const animated = (cls: string, extraStyle = ""): string => (running ? animation(cls, 0, extraStyle) : extraStyle ? ` style="${extraStyle}"` : "");

  // Entrada: tubo que vem da esquerda e desce sobre o tanque
  const pipeR = Math.max(5, W * 0.022);
  const mouthX = bodyX + bodyW * 0.3, pipeY = H * 0.085;
  parts.push(`<rect x="0" y="${f(pipeY - pipeR)}" width="${f(mouthX - pipeR)}" height="${f(pipeR * 2)}" fill="url(#${steelV})"/>`);
  parts.push(`<path d="M${f(mouthX - pipeR)},${f(pipeY - pipeR)}A${f(pipeR * 2)},${f(pipeR * 2)} 0 0 1 ${f(mouthX + pipeR)},${f(pipeY + pipeR)}V${f(bodyTop - ry - 2)}H${f(mouthX - pipeR)}V${f(pipeY + pipeR)}H${f(mouthX - pipeR)}Z" fill="url(#${steel})"/>`);
  parts.push(`<rect x="${f(mouthX - pipeR * 1.5)}" y="${f(bodyTop - ry - 6)}" width="${f(pipeR * 3)}" height="6" rx="1.5" fill="url(#${steel})"/>`);
  parts.push(`<rect x="2" y="${f(pipeY - pipeR * 1.5)}" width="6" height="${f(pipeR * 3)}" rx="1.5" fill="url(#${steel})"/>`);

  // Corpo: parede de fundo, líquido, vidro, aros
  parts.push(`<path d="${interior}" fill="rgba(4,14,32,0.55)"/>`);
  parts.push(`<ellipse cx="${f(cx)}" cy="${f(bodyTop)}" rx="${f(bodyW / 2)}" ry="${f(ry)}" fill="rgba(4,14,32,0.65)"/>`);
  if (fraction > 0.002) {
    const liquidParts = [
      `<rect x="${f(bodyX)}" y="${f(levelY)}" width="${f(bodyW)}" height="${f(bodyBottom - levelY + ry + 1)}" fill="url(#${water})"/>`,
      `<rect x="${f(bodyX)}" y="${f(levelY)}" width="${f(bodyW)}" height="${f(bodyBottom - levelY + ry + 1)}" fill="url(#${waterSide})"/>`,
    ];
    // Bolhas sobem enquanto entra água
    if (inFlow > 0 && running) {
      for (let k = 0; k < 7; k++) {
        const bx = mouthX - bodyW * 0.08 + ((k * 37) % 17) * bodyW * 0.012, by = levelY + 10 + ((k * 53) % 60) / 60 * Math.max(10, bodyBottom - levelY - 16);
        liquidParts.push(`<circle${animation("lw-bubble", k * 0.31)} cx="${f(bx)}" cy="${f(by)}" r="${f(1.2 + (k % 3))}" fill="#e0f2fe" fill-opacity="0.55"/>`);
      }
    }
    parts.push(`<g clip-path="url(#${clip})">${liquidParts.join("")}</g>`);
    // Superfície com ondulação
    const waveW = bodyW / 3;
    let wave = `M${f(bodyX - waveW * 2)},${f(levelY)}`;
    for (let k = 0; k < 9; k++) wave += `q${f(waveW / 4)},${f(-ry * 0.32)} ${f(waveW / 2)},0t${f(waveW / 2)},0`;
    wave += `V${f(levelY + ry * 1.2)}H${f(bodyX - waveW * 2)}Z`;
    parts.push(`<g clip-path="url(#${clip})"><ellipse cx="${f(cx)}" cy="${f(levelY)}" rx="${f(bodyW / 2)}" ry="${f(ry * 0.85)}" fill="#bae6fd" fill-opacity="0.55"/><path${animated("lw-wave", `--lw-dx:${f(waveW)}px`)} d="${wave}" fill="#e0f2fe" fill-opacity="0.35"/></g>`);
  }
  parts.push(`<path d="${interior}" fill="url(#${glass})" stroke="rgba(226,232,240,0.55)" stroke-width="1.6"/>`);
  parts.push(`<rect x="${f(bodyX + bodyW * 0.07)}" y="${f(bodyTop + ry * 0.6)}" width="${f(bodyW * 0.05)}" height="${f((bodyBottom - bodyTop) * 0.82)}" rx="${f(bodyW * 0.025)}" fill="#ffffff" fill-opacity="0.22"/>`);
  parts.push(`<ellipse cx="${f(cx)}" cy="${f(bodyTop)}" rx="${f(bodyW / 2 + 2)}" ry="${f(ry + 1)}" fill="none" stroke="url(#${steel})" stroke-width="5"/>`);
  parts.push(`<path d="M${f(bodyX - 2)},${f(bodyBottom)}A${f(bodyW / 2 + 2)},${f(ry + 1)} 0 0 0 ${f(bodyX + bodyW + 2)},${f(bodyBottom)}" fill="none" stroke="url(#${steel})" stroke-width="5"/>`);
  // Base e pés (com sombra no chão)
  const baseY = bodyBottom + ry + 2;
  parts.push(`<ellipse cx="${f(cx)}" cy="${f(baseY + H * 0.098)}" rx="${f(bodyW * 0.62)}" ry="${f(Math.max(3, H * 0.014))}" fill="#020617" fill-opacity="0.45"/>`);
  parts.push(`<rect x="${f(bodyX + bodyW * 0.08)}" y="${f(baseY)}" width="${f(bodyW * 0.84)}" height="${f(H * 0.025)}" rx="3" fill="url(#${steelV})"/>`);
  for (const lx of [bodyX + bodyW * 0.14, bodyX + bodyW * 0.8]) {
    parts.push(`<rect x="${f(lx)}" y="${f(baseY + H * 0.02)}" width="${f(bodyW * 0.06)}" height="${f(H * 0.07)}" fill="url(#${steel})"/>`);
    parts.push(`<rect x="${f(lx - bodyW * 0.03)}" y="${f(baseY + H * 0.085)}" width="${f(bodyW * 0.12)}" height="5" rx="2" fill="#4b5563"/>`);
  }

  // Jato de entrada (largura pela vazão)
  if (inFlow > 0.001 && plantBound && flowing) {
    const jetW = clamp(4 + inFlow * 5, 4, pipeR * 1.8);
    parts.push(`<rect x="${f(mouthX - jetW)}" y="${f(bodyTop - ry - 1)}" width="${f(jetW * 2)}" height="${f(Math.max(4, levelY - bodyTop + ry))}" rx="${f(jetW)}" fill="#7dd3fc" fill-opacity="0.18"/>`);
    const jetTop = bodyTop - ry - 1, jetBottom = Math.max(jetTop + 4, levelY);
    parts.push(`<rect x="${f(mouthX - jetW / 2)}" y="${f(jetTop)}" width="${f(jetW)}" height="${f(jetBottom - jetTop)}" rx="${f(jetW / 2)}" fill="url(#${stream})"/>`);
    parts.push(`<line${animated("lw-flow")} x1="${f(mouthX)}" y1="${f(jetTop)}" x2="${f(mouthX)}" y2="${f(jetBottom)}" stroke="#f0f9ff" stroke-opacity="0.7" stroke-width="${f(Math.max(1, jetW * 0.3))}" stroke-dasharray="6 9"/>`);
    if (fraction > 0.002) parts.push(`<ellipse cx="${f(mouthX)}" cy="${f(levelY)}" rx="${f(jetW * 2.2)}" ry="${f(jetW * 0.6)}" fill="#e0f2fe" fill-opacity="0.6"/>`);
  }

  // Saída: tubo pela parede direita, perto do fundo, com bomba/válvula/orifício
  const outY = bodyBottom - (bodyBottom - bodyTop) * 0.06;
  const outStart = bodyX + bodyW - 1;
  parts.push(`<rect x="${f(outStart)}" y="${f(outY - pipeR)}" width="${f(W - outStart)}" height="${f(pipeR * 2)}" fill="url(#${steelV})"/>`);
  parts.push(`<rect x="${f(W - 8)}" y="${f(outY - pipeR * 1.5)}" width="6" height="${f(pipeR * 3)}" rx="1.5" fill="url(#${steel})"/>`);
  if (outFlow > 0.001 && flowing) parts.push(`<line${animated("lw-flow")} x1="${f(outStart + 2)}" y1="${f(outY)}" x2="${f(W - 10)}" y2="${f(outY)}" stroke="#7dd3fc" stroke-width="${f(pipeR * 0.7)}" stroke-dasharray="6 9" stroke-linecap="round"/>`);
  const gx = outStart + (W - outStart) * 0.5;
  if (outlet === 0) {
    // Bomba centrífuga
    const r = Math.max(9, pipeR * 2.1);
    parts.push(`<circle cx="${f(gx)}" cy="${f(outY)}" r="${f(r)}" fill="url(#${steelV})" stroke="#374151" stroke-width="1.2"/>`);
    parts.push(`<circle cx="${f(gx)}" cy="${f(outY)}" r="${f(r * 0.62)}" fill="#1d4ed8" stroke="#bfdbfe" stroke-width="1"/>`);
    parts.push(`<g${animated("lw-spin", `transform-origin:${f(gx)}px ${f(outY)}px`)}><path d="M${f(gx)},${f(outY - r * 0.55)}L${f(gx + r * 0.2)},${f(outY)}L${f(gx)},${f(outY + r * 0.55)}L${f(gx - r * 0.2)},${f(outY)}Z M${f(gx - r * 0.55)},${f(outY)}L${f(gx)},${f(outY - r * 0.2)}L${f(gx + r * 0.55)},${f(outY)}L${f(gx)},${f(outY + r * 0.2)}Z" fill="#e0f2fe" fill-opacity="0.9"/></g>`);
    parts.push(`<rect x="${f(gx - r * 0.9)}" y="${f(outY + r * 0.85)}" width="${f(r * 1.8)}" height="4" rx="2" fill="#374151"/>`);
  } else if (outlet === 1) {
    const s = Math.max(9, pipeR * 1.8);
    parts.push(`<path d="M${f(gx - s)},${f(outY - s * 0.75)}V${f(outY + s * 0.75)}L${f(gx + s)},${f(outY - s * 0.75)}V${f(outY + s * 0.75)}Z" fill="#1d4ed8" stroke="#bfdbfe" stroke-width="1.2" stroke-linejoin="round"/>`);
    parts.push(`<path d="M${f(gx)},${f(outY)}V${f(outY - s * 1.4)}M${f(gx - s * 0.6)},${f(outY - s * 1.4)}H${f(gx + s * 0.6)}" stroke="#d1d5db" stroke-width="2.4" stroke-linecap="round"/>`);
  } else {
    parts.push(`<rect x="${f(gx - 2.5)}" y="${f(outY - pipeR * 1.8)}" width="5" height="${f(pipeR * 3.6)}" rx="1.5" fill="#cbd5e1" stroke="#475569"/>`);
  }

  // Transbordo: água sobre a borda
  if (overflow > 0) {
    parts.push(`<path d="M${f(bodyX + 2)},${f(bodyTop - ry * 0.4)}q${f(-bodyW * 0.12)},${f(ry)} ${f(-bodyW * 0.1)},${f((bodyBottom - bodyTop) * 0.9)}" fill="none" stroke="url(#${stream})" stroke-width="5" stroke-linecap="round"${animated("lw-flow")} stroke-dasharray="6 9"/>`);
  }

  // Régua de nível
  if (showScale) {
    const sx = bodyX + bodyW + 16;
    const unit = plantBound ? "m" : "%";
    const top = plantBound ? hMax : 100;
    const step = niceStep(top, 4);
    parts.push(`<text x="${f(sx)}" y="${f(bodyTop - ry - 10)}" font-family="${MATH_FONT}" font-style="italic" font-size="14" fill="${LAB_THEME.ink}">${plantBound ? "h (m)" : "nível (%)"}</text>`);
    parts.push(`<rect x="${f(sx - 3)}" y="${f(bodyTop - 2)}" width="6" height="${f(bodyBottom - bodyTop + 4)}" rx="3" fill="rgba(4,14,32,0.6)" stroke="rgba(148,163,184,0.35)"/>`);
    for (let value = 0; value <= top + step * 1e-6; value += step) {
      const y = bodyBottom - (value / top) * (bodyBottom - bodyTop);
      parts.push(`<line x1="${f(sx + 3)}" y1="${f(y)}" x2="${f(sx + 11)}" y2="${f(y)}" stroke="#cbd5e1" stroke-width="1.3"/>`);
      parts.push(`<text x="${f(sx + 15)}" y="${f(y)}" dominant-baseline="central" font-family="${SANS}" font-size="12" fill="${LAB_THEME.muted}">${escapeXml(fmt(value, 2))}${unit === "%" ? "" : ""}</text>`);
      for (let minor = 1; minor < 5 && value + (step * minor) / 5 <= top + 1e-9; minor++) {
        const my = bodyBottom - ((value + (step * minor) / 5) / top) * (bodyBottom - bodyTop);
        parts.push(`<line x1="${f(sx + 3)}" y1="${f(my)}" x2="${f(sx + 7)}" y2="${f(my)}" stroke="#94a3b8" stroke-width="0.9"/>`);
      }
    }
    // Marcador do nível atual
    parts.push(`<path d="M${f(sx - 4)},${f(levelY)}l-9,-6v12z" fill="${LAB_THEME.sky}"/>`);
  }

  if (showValues) {
    const labelY = fraction > 0.18 ? levelY + (bodyBottom - levelY) / 2 : bodyTop + (bodyBottom - bodyTop) * 0.35;
    const main = plantBound ? `V = ${fmt(volume, 1)} L` : `${fmt(genericPercent, 1)} %`;
    if (plantBound ? Number.isFinite(volume) : Number.isFinite(genericPercent)) {
      parts.push(`<text x="${f(cx)}" y="${f(labelY)}" text-anchor="middle" dominant-baseline="central" font-family="${SANS}" font-size="${f(clamp(W * 0.062, 12, 30))}" font-weight="800" fill="#ffffff" stroke="#0b1f3a" stroke-opacity="0.6" stroke-width="3.5" paint-order="stroke">${escapeXml(main)}</text>`);
    }
    if (plantBound) {
      const small = clamp(W * 0.042, 10, 18);
      if (Number.isFinite(areaValue)) parts.push(`<text x="${f(cx)}" y="${f(baseY + H * 0.135)}" text-anchor="middle" font-family="${MATH_FONT}" font-size="${f(small + 2)}" fill="${LAB_THEME.ink}"><tspan font-style="italic">A</tspan> = ${escapeXml(fmt(areaValue, 3))} m²</text>`);
      parts.push(`<text x="4" y="${f(pipeY - pipeR - 8)}" font-family="${SANS}" font-size="${f(small)}" font-weight="600" fill="${LAB_THEME.sky}">entrada ${escapeXml(fmt(inFlow, 2))} L/s</text>`);
      parts.push(`<text x="${f(W - 4)}" y="${f(outY + pipeR + small + 14)}" text-anchor="end" font-family="${SANS}" font-size="${f(small)}" font-weight="600" fill="${LAB_THEME.sky}">saída ${escapeXml(fmt(outFlow, 2))} L/s</text>`);
    }
    const label = str(p, "label", "");
    if (label) parts.push(`<text x="${f(cx)}" y="${f(bodyTop - ry - 10)}" text-anchor="middle" font-family="${SANS}" font-size="13" font-weight="700" fill="${LAB_THEME.ink}">${escapeXml(label)}</text>`);
  }
  // Avisos de borda
  const badges: Array<[string, string]> = [];
  if (overflow > 0) badges.push([`transborda ${fmt(overflow, 2)} L/s`, LAB_THEME.red]);
  if (unmet > 0) badges.push(["tanque vazio: a saída não é atendida", LAB_THEME.amber]);
  if (runtime.error) badges.push([runtime.error, LAB_THEME.red]);
  else if (plantBound && !buffer && runtime.status !== "stopped") badges.push(["aguardando o simulador…", LAB_THEME.amber]);
  badges.forEach(([textValue, fill], index) => {
    const bw = textValue.length * 6.6 + 18, by = bodyTop + 8 + index * 24;
    parts.push(`<g transform="translate(${f(cx - bw / 2)} ${f(by)})"><rect width="${f(bw)}" height="20" rx="10" fill="${fill}" fill-opacity="0.92"/><text x="${f(bw / 2)}" y="10" text-anchor="middle" dominant-baseline="central" font-family="${SANS}" font-size="12" font-weight="700" fill="#ffffff">${escapeXml(textValue)}</text></g>`);
  });
  if (!plantBound && !str(p, "bindSource", "")) parts.push(`<text x="${f(cx)}" y="${f(H - 6)}" text-anchor="middle" font-family="${SANS}" font-size="11" fill="${LAB_THEME.muted}">ligue a uma planta ou a uma fonte</text>`);
  return defs.toString() + parts.join("");
}

// ── Slider (parâmetro da planta e parâmetro da página) ───────────────────────────────────────────

export interface SliderView {
  label: string;
  valueText: string;
  fraction: number;
  color: string;
  icon?: string;
  locked?: boolean;
  note?: string;
  minText?: string;
  maxText?: string;
  background: "none" | "card";
}

/** Trilho do slider dentro da caixa (a cena converte o ponteiro em fração com ele). */
export function sliderTrack(box: Box): { x0: number; x1: number; y: number } {
  return { x0: 16, x1: Math.max(17, box.width - 16), y: box.height - 26 };
}

export function sliderSvg(view: SliderView, box: Box): string {
  const defs = new Defs();
  const { width: W } = box;
  const track = sliderTrack(box);
  const parts: string[] = [];
  if (view.background === "card") parts.push(cardBackground(defs, box, "dark", view.color, 12));
  const opacity = view.locked ? 0.55 : 1;
  const fill = defs.add("slider", (id) => `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${view.color}" stop-opacity="0.75"/><stop offset="1" stop-color="${view.color}"/></linearGradient>`);
  const knob = defs.add("knob", (id) => `<radialGradient id="${id}" cx="0.4" cy="0.35" r="0.7"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#dbe4ef"/></radialGradient>`);
  let lx = 16;
  if (view.icon && LAB_ICONS[view.icon]) { parts.push(icon(view.icon, 14, 9, 20, view.color, 2)); lx = 42; }
  parts.push(`<text x="${f(lx)}" y="20" dominant-baseline="central" font-family="${SANS}" font-size="15" font-weight="600" fill="${LAB_THEME.ink}">${escapeXml(view.label)}</text>`);
  parts.push(`<text x="${f(W - 16)}" y="20" text-anchor="end" dominant-baseline="central" font-family="${SANS}" font-size="15" font-weight="700" fill="${LAB_THEME.ink}">${escapeXml(view.valueText)}</text>`);
  if (view.locked) parts.push(icon("lock", W - 16 - view.valueText.length * 8.6 - 22, 11, 16, LAB_THEME.amber, 2));
  const x = track.x0 + clamp(view.fraction, 0, 1) * (track.x1 - track.x0);
  parts.push(`<g opacity="${opacity}">`);
  parts.push(`<rect x="${f(track.x0)}" y="${f(track.y - 4)}" width="${f(track.x1 - track.x0)}" height="8" rx="4" fill="rgba(148,163,184,0.28)"/>`);
  parts.push(`<rect x="${f(track.x0)}" y="${f(track.y - 4)}" width="${f(Math.max(0, x - track.x0))}" height="8" rx="4" fill="url(#${fill})"/>`);
  parts.push(`<circle class="math-parameter-thumb" cx="${f(x)}" cy="${f(track.y)}" r="11" fill="url(#${knob})" stroke="${view.color}" stroke-width="2.5" filter="url(#${shadow(defs, 0.45)})"/>`);
  parts.push(`</g>`);
  const bottom = box.height - 6;
  if (view.note) parts.push(`<text x="${f(W / 2)}" y="${f(bottom)}" text-anchor="middle" font-family="${SANS}" font-size="11" fill="${LAB_THEME.amber}">${escapeXml(view.note)}</text>`);
  else {
    if (view.minText !== undefined) parts.push(`<text x="${f(track.x0)}" y="${f(bottom)}" font-family="${SANS}" font-size="10.5" fill="${LAB_THEME.faint}">${escapeXml(view.minText)}</text>`);
    if (view.maxText !== undefined) parts.push(`<text x="${f(track.x1)}" y="${f(bottom)}" text-anchor="end" font-family="${SANS}" font-size="10.5" fill="${LAB_THEME.faint}">${escapeXml(view.maxText)}</text>`);
  }
  return defs.toString() + parts.join("");
}

const PARAMETER_ICON: Readonly<Record<string, string>> = { qIn: "drop", qOut: "pump", area: "area", k: "valve", torr: "valve", outlet: "valve", hMax: "process", v0: "process", u: "step", K: "gauge", tau: "clock", y0: "step", p: "gauge", pmin: "gauge", pmax: "gauge" };
const PARAMETER_COLOR: Readonly<Record<string, string>> = { qIn: "#3b82f6", qOut: "#f97316", area: "#14b8a6", k: "#a855f7", torr: "#a855f7", u: "#3b82f6", K: "#f97316", tau: "#14b8a6", p: "#3b82f6" };

/** O parâmetro da planta que o elemento comanda (pela planta do tipo `kind` informado em `__plant_kind`). */
export function plantParameterSpec(p: Props): PlantParameterSpec | undefined {
  const spec = plantSpecByKind(p.__plant_kind);
  const id = str(p, "parameterId", "");
  return (spec ?? undefined)?.parameters.find((candidate) => candidate.id === id)
    ?? Object.values(PLANTS).flatMap((plant) => plant.parameters).find((candidate) => candidate.id === id);
}

export function plantParameterSvg(p: Props, box: Box): string {
  const runtime = plantRuntimeOf(p);
  const spec = plantParameterSpec(p);
  if (!spec) return centered(box.width, box.height, "Escolha o parâmetro (Componente › Parâmetro).", LAB_THEME.muted, 12);
  const dragging = typeof p.__param_drag === "number" ? p.__param_drag : undefined;
  const value = dragging ?? runtime.parameters[spec.id] ?? NaN;
  const autoDecimals = spec.step >= 1 ? 0 : spec.step >= 0.1 ? 1 : 2;
  const decimals = num(p, "decimals", -1) >= 0 ? Math.min(6, Math.round(num(p, "decimals", autoDecimals))) : autoDecimals;
  const unit = displayUnit(spec.unit);
  const locked = spec.policy === "stop-required" && runtime.status !== "stopped";
  const reason = typeof p.__param_error === "string" ? p.__param_error : undefined;
  return sliderSvg({
    label: str(p, "label", "") || spec.label,
    valueText: Number.isFinite(value) ? `${fmt(value, decimals)}${unit ? ` ${unit}` : ""}` : "—",
    fraction: Number.isFinite(value) ? (value - spec.min) / Math.max(1e-12, spec.max - spec.min) : 0,
    color: color(p, "color", PARAMETER_COLOR[spec.id] ?? LAB_THEME.blue),
    icon: str(p, "icon", "auto") === "auto" ? PARAMETER_ICON[spec.id] : str(p, "icon", "none"),
    locked,
    note: reason ?? (locked ? "pare a simulação para mudar (Reiniciar)" : runtime.error),
    minText: `${fmt(spec.min, decimals)}`,
    maxText: `${fmt(spec.max, decimals)}${unit ? ` ${unit}` : ""}`,
    background: str(p, "background", "none") === "card" ? "card" : "none",
  }, box);
}

/** Valor do parâmetro da planta na fração `fraction` do trilho (com o passo do parâmetro). */
export function plantParameterValueAt(spec: PlantParameterSpec, fraction: number): number {
  const raw = spec.min + clamp(fraction, 0, 1) * (spec.max - spec.min);
  const stepped = spec.step > 0 ? spec.min + Math.round((raw - spec.min) / spec.step) * spec.step : raw;
  return Number(clamp(stepped, spec.min, spec.max).toPrecision(12));
}

// ── Controles da simulação ───────────────────────────────────────────────────────────────────────

export type SimCommand = "run" | "pause" | "restart";

/** Retângulos dos botões (a cena usa os mesmos para o clique). */
export function simControlsLayout(box: Box): Record<SimCommand, { x: number; y: number; w: number; h: number }> {
  const h = Math.min(box.height - 8, 52), y = (box.height - h) / 2;
  const run = { x: 4, y, w: h * 2, h };
  const pause = { x: run.x + run.w + 12, y, w: h * 1.3, h };
  const restart = { x: pause.x + pause.w + 12, y, w: h * 1.3, h };
  return { run, pause, restart };
}

export function simControlsSvg(p: Props, box: Box): string {
  const defs = new Defs();
  const runtime = plantRuntimeOf(p);
  const layout = simControlsLayout(box);
  const status = runtime.status;
  const green = defs.add("run", (id) => `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#34d399"/><stop offset="1" stop-color="#16a34a"/></linearGradient>`);
  const darkBtn = defs.add("btn", (id) => `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#21416f"/><stop offset="1" stop-color="#132c50"/></linearGradient>`);
  const parts: string[] = [];
  const button = (rect: { x: number; y: number; w: number; h: number }, fill: string, active: boolean, glyph: string, title: string): void => {
    parts.push(`<g data-sim-command="${title}"><title>${title}</title>`);
    if (active) parts.push(`<rect x="${f(rect.x - 3)}" y="${f(rect.y - 3)}" width="${f(rect.w + 6)}" height="${f(rect.h + 6)}" rx="14" fill="none" stroke="${fill === green ? "#86efac" : "#93c5fd"}" stroke-opacity="0.75" stroke-width="2"/>`);
    parts.push(`<rect x="${f(rect.x)}" y="${f(rect.y)}" width="${f(rect.w)}" height="${f(rect.h)}" rx="11" fill="url(#${fill})" stroke="rgba(255,255,255,0.14)" filter="url(#${shadow(defs, 0.4)})"/>`);
    parts.push(glyph);
    parts.push(`</g>`);
  };
  const cy = (rect: { y: number; h: number }): number => rect.y + rect.h / 2;
  const g = layout.run, s = g.h * 0.2;
  button(g, green, status === "running", `<path d="M${f(g.x + g.w / 2 - s * 0.8)},${f(cy(g) - s * 1.1)}v${f(s * 2.2)}l${f(s * 1.9)},${f(-s * 1.1)}z" fill="#ffffff"/>`, "Executar");
  const pz = layout.pause;
  button(pz, darkBtn, status === "paused", `<rect x="${f(pz.x + pz.w / 2 - s * 0.85)}" y="${f(cy(pz) - s)}" width="${f(s * 0.6)}" height="${f(s * 2)}" rx="1.5" fill="#ffffff"/><rect x="${f(pz.x + pz.w / 2 + s * 0.25)}" y="${f(cy(pz) - s)}" width="${f(s * 0.6)}" height="${f(s * 2)}" rx="1.5" fill="#ffffff"/>`, "Pausar");
  const rs = layout.restart, r = s * 1.05;
  button(rs, darkBtn, false, `<path d="M${f(rs.x + rs.w / 2 + r * 0.95)},${f(cy(rs) - r * 0.3)}A${f(r)},${f(r)} 0 1 1 ${f(rs.x + rs.w / 2 + r * 0.35)},${f(cy(rs) - r * 0.95)}" fill="none" stroke="#ffffff" stroke-width="2.4" stroke-linecap="round"/><path d="M${f(rs.x + rs.w / 2 + r * 0.1)},${f(cy(rs) - r * 1.45)}l${f(r * 0.65)},${f(r * 0.5)}l${f(-r * 0.6)},${f(r * 0.45)}z" fill="#ffffff"/>`, "Reiniciar");
  if (flag(p, "showStatus", true)) {
    const sx = rs.x + rs.w + 26;
    const dot = status === "running" ? LAB_THEME.green : status === "paused" ? LAB_THEME.amber : "#94a3b8";
    const label = status === "running" ? str(p, "runningText", "Simulação em tempo real") : status === "paused" ? "Simulação pausada" : "Simulação parada";
    if (sx < box.width - 40) {
      parts.push(`<circle cx="${f(sx)}" cy="${f(box.height / 2 - (runtime.buffer ? 8 : 0))}" r="6" fill="${dot}"${status === "running" ? animation("lw-pulse") : ""}/>`);
      parts.push(`<text x="${f(sx + 14)}" y="${f(box.height / 2 - (runtime.buffer ? 8 : 0))}" dominant-baseline="central" font-family="${SANS}" font-size="15" fill="${LAB_THEME.ink}">${escapeXml(label)}</text>`);
      if (runtime.buffer && runtime.buffer.length > 0) parts.push(`<text x="${f(sx + 14)}" y="${f(box.height / 2 + 12)}" dominant-baseline="central" font-family="${MATH_FONT}" font-size="14" fill="${LAB_THEME.muted}"><tspan font-style="italic">t</tspan> = ${escapeXml(fmt(runtime.buffer.now, 2))} s</text>`);
    }
  }
  return defs.toString() + parts.join("");
}

// ── Leitura ──────────────────────────────────────────────────────────────────────────────────────

/** Valor grande de uma série ou parâmetro da planta: "V = 21,2 L". */
export function readoutSvg(p: Props, box: Box): string {
  const runtime = plantRuntimeOf(p);
  const quantity = str(p, "quantity", "V");
  const info = PLANT_CHANNEL_INFO[quantity];
  const spec = plantSpecByKind(p.__plant_kind)?.parameters.find((parameter) => parameter.id === quantity);
  const value = runtime.buffer?.has(quantity) ? lastValue(runtime.buffer, quantity) : runtime.parameters[quantity] ?? NaN;
  const symbol = str(p, "symbol", "") || info?.symbol || spec?.label || quantity;
  const unit = str(p, "unit", "") || info?.unit || displayUnit(spec?.unit ?? "");
  const decimals = Math.round(clamp(num(p, "decimals", 2), 0, 8));
  const size = clamp(num(p, "fontSize", 26), 8, 96);
  const ink = color(p, "color", LAB_THEME.ink);
  const label = str(p, "label", "");
  const parts: string[] = [];
  const defs = new Defs();
  if (str(p, "background", "none") === "card") parts.push(cardBackground(defs, box, "dark", LAB_THEME.sky, 12));
  const y = label ? box.height * 0.64 : box.height / 2;
  if (label) parts.push(`<text x="16" y="${f(box.height * 0.26)}" dominant-baseline="central" font-family="${SANS}" font-size="${f(size * 0.48)}" fill="${LAB_THEME.muted}">${escapeXml(label)}</text>`);
  parts.push(`<text x="16" y="${f(y)}" dominant-baseline="central" font-family="${MATH_FONT}" font-size="${f(size)}" fill="${ink}"><tspan font-style="italic">${escapeXml(symbol)}</tspan><tspan dx="${f(size * 0.28)}">=</tspan><tspan dx="${f(size * 0.28)}" font-family="${SANS}" font-weight="700">${escapeXml(fmt(value, decimals))}</tspan>${unit ? `<tspan font-family="${SANS}" font-size="${f(size * 0.7)}" fill="${LAB_THEME.muted}"> ${escapeXml(unit)}</tspan>` : ""}</text>`);
  return defs.toString() + parts.join("");
}

/** Fundo de cartão do tema do Laboratório para outros elementos (equação, parâmetro da página). */
export function labCardFrameSvg(box: Box, variant: "dark" | "light" | "glass" | "accent" = "dark", accent: string = LAB_THEME.sky, radius = 14): string {
  const defs = new Defs();
  const body = cardBackground(defs, box, variant, accent, radius);
  return defs.toString() + body;
}

// ── Despacho ─────────────────────────────────────────────────────────────────────────────────────

export function labWidgetSvg(typeId: string, properties: Props, box: Box): string | undefined {
  switch (typeId) {
    case MATH_CARD_TYPE_ID: return cardSvg(properties, box);
    case MATH_SERIES_CHART_TYPE_ID: return seriesChartSvg(properties, box);
    case MATH_PROCESS_TANK_TYPE_ID: return processTankSvg(properties, box);
    case MATH_PLANT_PARAMETER_TYPE_ID: return plantParameterSvg(properties, box);
    case MATH_SIM_CONTROLS_TYPE_ID: return simControlsSvg(properties, box);
    case MATH_READOUT_TYPE_ID: return readoutSvg(properties, box);
    default: return undefined;
  }
}
