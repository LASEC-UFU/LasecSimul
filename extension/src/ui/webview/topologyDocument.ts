import { CanonicalEndpoint, CanonicalTopologyDocument } from "./model.js";

/** Validação de invariantes do documento canônico de topologia -- roda em toda mutação de edição
 * (`requestConnectEndpoints`/`requestRemoveWire`/`requestRemoveComponent`, `.spec` seção 25.3), não
 * só em save/load. Antes da Fase C completa (`.spec` seção 25.6) este arquivo também continha
 * `canonicalTopologyFromLegacy`/`legacyTopologyFromCanonical`, uma ponte entre o modelo vivo (que
 * usava `components+wires+topologyNodes` separados) e este documento canônico (só usado nas bordas
 * de save/load) -- removida porque não existe mais um "legado" pra converter de/para: `topology:
 * CanonicalTopologyDocument` (`model.ts`) é agora a ÚNICA representação, viva e persistida. */
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
    const vertices = conductor.points ?? [];
    for (let i = 1; i < vertices.length; i += 1) {
      const a = vertices[i - 1]!;
      const b = vertices[i]!;
      if (Math.hypot(a.x - b.x, a.y - b.y) < 0.5) throw new Error(`vértices duplicados: ${conductor.id}`);
    }
  }
}
