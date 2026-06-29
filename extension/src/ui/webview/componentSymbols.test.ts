import { createTestRunner, assert } from "../../ipc/testSupport/MockCoreServer";
import { componentBox, pinLocalPosition, packageSymbolSvg, registerPackage } from "./componentSymbols";
import { PackageDescriptor } from "./model";

(async () => {
  const { test, finish } = createTestRunner("componentSymbols — package real (Épico G)");

  const pkg: PackageDescriptor = {
    width: 60,
    height: 40,
    border: true,
    pins: [
      { id: "out", x: 60, y: 20, angle: 0, length: 8, label: "OUT" },
      { id: "vcc", x: 0, y: 10, angle: 180, length: 8, label: "VCC" },
      { id: "gnd", x: 0, y: 30, angle: 180, length: 8, label: "GND" },
    ],
  };

  await test("sem package registrado, componentBox cai pro algoritmo genérico (fallback)", () => {
    registerPackage("test.example", undefined);
    const box = componentBox("test.example");
    assert(box.width === 70 && box.height === 40, `esperado box genérico, recebido {${box.width},${box.height}}`);
  });

  await test("com package registrado, componentBox usa o layout resolvido (com folga pra leads)", () => {
    registerPackage("test.example", pkg);
    const box = componentBox("test.example");
    // leads de 8px nos dois lados (vcc/gnd à esquerda, out à direita) -- largura cresce 8 pra cada lado
    assert(box.width === 76, `esperado largura 76 (60 + 8 esquerda + 8 direita), recebido ${box.width}`);
    assert(box.height === 40, `altura não deveria mudar (nenhum lead vertical), recebido ${box.height}`);
  });

  await test("pinLocalPosition casa por id, na ponta real do lead (corpo + length na direção do angle)", () => {
    registerPackage("test.example", pkg);
    const outPos = pinLocalPosition("out", 0, 3, "test.example");
    // offsetX = 8 (pra cobrir o lead de vcc/gnd que vai a x=-8) -- ponta de "out" = 60+8(lead)+8(offset) = 76
    assert(outPos.x === 76, `ponta de "out" esperada em x=76, recebido ${outPos.x}`);
    assert(outPos.y === 20, `y de "out" não deveria mudar, recebido ${outPos.y}`);

    const vccPos = pinLocalPosition("vcc", 1, 3, "test.example");
    // ponta de vcc = 0 - 8(lead) + 8(offset) = 0
    assert(vccPos.x === 0, `ponta de "vcc" esperada em x=0, recebido ${vccPos.x}`);
  });

  await test("pinLocalPosition cai pro algoritmo genérico quando o id não está no package", () => {
    registerPackage("test.example", pkg);
    const fallback = pinLocalPosition("nao-existe", 0, 2, "test.example");
    // algoritmo genérico: índice par -> PIN_INSET (6) da borda esquerda do box resolvido (76)
    assert(fallback.x === 6, `esperado fallback genérico x=6, recebido ${fallback.x}`);
  });

  await test("packageSymbolSvg devolve undefined sem package, markup com package", () => {
    registerPackage("test.example", undefined);
    assert(packageSymbolSvg("test.example") === undefined, "sem package registrado deveria devolver undefined");
    registerPackage("test.example", pkg);
    const svg = packageSymbolSvg("test.example");
    assert(typeof svg === "string" && svg.includes("OUT") && svg.includes("VCC") && svg.includes("GND"),
      "markup deveria conter o rótulo de cada pino declarado");
  });

  registerPackage("test.example", undefined);
  finish();
})();
