import { createTestRunner, assert } from "../../ipc/testSupport/MockCoreServer";
import { packagePinVisualEnd } from "./componentSymbols";
import {
  buildGenericSubcircuitPackage,
  buildGenericSubcircuitSymbol,
} from "./genericSubcircuitPackage";

function idFactory(): () => string {
  let next = 0;
  return () => `generated-${next++}`;
}

(async () => {
  const { test, finish } = createTestRunner("genericSubcircuitPackage - encapsulamento automático");

  await test("distribui pinos alternadamente e termina cada lead exatamente na borda", () => {
    const descriptor = buildGenericSubcircuitPackage("Demo", [
      { id: "P1" }, { id: "P2" }, { id: "P3" }, { id: "P4" }, { id: "P5" },
    ]);
    assert(descriptor.pins.length === 5, "todos os pinos deveriam ser gerados");
    assert(descriptor.width % 8 === 0 && descriptor.height % 8 === 0, "corpo deveria respeitar a grade de 8 px");
    descriptor.pins.forEach((pin, index) => {
      const end = packagePinVisualEnd({ id: pin.id, x: Number(pin.x), y: Number(pin.y), angle: Number(pin.angle), length: Number(pin.length) });
      const expectedX = index % 2 === 0 ? 0 : descriptor.width;
      assert(Math.abs(end.x - expectedX) < 1e-9, `lead ${pin.id} deveria terminar na borda x=${expectedX}, recebido ${end.x}`);
      assert(Number(pin.y) === 24 + Math.floor(index / 2) * 16, `pino ${pin.id} deveria ocupar sua linha determinística`);
    });
  });

  await test("labels longos aumentam a largura sem alterar a ordem", () => {
    const short = buildGenericSubcircuitPackage("X", [{ id: "A" }, { id: "B" }]);
    const long = buildGenericSubcircuitPackage("X", [
      { id: "A", label: "ENTRADA_MUITO_LONGA" },
      { id: "B", label: "SAIDA_MUITO_LONGA" },
    ]);
    assert(long.width > short.width, "labels longos deveriam alargar o corpo");
    assert(long.pins.map((pin) => pin.id).join(",") === "A,B", "ordem elétrica deveria ser preservada");
  });

  await test("normaliza ids vazios/duplicados e produz saída determinística", () => {
    const pins = [{ id: " P1 " }, { id: "" }, { id: "P1" }, { id: "P2", label: "Saída" }];
    const first = buildGenericSubcircuitPackage("Demo", pins);
    const second = buildGenericSubcircuitPackage("Demo", pins);
    assert(JSON.stringify(first) === JSON.stringify(second), "mesma entrada deveria produzir bytes equivalentes");
    assert(first.pins.map((pin) => pin.id).join(",") === "P1,P2", "ids inválidos/duplicados deveriam ser removidos");
  });

  await test("regeneração preserva ids dos componentes dos pinos existentes", () => {
    const initial = buildGenericSubcircuitSymbol("Demo", [{ id: "P1" }, { id: "P2" }], idFactory());
    const ids = new Map(initial.elements.filter((element) => element.typeId === "symbol.pin").map((element) => [element.properties.pinId, element.id]));
    const regenerated = buildGenericSubcircuitSymbol(
      "Demo",
      [{ id: "P1" }, { id: "P2" }, { id: "P3" }],
      idFactory(),
      initial.elements,
    );
    const pins = regenerated.elements.filter((element) => element.typeId === "symbol.pin");
    assert(pins.find((pin) => pin.properties.pinId === "P1")?.id === ids.get("P1"), "P1 deveria preservar o componentId");
    assert(pins.find((pin) => pin.properties.pinId === "P2")?.id === ids.get("P2"), "P2 deveria preservar o componentId");
    assert(Boolean(pins.find((pin) => pin.properties.pinId === "P3")?.id), "P3 deveria receber um componentId novo");
  });

  finish();
})();
