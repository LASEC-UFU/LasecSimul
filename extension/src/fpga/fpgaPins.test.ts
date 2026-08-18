import { createTestRunner, assert } from "../ipc/testSupport/MockCoreServer";
import { buildFpgaPins } from "./fpgaPins";

(async () => {
  const { test, finish } = createTestRunner("fpgaPins");

  await test("bloco sem código nasce sem entradas nem saídas", () => {
    assert(buildFpgaPins([]).length === 0, "nenhum pino deveria ser sintetizado antes da análise");
  });

  await test("análise materializa escalares e cada bit dos vetores", () => {
    const pins = buildFpgaPins([
      { name: "clk", direction: "in", width: 1, downto: true },
      { name: "data", direction: "out", width: 4, downto: true, leftIndex: 3, rightIndex: 0 },
    ]);
    assert(JSON.stringify(pins.map((pin) => pin.id)) === JSON.stringify(["clk", "data(3)", "data(2)", "data(1)", "data(0)"]), "pinos deveriam refletir a interface VHDL");
  });

  await test("vetor ascendente preserva os índices VHDL reais", () => {
    const pins = buildFpgaPins([
      { name: "address", direction: "in", width: 4, downto: false, leftIndex: 4, rightIndex: 7 },
    ]);
    assert(
      JSON.stringify(pins.map((pin) => pin.id)) === JSON.stringify(["address(4)", "address(5)", "address(6)", "address(7)"]),
      "vetor 'to' deveria manter o intervalo não nulo declarado na entity",
    );
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();
