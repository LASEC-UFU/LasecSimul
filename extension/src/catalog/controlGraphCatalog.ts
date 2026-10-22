import { PackageDescriptor, WebviewComponentCatalogEntry } from "../ui/webview/model";

type ControlDefinition = readonly [typeId: string, label: string, pins: readonly string[], defaults?: Record<string, string | number | boolean>];

const unary: ControlDefinition[] = [
  ["control.gain", "Ganho", ["in", "out"], { gain: 1 }], ["control.bias", "Bias", ["in", "out"], { bias: 0 }],
  ["control.integrator", "Integrador", ["in", "out"], { gain: 1, initial: 0 }], ["control.filtered_derivative", "Derivador filtrado", ["in", "out"], { gain: 1, filterTau: 0.01, initial: 0 }],
  ["control.unit_delay", "Atraso unitário", ["in", "out"], { initial: 0 }], ["control.dead_time", "Tempo morto", ["in", "out"], { delay: 0.1, initial: 0 }],
  ["control.first_order", "Primeira ordem", ["in", "out"], { gain: 1, tau: 1, initial: 0 }], ["control.second_order", "Segunda ordem", ["in", "out"], { gain: 1, omega: 1, zeta: 1, initial: 0 }],
  ["control.lead_lag", "Lead-Lag", ["in", "out"], { gain: 1, leadTau: 0, lagTau: 1, initial: 0 }], ["control.fopdt", "FOPDT", ["in", "out"], { gain: 1, tau: 1, delay: 0.1, initial: 0 }],
  ["control.transfer_function", "Função de transferência", ["in", "out"], { model: "first_order", gain: 1, tau: 1, initial: 0, initialState: "[]" }], ["control.valve_characteristic", "Característica de válvula", ["in", "out"], { coefficient: 1, exponent: 1 }],
  ["control.state_space", "Espaço de estados SISO", ["in", "out"], { A: "[[-1]]", B: "[1]", C: "[1]", D: 0, x0: "[0]", domain: "continuous", samplePeriodNs: 100000000 }],
  ["control.saturation", "Saturação", ["in", "out"], { minimum: 0, maximum: 100 }], ["control.limiter", "Limitador", ["in", "out"], { minimum: 0, maximum: 100 }],
  ["control.deadband", "Banda morta", ["in", "out"], { width: 0 }], ["control.hysteresis", "Histerese", ["in", "out"], { low: 0, high: 1 }],
  ["control.stiction", "Stiction", ["in", "out"], { breakaway: 0, slip: 0 }], ["control.rate_limiter", "Limitador de taxa", ["in", "out"], { riseRate: 1, fallRate: 1 }],
  ["control.process", "Processo", ["in", "out"], { gain: 1, tau1: 1, tau2: 0, deadTime: 0 }], ["control.probe", "Sonda", ["in", "out"]],
];

const multi: ControlDefinition[] = [
  ["control.pid", "PID", ["sp", "pv", "out"], { kc: 1, ti: 10, td: 0, bias: 0, outputMin: 0, outputMax: 100, manual: false, manualOutput: 0, localMode: false, localSetpoint: 50 }],
  ["control.pid_station", "Estação de sintonia PID", ["sp", "pv", "am", "lr", "out"], { kc: 1, ti: 10, td: 0, bias: 0, outputMin: 0, outputMax: 100, manual: false, manualOutput: 0, localMode: false, localSetpoint: 50 }],
  ["control.sum", "Soma", ["in0", "in1", "out"], { inputs: "in0,in1" }], ["control.product", "Produto", ["in0", "in1", "out"], { inputs: "in0,in1" }],
  ["control.subtract", "Subtração", ["in0", "in1", "out"]], ["control.divide", "Divisão", ["in0", "in1", "out"]],
  ["control.calc_expression", "Expressão", ["x0", "x1", "out"], { expression: "x0", inputs: "x0" }],
];

/** Portas de saída do `control.accumulator`, na ordem do vetor do bloco no Core
 * (`SignalMathBlock::accumulatorOutputPortIds`). */
export const ACCUMULATOR_OUTPUT_PORTS = ["out", "inActual", "outActual", "overflow", "unmet", "cumIn", "cumOut", "cumOverflow", "cumUnmet", "cumSpill"] as const;
const ACCUMULATOR_OUTPUT_LABELS: Readonly<Record<string, string>> = {
  out: "X", inActual: "IN real", outActual: "OUT real", overflow: "TRANSB.", unmet: "FALTA",
  cumIn: "∫IN", cumOut: "∫OUT", cumOverflow: "∫TRANSB.", cumUnmet: "∫FALTA", cumSpill: "DERRAM.",
};
const ACCUMULATOR_DEFAULTS = { initial: 0, lowerLimitEnabled: true, lowerLimit: 0, upperLimitEnabled: false, upperLimit: 100, lowerInput: false, upperInput: false };

/** Acumulador: entradas à esquerda, estado e acumulados à direita (uma saída por porta nomeada). */
function accumulatorPackage(): PackageDescriptor {
  const height = 24 + ACCUMULATOR_OUTPUT_PORTS.length * 14;
  const inputs = [["in", "IN"], ["outflow", "OUTFLOW"]].map(([id, label], index) => ({ id: id!, x: 0, y: 20 + index * 16, angle: 180 as const, length: 8, label: label! }));
  const outputs = ACCUMULATOR_OUTPUT_PORTS.map((id, index) => ({ id, x: 132, y: 20 + index * 14, angle: 0 as const, length: 8, label: ACCUMULATOR_OUTPUT_LABELS[id]! }));
  return { width: 132, height, border: false,
    shapes: [{ kind: "rect", x: 8, y: 4, w: 116, h: height - 8, fill: "#e0f2fe", stroke: "#0369a1", strokeWidth: 1.5 }, { kind: "text", x: 66, y: 16, value: "Acumulador", fontSize: 10, textAnchor: "middle", fill: "#0c4a6e" }],
    pins: [...inputs, ...outputs] };
}

function packageFor(label: string, pins: readonly string[]): PackageDescriptor {
  const inputPins = pins.slice(0, -1).map((id, index) => ({ id, x: 0, y: 16 + index * 16, angle: 180 as const, length: 8, label: id.toUpperCase() }));
  const output = pins.length > 0 ? [{ id: pins[pins.length - 1]!, x: 112, y: 24 + Math.max(0, inputPins.length - 1) * 8, angle: 0 as const, length: 8, label: "OUT" }] : [];
  return { width: 112, height: Math.max(48, 32 + inputPins.length * 16), border: false,
    shapes: [{ kind: "rect", x: 8, y: 4, w: 96, h: Math.max(40, 24 + inputPins.length * 16), fill: "#e0f2fe", stroke: "#0369a1", strokeWidth: 1.5 }, { kind: "text", x: 56, y: 20, value: label, fontSize: 10, textAnchor: "middle", fill: "#0c4a6e" }],
    pins: [...inputPins, ...output] };
}

/** Constante: só a saída, com o valor e a unidade da instância escritos no corpo. */
function constantPackage(): PackageDescriptor {
  return { width: 112, height: 48, border: false,
    shapes: [{ kind: "rect", x: 8, y: 4, w: 96, h: 40, fill: "#e0f2fe", stroke: "#0369a1", strokeWidth: 1.5 },
      { kind: "text", x: 56, y: 17, value: "Constante", fontSize: 9, textAnchor: "middle", fill: "#0c4a6e" },
      { kind: "text", x: 48, y: 34, value: "0", fontSize: 11, textAnchor: "end", fill: "#0c4a6e", stateText: { kind: "property", prop: "value" } },
      { kind: "text", x: 52, y: 34, value: "", fontSize: 10, textAnchor: "start", fill: "#0c4a6e", stateText: { kind: "property", prop: "unit" } }],
    pins: [{ id: "out", x: 112, y: 24, angle: 0, length: 8, label: "OUT" }] };
}

function observerPackage(label: string): PackageDescriptor {
  return { width: 112, height: 48, border: false,
    shapes: [{ kind: "rect", x: 8, y: 4, w: 96, h: 40, fill: "#e0f2fe", stroke: "#0369a1", strokeWidth: 1.5 }, { kind: "text", x: 56, y: 20, value: label, fontSize: 10, textAnchor: "middle", fill: "#0c4a6e" }],
    pins: [{ id: "in", x: 0, y: 24, angle: 180, length: 8, label: "IN" }] };
}

function pidStationPackage(pins: readonly string[]): PackageDescriptor {
  const descriptor = packageFor("Sintonia FOPDT", pins);
  return { ...descriptor, pins: descriptor.pins.map((pin) => ({
    ...pin,
    label: pin.id === "out" ? "MV" : pin.id === "am" ? "A/M" : pin.id === "lr" ? "L/R" : pin.id.toUpperCase(),
  })) };
}

/** Os únicos primitivos que os modelos TDPS instanciam DIRETO e que não têm um bloco
 * `subcircuits.control.*` equivalente: só estes
 * aparecem na paleta, em Controle › Blocos Funcionais
 * (`folderPath: []` + `workspaceSection: "control"`; a subseção vem de
 * `paletteTree.ts::paletteFolderPathForEntry`). Todo o resto de `control.*` é a implementação interna
 * desses wrappers legados (o "stage" de cada `.lssubcircuit`) -- duplicar isso na paleta era justamente a
 * subseção "Controle" que aparecia dentro da antiga aba Processo. */
const PALETTE_VISIBLE_TYPE_IDS = new Set(["control.constant", "control.pid_station"]);

function entry(definition: ControlDefinition): WebviewComponentCatalogEntry {
  const [typeId, label, pins, defaults = {}] = definition;
  const isPid = typeId === "control.pid_station";
  // `paletteHidden` (só a paleta), nunca `hidden` (que apagaria a INSTÂNCIA do render): no editor de
  // subcircuito estes blocos são o conteúdo principal e precisam aparecer junto dos túneis.
  return { typeId, label: isPid ? "Sintonia FOPDT" : label, category: isPid ? "Ferramentas" : "Controle", folderPath: isPid ? ["Ferramentas"] : PALETTE_VISIBLE_TYPE_IDS.has(typeId) ? ["TDPS"] : [], workspaceSection: "control", icon: "package", hidden: false,
    paletteHidden: !PALETTE_VISIBLE_TYPE_IDS.has(typeId), graphical: true,
    pinCount: pins.length, pinIds: [...pins], defaultProperties: { ...defaults },
    ...(typeId.startsWith("control.") ? { readoutFormat: { kind: "scalar" as const, unit: "" } } : {}),
    package: typeId === "control.pid_station" ? pidStationPackage(pins) : packageFor(isPid ? "PID" : label, pins) };
}

export const controlGraphCatalog: WebviewComponentCatalogEntry[] = [
  // Parâmetro de modelo (altura, densidade, pressão...): muda com a simulação rodando (ver
  // core/src/components/control/SignalConstant.hpp).
  { typeId: "control.constant", label: "Constante", category: "Controle", folderPath: ["TDPS"], workspaceSection: "control", icon: "package", hidden: false, graphical: true, pinCount: 1, pinIds: ["out"], defaultProperties: { value: 0, unit: "" }, readoutFormat: { kind: "scalar", unit: "" }, package: constantPackage() },
  { typeId: "control.observer", label: "Sonda", category: "Controle", folderPath: ["TDPS"], workspaceSection: "control", icon: "package", hidden: false, paletteHidden: true, graphical: true, pinCount: 1, pinIds: ["in"], defaultProperties: { observerOnly: true }, readoutFormat: { kind: "scalar", unit: "" }, package: observerPackage("Sonda") },
  { typeId: "connectors.signal_tunnel", label: "Túnel de sinal", category: "Conectores", folderPath: ["Conectores"], workspaceSection: "misc", icon: "tunel", hidden: false, graphical: true, pinCount: 1, pinIds: ["value"], defaultProperties: { name: "signal", direction: "Input", valueType: "Real" }, package: packageFor("SINAL", ["value"]) },
  ...unary.map(entry), ...multi.map(entry),
  { ...entry(["control.accumulator", "Acumulador", ["in", "outflow", ...ACCUMULATOR_OUTPUT_PORTS], ACCUMULATOR_DEFAULTS]), package: accumulatorPackage() },
  { ...entry(["process.accumulator", "Acumulador de Processo", ["in", "outflow", ...ACCUMULATOR_OUTPUT_PORTS], ACCUMULATOR_DEFAULTS]), package: accumulatorPackage() },
];

const dynamicInputTypes = new Set(["control.calc_expression", "control.sum", "control.product"]);

/** The persisted TDPS model retains the canonical input names.  The visual
 * catalog supplies defaults, while this resolves the instance-specific ports. */
export function controlGraphPinIds(typeId: string, properties: Record<string, unknown>): string[] | undefined {
  // Fronteiras por entrada (ex.: Vmax = A·hmax ao vivo) só existem quando a instância as declara.
  if (typeId === "control.accumulator" || typeId === "process.accumulator") {
    return ["in", "outflow", ...(properties.lowerInput === true ? ["lower"] : []), ...(properties.upperInput === true ? ["upper"] : []), ...ACCUMULATOR_OUTPUT_PORTS];
  }
  if (!dynamicInputTypes.has(typeId)) return undefined;
  const raw = properties.inputs;
  const inputs = Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string" && value.length > 0)
    : typeof raw === "string" ? raw.split(",").map((value) => value.trim()).filter(Boolean) : [];
  return [...(inputs.length > 0 ? inputs : ["x0"]), "out"];
}
