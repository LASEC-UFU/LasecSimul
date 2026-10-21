/**
 * Modelo do Simulink -> projeto `.lsproj` com a biblioteca equivalente (`sl.*`, docs/66). Cada bloco é
 * casado com a especificação pelo `simulink.blockType` (+ `match`) ou, para blocos de biblioteca
 * (`BlockType="Reference"`), pelo `simulink.sourceBlock`. Parâmetros: o valor gravado no bloco; na
 * falta dele, o padrão do PRÓPRIO arquivo (`bddefaults`, que muda entre versões do Simulink); na falta
 * dos dois, o padrão da especificação. Inport/Outport viram túneis de sinal; SubSystem vira definição
 * interna (tabela `subsystems`) com a mesma interface; Scope "viewer" vira um Scope ligado ao sinal
 * observado. Variáveis citadas nos parâmetros entram no Model Workspace do projeto -- o valor delas
 * fica no workspace base do MATLAB, não no arquivo, e precisa ser informado (nunca é inventado).
 */
import { createEmptyProject, type ProjectComponent, type ProjectDocument, type ProjectTopology } from "../../project/ProjectTypes";
import type { ModelWorkspaceVariable } from "../../project/modelWorkspace";
import { buildGenericSubcircuitPackage } from "../../ui/webview/genericSubcircuitPackage";
import { BLOCK_SCALE, blockPackage } from "../../ui/webview/blockLibrary/blockSymbol";
import { evaluateParam, ParamValue, scalarValue } from "../../ui/webview/blockLibrary/paramExpr";
import { resolveBlockPorts } from "../../ui/webview/blockLibrary/ports";
import { BlockLibraryFile, BlockSpec, blockTypeId } from "../../ui/webview/blockLibrary/spec";
import type { SlBlock, SlModel, SlPortRef, SlSystem } from "./SimulinkModel";

type Json = Record<string, unknown>;
type Props = Record<string, string | number | boolean>;
type Conductor = ProjectTopology["conductors"][number];

export interface SimulinkImportIssue {
  severity: "info" | "warning" | "error";
  path: string;
  message: string;
}

export interface SimulinkImportReport {
  model: string;
  format: string;
  blocks: number;
  converted: number;
  subsystems: number;
  lines: number;
  byType: Record<string, number>;
  unsupported: Array<{ path: string; blockType: string; sourceBlock?: string; reason: string }>;
  workspace: string[];
  issues: SimulinkImportIssue[];
}

// ------------------------------------------------------------------ índice da especificação

/** Nomes de parâmetro de versões anteriores do Simulink -> nome atual da especificação. */
const PARAM_ALIASES: Record<string, Record<string, string>> = {
  step: { InitialValue: "Before", FinalValue: "After" },
};

/** Bibliotecas de PID por versão (`slpidlib` R2021b+, `pid_lib` R2020b) -> caminho canônico. */
const SOURCE_ALIASES: Array<[RegExp, string]> = [
  [/^(?:slpidlib|pid_lib)\/(Discrete PID Controller(?: \(2DOF\))?)$/, "simulink/Discrete/$1"],
  [/^(?:slpidlib|pid_lib)\/(PID Controller(?: \(2DOF\))?)$/, "simulink/Continuous/$1"],
];

export function normalizeSourceBlock(path: string): string {
  let text = path.replace(/\s+/g, " ").trim();
  for (const [pattern, replacement] of SOURCE_ALIASES) if (pattern.test(text)) text = text.replace(pattern, replacement);
  return text;
}

export class BlockSpecIndex {
  private readonly byType = new Map<string, BlockSpec[]>();
  private readonly bySource = new Map<string, BlockSpec>();

  constructor(library: readonly BlockLibraryFile[]) {
    for (const file of library) {
      for (const spec of file.blocks) {
        const simulink = (spec as BlockSpec & { simulink?: { blockType?: string; sourceBlock?: string } }).simulink;
        if (simulink?.blockType) this.byType.set(simulink.blockType, [...(this.byType.get(simulink.blockType) ?? []), spec]);
        if (simulink?.sourceBlock) this.bySource.set(normalizeSourceBlock(simulink.sourceBlock), spec);
      }
    }
  }

  /** Especificação do bloco (com o `match` avaliado sobre os parâmetros efetivos). */
  find(block: SlBlock, defaults: Record<string, string>): BlockSpec | undefined {
    if (block.sourceBlock && (block.blockType === "Reference" || !this.byType.has(block.blockType))) {
      const spec = this.bySource.get(normalizeSourceBlock(block.sourceBlock));
      if (spec) return spec;
    }
    const candidates = this.byType.get(block.blockType) ?? [];
    if (candidates.length <= 1) return candidates[0];
    const matching = candidates.find((spec) => {
      const match = (spec as BlockSpec & { simulink?: { match?: Record<string, string> } }).simulink?.match;
      if (!match) return false;
      return Object.entries(match).every(([name, expected]) => {
        const declared = spec.params.find((param) => param.name === name)?.default;
        const actual = block.params[name] ?? defaults[name] ?? (declared === undefined ? undefined : String(declared));
        return actual === expected;
      });
    });
    return matching ?? candidates.find((spec) => !(spec as BlockSpec & { simulink?: { match?: unknown } }).simulink?.match) ?? candidates[0];
  }
}

/** Parâmetros da instância: valor do bloco, senão o padrão do arquivo, senão (omitido) o da especificação. */
export function blockProperties(spec: BlockSpec, block: SlBlock, defaults: Record<string, string>): Props {
  const props: Props = {};
  const aliases = PARAM_ALIASES[spec.id] ?? {};
  for (const param of spec.params) {
    let raw = block.params[param.name] ?? defaults[param.name];
    const alias = aliases[param.name];
    if (raw === undefined && alias) raw = block.params[alias] ?? defaults[alias];
    if (raw === undefined) continue;
    props[param.name] = param.type === "bool" ? raw === "on" || raw === "true" || raw === "1" : raw;
  }
  return props;
}

// ------------------------------------------------------------------ variáveis do workspace

const UNDEFINED_VARIABLE = /variavel nao definida: '([^']+)'/;

/** Nomes que a expressão usa e que não estão no workspace (avaliação de sondagem; os valores de
 * sondagem nunca são gravados). */
export function referencedVariables(expression: string, known: ReadonlySet<string>): string[] {
  const workspace = new Map<string, ParamValue>([...known].map((name) => [name, scalarValue(1)]));
  const found: string[] = [];
  for (let attempt = 0; attempt < 64; attempt++) {
    try {
      evaluateParam(expression, workspace);
      return found;
    } catch (error) {
      const match = UNDEFINED_VARIABLE.exec(error instanceof Error ? error.message : String(error));
      if (!match) return found;
      found.push(match[1]!);
      workspace.set(match[1]!, scalarValue(1));
    }
  }
  return found;
}

/** Identificadores de uma expressão de Fcn que não são `u`, funções nem constantes. */
function fcnVariables(expression: string): string[] {
  const reserved = new Set(["u", "pi", "eps", "inf", "Inf", "nan", "NaN"]);
  const names = new Set<string>();
  for (const match of expression.matchAll(/[A-Za-z_][A-Za-z0-9_]*(?!\s*\()/g)) if (!reserved.has(match[0]) && !/^\d/.test(match[0])) names.add(match[0]);
  return [...names];
}

// ------------------------------------------------------------------ conversão

interface ConvertedSystem {
  components: ProjectComponent[];
  conductors: Conductor[];
  inputs: Array<{ pinId: string; label: string }>;
  outputs: Array<{ pinId: string; label: string }>;
}

class Converter {
  readonly report: SimulinkImportReport;
  readonly subsystems: Json[] = [];
  readonly workspace = new Map<string, ModelWorkspaceVariable>();
  private readonly usedTypeIds = new Set<string>();
  private wireCounter = 0;

  constructor(private readonly model: SlModel, private readonly index: BlockSpecIndex) {
    this.report = { model: model.name, format: model.format, blocks: 0, converted: 0, subsystems: 0, lines: 0, byType: {}, unsupported: [], workspace: [], issues: [] };
  }

  private issue(severity: SimulinkImportIssue["severity"], path: string, message: string) {
    this.report.issues.push({ severity, path, message });
  }

  private componentId(block: SlBlock, fallback: number): string {
    return `b${(block.sid || `n${fallback}`).replace(/[^A-Za-z0-9_]/g, "_")}`;
  }

  /** Posição: centro do bloco do Simulink na escala do esquemático; a caixa do pacote em volta. */
  private visual(block: SlBlock, width: number, height: number): NonNullable<ProjectComponent["visual"]> {
    const [l, t, r, b] = block.position ?? [0, 0, 30, 30];
    const cx = ((l + r) / 2) * BLOCK_SCALE, cy = ((t + b) / 2) * BLOCK_SCALE;
    return { x: Math.round(cx - width / 2), y: Math.round(cy - height / 2), rotation: block.rotation };
  }

  private noteWorkspace(names: string[], path: string) {
    for (const name of names) {
      if (this.workspace.has(name)) continue;
      this.workspace.set(name, { name, value: "", description: `citada em ${path}` });
    }
  }

  convertSystem(system: SlSystem, path: string): ConvertedSystem {
    const result: ConvertedSystem = { components: [], conductors: [], inputs: [], outputs: [] };
    // Endpoints: SID/nome do bloco -> (componente, portas de entrada/saída por índice).
    interface Ports { componentId: string; inputs: string[]; outputs: string[] }
    const ports = new Map<string, Ports>();
    const byName = new Map<string, string>();
    system.blocks.forEach((block, position) => {
      this.report.blocks++;
      const blockPath = `${path}/${block.name}`;
      const id = this.componentId(block, this.report.blocks);
      const key = block.sid || `#${position}`;
      byName.set(block.name, key);
      this.report.byType[block.blockType] = (this.report.byType[block.blockType] ?? 0) + 1;
      const defaults = this.model.defaults[block.blockType] ?? {};
      const show = (component: ProjectComponent, width: number, height: number) => {
        component.visual = this.visual(block, width, height);
        if (block.mirror) component.flipH = true;
        result.components.push(component);
      };
      if (block.blockType === "Inport" || block.blockType === "Outport") {
        const input = block.blockType === "Inport";
        const portNumber = Number(block.params.Port ?? defaults.Port ?? 1);
        const pinId = `${input ? "in" : "out"}${portNumber}`;
        show({ id, typeId: "connectors.signal_tunnel", label: block.name,
          properties: input ? { name: pinId, pinId, direction: "Input", valueType: "Real", defaultValue: 0 } : { name: pinId, pinId, direction: "Output", valueType: "Real" } }, 40, 20);
        (input ? result.inputs : result.outputs).push({ pinId, label: block.name });
        ports.set(key, { componentId: id, inputs: input ? [] : ["value"], outputs: input ? ["value"] : [] });
        this.report.converted++;
        return;
      }
      if (block.blockType === "SubSystem" && block.system) {
        // Máscara ANTES do conteúdo: os parâmetros internos que a citam já encontram a variável.
        for (const parameter of block.mask ?? []) {
          const existing = this.workspace.get(parameter.name);
          if (existing && existing.value.trim()) this.issue("warning", blockPath, `parametro de mascara '${parameter.name}' tem o mesmo nome de outra variavel; vale o primeiro valor`);
          else this.workspace.set(parameter.name, { name: parameter.name, value: parameter.value, description: `parametro da mascara de ${blockPath}` });
        }
        if ((block.mask ?? []).length > 0) this.issue("info", blockPath, "parametros da mascara viraram variaveis do Model Workspace (o projeto nao tem workspace por subsistema)");
        const inner = this.convertSystem(block.system, blockPath);
        const typeId = this.uniqueTypeId(block.name);
        inner.inputs.sort((a, b) => Number(a.pinId.slice(2)) - Number(b.pinId.slice(2)));
        inner.outputs.sort((a, b) => Number(a.pinId.slice(3)) - Number(b.pinId.slice(3)));
        const interfaceEntries = [
          ...inner.inputs.map((pin) => ({ pinId: pin.pinId, label: pin.label, internalTunnel: pin.pinId, domain: "signal", direction: "in", valueType: "Real", width: 1 })),
          ...inner.outputs.map((pin) => ({ pinId: pin.pinId, label: pin.label, internalTunnel: pin.pinId, domain: "signal", direction: "out", valueType: "Real", width: 1 })),
        ];
        this.subsystems.push({
          schemaVersion: 3, typeId, name: block.name, language: "pt-BR", folderPath: ["Simulink"], workspaceSection: "control",
          components: inner.components, topology: { revision: 0, nodes: [], conductors: inner.conductors },
          interface: interfaceEntries, symbolMode: "generic",
          symbol: buildGenericSubcircuitPackage(block.name, interfaceEntries.map((entry) => ({ id: entry.pinId, label: entry.label }))),
          exposedComponents: [], exportedPropertyComponentIds: [],
          origin: { kind: "simulink-import", path: blockPath },
        });
        this.report.subsystems++;
        show({ id, typeId, label: block.name, properties: {} }, 100, 60);
        ports.set(key, { componentId: id, inputs: inner.inputs.map((pin) => pin.pinId), outputs: inner.outputs.map((pin) => pin.pinId) });
        this.report.converted++;
        return;
      }
      const spec = this.index.find(block, defaults);
      if (!spec) {
        const reason = block.blockType === "Reference" ? `bloco de biblioteca sem equivalente: ${block.sourceBlock ?? "?"}` : `BlockType ${block.blockType} sem equivalente na biblioteca`;
        this.report.unsupported.push({ path: blockPath, blockType: block.blockType, sourceBlock: block.sourceBlock, reason });
        this.issue("warning", blockPath, `${reason}; bloco omitido e linhas ligadas a ele descartadas`);
        return;
      }
      const props = blockProperties(spec, block, defaults);
      // Scope "viewer" (sem portas): ganha uma entrada por sinal observado.
      if (block.viewerSignals && block.viewerSignals.length > 0 && spec.id === "scope") props.NumInputPorts = String(block.viewerSignals.length);
      const resolved = resolveBlockPorts(spec, props);
      const pkg = blockPackage(spec, props);
      show({ id, typeId: blockTypeId(spec), label: block.name, properties: props }, pkg.width, pkg.height);
      ports.set(key, { componentId: id, inputs: resolved.inputs.map((port) => port.id), outputs: resolved.outputs.map((port) => port.id) });
      this.report.converted++;
      for (const param of spec.params) {
        const value = props[param.name];
        if (typeof value !== "string" || value.trim() === "") continue;
        if (param.type === "expr") this.noteWorkspace(referencedVariables(value, new Set()), `${blockPath} (${param.name})`);
        else if (spec.id === "fcn" && param.name === "Expr") this.noteWorkspace(fcnVariables(value), `${blockPath} (Expr)`);
      }
    });
    // Linhas: uma ligação por destino (ramificações achatadas).
    const endpoint = (ref: SlPortRef | undefined, side: "in" | "out", where: string): { componentId: string; pinId: string } | undefined => {
      if (!ref) return undefined;
      const key = ref.byName ? byName.get(ref.block) : ref.block;
      const entry = key === undefined ? undefined : ports.get(key);
      if (!entry) return undefined;
      if (ref.kind !== side) {
        this.issue("warning", where, `porta especial '${ref.kind}' nao suportada (subsistemas condicionais/portas de estado); ligacao descartada`);
        return undefined;
      }
      const pinId = (side === "in" ? entry.inputs : entry.outputs)[ref.index - 1];
      if (!pinId) {
        this.issue("warning", where, `porta ${side}:${ref.index} inexistente no bloco convertido; ligacao descartada`);
        return undefined;
      }
      return { componentId: entry.componentId, pinId };
    };
    for (const line of system.lines) {
      const from = endpoint(line.src, "out", path);
      if (!from) continue;
      for (const dst of line.dsts) {
        const to = endpoint(dst, "in", path);
        if (!to) continue;
        result.conductors.push({ id: `w${++this.wireCounter}`, from: { kind: "port", ...from }, to: { kind: "port", ...to }, vertices: [] });
        this.report.lines++;
      }
    }
    // Viewers: sinal observado (bloco do mesmo sistema) -> entradas do Scope.
    for (const block of system.blocks) {
      if (!block.viewerSignals) continue;
      const scope = ports.get(block.sid || "");
      if (!scope) continue;
      block.viewerSignals.forEach((signal, index) => {
        const source = endpoint({ block: signal.blockName, byName: true, kind: "out", index: signal.port }, "out", `${path}/${block.name}`);
        const target = scope.inputs[index];
        if (!source || !target) { this.issue("warning", `${path}/${block.name}`, `sinal observado '${signal.blockName}:o${signal.port}' nao encontrado`); return; }
        result.conductors.push({ id: `w${++this.wireCounter}`, from: { kind: "port", ...source }, to: { kind: "port", componentId: scope.componentId, pinId: target }, vertices: [] });
        this.report.lines++;
      });
    }
    return result;
  }

  private uniqueTypeId(name: string): string {
    const slug = name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "subsistema";
    let typeId = `subsystem.${slug}`;
    for (let n = 2; this.usedTypeIds.has(typeId); n++) typeId = `subsystem.${slug}_${n}`;
    this.usedTypeIds.add(typeId);
    return typeId;
  }
}

function seconds(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  try {
    const value = evaluateParam(text);
    return value.data.length === 1 && Number.isFinite(value.data[0]) && value.data[0]! > 0 ? value.data[0] : undefined;
  } catch {
    return undefined;
  }
}

export function convertSimulinkModel(model: SlModel, library: readonly BlockLibraryFile[]): { project: ProjectDocument; report: SimulinkImportReport } {
  const converter = new Converter(model, new BlockSpecIndex(library));
  const root = converter.convertSystem(model.root, model.name);
  const project = createEmptyProject();
  project.components = root.components;
  project.topology = { revision: 0, nodes: [], conductors: root.conductors };
  if (converter.subsystems.length > 0) project.subsystems = converter.subsystems as unknown as ProjectDocument["subsystems"];
  const workspace = [...converter.workspace.values()];
  if (workspace.length > 0) project.modelWorkspace = workspace;
  const report = converter.report;
  report.workspace = workspace.filter((variable) => variable.value.trim() === "").map((variable) => variable.name);
  if (report.workspace.length > 0)
    report.issues.push({ severity: "warning", path: model.name, message: `variaveis sem valor no arquivo (vem do workspace do MATLAB): ${report.workspace.join(", ")}. Defina-as em "LasecSimul: Model Workspace".` });
  // Solver: passo máximo e tolerâncias numéricas viram configuração da simulação.
  const maxStep = seconds(model.config.MaxStep) ?? (/^Fixed/i.test(model.config.Solver ?? "") ? seconds(model.config.FixedStep) : undefined);
  const relTol = seconds(model.config.RelTol);
  const absTol = seconds(model.config.AbsTol);
  project.simulationSettings = {
    ...(maxStep !== undefined ? { maximumStepSeconds: maxStep } : {}),
    ...(relTol !== undefined ? { relativeTolerance: relTol } : {}),
    ...(absTol !== undefined ? { absoluteTolerance: absTol } : {}),
  };
  if (model.config.StopTime) report.issues.push({ severity: "info", path: model.name, message: `StopTime do modelo: ${model.config.StopTime} s (o LasecSimul simula continuamente; use pausa/parada)` });
  return { project, report };
}

export function formatSimulinkImportReport(report: SimulinkImportReport): string {
  const lines = [
    `Importação Simulink: ${report.model} (.${report.format})`,
    `Blocos: ${report.blocks} | convertidos: ${report.converted} | subsistemas: ${report.subsystems} | ligações: ${report.lines}`,
    `Tipos: ${Object.entries(report.byType).sort().map(([type, count]) => `${type}×${count}`).join(", ")}`,
  ];
  if (report.unsupported.length > 0) {
    lines.push("", "Sem equivalente (omitidos):");
    for (const item of report.unsupported) lines.push(`  - ${item.path}: ${item.reason}`);
  }
  if (report.workspace.length > 0) lines.push("", `Model Workspace a definir: ${report.workspace.join(", ")}`);
  if (report.issues.length > 0) {
    lines.push("", "Avisos:");
    for (const issue of report.issues) lines.push(`  [${issue.severity}] ${issue.path}: ${issue.message}`);
  }
  return lines.join("\n");
}
