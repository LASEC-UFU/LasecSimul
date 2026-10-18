import * as path from "path";
import { assert, createTestRunner } from "../ipc/testSupport/MockCoreServer";
import { CoreProcess } from "../ipc/CoreProcess";
import { CoreClient } from "../ipc/CoreClient";
import { resolveCoreExecutablePath } from "../core/coreExecutable";
import { SeriesStore } from "./SeriesStore";
import { FIRST_ORDER_PLANT, SENSOR_PLANT, type PlantSpec } from "../ui/webview/lab/plants";
import { materializeEmbeddedSubcircuit } from "../project/embeddedSubcircuits";
import { createPlantTemplateLookup } from "../project/plantTemplates";

/**
 * Experimentos D (primeira ordem) e A (sensor 4–20 mA) de docs/53 §1 no Core REAL, pelas mesmas séries e
 * parâmetros que o Laboratório usa (`plants.ts`).
 *
 * Fora do `npm test` (precisa do Core compilado):
 *   npm run compile && node out/lab/firstOrderSensor.realCore.test.js
 */
const { test, finish } = createTestRunner("Primeira ordem e sensor 4–20 mA (Core real, docs/53 §1)");
const extensionRoot = path.resolve(__dirname, "..", "..");
const repoRoot = path.resolve(extensionRoot, "..");
const MS = 1_000_000;

(async () => {
  const pipeName = `lasecsimul-fo-sensor-${process.pid}`;
  const processManager = new CoreProcess({ executablePath: resolveCoreExecutablePath(extensionRoot), pipeName });
  const client = new CoreClient(pipeName, { requestTimeoutMs: 60_000 });
  processManager.start();
  try {
    await client.start();
    await client.loadDeviceLibrary(path.join(repoRoot, "subcircuits", "library.json"));
    // Plantas não são registradas globalmente (fora de library.json): como num projeto, a definição
    // incorporada da planta é registrada avulsa (ver project/plantTemplates.ts).
    const plantTemplate = createPlantTemplateLookup(path.join(repoRoot, "subcircuits"));
    await client.registerAdhocSubcircuitDefinition(materializeEmbeddedSubcircuit(plantTemplate("subcircuits.process.first_order_lab")!.manifest));
    await client.registerAdhocSubcircuitDefinition(materializeEmbeddedSubcircuit(plantTemplate("subcircuits.process.sensor_4_20")!.manifest));

    const attach = async (plant: PlantSpec) => {
      const outer = await client.addComponent(plant.typeId, {}, [], plant.name);
      const children = new Map<string, string>();
      for (const localId of new Set([...plant.series.map((c) => c.localId), ...plant.parameters.map((p) => p.localId)]))
        children.set(localId, await client.getSubcircuitChildInstanceId(outer.instanceId, localId));
      const subscribe = async () => new SeriesStore(await client.subscribeSeries(
        plant.series.map((c) => ({ instanceId: children.get(c.localId)!, port: c.port })), { periodNs: plant.periodNs }), plant.series.map((c) => c.id));
      const set = (id: string, value: number) => {
        const spec = plant.parameters.find((p) => p.id === id)!;
        return client.setSubcircuitChildProperty(outer.instanceId, spec.localId, spec.property, value);
      };
      return { outer, subscribe, set };
    };
    const drain = async (store: SeriesStore): Promise<void> => {
      for (let guard = 0; guard < 500; guard++) {
        const frame = await client.getTelemetryFrame({ items: [], probes: [], series: [store.request()] });
        store.ingest(frame.series[0]!);
        if (!frame.series[0]!.more) return;
      }
    };
    const at = (store: SeriesStore, id: string, seconds: number): number => {
      const times = store.timesView(), column = store.column(id);
      for (let i = times.length - 1; i >= 0; i--) if (Math.round(times[i]! * 1000) === Math.round(seconds * 1000)) return column[i]!;
      throw new Error(`sem linha em t = ${seconds} s`);
    };

    const fo = await attach(FIRST_ORDER_PLANT);
    let store = await fo.subscribe();

    await test("D. degrau u = 1, K = 2, τ = 5 s, y0 = 0: |y(τ) − analítico| ≤ 1e-6·|K·u| e 63,2 % em t = τ", async () => {
      await client.step(20_000 * MS);
      await drain(store);
      const analytic = (t: number) => 2 * (1 - Math.exp(-t / 5));
      assert(Math.abs(at(store, "y", 5) - analytic(5)) <= 1e-6 * 2, `y(5) = ${at(store, "y", 5)}, analítico ${analytic(5)}`);
      let worst = 0;
      for (const t of [1, 2.5, 10, 15, 20]) worst = Math.max(worst, Math.abs(at(store, "y", t) - analytic(t)));
      assert(worst <= 1e-6 * 2, `erro máximo ${worst}`);
      assert(Math.abs(at(store, "y", 5) / 2 - (1 - Math.exp(-1))) < 1e-6, "63,2 % do salto em t = τ");
    });

    await test("D. mudar u em execução: marcador em appliedAtNs e só o futuro muda", async () => {
      const before = Array.from(store.column("y"));
      const { appliedAtNs } = await fo.set("u", -1);
      await client.step(5_000 * MS);
      await drain(store);
      const after = Array.from(store.column("y")).slice(0, before.length);
      assert(after.every((v, i) => v === before[i]), "amostras anteriores inalteradas");
      assert(store.events.some((e) => e.kind === "parameter" && e.tNs === appliedAtNs), "evento parameter");
      assert(at(store, "y", 25) < at(store, "y", 20), "a resposta passa a descer em direção a K·u = −2");
    });

    await test("D. K, τ e y0 são propriedades do bloco: valem na próxima execução", async () => {
      await client.stopSimulation();
      await client.unsubscribeSeries(store.subscriptionId);
      await fo.set("u", 1); await fo.set("K", 3); await fo.set("tau", 2); await fo.set("y0", 1);
      store = await fo.subscribe();
      await client.step(4_000 * MS);
      await drain(store);
      const analytic = (t: number) => 3 + (1 - 3) * Math.exp(-t / 2);
      assert(Math.abs(at(store, "y", 0) - 1) < 1e-12 && Math.abs(at(store, "y", 2) - analytic(2)) <= 1e-6 * 3, `y(2) = ${at(store, "y", 2)}`);
    });

    await client.stopSimulation();
    await client.unsubscribeSeries(store.subscriptionId);
    await client.removeComponent(fo.outer.instanceId);
    const sensor = await attach(SENSOR_PLANT);
    const sensorStore = await sensor.subscribe();

    await test("A. faixa 0–200 kPa: Pmin → 4,000 mA, ponto médio → 12,000, Pmax → 20,000", async () => {
      const read = async (p: number, t: number): Promise<number> => { await sensor.set("p", p); await client.step(100 * MS); await drain(sensorStore); return at(sensorStore, "i", t); };
      assert(Math.abs((await read(0, 0.1)) - 4) < 1e-12, "Pmin → 4 mA");
      assert(Math.abs((await read(100, 0.2)) - 12) < 1e-12, "ponto médio → 12 mA");
      assert(Math.abs((await read(200, 0.3)) - 20) < 1e-12, "Pmax → 20 mA");
    });

    await test("A. acima de Pmax a corrente satura em 20,5 mA e o valor bruto continua crescendo", async () => {
      await sensor.set("p", 260);
      await client.step(100 * MS);
      await drain(sensorStore);
      assert(at(sensorStore, "i", 0.4) === 20.5 && Math.abs(at(sensorStore, "iRaw", 0.4) - 24.8) < 1e-12, `I = ${at(sensorStore, "i", 0.4)}, bruto ${at(sensorStore, "iRaw", 0.4)}`);
    });
  } finally {
    await client.stop().catch(() => undefined);
    processManager.kill();
  }
  const result = finish();
  if (result.failed > 0) process.exitCode = 1;
})();
