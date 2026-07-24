import { createTestRunner, assert } from "../../ipc/testSupport/MockCoreServer";
import { continuousDialValueFromPointer, steppedDialValue } from "./dialInteraction";

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

  await test("quantiza o mouse nas 1000 posições inteiras do CustomDial", () => {
    const value = continuousDialValueFromPointer(99, 50, mapping);
    assert(value !== undefined && Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-9,
      `valor deveria cair na grade 0..1000 do QDial: ${value}`);
  });

  await test("setas usam singleStep 25 e Shift usa passo fino 1", () => {
    const coarse = steppedDialValue(0.5, 1, false, { minimum: 0, maximum: 1 });
    const fine = steppedDialValue(0.5, 1, true, { minimum: 0, maximum: 1 });
    assert(coarse === 0.525, `seta normal deveria avançar 25/1000: ${coarse}`);
    assert(fine === 0.501, `Shift+seta deveria avançar 1/1000: ${fine}`);
  });

  await test("setas respeitam faixa invertida, quantização física e extremos", () => {
    const reversed = steppedDialValue(50, 1, false, { minimum: 100, maximum: 0 });
    const snapped = steppedDialValue(0.5, 1, true, { minimum: 0, maximum: 1, step: 0.2 });
    const clamped = steppedDialValue(1, 1, false, { minimum: 0, maximum: 1 });
    assert(reversed === 47.5, `faixa invertida deveria acompanhar a direção declarada: ${reversed}`);
    assert(Math.abs(snapped - 0.6) < 1e-12, `quantização física deveria ser preservada: ${snapped}`);
    assert(clamped === 1, `máximo deveria permanecer limitado: ${clamped}`);
  });

  finish();
})();
