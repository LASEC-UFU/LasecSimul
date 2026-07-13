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

import { ComponentViewSpec, JUNCTION_TYPE_ID, PackageDescriptor, PackageDynamicPinGroup, PackageNumberValue, PackagePin, PackageShape, SIMULIDE_PACKAGE_GRID_UNIT, SimulidePaintSpec, SimulideQtWidgetSpec, TUNNEL_TYPE_ID, ViewSpecHitTest } from "./model.js";
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
const SMALL_METER_BOX: ComponentBox = { width: 56, height: 40 };

// ── Símbolo declarativo real (Épico G) ──────────────────────────────────────────────────────────
// Quando um typeId tem `package` (.lsdevice/.lssubcircuit, ver model.ts), cada pino é desenhado na
// posição REAL declarada (qualquer lado, com nome) -- nunca o algoritmo genérico esquerda/direita
// abaixo, que existe só pra built-ins sem package. `x`/`y` de um PackagePin é onde o "lead" toca o
// corpo; a ponta real (onde o fio conecta) é `x + cos(angle)*length, y + sin(angle)*length` -- pode
// cair fora de `0..width`/`0..height` (lead saindo da borda), por isso o layout é "resolvido" uma
// vez (desloca tudo pra um espaço sem coordenada negativa) em vez de usar `width`/`height` crus.
interface MaterializedPackagePin extends Omit<PackagePin, "x" | "y" | "angle" | "length" | "leadEndTrim" | "labelFontSize" | "labelSpace" | "labelX" | "labelY"> {
  x: number;
  y: number;
  angle: number;
  length: number;
  leadEndTrim?: number;
  labelFontSize?: number;
  labelSpace?: number;
  labelX?: number;
  labelY?: number;
}

interface MaterializedPackageDescriptor extends Omit<PackageDescriptor, "pins"> {
  pins: MaterializedPackagePin[];
}

interface ResolvedPackagePin extends MaterializedPackagePin {
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
  source: MaterializedPackageDescriptor;
}

function rotatePoint(x: number, y: number, cx: number, cy: number, deg: number): { x: number; y: number } {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = x - cx;
  const dy = y - cy;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

function numericPackageValue(value: PackageNumberValue | undefined, properties: Record<string, unknown> | undefined, context: Record<string, number>, fallback = 0): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (!value) return fallback;
  const rawBase = value.index
    ? context[value.index] ?? value.fallback ?? fallback
    : value.prop
      ? (Number.isFinite(Number(properties?.[value.prop])) ? Number(properties?.[value.prop]) : value.fallback ?? fallback)
      : value.fallback ?? fallback;
  const base = value.transform === "log2Ceil" ? (rawBase > 1 ? Math.ceil(Math.log2(rawBase)) : 0) : rawBase;
  let out = base * (value.multiplier ?? 1) + (value.offset ?? 0);
  if (value.min !== undefined) out = Math.max(value.min, out);
  if (value.max !== undefined) out = Math.min(value.max, out);
  switch (value.round) {
    case "round": return Math.round(out);
    case "floor": return Math.floor(out);
    case "ceil": return Math.ceil(out);
    case "trunc": return Math.trunc(out);
    default: return out;
  }
}

function materializePin(pin: PackagePin, properties?: Record<string, unknown>, context: Record<string, number> = {}): MaterializedPackagePin {
  return {
    ...pin,
    x: numericPackageValue(pin.x, properties, context),
    y: numericPackageValue(pin.y, properties, context),
    angle: numericPackageValue(pin.angle, properties, context),
    length: numericPackageValue(pin.length, properties, context, 8),
    leadEndTrim: pin.leadEndTrim === undefined ? undefined : numericPackageValue(pin.leadEndTrim, properties, context),
    labelFontSize: pin.labelFontSize === undefined ? undefined : numericPackageValue(pin.labelFontSize, properties, context),
    labelSpace: pin.labelSpace === undefined ? undefined : numericPackageValue(pin.labelSpace, properties, context),
    labelX: pin.labelX === undefined ? undefined : numericPackageValue(pin.labelX, properties, context),
    labelY: pin.labelY === undefined ? undefined : numericPackageValue(pin.labelY, properties, context),
  };
}

/** Exportado pra ser reaproveitado por `extension.ts::pinsForTypeId` -- o número/id REAL de pinos
 * elétricos que o Core recebe em `addComponent` precisa da MESMA fórmula usada aqui pro desenho
 * (`dynamicLayout.pinGroups`), senão a Webview desenha um pino que não existe de verdade no Core
 * (TR-9). Pura, sem DOM -- compilada tanto pelo host (`tsconfig.json`) quanto pela Webview. */
export function materializePinGroup(group: PackageDynamicPinGroup, properties?: Record<string, unknown>): MaterializedPackagePin[] {
  const rawCount = Number(properties?.[group.countProp]) || 0;
  const count =
    group.countFn === "log2Ceil"
      ? (rawCount > 1 ? Math.ceil(Math.log2(rawCount)) : 0)
      : Math.max(0, Math.trunc(rawCount));
  const pins: MaterializedPackagePin[] = [];
  for (let index = 0; index < count; index += 1) {
    const context = group.indexName ? { [group.indexName]: index } : { index };
    // Barramentos usam índice canônico zero-based (`bit-0` = LSB). Grupos que não declaram
    // `idStart` continuam começando em 1 pelo fallback; um zero explícito não pode ser alterado.
    const idNumber = Math.max(0, Math.trunc(numericPackageValue(group.idStart, properties, context, 1) + index));
    pins.push({
      id: `${group.idPrefix ?? "pin-"}${idNumber}`,
      x: numericPackageValue(group.x, properties, context),
      y: numericPackageValue(group.y, properties, context),
      angle: numericPackageValue(group.angle, properties, context, 0),
      length: numericPackageValue(group.length, properties, context, 8),
      leadEndTrim: group.leadEndTrim === undefined ? undefined : numericPackageValue(group.leadEndTrim, properties, context),
      leadOrigin: group.leadOrigin,
      leadColor: group.leadColor,
      label: group.label,
    });
  }
  return pins;
}

function materializePackage(pkg: PackageDescriptor, properties?: Record<string, unknown>): MaterializedPackageDescriptor {
  const dynamic = pkg.dynamicLayout;
  const width = dynamic?.width === undefined ? pkg.width : numericPackageValue(dynamic.width, properties, {}, pkg.width);
  const height = dynamic?.height === undefined ? pkg.height : numericPackageValue(dynamic.height, properties, {}, pkg.height);
  const pins = [
    ...(dynamic?.replacePins ? [] : pkg.pins.map((pin) => materializePin(pin, properties))),
    ...(dynamic?.pinGroups ?? []).flatMap((group) => materializePinGroup(group, properties)),
  ];
  const simulidePaint = pkg.simulidePaint && dynamic?.simulideBounds
    ? {
        ...pkg.simulidePaint,
        bounds: {
          x: dynamic.simulideBounds.x === undefined ? pkg.simulidePaint.bounds.x : numericPackageValue(dynamic.simulideBounds.x, properties, {}, pkg.simulidePaint.bounds.x),
          y: dynamic.simulideBounds.y === undefined ? pkg.simulidePaint.bounds.y : numericPackageValue(dynamic.simulideBounds.y, properties, {}, pkg.simulidePaint.bounds.y),
          w: dynamic.simulideBounds.w === undefined ? pkg.simulidePaint.bounds.w : numericPackageValue(dynamic.simulideBounds.w, properties, {}, pkg.simulidePaint.bounds.w),
          h: dynamic.simulideBounds.h === undefined ? pkg.simulidePaint.bounds.h : numericPackageValue(dynamic.simulideBounds.h, properties, {}, pkg.simulidePaint.bounds.h),
        },
      }
    : pkg.simulidePaint;
  return {
    ...pkg,
    width,
    height,
    schematicWidth: dynamic?.schematicWidth === undefined ? pkg.schematicWidth : numericPackageValue(dynamic.schematicWidth, properties, {}, pkg.schematicWidth ?? width),
    schematicHeight: dynamic?.schematicHeight === undefined ? pkg.schematicHeight : numericPackageValue(dynamic.schematicHeight, properties, {}, pkg.schematicHeight ?? height),
    simulidePaint,
    pins,
  };
}

/** Rotação de repouso arbitrária do símbolo (`PackageDescriptor.initialTransform`) -- pro caso de
 * devices que nascem girados no SimulIDE real (ex: `Probe::Probe()` faz `setRotation(rotation()-45)`
 * no construtor, algo que o modelo de rotação do schematic do LasecSimul -- só 0/90/180/270 -- não
 * representa). Gira os PINOS aqui (posição + ângulo) em volta do pivô declarado; a rotação do CORPO
 * visual (primitivas) é aplicada à parte, via `<g transform="rotate(...)">` em `packageBodySvg`, pra
 * não precisar reescrever geometria de cada tipo de `PackageShape` na mão. `leadOrigin:"terminal"`
 * usa a fórmula `180-angle` (não `angle` direto) pra achar o visualEnd -- rotacionar o VETOR
 * resultante corretamente exige SUBTRAIR `rotateDeg` do ângulo nesse modo (não somar); ver dedução em
 * `docs/20-diagnostico-renderizacao-simulide.md`. */
function applyInitialTransformToPins(pkg: MaterializedPackageDescriptor): MaterializedPackagePin[] {
  const transform = pkg.initialTransform;
  if (!transform?.rotateDeg) return pkg.pins;
  const rotateDeg = transform.rotateDeg;
  const cx = transform.cx ?? pkg.width / 2;
  const cy = transform.cy ?? pkg.height / 2;
  return pkg.pins.map((pin) => {
    const rotated = rotatePoint(pin.x, pin.y, cx, cy, rotateDeg);
    const angle = pin.leadOrigin === "terminal" ? pin.angle - rotateDeg : pin.angle + rotateDeg;
    return { ...pin, x: rotated.x, y: rotated.y, angle };
  });
}

function resolvePackageLayout(pkgInput: MaterializedPackageDescriptor): ResolvedPackage {
  const pkg = pkgInput.initialTransform?.rotateDeg ? { ...pkgInput, pins: applyInitialTransformToPins(pkgInput) } : pkgInput;
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

/** `font-size`/`stroke-width` de rótulo e lead de pino NUNCA escalam com `scaleX`/`scaleY`
 * (`schematicWidth`/`schematicHeight`) -- confirmado lendo o SimulIDE real (`gui/circuitwidget/
 * pin.cpp::Pin::paint()`): `font.setPixelSize(7)` e `QPen(...,3,...)`/`QPen(...,0.5,...)` são
 * CONSTANTES fixas, desenhadas direto no espaço final do item (sem nenhum conceito de "tamanho
 * nativo vs. schematic" -- cada `Package` real já nasce com dimensão/pinagem definitivas, ver
 * `other/subpackage.cpp`/`subcircuits/chip.cpp::m_area = QRect(0,0,8*m_width,8*m_height)`). A ÚNICA
 * coisa que reescala fonte+traço junto com a posição no SimulIDE real é o zoom do `QGraphicsView`,
 * que escala a cena INTEIRA uniformemente -- nunca um fator por-`package`. `scaleX`/`scaleY` aqui só
 * existem pra comprimir POSIÇÃO (`toDisplayX`/`toDisplayY`) quando um `package` LasecSimul foi
 * capturado em espaço de pixel nativo de uma foto/imagem (ex: `esp32_devkitc_v4.lssubcircuit`,
 * pinos capturados em coordenada de pixel da foto, sem equivalente no SimulIDE real onde pinos já
 * nascem autorados direto no espaço final) -- ver `docs/20-diagnostico-renderizacao-simulide.md`. */
function packagePinElectricalPoint(pin: MaterializedPackagePin): { x: number; y: number } {
  if (pin.leadOrigin === "terminal") return { x: pin.x, y: pin.y };
  const rad = (pin.angle * Math.PI) / 180;
  return { x: pin.x + Math.cos(rad) * pin.length, y: pin.y + Math.sin(rad) * pin.length };
}

function packagePinVisualEnd(pin: MaterializedPackagePin): { x: number; y: number } {
  if (pin.length === 0) return { x: pin.x, y: pin.y };
  const visualLength = Math.max(0, pin.length - (pin.leadEndTrim ?? 0));
  if (pin.leadOrigin === "terminal") {
    const rad = ((180 - pin.angle) * Math.PI) / 180;
    return { x: pin.x + Math.cos(rad) * visualLength, y: pin.y + Math.sin(rad) * visualLength };
  }
  const rad = (pin.angle * Math.PI) / 180;
  return { x: pin.x + Math.cos(rad) * visualLength, y: pin.y + Math.sin(rad) * visualLength };
}

const PACKAGE_BY_TYPE_ID = new Map<string, PackageDescriptor>();
/** Aparência ALTERNATIVA opcional ("Chip or Logic Symbol", igual ao `SubPackage::Logic_Symbol` do
 * SimulIDE real -- booleano simples, não uma lista de N variantes). Mapa SEPARADO do padrão (não um
 * 2º registro no mesmo mapa) pra não precisar inventar uma chave composta -- escolhido em
 * `resolvedPackageFor` pela propriedade `logicSymbol` da INSTÂNCIA, ver model.ts
 * `WebviewComponentCatalogEntry.logicSymbolPackage`. */
const LOGIC_SYMBOL_PACKAGE_BY_TYPE_ID = new Map<string, PackageDescriptor>();
/** Aparência do Modo Placa -- SEM equivalente no SimulIDE real (ver model.ts
 * `WebviewComponentCatalogEntry.boardPackage` pro porquê). Mapa SEPARADO, escolhido não por
 * propriedade da instância (como `logicSymbol`) mas por CONTEXTO de renderização (`variant:"board"`
 * explícito em `resolvedPackageFor`/`componentBox`/`packageSymbolSvg`) -- quem decide o contexto é
 * `main.ts` (dentro do Modo Placa real, ou no overlay da instância no circuito principal), nunca
 * este módulo. */
const BOARD_PACKAGE_BY_TYPE_ID = new Map<string, PackageDescriptor>();

export type PackageVariant = "board";

/** Chamado quando o catálogo chega/atualiza (ver `main.ts`) -- registra o descriptor original.
 * O layout é materializado em `resolvedPackageFor` por instância, porque packages como KeyPad dependem
 * de `properties` (`rows`/`columns`) para largura, altura e pinGroups. `undefined` remove (typeId sem
 * package mais, ou catálogo recarregado do zero). `boardPkg` não exige pino nenhum pra registrar
 * (guarda mais frouxa que `pkg`/`logicSymbolPkg`) -- ao contrário do esquemático, o Modo Placa nunca
 * desenha fio/terminal, então uma aparência puramente decorativa (0 pinos) é o caso normal, não uma
 * entrada malformada. */
export function registerPackage(typeId: string, pkg: PackageDescriptor | undefined, logicSymbolPkg?: PackageDescriptor, boardPkg?: PackageDescriptor): void {
  if (pkg && (pkg.pins.length > 0 || pkg.dynamicLayout?.pinGroups?.length)) PACKAGE_BY_TYPE_ID.set(typeId, pkg);
  else PACKAGE_BY_TYPE_ID.delete(typeId);

  if (logicSymbolPkg && (logicSymbolPkg.pins.length > 0 || logicSymbolPkg.dynamicLayout?.pinGroups?.length)) LOGIC_SYMBOL_PACKAGE_BY_TYPE_ID.set(typeId, logicSymbolPkg);
  else LOGIC_SYMBOL_PACKAGE_BY_TYPE_ID.delete(typeId);

  if (boardPkg) BOARD_PACKAGE_BY_TYPE_ID.set(typeId, boardPkg);
  else BOARD_PACKAGE_BY_TYPE_ID.delete(typeId);
}

/** `variant==="board"` E existe uma aparência de Modo Placa registrada pra este typeId -> usa ela
 * (nunca combinada com `logicSymbol` -- Modo Placa tem prioridade, é o contexto de renderização
 * mais específico). Sem variante de Modo Placa registrada pra este typeId, cai no caminho normal
 * (`logicSymbol`/`package` de sempre) -- Modo Placa reusa a mesma aparência do esquemático, igual
 * ao comportamento de antes desta funcionalidade existir. `properties.logicSymbol === true` E existe
 * uma variante Logic Symbol registrada pra este typeId -> usa ela; qualquer outro caso (sem
 * variante, propriedade ausente/falsa, ou sem `properties` nenhuma -- chamadas legadas que só
 * passam typeId) -> cai no `package` padrão de sempre. */
function resolvedPackageFor(typeId: string, properties?: Record<string, unknown>, variant?: PackageVariant): ResolvedPackage | undefined {
  if (variant === "board") {
    const boardPackage = BOARD_PACKAGE_BY_TYPE_ID.get(typeId);
    if (boardPackage) return resolvePackageLayout(materializePackage(boardPackage, properties));
  }
  if (properties?.logicSymbol === true) {
    const logicSymbolPackage = LOGIC_SYMBOL_PACKAGE_BY_TYPE_ID.get(typeId);
    if (logicSymbolPackage) return resolvePackageLayout(materializePackage(logicSymbolPackage, properties));
  }
  const pkg = PACKAGE_BY_TYPE_ID.get(typeId);
  return pkg ? resolvePackageLayout(materializePackage(pkg, properties)) : undefined;
}

function packageInstanceScale(properties?: Record<string, unknown>): { x: number; y: number } {
  const scaleX = typeof properties?.__simulideSceneScaleX === "number" && Number.isFinite(properties.__simulideSceneScaleX) && properties.__simulideSceneScaleX > 0
    ? properties.__simulideSceneScaleX
    : 1;
  const scaleY = typeof properties?.__simulideSceneScaleY === "number" && Number.isFinite(properties.__simulideSceneScaleY) && properties.__simulideSceneScaleY > 0
    ? properties.__simulideSceneScaleY
    : 1;
  return { x: scaleX, y: scaleY };
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
export function packageSymbolSvg(typeId: string, properties?: Record<string, unknown>, componentId?: string, variant?: PackageVariant): string | undefined {
  const resolved = resolvedPackageFor(typeId, properties, variant);
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

function packageTextContent(shape: PackageShape): string {
  const lines = String(shape.value ?? "").split(/\r?\n/);
  if (lines.length <= 1) return escapeXmlText(lines[0] ?? "");
  const lineHeight = Math.round((shape.fontSize ?? 11) * 1.15 * 1000) / 1000;
  return lines
    .map((line, index) => {
      const dy = index === 0 ? 0 : lineHeight;
      return `<tspan x="${shape.x ?? 0}" dy="${dy}">${escapeXmlText(line)}</tspan>`;
    })
    .join("");
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

function resolvedPathD(shape: PackageShape, properties?: Record<string, unknown>): string {
  if (shape.kind !== "path" || !shape.statePath) return shape.d ?? "";
  const rawValue = properties?.[shape.statePath.prop];
  const key = rawValue === undefined ? "absent" : String(rawValue);
  return shape.statePath.map[key] ?? shape.statePath.fallback ?? shape.d ?? "";
}

function packageShapeSvg(shape: PackageShape, extraTransform?: string, properties?: Record<string, unknown>): string {
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
      return safeInlineSvg(shape.value);
    case "polygon": {
      const pts = (shape.points ?? []).map(p => `${p.x},${p.y}`).join(" ");
      return `<polygon${cls}${xf} points="${pts}" stroke="${shape.stroke ?? "currentColor"}" fill="${fill}" stroke-width="${shape.strokeWidth ?? 1}"${paintAttrs}/>`;
    }
    case "path":
      return `<path${cls}${xf} d="${escapeXmlText(resolvedPathD(shape, properties))}" stroke="${shape.stroke ?? "currentColor"}" fill="${fill}" stroke-width="${shape.strokeWidth ?? 1}"${paintAttrs}/>`;
    case "image": {
      const href = safeImageHref(shape.href ?? shape.value);
      return `<image${cls}${xf} x="${shape.x ?? 0}" y="${shape.y ?? 0}" width="${shape.w ?? 0}" height="${shape.h ?? 0}" preserveAspectRatio="${escapeXmlText(shape.preserveAspectRatio ?? "none")}" href="${escapeXmlText(href)}"${paintAttrs}/>`;
    }
    case "text":
    default:
      return `<text${cls}${xf} x="${shape.x ?? 0}" y="${shape.y ?? 0}" text-anchor="${shape.textAnchor ?? "middle"}" font-size="${shape.fontSize ?? 11}"${shape.dominantBaseline ? ` dominant-baseline="${shape.dominantBaseline}"` : ""}${shape.fontFamily ? ` font-family="${escapeXmlText(shape.fontFamily)}"` : ""}${shape.fontWeight ? ` font-weight="${escapeXmlText(String(shape.fontWeight))}"` : ""} fill="${shape.color ?? "currentColor"}"${paintAttrs}>${packageTextContent(shape)}</text>`;
  }
}

function safeInlineSvg(value: string | undefined): string {
  if (!value) return "";
  if (/<\s*script\b/i.test(value)) return "";
  if (/<\s*foreignObject\b/i.test(value)) return "";
  if (/\son[a-z]+\s*=/i.test(value)) return "";
  if (/javascript\s*:/i.test(value)) return "";
  return value;
}

function safeImageHref(value: string | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (/^data:image\//i.test(trimmed)) return trimmed;
  if (/^#/i.test(trimmed)) return trimmed;
  if (/^(?:https?:|file:|javascript:)/i.test(trimmed)) return "";
  if (trimmed.includes("..")) return "";
  return trimmed;
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

function snapToGrid4(value: number): number {
  return Math.floor((value + 2) / 4) * 4;
}

function tunnelName(properties?: Record<string, unknown>): string {
  return typeof properties?.name === "string" ? properties.name.trim() : "";
}

function tunnelLabelWidth(properties?: Record<string, unknown>): number {
  // SimulIDE Pin font: Ubuntu Mono, pixelSize 7, PercentageSpacing 87 on Windows.
  return tunnelName(properties).length * 4.2;
}

function tunnelSize(properties?: Record<string, unknown>): number {
  const name = tunnelName(properties);
  return name ? snapToGrid4(Math.ceil(tunnelLabelWidth(properties) + 4)) : 20;
}

function tunnelRotated(properties?: Record<string, unknown>): boolean {
  return properties?.__simulideTunnelRotated === true;
}

function tunnelBox(properties?: Record<string, unknown>): ComponentBox {
  return { width: tunnelSize(properties) + 8, height: 12 };
}

function tunnelOrigin(properties?: Record<string, unknown>): { x: number; y: number } {
  return { x: tunnelRotated(properties) ? 0 : tunnelBox(properties).width, y: 6 };
}

function tunnelPaintSpec(properties?: Record<string, unknown>): SimulidePaintSpec {
  const size = tunnelSize(properties);
  const width = size + 8;
  const rotated = tunnelRotated(properties);
  const labelWidth = tunnelLabelWidth(properties);
  return {
    version: 1,
    source: {
      file: "connectors/tunnel.cpp + gui/circuitwidget/pin.cpp",
      className: "Tunnel",
      method: "Tunnel::paint + Pin::paint/Pin::setLabelPos",
      notes: "Traducao direta: m_area depende de Tunnel::setRotated(), m_size=snapToGrid4(labelSizeX()+4), pino em QPoint(0,0), Pin length=5 e texto e o label do Pin.",
    },
    bounds: { x: rotated ? 0 : -width, y: -6, w: width, h: 12 },
    defaultStroke: "#111111",
    defaultFill: "#fffffa",
    defaultStrokeWidth: 1.5,
    primitives: [
      rotated
        ? {
            kind: "line",
            x1: 0,
            y1: 0,
            x2: 4.3,
            y2: 0,
            stroke: "#111111",
            strokeWidth: 3,
            strokeLinecap: "round",
            strokeLinejoin: "round",
          }
        : {
            kind: "line",
            x1: 0,
            y1: 0,
            x2: -4.3,
            y2: 0,
            stroke: "#111111",
            strokeWidth: 3,
            strokeLinecap: "round",
            strokeLinejoin: "round",
          },
      rotated
        ? {
            kind: "polygon",
            points: [
              { x: size + 8, y: -4 },
              { x: 8, y: -4 },
              { x: 4, y: 0 },
              { x: 8, y: 4 },
              { x: size + 8, y: 4 },
            ],
            fill: "#fffffa",
            stroke: "#111111",
            strokeWidth: 1.5,
            strokeLinejoin: "round",
          }
        : {
            kind: "polygon",
            points: [
              { x: -size - 8, y: -4 },
              { x: -8, y: -4 },
              { x: -4, y: 0 },
              { x: -8, y: 4 },
              { x: -size - 8, y: 4 },
            ],
            fill: "#fffffa",
            stroke: "#111111",
            strokeWidth: 1.5,
            strokeLinejoin: "round",
          },
      {
        kind: "text",
        x: rotated ? 9 : -labelWidth - 9,
        y: 0,
        value: "",
        fontSize: 7,
        textAnchor: "start",
        dominantBaseline: "middle",
        fontFamily: "Ubuntu Mono, monospace",
        fontWeight: 400,
        fill: "#000000",
        stroke: "none",
        stateText: { kind: "property", prop: "name" },
      },
    ],
  };
}

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
      const propRange: [number, number] | undefined = proj.propRange && [
        proj.propRangeMinProp ? numericViewSpecProperty(properties, proj.propRangeMinProp, proj.propRange[0]) : proj.propRange[0],
        proj.propRangeMaxProp ? numericViewSpecProperty(properties, proj.propRangeMaxProp, proj.propRange[1]) : proj.propRange[1],
      ];
      const angle = propRange && proj.angleRange
        ? resolveAxisMapping(
            Math.max(Math.min(pos, Math.max(propRange[0], propRange[1])), Math.min(propRange[0], propRange[1])),
            propRange,
            proj.angleRange
          )
        : (() => {
            const stepsPerRev = Math.max(1, numericViewSpecProperty(properties, proj.stepsPerRevProp ?? "", proj.stepsPerRev));
            return (((pos % stepsPerRev) + stepsPerRev) % stepsPerRev) / stepsPerRev * 360;
          })();
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
function viewSpecBodySvg(pkg: PackageDescriptor, componentId: string, properties: Record<string, unknown>, includePaint = true): string | undefined {
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
  if (includePaint) {
    for (const shape of spec.paint ?? []) {
      const projection = shape.partId ? viewSpecResolvedProjection(shape.partId, spec, properties) : {};
      if (projection.visible === false) continue;
      const projectedShape = projection.fill ? { ...shape, fill: projection.fill } : shape;
      // Resolve gradient references in fill
      const resolvedShape: PackageShape = gradientIdMap.has(projectedShape.fill ?? "")
        ? { ...projectedShape, fill: gradientIdMap.get(projectedShape.fill!)! }
        : projectedShape;
      paintMarkup += packageShapeSvg(resolvedShape, projection.transform, properties);
    }
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
function packagePinLeadSvg(pin: MaterializedPackagePin, resolved: ResolvedPackage, labelColor = "currentColor", properties?: Record<string, unknown>): string {
  const visualEnd = packagePinVisualEnd(pin);
  const electrical = packagePinElectricalPoint(pin);
  const tipNativeX = electrical.x;
  const tipNativeY = electrical.y;
  const label = pin.label ?? pin.id;
  const hasCustomLabelPos = pin.labelX !== undefined && pin.labelY !== undefined;
  const labelSpace = pin.labelSpace ?? 9;
  const rad = (pin.angle * Math.PI) / 180;
  const labelFontSize = pin.labelFontSize ?? PACKAGE_PIN_LABEL_FONT_SIZE;
  let labelNativeX = pin.labelX ?? tipNativeX + Math.cos(rad) * labelSpace;
  let labelNativeY = pin.labelY ?? tipNativeY + Math.sin(rad) * labelSpace;
  let textAnchor = pin.labelTextAnchor ?? "middle";
  let labelRotation: number | undefined;
  let labelDominantBaseline = pin.labelDominantBaseline;
  if (!hasCustomLabelPos && pin.leadOrigin === "terminal") {
    const offset = pin.length + (pin.labelSpace ?? Math.max(2, labelFontSize / 2));
    labelDominantBaseline = labelDominantBaseline ?? "middle";
    switch (pin.angle) {
      case 0:
        labelNativeX = tipNativeX - offset;
        labelNativeY = tipNativeY;
        textAnchor = pin.labelTextAnchor ?? "end";
        break;
      case 90:
        labelNativeX = tipNativeX;
        labelNativeY = tipNativeY + offset;
        textAnchor = pin.labelTextAnchor ?? "middle";
        labelRotation = 90;
        break;
      case 180:
        labelNativeX = tipNativeX + offset;
        labelNativeY = tipNativeY;
        textAnchor = pin.labelTextAnchor ?? "start";
        break;
      case 270:
        labelNativeX = tipNativeX;
        labelNativeY = tipNativeY - offset;
        textAnchor = pin.labelTextAnchor ?? "middle";
        labelRotation = -90;
        break;
    }
  }
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
  const isVerticalLead = !hasCustomLabelPos && pin.leadOrigin !== "terminal" && (pin.angle === 90 || pin.angle === 270);
  const rotateDeg = labelRotation ?? (isVerticalLead ? -90 : undefined);
  const rotateAttr = rotateDeg === undefined ? "" : ` transform="rotate(${rotateDeg} ${labelX.toFixed(1)} ${labelY.toFixed(1)})"`;
  const resolvedLabelColor = pin.labelColor ?? labelColor;
  const fillAttr = resolvedLabelColor === "currentColor" ? ` class="symbol-text"` : ` fill="${resolvedLabelColor}"`;
  const baselineAttr = labelDominantBaseline ? ` dominant-baseline="${labelDominantBaseline}"` : "";
  const leadColor = pin.leadColor ?? "#000";
  const leadMarkup = pin.length === 0
    ? ""
    : `<line x1="${x.toFixed(1)}" y1="${y.toFixed(1)}" x2="${leadEndX.toFixed(1)}" y2="${leadEndY.toFixed(1)}" stroke="${escapeXmlText(leadColor)}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
  const markerMarkup = resolved.source.pinMarker === "packagePin"
    ? `<g stroke="#d3d3d3" stroke-width="0.5" stroke-linecap="round" stroke-linejoin="round"><line x1="${(x - 1).toFixed(1)}" y1="${y.toFixed(1)}" x2="${(x + 1).toFixed(1)}" y2="${y.toFixed(1)}"/><line x1="${x.toFixed(1)}" y1="${(y - 1).toFixed(1)}" x2="${x.toFixed(1)}" y2="${(y + 1).toFixed(1)}"/></g>`
    : "";
  const labelVisible = stateVisibleMatches(pin.labelStateVisible, properties);
  const labelMarkup = labelVisible && label.trim()
    ? `<text x="${labelX.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="${textAnchor}"${baselineAttr}${fillAttr} style="font-size:${labelFontSize}px"${rotateAttr}>${escapeXmlText(label)}</text>`
    : "";
  return (
    leadMarkup +
    markerMarkup +
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

function svgRound(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function qtButtonSvg(x: number, y: number, w: number, h: number, text: string, id: string): string {
  const gradId = `${id}-button-grad`;
  const innerH = h - 2;
  // Envolve os 3 elementos num `<g class="meter-expand-button">` -- NÃO a classe direto em cada um
  // (colocaria `.meter-expand-button { fill:#ededed; stroke:#999 }`, do CSS, por cima do
  // gradiente/borda destes atributos: presentation attribute sempre perde pra regra de CSS na
  // cascata). `<g>` não tem fill/stroke próprio pra sobrescrever nada -- só serve de alvo pro
  // `event.target.closest(".meter-expand-button")` do handler de clique (`main.ts`,
  // `isExpandableInstrument`). Sem isto (nenhum elemento carregava a classe antes), o botão
  // "Expande" nunca respondia a clique nenhum -- bug relatado 2026-07-09.
  return (
    `<defs><linearGradient id="${gradId}" x1="${x + w / 2}" y1="${y}" x2="${x + w / 2}" y2="${y + innerH}" gradientUnits="userSpaceOnUse">` +
    `<stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#c8c8c8"/></linearGradient></defs>` +
    `<g class="meter-expand-button">` +
    `<rect x="${x + 0.8}" y="${y + 0.8}" width="${w - 1.6}" height="${innerH + 0.4}" rx="2" ry="2" fill="none" stroke="#6e6e6e" stroke-width="1"/>` +
    `<rect x="${x + 1}" y="${y + 1}" width="${w - 2}" height="${innerH}" rx="2" ry="2" fill="url(#${gradId})" stroke="none"/>` +
    `<text x="${x + w / 2}" y="${y + h / 2}" text-anchor="middle" dominant-baseline="central" font-family="Segoe UI,Arial,sans-serif" font-size="9" font-weight="700" fill="#000014">${escapeXmlText(text)}</text>` +
    `</g>`
  );
}

function plotDisplaySvg(x: number, y: number, w: number, h: number, channels: number, tracks: number, histories: number[][], logicHistory: number[], colors: string[], expanded: boolean): string {
  const marginX = expanded ? 30 : 4;
  const marginY = expanded ? 10 : 4;
  const ceroX = x + marginX;
  const endX = x + w - marginX;
  const ceroY = y + marginY;
  const endY = y + h - marginY;
  const sizeX = w - 2 * marginX;
  const sizeY = h - 2 * marginY;
  let markup = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="7" ry="7" fill="#000000" stroke="#000000" stroke-width="1"/>`;

  for (let gx = ceroX; gx <= endX + 1; gx += sizeX / 10) {
    markup += `<line x1="${svgRound(gx)}" y1="${ceroY}" x2="${svgRound(gx)}" y2="${endY}" stroke="#464646" stroke-width="1.5" stroke-linecap="round"/>`;
  }
  if (expanded || channels === 8) {
    const divs = channels === 8 ? 8 : 10 * tracks;
    const startY = channels === 8 ? ceroY + sizeY / 16 : ceroY;
    for (let gy = startY; gy <= endY + 1; gy += sizeY / divs) {
      markup += `<line x1="${ceroX}" y1="${svgRound(gy)}" x2="${endX}" y2="${svgRound(gy)}" stroke="#464646" stroke-width="1.5" stroke-linecap="round"/>`;
    }
  }

  if (channels === 8) {
    const samples = logicHistory.length > 1 ? logicHistory : [0, 0];
    for (let channel = 0; channel < 8; channel += 1) {
      const rowCenter = ceroY + (channel + 0.5) * sizeY / 8;
      const highY = rowCenter - sizeY / 32;
      const lowY = rowCenter + sizeY / 32;
      const points = samples.map((mask, index) => {
        const px = ceroX + (sizeX * index) / Math.max(1, samples.length - 1);
        const py = ((mask >>> channel) & 1) === 1 ? highY : lowY;
        return `${index === 0 ? "M" : "L"} ${svgRound(px)} ${svgRound(py)}`;
      }).join(" ");
      markup += `<path d="${points}" fill="none" stroke="${colors[channel % colors.length]}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
  } else {
    for (let channel = 0; channel < channels; channel += 1) {
      const history = histories[channel] ?? [];
      const samples = history.length > 1 ? history : [0, 0];
      markup += `<path d="${tracePath(samples, ceroX, ceroY, sizeX, sizeY, -5, 5)}" fill="none" stroke="${colors[channel % colors.length]}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
  }
  return markup;
}

function simulideQtWidgetSvg(widget: SimulideQtWidgetSpec, properties: Record<string, unknown>, scopeId: string): string {
  const isLogic = widget.variant === "logicAnalyzer";
  const histories = symbolHistoryMatrix(properties);
  const logicHistory = symbolHistoryArray(properties);
  const latest = symbolReadoutArray(properties);
  const colors = ["#c8c83c", "#b4b4d7", "#c0a05f", "#00c864", "#c8c83c", "#b4b4d7", "#c0a05f", "#00c864"];
  const widgetX = 10;
  const widgetY = 2;
  const displayX = widgetX + 72;
  const displayY = widgetY + 2;
  const displayW = 143;
  const displayH = 143;
  let markup = `<rect x="8" y="0" width="219" height="153" rx="4" ry="4" fill="#f4f4f4" stroke="#606060" stroke-width="1.5"/>`;

  if (isLogic) {
    for (let i = 0; i < 8; i += 1) {
      const y = widgetY + 6 + i * 16;
      markup += `<rect x="${widgetX + 8}" y="${y}" width="60" height="14" rx="2" ry="2" fill="${colors[i]}" stroke="#777" stroke-width="1"/>`;
    }
    markup += qtButtonSvg(widgetX + 8, widgetY + 130, 60, 16, "Expande", `${scopeId}-logic`);
    markup += plotDisplaySvg(displayX, displayY, displayW, displayH, 8, 8, [], logicHistory, colors, false);
  } else {
    for (let i = 0; i < 4; i += 1) {
      const y = widgetY + 18 + i * 29;
      const latestValue = latest[i];
      const label = typeof latestValue === "number" && latestValue !== 0 ? `${formatRailVoltage(latestValue)} Hz` : "0 Hz";
      markup += `<text x="${widgetX + 8}" y="${y}" font-family="Segoe UI,Arial,sans-serif" font-size="9" font-weight="700" fill="#000">${escapeXmlText(label)}</text>`;
      markup += `<rect x="${widgetX + 8}" y="${y + 5}" width="60" height="15" rx="2" ry="2" fill="${colors[i]}" stroke="#777" stroke-width="1"/>`;
    }
    markup += qtButtonSvg(widgetX + 8, widgetY + 130, 60, 16, "Expande", `${scopeId}-scope`);
    markup += plotDisplaySvg(displayX, displayY, displayW, displayH, 4, widget.tracks ?? 1, histories, [], ["#00c864", "#f6f65a", "#ffd06a", "#d9d7ff"], false);
  }
  return markup;
}

/** Corpo completo de um typeId com `package`: fundo + formas declarativas + lead/rótulo de cada
 * pino, tudo num único `<g>` deslocado pro espaço sem coordenada negativa que `componentBox` usa
 * pro `viewBox` (ver `resolvePackageLayout`).
 * Quando `pkg.viewSpec` está presente e `componentId` é fornecido, usa o ViewSpec renderer (gradientes
 * escopados + stateProjection inicial). Caso contrário cai para `shapes[]` legado. */
function packageBodySvg(resolved: ResolvedPackage, componentId?: string, properties?: Record<string, unknown>): string {
  const pkg = resolved.source;
  let markup = packageBackgroundSvg(pkg);
  const scopeId = `simulide-${componentId ? componentId.replace(/[^a-zA-Z0-9_-]/g, "_") : "static"}`;

  const hasViewSpec = Boolean(pkg.viewSpec && componentId);
  if (pkg.simulidePaint) {
    for (const shape of simulidePaintToPackageShapes(pkg.simulidePaint, pkg.width, pkg.height, properties ?? {}, scopeId)) markup += packageShapeSvg(shape);
  } else if (pkg.qtWidget) {
    markup += simulideQtWidgetSvg(pkg.qtWidget, properties ?? {}, scopeId);
  } else if (hasViewSpec) {
    markup += viewSpecBodySvg(pkg, componentId!, properties ?? {}) ?? "";
  } else {
    for (const shape of pkg.shapes ?? []) markup += packageShapeSvg(shape, undefined, properties);
  }
  if (hasViewSpec && (pkg.simulidePaint || pkg.qtWidget)) {
    markup += viewSpecBodySvg(pkg, componentId!, properties ?? {}, pkg.viewSpec?.overlayPaint === true) ?? "";
  }
  if (pkg.initialTransform?.rotateDeg) {
    const cx = pkg.initialTransform.cx ?? pkg.width / 2;
    const cy = pkg.initialTransform.cy ?? pkg.height / 2;
    markup = `<g transform="rotate(${pkg.initialTransform.rotateDeg} ${cx} ${cy})">${markup}</g>`;
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
  const instanceScale = packageInstanceScale(properties);
  const packageMarkup = bodyMarkup + pinsMarkup;
  return instanceScale.x === 1 && instanceScale.y === 1
    ? packageMarkup
    : `<g transform="scale(${instanceScale.x.toFixed(6)},${instanceScale.y.toFixed(6)})">${packageMarkup}</g>`;
}

const DEFAULT_BOX: ComponentBox = { width: 70, height: 40 };

function builtinComponentBox(typeId: string): ComponentBox | undefined {
  switch (typeId) {
    case JUNCTION_TYPE_ID: return { width: 0, height: 0 };
    case "connectors.bus": return { width: 24, height: 64 }; // logic/bus.cpp: tronco vertical
    case TUNNEL_TYPE_ID: return tunnelBox();

    case "graphics.image": return { width: 80, height: 80 };
    case "graphics.text": return { width: 74, height: 28 };
    case "graphics.rectangle": return { width: 96, height: 58 };
    case "graphics.ellipse": return { width: 96, height: 58 };
    case "graphics.line": return { width: 86, height: 32 };
    case "other.package": return { width: 84, height: 66 };
    case "other.package_pin": return { width: 24, height: 24 };
    case "other.test_unit": return { width: 32, height: 32 }; // other/testunit.cpp (IoComponent generico)
    case "other.dial": return { width: 40, height: 40 }; // other/dial.cpp: knob nativo (QDial) -- estilizacao vetorial menor que antes
    case "subcircuits.external": return { width: 56, height: 40 }; // bloco generico de subcircuito por caminho, ainda sem arquivo vinculado -- retangulo neutro "de tamanho medio", nunca a silhueta de 2 pinos do fallback generico (ver componentSymbolSvg)

    case "logic.button": return COMP2PIN_BOX;

    // "switches.push"/"switches.switch"/"switches.switch_dip"/"switches.relay" agora vêm de
    // `package.simulidePaint` real (ver component-catalog.json + `registerPackage`) -- caixa
    // resolvida em `resolvePackageLayout`, nunca mais uma caixa estática aqui.
    default: return undefined;
  }
}

/** Caixa property-driven dos typeIds "de autoria de símbolo/subcircuito" -- `other.package`/
 * `graphics.rectangle`/`ellipse`/`image` usam `width`/`height` direto (mesmo significado de
 * `PackageDescriptor.width/height`/`PackageShape.w/h`, ver seção 21.2 do
 * `.spec/lasecsimul-native-devices.spec`). `graphics.line`/`other.package_pin` usam uma caixa
 * QUADRADA centrada no `length` -- o ponto fixo que não se move quando `component.rotation` gira
 * (CSS `rotate()` pivota no CENTRO do elemento, ver `renderComponent`) é o CENTRO da caixa, por isso
 * o desenho "canônico" (rotation=0) tem que colocar a âncora/ponto médio exatamente lá -- ver
 * `componentSymbolSvg` e `extension/src/catalog/subcircuitPackageAuthoring.ts` (fórmula inversa, o
 * compilador da autoria de Package dentro de "Abrir Subcircuito" -- ver `.spec/lasecsimul.spec`). */
function propertyDrivenBox(typeId: string, properties: Record<string, unknown> | undefined): ComponentBox | undefined {
  if (!properties) return undefined;
  const numberOf = (key: string): number | undefined => (typeof properties[key] === "number" ? (properties[key] as number) : undefined);
  switch (typeId) {
    case TUNNEL_TYPE_ID:
      return tunnelBox(properties);
    case "graphics.rectangle":
    case "graphics.ellipse":
    case "graphics.image":
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
    default:
      return undefined;
  }
}

/** Caixa (tamanho irregular, por tipo) usada pro `viewBox` do SVG e pro layout dos pinos. Quando o
 * typeId tem `package` (ver `registerPackage`), a caixa vem do layout resolvido (já com folga pra
 * leads que saem fora de `0..width`/`0..height`), nunca da tabela estática abaixo. `properties` (a
 * instância, não o typeId) tem prioridade sobre `package`/tabela estática quando presente -- só os
 * típicos "de autoria de símbolo" (`propertyDrivenBox`) realmente usam isso hoje. */
export function componentBox(typeId: string, properties?: Record<string, unknown>, variant?: PackageVariant): ComponentBox {
  const resolved = resolvedPackageFor(typeId, properties, variant);
  if (resolved) {
    const instanceScale = packageInstanceScale(properties);
    return { width: resolved.width * instanceScale.x, height: resolved.height * instanceScale.y };
  }
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

export function componentLocalOrigin(typeId: string, properties?: Record<string, unknown>): { x: number; y: number } | undefined {
  if (typeId === TUNNEL_TYPE_ID) return tunnelOrigin(properties);
  if (properties?.__simulideQtOrigin === true) {
    const resolved = resolvedPackageFor(typeId, properties);
    if (resolved) {
      const instanceScale = packageInstanceScale(properties);
      return { x: resolved.offsetX * resolved.scaleX * instanceScale.x, y: resolved.offsetY * resolved.scaleY * instanceScale.y };
    }
  }
  return undefined;
}

export function pinLocalPosition(pinId: string, pinIndex: number, pinCount: number, typeId: string, properties?: Record<string, unknown>): { x: number; y: number } {
  const resolved = resolvedPackageFor(typeId, properties);
  if (resolved) {
    const pin = resolved.pins.find((candidate) => packagePinMatches(candidate, pinId) && stateVisibleMatches(candidate.stateVisible, properties));
    if (pin) {
      const instanceScale = packageInstanceScale(properties);
      return { x: pin.tipX * instanceScale.x, y: pin.tipY * instanceScale.y };
    }
  }
  if (typeId === JUNCTION_TYPE_ID) return { x: 0, y: 0 };
  const box = componentBox(typeId, properties);
  // SimulIDE sources/ground.cpp:
  //   m_area = QRect(-8,-10,16,12)
  //   IoPin(90, QPoint(0,-16), ...)
  // In this positive viewBox the offset is (+8,+16), so the real electrical
  // connection is the top of the vertical lead, not the middle of the symbol.
  if (typeId === "other.ground" && pinCount <= 1) {
    return { x: box.width / 2, y: 0 };
  }
  if (typeId === TUNNEL_TYPE_ID && pinCount <= 1) {
    return tunnelOrigin(properties);
  }
  // logic/bus.cpp real só tem 1 pino elétrico (o Core modela como Junction, ver
  // CoreApplication.cpp) -- os 8 traços de bit no desenho são só decoração do tronco. O ponto de
  // ligação clicável fica no CENTRO do tronco vertical (não no topo, fallback genérico antigo
  // deixava a bolinha longe do meio do traço grosso).
  if (typeId === "connectors.bus" && pinCount <= 1) {
    return { x: box.width / 2, y: box.height / 2 };
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

/** Porta fiel de `CustomDial::paintEvent` (SimulIDE real, `gui/customdial.cpp`) -- o knob rotativo
 * que `Dialed` (`gui/circuitwidget/dialed.cpp`) monta pra QUALQUER dispositivo com controle
 * giratório: `Dial` (`other.dial`), `Potentiometer`, `VarResBase`/`VarInductor`/`VarCapacitor`
 * (resistor/indutor/capacitor variável), fonte de tensão/corrente controlada (`SourceWidget`) e o
 * encoder `KY040` -- todos o MESMO widget real, nunca aproximações diferentes por typeId.
 *
 * Geometria (todas as proporções derivadas de `r`, o raio TOTAL do widget -- equivalente a
 * `width/2`/`height/2` do `QDial` real, NÃO só o círculo visível; as marcas de escala vivem na
 * margem entre o círculo visível e essa borda):
 * - `d = r/6`, `faceR = r-d-1` (raio do círculo visível, `fi/2` no real).
 * - Arco de `spanDeg`/`startDeg`: SEM wrapping (padrão) = 300° a partir de 240°; COM wrapping
 *   (osciloscópio/analisador lógico, `QDial::wrapping()=true` real) = 360° a partir de 270°.
 * - `ângulo(ratio) = ratio*spanDeg - startDeg` -- MESMA fórmula pras marcas (`ratio=i/tickCount`,
 *   `Dialed::` real via `painter.rotate(-startAngle)` seguido de `N` rotações de `spanAngle/ticks`
 *   cada) E pro nub de valor (`ratio = QDial::value()/QDial::maximum()` real) -- nunca duas
 *   fórmulas separadas por engano (bug corrigido 2026-07-09: a versão anterior usava só
 *   `startDeg + spanDeg*i/n`, SEM o sinal negativo de `painter.rotate(-startAngle)` -- marcas
 *   ficavam ~120° fora de posição real, e o nub tinha uma fórmula totalmente diferente/decorativa,
 *   sempre travado no meio do curso).
 * - Marcas: contagem real = `maximum/singleStep` (`QDial` padrão do SimulIDE: 1000/25=40),
 *   limitada a espaçamento mínimo de 4px ao longo da circunferência (`(fi*PI)/ticks &gt;= 4`,
 *   senão vira faixa preta ilegível em tamanho pequeno) e sempre PAR. Marca 0 (referência fixa de
 *   zero, não o valor atual) é VERMELHA e um pouco mais LONGA (`r-3` até `r+1`, poking pra fora do
 *   anel); as demais são cinza `rgb(110,110,110)`, `r-3` até `r` (rente ao anel) -- mesma
 *   stroke-width 1 nas duas, só o comprimento difere.
 * - Anel externo: stroke `#464646` em `faceR`. Círculo interno (a "cara" do botão): stroke branco +
 *   preenchimento gradiente radial quase-branco, centro DESLOCADO pro canto superior-esquerdo
 *   (`QRadialGradient(QPoint(dx,dy), fi)` real -- luz vindo de cima-esquerda, não centrado) com
 *   paradas `0%→#fff, 80%→#e6e6e1, 83%→#dcdcd7, 100%→#c8c8c3`.
 * - Nub de valor: halo (stroke `rgb(240,240,230)`, sem preenchimento, raio `knobRadius+0.5`) +
 *   corpo (preenchimento `rgb(210,210,200)`, stroke `rgb(70,70,70)`, raio `knobRadius=faceR/6`),
 *   a `faceR-knobRadius*2.5` do centro. `ratio` ausente = sem nub (caso puramente decorativo, sem
 *   valor pra refletir).
 *
 * `wrapping` é o único parâmetro que decide qual dos DOIS MODELOS DE VALOR reais este knob
 * representa (achado 2026-07-09, pedido explícito do usuário -- ver `makeKnobRow` em `main.ts` pro
 * consumidor real do modo contínuo):
 * - **Limitado, uma volta** (`wrapping: false`/ausente -- `Dial`, `Potentiometer`,
 *   `VarResBase`/`VarInductor`/`VarCapacitor` reais): `QDial` interno SEMPRE 0-1000, `ratio =
 *   value/maximum` mapeia DIRETO pro arco de 300°, valor tem min/max reais e fica preso neles
 *   (`Dialed::setMinVal/setMaxVal`) -- o nub tem uma posição ABSOLUTA que representa o valor atual.
 * - **Contínuo, múltiplas voltas** (`wrapping: true` -- osciloscópio/analisador lógico, `QDial`
 *   nativo `wrapping=true` de `oscwidget.ui`/`lawidget.ui`): o `QDial` gira INDEFINIDAMENTE (0→999→
 *   0→999→... sem parar), e SimulIDE real NUNCA lê a posição absoluta como o valor -- só compara
 *   contra a posição anterior pra saber a DIREÇÃO, e aplica um passo relativo (~1% do valor atual)
 *   nessa direção (`OscWidget::on_timeDivDial_valueChanged`). Não existe "ratio = value/maximum"
 *   aqui porque não existe posição absoluta que corresponda ao valor (µs↔s não caberia numa volta
 *   só) -- o valor real não tem min/max nenhum, cresce/encolhe sem limite a cada volta completa do
 *   knob. O nub AINDA gira (`ratio` continua controlando SÓ a posição visual do nub, não o valor),
 *   só que a posição é arbitrária/cosmética (ver `knobDialPositions`, `main.ts`), nunca lida de volta
 *   como "o valor é X". */
export function dialKnobSvg(cx: number, cy: number, r: number, options?: { ratio?: number; wrapping?: boolean; tickCount?: number; idSeed?: string }): string {
  const wrapping = options?.wrapping === true;
  const d = r / 6;
  const faceR = r - d - 1;
  const knobRadius = faceR / 6;
  const spanDeg = wrapping ? 360 : 300;
  const startDeg = wrapping ? 270 : 240;
  const angleDegFor = (ratio: number) => ratio * spanDeg - startDeg;

  const spacingCap = Math.floor((faceR * 2 * Math.PI) / 4);
  let tickCount = Math.min(options?.tickCount ?? 40, spacingCap);
  if (tickCount % 2 !== 0) tickCount -= 1;
  tickCount = Math.max(2, tickCount);

  let ticks = "";
  for (let i = 0; i <= tickCount; i++) {
    const rad = (angleDegFor(i / tickCount) * Math.PI) / 180;
    const cosA = Math.cos(rad);
    const sinA = Math.sin(rad);
    const isZeroRef = i === 0;
    const innerR = r - 3;
    const outerR = isZeroRef ? r + 1 : r;
    ticks +=
      `<line x1="${(cx + cosA * innerR).toFixed(1)}" y1="${(cy + sinA * innerR).toFixed(1)}" ` +
      `x2="${(cx + cosA * outerR).toFixed(1)}" y2="${(cy + sinA * outerR).toFixed(1)}" ` +
      `stroke="${isZeroRef ? "#ff0000" : "#6e6e6e"}" stroke-width="1"/>`;
  }

  const gradId = `dial-grad-${options?.idSeed ?? `${Math.round(cx)}-${Math.round(cy)}-${Math.round(r)}`}`;
  const gradCx = cx - faceR;
  const gradCy = cy - faceR;

  let nub = "";
  if (options?.ratio !== undefined) {
    const rad = (angleDegFor(Math.min(1, Math.max(0, options.ratio))) * Math.PI) / 180;
    const nubDist = faceR - knobRadius * 2.5;
    const nubX = cx + Math.cos(rad) * nubDist;
    const nubY = cy + Math.sin(rad) * nubDist;
    nub =
      `<circle cx="${nubX.toFixed(1)}" cy="${nubY.toFixed(1)}" r="${(knobRadius + 0.5).toFixed(1)}" fill="none" stroke="rgb(240,240,230)" stroke-width="1"/>` +
      `<circle cx="${nubX.toFixed(1)}" cy="${nubY.toFixed(1)}" r="${knobRadius.toFixed(1)}" fill="rgb(210,210,200)" stroke="rgb(70,70,70)" stroke-width="1"/>`;
  }

  return (
    `<defs><radialGradient id="${gradId}" cx="${gradCx}" cy="${gradCy}" r="${(faceR * 2).toFixed(1)}" gradientUnits="userSpaceOnUse">` +
    `<stop offset="0%" stop-color="#ffffff"/><stop offset="80%" stop-color="#e6e6e1"/><stop offset="83%" stop-color="#dcdcd7"/><stop offset="100%" stop-color="#c8c8c3"/></radialGradient></defs>` +
    ticks +
    `<circle cx="${cx}" cy="${cy}" r="${faceR.toFixed(1)}" fill="none" stroke="#464646" stroke-width="1"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${(faceR - 1).toFixed(1)}" fill="url(#${gradId})" stroke="#ffffff" stroke-width="1"/>` +
    nub
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
  const packageMarkup = packageSymbolSvg(typeId, properties);
  if (packageMarkup) return packageMarkup;

  const box = componentBox(typeId, properties);
  const yMid = box.height / 2;
  const compactTwoPin = box.width <= 40 && box.height <= 32;
  const x1 = compactTwoPin ? 5 : LEAD_MARGIN;
  const x2 = compactTwoPin ? box.width - 5 : box.width - LEAD_MARGIN;
  const midX = box.width / 2;

  switch (typeId) {
    case TUNNEL_TYPE_ID:
      return builtinPaintSvg(tunnelPaintSpec(properties), box, properties);

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

    case "graphics.image": {
      // image.cpp real sempre desenha a imagem carregada (`drawPixmap`) escalada pro corpo.
      // `properties.imageData`/`imageMime` (base64, resolvido do `path` pelo host -- mesmo padrão de
      // `packageSanitizers.ts::sanitizePackageBackground`, ver `extension.ts`) é a imagem de verdade;
      // sem isso (arquivo ainda não escolhido, ou `path` que não resolveu), cai no glifo decorativo
      // "foto" de sempre -- nunca quebra uma cena com `graphics.image` antigo sem esses campos.
      const w = box.width, h = box.height;
      const imageData = typeof properties?.imageData === "string" ? properties.imageData : undefined;
      if (imageData) {
        const mime = typeof properties?.imageMime === "string" && properties.imageMime.trim() ? properties.imageMime : "image/png";
        return `<image x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" href="data:${mime};base64,${imageData}"/>`;
      }
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
      const isLinkedPinLabel = typeof properties?.linkedPinComponentId === "string" && properties.linkedPinComponentId.trim().length > 0;
      if (isLinkedPinLabel) {
        // Label de pino do `other.package_pin` (autorias de símbolo/subcircuito) é equivalente ao
        // `Pin::m_label` do SimulIDE: somente texto, sem placa amarela de fundo.
        return `<text x="${midX}" y="${yMid + fontSize / 3}" text-anchor="middle" font-size="${fontSize}" fill="${color}">${escapeXmlText(text)}</text>`;
      }
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
      // SEM texto aqui -- o rótulo é definido pelos dados do package (`labelX`/`labelY`) e renderizado
      // separadamente, igual ao SimulIDE real.
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
      // dial.cpp: o knob de verdade É `CustomDial` (gui/customdial.cpp), o widget PRÓPRIO do
      // SimulIDE reaproveitado por `Dialed` em vários dispositivos (ver docstring de
      // `dialKnobSvg`) -- plenamente reproduzível em SVG, ao contrário do que um comentário
      // anterior aqui afirmava. `ratio: 0.5` replica o valor padrão real do `QDial` recém-criado
      // (`setValue(500)` sobre um range 0-1000, `CustomDial::CustomDial`) -- sem `properties`
      // modeladas ainda pra este typeId (catálogo não declara min/max/valor), não há estado real
      // pra refletir além disso.
      return dialKnobSvg(midX, yMid, Math.min(midX, yMid) - 2, { ratio: 0.5 });

    case "subcircuits.external":
      // Bloco genérico "aponta pra .lssubcircuit por caminho" (ver `chooseSubcircuitFileCommand`,
      // `extension.ts`) ANTES de qualquer arquivo ser vinculado -- catálogo não declara `package`
      // nem pinos (`pinCount:0`) pra este estado, então SEM este case cairia no `default:` abaixo
      // (leads + corpo fino), com silhueta de componente de 2 pinos indistinguível de um resistor
      // sem zigzag. Retângulo neutro de tamanho médio, sem leads (não há pino nenhum ainda) --
      // uma vez vinculado a um arquivo real, o `typeId` da instância muda pro do subcircuito
      // (`parsed.typeId`) e este case nunca mais é usado pra ela.
      return `<rect x="2" y="2" width="${box.width - 4}" height="${box.height - 4}" rx="4" class="symbol-stroke" fill="none"/>`;

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

    default:
      return horizontalLeads(box, yMid) + `<rect x="${x1}" y="${yMid - 10}" width="${x2 - x1}" height="20" class="symbol-stroke" fill="none"/>`;
  }
}

/** Bloco genérico de subcircuito por caminho (`subcircuitRef`) quando o arquivo `.lssubcircuit`
 * referenciado não é encontrado (projeto reaberto num caminho movido/apagado) -- visual
 * deliberadamente DIFERENTE do fallback genérico de `componentSymbolSvg` (retângulo neutro sem
 * aviso nenhum): borda tracejada + "?" bem visível, pra comunicar "isto está quebrado, precisa
 * relocalizar o arquivo" (menu de contexto/propriedade "Localizar arquivo...", ver `main.ts`).
 * Terminais de pino são desenhados à parte pelo loop de pinos de sempre (posição genérica, já
 * funciona pra qualquer contagem sem `package`) -- este helper só desenha o corpo. */
export function missingSubcircuitPlaceholderSvg(box: { width: number; height: number }): string {
  return (
    `<rect x="1" y="1" width="${Math.max(box.width - 2, 1)}" height="${Math.max(box.height - 2, 1)}" rx="3" ` +
    `fill="none" stroke="#d9534f" stroke-width="1.5" stroke-dasharray="4 3"/>` +
    `<text x="${box.width / 2}" y="${box.height / 2 + 5}" text-anchor="middle" font-size="16" fill="#d9534f">?</text>`
  );
}
