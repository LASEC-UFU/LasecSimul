import { assert, createTestRunner } from "../../ipc/testSupport/MockCoreServer";
import { WebviewComponentModel } from "./model";
import {
  applyBoardTransforms, applyExposedSelection, captureBoardTransforms,
  captureCircuitTransforms, restoreCircuitTransforms,
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

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();
