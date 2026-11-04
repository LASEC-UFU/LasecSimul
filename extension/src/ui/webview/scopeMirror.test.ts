import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import { mergeScopeHistory, parseScopeViewSettings, scopeTimeWindow, scopeTraces, type ScopeChannelHistory } from "./scopeMirror";

// A tela pequena tem de desenhar o MESMO que a janela "Expande". Este teste roda o <script> real de
// media/electrical-instrument.html num DOM falso, grava o traço que o draw() dela faz no canvas e
// compara, ponto a ponto, com scopeTraces() no mesmo retângulo de plotagem.

const extensionRoot = path.resolve(__dirname, "../../../..");
const html = fs.readFileSync(path.join(extensionRoot, "media", "electrical-instrument.html"), "utf8");
const script = /<script nonce="\{\{NONCE\}\}">([\s\S]*?)<\/script>/.exec(html)?.[1];
assert.ok(script, "electrical-instrument.html deveria ter o <script> da janela");

const CH1_COLOR = "#f0f064";
const WIDTH = 800;
const HEIGHT = 432;
// Retângulo de plotagem do draw() da janela: l=52, r=w-10, t=10, b=h-22.
const PANEL_RECT = { x: 52, y: 10, width: WIDTH - 62, height: HEIGHT - 32 };

type Point = [number, number];

let panelTexts: string[] = [];

function panelTrace(settings: Record<string, unknown>, channels: ScopeChannelHistory[]): Point[] {
  let stroke = "";
  let current: Point[] = [];
  const strokes: Array<{ color: string; points: Point[] }> = [];
  const texts: string[] = [];
  panelTexts = texts;
  const ctx = {
    font: "", fillStyle: "", lineWidth: 1,
    get strokeStyle() { return stroke; },
    set strokeStyle(value: string) { stroke = value; },
    clearRect() {}, fillRect() {}, fillText(text: string) { texts.push(text); }, setLineDash() {}, setTransform() {},
    beginPath() { current = []; },
    moveTo(x: number, y: number) { current.push([x, y]); },
    lineTo(x: number, y: number) { current.push([x, y]); },
    stroke() { strokes.push({ color: stroke, points: current }); },
  };
  const element = (): Record<string, unknown> => ({
    value: "", textContent: "", innerHTML: "", style: {}, dataset: {},
    querySelector: () => ({ style: {} }), querySelectorAll: () => [], setCustomValidity() {},
  });
  const canvas = {
    clientWidth: WIDTH, clientHeight: HEIGHT, width: WIDTH, height: HEIGHT,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ width: WIDTH, height: HEIGHT, left: 0, top: 0 }),
    setPointerCapture() {},
  };
  const named: Record<string, Record<string, unknown>> = {};
  const messageHandlers: Array<(event: { data: unknown }) => void> = [];
  const sandbox = {
    acquireVsCodeApi: () => ({ postMessage() {}, setState() {} }),
    document: {
      querySelector: (selector: string) => selector === "#plot" ? canvas : (named[selector] ??= element()),
      querySelectorAll: () => [],
      getElementById: (id: string) => (named[`#${id}`] ??= element()),
    },
    window: { addEventListener: (type: string, handler: (event: { data: unknown }) => void) => { if (type === "message") messageHandlers.push(handler); } },
    ResizeObserver: class { observe() {} },
    setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => undefined,
    devicePixelRatio: 1, Event: class {},
  };
  const source = script!
    .replaceAll("{{KIND}}", "scope")
    .replaceAll("{{TITLE_JSON}}", JSON.stringify("Oscope-1"))
    .replaceAll("{{SETTINGS}}", JSON.stringify(JSON.stringify(settings)));
  vm.runInNewContext(source, sandbox);
  strokes.length = 0;
  texts.length = 0;
  for (const handler of messageHandlers) handler({ data: { type: "history", payload: { componentId: "scope", oscope: { channels } } } });
  const traces = strokes.filter((entry) => entry.color === CH1_COLOR && entry.points.length > 1);
  assert.strictEqual(traces.length, 1, "a janela deveria desenhar um traço do CH1");
  return traces[0]!.points;
}

function mirrorTrace(settings: Record<string, unknown>, channels: ScopeChannelHistory[]): Point[] {
  const traces = scopeTraces(channels, parseScopeViewSettings(JSON.stringify(settings)), PANEL_RECT);
  const ch1 = traces.find((trace) => trace.channel === 0);
  assert.ok(ch1?.d, "a tela pequena deveria desenhar o CH1");
  const numbers = ch1.d.replace(/[ML]/g, " ").trim().split(/\s+/).map(Number);
  const points: Point[] = [];
  for (let i = 0; i < numbers.length; i += 2) points.push([numbers[i]!, numbers[i + 1]!]);
  return points;
}

function assertSameTrace(label: string, settings: Record<string, unknown>, channels: ScopeChannelHistory[]): void {
  const panel = panelTrace(settings, channels);
  const mirror = mirrorTrace(settings, channels);
  assert.strictEqual(mirror.length, panel.length, `${label}: mesmo número de pontos (janela ${panel.length}, tela pequena ${mirror.length})`);
  for (let i = 0; i < panel.length; i++) {
    const [px, py] = panel[i]!;
    const [mx, my] = mirror[i]!;
    assert.ok(Math.abs(px - mx) < 0.011 && Math.abs(py - my) < 0.011, `${label}: ponto ${i} difere: janela (${px}, ${py}), tela pequena (${mx}, ${my})`);
  }
}

// Senoide de 60 Hz entre 0 e 3,4 V amostrada a cada 50 µs (Oscope `sampleIntervalNs` padrão), em
// tempo simulado, mais três canais em 0 V.
function sineChannels(samples: number, firstNs = 1e9): ScopeChannelHistory[] {
  const timestampsNs = Array.from({ length: samples }, (_, i) => firstNs + i * 50_000);
  const sine = timestampsNs.map((t) => 1.7 + 1.7 * Math.sin(2 * Math.PI * 60 * (t - firstNs) / 1e9));
  return [
    { timestampsNs, values: sine },
    ...[1, 2, 3].map(() => ({ timestampsNs: [...timestampsNs], values: timestampsNs.map(() => 0) })),
  ];
}

// Configuração salva pelo usuário no projeto II1P07_RMS (2026-11-04).
const userSettings = {
  timeDivMs: 4.2148, timePosMs: 3.8697, activeChannel: 0, tracks: 1, filter: 0.05, trigger: "none",
  triggerEdge: "rising", auto: "none", thresholdRising: 2.5, thresholdFalling: 2.5,
  hidden: [false, true, true, true], bus: [false, false, false, false],
  voltDiv: [19.604, 0.00016666666666666666, 1, 1], voltPos: [2.257, 0, 0, 0],
  tunnels: ["", "", "", ""], pauseCondition: "", version: 1,
};

// Mesma configuração nas unidades do SimulIDE (versão 2): 19,604/40 V/div e a posição somada.
const userSettingsV2 = { ...userSettings, voltDiv: [0.4901, 0.00016666666666666666 / 40, 0.025, 0.025], voltPos: [-2.257, 0, 0, 0], version: 2 };

assertSameTrace("configuração do projeto (versão 1, convertida)", userSettings, sineChannels(900));
assert.ok(panelTexts.includes("CH1 0.4901 V/div"), `a janela deveria mostrar o V/div convertido: ${JSON.stringify(panelTexts)}`);
assertSameTrace("configuração do projeto (versão 2)", userSettingsV2, sineChannels(900));
assertSameTrace("trigger de subida no CH1", { ...userSettingsV2, trigger: 0, timePosMs: 0, timeDivMs: 2 }, sineChannels(900));
assertSameTrace("descida, duas trilhas", { ...userSettingsV2, trigger: 0, triggerEdge: "falling", thresholdFalling: 1.7, tracks: 2, voltDiv: [0.2, 1, 1, 1], voltPos: [-1.7, 0, 0, 0] }, sineChannels(700));
assertSameTrace("auto no CH1", { ...userSettingsV2, auto: 0 }, sineChannels(900));
assertSameTrace("padrões (sem configuração salva)", {}, sineChannels(400));
assertSameTrace("formato do importador do SimulIDE", {
  version: 1, kind: "oscope", timeDivMs: 4, tracks: 1, triggerSource: "none", autoScaleChannel: "none", filterThreshold: 0.05,
  channels: [{ hidden: false, voltDiv: 0.5, voltPos: -1.7, timePosMs: 1 }, ...[1, 2, 3].map(() => ({ hidden: true, voltDiv: 1, voltPos: 0, timePosMs: 0 }))],
}, sineChannels(900));

{
  // A conversão da versão 1 não muda a imagem: o traço convertido é o que a conta antiga da janela
  // (`ph/tracks*4/voltDiv` pixels por volt e `voltPos` como tensão no centro) desenhava.
  const channels = sineChannels(900);
  const migrated = parseScopeViewSettings(JSON.stringify(userSettings));
  assert.ok(Math.abs(migrated.voltDiv[0]! - 0.4901) < 1e-12 && migrated.voltPos[0] === -2.257, `conversão: ${JSON.stringify(migrated)}`);
  const { startNs, endNs } = scopeTimeWindow(channels, migrated);
  const rect = { x: 0, y: 0, width: 1000, height: 135 }; // largo o bastante para não reduzir por coluna
  const oldY = (v: number) => Math.max(2, Math.min(133, 67.5 - (v - 2.257) * 135 * 4 / 19.604));
  const ch1 = channels[0]!;
  const visible = ch1.timestampsNs.map((t, i) => [t, ch1.values[i]!] as const).filter(([t]) => t >= startNs && t <= endNs);
  const newYs = scopeTraces(channels, migrated, rect)[0]!.d.replace(/[ML]/g, " ").trim().split(/\s+/).map(Number).filter((_, i) => i % 2 === 1);
  // O path é degrau: o y de cada amostra aparece no M inicial e no segundo L de cada passo.
  const sampleYs = [newYs[0]!, ...newYs.slice(1).filter((_, i) => i % 2 === 1)];
  assert.strictEqual(sampleYs.length, visible.length);
  visible.forEach(([, v], i) => assert.ok(Math.abs(sampleYs[i]! - oldY(v)) < 0.011, `amostra ${i}: antes ${oldY(v)}, agora ${sampleYs[i]}`));
}

{
  // Auto (OscopeChannel::updateStep): V/div = pico-a-pico/10 e o sinal ocupa a trilha inteira.
  const rect = { x: 0, y: 0, width: 135, height: 135 };
  const ys = scopeTraces(sineChannels(900), parseScopeViewSettings(JSON.stringify({ ...userSettingsV2, auto: 0 })), rect)[0]!
    .d.replace(/[ML]/g, " ").trim().split(/\s+/).map(Number).filter((_, i) => i % 2 === 1);
  assert.ok(Math.min(...ys) < 4 && Math.max(...ys) > 131, `auto deveria usar a trilha inteira: ${Math.min(...ys)}..${Math.max(...ys)}`);
}

{
  // Formato do importador do SimulIDE: os números já são os do SimulIDE.
  const imported = parseScopeViewSettings(JSON.stringify({
    version: 1, timeDivMs: 5, tracks: 2, triggerSource: 0, autoScaleChannel: "none", filterThreshold: 0.1,
    channels: [{ voltDiv: 0.5, voltPos: -1.65, hidden: false, timePosMs: 2 }, { voltDiv: 2, voltPos: 0, hidden: true, timePosMs: 0 }],
  }));
  assert.deepStrictEqual([imported.voltDiv, imported.voltPos, imported.hidden], [[0.5, 2], [-1.65, 0], [false, true]]);
  assert.deepStrictEqual([imported.trigger, imported.timePosMs, imported.filter, imported.tracks, imported.timeDivMs], [0, 2, 0.1, 2, 5]);
  // Versão 2 é lida sem conversão.
  assert.deepStrictEqual(parseScopeViewSettings(JSON.stringify(userSettingsV2)).voltDiv.slice(0, 1), [0.4901]);
}

{
  // Janela de tempo: fim = última amostra − Posição de Tempo; 10 divisões.
  const channels = sineChannels(900);
  const window = scopeTimeWindow(channels, parseScopeViewSettings(JSON.stringify(userSettings)));
  const last = channels[0]!.timestampsNs.at(-1)!;
  assert.strictEqual(window.endNs, last - 3.8697e6);
  assert.strictEqual(window.endNs - window.startNs, 42.148e6);
}

{
  // Muitas amostras por coluna: o path fica limitado pelos pixels e o pico continua lá.
  const samples = 60_000;
  const timestampsNs = Array.from({ length: samples }, (_, i) => i * 1000);
  const values = timestampsNs.map((_, i) => i === 31_337 ? 3.3 : 0);
  const rect = { x: 0, y: 0, width: 135, height: 135 };
  const settings = parseScopeViewSettings(JSON.stringify({ timeDivMs: 6, voltDiv: [0.4, 1, 1, 1], version: 2 }));
  const [trace] = scopeTraces([{ timestampsNs, values }], settings, rect);
  const ys = trace!.d.replace(/[ML]/g, " ").trim().split(/\s+/).map(Number).filter((_, i) => i % 2 === 1);
  assert.ok(Math.min(...ys) < 67.5 - 50, "decimação deveria preservar o pico de 3,3 V");
  assert.ok(trace!.d.length < 20_000, `path deveria ser limitado pelos pixels, tem ${trace!.d.length} caracteres`);
}

{
  // Deltas cruzados de dois consumidores nunca repetem amostra.
  const first = [{ timestampsNs: [1, 2, 3], values: [10, 20, 30] }];
  const overlapping = [{ timestampsNs: [2, 3, 4, 5], values: [20, 30, 40, 50] }];
  const merged = mergeScopeHistory(first, overlapping, true);
  assert.deepStrictEqual(merged, [{ timestampsNs: [1, 2, 3, 4, 5], values: [10, 20, 30, 40, 50] }]);
  assert.deepStrictEqual(mergeScopeHistory(merged, [{ timestampsNs: [7], values: [70] }], false), [{ timestampsNs: [7], values: [70] }]);
  const capped = mergeScopeHistory([{ timestampsNs: [1, 2], values: [1, 2] }], [{ timestampsNs: [3, 4], values: [3, 4] }], true, 3);
  assert.deepStrictEqual(capped, [{ timestampsNs: [2, 3, 4], values: [2, 3, 4] }]);
}

{
  // Configuração ilegível ou de outro formato cai nos padrões da janela.
  const fallback = parseScopeViewSettings("{inválido");
  assert.strictEqual(fallback.timeDivMs, 1);
  assert.strictEqual(fallback.trigger, "none");
  assert.deepStrictEqual(fallback.voltDiv, [1, 1, 1, 1]);
}

console.log("scopeMirror tests passed");
