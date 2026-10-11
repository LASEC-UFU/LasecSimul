import { FBD_OPERATORS, FbdOperator, GraphNetwork, GraphNode, IecProjectStore, PouDefinition } from "./iecProject";

export interface FbdLowering { lines: string[]; declarations: string[] }

/** Lower a data-flow FBD network to deterministic ST statements and retained one-scan state. */
export function lowerFbdBodyToSt(pou: PouDefinition, store: IecProjectStore): FbdLowering {
  if (pou.implementation.language !== "fbd") throw new Error("FBD lowering requires an FBD POU");
  const output: string[] = [];
  const declarations: string[] = [];
  const symbols = store.symbols();
  for (const network of pou.implementation.networks) {
    const byId = new Map(network.nodes.map(node => [node.nodeId, node]));
    const incoming = new Map<string, typeof network.edges>();
    const indegree = new Map(network.nodes.map(node => [node.nodeId, 0]));
    const outgoing = new Map<string, string[]>();
    for (const edge of network.edges) {
      if (!byId.has(edge.fromNodeId) || !byId.has(edge.toNodeId)) throw new Error(`FBD edge ${edge.edgeId} references a missing node`);
      incoming.set(edge.toNodeId, [...(incoming.get(edge.toNodeId) ?? []), edge]);
      if (!edge.feedback) {
        indegree.set(edge.toNodeId, (indegree.get(edge.toNodeId) ?? 0) + 1);
        outgoing.set(edge.fromNodeId, [...(outgoing.get(edge.fromNodeId) ?? []), edge.toNodeId]);
      }
    }
    const ready = network.nodes.filter(node => indegree.get(node.nodeId) === 0).sort((a, b) => a.nodeId.localeCompare(b.nodeId));
    const ordered = [] as typeof network.nodes;
    while (ready.length) {
      const node = ready.shift()!;
      ordered.push(node);
      for (const id of outgoing.get(node.nodeId) ?? []) {
        const left = (indegree.get(id) ?? 1) - 1;
        indegree.set(id, left);
        if (!left) { ready.push(byId.get(id)!); ready.sort((a, b) => a.nodeId.localeCompare(b.nodeId)); }
      }
    }
    if (ordered.length !== network.nodes.length) throw new Error(`FBD graph cycle in network ${network.networkId}; marque a ligação de retorno como realimentação`);

    const delayName = (edgeId: string): string => `__FBD_DELAY_${network.networkId}_${edgeId}`.replace(/[^A-Za-z0-9_]/g, "_");
    const edgeType = (edge: (typeof network.edges)[number]): string | undefined => {
      const source = byId.get(edge.fromNodeId);
      if (!source) return undefined;
      if (source.kind === "input" || source.kind === "contact") {
        const raw = source.symbol?.trim() ?? "";
        if (/^(TRUE|FALSE)$/i.test(raw)) return "BOOL";
        if (/^[-+]?\d+$/.test(raw)) return "DINT";
        if (/^[-+]?(?:\d+\.\d*|\d*\.\d+)(?:e[-+]?\d+)?$/i.test(raw)) return "LREAL";
        if (/^".*"$/.test(raw)) return "STRING";
        return pou.interface.variables.find(variable => variable.name.toUpperCase() === raw.toUpperCase())?.type;
      }
      if (source.kind === "block") {
        const target = symbols.find(symbol => symbol.pouId === source.referencedPouId);
        if (target?.kind === "function") return target.interface.returnType;
        return target?.interface.variables.find(variable => variable.name.toUpperCase() === (edge.fromPort ?? "").toUpperCase())?.type;
      }
      if (source.kind === "operator") return source.operator && ["AND", "OR", "XOR", "NOT", "EQ", "NE", "GT", "GE", "LT", "LE"].includes(source.operator) ? "BOOL" : "LREAL";
      if (source.kind === "junction") {
        const input = network.edges.find(candidate => candidate.toNodeId === source.nodeId);
        return input ? edgeType(input) : undefined;
      }
      return undefined;
    };
    for (const edge of network.edges.filter(item => item.feedback)) {
      const type = edgeType(edge);
      if (!type) throw new Error(`FBD feedback ${edge.edgeId} needs a source with a concrete IEC type`);
      const initial = edge.feedbackInitialValue ?? (type.toUpperCase() === "BOOL" ? "FALSE" : type.toUpperCase() === "STRING" ? '""' : "0");
      const name = delayName(edge.edgeId);
      if (declarations.some(declaration => declaration.startsWith(`${name} :`))) throw new Error(`duplicate FBD feedback edge id ${edge.edgeId}`);
      declarations.push(`${name} : ${type} := ${initial};`);
    }

    const values = new Map<string, string>();
    const portValue = (edge: (typeof network.edges)[number]): string => {
      if (edge.feedback) return delayName(edge.edgeId);
      const from = byId.get(edge.fromNodeId)!;
      if (from.kind === "block") {
        const target = symbols.find(symbol => symbol.pouId === from.referencedPouId);
        if (!target) throw new Error(`FBD block ${from.nodeId} has an orphan POU reference`);
        if (target.kind === "function") {
          if (edge.fromPort && !["OUT", target.displayName, target.interface.returnType].some(port => port?.toUpperCase() === edge.fromPort!.toUpperCase())) {
            throw new Error(`FBD function output port ${edge.fromPort} is invalid on ${target.displayName}`);
          }
          const value = values.get(from.nodeId);
          if (!value) throw new Error(`FBD function ${from.nodeId} has no resolved result`);
          return value;
        }
        if (!edge.fromPort) throw new Error(`FBD output connection from ${from.nodeId} needs a port name`);
        const outputPort = target.interface.variables.find(variable => variable.name.toUpperCase() === edge.fromPort!.toUpperCase() && (variable.class === "output" || variable.class === "inOut"));
        if (!outputPort) {
          throw new Error(`FBD output port ${edge.fromPort} does not exist on ${target.displayName}`);
        }
        return `${from.instanceName ?? target.displayName}.${outputPort.name}`;
      }
      if (from.kind === "output" || from.kind === "coil") throw new Error(`FBD output node ${from.nodeId} cannot drive another node`);
      if (from.kind === "operator" && edge.fromPort && edge.fromPort.toUpperCase() !== "OUT") {
        throw new Error(`FBD operator output port ${edge.fromPort} is invalid on ${from.nodeId}`);
      }
      const value = values.get(from.nodeId);
      if (!value) throw new Error(`FBD node ${from.nodeId} does not produce a value`);
      return value;
    };

    for (const node of ordered) {
      const edges = incoming.get(node.nodeId) ?? [];
      if (node.kind === "input" || node.kind === "contact") {
        if (!node.symbol) throw new Error(`FBD input ${node.nodeId} has no variable`);
        values.set(node.nodeId, node.negated ? `NOT (${node.symbol})` : node.symbol);
      } else if (node.kind === "operator") {
        if (!node.operator || !FBD_OPERATORS.includes(node.operator)) throw new Error(`FBD operator ${node.nodeId} is invalid`);
        const args = edges.slice().sort((a, b) => (a.toPort ?? "").localeCompare(b.toPort ?? ""));
        const unary = node.operator === "NOT" || node.operator === "NEG";
        const variadic = ["AND", "OR", "XOR", "ADD", "MUL"].includes(node.operator);
        const expected = unary ? 1 : 2;
        const argumentPorts = args.map(edge => (edge.toPort ?? "").toUpperCase());
        const expectedPorts = args.map((_, index) => String.fromCharCode(65 + index));
        if ((variadic ? args.length < expected : args.length !== expected) || args.some(edge => !/^[A-H]$/.test((edge.toPort ?? "").toUpperCase())) ||
          new Set(argumentPorts).size !== argumentPorts.length || argumentPorts.slice().sort().some((port, index) => port !== expectedPorts[index])) {
          throw new Error(`FBD operator ${node.operator} requires ${variadic ? "at least " : ""}${expected} input port(s)`);
        }
        const operands = args.map(portValue);
        values.set(node.nodeId, fbdExpression(node.operator, operands));
      } else if (node.kind === "junction") {
        if (edges.length !== 1) throw new Error(`FBD junction ${node.nodeId} requires exactly one input`);
        values.set(node.nodeId, portValue(edges[0]!));
      } else if (node.kind === "block") {
        const target = symbols.find(symbol => symbol.pouId === node.referencedPouId);
        if (!target || target.kind === "program") throw new Error(`FBD block ${node.nodeId} has an invalid POU reference`);
        const instance = node.instanceName ?? target.displayName;
        const inputs = target.interface.variables.filter(variable => variable.class === "input" || variable.class === "inOut");
        const formalPorts = edges.map(edge => (edge.toPort ?? "").toUpperCase());
        if (new Set(formalPorts).size !== formalPorts.length) throw new Error(`FBD input port connected more than once on ${target.displayName}`);
        if (target.kind === "functionBlock") {
          for (const edge of edges) {
            const port = edge.toPort;
            if (!port) throw new Error(`FBD input connection to ${node.nodeId} needs a port name`);
            const input = inputs.find(variable => variable.name.toUpperCase() === port.toUpperCase());
            if (!input) throw new Error(`FBD input port ${port} does not exist on ${target.displayName}`);
            output.push(`${instance}.${input.name} := ${portValue(edge)};`);
          }
          output.push(`${instance}();`);
        } else {
          for (const edge of edges) {
            const extensibleInput = target.extensible && /^IN[1-9][0-9]*$/i.test(edge.toPort ?? "");
            if (!edge.toPort || (!inputs.some(variable => variable.name.toUpperCase() === edge.toPort!.toUpperCase()) && !extensibleInput)) {
              throw new Error(`FBD input port ${edge.toPort ?? ""} does not exist on ${target.displayName}`);
            }
          }
          const args = edges.map(edge => {
            const formal = inputs.find(variable => variable.name.toUpperCase() === (edge.toPort ?? "").toUpperCase());
            return `${formal?.name ?? edge.toPort} := ${portValue(edge)}`;
          }).join(", ");
          values.set(node.nodeId, `${target.displayName}(${args})`);
        }
      } else if (node.kind === "output" || node.kind === "coil") {
        if (!node.symbol) throw new Error(`FBD output ${node.nodeId} has no variable`);
        if (!edges.length) throw new Error(`FBD output ${node.nodeId} has no connected input`);
        if (edges.length > 1) throw new Error(`FBD output ${node.nodeId} has more than one connected input`);
        output.push(`${node.symbol} := ${node.negated ? `NOT (${portValue(edges[0]!)})` : portValue(edges[0]!)};`);
      }
    }
    for (const edge of network.edges.filter(item => item.feedback)) output.push(`${delayName(edge.edgeId)} := ${portValue({ ...edge, feedback: false })};`);
  }
  return { lines: output, declarations };
}

/** Backwards-compatible statement-only facade used by older tests and diagnostics. */
export function lowerFbdToSt(pou: PouDefinition, store: IecProjectStore): string[] {
  return lowerFbdBodyToSt(pou, store).lines;
}

export interface FbdDiagnostic { nodeId: string; message: string }

const IEC_INTEGERS = new Set(["SINT", "INT", "DINT", "LINT", "USINT", "UINT", "UDINT", "ULINT"]);
const IEC_REALS = new Set(["REAL", "LREAL"]);
const IEC_NUMERICS = new Set([...IEC_INTEGERS, ...IEC_REALS]);
const IEC_BITS = new Set(["BOOL", "BYTE", "WORD", "DWORD", "LWORD"]);

function matchesIecGeneric(type: string, generic: string): boolean {
  if (generic === "ANY") return true;
  if (generic === "ANY_NUM") return IEC_NUMERICS.has(type) || type === "ANY_INT" || type === "ANY_REAL";
  if (generic === "ANY_INT") return IEC_INTEGERS.has(type) || type === "ANY_INT";
  if (generic === "ANY_REAL") return IEC_REALS.has(type) || type === "ANY_REAL";
  if (generic === "ANY_BIT") return IEC_BITS.has(type);
  if (generic === "ANY_STRING") return type === "STRING" || type === "WSTRING";
  return false;
}

function fbdTypesCompatible(actual: string, expected: string): boolean {
  return actual === expected || matchesIecGeneric(actual, expected) || matchesIecGeneric(expected, actual);
}

/** Editor-time checks for formal port direction and IEC type compatibility. */
export function validateFbd(pou: PouDefinition, store: IecProjectStore): FbdDiagnostic[] {
  if (pou.implementation.language !== "fbd") return [];
  const diagnostics: FbdDiagnostic[] = [];
  try { lowerFbdToSt(pou, store); }
  catch (error) { diagnostics.push({ nodeId: "", message: error instanceof Error ? error.message : String(error) }); }
  const symbols = store.symbols();
  const numeric = IEC_NUMERICS;
  const variableType = (name: string): string | undefined => pou.interface.variables.find(variable => variable.name.toUpperCase() === name.toUpperCase())?.type.toUpperCase();
  const nodeOutputType = (node: GraphNode, port?: string): string | undefined => {
    if (node.kind === "input" || node.kind === "contact") {
      const raw = node.symbol?.trim() ?? "";
      if (/^(TRUE|FALSE)$/i.test(raw)) return "BOOL";
      if (/^[-+]?\d+$/.test(raw)) return "DINT";
      if (/^[-+]?(?:\d+\.\d*|\d*\.\d+)(?:e[-+]?\d+)?$/i.test(raw)) return "LREAL";
      if (/^".*"$/.test(raw)) return "STRING";
      return variableType(raw);
    }
    if (node.kind === "operator") return node.operator && ["AND", "OR", "XOR", "NOT", "EQ", "NE", "GT", "GE", "LT", "LE"].includes(node.operator) ? "BOOL" : "LREAL";
    if (node.kind === "block") {
      const target = symbols.find(symbol => symbol.pouId === node.referencedPouId);
      if (target?.kind === "function") return target.interface.returnType?.toUpperCase();
      return target?.interface.variables.find(variable => variable.name.toUpperCase() === (port ?? "").toUpperCase() && (variable.class === "output" || variable.class === "inOut"))?.type.toUpperCase();
    }
    return undefined;
  };
  const resolvedOutputType = (network: GraphNetwork, node: GraphNode, port?: string, visited = new Set<string>()): string | undefined => {
    const direct = nodeOutputType(node, port);
    if (direct || node.kind !== "junction" || visited.has(node.nodeId)) return direct;
    visited.add(node.nodeId);
    const incoming = network.edges.find(edge => edge.toNodeId === node.nodeId);
    const source = incoming && network.nodes.find(candidate => candidate.nodeId === incoming.fromNodeId);
    return source ? resolvedOutputType(network, source, incoming?.fromPort, visited) : undefined;
  };
  const compatible = fbdTypesCompatible;
  for (const network of pou.implementation.networks) {
    const nodes = new Map(network.nodes.map(node => [node.nodeId, node]));
    for (const node of network.nodes.filter(item => item.kind === "operator")) {
      const operands = network.edges.filter(edge => edge.toNodeId === node.nodeId);
      const types = operands.map(edge => {
        const source = nodes.get(edge.fromNodeId);
        return source ? resolvedOutputType(network, source, edge.fromPort) : undefined;
      }).filter((type): type is string => Boolean(type));
      if (["AND", "OR", "XOR", "NOT"].includes(node.operator ?? "") && types.some(type => type !== "BOOL" && !matchesIecGeneric(type, "ANY_BIT"))) {
        diagnostics.push({ nodeId: node.nodeId, message: `${node.operator} aceita apenas entradas BOOL` });
      }
      if (["ADD", "SUB", "MUL", "DIV", "MOD", "NEG"].includes(node.operator ?? "") && types.some(type => !numeric.has(type) && !matchesIecGeneric(type, "ANY_NUM"))) {
        diagnostics.push({ nodeId: node.nodeId, message: `${node.operator} aceita apenas entradas numéricas` });
      }
      if (["EQ", "NE", "GT", "GE", "LT", "LE"].includes(node.operator ?? "") && types.length === 2) {
        if (!compatible(types[0]!, types[1]!)) diagnostics.push({ nodeId: node.nodeId, message: `operandos incompatíveis: ${types[0]} e ${types[1]}` });
        if (["GT", "GE", "LT", "LE"].includes(node.operator ?? "") && types.some(type => !numeric.has(type) && !matchesIecGeneric(type, "ANY_NUM"))) {
          diagnostics.push({ nodeId: node.nodeId, message: `${node.operator} exige operandos numéricos` });
        }
      }
    }
    for (const node of network.nodes.filter(item => item.kind === "block")) {
      const target = symbols.find(symbol => symbol.pouId === node.referencedPouId);
      if (!target) continue;
      const seenInputs = new Set<string>();
      for (const edge of network.edges.filter(item => item.toNodeId === node.nodeId)) {
        const portName = (edge.toPort ?? "").toUpperCase();
        if (!portName) continue;
        if (seenInputs.has(portName)) diagnostics.push({ nodeId: node.nodeId, message: `entrada ${portName} conectada mais de uma vez` });
        seenInputs.add(portName);
        const formal = target.interface.variables.find(variable => variable.name.toUpperCase() === (edge.toPort ?? "").toUpperCase() && (variable.class === "input" || variable.class === "inOut"));
        if (!formal && !(target.extensible && /^IN[1-9][0-9]*$/i.test(edge.toPort ?? ""))) continue;
      }
    }
    for (const edge of network.edges) {
      const from = nodes.get(edge.fromNodeId);
      const to = nodes.get(edge.toNodeId);
      if (!from || !to) continue;
      let sourceType = resolvedOutputType(network, from, edge.fromPort);
      let targetType: string | undefined;
      if (to.kind === "output" || to.kind === "coil") targetType = to.symbol ? variableType(to.symbol) : undefined;
      else if (to.kind === "operator") {
        const logical = ["AND", "OR", "XOR", "NOT"].includes(to.operator ?? "");
        if (logical && sourceType && sourceType !== "BOOL" && !matchesIecGeneric(sourceType, "ANY_BIT")) diagnostics.push({ nodeId: to.nodeId, message: `${to.operator} espera BOOL, recebeu ${sourceType}` });
        if (["ADD", "SUB", "MUL", "DIV", "MOD", "NEG"].includes(to.operator ?? "") && sourceType && !numeric.has(sourceType) && !matchesIecGeneric(sourceType, "ANY_NUM")) diagnostics.push({ nodeId: to.nodeId, message: `${to.operator} espera tipo numérico, recebeu ${sourceType}` });
        targetType = logical || ["EQ", "NE", "GT", "GE", "LT", "LE"].includes(to.operator ?? "") ? "BOOL" : sourceType;
      } else if (to.kind === "block") {
        const target = symbols.find(symbol => symbol.pouId === to.referencedPouId);
        const formal = target?.interface.variables.find(variable => variable.name.toUpperCase() === (edge.toPort ?? "").toUpperCase() && (variable.class === "input" || variable.class === "inOut"));
        targetType = formal?.type.toUpperCase() ?? (target?.extensible && /^IN[1-9][0-9]*$/i.test(edge.toPort ?? "")
          ? target.interface.variables.find(variable => variable.class === "input")?.type.toUpperCase() : undefined);
      }
      if (sourceType && targetType && !compatible(sourceType, targetType)) diagnostics.push({ nodeId: to.nodeId, message: `tipo incompatível: ${sourceType} ligado a ${targetType}` });
      if ((from.kind === "input" || from.kind === "contact") && !sourceType) diagnostics.push({ nodeId: from.nodeId, message: `variável ou literal FBD não resolvido: ${from.symbol ?? ""}` });
    }
  }
  return diagnostics;
}

function fbdExpression(operator: FbdOperator, operands: string[]): string {
  const unary: Partial<Record<FbdOperator, string>> = { NOT: "NOT", NEG: "-" };
  const binary: Partial<Record<FbdOperator, string>> = {
    AND: "AND", OR: "OR", XOR: "XOR", ADD: "+", SUB: "-", MUL: "*", DIV: "/", MOD: "MOD",
    EQ: "=", NE: "<>", GT: ">", GE: ">=", LT: "<", LE: "<=",
  };
  if (unary[operator]) return `${unary[operator]} (${operands[0]})`;
  const symbol = binary[operator];
  if (!symbol) throw new Error(`unsupported FBD operator ${operator}`);
  return operands.map(value => `(${value})`).join(` ${symbol} `);
}
