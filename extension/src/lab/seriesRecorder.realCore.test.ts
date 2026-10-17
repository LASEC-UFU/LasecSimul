import * as path from "path";
import { assert, createTestRunner } from "../ipc/testSupport/MockCoreServer";
import { CoreProcess } from "../ipc/CoreProcess";
import { CoreClient, type SeriesChunkDto } from "../ipc/CoreClient";
import { resolveCoreExecutablePath } from "../core/coreExecutable";

/**
 * Séries gravadas no Core (ADR 0012) e acumulador conservativo (ADR 0013) num Core REAL: bomba de
 * 1 L/s e saída de 0,4 L/s num `control.accumulator` a 10 ms; as linhas saem pelo frame de telemetria
 * na resolução do bloco, e a mudança de parâmetro chega com o tempo simulado em que foi aplicada.
 *
 * Fora do `npm test` (precisa do Core compilado):
 *   npm run compile && node out/lab/seriesRecorder.realCore.test.js
 */
const { test, finish } = createTestRunner("Séries gravadas no Core + acumulador (Core real)");
const extensionRoot = path.resolve(__dirname, "..", "..");
const MS = 1_000_000;

(async () => {
  const pipeName = `lasecsimul-series-${process.pid}`;
  const processManager = new CoreProcess({ executablePath: resolveCoreExecutablePath(extensionRoot), pipeName });
  const client = new CoreClient(pipeName, { requestTimeoutMs: 30_000 });
  processManager.start();
  try {
    await client.start();
    const qin = await client.addComponent("control.constant", { value: 1, unit: "L/s" }, [{ id: "out", x: 0, y: 0 }], "Bomba");
    const qout = await client.addComponent("control.constant", { value: 0.4, unit: "L/s" }, [{ id: "out", x: 0, y: 0 }], "Saída");
    const acc = await client.addComponent("control.accumulator", {
      initial: 20, lowerLimitEnabled: true, lowerLimit: 0, upperLimitEnabled: true, upperLimit: 100, samplePeriodNs: 10 * MS,
    }, [], "Volume");
    await client.applyWireTopologyTransaction([
      { kind: "connect", from: { componentId: qin.instanceId, pinId: "out" }, to: { componentId: acc.instanceId, pinId: "in" } },
      { kind: "connect", from: { componentId: qout.instanceId, pinId: "out" }, to: { componentId: acc.instanceId, pinId: "outflow" } },
    ]);
    const ports = ["out", "cumIn", "cumOut", "cumOverflow"];
    const subscription = await client.subscribeSeries(ports.map((port) => ({ instanceId: acc.instanceId, port })), { periodNs: 10 * MS });

    const rows: { t: number[]; columns: number[][] } = { t: [], columns: ports.map(() => []) };
    const events: SeriesChunkDto["events"] = [];
    let sinceSeq = 0;
    let sinceEventSeq = 0;
    let generation: number | undefined;
    const drain = async (): Promise<void> => {
      for (let guard = 0; guard < 100; guard++) {
        const frame = await client.getTelemetryFrame({ items: [], probes: [],
          series: [{ subscriptionId: subscription, generation, sinceSeq, sinceEventSeq, columns: ports.length }] });
        const chunk = frame.series.find((item) => item.subscriptionId === subscription);
        assert(Boolean(chunk) && !chunk!.missing, "assinatura presente no frame");
        if (generation !== undefined && chunk!.generation !== generation) { rows.t.length = 0; rows.columns.forEach((c) => (c.length = 0)); }
        generation = chunk!.generation;
        rows.t.push(...chunk!.tNs);
        chunk!.columns.forEach((column, index) => rows.columns[index]!.push(...column.map((v) => (v === null ? NaN : v))));
        events.push(...chunk!.events);
        sinceSeq = chunk!.toSeq;
        sinceEventSeq = chunk!.nextEventSeq;
        if (!chunk!.more) return;
      }
    };

    await test("10 s simulados com bloco de 10 ms: 1001 linhas, ΔV = 6 L exato e balanço fechado", async () => {
      await client.step(10_000 * MS);
      await drain();
      const last = rows.t.length - 1;
      assert(rows.t.length >= 1000 && rows.t.length <= 1002, `linhas: ${rows.t.length}`);
      assert(rows.t.every((t, i) => i === 0 || t >= rows.t[i - 1]!), "tempo monotônico");
      const onGrid = rows.t.filter((t) => t % (10 * MS) === 0).length;
      assert(onGrid >= rows.t.length - 1, `linhas na grade de 10 ms: ${onGrid}/${rows.t.length}`);
      const v = rows.columns[0]!;
      const t10 = rows.t.indexOf(10_000 * MS);
      assert(t10 >= 0, `linha em t = 10 s (última ${rows.t[last]})`);
      assert(Math.abs(v[t10]! - 26) < 1e-9, `V(10 s) = ${v[t10]}`);
      const residual = v[last]! - 20 - (rows.columns[1]![last]! - rows.columns[2]![last]! - rows.columns[3]![last]!);
      assert(Math.abs(residual) < 1e-9, `balanço ${residual}`);
      assert(events.some((e) => e.kind === "start"), "evento start da geração");
    });

    await test("setProperty devolve appliedAtNs e a série registra o evento parameter nesse instante", async () => {
      const { appliedAtNs } = await client.setProperty(qin.instanceId, "value", 0);
      assert(typeof appliedAtNs === "number" && appliedAtNs >= 10_000 * MS, `appliedAtNs = ${appliedAtNs}`);
      await client.step(1_000 * MS);
      await drain();
      const event = events.find((e) => e.kind === "parameter");
      assert(Boolean(event) && event!.tNs === appliedAtNs && event!.name === "value" && event!.value === 0 && event!.instanceId === qin.instanceId,
        `evento ${JSON.stringify(event)}`);
      assert(rows.t.includes(appliedAtNs!), "linha no instante exato do parâmetro");
      // O bloco é amostrado: a entrada lida pelo acumulador muda na PRÓXIMA ativação de 10 ms depois
      // de appliedAtNs (aqui 10,01 s). Até lá a bomba ainda soma 1 L/s.
      const v = rows.columns[0]!;
      const after = rows.t.indexOf(11_000 * MS);
      const expected = 26 + 0.6 * 0.01 - 0.4 * 0.99;
      assert(after >= 0 && Math.abs(v[after]! - expected) < 1e-9, `V(11 s) = ${v[after]}, esperado ${expected} (efeito na próxima amostra)`);
      const firstStep = rows.t.indexOf(appliedAtNs! + 10 * MS);
      const secondStep = rows.t.indexOf(appliedAtNs! + 20 * MS);
      assert(Math.abs(v[secondStep]! - v[firstStep]! + 0.004) < 1e-12, "a partir de appliedAt + 10 ms só a saída de 0,4 L/s atua");
    });

    await test("cancelar a assinatura: o frame passa a acusar assinatura ausente", async () => {
      assert(await client.unsubscribeSeries(subscription), "removida");
      const frame = await client.getTelemetryFrame({ items: [], probes: [], series: [{ subscriptionId: subscription, sinceSeq: 0, sinceEventSeq: 0, columns: 1 }] });
      assert(frame.series[0]?.missing === true, "missing");
    });
  } finally {
    await client.stop().catch(() => undefined);
    processManager.kill();
  }
  const result = finish();
  if (result.failed > 0) process.exitCode = 1;
})();
