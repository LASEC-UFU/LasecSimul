import * as path from "path";
import { assert, createTestRunner } from "../ipc/testSupport/MockCoreServer";
import { CoreProcess } from "../ipc/CoreProcess";
import { CoreClient, type SeriesChannel } from "../ipc/CoreClient";
import { resolveCoreExecutablePath } from "../core/coreExecutable";
import { SeriesStore } from "./SeriesStore";
import { TANK_PLANT } from "../ui/webview/lab/plants";
import { SeriesBuffer, riemannOnSteps } from "../ui/webview/lab/series/SeriesBuffer";
import { materializeEmbeddedSubcircuit } from "../project/embeddedSubcircuits";
import { createPlantTemplateLookup } from "../project/plantTemplates";

/**
 * Vertical "Tanque — da vazão à integral" (docs/53 §2.6) no Core REAL: o subcircuito
 * `subcircuits.process.hydraulic_tank` lido pelas mesmas séries que o Laboratório assina.
 *
 * Fora do `npm test` (precisa do Core compilado):
 *   npm run compile && node out/lab/hydraulicTank.realCore.test.js
 */
const { test, finish } = createTestRunner("Tanque hidráulico do Laboratório (Core real, docs/53 §2.6)");
const extensionRoot = path.resolve(__dirname, "..", "..");
const repoRoot = path.resolve(extensionRoot, "..");
const MS = 1_000_000;
const ids = TANK_PLANT.series.map((c) => c.id);

(async () => {
  const pipeName = `lasecsimul-hydraulic-tank-${process.pid}`;
  const processManager = new CoreProcess({ executablePath: resolveCoreExecutablePath(extensionRoot), pipeName });
  const client = new CoreClient(pipeName, { requestTimeoutMs: 60_000 });
  processManager.start();
  try {
    await client.start();
    await client.loadDeviceLibrary(path.join(repoRoot, "subcircuits", "library.json"));
    // Plantas não são registradas globalmente (fora de library.json): como num projeto, a definição
    // incorporada da planta é registrada avulsa (ver project/plantTemplates.ts).
    const plantTemplate = createPlantTemplateLookup(path.join(repoRoot, "subcircuits"));
    await client.registerAdhocSubcircuitDefinition(materializeEmbeddedSubcircuit(plantTemplate("subcircuits.process.hydraulic_tank")!.manifest));
    const plant = await client.addComponent("subcircuits.process.hydraulic_tank", {}, [], "Tanque (teste)");
    const child = (localId: string) => client.getSubcircuitChildInstanceId(plant.instanceId, localId);
    const channels: SeriesChannel[] = await Promise.all(TANK_PLANT.series.map(async (c) => ({ instanceId: await child(c.localId), port: c.port })));
    let store = new SeriesStore(await client.subscribeSeries(channels, { periodNs: 10 * MS }), ids);
    const drain = async (): Promise<void> => {
      for (let guard = 0; guard < 500; guard++) {
        const frame = await client.getTelemetryFrame({ items: [], probes: [], series: [store.request()] });
        const chunk = frame.series[0]!;
        store.ingest(chunk);
        if (!chunk.more) return;
      }
    };
    const at = (id: string, seconds: number, last = true): number => {
      const times = store.timesView();
      const column = store.column(id);
      const target = Math.round(seconds * 1000);
      for (let i = last ? times.length - 1 : 0; last ? i >= 0 : i < times.length; i += last ? -1 : 1)
        if (Math.round(times[i]! * 1000) === target) return column[i]!;
      throw new Error(`sem linha em t = ${seconds} s`);
    };
    const set = (localId: string, value: number) => client.setSubcircuitChildProperty(plant.instanceId, localId, "value", value);
    const residualAt = (i: number): number => {
      const c = (id: string) => store.column(id)[i]!;
      return c("V") - store.column("V")[0]! - (c("cumIn") - c("cumOut") - c("cumOverflow") - c("cumSpill"));
    };
    const maxResidual = (): number => { let worst = 0; for (let i = 0; i < store.length; i++) worst = Math.max(worst, Math.abs(residualAt(i))); return worst; };
    /** Nova execução: para o Core, reaplica parâmetros e uma assinatura nova (geração nova). */
    const restart = async (values: Record<string, number>): Promise<void> => {
      await client.stopSimulation();
      await client.unsubscribeSeries(store.subscriptionId);
      for (const [localId, value] of Object.entries(values)) await set(localId, value);
      store = new SeriesStore(await client.subscribeSeries(channels, { periodNs: 10 * MS }), ids);
    };
    const buffer = (): SeriesBuffer => {
      const snapshot = store.snapshot();
      const result = new SeriesBuffer();
      result.ingest({ reset: true, generation: snapshot.generation, columns: ids, t: snapshot.t, values: snapshot.columns, events: [], lost: 0 });
      return result;
    };

    await test("1. bomba 1 L/s, saída 0,4 L/s: ΔV = 6 L e Δh = 0,06 m em 10 s", async () => {
      await client.step(10_000 * MS);
      await drain();
      assert(Math.abs(at("V", 10) - 26) <= 1e-9, `V(10) = ${at("V", 10)}`);
      assert(Math.abs(at("h", 10) - at("h", 0, false) - 0.06) < 1e-9, `Δh = ${at("h", 10) - at("h", 0, false)}`);
    });

    await test("3 e 5. transbordo em 133,333… s (≤ 1 ns) e identidade de balanço em toda linha (≤ 1e-10 L)", async () => {
      await client.step(130_000 * MS);
      await drain();
      const contact = store.column("upperContact")[store.length - 1]!;
      assert(Math.abs(contact - 400 / 3) <= 1e-9, `contato em ${contact} s`);
      assert(Math.abs(at("overflow", 140) - 0.6) < 1e-12 && Math.abs(at("V", 140) - 100) < 1e-9, "no topo: transborda 0,6 L/s");
      assert(maxResidual() <= 1e-12 * 100, `resíduo máximo ${maxResidual()}`);
    });

    await test("2. V0 = 20 L com vazões zero: V constante; os acumulados ficam em zero", async () => {
      await restart({ c_qin: 0, c_qout: 0 });
      await client.step(5_000 * MS);
      await drain();
      const V = store.column("V");
      assert(Array.from(V).every((v) => v === 20) && at("cumIn", 5) === 0 && at("cumOut", 5) === 0, `V ${V[0]}…${V[V.length - 1]}`);
    });

    await test("4. esvaziamento: q_out = 2 L/s de 20 L → contato com o fundo em 10 s; depois saída real 0 e falta 2 L/s", async () => {
      await restart({ c_qin: 0, c_qout: 2 });
      await client.step(12_000 * MS);
      await drain();
      const contact = store.column("lowerContact")[store.length - 1]!;
      assert(Math.abs(contact - 10) <= 1e-9, `contato com o fundo em ${contact} s`);
      assert(at("outActual", 11) === 0 && Math.abs(at("unmet", 11) - 2) < 1e-12, `saída real ${at("outActual", 11)}, falta ${at("unmet", 11)}`);
      assert(maxResidual() <= 1e-12 * 100, `resíduo máximo ${maxResidual()}`);
    });

    await test("6 e 7. válvula (k = 2): V(t) contra a exponencial em [0, 200 s]; Riemann converge para ΔV", async () => {
      await restart({ c_qin: 1, c_qout: 0.4, c_outlet: 1 });
      await client.step(200_000 * MS);
      await drain();
      let worst = 0;
      for (const t of [10, 25, 50, 100, 150, 200]) worst = Math.max(worst, Math.abs(at("V", t) - (50 - 30 * Math.exp(-t / 50))) / (50 - 30 * Math.exp(-t / 50)));
      assert(worst <= 5e-4, `erro relativo máximo ${worst}`);
      const series = buffer();
      const dV = at("V", 50) - at("V", 0, false);
      const error = (n: number, method: "left" | "right" | "midpoint" | "trapezoid") => Math.abs(riemannOnSteps(series, "q", 0, 50, n, method).sum - dV);
      const left = [10, 20, 40].map((n) => error(n, "left"));
      assert(left[0]! / left[1]! > 1.8 && left[1]! / left[2]! > 1.8, `esquerda ~1/n: ${left.map((e) => e.toExponential(2))}`);
      const floor = 7e-5 * dV * 2;
      for (const method of ["midpoint", "trapezoid"] as const) {
        const e50 = error(50, method);
        assert(e50 <= error(50, "left") / 50 || e50 <= floor, `${method} com n = 50: ${e50.toExponential(2)} (esquerda ${error(50, "left").toExponential(2)})`);
      }
      assert(error(5000, "left") <= 1e-9 * dV, `retângulo = passo: erro ${error(5000, "left")}`);
      assert(Math.abs(series.stepIntegral("q", 0, 50) - dV) <= 1e-9, "∫q dt da série = ΔV");
    });

    await test("8. mudar q_in em execução: marcador em appliedAtNs e amostras anteriores inalteradas", async () => {
      await restart({ c_qin: 1, c_qout: 0.4, c_outlet: 0 });
      await client.step(3_000 * MS);
      await drain();
      const before = Array.from(store.column("V"));
      const { appliedAtNs } = await set("c_qin", 2);
      await client.step(1_000 * MS);
      await drain();
      const after = Array.from(store.column("V")).slice(0, before.length);
      assert(after.every((v, i) => v === before[i]), "linhas anteriores à mudança não mudam");
      assert(store.events.some((e) => e.kind === "parameter" && e.tNs === appliedAtNs), "evento parameter no instante aplicado");
    });

    await test("12 e 13. A de 0,1 para 0,04 m² com V = 50 L: derramam 10 L, h vai a 1 m, balanço com derramamento", async () => {
      await restart({ c_qin: 1, c_qout: 0.4 });
      await client.step(50_000 * MS);
      const { appliedAtNs } = await set("c_area", 0.04);
      assert(appliedAtNs === 50_000 * MS, `aplicado em ${appliedAtNs}`);
      await client.step(1_000 * MS);
      await drain();
      const next = (appliedAtNs! + 10 * MS) * 1e-9;
      assert(Math.abs(at("A", 50) - 0.04) < 1e-15, "A novo na linha do instante aplicado");
      assert(Math.abs(at("V", next) - 40) < 1e-9 && Math.abs(at("h", next) - 1) < 1e-9, `na amostra seguinte V = ${at("V", next)}, h = ${at("h", next)}`);
      assert(Math.abs(at("cumSpill", next) - 10.006) < 1e-9, `derramamento ${at("cumSpill", next)} L`);
      assert(Math.abs(at("overflow", 51) - 0.6) < 1e-12, `transbordo ${at("overflow", 51)} L/s`);
      const times = store.timesView(), h = store.column("h");
      assert(Array.from(h).every((value, i) => times[i]! <= 50 || value <= 1 + 1e-12), "h nunca passa da borda");
      assert(maxResidual() <= 1e-12 * 100, `resíduo máximo ${maxResidual()}`);
      const series = buffer();
      const dV = at("V", 51) - at("V", 49, false);
      assert(Math.abs(series.stepIntegral("q", 49, 51) - series.spillsBetween(49, 51) - dV) <= 1e-9, "ΔV = ∫q − derramamentos atravessando a mudança");
    });

    await test("Torricelli (q = c·√h, c = 1,4): h segue a solução de referência e tende a (q_in/c)²", async () => {
      await restart({ c_area: 0.1, c_qin: 1, c_outlet: 2, c_torr: 1.4 });
      await client.step(120_000 * MS);
      await drain();
      // referência: dV/dt = q_in − c√(V/(1000A)), RK4 com passo 1 ms
      let V = 20;
      const dVdt = (v: number) => 1 - 1.4 * Math.sqrt(Math.max(0, v) / 100);
      for (let i = 0; i < 120_000; i++) {
        const dt = 1e-3, k1 = dVdt(V), k2 = dVdt(V + dt * k1 / 2), k3 = dVdt(V + dt * k2 / 2), k4 = dVdt(V + dt * k3);
        V += (dt / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
      }
      assert(Math.abs(at("V", 120) - V) / V <= 1e-3, `V(120) = ${at("V", 120)}, referência ${V}`);
      const hStar = 1 / 1.4 ** 2; // equilíbrio (q_in/c)²; constante de tempo perto dele ~2V*/q ≈ 100 s
      assert(at("h", 60) < at("h", 120) && at("h", 120) < hStar, `h(60) = ${at("h", 60)} < h(120) = ${at("h", 120)} < h* = ${hStar}`);
    });
  } finally {
    await client.stop().catch(() => undefined);
    processManager.kill();
  }
  const result = finish();
  if (result.failed > 0) process.exitCode = 1;
})();
