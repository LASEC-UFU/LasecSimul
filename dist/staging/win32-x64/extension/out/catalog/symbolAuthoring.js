"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.seedSymbolAuthoringComponents = seedSymbolAuthoringComponents;
exports.compileSymbolAuthoringComponents = compileSymbolAuthoringComponents;
/**
 * Conversão pura entre `PackageDescriptor` (o que fica salvo no `package` de um
 * `device.json`/`mcu.json`/`.lssub.json`) e uma lista de `WebviewComponentModel` (o que aparece na
 * sessão de autoria de símbolo, ver `.spec/lasecsimul-native-devices.spec` seção 21.3 e
 * `main.ts::enterSymbolAuthoring`). Mesma ideia do SimulIDE real: `other.package`/`graphics.*`/
 * `other.package_pin` são componentes comuns colocados no canvas; "compilar" é só ler de volta a
 * posição/rotação/propriedades de cada um.
 *
 * Convenção geométrica (mesma de `componentSymbols.ts`): `component.x/y` é o canto superior-esquerdo
 * da caixa do componente (`componentBox`); `component.rotation` (0/90/180/270, CSS) faz o papel do
 * `angle` de um `PackagePin`/orientação de uma `graphics.line` -- por isso só ângulos múltiplos de
 * 90° sobrevivem ao round-trip visual (ver `snapRotation`). Cada conversão (seed/compile) é a
 * INVERSA exata da outra quando a caixa do tipo é determinística a partir das mesmas propriedades
 * (rect/ellipse/pino: sim, sempre; texto: sim, desde que o conteúdo não mude entre seed e compile;
 * linha: perde precisão de ângulo não-cardinal, ver `snapRotation`).
 */
const componentSymbols_1 = require("../ui/webview/componentSymbols");
function nextComponentId(prefix, index) {
    return `symbol-${prefix}-${index}`;
}
function baseComponent(id, typeId, x, y, rotation, properties) {
    return { id, typeId, label: typeId, hidden: false, x: Math.round(x), y: Math.round(y), rotation, pins: [], properties };
}
/** Ângulo real (graus, qualquer valor) -> o múltiplo de 90° mais próximo -- `component.rotation` só
 * aceita 4 valores. Pinos/formas autorados visualmente sempre caem exatamente num desses 4 (toda
 * rotação parte de 0 e só gira em passos de 90°), então isto só perde precisão pra packages escritos
 * à mão com ângulo não-cardinal (nenhum dos 3 exemplos reais do projeto faz isso hoje). */
function snapRotation(angleDegrees) {
    const normalized = ((Math.round(angleDegrees / 90) * 90) % 360 + 360) % 360;
    return normalized;
}
/** Constrói a lista de componentes pra semear a sessão de autoria a partir de um `package` já
 * existente (ou em branco, ver `extension.ts::extractPackageForEditing`). `originX`/`originY` é
 * onde o `other.package` (e portanto a origem `(0,0)` do package) fica no canvas -- arbitrário,
 * escolhido só pra dar folga visual em volta. */
function seedSymbolAuthoringComponents(pkg, originX = 140, originY = 140) {
    const components = [];
    const packageProperties = { width: pkg.width, height: pkg.height, border: pkg.border ?? true };
    if (pkg.background?.kind === "color" && pkg.background.value)
        packageProperties.backgroundColor = pkg.background.value;
    components.push(baseComponent(nextComponentId("package", 0), "other.package", originX, originY, 0, packageProperties));
    (pkg.shapes ?? []).forEach((shape, index) => {
        const component = seedShapeComponent(shape, index, originX, originY);
        if (component)
            components.push(component);
    });
    pkg.pins.forEach((pin, index) => {
        const properties = { pinId: pin.id, length: pin.length };
        const box = (0, componentSymbols_1.componentBox)("other.package_pin", properties);
        const pinComponentId = nextComponentId("pin", index);
        components.push(baseComponent(pinComponentId, "other.package_pin", originX + pin.x - box.width / 2, originY + pin.y - box.height / 2, snapRotation(pin.angle), properties));
        components.push(seedPinLabelComponent(pin, pinComponentId, index, originX, originY));
    });
    return components;
}
/** Rótulo do pino -- SEMPRE um `graphics.text` vinculado (`linkedPinComponentId`), nunca desenhado
 * pelo próprio `other.package_pin` (ver `componentSymbols.ts`) -- arrastável independente da posição
 * do pino, igual ao SimulIDE real. Sem `pin.labelX`/`labelY` (package nunca editado assim antes),
 * cai na MESMA posição padrão que o renderizador de leitura sempre calculou (ponta do lead + 9
 * unidades na direção do `angle`) -- abrir e salvar sem mover nada reproduz o `package` idêntico. */
function seedPinLabelComponent(pin, pinComponentId, index, originX, originY) {
    const rad = (pin.angle * Math.PI) / 180;
    const tipX = pin.x + Math.cos(rad) * pin.length;
    const tipY = pin.y + Math.sin(rad) * pin.length;
    // `labelX`/`labelY` (e a fórmula padrão de fallback) são a posição EXATA da baseline do `<text>`
    // que `packagePinLeadSvg` desenha (`x=labelX y=labelY` direto) -- mesma convenção do `shape.y` de
    // um `PackageShape` kind "text" em `packageShapeSvg`, por isso o mesmo ajuste de `fontSize/3` pra
    // converter baseline -> centro da caixa (ver `seedShapeComponent`/`case "text"` abaixo e a
    // compilação espelhada em `compileSymbolAuthoringComponents`).
    const labelX = pin.labelX ?? tipX + Math.cos(rad) * 9;
    const labelY = pin.labelY ?? tipY + Math.sin(rad) * 9;
    const text = pin.label ?? pin.id;
    const fontSize = 7;
    const properties = { text, fontSize, color: "#1f2937", linkedPinComponentId: pinComponentId };
    const box = (0, componentSymbols_1.componentBox)("graphics.text", properties);
    const centerX = labelX;
    const centerY = labelY - fontSize / 3;
    return baseComponent(nextComponentId("pin-label", index), "graphics.text", originX + centerX - box.width / 2, originY + centerY - box.height / 2, 0, properties);
}
function seedShapeComponent(shape, index, originX, originY) {
    switch (shape.kind) {
        case "rect": {
            const properties = { width: shape.w ?? 0, height: shape.h ?? 0, stroke: shape.stroke ?? "#94a3b8", fill: shape.fill ?? "none", strokeWidth: shape.strokeWidth ?? 1 };
            return baseComponent(nextComponentId("shape", index), "graphics.rectangle", originX + (shape.x ?? 0), originY + (shape.y ?? 0), 0, properties);
        }
        case "ellipse": {
            const rx = shape.rx ?? 0;
            const ry = shape.ry ?? 0;
            const properties = { width: rx * 2, height: ry * 2, stroke: shape.stroke ?? "#94a3b8", fill: shape.fill ?? "none" };
            return baseComponent(nextComponentId("shape", index), "graphics.ellipse", originX + (shape.cx ?? 0) - rx, originY + (shape.cy ?? 0) - ry, 0, properties);
        }
        case "line": {
            const x1 = shape.x1 ?? 0;
            const y1 = shape.y1 ?? 0;
            const x2 = shape.x2 ?? 0;
            const y2 = shape.y2 ?? 0;
            const midX = (x1 + x2) / 2;
            const midY = (y1 + y2) / 2;
            const length = Math.hypot(x2 - x1, y2 - y1);
            const angle = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
            const properties = { length, stroke: shape.stroke ?? "#94a3b8" };
            const box = (0, componentSymbols_1.componentBox)("graphics.line", properties);
            return baseComponent(nextComponentId("shape", index), "graphics.line", originX + midX - box.width / 2, originY + midY - box.height / 2, snapRotation(angle), properties);
        }
        case "text": {
            const fontSize = shape.fontSize ?? 11;
            const properties = { text: shape.value ?? "", fontSize, color: shape.color ?? "#1f2937" };
            const box = (0, componentSymbols_1.componentBox)("graphics.text", properties);
            const centerX = shape.x ?? 0;
            const centerY = (shape.y ?? 0) - fontSize / 3;
            return baseComponent(nextComponentId("shape", index), "graphics.text", originX + centerX - box.width / 2, originY + centerY - box.height / 2, 0, properties);
        }
        default:
            return undefined;
    }
}
/** Inverso de `seedSymbolAuthoringComponents` -- varre a sessão de autoria (todo `state.components`
 * no momento de "Salvar Símbolo") e reconstrói o `PackageDescriptor`. `existingBackground` é o
 * `background` ATUAL no disco (relido fresco, ver `extension.ts::saveSymbolCommand`) -- preservado
 * verbatim quando não é `"color"` (svg/image ainda não tem UI de upload nesta sessão de autoria,
 * perder esse dado ao salvar seria uma regressão silenciosa, não uma limitação aceitável). */
function compileSymbolAuthoringComponents(components, existingBackground) {
    const packages = components.filter((component) => component.typeId === "other.package");
    if (packages.length === 0)
        return { error: "Nenhum componente \"Pacote\" (other.package) na sessão -- adicione um pra definir o corpo do símbolo." };
    if (packages.length > 1)
        return { error: "Mais de um componente \"Pacote\" (other.package) na sessão -- deixe só um." };
    const packageComponent = packages[0];
    const originX = packageComponent.x;
    const originY = packageComponent.y;
    const width = typeof packageComponent.properties.width === "number" ? packageComponent.properties.width : 80;
    const height = typeof packageComponent.properties.height === "number" ? packageComponent.properties.height : 60;
    const border = packageComponent.properties.border !== false;
    const backgroundColor = typeof packageComponent.properties.backgroundColor === "string" ? packageComponent.properties.backgroundColor : undefined;
    const background = backgroundColor
        ? { kind: "color", value: backgroundColor }
        : existingBackground && existingBackground.kind !== "color" && existingBackground.kind !== "none"
            ? existingBackground
            : undefined;
    // Rótulo de pino é um `graphics.text` vinculado por `linkedPinComponentId` (id ESTÁVEL do
    // componente do pino, ver `main.ts::componentsToAddForTypeId`) -- precisa ser identificado ANTES
    // do laço principal, pra (a) não cair também em `shapes[]` como texto decorativo genérico e
    // (b) fornecer `label`/`labelX`/`labelY` reais pro `PackagePin` correspondente.
    const linkedLabelByPinComponentId = new Map();
    for (const component of components) {
        const linkedId = component.properties.linkedPinComponentId;
        if (component.typeId === "graphics.text" && typeof linkedId === "string") {
            linkedLabelByPinComponentId.set(linkedId, component);
        }
    }
    const shapes = [];
    const pins = [];
    for (const component of components) {
        if (component.typeId === "other.package")
            continue;
        if (component.typeId === "graphics.text" && typeof component.properties.linkedPinComponentId === "string")
            continue;
        const localX = component.x - originX;
        const localY = component.y - originY;
        if (component.typeId === "graphics.rectangle") {
            const w = typeof component.properties.width === "number" ? component.properties.width : 0;
            const h = typeof component.properties.height === "number" ? component.properties.height : 0;
            shapes.push({
                kind: "rect",
                x: localX,
                y: localY,
                w,
                h,
                stroke: typeof component.properties.stroke === "string" ? component.properties.stroke : undefined,
                fill: typeof component.properties.fill === "string" ? component.properties.fill : undefined,
                strokeWidth: typeof component.properties.strokeWidth === "number" ? component.properties.strokeWidth : undefined,
            });
        }
        else if (component.typeId === "graphics.ellipse") {
            const w = typeof component.properties.width === "number" ? component.properties.width : 0;
            const h = typeof component.properties.height === "number" ? component.properties.height : 0;
            shapes.push({
                kind: "ellipse",
                cx: localX + w / 2,
                cy: localY + h / 2,
                rx: w / 2,
                ry: h / 2,
                stroke: typeof component.properties.stroke === "string" ? component.properties.stroke : undefined,
                fill: typeof component.properties.fill === "string" ? component.properties.fill : undefined,
            });
        }
        else if (component.typeId === "graphics.line") {
            const box = (0, componentSymbols_1.componentBox)("graphics.line", component.properties);
            const length = typeof component.properties.length === "number" ? component.properties.length : 40;
            const midX = localX + box.width / 2;
            const midY = localY + box.height / 2;
            const rad = (component.rotation * Math.PI) / 180;
            const dx = (Math.cos(rad) * length) / 2;
            const dy = (Math.sin(rad) * length) / 2;
            shapes.push({
                kind: "line",
                x1: midX - dx,
                y1: midY - dy,
                x2: midX + dx,
                y2: midY + dy,
                stroke: typeof component.properties.stroke === "string" ? component.properties.stroke : undefined,
            });
        }
        else if (component.typeId === "graphics.text") {
            const box = (0, componentSymbols_1.componentBox)("graphics.text", component.properties);
            const fontSize = typeof component.properties.fontSize === "number" ? component.properties.fontSize : 11;
            shapes.push({
                kind: "text",
                x: localX + box.width / 2,
                y: localY + box.height / 2 + fontSize / 3,
                value: typeof component.properties.text === "string" ? component.properties.text : "",
                fontSize,
                color: typeof component.properties.color === "string" ? component.properties.color : undefined,
            });
        }
        else if (component.typeId === "other.package_pin") {
            const box = (0, componentSymbols_1.componentBox)("other.package_pin", component.properties);
            const id = typeof component.properties.pinId === "string" && component.properties.pinId.trim() ? component.properties.pinId.trim() : `pin${pins.length + 1}`;
            const pin = {
                id,
                x: localX + box.width / 2,
                y: localY + box.height / 2,
                angle: component.rotation,
                length: typeof component.properties.length === "number" ? component.properties.length : 8,
            };
            const linkedLabel = linkedLabelByPinComponentId.get(component.id);
            if (linkedLabel) {
                const labelBox = (0, componentSymbols_1.componentBox)("graphics.text", linkedLabel.properties);
                const labelFontSize = typeof linkedLabel.properties.fontSize === "number" ? linkedLabel.properties.fontSize : 7;
                pin.label = typeof linkedLabel.properties.text === "string" ? linkedLabel.properties.text : undefined;
                pin.labelX = linkedLabel.x - originX + labelBox.width / 2;
                pin.labelY = linkedLabel.y - originY + labelBox.height / 2 + labelFontSize / 3;
            }
            pins.push(pin);
        }
    }
    return { package: { width, height, border, background, shapes, pins } };
}
//# sourceMappingURL=symbolAuthoring.js.map