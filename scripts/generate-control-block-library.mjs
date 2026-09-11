import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "subcircuits");
const blocks = [
  ["gain", "Ganho", "control.gain", [{ id: "in", label: "IN", direction: "in" }], { gain: 1 }],
  ["bias", "Bias", "control.bias", [{ id: "in", label: "IN", direction: "in" }], { bias: 0 }],
  ["sum", "Soma", "control.sum", [{ id: "in0", label: "A", direction: "in" }, { id: "in1", label: "B", direction: "in" }], { inputs: ["in0", "in1"] }],
  ["subtract", "Subtracao", "control.subtract", [{ id: "in0", label: "A", direction: "in" }, { id: "in1", label: "B", direction: "in" }], { inputs: ["in0", "in1"] }],
  ["product", "Produto", "control.product", [{ id: "in0", label: "A", direction: "in" }, { id: "in1", label: "B", direction: "in" }], { inputs: ["in0", "in1"] }],
  ["divide", "Divisao", "control.divide", [{ id: "in0", label: "A", direction: "in" }, { id: "in1", label: "B", direction: "in" }], { inputs: ["in0", "in1"] }],
  ["pid", "PID", "control.pid", [{ id: "sp", label: "SP", direction: "in" }, { id: "pv", label: "PV", direction: "in" }], { kc: 1, ti: 10, td: 0, bias: 0, derivativeFilter: 0.1, outputMin: 0, outputMax: 100, action: 1, derivativeOnPv: true, initialIntegral: 0 }],
  ["integrator", "Integrador", "control.integrator", [{ id: "in", label: "IN", direction: "in" }], { gain: 1, initial: 0 }],
  ["filtered_derivative", "Derivador filtrado", "control.filtered_derivative", [{ id: "in", label: "IN", direction: "in" }], { gain: 1, filterTau: 0.01, initial: 0 }],
  ["unit_delay", "Atraso unitario", "control.unit_delay", [{ id: "in", label: "IN", direction: "in" }], { initial: 0 }],
  ["dead_time", "Tempo morto", "control.dead_time", [{ id: "in", label: "IN", direction: "in" }], { delay: 0.1, initial: 0 }],
  ["first_order", "Primeira ordem", "control.first_order", [{ id: "in", label: "IN", direction: "in" }], { gain: 1, tau: 1, initial: 0 }],
  ["second_order", "Segunda ordem", "control.second_order", [{ id: "in", label: "IN", direction: "in" }], { gain: 1, omega: 1, zeta: 1, initial: 0, initialDerivative: 0 }],
  ["lead_lag", "Lead-Lag", "control.lead_lag", [{ id: "in", label: "IN", direction: "in" }], { gain: 1, leadTau: 0, lagTau: 1, initial: 0 }],
  ["fopdt", "FOPDT", "control.fopdt", [{ id: "in", label: "IN", direction: "in" }], { gain: 1, tau: 1, delay: 0.1, initial: 0 }],
  ["transfer_function", "Funcao de transferencia", "control.transfer_function", [{ id: "in", label: "IN", direction: "in" }], { model: "first_order", gain: 1, tau: 1, initial: 0 }],
  ["tank", "Tanque", "control.tank", [{ id: "in", label: "IN", direction: "in" }], { area: 1, initial: 0 }],
  ["valve_characteristic", "Caracteristica de valvula", "control.valve_characteristic", [{ id: "in", label: "IN", direction: "in" }], { coefficient: 1, exponent: 1 }],
  ["saturation", "Saturacao", "control.saturation", [{ id: "in", label: "IN", direction: "in" }], { minimum: 0, maximum: 100 }],
  ["deadband", "Banda morta", "control.deadband", [{ id: "in", label: "IN", direction: "in" }], { width: 0 }],
  ["hysteresis", "Histerese", "control.hysteresis", [{ id: "in", label: "IN", direction: "in" }], { low: 0, high: 1, lowOutput: 0, highOutput: 1, initial: 0 }],
  ["stiction", "Stiction", "control.stiction", [{ id: "in", label: "IN", direction: "in" }], { breakaway: 0, slip: 0, initial: 0 }],
  ["rate_limiter", "Limitador de taxa", "control.rate_limiter", [{ id: "in", label: "IN", direction: "in" }], { riseRate: 1, fallRate: 1, initial: 0 }],
  ["limiter", "Limitador", "control.limiter", [{ id: "in", label: "IN", direction: "in" }], { minimum: 0, maximum: 100 }],
];

function makeBlock([slug, name, typeId, inputDefs, properties]) {
  const inputs = inputDefs.map((input, index) => ({ id: input.id, typeId: "connectors.tunnel", properties: { name: input.id, pinId: input.id, defaultValue: 0 }, visual: { x: 40, y: 70 + index * 55, rotation: 0 } }));
  const outputId = "out";
  const output = { id: "out-tunnel", typeId: "connectors.tunnel", properties: { name: outputId, pinId: outputId }, visual: { x: 320, y: 95 + Math.max(0, inputDefs.length - 1) * 27, rotation: 180 } };
  const component = { id: "stage", typeId, label: name, properties: { ...properties, samplePeriodNs: 10000000 }, visual: { x: 170, y: 85 + Math.max(0, inputDefs.length - 1) * 27, rotation: 0 } };
  const conductors = inputDefs.map((input, index) => ({ id: `wire-in-${index}`, from: { kind: "port", componentId: `${input.id}-tunnel`, pinId: "pin" }, to: { kind: "port", componentId: "stage", pinId: input.id }, points: [] }));
  conductors.push({ id: "wire-out", from: { kind: "port", componentId: "stage", pinId: "out" }, to: { kind: "port", componentId: "out-tunnel", pinId: "pin" }, points: [] });
  const interfaceEntries = [...inputDefs.map((input) => ({ pinId: input.id, label: input.label, internalTunnel: input.id, domain: "signal", direction: "in", valueType: "Real", width: 1 })), { pinId: outputId, label: "OUT", internalTunnel: outputId, domain: "signal", direction: "out", valueType: "Real", width: 1 }];
  const pins = [...inputDefs.map((input, index) => ({ id: input.id, kind: "ANALOG_IN", x: 0, y: 28 + index * 28, angle: 180, length: 8, label: input.label })), { id: outputId, kind: "ANALOG_OUT", x: 180, y: 42 + Math.max(0, inputDefs.length - 1) * 14, angle: 0, length: 8, label: "OUT" }];
  return { schemaVersion: 3, typeId: `subcircuits.control.${slug}`, name: `Controle - ${name}`, language: "pt-BR", folderPath: ["Control", "SignalEngine"], workspaceSection: "control", help: { description: `Bloco ${name} executado pelo SignalEngine do Core.` }, components: [...inputs, component, output], topology: { revision: 0, nodes: [], conductors }, interface: interfaceEntries, symbolMode: "generic", symbol: { width: 180, height: Math.max(76, 60 + inputDefs.length * 28), border: true, shapes: [{ kind: "text", x: 90, y: 18, value: name, fontSize: 10, textAnchor: "middle", color: "#111827" }], pins }, exposedComponents: [{ componentId: "stage", x: 90, y: 42 + Math.max(0, inputDefs.length - 1) * 14, rotation: 0, flipH: false, flipV: false, scale: 1, layer: 0 }], exportedPropertyComponentIds: ["stage"] };
}

const libraryPath = path.join(out, "library.json");
const library = JSON.parse(fs.readFileSync(libraryPath, "utf8"));
for (const entry of blocks) {
  const [slug] = entry;
  const file = `control_${slug}.lssubcircuit`;
  fs.writeFileSync(path.join(out, file), `${JSON.stringify(makeBlock(entry), null, 2)}\n`, "utf8");
  const typeId = `subcircuits.control.${slug}`;
  if (!library.subcircuits.some((item) => item.typeId === typeId)) library.subcircuits.push({ typeId, manifest: file });
}
fs.writeFileSync(libraryPath, `${JSON.stringify(library, null, 2)}\n`, "utf8");
console.log(`[control-library] ${blocks.length} blocos SignalEngine publicados`);
