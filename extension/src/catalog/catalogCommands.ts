import * as path from "path";
import * as vscode from "vscode";
import { currentLasecSimulLanguage } from "../currentLanguage";
import { normalizeAbsolutePath, readJsonFile } from "../pathUtils";
import { state } from "../state";
import { WebviewComponentCatalogEntry } from "../ui/webview/model";
import { mergePropertySchemas } from "./catalogMerge";
import { LoadedUnifiedCatalog, loadUnifiedCatalog, RegisteredSource, saveRegisteredSources } from "./UnifiedCatalog";
import {
  inferLibraryPathForDevice,
  sanitizeFolderPathSegments,
  expandLibraryJsonToSources,
  localizedAbiFailure,
  resolveRegisteredItems,
} from "./registeredSources";
import { checkDeviceIdUniqueness, DeviceIdOwner, formatDeviceIdConflict } from "./deviceUniqueness";
import {
  copyExternalManifest,
  externalFolderPath,
  manifestComponentDependencies,
  missingManifestDependencies,
  validateExternalManifest,
  writeAdhocDeviceLibrary,
} from "./externalComponents";

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
    // Registro manual ("Registrar arquivo...") de uma biblioteca inteira -- diferente da expansão
    // automática de `deviceLibraries[]` (`refreshUnifiedCatalogState`), aqui os dispositivos viram
    // `removable: true` (usuário pode desfazer o registro individualmente depois), então não
    // reaproveita os ids/removable fixos de `expandLibraryJsonToSources` -- só a extração das 3
    // listas (devices/mcus/subcircuits), reatribuindo id único por clique e removable de volta ao
    // default (`undefined` == removível, ver `ResolvedRegisteredItem.entry.registeredSourceRemovable`).
    return expandLibraryJsonToSources(absoluteSelectedPath).map((source) => ({
      ...source,
      id: nextSourceId(),
      removable: undefined,
    }));
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

export async function attachPropertySchemas(
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

/** Expande cada `deviceLibraries[]` (arquivo canônico -- `library.json` pode declarar 1 ou vários
 * dispositivos) em `RegisteredSource[]`, um por dispositivo -- `deviceLibraries[]` deixa de ser
 * "só o Core carrega, a paleta não vê" (bug real corrigido aqui: era a causa de portas lógicas,
 * sensores, displays e o adaptador ESP32/QEMU nunca aparecerem sozinhos na paleta de um pacote
 * instalado, mascarado por uma lista de 69 `registeredSources[]` manualmente duplicada -- ver
 * memória do projeto). Arquivo ilegível/ausente é ignorado aqui (mesma resiliência de sempre --
 * `loadConfiguredDeviceLibraries` já reporta o erro real de load pro Core separadamente). */
function expandDeviceLibraries(extensionPath: string, deviceLibraries: readonly string[]): RegisteredSource[] {
  const sources: RegisteredSource[] = [];
  for (const relativePath of deviceLibraries) {
    const absolutePath = normalizeAbsolutePath(extensionPath, relativePath);
    try {
      sources.push(...expandLibraryJsonToSources(absolutePath));
    } catch {
      // arquivo ausente/invalido -- loadConfiguredDeviceLibraries reporta o erro de carregar a
      // biblioteca no Core; aqui so nao contribui nenhuma entrada de paleta pra ela.
    }
  }
  return sources;
}

/** Acha UM `RegisteredSource` por `id`, olhando tanto `unifiedCatalog.registeredSources[]`
 * (registros manuais/avulsos) quanto os expandidos de `deviceLibraries[]` (`expandDeviceLibraries`,
 * mesma lógica de `refreshUnifiedCatalogState`) -- pesquisar só `registeredSources[]` direto (bug
 * real corrigido aqui) nunca encontra um `sourceId` de qualquer dispositivo/subcircuito vindo de
 * `deviceLibraries[]` (ESP32 DevKitC/WROOM, portas lógicas, sensores, etc. -- a imensa maioria dos
 * itens desde a unificação de `registeredSources[]`, ver memória do projeto), quebrando "Abrir
 * Subcircuito" e "Remover da paleta" pra eles com "Item registrado não encontrado no catálogo"
 * mesmo com o item plenamente resolvido e funcionando na paleta. */
export function findRegisteredSourceById(extensionPath: string, unifiedCatalog: LoadedUnifiedCatalog, sourceId: string): RegisteredSource | undefined {
  const expanded = expandDeviceLibraries(extensionPath, unifiedCatalog.deviceLibraries);
  return [...expanded, ...unifiedCatalog.registeredSources].find((source) => source.id === sourceId);
}

export async function refreshUnifiedCatalogState(
  loadLibrariesInCore: boolean,
  options: CatalogCommandOptions
): Promise<void> {
  if (!state.extensionContext) return;
  const extensionPath = state.extensionContext.extensionPath;
  const unifiedCatalog = loadUnifiedCatalog(extensionPath, currentLasecSimulLanguage());
  const expandedSources = expandDeviceLibraries(extensionPath, unifiedCatalog.deviceLibraries);
  const allSources = [...expandedSources, ...unifiedCatalog.registeredSources];
  const sourceFileById = new Map(allSources.map((source) => [source.id, normalizeAbsolutePath(extensionPath, source.filePath)]));
  const resolved = resolveRegisteredItems(extensionPath, allSources);

  const requests = new Map<string, { displayPath: string; absolutePath: string }>();
  const adhocSubcircuits = new Set<string>();
  for (const relativePath of unifiedCatalog.deviceLibraries) {
    const absolutePath = normalizeAbsolutePath(extensionPath, relativePath);
    requests.set(absolutePath, { displayPath: relativePath, absolutePath });
  }
  for (const item of resolved) {
    if (!item.libraryPathToLoad) continue;
    const absolutePath = normalizeAbsolutePath(extensionPath, item.libraryPathToLoad);
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
    ? await options.loadConfiguredDeviceLibraries(extensionPath, [...requests.values()])
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

  // Unicidade global de device ID (princípio arquitetural: cada typeId pertence a exatamente um
  // arquivo canônico, descoberto uma única vez) -- constrói o índice typeId->arquivo com o catálogo
  // ESTÁTICO primeiro (sempre "dono" de seu próprio typeId, é o arquivo fonte do próprio
  // `component-catalog.json`) e depois cada item resolvido (dono = o `.lsdevice`/`.lssubcircuit`
  // que de fato o declara, nunca o `library.json` que só aponta pra ele). Diferente do
  // `if (baseTypeIds.has(...)) return [];` de antes (skip silencioso, sem aviso nenhum), todo
  // conflito agora é reportado -- mantém só a PRIMEIRA definição no catálogo mesclado (a extensão
  // continua utilizável) mas nunca esconde a duplicidade do usuário.
  const owners: DeviceIdOwner[] = unifiedCatalog.catalog.map((entry) => ({ typeId: entry.typeId, sourceFile: unifiedCatalog.sourcePath }));
  for (const item of resolved) {
    const sourceFile = sourceFileById.get(item.sourceId);
    if (sourceFile) owners.push({ typeId: item.entry.typeId, sourceFile });
  }
  const conflicts = checkDeviceIdUniqueness(owners);
  for (const conflict of conflicts) {
    void vscode.window.showErrorMessage(formatDeviceIdConflict(conflict));
  }
  const conflictingTypeIds = new Set(conflicts.map((conflict) => conflict.typeId));

  const baseTypeIds = new Set(unifiedCatalog.catalog.map((entry) => entry.typeId));
  const seenRegisteredTypeIds = new Set<string>();
  const registeredEntries = resolved.flatMap((item) => {
    const failedReason = item.libraryPathToLoad
      ? failures.get(normalizeAbsolutePath(extensionPath, item.libraryPathToLoad))
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
    // Conflito entre 2 fontes registradas (nunca contra o catálogo base, já coberto acima): mantém
    // só a primeira ocorrência na ordem de `resolved` -- mesma semântica de `checkDeviceIdUniqueness`
    // (primeira definição sobrevive, demais são só reportadas, nunca aplicadas silenciosamente).
    if (conflictingTypeIds.has(item.entry.typeId)) {
      if (seenRegisteredTypeIds.has(item.entry.typeId)) return [];
      seenRegisteredTypeIds.add(item.entry.typeId);
    }
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
      "Componente externo LasecSimul": ["lsdevice", "lssubcircuit"],
    },
    title: "Adicionar componente externo",
  });
  const selected = picked?.[0];
  if (!selected) return;

  let newSources: RegisteredSource[] = [];
  let importedTypeId: string | undefined;
  try {
    const manifest = validateExternalManifest(selected.fsPath, readJsonFile(selected.fsPath));
    importedTypeId = manifest.typeId;
    const duplicate = state.schematicState.catalog.find((entry) =>
      entry.typeId === manifest.typeId && entry.typeId !== "devices.external" && entry.typeId !== "subcircuits.external");
    if (duplicate) {
      vscode.window.showErrorMessage(`typeId duplicado: "${manifest.typeId}" já existe no catálogo.`);
      return;
    }
    const missing = missingManifestDependencies(selected.fsPath, manifest.json);
    if (missing.length > 0) {
      vscode.window.showErrorMessage(`Dependência ausente: ${missing.join(", ")}`);
      return;
    }
    const availableTypeIds = new Set(state.schematicState.catalog.map((entry) => entry.typeId));
    const missingTypes = manifestComponentDependencies(manifest).filter((typeId) => !availableTypeIds.has(typeId));
    if (missingTypes.length > 0) {
      vscode.window.showErrorMessage(`Dependência de componente ausente: ${missingTypes.join(", ")}`);
      return;
    }
    const copiedPath = copyExternalManifest(selected.fsPath, manifest, ctx.globalStorageUri.fsPath);
    newSources = inferSourcesFromSelectedFile(ctx.extensionPath, copiedPath).map((source) => ({
      ...source,
      folderPath: externalFolderPath(manifest.kind, currentLasecSimulLanguage()),
      ...(manifest.kind === "device" ? {
        libraryPath: writeAdhocDeviceLibrary(copiedPath, manifest, ctx.globalStorageUri.fsPath),
      } : {}),
    }));
  } catch (err) {
    vscode.window.showErrorMessage(
      `Não foi possível adicionar componente externo: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  if (newSources.length === 0) {
    vscode.window.showWarningMessage("Arquivo inválido ou extensão não suportada. Use .lsdevice ou .lssubcircuit.");
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
    vscode.window.showInformationMessage("O componente externo já estava adicionado à paleta.");
    return;
  }

  const mergedSources = [...unifiedCatalog.registeredSources, ...deduped];
  const savedAt = saveRegisteredSources(ctx.extensionPath, mergedSources);
  await refreshUnifiedCatalogState(true, options);
  const loaded = importedTypeId
    ? state.schematicState.catalog.find((entry) => entry.typeId === importedTypeId)
    : undefined;
  if (!loaded || loaded.disabled) {
    vscode.window.showErrorMessage(
      `O componente foi registrado, mas falhou ao carregar: ${loaded?.disabledReason ?? "entrada não encontrada no catálogo"}`
    );
    return;
  }
  vscode.window.showInformationMessage(`Componente externo adicionado com sucesso (${deduped.length}). Catálogo salvo em ${savedAt}.`);
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
  const source = findRegisteredSourceById(state.extensionContext.extensionPath, unifiedCatalog, sourceId);
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
