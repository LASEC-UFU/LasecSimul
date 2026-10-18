import * as path from "path";
import { assert, createTestRunner } from "../ipc/testSupport/MockCoreServer";
import { CoreProcess } from "../ipc/CoreProcess";
import { CoreClient } from "../ipc/CoreClient";
import { resolveCoreExecutablePath } from "../core/coreExecutable";

/**
 * Janela expandida do Oscope por deltas (docs/54 §5 item 1) no Core REAL: `getComponentState` com
 * `history.sinceNs` devolve só as amostras novas, no mesmo layout; concatenadas, reproduzem o histórico
 * inteiro; depois de Parar, `latestNs` acusa o relógio que voltou.
 *
 * Fora do `npm test` (precisa do Core compilado):
 *   npm run compile && node out/lab/oscopeHistory.realCore.test.js
 */
const { test, finish } = createTestRunner("Oscope por deltas (Core real)");
const extensionRoot = path.resolve(__dirname, "..", "..");
const MS = 1_000_000;

/** Layout channelHistory: 4 doubles, uint32 contagem, 4 × contagem × {uint64 t, double v}. */
function decode(state: Buffer): Array<{ t: number[]; v: number[] }> {
  const count = state.readUInt32LE(32);
  const channels: Array<{ t: number[]; v: number[] }> = [];
  let offset = 36;
  for (let c = 0; c < 4; c++) {
    const t: number[] = [], v: number[] = [];
    for (let i = 0; i < count; i++) { t.push(Number(state.readBigUInt64LE(offset))); v.push(state.readDoubleLE(offset + 8)); offset += 16; }
    channels.push({ t, v });
  }
  return channels;
}

(async () => {
  const pipeName = `lasecsimul-oscope-history-${process.pid}`;
  const processManager = new CoreProcess({ executablePath: resolveCoreExecutablePath(extensionRoot), pipeName });
  const client = new CoreClient(pipeName, { requestTimeoutMs: 30_000 });
  processManager.start();
  try {
    await client.start();
    const pins = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `pin-${i + 1}`, x: 0, y: i * 10 }));
    const scope = await client.addComponent("meters.oscope", { sampleIntervalNs: 50_000 }, pins(5), "Oscope");
    // RC com τ = 1 ms no canal 0: dá dinâmica ao Scheduler (circuito vazio anda num passo só).
    const source = await client.addComponent("sources.dc_voltage", { voltage: 5 }, pins(2), "V");
    const resistor = await client.addComponent("passive.resistor", { resistance: 1000 }, pins(2), "R");
    const capacitor = await client.addComponent("passive.capacitor", { capacitance: 1e-6 }, pins(2), "C");
    const ground = await client.addComponent("other.ground", {}, pins(1), "GND");
    await client.connectWire(source.instanceId, "pin-1", resistor.instanceId, "pin-1");
    await client.connectWire(resistor.instanceId, "pin-2", capacitor.instanceId, "pin-1");
    await client.connectWire(capacitor.instanceId, "pin-2", ground.instanceId, "pin-1");
    await client.connectWire(source.instanceId, "pin-2", ground.instanceId, "pin-1");
    await client.connectWire(resistor.instanceId, "pin-2", scope.instanceId, "pin-1");

    await test("deltas concatenados reproduzem o histórico e trazem só amostras novas", async () => {
      await client.step(5 * MS);
      const first = decode(await client.getComponentState(scope.instanceId));
      assert(first[0]!.t.length > 50, `amostras iniciais: ${first[0]!.t.length}`);
      const since = first[0]!.t[first[0]!.t.length - 1]!;
      await client.step(3 * MS);
      const delta = await client.getComponentHistorySince(scope.instanceId, 4, since);
      const added = decode(delta.state);
      assert(delta.filtered && added[0]!.t.length > 0 && added[0]!.t.every((t) => t > since), `delta: ${added[0]!.t.length} amostras, todas depois de ${since}`);
      assert(delta.latestNs === added[0]!.t[added[0]!.t.length - 1], "latestNs = última amostra");
      const full = decode(await client.getComponentState(scope.instanceId));
      const merged = [...first[0]!.t, ...added[0]!.t].slice(-full[0]!.t.length);
      assert(JSON.stringify(merged) === JSON.stringify(full[0]!.t), "histórico anterior + delta = histórico inteiro (janela de 512)");
      assert(delta.state.length < (await client.getComponentState(scope.instanceId)).length, "o delta é menor que o estado inteiro");
    });

    await test("depois de Parar, latestNs fica abaixo do instante pedido (o Host pede tudo de novo)", async () => {
      const before = decode(await client.getComponentState(scope.instanceId));
      const since = before[0]!.t[before[0]!.t.length - 1]!;
      await client.stopSimulation();
      await client.step(1 * MS);
      const delta = await client.getComponentHistorySince(scope.instanceId, 4, since);
      assert(delta.filtered && (delta.latestNs ?? 0) < since, `latestNs ${delta.latestNs} < ${since}`);
    });
  } finally {
    await client.stop().catch(() => undefined);
    processManager.kill();
  }
  const result = finish();
  if (result.failed > 0) process.exitCode = 1;
})();
