import { createTestRunner, assert } from "../../ipc/testSupport/MockCoreServer";
import { Point } from "./wireGeometry";
import {
  WireDraft,
  defaultWirePath,
  finishWireDraft,
  fixWireDraftCorner,
  interiorOfPath,
  isOrthogonalPath,
  moveWireDraft,
  resolveWirePath,
  simplifyWirePath,
  snapToDraftGrid,
  startWireDraft,
  translatePoints,
  undoWireDraftCorner,
  wireDraftCorner,
  wireDraftPath,
} from "./wireRouting";

const p = (x: number, y: number): Point => ({ x, y });
const text = (points: readonly Point[]): string => points.map((point) => `${point.x},${point.y}`).join(" ");
const equal = (actual: readonly Point[], expected: readonly Point[], message: string): void =>
  assert(text(actual) === text(expected), `${message}: esperado [${text(expected)}], obtido [${text(actual)}]`);

/** Move o cursor por uma sequência de pontos (um evento de mouse por ponto). */
function sweep(draft: WireDraft, ...cursors: Point[]): WireDraft {
  return cursors.reduce((current, cursor) => moveWireDraft(current, cursor), draft);
}

/** Primeira perna da polilinha: "h", "v" ou "-" (reta/sem canto). */
function firstLeg(points: readonly Point[]): string {
  if (points.length < 3) return "-";
  return points[0]!.y === points[1]!.y ? "h" : "v";
}

(async () => {
  const { test, finish } = createTestRunner("wireRouting — rota ortogonal no estilo do SimulIDE");

  // ── criação ──────────────────────────────────────────────────────────────────────────────────

  await test("rascunho começa como um ponto e segue reto enquanto alinhado com a origem", () => {
    const draft = sweep(startWireDraft(p(100, 100)), p(140, 100));
    equal(wireDraftPath(draft), [p(100, 100), p(140, 100)], "reta horizontal");
    assert(wireDraftCorner(draft) === undefined, "reta não tem canto");
  });

  await test("ao sair do alinhamento, a primeira perna segue o eixo dominante", () => {
    equal(wireDraftPath(sweep(startWireDraft(p(0, 0)), p(80, 16))), [p(0, 0), p(80, 0), p(80, 16)], "dominante horizontal");
    equal(wireDraftPath(sweep(startWireDraft(p(0, 0)), p(16, 80))), [p(0, 0), p(0, 80), p(16, 80)], "dominante vertical");
    // empate cai na vertical (mesma comparação estrita `|dx| > |dy|` do SimulIDE)
    equal(wireDraftPath(sweep(startWireDraft(p(0, 0)), p(40, 40))), [p(0, 0), p(0, 40), p(40, 40)], "empate");
  });

  await test("o eixo fica travado: cruzar a diagonal não vira o cotovelo", () => {
    let draft = sweep(startWireDraft(p(0, 0)), p(8, 0), p(80, -8));
    const orientations: string[] = [];
    for (const cursor of [p(120, -40), p(100, -100), p(60, -160), p(40, -200), p(90, -30)]) {
      draft = moveWireDraft(draft, cursor);
      orientations.push(firstLeg(wireDraftPath(draft)));
      assert(isOrthogonalPath(wireDraftPath(draft)), "pré-visualização sempre ortogonal");
    }
    assert(orientations.join("") === "hhhhh", `cotovelo virou no meio do movimento: ${orientations.join("")}`);
  });

  await test("realinhar com a origem zera o eixo; a saída seguinte decide de novo", () => {
    let draft = sweep(startWireDraft(p(0, 0)), p(80, 0), p(80, 40)); // h primeiro
    assert(firstLeg(wireDraftPath(draft)) === "h", "começa h");
    draft = sweep(draft, p(0, 40)); // cursor na vertical da origem -> reta vertical
    equal(wireDraftPath(draft), [p(0, 0), p(0, 40)], "virou reta vertical");
    draft = sweep(draft, p(-8, 40)); // sai pela esquerda: dominante agora é vertical
    equal(wireDraftPath(draft), [p(0, 0), p(0, 40), p(-8, 40)], "agora v primeiro");
  });

  await test("clique no vazio fixa o canto e o trecho seguinte continua elástico a partir dele", () => {
    let draft = sweep(startWireDraft(p(0, 0)), p(8, 0), p(100, -40));
    draft = fixWireDraftCorner(draft);
    equal([...draft.anchors], [p(0, 0), p(100, 0)], "o canto (não o cursor) vira ponto fixo");
    equal(wireDraftPath(draft), [p(0, 0), p(100, 0), p(100, -40)], "forma inalterada pelo clique");
    draft = sweep(draft, p(108, -40), p(160, -80));
    // a perna que saía do canto fixado era vertical: ela estica e a nova perna é horizontal
    equal(wireDraftPath(draft), [p(0, 0), p(100, 0), p(100, -80), p(160, -80)], "nova perna após o canto fixado");
  });

  await test("clique no vazio com trecho reto transforma o cursor num ponto de passagem", () => {
    let draft = sweep(startWireDraft(p(0, 0)), p(64, 0));
    draft = fixWireDraftCorner(draft);
    equal([...draft.anchors], [p(0, 0), p(64, 0)], "ponto de passagem");
    draft = sweep(draft, p(64, 48));
    equal(wireDraftPath(draft), [p(0, 0), p(64, 0), p(64, 48)], "dobra exatamente no ponto clicado");
    assert(fixWireDraftCorner(startWireDraft(p(5, 5))).anchors.length === 1, "clique sobre a própria origem não cria ponto");
  });

  await test("desfazer canto recua um ponto fixo por vez e nunca remove a origem", () => {
    let draft = sweep(startWireDraft(p(0, 0)), p(100, -40));
    draft = fixWireDraftCorner(draft);
    draft = sweep(draft, p(160, -80));
    draft = fixWireDraftCorner(draft);
    assert(draft.anchors.length === 3, "dois cantos fixados");
    const once = undoWireDraftCorner(draft)!;
    assert(once.anchors.length === 2, "recuou um");
    assert(isOrthogonalPath(wireDraftPath(once)), "continua ortogonal depois de recuar");
    const twice = undoWireDraftCorner(once)!;
    assert(twice.anchors.length === 1, "só a origem");
    assert(undoWireDraftCorner(twice) === undefined, "nada mais a desfazer");
  });

  await test("fechar num alvo grava exatamente a pré-visualização com a ponta no alvo", () => {
    let draft = sweep(startWireDraft(p(192, 244.5)), p(200, 244.5), p(304, 188.5));
    draft = fixWireDraftCorner(draft);
    const target = p(400, 84.5);
    const preview = simplifyWirePath(wireDraftPath(moveWireDraft(draft, target)));
    const final = finishWireDraft(draft, target);
    equal(final, preview, "fio final == pré-visualização");
    equal(final, [p(192, 244.5), p(304, 244.5), p(304, 84.5), p(400, 84.5)], "rota em três pernas");
    assert(isOrthogonalPath(final), "ortogonal");
  });

  await test("fechar num alvo alinhado com a origem dá uma reta sem cantos", () => {
    equal(finishWireDraft(startWireDraft(p(0, 10)), p(200, 10)), [p(0, 10), p(200, 10)], "reta");
    assert(interiorOfPath(finishWireDraft(startWireDraft(p(0, 10)), p(200, 10))).length === 0, "sem cantos a gravar");
  });

  await test("grade do rascunho é relativa à origem (pino fora da grade não deixa degrau)", () => {
    const draft = startWireDraft(p(192, 244.5));
    equal([snapToDraftGrid(draft, p(301, 247))], [p(304, 244.5)], "y encaixa no y do pino");
    equal([snapToDraftGrid(draft, p(301, 241))], [p(304, 244.5)], "menos de meio passo ainda encaixa no pino");
    equal([snapToDraftGrid(draft, p(301, 239))], [p(304, 236.5)], "passo inteiro abaixo");
  });

  await test("movimento rápido (saltos grandes) mantém a pré-visualização ortogonal e sem pontos repetidos", () => {
    let draft = startWireDraft(p(0, 0));
    for (const cursor of [p(400, -300), p(-250, 120), p(8, 0), p(0, 0), p(640, 16), p(-16, -480)]) {
      draft = moveWireDraft(draft, cursor);
      const path = simplifyWirePath(wireDraftPath(draft));
      assert(isOrthogonalPath(path), `diagonal em ${text(path)}`);
      for (let index = 0; index + 1 < path.length; index += 1) {
        assert(path[index]!.x !== path[index + 1]!.x || path[index]!.y !== path[index + 1]!.y, `ponto repetido em ${text(path)}`);
      }
    }
  });

  // ── simplificação ────────────────────────────────────────────────────────────────────────────

  await test("simplificar remove pontos repetidos, colineares e dentes de ida e volta", () => {
    equal(simplifyWirePath([p(0, 0), p(0, 0), p(50, 0), p(100, 0), p(100, 40)]), [p(0, 0), p(100, 0), p(100, 40)], "repetido + colinear");
    equal(simplifyWirePath([p(0, 0), p(80, 0), p(40, 0), p(40, 30)]), [p(0, 0), p(40, 0), p(40, 30)], "dente de ida e volta");
    equal(simplifyWirePath([p(0, 0), p(80, 0), p(0, 0), p(0, 30)]), [p(0, 0), p(0, 30)], "volta completa até a origem");
    equal(simplifyWirePath([p(0, 0), p(100, 0)]), [p(0, 0), p(100, 0)], "reta intocada");
  });

  await test("simplificar preserva as duas pontas exatamente e os cantos de verdade", () => {
    const path = [p(192, 244.5), p(304, 244.5), p(304, 84.5), p(400, 84.5)];
    equal(simplifyWirePath(path), path, "nada a remover");
    equal(simplifyWirePath([p(10, 10), p(10.2, 10.1), p(60, 10)]), [p(10, 10), p(60, 10)], "primeira ponta mantida");
    equal(simplifyWirePath([p(10, 10), p(59.8, 10.1), p(60, 10)]), [p(10, 10), p(60, 10)], "última ponta mantida");
  });

  // ── pontas que se movem ──────────────────────────────────────────────────────────────────────

  await test("fio sem canto: reta quando alinhado, L pelo eixo pedido quando não", () => {
    equal(resolveWirePath(p(0, 0), undefined, p(100, 0)), [p(0, 0), p(100, 0)], "reta");
    equal(resolveWirePath(p(0, 0), [], p(100, 40), "h"), [p(0, 0), p(100, 0), p(100, 40)], "L horizontal primeiro");
    equal(resolveWirePath(p(0, 0), [], p(100, 40), "v"), [p(0, 0), p(0, 40), p(100, 40)], "L vertical primeiro");
    equal(defaultWirePath(p(0, 0), p(10, 90)), [p(0, 0), p(0, 90), p(10, 90)], "sem eixo pedido: dominante");
  });

  await test("L com um canto guarda a orientação quando qualquer das pontas se move", () => {
    const corner = [p(100, 0)]; // h primeiro: (0,0) -> (100,0) -> (100,60)
    equal(resolveWirePath(p(0, 0), corner, p(100, 60)), [p(0, 0), p(100, 0), p(100, 60)], "intocado");
    equal(resolveWirePath(p(0, 24), corner, p(100, 60)), [p(0, 24), p(100, 24), p(100, 60)], "origem desceu: canto desce junto");
    equal(resolveWirePath(p(0, 0), corner, p(140, 90)), [p(0, 0), p(140, 0), p(140, 90)], "destino andou: canto desliza na horizontal");
    const vertical = [p(0, 60)]; // v primeiro
    equal(resolveWirePath(p(16, 0), vertical, p(100, 60)), [p(16, 0), p(16, 60), p(100, 60)], "v primeiro preservado");
  });

  await test("fio com vários cantos: só o canto vizinho à ponta movida desliza", () => {
    const interior = [p(100, 0), p(100, 80)]; // (0,0) h (100,0) v (100,80) h (200,80)
    equal(resolveWirePath(p(0, 0), interior, p(200, 80)), [p(0, 0), p(100, 0), p(100, 80), p(200, 80)], "intocado");
    equal(resolveWirePath(p(0, 30), interior, p(200, 80)), [p(0, 30), p(100, 30), p(100, 80), p(200, 80)], "origem: 1º canto desliza, o resto fica");
    equal(resolveWirePath(p(0, 0), interior, p(260, 120)), [p(0, 0), p(100, 0), p(100, 120), p(260, 120)], "destino: último canto desliza");
    equal(resolveWirePath(p(-40, 30), interior, p(260, 120)), [p(-40, 30), p(100, 30), p(100, 120), p(260, 120)], "as duas pontas");
    const five = [p(50, 0), p(50, 40), p(120, 40), p(120, 90)];
    const moved = resolveWirePath(p(0, 16), five, p(200, 90));
    equal(moved, [p(0, 16), p(50, 16), p(50, 40), p(120, 40), p(120, 90), p(200, 90)], "cantos do meio intocados");
  });

  await test("a rota não depende do caminho: mover a ponta e voltar devolve a forma original", () => {
    const interior = [p(100, 0), p(100, 80)];
    const original = resolveWirePath(p(0, 0), interior, p(200, 80));
    for (const detour of [p(0, 80), p(100, 80), p(300, 200), p(100, 0), p(-50, -50)]) {
      assert(isOrthogonalPath(resolveWirePath(detour, interior, p(200, 80))), `diagonal com a origem em ${text([detour])}`);
    }
    equal(resolveWirePath(p(0, 0), interior, p(200, 80)), original, "voltou igual");
  });

  await test("ponta que alinha com o segmento seguinte colapsa o canto (sem dente)", () => {
    const interior = [p(100, 0), p(100, 80)];
    // origem exatamente sobre a vertical do 1º canto: o trecho inicial some
    equal(resolveWirePath(p(100, 40), interior, p(200, 80)), [p(100, 40), p(100, 80), p(200, 80)], "colapsou");
    // origem na altura do 2º canto: o fio vira uma reta
    equal(resolveWirePath(p(0, 80), interior, p(200, 80)), [p(0, 80), p(200, 80)], "reta");
  });

  await test("dado legado com diagonal entre cantos gravados ainda sai ortogonal", () => {
    const path = resolveWirePath(p(0, 0), [p(40, 0), p(90, 50), p(90, 120)], p(200, 120));
    assert(isOrthogonalPath(path), `diagonal em ${text(path)}`);
    equal([path[0]!, path[path.length - 1]!], [p(0, 0), p(200, 120)], "pontas intactas");
  });

  await test("interiorOfPath e translatePoints", () => {
    equal(interiorOfPath([p(0, 0), p(50, 0), p(100, 0), p(100, 40)]), [p(100, 0)], "só o canto de verdade");
    equal(translatePoints([p(1, 2), p(3, 4)], 10, -5), [p(11, -3), p(13, -1)], "translação");
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();
