import type { CanonicalEndpoint, WebviewProjectState } from "../ui/webview/model.js";
import type { DslEndpoint } from "./DslTypes.js";
import type { DslDocument, DslValue } from "./DslTypes.js";

function value(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(value).join(", ")}]`;
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "null";
}
function endpoint(endpoint: DslEndpoint | CanonicalEndpoint): string {
  if (endpoint.kind === "tunnel") return `@${endpoint.tunnelId}`;
  if (endpoint.kind === "context") return `${endpoint.direction}${endpoint.portId ? `.${endpoint.portId}` : ""}`;
  return endpoint.kind === "node" ? `node.${endpoint.nodeId}` : `${endpoint.componentId}.${endpoint.pinId}`;
}
export function serializeDsl(document: DslDocument): string {
  const out = [`model ${document.name} {`];
  for (const component of [...document.components].sort((a, b) => a.id.localeCompare(b.id))) {
    out.push(`  component ${component.id} ${component.typeId} {`);
    for (const key of Object.keys(component.properties).sort()) out.push(`    ${key} = ${value(component.properties[key])};`);
    out.push("  }");
  }
  for (const node of [...document.nodes].sort((a, b) => a.id.localeCompare(b.id))) out.push(`  node ${node.id};`);
  for (const wire of [...document.wires].sort((a, b) => a.id.localeCompare(b.id))) out.push(`  wire ${wire.id}: ${endpoint(wire.from)} -> ${endpoint(wire.to)};`);
  out.push("}", ""); return out.join("\n");
}
export function stateToDsl(state: Pick<WebviewProjectState, "components" | "topology">, name = "Circuit"): string {
  return serializeDsl({ name, components: state.components.map((c) => ({ id: c.id, typeId: c.typeId, properties: c.properties as Record<string, DslValue> })), nodes: state.topology.nodes.map((n) => ({ id: n.id })), wires: state.topology.conductors.map((w) => ({ id: w.id, from: w.from, to: w.to })) });
}
