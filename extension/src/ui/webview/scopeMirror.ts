/** Tela pequena do osciloscópio no canvas = a MESMA tela da janela "Expande", só menor -- igual ao
 * SimulIDE, onde o `PlotDisplay` colapsado (`Oscope::expand(false)`) e o expandido leem o mesmo
 * buffer do `DataChannel` com o mesmo `m_timeDiv`/`m_vTick`/`m_vPos`/trilhas/trigger.
 *
 * A janela "Expande" é `media/electrical-instrument.html` (`draw()`), que desenha o histórico REAL do
 * Core (tempo simulado) com as configurações que ela grava em `__ui_instrumentView`. Este módulo é a
 * MESMA conta daquele `draw()` -- janela de tempo, trigger, auto, posição/divisão de tensão e trilhas
 * -- para um retângulo qualquer. Mudar a conta de um lado sem o outro faz as duas telas divergirem:
 * `scopeMirror.test.ts` fixa a correspondência. */

export interface ScopeChannelHistory {
  timestampsNs: number[];
  values: number[];
}

export interface ScopeViewSettings {
  timeDivMs: number;
  timePosMs: number;
  tracks: number;
  trigger: number | "none";
  triggerEdge: "rising" | "falling";
  thresholdRising: number;
  thresholdFalling: number;
  filter: number;
  auto: number | "none";
  hidden: boolean[];
  voltDiv: number[];
  voltPos: number[];
}

/** Mesmos padrões do objeto `d` de `electrical-instrument.html`. */
const DEFAULT_SETTINGS: ScopeViewSettings = {
  timeDivMs: 1,
  timePosMs: 0,
  tracks: 1,
  trigger: "none",
  triggerEdge: "rising",
  thresholdRising: 2.5,
  thresholdFalling: 2.5,
  filter: 0.05,
  auto: "none",
  hidden: [],
  voltDiv: [1, 1, 1, 1],
  voltPos: [0, 0, 0, 0],
};

/** Quantas amostras a janela "Expande" guarda por canal (`ElectricalInstrumentPanel.update` e o
 * `message` handler de `electrical-instrument.html`). A tela pequena guarda o mesmo tanto, senão uma
 * base de tempo longa mostraria menos sinal na pequena do que na grande. */
export const SCOPE_MIRROR_CAPACITY = 4096;

/** Amostras do trigger: `trig()` só procura nas últimas 512 (a captura do Core,
 * `Oscope::kHistoryCapacity`). */
const TRIGGER_SEARCH_SAMPLES = 512;

function finiteOr(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function channelSelector(value: unknown): number | "none" {
  if (value === "none" || value === undefined || value === null || value === "") return "none";
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : "none";
}

/** Versão da configuração do osciloscópio gravada pela janela "Expande". A 2 usa as unidades do
 * SimulIDE (`PlotDisplay`): `voltDiv` é volts por divisão, com 10 divisões por trilha, e `voltPos` é
 * SOMADO ao sinal (`setVPos` guarda `-vPos`: y = centro − (v + voltPos)·escala). */
export const SCOPE_VIEW_SETTINGS_VERSION = 2;

/** Converte uma configuração gravada antes da versão 2 sem mudar a imagem na tela.
 * - Versão 1 da janela: `ph/tracks*4/voltDiv` pixels por volt (40× o `alturaDaTrilha/(10·voltDiv)` do
 *   SimulIDE) e `voltPos` = tensão no centro. Logo V/div ÷ 40 e posição com o sinal trocado.
 * - Formato do importador do SimulIDE e do popup antigo (`channels[]`, `triggerSource`,
 *   `autoScaleChannel`): os números já são os do SimulIDE, só mudam de lugar.
 * Mesma regra de `upgradeSettings` em `electrical-instrument.html`. */
export function upgradeScopeViewSettings(raw: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(raw.voltDiv) && Array.isArray(raw.channels)) {
    const channels = raw.channels as Array<Record<string, unknown> | null | undefined>;
    return {
      ...raw,
      voltDiv: channels.map((channel) => Number(channel?.voltDiv) || 1),
      voltPos: channels.map((channel) => Number(channel?.voltPos) || 0),
      hidden: channels.map((channel) => Boolean(channel?.hidden)),
      timePosMs: Number(channels[0]?.timePosMs) || 0,
      trigger: raw.triggerSource ?? "none",
      auto: raw.autoScaleChannel ?? "none",
      filter: Number(raw.filterThreshold ?? raw.filter ?? 0.05),
      version: SCOPE_VIEW_SETTINGS_VERSION,
    };
  }
  if (Array.isArray(raw.voltDiv) && Number(raw.version || 1) < SCOPE_VIEW_SETTINGS_VERSION) {
    return {
      ...raw,
      voltDiv: raw.voltDiv.map((value) => (Number(value) || 1) / 40),
      voltPos: (Array.isArray(raw.voltPos) ? raw.voltPos : []).map((value) => -(Number(value) || 0)),
      version: SCOPE_VIEW_SETTINGS_VERSION,
    };
  }
  return raw;
}

/** Lê `__ui_instrumentView` (string JSON gravada pela janela "Expande") com os padrões dela,
 * convertendo configurações antigas (`upgradeScopeViewSettings`). */
export function parseScopeViewSettings(raw: unknown): ScopeViewSettings {
  let parsed: Record<string, unknown> = {};
  if (typeof raw === "string" && raw.trim()) {
    try {
      const value = JSON.parse(raw) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) parsed = upgradeScopeViewSettings(value as Record<string, unknown>);
    } catch {
      parsed = {};
    }
  }
  const numberArray = (value: unknown, fallback: number[]): number[] =>
    Array.isArray(value) ? value.map((entry, index) => finiteOr(entry, fallback[index] ?? 1)) : [...fallback];
  return {
    timeDivMs: finiteOr(parsed.timeDivMs, DEFAULT_SETTINGS.timeDivMs),
    timePosMs: finiteOr(parsed.timePosMs, DEFAULT_SETTINGS.timePosMs),
    tracks: finiteOr(parsed.tracks, DEFAULT_SETTINGS.tracks),
    trigger: channelSelector(parsed.trigger),
    triggerEdge: parsed.triggerEdge === "falling" ? "falling" : "rising",
    thresholdRising: finiteOr(parsed.thresholdRising, DEFAULT_SETTINGS.thresholdRising),
    thresholdFalling: finiteOr(parsed.thresholdFalling, DEFAULT_SETTINGS.thresholdFalling),
    filter: finiteOr(parsed.filter, DEFAULT_SETTINGS.filter),
    auto: channelSelector(parsed.auto),
    hidden: Array.isArray(parsed.hidden) ? parsed.hidden.map(Boolean) : [],
    voltDiv: numberArray(parsed.voltDiv, DEFAULT_SETTINGS.voltDiv),
    voltPos: numberArray(parsed.voltPos, DEFAULT_SETTINGS.voltPos).map((value) => Number.isFinite(value) ? value : 0),
  };
}

/** `trig(r)` de `electrical-instrument.html`: a borda mais recente nas últimas 512 amostras. */
export function scopeTriggerTimeNs(channel: ScopeChannelHistory | undefined, settings: ScopeViewSettings): number | undefined {
  if (!channel || channel.timestampsNs.length < 2) return undefined;
  const threshold = settings.triggerEdge === "rising" ? settings.thresholdRising : settings.thresholdFalling;
  const hysteresis = settings.filter || 0;
  const times = channel.timestampsNs;
  const values = channel.values;
  for (let i = times.length - 1; i > Math.max(0, times.length - TRIGGER_SEARCH_SAMPLES); i--) {
    const before = Number(values[i - 1]);
    const after = Number(values[i]);
    const crossed = settings.triggerEdge === "rising"
      ? before < threshold - hysteresis && after >= threshold
      : before > threshold + hysteresis && after <= threshold;
    if (crossed) return times[i];
  }
  return undefined;
}

/** Janela de tempo visível: termina no trigger (ou na última amostra do CH1) menos a Posição de
 * Tempo, e cobre 10 divisões. */
export function scopeTimeWindow(channels: readonly ScopeChannelHistory[], settings: ScopeViewSettings): { startNs: number; endNs: number; triggerNs?: number } {
  const div = settings.timeDivMs || 1;
  const latest = channels[0]?.timestampsNs.at(-1) ?? 0;
  const triggerNs = settings.trigger !== "none" ? scopeTriggerTimeNs(channels[settings.trigger], settings) : undefined;
  const endNs = (triggerNs ?? latest) - settings.timePosMs * 1e6;
  return { startNs: endNs - div * 10e6, endNs, triggerNs };
}

export interface ScopeTrace {
  channel: number;
  /** Atributo `d` de um `<path>` SVG, vazio quando o canal não tem amostra na janela. */
  d: string;
}

export interface ScopeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Traços de cada canal visível, na mesma geometria do `draw()` da janela "Expande", que é a do
 * `PlotDisplay` do SimulIDE: a trilha `i % tracks`, `alturaDaTrilha/(10·voltDiv)` pixels por volt
 * (`m_scaleY = sizeY/(vTick*10)/tracks`), y = centro − (v + voltPos)·escala, recorte a 2 px da
 * borda da trilha e degrau (amostra e retenção) entre amostras. O Auto é o de
 * `OscopeChannel::updateStep`: V/div = pico-a-pico/10 e posição = −média. Com mais amostras do que
 * colunas de pixel, cada coluna guarda a primeira, a mínima, a máxima e a última amostra -- o
 * desenho fica o mesmo e o `<path>` não cresce com a profundidade do histórico. */
export function scopeTraces(
  channels: readonly ScopeChannelHistory[],
  settings: ScopeViewSettings,
  rect: ScopeRect,
  maxChannels = channels.length,
): ScopeTrace[] {
  const { startNs, endNs } = scopeTimeWindow(channels, settings);
  const frameNs = (settings.timeDivMs || 1) * 10e6;
  const tracks = Number(settings.tracks) || 1;
  const trackHeight = rect.height / tracks;
  const traces: ScopeTrace[] = [];
  const count = Math.min(channels.length, maxChannels);
  for (let i = 0; i < count; i++) {
    const channel = channels[i]!;
    if (settings.hidden[i] || channel.timestampsNs.length === 0) continue;
    const indices: number[] = [];
    for (let j = 0; j < channel.timestampsNs.length; j++) {
      const time = channel.timestampsNs[j]!;
      if (time >= startNs && time <= endNs) indices.push(j);
    }
    let voltDiv = settings.voltDiv[i] || 1;
    let voltPos = settings.voltPos[i] || 0;
    if (String(settings.auto) === String(i) && indices.length) {
      let low = Infinity;
      let high = -Infinity;
      for (const j of indices) {
        const value = Number(channel.values[j]);
        if (value < low) low = value;
        if (value > high) high = value;
      }
      voltDiv = Math.max(0.001, high - low) / 10;
      voltPos = -(high + low) / 2;
    }
    const slot = i % tracks;
    const trackTop = rect.y + slot * trackHeight;
    const base = trackTop + trackHeight / 2;
    const pixelsPerVolt = trackHeight / (10 * voltDiv);
    const xOf = (time: number) => rect.x + (time - startNs) / frameNs * rect.width;
    const yOf = (value: number) => Math.max(trackTop + 2, Math.min(trackTop + trackHeight - 2, base - (value + voltPos) * pixelsPerVolt));

    const points: Array<[number, number]> = [];
    if (indices.length > rect.width * 4) {
      let column = Number.NaN;
      let bucket: number[] = [];
      const flush = () => {
        if (bucket.length === 0) return;
        let minAt = bucket[0]!;
        let maxAt = bucket[0]!;
        for (const j of bucket) {
          if (Number(channel.values[j]) < Number(channel.values[minAt])) minAt = j;
          if (Number(channel.values[j]) > Number(channel.values[maxAt])) maxAt = j;
        }
        const keep = [...new Set([bucket[0]!, minAt, maxAt, bucket[bucket.length - 1]!])].sort((a, b) => a - b);
        for (const j of keep) points.push([xOf(channel.timestampsNs[j]!), yOf(Number(channel.values[j]))]);
        bucket = [];
      };
      for (const j of indices) {
        const at = Math.floor(xOf(channel.timestampsNs[j]!) - rect.x);
        if (at !== column) { flush(); column = at; }
        bucket.push(j);
      }
      flush();
    } else {
      for (const j of indices) points.push([xOf(channel.timestampsNs[j]!), yOf(Number(channel.values[j]))]);
    }

    let d = "";
    let previousY = 0;
    points.forEach(([x, y], index) => {
      d += index === 0
        ? `M ${round(x)} ${round(y)}`
        : ` L ${round(x)} ${round(previousY)} L ${round(x)} ${round(y)}`;
      previousY = y;
    });
    traces.push({ channel: i, d });
  }
  return traces;
}

/** Junta um lote do histórico ao que já se tem, sem repetir amostra: entra só o que é mais novo do
 * que a última amostra guardada. Dois consumidores (tela pequena e janela "Expande") podem pedir
 * deltas em instantes diferentes; com esta regra os dois ficam com o mesmo histórico. */
export function mergeScopeHistory(
  previous: readonly ScopeChannelHistory[] | undefined,
  incoming: readonly ScopeChannelHistory[],
  append: boolean,
  capacity = SCOPE_MIRROR_CAPACITY,
): ScopeChannelHistory[] {
  if (!append || !previous) {
    return incoming.map((channel) => ({
      timestampsNs: channel.timestampsNs.slice(-capacity),
      values: channel.values.slice(-capacity),
    }));
  }
  return incoming.map((channel, index) => {
    const before = previous[index] ?? { timestampsNs: [], values: [] };
    const lastNs = before.timestampsNs.at(-1);
    let from = 0;
    if (lastNs !== undefined) while (from < channel.timestampsNs.length && channel.timestampsNs[from]! <= lastNs) from++;
    const timestampsNs = [...before.timestampsNs, ...channel.timestampsNs.slice(from)];
    const values = [...before.values, ...channel.values.slice(from)];
    const drop = Math.max(0, timestampsNs.length - capacity);
    return { timestampsNs: timestampsNs.slice(drop), values: values.slice(drop) };
  });
}
