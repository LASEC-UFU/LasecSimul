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

import { PackageDescriptor, PackagePin, PackageShape, SIMULIDE_PACKAGE_GRID_UNIT } from "./model.js";

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
    const rad = (pin.angle * Math.PI) / 180;
    const tipX = pin.x + Math.cos(rad) * pin.length;
    const tipY = pin.y + Math.sin(rad) * pin.length;
    minX = Math.min(minX, tipX, pin.x);
    maxX = Math.max(maxX, tipX, pin.x);
    minY = Math.min(minY, tipY, pin.y);
    maxY = Math.max(maxY, tipY, pin.y);
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

/** Corpo do símbolo a partir do `package` real, se este typeId tiver um registrado -- `undefined`
 * pra `main.ts` cair em `catalogEntry?.symbolSvg ?? componentSymbolSvg(typeId)` (mesma prioridade
 * de sempre, só com `package` real entrando ANTES de symbolSvg). */
export function packageSymbolSvg(typeId: string, properties?: Record<string, unknown>): string | undefined {
  const resolved = resolvedPackageFor(typeId, properties);
  return resolved ? packageBodySvg(resolved) : undefined;
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

function packageShapeSvg(shape: PackageShape): string {
  const cls = shape.cssClass ? ` class="${shape.cssClass}"` : "";
  switch (shape.kind) {
    case "rect":
      return `<rect${cls} x="${shape.x ?? 0}" y="${shape.y ?? 0}" width="${shape.w ?? 0}" height="${shape.h ?? 0}"${shape.rx !== undefined ? ` rx="${shape.rx}"` : ""}${shape.ry !== undefined ? ` ry="${shape.ry}"` : ""} stroke="${shape.stroke ?? "currentColor"}" fill="${shape.fill ?? "none"}" stroke-width="${shape.strokeWidth ?? 1}"/>`;
    case "line":
      return `<line${cls} x1="${shape.x1 ?? 0}" y1="${shape.y1 ?? 0}" x2="${shape.x2 ?? 0}" y2="${shape.y2 ?? 0}" stroke="${shape.stroke ?? "currentColor"}"/>`;
    case "ellipse":
      return `<ellipse${cls} cx="${shape.cx ?? 0}" cy="${shape.cy ?? 0}" rx="${shape.rx ?? 0}" ry="${shape.ry ?? 0}" stroke="${shape.stroke ?? "currentColor"}" fill="${shape.fill ?? "none"}" stroke-width="${shape.strokeWidth ?? 1}"/>`;
    case "svg":
      return shape.value ?? "";
    case "polygon": {
      const pts = (shape.points ?? []).map(p => `${p.x},${p.y}`).join(" ");
      return `<polygon${cls} points="${pts}" stroke="${shape.stroke ?? "currentColor"}" fill="${shape.fill ?? "none"}" stroke-width="${shape.strokeWidth ?? 1}"/>`;
    }
    case "text":
    default:
      return `<text${cls} x="${shape.x ?? 0}" y="${shape.y ?? 0}" text-anchor="middle" font-size="${shape.fontSize ?? 11}" fill="${shape.color ?? "currentColor"}">${escapeXmlText(shape.value ?? "")}</text>`;
  }
}

/** Lead (corpo -> ponta real) + rótulo, em coordenadas ORIGINAIS do package (sem o deslocamento de
 * `resolvePackageLayout` -- quem chama envolve isto num `<g transform="translate(offsetX,offsetY)">`,
 * ver `packageBodySvg`). O círculo do terminal em si (onde o clique conecta fio) é desenhado por
 * quem chama (`main.ts::renderComponent`), na posição JÁ deslocada devolvida por `pinLocalPosition`. */
function packagePinLeadSvg(pin: PackagePin, resolved: ResolvedPackage, labelColor = "currentColor"): string {
  const rad = (pin.angle * Math.PI) / 180;
  const tipNativeX = pin.x + Math.cos(rad) * pin.length;
  const tipNativeY = pin.y + Math.sin(rad) * pin.length;
  const label = pin.label ?? pin.id;
  const hasCustomLabelPos = pin.labelX !== undefined && pin.labelY !== undefined;
  const labelNativeX = pin.labelX ?? tipNativeX + Math.cos(rad) * 9;
  const labelNativeY = pin.labelY ?? tipNativeY + Math.sin(rad) * 9;
  const toDisplayX = (value: number): number => (value + resolved.offsetX) * resolved.scaleX;
  const toDisplayY = (value: number): number => (value + resolved.offsetY) * resolved.scaleY;
  const x = toDisplayX(pin.x);
  const y = toDisplayY(pin.y);
  const tipX = toDisplayX(tipNativeX);
  const tipY = toDisplayY(tipNativeY);
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
  const fillAttr = labelColor === "currentColor" ? ` class="symbol-text"` : ` fill="${labelColor}"`;
  return (
    `<line x1="${x.toFixed(1)}" y1="${y.toFixed(1)}" x2="${tipX.toFixed(1)}" y2="${tipY.toFixed(1)}" class="symbol-stroke"/>` +
    `<text x="${labelX.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle"${fillAttr} style="font-size:${PACKAGE_PIN_LABEL_FONT_SIZE}px"${rotateAttr}>${escapeXmlText(label)}</text>`
  );
}

/** Corpo completo de um typeId com `package`: fundo + formas declarativas + lead/rótulo de cada
 * pino, tudo num único `<g>` deslocado pro espaço sem coordenada negativa que `componentBox` usa
 * pro `viewBox` (ver `resolvePackageLayout`). */
function packageBodySvg(resolved: ResolvedPackage): string {
  const pkg = resolved.source;
  let markup = "";
  if (pkg.background?.kind === "color" && pkg.background.value) {
    markup += `<rect x="0" y="0" width="${pkg.width}" height="${pkg.height}" fill="${pkg.background.value}"/>`;
  } else if (pkg.background?.kind === "image" && pkg.background.data) {
    // `data` é o PNG/JPEG em base64 puro (sem prefixo `data:`) -- mesma convenção de
    // `BckGndData` do SimulIDE real (foto da placa real embutida no próprio arquivo, sem
    // depender de um asset externo que possa ficar pendente). `preserveAspectRatio="none"`
    // porque width/height do package JÁ são as dimensões nativas da imagem (1:1, sem distorção).
    markup += `<image x="0" y="0" width="${pkg.width}" height="${pkg.height}" preserveAspectRatio="none" href="data:image/png;base64,${pkg.background.data}"/>`;
  }
  if (pkg.border) {
    markup += `<rect x="0.5" y="0.5" width="${Math.max(0, pkg.width - 1)}" height="${Math.max(0, pkg.height - 1)}" class="symbol-stroke" fill="none"/>`;
  }
  for (const shape of pkg.shapes ?? []) markup += packageShapeSvg(shape);
  const bodyMarkup =
    `<g transform="translate(${(resolved.offsetX * resolved.scaleX).toFixed(3)},${(resolved.offsetY * resolved.scaleY).toFixed(3)})">` +
    `<g transform="scale(${resolved.scaleX.toFixed(6)},${resolved.scaleY.toFixed(6)})">${markup}</g>` +
    `</g>`;
  const pinLabelColor = pkg.pinLabelColor ?? "currentColor";
  const pinsMarkup = pkg.pins.map((pin) => packagePinLeadSvg(pin, resolved, pinLabelColor)).join("");
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
    case "connectors.bus": return { width: 76, height: 28 };
    case "connectors.tunnel": return { width: 44, height: 16 };
    case "connectors.socket": return { width: 32, height: 64 };
    case "connectors.header": return { width: 64, height: 16 };

    case "graphics.image": return { width: 96, height: 64 };
    case "graphics.text": return { width: 74, height: 28 };
    case "graphics.rectangle": return { width: 96, height: 58 };
    case "graphics.ellipse": return { width: 96, height: 58 };
    case "graphics.line": return { width: 86, height: 32 };
    case "other.package": return { width: 84, height: 66 };
    case "other.package_pin": return { width: 24, height: 24 };
    case "other.test_unit": return { width: 72, height: 56 };
    case "other.dial": return { width: 56, height: 56 };
    case "other.ground": return { width: 16, height: 18 }; // sources/ground.cpp

    case "passive.resistor": return COMP2PIN_BOX; // comp2pin.cpp
    case "passive.variable_resistor": return { width: 40, height: 24 };
    case "passive.resistor_dip": return { width: 32, height: 68 };
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
    case "switches.switch_dip": return { width: 32, height: 64 };
    case "switches.relay": return { width: 48, height: 48 };
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
    case "active.analog_mux": return { width: 48, height: 88 };
    case "active.volt_regulator": return { width: 32, height: 24 };

    case "outputs.led": return { width: 40, height: 24 };
    case "outputs.led_rgb": return { width: 32, height: 24 };
    case "outputs.led_bar": return { width: 32, height: 64 };
    case "outputs.led_matrix": return { width: 72, height: 72 };
    case "outputs.max72xx_matrix": return { width: 264, height: 88 }; // outputs/leds/max72xx_matrix.cpp
    case "outputs.ws2812": return { width: 24, height: 24 };
    case "outputs.seven_segment": return { width: 60, height: 60 }; // outputs/leds/sevensegment.cpp
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
    case "sources.fixed_volt": return { width: 48, height: 24 };
    case "sources.clock": return { width: 30, height: 16 };
    case "sources.wave_gen": return { width: 48, height: 40 };
    case "sources.voltage_source": return { width: 44, height: 32 }; // sources/voltsource.cpp
    case "sources.current_source": return { width: 44, height: 32 }; // sources/currsource.cpp
    case "sources.controlled_source": return { width: 48, height: 40 };
    case "sources.battery": return COMP2PIN_BOX;
    case "sources.rail": return { width: 24, height: 16 };

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
  return resolved.pins.some((candidate) => candidate.id === pinId);
}

export function pinLocalPosition(pinId: string, pinIndex: number, pinCount: number, typeId: string, properties?: Record<string, unknown>): { x: number; y: number } {
  const resolved = resolvedPackageFor(typeId, properties);
  if (resolved) {
    const pin = resolved.pins.find((candidate) => candidate.id === pinId);
    if (pin) return { x: pin.tipX, y: pin.tipY };
  }
  if (typeId === "connectors.junction") return { x: 0, y: 0 };
  const box = componentBox(typeId, properties);
  if (typeId === "connectors.tunnel" && pinCount <= 1) {
    return { x: box.width - 8, y: box.height / 2 };
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
      if (pinIndex === 1) return { x: 32, y: 8 };
      if (pinIndex === 2) return { x: 16, y: 24 };
      break;
    case "sources.voltage_source":
    case "sources.current_source":
      if (pinCount <= 1) return { x: box.width, y: box.height / 2 };
      break;
    case "sources.controlled_source":
      if (pinIndex === 0) return { x: 0, y: 12 };
      if (pinIndex === 1) return { x: 0, y: 28 };
      if (pinIndex === 2) return { x: 24, y: 0 };
      if (pinIndex === 3) return { x: 24, y: 40 };
      break;
  }
  if ((typeId === "switches.push" || typeId === "switches.switch") && pinCount <= 2) {
    return { x: pinIndex % 2 === 0 ? 0 : box.width, y: 8 };
  }
  if (typeId === "sources.fixed_volt" && pinCount <= 1) {
    return { x: box.width, y: box.height / 2 };
  }
  if (typeId === "sources.rail" && pinCount <= 1) {
    return { x: box.width, y: box.height / 2 };
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

  const diodeBody = (extra = ""): string =>
    horizontalLeads(box, yMid) +
    `<path d="M ${midX - 9} ${yMid - 12} L ${midX - 9} ${yMid + 12} L ${midX + 8} ${yMid} Z" class="symbol-stroke" fill="none"/>` +
    `<line x1="${midX + 10}" y1="${yMid - 13}" x2="${midX + 10}" y2="${yMid + 13}" class="symbol-stroke symbol-stroke--thick"/>` +
    extra;

  switch (typeId) {
    case "passive.resistor":
    case "passive.variable_resistor":
    case "passive.ldr":
    case "passive.thermistor":
    case "passive.rtd":
    case "passive.force_strain_gauge": {
      const amplitude = box.height / 2 - 5;
      const mark =
        typeId === "passive.variable_resistor"
          ? `<line x1="${midX - 12}" y1="${yMid + 14}" x2="${midX + 12}" y2="${yMid - 14}" class="symbol-stroke symbol-stroke--accent"/>`
          : typeId !== "passive.resistor"
            ? `<text x="${midX}" y="${yMid - 11}" text-anchor="middle" class="symbol-text">${(typeId.split(".")[1] ?? "").slice(0, 3).toUpperCase()}</text>`
            : "";
      return horizontalLeads(box, yMid) + `<path d="${zigzagPath(x1, x2, yMid, amplitude, 3)}" class="symbol-stroke"/>` + mark;
    }

    case "passive.resistor_dip":
      return labelBox("DIP-R");

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
      const plateHalfLength = box.height / 2 - 6;
      return (
        horizontalLeads(box, yMid) +
        `<line x1="${x1}" y1="${yMid}" x2="${midX - 5}" y2="${yMid}" class="symbol-stroke"/>` +
        `<line x1="${midX + 5}" y1="${yMid}" x2="${x2}" y2="${yMid}" class="symbol-stroke"/>` +
        `<line x1="${midX - 5}" y1="${yMid - plateHalfLength}" x2="${midX - 5}" y2="${yMid + plateHalfLength}" class="symbol-stroke symbol-stroke--thick"/>` +
        `<line x1="${midX + 5}" y1="${yMid - plateHalfLength}" x2="${midX + 5}" y2="${yMid + plateHalfLength}" class="symbol-stroke symbol-stroke--thick"/>`
      );
    }

    case "passive.electrolytic_capacitor":
      return (
        componentSymbolSvg("passive.capacitor") +
        `<text x="${midX - 15}" y="${yMid - 12}" text-anchor="middle" class="symbol-text">+</text>`
      );

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
      return (
        `<line x1="8" y1="0" x2="8" y2="8" class="symbol-stroke"/>` +
        `<line x1="1.4" y1="8" x2="14.6" y2="8" class="symbol-stroke"/>` +
        `<line x1="3.7" y1="12" x2="12.3" y2="12" class="symbol-stroke"/>` +
        `<line x1="6.1" y1="16" x2="9.9" y2="16" class="symbol-stroke"/>`
      );

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

    case "connectors.bus":
      return (
        `<line x1="12" y1="${yMid}" x2="${box.width - 12}" y2="${yMid}" class="symbol-stroke symbol-stroke--thick"/>` +
        Array.from({ length: 6 }, (_, index) => {
          const x = 18 + index * 8;
          return `<line x1="${x}" y1="${yMid - 5}" x2="${x}" y2="${yMid + 5}" class="symbol-stroke"/>`;
        }).join("")
      );

    case "connectors.socket":
      return (
        `<rect x="18" y="8" width="${box.width - 36}" height="${box.height - 16}" rx="2" class="symbol-stroke" fill="none"/>` +
        Array.from({ length: 6 }, (_, index) => `<circle cx="${midX}" cy="${18 + index * 10}" r="2" class="symbol-stroke" fill="none"/>`).join("")
      );

    case "connectors.header":
      return (
        `<line x1="12" y1="${yMid}" x2="${box.width - 12}" y2="${yMid}" class="symbol-stroke symbol-stroke--thick"/>` +
        Array.from({ length: 6 }, (_, index) => {
          const x = 18 + index * 8;
          return `<line x1="${x}" y1="${yMid - 8}" x2="${x}" y2="${yMid + 8}" class="symbol-stroke"/>`;
        }).join("")
      );

    case "graphics.image":
      return (
        `<rect x="4" y="4" width="${box.width - 8}" height="${box.height - 8}" class="symbol-stroke" fill="none"/>` +
        `<circle cx="24" cy="20" r="5" class="symbol-stroke" fill="none"/>` +
        `<path d="M 8 ${box.height - 10} L 34 34 L 48 46 L 62 28 L ${box.width - 8} ${box.height - 10}" class="symbol-stroke" fill="none"/>`
      );

    case "graphics.text": {
      // Sem `properties` (paleta/preview) cai no placeholder de sempre; com `properties`, desenha o
      // texto/cor/tamanho reais -- mesmo princípio property-driven do resto deste `case`, ver
      // `propertyDrivenBox`.
      const text = typeof properties?.text === "string" ? properties.text : "Texto";
      const fontSize = typeof properties?.fontSize === "number" ? properties.fontSize : 11;
      const color = typeof properties?.color === "string" ? properties.color : "currentColor";
      return `<text x="${midX}" y="${yMid + fontSize / 3}" text-anchor="middle" font-size="${fontSize}" fill="${color}">${escapeXmlText(text)}</text>`;
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
      return (
        `<rect x="10" y="8" width="${box.width - 20}" height="${box.height - 16}" rx="2" class="symbol-stroke" fill="none"/>` +
        `<path d="M 20 ${yMid} L 30 ${yMid + 10} L 50 ${yMid - 10}" class="symbol-stroke symbol-stroke--accent" fill="none"/>` +
        `<line x1="16" y1="16" x2="22" y2="16" class="symbol-stroke"/>` +
        `<line x1="${box.width - 22}" y1="${box.height - 16}" x2="${box.width - 16}" y2="${box.height - 16}" class="symbol-stroke"/>`
      );

    case "other.dial":
      return (
        `<circle cx="${midX}" cy="${yMid}" r="22" class="symbol-stroke" fill="none"/>` +
        `<circle cx="${midX}" cy="${yMid}" r="12" class="symbol-stroke" fill="none"/>` +
        `<line x1="${midX}" y1="${yMid}" x2="${midX + 8}" y2="${yMid - 12}" class="symbol-stroke symbol-stroke--thick"/>`
      );

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

    case "switches.relay":
      return (
        `<rect x="12" y="10" width="24" height="20" class="symbol-stroke" fill="none"/>` +
        `<line x1="${PIN_INSET}" y1="20" x2="12" y2="20" class="symbol-stroke"/>` +
        `<line x1="36" y1="20" x2="${midX - 2}" y2="20" class="symbol-stroke"/>` +
        `<line x1="${midX + 4}" y1="${box.height - 18}" x2="${box.width - PIN_INSET}" y2="${box.height - 18}" class="symbol-stroke"/>` +
        `<line x1="${midX + 4}" y1="${box.height - 18}" x2="${box.width - 28}" y2="${box.height - 34}" class="symbol-stroke"/>` +
        `<circle cx="${midX + 4}" cy="${box.height - 18}" r="2" class="symbol-stroke" fill="currentColor"/>` +
        `<circle cx="${box.width - 28}" cy="${box.height - 18}" r="2" class="symbol-stroke" fill="currentColor"/>`
      );

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
    case "outputs.led":
      return diodeBody(
        typeId === "active.zener"
          ? `<path d="M ${midX + 10} ${yMid - 13} l 5 -5 M ${midX + 10} ${yMid + 13} l -5 5" class="symbol-stroke"/>`
          : typeId === "outputs.led"
            ? `<path d="M ${midX + 16} ${yMid - 14} l 8 -8 M ${midX + 20} ${yMid - 6} l 8 -8" class="symbol-stroke symbol-stroke--accent"/>`
            : ""
      );

    case "active.bjt":
    case "active.mosfet":
    case "active.jfet":
      return (
        `<circle cx="${midX}" cy="${yMid}" r="18" class="symbol-stroke" fill="none"/>` +
        `<line x1="${PIN_INSET}" y1="${yMid}" x2="${midX - 12}" y2="${yMid}" class="symbol-stroke"/>` +
        `<line x1="${midX}" y1="${yMid - 16}" x2="${box.width - PIN_INSET}" y2="${PIN_INSET}" class="symbol-stroke"/>` +
        `<line x1="${midX}" y1="${yMid + 16}" x2="${box.width - PIN_INSET}" y2="${box.height - PIN_INSET}" class="symbol-stroke"/>` +
        `<line x1="${midX - 12}" y1="${yMid - 16}" x2="${midX - 12}" y2="${yMid + 16}" class="symbol-stroke"/>`
      );

    case "active.opamp":
    case "active.comparator":
      return (
        `<path d="M 24 12 L 24 ${box.height - 12} L ${box.width - 16} ${yMid} Z" class="symbol-stroke" fill="none"/>` +
        `<line x1="${PIN_INSET}" y1="${box.height * 0.35}" x2="24" y2="${box.height * 0.35}" class="symbol-stroke"/>` +
        `<line x1="${PIN_INSET}" y1="${box.height * 0.65}" x2="24" y2="${box.height * 0.65}" class="symbol-stroke"/>` +
        `<line x1="${box.width - 16}" y1="${yMid}" x2="${box.width - PIN_INSET}" y2="${yMid}" class="symbol-stroke"/>` +
        `<text x="18" y="${box.height * 0.36 + 4}" text-anchor="middle" class="symbol-text">+</text>` +
        `<text x="18" y="${box.height * 0.66 + 4}" text-anchor="middle" class="symbol-text">-</text>`
      );

    case "active.analog_mux":
      return labelBox("MUX");

    case "active.volt_regulator":
      return labelBox("REG");

    case "outputs.led_rgb":
      return labelBox("RGB");
    case "outputs.led_bar":
      return labelBox("LED BAR");
    case "outputs.led_matrix":
    case "outputs.max72xx_matrix":
    case "outputs.ws2812":
      return labelBox("MATRIX");
    case "outputs.seven_segment":
      return labelBox("7SEG");
    case "outputs.dc_motor":
      return labelBox("M");
    case "outputs.stepper":
      return labelBox("STEP");
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
      const showVolt = properties?.showVolt !== false;
      return (
        `<line x1="0" y1="8" x2="10" y2="8" class="symbol-stroke"/>` +
        `<ellipse cx="20" cy="8" rx="8" ry="8" class="symbol-stroke" fill="none"/>` +
        (showVolt ? `<text x="32" y="6" class="probe-voltage-label">${escapeXmlText(formatRailVoltage(symbolReadoutNumber(properties) ?? 0))} V</text>` : "")
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
    case "sources.fixed_volt": {
      return (
        `<rect x="0" y="4" width="16" height="16" rx="2" class="fixed-volt-button" fill="#dddddd" stroke="#777777" stroke-width="1.5"/>` +
        `<rect x="24" y="4" width="16" height="16" rx="2" class="fixed-volt-body toggle-hit-zone" fill="#dddddd" stroke="#777777" stroke-width="1.5"/>` +
        `<rect x="40" y="9" width="8" height="6" rx="3" class="fixed-volt-terminal" fill="currentColor"/>`
      );
    }

    case "sources.clock":
      // Pulso quadrado -- mesma sequência exata de drawLine do Clock::paint original.
      return (
        `<path d="M ${midX - 11} ${yMid + 3} L ${midX - 11} ${yMid - 3} L ${midX - 5} ${yMid - 3} L ${midX - 5} ${yMid + 3} ` +
        `L ${midX + 1} ${yMid + 3} L ${midX + 1} ${yMid - 3} L ${midX + 4} ${yMid - 3}" class="symbol-stroke" fill="none"/>`
      );

    case "sources.wave_gen":
      return (
        `<rect x="4" y="4" width="${box.width - 8}" height="${box.height - 8}" rx="2" class="symbol-stroke" fill="none"/>` +
        `<path d="M 10 ${yMid} Q ${midX - 8} ${yMid - 12}, ${midX} ${yMid} T ${box.width - 10} ${yMid}" class="symbol-stroke symbol-stroke--accent" fill="none"/>`
      );

    case "sources.voltage_source":
      return (
        horizontalLeads(box, yMid) +
        `<line x1="${x1}" y1="${yMid}" x2="${midX - 14}" y2="${yMid}" class="symbol-stroke"/>` +
        `<line x1="${midX + 14}" y1="${yMid}" x2="${x2}" y2="${yMid}" class="symbol-stroke"/>` +
        `<circle cx="${midX}" cy="${yMid}" r="14" class="symbol-stroke" fill="none"/>` +
        `<text x="${midX}" y="${yMid + 5}" text-anchor="middle" class="symbol-text">V</text>` +
        `<line x1="${midX - 7}" y1="${yMid - 11}" x2="${midX + 7}" y2="${yMid - 11}" class="symbol-stroke symbol-stroke--accent"/>`
      );

    case "sources.current_source":
      return (
        horizontalLeads(box, yMid) +
        `<line x1="${x1}" y1="${yMid}" x2="${midX - 14}" y2="${yMid}" class="symbol-stroke"/>` +
        `<line x1="${midX + 14}" y1="${yMid}" x2="${x2}" y2="${yMid}" class="symbol-stroke"/>` +
        `<circle cx="${midX}" cy="${yMid}" r="14" class="symbol-stroke" fill="none"/>` +
        `<line x1="${midX}" y1="${yMid + 8}" x2="${midX}" y2="${yMid - 8}" class="symbol-stroke symbol-stroke--accent"/>` +
        `<path d="M ${midX - 4} ${yMid - 4} L ${midX} ${yMid - 8} L ${midX + 4} ${yMid - 4}" class="symbol-stroke symbol-stroke--accent" fill="none"/>`
      );

    case "sources.controlled_source": {
      // Diamante (Csource::paint do original, modo "control pins": polígono de 4 pontos) com seta
      // de corrente -- mesma lógica de m_currSource do original.
      const cx = box.width / 2;
      const cy = box.height / 2;
      return (
        `<path d="M ${cx - 16} ${cy} L ${cx} ${cy - 26} L ${cx + 16} ${cy} L ${cx} ${cy + 26} Z" class="symbol-stroke" fill="none"/>` +
        `<line x1="${cx}" y1="${cy - 10}" x2="${cx}" y2="${cy + 10}" class="symbol-stroke symbol-stroke--accent"/>` +
        `<path d="M ${cx - 4} ${cy + 4} L ${cx} ${cy + 10} L ${cx + 4} ${cy + 4}" class="symbol-stroke symbol-stroke--accent" fill="none"/>`
      );
    }

    case "sources.battery":
      // Barras alternadas longa/curta -- mesma sequência exata de drawLine do Battery::paint original.
      return (
        `<line x1="${midX - 7}" y1="${yMid - 8}" x2="${midX - 7}" y2="${yMid + 8}" class="symbol-stroke symbol-stroke--thick"/>` +
        `<line x1="${midX - 2}" y1="${yMid - 3}" x2="${midX - 2}" y2="${yMid + 3}" class="symbol-stroke"/>` +
        `<line x1="${midX + 3}" y1="${yMid - 8}" x2="${midX + 3}" y2="${yMid + 8}" class="symbol-stroke symbol-stroke--thick"/>` +
        `<line x1="${midX + 8}" y1="${yMid - 3}" x2="${midX + 8}" y2="${yMid + 3}" class="symbol-stroke"/>`
      );

    case "sources.rail": {
      const voltage = typeof properties?.voltage === "number" ? properties.voltage : 5.0;
      const label = `${formatRailVoltage(voltage)} V`;
      return (
        `<text x="6" y="6" text-anchor="middle" class="rail-voltage-label">${escapeXmlText(label)}</text>` +
        `<path d="M 6 1.5 L 6 14.5 L 17 9 L 17 7 Z" fill="#ffa500" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>` +
        `<rect x="16" y="5" width="8" height="6" rx="3" fill="currentColor"/>`
      );
    }

    default:
      return horizontalLeads(box, yMid) + `<rect x="${x1}" y="${yMid - 10}" width="${x2 - x1}" height="20" class="symbol-stroke" fill="none"/>`;
  }
}
