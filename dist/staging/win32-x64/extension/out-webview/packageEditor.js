/**
 * Editor visual de `package` (Épico G, parte de ESCRITA — a parte de LEITURA já existe em
 * `componentSymbols.ts`, ver `registerPackage`/`packageSymbolSvg`). Mesmo princípio do
 * `.spec/lasecsimul-native-devices.spec` seção 21.3: reaproveita o MESMO webview do esquemático,
 * com um "modo de edição" que toma conta de `#app` por completo enquanto ativo — nunca um painel
 * novo, nunca um formato de estado paralelo (salva direto no `package` do `device.json`/`mcu.json`/
 * `.lssub.json` real, o mesmo arquivo que alguém poderia editar à mão).
 *
 * Geometria/convenção de pino (`x`/`y`/`angle`/`length`) é a MESMA do renderizador de leitura
 * (`componentSymbols.ts::resolvePackageLayout`): `x`/`y` é onde o lead toca o corpo; a ponta real
 * (onde o fio conectaria, se isto fosse um componente de circuito) é
 * `x + cos(angle)*length, y + sin(angle)*length`. `angle` em graus, convenção SVG (y pra baixo):
 * 0=direita, 90=baixo, 180=esquerda, 270=cima.
 */
import { WEBVIEW_MESSAGE_VERSION } from "./messages.js";
import { applyShapeOrigin, computeBounds, inferPinPlacement, nextFreePinId, pinTip, shapeOrigin } from "./packageEditorGeometry.js";
const SVG_NS = "http://www.w3.org/2000/svg";
/** Símbolo na tela sempre em 2x as unidades do `package` -- pinos/formas de devices reais costumam
 * ser pequenos (60-330 unidades), 1:1 ficaria minúsculo demais pra arrastar com precisão. */
const DISPLAY_SCALE = 2;
const CANVAS_PADDING = 48; // folga (em unidades do package) ao redor do corpo, pra caber lead+rótulo
const HANDLE_RADIUS = 5;
let editorState;
let sendMessage = () => { };
let onExitCallback = () => { };
let onChangeCallback = () => { };
/** Chamado uma vez por `main.ts` (mesmo princípio de injeção de dependência do resto do webview —
 * este módulo nunca chama `acquireVsCodeApi()` direto, pra não duplicar o "singleton" já feito lá). */
export function configurePackageEditor(send, onExit, onChange) {
    sendMessage = send;
    onExitCallback = onExit;
    onChangeCallback = onChange;
}
export function isPackageEditorActive() {
    return editorState !== undefined;
}
function clonePackage(pkg) {
    return {
        width: pkg.width,
        height: pkg.height,
        border: pkg.border,
        background: pkg.background ? { ...pkg.background } : undefined,
        shapes: (pkg.shapes ?? []).map((shape) => ({ ...shape })),
        pins: pkg.pins.map((pin) => ({ ...pin })),
    };
}
export function enterPackageEditor(payload) {
    editorState = {
        filePath: payload.filePath,
        typeId: payload.typeId,
        knownPinIds: payload.knownPinIds,
        pkg: clonePackage(payload.package),
        selection: undefined,
        addPinMode: false,
        dirty: false,
    };
}
function exitEditor() {
    editorState = undefined;
    onExitCallback();
}
function markDirty() {
    if (editorState)
        editorState.dirty = true;
    onChangeCallback();
}
// ── Drag genérico (mesmo idioma de `main.ts`: setPointerCapture + listeners por gesto) ───────────
function startDrag(event, onMove, onUp) {
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    target.setPointerCapture(pointerId);
    let moved = false;
    const move = (moveEvent) => {
        moved = true;
        onMove((moveEvent.clientX - startX) / DISPLAY_SCALE, (moveEvent.clientY - startY) / DISPLAY_SCALE);
    };
    const up = () => {
        target.removeEventListener("pointermove", move);
        target.removeEventListener("pointerup", up);
        target.removeEventListener("pointercancel", up);
        if (moved)
            onUp();
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up, { once: true });
    target.addEventListener("pointercancel", up, { once: true });
}
// ── Construção de elementos de campo (mesma linguagem visual de `.property-sheet__field-row`) ────
function fieldRow(labelText, input) {
    const row = document.createElement("label");
    row.className = "property-sheet__field-row package-editor__field-row";
    const caption = document.createElement("span");
    caption.className = "property-sheet__field-label";
    caption.textContent = `${labelText}:`;
    row.append(caption, input);
    return row;
}
function numberInput(value, onCommit, step = 1) {
    const input = document.createElement("input");
    input.className = "property-sheet__field-input";
    input.type = "number";
    input.step = String(step);
    input.value = String(value);
    input.addEventListener("change", () => {
        const next = Number(input.value);
        if (Number.isFinite(next))
            onCommit(next);
    });
    return input;
}
function textInput(value, onCommit) {
    const input = document.createElement("input");
    input.className = "property-sheet__field-input";
    input.type = "text";
    input.value = value;
    input.addEventListener("change", () => onCommit(input.value));
    return input;
}
function colorInput(value, onCommit) {
    const input = document.createElement("input");
    input.className = "property-sheet__field-input package-editor__color-input";
    input.type = "color";
    input.value = /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#000000";
    input.addEventListener("input", () => onCommit(input.value));
    return input;
}
function selectInput(value, options, onCommit) {
    const select = document.createElement("select");
    select.className = "property-sheet__field-input";
    for (const option of options) {
        const optionEl = document.createElement("option");
        optionEl.value = option.value;
        optionEl.textContent = option.label;
        optionEl.selected = option.value === value;
        select.appendChild(optionEl);
    }
    select.addEventListener("change", () => onCommit(select.value));
    return select;
}
function checkboxRow(labelText, checked, onCommit) {
    const row = document.createElement("label");
    row.className = "property-sheet__check-row";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    input.addEventListener("change", () => onCommit(input.checked));
    const text = document.createElement("span");
    text.textContent = labelText;
    row.append(input, text);
    return row;
}
function actionButton(label, onClick, variant) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `package-editor__button${variant ? ` package-editor__button--${variant}` : ""}`;
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
}
// ── Render principal ───────────────────────────────────────────────────────────────────────────
export function renderPackageEditorView() {
    const state = editorState;
    if (!state) {
        const empty = document.createElement("div");
        return empty;
    }
    const root = document.createElement("div");
    root.className = "package-editor";
    root.appendChild(renderToolbar(state));
    const body = document.createElement("div");
    body.className = "package-editor__body";
    body.appendChild(renderCanvas(state));
    body.appendChild(renderSidebar(state));
    root.appendChild(body);
    return root;
}
function renderToolbar(state) {
    const bar = document.createElement("div");
    bar.className = "package-editor__toolbar";
    const title = document.createElement("div");
    title.className = "package-editor__title";
    title.textContent = `Editando símbolo: ${state.typeId}${state.dirty ? " ●" : ""}`;
    title.title = state.filePath;
    const shapesGroup = document.createElement("div");
    shapesGroup.className = "package-editor__toolbar-group";
    shapesGroup.append(actionButton("+ Retângulo", () => addShape(state, "rect")), actionButton("+ Elipse", () => addShape(state, "ellipse")), actionButton("+ Linha", () => addShape(state, "line")), actionButton("+ Texto", () => addShape(state, "text")));
    const pinGroup = document.createElement("div");
    pinGroup.className = "package-editor__toolbar-group";
    const pinModeButton = actionButton(state.addPinMode ? "Clique na borda do corpo…" : "+ Pino", () => {
        state.addPinMode = !state.addPinMode;
        rerender();
    }, state.addPinMode ? "primary" : undefined);
    pinGroup.append(pinModeButton);
    const actionsGroup = document.createElement("div");
    actionsGroup.className = "package-editor__toolbar-group package-editor__toolbar-group--end";
    actionsGroup.append(actionButton("Cancelar", () => exitEditor()), actionButton("Salvar", () => savePackage(state), "primary"));
    bar.append(title, shapesGroup, pinGroup, actionsGroup);
    return bar;
}
function addShape(state, kind) {
    const cx = state.pkg.width / 2;
    const cy = state.pkg.height / 2;
    let shape;
    switch (kind) {
        case "rect":
            shape = { kind: "rect", x: cx - 15, y: cy - 10, w: 30, h: 20, stroke: "#94a3b8", fill: "none", strokeWidth: 1 };
            break;
        case "ellipse":
            shape = { kind: "ellipse", cx, cy, rx: 12, ry: 12, stroke: "#94a3b8", fill: "none" };
            break;
        case "line":
            shape = { kind: "line", x1: cx - 15, y1: cy, x2: cx + 15, y2: cy, stroke: "#94a3b8" };
            break;
        case "text":
        default:
            shape = { kind: "text", x: cx, y: cy, value: "Texto", fontSize: 11, color: "currentColor" };
            break;
    }
    state.pkg.shapes = [...(state.pkg.shapes ?? []), shape];
    state.selection = { kind: "shape", index: (state.pkg.shapes?.length ?? 1) - 1 };
    markDirty();
    rerender();
}
function rerender() {
    onChangeCallback();
}
// ── Canvas (SVG editável) ──────────────────────────────────────────────────────────────────────
function renderCanvas(state) {
    const wrapper = document.createElement("div");
    wrapper.className = "package-editor__canvas-wrapper";
    const bounds = computeBounds(state.pkg);
    const viewWidth = bounds.maxX - bounds.minX + CANVAS_PADDING * 2;
    const viewHeight = bounds.maxY - bounds.minY + CANVAS_PADDING * 2;
    const offsetX = CANVAS_PADDING - bounds.minX;
    const offsetY = CANVAS_PADDING - bounds.minY;
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.classList.add("package-editor__canvas");
    svg.setAttribute("viewBox", `0 0 ${viewWidth} ${viewHeight}`);
    svg.setAttribute("width", String(viewWidth * DISPLAY_SCALE));
    svg.setAttribute("height", String(viewHeight * DISPLAY_SCALE));
    const root = document.createElementNS(SVG_NS, "g");
    root.setAttribute("transform", `translate(${offsetX},${offsetY})`);
    svg.appendChild(root);
    // Fundo + corpo -- clicar aqui (fora de qualquer forma/pino) limpa seleção, ou adiciona pino se
    // `addPinMode` estiver ativo e o clique cair perto da borda do corpo.
    const bodyRect = document.createElementNS(SVG_NS, "rect");
    bodyRect.setAttribute("x", "0");
    bodyRect.setAttribute("y", "0");
    bodyRect.setAttribute("width", String(state.pkg.width));
    bodyRect.setAttribute("height", String(state.pkg.height));
    bodyRect.setAttribute("class", "package-editor__body-rect");
    bodyRect.setAttribute("fill", backgroundFill(state.pkg.background));
    bodyRect.addEventListener("click", (event) => {
        event.stopPropagation();
        // Em `addPinMode`, o `pointerdown` abaixo já criou o pino e desligou o modo antes deste `click`
        // ser disparado -- nada a fazer aqui além do caminho normal de "clique no fundo limpa seleção".
        if (state.addPinMode)
            return;
        state.selection = undefined;
        rerender();
    });
    // `offsetX/offsetY` do DOM nativo são relativos ao elemento `<svg>`, não ao `<g>` transladado --
    // mais simples calcular a posição local a partir do `pointerdown` com `getBoundingClientRect()`
    // do que depender de `offsetX` (que some atrás do `transform`). Ver `addPinAtPoint` abaixo.
    bodyRect.addEventListener("pointerdown", (event) => {
        if (!state.addPinMode)
            return;
        event.stopPropagation();
        const rect = svg.getBoundingClientRect();
        const localX = (event.clientX - rect.left) / DISPLAY_SCALE - offsetX;
        const localY = (event.clientY - rect.top) / DISPLAY_SCALE - offsetY;
        addPinAtPoint(state, { x: localX, y: localY });
    });
    root.appendChild(bodyRect);
    if (state.pkg.border) {
        const borderRect = document.createElementNS(SVG_NS, "rect");
        borderRect.setAttribute("x", "0.5");
        borderRect.setAttribute("y", "0.5");
        borderRect.setAttribute("width", String(Math.max(0, state.pkg.width - 1)));
        borderRect.setAttribute("height", String(Math.max(0, state.pkg.height - 1)));
        borderRect.setAttribute("class", "package-editor__border-rect");
        root.appendChild(borderRect);
    }
    (state.pkg.shapes ?? []).forEach((shape, index) => {
        root.appendChild(renderEditableShape(state, shape, index));
    });
    state.pkg.pins.forEach((pin, index) => {
        root.appendChild(renderEditablePin(state, pin, index));
    });
    svg.addEventListener("click", () => {
        if (!state.addPinMode) {
            state.selection = undefined;
            rerender();
        }
    });
    wrapper.appendChild(svg);
    const hint = document.createElement("p");
    hint.className = "package-editor__hint";
    hint.textContent = state.addPinMode
        ? "Clique em qualquer ponto perto da borda do corpo pra adicionar um pino ali."
        : "Arraste o corpo cinza (canto) pra redimensionar, formas/pinos pra reposicionar. Clique pra selecionar e editar os campos à direita.";
    wrapper.appendChild(hint);
    // Alças de redimensionar o CORPO (4 cantos) -- só fazem sentido fora do <g> deslocado, porque
    // resize altera width/height, não pin/shape -- mais simples desenhar direto no espaço do <g>
    // mesmo (cantos do corpo são sempre (0,0)-(width,height) ali).
    for (const corner of cornerHandles(state.pkg.width, state.pkg.height)) {
        root.appendChild(renderBodyResizeHandle(state, corner));
    }
    return wrapper;
}
function backgroundFill(background) {
    if (background?.kind === "color" && background.value)
        return background.value;
    return "var(--canvas-bg, #ffffff)";
}
function cornerHandles(width, height) {
    return [
        { x: 0, y: 0, cursor: "nwse-resize", key: "nw" },
        { x: width, y: 0, cursor: "nesw-resize", key: "ne" },
        { x: 0, y: height, cursor: "nesw-resize", key: "sw" },
        { x: width, y: height, cursor: "nwse-resize", key: "se" },
    ];
}
function renderBodyResizeHandle(state, corner) {
    const handle = document.createElementNS(SVG_NS, "rect");
    const size = HANDLE_RADIUS * 1.6;
    handle.setAttribute("x", String(corner.x - size / 2));
    handle.setAttribute("y", String(corner.y - size / 2));
    handle.setAttribute("width", String(size));
    handle.setAttribute("height", String(size));
    handle.setAttribute("class", "package-editor__resize-handle");
    handle.style.cursor = corner.cursor;
    const startWidth = state.pkg.width;
    const startHeight = state.pkg.height;
    handle.addEventListener("pointerdown", (event) => {
        startDrag(event, (dx, dy) => {
            const growX = corner.key === "ne" || corner.key === "se" ? dx : -dx;
            const growY = corner.key === "sw" || corner.key === "se" ? dy : -dy;
            state.pkg.width = Math.max(8, Math.round(startWidth + growX));
            state.pkg.height = Math.max(8, Math.round(startHeight + growY));
            rerender();
        }, () => markDirty());
    });
    return handle;
}
function addPinAtPoint(state, point) {
    const placement = inferPinPlacement(point, state.pkg.width, state.pkg.height);
    const id = nextFreePinId(state.pkg.pins.map((pin) => pin.id));
    const pin = { id, x: Math.round(placement.x), y: Math.round(placement.y), angle: placement.angle, length: 8, label: id };
    state.pkg.pins = [...state.pkg.pins, pin];
    state.selection = { kind: "pin", index: state.pkg.pins.length - 1 };
    state.addPinMode = false;
    markDirty();
    rerender();
}
// ── Formas editáveis ───────────────────────────────────────────────────────────────────────────
function renderEditableShape(state, shape, index) {
    const group = document.createElementNS(SVG_NS, "g");
    group.setAttribute("class", "package-editor__shape");
    const isSelected = state.selection?.kind === "shape" && state.selection.index === index;
    const visual = shapeVisualElement(shape);
    if (isSelected)
        visual.classList.add("package-editor__shape--selected");
    group.appendChild(visual);
    group.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
        state.selection = { kind: "shape", index };
        rerender();
        const origin = shapeOrigin(shape);
        startDrag(event, (dx, dy) => {
            applyShapeOrigin(shape, { x: origin.x + dx, y: origin.y + dy });
            rerender();
        }, () => markDirty());
    });
    return group;
}
function shapeVisualElement(shape) {
    switch (shape.kind) {
        case "rect": {
            const el = document.createElementNS(SVG_NS, "rect");
            el.setAttribute("x", String(shape.x ?? 0));
            el.setAttribute("y", String(shape.y ?? 0));
            el.setAttribute("width", String(shape.w ?? 0));
            el.setAttribute("height", String(shape.h ?? 0));
            el.setAttribute("stroke", shape.stroke ?? "currentColor");
            el.setAttribute("fill", shape.fill ?? "none");
            el.setAttribute("stroke-width", String(shape.strokeWidth ?? 1));
            return el;
        }
        case "ellipse": {
            const el = document.createElementNS(SVG_NS, "ellipse");
            el.setAttribute("cx", String(shape.cx ?? 0));
            el.setAttribute("cy", String(shape.cy ?? 0));
            el.setAttribute("rx", String(shape.rx ?? 0));
            el.setAttribute("ry", String(shape.ry ?? 0));
            el.setAttribute("stroke", shape.stroke ?? "currentColor");
            el.setAttribute("fill", shape.fill ?? "none");
            return el;
        }
        case "line": {
            const el = document.createElementNS(SVG_NS, "line");
            el.setAttribute("x1", String(shape.x1 ?? 0));
            el.setAttribute("y1", String(shape.y1 ?? 0));
            el.setAttribute("x2", String(shape.x2 ?? 0));
            el.setAttribute("y2", String(shape.y2 ?? 0));
            el.setAttribute("stroke", shape.stroke ?? "currentColor");
            el.setAttribute("stroke-width", "2");
            return el;
        }
        case "text":
        default: {
            const el = document.createElementNS(SVG_NS, "text");
            el.setAttribute("x", String(shape.x ?? 0));
            el.setAttribute("y", String(shape.y ?? 0));
            el.setAttribute("text-anchor", "middle");
            el.setAttribute("font-size", String(shape.fontSize ?? 11));
            el.setAttribute("fill", shape.color ?? "currentColor");
            el.textContent = shape.value ?? "";
            return el;
        }
    }
}
// ── Pinos editáveis ────────────────────────────────────────────────────────────────────────────
function renderEditablePin(state, pin, index) {
    const group = document.createElementNS(SVG_NS, "g");
    group.setAttribute("class", "package-editor__pin");
    const isSelected = state.selection?.kind === "pin" && state.selection.index === index;
    const tip = pinTip(pin);
    const lead = document.createElementNS(SVG_NS, "line");
    lead.setAttribute("x1", String(pin.x));
    lead.setAttribute("y1", String(pin.y));
    lead.setAttribute("x2", String(tip.x));
    lead.setAttribute("y2", String(tip.y));
    lead.setAttribute("class", `package-editor__pin-lead${isSelected ? " package-editor__pin-lead--selected" : ""}`);
    group.appendChild(lead);
    const label = document.createElementNS(SVG_NS, "text");
    const labelOffset = 9;
    const rad = (pin.angle * Math.PI) / 180;
    label.setAttribute("x", String(tip.x + Math.cos(rad) * labelOffset));
    label.setAttribute("y", String(tip.y + Math.sin(rad) * labelOffset));
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("class", "package-editor__pin-label");
    label.textContent = pin.label ?? pin.id;
    group.appendChild(label);
    // Alça do ANCORA (toca o corpo) -- arrastar reposiciona x/y livremente; ângulo só muda quando o
    // usuário arrasta a PONTA (alça menor abaixo), nunca recalculado automaticamente aqui, pra não
    // "lutar" com o gesto do usuário no meio do arrasto.
    const anchorHandle = document.createElementNS(SVG_NS, "circle");
    anchorHandle.setAttribute("cx", String(pin.x));
    anchorHandle.setAttribute("cy", String(pin.y));
    anchorHandle.setAttribute("r", String(HANDLE_RADIUS));
    anchorHandle.setAttribute("class", `package-editor__pin-anchor${isSelected ? " package-editor__pin-anchor--selected" : ""}`);
    anchorHandle.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
        state.selection = { kind: "pin", index };
        rerender();
        const startX = pin.x;
        const startY = pin.y;
        startDrag(event, (dx, dy) => {
            pin.x = Math.round(startX + dx);
            pin.y = Math.round(startY + dy);
            rerender();
        }, () => markDirty());
    });
    group.appendChild(anchorHandle);
    // Alça da PONTA -- arrastar recalcula angle/length via atan2/distância (dá controle total sobre
    // os dois sem precisar de campo numérico, embora os campos também existam na barra lateral).
    const tipHandle = document.createElementNS(SVG_NS, "circle");
    tipHandle.setAttribute("cx", String(tip.x));
    tipHandle.setAttribute("cy", String(tip.y));
    tipHandle.setAttribute("r", String(HANDLE_RADIUS * 0.7));
    tipHandle.setAttribute("class", "package-editor__pin-tip");
    tipHandle.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
        state.selection = { kind: "pin", index };
        rerender();
        const startTip = { x: tip.x, y: tip.y };
        startDrag(event, (dx, dy) => {
            const nextX = startTip.x + dx;
            const nextY = startTip.y + dy;
            const ddx = nextX - pin.x;
            const ddy = nextY - pin.y;
            const length = Math.hypot(ddx, ddy);
            if (length < 1)
                return; // evita angle indefinido quando a ponta cai sobre a âncora
            pin.length = Math.round(length);
            pin.angle = Math.round((Math.atan2(ddy, ddx) * 180) / Math.PI);
            rerender();
        }, () => markDirty());
    });
    group.appendChild(tipHandle);
    return group;
}
// ── Barra lateral (corpo / forma selecionada / pino selecionado) ─────────────────────────────────
function renderSidebar(state) {
    const sidebar = document.createElement("aside");
    sidebar.className = "package-editor__sidebar";
    if (state.selection?.kind === "shape") {
        const shape = state.pkg.shapes?.[state.selection.index];
        if (shape) {
            sidebar.appendChild(renderShapeSidebar(state, shape, state.selection.index));
            return sidebar;
        }
    }
    if (state.selection?.kind === "pin") {
        const pin = state.pkg.pins[state.selection.index];
        if (pin) {
            sidebar.appendChild(renderPinSidebar(state, pin, state.selection.index));
            return sidebar;
        }
    }
    sidebar.appendChild(renderBodySidebar(state));
    return sidebar;
}
function sidebarHeading(text) {
    const heading = document.createElement("h3");
    heading.className = "package-editor__sidebar-heading";
    heading.textContent = text;
    return heading;
}
function renderBodySidebar(state) {
    const section = document.createElement("div");
    section.className = "package-editor__sidebar-section";
    section.appendChild(sidebarHeading("Corpo do símbolo"));
    section.appendChild(fieldRow("Largura", numberInput(state.pkg.width, (next) => { state.pkg.width = Math.max(8, Math.round(next)); markDirty(); rerender(); })));
    section.appendChild(fieldRow("Altura", numberInput(state.pkg.height, (next) => { state.pkg.height = Math.max(8, Math.round(next)); markDirty(); rerender(); })));
    section.appendChild(checkboxRow("Borda", state.pkg.border ?? false, (next) => { state.pkg.border = next; markDirty(); rerender(); }));
    section.appendChild(sidebarHeading("Fundo"));
    const backgroundKind = state.pkg.background?.kind ?? "none";
    section.appendChild(fieldRow("Tipo", selectInput(backgroundKind, [
        { value: "none", label: "Nenhum" },
        { value: "color", label: "Cor sólida" },
        { value: "image", label: "Imagem (PNG/JPEG)" },
        { value: "svg", label: "SVG inline" },
    ], (next) => {
        if (next === "none")
            state.pkg.background = undefined;
        else
            state.pkg.background = { kind: next, value: state.pkg.background?.value, data: state.pkg.background?.data };
        markDirty();
        rerender();
    })));
    if (backgroundKind === "color") {
        section.appendChild(fieldRow("Cor", colorInput(state.pkg.background?.value ?? "#ffffff", (next) => {
            state.pkg.background = { kind: "color", value: next };
            markDirty();
            rerender();
        })));
    }
    if (backgroundKind === "image" || backgroundKind === "svg") {
        const status = document.createElement("p");
        status.className = "package-editor__hint";
        status.textContent = state.pkg.background?.data
            ? "Imagem carregada."
            : "Nenhuma imagem carregada ainda.";
        section.appendChild(status);
        section.appendChild(actionButton("Carregar imagem…", () => {
            sendMessage({ version: WEBVIEW_MESSAGE_VERSION, type: "requestPickPackageBackgroundImage" });
        }));
    }
    section.appendChild(sidebarHeading("Pinos elétricos ainda sem símbolo"));
    const declaredIds = new Set(state.pkg.pins.map((pin) => pin.id));
    const missing = state.knownPinIds.filter((id) => !declaredIds.has(id));
    if (state.knownPinIds.length === 0) {
        const note = document.createElement("p");
        note.className = "package-editor__hint";
        note.textContent = "Sem lista estática de pinos pra este typeId (normal para adaptador de MCU — os pinos vêm do plugin em runtime). Adicione pelo id real mesmo assim, com \"+ Pino\".";
        section.appendChild(note);
    }
    else if (missing.length === 0) {
        const note = document.createElement("p");
        note.className = "package-editor__hint";
        note.textContent = "Todos os pinos elétricos já têm um símbolo no package.";
        section.appendChild(note);
    }
    else {
        const list = document.createElement("ul");
        list.className = "package-editor__missing-pins";
        for (const id of missing) {
            const item = document.createElement("li");
            item.textContent = id;
            list.appendChild(item);
        }
        section.appendChild(list);
    }
    return section;
}
function renderShapeSidebar(state, shape, index) {
    const section = document.createElement("div");
    section.className = "package-editor__sidebar-section";
    section.appendChild(sidebarHeading(`Forma: ${shapeKindLabel(shape.kind)}`));
    const commit = () => { markDirty(); rerender(); };
    if (shape.kind === "rect") {
        section.appendChild(fieldRow("X", numberInput(shape.x ?? 0, (v) => { shape.x = v; commit(); })));
        section.appendChild(fieldRow("Y", numberInput(shape.y ?? 0, (v) => { shape.y = v; commit(); })));
        section.appendChild(fieldRow("Largura", numberInput(shape.w ?? 0, (v) => { shape.w = v; commit(); })));
        section.appendChild(fieldRow("Altura", numberInput(shape.h ?? 0, (v) => { shape.h = v; commit(); })));
        section.appendChild(fieldRow("Cor da borda", colorInput(shape.stroke ?? "#94a3b8", (v) => { shape.stroke = v; commit(); })));
        section.appendChild(fieldRow("Cor de preenchimento", colorInput(shape.fill === "none" ? "#ffffff" : (shape.fill ?? "#ffffff"), (v) => { shape.fill = v; commit(); })));
        section.appendChild(checkboxRow("Sem preenchimento", shape.fill === undefined || shape.fill === "none", (checked) => { shape.fill = checked ? "none" : "#ffffff"; commit(); }));
    }
    else if (shape.kind === "ellipse") {
        section.appendChild(fieldRow("Centro X", numberInput(shape.cx ?? 0, (v) => { shape.cx = v; commit(); })));
        section.appendChild(fieldRow("Centro Y", numberInput(shape.cy ?? 0, (v) => { shape.cy = v; commit(); })));
        section.appendChild(fieldRow("Raio X", numberInput(shape.rx ?? 0, (v) => { shape.rx = v; commit(); })));
        section.appendChild(fieldRow("Raio Y", numberInput(shape.ry ?? 0, (v) => { shape.ry = v; commit(); })));
        section.appendChild(fieldRow("Cor da borda", colorInput(shape.stroke ?? "#94a3b8", (v) => { shape.stroke = v; commit(); })));
    }
    else if (shape.kind === "line") {
        section.appendChild(fieldRow("X1", numberInput(shape.x1 ?? 0, (v) => { shape.x1 = v; commit(); })));
        section.appendChild(fieldRow("Y1", numberInput(shape.y1 ?? 0, (v) => { shape.y1 = v; commit(); })));
        section.appendChild(fieldRow("X2", numberInput(shape.x2 ?? 0, (v) => { shape.x2 = v; commit(); })));
        section.appendChild(fieldRow("Y2", numberInput(shape.y2 ?? 0, (v) => { shape.y2 = v; commit(); })));
        section.appendChild(fieldRow("Cor", colorInput(shape.stroke ?? "#94a3b8", (v) => { shape.stroke = v; commit(); })));
    }
    else {
        section.appendChild(fieldRow("X", numberInput(shape.x ?? 0, (v) => { shape.x = v; commit(); })));
        section.appendChild(fieldRow("Y", numberInput(shape.y ?? 0, (v) => { shape.y = v; commit(); })));
        section.appendChild(fieldRow("Texto", textInput(shape.value ?? "", (v) => { shape.value = v; commit(); })));
        section.appendChild(fieldRow("Tamanho da fonte", numberInput(shape.fontSize ?? 11, (v) => { shape.fontSize = v; commit(); })));
        section.appendChild(fieldRow("Cor", colorInput(normalizeColorForInput(shape.color), (v) => { shape.color = v; commit(); })));
    }
    section.appendChild(actionButton("Excluir forma", () => {
        state.pkg.shapes = (state.pkg.shapes ?? []).filter((_, i) => i !== index);
        state.selection = undefined;
        commit();
    }, "danger"));
    return section;
}
function normalizeColorForInput(value) {
    return value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#000000";
}
function shapeKindLabel(kind) {
    switch (kind) {
        case "rect": return "retângulo";
        case "ellipse": return "elipse";
        case "line": return "linha";
        case "text": return "texto";
        default: return kind;
    }
}
function renderPinSidebar(state, pin, index) {
    const section = document.createElement("div");
    section.className = "package-editor__sidebar-section";
    section.appendChild(sidebarHeading("Pino"));
    const commit = () => { markDirty(); rerender(); };
    const idsInUse = new Set(state.pkg.pins.filter((_, i) => i !== index).map((p) => p.id));
    if (state.knownPinIds.length > 0 && !state.knownPinIds.includes(pin.id)) {
        const warning = document.createElement("p");
        warning.className = "package-editor__hint package-editor__hint--warning";
        warning.textContent = `"${pin.id}" não está na lista de pinos elétricos conhecidos deste typeId — confira o id antes de salvar.`;
        section.appendChild(warning);
    }
    section.appendChild(fieldRow("Id (pino real)", textInput(pin.id, (next) => {
        const trimmed = next.trim();
        if (!trimmed || idsInUse.has(trimmed))
            return;
        pin.id = trimmed;
        commit();
    })));
    section.appendChild(fieldRow("Rótulo", textInput(pin.label ?? pin.id, (next) => { pin.label = next; commit(); })));
    section.appendChild(fieldRow("X (âncora)", numberInput(pin.x, (v) => { pin.x = v; commit(); })));
    section.appendChild(fieldRow("Y (âncora)", numberInput(pin.y, (v) => { pin.y = v; commit(); })));
    section.appendChild(fieldRow("Ângulo (graus)", numberInput(pin.angle, (v) => { pin.angle = v; commit(); }, 15)));
    section.appendChild(fieldRow("Comprimento do lead", numberInput(pin.length, (v) => { pin.length = Math.max(1, v); commit(); })));
    section.appendChild(actionButton("Excluir pino", () => {
        state.pkg.pins = state.pkg.pins.filter((_, i) => i !== index);
        state.selection = undefined;
        commit();
    }, "danger"));
    return section;
}
// ── Salvar ─────────────────────────────────────────────────────────────────────────────────────
function savePackage(state) {
    sendMessage({
        version: WEBVIEW_MESSAGE_VERSION,
        type: "requestSavePackage",
        filePath: state.filePath,
        package: clonePackage(state.pkg),
    });
}
/** Chamado pelo handler de `"packageSaved"` em `main.ts` -- confirma que o arquivo foi escrito,
 * tira a marca de "não salvo" do título, mas continua no modo de edição (usuário decide quando
 * sair, via "Cancelar" -- que nesse ponto já não descartaria nada não salvo). */
export function markPackageSaved() {
    if (editorState)
        editorState.dirty = false;
}
/** Chamado pelo handler de `"packageBackgroundImageLoaded"` em `main.ts`. */
export function applyLoadedBackgroundImage(kind, data) {
    if (!editorState)
        return;
    editorState.pkg.background = { kind, data };
    markDirty();
}
//# sourceMappingURL=packageEditor.js.map