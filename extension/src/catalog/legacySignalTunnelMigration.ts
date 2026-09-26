import { ProjectComponent, ProjectTopology } from "../project/ProjectTypes";

type TunnelInterface = { internalTunnel: string; domain?: string; direction?: string };

/** Convert schema v3 signal wiring made with the former dual-domain Tunnel. */
export function migrateLegacySignalTunnels<T extends TunnelInterface>(
  components: ProjectComponent[], topology: ProjectTopology, interfaceEntries: T[] = [],
): { components: ProjectComponent[]; topology: ProjectTopology; interfaceEntries: T[] } {
  const byId = new Map(components.map((component) => [component.id, component]));
  const tunnelsByName = new Map<string, string[]>();
  for (const component of components) {
    if (component.typeId !== "connectors.tunnel") continue;
    const name = component.properties?.name;
    if (typeof name !== "string" || !name) continue;
    const members = tunnelsByName.get(name) ?? [];
    members.push(component.id);
    tunnelsByName.set(name, members);
  }
  const signalIds = new Set<string>();
  for (const entry of interfaceEntries) {
    if (entry.domain === "signal") for (const id of tunnelsByName.get(entry.internalTunnel) ?? []) signalIds.add(id);
  }
  let changed: boolean;
  do {
    changed = false;
    for (const wire of topology.conductors) {
      if (wire.from.kind !== "port" || wire.to.kind !== "port") continue;
      const from = byId.get(wire.from.componentId);
      const to = byId.get(wire.to.componentId);
      if (!from || !to) continue;
      const isSignal = (component: ProjectComponent) => component.typeId.startsWith("control.") ||
        component.typeId === "connectors.signal_tunnel" || signalIds.has(component.id);
      if (from.typeId === "connectors.tunnel" && isSignal(to) && !signalIds.has(from.id)) {
        signalIds.add(from.id); changed = true;
      }
      if (to.typeId === "connectors.tunnel" && isSignal(from) && !signalIds.has(to.id)) {
        signalIds.add(to.id); changed = true;
      }
    }
    for (const members of tunnelsByName.values()) {
      if (!members.some((id) => signalIds.has(id))) continue;
      for (const id of members) if (!signalIds.has(id)) { signalIds.add(id); changed = true; }
    }
  } while (changed);
  if (signalIds.size === 0) return { components, topology, interfaceEntries };

  const migratedComponents = components.map((component) => signalIds.has(component.id)
    ? { ...component, typeId: "connectors.signal_tunnel" } : component);
  const migratedTopology: ProjectTopology = {
    ...topology,
    conductors: topology.conductors.map((wire) => ({
      ...wire,
      from: wire.from.kind === "port" && signalIds.has(wire.from.componentId) && wire.from.pinId === "pin"
        ? { ...wire.from, pinId: "value" } : wire.from,
      to: wire.to.kind === "port" && signalIds.has(wire.to.componentId) && wire.to.pinId === "pin"
        ? { ...wire.to, pinId: "value" } : wire.to,
    })),
  };
  const migratedInterfaces = interfaceEntries.map((entry) => {
    const member = (tunnelsByName.get(entry.internalTunnel) ?? []).find((id) => signalIds.has(id));
    if (!member) return entry;
    const direction = entry.direction === "inout" || !entry.direction
      ? (byId.get(member)?.properties?.direction === "Output" ? "out" : "in") : entry.direction;
    return { ...entry, domain: "signal", direction };
  });
  return { components: migratedComponents, topology: migratedTopology, interfaceEntries: migratedInterfaces };
}
