import * as vscode from "vscode";
import { currentLasecSimulLanguage } from "../currentLanguage";
import { fileExists, normalizeAbsolutePath, readJsonFile } from "../pathUtils";
import { state } from "../state";
import { InternalComponentSnapshot } from "../ui/webview/messages";
import { JUNCTION_TYPE_ID, TUNNEL_TYPE_ID } from "../ui/webview/model";
import { loadUnifiedCatalog } from "./UnifiedCatalog";
import { findRegisteredSourceById } from "./catalogCommands";

interface VisualPosition {
  x: number;
  y: number;
  rotation?: 0 | 90 | 180 | 270;
  flipH?: boolean;
  flipV?: boolean;
}

interface InternalComponentSeed {
  id: string;
  typeId: string;
  label: string;
  properties: Record<string, unknown>;
  boardVisual?: VisualPosition;
  exposed?: boolean;
  exported?: boolean;
  showId?: boolean;
  showValue?: boolean;
  showDialValue?: boolean;
  valueLabelPropertyKey?: string;
}

/** Deriva a posição de Modo Placa de `exposedComponents[]` (schemaVersion 3,
 * `catalog/subcircuitDocument.ts`) -- array de nível superior, indexado por `componentId`, nunca
 * mais campos planos `boardX`/`boardY`/... dentro do próprio componente (formato antigo, removido).
 * `boardVisual` no `InternalComponentSnapshot` (mensagem IPC) continua existindo só como agrupamento
 * de conveniência pro protocolo. */
function exposedEntryFor(componentId: string, exposedComponents: ReadonlyArray<Record<string, unknown>>): Record<string, unknown> | undefined {
  return exposedComponents.find((entry) => entry.componentId === componentId);
}

function boardVisualFromExposedEntry(entry: Record<string, unknown> | undefined): VisualPosition | undefined {
  if (!entry || typeof entry.x !== "number" || typeof entry.y !== "number") return undefined;
  const rotation = entry.rotation === 90 || entry.rotation === 180 || entry.rotation === 270 ? entry.rotation : 0;
  return {
    x: entry.x,
    y: entry.y,
    rotation,
    flipH: typeof entry.flipH === "boolean" ? entry.flipH : undefined,
    flipV: typeof entry.flipV === "boolean" ? entry.flipV : undefined,
  };
}

function extractInternalComponents(json: Record<string, unknown>): InternalComponentSeed[] {
  const componentsRaw = Array.isArray(json.components) ? json.components : [];
  const exposedComponentsRaw = (Array.isArray(json.exposedComponents) ? json.exposedComponents : [])
    .filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null);
  // INDEPENDENTE de `exposedComponents[]` -- ver doc de `SubcircuitDocument.exportedPropertyComponentIds`.
  const exportedIds = new Set(
    (Array.isArray(json.exportedPropertyComponentIds) ? json.exportedPropertyComponentIds : []).filter((value): value is string => typeof value === "string")
  );
  return componentsRaw
    .filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
    .map((value) => {
      const id = typeof value.id === "string" ? value.id : "";
      const exposedEntry = exposedEntryFor(id, exposedComponentsRaw);
      return {
        id,
        typeId: typeof value.typeId === "string" ? value.typeId : "",
        label: typeof value.label === "string" ? value.label : id,
        properties: typeof value.properties === "object" && value.properties !== null ? (value.properties as Record<string, unknown>) : {},
        boardVisual: boardVisualFromExposedEntry(exposedEntry),
        exposed: exposedEntry !== undefined,
        exported: exportedIds.has(id),
        showId: typeof value.showId === "boolean" ? value.showId : undefined,
        showValue: typeof value.showValue === "boolean" ? value.showValue : undefined,
        showDialValue: typeof value.showDialValue === "boolean" ? value.showDialValue : undefined,
        valueLabelPropertyKey: typeof value.valueLabelPropertyKey === "string" ? value.valueLabelPropertyKey : undefined,
      };
    })
    .filter((component) => component.id && component.typeId);
}

export function resolveSourceFilePath(sourceId: string): string | undefined {
  if (!state.extensionContext) return undefined;
  const unifiedCatalog = loadUnifiedCatalog(state.extensionContext.extensionPath, currentLasecSimulLanguage());
  const source = findRegisteredSourceById(state.extensionContext.extensionPath, unifiedCatalog, sourceId);
  if (!source) {
    vscode.window.showWarningMessage("Item registrado nao encontrado no catalogo.");
    return undefined;
  }
  return normalizeAbsolutePath(state.extensionContext.extensionPath, source.filePath);
}

export function gatherInternalComponentSnapshots(sourceId: string): InternalComponentSnapshot[] | undefined {
  const absoluteFilePath = resolveSourceFilePath(sourceId);
  if (!absoluteFilePath || !fileExists(absoluteFilePath)) return undefined;

  let json: Record<string, unknown>;
  try {
    json = readJsonFile(absoluteFilePath) as Record<string, unknown>;
  } catch (err) {
    vscode.window.showErrorMessage(`Nao foi possivel ler ${absoluteFilePath}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }

  return extractInternalComponents(json)
    .filter((component) => component.typeId !== TUNNEL_TYPE_ID && component.typeId !== JUNCTION_TYPE_ID)
    .map((component) => {
      const catalogEntry = state.schematicState.catalog.find((entry) => entry.typeId === component.typeId);
      return {
        id: component.id,
        typeId: component.typeId,
        label: component.label,
        graphical: catalogEntry?.graphical === true,
        exposed: component.exposed === true,
        exported: component.exported === true,
        showId: component.showId,
        showValue: component.showValue,
        showDialValue: component.showDialValue,
        valueLabelPropertyKey: component.valueLabelPropertyKey,
        boardVisual: component.boardVisual
          ? {
              x: component.boardVisual.x,
              y: component.boardVisual.y,
              rotation: component.boardVisual.rotation ?? 0,
              flipH: component.boardVisual.flipH,
              flipV: component.boardVisual.flipV,
            }
          : undefined,
        properties: component.properties as Record<string, string | number | boolean>,
      };
    });
}
