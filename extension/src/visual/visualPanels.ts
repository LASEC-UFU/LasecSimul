import * as vscode from "vscode";
import { logSimulation } from "../diagnostics/simulationLog";
import { state } from "../state";
import { VisualPanel, VISUAL_PANEL_VIEW_TYPE, visualPanelKey, type VisualPanelHost } from "../ui/panels/VisualPanel";
import { childPropertyKey, effectiveChildProperties } from "../ui/webview/childPropertyOverrides";
import type { HmiApplication, WebviewComponentModel, WebviewProjectState } from "../ui/webview/model";
import { isSubsystemTypeId } from "../ui/webview/subsystemModel";
import { WEBVIEW_MESSAGE_VERSION, type HostToWebviewMessage, type VisualWindowAction, type WebviewToHostMessage } from "../ui/webview/messages";
import {
  classifyWindowState, createFaceplateDocument, faceplateDocumentId, isOtherWindow, screenIdOf, subsystemTypeIdOfFaceplate, uniqueScreenId,
  type PresentationContext, type ScreenViewState, type VisualDocument, type VisualSession, type VisualWindowInfo, type WebviewGeometry,
} from "../ui/webview/visualDocument";
import {
  getScreen, listScreens, onScreenChanged, putScreen, redoScreen, rootComponents, rootSchematicState, screenButtonFor, screenHistory, undoScreen,
} from "./screenStore";
import { LabEmbedHost, isLabToHostMessage, labEmbedBundle } from "./labEmbeds";
import { configureLabExperiments } from "./labExperiments";
import { requestPlantParameter, subscribePlantFeeds, unsubscribePlantFeeds } from "./plantFeeds";
import { LAB_SCREEN_TITLE, createLabScreenDocument, findLabScreen, labScreenButton } from "./labScreens";
import { defaultActivities } from "../ui/webview/lab/activity";

/**
 * Painéis Visuais (Telas HMI e Faceplates de instância) e o gerenciamento das janelas deles (docs/61,
 * docs/62 §8, ADR 0016).
 *
 * - Uma vista por tela; abrir de novo REVELA a existente. Um Faceplate (documento da definição de um
 *   subsistema interno) abre uma vista POR INSTÂNCIA: componentes da cena = internos da definição com os
 *   valores daquela instância; telemetria = a da instância; escrita = `@<interno>.<prop>` da instância.
 * - Undock = `moveEditorToNewWindow` (janela auxiliar do VS Code, mesmo Extension Host); Dock =
 *   `panel.reveal(coluna)` (API pública); tela cheia = `toggleFullScreen` com a janela da tela focada.
 * - O estado da janela não é comandado: é DETECTADO pela geometria que a Webview reporta.
 * - Toda troca de janela recria a Webview; o Host reenvia documento, sessão e janela no `webviewReady`.
 */

type MessageDelegate = (message: WebviewToHostMessage) => void;

interface Options {
  extensionUri: vscode.Uri;
  /** Mensagens que o esquemático já sabe tratar (escrita de operador, simulação, salvar). */
  delegate: MessageDelegate;
}

const WINDOW_COMMANDS = {
  undock: "workbench.action.moveEditorToNewWindow",
  fullscreen: "workbench.action.toggleFullScreen",
  compact: "workbench.action.enableCompactAuxiliaryWindow",
} as const;

/** Só o que faz sentido numa Tela HMI chega ao manipulador do esquemático: o Painel Visual nunca
 * edita o circuito, os fios nem a sessão de subsistemas. */
const DELEGATED_MESSAGES = new Set<WebviewToHostMessage["type"]>([
  "requestUpdateProperty", "requestPreviewProperty", "requestUpdateBoardOverlayProperty",
  "requestRunSimulation", "requestPauseSimulation", "requestStopSimulation",
  "requestSaveProject", "requestSaveProjectAs", "requestOpenExternal", "requestExportInstrumentData",
  "requestOpenPidTuning", "requestToggleLasecPlot", "requestToggleSerialTerminal", "requestSerialTerminalWrite",
]);

let options: Options | undefined;
const panels = new Map<string, VisualPanel>();
let mainWindowGeometry: WebviewGeometry | undefined;
let lastActiveSurface: VisualPanel | "schematic" | undefined;
let availableCommands: Set<string> | undefined;
let lastScreenStates = "";
const lastSyncedRoot = new WeakMap<VisualPanel, Pick<WebviewProjectState, "components" | "topology" | "catalog" | "locale" | "subsystems">>();

export function configureVisualPanels(config: Options): vscode.Disposable {
  options = config;
  const disposeScreenListener = onScreenChanged((documentId, origin) => screenDocumentChanged(documentId, origin));
  // Experimentos do Laboratório e gravações por planta: do projeto, vivos com ou sem tela aberta.
  const disposeLabExperiments = configureLabExperiments();
  void refreshAvailableCommands();
  return new vscode.Disposable(() => {
    disposeScreenListener();
    disposeLabExperiments();
    for (const panel of [...panels.values()]) panel.dispose();
  });
}

async function refreshAvailableCommands(): Promise<void> {
  try {
    availableCommands = new Set(await vscode.commands.getCommands(true));
  } catch {
    availableCommands = new Set();
  }
}

const hasCommand = (id: string): boolean => availableCommands?.has(id) ?? false;

export function visualPanels(): VisualPanel[] {
  return [...panels.values()];
}

const isFaceplatePanel = (panel: VisualPanel): boolean => Boolean(panel.instanceId && subsystemTypeIdOfFaceplate(panel.documentId));

// ── Estado do Painel Visual ──────────────────────────────────────────────────────────────────────

const SESSION_KEY = "lasecsimul.visualSessions";

function sessionKey(panelKey: string): string {
  return `${state.currentProjectFilePath ?? "<sem arquivo>"}::${panelKey}`;
}

interface StoredSession { session: VisualSession; floating?: boolean }

function storedSessions(): Record<string, StoredSession> {
  return state.extensionContext?.workspaceState.get<Record<string, StoredSession>>(SESSION_KEY, {}) ?? {};
}

function storeSession(panel: VisualPanel): void {
  const context = state.extensionContext;
  if (!context) return;
  const all = { ...storedSessions(), [sessionKey(panel.key)]: { session: panel.session, floating: panel.window.docking === "undocked" } };
  void context.workspaceState.update(SESSION_KEY, all);
}

function initialSession(documentId: string, instanceId?: string): StoredSession {
  const stored = storedSessions()[sessionKey(visualPanelKey(documentId, instanceId))];
  if (stored) return stored;
  const presentation = getScreen(documentId)?.presentation;
  return { session: { editing: presentation?.startInOperation !== true, context: presentation?.defaultContext ?? "hmi" } };
}

/** Componentes internos da definição com os valores da INSTÂNCIA (`@<interno>.<prop>` da instância por
 * cima do valor do modelo): o que um Faceplate projeta, liga e comanda naquele contexto. */
function faceplateContextComponents(subsystemTypeId: string, instanceId: string): WebviewComponentModel[] {
  const root = rootSchematicState();
  const definition = (root.subsystems ?? []).find((entry) => entry.typeId === subsystemTypeId);
  const instance = root.components.find((component) => component.id === instanceId);
  if (!definition || !instance) return [];
  return (definition.components ?? []).flatMap((child): WebviewComponentModel[] => {
    if (typeof child.id !== "string" || typeof child.typeId !== "string") return [];
    const raw = child as { label?: unknown; visual?: { x?: unknown; y?: unknown } };
    const modelProperties = (child.properties && typeof child.properties === "object" ? child.properties : {}) as Record<string, string | number | boolean>;
    return [{
      id: child.id,
      typeId: child.typeId,
      label: typeof raw.label === "string" ? raw.label : child.id,
      x: typeof raw.visual?.x === "number" ? raw.visual.x : 0,
      y: typeof raw.visual?.y === "number" ? raw.visual.y : 0,
      rotation: 0,
      pins: [],
      showId: false,
      showValue: false,
      properties: effectiveChildProperties(modelProperties, instance.properties, child.id) as WebviewComponentModel["properties"],
    }];
  });
}

/** O que o motor de cena da vista conhece como "projeto": a raiz (tela) ou os internos da instância (Faceplate). */
function viewContext(doc: VisualDocument, instanceId: string | undefined): Pick<WebviewProjectState, "components" | "topology"> {
  const root = rootSchematicState();
  const subsystemTypeId = subsystemTypeIdOfFaceplate(doc.id);
  if (doc.kind === "faceplate" && subsystemTypeId && instanceId) {
    return { components: faceplateContextComponents(subsystemTypeId, instanceId), topology: { revision: 0, nodes: [], conductors: [] } };
  }
  return { components: root.components, topology: root.topology };
}

/** O catálogo que uma vista visual usa (M10, docs/63 §3.2): o do esquemático passa de 36 MB (pacotes,
 * imagens de placas, tabelas HART; só os 243 gráficos somam ~8 MB). A vista recebe os tipos que o seu
 * contexto e o seu documento usam, mais os matemáticos/ferramentas; um tipo novo chega junto com a
 * colocação pela paleta ou com a colagem de outra vista. Memorizado por catálogo + tipos. */
let visualCatalogCache: { catalog: WebviewProjectState["catalog"]; byKey: Map<string, WebviewProjectState["catalog"]> } | undefined;

function visualCatalog(catalog: WebviewProjectState["catalog"], components: readonly WebviewComponentModel[], doc?: VisualDocument): WebviewProjectState["catalog"] {
  const elements = doc?.pages.flatMap((page) => page.elements) ?? [];
  // Tela: dos componentes da raiz, só os que o documento projeta (`componentId`), comanda (`actionTarget`)
  // ou lê (`bindSource*`). Faceplate: os internos (poucos) vão todos.
  const referenced = new Set(elements.flatMap((element) => [element.componentId,
    ...["actionTarget", "bindSource", "bindSourceB", "bindSourceC"].map((key) => element.properties?.[key])]).filter((id): id is string => typeof id === "string" && id.length > 0));
  const used = new Set(components.filter((component) => doc?.kind === "faceplate" || referenced.has(component.id)).map((component) => component.typeId));
  for (const element of elements) if (element.typeId) used.add(element.typeId);
  const key = [...used].sort().join("|");
  // Uma entrada por conjunto de tipos (várias vistas abertas); recomeça quando o catálogo da raiz muda.
  if (visualCatalogCache?.catalog !== catalog) visualCatalogCache = { catalog, byKey: new Map() };
  const cached = visualCatalogCache.byKey.get(key);
  if (cached) return cached;
  const result = catalog.filter((entry) => entry.typeId.startsWith("graphics.math.") || entry.typeId.startsWith("tools.") || used.has(entry.typeId));
  visualCatalogCache.byKey.set(key, result);
  return result;
}

const catalogEntriesFor = (typeIds: Iterable<string>): WebviewProjectState["catalog"] => {
  const wanted = new Set(typeIds);
  return rootSchematicState().catalog.filter((entry) => wanted.has(entry.typeId));
};

/** O projeto raiz com a tela no lugar de `hmiApplication`: é o que o motor de cena edita no papel visual. */
function visualWebviewState(doc: VisualDocument, session: VisualSession, instanceId?: string): WebviewProjectState {
  const root = rootSchematicState();
  const context = viewContext(doc, instanceId);
  return {
    ...root,
    ...context,
    catalog: visualCatalog(root.catalog, context.components, doc),
    calculusLab: undefined,
    controlDesignProject: undefined,
    identProject: undefined,
    hmiApplication: doc,
    viewport: session.viewport ?? { x: 0, y: 0, zoom: 1 },
    selectedComponentIds: [],
    selectedWireIds: [],
    pendingConnection: undefined,
    subcircuitEditingContext: undefined,
    symbolMode: undefined,
    symbolElements: [],
    iconElements: [],
    symbolCanvas: undefined,
    iconCanvas: undefined,
    exposedComponents: [],
    exportedPropertyComponentIds: [],
  };
}

function windowInfo(panel: VisualPanel): VisualWindowInfo {
  return {
    docking: panel.window.docking,
    window: panel.window.window,
    canUndock: hasCommand(WINDOW_COMMANDS.undock),
    canFullscreen: hasCommand(WINDOW_COMMANDS.fullscreen) && hasCommand(WINDOW_COMMANDS.undock),
    projectSimulationSuspended: state.subcircuitEditingStack.length > 0,
  };
}

function postVisualState(panel: VisualPanel): void {
  panel.window = windowInfo(panel);
  const message: HostToWebviewMessage = {
    version: WEBVIEW_MESSAGE_VERSION, type: "visualState", session: panel.session, window: panel.window, history: screenHistory(panel.documentId),
  };
  panel.postMessage(message);
}

const host: VisualPanelHost = {
  initialState(panel) {
    const doc = getScreen(panel.documentId);
    return doc ? visualWebviewState(doc, panel.session, panel.instanceId) : undefined;
  },
  roleState(panel) {
    panel.window = windowInfo(panel);
    const instance = panel.instanceId ? rootComponents().find((component) => component.id === panel.instanceId) : undefined;
    return {
      window: panel.window,
      history: screenHistory(panel.documentId),
      ...(isFaceplatePanel(panel) && panel.instanceId ? { faceplate: { instanceId: panel.instanceId, instanceLabel: instance?.label ?? panel.instanceId } } : {}),
    };
  },
  ready(panel) {
    const doc = getScreen(panel.documentId);
    if (!doc) {
      panel.dispose();
      return;
    }
    state.runtimeSinks.add(panel);
    const project = visualWebviewState(doc, panel.session, panel.instanceId);
    lastSyncedRoot.set(panel, { components: project.components, topology: project.topology, catalog: project.catalog, locale: project.locale, subsystems: project.subsystems });
    if (isFaceplatePanel(panel) && panel.instanceId && !panel.runtimeTransform) panel.runtimeTransform = faceplateRuntimeTransform(panel.instanceId);
    void panel.panel.webview.postMessage({ version: WEBVIEW_MESSAGE_VERSION, type: "init", project });
    postVisualState(panel);
    void panel.panel.webview.postMessage({ version: WEBVIEW_MESSAGE_VERSION, type: "simulationStatus", status: state.simulationStatus });
    publishScreenStates();
  },
  message(panel, message) {
    handleVisualMessage(panel, message);
  },
  viewStateChanged(panel) {
    if (panel.panel.active) lastActiveSurface = panel;
    if (panel.window.docking === "docked" && panel.panel.viewColumn) panel.dockedColumn = panel.panel.viewColumn;
  },
  disposed(panel) {
    unsubscribePlantFeeds(panel);
    labHosts.get(panel)?.dispose();
    labHosts.delete(panel);
    state.runtimeSinks.delete(panel);
    if (panels.get(panel.key) === panel) panels.delete(panel.key);
    if (lastActiveSurface === panel) lastActiveSurface = undefined;
    publishScreenStates();
  },
};

// ── Abrir / revelar ──────────────────────────────────────────────────────────────────────────────

export type OpenScreenMode = "auto" | "docked" | "floating" | "fullscreen";

export async function openScreen(documentId: string, mode: OpenScreenMode = "auto", instanceId?: string): Promise<VisualPanel | undefined> {
  if (!options) return undefined;
  const doc = getScreen(documentId);
  if (!doc) {
    void vscode.window.showWarningMessage("Esta Tela HMI não existe mais no projeto.");
    return undefined;
  }
  await refreshAvailableCommands();
  const key = visualPanelKey(documentId, instanceId);
  let panel = panels.get(key);
  const stored = initialSession(documentId, instanceId);
  if (!panel || panel.isDisposed) {
    const column = state.schematicPanel ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
    panel = VisualPanel.create(options.extensionUri, documentId, panelTitle(doc, instanceId), column, stored.session, host, instanceId);
    if (instanceId && doc.kind === "faceplate") panel.runtimeTransform = faceplateRuntimeTransform(instanceId);
    panels.set(key, panel);
  } else {
    panel.panel.reveal(undefined, false);
  }
  const wantsFloating = mode === "floating" || mode === "fullscreen" || (mode === "auto" && stored.floating === true && panel.boots === 0);
  if (wantsFloating && panel.window.docking === "docked") await undock(panel);
  if (mode === "fullscreen") await enterFullscreen(panel);
  publishScreenStates();
  return panel;
}

/** Título da aba: o da tela, ou "Instância — Faceplate" para o Faceplate de uma instância. */
function panelTitle(doc: VisualDocument, instanceId?: string): string {
  if (doc.kind !== "faceplate" || !instanceId) return doc.title;
  const instance = rootComponents().find((component) => component.id === instanceId);
  return `${instance?.label ?? instanceId} — Faceplate`;
}

/** A vista do Faceplate de uma instância recebe só a telemetria DA instância, com os ids internos:
 * `boardOverlayReadouts` (`<instância>:<interno>`, ver `coreLifecycle.ts::pollBoardOverlayReadouts`) vira
 * `componentReadout`/`componentVisualState` dos componentes internos; a telemetria da raiz não se aplica. */
function faceplateRuntimeTransform(instanceId: string): (message: unknown) => unknown[] {
  const prefix = `${instanceId}:`;
  const pick = (record: unknown): Record<string, unknown> => Object.fromEntries(Object.entries(record && typeof record === "object" ? record : {})
    .filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key.slice(prefix.length), value]));
  return (message) => {
    const runtime = message as { type?: string; readoutsByKey?: unknown; visualStatesByKey?: unknown; transportStatus?: unknown; sampleTimestampNs?: unknown };
    switch (runtime.type) {
      case "componentReadout":
      case "componentVisualState":
      case "wireVoltages":
        return [];
      case "boardOverlayReadouts":
        return [
          { version: 1, type: "componentReadout", readoutsByComponentId: pick(runtime.readoutsByKey), transportStatus: runtime.transportStatus ?? "connected", sampleTimestampNs: runtime.sampleTimestampNs },
          { version: 1, type: "componentVisualState", statesByComponentId: pick(runtime.visualStatesByKey) },
        ];
      default:
        return [message];
    }
  };
}

/** O Faceplate da definição (cria um vazio na primeira vez; adota o que veio dentro de uma definição
 * importada/colada, `subsystems[].faceplate`). */
export function faceplateForSubsystem(subsystemTypeId: string): VisualDocument | undefined {
  const documentId = faceplateDocumentId(subsystemTypeId);
  const existing = getScreen(documentId);
  if (existing) return existing;
  const definition = (rootSchematicState().subsystems ?? []).find((entry) => entry.typeId === subsystemTypeId);
  if (!definition) return undefined;
  const carried = (definition as { faceplate?: unknown }).faceplate;
  // Páginas HMI antigas da definição (modo HMI da sessão do subsistema): viram o Faceplate, com os
  // mesmos elementos -- os que projetam componentes internos (`componentId`) continuam ligados a eles.
  const legacyHmi = (definition as { hmiApplication?: HmiApplication }).hmiApplication;
  const doc: VisualDocument = carried && typeof carried === "object" && Array.isArray((carried as VisualDocument).pages)
    ? { ...(carried as VisualDocument), id: documentId, kind: "faceplate" }
    : legacyHmi?.pages?.length
      ? { ...createFaceplateDocument(subsystemTypeId, definition.name), ...structuredClone(legacyHmi), id: documentId, kind: "faceplate" }
      : createFaceplateDocument(subsystemTypeId, definition.name);
  putScreen(doc, { record: false });
  return doc;
}

/** "Abrir Faceplate da instância" (docs/62 §8): o painel de operação da definição no contexto da
 * instância, numa vista própria (acoplada, flutuante ou em tela cheia, como uma tela). */
export async function openInstanceFaceplate(componentId: string, mode: OpenScreenMode = "auto"): Promise<void> {
  const instance = rootComponents().find((component) => component.id === componentId);
  if (!instance || !isSubsystemTypeId(instance.typeId)) {
    void vscode.window.showWarningMessage("O Faceplate de instância existe para subsistemas internos do projeto (sistemas externos: \"Incorporar como subsistema interno\" antes).");
    return;
  }
  const doc = faceplateForSubsystem(instance.typeId);
  if (!doc) return;
  try {
    await openScreen(doc.id, mode, instance.id);
  } catch (error) {
    logSimulation("error", `falha ao abrir o Faceplate de ${instance.label}: ${error instanceof Error ? error.message : String(error)}`,
      { stage: "tela-hmi", detail: error instanceof Error ? error.stack : undefined });
  }
}

/** Botão "Faceplate" da sessão de um subsistema interno: abre no contexto da 1ª instância do projeto. */
export async function openDefinitionFaceplate(subsystemTypeId: string): Promise<void> {
  const instance = rootComponents().find((component) => component.typeId === subsystemTypeId);
  if (!instance) {
    void vscode.window.showWarningMessage("O Faceplate abre no contexto de uma instância: coloque uma instância deste subsistema no projeto (ou use o menu da instância).");
    return;
  }
  await openInstanceFaceplate(instance.id);
}

/**
 * "LasecSimul: Laboratório de Cálculo" (docs/62 §6.3): abre a tela do Laboratório do projeto; sem uma,
 * cria a tela com as atividades-modelo e o botão que a abre no esquemático (Controle › Ferramentas).
 * `afterInsert` sincroniza o esquemático e o indicador de alterações (`extension.ts`).
 */
export async function openCalculusLabScreen(afterInsert: () => void): Promise<void> {
  let doc = findLabScreen(listScreens());
  if (!doc) {
    if (state.subcircuitEditingStack.length > 0) {
      void vscode.window.showWarningMessage("Volte ao circuito principal para criar a tela do Laboratório de Cálculo (ela fica no projeto, não dentro do subsistema).");
      return;
    }
    const id = uniqueScreenId(new Set(listScreens().map((screen) => screen.id)));
    const legacy = state.schematicState.calculusLab?.activities;
    doc = createLabScreenDocument(id, LAB_SCREEN_TITLE, legacy && legacy.length > 0 ? legacy : defaultActivities());
    putScreen(doc, { record: false });
    const components = state.schematicState.components;
    const button = labScreenButton(id, LAB_SCREEN_TITLE, components, new Set(components.map((component) => component.id)));
    state.schematicState = { ...state.schematicState, components: [...components, button], calculusLab: undefined };
    afterInsert();
  }
  await openScreen(doc.id, "auto");
}

export async function openScreenForButton(componentId: string, mode: OpenScreenMode): Promise<void> {
  const button = rootSchematicState().components.find((component) => component.id === componentId)
    ?? state.schematicState.components.find((component) => component.id === componentId);
  const documentId = screenIdOf(button);
  if (!documentId) return;
  try {
    await openScreen(documentId, mode);
  } catch (error) {
    logSimulation("error", `falha ao abrir a Tela HMI ${documentId}: ${error instanceof Error ? error.message : String(error)}`,
      { stage: "tela-hmi", detail: error instanceof Error ? error.stack : undefined });
  }
}

// ── Mensagens do Painel Visual ───────────────────────────────────────────────────────────────────

/** Atividades do Laboratório embutidas nas páginas de cada vista (`labEmbeds.ts`). */
const labHosts = new Map<VisualPanel, LabEmbedHost>();

function labHostFor(panel: VisualPanel): LabEmbedHost {
  let host = labHosts.get(panel);
  if (!host) {
    host = new LabEmbedHost(panel.documentId, panel.session.editing,
      (elementId, message) => panel.postMessage({ version: WEBVIEW_MESSAGE_VERSION, type: "labEmbedMessage", elementId, message }));
    labHosts.set(panel, host);
  }
  return host;
}

function handleVisualMessage(panel: VisualPanel, message: WebviewToHostMessage): void {
  if (!message || message.version !== WEBVIEW_MESSAGE_VERSION) return;
  switch (message.type) {
    case "labEmbedMessage":
      if (message.documentId === panel.documentId && isLabToHostMessage(message.message)) labHostFor(panel).receive(message.elementId, message.message);
      return;
    case "subscribePlantFeeds":
      if (message.documentId === panel.documentId) subscribePlantFeeds(panel, message.componentIds, message.fresh);
      return;
    case "requestPlantParameter":
      if (message.documentId === panel.documentId) void requestPlantParameter(panel, message.componentId, message.parameterId, message.value);
      return;
    case "labEmbedClosed":
      if (message.documentId === panel.documentId) labHosts.get(panel)?.close(message.elementId);
      return;
    case "visualClipboardSet":
      // As outras vistas visuais passam a poder colar esta cópia (a de origem já a tem).
      for (const other of panels.values()) {
        if (other !== panel) other.postMessage({ version: WEBVIEW_MESSAGE_VERSION, type: "visualClipboard", at: message.at, components: message.components,
          catalogEntries: catalogEntriesFor(message.components.map((component) => component.typeId)),
          ...(message.faceplateInstanceId ? { faceplateInstanceId: message.faceplateInstanceId } : {}) });
      }
      return;
    case "requestLabEmbedBundle": {
      const bundle = options ? labEmbedBundle(options.extensionUri.fsPath) : undefined;
      if (bundle) panel.postMessage({ version: WEBVIEW_MESSAGE_VERSION, type: "labEmbedBundle", ...bundle });
      else void vscode.window.showErrorMessage("O Laboratório de Cálculo não foi compilado (out-webview/lab-embed/lab.js ausente): rode npm run compile.");
      return;
    }
    case "visualDocumentChanged": {
      if (message.documentId !== panel.documentId) return;
      const current = getScreen(panel.documentId);
      if (!current) return;
      // Título, apresentação e identidade pertencem ao Host (botão/menu, definição), não à cena.
      putScreen({ ...message.document, id: current.id, kind: current.kind, schemaVersion: current.schemaVersion, title: current.title, presentation: current.presentation }, { record: true, origin: panel });
      return;
    }
    case "requestVisualUndo":
      if (undoScreen(panel.documentId)) return;
      postVisualState(panel);
      return;
    case "requestVisualRedo":
      if (redoScreen(panel.documentId)) return;
      postVisualState(panel);
      return;
    case "visualSessionChanged":
      panel.session = message.session;
      storeSession(panel);
      labHosts.get(panel)?.setEditing(panel.session.editing);
      return;
    case "visualGeometry":
      updateGeometry(panel, message.geometry);
      return;
    case "visualWindowRequest":
      void windowAction(panel, message.action);
      return;
    default:
      if (!DELEGATED_MESSAGES.has(message.type)) return;
      // Faceplate: comandar um componente interno = propriedade `@<interno>.<prop>` DA INSTÂNCIA (vale só
      // para ela, entra no desfazer e no arquivo, e o Core aplica com `setSubcircuitChildProperty`).
      if (isFaceplatePanel(panel) && panel.instanceId && (message.type === "requestUpdateProperty" || message.type === "requestPreviewProperty")) {
        options?.delegate({ ...message, componentId: panel.instanceId, name: childPropertyKey(message.componentId, message.name) });
        return;
      }
      options?.delegate(message);
  }
}

function screenDocumentChanged(documentId: string, origin: unknown): void {
  const doc = getScreen(documentId);
  const views = [...panels.values()].filter((panel) => panel.documentId === documentId);
  if (!doc || views.length === 0) {
    publishScreenStates();
    return;
  }
  // Um Faceplate é da definição: todas as instâncias abertas recebem a mudança.
  for (const panel of views) {
    panel.setTitle(panelTitle(doc, panel.instanceId));
    if (origin !== panel) {
      panel.postMessage({ version: WEBVIEW_MESSAGE_VERSION, type: "syncStatePatch", patch: { hmiApplication: doc } });
    }
    postVisualState(panel);
    labHosts.get(panel)?.documentChanged();
  }
}

/** O projeto raiz mudou (componentes, fios, catálogo, idioma): projeções e alvos de ação das telas
 * abertas precisam do estado novo. Só os campos que mudaram (mesma disciplina de `syncStatePatch`). */
export function syncVisualPanelsWithProject(): void {
  const root = rootSchematicState();
  // Botão removido: a tela fecha (o documento continua na memória para um Ctrl+Z que devolva o botão).
  // Faceplate: fecha quando a instância ou a definição deixa de existir.
  for (const panel of [...panels.values()]) {
    const subsystemTypeId = subsystemTypeIdOfFaceplate(panel.documentId);
    const alive = subsystemTypeId
      ? root.components.some((component) => component.id === panel.instanceId && component.typeId === subsystemTypeId)
      : Boolean(screenButtonFor(panel.documentId));
    if (!alive) panel.dispose();
  }
  for (const panel of panels.values()) {
    if (!panel.ready) continue;
    const doc = getScreen(panel.documentId);
    if (!doc) continue;
    // A vista de Faceplate recalcula os internos com os valores da instância (os componentes da raiz
    // mudam a cada comando `@<interno>.<prop>` aceito).
    const context = isFaceplatePanel(panel) ? viewContext(doc, panel.instanceId) : { components: root.components, topology: root.topology };
    const previous = lastSyncedRoot.get(panel);
    const patch: Record<string, unknown> = {};
    const componentsChanged = isFaceplatePanel(panel)
      ? JSON.stringify(previous?.components) !== JSON.stringify(context.components)
      : !previous || previous.components !== context.components;
    if (componentsChanged) patch.components = context.components;
    if (!previous || previous.topology !== context.topology) patch.topology = context.topology;
    const catalog = visualCatalog(root.catalog, context.components, doc);
    if (!previous || previous.catalog !== catalog) patch.catalog = catalog;
    if (!previous || previous.locale !== root.locale) patch.locale = root.locale;
    if (!previous || previous.subsystems !== root.subsystems) patch.subsystems = root.subsystems;
    if (Object.keys(patch).length === 0) continue;
    lastSyncedRoot.set(panel, { components: context.components, topology: context.topology, catalog, locale: root.locale, subsystems: root.subsystems });
    panel.postMessage({ version: WEBVIEW_MESSAGE_VERSION, type: "syncStatePatch", patch });
  }
  for (const panel of panels.values()) postVisualState(panel);
}

// ── Estado das janelas ───────────────────────────────────────────────────────────────────────────

/** Geometria da janela PRINCIPAL do VS Code: a paleta lateral (uma WebviewView) nunca sai dela. */
export function setMainWindowGeometry(geometry: WebviewGeometry): void {
  mainWindowGeometry = geometry;
  for (const panel of panels.values()) if (panel.geometry) updateGeometry(panel, panel.geometry);
}

function updateGeometry(panel: VisualPanel, geometry: WebviewGeometry): void {
  panel.geometry = geometry;
  const previousDocking = panel.window.docking;
  const previousWindow = panel.window.window;
  const undockedByGeometry = isOtherWindow(geometry, mainWindowGeometry);
  // Sem a geometria da janela principal, vale o que o próprio Host fez por último (Undock/Dock).
  if (mainWindowGeometry) panel.window.docking = undockedByGeometry ? "undocked" : "docked";
  panel.window.window = panel.window.docking === "undocked" ? classifyWindowState(geometry) : "normal";
  if (panel.window.docking === previousDocking && panel.window.window === previousWindow) return;
  // As transições de tela cheia valem igual para o botão da tela, o menu e o F11 nativo do VS Code.
  if (previousWindow !== "fullscreen" && panel.window.window === "fullscreen") {
    panel.contextBeforeFullscreen = panel.session.context;
    panel.session = { ...panel.session, context: contextForFullscreen(panel) };
    void offerChromelessFullscreen(panel);
  } else if (previousWindow === "fullscreen" && panel.window.window !== "fullscreen") {
    if (panel.contextBeforeFullscreen) panel.session = { ...panel.session, context: panel.contextBeforeFullscreen };
    panel.contextBeforeFullscreen = undefined;
    if (panel.dockAfterFullscreen) {
      panel.dockAfterFullscreen = false;
      void dock(panel);
    }
  }
  postVisualState(panel);
  storeSession(panel);
  publishScreenStates();
}

export function screenViewState(documentId: string): ScreenViewState {
  const panel = panels.get(visualPanelKey(documentId));
  if (!panel || panel.isDisposed) return "closed";
  if (panel.window.window === "fullscreen") return "fullscreen";
  return panel.window.docking === "undocked" ? "floating" : "docked";
}

export function publishScreenStates(): void {
  const states: Record<string, ScreenViewState> = {};
  for (const panel of panels.values()) if (!panel.instanceId) states[panel.documentId] = screenViewState(panel.documentId);
  const key = JSON.stringify(states);
  if (key === lastScreenStates) return;
  lastScreenStates = key;
  state.schematicPanel?.postMessage({ version: WEBVIEW_MESSAGE_VERSION, type: "screenStates", states });
}

/** Reenvia o indicador ao esquemático (painel recém-aberto ou recriado). */
export function republishScreenStates(): void {
  lastScreenStates = "";
  publishScreenStates();
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Espera a Webview renascer (troca de janela) ou o tempo acabar. */
async function waitForBoot(panel: VisualPanel, previousBoots: number, timeoutMs = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (panel.isDisposed) return false;
    if (panel.boots > previousBoots && panel.ready) return true;
    await sleep(50);
  }
  return false;
}

async function waitForWindowState(panel: VisualPanel, predicate: (info: VisualWindowInfo) => boolean, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (panel.isDisposed) return false;
    if (predicate(panel.window)) return true;
    await sleep(50);
  }
  return false;
}

async function focusPanel(panel: VisualPanel): Promise<void> {
  panel.panel.reveal(undefined, false);
  await sleep(150);
}

export async function undock(panel: VisualPanel): Promise<boolean> {
  if (!hasCommand(WINDOW_COMMANDS.undock)) {
    void vscode.window.showWarningMessage("Esta versão do VS Code não oferece janelas flutuantes para editores: a Tela HMI continua acoplada.");
    return false;
  }
  if (panel.window.docking === "undocked") return true;
  if (panel.panel.viewColumn) panel.dockedColumn = panel.panel.viewColumn;
  await focusPanel(panel);
  const boots = panel.boots;
  await vscode.commands.executeCommand(WINDOW_COMMANDS.undock);
  const reborn = await waitForBoot(panel, boots);
  panel.window.docking = "undocked";
  if (reborn && hasCommand(WINDOW_COMMANDS.compact)) {
    await sleep(150);
    await vscode.commands.executeCommand(WINDOW_COMMANDS.compact);
  }
  postVisualState(panel);
  storeSession(panel);
  publishScreenStates();
  return reborn;
}

/** Colunas da janela PRINCIPAL. Na numeração de `ViewColumn` os grupos da principal vêm antes dos das
 * janelas auxiliares (PoC docs/poc/janelas-auxiliares-vscode: `reveal(One)` acopla), e cada tela
 * flutuante desta extensão ocupa uma janela auxiliar com um grupo só. */
function mainWindowColumnCount(): number {
  const floating = visualPanels().filter((view) => view.window.docking === "undocked").length;
  return Math.max(1, vscode.window.tabGroups.all.length - floating);
}

export async function dock(panel: VisualPanel): Promise<boolean> {
  if (panel.window.docking === "docked") return true;
  panel.dockAfterFullscreen = false;
  if (panel.window.window === "fullscreen") await exitFullscreen(panel);
  const wanted = panel.dockedColumn && panel.dockedColumn > 0 ? panel.dockedColumn : vscode.ViewColumn.Two;
  const boots = panel.boots;
  let reborn: boolean;
  if (wanted <= mainWindowColumnCount()) {
    panel.panel.reveal(wanted, false);
    reborn = await waitForBoot(panel, boots);
  } else {
    // A coluna de antes ficou vazia e sumiu com o Undock (o número dela agora é o grupo da janela
    // auxiliar): volta pela 1ª coluna da principal e abre ao lado, como na abertura da tela.
    panel.panel.reveal(vscode.ViewColumn.One, false);
    reborn = await waitForBoot(panel, boots);
    panel.panel.reveal(vscode.ViewColumn.Beside, false);
    await sleep(200);
  }
  panel.window.docking = "docked";
  panel.window.window = "normal";
  if (panel.panel.viewColumn) panel.dockedColumn = panel.panel.viewColumn;
  postVisualState(panel);
  storeSession(panel);
  publishScreenStates();
  return reborn;
}

function contextForFullscreen(panel: VisualPanel): PresentationContext {
  const policy = getScreen(panel.documentId)?.presentation.fullscreenContext ?? "lab";
  return policy === "keep" ? panel.session.context : policy;
}

/** Tela cheia verdadeira da janela da tela (docs/61 §7.1). Acoplada: desacopla antes e volta a
 * acoplar ao sair. A troca de contexto e o reacoplamento acontecem na transição detectada pela
 * geometria (`updateGeometry`), o mesmo caminho do F11 nativo. */
export async function enterFullscreen(panel: VisualPanel): Promise<boolean> {
  if (!hasCommand(WINDOW_COMMANDS.fullscreen)) return false;
  if (panel.window.window === "fullscreen") return true;
  if (panel.window.docking === "docked") {
    if (!(await undock(panel))) return false;
    panel.dockAfterFullscreen = true;
  }
  await focusPanel(panel);
  if (hasCommand(WINDOW_COMMANDS.compact)) await vscode.commands.executeCommand(WINDOW_COMMANDS.compact);
  await vscode.commands.executeCommand(WINDOW_COMMANDS.fullscreen);
  return waitForWindowState(panel, (info) => info.window === "fullscreen");
}

export async function exitFullscreen(panel: VisualPanel): Promise<boolean> {
  if (panel.window.window !== "fullscreen") return true;
  await focusPanel(panel);
  await vscode.commands.executeCommand(WINDOW_COMMANDS.fullscreen);
  return waitForWindowState(panel, (info) => info.window !== "fullscreen");
}

async function windowAction(panel: VisualPanel, action: VisualWindowAction): Promise<void> {
  switch (action) {
    case "undock": await undock(panel); return;
    case "dock": await dock(panel); return;
    case "fullscreen": await enterFullscreen(panel); return;
    case "exitFullscreen": await exitFullscreen(panel); return;
    case "toggleContext":
      panel.session = { ...panel.session, context: panel.session.context === "lab" ? "hmi" : "lab" };
      postVisualState(panel);
      storeSession(panel);
      return;
  }
}

/** Faixa de 30 px que sobra em tela cheia compacta (docs/61 §7.2): só a configuração GLOBAL do VS Code
 * `window.customTitleBarVisibility: "windowed"` a remove, então o usuário decide uma vez. */
async function offerChromelessFullscreen(panel: VisualPanel): Promise<void> {
  const context = state.extensionContext;
  if (!context || !panel.geometry) return;
  const key = "lasecsimul.chromelessFullscreenAsked";
  if (context.globalState.get<boolean>(key)) return;
  const configuration = vscode.workspace.getConfiguration("window");
  if (configuration.get<string>("customTitleBarVisibility") === "windowed") return;
  if (panel.geometry.innerHeight >= panel.geometry.screen.height) return;
  await context.globalState.update(key, true);
  const apply = "Ocultar a barra de título em tela cheia";
  const choice = await vscode.window.showInformationMessage(
    "Para a Tela HMI ocupar o monitor inteiro, sem a faixa de título do VS Code, a configuração window.customTitleBarVisibility precisa valer \"windowed\" (vale para todo o VS Code).",
    apply, "Agora não");
  if (choice === apply) await configuration.update("customTitleBarVisibility", "windowed", vscode.ConfigurationTarget.Global);
}

// ── Paleta e foco ────────────────────────────────────────────────────────────────────────────────

export function noteSchematicActive(): void {
  lastActiveSurface = "schematic";
}

/** A paleta lateral é uma só: um clique num item arma a colocação na ÚLTIMA superfície ativa. Uma
 * Tela HMI em edição recebe os elementos gráficos (`graphics.*`, docs/61 §8); o resto vai ao
 * esquemático. Devolve `true` quando uma tela ficou com a colocação. */
export function routePlacementToVisualPanel(typeId: string): boolean {
  const target = lastActiveSurface;
  if (!target || target === "schematic" || target.isDisposed || !target.ready) return false;
  if (!target.session.editing || !typeId.startsWith("graphics.")) return false;
  target.postMessage({ version: WEBVIEW_MESSAGE_VERSION, type: "beginComponentPlacement", typeId, catalogEntries: catalogEntriesFor([typeId]) });
  return true;
}

// ── Recarregar o VS Code ─────────────────────────────────────────────────────────────────────────

/** Painéis restaurados pelo VS Code antes de o projeto abrir: esperam o documento. */
const restoredPanels = new Map<string, vscode.WebviewPanel>();

export function registerVisualPanelSerializer(): vscode.Disposable {
  return vscode.window.registerWebviewPanelSerializer(VISUAL_PANEL_VIEW_TYPE, {
    async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel, saved: unknown): Promise<void> {
      const documentId = documentIdFromSavedState(saved);
      const instanceId = instanceIdFromSavedState(saved);
      // Faceplate sem a instância no estado salvo não tem contexto: reabre-se pelo esquemático.
      if (!documentId || !options || (subsystemTypeIdOfFaceplate(documentId) && !instanceId)) {
        webviewPanel.dispose();
        return;
      }
      if (restorable(documentId, instanceId)) {
        adoptRestoredPanel(documentId, webviewPanel, instanceId);
        return;
      }
      const key = visualPanelKey(documentId, instanceId);
      restoredPanels.set(key, webviewPanel);
      webviewPanel.webview.html = `<!doctype html><html><body style="font:14px system-ui;padding:24px;color:#475569">Tela HMI aguardando o projeto LasecSimul ser aberto…</body></html>`;
      webviewPanel.onDidDispose(() => restoredPanels.delete(key));
    },
  });
}

function documentIdFromSavedState(saved: unknown): string | undefined {
  if (typeof saved !== "object" || saved === null) return undefined;
  const app = (saved as { hmiApplication?: { id?: unknown } }).hmiApplication;
  return typeof app?.id === "string" ? app.id : undefined;
}

function instanceIdFromSavedState(saved: unknown): string | undefined {
  const value = typeof saved === "object" && saved !== null ? (saved as { __visualInstanceId?: unknown }).__visualInstanceId : undefined;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A vista restaurada ainda faz sentido neste projeto: tela com botão, ou Faceplate com a instância. */
function restorable(documentId: string, instanceId: string | undefined): boolean {
  if (!getScreen(documentId)) return false;
  const subsystemTypeId = subsystemTypeIdOfFaceplate(documentId);
  if (subsystemTypeId) return rootComponents().some((component) => component.id === instanceId && component.typeId === subsystemTypeId);
  return Boolean(screenButtonFor(documentId));
}

function adoptRestoredPanel(documentId: string, webviewPanel: vscode.WebviewPanel, instanceId?: string): void {
  const key = visualPanelKey(documentId, instanceId);
  if (!options || panels.has(key)) {
    webviewPanel.dispose();
    return;
  }
  const doc = getScreen(documentId);
  if (doc) webviewPanel.title = panelTitle(doc, instanceId);
  const panel = new VisualPanel(webviewPanel, options.extensionUri, documentId, initialSession(documentId, instanceId).session, host, instanceId);
  if (instanceId && doc?.kind === "faceplate") panel.runtimeTransform = faceplateRuntimeTransform(instanceId);
  panels.set(key, panel);
}

/** Projeto aberto: vistas restauradas pelo VS Code que pertencem a ele são adotadas; as outras fecham. */
export function adoptRestoredVisualPanels(): void {
  for (const [key, webviewPanel] of [...restoredPanels]) {
    restoredPanels.delete(key);
    const at = key.lastIndexOf("@");
    const documentId = at > 0 ? key.slice(0, at) : key;
    const instanceId = at > 0 ? key.slice(at + 1) : undefined;
    if (subsystemTypeIdOfFaceplate(documentId) && instanceId) faceplateForSubsystem(subsystemTypeIdOfFaceplate(documentId)!);
    if (restorable(documentId, instanceId)) adoptRestoredPanel(documentId, webviewPanel, instanceId);
    else webviewPanel.dispose();
  }
}

/** Projeto trocado/fechado: as telas do projeto anterior fecham. */
export function closeAllVisualPanels(): void {
  for (const panel of [...panels.values()]) panel.dispose();
  panels.clear();
}
