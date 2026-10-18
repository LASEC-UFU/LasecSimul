/**
 * Linha de base de telemetria (docs/54 §1 M0 item e): bytes e duração de `getTelemetryFrame` a 20 Hz
 * com 10 e 100 componentes, e bytes da janela expandida do Oscope por quadro (estado inteiro x deltas).
 * Mede no Core REAL; um processo do Core, um cenário de cada vez, poucos segundos cada.
 *
 *   npm run compile && node test/performance/telemetry-baseline.cjs
 */
const path = require("path");
const { CoreProcess } = require("../../out/ipc/CoreProcess.js");
const { CoreClient } = require("../../out/ipc/CoreClient.js");
const { resolveCoreExecutablePath } = require("../../out/core/coreExecutable.js");

const extensionRoot = path.resolve(__dirname, "..", "..");
const FRAME_MS = 50; // 20 Hz, a cadência do Host
const SECONDS = Number(process.env.BASELINE_SECONDS ?? 4);
const pins = (n) => Array.from({ length: n }, (_, i) => ({ id: `pin-${i + 1}`, x: 0, y: i * 10 }));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Pedido que o Core pode adiar com a simulação rodando ("tente novamente", "ocupada"): `undefined`
 * = adiado (o Host simplesmente pula o quadro), e conta quantos foram. */
async function attempt(client, type, payload, counter) {
  try {
    return await client.request(type, payload);
  } catch (error) {
    if (!/tente novamente|ocupada|adiada/.test(String(error))) throw error;
    counter.deferred = (counter.deferred ?? 0) + 1;
    return undefined;
  }
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const mean = values.reduce((s, v) => s + v, 0) / Math.max(1, values.length);
  return { n: values.length, mean: Math.round(mean * 100) / 100, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}

/** Fonte + terra + seções RC (R série, C ao terra) até `count` componentes. */
async function buildRcLadder(client, count) {
  const ids = [];
  const source = await client.addComponent("sources.dc_voltage", { voltage: 5 }, pins(2), "V");
  const ground = await client.addComponent("other.ground", {}, pins(1), "GND");
  ids.push(source.instanceId, ground.instanceId);
  await client.connectWire(source.instanceId, "pin-2", ground.instanceId, "pin-1");
  const nodes = [];
  let previous = { id: source.instanceId, pin: "pin-1" };
  for (let section = 0; ids.length + 2 <= count; section++) {
    const r = await client.addComponent("passive.resistor", { resistance: 1000 }, pins(2), `R${section}`);
    const c = await client.addComponent("passive.capacitor", { capacitance: 1e-6 }, pins(2), `C${section}`);
    await client.connectWire(previous.id, previous.pin, r.instanceId, "pin-1");
    await client.connectWire(r.instanceId, "pin-2", c.instanceId, "pin-1");
    await client.connectWire(c.instanceId, "pin-2", ground.instanceId, "pin-1");
    ids.push(r.instanceId, c.instanceId);
    nodes.push({ id: r.instanceId, pin: "pin-2" });
    previous = { id: r.instanceId, pin: "pin-2" };
  }
  return { ids, nodes };
}

async function measureFrames(client, subscription) {
  const bytes = [], durations = [], simulated = [], counter = {};
  let lastSimNs;
  const deadline = Date.now() + SECONDS * 1000;
  while (Date.now() < deadline) {
    const started = process.hrtime.bigint();
    // O primeiro pedido com a simulação rodando só registra a assinatura (o Host repete igual).
    const resp = await attempt(client, "getTelemetryFrame", { subscription, sinceGeneration: 0 }, counter);
    if (!resp) { await sleep(FRAME_MS); continue; }
    durations.push(Number(process.hrtime.bigint() - started) / 1e6);
    bytes.push(Buffer.byteLength(JSON.stringify(resp)));
    const simNs = resp.groups?.runtime?.simulatedNs ?? resp.timestampNs;
    if (lastSimNs !== undefined) simulated.push((simNs - lastSimNs) / 1e6);
    lastSimNs = simNs;
    await sleep(FRAME_MS);
  }
  return { bytes: stats(bytes), durationMs: stats(durations), simulatedMsPerFrame: stats(simulated), deferred: counter.deferred ?? 0 };
}

async function withCore(label, body) {
  const pipeName = `lasecsimul-telemetry-baseline-${process.pid}-${label}`;
  const processManager = new CoreProcess({ executablePath: resolveCoreExecutablePath(extensionRoot), pipeName });
  const client = new CoreClient(pipeName, { requestTimeoutMs: 30_000 });
  processManager.start();
  try {
    await client.start();
    // Mesma cadência do Host (configuração `realTimeRate`, padrão 1 = tempo real).
    await client.setSimulationConfig({ realTimeRate: Number(process.env.BASELINE_REAL_TIME_RATE ?? 1) });
    return await body(client);
  } finally {
    await client.stop().catch(() => undefined);
    processManager.kill();
  }
}

async function telemetryScenario(count) {
  return withCore(`n${count}`, async (client) => {
    const { ids, nodes } = await buildRcLadder(client, count);
    const subscription = {
      items: ids.map((instanceId, index) => ({ key: `c${index}`, instanceId })),
      probes: nodes.map((node, index) => ({ key: `n${index}`, instanceId: node.id, pinId: node.pin })),
    };
    await client.run();
    await sleep(300);
    const result = await measureFrames(client, subscription);
    await client.stopSimulation();
    return { components: ids.length, probes: nodes.length, ...result };
  });
}

async function oscopeScenario(sampleIntervalNs) {
  return withCore(`scope${sampleIntervalNs}`, async (client) => {
    const { nodes } = await buildRcLadder(client, 10);
    const scope = await client.addComponent("meters.oscope", { sampleIntervalNs }, pins(5), "Oscope");
    await client.connectWire(nodes[0].id, nodes[0].pin, scope.instanceId, "pin-1");
    await client.run();
    await sleep(300);
    const full = [], delta = [], counter = {};
    let sinceNs;
    const deadline = Date.now() + SECONDS * 1000;
    while (Date.now() < deadline) {
      if (sinceNs !== undefined) {
        const part = await attempt(client, "getComponentState", { instanceId: scope.instanceId, history: { kind: "channelHistory", channels: 4, sinceNs } }, counter);
        if (part) delta.push(Buffer.byteLength(JSON.stringify(part)));
      }
      const whole = await attempt(client, "getComponentState", { instanceId: scope.instanceId }, counter);
      if (!whole) { await sleep(FRAME_MS); continue; }
      full.push(Buffer.byteLength(JSON.stringify(whole)));
      const state = Buffer.from(whole.stateHex, "hex");
      const count = state.readUInt32LE(32);
      if (count > 0) sinceNs = Number(state.readBigUInt64LE(36 + (count - 1) * 16));
      await sleep(FRAME_MS);
    }
    await client.stopSimulation();
    return { sampleIntervalNs, fullBytesPerFrame: stats(full), deltaBytesPerFrame: stats(delta), deferred: counter.deferred ?? 0 };
  });
}

(async () => {
  const report = { frameMs: FRAME_MS, seconds: SECONDS, telemetry: [], oscope: [] };
  for (const count of [10, 100]) report.telemetry.push(await telemetryScenario(count));
  for (const interval of [50_000, 1_000_000]) report.oscope.push(await oscopeScenario(interval));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
