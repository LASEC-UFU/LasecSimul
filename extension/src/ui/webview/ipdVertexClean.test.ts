import { createTestRunner, assert } from "../../ipc/testSupport/MockCoreServer";
import { cleanIpdWireVertices } from "./ipdVertexClean";

const source = { x: 336, y: 136 };
const target = { x: 336, y: 240 };

(async () => {
  const { test, finish } = createTestRunner("ipdVertexClean — limpeza de rotas autoradas");

  await test("preserva uma dobra real e a encaixa na grade", () => {
    const result = cleanIpdWireVertices([{ x: 391, y: 214 }], source, target);
    assert(JSON.stringify(result) === JSON.stringify([{ x: 392, y: 216 }]), "a dobra deveria encaixar em 392,216");
  });

  await test("cura uma dobra arrastada de volta para perto do eixo", () => {
    assert(cleanIpdWireVertices([{ x: 339, y: 214 }], source, target).length === 0, "a dobra residual deveria desaparecer");
  });

  await test("adota o eixo de uma porta fora da grade", () => {
    const offGridSource = { x: 335, y: 136 };
    const offGridTarget = { x: 335, y: 240 };
    assert(cleanIpdWireVertices([{ x: 338, y: 190 }], offGridSource, offGridTarget).length === 0, "o desvio de 1 px deveria ser curado");
  });

  await test("preserva exatamente um cotovelo entre dois trechos", () => {
    const result = cleanIpdWireVertices([{ x: 98, y: 2 }], { x: 0, y: 0 }, { x: 100, y: 80 });
    assert(JSON.stringify(result) === JSON.stringify([{ x: 100, y: 0 }]), "o cotovelo deveria adotar os dois eixos");
  });

  await test("propaga adoção de eixo por uma cadeia de vértices", () => {
    const result = cleanIpdWireVertices(
      [{ x: 104, y: 2 }, { x: 101, y: 98 }],
      { x: 0, y: 0 },
      { x: 200, y: 100 },
    );
    assert(JSON.stringify(result) === JSON.stringify([{ x: 104, y: 0 }, { x: 104, y: 100 }]), "a cadeia deveria formar dois trechos limpos");
  });

  await test("remove duplicatas e vértices sobre a âncora", () => {
    assert(cleanIpdWireVertices([{ x: 336, y: 136 }], source, target).length === 0, "a âncora duplicada deveria desaparecer");
    const result = cleanIpdWireVertices([{ x: 392, y: 216 }, { x: 393, y: 217 }], source, target);
    assert(JSON.stringify(result) === JSON.stringify([{ x: 392, y: 216 }]), "os pontos duplicados deveriam colapsar");
  });

  await test("extremidades livres ainda encaixam e simplificam", () => {
    const result = cleanIpdWireVertices([{ x: 41, y: 39 }], null, null);
    assert(JSON.stringify(result) === JSON.stringify([{ x: 40, y: 40 }]), "o ponto livre deveria encaixar em 40,40");
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();
