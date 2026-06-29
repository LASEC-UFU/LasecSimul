"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const MockCoreServer_1 = require("../../ipc/testSupport/MockCoreServer");
const packageEditorGeometry_1 = require("./packageEditorGeometry");
(async () => {
    const { test, finish } = (0, MockCoreServer_1.createTestRunner)("packageEditorGeometry — geometria pura do editor (Épico G, escrita)");
    await test("pinTip: angle 0 (direita) soma length só em x", () => {
        const pin = { id: "p", x: 10, y: 5, angle: 0, length: 8 };
        const tip = (0, packageEditorGeometry_1.pinTip)(pin);
        (0, MockCoreServer_1.assert)(tip.x === 18 && tip.y === 5, `esperado {18,5}, recebido {${tip.x},${tip.y}}`);
    });
    await test("pinTip: angle 180 (esquerda) subtrai length de x", () => {
        const pin = { id: "p", x: 10, y: 5, angle: 180, length: 8 };
        const tip = (0, packageEditorGeometry_1.pinTip)(pin);
        (0, MockCoreServer_1.assert)(Math.abs(tip.x - 2) < 1e-9 && Math.abs(tip.y - 5) < 1e-9, `esperado {2,5}, recebido {${tip.x},${tip.y}}`);
    });
    await test("pinTip: angle 90 (baixo, convenção SVG) soma length em y", () => {
        const pin = { id: "p", x: 10, y: 5, angle: 90, length: 4 };
        const tip = (0, packageEditorGeometry_1.pinTip)(pin);
        (0, MockCoreServer_1.assert)(Math.abs(tip.x - 10) < 1e-9 && Math.abs(tip.y - 9) < 1e-9, `esperado {10,9}, recebido {${tip.x},${tip.y}}`);
    });
    await test("computeBounds: sem pinos, é exatamente o corpo", () => {
        const pkg = { width: 60, height: 40, pins: [] };
        const bounds = (0, packageEditorGeometry_1.computeBounds)(pkg);
        (0, MockCoreServer_1.assert)(bounds.minX === 0 && bounds.minY === 0 && bounds.maxX === 60 && bounds.maxY === 40, "bounds deveria ser {0,0,60,40}");
    });
    await test("computeBounds: lead pra fora do corpo expande o bounding box", () => {
        const pkg = {
            width: 60,
            height: 40,
            pins: [{ id: "vcc", x: 0, y: 10, angle: 180, length: 8 }],
        };
        const bounds = (0, packageEditorGeometry_1.computeBounds)(pkg);
        (0, MockCoreServer_1.assert)(bounds.minX === -8, `esperado minX=-8 (lead sai pra esquerda do corpo), recebido ${bounds.minX}`);
        (0, MockCoreServer_1.assert)(bounds.maxX === 60, `maxX não deveria mudar, recebido ${bounds.maxX}`);
    });
    await test("shapeOrigin/applyShapeOrigin: mover um rect move x/y direto", () => {
        const shape = { kind: "rect", x: 5, y: 5, w: 10, h: 10 };
        (0, MockCoreServer_1.assert)((0, packageEditorGeometry_1.shapeOrigin)(shape).x === 5 && (0, packageEditorGeometry_1.shapeOrigin)(shape).y === 5, "origem inicial deveria ser {5,5}");
        (0, packageEditorGeometry_1.applyShapeOrigin)(shape, { x: 20, y: 30 });
        (0, MockCoreServer_1.assert)(shape.x === 20 && shape.y === 30, `esperado rect movido para {20,30}, recebido {${shape.x},${shape.y}}`);
    });
    await test("applyShapeOrigin numa linha move OS DOIS pontos juntos (não estica)", () => {
        const shape = { kind: "line", x1: 0, y1: 0, x2: 10, y2: 0 };
        (0, packageEditorGeometry_1.applyShapeOrigin)(shape, { x: 5, y: 5 });
        (0, MockCoreServer_1.assert)(shape.x1 === 5 && shape.y1 === 5, `x1/y1 deveriam ser {5,5}, recebido {${shape.x1},${shape.y1}}`);
        (0, MockCoreServer_1.assert)(shape.x2 === 15 && shape.y2 === 5, `x2/y2 deveriam acompanhar o delta, recebido {${shape.x2},${shape.y2}}`);
    });
    await test("inferPinPlacement: ponto perto do topo prende y=0 e angle=270 (pra cima)", () => {
        const placement = (0, packageEditorGeometry_1.inferPinPlacement)({ x: 30, y: 2 }, 60, 40);
        (0, MockCoreServer_1.assert)(placement.side === "top", `esperado lado 'top', recebido '${placement.side}'`);
        (0, MockCoreServer_1.assert)(placement.y === 0 && placement.angle === 270, `esperado y=0/angle=270, recebido y=${placement.y}/angle=${placement.angle}`);
    });
    await test("inferPinPlacement: ponto perto da direita prende x=width e angle=0", () => {
        const placement = (0, packageEditorGeometry_1.inferPinPlacement)({ x: 58, y: 20 }, 60, 40);
        (0, MockCoreServer_1.assert)(placement.side === "right", `esperado lado 'right', recebido '${placement.side}'`);
        (0, MockCoreServer_1.assert)(placement.x === 60 && placement.angle === 0, `esperado x=60/angle=0, recebido x=${placement.x}/angle=${placement.angle}`);
    });
    await test("inferPinPlacement: ponto fora do corpo é clampado pra dentro do range do lado", () => {
        // distância é por eixo (|x| pra left/right, |y| pra top/bottom) -- x=-5 (dist. 5) bate mais perto
        // da borda esquerda do que y=20 (dist. 20) bate de top/bottom, então "left" vence.
        const placement = (0, packageEditorGeometry_1.inferPinPlacement)({ x: -5, y: 20 }, 60, 40);
        (0, MockCoreServer_1.assert)(placement.side === "left", `esperado lado 'left', recebido '${placement.side}'`);
        (0, MockCoreServer_1.assert)(placement.x === 0 && placement.y === 20, `esperado {0,20} (y clampado, mas dentro do range), recebido {${placement.x},${placement.y}}`);
    });
    await test("nextFreePinId: pula ids já usados", () => {
        const id = (0, packageEditorGeometry_1.nextFreePinId)(["pin1", "pin2"]);
        (0, MockCoreServer_1.assert)(id === "pin3", `esperado 'pin3', recebido '${id}'`);
    });
    finish();
})();
//# sourceMappingURL=packageEditorGeometry.test.js.map