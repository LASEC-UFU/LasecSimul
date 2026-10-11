import { GraphNetwork, IecDataType, IecLanguage, IecProjectStore, IecVariable, PouDefinition } from "./iecProject";
import { IlContext, IlMember, lowerIlToSt } from "./ilLowering";
import { lowerLdToSt } from "./ldLowering";
import { lowerFbdBodyToSt } from "./fbdLowering";
import { SfcElement, actionControlSource, lowerSfcToSt } from "./sfcLowering";

export interface LoweringResult {
  language: IecLanguage;
  canonicalSt: string;
  sourceMap: Array<{ generatedLine: number; sourceId: string }>;
}

function clean(text: string): string {
  return text.replace(/\r\n/g, "\n").split("\n").map(line => line.replace(/\s+$/g, "")).join("\n").trim();
}

function orderedNodes(network: GraphNetwork): GraphNetwork["nodes"] {
  const byId = new Map(network.nodes.map(node => [node.nodeId, node]));
  const indegree = new Map(network.nodes.map(node => [node.nodeId, 0]));
  const next = new Map<string, string[]>();
  for (const edge of network.edges) {
    if (!byId.has(edge.fromNodeId) || !byId.has(edge.toNodeId)) throw new Error(`edge ${edge.edgeId} references missing node`);
    indegree.set(edge.toNodeId, (indegree.get(edge.toNodeId) ?? 0) + 1);
    next.set(edge.fromNodeId, [...(next.get(edge.fromNodeId) ?? []), edge.toNodeId]);
  }
  const queue = network.nodes.filter(node => indegree.get(node.nodeId) === 0)
    .sort((a, b) => (a.x ?? 0) - (b.x ?? 0) || a.nodeId.localeCompare(b.nodeId));
  const result: GraphNetwork["nodes"] = [];
  while (queue.length) {
    const node = queue.shift()!;
    result.push(node);
    for (const id of (next.get(node.nodeId) ?? []).sort()) {
      indegree.set(id, (indegree.get(id) ?? 1) - 1);
      if (indegree.get(id) === 0) queue.push(byId.get(id)!);
    }
  }
  if (result.length !== network.nodes.length) throw new Error(`graph cycle in network ${network.networkId}`);
  return result;
}

function lowerGraph(pou: PouDefinition, symbols: IecProjectStore): string[] {
  if (pou.implementation.language !== "ld") return [];
  const lines: string[] = [];
  for (const network of pou.implementation.networks) {
    const nodes = orderedNodes(network);
    const byId = new Map(nodes.map(node => [node.nodeId, node]));
    const incoming = new Map<string, string[]>();
    for (const edge of network.edges) incoming.set(edge.toNodeId, [...(incoming.get(edge.toNodeId) ?? []), edge.fromNodeId]);
    const expressions = new Map<string, string>();
    const expressionFor = (nodeId: string): string => {
      const cached = expressions.get(nodeId);
      if (cached) return cached;
      const node = byId.get(nodeId);
      if (!node) throw new Error(`missing graph node ${nodeId}`);
      const predecessors = (incoming.get(nodeId) ?? []).map(expressionFor);
      const upstream = predecessors.length === 0 ? "TRUE"
        : predecessors.length === 1 ? predecessors[0]!
          : predecessors.map(value => `(${value})`).join(" OR ");
      let result = upstream;
      if (node.kind === "contact" || node.kind === "input") {
        const term = node.symbol ?? "FALSE";
        const own = node.negated ? `NOT (${term})` : term;
        result = upstream === "TRUE" ? own : `(${upstream}) AND (${own})`;
      }
      expressions.set(nodeId, result);
      return result;
    };
    for (const node of nodes) {
      if (node.kind === "coil" || node.kind === "output") {
        if (!node.symbol) throw new Error(`output node ${node.nodeId} has no symbol`);
        const expression = expressionFor(node.nodeId);
        lines.push(`${node.symbol} := ${node.negated ? `NOT (${expression})` : expression};`);
      } else if (node.kind === "block") {
        const target = node.referencedPouId ? symbols.symbols().find(symbol => symbol.pouId === node.referencedPouId) : undefined;
        if (!target) throw new Error(`block node ${node.nodeId} has orphan POU reference`);
        lines.push(`${node.instanceName ?? target.displayName}(); (* ${target.qualifiedName} by pouId=${target.pouId} *)`);
      }
    }
  }
  return lines;
}

/** Erro de tradução de uma linguagem para ST, com o POU e a linha do texto do aluno. */
export interface IecLoweringDiagnostic {
  pouId: string;
  pouName: string;
  line: number;
  message: string;
  /** SFC: passo, transição ou ação onde está o erro. */
  element?: SfcElement;
  severity?: "error" | "warning";
}

export class IecLoweringError extends Error {
  constructor(readonly diagnostics: IecLoweringDiagnostic[]) {
    super(diagnostics.map(item => `${item.pouName}:${item.line}: ${item.message}`).join("; "));
    this.name = "IecLoweringError";
  }
}

/** Tipos que a tradução da IL enxerga a partir de um POU: interface, instâncias de FB das
 * referências, o nome da FUNCTION (valor de retorno) e as interfaces dos FBs e FUNCTIONs do projeto. */
export function ilContextFor(pou: PouDefinition, store: IecProjectStore): IlContext {
  const variables = new Map<string, string>();
  for (const variable of pou.interface.variables) variables.set(variable.name.toUpperCase(), variable.type.trim().toUpperCase());
  const symbols = store.symbols();
  for (const reference of pou.references ?? []) {
    const target = symbols.find(symbol => symbol.pouId === reference.targetPouId);
    if (target?.kind === "functionBlock" && reference.instanceName) variables.set(reference.instanceName.toUpperCase(), target.displayName.toUpperCase());
  }
  if (pou.kind === "function" && pou.interface.returnType) variables.set(pou.name.toUpperCase(), pou.interface.returnType.toUpperCase());
  const functionBlocks = new Map<string, Map<string, IlMember>>();
  const functions = new Map<string, { returnType: string; inputs: string[] }>();
  for (const symbol of symbols) {
    if (symbol.kind === "functionBlock") {
      functionBlocks.set(symbol.displayName.toUpperCase(), new Map(symbol.interface.variables.map(variable => [
        variable.name.toUpperCase(),
        { type: variable.type.trim().toUpperCase(), direction: variable.class === "input" || variable.class === "output" || variable.class === "inOut" ? variable.class : "local" },
      ])));
    } else if (symbol.kind === "function") {
      functions.set(symbol.displayName.toUpperCase(), {
        returnType: (symbol.interface.returnType ?? "BOOL").toUpperCase(),
        inputs: symbol.interface.variables.filter(variable => variable.class === "input").map(variable => variable.name.toUpperCase()),
      });
    }
  }
  return { pouName: pou.name, pouKind: pou.kind, variables, functionBlocks, functions };
}

export interface PouBodyLowering {
  /** Linhas ST com a linha do texto original (ST e IL; corpo da ação no SFC; LD/FBD: índice gerado). */
  lines: Array<{ text: string; sourceLine: number; element?: SfcElement }>;
  /** Variáveis internas da tradução, para o bloco VAR do POU. */
  declarations: string[];
}

export function lowerPouBody(pou: PouDefinition, symbols: IecProjectStore): PouBodyLowering {
  const numbered = (lines: string[]) => lines.map((text, index) => ({ text, sourceLine: index + 1 }));
  switch (pou.implementation.language) {
    case "st": return { lines: numbered(stBodyLines(pou.implementation.text)), declarations: [] };
    case "il": {
      const lowered = lowerIlToSt(pou.implementation.text, ilContextFor(pou, symbols));
      if (lowered.diagnostics.length > 0) {
        throw new IecLoweringError(lowered.diagnostics.map(item => ({ pouId: pou.pouId, pouName: pou.name, line: item.line, message: item.message })));
      }
      return { lines: lowered.lines, declarations: lowered.declarations };
    }
    case "ld": {
      // Modelo do editor LD (grade por rede); sem `rungs`, o formato antigo de nós e arestas.
      if (!pou.implementation.rungs) return { lines: numbered(lowerGraph(pou, symbols)), declarations: [] };
      const lowered = lowerLdToSt(pou, ilContextFor(pou, symbols));
      const errors = lowered.diagnostics.filter(item => item.severity === "error");
      if (errors.length > 0) {
        throw new IecLoweringError(errors.map(item => ({
          pouId: pou.pouId, pouName: pou.name, line: 1, message: item.message, severity: "error",
          ...(item.element ? { element: item.element } : {}),
        })));
      }
      return { lines: lowered.lines, declarations: lowered.declarations };
    }
    case "fbd": {
      const body = lowerFbdBodyToSt(pou, symbols);
      return { lines: numbered(body.lines), declarations: body.declarations };
    }
    case "sfc": {
      const lowered = lowerSfcToSt(pou, ilContextFor(pou, symbols));
      const errors = lowered.diagnostics.filter(item => item.severity === "error");
      if (errors.length > 0) {
        throw new IecLoweringError(errors.map(item => ({
          pouId: pou.pouId, pouName: pou.name, line: item.line ?? 1, message: item.message, severity: "error",
          ...(item.element ? { element: item.element } : {}),
        })));
      }
      return { lines: lowered.lines, declarations: lowered.declarations };
    }
  }
}

export function lowerPouToSt(pou: PouDefinition, symbols: IecProjectStore): LoweringResult {
  const { lines } = lowerPouBody(pou, symbols);
  return {
    language: pou.implementation.language,
    canonicalSt: lines.map(line => line.text).join("\n"),
    sourceMap: lines.map((line, index) => ({ generatedLine: index + 1, sourceId: `${pou.pouId}:${line.sourceLine}` })),
  };
}

function declarationClass(value: string): string {
  if (value === "input") return "VAR_INPUT";
  if (value === "output") return "VAR_OUTPUT";
  if (value === "inOut") return "VAR_IN_OUT";
  if (value === "temp") return "VAR_TEMP";
  if (value === "external") return "VAR_EXTERNAL";
  return "VAR";
}

function dataTypeSource(type: IecDataType): string[] {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(type.name)) throw new Error(`invalid IEC data type name: ${type.name}`);
  if (type.kind === "alias") return [`TYPE ${type.name} : ${type.baseType}${type.initialValue ? ` := ${type.initialValue}` : ""};`, "END_TYPE"];
  if (type.kind === "enum") {
    if (!type.values.length || type.values.some(value => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))) throw new Error(`invalid IEC enumeration ${type.name}`);
    return [`TYPE ${type.name} : (${type.values.join(", ")});`, "END_TYPE"];
  }
  if (type.kind === "struct") {
    if (type.fields.some(field => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field.name))) throw new Error(`invalid IEC structure ${type.name}`);
    return [`TYPE ${type.name} : STRUCT`, ...type.fields.map(field => `  ${field.name} : ${field.type}${field.initialValue ? ` := ${field.initialValue}` : ""};`), "END_STRUCT", "END_TYPE"];
  }
  if (type.kind === "array") {
    if (!type.dimensions.length || type.dimensions.some(bound => !/^-?\d+\s*\.\.\s*-?\d+$/.test(bound))) throw new Error(`invalid IEC array dimensions for ${type.name}`);
    return [`TYPE ${type.name} : ARRAY[${type.dimensions.join(", ")}] OF ${type.elementType};`, "END_TYPE"];
  }
  return [];
}

function variableDeclarations(variables: IecVariable[]): string[] {
  return variables.map(variable => `  ${variable.name} : ${variable.type}${variable.initialValue ? ` := ${variable.initialValue}` : ""};`);
}

/** De onde veio cada linha do ST canônico: erros do STruCpp e do g++ (via #line) apontam para a
 * linha gerada, e o editor mostra o POU e a linha do corpo que o aluno escreveu. */
export interface CanonicalStOrigin {
  pouId: string;
  pouName: string;
  section: "header" | "declaration" | "body";
  /** Linha do corpo (1 = primeira linha do texto do POU), só em `section: "body"`. */
  bodyLine?: number;
  /** Variável declarada nesta linha, em `section: "declaration"`. */
  variableName?: string;
  /** SFC: passo, transição ou ação que gerou a linha. */
  element?: SfcElement;
}

export interface CanonicalStProgram {
  text: string;
  /** `origins[i]` descreve a linha `i + 1` de `text`. */
  origins: CanonicalStOrigin[];
}

/** Corpo ST do jeito que o aluno escreveu: sem `trim()` no início, para a linha 1 do erro ser a
 * linha 1 do editor. */
function stBodyLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n").map(line => line.replace(/\s+$/g, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function generateCanonicalSt(store: IecProjectStore, projectId: string, entryPouId: string): CanonicalStProgram {
  const project = store.snapshot(projectId);
  if (!project.pous.some(pou => pou.pouId === entryPouId && pou.kind === "program")) {
    throw new Error(`entry PROGRAM ${entryPouId} does not exist`);
  }
  const diagnostics = store.diagnostics();
  if (diagnostics.length) throw new Error(diagnostics.map(item => item.message).join("; "));
  const projectNames = new Set(project.pous.map(pou => pou.name.toUpperCase()));
  for (const type of project.dataTypes) {
    if (projectNames.has(type.name.toUpperCase())) throw new Error(`IEC data type ${type.name} conflicts with a POU name`);
  }
  const globals = new Map<string, IecVariable>();
  for (const list of project.globalVariableLists) for (const variable of list.variables) {
    const key = variable.name.toUpperCase();
    if (globals.has(key)) throw new Error(`duplicate IEC global variable ${variable.name}`);
    globals.set(key, variable);
  }
  for (const pou of project.pous) for (const variable of pou.interface.variables.filter(item => item.class === "external")) {
    const global = globals.get(variable.name.toUpperCase());
    if (!global) throw new Error(`${pou.name}.${variable.name} is VAR_EXTERNAL but no matching GVL variable exists`);
    if (global.type.toUpperCase() !== variable.type.toUpperCase()) throw new Error(`${pou.name}.${variable.name} type ${variable.type} differs from its GVL declaration ${global.type}`);
  }
  const ordered = [...project.pous].sort((a, b) => (a.pouId === entryPouId ? 1 : b.pouId === entryPouId ? -1 : a.pouId.localeCompare(b.pouId)));
  const lines: string[] = [];
  const origins: CanonicalStOrigin[] = [];
  const loweringErrors: IecLoweringDiagnostic[] = [];
  const dataTypeNames = new Set<string>();
  for (const type of project.dataTypes) {
    if (dataTypeNames.has(type.name.toUpperCase())) throw new Error(`duplicate IEC data type: ${type.name}`);
    dataTypeNames.add(type.name.toUpperCase());
    for (const line of dataTypeSource(type)) {
      lines.push(line);
      origins.push({ pouId: entryPouId, pouName: project.pous.find(pou => pou.pouId === entryPouId)!.name, section: "header" });
    }
    lines.push("");
    origins.push({ pouId: entryPouId, pouName: project.pous.find(pou => pou.pouId === entryPouId)!.name, section: "header" });
  }
  // SFC: o bloco ACTION_CONTROL da norma, uma vez por projeto, antes dos POUs que o instanciam.
  const firstSfc = ordered.find(pou => pou.implementation.language === "sfc");
  if (firstSfc) {
    for (const line of actionControlSource()) {
      lines.push(line);
      origins.push({ pouId: firstSfc.pouId, pouName: firstSfc.name, section: "header" });
    }
    lines.push("");
    origins.push({ pouId: firstSfc.pouId, pouName: firstSfc.name, section: "header" });
  }
  for (const pou of ordered) {
    const emit = (line: string, origin: Omit<CanonicalStOrigin, "pouId" | "pouName">): void => {
      lines.push(line);
      origins.push({ pouId: pou.pouId, pouName: pou.name, ...origin });
    };
    const keyword = pou.kind === "functionBlock" ? "FUNCTION_BLOCK" : pou.kind === "function" ? "FUNCTION" : "PROGRAM";
    emit(`${keyword} ${pou.name}${pou.kind === "function" ? ` : ${pou.interface.returnType}` : ""}`, { section: "header" });
    const groups = new Map<string, typeof pou.interface.variables>();
    for (const variable of pou.interface.variables) {
      const key = variable.class === "local" && variable.retain ? "VAR RETAIN" : declarationClass(variable.class);
      groups.set(key, [...(groups.get(key) ?? []), variable]);
    }
    for (const [key, variables] of groups) {
      emit(key, { section: "header" });
      for (const variable of variables) {
        emit(`  ${variable.name} : ${variable.type}${variable.initialValue ? ` := ${variable.initialValue}` : ""};`,
          { section: "declaration", variableName: variable.name });
      }
      emit("END_VAR", { section: "header" });
    }
    const instanceVariables = (pou.references ?? []).flatMap(reference => {
      const target = store.symbols().find(symbol => symbol.pouId === reference.targetPouId);
      return target?.kind === "functionBlock" && reference.instanceName
        ? [`  ${reference.instanceName} : ${target.displayName};`]
        : [];
    });
    let body: PouBodyLowering;
    try {
      body = lowerPouBody(pou, store);
    } catch (error) {
      if (!(error instanceof IecLoweringError)) throw error;
      loweringErrors.push(...error.diagnostics);
      continue;
    }
    if (instanceVariables.length > 0 || body.declarations.length > 0) {
      emit("VAR", { section: "header" });
      for (const line of instanceVariables) emit(line, { section: "header" });
      for (const line of body.declarations) emit(line, { section: "header" });
      emit("END_VAR", { section: "header" });
    }
    for (const line of body.lines) emit(line.text, { section: "body", bodyLine: line.sourceLine, ...(line.element ? { element: line.element } : {}) });
    emit(`END_${keyword}`, { section: "header" });
    emit("", { section: "header" });
  }
  const globalVariables = project.globalVariableLists.flatMap(list => list.variables);
  const resources = project.resources.filter(item => item && typeof item === "object") as Array<{ name?: unknown; task?: unknown; tasks?: unknown }>;
  const tasks = project.tasks.filter(item => item && typeof item === "object") as Array<{ name?: unknown; intervalMs?: unknown; priority?: unknown; eventVariable?: unknown }>;
  const instances = project.programInstances.filter(item => item && typeof item === "object") as Array<{ name?: unknown; pouId?: unknown; task?: unknown }>;
  if (globalVariables.length > 0 || resources.length > 0 || tasks.length > 0 || instances.length > 0) {
    const configuration = project.configurations.find(item => item && typeof item === "object" && (item as { name?: unknown }).name === project.buildSettings.entryConfiguration) ??
      project.configurations[0];
    const configurationName = configuration && typeof configuration === "object" && typeof (configuration as { name?: unknown }).name === "string"
      ? (configuration as { name: string }).name : "CONFIGURATION_1";
    const firstPou = project.pous.find(pou => pou.pouId === entryPouId)!;
    const emitGlobal = (line: string): void => { lines.push(line); origins.push({ pouId: firstPou.pouId, pouName: firstPou.name, section: "header" }); };
    emitGlobal(`CONFIGURATION ${configurationName}`);
    for (const [retained, variables] of [false, true].map(retained => [retained, globalVariables.filter(variable => Boolean(variable.retain) === retained)] as const)) {
      if (variables.length === 0) continue;
      emitGlobal(retained ? "VAR_GLOBAL RETAIN" : "VAR_GLOBAL");
      for (const line of variableDeclarations(variables)) emitGlobal(line);
      emitGlobal("END_VAR");
    }
    for (const resource of resources) {
      if (typeof resource.name !== "string") continue;
      emitGlobal(`RESOURCE ${resource.name} ON PLC`);
      const assignedTasks = Array.isArray(resource.tasks)
        ? resource.tasks.filter((value): value is string => typeof value === "string")
        : typeof resource.task === "string" ? [resource.task] : [];
      for (const task of tasks) {
        if (typeof task.name !== "string" || (assignedTasks.length > 0 && !assignedTasks.includes(task.name))) continue;
        const priority = Math.max(0, Math.round(Number(task.priority) || 0));
        if (typeof task.eventVariable === "string" && task.eventVariable.trim()) {
          emitGlobal(`  TASK ${task.name}(SINGLE := ${task.eventVariable.trim()}, PRIORITY := ${priority});`);
        } else {
          const period = Number(task.intervalMs);
          const periodLiteral = Number.isFinite(period) && period > 0 ? `T#${period}ms` : "T#10ms";
          emitGlobal(`  TASK ${task.name}(INTERVAL := ${periodLiteral}, PRIORITY := ${priority});`);
        }
        for (const instance of instances) {
          const pou = project.pous.find(candidate => candidate.pouId === instance.pouId);
          if (pou?.kind === "program" && (instance.task === task.name || !instance.task)) {
            emitGlobal(`  PROGRAM ${String(instance.name ?? pou.name)} WITH ${task.name} : ${pou.name};`);
          }
        }
      }
      emitGlobal("END_RESOURCE");
    }
    emitGlobal("END_CONFIGURATION");
  }
  if (loweringErrors.length > 0) throw new IecLoweringError(loweringErrors);
  while (lines.length > 0 && lines[lines.length - 1] === "") { lines.pop(); origins.pop(); }
  return { text: lines.join("\n") + "\n", origins };
}

export function compileProjectToCanonicalSt(store: IecProjectStore, projectId: string, entryPouId: string): string {
  return generateCanonicalSt(store, projectId, entryPouId).text;
}
