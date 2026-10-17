import * as fs from "fs";
import * as path from "path";
import { assert as assertWithMessage, createTestRunner } from "../../../ipc/testSupport/MockCoreServer";
import { convertUnit, UNITS } from "./units";

const assert = (condition: boolean, message = "falhou"): void => assertWithMessage(condition, message);
const { test, finish } = createTestRunner("Laboratório de Cálculo — registro de unidades");

/** Lê a tabela `unitInfo` do Core: `if (symbol == "X") return {"dim", scale, offset};`. */
function coreUnits(): Map<string, { dimension: string; scale: number; offset: number }> {
  const source = path.resolve(__dirname, "../../../../../../core/src/simulation/SignalEngine.cpp");
  const text = fs.readFileSync(source, "utf8");
  const table = new Map<string, { dimension: string; scale: number; offset: number }>();
  // Escalas são literais ou "a / b" (ex.: `1e-3 / 60.0`).
  const evaluate = (expression: string): number => {
    const parts = expression.split("/").map((part) => Number(part.trim()));
    if (parts.some((part) => !Number.isFinite(part))) throw new Error(`escala não numérica: ${expression}`);
    return parts.reduce((left, right) => left / right);
  };
  for (const match of text.matchAll(/if \(symbol == "([^"]+)"\) return \{"([a-zA-Z]+)", ([^,]+), ([^}]+)\};/g)) {
    table.set(match[1]!, { dimension: match[2]!, scale: evaluate(match[3]!), offset: evaluate(match[4]!) });
  }
  return table;
}

void (async () => {
  await test("a tabela da Extension é exatamente a do Core (símbolo, dimensão, escala, offset)", () => {
    const core = coreUnits();
    assert(core.size >= 30, `tabela do Core não encontrada (${core.size} entradas)`);
    for (const [symbol, info] of core) {
      const mine = UNITS[symbol];
      assert(Boolean(mine), `falta ${symbol} na Extension`);
      assert(mine!.dimension === info.dimension && Math.abs(mine!.scale - info.scale) <= 1e-15 * Math.abs(info.scale) && mine!.offset === info.offset,
        `${symbol} diverge: ${JSON.stringify(mine)} x ${JSON.stringify(info)}`);
    }
    for (const symbol of Object.keys(UNITS)) assert(symbol === "1" || core.has(symbol), `${symbol} existe só na Extension`);
  });

  await test("conversões do tanque", () => {
    assert(Math.abs(convertUnit(1, "L/s", "m3/s") - 1e-3) < 1e-18, "1 L/s = 1e-3 m³/s");
    assert(Math.abs(convertUnit(60, "L/min", "L/s") - 1) < 1e-12, "60 L/min = 1 L/s");
    assert(Math.abs(convertUnit(0.05, "m", "cm") - 5) < 1e-12, "0,05 m = 5 cm");
    assert(Math.abs(convertUnit(25, "degC", "K") - 298.15) < 1e-12, "25 °C = 298,15 K");
    let threw = false;
    try { convertUnit(1, "L", "m"); } catch { threw = true; }
    assert(threw, "volume → comprimento é recusado");
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();
