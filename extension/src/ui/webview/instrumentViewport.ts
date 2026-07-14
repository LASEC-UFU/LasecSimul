/** Geometria e estado comuns dos plots expandidos. Funções puras: nenhuma dependência do DOM/Core. */
export interface InstrumentViewportState {
  width: number;
  height: number;
  timeDivMs: number;
  timePosMs: number;
  timeZeroRatio: number;
}

export const INSTRUMENT_VIEW_STATE_VERSION = 1;

export function clampInstrumentWindow(width: number, height: number): { width: number; height: number } {
  return {
    width: Math.round(Math.min(1400, Math.max(620, Number.isFinite(width) ? width : 820))),
    height: Math.round(Math.min(1000, Math.max(390, Number.isFinite(height) ? height : 560))),
  };
}

/** Mesmo cálculo de `PlotDisplay::wheelEvent`: passo de 20% e tempo sob o cursor invariável. */
export function zoomInstrumentTimeAt(
  state: Pick<InstrumentViewportState, "timeDivMs" | "timePosMs">,
  cursorRatio: number,
  zoomIn: boolean,
): { timeDivMs: number; timePosMs: number } {
  const ratio = Math.min(1, Math.max(0, cursorRatio));
  const oldDiv = Math.max(1e-9, state.timeDivMs);
  const nextDiv = Math.max(1e-9, oldDiv * (zoomIn ? 0.8 : 1.2));
  const oldFrame = oldDiv * 10;
  const nextFrame = nextDiv * 10;
  const anchorFromLatest = state.timePosMs - (1 - ratio) * oldFrame;
  return { timeDivMs: nextDiv, timePosMs: anchorFromLatest + (1 - ratio) * nextFrame };
}

/** Arrasto para a direita mostra dados anteriores, como OscWidget/LaWidget. */
export function panInstrumentTime(timePosMs: number, timeDivMs: number, deltaPixels: number, plotWidth: number): number {
  return timePosMs - (deltaPixels * timeDivMs * 10) / Math.max(1, plotWidth);
}

/** Traço analógico zero-order hold; nunca inventa rampas diagonais entre amostras. */
export function analogSampleHoldPath(
  timestampsNs: number[],
  values: number[],
  windowStartNs: number,
  windowEndNs: number,
  plotWidth: number,
  valueToY: (value: number) => number,
): string {
  if (values.length === 0 || timestampsNs.length === 0 || windowEndNs <= windowStartNs) return "";
  const count = Math.min(values.length, timestampsNs.length);
  let indices = Array.from({ length: count }, (_, index) => index);
  // Envelope min/max por coluna, equivalente à proteção de picos de PlotDisplay::paintEvent.
  if (count > plotWidth * 4) {
    const buckets = new Map<number, { min: number; max: number }>();
    for (let i = 0; i < count; i++) {
      const column = Math.floor(Math.min(plotWidth - 1, Math.max(0, ((timestampsNs[i]! - windowStartNs) / (windowEndNs - windowStartNs)) * plotWidth)));
      const bucket = buckets.get(column);
      if (!bucket) buckets.set(column, { min: i, max: i });
      else {
        if (values[i]! < values[bucket.min]!) bucket.min = i;
        if (values[i]! > values[bucket.max]!) bucket.max = i;
      }
    }
    indices = [0];
    for (const bucket of buckets.values()) indices.push(...(bucket.min < bucket.max ? [bucket.min, bucket.max] : [bucket.max, bucket.min]));
    indices.push(count - 1);
    indices = Array.from(new Set(indices)).sort((a, b) => a - b);
  }
  let path = "";
  let previousY: number | undefined;
  for (const i of indices) {
    const x = Math.min(plotWidth, Math.max(0, ((timestampsNs[i]! - windowStartNs) / (windowEndNs - windowStartNs)) * plotWidth));
    const y = valueToY(values[i]!);
    if (previousY === undefined) path = `M ${x.toFixed(1)} ${y.toFixed(1)}`;
    else path += ` L ${x.toFixed(1)} ${previousY.toFixed(1)} L ${x.toFixed(1)} ${y.toFixed(1)}`;
    previousY = y;
  }
  if (previousY !== undefined) path += ` L ${plotWidth.toFixed(1)} ${previousY.toFixed(1)}`;
  return path;
}

export function encodeInstrumentState(value: object): string {
  return JSON.stringify({ version: INSTRUMENT_VIEW_STATE_VERSION, ...value });
}

export function decodeInstrumentState<T extends object>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || raw.length > 32_768) return fallback;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.version !== INSTRUMENT_VIEW_STATE_VERSION) return fallback;
    const { version: _version, ...payload } = parsed;
    return { ...fallback, ...payload } as T;
  } catch {
    return fallback;
  }
}

export function logicHistoryToVcd(timestampsNs: number[], masks: number[], channels: number[], generatedAt = "1970-01-01T00:00:00.000Z"): string {
  const ids = ["!", '"', "#", "$", "%", "&", "'", "("];
  const valid = channels.filter((channel) => Number.isInteger(channel) && channel >= 0 && channel < 8);
  const lines = ["$date", `  ${generatedAt}`, "$end", "$version LasecSimul Logic Analyzer $end", "$timescale 1ns $end", "$scope module logic_analyzer $end"];
  valid.forEach((channel) => lines.push(`$var wire 1 ${ids[channel]} D${channel} $end`));
  lines.push("$upscope $end", "$enddefinitions $end", "$dumpvars");
  valid.forEach((channel) => lines.push(`0${ids[channel]}`));
  lines.push("$end");
  let previousMask = -1;
  masks.forEach((mask, index) => {
    if (mask === previousMask) return;
    lines.push(`#${Math.max(0, Math.round(timestampsNs[index] ?? 0))}`);
    valid.forEach((channel) => {
      if (previousMask < 0 || ((mask >>> channel) & 1) !== ((previousMask >>> channel) & 1)) lines.push(`${(mask >>> channel) & 1}${ids[channel]}`);
    });
    previousMask = mask;
  });
  return lines.join("\n");
}
