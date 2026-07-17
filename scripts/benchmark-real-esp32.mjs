import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const require = createRequire(import.meta.url);
const { CoreClient } = require(path.join(repo, "extension", "out", "ipc", "CoreClient.js"));

const projectPath = process.argv[2] ??
  "G:\\Meu Drive\\Josue\\02 AulasUFU\\01 Aulas_ININD1\\Pratica\\EININDI01_GitHub_VSCode_PIO\\lasecSimul\\blinkLed.lsproj";
const firmwarePath = process.argv[3] ??
  "G:\\Meu Drive\\Josue\\02 AulasUFU\\01 Aulas_ININD1\\Pratica\\EININDI01_GitHub_VSCode_PIO\\lasecSimul\\merged.bin";
const durationMs = Number(process.argv[4] ?? 5000);
const corePath = process.argv[5] ?? path.join(repo, "core", "build", "Release", "lasecsimul-core.exe");
const profiling = process.argv[6] !== "false";
const qemuPath = path.join(repo, "devices", "qemu-esp32", "bin", "qemu-system-xtensa.exe");
const subcircuitPath = path.join(repo, "subcircuits", "esp32_devkitc_v4.lssubcircuit");

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
  await client.start();
  await client.loadDeviceLibrary(path.join(repo, "devices", "library.json"));
  await client.loadDeviceLibrary(path.join(repo, "mcu-adapters", "library.json"));
  await client.registerAdhocSubcircuitDefinition(subcircuitPath);
  const catalog = await client.getPropertySchemas();

  for (const component of project.components) {
    const pins = (catalog.pinIdsByTypeId[component.typeId] ?? [])
      .map((id) => ({ id, x: 0, y: 0 }));
    const response = await client.addComponent(
      component.typeId,
      component.properties ?? {},
      pins,
      component.id,
      component.label ? [component.label] : [],
    );
    instances.set(component.id, response);
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

  await client.setSimulationConfig({
    targetStepUs: 0,
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
  await client.loadMcuFirmware(mcuId, firmwarePath, qemuPath);
  await client.resetPerformanceMetrics();
  await client.run();

  if (plotEntry) {
    const plotId = plotEntry[1].instanceId;
    uartTimer = setInterval(() => {
      if (uartPollInFlight) return;
      uartPollInFlight = true;
      void client.drainUart(plotId).finally(() => { uartPollInFlight = false; });
    }, 10);
  }

  const samples = [];
  let previousWall = performance.now();
  let previousSim = await client.getSimulationTime();
  const deadline = previousWall + durationMs;
  while (performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const wall = performance.now();
    const sim = await client.getSimulationTime();
    samples.push({
      wallMs: wall - previousWall,
      simulatedNs: sim - previousSim,
      rate: ((sim - previousSim) / 1e6) / (wall - previousWall),
    });
    previousWall = wall;
    previousSim = sim;
  }

  clearInterval(uartTimer);
  uartTimer = undefined;
  const stopStarted = performance.now();
  await client.stopSimulation();
  const stopLatencyMs = performance.now() - stopStarted;
  const metrics = await client.getPerformanceMetrics();
  const qemuLogs = await client.getMcuLogs(mcuId);
  const rates = samples.map((sample) => sample.rate);
  const result = {
    fixture: { projectPath, firmwarePath, boardProjectId, mcuId, durationMs },
    rate: {
      average: rates.reduce((sum, value) => sum + value, 0) / rates.length,
      minimum: Math.min(...rates),
      maximum: Math.max(...rates),
      samples,
    },
    stopLatencyMs,
    metrics,
    qemuLogs,
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
