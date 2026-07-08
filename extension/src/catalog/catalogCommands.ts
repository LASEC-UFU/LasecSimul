import * as path from "path";
import * as vscode from "vscode";
import { currentLasecSimulLanguage } from "../currentLanguage";
import { normalizeAbsolutePath, readJsonFile } from "../pathUtils";
import { state } from "../state";
import { WebviewComponentCatalogEntry } from "../ui/webview/model";
import { mergePropertySchemas } from "./catalogMerge";
import { loadUnifiedCatalog, RegisteredSource, saveRegisteredSources } from "./UnifiedCatalog";
import {
  inferLibraryPathForDevice,
  sanitizeFolderPathSegments,
  folderPathFromManifestFile,
  localizedAbiFailure,
  resolveRegisteredItems,
} from "./registeredSources";

type LoadConfiguredDeviceLibraries = (
  extensionPath: string,
  requests: Array<{ displayPath: string; absolutePath: string }>
) => Promise<Map<string, string>>;

interface CatalogCommandOptions {
  loadConfiguredDeviceLibraries: LoadConfiguredDeviceLibraries;
  setEffectiveCatalog: (entries: WebviewComponentCatalogEntry[]) => void;
}

function nextSourceId(): string {
  return `registered-source-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

function inferSourcesFromSelectedFile(extensionPath: string, selectedPath: string): RegisteredSource[] {
  const absoluteSelectedPath = normalizeAbsolutePath(extensionPath, selectedPath);
  const fileName = path.basename(absoluteSelectedPath).toLowerCase();
  const sources: RegisteredSource[] = [];

  const json = readJsonFile(absoluteSelectedPath) as Record<string, unknown>;

  if (fileName === "library.json") {
    const abiEntries = Array.isArray(json.devices) ? json.devices : [];
    for (const value of abiEntries) {
      if (typeof value !== "object" || value === null) continue;
      const deviceEntry = value as { manifest?: unknown };
      if (typeof deviceEntry.manifest !== "string" || !deviceEntry.manifest.trim()) continue;
      const manifestPath = path.resolve(path.dirname(absoluteSelectedPath), deviceEntry.manifest);
      sources.push({
        id: nextSourceId(),
        kind: "abi-device",
        filePath: manifestPath,
        libraryPath: absoluteSelectedPath,
        folderPath: folderPathFromManifestFile(manifestPath),
      });
    }

    const mcuEntries = Array.isArray(json.mcus) ? json.mcus : [];
    for (const value of mcuEntries) {
      if (typeof value !== "object" || value === null) continue;
      const mcuEntry = value as { manifest?: unknown };
      if (typeof mcuEntry.manifest !== "string" || !mcuEntry.manifest.trim()) continue;
      const manifestPath = path.resolve(path.dirname(absoluteSelectedPath), mcuEntry.manifest);
      sources.push({
        id: nextSourceId(),
        kind: "mcu-adapter",
        filePath: manifestPath,
        libraryPath: absoluteSelectedPath,
        folderPath: folderPathFromManifestFile(manifestPath),
      });
    }

    const subEntries = Array.isArray(json.subcircuits) ? json.subcircuits : [];
    for (const value of subEntries) {
      if (typeof value !== "object" || value === null) continue;
      const subEntry = value as { manifest?: unknown };
      if (typeof subEntry.manifest !== "string" || !subEntry.manifest.trim()) continue;
      const manifestPath = path.resolve(path.dirname(absoluteSelectedPath), subEntry.manifest);
      sources.push({
        id: nextSourceId(),
        kind: "subcircuit-file",
        filePath: manifestPath,
        folderPath: folderPathFromManifestFile(manifestPath),
      });
    }

    return sources;
  }

  if (fileName.endsWith(".lssubcircuit")) {
    sources.push({
      id: nextSourceId(),
      kind: "subcircuit-file",
      filePath: absoluteSelectedPath,
      folderPath: sanitizeFolderPathSegments(json.folderPath),
    });
    return sources;
  }

  const hasChipId = typeof json.chipId === "string" && json.chipId.trim().length > 0;
  const hasNativeEntry = typeof json.nativeEntry === "object" && json.nativeEntry !== null;
  if (fileName === "mcu.lsdevice" || hasChipId) {
    sources.push({
      id: nextSourceId(),
      kind: "mcu-adapter",
      filePath: absoluteSelectedPath,
      libraryPath: inferLibraryPathForDevice(absoluteSelectedPath),
      folderPath: sanitizeFolderPathSegments(json.folderPath),
    });
    return sources;
  }

  if (fileName === "device.lsdevice" || hasNativeEntry) {
    sources.push({
      id: nextSourceId(),
      kind: "abi-device",
      filePath: absoluteSelectedPath,
      libraryPath: inferLibraryPathForDevice(absoluteSelectedPath),
      folderPath: sanitizeFolderPathSegments(json.folderPath),
    });
    return sources;
  }

  const looksLikeSubcircuit = Array.isArray(json.components) && Array.isArray(json.wires) && Array.isArray(json.interface);
  if (looksLikeSubcircuit) {
    sources.push({
      id: nextSourceId(),
      kind: "subcircuit-file",
      filePath: absoluteSelectedPath,
      folderPath: sanitizeFolderPathSegments(json.folderPath),
    });
  }

  return sources;
}

async function attachPropertySchemas(
  catalog: WebviewComponentCatalogEntry[]
): Promise<WebviewComponentCatalogEntry[]> {
  if (!state.coreClient) return catalog;
  let resolved: Awaited<ReturnType<typeof state.coreClient.getPropertySchemas>>;
  try {
    resolved = await state.coreClient.getPropertySchemas(currentLasecSimulLanguage());
  } catch {
    return catalog;
  }
  return mergePropertySchemas(
    catalog,
    resolved.schemasByTypeId,
    resolved.readoutFormatByTypeId,
    resolved.interactionKindByTypeId,
    resolved.pinIdsByTypeId,
    resolved.serialPortsByTypeId
  );
}

export async function refreshUnifiedCatalogState(
  loadLibrariesInCore: boolean,
  options: CatalogCommandOptions
): Promise<void> {
  if (!state.extensionContext) return;
  const unifiedCatalog = loadUnifiedCatalog(state.extensionContext.extensionPath, currentLasecSimulLanguage());
  const resolved = resolveRegisteredItems(state.extensionContext.extensionPath, unifiedCatalog.registeredSources);

  const requests = new Map<string, { displayPath: string; absolutePath: string }>();
  const adhocSubcircuits = new Set<string>();
  for (const relativePath of unifiedCatalog.deviceLibraries) {
    const absolutePath = normalizeAbsolutePath(state.extensionContext.extensionPath, relativePath);
    requests.set(absolutePath, { displayPath: relativePath, absolutePath });
  }
  for (const item of resolved) {
    if (!item.libraryPathToLoad) continue;
    const absolutePath = normalizeAbsolutePath(state.extensionContext.extensionPath, item.libraryPathToLoad);
    if (!requests.has(absolutePath)) {
      requests.set(absolutePath, { displayPath: absolutePath, absolutePath });
    }
  }
  for (const item of resolved) {
    if (item.adhocSubcircuitPathToRegister) {
      adhocSubcircuits.add(item.adhocSubcircuitPathToRegister);
    }
  }

  const failures = loadLibrariesInCore
    ? await options.loadConfiguredDeviceLibraries(state.extensionContext.extensionPath, [...requests.values()])
    : new Map<string, string>();
  const adhocFailures = new Map<string, string>();
  if (loadLibrariesInCore && state.coreClient) {
    for (const absolutePath of adhocSubcircuits) {
      try {
        await state.coreClient.registerAdhocSubcircuitDefinition(absolutePath);
      } catch (err) {
        adhocFailures.set(absolutePath, err instanceof Error ? err.message : String(err));
      }
    }
  }

  const baseTypeIds = new Set(unifiedCatalog.catalog.map((entry) => entry.typeId));
  const registeredEntries = resolved.flatMap((item) => {
    const failedReason = item.libraryPathToLoad
      ? failures.get(normalizeAbsolutePath(state.extensionContext!.extensionPath, item.libraryPathToLoad))
      : undefined;
    const adhocFailedReason = item.adhocSubcircuitPathToRegister
      ? adhocFailures.get(item.adhocSubcircuitPathToRegister)
      : undefined;
    if (failedReason) {
      return [{
        ...item.entry,
        disabled: true,
        disabledReason: localizedAbiFailure(failedReason, currentLasecSimulLanguage()),
      }];
    }
    if (adhocFailedReason) {
      return [{
        ...item.entry,
        disabled: true,
        disabledReason: currentLasecSimulLanguage() === "en"
          ? `subcircuit registration failed: ${adhocFailedReason}`
          : `falha ao registrar subcircuito: ${adhocFailedReason}`,
      }];
    }
    if (baseTypeIds.has(item.entry.typeId)) return [];
    return [item.entry];
  });

  const mergedCatalog = [...unifiedCatalog.catalog, ...registeredEntries];
  options.setEffectiveCatalog(loadLibrariesInCore ? await attachPropertySchemas(mergedCatalog) : mergedCatalog);
}

export async function registerCatalogFileCommand(options: CatalogCommandOptions): Promise<void> {
  if (!state.extensionContext) return;
  const ctx = state.extensionContext;
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: {
      "LasecSimul": ["lsdevice", "lssubcircuit", "json"],
    },
    title: "Registrar arquivo ABI/QEMU/Subcircuito no LasecSimul",
  });
  const selected = picked?.[0];
  if (!selected) return;

  let newSources: RegisteredSource[] = [];
  try {
    newSources = inferSourcesFromSelectedFile(ctx.extensionPath, selected.fsPath);
  } catch (err) {
    vscode.window.showErrorMessage(
      `Não foi possível registrar arquivo: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  if (newSources.length === 0) {
    vscode.window.showWarningMessage("Arquivo não reconhecido como ABI, QEMU (mcu/library) nem subcircuito.");
    return;
  }

  const unifiedCatalog = loadUnifiedCatalog(ctx.extensionPath, currentLasecSimulLanguage());
  const existingKeys = new Set(
    unifiedCatalog.registeredSources.map((source) => `${source.kind}::${normalizeAbsolutePath(ctx.extensionPath, source.filePath)}`)
  );
  const deduped = newSources.filter((source) => {
    const key = `${source.kind}::${normalizeAbsolutePath(ctx.extensionPath, source.filePath)}`;
    if (existingKeys.has(key)) return false;
    existingKeys.add(key);
    return true;
  });

  if (deduped.length === 0) {
    vscode.window.showInformationMessage("Esses itens já estavam registrados na paleta.");
    return;
  }

  const mergedSources = [...unifiedCatalog.registeredSources, ...deduped];
  const savedAt = saveRegisteredSources(ctx.extensionPath, mergedSources);
  await refreshUnifiedCatalogState(true, options);
  vscode.window.showInformationMessage(`Registro concluído (${deduped.length} item(ns)). Catálogo salvo em ${savedAt}.`);
}

export async function removeRegisteredCatalogItemCommand(
  item: { sourceId?: string } | undefined,
  options: CatalogCommandOptions
): Promise<void> {
  if (!state.extensionContext) return;
  const sourceId = typeof item?.sourceId === "string" ? item.sourceId : undefined;
  if (!sourceId) {
    vscode.window.showWarningMessage("Selecione um item registrado na paleta para remover.");
    return;
  }

  const unifiedCatalog = loadUnifiedCatalog(state.extensionContext.extensionPath, currentLasecSimulLanguage());
  const source = unifiedCatalog.registeredSources.find((value) => value.id === sourceId);
  if (!source) {
    vscode.window.showWarningMessage("Item registrado não encontrado no catálogo.");
    return;
  }

  if (source.removable === false) {
    vscode.window.showInformationMessage("Esse item faz parte do catálogo integrado e não pode ser removido pela paleta.");
    return;
  }

  const decision = await vscode.window.showWarningMessage(
    "Remover item registrado da paleta?",
    { modal: true },
    "Remover"
  );
  if (decision !== "Remover") return;

  const nextSources = unifiedCatalog.registeredSources.filter((value) => value.id !== sourceId);
  saveRegisteredSources(state.extensionContext.extensionPath, nextSources);
  await refreshUnifiedCatalogState(true, options);
  vscode.window.showInformationMessage("Item removido da paleta de componentes.");
}
