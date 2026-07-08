import { createTestRunner, assert } from "../../ipc/testSupport/MockCoreServer";
import { JUNCTION_TYPE_ID, WebviewWireModel } from "./model";
import { buildPinToPinWire, buildPinToWireConnection } from "./wireConnections";

(async () => {
  const { test, finish } = createTestRunner("wireConnections - montagem pura");

  await test("buildPinToPinWire preserva endpoints e pontos calculados pelo chamador", () => {
    const wire = buildPinToPinWire({
      id: "wire-new",
      from: { componentId: "r1", pinId: "pin-1" },
      to: { componentId: "c1", pinId: "pin-2" },
      points: [{ x: 16, y: 24 }],
    });

    assert(wire.id === "wire-new", "id do fio deveria ser preservado");
    assert(wire.from.componentId === "r1" && wire.from.pinId === "pin-1", "endpoint from deveria ser preservado");
    assert(wire.to.componentId === "c1" && wire.to.pinId === "pin-2", "endpoint to deveria ser preservado");
    assert(wire.points?.[0]?.x === 16 && wire.points?.[0]?.y === 24, "pontos calculados deveriam ser preservados");
  });

  await test("buildPinToWireConnection cria junction hidden e divide o fio existente", () => {
    const existingWire: WebviewWireModel = {
      id: "wire-old",
      from: { componentId: "a", pinId: "pin-1" },
      to: { componentId: "b", pinId: "pin-2" },
      points: [{ x: 8, y: 8 }],
    };

    const result = buildPinToWireConnection({
      existingWire,
      junctionId: "junction-1",
      junctionPoint: { x: 32, y: 40 },
      from: { componentId: "c", pinId: "pin-1" },
      newWireId: "wire-new",
      firstWireId: "wire-a",
      secondWireId: "wire-b",
      existingWireFirstPoints: [{ x: 16, y: 8 }],
      existingWireSecondPoints: [{ x: 32, y: 24 }],
      newWirePoints: [{ x: 32, y: 48 }],
    });

    assert(result.junction.id === "junction-1", "junction deveria usar o id recebido");
    assert(result.junction.typeId === JUNCTION_TYPE_ID, "junction deveria usar o typeId canonico");
    assert(result.junction.hidden === true, "junction eletrica criada por fio deve ficar oculta");
    assert(result.junction.x === 32 && result.junction.y === 40, "junction deveria nascer no ponto de split");

    assert(result.firstWire.from === existingWire.from, "primeira metade deve manter o endpoint inicial do fio antigo");
    assert(result.firstWire.to.componentId === "junction-1", "primeira metade deve terminar na junction");
    assert(result.secondWire.from.componentId === "junction-1", "segunda metade deve sair da junction");
    assert(result.secondWire.to === existingWire.to, "segunda metade deve manter o endpoint final do fio antigo");
    assert(result.newWire.from.componentId === "c", "fio novo deve sair do pino pendente");
    assert(result.newWire.to.componentId === "junction-1", "fio novo deve terminar na mesma junction");
    assert(result.firstWire.to !== result.secondWire.from, "refs de endpoint da junction nao devem ser compartilhadas entre fios");
    assert(result.secondWire.from !== result.newWire.to, "refs de endpoint da junction nao devem ser compartilhadas entre fios");
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();
