import { ProjectComponent, ProjectTopology } from "../project/ProjectTypes";
import { SUBCIRCUIT_SCHEMA_VERSION, SubcircuitDocument, SubcircuitInterfaceEntry } from "../catalog/subcircuitDocument";

export type TdpsScalar = string | number | boolean;

export interface TdpsSection {
  kind: string;
  index?: number;
  fields: Record<string, TdpsScalar>;
  labels: Record<string, string>;
  raw: string[];
}

export interface TdpsModel {
  sourceName: string;
  title: string;
  screen?: string;
  controllers: TdpsSection[];
  processes: TdpsSection[];
  calcBlocks: TdpsSection[];
  recorders: TdpsSection[];
  xyRecorders: TdpsSection[];
  animatedTexts: TdpsSection[];
  otherSections: TdpsSection[];
  diagnostics: string[];
}

export interface TdpsCoverage {
  files: number;
  controllers: number;
  processes: number;
  calcBlocks: number;
  recorders: number;
  xyRecorders: number;
  animatedTexts: number;
  diagnostics: number;
}

export interface TdpsConversionReport {
  sourceName: string;
  externalVariables: number[];
  mapped: Record<string, number>;
  unsupported: Array<{ section: string; reason: string }>;
  diagnostics: string[];
}

export interface TdpsConversionResult {
  document: SubcircuitDocument;
  report: TdpsConversionReport;
}

const HEADER = /^=+<<<\s*([^>:]+?)(?::\s*(-?\d+))?\s*>>>=+\)?\s*$/i;
const FIELD = /^\{([^}]+)\}\s*(.*)$/;

function decode(source: string | Uint8Array): string {
  return typeof source === "string" ? source : new TextDecoder("windows-1252").decode(source);
}

function scalar(raw: string): TdpsScalar {
  const value = raw.trim();
  if (/^true$/i.test(value)) return true;
  if (/^false$/i.test(value)) return false;
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return value;
}

function parseFieldTail(tail: string): { label: string; value: TdpsScalar } {
  const separator = tail.indexOf(":");
  if (separator < 0) return { label: "", value: scalar(tail) };
  return { label: tail.slice(0, separator).trim(), value: scalar(tail.slice(separator + 1)) };
}

function classify(model: TdpsModel, section: TdpsSection): void {
  switch (section.kind) {
    case "CONTROLADOR": model.controllers.push(section); break;
    case "PROCESSO": model.processes.push(section); break;
    case "BLOCO CALC": model.calcBlocks.push(section); break;
    case "REGISTRADOR": model.recorders.push(section); break;
    case "REGISTRADOR XY": model.xyRecorders.push(section); break;
    case "TEXTO ANIMADO": model.animatedTexts.push(section); break;
    default: model.otherSections.push(section); break;
  }
}

/** Parser tolerante e sem efeitos colaterais para o formato legado TDPS v7.71. */
export function parseTdpsSmp(source: string | Uint8Array, sourceName = "input.smp"): TdpsModel {
  const lines = decode(source).replace(/^\uFEFF/, "").split(/\r?\n/);
  const first = lines.find((line) => line.trim().length > 0)?.trim() ?? sourceName;
  const firstIndex = lines.findIndex((line) => line.trim().length > 0);
  const screen = firstIndex >= 0 ? lines.slice(firstIndex + 1).find((line) => line.trim().length > 0)?.trim() : undefined;
  const model: TdpsModel = {
    sourceName, title: first, screen,
    controllers: [], processes: [], calcBlocks: [], recorders: [], xyRecorders: [], animatedTexts: [],
    otherSections: [], diagnostics: [],
  };
  let current: TdpsSection | undefined;
  for (const line of lines) {
    const header = HEADER.exec(line.trim());
    if (header) {
      if (current) classify(model, current);
      current = {
        kind: (header[1] ?? "UNKNOWN").trim().toUpperCase(),
        ...(header[2] !== undefined ? { index: Number(header[2]) } : {}),
        fields: {}, labels: {}, raw: [],
      };
      continue;
    }
    if (!current) continue;
    current.raw.push(line);
    const match = FIELD.exec(line.trim());
    if (!match) continue;
    const key = (match[1] ?? "").trim();
    if (!key) continue;
    const parsed = parseFieldTail(match[2] ?? "");
    current.fields[key] = parsed.value;
    current.labels[key] = parsed.label;
  }
  if (current) classify(model, current);

  for (const section of [...model.controllers, ...model.processes, ...model.calcBlocks, ...model.recorders, ...model.animatedTexts]) {
    if (section.index === undefined) model.diagnostics.push(`Secao ${section.kind} sem indice.`);
  }
  return model;
}

export function summarizeTdpsCorpus(models: readonly TdpsModel[]): TdpsCoverage {
  return models.reduce<TdpsCoverage>((sum, model) => ({
    files: sum.files + 1,
    controllers: sum.controllers + model.controllers.length,
    processes: sum.processes + model.processes.length,
    calcBlocks: sum.calcBlocks + model.calcBlocks.length,
    recorders: sum.recorders + model.recorders.length,
    xyRecorders: sum.xyRecorders + model.xyRecorders.length,
    animatedTexts: sum.animatedTexts + model.animatedTexts.length,
    diagnostics: sum.diagnostics + model.diagnostics.length,
  }), { files: 0, controllers: 0, processes: 0, calcBlocks: 0, recorders: 0, xyRecorders: 0, animatedTexts: 0, diagnostics: 0 });
}

function field(section: TdpsSection, ordinal: number): TdpsScalar | undefined {
  const suffix = `/${String(ordinal).padStart(2, "0")}`;
  const key = Object.keys(section.fields).find((candidate) => candidate.endsWith(suffix));
  return key === undefined ? undefined : section.fields[key];
}

function numberField(section: TdpsSection, ordinal: number, fallback = 0): number {
  const value = field(section, ordinal);
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanField(section: TdpsSection, ordinal: number, fallback = false): boolean {
  const value = field(section, ordinal);
  return typeof value === "boolean" ? value : fallback;
}

function stringField(section: TdpsSection, ordinal: number, fallback = ""): string {
  const value = field(section, ordinal);
  return typeof value === "string" ? value : value === undefined ? fallback : String(value);
}

function slug(value: string): string {
  const normalized = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const safe = normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return safe || "tdps-import";
}

function coordinates(model: TdpsModel): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  const section = model.otherSections.find((candidate) => candidate.kind === "COORDENADAS");
  if (!section) return result;
  const values = section.raw.map((line) => line.trim()).filter(Boolean);
  for (let index = 0; index + 3 < values.length; index += 4) {
    const tag = values[index];
    const x = Number(values[index + 1]);
    const y = Number(values[index + 2]);
    if (tag && Number.isFinite(x) && Number.isFinite(y)) result.set(tag, { x, y });
  }
  return result;
}

function references(expression: string): number[] {
  const found: number[] = [];
  for (const match of expression.matchAll(/\bM(\d+)\b/gi)) {
    const value = Number(match[1]);
    if (!found.includes(value)) found.push(value);
  }
  return found;
}

function rewriteExpression(expression: string, refs: readonly number[]): string {
  const names = new Map(refs.map((reference, index) => [reference, `x${index}`]));
  return expression.replace(/\bM(\d+)\b/gi, (_whole, digits: string) => names.get(Number(digits)) ?? "unsupported");
}

/** Converte referencias globais Mnn para edges explicitas de um subcircuito schemaVersion 3. */
export function convertTdpsToSubcircuit(model: TdpsModel, typeId = `subcircuits.tdps.${slug(model.title)}`): TdpsConversionResult {
  const components: ProjectComponent[] = [];
  const topology: ProjectTopology = { revision: 0, nodes: [], conductors: [] };
  const interfaces: SubcircuitInterfaceEntry[] = [];
  const pins: NonNullable<SubcircuitDocument["symbol"]>["pins"] = [];
  const positions = coordinates(model);
  const producers = new Map<number, { componentId: string; pinId: string }>();
  const external = new Map<number, string>();
  const unsupported: TdpsConversionReport["unsupported"] = [];
  let wire = 0;
  const addWire = (fromComponentId: string, fromPinId: string, toComponentId: string, toPinId: string): void => {
    topology.conductors.push({
      id: `wire-${++wire}`,
      from: { kind: "port", componentId: fromComponentId, pinId: fromPinId },
      to: { kind: "port", componentId: toComponentId, pinId: toPinId },
      vertices: [],
    });
  };
  const visual = (tag: string, fallbackIndex: number): ProjectComponent["visual"] => {
    const found = positions.get(tag);
    return { x: found?.x ?? 120 + (fallbackIndex % 5) * 180, y: found?.y ?? 80 + Math.floor(fallbackIndex / 5) * 100, rotation: 0 };
  };

  let componentOrder = 0;
  for (const controller of model.controllers) {
    const index = controller.index ?? componentOrder + 1;
    const id = `pid-${String(index).padStart(2, "0")}`;
    const tag = stringField(controller, 1, id);
    components.push({ id, typeId: "control.pid", label: tag, visual: visual(tag, componentOrder++), properties: {
      kc: numberField(controller, 3, 1), ti: numberField(controller, 4), td: numberField(controller, 5),
      bias: numberField(controller, 6), derivativeFilter: numberField(controller, 8, 0.1),
      outputMin: numberField(controller, 9), outputMax: numberField(controller, 10, 100),
      action: numberField(controller, 20, 1), derivativeOnPv: numberField(controller, 21, 1) !== 0,
      remoteSpEnabled: booleanField(controller, 18), feedForwardEnabled: booleanField(controller, 19),
      autoMode: booleanField(controller, 27, true), samplePeriodNs: 100_000_000,
    }});
    if (booleanField(controller, 19)) unsupported.push({ section: `CONTROLADOR:${index}`, reason: "Feedforward TDPS ainda nao possui binding confirmado." });
    if (!booleanField(controller, 27, true)) unsupported.push({ section: `CONTROLADOR:${index}`, reason: "Estado manual/auto legado nao e persistido como estado inicial." });
    if (numberField(controller, 22, 1) !== 1) unsupported.push({ section: `CONTROLADOR:${index}`, reason: "Estrutura PID nao-ISA sem semantica confirmada." });
    producers.set(index - 1, { componentId: id, pinId: "out" });
  }
  for (const process of model.processes) {
    const index = process.index ?? 20 + componentOrder;
    const id = `process-${String(index).padStart(2, "0")}`;
    const tag = stringField(process, 1, id);
    components.push({ id, typeId: "control.process", label: tag, visual: visual(tag, componentOrder++), properties: {
      tau1: numberField(process, 4), tau2: numberField(process, 5),
      saturationEnabled: booleanField(process, 6), hysteresis: numberField(process, 7),
      deadTime: numberField(process, 8), gain: numberField(process, 9, 1), valveType: numberField(process, 10),
      stiction: numberField(process, 11), rateLimiter: numberField(process, 12), actuatorTau: numberField(process, 13),
      transferFunctionType: numberField(process, 14), lead: numberField(process, 16), lag: numberField(process, 17),
      samplePeriodNs: 10_000_000,
    }});
    if (numberField(process, 10) !== 0) unsupported.push({ section: `PROCESSO:${index}`, reason: "Tipo de valvula legado preservado no relatorio; caracteristica nao confirmada." });
    if (numberField(process, 14) !== 0) unsupported.push({ section: `PROCESSO:${index}`, reason: "Tipo de funcao de transferencia legado nao confirmado." });
    if (booleanField(process, 6)) unsupported.push({ section: `PROCESSO:${index}`, reason: "Desaturacao TDPS nao possui limites declarados suficientes para conversao exata." });
    producers.set(index, { componentId: id, pinId: "out" });
  }
  for (const calc of model.calcBlocks) {
    const index = calc.index ?? 40 + componentOrder;
    const id = `calc-${String(index).padStart(2, "0")}`;
    const tag = stringField(calc, 1, id);
    const legacyExpression = stringField(calc, 3, "0");
    const refs = references(legacyExpression);
    const expression = rewriteExpression(legacyExpression, refs);
    const safe = /^[\s\d.xX+\-*/()]+$/.test(expression) && !expression.includes("unsupported");
    if (!safe) unsupported.push({ section: `BLOCO CALC:${index}`, reason: `Expressao fora da DSL segura: ${legacyExpression}` });
    components.push({ id, typeId: "control.calc_expression", label: tag, visual: visual(tag, componentOrder++), properties: {
      expression: safe ? expression : "0", inputs: refs.map((_reference, inputIndex) => `x${inputIndex}`),
      upperLimit: numberField(calc, 4), lowerLimit: numberField(calc, 5),
      upperLimitEnabled: booleanField(calc, 6), lowerLimitEnabled: booleanField(calc, 7), samplePeriodNs: 10_000_000,
    }});
    producers.set(index, { componentId: id, pinId: "out" });
  }

  const ensureExternal = (variable: number): { componentId: string; pinId: string } => {
    const existing = external.get(variable);
    if (existing) return { componentId: existing, pinId: "pin" };
    const pinId = `external-${String(variable).padStart(2, "0")}`;
    const componentId = `tunnel-${pinId}`;
    external.set(variable, componentId);
    components.push({ id: componentId, typeId: "connectors.tunnel", label: pinId, properties: { name: pinId, pinId, legacyVariableIndex: variable }, visual: { x: 20, y: 40 + external.size * 30, rotation: 0 } });
    interfaces.push({ pinId, label: pinId, internalTunnel: pinId, domain: "signal", direction: "in", valueType: "Real", width: 1 });
    pins.push({ id: pinId, label: pinId, kind: "ANALOG_IN", x: 0, y: 20 + external.size * 20, angle: 180, length: 8 });
    return { componentId, pinId: "pin" };
  };
  const connectVariable = (variable: number, targetComponentId: string, targetPinId: string): void => {
    const source = producers.get(variable) ?? ensureExternal(variable);
    addWire(source.componentId, source.pinId, targetComponentId, targetPinId);
  };

  for (const controller of model.controllers) {
    const id = `pid-${String(controller.index ?? 1).padStart(2, "0")}`;
    connectVariable(numberField(controller, 14), id, "pv");
    connectVariable(numberField(controller, 15), id, "sp");
  }
  for (const process of model.processes) {
    const id = `process-${String(process.index ?? 21).padStart(2, "0")}`;
    connectVariable(numberField(process, 3), id, "in");
  }
  for (const calc of model.calcBlocks) {
    const id = `calc-${String(calc.index ?? 41).padStart(2, "0")}`;
    references(stringField(calc, 3, "0")).forEach((reference, index) => connectVariable(reference, id, `x${index}`));
  }

  const addProbe = (id: string, label: string, variable: number, unit: string, order: number): void => {
    if (variable < 0) return;
    components.push({ id, typeId: "control.probe", label, visual: visual(label, order), properties: { unit, observerOnly: true } });
    connectVariable(variable, id, "in");
  };
  for (const recorder of model.recorders) {
    const index = recorder.index ?? 200 + componentOrder;
    for (const ordinal of [3, 5, 7]) {
      const variable = numberField(recorder, ordinal, -1);
      addProbe(`recorder-${index}-${ordinal}`, stringField(recorder, ordinal + 1, `Recorder ${index}`), variable, "", componentOrder++);
    }
  }
  for (const animated of model.animatedTexts) {
    const index = animated.index ?? 100 + componentOrder;
    addProbe(`readout-${index}`, stringField(animated, 1, `Readout ${index}`), numberField(animated, 8, -1), stringField(animated, 4), componentOrder++);
    const displayExpression = stringField(animated, 2);
    if (displayExpression.trim()) unsupported.push({ section: `TEXTO ANIMADO:${index}`, reason: "Expressao visual preservada no relatorio; Probe observa somente o binding de variavel declarado." });
  }
  for (const xy of model.xyRecorders) unsupported.push({ section: xy.kind, reason: "Layout XY preservado no relatorio; formato nao declara bindings inequívocos." });
  for (const other of model.otherSections) {
    if (other.kind !== "COORDENADAS") unsupported.push({ section: other.kind, reason: "Secao de autoria sem efeito no runtime." });
  }

  const outputVariables = [...producers.keys()].sort((a, b) => a - b);
  for (const variable of outputVariables) {
    const source = producers.get(variable)!;
    const pinId = `output-${String(variable).padStart(2, "0")}`;
    const componentId = `tunnel-${pinId}`;
    components.push({ id: componentId, typeId: "connectors.tunnel", label: pinId, properties: { name: pinId, pinId, legacyVariableIndex: variable }, visual: { x: 1000, y: 40 + interfaces.length * 30, rotation: 180 } });
    interfaces.push({ pinId, label: pinId, internalTunnel: pinId, domain: "signal", direction: "out", valueType: "Real", width: 1 });
    pins.push({ id: pinId, label: pinId, kind: "ANALOG_OUT", x: 140, y: 20 + outputVariables.indexOf(variable) * 20, angle: 0, length: 8 });
    addWire(source.componentId, source.pinId, componentId, "pin");
  }

  const document: SubcircuitDocument = {
    schemaVersion: SUBCIRCUIT_SCHEMA_VERSION,
    typeId, name: model.title, language: "pt-BR", folderPath: ["Controle de Processos", "TDPS importado"],
    workspaceSection: "process", help: { description: `Convertido de ${model.sourceName}; referencias TDPS foram resolvidas para topologia explicita.` },
    components, topology, interface: interfaces,
    symbolMode: "generic",
    symbol: { width: 140, height: Math.max(80, 40 + Math.max(external.size, outputVariables.length) * 20), border: true, pins, shapes: [
      { kind: "text", x: 12, y: 18, value: "TDPS", fontSize: 10, color: "#111827" },
      { kind: "text", x: 12, y: 34, value: model.title.slice(0, 28), fontSize: 8, color: "#111827" },
    ] },
    exposedComponents: [],
    exportedPropertyComponentIds: components.filter((component) => component.typeId === "control.pid" || component.typeId === "control.process").map((component) => component.id),
  };
  return {
    document,
    report: {
      sourceName: model.sourceName,
      externalVariables: [...external.keys()].sort((a, b) => a - b),
      mapped: {
        controllers: model.controllers.length, processes: model.processes.length, calcBlocks: model.calcBlocks.length,
        recorders: model.recorders.length, animatedTexts: model.animatedTexts.length,
      },
      unsupported,
      diagnostics: [...model.diagnostics],
    },
  };
}
