import { JUNCTION_TYPE_ID, WebviewComponentModel, WebviewPoint, WebviewWireModel } from "./model.js";

export type CanonicalEndpoint =
  | { kind: "port"; componentId: string; pinId: string }
  | { kind: "node"; nodeId: string };

export interface TopologyNode { id: string; position: WebviewPoint; }
export interface TopologyConductor { id: string; from: CanonicalEndpoint; to: CanonicalEndpoint; vertices: WebviewPoint[]; }
export interface CanonicalTopologyDocument {
  revision: number;
  nodes: TopologyNode[];
  conductors: TopologyConductor[];
}

export function assertTopologyInvariants(document: CanonicalTopologyDocument, componentIds?: ReadonlySet<string>): void {
  const nodeIds = new Set<string>();
  for (const node of document.nodes) {
    if (!node.id || nodeIds.has(node.id)) throw new Error(`nó duplicado/inválido: ${node.id}`);
    if (!Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)) throw new Error(`posição inválida: ${node.id}`);
    nodeIds.add(node.id);
  }
  const conductorIds = new Set<string>();
  const validateEndpoint = (endpoint: CanonicalEndpoint): void => {
    if (endpoint.kind === "node") {
      if (!nodeIds.has(endpoint.nodeId)) throw new Error(`endpoint referencia nó inexistente: ${endpoint.nodeId}`);
    } else if (!endpoint.componentId || !endpoint.pinId || (componentIds && !componentIds.has(endpoint.componentId))) {
      throw new Error(`endpoint de porta inválido: ${endpoint.componentId}:${endpoint.pinId}`);
    }
  };
  for (const conductor of document.conductors) {
    if (!conductor.id || conductorIds.has(conductor.id)) throw new Error(`condutor duplicado/inválido: ${conductor.id}`);
    conductorIds.add(conductor.id);
    validateEndpoint(conductor.from);
    validateEndpoint(conductor.to);
    const same = conductor.from.kind === conductor.to.kind &&
      (conductor.from.kind === "node"
        ? conductor.from.nodeId === (conductor.to as { kind: "node"; nodeId: string }).nodeId
        : conductor.from.componentId === (conductor.to as { kind: "port"; componentId: string; pinId: string }).componentId &&
          conductor.from.pinId === (conductor.to as { kind: "port"; componentId: string; pinId: string }).pinId);
    if (same) throw new Error(`condutor de comprimento topológico zero: ${conductor.id}`);
    for (let i = 1; i < conductor.vertices.length; i += 1) {
      const a = conductor.vertices[i - 1]!;
      const b = conductor.vertices[i]!;
      if (Math.hypot(a.x - b.x, a.y - b.y) < 0.5) throw new Error(`vértices duplicados: ${conductor.id}`);
    }
  }
}

/** Ponte determinística temporária: junction deixa de ser componente no documento canônico. */
export function canonicalTopologyFromLegacy(components: WebviewComponentModel[], wires: WebviewWireModel[], revision = 0, topologyNodes: Array<{ id: string; x: number; y: number }> = []): CanonicalTopologyDocument {
  const junctions = new Map(components.filter((c) => c.typeId === JUNCTION_TYPE_ID).map((c) => [c.id, c]));
  for (const node of topologyNodes) if (!junctions.has(node.id)) junctions.set(node.id, { id: node.id, typeId: JUNCTION_TYPE_ID, label: "Junction", hidden: true, x: node.x, y: node.y, rotation: 0, pins: [{ id: "pin-1", x: 0, y: 0 }], properties: {} });
  const endpoint = (ref: { componentId: string; pinId: string }): CanonicalEndpoint =>
    junctions.has(ref.componentId) ? { kind: "node", nodeId: ref.componentId } : { kind: "port", ...ref };
  const document: CanonicalTopologyDocument = {
    revision,
    nodes: [...junctions.values()].map((c) => ({ id: c.id, position: { x: c.x, y: c.y } })),
    conductors: wires.map((wire) => ({ id: wire.id, from: endpoint(wire.from), to: endpoint(wire.to), vertices: (wire.points ?? []).map((p) => ({ ...p })) })),
  };
  assertTopologyInvariants(document, new Set(components.filter((c) => c.typeId !== JUNCTION_TYPE_ID).map((c) => c.id)));
  return document;
}

export function legacyTopologyFromCanonical(document: CanonicalTopologyDocument): { junctions: WebviewComponentModel[]; wires: WebviewWireModel[] } {
  assertTopologyInvariants(document);
  const ref = (endpoint: CanonicalEndpoint): { componentId: string; pinId: string } => endpoint.kind === "node"
    ? { componentId: endpoint.nodeId, pinId: "pin-1" }
    : { componentId: endpoint.componentId, pinId: endpoint.pinId };
  return {
    junctions: document.nodes.map((node) => ({ id: node.id, typeId: JUNCTION_TYPE_ID, label: "Junction", hidden: true, x: node.position.x, y: node.position.y, rotation: 0, pins: [{ id: "pin-1", x: 0, y: 0 }], properties: {} })),
    wires: document.conductors.map((c) => ({ id: c.id, from: ref(c.from), to: ref(c.to), points: c.vertices.length ? c.vertices.map((p) => ({ ...p })) : undefined })),
  };
}
