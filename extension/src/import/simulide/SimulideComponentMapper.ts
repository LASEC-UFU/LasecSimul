import type { PackagePin, WebviewComponentCatalogEntry } from "../../ui/webview/model";
import type { SimulideComponentRecord } from "./SimulideTypes";

const FALLBACK_TYPE_MAP: Record<string, string> = {
  push: "switches.push",
  switch: "switches.switch",
  switchdip: "switches.switch_dip",
  relay: "switches.relay",
  keypad: "switches.keypad",
  resistor: "passive.resistor",
  varresistor: "passive.variable_resistor",
  potentiometer: "passive.potentiometer",
  resistordip: "passive.resistor_dip",
  capacitor: "passive.capacitor",
  elcapacitor: "passive.electrolytic_capacitor",
  electrolyticcapacitor: "passive.electrolytic_capacitor",
  inductor: "passive.inductor",
  varcapacitor: "passive.variable_capacitor",
  varinductor: "passive.variable_inductor",
  thermistor: "sensors.thermistor",
  diode: "active.diode",
  zener: "active.zener",
  opamp: "active.opamp",
  comparator: "active.comparator",
  muxanalog: "active.analog_mux",
  voltreg: "active.volt_regulator",
  led: "outputs.led",
  ledrgb: "outputs.led_rgb",
  ledbar: "outputs.led_bar",
  ledmatrix: "outputs.led_matrix",
  sevensegment: "outputs.seven_segment",
  dcmotor: "outputs.dc_motor",
  stepper: "outputs.stepper",
  lamp: "outputs.incandescent_lamp",
  aip31068i2c: "outputs.aip31068_i2c",
  pcd8544: "outputs.pcd8544",
  bus: "connectors.bus",
  tunnel: "connectors.tunnel",
  socket: "connectors.socket",
  header: "connectors.header",
  probe: "meters.probe",
  ampmeter: "meters.ampmeter",
  voltimeter: "instruments.voltmeter",
  voltmeter: "instruments.voltmeter",
  freqmeter: "meters.freqmeter",
  oscope: "meters.oscope",
  oscilloscope: "meters.oscope",
  logicanalyzer: "meters.logic_analyzer",
  lanalizer: "meters.logic_analyzer",
  serialterm: "peripherals.serialterm",
  serialterminal: "peripherals.serialterm",
  serialport: "peripherals.serialport",
  dcvoltagesource: "sources.dc_voltage",
  fixedvolt: "sources.fixed_volt",
  fixedvoltage: "sources.fixed_volt",
  clock: "sources.clock",
  wavegen: "sources.wave_gen",
  voltsource: "sources.voltage_source",
  currsource: "sources.current_source",
  csource: "sources.controlled_source",
  battery: "sources.battery",
  rail: "sources.rail",
  ground: "other.ground",

  // Elementos gráficos do SimulIDE.
  textcomponent: "graphics.text",
  text: "graphics.text",
  rectangle: "graphics.rectangle",
  ellipse: "graphics.ellipse",
  line: "graphics.line",
  image: "graphics.image",

  // Lógica digital, memória e conversores -- itemtypes confirmados extraindo as strings do
  // binário real do SimulIDE instalado (simulide.exe, build 2-R260501), cruzando cada nome com o
  // rótulo amigável/categoria/ícone registrados junto (ex.: "And Gate"/AndGate/"Gates"/andgate.png).
  // Não incluímos aqui os poucos devices do catálogo (logic.decoder, logic.encoder,
  // logic.priority_encoder, logic.multiplier, logic.divider, logic.shifter, logic.minmax,
  // logic.absolute, logic.bit_adder, logic.bit_selector, logic.seven_segment_bcd, logic.random,
  // logic.negator) porque NENHUM itemtype correspondente foi encontrado nessa build real -- os
  // "achados" com esses nomes eram ruído (mnemônicos de bytecode, strings do OpenSSL, ou o próprio
  // enum de forma de onda do WaveGen) ou simplesmente não existem nesta versão. Ficam como
  // placeholder até alguém confirmar o nome real com um .sim2 de exemplo.
  andgate: "logic.and_gate",
  orgate: "logic.or_gate",
  xorgate: "logic.xor_gate",
  buffer: "logic.buffer",
  shiftreg: "logic.shift_reg",
  bincounter: "logic.bin_counter",
  demux: "logic.demux",
  dectobcd: "logic.dec_to_bcd",
  bcdtodec: "logic.bcd_to_dec",
  magnitudecomp: "logic.magnitude_comp",
  dynamicmemory: "logic.dynamic_memory",
  latchd: "logic.latch_d",
  i2cram: "logic.i2c_ram",
  lm555: "logic.lm555",
  function: "logic.function",
  counter: "logic.counter",
  adc: "logic.adc",
  dac: "logic.dac",
  mux: "logic.mux",
  memory: "logic.memory",
  flipflopjk: "logic.flipflop_jk",
  flipflopt: "logic.flipflop_t",
  flipfloprs: "logic.flipflop_rs",
  flipflopd: "logic.flipflop_d",
  bcdto7s: "logic.bcd_to_7seg",
  i2ctoparallel: "logic.i2c_to_parallel",

  // Semicondutores discretos e passivos complexos -- mesma verificação binária acima.
  bjt: "active.bjt",
  mosfet: "active.mosfet",
  jfet: "active.jfet",
  scr: "active.scr",
  triac: "active.triac",
  diac: "active.diac",
  transformer: "passive.transformer",

  // Saídas, displays, sensores e periféricos SimulIDE-nativos -- idem.
  audioout: "outputs.audio_out",
  servo: "outputs.servo",
  ssd1306: "outputs.ssd1306",
  st7735: "outputs.st7735",
  st7789: "outputs.st7789",
  ili9341: "outputs.ili9341",
  hd44780: "outputs.hd44780",
  ks0108: "outputs.ks0108",
  pcf8833: "outputs.pcf8833",
  sh1107: "outputs.sh1107",
  gc9a01a: "outputs.gc9a01a",
  dht22: "sensors.dht22",
  ds1621: "sensors.ds1621",
  ds18b20: "sensors.ds18b20",
  rtd: "sensors.rtd",
  sr04: "sensors.sr04",
  strain: "sensors.strain",
  ds1307: "peripherals.ds1307",
  esp01: "peripherals.esp01",
  ky023: "peripherals.ky023",
  ky040: "peripherals.ky040",
  touchpad: "peripherals.touchpad",
  sdcard: "peripherals.sdcard",
};

/** Aliases que são específicos do FORMATO de arquivo do SimulIDE, não do ABI nativo do LasecSimul. */
const IMPORT_PIN_ALIASES: Record<string, Record<string, string>> = {
  "sources.fixed_volt": { outnod: "out" },
  "sources.rail": { outnod: "pin-1" },
  "sources.wave_gen": { outnod: "pin-1", gnd: "pin-2" },
  "other.ground": { gnd: "pin" },
  "peripherals.serialterm": { pin0: "tx", pin1: "rx" },
  "peripherals.serialport": { pin0: "tx", pin1: "rx" },
  "outputs.aip31068_i2c": { pinsda: "sda", pinscl: "scl" },
  "outputs.pcd8544": { pinrst: "rst", pincs: "ce", pindc: "dc", pinsi: "din", pinscl: "clk" },
  "sensors.thermistor": { lpin: "a", rpin: "b" },
};

export function normalizeSimulideToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function sourceClassNames(entry: WebviewComponentCatalogEntry): string[] {
  const names = [
    entry.package?.simulidePaint?.source?.className,
    entry.logicSymbolPackage?.simulidePaint?.source?.className,
    entry.boardPackage?.simulidePaint?.source?.className,
  ].filter((name): name is string => Boolean(name));
  // Alguns manifests documentam classe + widgets auxiliares em "A/B/C". A primeira classe ainda
  // precisa casar com itemtype="A" sem obrigar o catálogo a duplicar metadados só para o importador.
  return names.flatMap((name) => [name, ...name.split(/[\/,+\s]+/g).filter(Boolean)]);
}

function recognizedSubcircuitTypeId(source: SimulideComponentRecord | undefined): string | undefined {
  if (!source || normalizeSimulideToken(source.itemType) !== "subcircuit") return undefined;
  const identity = normalizeSimulideToken(`${source.circId} ${source.attributes.label ?? ""}`);
  const mainComp = normalizeSimulideToken(source.mainCompProps?.attributes.MainCompId ?? "");
  if (identity.includes("devkitc") && mainComp.startsWith("esp32")) return "subcircuits.esp32_devkitc_v4";
  return undefined;
}

export function resolveSimulideCatalogEntry(
  itemType: string,
  catalog: readonly WebviewComponentCatalogEntry[],
  source?: SimulideComponentRecord
): WebviewComponentCatalogEntry | undefined {
  const normalized = normalizeSimulideToken(itemType);

  const subcircuitTypeId = recognizedSubcircuitTypeId(source);
  if (subcircuitTypeId) return catalog.find((entry) => entry.typeId === subcircuitTypeId);

  const bySourceClass = catalog.find((entry) =>
    sourceClassNames(entry).some((name) => normalizeSimulideToken(name) === normalized)
  );
  if (bySourceClass) return bySourceClass;

  const fallbackTypeId = FALLBACK_TYPE_MAP[normalized];
  if (fallbackTypeId) return catalog.find((entry) => entry.typeId === fallbackTypeId);

  // Último fallback conservador: typeId/label somente quando a normalização casa exatamente.
  return catalog.find((entry) =>
    normalizeSimulideToken(entry.typeId) === normalized || normalizeSimulideToken(entry.label) === normalized
  );
}

function staticPins(entry: WebviewComponentCatalogEntry): PackagePin[] {
  return entry.package?.pins ?? [];
}

export function resolveSimulidePinId(
  entry: WebviewComponentCatalogEntry,
  rawLocalPinId: string
): string | undefined {
  const wanted = normalizeSimulideToken(rawLocalPinId);

  const importAlias = IMPORT_PIN_ALIASES[entry.typeId]?.[wanted];
  if (importAlias) return importAlias;

  const packagePin = staticPins(entry).find((pin) => {
    if (normalizeSimulideToken(pin.id) === wanted) return true;
    return pin.aliases?.some((alias) => normalizeSimulideToken(alias) === wanted) ?? false;
  });
  if (packagePin) return packagePin.id;

  const direct = entry.pinIds?.find((pinId) => normalizeSimulideToken(pinId) === wanted);
  if (direct) return direct;

  // Fallback numérico SOMENTE para formatos 1-based inequívocos (pin-1/p1/1). Não aceitar pin0,
  // porque SerialTerm/SerialPort do SimulIDE usam pin0=TX e pin1=RX; tratar pin1 como índice 1
  // converteria RX incorretamente para TX.
  const numericMatch = rawLocalPinId.match(/^(?:pin[-_]?|p)?([1-9]\d*)$/i);
  if (numericMatch) {
    const oneBased = Number(numericMatch[1]);
    const canonical = entry.pinIds?.[oneBased - 1];
    if (canonical) return canonical;
  }

  return undefined;
}

export function splitSimulideEndpoint(
  fullPinId: string,
  ownerIds: readonly string[]
): { ownerId: string; localPinId: string } | undefined {
  // IDs do SimulIDE contêm hífens. O owner correto é sempre o maior prefixo conhecido. A maioria
  // usa owner + "-" + pin, mas alguns componentes reais (Aip31068_i2c) criam id + "PinSDA" sem
  // separador. Longest-prefix evita confundir Foo-1 com Foo-10 quando ambos existem.
  const sorted = [...ownerIds].sort((a, b) => b.length - a.length);
  for (const ownerId of sorted) {
    if (fullPinId === ownerId) return { ownerId, localPinId: "" };
    if (fullPinId.startsWith(`${ownerId}-`)) {
      return { ownerId, localPinId: fullPinId.slice(ownerId.length + 1) };
    }
    if (fullPinId.startsWith(ownerId) && fullPinId.length > ownerId.length) {
      return { ownerId, localPinId: fullPinId.slice(ownerId.length) };
    }
  }
  return undefined;
}
