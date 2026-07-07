import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { CoreClient } from "./ipc/CoreClient";
import { CoreProcess } from "./ipc/CoreProcess";
import { TrustStore } from "./trust/TrustStore";
import { isPreApproved, isPreBlocked, resolveConsentChoice, shouldLoadLibrary, decisionToPersist } from "./trust/trustDecision";
import { SchematicPanel } from "./ui/panels/SchematicPanel";
import { createInitialWebviewState } from "./ui/webview/catalog";
import { InteractionKindEntry, JUNCTION_TYPE_ID, PackageDescriptor, PackagePin, PackageShape, PropertySchemaEntry, TUNNEL_TYPE_ID, WebviewComponentCatalogEntry, WebviewComponentModel, WebviewProjectState, WebviewWireModel } from "./ui/webview/model";
import { buildPinToPinWire, buildPinToWireConnection } from "./ui/webview/wireConnections";
import { InternalComponentSnapshot, WebviewToHostMessage } from "./ui/webview/messages";
import { ComponentPaletteViewProvider } from "./ui/views/ComponentPaletteViewProvider";
import { componentLocalOrigin } from "./ui/webview/componentSymbols";
import { ProjectSerializer } from "./project/ProjectSerializer";
import { ProjectComponent, ProjectDocument, createEmptyProject } from "./project/ProjectTypes";
import { loadUnifiedCatalog, RegisteredSource, saveRegisteredSources } from "./catalog/UnifiedCatalog";
import { extractSimulideSubcircuitScene, translateSimulideSubcircuitAuthoringScene } from "./catalog/simulideSceneTranslator";
import {
  compileSubcircuitInternalComponents,
  compileSymbolAuthoringComponents,
  InternalComponentSeed,
  InternalWireSeed,
  seedSubcircuitInternalComponents,
  seedSymbolAuthoringComponents,
  VisualPosition,
} from "./catalog/symbolAuthoring";
import { hasShowOnSymbolProperty, mergePropertySchemas, nextIndexedLabel } from "./catalog/catalogMerge";
import { sanitizeManifestDefaultProperties, sanitizePackage, sanitizePackageBackground } from "./catalog/packageSanitizers";
import { LasecSimulLanguage } from "./language";
import { fileExists, normalizeAbsolutePath, readJsonFile } from "./pathUtils";
import { currentLasecSimulLanguage } from "./currentLanguage";
import {
  RegisteredItemKind,
  inferLibraryPathForDevice,
  sanitizeFolderPathSegments,
  folderPathFromManifestFile,
  localizedAbiFailure,
  knownPinIdsForManifest,
  parseSubcircuitManifest,
  resolveRegisteredItem,
  resolveRegisteredItems,
} from "./catalog/registeredSources";
import {
  state,
  coreInstanceIdByComponentId,
  mcuTargetCoreIdByComponentId,
  mcuSerialMonitorByKey,
  projectSerializer,
} from "./state";
import {
  reportCoreWarning,
  registerCoreIdsForComponent,
  pushComponentToCore,
  pushWireToCore,
  pushRemoveWireToCore,
  pushPropertyToCore,
  pushRemoveToCore,
  sendInstrumentHistory,
  pollInstrumentReadouts,
  pollWireVoltages,
  stopVoltageReadoutPolling,
  setSimulationStatus,
  runSimulation,
  pauseSimulation,
  stopSimulation,
  shouldSyncComponentToCore,
  queueCoreRebuild,
  rebuildCoreFromSchematicState,
  pinsForProjectComponent,
} from "./core/coreLifecycle";

function setSchematicOpenContext(isOpen: boolean): Thenable<void> {
  return vscode.commands.executeCommand("setContext", "lasecsimul.schematicOpen", isOpen);
}

function nextId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

/** `catalog` NUNCA é mutado in-place (só substituído por inteiro via `setEffectiveCatalog`, ver lá)
 * -- excluído do round-trip `JSON.stringify`/`JSON.parse` abaixo e reanexado por referência depois.
 * Usado só pro snapshot COMPLETO inicial (`openSchematicEditor`/painel recriado) -- ver
 * `computeProjectStatePatch` pro caminho incremental de toda mutação seguinte (PC-1/EX-7). */
function cloneState(): WebviewProjectState {
  const { catalog, ...rest } = state.schematicState;
  return { ...(JSON.parse(JSON.stringify(rest)) as Omit<WebviewProjectState, "catalog">), catalog };
}

const PROJECT_STATE_KEYS = [
  "locale", "catalog", "components", "wires", "viewport", "selectedComponentIds", "selectedWireIds", "pendingConnection",
] as const satisfies readonly (keyof WebviewProjectState)[];

/** Último `state.schematicState` já mandado pra Webview (via `syncState`/`syncStatePatch`) -- `undefined`
 * enquanto o painel ainda não recebeu nenhum snapshot completo (`init`, ver `openSchematicEditor`).
 * Comparado por REFERÊNCIA (não por valor) contra `state.schematicState` atual em
 * `computeProjectStatePatch` -- barato, e correto porque todo mutador deste arquivo segue o padrão
 * `state.schematicState = {...state.schematicState, campoQueMudou: novoValor}` (~17 sites): um campo NÃO tocado
 * mantém a MESMA referência de antes, então `!==` já detecta exatamente "isto mudou" sem precisar de
 * comparação profunda. */

/** PC-1/EX-7 (.spec/lasecsimul-native-devices.spec): mensagens incrementais -- `syncSchematicPanel`
 * roda a cada mutação pequena do projeto (mover 1 componente, editar 1 propriedade, apagar 1 fio --
 * ~18 call sites), mas ANTES mandava o `WebviewProjectState` inteiro (clonado via JSON de novo) toda
 * vez, mesmo quando só UM dos ~8 campos de nível superior mudou. Serializa só os campos que
 * REALMENTE mudaram desde o último sync -- `catalog` em particular (schemas/ícones/packages de todo
 * typeId registrado, tipicamente o maior pedaço do estado) quase nunca muda, então a maioria das
 * chamadas nem chega a tocar nele. Devolve `undefined` quando nada mudou (chamador não manda
 * mensagem nenhuma nesse caso -- nunca um patch vazio). */
type ProjectStatePatch = Omit<Partial<WebviewProjectState>, "pendingConnection"> & {
  pendingConnection?: WebviewProjectState["pendingConnection"] | null;
};

function computeProjectStatePatch(): ProjectStatePatch | undefined {
  const previous = state.lastSyncedProjectState;
  const changedKeys = previous
    ? PROJECT_STATE_KEYS.filter((key) => state.schematicState[key] !== previous[key])
    : [...PROJECT_STATE_KEYS]; // painel ainda não recebeu nenhum snapshot (não deveria acontecer -- syncSchematicPanel só roda depois de "init" -- mas cobre defensivamente)
  if (changedKeys.length === 0) return undefined;

  const toClone: Record<string, unknown> = {};
  let catalogIncluded = false;
  for (const key of changedKeys) {
    if (key === "catalog") { catalogIncluded = true; continue; }
    // `pendingConnection` é o único campo opcional que de fato fica `undefined` em uso normal
    // (começar/cancelar um fio) -- `undefined` desaparece silenciosamente de um JSON.stringify (a
    // chave nem aparece no resultado), então sem o sentinela `null` explícito aqui "voltou a
    // undefined" ficaria indistinguível de "não mudou" pro merge do lado da Webview.
    if (key === "pendingConnection" && state.schematicState.pendingConnection === undefined) {
      toClone[key] = null;
      continue;
    }
    toClone[key] = state.schematicState[key];
  }
  const patch = JSON.parse(JSON.stringify(toClone)) as ProjectStatePatch;
  if (catalogIncluded) patch.catalog = state.schematicState.catalog;
  state.lastSyncedProjectState = state.schematicState;
  return patch;
}

function syncSchematicPanel(): void {
  state.schematicPanel?.setLanguage(state.schematicState.locale ?? currentLasecSimulLanguage());
  const patch = computeProjectStatePatch();
  if (patch) state.schematicPanel?.postMessage({ version: 1, type: "syncStatePatch", patch });
  state.schematicPanel?.postMessage({ version: 1, type: "simulationStatus", status: state.simulationStatus });
}

function openSchematicEditor(extensionUri: vscode.Uri): void {
  state.schematicPanel = SchematicPanel.createOrShow(extensionUri, cloneState(), handleWebviewMessage, () => {
    state.schematicPanel = undefined;
    state.lastSyncedProjectState = undefined; // painel fechado -- o próximo (novo ou reaberto) recebe "init" completo de novo
    void setSchematicOpenContext(false);
  });
  // `createOrShow` acabou de mandar um snapshot COMPLETO (painel novo -> "init", painel já existente
  // -> "syncState" direto, ver SchematicPanel.ts) -- em qualquer um dos dois casos, o próximo
  // `syncSchematicPanel()` deve comparar contra ESTE `state.schematicState`, não mandar tudo nem achar
  // que nenhum snapshot foi enviado ainda.
  state.lastSyncedProjectState = state.schematicState;
  void setSchematicOpenContext(true);
  setSimulationStatus(state.simulationStatus);
}

/** Localiza o binário do Core dentro de `core/build/`. Geradores single-config (Ninja simples)
 * colocam o executável direto em `core/build/`; geradores multi-config (Visual Studio, Ninja Multi-
 * Config — os dois caminhos documentados no README para Windows) colocam em `core/build/Debug/` ou
 * `core/build/Release/`. Sem checar os dois, a extensão tenta abrir um arquivo que não existe em
 * qualquer build feito com o gerador padrão do Windows. */
function resolveCoreExecutablePath(extensionPath: string): string {
  const coreBin = process.platform === "win32" ? "lasecsimul-core.exe" : "lasecsimul-core";
  const buildDirs = [
    path.join(extensionPath, "..", "core", "build"),
    path.join(extensionPath, "bundled", "core", "build"),
  ];
  const candidates = buildDirs.flatMap((buildDir) => [
    path.join(buildDir, coreBin),
    path.join(buildDir, "Debug", coreBin),
    path.join(buildDir, "Release", coreBin),
    path.join(buildDir, "RelWithDebInfo", coreBin),
  ]);
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]!;
}

function setEffectiveCatalog(entries: WebviewComponentCatalogEntry[]): void {
  state.schematicState = { ...state.schematicState, catalog: entries };
  state.paletteViewProvider?.setCatalog(entries);
  syncSchematicPanel();
}

/** Lê `publisher`/`trust` do `library.json` e decide se o carregamento pode seguir -- nunca lança:
 * arquivo ilegível/sem esses campos é tratado como publisher "desconhecido", não first-party (o
 * próprio `loadDeviceLibrary` no Core reporta o erro real se o arquivo for inválido de verdade).
 * Ver `.spec/lasecsimul-native-devices.spec` seção 12, item 2 -- consentimento mora na Extension,
 * nunca no Core. */
async function ensureLibraryTrusted(libraryPath: string): Promise<boolean> {
  if (!state.extensionContext) return false;
  if (!state.trustStore) state.trustStore = new TrustStore(state.extensionContext);

  let manifest: { publisher?: string; trust?: string } = {};
  try {
    manifest = JSON.parse(fs.readFileSync(libraryPath, "utf8"));
  } catch {
    return true; // deixa o Core recusar o arquivo inválido com o erro real
  }
  const publisher = manifest.publisher ?? "desconhecido";
  const stored = state.trustStore.decisionFor(publisher);

  if (isPreApproved(manifest.trust, stored)) return true;
  if (isPreBlocked(manifest.trust, stored)) return false;

  const buttonLabel = await vscode.window.showWarningMessage(
    `Este pacote contém código nativo sem isolamento e pode travar ou comprometer o simulador. Confiar em "${publisher}"?`,
    { modal: true },
    "Permitir uma vez",
    "Sempre confiar",
    "Bloquear"
  );
  const choice = resolveConsentChoice(buttonLabel);
  const toPersist = decisionToPersist(choice);
  if (toPersist) await state.trustStore.setDecision(publisher, toPersist);
  return shouldLoadLibrary(choice);
}

/** Carrega no Core bibliotecas declaradas (base + registradas) e devolve mapa de erro por caminho.
 * Falha em uma biblioteca não bloqueia as demais. */
async function loadConfiguredDeviceLibraries(
  extensionPath: string,
  requests: Array<{ displayPath: string; absolutePath: string }>
): Promise<Map<string, string>> {
  const failures = new Map<string, string>();
  if (!state.coreClient) return failures;

  for (const request of requests) {
    const libraryPath = normalizeAbsolutePath(extensionPath, request.absolutePath);
    try {
      const trusted = await ensureLibraryTrusted(libraryPath);
      if (!trusted) {
        failures.set(libraryPath, "carregamento bloqueado: publisher não confiável (ver consentimento de plugin)");
        continue;
      }
      await state.coreClient.loadDeviceLibrary(libraryPath);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failures.set(libraryPath, reason);
      reportCoreWarning(`carregar biblioteca de dispositivos "${request.displayPath}"`, err);
    }
  }

  return failures;
}

/** Clique num componente do overlay de Modo Placa (botão EN/BOOT etc. desenhados sobre a foto da
 * placa no circuito PRINCIPAL) -- `outerComponentId` é a instância do subcircuito já mapeada em
 * `coreInstanceIdByComponentId`; `innerComponentId` é o id LOCAL do `.lssubcircuit` (ex:
 * "button_en"), resolvido pelo Core via `findSubcircuitChildByLocalId` (ver
 * `CoreApplication.cpp::"setSubcircuitChildProperty"`). */
function updateBoardOverlayPropertyCommand(outerComponentId: string, innerComponentId: string, name: string, value: string | number | boolean): void {
  if (!state.coreClient) return;
  const coreId = coreInstanceIdByComponentId.get(outerComponentId);
  if (!coreId) return;
  state.coreClient
    .setSubcircuitChildProperty(coreId, innerComponentId, name, value)
    .catch((err) => reportCoreWarning(`atualizar "${innerComponentId}.${name}" (Modo Placa)`, err));
}

function getComponentById(componentId: string): WebviewComponentModel | undefined {
  return state.schematicState.components.find((component) => component.id === componentId);
}

function componentLabel(componentId: string): string {
  return getComponentById(componentId)?.label ?? componentId;
}

function resolveMcuTargetCoreId(componentId: string): string | undefined {
  return mcuTargetCoreIdByComponentId.get(componentId) ?? coreInstanceIdByComponentId.get(componentId);
}

function resolveSourceIdForComponent(componentId: string): string | undefined {
  const component = getComponentById(componentId);
  if (!component) return undefined;
  return state.schematicState.catalog.find((entry) => entry.typeId === component.typeId)?.registeredSourceId;
}

function resolveSubcircuitChildCoreId(outerComponentId: string, innerComponentId: string): Promise<string | undefined> {
  const outerCoreId = coreInstanceIdByComponentId.get(outerComponentId);
  if (!state.coreClient || !outerCoreId) return Promise.resolve(undefined);
  return state.coreClient.getSubcircuitChildInstanceId(outerCoreId, innerComponentId).catch(() => undefined);
}

function closeMcuSerialMonitor(componentId: string, usartIndex?: number): void {
  for (const [key, monitor] of mcuSerialMonitorByKey) {
    const parts = key.split(":");
    const currentComponentId = parts[0];
    const currentUsartIndex = parts[parts.length - 1];
    if (currentComponentId !== componentId) continue;
    if (usartIndex !== undefined && Number(currentUsartIndex) !== usartIndex) continue;
    clearInterval(monitor.timer);
    monitor.channel.dispose();
    mcuSerialMonitorByKey.delete(key);
  }
}

function closeAllMcuSerialMonitors(): void {
  for (const [key, monitor] of mcuSerialMonitorByKey) {
    clearInterval(monitor.timer);
    monitor.channel.dispose();
    mcuSerialMonitorByKey.delete(key);
  }
}

async function chooseMcuFirmwareCommand(componentId: string): Promise<void> {
  const component = getComponentById(componentId);
  if (!component) return;
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { Firmware: ["bin", "elf", "hex"] },
    title: `Selecionar firmware para ${component.label}`,
  });
  const selected = picked?.[0];
  if (!selected) return;

  const firmwarePath = selected.fsPath;
  const qemuBinaryOverride = typeof component.properties.qemuBinaryOverride === "string" ? component.properties.qemuBinaryOverride : "";
  state.schematicState = {
    ...state.schematicState,
    components: state.schematicState.components.map((entry) =>
      entry.id === componentId
        ? { ...entry, properties: { ...entry.properties, firmwarePath } }
        : entry
    ),
  };
  syncSchematicPanel();

  if (state.simulationStatus === "running") {
    const targetCoreId = resolveMcuTargetCoreId(componentId);
    if (state.coreClient && targetCoreId) {
      try {
        await state.coreClient.loadMcuFirmware(targetCoreId, firmwarePath, qemuBinaryOverride || undefined);
      } catch (err) {
        reportCoreWarning(`carregar firmware de "${component.label}"`, err);
      }
    }
  }
}

async function chooseExposedMcuFirmwareCommand(outerComponentId: string, innerComponentId: string): Promise<void> {
  const sourceId = resolveSourceIdForComponent(outerComponentId);
  const inner = sourceId ? gatherInternalComponentSnapshots(sourceId)?.find((entry) => entry.id === innerComponentId) : undefined;
  const label = inner?.label ?? innerComponentId;
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { Firmware: ["bin", "elf", "hex"] },
    title: `Selecionar firmware para ${label}`,
  });
  const selected = picked?.[0];
  if (!selected || !sourceId) return;

  const firmwarePath = selected.fsPath;
  const qemuBinaryOverride = typeof inner?.properties.qemuBinaryOverride === "string" ? inner.properties.qemuBinaryOverride : "";
  await updateExposedComponentPropertyCommand(outerComponentId, sourceId, innerComponentId, "firmwarePath", firmwarePath);

  if (state.simulationStatus === "running") {
    const targetCoreId = await resolveSubcircuitChildCoreId(outerComponentId, innerComponentId);
    if (state.coreClient && targetCoreId) {
      try {
        await state.coreClient.loadMcuFirmware(targetCoreId, firmwarePath, qemuBinaryOverride || undefined);
      } catch (err) {
        reportCoreWarning(`carregar firmware de "${label}"`, err);
      }
    }
  }
}

/** Bloco genérico de subcircuito por caminho (`subcircuits.external`, ou qualquer typeId já
 * resolvido antes) -- abre um seletor de `.lssubcircuit`, deriva typeId/pinos/package via
 * `parseSubcircuitManifest` (mesma lógica de `resolveRegisteredItem`, sem exigir registro na
 * paleta), registra a definição no Core (verbo IPC avulso `registerAdhocSubcircuit`, sem
 * `library.json`) e troca o typeId/pinos da instância. Mesmo comando serve pra escolha inicial e
 * pra "relink" (arquivo ausente ou trocar de arquivo depois de já resolvido). Fios cujo pinId
 * sobrevive no novo arquivo são mantidos, os que não existem mais são removidos com aviso explícito
 * (nunca silenciosamente) -- ver `.spec/lasecsimul-subcircuits.spec` seção 12. */
async function chooseSubcircuitFileCommand(componentId: string): Promise<void> {
  const component = getComponentById(componentId);
  if (!component) return;

  const previousDir = component.subcircuitRef?.path ? path.dirname(absoluteSubcircuitRefPath(component.subcircuitRef.path)) : undefined;
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { "Subcircuito LasecSimul": ["lssubcircuit"] },
    title: `Selecionar subcircuito para ${component.label}`,
    defaultUri: previousDir && fileExists(previousDir) ? vscode.Uri.file(previousDir) : undefined,
  });
  const selected = picked?.[0];
  if (!selected) return;
  const absolutePath = selected.fsPath;

  if (!state.coreClient) {
    vscode.window.showErrorMessage("Core indisponivel: nao foi possivel validar o subcircuito selecionado.");
    return;
  }

  try {
    await state.coreClient.registerAdhocSubcircuit(absolutePath, { replace: Boolean(component.subcircuitRef?.lastKnownTypeId) });
  } catch (err) {
    vscode.window.showErrorMessage(`Não foi possível ler ${absolutePath}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const parsed = parseSubcircuitManifest(
    readJsonFile(absolutePath) as Record<string, unknown>,
    path.dirname(absolutePath),
    currentLasecSimulLanguage(),
    new Set(state.schematicState.catalog.filter((entry) => entry.registeredSourceKind === "mcu-adapter").map((entry) => entry.typeId))
  );
  if (!parsed.typeId) {
    vscode.window.showErrorMessage(`Arquivo inválido: "${path.basename(absolutePath)}" não declara "typeId".`);
    return;
  }

  const newPinIds = parsed.pinIds.length > 0 ? parsed.pinIds : Array.from({ length: parsed.pinCount }, (_, index) => `pin-${index + 1}`);
  const newPinIdSet = new Set(newPinIds);
  const newPins = newPinIds.map((id, index) => ({ id, x: 0, y: index * 12 }));

  // Diff de fios: mantém quem sobrevive no novo arquivo, remove (com aviso) quem não existe mais --
  // nunca perde fio em silêncio.
  const survivingWireIds = new Set<string>();
  let droppedWireCount = 0;
  for (const wire of state.schematicState.wires) {
    const touchesFrom = wire.from.componentId === componentId;
    const touchesTo = wire.to.componentId === componentId;
    if (!touchesFrom && !touchesTo) {
      survivingWireIds.add(wire.id);
      continue;
    }
    const ownPinId = touchesFrom ? wire.from.pinId : wire.to.pinId;
    if (newPinIdSet.has(ownPinId)) survivingWireIds.add(wire.id);
    else droppedWireCount++;
  }

  const label = parsed.label || parsed.typeId;
  const ephemeralEntry: WebviewComponentCatalogEntry = {
    typeId: parsed.typeId,
    label,
    category: "Subcircuitos",
    hidden: true, // nunca aparece na paleta -- só resolve por typeId, ver paletteTree.ts
    pinCount: parsed.pinCount,
    pinIds: parsed.pinIds.length > 0 ? parsed.pinIds : undefined,
    defaultProperties: parsed.defaultProperties,
    icon: parsed.icon,
    iconFilePath: parsed.iconFilePath,
    iconSvgInline: parsed.iconSvgInline,
    package: parsed.package,
    logicSymbolPackage: parsed.logicSymbolPackage,
    disabled: false,
    mcuHost: parsed.mcuHost,
    serialPorts: parsed.serialPorts,
  };

  const updatedComponent: WebviewComponentModel = {
    ...component,
    typeId: parsed.typeId,
    label: component.typeId === parsed.typeId ? component.label : nextIndexedLabel(parsed.typeId, label, state.schematicState.components),
    pins: newPins,
    properties: parsed.defaultProperties,
    subcircuitRef: { path: absolutePath, lastKnownTypeId: parsed.typeId, lastKnownPinIds: newPinIds },
  };

  state.schematicState = {
    ...state.schematicState,
    catalog: [...state.schematicState.catalog.filter((entry) => entry.typeId !== parsed.typeId), ephemeralEntry],
    components: state.schematicState.components.map((entry) => (entry.id === componentId ? updatedComponent : entry)),
    wires: state.schematicState.wires.filter((wire) => survivingWireIds.has(wire.id)),
  };

  // Recria no Core: o typeId pode ter mudado (pino fixo desde a construção, não dá pra
  // redimensionar in-place) -- remove a instância antiga, registra a definição avulsa, cria de
  // novo e reconecta os fios sobreviventes contra o NOVO instanceId.
  pushRemoveToCore(componentId);
  coreInstanceIdByComponentId.delete(componentId);
  mcuTargetCoreIdByComponentId.delete(componentId);
  if (state.coreClient && shouldSyncComponentToCore(parsed.typeId)) {
    try {
      const response = await state.coreClient.addComponent(parsed.typeId, updatedComponent.properties, newPins);
      registerCoreIdsForComponent(componentId, parsed.typeId, response);
      for (const wire of state.schematicState.wires) {
        if (wire.from.componentId === componentId || wire.to.componentId === componentId) await pushWireToCore(wire);
      }
      if (state.simulationStatus === "running") {
        void pollInstrumentReadouts();
        void pollWireVoltages();
      }
    } catch (err) {
      reportCoreWarning(`registrar subcircuito "${label}"`, err);
    }
  }

  syncSchematicPanel();
  if (droppedWireCount > 0) {
    vscode.window.showWarningMessage(`${droppedWireCount} fio(s) removido(s): pino(s) não existem mais no novo subcircuito.`);
  }
}

async function reloadMcuFirmwareCommand(componentId: string): Promise<void> {
  const component = getComponentById(componentId);
  if (!component) return;
  const firmwarePath = typeof component.properties.firmwarePath === "string" ? component.properties.firmwarePath.trim() : "";
  const qemuBinaryOverride = typeof component.properties.qemuBinaryOverride === "string" ? component.properties.qemuBinaryOverride.trim() : "";
  if (!firmwarePath) {
    vscode.window.showWarningMessage(`Defina o firmware do componente "${component.label}" primeiro.`);
    return;
  }
  const targetCoreId = resolveMcuTargetCoreId(componentId);
  if (!state.coreClient || !targetCoreId) {
    vscode.window.showWarningMessage(`O MCU de "${component.label}" ainda nao esta disponivel no Core.`);
    return;
  }
  try {
    await state.coreClient.loadMcuFirmware(targetCoreId, firmwarePath, qemuBinaryOverride || undefined);
  } catch (err) {
    reportCoreWarning(`recarregar firmware de "${component.label}"`, err);
  }
}

async function reloadExposedMcuFirmwareCommand(outerComponentId: string, innerComponentId: string): Promise<void> {
  const sourceId = resolveSourceIdForComponent(outerComponentId);
  const inner = sourceId ? gatherInternalComponentSnapshots(sourceId)?.find((entry) => entry.id === innerComponentId) : undefined;
  const label = inner?.label ?? innerComponentId;
  const firmwarePath = typeof inner?.properties.firmwarePath === "string" ? inner.properties.firmwarePath.trim() : "";
  const qemuBinaryOverride = typeof inner?.properties.qemuBinaryOverride === "string" ? inner.properties.qemuBinaryOverride.trim() : "";
  if (!firmwarePath) {
    vscode.window.showWarningMessage(`Defina o firmware do componente "${label}" primeiro.`);
    return;
  }
  const targetCoreId = await resolveSubcircuitChildCoreId(outerComponentId, innerComponentId);
  if (!state.coreClient || !targetCoreId) {
    vscode.window.showWarningMessage(`O MCU de "${label}" ainda nao esta disponivel no Core.`);
    return;
  }
  try {
    await state.coreClient.loadMcuFirmware(targetCoreId, firmwarePath, qemuBinaryOverride || undefined);
  } catch (err) {
    reportCoreWarning(`recarregar firmware de "${label}"`, err);
  }
}

function serialPortLabelForTypeId(typeId: string | undefined, usartIndex: 0 | 1 | 2): string | undefined {
  if (!typeId) return undefined;
  const entry = state.schematicState.catalog.find((item) => item.typeId === typeId);
  return entry?.serialPorts?.find((port) => port.usartIndex === usartIndex)?.label;
}

function openMcuSerialMonitorCommand(componentId: string, usartIndex: 0 | 1 | 2): void {
  const targetCoreId = resolveMcuTargetCoreId(componentId);
  const component = getComponentById(componentId);
  const serialPortLabel = serialPortLabelForTypeId(component?.typeId, usartIndex);
  if (!state.coreClient || !targetCoreId || !component || !serialPortLabel) {
    vscode.window.showWarningMessage("Monitor serial indisponivel para este componente.");
    return;
  }
  const key = `${componentId}:${usartIndex}`;
  const existing = mcuSerialMonitorByKey.get(key);
  if (existing) {
    existing.channel.show(true);
    return;
  }

  const channel = vscode.window.createOutputChannel(`LasecSimul ${serialPortLabel} - ${component.label}`);
  channel.appendLine(`[${new Date().toLocaleString()}] Monitor serial aberto para ${component.label} (${serialPortLabel}).`);
  channel.appendLine("Observacao: por enquanto o monitor espelha os logs/saida do QEMU expostos pelo Core.");

  const pollLogs = async (): Promise<void> => {
    try {
      const logs = await state.coreClient!.getMcuLogs(targetCoreId);
      const monitor = mcuSerialMonitorByKey.get(key);
      if (!monitor) return;
      const delta = logs.slice(monitor.lastLength);
      if (delta) {
        channel.append(delta);
        monitor.lastLength = logs.length;
      } else if (logs.length < monitor.lastLength) {
        channel.appendLine(`\n[${new Date().toLocaleTimeString()}] logs reiniciados`);
        if (logs) channel.append(logs);
        monitor.lastLength = logs.length;
      }
    } catch (err) {
      channel.appendLine(`\n[erro] ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const timer = setInterval(() => void pollLogs(), 500);
  mcuSerialMonitorByKey.set(key, { channel, timer, lastLength: 0 });
  channel.show(true);
  void pollLogs();
}

async function openExposedMcuSerialMonitorCommand(outerComponentId: string, innerComponentId: string, usartIndex: 0 | 1 | 2): Promise<void> {
  const sourceId = resolveSourceIdForComponent(outerComponentId);
  const inner = sourceId ? gatherInternalComponentSnapshots(sourceId)?.find((entry) => entry.id === innerComponentId) : undefined;
  const label = inner?.label ?? innerComponentId;
  const serialPortLabel = serialPortLabelForTypeId(inner?.typeId, usartIndex);
  const targetCoreId = await resolveSubcircuitChildCoreId(outerComponentId, innerComponentId);
  if (!state.coreClient || !targetCoreId || !serialPortLabel) {
    vscode.window.showWarningMessage("Monitor serial indisponivel para este componente.");
    return;
  }
  const key = `${outerComponentId}:${innerComponentId}:${usartIndex}`;
  const existing = mcuSerialMonitorByKey.get(key);
  if (existing) {
    existing.channel.show(true);
    return;
  }

  const channel = vscode.window.createOutputChannel(`LasecSimul ${serialPortLabel} - ${label}`);
  channel.appendLine(`[${new Date().toLocaleString()}] Monitor serial aberto para ${label} (${serialPortLabel}).`);
  channel.appendLine("Observacao: por enquanto o monitor espelha os logs/saida do QEMU expostos pelo Core.");

  const pollLogs = async (): Promise<void> => {
    try {
      const logs = await state.coreClient!.getMcuLogs(targetCoreId);
      const monitor = mcuSerialMonitorByKey.get(key);
      if (!monitor) return;
      const delta = logs.slice(monitor.lastLength);
      if (delta) {
        channel.append(delta);
        monitor.lastLength = logs.length;
      } else if (logs.length < monitor.lastLength) {
        channel.appendLine(`\n[${new Date().toLocaleTimeString()}] logs reiniciados`);
        if (logs) channel.append(logs);
        monitor.lastLength = logs.length;
      }
    } catch (err) {
      channel.appendLine(`\n[erro] ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const timer = setInterval(() => void pollLogs(), 500);
  mcuSerialMonitorByKey.set(key, { channel, timer, lastLength: 0 });
  channel.show(true);
  void pollLogs();
}

/** `pinIds` (quando presente) é o contrato elétrico REAL na ordem que o Core espera -- plugins usam
 * o id enviado aqui diretamente (`NativeDeviceProxy`/`McuComponent`, ver `CoreApplication.cpp`,
 * `addComponent`), nunca um `pin-N` genérico sem relação com nada real. Sem `pinIds` (built-ins sem
 * schema próprio), mantém o numerador genérico de sempre. Ver `model.ts::
 * WebviewComponentCatalogEntry.pinIds`. */
export function pinsForTypeId(typeId: string): Array<{ id: string; x: number; y: number }> {
  const descriptor = state.schematicState.catalog.find((item) => item.typeId === typeId);
  const pinCount = descriptor?.pinCount ?? 2;
  if (descriptor?.pinIds && descriptor.pinIds.length === pinCount) {
    return descriptor.pinIds.map((id, index) => ({ id, x: 0, y: index * 12 }));
  }
  return Array.from({ length: pinCount }, (_, index) => ({ id: `pin-${index + 1}`, x: 0, y: index * 12 }));
}

/** `pinsForTypeId` já devolve o id elétrico REAL (`p1`/`p2`/`pin`/`out`...) pros builtins que o Core
 * declara via `getPropertySchemas` (ver `CoreApplication.cpp::registerBuiltinMetadata`, EX-4.2) --
 * cai no numerador genérico (`pin-1`/`pin-2`...) só quando o catálogo AINDA não tem `pinIds` pra
 * este typeId (ex: `switches.push`, que não declara id canônico fixo; ou o catálogo ainda não
 * terminou de sincronizar com o Core). Este `realIds` abaixo é a rede de segurança pra esse caso
 * residual: `.lssubcircuit::wires[]` de um subcircuito no disco já usa o id elétrico real, e sem
 * correspondência `pinScenePosition` (main.ts) nunca acha o pino certo no componente seedado e a
 * wire some da tela (raiz do "não tem linha nenhuma" reportado ao abrir um subcircuito pra editar).
 * Substitui cada id genérico pelo id real encontrado em QUALQUER wire que toque este componente, na
 * MESMA posição/índice (geometria de `pinLocalPosition` é por índice pra typeIds sem `package`,
 * então a troca de string não move nada na tela -- só agora bate com o que a wire espera); typeIds
 * COM `package`/`pinIds` já corretos (ex: `espressif.esp32`, e agora os builtins canônicos também)
 * têm o id "real" encontrado aqui sempre redundante/igual, nunca pior. */
function pinsForInternalComponent(componentId: string, typeId: string, wires: InternalWireSeed[]): Array<{ id: string; x: number; y: number }> {
  const generic = pinsForTypeId(typeId);
  const realIds: string[] = [];
  for (const wire of wires) {
    if (wire.from.componentId === componentId && wire.from.pinId && !realIds.includes(wire.from.pinId)) realIds.push(wire.from.pinId);
    if (wire.to.componentId === componentId && wire.to.pinId && !realIds.includes(wire.to.pinId)) realIds.push(wire.to.pinId);
  }
  if (realIds.length === 0) return generic;

  const count = Math.max(generic.length, realIds.length);
  return Array.from({ length: count }, (_, index) => ({
    id: realIds[index] ?? generic[index]?.id ?? `pin-${index + 1}`,
    x: 0,
    y: index * 12,
  }));
}

/** Roda logo depois de `projectToWebviewState` num `openProjectCommand`, ANTES de
 * `rebuildCoreFromSchematicState` (o typeId precisa estar certo e o Core precisar já ter a
 * definição avulsa registrada antes do rebuild tentar `addComponent`). Pra cada componente com
 * `subcircuitRef`: se o arquivo `.lssubcircuit` (resolvido relativo ao diretório do `.lsproj`, ou
 * absoluto) existir, resolve normalmente e registra a definição no Core -- SILENCIOSO, igual à
 * resolução de qualquer `RegisteredSource` hoje. Se não existir, preserva o componente como
 * placeholder (posição/propriedades/`lastKnownPinIds` intactos, ver `pinsForProjectComponent`) SEM
 * tentar `addComponent` -- nunca corrompe o schematic, só avisa UMA VEZ no final (nunca um toast por
 * componente). Ver `.spec/lasecsimul-subcircuits.spec` seção 12. */
async function resolveProjectSubcircuitReferences(projectDir: string): Promise<void> {
  const componentsWithRef = state.schematicState.components.filter((component) => component.subcircuitRef);
  if (componentsWithRef.length === 0) return;

  const language = currentLasecSimulLanguage();
  const newCatalogEntries: WebviewComponentCatalogEntry[] = [];
  const updatedComponents = new Map<string, WebviewComponentModel>();
  let missingCount = 0;

  for (const component of componentsWithRef) {
    const ref = component.subcircuitRef!;
    const absolutePath = normalizeAbsolutePath(projectDir, ref.path);
    if (!fileExists(absolutePath)) {
      missingCount++;
      continue;
    }

    if (!state.coreClient) {
      missingCount++;
      continue;
    }

    try {
      await state.coreClient.registerAdhocSubcircuit(absolutePath);
    } catch {
      missingCount++;
      continue;
    }
    const parsed = parseSubcircuitManifest(
      readJsonFile(absolutePath) as Record<string, unknown>,
      path.dirname(absolutePath),
      language,
      new Set(state.schematicState.catalog.filter((entry) => entry.registeredSourceKind === "mcu-adapter").map((entry) => entry.typeId))
    );
    if (!parsed.typeId) {
      missingCount++;
      continue;
    }

    const newPinIds = parsed.pinIds.length > 0 ? parsed.pinIds : Array.from({ length: parsed.pinCount }, (_, index) => `pin-${index + 1}`);
    const label = parsed.label || parsed.typeId;
    newCatalogEntries.push({
      typeId: parsed.typeId,
      label,
      category: "Subcircuitos",
      hidden: true,
      pinCount: parsed.pinCount,
      pinIds: parsed.pinIds.length > 0 ? parsed.pinIds : undefined,
      defaultProperties: parsed.defaultProperties,
      icon: parsed.icon,
      iconFilePath: parsed.iconFilePath,
      iconSvgInline: parsed.iconSvgInline,
      package: parsed.package,
      logicSymbolPackage: parsed.logicSymbolPackage,
      disabled: false,
      mcuHost: parsed.mcuHost,
      serialPorts: parsed.serialPorts,
    });
    updatedComponents.set(component.id, {
      ...component,
      typeId: parsed.typeId,
      pins: newPinIds.map((id, index) => ({ id, x: 0, y: index * 12 })),
      subcircuitRef: { path: ref.path, lastKnownTypeId: parsed.typeId, lastKnownPinIds: newPinIds },
    });
  }

  if (newCatalogEntries.length === 0 && updatedComponents.size === 0) {
    if (missingCount > 0) {
      vscode.window.showWarningMessage(
        `${missingCount} subcircuito(s) não encontrado(s). Clique com o botão direito no bloco para localizar o arquivo.`
      );
    }
    return;
  }

  const catalogTypeIds = new Set(newCatalogEntries.map((entry) => entry.typeId));
  state.schematicState = {
    ...state.schematicState,
    catalog: [...state.schematicState.catalog.filter((entry) => !catalogTypeIds.has(entry.typeId)), ...newCatalogEntries],
    components: state.schematicState.components.map((component) => updatedComponents.get(component.id) ?? component),
  };

  if (missingCount > 0) {
    vscode.window.showWarningMessage(
      `${missingCount} subcircuito(s) não encontrado(s). Clique com o botão direito no bloco para localizar o arquivo.`
    );
  }
}

/** Recria um projeto carregado de disco no Core, na ordem certa (todo componente antes de qualquer
 * fio) — diferente do caminho interativo, aqui é preciso aguardar cada chamada porque connectWire
 * depende do instanceId que addComponent ainda não tinha devolvido. */
async function pushProjectToCore(project: ProjectDocument): Promise<void> {
  if (!state.coreClient) return;
  coreInstanceIdByComponentId.clear();
  mcuTargetCoreIdByComponentId.clear();
  for (const component of project.components) {
    if (!shouldSyncComponentToCore(component.typeId)) continue;
    try {
      const response = await state.coreClient.addComponent(
        component.typeId,
        component.properties,
        pinsForTypeId(component.typeId)
      );
      registerCoreIdsForComponent(component.id, component.typeId, response);
    } catch (err) {
      reportCoreWarning(`criar "${component.typeId}" (${component.id})`, err);
    }
  }
  for (const wire of project.wires) {
    const coreA = coreInstanceIdByComponentId.get(wire.from.componentId);
    const coreB = coreInstanceIdByComponentId.get(wire.to.componentId);
    if (!coreA || !coreB) continue;
    try {
      await state.coreClient.connectWire(coreA, wire.from.pinId, coreB, wire.to.pinId);
    } catch (err) {
      reportCoreWarning(`conectar fio "${wire.id}"`, err);
    }
  }
}

function webviewComponentToProjectComponent(component: WebviewComponentModel): ProjectComponent {
  return {
    id: component.id,
    typeId: component.typeId,
    properties: component.properties,
    label: component.label,
    showId: component.showId,
    showValue: component.showValue,
    flipH: component.flipH,
    flipV: component.flipV,
    visual: { x: component.x, y: component.y, rotation: component.rotation },
    subcircuitRef: component.subcircuitRef,
  };
}

function validVisualPoints(points: unknown): Array<{ x: number; y: number }> {
  if (!Array.isArray(points)) return [];
  return points
    .filter((point): point is { x: number; y: number } =>
      typeof point === "object" &&
      point !== null &&
      "x" in point &&
      "y" in point &&
      Number.isFinite(point.x) &&
      Number.isFinite(point.y)
    )
    .map((point) => ({ x: point.x, y: point.y }));
}

function projectToWebviewState(project: ProjectDocument): WebviewProjectState {
  const catalog = state.schematicState.catalog;
  const visualWirePoints = new Map(
    project.visual.wires.map((wire) => [
      wire.id,
      validVisualPoints(wire.points),
    ])
  );
  const components: WebviewComponentModel[] = project.components.map((component) => {
    const descriptor = catalog.find((item) => item.typeId === component.typeId);
    return {
      id: component.id,
      typeId: component.typeId,
      // Projeto salvo antes desta versão não tem `label` -- cai pro catálogo, igual sempre foi.
      label: component.label ?? descriptor?.label ?? component.typeId,
      // `connectors.junction` SEMPRE nasce `hidden: true` (ver `junctionComponentAt`) -- um ponto de
      // fiação sem símbolo/rótulo visível, igual ao SimulIDE real. `ProjectComponent` (`.lsproj`) não
      // tem campo `hidden` pra persistir isso (só `descriptor?.hidden`, que é sobre esconder o
      // typeId da PALETA -- "Junção" é colocável manualmente de propósito, ver
      // `component-catalog.json`, então não pode virar `hidden` ali) -- sem esta exceção, reabrir um
      // projeto com uma junção virava um ponto/círculo visível que nunca deveria aparecer (mesma
      // causa raiz do bug real corrigido em `symbolAuthoring.ts::seedSubcircuitInternalComponents`
      // pro circuito INTERNO de um subcircuito).
      hidden: component.typeId === JUNCTION_TYPE_ID ? true : (descriptor?.hidden ?? false),
      showId: component.showId,
      showValue: component.showValue ?? hasShowOnSymbolProperty(descriptor),
      flipH: component.flipH,
      flipV: component.flipV,
      x: component.visual?.x ?? 0,
      y: component.visual?.y ?? 0,
      rotation: component.visual?.rotation ?? 0,
      pins: pinsForProjectComponent(component),
      properties: component.properties as Record<string, string | number | boolean>,
      subcircuitRef: component.subcircuitRef,
    };
  });
  const wires: WebviewWireModel[] = project.wires.map((wire) => {
    const points = visualWirePoints.get(wire.id);
    return {
      id: wire.id,
      from: wire.from,
      to: wire.to,
      ...(points && points.length > 0 ? { points } : {}),
    };
  });
  return {
    locale: currentLasecSimulLanguage(),
    catalog,
    components,
    wires,
    viewport: project.visual.viewport,
    selectedComponentIds: [],
    selectedWireIds: [],
  };
}

function sameWireEndpoints(a: WebviewWireModel, b: WebviewWireModel): boolean {
  return a.from.componentId === b.from.componentId
    && a.from.pinId === b.from.pinId
    && a.to.componentId === b.to.componentId
    && a.to.pinId === b.to.pinId;
}

function changedPropertyNames(
  previous: Record<string, string | number | boolean>,
  next: Record<string, string | number | boolean>
): string[] {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  return [...keys].filter((key) => key in next && previous[key] !== next[key]);
}

async function syncProjectSnapshotToCore(previous: WebviewProjectState, next: WebviewProjectState): Promise<void> {
  if (!state.coreClient) return;

  const previousComponentsById = new Map(previous.components.map((component) => [component.id, component]));
  const nextComponentsById = new Map(next.components.map((component) => [component.id, component]));
  const previousWiresById = new Map(previous.wires.map((wire) => [wire.id, wire]));
  const nextWiresById = new Map(next.wires.map((wire) => [wire.id, wire]));

  const typeChanged = next.components.some((component) => {
    const before = previousComponentsById.get(component.id);
    return before && before.typeId !== component.typeId;
  });
  if (typeChanged) {
    await queueCoreRebuild();
    if (state.simulationStatus === "running") {
      void pollInstrumentReadouts();
      void pollWireVoltages();
    }
    return;
  }

  for (const previousWire of previous.wires) {
    const nextWire = nextWiresById.get(previousWire.id);
    if (!nextWire || !sameWireEndpoints(previousWire, nextWire)) {
      pushRemoveWireToCore(previousWire);
    }
  }

  const removedComponentIds = previous.components
    .map((component) => component.id)
    .filter((id) => !nextComponentsById.has(id));
  for (const id of removedComponentIds) {
    pushRemoveToCore(id);
    coreInstanceIdByComponentId.delete(id);
    mcuTargetCoreIdByComponentId.delete(id);
  }

  const addedComponents = next.components.filter((component) => !previousComponentsById.has(component.id));
  for (const component of addedComponents) {
    await pushComponentToCore(component.id, component.typeId, component.properties, component.pins);
  }

  for (const component of next.components) {
    const before = previousComponentsById.get(component.id);
    if (!before || before.typeId !== component.typeId) continue;
    for (const name of changedPropertyNames(before.properties, component.properties)) {
      const value = component.properties[name];
      if (value === undefined) continue;
      if (name === "name" && component.typeId === TUNNEL_TYPE_ID) {
        const coreId = coreInstanceIdByComponentId.get(component.id);
        if (state.coreClient && coreId) {
          const pinId = component.pins[0]?.id ?? "pin";
          state.coreClient.setTunnelName(coreId, pinId, String(before.properties[name] ?? ""), String(value))
            .catch((err: unknown) => reportCoreWarning("renomear túnel", err));
        }
      } else {
        pushPropertyToCore(component.id, name, value);
      }
    }
  }

  const addedOrChangedWires = next.wires.filter((wire) => {
    const previousWire = previousWiresById.get(wire.id);
    return !previousWire || !sameWireEndpoints(previousWire, wire);
  });
  for (const wire of addedOrChangedWires) {
    await pushWireToCore(wire);
  }

  if (state.simulationStatus === "running" && (addedComponents.length > 0 || addedOrChangedWires.length > 0 || removedComponentIds.length > 0)) {
    void pollInstrumentReadouts();
    void pollWireVoltages();
  }
}

let projectSnapshotSyncQueue = Promise.resolve();

function enqueueProjectSnapshotSync(previous: WebviewProjectState, next: WebviewProjectState): void {
  projectSnapshotSyncQueue = projectSnapshotSyncQueue
    .catch(() => undefined)
    .then(() => syncProjectSnapshotToCore(previous, next))
    .catch((err: unknown) => reportCoreWarning("sincronizar alteracoes do esquematico", err));
  void projectSnapshotSyncQueue;
}

function handleWebviewMessage(message: WebviewToHostMessage): void {
  if (message.version !== 1) {
    return;
  }
  switch (message.type) {
    case "projectChanged": {
      // Vários fluxos client-side mutam `state` na Webview e mandam o snapshot inteiro aqui. O diff
      // precisa cobrir também propriedades/endpoints, porque undo/redo passa por este caminho.
      const previous = state.schematicState;
      state.schematicState = message.project;
      enqueueProjectSnapshotSync(previous, message.project);
      return;
    }
    case "requestAddComponent": {
      const descriptor = state.schematicState.catalog.find((item) => item.typeId === message.typeId);
      const componentId = nextId("component");
      const pins = pinsForTypeId(message.typeId);
      const baseLabel = descriptor?.label ?? message.typeId;
      const component: WebviewComponentModel = {
        id: componentId,
        typeId: message.typeId,
        label: nextIndexedLabel(message.typeId, baseLabel, state.schematicState.components),
        hidden: descriptor?.hidden ?? false,
        showValue: hasShowOnSymbolProperty(descriptor),
        x: 140 + state.schematicState.components.length * 24,
        y: 140 + state.schematicState.components.length * 24,
        rotation: 0,
        pins,
        properties: { ...(descriptor?.defaultProperties ?? {}) },
      };
      state.schematicState = {
        ...state.schematicState,
        components: [...state.schematicState.components, component],
        selectedComponentIds: [componentId],
        selectedWireIds: [],
      };
      void pushComponentToCore(componentId, component.typeId, component.properties, component.pins);
      syncSchematicPanel();
      return;
    }
    case "requestInsertItems": {
      const existingComponentIds = new Set(state.schematicState.components.map((component) => component.id));
      const existingWireIds = new Set(state.schematicState.wires.map((wire) => wire.id));
      const components = message.components.filter((component) => !existingComponentIds.has(component.id));
      const insertedComponentIds = new Set(components.map((component) => component.id));
      const wires = message.wires.filter((wire) =>
        !existingWireIds.has(wire.id) &&
        (existingComponentIds.has(wire.from.componentId) || insertedComponentIds.has(wire.from.componentId)) &&
        (existingComponentIds.has(wire.to.componentId) || insertedComponentIds.has(wire.to.componentId))
      );

      state.schematicState = {
        ...state.schematicState,
        components: [...state.schematicState.components, ...components],
        wires: [...state.schematicState.wires, ...wires],
        selectedComponentIds: components.map((component) => component.id),
        selectedWireIds: wires.map((wire) => wire.id),
      };
      void (async () => {
        for (const component of components) await pushComponentToCore(component.id, component.typeId, component.properties, component.pins);
        for (const wire of wires) await pushWireToCore(wire);
      })();
      syncSchematicPanel();
      return;
    }
    case "requestRemoveComponent": {
      closeMcuSerialMonitor(message.componentId);
      pushRemoveToCore(message.componentId);
      coreInstanceIdByComponentId.delete(message.componentId);
      mcuTargetCoreIdByComponentId.delete(message.componentId);
      const removedWireIds = new Set(
        state.schematicState.wires
          .filter((wire) => wire.from.componentId === message.componentId || wire.to.componentId === message.componentId)
          .map((wire) => wire.id)
      );
      state.schematicState = {
        ...state.schematicState,
        components: state.schematicState.components.filter((component) => component.id !== message.componentId),
        wires: state.schematicState.wires.filter((wire) => wire.from.componentId !== message.componentId && wire.to.componentId !== message.componentId),
        selectedComponentIds: state.schematicState.selectedComponentIds.filter((id) => id !== message.componentId),
        selectedWireIds: state.schematicState.selectedWireIds.filter((id) => !removedWireIds.has(id)),
        pendingConnection:
          state.schematicState.pendingConnection?.componentId === message.componentId ? undefined : state.schematicState.pendingConnection,
      };
      syncSchematicPanel();
      if (state.simulationStatus === "running") void pollWireVoltages();
      return;
    }
    case "requestRemoveWire": {
      const removedWire = state.schematicState.wires.find((wire) => wire.id === message.wireId);
      state.schematicState = {
        ...state.schematicState,
        wires: state.schematicState.wires.filter((wire) => wire.id !== message.wireId),
        selectedWireIds: state.schematicState.selectedWireIds.filter((id) => id !== message.wireId),
      };
      syncSchematicPanel();
      pushRemoveWireToCore(removedWire);
      if (state.simulationStatus === "running") {
        void pollInstrumentReadouts();
        void pollWireVoltages();
      }
      return;
    }
    case "requestConnectPins": {
      const wire = buildPinToPinWire({ id: nextId("wire"), from: message.from, to: message.to, points: message.points });
      state.schematicState = {
        ...state.schematicState,
        wires: [...state.schematicState.wires, wire],
        selectedComponentIds: [],
        selectedWireIds: [wire.id],
        pendingConnection: undefined,
      };
      void pushWireToCore(wire);
      syncSchematicPanel();
      if (state.simulationStatus === "running") void pollWireVoltages();
      return;
    }
    case "requestConnectPinToWire": {
      const existingWire = state.schematicState.wires.find((wire) => wire.id === message.wireId);
      if (!existingWire) return;
      const { junction, firstWire, secondWire, newWire } = buildPinToWireConnection({
        existingWire,
        junctionId: nextId("junction"),
        junctionPoint: message.point,
        from: message.from,
        newWireId: nextId("wire"),
        firstWireId: nextId("wire"),
        secondWireId: nextId("wire"),
        existingWireFirstPoints: message.existingWireFirstPoints,
        existingWireSecondPoints: message.existingWireSecondPoints,
        newWirePoints: message.points,
      });
      state.schematicState = {
        ...state.schematicState,
        components: [...state.schematicState.components, junction],
        wires: [
          ...state.schematicState.wires.filter((wire) => wire.id !== message.wireId),
          firstWire,
          secondWire,
          newWire,
        ],
        selectedComponentIds: [],
        selectedWireIds: [newWire.id],
        pendingConnection: undefined,
      };
      syncSchematicPanel();
      void queueCoreRebuild().then(() => {
        if (state.simulationStatus === "running") {
          void pollInstrumentReadouts();
          void pollWireVoltages();
        }
      });
      return;
    }
    case "requestRotateComponent": {
      state.schematicState = {
        ...state.schematicState,
        components: state.schematicState.components.map((component) =>
          component.id === message.componentId ? { ...component, rotation: message.rotation } : component
        ),
      };
      syncSchematicPanel();
      return;
    }
    case "requestFlipComponent": {
      state.schematicState = {
        ...state.schematicState,
        components: state.schematicState.components.map((component) =>
          component.id === message.componentId
            ? { ...component, flipH: message.flipH, flipV: message.flipV }
            : component
        ),
      };
      syncSchematicPanel();
      return;
    }
    case "requestRenameComponent": {
      state.schematicState = {
        ...state.schematicState,
        components: state.schematicState.components.map((component) =>
          component.id === message.componentId ? { ...component, label: message.label } : component
        ),
      };
      syncSchematicPanel();
      return;
    }
    case "requestUpdateLabelVisibility": {
      // Puramente visual -- nunca toca o Core (ver `.spec/lasecsimul.spec` seção 6.1.2: visibilidade
      // de rótulo não é uma propriedade elétrica, não tem schema de plugin/built-in nenhum).
      state.schematicState = {
        ...state.schematicState,
        components: state.schematicState.components.map((component) =>
          component.id === message.componentId
            ? { ...component, showId: message.showId, showValue: message.showValue }
            : component
        ),
      };
      syncSchematicPanel();
      return;
    }
    case "requestUpdateProperty": {
      const prevComponent = state.schematicState.components.find((c) => c.id === message.componentId);
      state.schematicState = {
        ...state.schematicState,
        components: state.schematicState.components.map((component) =>
          component.id === message.componentId
            ? { ...component, properties: { ...component.properties, [message.name]: message.value } }
            : component
        ),
      };
      // Túnel: nome precisa de setTunnelName (rebuilda topologia do Netlist), não setProperty.
      if (message.name === "name" && prevComponent?.typeId === TUNNEL_TYPE_ID) {
        const coreId = coreInstanceIdByComponentId.get(message.componentId);
        if (state.coreClient && coreId) {
          const pinId = prevComponent.pins[0]?.id ?? "pin";
          const oldName = String(prevComponent.properties["name"] ?? "");
          state.coreClient.setTunnelName(coreId, pinId, oldName, String(message.value))
            .catch((err: unknown) => reportCoreWarning("renomear túnel", err));
        }
      } else {
        pushPropertyToCore(message.componentId, message.name, message.value);
      }
      syncSchematicPanel();
      if (state.simulationStatus === "running") {
        void pollInstrumentReadouts();
        void pollWireVoltages();
      }
      return;
    }
    case "requestChooseSubcircuitFile":
      void chooseSubcircuitFileCommand(message.componentId);
      return;
    case "requestOpenExternal":
      void vscode.env.openExternal(vscode.Uri.parse(message.url));
      return;
    case "requestRunSimulation":
      runSimulation();
      return;
    case "requestPauseSimulation":
      pauseSimulation();
      return;
    case "requestStopSimulation":
      stopSimulation();
      return;
    case "requestSaveProject":
      void saveProjectCommand();
      return;
    case "requestOpenProject":
      if (state.extensionContext) void openProjectCommand(state.extensionContext);
      return;
    case "requestSaveSymbol":
      void saveSymbolCommand(message.filePath, message.typeId, message.kind, message.view, message.components, message.wires);
      return;
    case "requestEditSymbol":
      void editPackageSymbolCommand({ sourceId: message.sourceId });
      return;
    case "requestChooseMcuFirmware":
      void chooseMcuFirmwareCommand(message.componentId);
      return;
    case "requestChooseExposedMcuFirmware":
      void chooseExposedMcuFirmwareCommand(message.outerComponentId, message.innerComponentId);
      return;
    case "requestReloadMcuFirmware":
      void reloadMcuFirmwareCommand(message.componentId);
      return;
    case "requestReloadExposedMcuFirmware":
      void reloadExposedMcuFirmwareCommand(message.outerComponentId, message.innerComponentId);
      return;
    case "requestOpenMcuSerialMonitor":
      openMcuSerialMonitorCommand(message.componentId, message.usartIndex);
      return;
    case "requestOpenExposedMcuSerialMonitor":
      void openExposedMcuSerialMonitorCommand(message.outerComponentId, message.innerComponentId, message.usartIndex);
      return;
    case "requestSwitchSymbolView":
      void switchSymbolViewCommand(message.filePath, message.typeId, message.kind, message.toView, message.internalComponents, message.internalWires);
      return;
    case "requestExportInstrumentData":
      void exportInstrumentDataCommand(message.suggestedFileName, message.csvContent);
      return;
    case "requestInstrumentHistory":
      void sendInstrumentHistory(message.componentId);
      return;
    case "requestLoadPackage":
      void loadPackageCommand(message.sourceId);
      return;
    case "requestSavePackage":
      void savePackageCommand(message.sourceId);
      return;
    case "requestUpdateBoardOverlayProperty":
      updateBoardOverlayPropertyCommand(message.outerComponentId, message.innerComponentId, message.name, message.value);
      return;
    case "requestBoardOverlayData":
      void requestBoardOverlayDataCommand(message.componentId, message.sourceId);
      return;
    case "requestUpdateBoardOverlayVisual":
      void updateBoardOverlayVisualCommand(message.sourceId, message.innerComponentId, message.x, message.y);
      return;
    case "requestUpdateExposedComponentProperty":
      void updateExposedComponentPropertyCommand(message.outerComponentId, message.sourceId, message.innerComponentId, message.name, message.value);
      return;
    case "requestCreateSubcircuitFromSelection":
      void createSubcircuitFromSelectionHandler(message.componentIds);
      return;
  }
}

/** Disparado por `lasecsimul.newSubcircuit` (comando VSCode) -- envia `triggerCreateSubcircuitFromSelection`
 * à Webview, que verifica a seleção atual e devolve `requestCreateSubcircuitFromSelection` com os IDs.
 * Se o painel não estiver aberto ou não houver multi-seleção, não faz nada (a Webview trata isso). */
function triggerCreateSubcircuitFromSelection(panel: { postMessage: (msg: unknown) => void } | undefined): void {
  if (!panel) {
    vscode.window.showWarningMessage("Abra o editor de esquemático antes de criar um subcircuito.");
    return;
  }
  panel.postMessage({ version: 1, type: "triggerCreateSubcircuitFromSelection" });
}

/** Cria um `.lssubcircuit` a partir dos componentes selecionados no esquemático:
 * 1. Salva o arquivo escolhido pelo usuário.
 * 2. Registra o novo subcircuito na paleta.
 * 3. Substitui os componentes selecionados por uma instância do novo subcircuito no esquemático,
 *    reconectando os fios que cruzavam a fronteira via os pinos gerados automaticamente. */
async function createSubcircuitFromSelectionHandler(componentIds: string[]): Promise<void> {
  if (!state.extensionContext || componentIds.length < 1) return;

  const selectedSet = new Set(componentIds);
  const selectedComponents = state.schematicState.components.filter((c) => selectedSet.has(c.id));
  if (selectedComponents.length === 0) return;

  // 1. Salvar arquivo
  const saveUri = await vscode.window.showSaveDialog({
    filters: { "Subcircuito LasecSimul": ["lssubcircuit"] },
    title: "Salvar novo subcircuito",
  });
  if (!saveUri) return;
  const rawPath = saveUri.fsPath;
  const normalizedPath = rawPath.endsWith(".lssubcircuit")
    ? rawPath
    : rawPath.replace(/\.[^./\\]+$/, "") + ".lssubcircuit";

  // 2. Gerar typeId a partir do nome do arquivo
  const baseName = path.basename(normalizedPath, ".lssubcircuit");
  const safeSlug = baseName.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
  const typeId = `subcircuits.${safeSlug}`;

  // 3. Categorizar fios
  const allWires = state.schematicState.wires;
  const internalWires: WebviewWireModel[] = [];
  const boundaryWires: WebviewWireModel[] = [];
  for (const wire of allWires) {
    const fromIn = selectedSet.has(wire.from.componentId);
    const toIn = selectedSet.has(wire.to.componentId);
    if (fromIn && toIn) internalWires.push(wire);
    else if (fromIn || toIn) boundaryWires.push(wire);
  }

  // 4. Bounding box dos componentes selecionados
  let minX = Infinity, minY = Infinity;
  for (const c of selectedComponents) {
    if (c.x < minX) minX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.x > 0 || c.y > 0) { /* just need bounds */ }
  }
  let maxX = -Infinity;
  for (const c of selectedComponents) {
    if (c.x > maxX) maxX = c.x;
  }

  // 5. Gerar um túnel interno por fio de fronteira
  interface TunnelEntry {
    id: string;
    name: string;
    x: number;
    y: number;
    internalComponentId: string;
    internalPinId: string;
    isFromInside: boolean;
    wireId: string;
  }
  const tunnels: TunnelEntry[] = boundaryWires.map((wire, i) => {
    const pinName = `P${i + 1}`;
    const fromIn = selectedSet.has(wire.from.componentId);
    return {
      id: `tunnel_${pinName.toLowerCase()}`,
      name: pinName,
      x: minX - 64,
      y: minY + i * 16,
      internalComponentId: fromIn ? wire.from.componentId : wire.to.componentId,
      internalPinId: fromIn ? wire.from.pinId : wire.to.pinId,
      isFromInside: fromIn,
      wireId: wire.id,
    };
  });

  // 6. Montar o .lssubcircuit
  const internalCompObjects = selectedComponents.map((c) => ({
    id: c.id,
    typeId: c.typeId,
    properties: { ...c.properties },
    visual: { x: c.x, y: c.y, rotation: c.rotation },
    exposed: false,
  }));
  const tunnelCompObjects = tunnels.map((t) => ({
    id: t.id,
    typeId: TUNNEL_TYPE_ID,
    properties: { name: t.name },
    visual: { x: t.x, y: t.y, rotation: 0 },
    exposed: false,
  }));
  const internalWireObjects = internalWires.map((w) => ({
    from: { componentId: w.from.componentId, pinId: w.from.pinId },
    to: { componentId: w.to.componentId, pinId: w.to.pinId },
    ...(w.points ? { points: w.points } : {}),
  }));
  const stubWireObjects = tunnels.map((t) => ({
    from: { componentId: t.id, pinId: "pin" },
    to: { componentId: t.internalComponentId, pinId: t.internalPinId },
  }));
  const interfaceEntries = tunnels.map((t) => ({
    pinId: t.name,
    label: t.name,
    internalTunnel: t.name,
  }));

  const lssubJson = {
    schemaVersion: 1,
    typeId,
    name: baseName,
    language: "pt-BR",
    components: [...internalCompObjects, ...tunnelCompObjects],
    wires: [...internalWireObjects, ...stubWireObjects],
    interface: interfaceEntries,
  };

  // 7. Gravar arquivo
  try {
    fs.writeFileSync(normalizedPath, `${JSON.stringify(lssubJson, null, 2)}\n`, "utf8");
  } catch (err) {
    vscode.window.showErrorMessage(`Não foi possível salvar o subcircuito: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (state.coreClient) {
    try {
      await state.coreClient.registerAdhocSubcircuit(normalizedPath);
    } catch (err) {
      vscode.window.showErrorMessage(`Não foi possível registrar o subcircuito no Core: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
  }

  // 8. Registrar na paleta
  const unifiedCatalog = loadUnifiedCatalog(state.extensionContext.extensionPath, currentLasecSimulLanguage());
  const newSource: RegisteredSource = {
    id: nextId("registered"),
    kind: "subcircuit-file",
    filePath: normalizedPath,
    folderPath: ["Meus Subcircuitos"],
  };
  saveRegisteredSources(state.extensionContext.extensionPath, [...unifiedCatalog.registeredSources, newSource]);
  await refreshUnifiedCatalogState(false);

  // 9. Inserir instância do subcircuito no esquemático, no centro da bounding box
  const newCompId = nextId("component");
  const centerX = Math.round((minX + maxX) / 2);
  const centerY = Math.round((minY + (minY + (selectedComponents.length - 1) * 16)) / 2);
  const newPins = pinsForTypeId(typeId);
  const catalogEntry = state.schematicState.catalog.find((e) => e.typeId === typeId);
  const newComponent: WebviewComponentModel = {
    id: newCompId,
    typeId,
    label: nextIndexedLabel(typeId, catalogEntry?.label ?? baseName, state.schematicState.components),
    x: centerX,
    y: centerY,
    rotation: 0,
    pins: newPins,
    properties: { ...(catalogEntry?.defaultProperties ?? {}) },
  };

  // 10. Reconectar fios de fronteira ao novo subcircuito
  const newBoundaryWires: WebviewWireModel[] = tunnels.map((t) => {
    const original = boundaryWires.find((w) => w.id === t.wireId)!;
    const externalEndpoint = t.isFromInside
      ? { componentId: original.to.componentId, pinId: original.to.pinId }
      : { componentId: original.from.componentId, pinId: original.from.pinId };
    return {
      id: nextId("wire"),
      from: { componentId: newCompId, pinId: t.name },
      to: externalEndpoint,
    };
  });

  // 11. Remover componentes e fios selecionados do esquemático
  const removedWireIds = new Set(
    allWires.filter((w) => selectedSet.has(w.from.componentId) || selectedSet.has(w.to.componentId)).map((w) => w.id)
  );
  state.schematicState = {
    ...state.schematicState,
    components: [...state.schematicState.components.filter((c) => !selectedSet.has(c.id)), newComponent],
    wires: [...state.schematicState.wires.filter((w) => !removedWireIds.has(w.id)), ...newBoundaryWires],
    selectedComponentIds: [newCompId],
    selectedWireIds: [],
  };

  // 12. Atualizar Core
  for (const id of componentIds) {
    pushRemoveToCore(id);
    coreInstanceIdByComponentId.delete(id);
  }
  await pushComponentToCore(newCompId, typeId, newComponent.properties, newPins);
  for (const wire of newBoundaryWires) await pushWireToCore(wire);

  syncSchematicPanel();
  void queueCoreRebuild();
  vscode.window.showInformationMessage(`Subcircuito '${baseName}' criado e registrado na paleta em 'Meus Subcircuitos'.`);
}

/** "Exportar Dados" da janela "Expande" (osciloscópio/analisador lógico) -- o CSV já vem formatado
 * da Webview (main.ts, que tem o histórico/configuração de canais); aqui só o diálogo de salvar +
 * escrita do arquivo, igual a `saveProjectCommand`. */
async function exportInstrumentDataCommand(suggestedFileName: string, csvContent: string): Promise<void> {
  const uri = await vscode.window.showSaveDialog({
    filters: { "CSV": ["csv"] },
    defaultUri: vscode.Uri.file(suggestedFileName),
  });
  if (!uri) return;
  try {
    fs.writeFileSync(uri.fsPath, csvContent, "utf8");
  } catch (err) {
    vscode.window.showErrorMessage(`Não foi possível exportar os dados: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function absoluteSubcircuitRefPath(refPath: string): string {
  if (path.isAbsolute(refPath)) return path.normalize(refPath);
  const baseDir = state.currentProjectFilePath ? path.dirname(state.currentProjectFilePath) : process.cwd();
  return path.resolve(baseDir, refPath);
}

function projectWithRelativeSubcircuitRefs(project: ProjectDocument, targetProjectPath: string): ProjectDocument {
  const targetDir = path.dirname(targetProjectPath);
  return {
    ...project,
    components: project.components.map((component) => {
      if (!component.subcircuitRef?.path) return component;
      const absolutePath = absoluteSubcircuitRefPath(component.subcircuitRef.path);
      const relativePath = path.relative(targetDir, absolutePath);
      const portablePath = relativePath && !path.isAbsolute(relativePath) ? relativePath : absolutePath;
      return {
        ...component,
        subcircuitRef: {
          ...component.subcircuitRef,
          path: portablePath,
        },
      };
    }),
  };
}

async function saveProjectCommand(): Promise<void> {
  const uri = await vscode.window.showSaveDialog({ filters: { "LasecSimul Project": ["lsproj"] } });
  if (!uri) return;
  const project: ProjectDocument = projectWithRelativeSubcircuitRefs({
    ...createEmptyProject(),
    components: state.schematicState.components.map(webviewComponentToProjectComponent),
    wires: state.schematicState.wires.map((wire) => ({ id: wire.id, from: wire.from, to: wire.to })),
    visual: {
      wires: state.schematicState.wires
        .filter((wire) => wire.points && wire.points.length > 0)
        .map((wire) => ({ id: wire.id, points: wire.points })),
      viewport: state.schematicState.viewport,
    },
  }, uri.fsPath);
  await projectSerializer.save(uri.fsPath, project);
  state.currentProjectFilePath = uri.fsPath;
  vscode.window.showInformationMessage(`Projeto LasecSimul salvo em ${uri.fsPath}`);
}

async function openProjectCommand(context: vscode.ExtensionContext): Promise<void> {
  const uris = await vscode.window.showOpenDialog({
    filters: { "LasecSimul Project": ["lsproj"] },
    canSelectMany: false,
  });
  const selected = uris?.[0];
  if (!selected) return;
  closeAllMcuSerialMonitors();
  const project = await projectSerializer.load(selected.fsPath);
  state.currentProjectFilePath = selected.fsPath;
  state.schematicState = projectToWebviewState(project);
  await resolveProjectSubcircuitReferences(path.dirname(selected.fsPath));
  if (!state.schematicPanel) openSchematicEditor(context.extensionUri);
  syncSchematicPanel();
  await rebuildCoreFromSchematicState();
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
  // Devices sem basename fixo (ex: "ssd1306.lsdevice") caem no sniff estrutural
  // (`hasChipId`/`hasNativeEntry`), extension-agnostic.
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

async function refreshUnifiedCatalogState(loadLibrariesInCore: boolean): Promise<void> {
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
    ? await loadConfiguredDeviceLibraries(state.extensionContext.extensionPath, [...requests.values()])
    : new Map<string, string>();
  const adhocFailures = new Map<string, string>();
  if (loadLibrariesInCore && state.coreClient) {
    for (const absolutePath of adhocSubcircuits) {
      try {
        await state.coreClient.registerAdhocSubcircuit(absolutePath);
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
    if (baseTypeIds.has(item.entry.typeId)) {
      // Catálogo base vence: evita duplicata "registrada" com lápis/ícone externo quando o mesmo
      // typeId já existe como item nativo da paleta (caso do voltímetro).
      return [];
    }
    return [item.entry];
  });

  const mergedCatalog = [...unifiedCatalog.catalog, ...registeredEntries];
  setEffectiveCatalog(loadLibrariesInCore ? await attachPropertySchemas(mergedCatalog) : mergedCatalog);
}

/** Anexa o schema rico de propriedades (grupo/editor/min/max/opções/flags) de cada typeId, vindo do
 * Core via `getPropertySchemas` — só tentado quando `loadLibrariesInCore` (ou seja, quando o
 * `state.coreClient` já deveria estar conectado); best-effort: se falhar (Core ainda não respondeu, por
 * exemplo), o catálogo segue sem schema e o diálogo de propriedades cai pra inferência (ver
 * `resolvePropertyFields` na Webview). Schema é por typeId (catálogo), nunca por instância. */
async function attachPropertySchemas(
  catalog: WebviewComponentCatalogEntry[]
): Promise<WebviewComponentCatalogEntry[]> {
  if (!state.coreClient) return catalog;
  let resolved: Awaited<ReturnType<typeof state.coreClient.getPropertySchemas>>;
  try {
    resolved = await state.coreClient.getPropertySchemas(currentLasecSimulLanguage());
  } catch {
    return catalog; // Core ainda não respondeu -- catálogo sem schema, inferência cobre o resto
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

async function registerCatalogFileCommand(): Promise<void> {
  if (!state.extensionContext) return;
  const ctx = state.extensionContext;
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    // `lsdevice`/`lssubcircuit` são as extensões oficiais de manifesto; `json` continua na lista
    // porque `library.json` (índice, nunca renomeado) também é selecionável aqui.
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
  await refreshUnifiedCatalogState(true);
  vscode.window.showInformationMessage(`Registro concluído (${deduped.length} item(ns)). Catálogo salvo em ${savedAt}.`);
}

async function removeRegisteredCatalogItemCommand(item?: { sourceId?: string }): Promise<void> {
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
  await refreshUnifiedCatalogState(true);
  vscode.window.showInformationMessage("Item removido da paleta de componentes.");
}

/** PC-16 (.spec/lasecsimul-native-devices.spec): filtra elementos `null`/não-objeto de um array vindo
 * de JSON externo -- `Array.isArray` sozinho não garante que CADA elemento seja utilizável; um
 * `.lsdevice`/`.lssubcircuit` malformado com `"pins":[null]` ou `"shapes":[null]` passava batido
 * (só o container era checado) e derrubava `symbolAuthoring.ts` com `TypeError` não tratado ao abrir
 * "Editar Símbolo Visual"/"Abrir Subcircuito" -- mesmo padrão defensivo que `knownPinIdsForManifest`
 * já usa pros formatos carregados no boot do catálogo, agora também na leitura pra EDIÇÃO. */
function sanitizeJsonObjectArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null);
}

function extractPackageForEditing(json: Record<string, unknown>, key: "package" | "logicSymbolPackage" = "package", assetBasePath?: string): PackageDescriptor {
  const raw = json[key];
  if (typeof raw === "object" && raw !== null) {
    const candidate = raw as Record<string, unknown>;
    if (typeof candidate.width === "number" && typeof candidate.height === "number") {
      const viewSpecCandidate = typeof candidate.viewSpec === "object" && candidate.viewSpec !== null
        ? (candidate.viewSpec as Record<string, unknown>)
        : undefined;
      return {
        width: candidate.width,
        height: candidate.height,
        schematicWidth: typeof candidate.schematicWidth === "number" ? candidate.schematicWidth : undefined,
        schematicHeight: typeof candidate.schematicHeight === "number" ? candidate.schematicHeight : undefined,
        border: typeof candidate.border === "boolean" ? candidate.border : undefined,
        background: sanitizePackageBackground(candidate.background, assetBasePath),
        initialTransform: typeof candidate.initialTransform === "object" && candidate.initialTransform !== null
          ? (candidate.initialTransform as PackageDescriptor["initialTransform"])
          : undefined,
        pinMarker: candidate.pinMarker === "packagePin" ? "packagePin" : undefined,
        shapes: sanitizeJsonObjectArray(candidate.shapes) as unknown as PackageShape[],
        simulidePaint: typeof candidate.simulidePaint === "object" && candidate.simulidePaint !== null
          ? (candidate.simulidePaint as PackageDescriptor["simulidePaint"])
          : undefined,
        qtWidget: typeof candidate.qtWidget === "object" && candidate.qtWidget !== null
          ? (candidate.qtWidget as PackageDescriptor["qtWidget"])
          : undefined,
        // `viewSpec.paint` é um array consumido do mesmo jeito que `shapes[]` (ver
        // `symbolAuthoring.ts::seedSymbolAuthoringComponents`) -- precisa da MESMA sanitização, não
        // só "viewSpec é um objeto". `paint` ausente/errado vira `[]` explícito aqui (nunca deixado
        // como estava) porque `pkg.viewSpec?.paint ?? []` no chamador só substitui null/undefined,
        // não uma string/objeto por engano no lugar do array.
        viewSpec: viewSpecCandidate
          ? ({ ...viewSpecCandidate, paint: sanitizeJsonObjectArray(viewSpecCandidate.paint) } as unknown as PackageDescriptor["viewSpec"])
          : undefined,
        valueLabel: typeof candidate.valueLabel === "object" && candidate.valueLabel !== null
          ? (candidate.valueLabel as PackageDescriptor["valueLabel"])
          : undefined,
        pins: sanitizeJsonObjectArray(candidate.pins) as unknown as PackagePin[],
        pinLabelColor: typeof candidate.pinLabelColor === "string" ? candidate.pinLabelColor : undefined,
      };
    }
  }
  return { width: 80, height: 60, border: true, shapes: [], pins: [] };
}

function extractSubcircuitInterfaceMap(json: Record<string, unknown>): Map<string, { label?: string; internalTunnel?: string }> {
  const entries = Array.isArray(json.interface) ? json.interface : [];
  const result = new Map<string, { label?: string; internalTunnel?: string }>();
  for (const value of entries) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Record<string, unknown>;
    const pinId = typeof entry.pinId === "string" ? entry.pinId.trim() : "";
    if (!pinId) continue;
    result.set(pinId, {
      label: typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : undefined,
      internalTunnel: typeof entry.internalTunnel === "string" && entry.internalTunnel.trim() ? entry.internalTunnel.trim() : undefined,
    });
  }
  return result;
}

function extractInternalTunnelNames(json: Record<string, unknown>): Set<string> {
  const rawComponents = Array.isArray(json.components) ? json.components : [];
  return new Set(
    rawComponents
      .filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
      .filter((component) => component.typeId === TUNNEL_TYPE_ID)
      .map((component) => component.properties as Record<string, unknown> | undefined)
      .map((properties) => typeof properties?.name === "string" ? properties.name.trim() : "")
      .filter((name) => name.length > 0)
  );
}

function inferInternalTunnelForPin(pinId: string, tunnelNames: Set<string>, label?: string): string | undefined {
  if (tunnelNames.has(pinId)) return pinId;
  if (/^GND\d+$/i.test(pinId) && tunnelNames.has("GND")) return "GND";
  const normalizedLabel = typeof label === "string" ? label.trim().toUpperCase() : "";
  if (normalizedLabel && tunnelNames.has(normalizedLabel)) return normalizedLabel;
  return undefined;
}

function applySubcircuitInterfaceToPackageComponents(json: Record<string, unknown>, packageComponents: WebviewComponentModel[]): WebviewComponentModel[] {
  const interfaceByPinId = extractSubcircuitInterfaceMap(json);
  const tunnelNames = extractInternalTunnelNames(json);
  return packageComponents.map((component) => {
    if (component.typeId !== "other.package_pin") return component;
    const pinId = typeof component.properties.pinId === "string" ? component.properties.pinId.trim() : "";
    if (!pinId) return component;
    const current = interfaceByPinId.get(pinId);
    const inferredTunnel = current?.internalTunnel ?? inferInternalTunnelForPin(pinId, tunnelNames, current?.label);
    if (!inferredTunnel) return component;
    return {
      ...component,
      properties: {
        ...component.properties,
        internalTunnel: inferredTunnel,
      },
    };
  });
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

/** Lê `components[]`/`wires[]` REAIS de um `.lssubcircuit` (`visual`/`boardVisual`/`points` são campos
 * novos, aditivos -- `core/src/registry/SubcircuitRegistry.hpp::SubcircuitComponentDef`/
 * `SubcircuitWireDef` só leem campos nomeados, ignoram o resto, então isto nunca quebra o Core, ver
 * `.spec/lasecsimul-subcircuits.spec`). Só usado pra "Abrir Subcircuito" (kind === "subcircuit-file"
 * -- `.lsdevice` não tem circuito interno, "Package ≠ Subcircuit"). */
function extractInternalCircuit(json: Record<string, unknown>): { components: InternalComponentSeed[]; wires: InternalWireSeed[] } {
  const componentsRaw = Array.isArray(json.components) ? json.components : [];
  const components: InternalComponentSeed[] = componentsRaw
    .filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
    .map((value) => ({
      id: typeof value.id === "string" ? value.id : "",
      typeId: typeof value.typeId === "string" ? value.typeId : "",
      properties: typeof value.properties === "object" && value.properties !== null ? (value.properties as Record<string, unknown>) : {},
      visual: sanitizeVisualPosition(value.visual),
      boardVisual: sanitizeVisualPosition(value.boardVisual),
      exposed: value.exposed === true,
      label: typeof value.label === "string" && value.label.trim() ? value.label : undefined,
      showId: typeof value.showId === "boolean" ? value.showId : undefined,
      showValue: typeof value.showValue === "boolean" ? value.showValue : undefined,
    }))
    .filter((component) => component.id && component.typeId);

  const wiresRaw = Array.isArray(json.wires) ? json.wires : [];
  const wires: InternalWireSeed[] = wiresRaw
    .filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
    .map((value) => {
      const from = value.from as Record<string, unknown> | undefined;
      const to = value.to as Record<string, unknown> | undefined;
      const points = Array.isArray(value.points)
        ? (value.points as unknown[])
            .filter((point): point is Record<string, unknown> => typeof point === "object" && point !== null && typeof (point as Record<string, unknown>).x === "number" && typeof (point as Record<string, unknown>).y === "number")
            .map((point) => ({ x: point.x as number, y: point.y as number }))
        : undefined;
      return {
        from: { componentId: typeof from?.componentId === "string" ? from.componentId : "", pinId: typeof from?.pinId === "string" ? from.pinId : "" },
        to: { componentId: typeof to?.componentId === "string" ? to.componentId : "", pinId: typeof to?.pinId === "string" ? to.pinId : "" },
        points,
      };
    })
    .filter((wire) => wire.from.componentId && wire.to.componentId);

  return { components, wires };
}

/** Resolve um `sourceId` (`RegisteredSource.id`, igual ao usado por `editPackageSymbolCommand`) pro
 * caminho absoluto do manifesto -- compartilhado pelos comandos de "Carregar/Salvar pacote" e
 * "Selecione os Componentes expostos", que precisam todos do mesmo manifesto (`.lssubcircuit`/
 * `.lsdevice`) do item clicado. */
function resolveSourceFilePath(ctx: vscode.ExtensionContext, sourceId: string): string | undefined {
  const unifiedCatalog = loadUnifiedCatalog(ctx.extensionPath, currentLasecSimulLanguage());
  const source = unifiedCatalog.registeredSources.find((value) => value.id === sourceId);
  if (!source) {
    vscode.window.showWarningMessage("Item registrado não encontrado no catálogo.");
    return undefined;
  }
  return normalizeAbsolutePath(ctx.extensionPath, source.filePath);
}

/** "Carregar pacote" -- mesmo destino de "Abrir Subcircuito"/"Editar Símbolo" (reaproveita
 * `editPackageSymbolCommand` tal qual), só com rótulo de menu diferente (ver `subpackage.cpp::
 * loadPackage()` real, que também abre a edição do package ao "carregar"). */
async function loadPackageCommand(sourceId: string): Promise<void> {
  await editPackageSymbolCommand({ sourceId });
}

/** "Salvar pacote" -- exporta só a chave `package` do manifesto pra um arquivo separado escolhido
 * pelo usuário (mesmo papel de `SubPackage::slotSave()` real, formato simplificado pra JSON puro
 * em vez do `.package` binário do SimulIDE). */
async function savePackageCommand(sourceId: string): Promise<void> {
  if (!state.extensionContext) return;
  const ctx = state.extensionContext;
  const absoluteFilePath = resolveSourceFilePath(ctx, sourceId);
  if (!absoluteFilePath || !fileExists(absoluteFilePath)) return;

  let json: Record<string, unknown>;
  try {
    json = readJsonFile(absoluteFilePath) as Record<string, unknown>;
  } catch (err) {
    vscode.window.showErrorMessage(`Não foi possível ler ${absoluteFilePath}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const pkg = json.package;
  if (typeof pkg !== "object" || pkg === null) {
    vscode.window.showWarningMessage("Este item não tem um \"package\" pra salvar.");
    return;
  }

  const defaultName = `${path.basename(absoluteFilePath).replace(/\.json$/i, "")}.pkg.json`;
  const target = await vscode.window.showSaveDialog({
    filters: { JSON: ["json"] },
    defaultUri: vscode.Uri.file(path.join(path.dirname(absoluteFilePath), defaultName)),
    title: "Salvar pacote",
  });
  if (!target) return;

  try {
    fs.writeFileSync(target.fsPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
    vscode.window.showInformationMessage(`Pacote salvo em ${target.fsPath}.`);
  } catch (err) {
    vscode.window.showErrorMessage(`Não foi possível salvar ${target.fsPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Lê o circuito interno do `.lssubcircuit` (`sourceId`) e monta a lista de componentes candidatos a
 * "expostos" -- alimenta o overlay de Modo Placa E o submenu por componente exposto do menu de
 * contexto (`main.ts::buildExposedComponentMenuItems`). "Exposto" é marcado/desmarcado DENTRO da
 * sessão "Abrir Subcircuito" (não daqui de fora) e persistido via "Salvar Subcircuito" -- esta
 * função só LÊ o que já foi salvo. Filtra `connectors.tunnel`/`connectors.junction` -- são fiação
 * interna, não "componentes" expostos úteis (mesmo critério de `m_graphical` do SimulIDE: só itens
 * com presença visual/funcional fazem sentido aqui). */
function gatherInternalComponentSnapshots(sourceId: string): InternalComponentSnapshot[] | undefined {
  if (!state.extensionContext) return undefined;
  const absoluteFilePath = resolveSourceFilePath(state.extensionContext, sourceId);
  if (!absoluteFilePath || !fileExists(absoluteFilePath)) return undefined;

  let json: Record<string, unknown>;
  try {
    json = readJsonFile(absoluteFilePath) as Record<string, unknown>;
  } catch (err) {
    vscode.window.showErrorMessage(`Não foi possível ler ${absoluteFilePath}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }

  const internal = extractInternalCircuit(json);
  return internal.components
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
          ? { x: component.boardVisual.x, y: component.boardVisual.y, rotation: component.boardVisual.rotation ?? 0, flipH: component.boardVisual.flipH, flipV: component.boardVisual.flipV }
          : undefined,
        properties: component.properties as Record<string, string | number | boolean>,
      };
    });
}

/** Dados pro overlay de Modo Placa no circuito principal E pro submenu por componente exposto do
 * menu de contexto -- pedido pela Webview ao renderizar qualquer instância de subcircuito (ver
 * `main.ts::ensureBoardOverlayData`) ou quando o catálogo muda. */
async function requestBoardOverlayDataCommand(componentId: string, sourceId: string): Promise<void> {
  if (!state.schematicPanel) return;
  const items = gatherInternalComponentSnapshots(sourceId);
  if (!items) return;
  state.schematicPanel.postMessage({ version: 1, type: "boardOverlayData", componentId, items });
}

/** Atualiza uma propriedade REAL de um componente interno exposto a partir do submenu externo do
 * subcircuito. Persiste no `.lssubcircuit` e, se a instância já estiver expandida no Core, tenta
 * aplicar em runtime também (mesmo mecanismo de `setSubcircuitChildProperty` usado pelo overlay de
 * Modo Placa). */
async function updateExposedComponentPropertyCommand(
  outerComponentId: string,
  sourceId: string | undefined,
  innerComponentId: string,
  name: string,
  value: string | number | boolean,
): Promise<void> {
  if (!state.extensionContext || !sourceId) return;
  const absoluteFilePath = resolveSourceFilePath(state.extensionContext, sourceId);
  if (!absoluteFilePath || !fileExists(absoluteFilePath)) return;

  let json: Record<string, unknown>;
  try {
    json = readJsonFile(absoluteFilePath) as Record<string, unknown>;
  } catch (err) {
    vscode.window.showErrorMessage(`Não foi possível ler ${absoluteFilePath}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  if (Array.isArray(json.components)) {
    json.components = json.components.map((entry) => {
      if (typeof entry !== "object" || entry === null) return entry;
      const component = entry as Record<string, unknown>;
      if (component.id !== innerComponentId) return component;
      const properties = typeof component.properties === "object" && component.properties !== null
        ? (component.properties as Record<string, unknown>)
        : {};
      return { ...component, properties: { ...properties, [name]: value } };
    });
  }

  try {
    fs.writeFileSync(absoluteFilePath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  } catch (err) {
    vscode.window.showErrorMessage(`Não foi possível salvar ${absoluteFilePath}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  updateBoardOverlayPropertyCommand(outerComponentId, innerComponentId, name, value);
  await requestBoardOverlayDataCommand(outerComponentId, sourceId);
}

/** Arrastar um componente do overlay de Modo Placa direto no circuito principal -- grava
 * `boardVisual` em `components[]` do `.lssubcircuit` (`sourceId`), preservando `rotation`/`flipH`/
 * `flipV` já existentes (só `x`/`y` mudam; girar continua sendo coisa de "Abrir Subcircuito" por
 * enquanto). Edição cirúrgica, mesmo padrão de `updateExposedComponentsCommand`. */
async function updateBoardOverlayVisualCommand(sourceId: string, innerComponentId: string, x: number, y: number): Promise<void> {
  if (!state.extensionContext) return;
  const ctx = state.extensionContext;
  const absoluteFilePath = resolveSourceFilePath(ctx, sourceId);
  if (!absoluteFilePath || !fileExists(absoluteFilePath)) return;

  let json: Record<string, unknown>;
  try {
    json = readJsonFile(absoluteFilePath) as Record<string, unknown>;
  } catch (err) {
    vscode.window.showErrorMessage(`Não foi possível ler ${absoluteFilePath}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  if (Array.isArray(json.components)) {
    json.components = json.components.map((value) => {
      if (typeof value !== "object" || value === null) return value;
      const component = value as Record<string, unknown>;
      if (component.id !== innerComponentId) return component;
      const previousBoardVisual = typeof component.boardVisual === "object" && component.boardVisual !== null
        ? (component.boardVisual as Record<string, unknown>)
        : undefined;
      return {
        ...component,
        boardVisual: { x, y, rotation: previousBoardVisual?.rotation ?? 0, flipH: previousBoardVisual?.flipH, flipV: previousBoardVisual?.flipV },
      };
    });
  }

  try {
    fs.writeFileSync(absoluteFilePath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  } catch (err) {
    vscode.window.showErrorMessage(`Não foi possível salvar ${absoluteFilePath}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  await refreshUnifiedCatalogState(true);
}

function detectManifestKind(absoluteFilePath: string, json: Record<string, unknown>): RegisteredItemKind {
  const fileName = path.basename(absoluteFilePath).toLowerCase();
  if (fileName.endsWith(".lssubcircuit")) return "subcircuit-file";
  const hasChipId = typeof json.chipId === "string" && json.chipId.trim().length > 0;
  if (fileName === "mcu.lsdevice" || hasChipId) return "mcu-adapter";
  return "abi-device";
}

/** Comando "Editar Símbolo Visual"/"Abrir Subcircuito" (Épico G, parte de escrita) -- com
 * `item.sourceId`, edita o item JÁ registrado na paleta (botão "✎" em `palette.ts`, ou botão direito
 * numa instância já no circuito, `requestEditSymbol`); sem `sourceId` (botão da barra de título,
 * `lasecsimul.palette.editSymbol` sem argumento), abre um seletor de arquivo pra editar QUALQUER
 * `.lsdevice`/`.lssubcircuit`, registrado ou não. Em todos os casos abre o MESMO webview
 * do esquemático (`openSchematicEditor`), só que numa sessão de autoria -- nunca um painel novo
 * (ver `.spec/lasecsimul-native-devices.spec` seção 21.3, `.spec/lasecsimul-subcircuits.spec`
 * seção 4). `view` escolhe qual aparência abrir ("logicSymbol" só existe pra `mcu-adapter`/
 * `subcircuit-file`, ver seção 21.3 -- ignorado silenciosamente pra `abi-device`, que não tem essa
 * variante). Subcircuito (`kind === "subcircuit-file"`) semeia TAMBÉM o circuito interno real
 * (`components[]`/`wires[]`) na MESMA sessão, junto com o `package` -- "Open Subcircuit" do
 * SimulIDE real mostra os dois juntos na mesma cena, não dois painéis separados. */
async function editPackageSymbolCommand(item?: { sourceId?: string; view?: "default" | "logicSymbol" }): Promise<void> {
  if (!state.extensionContext) return;
  const ctx = state.extensionContext;

  let absoluteFilePath: string | undefined;
  const sourceId = typeof item?.sourceId === "string" ? item.sourceId : undefined;
  if (sourceId) {
    const unifiedCatalog = loadUnifiedCatalog(ctx.extensionPath, currentLasecSimulLanguage());
    const source = unifiedCatalog.registeredSources.find((value) => value.id === sourceId);
    if (!source) {
      vscode.window.showWarningMessage("Item registrado não encontrado no catálogo.");
      return;
    }
    absoluteFilePath = normalizeAbsolutePath(ctx.extensionPath, source.filePath);
  } else {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { "LasecSimul": ["lsdevice", "lssubcircuit"] },
      title: "Editar símbolo visual de um .lsdevice/.lssubcircuit",
    });
    absoluteFilePath = picked?.[0]?.fsPath;
  }
  if (!absoluteFilePath) return;

  if (!fileExists(absoluteFilePath)) {
    vscode.window.showErrorMessage(`Arquivo não encontrado: ${absoluteFilePath}`);
    return;
  }

  let json: Record<string, unknown>;
  try {
    json = readJsonFile(absoluteFilePath) as Record<string, unknown>;
  } catch (err) {
    vscode.window.showErrorMessage(
      `Não foi possível ler ${absoluteFilePath}: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  const kind = detectManifestKind(absoluteFilePath, json);
  const typeIdKey = kind === "mcu-adapter" ? "chipId" : "typeId";
  const typeId = typeof json[typeIdKey] === "string" && String(json[typeIdKey]).trim() ? String(json[typeIdKey]).trim() : path.basename(absoluteFilePath);

  const view: "default" | "logicSymbol" = item?.view === "logicSymbol" && kind !== "abi-device" ? "logicSymbol" : "default";
  const packageKey = view === "logicSymbol" ? "logicSymbolPackage" : "package";
  let packageComponents = applySubcircuitInterfaceToPackageComponents(json, seedSymbolAuthoringComponents(extractPackageForEditing(json, packageKey, path.dirname(absoluteFilePath)), kind === "subcircuit-file" ? 0 : 140, kind === "subcircuit-file" ? 0 : 140));
  let components = packageComponents;
  let wires: WebviewWireModel[] = [];

  if (kind === "subcircuit-file") {
    const internal = extractInternalCircuit(json);
    const seededInternal = seedSubcircuitInternalComponents(internal.components, internal.wires);
    const componentsWithPins = seededInternal.components.map((component) => ({
      ...component,
      pins: pinsForInternalComponent(component.id, component.typeId, internal.wires),
    }));
    const translated = translateSimulideSubcircuitAuthoringScene(packageComponents, componentsWithPins, seededInternal.wires, extractSimulideSubcircuitScene(json));
    components = translated.components;
    wires = translated.wires;
  }

  if (!state.schematicPanel) openSchematicEditor(ctx.extensionUri);
  state.schematicPanel?.postMessage({
    version: 1,
    type: "enterSymbolAuthoring",
    filePath: absoluteFilePath,
    typeId,
    kind,
    view,
    components,
    wires,
  });
}

/** Handler de `requestSwitchSymbolView` (`messages.ts`) -- toggle "Ver: Físico/Símbolo Lógico" na
 * barra da sessão de autoria. Relê o `package`/`logicSymbolPackage` do disco (fresco, não confia no
 * que a Webview tinha) pra semear a NOVA vista, mas preserva o circuito interno EXATAMENTE como a
 * Webview mandou (`internalComponents`/`internalWires`, sessão atual em memória, não relido do
 * disco) -- trocar de vista nunca perde posição/propriedade de componente interno ainda não salvo,
 * só descarta o que foi editado no `package`/`logicSymbolPackage` da vista que está SAINDO (mesmo
 * aviso já mostrado na UI antes de mandar esta mensagem, ver `main.ts::toggleLogicSymbolView`). */
async function switchSymbolViewCommand(
  filePath: string,
  typeId: string,
  kind: RegisteredItemKind,
  toView: "default" | "logicSymbol",
  internalComponents: WebviewComponentModel[],
  internalWires: WebviewWireModel[]
): Promise<void> {
  if (!fileExists(filePath)) {
    vscode.window.showErrorMessage(`Arquivo não encontrado: ${filePath}`);
    return;
  }
  let json: Record<string, unknown>;
  try {
    json = readJsonFile(filePath) as Record<string, unknown>;
  } catch (err) {
    vscode.window.showErrorMessage(`Não foi possível reler ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const packageKey = toView === "logicSymbol" ? "logicSymbolPackage" : "package";
  const seededPackageComponents = applySubcircuitInterfaceToPackageComponents(json, seedSymbolAuthoringComponents(extractPackageForEditing(json, packageKey, path.dirname(filePath)), kind === "subcircuit-file" ? 0 : 140, kind === "subcircuit-file" ? 0 : 140));
  const packageComponents = kind === "subcircuit-file"
    ? translateSimulideSubcircuitAuthoringScene(seededPackageComponents, internalComponents, internalWires, extractSimulideSubcircuitScene(json)).components.slice(0, seededPackageComponents.length)
    : seededPackageComponents;

  state.schematicPanel?.postMessage({
    version: 1,
    type: "enterSymbolAuthoring",
    filePath,
    typeId,
    kind,
    view: toView,
    components: [...packageComponents, ...internalComponents],
    wires: internalWires,
  });
}

/** `other.package_pin`'s `properties.internalTunnel` é o vínculo com o `connectors.tunnel` interno
 * (`properties.name`), igual a `interface[].internalTunnel` de sempre (ver
 * `subcircuits/esp32_devkitc_v4.lssubcircuit`) -- compilado aqui, não em `symbolAuthoring.ts`
 * (`compileSymbolAuthoringComponents` só sabe do `package`, nunca do circuito interno). Ordem de
 * `compiledPins` é GARANTIDA igual à de `pinComponents` (mesmo array `components`, mesmo filtro,
 * mesma ordem de iteração nos dois lugares). */
function compileSubcircuitInterface(
  components: WebviewComponentModel[],
  compiledPins: PackagePin[],
  existingInterfaceByPinId: Map<string, { label?: string; internalTunnel?: string }>
): Array<{ pinId: string; label: string; internalTunnel: string }> {
  const pinComponents = components.filter((component) => component.typeId === "other.package_pin");
  return compiledPins.map((pin, index) => ({
    pinId: pin.id,
    label: pin.label ?? pin.id,
    internalTunnel:
      (typeof pinComponents[index]?.properties.internalTunnel === "string" && (pinComponents[index]!.properties.internalTunnel as string).trim())
      || existingInterfaceByPinId.get(pin.id)?.internalTunnel
      || "",
  }));
}

function isSymbolAuthoringSceneComponent(typeId: string): boolean {
  return typeId === "other.package" || typeId === "other.package_pin" || typeId.startsWith("graphics.");
}

function serializeSubcircuitSceneComponent(component: WebviewComponentModel): {
  componentId: string;
  x: number;
  y: number;
  rotation?: WebviewComponentModel["rotation"];
  flipH?: boolean;
  flipV?: boolean;
  properties?: Record<string, string | number | boolean>;
} {
  const localOrigin = componentLocalOrigin(component.typeId, component.properties);
  const sceneProperties: Record<string, string | number | boolean> = {};
  const qtOrigin = component.properties.__simulideQtOrigin;
  const scaleX = component.properties.__simulideSceneScaleX;
  const scaleY = component.properties.__simulideSceneScaleY;
  if (qtOrigin === true || Boolean(localOrigin)) sceneProperties.__simulideQtOrigin = true;
  if (typeof scaleX === "number" && Number.isFinite(scaleX) && scaleX > 0) sceneProperties.__simulideSceneScaleX = scaleX;
  if (typeof scaleY === "number" && Number.isFinite(scaleY) && scaleY > 0) sceneProperties.__simulideSceneScaleY = scaleY;
  const placement = {
    componentId: component.id,
    x: Math.round(component.x + (localOrigin?.x ?? 0)),
    y: Math.round(component.y + (localOrigin?.y ?? 0)),
    ...(component.rotation !== undefined ? { rotation: component.rotation } : {}),
    ...(Object.keys(sceneProperties).length > 0 ? { properties: sceneProperties } : {}),
  };
  if (component.typeId === TUNNEL_TYPE_ID) {
    const rotated = component.properties.__simulideTunnelRotated;
    if (typeof rotated === "boolean") {
      if (!placement.properties) placement.properties = {};
      placement.properties.__simulideTunnelRotated = rotated;
      return { ...placement, flipH: rotated };
    }
    return placement;
  }
  return {
    ...placement,
    ...(typeof component.flipH === "boolean" ? { flipH: component.flipH } : {}),
    ...(typeof component.flipV === "boolean" ? { flipV: component.flipV } : {}),
  };
}

function serializeSubcircuitSceneWire(wire: WebviewWireModel): {
  from: { componentId: string; pinId: string };
  to: { componentId: string; pinId: string };
  points: Array<{ x: number; y: number }>;
} | undefined {
  if (!wire.points || wire.points.length === 0) return undefined;
  return {
    from: wire.from,
    to: wire.to,
    points: wire.points.map((point) => ({ x: point.x, y: point.y })),
  };
}

/** Handler de `requestSaveSymbol` (`messages.ts`) -- relê o arquivo do disco (não confia no que a
 * Webview tinha em memória pras OUTRAS chaves, podem ter mudado por fora desde que a sessão de
 * autoria abriu), compila a sessão (`compileSymbolAuthoringComponents`) e substitui só a chave do
 * `package`/`logicSymbolPackage` (conforme `view`) — preservando tudo o mais. Pra subcircuito
 * (`kind === "subcircuit-file"`), TAMBÉM compila e grava `components[]`/`wires[]`/`interface[]`
 * reais (`compileSubcircuitInternalComponents`/`compileSubcircuitInterface`) -- mesmo arquivo que
 * um humano editaria à mão, nunca um formato/estado paralelo (ver `.spec/
 * lasecsimul-native-devices.spec` seção 21.3, `.spec/lasecsimul-subcircuits.spec` seção 4). Avisa
 * (sem bloquear o save) se algum `pinId` digitado num `other.package_pin` não bate com nenhum pino
 * elétrico conhecido (`knownPinIdsForManifest`, melhor-esforço -- vazio pra `mcu-adapter`, pinos
 * vêm do plugin em runtime). */
function persistSubcircuitAuthoringScene(json: Record<string, unknown>, components: WebviewComponentModel[], wires: WebviewWireModel[]): void {
  const packageComponent = components.find((component) => component.typeId === "other.package");
  if (!packageComponent) return;
  const internalComponents = components
    .filter((component) => !isSymbolAuthoringSceneComponent(component.typeId))
    .map(serializeSubcircuitSceneComponent);
  const internalWires = wires.map(serializeSubcircuitSceneWire).filter((wire): wire is NonNullable<typeof wire> => Boolean(wire));
  const existing = typeof json.authoringScene === "object" && json.authoringScene !== null
    ? json.authoringScene as Record<string, unknown>
    : {};
  const { transform: _legacyTransform, ...existingWithoutTransform } = existing;
  json.authoringScene = {
    ...existingWithoutTransform,
    package: { x: packageComponent.x, y: packageComponent.y },
    components: internalComponents,
    wires: internalWires,
  };
}

async function saveSymbolCommand(
  filePath: string,
  typeId: string,
  kind: RegisteredItemKind,
  view: "default" | "logicSymbol",
  components: WebviewComponentModel[],
  wires: WebviewWireModel[]
): Promise<void> {
  let json: Record<string, unknown>;
  try {
    json = readJsonFile(filePath) as Record<string, unknown>;
  } catch (err) {
    vscode.window.showErrorMessage(`Não foi possível reler ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const packageKey = view === "logicSymbol" ? "logicSymbolPackage" : "package";
  const existingPackage = extractPackageForEditing(json, packageKey, path.dirname(filePath));
  const existingInterfaceByPinId = extractSubcircuitInterfaceMap(json);
  const existingBackground = existingPackage.background;
  const result = compileSymbolAuthoringComponents(components, existingBackground, existingPackage);
  if (!result.package) {
    vscode.window.showErrorMessage(result.error ?? "Não foi possível compilar o símbolo.");
    return;
  }

  const knownPinIds = knownPinIdsForManifest(json, kind);
  if (knownPinIds.length > 0) {
    const unknownIds = result.package.pins.map((pin) => pin.id).filter((id) => !knownPinIds.includes(id));
    if (unknownIds.length > 0) {
      vscode.window.showWarningMessage(`Pino(s) sem correspondência elétrica conhecida em "${typeId}": ${unknownIds.join(", ")}. Salvando assim mesmo.`);
    }
  }

  json[packageKey] = {
    ...result.package,
    ...(result.package.schematicWidth === undefined && existingPackage.schematicWidth !== undefined ? { schematicWidth: existingPackage.schematicWidth } : {}),
    ...(result.package.schematicHeight === undefined && existingPackage.schematicHeight !== undefined ? { schematicHeight: existingPackage.schematicHeight } : {}),
    ...(existingPackage.initialTransform !== undefined ? { initialTransform: existingPackage.initialTransform } : {}),
    ...(existingPackage.pinMarker !== undefined ? { pinMarker: existingPackage.pinMarker } : {}),
    ...(existingPackage.simulidePaint !== undefined ? { simulidePaint: existingPackage.simulidePaint } : {}),
    ...(existingPackage.qtWidget !== undefined ? { qtWidget: existingPackage.qtWidget } : {}),
    ...(existingPackage.viewSpec !== undefined ? { viewSpec: existingPackage.viewSpec } : {}),
    ...(existingPackage.valueLabel !== undefined ? { valueLabel: existingPackage.valueLabel } : {}),
  };

  if (kind === "subcircuit-file") {
    const internal = compileSubcircuitInternalComponents(components, wires);
    persistSubcircuitAuthoringScene(json, components, wires);
    json.components = internal.components.map((component) => ({ id: component.id, typeId: component.typeId, properties: component.properties, visual: component.visual, boardVisual: component.boardVisual, exposed: component.exposed }));
    json.wires = internal.wires.map((wire) => ({ from: wire.from, to: wire.to, points: wire.points }));
    json.interface = compileSubcircuitInterface(components, result.package.pins, existingInterfaceByPinId);
  }

  try {
    fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  } catch (err) {
    vscode.window.showErrorMessage(`Não foi possível salvar ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  await refreshUnifiedCatalogState(true);
  vscode.window.showInformationMessage(`Símbolo visual de "${typeId}" salvo em ${filePath}.`);
}

export function activate(context: vscode.ExtensionContext): void {
  state.extensionContext = context;
  const unifiedCatalog = loadUnifiedCatalog(context.extensionPath, currentLasecSimulLanguage());
  const initialResolved = resolveRegisteredItems(context.extensionPath, unifiedCatalog.registeredSources);
  state.schematicState = createInitialWebviewState([
    ...unifiedCatalog.catalog,
    ...initialResolved.map((item) => item.entry),
  ]);
  state.schematicState.locale = currentLasecSimulLanguage();

  const corePath = resolveCoreExecutablePath(context.extensionPath);
  const pipeName = CoreProcess.defaultPipeName();

  state.coreProc = new CoreProcess({ executablePath: corePath, pipeName });
  state.coreProc.onError((err) => {
    vscode.window.showErrorMessage(
      `LasecSimul Core: não foi possível iniciar "${corePath}" (${err.message}). ` +
        `Compile o Core antes (npm run build:core) e confirme que o gerador usado coloca o binário ` +
        `em core/build/ ou core/build/<Config>/.`
    );
  });
  try {
    state.coreProc.start();
  } catch (err) {
    vscode.window.showErrorMessage(
      `LasecSimul Core: falha ao iniciar processo: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  state.coreProc.onExit((code) => {
    // RNF: Core caiu → reiniciar + restaurar snapshot (ver lasecsimul-native-devices.spec §12.5)
    vscode.window.showWarningMessage(`LasecSimul Core terminou (code ${code}). Reinicie a simulação.`);
    state.coreClient = undefined;
  });

  state.coreClient = new CoreClient(pipeName);
  // Conecta de forma assíncrona — não bloqueia a ativação da extensão
  state.coreClient
    .start()
    .then(() => refreshUnifiedCatalogState(true))
    .catch((err) => {
      vscode.window.showErrorMessage(
        `Falha ao conectar ao LasecSimul Core: ${err instanceof Error ? err.message : String(err)}`
      );
    });

  const addPaletteComponent = (typeId: string) => {
    if (!state.schematicPanel) openSchematicEditor(context.extensionUri);
    state.schematicPanel?.postMessage({ version: 1, type: "beginComponentPlacement", typeId });
  };

  state.paletteViewProvider = new ComponentPaletteViewProvider(
    context.extensionUri,
    state.schematicState.catalog,
    currentLasecSimulLanguage(),
    addPaletteComponent,
    (item) => removeRegisteredCatalogItemCommand(item),
    (item) => editPackageSymbolCommand(item)
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("lasecsimul.componentPalette", state.paletteViewProvider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("lasecsimul.language")) return;
      state.schematicState = { ...state.schematicState, locale: currentLasecSimulLanguage() };
      state.paletteViewProvider?.setLanguage(currentLasecSimulLanguage());
      void refreshUnifiedCatalogState(Boolean(state.coreClient));
      syncSchematicPanel();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("lasecsimul.simulation")) return;
      if (!state.coreClient) return;
      const cfg = vscode.workspace.getConfiguration("lasecsimul.simulation");
      const targetStepUs = cfg.get<number>("targetStepUs", 0);
      const maxNonLinearIterations = cfg.get<number>("maxNonLinearIterations", 0);
      state.coreClient.setSimulationConfig({ targetStepUs, maxNonLinearIterations })
        .catch((err: unknown) => reportCoreWarning("configurar simulação", err));
    }),
    vscode.commands.registerCommand("lasecsimul.openSchematicEditor", () => openSchematicEditor(context.extensionUri)),
    vscode.commands.registerCommand("lasecsimul.newSubcircuit", () => triggerCreateSubcircuitFromSelection(state.schematicPanel)),
    vscode.commands.registerCommand("lasecsimul.openSettings", () => {
      void vscode.commands.executeCommand("workbench.action.openSettings", "lasecsimul.");
    }),
    vscode.commands.registerCommand("lasecsimul.palette.addComponent", (typeId: string) => addPaletteComponent(typeId)),
    vscode.commands.registerCommand("lasecsimul.run", () => runSimulation()),
    vscode.commands.registerCommand("lasecsimul.pause", () => pauseSimulation()),
    vscode.commands.registerCommand("lasecsimul.stop", () => stopSimulation()),
    vscode.commands.registerCommand("lasecsimul.saveProject", () => saveProjectCommand()),
    vscode.commands.registerCommand("lasecsimul.openProject", () => openProjectCommand(context)),
    vscode.commands.registerCommand("lasecsimul.palette.registerFile", () => registerCatalogFileCommand()),
    vscode.commands.registerCommand("lasecsimul.palette.removeRegistered", (item: { sourceId?: string }) =>
      removeRegisteredCatalogItemCommand(item)
    ),
    vscode.commands.registerCommand("lasecsimul.palette.editSymbol", (item?: { sourceId?: string }) =>
      editPackageSymbolCommand(item)
    ),
    // Keybinding em contributes.keybindings ("when": activeWebviewPanelId == 'lasecsimul.schematic')
    // sobrepõe Ctrl+R/Ctrl+Shift+R do VSCode SÓ enquanto o painel do esquemático está em foco --
    // fora dele, o `when` deixa de casar e o atalho nativo do VSCode volta a funcionar sozinho, sem
    // nenhuma lógica de restauração aqui (ver `.spec/lasecsimul.spec` seção 13.4).
    vscode.commands.registerCommand("lasecsimul.rotateSelectionCw", () => {
      state.schematicPanel?.postMessage({ version: 1, type: "requestRotateSelection", direction: "cw" });
    }),
    vscode.commands.registerCommand("lasecsimul.rotateSelectionCcw", () => {
      state.schematicPanel?.postMessage({ version: 1, type: "requestRotateSelection", direction: "ccw" });
    }),
    vscode.commands.registerCommand("lasecsimul.flipSelectionHorizontal", () => {
      state.schematicPanel?.postMessage({ version: 1, type: "requestFlipSelection", axis: "horizontal" });
    }),
    vscode.commands.registerCommand("lasecsimul.flipSelectionVertical", () => {
      state.schematicPanel?.postMessage({ version: 1, type: "requestFlipSelection", axis: "vertical" });
    }),
    // Mesmo motivo do Ctrl+R acima -- Ctrl+Z/Ctrl+Y/Ctrl+Shift+Z são comandos globais nativos do
    // VSCode (undo/redo do editor de texto); sem este keybinding dedicado (quando o painel do
    // esquemático está em foco) o VSCode intercepta antes de chegar na Webview via `keydown`.
    vscode.commands.registerCommand("lasecsimul.undo", () => {
      state.schematicPanel?.postMessage({ version: 1, type: "requestUndo" });
    }),
    vscode.commands.registerCommand("lasecsimul.redo", () => {
      state.schematicPanel?.postMessage({ version: 1, type: "requestRedo" });
    }),
  );

  void setSchematicOpenContext(false);
  void refreshUnifiedCatalogState(false);
}

export async function deactivate(): Promise<void> {
  closeAllMcuSerialMonitors();
  stopVoltageReadoutPolling();
  await state.coreClient?.stop().catch(() => {});
  state.coreProc?.kill(); // force-kill de segurança caso shutdown IPC não tenha chegado
}
