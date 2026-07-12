import { assert, createTestRunner } from "../../ipc/testSupport/MockCoreServer";
import { WebviewComponentModel } from "./model";
import {
  applyBoardTransforms, applyExposedSelection, captureBoardTransforms,
  captureCircuitTransforms, isBoardModeVisible, restoreCircuitTransforms,
} from "./subcircuitBoardMode";

function component(id: string, graphical = true): WebviewComponentModel & { graphicalForTest: boolean } {
  return {
    id, graphicalForTest: graphical, typeId: "test", label: id, x: 10, y: 20, rotation: 0,
    pins: [], properties: {},
  };
}

(async () => {
  const { test, finish } = createTestRunner("subcircuitBoardMode");
  const visible = (entry: WebviewComponentModel) => (entry as WebviewComponentModel & { graphicalForTest?: boolean }).graphicalForTest === true;

  await test("coordenadas de placa são independentes das coordenadas do circuito", () => {
    const graphical = component("led");
    graphical.boardX = 100; graphical.boardY = 120; graphical.boardRotation = 90;
    const hidden = component("resistor", false);
    const components = [graphical, hidden];
    const circuit = captureCircuitTransforms(components);
    applyBoardTransforms(components, visible);
    assert(graphical.x === 100 && graphical.y === 120 && graphical.rotation === 90, "gráfico deveria assumir boardVisual");
    assert(hidden.x === 10 && hidden.y === 20, "não gráfico não deveria ser reposicionado");
    graphical.x = 130; graphical.y = 140;
    captureBoardTransforms(components, visible);
    restoreCircuitTransforms(components, circuit);
    assert(graphical.x === 10 && graphical.y === 20, "saída deveria restaurar posição do circuito");
    assert(graphical.boardX === 130 && graphical.boardY === 140, "arrasto em placa deveria persistir separadamente");
  });

  await test("seleção de expostos substitui atomicamente o conjunto anterior", () => {
    const a = component("a"); const b = component("b"); const c = component("c");
    a.exposed = true; b.exposed = true;
    applyExposedSelection([a, b, c], new Set(["b", "c"]));
    assert(!a.exposed && Boolean(b.exposed) && Boolean(c.exposed), "conjunto confirmado deveria ser a fonte única");
  });

  await test("seleção de expostos: marcar vários de uma vez e depois remover um mantém os demais", () => {
    const a = component("a"); const b = component("b"); const c = component("c");
    applyExposedSelection([a, b, c], new Set(["a", "b", "c"]));
    assert(Boolean(a.exposed) && Boolean(b.exposed) && Boolean(c.exposed), "os 3 deveriam ficar expostos");
    applyExposedSelection([a, b, c], new Set(["a", "c"])); // usuário desmarcou só "b"
    assert(a.exposed === true && b.exposed === false && c.exposed === true, "remover um da seleção não deveria afetar os outros");
  });

  await test("isBoardModeVisible: gráfico aparece, não-gráfico some, other.package e ícone do Package sempre aparecem", () => {
    const isGraphicalTypeId = (typeId: string) => typeId === "outputs.led";
    const led: WebviewComponentModel = { id: "led", typeId: "outputs.led", label: "led", x: 0, y: 0, rotation: 0, pins: [], properties: {} };
    const resistor: WebviewComponentModel = { id: "r1", typeId: "passive.resistor", label: "r1", x: 0, y: 0, rotation: 0, pins: [], properties: {} };
    const pkg: WebviewComponentModel = { id: "pkg", typeId: "other.package", label: "pkg", x: 0, y: 0, rotation: 0, pins: [], properties: {} };
    const icon: WebviewComponentModel = { id: "icon", typeId: "graphics.image", label: "icon", x: 0, y: 0, rotation: 0, pins: [], properties: {}, packageIconRole: true };
    assert(isBoardModeVisible(led, isGraphicalTypeId) === true, "componente gráfico deveria aparecer no Modo Placa");
    assert(isBoardModeVisible(resistor, isGraphicalTypeId) === false, "componente não-gráfico deveria sumir no Modo Placa (igual a Component::setHidden do SimulIDE)");
    assert(isBoardModeVisible(pkg, isGraphicalTypeId) === true, "other.package (a própria placa) sempre aparece, mesmo não estando no catálogo como gráfico");
    assert(isBoardModeVisible(icon, isGraphicalTypeId) === true, "ícone do Package sempre aparece, é o fundo da placa");
  });

  await test("componente gráfico sem posição de placa salva ainda não fica em (0,0): mantém a posição atual do circuito (arquivo antigo/1ª vez no Modo Placa)", () => {
    const graphical = component("led"); // sem boardX/boardY/boardRotation definidos
    const components = [graphical];
    applyBoardTransforms(components, visible);
    assert(graphical.x === 10 && graphical.y === 20 && graphical.rotation === 0, "sem posição de placa salva, deveria ficar onde já estava no circuito, nunca pular pra 0,0");
  });

  await test("rotação e espelhamento sobrevivem a um ciclo completo de entrar/sair do Modo Placa", () => {
    const graphical = component("led");
    graphical.boardX = 50; graphical.boardY = 60; graphical.boardRotation = 180; graphical.boardFlipH = true;
    const components = [graphical];
    const circuit = captureCircuitTransforms(components);
    applyBoardTransforms(components, visible);
    assert(graphical.rotation === 180 && graphical.flipH === true, "deveria assumir rotação/espelhamento salvos da placa");
    graphical.rotation = 270; graphical.flipV = true; // usuário rotaciona/espelha DENTRO do Modo Placa
    captureBoardTransforms(components, visible);
    restoreCircuitTransforms(components, circuit);
    const rotationAfterExit: number = graphical.rotation;
    assert(rotationAfterExit === 0 && graphical.flipH === undefined && graphical.flipV === undefined, "saída deveria restaurar rotação/espelhamento originais do circuito");
    const boardRotationAfterExit: number | undefined = graphical.boardRotation;
    assert(boardRotationAfterExit === 270 && graphical.boardFlipV === true, "rotação/espelhamento feitos dentro do Modo Placa deveriam persistir separadamente");
  });

  await test("capturas independentes (2 instâncias do mesmo subcircuito) nunca compartilham objeto de transform por referência", () => {
    const instanceA = [component("led")];
    const instanceB = [component("led")]; // mesmo id de componente interno -- é OUTRA instância/array
    const transformsA = captureCircuitTransforms(instanceA);
    const transformsB = captureCircuitTransforms(instanceB);
    transformsA.get("led")!.x = 999; // mutar a captura da instância A
    assert(transformsB.get("led")!.x === 10, "mutar a captura de uma instância nunca pode afetar a captura de outra instância");
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();
