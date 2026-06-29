"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const MockCoreServer_1 = require("../../ipc/testSupport/MockCoreServer");
const wireGeometry_1 = require("./wireGeometry");
(async () => {
    const { test, finish } = (0, MockCoreServer_1.createTestRunner)("wireGeometry — testes puros");
    await test("samePoint considera tolerância < 0.5", () => {
        (0, MockCoreServer_1.assert)((0, wireGeometry_1.samePoint)({ x: 10, y: 10 }, { x: 10.4, y: 9.6 }) === true, "deveria considerar igual dentro da tolerância");
        (0, MockCoreServer_1.assert)((0, wireGeometry_1.samePoint)({ x: 10, y: 10 }, { x: 10.6, y: 10 }) === false, "fora da tolerância não é igual");
    });
    await test("snapToWireGrid arredonda pro grid mais próximo", () => {
        const snapped = (0, wireGeometry_1.snapToWireGrid)({ x: 10, y: 13 }, 24);
        (0, MockCoreServer_1.assert)(snapped.x === 0 && snapped.y === 24, `esperado {0,24}, recebido {${snapped.x},${snapped.y}}`);
    });
    await test("snapCoordinate arredonda escalar pro step dado", () => {
        (0, MockCoreServer_1.assert)((0, wireGeometry_1.snapCoordinate)(13, 24) === 24, "13 deveria arredondar pra 24");
        (0, MockCoreServer_1.assert)((0, wireGeometry_1.snapCoordinate)(11, 24) === 0, "11 deveria arredondar pra 0");
    });
    await test("appendPoint não duplica ponto igual ao último", () => {
        const points = [{ x: 0, y: 0 }];
        (0, wireGeometry_1.appendPoint)(points, { x: 0.2, y: 0.1 });
        (0, MockCoreServer_1.assert)(points.length === 1, "ponto quase idêntico não deveria ser adicionado");
        (0, wireGeometry_1.appendPoint)(points, { x: 50, y: 50 });
        (0, MockCoreServer_1.assert)(points.length === 2, "ponto diferente deveria ser adicionado");
    });
    await test("orthogonalSegmentPoints: pontos iguais devolve 1 ponto", () => {
        const result = (0, wireGeometry_1.orthogonalSegmentPoints)({ x: 5, y: 5 }, { x: 5, y: 5 });
        (0, MockCoreServer_1.assert)(result.length === 1, "pontos iguais deveria devolver array de 1");
    });
    await test("orthogonalSegmentPoints: já alinhado (reta) não cria cotovelo", () => {
        const horizontal = (0, wireGeometry_1.orthogonalSegmentPoints)({ x: 0, y: 0 }, { x: 100, y: 0 });
        (0, MockCoreServer_1.assert)(horizontal.length === 2, "segmento horizontal reto não deveria ter cotovelo");
        const vertical = (0, wireGeometry_1.orthogonalSegmentPoints)({ x: 0, y: 0 }, { x: 0, y: 100 });
        (0, MockCoreServer_1.assert)(vertical.length === 2, "segmento vertical reto não deveria ter cotovelo");
    });
    await test("orthogonalSegmentPoints: diagonal cria um cotovelo em L", () => {
        const result = (0, wireGeometry_1.orthogonalSegmentPoints)({ x: 0, y: 0 }, { x: 100, y: 50 });
        (0, MockCoreServer_1.assert)(result.length === 3, "diagonal deveria gerar 3 pontos (com cotovelo)");
        const elbow = result[1];
        (0, MockCoreServer_1.assert)((elbow.x === 100 && elbow.y === 0) || (elbow.x === 0 && elbow.y === 50), "cotovelo deveria estar alinhado com o eixo dominante");
    });
    await test("buildOrthogonalPath concatena segmentos sem duplicar pontos de junção", () => {
        const path = (0, wireGeometry_1.buildOrthogonalPath)([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }]);
        (0, MockCoreServer_1.assert)(path.length === 3, `esperado 3 pontos, recebido ${path.length}`);
        (0, MockCoreServer_1.assert)((0, wireGeometry_1.samePoint)(path[0], { x: 0, y: 0 }), "primeiro ponto preservado");
        (0, MockCoreServer_1.assert)((0, wireGeometry_1.samePoint)(path[2], { x: 50, y: 50 }), "último ponto preservado");
    });
    await test("normalizeOrthogonalPath remove ponto intermediário colinear numa reta pura", () => {
        const normalized = (0, wireGeometry_1.normalizeOrthogonalPath)([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }]);
        (0, MockCoreServer_1.assert)(normalized.length === 2, `reta pura deveria colapsar pra 2 extremos, recebido ${normalized.length}`);
    });
    await test("normalizeOrthogonalPath remove ponto colinear mas preserva o cotovelo real num L", () => {
        const normalized = (0, wireGeometry_1.normalizeOrthogonalPath)([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }]);
        (0, MockCoreServer_1.assert)(normalized.length === 3, `L deveria manter o cotovelo em (100,0), recebido ${normalized.length}`);
    });
    await test("normalizeOrthogonalPath preserva cotovelo real (mudança de direção)", () => {
        const normalized = (0, wireGeometry_1.normalizeOrthogonalPath)([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }]);
        (0, MockCoreServer_1.assert)(normalized.length === 3, "cotovelo real não deveria ser removido");
    });
    const { failed } = finish();
    process.exitCode = failed > 0 ? 1 : 0;
})();
//# sourceMappingURL=wireGeometry.test.js.map