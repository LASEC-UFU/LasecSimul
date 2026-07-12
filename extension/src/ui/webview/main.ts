import { WEBVIEW_MESSAGE_VERSION, ComponentReadoutValue, HostToWebviewMessage, InternalComponentSnapshot, SimulationStatus, WebviewToHostMessage } from "./messages.js";
import { CanonicalEndpoint, CanonicalTopologyDocument, InteractionKindEntry, McuSerialPortEntry, PropertySchemaEntry, TUNNEL_TYPE_ID, ViewSpecInteraction, WebviewComponentCatalogEntry, WebviewComponentModel, WebviewProjectState, WebviewWireModel, endpointId, endpointPinId, nodeEndpoint, portEndpoint, remapEndpoint } from "./model.js";
import { ComponentBox, PIN_RADIUS, componentBox, componentLocalOrigin, componentSymbolSvg, dialKnobSvg, hasRealPinPosition, missingSubcircuitPlaceholderSvg, packageSymbolSvg, pinLocalPosition, registerPackage } from "./componentSymbols.js";
import { detectChannelTrigger, findTriggerAnchorIndex, triggerAlignedWindowEndNs, visibleSampleWindowByTime } from "./instrumentTrigger.js";
import {
  Point,
  WIRE_GRID_SIZE,
  appendPoint,
  buildOrthogonalPath,
  moveOrthogonalWireCorner,
  moveOrthogonalWireSegment,
  nearestPointOnOrthogonalSegment,
  nearestSnappedPointOnOrthogonalSegment,
  normalizeOrthogonalPath,
  orthogonalSegmentPoints,
  samePoint,
  snapCoordinate,
  snapToWireGrid,
  splitWireRouteAtPoint,
  wireConnectCornerIndexLikeSimulIDE,
  wireCornerIndexNearSegmentPoint,
} from "./wireGeometry.js";
import { formatEngineeringValue, defaultSiPrefixFactor, SI_PREFIXES } from "./valueFormatting.js";
import { isJunctionVisible, movableTopologyNodeIds, endpointScenePosition as resolveEndpointScenePosition } from "./wireTopology.js";
import { WireSpatialIndex } from "./wireSpatialIndex.js";
import { applyBoardTransforms, applyExposedSelection, captureBoardTransforms, captureCircuitTransforms, ComponentTransform, isBoardModeVisible as isBoardModeVisibleShared, restoreCircuitTransforms } from "./subcircuitBoardMode.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const FINE_WIRE_STEP = WIRE_GRID_SIZE / 10;

interface WindowWithInitialState extends Window {
  __LASECSIMUL_INITIAL_STATE__?: WebviewProjectState;
}

declare const acquireVsCodeApi: undefined | (() => { postMessage(message: unknown): void; setState(state: unknown): void; getState(): unknown });

const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
const app = document.getElementById("app");

function createEmptyState(): WebviewProjectState {
  return {
    locale: "pt-BR",
    catalog: [],
    components: [],
    topology: { revision: 0, nodes: [], conductors: [] },
    viewport: { x: 0, y: 0, zoom: 1 },
    selectedComponentIds: [],
    selectedWireIds: [],
  };
}

/** `vscode.getState()` pode devolver um estado persistido de ANTES desta versão (seleção era
 * `selectedComponentId?: string` singular, não array) — sem normalizar, `.includes()`/`.filter()`
 * num `undefined` quebraria na primeira interação. Migração unidirecional, sem perda de dados real
 * (seleção não é algo que precise sobreviver a uma atualização da extensão). */
function normalizeProjectState(raw: WebviewProjectState): WebviewProjectState {
  const legacy = raw as WebviewProjectState & { selectedComponentId?: string; selectedWireId?: string };
  return {
    ...raw,
    selectedComponentIds: Array.isArray(raw.selectedComponentIds)
      ? raw.selectedComponentIds
      : legacy.selectedComponentId
        ? [legacy.selectedComponentId]
        : [],
    selectedWireIds: Array.isArray(raw.selectedWireIds)
      ? raw.selectedWireIds
      : legacy.selectedWireId
        ? [legacy.selectedWireId]
        : [],
  };
}

/** `componentSymbols.ts` cacheia o layout de `package` por typeId num registro próprio (módulo
 * importado uma vez, sobrevive a troca de `state`) -- precisa ser re-sincronizado toda vez que o
 * catálogo chega de novo (Épico G: cada item registrado pode trazer um `package` real). */
function syncPackageRegistry(catalog: WebviewProjectState["catalog"]): void {
  for (const entry of catalog) registerPackage(entry.typeId, entry.package, entry.logicSymbolPackage);
}

const initialWindowState = (window as WindowWithInitialState).__LASECSIMUL_INITIAL_STATE__;
let state = normalizeProjectState((vscode?.getState() as WebviewProjectState | undefined) ?? initialWindowState ?? createEmptyState());
syncPackageRegistry(state.catalog);

let catalogLookupSource: WebviewProjectState["catalog"] | undefined;
let catalogEntryByTypeId = new Map<string, WebviewComponentCatalogEntry>();

function catalogEntryFor(typeId: string): WebviewComponentCatalogEntry | undefined {
  if (catalogLookupSource !== state.catalog) {
    catalogLookupSource = state.catalog;
    catalogEntryByTypeId = new Map(state.catalog.map((entry) => [entry.typeId, entry]));
  }
  return catalogEntryByTypeId.get(typeId);
}

// Histórico de undo/redo do circuito principal e da sessão de autoria de símbolo/subcircuito (ver
// definição completa de `UndoHistory`/`resetUndoHistory` mais abaixo, junto do resto do mecanismo de
// undo). Inicializados aqui (antes de qualquer interação do usuário) pra que a 1ª ação já seja
// desfazível -- inicializar só na 1ª chamada de `persistState()` capturaria o estado JÁ mutado por
// essa 1ª ação como "baseline", tornando-a não-desfazível.
let mainUndoHistory = createUndoHistory();
/** Verdadeiro só durante a aplicação de um snapshot de undo/redo -- impede que a própria
 * `persistState()` disparada por `applyUndoSnapshot` grave OUTRO snapshot em cima do que acabou de
 * ser restaurado (senão desfazer criaria uma entrada de refazer idêntica à de desfazer, e vice-versa,
 * quebrando a pilha). */
let isApplyingUndoSnapshot = false;
resetUndoHistory(mainUndoHistory);

/** Reconciliação incremental da camada de render. O shell (`appbar` + `.canvas` + `.canvas-content`)
 * é mantido vivo entre renders; as camadas internas são atualizadas sem `app.innerHTML = ""`.
 * Componentes também são cacheados por id para preservar listeners e estado de interação. */
const componentElementsById = new Map<string, HTMLElement>();
/** Mesmo princípio de `componentElementsById` (UI-4) -- o `<polyline>` de cada fio é 100% não-
 * interativo (`pointer-events:none`, ver `render()`), sem listener nenhum pra se preocupar em
 * recriar com closure obsoleta; reaproveitar via Map em vez de recriar do zero a cada `render()`
 * evita `createElementNS`+5 atributos por fio em circuitos grandes. As alças de segmento/canto
 * (`renderWireSegmentHandles`/`renderWireCornerHandles`) continuam recriadas -- têm listener próprio
 * capturando `points`/`index` da chamada atual, mexer nisso é um risco de interação bem maior pra um
 * ganho bem menor (poucas alças por fio vs. potencialmente centenas de fios). */
const wirePolylineElementsById = new Map<string, SVGPolylineElement>();
const wireSpatialIndex = new WireSpatialIndex(64);
const wireSpatialSignatures = new Map<string, string>();
let appBarElement: HTMLElement | undefined;
let canvasElement: HTMLDivElement | undefined;
let canvasContentElement: HTMLDivElement | undefined;
let wireLayerElement: SVGSVGElement | undefined;

const UI_TEXT = {
  "pt-BR": {
    nothingSelected: "Nada selecionado",
    wireLabel: "Fio",
    openProject: "Abrir projeto",
    saveProject: "Salvar projeto",
    runSimulation: "Iniciar simulação",
    pauseSimulation: "Pausar simulação",
    stopSimulation: "Parar simulação",
    componentProperties: "Propriedades do componente",
    deleteSelectedWire: "Apagar fio selecionado",
    deleteSelectedComponent: "Apagar componente selecionado",
    deleteSelectedItems: "Apagar selecionados",
    running: "Rodando",
    paused: "Pausado",
    stopped: "Parado",
    properties: "Propriedades",
    copy: "Copiar",
    cut: "Cortar",
    paste: "Colar",
    undo: "Desfazer",
    redo: "Refazer",
    remove: "Remover",
    delete: "Excluir",
    deleteWire: "Excluir fio",
    rotate: "Rotacionar",
    rotateCw: "Girar no sentido horario",
    rotateCcw: "Girar no sentido anti-horario",
    rotate180: "Girar 180°",
    flipHorizontal: "Inverter horizontalmente",
    flipVertical: "Inverter verticalmente",
    help: "Ajuda",
    show: "Mostrar",
    title: "Título:",
    visual: "Visual",
    principal: "Principal",
    shortcut: "Atalho",
    reading: "Leitura",
    measuredVoltage: "Tensao Medida",
    showName: "Mostrar nome",
    showValue: "Mostrar valor",
    noProperties: "Nenhuma propriedade disponivel nesta aba.",
    type: "Type",
    uid: "Uid",
    openSubcircuit: "Abrir Subcircuito",
    chooseSubcircuitFile: "Procurar...",
    noSubcircuitFileChosen: "(nenhum)",
    locateSubcircuitFile: "Localizar arquivo do subcircuito...",
    linkToTunnel: "Vincular a túnel...",
    unlinkTunnel: "Desvincular túnel",
    noTunnelsInScene: "(nenhum túnel na cena)",
    loadFirmware: "Carregar firmware",
    openSerialMonitor: "Abrir monitor serial",
    firmwareGroup: "Firmware",
    firmwarePath: "Firmware (.bin/.elf)",
    qemuBinary: "Binario QEMU",
    boardMode: "Modo Placa",
    exposed: "Exposto",
    selectExposedComponents: "Selecione os Componentes expostos",
    exposedComponentsDialogTitle: "Componentes Expostos",
    exposedComponentsConfirm: "OK",
    exposedComponentsCancel: "Cancelar",
    exposedComponentsSelectAll: "Selecionar todos",
    exposedComponentsClearAll: "Limpar seleção",
    notGraphicalHint: "(sem efeito visual no Modo Placa)",
    createSubcircuit: "Criar Subcircuito da Seleção",
    selectAll: "Selecionar tudo",
    unknownComponent: "Componente desconhecido",
    zoomFitSelection: "Ajustar zoom à seleção",
    zoomFitAll: "Ajustar zoom a tudo",
    zoomReset: "Zoom 1:1",
    exportImage: "Salvar Esquemático como Imagem (SVG)",
    importCircuit: "Importar Circuito...",
    editingSubcircuit: "Editando subcircuito:",
    backToMainCircuit: "Voltar ao Circuito Principal",
  },
  en: {
    nothingSelected: "Nothing selected",
    wireLabel: "Wire",
    openProject: "Open project",
    saveProject: "Save project",
    runSimulation: "Run simulation",
    pauseSimulation: "Pause simulation",
    stopSimulation: "Stop simulation",
    componentProperties: "Component properties",
    deleteSelectedWire: "Delete selected wire",
    deleteSelectedComponent: "Delete selected component",
    deleteSelectedItems: "Delete selected items",
    running: "Running",
    paused: "Paused",
    stopped: "Stopped",
    properties: "Properties",
    copy: "Copy",
    cut: "Cut",
    paste: "Paste",
    undo: "Undo",
    redo: "Redo",
    remove: "Remove",
    delete: "Delete",
    deleteWire: "Delete wire",
    rotate: "Rotate",
    rotateCw: "Rotate clockwise",
    rotateCcw: "Rotate counter-clockwise",
    rotate180: "Rotate 180°",
    flipHorizontal: "Flip horizontally",
    flipVertical: "Flip vertically",
    help: "Help",
    show: "Show",
    title: "Title:",
    visual: "Visual",
    principal: "Main",
    shortcut: "Shortcut",
    reading: "Reading",
    measuredVoltage: "Measured Voltage",
    showName: "Show name",
    showValue: "Show value",
    noProperties: "No properties available in this tab.",
    type: "Type",
    uid: "Uid",
    openSubcircuit: "Open Subcircuit",
    chooseSubcircuitFile: "Browse...",
    noSubcircuitFileChosen: "(none)",
    locateSubcircuitFile: "Locate subcircuit file...",
    linkToTunnel: "Link to tunnel...",
    unlinkTunnel: "Unlink tunnel",
    noTunnelsInScene: "(no tunnels in scene)",
    loadFirmware: "Load firmware",
    openSerialMonitor: "Open serial monitor",
    firmwareGroup: "Firmware",
    firmwarePath: "Firmware (.bin/.elf)",
    qemuBinary: "QEMU binary",
    boardMode: "Board Mode",
    exposed: "Exposed",
    selectExposedComponents: "Select Exposed Components",
    exposedComponentsDialogTitle: "Exposed Components",
    exposedComponentsConfirm: "OK",
    exposedComponentsCancel: "Cancel",
    exposedComponentsSelectAll: "Select all",
    exposedComponentsClearAll: "Clear selection",
    notGraphicalHint: "(no visual effect in Board Mode)",
    createSubcircuit: "Create Subcircuit from Selection",
    selectAll: "Select all",
    unknownComponent: "Unknown component",
    zoomFitSelection: "Zoom to selection",
    zoomFitAll: "Zoom to fit all",
    zoomReset: "Zoom 1:1",
    exportImage: "Save Schematic as Image (SVG)",
    importCircuit: "Import Circuit...",
    editingSubcircuit: "Editing subcircuit:",
    backToMainCircuit: "Back to Main Circuit",
  },
} as const;

function currentLocale(): "pt-BR" | "en" {
  return state.locale === "en" ? "en" : "pt-BR";
}

function t(key: keyof typeof UI_TEXT["pt-BR"]): string {
  return UI_TEXT[currentLocale()][key];
}

let readoutsByComponentId: Record<string, ComponentReadoutValue> = {};
// Histórico APROXIMADO (1 amostra por poll de IPC, ~300ms de parede, sem relação com o tempo
// SIMULADO do circuito) -- só pra pré-visualização PEQUENA no canvas (`scopePanelSvg`/
// `logicAnalyzerPanelSvg`), onde não compensa buscar o histórico real de alta resolução pra todo
// instrumento do projeto a cada poll. A janela "Expande" usa `realScopeHistoryByComponentId`/
// `realLogicHistoryByComponentId` abaixo (tempo SIMULADO de verdade, ver `requestInstrumentHistory`).
let scopeHistoryByComponentId: Record<string, number[][]> = {};
let logicHistoryByComponentId: Record<string, number[]> = {};
const INSTRUMENT_POLL_INTERVAL_MS = 300;
const INSTRUMENT_HISTORY_DEPTH = 600;

// Histórico REAL (tempo simulado de verdade, `Scheduler::nowNs()` do Core -- ver `core/src/
// components/meters/Oscope.hpp`/`LogicAnalyzer.hpp`) -- buscado via `requestInstrumentHistory` só
// pros componentes com janela "Expande" ABERTA (ver `toggleInstrumentPopup`/`updateReadoutHistories`),
// nunca pra todo instrumento do projeto (histórico real pode ter centenas de amostras, desperdício
// pra quem não abriu a janela). Resolve a limitação documentada antes desta data: o eixo de tempo
// da janela "Expande" agora é de verdade, não uma aproximação sobre o intervalo de poll de IPC.
const realScopeHistoryByComponentId = new Map<string, Array<{ timestampsNs: number[]; values: number[] }>>();
const realLogicHistoryByComponentId = new Map<string, { timestampsNs: number[]; masks: number[] }>();
let voltagesByWireId: Record<string, number> = {};
let pendingWirePreviewTarget: Point | undefined;
let pendingWireRoute: Point[] = [];
let pendingWireBendLengths: number[] = [];
let wireSegmentDrag:
  | {
      wireId: string;
      segmentIndex: number;
      axis: "x" | "y";
      startFullPoints: Point[];
      moved: boolean;
    }
  | undefined;
let wireCornerDrag:
  | {
      wireId: string;
      pointIndex: number;
      startFullPoints: Point[];
      moved: boolean;
    }
  | undefined;
let selectedWireSegment:
  | {
      wireId: string;
      segmentIndex: number;
    }
  | undefined;
let selectedWireCorner:
  | {
      wireId: string;
      pointIndex: number;
    }
  | undefined;
/** Um arrasto real (canto/segmento com `drag.moved === true`) dispara um `click` sintético logo
 * depois em alguns navegadores/plataformas mesmo com bastante deslocamento -- sem esta trava, esse
 * clique cairia no novo gesto "clicar num fio sempre inicia uma derivação" (ver
 * `renderWireCornerHandles`/`renderWireSegmentHandles`) e criaria uma junção indesejada logo após
 * mover um fio. Setado no `finish()` de cada arrasto quando `moved===true`, consumido (e resetado)
 * no início do próximo `click`. */
let suppressNextWireInteractionClick = false;
let simulationStatus: SimulationStatus = "stopped";
/** Taxa real alcançada (ver `messages.ts::simulationRate`) -- `undefined` == sem leitura ainda ou
 * simulação parada, mostra só o rótulo de status sem número junto. */
let simulationRate: number | undefined;
let activePropertyTarget:
  | { kind: "project"; componentId: string }
  | { kind: "exposed-internal"; outerComponentId: string; sourceId: string; snapshot: InternalComponentSnapshot; model: WebviewComponentModel }
  | undefined;
let propertyDialogShowAll = false;
let clipboardItems: { components: WebviewComponentModel[]; wires: WebviewWireModel[] } | undefined;
const activePushShortcutIds = new Set<string>();
/** `true` durante QUALQUER gesto de arrastar componente em andamento (mouse ainda pressionado) --
 * mesmo com shell persistente, o render de telemetria pode trocar SVG interno e estado visual no
 * meio de um gesto que depende de `setPointerCapture()`/listeners `pointermove`/`pointerup`.
 * Como `componentReadout`/`wireVoltages` chegam a cada ~300ms DURANTE a simulação e cada um chama
 * `render()` sem condição, um arrasto em andamento durante a simulação era interrompido a cada
 * poll -- o usuário só conseguia mover um pedacinho por vez, "soltar e começar de novo" a cada
 * ~300ms (bug relatado 2026-06-30). Enquanto isto for `true`, esses dois handlers pulam o
 * `render()` (ainda atualizam os dados em cache -- a tela só fica "atrasada" até o solte do mouse,
 * que já chama `render()` no fim do gesto). */
let isDraggingComponent = false;

/** Guarda de render concorrente GENÉRICA (UI-1) -- `true` durante QUALQUER gesto de arrastar em
 * andamento (componente OU canto/segmento de fio, ver `wireCornerDrag`/`wireSegmentDrag`), não só
 * componente. Motivo é o mesmo de `isDraggingComponent` (telemetria chegando a cada ~300ms durante a
 * simulação chamaria `render()` sem condição, atropelando o gesto em andamento) -- antes só cobria
 * arrasto de componente, então um `render()` de telemetria no meio de um arrasto de fio (agora
 * incremental via `updateWireVisual`, ver UI-2/UI-3) reconstruiria o canvas inteiro à toa. */
function isInteractiveGestureInProgress(): boolean {
  return isDraggingComponent || wireCornerDrag !== undefined || wireSegmentDrag !== undefined;
}
type ExternalLabelKind = "id" | "value";
let selectedTextLabel: { componentId: string; kind: ExternalLabelKind } | undefined;

// Modo de posicionamento de componente (SimulIDE-style: clicar na paleta → mover → clicar no canvas).
let placingTypeId: string | null = null;
let placementGhostEl: HTMLElement | null = null;

let subcircuitBoardMode = false;
const circuitTransformByComponentId = new Map<string, ComponentTransform>();

function isBoardModeVisible(component: WebviewComponentModel): boolean {
  return isBoardModeVisibleShared(component, (typeId) => catalogEntryFor(typeId)?.graphical === true);
}

function syncBoardVisualFromLiveComponents(): void {
  if (!subcircuitBoardMode) return;
  captureBoardTransforms(state.components, isBoardModeVisible);
}

function projectCircuitTransformsForHost(): WebviewProjectState {
  if (!subcircuitBoardMode) return state;
  syncBoardVisualFromLiveComponents();
  const projected = structuredClone(state);
  restoreCircuitTransforms(projected.components, circuitTransformByComponentId);
  return projected;
}

function setSubcircuitBoardMode(enabled: boolean): void {
  if (!state.subcircuitEditingContext || enabled === subcircuitBoardMode) return;
  cancelActiveTool();
  clearSelection();
  if (enabled) {
    circuitTransformByComponentId.clear();
    for (const [id, transform] of captureCircuitTransforms(state.components)) circuitTransformByComponentId.set(id, transform);
    applyBoardTransforms(state.components, isBoardModeVisible);
    subcircuitBoardMode = true;
  } else {
    syncBoardVisualFromLiveComponents();
    restoreCircuitTransforms(state.components, circuitTransformByComponentId);
    subcircuitBoardMode = false;
    circuitTransformByComponentId.clear();
    persistState();
  }
  render();
}

function restoreBoardViewAfterHostSync(): void {
  if (!subcircuitBoardMode) return;
  if (!state.subcircuitEditingContext) {
    subcircuitBoardMode = false;
    circuitTransformByComponentId.clear();
    return;
  }
  circuitTransformByComponentId.clear();
  for (const [id, transform] of captureCircuitTransforms(state.components)) circuitTransformByComponentId.set(id, transform);
  applyBoardTransforms(state.components, isBoardModeVisible);
}

function openExposedComponentsDialog(): void {
  if (!state.subcircuitEditingContext) return;
  const dialog = document.createElement("dialog");
  dialog.className = "exposed-components-dialog";
  const form = document.createElement("form");
  form.method = "dialog";
  form.className = "exposed-components-form";
  const title = document.createElement("h2");
  title.textContent = t("exposedComponentsDialogTitle");
  form.appendChild(title);
  const list = document.createElement("div");
  list.className = "exposed-components-list";
  const choices = new Map<string, HTMLInputElement>();
  for (const component of state.components.filter((entry) => !entry.hidden && entry.typeId !== "other.package" && !entry.packageIconRole)) {
    const row = document.createElement("label");
    row.className = "exposed-components-row";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = component.exposed === true;
    choices.set(component.id, input);
    const text = document.createElement("span");
    text.textContent = `${component.label} (${component.id})${catalogEntryFor(component.typeId)?.graphical === true ? "" : ` ${t("notGraphicalHint")}`}`;
    row.append(input, text);
    list.appendChild(row);
  }
  form.appendChild(list);
  const actions = document.createElement("div");
  actions.className = "exposed-components-actions";
  const selectAll = document.createElement("button");
  selectAll.type = "button"; selectAll.textContent = t("exposedComponentsSelectAll");
  selectAll.onclick = () => choices.forEach((input) => { input.checked = true; });
  const clearAll = document.createElement("button");
  clearAll.type = "button"; clearAll.textContent = t("exposedComponentsClearAll");
  clearAll.onclick = () => choices.forEach((input) => { input.checked = false; });
  const cancel = document.createElement("button");
  cancel.type = "button"; cancel.textContent = t("exposedComponentsCancel"); cancel.onclick = () => dialog.close("cancel");
  const confirm = document.createElement("button");
  confirm.type = "submit"; confirm.value = "confirm"; confirm.textContent = t("exposedComponentsConfirm");
  actions.append(selectAll, clearAll, cancel, confirm);
  form.appendChild(actions);
  dialog.appendChild(form);
  dialog.addEventListener("close", () => {
    if (dialog.returnValue === "confirm") {
      applyExposedSelection(state.components, new Set([...choices].filter(([, input]) => input.checked).map(([id]) => id)));
      persistState();
      render();
    }
    dialog.remove();
  });
  document.body.appendChild(dialog);
  dialog.showModal();
}

const propertyDialog = document.createElement("dialog");
propertyDialog.className = "property-dialog";
document.body.appendChild(propertyDialog);
propertyDialog.addEventListener("click", (event) => {
  if (event.target === propertyDialog) propertyDialog.close();
});
propertyDialog.addEventListener("close", () => {
  activePropertyTarget = undefined;
});

const contextMenu = document.createElement("div");
contextMenu.className = "context-menu";
contextMenu.hidden = true;
document.body.appendChild(contextMenu);

// Ghost do modo de posicionamento: posição absoluta na tela, segue o cursor.
document.addEventListener("pointermove", (event) => {
  if (!placingTypeId || !placementGhostEl) return;
  const zoom = state.viewport.zoom || 1;
  const box = componentBox(placingTypeId, {});
  const w = box.width * zoom;
  const h = box.height * zoom;
  placementGhostEl.style.left = `${event.clientX - w / 2}px`;
  placementGhostEl.style.top = `${event.clientY - h / 2}px`;
  placementGhostEl.style.width = `${w}px`;
  placementGhostEl.style.height = `${h}px`;
});

/** Popups de submenu (ver `renderContextMenuItems`) são anexados direto em `document.body`, fora de
 * `contextMenu` (pra não ficarem limitados pela largura/altura do menu pai) -- por isso precisam
 * ser removidos do DOM explicitamente ao fechar o menu, senão acumulam elementos órfãos a cada
 * abertura de um menu com submenu. */
let openSubmenuPopups: HTMLElement[] = [];

function hideContextMenu(): void {
  contextMenu.hidden = true;
  contextMenu.innerHTML = "";
  for (const submenu of openSubmenuPopups) submenu.remove();
  openSubmenuPopups = [];
}

window.addEventListener("click", () => hideContextMenu());
window.addEventListener("blur", () => hideContextMenu());

/** Overlay de Modo Placa no circuito PRINCIPAL -- componentes "graphical" expostos de uma instância com
 * `properties.boardModeEnabled === true` são desenhados sobre a foto do package, na posição
 * `boardVisual`, e ficam clicáveis durante a simulação (ver `subpackage.cpp::setBoardMode()` real).
 * Cache por componentId OUTER -- buscado sob demanda (`ensureBoardOverlayData`) só quando Modo
 * Placa está ligado pra aquela instância, nunca pra todo subcircuito do projeto. */
const boardOverlayDataByComponentId = new Map<string, InternalComponentSnapshot[]>();

function ensureBoardOverlayData(component: WebviewComponentModel): void {
  if (boardOverlayDataByComponentId.has(component.id)) return;
  const sourceId = catalogEntryFor(component.typeId)?.registeredSourceId;
  if (!sourceId) return;
  boardOverlayDataByComponentId.set(component.id, []); // marca "pedido em andamento" -- evita reenviar a cada render()
  send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestBoardOverlayData", componentId: component.id, sourceId });
}

/** Desenha os componentes "graphical" expostos de `component` (instância com Modo Placa ligado)
 * sobre a foto do package, na posição `boardVisual` RELATIVA à posição da instância no circuito
 * principal. `switches.push`/`switches.switch` ficam clicáveis (igual ao botão EN/BOOT reais
 * durante a simulação) -- a mudança de estado vai direto pro Core via
 * `requestUpdateBoardOverlayProperty` (ver `CoreApplication.cpp::"setSubcircuitChildProperty"`),
 * nunca por `state.components` (estes elementos não fazem parte do circuito do usuário). */
/** Posição padrão pra um componente exposto que AINDA não foi posicionado em Modo Placa nenhuma
 * vez (sem `boardVisual` no `.lssubcircuit`) -- sem isto, marcar "exposto" + ligar "Modo Placa" não
 * mostrava NADA (bug relatado 2026-06-30: usuário esperava ver um retângulo aparecer mesmo sem
 * posicionar manualmente antes). Empilha em coluna à DIREITA da foto do package, na ordem que
 * vieram -- só um ponto de partida razoável; o usuário arrasta pra posição final (ver drag abaixo,
 * que persiste em `boardVisual` na hora). */
function fallbackBoardVisualPosition(packageBox: ComponentBox, index: number): { x: number; y: number } {
  return { x: packageBox.width + 16, y: 8 + index * 64 };
}

function renderBoardOverlaysFor(component: WebviewComponentModel): HTMLElement[] {
  const items = boardOverlayDataByComponentId.get(component.id);
  if (!items || items.length === 0) return [];
  const packageBox = componentBox(component.typeId, component.properties);
  const sourceId = catalogEntryFor(component.typeId)?.registeredSourceId;
  const elements: HTMLElement[] = [];
  let fallbackIndex = 0;
  for (const item of items) {
    if (!item.exposed || !item.graphical) continue;
    const boardVisual = item.boardVisual ?? { ...fallbackBoardVisualPosition(packageBox, fallbackIndex++), rotation: 0 as const };
    const properties: Record<string, string | number | boolean> = { closed: false };
    const box = componentBox(item.typeId, properties);
    const el = document.createElement("div");
    el.className = "component component--board-overlay";
    el.style.left = `${component.x + boardVisual.x}px`;
    el.style.top = `${component.y + boardVisual.y}px`;
    el.style.width = `${box.width}px`;
    el.style.height = `${box.height}px`;
    el.style.transform = `rotate(${boardVisual.rotation}deg)`;
    el.title = item.label;

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
    svg.classList.add("component__symbol");
    svg.innerHTML = packageSymbolSvg(item.typeId, properties, item.id) ?? componentSymbolSvg(item.typeId, properties);
    el.appendChild(svg);

    const isPushButton = interactionKindFor(item.typeId) === "momentary";

    // Arrastar (move/persiste boardVisual) vs apertar/segurar (switches.push) são o MESMO gesto de
    // pointerdown -- pressiona IMEDIATAMENTE (mesma sensação de "segurar" de sempre), mas cancela o
    // aperto se detectar movimento além do limiar e vira arrasto (mesmo princípio de qualquer
    // drag-vs-click, só que aqui o "click" já tem efeito colateral próprio que precisa ser desfeito).
    el.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const startClientX = event.clientX;
      const startClientY = event.clientY;
      const startLeft = component.x + boardVisual.x;
      const startTop = component.y + boardVisual.y;
      let dragging = false;
      let pressed = false;
      const DRAG_THRESHOLD_PX = 4;

      // Estado aberto/fechado vem de `stateFill`/`stateVisible` no `package.simulidePaint` (quando
      // registrado) -- reconstrói o SVG a cada aperto/soltura em vez de só alternar uma classe CSS,
      // senão a primitiva certa (aberta/fechada) nunca troca pro overlay de Modo Placa.
      const setPressed = (value: boolean): void => {
        if (pressed === value) return;
        pressed = value;
        const pressedProperties = { ...properties, closed: value };
        svg.innerHTML = packageSymbolSvg(item.typeId, pressedProperties, item.id) ?? componentSymbolSvg(item.typeId, pressedProperties);
        send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestUpdateBoardOverlayProperty", outerComponentId: component.id, innerComponentId: item.id, name: "closed", value });
      };
      if (isPushButton) setPressed(true);

      const onMove = (moveEvent: PointerEvent): void => {
        const zoom = state.viewport.zoom || 1;
        const dx = (moveEvent.clientX - startClientX) / zoom;
        const dy = (moveEvent.clientY - startClientY) / zoom;
        if (!dragging && Math.hypot(moveEvent.clientX - startClientX, moveEvent.clientY - startClientY) > DRAG_THRESHOLD_PX) {
          dragging = true;
          el.classList.add("dragging");
          isDraggingComponent = true;
          setPressed(false); // movimento detectado -- isto era arrasto, não aperto, desfaz o efeito
        }
        if (dragging) {
          el.style.left = `${startLeft + dx}px`;
          el.style.top = `${startTop + dy}px`;
        }
      };
      const finish = (moveEvent: PointerEvent): void => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        el.classList.remove("dragging");
        isDraggingComponent = false;
        setPressed(false);
        if (!dragging) return;
        const zoom = state.viewport.zoom || 1;
        const dx = (moveEvent.clientX - startClientX) / zoom;
        const dy = (moveEvent.clientY - startClientY) / zoom;
        const newX = boardVisual.x + dx;
        const newY = boardVisual.y + dy;
        const cached = boardOverlayDataByComponentId.get(component.id);
        const cachedItem = cached?.find((entry) => entry.id === item.id);
        if (cachedItem) cachedItem.boardVisual = { x: newX, y: newY, rotation: boardVisual.rotation, flipH: boardVisual.flipH, flipV: boardVisual.flipV };
        if (sourceId) send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestUpdateBoardOverlayVisual", sourceId, innerComponentId: item.id, x: newX, y: newY });
        render();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    });

    elements.push(el);
  }
  return elements;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Undo/Redo (Ctrl+Z/Ctrl+Y) -- 100% client-side, sem verbo IPC dedicado. `state.components`/`wires`
// são mutados livremente pelo resto do arquivo (às vezes por reatribuição imutável, às vezes campo a
// campo direto, ex. `component.x = ...` durante um drag) -- não há como diferenciar "ação distinta"
// por identidade de referência. Em vez disso, aproveita `persistState()` como o funil ÚNICO por onde
// toda mutação relevante já passa (~40 call sites no arquivo, sempre no fim de uma ação discreta ou
// no fim de um drag -- nunca a cada `pointermove` intermediário, ver `onUp` dos handlers de arrasto)
// e compara o conteúdo ANTES/DEPOIS a cada chamada: só empilha um snapshot de undo quando
// `components`/`wires` realmente mudaram desde o último commit (mudança só de seleção não conta,
// senão clicar pra selecionar algo viraria uma ação desfazível).
interface UndoSnapshot {
  components: WebviewComponentModel[];
  topology: CanonicalTopologyDocument;
  selectedComponentIds: string[];
  selectedWireIds: string[];
}

interface UndoHistory {
  undoStack: UndoSnapshot[];
  redoStack: UndoSnapshot[];
  /** Serialização (`components`+`wires`, NUNCA seleção) do último snapshot commitado -- comparado a
   * cada `persistState()` pra decidir se algo que importa mudou. `undefined` até a 1ª chamada. */
  baselineKey: string | undefined;
  baselineSnapshot: UndoSnapshot | undefined;
}

const UNDO_HISTORY_LIMIT = 200;

function createUndoHistory(): UndoHistory {
  return { undoStack: [], redoStack: [], baselineKey: undefined, baselineSnapshot: undefined };
}

function activeUndoHistory(): UndoHistory {
  return mainUndoHistory;
}

function snapshotOfProjectState(project: Pick<WebviewProjectState, "components" | "topology" | "selectedComponentIds" | "selectedWireIds">): UndoSnapshot {
  return {
    components: structuredClone(project.components),
    topology: structuredClone(project.topology),
    selectedComponentIds: [...project.selectedComponentIds],
    selectedWireIds: [...project.selectedWireIds],
  };
}

function captureUndoSnapshot(): UndoSnapshot {
  return snapshotOfProjectState(state);
}

/** Chave de comparação -- só `components`/`topology` (NUNCA seleção, ver comentário da seção). */
function undoContentKey(snapshot: { components: WebviewComponentModel[]; topology: CanonicalTopologyDocument }): string {
  return JSON.stringify([snapshot.components, snapshot.topology]);
}

/** Reseta o histórico (undo E redo) pro estado ATUAL de `state` -- chamado ao entrar/sair da sessão
 * de autoria e na carga inicial, nunca durante edição normal (isso apagaria o histórico do usuário). */
function resetUndoHistory(history: UndoHistory): void {
  history.undoStack = [];
  history.redoStack = [];
  const snapshot = captureUndoSnapshot();
  history.baselineSnapshot = snapshot;
  history.baselineKey = undoContentKey(snapshot);
}

/** Núcleo do commit de undo: `currentKey` é a chave de conteúdo "de agora" (depois da mutação que já
 * aconteceu), comparada contra o último commit (`baselineKey`) -- só empilha (e só CLONA via
 * `captureCurrent`, ver UI-5) se o CONTEÚDO (`components`/`wires`) realmente mudou. `captureCurrent`
 * só é chamada quando precisa MESMO de um snapshot independente (1ª chamada da história, ou
 * conteúdo confirmadamente diferente) -- `currentKey` sozinho (comparação de string, sem clonar
 * nada) já resolve o caso comum de "chamada seguiu só uma troca de seleção, nada mudou de verdade".
 * Compartilhado por dois chamadores: `recordUndoSnapshotIfChanged` (mutação local, ex. `component.x
 * =` num drag, `persistState()` já chamada em seguida) e o handler de `"syncState"` (mutação
 * aplicada pelo HOST, ex. `deleteSelectedItems` fora de autoria só manda
 * `requestRemoveComponent`/`Wire` e espera a Extension devolver o estado já sem o item removido --
 * `state` local nunca muda antes disso, então sem este 2º caminho a remoção nunca viraria uma
 * entrada de undo). */
function recordUndoTransition(currentKey: string, captureCurrent: () => UndoSnapshot): void {
  if (isApplyingUndoSnapshot) return;
  const history = activeUndoHistory();
  if (history.baselineKey === undefined) {
    // 1ª chamada desta história (ver `resetUndoHistory` -- normalmente já cobre isto, mas cobre
    // também o caso de uma história nunca inicializada explicitamente).
    history.baselineSnapshot = captureCurrent();
    history.baselineKey = currentKey;
    return;
  }
  if (currentKey === history.baselineKey) return; // só seleção mudou (ou nada) -- não é undoable, nunca clona
  history.undoStack.push(history.baselineSnapshot!);
  if (history.undoStack.length > UNDO_HISTORY_LIMIT) history.undoStack.shift();
  history.redoStack = []; // qualquer ação nova invalida o redo, igual a qualquer editor de verdade
  history.baselineSnapshot = captureCurrent();
  history.baselineKey = currentKey;
}

/** UI-5: computa a chave de comparação DIRETO do `state` vivo (`JSON.stringify`, sem
 * `structuredClone` primeiro) -- só paga o clone caro (`captureUndoSnapshot`) se a chave realmente
 * diferir da última commitada. A maioria das ~49 chamadas de `persistState()` no arquivo segue uma
 * mudança de SELEÇÃO apenas (nunca vira entrada de undo, ver `undoContentKey`) -- antes clonava
 * `components`/`wires` inteiros só pra descobrir isso a cada uma. */
function recordUndoSnapshotIfChanged(): void {
  const currentKey = undoContentKey(state);
  recordUndoTransition(currentKey, captureUndoSnapshot);
}

/** Aplica um snapshot (de undo OU redo) como o novo `state.components`/`wires`/seleção -- mesmo
 * princípio do handler de `"init"`/`"syncState"` (`state = message.project; render();`), só que sem
 * round-trip pela Extension. Cancela qualquer fio em desenho/seleção de segmento-de-fio em curso
 * (índices/ids ali podem não corresponder mais aos fios restaurados). */
function applyUndoSnapshot(snapshot: UndoSnapshot): void {
  isApplyingUndoSnapshot = true;
  try {
    state.components = snapshot.components;
    state.topology = snapshot.topology;
    state.selectedComponentIds = snapshot.selectedComponentIds;
    state.selectedWireIds = snapshot.selectedWireIds;
    clearPendingWire();
    selectedWireSegment = undefined;
    selectedWireCorner = undefined;
    selectedTextLabel = undefined;
    hideContextMenu();
    persistState();
    render();
  } finally {
    isApplyingUndoSnapshot = false;
  }
}

function undo(): void {
  const history = activeUndoHistory();
  if (history.undoStack.length === 0) return;
  const previous = history.undoStack.pop()!;
  history.redoStack.push(history.baselineSnapshot ?? captureUndoSnapshot());
  history.baselineSnapshot = previous;
  history.baselineKey = undoContentKey(previous);
  applyUndoSnapshot(previous);
}

function redo(): void {
  const history = activeUndoHistory();
  if (history.redoStack.length === 0) return;
  const next = history.redoStack.pop()!;
  history.undoStack.push(history.baselineSnapshot ?? captureUndoSnapshot());
  history.baselineSnapshot = next;
  history.baselineKey = undoContentKey(next);
  applyUndoSnapshot(next);
}
// ────────────────────────────────────────────────────────────────────────────────────────────────

function persistState(): void {
  syncBoardVisualFromLiveComponents();
  recordUndoSnapshotIfChanged();
  const persisted = projectCircuitTransformsForHost();
  vscode?.setState(persisted);
  const outbound: WebviewToHostMessage = { version: WEBVIEW_MESSAGE_VERSION, type: "projectChanged", project: persisted };
  vscode?.postMessage(outbound);
}

function send(message: WebviewToHostMessage): void {
  vscode?.postMessage(message);
}

function isComponentSelected(componentId: string): boolean {
  return state.selectedComponentIds.includes(componentId);
}

function isWireSelected(wireId: string): boolean {
  return state.selectedWireIds.includes(wireId);
}

function isWireSegmentSelected(wireId: string, segmentIndex: number): boolean {
  return selectedWireSegment?.wireId === wireId && selectedWireSegment.segmentIndex === segmentIndex;
}

function isWireCornerSelected(wireId: string, pointIndex: number): boolean {
  return selectedWireCorner?.wireId === wireId && selectedWireCorner.pointIndex === pointIndex;
}

function isTextLabelSelected(componentId: string, kind: ExternalLabelKind): boolean {
  return selectedTextLabel?.componentId === componentId && selectedTextLabel.kind === kind;
}

function getSelectedComponents(): WebviewComponentModel[] {
  return state.components.filter((component) => state.selectedComponentIds.includes(component.id));
}

function dragSelectionWithLinkedPinLabels(): WebviewComponentModel[] {
  const selected = getSelectedComponents();
  const byId = new Map(selected.map((component) => [component.id, component]));
  for (const component of selected) {
    if (component.typeId !== "other.package_pin") continue;
    const linkedLabel = state.components.find((candidate) => candidate.typeId === "graphics.text" && candidate.properties.linkedPinComponentId === component.id);
    if (linkedLabel && !byId.has(linkedLabel.id)) byId.set(linkedLabel.id, linkedLabel);
  }
  return [...byId.values()];
}

/** Primeiro componente selecionado — usado por operações que só fazem sentido pra UM (atalho `r` sem
 * Ctrl, herdado de quando a seleção era singular; abrir o diálogo de propriedades por `Enter`/`P`). */
function getSelectedComponent(): WebviewComponentModel | undefined {
  return getSelectedComponents()[0];
}

function selectOnlyComponent(componentId: string): void {
  state.selectedComponentIds = [componentId];
  state.selectedWireIds = [];
  selectedWireSegment = undefined;
  selectedWireCorner = undefined;
  selectedTextLabel = undefined;
}

function selectOnlyWire(wireId: string, segmentIndex?: number): void {
  state.selectedComponentIds = [];
  state.selectedWireIds = [wireId];
  selectedWireSegment = segmentIndex === undefined ? undefined : { wireId, segmentIndex };
  selectedWireCorner = undefined;
  selectedTextLabel = undefined;
}

function selectOnlyWireCorner(wireId: string, pointIndex: number): void {
  state.selectedComponentIds = [];
  state.selectedWireIds = [wireId];
  selectedWireSegment = undefined;
  selectedWireCorner = { wireId, pointIndex };
  selectedTextLabel = undefined;
}

function selectOnlyTextLabel(componentId: string, kind: ExternalLabelKind): void {
  state.selectedComponentIds = [];
  state.selectedWireIds = [];
  selectedWireSegment = undefined;
  selectedWireCorner = undefined;
  selectedTextLabel = { componentId, kind };
}

/** Shift+click: alterna um componente dentro/fora de uma seleção múltipla já existente — convenção
 * comum de desktop, não verificada item-a-item contra o SimulIDE (ver `.spec` seção 13.4). */
function toggleComponentSelection(componentId: string): void {
  selectedWireSegment = undefined;
  selectedWireCorner = undefined;
  selectedTextLabel = undefined;
  state.selectedComponentIds = isComponentSelected(componentId)
    ? state.selectedComponentIds.filter((id) => id !== componentId)
    : [...state.selectedComponentIds, componentId];
}

/** Shift/Ctrl+click em fio preserva componentes já selecionados, permitindo mover uma seleção
 * heterogênea como um grupo. Segmento/canto individual deixa de ser o modelo de seleção neste
 * gesto; o condutor inteiro entra ou sai da seleção. */
function toggleWireSelection(wireId: string): void {
  selectedWireSegment = undefined;
  selectedWireCorner = undefined;
  selectedTextLabel = undefined;
  state.selectedWireIds = isWireSelected(wireId)
    ? state.selectedWireIds.filter((id) => id !== wireId)
    : [...state.selectedWireIds, wireId];
}

/** "" (nada) parado/sem amostra; senão "(0.9x)"/"(120%)" -- mesmo espírito de `InfoWidget::setRate()`
 * real do SimulIDE (percentual da velocidade real), achado de auditoria de UI 2026-07-09. */
function simulationRateText(): string {
  if (simulationRate === undefined || simulationStatus !== "running") return "";
  return ` (${Math.round(simulationRate * 100)}%)`;
}

/** Atualização pontual do número de taxa SEM `render()` completo -- chega a cada ~300ms enquanto
 * roda, um `render()` inteiro nessa cadência seria desperdício (mesmo raciocínio de
 * `updateWiresTouchingComponent` em vez de reconstruir tudo). */
function updateSimulationRateLabel(): void {
  const rateLabel = appBarElement?.querySelector<HTMLElement>(".appbar__status-rate");
  if (rateLabel) rateLabel.textContent = simulationRateText();
}

function selectionLabel(): string {
  if (selectedTextLabel) {
    const activeLabel = selectedTextLabel;
    const component = state.components.find((entry) => entry.id === activeLabel.componentId);
    const suffix = activeLabel.kind === "id" ? "name" : "value";
    return component ? `${component.label} (${suffix})` : t("nothingSelected");
  }
  const components = getSelectedComponents();
  const wires = state.selectedWireIds;
  const total = components.length + wires.length;
  if (total === 0) return t("nothingSelected");
  if (total === 1) return components[0]?.label ?? `${t("wireLabel")} ${wires[0]}`;
  return `${total} itens selecionados`;
}

function clearSelection(): void {
  state.selectedComponentIds = [];
  state.selectedWireIds = [];
  selectedWireSegment = undefined;
  selectedWireCorner = undefined;
  selectedTextLabel = undefined;
}

function clearPendingWire(): void {
  state.pendingConnection = undefined;
  pendingWirePreviewTarget = undefined;
  pendingWireRoute = [];
  pendingWireBendLengths = [];
}

/** Ponto único de cancelamento da ferramenta ativa (derivação de fio EM ANDAMENTO ou posicionamento
 * de componente) -- Esc/botão direito/troca de ferramenta chamam SÓ isto, nunca mexem nas duas flags
 * na mão. Antes desta função, entrar em modo de posicionamento não cancelava um draft de fio em
 * andamento (nem o inverso) -- os dois podiam coexistir, e o primeiro Esc só derrubava um dos dois
 * (achado real de auditoria: `docs/27-analise-critica-fios-vs-auditoria-2026-07-11.md`, seção "Análise
 * da FSM" -- preview de fio ficava visível sobre o componente recém-posicionado até um SEGUNDO Esc).
 * As duas ferramentas são MUTUAMENTE EXCLUSIVAS por construção agora: nenhum caminho de entrada em
 * uma delas (`beginWireDraft`/`beginPlacementMode` abaixo) deixa a outra ativa. */
function cancelActiveTool(): void {
  clearPendingWire();
  exitPlacementMode();
}

/** Único ponto de entrada em "derivar fio" (clique num pino livre ou em cima de outro fio) --
 * cancela posicionamento de componente em andamento antes, pra nunca deixar as duas ferramentas
 * simultaneamente ativas (ver `cancelActiveTool`). */
function beginWireDraft(origin: NonNullable<WebviewProjectState["pendingConnection"]>): void {
  if (placingTypeId) exitPlacementMode();
  state.pendingConnection = origin;
  pendingWireRoute = [];
  pendingWireBendLengths = [];
}

type WireGestureOrigin =
  | { kind: "pin"; componentId: string; pinId: string; point: Point }
  | { kind: "wire"; wireId: string; point: Point };

/** Ponto único de decisão pra clicar num alvo de conexão JÁ EXISTENTE (pino, meio-de-segmento,
 * canto, ou junção) -- antes desta função, cada um dos quatro handles tinha sua PRÓPRIA cópia quase
 * idêntica desta lógica (checar `placingTypeId`, checar `suppressNextWireInteractionClick`, decidir
 * "terminar a conexão pendente aqui" vs "começar um draft novo daqui"), e só o pino tratava
 * corretamente o caso de re-clicar na própria origem pra cancelar. Início de draft é SEMPRE local
 * (nunca mais um round-trip `requestStartWireFromWire` pela Extension só pra armar
 * `pendingConnection` -- é estado 100% transitório da Webview, `beginWireDraft` já bastava pro caso
 * de pino, agora serve pros quatro). Terminar (`state.pendingConnection` já setado) SEMPRE passa
 * pelo Core via `requestConnectEndpoints` -- isso sim precisa de round-trip, é o único momento em
 * que a topologia de verdade muda. */
function handleWireGestureClick(target: WireGestureOrigin): void {
  if (placingTypeId) return;
  if (suppressNextWireInteractionClick) {
    suppressNextWireInteractionClick = false;
    return;
  }

  if (!state.pendingConnection) {
    if (target.kind === "pin") {
      beginWireDraft({ kind: "pin", componentId: target.componentId, pinId: target.pinId });
      selectOnlyComponent(target.componentId);
    } else {
      beginWireDraft({ kind: "wire", wireId: target.wireId, point: target.point });
      clearSelection();
    }
    pendingWirePreviewTarget = target.point;
    persistState();
    render();
    return;
  }

  const pending = state.pendingConnection;
  if (target.kind === "pin" && pending.kind !== "wire" && pending.componentId === target.componentId && pending.pinId === target.pinId) {
    // Re-clicar na MESMA origem cancela o draft -- só faz sentido pra pino (um ponto discreto e
    // nomeado); meio-de-fio/junção não tem essa noção de "clicar 2x no mesmo lugar", Esc já cobre.
    clearPendingWire();
    persistState();
    render();
    return;
  }

  send({
    version: WEBVIEW_MESSAGE_VERSION,
    type: "requestConnectEndpoints",
    baseRevision: state.topology.revision ?? 0,
    from: pending.kind === "wire" ? pending : { kind: "pin", componentId: pending.componentId, pinId: pending.pinId },
    to: target.kind === "pin" ? { kind: "pin", componentId: target.componentId, pinId: target.pinId } : { kind: "wire", wireId: target.wireId, point: target.point },
    points: pendingWirePointsForTarget(target.point),
  });
  clearPendingWire();
  vscode?.setState(state);
  render();
}

function openSelectedProperties(): void {
  const component = getSelectedComponent();
  if (component) openPropertyDialog(component);
}

function openPropertyDialog(component: WebviewComponentModel): void {
  activePropertyTarget = { kind: "project", componentId: component.id };
  propertyDialog.innerHTML = "";
  propertyDialog.append(renderPropertySheet(component));
  if (!propertyDialog.open) propertyDialog.showModal();
}

function snapshotToDialogComponent(snapshot: InternalComponentSnapshot): WebviewComponentModel {
  return {
    id: snapshot.id,
    typeId: snapshot.typeId,
    label: snapshot.label,
    x: 0,
    y: 0,
    rotation: 0,
    pins: [],
    properties: { ...snapshot.properties },
  };
}

function openExposedInternalPropertyDialog(outerComponentId: string, sourceId: string, snapshot: InternalComponentSnapshot): void {
  const model = snapshotToDialogComponent(snapshot);
  activePropertyTarget = { kind: "exposed-internal", outerComponentId, sourceId, snapshot, model };
  propertyDialog.innerHTML = "";
  propertyDialog.append(
    renderPropertySheet(model, {
      titleText: `Propriedades de ${snapshot.label}`,
      allowTitleEdit: false,
      showVisibilityToggle: false,
      onPropertyChange: (key, value) => {
        snapshot.properties[key] = value;
        model.properties[key] = value;
        send({
          version: WEBVIEW_MESSAGE_VERSION,
          type: "requestUpdateExposedComponentProperty",
          outerComponentId,
          sourceId,
          innerComponentId: snapshot.id,
          name: key,
          value,
        });
      },
    }),
  );
  if (!propertyDialog.open) propertyDialog.showModal();
}

function refreshOpenPropertyDialog(): void {
  if (!propertyDialog.open || !activePropertyTarget) return;
  const target = activePropertyTarget;
  if (target.kind === "project") {
    const component = state.components.find((entry) => entry.id === target.componentId);
    if (!component) {
      propertyDialog.close();
      return;
    }
    openPropertyDialog(component);
    return;
  }
  openExposedInternalPropertyDialog(
    target.outerComponentId,
    target.sourceId,
    target.snapshot,
  );
}

type ContextMenuIconKind = "copy" | "cut" | "remove" | "properties" | "rotateCw" | "rotateCcw" | "rotate180" | "flipHorizontal" | "flipVertical";

type ContextMenuItem =
  | { kind: "separator" }
  | { label: string; onClick: () => void; disabled?: boolean; icon?: ContextMenuIconKind; shortcut?: string; checked?: boolean }
  /** Submenu (ex: um item por componente exposto da instância, cada um com suas próprias ações --
   * ver `buildExposedComponentMenuItems`) -- aberto ao passar o mouse, mesmo princípio de qualquer
   * menu nativo de SO. `icon`/`disabled` reaproveitados do item de ação pra não duplicar campos. */
  | { label: string; items: ContextMenuItem[]; icon?: ContextMenuIconKind; disabled?: boolean };

function renderContextMenuIcon(kind?: ContextMenuIconKind): HTMLSpanElement {
  const wrapper = document.createElement("span");
  wrapper.className = "context-menu__icon";
  if (!kind) return wrapper;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");

  switch (kind) {
    case "copy":
      svg.innerHTML = '<rect x="8" y="7" width="10" height="13" rx="1.5"></rect><path d="M6 17H5.5A1.5 1.5 0 0 1 4 15.5v-10A1.5 1.5 0 0 1 5.5 4h8A1.5 1.5 0 0 1 15 5.5V6"></path>';
      break;
    case "cut":
      svg.innerHTML = '<circle cx="6.5" cy="6.5" r="2"></circle><circle cx="6.5" cy="17.5" r="2"></circle><path d="M8.2 7.7 19 18"></path><path d="M8.2 16.3 19 6"></path>';
      break;
    case "remove":
      svg.innerHTML = '<path d="M7 7l10 10"></path><path d="M17 7 7 17"></path>';
      break;
    case "properties":
      svg.innerHTML = '<circle cx="12" cy="12" r="3"></circle><path d="M12 3v3"></path><path d="M12 18v3"></path><path d="M3 12h3"></path><path d="M18 12h3"></path><path d="m5.6 5.6 2.1 2.1"></path><path d="m16.3 16.3 2.1 2.1"></path><path d="m18.4 5.6-2.1 2.1"></path><path d="m7.7 16.3-2.1 2.1"></path>';
      break;
    case "rotateCw":
      svg.innerHTML = '<path d="M17 7h4V3"></path><path d="M20 7a8 8 0 1 0 1 5"></path>';
      break;
    case "rotateCcw":
      svg.innerHTML = '<path d="M7 7H3V3"></path><path d="M4 7a8 8 0 1 1-1 5"></path>';
      break;
    case "rotate180":
      svg.innerHTML = '<path d="M17 8a5 5 0 0 0-10 0v7"></path><path d="m4 12 3 3 3-3"></path><path d="M14 17h6"></path>';
      break;
    case "flipHorizontal":
      svg.innerHTML = '<path d="M12 4v16"></path><path d="M4 12h16"></path><path d="m8 8-4 4 4 4"></path><path d="m16 8 4 4-4 4"></path>';
      break;
    case "flipVertical":
      svg.innerHTML = '<path d="M4 12h16"></path><path d="M12 4v16"></path><path d="m8 8 4-4 4 4"></path><path d="m8 16 4 4 4-4"></path>';
      break;
  }

  wrapper.appendChild(svg);
  return wrapper;
}

function isSubmenuItem(item: ContextMenuItem): item is Extract<ContextMenuItem, { items: ContextMenuItem[] }> {
  return "items" in item;
}

/** Preenche `container` (menu de topo OU um popup de submenu) com `items` -- recursivo: um item
 * `items` (sem `onClick`) vira um submenu aberto ao passar o mouse, com seu PRÓPRIO popup
 * `context-menu--submenu` anexado a `document.body` (não dentro do pai, pra não ficar limitado pela
 * largura/altura dele) e posicionado à direita do botão que o abriu. */
function renderContextMenuItems(container: HTMLElement, items: ContextMenuItem[]): void {
  container.innerHTML = "";
  for (const item of items) {
    if ("kind" in item && item.kind === "separator") {
      const separator = document.createElement("div");
      separator.className = "context-menu__separator";
      container.appendChild(separator);
      continue;
    }
    if (isSubmenuItem(item)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "context-menu__item";
      button.disabled = item.disabled ?? false;
      button.appendChild(renderContextMenuIcon(item.icon));
      const label = document.createElement("span");
      label.className = "context-menu__label";
      label.textContent = item.label;
      const arrow = document.createElement("span");
      arrow.className = "context-menu__submenu-arrow";
      arrow.textContent = "▶";
      button.append(label, arrow);

      const submenu = document.createElement("div");
      submenu.className = "context-menu context-menu--submenu";
      submenu.hidden = true;
      document.body.appendChild(submenu);
      renderContextMenuItems(submenu, item.items);
      openSubmenuPopups.push(submenu);

      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      const openSubmenu = (): void => {
        if (closeTimer) clearTimeout(closeTimer);
        for (const other of openSubmenuPopups) if (other !== submenu) other.hidden = true;
        const rect = button.getBoundingClientRect();
        submenu.hidden = false;
        submenu.style.left = `${rect.right}px`;
        submenu.style.top = `${rect.top}px`;
      };
      const scheduleClose = (): void => {
        closeTimer = setTimeout(() => { submenu.hidden = true; }, 250);
      };
      button.addEventListener("mouseenter", openSubmenu);
      button.addEventListener("mouseleave", scheduleClose);
      submenu.addEventListener("mouseenter", () => { if (closeTimer) clearTimeout(closeTimer); });
      submenu.addEventListener("mouseleave", scheduleClose);
      container.appendChild(button);
      continue;
    }
    const action = item as Extract<ContextMenuItem, { label: string; onClick: () => void }>;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `context-menu__item${action.checked !== undefined ? " context-menu__item--checkable" : ""}${action.checked ? " context-menu__item--checked" : ""}`;
    button.disabled = action.disabled ?? false;
    const icon = action.checked !== undefined
      ? (() => { const check = document.createElement("span"); check.className = "context-menu__check"; check.textContent = action.checked ? "✓" : ""; return check; })()
      : renderContextMenuIcon(action.icon);
    const label = document.createElement("span");
    label.className = "context-menu__label";
    label.textContent = action.label;
    const shortcut = document.createElement("span");
    shortcut.className = "context-menu__shortcut";
    shortcut.textContent = action.shortcut ?? "";
    button.append(icon, label, shortcut);
    button.addEventListener("click", () => {
      hideContextMenu();
      action.onClick();
    });
    container.appendChild(button);
  }
}

/** NUNCA chamar `event.stopPropagation()` aqui -- o host da Webview do VS Code também escuta
 * `contextmenu` em `window`/`document` (fora do nosso controle) pra decidir se abre o menu NATIVO
 * (Cortar/Copiar/Colar) checando `event.defaultPrevented`; se a propagação for cortada antes de
 * chegar lá, o host nunca vê que o evento já foi tratado e abre o menu nativo por cima do nosso
 * (chega um instante depois, por ser round-trip nativo/IPC -- exatamente o "menu certo aparece e
 * some" relatado). `preventDefault()` sozinho já basta pra suprimir o menu nativo do navegador E
 * sinalizar pro host que o evento foi tratado; quem precisa evitar abrir um SEGUNDO menu nosso por
 * cima (ex: `canvas` no fundo vazio) deve checar `event.defaultPrevented`, nunca depender de
 * propagação cortada. */
function showContextMenu(event: MouseEvent, items: ContextMenuItem[]): void {
  event.preventDefault();
  if (items.length === 0 || items.every((item) => "kind" in item && item.kind === "separator")) {
    hideContextMenu();
    return;
  }
  renderContextMenuItems(contextMenu, items);

  contextMenu.hidden = false;
  contextMenu.style.left = `${event.clientX}px`;
  contextMenu.style.top = `${event.clientY}px`;
}

function renderToolbarButton(kind: ToolbarIconKind, title: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `appbar__button appbar__button--${kind}`;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.disabled = disabled;
  button.appendChild(renderIcon(kind));
  button.addEventListener("click", onClick);
  return button;
}

function renderAppBar(): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "appbar";

  // Abrir/Salvar Projeto usam o formato `.lsproj`, incompatível com o circuito INTERNO de um
  // `.lssubcircuit` em edição (ver `subcircuitEditingContext`/`extension.ts::
  // warnIfEditingSubcircuit`) -- desabilitados aqui só reforça visualmente o que o host já recusa.
  const editingSubcircuit = Boolean(state.subcircuitEditingContext);

  const fileGroup = document.createElement("div");
  fileGroup.className = "appbar__group";
  fileGroup.append(
    renderToolbarButton("open", t("openProject"), () => send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestOpenProject" }), editingSubcircuit),
    renderToolbarButton("save", t("saveProject"), () => send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestSaveProject" }), editingSubcircuit),
    renderToolbarButton("exportImage", t("exportImage"), () => exportSchematicImage(), state.components.length === 0),
  );

  const subcircuitGroup = document.createElement("div");
  subcircuitGroup.className = "appbar__group appbar__group--subcircuit";
  if (state.subcircuitEditingContext) {
    const label = document.createElement("span");
    label.className = "appbar__subcircuit-label";
    label.textContent = `${t("editingSubcircuit")} ${state.subcircuitEditingContext.name}`;
    subcircuitGroup.append(
      label,
      renderToolbarButton("back", t("backToMainCircuit"), () => send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestCloseSubcircuitEditor" })),
    );
  }

  const simGroup = document.createElement("div");
  simGroup.className = "appbar__group";
  simGroup.append(
    renderToolbarButton("start", t("runSimulation"), () => send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestRunSimulation" }), simulationStatus === "running"),
    renderToolbarButton("pause", t("pauseSimulation"), () => send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestPauseSimulation" }), simulationStatus !== "running"),
    renderToolbarButton("stop", t("stopSimulation"), () => send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestStopSimulation" }), simulationStatus === "stopped"),
  );

  const editGroup = document.createElement("div");
  editGroup.className = "appbar__group";
  editGroup.append(
    renderToolbarButton("properties", t("componentProperties"), () => openSelectedProperties(), !getSelectedComponent()),
    renderToolbarButton(
      "delete",
      state.selectedWireIds.length > 0 ? t("deleteSelectedItems") : t("deleteSelectedComponent"),
      () => deleteSelectedItems(),
      state.selectedWireIds.length === 0 && state.selectedComponentIds.length === 0,
    ),
  );

  const viewGroup = document.createElement("div");
  viewGroup.className = "appbar__group";
  viewGroup.append(
    renderToolbarButton("zoomFitSelection", t("zoomFitSelection"), () => zoomToFitSelection(), state.selectedComponentIds.length === 0),
    renderToolbarButton("zoomFitAll", t("zoomFitAll"), () => zoomToFitAll(), state.components.length === 0),
    renderToolbarButton("zoomReset", t("zoomReset"), () => zoomReset()),
  );

  const meta = document.createElement("div");
  meta.className = "appbar__meta";

  const selection = document.createElement("div");
  selection.className = "appbar__selection";
  selection.textContent = selectionLabel();

  const status = document.createElement("div");
  status.className = `appbar__status appbar__status--${simulationStatus}`;
  status.textContent = simulationStatus === "running" ? t("running") : simulationStatus === "paused" ? t("paused") : t("stopped");
  const rateLabel = document.createElement("span");
  rateLabel.className = "appbar__status-rate";
  rateLabel.textContent = simulationRateText();
  status.appendChild(rateLabel);

  meta.append(selection, status);
  bar.append(fileGroup, simGroup, editGroup, viewGroup, subcircuitGroup, meta);
  return bar;
}

type ToolbarIconKind = "open" | "save" | "start" | "pause" | "stop" | "properties" | "delete" | "zoomFitSelection" | "zoomFitAll" | "zoomReset" | "exportImage" | "back";

function renderIcon(kind: ToolbarIconKind): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("appbar__icon");

  switch (kind) {
    case "open":
      svg.innerHTML = '<path d="M4 18h16"></path><path d="M5 18V7h5l2 2h7v9"></path><path d="M12 12l3 3"></path><path d="M12 12l-3 3"></path><path d="M12 6v9"></path>';
      break;
    case "save":
      svg.innerHTML = '<path d="M5 4h11l3 3v13H5z"></path><path d="M8 4v6h8V4"></path><path d="M9 18h6"></path>';
      break;
    case "start":
      svg.innerHTML = '<circle cx="12" cy="12" r="8.25"></circle><line x1="12" y1="4" x2="12" y2="12"></line>';
      break;
    case "pause":
      svg.innerHTML = '<rect x="7" y="6" width="3.5" height="12" rx="1"></rect><rect x="13.5" y="6" width="3.5" height="12" rx="1"></rect>';
      break;
    case "stop":
      svg.innerHTML = '<rect x="7" y="7" width="10" height="10" rx="1.5"></rect>';
      break;
    case "properties":
      svg.innerHTML = '<path d="M6 7h12"></path><path d="M6 12h12"></path><path d="M6 17h8"></path><circle cx="16.5" cy="17" r="1.75"></circle>';
      break;
    case "delete":
      svg.innerHTML = '<path d="M6 7h12"></path><path d="M9 7V5h6v2"></path><path d="M8 7l1 11h6l1-11"></path><path d="M10 10v5"></path><path d="M14 10v5"></path>';
      break;
    case "zoomFitSelection":
      svg.innerHTML = '<rect x="7" y="7" width="10" height="10" rx="1"></rect><path d="M3 8V4h4"></path><path d="M21 8V4h-4"></path><path d="M3 16v4h4"></path><path d="M21 16v4h-4"></path>';
      break;
    case "zoomFitAll":
      svg.innerHTML = '<circle cx="11" cy="11" r="6.5"></circle><line x1="20" y1="20" x2="15.5" y2="15.5"></line><path d="M3 8V4h4"></path><path d="M21 8V4h-4"></path><path d="M3 16v4h4"></path>';
      break;
    case "zoomReset":
      svg.innerHTML = '<circle cx="11" cy="11" r="6.5"></circle><line x1="20" y1="20" x2="15.5" y2="15.5"></line><text x="8" y="14.5" font-size="8" stroke="none" fill="currentColor">1:1</text>';
      break;
    case "exportImage":
      svg.innerHTML = '<rect x="4" y="4" width="16" height="16" rx="1.5"></rect><circle cx="9" cy="10" r="1.5"></circle><path d="M4 17l5-5 3 3 4-5 4 5"></path>';
      break;
    case "back":
      svg.innerHTML = '<path d="M19 12H5"></path><path d="m11 18-6-6 6-6"></path>';
      break;
  }

  return svg;
}

function installCanvasEventHandlers(canvas: HTMLDivElement, canvasContent: HTMLDivElement): void {
  let marqueeStart: Point | undefined;
  let marqueeStartScreen: Point | undefined;
  let marqueeRectEl: HTMLElement | undefined;
  let marqueeJustFinished = false;

  canvas.addEventListener("pointermove", (event) => {
    if (!state.pendingConnection) return;
    pendingWirePreviewTarget = eventToCanvasPoint(event, canvas);
    refreshPendingWirePreview();
  });
  canvas.addEventListener("click", (event) => {
    hideContextMenu();
    if (placingTypeId) {
      const pt = eventToCanvasPoint(event, canvas);
      const snappedX = snapCoordinate(pt.x, WIRE_GRID_SIZE);
      const snappedY = snapCoordinate(pt.y, WIRE_GRID_SIZE);
      const newComponents = componentsToAddForTypeId(placingTypeId);
      for (const comp of newComponents) { comp.x = snappedX; comp.y = snappedY; }
      state = { ...state, components: [...state.components, ...newComponents] };
      vscode?.setState(state);
      persistState();
      exitPlacementMode();
      render();
      return;
    }
    if (marqueeJustFinished) {
      marqueeJustFinished = false;
      return;
    }
    if (state.pendingConnection) {
      appendPendingWireBend(eventToCanvasPoint(event, canvas));
      pendingWirePreviewTarget = undefined;
      refreshPendingWirePreview();
      return;
    }
    clearSelection();
    clearPendingWire();
    persistState();
    render();
  });
  canvas.addEventListener("contextmenu", (event) => {
    // Handler mais GENÉRICO (fundo vazio) -- roda DEPOIS de qualquer handler mais específico
    // (componente/fio/handle), já que `canvas` é ancestor deles no DOM e eles não cortam mais a
    // propagação (ver `showContextMenu`). Se algum já tratou (defaultPrevented), não faz nada --
    // nunca substitui um menu mais específico pelo genérico "Selecionar tudo".
    if (event.defaultPrevented) return;
    event.preventDefault();
    if (placingTypeId) {
      // Mesmo padrão de Esc: botão direito cancela a ferramenta ativa, nunca deixa o modo de
      // posicionamento aberto por baixo do menu de contexto genérico.
      exitPlacementMode();
      render();
      return;
    }
    if (state.pendingConnection) {
      if (pendingWireBendLengths.length > 0) {
        undoPendingWireBend();
        refreshPendingWirePreview();
      } else {
        clearPendingWire();
        persistState();
        render();
      }
      return;
    }
    clearSelection();
    render();
    const history = activeUndoHistory();
    // "Modo Placa"/"Selecionar Componentes Expostos" também precisam ser alcançáveis do fundo
    // vazio -- antes só apareciam no menu de um componente específico já existente (bug real de
    // descoberta: numa folha de subcircuito recém-criada, sem nenhum componente ainda, não havia
    // NENHUM jeito de entrar em Modo Placa). Mesmas duas entradas, mesmo comportamento.
    const internalAuthoringItems: ContextMenuItem[] = state.subcircuitEditingContext
      ? [
          { label: t("boardMode"), checked: subcircuitBoardMode, onClick: () => setSubcircuitBoardMode(!subcircuitBoardMode) },
          { label: t("selectExposedComponents"), onClick: () => openExposedComponentsDialog() },
          { kind: "separator" },
        ]
      : [];
    showContextMenu(event, [
      ...internalAuthoringItems,
      { label: t("paste"), onClick: () => pasteClipboardItems(), disabled: !clipboardItems || clipboardItems.components.length === 0, shortcut: "Ctrl+V" },
      { label: t("undo"), onClick: () => undo(), disabled: history.undoStack.length === 0, shortcut: "Ctrl+Z" },
      { label: t("redo"), onClick: () => redo(), disabled: history.redoStack.length === 0, shortcut: "Ctrl+Y" },
      { kind: "separator" },
      { label: t("selectAll"), onClick: () => selectAll() },
      { kind: "separator" },
      { label: t("zoomFitAll"), onClick: () => zoomToFitAll(), disabled: state.components.length === 0 },
      { label: t("zoomReset"), onClick: () => zoomReset() },
      { kind: "separator" },
      { label: t("exportImage"), onClick: () => exportSchematicImage(), disabled: state.components.length === 0 },
      { label: t("importCircuit"), onClick: () => send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestImportCircuit" }) },
    ]);
  });

  // Marquee (retângulo de arrasto a partir do fundo vazio) -- seleção por interseção, igual ao
  // SimulIDE real (`QGraphicsView::RubberBandDrag` puro, sem distinção de sentido de arrasto, ver
  // `.spec/lasecsimul.spec` seção 13.4). Só começa se o pointerdown for no fundo (componente/fio/pino
  // já chamam `stopPropagation()` nos próprios listeners, então nunca chegam aqui).
  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || state.pendingConnection) return;
    // Pino/fio não chamam `stopPropagation()` no PRÓPRIO `pointerdown` (só no `click`) -- sem este
    // guard, o evento borbulha até aqui e `setPointerCapture` rouba o pointer do pino, quebrando o
    // clique que inicia um fio (mesma classe de bug já corrigida 2x antes nesta sessão, ver
    // .spec/lasecsimul.spec — pointerdown de filho sem stopPropagation some o alvo do clique
    // sintetizado quando o `render()` do `onUp` do marquee recria o DOM no meio do gesto).
    if (
      event.target instanceof Element &&
      (event.target.closest(".pin-terminal") || event.target.closest(".component") || event.target.closest(".component-floating-label") || event.target.closest("polyline[data-wire-id]"))
    ) {
      return;
    }
    marqueeStart = eventToCanvasPoint(event, canvas);
    marqueeStartScreen = { x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);

    const onMove = (moveEvent: PointerEvent): void => {
      const dx = moveEvent.clientX - marqueeStartScreen!.x;
      const dy = moveEvent.clientY - marqueeStartScreen!.y;
      if (!marqueeRectEl) {
        if (Math.hypot(dx, dy) < 4) return; // limiar -- abaixo disso ainda pode ser um clique simples
        marqueeRectEl = document.createElement("div");
        marqueeRectEl.className = "marquee-rect";
        canvas.appendChild(marqueeRectEl);
      }
      const rect = canvas.getBoundingClientRect();
      marqueeRectEl.style.left = `${Math.min(marqueeStartScreen!.x, moveEvent.clientX) - rect.left}px`;
      marqueeRectEl.style.top = `${Math.min(marqueeStartScreen!.y, moveEvent.clientY) - rect.top}px`;
      marqueeRectEl.style.width = `${Math.abs(dx)}px`;
      marqueeRectEl.style.height = `${Math.abs(dy)}px`;
    };

    const finish = (): void => {
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", finish);
      marqueeRectEl?.remove();
      marqueeRectEl = undefined;
      marqueeStart = undefined;
      marqueeStartScreen = undefined;
    };

    const onUp = (upEvent: PointerEvent): void => {
      const hadRect = Boolean(marqueeRectEl);
      if (hadRect) {
        applyMarqueeSelection(marqueeStart!, eventToCanvasPoint(upEvent, canvas), upEvent.shiftKey);
        marqueeJustFinished = true;
        persistState();
      }
      finish();
      if (hadRect) render();
    };

    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp, { once: true });
    canvas.addEventListener("pointercancel", finish, { once: true });
  });

  // Pan com botão do meio (MiddleButton) -- igual ao SimulIDE (`CircuitView::mousePressEvent` com
  // `Qt::MiddleButton` → `ScrollHandDrag`). Mutação direta de `state.viewport` + transform sem
  // `render()` (mesmo padrão do wheel acima -- evita recriar o DOM a cada pixel arrastado).
  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 1) return;
    event.preventDefault(); // impede autoscroll cursor do browser com botão do meio
    const startClientX = event.clientX;
    const startClientY = event.clientY;
    const startViewportX = state.viewport.x;
    const startViewportY = state.viewport.y;
    canvas.setPointerCapture(event.pointerId);
    const onPanMove = (moveEvent: PointerEvent): void => {
      state.viewport.x = startViewportX + (moveEvent.clientX - startClientX);
      state.viewport.y = startViewportY + (moveEvent.clientY - startClientY);
      canvasContent.style.transform = `translate(${state.viewport.x}px, ${state.viewport.y}px) scale(${state.viewport.zoom})`;
    };
    const finishPan = (): void => {
      canvas.removeEventListener("pointermove", onPanMove);
      canvas.removeEventListener("pointerup", finishPan);
      canvas.removeEventListener("pointercancel", finishPan);
      persistState();
    };
    canvas.addEventListener("pointermove", onPanMove);
    canvas.addEventListener("pointerup", finishPan, { once: true });
    canvas.addEventListener("pointercancel", finishPan, { once: true });
  });

  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const screenX = event.clientX - rect.left;
      const screenY = event.clientY - rect.top;
      const oldZoom = state.viewport.zoom || 1;
      // Mesma fórmula do SimulIDE (CircuitView::wheelEvent: 2^(deltaY/700)); limite [0.2, 4] é
      // decisão do LasecSimul (SimulIDE real não tem limite codificado), ver `.spec` seção 13.4.
      const factor = Math.pow(2, -event.deltaY / 700);
      const newZoom = Math.min(4, Math.max(0.2, oldZoom * factor));
      const localX = (screenX - state.viewport.x) / oldZoom;
      const localY = (screenY - state.viewport.y) / oldZoom;
      state.viewport.x = screenX - localX * newZoom;
      state.viewport.y = screenY - localY * newZoom;
      state.viewport.zoom = newZoom;
      canvasContent.style.transform = `translate(${state.viewport.x}px, ${state.viewport.y}px) scale(${newZoom})`;
      persistState();
    },
    { passive: false }
  );
}

/** Bounding box aproximada (posição declarada +/- margem fixa, não a caixa exata do símbolo --
 * mesma simplificação já aceita pelo cálculo de centro do "Criar Subcircuito da Seleção" no lado
 * Extension) dos componentes informados, em coordenadas de mundo (não de tela). */
function approximateBoundingBox(components: readonly WebviewComponentModel[]): { minX: number; minY: number; maxX: number; maxY: number } | undefined {
  if (components.length === 0) return undefined;
  const margin = 32;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of components) {
    minX = Math.min(minX, c.x - margin);
    minY = Math.min(minY, c.y - margin);
    maxX = Math.max(maxX, c.x + margin);
    maxY = Math.max(maxY, c.y + margin);
  }
  return { minX, minY, maxX, maxY };
}

/** Ajusta `state.viewport` pra enquadrar a bounding box informada dentro da área visível do canvas,
 * com 10% de margem -- mesmos limites de zoom [0.2, 4] do wheel-zoom (`.spec` seção 13.4), pra
 * nunca produzir um zoom fora da faixa que o próprio scroll já respeita. */
function zoomToBoundingBox(box: { minX: number; minY: number; maxX: number; maxY: number }): void {
  if (!canvasElement) return;
  const viewWidth = canvasElement.clientWidth;
  const viewHeight = canvasElement.clientHeight;
  const width = box.maxX - box.minX;
  const height = box.maxY - box.minY;
  if (viewWidth <= 0 || viewHeight <= 0 || width <= 0 || height <= 0) return;
  const zoom = Math.min(4, Math.max(0.2, Math.min(viewWidth / width, viewHeight / height) * 0.9));
  const centerX = (box.minX + box.maxX) / 2;
  const centerY = (box.minY + box.maxY) / 2;
  state.viewport = { zoom, x: viewWidth / 2 - centerX * zoom, y: viewHeight / 2 - centerY * zoom };
  if (canvasContentElement) canvasContentElement.style.transform = `translate(${state.viewport.x}px, ${state.viewport.y}px) scale(${zoom})`;
  persistState();
}

/** Componentes de autoria de Package/ícone (`.spec/lasecsimul.spec` seção 23) -- espelha
 * `isPackageAuthoringComponent` (`extension/src/catalog/subcircuitPackageAuthoring.ts`, código de
 * host, não importável aqui) só na parte que "Zoom Tudo" precisa: NUNCA entram na bounding box de
 * "zoom pra caber tudo", senão a área reservada do Package (deliberadamente afastada do circuito
 * interno, ver `reservedAuthoringOrigin`) dobra o tamanho do enquadramento e encolhe o circuito
 * interno (e os fios) a um zoom bem menor do que antes desta feature existir -- achado real
 * (usuário reportou "clico em Zoom e os fios somem": não sumiram, ficaram finos demais num zoom bem
 * mais afastado). */
function isPackageAuthoringComponentForZoom(component: WebviewComponentModel): boolean {
  if (component.typeId === "other.package" || component.typeId === "other.package_pin") return true;
  if (component.typeId === "graphics.image" && component.packageIconRole === true) return true;
  // Rótulo de pino do Package (`graphics.text` linkado por `linkedPinComponentId`) fica na MESMA
  // área reservada do pino que representa -- sem excluir aqui também, o bbox continuaria inflado
  // quase do mesmo jeito.
  if (component.typeId === "graphics.text" && typeof component.properties.linkedPinComponentId === "string" && component.properties.linkedPinComponentId) return true;
  return false;
}

function zoomToFitAll(): void {
  const box = approximateBoundingBox(state.components.filter((c) => !isPackageAuthoringComponentForZoom(c)));
  if (box) zoomToBoundingBox(box);
}

function zoomToFitSelection(): void {
  const selectedIds = new Set(state.selectedComponentIds);
  const box = approximateBoundingBox(state.components.filter((c) => selectedIds.has(c.id)));
  if (box) zoomToBoundingBox(box);
}

/** Zoom 1:1 mantendo o CENTRO da área visível fixo -- mesma técnica de "zoom ancorado num ponto de
 * tela" do wheel-zoom acima, só que ancorado no centro do viewport em vez do cursor. */
function zoomReset(): void {
  if (!canvasElement) return;
  const screenX = canvasElement.clientWidth / 2;
  const screenY = canvasElement.clientHeight / 2;
  const oldZoom = state.viewport.zoom || 1;
  const localX = (screenX - state.viewport.x) / oldZoom;
  const localY = (screenY - state.viewport.y) / oldZoom;
  state.viewport = { zoom: 1, x: screenX - localX, y: screenY - localY };
  if (canvasContentElement) canvasContentElement.style.transform = `translate(${state.viewport.x}px, ${state.viewport.y}px) scale(1)`;
  persistState();
}

/** Monta um SVG autocontido do esquemático inteiro (achado de auditoria de UI 2026-07-09 --
 * SimulIDE exporta PNG/JPEG/BMP/SVG do menu de contexto, LasecSimul não tinha nenhum). Clona o
 * `canvas-content` REAL (já visualmente correto -- reaproveita posição/rotação/flip/símbolo tal
 * qual renderizados, em vez de reconstruir do zero e arriscar uma sutil divergência não
 * verificável sem GUI) dentro de um `<foreignObject>`, com o CSS da própria página embutido
 * inline (`document.styleSheets`, já que o arquivo exportado é aberto FORA deste contexto, sem
 * acesso ao `<link>` da Webview). Retorna `undefined` se não há nada pra exportar. */
function buildSchematicSvgExport(): string | undefined {
  if (!canvasContentElement) return undefined;
  const box = approximateBoundingBox(state.components);
  if (!box) return undefined;

  const margin = 32;
  const originX = box.minX - margin;
  const originY = box.minY - margin;
  const width = box.maxX - box.minX + margin * 2;
  const height = box.maxY - box.minY + margin * 2;

  const clone = canvasContentElement.cloneNode(true) as HTMLElement;
  // Overlays efêmeros de interação (marquee/alças de fio/preview de fio pendente) não deveriam
  // sobreviver até aqui (só existem durante um gesto ativo, não depois de um clique de menu/
  // toolbar), mas removidos defensivamente da CÓPIA -- nunca da árvore viva.
  clone.querySelectorAll(".marquee-rect, .wire-corner-handle, .wire-segment-handle, .pending-wire-preview").forEach((el) => el.remove());
  clone.style.transform = `translate(${-originX}px, ${-originY}px)`;

  let cssText = "";
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) cssText += `${rule.cssText}\n`;
    } catch {
      // folha de estilo de outra origem (CSP da Webview não deveria permitir isso acontecer) --
      // ignora em vez de quebrar a exportação inteira por causa de uma folha que não importa.
    }
  }

  const serializer = new XMLSerializer();
  const clonedMarkup = serializer.serializeToString(clone);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<defs><style><![CDATA[\n${cssText}\n]]></style></defs>`,
    `<foreignObject width="${width}" height="${height}"><div xmlns="http://www.w3.org/1999/xhtml">${clonedMarkup}</div></foreignObject>`,
    `</svg>`,
  ].join("\n");
}

function exportSchematicImage(): void {
  const svg = buildSchematicSvgExport();
  if (!svg) return;
  send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestExportSchematicImage", svg });
}

function ensureRenderShell(): { canvas: HTMLDivElement; canvasContent: HTMLDivElement; wireLayer: SVGSVGElement } | undefined {
  if (!app) return undefined;

  const nextAppBar = renderAppBar();
  if (appBarElement) appBarElement.replaceWith(nextAppBar);
  else app.appendChild(nextAppBar);
  appBarElement = nextAppBar;

  if (!canvasElement || !canvasContentElement || !wireLayerElement) {
    canvasElement = document.createElement("div");
    canvasElement.className = "canvas";

    canvasContentElement = document.createElement("div");
    canvasContentElement.className = "canvas-content";

    wireLayerElement = document.createElementNS(SVG_NS, "svg");
    wireLayerElement.classList.add("wire-layer");
    canvasContentElement.appendChild(wireLayerElement);
    canvasElement.appendChild(canvasContentElement);
    installCanvasEventHandlers(canvasElement, canvasContentElement);
  }

  if (canvasElement.parentElement !== app) app.appendChild(canvasElement);
  if (appBarElement.nextSibling !== canvasElement) app.insertBefore(canvasElement, appBarElement.nextSibling);

  canvasContentElement.style.transform = `translate(${state.viewport.x}px, ${state.viewport.y}px) scale(${state.viewport.zoom})`;
  if (wireLayerElement.parentElement !== canvasContentElement) canvasContentElement.insertBefore(wireLayerElement, canvasContentElement.firstChild);
  else if (canvasContentElement.firstChild !== wireLayerElement) canvasContentElement.insertBefore(wireLayerElement, canvasContentElement.firstChild);

  return { canvas: canvasElement, canvasContent: canvasContentElement, wireLayer: wireLayerElement };
}

function clearEphemeralCanvasChildren(canvasContent: HTMLDivElement): void {
  for (const child of Array.from(canvasContent.children)) {
    if (!(child instanceof HTMLElement)) continue;
    if (
      child.classList.contains("component--board-overlay") ||
      child.classList.contains("component-floating-label")
    ) {
      child.remove();
    }
  }
}

function render(): void {
  if (!app) return;
  normalizeSelectedWireSegment();
  normalizeSelectedWireCorner();
  normalizeSelectedTextLabel();
  const shell = ensureRenderShell();
  if (!shell) return;
  const { canvasContent, wireLayer } = shell;
  clearEphemeralCanvasChildren(canvasContent);
  // Alças de segmento/canto E o preview de fio pendente (`renderPendingWirePreview`, sempre recriado
  // do zero, nunca reaproveitado) são removidos aqui -- só os `<polyline>` REAIS rastreados em
  // `wirePolylineElementsById` (ver abaixo) sobrevivem entre renders.
  const trackedPolylines = new Set<SVGPolylineElement>(wirePolylineElementsById.values());
  for (const child of Array.from(wireLayer.children)) {
    if (!(child instanceof SVGPolylineElement) || !trackedPolylines.has(child)) child.remove();
  }

  const visibleWireIds = new Set<string>();
  for (const wire of subcircuitBoardMode ? [] : state.topology.conductors) {
    const points = wirePolylinePoints(wire);
    if (points.length < 2) continue;
    const spatialSignature = points.map((point) => `${point.x},${point.y}`).join(";");
    if (wireSpatialSignatures.get(wire.id) !== spatialSignature) {
      wireSpatialIndex.upsertWire(wire.id, points);
      wireSpatialSignatures.set(wire.id, spatialSignature);
    }
    visibleWireIds.add(wire.id);
    let polyline = wirePolylineElementsById.get(wire.id);
    if (!polyline) {
      polyline = document.createElementNS(SVG_NS, "polyline");
      polyline.dataset.wireId = wire.id;
      polyline.style.pointerEvents = "none";
      wirePolylineElementsById.set(wire.id, polyline);
    }
    setPolylinePoints(polyline, points);
    polyline.setAttribute("class", wireClass(wire.id));
    wireLayer.appendChild(polyline); // reordena pro fim (no-op se já era o último) -- mantém a ordem de state.topology.conductors
    renderWireSegmentHandles(wireLayer, wire, points);
    renderWireCornerHandles(wireLayer, wire, points);
  }
  for (const [id, polyline] of wirePolylineElementsById) {
    if (visibleWireIds.has(id)) continue;
    polyline.remove();
    wirePolylineElementsById.delete(id);
    wireSpatialIndex.removeWire(id);
    wireSpatialSignatures.delete(id);
  }
  if (!subcircuitBoardMode) renderPendingWirePreview(wireLayer);

  const visibleComponents: WebviewComponentModel[] = [];
  const subcircuitFileComponents: WebviewComponentModel[] = [];
  const boardModeComponents: WebviewComponentModel[] = [];
  for (const component of state.components) {
    if (component.hidden) continue;
    if (subcircuitBoardMode && !isBoardModeVisible(component)) continue;
    visibleComponents.push(component);
    if (component.properties.boardModeEnabled) boardModeComponents.push(component);
    if (catalogEntryFor(component.typeId)?.registeredSourceKind === "subcircuit-file") subcircuitFileComponents.push(component);
  }

  const visibleComponentIds = new Set<string>();
  for (const component of visibleComponents) {
    visibleComponentIds.add(component.id);
    let componentEl = componentElementsById.get(component.id);
    if (componentEl && componentEl.dataset.typeId !== component.typeId) {
      componentEl.remove();
      componentElementsById.delete(component.id);
      componentEl = undefined;
    }
    if (!componentEl) {
      componentEl = createComponentElement(component);
      componentElementsById.set(component.id, componentEl);
    } else {
      updateComponentElement(componentEl, component);
    }
    canvasContent.appendChild(componentEl);
  }
  for (const [id, componentEl] of componentElementsById) {
    if (visibleComponentIds.has(id)) continue;
    componentEl.remove();
    componentElementsById.delete(id);
  }

  for (const component of subcircuitFileComponents) {
    ensureBoardOverlayData(component);
  }

  for (const component of boardModeComponents) {
    for (const overlayEl of renderBoardOverlaysFor(component)) canvasContent.appendChild(overlayEl);
  }

  for (const component of visibleComponents) {
    const embedsOwnIdLabel = component.typeId === TUNNEL_TYPE_ID &&
      typeof component.properties.name === "string" &&
      component.properties.name.trim().length > 0;
    if (!embedsOwnIdLabel) {
      const idLabel = renderExternalLabel(component, "id");
      if (idLabel) canvasContent.appendChild(idLabel);
    }
    const valueLabel = renderExternalLabel(component, "value");
    if (valueLabel) canvasContent.appendChild(valueLabel);
  }

  for (const node of state.topology.nodes) {
    // Dentro do `wireLayer` (SVG), não mais `canvasContent` (`<div>`) -- mesmo espaço de coordenadas
    // dos dois jeitos (ambos herdam o transform de zoom/pan de `canvasContent`), mas como SVG a
    // junção fica no MESMO documento das alças de canto/segmento (pintadas por último = por cima,
    // ordem de inserção natural já que este loop roda depois do loop de fios) e ganha hit-test nativo
    // consistente com elas -- antes era um `<div>` com `pointer-events:none`, nunca clicável/
    // arrastável (bug real: impossível conectar um 4º fio a uma junção existente, só por acidente
    // via a borda de um segmento adjacente).
    if (isJunctionVisible(state.topology.conductors, node.id)) wireLayer.appendChild(renderJunction(node.id, node.position.x, node.position.y));
  }

  renderInstrumentPopups();
}

/** Componentes/fios cujas caixas (canvas-local, sem zoom) se sobrepõem ao retângulo do marquee --
 * interseção simples, igual `IntersectsItemShape` do Qt/SimulIDE (ver `.spec` seção 13.4). Fio entra
 * se QUALQUER ponto da polilinha cair dentro do retângulo (simplificação documentada de "toca"). */
function applyMarqueeSelection(start: Point, end: Point, additive: boolean): void {
  const left = Math.min(start.x, end.x);
  const right = Math.max(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const bottom = Math.max(start.y, end.y);

  const hitComponentIds = state.components
    .filter((component) => {
      if (component.hidden) return false;
      const box = componentBox(component.typeId, component.properties);
      // Caixa já rotacionada/espelhada (ver `rotatedComponentLocalBox`) -- sem isto, um componente
      // com caixa bem mais larga que alta (ex: `connectors.tunnel`) girado 90/270° testava
      // interseção contra a caixa CANÔNICA, bem longe de onde o símbolo visualmente está.
      const origin = componentLocalOrigin(component.typeId, component.properties);
      const rotatedBox = rotatedComponentLocalBox(box, component.rotation, Boolean(component.flipH), Boolean(component.flipV), origin);
      const boxLeft = component.x + rotatedBox.x;
      const boxTop = component.y + rotatedBox.y;
      return boxLeft < right && boxLeft + rotatedBox.width > left && boxTop < bottom && boxTop + rotatedBox.height > top;
    })
    .map((component) => component.id);

  const hitWireIds = state.topology.conductors
    .filter((wire) => wireIntersectsRect(wire, left, top, right, bottom))
    .map((wire) => wire.id);

  if (additive) {
    state.selectedComponentIds = [...new Set([...state.selectedComponentIds, ...hitComponentIds])];
    state.selectedWireIds = [...new Set([...state.selectedWireIds, ...hitWireIds])];
    if (selectedWireSegment && !state.selectedWireIds.includes(selectedWireSegment.wireId)) selectedWireSegment = undefined;
    if (selectedWireCorner && !state.selectedWireIds.includes(selectedWireCorner.wireId)) selectedWireCorner = undefined;
  } else {
    state.selectedComponentIds = hitComponentIds;
    state.selectedWireIds = hitWireIds;
    selectedWireSegment = hitWireIds.length === 1 ? firstWireSegmentIntersectingRect(hitWireIds[0]!, left, top, right, bottom) : undefined;
    selectedWireCorner = undefined;
  }
}

/** Remove TODOS os componentes e fios selecionados — uma mensagem IPC por item (reaproveita os
 * verbos `requestRemoveComponent`/`requestRemoveWire` já existentes; nenhum verbo em lote novo). */
function deleteSelectedItems(): void {
  for (const wireId of state.selectedWireIds) {
    send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestRemoveWire", wireId });
  }
  for (const componentId of state.selectedComponentIds) {
    send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestRemoveComponent", componentId });
  }
  clearSelection();
}

function cloneComponent(component: WebviewComponentModel): WebviewComponentModel {
  // `packageIconRole` marca a ÚNICA Figura que representa o ícone do Package sendo editado
  // (`.spec/lasecsimul.spec`, autoria de subcircuito) -- uma cópia NUNCA herda esse papel (senão
  // "colar" duplicaria o ícone, erro bloqueante em `compilePackageAuthoringComponents` no save). A
  // cópia vira um `graphics.image` comum, sem papel especial.
  const { packageIconRole: _packageIconRole, ...rest } = component;
  return {
    ...rest,
    pins: component.pins.map((pin) => ({ ...pin })),
    properties: { ...component.properties },
  };
}

function cloneWire(wire: WebviewWireModel): WebviewWireModel {
  return {
    ...wire,
    from: { ...wire.from },
    to: { ...wire.to },
    points: wire.points?.map((point) => ({ ...point })),
  };
}

function newComponentId(): string {
  return `component-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

function newWireId(): string {
  return `wire-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

function copySelectedItems(): boolean {
  const selectedComponentIds = new Set(state.selectedComponentIds);
  const components = state.components.filter((component) => selectedComponentIds.has(component.id)).map(cloneComponent);
  if (components.length === 0) return false;

  const wires = state.topology.conductors
    .filter((wire) => selectedComponentIds.has(endpointId(wire.from)) && selectedComponentIds.has(endpointId(wire.to)))
    .map(cloneWire);

  clipboardItems = { components, wires };
  return true;
}

function cutSelectedItems(): void {
  if (!copySelectedItems()) return;
  deleteSelectedItems();
}

/** `Ctrl+Shift`-drag duplica a seleção e arrasta a CÓPIA, deixando os originais parados (mesmo gesto
 * do SimulIDE real, `circuitview.cpp::mousePressEvent`/`mouseMoveEvent` -- achado de auditoria de UI
 * 2026-07-09). Cópias nascem NA MESMA posição dos originais (não deslocadas, ao contrário de
 * `pasteClipboardItems`) porque a posição final é ditada pelo próprio arrasto em andamento, não por
 * este helper. Mesma lógica de filtro de fio interno de `copySelectedItems`, sem tocar
 * `clipboardItems`/`state` -- quem chama decide quando inserir no estado global (o gesto de arrasto
 * NUNCA chama `render()` no meio, ver comentário sobre `setPointerCapture` em `createComponentElement`). */
function duplicateComponentsForDrag(originals: WebviewComponentModel[]): { components: WebviewComponentModel[]; wires: WebviewWireModel[] } {
  const originalIds = new Set(originals.map((component) => component.id));
  const idMap = new Map<string, string>();
  const stagedComponents = [...state.components];
  const components = originals.map((source) => {
    const component = cloneComponent(source);
    const descriptor = catalogEntryFor(component.typeId);
    const baseLabel = descriptor?.label ?? component.typeId;
    const nextId = newComponentId();
    idMap.set(source.id, nextId);
    component.id = nextId;
    component.label = nextIndexedLabel(component.typeId, baseLabel, stagedComponents);
    if (interactionKindFor(component.typeId) === "momentary") component.properties.closed = false;
    stagedComponents.push(component);
    return component;
  });

  const wires = state.topology.conductors
    .filter((wire) => originalIds.has(endpointId(wire.from)) && originalIds.has(endpointId(wire.to)))
    .flatMap((source) => {
      const from = remapEndpoint(source.from, idMap);
      const to = remapEndpoint(source.to, idMap);
      if (!from || !to) return [];
      const wire = cloneWire(source);
      wire.id = newWireId();
      wire.from = from;
      wire.to = to;
      return [wire];
    });

  return { components, wires };
}

function pasteClipboardItems(): void {
  if (!clipboardItems || clipboardItems.components.length === 0) return;

  const idMap = new Map<string, string>();
  const stagedComponents = [...state.components];
  const components = clipboardItems.components.map((source) => {
    const component = cloneComponent(source);
    const descriptor = catalogEntryFor(component.typeId);
    const baseLabel = descriptor?.label ?? component.typeId;
    const nextId = newComponentId();
    idMap.set(component.id, nextId);
    component.id = nextId;
    component.label = nextIndexedLabel(component.typeId, baseLabel, stagedComponents);
    component.x += WIRE_GRID_SIZE;
    component.y += WIRE_GRID_SIZE;
    // Mesmo deslocamento pra posição de Modo Placa, quando existir -- sem isto, colar uma cópia de
    // um componente já posicionado na placa (exposto+gráfico) fazia a cópia nascer exatamente em
    // cima do original ali (só `x`/`y` do esquemático eram deslocados), com duas peças empilhadas
    // até o usuário notar e arrastar manualmente.
    if (component.boardX !== undefined) component.boardX += WIRE_GRID_SIZE;
    if (component.boardY !== undefined) component.boardY += WIRE_GRID_SIZE;
    if (interactionKindFor(component.typeId) === "momentary") component.properties.closed = false;
    stagedComponents.push(component);
    return component;
  });

  const wires = clipboardItems.wires.flatMap((source) => {
    const from = remapEndpoint(source.from, idMap);
    const to = remapEndpoint(source.to, idMap);
    if (!from || !to) return [];
    const wire = cloneWire(source);
    wire.id = newWireId();
    wire.from = from;
    wire.to = to;
    wire.points = wire.points?.map((point) => ({ x: point.x + WIRE_GRID_SIZE, y: point.y + WIRE_GRID_SIZE }));
    return [wire];
  });

  state = {
    ...state,
    components: [...state.components, ...components],
    topology: { ...state.topology, conductors: [...state.topology.conductors, ...wires] },
    selectedComponentIds: components.map((component) => component.id),
    selectedWireIds: wires.map((wire) => wire.id),
  };
  vscode?.setState(state);
  send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestInsertItems", components, wires });
  render();
}

function wireClass(wireId: string): string {
  const classNames = ["wire-layer__wire"];
  const voltage = voltagesByWireId[wireId];
  if (voltage !== undefined) {
    classNames.push(voltage > 2.5 ? "wire-layer__wire--high" : "wire-layer__wire--low");
  }
  if (isWireSelected(wireId) && selectedWireSegment?.wireId !== wireId) {
    classNames.push("wire-layer__wire--selected");
  }
  return classNames.join(" ");
}

function normalizeSelectedWireSegment(): void {
  if (!selectedWireSegment) return;
  const wire = state.topology.conductors.find((entry) => entry.id === selectedWireSegment?.wireId);
  if (!wire || !isWireSelected(wire.id)) {
    selectedWireSegment = undefined;
    return;
  }

  const segmentCount = Math.max(wirePolylinePoints(wire).length - 1, 0);
  if (selectedWireSegment.segmentIndex < 0 || selectedWireSegment.segmentIndex >= segmentCount) {
    selectedWireSegment = undefined;
  }
}

function normalizeSelectedWireCorner(): void {
  if (!selectedWireCorner) return;
  const wire = state.topology.conductors.find((entry) => entry.id === selectedWireCorner?.wireId);
  if (!wire || !isWireSelected(wire.id)) {
    selectedWireCorner = undefined;
    return;
  }

  const pointCount = wirePolylinePoints(wire).length;
  if (selectedWireCorner.pointIndex <= 0 || selectedWireCorner.pointIndex >= pointCount - 1) {
    selectedWireCorner = undefined;
  }
}

function normalizeSelectedTextLabel(): void {
  if (!selectedTextLabel) return;
  const activeLabel = selectedTextLabel;
  const component = state.components.find((entry) => entry.id === activeLabel.componentId);
  if (!component || externalLabelText(component, activeLabel.kind) === undefined) {
    selectedTextLabel = undefined;
  }
}

function valueWithinRange(value: number, min: number, max: number): boolean {
  return value >= Math.min(min, max) - 0.5 && value <= Math.max(min, max) + 0.5;
}

function orthogonalSegmentIntersectsRect(from: Point, to: Point, left: number, top: number, right: number, bottom: number): boolean {
  if (Math.abs(from.x - to.x) < 0.5) {
    return valueWithinRange(from.x, left, right) && Math.max(Math.min(from.y, to.y), top) <= Math.min(Math.max(from.y, to.y), bottom);
  }

  if (Math.abs(from.y - to.y) < 0.5) {
    return valueWithinRange(from.y, top, bottom) && Math.max(Math.min(from.x, to.x), left) <= Math.min(Math.max(from.x, to.x), right);
  }

  return false;
}

function wireIntersectsRect(wire: WebviewWireModel, left: number, top: number, right: number, bottom: number): boolean {
  const points = wirePolylinePoints(wire);
  for (let index = 0; index < points.length - 1; index += 1) {
    if (orthogonalSegmentIntersectsRect(points[index]!, points[index + 1]!, left, top, right, bottom)) return true;
  }
  return false;
}

function firstWireSegmentIntersectingRect(
  wireId: string,
  left: number,
  top: number,
  right: number,
  bottom: number
): { wireId: string; segmentIndex: number } | undefined {
  const wire = state.topology.conductors.find((entry) => entry.id === wireId);
  if (!wire) return undefined;

  const points = wirePolylinePoints(wire);
  for (let index = 0; index < points.length - 1; index += 1) {
    if (orthogonalSegmentIntersectsRect(points[index]!, points[index + 1]!, left, top, right, bottom)) {
      return { wireId, segmentIndex: index };
    }
  }
  return undefined;
}

/** `canvas` aqui é sempre o viewport fixo (`.canvas`, nunca se move/escala) — `.canvas-content` é
 * quem recebe `translate(viewport.x,y) scale(viewport.zoom)`; inverter essa transformação é o que
 * mantém clique de pino/desenho de fio/marquee corretos em qualquer zoom (ver `.spec` seção 13.4). */
function eventToCanvasPoint(event: PointerEvent | MouseEvent, canvas: HTMLElement): Point {
  const rect = canvas.getBoundingClientRect();
  const zoom = state.viewport.zoom || 1;
  return {
    x: (event.clientX - rect.left - state.viewport.x) / zoom,
    y: (event.clientY - rect.top - state.viewport.y) / zoom,
  };
}

/** Espelha o ponto local antes da rotação -- mesma ordem do CSS `transform: rotate(...) scale(...)`
 * em `renderComponent` (transform aplica da direita pra esquerda: scale primeiro, rotate depois). */
function flipPoint(local: Point, box: { width: number; height: number }, flipH: boolean, flipV: boolean, origin?: Point): Point {
  const pivot = origin ?? { x: box.width / 2, y: box.height / 2 };
  return {
    x: flipH ? pivot.x - (local.x - pivot.x) : local.x,
    y: flipV ? pivot.y - (local.y - pivot.y) : local.y,
  };
}

function rotatePoint(local: Point, box: { width: number; height: number }, rotation: 0 | 90 | 180 | 270, origin?: Point): Point {
  const pivot = origin ?? { x: box.width / 2, y: box.height / 2 };
  const cx = pivot.x;
  const cy = pivot.y;
  const dx = local.x - cx;
  const dy = local.y - cy;
  switch (rotation) {
    case 90:
      return { x: cx - dy, y: cy + dx };
    case 180:
      return { x: cx - dx, y: cy - dy };
    case 270:
      return { x: cx + dy, y: cy - dx };
    case 0:
    default:
      return local;
  }
}

/** Bounding box canvas-local do símbolo já rotacionado/espelhado -- `componentBox()` sempre devolve a
 * caixa CANÔNICA (rotation=0), então qualquer código que precise saber ONDE o desenho realmente
 * ocupa espaço na tela (hit-box do `<div class="component">` em `updateComponentElement`, teste de
 * interseção de `applyMarqueeSelection`) usava a caixa canônica direto -- certo só quando width≈height
 * ou o pivô é o centro da caixa. Bug relatado 2026-07-09: girar um `connectors.tunnel` (caixa bem
 * mais larga que alta, pivô numa PONTA via `tunnelOrigin`, não no centro) deixava a área clicável
 * bem longe do desenho visualmente rotacionado -- clicar perto do símbolo selecionava o vizinho
 * errado. Roda os 4 cantos da caixa canônica pelo MESMO par flip+rotate (mesma ordem -- flip
 * primeiro, rotate depois -- de `componentPinLocalPosition`/`svgBodyTransform`) e agrega o min/max:
 * nunca duplica a fórmula de rotação/flip, só descobre o retângulo que os 4 cantos transformados
 * ocupam. */
function rotatedComponentLocalBox(
  box: { width: number; height: number },
  rotation: 0 | 90 | 180 | 270,
  flipH: boolean,
  flipV: boolean,
  origin?: Point
): { x: number; y: number; width: number; height: number } {
  if (rotation === 0 && !flipH && !flipV) return { x: 0, y: 0, width: box.width, height: box.height };
  const corners = [
    { x: 0, y: 0 },
    { x: box.width, y: 0 },
    { x: box.width, y: box.height },
    { x: 0, y: box.height },
  ].map((corner) => rotatePoint(flipPoint(corner, box, flipH, flipV, origin), box, rotation, origin));
  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

/** `x`/`y` de `rotatedComponentLocalBox` pra este componente -- o deslocamento que soma em
 * `component.x`/`y` pra achar o `left`/`top` real do `<div>` (ver `updateComponentElement`). Extraído
 * pra função própria porque tem DOIS chamadores que precisam do MESMO valor: o render completo E o
 * "fast path" de arrasto (`onMove` do `pointerdown` de componente) -- que só atualiza `style.left/top`
 * direto, sem passar por `updateComponentElement`, por performance (evita reconstruir o `<svg>`
 * inteiro a cada `pointermove`). Sem isto no fast path, o `<div>` de um componente rotacionado
 * "pulava" de volta pro offset ERRADO (zero) assim que o arrasto começava, mesmo o `<svg>` interno
 * continuando corretamente rotacionado -- bug relatado 2026-07-09 (2ª rodada): destaque cinza
 * deslocado horizontalmente do túnel de verdade depois de mover/rotacionar. */
function componentDivOffset(component: WebviewComponentModel): Point {
  const box = componentBox(component.typeId, component.properties);
  if (component.rotation === 0 && !component.flipH && !component.flipV) return { x: 0, y: 0 };
  const origin = componentLocalOrigin(component.typeId, component.properties);
  const rotatedBox = rotatedComponentLocalBox(box, component.rotation, Boolean(component.flipH), Boolean(component.flipV), origin);
  return { x: rotatedBox.x, y: rotatedBox.y };
}

function svgBodyTransform(box: { width: number; height: number }, rotation: 0 | 90 | 180 | 270, flipH: boolean, flipV: boolean, origin?: Point): string {
  const pivot = origin ?? { x: box.width / 2, y: box.height / 2 };
  const cx = pivot.x;
  const cy = pivot.y;
  const scaleX = flipH ? -1 : 1;
  const scaleY = flipV ? -1 : 1;
  return `translate(${cx} ${cy}) rotate(${rotation}) scale(${scaleX} ${scaleY}) translate(${-cx} ${-cy})`;
}

function componentPinLocalPosition(component: WebviewComponentModel, pinIndex: number): Point {
  const box = componentBox(component.typeId, component.properties);
  const origin = componentLocalOrigin(component.typeId, component.properties);
  const base = pinLocalPosition(component.pins[pinIndex]?.id ?? "", pinIndex, component.pins.length, component.typeId, component.properties);
  const flipped = flipPoint(base, box, Boolean(component.flipH), Boolean(component.flipV), origin);
  return rotatePoint(flipped, box, component.rotation, origin);
}

function setPolylinePoints(polyline: SVGPolylineElement, points: Point[]): void {
  polyline.setAttribute("points", points.map((point) => `${point.x},${point.y}`).join(" "));
}

function wirePolylinePoints(wire: WebviewWireModel): Point[] {
  // Resolução porta-ou-nó de topologia é SEMPRE a mesma regra (`wireTopology.ts::pinScenePosition`,
  // fonte única) -- antes desta rodada, main.ts reimplementava essa distinção à mão, uma 3ª cópia
  // independente da mesma lógica (`electricalEdgesForProject`/`voltageProbesForProject` já tinham
  // cada uma a sua, ver `docs/27-analise-critica-fios-vs-auditoria-2026-07-11.md`).
  const fromPos = resolveEndpointScenePosition(state.components, wire.from, state.topology.nodes);
  const toPos = resolveEndpointScenePosition(state.components, wire.to, state.topology.nodes);
  if (!fromPos || !toPos) return [];
  return buildOrthogonalPath([fromPos, ...(wire.points ?? []), toPos]);
}

function updateWireFromFullPath(wire: WebviewWireModel, fullPoints: Point[]): void {
  const normalized = normalizeOrthogonalPath(fullPoints);
  const internal = normalized.slice(1, -1).map((point) => ({ x: point.x, y: point.y }));
  if (internal.length > 0) wire.points = internal;
  else delete wire.points;
}

/** "Ramo" de fio (canto ou segmento) capturado no início de um arrasto de GRUPO -- move junto com
 * componente(s) selecionado(s), qualquer que seja o elemento que o usuário agarrou pra iniciar o
 * arrasto (componente OU o próprio ramo). Mesmo espírito do `m_lineMoveList`/`m_compMoveList` do
 * SimulIDE real (`Component::mouseMoveEvent`): tudo que está selecionado se move pelo MESMO delta
 * contínuo do mouse, sem snap de grade durante o arrasto (só ao soltar, via `normalizeOrthogonalPath`
 * já embutido em `updateWireFromFullPath`). */
type GroupWireDragTarget =
  | { kind: "corner"; wireId: string; pointIndex: number; startFullPoints: Point[] }
  | { kind: "segment"; wireId: string; segmentIndex: number; startFullPoints: Point[] };

/** Ponta solta de um fio (índice 0 ou último de `wirePolylinePoints`, o pino real) nunca é alterada
 * de fato -- `moveOrthogonalWireCorner`/`moveOrthogonalWireSegment` podem tocar nela internamente,
 * mas `updateWireFromFullPath` já descarta índice 0/último do que é persistido (`slice(1,-1)`), então
 * ela sempre volta a refletir a posição REAL do pino no próximo render, atrelada ou não a um
 * componente que também esteja se movendo no mesmo arrasto. */
function currentGroupWireSelection(): GroupWireDragTarget | undefined {
  if (selectedWireSegment) {
    const wire = state.topology.conductors.find((entry) => entry.id === selectedWireSegment!.wireId);
    if (!wire) return undefined;
    return { kind: "segment", wireId: wire.id, segmentIndex: selectedWireSegment.segmentIndex, startFullPoints: wirePolylinePoints(wire) };
  }
  if (selectedWireCorner) {
    const wire = state.topology.conductors.find((entry) => entry.id === selectedWireCorner!.wireId);
    if (!wire) return undefined;
    return { kind: "corner", wireId: wire.id, pointIndex: selectedWireCorner.pointIndex, startFullPoints: wirePolylinePoints(wire) };
  }
  return undefined;
}

function applyGroupWireDelta(target: GroupWireDragTarget, dx: number, dy: number): void {
  const wire = state.topology.conductors.find((entry) => entry.id === target.wireId);
  if (!wire) return;
  if (target.kind === "corner") {
    const start = target.startFullPoints[target.pointIndex];
    if (!start) return;
    updateWireFromFullPath(wire, moveOrthogonalWireCorner(target.startFullPoints, target.pointIndex, { x: start.x + dx, y: start.y + dy }));
  } else {
    const from = target.startFullPoints[target.segmentIndex];
    const to = target.startFullPoints[target.segmentIndex + 1];
    if (!from || !to) return;
    const isHorizontal = Math.abs(from.y - to.y) < 0.5;
    const coordinate = isHorizontal ? from.y + dy : from.x + dx;
    updateWireFromFullPath(wire, moveOrthogonalWireSegment(target.startFullPoints, target.segmentIndex, coordinate));
  }
  updateWireVisual(wire.id);
}

/** Generaliza `GroupWireDragTarget` (que só cobre UM canto/segmento ativamente arrastado) pra TODA a
 * seleção múltipla de fios (`state.selectedWireIds`, populada por marquee/Ctrl+click) -- "selecionar
 * um componente E um fio inteiro (ou vários) e arrastar qualquer um dos dois move tudo junto"
 * (queixa real do usuário: antes só funcionava se o fio tivesse um canto/segmento individualmente
 * selecionado, nunca pra seleção de fio inteiro via marquee). Cada fio selecionado translada seus
 * pontos INTERNOS pelo delta; as duas extremidades reais (índice 0/último de `wirePolylinePoints`)
 * nunca entram aqui porque são sempre recalculadas dinamicamente da posição do pino/nó (ver
 * `wirePolylinePoints`) -- só o NÓ DE TOPOLOGIA em si precisa ser deslocado explicitamente quando
 * `movableTopologyNodeIds` confirma que TODOS os fios que o tocam também estão selecionados (senão
 * arrastaria um T inteiro por causa de só um dos ramos, rasgando os outros). `excludeWireId` evita
 * mover em dobro o fio cujo canto/segmento específico já está sendo arrastado por
 * `applyGroupWireDelta` (tratado à parte, com eixo/snap próprios). */
interface GroupMoveWireTargets {
  wires: { wireId: string; startFullPoints: Point[] }[];
  nodes: { nodeId: string; startX: number; startY: number }[];
}

function computeGroupMoveWireTargets(excludeWireId?: string, excludeNodeId?: string): GroupMoveWireTargets {
  const wireIds = new Set(state.selectedWireIds.filter((id) => id !== excludeWireId));
  const wires: GroupMoveWireTargets["wires"] = [];
  for (const wireId of wireIds) {
    const wire = state.topology.conductors.find((entry) => entry.id === wireId);
    if (!wire) continue;
    wires.push({ wireId, startFullPoints: wirePolylinePoints(wire) });
  }
  if (wires.length === 0) return { wires: [], nodes: [] };

  const snapshot = { components: state.components, wires: state.topology.conductors, nodes: state.topology.nodes };
  const movableNodeIds = movableTopologyNodeIds(snapshot, wireIds);
  const nodes: GroupMoveWireTargets["nodes"] = [];
  for (const nodeId of movableNodeIds) {
    if (nodeId === excludeNodeId) continue; // já sendo movido pelo arrasto direto da própria junção
    const node = state.topology.nodes.find((entry) => entry.id === nodeId);
    if (node) nodes.push({ nodeId, startX: node.position.x, startY: node.position.y });
  }
  return { wires, nodes };
}

function applyGroupMoveWireDelta(targets: GroupMoveWireTargets, dx: number, dy: number): void {
  for (const { wireId, startFullPoints } of targets.wires) {
    const wire = state.topology.conductors.find((entry) => entry.id === wireId);
    if (!wire || startFullPoints.length < 2) continue;
    const shifted = startFullPoints.map((point, index) =>
      index === 0 || index === startFullPoints.length - 1 ? point : { x: point.x + dx, y: point.y + dy }
    );
    updateWireFromFullPath(wire, shifted);
  }
  for (const { nodeId, startX, startY } of targets.nodes) {
    const node = state.topology.nodes.find((entry) => entry.id === nodeId);
    if (node) node.position = { x: startX + dx, y: startY + dy };
  }
  // Um fio pode ter as duas pontas em nós movidos (ex: dois nós private do mesmo ramo selecionado
  // junto) -- atualiza TODOS os fios afetados só depois de toda posição já ter sido escrita, nunca
  // intercalado, senão um fio leria a posição ANTIGA do segundo nó ainda não processado nesta rodada.
  const touchedWireIds = new Set(targets.wires.map((entry) => entry.wireId));
  for (const { nodeId } of targets.nodes) for (const wire of wiresByComponentId().get(nodeId) ?? []) touchedWireIds.add(wire.id);
  for (const wireId of touchedWireIds) updateWireVisual(wireId);
}

/** Reflete `component.x/y` (já atualizado pelo chamador) na posição DOM + reroteia os fios que
 * tocam esse componente -- versão reusável do que o loop principal de arrasto de componente já faz
 * inline, usada pelos gestos de arrasto de GRUPO iniciados pelo lado do FIO (`applyGroupWireDelta`
 * é o inverso: grupo iniciado pelo lado do componente). Recalcula o offset de rotação/flip a cada
 * chamada em vez de cachear -- poucos componentes num grupo misto, custo desprezível. */
function updateComponentPosition(component: WebviewComponentModel): void {
  const offset = componentDivOffset(component);
  const targetEl = componentElementsById.get(component.id);
  if (targetEl) {
    targetEl.style.left = `${component.x + offset.x}px`;
    targetEl.style.top = `${component.y + offset.y}px`;
  }
  updateWiresTouchingComponent(component.id);
}

/** Fonte única de verdade pra aplicar o delta de "arrasto de grupo" (componente(s) e/ou fio(s)
 * co-selecionados acompanhando o elemento que o usuário de fato agarrou -- componente, canto,
 * segmento ou junção) -- as 4 alças interativas que iniciam um arrasto (`renderWireCornerHandles`,
 * `renderWireSegmentHandles` x2 -- caso Shift+canto embutido e caso segmento direto --, o handler de
 * componente, e `renderJunction`) capturavam `groupComponentTargets`/`groupWireMoveTargets` no
 * início do gesto e repetiam EXATAMENTE este mesmo bloco de aplicação no `onMove` de cada uma.
 * Extraído aqui: cada chamador só precisa calcular `groupDx`/`groupDy` (delta do mouse desde o
 * início do gesto, já dividido pelo zoom) e delegar. */
function applyGroupTagAlongDelta(
  groupComponentTargets: { component: WebviewComponentModel; startX: number; startY: number }[],
  groupWireMoveTargets: GroupMoveWireTargets,
  groupDx: number,
  groupDy: number
): void {
  if (groupComponentTargets.length === 0 && groupWireMoveTargets.wires.length === 0) return;
  for (const groupTarget of groupComponentTargets) {
    groupTarget.component.x = groupTarget.startX + groupDx;
    groupTarget.component.y = groupTarget.startY + groupDy;
    updateComponentPosition(groupTarget.component);
  }
  applyGroupMoveWireDelta(groupWireMoveTargets, groupDx, groupDy);
}

function duplicateEditableEndpointForSegmentMove(
  fullPoints: Point[],
  segmentIndex: number
): { points: Point[]; segmentIndex: number } {
  const duplicated = fullPoints.map((point) => ({ ...point }));
  if (segmentIndex === 0 && duplicated.length >= 2) {
    duplicated.splice(0, 0, { ...duplicated[0]! });
    return { points: duplicated, segmentIndex: 1 };
  }
  if (segmentIndex === duplicated.length - 2 && duplicated.length >= 2) {
    duplicated.push({ ...duplicated[duplicated.length - 1]! });
  }
  return { points: duplicated, segmentIndex };
}

/** Fonte única de verdade pra ligar/desligar os 3 listeners de arrasto em `window`
 * (pointermove/pointerup/pointercancel) -- os 4 gestos de arrasto que tocam fio/junção (canto,
 * canto via Shift-no-segmento, segmento, junção) repetiam esta fiação idêntica, cada um com seu
 * próprio `finish` nomeado só pra poder se referenciar nos 3 listeners. `onFinish` roda uma única
 * vez, no primeiro de pointerup/pointercancel (`{once:true}` nos dois) -- cabe ao chamador limpar
 * sua própria referência de drag (`wireCornerDrag`/`wireSegmentDrag`/etc, cada uma de um tipo
 * diferente, por isso não dá pra generalizar esse pedaço aqui sem um genérico desnecessário) e
 * decidir persistir/suprimir o próximo clique. */
function startWireDragListeners(onMove: (event: PointerEvent) => void, onFinish: () => void): void {
  const finish = (): void => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
    onFinish();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", finish, { once: true });
  window.addEventListener("pointercancel", finish, { once: true });
}

function renderWireCornerHandles(wireLayer: SVGSVGElement, wire: WebviewWireModel, points: Point[]): void {
  if (points.length < 3) return;

  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index]!;
    const handle = document.createElementNS(SVG_NS, "circle");
    handle.dataset.wireId = wire.id; // ver `updateWireVisual` -- marca de qual fio esta alça é
    handle.setAttribute("cx", String(point.x));
    handle.setAttribute("cy", String(point.y));
    handle.setAttribute("r", isWireCornerSelected(wire.id, index) ? "5.5" : "4");
    handle.setAttribute(
      "class",
      `wire-layer__corner-handle ${isWireCornerSelected(wire.id, index) ? "wire-layer__corner-handle--selected" : ""}`
    );
    handle.addEventListener("click", (event) => {
      event.stopPropagation();
      // Toggle de seleção múltipla é resolvido AQUI, fora de `handleWireGestureClick` -- é uma
      // preocupação ortogonal (seleção) à decisão "iniciar/terminar derivação" que a função unificada
      // cobre (ver seu docstring). `placingTypeId`/`suppressNextWireInteractionClick` já são
      // verificados lá dentro, não precisa duplicar aqui.
      if (!placingTypeId && !suppressNextWireInteractionClick && (event.shiftKey || event.ctrlKey || event.metaKey)) {
        toggleWireSelection(wire.id);
        persistState();
        render();
        return;
      }
      handleWireGestureClick({ kind: "wire", wireId: wire.id, point });
    });
    handle.addEventListener("contextmenu", (event) => {
      if (!isWireSelected(wire.id) || !isWireCornerSelected(wire.id, index)) selectOnlyWireCorner(wire.id, index);
      persistState();
      render();
      showContextMenu(event, [{ label: t("deleteSelectedItems"), onClick: () => deleteSelectedItems() }]);
    });
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || state.pendingConnection) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey || event.ctrlKey || event.metaKey) return;

      const canvasEl = handle.closest<HTMLElement>(".canvas");
      if (!canvasEl) return;

      if (!isWireSelected(wire.id) || !isWireCornerSelected(wire.id, index)) {
        selectOnlyWireCorner(wire.id, index);
      }

      wireCornerDrag = {
        wireId: wire.id,
        pointIndex: index,
        startFullPoints: points.map((entry) => ({ ...entry })),
        moved: false,
      };
      // "Selecionar um ramo de fio + um dispositivo e mover juntos", começando o arrasto pelo
      // PRÓPRIO ramo: se `state.selectedComponentIds` já tinha componente(s) junto (seleção mista
      // prévia via marquee/shift-click -- `selectOnlyWireCorner` acima só reseta pra solo quando o
      // canto NÃO estava selecionado ainda), eles acompanham pelo mesmo delta. `groupWireMoveTargets`
      // (`wire.id` excluído -- este fio já está sendo movido pelo `wireCornerDrag` acima, com seu
      // próprio eixo/snap) cobre o caso GERAL: qualquer OUTRO fio inteiro co-selecionado (marquee)
      // também acompanha.
      const groupComponentTargets = dragSelectionWithLinkedPinLabels().map((selected) => ({
        component: selected,
        startX: selected.x,
        startY: selected.y,
      }));
      const groupWireMoveTargets = computeGroupMoveWireTargets(wire.id);
      const groupStartClientX = event.clientX;
      const groupStartClientY = event.clientY;

      const onMove = (moveEvent: PointerEvent): void => {
        const drag = wireCornerDrag;
        if (!drag || drag.wireId !== wire.id || drag.pointIndex !== index) return;
        const wireToMove = state.topology.conductors.find((entry) => entry.id === drag.wireId);
        if (!wireToMove) return;
        const raw = eventToCanvasPoint(moveEvent, canvasEl);
        const step = moveEvent.shiftKey ? FINE_WIRE_STEP : WIRE_GRID_SIZE;
        const target = { x: snapCoordinate(raw.x, step), y: snapCoordinate(raw.y, step) };
        updateWireFromFullPath(wireToMove, moveOrthogonalWireCorner(drag.startFullPoints, drag.pointIndex, target));
        drag.moved = true;
        updateWireVisual(wire.id);
        const zoom = state.viewport.zoom || 1;
        applyGroupTagAlongDelta(
          groupComponentTargets,
          groupWireMoveTargets,
          (moveEvent.clientX - groupStartClientX) / zoom,
          (moveEvent.clientY - groupStartClientY) / zoom
        );
      };

      startWireDragListeners(onMove, () => {
        const drag = wireCornerDrag;
        wireCornerDrag = undefined;
        if (drag?.moved) {
          persistState();
          suppressNextWireInteractionClick = true;
        }
      });
    });
    wireLayer.appendChild(handle);
  }
}

function renderWireSegmentHandles(wireLayer: SVGSVGElement, wire: WebviewWireModel, points: Point[]): void {
  if (points.length < 2) return;

  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index]!;
    const to = points[index + 1]!;
    const isHorizontal = Math.abs(from.y - to.y) < 0.5;
    const isVertical = Math.abs(from.x - to.x) < 0.5;
    if (!isHorizontal && !isVertical) continue;

    if (isWireSegmentSelected(wire.id, index)) {
      const highlight = document.createElementNS(SVG_NS, "line");
      highlight.dataset.wireId = wire.id; // ver `updateWireVisual` -- marca de qual fio este realce é
      highlight.setAttribute("x1", String(from.x));
      highlight.setAttribute("y1", String(from.y));
      highlight.setAttribute("x2", String(to.x));
      highlight.setAttribute("y2", String(to.y));
      highlight.setAttribute("class", "wire-layer__segment-highlight");
      wireLayer.appendChild(highlight);
    }

    const handle = document.createElementNS(SVG_NS, "line");
    handle.dataset.wireId = wire.id; // ver `updateWireVisual` -- marca de qual fio esta alça é
    handle.setAttribute("x1", String(from.x));
    handle.setAttribute("y1", String(from.y));
    handle.setAttribute("x2", String(to.x));
    handle.setAttribute("y2", String(to.y));
    handle.setAttribute(
      "class",
      `wire-layer__segment-handle ${isHorizontal ? "wire-layer__segment-handle--horizontal" : "wire-layer__segment-handle--vertical"}`
    );
    handle.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!placingTypeId && !suppressNextWireInteractionClick && (event.shiftKey || event.ctrlKey || event.metaKey)) {
        toggleWireSelection(wire.id);
        persistState();
        render();
        return;
      }

      const canvasEl = handle.closest<HTMLElement>(".canvas");
      if (!canvasEl) return;
      const clickPoint = eventToCanvasPoint(event, canvasEl);
      const cornerIndex = wireConnectCornerIndexLikeSimulIDE(points, index, clickPoint);
      const target =
        cornerIndex !== undefined ? points[cornerIndex]! : nearestSnappedPointOnOrthogonalSegment(clickPoint, from, to, WIRE_GRID_SIZE);
      handleWireGestureClick({ kind: "wire", wireId: wire.id, point: target });
    });
    handle.addEventListener("contextmenu", (event) => {
      if (!isWireSelected(wire.id) || !isWireSegmentSelected(wire.id, index)) selectOnlyWire(wire.id, index);
      persistState();
      render();
      showContextMenu(event, [{ label: t("deleteSelectedItems"), onClick: () => deleteSelectedItems() }]);
    });
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || state.pendingConnection) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey || event.ctrlKey || event.metaKey) return;

      const canvasEl = handle.closest<HTMLElement>(".canvas");
      if (!canvasEl) return;
      const startPoint = eventToCanvasPoint(event, canvasEl);
      const cornerIndex = event.shiftKey ? wireCornerIndexNearSegmentPoint(points, index, startPoint) : undefined;

      if (cornerIndex !== undefined) {
        if (!isWireSelected(wire.id) || !isWireCornerSelected(wire.id, cornerIndex)) {
          selectOnlyWireCorner(wire.id, cornerIndex);
        }

        wireCornerDrag = {
          wireId: wire.id,
          pointIndex: cornerIndex,
          startFullPoints: points.map((entry) => ({ ...entry })),
          moved: false,
        };
        const groupComponentTargets = dragSelectionWithLinkedPinLabels().map((selected) => ({
          component: selected,
          startX: selected.x,
          startY: selected.y,
        }));
        const groupWireMoveTargets = computeGroupMoveWireTargets(wire.id);
        const groupStartClientX = event.clientX;
        const groupStartClientY = event.clientY;

        const onCornerMove = (moveEvent: PointerEvent): void => {
          const drag = wireCornerDrag;
          if (!drag || drag.wireId !== wire.id || drag.pointIndex !== cornerIndex) return;
          const wireToMove = state.topology.conductors.find((entry) => entry.id === drag.wireId);
          if (!wireToMove) return;
          const raw = eventToCanvasPoint(moveEvent, canvasEl);
          const step = moveEvent.shiftKey ? FINE_WIRE_STEP : WIRE_GRID_SIZE;
          const target = { x: snapCoordinate(raw.x, step), y: snapCoordinate(raw.y, step) };
          updateWireFromFullPath(wireToMove, moveOrthogonalWireCorner(drag.startFullPoints, drag.pointIndex, target));
          drag.moved = true;
          updateWireVisual(wire.id);
          const zoom = state.viewport.zoom || 1;
          applyGroupTagAlongDelta(
            groupComponentTargets,
            groupWireMoveTargets,
            (moveEvent.clientX - groupStartClientX) / zoom,
            (moveEvent.clientY - groupStartClientY) / zoom
          );
        };

        startWireDragListeners(onCornerMove, () => {
          const drag = wireCornerDrag;
          wireCornerDrag = undefined;
          if (drag?.moved) {
            persistState();
            suppressNextWireInteractionClick = true;
          }
        });
        return;
      }

      if (!isWireSelected(wire.id) || !isWireSegmentSelected(wire.id, index)) {
        selectOnlyWire(wire.id, index);
      }

      const prepared = duplicateEditableEndpointForSegmentMove(points, index);
      wireSegmentDrag = {
        wireId: wire.id,
        segmentIndex: prepared.segmentIndex,
        axis: isHorizontal ? "y" : "x",
        startFullPoints: prepared.points,
        moved: false,
      };
      const groupComponentTargets = dragSelectionWithLinkedPinLabels().map((selected) => ({
        component: selected,
        startX: selected.x,
        startY: selected.y,
      }));
      const groupWireMoveTargets = computeGroupMoveWireTargets(wire.id);
      const groupStartClientX = event.clientX;
      const groupStartClientY = event.clientY;

      const onMove = (moveEvent: PointerEvent): void => {
        const drag = wireSegmentDrag;
        // `prepared.segmentIndex` pode diferir de `index` quando o segmento arrastado é o primeiro
        // (duplicateEditableEndpointForSegmentMove insere um ponto duplicado antes e desloca o índice
        // de 0 pra 1) -- comparar contra `prepared.segmentIndex`, não `index` original.
        if (!drag || drag.wireId !== wire.id || drag.segmentIndex !== prepared.segmentIndex) return;
        const wireToMove = state.topology.conductors.find((entry) => entry.id === drag.wireId);
        if (!wireToMove) return;
        const current = eventToCanvasPoint(moveEvent, canvasEl);
        const step = moveEvent.shiftKey ? FINE_WIRE_STEP : WIRE_GRID_SIZE;
        const coordinate = drag.axis === "y" ? snapCoordinate(current.y, step) : snapCoordinate(current.x, step);
        updateWireFromFullPath(
          wireToMove,
          moveOrthogonalWireSegment(drag.startFullPoints, drag.segmentIndex, coordinate)
        );
        drag.moved = true;
        selectedWireSegment = { wireId: wire.id, segmentIndex: drag.segmentIndex };
        updateWireVisual(wire.id);
        const zoom = state.viewport.zoom || 1;
        applyGroupTagAlongDelta(
          groupComponentTargets,
          groupWireMoveTargets,
          (moveEvent.clientX - groupStartClientX) / zoom,
          (moveEvent.clientY - groupStartClientY) / zoom
        );
      };

      startWireDragListeners(onMove, () => {
        const drag = wireSegmentDrag;
        wireSegmentDrag = undefined;
        if (drag?.moved) {
          persistState();
          suppressNextWireInteractionClick = true;
        }
      });
    });
    wireLayer.appendChild(handle);
  }
}

function pendingConnectionPosition(): Point | undefined {
  const pending = state.pendingConnection;
  if (!pending) return undefined;
  if (pending.kind === "wire") return pending.point;
  const component = state.components.find((item) => item.id === pending.componentId);
  return component && pinScenePosition(component, pending.pinId);
}

function pendingWireAnchor(): Point | undefined {
  const start = pendingConnectionPosition();
  if (!start) return undefined;
  return pendingWireRoute[pendingWireRoute.length - 1] ?? start;
}

function pendingWirePreviewPoints(): Point[] {
  const start = pendingConnectionPosition();
  if (!start) return [];
  const target = pendingWirePreviewTarget;
  return target ? buildOrthogonalPath([start, ...pendingWireRoute, target]) : [start, ...pendingWireRoute];
}

function renderPendingWirePreview(wireLayer: SVGSVGElement): void {
  const points = pendingWirePreviewPoints();
  if (points.length < 2) return;
  const polyline = document.createElementNS(SVG_NS, "polyline");
  polyline.dataset.wirePreview = "pending";
  setPolylinePoints(polyline, points);
  polyline.setAttribute("class", "wire-layer__wire wire-layer__wire--preview");
  wireLayer.appendChild(polyline);
}

function refreshPendingWirePreview(): void {
  const wireLayer = document.querySelector<SVGSVGElement>(".wire-layer");
  if (!wireLayer) return;
  let polyline = wireLayer.querySelector<SVGPolylineElement>('polyline[data-wire-preview="pending"]');
  const points = pendingWirePreviewPoints();
  if (points.length < 2) {
    polyline?.remove();
    return;
  }
  if (!polyline) {
    polyline = document.createElementNS(SVG_NS, "polyline");
    polyline.dataset.wirePreview = "pending";
    polyline.setAttribute("class", "wire-layer__wire wire-layer__wire--preview");
    wireLayer.appendChild(polyline);
  }
  setPolylinePoints(polyline, points);
}

function appendPendingWireBend(point: Point): void {
  const anchor = pendingWireAnchor();
  if (!anchor) return;
  const snappedPoint = snapToWireGrid(point);
  const segment = orthogonalSegmentPoints(anchor, snappedPoint);
  const beforeLength = pendingWireRoute.length;
  for (const routePoint of segment.slice(1)) appendPoint(pendingWireRoute, routePoint);
  pendingWireBendLengths.push(pendingWireRoute.length - beforeLength);
}

function undoPendingWireBend(): void {
  const lastLength = pendingWireBendLengths.pop();
  if (!lastLength) return;
  pendingWireRoute.splice(Math.max(0, pendingWireRoute.length - lastLength), lastLength);
}

function pendingWirePointsForTarget(target: Point): Point[] {
  const anchor = pendingWireAnchor();
  if (!anchor) return [];
  const points = pendingWireRoute.map((point) => ({ ...point }));
  const segment = orthogonalSegmentPoints(anchor, target);
  for (const routePoint of segment.slice(1, -1)) appendPoint(points, routePoint);
  return points;
}

function selectedWireSegmentInfo():
  | { wire: WebviewWireModel; from: Point; to: Point; axis: "x" | "y"; segmentIndex: number }
  | undefined {
  normalizeSelectedWireSegment();
  if (!selectedWireSegment) return undefined;
  const wire = state.topology.conductors.find((entry) => entry.id === selectedWireSegment?.wireId);
  if (!wire) return undefined;
  const points = wirePolylinePoints(wire);
  const from = points[selectedWireSegment.segmentIndex];
  const to = points[selectedWireSegment.segmentIndex + 1];
  if (!from || !to) return undefined;
  if (Math.abs(from.y - to.y) < 0.5) return { wire, from, to, axis: "y", segmentIndex: selectedWireSegment.segmentIndex };
  if (Math.abs(from.x - to.x) < 0.5) return { wire, from, to, axis: "x", segmentIndex: selectedWireSegment.segmentIndex };
  return undefined;
}

function moveSelectedWireSegmentByArrow(key: string, step: number): boolean {
  const info = selectedWireSegmentInfo();
  if (!info) return false;
  if (info.segmentIndex <= 0 || info.segmentIndex >= wirePolylinePoints(info.wire).length - 2) return false;

  const currentCoordinate = info.axis === "y" ? info.from.y : info.from.x;
  const delta =
    info.axis === "y"
      ? key === "ArrowUp"
        ? -step
        : key === "ArrowDown"
          ? step
          : undefined
      : key === "ArrowLeft"
        ? -step
        : key === "ArrowRight"
          ? step
          : undefined;
  if (delta === undefined) return false;

  updateWireFromFullPath(info.wire, moveOrthogonalWireSegment(wirePolylinePoints(info.wire), info.segmentIndex, currentCoordinate + delta));
  persistState();
  render();
  return true;
}

function moveSelectedWireCornerByArrow(key: string, step: number): boolean {
  normalizeSelectedWireCorner();
  if (!selectedWireCorner) return false;
  const wire = state.topology.conductors.find((entry) => entry.id === selectedWireCorner?.wireId);
  if (!wire) return false;

  const points = wirePolylinePoints(wire);
  const current = points[selectedWireCorner.pointIndex];
  if (!current) return false;

  const delta =
    key === "ArrowUp"
      ? { x: 0, y: -step }
      : key === "ArrowDown"
        ? { x: 0, y: step }
        : key === "ArrowLeft"
          ? { x: -step, y: 0 }
          : key === "ArrowRight"
            ? { x: step, y: 0 }
            : undefined;
  if (!delta) return false;

  updateWireFromFullPath(
    wire,
    moveOrthogonalWireCorner(points, selectedWireCorner.pointIndex, { x: current.x + delta.x, y: current.y + delta.y })
  );
  persistState();
  render();
  return true;
}

/** Move todos os componentes selecionados por `step` px na direção da tecla de seta -- mesmo padrão
 * do SimulIDE (`Component::keyPressEvent` com `GRID_SIZE` step). Posições são puramente visuais:
 * nenhuma notificação pro Core (o Core não usa coordenadas xy). Retorna `false` se nada foi movido. */
function moveSelectedComponentsByArrow(key: string, step: number): boolean {
  const components = getSelectedComponents();
  if (components.length === 0) return false;
  const dx = key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0;
  const dy = key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0;
  if (dx === 0 && dy === 0) return false;
  for (const component of components) {
    component.x += dx;
    component.y += dy;
  }
  persistState();
  render();
  return true;
}

function pinScenePosition(component: WebviewComponentModel, pinId: string): Point | undefined {
  const pinIndex = component.pins.findIndex((pin) => pin.id === pinId);
  if (pinIndex < 0) return undefined;
  const local = componentPinLocalPosition(component, pinIndex);
  return { x: component.x + local.x, y: component.y + local.y };
}

/** Depois de soltar um arrasto de componente, verifica se algum dos pinos dele agora encosta
 * EXATAMENTE (não só "perto") em cima de um fio que ainda não toca esse componente -- se sim, cria a
 * junção automaticamente, igual ao clique-pra-derivar. Corrige "parece
 * conectado mas não está" ao arrastar um componente por cima de um fio existente. Tolerância pequena
 * de propósito (só overlap real, não "nas redondezas") -- diferente do hit-test de clique explícito
 * (`WIRE_GRID_SIZE`), já que este gatilho é automático/passivo, não uma ação deliberada do usuário. */
function maybeAutoJunctionForDraggedComponents(componentIds: string[]): void {
  for (const componentId of componentIds) {
    const component = state.components.find((entry) => entry.id === componentId);
    if (!component) continue;
    const touchingWireIds = new Set(
      state.topology.conductors.filter((wire) => endpointId(wire.from) === componentId || endpointId(wire.to) === componentId).map((wire) => wire.id)
    );
    for (const pin of component.pins) {
      const pinPos = pinScenePosition(component, pin.id);
      if (!pinPos) continue;

      let matchedWire: WebviewWireModel | undefined;
      let matchedTarget: Point | undefined;
      for (const candidate of wireSpatialIndex.queryPoint(pinPos, 0.5)) {
        if (touchingWireIds.has(candidate.wireId)) continue;
        const wire = state.topology.conductors.find((entry) => entry.id === candidate.wireId);
        if (!wire) continue;
        const from = candidate.from;
        const to = candidate.to;
        const isHorizontal = Math.abs(from.y - to.y) < 0.5;
        const isVertical = Math.abs(from.x - to.x) < 0.5;
        if (!isHorizontal && !isVertical) continue;
        const projected = nearestPointOnOrthogonalSegment(pinPos, from, to);
        if (Math.hypot(projected.x - pinPos.x, projected.y - pinPos.y) < 0.5) {
          matchedWire = wire;
          matchedTarget = projected;
          break;
        }
      }
      if (!matchedWire || !matchedTarget) continue;

      send({
        version: WEBVIEW_MESSAGE_VERSION,
        type: "requestConnectEndpoints",
        baseRevision: state.topology.revision ?? 0,
        from: { kind: "pin", componentId, pinId: pin.id },
        to: { kind: "wire", wireId: matchedWire.id, point: matchedTarget },
      });
      touchingWireIds.add(matchedWire.id); // não tenta o mesmo fio de novo pra outro pino desta mesma passada
    }
  }
}

let wiresByComponentCacheKey = "";
let wiresByComponentCache = new Map<string, WebviewWireModel[]>();

function wiresByComponentId(): Map<string, WebviewWireModel[]> {
  const key = state.topology.conductors.map((wire) => `${wire.id}:${endpointId(wire.from)}>${endpointId(wire.to)}`).join("|");
  if (key === wiresByComponentCacheKey) return wiresByComponentCache;
  const next = new Map<string, WebviewWireModel[]>();
  for (const wire of state.topology.conductors) {
    const fromKey = endpointId(wire.from);
    const toKey = endpointId(wire.to);
    const fromList = next.get(fromKey) ?? [];
    fromList.push(wire);
    next.set(fromKey, fromList);
    if (toKey !== fromKey) {
      const toList = next.get(toKey) ?? [];
      toList.push(wire);
      next.set(toKey, toList);
    }
  }
  wiresByComponentCacheKey = key;
  wiresByComponentCache = next;
  return next;
}

function updateWiresTouchingComponent(componentId: string): void {
  for (const wire of wiresByComponentId().get(componentId) ?? []) {
    // Lookup O(1) via `wirePolylineElementsById` (UI-2/UI-3) em vez de `querySelector` -- percorrido
    // uma vez por fio tocado a cada `pointermove` de um arrasto de componente, potencialmente muitas
    // vezes por segundo em circuitos grandes.
    const polyline = wirePolylineElementsById.get(wire.id);
    if (!polyline) continue;
    const points = wirePolylinePoints(wire);
    if (points.length < 2) continue;
    setPolylinePoints(polyline, points);
    polyline.setAttribute("class", wireClass(wire.id));
  }
}

/** Atualização de UM fio (polyline + suas próprias alças/realces) sem tocar em nenhum outro fio ou
 * componente -- chamado a cada `pointermove` de um arrasto de canto/segmento de fio (UI-2/UI-3) em
 * vez do `render()` completo de sempre, que reconstruía TODO o canvas (todos os componentes E todos
 * os fios) a cada pixel de movimento do mouse. As alças/realces deste fio são marcadas com
 * `dataset.wireId` (ver `renderWireCornerHandles`/`renderWireSegmentHandles`) -- removidas e
 * reconstruídas do zero aqui (elas têm listener próprio capturando `points` da posição atual, então
 * "atualizar" em vez de recriar exigiria reatribuir os 5 listeners também; reconstruir só ESTE fio é
 * barato o bastante, o caro era reconstruir os OUTROS fios/componentes junto). */
function updateWireVisual(wireId: string): void {
  const wire = state.topology.conductors.find((entry) => entry.id === wireId);
  const wireLayer = document.querySelector<SVGSVGElement>(".wire-layer");
  if (!wire || !wireLayer) return;
  const points = wirePolylinePoints(wire);

  for (const child of Array.from(wireLayer.children)) {
    if (child instanceof SVGPolylineElement) continue; // polyline reaproveitado abaixo, nunca removido aqui
    if (child instanceof SVGElement && child.dataset.wireId === wireId) child.remove();
  }

  const polyline = wirePolylineElementsById.get(wireId);
  if (points.length < 2 || !polyline) return;
  setPolylinePoints(polyline, points);
  polyline.setAttribute("class", wireClass(wireId));
  renderWireSegmentHandles(wireLayer, wire, points);
  renderWireCornerHandles(wireLayer, wire, points);
}

function numericReadout(component: WebviewComponentModel): number | undefined {
  const readout = readoutsByComponentId[component.id];
  return typeof readout === "number" ? readout : undefined;
}

/** ABI v2 (.spec/lasecsimul-native-devices.spec): consulta `interactionKind` do catálogo (vindo do
 * Core via `getPropertySchemas`) em vez de checar typeId -- fallback legado só pra typeId sem o
 * campo declarado ainda (catálogo não carregou do Core). */
function interactionKindFor(typeId: string): InteractionKindEntry {
  const declared = catalogEntryFor(typeId)?.interactionKind;
  if (declared) return declared;
  if (typeId === "switches.push") return "momentary";
  if (typeId === "switches.switch" || typeId === "switches.switch_dip") return "toggle";
  return "none";
}

function viewSpecInteractionFor<K extends ViewSpecInteraction["kind"]>(
  typeId: string,
  kind: K
): Extract<ViewSpecInteraction, { kind: K }> | undefined {
  const interactions = catalogEntryFor(typeId)?.package?.viewSpec?.interaction;
  if (!interactions) return undefined;
  return Object.values(interactions).find(
    (entry): entry is Extract<ViewSpecInteraction, { kind: K }> => entry.kind === kind
  );
}

function mapLinear(value: number, from: [number, number], to: [number, number]): number {
  if (from[0] === from[1]) return to[0];
  const t = (value - from[0]) / (from[1] - from[0]);
  return to[0] + t * (to[1] - to[0]);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function numericComponentProperty(component: WebviewComponentModel, prop: string | undefined, fallback: number): number {
  if (!prop) return fallback;
  const value = Number(component.properties[prop]);
  return Number.isFinite(value) ? value : fallback;
}

function usesEmbeddedValueLabel(typeId: string): boolean {
  // sources.fixed_volt/sources.rail mostram um valor CONFIGURADO (propriedade estática), não uma
  // leitura medida -- conceito diferente de `readoutFormat` (ABI v2), que é só pra instrumentos com
  // leitura simulada (ver findCatalogEntry abaixo). Os dois continuam embutindo valor no símbolo,
  // por isso ficam juntos nesta função, mas a ORIGEM do "embute valor" é diferente pra cada um.
  if (typeId === "sources.fixed_volt" || typeId === "sources.rail") return true;
  if (catalogEntryFor(typeId)?.readoutFormat) return true;
  // Fallback legado -- typeId sem readoutFormat no catálogo ainda.
  return typeId === "instruments.voltmeter" || typeId.startsWith("meters.");
}

/** `readoutFormat.kind` (ABI v2) de um typeId quando é "de histórico" (janela "Expande" faz
 * sentido) -- `channelHistory` é o osciloscópio (N canais analógicos), `bitmaskHistory` o
 * analisador lógico (1 palavra digital por amostra). Substitui checar
 * `typeId === "meters.oscope"`/`"meters.logic_analyzer"` nos 4 pontos que decidem "isto tem
 * histórico e de que FORMA" -- sem isto, um instrumento de terceiros (device/plugin) com o mesmo
 * `readoutFormat.kind` nunca ganharia popup "Expande"/rastreamento de histórico, só os 2 builtins.
 * Fallback legado pros mesmos 2 typeIds cobre o catálogo ainda não ter chegado do Core. */
function instrumentHistoryKind(typeId: string): "channelHistory" | "bitmaskHistory" | undefined {
  const readoutFormat = catalogEntryFor(typeId)?.readoutFormat;
  if (readoutFormat?.kind === "channelHistory" || readoutFormat?.kind === "bitmaskHistory") return readoutFormat.kind;
  if (readoutFormat) return undefined;
  // Fallback legado -- typeId sem readoutFormat no catálogo ainda.
  if (typeId === "meters.oscope") return "channelHistory";
  if (typeId === "meters.logic_analyzer") return "bitmaskHistory";
  return undefined;
}

function voltmeterReadoutText(component: WebviewComponentModel): string {
  const readout = numericReadout(component);
  if (typeof readout === "number") return `${readout.toFixed(3)} V`;
  return simulationStatus === "running" ? "... V" : "0.000 V";
}

function runtimeSymbolProperties(component: WebviewComponentModel): Record<string, unknown> {
  const readout = readoutsByComponentId[component.id];
  const scopeHistory = scopeHistoryByComponentId[component.id];
  const logicHistory = logicHistoryByComponentId[component.id];
  if (readout === undefined && !scopeHistory && !logicHistory) return component.properties;
  return {
    ...component.properties,
    ...(readout === undefined ? {} : { __readout: readout }),
    ...(scopeHistory ? { __history: scopeHistory } : {}),
    ...(logicHistory ? { __history: logicHistory } : {}),
  };
}

function updateReadoutHistories(readouts: Record<string, ComponentReadoutValue>): void {
  const activeIds = new Set(state.components.map((component) => component.id));
  const scopeHistories: Record<string, number[][]> = {};
  const logicHistories: Record<string, number[]> = {};
  for (const [componentId, history] of Object.entries(scopeHistoryByComponentId)) {
    if (activeIds.has(componentId)) scopeHistories[componentId] = history;
  }
  for (const [componentId, history] of Object.entries(logicHistoryByComponentId)) {
    if (activeIds.has(componentId)) logicHistories[componentId] = history;
  }
  for (const component of state.components) {
    const readout = readouts[component.id];
    if (instrumentHistoryKind(component.typeId) === "channelHistory" && Array.isArray(readout)) {
      const previous = scopeHistoryByComponentId[component.id] ?? [[], [], [], []];
      scopeHistories[component.id] = [0, 1, 2, 3].map((channel) => {
        const history = [...(previous[channel] ?? []), Number(readout[channel] ?? 0)];
        return history.slice(-INSTRUMENT_HISTORY_DEPTH);
      });
    }
    if (instrumentHistoryKind(component.typeId) === "bitmaskHistory" && typeof readout === "number") {
      const history = [...(logicHistoryByComponentId[component.id] ?? []), readout >>> 0];
      logicHistories[component.id] = history.slice(-INSTRUMENT_HISTORY_DEPTH);
    }
  }
  scopeHistoryByComponentId = scopeHistories;
  logicHistoryByComponentId = logicHistories;
  // Mesmo ritmo do poll de telemetria pequena (~300ms) -- só pros componentes com janela "Expande"
  // aberta agora, ver doc de `realScopeHistoryByComponentId` acima.
  for (const componentId of instrumentPopups.keys()) requestInstrumentHistoryRefresh(componentId);
  renderInstrumentPopups();
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// Janela "Expande" do osciloscópio/analisador lógico -- igual ao SimulIDE real (OscWidget popup
// flutuante, independente do zoom/pan do canvas principal). Reaproveita o MESMO histórico de
// amostras que já alimenta a pré-visualização pequena (`scopeHistoryByComponentId`/
// `logicHistoryByComponentId`, ver `updateReadoutHistories`) -- só desenha maior, com controles.
// ════════════════════════════════════════════════════════════════════════════════════════════

/** `timePosMs` é POR CANAL (igual a `Oscope::m_timePos[4]` real) -- cada traço pode ser deslocado
 * horizontalmente de forma independente, além do deslocamento compartilhado vindo do trigger. */
interface ScopeChannelSettings {
  hidden: boolean;
  voltDiv: number;
  voltPos: number;
  timePosMs: number;
}

/** `triggerSource` é UMA fonte compartilhada por TODOS os canais (igual a `Oscope::m_trigger`,
 * `int 0..3` ou nenhum) -- um osciloscópio real tem UM circuito de disparo, não um por canal;
 * `autoScaleChannel` é o canal-alvo de auto-escala contínua (`Oscope::m_auto`, ver
 * `OscopeChannel::updateStep()`) -- enquanto ativo, Divisão de Tempo/Tensão/Posição daquele canal
 * seguem o período/amplitude detectados automaticamente a cada atualização, como o botão "Auto" de
 * um osciloscópio de bancada. `filterThreshold` é a histerese de detecção de borda (mesmo papel de
 * `OscWidget::filterBox`) -- evita disparo falso por ruído de baixa amplitude. */
interface ScopePopupState {
  kind: "oscope";
  componentId: string;
  x: number;
  y: number;
  activeTab: 0 | 1 | 2 | 3 | "all";
  timeDivMs: number;
  tracks: 1 | 2 | 4;
  channels: ScopeChannelSettings[];
  triggerSource: 0 | 1 | 2 | 3 | "none";
  autoScaleChannel: 0 | 1 | 2 | 3 | "none";
  filterThreshold: number;
}

interface LogicPopupState {
  kind: "logic";
  componentId: string;
  x: number;
  y: number;
  timeDivMs: number;
  timePosMs: number;
  hiddenChannels: boolean[];
  triggerChannel: number | "none";
  thresholdUp: number;
  thresholdDown: number;
}

type InstrumentPopupState = ScopePopupState | LogicPopupState;

const instrumentPopups = new Map<string, InstrumentPopupState>();
/** Posição bruta 0-1000 do `QDial` por knob (`makeKnobRow`), chave `${componentId}:${labelText}` --
 * MESMO modelo do real (`QDial` interno sempre 0-1000, `CustomDial::CustomDial` -- ver docstring de
 * `dialKnobSvg`, `componentSymbols.ts`). Os knobs de Divisão/Posição de Tempo/Tensão do osciloscópio
 * são `wrapping=true` no real (`oscwidget.ui`) e NUNCA representam o valor físico diretamente (ver
 * `OscWidget::on_timeDivDial_valueChanged` -- só a DIREÇÃO do movimento importa, aplicada como ~1%
 * do valor atual); esta posição existe só pra desenhar o nub girando visualmente a cada interação,
 * igual ao encoder "infinito" real -- nunca derivada do valor físico (µs↔s teria que pular loucamente
 * de posição a cada refresh). Sobrevive a re-renders (módulo, não escopo de função) até a janela
 * fechar; nunca limpo por componente removido (leak inofensivo, mesma classe de decisão de
 * `state.ts::lastLoadedFirmwareByCoreId`). */
const knobDialPositions = new Map<string, number>();
// Cores EXATAS do SimulIDE real (plotbase.cpp: m_color[0..3] = RGB(240,240,100)/(220,220,255)/
// (255,210,90)/(0,245,160)) -- canais 4-7 do analisador lógico reusam as mesmas 4 cores (i % 4).
const INSTRUMENT_CHANNEL_COLORS = ["#f0f064", "#dcdcff", "#ffd25a", "#00f5a0", "#f0f064", "#dcdcff", "#ffd25a", "#00f5a0"];

const instrumentPopupLayer = document.createElement("div");
instrumentPopupLayer.className = "instrument-popup-layer";
document.body.appendChild(instrumentPopupLayer);

function defaultScopePopupState(componentId: string, x: number, y: number): ScopePopupState {
  return {
    kind: "oscope",
    componentId,
    x,
    y,
    activeTab: "all",
    timeDivMs: 1000,
    tracks: 4,
    channels: [0, 1, 2, 3].map(() => ({ hidden: false, voltDiv: 1, voltPos: 0, timePosMs: 0 })),
    triggerSource: "none",
    autoScaleChannel: "none",
    filterThreshold: 0.05,
  };
}

/** `thresholdUp`/`thresholdDown` espelham as propriedades REAIS do componente no Core
 * (`thresholdRising`/`thresholdFalling`, ver `LogicAnalyzer.hpp`) -- lidas do componente ao abrir
 * (não um padrão fixo do popup) e gravadas de volta via `requestUpdateProperty` quando editadas
 * aqui (ver `buildLogicPopup`), pra editar a histerese de verdade, não só um valor decorativo. */
function defaultLogicPopupState(component: WebviewComponentModel, x: number, y: number): LogicPopupState {
  return {
    kind: "logic",
    componentId: component.id,
    x,
    y,
    timeDivMs: 1000,
    timePosMs: 0,
    hiddenChannels: Array.from({ length: 8 }, () => false),
    triggerChannel: "none",
    thresholdUp: Number(component.properties.thresholdRising ?? 2.5),
    thresholdDown: Number(component.properties.thresholdFalling ?? 2.5),
  };
}

function requestInstrumentHistoryRefresh(componentId: string): void {
  send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestInstrumentHistory", componentId });
}

function toggleInstrumentPopup(component: WebviewComponentModel): void {
  if (instrumentPopups.has(component.id)) {
    instrumentPopups.delete(component.id);
    realScopeHistoryByComponentId.delete(component.id);
    realLogicHistoryByComponentId.delete(component.id);
  } else {
    const cascadeOffset = (instrumentPopups.size % 6) * 28;
    const historyKind = instrumentHistoryKind(component.typeId);
    if (historyKind === "channelHistory") {
      instrumentPopups.set(component.id, defaultScopePopupState(component.id, 90 + cascadeOffset, 90 + cascadeOffset));
    } else if (historyKind === "bitmaskHistory") {
      instrumentPopups.set(component.id, defaultLogicPopupState(component, 90 + cascadeOffset, 90 + cascadeOffset));
    }
    requestInstrumentHistoryRefresh(component.id);
  }
  renderInstrumentPopups();
}

function closeInstrumentPopup(componentId: string): void {
  instrumentPopups.delete(componentId);
  renderInstrumentPopups();
}

/** Adapta o histórico de um componente pro formato unificado `{timestampsNs, values}` por canal --
 * prefere o histórico REAL (`realScopeHistoryByComponentId`, ver doc lá); se ainda não chegou
 * nenhuma resposta de `requestInstrumentHistory` (popup recém-aberto), cai no histórico
 * APROXIMADO de sempre, sintetizando timestamps no intervalo de poll (só pra não desenhar um plot
 * vazio no primeiro frame). */
function scopeChannelsFor(componentId: string): Array<{ timestampsNs: number[]; values: number[] }> {
  const real = realScopeHistoryByComponentId.get(componentId);
  if (real) return real;
  const approx = scopeHistoryByComponentId[componentId] ?? [[], [], [], []];
  return approx.map((values) => ({ values, timestampsNs: values.map((_, i) => i * INSTRUMENT_POLL_INTERVAL_MS * 1e6) }));
}

function logicChannelFor(componentId: string): { timestampsNs: number[]; masks: number[] } {
  const real = realLogicHistoryByComponentId.get(componentId);
  if (real) return real;
  const approx = logicHistoryByComponentId[componentId] ?? [];
  return { masks: approx, timestampsNs: approx.map((_, i) => i * INSTRUMENT_POLL_INTERVAL_MS * 1e6) };
}

function instrumentPlotPolyline(samples: number[], plotW: number, valueToY: (value: number) => number): string {
  if (samples.length === 0) return "";
  return samples
    .map((value, index) => `${(index === 0 ? "M" : "L")} ${((index / Math.max(1, samples.length - 1)) * plotW).toFixed(1)} ${valueToY(value).toFixed(1)}`)
    .join(" ");
}

function instrumentPlotGridSvg(plotW: number, plotH: number, divisions = 10, rows = 8): string {
  const cols = Array.from({ length: divisions + 1 }, (_, i) => {
    const x = (i * plotW) / divisions;
    return `<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${plotH}" class="instrument-plot-grid${i === divisions / 2 ? " instrument-plot-grid--center" : ""}"/>`;
  }).join("");
  const rowLines = Array.from({ length: rows + 1 }, (_, i) => {
    const y = (i * plotH) / rows;
    return `<line x1="0" y1="${y.toFixed(1)}" x2="${plotW}" y2="${y.toFixed(1)}" class="instrument-plot-grid${i === rows / 2 ? " instrument-plot-grid--center" : ""}"/>`;
  }).join("");
  return cols + rowLines;
}

/** Porta fiel de `Oscope::updateStep()`+`setTrigger()`/`setAutoSC()` -- UMA fonte de trigger
 * compartilhada alinha TODOS os canais visíveis ao mesmo instante (mais o deslocamento próprio de
 * cada canal, `timePosMs`); o canal de auto-escala (se algum) tem Divisão de Tempo/Tensão/Posição
 * recalculados a cada atualização a partir do período/amplitude detectados -- mutação deliberada
 * de `popup` durante o render, mesma semântica de "os botões/diais se movem sozinhos" do osciloscópio
 * de bancada real enquanto "Auto" está ativo. */
function renderScopePopupPlot(popup: ScopePopupState, channels: Array<{ timestampsNs: number[]; values: number[] }>): SVGSVGElement {
  // 560x448 -- MESMO tamanho de `.instrument-plot-svg` (styles.css), pra 10x8 divisões ficarem
  // quadradas (56x56px cada) em vez de esticadas -- bug corrigido 2026-07-09, ver comentário lá.
  const plotW = 560;
  const plotH = 448;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${plotW} ${plotH}`);
  svg.classList.add("instrument-plot-svg");
  let markup = `<rect x="0" y="0" width="${plotW}" height="${plotH}" fill="#050505"/>` + instrumentPlotGridSvg(plotW, plotH);

  if (popup.autoScaleChannel !== "none") {
    const autoChannel = channels[popup.autoScaleChannel];
    const autoSettings = popup.channels[popup.autoScaleChannel];
    if (autoChannel && autoSettings) {
      const autoTrigger = detectChannelTrigger(autoChannel.timestampsNs, autoChannel.values, popup.filterThreshold);
      if (autoTrigger.periodNs !== undefined && autoTrigger.periodNs > 0) {
        popup.timeDivMs = autoTrigger.periodNs / 5 / 1e6;
        autoSettings.voltDiv = Math.max(0.001, autoTrigger.amplitude / 8);
        autoSettings.voltPos = -autoTrigger.mid;
      }
    }
  }

  const timeFrameNs = Math.max(1, popup.timeDivMs) * 1e6 * 10;
  const latestSampleNs = Math.max(0, ...channels.map((c) => c.timestampsNs[c.timestampsNs.length - 1] ?? 0));
  const triggerChannelHistory = popup.triggerSource !== "none" ? channels[popup.triggerSource] : undefined;
  const trigger = triggerChannelHistory ? detectChannelTrigger(triggerChannelHistory.timestampsNs, triggerChannelHistory.values, popup.filterThreshold) : undefined;
  const sharedWindowEndNs = trigger ? triggerAlignedWindowEndNs(latestSampleNs, trigger, timeFrameNs) : latestSampleNs;

  const channelIndices = popup.activeTab === "all" ? [0, 1, 2, 3] : [popup.activeTab];
  for (const channel of channelIndices) {
    const settings = popup.channels[channel];
    if (!settings || settings.hidden) continue;
    const fullHistory = channels[channel] ?? { timestampsNs: [], values: [] };
    const windowEndNs = sharedWindowEndNs + settings.timePosMs * 1e6;
    const { start, end } = visibleSampleWindowByTime(fullHistory.timestampsNs, windowEndNs, timeFrameNs);
    const samples = fullHistory.values.slice(start, end + 1);
    const voltsPerPx = (settings.voltDiv * 8) / plotH; // 8 divisões verticais
    const valueToY = (value: number) => plotH / 2 - (value + settings.voltPos) / voltsPerPx;
    markup += `<path d="${instrumentPlotPolyline(samples, plotW, valueToY)}" fill="none" stroke="${INSTRUMENT_CHANNEL_COLORS[channel]}" stroke-width="2"/>`;
  }
  svg.innerHTML = markup;
  return svg;
}

/** Trigger do analisador lógico é mais simples que o do osciloscópio (sinal já digitalizado, nível
 * conhecido -- 0/1 -- não precisa de auto-detecção de amplitude): `Oscope` faz `simTime =
 * risEdge-delta` (encaixe de período); `LAnalizer::updateStep()` faz `simTime = risEdge`
 * DIRETAMENTE -- a borda de disparo cai exatamente na borda direita da tela, sem encaixe de
 * período (mesma fidelidade, função mais simples porque o sinal de origem é mais simples). */
function renderLogicPopupPlot(popup: LogicPopupState, history: { timestampsNs: number[]; masks: number[] }): SVGSVGElement {
  // 560x448 -- MESMO tamanho de `.instrument-plot-svg` (styles.css) e do osciloscópio
  // (`renderScopePopupPlot`), pra 10x8 divisões ficarem quadradas -- bug corrigido 2026-07-09.
  const plotW = 560;
  const plotH = 448;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${plotW} ${plotH}`);
  svg.classList.add("instrument-plot-svg");
  let markup = `<rect x="0" y="0" width="${plotW}" height="${plotH}" fill="#050505"/>` + instrumentPlotGridSvg(plotW, plotH, 10, 8);

  const visibleChannels = INSTRUMENT_CHANNEL_COLORS.map((_, ch) => ch).filter((ch) => !popup.hiddenChannels[ch]);
  const rowH = plotH / Math.max(1, visibleChannels.length);
  const timeFrameNs = Math.max(1, popup.timeDivMs) * 1e6 * 10;
  const latestSampleNs = history.timestampsNs[history.timestampsNs.length - 1] ?? 0;
  let windowEndNs = latestSampleNs;
  if (popup.triggerChannel !== "none") {
    const bits = history.masks.map((mask) => (mask >>> (popup.triggerChannel as number)) & 1);
    const edgeIndex = findTriggerAnchorIndex(bits, 1);
    if (edgeIndex !== undefined) windowEndNs = history.timestampsNs[edgeIndex]!;
  }
  windowEndNs += popup.timePosMs * 1e6;
  const { start, end } = visibleSampleWindowByTime(history.timestampsNs, windowEndNs, timeFrameNs);
  const samples = history.masks.slice(start, end + 1);

  visibleChannels.forEach((channel, row) => {
    const rowTop = row * rowH;
    const high = rowTop + rowH * 0.25;
    const low = rowTop + rowH * 0.75;
    const points = samples
      .map((mask, index) => {
        const x = (index / Math.max(1, samples.length - 1)) * plotW;
        const y = ((mask >>> channel) & 1) === 1 ? high : low;
        return `${index === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(" ");
    markup += `<path d="${points}" fill="none" stroke="${INSTRUMENT_CHANNEL_COLORS[channel]}" stroke-width="2"/>`;
  });
  svg.innerHTML = markup;
  return svg;
}

function makeFieldRow(labelText: string, input: HTMLElement): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "instrument-field";
  const label = document.createElement("label");
  label.textContent = labelText;
  row.append(label, input);
  return row;
}

function makeNumberInput(value: number, step: number, onChange: (value: number) => void): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "number";
  input.value = String(value);
  input.step = String(step);
  input.addEventListener("change", () => {
    const parsed = Number(input.value);
    if (Number.isFinite(parsed)) onChange(parsed);
  });
  return input;
}

/** Botão de canal (Ch1-Ch4/All) com a cor de fundo do PRÓPRIO canal -- réplica do
 * `oscwidget.cpp`/`oscwidget.ui` real (QPushButton checkable, background = cor do canal via
 * stylesheet, borda "inset" quando ativo). */
function makeChannelButton(label: string, color: string, active: boolean, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.className = `instrument-channel-button${active ? " instrument-channel-button--active" : ""}`;
  button.style.background = color;
  button.addEventListener("click", onClick);
  return button;
}

/** Knob visual do osciloscópio/analisador lógico -- usa `dialKnobSvg` (`componentSymbols.ts`) no
 * modo **contínuo/múltiplas voltas** (`wrapping: true`), NÃO no modo limitado de uma volta só que
 * `other.dial`/Potenciômetro/Resistor-Indutor-Capacitor Variável usam (ver a distinção completa dos
 * dois modelos na docstring de `dialKnobSvg`) -- pedido explícito do usuário 2026-07-09: "no
 * osciloscópio ele pode girar várias vezes e cada ciclo vai incrementando, não com um valor de
 * máximo e mínimo em uma volta". Confirma a fidelidade com o real: `timeDivDial`/`timePosDial`/
 * `voltDivDial`/`voltPosDial` de `oscwidget.ui` são `QDial` nativos `wrapping=true`, e o valor muda
 * por DIREÇÃO relativa (~1% do valor atual por "clique" do encoder,
 * `OscWidget::on_timeDivDial_valueChanged`) -- SEM min/max nenhum, cresce/encolhe indefinidamente
 * conforme o usuário continua girando (só `options.min`, quando presente, evita valor negativo/zero
 * onde não faz sentido físico, ex: Divisão de Tempo). O nub gira a cada interação via
 * `knobDialPositions` (módulo-level, mesmo modelo 0-1000 do `QDial` interno real, dá uma volta
 * visual completa a cada ~25 "cliques" do encoder) -- é feedback de "girei o botão", nunca uma
 * leitura do valor físico (não existe ângulo que representaria µs↔s numa volta só). */
function makeKnobRow(
  knobKey: string,
  labelText: string,
  value: number,
  step: number,
  onChange: (value: number) => void,
  options?: { dialStep?: (value: number) => number; reverse?: boolean; min?: number }
): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "instrument-knob-row";

  const dial = document.createElement("span");
  dial.className = "instrument-knob-dial";
  dial.tabIndex = 0;

  const renderDial = (): void => {
    const dialPos = knobDialPositions.get(knobKey) ?? 500;
    dial.innerHTML = `<svg viewBox="0 0 32 32" class="instrument-knob-dial__svg">${dialKnobSvg(16, 16, 15, { ratio: dialPos / 1000, wrapping: true, idSeed: knobKey.replace(/[^a-zA-Z0-9]/g, "-") })}</svg>`;
  };
  renderDial();

  const dialStep = () => Math.max(1e-12, options?.dialStep?.(value) ?? step);
  const spinDial = (direction: 1 | -1): void => {
    const previous = knobDialPositions.get(knobKey) ?? 500;
    knobDialPositions.set(knobKey, ((previous + direction * 40) % 1000 + 1000) % 1000);
    renderDial();
  };
  const applyDialDelta = (direction: 1 | -1) => {
    const signed = options?.reverse ? -direction : direction;
    const next = Math.max(options?.min ?? -Infinity, value + signed * dialStep());
    value = next;
    onChange(next);
    spinDial(direction);
  };
  dial.addEventListener("wheel", (event) => {
    event.preventDefault();
    applyDialDelta(event.deltaY > 0 ? 1 : -1);
  }, { passive: false });
  dial.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    let previousY = event.clientY;
    let accumulated = 0;
    const onMove = (moveEvent: PointerEvent) => {
      accumulated += previousY - moveEvent.clientY;
      previousY = moveEvent.clientY;
      while (Math.abs(accumulated) >= 4) {
        applyDialDelta(accumulated > 0 ? 1 : -1);
        accumulated += accumulated > 0 ? -4 : 4;
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    window.addEventListener("pointercancel", onUp, { once: true });
  });
  const info = document.createElement("div");
  info.className = "instrument-knob-info";
  const label = document.createElement("label");
  label.textContent = labelText;
  info.append(label, makeNumberInput(value, step, onChange));
  row.append(dial, info);
  return row;
}

function makeDivider(): HTMLHRElement {
  const hr = document.createElement("hr");
  hr.className = "instrument-divider";
  return hr;
}

/** Linha "Auto"/"Trigger" -- seleção EXCLUSIVA de 1 canal (ou nenhum), uma bolinha colorida por
 * canal + uma cinza pra "nenhum" -- réplica das `QRadioButton` (background = cor do canal) dentro
 * de `autoGroup`/`triggerGroup` (`exclusive=true`) de `oscwidget.ui`. */
function makeExclusiveDotRow(
  labelText: string,
  selected: 0 | 1 | 2 | 3 | "none",
  onSelect: (value: 0 | 1 | 2 | 3 | "none") => void
): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "instrument-radio-row";
  const label = document.createElement("span");
  label.className = "instrument-radio-row__label";
  label.textContent = labelText;
  row.appendChild(label);
  ([0, 1, 2, 3] as const).forEach((channel) => {
    const dot = document.createElement("span");
    dot.className = `instrument-radio-dot${selected === channel ? " instrument-radio-dot--selected" : ""}`;
    dot.style.background = INSTRUMENT_CHANNEL_COLORS[channel] ?? "#888";
    dot.title = `Ch${channel + 1}`;
    dot.addEventListener("click", () => onSelect(channel));
    row.appendChild(dot);
  });
  const noneDot = document.createElement("span");
  noneDot.className = `instrument-radio-dot${selected === "none" ? " instrument-radio-dot--selected" : ""}`;
  noneDot.style.background = "#cfd3da";
  noneDot.title = "Nenhum";
  noneDot.addEventListener("click", () => onSelect("none"));
  row.appendChild(noneDot);
  return row;
}

/** Linha "Esconder" -- TOGGLE independente por canal (não exclusivo), uma bolinha colorida por
 * canal -- réplica de `hideGroup` (`exclusive=false`) de `oscwidget.ui`: vários canais podem ficar
 * escondidos ao mesmo tempo. */
function makeToggleDotRow(labelText: string, hiddenByChannel: boolean[], onToggle: (channel: number) => void): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "instrument-radio-row";
  const label = document.createElement("span");
  label.className = "instrument-radio-row__label";
  label.textContent = labelText;
  row.appendChild(label);
  hiddenByChannel.slice(0, 4).forEach((hidden, channel) => {
    const dot = document.createElement("span");
    dot.className = `instrument-radio-dot${hidden ? " instrument-radio-dot--selected" : ""}`;
    dot.style.background = INSTRUMENT_CHANNEL_COLORS[channel] ?? "#888";
    dot.title = `Ch${channel + 1}`;
    dot.addEventListener("click", () => onToggle(channel));
    row.appendChild(dot);
  });
  return row;
}

/** Janela "Expande" arrastável pela barra de título -- mesmo padrão de pointer capture usado em
 * outros arrastos da Webview, só que fora do `.canvas-content` (não escala/pan com o zoom do
 * esquemático principal, ver `instrumentPopupLayer`). */
function makePopupChrome(title: string, popup: InstrumentPopupState): { container: HTMLDivElement; body: HTMLDivElement } {
  const container = document.createElement("div");
  container.className = "instrument-popup";
  container.style.left = `${popup.x}px`;
  container.style.top = `${popup.y}px`;

  const titlebar = document.createElement("div");
  titlebar.className = "instrument-popup__titlebar";
  const titleText = document.createElement("span");
  titleText.textContent = title;
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "instrument-popup__close";
  closeButton.textContent = "✕";
  closeButton.addEventListener("click", (event) => {
    event.stopPropagation();
    closeInstrumentPopup(popup.componentId);
  });
  titlebar.append(titleText, closeButton);

  titlebar.addEventListener("pointerdown", (event) => {
    if (event.target === closeButton) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const originX = popup.x;
    const originY = popup.y;
    const onMove = (moveEvent: PointerEvent) => {
      popup.x = originX + (moveEvent.clientX - startX);
      popup.y = originY + (moveEvent.clientY - startY);
      container.style.left = `${popup.x}px`;
      container.style.top = `${popup.y}px`;
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  });

  const body = document.createElement("div");
  body.className = "instrument-popup__body";
  container.append(titlebar, body);
  return { container, body };
}

/** Índice numérico do rótulo indexado (`nextIndexedLabel`, ex: "Osciloscópio-2" -> "2") -- usado pra
 * montar o título da janela "Expande" no formato curto real do SimulIDE (`Oscope-1`/`LAnalizer-1`,
 * ver `oscwidget.ui`/`lawidget.ui`), independente do texto de rótulo do catálogo (localizável,
 * "Logic Analyzer" aqui vs "LAnalizer" lá). Bug corrigido 2026-07-09: o título prefixava o rótulo
 * JÁ indexado inteiro (`Oscope-${component.label}` com `label` = "Oscope-1" → "Oscope-Oscope-1"). */
function instrumentPopupIndexSuffix(component: WebviewComponentModel): string {
  const match = /-(\d+)$/.exec(component.label);
  return match ? match[1]! : (component.label || component.id);
}

function buildScopePopup(popup: ScopePopupState, component: WebviewComponentModel): HTMLDivElement {
  const { container, body } = makePopupChrome(`Oscope-${instrumentPopupIndexSuffix(component)}`, popup);

  const plotWrap = document.createElement("div");
  plotWrap.className = "instrument-popup__plot";
  plotWrap.appendChild(renderScopePopupPlot(popup, scopeChannelsFor(component.id)));

  const controls = document.createElement("div");
  controls.className = "instrument-popup__controls";

  // Botões Ch1-Ch4/All -- cor de fundo do PRÓPRIO canal, igual `oscwidget.ui` real (ver
  // makeChannelButton). Trocar a aba ativa também troca qual canal os knobs de Posição de
  // Tempo/Tensão abaixo editam (mesmo papel do `m_channel` em `OscWidget`).
  const tabs = document.createElement("div");
  tabs.className = "instrument-tabs";
  ([0, 1, 2, 3] as const).forEach((channel) => {
    tabs.appendChild(makeChannelButton(`Ch${channel + 1}`, INSTRUMENT_CHANNEL_COLORS[channel] ?? "#888", popup.activeTab === channel, () => {
      popup.activeTab = channel;
      renderInstrumentPopups();
    }));
  });
  tabs.appendChild(makeChannelButton("All", "#e6e8ec", popup.activeTab === "all", () => {
    popup.activeTab = "all";
    renderInstrumentPopups();
  }));
  controls.appendChild(tabs);

  // Knobs (disco + spinner) -- réplica do layout QDial+QLabel+PlotSpinBox de `oscwidget.ui`.
  const knobs = document.createElement("div");
  knobs.className = "instrument-knobs";
  const activeChannelIndex = popup.activeTab === "all" ? 0 : popup.activeTab;
  const activeChannel = popup.channels[activeChannelIndex] ?? popup.channels[0]!;
  const applyChannels = (fn: (channel: ScopeChannelSettings) => void) => {
    if (popup.activeTab === "all") popup.channels.forEach(fn);
    else fn(activeChannel);
  };
  knobs.appendChild(makeKnobRow(`${component.id}:timeDiv`, "Divisão de Tempo (ms)", popup.timeDivMs, 100, (v) => { popup.timeDivMs = Math.max(0.001, v); renderInstrumentPopups(); }, {
    dialStep: (current) => Math.max(0.001, Math.abs(current) / 100),
    reverse: true,
    min: 0.001,
  }));
  knobs.appendChild(makeKnobRow(`${component.id}:timePos`, "Posição de Tempo (ms)", activeChannel.timePosMs, 100, (v) => { applyChannels((channel) => { channel.timePosMs = v; }); renderInstrumentPopups(); }, {
    dialStep: () => Math.max(0.001, popup.timeDivMs / 100),
  }));
  knobs.appendChild(makeKnobRow(`${component.id}:voltDiv`, "Divisão de Tensão (V)", activeChannel.voltDiv, 0.1, (v) => { const next = Math.max(0.001, v); applyChannels((channel) => { channel.voltDiv = next; }); renderInstrumentPopups(); }, {
    dialStep: (current) => Math.max(0.001, Math.abs(current) / 100),
    reverse: true,
    min: 0.001,
  }));
  knobs.appendChild(makeKnobRow(`${component.id}:voltPos`, "Posição de Tensão (V)", activeChannel.voltPos, 0.1, (v) => { applyChannels((channel) => { channel.voltPos = v; }); renderInstrumentPopups(); }, {
    dialStep: () => Math.max(0.001, activeChannel.voltDiv / 100),
    reverse: true,
  }));
  controls.appendChild(knobs);

  controls.appendChild(makeDivider());
  controls.appendChild(makeFieldRow("Filtro (V)", makeNumberInput(popup.filterThreshold, 0.01, (v) => { popup.filterThreshold = Math.max(0, v); renderInstrumentPopups(); })));

  // Auto/Trigger/Esconder -- bolinhas coloridas por canal, igual `oscwidget.ui` real (réplica de
  // `autoGroup`/`triggerGroup`/`hideGroup`, ver makeExclusiveDotRow/makeToggleDotRow).
  controls.appendChild(makeDivider());
  controls.appendChild(makeExclusiveDotRow("Auto", popup.autoScaleChannel, (value) => { popup.autoScaleChannel = value; renderInstrumentPopups(); }));
  controls.appendChild(makeExclusiveDotRow("Trigger", popup.triggerSource, (value) => { popup.triggerSource = value; renderInstrumentPopups(); }));
  controls.appendChild(makeToggleDotRow("Esconder", popup.channels.map((c) => c.hidden), (channel) => {
    popup.channels[channel]!.hidden = !popup.channels[channel]!.hidden;
    renderInstrumentPopups();
  }));
  controls.appendChild(makeDivider());

  const tracksRow = document.createElement("div");
  tracksRow.className = "instrument-field";
  const tracksLabel = document.createElement("label");
  tracksLabel.textContent = "Trilhas";
  tracksRow.appendChild(tracksLabel);
  ([1, 2, 4] as const).forEach((trackCount) => {
    const radioLabel = document.createElement("label");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = `scope-${component.id}-tracks`;
    radio.checked = popup.tracks === trackCount;
    radio.addEventListener("change", () => {
      popup.tracks = trackCount;
      renderInstrumentPopups();
    });
    radioLabel.append(radio, document.createTextNode(String(trackCount)));
    tracksRow.appendChild(radioLabel);
  });
  controls.appendChild(tracksRow);

  body.append(plotWrap, controls);
  return container;
}

function buildLogicPopup(popup: LogicPopupState, component: WebviewComponentModel): HTMLDivElement {
  const { container, body } = makePopupChrome(`LAnalizer-${instrumentPopupIndexSuffix(component)}`, popup);
  const history = logicChannelFor(component.id);

  const plotWrap = document.createElement("div");
  plotWrap.className = "instrument-popup__plot";
  plotWrap.appendChild(renderLogicPopupPlot(popup, history));

  const controls = document.createElement("div");
  controls.className = "instrument-popup__controls";

  const knobs = document.createElement("div");
  knobs.className = "instrument-knobs";
  knobs.appendChild(makeKnobRow(`${component.id}:timeDiv`, "Divisão de Tempo (ms)", popup.timeDivMs, 100, (v) => { popup.timeDivMs = Math.max(10, v); renderInstrumentPopups(); }));
  knobs.appendChild(makeKnobRow(`${component.id}:timePos`, "Posição de Tempo (ms)", popup.timePosMs, 100, (v) => { popup.timePosMs = v; renderInstrumentPopups(); }));
  controls.appendChild(knobs);

  const busLabel = document.createElement("div");
  busLabel.className = "instrument-section-label";
  busLabel.textContent = "Barramento";
  controls.appendChild(busLabel);

  const channelRows = document.createElement("div");
  channelRows.className = "instrument-channel-rows";
  popup.hiddenChannels.forEach((hidden, channel) => {
    const row = document.createElement("div");
    row.className = "instrument-channel-row";
    const swatch = document.createElement("span");
    swatch.className = "instrument-channel-swatch";
    swatch.style.background = INSTRUMENT_CHANNEL_COLORS[channel] ?? "#888";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !hidden;
    checkbox.addEventListener("change", () => {
      popup.hiddenChannels[channel] = !checkbox.checked;
      renderInstrumentPopups();
    });
    row.append(swatch, checkbox, document.createTextNode(`Ch${channel}`));
    channelRows.appendChild(row);
  });
  controls.appendChild(channelRows);

  const triggerRow = document.createElement("div");
  triggerRow.className = "instrument-field";
  const triggerLabel = document.createElement("label");
  triggerLabel.textContent = "Trigger";
  const triggerSelect = document.createElement("select");
  const noneOption = document.createElement("option");
  noneOption.value = "none";
  noneOption.textContent = "Nenhum";
  triggerSelect.appendChild(noneOption);
  for (let channel = 0; channel < 8; channel++) {
    const option = document.createElement("option");
    option.value = String(channel);
    option.textContent = `Ch${channel}`;
    triggerSelect.appendChild(option);
  }
  triggerSelect.value = popup.triggerChannel === "none" ? "none" : String(popup.triggerChannel);
  triggerSelect.addEventListener("change", () => {
    popup.triggerChannel = triggerSelect.value === "none" ? "none" : Number(triggerSelect.value);
    renderInstrumentPopups();
  });
  triggerRow.append(triggerLabel, triggerSelect);
  controls.appendChild(triggerRow);

  controls.appendChild(makeFieldRow("Limiar ↑ (V)", makeNumberInput(popup.thresholdUp, 0.1, (v) => {
    popup.thresholdUp = v;
    send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestUpdateProperty", componentId: component.id, name: "thresholdRising", value: v });
    renderInstrumentPopups();
  })));
  controls.appendChild(makeFieldRow("Limiar ↓ (V)", makeNumberInput(popup.thresholdDown, 0.1, (v) => {
    popup.thresholdDown = v;
    send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestUpdateProperty", componentId: component.id, name: "thresholdFalling", value: v });
    renderInstrumentPopups();
  })));

  const exportButton = document.createElement("button");
  exportButton.type = "button";
  exportButton.className = "instrument-export-button";
  exportButton.textContent = "Exportar Dados";
  exportButton.addEventListener("click", () => exportInstrumentData(component, popup, history));
  controls.appendChild(exportButton);

  body.append(plotWrap, controls);
  return container;
}

/** CSV com timestamp REAL (tempo simulado, convertido pra ms -- `timestampsNs[i] / 1e6`) quando o
 * histórico real já chegou (ver `realLogicHistoryByComponentId`/`realScopeHistoryByComponentId`);
 * cai pro timestamp aproximado (intervalo de poll) só se a janela acabou de abrir e a resposta de
 * `requestInstrumentHistory` ainda não chegou. */
function exportInstrumentData(component: WebviewComponentModel, popup: InstrumentPopupState, history: { timestampsNs: number[]; masks: number[] } | Array<{ timestampsNs: number[]; values: number[] }>): void {
  const lines: string[] = [];
  if (popup.kind === "logic") {
    const logic = history as { timestampsNs: number[]; masks: number[] };
    const visibleChannels = popup.hiddenChannels.map((hidden, ch) => (hidden ? -1 : ch)).filter((ch) => ch >= 0);
    lines.push(["tempo_ms", ...visibleChannels.map((ch) => `ch${ch}`)].join(","));
    logic.masks.forEach((mask, index) => {
      const timeMs = (logic.timestampsNs[index] ?? index * INSTRUMENT_POLL_INTERVAL_MS * 1e6) / 1e6;
      lines.push([timeMs, ...visibleChannels.map((ch) => (mask >>> ch) & 1)].join(","));
    });
  } else {
    const channels = history as Array<{ timestampsNs: number[]; values: number[] }>;
    const sampleCount = Math.max(0, ...channels.map((channel) => channel.values.length));
    lines.push(["tempo_ms", "ch0", "ch1", "ch2", "ch3"].join(","));
    for (let index = 0; index < sampleCount; index++) {
      const timeMs = (channels[0]?.timestampsNs[index] ?? index * INSTRUMENT_POLL_INTERVAL_MS * 1e6) / 1e6;
      lines.push([timeMs, ...channels.map((channel) => channel.values[index] ?? "")].join(","));
    }
  }
  send({
    version: WEBVIEW_MESSAGE_VERSION,
    type: "requestExportInstrumentData",
    suggestedFileName: `${component.label || component.id}.csv`,
    csvContent: lines.join("\n"),
  });
}

/** Reconstrói TODAS as janelas "Expande" abertas a partir de `instrumentPopups` -- chamado depois
 * de qualquer mudança de estado relevante (novo readout, abrir/fechar, editar um controle). Sempre
 * reconstrói do zero (mesmo brute-force de `render()` pro canvas principal) -- volume baixo (no
 * máximo algumas janelas abertas por vez), não compensa otimizar com diff incremental. */
function renderInstrumentPopups(): void {
  instrumentPopupLayer.innerHTML = "";
  for (const popup of instrumentPopups.values()) {
    const component = state.components.find((entry) => entry.id === popup.componentId);
    if (!component) {
      instrumentPopups.delete(popup.componentId);
      continue;
    }
    const element = popup.kind === "oscope" ? buildScopePopup(popup, component) : buildLogicPopup(popup, component);
    instrumentPopupLayer.appendChild(element);
  }
}

/** `steps`: múltiplo de 90° (1 = CW, -1 = CCW, 2 = 180° — `Ctrl+R`/`Ctrl+Shift+R`/menu "Rotacionar
 * 180", ver `.spec/lasecsimul.spec` seção 13.4). Sem `persistState`/`render` aqui -- quem chama em
 * grupo (`rotateSelectedComponents`) faz isso uma vez só, não por componente. */
function applyRotation(component: WebviewComponentModel, steps: 1 | -1 | 2): void {
  const nextRotation = (((component.rotation + 90 * steps + 360) % 360) as 0 | 90 | 180 | 270);
  component.rotation = nextRotation;
  send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestRotateComponent", componentId: component.id, rotation: nextRotation });
}

/** Atalho de conveniência pra rotacionar UM componente isolado (chamador cuida de persist/render) --
 * usado pelo atalho solto `r` (sem Ctrl), herdado de quando a seleção era singular. */
function rotateComponent(component: WebviewComponentModel): void {
  applyRotation(component, 1);
  persistState();
  render();
}

function rotateSelectedComponents(steps: 1 | -1 | 2): void {
  if (rotateSelectedTextLabel(steps)) return;
  const components = getSelectedComponents();
  if (components.length === 0) return;
  for (const component of components) applyRotation(component, steps);
  persistState();
  render();
}

/** Espelha o símbolo no eixo dado -- só altera a flag visual (`flipH`/`flipV`); pinos continuam
 * identificados pelo mesmo `pinId`, então fios já conectados não precisam de nenhum ajuste no
 * Core (mesma lógica de `applyRotation`: puramente visual). */
function applyFlip(component: WebviewComponentModel, axis: "horizontal" | "vertical"): void {
  const flipsLocalHorizontal = component.rotation === 0 || component.rotation === 180;
  if (axis === "horizontal") {
    if (flipsLocalHorizontal) component.flipH = !component.flipH;
    else component.flipV = !component.flipV;
  } else {
    if (flipsLocalHorizontal) component.flipV = !component.flipV;
    else component.flipH = !component.flipH;
  }
  send({
    version: WEBVIEW_MESSAGE_VERSION,
    type: "requestFlipComponent",
    componentId: component.id,
    flipH: Boolean(component.flipH),
    flipV: Boolean(component.flipV),
  });
}

function flipSelectedComponents(axis: "horizontal" | "vertical"): void {
  if (selectedTextLabel) return;
  const components = getSelectedComponents();
  if (components.length === 0) return;
  for (const component of components) applyFlip(component, axis);
  persistState();
  render();
}

interface ComponentVisualFlags {
  catalogEntry: WebviewComponentCatalogEntry | undefined;
  isPushButton: boolean;
  isSwitchToggle: boolean;
  isToggleClickable: boolean;
  isFixedVolt: boolean;
  isExpandableInstrument: boolean;
  isJoystick: boolean;
  isEncoder: boolean;
  isTouchpad: boolean;
  isRail: boolean;
  isTunnel: boolean;
  isMeter: boolean;
  isVoltmeter: boolean;
  hasPackageVisual: boolean;
  isMissingSubcircuitRef: boolean;
}

/** Ponto único de "que categoria visual/interativa este componente é" -- ANTES calculado duas vezes
 * (`createComponentElement`/`updateComponentElement`), com `isPushButton`/`isSwitchToggle`/
 * `isFixedVolt` repetidos idênticos nos dois (UI-11/PC-12). ABI v2 (interactionKind/viewSpec
 * interaction) tem prioridade; typeId hardcoded só cobre exceção específica de CSS/glifo
 * (`isSwitchToggle`/`isFixedVolt`/`isRail`/`isTunnel`/`isVoltmeter`) sem equivalente genérico ainda. */
function componentVisualFlags(component: WebviewComponentModel): ComponentVisualFlags {
  const catalogEntry = catalogEntryFor(component.typeId);
  const catalogInteractionKind = catalogEntry?.interactionKind ?? interactionKindFor(component.typeId);
  return {
    catalogEntry,
    isPushButton: catalogInteractionKind === "momentary",
    isSwitchToggle: component.typeId === "switches.switch",
    isToggleClickable: catalogInteractionKind === "toggle",
    isFixedVolt: component.typeId === "sources.fixed_volt",
    isExpandableInstrument: instrumentHistoryKind(component.typeId) !== undefined,
    isJoystick: catalogInteractionKind === "joystick" || Boolean(viewSpecInteractionFor(component.typeId, "dragVector")),
    isEncoder: catalogInteractionKind === "encoder" || Boolean(viewSpecInteractionFor(component.typeId, "dragAngular")),
    isTouchpad: catalogInteractionKind === "touchpad" || Boolean(viewSpecInteractionFor(component.typeId, "touchPoint")),
    isRail: component.typeId === "sources.rail",
    isTunnel: component.typeId === TUNNEL_TYPE_ID,
    isMeter: component.typeId.startsWith("meters.") || component.typeId === "instruments.voltmeter",
    isVoltmeter: component.typeId === "instruments.voltmeter",
    hasPackageVisual: Boolean(catalogEntry?.package || (component.properties.logicSymbol === true && catalogEntry?.logicSymbolPackage)),
    isMissingSubcircuitRef: Boolean(component.subcircuitRef) && !catalogEntry,
  };
}

/** Cria o elemento `.component` UMA VEZ por id (reaproveitado entre renders, ver
 * `componentElementsById`) -- registra aqui SÓ os listeners de longa duração (clique/seleção,
 * duplo-clique, menu de contexto, arrastar, popup de instrumento). Reconciliação incremental
 * (.spec/lasecsimul-native-devices.spec): pintura visual (posição/classe/SVG/pinos) fica inteira em
 * `updateComponentElement`, chamada daqui pra pintura inicial e de novo em TODO `render()` seguinte
 * pro mesmo id -- nunca recria o wrapper nem os listeners abaixo, só atualiza.
 *
 * Listeners aqui NUNCA capturam `component` por referência: mensagens "init"/"syncState" do host
 * substituem `state` inteiro (objetos novos, mesmo id) toda vez que algo muda no projeto, então uma
 * closure que capturasse o objeto leria dados desatualizados depois do primeiro `syncState` seguinte
 * à criação. Toda leitura de campo MUTÁVEL (x/y/properties/exposed/...) relê via `liveComponent()`
 * (busca por id, sempre atual); só `componentId` e flags derivadas de `typeId` (também imutável pro
 * tempo de vida da instância) são seguros pra capturar uma vez. */
function createComponentElement(component: WebviewComponentModel): HTMLElement {
  const el = document.createElement("div");
  const componentId = component.id;
  el.dataset.componentId = componentId;
  el.dataset.typeId = component.typeId;

  const liveComponent = (): WebviewComponentModel | undefined =>
    state.components.find((entry) => entry.id === componentId);

  // ABI v2 (.spec/lasecsimul-native-devices.spec): isPushButton vem de interactionKind (genérico);
  // isToggleClickable é o conceito genérico de "clicar no toggle-hit-zone alterna `closed`" -- cobre
  // switch E switch_dip (e qualquer typeId futuro de interactionKind "toggle" que use a mesma
  // propriedade `closed`), sem precisar de um bucket por typeId (bug real: switch_dip não tinha
  // NENHUM handler de clique, só um `isSwitchToggle` escopado a "switches.switch" via canToggle).
  const { isPushButton, isToggleClickable, isFixedVolt, isExpandableInstrument, isJoystick, isEncoder, isTouchpad } =
    componentVisualFlags(component);

  // Clique-pra-alternar (push/switch/fixed-volt) é desambiguado de ARRASTAR dentro do handler
  // genérico de `pointerdown` mais abaixo (ver `DRAG_THRESHOLD_PX`) -- antes disto, estes 3 tipos
  // tinham handler PRÓPRIO que chamava `stopImmediatePropagation()` e alternava direto no
  // `pointerdown`, impedindo COMPLETAMENTE o handler genérico de arrastar de rodar (bug relatado
  // 2026-06-30: "os botões onde tem ação eu não consigo mover, sempre acha que é clicar").

  if (isExpandableInstrument) {
    el.addEventListener("click", (event) => {
      if (!(event.target instanceof Element) || !event.target.closest(".meter-expand-button")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const current = liveComponent();
      if (current) toggleInstrumentPopup(current);
    }, { capture: true });
  }

  if (isEncoder) {
    el.addEventListener("wheel", (event) => {
      if (!(event.target instanceof Element) || !event.target.closest(".encoder-hit-zone, .viewspec-interaction-dragAngular")) return;
      event.preventDefault();
      event.stopPropagation();
      const comp = liveComponent();
      if (!comp) return;
      const turn = viewSpecInteractionFor(comp.typeId, "dragAngular");
      const positionProp = turn?.prop ?? "position";
      const stepsRevFallback = turn?.stepsPerRev ?? 20;
      const stepsRev = numericComponentProperty(comp, turn?.stepsPerRevProp ?? "steps_rev", stepsRevFallback);
      const centerX = turn?.cx ?? 20;
      const centerY = turn?.cy ?? 20;
      const currentPos = numericComponentProperty(comp, positionProp, 0);
      const angularLimit = turn?.limits ? catalogEntryFor(comp.typeId)?.package?.viewSpec?.limits?.[turn.limits] : undefined;
      if (turn?.continuous) {
        const propMin = angularLimit?.min ?? 0;
        const propMax = angularLimit?.max ?? 1000;
        const propStep = angularLimit?.step ?? 0;
        const wheelStep = propStep > 0 ? propStep : Math.abs(propMax - propMin) * 25 / 1000;
        const clamp = angularLimit?.clamp !== false;
        let newValue = currentPos + (event.deltaY > 0 ? wheelStep : -wheelStep);
        if (propStep > 0) newValue = Math.round(newValue / propStep) * propStep;
        if (clamp) newValue = clampNumber(newValue, Math.min(propMin, propMax), Math.max(propMin, propMax));
        if (Math.abs(newValue - currentPos) < 1e-12) return;
        comp.properties[positionProp] = newValue;
        send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestUpdateProperty", componentId: comp.id, name: positionProp, value: newValue });
        const indicatorEl = el.querySelector<SVGElement>(".encoder-indicator");
        if (indicatorEl) {
          const angle = mapLinear(newValue, [propMin, propMax], [angularLimit?.minAngleDeg ?? -150, angularLimit?.maxAngleDeg ?? 150]);
          indicatorEl.setAttribute("transform", `rotate(${angle}, ${centerX}, ${centerY})`);
        }
        persistState();
        return;
      }
      const delta = event.deltaY > 0 ? 1 : -1;
      const newPos = currentPos + delta;
      comp.properties[positionProp] = newPos;
      send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestUpdateProperty", componentId: comp.id, name: positionProp, value: newPos });
      // Rotate the indicator line visually based on position
      const indicatorEl = el.querySelector<SVGElement>(".encoder-indicator");
      if (indicatorEl) {
        const angle = ((((newPos % stepsRev) + stepsRev) % stepsRev) / stepsRev) * 360;
        indicatorEl.setAttribute("transform", `rotate(${angle}, ${centerX}, ${centerY})`);
      }
      persistState();
    }, { passive: false });
  }

  el.addEventListener("click", (event) => {
    event.stopPropagation();
    if (event.shiftKey) toggleComponentSelection(componentId);
    else selectOnlyComponent(componentId);
    persistState();
    render();
    if (event.detail >= 2) {
      queueMicrotask(() => {
        const refreshed = liveComponent();
        if (refreshed) openPropertyDialog(refreshed);
      });
    }
  });

  el.addEventListener("contextmenu", (event) => {
    // O menu customizado do LasecSimul deve sempre prevalecer sobre o menu nativo da Webview.
    // Se `preventDefault` ficar só no `showContextMenu(...)` ao final, qualquer retorno antecipado
    // (ou render custoso antes dele) pode deixar o menu nativo "vazar" de forma intermitente.
    // NUNCA `stopPropagation()` aqui -- precisa borbulhar até `window`/`document` pro host da
    // Webview ver `defaultPrevented` e não abrir o menu nativo (Cortar/Copiar/Colar) por cima do
    // nosso; `canvas` (ancestor) já ignora o evento quando `defaultPrevented` (ver seu handler).
    event.preventDefault();
    const component = liveComponent();
    if (!component) {
      hideContextMenu();
      return;
    }
    const catalogEntry = catalogEntryFor(component.typeId);
    if (!isComponentSelected(component.id)) selectOnlyComponent(component.id);
    persistState();
    render();
    const selectedComponents = getSelectedComponents();
    const isGroup = selectedComponents.length > 1;
    const internalAuthoringItems: ContextMenuItem[] = state.subcircuitEditingContext
      ? [
          { label: t("boardMode"), checked: subcircuitBoardMode, onClick: () => setSubcircuitBoardMode(!subcircuitBoardMode) },
          { label: t("selectExposedComponents"), onClick: () => openExposedComponentsDialog() },
          { kind: "separator" },
        ]
      : [];
    const sourceId = catalogEntry?.registeredSourceId;
    const propertyMenuItems: ContextMenuItem[] = isGroup
      ? []
      : [{ label: t("properties"), icon: "properties", onClick: () => openPropertyDialog(component) }];
    // Menu da instância do subcircuito no circuito principal: ações da própria instância ficam
    // aqui; os componentes internos expostos aparecem em submenus separados.
    const isSubcircuitWithPackage = !isGroup && Boolean(sourceId) && catalogEntry?.registeredSourceKind === "subcircuit-file";
    const exposedSubmenuItems: ContextMenuItem[] = !isGroup && isSubcircuitWithPackage ? buildExposedComponentMenuItems(component) : [];
    // "Abrir Subcircuito" -- entra no circuito INTERNO do `.lssubcircuit` já registrado (ver
    // `extension.ts::openSubcircuitForEditingCommand`); fica logo após o(s) submenu(s) de
    // componente(s) expostos, ainda antes de Copiar/Cortar/Remover.
    const openSubcircuitMenuItems: ContextMenuItem[] = isSubcircuitWithPackage
      ? [{ label: t("openSubcircuit"), onClick: () => send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestOpenSubcircuit", sourceId: sourceId! }) }]
      : [];
    const mcuMenuItems: ContextMenuItem[] = !isGroup && !isSubcircuitWithPackage && isMcuHostComponent(component)
      ? [
          { kind: "separator" },
          { label: t("loadFirmware"), onClick: () => send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestChooseMcuFirmware", componentId: component.id }) },
          ...serialPortsForTypeId(component.typeId).map((port) => ({
            label: `${t("openSerialMonitor")} ${port.label}`,
            onClick: () => send({
              version: WEBVIEW_MESSAGE_VERSION,
              type: "requestOpenMcuSerialMonitor",
              componentId: component.id,
              usartIndex: port.usartIndex,
            }),
          } satisfies ContextMenuItem)),
        ]
      : [];
    const createSubcircuitMenuItems: ContextMenuItem[] = isGroup
      ? [
          { kind: "separator" },
          { label: t("createSubcircuit"), onClick: () => send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestCreateSubcircuitFromSelection", componentIds: state.selectedComponentIds }) },
        ]
      : [];
    // Bloco genérico de subcircuito por caminho -- mesmo comando da propriedade "Arquivo do
    // subcircuito"/botão "Procurar...", só mais acessível direto no clique direito. Cobre os 2
    // casos: `subcircuitRef` já presente (resolvido ou "ausente", ver `updateComponentElement`) E
    // o bloco AINDA não vinculado (typeId ainda `subcircuits.external`, recém-colocado, sem
    // `subcircuitRef` nenhum) -- sem isto, a única forma de vincular um bloco novo era abrir o
    // painel de propriedades e achar o botão "Procurar...".
    const subcircuitRefMenuItems: ContextMenuItem[] = !isGroup && (component.subcircuitRef || component.typeId === "subcircuits.external")
      ? [
          { kind: "separator" },
          { label: t("locateSubcircuitFile"), onClick: () => send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestChooseSubcircuitFile", componentId: component.id }) },
        ]
      : [];
    // Autoria de Package (Estágio 5, `.spec/lasecsimul.spec`) -- vínculo pino-do-Package↔Túnel
    // interno por IDENTIFICADOR ESTÁVEL (`properties.tunnelComponentId`, o id do componente-túnel,
    // nunca o nome dele que pode ser renomeado) em vez de escolher/editar isso no painel de
    // propriedades genérico (que não sabe listar "só os túneis presentes nesta cena"). Só aparece
    // pra `other.package_pin` (typeId literal -- este módulo webview não importa
    // `extension/src/catalog/subcircuitPackageAuthoring.ts`, que é código de host/Node).
    const packagePinLinkMenuItems: ContextMenuItem[] = !isGroup && component.typeId === "other.package_pin"
      ? (() => {
          const tunnels = state.components.filter((c) => c.typeId === TUNNEL_TYPE_ID);
          const currentTunnelId = typeof component.properties.tunnelComponentId === "string" ? component.properties.tunnelComponentId : "";
          const tunnelItems: ContextMenuItem[] = tunnels.map((tunnelComponent) => ({
            label: String(tunnelComponent.properties.name ?? tunnelComponent.label),
            checked: tunnelComponent.id === currentTunnelId,
            onClick: () =>
              send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestUpdateProperty", componentId: component.id, name: "tunnelComponentId", value: tunnelComponent.id }),
          }));
          if (currentTunnelId) {
            tunnelItems.push(
              { kind: "separator" },
              { label: t("unlinkTunnel"), onClick: () => send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestUpdateProperty", componentId: component.id, name: "tunnelComponentId", value: "" }) }
            );
          }
          return [
            { kind: "separator" },
            {
              label: t("linkToTunnel"),
              items: tunnelItems.length > 0 ? tunnelItems : [{ label: t("noTunnelsInScene"), onClick: () => {}, disabled: true }],
            } satisfies ContextMenuItem,
          ];
        })()
      : [];
    const menuItems: ContextMenuItem[] = [
      ...internalAuthoringItems,
      ...exposedSubmenuItems,
      ...openSubcircuitMenuItems,
      ...(exposedSubmenuItems.length > 0 || openSubcircuitMenuItems.length > 0 ? [{ kind: "separator" } satisfies ContextMenuItem] : []),
      { label: t("copy"), icon: "copy", shortcut: "Ctrl+C", onClick: () => copySelectedItems() },
      { label: t("cut"), icon: "cut", shortcut: "Ctrl+X", onClick: () => cutSelectedItems() },
      { label: isGroup ? t("deleteSelectedItems") : t("remove"), icon: "remove", shortcut: "Del", onClick: () => deleteSelectedItems() },
      ...propertyMenuItems,
      { kind: "separator" },
      { label: t("rotateCw"), icon: "rotateCw", shortcut: "Ctrl+R", onClick: () => rotateSelectedComponents(1) },
      { label: t("rotateCcw"), icon: "rotateCcw", shortcut: "Ctrl+Shift+R", onClick: () => rotateSelectedComponents(-1) },
      { label: t("rotate180"), icon: "rotate180", onClick: () => rotateSelectedComponents(2) },
      { label: t("flipHorizontal"), icon: "flipHorizontal", shortcut: "Ctrl+L", onClick: () => flipSelectedComponents("horizontal") },
      { label: t("flipVertical"), icon: "flipVertical", shortcut: "Ctrl+Shift+L", onClick: () => flipSelectedComponents("vertical") },
      ...mcuMenuItems,
      ...createSubcircuitMenuItems,
      ...subcircuitRefMenuItems,
      ...packagePinLinkMenuItems,
    ];
    showContextMenu(event, menuItems);
  });

  let dragStartX = 0;
  let dragStartY = 0;
  let dragTargets: Array<{ component: WebviewComponentModel; startX: number; startY: number; offsetX: number; offsetY: number }> = [];
  let groupWireDragTarget: GroupWireDragTarget | undefined;
  let groupWireMoveTargets: GroupMoveWireTargets | undefined;

  el.addEventListener("pointerdown", (event) => {
    const component = liveComponent();
    if (!component) return;
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest(".pin-terminal, .meter-expand-button")) return;
    event.stopPropagation();
    // `Ctrl+Shift` junto é o gesto de duplicar-arrastando (checado ANTES do shift-toggle abaixo,
    // senão nunca chegaria aqui -- shift sozinho sempre alterna seleção e retorna cedo).
    const isDuplicateDragGesture = event.ctrlKey && event.shiftKey;
    if (event.shiftKey && !isDuplicateDragGesture) {
      toggleComponentSelection(component.id);
      persistState();
      render();
      return;
    }
    if (!isComponentSelected(component.id)) selectOnlyComponent(component.id);
    dragStartX = event.clientX;
    dragStartY = event.clientY;
    dragTargets = dragSelectionWithLinkedPinLabels().map((selected) => {
      const offset = componentDivOffset(selected);
      return { component: selected, startX: selected.x, startY: selected.y, offsetX: offset.x, offsetY: offset.y };
    });
    // "Selecionar um ramo de fio + um dispositivo e mover juntos": se um canto/segmento de fio
    // também estava selecionado (marquee, ou clique anterior no ramo), ele acompanha o(s)
    // componente(s) pelo MESMO delta -- ver `applyGroupWireDelta`. `groupWireMoveTargets` cobre o
    // caso GERAL: qualquer OUTRO fio inteiro co-selecionado (`state.selectedWireIds`, não só um
    // canto/segmento específico) também acompanha -- ver `computeGroupMoveWireTargets`. O fio de
    // `groupWireDragTarget` (se houver) é EXCLUÍDO daqui -- `selectOnlyWire`/`selectOnlyWireCorner`
    // sempre colocam esse mesmo fio em `selectedWireIds` como efeito colateral, e sem a exclusão os
    // dois mecanismos brigariam pelo mesmo `wire.points` neste `onMove` (bug real encontrado nesta
    // auditoria: o shift em bloco de `applyGroupMoveWireDelta`, por rodar DEPOIS, sobrescrevia
    // silenciosamente o ajuste preciso de canto/segmento de `applyGroupWireDelta`).
    groupWireDragTarget = currentGroupWireSelection();
    groupWireMoveTargets = computeGroupMoveWireTargets(groupWireDragTarget?.wireId);
    el.setPointerCapture(event.pointerId);
    // Bloqueia render() de telemetria DESDE O POINTERDOWN, não só depois do limiar de arrasto
    // (`startDragging` abaixo) -- com reconciliação (`componentElementsById`), `el` é REAPROVEITADO
    // entre renders via `appendChild` num `canvasContent` novo a cada `render()`; se um render() de
    // telemetria rodar NESSA janela (pointerdown ainda sem cruzar o limiar), o reparenting pode
    // soltar `setPointerCapture()` implicitamente (a spec de Pointer Events libera captura quando o
    // elemento "sai" do DOM, mesmo que seja um remove+insert atômico do mesmo appendChild) --
    // `pointerup`/`pointercancel` nunca mais disparam, e os listeners de `onMove`/`onUp` abaixo ficam
    // vazados em `el` para sempre, disparando movimento (com coordenadas de início desatualizadas) no
    // primeiro `pointermove` que passar por cima do elemento depois, mesmo sem o botão pressionado
    // (bug relatado 2026-06-30: "mouse sem clicar e movendo ele e o dispositivo esta movendo").
    isDraggingComponent = true;

    // Clique-pra-alternar (push/switch/fixed-volt) vs ARRASTAR é o MESMO gesto de pointerdown,
    // desambiguado por distância percorrida -- igual ao overlay de Modo Placa (ver
    // `renderBoardOverlaysFor`). Push pressiona IMEDIATAMENTE (feedback tátil de "segurar"), mas o
    // aperto é desfeito se virar arrasto; switch/fixed-volt só alternam no soltar, se NÃO arrastou.
    //
    // SimulIDE real (`switches/switch_base.cpp`, `push_base.cpp`) NÃO trata o componente inteiro como
    // área de clique-pra-alternar -- o "botão" é um `QGraphicsProxyWidget` PRÓPRIO, de 16x16px,
    // sobreposto a uma área pequena dentro da caixa maior do componente; clique fora dele cai pro
    // `Component` pai (mover), só clique bem em cima do retângulo/alavanca alterna o estado (bug
    // relatado 2026-06-30: "tem que ser bem encima do retângulo, fora é mover"). `.toggle-hit-zone`
    // (componentSymbols.ts) marca os mesmos elementos visuais (corpo do botão/alavanca) que o
    // SimulIDE cobre com o widget -- clique fora dessa zona NUNCA tenta alternar, vira arrasto puro
    // desde o primeiro pixel, igual a qualquer componente comum.
    // Joystick drag: arrastar o círculo interno manda x_pos/y_pos ao Core e mola de volta ao centro.
    // Encoder drag: arrasto angular no knob incrementa/decrementa a posição.
    // Touchpad drag: arrastar dentro da área sensível manda touch_x/touch_y/pressed ao Core.
    // SW button: clicar no `.sw-hit-zone` alterna sw_pressed (para joystick e encoder).
    if (isJoystick || isEncoder || isTouchpad) {
      const dragVector = viewSpecInteractionFor(component.typeId, "dragVector");
      const dragAngular = viewSpecInteractionFor(component.typeId, "dragAngular");
      const touchPoint = viewSpecInteractionFor(component.typeId, "touchPoint");
      const press = viewSpecInteractionFor(component.typeId, "press");
      const hitJoystick = isJoystick && event.target instanceof Element && Boolean(event.target.closest(".joystick-hit-zone, .viewspec-interaction-dragVector"));
      const hitEncoder = isEncoder && event.target instanceof Element && Boolean(event.target.closest(".encoder-hit-zone, .viewspec-interaction-dragAngular"));
      const hitTouchpad = isTouchpad && event.target instanceof Element && Boolean(event.target.closest(".touchpad-hit-zone, .viewspec-interaction-touchPoint"));
      const hitSw = event.target instanceof Element && Boolean(event.target.closest(".sw-hit-zone, .viewspec-interaction-press"));
      if (hitJoystick) {
        const joystickEl = el.querySelector<SVGElement>(".joystick-hit-zone");
        const startClientX = event.clientX;
        const startClientY = event.clientY;
        const dragLimit = dragVector?.limits
          ? catalogEntryFor(component.typeId)?.package?.viewSpec?.limits?.[dragVector.limits]
          : undefined;
        const xMapping = dragVector?.x;
        const yMapping = dragVector?.y;
        const xProp = xMapping?.prop ?? "x_pos";
        const yProp = yMapping?.prop ?? "y_pos";
        const xPropRange = xMapping?.propRange ?? [0, 1023] as [number, number];
        const yPropRange = yMapping?.propRange ?? [0, 1023] as [number, number];
        const xPixelRange = xMapping?.pixelRange ?? [-7, 7] as [number, number];
        const yPixelRange = yMapping?.pixelRange ?? [-7, 7] as [number, number];
        // Bowl r=17, thumbstick r=10 -> max translation = 7 unless a ViewSpec limit overrides it.
        const JOYSTICK_CLAMP =
          dragLimit?.radius ??
          Math.max(Math.abs(xPixelRange[0]), Math.abs(xPixelRange[1]), Math.abs(yPixelRange[0]), Math.abs(yPixelRange[1]), 1);
        const onJoystickMove = (moveEvent: PointerEvent) => {
          const zoom = state.viewport.zoom || 1;
          const rawDx = (moveEvent.clientX - startClientX) / zoom;
          const rawDy = (moveEvent.clientY - startClientY) / zoom;
          const dist = Math.hypot(rawDx, rawDy);
          const clampedDx = dist > JOYSTICK_CLAMP ? rawDx * JOYSTICK_CLAMP / dist : rawDx;
          const clampedDy = dist > JOYSTICK_CLAMP ? rawDy * JOYSTICK_CLAMP / dist : rawDy;
          if (joystickEl) joystickEl.setAttribute("transform", `translate(${clampedDx},${clampedDy})`);
          const x_pos = Math.round(mapLinear(clampedDx, xPixelRange, xPropRange));
          const y_pos = Math.round(mapLinear(clampedDy, yPixelRange, yPropRange));
          const comp = liveComponent();
          if (comp) {
            comp.properties[xProp] = x_pos;
            comp.properties[yProp] = y_pos;
            send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestUpdateProperty", componentId: comp.id, name: xProp, value: x_pos });
            send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestUpdateProperty", componentId: comp.id, name: yProp, value: y_pos });
          }
        };
        const onJoystickUp = () => {
          el.removeEventListener("pointermove", onJoystickMove);
          el.removeEventListener("pointerup", onJoystickUp);
          el.removeEventListener("pointercancel", onJoystickUp);
          isDraggingComponent = false;
          if (joystickEl) joystickEl.removeAttribute("transform");
          const comp = liveComponent();
          if (comp && dragVector?.springBack !== false) {
            const centerX = Math.round((xPropRange[0] + xPropRange[1]) / 2);
            const centerY = Math.round((yPropRange[0] + yPropRange[1]) / 2);
            comp.properties[xProp] = centerX;
            comp.properties[yProp] = centerY;
            send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestUpdateProperty", componentId: comp.id, name: xProp, value: centerX });
            send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestUpdateProperty", componentId: comp.id, name: yProp, value: centerY });
          }
          persistState();
          render();
        };
        isDraggingComponent = true;
        el.setPointerCapture(event.pointerId);
        el.addEventListener("pointermove", onJoystickMove);
        el.addEventListener("pointerup", onJoystickUp, { once: true });
        el.addEventListener("pointercancel", onJoystickUp, { once: true });
        return;
      }
      if (hitEncoder) {
        // Arrasto angular (igual ao QDial nativo do SimulIDE): atan2 do cursor em relação ao centro
        // do knob. Acumula fração de steps para resposta suave (igual ao `single-step` do QDial).
        const svgEl = el.querySelector<SVGElement>(".component__symbol");
        const indicatorEl = el.querySelector<SVGElement>(".encoder-indicator");
        if (!svgEl) { isDraggingComponent = false; return; }
        const svgRect = svgEl.getBoundingClientRect();
        const viewBoxParts = svgEl.getAttribute("viewBox")?.split(" ") ?? [];
        const vbW = parseFloat(viewBoxParts[2] ?? "40");
        const vbH = parseFloat(viewBoxParts[3] ?? "64");
        const centerX = dragAngular?.cx ?? 20;
        const centerY = dragAngular?.cy ?? 20;
        const positionProp = dragAngular?.prop ?? "position";
        const hitElement = event.target instanceof Element
          ? event.target.closest(".encoder-hit-zone, .viewspec-interaction-dragAngular")
          : undefined;
        const hitRect = hitElement instanceof SVGGraphicsElement ? hitElement.getBoundingClientRect() : undefined;
        // Para o ângulo do mouse, usa o centro real da região clicável já deslocada no viewBox.
        // Para o transform do indicador, `centerX/centerY` continuam sendo coordenadas nativas do package.
        const kx = hitRect ? hitRect.left + hitRect.width / 2 : svgRect.left + (centerX / vbW) * svgRect.width;
        const ky = hitRect ? hitRect.top + hitRect.height / 2 : svgRect.top  + (centerY / vbH) * svgRect.height;
        const dx0 = event.clientX - kx;
        const dy0 = event.clientY - ky;
        if (Math.hypot(dx0, dy0) < 3) {
          // Zona morta: ponteiro no centro exato — consume mas não inicia arrasto angular
          isDraggingComponent = false;
          return;
        }
        const comp0 = liveComponent();
        const stepsRevFallback = dragAngular?.stepsPerRev ?? 20;
        const stepsRev = comp0 ? numericComponentProperty(comp0, dragAngular?.stepsPerRevProp ?? "steps_rev", stepsRevFallback) : stepsRevFallback;
        const angularLimit = dragAngular?.limits ? catalogEntryFor(component.typeId)?.package?.viewSpec?.limits?.[dragAngular.limits] : undefined;
        if (dragAngular?.continuous) {
          // `minProp`/`maxProp` (achado 2026-07-10): fontes de tensão/corrente controladas têm
          // `minValue`/`maxValue` EDITÁVEIS pelo usuário -- ler ao vivo da instância em vez de um
          // `min`/`max` fixo, senão o dial ficaria preso no range do momento em que foi desenhado.
          const propMin = comp0 && angularLimit?.minProp ? numericComponentProperty(comp0, angularLimit.minProp, angularLimit?.min ?? 0) : (angularLimit?.min ?? 0);
          const propMax = comp0 && angularLimit?.maxProp ? numericComponentProperty(comp0, angularLimit.maxProp, angularLimit?.max ?? 1000) : (angularLimit?.max ?? 1000);
          const propStep = angularLimit?.step ?? 0;
          const clamp = angularLimit?.clamp !== false;
          const angleSpanDeg = Math.max(1, Math.abs((angularLimit?.maxAngleDeg ?? 150) - (angularLimit?.minAngleDeg ?? -150)));
          const angleSpanRad = (angleSpanDeg * Math.PI) / 180;
          let prevAngle = Math.atan2(dy0, dx0);
          const onDialMove = (moveEvent: PointerEvent) => {
            const dx = moveEvent.clientX - kx;
            const dy = moveEvent.clientY - ky;
            if (Math.hypot(dx, dy) < 3) return;
            let dAngle = Math.atan2(dy, dx) - prevAngle;
            if (dAngle >  Math.PI) dAngle -= 2 * Math.PI;
            if (dAngle < -Math.PI) dAngle += 2 * Math.PI;
            prevAngle = Math.atan2(dy, dx);

            const comp = liveComponent();
            if (!comp) return;
            const currentValue = numericComponentProperty(comp, positionProp, propMin);
            let nextValue = currentValue + (dAngle / angleSpanRad) * (propMax - propMin);
            if (propStep > 0) nextValue = Math.round(nextValue / propStep) * propStep;
            if (clamp) nextValue = clampNumber(nextValue, Math.min(propMin, propMax), Math.max(propMin, propMax));
            if (Math.abs(nextValue - currentValue) < 1e-12) return;
            comp.properties[positionProp] = nextValue;
            send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestUpdateProperty", componentId: comp.id, name: positionProp, value: nextValue });
            if (indicatorEl) {
              const angle = mapLinear(nextValue, [propMin, propMax], [angularLimit?.minAngleDeg ?? -150, angularLimit?.maxAngleDeg ?? 150]);
              indicatorEl.setAttribute("transform", `rotate(${angle}, ${centerX}, ${centerY})`);
            }
            persistState();
          };
          const onDialUp = () => {
            el.removeEventListener("pointermove", onDialMove);
            el.removeEventListener("pointerup", onDialUp);
            el.removeEventListener("pointercancel", onDialUp);
            isDraggingComponent = false;
            render();
          };
          isDraggingComponent = true;
          el.setPointerCapture(event.pointerId);
          el.addEventListener("pointermove", onDialMove);
          el.addEventListener("pointerup", onDialUp, { once: true });
          el.addEventListener("pointercancel", onDialUp, { once: true });
          return;
        }
        const radPerStep = (2 * Math.PI) / stepsRev;
        let prevAngle = Math.atan2(dy0, dx0);
        let accumDelta = 0;
        const onEncoderMove = (moveEvent: PointerEvent) => {
          const dx = moveEvent.clientX - kx;
          const dy = moveEvent.clientY - ky;
          if (Math.hypot(dx, dy) < 3) return;
          let dAngle = Math.atan2(dy, dx) - prevAngle;
          if (dAngle >  Math.PI) dAngle -= 2 * Math.PI;
          if (dAngle < -Math.PI) dAngle += 2 * Math.PI;
          prevAngle = Math.atan2(dy, dx);
          accumDelta += dAngle / radPerStep;
          const steps = Math.trunc(accumDelta);
          if (steps !== 0) {
            accumDelta -= steps;
            const comp = liveComponent();
            if (comp) {
              const currentPos = numericComponentProperty(comp, positionProp, 0);
              const newPos = currentPos + steps;
              comp.properties[positionProp] = newPos;
              send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestUpdateProperty", componentId: comp.id, name: positionProp, value: newPos });
              if (indicatorEl) {
                const angle = ((((newPos % stepsRev) + stepsRev) % stepsRev) / stepsRev) * 360;
                indicatorEl.setAttribute("transform", `rotate(${angle}, ${centerX}, ${centerY})`);
              }
              persistState();
            }
          }
        };
        const onEncoderUp = () => {
          el.removeEventListener("pointermove", onEncoderMove);
          el.removeEventListener("pointerup", onEncoderUp);
          el.removeEventListener("pointercancel", onEncoderUp);
          isDraggingComponent = false;
          render();
        };
        isDraggingComponent = true;
        el.setPointerCapture(event.pointerId);
        el.addEventListener("pointermove", onEncoderMove);
        el.addEventListener("pointerup", onEncoderUp, { once: true });
        el.addEventListener("pointercancel", onEncoderUp, { once: true });
        return;
      }
      if (hitTouchpad) {
        const svgEl = el.querySelector<SVGSVGElement>(".component__symbol");
        if (!svgEl) { isDraggingComponent = false; return; }
        const indicatorEl = el.querySelector<SVGElement>(".touch-indicator");
        const xPixelRange = touchPoint?.x.pixelRange ?? [4, 116] as [number, number];
        const yPixelRange = touchPoint?.y.pixelRange ?? [4, 140] as [number, number];
        const touchMinX = Math.min(xPixelRange[0], xPixelRange[1]);
        const touchMaxX = Math.max(xPixelRange[0], xPixelRange[1]);
        const touchMinY = Math.min(yPixelRange[0], yPixelRange[1]);
        const touchMaxY = Math.max(yPixelRange[0], yPixelRange[1]);
        const touchPropX = touchPoint?.x.prop ?? "touch_x";
        const touchPropY = touchPoint?.y.prop ?? "touch_y";
        const pressedProp = touchPoint?.pressedProp ?? "pressed";
        const pointFromEvent = (pointerEvent: PointerEvent): { x: number; y: number } => {
          const svgRect = svgEl.getBoundingClientRect();
          const viewBoxParts = svgEl.getAttribute("viewBox")?.split(/\s+/) ?? [];
          const vbX = parseFloat(viewBoxParts[0] ?? "0");
          const vbY = parseFloat(viewBoxParts[1] ?? "0");
          const vbW = parseFloat(viewBoxParts[2] ?? String(svgRect.width || Math.max(1, touchMaxX - touchMinX)));
          const vbH = parseFloat(viewBoxParts[3] ?? String(svgRect.height || Math.max(1, touchMaxY - touchMinY)));
          const localX = vbX + ((pointerEvent.clientX - svgRect.left) / Math.max(1, svgRect.width)) * vbW;
          const localY = vbY + ((pointerEvent.clientY - svgRect.top) / Math.max(1, svgRect.height)) * vbH;
          return {
            x: Math.max(touchMinX, Math.min(touchMaxX, localX)),
            y: Math.max(touchMinY, Math.min(touchMaxY, localY)),
          };
        };
        const applyTouch = (pointerEvent: PointerEvent, pressed: boolean) => {
          const point = pointFromEvent(pointerEvent);
          const comp = liveComponent();
          if (!comp) return;
          const widthPx = Math.max(1, Number(comp.properties.width) || 240);
          const heightPx = Math.max(1, Number(comp.properties.height) || 320);
          const xOutputRange = touchPropX === "touch_x" ? [0, widthPx] as [number, number] : (touchPoint?.x.propRange ?? [0, widthPx] as [number, number]);
          const yOutputRange = touchPropY === "touch_y" ? [0, heightPx] as [number, number] : (touchPoint?.y.propRange ?? [0, heightPx] as [number, number]);
          const touchX = Math.round(mapLinear(point.x, xPixelRange, xOutputRange));
          const touchY = Math.round(mapLinear(point.y, yPixelRange, yOutputRange));
          comp.properties[touchPropX] = touchX;
          comp.properties[touchPropY] = touchY;
          comp.properties[pressedProp] = pressed;
          send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestUpdateProperty", componentId: comp.id, name: touchPropX, value: touchX });
          send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestUpdateProperty", componentId: comp.id, name: touchPropY, value: touchY });
          send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestUpdateProperty", componentId: comp.id, name: pressedProp, value: pressed });
          if (indicatorEl) {
            const dx = mapLinear(touchX, xOutputRange, [0, 112]);
            const dy = mapLinear(touchY, yOutputRange, [0, 136]);
            indicatorEl.setAttribute("transform", `translate(${dx.toFixed(2)},${dy.toFixed(2)})`);
            indicatorEl.style.display = pressed ? "" : "none";
          }
        };
        const onTouchpadMove = (moveEvent: PointerEvent) => {
          applyTouch(moveEvent, true);
          persistState();
        };
        const onTouchpadUp = (upEvent: PointerEvent) => {
          el.removeEventListener("pointermove", onTouchpadMove);
          el.removeEventListener("pointerup", onTouchpadUp);
          el.removeEventListener("pointercancel", onTouchpadUp);
          applyTouch(upEvent, false);
          isDraggingComponent = false;
          persistState();
          render();
        };
        isDraggingComponent = true;
        el.setPointerCapture(event.pointerId);
        applyTouch(event, true);
        persistState();
        el.addEventListener("pointermove", onTouchpadMove);
        el.addEventListener("pointerup", onTouchpadUp, { once: true });
        el.addEventListener("pointercancel", onTouchpadUp, { once: true });
        return;
      }
      if (hitSw) {
        const pressProp = press?.prop ?? "sw_pressed";
        const pressedValue = press?.pressedValue ?? true;
        const releasedValue = press?.releasedValue ?? false;
        const comp = liveComponent();
        if (comp) {
          comp.properties[pressProp] = pressedValue;
          send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestUpdateProperty", componentId: comp.id, name: pressProp, value: pressedValue });
        }
        const onSwUp = () => {
          el.removeEventListener("pointerup", onSwUp);
          el.removeEventListener("pointercancel", onSwUp);
          isDraggingComponent = false;
          const comp = liveComponent();
          if (comp) {
            comp.properties[pressProp] = releasedValue;
            send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestUpdateProperty", componentId: comp.id, name: pressProp, value: releasedValue });
          }
          persistState();
          render();
        };
        persistState();
        el.addEventListener("pointerup", onSwUp, { once: true });
        el.addEventListener("pointercancel", onSwUp, { once: true });
        return;
      }
    }

    const clickedToggleZone = event.target instanceof Element && Boolean(event.target.closest(".toggle-hit-zone"));
    const canToggle = (isPushButton || isToggleClickable || isFixedVolt) && clickedToggleZone;

    const DRAG_THRESHOLD_PX = 4;
    let dragStarted = false;
    if (isPushButton && canToggle) setPushClosed(component, true);

    const startDragging = (): void => {
      dragStarted = true;
      el.classList.add("dragging");
      if (isPushButton && canToggle) setPushClosed(component, false); // movimento detectado -- isto era arrasto, não aperto
      if (isDuplicateDragGesture) {
        // NUNCA chama render() aqui -- reparentear `el` (o elemento sendo arrastado, com
        // `setPointerCapture` já ativo) no meio do gesto libera a captura implicitamente (mesmo
        // bug documentado acima sobre `componentElementsById`/telemetria), quebrando o resto do
        // arrasto. Insere os componentes/fios duplicados diretamente no DOM/estado, sem tocar `el`.
        const { components: duplicated, wires: duplicatedWires } = duplicateComponentsForDrag(dragTargets.map((target) => target.component));
        if (duplicated.length > 0 && canvasContentElement) {
          state = { ...state, components: [...state.components, ...duplicated], topology: { ...state.topology, conductors: [...state.topology.conductors, ...duplicatedWires] } };
          for (const dup of duplicated) {
            const dupEl = createComponentElement(dup);
            componentElementsById.set(dup.id, dupEl);
            canvasContentElement.appendChild(dupEl);
          }
          dragTargets = duplicated.map((dup) => {
            const offset = componentDivOffset(dup);
            return { component: dup, startX: dup.x, startY: dup.y, offsetX: offset.x, offsetY: offset.y };
          });
          send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestInsertItems", components: duplicated, wires: duplicatedWires });
        }
      }
    };

    const onMove = (moveEvent: PointerEvent) => {
      if (!dragStarted && Math.hypot(moveEvent.clientX - dragStartX, moveEvent.clientY - dragStartY) > DRAG_THRESHOLD_PX) {
        startDragging();
      }
      if (!dragStarted) return;
      const zoom = state.viewport.zoom || 1;
      const dx = (moveEvent.clientX - dragStartX) / zoom;
      const dy = (moveEvent.clientY - dragStartY) / zoom;
      for (const target of dragTargets) {
        target.component.x = target.startX + dx;
        target.component.y = target.startY + dy;
        // Lookup O(1) via `componentElementsById` (UI-2/UI-3) -- percorrido por alvo arrastado a
        // cada `pointermove`, potencialmente muitas vezes por segundo com vários componentes selecionados.
        const targetEl = componentElementsById.get(target.component.id);
        if (targetEl) {
          targetEl.style.left = `${target.component.x + target.offsetX}px`;
          targetEl.style.top = `${target.component.y + target.offsetY}px`;
        }
        updateWiresTouchingComponent(target.component.id);
      }
      if (groupWireDragTarget) applyGroupWireDelta(groupWireDragTarget, dx, dy);
      if (groupWireMoveTargets) applyGroupMoveWireDelta(groupWireMoveTargets, dx, dy);
    };

    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.classList.remove("dragging");
      isDraggingComponent = false;
      // Depois de um `Ctrl+Shift`-drag, a seleção passa a ser a CÓPIA recém-solta (não os
      // originais, que ficaram parados) -- mesmo resultado esperado de "duplicar e mover".
      if (dragStarted && isDuplicateDragGesture && dragTargets.length > 0) {
        state.selectedComponentIds = dragTargets.map((target) => target.component.id);
      }
      const draggedComponentIds = dragStarted ? dragTargets.map((target) => target.component.id) : [];
      dragTargets = [];
      groupWireDragTarget = undefined;
      groupWireMoveTargets = undefined;
      if (!dragStarted && canToggle) {
        if (isPushButton) setPushClosed(component, false);
        else if (isToggleClickable) setSwitchClosed(component, component.properties.closed !== true);
        else if (isFixedVolt) setFixedVoltOut(component, component.properties.out !== true);
      }
      persistState();
      render();
      // Roda DEPOIS de persistir/renderizar o movimento em si -- é um bônus best-effort (conectar
      // automaticamente se algum pino ficou em cima de um fio), nunca pode arriscar deixar o
      // movimento em si sem persistir se algo aqui der errado.
      if (draggedComponentIds.length > 0) {
        try {
          maybeAutoJunctionForDraggedComponents(draggedComponentIds);
        } catch (err) {
          console.error("maybeAutoJunctionForDraggedComponents falhou (movimento já persistido, sem impacto)", err);
        }
      }
    };

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp, { once: true });
    el.addEventListener("pointercancel", onUp, { once: true });
  });

  updateComponentElement(el, component);
  return el;
}

/** Atualização VISUAL pura do `.component` já existente -- roda em TODO `render()` (ver
 * `componentElementsById`), nunca toca os listeners de `createComponentElement`. Reconstrói o
 * `<svg>` inteiro (símbolo/pinos/seleção) porque rotação/flip/propriedades podem ter mudado desde a
 * última chamada; os listeners dos PINOS (clique pra iniciar/terminar fio) são recriados aqui junto
 * do resto do SVG -- sempre frescos, sem risco de capturar `component` desatualizado (diferente dos
 * listeners de `el`, que sobrevivem a vários renders). */
function updateComponentElement(el: HTMLElement, component: WebviewComponentModel): void {
  const box = componentBox(component.typeId, component.properties);
  // Bloco genérico de subcircuito por caminho cujo `.lssubcircuit` não foi encontrado (arquivo
  // movido/apagado, ver `chooseSubcircuitFileCommand`/carregamento de projeto) -- `subcircuitRef`
  // presente mas o typeId atual não tem entrada no catálogo desta sessão.
  const {
    catalogEntry, isPushButton, isSwitchToggle, isFixedVolt, isRail, isTunnel, isMeter, isVoltmeter, hasPackageVisual, isMissingSubcircuitRef,
  } = componentVisualFlags(component);
  const isUnknownComponent = !catalogEntry && !component.subcircuitRef;
  const meterClass = isMeter ? `component--meter component--${component.typeId.replace(/[._]/g, "-")}` : "";

  // CSS aplica da direita pra esquerda: scale (flip) primeiro, rotate depois -- mesma ordem usada
  // em flipPoint/rotatePoint pra calcular posição de pino, ver componentPinLocalPosition.
  const scaleX = component.flipH ? -1 : 1;
  const scaleY = component.flipV ? -1 : 1;
  const symbolProperties = runtimeSymbolProperties(component);
  const localOrigin = componentLocalOrigin(component.typeId, symbolProperties);
  // Caixa REAL (canvas-local, já rotacionada/espelhada) -- usada pro hit-box do `<div>` (o que o
  // navegador de fato considera clicável) e pro `viewBox`, ver `rotatedComponentLocalBox`. `bodyGroup`
  // continua desenhando na caixa CANÔNICA de sempre (rotation=0) -- só a JANELA em volta dele (`div`+
  // `viewBox`) passa a acompanhar a rotação, então nenhuma posição de pino/fio muda.
  const rotatedBox = rotatedComponentLocalBox(box, component.rotation, Boolean(component.flipH), Boolean(component.flipV), localOrigin);

  el.className = `component ${isComponentSelected(component.id) ? "selected" : ""} ${hasPackageVisual ? "component--package" : ""} ${isVoltmeter ? "component--voltmeter" : ""} ${isPushButton ? "component--push" : ""} ${isSwitchToggle ? "component--switch" : ""} ${isFixedVolt ? "component--fixed-volt" : ""} ${isRail ? "component--rail" : ""} ${isTunnel ? "component--tunnel" : ""} ${meterClass} ${isMissingSubcircuitRef ? "component--subcircuit-missing" : ""} ${isUnknownComponent ? "component--unknown" : ""}`;
  el.style.left = `${component.x + rotatedBox.x}px`;
  el.style.top = `${component.y + rotatedBox.y}px`;
  el.style.width = `${rotatedBox.width}px`;
  el.style.height = `${rotatedBox.height}px`;
  el.title = isMissingSubcircuitRef
    ? `${component.label} -- ${t("locateSubcircuitFile")}\n${component.subcircuitRef?.path ?? ""}`
    : isUnknownComponent
      ? `${component.label} -- ${t("unknownComponent")}\n${component.typeId}`
      : `${component.label} (${component.typeId})`;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.classList.add("component__symbol");
  svg.setAttribute("viewBox", `${rotatedBox.x} ${rotatedBox.y} ${rotatedBox.width} ${rotatedBox.height}`);
  const bodyGroup = document.createElementNS(SVG_NS, "g");
  bodyGroup.classList.add("component__symbol-body");
  bodyGroup.setAttribute("transform", svgBodyTransform(box, component.rotation, Boolean(component.flipH), Boolean(component.flipV), localOrigin));
  // Estado aberto/fechado de push/switch/switch_dip agora vem de `stateFill`/`stateVisible` no
  // `package.simulidePaint` (primitivas diferentes por valor de `properties.closed`, reconstruídas a
  // cada `packageSymbolSvg` abaixo) -- não precisa mais de uma classe CSS `--push-pressed`/
  // `--switch-closed` alternada aqui pra trocar a aparência.
  if (isFixedVolt) {
    svg.classList.add("component__symbol--fixed-volt");
    if (component.properties.out === true) svg.classList.add("component__symbol--fixed-volt-on");
  }
  bodyGroup.innerHTML = isMissingSubcircuitRef || isUnknownComponent
    ? missingSubcircuitPlaceholderSvg(box)
    : packageSymbolSvg(component.typeId, symbolProperties, component.id) ?? catalogEntry?.symbolSvg ?? componentSymbolSvg(component.typeId, symbolProperties);
  svg.appendChild(bodyGroup);
  const tunnelLabel = bodyGroup.querySelector<SVGTextElement>(".tunnel-name");
  if (tunnelLabel && (component.flipH || component.flipV)) {
    tunnelLabel.style.transformBox = "fill-box";
    tunnelLabel.style.transformOrigin = "center";
    tunnelLabel.style.transform = `scale(${scaleX}, ${scaleY})`;
  }

  if (isComponentSelected(component.id)) {
    // Coordenadas ABSOLUTAS de `rotatedBox` (não `0%/100%`) -- percentual de POSIÇÃO em SVG (`x`/`y`)
    // não compensa um `viewBox` com `minX`/`minY` deslocado: `x="0%"` sempre resolve pra coordenada
    // absoluta 0, não pro canto visível do viewport (só `width`/`height` percentual escalam certo
    // contra o tamanho do viewport -- posição não). Como o `viewBox` agora começa em
    // `rotatedBox.x/y` (não-zero pra qualquer rotação/flip real), um retângulo em `0%,0%` ficava
    // fora da janela visível -- exatamente o destaque cinza desalinhado relatado (2ª rodada). Usar os
    // MESMOS `rotatedBox.x/y/width/height` do `viewBox` cobre a janela inteira de verdade.
    const overlay = document.createElementNS(SVG_NS, "rect");
    overlay.setAttribute("x", String(rotatedBox.x));
    overlay.setAttribute("y", String(rotatedBox.y));
    overlay.setAttribute("width", String(rotatedBox.width));
    overlay.setAttribute("height", String(rotatedBox.height));
    overlay.setAttribute("class", "selection-overlay");
    svg.appendChild(overlay);
  }

  component.pins.forEach((pin, index) => {
    // Pino elétrico real sem lead físico no encapsulamento (ex: GPIO20/24/28-31/UART0_RX/TX do chip
    // ESP32 nu) -- nunca desenha terminal genérico por cima do desenho real dos outros, ver
    // `componentSymbols.ts::hasRealPinPosition`. Continua existindo em `component.pins[]` (contrato
    // posicional com o Core), só não fica clicável/visível -- fiel ao hardware real, que também não
    // tem ponto de solda aí.
    if (!hasRealPinPosition(component.typeId, pin.id, component.properties)) return;
    const local = componentPinLocalPosition(component, index);
    const isActive = state.pendingConnection?.kind !== "wire" && state.pendingConnection?.componentId === component.id && state.pendingConnection?.pinId === pin.id;
    const circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("cx", String(local.x));
    circle.setAttribute("cy", String(local.y));
    circle.setAttribute("r", String(PIN_RADIUS));
    circle.setAttribute("class", `pin-terminal ${isActive ? "pin-terminal--active" : ""}`);
    const titleEl = document.createElementNS(SVG_NS, "title");
    titleEl.textContent = pin.id;
    circle.appendChild(titleEl);

    circle.addEventListener("click", (event) => {
      event.stopPropagation();
      // `handleWireGestureClick` já cobre a guarda de `placingTypeId` -- clique é descartado,
      // `stopPropagation` já rodou.
      const point = pinScenePosition(component, pin.id)!;
      handleWireGestureClick({ kind: "pin", componentId: component.id, pinId: pin.id, point });
    });
    svg.appendChild(circle);
  });

  el.querySelector("svg")?.remove();
  el.appendChild(svg);
}

type PropertyFieldKind = "boolean" | "number" | "text" | "readonly" | "select" | "filePath" | "color" | "textarea";

interface PropertyField {
  key: string;
  label: string;
  kind: PropertyFieldKind;
  value: string | number | boolean;
  readonly?: boolean;
  group: string;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  /** Unidade base (ex: "Ω", "F") -- quando presente num campo `number` editável, ativa o seletor de
   * múltiplo de unidade (pF/nF/µF/.../k/M/G) ao lado do input, mesmo `NumVal::addMultipliers` do
   * SimulIDE real (achado de auditoria de UI 2026-07-09). */
  unit?: string;
}

interface PropertySheetOptions {
  titleText?: string;
  allowTitleEdit?: boolean;
  showVisibilityToggle?: boolean;
  onPropertyChange?: (key: string, value: string | number | boolean) => void;
}

function humanizePropertyName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function inferPropertyGroup(name: string): string {
  const normalized = name.toLowerCase();
  if (normalized.includes("key") || normalized.includes("tecla")) return t("shortcut");
  if (normalized.includes("show") || normalized.includes("visible") || normalized.includes("title") || normalized.includes("label")) return t("visual");
  if (normalized.includes("pole") || normalized.includes("throw") || normalized.includes("close") || normalized.includes("open")) return t("principal");
  return t("principal");
}

function propertyFieldKindFromEditor(editor: string): PropertyFieldKind {
  const normalized = editor.trim().toLowerCase();
  if (normalized === "checkbox" || normalized === "switch") return "boolean";
  if (normalized === "select" || normalized === "enum") return "select";
  if (normalized === "display") return "readonly";
  if (normalized === "number") return "number";
  if (normalized === "filepath") return "filePath";
  if (normalized === "color") return "color";
  if (normalized === "textarea" || normalized === "textedit") return "textarea";
  return "text";
}

/** Mesmo texto que `voltmeterReadoutText` produzia (hardcoded só pro voltímetro), generalizado pra
 * qualquer campo `showOnSymbol && editor==="display"`: valor medido ao vivo (telemetria, não uma
 * propriedade) enquanto a simulação roda, placeholder "..." até a primeira leitura chegar, "0.000"
 * quando parado. Não é mais inferência — é a única ponte documentada entre o schema (estático, por
 * typeId) e a telemetria (dinâmica, por instância, via `readoutsByComponentId`). */
function formatLiveReadout(schema: PropertySchemaEntry, component: WebviewComponentModel): string {
  const unit = schema.unit ? ` ${schema.unit}` : "";
  const live = numericReadout(component);
  if (typeof live === "number") return `${live.toFixed(3)}${unit}`;
  if (simulationStatus === "running") return `...${unit}`;
  return `0.000${unit}`;
}

/** Propriedade do typeId mostrada no rótulo de valor -- `component.valueLabelPropertyKey` (escolha
 * explícita da instância, ver `model.ts`) tem prioridade quando aponta pra um schema numérico
 * válido do typeId atual; senão cai pro default do catálogo (`showOnSymbol`). Mesma fonte
 * (`propertySchema` do catálogo) usada pelo diálogo de propriedades, ver `resolvePropertyFields`. */
function findShowOnSymbolSchema(component: WebviewComponentModel): PropertySchemaEntry | undefined {
  const schemas = catalogEntryFor(component.typeId)?.propertySchema;
  if (!schemas) return undefined;
  if (component.valueLabelPropertyKey) {
    const chosen = schemas.find(
      (schema) => schema.id === component.valueLabelPropertyKey && propertyFieldKindFromEditor(schema.editor) === "number"
    );
    if (chosen) return chosen;
  }
  return schemas.find((schema) => schema.showOnSymbol);
}

/** Propriedades numéricas do typeId elegíveis pro rótulo de valor -- usado só pra decidir SE mostra
 * o seletor de rádio "mostrar no símbolo" (`renderPropertyField`), não pra escolher a propriedade
 * em si (isso é `findShowOnSymbolSchema`). */
function numericFieldCandidates(component: WebviewComponentModel): PropertySchemaEntry[] {
  const schemas = catalogEntryFor(component.typeId)?.propertySchema;
  if (!schemas) return [];
  return schemas.filter((schema) => propertyFieldKindFromEditor(schema.editor) === "number" && !schema.hidden);
}

/** Texto do rótulo de valor (ex: "1 kΩ", ou a leitura ao vivo do voltímetro) — `undefined` quando o
 * typeId não tem propriedade `showOnSymbol` nenhuma (nada a mostrar). Generaliza o que antes era um
 * bloco hardcoded só pro voltímetro em `renderComponent`. */
function valueLabelText(component: WebviewComponentModel): string | undefined {
  const schema = findShowOnSymbolSchema(component);
  if (!schema) return undefined;
  if (schema.editor === "display") return formatLiveReadout(schema, component);
  const raw = component.properties[schema.id] ?? schema.default;
  return typeof raw === "number" ? formatEngineeringValue(raw, schema.unit) : String(raw);
}

function labelPropertyKey(kind: ExternalLabelKind, suffix: "x" | "y" | "rotation"): string {
  const prefix = kind === "id" ? "__ui_idLabel" : "__ui_valueLabel";
  return `${prefix}${suffix === "rotation" ? "Rotation" : suffix.toUpperCase()}`;
}

/** `showValue` efetivo de um componente -- `false` incondicional pra typeId com mostrador embutido
 * no próprio SVG do símbolo (meters/voltímetro/readoutFormat, ver `usesEmbeddedValueLabel`), senão
 * o valor explícito da instância ou, na ausência, se o catálogo tem alguma propriedade
 * `showOnSymbol` (default "mostra se tem o que mostrar"). Ponto único -- calculado em dois lugares
 * antes (`externalLabelText`/`refreshReadouts`) sempre com a mesma expressão. */
function effectiveShowValue(component: WebviewComponentModel): boolean {
  if (usesEmbeddedValueLabel(component.typeId)) return false;
  return component.showValue ?? Boolean(findShowOnSymbolSchema(component));
}

function externalLabelText(component: WebviewComponentModel, kind: ExternalLabelKind): string | undefined {
  if (kind === "id") {
    return !component.hidden && component.showId ? component.label : undefined;
  }
  return !component.hidden && effectiveShowValue(component) ? valueLabelText(component) : undefined;
}

function defaultExternalLabelOffset(component: WebviewComponentModel, kind: ExternalLabelKind): Point {
  const packageValueLabel = catalogEntryFor(component.typeId)?.package?.valueLabel;
  if (kind === "value" && packageValueLabel) return { x: packageValueLabel.x, y: packageValueLabel.y };
  const box = componentBox(component.typeId, component.properties);
  return kind === "id"
    ? { x: 0, y: -14 }
    : { x: 0, y: box.height + 2 };
}

function externalLabelOffset(component: WebviewComponentModel, kind: ExternalLabelKind): Point {
  const fallback = defaultExternalLabelOffset(component, kind);
  const x = component.properties[labelPropertyKey(kind, "x")];
  const y = component.properties[labelPropertyKey(kind, "y")];
  return {
    x: typeof x === "number" ? x : fallback.x,
    y: typeof y === "number" ? y : fallback.y,
  };
}

function externalLabelRotation(component: WebviewComponentModel, kind: ExternalLabelKind): 0 | 90 | 180 | 270 {
  const raw = component.properties[labelPropertyKey(kind, "rotation")];
  if (raw === undefined && kind === "value") {
    const packageRotation = catalogEntryFor(component.typeId)?.package?.valueLabel?.rotation;
    if (packageRotation === -90) return 270;
    if (packageRotation === 0 || packageRotation === 90 || packageRotation === 180 || packageRotation === 270) return packageRotation;
  }
  return raw === 90 || raw === 180 || raw === 270 ? raw : 0;
}

function setExternalLabelLayout(component: WebviewComponentModel, kind: ExternalLabelKind, patch: Partial<{ x: number; y: number; rotation: 0 | 90 | 180 | 270 }>): void {
  if (patch.x !== undefined) {
    component.properties[labelPropertyKey(kind, "x")] = Math.round(patch.x);
    send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestUpdateProperty", componentId: component.id, name: labelPropertyKey(kind, "x"), value: Math.round(patch.x) });
  }
  if (patch.y !== undefined) {
    component.properties[labelPropertyKey(kind, "y")] = Math.round(patch.y);
    send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestUpdateProperty", componentId: component.id, name: labelPropertyKey(kind, "y"), value: Math.round(patch.y) });
  }
  if (patch.rotation !== undefined) {
    component.properties[labelPropertyKey(kind, "rotation")] = patch.rotation;
    send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestUpdateProperty", componentId: component.id, name: labelPropertyKey(kind, "rotation"), value: patch.rotation });
  }
}

function rotateSelectedTextLabel(steps: 1 | -1 | 2): boolean {
  if (!selectedTextLabel) return false;
  const activeLabel = selectedTextLabel;
  const component = state.components.find((entry) => entry.id === activeLabel.componentId);
  if (!component) return false;
  const current = externalLabelRotation(component, activeLabel.kind);
  const delta = steps === 2 ? 180 : steps * 90;
  const next = ((((current + delta) % 360) + 360) % 360) as 0 | 90 | 180 | 270;
  setExternalLabelLayout(component, activeLabel.kind, { rotation: next });
  persistState();
  render();
  return true;
}

function isMcuHostComponent(component: WebviewComponentModel): boolean {
  return isMcuHostTypeId(component.typeId);
}

function isMcuHostTypeId(typeId: string): boolean {
  const entry = catalogEntryFor(typeId);
  return entry?.mcuHost === true;
}

function serialPortsForTypeId(typeId: string): McuSerialPortEntry[] {
  return catalogEntryFor(typeId)?.serialPorts ?? [];
}

function buildExposedComponentMenuItems(component: WebviewComponentModel): ContextMenuItem[] {
  const sourceId = catalogEntryFor(component.typeId)?.registeredSourceId;
  if (!sourceId) return [];
  ensureBoardOverlayData(component);
  const items = boardOverlayDataByComponentId.get(component.id) ?? [];
  return items
    .filter((item) => item.exposed)
    .map((item) => {
      const actions: ContextMenuItem[] = [];
      if (isMcuHostTypeId(item.typeId)) {
        actions.push(
          { label: t("loadFirmware"), onClick: () => send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestChooseExposedMcuFirmware", outerComponentId: component.id, innerComponentId: item.id }) },
          ...serialPortsForTypeId(item.typeId).map((port) => ({
            label: `${t("openSerialMonitor")} ${port.label}`,
            onClick: () => send({
              version: WEBVIEW_MESSAGE_VERSION,
              type: "requestOpenExposedMcuSerialMonitor",
              outerComponentId: component.id,
              innerComponentId: item.id,
              usartIndex: port.usartIndex,
            }),
          } satisfies ContextMenuItem)),
        );
      }
      actions.push({ label: t("properties"), icon: "properties", onClick: () => openExposedInternalPropertyDialog(component.id, sourceId, item) });
      return { label: item.label, items: actions } satisfies ContextMenuItem;
    });
}

function augmentRuntimePropertyFields(component: WebviewComponentModel, fields: PropertyField[]): PropertyField[] {
  if (!isMcuHostComponent(component)) return fields;
  const existingKeys = new Set(fields.map((field) => field.key));
  const augmented = [...fields];
  if (!existingKeys.has("firmwarePath")) {
    augmented.push({
      key: "firmwarePath",
      label: t("firmwarePath"),
      kind: "text",
      value: component.properties.firmwarePath ?? "",
      group: t("firmwareGroup"),
    });
  }
  if (!existingKeys.has("qemuBinaryOverride")) {
    augmented.push({
      key: "qemuBinaryOverride",
      label: t("qemuBinary"),
      kind: "text",
      value: component.properties.qemuBinaryOverride ?? "",
      group: t("firmwareGroup"),
    });
  }
  return augmented;
}

/** Schema-driven: grupo/ordem/rótulo/editor/min/max/opções vêm do `propertySchema` que o Core
 * declarou pro typeId (built-in ou plugin, ver `getPropertySchemas`) em vez de inferidos do valor JS
 * (`typeof value`) e de heurística de nome -- isso é o que faz spinbox, select/enum, campo oculto e
 * rótulo customizado funcionarem de verdade. Cai pra `inferPropertyFields` (heurística antiga) só
 * quando o Core ainda não tem schema pra este typeId (registrado-mas-desabilitado, por exemplo) --
 * degradação graciosa, nunca quebra o diálogo. */
function resolvePropertyFields(component: WebviewComponentModel): PropertyField[] {
  const catalogEntry = catalogEntryFor(component.typeId);
  const schema = catalogEntry?.propertySchema;
  if (!schema || schema.length === 0) return augmentRuntimePropertyFields(component, inferPropertyFields(component));

  const fields: PropertyField[] = [];
  for (const propSchema of schema) {
    if (propSchema.hidden && !propertyDialogShowAll) continue;
    const kind = propertyFieldKindFromEditor(propSchema.editor);
    const isLiveReadout = kind === "readonly" && Boolean(propSchema.showOnSymbol);
    // "filePath" tem 2 fontes possíveis: o caso especial único `subcircuitPath` (bloco genérico de
    // subcircuito por caminho) nunca guarda o caminho em `properties` -- vem de
    // `component.subcircuitRef.path` (ver model.ts), a mesma referência usada pra resolver
    // pinos/package/relink, nunca duplicada num segundo lugar. Qualquer OUTRO campo `filePath`
    // (ex: `graphics.image.path`) é genérico e guarda direto em `properties[id]`, como qualquer
    // outra propriedade -- ver `renderPropertyField`/`requestChooseFile`.
    const value = isLiveReadout
      ? formatLiveReadout(propSchema, component)
      : kind === "filePath"
        ? propSchema.id === "subcircuitPath"
          ? (component.subcircuitRef?.path ?? "")
          : (component.properties[propSchema.id] ?? propSchema.default ?? "")
        : component.properties[propSchema.id] ?? propSchema.default;
    fields.push({
      key: propSchema.id,
      label: propSchema.label,
      kind,
      value,
      readonly: propSchema.readOnly || isLiveReadout,
      group: propSchema.group || t("principal"),
      min: propSchema.min,
      max: propSchema.max,
      step: propSchema.step,
      options: propSchema.options,
      unit: propSchema.unit,
    });
  }
  return augmentRuntimePropertyFields(component, fields);
}

function inferPropertyFields(component: WebviewComponentModel): PropertyField[] {
  const fields: PropertyField[] = [];
  for (const [key, value] of Object.entries(component.properties)) {
    if (key.startsWith("__ui_")) continue;
    fields.push({
      key,
      label: humanizePropertyName(key),
      kind: typeof value === "boolean" ? "boolean" : typeof value === "number" ? "number" : "text",
      value,
      group: inferPropertyGroup(key),
    });
  }

  if (component.typeId === "instruments.voltmeter") {
    fields.push({
      key: "__meter_readout__",
      label: t("measuredVoltage"),
      kind: "readonly",
      value: voltmeterReadoutText(component),
      readonly: true,
      group: t("reading"),
    });
  }

  return augmentRuntimePropertyFields(component, fields);
}

function groupFields(fields: PropertyField[]): Map<string, PropertyField[]> {
  const groups = new Map<string, PropertyField[]>();
  for (const field of fields) {
    const list = groups.get(field.group) ?? [];
    list.push(field);
    groups.set(field.group, list);
  }
  return groups;
}

function renderPropertyField(component: WebviewComponentModel, field: PropertyField, options: PropertySheetOptions = {}): HTMLElement {
  const applyChange = (value: string | number | boolean): void => {
    component.properties[field.key] = value;
    if (options.onPropertyChange) {
      options.onPropertyChange(field.key, value);
    } else {
      send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestUpdateProperty", componentId: component.id, name: field.key, value });
      persistState();
    }
    refreshOpenPropertyDialog();
  };
  if (field.kind === "filePath") {
    // Bloco genérico de subcircuito por caminho (`field.key === "subcircuitPath"`) -- NUNCA edita
    // `component.properties[field.key]` direto (o campo é só leitura + botão), o caminho de verdade
    // mora em `component.subcircuitRef` (ver `resolvePropertyFields`). Escolher/trocar arquivo é um
    // fluxo assíncrono no host (parse + troca de typeId/pinos/package + registro no Core) -- mesmo
    // comando usado pelo menu de contexto "Localizar arquivo do subcircuito...". Qualquer OUTRO
    // campo `filePath` (ex: `graphics.image.path`, usado pela Figura/ícone da autoria de Package,
    // `.spec/lasecsimul.spec`) é genérico: `requestChooseFile` lê o arquivo no host e grava o
    // resultado direto em `properties[propertyKey]` -- sem trocar typeId/pinos/nada mais.
    const isSubcircuitRefPath = field.key === "subcircuitPath";
    const row = document.createElement("label");
    row.className = "property-sheet__field-row";
    const caption = document.createElement("span");
    caption.className = "property-sheet__field-label";
    caption.textContent = `${field.label}:`;
    const fileGroup = document.createElement("div");
    fileGroup.className = "property-sheet__file-group";
    const pathText = document.createElement("input");
    pathText.className = "property-sheet__field-input";
    pathText.type = "text";
    pathText.readOnly = true;
    pathText.value = String(field.value) || t("noSubcircuitFileChosen");
    pathText.title = String(field.value);
    const browseButton = document.createElement("button");
    browseButton.type = "button";
    browseButton.className = "property-sheet__file-browse-button";
    browseButton.textContent = t("chooseSubcircuitFile");
    browseButton.addEventListener("click", () => {
      if (isSubcircuitRefPath) {
        send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestChooseSubcircuitFile", componentId: component.id });
      } else {
        send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestChooseFile", componentId: component.id, propertyKey: field.key });
      }
    });
    fileGroup.append(pathText, browseButton);
    row.append(caption, fileGroup);
    return row;
  }
  if (field.kind === "boolean") {
    const row = document.createElement("label");
    row.className = "property-sheet__check-row";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = Boolean(field.value);
    input.disabled = field.readonly ?? false;
    input.addEventListener("change", () => {
      applyChange(input.checked);
      const visualFlags = componentVisualFlags(component);
      if (visualFlags.isToggleClickable && field.key === "closed") updateRenderedToggleState(component);
      if (visualFlags.isFixedVolt && field.key === "out") updateRenderedFixedVoltState(component);
    });
    const text = document.createElement("span");
    text.textContent = field.label;
    row.append(input, text);
    return row;
  }

  const row = document.createElement("label");
  row.className = "property-sheet__field-row";
  const caption = document.createElement("span");
  caption.className = "property-sheet__field-label";
  caption.textContent = `${field.label}:`;

  if (field.kind === "select") {
    const select = document.createElement("select");
    select.className = "property-sheet__field-input";
    select.disabled = Boolean(field.readonly);
    for (const option of field.options ?? []) {
      const optionEl = document.createElement("option");
      optionEl.value = option.value;
      optionEl.textContent = option.label;
      optionEl.selected = option.value === String(field.value);
      select.appendChild(optionEl);
    }
    select.addEventListener("change", () => {
      applyChange(typeof field.value === "number" ? Number(select.value) : select.value);
    });
    row.append(caption, select);
    return row;
  }

  if (field.kind === "textarea") {
    const textarea = document.createElement("textarea");
    textarea.className = "property-sheet__field-input property-sheet__field-input--textarea";
    textarea.value = String(field.value);
    textarea.readOnly = Boolean(field.readonly);
    if (!textarea.readOnly) {
      textarea.addEventListener("change", () => applyChange(textarea.value));
    }
    row.append(caption, textarea);
    return row;
  }

  const fieldIsReadonly = field.kind === "readonly" || Boolean(field.readonly);
  if (field.kind === "number" && field.unit && !fieldIsReadonly) {
    // Seletor de múltiplo de unidade (pF/nF/µF/.../k/M/G) -- valor ARMAZENADO sempre em unidade base
    // (sem mudança nenhuma no schema/Core, `applyChange` continua recebendo o número em unidade
    // base); só a EXIBIÇÃO é escalada. Trocar o múltiplo RE-ESCALA o número mostrado mantendo o
    // valor absoluto (mesmo comportamento de `NumVal` real do SimulIDE), não multiplica o valor.
    const baseValue = typeof field.value === "number" ? field.value : Number(field.value) || 0;
    let currentFactor = defaultSiPrefixFactor(baseValue);

    const numberInput = document.createElement("input");
    numberInput.className = "property-sheet__field-input";
    numberInput.type = "number";
    numberInput.step = field.step !== undefined ? String(field.step) : "any";
    numberInput.value = String(baseValue / currentFactor);

    const multiplierSelect = document.createElement("select");
    multiplierSelect.className = "property-sheet__field-unit-select";
    for (const [factor, prefix] of SI_PREFIXES) {
      const optionEl = document.createElement("option");
      optionEl.value = String(factor);
      optionEl.textContent = `${prefix}${field.unit}`;
      optionEl.selected = factor === currentFactor;
      multiplierSelect.appendChild(optionEl);
    }
    multiplierSelect.addEventListener("change", () => {
      const displayed = Number(numberInput.value);
      const base = Number.isFinite(displayed) ? displayed * currentFactor : baseValue;
      currentFactor = Number(multiplierSelect.value);
      numberInput.value = String(base / currentFactor);
    });
    numberInput.addEventListener("change", () => {
      const displayed = Number(numberInput.value);
      applyChange(Number.isFinite(displayed) ? displayed * currentFactor : 0);
    });

    const unitGroup = document.createElement("div");
    unitGroup.className = "property-sheet__unit-group";
    unitGroup.append(numberInput, multiplierSelect);

    // "Mostrar no símbolo" por propriedade -- achado de auditoria de UI 2026-07-09: SimulIDE deixa
    // escolher QUAL propriedade aparece perto do símbolo quando há mais de uma candidata numérica;
    // LasecSimul só permitia a única marcada `showOnSymbol` no catálogo, fixa por typeId. Só faz
    // sentido mostrar o seletor quando há MAIS de 1 candidato -- com só 1, a pergunta "qual" não
    // existe. Rádio, não checkbox: só um rótulo de valor por componente (mesma limitação de sempre).
    const candidates = numericFieldCandidates(component);
    if (candidates.length > 1) {
      const radioLabel = document.createElement("label");
      radioLabel.className = "property-sheet__show-on-symbol";
      radioLabel.title = t("showValue");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = `show-on-symbol-${component.id}`;
      radio.checked = (findShowOnSymbolSchema(component)?.id ?? "") === field.key;
      radio.addEventListener("change", () => {
        component.valueLabelPropertyKey = field.key;
        component.showValue = true;
        send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestUpdateLabelVisibility", componentId: component.id, showId: Boolean(component.showId), showValue: true, valueLabelPropertyKey: field.key });
        persistState();
        render();
      });
      radioLabel.appendChild(radio);
      unitGroup.appendChild(radioLabel);
    }

    row.append(caption, unitGroup);
    return row;
  }

  const input = document.createElement("input");
  input.className = "property-sheet__field-input";
  input.type = field.kind === "number" ? "number" : field.kind === "color" ? "color" : "text";
  input.value = String(field.value);
  input.readOnly = fieldIsReadonly;
  if (field.kind === "number") {
    input.step = field.step !== undefined ? String(field.step) : "any";
    if (field.min !== undefined) input.min = String(field.min);
    if (field.max !== undefined) input.max = String(field.max);
  }
  if (!input.readOnly) {
    input.addEventListener("change", () => {
      const value = field.kind === "number" ? Number(input.value) : input.value;
      applyChange(value);
    });
  }
  row.append(caption, input);
  return row;
}

function componentTypeLabel(component: WebviewComponentModel): string {
  return catalogEntryFor(component.typeId)?.label ?? component.typeId;
}

function renderPropertySheet(component: WebviewComponentModel, options: PropertySheetOptions = {}): HTMLElement {
  const shell = document.createElement("section");
  shell.className = "property-sheet";

  const titleBar = document.createElement("div");
  titleBar.className = "property-sheet__titlebar";
  const uid = document.createElement("div");
  uid.className = "property-sheet__uid";
  uid.textContent = options.titleText ?? `${t("uid")}: ${component.label}`;
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "property-sheet__window-close";
  closeButton.textContent = "x";
  closeButton.addEventListener("click", () => propertyDialog.close());
  titleBar.append(uid, closeButton);

  const toolbar = document.createElement("div");
  toolbar.className = "property-sheet__toolbar";
  const typeText = document.createElement("div");
  typeText.className = "property-sheet__type";
  typeText.textContent = `${t("type")}: ${componentTypeLabel(component)}`;
  const toolbarActions = document.createElement("div");
  toolbarActions.className = "property-sheet__actions";
  const catalogEntry = catalogEntryFor(component.typeId);
  const helpInfo = catalogEntry?.help;
  const helpButton = document.createElement("button");
  helpButton.type = "button";
  helpButton.className = "property-sheet__button";
  helpButton.textContent = t("help");
  helpButton.disabled = !helpInfo;
  // Painel inline expansível (achado de auditoria de UI 2026-07-09, paridade com o painel de ajuda
  // do `PropDialog` real do SimulIDE) -- antes o botão só abria a URL externa direto (sem handler
  // NENHUM se o typeId só tinha `help.description`, sem `help.url` -- botão habilitado mas morto,
  // achado de brinde corrigido aqui). `help.file` (Markdown local) continua fora de escopo -- exige
  // I/O de arquivo (Webview não tem `fs`) e um parser Markdown->HTML sanitizado, feature maior
  // separada; `help.description` já é texto simples, seguro de mostrar via `textContent` puro.
  const helpPanel = document.createElement("div");
  helpPanel.className = "property-sheet__help-panel";
  helpPanel.hidden = true;
  if (helpInfo?.description) {
    const helpText = document.createElement("p");
    helpText.textContent = helpInfo.description;
    helpPanel.appendChild(helpText);
  }
  if (helpInfo?.url) {
    const helpLink = document.createElement("button");
    helpLink.type = "button";
    helpLink.className = "property-sheet__help-link";
    helpLink.textContent = helpInfo.url;
    helpLink.addEventListener("click", () => {
      send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestOpenExternal", url: helpInfo.url! });
    });
    helpPanel.appendChild(helpLink);
  }
  helpButton.addEventListener("click", () => {
    helpPanel.hidden = !helpPanel.hidden;
  });
  const showLabel = document.createElement("label");
  showLabel.className = "property-sheet__show-toggle";
  const showText = document.createElement("span");
  showText.textContent = t("show");
  const showCheckbox = document.createElement("input");
  showCheckbox.type = "checkbox";
  showCheckbox.checked = Boolean(component.showId);
  showCheckbox.addEventListener("change", () => {
    component.showId = showCheckbox.checked;
    const showValue = component.showValue ?? Boolean(findShowOnSymbolSchema(component));
    send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestUpdateLabelVisibility", componentId: component.id, showId: component.showId, showValue });
    persistState();
    render();
    refreshOpenPropertyDialog();
  });
  showLabel.append(showText, showCheckbox);
  toolbarActions.append(helpButton);
  if (options.showVisibilityToggle !== false) toolbarActions.append(showLabel);
  toolbar.append(typeText, toolbarActions);

  let titleRow: HTMLElement | undefined;
  if (options.allowTitleEdit !== false) {
    titleRow = document.createElement("label");
    titleRow.className = "property-sheet__title-row";
    const titleCaption = document.createElement("span");
    titleCaption.textContent = t("title");
    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.value = component.label;
    titleInput.addEventListener("change", () => {
      component.label = titleInput.value.trim() || component.label;
      send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestRenameComponent", componentId: component.id, label: component.label });
      persistState();
      render();
      refreshOpenPropertyDialog();
    });
    titleRow.append(titleCaption, titleInput);
  }

  const usesSchema = Boolean(catalogEntryFor(component.typeId)?.propertySchema?.length);
  const groups = groupFields(resolvePropertyFields(component));
  // Schema-driven: ordem das abas = ordem de primeira aparição do grupo no schema (Map preserva
  // ordem de inserção) -- nunca prefixado por "Principal", que só faz sentido como fallback da
  // heurística antiga (quando NENHUM grupo real foi declarado).
  const orderedGroupNames = usesSchema ? [...groups.keys()] : [...new Set([t("principal"), ...groups.keys()])];
  const tabs = document.createElement("div");
  tabs.className = "property-sheet__tabs";
  const pages = document.createElement("div");
  pages.className = "property-sheet__pages";
  let activeTab = orderedGroupNames.find((name) => groups.get(name)?.length) ?? t("principal");

  const renderPage = (): void => {
    tabs.innerHTML = "";
    pages.innerHTML = "";

    for (const groupName of orderedGroupNames) {
      const fields = groups.get(groupName) ?? [];
      if (fields.length === 0 && !propertyDialogShowAll) continue;
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = `property-sheet__tab${groupName === activeTab ? " property-sheet__tab--active" : ""}`;
      tab.textContent = groupName;
      tab.addEventListener("click", () => {
        activeTab = groupName;
        renderPage();
      });
      tabs.appendChild(tab);
    }

    const fieldset = document.createElement("fieldset");
    fieldset.className = "property-sheet__group";
    const fields = groups.get(activeTab) ?? [];
    if (fields.length === 0) {
      const empty = document.createElement("p");
      empty.className = "property-sheet__empty";
      empty.textContent = t("noProperties");
      fieldset.appendChild(empty);
    } else {
      for (const field of fields) fieldset.appendChild(renderPropertyField(component, field, options));
    }
    pages.appendChild(fieldset);
  };

  renderPage();
  shell.append(titleBar, toolbar, helpPanel);
  if (titleRow) shell.append(titleRow);
  shell.append(tabs, pages);
  return shell;
}

window.addEventListener("message", (event: MessageEvent<HostToWebviewMessage>) => {
  const message = event.data;
  if (!message || message.version !== WEBVIEW_MESSAGE_VERSION) return;

  if (message.type === "init" || message.type === "syncState") {
    // `syncState` é como o Host confirma mutações que NUNCA passam por `state` local antes (ex:
    // `deleteSelectedItems` só manda `requestRemoveComponent`/`Wire` -- sem este registro aqui,
    // apagar um componente/fio no circuito principal nunca viraria undoable). `"init"` (1ª carga)
    // nunca deveria virar uma entrada de undo -- reseta o histórico pro estado recém-carregado em
    // vez de registrar transição.
    if (message.type === "syncState") {
      recordUndoTransition(undoContentKey(message.project), () => snapshotOfProjectState(message.project));
    }
    state = message.project;
    restoreBoardViewAfterHostSync();
    syncPackageRegistry(state.catalog);
    if (!state.pendingConnection) {
      pendingWirePreviewTarget = undefined;
      pendingWireRoute = [];
      pendingWireBendLengths = [];
    }
    if (message.type === "init") resetUndoHistory(mainUndoHistory);
    vscode?.setState(state);
    render();
    refreshOpenPropertyDialog();
  }

  // PC-1/EX-7: versão incremental de "syncState" -- `patch` só tem os campos de `WebviewProjectState`
  // que mudaram desde o último sync (ver `extension.ts::computeProjectStatePatch`), nunca substitui
  // `state` por inteiro (campo ausente == sem mudança, não "esvaziar"). Mesmo pós-processamento do
  // handler de "syncState" acima, exceto `resetUndoHistory` (nunca é um "1º load") -- COM UMA
  // EXCEÇÃO, ver `enteringOrLeavingSubcircuitSession` abaixo. `syncPackageRegistry` só roda quando
  // `catalog` de fato veio no patch -- reduz ainda mais o retrabalho quando só posição/propriedade de
  // componente mudou.
  if (message.type === "syncStatePatch") {
    // `pendingConnection: null` é o sentinela de "limpar" (ver `extension.ts::computeProjectStatePatch`
    // -- `undefined` não sobrevive a um JSON.stringify, a chave some sem deixar rastro) -- convertido
    // de volta pra `undefined` aqui, único jeito de `WebviewProjectState` continuar tipado certo.
    const merged: WebviewProjectState = {
      ...state,
      ...message.patch,
      pendingConnection: message.patch.pendingConnection === null ? undefined : message.patch.pendingConnection ?? state.pendingConnection,
      subcircuitEditingContext: message.patch.subcircuitEditingContext === null ? undefined : message.patch.subcircuitEditingContext ?? state.subcircuitEditingContext,
    };
    // `openSubcircuitForEditingCommand`/`closeSubcircuitEditorCommand` (`extension.ts`) trocam
    // `components`/`wires` por um circuito INTERNO completamente diferente via `syncStatePatch` (não
    // `"init"`, que é só pra 1ª carga do painel) -- sem este caso especial, `recordUndoTransition`
    // empilharia essa troca de contexto como se fosse uma edição normal, e um Ctrl+Z dentro da sessão
    // pularia de volta pro circuito de FORA (mesma pilha única, ver seção 17.3 do spec) com
    // `subcircuitEditingContext` ainda apontando pra dentro -- tela mostrando um circuito, faixa
    // dizendo outro, e o próximo "Voltar ao Circuito Principal" salvaria o conteúdo ERRADO no
    // arquivo. `"subcircuitEditingContext" in message.patch` (chave presente, não o valor) cobre
    // tanto entrar (objeto) quanto sair (sentinela `null`) -- reseta o histórico em vez de registrar
    // transição, mesmo tratamento de `"init"`.
    const enteringOrLeavingSubcircuitSession = "subcircuitEditingContext" in message.patch;
    if (!enteringOrLeavingSubcircuitSession) recordUndoTransition(undoContentKey(merged), () => snapshotOfProjectState(merged));
    state = merged;
    restoreBoardViewAfterHostSync();
    if (enteringOrLeavingSubcircuitSession) resetUndoHistory(mainUndoHistory);
    if (message.patch.catalog) syncPackageRegistry(state.catalog);
    if (!state.pendingConnection) {
      pendingWirePreviewTarget = undefined;
      pendingWireRoute = [];
      pendingWireBendLengths = [];
    }
    vscode?.setState(state);
    render();
    refreshOpenPropertyDialog();
  }

  if (message.type === "beginComponentPlacement") {
    enterPlacementMode(message.typeId);
  }

  if (message.type === "selectComponent") {
    state.selectedComponentIds = message.componentId ? [message.componentId] : [];
    state.selectedWireIds = [];
    render();
  }

  if (message.type === "componentReadout") {
    readoutsByComponentId = message.readoutsByComponentId;
    updateReadoutHistories(message.readoutsByComponentId);
    // `render()` reconstrói o DOM inteiro -- chamado SEM CONDIÇÃO a cada poll de telemetria (~300ms
    // durante a simulação) destruiria um arrasto em andamento (ver doc de
    // `isInteractiveGestureInProgress`). Os dados (`readoutsByComponentId`) já ficaram atualizados
    // acima; só a TELA fica momentaneamente atrasada até o usuário soltar o mouse (que já atualiza).
    if (!isInteractiveGestureInProgress()) {
      // Só typeIds com `usesEmbeddedValueLabel` desenham a leitura DENTRO do próprio SVG do símbolo
      // (mostrador do voltímetro/amperímetro/frequencímetro/osciloscópio/analisador lógico, ver
      // `symbolReadoutNumber`/`symbolReadoutArray` em componentSymbols.ts) -- só esses exigem
      // reconstruir o SVG inteiro a cada tick. Qualquer outro componente com leitura ao vivo usa só o
      // rótulo de valor FORA do SVG (`refreshReadouts`, texto simples), bem mais barato que um
      // `render()` completo do canvas -- sem isto, `refreshReadouts` nunca era chamado (função morta).
      const needsFullRender = state.components.some((component) => usesEmbeddedValueLabel(component.typeId));
      if (needsFullRender) render();
      else refreshReadouts();
    }
    refreshOpenPropertyDialog();
  }

  if (message.type === "instrumentHistory") {
    if (message.oscope) realScopeHistoryByComponentId.set(message.componentId, message.oscope.channels);
    if (message.logic) realLogicHistoryByComponentId.set(message.componentId, message.logic);
    renderInstrumentPopups();
  }

  if (message.type === "boardOverlayData") {
    boardOverlayDataByComponentId.set(message.componentId, message.items);
    if (!isInteractiveGestureInProgress()) render();
  }

  if (message.type === "wireVoltages") {
    voltagesByWireId = message.voltagesByWireId;
    if (!isInteractiveGestureInProgress()) render();
  }

  if (message.type === "simulationStatus") {
    simulationStatus = message.status;
    if (message.status === "stopped") {
      readoutsByComponentId = {};
      scopeHistoryByComponentId = {};
      logicHistoryByComponentId = {};
      simulationRate = undefined;
    }
    render();
    refreshOpenPropertyDialog();
  }

  if (message.type === "simulationRate") {
    simulationRate = message.rate;
    updateSimulationRateLabel();
  }

  if (message.type === "requestRotateSelection") {
    rotateSelectedComponents(message.direction === "cw" ? 1 : -1);
  }

  if (message.type === "requestFlipSelection") {
    flipSelectedComponents(message.axis);
  }

  if (message.type === "requestUndo") {
    undo();
  }

  if (message.type === "requestRedo") {
    redo();
  }

  if (message.type === "triggerCreateSubcircuitFromSelection") {
    if (state.selectedComponentIds.length > 1) {
      send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestCreateSubcircuitFromSelection", componentIds: state.selectedComponentIds });
    }
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Mesmo algoritmo de `extension.ts::nextIndexedLabel` (duplicado de propósito — são dois pontos de
 * criação de componente independentes, ver `.spec`/plano aprovado). Contador por `typeId`, nunca
 * persistido separado: sempre recalculado a partir de quem já existe em `state.components`. */
function nextIndexedLabel(typeId: string, baseLabel: string, components: WebviewComponentModel[] = state.components): string {
  const pattern = new RegExp(`^${escapeRegExp(baseLabel)}-(\\d+)$`);
  let maxIndex = 0;
  for (const component of components) {
    if (component.typeId !== typeId) continue;
    const match = pattern.exec(component.label);
    if (match) maxIndex = Math.max(maxIndex, Number(match[1]));
  }
  return `${baseLabel}-${maxIndex + 1}`;
}

/** Entra no modo de posicionamento de componente. A posição de rótulos de pinos do package vem do
 * próprio manifesto (`labelX`/`labelY`) e não é editada pelo esquemático. */
function enterPlacementMode(typeId: string): void {
  // Cancela qualquer derivação de fio em andamento primeiro -- as duas ferramentas nunca ficam
  // ativas ao mesmo tempo (ver `cancelActiveTool`). Sem isto, colocar um componente novo enquanto um
  // fio está em desenho deixava o preview/pino de origem pendurados na tela.
  if (state.pendingConnection) clearPendingWire();
  placingTypeId = typeId;
  if (!placementGhostEl) {
    placementGhostEl = document.createElement("div");
    placementGhostEl.className = "placement-ghost";
    document.body.appendChild(placementGhostEl);
  }
  const descriptor = catalogEntryFor(typeId);
  placementGhostEl.textContent = descriptor?.label ?? typeId;
  placementGhostEl.classList.add("visible");
  document.body.style.cursor = "crosshair";
}

function exitPlacementMode(): void {
  placingTypeId = null;
  placementGhostEl?.classList.remove("visible");
  document.body.style.cursor = "";
}

function componentsToAddForTypeId(typeId: string): WebviewComponentModel[] {
  const component = makeComponentFromTypeId(typeId);
  if (typeId !== "other.package_pin") return [component];

  const box = componentBox(component.typeId, component.properties);
  const anchorX = component.x + box.width / 2;
  const anchorY = component.y + box.height / 2;
  const length = typeof component.properties.length === "number" ? component.properties.length : 8;
  const rad = (component.rotation * Math.PI) / 180;
  const labelX = anchorX + Math.cos(rad) * (length + 9);
  const labelY = anchorY + Math.sin(rad) * (length + 9);
  const pinId = typeof component.properties.pinId === "string" ? component.properties.pinId : component.id;
  const labelBox = componentBox("graphics.text", { text: pinId, fontSize: 7 });
  const label: WebviewComponentModel = {
    id: `component-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}-label`,
    typeId: "graphics.text",
    label: "graphics.text",
    hidden: false,
    x: Math.round(labelX - labelBox.width / 2),
    y: Math.round(labelY - labelBox.height / 2),
    rotation: 0,
    pins: [],
    properties: { text: pinId, fontSize: 7, color: "#1f2937", linkedPinComponentId: component.id },
  };
  return [component, label];
}

function makeComponentFromTypeId(typeId: string): WebviewComponentModel {
  const descriptor = catalogEntryFor(typeId);
  const componentIndex = state.components.length;
  const pinCount = descriptor?.pinCount ?? 2;
  const baseLabel = descriptor?.label ?? typeId;
  // `pinIds` (quando presente) é o id elétrico REAL de cada pino, casando por `id` com
  // `package.pins[]` em `pinLocalPosition` -- sem isso, o terminal de fio cai no algoritmo
  // genérico (esquerda/direita por índice), nunca na posição real desenhada do `package`. Ver
  // `model.ts::WebviewComponentCatalogEntry.pinIds`.
  const pins = descriptor?.pinIds && descriptor.pinIds.length === pinCount
    ? descriptor.pinIds.map((id, index) => ({ id, x: 0, y: index * 12 }))
    : Array.from({ length: pinCount }, (_, index) => ({ id: `pin-${index + 1}`, x: 0, y: index * 12 }));
  return {
    id: `component-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`,
    typeId,
    label: nextIndexedLabel(typeId, baseLabel),
    hidden: descriptor?.hidden ?? false,
    showValue: usesEmbeddedValueLabel(typeId) ? false : Boolean(descriptor?.propertySchema?.some((schema) => schema.showOnSymbol)),
    x: 140 + componentIndex * 24,
    y: 140 + componentIndex * 24,
    rotation: 0,
    pins,
    properties: { ...(descriptor?.defaultProperties ?? {}) },
  };
}

/** Atualiza só o texto do rótulo de valor (telemetria ao vivo, ex: leitura do voltímetro) sem
 * re-renderizar o componente inteiro — chamado a cada tick de `componentReadout` (alta frequência
 * enquanto a simulação roda); um re-render completo a cada tick seria desnecessariamente caro. */
function refreshReadouts(): void {
  for (const component of state.components) {
    const el = document.querySelector<HTMLElement>(`.component[data-component-id="${component.id}"]`);
    if (!el) continue;
    const existing = el.querySelector<HTMLElement>(".component__value-label");

    const text = externalLabelText(component, "value");
    if (text === undefined) {
      existing?.remove();
      continue;
    }

    const valueLabelEl = existing ?? document.createElement("div");
    valueLabelEl.className = "component__value-label";
    valueLabelEl.textContent = text;
    if (!existing) el.appendChild(valueLabelEl);
  }
}

function pushShortcutKey(component: WebviewComponentModel): string | undefined {
  if (component.typeId !== "switches.push") return undefined;
  const raw = component.properties.key;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

/** Repintura imediata (antes do `render()` de fim de gesto) pro feedback visual de apertar/soltar --
 * o estado aberto/fechado agora vem de `stateVisible`/`stateFill` no `package.simulidePaint` (não de
 * uma classe CSS alternada), então só um `classList.toggle` não muda mais QUAL primitiva aparece;
 * precisa reconstruir o SVG de verdade via `updateComponentElement`, a mesma função usada em todo
 * `render()`. Cobre push, switch E switch_dip (interactionKind "toggle" genérico). */
function updateRenderedToggleState(component: WebviewComponentModel): void {
  const el = document.querySelector<HTMLElement>(`.component[data-component-id="${component.id}"]`);
  if (el) updateComponentElement(el, component);
}

function updateRenderedFixedVoltState(component: WebviewComponentModel): void {
  const elements = document.querySelectorAll(".component");
  for (let index = 0; index < elements.length; index += 1) {
    const el = elements.item(index) as HTMLElement;
    if (el.dataset.componentId !== component.id) continue;
    const svg = el.querySelector(".component__symbol--fixed-volt") as SVGSVGElement | null;
    svg?.classList.toggle("component__symbol--fixed-volt-on", component.properties.out === true);
    return;
  }
}

function setPushClosed(component: WebviewComponentModel, closed: boolean): void {
  if (component.properties.closed === closed) return;
  component.properties.closed = closed;
  send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestUpdateProperty", componentId: component.id, name: "closed", value: closed });
  vscode?.setState(state);
  updateRenderedToggleState(component);
  refreshOpenPropertyDialog();
}

function setSwitchClosed(component: WebviewComponentModel, closed: boolean): void {
  if (component.properties.closed === closed) return;
  component.properties.closed = closed;
  send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestUpdateProperty", componentId: component.id, name: "closed", value: closed });
  vscode?.setState(state);
  updateRenderedToggleState(component);
  refreshOpenPropertyDialog();
}

function setFixedVoltOut(component: WebviewComponentModel, out: boolean): void {
  if (component.properties.out === out) return;
  component.properties.out = out;
  send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestUpdateProperty", componentId: component.id, name: "out", value: out });
  vscode?.setState(state);
  updateRenderedFixedVoltState(component);
  refreshOpenPropertyDialog();
}

function handlePushShortcut(event: KeyboardEvent, closed: boolean): boolean {
  const key = event.key.toLowerCase();
  let handled = false;
  for (const component of state.components) {
    if (pushShortcutKey(component) !== key) continue;
    if (closed) activePushShortcutIds.add(component.id);
    else if (!activePushShortcutIds.delete(component.id)) continue;
    setPushClosed(component, closed);
    handled = true;
  }
  return handled;
}

/** Junção (nó de topologia com 3+ fios) como elemento SVG interativo -- antes um `<div>` puramente
 * decorativo (`pointer-events:none`), impossível de clicar ou arrastar: não dava pra conectar um 4º
 * fio a uma junção existente (só por acidente via a borda de um segmento adjacente, quando dava
 * certo) nem mover a própria junção. `<g>` com dois círculos: um alvo de clique maior e invisível
 * (`r=8`, mesmo princípio de pino/canto -- "alvo de clique maior que a marca visual", ver
 * `docs/prompt_mestre_editor_esquematico_vscode.md` seção 9.2) e o marcador pequeno visível por
 * cima (`r=2.5`, tamanho fiel ao SimulIDE -- ver CSS). Clique passa pelo MESMO
 * `handleWireGestureClick` de pino/segmento/canto (`kind:"wire"`, usando qualquer fio que já toca a
 * junção -- `splitSegmentAtPoint`/`findExistingJunctionAt` reconhecem que o ponto já É a extremidade
 * daquele fio e resolvem pra este MESMO nó em vez de dividir, sem precisar de um `kind:"junction"`
 * separado no protocolo). Arrasto move `node.position` direto (mais simples que arrasto de
 * canto/segmento: não há `moveOrthogonalWireCorner` -- os fios tocando o nó se re-roteiam sozinhos,
 * `wirePolylinePoints`/`buildOrthogonalPath` já resolvem a posição do nó dinamicamente a cada
 * chamada, igual a mover um componente). */
function renderJunction(id: string, x: number, y: number): SVGGElement {
  const group = document.createElementNS(SVG_NS, "g");
  group.dataset.wireId = id; // reaproveita a mesma convenção de `dataset.wireId` pra limpeza incremental (ver `updateWireVisual`)
  group.setAttribute("class", "wire-layer__junction");

  const hitTarget = document.createElementNS(SVG_NS, "circle");
  hitTarget.setAttribute("cx", String(x));
  hitTarget.setAttribute("cy", String(y));
  hitTarget.setAttribute("r", "8");
  hitTarget.setAttribute("class", "wire-layer__junction-hit");
  group.appendChild(hitTarget);

  const dot = document.createElementNS(SVG_NS, "circle");
  dot.setAttribute("cx", String(x));
  dot.setAttribute("cy", String(y));
  dot.setAttribute("r", "2.5");
  dot.setAttribute("class", "wire-layer__junction-dot");
  group.appendChild(dot);

  const anyTouchingWireId = (): string | undefined => wiresByComponentId().get(id)?.[0]?.id;

  group.addEventListener("click", (event) => {
    event.stopPropagation();
    const wireId = anyTouchingWireId();
    if (!wireId) return; // nó sem fio de verdade não deveria existir (ver removeOrphanNodes), defensivo
    handleWireGestureClick({ kind: "wire", wireId, point: { x, y } });
  });

  group.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const touching = wiresByComponentId().get(id) ?? [];
    if (touching.length === 0) return;
    state.selectedComponentIds = [];
    state.selectedWireIds = touching.map((wire) => wire.id);
    selectedWireSegment = undefined;
    selectedWireCorner = undefined;
    persistState();
    render();
    showContextMenu(event, [{ label: t("deleteSelectedItems"), onClick: () => deleteSelectedItems() }]);
  });

  group.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || state.pendingConnection || event.shiftKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    event.stopPropagation();

    const canvasEl = group.closest<HTMLElement>(".canvas");
    if (!canvasEl) return;

    const node = state.topology.nodes.find((entry) => entry.id === id);
    if (!node) return;
    const startX = node.position.x;
    const startY = node.position.y;
    let moved = false;

    const groupComponentTargets = dragSelectionWithLinkedPinLabels().map((selected) => ({
      component: selected,
      startX: selected.x,
      startY: selected.y,
    }));
    const groupWireMoveTargets = computeGroupMoveWireTargets(undefined, id);
    const groupStartClientX = event.clientX;
    const groupStartClientY = event.clientY;

    const onMove = (moveEvent: PointerEvent): void => {
      const raw = eventToCanvasPoint(moveEvent, canvasEl);
      const step = moveEvent.shiftKey ? FINE_WIRE_STEP : WIRE_GRID_SIZE;
      node.position = { x: snapCoordinate(raw.x, step), y: snapCoordinate(raw.y, step) };
      moved = true;
      // `updateWiresTouchingComponent` só redesenha os FIOS tocando o nó -- a própria marca visual da
      // junção (este `<g>`) não é um fio, precisa ser movida à parte (senão o nó "salta" de volta pra
      // posição antiga no próximo render(), com os fios já mostrando a posição nova nesse meio-tempo).
      hitTarget.setAttribute("cx", String(node.position.x));
      hitTarget.setAttribute("cy", String(node.position.y));
      dot.setAttribute("cx", String(node.position.x));
      dot.setAttribute("cy", String(node.position.y));
      updateWiresTouchingComponent(id);

      const zoom = state.viewport.zoom || 1;
      applyGroupTagAlongDelta(
        groupComponentTargets,
        groupWireMoveTargets,
        (moveEvent.clientX - groupStartClientX) / zoom,
        (moveEvent.clientY - groupStartClientY) / zoom
      );
    };

    startWireDragListeners(onMove, () => {
      if (moved) {
        persistState();
        suppressNextWireInteractionClick = true;
      } else {
        node.position = { x: startX, y: startY }; // sem movimento real -- nunca deixa arredondamento residual
      }
    });
  });

  return group;
}

function renderExternalLabel(component: WebviewComponentModel, kind: ExternalLabelKind): HTMLElement | undefined {
  const text = externalLabelText(component, kind);
  if (!text) return undefined;
  const el = document.createElement("div");
  const offset = externalLabelOffset(component, kind);
  const rotation = externalLabelRotation(component, kind);
  el.className = `component-floating-label component-floating-label--${kind}${isTextLabelSelected(component.id, kind) ? " selected" : ""}`;
  el.textContent = text;
  el.style.left = `${component.x + offset.x}px`;
  el.style.top = `${component.y + offset.y}px`;
  el.style.transform = rotation === 0 ? "" : `rotate(${rotation}deg)`;
  el.dataset.componentId = component.id;
  el.dataset.labelKind = kind;

  el.addEventListener("click", (event) => {
    event.stopPropagation();
    selectOnlyTextLabel(component.id, kind);
    persistState();
    render();
  });

  el.addEventListener("contextmenu", (event) => {
    // NUNCA stopPropagation() -- ver comentário equivalente no handler de componente.
    event.preventDefault();
    selectOnlyTextLabel(component.id, kind);
    persistState();
    render();
    showContextMenu(event, [
      { label: t("rotateCw"), icon: "rotateCw", shortcut: "Ctrl+R", onClick: () => rotateSelectedTextLabel(1) },
      { label: t("rotateCcw"), icon: "rotateCcw", shortcut: "Ctrl+Shift+R", onClick: () => rotateSelectedTextLabel(-1) },
      { label: t("rotate180"), icon: "rotate180", onClick: () => rotateSelectedTextLabel(2) },
    ]);
  });

  let dragStartX = 0;
  let dragStartY = 0;
  let startOffset = offset;
  el.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    selectOnlyTextLabel(component.id, kind);
    dragStartX = event.clientX;
    dragStartY = event.clientY;
    startOffset = externalLabelOffset(component, kind);
    el.setPointerCapture(event.pointerId);
    isDraggingComponent = true;

    const onMove = (moveEvent: PointerEvent): void => {
      const zoom = state.viewport.zoom || 1;
      const dx = (moveEvent.clientX - dragStartX) / zoom;
      const dy = (moveEvent.clientY - dragStartY) / zoom;
      el.style.left = `${component.x + startOffset.x + dx}px`;
      el.style.top = `${component.y + startOffset.y + dy}px`;
    };

    const onUp = (upEvent: PointerEvent): void => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      isDraggingComponent = false;
      const zoom = state.viewport.zoom || 1;
      const dx = (upEvent.clientX - dragStartX) / zoom;
      const dy = (upEvent.clientY - dragStartY) / zoom;
      setExternalLabelLayout(component, kind, { x: startOffset.x + dx, y: startOffset.y + dy });
      persistState();
      render();
    };

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp, { once: true });
    el.addEventListener("pointercancel", onUp, { once: true });
  });

  return el;
}

/** Seleciona todo componente/fio não oculto (`Ctrl+A`, `circuit.cpp::keyPressEvent` do SimulIDE). */
function selectAll(): void {
  state.selectedComponentIds = state.components.filter((component) => !component.hidden).map((component) => component.id);
  state.selectedWireIds = state.topology.conductors.map((wire) => wire.id);
  persistState();
  render();
}

window.addEventListener("keydown", (event) => {
  if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) {
    return;
  }
  const ctrl = event.ctrlKey || event.metaKey; // metaKey: paridade com Mac (Cmd em vez de Ctrl)

  // Ctrl+R/Ctrl+Shift+R NÃO são tratados aqui de propósito -- o VSCode intercepta esses dois antes
  // de chegarem na Webview (Ctrl+R nativo é "Abrir recente"), então a sobreposição é feita por
  // `contributes.keybindings` (when: activeWebviewPanelId == 'lasecsimul.schematic') + comando que
  // manda `requestRotateSelection` (ver handler de mensagem abaixo e `.spec` seção 13.4) -- tratar
  // aqui TAMBÉM rotacionaria em dobro nos casos em que o evento ainda chega na Webview.

  if (ctrl && event.key.toLowerCase() === "a") {
    event.preventDefault();
    selectAll();
    return;
  }

  if (ctrl && event.key.toLowerCase() === "c") {
    event.preventDefault();
    copySelectedItems();
    return;
  }

  if (ctrl && event.key.toLowerCase() === "x") {
    event.preventDefault();
    cutSelectedItems();
    return;
  }

  if (ctrl && event.key.toLowerCase() === "v") {
    event.preventDefault();
    pasteClipboardItems();
    return;
  }

  if (ctrl && event.key.toLowerCase() === "l") {
    event.preventDefault();
    flipSelectedComponents(event.shiftKey ? "vertical" : "horizontal");
    return;
  }

  if (event.key === "Delete" || event.key === "Backspace") {
    if (state.selectedWireIds.length > 0 || state.selectedComponentIds.length > 0) {
      deleteSelectedItems();
    }
    return;
  }

  if (event.key.startsWith("Arrow")) {
    const step = event.shiftKey ? FINE_WIRE_STEP : WIRE_GRID_SIZE;
    if (moveSelectedWireCornerByArrow(event.key, step)) {
      event.preventDefault();
      return;
    }
    if (moveSelectedWireSegmentByArrow(event.key, step)) {
      event.preventDefault();
      return;
    }
    if (moveSelectedComponentsByArrow(event.key, step)) {
      event.preventDefault();
      return;
    }
  }

  if ((event.key === "Enter" || event.key.toLowerCase() === "p") && getSelectedComponent()) {
    openSelectedProperties();
    return;
  }

  if (!ctrl && !event.altKey && !event.repeat && handlePushShortcut(event, true)) {
    event.preventDefault();
    return;
  }

  // Atalho solto `r` (sem Ctrl) -- herdado de quando a seleção era singular, rotaciona só o
  // primeiro componente selecionado (não o grupo inteiro -- isso é o que `Ctrl+R` faz agora).
  if (!ctrl && event.key.toLowerCase() === "r" && getSelectedComponent()) {
    rotateComponent(getSelectedComponent()!);
    return;
  }

  if (event.key === "Escape") {
    hideContextMenu();
    // As duas ferramentas nunca coexistem (ver `cancelActiveTool`), mas um único Esc cancela
    // qualquer uma que esteja ativa -- sem `return` antecipado que pule a outra checagem (bug real
    // corrigido: entrar em posicionamento de componente durante um draft de fio exigia DOIS Esc pra
    // limpar tudo, ver `docs/27-analise-critica-fios-vs-auditoria-2026-07-11.md`, seção "FSM").
    const hadActiveTool = placingTypeId !== null || state.pendingConnection !== undefined;
    cancelActiveTool();
    if (hadActiveTool) {
      persistState();
      render();
    }
  }
});

window.addEventListener("keyup", (event) => {
  if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) {
    return;
  }
  if (handlePushShortcut(event, false)) event.preventDefault();
});

render();
send({ version: WEBVIEW_MESSAGE_VERSION, type: "webviewReady" });
