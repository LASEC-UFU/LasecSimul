/**
 * Geometria dos símbolos de componente e layout dos terminais (pinos) — inspirada no SimulIDE-dev
 * (`src/components/passive/*`, `src/components/sources/ground.cpp`, `src/gui/circuitwidget/pin.cpp`):
 * zigzag pro resistor, placas paralelas pro capacitor, arcos pro indutor, linhas decrescentes pro
 * terra, terminal como círculo pequeno na ponta de um "lead" reto.
 *
 * Cada `typeId` tem sua PRÓPRIA caixa (`ComponentBox`) — `Component::boundingRect()` do SimulIDE
 * devolve exatamente a geometria real do desenho, nunca um card uniforme (ver `component.h`); aqui é
 * o mesmo princípio: um resistor (70×28) não ocupa o mesmo espaço que um terra (48×56). Geometria e
 * layout de pino são calculados a partir da caixa do tipo, nunca de uma constante global de tamanho.
 */

import { ComponentViewSpec, PackageDescriptor, PackagePin, PackageShape, SIMULIDE_PACKAGE_GRID_UNIT, SimulidePaintSpec, ViewSpecHitTest } from "./model.js";
import { simulidePaintToPackageShapes } from "./simulidePaint.js";

export interface ComponentBox {
  width: number;
  height: number;
}

const PIN_INSET = 6; // usado só nos fallbacks; símbolos alinhados ao SimulIDE declaram seus pinos exatos.
const LEAD_MARGIN = 18;

export const PIN_RADIUS = 4.5;
const PACKAGE_PIN_LABEL_FONT_SIZE = 7;
const COMP2PIN_BOX: ComponentBox = { width: 32, height: 16 };
const SWITCH_BOX: ComponentBox = { width: 32, height: 24 };
const SMALL_METER_BOX: ComponentBox = { width: 56, height: 40 };
const TRANSISTOR_BOX: ComponentBox = { width: 32, height: 32 };
const TRIANGLE_AMP_BOX: ComponentBox = { width: 48, height: 32 };

// ── Símbolo declarativo real (Épico G) ──────────────────────────────────────────────────────────
// Quando um typeId tem `package` (device.json/.lssub.json, ver model.ts), cada pino é desenhado na
// posição REAL declarada (qualquer lado, com nome) -- nunca o algoritmo genérico esquerda/direita
// abaixo, que existe só pra built-ins sem package. `x`/`y` de um PackagePin é onde o "lead" toca o
// corpo; a ponta real (onde o fio conecta) é `x + cos(angle)*length, y + sin(angle)*length` -- pode
// cair fora de `0..width`/`0..height` (lead saindo da borda), por isso o layout é "resolvido" uma
// vez (desloca tudo pra um espaço sem coordenada negativa) em vez de usar `width`/`height` crus.
interface ResolvedPackagePin extends PackagePin {
  tipX: number;
  tipY: number;
}

interface ResolvedPackage {
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  scaleX: number;
  scaleY: number;
  pins: ResolvedPackagePin[];
  source: PackageDescriptor;
}

function resolvePackageLayout(pkg: PackageDescriptor): ResolvedPackage {
  let minX = 0;
  let minY = 0;
  let maxX = pkg.width;
  let maxY = pkg.height;
  const tips = pkg.pins.map((pin) => {
    const electrical = packagePinElectricalPoint(pin);
    const visualEnd = packagePinVisualEnd(pin);
    const tipX = electrical.x;
    const tipY = electrical.y;
    minX = Math.min(minX, tipX, pin.x, visualEnd.x);
    maxX = Math.max(maxX, tipX, pin.x, visualEnd.x);
    minY = Math.min(minY, tipY, pin.y, visualEnd.y);
    maxY = Math.max(maxY, tipY, pin.y, visualEnd.y);
    // Rótulo pode ter posição própria, arrastada pra fora do alcance do lead (ver model.ts
    // PackagePin.labelX/labelY) -- sem isso no cálculo, um rótulo arrastado bem pra fora poderia
    // ficar fora do viewBox calculado (overflow:visible evita corte, mas o box do componente
    // ficaria menor do que devia).
    if (pin.labelX !== undefined) { minX = Math.min(minX, pin.labelX); maxX = Math.max(maxX, pin.labelX); }
    if (pin.labelY !== undefined) { minY = Math.min(minY, pin.labelY); maxY = Math.max(maxY, pin.labelY); }
    return { ...pin, tipX, tipY };
  });
  const offsetX = -minX;
  const offsetY = -minY;
  const nativeWidth = maxX - minX;
  const nativeHeight = maxY - minY;
  const scaleX = typeof pkg.schematicWidth === "number" && pkg.schematicWidth > 0 && pkg.width > 0 ? pkg.schematicWidth / pkg.width : 1;
  const scaleY = typeof pkg.schematicHeight === "number" && pkg.schematicHeight > 0 && pkg.height > 0 ? pkg.schematicHeight / pkg.height : 1;
  const displayWidth = nativeWidth * scaleX;
  const displayHeight = nativeHeight * scaleY;
  return {
    width: displayWidth,
    height: displayHeight,
    offsetX,
    offsetY,
    scaleX,
    scaleY,
    pins: tips.map((pin) => ({
      ...pin,
      tipX: (pin.tipX + offsetX) * scaleX,
      tipY: (pin.tipY + offsetY) * scaleY,
    })),
    source: pkg,
  };
}

function packagePinElectricalPoint(pin: PackagePin): { x: number; y: number } {
  if (pin.leadOrigin === "terminal") return { x: pin.x, y: pin.y };
  const rad = (pin.angle * Math.PI) / 180;
  return { x: pin.x + Math.cos(rad) * pin.length, y: pin.y + Math.sin(rad) * pin.length };
}

function packagePinVisualEnd(pin: PackagePin): { x: number; y: number } {
  if (pin.length === 0) return { x: pin.x, y: pin.y };
  const visualLength = Math.max(0, pin.length - (pin.leadEndTrim ?? 0));
  if (pin.leadOrigin === "terminal") {
    const rad = ((180 - pin.angle) * Math.PI) / 180;
    return { x: pin.x + Math.cos(rad) * visualLength, y: pin.y + Math.sin(rad) * visualLength };
  }
  const rad = (pin.angle * Math.PI) / 180;
  return { x: pin.x + Math.cos(rad) * visualLength, y: pin.y + Math.sin(rad) * visualLength };
}

const RESOLVED_PACKAGE_BY_TYPE_ID = new Map<string, ResolvedPackage>();
/** Aparência ALTERNATIVA opcional ("Chip or Logic Symbol", igual ao `SubPackage::Logic_Symbol` do
 * SimulIDE real -- booleano simples, não uma lista de N variantes). Mapa SEPARADO do padrão (não um
 * 2º registro no mesmo mapa) pra não precisar inventar uma chave composta -- escolhido em
 * `resolvedPackageFor` pela propriedade `logicSymbol` da INSTÂNCIA, ver model.ts
 * `WebviewComponentCatalogEntry.logicSymbolPackage`. */
const RESOLVED_LOGIC_SYMBOL_PACKAGE_BY_TYPE_ID = new Map<string, ResolvedPackage>();

/** Chamado quando o catálogo chega/atualiza (ver `main.ts`) -- cacheia o layout resolvido (cálculo
 * de deslocamento é o mesmo pra toda renderização do mesmo typeId, não precisa repetir por frame).
 * `undefined` remove (typeId sem package mais, ou catálogo recarregado do zero). */
export function registerPackage(typeId: string, pkg: PackageDescriptor | undefined, logicSymbolPkg?: PackageDescriptor): void {
  if (pkg && pkg.pins.length > 0) RESOLVED_PACKAGE_BY_TYPE_ID.set(typeId, resolvePackageLayout(pkg));
  else RESOLVED_PACKAGE_BY_TYPE_ID.delete(typeId);

  if (logicSymbolPkg && logicSymbolPkg.pins.length > 0) RESOLVED_LOGIC_SYMBOL_PACKAGE_BY_TYPE_ID.set(typeId, resolvePackageLayout(logicSymbolPkg));
  else RESOLVED_LOGIC_SYMBOL_PACKAGE_BY_TYPE_ID.delete(typeId);
}

/** `properties.logicSymbol === true` E existe uma variante Logic Symbol registrada pra este typeId
 * -> usa ela; qualquer outro caso (sem variante, propriedade ausente/falsa, ou sem `properties`
 * nenhuma -- chamadas legadas que só passam typeId) -> cai no `package` padrão de sempre. */
function resolvedPackageFor(typeId: string, properties?: Record<string, unknown>): ResolvedPackage | undefined {
  if (properties?.logicSymbol === true) {
    const logicSymbolResolved = RESOLVED_LOGIC_SYMBOL_PACKAGE_BY_TYPE_ID.get(typeId);
    if (logicSymbolResolved) return logicSymbolResolved;
  }
  return RESOLVED_PACKAGE_BY_TYPE_ID.get(typeId);
}

function packagePinMatches(pin: PackagePin, pinId: string): boolean {
  return pin.id === pinId || Boolean(pin.aliases?.includes(pinId));
}

function stateVisibleMatches(stateVisible: PackagePin["stateVisible"] | undefined, properties?: Record<string, unknown>): boolean {
  if (!stateVisible) return true;
  for (const [prop, accepted] of Object.entries(stateVisible.when)) {
    if (!accepted.includes(String(properties?.[prop]))) return false;
  }
  return true;
}

/** Corpo do símbolo a partir do `package` real, se este typeId tiver um registrado -- `undefined`
 * pra `main.ts` cair em `catalogEntry?.symbolSvg ?? componentSymbolSvg(typeId)` (mesma prioridade
 * de sempre, só com `package` real entrando ANTES de symbolSvg).
 * `componentId` é opcional mas necessário para ativar o ViewSpec renderer (gradientes escopados + stateProjection).
 * Chamadas sem `componentId` (ex: testes, paleta) usam o caminho legado `shapes[]`. */
export function packageSymbolSvg(typeId: string, properties?: Record<string, unknown>, componentId?: string): string | undefined {
  const resolved = resolvedPackageFor(typeId, properties);
  return resolved ? packageBodySvg(resolved, componentId, properties) : undefined;
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatRailVoltage(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return Number(value.toFixed(2)).toString();
}

function symbolReadoutNumber(properties?: Record<string, unknown>): number | undefined {
  return typeof properties?.__readout === "number" ? properties.__readout : undefined;
}

function symbolReadoutArray(properties?: Record<string, unknown>): number[] {
  return Array.isArray(properties?.__readout) ? properties.__readout.map((value) => Number(value) || 0) : [];
}

function symbolHistoryArray(properties?: Record<string, unknown>): number[] {
  return Array.isArray(properties?.__history) ? properties.__history.map((value) => Number(value) || 0) : [];
}

function symbolHistoryMatrix(properties?: Record<string, unknown>): number[][] {
  if (!Array.isArray(properties?.__history)) return [];
  return properties.__history.map((row) => Array.isArray(row) ? row.map((value) => Number(value) || 0) : []);
}

function formatLcdNumber(value: number | undefined): string {
  return (value ?? 0).toFixed(3);
}

function lcdValueFontSize(text: string): number {
  if (text.length >= 7) return 10;
  if (text.length >= 6) return 11;
  return 14;
}

function formatHz(value: number | undefined): string {
  const hz = value ?? 0;
  if (hz >= 1000) return `${Number((hz / 1000).toFixed(2))} kHz`;
  return `${Math.round(hz)} Hz`;
}

function tracePath(history: number[], x: number, y: number, width: number, height: number, min = -5, max = 5): string {
  const samples = history.length > 1 ? history : [0, 0];
  const span = Math.max(1e-9, max - min);
  return samples
    .map((value, index) => {
      const px = x + (width * index) / Math.max(1, samples.length - 1);
      const normalized = Math.max(0, Math.min(1, (value - min) / span));
      const py = y + height - normalized * height;
      return `${index === 0 ? "M" : "L"} ${px.toFixed(1)} ${py.toFixed(1)}`;
    })
    .join(" ");
}

function packageShapeSvg(shape: PackageShape, extraTransform?: string): string {
  const cls = shape.cssClass ? ` class="${shape.cssClass}"` : "";
  const transform = [shape.transform, extraTransform].filter(Boolean).join(" ");
  const xf = transform ? ` transform="${escapeXmlText(transform)}"` : "";
  const fill = shape.fill ?? "none";
  const paintAttrs =
    `${shape.strokeLinecap ? ` stroke-linecap="${shape.strokeLinecap}"` : ""}` +
    `${shape.strokeLinejoin ? ` stroke-linejoin="${shape.strokeLinejoin}"` : ""}` +
    `${shape.strokeDasharray ? ` stroke-dasharray="${escapeXmlText(shape.strokeDasharray)}"` : ""}` +
    `${shape.fillRule ? ` fill-rule="${shape.fillRule}"` : ""}` +
    `${shape.opacity !== undefined ? ` opacity="${shape.opacity}"` : ""}`;
  switch (shape.kind) {
    case "rect":
      return `<rect${cls}${xf} x="${shape.x ?? 0}" y="${shape.y ?? 0}" width="${shape.w ?? 0}" height="${shape.h ?? 0}"${shape.rx !== undefined ? ` rx="${shape.rx}"` : ""}${shape.ry !== undefined ? ` ry="${shape.ry}"` : ""} stroke="${shape.stroke ?? "currentColor"}" fill="${fill}" stroke-width="${shape.strokeWidth ?? 1}"${paintAttrs}/>`;
    case "line":
      return `<line${cls}${xf} x1="${shape.x1 ?? 0}" y1="${shape.y1 ?? 0}" x2="${shape.x2 ?? 0}" y2="${shape.y2 ?? 0}" stroke="${shape.stroke ?? "currentColor"}" stroke-width="${shape.strokeWidth ?? 1}"${paintAttrs}/>`;
    case "ellipse":
      return `<ellipse${cls}${xf} cx="${shape.cx ?? 0}" cy="${shape.cy ?? 0}" rx="${shape.rx ?? 0}" ry="${shape.ry ?? 0}" stroke="${shape.stroke ?? "currentColor"}" fill="${fill}" stroke-width="${shape.strokeWidth ?? 1}"${paintAttrs}/>`;
    case "svg":
      return shape.value ?? "";
    case "polygon": {
      const pts = (shape.points ?? []).map(p => `${p.x},${p.y}`).join(" ");
      return `<polygon${cls}${xf} points="${pts}" stroke="${shape.stroke ?? "currentColor"}" fill="${fill}" stroke-width="${shape.strokeWidth ?? 1}"${paintAttrs}/>`;
    }
    case "path":
      return `<path${cls}${xf} d="${escapeXmlText(shape.d ?? "")}" stroke="${shape.stroke ?? "currentColor"}" fill="${fill}" stroke-width="${shape.strokeWidth ?? 1}"${paintAttrs}/>`;
    case "image": {
      const href = shape.href ?? shape.value ?? "";
      return `<image${cls}${xf} x="${shape.x ?? 0}" y="${shape.y ?? 0}" width="${shape.w ?? 0}" height="${shape.h ?? 0}" preserveAspectRatio="${escapeXmlText(shape.preserveAspectRatio ?? "none")}" href="${escapeXmlText(href)}"${paintAttrs}/>`;
    }
    case "text":
    default:
      return `<text${cls}${xf} x="${shape.x ?? 0}" y="${shape.y ?? 0}" text-anchor="${shape.textAnchor ?? "middle"}" font-size="${shape.fontSize ?? 11}"${shape.fontFamily ? ` font-family="${escapeXmlText(shape.fontFamily)}"` : ""}${shape.fontWeight ? ` font-weight="${escapeXmlText(String(shape.fontWeight))}"` : ""} fill="${shape.color ?? "currentColor"}"${paintAttrs}>${escapeXmlText(shape.value ?? "")}</text>`;
  }
}

/** Tradutor genérico SimulIDE→LasecSimul pra typeIds BUILT-IN (sem `devices/*.json`/`package`).
 * Reusa o MESMO motor já usado pelos devices JSON-backed (`simulidePaintToPackageShapes` +
 * `packageShapeSvg`, ver `simulidePaint.ts`) -- um `SimulidePaintSpec` carrega as primitivas
 * (linha/retângulo/elipse/arco/path/polígono/texto) em coordenadas LOCAIS copiadas quase
 * literalmente do `paint()`/`m_area`/`Pin` reais do C++ (ver `spec.source`), e o motor faz UMA
 * transformação de coordenadas (translação, já que `bounds.w/h` sempre bate com `box.width/height`
 * aqui -- built-ins não reescalam, só traduzem) pra todas elas de uma vez. Isso substitui deslocar
 * cada linha/retângulo/pino à mão por componente -- a mesma fonte de erro (bug real encontrado:
 * `sources.battery` tinha as 4 barras com espessuras alternadas por engano; o C++ real usa
 * `pen.setWidth(3)` uma vez só, pras 4) some quando a tradução é mecânica, não manual. */
function builtinPaintSvg(spec: SimulidePaintSpec, box: ComponentBox, properties?: Record<string, unknown>): string {
  const shapes = simulidePaintToPackageShapes(spec, box.width, box.height, properties ?? {});
  return shapes.map((shape) => packageShapeSvg(shape)).join("");
}

// ── Fontes (pasta "Sources" do SimulIDE) -- specs SimulidePaint (ver `builtinPaintSvg`) ───────────
// Coordenadas de cada `primitives[]` são as mesmas que aparecem literalmente no `paint()`/`m_area`/
// `Pin` do arquivo citado em `source` -- não precisam de nenhuma conta de deslocamento manual, só
// copiar do C++. `bounds` é a união do `m_area` real com a extremidade de cada pino (o pino real
// costuma sair fora do `m_area` visual).

const GROUND_PAINT: SimulidePaintSpec = {
  version: 1,
  source: { file: "sources/ground.cpp", className: "Ground", method: "paint" },
  bounds: { x: -8, y: -16, w: 16, h: 18 },
  defaultStroke: "currentColor",
  defaultStrokeWidth: 2.5,
  primitives: [
    // lead do pino: NÃO está no paint() real (o IoPin/base class desenha isso sozinho no SimulIDE
    // real -- built-ins do LasecSimul não têm esse mecanismo automático, então o lead é desenhado
    // aqui explicitamente; usa pen 3px, igual ao Pin::paint() real).
    { kind: "line", x1: 0, y1: -16, x2: 0, y2: -8, strokeWidth: 3 },
    { kind: "line", x1: -6.6, y1: -8, x2: 6.6, y2: -8 },
    { kind: "line", x1: -4.3, y1: -4, x2: 4.3, y2: -4 },
    { kind: "line", x1: -1.9, y1: 0, x2: 1.9, y2: 0 },
  ],
};

const BATTERY_PAINT: SimulidePaintSpec = {
  version: 1,
  source: { file: "sources/battery.cpp", className: "Battery", method: "paint", notes: "Comp2Pin: pinos herdados em x=±16." },
  bounds: { x: -16, y: -10, w: 32, h: 20 },
  defaultStroke: "currentColor",
  defaultStrokeWidth: 3,
  primitives: [
    { kind: "line", x1: -16, y1: 0, x2: -7, y2: 0, strokeWidth: 1.5 },
    { kind: "line", x1: -7, y1: -8, x2: -7, y2: 8 },
    { kind: "line", x1: -2, y1: -3, x2: -2, y2: 3 },
    { kind: "line", x1: 3, y1: -8, x2: 3, y2: 8 },
    { kind: "line", x1: 8, y1: -3, x2: 8, y2: 3 },
    { kind: "line", x1: 8, y1: 0, x2: 16, y2: 0, strokeWidth: 1.5 },
  ],
};

const RAIL_PAINT: SimulidePaintSpec = {
  version: 1,
  source: {
    file: "sources/rail.cpp",
    className: "Rail",
    method: "paint",
    notes: "setRotation(90) no construtor real -- pontos locais já rotacionados 90° aqui (funil aponta pra baixo, não a bandeirola horizontal dos pontos crus).",
  },
  bounds: { x: -8, y: -4, w: 16, h: 20 },
  primitives: [
    { kind: "polygon", points: [{ x: 6.5, y: -1.5 }, { x: -6.5, y: -1.5 }, { x: -1, y: 9 }, { x: 1, y: 9 }], fill: "#ffa500", stroke: "currentColor", strokeWidth: 2 },
    { kind: "line", x1: 0, y1: 9, x2: 0, y2: 16, strokeWidth: 1.5 },
  ],
};

/** fixedvolt.cpp: `m_button` (widget nativo QGraphicsProxyWidget nas coordenadas reais, ver
 * `FixedVolt::FixedVolt`) fica 16x16 à esquerda do corpo -- posição exata do proxy não é
 * 100% reconstruível só da leitura do `.cpp` (a geometria de QGraphicsProxyWidget soma
 * `setGeometry`/`setPos` de um jeito que depende do layout interno do Qt em tempo de execução);
 * usa a posição já validada visualmente lado a lado com o SimulIDE real (2026-07-05). */
function fixedVoltPaint(): SimulidePaintSpec {
  return {
    version: 1,
    source: { file: "sources/fixedvolt.cpp", className: "FixedVolt", method: "paint" },
    bounds: { x: -32, y: -8, w: 48, h: 16 },
    defaultStroke: "currentColor",
    primitives: [
      { kind: "rect", x: -32, y: -8, w: 16, h: 16, rx: 2, ry: 2, fill: "#dddddd", strokeWidth: 1.5, cssClass: "toggle-hit-zone" },
      { kind: "line", x1: 8, y1: 0, x2: 16, y2: 0, strokeWidth: 3 },
      { kind: "roundedRect", x: -8, y: -8, w: 16, h: 16, rx: 2, ry: 2, fill: "#e6e6ff", strokeWidth: 1.5, cssClass: "fixed-volt-body toggle-hit-zone", stateFill: { prop: "out", map: { true: "#ffa600", false: "#e6e6ff" } } },
    ],
  };
}

/** clock.cpp/wavegen.cpp (ClockBase): mesmo `m_button` do FixedVolt (herdado, posição idêntica) +
 * `m_area` próprio (-14,-8,22,16). `pulsePath` é o glifo de onda (traços fixos do Clock real,
 * `drawLine` x6; WaveGen usa um path aproximado, o real troca de PIXMAP bitmap por tipo de onda). */
function clockLikePaint(pulseOrWavePath: string, pins: "one" | "two"): SimulidePaintSpec {
  return {
    version: 1,
    source: { file: "sources/clock-base.cpp + clock.cpp/wavegen.cpp", className: "ClockBase", method: "paint" },
    bounds: { x: -32, y: -8, w: 48, h: 16 },
    defaultStroke: "currentColor",
    primitives: [
      { kind: "rect", x: -32, y: -8, w: 16, h: 16, rx: 2, ry: 2, fill: "#dddddd", strokeWidth: 1.5, cssClass: "toggle-hit-zone" },
      { kind: "roundedRect", x: -14, y: -8, w: 22, h: 16, rx: 2, ry: 2, fill: "#e6e6ff", strokeWidth: 1, stateFill: { prop: "running", map: { true: "#fac832", false: "#e6e6ff" } } },
      { kind: "path", d: pulseOrWavePath, fill: "none", strokeWidth: 1.5 },
      { kind: "line", x1: 8, y1: pins === "two" ? -4 : 0, x2: 16, y2: pins === "two" ? -4 : 0, strokeWidth: 1.5 },
      ...(pins === "two" ? ([{ kind: "line", x1: 8, y1: 4, x2: 16, y2: 4, strokeWidth: 1.5 }] as SimulidePaintSpec["primitives"]) : []),
    ],
  };
}

const CLOCK_PULSE_PATH = "M -11 3 L -11 -3 L -5 -3 L -5 3 L 1 3 L 1 -3 L 4 -3";
const WAVE_GEN_SINE_PATH = "M -10 0 Q -6 -5 -3 0 T 6 0";

const CONTROLLED_SOURCE_PAINT: SimulidePaintSpec = {
  // csource.cpp: estado default real (Control_Pins=true, CurrSource=true, CurrControl=false, que é
  // também o default do Core -- ver CoreApplication.cpp). Alternar essas 3 propriedades muda a
  // forma real (círculo em vez de diamante, seta em direção diferente, marca de tensão-controlada)
  // -- não implementado ainda, documentado aqui como próximo passo, não parte deste fix.
  version: 1,
  source: { file: "sources/csource.cpp", className: "Csource", method: "paint" },
  bounds: { x: -24, y: -20, w: 40, h: 40 },
  defaultStroke: "currentColor",
  primitives: [
    { kind: "rect", x: -16, y: -16, w: 32, h: 32, fill: "none", strokeWidth: 1 },
    { kind: "polygon", points: [{ x: -8, y: 0 }, { x: 0, y: -13 }, { x: 8, y: 0 }, { x: 0, y: 13 }], fill: "none", strokeWidth: 2 },
    { kind: "line", x1: 0, y1: -5, x2: 0, y2: 5, strokeWidth: 1 },
    { kind: "path", d: "M -2 2 L 0 5 L 2 2", fill: "none", strokeWidth: 1 },
    { kind: "line", x1: -24, y1: -8, x2: -16, y2: -8, strokeWidth: 1.5 },
    { kind: "line", x1: -24, y1: 8, x2: -16, y2: 8, strokeWidth: 1.5 },
    { kind: "text", x: -21, y: -10, value: "+", fill: "#c65252", fontSize: 8 },
    { kind: "text", x: -21, y: 11, value: "−", fill: "#888888", fontSize: 8 },
    { kind: "line", x1: 0, y1: -20, x2: 0, y2: -13, strokeWidth: 1.5 },
    { kind: "line", x1: 0, y1: 20, x2: 0, y2: 13, strokeWidth: 1.5 },
  ],
};

// ── ViewSpec renderer ────────────────────────────────────────────────────────────────────────────

/** Resolve um mapeamento linear de eixo: propRange → pixelRange. */
function resolveAxisMapping(value: number, propRange: [number, number], pixelRange: [number, number]): number {
  const t = propRange[1] === propRange[0] ? 0 : (value - propRange[0]) / (propRange[1] - propRange[0]);
  return pixelRange[0] + t * (pixelRange[1] - pixelRange[0]);
}

function numericViewSpecProperty(properties: Record<string, unknown>, prop: string, fallback: number): number {
  const value = Number(properties[prop]);
  return Number.isFinite(value) ? value : fallback;
}

interface ViewSpecResolvedProjection {
  transform?: string;
  fill?: string;
  visible?: boolean;
}

/** Computa a projeção visual inicial para um `partId` com base nas propriedades do componente. */
function viewSpecResolvedProjection(partId: string, spec: ComponentViewSpec, properties: Record<string, unknown>): ViewSpecResolvedProjection {
  const projections = spec.stateProjection?.[partId];
  if (!projections) return {};
  const transforms: string[] = [];
  let fill: string | undefined;
  let visible: boolean | undefined;
  for (const proj of projections) {
    if (proj.kind === "translate") {
      const dx = proj.x
        ? resolveAxisMapping(numericViewSpecProperty(properties, proj.x.prop, (proj.x.propRange[0] + proj.x.propRange[1]) / 2), proj.x.propRange, proj.x.pixelRange)
        : 0;
      const dy = proj.y
        ? resolveAxisMapping(numericViewSpecProperty(properties, proj.y.prop, (proj.y.propRange[0] + proj.y.propRange[1]) / 2), proj.y.propRange, proj.y.pixelRange)
        : 0;
      if (dx !== 0 || dy !== 0) transforms.push(`translate(${dx.toFixed(2)},${dy.toFixed(2)})`);
    } else if (proj.kind === "rotate") {
      const pos = numericViewSpecProperty(properties, proj.prop, 0);
      const stepsPerRev = Math.max(1, numericViewSpecProperty(properties, proj.stepsPerRevProp ?? "", proj.stepsPerRev));
      const angle = (((pos % stepsPerRev) + stepsPerRev) % stepsPerRev) / stepsPerRev * 360;
      if (angle !== 0) transforms.push(`rotate(${angle.toFixed(2)},${proj.cx},${proj.cy})`);
    } else if (proj.kind === "fill") {
      const rawValue = properties[proj.prop];
      const key = rawValue === undefined ? "absent" : String(rawValue);
      fill = proj.map[key] ?? proj.map.default ?? fill;
    } else if (proj.kind === "visible") {
      const rawValue = properties[proj.prop];
      const nextVisible = Boolean(rawValue);
      visible = proj.invert ? !nextVisible : nextVisible;
    }
  }
  return {
    ...(transforms.length > 0 ? { transform: transforms.join(" ") } : {}),
    ...(fill ? { fill } : {}),
    ...(visible !== undefined ? { visible } : {}),
  };
}

function viewSpecClassToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function viewSpecHitTestSvg(id: string, region: ViewSpecHitTest, extraClasses: string[]): string {
  const classes = ["viewspec-hit-zone", `viewspec-hit-${viewSpecClassToken(id)}`, ...extraClasses].join(" ");
  const cursor = region.cursor ? ` style="cursor:${escapeXmlText(region.cursor)}"` : "";
  const common = ` class="${classes}" data-viewspec-hit-id="${escapeXmlText(id)}" fill="transparent" stroke="none" pointer-events="all"${cursor}`;
  switch (region.kind) {
    case "rect":
      return `<rect${common} x="${region.x}" y="${region.y}" width="${region.w}" height="${region.h}"/>`;
    case "circle":
      return `<circle${common} cx="${region.cx}" cy="${region.cy}" r="${region.r}"/>`;
    case "ellipse":
      return `<ellipse${common} cx="${region.cx}" cy="${region.cy}" rx="${region.rx}" ry="${region.ry}"/>`;
    case "polygon": {
      const pts = region.points.map((point) => `${point.x},${point.y}`).join(" ");
      return `<polygon${common} points="${pts}"/>`;
    }
    case "path":
      return `<path${common} d="${escapeXmlText(region.d)}"/>`;
  }
  return "";
}

/** Renderiza o corpo SVG de um ViewSpec: gradientes escopados por `componentId` + paint items com
 * stateProjection inicial. `fill: "gradient:name"` resolve para `url(#name-componentId)`.
 * Retorna `undefined` se `pkg.viewSpec` está ausente (caller cai para shapes[]). */
function viewSpecBodySvg(pkg: PackageDescriptor, componentId: string, properties: Record<string, unknown>): string | undefined {
  const spec = pkg.viewSpec;
  if (!spec) return undefined;

  const idSuffix = componentId.replace(/[^a-zA-Z0-9_-]/g, "_");

  // Build gradient defs
  let defs = "";
  const gradientIdMap = new Map<string, string>();
  if (spec.gradients) {
    for (const [name, grad] of Object.entries(spec.gradients)) {
      const scopedId = `${name}-${idSuffix}`;
      gradientIdMap.set(`gradient:${name}`, `url(#${scopedId})`);
      const units = grad.gradientUnits ?? "userSpaceOnUse";
      const stops = grad.stops.map(s => `<stop offset="${s.offset}" stop-color="${s.color}"/>`).join("");
      if (grad.kind === "radial") {
        const fxAttr = grad.fx !== undefined ? ` fx="${grad.fx}"` : "";
        const fyAttr = grad.fy !== undefined ? ` fy="${grad.fy}"` : "";
        defs += `<radialGradient id="${scopedId}" cx="${grad.cx}" cy="${grad.cy}" r="${grad.r}"${fxAttr}${fyAttr} gradientUnits="${units}">${stops}</radialGradient>`;
      } else {
        defs += `<linearGradient id="${scopedId}" x1="${grad.x1}" y1="${grad.y1}" x2="${grad.x2}" y2="${grad.y2}" gradientUnits="${units}">${stops}</linearGradient>`;
      }
    }
  }

  // Render paint items
  let paintMarkup = "";
  for (const shape of spec.paint) {
    const projection = shape.partId ? viewSpecResolvedProjection(shape.partId, spec, properties) : {};
    if (projection.visible === false) continue;
    const projectedShape = projection.fill ? { ...shape, fill: projection.fill } : shape;
    // Resolve gradient references in fill
    const resolvedShape: PackageShape = gradientIdMap.has(projectedShape.fill ?? "")
      ? { ...projectedShape, fill: gradientIdMap.get(projectedShape.fill!)! }
      : projectedShape;
    paintMarkup += packageShapeSvg(resolvedShape, projection.transform);
  }

  let hitTestMarkup = "";
  if (spec.hitTest) {
    const classesByHitTestId = new Map<string, string[]>();
    if (spec.interaction) {
      for (const interaction of Object.values(spec.interaction)) {
        if (!interaction.hitTest) continue;
        const classes = classesByHitTestId.get(interaction.hitTest) ?? [];
        classes.push(`viewspec-interaction-${viewSpecClassToken(interaction.kind)}`);
        classesByHitTestId.set(interaction.hitTest, classes);
      }
    }
    for (const [hitTestId, region] of Object.entries(spec.hitTest)) {
      hitTestMarkup += viewSpecHitTestSvg(hitTestId, region, classesByHitTestId.get(hitTestId) ?? []);
    }
  }

  return (defs ? `<defs>${defs}</defs>` : "") + paintMarkup + hitTestMarkup;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────

/** Lead (corpo -> ponta real) + rótulo, em coordenadas ORIGINAIS do package (sem o deslocamento de
 * `resolvePackageLayout` -- quem chama envolve isto num `<g transform="translate(offsetX,offsetY)">`,
 * ver `packageBodySvg`). O círculo do terminal em si (onde o clique conecta fio) é desenhado por
 * quem chama (`main.ts::renderComponent`), na posição JÁ deslocada devolvida por `pinLocalPosition`. */
function packagePinLeadSvg(pin: PackagePin, resolved: ResolvedPackage, labelColor = "currentColor", properties?: Record<string, unknown>): string {
  const visualEnd = packagePinVisualEnd(pin);
  const electrical = packagePinElectricalPoint(pin);
  const tipNativeX = electrical.x;
  const tipNativeY = electrical.y;
  const label = pin.label ?? pin.id;
  const hasCustomLabelPos = pin.labelX !== undefined && pin.labelY !== undefined;
  const labelSpace = pin.labelSpace ?? 9;
  const rad = (pin.angle * Math.PI) / 180;
  const labelNativeX = pin.labelX ?? tipNativeX + Math.cos(rad) * labelSpace;
  const labelNativeY = pin.labelY ?? tipNativeY + Math.sin(rad) * labelSpace;
  const toDisplayX = (value: number): number => (value + resolved.offsetX) * resolved.scaleX;
  const toDisplayY = (value: number): number => (value + resolved.offsetY) * resolved.scaleY;
  const x = toDisplayX(pin.x);
  const y = toDisplayY(pin.y);
  const leadEndX = toDisplayX(visualEnd.x);
  const leadEndY = toDisplayY(visualEnd.y);
  const labelX = toDisplayX(labelNativeX);
  const labelY = toDisplayY(labelNativeY);
  // Lead vertical (topo/baixo do corpo, angle 90/270) -- texto horizontal colide com o label do
  // pino vizinho quando há muitos pinos apertados num lado só (ex: 12 pinos em 170 unidades no chip
  // ESP32 nu). Giram -90° (lê de baixo pra cima) só nesses dois ângulos -- lead horizontal
  // (esquerda/direita) já tem espaçamento vertical de sobra entre linhas, não precisa girar. Só se
  // aplica na posição PADRÃO (calculada) -- uma vez que o usuário arrastou o rótulo pra um lugar
  // próprio (`labelX`/`labelY`, ver model.ts), a rotação automática pra encaixe apertado não faz
  // mais sentido (ele já escolheu onde e como cabe).
  const isVerticalLead = !hasCustomLabelPos && (pin.angle === 90 || pin.angle === 270);
  const rotateAttr = isVerticalLead ? ` transform="rotate(-90 ${labelX.toFixed(1)} ${labelY.toFixed(1)})"` : "";
  const resolvedLabelColor = pin.labelColor ?? labelColor;
  const fillAttr = resolvedLabelColor === "currentColor" ? ` class="symbol-text"` : ` fill="${resolvedLabelColor}"`;
  const labelFontSize = pin.labelFontSize ?? PACKAGE_PIN_LABEL_FONT_SIZE;
  const textAnchor = pin.labelTextAnchor ?? "middle";
  const baselineAttr = pin.labelDominantBaseline ? ` dominant-baseline="${pin.labelDominantBaseline}"` : "";
  const leadMarkup = pin.length === 0
    ? ""
    : `<line x1="${x.toFixed(1)}" y1="${y.toFixed(1)}" x2="${leadEndX.toFixed(1)}" y2="${leadEndY.toFixed(1)}" stroke="#000" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
  const labelVisible = stateVisibleMatches(pin.labelStateVisible, properties);
  const labelMarkup = labelVisible && label.trim()
    ? `<text x="${labelX.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="${textAnchor}"${baselineAttr}${fillAttr} style="font-size:${labelFontSize}px"${rotateAttr}>${escapeXmlText(label)}</text>`
    : "";
  return (
    leadMarkup +
    labelMarkup
  );
}

function packageBackgroundSvg(pkg: PackageDescriptor): string {
  if (pkg.background?.kind === "color" && pkg.background.value) {
    return `<rect x="0" y="0" width="${pkg.width}" height="${pkg.height}" fill="${pkg.background.value}"/>`;
  }
  if (pkg.background?.kind === "image" && pkg.background.data) {
    // `data` e o PNG/JPEG/SVG em base64 puro (sem prefixo `data:`) -- mesma convencao de
    // `BckGndData` do SimulIDE real quando a imagem da placa vem embutida no proprio arquivo.
    return `<image x="0" y="0" width="${pkg.width}" height="${pkg.height}" preserveAspectRatio="none" href="data:${pkg.background.mime ?? "image/png"};base64,${pkg.background.data}"/>`;
  }
  return "";
}

/** Corpo completo de um typeId com `package`: fundo + formas declarativas + lead/rótulo de cada
 * pino, tudo num único `<g>` deslocado pro espaço sem coordenada negativa que `componentBox` usa
 * pro `viewBox` (ver `resolvePackageLayout`).
 * Quando `pkg.viewSpec` está presente e `componentId` é fornecido, usa o ViewSpec renderer (gradientes
 * escopados + stateProjection inicial). Caso contrário cai para `shapes[]` legado. */
function packageBodySvg(resolved: ResolvedPackage, componentId?: string, properties?: Record<string, unknown>): string {
  const pkg = resolved.source;
  let markup = packageBackgroundSvg(pkg);

  if (pkg.simulidePaint) {
    const scopeId = `simulide-${componentId ? componentId.replace(/[^a-zA-Z0-9_-]/g, "_") : "static"}`;
    for (const shape of simulidePaintToPackageShapes(pkg.simulidePaint, pkg.width, pkg.height, properties ?? {}, scopeId)) markup += packageShapeSvg(shape);
  } else if (pkg.viewSpec && componentId) {
    markup += viewSpecBodySvg(pkg, componentId, properties ?? {}) ?? "";
  } else {
    for (const shape of pkg.shapes ?? []) markup += packageShapeSvg(shape);
  }
  if (pkg.border) {
    markup += `<rect x="0.5" y="0.5" width="${Math.max(0, pkg.width - 1)}" height="${Math.max(0, pkg.height - 1)}" class="symbol-stroke" fill="none"/>`;
  }

  const bodyMarkup =
    `<g transform="translate(${(resolved.offsetX * resolved.scaleX).toFixed(3)},${(resolved.offsetY * resolved.scaleY).toFixed(3)})">` +
    `<g transform="scale(${resolved.scaleX.toFixed(6)},${resolved.scaleY.toFixed(6)})">${markup}</g>` +
    `</g>`;
  const pinLabelColor = pkg.pinLabelColor ?? "currentColor";
  const pinsMarkup = pkg.pins
    .filter((pin) => stateVisibleMatches(pin.stateVisible, properties))
    .map((pin) => packagePinLeadSvg(pin, resolved, pinLabelColor, properties))
    .join("");
  return bodyMarkup + pinsMarkup;
}

const DEFAULT_BOX: ComponentBox = { width: 70, height: 40 };

function ioComponentBox(widthCells: number, rows: number, hasLabel = true): ComponentBox {
  // SimulIDE: src/components/iocomponent.cpp::setNumPins().
  const heightRows = hasLabel ? rows + 1 : rows;
  return { width: widthCells * 8 + 16, height: heightRows * 8 };
}

function logicComponentBox(widthCells: number, heightRows: number): ComponentBox {
  // SimulIDE: several LogicComponent subclasses set m_area directly from m_width/m_height.
  return { width: widthCells * 8 + 16, height: heightRows * 8 };
}

function builtinComponentBox(typeId: string): ComponentBox | undefined {
  switch (typeId) {
    case "connectors.junction": return { width: 0, height: 0 };
    case "connectors.bus": return { width: 24, height: 64 }; // logic/bus.cpp: tronco vertical
    case "connectors.tunnel": return { width: 44, height: 16 };
    case "connectors.socket": return { width: 24, height: 64 }; // connectors/socket.cpp + connbase.cpp
    case "connectors.header": return { width: 24, height: 64 }; // connectors/header.cpp + connbase.cpp

    case "graphics.image": return { width: 80, height: 80 };
    case "graphics.text": return { width: 74, height: 28 };
    case "graphics.rectangle": return { width: 96, height: 58 };
    case "graphics.ellipse": return { width: 96, height: 58 };
    case "graphics.line": return { width: 86, height: 32 };
    case "other.package": return { width: 84, height: 66 };
    case "other.package_pin": return { width: 24, height: 24 };
    case "other.test_unit": return { width: 32, height: 32 }; // other/testunit.cpp (IoComponent generico)
    case "other.dial": return { width: 40, height: 40 }; // other/dial.cpp: knob nativo (QDial) -- estilizacao vetorial menor que antes
    case "other.ground": return { width: 16, height: 18 }; // sources/ground.cpp

    case "passive.resistor": return COMP2PIN_BOX; // comp2pin.cpp
    case "passive.variable_resistor": return { width: 40, height: 24 };
    case "passive.resistor_dip": return { width: 24, height: 68 }; // passive/resistordip.cpp
    case "passive.potentiometer": return { width: 40, height: 32 };
    case "passive.ldr": return { width: 40, height: 24 };
    case "passive.thermistor": return { width: 40, height: 24 };
    case "passive.rtd": return { width: 40, height: 24 };
    case "passive.force_strain_gauge": return { width: 40, height: 24 };
    case "passive.capacitor": return COMP2PIN_BOX;
    case "passive.electrolytic_capacitor": return { width: 36, height: 20 };
    case "passive.variable_capacitor": return { width: 40, height: 24 };
    case "passive.inductor": return COMP2PIN_BOX;
    case "passive.variable_inductor": return { width: 40, height: 24 };
    case "passive.transformer": return { width: 56, height: 64 };

    case "logic.button": return COMP2PIN_BOX;
    case "logic.buffer": return ioComponentBox(2, 1, false);
    case "logic.and_gate": return ioComponentBox(2, 2, false);
    case "logic.or_gate": return ioComponentBox(2, 2, false);
    case "logic.xor_gate": return ioComponentBox(2, 2, false);
    case "logic.counter": return logicComponentBox(3, 3); // logic/counter.cpp
    case "logic.bin_counter": return logicComponentBox(4, 6); // logic/bincounter.cpp
    case "logic.full_adder": return { width: 40, height: 32 }; // logic/fulladder.cpp
    case "logic.magnitude_comp": return logicComponentBox(4, 4); // logic/magnitudecomp.cpp
    case "logic.shift_reg": return logicComponentBox(4, 9); // logic/shiftreg.cpp
    case "logic.function": return ioComponentBox(3, 4);
    case "logic.flipflop_d": return logicComponentBox(3, 3); // logic/flipflopd.cpp
    case "logic.flipflop_t": return logicComponentBox(3, 3); // logic/flipflopt.cpp
    case "logic.flipflop_rs": return logicComponentBox(3, 4); // logic/flipfloprs.cpp
    case "logic.flipflop_jk": return logicComponentBox(3, 4); // logic/flipflopjk.cpp
    case "logic.latch_d": return logicComponentBox(4, 10); // logic/latchd.cpp
    case "logic.memory": return logicComponentBox(4, 11); // logic/memory.cpp
    case "logic.dynamic_memory": return logicComponentBox(4, 11); // logic/dynamic_memory.cpp
    case "logic.i2c_ram": return logicComponentBox(4, 4); // logic/i2cram.cpp
    case "logic.mux": return { width: 50, height: 114 }; // logic/mux.cpp, default channels + enables.
    case "logic.demux": return { width: 50, height: 114 };
    case "logic.bcd_to_dec": return logicComponentBox(4, 11); // logic/bcdtodec.cpp
    case "logic.dec_to_bcd": return logicComponentBox(4, 10); // logic/dectobcd.cpp
    case "logic.bcd_to_7seg": return logicComponentBox(4, 8); // logic/bcdto7s.cpp
    case "logic.i2c_to_parallel": return logicComponentBox(4, 8); // logic/i2ctoparallel.cpp
    case "logic.adc": return logicComponentBox(4, 9); // logic/adc.cpp
    case "logic.dac": return logicComponentBox(4, 9); // logic/dac.cpp
    case "logic.seven_segment_bcd": return logicComponentBox(4, 6); // logic/sevensegment_bcd.cpp
    case "logic.lm555": return { width: 48, height: 40 }; // logic/lm555.cpp

    case "switches.push": return SWITCH_BOX; // switches/push.cpp
    case "switches.switch": return SWITCH_BOX; // switches/switch.cpp + mech_contact.cpp
    case "switches.switch_dip": return { width: 24, height: 64 }; // switches/switchdip.cpp
    case "switches.relay": return { width: 32, height: 44 }; // switches/relay.cpp (bobina + contato)
    // "switches.keypad" agora é property-driven (ver `propertyDrivenBox`) -- cresce com rows/columns
    // reais, nunca um tamanho fixo.

    case "active.diode": return COMP2PIN_BOX;
    case "active.zener": return { width: 36, height: 20 };
    case "active.diac": return { width: 36, height: 32 }; // active/diac.cpp
    case "active.scr": return { width: 32, height: 24 };
    case "active.triac": return { width: 32, height: 32 };
    case "active.bjt": return TRANSISTOR_BOX;
    case "active.mosfet": return TRANSISTOR_BOX;
    case "active.jfet": return TRANSISTOR_BOX;
    case "active.opamp": return TRIANGLE_AMP_BOX;
    case "active.comparator": return TRIANGLE_AMP_BOX;
    case "active.analog_mux": return { width: 32, height: 72 }; // active/mux_analog.cpp (8 canais default)
    case "active.volt_regulator": return { width: 24, height: 20 }; // active/volt_reg.cpp

    case "outputs.led": return { width: 40, height: 24 };
    case "outputs.led_rgb": return { width: 24, height: 24 }; // outputs/leds/ledrgb.cpp
    case "outputs.led_bar": return { width: 20, height: 64 }; // outputs/leds/ledbar.cpp
    case "outputs.led_matrix": return { width: 72, height: 72 };
    case "outputs.max72xx_matrix": return { width: 264, height: 88 }; // outputs/leds/max72xx_matrix.cpp
    case "outputs.ws2812": return { width: 24, height: 24 };
    case "outputs.seven_segment": return { width: 40, height: 56 }; // outputs/leds/sevensegment.cpp
    case "outputs.hd44780": return { width: 210, height: 75 }; // outputs/displays/hd44780_base.cpp + pins.
    case "outputs.aip31068_i2c": return { width: 210, height: 75 };
    case "outputs.pcd8544": return { width: 104, height: 84 };
    case "outputs.ks0108": return { width: 148, height: 100 };
    case "outputs.ssd1306": return { width: 140, height: 88 };
    case "outputs.sh1107": return { width: 88, height: 144 };
    case "outputs.st7735": return { width: 144, height: 184 };
    case "outputs.st7789": return { width: 252, height: 342 };
    case "outputs.ili9341": return { width: 252, height: 342 };
    case "outputs.gc9a01a": return { width: 252, height: 252 };
    case "outputs.pcf8833": return { width: 144, height: 152 };
    case "outputs.dc_motor": return { width: 80, height: 66 };
    case "outputs.stepper": return { width: 114, height: 100 };
    case "outputs.servo": return { width: 96, height: 80 };
    case "outputs.audio_out": return { width: 32, height: 40 };
    case "outputs.incandescent_lamp": return { width: 32, height: 32 };

    case "instruments.voltmeter": return SMALL_METER_BOX;
    case "meters.probe": return { width: 30, height: 16 };
    case "meters.ampmeter": return SMALL_METER_BOX;
    case "meters.freqmeter": return { width: 93, height: 20 };
    case "meters.oscope": return { width: 260, height: 180 };
    case "meters.logic_analyzer": return { width: 260, height: 212 };

    case "sources.dc_voltage": return { width: 64, height: 48 };
    case "sources.fixed_volt": return { width: 48, height: 16 }; // botao proxy 16x16 + corpo 16x16 + pino
    case "sources.clock": return { width: 48, height: 16 }; // botao proxy herdado + m_area 22x16 + pino
    case "sources.wave_gen": return { width: 48, height: 16 }; // idem Clock, 2 pinos (out/gnd)
    case "sources.voltage_source": return { width: 48, height: 56 }; // sources/voltsource.cpp+varsource.cpp: WIDTH=40,HEIGHT=56 + pino em (28,16)
    case "sources.current_source": return { width: 48, height: 56 }; // sources/currsource.cpp+varsource.cpp
    case "sources.controlled_source": return { width: 40, height: 40 }; // sources/csource.cpp: m_area 32x32 + pinos de controle em x=-24
    case "sources.battery": return { width: 32, height: 20 }; // sources/battery.cpp (Comp2Pin): m_area 20x20, pinos herdados em x=±16
    case "sources.rail": return { width: 16, height: 20 }; // sources/rail.cpp: setRotation(90) no construtor -- funil aponta pra baixo

    default: return undefined;
  }
}

/** Caixa property-driven dos typeIds "de autoria de símbolo" (Épico G) -- `other.package`/
 * `graphics.rectangle`/`ellipse` usam `width`/`height` direto (mesmo significado de
 * `PackageDescriptor.width/height`/`PackageShape.w/h`, ver seção 21.2 do
 * `.spec/lasecsimul-native-devices.spec`). `graphics.line`/`other.package_pin` usam uma caixa
 * QUADRADA centrada no `length` -- o ponto fixo que não se move quando `component.rotation` gira
 * (CSS `rotate()` pivota no CENTRO do elemento, ver `renderComponent`) é o CENTRO da caixa, por isso
 * o desenho "canônico" (rotation=0) tem que colocar a âncora/ponto médio exatamente lá -- ver
 * `componentSymbolSvg` e `extension.ts::compileSymbolAuthoringComponents` (fórmula inversa). */
function propertyDrivenBox(typeId: string, properties: Record<string, unknown> | undefined): ComponentBox | undefined {
  if (!properties) return undefined;
  const numberOf = (key: string): number | undefined => (typeof properties[key] === "number" ? (properties[key] as number) : undefined);
  const tunnelName = typeof properties.name === "string" ? properties.name.trim() : "";
  switch (typeId) {
    case "connectors.tunnel": {
      const estimatedTextWidth = tunnelName ? tunnelName.length * 7.4 + 12 : 20;
      return { width: Math.max(44, Math.ceil(estimatedTextWidth + 24)), height: 16 };
    }
    case "graphics.rectangle":
    case "graphics.ellipse":
    case "other.package": {
      const width = numberOf("width");
      const height = numberOf("height");
      if (width === undefined || height === undefined) return undefined;
      const unit = properties.__ui_packageUnit === "simulide-grid" ? SIMULIDE_PACKAGE_GRID_UNIT : 1;
      return { width: Math.max(8, width * unit), height: Math.max(8, height * unit) };
    }
    case "graphics.line": {
      const length = numberOf("length") ?? 40;
      const side = Math.max(20, length + 12);
      return { width: side, height: side };
    }
    case "other.package_pin": {
      const length = numberOf("length") ?? 8;
      const side = Math.max(24, length * 2 + 16);
      return { width: side, height: side };
    }
    case "graphics.text": {
      const text = typeof properties.text === "string" ? properties.text : "Texto";
      const fontSize = numberOf("fontSize") ?? 11;
      return { width: Math.max(24, text.length * fontSize * 0.62 + 12), height: fontSize + 14 };
    }
    case "switches.keypad": {
      // Mesma fórmula de `switches/keypad.cpp::updateBoardLayout()` real: `m_area = QRectF(-12,-4,
      // 16*cols+8, 16*rows+8)` -- cresce/encolhe com `rows`/`columns` reais da instância, nunca um
      // tamanho fixo (bug relatado 2026-06-30: grade sempre desenhada 4×4 vazia, ignorando a
      // configuração real do componente).
      const cols = numberOf("columns") ?? 3;
      const rows = numberOf("rows") ?? 4;
      return { width: 16 * cols + 8, height: 16 * rows + 8 };
    }
    default:
      return undefined;
  }
}

/** Caixa (tamanho irregular, por tipo) usada pro `viewBox` do SVG e pro layout dos pinos. Quando o
 * typeId tem `package` (ver `registerPackage`), a caixa vem do layout resolvido (já com folga pra
 * leads que saem fora de `0..width`/`0..height`), nunca da tabela estática abaixo. `properties` (a
 * instância, não o typeId) tem prioridade sobre `package`/tabela estática quando presente -- só os
 * típicos "de autoria de símbolo" (`propertyDrivenBox`) realmente usam isso hoje. */
export function componentBox(typeId: string, properties?: Record<string, unknown>): ComponentBox {
  const resolved = resolvedPackageFor(typeId, properties);
  if (resolved) return { width: resolved.width, height: resolved.height };
  const propertyBox = propertyDrivenBox(typeId, properties);
  if (propertyBox) return propertyBox;
  return builtinComponentBox(typeId) ?? DEFAULT_BOX;
}

/** Posição local (dentro da caixa do componente) do pino `pinId` (índice `pinIndex` de `pinCount`
 * pinos no array real que o Core devolveu, usado só pra fallback). Quando o typeId tem `package`, a
 * posição vem do layout resolvido, casando por `id` -- nunca por posição no array, porque a ordem
 * real de `component.pins[]` (Core) não é garantida bater com a ordem de `package.pins[]`
 * declarada. Sem `package` (built-ins de sempre), cai no algoritmo genérico de sempre: 2 pinos um de
 * cada lado (esquerda/direita), no meio da altura -- igual ao layout Comp2Pin do SimulIDE; 1 pino
 * (terra/túnel) no TOPO, centralizado. */
/** Falso só quando o typeId TEM `package` real e este pino específico NÃO está nele -- ex: o chip
 * ESP32 nu expõe 42 pinos elétricos (`pinMap`, casa com o que o plugin/Core esperam
 * posicionalmente), mas só 34 deles têm um lead físico desenhado no encapsulamento real (os outros
 * 8 -- GPIO20/24/28-31 não pinados pra fora + UART0_RX/TX, alias elétrico do GPIO3/GPIO1 -- não
 * existem como ponto de solda separado). Sem isto, esses 8 cairiam no algoritmo genérico (posição
 * por índice global entre os 42), aparecendo como bolinhas soltas/embaralhadas por cima do desenho
 * real dos outros 34 -- pior que não desenhar nada. Pra typeId SEM `package` (built-ins de sempre),
 * sempre `true` -- o algoritmo genérico já é a posição "real" deles, nunca um substituto malfeito. */
export function hasRealPinPosition(typeId: string, pinId: string, properties?: Record<string, unknown>): boolean {
  const resolved = resolvedPackageFor(typeId, properties);
  if (!resolved) return true;
  return resolved.pins.some((candidate) => packagePinMatches(candidate, pinId) && stateVisibleMatches(candidate.stateVisible, properties));
}

export function pinLocalPosition(pinId: string, pinIndex: number, pinCount: number, typeId: string, properties?: Record<string, unknown>): { x: number; y: number } {
  const resolved = resolvedPackageFor(typeId, properties);
  if (resolved) {
    const pin = resolved.pins.find((candidate) => packagePinMatches(candidate, pinId) && stateVisibleMatches(candidate.stateVisible, properties));
    if (pin) return { x: pin.tipX, y: pin.tipY };
  }
  if (typeId === "connectors.junction") return { x: 0, y: 0 };
  const box = componentBox(typeId, properties);
  // SimulIDE sources/ground.cpp:
  //   m_area = QRect(-8,-10,16,12)
  //   IoPin(90, QPoint(0,-16), ...)
  // In this positive viewBox the offset is (+8,+16), so the real electrical
  // connection is the top of the vertical lead, not the middle of the symbol.
  if (typeId === "other.ground" && pinCount <= 1) {
    return { x: box.width / 2, y: 0 };
  }
  if (typeId === "connectors.tunnel" && pinCount <= 1) {
    return { x: box.width - 8, y: box.height / 2 };
  }
  // logic/bus.cpp real só tem 1 pino elétrico (o Core modela como Junction, ver
  // CoreApplication.cpp) -- os 8 traços de bit no desenho são só decoração do tronco. O ponto de
  // ligação clicável fica no CENTRO do tronco vertical (não no topo, fallback genérico antigo
  // deixava a bolinha longe do meio do traço grosso).
  if (typeId === "connectors.bus" && pinCount <= 1) {
    return { x: box.width / 2, y: box.height / 2 };
  }
  // connectors/socket.cpp e header.cpp: coluna ÚNICA vertical de N pinos (ver `componentSymbolSvg`,
  // mesma fórmula de posição Y dos círculos/marcas desenhados) -- o fallback genérico de 2 colunas
  // (usado por engano antes) deixava as bolinhas de ligação flutuando fora da tira desenhada.
  if ((typeId === "connectors.socket" || typeId === "connectors.header") && pinCount > 0) {
    return { x: box.width / 2, y: (box.height / (pinCount + 1)) * (pinIndex + 1) };
  }
  // switches/relay.cpp: 4 pinos reais -- 2 na bobina (extremos do traço grosso embaixo) + 2 no
  // contato/alavanca (extremos da tira em cima), ver `componentSymbolSvg` pro desenho exato. O
  // fallback genérico (2 colunas em Y intermediário) não batia com nenhum dos dois traços.
  if (typeId === "switches.relay" && pinCount >= 4) {
    const coilY = box.height - 10;
    const leverY = 8;
    if (pinIndex === 0) return { x: 4, y: coilY };
    if (pinIndex === 1) return { x: box.width - 4, y: coilY };
    if (pinIndex === 2) return { x: 4, y: leverY };
    return { x: box.width - 4, y: leverY };
  }
  // outputs/stepper.cpp: os 4 pinos reais ficam TODOS na tira conectora à esquerda (ver o
  // `<rect>` estreito em `componentSymbolSvg`) -- o motor circular à direita não tem pino nenhum.
  // Fallback genérico jogava 2 dos 4 pinos pro lado direito, flutuando sobre o corpo do motor.
  if (typeId === "outputs.stepper" && pinCount > 0) {
    const r = Math.min(box.width, box.height) / 2 - 4;
    const stripTop = box.height / 2 - r * 0.7;
    const stripHeight = r * 1.4;
    return { x: 0, y: stripTop + (stripHeight / pinCount) * (pinIndex + 0.5) };
  }
  switch (typeId) {
    // SimulIDE Comp2Pin: src/components/comp2pin.cpp
    case "passive.resistor":
    case "passive.capacitor":
    case "passive.inductor":
    case "passive.variable_resistor":
    case "passive.ldr":
    case "passive.thermistor":
    case "passive.rtd":
    case "passive.force_strain_gauge":
    case "passive.electrolytic_capacitor":
    case "passive.variable_capacitor":
    case "passive.variable_inductor":
    case "sources.battery":
    case "active.diode":
    case "active.zener":
    case "outputs.led":
    case "outputs.incandescent_lamp":
      // led.cpp/lamp.cpp: pinos reais em x=±16 (caixa compacta, ver `horizontalLeads` -- caía nesta
      // mesma convenção 0/width antes, mas sem case aqui o fallback genérico usava PIN_INSET(6) em
      // vez de 0, deixando a bolinha de ligação 6px longe da ponta do traço desenhado).
      if (pinCount <= 2) return { x: pinIndex === 0 ? 0 : box.width, y: box.height / 2 };
      break;
    case "active.diac":
      if (pinCount <= 2) return { x: pinIndex === 0 ? 0 : box.width, y: 16 };
      break;
    case "active.scr":
      if (pinIndex === 0) return { x: 0, y: 8 };
      if (pinIndex === 1) return { x: 32, y: 8 };
      if (pinIndex === 2) return { x: 32, y: 16 };
      break;
    case "active.triac":
      if (pinIndex === 0) return { x: 0, y: 16 };
      if (pinIndex === 1) return { x: 32, y: 16 };
      if (pinIndex === 2) return { x: 32, y: 28 };
      break;
    case "active.bjt":
    case "active.mosfet":
    case "active.jfet":
      if (pinIndex === 0) return { x: 24, y: 0 };
      if (pinIndex === 1) return { x: 24, y: 32 };
      if (pinIndex === 2) return { x: 0, y: 16 };
      break;
    case "active.opamp":
    case "active.comparator":
      if (pinIndex === 0) return { x: 0, y: 8 };
      if (pinIndex === 1) return { x: 0, y: 24 };
      if (pinIndex === 2) return { x: 48, y: 16 };
      if (pinIndex === 3) return { x: 24, y: 0 };
      if (pinIndex === 4) return { x: 24, y: 32 };
      break;
    case "active.volt_regulator":
      if (pinIndex === 0) return { x: 0, y: 8 };
      if (pinIndex === 1) return { x: 24, y: 8 };
      if (pinIndex === 2) return { x: 12, y: 20 };
      break;
    case "sources.voltage_source":
    case "sources.current_source":
      // voltsource.cpp/currsource.cpp: pino real em (28,16) local dentro de m_area(-20,-28,40,56)
      // -- deslocado (+20,+28) fica (48,44), na borda direita perto da caixa de valor, NÃO no meio
      // vertical da caixa toda (46% da altura, não 50%).
      if (pinCount <= 1) return { x: box.width, y: 44 };
      break;
    case "sources.controlled_source":
      // csource.cpp: 4 pinos reais -- 2 de controle (+/-) à ESQUERDA da moldura quadrada (que já
      // começa 8px depois da borda da caixa, ver componentSymbolSvg) + 2 de fonte (topo/baixo) no
      // meio do diamante. Caixa antiga (36x36) não tinha espaço pros pinos de controle, que no real
      // saem 8px além da moldura.
      if (pinIndex === 0) return { x: 0, y: 12 };
      if (pinIndex === 1) return { x: 0, y: 28 };
      if (pinIndex === 2) return { x: 24, y: 0 };
      if (pinIndex === 3) return { x: 24, y: 40 };
      break;
    case "sources.clock":
      if (pinCount <= 1) return { x: box.width, y: box.height / 2 };
      break;
    case "sources.wave_gen":
      // wavegen.cpp: 2 pinos reais, AMBOS do lado direito (out em cima, gnd embaixo) -- não um de
      // cada lado (fallback genérico jogava o 2º pino pra esquerda, sem nenhum traço desenhado lá).
      if (pinIndex === 0) return { x: box.width, y: 4 };
      return { x: box.width, y: 12 };
    // potentiometer.cpp: pins[0]/[1] são as pontas A/B (Core stampa conductance entre elas e o
    // wiper, ver SimulidePotentiometer::stamp) -- esquerda/direita, na mesma convenção compacta
    // 0/width usada pelo `horizontalLeads` (ver componentSymbolSvg). pins[2] é o wiper embaixo, no
    // mesmo x do traço vertical desenhado (`midX`). Sem este case, o fallback genérico (2 colunas
    // em Y intermediário) não batia com NENHUM dos 3 traços reais.
    case "passive.potentiometer":
      if (pinIndex === 0) return { x: 0, y: box.height / 2 };
      if (pinIndex === 1) return { x: box.width, y: box.height / 2 };
      return { x: box.width / 2, y: box.height - PIN_INSET };
  }
  if ((typeId === "switches.push" || typeId === "switches.switch") && pinCount <= 2) {
    return { x: pinIndex % 2 === 0 ? 0 : box.width, y: 8 };
  }
  if (typeId === "sources.fixed_volt" && pinCount <= 1) {
    return { x: box.width, y: box.height / 2 };
  }
  if (typeId === "sources.rail" && pinCount <= 1) {
    // rail.cpp: pino sai da ponta ESTREITA do funil, embaixo (ver componentSymbolSvg) -- não do
    // lado direito (bug: era desenhado como bandeirola horizontal, sem base real no `setRotation(90)`
    // do construtor real).
    return { x: box.width / 2, y: box.height };
  }
  if (typeId === "meters.probe" && pinCount <= 1) {
    return { x: 0, y: box.height / 2 };
  }
  if ((typeId === "meters.ampmeter" || typeId === "instruments.voltmeter") && pinCount >= 3) {
    if (pinIndex === 0) return { x: 16, y: box.height };
    if (pinIndex === 1) return { x: 32, y: box.height };
    return { x: box.width, y: 16 };
  }
  if (typeId === "meters.freqmeter" && pinCount <= 1) {
    return { x: 0, y: box.height / 2 };
  }
  if (typeId === "meters.oscope") {
    return { x: PIN_INSET, y: 28 + pinIndex * 28 };
  }
  if (typeId === "meters.logic_analyzer") {
    return { x: PIN_INSET, y: 20 + pinIndex * 20 };
  }
  if (pinCount <= 1) return { x: box.width / 2, y: PIN_INSET };

  const side = pinIndex % 2 === 0 ? PIN_INSET : box.width - PIN_INSET;
  const rowsOnSide = Math.ceil(pinCount / 2);
  const row = Math.floor(pinIndex / 2);
  const y = (box.height / (rowsOnSide + 1)) * (row + 1);
  return { x: side, y };
}

function zigzagPath(x1: number, x2: number, yMid: number, amplitude: number, peaks: number): string {
  const step = (x2 - x1) / (peaks * 2);
  const points = [`M ${x1} ${yMid}`];
  for (let i = 1; i <= peaks * 2; i++) {
    const x = x1 + step * i;
    const y = i % 2 === 1 ? yMid - amplitude : yMid + amplitude;
    points.push(`L ${x.toFixed(1)} ${y.toFixed(1)}`);
  }
  points.push(`L ${x2} ${yMid}`);
  return points.join(" ");
}

/** Leads genéricos (pino -> início do corpo) para componentes de 2 pinos em layout horizontal —
 * cada símbolo desenha só o corpo entre `LEAD_MARGIN` e `largura - LEAD_MARGIN`; o pino em si
 * (círculo) é desenhado por quem chama (renderComponent), não aqui. */
function horizontalLeads(box: ComponentBox, yMid: number): string {
  const pinLeft = box.width <= 40 ? 0 : PIN_INSET;
  const pinRight = box.width <= 40 ? box.width : box.width - PIN_INSET;
  const bodyLeft = box.width <= 40 ? 5 : LEAD_MARGIN;
  const bodyRight = box.width <= 40 ? box.width - 5 : box.width - LEAD_MARGIN;
  return (
    `<line x1="${pinLeft}" y1="${yMid}" x2="${bodyLeft}" y2="${yMid}" class="symbol-stroke"/>` +
    `<line x1="${bodyRight}" y1="${yMid}" x2="${pinRight}" y2="${yMid}" class="symbol-stroke"/>`
  );
}

/** Estilização vetorial de um `QDial` NATIVO do Qt (widget do SO, ver `gui/customdial.cpp` --
 * `CustomDial::paintEvent` real, não aproximação livre) -- usado por `other.dial` e
 * `sources.voltage_source`/`current_source` pra ficarem visualmente consistentes entre si (mesmo
 * widget real por trás dos três). Geometria fiel ao paintEvent: arco de 300° começando em 240°,
 * marcas cinza (110,110,110) a cada passo + a PRIMEIRA marca (240°, início da faixa) sempre
 * VERMELHA -- essa marca vermelha é uma referência FIXA de zero, não o indicador de valor real (o
 * indicador de valor é um "nub" circular separado, que se move ao longo do mesmo arco conforme
 * value/maximum). Gradiente radial quase branco (só (200,200,195) na borda, não um cinza forte). */
function qDialKnobSvg(cx: number, cy: number, r: number): string {
  const gradientId = `dial-grad-${Math.round(cx)}-${Math.round(cy)}-${Math.round(r)}`;
  const tickCount = 20;
  let ticks = "";
  for (let i = 0; i <= tickCount; i++) {
    const angleDeg = 240 + (300 / tickCount) * i;
    const rad = (angleDeg * Math.PI) / 180;
    const inner = r - 4;
    const isZeroRef = i === 0;
    ticks +=
      `<line x1="${(cx + Math.cos(rad) * inner).toFixed(1)}" y1="${(cy + Math.sin(rad) * inner).toFixed(1)}" ` +
      `x2="${(cx + Math.cos(rad) * r).toFixed(1)}" y2="${(cy + Math.sin(rad) * r).toFixed(1)}" ` +
      `stroke="${isZeroRef ? "#e02020" : "#6e6e6e"}" stroke-width="${isZeroRef ? 2 : 1}"/>`;
  }
  // Nub de valor decorativo no meio do curso (50%) -- widget interativo real, sem estado de
  // "posição atual" reproduzido aqui, ver docstring da função.
  const valueRad = ((240 + 300 * 0.5) * Math.PI) / 180;
  const knobR = r / 6;
  const nubX = cx + Math.cos(valueRad) * (r - knobR * 2.5);
  const nubY = cy + Math.sin(valueRad) * (r - knobR * 2.5);
  return (
    `<defs><radialGradient id="${gradientId}" cx="50%" cy="50%" r="50%">` +
    `<stop offset="0%" stop-color="#ffffff"/><stop offset="80%" stop-color="#e6e6e1"/><stop offset="100%" stop-color="#c8c8c3"/></radialGradient></defs>` +
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#${gradientId})" stroke="#464646" stroke-width="1"/>` +
    ticks +
    `<circle cx="${nubX.toFixed(1)}" cy="${nubY.toFixed(1)}" r="${knobR.toFixed(1)}" fill="#d2d2c8" stroke="#464646" stroke-width="1"/>`
  );
}

function smallMeterDisplaySvg(box: ComponentBox, unit: "A" | "V", readout: number | undefined): string {
  const valueText = formatLcdNumber(readout);
  const valueFontSize = lcdValueFontSize(valueText);
  return (
    `<rect x="0" y="0" width="48" height="32" rx="1" class="meter-lcd"/>` +
    `<text x="44" y="13" text-anchor="end" class="meter-lcd-value" style="font-size:${valueFontSize}px">${valueText}</text>` +
    `<text x="8" y="27" class="meter-lcd-unit">${unit}</text>` +
    `<rect x="48" y="13" width="8" height="6" rx="3" fill="currentColor"/>` +
    `<rect x="13.5" y="32" width="5" height="8" rx="2.5" fill="currentColor"/>` +
    `<rect x="29.5" y="32" width="5" height="8" rx="2.5" fill="currentColor"/>`
  );
}

function plotGridSvg(x: number, y: number, width: number, height: number): string {
  return Array.from({ length: 9 }, (_, index) => {
    const gx = x + 12 + index * ((width - 24) / 8);
    return `<line x1="${gx.toFixed(1)}" y1="${y + 8}" x2="${gx.toFixed(1)}" y2="${y + height - 8}" class="meter-plot-grid"/>`;
  }).join("");
}

function scopePanelSvg(properties?: Record<string, unknown>): string {
  const histories = symbolHistoryMatrix(properties);
  const latest = symbolReadoutArray(properties);
  const colors = ["#f6f65a", "#d9d7ff", "#ffd06a", "#00e89a"];
  const plotX = 104;
  const plotY = 8;
  const plotW = 146;
  const plotH = 154;
  // Selo (cor) e valor na MESMA linha (não rótulo empilhado acima do selo) -- cabia "tecnicamente"
  // empilhado, mas em 4 canais ficava espremido contra o botão "Expande" embaixo (overlap real de
  // ~6px entre o último selo e o botão, reportado como "texto fora do lugar"). Mais respiro vertical
  // (height 150->180) some com a colisão de propósito, não só corta o sintoma.
  const rows = colors.map((color, index) => {
    const y = 16 + index * 30;
    const label = `${formatRailVoltage(latest[index] ?? 0)} V`;
    return (
      `<rect x="18" y="${y}" width="50" height="20" rx="2" fill="${color}" stroke="#777"/>` +
      `<text x="74" y="${y + 14}" class="meter-panel-label">${escapeXmlText(label)}</text>`
    );
  }).join("");
  const traces = colors.map((color, index) => {
    const history = histories[index] ?? [];
    return `<path d="${tracePath(history, plotX + 7, plotY + 14, plotW - 14, plotH - 28)}" fill="none" stroke="${color}" stroke-width="2"/>`;
  }).join("");
  return (
    `<rect x="4" y="2" width="252" height="166" rx="6" fill="#f7f7f7" stroke="currentColor" stroke-width="2"/>` +
    rows +
    `<rect x="18" y="140" width="78" height="20" rx="3" class="meter-expand-button"/>` +
    `<text x="31" y="154" class="meter-panel-button">Expande</text>` +
    `<rect x="${plotX}" y="${plotY}" width="${plotW}" height="${plotH}" rx="6" fill="#050505" stroke="currentColor" stroke-width="3"/>` +
    plotGridSvg(plotX, plotY, plotW, plotH) +
    traces
  );
}

function logicAnalyzerPanelSvg(properties?: Record<string, unknown>): string {
  const history = symbolHistoryArray(properties);
  const latest = symbolReadoutNumber(properties) ?? 0;
  const colors = ["#f6f65a", "#d9d7ff", "#ffd06a", "#00e89a", "#f6f65a", "#d9d7ff", "#ffd06a", "#00e89a"];
  const plotX = 104;
  const plotY = 8;
  const plotW = 146;
  const plotH = 174;
  const rows = colors.map((color, index) => {
    const y = 12 + index * 20;
    return `<rect x="18" y="${y}" width="78" height="16" rx="2" fill="${color}" stroke="#777"/>`;
  }).join("");
  const traces = colors.map((color, channel) => {
    const samples = history.length > 1 ? history : [latest, latest];
    const rowY = plotY + 14 + channel * 19;
    const points = samples.map((mask, index) => {
      const x = plotX + 7 + ((plotW - 14) * index) / Math.max(1, samples.length - 1);
      const high = ((mask >>> channel) & 1) === 1;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(1)} ${(rowY + (high ? 0 : 9)).toFixed(1)}`;
    }).join(" ");
    return `<path d="${points}" fill="none" stroke="${color}" stroke-width="2"/>`;
  }).join("");
  return (
    `<rect x="4" y="2" width="252" height="208" rx="6" fill="#f7f7f7" stroke="currentColor" stroke-width="2"/>` +
    rows +
    `<rect x="18" y="184" width="78" height="20" rx="3" class="meter-expand-button"/>` +
    `<text x="31" y="198" class="meter-panel-button">Expande</text>` +
    `<rect x="${plotX}" y="${plotY}" width="${plotW}" height="${plotH}" rx="6" fill="#050505" stroke="currentColor" stroke-width="3"/>` +
    plotGridSvg(plotX, plotY, plotW, plotH) +
    traces
  );
}

/** Corpo do símbolo (SVG inline, em coordenadas locais da caixa do tipo) para um `typeId` conhecido.
 * Tipos sem símbolo dedicado caem num retângulo genérico com leads — nunca undefined/branco.
 * `properties` (opcional) é a instância real -- só os typeIds "de autoria de símbolo" (Épico G) leem
 * isso pra desenhar tamanho/cor reais em vez de um ícone decorativo fixo, ver `propertyDrivenBox`. */
export function componentSymbolSvg(typeId: string, properties?: Record<string, unknown>): string {
  const box = componentBox(typeId, properties);
  const yMid = box.height / 2;
  const compactTwoPin = box.width <= 40 && box.height <= 32;
  const x1 = compactTwoPin ? 5 : LEAD_MARGIN;
  const x2 = compactTwoPin ? box.width - 5 : box.width - LEAD_MARGIN;
  const midX = box.width / 2;

  const labelBox = (label: string): string =>
    `<rect x="${x1}" y="${Math.max(8, yMid - 14)}" width="${Math.max(24, x2 - x1)}" height="28" class="symbol-stroke" fill="none"/>` +
    `<text x="${midX}" y="${yMid + 4}" text-anchor="middle" class="symbol-text">${label}</text>`;

  // active/diode.cpp: triangulo (meia-altura 7) + barra de catodo cabem dentro do corpo 20x16 real
  // sem transbordar -- amplitude fixa de 12/13 (independente de box.height) estourava caixas mais
  // baixas (bug relatado 2026-07-04: triangulo do diodo saia 4px pra fora da propria caixa).
  const diodeTriHalf = Math.max(6, Math.min(12, yMid - 2));
  const diodeBarHalf = diodeTriHalf + 1;
  const diodeBody = (extra = ""): string =>
    horizontalLeads(box, yMid) +
    `<path d="M ${midX - 9} ${(yMid - diodeTriHalf).toFixed(1)} L ${midX - 9} ${(yMid + diodeTriHalf).toFixed(1)} L ${midX + 8} ${yMid} Z" class="symbol-stroke" fill="none"/>` +
    `<line x1="${midX + 10}" y1="${(yMid - diodeBarHalf).toFixed(1)}" x2="${midX + 10}" y2="${(yMid + diodeBarHalf).toFixed(1)}" class="symbol-stroke symbol-stroke--thick"/>` +
    extra;

  switch (typeId) {
    case "passive.resistor":
    case "passive.variable_resistor":
    case "passive.ldr":
    case "passive.thermistor":
    case "passive.rtd": {
      const amplitude = box.height / 2 - 5;
      // Marcas reais por tipo (coordenadas relativas ao centro do corpo, mesmos valores de
      // `ldr.cpp`/`thermistorbase.cpp`/`rtd.cpp`) -- antes cada um só ganhava as 3 primeiras letras
      // do typeId como texto ("LDR"/"THE"/"RTD"), sem nenhuma relação com o desenho real.
      let mark = "";
      if (typeId === "passive.variable_resistor") {
        mark = `<line x1="${midX - 12}" y1="${yMid + 14}" x2="${midX + 12}" y2="${yMid - 14}" class="symbol-stroke symbol-stroke--accent"/>`;
      } else if (typeId === "passive.ldr") {
        mark =
          `<path d="M ${midX - 5} ${yMid - 11} L ${midX - 1} ${yMid - 7} M ${midX - 1} ${yMid - 7} L ${midX - 1} ${yMid - 9} M ${midX - 1} ${yMid - 7} L ${midX - 3} ${yMid - 7}" class="symbol-stroke symbol-stroke--accent" fill="none"/>` +
          `<path d="M ${midX + 5} ${yMid - 11} L ${midX + 1} ${yMid - 7} M ${midX + 1} ${yMid - 7} L ${midX + 1} ${yMid - 9} M ${midX + 1} ${yMid - 7} L ${midX + 3} ${yMid - 7}" class="symbol-stroke symbol-stroke--accent" fill="none"/>`;
      } else if (typeId === "passive.thermistor") {
        mark = `<path d="M ${midX - 8} ${yMid + 6} L ${midX + 6} ${yMid - 8} L ${midX + 10} ${yMid - 8}" class="symbol-stroke symbol-stroke--accent" fill="none"/>`;
      } else if (typeId === "passive.rtd") {
        mark =
          `<line x1="${midX - 6}" y1="${yMid + 6}" x2="${midX + 8}" y2="${yMid - 8}" class="symbol-stroke symbol-stroke--accent"/>` +
          `<text x="${midX - 8}" y="${yMid - 6}" text-anchor="middle" class="symbol-text" style="font-size:7px">+t&#176;</text>`;
      }
      return horizontalLeads(box, yMid) + `<path d="${zigzagPath(x1, x2, yMid, amplitude, 3)}" class="symbol-stroke"/>` + mark;
    }

    case "passive.force_strain_gauge": {
      // strain.cpp: NADA a ver com o corpo zigzag de resistor -- retangulo (corpo do sensor) + 2
      // abas de fixacao (quadrados preenchidos) + grade zigzag de 8 pontos (as trilhas do extensometro).
      const bodyHalfW = 11, bodyHalfH = 12;
      return (
        horizontalLeads(box, yMid) +
        `<rect x="${midX - bodyHalfW}" y="${yMid - bodyHalfH}" width="${bodyHalfW * 2}" height="${bodyHalfH * 2}" class="symbol-stroke" fill="none"/>` +
        `<rect x="${midX - 8}" y="${yMid - 2}" width="4" height="4" fill="currentColor"/>` +
        `<rect x="${midX + 4}" y="${yMid - 2}" width="4" height="4" fill="currentColor"/>` +
        `<path d="M ${midX - 6} ${yMid} L ${midX - 6} ${yMid - 16} L ${midX - 2} ${yMid - 16} L ${midX - 2} ${yMid - 4} L ${midX + 2} ${yMid - 4} L ${midX + 2} ${yMid - 16} L ${midX + 6} ${yMid - 16} L ${midX + 6} ${yMid}" class="symbol-stroke" fill="none"/>`
      );
    }

    case "passive.resistor_dip": {
      // resistordip.cpp: retangulo simples do corpo do CI (sem zigue-zague nenhum dentro -- os
      // resistores individuais nao sao desenhados, só o encapsulamento) + N pares de pino (8 default).
      const bodyHalfW = 9;
      return `<rect x="${midX - bodyHalfW}" y="2" width="${bodyHalfW * 2}" height="${box.height - 4}" rx="1" class="symbol-stroke" fill="none"/>`;
    }

    case "switches.switch_dip": {
      // Antes era um `labelBox("DIP-SW")` genérico (texto+caixa únicos, SEM marca de alavanca
      // nenhuma) -- numa caixa MUITO mais alta que o texto (até 8 posições empilhadas), o texto
      // ficava no meio da pilha de pinos, colidindo visualmente com eles (bug relatado 2026-06-30,
      // "D...SW" sobreposto às bolinhas de pino). Agora desenha N marcas de alavanca empilhadas
      // (uma por posição, `N = box.height/8`, mesma fórmula de `switchdip.cpp::m_area`), igual ao
      // corpo retangular fino real -- sem texto nenhum no meio do corpo.
      const closed = properties?.closed === true;
      const bodyWidth = 16;
      const bodyX = midX - bodyWidth / 2;
      const positions = Math.max(1, Math.round(box.height / 8));
      let leversMarkup = `<rect x="${bodyX}" y="2" width="${bodyWidth}" height="${box.height - 4}" class="symbol-stroke" fill="none"/>`;
      for (let i = 0; i < positions; i++) {
        const cy = 2 + ((i + 0.5) * (box.height - 4)) / positions;
        const leverX2 = closed ? bodyX + bodyWidth - 3 : bodyX + bodyWidth - 7;
        leversMarkup +=
          `<line x1="${bodyX + 3}" y1="${cy}" x2="${leverX2}" y2="${cy - 2}" class="symbol-stroke"/>` +
          `<circle cx="${bodyX + 3}" cy="${cy}" r="1.4" class="symbol-stroke" fill="currentColor"/>`;
      }
      return leversMarkup;
    }

    case "passive.potentiometer":
      return (
        horizontalLeads(box, yMid) +
        `<path d="${zigzagPath(x1, x2, yMid, 8, 3)}" class="symbol-stroke"/>` +
        `<line x1="${midX}" y1="${box.height - PIN_INSET}" x2="${midX}" y2="${yMid + 7}" class="symbol-stroke"/>` +
        `<path d="M ${midX - 7} ${yMid + 9} L ${midX} ${yMid + 2} L ${midX + 7} ${yMid + 9}" class="symbol-stroke" fill="none"/>`
      );

    case "passive.capacitor": {
      // capacitorbase.cpp: placas ocupam quase a altura toda do corpo (12 de 16, ~75%) -- a formula
      // antiga (`box.height/2-6`) dava só 25% (4px), placas curtas demais (bug relatado 2026-07-04).
      const plateHalfLength = yMid - 2;
      return (
        horizontalLeads(box, yMid) +
        `<line x1="${x1}" y1="${yMid}" x2="${midX - 5}" y2="${yMid}" class="symbol-stroke"/>` +
        `<line x1="${midX + 5}" y1="${yMid}" x2="${x2}" y2="${yMid}" class="symbol-stroke"/>` +
        `<line x1="${midX - 5}" y1="${(yMid - plateHalfLength).toFixed(1)}" x2="${midX - 5}" y2="${(yMid + plateHalfLength).toFixed(1)}" class="symbol-stroke symbol-stroke--thick"/>` +
        `<line x1="${midX + 5}" y1="${(yMid - plateHalfLength).toFixed(1)}" x2="${midX + 5}" y2="${(yMid + plateHalfLength).toFixed(1)}" class="symbol-stroke symbol-stroke--thick"/>`
      );
    }

    case "passive.electrolytic_capacitor": {
      // elcapacitor.cpp: placa direita reta + placa esquerda em formato de "balde" (3 segmentos) --
      // a polaridade é transmitida pela geometria da placa, nunca por um texto "+" solto.
      const plateHalfLength = yMid - 2;
      return (
        horizontalLeads(box, yMid) +
        `<line x1="${x1}" y1="${yMid}" x2="${midX - 5}" y2="${yMid}" class="symbol-stroke"/>` +
        `<line x1="${midX + 5}" y1="${yMid}" x2="${x2}" y2="${yMid}" class="symbol-stroke"/>` +
        `<line x1="${midX + 5}" y1="${(yMid - plateHalfLength).toFixed(1)}" x2="${midX + 5}" y2="${(yMid + plateHalfLength).toFixed(1)}" class="symbol-stroke symbol-stroke--thick"/>` +
        `<path d="M ${midX - 5} ${(yMid - plateHalfLength).toFixed(1)} L ${midX + 5} ${(yMid - plateHalfLength).toFixed(1)} M ${midX - 5} ${(yMid + plateHalfLength).toFixed(1)} L ${midX + 5} ${(yMid + plateHalfLength).toFixed(1)} M ${midX - 5} ${(yMid - plateHalfLength / 2).toFixed(1)} L ${midX - 5} ${(yMid + plateHalfLength / 2).toFixed(1)}" class="symbol-stroke symbol-stroke--thick" fill="none"/>`
      );
    }

    case "passive.variable_capacitor":
      return componentSymbolSvg("passive.capacitor") +
        `<line x1="${midX - 18}" y1="${yMid + 16}" x2="${midX + 18}" y2="${yMid - 16}" class="symbol-stroke symbol-stroke--accent"/>`;

    case "passive.inductor": {
      const loopWidth = (x2 - x1) / 3;
      const ry = box.height / 2 - 5;
      let arcs = horizontalLeads(box, yMid);
      for (let i = 0; i < 3; i++) {
        const cx = x1 + loopWidth * (i + 0.5);
        const left = (cx - loopWidth / 2).toFixed(1);
        const right = (cx + loopWidth / 2).toFixed(1);
        arcs += `<path d="M ${left} ${yMid} A ${(loopWidth / 2).toFixed(1)} ${ry.toFixed(1)} 0 1 1 ${right} ${yMid}" class="symbol-stroke"/>`;
      }
      return arcs;
    }

    case "passive.variable_inductor":
      return componentSymbolSvg("passive.inductor") +
        `<line x1="${midX - 18}" y1="${yMid + 14}" x2="${midX + 18}" y2="${yMid - 14}" class="symbol-stroke symbol-stroke--accent"/>`;

    case "passive.transformer":
      return (
        `<line x1="${PIN_INSET}" y1="${box.height * 0.3}" x2="${LEAD_MARGIN}" y2="${box.height * 0.3}" class="symbol-stroke"/>` +
        `<line x1="${PIN_INSET}" y1="${box.height * 0.7}" x2="${LEAD_MARGIN}" y2="${box.height * 0.7}" class="symbol-stroke"/>` +
        `<line x1="${box.width - LEAD_MARGIN}" y1="${box.height * 0.3}" x2="${box.width - PIN_INSET}" y2="${box.height * 0.3}" class="symbol-stroke"/>` +
        `<line x1="${box.width - LEAD_MARGIN}" y1="${box.height * 0.7}" x2="${box.width - PIN_INSET}" y2="${box.height * 0.7}" class="symbol-stroke"/>` +
        `<path d="M 24 16 A 8 8 0 1 1 24 30 A 8 8 0 1 1 24 44" class="symbol-stroke" fill="none"/>` +
        `<path d="M ${box.width - 24} 16 A 8 8 0 1 0 ${box.width - 24} 30 A 8 8 0 1 0 ${box.width - 24} 44" class="symbol-stroke" fill="none"/>` +
        `<line x1="${midX - 3}" y1="12" x2="${midX - 3}" y2="${box.height - 12}" class="symbol-stroke"/>` +
        `<line x1="${midX + 3}" y1="12" x2="${midX + 3}" y2="${box.height - 12}" class="symbol-stroke"/>`
      );

    case "other.ground":
      return builtinPaintSvg(GROUND_PAINT, box);

    case "connectors.tunnel":
      {
        const tunnelName = typeof properties?.name === "string" ? properties.name.trim() : "";
        const tipX = box.width - 8;
        const bodyLeft = 2;
        const bodyRight = tipX - 8;
        return (
          `<path d="M ${bodyLeft} 4 H ${bodyRight} L ${tipX} ${yMid} L ${bodyRight} ${box.height - 4} H ${bodyLeft} Z" ` +
          `fill="#d7d7ec" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>` +
          `<rect x="${tipX}" y="${yMid - 3}" width="8" height="6" rx="3" fill="currentColor"/>` +
          (tunnelName
            ? `<text x="${(bodyLeft + bodyRight) / 2}" y="${yMid + 3}" text-anchor="middle" class="tunnel-name">${escapeXmlText(tunnelName)}</text>`
            : "")
        );
      }

    case "connectors.bus": {
      // logic/bus.cpp: tronco VERTICAL grosso (não horizontal) com os fios de bit saindo pra
      // esquerda -- orientação e proporção corrigidas (era um traço horizontal com 6 tiquinhos).
      const trunkX = midX;
      let bits = `<line x1="${trunkX}" y1="4" x2="${trunkX}" y2="${box.height - 4}" class="symbol-stroke symbol-stroke--thick"/>`;
      const count = 8;
      for (let i = 0; i < count; i++) {
        const y = 4 + ((box.height - 8) / (count - 1)) * i;
        bits += `<line x1="4" y1="${y.toFixed(1)}" x2="${trunkX}" y2="${y.toFixed(1)}" class="symbol-stroke"/>`;
      }
      return bits;
    }

    case "connectors.socket": {
      // connectors/socket.cpp + connbase.cpp: tira VERTICAL fina com uma coluna de pinos -- o
      // desenho antigo tinha `width = box.width-36` que dava LARGURA NEGATIVA (bug: não renderizava
      // nada) pra caixa pequena real. `count` casa com o `pinCount:8` real do Core
      // (CoreApplication.cpp) -- desenhar menos círculos que pinos reais deixava 2 pinos sem marca
      // nenhuma, e a "bolinha azul" clicável (`pinLocalPosition`) caía no fallback genérico de 2
      // colunas em vez desta coluna única (bug relatado 2026-07-04: pontos de ligação flutuando fora
      // do desenho).
      const count = 8;
      let pins = `<rect x="4" y="2" width="${box.width - 8}" height="${box.height - 4}" rx="2" class="symbol-stroke" fill="none"/>`;
      for (let i = 0; i < count; i++) {
        const y = ((box.height) / (count + 1)) * (i + 1);
        pins += `<circle cx="${midX}" cy="${y.toFixed(1)}" r="2" class="symbol-stroke" fill="none"/>`;
      }
      return pins;
    }

    case "connectors.header": {
      // connectors/header.cpp + connbase.cpp: mesma tira vertical do Socket, com marcas de pino
      // retas (macho) em vez de círculos (fêmea) -- era um traço horizontal com 6 tiquinhos. `count`
      // casa com o `pinCount:8` real do Core, mesmo motivo do Socket acima.
      const count = 8;
      let pins = `<rect x="4" y="2" width="${box.width - 8}" height="${box.height - 4}" rx="2" class="symbol-stroke" fill="none"/>`;
      for (let i = 0; i < count; i++) {
        const y = ((box.height) / (count + 1)) * (i + 1);
        pins += `<line x1="${midX - 4}" y1="${y.toFixed(1)}" x2="${midX + 4}" y2="${y.toFixed(1)}" class="symbol-stroke symbol-stroke--thick"/>`;
      }
      return pins;
    }

    case "graphics.image": {
      // image.cpp real sempre desenha a imagem carregada (`drawPixmap`) escalada pro corpo -- sem
      // suporte a carregar/exibir a imagem de verdade nesta Webview ainda, o glifo decorativo
      // "foto" abaixo é um placeholder assumido (ver auditoria 2026-07-04); manter proporcional à
      // caixa real (80x80) em vez de números fixos de uma caixa antiga (96x64).
      const w = box.width, h = box.height;
      return (
        `<rect x="4" y="4" width="${w - 8}" height="${h - 8}" class="symbol-stroke" fill="none"/>` +
        `<circle cx="${w * 0.3}" cy="${h * 0.3}" r="${Math.min(w, h) * 0.08}" class="symbol-stroke" fill="none"/>` +
        `<path d="M 8 ${h - 12} L ${w * 0.4} ${h * 0.55} L ${w * 0.58} ${h * 0.68} L ${w * 0.75} ${h * 0.42} L ${w - 8} ${h - 12}" class="symbol-stroke" fill="none"/>`
      );
    }

    case "graphics.text": {
      // textcomponent.cpp: SEMPRE tem uma placa de fundo preenchida (amarelo-claro por padrão) +
      // borda -- antes só o texto flutuava sem nenhum retângulo atrás (bug: real nunca mostra texto
      // "no ar").
      const text = typeof properties?.text === "string" ? properties.text : "Texto";
      const fontSize = typeof properties?.fontSize === "number" ? properties.fontSize : 11;
      const color = typeof properties?.color === "string" ? properties.color : "currentColor";
      return (
        `<rect x="0.5" y="0.5" width="${Math.max(0, box.width - 1)}" height="${Math.max(0, box.height - 1)}" fill="#fffcdc" stroke="currentColor" stroke-width="1"/>` +
        `<text x="${midX}" y="${yMid + fontSize / 3}" text-anchor="middle" font-size="${fontSize}" fill="${color}">${escapeXmlText(text)}</text>`
      );
    }

    case "graphics.rectangle": {
      const stroke = typeof properties?.stroke === "string" ? properties.stroke : "currentColor";
      const fill = typeof properties?.fill === "string" ? properties.fill : "none";
      const strokeWidth = typeof properties?.strokeWidth === "number" ? properties.strokeWidth : 1;
      return `<rect x="0.5" y="0.5" width="${Math.max(0, box.width - 1)}" height="${Math.max(0, box.height - 1)}" stroke="${stroke}" fill="${fill}" stroke-width="${strokeWidth}"/>`;
    }

    case "graphics.ellipse": {
      const stroke = typeof properties?.stroke === "string" ? properties.stroke : "currentColor";
      const fill = typeof properties?.fill === "string" ? properties.fill : "none";
      return `<ellipse cx="${midX}" cy="${yMid}" rx="${box.width / 2 - 0.5}" ry="${box.height / 2 - 0.5}" stroke="${stroke}" fill="${fill}"/>`;
    }

    case "graphics.line": {
      // Desenho CANÔNICO (rotation=0): linha horizontal centrada no meio da caixa quadrada -- o
      // ponto médio é o único ponto invariante sob `rotate()` em torno do centro (ver
      // `propertyDrivenBox`), por isso é ele (não uma ponta) que vira a referência ao compilar de
      // volta pra `PackageShape.x1/y1/x2/y2` em `extension.ts::compileSymbolAuthoringComponents`.
      const length = typeof properties?.length === "number" ? properties.length : 40;
      const stroke = typeof properties?.stroke === "string" ? properties.stroke : "currentColor";
      return `<line x1="${midX - length / 2}" y1="${yMid}" x2="${midX + length / 2}" y2="${yMid}" stroke="${stroke}" stroke-width="2"/>`;
    }

    case "other.package": {
      const border = properties?.border !== false;
      const backgroundColor = typeof properties?.backgroundColor === "string" ? properties.backgroundColor : undefined;
      // `backgroundImageData` (achatado de `pkg.background.data` por `seedSymbolAuthoringComponents`
      // -- `properties` não aceita objeto aninhado) -- mesma foto real que `packageBodySvg` desenha
      // fora da sessão de autoria, só que aqui o componente é o meta "other.package" (corpo do
      // símbolo sendo EDITADO), não o `package` resolvido de um typeId qualquer.
      const backgroundImageData = typeof properties?.backgroundImageData === "string" ? properties.backgroundImageData : undefined;
      return (
        (backgroundImageData
          ? `<image x="0" y="0" width="${box.width}" height="${box.height}" preserveAspectRatio="none" href="data:image/png;base64,${backgroundImageData}"/>`
          : backgroundColor ? `<rect x="0" y="0" width="${box.width}" height="${box.height}" fill="${backgroundColor}"/>` : "") +
        (border ? `<rect x="0.5" y="0.5" width="${Math.max(0, box.width - 1)}" height="${Math.max(0, box.height - 1)}" class="symbol-stroke" fill="none"/>` : "") +
        (backgroundImageData ? "" : `<text x="4" y="11" font-size="7" fill="currentColor" opacity="0.55">PKG</text>`)
      );
    }

    case "other.package_pin": {
      // Desenho CANÔNICO (rotation=0): âncora no CENTRO da caixa (ponto invariante sob `rotate()`),
      // lead saindo pra DIREITA -- mesma convenção de ângulo 0=direita do renderizador de leitura
      // (`packagePinLeadSvg`). `component.rotation` (0/90/180/270, CSS) faz o papel do `angle` real
      // de um `PackagePin` sem nenhum campo novo -- reaproveita rotação genérica (teclado/toolbar).
      // SEM texto aqui -- o rótulo é um `graphics.text` vinculado separado (`linkedPinComponentId`),
      // arrastável independente da posição do pino, igual ao SimulIDE real (ver
      // `symbolAuthoring.ts`/`main.ts::requestAddComponent`).
      const length = typeof properties?.length === "number" ? properties.length : 8;
      const tipX = midX + length;
      return (
        `<line x1="${midX}" y1="${yMid}" x2="${tipX}" y2="${yMid}" class="symbol-stroke"/>` +
        `<circle cx="${midX}" cy="${yMid}" r="2" class="symbol-stroke" fill="currentColor"/>`
      );
    }

    case "other.test_unit":
      // testunit.cpp (IoComponent): `Component::paint()` + `drawRect(m_area)` -- corpo vazio, sem
      // check-mark nem cantos decorados (isso era inventado, sem base no paint() real).
      return `<rect x="2" y="2" width="${box.width - 4}" height="${box.height - 4}" class="symbol-stroke" fill="none"/>`;

    case "other.dial":
      // dial.cpp: o knob de verdade é um `QDial` NATIVO do Qt (widget do SO, não dá pra reproduzir
      // em SVG) -- usa a MESMA estilização de `sources.voltage_source`/`current_source`
      // (`qDialKnobSvg`), já que é o mesmo widget real por trás dos dois, em vez de manter dois
      // desenhos diferentes pra aproximar a mesma peça.
      return qDialKnobSvg(midX, yMid, Math.min(midX, yMid) - 2);

    case "sources.dc_voltage":
      return (
        horizontalLeads(box, yMid) +
        `<line x1="${x1}" y1="${yMid}" x2="${midX - 14}" y2="${yMid}" class="symbol-stroke"/>` +
        `<line x1="${midX + 14}" y1="${yMid}" x2="${x2}" y2="${yMid}" class="symbol-stroke"/>` +
        `<circle cx="${midX}" cy="${yMid}" r="14" class="symbol-stroke" fill="none"/>` +
        `<text x="${midX - 7}" y="${yMid + 5}" text-anchor="middle" class="symbol-text">+</text>` +
        `<text x="${midX + 7}" y="${yMid + 5}" text-anchor="middle" class="symbol-text">&#8722;</text>` +
        `<line x1="${PIN_INSET}" y1="${yMid - 7}" x2="${PIN_INSET}" y2="${yMid + 7}" class="symbol-stroke symbol-stroke--accent"/>` +
        `<line x1="${box.width - PIN_INSET - 6}" y1="${yMid}" x2="${box.width - PIN_INSET + 6}" y2="${yMid}" class="symbol-stroke symbol-stroke--accent"/>`
      );

    case "switches.push": {
      const contactY = 8;
      return (
        `<line x1="0" y1="${contactY}" x2="5" y2="${contactY}" class="symbol-stroke"/>` +
        `<line x1="27" y1="${contactY}" x2="32" y2="${contactY}" class="symbol-stroke"/>` +
        `<rect x="10" y="2" width="12" height="3" rx="1.5" class="push-actuator-bar" fill="currentColor"/>` +
        `<line x1="7" y1="${contactY - 4}" x2="25" y2="${contactY - 4}" class="symbol-stroke symbol-stroke--thick push-actuator-bar"/>` +
        `<rect x="10" y="11" width="12" height="11" rx="2" class="push-body toggle-hit-zone" fill="#dddddd" stroke="#777777" stroke-width="1.5"/>`
      );
    }

    case "switches.switch": {
      const contactY = 8;
      return (
        `<line x1="0" y1="${contactY}" x2="5" y2="${contactY}" class="symbol-stroke"/>` +
        `<line x1="27" y1="${contactY}" x2="32" y2="${contactY}" class="symbol-stroke"/>` +
        `<rect x="5" y="${contactY - 2}" width="8" height="4" rx="2" fill="currentColor"/>` +
        `<rect x="19" y="${contactY - 2}" width="8" height="4" rx="2" fill="currentColor"/>` +
        `<line x1="8" y1="${contactY}" x2="24" y2="0" class="symbol-stroke symbol-stroke--thick switch-lever"/>` +
        `<rect x="10" y="11" width="12" height="11" rx="2" class="switch-body toggle-hit-zone" fill="#dddddd" stroke="#777777" stroke-width="1.5"/>`
      );
    }

    case "logic.button": {
      const rise = box.height / 2 - 5;
      return (
        horizontalLeads(box, yMid) +
        `<line x1="${x1}" y1="${yMid}" x2="${midX - 8}" y2="${yMid}" class="symbol-stroke"/>` +
        `<line x1="${midX + 8}" y1="${yMid}" x2="${x2}" y2="${yMid}" class="symbol-stroke"/>` +
        `<circle cx="${midX - 8}" cy="${yMid}" r="2" class="symbol-stroke" fill="currentColor"/>` +
        `<circle cx="${midX + 8}" cy="${yMid}" r="2" class="symbol-stroke" fill="currentColor"/>` +
        `<line x1="${midX - 8}" y1="${yMid}" x2="${midX + 6}" y2="${(yMid - rise).toFixed(1)}" class="symbol-stroke"/>`
      );
    }

    case "switches.relay": {
      // relay.cpp: bobina real (arcos, igual passive.inductor) na METADE DE BAIXO + contato/alavanca
      // do interruptor na metade de CIMA -- não uma caixa de bobina + alavanca lado a lado como
      // estava antes (posições/proporções invented, sem relação com o m_area/paint real).
      const coilY = box.height - 10;
      let coil = `<line x1="4" y1="${coilY}" x2="${box.width - 4}" y2="${coilY}" class="symbol-stroke"/>`;
      const loopWidth = (box.width - 8) / 3;
      for (let i = 0; i < 3; i++) {
        const cx = 4 + loopWidth * (i + 0.5);
        coil += `<path d="M ${(cx - loopWidth / 2).toFixed(1)} ${coilY} A ${(loopWidth / 2).toFixed(1)} 6 0 1 1 ${(cx + loopWidth / 2).toFixed(1)} ${coilY}" class="symbol-stroke" fill="none"/>`;
      }
      const leverY = 8;
      return (
        coil +
        `<line x1="4" y1="${leverY}" x2="12" y2="${leverY}" class="symbol-stroke"/>` +
        `<circle cx="12" cy="${leverY}" r="1.6" class="symbol-stroke" fill="currentColor"/>` +
        `<line x1="12" y1="${leverY}" x2="${box.width - 8}" y2="${leverY - 6}" class="symbol-stroke symbol-stroke--thick"/>` +
        `<circle cx="${box.width - 8}" cy="${leverY - 6}" r="1.6" class="symbol-stroke" fill="currentColor"/>` +
        `<line x1="${box.width - 8}" y1="${leverY}" x2="${box.width - 4}" y2="${leverY}" class="symbol-stroke"/>`
      );
    }

    case "switches.keypad": {
      // Lê rows/columns/keyLabels REAIS da instância (mesmo default do real SimulIDE,
      // `keypad.cpp`: `m_keyLabels = "123456789*0#"`) -- sem isto, a grade saía sempre 4×4 vazia,
      // ignorando a configuração real do componente (bug relatado 2026-06-30, "veja o keypad o
      // quanto está diferente"). Cada tecla é um quadrado arredondado com o caractere centralizado,
      // igual ao desenho real (`keypad.cpp::paint()`).
      const cols = typeof properties?.columns === "number" ? properties.columns : 3;
      const rows = typeof properties?.rows === "number" ? properties.rows : 4;
      const keyLabels = typeof properties?.keyLabels === "string" ? properties.keyLabels : "123456789*0#";
      const cell = 16;
      const keySize = 12;
      let keysMarkup = "";
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const index = row * cols + col;
          const label = keyLabels[index] ?? "";
          const cx = 4 + col * cell + cell / 2;
          const cy = 4 + row * cell + cell / 2;
          keysMarkup +=
            `<rect x="${cx - keySize / 2}" y="${cy - keySize / 2}" width="${keySize}" height="${keySize}" rx="2" class="symbol-stroke" fill="none"/>` +
            (label ? `<text x="${cx}" y="${cy + 3}" text-anchor="middle" class="symbol-text" style="font-size:8px">${escapeXmlText(label)}</text>` : "");
        }
      }
      return keysMarkup;
    }

    case "active.diode":
    case "active.zener":
    case "active.diac":
    case "active.scr":
    case "active.triac":
      return diodeBody(
        typeId === "active.zener"
          ? `<path d="M ${midX + 10} ${(yMid - diodeBarHalf).toFixed(1)} l 5 -5 M ${midX + 10} ${(yMid + diodeBarHalf).toFixed(1)} l -5 5" class="symbol-stroke"/>`
          : ""
      );

    case "outputs.led":
      // outputs/leds/led.cpp + ledbase.cpp::drawBackground(): a bolha de vidro (elipse preenchida,
      // cor = brilho ao vivo) é o sinal visual real do LED -- as setinhas de "luz emitida" que
      // existiam aqui antes não têm equivalente nenhum no paint() real, foram removidas.
      return (
        `<ellipse cx="${midX - 1}" cy="${yMid}" rx="8" ry="8" fill="#3a3a3a" stroke="#111" stroke-width="1"/>` +
        diodeBody()
      );

    case "active.bjt":
      // active/bjt.cpp: m_area real QRectF(-12,-14,28,28) (elipse centrada em (2,0), raio 14) +
      // pinos Collector(8,-16)/Emiter(8,16)/Base(-16,0) -- convertido pra origem top-left desta
      // caixa 32×32 (deslocamento +16,+16, mesma metade da caixa) fica elipse em (18,16) r=14. O
      // raio fixo antigo (18) era MAIOR que a metade da caixa (16), estourando o próprio viewBox
      // (bug relatado 2026-07-04: "corpo" do transistor vazando pra fora do componente); os
      // `pinLocalPosition` já estavam certos (24,0)/(24,32)/(0,16), só o desenho não batia com eles.
      return (
        `<ellipse cx="18" cy="16" rx="14" ry="14" class="symbol-stroke" fill="none"/>` +
        `<line x1="0" y1="16" x2="12" y2="16" class="symbol-stroke"/>` +
        `<line x1="12" y1="8" x2="12" y2="24" class="symbol-stroke"/>` +
        `<line x1="12" y1="12" x2="24" y2="4" class="symbol-stroke"/>` +
        `<line x1="12" y1="20" x2="24" y2="28" class="symbol-stroke"/>` +
        `<line x1="24" y1="0" x2="24" y2="4" class="symbol-stroke"/>` +
        `<line x1="24" y1="32" x2="24" y2="28" class="symbol-stroke"/>` +
        `<path d="M 22 26.7 L 18.4 26 L 20 23.5 Z" fill="currentColor"/>`
      );

    case "active.mosfet":
      // active/mosfet.cpp: mesma elipse/pinos do BJT (m_area e Pin idênticos) -- só o glifo interno
      // muda (3 "dedos" horizontais + barra de gate + setinha de canal N, modo enhancement default).
      return (
        `<ellipse cx="18" cy="16" rx="14" ry="14" class="symbol-stroke" fill="none"/>` +
        `<line x1="0" y1="16" x2="12" y2="16" class="symbol-stroke"/>` +
        `<line x1="12" y1="8" x2="12" y2="24" class="symbol-stroke"/>` +
        `<line x1="16" y1="9" x2="24" y2="9" class="symbol-stroke"/>` +
        `<line x1="16" y1="16" x2="24" y2="16" class="symbol-stroke"/>` +
        `<line x1="16" y1="23" x2="24" y2="23" class="symbol-stroke"/>` +
        `<line x1="24" y1="0" x2="24" y2="9" class="symbol-stroke"/>` +
        `<line x1="24" y1="32" x2="24" y2="16" class="symbol-stroke"/>` +
        `<line x1="16" y1="7" x2="16" y2="11" class="symbol-stroke symbol-stroke--thick"/>` +
        `<line x1="16" y1="14" x2="16" y2="18" class="symbol-stroke symbol-stroke--thick"/>` +
        `<line x1="16" y1="21" x2="16" y2="25" class="symbol-stroke symbol-stroke--thick"/>` +
        `<path d="M 17 16 L 21 14 L 21 18 Z" fill="currentColor"/>`
      );

    case "active.jfet":
      // active/jfet.cpp: mesma elipse/pinos do BJT/Mosfet -- gate é uma barra reta única (sem
      // enhancement/depletion) e a seta aponta pra dentro (canal N default).
      return (
        `<ellipse cx="18" cy="16" rx="14" ry="14" class="symbol-stroke" fill="none"/>` +
        `<line x1="0" y1="16" x2="16" y2="16" class="symbol-stroke"/>` +
        `<line x1="16" y1="7" x2="16" y2="25" class="symbol-stroke"/>` +
        `<line x1="16" y1="9" x2="24" y2="9" class="symbol-stroke"/>` +
        `<line x1="16" y1="23" x2="24" y2="23" class="symbol-stroke"/>` +
        `<line x1="24" y1="0" x2="24" y2="9" class="symbol-stroke"/>` +
        `<line x1="24" y1="32" x2="24" y2="24" class="symbol-stroke"/>` +
        `<path d="M 15 16 L 11 14 L 11 18 Z" fill="currentColor"/>`
      );

    case "active.opamp":
    case "active.comparator":
      return (
        // Entradas ligadas EXATAMENTE em y=8/24 (mesmos valores de `pinLocalPosition` acima) -- a
        // proporção antiga (0.35/0.65 do box.height=32) dava 11.2/20.8, ~3px longe da bolinha de
        // ligação real.
        `<path d="M 24 12 L 24 ${box.height - 12} L ${box.width - 16} ${yMid} Z" class="symbol-stroke" fill="none"/>` +
        `<line x1="${PIN_INSET}" y1="8" x2="24" y2="8" class="symbol-stroke"/>` +
        `<line x1="${PIN_INSET}" y1="24" x2="24" y2="24" class="symbol-stroke"/>` +
        `<line x1="${box.width - 16}" y1="${yMid}" x2="${box.width - PIN_INSET}" y2="${yMid}" class="symbol-stroke"/>` +
        `<text x="18" y="12" text-anchor="middle" class="symbol-text">+</text>` +
        `<text x="18" y="28" text-anchor="middle" class="symbol-text">-</text>`
      );

    case "active.analog_mux":
      // mux_analog.cpp: paint() é só `drawRect(m_area)` -- sem texto nenhum (era `labelBox("MUX")`).
      return horizontalLeads(box, yMid) + `<rect x="4" y="2" width="${box.width - 8}" height="${box.height - 4}" class="symbol-stroke" fill="none"/>`;

    case "active.volt_regulator":
      // volt_reg.cpp: idem, `drawRect(m_area)` sem texto (era `labelBox("REG")`).
      return `<rect x="4" y="2" width="${box.width - 8}" height="${box.height - 4}" class="symbol-stroke" fill="none"/>`;

    case "outputs.led_rgb":
      // ledrgb.cpp: borda arredondada (pena grossa) + elipse preenchida com a cor viva (mistura
      // R/G/B) -- aqui em repouso/estático usamos cinza escuro (apagado), sem nenhum texto "RGB".
      return (
        `<rect x="2" y="2" width="${box.width - 4}" height="${box.height - 4}" rx="4" ry="4" class="symbol-stroke symbol-stroke--thick" fill="none"/>` +
        `<ellipse cx="${midX}" cy="${yMid}" rx="${box.width / 2 - 4}" ry="${box.height / 2 - 4}" fill="#3a3a3a"/>`
      );

    case "outputs.led_bar": {
      // ledbar.cpp: encapsulamento estreito + N LEDs individuais empilhados (8 default), cada um seu
      // proprio quadrado -- não um texto "LED BAR" solto.
      const count = 8;
      const cellH = (box.height - 8) / count;
      let cells = `<rect x="2" y="2" width="${box.width - 4}" height="${box.height - 4}" class="symbol-stroke" fill="none"/>`;
      for (let i = 0; i < count; i++) {
        const cy = 4 + cellH * (i + 0.5);
        cells += `<rect x="${midX - 4}" y="${(cy - 3).toFixed(1)}" width="8" height="6" fill="#3a3a3a" stroke="currentColor" stroke-width="0.75"/>`;
      }
      return cells;
    }

    case "outputs.led_matrix": {
      // ledmatrix.cpp: corpo arredondado + grade rows×cols de LEDs individuais (8x8 default) --
      // mesmo espírito do grid já implementado pra `switches.keypad`, não um texto "MATRIX".
      const rows = typeof properties?.rows === "number" ? properties.rows : 8;
      const cols = typeof properties?.columns === "number" ? properties.columns : 8;
      const cellW = (box.width - 8) / cols;
      const cellH = (box.height - 8) / rows;
      let cells = `<rect x="2" y="2" width="${box.width - 4}" height="${box.height - 4}" rx="3" ry="3" class="symbol-stroke" fill="none"/>`;
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const cx = 4 + cellW * (col + 0.5);
          const cy = 4 + cellH * (row + 0.5);
          cells += `<rect x="${(cx - cellW * 0.35).toFixed(1)}" y="${(cy - cellH * 0.35).toFixed(1)}" width="${(cellW * 0.7).toFixed(1)}" height="${(cellH * 0.7).toFixed(1)}" fill="#3a1414"/>`;
        }
      }
      return cells;
    }

    case "outputs.seven_segment": {
      // sevensegment.cpp: glifo real de 7 segmentos (o "8" clássico) em repouso/apagado -- não um
      // texto "7SEG". Segmentos como linhas grossas de ponta arredondada, igual ao LED real.
      const segColor = "#3a1414";
      const L = 6, R = box.width - 6, T = 6, M = yMid, B = box.height - 6;
      const seg = (x1: number, y1: number, x2: number, y2: number): string =>
        `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${segColor}" stroke-width="4" stroke-linecap="round"/>`;
      return (
        seg(L + 2, T, R - 2, T) + // a
        seg(R, T + 2, R, M - 2) + // b
        seg(R, M + 2, R, B - 2) + // c
        seg(L + 2, B, R - 2, B) + // d
        seg(L, M + 2, L, B - 2) + // e
        seg(L, T + 2, L, M - 2) + // f
        seg(L + 2, M, R - 2, M) + // g
        `<circle cx="${R + 4}" cy="${B}" r="2" fill="${segColor}"/>` // ponto decimal
      );
    }

    case "outputs.dc_motor": {
      // dcmotor.cpp: corpo circular concêntrico (carcaça + rotor) + 2 abas de terminal coloridas.
      const r = Math.min(box.width, box.height) / 2 - 2;
      return (
        `<ellipse cx="${midX}" cy="${yMid}" rx="${r}" ry="${r}" fill="#324664"/>` +
        `<rect x="${(midX - r - 6).toFixed(1)}" y="${(yMid - 4).toFixed(1)}" width="8" height="8" rx="2" fill="#8d0000"/>` +
        `<rect x="${(midX + r - 2).toFixed(1)}" y="${(yMid - 4).toFixed(1)}" width="8" height="8" rx="2" fill="#111"/>` +
        `<ellipse cx="${midX}" cy="${yMid}" rx="${(r * 0.8).toFixed(1)}" ry="${(r * 0.8).toFixed(1)}" fill="#ffffff"/>` +
        `<path d="M ${midX} ${yMid} L ${midX} ${(yMid - r * 0.7).toFixed(1)} A ${(r * 0.7).toFixed(1)} ${(r * 0.7).toFixed(1)} 0 0 1 ${(midX + r * 0.7 * 0.87).toFixed(1)} ${(yMid - r * 0.7 * 0.5).toFixed(1)} Z" fill="#324664"/>` +
        `<ellipse cx="${midX}" cy="${yMid}" rx="${(r * 0.4).toFixed(1)}" ry="${(r * 0.4).toFixed(1)}" fill="#dcdcdc" stroke="#888" stroke-width="1"/>`
      );
    }

    case "outputs.stepper": {
      // stepper.cpp: mesma família visual do dc_motor (círculos concêntricos) + marcas de passo em
      // volta do rotor + tira de conector à esquerda (5 pinos, todos do lado esquerdo no real).
      const r = Math.min(box.width, box.height) / 2 - 4;
      const cx = midX + 8;
      let ticks = "";
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const x1 = cx + Math.cos(a) * (r - 3);
        const y1 = yMid + Math.sin(a) * (r - 3);
        const x2 = cx + Math.cos(a) * r;
        const y2 = yMid + Math.sin(a) * r;
        ticks += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#ffffff" stroke-width="1.5"/>`;
      }
      return (
        `<rect x="0" y="${(yMid - r * 0.7).toFixed(1)}" width="14" height="${(r * 1.4).toFixed(1)}" rx="1" fill="#324664"/>` +
        `<ellipse cx="${cx}" cy="${yMid}" rx="${r}" ry="${r}" fill="#324664"/>` +
        `<ellipse cx="${cx}" cy="${yMid}" rx="${(r * 0.82).toFixed(1)}" ry="${(r * 0.82).toFixed(1)}" fill="#ffffff"/>` +
        ticks +
        `<ellipse cx="${cx}" cy="${yMid}" rx="${(r * 0.5).toFixed(1)}" ry="${(r * 0.5).toFixed(1)}" fill="#324664"/>` +
        `<ellipse cx="${cx}" cy="${yMid}" rx="${(r * 0.28).toFixed(1)}" ry="${(r * 0.28).toFixed(1)}" fill="#dcdcdc"/>`
      );
    }
    case "outputs.servo":
      return labelBox("SERVO");
    case "outputs.audio_out":
      return labelBox("AUDIO");
    case "outputs.incandescent_lamp":
      return (
        horizontalLeads(box, yMid) +
        `<circle cx="${midX}" cy="${yMid}" r="14" class="symbol-stroke" fill="none"/>` +
        `<path d="M ${midX - 8} ${yMid - 8} L ${midX + 8} ${yMid + 8} M ${midX + 8} ${yMid - 8} L ${midX - 8} ${yMid + 8}" class="symbol-stroke"/>`
      );

    case "outputs.hd44780":
    case "outputs.aip31068_i2c":
    case "outputs.pcd8544":
    case "outputs.ks0108":
    case "outputs.ssd1306":
    case "outputs.sh1107":
    case "outputs.st7735":
    case "outputs.st7789":
    case "outputs.ili9341":
    case "outputs.gc9a01a":
    case "outputs.pcf8833":
      return labelBox((typeId.split(".")[1] ?? typeId).replace(/_/g, " ").toUpperCase());

    case "logic.buffer":
      return labelBox("BUF");
    case "logic.and_gate":
      return labelBox("AND");
    case "logic.or_gate":
      return labelBox("OR");
    case "logic.xor_gate":
      return labelBox("XOR");
    case "logic.counter":
      return labelBox("CNT");
    case "logic.bin_counter":
      return labelBox("BIN CNT");
    case "logic.full_adder":
      return labelBox("ADD");
    case "logic.magnitude_comp":
      return labelBox("A:B");
    case "logic.shift_reg":
      return labelBox("SHIFT");
    case "logic.function":
      return labelBox("F(x)");
    case "logic.flipflop_d":
      return labelBox("D FF");
    case "logic.flipflop_t":
      return labelBox("T FF");
    case "logic.flipflop_rs":
      return labelBox("RS");
    case "logic.flipflop_jk":
      return labelBox("JK");
    case "logic.latch_d":
      return labelBox("LATCH");
    case "logic.memory":
      return labelBox("RAM");
    case "logic.dynamic_memory":
      return labelBox("DRAM");
    case "logic.i2c_ram":
      return labelBox("I2C RAM");
    case "logic.mux":
      return labelBox("MUX");
    case "logic.demux":
      return labelBox("DEMUX");
    case "logic.bcd_to_dec":
      return labelBox("BCD>DEC");
    case "logic.dec_to_bcd":
      return labelBox("DEC>BCD");
    case "logic.bcd_to_7seg":
      return labelBox("BCD>7S");
    case "logic.i2c_to_parallel":
      return labelBox("I2C>P");
    case "logic.adc":
      return labelBox("ADC");
    case "logic.dac":
      return labelBox("DAC");
    case "logic.seven_segment_bcd":
      return labelBox("7S BCD");
    case "logic.lm555":
      return labelBox("555");

    case "instruments.voltmeter":
      // `device.lsconfig` não tem mais `symbolSvg` próprio (o antigo círculo+"V" tinha leads
      // horizontais em y=24 que nunca bateram com a posição real do pino, calculada pra ESTE
      // desenho -- ver pinLocalPosition acima). O 3º pino ("outPin", saída analógica da leitura, ver
      // devices/voltmeter/src/lib.c) usa o terminal da direita desenhado por smallMeterDisplaySvg.
      return smallMeterDisplaySvg(box, "V", symbolReadoutNumber(properties));

    // ── Medidores (pasta "Meters" do SimulIDE) ──────────────────────────────────
    case "meters.probe": {
      // probe.cpp: o círculo é preenchido dinamicamente conforme o sinal medido (laranja acima do
      // limiar, azul abaixo, lavanda-claro no meio) -- antes sempre `fill="none"`, nunca refletia a
      // leitura.
      const showVolt = properties?.showVolt !== false;
      const reading = symbolReadoutNumber(properties);
      const threshold = 2.5;
      const fill = reading === undefined ? "#e6e6ff" : reading > threshold ? "#ffa600" : reading < -threshold ? "#0064ff" : "#e6e6ff";
      // probe.cpp: circulo real (drawEllipse(-8,-8,16,16)) fica encostado na borda direita de
      // m_area, nao centralizado com folga dos dois lados -- cx=22 (nao 20) faz o traco do pino
      // tocar exatamente a borda do circulo (era 2px curto antes).
      return (
        `<line x1="0" y1="8" x2="14" y2="8" class="symbol-stroke"/>` +
        `<ellipse cx="22" cy="8" rx="8" ry="8" class="symbol-stroke" fill="${fill}"/>` +
        (showVolt ? `<text x="34" y="6" class="probe-voltage-label">${escapeXmlText(formatRailVoltage(reading ?? 0))} V</text>` : "")
      );
    }

    case "meters.ampmeter":
      return smallMeterDisplaySvg(box, "A", symbolReadoutNumber(properties));

    case "meters.freqmeter":
      return (
        `<rect x="8" y="0" width="85" height="20" rx="1" class="meter-lcd"/>` +
        `<rect x="0" y="${yMid - 3}" width="8" height="6" rx="3" fill="currentColor"/>` +
        `<text x="13" y="${yMid + 5}" class="freq-lcd-value">${escapeXmlText(formatHz(symbolReadoutNumber(properties)))}</text>`
      );

    case "meters.oscope":
      // Caixa preta com uma forma de onda simplificada -- mesmo espírito do Oscope::paint (corpo
      // preenchido) sem a janela de plotagem real (ver docstring de Oscope.hpp no Core).
      return scopePanelSvg(properties);

    case "meters.logic_analyzer":
      return logicAnalyzerPanelSvg(properties);

    // ── Fontes (pasta "Sources" do SimulIDE) ────────────────────────────────────
    case "sources.fixed_volt":
      return builtinPaintSvg(fixedVoltPaint(), box, properties);

    case "sources.clock":
      return builtinPaintSvg(clockLikePaint(CLOCK_PULSE_PATH, "one"), box, properties);

    case "sources.wave_gen":
      return builtinPaintSvg(clockLikePaint(WAVE_GEN_SINE_PATH, "two"), box, properties);

    case "sources.voltage_source":
    case "sources.current_source": {
      // varsource.cpp: `paint()` preenche o `m_area` INTEIRO (40x56) com um painel cinza-claro
      // arredondado (230,230,230) ANTES do QDial nativo -- faltava esse painel de fundo (só o
      // botão de valor tinha fundo próprio antes, deixando o dial "flutuando" sem moldura, bug
      // relatado 2026-07-05). QDial via `qDialKnobSvg` (mesmo widget de `other.dial`).
      const unit = typeId === "sources.voltage_source" ? "V" : "A";
      const value = typeof properties?.value === "number" ? properties.value : unit === "V" ? 5 : 1;
      return (
        `<rect x="0" y="0" width="40" height="56" rx="2" fill="#e6e6e6" stroke="#464646" stroke-width="1.5"/>` +
        qDialKnobSvg(20, 19, 16) +
        `<rect x="4" y="39" width="32" height="14" rx="2" fill="#f2f2f2" stroke="#464646" stroke-width="1"/>` +
        `<text x="20" y="49" text-anchor="middle" class="symbol-text" style="font-size:9px">${escapeXmlText(formatRailVoltage(value))} ${unit}</text>` +
        `<line x1="40" y1="44" x2="48" y2="44" class="symbol-stroke"/>`
      );
    }

    case "sources.controlled_source":
      return builtinPaintSvg(CONTROLLED_SOURCE_PAINT, box);

    case "sources.battery":
      return builtinPaintSvg(BATTERY_PAINT, box);

    case "sources.rail": {
      const voltage = typeof properties?.voltage === "number" ? properties.voltage : 5.0;
      const label = `${formatRailVoltage(voltage)} V`;
      return (
        builtinPaintSvg(RAIL_PAINT, box) +
        `<text x="8" y="-2" text-anchor="middle" class="rail-voltage-label">${escapeXmlText(label)}</text>`
      );
    }

    default:
      return horizontalLeads(box, yMid) + `<rect x="${x1}" y="${yMid - 10}" width="${x2 - x1}" height="20" class="symbol-stroke" fill="none"/>`;
  }
}
