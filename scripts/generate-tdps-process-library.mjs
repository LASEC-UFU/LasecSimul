import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(repoRoot, "subcircuits");

const scenarios = [
  {
    file: "tdps_split_range.lssubcircuit",
    typeId: "subcircuits.tdps.split_range",
    name: "TDPS - Controle Split-Range",
    short: "SPLIT\nRANGE",
    inputs: [["command", "Comando", "%"]],
    expression: "x0",
    process: { gain: 1, tau1: 1.8, tau2: 0.7, deadTime: 0.2, actuatorTau: 0.35, hysteresis: 1.5, stiction: 0.8, rateLimiter: 40 },
    output: ["response", "Resposta", "%"],
    description: "Cenario didatico TDPS convertido: duas regioes de atuacao sao representadas pela nao linearidade de valvula, histerese, stiction, atuador e limites de velocidade do bloco de processo.",
  },
  {
    file: "tdps_surge_tank_level.lssubcircuit",
    typeId: "subcircuits.tdps.surge_tank_level",
    name: "TDPS - Nivel de Tanque Pulmao",
    short: "SURGE\nLEVEL",
    inputs: [["inflow", "Vazao entrada", "m3/h"], ["outflow", "Vazao saida", "m3/h"]],
    expression: "x0-x1",
    process: { gain: 0.75, tau1: 18, tau2: 0, deadTime: 0, actuatorTau: 0, hysteresis: 0, stiction: 0, rateLimiter: 0 },
    output: ["level", "Nivel", "%"],
    description: "Cenario didatico TDPS convertido para balanco de vazoes e dinamica lenta de nivel.",
  },
  {
    file: "tdps_heat_exchanger.lssubcircuit",
    typeId: "subcircuits.tdps.heat_exchanger",
    name: "TDPS - Trocador de Calor",
    short: "HEAT\nEXCHANGER",
    inputs: [["steam", "Vapor", "%"], ["inletTemperature", "Temperatura entrada", "degC"]],
    expression: "0.65*x0+0.35*x1",
    process: { gain: 1.1, tau1: 12, tau2: 3.5, deadTime: 1.2, actuatorTau: 0.8, hysteresis: 0, stiction: 0.3, rateLimiter: 15 },
    output: ["outletTemperature", "Temperatura saida", "degC"],
    description: "Cenario didatico TDPS convertido com mistura de vapor/temperatura, duas constantes de tempo, atuador e tempo morto.",
  },
  {
    file: "tdps_furnace_combustion.lssubcircuit",
    typeId: "subcircuits.tdps.furnace_combustion",
    name: "TDPS - Fornalha e Combustao",
    short: "FURNACE",
    inputs: [["fuel", "Combustivel", "%"], ["air", "Ar", "%"]],
    expression: "x0*x1/100",
    process: { gain: 9, tau1: 22, tau2: 6, deadTime: 2.5, actuatorTau: 1.5, hysteresis: 0.5, stiction: 0.5, rateLimiter: 8 },
    output: ["temperature", "Temperatura", "degC"],
    description: "Cenario didatico TDPS convertido: a liberacao de calor depende de combustivel e ar, seguida pela dinamica termica da fornalha.",
  },
  {
    file: "tdps_boiler_drum.lssubcircuit",
    typeId: "subcircuits.tdps.boiler_drum",
    name: "TDPS - Caldeira e Tubulao",
    short: "BOILER\nDRUM",
    inputs: [["firing", "Queima", "%"], ["feedwater", "Agua alimentacao", "%"]],
    expression: "0.8*x0+0.2*x1",
    process: { gain: 1.25, tau1: 28, tau2: 7, deadTime: 3, actuatorTau: 1.2, hysteresis: 0, stiction: 0.4, rateLimiter: 6 },
    output: ["pressure", "Pressao", "bar"],
    description: "Cenario didatico TDPS convertido para resposta de pressao de caldeira a queima e agua de alimentacao.",
  },
  {
    file: "tdps_reactor_temperature.lssubcircuit",
    typeId: "subcircuits.tdps.reactor_temperature",
    name: "TDPS - Temperatura de Reator",
    short: "REACTOR",
    inputs: [["feed", "Carga termica", "%"], ["cooling", "Resfriamento", "%"]],
    expression: "x0-x1",
    process: { gain: 2.4, tau1: 35, tau2: 9, deadTime: 1.5, actuatorTau: 2, hysteresis: 0.4, stiction: 0.6, rateLimiter: 5 },
    output: ["temperature", "Temperatura", "degC"],
    description: "Cenario didatico TDPS convertido para balanco entre carga termica e resfriamento de um reator.",
  },
  {
    file: "tdps_ph_neutralization.lssubcircuit",
    typeId: "subcircuits.tdps.ph_neutralization",
    name: "TDPS - Neutralizacao de pH",
    short: "pH",
    inputs: [["base", "Base", "%"], ["acid", "Acido", "%"]],
    expression: "7+0.07*(x0-x1)",
    process: { gain: 1, tau1: 8, tau2: 2, deadTime: 0.8, actuatorTau: 0.6, hysteresis: 0.15, stiction: 0.25, rateLimiter: 2 },
    output: ["ph", "pH", "pH"],
    description: "Cenario didatico TDPS convertido para neutralizacao. A curva local usa uma aproximacao segura e explicita; nao pretende substituir um modelo quimico de equilibrio completo.",
  },
];

function tunnel(id, name, x, y, defaultValue = undefined) {
  return {
    id: `${id}-tunnel`, typeId: "connectors.tunnel",
    properties: { name: id, pinId: id, ...(defaultValue === undefined ? {} : { defaultValue }) },
    visual: { x, y, rotation: name === "out" ? 180 : 0 },
  };
}

function buildScenario(scenario) {
  const inputComponents = scenario.inputs.map(([id], index) => tunnel(id, "in", 40, 70 + index * 80, 0));
  const calcInputs = scenario.inputs.map((_, index) => `x${index}`);
  const components = [
    ...inputComponents,
    { id: "balance", typeId: "control.calc_expression", label: "Modelo estatico", properties: { expression: scenario.expression, inputs: calcInputs }, visual: { x: 210, y: 110, rotation: 0 } },
    { id: "plant", typeId: "control.process", label: scenario.name, properties: { ...scenario.process, lead: 0, lag: 0, samplePeriodNs: 10000000 }, visual: { x: 420, y: 110, rotation: 0 } },
    tunnel(scenario.output[0], "out", 640, 110),
  ];
  const conductors = [
    ...scenario.inputs.map(([id], index) => ({ id: `wire-${index + 1}`, from: { kind: "port", componentId: `${id}-tunnel`, pinId: "pin" }, to: { kind: "port", componentId: "balance", pinId: `x${index}` }, points: [] })),
    { id: `wire-${scenario.inputs.length + 1}`, from: { kind: "port", componentId: "balance", pinId: "out" }, to: { kind: "port", componentId: "plant", pinId: "in" }, points: [] },
    { id: `wire-${scenario.inputs.length + 2}`, from: { kind: "port", componentId: "plant", pinId: "out" }, to: { kind: "port", componentId: `${scenario.output[0]}-tunnel`, pinId: "pin" }, points: [] },
  ];
  const interfaceEntries = [
    ...scenario.inputs.map(([pinId, label, unit]) => ({ pinId, label, internalTunnel: pinId, domain: "signal", direction: "in", valueType: "Real", width: 1, unit })),
    { pinId: scenario.output[0], label: scenario.output[1], internalTunnel: scenario.output[0], domain: "signal", direction: "out", valueType: "Real", width: 1, unit: scenario.output[2] },
  ];
  const leftPins = scenario.inputs.map(([id, label], index) => ({ id, kind: "ANALOG_IN", x: 0, y: 34 + index * 34, angle: 180, length: 8, label }));
  return {
    schemaVersion: 3,
    typeId: scenario.typeId,
    name: scenario.name,
    language: "pt-BR",
    folderPath: ["Process", "TDPS Convertidos"],
    workspaceSection: "process",
    help: { description: scenario.description },
    components,
    topology: { revision: 0, nodes: [], conductors },
    interface: interfaceEntries,
    symbolMode: "generic",
    symbol: {
      width: 150, height: Math.max(90, 50 + scenario.inputs.length * 34), border: true,
      shapes: scenario.short.split("\n").map((value, index) => ({ kind: "text", x: 75, y: 34 + index * 18, value, fontSize: index ? 8 : 11, textAnchor: "middle", color: index ? "#374151" : "#111827" })),
      pins: [...leftPins, { id: scenario.output[0], kind: "ANALOG_OUT", x: 150, y: 50, angle: 0, length: 8, label: scenario.output[1] }],
    },
    exposedComponents: [],
    exportedPropertyComponentIds: ["balance", "plant"],
  };
}

for (const scenario of scenarios) {
  fs.writeFileSync(path.join(outputDir, scenario.file), `${JSON.stringify(buildScenario(scenario), null, 2)}\n`, "utf8");
}
