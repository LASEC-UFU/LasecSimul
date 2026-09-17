#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.join(repoRoot, "subcircuits");
const files = fs.readdirSync(root).filter((name) => name.startsWith("tdps_") && name.endsWith(".lssubcircuit"));
const rebuildFromGit = process.argv.includes("--rebuild-from-git");

function pinOffsetY(component, pinId) {
  if (component.typeId === "control.pid") return pinId === "sp" ? 16 : 32;
  if (component.typeId === "control.process") return pinId === "in" ? 16 : 24;
  if (component.typeId === "control.observer") return 24;
  if (component.typeId === "control.calc_expression") {
    if (pinId.startsWith("x")) return 16 + Number(pinId.slice(1) || 0) * 16;
    const inputs = Array.isArray(component.properties?.inputs) ? component.properties.inputs.length : 1;
    return 24 + Math.max(0, inputs - 1) * 8;
  }
  if (/^in\d+$/.test(pinId)) return 16 + Number(pinId.slice(2)) * 16;
  return pinId === "out" ? 32 : 16;
}

function componentHeight(component) {
  if (component.typeId === "control.calc_expression") {
    const inputs = Array.isArray(component.properties?.inputs) ? component.properties.inputs.length : 1;
    return Math.max(48, 32 + inputs * 16);
  }
  if (component.typeId === "control.pid") return 64;
  return 48;
}

function consolidateFanout(document) {
  let byId = new Map(document.components.map((component) => [component.id, component]));
  const sourceGroups = new Map();
  for (const conductor of document.topology.conductors) {
    if (!String(conductor.id).endsWith("-from")) continue;
    const source = byId.get(conductor.from.componentId);
    const tunnel = byId.get(conductor.to.componentId);
    if (!source || tunnel?.typeId !== "connectors.tunnel") continue;
    const key = `${conductor.from.componentId}:${conductor.from.pinId}`;
    const group = sourceGroups.get(key) ?? [];
    group.push({ conductor, source, tunnel, baseId: String(conductor.id).slice(0, -5) });
    sourceGroups.set(key, group);
  }
  const removeComponents = new Set();
  const removeConductors = new Set();
  for (const [key, group] of sourceGroups) {
    const netName = key.replace(":", ".");
    const primary = group[0];
    for (const item of group) {
      const destination = byId.get(`tunnel-${item.baseId}-to`);
      item.tunnel.label = netName;
      item.tunnel.properties = { name: netName };
      if (destination) {
        destination.label = netName;
        destination.properties = { name: netName };
      }
      if (item !== primary) {
        removeComponents.add(item.tunnel.id);
        removeConductors.add(item.conductor.id);
      }
    }
  }
  document.components = document.components.filter((component) => !removeComponents.has(component.id));
  document.topology.conductors = document.topology.conductors.filter((conductor) => !removeConductors.has(conductor.id));
  byId = new Map(document.components.map((component) => [component.id, component]));
  return byId;
}

function optimizeTdpsLayout(document) {
  const originalY = new Map(document.components.map((component) => [component.id, component.visual?.y ?? 0]));
  const byId = consolidateFanout(document);
  const blocks = document.components.filter((component) => component.typeId.startsWith("control."));
  const blockIds = new Set(blocks.map((component) => component.id));
  const netSources = new Map();
  const netTargets = new Map();
  const externalRoots = new Set();
  for (const conductor of document.topology.conductors) {
    const from = byId.get(conductor.from.componentId);
    const to = byId.get(conductor.to.componentId);
    if (!from || !to) continue;
    if (blockIds.has(from.id) && to.typeId === "connectors.tunnel" && !to.properties?.pinId) {
      netSources.set(String(to.properties?.name ?? ""), from.id);
    }
    if (from.typeId === "connectors.tunnel" && !from.properties?.pinId && blockIds.has(to.id)) {
      const name = String(from.properties?.name ?? "");
      const targets = netTargets.get(name) ?? [];
      targets.push(to.id);
      netTargets.set(name, targets);
    }
    if (from.typeId === "connectors.tunnel" && from.properties?.direction === "Input" && blockIds.has(to.id)) {
      externalRoots.add(to.id);
    }
  }
  const adjacency = new Map(blocks.map((component) => [component.id, []]));
  const indegree = new Map(blocks.map((component) => [component.id, 0]));
  for (const [name, sourceId] of netSources) {
    for (const targetId of netTargets.get(name) ?? []) {
      if (sourceId === targetId || !blockIds.has(targetId)) continue;
      adjacency.get(sourceId).push(targetId);
      indegree.set(targetId, (indegree.get(targetId) ?? 0) + 1);
    }
  }
  const roots = blocks.filter((component) => externalRoots.has(component.id) || (indegree.get(component.id) ?? 0) === 0).map((component) => component.id);
  const layer = new Map(roots.map((id) => [id, 0]));
  const queue = [...roots];
  while (queue.length > 0) {
    const sourceId = queue.shift();
    const nextLayer = Math.min(7, (layer.get(sourceId) ?? 0) + 1);
    for (const targetId of adjacency.get(sourceId) ?? []) {
      if (layer.has(targetId) && layer.get(targetId) <= nextLayer) continue;
      layer.set(targetId, nextLayer);
      queue.push(targetId);
    }
  }
  for (const component of blocks) if (!layer.has(component.id)) layer.set(component.id, 1);
  const columns = new Map();
  for (const component of blocks) {
    const column = layer.get(component.id) ?? 0;
    const items = columns.get(column) ?? [];
    items.push(component);
    columns.set(column, items);
  }
  for (const [column, items] of columns) {
    items.sort((a, b) => (originalY.get(a.id) ?? 0) - (originalY.get(b.id) ?? 0) || a.id.localeCompare(b.id));
    let y = 80;
    for (const component of items) {
      component.visual = { ...component.visual, x: 220 + column * 280, y };
      y += componentHeight(component) + 72;
    }
  }

  for (const conductor of document.topology.conductors) {
    const from = byId.get(conductor.from.componentId);
    const to = byId.get(conductor.to.componentId);
    if (!from || !to) continue;
    if (blockIds.has(from.id) && to.typeId === "connectors.tunnel") {
      const boundary = to.properties?.direction === "Output";
      to.visual = { x: from.visual.x + (boundary ? 180 : 160), y: from.visual.y + pinOffsetY(from, conductor.from.pinId) + (boundary ? 48 : 0), rotation: 0 };
    } else if (from.typeId === "connectors.tunnel" && blockIds.has(to.id)) {
      from.visual = { x: to.visual.x - (from.properties?.direction === "Input" ? 120 : 60), y: to.visual.y + pinOffsetY(to, conductor.to.pinId), rotation: from.properties?.direction === "Input" ? 0 : 180 };
    }
    conductor.points = [];
  }
}

function optimizeBasicFlow(document) {
  const byId = new Map(document.components.map((component) => [component.id, component]));
  const positions = {
    "pid-01": [180, 320], "process-21": [440, 320], "calc-41": [760, 280], "calc-42": [760, 440],
    "readout-104": [440, 480], "readout-105": [180, 240], "readout-106": [440, 200],
    "tunnel-external-14": [80, 336], "tunnel-external-40": [80, 352], "tunnel-external-97": [660, 296],
    "tunnel-external-81": [660, 328], "tunnel-external-82": [660, 344], "tunnel-external-98": [660, 360],
    "tunnel-external-15": [660, 456], "tunnel-external-96": [340, 224],
    "tunnel-output-00": [340, 416], "tunnel-output-21": [600, 416],
    "tunnel-output-41": [920, 336], "tunnel-output-42": [920, 464],
  };
  for (const [id, [x, y]] of Object.entries(positions)) {
    const component = byId.get(id);
    if (component) component.visual = { ...component.visual, x, y };
  }

  const pinY = (component, pinId) => {
    if (component.typeId === "control.pid") return pinId === "sp" ? 16 : 32;
    if (component.typeId === "control.process") return pinId === "in" ? 16 : 24;
    if (component.typeId === "control.observer") return 24;
    if (component.typeId === "control.calc_expression") {
      if (pinId.startsWith("x")) return 16 + Number(pinId.slice(1) || 0) * 16;
      const inputs = Array.isArray(component.properties?.inputs) ? component.properties.inputs.length : 1;
      return 24 + Math.max(0, inputs - 1) * 8;
    }
    return 24;
  };

  const sourceGroups = new Map();
  for (const conductor of document.topology.conductors) {
    if (!String(conductor.id).endsWith("-from")) continue;
    const source = byId.get(conductor.from.componentId);
    const tunnel = byId.get(conductor.to.componentId);
    if (!source || tunnel?.typeId !== "connectors.tunnel") continue;
    const key = `${conductor.from.componentId}:${conductor.from.pinId}`;
    const group = sourceGroups.get(key) ?? [];
    group.push({ conductor, source, tunnel, baseId: String(conductor.id).slice(0, -5) });
    sourceGroups.set(key, group);
  }
  const removeComponents = new Set();
  const removeConductors = new Set();
  for (const [key, group] of sourceGroups) {
    const netName = key.replace(":", ".");
    const primary = group[0];
    primary.tunnel.label = netName;
    primary.tunnel.properties = { name: netName };
    primary.tunnel.visual = { x: primary.source.visual.x + 160, y: primary.source.visual.y + pinY(primary.source, primary.conductor.from.pinId), rotation: 0 };
    for (const item of group) {
      const destination = byId.get(`tunnel-${item.baseId}-to`);
      if (destination) {
        const targetWire = document.topology.conductors.find((wire) => wire.id === `${item.baseId}-to`);
        const target = targetWire ? byId.get(targetWire.to.componentId) : undefined;
        destination.label = netName;
        destination.properties = { name: netName };
        if (target && targetWire) destination.visual = { x: target.visual.x - 60, y: target.visual.y + pinY(target, targetWire.to.pinId), rotation: 180 };
      }
      if (item !== primary) {
        removeComponents.add(item.tunnel.id);
        removeConductors.add(item.conductor.id);
      }
    }
  }
  document.components = document.components.filter((component) => !removeComponents.has(component.id));
  document.topology.conductors = document.topology.conductors.filter((conductor) => !removeConductors.has(conductor.id));
}

for (const name of files) {
  const filePath = path.join(root, name);
  const source = rebuildFromGit
    ? execFileSync("git", ["show", `HEAD:subcircuits/${name}`], { cwd: repoRoot, encoding: "utf8" })
    : fs.readFileSync(filePath, "utf8");
  const document = JSON.parse(source);
  document.workspaceSection = "process";
  const positions = new Map((document.components ?? []).map((component) => [component.id, component.visual ?? { x: 0, y: 0 }]));
  for (const component of document.components ?? []) {
    if (component.typeId !== "connectors.signal_tunnel") continue;
    component.typeId = "connectors.tunnel";
    component.properties = { ...component.properties, pinId: component.properties?.name ?? "pin" };
  }
  for (const component of document.components ?? []) {
    if (component.typeId === "control.probe" && component.properties?.observerOnly === true) component.typeId = "control.observer";
  }
  for (const component of document.components ?? []) {
    if (component.typeId === "connectors.tunnel" && String(component.id).startsWith("tunnel-wire-")) {
      delete component.properties?.pinId;
    }
  }
  const componentById = new Map((document.components ?? []).map((component) => [component.id, component]));
  for (const conductor of document.topology?.conductors ?? []) {
    const names = [conductor.from, conductor.to].map((endpoint) => {
      const candidate = componentById.get(endpoint.componentId);
      if (!candidate || candidate.typeId !== "connectors.tunnel") return undefined;
      return candidate.properties?.pinId ?? candidate.properties?.name;
    }).filter((value) => typeof value === "string" && value.trim());
    const tunnelName = names[0] ?? conductor.id;
    if (names.length > 0) continue;
    for (const side of ["from", "to"]) {
      const component = componentById.get(conductor[side].componentId);
      if (!component || component.typeId === "connectors.tunnel") continue;
      const id = `tunnel-${conductor.id}-${side}`;
      if (componentById.has(id)) continue;
      const direction = side === "from" ? 1 : -1;
      const tunnel = {
        id,
        typeId: "connectors.tunnel",
        label: tunnelName,
        properties: { name: tunnelName },
        visual: { x: (component.visual?.x ?? 0) + direction * 48, y: component.visual?.y ?? 0, rotation: direction > 0 ? 0 : 180 },
      };
      document.components.push(tunnel);
      componentById.set(id, tunnel);
    }
  }
  const conductors = document.topology?.conductors ?? [];
  if (!conductors.some((conductor) => /-(from|to)$/.test(String(conductor.id)))) {
    document.topology.conductors = conductors.flatMap((conductor) => {
      const fromComponent = componentById.get(conductor.from.componentId);
      const toComponent = componentById.get(conductor.to.componentId);
      if (fromComponent?.typeId === "connectors.tunnel" || toComponent?.typeId === "connectors.tunnel") {
        return [{ ...conductor, points: [] }];
      }
      const local = [];
      for (const side of ["from", "to"]) {
        const endpoint = conductor[side];
        const component = componentById.get(endpoint.componentId);
        if (!component || component.typeId === "connectors.tunnel") continue;
        const tunnelId = `tunnel-${conductor.id}-${side}`;
        const tunnelEndpoint = { kind: "port", componentId: tunnelId, pinId: "pin" };
        local.push(side === "from"
          ? { id: `${conductor.id}-from`, from: endpoint, to: tunnelEndpoint, points: [] }
          : { id: `${conductor.id}-to`, from: tunnelEndpoint, to: endpoint, points: [] });
      }
      return local;
    });
  }
  for (const conductor of document.topology?.conductors ?? []) {
    delete conductor.hidden;
    for (const endpoint of [conductor.from, conductor.to]) {
      if (document.components.find((component) => component.id === endpoint.componentId)?.typeId === "connectors.tunnel") {
        endpoint.pinId = "pin";
      }
    }
    conductor.points = [];
    delete conductor.vertices;
  }
  if (name === "tdps_basic_flow_loop.lssubcircuit") optimizeBasicFlow(document);
  else optimizeTdpsLayout(document);
  fs.writeFileSync(filePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  console.log(`[tdps-migrate] ${name}`);
}
