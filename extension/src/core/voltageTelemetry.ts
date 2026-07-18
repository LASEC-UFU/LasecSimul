import { CanonicalEndpoint } from "../ui/webview/model";

export interface VoltageProbeCandidate {
  componentId: string;
  pinId: string;
}

/**
 * Escolhe um pino real por rede e o associa a cada condutor geométrico dessa rede.
 *
 * `canProbe` permite ao chamador preferir um endpoint que já exista no Core. Isso é importante
 * para subcircuitos: o primeiro pino encontrado no grafo pode ser uma fronteira ainda não
 * resolvida, enquanto outro pino da mesma rede já é consultável. Antes, essa escolha arbitrária
 * deixava a rede inteira sem cor apesar de existir um endpoint válido.
 */
export function voltageProbesForProject(
  project: { conductors: Array<{ id: string; from: CanonicalEndpoint; to: CanonicalEndpoint }> },
  canProbe: (candidate: VoltageProbeCandidate) => boolean = () => true
): Array<{ wireId: string; componentId: string; pinId: string }> {
  const key = (endpoint: CanonicalEndpoint): string => endpoint.kind === "node"
    ? `n:${endpoint.nodeId}`
    : `p:${JSON.stringify([endpoint.componentId, endpoint.pinId])}`;
  const refs = new Map<string, VoltageProbeCandidate>();
  const adjacency = new Map<string, Set<string>>();
  for (const wire of project.conductors) {
    const a = key(wire.from);
    const b = key(wire.to);
    if (wire.from.kind === "port") refs.set(a, wire.from);
    if (wire.to.kind === "port") refs.set(b, wire.to);
    (adjacency.get(a) ?? (adjacency.set(a, new Set()), adjacency.get(a)!)).add(b);
    (adjacency.get(b) ?? (adjacency.set(b, new Set()), adjacency.get(b)!)).add(a);
  }

  const probeByVertex = new Map<string, VoltageProbeCandidate>();
  const seen = new Set<string>();
  for (const start of adjacency.keys()) {
    if (seen.has(start)) continue;
    const queue = [start];
    const network: string[] = [];
    const candidates: VoltageProbeCandidate[] = [];
    seen.add(start);
    while (queue.length) {
      const current = queue.pop()!;
      network.push(current);
      const candidate = refs.get(current);
      if (candidate) candidates.push(candidate);
      for (const next of adjacency.get(current) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    const probe = candidates.find(canProbe) ?? candidates[0];
    if (probe) for (const vertex of network) probeByVertex.set(vertex, probe);
  }

  return project.conductors.flatMap((wire) => {
    const probe = probeByVertex.get(key(wire.from)) ?? probeByVertex.get(key(wire.to));
    return probe ? [{ wireId: wire.id, ...probe }] : [];
  });
}
