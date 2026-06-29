"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const messages_1 = require("./messages");
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
const app = document.getElementById("app");
function createEmptyState() {
    return {
        catalog: [],
        components: [],
        wires: [],
        viewport: { x: 0, y: 0, zoom: 1 },
    };
}
const initialWindowState = window.__LASECSIMUL_INITIAL_STATE__;
let state = vscode?.getState() ?? initialWindowState ?? createEmptyState();
function persistState() {
    vscode?.setState(state);
    const outbound = { version: messages_1.WEBVIEW_MESSAGE_VERSION, type: "projectChanged", project: state };
    vscode?.postMessage(outbound);
}
function send(message) {
    vscode?.postMessage(message);
}
function makeComponentFromTypeId(typeId) {
    const descriptor = state.catalog.find((entry) => entry.typeId === typeId);
    const componentIndex = state.components.length;
    const pinCount = descriptor?.pinCount ?? 2;
    return {
        id: `component-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`,
        typeId,
        label: descriptor?.label ?? typeId,
        x: 140 + componentIndex * 24,
        y: 140 + componentIndex * 24,
        rotation: 0,
        pins: Array.from({ length: pinCount }, (_, index) => ({ id: `pin-${index + 1}`, x: 0, y: index * 12 })),
        properties: { ...(descriptor?.defaultProperties ?? {}) },
    };
}
function render() {
    if (!app)
        return;
    app.innerHTML = "";
    const toolbar = document.createElement("div");
    toolbar.className = "toolbar";
    const grouped = new Map();
    for (const item of state.catalog) {
        const list = grouped.get(item.category) ?? [];
        list.push(item);
        grouped.set(item.category, list);
    }
    for (const [category, entries] of grouped.entries()) {
        const section = document.createElement("section");
        section.className = "toolbar__group";
        const heading = document.createElement("h3");
        heading.textContent = category;
        section.appendChild(heading);
        for (const entry of entries) {
            const button = document.createElement("button");
            button.type = "button";
            button.dataset.add = entry.typeId;
            button.textContent = entry.label;
            button.title = `${entry.typeId} • ${entry.pinCount} pinos`;
            button.addEventListener("click", () => send({ version: messages_1.WEBVIEW_MESSAGE_VERSION, type: "requestAddComponent", typeId: entry.typeId }));
            section.appendChild(button);
        }
        toolbar.appendChild(section);
    }
    const canvas = document.createElement("div");
    canvas.className = "canvas";
    canvas.addEventListener("click", () => {
        state.selectedComponentId = undefined;
        state.pendingConnection = undefined;
        persistState();
        render();
    });
    const wireLayer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    wireLayer.classList.add("wire-layer");
    wireLayer.setAttribute("viewBox", "0 0 4000 2400");
    for (const wire of state.wires) {
        const from = state.components.find((component) => component.id === wire.from.componentId);
        const to = state.components.find((component) => component.id === wire.to.componentId);
        if (!from || !to)
            continue;
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", String(from.x + 40));
        line.setAttribute("y1", String(from.y + 20));
        line.setAttribute("x2", String(to.x + 40));
        line.setAttribute("y2", String(to.y + 20));
        line.setAttribute("class", "wire-layer__wire");
        wireLayer.appendChild(line);
    }
    canvas.appendChild(wireLayer);
    for (const component of state.components) {
        canvas.appendChild(renderComponent(component));
    }
    const sidebar = document.createElement("aside");
    sidebar.className = "properties";
    sidebar.innerHTML = `<h2>Propriedades</h2>`;
    const selected = state.components.find((component) => component.id === state.selectedComponentId);
    if (!selected) {
        const empty = document.createElement("p");
        empty.textContent = "Selecione um componente para editar.";
        sidebar.appendChild(empty);
    }
    else {
        sidebar.appendChild(renderPropertyEditor(selected));
    }
    app.append(toolbar, canvas, sidebar);
}
function renderComponent(component) {
    const el = document.createElement("div");
    el.className = `component ${state.selectedComponentId === component.id ? "selected" : ""}`;
    el.style.left = `${component.x}px`;
    el.style.top = `${component.y}px`;
    el.dataset.componentId = component.id;
    el.innerHTML = `
    <div class="component__title">${component.label}</div>
    <div class="component__type">${component.typeId}</div>
  `;
    el.addEventListener("click", (event) => {
        event.stopPropagation();
        state.selectedComponentId = component.id;
        persistState();
        render();
    });
    let dragStartX = 0;
    let dragStartY = 0;
    let startComponentX = 0;
    let startComponentY = 0;
    el.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
        state.selectedComponentId = component.id;
        dragStartX = event.clientX;
        dragStartY = event.clientY;
        startComponentX = component.x;
        startComponentY = component.y;
        el.setPointerCapture(event.pointerId);
        const onMove = (moveEvent) => {
            component.x = startComponentX + (moveEvent.clientX - dragStartX);
            component.y = startComponentY + (moveEvent.clientY - dragStartY);
            render();
        };
        const onUp = () => {
            el.removeEventListener("pointermove", onMove);
            el.removeEventListener("pointerup", onUp);
            el.removeEventListener("pointercancel", onUp);
            persistState();
        };
        el.addEventListener("pointermove", onMove);
        el.addEventListener("pointerup", onUp, { once: true });
        el.addEventListener("pointercancel", onUp, { once: true });
    });
    const remove = document.createElement("button");
    remove.className = "component__remove";
    remove.type = "button";
    remove.textContent = "×";
    remove.addEventListener("click", (event) => {
        event.stopPropagation();
        send({ version: messages_1.WEBVIEW_MESSAGE_VERSION, type: "requestRemoveComponent", componentId: component.id });
    });
    el.appendChild(remove);
    const pinRail = document.createElement("div");
    pinRail.className = "component__pins";
    for (const pin of component.pins) {
        const pinButton = document.createElement("button");
        pinButton.type = "button";
        pinButton.className = `component__pin ${state.pendingConnection?.componentId === component.id && state.pendingConnection?.pinId === pin.id ? "component__pin--active" : ""}`;
        pinButton.title = pin.id;
        pinButton.addEventListener("click", (event) => {
            event.stopPropagation();
            if (!state.pendingConnection) {
                state.pendingConnection = { componentId: component.id, pinId: pin.id };
                persistState();
                render();
                return;
            }
            if (state.pendingConnection.componentId === component.id && state.pendingConnection.pinId === pin.id) {
                state.pendingConnection = undefined;
                persistState();
                render();
                return;
            }
            send({
                version: messages_1.WEBVIEW_MESSAGE_VERSION,
                type: "requestConnectPins",
                from: state.pendingConnection,
                to: { componentId: component.id, pinId: pin.id },
            });
            state.pendingConnection = undefined;
        });
        pinRail.appendChild(pinButton);
    }
    el.appendChild(pinRail);
    return el;
}
function renderPropertyEditor(component) {
    const wrap = document.createElement("div");
    wrap.className = "property-editor";
    for (const [name, value] of Object.entries(component.properties)) {
        const label = document.createElement("label");
        label.textContent = name;
        const input = document.createElement("input");
        input.value = String(value);
        input.addEventListener("change", () => {
            const parsed = input.value === "true"
                ? true
                : input.value === "false"
                    ? false
                    : Number.isFinite(Number(input.value))
                        ? Number(input.value)
                        : input.value;
            send({ version: messages_1.WEBVIEW_MESSAGE_VERSION, type: "requestUpdateProperty", componentId: component.id, name, value: parsed });
        });
        label.appendChild(input);
        wrap.appendChild(label);
    }
    if (!Object.keys(component.properties).length) {
        const hint = document.createElement("p");
        hint.textContent = "Sem propriedades editáveis no modelo atual.";
        wrap.appendChild(hint);
    }
    return wrap;
}
window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || message.version !== messages_1.WEBVIEW_MESSAGE_VERSION)
        return;
    if (message.type === "init" || message.type === "syncState") {
        state = message.project;
        vscode?.setState(state);
        render();
    }
    if (message.type === "requestAddComponent") {
        state = {
            ...state,
            components: [...state.components, makeComponentFromTypeId(message.typeId)],
        };
        vscode?.setState(state);
        persistState();
        render();
    }
    if (message.type === "selectComponent") {
        state.selectedComponentId = message.componentId ?? undefined;
        render();
    }
});
render();
send({ version: messages_1.WEBVIEW_MESSAGE_VERSION, type: "webviewReady" });
//# sourceMappingURL=main.js.map