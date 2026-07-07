import * as fs from "fs/promises";
import * as path from "path";
import {
  LS_PROJ_SCHEMA_VERSION,
  ProjectComponent,
  ProjectDocument,
  ProjectSubcircuitRef,
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
    const wires = Array.isArray(parsed.wires) ? parsed.wires.map(validateWire) : [];
    for (const wire of wires) {
      if (!componentIds.has(wire.from.componentId) || !componentIds.has(wire.to.componentId)) {
        throw new Error(`wire ${wire.id} referencia componente inexistente`);
      }
    }
    return {
      schemaVersion: LS_PROJ_SCHEMA_VERSION,
      components,
      wires,
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
    const normalized: ProjectDocument = {
      schemaVersion: LS_PROJ_SCHEMA_VERSION,
      components: project.components,
      wires: project.wires,
      visual: project.visual,
      simulationSettings: project.simulationSettings,
      mcuFirmware: project.mcuFirmware,
    };
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  }
}
