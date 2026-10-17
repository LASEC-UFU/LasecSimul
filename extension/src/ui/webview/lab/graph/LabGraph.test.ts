import { createTestRunner, assert as assertWithMessage } from "../../../../ipc/testSupport/MockCoreServer";
import { LabGraph } from "./LabGraph";

const assert = (condition: boolean, message = "falhou"): void => assertWithMessage(condition, message);

(async () => {
  const { test, finish } = createTestRunner("Laboratório de Cálculo — grafo de dependências");

  const build = (): LabGraph => {
    const g = new LabGraph();
    g.source("a", 4, { kind: "authoring" });
    g.source("dt", 0.5);
    g.source("expr", "q");
    g.derived("fn", ["expr"], (e: string) => e.toUpperCase());
    g.derived("P", ["fn", "a"], (fn: string, a: number) => `${fn}(${a})`);
    g.derived("Q", ["fn", "a", "dt"], (fn: string, a: number, dt: number) => `${fn}(${a + dt})`);
    g.derived("side", ["dt"], (dt: number) => (dt > 0 ? "direita" : dt < 0 ? "esquerda" : "nenhum"));
    g.derived("table", ["fn", "a"], (fn: string, a: number) => [fn, a]);
    return g;
  };

  await test("mudar Δt recalcula só o que depende de Δt", () => {
    const g = build();
    const before = { P: g.computeCount("P"), table: g.computeCount("table"), Q: g.computeCount("Q") };
    for (const dt of [0.4, 0.3, 0.2]) g.set("dt", dt);
    assert(g.computeCount("Q") - before.Q === 3);
    assert(g.computeCount("P") === before.P && g.computeCount("table") === before.table);
  });
  await test("mesmo valor não propaga; valor derivado igual poda os dependentes", () => {
    const g = build();
    let notifications = 0;
    g.onChange(() => notifications++);
    g.set("dt", 0.5);
    assert(notifications === 0);
    const side = g.computeCount("side");
    g.set("dt", 0.25); // side continua "direita": calcula side, não propaga
    assert(g.computeCount("side") === side + 1 && notifications === 1);
  });
  await test("lote gera uma notificação com o conjunto alterado", () => {
    const g = build();
    const sets: string[][] = [];
    g.onChange((changed) => sets.push([...changed]));
    g.batch(() => { g.set("dt", -0.1); g.set("a", 4); });
    assert(sets.length === 1 && sets[0]?.includes("side") === true && sets[0]?.includes("table") === false, JSON.stringify(sets));
  });
  await test("nó só pode depender de nós já definidos; fonte não pode ser calculada", () => {
    const g = new LabGraph();
    let threw = 0;
    try { g.derived("x", ["y"], () => 1); } catch { threw++; }
    g.derived("z", [], () => 1);
    try { g.set("z", 2); } catch { threw++; }
    assert(threw === 2);
  });
  await test("erro no cálculo vira valor de erro em vez de quebrar a propagação", () => {
    const g = new LabGraph();
    g.source("x", 1);
    g.derived("bad", ["x"], (x: number) => { if (x > 1) throw new Error("falhou"); return x; });
    g.set("x", 2);
    assert(JSON.stringify(g.get("bad")) === JSON.stringify({ kind: "error", reason: "falhou" }));
  });

  finish();
})();
