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

/** Deriva a posição de Modo Placa dos campos PLANOS realmente persistidos em cada componente
 * (`boardX`/`boardY`/`boardRotation`/`boardFlipH`/`boardFlipV`, mesmo shape de
 * `WebviewComponentModel` -- ver `model.ts` e `subcircuitBoardMode.ts::captureBoardTransforms`,
 * que é quem escreve isso ao sair do Modo Placa DENTRO da edição do subcircuito). Bug real
 * corrigido aqui: esta função lia um campo aninhado `boardVisual` que NUNCA existiu no arquivo --
 * só `updateBoardOverlayVisualCommand` (mcuCommands.ts) escrevia nesse campo fantasma, então a
 * posição definida editando o subcircuito por dentro (Modo Placa real) nunca aparecia no overlay
 * da instância no circuito principal, e vice-versa -- dois armazenamentos paralelos da MESMA
 * posição, nunca sincronizados (`.spec` seção sobre a auditoria de Modo Placa). `boardVisual` no
 * `InternalComponentSnapshot` (mensagem IPC) continua existindo só como agrupamento de
 * conveniência pro protocolo -- a fonte de verdade persistida é sempre os campos planos. */
function boardVisualFromFlatFields(value: Record<string, unknown>): VisualPosition | undefined {
  if (typeof value.boardX !== "number" || typeof value.boardY !== "number") return undefined;
  const rotation = value.boardRotation === 90 || value.boardRotation === 180 || value.boardRotation === 270 ? value.boardRotation : 0;
  return {
    x: value.boardX,
    y: value.boardY,
    rotation,
    flipH: typeof value.boardFlipH === "boolean" ? value.boardFlipH : undefined,
    flipV: typeof value.boardFlipV === "boolean" ? value.boardFlipV : undefined,
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
      boardVisual: boardVisualFromFlatFields(value),
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
