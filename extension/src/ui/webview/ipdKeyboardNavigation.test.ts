import { createTestRunner, assert } from "../../ipc/testSupport/MockCoreServer";
import {
  IpdNavigationItem,
  describeIpdNavigationSelection,
  ipdNavigationOrder,
  stepIpdNavigation,
} from "./ipdKeyboardNavigation";

const item = (id: string, x: number, y: number, extra: Partial<IpdNavigationItem> = {}): IpdNavigationItem => ({
  id,
  x,
  y,
  kind: "component",
  label: id.toUpperCase(),
  ...extra,
});

(async () => {
  const { test, finish } = createTestRunner("ipdKeyboardNavigation — percurso acessível do canvas");

  await test("ordena de cima para baixo e da esquerda para a direita", () => {
    const order = ipdNavigationOrder([item("c", 400, 400), item("a", 100, 100), item("b", 300, 100)]);
    assert(order.join(",") === "a,b,c", "a ordem visual deveria ser a,b,c");
  });

  await test("agrupa numa linha objetos com pequena diferença vertical", () => {
    const order = ipdNavigationOrder([item("right", 400, 104), item("left", 100, 100), item("mid", 250, 96)]);
    assert(order.join(",") === "left,mid,right", "uma linha de processo deveria ser percorrida horizontalmente");
  });

  await test("desempata posições idênticas por id de forma estável", () => {
    const order = ipdNavigationOrder([item("b", 10, 10), item("a", 10, 10)]);
    assert(order.join(",") === "a,b", "o desempate deveria ser determinístico");
  });

  await test("inclui fios no mesmo percurso visual", () => {
    const order = ipdNavigationOrder([item("node", 100, 100), item("wire", 200, 100, { kind: "wire" })]);
    assert(order.join(",") === "node,wire", "o fio deveria participar da ordem");
  });

  await test("Tab e Shift+Tab entram, avançam e dão a volta", () => {
    const order = ["a", "b", "c"];
    assert(stepIpdNavigation(order, undefined, 1) === "a", "Tab deveria entrar pelo primeiro");
    assert(stepIpdNavigation(order, undefined, -1) === "c", "Shift+Tab deveria entrar pelo último");
    assert(stepIpdNavigation(order, "c", 1) === "a", "Tab deveria dar a volta");
    assert(stepIpdNavigation(order, "a", -1) === "c", "Shift+Tab deveria dar a volta para trás");
  });

  await test("descrição informa identidade, rotação e posição", () => {
    const items = [item("a", 0, 0), item("b", 40, 0, { label: "FT-101", rotation: 90 })];
    const description = describeIpdNavigationSelection(items, ["b"], "pt-BR");
    assert(description.includes("FT-101"), "a identidade de engenharia deveria ser anunciada");
    assert(description.includes("girado 90"), "a rotação deveria ser anunciada");
    assert(description.includes("2 de 2"), "a posição no percurso deveria ser anunciada");
  });

  await test("descrição trata seleção vazia e múltipla nos dois idiomas", () => {
    const items = [item("a", 0, 0), item("b", 40, 0)];
    assert(describeIpdNavigationSelection(items, [], "pt-BR") === "Nada selecionado", "vazio em português incorreto");
    assert(describeIpdNavigationSelection(items, ["a", "b"], "en") === "2 objects selected", "múltipla em inglês incorreta");
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();
