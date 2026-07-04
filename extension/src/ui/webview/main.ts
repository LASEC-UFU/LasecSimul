import { WEBVIEW_MESSAGE_VERSION, ComponentReadoutValue, HostToWebviewMessage, InternalComponentSnapshot, SimulationStatus, SymbolAuthoringKind, WebviewToHostMessage } from "./messages.js";
import { PropertySchemaEntry, WebviewComponentModel, WebviewProjectState, WebviewWireModel } from "./model.js";
import { ComponentBox, PIN_RADIUS, componentBox, componentSymbolSvg, hasRealPinPosition, packageSymbolSvg, pinLocalPosition, registerPackage } from "./componentSymbols.js";
import { detectChannelTrigger, findTriggerAnchorIndex, triggerAlignedWindowEndNs, visibleSampleWindowByTime } from "./instrumentTrigger.js";
import {
  Point,
  WIRE_GRID_SIZE,
  appendPoint,
  buildOrthogonalPath,
  normalizeOrthogonalPath,
  orthogonalSegmentPoints,
  samePoint,
  snapCoordinate,
  snapToWireGrid,
} from "./wireGeometry.js";
import { formatEngineeringValue } from "./valueFormatting.js";

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
    wires: [],
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

/** Reconciliação incremental da camada de COMPONENTES (a mais cara/mais re-renderizada da Webview) --
 * `render()` (mais abaixo) cria/atualiza/remove só o que mudou em vez de `app.innerHTML = ""` +
 * reconstrução total, que antes recriava TODO `.component` (com seu `<svg>` e listeners) a cada
 * poll de telemetria (~300ms durante simulação). `canvas`/`canvasContent`/camada de fios/labels
 * continuam recriados a cada `render()` nesta rodada (custo bem menor, documentado como próximo
 * passo natural em `.spec/lasecsimul-native-devices.spec` com o mesmo padrão) -- mover um
 * `.component` pra um `canvasContent` novo via `appendChild` NÃO derruba seus listeners (pertencem
 * ao elemento, não ao pai), e `render()` nunca roda durante um arrasto ativo (`isDraggingComponent`),
 * então não há risco de perder `setPointerCapture()` em trânsito. */
const componentElementsById = new Map<string, HTMLElement>();

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
    editSymbol: "Editar Símbolo Visual",
    openSubcircuit: "Abrir Subcircuito",
    loadFirmware: "Carregar firmware",
    reloadFirmware: "Recarregar firmware",
    openSerialMonitor: "Abrir monitor serial",
    firmwareGroup: "Firmware",
    firmwarePath: "Firmware (.bin/.elf)",
    qemuBinary: "Binario QEMU",
    loadPackage: "Carregar pacote",
    savePackage: "Salvar pacote",
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
    editSymbol: "Edit Visual Symbol",
    openSubcircuit: "Open Subcircuit",
    loadFirmware: "Load firmware",
    reloadFirmware: "Reload firmware",
    openSerialMonitor: "Open serial monitor",
    firmwareGroup: "Firmware",
    firmwarePath: "Firmware (.bin/.elf)",
    qemuBinary: "QEMU binary",
    loadPackage: "Load Package",
    savePackage: "Save Package",
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
let simulationStatus: SimulationStatus = "stopped";
let activePropertyTarget:
  | { kind: "project"; componentId: string }
  | { kind: "exposed-internal"; outerComponentId: string; sourceId: string; snapshot: InternalComponentSnapshot; model: WebviewComponentModel }
  | undefined;
let propertyDialogShowAll = false;
let clipboardItems: { components: WebviewComponentModel[]; wires: WebviewWireModel[] } | undefined;
const activePushShortcutIds = new Set<string>();
/** `true` durante QUALQUER gesto de arrastar componente em andamento (mouse ainda pressionado) --
 * `render()` reconstrói `app.innerHTML` inteiro (ver função `render`), o que destrói o elemento
 * `el` que tem `setPointerCapture()`/os listeners `pointermove`/`pointerup` do arrasto em curso.
 * Como `componentReadout`/`wireVoltages` chegam a cada ~300ms DURANTE a simulação e cada um chama
 * `render()` sem condição, um arrasto em andamento durante a simulação era interrompido a cada
 * poll -- o usuário só conseguia mover um pedacinho por vez, "soltar e começar de novo" a cada
 * ~300ms (bug relatado 2026-06-30). Enquanto isto for `true`, esses dois handlers pulam o
 * `render()` (ainda atualizam os dados em cache -- a tela só fica "atrasada" até o solte do mouse,
 * que já chama `render()` no fim do gesto). */
let isDraggingComponent = false;
type ExternalLabelKind = "id" | "value";
let selectedTextLabel: { componentId: string; kind: ExternalLabelKind } | undefined;

// Modo de posicionamento de componente (SimulIDE-style: clicar na paleta → mover → clicar no canvas).
let placingTypeId: string | null = null;
let placementGhostEl: HTMLElement | null = null;

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

/** Sessão de "autoria de símbolo" ativa (Épico G, parte de escrita) -- ver `enterSymbolAuthoring`.
 * `realCircuitState` guarda o `state` de verdade (circuito do usuário, se houver algum aberto)
 * enquanto a sessão de autoria usa a MESMA variável `state`/render()/drag/painel de propriedades de
 * sempre -- nenhum desses precisa saber que "isto não é bem o circuito real" (mesmo princípio do
 * SimulIDE: `SubPackage`/`Rectangle`/`PackagePin` são `Component`s comuns, não exigem um modo
 * especial de canvas/drag/seleção, ver auditoria em `.spec/lasecsimul-native-devices.spec`
 * seção 21.3). */
let realCircuitState: WebviewProjectState | undefined;
let symbolAuthoringContext: { filePath: string; typeId: string; kind: SymbolAuthoringKind; view: "default" | "logicSymbol" } | undefined;
/** Modo Placa (igual ao SimulIDE real, `SubPackage::boardModeSlot()`) -- só faz sentido pra
 * `kind === "subcircuit-file"` (só subcircuito tem circuito interno pra organizar espacialmente,
 * ver `toggleBoardMode`). */
let boardModeActive = false;

/** Overlay de Modo Placa no circuito PRINCIPAL (diferente de `boardModeActive`, que só existe
 * dentro de "Abrir Subcircuito") -- componentes "graphical" expostos de uma instância com
 * `properties.boardModeEnabled === true` são desenhados sobre a foto do package, na posição
 * `boardVisual`, e ficam clicáveis durante a simulação (ver `subpackage.cpp::setBoardMode()` real).
 * Cache por componentId OUTER -- buscado sob demanda (`ensureBoardOverlayData`) só quando Modo
 * Placa está ligado pra aquela instância, nunca pra todo subcircuito do projeto. */
const boardOverlayDataByComponentId = new Map<string, InternalComponentSnapshot[]>();

function ensureBoardOverlayData(component: WebviewComponentModel): void {
  if (boardOverlayDataByComponentId.has(component.id)) return;
  const sourceId = state.catalog.find((entry) => entry.typeId === component.typeId)?.registeredSourceId;
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
 * vez (sem `boardVisual` no `.lssub.json`) -- sem isto, marcar "exposto" + ligar "Modo Placa" não
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
  const sourceId = state.catalog.find((entry) => entry.typeId === component.typeId)?.registeredSourceId;
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
    svg.innerHTML = componentSymbolSvg(item.typeId, properties);
    el.appendChild(svg);

    const isPushButton = interactionKindFor(item.typeId) === "momentary";
    if (isPushButton) svg.classList.add("component__symbol--push");

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

      const setPressed = (value: boolean): void => {
        if (pressed === value) return;
        pressed = value;
        svg.classList.toggle("component__symbol--push-pressed", value);
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

/** Mesmo typeIds "de autoria de símbolo" de `extension/src/catalog/symbolAuthoring.ts::
 * isSymbolAuthoringTypeId` -- duplicado de propósito (webview não importa do host, tsconfigs
 * diferentes/rootDir diferente). `other.package`/`graphics.*`/`other.package_pin` SEMPRE ficam
 * visíveis/na mesma posição nos dois modos (Modo Placa É a arte deles) -- só o circuito interno
 * real troca de posição/visibilidade. */
function isSymbolAuthoringTypeId(typeId: string): boolean {
  return typeId === "other.package" || typeId === "other.package_pin" || typeId.startsWith("graphics.");
}

function enterSymbolAuthoring(filePath: string, typeId: string, kind: SymbolAuthoringKind, view: "default" | "logicSymbol", components: WebviewComponentModel[], wires: WebviewWireModel[]): void {
  if (!symbolAuthoringContext) realCircuitState = state; // só guarda o circuito real na 1ª entrada -- reentrada (troca de vista) não deve pisar nele de novo
  symbolAuthoringContext = { filePath, typeId, kind, view };
  boardModeActive = false;
  state = { ...createEmptyState(), catalog: realCircuitState!.catalog, locale: realCircuitState!.locale, components, wires };
  render();
}

function exitSymbolAuthoring(): void {
  if (!symbolAuthoringContext || !realCircuitState) return;
  state = realCircuitState;
  realCircuitState = undefined;
  symbolAuthoringContext = undefined;
  boardModeActive = false;
  render();
}

function saveSymbolAuthoring(): void {
  const context = symbolAuthoringContext;
  if (!context) return;
  const components = state.components;
  const wires = state.wires;
  exitSymbolAuthoring(); // restaura o circuito real ANTES de mandar a mensagem -- `send()` abaixo só
  // bloqueia enquanto `symbolAuthoringContext` está ativo, então a ordem aqui importa.
  send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestSaveSymbol", filePath: context.filePath, typeId: context.typeId, kind: context.kind, view: context.view, components, wires });
}

/** Toggle "Ver: Físico / Símbolo Lógico" -- descarta sem aviso qualquer mudança não salva no
 * `package`/`logicSymbolPackage` da vista que está SAINDO (decisão de escopo deliberada: sem
 * `confirm()`, que nem sempre funciona dentro de uma Webview do VSCode -- o hint na barra já avisa
 * "salve antes de trocar de vista"). Preserva o circuito interno tal como está agora (não relido do
 * disco, ver `extension.ts::switchSymbolViewCommand`). */
function toggleLogicSymbolView(): void {
  const context = symbolAuthoringContext;
  if (!context) return;
  const toView: "default" | "logicSymbol" = context.view === "logicSymbol" ? "default" : "logicSymbol";
  const internalComponents = state.components.filter((component) => !isSymbolAuthoringTypeId(component.typeId));
  const internalWires = state.wires;
  exitSymbolAuthoring();
  send({
    version: WEBVIEW_MESSAGE_VERSION,
    type: "requestSwitchSymbolView",
    filePath: context.filePath,
    typeId: context.typeId,
    kind: context.kind,
    toView,
    internalComponents,
    internalWires,
  });
}

/** Modo Placa -- troca, pra cada componente do circuito INTERNO (nunca `other.package`/
 * `graphics.*`/`other.package_pin`, que são a arte da placa em si), qual posição está "ativa"
 * (`x`/`y`/`rotation`/`flipH`/`flipV` <-> `boardX`/`boardY`/`boardRotation`/`boardFlipH`/
 * `boardFlipV`) -- swap simétrico, funciona entrando OU saindo do modo, igual ao SimulIDE real
 * (`SubPackage::setBoardMode()`: "Positions of components in one mode does not affect positions in
 * the other"). Visibilidade (`renderComponent`'s caller, ver `render()`) some à parte, checando
 * `catalog.graphical`. */
function toggleBoardMode(): void {
  if (!symbolAuthoringContext || symbolAuthoringContext.kind !== "subcircuit-file") return;
  boardModeActive = !boardModeActive;
  for (const component of state.components) {
    if (isSymbolAuthoringTypeId(component.typeId)) continue;
    const activeX = component.x;
    const activeY = component.y;
    const activeRotation = component.rotation;
    const activeFlipH = component.flipH;
    const activeFlipV = component.flipV;
    component.x = component.boardX ?? activeX;
    component.y = component.boardY ?? activeY;
    component.rotation = component.boardRotation ?? 0;
    component.flipH = component.boardFlipH;
    component.flipV = component.boardFlipV;
    component.boardX = activeX;
    component.boardY = activeY;
    component.boardRotation = activeRotation;
    component.boardFlipH = activeFlipH;
    component.boardFlipV = activeFlipV;
  }
  persistState();
  render();
}

/** Visível no Modo Placa: a arte da placa em si (sempre) OU um componente "graphical" de verdade
 * (`catalog.graphical`, ver model.ts) -- mesmo princípio do SimulIDE real (LED/motor/display/switch
 * etc. continuam visíveis, o resto -- resistor, MCU, fonte fixa -- some). Fora de Modo Placa, ou
 * fora de uma sessão de subcircuito, sempre visível (comportamento de sempre). */
function isVisibleInCurrentMode(component: WebviewComponentModel): boolean {
  if (!boardModeActive) return true;
  if (isSymbolAuthoringTypeId(component.typeId)) return true;
  return Boolean(state.catalog.find((entry) => entry.typeId === component.typeId)?.graphical);
}

function persistState(): void {
  vscode?.setState(state);
  // Sessão de autoria nunca sincroniza com o `schematicState` real do lado da Extension -- só
  // `requestSaveSymbol` (`saveSymbolAuthoring`) cruza o IPC, e só depois de já restaurar `state`.
  if (symbolAuthoringContext) return;
  const outbound: WebviewToHostMessage = { version: WEBVIEW_MESSAGE_VERSION, type: "projectChanged", project: state };
  vscode?.postMessage(outbound);
}

function send(message: WebviewToHostMessage): void {
  if (symbolAuthoringContext) return;
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

function getSelectedWires(): WebviewWireModel[] {
  return state.wires.filter((wire) => state.selectedWireIds.includes(wire.id));
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
  state.selectedWireIds = [];
  selectedWireSegment = undefined;
  selectedWireCorner = undefined;
  selectedTextLabel = undefined;
  state.selectedComponentIds = isComponentSelected(componentId)
    ? state.selectedComponentIds.filter((id) => id !== componentId)
    : [...state.selectedComponentIds, componentId];
}

function toggleWireSelection(wireId: string, segmentIndex?: number): void {
  state.selectedComponentIds = [];
  selectedTextLabel = undefined;
  if (isWireSelected(wireId)) {
    state.selectedWireIds = state.selectedWireIds.filter((id) => id !== wireId);
    if (selectedWireSegment?.wireId === wireId) selectedWireSegment = undefined;
    if (selectedWireCorner?.wireId === wireId) selectedWireCorner = undefined;
    return;
  }

  state.selectedWireIds = [...state.selectedWireIds, wireId];
  selectedWireSegment = segmentIndex === undefined ? undefined : { wireId, segmentIndex };
  selectedWireCorner = undefined;
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

function showContextMenu(event: MouseEvent, items: ContextMenuItem[]): void {
  event.preventDefault();
  event.stopPropagation();
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

/** Barra de "autoria de símbolo" -- Run/Pause/Stop/Abrir/Salvar Projeto não fazem sentido aqui (a
 * sessão de autoria não é o circuito do usuário, nunca vai pro Core, ver `enterSymbolAuthoring`),
 * então a barra normal seria enganosa (cliques pareceriam funcionar mas `send()` os descarta
 * silenciosamente enquanto `symbolAuthoringContext` está ativo). Só "Cancelar"/"Salvar Símbolo". */
function renderSymbolAuthoringAppBar(context: { typeId: string; kind: SymbolAuthoringKind; view: "default" | "logicSymbol" }): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "appbar";

  const isSubcircuit = context.kind === "subcircuit-file";
  const titleText = isSubcircuit ? `Abrindo subcircuito: ${context.typeId}` : `Editando símbolo: ${context.typeId}`;

  const title = document.createElement("div");
  title.className = "appbar__selection";
  title.textContent = `${titleText}${context.view === "logicSymbol" ? " (vista: Símbolo Lógico)" : ""}`;

  const viewGroup = document.createElement("div");
  viewGroup.className = "appbar__group";
  // "Logic Symbol" -- igual ao SimulIDE real (`SubPackage::Logic_Symbol`): aparência ALTERNATIVA
  // opcional, nunca pra `abi-device` puro ("Package ≠ Subcircuit", ver `.spec/
  // lasecsimul-native-devices.spec` seção 21.3).
  if (context.kind !== "abi-device") {
    const viewToggle = document.createElement("button");
    viewToggle.type = "button";
    viewToggle.className = "property-sheet__button";
    viewToggle.title = "Salve antes de trocar -- mudanças não salvas na vista atual são descartadas.";
    viewToggle.textContent = context.view === "logicSymbol" ? "Ver: Físico" : "Ver: Símbolo Lógico";
    viewToggle.addEventListener("click", () => toggleLogicSymbolView());
    viewGroup.appendChild(viewToggle);
  }
  // Modo Placa -- só faz sentido pra subcircuito (só ele tem circuito interno pra organizar
  // espacialmente, ver `toggleBoardMode`).
  if (isSubcircuit) {
    const boardModeToggle = document.createElement("button");
    boardModeToggle.type = "button";
    boardModeToggle.className = `property-sheet__button${boardModeActive ? " property-sheet__button--active" : ""}`;
    boardModeToggle.textContent = boardModeActive ? "Modo Placa: ON" : "Modo Placa";
    boardModeToggle.title = "Organiza componentes \"de interação\" (LED, motor, display, switch...) sobre a arte da placa, numa posição independente do layout do circuito interno.";
    boardModeToggle.addEventListener("click", () => toggleBoardMode());
    viewGroup.appendChild(boardModeToggle);
  }

  const actions = document.createElement("div");
  actions.className = "appbar__group appbar__meta";
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "property-sheet__button";
  cancelButton.textContent = "Cancelar";
  cancelButton.addEventListener("click", () => exitSymbolAuthoring());

  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.className = "property-sheet__button";
  saveButton.textContent = isSubcircuit ? "Salvar Subcircuito" : "Salvar Símbolo";
  saveButton.addEventListener("click", () => saveSymbolAuthoring());

  actions.append(cancelButton, saveButton);
  bar.append(title, viewGroup, actions);
  return bar;
}

function renderAppBar(): HTMLElement {
  if (symbolAuthoringContext) return renderSymbolAuthoringAppBar(symbolAuthoringContext);

  const bar = document.createElement("div");
  bar.className = "appbar";

  const fileGroup = document.createElement("div");
  fileGroup.className = "appbar__group";
  fileGroup.append(
    renderToolbarButton("open", t("openProject"), () => send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestOpenProject" })),
    renderToolbarButton("save", t("saveProject"), () => send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestSaveProject" })),
  );

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

  const meta = document.createElement("div");
  meta.className = "appbar__meta";

  const selection = document.createElement("div");
  selection.className = "appbar__selection";
  selection.textContent = selectionLabel();

  const status = document.createElement("div");
  status.className = `appbar__status appbar__status--${simulationStatus}`;
  status.textContent = simulationStatus === "running" ? t("running") : simulationStatus === "paused" ? t("paused") : t("stopped");

  meta.append(selection, status);
  bar.append(fileGroup, simGroup, editGroup, meta);
  return bar;
}

type ToolbarIconKind = "open" | "save" | "start" | "pause" | "stop" | "properties" | "delete";

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
  }

  return svg;
}

function render(): void {
  if (!app) return;
  normalizeSelectedWireSegment();
  normalizeSelectedWireCorner();
  app.innerHTML = "";
  app.appendChild(renderAppBar());

  const canvas = document.createElement("div");
  canvas.className = "canvas";

  const canvasContent = document.createElement("div");
  canvasContent.className = "canvas-content";
  canvasContent.style.transform = `translate(${state.viewport.x}px, ${state.viewport.y}px) scale(${state.viewport.zoom})`;

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
    if (state.pendingConnection) {
      event.preventDefault();
      event.stopPropagation();
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
    showContextMenu(event, [{ label: "Selecionar tudo", onClick: () => selectAll() }]);
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

  const wireLayer = document.createElementNS(SVG_NS, "svg");
  wireLayer.classList.add("wire-layer");
  for (const wire of state.wires) {
    const points = wirePolylinePoints(wire);
    if (points.length < 2) continue;
    const polyline = document.createElementNS(SVG_NS, "polyline");
    polyline.dataset.wireId = wire.id;
    setPolylinePoints(polyline, points);
    polyline.setAttribute("class", wireClass(wire.id));
    polyline.style.pointerEvents = "none";
    wireLayer.appendChild(polyline);
    renderWireSegmentHandles(wireLayer, wire, points);
    renderWireCornerHandles(wireLayer, wire, points);
  }
  renderPendingWirePreview(wireLayer);
  canvasContent.appendChild(wireLayer);

  const visibleComponentIds = new Set<string>();
  for (const component of state.components.filter((entry) => !entry.hidden && isVisibleInCurrentMode(entry))) {
    visibleComponentIds.add(component.id);
    let componentEl = componentElementsById.get(component.id);
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

  for (const component of state.components.filter((entry) => {
    if (entry.hidden) return false;
    const catalogEntry = state.catalog.find((item) => item.typeId === entry.typeId);
    return catalogEntry?.registeredSourceKind === "subcircuit-file";
  })) {
    ensureBoardOverlayData(component);
  }

  for (const component of state.components.filter((entry) => !entry.hidden && entry.properties.boardModeEnabled)) {
    for (const overlayEl of renderBoardOverlaysFor(component)) canvasContent.appendChild(overlayEl);
  }

  for (const component of state.components.filter((entry) => !entry.hidden && isVisibleInCurrentMode(entry))) {
    const embedsOwnIdLabel = component.typeId === "connectors.tunnel" &&
      typeof component.properties.name === "string" &&
      component.properties.name.trim().length > 0;
    if (!embedsOwnIdLabel) {
      const idLabel = renderExternalLabel(component, "id");
      if (idLabel) canvasContent.appendChild(idLabel);
    }
    const valueLabel = renderExternalLabel(component, "value");
    if (valueLabel) canvasContent.appendChild(valueLabel);
  }

  for (const component of state.components.filter((entry) => entry.typeId === "connectors.junction")) {
    canvasContent.appendChild(renderJunction(component));
  }

  canvas.appendChild(canvasContent);
  app.append(canvas);
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
      return component.x < right && component.x + box.width > left && component.y < bottom && component.y + box.height > top;
    })
    .map((component) => component.id);

  const hitWireIds = state.wires
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
  return {
    ...component,
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

  const selectedWireIds = new Set(state.selectedWireIds);
  const wires = state.wires
    .filter((wire) =>
      (selectedWireIds.has(wire.id) || (selectedComponentIds.has(wire.from.componentId) && selectedComponentIds.has(wire.to.componentId))) &&
      selectedComponentIds.has(wire.from.componentId) &&
      selectedComponentIds.has(wire.to.componentId)
    )
    .map(cloneWire);

  clipboardItems = { components, wires };
  return true;
}

function cutSelectedItems(): void {
  if (!copySelectedItems()) return;
  deleteSelectedItems();
}

function pasteClipboardItems(): void {
  if (!clipboardItems || clipboardItems.components.length === 0) return;

  const idMap = new Map<string, string>();
  const stagedComponents = [...state.components];
  const components = clipboardItems.components.map((source) => {
    const component = cloneComponent(source);
    const descriptor = state.catalog.find((entry) => entry.typeId === component.typeId);
    const baseLabel = descriptor?.label ?? component.typeId;
    const nextId = newComponentId();
    idMap.set(component.id, nextId);
    component.id = nextId;
    component.label = nextIndexedLabel(component.typeId, baseLabel, stagedComponents);
    component.x += WIRE_GRID_SIZE;
    component.y += WIRE_GRID_SIZE;
    if (interactionKindFor(component.typeId) === "momentary") component.properties.closed = false;
    stagedComponents.push(component);
    return component;
  });

  const wires = clipboardItems.wires.flatMap((source) => {
    const fromId = idMap.get(source.from.componentId);
    const toId = idMap.get(source.to.componentId);
    if (!fromId || !toId) return [];
    const wire = cloneWire(source);
    wire.id = newWireId();
    wire.from = { ...wire.from, componentId: fromId };
    wire.to = { ...wire.to, componentId: toId };
    wire.points = wire.points?.map((point) => ({ x: point.x + WIRE_GRID_SIZE, y: point.y + WIRE_GRID_SIZE }));
    return [wire];
  });

  state = {
    ...state,
    components: [...state.components, ...components],
    wires: [...state.wires, ...wires],
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
  const wire = state.wires.find((entry) => entry.id === selectedWireSegment?.wireId);
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
  const wire = state.wires.find((entry) => entry.id === selectedWireCorner?.wireId);
  if (!wire || !isWireSelected(wire.id)) {
    selectedWireCorner = undefined;
    return;
  }

  const pointCount = wirePolylinePoints(wire).length;
  if (selectedWireCorner.pointIndex <= 0 || selectedWireCorner.pointIndex >= pointCount - 1) {
    selectedWireCorner = undefined;
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
  const wire = state.wires.find((entry) => entry.id === wireId);
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
function flipPoint(local: Point, box: { width: number; height: number }, flipH: boolean, flipV: boolean): Point {
  return {
    x: flipH ? box.width - local.x : local.x,
    y: flipV ? box.height - local.y : local.y,
  };
}

function rotatePoint(local: Point, box: { width: number; height: number }, rotation: 0 | 90 | 180 | 270): Point {
  const cx = box.width / 2;
  const cy = box.height / 2;
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

function svgBodyTransform(box: { width: number; height: number }, rotation: 0 | 90 | 180 | 270, flipH: boolean, flipV: boolean): string {
  const cx = box.width / 2;
  const cy = box.height / 2;
  const scaleX = flipH ? -1 : 1;
  const scaleY = flipV ? -1 : 1;
  return `translate(${cx} ${cy}) rotate(${rotation}) scale(${scaleX} ${scaleY}) translate(${-cx} ${-cy})`;
}

function componentPinLocalPosition(component: WebviewComponentModel, pinIndex: number): Point {
  const box = componentBox(component.typeId, component.properties);
  const base = pinLocalPosition(component.pins[pinIndex]?.id ?? "", pinIndex, component.pins.length, component.typeId, component.properties);
  const flipped = flipPoint(base, box, Boolean(component.flipH), Boolean(component.flipV));
  return rotatePoint(flipped, box, component.rotation);
}

function setPolylinePoints(polyline: SVGPolylineElement, points: Point[]): void {
  polyline.setAttribute("points", points.map((point) => `${point.x},${point.y}`).join(" "));
}

function wirePolylinePoints(wire: WebviewWireModel): Point[] {
  const from = state.components.find((component) => component.id === wire.from.componentId);
  const to = state.components.find((component) => component.id === wire.to.componentId);
  const fromPos = from && pinScenePosition(from, wire.from.pinId);
  const toPos = to && pinScenePosition(to, wire.to.pinId);
  if (!fromPos || !toPos) return [];
  return buildOrthogonalPath([fromPos, ...(wire.points ?? []), toPos]);
}

function updateWireFromFullPath(wire: WebviewWireModel, fullPoints: Point[]): void {
  const normalized = normalizeOrthogonalPath(fullPoints);
  const internal = normalized.slice(1, -1).map((point) => ({ x: point.x, y: point.y }));
  if (internal.length > 0) wire.points = internal;
  else delete wire.points;
}

function moveOrthogonalWireSegment(fullPoints: Point[], segmentIndex: number, coordinate: number): Point[] {
  const moved = fullPoints.map((point) => ({ ...point }));
  const from = moved[segmentIndex];
  const to = moved[segmentIndex + 1];
  if (!from || !to) return moved;

  if (Math.abs(from.y - to.y) < 0.5) {
    from.y = coordinate;
    to.y = coordinate;
  } else if (Math.abs(from.x - to.x) < 0.5) {
    from.x = coordinate;
    to.x = coordinate;
  }
  return normalizeOrthogonalPath(moved);
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

function wireCornerIndexNearSegmentPoint(points: Point[], segmentIndex: number, point: Point, tolerance = 8): number | undefined {
  const from = points[segmentIndex];
  const to = points[segmentIndex + 1];
  if (!from || !to) return undefined;

  const distanceFrom = Math.hypot(point.x - from.x, point.y - from.y);
  if (distanceFrom <= tolerance && segmentIndex > 0) return segmentIndex;

  const distanceTo = Math.hypot(point.x - to.x, point.y - to.y);
  if (distanceTo <= tolerance && segmentIndex + 1 < points.length - 1) return segmentIndex + 1;

  return undefined;
}

function wireConnectCornerIndexLikeSimulIDE(
  points: Point[],
  segmentIndex: number,
  point: Point,
  tolerance = 8
): number | undefined {
  const from = points[segmentIndex];
  const to = points[segmentIndex + 1];
  if (!from || !to) return undefined;

  const isHorizontal = Math.abs(from.y - to.y) < 0.5;
  const isVertical = Math.abs(from.x - to.x) < 0.5;
  if (!isHorizontal && !isVertical) return undefined;

  if (isHorizontal) {
    if (Math.abs(point.x - to.x) < tolerance && segmentIndex < points.length - 2) return segmentIndex + 1;
    if (Math.abs(point.x - from.x) < tolerance && segmentIndex > 0) return segmentIndex;
    return undefined;
  }

  if (Math.abs(point.y - to.y) < tolerance && segmentIndex < points.length - 2) return segmentIndex + 1;
  if (Math.abs(point.y - from.y) < tolerance && segmentIndex > 0) return segmentIndex;
  return undefined;
}

function moveOrthogonalWireCorner(fullPoints: Point[], pointIndex: number, target: Point): Point[] {
  const moved = fullPoints.map((point) => ({ ...point }));
  const prev = moved[pointIndex - 1];
  const current = moved[pointIndex];
  const next = moved[pointIndex + 1];
  if (!prev || !current || !next) return moved;

  const prevVertical = Math.abs(prev.x - current.x) < 0.5;
  const nextVertical = Math.abs(current.x - next.x) < 0.5;
  current.x = target.x;
  current.y = target.y;

  if (prevVertical) prev.x = target.x;
  else prev.y = target.y;

  if (nextVertical) next.x = target.x;
  else next.y = target.y;

  return normalizeOrthogonalPath(moved);
}

function renderWireCornerHandles(wireLayer: SVGSVGElement, wire: WebviewWireModel, points: Point[]): void {
  if (points.length < 3) return;

  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index]!;
    const handle = document.createElementNS(SVG_NS, "circle");
    handle.setAttribute("cx", String(point.x));
    handle.setAttribute("cy", String(point.y));
    handle.setAttribute("r", isWireCornerSelected(wire.id, index) ? "5.5" : "4");
    handle.setAttribute(
      "class",
      `wire-layer__corner-handle ${isWireCornerSelected(wire.id, index) ? "wire-layer__corner-handle--selected" : ""}`
    );
    handle.addEventListener("click", (event) => {
      event.stopPropagation();
      if (event.shiftKey) toggleWireSelection(wire.id);
      else selectOnlyWireCorner(wire.id, index);
      persistState();
      render();
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

      const canvasEl = handle.closest<HTMLElement>(".canvas");
      if (!canvasEl) return;

      if (!isWireSelected(wire.id) || !isWireCornerSelected(wire.id, index)) {
        selectOnlyWireCorner(wire.id, index);
        persistState();
        render();
      }

      wireCornerDrag = {
        wireId: wire.id,
        pointIndex: index,
        startFullPoints: points.map((entry) => ({ ...entry })),
        moved: false,
      };

      const onMove = (moveEvent: PointerEvent): void => {
        const drag = wireCornerDrag;
        if (!drag || drag.wireId !== wire.id || drag.pointIndex !== index) return;
        const wireToMove = state.wires.find((entry) => entry.id === drag.wireId);
        if (!wireToMove) return;
        const raw = eventToCanvasPoint(moveEvent, canvasEl);
        const step = moveEvent.shiftKey ? FINE_WIRE_STEP : WIRE_GRID_SIZE;
        const target = { x: snapCoordinate(raw.x, step), y: snapCoordinate(raw.y, step) };
        updateWireFromFullPath(wireToMove, moveOrthogonalWireCorner(drag.startFullPoints, drag.pointIndex, target));
        drag.moved = true;
        render();
      };

      const finish = (): void => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        const drag = wireCornerDrag;
        wireCornerDrag = undefined;
        if (drag?.moved) persistState();
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", finish, { once: true });
      window.addEventListener("pointercancel", finish, { once: true });
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
      highlight.setAttribute("x1", String(from.x));
      highlight.setAttribute("y1", String(from.y));
      highlight.setAttribute("x2", String(to.x));
      highlight.setAttribute("y2", String(to.y));
      highlight.setAttribute("class", "wire-layer__segment-highlight");
      wireLayer.appendChild(highlight);
    }

    const handle = document.createElementNS(SVG_NS, "line");
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
      const canvasEl = handle.closest<HTMLElement>(".canvas");
      if (!canvasEl) return;
      const clickPoint = eventToCanvasPoint(event, canvasEl);

      if (state.pendingConnection) {
        const cornerIndex = wireConnectCornerIndexLikeSimulIDE(points, index, clickPoint);
        const target =
          cornerIndex !== undefined ? points[cornerIndex]! : nearestSnappedPointOnOrthogonalSegment(clickPoint, from, to, WIRE_GRID_SIZE);
        const split = splitWireRouteAtPoint(wire, target);
        send({
          version: WEBVIEW_MESSAGE_VERSION,
          type: "requestConnectPinToWire",
          from: state.pendingConnection,
          wireId: wire.id,
          point: target,
          points: pendingWirePointsForTarget(target),
          existingWireFirstPoints: split.first,
          existingWireSecondPoints: split.second,
        });
        clearPendingWire();
        vscode?.setState(state);
        render();
        return;
      }

      const cornerIndex = wireCornerIndexNearSegmentPoint(points, index, clickPoint);
      if (event.shiftKey && cornerIndex !== undefined) selectOnlyWireCorner(wire.id, cornerIndex);
      else if (event.shiftKey) toggleWireSelection(wire.id, index);
      else selectOnlyWire(wire.id, index);
      persistState();
      render();
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

      const canvasEl = handle.closest<HTMLElement>(".canvas");
      if (!canvasEl) return;
      const startPoint = eventToCanvasPoint(event, canvasEl);
      const cornerIndex = event.shiftKey ? wireCornerIndexNearSegmentPoint(points, index, startPoint) : undefined;

      if (cornerIndex !== undefined) {
        if (!isWireSelected(wire.id) || !isWireCornerSelected(wire.id, cornerIndex)) {
          selectOnlyWireCorner(wire.id, cornerIndex);
          persistState();
          render();
        }

        wireCornerDrag = {
          wireId: wire.id,
          pointIndex: cornerIndex,
          startFullPoints: points.map((entry) => ({ ...entry })),
          moved: false,
        };

        const onCornerMove = (moveEvent: PointerEvent): void => {
          const drag = wireCornerDrag;
          if (!drag || drag.wireId !== wire.id || drag.pointIndex !== cornerIndex) return;
          const wireToMove = state.wires.find((entry) => entry.id === drag.wireId);
          if (!wireToMove) return;
          const raw = eventToCanvasPoint(moveEvent, canvasEl);
          const step = moveEvent.shiftKey ? FINE_WIRE_STEP : WIRE_GRID_SIZE;
          const target = { x: snapCoordinate(raw.x, step), y: snapCoordinate(raw.y, step) };
          updateWireFromFullPath(wireToMove, moveOrthogonalWireCorner(drag.startFullPoints, drag.pointIndex, target));
          drag.moved = true;
          render();
        };

        const finishCorner = (): void => {
          window.removeEventListener("pointermove", onCornerMove);
          window.removeEventListener("pointerup", finishCorner);
          window.removeEventListener("pointercancel", finishCorner);
          const drag = wireCornerDrag;
          wireCornerDrag = undefined;
          if (drag?.moved) persistState();
        };

        window.addEventListener("pointermove", onCornerMove);
        window.addEventListener("pointerup", finishCorner, { once: true });
        window.addEventListener("pointercancel", finishCorner, { once: true });
        return;
      }

      if (!isWireSelected(wire.id) || !isWireSegmentSelected(wire.id, index)) {
        selectOnlyWire(wire.id, index);
        persistState();
        render();
      }

      const prepared = duplicateEditableEndpointForSegmentMove(points, index);
      wireSegmentDrag = {
        wireId: wire.id,
        segmentIndex: prepared.segmentIndex,
        axis: isHorizontal ? "y" : "x",
        startFullPoints: prepared.points,
        moved: false,
      };

      const onMove = (moveEvent: PointerEvent): void => {
        const drag = wireSegmentDrag;
        // `prepared.segmentIndex` pode diferir de `index` quando o segmento arrastado é o primeiro
        // (duplicateEditableEndpointForSegmentMove insere um ponto duplicado antes e desloca o índice
        // de 0 pra 1) -- comparar contra `prepared.segmentIndex`, não `index` original.
        if (!drag || drag.wireId !== wire.id || drag.segmentIndex !== prepared.segmentIndex) return;
        const wireToMove = state.wires.find((entry) => entry.id === drag.wireId);
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
        render();
      };

      const finish = (): void => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        const drag = wireSegmentDrag;
        wireSegmentDrag = undefined;
        if (drag?.moved) persistState();
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", finish, { once: true });
      window.addEventListener("pointercancel", finish, { once: true });
    });
    wireLayer.appendChild(handle);
  }
}

function pendingConnectionPosition(): Point | undefined {
  const pending = state.pendingConnection;
  if (!pending) return undefined;
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

function nearestPointOnOrthogonalSegment(point: Point, from: Point, to: Point): Point {
  if (Math.abs(from.x - to.x) < 0.5) {
    return {
      x: from.x,
      y: Math.max(Math.min(point.y, Math.max(from.y, to.y)), Math.min(from.y, to.y)),
    };
  }
  return {
    x: Math.max(Math.min(point.x, Math.max(from.x, to.x)), Math.min(from.x, to.x)),
    y: from.y,
  };
}

function nearestSnappedPointOnOrthogonalSegment(point: Point, from: Point, to: Point, step: number): Point {
  const nearest = nearestPointOnOrthogonalSegment(point, from, to);
  if (Math.abs(from.x - to.x) < 0.5) {
    return {
      x: from.x,
      y: Math.max(Math.min(snapCoordinate(nearest.y, step), Math.max(from.y, to.y)), Math.min(from.y, to.y)),
    };
  }

  return {
    x: Math.max(Math.min(snapCoordinate(nearest.x, step), Math.max(from.x, to.x)), Math.min(from.x, to.x)),
    y: from.y,
  };
}

function squaredDistance(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function splitWireRouteAtPoint(wire: WebviewWireModel, splitPoint: Point): { first: Point[]; second: Point[] } {
  const full = wirePolylinePoints(wire);
  if (full.length < 2) return { first: [], second: [] };

  const withSplit: Point[] = [full[0]!];
  let inserted = false;
  for (let index = 1; index < full.length; index += 1) {
    const from = withSplit[withSplit.length - 1]!;
    const to = full[index]!;
    if (!inserted) {
      const nearest = nearestPointOnOrthogonalSegment(splitPoint, from, to);
      if (squaredDistance(nearest, splitPoint) < 1) {
        appendPoint(withSplit, nearest);
        if (!samePoint(nearest, to)) appendPoint(withSplit, to);
        inserted = true;
        continue;
      }
    }
    appendPoint(withSplit, to);
  }

  const splitIndex = withSplit.findIndex((point) => samePoint(point, splitPoint));
  if (splitIndex <= 0 || splitIndex >= withSplit.length - 1) return { first: [], second: [] };
  return {
    first: withSplit.slice(1, splitIndex),
    second: withSplit.slice(splitIndex + 1, withSplit.length - 1),
  };
}

function selectedWireSegmentInfo():
  | { wire: WebviewWireModel; from: Point; to: Point; axis: "x" | "y"; segmentIndex: number }
  | undefined {
  normalizeSelectedWireSegment();
  if (!selectedWireSegment) return undefined;
  const wire = state.wires.find((entry) => entry.id === selectedWireSegment?.wireId);
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
  const wire = state.wires.find((entry) => entry.id === selectedWireCorner?.wireId);
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

function nearestPointOnWire(wire: WebviewWireModel, point: Point): Point | undefined {
  const full = wirePolylinePoints(wire);
  if (full.length < 2) return undefined;

  let bestPoint: Point | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 1; index < full.length; index += 1) {
    const candidate = nearestPointOnOrthogonalSegment(point, full[index - 1]!, full[index]!);
    const distance = squaredDistance(candidate, point);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestPoint = candidate;
    }
  }
  return bestDistance <= 144 ? snapToWireGrid(bestPoint!) : undefined;
}

function pinScenePosition(component: WebviewComponentModel, pinId: string): Point | undefined {
  const pinIndex = component.pins.findIndex((pin) => pin.id === pinId);
  if (pinIndex < 0) return undefined;
  const local = componentPinLocalPosition(component, pinIndex);
  return { x: component.x + local.x, y: component.y + local.y };
}

function updateWiresTouchingComponent(componentId: string): void {
  const wireLayer = document.querySelector<SVGSVGElement>(".wire-layer");
  if (!wireLayer) return;
  for (const wire of state.wires) {
    if (wire.from.componentId !== componentId && wire.to.componentId !== componentId) continue;
    const polyline = wireLayer.querySelector<SVGPolylineElement>(`polyline[data-wire-id="${wire.id}"]`);
    if (!polyline) continue;
    const points = wirePolylinePoints(wire);
    if (points.length < 2) continue;
    setPolylinePoints(polyline, points);
    polyline.setAttribute("class", wireClass(wire.id));
  }
}

function refreshWireColors(): void {
  const wireLayer = document.querySelector<SVGSVGElement>(".wire-layer");
  if (!wireLayer) return;
  for (const wire of state.wires) {
    const polyline = wireLayer.querySelector<SVGPolylineElement>(`polyline[data-wire-id="${wire.id}"]`);
    if (polyline) polyline.setAttribute("class", wireClass(wire.id));
  }
}

function numericReadout(component: WebviewComponentModel): number | undefined {
  const readout = readoutsByComponentId[component.id];
  return typeof readout === "number" ? readout : undefined;
}

/** ABI v2 (.spec/lasecsimul-native-devices.spec): consulta `interactionKind` do catálogo (vindo do
 * Core via `getPropertySchemas`) em vez de checar typeId -- fallback legado só pra typeId sem o
 * campo declarado ainda (catálogo não carregou do Core). */
function interactionKindFor(typeId: string): "momentary" | "toggle" | "none" {
  const declared = state.catalog.find((entry) => entry.typeId === typeId)?.interactionKind;
  if (declared) return declared;
  if (typeId === "switches.push") return "momentary";
  if (typeId === "switches.switch" || typeId === "switches.switch_dip") return "toggle";
  return "none";
}

function usesEmbeddedValueLabel(typeId: string): boolean {
  // sources.fixed_volt/sources.rail mostram um valor CONFIGURADO (propriedade estática), não uma
  // leitura medida -- conceito diferente de `readoutFormat` (ABI v2), que é só pra instrumentos com
  // leitura simulada (ver findCatalogEntry abaixo). Os dois continuam embutindo valor no símbolo,
  // por isso ficam juntos nesta função, mas a ORIGEM do "embute valor" é diferente pra cada um.
  if (typeId === "sources.fixed_volt" || typeId === "sources.rail") return true;
  if (state.catalog.find((entry) => entry.typeId === typeId)?.readoutFormat) return true;
  // Fallback legado -- typeId sem readoutFormat no catálogo ainda.
  return typeId === "instruments.voltmeter" || typeId.startsWith("meters.");
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
    if (component.typeId === "meters.oscope" && Array.isArray(readout)) {
      const previous = scopeHistoryByComponentId[component.id] ?? [[], [], [], []];
      scopeHistories[component.id] = [0, 1, 2, 3].map((channel) => {
        const history = [...(previous[channel] ?? []), Number(readout[channel] ?? 0)];
        return history.slice(-INSTRUMENT_HISTORY_DEPTH);
      });
    }
    if (component.typeId === "meters.logic_analyzer" && typeof readout === "number") {
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
    if (component.typeId === "meters.oscope") {
      instrumentPopups.set(component.id, defaultScopePopupState(component.id, 90 + cascadeOffset, 90 + cascadeOffset));
    } else if (component.typeId === "meters.logic_analyzer") {
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
  const plotW = 560;
  const plotH = 280;
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
  const plotW = 700;
  const plotH = 320;
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

/** Linha de "knob" (disco visual estático + rótulo + spinner numérico editável) -- réplica do
 * layout QDial+QLabel+PlotSpinBox de `oscwidget.ui` (Divisão/Posição de Tempo/Tensão). O disco é só
 * decorativo nesta rodada (sem arrastar pra girar); o spinner ao lado é o controle real. */
function makeKnobRow(labelText: string, value: number, step: number, onChange: (value: number) => void): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "instrument-knob-row";
  const dial = document.createElement("span");
  dial.className = "instrument-knob-dial";
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

function buildScopePopup(popup: ScopePopupState, component: WebviewComponentModel): HTMLDivElement {
  const { container, body } = makePopupChrome(`Oscope-${component.label || component.id}`, popup);

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
  knobs.appendChild(makeKnobRow("Divisão de Tempo (ms)", popup.timeDivMs, 100, (v) => { popup.timeDivMs = Math.max(0.001, v); renderInstrumentPopups(); }));
  knobs.appendChild(makeKnobRow("Posição de Tempo (ms)", activeChannel.timePosMs, 100, (v) => { activeChannel.timePosMs = v; renderInstrumentPopups(); }));
  knobs.appendChild(makeKnobRow("Divisão de Tensão (V)", activeChannel.voltDiv, 0.1, (v) => { activeChannel.voltDiv = Math.max(0.001, v); renderInstrumentPopups(); }));
  knobs.appendChild(makeKnobRow("Posição de Tensão (V)", activeChannel.voltPos, 0.1, (v) => { activeChannel.voltPos = v; renderInstrumentPopups(); }));
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
  const { container, body } = makePopupChrome(`LAnalizer-${component.label || component.id}`, popup);
  const history = logicChannelFor(component.id);

  const plotWrap = document.createElement("div");
  plotWrap.className = "instrument-popup__plot";
  plotWrap.appendChild(renderLogicPopupPlot(popup, history));

  const controls = document.createElement("div");
  controls.className = "instrument-popup__controls";

  const knobs = document.createElement("div");
  knobs.className = "instrument-knobs";
  knobs.appendChild(makeKnobRow("Divisão de Tempo (ms)", popup.timeDivMs, 100, (v) => { popup.timeDivMs = Math.max(10, v); renderInstrumentPopups(); }));
  knobs.appendChild(makeKnobRow("Posição de Tempo (ms)", popup.timePosMs, 100, (v) => { popup.timePosMs = v; renderInstrumentPopups(); }));
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

  const liveComponent = (): WebviewComponentModel | undefined =>
    state.components.find((entry) => entry.id === componentId);

  // ABI v2 (.spec/lasecsimul-native-devices.spec): isPushButton vem de interactionKind (genérico);
  // isSwitchToggle continua específico de "switches.switch" de propósito -- é sobre QUAL CSS/visual
  // este typeId usa, não sobre o conceito genérico de "é toggle" (switch_dip também é toggle mas
  // tem visual/lógica própria, construída à parte nesta sessão, não deve cair neste bucket).
  const isPushButton = (state.catalog.find((entry) => entry.typeId === component.typeId)?.interactionKind ?? interactionKindFor(component.typeId)) === "momentary";
  const isSwitchToggle = component.typeId === "switches.switch";
  const isFixedVolt = component.typeId === "sources.fixed_volt";
  const isExpandableInstrument = component.typeId === "meters.oscope" || component.typeId === "meters.logic_analyzer";

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
    const component = liveComponent();
    if (!component) return;
    const catalogEntry = state.catalog.find((entry) => entry.typeId === component.typeId);
    if (!isComponentSelected(component.id)) selectOnlyComponent(component.id);
    persistState();
    render();
    const selectedComponents = getSelectedComponents();
    const isGroup = selectedComponents.length > 1;
    const isInternalSubcircuitComponent = Boolean(symbolAuthoringContext && symbolAuthoringContext.kind === "subcircuit-file" && !isSymbolAuthoringTypeId(component.typeId));
    // Mesma entrada do botão "✎" da paleta (`palette.ts`) -- só que a partir de uma INSTÂNCIA já
    // colocada no circuito, igual ao "Open Subcircuit" do SimulIDE no menu de botão direito. Só
    // aparece pra typeId registrado (tem `registeredSourceId` -- built-ins de verdade não têm
    // manifesto nenhum pra editar visualmente).
    const sourceId = catalogEntry?.registeredSourceId;
    const propertyMenuItems: ContextMenuItem[] = isGroup
      ? []
      : [{ label: t("properties"), icon: "properties", onClick: () => openPropertyDialog(component) }];
    const internalSubcircuitMenuItems: ContextMenuItem[] = !isGroup && isInternalSubcircuitComponent
      ? [{
          label: t("exposed"),
          checked: component.exposed === true,
          onClick: () => {
            component.exposed = component.exposed !== true;
            persistState();
            render();
            refreshOpenPropertyDialog();
          },
        }]
      : [];
    const symbolMenuItems: ContextMenuItem[] = !isGroup && sourceId
      ? [{
          label: catalogEntry?.registeredSourceKind === "subcircuit-file" ? t("openSubcircuit") : t("editSymbol"),
          onClick: () => send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestEditSymbol", sourceId }),
        }]
      : [];
    // Menu da instância do subcircuito no circuito principal: ações da própria instância ficam
    // aqui; os componentes internos expostos aparecem em submenus separados.
    const isSubcircuitWithPackage = !isGroup && Boolean(sourceId) && catalogEntry?.registeredSourceKind === "subcircuit-file";
    const subcircuitPackageMenuItems: ContextMenuItem[] = isSubcircuitWithPackage
      ? [
          { label: t("loadPackage"), onClick: () => send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestLoadPackage", sourceId: sourceId! }) },
          { label: t("savePackage"), onClick: () => send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestSavePackage", sourceId: sourceId! }) },
          { kind: "separator" },
        ]
      : [];
    const exposedSubmenuItems: ContextMenuItem[] = !isGroup && isSubcircuitWithPackage ? buildExposedComponentMenuItems(component) : [];
    const mcuMenuItems: ContextMenuItem[] = !isGroup && !isSubcircuitWithPackage && isMcuHostComponent(component)
      ? [
          { kind: "separator" },
          { label: t("loadFirmware"), onClick: () => send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestChooseMcuFirmware", componentId: component.id }) },
          { label: t("reloadFirmware"), onClick: () => send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestReloadMcuFirmware", componentId: component.id }) },
          { label: `${t("openSerialMonitor")} USART1`, onClick: () => send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestOpenMcuSerialMonitor", componentId: component.id, usartIndex: 0 }) },
          { label: `${t("openSerialMonitor")} USART2`, onClick: () => send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestOpenMcuSerialMonitor", componentId: component.id, usartIndex: 1 }) },
          { label: `${t("openSerialMonitor")} USART3`, onClick: () => send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestOpenMcuSerialMonitor", componentId: component.id, usartIndex: 2 }) },
        ]
      : [];
    const createSubcircuitMenuItems: ContextMenuItem[] = isGroup && !symbolAuthoringContext
      ? [
          { kind: "separator" },
          { label: t("createSubcircuit"), onClick: () => send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestCreateSubcircuitFromSelection", componentIds: state.selectedComponentIds }) },
        ]
      : [];
    const menuItems: ContextMenuItem[] = [
      ...exposedSubmenuItems,
      ...(exposedSubmenuItems.length > 0 ? [{ kind: "separator" } satisfies ContextMenuItem] : []),
      ...subcircuitPackageMenuItems,
      { label: t("copy"), icon: "copy", shortcut: "Ctrl+C", onClick: () => copySelectedItems() },
      { label: t("cut"), icon: "cut", shortcut: "Ctrl+X", onClick: () => cutSelectedItems() },
      { label: isGroup ? t("deleteSelectedItems") : t("remove"), icon: "remove", shortcut: "Del", onClick: () => deleteSelectedItems() },
      ...propertyMenuItems,
      ...internalSubcircuitMenuItems,
      { kind: "separator" },
      { label: t("rotateCw"), icon: "rotateCw", shortcut: "Ctrl+R", onClick: () => rotateSelectedComponents(1) },
      { label: t("rotateCcw"), icon: "rotateCcw", shortcut: "Ctrl+Shift+R", onClick: () => rotateSelectedComponents(-1) },
      { label: t("rotate180"), icon: "rotate180", onClick: () => rotateSelectedComponents(2) },
      { label: t("flipHorizontal"), icon: "flipHorizontal", shortcut: "Ctrl+L", onClick: () => flipSelectedComponents("horizontal") },
      { label: t("flipVertical"), icon: "flipVertical", shortcut: "Ctrl+Shift+L", onClick: () => flipSelectedComponents("vertical") },
      ...symbolMenuItems,
      ...mcuMenuItems,
      ...createSubcircuitMenuItems,
    ];
    showContextMenu(event, menuItems);
  });

  let dragStartX = 0;
  let dragStartY = 0;
  let dragTargets: Array<{ component: WebviewComponentModel; startX: number; startY: number }> = [];

  el.addEventListener("pointerdown", (event) => {
    const component = liveComponent();
    if (!component) return;
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest(".pin-terminal, .meter-expand-button")) return;
    event.stopPropagation();
    if (event.shiftKey) {
      toggleComponentSelection(component.id);
      persistState();
      render();
      return;
    }
    if (!isComponentSelected(component.id)) selectOnlyComponent(component.id);
    dragStartX = event.clientX;
    dragStartY = event.clientY;
    dragTargets = dragSelectionWithLinkedPinLabels().map((selected) => ({ component: selected, startX: selected.x, startY: selected.y }));
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
    const clickedToggleZone = event.target instanceof Element && Boolean(event.target.closest(".toggle-hit-zone"));
    const canToggle = (isPushButton || isSwitchToggle || isFixedVolt) && clickedToggleZone;

    const DRAG_THRESHOLD_PX = 4;
    let dragStarted = false;
    if (isPushButton && canToggle) setPushClosed(component, true);

    const startDragging = (): void => {
      dragStarted = true;
      el.classList.add("dragging");
      if (isPushButton && canToggle) setPushClosed(component, false); // movimento detectado -- isto era arrasto, não aperto
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
        const targetEl = document.querySelector<HTMLElement>(`.component[data-component-id="${target.component.id}"]`);
        if (targetEl) {
          targetEl.style.left = `${target.component.x}px`;
          targetEl.style.top = `${target.component.y}px`;
        }
        updateWiresTouchingComponent(target.component.id);
      }
    };

    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.classList.remove("dragging");
      isDraggingComponent = false;
      dragTargets = [];
      if (!dragStarted && canToggle) {
        if (isPushButton) setPushClosed(component, false);
        else if (isSwitchToggle) setSwitchClosed(component, component.properties.closed !== true);
        else if (isFixedVolt) setFixedVoltOut(component, component.properties.out !== true);
      }
      persistState();
      render();
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
  const catalogEntry = state.catalog.find((entry) => entry.typeId === component.typeId);
  const box = componentBox(component.typeId, component.properties);
  const isPushButton = (catalogEntry?.interactionKind ?? interactionKindFor(component.typeId)) === "momentary";
  const isSwitchToggle = component.typeId === "switches.switch";
  const isFixedVolt = component.typeId === "sources.fixed_volt";
  const isRail = component.typeId === "sources.rail";
  const isTunnel = component.typeId === "connectors.tunnel";
  const isMeter = component.typeId.startsWith("meters.") || component.typeId === "instruments.voltmeter";
  const meterClass = isMeter ? `component--meter component--${component.typeId.replace(/[._]/g, "-")}` : "";
  const isVoltmeter = component.typeId === "instruments.voltmeter"; // só tinge o símbolo, ver styles.css

  el.className = `component ${isComponentSelected(component.id) ? "selected" : ""} ${isVoltmeter ? "component--voltmeter" : ""} ${isPushButton ? "component--push" : ""} ${isSwitchToggle ? "component--switch" : ""} ${isFixedVolt ? "component--fixed-volt" : ""} ${isRail ? "component--rail" : ""} ${isTunnel ? "component--tunnel" : ""} ${meterClass}`;
  el.style.left = `${component.x}px`;
  el.style.top = `${component.y}px`;
  el.style.width = `${box.width}px`;
  el.style.height = `${box.height}px`;
  el.title = `${component.label} (${component.typeId})`;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.classList.add("component__symbol");
  svg.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
  const bodyGroup = document.createElementNS(SVG_NS, "g");
  bodyGroup.classList.add("component__symbol-body");
  // CSS aplica da direita pra esquerda: scale (flip) primeiro, rotate depois -- mesma ordem usada
  // em flipPoint/rotatePoint pra calcular posição de pino, ver componentPinLocalPosition.
  const scaleX = component.flipH ? -1 : 1;
  const scaleY = component.flipV ? -1 : 1;
  bodyGroup.setAttribute("transform", svgBodyTransform(box, component.rotation, Boolean(component.flipH), Boolean(component.flipV)));
  if (isPushButton) {
    svg.classList.add("component__symbol--push");
    if (component.properties.closed === true) svg.classList.add("component__symbol--push-pressed");
  }
  if (isSwitchToggle) {
    svg.classList.add("component__symbol--switch");
    if (component.properties.closed === true) svg.classList.add("component__symbol--switch-closed");
  }
  if (isFixedVolt) {
    svg.classList.add("component__symbol--fixed-volt");
    if (component.properties.out === true) svg.classList.add("component__symbol--fixed-volt-on");
  }
  const symbolProperties = runtimeSymbolProperties(component);
  bodyGroup.innerHTML = packageSymbolSvg(component.typeId, symbolProperties) ?? catalogEntry?.symbolSvg ?? componentSymbolSvg(component.typeId, symbolProperties);
  svg.appendChild(bodyGroup);
  const tunnelLabel = bodyGroup.querySelector<SVGTextElement>(".tunnel-name");
  if (tunnelLabel && (component.flipH || component.flipV)) {
    tunnelLabel.style.transformBox = "fill-box";
    tunnelLabel.style.transformOrigin = "center";
    tunnelLabel.style.transform = `scale(${scaleX}, ${scaleY})`;
  }

  if (isComponentSelected(component.id)) {
    const overlay = document.createElementNS(SVG_NS, "rect");
    overlay.setAttribute("width", String(box.width));
    overlay.setAttribute("height", String(box.height));
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
    const isActive = state.pendingConnection?.componentId === component.id && state.pendingConnection?.pinId === pin.id;
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
      const canvas = circle.closest<HTMLElement>(".canvas");
      if (!state.pendingConnection) {
        state.pendingConnection = { componentId: component.id, pinId: pin.id };
        selectOnlyComponent(component.id);
        pendingWireRoute = [];
        pendingWireBendLengths = [];
        pendingWirePreviewTarget = canvas ? eventToCanvasPoint(event, canvas) : undefined;
        persistState();
        render();
        return;
      }
      if (state.pendingConnection.componentId === component.id && state.pendingConnection.pinId === pin.id) {
        clearPendingWire();
        persistState();
        render();
        return;
      }
      const toPos = pinScenePosition(component, pin.id);
      send({
        version: WEBVIEW_MESSAGE_VERSION,
        type: "requestConnectPins",
        from: state.pendingConnection,
        to: { componentId: component.id, pinId: pin.id },
        points: toPos ? pendingWirePointsForTarget(toPos) : pendingWireRoute,
      });
      clearPendingWire();
      vscode?.setState(state);
      render();
    });
    svg.appendChild(circle);
  });

  el.querySelector("svg")?.remove();
  el.appendChild(svg);
}

type PropertyFieldKind = "boolean" | "number" | "text" | "readonly" | "select";

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
  if (editor === "checkbox" || editor === "switch") return "boolean";
  if (editor === "select" || editor === "enum") return "select";
  if (editor === "display") return "readonly";
  if (editor === "number") return "number";
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

/** Propriedade do typeId marcada `showOnSymbol` (no máximo uma faz sentido hoje — built-ins/plugins
 * atuais só têm 1 propriedade elétrica cada) — mesma fonte (`propertySchema` do catálogo) usada pelo
 * diálogo de propriedades, ver `resolvePropertyFields`. */
function findShowOnSymbolSchema(component: WebviewComponentModel): PropertySchemaEntry | undefined {
  return state.catalog.find((entry) => entry.typeId === component.typeId)?.propertySchema?.find((schema) => schema.showOnSymbol);
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

function externalLabelText(component: WebviewComponentModel, kind: ExternalLabelKind): string | undefined {
  if (kind === "id") {
    return !component.hidden && component.showId ? component.label : undefined;
  }
  const showValue = usesEmbeddedValueLabel(component.typeId) ? false : component.showValue ?? Boolean(findShowOnSymbolSchema(component));
  return !component.hidden && showValue ? valueLabelText(component) : undefined;
}

function defaultExternalLabelOffset(component: WebviewComponentModel, kind: ExternalLabelKind): Point {
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
  const entry = state.catalog.find((catalogEntry) => catalogEntry.typeId === typeId);
  return entry?.mcuHost === true;
}

function buildExposedComponentMenuItems(component: WebviewComponentModel): ContextMenuItem[] {
  const sourceId = state.catalog.find((entry) => entry.typeId === component.typeId)?.registeredSourceId;
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
          { label: t("reloadFirmware"), onClick: () => send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestReloadExposedMcuFirmware", outerComponentId: component.id, innerComponentId: item.id }) },
          { label: `${t("openSerialMonitor")} USART1`, onClick: () => send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestOpenExposedMcuSerialMonitor", outerComponentId: component.id, innerComponentId: item.id, usartIndex: 0 }) },
          { label: `${t("openSerialMonitor")} USART2`, onClick: () => send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestOpenExposedMcuSerialMonitor", outerComponentId: component.id, innerComponentId: item.id, usartIndex: 1 }) },
          { label: `${t("openSerialMonitor")} USART3`, onClick: () => send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestOpenExposedMcuSerialMonitor", outerComponentId: component.id, innerComponentId: item.id, usartIndex: 2 }) },
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
  const catalogEntry = state.catalog.find((entry) => entry.typeId === component.typeId);
  const schema = catalogEntry?.propertySchema;
  if (!schema || schema.length === 0) return augmentRuntimePropertyFields(component, inferPropertyFields(component));

  const fields: PropertyField[] = [];
  for (const propSchema of schema) {
    if (propSchema.hidden && !propertyDialogShowAll) continue;
    const kind = propertyFieldKindFromEditor(propSchema.editor);
    const isLiveReadout = kind === "readonly" && Boolean(propSchema.showOnSymbol);
    const value = isLiveReadout
      ? formatLiveReadout(propSchema, component)
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
  if (field.kind === "boolean") {
    const row = document.createElement("label");
    row.className = "property-sheet__check-row";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = Boolean(field.value);
    input.disabled = field.readonly ?? false;
    input.addEventListener("change", () => {
      applyChange(input.checked);
      if (component.typeId === "switches.switch" && field.key === "closed") updateRenderedSwitchState(component);
      if (component.typeId === "sources.fixed_volt" && field.key === "out") updateRenderedFixedVoltState(component);
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

  const input = document.createElement("input");
  input.className = "property-sheet__field-input";
  input.type = field.kind === "number" ? "number" : "text";
  input.value = String(field.value);
  input.readOnly = field.kind === "readonly" || Boolean(field.readonly);
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
  return state.catalog.find((entry) => entry.typeId === component.typeId)?.label ?? component.typeId;
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
  const catalogEntry = state.catalog.find((entry) => entry.typeId === component.typeId);
  const helpInfo = catalogEntry?.help;
  const helpButton = document.createElement("button");
  helpButton.type = "button";
  helpButton.className = "property-sheet__button";
  helpButton.textContent = t("help");
  helpButton.disabled = !helpInfo;
  if (helpInfo?.description) helpButton.title = helpInfo.description;
  if (helpInfo?.url) {
    helpButton.addEventListener("click", () => {
      send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestOpenExternal", url: helpInfo.url! });
    });
  }
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

  const usesSchema = Boolean(state.catalog.find((entry) => entry.typeId === component.typeId)?.propertySchema?.length);
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
  shell.append(titleBar, toolbar);
  if (titleRow) shell.append(titleRow);
  shell.append(tabs, pages);
  return shell;
}

window.addEventListener("message", (event: MessageEvent<HostToWebviewMessage>) => {
  const message = event.data;
  if (!message || message.version !== WEBVIEW_MESSAGE_VERSION) return;

  if (message.type === "init" || message.type === "syncState") {
    state = message.project;
    syncPackageRegistry(state.catalog);
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
    // durante a simulação) destruiria um arrasto de componente em andamento (ver doc de
    // `isDraggingComponent`). Os dados (`readoutsByComponentId`) já ficaram atualizados acima; só a
    // TELA fica momentaneamente atrasada até o usuário soltar o mouse (que já chama `render()`).
    if (!isDraggingComponent) render();
    refreshOpenPropertyDialog();
  }

  if (message.type === "instrumentHistory") {
    if (message.oscope) realScopeHistoryByComponentId.set(message.componentId, message.oscope.channels);
    if (message.logic) realLogicHistoryByComponentId.set(message.componentId, message.logic);
    renderInstrumentPopups();
  }

  if (message.type === "boardOverlayData") {
    boardOverlayDataByComponentId.set(message.componentId, message.items);
    if (!isDraggingComponent) render();
  }

  if (message.type === "wireVoltages") {
    voltagesByWireId = message.voltagesByWireId;
    if (!isDraggingComponent) render();
  }

  if (message.type === "simulationStatus") {
    simulationStatus = message.status;
    if (message.status === "stopped") {
      readoutsByComponentId = {};
      scopeHistoryByComponentId = {};
      logicHistoryByComponentId = {};
    }
    render();
    refreshOpenPropertyDialog();
  }

  if (message.type === "requestRotateSelection") {
    rotateSelectedComponents(message.direction === "cw" ? 1 : -1);
  }

  if (message.type === "requestFlipSelection") {
    flipSelectedComponents(message.axis);
  }

  if (message.type === "enterSymbolAuthoring") {
    enterSymbolAuthoring(message.filePath, message.typeId, message.kind, message.view, message.components, message.wires);
  }

  if (message.type === "triggerCreateSubcircuitFromSelection") {
    if (state.selectedComponentIds.length > 1 && !symbolAuthoringContext) {
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

/** `other.package_pin` sempre vem acompanhado de um `graphics.text` vinculado
 * (`linkedPinComponentId` == id ESTÁVEL do componente do pino, nunca o valor mutável da propriedade
 * `pinId` -- assim o vínculo sobrevive a renomear o pino depois, ver `extension/src/catalog/
 * symbolAuthoring.ts::compileSymbolAuthoringComponents`) -- é o rótulo arrastável independente, igual
 * ao SimulIDE real (texto de pino nunca presa a um deslocamento fixo). Posição inicial = mesma
 * fórmula padrão do renderizador de leitura (ponta do lead + 9 unidades na direção do ângulo). Todo
 * outro typeId continua devolvendo só o próprio componente, sem comportamento especial. */
function enterPlacementMode(typeId: string): void {
  placingTypeId = typeId;
  if (!placementGhostEl) {
    placementGhostEl = document.createElement("div");
    placementGhostEl.className = "placement-ghost";
    document.body.appendChild(placementGhostEl);
  }
  const descriptor = state.catalog.find((e) => e.typeId === typeId);
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
  const descriptor = state.catalog.find((entry) => entry.typeId === typeId);
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

    const showValue = usesEmbeddedValueLabel(component.typeId) ? false : component.showValue ?? Boolean(findShowOnSymbolSchema(component));
    const text = !component.hidden && showValue ? valueLabelText(component) : undefined;
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

function updateRenderedPushState(component: WebviewComponentModel): void {
  const elements = document.querySelectorAll(".component");
  for (let index = 0; index < elements.length; index += 1) {
    const el = elements.item(index) as HTMLElement;
    if (el.dataset.componentId !== component.id) continue;
    const svg = el.querySelector(".component__symbol--push") as SVGSVGElement | null;
    svg?.classList.toggle("component__symbol--push-pressed", component.properties.closed === true);
    return;
  }
}

function updateRenderedSwitchState(component: WebviewComponentModel): void {
  const elements = document.querySelectorAll(".component");
  for (let index = 0; index < elements.length; index += 1) {
    const el = elements.item(index) as HTMLElement;
    if (el.dataset.componentId !== component.id) continue;
    const svg = el.querySelector(".component__symbol--switch") as SVGSVGElement | null;
    svg?.classList.toggle("component__symbol--switch-closed", component.properties.closed === true);
    return;
  }
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
  updateRenderedPushState(component);
  refreshOpenPropertyDialog();
}

function setSwitchClosed(component: WebviewComponentModel, closed: boolean): void {
  if (component.properties.closed === closed) return;
  component.properties.closed = closed;
  send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestUpdateProperty", componentId: component.id, name: "closed", value: closed });
  vscode?.setState(state);
  updateRenderedSwitchState(component);
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

function renderJunction(component: WebviewComponentModel): HTMLElement {
  const dot = document.createElement("div");
  dot.className = "junction-dot";
  dot.style.left = `${component.x - 4}px`;
  dot.style.top = `${component.y - 4}px`;
  dot.dataset.componentId = component.id;
  return dot;
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
    event.preventDefault();
    event.stopPropagation();
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
  state.selectedWireIds = state.wires.map((wire) => wire.id);
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
    if (placingTypeId) { exitPlacementMode(); return; }
  }

  if (event.key === "Escape" && state.pendingConnection) {
    clearPendingWire();
    persistState();
    render();
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
