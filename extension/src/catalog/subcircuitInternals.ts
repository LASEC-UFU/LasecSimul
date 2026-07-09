import * as vscode from "vscode";
import { currentLasecSimulLanguage } from "../currentLanguage";
import { fileExists, normalizeAbsolutePath, readJsonFile } from "../pathUtils";
import { state } from "../state";
import { InternalComponentSnapshot } from "../ui/webview/messages";
import { JUNCTION_TYPE_ID, TUNNEL_TYPE_ID } from "../ui/webview/model";
import { loadUnifiedCatalog } from "./UnifiedCatalog";

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
  properties: Record<string, unknown>;
  boardVisual?: VisualPosition;
  exposed?: boolean;
}

function sanitizeVisualPosition(value: unknown): VisualPosition | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.x !== "number" || typeof raw.y !== "number") return undefined;
  const rotation = raw.rotation === 90 || raw.rotation === 180 || raw.rotation === 270 ? raw.rotation : 0;
  return {
    x: raw.x,
    y: raw.y,
    rotation,
    flipH: typeof raw.flipH === "boolean" ? raw.flipH : undefined,
    flipV: typeof raw.flipV === "boolean" ? raw.flipV : undefined,
  };
}

function extractInternalComponents(json: Record<string, unknown>): InternalComponentSeed[] {
  const componentsRaw = Array.isArray(json.components) ? json.components : [];
  return componentsRaw
    .filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
    .map((value) => ({
      id: typeof value.id === "string" ? value.id : "",
      typeId: typeof value.typeId === "string" ? value.typeId : "",
      properties: typeof value.properties === "object" && value.properties !== null ? (value.properties as Record<string, unknown>) : {},
      boardVisual: sanitizeVisualPosition(value.boardVisual),
      exposed: value.exposed === true,
    }))
    .filter((component) => component.id && component.typeId);
}

export function resolveSourceFilePath(sourceId: string): string | undefined {
  if (!state.extensionContext) return undefined;
  const unifiedCatalog = loadUnifiedCatalog(state.extensionContext.extensionPath, currentLasecSimulLanguage());
  const source = unifiedCatalog.registeredSources.find((value) => value.id === sourceId);
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
        label: component.id,
        graphical: catalogEntry?.graphical === true,
        exposed: component.exposed === true,
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
