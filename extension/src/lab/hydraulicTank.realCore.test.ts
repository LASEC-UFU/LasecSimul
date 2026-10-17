import * as path from "path";
import { assert, createTestRunner } from "../ipc/testSupport/MockCoreServer";
import { CoreProcess } from "../ipc/CoreProcess";
import { CoreClient } from "../ipc/CoreClient";
import { resolveCoreExecutablePath } from "../core/coreExecutable";
import { SeriesStore } from "./SeriesStore";
import { TANK_SERIES_CHANNELS } from "../ui/webview/lab/tankModel";

/**
 * Vertical "Tanque — da vazão à integral" (docs/53 §2.6) no Core REAL: o subcircuito
 * `subcircuits.process.hydraulic_tank` lido pelas mesmas séries que o Laboratório assina.
 *
 * Fora do `npm test` (precisa do Core compilado):
 *   npm run compile && node out/lab/hydraulicTank.realCore.test.js
 */
const { test, finish } = createTestRunner("Tanque hidráulico do Laboratório (Core real)");
const extensionRoot = path.resolve(__dirname, "..", "..");
const repoRoot = path.resolve(extensionRoot, "..");
const MS = 1_000_000;

(async () => {
  const pipeName = `lasecsimul-hydraulic-tank-${process.pid}`;
  const processManager = new CoreProcess({ executablePath: resolveCoreExecutablePath(extensionRoot), pipeName });
  const client = new CoreClient(pipeName, { requestTimeoutMs: 30_000 });
  processManager.start();
  try {
    await client.start();
    await client.loadDeviceLibrary(path.join(repoRoot, "subcircuits", "library.json"));
    const plant = await client.addComponent("subcircuits.process.hydraulic_tank", {}, [], "Tanque (teste)");
    const child = (localId: string) => client.getSubcircuitChildInstanceId(plant.instanceId, localId);
    const channels = await Promise.all(TANK_SERIES_CHANNELS.map(async (c) => ({ instanceId: await child(c.localId), port: c.port })));
    const ids = TANK_SERIES_CHANNELS.map((c) => c.id);
    let store = new SeriesStore(await client.subscribeSeries(channels, { periodNs: 10 * MS }), ids);
    const drain = async (): Promise<void> => {
      for (let guard = 0; guard < 200; guard++) {
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
    const balance = (seconds: number): number =>
      at("V", seconds) - 20 - (at("cumIn", seconds) - at("cumOut", seconds) - at("cumOverflow", seconds) - at("cumSpill", seconds));

    await test("bomba 1 L/s, saída 0,4 L/s: ΔV = 6 L e Δh = 0,06 m em 10 s (exato para ZOH)", async () => {
      await client.step(10_000 * MS);
      await drain();
      assert(Math.abs(at("V", 0, false) - 20) < 1e-12 && Math.abs(at("V", 10) - 26) < 1e-9, `V(10) = ${at("V", 10)}`);
      assert(Math.abs(at("h", 10) - at("h", 0, false) - 0.06) < 1e-9, `Δh = ${at("h", 10) - at("h", 0, false)}`);
      assert(Math.abs(at("A", 10) - 0.1) < 1e-15 && Math.abs(balance(10)) < 1e-9, "A gravado e balanço fechado");
    });

    await test("A de 0,1 para 0,04 m² com V = 50 L: derramam 10 L, h vai a 1 m e passa a transbordar 0,6 L/s", async () => {
      await client.step(40_000 * MS);
      const { appliedAtNs } = await set("c_area", 0.04);
      assert(appliedAtNs === 50_000 * MS, `aplicado em ${appliedAtNs}`);
      await client.step(1_000 * MS);
      await drain();
      const next = (appliedAtNs! + 10 * MS) * 1e-9;
      assert(Math.abs(at("A", 50) - 0.04) < 1e-15, "A novo já na linha do instante aplicado");
      assert(Math.abs(at("V", next) - 40) < 1e-9 && Math.abs(at("h", next) - 1) < 1e-9, `na amostra seguinte V = ${at("V", next)}, h = ${at("h", next)}`);
      assert(Math.abs(at("cumSpill", next) - 10.006) < 1e-9, `derramamento ${at("cumSpill", next)} L (10 L + 1 passo de 10 ms antes da amostra)`);
      assert(Math.abs(at("overflow", 51) - 0.6) < 1e-12, `transbordo ${at("overflow", 51)} L/s`);
      const times = store.timesView();
      const h = store.column("h");
      assert(Array.from(h).every((value, i) => times[i]! <= 50 || value <= 1 + 1e-12), "h nunca passa da borda");
      assert(Math.abs(balance(51)) < 1e-8, `balanço ${balance(51)} (arredondamento acumulado em 5100 passos)`);
    });

    await test("A de 0,04 para 0,2 m²: V preservado e h cai para V/A", async () => {
      await set("c_area", 0.2);
      await client.step(20 * MS);
      await drain();
      const t = 51.02;
      assert(Math.abs(at("h", t) - at("V", t) / 200) < 1e-12, "h = V/(1000·A)");
      assert(Math.abs(at("V", t) - (40 + 0.6 * 0.01)) < 1e-9, `V ${at("V", t)} (uma amostra ainda no topo antigo)`);
    });

    await test("válvula por gravidade (k = 2 L/(s·m)): h tende a 0,5 m com τ = 50 s", async () => {
      await client.stopSimulation();
      await client.unsubscribeSeries(store.subscriptionId);
      store = new SeriesStore(await client.subscribeSeries(channels, { periodNs: 10 * MS }), ids);
      await set("c_area", 0.1);
      await set("c_valve", 1);
      await client.step(50_000 * MS);
      await drain();
      const expected = 50 + (20 - 50) * Math.exp(-1);
      assert(Math.abs(at("V", 50) - expected) < 0.01, `V(50 s) = ${at("V", 50)}, analítico ${expected}`);
      assert(Math.abs(at("V", 50) - expected) / expected < 2e-4, "erro relativo ~Δt/(2τ)");
    });

    await test("esvaziar: saída 2 L/s sem entrada seca em 10 s e a demanda passa a não ser atendida", async () => {
      await client.stopSimulation();
      await client.unsubscribeSeries(store.subscriptionId);
      store = new SeriesStore(await client.subscribeSeries(channels, { periodNs: 10 * MS }), ids);
      await set("c_valve", 0);
      await set("c_qin", 0);
      await set("c_qout", 2);
      await client.step(12_000 * MS);
      await drain();
      assert(Math.abs(at("V", 9.99) - 0.02) < 1e-9 && Math.abs(at("V", 10)) < 1e-9 && at("V", 12) === 0, `V(10) = ${at("V", 10)}`);
      assert(Math.abs(at("unmet", 11) - 2) < 1e-12 && Math.abs(at("cumUnmet", 12) - 4) < 1e-9, `falta ${at("unmet", 11)} L/s`);
      assert(Math.abs(balance(12)) < 1e-9, "balanço fechado no fundo");
    });
  } finally {
    await client.stop().catch(() => undefined);
    processManager.kill();
  }
  const result = finish();
  if (result.failed > 0) process.exitCode = 1;
})();
