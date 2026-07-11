import { createTestRunner, assert } from "../../ipc/testSupport/MockCoreServer";
import {
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
  squaredDistance,
  wireConnectCornerIndexLikeSimulIDE,
  wireCornerIndexNearSegmentPoint,
  WIRE_GRID_SIZE,
} from "./wireGeometry";

(async () => {
  const { test, finish } = createTestRunner("wireGeometry — testes puros");

  await test("samePoint considera tolerância < 0.5", () => {
    assert(samePoint({ x: 10, y: 10 }, { x: 10.4, y: 9.6 }) === true, "deveria considerar igual dentro da tolerância");
    assert(samePoint({ x: 10, y: 10 }, { x: 10.6, y: 10 }) === false, "fora da tolerância não é igual");
  });

  await test("snapToWireGrid arredonda pro grid mais próximo", () => {
    assert(WIRE_GRID_SIZE === 8, `grade padrão deveria seguir a unidade do SimulIDE (8), recebido ${WIRE_GRID_SIZE}`);
    const snapped = snapToWireGrid({ x: 10, y: 13 });
    assert(snapped.x === 8 && snapped.y === 16, `esperado {8,16}, recebido {${snapped.x},${snapped.y}}`);
  });

  await test("snapCoordinate arredonda escalar pro step dado", () => {
    assert(snapCoordinate(13, 24) === 24, "13 deveria arredondar pra 24");
    assert(snapCoordinate(11, 24) === 0, "11 deveria arredondar pra 0");
  });

  await test("appendPoint não duplica ponto igual ao último", () => {
    const points = [{ x: 0, y: 0 }];
    appendPoint(points, { x: 0.2, y: 0.1 });
    assert(points.length === 1, "ponto quase idêntico não deveria ser adicionado");
    appendPoint(points, { x: 50, y: 50 });
    assert(points.length === 2, "ponto diferente deveria ser adicionado");
  });

  await test("orthogonalSegmentPoints: pontos iguais devolve 1 ponto", () => {
    const result = orthogonalSegmentPoints({ x: 5, y: 5 }, { x: 5, y: 5 });
    assert(result.length === 1, "pontos iguais deveria devolver array de 1");
  });

  await test("orthogonalSegmentPoints: já alinhado (reta) não cria cotovelo", () => {
    const horizontal = orthogonalSegmentPoints({ x: 0, y: 0 }, { x: 100, y: 0 });
    assert(horizontal.length === 2, "segmento horizontal reto não deveria ter cotovelo");
    const vertical = orthogonalSegmentPoints({ x: 0, y: 0 }, { x: 0, y: 100 });
    assert(vertical.length === 2, "segmento vertical reto não deveria ter cotovelo");
  });

  await test("orthogonalSegmentPoints: diagonal cria um cotovelo em L", () => {
    const result = orthogonalSegmentPoints({ x: 0, y: 0 }, { x: 100, y: 50 });
    assert(result.length === 3, "diagonal deveria gerar 3 pontos (com cotovelo)");
    const elbow = result[1]!;
    assert(
      (elbow.x === 100 && elbow.y === 0) || (elbow.x === 0 && elbow.y === 50),
      "cotovelo deveria estar alinhado com o eixo dominante"
    );
  });

  await test("buildOrthogonalPath concatena segmentos sem duplicar pontos de junção", () => {
    const path = buildOrthogonalPath([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }]);
    assert(path.length === 3, `esperado 3 pontos, recebido ${path.length}`);
    assert(samePoint(path[0]!, { x: 0, y: 0 }), "primeiro ponto preservado");
    assert(samePoint(path[2]!, { x: 50, y: 50 }), "último ponto preservado");
  });

  await test("normalizeOrthogonalPath remove ponto intermediário colinear numa reta pura", () => {
    const normalized = normalizeOrthogonalPath([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }]);
    assert(normalized.length === 2, `reta pura deveria colapsar pra 2 extremos, recebido ${normalized.length}`);
  });

  await test("normalizeOrthogonalPath remove ponto colinear mas preserva o cotovelo real num L", () => {
    const normalized = normalizeOrthogonalPath([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }]);
    assert(normalized.length === 3, `L deveria manter o cotovelo em (100,0), recebido ${normalized.length}`);
  });

  await test("normalizeOrthogonalPath preserva cotovelo real (mudança de direção)", () => {
    const normalized = normalizeOrthogonalPath([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }]);
    assert(normalized.length === 3, "cotovelo real não deveria ser removido");
  });

  await test("nearestPointOnOrthogonalSegment clampa no eixo livre do segmento", () => {
    const onVertical = nearestPointOnOrthogonalSegment({ x: 50, y: 200 }, { x: 0, y: 0 }, { x: 0, y: 100 });
    assert(onVertical.x === 0 && onVertical.y === 100, `esperado {0,100} (clamp no fim), recebido {${onVertical.x},${onVertical.y}}`);
    const onHorizontal = nearestPointOnOrthogonalSegment({ x: 50, y: 200 }, { x: 0, y: 0 }, { x: 100, y: 0 });
    assert(onHorizontal.x === 50 && onHorizontal.y === 0, `esperado {50,0}, recebido {${onHorizontal.x},${onHorizontal.y}}`);
  });

  await test("nearestSnappedPointOnOrthogonalSegment arredonda pro grid antes de clampar", () => {
    const snapped = nearestSnappedPointOnOrthogonalSegment({ x: 13, y: 200 }, { x: 0, y: 0 }, { x: 100, y: 0 }, 8);
    assert(snapped.x === 16 && snapped.y === 0, `esperado {16,0}, recebido {${snapped.x},${snapped.y}}`);
  });

  await test("squaredDistance calcula distância euclidiana ao quadrado", () => {
    assert(squaredDistance({ x: 0, y: 0 }, { x: 3, y: 4 }) === 25, "3-4-5 ao quadrado deveria ser 25");
  });

  await test("wireCornerIndexNearSegmentPoint encontra canto vizinho dentro da tolerância", () => {
    const points = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }];
    const near = wireCornerIndexNearSegmentPoint(points, 1, { x: 51, y: 3 });
    assert(near === 1, `deveria encontrar o canto no índice 1, recebido ${near}`);
    const tooFar = wireCornerIndexNearSegmentPoint(points, 1, { x: 51, y: 30 });
    assert(tooFar === undefined, "canto fora da tolerância não deveria ser encontrado");
  });

  await test("wireConnectCornerIndexLikeSimulIDE snapa pro canto vizinho no eixo do segmento", () => {
    const points = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }];
    const near = wireConnectCornerIndexLikeSimulIDE(points, 0, { x: 48, y: 0 });
    assert(near === 1, `clique perto do fim do 1º segmento deveria snapar pro canto 1, recebido ${near}`);
    const notFound = wireConnectCornerIndexLikeSimulIDE(points, 0, { x: 25, y: 0 });
    assert(notFound === undefined, "clique no meio do segmento não deveria snapar pra nenhum canto");
  });

  await test("moveOrthogonalWireSegment reposiciona o segmento no eixo perpendicular", () => {
    const moved = moveOrthogonalWireSegment([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], 0, 30);
    assert(moved[0]!.y === 30 && moved[1]!.y === 30, "segmento horizontal deveria mover no eixo Y");
  });

  await test("moveOrthogonalWireCorner arrasta os segmentos vizinhos junto, mantendo ortogonalidade", () => {
    const moved = moveOrthogonalWireCorner(
      [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }],
      1,
      { x: 70, y: 20 }
    );
    assert(moved[1]!.x === 70 && moved[1]!.y === 20, "canto movido deveria ir pro alvo exato");
    assert(moved[0]!.y === 20, "vizinho do segmento horizontal deveria seguir o Y do canto movido");
    assert(moved[2]!.x === 70, "vizinho do segmento vertical deveria seguir o X do canto movido");
  });

  await test("splitWireRouteAtPoint divide a polilinha em dois trechos intermediários", () => {
    const full = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
    const split = splitWireRouteAtPoint(full, { x: 50, y: 0 });
    assert(split.first.length === 0, "trecho antes do split (sem cantos intermediários) deveria ficar vazio");
    assert(split.second.length === 1 && split.second[0]!.x === 100 && split.second[0]!.y === 0, "trecho depois do split deveria conter o cotovelo remanescente");
  });

  await test("splitWireRouteAtPoint devolve vazio quando o ponto não está sobre a polilinha", () => {
    const full = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
    const split = splitWireRouteAtPoint(full, { x: 500, y: 500 });
    assert(split.first.length === 0 && split.second.length === 0, "ponto fora da polilinha não deveria produzir split");
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();
