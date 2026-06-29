"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const MockCoreServer_1 = require("../ipc/testSupport/MockCoreServer");
const symbolAuthoring_1 = require("./symbolAuthoring");
(async () => {
    const { test, finish } = (0, MockCoreServer_1.createTestRunner)("symbolAuthoring — seed/compile entre package e componentes (Épico G, escrita)");
    await test("seed: package em branco gera só o componente other.package", () => {
        const pkg = { width: 80, height: 60, border: true, pins: [] };
        const components = (0, symbolAuthoring_1.seedSymbolAuthoringComponents)(pkg);
        (0, MockCoreServer_1.assert)(components.length === 1, `esperado 1 componente, recebido ${components.length}`);
        (0, MockCoreServer_1.assert)(components[0].typeId === "other.package", "único componente deveria ser other.package");
        (0, MockCoreServer_1.assert)(components[0].properties.width === 80 && components[0].properties.height === 60, "width/height deveriam vir do package");
    });
    await test("seed: rect/ellipse/line/text/pin geram um componente cada", () => {
        const pkg = {
            width: 100,
            height: 80,
            border: true,
            shapes: [
                { kind: "rect", x: 10, y: 10, w: 20, h: 15 },
                { kind: "ellipse", cx: 50, cy: 40, rx: 8, ry: 6 },
                { kind: "line", x1: 0, y1: 0, x2: 20, y2: 0 },
                { kind: "text", x: 50, y: 50, value: "ESP32", fontSize: 11 },
            ],
            pins: [{ id: "GPIO2", x: 0, y: 20, angle: 180, length: 8, label: "G2" }],
        };
        const components = (0, symbolAuthoring_1.seedSymbolAuthoringComponents)(pkg);
        // 1 package + 4 shapes + 1 pino + 1 rótulo de pino (graphics.text vinculado, sempre semeado
        // junto -- ver seedPinLabelComponent) = 7.
        (0, MockCoreServer_1.assert)(components.length === 7, `esperado 1 package + 4 shapes + 1 pin + 1 rótulo = 7, recebido ${components.length}`);
        const rect = components.find((c) => c.typeId === "graphics.rectangle");
        (0, MockCoreServer_1.assert)(Boolean(rect) && rect.properties.width === 20 && rect.properties.height === 15, "rect deveria preservar w/h");
        const pin = components.find((c) => c.typeId === "other.package_pin");
        (0, MockCoreServer_1.assert)(Boolean(pin) && pin.properties.pinId === "GPIO2" && pin.rotation === 180, "pino deveria preservar id e ângulo (180 já é cardinal)");
        const decorativeTexts = components.filter((c) => c.typeId === "graphics.text" && !c.properties.linkedPinComponentId);
        (0, MockCoreServer_1.assert)(decorativeTexts.length === 1 && decorativeTexts[0].properties.text === "ESP32", "o graphics.text DECORATIVO (não vinculado) deveria ser só o do shape kind text original");
        const pinLabel = components.find((c) => c.typeId === "graphics.text" && c.properties.linkedPinComponentId === pin.id);
        (0, MockCoreServer_1.assert)(Boolean(pinLabel) && pinLabel.properties.text === "G2", "deveria existir um graphics.text vinculado ao pino com o texto do rótulo");
    });
    await test("seed: pino com âncora no CENTRO da caixa (ponto invariante sob rotação)", () => {
        const pkg = { width: 60, height: 40, pins: [{ id: "p1", x: 0, y: 20, angle: 180, length: 8 }] };
        const components = (0, symbolAuthoring_1.seedSymbolAuthoringComponents)(pkg, 0, 0);
        const pin = components.find((c) => c.typeId === "other.package_pin");
        const boxSide = Math.max(24, 8 * 2 + 16); // mesma fórmula de propertyDrivenBox
        (0, MockCoreServer_1.assert)(pin.x + boxSide / 2 === 0 && pin.y + boxSide / 2 === 20, `âncora deveria reconstruir pra {0,20} a partir do centro, recebido x+side/2=${pin.x + boxSide / 2}`);
    });
    await test("compile: sem nenhum other.package devolve erro, não lança exceção", () => {
        const result = (0, symbolAuthoring_1.compileSymbolAuthoringComponents)([], undefined);
        (0, MockCoreServer_1.assert)(result.package === undefined, "não deveria compilar package nenhum");
        (0, MockCoreServer_1.assert)(typeof result.error === "string" && result.error.length > 0, "deveria ter mensagem de erro");
    });
    await test("compile: mais de um other.package devolve erro", () => {
        const pkg = { width: 80, height: 60, pins: [] };
        const components = (0, symbolAuthoring_1.seedSymbolAuthoringComponents)(pkg);
        components.push({ ...components[0], id: "outro-package" });
        const result = (0, symbolAuthoring_1.compileSymbolAuthoringComponents)(components, undefined);
        (0, MockCoreServer_1.assert)(result.package === undefined && Boolean(result.error), "dois other.package deveria falhar");
    });
    await test("round-trip: seed então compile reproduz width/height/pino/forma sem perda", () => {
        const original = {
            width: 100,
            height: 80,
            border: true,
            shapes: [{ kind: "rect", x: 10, y: 10, w: 20, h: 15, stroke: "#94a3b8", fill: "none", strokeWidth: 1 }],
            pins: [{ id: "GPIO2", x: 0, y: 20, angle: 180, length: 8, label: "G2" }],
        };
        const components = (0, symbolAuthoring_1.seedSymbolAuthoringComponents)(original);
        const result = (0, symbolAuthoring_1.compileSymbolAuthoringComponents)(components, undefined);
        (0, MockCoreServer_1.assert)(Boolean(result.package), "deveria compilar com sucesso");
        const compiled = result.package;
        (0, MockCoreServer_1.assert)(compiled.width === original.width && compiled.height === original.height, "width/height deveriam sobreviver ao round-trip");
        (0, MockCoreServer_1.assert)(compiled.pins.length === 1 && compiled.pins[0].id === "GPIO2" && compiled.pins[0].angle === 180 && compiled.pins[0].length === 8, "pino deveria sobreviver ao round-trip");
        (0, MockCoreServer_1.assert)(compiled.pins[0].label === "G2", "rótulo do pino deveria sobreviver ao round-trip (via graphics.text vinculado)");
        (0, MockCoreServer_1.assert)(compiled.shapes?.length === 1 && compiled.shapes[0].kind === "rect" && compiled.shapes[0].w === 20 && compiled.shapes[0].h === 15, "forma rect deveria sobreviver ao round-trip");
    });
    await test("round-trip: rótulo de pino arrastado pra posição própria (labelX/labelY) sobrevive", () => {
        const original = {
            width: 100,
            height: 80,
            pins: [{ id: "GPIO2", x: 0, y: 20, angle: 180, length: 8, label: "G2", labelX: 50, labelY: 40 }],
        };
        const components = (0, symbolAuthoring_1.seedSymbolAuthoringComponents)(original);
        const result = (0, symbolAuthoring_1.compileSymbolAuthoringComponents)(components, undefined);
        (0, MockCoreServer_1.assert)(Boolean(result.package), "deveria compilar com sucesso");
        const pin = result.package.pins[0];
        // Tolerância de 1 unidade -- `baseComponent` arredonda x/y pra inteiro ao semear (mesmo
        // comportamento de qualquer componente posicionado no canvas), então um `labelY` fracionário
        // como 40 perde um pouquinho de precisão no arredondamento, não é uma regressão real.
        (0, MockCoreServer_1.assert)(Math.abs((pin.labelX ?? 0) - 50) < 1 && Math.abs((pin.labelY ?? 0) - 40) < 1, `labelX/labelY deveriam sobreviver ao round-trip (posição arrastada pelo usuário, não a fórmula padrão), recebido {${pin.labelX},${pin.labelY}}`);
    });
    await test("compile: fundo color vem do componente other.package, svg/image existente é preservado se não houver backgroundColor", () => {
        const pkg = { width: 80, height: 60, pins: [] };
        const components = (0, symbolAuthoring_1.seedSymbolAuthoringComponents)(pkg);
        const existingSvgBackground = { kind: "svg", data: "<svg></svg>" };
        const result = (0, symbolAuthoring_1.compileSymbolAuthoringComponents)(components, existingSvgBackground);
        (0, MockCoreServer_1.assert)(result.package?.background?.kind === "svg", "fundo svg existente deveria ser preservado quando o componente não define backgroundColor");
        const withColor = components.map((c) => (c.typeId === "other.package" ? { ...c, properties: { ...c.properties, backgroundColor: "#112233" } } : c));
        const resultWithColor = (0, symbolAuthoring_1.compileSymbolAuthoringComponents)(withColor, existingSvgBackground);
        (0, MockCoreServer_1.assert)(resultWithColor.package?.background?.kind === "color" && resultWithColor.package.background.value === "#112233", "backgroundColor explícito deveria sobrescrever o fundo svg existente");
    });
    finish();
})();
//# sourceMappingURL=symbolAuthoring.test.js.map