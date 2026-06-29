"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProjectSerializer = void 0;
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const ProjectTypes_1 = require("./ProjectTypes");
function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asString(value) {
    return typeof value === "string" ? value : undefined;
}
function asNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function asBoolean(value) {
    return typeof value === "boolean" ? value : undefined;
}
function validateComponent(component, index) {
    if (!isObject(component))
        throw new Error(`components[${index}] inválido`);
    const id = asString(component.id);
    const typeId = asString(component.typeId);
    if (!id)
        throw new Error(`components[${index}].id ausente`);
    if (!typeId)
        throw new Error(`components[${index}].typeId ausente`);
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
    };
}
function validateWire(wire, index) {
    if (!isObject(wire))
        throw new Error(`wires[${index}] inválido`);
    const id = asString(wire.id);
    const from = isObject(wire.from) ? wire.from : undefined;
    const to = isObject(wire.to) ? wire.to : undefined;
    if (!id)
        throw new Error(`wires[${index}].id ausente`);
    if (!from || !to)
        throw new Error(`wires[${index}] precisa de from/to`);
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
class ProjectSerializer {
    async load(filePath) {
        const raw = await fs.readFile(filePath, "utf8");
        const parsed = JSON.parse(raw);
        if (!isObject(parsed))
            throw new Error("Projeto inválido");
        if (parsed.schemaVersion !== ProjectTypes_1.LS_PROJ_SCHEMA_VERSION) {
            throw new Error(`schemaVersion incompatível: esperado ${ProjectTypes_1.LS_PROJ_SCHEMA_VERSION}, recebido ${String(parsed.schemaVersion)}`);
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
            schemaVersion: ProjectTypes_1.LS_PROJ_SCHEMA_VERSION,
            components,
            wires,
            visual: isObject(parsed.visual)
                ? {
                    components: Array.isArray(parsed.visual.components)
                        ? parsed.visual.components
                        : [],
                    wires: Array.isArray(parsed.visual.wires)
                        ? parsed.visual.wires
                        : [],
                    viewport: isObject(parsed.visual.viewport)
                        ? {
                            x: asNumber(parsed.visual.viewport.x) ?? 0,
                            y: asNumber(parsed.visual.viewport.y) ?? 0,
                            zoom: asNumber(parsed.visual.viewport.zoom) ?? 1,
                        }
                        : { x: 0, y: 0, zoom: 1 },
                }
                : (0, ProjectTypes_1.createEmptyProject)().visual,
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
                    arguments: Array.isArray(entry.arguments) ? entry.arguments.filter((v) => typeof v === "string") : undefined,
                })).filter((entry) => entry.chipId && entry.firmwarePath)
                : undefined,
        };
    }
    async save(filePath, project) {
        const normalized = {
            schemaVersion: ProjectTypes_1.LS_PROJ_SCHEMA_VERSION,
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
exports.ProjectSerializer = ProjectSerializer;
//# sourceMappingURL=ProjectSerializer.js.map