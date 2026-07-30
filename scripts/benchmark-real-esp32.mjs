import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const runtimeRepo = process.env.LASECSIMUL_BENCHMARK_RUNTIME_REPO
  ? path.resolve(process.env.LASECSIMUL_BENCHMARK_RUNTIME_REPO)
  : repo;
const require = createRequire(import.meta.url);
const { CoreClient } = require(path.join(repo, "extension", "out", "ipc", "CoreClient.js"));

const projectPath = process.argv[2] ??
  "G:\\Meu Drive\\Josue\\02 AulasUFU\\01 Aulas_ININD1\\Pratica\\EININDI01_GitHub_VSCode_PIO\\lasecSimul\\blinkLed.lsproj";
const firmwarePath = process.argv[3] ??
  "G:\\Meu Drive\\Josue\\02 AulasUFU\\01 Aulas_ININD1\\Pratica\\EININDI01_GitHub_VSCode_PIO\\lasecSimul\\merged.bin";
const durationMs = Number(process.argv[4] ?? 5000);
const corePath = process.argv[5] ?? path.join(repo, "core", "build", "Release", "lasecsimul-core.exe");
const profiling = process.argv[6] !== "false";
const realTimeRate = Number(process.argv[7] ?? 0);
const gdbPort = Number(process.env.LASECSIMUL_BENCHMARK_GDB_PORT ?? 0);
const qemuPath = path.join(runtimeRepo, "devices", "qemu-esp32", "bin", "qemu-system-xtensa.exe");
const subcircuitPath = path.join(runtimeRepo, "subcircuits", "esp32_devkitc_v4.lssubcircuit");

for (const required of [projectPath, firmwarePath, corePath, qemuPath, subcircuitPath]) {
  if (!fs.existsSync(required)) throw new Error(`Arquivo obrigatório não encontrado: ${required}`);
}
if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error("Duração deve ser positiva.");

const project = JSON.parse(fs.readFileSync(projectPath, "utf8"));
const pipeName = `lasecsimul-real-esp32-${process.pid}-${Date.now()}`;
const core = spawn(corePath, ["--pipe", pipeName], {
  cwd: repo,
  windowsHide: true,
  env: { ...process.env, LASECSIMUL_NETWORK_MODE: "isolated" },
  stdio: ["ignore", "pipe", "pipe"],
});
const coreExit = new Promise((resolve) => core.once("exit", resolve));
let coreLog = "";
core.stdout.on("data", (chunk) => { coreLog += chunk.toString(); });
core.stderr.on("data", (chunk) => { coreLog += chunk.toString(); });

const client = new CoreClient(pipeName, { requestTimeoutMs: 30000 });
const instances = new Map();
let uartTimer;
let uartPollInFlight = false;
let plotUartHex = "";
const progress = (label) => console.error(`[benchmark-real-esp32] ${label}`);

function resolveEndpoint(endpoint) {
  const instance = instances.get(endpoint.componentId);
  if (!instance) throw new Error(`Componente não materializado: ${endpoint.componentId}`);
  if (instance.exposedPins) {
    const exposed = instance.exposedPins[endpoint.pinId];
    if (!exposed) throw new Error(`Pino externo não resolvido: ${endpoint.componentId}.${endpoint.pinId}`);
    return exposed;
  }
  return { instanceId: instance.instanceId, pinId: endpoint.pinId };
}

async function main() {
  progress("conectando ao Core");
  await client.start();
  progress("carregando bibliotecas");
  await client.loadDeviceLibrary(path.join(runtimeRepo, "devices", "library.json"));
  await client.loadDeviceLibrary(path.join(runtimeRepo, "mcu-adapters", "library.json"));
  await client.registerAdhocSubcircuitDefinition(subcircuitPath);
  const catalog = await client.getPropertySchemas();

  progress("materializando projeto");
  for (const component of project.components) {
    const pins = (catalog.pinIdsByTypeId[component.typeId] ?? [])
      .map((id) => ({ id, x: 0, y: 0 }));
    const response = await client.addComponent(
      component.typeId,
      Object.fromEntries(Object.entries(component.properties ?? {}).filter(([name]) => !name.startsWith("__ui_"))),
      pins,
      component.id,
      component.label ? [component.label] : [],
    );
    instances.set(component.id, response);
    if (component.typeId === "connectors.tunnel" && component.properties?.name) {
      await client.setTunnelName(response.instanceId, pins[0]?.id ?? "pin", "", String(component.properties.name));
    }
  }
  for (const conductor of project.topology?.conductors ?? []) {
    const from = resolveEndpoint(conductor.from);
    const to = resolveEndpoint(conductor.to);
    await client.connectWire(from.instanceId, from.pinId, to.instanceId, to.pinId);
  }

  const boardEntry = [...instances.entries()].find(([, value]) => value.primaryMcuInstanceId);
  if (!boardEntry) throw new Error("O projeto não materializou um MCU interno.");
  const [boardProjectId, board] = boardEntry;
  const mcuId = board.primaryMcuInstanceId ??
    await client.getSubcircuitChildInstanceId(board.instanceId, "mcu1");
  const plotEntry = [...instances.entries()].find(([projectId]) =>
    project.components.find((component) => component.id === projectId)?.typeId === "peripherals.lasecplot");
  const plotId = plotEntry?.[1].instanceId;

  await client.setSimulationConfig({
    targetStepUs: 0,
    realTimeRate,
    maxNonLinearIterations: 0,
    performanceProfiling: profiling,
    integrationMethod: "automatic",
    adaptiveTimeStep: true,
    initialStepNs: 100,
    minimumStepNs: 1,
    maximumStepNs: 100000,
    relativeTolerance: 1e-4,
    absoluteTolerance: 1e-9,
  });
  progress("carregando firmware");
  await client.loadMcuFirmware(
    mcuId,
    firmwarePath,
    qemuPath,
    gdbPort > 0 ? { gdbPort, startPaused: false } : undefined,
  );
  progress("iniciando simulacao");
  await client.resetPerformanceMetrics();
  await client.run();
  progress("simulacao iniciada");

  if (plotId) {
    uartTimer = setInterval(() => {
      if (uartPollInFlight) return;
      uartPollInFlight = true;
      void client.drainUart(plotId)
        .then((batch) => { plotUartHex += batch.dataHex; })
        .catch(() => undefined)
        .finally(() => { uartPollInFlight = false; });
    }, 10);
  }

  const samples = [];
  let previousWall = performance.now();
  const initialTime = await client.getSimulationTime();
  let previousSim = initialTime.simulatedNs;
  let previousMcu = initialTime.mcuVirtualNs;
  const deadline = previousWall + durationMs;
  while (performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const wall = performance.now();
    const time = await client.getSimulationTime();
    const sim = time.simulatedNs;
    const mcuDelta = time.mcuVirtualNs !== undefined && previousMcu !== undefined
      ? time.mcuVirtualNs - previousMcu
      : undefined;
    samples.push({
      wallMs: wall - previousWall,
      simulatedNs: sim - previousSim,
      rate: ((sim - previousSim) / 1e6) / (wall - previousWall),
      ...(mcuDelta !== undefined ? {
        mcuVirtualNs: mcuDelta,
        mcuRate: (mcuDelta / 1e6) / (wall - previousWall),
      } : {}),
    });
    previousWall = wall;
    previousSim = sim;
    previousMcu = time.mcuVirtualNs;
  }

  clearInterval(uartTimer);
  uartTimer = undefined;
  const stopStarted = performance.now();
  await client.stopSimulation();
  const stopLatencyMs = performance.now() - stopStarted;
  if (plotId) {
    const finalPlotBatch = await client.drainUart(plotId).catch(() => undefined);
    if (finalPlotBatch) plotUartHex += finalPlotBatch.dataHex;
  }
  const directUartValue = await client.getProperty(mcuId, "uart0_tx_monitor_hex").catch(() => "");
  const directUartHex = typeof directUartValue === "string" ? directUartValue : "";
  const displayEntry = [...instances.entries()].find(([projectId]) =>
    project.components.find((component) => component.id === projectId)?.typeId === "outputs.ssd1306");
  const displayState = displayEntry ? await client.getComponentState(displayEntry[1].instanceId) : undefined;
  const displayPayload = displayState && displayState.length >= 36 ? displayState.subarray(36) : Buffer.alloc(0);
  const display = displayState ? {
    stateBytes: displayState.length,
    version: displayState.readUInt32LE(0),
    width: displayState.readUInt32LE(8),
    height: displayState.readUInt32LE(12),
    enabled: displayState.readUInt32LE(16) !== 0,
    nonZeroBytes: [...displayPayload].filter((value) => value !== 0).length,
    litPixels: [...displayPayload].reduce((count, value) => count + value.toString(2).replaceAll("0", "").length, 0),
    nonZeroBytesByPage: Array.from({ length: 8 }, (_, page) =>
      [...displayPayload.subarray(page * 128, (page + 1) * 128)].filter((value) => value !== 0).length
    ),
  } : undefined;
  const metrics = await client.getPerformanceMetrics();
  const qemuLogs = await client.getMcuLogs(mcuId);
  if (displayEntry && (!display?.enabled || display.litPixels === 0)) {
    throw new Error(`SSD1306 não foi atualizado: ${JSON.stringify(display)}`);
  }
  if (/Guru Meditation|panic'ed|CORRUPTED/i.test(qemuLogs)) {
    throw new Error("Firmware entrou em panic durante a execução real.");
  }
  const rates = samples.map((sample) => sample.rate);
  const mcuRates = samples.flatMap((sample) => typeof sample.mcuRate === "number" ? [sample.mcuRate] : []);
  const uartSummary = (hex) => {
    const bytes = Buffer.from(hex, "hex");
    const printable = bytes.toString("utf8").replace(/[^\x09\x0a\x0d\x20-\x7e]/g, ".");
    // A janela do benchmark pode terminar no meio de um Serial.print(); isso e' uma linha
    // incompleta, nao uma linha corrompida. Valide somente registros encerrados por LF.
    const lastCompleteLineEnd = printable.lastIndexOf("\n");
    const completeText = lastCompleteLineEnd >= 0
      ? printable.slice(0, lastCompleteLineEnd + 1)
      : "";
    const firstTextOffset = Math.max(0, bytes.indexOf(Buffer.from("Display")));
    const firstTextEnd = bytes.indexOf(0x0a, firstTextOffset);
    const telemetryLines = completeText
      .split(/\r?\n/)
      .filter((line) => line.startsWith(">reta:") || line.startsWith(">seno:"));
    const malformedTelemetryLines = telemetryLines.filter((line) =>
      !/^>(?:reta|seno):\d+:-?\d+(?:\.\d+)?\|g$/.test(line)
    );
    return {
      bytes: bytes.length,
      preview: printable.slice(0, 500),
      tail: printable.slice(-500),
      firstTextLineHex: bytes.subarray(
        firstTextOffset,
        firstTextEnd >= 0 ? firstTextEnd + 1 : Math.min(bytes.length, firstTextOffset + 80)
      ).toString("hex"),
      telemetryLines: telemetryLines.length,
      malformedTelemetryLines: malformedTelemetryLines.length,
    };
  };
  if (plotId && directUartHex !== plotUartHex) {
    throw new Error(
      `LasecPlot divergiu do monitor byte-exato: monitor=${directUartHex.length / 2} bytes, ` +
      `plot=${plotUartHex.length / 2} bytes`
    );
  }
  const compact = process.env.LASECSIMUL_BENCHMARK_COMPACT === "1";
  const result = {
    fixture: { projectPath, firmwarePath, boardProjectId, mcuId, durationMs, realTimeRate },
    rate: {
      average: rates.reduce((sum, value) => sum + value, 0) / rates.length,
      minimum: Math.min(...rates),
      maximum: Math.max(...rates),
      ...(compact ? { sampleCount: samples.length } : { samples }),
    },
    mcuRate: mcuRates.length > 0 ? {
      average: mcuRates.reduce((sum, value) => sum + value, 0) / mcuRates.length,
      minimum: Math.min(...mcuRates),
      maximum: Math.max(...mcuRates),
      sampleCount: mcuRates.length,
    } : undefined,
    uart: {
      exactMatch: directUartHex === plotUartHex,
      directMonitor: uartSummary(directUartHex),
      lasecPlot: uartSummary(plotUartHex),
    },
    stopLatencyMs,
    display,
    metrics,
    ...(compact ? {
      qemu: {
        guruMeditation: /Guru Meditation|panic'ed|CORRUPTED/i.test(qemuLogs),
        i2cAckErrors: (qemuLogs.match(/esp32_i2c_event ackERR/g) ?? []).length,
      },
    } : { qemuLogs }),
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

try {
  await main();
} finally {
  if (uartTimer) clearInterval(uartTimer);
  await client.stop().catch(() => undefined);
  await coreExit;
  if (coreLog.trim()) process.stderr.write(coreLog);
}
