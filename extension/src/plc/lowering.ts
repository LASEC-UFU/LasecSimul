import { GraphNetwork, IecLanguage, IecProjectStore, PouDefinition, SfcStep, SfcTransition } from "./iecProject";

export interface LoweringResult {
  language: IecLanguage;
  canonicalSt: string;
  sourceMap: Array<{ generatedLine: number; sourceId: string }>;
}

function clean(text: string): string {
  return text.replace(/\r\n/g, "\n").split("\n").map(line => line.replace(/\s+$/g, "")).join("\n").trim();
}

function lowerIl(text: string): string[] {
  const result: string[] = [];
  let accumulator = "FALSE";
  for (const original of clean(text).split("\n")) {
    const line = original.replace(/;.*/, "").trim();
    if (!line) continue;
    const [opcodeRaw, ...operandParts] = line.split(/\s+/);
    const opcode = (opcodeRaw ?? "").toUpperCase();
    const operand = operandParts.join(" ");
    if (opcode === "LD") accumulator = operand;
    else if (opcode === "LDN") accumulator = `NOT (${operand})`;
    else if (opcode === "AND") accumulator = `(${accumulator}) AND (${operand})`;
    else if (opcode === "ANDN") accumulator = `(${accumulator}) AND NOT (${operand})`;
    else if (opcode === "OR") accumulator = `(${accumulator}) OR (${operand})`;
    else if (opcode === "ORN") accumulator = `(${accumulator}) OR NOT (${operand})`;
    else if (opcode === "NOT") accumulator = `NOT (${accumulator})`;
    else if (opcode === "ST") result.push(`${operand} := ${accumulator};`);
    else if (opcode === "STN") result.push(`${operand} := NOT (${accumulator});`);
    else if (opcode === "CAL") result.push(`${operand}();`);
    else throw new Error(`unsupported IL opcode: ${opcode}`);
  }
  return result;
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
  if (pou.implementation.language !== "ld" && pou.implementation.language !== "fbd") return [];
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

function lowerSfcSteps(steps: SfcStep[], transitions: SfcTransition[]): string[] {
  const lines: string[] = [];
  const state = (stepId: string): string => `__SFC_${stepId.replace(/[^A-Za-z0-9_]/g, "_")}`;
  for (const step of steps) {
    lines.push(`IF ${state(step.stepId)} THEN`);
    for (const action of step.actions) {
      if (action.text) lines.push(`  ${clean(action.text)}`);
      else if (action.referencedPouId) lines.push(`  ${action.instanceName ?? action.referencedPouId}();`);
    }
    lines.push("END_IF;");
  }
  for (const transition of transitions) {
    if (!steps.some(step => step.stepId === transition.fromStepId) || !steps.some(step => step.stepId === transition.toStepId)) {
      throw new Error(`SFC transition ${transition.transitionId} references missing step`);
    }
    lines.push(`IF ${state(transition.fromStepId)} AND (${transition.condition}) THEN`);
    lines.push(`  ${state(transition.fromStepId)} := FALSE;`);
    lines.push(`  ${state(transition.toStepId)} := TRUE;`);
    lines.push("END_IF;");
  }
  return lines;
}

export function lowerPouToSt(pou: PouDefinition, symbols: IecProjectStore): LoweringResult {
  let lines: string[];
  switch (pou.implementation.language) {
    case "st": lines = clean(pou.implementation.text).split("\n"); break;
    case "il": lines = lowerIl(pou.implementation.text); break;
    case "ld":
    case "fbd": lines = lowerGraph(pou, symbols); break;
    case "sfc": lines = lowerSfcSteps(pou.implementation.steps, pou.implementation.transitions); break;
  }
  return {
    language: pou.implementation.language,
    canonicalSt: lines.join("\n"),
    sourceMap: lines.map((_, index) => ({ generatedLine: index + 1, sourceId: `${pou.pouId}:${index + 1}` })),
  };
}

function declarationClass(value: string): string {
  if (value === "input") return "VAR_INPUT";
  if (value === "output") return "VAR_OUTPUT";
  if (value === "inOut") return "VAR_IN_OUT";
  return "VAR";
}

export function compileProjectToCanonicalSt(store: IecProjectStore, projectId: string, entryPouId: string): string {
  const project = store.snapshot(projectId);
  if (!project.pous.some(pou => pou.pouId === entryPouId && pou.kind === "program")) {
    throw new Error(`entry PROGRAM ${entryPouId} does not exist`);
  }
  const diagnostics = store.diagnostics();
  if (diagnostics.length) throw new Error(diagnostics.map(item => item.message).join("; "));
  const ordered = [...project.pous].sort((a, b) => (a.pouId === entryPouId ? 1 : b.pouId === entryPouId ? -1 : a.pouId.localeCompare(b.pouId)));
  const chunks: string[] = [];
  for (const pou of ordered) {
    const keyword = pou.kind === "functionBlock" ? "FUNCTION_BLOCK" : pou.kind === "function" ? "FUNCTION" : "PROGRAM";
    chunks.push(`${keyword} ${pou.name}${pou.kind === "function" ? ` : ${pou.interface.returnType}` : ""}`);
    const groups = new Map<string, typeof pou.interface.variables>();
    for (const variable of pou.interface.variables) {
      const key = declarationClass(variable.class);
      groups.set(key, [...(groups.get(key) ?? []), variable]);
    }
    for (const [key, variables] of groups) {
      chunks.push(key);
      for (const variable of variables) chunks.push(`  ${variable.name} : ${variable.type}${variable.initialValue ? ` := ${variable.initialValue}` : ""};`);
      chunks.push("END_VAR");
    }
    const instanceVariables = (pou.references ?? []).flatMap(reference => {
      const target = store.symbols().find(symbol => symbol.pouId === reference.targetPouId);
      return target?.kind === "functionBlock" && reference.instanceName
        ? [`  ${reference.instanceName} : ${target.displayName};`]
        : [];
    });
    if (pou.implementation.language === "sfc" || instanceVariables.length > 0) {
      chunks.push("VAR");
      chunks.push(...instanceVariables);
      if (pou.implementation.language === "sfc") {
        for (const step of pou.implementation.steps) {
          const name = `__SFC_${step.stepId.replace(/[^A-Za-z0-9_]/g, "_")}`;
          chunks.push(`  ${name} : BOOL := ${step.initial ? "TRUE" : "FALSE"};`);
        }
      }
      chunks.push("END_VAR");
    }
    chunks.push(lowerPouToSt(pou, store).canonicalSt);
    chunks.push(`END_${keyword}`, "");
  }
  return chunks.join("\n").trim() + "\n";
}
