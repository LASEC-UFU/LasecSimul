import { createTestRunner, assert } from "../../ipc/testSupport/MockCoreServer";
import { continuousDialValueFromPointer } from "./dialInteraction";

(async () => {
  const { test, finish } = createTestRunner("dialInteraction — controles rotativos estáveis");
  const mapping = {
    centerX: 100,
    centerY: 100,
    minimum: 0,
    maximum: 1,
    minimumAngleDeg: -150,
    maximumAngleDeg: 150,
  };

  await test("a mesma posição do mouse sempre produz o mesmo valor absoluto", () => {
    const first = continuousDialValueFromPointer(100, 50, mapping);
    const afterDelayedHostEcho = continuousDialValueFromPointer(100, 50, mapping);
    assert(first === 0.5, `topo do dial deveria mapear para 0,5, recebido ${first}`);
    assert(afterDelayedHostEcho === first, "o resultado não pode depender de estado/eco anterior");
  });

  await test("o vão inferior gruda no extremo angular mais próximo", () => {
    const bottomRight = continuousDialValueFromPointer(108, 145, mapping);
    const bottomLeft = continuousDialValueFromPointer(92, 145, mapping);
    assert(bottomRight === 1, `lado direito do vão deveria grudar no máximo: ${bottomRight}`);
    assert(bottomLeft === 0, `lado esquerdo do vão deveria grudar no mínimo: ${bottomLeft}`);
  });

  await test("respeita zona morta, step e clamp", () => {
    assert(continuousDialValueFromPointer(101, 101, mapping) === undefined, "centro deve pertencer à zona morta");
    const stepped = continuousDialValueFromPointer(100, 50, { ...mapping, step: 0.2 });
    assert(stepped === 0.6000000000000001, `0,5 arredondado em passos de 0,2 deveria ser 0,6: ${stepped}`);
  });

  finish();
})();
