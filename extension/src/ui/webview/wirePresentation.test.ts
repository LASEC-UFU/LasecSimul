import { createTestRunner, assert } from "../../ipc/testSupport/MockCoreServer";
import { HIGH_WIRE_VOLTAGE_THRESHOLD, isHighWireVoltage, reconcileWireVoltages } from "./wirePresentation";

(async () => {
  const { test, finish } = createTestRunner("wirePresentation — limiar visual dos fios");

  await test("fica vermelho somente acima de 0,7 V", () => {
    assert(HIGH_WIRE_VOLTAGE_THRESHOLD === 0.7, "o limiar configurado deve ser 0,7 V");
    assert(!isHighWireVoltage(0), "0 V deve permanecer no estado baixo");
    assert(!isHighWireVoltage(0.7), "exatamente 0,7 V deve permanecer no estado baixo");
    assert(isHighWireVoltage(0.700001), "qualquer tensão acima de 0,7 V deve ficar vermelha");
    assert(isHighWireVoltage(2.4), "o nó do LED amarelo deve ficar vermelho");
  });

  await test("amostra parcial preserva a última cor válida dos demais fios", () => {
    const result = reconcileWireVoltages(
      { "wire-led": 2.4, "wire-ground": 0, "wire-removed": 3.3 },
      { "wire-ground": 0.1 },
      new Set(["wire-led", "wire-ground"]),
      false
    );
    assert(result["wire-led"] === 2.4, `wire-led não deveria piscar cinza: ${JSON.stringify(result)}`);
    assert(result["wire-ground"] === 0.1, `nova amostra deveria vencer: ${JSON.stringify(result)}`);
    assert(result["wire-removed"] === undefined, `fio removido não deve permanecer no cache: ${JSON.stringify(result)}`);
  });

  await test("Stop confirmado limpa todas as cores", () => {
    const result = reconcileWireVoltages({ "wire-led": 2.4 }, {}, new Set(["wire-led"]), true);
    assert(Object.keys(result).length === 0, `Stop deveria limpar o snapshot: ${JSON.stringify(result)}`);
  });

  finish();
})();
