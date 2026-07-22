import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { CoreClient } from "./ipc/CoreClient";
import { IpcError } from "./ipc/protocol";
import { CoreProcess } from "./ipc/CoreProcess";
import { resolveCoreExecutablePath } from "./core/coreExecutable";
import { TrustStore } from "./trust/TrustStore";
import { isPreApproved, isPreBlocked, resolveConsentChoice, shouldLoadLibrary, decisionToPersist } from "./trust/trustDecision";
import { SchematicPanel } from "./ui/panels/SchematicPanel";
import { createInitialWebviewState } from "./ui/webview/catalog";
import { CanonicalTopologyDocument, JUNCTION_TYPE_ID, PackageDescriptor, TUNNEL_TYPE_ID, WebviewComponentCatalogEntry, WebviewComponentModel, WebviewProjectState, WebviewWireModel, endpointId, endpointPinId, portEndpoint } from "./ui/webview/model";
import { connectEndpointToNode, normalizeWireGeometry, removeOrphanNodes, splitSegmentAtPoint } from "./ui/webview/wireTopology";
import { assertTopologyInvariants } from "./ui/webview/topologyDocument";
import { WebviewToHostMessage } from "./ui/webview/messages";
import { ComponentPaletteViewProvider } from "./ui/views/ComponentPaletteViewProvider";
import { materializePinGroup, registerPackage } from "./ui/webview/componentSymbols";
import { absoluteDeviceRefPath, absoluteSubcircuitRefPath, importProjectCommand, openProjectCommand, openProjectFile, openRecentProjectCommand, projectComponentToWebviewComponent, refreshDirtyIndicator, saveProjectAsCommand, saveProjectCommand, webviewComponentToProjectComponent } from "./project/projectCommands";
import { loadUnifiedCatalog, RegisteredSource, saveRegisteredSources } from "./catalog/UnifiedCatalog";
import { attachPropertySchemas, refreshUnifiedCatalogState, registerCatalogFileCommand, removeRegisteredCatalogItemCommand } from "./catalog/catalogCommands";
import { hasShowOnSymbolProperty, nextIndexedLabel } from "./catalog/catalogMerge";
import { imageMimeForFile, sanitizeManifestDefaultProperties } from "./catalog/packageSanitizers";
import { SUBCIRCUIT_SCHEMA_VERSION, SubcircuitDocument, parseSubcircuitDocument, schemaVersionRejectionMessage, serializeSubcircuitDocument } from "./catalog/subcircuitDocument";
import { finalizeSubcircuitDocumentForSave } from "./catalog/subcircuitPinModel";
import { pruneInvalidExposedComponentRefs } from "./catalog/subcircuitExposedComponents";
import { validateSubcircuitDocument } from "./catalog/subcircuitValidation";
import { compileSymbolScene, materializeSymbolScene } from "./catalog/subcircuitSymbolScene";
import { fileExists, normalizeAbsolutePath, readJsonFile } from "./pathUtils";
import { currentLasecSimulLanguage } from "./currentLanguage";
import {
  parseSubcircuitManifest,
  resolveRegisteredItem,
  resolveRegisteredItems,
} from "./catalog/registeredSources";
import {
  state,
  coreInstanceIdByComponentId,
  mcuTargetCoreIdByComponentId,
} from "./state";
import {
  reportCoreWarning,
  pushComponentToCore,
  pushWireToCore,
  pushWireTopologyTransaction,
  pushRemoveWireToCore,
  pushPropertyToCore,
  previewPropertyInCore,
  pushRemoveToCore,
  pushTunnelNameToCore,
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
  electricalOperationsDiff,
} from "./core/coreLifecycle";
import { ElementCategory, ElementScope, getElement, insertElements, moveElement, removeElement, setExposedComponentEntry, updateElement } from "./core/schematicModel";
import {
  chooseExposedMcuFirmwareCommand,
  chooseMcuFirmwareCommand,
  closeAllMcuSerialMonitors,
  closeMcuSerialMonitor,
  closeMcuSerialMonitorByKey,
  ensureAllMcuFirmwareUpToDate,
  openExposedMcuSerialMonitorCommand,
  openMcuSerialMonitorCommand,
  requestBoardOverlayDataCommand,
  updateBoardOverlayPropertyCommand,
  updateBoardOverlayVisualCommand,
  updateExposedComponentPropertyCommand,
} from "./mcu/mcuCommands";
import { debugMcuFirmwareCommand, registerMcuDebugTracking } from "./mcu/mcuDebug";
import { initializeLasecPlot, lasecPlotManager } from "./lasecplot/manager";
import { LasecSimulInteropApi } from "./lasecplot/api";
import { initializeSerialTerminal, serialTerminalManager } from "./serialterm/manager";
import { initializeSerialPort, serialPortManager } from "./serialport/manager";
import {
  gatherInternalComponentSnapshots,
  resolveSourceFilePath,
} from "./catalog/subcircuitInternals";
import { initSimulationLog, logSimulation, noteSimulationStatusChange, showSimulationLogChannel } from "./diagnostics/simulationLog";
import { ProjectCustomEditorProvider } from "./ui/panels/ProjectCustomEditorProvider";
import {
  externalFolderPath,
  missingManifestDependencies,
  validateExternalManifest,
  writeAdhocDeviceLibrary,
} from "./catalog/externalComponents";

const deviceReferenceWatchers = new Map<string, vscode.FileSystemWatcher>();
const deviceReferenceReloadTimers = new Map<string, NodeJS.Timeout>();

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
  "locale", "catalog", "components", "topology", "viewport", "selectedComponentIds", "selectedWireIds", "pendingConnection",
  "subcircuitEditingContext", "symbolElements", "iconElements", "exposedComponents", "exportedPropertyComponentIds", "symbolCanvas", "iconCanvas",
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
type ProjectStatePatch = Omit<Partial<WebviewProjectState>, "pendingConnection" | "subcircuitEditingContext" | "symbolCanvas" | "iconCanvas"> & {
  pendingConnection?: WebviewProjectState["pendingConnection"] | null;
  subcircuitEditingContext?: WebviewProjectState["subcircuitEditingContext"] | null;
  symbolCanvas?: WebviewProjectState["symbolCanvas"] | null;
  iconCanvas?: WebviewProjectState["iconCanvas"] | null;
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
    if (key === "subcircuitEditingContext" && state.schematicState.subcircuitEditingContext === undefined) {
      toClone[key] = null;
      continue;
    }
    if (key === "symbolCanvas" && state.schematicState.symbolCanvas === undefined) {
      toClone[key] = null;
      continue;
    }
    if (key === "iconCanvas" && state.schematicState.iconCanvas === undefined) {
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
  reconcileDeviceReferenceWatchers();
  lasecPlotManager?.sync();
  serialTerminalManager?.sync();
  serialPortManager?.sync();
  const lastSynced = state.lastSyncedProjectState;
  if (lastSynced &&
      (lastSynced.components !== state.schematicState.components || lastSynced.topology.conductors !== state.schematicState.topology.conductors) &&
      state.schematicState.topology.revision <= lastSynced.topology.revision) {
    state.schematicState = { ...state.schematicState, topology: { ...state.schematicState.topology, revision: lastSynced.topology.revision + 1 } };
  }
  state.schematicPanel?.setLanguage(state.schematicState.locale ?? currentLasecSimulLanguage());
  const patch = computeProjectStatePatch();
  if (patch) state.schematicPanel?.postMessage({ version: 1, type: "syncStatePatch", patch });
  state.schematicPanel?.postMessage({ version: 1, type: "simulationStatus", status: state.simulationStatus });
  refreshDirtyIndicator();
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

function setEffectiveCatalog(entries: WebviewComponentCatalogEntry[]): void {
  state.schematicState = { ...state.schematicState, catalog: entries };
  // `componentSymbols.ts` é compilado duas vezes (host via `out/`, Webview via `out-webview/`) --
  // são DUAS instâncias de módulo totalmente separadas, cada uma com seu próprio registro de
  // pacotes em memória (`PACKAGE_BY_TYPE_ID`). Sem espelhar aqui o `syncPackageRegistry` que
  // `main.ts` já faz do lado da Webview, `componentBox`/`pinLocalPosition` do lado do HOST caem
  // silenciosamente no algoritmo genérico pra QUALQUER typeId com package real -- geometria de pino
  // diferente da que a Webview mostra, quebrando `wireTopology.ts` (split de fio no ponto errado,
  // clique no meio de um fio não faz nada -- bug real encontrado 2026-07-11).
  for (const entry of entries) registerPackage(entry.typeId, entry.package, entry.logicSymbolPackage);
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

function catalogCommandOptions(): Parameters<typeof refreshUnifiedCatalogState>[1] {
  return { loadConfiguredDeviceLibraries, setEffectiveCatalog };
}

function mcuCommandOptions(): Parameters<typeof chooseMcuFirmwareCommand>[1] {
  return {
    syncSchematicPanel,
    reportCoreWarning,
    gatherInternalComponentSnapshots,
    resolveSourceFilePath,
    refreshUnifiedCatalogState: (loadLibrariesInCore) => refreshUnifiedCatalogState(loadLibrariesInCore, catalogCommandOptions()),
  };
}

/** Registra os handlers de ciclo de vida de um `CoreProcess` recém-criado -- extraído de `activate()`
 * pra ser reaproveitado por `ensureCoreConnected()` (reconexão sob demanda quando o Core morreu). */
function attachCoreProcessHandlers(proc: CoreProcess, corePath: string): void {
  proc.onError((err) => {
    logSimulation(
      "error",
      `Não foi possível iniciar "${corePath}": ${err.message}`,
      {
        stage: "core-process",
        detail: "Compile o Core antes (npm run build:core) e confirme que o gerador usado coloca o binário em core/build/ ou core/build/<Config>/.",
      }
    );
  });
  proc.onExit((code) => {
    logSimulation("error", `LasecSimul Core terminou (code ${code}).`, { stage: "core-process" });
    state.coreClient = undefined;
    setSimulationStatus("stopped");
    for (const component of state.schematicState.components.filter((entry) => entry.typeId === "peripherals.lasecplot")) {
      state.schematicPanel?.postMessage({ version: 1, type: "lasecPlotStatus", componentId: component.id, opened: false, clients: 0, error: "Core encerrado inesperadamente" });
    }
    serialTerminalManager?.updateSimulationState();
    serialPortManager?.updateSimulationState();
  });
}

/** Registra o handler de notificações assíncronas de um `CoreClient` recém-criado (hoje só
 * `pauseConditionTriggered`) -- mesmo motivo de `attachCoreProcessHandlers`: reaproveitado por
 * `ensureCoreConnected()`. */
function attachCoreClientNotifications(client: CoreClient): void {
  client.onNotification((notification) => {
    if (notification.type !== "pauseConditionTriggered") return;
    const payload = notification.payload as {
      ownerId?: string;
      simulationTimeNs?: number;
      expression?: string;
      resolvedValues?: Record<string, number | boolean | string>;
      error?: string;
    };
    stopVoltageReadoutPolling(false);
    setSimulationStatus("paused");
    // Erro de AVALIAÇÃO da condição (expressão inválida) acende o indicador de erro em vez do simples
    // "pausado" -- antes disto o `payload.error` só ia pra Webview (inline no instrumento), sem
    // nenhum rastro no canal de saída/status bar.
    if (payload.error) {
      logSimulation("error", payload.error, { device: componentLabel(payload.ownerId ?? ""), stage: "condição-de-pausa" });
    } else {
      noteSimulationStatusChange("paused");
    }
    state.schematicPanel?.postMessage({
      version: 1,
      type: "pauseConditionTriggered",
      ownerId: payload.ownerId ?? "",
      simulationTimeNs: Number(payload.simulationTimeNs ?? 0),
      expression: payload.expression ?? "",
      resolvedValues: payload.resolvedValues ?? {},
      ...(payload.error ? { error: payload.error } : {}),
    });
  });
}

/** Resolve o binário, monta o ambiente e sobe um `CoreProcess` novo em `state.coreProc` -- usado na
 * ativação da extensão E por `ensureCoreConnected()` pra reiniciar depois que o processo morreu. */
function launchCoreProcess(extensionPath: string): { corePath: string; pipeName: string } {
  const corePath = resolveCoreExecutablePath(extensionPath);
  const pipeName = CoreProcess.defaultPipeName();
  const networkConfiguration = vscode.workspace.getConfiguration("lasecsimul.network");
  const configuredNetworkNamespace = networkConfiguration.get<number>("namespace", -1);
  const configuredNetworkMode = networkConfiguration.get<string>("mode", "disabled");
  const configuredGatewayPort = networkConfiguration.get<number>("gatewayPort", 9011);
  const coreEnv: NodeJS.ProcessEnv = {
    // Prevent shared-memory arena collisions between thin-client instances.
    LASECSIMUL_HOST_INSTANCE_ID: String(process.pid),
    LASECSIMUL_NETWORK_MODE:
      configuredNetworkMode === "lab-bridge" || configuredNetworkMode === "isolated"
        ? configuredNetworkMode
        : "disabled",
    LASECSIMUL_GATEWAY_PORT: String(configuredGatewayPort),
  };
  if (Number.isInteger(configuredNetworkNamespace) && configuredNetworkNamespace >= 0 && configuredNetworkNamespace <= 255) {
    coreEnv.LASECSIMUL_NETWORK_NAMESPACE = String(configuredNetworkNamespace);
  }

  state.coreProc = new CoreProcess({ executablePath: corePath, pipeName, env: coreEnv });
  attachCoreProcessHandlers(state.coreProc, corePath);
  try {
    state.coreProc.start();
  } catch (err) {
    logSimulation("error", `Falha ao iniciar processo: ${err instanceof Error ? err.message : String(err)}`, { stage: "core-process" });
  }
  return { corePath, pipeName };
}

/** Cria e conecta um `CoreClient` novo ao pipe de um `CoreProcess` já iniciado (handshake incluído). */
async function connectCoreClient(pipeName: string): Promise<CoreClient> {
  const client = new CoreClient(pipeName);
  attachCoreClientNotifications(client);
  await client.start();
  return client;
}

let coreReconnectPromise: Promise<boolean> | undefined;

/** Reconecta ao Core quando `state.coreClient` está ausente (processo caiu -- inclusive derrubado à
 * força pelo usuário depois de um "Parar" que não respondia -- ou falhou ao conectar na ativação).
 * ANTES disto, nenhum caminho reiniciava `state.coreProc`/`state.coreClient`: "Run" ficava preso pra
 * sempre em "O Core ainda não está conectado" até o usuário recarregar a janela inteira do VS Code
 * (bug relatado 2026-07-17). Reconstrói o circuito inteiro no processo novo a partir de
 * `state.schematicState` (fonte de verdade já vive na Extension, não no Core) -- é a "restaurar
 * snapshot" que o comentário antigo em `attachCoreProcessHandlers`/`coreProc.onExit` prometia (RNF,
 * .spec/lasecsimul-native-devices.spec) mas nunca implementava. Deliberadamente reativo (só tenta
 * quando o usuário pede "Run" de novo), nunca automático a partir de `onExit` -- um Core que morre
 * repetidamente (binário quebrado, por exemplo) não deve virar um loop de respawn silencioso em
 * segundo plano. `coreReconnectPromise` coalesce chamadas concorrentes (ex: duplo-clique em "Run") --
 * só uma tentativa de reconexão por vez. */
async function ensureCoreConnected(): Promise<boolean> {
  if (state.coreClient) return true;
  if (!state.extensionContext) return false;
  if (coreReconnectPromise) return coreReconnectPromise;
  coreReconnectPromise = (async () => {
    logSimulation("info", "Core desconectado -- reiniciando processo antes de rodar...", { stage: "core-process" });
    try {
      const { pipeName } = launchCoreProcess(state.extensionContext!.extensionPath);
      const client = await connectCoreClient(pipeName);
      state.coreClient = client;
      await refreshUnifiedCatalogState(true, catalogCommandOptions());
      await rebuildCoreFromSchematicState();
      return true;
    } catch (err) {
      logSimulation("error", `Falha ao reconectar ao Core: ${err instanceof Error ? err.message : String(err)}`, { stage: "core-process" });
      return false;
    }
  })();
  try {
    return await coreReconnectPromise;
  } finally {
    coreReconnectPromise = undefined;
  }
}

/** Substitui a chamada direta a `runSimulation()` nos dois pontos de entrada de "Run" (mensagem
 * `requestRunSimulation` da Webview E comando `lasecsimul.run`) -- achado de auditoria 2026-07-09:
 * "Recarregar Firmware" era uma ação manual que o usuário precisava lembrar de clicar toda vez que
 * recompilava o `.bin` fora do LasecSimul; removida da interface (`main.ts`), o recarregamento agora
 * é sempre automático, verificado aqui ANTES de rodar. `ensureAllMcuFirmwareUpToDate` só empurra
 * firmware pro Core quando o arquivo mudou (mtime+tamanho) desde a última carga daquela instância --
 * nunca recarrega à toa, nem no caso comum (nada mudou). Se QUALQUER MCU/CPU tiver firmware ausente/
 * inacessível ou a recarga falhar, a simulação NÃO inicia -- erro claro em vez de rodar com firmware
 * potencialmente desatualizado ou o processo QEMU num estado inconsistente. */
let startSimulationPreparationPending = false;

async function runSimulationWithFirmwareCheck(): Promise<void> {
  // O comando de teclado/Command Palette obedece à mesma máquina de estados do botão: retomar uma
  // pausa nunca passa pelo carregador de firmware e nunca recria o circuito/QEMU.
  if (state.simulationStatus === "paused") {
    pauseSimulation();
    return;
  }
  if (state.simulationStatus !== "stopped" || startSimulationPreparationPending) return;
  startSimulationPreparationPending = true;
  try {
  // Sem isto, "Run" ficava em silêncio TOTAL sempre que `state.coreClient` ainda não estava pronto
  // (Core em processo de inicialização, ou falhou ao conectar) -- achado real: `ensureAllMcuFirmwareUpToDate`
  // PULA cada MCU quando `!state.coreClient` (`continue`, nunca `ok:false`) e `registerAllPauseConditions`
  // devolve `false` no mesmo caso (também sem mensagem nenhuma) -- as duas etapas seguintes rodavam
  // "com sucesso" (nada de errado detectado) e `runSimulation()` nunca era chamado, sem nenhum
  // feedback visível pro usuário sobre o motivo.
  if (!(await ensureCoreConnected())) {
    logSimulation("error", "O Core ainda não está conectado.", { stage: "core" });
    return;
  }
  const result = await ensureAllMcuFirmwareUpToDate(mcuCommandOptions());
  if (!result.ok) return; // já logado (canal + Problemas + status bar) dentro de ensureAllMcuFirmwareUpToDate
  await registerAllPauseConditions().then((valid) => valid ? runSimulation() : undefined);
  } finally {
    startSimulationPreparationPending = false;
  }
}

function persistedPauseCondition(component: WebviewComponentModel): string {
  const raw = component.properties.__ui_instrumentView;
  if (typeof raw !== "string" || raw.length > 32_768) return "";
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed.version === 1 && typeof parsed.triggerCondition === "string" ? parsed.triggerCondition.trim() : "";
  } catch { return ""; }
}

async function registerAllPauseConditions(): Promise<boolean> {
  if (!state.coreClient) return false;
  for (const component of state.schematicState.components) {
    if (component.typeId !== "meters.logic_analyzer") continue;
    try {
      await state.coreClient.setPauseCondition(component.id, persistedPauseCondition(component));
      state.schematicPanel?.postMessage({ version: 1, type: "pauseConditionValidation", componentId: component.id, valid: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.schematicPanel?.postMessage({ version: 1, type: "pauseConditionValidation", componentId: component.id, valid: false, error: message });
      logSimulation("error", message, { device: component.label || component.id, stage: "condição-de-pausa" });
      return false;
    }
  }
  return true;
}

function getComponentById(componentId: string): WebviewComponentModel | undefined {
  return getElement(state.schematicState, componentId)?.element;
}

function componentLabel(componentId: string): string {
  return getComponentById(componentId)?.label ?? componentId;
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
    await state.coreClient.registerAdhocSubcircuitDefinition(absolutePath, { replace: Boolean(component.subcircuitRef?.lastKnownTypeId) });
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
  if (parsed.schemaVersionRejected) {
    void vscode.window.showErrorMessage(parsed.schemaVersionRejected, { modal: true });
    return;
  }
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
  for (const wire of state.schematicState.topology.conductors) {
    const touchesFrom = endpointId(wire.from) === componentId;
    const touchesTo = endpointId(wire.to) === componentId;
    if (!touchesFrom && !touchesTo) {
      survivingWireIds.add(wire.id);
      continue;
    }
    const ownPinId = touchesFrom ? endpointPinId(wire.from) : endpointPinId(wire.to);
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

  const updated = updateElement(state.schematicState, componentId, {
    typeId: parsed.typeId,
    label: component.typeId === parsed.typeId ? component.label : nextIndexedLabel(parsed.typeId, label, state.schematicState.components),
    pins: newPins,
    properties: parsed.defaultProperties,
    subcircuitRef: { path: absolutePath, lastKnownTypeId: parsed.typeId, lastKnownPinIds: newPinIds },
  });
  if (!updated.ok) return; // componentId sumiu entre o início do comando e agora (corrida rara) -- nada a fazer
  const updatedComponent = updated.value.ref.element;

  state.schematicState = {
    ...updated.value.state,
    catalog: [...updated.value.state.catalog.filter((entry) => entry.typeId !== parsed.typeId), ephemeralEntry],
    topology: { ...updated.value.state.topology, conductors: updated.value.state.topology.conductors.filter((wire) => survivingWireIds.has(wire.id)) },
  };

  // Recria no Core: o typeId pode ter mudado (pino fixo desde a construção, não dá pra
  // redimensionar in-place) -- remove a instância antiga, registra a definição avulsa, cria de
  // novo e reconecta os fios sobreviventes contra o NOVO instanceId.
  pushRemoveToCore(componentId);
  coreInstanceIdByComponentId.delete(componentId);
  mcuTargetCoreIdByComponentId.delete(componentId);
  if (state.coreClient && shouldSyncComponentToCore(parsed.typeId)) {
    const created = await pushComponentToCore(componentId, parsed.typeId, updatedComponent.properties, newPins);
    if (created) {
      for (const wire of state.schematicState.topology.conductors) {
        if (endpointId(wire.from) === componentId || endpointId(wire.to) === componentId) await pushWireToCore(wire);
      }
      if (state.simulationStatus === "running") {
        void pollInstrumentReadouts();
        void pollWireVoltages();
      }
    }
  }

  syncSchematicPanel();
  if (droppedWireCount > 0) {
    vscode.window.showWarningMessage(`${droppedWireCount} fio(s) removido(s): pino(s) não existem mais no novo subcircuito.`);
  }
}

/** Resolve um .lsdevice avulso para uma única instância, sem gravá-lo em registeredSources. */
async function loadDeviceReference(componentId: string, absolutePath: string, showErrors = true): Promise<boolean> {
  const component = getComponentById(componentId);
  if (!component || !state.extensionContext) return false;
  if (!state.coreClient) {
    if (showErrors) vscode.window.showErrorMessage("Core indisponível: não foi possível carregar o Device externo.");
    return false;
  }

  let manifest: ReturnType<typeof validateExternalManifest>;
  try {
    manifest = validateExternalManifest(absolutePath, readJsonFile(absolutePath));
    if (manifest.kind !== "device") throw new Error("selecione um arquivo .lsdevice");
  } catch (err) {
    if (showErrors) vscode.window.showErrorMessage(`Device inválido: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }

  const libraryPath = writeAdhocDeviceLibrary(
    absolutePath,
    manifest,
    state.extensionContext.globalStorageUri.fsPath,
  );
  const failures = await loadConfiguredDeviceLibraries(state.extensionContext.extensionPath, [{
    displayPath: absolutePath,
    absolutePath: libraryPath,
  }]);
  const failure = failures.get(path.normalize(libraryPath));
  if (failure) {
    if (showErrors) vscode.window.showErrorMessage(`Falha ao carregar Device: ${failure}`);
    return false;
  }

  const source: RegisteredSource = {
    id: `adhoc-device:${componentId}`,
    kind: manifest.runtimeKind!,
    filePath: absolutePath,
    libraryPath,
    folderPath: externalFolderPath("device", currentLasecSimulLanguage()),
    removable: false,
  };
  const resolved = resolveRegisteredItem(source, state.extensionContext.extensionPath, currentLasecSimulLanguage(),
    manifest.runtimeKind === "mcu-adapter" ? new Set([manifest.typeId]) : new Set());
  if (resolved.entry.disabled) {
    if (showErrors) vscode.window.showErrorMessage(`Device incompatível: ${resolved.entry.disabledReason ?? "manifesto não suportado"}`);
    return false;
  }

  const newPinIds = resolved.entry.pinIds?.length
    ? resolved.entry.pinIds
    : Array.from({ length: resolved.entry.pinCount }, (_, index) => `pin-${index + 1}`);
  const newPinSet = new Set(newPinIds);
  let droppedWireCount = 0;
  const conductors = state.schematicState.topology.conductors.filter((wire) => {
    const from = endpointId(wire.from) === componentId;
    const to = endpointId(wire.to) === componentId;
    if (!from && !to) return true;
    const pinId = from ? endpointPinId(wire.from) : endpointPinId(wire.to);
    const keep = newPinSet.has(pinId);
    if (!keep) droppedWireCount++;
    return keep;
  });
  const rawEntry: WebviewComponentCatalogEntry = {
    ...resolved.entry,
    hidden: true,
    isRegistered: false,
    registeredSourceRemovable: false,
    externalReferencePath: path.normalize(absolutePath),
  };
  const entry = (await attachPropertySchemas([rawEntry]))[0] ?? rawEntry;
  const label = component.typeId === "devices.external"
    ? nextIndexedLabel(manifest.typeId, resolved.entry.label, state.schematicState.components)
    : component.label;
  const updated = updateElement(state.schematicState, componentId, {
    typeId: manifest.typeId,
    label,
    pins: newPinIds.map((id, index) => ({ id, x: 0, y: index * 12 })),
    // Defaults novos entram, mas propriedades da instância (inclusive posições de labels) vencem.
    properties: { ...resolved.entry.defaultProperties, ...component.properties },
    subcircuitRef: undefined,
    deviceRef: {
      path: absolutePath,
      lastKnownTypeId: manifest.typeId,
      lastKnownPinIds: newPinIds,
      lastKnownMtimeMs: fs.statSync(absolutePath).mtimeMs,
    },
  });
  if (!updated.ok) return false;
  state.schematicState = {
    ...updated.value.state,
    catalog: [
      ...updated.value.state.catalog.filter((candidate) => candidate.typeId !== manifest.typeId),
      entry,
    ],
    topology: { ...updated.value.state.topology, conductors },
  };
  syncSchematicPanel();
  if (droppedWireCount > 0 && showErrors) {
    vscode.window.showWarningMessage(`${droppedWireCount} fio(s) removido(s): pino(s) não existem mais no Device recarregado.`);
  }
  return true;
}

async function chooseDeviceFileCommand(componentId: string): Promise<void> {
  const component = getComponentById(componentId);
  if (!component) return;
  const previous = component.deviceRef?.path ? absoluteDeviceRefPath(component.deviceRef.path) : undefined;
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { "Dispositivo LasecSimul": ["lsdevice"] },
    title: `Selecionar Device para ${component.label}`,
    defaultUri: previous && fileExists(path.dirname(previous)) ? vscode.Uri.file(path.dirname(previous)) : undefined,
  });
  const selected = picked?.[0];
  if (!selected) return;
  if (await loadDeviceReference(componentId, selected.fsPath)) await rebuildCoreFromSchematicState();
}

/** Reidrata refs ao abrir projeto. Ausente/inválido permanece como placeholder com pinos conhecidos. */
async function resolveExternalDeviceReferences(projectDir: string): Promise<void> {
  const refs = [...state.schematicState.components].filter((component) => component.deviceRef);
  let failures = 0;
  let resolved = 0;
  for (const component of refs) {
    const absolutePath = normalizeAbsolutePath(projectDir, component.deviceRef!.path);
    if (!fileExists(absolutePath) || !(await loadDeviceReference(component.id, absolutePath, false))) {
      failures++;
      continue;
    }
    resolved++;
  }
  if (failures > 0) {
    const message = `${failures} Device(s) externo(s) ausente(s), inválido(s) ou incompatível(is). A instância foi preservada como placeholder.`;
    logSimulation("error", message, { stage: "device-externo" });
    vscode.window.showWarningMessage(message);
  }
  if (resolved > 0) syncSchematicPanel();
}

function deviceReferenceKey(filePath: string): string {
  const normalized = path.normalize(filePath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function reloadChangedDeviceReferences(absolutePath: string): Promise<void> {
  const key = deviceReferenceKey(absolutePath);
  const referenced = state.schematicState.components.filter((component) =>
    component.deviceRef && deviceReferenceKey(absoluteDeviceRefPath(component.deviceRef.path)) === key);
  if (referenced.length === 0) return;

  let loaded = false;
  let failed = !fileExists(absolutePath);
  if (!failed) {
    for (const component of referenced) {
      if (await loadDeviceReference(component.id, absolutePath, false)) loaded = true;
      else failed = true;
    }
  }
  if (failed) {
    state.schematicState = {
      ...state.schematicState,
      catalog: state.schematicState.catalog.filter((entry) =>
        !entry.externalReferencePath || deviceReferenceKey(entry.externalReferencePath) !== key),
    };
    const message = `Device externo alterado não pôde ser recarregado: ${absolutePath}. A instância foi preservada como placeholder.`;
    logSimulation("error", message, { stage: "device-externo" });
    vscode.window.showWarningMessage(message);
    syncSchematicPanel();
  }
  if (loaded || failed) await rebuildCoreFromSchematicState();
}

function scheduleDeviceReferenceReload(absolutePath: string): void {
  const key = deviceReferenceKey(absolutePath);
  const previous = deviceReferenceReloadTimers.get(key);
  if (previous) clearTimeout(previous);
  deviceReferenceReloadTimers.set(key, setTimeout(() => {
    deviceReferenceReloadTimers.delete(key);
    void reloadChangedDeviceReferences(absolutePath);
  }, 300));
}

/** Mantém um watcher por arquivo referenciado; salvar/renomear/apagar o .lsdevice atualiza a instância. */
function reconcileDeviceReferenceWatchers(): void {
  if (!state.extensionContext) return;
  const desired = new Map<string, string>();
  for (const component of state.schematicState.components) {
    if (!component.deviceRef?.path) continue;
    const absolutePath = absoluteDeviceRefPath(component.deviceRef.path);
    desired.set(deviceReferenceKey(absolutePath), absolutePath);
  }
  for (const [key, watcher] of deviceReferenceWatchers) {
    if (desired.has(key)) continue;
    watcher.dispose();
    deviceReferenceWatchers.delete(key);
  }
  for (const [key, absolutePath] of desired) {
    if (deviceReferenceWatchers.has(key) || !fileExists(path.dirname(absolutePath))) continue;
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(absolutePath), path.basename(absolutePath)));
    watcher.onDidChange(() => scheduleDeviceReferenceReload(absolutePath));
    watcher.onDidCreate(() => scheduleDeviceReferenceReload(absolutePath));
    watcher.onDidDelete(() => scheduleDeviceReferenceReload(absolutePath));
    deviceReferenceWatchers.set(key, watcher);
  }
}

function disposeDeviceReferenceWatchers(): void {
  for (const timer of deviceReferenceReloadTimers.values()) clearTimeout(timer);
  deviceReferenceReloadTimers.clear();
  for (const watcher of deviceReferenceWatchers.values()) watcher.dispose();
  deviceReferenceWatchers.clear();
}

/** Editor de propriedade `filePath` GENÉRICO (Estágio 1 da autoria de Package/ícone dentro de "Abrir
 * Subcircuito", `.spec/lasecsimul.spec`) -- ao contrário de `chooseSubcircuitFileCommand` (nunca
 * grava em `properties`, troca typeId/pinos/package inteiros da instância), este comando só lê o
 * arquivo escolhido e grava em `component.properties[propertyKey]`. Quando o campo é
 * `graphics.image.path`, também resolve `imageData`/`imageMime` (base64, mesmo padrão de
 * `packageSanitizers.ts::sanitizePackageBackground`) pra renderização real na Webview
 * (`componentSymbols.ts`) -- sem isso a imagem escolhida nunca apareceria no canvas, só o caminho
 * cru guardado. */
async function chooseFilePropertyCommand(componentId: string, propertyKey: string): Promise<void> {
  const ref = getElement(state.schematicState, componentId);
  if (!ref) return;
  const component = ref.element;

  const isImagePath = component.typeId === "graphics.image" && propertyKey === "path";
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: isImagePath ? { Imagem: ["png", "jpg", "jpeg", "svg"] } : { "Todos os arquivos": ["*"] },
    title: `Selecionar arquivo para ${component.label}`,
  });
  const selected = picked?.[0];
  if (!selected) return;
  const absolutePath = selected.fsPath;

  const updatedProperties: Record<string, string | number | boolean> = { ...component.properties, [propertyKey]: absolutePath };
  if (isImagePath) {
    try {
      updatedProperties.imageData = fs.readFileSync(absolutePath).toString("base64");
      updatedProperties.imageMime = imageMimeForFile(absolutePath);
    } catch (err) {
      vscode.window.showErrorMessage(`Não foi possível ler ${absolutePath}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
  }

  const updated = updateElement(state.schematicState, componentId, { properties: updatedProperties });
  if (!updated.ok) return;
  state.schematicState = updated.value.state;
  // Core só existe pro circuito interno real -- Símbolo/Ícone nunca sincronizam.
  if (ref.scope === "schematic") pushPropertyToCore(componentId, propertyKey, absolutePath);
  syncSchematicPanel();
}

/** `pinIds` (quando presente) é o contrato elétrico REAL na ordem que o Core espera -- plugins usam
 * o id enviado aqui diretamente (`NativeDeviceProxy`/`McuComponent`, ver `CoreApplication.cpp`,
 * `addComponent`), nunca um `pin-N` genérico sem relação com nada real. Sem `pinIds` (built-ins sem
 * schema próprio), mantém o numerador genérico de sempre. Ver `model.ts::
 * WebviewComponentCatalogEntry.pinIds`.
 *
 * `properties`: quando o `package.dynamicLayout.pinGroups` do typeId existe (ex: `switches.keypad`,
 * TR-9), o número/id REAL de pinos depende da INSTÂNCIA (`rows`/`columns`), não só do typeId -- usa
 * `materializePinGroup` (mesma fórmula do desenho em `componentSymbols.ts`, nunca duplicada aqui) com
 * as propriedades atuais. Sem `properties` (chamador não tem a instância ainda, ex: seed de
 * componente interno de autoria), cai em `descriptor.defaultProperties` -- produz exatamente os
 * `pinIds` estáticos já cadastrados no catálogo pro caso default, sem regressão pros chamadores que
 * não foram atualizados pra passar a instância real. */
export function pinsForTypeId(typeId: string, properties?: Record<string, unknown>): Array<{ id: string; x: number; y: number }> {
  const descriptor = state.schematicState.catalog.find((item) => item.typeId === typeId);
  const dynamicGroups = descriptor?.package?.dynamicLayout?.pinGroups;
  if (dynamicGroups && dynamicGroups.length > 0) {
    const effectiveProperties = properties ?? descriptor?.defaultProperties ?? {};
    const replacePins = descriptor?.package?.dynamicLayout?.replacePins ?? false;
    const staticPins = replacePins ? [] : (descriptor?.package?.pins ?? []);
    const combined = [
      ...staticPins.map((pin) => ({ id: pin.id })),
      ...dynamicGroups.flatMap((group) => materializePinGroup(group, effectiveProperties).map((pin) => ({ id: pin.id }))),
    ];
    if (combined.length > 0) return combined.map((pin, index) => ({ id: pin.id, x: 0, y: index * 12 }));
  }
  const pinCount = descriptor?.pinCount ?? 2;
  if (descriptor?.pinIds && descriptor.pinIds.length === pinCount) {
    return descriptor.pinIds.map((id, index) => ({ id, x: 0, y: index * 12 }));
  }
  return Array.from({ length: pinCount }, (_, index) => ({ id: `pin-${index + 1}`, x: 0, y: index * 12 }));
}

function sameWireEndpoints(a: WebviewWireModel, b: WebviewWireModel): boolean {
  return endpointId(a.from) === endpointId(b.from)
    && endpointPinId(a.from) === endpointPinId(b.from)
    && endpointId(a.to) === endpointId(b.to)
    && endpointPinId(a.to) === endpointPinId(b.to);
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
  const previousWiresById = new Map(previous.topology.conductors.map((wire) => [wire.id, wire]));
  const nextWiresById = new Map(next.topology.conductors.map((wire) => [wire.id, wire]));
  const componentSetChanged = previous.components.some((component) => !nextComponentsById.has(component.id)) ||
    next.components.some((component) => !previousComponentsById.has(component.id));
  // Só CONECTIVIDADE (endpoints + quais nós existem), nunca geometria (`points`) -- arrastar um
  // cotovelo de fio não deveria disparar nenhuma sincronização com o Core (ele não conhece rota
  // visual). Comparar `topology` inteiro (com `points`) faria uma edição puramente visual entrar no
  // branch de baixo à toa.
  const connectivityKey = (topology: WebviewProjectState["topology"]) =>
    JSON.stringify([topology.nodes, topology.conductors.map((wire) => ({ id: wire.id, from: wire.from, to: wire.to }))]);
  const geometricTopologyChanged = connectivityKey(previous.topology) !== connectivityKey(next.topology);

  // A projeção elétrica de uma rede com nós não tem correspondência 1:1 com os condutores
  // geométricos -- um wire pode apontar pra um nó de topologia, que o Core nunca viu. Quando só a
  // topologia mexeu (nenhum componente entrou/saiu), achata os dois lados (antes/depois) em arestas
  // de pino real (`electricalEdgesForProject`, mesma função usada no rebuild completo) e manda só a
  // DIFERENÇA como uma transação atômica -- o diff fica naturalmente restrito à(s) rede(s) tocada(s)
  // pela edição, nunca ao projeto inteiro (`.spec` seção 25.1). Rebuild completo vira exceção
  // (componente adicionado/removido, que exige registrar/desregistrar instância mesmo), não mais o
  // caminho default de qualquer edição de fio.
  if (componentSetChanged) {
    await queueCoreRebuild();
    if (state.simulationStatus === "running") {
      void pollInstrumentReadouts();
      void pollWireVoltages();
    }
    return;
  }
  if (geometricTopologyChanged) {
    const operations = electricalOperationsDiff(previous.topology.conductors, previous.topology.nodes, next.topology.conductors, next.topology.nodes);
    if (operations.length > 0) {
      const applied = await pushWireTopologyTransaction(operations);
      if (!applied) await queueCoreRebuild();
    }
    if (state.simulationStatus === "running") {
      void pollInstrumentReadouts();
      void pollWireVoltages();
    }
    return;
  }

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

  for (const previousWire of previous.topology.conductors) {
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
        const pinId = component.pins[0]?.id ?? "pin";
        pushTunnelNameToCore(component.id, pinId, String(before.properties[name] ?? ""), String(value));
      } else {
        pushPropertyToCore(component.id, name, value);
      }
    }
  }

  const addedOrChangedWires = next.topology.conductors.filter((wire) => {
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
      const topologyChanged = JSON.stringify([previous.components, previous.topology]) !==
        JSON.stringify([message.project.components, message.project.topology]);
      state.schematicState = topologyChanged
        ? { ...message.project, topology: { ...message.project.topology, revision: previous.topology.revision + 1 } }
        : { ...message.project, topology: { ...message.project.topology, revision: previous.topology.revision } };
      enqueueProjectSnapshotSync(previous, state.schematicState);
      if (topologyChanged) syncSchematicPanel();
      return;
    }
    case "requestAddComponent": {
      // Junção só pode nascer automaticamente de uma divisão real de fio (ver `wireTopology.ts`
      // `splitSegmentAtPoint`) -- nunca colocável manualmente, mesmo que uma mensagem IPC tente
      // forçar isso (defesa em profundidade; a paleta já filtra por `hidden:true` no catálogo).
      if (message.typeId === JUNCTION_TYPE_ID) return;
      const descriptor = state.schematicState.catalog.find((item) => item.typeId === message.typeId);
      const componentId = nextId("component");
      const pins = pinsForTypeId(message.typeId, descriptor?.defaultProperties);
      const baseLabel = descriptor?.label ?? message.typeId;
      const component: WebviewComponentModel = {
        id: componentId,
        typeId: message.typeId,
        label: nextIndexedLabel(message.typeId, baseLabel, state.schematicState.components),
        hidden: descriptor?.hidden ?? false,
        showValue: hasShowOnSymbolProperty(descriptor),
        showDialValue: false,
        x: 140 + state.schematicState.components.length * 24,
        y: 140 + state.schematicState.components.length * 24,
        rotation: 0,
        pins,
        properties: { ...(descriptor?.defaultProperties ?? {}) },
      };
      void (async () => {
        // Só aguarda confirmação do Core quando ele de fato vai tentar sincronizar este componente
        // -- um componente sem pino elétrico (decorativo) ou sem Core conectado nunca tenta push, e
        // não deve ficar bloqueado esperando por algo que nunca aconteceria (`shouldSyncComponentToCore`).
        const willSync = Boolean(state.coreClient) && shouldSyncComponentToCore(message.typeId);
        if (willSync) {
          const ok = await pushComponentToCore(componentId, component.typeId, component.properties, component.pins);
          if (!ok) return; // Core recusou/falhou -- a tela nunca chega a mostrar um componente que o Core não tem.
        }
        state.schematicState = {
          ...state.schematicState,
          components: [...state.schematicState.components, component],
          selectedComponentIds: [componentId],
          selectedWireIds: [],
        };
        syncSchematicPanel();
      })();
      return;
    }
    case "requestInsertItems": {
      if (message.scope !== "schematic") {
        // Símbolo/Ícone nunca têm fios/topologia nem presença no Core -- só insere os elementos
        // (pino/forma) no escopo certo, nunca no circuito interno real.
        const inserted = insertElements(state.schematicState, message.scope, message.components);
        state.schematicState = { ...inserted.state, selectedComponentIds: inserted.inserted.map((component) => component.id), selectedWireIds: [] };
        syncSchematicPanel();
        return;
      }

      const existingWireIds = new Set(state.schematicState.topology.conductors.map((wire) => wire.id));
      const inserted = insertElements(state.schematicState, "schematic", message.components);
      const insertedComponentIds = new Set(inserted.inserted.map((component) => component.id));
      const existingComponentIds = new Set(state.schematicState.components.map((component) => component.id));
      const wires = message.wires.filter((wire) =>
        !existingWireIds.has(wire.id) &&
        (existingComponentIds.has(endpointId(wire.from)) || insertedComponentIds.has(endpointId(wire.from))) &&
        (existingComponentIds.has(endpointId(wire.to)) || insertedComponentIds.has(endpointId(wire.to)))
      );

      state.schematicState = {
        ...inserted.state,
        topology: { ...state.schematicState.topology, conductors: [...state.schematicState.topology.conductors, ...wires] },
        selectedComponentIds: inserted.inserted.map((component) => component.id),
        selectedWireIds: wires.map((wire) => wire.id),
      };
      void (async () => {
        for (const component of inserted.inserted) await pushComponentToCore(component.id, component.typeId, component.properties, component.pins);
        for (const wire of wires) await pushWireToCore(wire);
      })();
      syncSchematicPanel();
      return;
    }
    case "requestRemoveComponent": {
      // Ponto único de leitura/mutação por id (`schematicModel.ts`) -- decide sozinho em qual escopo
      // (circuito interno/Símbolo/Ícone) o elemento vive, aplica a cascata certa pra sua categoria
      // (pino remove seus túneis; túnel-único-de-um-pino é bloqueado), nunca reimplementado aqui.
      const removal = removeElement(state.schematicState, message.componentId);
      if (!removal.ok) {
        // "Elemento inexistente" nunca é reportado como erro pro usuário (pode ser uma corrida
        // benigna -- já removido por outra ação); o bloqueio do túnel-único É reportado.
        if (removal.error.includes("única ligação interna")) {
          void vscode.window.showWarningMessage(removal.error, { modal: true });
        }
        return;
      }
      if (removal.value.ref.scope !== "schematic") {
        // Símbolo/Ícone nunca tocam Core/topologia -- efeito colateral nenhum além de aplicar a
        // remoção (já cascateada) e sincronizar.
        state.schematicState = removal.value.state;
        syncSchematicPanel();
        return;
      }

      closeMcuSerialMonitor(message.componentId);
      pushRemoveToCore(message.componentId); // remove a instância; Netlist::removeComponent já desconecta os fios dela no Core
      coreInstanceIdByComponentId.delete(message.componentId);
      mcuTargetCoreIdByComponentId.delete(message.componentId);
      const previousWires = state.schematicState.topology.conductors;
      const previousNodes = state.schematicState.topology.nodes;
      const afterRemoval = {
        components: removal.value.state.components,
        wires: previousWires.filter((wire) => endpointId(wire.from) !== message.componentId && endpointId(wire.to) !== message.componentId),
      };
      // Apagar um componente pode derrubar o grau de um nó de topologia que ele tocava (ou de um
      // encadeado além dele) pra <=2 -- `removeOrphanNodes` cascateia a limpeza/colapso pra nunca
      // deixar uma "bola laranja" órfã presa no esquemático (ver `.spec` seção 24/25).
      const normalized = normalizeWireGeometry({ components: afterRemoval.components, wires: afterRemoval.wires, nodes: previousNodes });
      // Valida antes de commitar -- defesa em profundidade contra um bug futuro em
      // `normalizeWireGeometry`/`removeOrphanNodes` deixar referência órfã (`.spec` seção 25.3); o
      // componente já foi removido no Core acima independentemente do resultado desta checagem.
      try {
        assertTopologyInvariants(
          { revision: state.schematicState.topology.revision, nodes: normalized.nodes, conductors: normalized.wires },
          new Set(normalized.components.map((component) => component.id))
        );
      } catch (err) {
        reportCoreWarning("validar topologia após remoção de componente", err);
      }
      const survivingWireIds = new Set(normalized.wires.map((wire) => wire.id));
      state.schematicState = {
        ...state.schematicState,
        components: normalized.components,
        exposedComponents: removal.value.state.exposedComponents,
        exportedPropertyComponentIds: removal.value.state.exportedPropertyComponentIds,
        topology: { ...state.schematicState.topology, nodes: normalized.nodes, conductors: normalized.wires },
        selectedComponentIds: state.schematicState.selectedComponentIds.filter((id) => id !== message.componentId),
        selectedWireIds: state.schematicState.selectedWireIds.filter((id) => survivingWireIds.has(id)),
        pendingConnection:
          state.schematicState.pendingConnection?.kind !== "wire" &&
          state.schematicState.pendingConnection?.componentId === message.componentId
            ? undefined
            : state.schematicState.pendingConnection,
      };
      syncSchematicPanel();
      // Achata ANTES ("depois de tirar os fios do componente removido, antes do colapso de cascata")
      // e DEPOIS (já normalizado) e manda só a diferença -- nunca inclui aresta tocando o componente
      // removido (o Core já não tem mais essa instância pra resolver `componentId`, ver EX-F).
      const operations = electricalOperationsDiff(afterRemoval.wires, previousNodes, normalized.wires, normalized.nodes);
      if (operations.length > 0) {
        void pushWireTopologyTransaction(operations).then((applied) => (applied ? undefined : queueCoreRebuild())).then(() => {
          if (state.simulationStatus === "running") {
            void pollInstrumentReadouts();
            void pollWireVoltages();
          }
        });
      } else if (state.simulationStatus === "running") {
        void pollWireVoltages();
      }
      return;
    }
    case "requestRemoveWire": {
      const removedWire = state.schematicState.topology.conductors.find((wire) => wire.id === message.wireId);
      const previousWires = state.schematicState.topology.conductors;
      const previousNodes = state.schematicState.topology.nodes;
      const afterRemoval = {
        components: state.schematicState.components,
        wires: previousWires.filter((wire) => wire.id !== message.wireId),
      };
      const normalized = normalizeWireGeometry({ components: afterRemoval.components, wires: afterRemoval.wires, nodes: previousNodes });
      try {
        assertTopologyInvariants(
          { revision: state.schematicState.topology.revision, nodes: normalized.nodes, conductors: normalized.wires },
          new Set(normalized.components.map((component) => component.id))
        );
      } catch (err) {
        reportCoreWarning("validar topologia após remoção de fio", err);
      }
      const survivingWireIds = new Set(normalized.wires.map((wire) => wire.id));
      state.schematicState = {
        ...state.schematicState,
        components: normalized.components,
        topology: { ...state.schematicState.topology, nodes: normalized.nodes, conductors: normalized.wires },
        selectedWireIds: state.schematicState.selectedWireIds.filter((id) => survivingWireIds.has(id)),
      };
      syncSchematicPanel();
      const operations = electricalOperationsDiff(previousWires, previousNodes, normalized.wires, normalized.nodes);
      if (operations.length > 0) {
        void pushWireTopologyTransaction(operations).then((applied) => (applied ? undefined : queueCoreRebuild())).then(() => {
          if (state.simulationStatus === "running") {
            void pollInstrumentReadouts();
            void pollWireVoltages();
          }
        });
      } else {
        pushRemoveWireToCore(removedWire);
        if (state.simulationStatus === "running") {
          void pollInstrumentReadouts();
          void pollWireVoltages();
        }
      }
      return;
    }
    case "requestConnectEndpoints": {
      const currentRevision = state.schematicState.topology.revision;
      if (message.baseRevision !== currentRevision) {
        // O cliente trabalhou sobre uma projeção antiga. Não tenta mesclar geometria por heurística:
        // republica a revisão canônica e deixa o usuário repetir o gesto sobre o estado atual.
        state.schematicPanel?.postMessage({ version: 1, type: "syncState", project: state.schematicState });
        return;
      }
      let connected;
      try {
        connected = connectEndpointToNode(
          { components: state.schematicState.components, wires: state.schematicState.topology.conductors, nodes: state.schematicState.topology.nodes },
          message.from,
          message.to,
          message.points,
          {
            newWireId: nextId("wire"),
            nextJunctionId: () => nextId("junction"),
            nextWireId: () => nextId("wire"),
          }
        );
      } catch (err) {
        reportCoreWarning("conectar extremos do fio", err);
        return;
      }
      const replaced = new Set(connected.replacedWireIds);
      const nextTopology: CanonicalTopologyDocument = {
        revision: currentRevision + 1,
        nodes: [...state.schematicState.topology.nodes, ...connected.newNodes],
        conductors: [...state.schematicState.topology.conductors.filter((wire) => !replaced.has(wire.id)), ...connected.newWires],
      };
      const nextState: WebviewProjectState = {
        ...state.schematicState,
        topology: nextTopology,
        selectedComponentIds: [],
        selectedWireIds: connected.newWires.length > 0 ? [connected.newWires[connected.newWires.length - 1]!.id] : [],
        pendingConnection: undefined,
      };
      try {
        // Valida ANTES de aceitar a mutação -- nó/condutor duplicado, endpoint órfão, condutor de
        // comprimento topológico zero -- em vez de só na borda de save/load (`.spec` seção 25.3).
        assertTopologyInvariants(nextTopology, new Set(nextState.components.map((component) => component.id)));
      } catch (err) {
        reportCoreWarning("validar topologia resultante", err);
        return;
      }
      void (async () => {
        // Publica a revisão visual somente depois de o Core confirmar a transação. Isso evita expor
        // a sequência intermediária junction/metades/ramo dos verbos antigos. Este verbo nunca muda o
        // CONJUNTO de componentes (só fios/nós de topologia) -- o diff achatado (EX-F) sempre cabe
        // numa única transação atômica; `queueCoreRebuild()` fica reservado pra quando a transação é
        // rejeitada (conflito de revisão, endpoint que ainda não resolveu no Core, etc.), não mais
        // pro caminho feliz.
        const previous = state.schematicState;
        const operations = electricalOperationsDiff(previous.topology.conductors, previous.topology.nodes, nextTopology.conductors, nextTopology.nodes);
        state.schematicState = nextState;
        try {
          const applied = operations.length === 0 ? true : await pushWireTopologyTransaction(operations);
          if (!applied) await queueCoreRebuild();
          syncSchematicPanel();
          if (state.simulationStatus === "running") {
            void pollInstrumentReadouts();
            void pollWireVoltages();
          }
        } catch (err) {
          state.schematicState = previous;
          // A transação (ou o rebuild de fallback) pode ter falhado depois de mexer em parte do
          // estado anterior no Core. Restaura o estado canônico e agenda uma segunda reconstrução
          // best-effort antes de voltar a aceitar mutações subsequentes.
          void queueCoreRebuild();
          reportCoreWarning("aplicar transação de fio", err);
        }
      })();
      return;
    }
    case "requestRotateComponent": {
      const updated = updateElement(state.schematicState, message.componentId, { rotation: message.rotation });
      if (!updated.ok) return;
      state.schematicState = updated.value.state;
      syncSchematicPanel();
      return;
    }
    case "requestFlipComponent": {
      const updated = updateElement(state.schematicState, message.componentId, { flipH: message.flipH, flipV: message.flipV });
      if (!updated.ok) return;
      state.schematicState = updated.value.state;
      syncSchematicPanel();
      return;
    }
    case "requestRenameComponent": {
      const current = getElement(state.schematicState, message.componentId);
      const isLasecPlot = current?.element.typeId === "peripherals.lasecplot";
      const updated = updateElement(state.schematicState, message.componentId, {
        label: message.label,
        ...(isLasecPlot ? { properties: { ...current!.element.properties, source_name: message.label } } : {}),
      });
      if (!updated.ok) return;
      state.schematicState = updated.value.state;
      if (isLasecPlot) pushPropertyToCore(message.componentId, "source_name", message.label);
      lasecPlotManager?.sync();
      syncSchematicPanel();
      return;
    }
    case "requestUpdateLabelVisibility": {
      // Puramente visual -- nunca toca o Core (ver `.spec/lasecsimul.spec` seção 6.1.2: visibilidade
      // de rótulo não é uma propriedade elétrica, não tem schema de plugin/built-in nenhum).
      const updated = updateElement(state.schematicState, message.componentId, {
        showId: message.showId,
        showValue: message.showValue,
        showDialValue: message.showDialValue ?? false,
        ...(message.valueLabelPropertyKey !== undefined ? { valueLabelPropertyKey: message.valueLabelPropertyKey } : {}),
      });
      if (!updated.ok) return;
      state.schematicState = updated.value.state;
      syncSchematicPanel();
      return;
    }
    case "requestUpdateProperty": {
      const ref = getElement(state.schematicState, message.componentId);
      if (!ref) return;
      const prevComponent = ref.element;
      if (prevComponent.typeId === "peripherals.lasecplot" && message.name === "source_name" && !String(message.value).trim()) {
        vscode.window.showErrorMessage("LasecPlot: Nome da fonte não pode ficar vazio.");
        syncSchematicPanel();
        return;
      }
      const updatedProperties = { ...prevComponent.properties, [message.name]: message.value };

      if (ref.scope !== "schematic") {
        // Símbolo/Ícone (pino/forma) nunca têm `affectsPinCount`/Core/túnel -- só a propriedade em
        // si muda (ex: reordenar z-order via PACKAGE_SHAPE_ORDER_PROPERTY_KEY, ou qualquer campo do
        // painel de Propriedades pra um `symbol.pin`/`graphics.*`).
        const updated = updateElement(state.schematicState, message.componentId, { properties: updatedProperties });
        if (updated.ok) state.schematicState = updated.value.state;
        syncSchematicPanel();
        return;
      }

      // Propriedade `affectsPinCount` (ex: rows/columns do switches.keypad, TR-9): o número de
      // pinos da instância pode ter mudado -- recalcula via a MESMA fórmula que o Core usa
      // (`pinsForTypeId`, dynamicLayout.pinGroups), reconcilia `component.pins[]` e derruba
      // qualquer fio que apontava pra um pino que deixou de existir. O Core faz a MESMA
      // reconciliação do lado dele sozinho (`SimulationSession::setProperty` ->
      // `reregisterComponentPins`, disparado pelo `pushPropertyToCore` abaixo) -- não é preciso
      // mandar `disconnectWire` explícito pra esses fios, já saem do Netlist junto.
      const catalogEntry = state.schematicState.catalog.find((item) => item.typeId === prevComponent.typeId);
      const affectsPinCount = catalogEntry?.propertySchema?.find((schema) => schema.id === message.name)?.affectsPinCount ?? false;
      const newPins = affectsPinCount ? pinsForTypeId(prevComponent.typeId, updatedProperties) : undefined;
      const newPinIds = newPins ? new Set(newPins.map((pin) => pin.id)) : undefined;

      const nextWires = newPinIds
        ? state.schematicState.topology.conductors.filter((wire) => {
            const touchesRemovedPin =
              (endpointId(wire.from) === message.componentId && !newPinIds.has(endpointPinId(wire.from))) ||
              (endpointId(wire.to) === message.componentId && !newPinIds.has(endpointPinId(wire.to)));
            return !touchesRemovedPin;
          })
        : state.schematicState.topology.conductors;

      const synchronizedSourceName = prevComponent.typeId === "peripherals.lasecplot" && message.name === "source_name"
        ? String(message.value).trim()
        : undefined;
      const updated = updateElement(state.schematicState, message.componentId, {
        properties: updatedProperties,
        ...(synchronizedSourceName ? { label: synchronizedSourceName } : {}),
        ...(newPins ? { pins: newPins } : {}),
      });
      if (!updated.ok) return;
      state.schematicState = {
        ...updated.value.state,
        topology: { ...updated.value.state.topology, conductors: nextWires },
        selectedWireIds:
          nextWires === state.schematicState.topology.conductors
            ? state.schematicState.selectedWireIds
            : state.schematicState.selectedWireIds.filter((id) => nextWires.some((wire) => wire.id === id)),
      };
      // Túnel: nome precisa de setTunnelName (rebuilda topologia do Netlist), não setProperty.
      if (message.name === "name" && prevComponent.typeId === TUNNEL_TYPE_ID) {
        const pinId = prevComponent.pins[0]?.id ?? "pin";
        const oldName = String(prevComponent.properties["name"] ?? "");
        pushTunnelNameToCore(message.componentId, pinId, oldName, String(message.value));
      } else {
        pushPropertyToCore(message.componentId, message.name, message.value);
      }
      syncSchematicPanel();
      lasecPlotManager?.sync();
      if (state.simulationStatus === "running") {
        void pollInstrumentReadouts();
        void pollWireVoltages();
      }
      return;
    }
    case "requestPreviewProperty": {
      // Pointermove de dial/encoder: efeito elétrico ao vivo, sem mutar o documento nem devolver
      // `syncStatePatch`. O pointerup envia um único `requestUpdateProperty` persistente.
      previewPropertyInCore(message.componentId, message.name, message.value);
      return;
    }
    case "requestToggleLasecPlot": {
      // Diagnóstico (achado 2026-07-18: "Abrir não faz nada visível") -- roteia cada etapa pro canal
      // "LasecSimul: Simulação" (`lasecsimul.showSimulationLog`), pra distinguir "o clique nem chegou
      // aqui" de "chegou, mas o toggle() falhou" de "publicou certo, o problema é no consumidor
      // externo" sem precisar de DevTools. `logSimulation("error", ...)` já mostra o toast nativo
      // sozinho (nível "error" notifica por padrão) -- não duplica o `showErrorMessage` manual de antes.
      const targetComponent = state.schematicState.components.find((c) => c.id === message.componentId);
      const deviceLabel = targetComponent?.label ?? message.componentId;
      if (!lasecPlotManager) {
        logSimulation("error", "Clique em Abrir/Fechar ignorado: o gerenciador do LasecPlot ainda não foi inicializado nesta janela.", { device: deviceLabel, stage: "lasecplot-abrir" });
        return;
      }
      logSimulation("info", "Abrir/Fechar clicado -- chamando LasecPlotBroker.toggle()...", { device: deviceLabel, stage: "lasecplot-abrir" });
      void lasecPlotManager.toggle(message.componentId).then((result) => {
        logSimulation("info", `toggle() concluído: aberto=${result.opened}, clientes=${result.clients}.`, { device: deviceLabel, stage: "lasecplot-abrir" });
        state.schematicPanel?.postMessage({ version: 1, type: "lasecPlotStatus", componentId: message.componentId, ...result });
      }).catch((error) => {
        const text = error instanceof Error ? error.message : String(error);
        logSimulation("error", text, { device: deviceLabel, stage: "lasecplot-abrir" });
        state.schematicPanel?.postMessage({ version: 1, type: "lasecPlotStatus", componentId: message.componentId, opened: false, clients: 0, error: text });
      });
      return;
    }
    case "requestToggleSerialTerminal": {
      try { serialTerminalManager?.toggle(message.componentId); }
      catch (error) { vscode.window.showErrorMessage(`Serial Terminal: ${error instanceof Error ? error.message : String(error)}`); }
      return;
    }
    case "requestSerialTerminalWrite": {
      void serialTerminalManager?.write(message.componentId, Uint8Array.from(Buffer.from(message.dataHex, "hex")))
        .catch((error) => vscode.window.showErrorMessage(`Serial Terminal: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    case "requestSerialTerminalLoadFile":
      void serialTerminalManager?.loadFile(message.componentId);
      return;
    case "requestSerialTerminalSaveLog":
      void serialTerminalManager?.saveLog(message.text);
      return;
    case "requestToggleSerialPort":
      void serialPortManager?.toggle(message.componentId).catch((error) =>
        vscode.window.showErrorMessage(`Serial Port: ${error instanceof Error ? error.message : String(error)}`));
      return;
    case "requestChooseSubcircuitFile":
      void chooseSubcircuitFileCommand(message.componentId);
      return;
    case "requestChooseDeviceFile":
      void chooseDeviceFileCommand(message.componentId);
      return;
    case "requestChooseFile":
      void chooseFilePropertyCommand(message.componentId, message.propertyKey);
      return;
    case "requestOpenExternal":
      void vscode.env.openExternal(vscode.Uri.parse(message.url));
      return;
    case "requestRunSimulation":
      void runSimulationWithFirmwareCheck();
      return;
    case "requestPauseSimulation":
      pauseSimulation();
      return;
    case "requestSetPauseCondition":
      void state.coreClient?.setPauseCondition(message.componentId, message.expression)
        .then(() => state.schematicPanel?.postMessage({ version: 1, type: "pauseConditionValidation", componentId: message.componentId, valid: true }))
        .catch((err) => state.schematicPanel?.postMessage({ version: 1, type: "pauseConditionValidation", componentId: message.componentId, valid: false, error: err instanceof Error ? err.message : String(err), column: err instanceof IpcError ? err.column : undefined }));
      return;
    case "requestStopSimulation":
      stopSimulation();
      return;
    case "requestSaveProject":
      void saveProjectCommand();
      return;
    case "requestSaveProjectAs":
      void saveProjectAsCommand();
      return;
    case "requestOpenProject":
      if (state.extensionContext) {
        void openProjectCommand({
          extensionUri: state.extensionContext.extensionUri,
          beforeOpen: closeAllMcuSerialMonitors,
          resolveExternalDeviceReferences,
          openSchematicEditor,
          syncSchematicPanel,
        });
      }
      return;
    case "requestImportCircuit":
      void importProjectCommand({ syncSchematicPanel });
      return;
    case "requestChooseMcuFirmware":
      void chooseMcuFirmwareCommand(message.componentId, mcuCommandOptions());
      return;
    case "requestChooseExposedMcuFirmware":
      void chooseExposedMcuFirmwareCommand(message.outerComponentId, message.innerComponentId, mcuCommandOptions());
      return;
    case "requestOpenMcuSerialMonitor":
      openMcuSerialMonitorCommand(message.componentId, message.usartIndex);
      return;
    case "requestOpenExposedMcuSerialMonitor":
      void openExposedMcuSerialMonitorCommand(message.outerComponentId, message.innerComponentId, message.usartIndex, mcuCommandOptions());
      return;
    case "requestCloseMcuSerialMonitor":
      closeMcuSerialMonitorByKey(message.key);
      return;
    case "requestExportInstrumentData":
      void exportInstrumentDataCommand(message.suggestedFileName, message.csvContent);
      return;
    case "requestInstrumentHistory":
      void sendInstrumentHistory(message.componentId);
      return;
    case "requestUpdateBoardOverlayProperty":
      updateBoardOverlayPropertyCommand(message.outerComponentId, message.innerComponentId, message.name, message.value, mcuCommandOptions());
      return;
    case "requestBoardOverlayData":
      void requestBoardOverlayDataCommand(message.componentId, message.sourceId, mcuCommandOptions());
      return;
    case "requestUpdateBoardOverlayVisual":
      void updateBoardOverlayVisualCommand(message.sourceId, message.innerComponentId, message.x, message.y, mcuCommandOptions());
      return;
    case "requestUpdateExposedComponentProperty":
      void updateExposedComponentPropertyCommand(message.outerComponentId, message.sourceId, message.innerComponentId, message.name, message.value, mcuCommandOptions());
      return;
    case "requestCreateSubcircuitFromSelection":
      void createSubcircuitFromSelectionHandler(message.componentIds);
      return;
    case "requestOpenSubcircuit":
      void openSubcircuitForEditingCommand(message.sourceId);
      return;
    case "requestCloseSubcircuitEditor":
      void closeSubcircuitEditorCommand();
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
  const allWires = state.schematicState.topology.conductors;
  const internalWires: WebviewWireModel[] = [];
  const boundaryWires: WebviewWireModel[] = [];
  for (const wire of allWires) {
    const fromIn = selectedSet.has(endpointId(wire.from));
    const toIn = selectedSet.has(endpointId(wire.to));
    if (fromIn && toIn) internalWires.push(wire);
    else if (fromIn || toIn) boundaryWires.push(wire);
  }

  // 4. Bounding box dos componentes selecionados
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of selectedComponents) {
    if (c.x < minX) minX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.x > maxX) maxX = c.x;
    if (c.y > maxY) maxY = c.y;
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
    const fromIn = selectedSet.has(endpointId(wire.from));
    return {
      id: `tunnel_${pinName.toLowerCase()}`,
      name: pinName,
      x: minX - 64,
      y: minY + i * 16,
      internalComponentId: fromIn ? endpointId(wire.from) : endpointId(wire.to),
      internalPinId: fromIn ? endpointPinId(wire.from) : endpointPinId(wire.to),
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
    from: { componentId: endpointId(w.from), pinId: endpointPinId(w.from) },
    to: { componentId: endpointId(w.to), pinId: endpointPinId(w.to) },
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
    schemaVersion: SUBCIRCUIT_SCHEMA_VERSION,
    typeId,
    name: baseName,
    language: "pt-BR",
    components: [...internalCompObjects, ...tunnelCompObjects],
    topology: {
      revision: 0,
      nodes: [],
      conductors: [...internalWireObjects, ...stubWireObjects].map((wire, index) => ({
        id: `wire-${index + 1}`,
        from: { kind: "port", ...wire.from },
        to: { kind: "port", ...wire.to },
        vertices: "points" in wire ? wire.points ?? [] : [],
      })),
    },
    interface: interfaceEntries,
    // Símbolo/Ícone ainda não autorados nesta criação -- subcircuito novo abre direto em Modo
    // Subcircuito, sem nenhum pino externo visual ainda (`interface[]` acima é só o contrato do
    // Core; o desenho WYSIWYG do Símbolo é responsabilidade do usuário, Modo Símbolo).
    exposedComponents: [],
    exportedPropertyComponentIds: [],
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
      await state.coreClient.registerAdhocSubcircuitDefinition(normalizedPath);
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
  await refreshUnifiedCatalogState(false, catalogCommandOptions());

  // 9. Inserir instância do subcircuito no esquemático, no centro da bounding box
  const newCompId = nextId("component");
  const centerX = Math.round((minX + maxX) / 2);
  const centerY = Math.round((minY + maxY) / 2);
  const catalogEntry = state.schematicState.catalog.find((e) => e.typeId === typeId);
  const newPins = pinsForTypeId(typeId, catalogEntry?.defaultProperties);
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
    const externalEndpoint = t.isFromInside ? original.to : original.from;
    return {
      id: nextId("wire"),
      from: portEndpoint(newCompId, t.name),
      to: externalEndpoint,
    };
  });

  // 11. Remover componentes e fios selecionados do esquemático
  const removedWireIds = new Set(
    allWires.filter((w) => selectedSet.has(endpointId(w.from)) || selectedSet.has(endpointId(w.to))).map((w) => w.id)
  );
  state.schematicState = {
    ...state.schematicState,
    components: [...state.schematicState.components.filter((c) => !selectedSet.has(c.id)), newComponent],
    topology: { ...state.schematicState.topology, conductors: [...state.schematicState.topology.conductors.filter((w) => !removedWireIds.has(w.id)), ...newBoundaryWires] },
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

/** "Abrir Subcircuito" no menu de contexto de uma instância `subcircuit-file` -- troca `state.
 * schematicState` pelo circuito INTERNO do `.lssubcircuit` apontado por `sourceId`, empilhando o
 * circuito atual em `state.subcircuitEditingStack` pra restaurar depois (ver
 * `closeSubcircuitEditorCommand`). Diferente de "Abrir Projeto": nada é perdido/substituído em
 * disco, só trocado NA MEMÓRIA -- o circuito de fora fica intacto até "Voltar ao Circuito Principal".
 * `components`/`wires` do `.lssubcircuit` já usam o mesmo shape de campo (`visual.x/y/rotation/
 * flipH/flipV`) de `ProjectComponent`, então a conversão pra `WebviewComponentModel` espelha
 * `projectToWebviewState` (`projectCommands.ts`). */
async function openSubcircuitForEditingCommand(sourceId: string): Promise<void> {
  const filePath = resolveSourceFilePath(sourceId);
  if (!filePath || !fileExists(filePath)) {
    vscode.window.showWarningMessage("Arquivo do subcircuito não encontrado.");
    return;
  }

  let raw: unknown;
  try {
    raw = readJsonFile(filePath);
  } catch (err) {
    vscode.window.showErrorMessage(`Não foi possível ler ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // Gate de schemaVersion -- rejeita IMEDIATAMENTE um arquivo de versão antiga, antes de qualquer
  // outra leitura, nunca abre uma sessão parcial (ruptura de compatibilidade autorizada
  // explicitamente pelo pedido original: sem migração automática nesta etapa).
  const parsed = parseSubcircuitDocument(raw, path.dirname(filePath));
  if (!parsed.ok) {
    void vscode.window.showErrorMessage(parsed.reason, { modal: true });
    return;
  }
  const document = parsed.document;

  const internalComponents: WebviewComponentModel[] = document.components.map((component) => projectComponentToWebviewComponent(component, state.schematicState.catalog));
  const internalWires: WebviewWireModel[] = document.topology.conductors.map((conductor) => ({
    id: conductor.id,
    from: conductor.from,
    to: conductor.to,
    ...(conductor.vertices.length > 0 ? { points: conductor.vertices } : {}),
  }));
  // Autocorreção defensiva (junção órfã/duplicada, fio de comprimento zero) -- roda ANTES de virar a
  // baseline "não-alterada" da sessão (`initialComponents`/`initialWires`), pra um arquivo recém-
  // autocurado não abrir já marcado como sujo.
  const normalized = normalizeWireGeometry({ components: internalComponents, wires: internalWires, nodes: document.topology.nodes });

  const symbolAuthoringIdFactory = () => nextId("symauth");
  const symbolElements = materializeSymbolScene(document.symbol, symbolAuthoringIdFactory);
  const iconElements = materializeSymbolScene(document.icon, symbolAuthoringIdFactory);
  const symbolCanvas = document.symbol
    ? { width: document.symbol.width, height: document.symbol.height, border: document.symbol.border, background: document.symbol.background }
    : undefined;
  const iconCanvas = document.icon
    ? { width: document.icon.width, height: document.icon.height, border: document.icon.border, background: document.icon.background }
    : undefined;

  state.subcircuitEditingStack.push({
    sourceId,
    filePath,
    originalDocument: document,
    outerSchematicState: state.schematicState,
    outerProjectFilePath: state.currentProjectFilePath,
    initialComponents: normalized.components,
    initialWires: normalized.wires,
    initialTopologyNodes: normalized.nodes,
    initialSymbolElements: symbolElements,
    initialIconElements: iconElements,
    initialExposedComponents: document.exposedComponents,
    initialExportedPropertyComponentIds: document.exportedPropertyComponentIds,
  });

  state.schematicState = {
    ...state.schematicState,
    components: normalized.components,
    topology: { revision: document.topology.revision, nodes: normalized.nodes, conductors: normalized.wires },
    symbolElements,
    iconElements,
    symbolCanvas,
    iconCanvas,
    exposedComponents: document.exposedComponents,
    exportedPropertyComponentIds: document.exportedPropertyComponentIds,
    viewport: { x: 0, y: 0, zoom: 1 },
    selectedComponentIds: [],
    selectedWireIds: [],
    pendingConnection: undefined,
    subcircuitEditingContext: { sourceId, typeId: document.typeId, name: document.name },
  };
  syncSchematicPanel();
  await rebuildCoreFromSchematicState();
}

type SubcircuitEditingSession = (typeof state.subcircuitEditingStack)[number];

/** Mesmo princípio de `projectCommands.ts::isProjectDirty`, só que a "baseline" é o snapshot de
 * CADA cena logo após abrir a sessão (ver `openSubcircuitForEditingCommand`) em vez do último save
 * do `.lsproj`. Compara as 4 cenas independentes (circuito interno, Símbolo, Ícone, componentes
 * expostos) -- uma edição em QUALQUER uma delas torna a sessão suja, mesmo que as outras 3 nunca
 * tenham sido tocadas. */
function isSubcircuitEditingSessionDirty(session: SubcircuitEditingSession): boolean {
  const current = JSON.stringify({
    components: state.schematicState.components,
    wires: state.schematicState.topology.conductors,
    nodes: state.schematicState.topology.nodes,
    symbolElements: state.schematicState.symbolElements,
    iconElements: state.schematicState.iconElements,
    exposedComponents: state.schematicState.exposedComponents,
    exportedPropertyComponentIds: state.schematicState.exportedPropertyComponentIds,
  });
  const initial = JSON.stringify({
    components: session.initialComponents,
    wires: session.initialWires,
    nodes: session.initialTopologyNodes,
    symbolElements: session.initialSymbolElements,
    iconElements: session.initialIconElements,
    exposedComponents: session.initialExposedComponents,
    exportedPropertyComponentIds: session.initialExportedPropertyComponentIds,
  });
  return current !== initial;
}

/** Compila uma cena (Símbolo OU Ícone) + seu canvas (dimensões/borda/fundo, propriedade do
 * DOCUMENTO, nunca um componente) de volta pra um `PackageDescriptor` -- `undefined` quando o
 * canvas nunca foi autorado nesta sessão (subcircuito ainda sem Símbolo/Ícone, round-trip
 * preserva "ausente"). */
function compileSceneToDescriptor(
  elements: WebviewComponentModel[],
  canvas: WebviewProjectState["symbolCanvas"]
): { descriptor: PackageDescriptor | undefined; errors: string[]; warnings: string[] } {
  if (!canvas) return { descriptor: undefined, errors: [], warnings: [] };
  const compiled = compileSymbolScene(elements);
  const descriptor: PackageDescriptor = {
    width: canvas.width,
    height: canvas.height,
    ...(canvas.border !== undefined ? { border: canvas.border } : {}),
    ...(canvas.background ? { background: canvas.background } : {}),
    pins: compiled.pins,
    ...(compiled.shapes.length > 0 ? { shapes: compiled.shapes } : {}),
  };
  return { descriptor, errors: compiled.errors, warnings: compiled.warnings };
}

/** Grava a cena ATUAL (circuito interno + Símbolo + Ícone + componentes expostos) de volta no
 * `.lssubcircuit` da sessão (preservando os campos que a UI ainda não edita: `translations`,
 * `serialPorts`, `folderPath`, `defaultProperties`, `propertySchema`, `help`) e reregistra no Core.
 * Não mexe em `state.subcircuitEditingStack`/`schematicState` -- só o efeito colateral em disco,
 * chamado pelo branch "Salvar" de `closeSubcircuitEditorCommand`. Devolve `false` (sem gravar NADA
 * em disco) numa condição fatal (pinId duplicado, tunnel/pin órfão, topologia inválida, ...) --
 * a chamadora mantém a sessão aberta nesse caso, nunca escreve um `.lssubcircuit` inconsistente. */
async function writeSubcircuitEditingSessionBack(session: SubcircuitEditingSession): Promise<boolean> {
  const symbolResult = compileSceneToDescriptor(state.schematicState.symbolElements, state.schematicState.symbolCanvas);
  const iconResult = compileSceneToDescriptor(state.schematicState.iconElements, state.schematicState.iconCanvas);

  // `state.schematicState.topology` JÁ é o documento canônico (Fase C completa, `.spec` seção
  // 25.6) -- só falta validar contra o conjunto de componentes do circuito interno (agora SEM
  // nenhuma mistura de Símbolo/Ícone, ver `activeSceneComponents()`) antes de escrever em disco.
  try {
    assertTopologyInvariants(state.schematicState.topology, new Set(state.schematicState.components.map((component) => component.id)));
  } catch (err) {
    void vscode.window.showErrorMessage(
      "Não foi possível salvar o subcircuito -- topologia inválida.",
      { modal: true, detail: err instanceof Error ? err.message : String(err) }
    );
    return false;
  }

  const rawDocument: SubcircuitDocument = {
    schemaVersion: SUBCIRCUIT_SCHEMA_VERSION,
    typeId: session.originalDocument.typeId,
    name: session.originalDocument.name,
    ...(session.originalDocument.language ? { language: session.originalDocument.language } : {}),
    ...(session.originalDocument.translations ? { translations: session.originalDocument.translations } : {}),
    ...(session.originalDocument.serialPorts ? { serialPorts: session.originalDocument.serialPorts } : {}),
    ...(session.originalDocument.folderPath ? { folderPath: session.originalDocument.folderPath } : {}),
    ...(session.originalDocument.defaultProperties ? { defaultProperties: session.originalDocument.defaultProperties } : {}),
    ...(session.originalDocument.propertySchema ? { propertySchema: session.originalDocument.propertySchema } : {}),
    ...(session.originalDocument.help ? { help: session.originalDocument.help } : {}),
    components: state.schematicState.components.map(webviewComponentToProjectComponent),
    topology: {
      revision: state.schematicState.topology.revision,
      nodes: state.schematicState.topology.nodes,
      conductors: state.schematicState.topology.conductors.map((wire) => ({ id: wire.id, from: wire.from, to: wire.to, vertices: wire.points ?? [] })),
    },
    interface: [], // re-derivado abaixo por finalizeSubcircuitDocumentForSave, nunca hand-authored
    ...(symbolResult.descriptor ? { symbol: symbolResult.descriptor } : {}),
    ...(iconResult.descriptor ? { icon: iconResult.descriptor } : {}),
    exposedComponents: state.schematicState.exposedComponents,
    exportedPropertyComponentIds: state.schematicState.exportedPropertyComponentIds,
  };

  // Força `properties.name === properties.pinId` em todo túnel ligado e re-deriva `interface[]`
  // inteiro a partir de `symbol.pins[]` -- nunca hand-authored, nunca parcialmente corrigido.
  const finalizedDocument = finalizeSubcircuitDocumentForSave(rawDocument);

  const validation = validateSubcircuitDocument(finalizedDocument);
  const allErrors = [...symbolResult.errors, ...iconResult.errors, ...validation.errors];
  if (allErrors.length > 0) {
    // Modal (não um toast) -- uma lista de erros pode ser longa o bastante pra um toast cortar com
    // "..." sem dar jeito de ler o resto (achado real: usuário só via a mensagem truncada, sem
    // saber qual era o erro de verdade). Modal sempre mostra o texto inteiro, sem limite de altura.
    void vscode.window.showErrorMessage(
      "Não foi possível salvar o subcircuito -- corrija antes de tentar de novo.",
      { modal: true, detail: allErrors.map((error) => `• ${error}`).join("\n") }
    );
    return false;
  }
  const documentToWrite = validation.autoFixed ?? finalizedDocument;
  const allWarnings = [...symbolResult.warnings, ...iconResult.warnings, ...validation.warnings];
  if (allWarnings.length > 0) {
    void vscode.window.showWarningMessage(
      "Subcircuito salvo com avisos.",
      { modal: true, detail: allWarnings.map((warning) => `• ${warning}`).join("\n") }
    );
  }

  try {
    fs.writeFileSync(session.filePath, `${JSON.stringify(serializeSubcircuitDocument(documentToWrite), null, 2)}\n`, "utf8");
  } catch (err) {
    vscode.window.showErrorMessage(`Não foi possível salvar o subcircuito: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  if (state.coreClient) {
    try {
      await state.coreClient.registerAdhocSubcircuitDefinition(session.filePath, { replace: true });
    } catch (err) {
      vscode.window.showErrorMessage(`Não foi possível reregistrar o subcircuito no Core: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
  return true;
}

/** Salva o documento visual ativo, como Ctrl+S num editor de código. No circuito principal grava o
 * `.lsproj`; dentro de "Editar Subcircuito" grava o `.lssubcircuit` atual sem fechar/desempilhar a
 * sessão e estabelece uma nova baseline para o indicador de alterações. */
async function saveActiveSchematicCommand(): Promise<void> {
  const session = state.subcircuitEditingStack[state.subcircuitEditingStack.length - 1];
  if (!session) {
    await saveProjectCommand();
    return;
  }
  if (!isSubcircuitEditingSessionDirty(session)) return;
  if (!(await writeSubcircuitEditingSessionBack(session))) return;

  // Mutadores da Webview substituem arrays/objetos em vez de editar estas referências in-place;
  // portanto o snapshot atual pode virar a nova baseline exatamente como no momento da abertura.
  session.initialComponents = state.schematicState.components;
  session.initialWires = state.schematicState.topology.conductors;
  session.initialTopologyNodes = state.schematicState.topology.nodes;
  session.initialSymbolElements = state.schematicState.symbolElements;
  session.initialIconElements = state.schematicState.iconElements;
  session.initialExposedComponents = state.schematicState.exposedComponents;
  session.initialExportedPropertyComponentIds = state.schematicState.exportedPropertyComponentIds;
  session.savedDuringEditing = true;
  vscode.window.showInformationMessage(`Subcircuito salvo em ${session.filePath}`);
}

/** Restaura o circuito empilhado por `openSubcircuitForEditingCommand`, sem tocar no arquivo --
 * usado tanto pelo branch "Descartar Alterações" quanto, após `writeSubcircuitEditingSessionBack`,
 * pelo branch "Salvar". */
async function restoreOuterCircuitFromSession(session: SubcircuitEditingSession): Promise<void> {
  state.schematicState = session.outerSchematicState;
  state.currentProjectFilePath = session.outerProjectFilePath;
  syncSchematicPanel();
  await rebuildCoreFromSchematicState();
}

/** "Voltar ao Circuito Principal" -- sem alteração desde a abertura da sessão, sai direto (nada pra
 * perguntar). Com alteração, pergunta Salvar/Descartar Alterações/Cancelar (modal, sem default
 * implícito no Escape -- "Cancelar" é uma opção explícita que mantém o usuário na sessão de edição,
 * sem perder nada). "Salvar" grava no `.lssubcircuit` e volta; "Descartar Alterações" só volta,
 * ignorando as mudanças; "Cancelar" (ou fechar o diálogo) não muda nada, sessão continua ativa.
 * No-op se nenhuma sessão estiver ativa. */
async function closeSubcircuitEditorCommand(): Promise<void> {
  const session = state.subcircuitEditingStack[state.subcircuitEditingStack.length - 1];
  if (!session) return;

  if (isSubcircuitEditingSessionDirty(session)) {
    const save = "Salvar";
    const discard = "Descartar Alterações";
    const cancel = "Cancelar";
    const subcircuitName = state.schematicState.subcircuitEditingContext?.name ?? session.sourceId;
    const choice = await vscode.window.showWarningMessage(
      `O subcircuito "${subcircuitName}" tem alterações não salvas. O que deseja fazer antes de voltar ao circuito principal?`,
      { modal: true },
      save,
      discard,
      cancel
    );
    if (choice === undefined || choice === cancel) return; // permanece na sessão de edição, nada muda
    if (choice === save) {
      // Valida/grava ANTES de desempilhar -- numa condição fatal (ver `writeSubcircuitEditingSessionBack`),
      // a sessão PRECISA continuar ativa (nada foi escrito em disco), nunca desempilhar como se o
      // "Salvar" tivesse funcionado.
      const saved = await writeSubcircuitEditingSessionBack(session);
      if (!saved) return;
    }
    state.subcircuitEditingStack.pop();
    await restoreOuterCircuitFromSession(session);
    if (choice === save || session.savedDuringEditing) {
      // Sem isto, `PACKAGE_BY_TYPE_ID` (host E Webview, `componentSymbols.ts`) mantém o `package`
      // ANTIGO deste typeId em memória -- qualquer instância já colocada no esquemático (deste
      // projeto ou de outro aberto depois) continua desenhando o Package de antes da edição até um
      // reload completo da janela (bug real: "editar o subcircuito não persiste visualmente").
      // PRECISA rodar DEPOIS de `restoreOuterCircuitFromSession` (nunca antes): esta função
      // SOBRESCREVE `state.schematicState` inteiro com `session.outerSchematicState` (a referência
      // capturada ANTES da edição, catálogo velho incluído) -- rodar o refresh antes disso faz o
      // catálogo fresco ser jogado fora no mesmo instante em que é aplicado (bug real: "as mudanças
      // persistem no editor mas nenhuma aparece no esquemático", já que o `syncSchematicPanel()`
      // final de `restoreOuterCircuitFromSession` reenviava o catálogo ANTIGO por cima pra Webview).
      // `loadLibrariesInCore: false` -- `writeSubcircuitEditingSessionBack` já reregistrou no Core
      // (`registerAdhocSubcircuitDefinition`) antes; só falta reler o arquivo e reregistrar o
      // pacote pro lado da Extension/Webview, mesmo padrão já usado em `extension.ts:1278` logo após
      // escrever um `.lssubcircuit` novo.
      await refreshUnifiedCatalogState(false, catalogCommandOptions());
    }
    return;
  }

  state.subcircuitEditingStack.pop();
  await restoreOuterCircuitFromSession(session);
  if (session.savedDuringEditing) {
    await refreshUnifiedCatalogState(false, catalogCommandOptions());
  }
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

/** Diagnóstico (achado 2026-07-18: conexão LasecPlot funciona, mas os caracteres chegam corrompidos
 * no consumidor externo) -- hex + melhor-esforço ASCII dos bytes CRUS que o LasecSimul leu do Core,
 * pra comparar contra o que aparece do outro lado. Se já sai estranho aqui, o problema é do lado do
 * LasecSimul (UART/firmware/encoding); se sai limpo aqui mas corrompe lá, o problema é do consumidor. */
function hexAsciiPreview(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) return "(nenhum byte lido ainda)";
  const hex = Buffer.from(bytes).toString("hex").match(/.{1,2}/g)?.join(" ") ?? "";
  const ascii = Array.from(bytes).map((byte) => (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : ".")).join("");
  return `últimos ${bytes.byteLength} byte(s) lidos do Core:\n    hex:   ${hex}\n    ascii: ${ascii}`;
}

export function activate(context: vscode.ExtensionContext): LasecSimulInteropApi {
  initSimulationLog(context);
  context.subscriptions.push(
    { dispose: disposeDeviceReferenceWatchers },
    vscode.commands.registerCommand("lasecsimul.showSimulationLog", () => showSimulationLogChannel()),
    // Diagnóstico via Command Palette (achado 2026-07-18, pedido explícito do usuário: "tem algum
    // comando que posso dar pelo prompt... pra saber se o problema é aqui ou na outra extensão") --
    // lista TODOS os dispositivos LasecPlot que o broker conhece nesta janela, publicado ou não,
    // direto no canal "LasecSimul: Simulação". `debugListAllEndpoints()` (sem filtro `published`, ao
    // contrário da `listLasecPlotEndpoints()` da API pública) distingue as 3 causas possíveis de "a
    // outra extensão não identifica nada": (1) lista vazia -- o dispositivo nem está registrado nesta
    // janela/sessão; (2) `aberto=false` -- registrado, mas "Abrir" nunca publicou; (3) `aberto=true`
    // -- LasecSimul publicou certo, o problema está do lado do consumidor externo.
    vscode.commands.registerCommand("lasecsimul.lasecplot.listEndpoints", () => {
      lasecPlotManager?.sync();
      const endpoints = lasecPlotManager?.broker.debugListAllEndpoints() ?? [];
      if (endpoints.length === 0) {
        logSimulation("info", "Nenhum dispositivo LasecPlot registrado no circuito desta janela.", { stage: "lasecplot-diagnostico", reveal: true });
        return;
      }
      const detail = endpoints
        .map((e) => {
          const recentBytes = lasecPlotManager?.broker.debugRecentBytes(e.id);
          return `${e.displayName}\n    componentId=${e.componentId} id=${e.id}\n    aberto=${e.opened} online=${e.online} clientes=${e.connectedClients} escrita=${e.writable}\n    baud=${e.baudRate} bits=${e.dataBits} parity=${e.parity} stopBits=${e.stopBits}\n    ${hexAsciiPreview(recentBytes ?? new Uint8Array(0))}`;
        })
        .join("\n");
      logSimulation("info", `${endpoints.length} dispositivo(s) LasecPlot nesta janela:`, { stage: "lasecplot-diagnostico", detail, reveal: true });
    }),
    vscode.window.registerCustomEditorProvider(
      "lasecsimul.projectEditor",
      new ProjectCustomEditorProvider({
        extensionUri: context.extensionUri,
        beforeOpen: closeAllMcuSerialMonitors,
        resolveExternalDeviceReferences,
        openSchematicEditor,
        syncSchematicPanel,
      }),
      { webviewOptions: { retainContextWhenHidden: false } }
    )
  );
  const lasecPlot = initializeLasecPlot(context);
  initializeSerialTerminal(context);
  initializeSerialPort(context);
  registerMcuDebugTracking(context);
  state.extensionContext = context;
  const unifiedCatalog = loadUnifiedCatalog(context.extensionPath, currentLasecSimulLanguage());
  const initialResolved = resolveRegisteredItems(context.extensionPath, unifiedCatalog.registeredSources);
  state.schematicState = createInitialWebviewState([
    ...unifiedCatalog.catalog,
    ...initialResolved.map((item) => item.entry),
  ]);
  state.schematicState.locale = currentLasecSimulLanguage();

  const { pipeName } = launchCoreProcess(context.extensionPath);

  state.coreClient = new CoreClient(pipeName);
  attachCoreClientNotifications(state.coreClient);
  // Conecta de forma assíncrona — não bloqueia a ativação da extensão. `catalogReadyPromise` é
  // atribuída aqui, síncrona dentro do corpo (não-async) de `activate()`, então já existe antes de
  // o VS Code ter qualquer chance de invocar `resolveCustomEditor` (ver comentário em state.ts).
  state.catalogReadyPromise = state.coreClient
    .start()
    .then(() => refreshUnifiedCatalogState(true, catalogCommandOptions()))
    .catch((err) => {
      logSimulation("error", `Falha ao conectar ao LasecSimul Core: ${err instanceof Error ? err.message : String(err)}`, { stage: "core-process" });
    });
  state.catalogReadyPromise.then(async () => {
    if (process.env.LASECSIMUL_E2E === "1" && process.env.LASECSIMUL_E2E_FIXTURE) {
      await openProjectFile(process.env.LASECSIMUL_E2E_FIXTURE, {
        extensionUri: context.extensionUri,
        beforeOpen: closeAllMcuSerialMonitors,
        resolveExternalDeviceReferences,
        openSchematicEditor,
        syncSchematicPanel,
      });
    }
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
    (item) => removeRegisteredCatalogItemCommand(item, catalogCommandOptions())
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
      void refreshUnifiedCatalogState(Boolean(state.coreClient), catalogCommandOptions());
      syncSchematicPanel();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("lasecsimul.simulation")) return;
      if (!state.coreClient) return;
      const cfg = vscode.workspace.getConfiguration("lasecsimul.simulation");
      const targetStepUs = cfg.get<number>("targetStepUs", 0);
      const maxNonLinearIterations = cfg.get<number>("maxNonLinearIterations", 0);
      state.coreClient.setSimulationConfig({
        targetStepUs,
        realTimeRate: cfg.get("realTimeRate", 1),
        maxNonLinearIterations,
        integrationMethod: cfg.get("integrationMethod", "automatic"),
        adaptiveTimeStep: cfg.get("adaptiveTimeStep", true),
        initialStepNs: cfg.get("initialStepNs", 100),
        minimumStepNs: cfg.get("minimumStepNs", 1),
        maximumStepNs: cfg.get("maximumStepNs", 100_000),
        relativeTolerance: cfg.get("relativeTolerance", 1e-4),
        absoluteTolerance: cfg.get("absoluteTolerance", 1e-9),
      })
        .catch((err: unknown) => reportCoreWarning("configurar simulação", err));
    }),
    vscode.commands.registerCommand("lasecsimul.openSchematicEditor", () => openSchematicEditor(context.extensionUri)),
    vscode.commands.registerCommand("lasecsimul.newSubcircuit", () => triggerCreateSubcircuitFromSelection(state.schematicPanel)),
    vscode.commands.registerCommand("lasecsimul.openSettings", async () => {
      try {
        await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:josuemoraisgh.lasecsimul");
      } catch (err) {
        const message = `Não foi possível abrir as Configurações do LasecSimul: ${err instanceof Error ? err.message : String(err)}`;
        logSimulation("error", message, { stage: "configurações" });
        vscode.window.showErrorMessage(message);
      }
    }),
    vscode.commands.registerCommand("lasecsimul.palette.addComponent", (typeId: string) => addPaletteComponent(typeId)),
    vscode.commands.registerCommand("lasecsimul.run", () => void runSimulationWithFirmwareCheck()),
    vscode.commands.registerCommand("lasecsimul.debugFirmware", () => void debugMcuFirmwareCommand(mcuCommandOptions())),
    vscode.commands.registerCommand("lasecsimul.pause", () => pauseSimulation()),
    vscode.commands.registerCommand("lasecsimul.stop", () => stopSimulation()),
    vscode.commands.registerCommand("lasecsimul.saveProject", () => saveActiveSchematicCommand()),
    vscode.commands.registerCommand("lasecsimul.saveProjectAs", () => saveProjectAsCommand()),
    vscode.commands.registerCommand("lasecsimul.openProject", () => openProjectCommand({
      extensionUri: context.extensionUri,
      beforeOpen: closeAllMcuSerialMonitors,
      resolveExternalDeviceReferences,
      openSchematicEditor,
      syncSchematicPanel,
    })),
    vscode.commands.registerCommand("lasecsimul.openRecentProject", () => openRecentProjectCommand({
      extensionUri: context.extensionUri,
      beforeOpen: closeAllMcuSerialMonitors,
      resolveExternalDeviceReferences,
      openSchematicEditor,
      syncSchematicPanel,
    })),
    vscode.commands.registerCommand("lasecsimul.importProject", () => importProjectCommand({ syncSchematicPanel })),
    vscode.commands.registerCommand("lasecsimul.palette.registerFile", () => registerCatalogFileCommand(catalogCommandOptions())),
    vscode.commands.registerCommand("lasecsimul.palette.removeRegistered", (item: { sourceId?: string }) =>
      removeRegisteredCatalogItemCommand(item, catalogCommandOptions())
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

  // Comando deliberadamente ausente em produção: permite ao E2E carregar fixture pelo pipeline
  // real (serializer -> Core -> Webview), sem file picker e sem injetar HTML/estado artificial.
  if (process.env.LASECSIMUL_E2E === "1") {
    context.subscriptions.push(vscode.commands.registerCommand("lasecsimul.e2e.openFixture", async (fixturePath?: string) => {
      const selected = fixturePath || process.env.LASECSIMUL_E2E_FIXTURE;
      if (!selected) throw new Error("LASECSIMUL_E2E_FIXTURE ausente");
      await openProjectFile(selected, {
        extensionUri: context.extensionUri,
        beforeOpen: closeAllMcuSerialMonitors,
        resolveExternalDeviceReferences,
        openSchematicEditor,
        syncSchematicPanel,
      });
    }));
  }

  void setSchematicOpenContext(false);
  void refreshUnifiedCatalogState(false, catalogCommandOptions());
  return lasecPlot.api;
}

export async function deactivate(): Promise<void> {
  closeAllMcuSerialMonitors();
  stopVoltageReadoutPolling();
  await state.coreClient?.stop().catch(() => {});
  state.coreProc?.kill(); // force-kill de segurança caso shutdown IPC não tenha chegado
}
