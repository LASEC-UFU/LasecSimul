import { createTestRunner, assert } from "../../ipc/testSupport/MockCoreServer";
import { IpdAlignmentNode, alignIpdNodes, distributeIpdNodes } from "./ipdAlignment";

const node = (
  id: string,
  x: number,
  y: number,
  width = 32,
  height = 32,
  extra: Partial<IpdAlignmentNode> = {},
): IpdAlignmentNode => ({ id, x, y, width, height, ...extra });

function byId(moves: ReturnType<typeof alignIpdNodes>, id: string) {
  return moves.find((move) => move.id === id)!;
}

(async () => {
  const { test, finish } = createTestRunner("ipdAlignment — geometria visual do editor");

  await test("alinha bordas esquerda e direita respeitando larguras diferentes", () => {
    const nodes = [node("a", 10, 0, 32, 24), node("b", 70, 20, 48, 24)];
    const left = alignIpdNodes(nodes, "left");
    assert(byId(left, "a").x === 10 && byId(left, "b").x === 10, "as bordas esquerdas deveriam coincidir");
    const right = alignIpdNodes(nodes, "right");
    assert(byId(right, "a").x + 32 === 118, "o item estreito deveria terminar na borda extrema");
    assert(byId(right, "b").x + 48 === 118, "o item largo deveria terminar na borda extrema");
  });

  await test("alinha bordas superior e inferior respeitando alturas diferentes", () => {
    const nodes = [node("a", 0, 12, 20, 20), node("b", 30, 80, 20, 44)];
    const top = alignIpdNodes(nodes, "top");
    assert(byId(top, "a").y === 12 && byId(top, "b").y === 12, "as bordas superiores deveriam coincidir");
    const bottom = alignIpdNodes(nodes, "bottom");
    assert(byId(bottom, "a").y + 20 === 124, "o item baixo deveria terminar na borda extrema");
    assert(byId(bottom, "b").y + 44 === 124, "o item alto deveria terminar na borda extrema");
  });

  await test("centraliza pela extensão conjunta e encaixa as âncoras na grade de 8 px", () => {
    const nodes = [node("a", 0, 0, 32, 24), node("b", 100, 50, 48, 40)];
    const vertical = alignIpdNodes(nodes, "center-v");
    const horizontal = alignIpdNodes(nodes, "center-h");
    assert(vertical.every((move) => move.x % 8 === 0), "a centralização vertical deveria encaixar x na grade");
    assert(horizontal.every((move) => move.y % 8 === 0), "a centralização horizontal deveria encaixar y na grade");
    const cxA = byId(vertical, "a").x + 16;
    const cxB = byId(vertical, "b").x + 24;
    assert(Math.abs(cxA - cxB) <= 8, "os centros verticais deveriam coincidir dentro de um passo de grade");
  });

  await test("distribui por centros em ordem espacial, não pela ordem de seleção", () => {
    const nodes = [node("last", 200, 0), node("first", 0, 0), node("middle", 17, 0)];
    const moves = distributeIpdNodes(nodes, "h");
    const centers = moves.map((move) => move.x + 16).sort((a, b) => a - b);
    assert(Math.abs((centers[1]! - centers[0]!) - (centers[2]! - centers[1]!)) <= 8, "os centros deveriam ter espaçamento uniforme");
    assert(moves.every((move) => move.x % 8 === 0), "as posições distribuídas deveriam encaixar na grade");
  });

  await test("rotação de 90 graus troca as dimensões efetivas quando não há bounds do host", () => {
    const nodes = [node("rotated", 10, 0, 80, 24, { rotation: 90 }), node("normal", 100, 0, 40, 24)];
    const moves = alignIpdNodes(nodes, "right");
    assert(byId(moves, "rotated").x + 24 === 140, "a largura visual do item rotacionado deveria ser a altura original");
    assert(byId(moves, "normal").x + 40 === 140, "a borda direita normal deveria coincidir");
  });

  await test("bounds transformados preservam a âncora deslocada de símbolos assimétricos", () => {
    const nodes = [
      node("offset", 40, 50, 80, 24, { bounds: { x: -24, y: 8, width: 24, height: 80 } }),
      node("plain", 100, 30, 32, 32),
    ];
    const left = alignIpdNodes(nodes, "left");
    assert(byId(left, "offset").x === 40, "o item que já define a borda mínima não deveria mover a âncora");
    assert(byId(left, "plain").x === 16, "a outra caixa deveria alinhar na borda visual x=16");
  });

  await test("menos de três itens permanecem intactos na distribuição", () => {
    const nodes = [node("a", 3, 7), node("b", 55, 11)];
    const moves = distributeIpdNodes(nodes, "v");
    assert(byId(moves, "a").x === 3 && byId(moves, "a").y === 7, "o primeiro item não deveria mover");
    assert(byId(moves, "b").x === 55 && byId(moves, "b").y === 11, "o segundo item não deveria mover");
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();
