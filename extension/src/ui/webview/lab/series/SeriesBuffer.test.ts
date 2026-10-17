import { assert as assertWithMessage, createTestRunner } from "../../../../ipc/testSupport/MockCoreServer";
import type { LabSeriesDelta } from "../messages";
import { SeriesBuffer, riemannOnSteps } from "./SeriesBuffer";

const assert = (condition: boolean, message = "falhou"): void => assertWithMessage(condition, message);
const { test, finish } = createTestRunner("Laboratório de Cálculo — séries na Webview (Riemann, ∫, eventos)");

const COLUMNS = ["V", "cumIn", "cumOut", "cumOverflow", "cumSpill", "overflow", "unmet"];

/** Tanque a 10 ms: bomba 1 L/s, saída 0,4 L/s; em t = 5 s o topo cai e derramam 2 L. */
function tankDelta(): LabSeriesDelta {
  const t: number[] = [], values: number[][] = COLUMNS.map(() => []);
  let V = 20, cumIn = 0, cumOut = 0, cumSpill = 0;
  for (let i = 0; i <= 1000; i++) {
    const time = i / 100;
    if (i > 0) { V += 0.006; cumIn += 0.01; cumOut += 0.004; }
    if (i === 500) { V -= 2; cumSpill += 2; }
    t.push(time);
    [V, cumIn, cumOut, 0, cumSpill, 0, 0].forEach((v, c) => values[c]!.push(v));
  }
  return { reset: true, generation: 1, columns: COLUMNS, t, values, events: [{ tS: 0, kind: "start" }], lost: 0 };
}

void (async () => {
  await test("q derivado é a vazão média realizada (0,6 L/s), sem o derramamento", () => {
    const buffer = new SeriesBuffer();
    buffer.ingest(tankDelta());
    const q = buffer.col("q");
    assert(Number.isNaN(q[0]!) && Math.abs(q[1]! - 0.6) < 1e-9 && Math.abs(q[500]! - 0.6) < 1e-9, `q ${q[1]} ${q[500]}`);
  });

  await test("∫q dt sobre a série = ΔV + derramamentos; Riemann com q constante é exato", () => {
    const buffer = new SeriesBuffer();
    buffer.ingest(tankDelta());
    const exact = buffer.stepIntegral("q", 2, 8);
    const dV = buffer.linearAt("V", 8).value - buffer.linearAt("V", 2, false).value;
    const spills = buffer.spillsBetween(2, 8);
    assert(Math.abs(exact - 3.6) < 1e-9 && Math.abs(spills - 2) < 1e-12, `∫q ${exact}, derram. ${spills}`);
    assert(Math.abs(exact - spills - dV) < 1e-9, `balanço ${exact - spills - dV}`);
    for (const method of ["left", "right", "midpoint", "trapezoid"] as const) {
      const r = riemannOnSteps(buffer, "q", 2, 8, 7, method);
      assert(Math.abs(r.sum - 3.6) < 1e-9 && r.bars.length === 7, `${method}: ${r.sum}`);
    }
  });

  await test("eventos derivados: derramamento com volume no instante da amostra", () => {
    const buffer = new SeriesBuffer();
    buffer.ingest(tankDelta());
    const spill = buffer.events.find((e) => e.kind === "spill");
    assert(Boolean(spill) && spill!.tS === 5 && Math.abs(spill!.volume! - 2) < 1e-12, JSON.stringify(spill));
  });

  await test("deltas anexam; reset e geração nova recomeçam", () => {
    const buffer = new SeriesBuffer();
    const full = tankDelta();
    const half = (from: number, to: number, reset: boolean): LabSeriesDelta => ({
      ...full, reset, t: full.t.slice(from, to), values: full.values.map((c) => c.slice(from, to)), events: reset ? full.events : [],
    });
    buffer.ingest(half(0, 600, true));
    buffer.ingest(half(600, 1001, false));
    assert(buffer.length === 1001 && Math.abs(buffer.col("q")[600]! - 0.6) < 1e-9, "q na fronteira entre deltas");
    buffer.ingest({ ...half(0, 10, true), generation: 2 });
    assert(buffer.length === 10 && buffer.generation === 2, "geração nova");
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();
