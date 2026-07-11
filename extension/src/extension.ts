import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { CoreClient } from "./ipc/CoreClient";
import { CoreProcess } from "./ipc/CoreProcess";
import { TrustStore } from "./trust/TrustStore";
import { isPreApproved, isPreBlocked, resolveConsentChoice, shouldLoadLibrary, decisionToPersist } from "./trust/trustDecision";
import { SchematicPanel } from "./ui/panels/SchematicPanel";
import { createInitialWebviewState } from "./ui/webview/catalog";
import { JUNCTION_TYPE_ID, TUNNEL_TYPE_ID, WebviewComponentCatalogEntry, WebviewComponentModel, WebviewProjectState, WebviewWireModel } from "./ui/webview/model";
import { buildPinToPinWire, buildPinToWireConnection } from "./ui/webview/wireConnections";
import { normalizeWireGeometry, removeOrphanNodes, splitSegmentAtPoint } from "./ui/webview/wireTopology";
import { WebviewToHostMessage } from "./ui/webview/messages";
import { ComponentPaletteViewProvider } from "./ui/views/ComponentPaletteViewProvider";
import { materializePinGroup, registerPackage } from "./ui/webview/componentSymbols";
import { absoluteSubcircuitRefPath, exportSchematicImageCommand, importProjectCommand, openProjectCommand, openRecentProjectCommand, refreshDirtyIndicator, saveProjectCommand } from "./project/projectCommands";
import { loadUnifiedCatalog, RegisteredSource, saveRegisteredSources } from "./catalog/UnifiedCatalog";
import { refreshUnifiedCatalogState, registerCatalogFileCommand, removeRegisteredCatalogItemCommand } from "./catalog/catalogCommands";
import { hasShowOnSymbolProperty, nextIndexedLabel } from "./catalog/catalogMerge";
import { imageMimeForFile, sanitizeManifestDefaultProperties } from "./catalog/packageSanitizers";
import { compilePackageAuthoringComponents, seedPackageAuthoringComponents } from "./catalog/subcircuitPackageAuthoring";
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
  pushRemoveWireToCore,
  pushPropertyToCore,
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
  pinsForProjectComponent,
} from "./core/coreLifecycle";
import {
  chooseExposedMcuFirmwareCommand,
  chooseMcuFirmwareCommand,
  closeAllMcuSerialMonitors,
  closeMcuSerialMonitor,
  ensureAllMcuFirmwareUpToDate,
  openExposedMcuSerialMonitorCommand,
  openMcuSerialMonitorCommand,
  requestBoardOverlayDataCommand,
  updateBoardOverlayPropertyCommand,
  updateBoardOverlayVisualCommand,
  updateExposedComponentPropertyCommand,
} from "./mcu/mcuCommands";
import {
  gatherInternalComponentSnapshots,
  resolveSourceFilePath,
} from "./catalog/subcircuitInternals";

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
  "subcircuitEditingContext",
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
type ProjectStatePatch = Omit<Partial<WebviewProjectState>, "pendingConnection" | "subcircuitEditingContext"> & {
  pendingConnection?: WebviewProjectState["pendingConnection"] | null;
  subcircuitEditingContext?: WebviewProjectState["subcircuitEditingContext"] | null;
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

/** Substitui a chamada direta a `runSimulation()` nos dois pontos de entrada de "Run" (mensagem
 * `requestRunSimulation` da Webview E comando `lasecsimul.run`) -- achado de auditoria 2026-07-09:
 * "Recarregar Firmware" era uma ação manual que o usuário precisava lembrar de clicar toda vez que
 * recompilava o `.bin` fora do LasecSimul; removida da interface (`main.ts`), o recarregamento agora
 * é sempre automático, verificado aqui ANTES de rodar. `ensureAllMcuFirmwareUpToDate` só empurra
 * firmware pro Core quando o arquivo mudou (mtime+tamanho) desde a última carga daquela instância --
 * nunca recarrega à toa, nem no caso comum (nada mudou). Se QUALQUER MCU/CPU tiver firmware ausente/
 * inacessível ou a recarga falhar, a simulação NÃO inicia -- erro claro em vez de rodar com firmware
 * potencialmente desatualizado ou o processo QEMU num estado inconsistente. */
async function runSimulationWithFirmwareCheck(): Promise<void> {
  const result = await ensureAllMcuFirmwareUpToDate(mcuCommandOptions());
  if (!result.ok) {
    vscode.window.showErrorMessage(`Não foi possível iniciar a simulação: ${result.message}`);
    return;
  }
  runSimulation();
}

function getComponentById(componentId: string): WebviewComponentModel | undefined {
  return state.schematicState.components.find((component) => component.id === componentId);
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
    const created = await pushComponentToCore(componentId, parsed.typeId, updatedComponent.properties, newPins);
    if (created) {
      for (const wire of state.schematicState.wires) {
        if (wire.from.componentId === componentId || wire.to.componentId === componentId) await pushWireToCore(wire);
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

/** Editor de propriedade `filePath` GENÉRICO (Estágio 1 da autoria de Package/ícone dentro de "Abrir
 * Subcircuito", `.spec/lasecsimul.spec`) -- ao contrário de `chooseSubcircuitFileCommand` (nunca
 * grava em `properties`, troca typeId/pinos/package inteiros da instância), este comando só lê o
 * arquivo escolhido e grava em `component.properties[propertyKey]`. Quando o campo é
 * `graphics.image.path`, também resolve `imageData`/`imageMime` (base64, mesmo padrão de
 * `packageSanitizers.ts::sanitizePackageBackground`) pra renderização real na Webview
 * (`componentSymbols.ts`) -- sem isso a imagem escolhida nunca apareceria no canvas, só o caminho
 * cru guardado. */
async function chooseFilePropertyCommand(componentId: string, propertyKey: string): Promise<void> {
  const component = getComponentById(componentId);
  if (!component) return;

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

  state.schematicState = {
    ...state.schematicState,
    components: state.schematicState.components.map((c) => (c.id === componentId ? { ...c, properties: updatedProperties } : c)),
  };
  pushPropertyToCore(componentId, propertyKey, absolutePath);
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
        const pinId = component.pins[0]?.id ?? "pin";
        pushTunnelNameToCore(component.id, pinId, String(before.properties[name] ?? ""), String(value));
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
      const afterRemoval = {
        components: state.schematicState.components.filter((component) => component.id !== message.componentId),
        wires: state.schematicState.wires.filter((wire) => wire.from.componentId !== message.componentId && wire.to.componentId !== message.componentId),
      };
      // Apagar um componente pode derrubar o grau de uma junção que ele tocava (ou de uma
      // encadeada além dela) pra <=2 -- `removeOrphanNodes` cascateia a limpeza/colapso pra nunca
      // deixar uma junção "bola laranja" órfã presa no esquemático (ver `.spec` seção do refactor
      // de fios).
      const normalized = removeOrphanNodes(afterRemoval);
      const topologyChangedBeyondDirectRemoval =
        normalized.components.length !== afterRemoval.components.length || normalized.wires.length !== afterRemoval.wires.length;
      const survivingWireIds = new Set(normalized.wires.map((wire) => wire.id));
      state.schematicState = {
        ...state.schematicState,
        components: normalized.components,
        wires: normalized.wires,
        selectedComponentIds: state.schematicState.selectedComponentIds.filter((id) => id !== message.componentId),
        selectedWireIds: state.schematicState.selectedWireIds.filter((id) => survivingWireIds.has(id)),
        pendingConnection:
          state.schematicState.pendingConnection?.componentId === message.componentId ? undefined : state.schematicState.pendingConnection,
      };
      syncSchematicPanel();
      if (topologyChangedBeyondDirectRemoval) {
        // Colapso/cascata de junção órfã: mais seguro reconstruir o Core do zero do que tentar
        // diferenciar incrementalmente quais fios sumiram/nasceram nessa fusão (operação rara).
        void queueCoreRebuild().then(() => {
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
      const removedWire = state.schematicState.wires.find((wire) => wire.id === message.wireId);
      const afterRemoval = {
        components: state.schematicState.components,
        wires: state.schematicState.wires.filter((wire) => wire.id !== message.wireId),
      };
      const normalized = removeOrphanNodes(afterRemoval);
      const topologyChangedBeyondDirectRemoval =
        normalized.components.length !== afterRemoval.components.length || normalized.wires.length !== afterRemoval.wires.length;
      const survivingWireIds = new Set(normalized.wires.map((wire) => wire.id));
      state.schematicState = {
        ...state.schematicState,
        components: normalized.components,
        wires: normalized.wires,
        selectedWireIds: state.schematicState.selectedWireIds.filter((id) => survivingWireIds.has(id)),
      };
      syncSchematicPanel();
      if (topologyChangedBeyondDirectRemoval) {
        void queueCoreRebuild().then(() => {
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
    case "requestConnectPins": {
      const wire = buildPinToPinWire({ id: nextId("wire"), from: message.from, to: message.to, points: message.points });
      void (async () => {
        if (state.coreClient) {
          const ok = await pushWireToCore(wire);
          if (!ok) return; // Core recusou/falhou -- não deixa a tela mostrar um fio que o Core não conectou.
        }
        state.schematicState = {
          ...state.schematicState,
          wires: [...state.schematicState.wires, wire],
          selectedComponentIds: [],
          selectedWireIds: [wire.id],
          pendingConnection: undefined,
        };
        syncSchematicPanel();
        if (state.simulationStatus === "running") void pollWireVoltages();
      })();
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
      void (async () => {
        // Operação composta (junção + até 3 fios): qualquer falha no Core reverte tudo, nunca
        // deixa uma junção "meio criada" na tela sem os fios que deveriam sair dela.
        if (state.coreClient) {
          const componentOk = await pushComponentToCore(junction.id, junction.typeId, junction.properties, junction.pins);
          if (!componentOk) return;
          const wiresOk = await Promise.all([firstWire, secondWire, newWire].map((wire) => pushWireToCore(wire)));
          if (wiresOk.some((ok) => !ok)) {
            pushRemoveToCore(junction.id); // desfaz o componente já aceito -- Core não fica com meia-junção
            return;
          }
        }
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
        if (state.simulationStatus === "running") {
          void pollInstrumentReadouts();
          void pollWireVoltages();
        }
      })();
      return;
    }
    case "requestStartWireFromWire": {
      // Clique num trecho qualquer de um fio, sem conexão pendente -- inicia uma derivação
      // diretamente daquele ponto (fiel ao SimulIDE). Todo o cálculo de split/reuso de junção
      // já existente vive em `wireTopology.ts`, única fonte de verdade tanto pra este verbo quanto
      // pra `requestConnectPinToWire` acima.
      const split = splitSegmentAtPoint(
        { components: state.schematicState.components, wires: state.schematicState.wires },
        message.wireId,
        message.point,
        { junctionId: nextId("junction"), firstWireId: nextId("wire"), secondWireId: nextId("wire") }
      );
      if (!split) return;
      const junctionId = split.firstWire.to.componentId;
      void (async () => {
        // Mesma regra de rollback composto de `requestConnectPinToWire`: se reusa uma junção já
        // existente, `split.junction` é `undefined` e não há componente novo pra criar/desfazer no
        // Core -- só os dois fios do split precisam ser confirmados.
        if (state.coreClient) {
          if (split.junction) {
            const componentOk = await pushComponentToCore(split.junction.id, split.junction.typeId, split.junction.properties, split.junction.pins);
            if (!componentOk) return;
          }
          const wiresOk = await Promise.all([split.firstWire, split.secondWire].map((wire) => pushWireToCore(wire)));
          if (wiresOk.some((ok) => !ok)) {
            if (split.junction) pushRemoveToCore(split.junction.id);
            return;
          }
        }
        state.schematicState = {
          ...state.schematicState,
          components: split.junction ? [...state.schematicState.components, split.junction] : state.schematicState.components,
          wires: [...state.schematicState.wires.filter((wire) => wire.id !== message.wireId), split.firstWire, split.secondWire],
          selectedComponentIds: [],
          selectedWireIds: [],
          // Arma a conexão pendente na junção recém-criada (ou reusada) -- o pino dela é um pino
          // REAL, então todo o mecanismo de preview/arrasto de fio pendente já existente na Webview
          // funciona sem nenhuma mudança (`pendingConnectionPosition` resolve por componentId/pinId
          // igual a qualquer outro componente).
          pendingConnection: { componentId: junctionId, pinId: "pin-1" },
        };
        syncSchematicPanel();
        if (state.simulationStatus === "running") {
          void pollInstrumentReadouts();
          void pollWireVoltages();
        }
      })();
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
            ? {
                ...component,
                showId: message.showId,
                showValue: message.showValue,
                ...(message.valueLabelPropertyKey !== undefined ? { valueLabelPropertyKey: message.valueLabelPropertyKey } : {}),
              }
            : component
        ),
      };
      syncSchematicPanel();
      return;
    }
    case "requestUpdateProperty": {
      const prevComponent = state.schematicState.components.find((c) => c.id === message.componentId);
      const updatedProperties = { ...prevComponent?.properties, [message.name]: message.value };
      // Propriedade `affectsPinCount` (ex: rows/columns do switches.keypad, TR-9): o número de
      // pinos da instância pode ter mudado -- recalcula via a MESMA fórmula que o Core usa
      // (`pinsForTypeId`, dynamicLayout.pinGroups), reconcilia `component.pins[]` e derruba
      // qualquer fio que apontava pra um pino que deixou de existir. O Core faz a MESMA
      // reconciliação do lado dele sozinho (`SimulationSession::setProperty` ->
      // `reregisterComponentPins`, disparado pelo `pushPropertyToCore` abaixo) -- não é preciso
      // mandar `disconnectWire` explícito pra esses fios, já saem do Netlist junto.
      const catalogEntry = prevComponent ? state.schematicState.catalog.find((item) => item.typeId === prevComponent.typeId) : undefined;
      const affectsPinCount = catalogEntry?.propertySchema?.find((schema) => schema.id === message.name)?.affectsPinCount ?? false;
      const newPins = prevComponent && affectsPinCount ? pinsForTypeId(prevComponent.typeId, updatedProperties) : undefined;
      const newPinIds = newPins ? new Set(newPins.map((pin) => pin.id)) : undefined;

      const nextWires = newPinIds
        ? state.schematicState.wires.filter((wire) => {
            const touchesRemovedPin =
              (wire.from.componentId === message.componentId && !newPinIds.has(wire.from.pinId)) ||
              (wire.to.componentId === message.componentId && !newPinIds.has(wire.to.pinId));
            return !touchesRemovedPin;
          })
        : state.schematicState.wires;

      state.schematicState = {
        ...state.schematicState,
        components: state.schematicState.components.map((component) =>
          component.id === message.componentId
            ? { ...component, properties: updatedProperties, ...(newPins ? { pins: newPins } : {}) }
            : component
        ),
        wires: nextWires,
        selectedWireIds:
          nextWires === state.schematicState.wires
            ? state.schematicState.selectedWireIds
            : state.schematicState.selectedWireIds.filter((id) => nextWires.some((wire) => wire.id === id)),
      };
      // Túnel: nome precisa de setTunnelName (rebuilda topologia do Netlist), não setProperty.
      if (message.name === "name" && prevComponent?.typeId === TUNNEL_TYPE_ID) {
        const pinId = prevComponent.pins[0]?.id ?? "pin";
        const oldName = String(prevComponent.properties["name"] ?? "");
        pushTunnelNameToCore(message.componentId, pinId, oldName, String(message.value));
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
    case "requestStopSimulation":
      stopSimulation();
      return;
    case "requestSaveProject":
      void saveProjectCommand();
      return;
    case "requestOpenProject":
      if (state.extensionContext) {
        void openProjectCommand({
          extensionUri: state.extensionContext.extensionUri,
          beforeOpen: closeAllMcuSerialMonitors,
          openSchematicEditor,
          syncSchematicPanel,
        });
      }
      return;
    case "requestImportCircuit":
      void importProjectCommand({ syncSchematicPanel });
      return;
    case "requestExportSchematicImage":
      void exportSchematicImageCommand(message.svg);
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

  let manifest: Record<string, unknown>;
  try {
    manifest = readJsonFile(filePath) as Record<string, unknown>;
  } catch (err) {
    vscode.window.showErrorMessage(`Não foi possível ler ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const rawComponents = Array.isArray(manifest.components) ? manifest.components : [];
  const rawWires = Array.isArray(manifest.wires) ? manifest.wires : [];
  const internalComponents: WebviewComponentModel[] = rawComponents
    .filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
    .map((raw) => {
      const visual = (typeof raw.visual === "object" && raw.visual !== null ? raw.visual : {}) as Record<string, unknown>;
      const properties = (typeof raw.properties === "object" && raw.properties !== null ? raw.properties : {}) as Record<string, string | number | boolean>;
      const typeId = String(raw.typeId ?? "");
      const descriptor = state.schematicState.catalog.find((entry) => entry.typeId === typeId);
      const component = {
        id: String(raw.id ?? ""),
        typeId,
        label: String(raw.id ?? ""),
        hidden: typeId === JUNCTION_TYPE_ID ? true : (descriptor?.hidden ?? false),
        showValue: hasShowOnSymbolProperty(descriptor),
        x: typeof visual.x === "number" ? visual.x : 0,
        y: typeof visual.y === "number" ? visual.y : 0,
        rotation: (visual.rotation === 90 || visual.rotation === 180 || visual.rotation === 270 ? visual.rotation : 0) as 0 | 90 | 180 | 270,
        flipH: typeof visual.flipH === "boolean" ? visual.flipH : undefined,
        flipV: typeof visual.flipV === "boolean" ? visual.flipV : undefined,
        exposed: raw.exposed === true,
        properties,
        pins: [] as Array<{ id: string; x: number; y: number }>,
      };
      component.pins = pinsForProjectComponent(component);
      return component;
    })
    .filter((component) => component.id && component.typeId);

  // Autoria visual de ícone/Package (Estágio 3/4, `.spec/lasecsimul.spec`) -- materializa
  // `other.package`/`other.package_pin`/a Figura marcada como ícone a partir de `manifest.package`/
  // `manifest.interface` DENTRO da mesma lista `components` usada tanto por
  // `session.initialComponents` quanto por `state.schematicState.components` (mesma referência,
  // abaixo) -- se esses dois usassem arrays diferentes, a sessão abriria "suja" mesmo sem o usuário
  // ter tocado em nada (ver `isSubcircuitEditingSessionDirty`). Nunca sintetiza nada quando
  // `manifest.package` está ausente/não sanitiza -- arquivo antigo sem Package não ganha um
  // gratuitamente só por ser aberto.
  const packageAuthoringSeed = seedPackageAuthoringComponents(manifest, internalComponents, path.dirname(filePath), () => nextId("pkgauth"));
  const components: WebviewComponentModel[] = [...internalComponents, ...packageAuthoringSeed.components];
  if (packageAuthoringSeed.warnings.length > 0) {
    // Modal (não toast) -- mesmo motivo do erro de save: uma lista com vários avisos cortava com
    // "..." num toast, sem jeito de ler o resto.
    void vscode.window.showWarningMessage(
      "Subcircuito aberto com avisos no Package.",
      { modal: true, detail: packageAuthoringSeed.warnings.map((warning) => `• ${warning}`).join("\n") }
    );
  }

  const rawWiresParsed: WebviewWireModel[] = rawWires
    .filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
    .map((raw) => {
      const from = raw.from as { componentId: string; pinId: string };
      const to = raw.to as { componentId: string; pinId: string };
      const points = Array.isArray(raw.points) ? (raw.points as Array<{ x: number; y: number }>) : [];
      return { id: nextId("wire"), from, to, ...(points.length > 0 ? { points } : {}) };
    })
    .filter((wire) => wire.from?.componentId && wire.to?.componentId);

  // Autocorrige `.lssubcircuit` salvo antes do refactor de fios (junção órfã/duplicada, fio de
  // comprimento zero) -- roda ANTES de virar `initialComponents`/`initialWires` (a baseline de
  // "sujo"), pra um arquivo recém-autocurado não abrir a sessão já marcada como alterada.
  const normalized = normalizeWireGeometry({ components, wires: rawWiresParsed });
  const wires = normalized.wires;

  state.subcircuitEditingStack.push({
    sourceId,
    filePath,
    originalManifest: manifest,
    outerSchematicState: state.schematicState,
    outerProjectFilePath: state.currentProjectFilePath,
    initialComponents: normalized.components,
    initialWires: normalized.wires,
  });

  state.schematicState = {
    ...state.schematicState,
    components: normalized.components,
    wires,
    viewport: { x: 0, y: 0, zoom: 1 },
    selectedComponentIds: [],
    selectedWireIds: [],
    pendingConnection: undefined,
    subcircuitEditingContext: {
      sourceId,
      typeId: String(manifest.typeId ?? ""),
      name: String(manifest.name ?? manifest.typeId ?? filePath),
    },
  };
  syncSchematicPanel();
  await rebuildCoreFromSchematicState();
}

type SubcircuitEditingSession = (typeof state.subcircuitEditingStack)[number];

/** Mesmo princípio de `projectCommands.ts::isProjectDirty`, só que a "baseline" é `initialComponents/
 * Wires` (estado logo após abrir a sessão, ver `openSubcircuitForEditingCommand`) em vez do último
 * save do `.lsproj`. */
function isSubcircuitEditingSessionDirty(session: SubcircuitEditingSession): boolean {
  const current = JSON.stringify({ components: state.schematicState.components, wires: state.schematicState.wires });
  const initial = JSON.stringify({ components: session.initialComponents, wires: session.initialWires });
  return current !== initial;
}

/** Grava `components`/`wires` atuais de volta no `.lssubcircuit` da sessão (preservando todas as
 * outras chaves do manifesto original, ex: `translations`) e reregistra no Core. Não mexe em
 * `state.subcircuitEditingStack`/`schematicState` -- só o efeito colateral em disco, chamado pelo
 * branch "Salvar" de `closeSubcircuitEditorCommand`. Devolve `false` (sem gravar NADA em disco) numa
 * condição fatal pro Core (pinId duplicado, Package/ícone duplicado, vínculo de túnel duplicado) --
 * a chamadora mantém a sessão aberta nesse caso, nunca escreve um `.lssubcircuit` inconsistente. */
async function writeSubcircuitEditingSessionBack(session: SubcircuitEditingSession): Promise<boolean> {
  // Autoria visual de ícone/Package (Estágio 3/4/5, `.spec/lasecsimul.spec`) -- compila
  // `other.package`/`other.package_pin`/a Figura marcada como ícone da cena ATUAL de volta pra
  // `package`/`interface[]`, ANTES de qualquer `fs.writeFileSync` (nunca depois -- um resultado
  // inválido não pode chegar a tocar o disco). `remainingComponents` já vem SEM os componentes de
  // autoria -- precisa ser a base do merge de `boardVisual` abaixo, não `state.schematicState.
  // components` bruto, senão um `other.package_pin` vazaria pra dentro de `components[]` do
  // circuito interno de verdade (mesma classe de bug já corrigida uma vez nesta área).
  const compiled = compilePackageAuthoringComponents(state.schematicState.components);
  if (compiled.errors.length > 0) {
    // Modal (não um toast) -- uma lista de erros pode ser longa o bastante pra um toast cortar com
    // "..." sem dar jeito de ler o resto (achado real: usuário só via a mensagem truncada, sem
    // saber qual era o erro de verdade). Modal sempre mostra o texto inteiro, sem limite de altura.
    void vscode.window.showErrorMessage(
      "Não foi possível salvar o subcircuito -- corrija antes de tentar de novo.",
      { modal: true, detail: compiled.errors.map((error) => `• ${error}`).join("\n") }
    );
    return false;
  }
  if (compiled.warnings.length > 0) {
    void vscode.window.showWarningMessage(
      "Subcircuito salvo com avisos.",
      { modal: true, detail: compiled.warnings.map((warning) => `• ${warning}`).join("\n") }
    );
  }

  // `boardVisual` (posição no overlay de Modo Placa, ver `WebviewComponentModel.boardX/Y`) é uma
  // propriedade do componente que esta sessão de edição NUNCA expõe/toca -- reconstruir cada
  // componente do zero (só com `id`/`typeId`/`properties`/`visual`/`exposed`) apagaria esse campo
  // silenciosamente pra quem já tinha posicionado o overlay antes. Parte do objeto ORIGINAL de cada
  // componente que sobreviveu à sessão, sobrescrevendo só os campos que de fato passam por
  // `WebviewComponentModel` -- um componente novo (criado durante a sessão) não tem original, cai no
  // shape simples de sempre.
  const originalComponents = Array.isArray(session.originalManifest.components)
    ? (session.originalManifest.components as Array<Record<string, unknown>>)
    : [];
  const originalComponentById = new Map(originalComponents.map((raw) => [String(raw.id ?? ""), raw]));
  const components = compiled.remainingComponents.map((component) => ({
    ...(originalComponentById.get(component.id) ?? {}),
    id: component.id,
    typeId: component.typeId,
    properties: { ...component.properties },
    visual: {
      x: component.x,
      y: component.y,
      rotation: component.rotation,
      flipH: component.flipH ?? false,
      flipV: component.flipV ?? false,
    },
    exposed: component.exposed === true,
  }));
  // Fios que tocam um componente de autoria (nunca deveria acontecer -- `other.package`/
  // `other.package_pin`/a Figura têm `pinCount: 0`, sem pino nenhum pra desenhar fio até) são
  // filtrados por defesa em profundidade, nunca gravados apontando pra um id que não existe mais em
  // `components[]`.
  const remainingIds = new Set(compiled.remainingComponents.map((component) => component.id));
  const wires = state.schematicState.wires
    .filter((wire) => remainingIds.has(wire.from.componentId) && remainingIds.has(wire.to.componentId))
    .map((wire) => ({
      from: wire.from,
      to: wire.to,
      points: wire.points ?? [],
    }));
  const updatedManifest: Record<string, unknown> = { ...session.originalManifest, components, wires };
  if (compiled.touchedPackageAuthoring) {
    if (compiled.hasPackage && compiled.package) {
      updatedManifest.package = compiled.package;
      updatedManifest.interface = compiled.interfaceEntries ?? [];
    } else {
      delete updatedManifest.package;
      delete updatedManifest.interface;
    }
  }

  try {
    fs.writeFileSync(session.filePath, `${JSON.stringify(updatedManifest, null, 2)}\n`, "utf8");
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
    return;
  }

  state.subcircuitEditingStack.pop();
  await restoreOuterCircuitFromSession(session);
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
    .then(() => refreshUnifiedCatalogState(true, catalogCommandOptions()))
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
      state.coreClient.setSimulationConfig({ targetStepUs, maxNonLinearIterations })
        .catch((err: unknown) => reportCoreWarning("configurar simulação", err));
    }),
    vscode.commands.registerCommand("lasecsimul.openSchematicEditor", () => openSchematicEditor(context.extensionUri)),
    vscode.commands.registerCommand("lasecsimul.newSubcircuit", () => triggerCreateSubcircuitFromSelection(state.schematicPanel)),
    vscode.commands.registerCommand("lasecsimul.openSettings", () => {
      void vscode.commands.executeCommand("workbench.action.openSettings", "lasecsimul.");
    }),
    vscode.commands.registerCommand("lasecsimul.palette.addComponent", (typeId: string) => addPaletteComponent(typeId)),
    vscode.commands.registerCommand("lasecsimul.run", () => void runSimulationWithFirmwareCheck()),
    vscode.commands.registerCommand("lasecsimul.pause", () => pauseSimulation()),
    vscode.commands.registerCommand("lasecsimul.stop", () => stopSimulation()),
    vscode.commands.registerCommand("lasecsimul.saveProject", () => saveProjectCommand()),
    vscode.commands.registerCommand("lasecsimul.openProject", () => openProjectCommand({
      extensionUri: context.extensionUri,
      beforeOpen: closeAllMcuSerialMonitors,
      openSchematicEditor,
      syncSchematicPanel,
    })),
    vscode.commands.registerCommand("lasecsimul.openRecentProject", () => openRecentProjectCommand({
      extensionUri: context.extensionUri,
      beforeOpen: closeAllMcuSerialMonitors,
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

  void setSchematicOpenContext(false);
  void refreshUnifiedCatalogState(false, catalogCommandOptions());
}

export async function deactivate(): Promise<void> {
  closeAllMcuSerialMonitors();
  stopVoltageReadoutPolling();
  await state.coreClient?.stop().catch(() => {});
  state.coreProc?.kill(); // force-kill de segurança caso shutdown IPC não tenha chegado
}
