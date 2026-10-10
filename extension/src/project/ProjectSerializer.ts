import * as fs from "fs/promises";
import * as path from "path";
import {
  LS_PROJ_SCHEMA_VERSION,
  HmiApplication,
  HmiPage,
  HmiPageElement,
  ProjectComponent,
  ProjectDocument,
  ProjectSubcircuitRef,
  ProjectDeviceRef,
  ProjectFpgaConfig,
  ProjectPlcConfig,
  ProjectTopology,
  ProjectTopologyEndpoint,
  ProjectWire,
  createEmptyProject,
} from "./ProjectTypes";
import { isIpdLineClass } from "../ui/webview/ipdLineStyle";
import { defaultHmiNavigationVisual } from "../ui/webview/model";
import { migrateLegacySignalTunnels } from "../catalog/legacySignalTunnelMigration";

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
    ...(isObject(value.embedded) ? { embedded: value.embedded } : {}),
  };
}

function validateDeviceRef(value: unknown): ProjectDeviceRef | undefined {
  if (!isObject(value)) return undefined;
  const path = asString(value.path);
  if (!path) return undefined;
  return {
    path,
    lastKnownTypeId: asString(value.lastKnownTypeId),
    lastKnownPinIds: asStringArray(value.lastKnownPinIds),
    lastKnownMtimeMs: asNumber(value.lastKnownMtimeMs),
  };
}

function validateFpgaConfig(value: unknown): ProjectFpgaConfig | undefined {
  if (!isObject(value)) return undefined;
  const top = asString(value.top);
  const sources = asStringArray(value.sources);
  if (!top || !sources) return undefined; // sem top/sources não é uma config utilizável -- descarta
  const rawPorts = Array.isArray(value.ports) ? value.ports : [];
  const ports = rawPorts
    .filter(isObject)
    .map((p) => ({
      name: asString(p.name) ?? "",
      direction: p.direction === "out" ? ("out" as const) : ("in" as const),
      width: asNumber(p.width) ?? 1,
      downto: p.downto !== false,
      ...(asNumber(p.leftIndex) !== undefined ? { leftIndex: asNumber(p.leftIndex) } : {}),
      ...(asNumber(p.rightIndex) !== undefined ? { rightIndex: asNumber(p.rightIndex) } : {}),
    }))
    .filter((p) => p.name.length > 0);
  return {
    language: "vhdl",
    backend: "ghdl",
    standard: asString(value.standard) ?? "08",
    top,
    sources,
    ports,
  };
}

function validatePlcConfig(value: unknown): ProjectPlcConfig | undefined {
  if (!isObject(value)) return undefined;
  const exportedIo = Array.isArray(value.exportedIo) ? value.exportedIo.filter(isObject).map(io => ({
    ioId: asString(io.ioId) ?? "",
    name: asString(io.name) ?? "",
    direction: io.direction === "output" ? ("output" as const) : ("input" as const),
    iecType: asString(io.iecType) ?? "",
  })).filter(io => io.ioId && io.name && io.iecType) : undefined;
  return {
    iecProjectRef: asString(value.iecProjectRef),
    entryConfiguration: asString(value.entryConfiguration),
    artifactRef: asString(value.artifactRef),
    expectedArtifactHash: asString(value.expectedArtifactHash),
    exportedIoBindingVersion: asNumber(value.exportedIoBindingVersion),
    exportedIo,
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
    showDialValue: asBoolean(component.showDialValue),
    valueLabelPropertyKey: asString(component.valueLabelPropertyKey),
    flipH: asBoolean(component.flipH),
    flipV: asBoolean(component.flipV),
    locked: asBoolean(component.locked),
    hiddenByUser: asBoolean(component.hiddenByUser),
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
    deviceRef: validateDeviceRef(component.deviceRef),
    fpga: validateFpgaConfig(component.fpga),
    plc: validatePlcConfig(component.plc),
  };
}

export function validateHmiApplication(value: unknown): HmiApplication | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value) || !Array.isArray(value.pages) || value.pages.length === 0) {
    throw new Error("hmiApplication precisa conter ao menos uma página");
  }
  const staleAfterMs = asNumber(value.staleAfterMs);
  if (value.staleAfterMs !== undefined && (staleAfterMs === undefined || staleAfterMs < 0)) {
    throw new Error("hmiApplication.staleAfterMs precisa ser um numero finito nao negativo");
  }
  const pageIds = new Set<string>();
  const elementIds = new Set<string>();
  const navigationIds = new Set<string>();
  const pages: HmiPage[] = value.pages.map((entry, pageIndex) => {
    if (!isObject(entry)) throw new Error(`hmiApplication.pages[${pageIndex}] inválida`);
    const id = asString(entry.id);
    const name = asString(entry.name);
    const width = asNumber(entry.width);
    const height = asNumber(entry.height);
    if (!id || !name || width === undefined || width <= 0 || height === undefined || height <= 0) {
      throw new Error(`hmiApplication.pages[${pageIndex}] precisa de id, name, width e height válidos`);
    }
    if (pageIds.has(id)) throw new Error(`hmiApplication contém página duplicada: ${id}`);
    pageIds.add(id);
    const elements: HmiPageElement[] = Array.isArray(entry.elements)
      ? entry.elements.map((element, elementIndex) => {
          const context = `hmiApplication.pages[${pageIndex}].elements[${elementIndex}]`;
          if (!isObject(element) || !isObject(element.visual)) throw new Error(`${context} inválido`);
          const elementId = asString(element.id);
          const componentId = asString(element.componentId);
          const typeId = asString(element.typeId);
          const x = asNumber(element.visual.x);
          const y = asNumber(element.visual.y);
          const elementWidth = asNumber(element.visual.width);
          const elementHeight = asNumber(element.visual.height);
          const rotation = element.visual.rotation;
          if (!elementId || (!componentId && !typeId) || x === undefined || y === undefined || elementWidth === undefined || elementWidth <= 0 || elementHeight === undefined || elementHeight <= 0) {
            throw new Error(`${context} precisa de id, componentId ou typeId e geometria válida`);
          }
          if (elementIds.has(elementId)) throw new Error(`hmiApplication contém elemento duplicado: ${elementId}`);
          elementIds.add(elementId);
          if (rotation !== undefined && rotation !== 0 && rotation !== 90 && rotation !== 180 && rotation !== 270) {
            throw new Error(`${context}.visual.rotation inválida`);
          }
          // Referências órfãs são preservadas para que excluir um componente no editor não torne
          // impossível reabrir/salvar o projeto HMI; o auditor poderá oferecer a relocalização.
          // Referências podem apontar a qualquer componente real do processo; a página apresenta
          // uma projeção independente dele. Elementos sem referência continuam restritos a graphics.*.
          if (!componentId && !typeId!.startsWith("graphics.")) throw new Error(`${context} só pode conter elementos gráficos`);
          return {
            id: elementId,
            ...(componentId ? { componentId } : {}),
            ...(typeId ? { typeId } : {}),
            ...(asString(element.label) ? { label: asString(element.label) } : {}),
            ...(isObject(element.properties) ? { properties: element.properties } : {}),
            visual: {
              x,
              y,
              width: elementWidth,
              height: elementHeight,
              rotation: rotation === 90 || rotation === 180 || rotation === 270 ? rotation : 0,
            },
          };
        })
      : [];
    const navigationObstacles = elements.map((element) => element.visual);
    const navigation = Array.isArray(entry.navigation)
      ? entry.navigation.map((item, itemIndex) => {
          const context = `hmiApplication.pages[${pageIndex}].navigation[${itemIndex}]`;
          if (!isObject(item)) throw new Error(`${context} inválido`);
          const navId = asString(item.id);
          const label = asString(item.label);
          const targetPageId = asString(item.targetPageId);
          if (!navId || !label || !targetPageId) throw new Error(`${context} precisa de id, label e targetPageId`);
          if (navigationIds.has(navId)) throw new Error(`hmiApplication contém navegação duplicada: ${navId}`);
          navigationIds.add(navId);
          let visual = defaultHmiNavigationVisual(width, height, navigationObstacles);
          if (item.visual !== undefined) {
            if (!isObject(item.visual)) throw new Error(`${context}.visual invalido`);
            const x = asNumber(item.visual.x);
            const y = asNumber(item.visual.y);
            const visualWidth = asNumber(item.visual.width);
            const visualHeight = asNumber(item.visual.height);
            if (x === undefined || y === undefined || visualWidth === undefined || visualWidth <= 0 || visualHeight === undefined || visualHeight <= 0) {
              throw new Error(`${context}.visual precisa de geometria valida`);
            }
            visual = { x, y, width: visualWidth, height: visualHeight };
          }
          navigationObstacles.push(visual);
          return { id: navId, label, targetPageId, visual };
        })
      : undefined;
    return { id, name, width, height, elements, ...(navigation ? { navigation } : {}) };
  });
  const startPageId = asString(value.startPageId);
  if (!startPageId || !pageIds.has(startPageId)) throw new Error("hmiApplication.startPageId referencia página inexistente");
  for (const page of pages) {
    for (const item of page.navigation ?? []) {
      if (!pageIds.has(item.targetPageId)) throw new Error(`navegação ${item.id} referencia página inexistente: ${item.targetPageId}`);
    }
  }
  return { startPageId, pages, ...(staleAfterMs && staleAfterMs > 0 ? { staleAfterMs } : {}) };
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

function asIntegrationMethod(value: unknown): "automatic" | "backwardEuler" | "trapezoidal" | "gear2" | undefined {
  return value === "automatic" || value === "backwardEuler" || value === "trapezoidal" || value === "gear2"
    ? value
    : undefined;
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
    return {
      id,
      from,
      to,
      vertices,
      hidden: entry.hidden === true,
      ...(isIpdLineClass(entry.lineClass) ? { lineClass: entry.lineClass } : {}),
    };
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
    const migrated = migrateLegacySignalTunnels(components, topology);
    const wires: ProjectWire[] = migrated.topology.conductors.map((conductor) => ({
      id: conductor.id,
      from: conductor.from.kind === "port" ? conductor.from : { componentId: conductor.from.nodeId, pinId: "pin-1" },
      to: conductor.to.kind === "port" ? conductor.to : { componentId: conductor.to.nodeId, pinId: "pin-1" },
    }));
    return {
      schemaVersion: LS_PROJ_SCHEMA_VERSION,
      components: migrated.components,
      wires,
      topology: migrated.topology,
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
            integrationMethod: asIntegrationMethod(parsed.simulationSettings.integrationMethod),
            initialStepSeconds: asNumber(parsed.simulationSettings.initialStepSeconds),
            minimumStepSeconds: asNumber(parsed.simulationSettings.minimumStepSeconds),
            maximumStepSeconds: asNumber(parsed.simulationSettings.maximumStepSeconds),
            relativeTolerance: asNumber(parsed.simulationSettings.relativeTolerance),
            absoluteTolerance: asNumber(parsed.simulationSettings.absoluteTolerance),
            maximumNewtonIterations: asNumber(parsed.simulationSettings.maximumNewtonIterations),
            threadCount: asNumber(parsed.simulationSettings.threadCount),
            telemetryRateHz: asNumber(parsed.simulationSettings.telemetryRateHz),
            adaptiveTimeStep: asBoolean(parsed.simulationSettings.adaptiveTimeStep),
          }
        : {},
      hmiApplication: validateHmiApplication(parsed.hmiApplication),
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
      hmiApplication: project.hmiApplication,
      mcuFirmware: project.mcuFirmware,
    };
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  }
}
