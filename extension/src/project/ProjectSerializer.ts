import * as fs from "fs/promises";
import * as path from "path";
import {
  LS_PROJ_SCHEMA_VERSION,
  ProjectComponent,
  ProjectDocument,
  ProjectSubcircuitRef,
  ProjectTopology,
  ProjectTopologyEndpoint,
  ProjectWire,
  createEmptyProject,
} from "./ProjectTypes";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string");
  return out.length > 0 ? out : undefined;
}

function validateSubcircuitRef(value: unknown): ProjectSubcircuitRef | undefined {
  if (!isObject(value)) return undefined;
  const path = asString(value.path);
  if (!path) return undefined;
  return {
    path,
    lastKnownTypeId: asString(value.lastKnownTypeId),
    lastKnownPinIds: asStringArray(value.lastKnownPinIds),
  };
}

function validateComponent(component: unknown, index: number): ProjectComponent {
  if (!isObject(component)) throw new Error(`components[${index}] inválido`);
  const id = asString(component.id);
  const typeId = asString(component.typeId);
  if (!id) throw new Error(`components[${index}].id ausente`);
  if (!typeId) throw new Error(`components[${index}].typeId ausente`);
  const visual = isObject(component.visual) ? component.visual : undefined;
  return {
    id,
    typeId,
    properties: isObject(component.properties) ? component.properties : {},
    label: asString(component.label),
    showId: asBoolean(component.showId),
    showValue: asBoolean(component.showValue),
    valueLabelPropertyKey: asString(component.valueLabelPropertyKey),
    flipH: asBoolean(component.flipH),
    flipV: asBoolean(component.flipV),
    visual: visual
      ? {
          x: asNumber(visual.x),
          y: asNumber(visual.y),
          rotation: visual.rotation === 90 || visual.rotation === 180 || visual.rotation === 270
            ? visual.rotation
            : 0,
        }
      : undefined,
    subcircuitRef: validateSubcircuitRef(component.subcircuitRef),
  };
}

function validateWire(wire: unknown, index: number): ProjectWire {
  if (!isObject(wire)) throw new Error(`wires[${index}] inválido`);
  const id = asString(wire.id);
  const from = isObject(wire.from) ? wire.from : undefined;
  const to = isObject(wire.to) ? wire.to : undefined;
  if (!id) throw new Error(`wires[${index}].id ausente`);
  if (!from || !to) throw new Error(`wires[${index}] precisa de from/to`);
  const fromComponentId = asString(from.componentId);
  const fromPinId = asString(from.pinId);
  const toComponentId = asString(to.componentId);
  const toPinId = asString(to.pinId);
  if (!fromComponentId || !fromPinId || !toComponentId || !toPinId) {
    throw new Error(`wires[${index}] precisa de componentId/pinId em from/to`);
  }
  return {
    id,
    from: { componentId: fromComponentId, pinId: fromPinId },
    to: { componentId: toComponentId, pinId: toPinId },
  };
}

function validateTopologyEndpoint(value: unknown, context: string): ProjectTopologyEndpoint {
  if (!isObject(value)) throw new Error(`${context} inválido`);
  if (value.kind === "node") {
    const nodeId = asString(value.nodeId);
    if (!nodeId) throw new Error(`${context}.nodeId ausente`);
    return { kind: "node", nodeId };
  }
  if (value.kind === "port") {
    const componentId = asString(value.componentId);
    const pinId = asString(value.pinId);
    if (!componentId || !pinId) throw new Error(`${context} precisa de componentId/pinId`);
    return { kind: "port", componentId, pinId };
  }
  throw new Error(`${context}.kind inválido`);
}

function validateTopology(value: unknown, componentIds: ReadonlySet<string>): ProjectTopology {
  if (!isObject(value)) throw new Error("topology ausente/inválida");
  const nodes = Array.isArray(value.nodes) ? value.nodes.map((entry, index) => {
    if (!isObject(entry) || !isObject(entry.position)) throw new Error(`topology.nodes[${index}] inválido`);
    const id = asString(entry.id); const x = asNumber(entry.position.x); const y = asNumber(entry.position.y);
    if (!id || x === undefined || y === undefined) throw new Error(`topology.nodes[${index}] incompleto`);
    return { id, position: { x, y } };
  }) : [];
  const nodeIds = new Set(nodes.map((node) => node.id));
  if (nodeIds.size !== nodes.length) throw new Error("topology contém nós duplicados");
  const conductors = Array.isArray(value.conductors) ? value.conductors.map((entry, index) => {
    if (!isObject(entry)) throw new Error(`topology.conductors[${index}] inválido`);
    const id = asString(entry.id); if (!id) throw new Error(`topology.conductors[${index}].id ausente`);
    const from = validateTopologyEndpoint(entry.from, `topology.conductors[${index}].from`);
    const to = validateTopologyEndpoint(entry.to, `topology.conductors[${index}].to`);
    const vertices = Array.isArray(entry.vertices) ? entry.vertices.map((point, pointIndex) => {
      if (!isObject(point)) throw new Error(`topology.conductors[${index}].vertices[${pointIndex}] inválido`);
      const x = asNumber(point.x); const y = asNumber(point.y);
      if (x === undefined || y === undefined) throw new Error(`topology.conductors[${index}].vertices[${pointIndex}] inválido`);
      return { x, y };
    }) : [];
    for (const endpoint of [from, to]) {
      if (endpoint.kind === "node" && !nodeIds.has(endpoint.nodeId)) throw new Error(`conductor ${id} referencia nó inexistente`);
      if (endpoint.kind === "port" && !componentIds.has(endpoint.componentId)) throw new Error(`conductor ${id} referencia componente inexistente`);
    }
    return { id, from, to, vertices };
  }) : [];
  if (new Set(conductors.map((c) => c.id)).size !== conductors.length) throw new Error("topology contém condutores duplicados");
  return { revision: asNumber(value.revision) ?? 0, nodes, conductors };
}

export class ProjectSerializer {
  async load(filePath: string): Promise<ProjectDocument> {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isObject(parsed)) throw new Error("Projeto inválido");
    if (parsed.schemaVersion !== LS_PROJ_SCHEMA_VERSION) {
      throw new Error(`schemaVersion incompatível: esperado ${LS_PROJ_SCHEMA_VERSION}, recebido ${String(parsed.schemaVersion)}`);
    }
    const components = Array.isArray(parsed.components) ? parsed.components.map(validateComponent) : [];
    const componentIds = new Set(components.map((c) => c.id));
    const topology = validateTopology(parsed.topology, componentIds);
    const wires: ProjectWire[] = topology.conductors.map((conductor) => ({
      id: conductor.id,
      from: conductor.from.kind === "port" ? conductor.from : { componentId: conductor.from.nodeId, pinId: "pin-1" },
      to: conductor.to.kind === "port" ? conductor.to : { componentId: conductor.to.nodeId, pinId: "pin-1" },
    }));
    return {
      schemaVersion: LS_PROJ_SCHEMA_VERSION,
      components,
      wires,
      topology,
      visual: isObject(parsed.visual)
        ? {
            wires: Array.isArray(parsed.visual.wires)
              ? (parsed.visual.wires as ProjectDocument["visual"]["wires"])
              : [],
            viewport: isObject(parsed.visual.viewport)
              ? {
                  x: asNumber(parsed.visual.viewport.x) ?? 0,
                  y: asNumber(parsed.visual.viewport.y) ?? 0,
                  zoom: asNumber(parsed.visual.viewport.zoom) ?? 1,
                }
              : { x: 0, y: 0, zoom: 1 },
          }
        : createEmptyProject().visual,
      simulationSettings: isObject(parsed.simulationSettings)
        ? {
            frequencyHz: asNumber(parsed.simulationSettings.frequencyHz),
            timeScale: asNumber(parsed.simulationSettings.timeScale),
            paused: typeof parsed.simulationSettings.paused === "boolean" ? parsed.simulationSettings.paused : undefined,
          }
        : {},
      mcuFirmware: Array.isArray(parsed.mcuFirmware)
        ? parsed.mcuFirmware.filter(isObject).map((entry) => ({
            chipId: asString(entry.chipId) ?? "",
            firmwarePath: asString(entry.firmwarePath) ?? "",
            arguments: Array.isArray(entry.arguments) ? entry.arguments.filter((v): v is string => typeof v === "string") : undefined,
          })).filter((entry) => entry.chipId && entry.firmwarePath)
        : undefined,
    };
  }

  async save(filePath: string, project: ProjectDocument): Promise<void> {
    const normalized = {
      schemaVersion: LS_PROJ_SCHEMA_VERSION,
      components: project.components,
      topology: project.topology,
      visual: { viewport: project.visual.viewport },
      simulationSettings: project.simulationSettings,
      mcuFirmware: project.mcuFirmware,
    };
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  }
}
