import { WEBVIEW_MESSAGE_VERSION } from "./messages.js";
import { PIN_RADIUS, componentBox, componentSymbolSvg, hasRealPinPosition, packageSymbolSvg, pinLocalPosition, registerPackage } from "./componentSymbols.js";
import { WIRE_GRID_SIZE, appendPoint, buildOrthogonalPath, normalizeOrthogonalPath, orthogonalSegmentPoints, samePoint, snapCoordinate, snapToWireGrid, } from "./wireGeometry.js";
import { formatEngineeringValue } from "./valueFormatting.js";
const SVG_NS = "http://www.w3.org/2000/svg";
const FINE_WIRE_STEP = WIRE_GRID_SIZE / 10;
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
const app = document.getElementById("app");
function createEmptyState() {
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
function normalizeProjectState(raw) {
    const legacy = raw;
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
function syncPackageRegistry(catalog) {
    for (const entry of catalog)
        registerPackage(entry.typeId, entry.package, entry.logicSymbolPackage);
}
const initialWindowState = window.__LASECSIMUL_INITIAL_STATE__;
let state = normalizeProjectState(vscode?.getState() ?? initialWindowState ?? createEmptyState());
syncPackageRegistry(state.catalog);
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
        delete: "Excluir",
        deleteWire: "Excluir fio",
        rotate: "Rotacionar",
        rotateCw: "Rotacionar CW",
        rotateCcw: "Rotacionar CCW",
        rotate180: "Rotacionar 180°",
        help: "Ajuda",
        show: "Mostrar",
        title: "Titulo:",
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
        delete: "Delete",
        deleteWire: "Delete wire",
        rotate: "Rotate",
        rotateCw: "Rotate CW",
        rotateCcw: "Rotate CCW",
        rotate180: "Rotate 180°",
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
    },
};
function currentLocale() {
    return state.locale === "en" ? "en" : "pt-BR";
}
function t(key) {
    return UI_TEXT[currentLocale()][key];
}
let readoutsByComponentId = {};
let voltagesByWireId = {};
let pendingWirePreviewTarget;
let pendingWireRoute = [];
let pendingWireBendLengths = [];
let wireSegmentDrag;
let wireCornerDrag;
let selectedWireSegment;
let selectedWireCorner;
let simulationStatus = "stopped";
let activePropertyComponentId;
let propertyDialogShowAll = false;
const propertyDialog = document.createElement("dialog");
propertyDialog.className = "property-dialog";
document.body.appendChild(propertyDialog);
propertyDialog.addEventListener("click", (event) => {
    if (event.target === propertyDialog)
        propertyDialog.close();
});
propertyDialog.addEventListener("close", () => {
    activePropertyComponentId = undefined;
});
const contextMenu = document.createElement("div");
contextMenu.className = "context-menu";
contextMenu.hidden = true;
document.body.appendChild(contextMenu);
function hideContextMenu() {
    contextMenu.hidden = true;
    contextMenu.innerHTML = "";
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
let realCircuitState;
let symbolAuthoringContext;
function enterSymbolAuthoring(filePath, typeId, components) {
    if (symbolAuthoringContext)
        return; // já em autoria -- reentrada ignorada, ver nota em messages.ts
    realCircuitState = state;
    symbolAuthoringContext = { filePath, typeId };
    state = { ...createEmptyState(), catalog: realCircuitState.catalog, locale: realCircuitState.locale, components };
    render();
}
function exitSymbolAuthoring() {
    if (!symbolAuthoringContext || !realCircuitState)
        return;
    state = realCircuitState;
    realCircuitState = undefined;
    symbolAuthoringContext = undefined;
    render();
}
function saveSymbolAuthoring() {
    const context = symbolAuthoringContext;
    if (!context)
        return;
    const components = state.components;
    exitSymbolAuthoring(); // restaura o circuito real ANTES de mandar a mensagem -- `send()` abaixo só
    // bloqueia enquanto `symbolAuthoringContext` está ativo, então a ordem aqui importa.
    send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestSaveSymbol", filePath: context.filePath, typeId: context.typeId, components });
}
function persistState() {
    vscode?.setState(state);
    // Sessão de autoria nunca sincroniza com o `schematicState` real do lado da Extension -- só
    // `requestSaveSymbol` (`saveSymbolAuthoring`) cruza o IPC, e só depois de já restaurar `state`.
    if (symbolAuthoringContext)
        return;
    const outbound = { version: WEBVIEW_MESSAGE_VERSION, type: "projectChanged", project: state };
    vscode?.postMessage(outbound);
}
function send(message) {
    if (symbolAuthoringContext)
        return;
    vscode?.postMessage(message);
}
function isComponentSelected(componentId) {
    return state.selectedComponentIds.includes(componentId);
}
function isWireSelected(wireId) {
    return state.selectedWireIds.includes(wireId);
}
function isWireSegmentSelected(wireId, segmentIndex) {
    return selectedWireSegment?.wireId === wireId && selectedWireSegment.segmentIndex === segmentIndex;
}
function isWireCornerSelected(wireId, pointIndex) {
    return selectedWireCorner?.wireId === wireId && selectedWireCorner.pointIndex === pointIndex;
}
function getSelectedComponents() {
    return state.components.filter((component) => state.selectedComponentIds.includes(component.id));
}
function getSelectedWires() {
    return state.wires.filter((wire) => state.selectedWireIds.includes(wire.id));
}
/** Primeiro componente selecionado — usado por operações que só fazem sentido pra UM (atalho `r` sem
 * Ctrl, herdado de quando a seleção era singular; abrir o diálogo de propriedades por `Enter`/`P`). */
function getSelectedComponent() {
    return getSelectedComponents()[0];
}
function selectOnlyComponent(componentId) {
    state.selectedComponentIds = [componentId];
    state.selectedWireIds = [];
    selectedWireSegment = undefined;
    selectedWireCorner = undefined;
}
function selectOnlyWire(wireId, segmentIndex) {
    state.selectedComponentIds = [];
    state.selectedWireIds = [wireId];
    selectedWireSegment = segmentIndex === undefined ? undefined : { wireId, segmentIndex };
    selectedWireCorner = undefined;
}
function selectOnlyWireCorner(wireId, pointIndex) {
    state.selectedComponentIds = [];
    state.selectedWireIds = [wireId];
    selectedWireSegment = undefined;
    selectedWireCorner = { wireId, pointIndex };
}
/** Shift+click: alterna um componente dentro/fora de uma seleção múltipla já existente — convenção
 * comum de desktop, não verificada item-a-item contra o SimulIDE (ver `.spec` seção 13.4). */
function toggleComponentSelection(componentId) {
    state.selectedWireIds = [];
    selectedWireSegment = undefined;
    selectedWireCorner = undefined;
    state.selectedComponentIds = isComponentSelected(componentId)
        ? state.selectedComponentIds.filter((id) => id !== componentId)
        : [...state.selectedComponentIds, componentId];
}
function toggleWireSelection(wireId, segmentIndex) {
    state.selectedComponentIds = [];
    if (isWireSelected(wireId)) {
        state.selectedWireIds = state.selectedWireIds.filter((id) => id !== wireId);
        if (selectedWireSegment?.wireId === wireId)
            selectedWireSegment = undefined;
        if (selectedWireCorner?.wireId === wireId)
            selectedWireCorner = undefined;
        return;
    }
    state.selectedWireIds = [...state.selectedWireIds, wireId];
    selectedWireSegment = segmentIndex === undefined ? undefined : { wireId, segmentIndex };
    selectedWireCorner = undefined;
}
function selectionLabel() {
    const components = getSelectedComponents();
    const wires = state.selectedWireIds;
    const total = components.length + wires.length;
    if (total === 0)
        return t("nothingSelected");
    if (total === 1)
        return components[0]?.label ?? `${t("wireLabel")} ${wires[0]}`;
    return `${total} itens selecionados`;
}
function clearSelection() {
    state.selectedComponentIds = [];
    state.selectedWireIds = [];
    selectedWireSegment = undefined;
    selectedWireCorner = undefined;
}
function clearPendingWire() {
    state.pendingConnection = undefined;
    pendingWirePreviewTarget = undefined;
    pendingWireRoute = [];
    pendingWireBendLengths = [];
}
function openSelectedProperties() {
    const component = getSelectedComponent();
    if (component)
        openPropertyDialog(component);
}
function openPropertyDialog(component) {
    activePropertyComponentId = component.id;
    propertyDialog.innerHTML = "";
    propertyDialog.append(renderPropertySheet(component));
    if (!propertyDialog.open)
        propertyDialog.showModal();
}
function refreshOpenPropertyDialog() {
    if (!propertyDialog.open || !activePropertyComponentId)
        return;
    const component = state.components.find((entry) => entry.id === activePropertyComponentId);
    if (!component) {
        propertyDialog.close();
        return;
    }
    openPropertyDialog(component);
}
function showContextMenu(event, items) {
    event.preventDefault();
    event.stopPropagation();
    contextMenu.innerHTML = "";
    if (items.length === 0) {
        hideContextMenu();
        return;
    }
    for (const item of items) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "context-menu__item";
        button.textContent = item.label;
        button.disabled = item.disabled ?? false;
        button.addEventListener("click", () => {
            hideContextMenu();
            item.onClick();
        });
        contextMenu.appendChild(button);
    }
    contextMenu.hidden = false;
    contextMenu.style.left = `${event.clientX}px`;
    contextMenu.style.top = `${event.clientY}px`;
}
function renderToolbarButton(kind, title, onClick, disabled = false) {
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
function renderSymbolAuthoringAppBar(context) {
    const bar = document.createElement("div");
    bar.className = "appbar";
    const title = document.createElement("div");
    title.className = "appbar__selection";
    title.textContent = `Editando símbolo: ${context.typeId}`;
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
    saveButton.textContent = "Salvar Símbolo";
    saveButton.addEventListener("click", () => saveSymbolAuthoring());
    actions.append(cancelButton, saveButton);
    bar.append(title, actions);
    return bar;
}
function renderAppBar() {
    if (symbolAuthoringContext)
        return renderSymbolAuthoringAppBar(symbolAuthoringContext);
    const bar = document.createElement("div");
    bar.className = "appbar";
    const fileGroup = document.createElement("div");
    fileGroup.className = "appbar__group";
    fileGroup.append(renderToolbarButton("open", t("openProject"), () => send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestOpenProject" })), renderToolbarButton("save", t("saveProject"), () => send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestSaveProject" })));
    const simGroup = document.createElement("div");
    simGroup.className = "appbar__group";
    simGroup.append(renderToolbarButton("start", t("runSimulation"), () => send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestRunSimulation" }), simulationStatus === "running"), renderToolbarButton("pause", t("pauseSimulation"), () => send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestPauseSimulation" }), simulationStatus !== "running"), renderToolbarButton("stop", t("stopSimulation"), () => send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestStopSimulation" }), simulationStatus === "stopped"));
    const editGroup = document.createElement("div");
    editGroup.className = "appbar__group";
    editGroup.append(renderToolbarButton("properties", t("componentProperties"), () => openSelectedProperties(), !getSelectedComponent()), renderToolbarButton("delete", state.selectedWireIds.length > 0 ? t("deleteSelectedItems") : t("deleteSelectedComponent"), () => deleteSelectedItems(), state.selectedWireIds.length === 0 && state.selectedComponentIds.length === 0));
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
function renderIcon(kind) {
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
function render() {
    if (!app)
        return;
    normalizeSelectedWireSegment();
    normalizeSelectedWireCorner();
    app.innerHTML = "";
    app.appendChild(renderAppBar());
    const canvas = document.createElement("div");
    canvas.className = "canvas";
    const canvasContent = document.createElement("div");
    canvasContent.className = "canvas-content";
    canvasContent.style.transform = `translate(${state.viewport.x}px, ${state.viewport.y}px) scale(${state.viewport.zoom})`;
    let marqueeStart;
    let marqueeStartScreen;
    let marqueeRectEl;
    let marqueeJustFinished = false;
    canvas.addEventListener("pointermove", (event) => {
        if (!state.pendingConnection)
            return;
        pendingWirePreviewTarget = eventToCanvasPoint(event, canvas);
        refreshPendingWirePreview();
    });
    canvas.addEventListener("click", (event) => {
        hideContextMenu();
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
            }
            else {
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
        if (event.button !== 0 || state.pendingConnection)
            return;
        // Pino/fio não chamam `stopPropagation()` no PRÓPRIO `pointerdown` (só no `click`) -- sem este
        // guard, o evento borbulha até aqui e `setPointerCapture` rouba o pointer do pino, quebrando o
        // clique que inicia um fio (mesma classe de bug já corrigida 2x antes nesta sessão, ver
        // .spec/lasecsimul.spec — pointerdown de filho sem stopPropagation some o alvo do clique
        // sintetizado quando o `render()` do `onUp` do marquee recria o DOM no meio do gesto).
        if (event.target instanceof Element &&
            (event.target.closest(".pin-terminal") || event.target.closest(".component") || event.target.closest("polyline[data-wire-id]"))) {
            return;
        }
        marqueeStart = eventToCanvasPoint(event, canvas);
        marqueeStartScreen = { x: event.clientX, y: event.clientY };
        canvas.setPointerCapture(event.pointerId);
        const onMove = (moveEvent) => {
            const dx = moveEvent.clientX - marqueeStartScreen.x;
            const dy = moveEvent.clientY - marqueeStartScreen.y;
            if (!marqueeRectEl) {
                if (Math.hypot(dx, dy) < 4)
                    return; // limiar -- abaixo disso ainda pode ser um clique simples
                marqueeRectEl = document.createElement("div");
                marqueeRectEl.className = "marquee-rect";
                canvas.appendChild(marqueeRectEl);
            }
            const rect = canvas.getBoundingClientRect();
            marqueeRectEl.style.left = `${Math.min(marqueeStartScreen.x, moveEvent.clientX) - rect.left}px`;
            marqueeRectEl.style.top = `${Math.min(marqueeStartScreen.y, moveEvent.clientY) - rect.top}px`;
            marqueeRectEl.style.width = `${Math.abs(dx)}px`;
            marqueeRectEl.style.height = `${Math.abs(dy)}px`;
        };
        const finish = () => {
            canvas.removeEventListener("pointermove", onMove);
            canvas.removeEventListener("pointerup", onUp);
            canvas.removeEventListener("pointercancel", finish);
            marqueeRectEl?.remove();
            marqueeRectEl = undefined;
            marqueeStart = undefined;
            marqueeStartScreen = undefined;
        };
        const onUp = (upEvent) => {
            const hadRect = Boolean(marqueeRectEl);
            if (hadRect) {
                applyMarqueeSelection(marqueeStart, eventToCanvasPoint(upEvent, canvas), upEvent.shiftKey);
                marqueeJustFinished = true;
                persistState();
            }
            finish();
            if (hadRect)
                render();
        };
        canvas.addEventListener("pointermove", onMove);
        canvas.addEventListener("pointerup", onUp, { once: true });
        canvas.addEventListener("pointercancel", finish, { once: true });
    });
    canvas.addEventListener("wheel", (event) => {
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
    }, { passive: false });
    const wireLayer = document.createElementNS(SVG_NS, "svg");
    wireLayer.classList.add("wire-layer");
    for (const wire of state.wires) {
        const points = wirePolylinePoints(wire);
        if (points.length < 2)
            continue;
        const polyline = document.createElementNS(SVG_NS, "polyline");
        polyline.dataset.wireId = wire.id;
        setPolylinePoints(polyline, points);
        polyline.setAttribute("class", wireClass(wire.id));
        polyline.style.pointerEvents = "none";
        wireLayer.appendChild(polyline);
        renderWireSegmentHandles(wireLayer, wire, points);
    }
    renderPendingWirePreview(wireLayer);
    canvasContent.appendChild(wireLayer);
    for (const component of state.components.filter((entry) => !entry.hidden)) {
        canvasContent.appendChild(renderComponent(component));
    }
    for (const component of state.components.filter((entry) => entry.typeId === "connectors.junction")) {
        canvasContent.appendChild(renderJunction(component));
    }
    canvas.appendChild(canvasContent);
    app.append(canvas);
}
/** Componentes/fios cujas caixas (canvas-local, sem zoom) se sobrepõem ao retângulo do marquee --
 * interseção simples, igual `IntersectsItemShape` do Qt/SimulIDE (ver `.spec` seção 13.4). Fio entra
 * se QUALQUER ponto da polilinha cair dentro do retângulo (simplificação documentada de "toca"). */
function applyMarqueeSelection(start, end, additive) {
    const left = Math.min(start.x, end.x);
    const right = Math.max(start.x, end.x);
    const top = Math.min(start.y, end.y);
    const bottom = Math.max(start.y, end.y);
    const hitComponentIds = state.components
        .filter((component) => {
        if (component.hidden)
            return false;
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
        if (selectedWireSegment && !state.selectedWireIds.includes(selectedWireSegment.wireId))
            selectedWireSegment = undefined;
        if (selectedWireCorner && !state.selectedWireIds.includes(selectedWireCorner.wireId))
            selectedWireCorner = undefined;
    }
    else {
        state.selectedComponentIds = hitComponentIds;
        state.selectedWireIds = hitWireIds;
        selectedWireSegment = hitWireIds.length === 1 ? firstWireSegmentIntersectingRect(hitWireIds[0], left, top, right, bottom) : undefined;
        selectedWireCorner = undefined;
    }
}
/** Remove TODOS os componentes e fios selecionados — uma mensagem IPC por item (reaproveita os
 * verbos `requestRemoveComponent`/`requestRemoveWire` já existentes; nenhum verbo em lote novo). */
function deleteSelectedItems() {
    for (const wireId of state.selectedWireIds) {
        send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestRemoveWire", wireId });
    }
    for (const componentId of state.selectedComponentIds) {
        send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestRemoveComponent", componentId });
    }
    clearSelection();
}
function wireClass(wireId) {
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
function normalizeSelectedWireSegment() {
    if (!selectedWireSegment)
        return;
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
function normalizeSelectedWireCorner() {
    if (!selectedWireCorner)
        return;
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
function valueWithinRange(value, min, max) {
    return value >= Math.min(min, max) - 0.5 && value <= Math.max(min, max) + 0.5;
}
function orthogonalSegmentIntersectsRect(from, to, left, top, right, bottom) {
    if (Math.abs(from.x - to.x) < 0.5) {
        return valueWithinRange(from.x, left, right) && Math.max(Math.min(from.y, to.y), top) <= Math.min(Math.max(from.y, to.y), bottom);
    }
    if (Math.abs(from.y - to.y) < 0.5) {
        return valueWithinRange(from.y, top, bottom) && Math.max(Math.min(from.x, to.x), left) <= Math.min(Math.max(from.x, to.x), right);
    }
    return false;
}
function wireIntersectsRect(wire, left, top, right, bottom) {
    const points = wirePolylinePoints(wire);
    for (let index = 0; index < points.length - 1; index += 1) {
        if (orthogonalSegmentIntersectsRect(points[index], points[index + 1], left, top, right, bottom))
            return true;
    }
    return false;
}
function firstWireSegmentIntersectingRect(wireId, left, top, right, bottom) {
    const wire = state.wires.find((entry) => entry.id === wireId);
    if (!wire)
        return undefined;
    const points = wirePolylinePoints(wire);
    for (let index = 0; index < points.length - 1; index += 1) {
        if (orthogonalSegmentIntersectsRect(points[index], points[index + 1], left, top, right, bottom)) {
            return { wireId, segmentIndex: index };
        }
    }
    return undefined;
}
/** `canvas` aqui é sempre o viewport fixo (`.canvas`, nunca se move/escala) — `.canvas-content` é
 * quem recebe `translate(viewport.x,y) scale(viewport.zoom)`; inverter essa transformação é o que
 * mantém clique de pino/desenho de fio/marquee corretos em qualquer zoom (ver `.spec` seção 13.4). */
function eventToCanvasPoint(event, canvas) {
    const rect = canvas.getBoundingClientRect();
    const zoom = state.viewport.zoom || 1;
    return {
        x: (event.clientX - rect.left - state.viewport.x) / zoom,
        y: (event.clientY - rect.top - state.viewport.y) / zoom,
    };
}
/** Espelha o ponto local antes da rotação -- mesma ordem do CSS `transform: rotate(...) scale(...)`
 * em `renderComponent` (transform aplica da direita pra esquerda: scale primeiro, rotate depois). */
function flipPoint(local, box, flipH, flipV) {
    return {
        x: flipH ? box.width - local.x : local.x,
        y: flipV ? box.height - local.y : local.y,
    };
}
function rotatePoint(local, box, rotation) {
    switch (rotation) {
        case 90:
            return { x: box.width - local.y, y: local.x };
        case 180:
            return { x: box.width - local.x, y: box.height - local.y };
        case 270:
            return { x: local.y, y: box.height - local.x };
        case 0:
        default:
            return local;
    }
}
function componentPinLocalPosition(component, pinIndex) {
    const box = componentBox(component.typeId, component.properties);
    const base = pinLocalPosition(component.pins[pinIndex]?.id ?? "", pinIndex, component.pins.length, component.typeId, component.properties);
    const flipped = flipPoint(base, box, Boolean(component.flipH), Boolean(component.flipV));
    return rotatePoint(flipped, box, component.rotation);
}
function setPolylinePoints(polyline, points) {
    polyline.setAttribute("points", points.map((point) => `${point.x},${point.y}`).join(" "));
}
function wirePolylinePoints(wire) {
    const from = state.components.find((component) => component.id === wire.from.componentId);
    const to = state.components.find((component) => component.id === wire.to.componentId);
    const fromPos = from && pinScenePosition(from, wire.from.pinId);
    const toPos = to && pinScenePosition(to, wire.to.pinId);
    if (!fromPos || !toPos)
        return [];
    return buildOrthogonalPath([fromPos, ...(wire.points ?? []), toPos]);
}
function updateWireFromFullPath(wire, fullPoints) {
    const normalized = normalizeOrthogonalPath(fullPoints);
    const internal = normalized.slice(1, -1).map((point) => ({ x: point.x, y: point.y }));
    if (internal.length > 0)
        wire.points = internal;
    else
        delete wire.points;
}
function moveOrthogonalWireSegment(fullPoints, segmentIndex, coordinate) {
    const moved = fullPoints.map((point) => ({ ...point }));
    const from = moved[segmentIndex];
    const to = moved[segmentIndex + 1];
    if (!from || !to)
        return moved;
    if (Math.abs(from.y - to.y) < 0.5) {
        from.y = coordinate;
        to.y = coordinate;
    }
    else if (Math.abs(from.x - to.x) < 0.5) {
        from.x = coordinate;
        to.x = coordinate;
    }
    return normalizeOrthogonalPath(moved);
}
function duplicateEditableEndpointForSegmentMove(fullPoints, segmentIndex) {
    const duplicated = fullPoints.map((point) => ({ ...point }));
    if (segmentIndex === 0 && duplicated.length >= 2) {
        duplicated.splice(0, 0, { ...duplicated[0] });
        return { points: duplicated, segmentIndex: 1 };
    }
    if (segmentIndex === duplicated.length - 2 && duplicated.length >= 2) {
        duplicated.push({ ...duplicated[duplicated.length - 1] });
    }
    return { points: duplicated, segmentIndex };
}
function wireCornerIndexNearSegmentPoint(points, segmentIndex, point, tolerance = 8) {
    const from = points[segmentIndex];
    const to = points[segmentIndex + 1];
    if (!from || !to)
        return undefined;
    const distanceFrom = Math.hypot(point.x - from.x, point.y - from.y);
    if (distanceFrom <= tolerance && segmentIndex > 0)
        return segmentIndex;
    const distanceTo = Math.hypot(point.x - to.x, point.y - to.y);
    if (distanceTo <= tolerance && segmentIndex + 1 < points.length - 1)
        return segmentIndex + 1;
    return undefined;
}
function wireConnectCornerIndexLikeSimulIDE(points, segmentIndex, point, tolerance = 8) {
    const from = points[segmentIndex];
    const to = points[segmentIndex + 1];
    if (!from || !to)
        return undefined;
    const isHorizontal = Math.abs(from.y - to.y) < 0.5;
    const isVertical = Math.abs(from.x - to.x) < 0.5;
    if (!isHorizontal && !isVertical)
        return undefined;
    if (isHorizontal) {
        if (Math.abs(point.x - to.x) < tolerance && segmentIndex < points.length - 2)
            return segmentIndex + 1;
        if (Math.abs(point.x - from.x) < tolerance && segmentIndex > 0)
            return segmentIndex;
        return undefined;
    }
    if (Math.abs(point.y - to.y) < tolerance && segmentIndex < points.length - 2)
        return segmentIndex + 1;
    if (Math.abs(point.y - from.y) < tolerance && segmentIndex > 0)
        return segmentIndex;
    return undefined;
}
function moveOrthogonalWireCorner(fullPoints, pointIndex, target) {
    const moved = fullPoints.map((point) => ({ ...point }));
    const prev = moved[pointIndex - 1];
    const current = moved[pointIndex];
    const next = moved[pointIndex + 1];
    if (!prev || !current || !next)
        return moved;
    const prevVertical = Math.abs(prev.x - current.x) < 0.5;
    const nextVertical = Math.abs(current.x - next.x) < 0.5;
    current.x = target.x;
    current.y = target.y;
    if (prevVertical)
        prev.x = target.x;
    else
        prev.y = target.y;
    if (nextVertical)
        next.x = target.x;
    else
        next.y = target.y;
    return normalizeOrthogonalPath(moved);
}
function renderWireCornerHandles(wireLayer, wire, points) {
    if (points.length < 3)
        return;
    for (let index = 1; index < points.length - 1; index += 1) {
        const point = points[index];
        const handle = document.createElementNS(SVG_NS, "circle");
        handle.setAttribute("cx", String(point.x));
        handle.setAttribute("cy", String(point.y));
        handle.setAttribute("r", isWireCornerSelected(wire.id, index) ? "5.5" : "4");
        handle.setAttribute("class", `wire-layer__corner-handle ${isWireCornerSelected(wire.id, index) ? "wire-layer__corner-handle--selected" : ""}`);
        handle.addEventListener("click", (event) => {
            event.stopPropagation();
            if (event.shiftKey)
                toggleWireSelection(wire.id);
            else
                selectOnlyWireCorner(wire.id, index);
            persistState();
            render();
        });
        handle.addEventListener("contextmenu", (event) => {
            if (!isWireSelected(wire.id) || !isWireCornerSelected(wire.id, index))
                selectOnlyWireCorner(wire.id, index);
            persistState();
            render();
            showContextMenu(event, [{ label: t("deleteSelectedItems"), onClick: () => deleteSelectedItems() }]);
        });
        handle.addEventListener("pointerdown", (event) => {
            if (event.button !== 0 || state.pendingConnection)
                return;
            event.preventDefault();
            event.stopPropagation();
            const canvasEl = handle.closest(".canvas");
            if (!canvasEl)
                return;
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
            const onMove = (moveEvent) => {
                const drag = wireCornerDrag;
                if (!drag || drag.wireId !== wire.id || drag.pointIndex !== index)
                    return;
                const wireToMove = state.wires.find((entry) => entry.id === drag.wireId);
                if (!wireToMove)
                    return;
                const raw = eventToCanvasPoint(moveEvent, canvasEl);
                const step = moveEvent.shiftKey ? FINE_WIRE_STEP : WIRE_GRID_SIZE;
                const target = { x: snapCoordinate(raw.x, step), y: snapCoordinate(raw.y, step) };
                updateWireFromFullPath(wireToMove, moveOrthogonalWireCorner(drag.startFullPoints, drag.pointIndex, target));
                drag.moved = true;
                render();
            };
            const finish = () => {
                window.removeEventListener("pointermove", onMove);
                window.removeEventListener("pointerup", finish);
                window.removeEventListener("pointercancel", finish);
                const drag = wireCornerDrag;
                wireCornerDrag = undefined;
                if (drag?.moved)
                    persistState();
            };
            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", finish, { once: true });
            window.addEventListener("pointercancel", finish, { once: true });
        });
        wireLayer.appendChild(handle);
    }
}
function renderWireSegmentHandles(wireLayer, wire, points) {
    if (points.length < 2)
        return;
    for (let index = 0; index < points.length - 1; index += 1) {
        const from = points[index];
        const to = points[index + 1];
        const isHorizontal = Math.abs(from.y - to.y) < 0.5;
        const isVertical = Math.abs(from.x - to.x) < 0.5;
        if (!isHorizontal && !isVertical)
            continue;
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
        handle.setAttribute("class", `wire-layer__segment-handle ${isHorizontal ? "wire-layer__segment-handle--horizontal" : "wire-layer__segment-handle--vertical"}`);
        handle.addEventListener("click", (event) => {
            event.stopPropagation();
            const canvasEl = handle.closest(".canvas");
            if (!canvasEl)
                return;
            const clickPoint = eventToCanvasPoint(event, canvasEl);
            if (state.pendingConnection) {
                const cornerIndex = wireConnectCornerIndexLikeSimulIDE(points, index, clickPoint);
                const target = cornerIndex !== undefined ? points[cornerIndex] : nearestSnappedPointOnOrthogonalSegment(clickPoint, from, to, WIRE_GRID_SIZE);
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
            if (event.shiftKey && cornerIndex !== undefined)
                selectOnlyWireCorner(wire.id, cornerIndex);
            else if (event.shiftKey)
                toggleWireSelection(wire.id, index);
            else
                selectOnlyWire(wire.id, index);
            persistState();
            render();
        });
        handle.addEventListener("contextmenu", (event) => {
            if (!isWireSelected(wire.id) || !isWireSegmentSelected(wire.id, index))
                selectOnlyWire(wire.id, index);
            persistState();
            render();
            showContextMenu(event, [{ label: t("deleteSelectedItems"), onClick: () => deleteSelectedItems() }]);
        });
        handle.addEventListener("pointerdown", (event) => {
            if (event.button !== 0 || state.pendingConnection)
                return;
            event.preventDefault();
            event.stopPropagation();
            const canvasEl = handle.closest(".canvas");
            if (!canvasEl)
                return;
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
                const onCornerMove = (moveEvent) => {
                    const drag = wireCornerDrag;
                    if (!drag || drag.wireId !== wire.id || drag.pointIndex !== cornerIndex)
                        return;
                    const wireToMove = state.wires.find((entry) => entry.id === drag.wireId);
                    if (!wireToMove)
                        return;
                    const raw = eventToCanvasPoint(moveEvent, canvasEl);
                    const step = moveEvent.shiftKey ? FINE_WIRE_STEP : WIRE_GRID_SIZE;
                    const target = { x: snapCoordinate(raw.x, step), y: snapCoordinate(raw.y, step) };
                    updateWireFromFullPath(wireToMove, moveOrthogonalWireCorner(drag.startFullPoints, drag.pointIndex, target));
                    drag.moved = true;
                    render();
                };
                const finishCorner = () => {
                    window.removeEventListener("pointermove", onCornerMove);
                    window.removeEventListener("pointerup", finishCorner);
                    window.removeEventListener("pointercancel", finishCorner);
                    const drag = wireCornerDrag;
                    wireCornerDrag = undefined;
                    if (drag?.moved)
                        persistState();
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
            const onMove = (moveEvent) => {
                const drag = wireSegmentDrag;
                if (!drag || drag.wireId !== wire.id || drag.segmentIndex !== index)
                    return;
                const wireToMove = state.wires.find((entry) => entry.id === drag.wireId);
                if (!wireToMove)
                    return;
                const current = eventToCanvasPoint(moveEvent, canvasEl);
                const step = moveEvent.shiftKey ? FINE_WIRE_STEP : WIRE_GRID_SIZE;
                const coordinate = drag.axis === "y" ? snapCoordinate(current.y, step) : snapCoordinate(current.x, step);
                updateWireFromFullPath(wireToMove, moveOrthogonalWireSegment(drag.startFullPoints, drag.segmentIndex, coordinate));
                drag.moved = true;
                selectedWireSegment = { wireId: wire.id, segmentIndex: drag.segmentIndex };
                render();
            };
            const finish = () => {
                window.removeEventListener("pointermove", onMove);
                window.removeEventListener("pointerup", finish);
                window.removeEventListener("pointercancel", finish);
                const drag = wireSegmentDrag;
                wireSegmentDrag = undefined;
                if (drag?.moved)
                    persistState();
            };
            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", finish, { once: true });
            window.addEventListener("pointercancel", finish, { once: true });
        });
        wireLayer.appendChild(handle);
    }
}
function pendingConnectionPosition() {
    const pending = state.pendingConnection;
    if (!pending)
        return undefined;
    const component = state.components.find((item) => item.id === pending.componentId);
    return component && pinScenePosition(component, pending.pinId);
}
function pendingWireAnchor() {
    const start = pendingConnectionPosition();
    if (!start)
        return undefined;
    return pendingWireRoute[pendingWireRoute.length - 1] ?? start;
}
function pendingWirePreviewPoints() {
    const start = pendingConnectionPosition();
    if (!start)
        return [];
    const target = pendingWirePreviewTarget;
    return target ? buildOrthogonalPath([start, ...pendingWireRoute, target]) : [start, ...pendingWireRoute];
}
function renderPendingWirePreview(wireLayer) {
    const points = pendingWirePreviewPoints();
    if (points.length < 2)
        return;
    const polyline = document.createElementNS(SVG_NS, "polyline");
    polyline.dataset.wirePreview = "pending";
    setPolylinePoints(polyline, points);
    polyline.setAttribute("class", "wire-layer__wire wire-layer__wire--preview");
    wireLayer.appendChild(polyline);
}
function refreshPendingWirePreview() {
    const wireLayer = document.querySelector(".wire-layer");
    if (!wireLayer)
        return;
    let polyline = wireLayer.querySelector('polyline[data-wire-preview="pending"]');
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
function appendPendingWireBend(point) {
    const anchor = pendingWireAnchor();
    if (!anchor)
        return;
    const snappedPoint = snapToWireGrid(point);
    const segment = orthogonalSegmentPoints(anchor, snappedPoint);
    const beforeLength = pendingWireRoute.length;
    for (const routePoint of segment.slice(1))
        appendPoint(pendingWireRoute, routePoint);
    pendingWireBendLengths.push(pendingWireRoute.length - beforeLength);
}
function undoPendingWireBend() {
    const lastLength = pendingWireBendLengths.pop();
    if (!lastLength)
        return;
    pendingWireRoute.splice(Math.max(0, pendingWireRoute.length - lastLength), lastLength);
}
function pendingWirePointsForTarget(target) {
    const anchor = pendingWireAnchor();
    if (!anchor)
        return [];
    const points = pendingWireRoute.map((point) => ({ ...point }));
    const segment = orthogonalSegmentPoints(anchor, target);
    for (const routePoint of segment.slice(1, -1))
        appendPoint(points, routePoint);
    return points;
}
function nearestPointOnOrthogonalSegment(point, from, to) {
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
function nearestSnappedPointOnOrthogonalSegment(point, from, to, step) {
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
function squaredDistance(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
}
function splitWireRouteAtPoint(wire, splitPoint) {
    const full = wirePolylinePoints(wire);
    if (full.length < 2)
        return { first: [], second: [] };
    const withSplit = [full[0]];
    let inserted = false;
    for (let index = 1; index < full.length; index += 1) {
        const from = withSplit[withSplit.length - 1];
        const to = full[index];
        if (!inserted) {
            const nearest = nearestPointOnOrthogonalSegment(splitPoint, from, to);
            if (squaredDistance(nearest, splitPoint) < 1) {
                appendPoint(withSplit, nearest);
                if (!samePoint(nearest, to))
                    appendPoint(withSplit, to);
                inserted = true;
                continue;
            }
        }
        appendPoint(withSplit, to);
    }
    const splitIndex = withSplit.findIndex((point) => samePoint(point, splitPoint));
    if (splitIndex <= 0 || splitIndex >= withSplit.length - 1)
        return { first: [], second: [] };
    return {
        first: withSplit.slice(1, splitIndex),
        second: withSplit.slice(splitIndex + 1, withSplit.length - 1),
    };
}
function selectedWireSegmentInfo() {
    normalizeSelectedWireSegment();
    if (!selectedWireSegment)
        return undefined;
    const wire = state.wires.find((entry) => entry.id === selectedWireSegment?.wireId);
    if (!wire)
        return undefined;
    const points = wirePolylinePoints(wire);
    const from = points[selectedWireSegment.segmentIndex];
    const to = points[selectedWireSegment.segmentIndex + 1];
    if (!from || !to)
        return undefined;
    if (Math.abs(from.y - to.y) < 0.5)
        return { wire, from, to, axis: "y", segmentIndex: selectedWireSegment.segmentIndex };
    if (Math.abs(from.x - to.x) < 0.5)
        return { wire, from, to, axis: "x", segmentIndex: selectedWireSegment.segmentIndex };
    return undefined;
}
function moveSelectedWireSegmentByArrow(key, step) {
    const info = selectedWireSegmentInfo();
    if (!info)
        return false;
    if (info.segmentIndex <= 0 || info.segmentIndex >= wirePolylinePoints(info.wire).length - 2)
        return false;
    const currentCoordinate = info.axis === "y" ? info.from.y : info.from.x;
    const delta = info.axis === "y"
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
    if (delta === undefined)
        return false;
    updateWireFromFullPath(info.wire, moveOrthogonalWireSegment(wirePolylinePoints(info.wire), info.segmentIndex, currentCoordinate + delta));
    persistState();
    render();
    return true;
}
function moveSelectedWireCornerByArrow(key, step) {
    normalizeSelectedWireCorner();
    if (!selectedWireCorner)
        return false;
    const wire = state.wires.find((entry) => entry.id === selectedWireCorner?.wireId);
    if (!wire)
        return false;
    const points = wirePolylinePoints(wire);
    const current = points[selectedWireCorner.pointIndex];
    if (!current)
        return false;
    const delta = key === "ArrowUp"
        ? { x: 0, y: -step }
        : key === "ArrowDown"
            ? { x: 0, y: step }
            : key === "ArrowLeft"
                ? { x: -step, y: 0 }
                : key === "ArrowRight"
                    ? { x: step, y: 0 }
                    : undefined;
    if (!delta)
        return false;
    updateWireFromFullPath(wire, moveOrthogonalWireCorner(points, selectedWireCorner.pointIndex, { x: current.x + delta.x, y: current.y + delta.y }));
    persistState();
    render();
    return true;
}
function nearestPointOnWire(wire, point) {
    const full = wirePolylinePoints(wire);
    if (full.length < 2)
        return undefined;
    let bestPoint;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 1; index < full.length; index += 1) {
        const candidate = nearestPointOnOrthogonalSegment(point, full[index - 1], full[index]);
        const distance = squaredDistance(candidate, point);
        if (distance < bestDistance) {
            bestDistance = distance;
            bestPoint = candidate;
        }
    }
    return bestDistance <= 144 ? snapToWireGrid(bestPoint) : undefined;
}
function pinScenePosition(component, pinId) {
    const pinIndex = component.pins.findIndex((pin) => pin.id === pinId);
    if (pinIndex < 0)
        return undefined;
    const local = componentPinLocalPosition(component, pinIndex);
    return { x: component.x + local.x, y: component.y + local.y };
}
function updateWiresTouchingComponent(componentId) {
    const wireLayer = document.querySelector(".wire-layer");
    if (!wireLayer)
        return;
    for (const wire of state.wires) {
        if (wire.from.componentId !== componentId && wire.to.componentId !== componentId)
            continue;
        const polyline = wireLayer.querySelector(`polyline[data-wire-id="${wire.id}"]`);
        if (!polyline)
            continue;
        const points = wirePolylinePoints(wire);
        if (points.length < 2)
            continue;
        setPolylinePoints(polyline, points);
        polyline.setAttribute("class", wireClass(wire.id));
    }
}
function refreshWireColors() {
    const wireLayer = document.querySelector(".wire-layer");
    if (!wireLayer)
        return;
    for (const wire of state.wires) {
        const polyline = wireLayer.querySelector(`polyline[data-wire-id="${wire.id}"]`);
        if (polyline)
            polyline.setAttribute("class", wireClass(wire.id));
    }
}
function voltmeterReadoutText(component) {
    const readout = readoutsByComponentId[component.id];
    if (typeof readout === "number")
        return `${readout.toFixed(3)} V`;
    return simulationStatus === "running" ? "... V" : "0.000 V";
}
/** `steps`: múltiplo de 90° (1 = CW, -1 = CCW, 2 = 180° — `Ctrl+R`/`Ctrl+Shift+R`/menu "Rotacionar
 * 180", ver `.spec/lasecsimul.spec` seção 13.4). Sem `persistState`/`render` aqui -- quem chama em
 * grupo (`rotateSelectedComponents`) faz isso uma vez só, não por componente. */
function applyRotation(component, steps) {
    const nextRotation = ((component.rotation + 90 * steps + 360) % 360);
    component.rotation = nextRotation;
    send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestRotateComponent", componentId: component.id, rotation: nextRotation });
}
/** Atalho de conveniência pra rotacionar UM componente isolado (chamador cuida de persist/render) --
 * usado pelo atalho solto `r` (sem Ctrl), herdado de quando a seleção era singular. */
function rotateComponent(component) {
    applyRotation(component, 1);
    persistState();
    render();
}
function rotateSelectedComponents(steps) {
    const components = getSelectedComponents();
    if (components.length === 0)
        return;
    for (const component of components)
        applyRotation(component, steps);
    persistState();
    render();
}
/** Espelha o símbolo no eixo dado -- só altera a flag visual (`flipH`/`flipV`); pinos continuam
 * identificados pelo mesmo `pinId`, então fios já conectados não precisam de nenhum ajuste no
 * Core (mesma lógica de `applyRotation`: puramente visual). */
function applyFlip(component, axis) {
    if (axis === "horizontal")
        component.flipH = !component.flipH;
    else
        component.flipV = !component.flipV;
    send({
        version: WEBVIEW_MESSAGE_VERSION,
        type: "requestFlipComponent",
        componentId: component.id,
        flipH: Boolean(component.flipH),
        flipV: Boolean(component.flipV),
    });
}
function flipSelectedComponents(axis) {
    const components = getSelectedComponents();
    if (components.length === 0)
        return;
    for (const component of components)
        applyFlip(component, axis);
    persistState();
    render();
}
function renderComponent(component) {
    const el = document.createElement("div");
    const catalogEntry = state.catalog.find((entry) => entry.typeId === component.typeId);
    const box = componentBox(component.typeId, component.properties);
    const isVoltmeter = component.typeId === "instruments.voltmeter"; // só tinge o símbolo, ver styles.css
    el.className = `component ${isComponentSelected(component.id) ? "selected" : ""} ${isVoltmeter ? "component--voltmeter" : ""}`;
    el.style.left = `${component.x}px`;
    el.style.top = `${component.y}px`;
    el.style.width = `${box.width}px`;
    el.style.height = `${box.height}px`;
    el.dataset.componentId = component.id;
    el.title = `${component.label} (${component.typeId})`;
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.classList.add("component__symbol");
    svg.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
    // CSS aplica da direita pra esquerda: scale (flip) primeiro, rotate depois -- mesma ordem usada
    // em flipPoint/rotatePoint pra calcular posição de pino, ver componentPinLocalPosition.
    const scaleX = component.flipH ? -1 : 1;
    const scaleY = component.flipV ? -1 : 1;
    svg.style.transform = `rotate(${component.rotation}deg) scale(${scaleX}, ${scaleY})`;
    svg.innerHTML = packageSymbolSvg(component.typeId, component.properties) ?? catalogEntry?.symbolSvg ?? componentSymbolSvg(component.typeId, component.properties);
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
        if (!hasRealPinPosition(component.typeId, pin.id, component.properties))
            return;
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
            const canvas = circle.closest(".canvas");
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
    el.appendChild(svg);
    if (!component.hidden && component.showId) {
        const idLabelEl = document.createElement("div");
        idLabelEl.className = "component__id-label";
        idLabelEl.textContent = component.label;
        el.appendChild(idLabelEl);
    }
    const showValue = component.showValue ?? Boolean(findShowOnSymbolSchema(component));
    if (!component.hidden && showValue) {
        const text = valueLabelText(component);
        if (text !== undefined) {
            const valueLabelEl = document.createElement("div");
            valueLabelEl.className = "component__value-label";
            valueLabelEl.textContent = text;
            el.appendChild(valueLabelEl);
        }
    }
    el.addEventListener("click", (event) => {
        event.stopPropagation();
        if (event.shiftKey)
            toggleComponentSelection(component.id);
        else
            selectOnlyComponent(component.id);
        persistState();
        render();
        if (event.detail >= 2) {
            queueMicrotask(() => {
                const refreshedComponent = state.components.find((entry) => entry.id === component.id);
                if (refreshedComponent)
                    openPropertyDialog(refreshedComponent);
            });
        }
    });
    el.addEventListener("contextmenu", (event) => {
        if (!isComponentSelected(component.id))
            selectOnlyComponent(component.id);
        persistState();
        render();
        const selectedComponents = getSelectedComponents();
        const isGroup = selectedComponents.length > 1;
        // Mesma entrada do botão "✎" da paleta (`palette.ts`) -- só que a partir de uma INSTÂNCIA já
        // colocada no circuito, igual ao "Open Subcircuit" do SimulIDE no menu de botão direito. Só
        // aparece pra typeId registrado (tem `registeredSourceId` -- built-ins de verdade não têm
        // manifesto nenhum pra editar visualmente).
        const sourceId = catalogEntry?.registeredSourceId;
        showContextMenu(event, [
            ...(isGroup ? [] : [{ label: t("properties"), onClick: () => openPropertyDialog(component) }]),
            { label: t("rotateCw"), onClick: () => rotateSelectedComponents(1) },
            { label: t("rotateCcw"), onClick: () => rotateSelectedComponents(-1) },
            { label: t("rotate180"), onClick: () => rotateSelectedComponents(2) },
            ...(!isGroup && sourceId ? [{ label: t("editSymbol"), onClick: () => send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestEditSymbol", sourceId }) }] : []),
            { label: isGroup ? t("deleteSelectedItems") : t("delete"), onClick: () => deleteSelectedItems() },
        ]);
    });
    let dragStartX = 0;
    let dragStartY = 0;
    let dragTargets = [];
    el.addEventListener("pointerdown", (event) => {
        if (event.button !== 0)
            return;
        if (event.target instanceof Element && event.target.closest(".pin-terminal"))
            return;
        event.stopPropagation();
        if (event.shiftKey) {
            toggleComponentSelection(component.id);
            persistState();
            render();
            return;
        }
        if (!isComponentSelected(component.id))
            selectOnlyComponent(component.id);
        el.classList.add("dragging");
        dragStartX = event.clientX;
        dragStartY = event.clientY;
        dragTargets = getSelectedComponents().map((selected) => ({ component: selected, startX: selected.x, startY: selected.y }));
        el.setPointerCapture(event.pointerId);
        const onMove = (moveEvent) => {
            const zoom = state.viewport.zoom || 1;
            const dx = (moveEvent.clientX - dragStartX) / zoom;
            const dy = (moveEvent.clientY - dragStartY) / zoom;
            for (const target of dragTargets) {
                target.component.x = target.startX + dx;
                target.component.y = target.startY + dy;
                const targetEl = document.querySelector(`.component[data-component-id="${target.component.id}"]`);
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
            dragTargets = [];
            persistState();
            render();
        };
        el.addEventListener("pointermove", onMove);
        el.addEventListener("pointerup", onUp, { once: true });
        el.addEventListener("pointercancel", onUp, { once: true });
    });
    return el;
}
function humanizePropertyName(name) {
    return name
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[._-]+/g, " ")
        .replace(/\b\w/g, (char) => char.toUpperCase());
}
function inferPropertyGroup(name) {
    const normalized = name.toLowerCase();
    if (normalized.includes("key") || normalized.includes("tecla"))
        return t("shortcut");
    if (normalized.includes("show") || normalized.includes("visible") || normalized.includes("title") || normalized.includes("label"))
        return t("visual");
    if (normalized.includes("pole") || normalized.includes("throw") || normalized.includes("close") || normalized.includes("open"))
        return t("principal");
    return t("principal");
}
function propertyFieldKindFromEditor(editor) {
    if (editor === "checkbox" || editor === "switch")
        return "boolean";
    if (editor === "select" || editor === "enum")
        return "select";
    if (editor === "display")
        return "readonly";
    if (editor === "number")
        return "number";
    return "text";
}
/** Mesmo texto que `voltmeterReadoutText` produzia (hardcoded só pro voltímetro), generalizado pra
 * qualquer campo `showOnSymbol && editor==="display"`: valor medido ao vivo (telemetria, não uma
 * propriedade) enquanto a simulação roda, placeholder "..." até a primeira leitura chegar, "0.000"
 * quando parado. Não é mais inferência — é a única ponte documentada entre o schema (estático, por
 * typeId) e a telemetria (dinâmica, por instância, via `readoutsByComponentId`). */
function formatLiveReadout(schema, component) {
    const unit = schema.unit ? ` ${schema.unit}` : "";
    const live = readoutsByComponentId[component.id];
    if (typeof live === "number")
        return `${live.toFixed(3)}${unit}`;
    if (simulationStatus === "running")
        return `...${unit}`;
    return `0.000${unit}`;
}
/** Propriedade do typeId marcada `showOnSymbol` (no máximo uma faz sentido hoje — built-ins/plugins
 * atuais só têm 1 propriedade elétrica cada) — mesma fonte (`propertySchema` do catálogo) usada pelo
 * diálogo de propriedades, ver `resolvePropertyFields`. */
function findShowOnSymbolSchema(component) {
    return state.catalog.find((entry) => entry.typeId === component.typeId)?.propertySchema?.find((schema) => schema.showOnSymbol);
}
/** Texto do rótulo de valor (ex: "1 kΩ", ou a leitura ao vivo do voltímetro) — `undefined` quando o
 * typeId não tem propriedade `showOnSymbol` nenhuma (nada a mostrar). Generaliza o que antes era um
 * bloco hardcoded só pro voltímetro em `renderComponent`. */
function valueLabelText(component) {
    const schema = findShowOnSymbolSchema(component);
    if (!schema)
        return undefined;
    if (schema.editor === "display")
        return formatLiveReadout(schema, component);
    const raw = component.properties[schema.id] ?? schema.default;
    return typeof raw === "number" ? formatEngineeringValue(raw, schema.unit) : String(raw);
}
/** Schema-driven: grupo/ordem/rótulo/editor/min/max/opções vêm do `propertySchema` que o Core
 * declarou pro typeId (built-in ou plugin, ver `getPropertySchemas`) em vez de inferidos do valor JS
 * (`typeof value`) e de heurística de nome -- isso é o que faz spinbox, select/enum, campo oculto e
 * rótulo customizado funcionarem de verdade. Cai pra `inferPropertyFields` (heurística antiga) só
 * quando o Core ainda não tem schema pra este typeId (registrado-mas-desabilitado, por exemplo) --
 * degradação graciosa, nunca quebra o diálogo. */
function resolvePropertyFields(component) {
    const catalogEntry = state.catalog.find((entry) => entry.typeId === component.typeId);
    const schema = catalogEntry?.propertySchema;
    if (!schema || schema.length === 0)
        return inferPropertyFields(component);
    const fields = [];
    for (const propSchema of schema) {
        if (propSchema.hidden && !propertyDialogShowAll)
            continue;
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
    return fields;
}
function inferPropertyFields(component) {
    const fields = [];
    for (const [key, value] of Object.entries(component.properties)) {
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
    return fields;
}
function groupFields(fields) {
    const groups = new Map();
    for (const field of fields) {
        const list = groups.get(field.group) ?? [];
        list.push(field);
        groups.set(field.group, list);
    }
    return groups;
}
function renderPropertyField(component, field) {
    if (field.kind === "boolean") {
        const row = document.createElement("label");
        row.className = "property-sheet__check-row";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = Boolean(field.value);
        input.disabled = field.readonly ?? false;
        input.addEventListener("change", () => {
            component.properties[field.key] = input.checked;
            send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestUpdateProperty", componentId: component.id, name: field.key, value: input.checked });
            persistState();
            refreshOpenPropertyDialog();
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
            component.properties[field.key] = select.value;
            send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestUpdateProperty", componentId: component.id, name: field.key, value: select.value });
            persistState();
            refreshOpenPropertyDialog();
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
        if (field.min !== undefined)
            input.min = String(field.min);
        if (field.max !== undefined)
            input.max = String(field.max);
    }
    if (!input.readOnly) {
        input.addEventListener("change", () => {
            const value = field.kind === "number" ? Number(input.value) : input.value;
            component.properties[field.key] = value;
            send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestUpdateProperty", componentId: component.id, name: field.key, value });
            persistState();
            refreshOpenPropertyDialog();
        });
    }
    row.append(caption, input);
    return row;
}
/** Os 2 checkboxes "de sistema" (mostrar nome/mostrar valor) -- nunca vêm de `propertySchema` do
 * Core (não são propriedade elétrica de typeId nenhum, ver `.spec/lasecsimul.spec` seção 6.1.2);
 * aplicam-se a QUALQUER componente igual, por isso são montados aqui, não em
 * `resolvePropertyFields`/`renderPropertyField`. Mudar um manda os dois valores resolvidos juntos
 * (`requestUpdateLabelVisibility`), nunca toca o Core. */
function appendSystemVisualFields(fieldset, component) {
    const currentShowId = component.showId ?? false;
    const currentShowValue = component.showValue ?? Boolean(findShowOnSymbolSchema(component));
    const sendVisibility = (showId, showValue) => {
        component.showId = showId;
        component.showValue = showValue;
        send({ version: WEBVIEW_MESSAGE_VERSION, type: "requestUpdateLabelVisibility", componentId: component.id, showId, showValue });
        persistState();
        render();
        refreshOpenPropertyDialog();
    };
    const idRow = document.createElement("label");
    idRow.className = "property-sheet__check-row";
    const idInput = document.createElement("input");
    idInput.type = "checkbox";
    idInput.checked = currentShowId;
    idInput.addEventListener("change", () => sendVisibility(idInput.checked, currentShowValue));
    const idText = document.createElement("span");
    idText.textContent = t("showName");
    idRow.append(idInput, idText);
    const valueRow = document.createElement("label");
    valueRow.className = "property-sheet__check-row";
    const valueInput = document.createElement("input");
    valueInput.type = "checkbox";
    valueInput.checked = currentShowValue;
    valueInput.addEventListener("change", () => sendVisibility(currentShowId, valueInput.checked));
    const valueText = document.createElement("span");
    valueText.textContent = t("showValue");
    valueRow.append(valueInput, valueText);
    fieldset.append(idRow, valueRow);
}
function renderPropertySheet(component) {
    const shell = document.createElement("section");
    shell.className = "property-sheet";
    const titleBar = document.createElement("div");
    titleBar.className = "property-sheet__titlebar";
    const uid = document.createElement("div");
    uid.className = "property-sheet__uid";
    uid.textContent = `${t("uid")}: ${component.label}`;
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
    typeText.textContent = `${t("type")}: ${component.label}`;
    const toolbarActions = document.createElement("div");
    toolbarActions.className = "property-sheet__actions";
    const helpButton = document.createElement("button");
    helpButton.type = "button";
    helpButton.className = "property-sheet__button";
    helpButton.textContent = t("help");
    helpButton.disabled = true;
    const showLabel = document.createElement("label");
    showLabel.className = "property-sheet__show-toggle";
    const showText = document.createElement("span");
    showText.textContent = t("show");
    const showCheckbox = document.createElement("input");
    showCheckbox.type = "checkbox";
    showCheckbox.checked = propertyDialogShowAll;
    showCheckbox.addEventListener("change", () => {
        propertyDialogShowAll = showCheckbox.checked;
        refreshOpenPropertyDialog();
    });
    showLabel.append(showText, showCheckbox);
    toolbarActions.append(helpButton, showLabel);
    toolbar.append(typeText, toolbarActions);
    const titleRow = document.createElement("label");
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
    const usesSchema = Boolean(state.catalog.find((entry) => entry.typeId === component.typeId)?.propertySchema?.length);
    const groups = groupFields(resolvePropertyFields(component));
    // Schema-driven: ordem das abas = ordem de primeira aparição do grupo no schema (Map preserva
    // ordem de inserção) -- nunca prefixado por "Principal", que só faz sentido como fallback da
    // heurística antiga (quando NENHUM grupo real foi declarado).
    const orderedGroupNames = usesSchema ? [...groups.keys()] : [...new Set([t("principal"), ...groups.keys()])];
    // "Visual" (mostrar nome/valor no canvas) é de sistema -- aplica a QUALQUER typeId, nunca vem do
    // schema do Core (não é elétrico) -- garante a aba mesmo se nenhuma propriedade real usar esse grupo.
    if (!orderedGroupNames.includes(t("visual")))
        orderedGroupNames.push(t("visual"));
    const tabs = document.createElement("div");
    tabs.className = "property-sheet__tabs";
    const pages = document.createElement("div");
    pages.className = "property-sheet__pages";
    let activeTab = orderedGroupNames.find((name) => groups.get(name)?.length) ?? t("principal");
    const renderPage = () => {
        tabs.innerHTML = "";
        pages.innerHTML = "";
        for (const groupName of orderedGroupNames) {
            const fields = groups.get(groupName) ?? [];
            if (groupName !== t("visual") && fields.length === 0 && !propertyDialogShowAll)
                continue;
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
        if (fields.length === 0 && activeTab !== t("visual")) {
            const empty = document.createElement("p");
            empty.className = "property-sheet__empty";
            empty.textContent = t("noProperties");
            fieldset.appendChild(empty);
        }
        else {
            for (const field of fields)
                fieldset.appendChild(renderPropertyField(component, field));
        }
        if (activeTab === t("visual"))
            appendSystemVisualFields(fieldset, component);
        pages.appendChild(fieldset);
    };
    renderPage();
    shell.append(titleBar, toolbar, titleRow, tabs, pages);
    return shell;
}
window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || message.version !== WEBVIEW_MESSAGE_VERSION)
        return;
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
    if (message.type === "requestAddComponent") {
        state = {
            ...state,
            components: [...state.components, ...componentsToAddForTypeId(message.typeId)],
        };
        vscode?.setState(state);
        persistState();
        render();
    }
    if (message.type === "selectComponent") {
        state.selectedComponentIds = message.componentId ? [message.componentId] : [];
        state.selectedWireIds = [];
        render();
    }
    if (message.type === "componentReadout") {
        readoutsByComponentId = message.readoutsByComponentId;
        render();
        refreshOpenPropertyDialog();
    }
    if (message.type === "wireVoltages") {
        voltagesByWireId = message.voltagesByWireId;
        render();
    }
    if (message.type === "simulationStatus") {
        simulationStatus = message.status;
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
        enterSymbolAuthoring(message.filePath, message.typeId, message.components);
    }
});
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/** Mesmo algoritmo de `extension.ts::nextIndexedLabel` (duplicado de propósito — são dois pontos de
 * criação de componente independentes, ver `.spec`/plano aprovado). Contador por `typeId`, nunca
 * persistido separado: sempre recalculado a partir de quem já existe em `state.components`. */
function nextIndexedLabel(typeId, baseLabel) {
    const pattern = new RegExp(`^${escapeRegExp(baseLabel)}-(\\d+)$`);
    let maxIndex = 0;
    for (const component of state.components) {
        if (component.typeId !== typeId)
            continue;
        const match = pattern.exec(component.label);
        if (match)
            maxIndex = Math.max(maxIndex, Number(match[1]));
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
function componentsToAddForTypeId(typeId) {
    const component = makeComponentFromTypeId(typeId);
    if (typeId !== "other.package_pin")
        return [component];
    const box = componentBox(component.typeId, component.properties);
    const anchorX = component.x + box.width / 2;
    const anchorY = component.y + box.height / 2;
    const length = typeof component.properties.length === "number" ? component.properties.length : 8;
    const rad = (component.rotation * Math.PI) / 180;
    const labelX = anchorX + Math.cos(rad) * (length + 9);
    const labelY = anchorY + Math.sin(rad) * (length + 9);
    const pinId = typeof component.properties.pinId === "string" ? component.properties.pinId : component.id;
    const labelBox = componentBox("graphics.text", { text: pinId, fontSize: 7 });
    const label = {
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
function makeComponentFromTypeId(typeId) {
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
        showValue: Boolean(descriptor?.propertySchema?.some((schema) => schema.showOnSymbol)),
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
function refreshReadouts() {
    for (const component of state.components) {
        const el = document.querySelector(`.component[data-component-id="${component.id}"]`);
        if (!el)
            continue;
        const existing = el.querySelector(".component__value-label");
        const showValue = component.showValue ?? Boolean(findShowOnSymbolSchema(component));
        const text = !component.hidden && showValue ? valueLabelText(component) : undefined;
        if (text === undefined) {
            existing?.remove();
            continue;
        }
        const valueLabelEl = existing ?? document.createElement("div");
        valueLabelEl.className = "component__value-label";
        valueLabelEl.textContent = text;
        if (!existing)
            el.appendChild(valueLabelEl);
    }
}
function renderJunction(component) {
    const dot = document.createElement("div");
    dot.className = "junction-dot";
    dot.style.left = `${component.x - 4}px`;
    dot.style.top = `${component.y - 4}px`;
    dot.dataset.componentId = component.id;
    return dot;
}
/** Seleciona todo componente/fio não oculto (`Ctrl+A`, `circuit.cpp::keyPressEvent` do SimulIDE). */
function selectAll() {
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
    }
    if ((event.key === "Enter" || event.key.toLowerCase() === "p") && getSelectedComponent()) {
        openSelectedProperties();
        return;
    }
    // Atalho solto `r` (sem Ctrl) -- herdado de quando a seleção era singular, rotaciona só o
    // primeiro componente selecionado (não o grupo inteiro -- isso é o que `Ctrl+R` faz agora).
    if (!ctrl && event.key.toLowerCase() === "r" && getSelectedComponent()) {
        rotateComponent(getSelectedComponent());
        return;
    }
    if (event.key === "Escape") {
        hideContextMenu();
    }
    if (event.key === "Escape" && state.pendingConnection) {
        clearPendingWire();
        persistState();
        render();
    }
});
render();
send({ version: WEBVIEW_MESSAGE_VERSION, type: "webviewReady" });
//# sourceMappingURL=main.js.map