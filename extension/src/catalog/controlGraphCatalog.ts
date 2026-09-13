import { PackageDescriptor, WebviewComponentCatalogEntry } from "../ui/webview/model";

type ControlDefinition = readonly [typeId: string, label: string, pins: readonly string[], defaults?: Record<string, string | number | boolean>];

const unary: ControlDefinition[] = [
  ["control.gain", "Ganho", ["in", "out"], { gain: 1 }], ["control.bias", "Bias", ["in", "out"], { bias: 0 }],
  ["control.integrator", "Integrador", ["in", "out"], { gain: 1, initial: 0 }], ["control.filtered_derivative", "Derivador filtrado", ["in", "out"], { gain: 1, filterTau: 0.01, initial: 0 }],
  ["control.unit_delay", "Atraso unitário", ["in", "out"], { initial: 0 }], ["control.dead_time", "Tempo morto", ["in", "out"], { delay: 0.1, initial: 0 }],
  ["control.first_order", "Primeira ordem", ["in", "out"], { gain: 1, tau: 1, initial: 0 }], ["control.second_order", "Segunda ordem", ["in", "out"], { gain: 1, omega: 1, zeta: 1, initial: 0 }],
  ["control.lead_lag", "Lead-Lag", ["in", "out"], { gain: 1, leadTau: 0, lagTau: 1, initial: 0 }], ["control.fopdt", "FOPDT", ["in", "out"], { gain: 1, tau: 1, delay: 0.1, initial: 0 }],
  ["control.transfer_function", "Função de transferência", ["in", "out"], { model: "first_order", gain: 1, tau: 1, initial: 0 }], ["control.valve_characteristic", "Característica de válvula", ["in", "out"], { coefficient: 1, exponent: 1 }],
  ["control.saturation", "Saturação", ["in", "out"], { minimum: 0, maximum: 100 }], ["control.limiter", "Limitador", ["in", "out"], { minimum: 0, maximum: 100 }],
  ["control.deadband", "Banda morta", ["in", "out"], { width: 0 }], ["control.hysteresis", "Histerese", ["in", "out"], { low: 0, high: 1 }],
  ["control.stiction", "Stiction", ["in", "out"], { breakaway: 0, slip: 0 }], ["control.rate_limiter", "Limitador de taxa", ["in", "out"], { riseRate: 1, fallRate: 1 }],
  ["control.process", "Processo", ["in", "out"], { gain: 1, tau1: 1, tau2: 0, deadTime: 0 }], ["control.probe", "Sonda", ["in", "out"]],
];

const multi: ControlDefinition[] = [
  ["control.pid", "PID", ["sp", "pv", "out"], { kc: 1, ti: 10, td: 0, bias: 0, outputMin: 0, outputMax: 100 }],
  ["control.sum", "Soma", ["in0", "in1", "out"], { inputs: "in0,in1" }], ["control.product", "Produto", ["in0", "in1", "out"], { inputs: "in0,in1" }],
  ["control.subtract", "Subtração", ["in0", "in1", "out"]], ["control.divide", "Divisão", ["in0", "in1", "out"]],
  ["control.tank", "Tanque", ["in", "outflow", "out"], { area: 1, initial: 0 }], ["control.calc_expression", "Expressão", ["x0", "x1", "out"], { expression: "x0", inputs: "x0" }],
];

function packageFor(label: string, pins: readonly string[]): PackageDescriptor {
  const inputPins = pins.slice(0, -1).map((id, index) => ({ id, x: 0, y: 16 + index * 16, angle: 180 as const, length: 8, label: id.toUpperCase() }));
  const output = pins.length > 0 ? [{ id: pins[pins.length - 1]!, x: 112, y: 24 + Math.max(0, inputPins.length - 1) * 8, angle: 0 as const, length: 8, label: "OUT" }] : [];
  return { width: 112, height: Math.max(48, 32 + inputPins.length * 16), border: false,
    shapes: [{ kind: "rect", x: 8, y: 4, w: 96, h: Math.max(40, 24 + inputPins.length * 16), fill: "#e0f2fe", stroke: "#0369a1", strokeWidth: 1.5 }, { kind: "text", x: 56, y: 20, value: label, fontSize: 10, textAnchor: "middle", fill: "#0c4a6e" }],
    pins: [...inputPins, ...output] };
}

function entry(definition: ControlDefinition): WebviewComponentCatalogEntry {
  const [typeId, label, pins, defaults = {}] = definition;
  return { typeId, label, category: "Controle", folderPath: ["Controle"], workspaceSection: "process", icon: "package", hidden: true, graphical: true,
    pinCount: pins.length, pinIds: [...pins], defaultProperties: { ...defaults }, package: packageFor(label, pins) };
}

export const controlGraphCatalog: WebviewComponentCatalogEntry[] = [
  { typeId: "connectors.signal_tunnel", label: "Túnel de sinal", category: "Conectores", folderPath: ["Conectores"], workspaceSection: "process", icon: "tunel", hidden: true, graphical: true, pinCount: 1, pinIds: ["value"], defaultProperties: { name: "signal", direction: "Input", valueType: "Real" }, package: packageFor("SINAL", ["value"]) },
  ...unary.map(entry), ...multi.map(entry),
];

const dynamicInputTypes = new Set(["control.calc_expression", "control.sum", "control.product"]);

/** The persisted TDPS model retains the canonical input names.  The visual
 * catalog supplies defaults, while this resolves the instance-specific ports. */
export function controlGraphPinIds(typeId: string, properties: Record<string, unknown>): string[] | undefined {
  if (!dynamicInputTypes.has(typeId)) return undefined;
  const raw = properties.inputs;
  const inputs = Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string" && value.length > 0)
    : typeof raw === "string" ? raw.split(",").map((value) => value.trim()).filter(Boolean) : [];
  return [...(inputs.length > 0 ? inputs : ["x0"]), "out"];
}
