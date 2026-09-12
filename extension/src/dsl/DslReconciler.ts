import type { CanonicalEndpoint, WebviewComponentCatalogEntry, WebviewComponentModel, WebviewProjectState } from "../ui/webview/model.js";
import { DEFAULT_PIN_SENTINEL } from "./DslTypes.js";
import type { DslDocument, DslDiagnostic, DslEndpoint, DslReconcileResult } from "./DslTypes.js";

const diag = (message: string, severity: "error" | "warning" = "error"): DslDiagnostic => ({ message, line: 1, column: 1, severity });
export function reconcileDsl(document: DslDocument, previous: WebviewProjectState, catalog: WebviewComponentCatalogEntry[]): DslReconcileResult {
  const errors: DslDiagnostic[] = []; const catalogByType = new Map(catalog.map((entry) => [entry.typeId, entry])); const ids = new Set<string>();
  const oldById = new Map(previous.components.map((c) => [c.id, c]));
  const components: WebviewComponentModel[] = [];
  for (const source of document.components) {
    if (ids.has(source.id)) errors.push(diag(`ID duplicado '${source.id}'`)); ids.add(source.id);
    const descriptor = catalogByType.get(source.typeId); if (!descriptor) { errors.push(diag(`tipo de componente desconhecido '${source.typeId}'`)); continue; }
    const old = oldById.get(source.id); const knownProperties = new Set((descriptor.propertySchema ?? []).map((p) => p.id));
    for (const property of Object.keys(source.properties)) if (descriptor.propertySchema && !knownProperties.has(property) && !(property in (descriptor.defaultProperties ?? {}))) errors.push(diag(`propriedade desconhecida '${source.id}.${property}'`));
    const pins = descriptor.pinIds?.map((id, index) => ({ id, x: 0, y: index * 12 })) ?? Array.from({ length: descriptor.pinCount }, (_, index) => ({ id: `pin-${index + 1}`, x: 0, y: index * 12 }));
    components.push({ ...(old ?? { id: source.id, x: 100 + components.length * 80, y: 100 + components.length * 60, rotation: 0 as const }), id: source.id, typeId: source.typeId, pins, properties: { ...(descriptor.defaultProperties ?? {}), ...source.properties } as Record<string, string | number | boolean>, label: old?.label ?? source.id });
  }
  const componentIds = new Set(components.map((c) => c.id)); const nodeIds = new Set(document.nodes.map((n) => n.id));
  // A bare compact-syntax reference (`A -> Type(...) -> B`, no explicit
  // `.pin`) arrives as `DEFAULT_PIN_SENTINEL` -- the parser has no catalog
  // access to pick a real pin id. Resolve it HERE, where the component's
  // actual, ordered pin list is known: the first declared pin for the
  // receiving side of a wire (`to`), the last declared pin for the sending
  // side (`from`). This mirrors the conventional 2-terminal passive wiring
  // order (current flows pin[0] -> ... -> pin[last]) and degrades the same
  // way for N-pin components; it is real catalog-declared data, not a
  // second invented pin-naming scheme.
  const endpoint = (e: DslEndpoint, role: "from" | "to"): CanonicalEndpoint | undefined => {
    if (e.kind === "node") return e;
    if (e.kind === "port") {
      if (e.pinId !== DEFAULT_PIN_SENTINEL) return e;
      const pins = components.find((c) => c.id === e.componentId)?.pins;
      if (!pins || pins.length === 0) return undefined;
      return { kind: "port", componentId: e.componentId, pinId: (role === "to" ? pins[0] : pins[pins.length - 1])!.id };
    }
    if (e.kind === "tunnel") { const id = `tunnel:${e.tunnelId}`; nodeIds.add(id); return { kind: "node", nodeId: id }; }
    const id = `context:${e.direction}:${e.portId ?? "default"}`; nodeIds.add(id); return { kind: "node", nodeId: id };
  };
  for (const node of document.nodes) if (ids.has(node.id)) errors.push(diag(`ID duplicado '${node.id}'`)); else ids.add(node.id);
  const validEndpoint = (e: DslDocument["wires"][number]["from"], role: "from" | "to"): boolean => { const c = endpoint(e, role); return Boolean(c && (c.kind === "node" ? nodeIds.has(c.nodeId) : componentIds.has(c.componentId) && Boolean(components.find((x) => x.id === c.componentId)?.pins.some((p) => p.id === c.pinId)))); };
  const oldWires = new Map(previous.topology.conductors.map((w) => [w.id, w])); const conductors = [];
  for (const wire of document.wires) {
    if (ids.has(wire.id)) errors.push(diag(`ID duplicado '${wire.id}'`)); ids.add(wire.id);
    if (!validEndpoint(wire.from, "from") || !validEndpoint(wire.to, "to")) { errors.push(diag(`endpoint inválido na conexão '${wire.id}'`)); continue; }
    const from = endpoint(wire.from, "from")!; const to = endpoint(wire.to, "to")!; const old = oldWires.get(wire.id); conductors.push({ id: wire.id, from, to, ...(old && JSON.stringify([old.from, old.to]) === JSON.stringify([from, to]) ? { points: old.points } : {}) });
  }
  if (errors.length) return { diagnostics: errors };
  const oldNodes = new Map(previous.topology.nodes.map((n) => [n.id, n]));
  return { diagnostics: [], state: { components, topology: { revision: previous.topology.revision + 1, nodes: document.nodes.map((n, index) => oldNodes.get(n.id) ?? { id: n.id, position: { x: 180 + index * 50, y: 180 } }), conductors } } };
}
