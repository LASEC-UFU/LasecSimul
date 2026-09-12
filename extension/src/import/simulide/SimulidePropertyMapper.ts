import type { WebviewComponentCatalogEntry } from "../../ui/webview/model";
import type { SimulideAttributes, SimulideImportIssue } from "./SimulideTypes";
import { normalizeSimulideToken } from "./SimulideComponentMapper";

const RESERVED_PROPERTIES = new Set([
  "itemtype", "circid", "maincomp", "showprop", "showid", "showval", "pos", "rotation", "hflip", "vflip",
  "label", "idlabpos", "labelrot", "vallabpos", "vallabrot", "boardpos", "circpos", "boardrot", "circrot",
  "boardhflip", "boardvflip", "angle",
].map(normalizeSimulideToken));

const GLOBAL_PROPERTY_ALIASES: Record<string, string[]> = {
  resistance: ["resistance", "res", "ohm"],
  capacitance: ["capacitance", "capacity", "cap"],
  inductance: ["inductance", "ind"],
  voltage: ["voltage", "volt", "vout"],
  threshold: ["threshold", "thresholdvolt", "forwardvoltage"],
  saturationCurrent: ["satcurrent", "saturationcurrent"],
  gain: ["gain"],
  color: ["color", "colour"],
  frequency: ["frequency", "freq", "freqhz"],
  freqHz: ["frequency", "freq", "freqhz"],
  normallyClosed: ["normallyclosed", "normclose", "norm_close"],
  closed: ["closed", "state"],
  position: ["position", "dialvalue", "dialposition"],
  rows: ["rows"],
  columns: ["columns", "cols"],
  size: ["size"],
  key: ["key"],
  enabled: ["enabled"],
  inverted: ["inverted", "invert"],
  minValue: ["minvalue", "min"],
  maxValue: ["maxvalue", "max"],
  value: ["value"],
  out: ["out"],
};

/**
 * Propriedades extras necessárias para preservar o visual do SimulIDE. O ProjectDocument aceita
 * propriedades de instância arbitrárias; são preservadas mesmo quando o Core/render ainda não
 * consome todas -- ver `coreLifecycle.ts` (nunca chegam ao Core: `__ui_`/UI-only).
 */
const EXTRA_DEFAULTS: Record<string, Record<string, string | number | boolean>> = {
  "sources.fixed_volt": {
    small: false,
  },
  "meters.probe": {
    small: false,
  },
  "graphics.line": {
    length: Math.hypot(50, 30),
    deltaX: 50,
    deltaY: -30,
    zValue: -1,
  },
  "graphics.text": {
    zValue: 0,
  },
  "graphics.rectangle": {
    zValue: -1,
  },
  "graphics.ellipse": {
    zValue: -1,
  },
  "graphics.image": {
    zValue: -1,
  },
};

/**
 * NÃO CONFIRMADO contra um arquivo real: nenhum fixture disponível usa uma borda não-sólida, e a
 * única evidência que temos é o enum genérico Qt::PenStyle (NoPen/SolidLine/DashLine/DotLine/
 * DashDotLine/DashDotDotLine/CustomDashLine) encontrado no binário do SimulIDE -- não o nome do
 * atributo XML específico que o Rectangle/Ellipse/Line realmente grava. Tentamos os nomes mais
 * prováveis (convenção Palavra_Palavra já vista em outros atributos reais, ex. Out_Imped/
 * Power_Pins); se o nome real for outro, a propriedade cai em `__ui_simulideRaw_*` como qualquer
 * atributo não mapeado, sem quebrar nada -- só não aplica o estilo automaticamente.
 */
const STROKE_STYLE_ALIASES = ["pen_style", "penstyle", "line_style", "linestyle", "border_style", "borderstyle"];

/** Qt::PenStyle -> um dos 3 estilos que `componentSymbols.ts::strokeDashArrayAttr` sabe desenhar.
 * Aceita tanto o nome do enum (mais provável, já que o SimulIDE serializa vários enums Qt como
 * texto) quanto o ordinal numérico, caso o valor real seja um int. */
function normalizeSimulideStrokeStyle(raw: string): "solid" | "dashed" | "dotted" | undefined {
  const normalized = raw.trim().toLowerCase();
  const numeric = Number(normalized);
  if (Number.isInteger(numeric)) {
    if (numeric <= 1) return "solid"; // NoPen(0)/SolidLine(1): sem tracejado equivalente, mantém sólido.
    if (numeric === 3) return "dotted"; // DotLine
    if (numeric >= 2) return "dashed"; // DashLine/DashDotLine/DashDotDotLine/CustomDashLine
  }
  if (normalized.includes("dot") && !normalized.includes("dash")) return "dotted";
  if (normalized.includes("dash")) return "dashed";
  if (normalized.includes("solid") || normalized === "nopen") return "solid";
  return undefined;
}

const TYPE_PROPERTY_ALIASES: Record<string, Record<string, string[]>> = {
  "sources.fixed_volt": {
    small: ["small"],
  },
  "sources.wave_gen": {
    freqHz: ["freq", "frequency", "freqhz"],
    semiAmplitude: ["voltage", "amplitude", "semiamplitude", "semi_ampli", "semiampli"],
    midVoltage: ["mid_volt", "midvolt", "midvoltage"],
    waveType: ["wave_type", "wavetype", "wave", "type"],
    phaseShift: ["phase", "phaseshift"],
    duty: ["duty"],
    alwaysOn: ["always_on", "alwayson"],
    bipolar: ["bipolar"],
    floating: ["floating"],
  },
  "meters.probe": {
    small: ["small"],
    threshold: ["threshold"],
    showVolt: ["showvolt"],
    pauseOnChange: ["pause", "pauseonchange"],
  },
  "meters.oscope": {
    filter: ["filter"],
    tracks: ["tracks"],
    tunnels: ["tunnels"],
  },
  "meters.logic_analyzer": {
    thresholdRising: ["tresholdr", "thresholdr", "thresholdrising"],
    thresholdFalling: ["tresholdf", "thresholdf", "thresholdfalling"],
    tunnels: ["tunnels"],
  },
  "sources.clock": {
    freqHz: ["freq", "frequency", "freqhz"],
    voltage: ["voltage", "volt"],
    alwaysOn: ["alwayson", "always_on"],
  },
  "active.diode": {
    threshold: ["threshold"],
    saturationCurrent: ["satcurrent", "saturationcurrent"],
  },
  "active.zener": {
    threshold: ["zener_volt", "breakdownvoltage", "brkdownv", "threshold"],
    resistance: ["resistance"],
  },
  "passive.potentiometer": {
    resistance: ["resistance"],
    position: ["position", "dialposition"],
  },
  "switches.push": {
    normallyClosed: ["norm_close", "normclose", "normallyclosed"],
    key: ["key"],
  },
  "switches.switch": {
    normallyClosed: ["norm_close", "normclose", "normallyclosed"],
    key: ["key"],
  },
  "graphics.rectangle": {
    width: ["h_size", "hsize", "width"],
    height: ["v_size", "vsize", "height"],
    fill: ["color", "fill"],
    strokeWidth: ["border", "strokewidth"],
    fillOpacity: ["opacity"],
    zValue: ["z_value", "zvalue"],
    strokeStyle: STROKE_STYLE_ALIASES,
  },
  "graphics.ellipse": {
    width: ["h_size", "hsize", "width"],
    height: ["v_size", "vsize", "height"],
    fill: ["color", "fill"],
    strokeWidth: ["border", "strokewidth"],
    fillOpacity: ["opacity"],
    zValue: ["z_value", "zvalue"],
    strokeStyle: STROKE_STYLE_ALIASES,
  },
  "graphics.line": {
    stroke: ["color", "stroke"],
    strokeWidth: ["border", "strokewidth"],
    opacity: ["opacity"],
    zValue: ["z_value", "zvalue"],
    strokeStyle: STROKE_STYLE_ALIASES,
  },
  "graphics.text": {
    text: ["text"],
    fontSize: ["font_size", "fontsize"],
    color: ["font_color", "fontcolor"],
    backgroundColor: ["color", "backgroundcolor"],
    backgroundOpacity: ["opacity"],
    borderWidth: ["border", "borderwidth"],
    fontFamily: ["font", "fontfamily"],
    fixedWidth: ["fixed_width", "fixedwidth"],
    margin: ["margin"],
  },
  "graphics.image": {
    width: ["h_size", "hsize", "width"],
    height: ["v_size", "vsize", "height"],
    path: ["image_file", "imagefile", "path"],
    borderWidth: ["border", "borderwidth"],
    backgroundColor: ["color", "backgroundcolor"],
    backgroundOpacity: ["opacity"],
    zValue: ["z_value", "zvalue"],
  },
};

function findRawAttribute(attributes: SimulideAttributes, aliases: readonly string[]): string | undefined {
  const wanted = new Set(aliases.map(normalizeSimulideToken));
  for (const [key, value] of Object.entries(attributes)) {
    if (wanted.has(normalizeSimulideToken(key))) return value;
  }
  return undefined;
}

export function parseEngineeringNumber(raw: string): number | undefined {
  const value = raw.trim().replace(/,/g, ".");
  const match = value.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*([pnumkMGTµμ]?)(?:[A-Za-zΩΩ%°º/_-].*)?$/u);
  if (!match) return undefined;
  const numeric = Number(match[1]);
  if (!Number.isFinite(numeric)) return undefined;
  const prefix = match[2] ?? "";
  const multiplier: Record<string, number> = {
    p: 1e-12,
    n: 1e-9,
    u: 1e-6,
    µ: 1e-6,
    μ: 1e-6,
    m: 1e-3,
    "": 1,
    k: 1e3,
    M: 1e6,
    G: 1e9,
    T: 1e12,
  };
  return numeric * (multiplier[prefix] ?? 1);
}

function coerceValue(raw: string, expected: string | number | boolean): string | number | boolean | undefined {
  if (typeof expected === "boolean") {
    const normalized = raw.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    return undefined;
  }
  if (typeof expected === "number") return parseEngineeringNumber(raw);
  return raw;
}

function mergedDefaults(entry: WebviewComponentCatalogEntry): Record<string, string | number | boolean> {
  return { ...entry.defaultProperties, ...(EXTRA_DEFAULTS[entry.typeId] ?? {}) };
}

function candidateKeys(entry: WebviewComponentCatalogEntry): Array<{ key: string; expected: string | number | boolean }> {
  const byKey = new Map<string, string | number | boolean>();
  for (const [key, value] of Object.entries(mergedDefaults(entry))) byKey.set(key, value);
  for (const schema of entry.propertySchema ?? []) {
    if (typeof schema.default === "string" || typeof schema.default === "number" || typeof schema.default === "boolean") {
      byKey.set(schema.id, schema.default);
    }
  }
  return [...byKey.entries()].map(([key, expected]) => ({ key, expected }));
}

function aliasesFor(entry: WebviewComponentCatalogEntry, targetKey: string): string[] {
  return [
    targetKey,
    ...(GLOBAL_PROPERTY_ALIASES[targetKey] ?? []),
    ...(TYPE_PROPERTY_ALIASES[entry.typeId]?.[targetKey] ?? []),
  ];
}

function resolveTargetPropertyKey(entry: WebviewComponentCatalogEntry, sourcePropertyName: string): string | undefined {
  const normalized = normalizeSimulideToken(sourcePropertyName);
  const candidates = candidateKeys(entry);

  // Regras específicas do typeId têm prioridade sobre aliases globais. Ex.: TextComponent.Color é
  // cor de FUNDO, enquanto Font_Color é a cor do texto; sem esta precedência, o alias global
  // `color` capturaria Color antes de backgroundColor.
  const typeAliases = TYPE_PROPERTY_ALIASES[entry.typeId] ?? {};
  for (const { key } of candidates) {
    if ((typeAliases[key] ?? []).some((alias) => normalizeSimulideToken(alias) === normalized)) return key;
  }
  for (const { key } of candidates) {
    if ([key, ...(GLOBAL_PROPERTY_ALIASES[key] ?? [])].some((alias) => normalizeSimulideToken(alias) === normalized)) return key;
  }
  return undefined;
}

function mimeForEmbeddedBytes(bytes: Buffer): string {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a")) return "image/gif";
  const prefix = bytes.subarray(0, Math.min(bytes.length, 256)).toString("utf8").trimStart();
  if (prefix.startsWith("<svg") || prefix.startsWith("<?xml") && prefix.includes("<svg")) return "image/svg+xml";
  return "image/png";
}

function mapEmbeddedImageData(properties: Record<string, string | number | boolean>, attributes: SimulideAttributes): void {
  const rawHex = findRawAttribute(attributes, ["BckGndData"]);
  if (!rawHex || !/^(?:[0-9a-fA-F]{2})+$/.test(rawHex)) return;
  const bytes = Buffer.from(rawHex, "hex");
  if (bytes.length === 0) return;
  properties.imageData = bytes.toString("base64");
  properties.imageMime = mimeForEmbeddedBytes(bytes);
}

function parseNumberList(raw: string | undefined, fallback: number[] = []): number[] {
  if (!raw) return fallback;
  return raw.split(",").filter((part) => part.trim() !== "").map((part) => Number(part.trim())).filter(Number.isFinite);
}

function parseBooleanList(raw: string | undefined, count: number): boolean[] {
  const values = (raw ?? "").split(",").filter((part) => part.trim() !== "").map((part) => part.trim().toLowerCase() === "true");
  return Array.from({ length: count }, (_, index) => values[index] ?? false);
}

function psToMs(value: number): number { return value * 1e-9; }

function mapOscopeUiState(properties: Record<string, string | number | boolean>, attributes: SimulideAttributes): void {
  const timeDivPs = Number(findRawAttribute(attributes, ["TimDiv"]) ?? 1_000_000_000);
  const timePos = parseNumberList(findRawAttribute(attributes, ["TimPos"]));
  const voltDiv = parseNumberList(findRawAttribute(attributes, ["VolDiv"]));
  const voltPos = parseNumberList(findRawAttribute(attributes, ["VolPos"]));
  const hidden = parseBooleanList(findRawAttribute(attributes, ["HideCh"]), 4);
  const trigger = Number(findRawAttribute(attributes, ["Trigger"]) ?? -1);
  const auto = Number(findRawAttribute(attributes, ["AutoSC"]) ?? -1);
  const tracksRaw = Number(findRawAttribute(attributes, ["Tracks"]) ?? 1);
  const tracks = tracksRaw === 2 || tracksRaw === 4 ? tracksRaw : 1;
  const filter = parseEngineeringNumber(findRawAttribute(attributes, ["Filter"]) ?? "0.05") ?? 0.05;
  const view = {
    version: 1,
    kind: "oscope",
    width: 820,
    height: 570,
    timeZeroRatio: 0.5,
    activeTab: "all",
    timeDivMs: Number.isFinite(timeDivPs) ? psToMs(timeDivPs) : 1,
    tracks,
    channels: Array.from({ length: 4 }, (_, index) => ({
      hidden: hidden[index] ?? false,
      voltDiv: voltDiv[index] ?? 1,
      voltPos: voltPos[index] ?? 0,
      timePosMs: psToMs(timePos[index] ?? 0),
    })),
    triggerSource: Number.isInteger(trigger) && trigger >= 0 && trigger <= 3 ? trigger : "none",
    autoScaleChannel: Number.isInteger(auto) && auto >= 0 && auto <= 3 ? auto : "none",
    filterThreshold: filter,
  };
  properties.__ui_instrumentView = JSON.stringify(view);
  properties.autoScale = view.autoScaleChannel !== "none";
  properties.tracks = tracks;
  properties.filter = filter;
}

function mapLogicAnalyzerUiState(properties: Record<string, string | number | boolean>, attributes: SimulideAttributes): void {
  const timeDivPs = Number(findRawAttribute(attributes, ["TimDiv"]) ?? 1_000_000_000);
  const timePosPs = Number(findRawAttribute(attributes, ["TimPos"]) ?? 0);
  const trigger = Number(findRawAttribute(attributes, ["Trigger"]) ?? -1);
  const thresholdUp = parseEngineeringNumber(findRawAttribute(attributes, ["TresholdR", "ThresholdR"]) ?? "2.5") ?? 2.5;
  const thresholdDown = parseEngineeringNumber(findRawAttribute(attributes, ["TresholdF", "ThresholdF"]) ?? "2.5") ?? 2.5;
  const busFlags = parseBooleanList(findRawAttribute(attributes, ["Bus"]), 8);
  const tunnels = (findRawAttribute(attributes, ["Tunnels"]) ?? "").split(",");
  const expandedBusChannels = tunnels
    .map((name, index) => ({ name: name.trim(), index }))
    .filter((entry) => entry.name && busFlags[entry.index])
    .map((entry) => entry.name);
  properties.__ui_instrumentView = JSON.stringify({
    version: 1,
    kind: "logic",
    width: 820,
    height: 430,
    timeZeroRatio: 0.5,
    timeDivMs: Number.isFinite(timeDivPs) ? psToMs(timeDivPs) : 1,
    timePosMs: Number.isFinite(timePosPs) ? psToMs(timePosPs) : 0,
    hiddenChannels: Array.from({ length: 8 }, () => false),
    expandedBusChannels,
    triggerChannel: Number.isInteger(trigger) && trigger >= 0 && trigger <= 7 ? trigger : "none",
    triggerCondition: "",
    thresholdUp,
    thresholdDown,
  });
  properties.thresholdRising = thresholdUp;
  properties.thresholdFalling = thresholdDown;
  const timeStepPs = parseEngineeringNumber(findRawAttribute(attributes, ["TimeStep"]) ?? "1000") ?? 1000;
  properties.sampleIntervalNs = Math.max(1, timeStepPs / 1000);
}

export interface MappedSimulideProperties {
  properties: Record<string, string | number | boolean>;
  valueLabelPropertyKey?: string;
  issues: SimulideImportIssue[];
}

export function mapSimulideProperties(
  entry: WebviewComponentCatalogEntry,
  attributes: SimulideAttributes,
  sourceId: string,
  lineNumber?: number
): MappedSimulideProperties {
  const properties: Record<string, string | number | boolean> = mergedDefaults(entry);
  const issues: SimulideImportIssue[] = [];
  const candidates = new Map(candidateKeys(entry).map(({ key, expected }) => [key, expected]));

  for (const [sourceKey, rawValue] of Object.entries(attributes)) {
    if (RESERVED_PROPERTIES.has(normalizeSimulideToken(sourceKey))) continue;

    // Geometria H/V da linha precisa de pós-processamento porque o eixo Y do SimulIDE é invertido.
    if (entry.typeId === "graphics.line" && ["hsize", "vsize"].includes(normalizeSimulideToken(sourceKey))) continue;
    // Dados de imagem embutida são transformados de hex -> base64 abaixo.
    if (entry.typeId === "graphics.image" && normalizeSimulideToken(sourceKey) === "bckgnddata") continue;
    if (entry.typeId === "graphics.image" && normalizeSimulideToken(sourceKey) === "embeedbck") continue;

    const targetKey = resolveTargetPropertyKey(entry, sourceKey);
    if (!targetKey) {
      properties[`__ui_simulideRaw_${normalizeSimulideToken(sourceKey)}`] = rawValue;
      issues.push({
        severity: "warning",
        code: "ignored-property",
        message: `Propriedade SimulIDE não mapeada: ${sourceKey}`,
        sourceId,
        sourceType: entry.typeId,
        property: sourceKey,
        lineNumber,
      });
      continue;
    }
    const expected = candidates.get(targetKey);
    if (expected === undefined) continue;
    const converted = targetKey === "strokeStyle" ? normalizeSimulideStrokeStyle(rawValue) : coerceValue(rawValue, expected);
    if (converted === undefined) {
      issues.push({
        severity: "warning",
        code: "property-coercion",
        message: `Não foi possível converter ${sourceKey}="${rawValue}" para ${targetKey}`,
        sourceId,
        sourceType: entry.typeId,
        property: sourceKey,
        lineNumber,
      });
      continue;
    }
    properties[targetKey] = converted;
  }

  // Potenciômetro: SimulIDE persiste Value_Ohm; LasecSimul usa posição normalizada 0..1.
  if (entry.typeId === "passive.potentiometer") {
    const resistanceRaw = findRawAttribute(attributes, ["Resistance"]);
    const valueRaw = findRawAttribute(attributes, ["Value_Ohm"]);
    const resistance = resistanceRaw ? parseEngineeringNumber(resistanceRaw) : undefined;
    const value = valueRaw ? parseEngineeringNumber(valueRaw) : undefined;
    if (resistance !== undefined && resistance > 0 && value !== undefined) {
      properties.position = Math.max(0, Math.min(1, value / resistance));
    }
  }

  // Line::paint() real: (-H/2,+V/2) -> (+H/2,-V/2). Guardamos o vetor para preservar
  // comprimento E inclinação, inclusive quando não é cardinal.
  if (entry.typeId === "graphics.line") {
    const h = parseEngineeringNumber(findRawAttribute(attributes, ["H_size"]) ?? "50") ?? 50;
    const v = parseEngineeringNumber(findRawAttribute(attributes, ["V_size"]) ?? "30") ?? 30;
    properties.deltaX = h;
    properties.deltaY = -v;
    properties.length = Math.hypot(h, v);
  }

  if (entry.typeId === "graphics.image") mapEmbeddedImageData(properties, attributes);

  if (entry.typeId === "meters.oscope") mapOscopeUiState(properties, attributes);
  if (entry.typeId === "meters.logic_analyzer") mapLogicAnalyzerUiState(properties, attributes);

  // Propriedades vistas nos arquivos reais mas sem equivalente funcional atual ficam preservadas
  // sob __ui_simulideRaw_* acima. Isso evita perda de dados sem enviá-las ao Core.
  const showProp = attributes.ShowProp;
  const valueLabelPropertyKey = showProp ? resolveTargetPropertyKey(entry, showProp) : undefined;
  return { properties, valueLabelPropertyKey, issues };
}
