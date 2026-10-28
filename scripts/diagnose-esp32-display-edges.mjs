// Diagnóstico do bug de bordas do ESP32 perdidas/reordenadas antes de chegar aos devices (ver
// docs/35-bug-bordas-esp32-displays-2026-10-28.md). Materializa o projeto II1P06_SPI_I2C_UART sem
// UI, roda o firmware real no QEMU e lê o estado dos displays PCD8544 (SPI) e AIP31068 (I2C).
//
// Uso (PowerShell -- no Git Bash as DLLs do MSYS no PATH derrubam o QEMU com 0xC0000139):
//   node scripts/diagnose-esp32-display-edges.mjs [projeto.lsproj] [merged.bin] [duracaoMs]
// Variáveis: RTR=1 (tempo real, igual à extensão; padrão 0), DUMP=1 (desenha o último quadro não
// vazio do PCD8544), PROBEALL=1 (lê a tensão de todos os fios a cada 33 ms, como a UI),
// UARTLEN=n (quantos caracteres finais da UART0 mostrar), TOGGLE_BUTTON=1 (alterna a fonte do botão).
// Para reproduzir a extensão, rode também com LASECSIMUL_MCU_TRANSPORT=VNEXT_B,
// LASECSIMUL_ESP32_EXECUTION_MODE=mttcg e LASECSIMUL_HOST_INSTANCE_ID=<pid> (mesmo coreEnv dela).
// Os ids de componente (devkitC-46, Pcd8544-19, Aip31068_i2c-13, Led-87) são os desse projeto.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { CoreClient } = require(path.join(repo, "extension", "out", "ipc", "CoreClient.js"));

const projectPath = process.argv[2] ?? "C:\\Prof_Josue\\0II1\\II1P06_SPI_I2C_UART\\lasecSimul\\devkitc_test.lsproj";
const firmwarePath = process.argv[3] ?? "C:\\Prof_Josue\\0II1\\II1P06_SPI_I2C_UART\\sourcecode\\merged.bin";
const durationMs = Number(process.argv[4] ?? 15000);
// RUNTIME_ROOT=<extensão instalada>\bundled roda contra o Core/devices empacotados em vez dos do repo.
const runtimeRoot = process.env.RUNTIME_ROOT ? path.resolve(process.env.RUNTIME_ROOT) : repo;
const corePath = path.join(runtimeRoot, "core", "build", "Release", "lasecsimul-core.exe");
const qemuPath = path.join(runtimeRoot, "devices", "qemu-esp32", "bin", "qemu-system-xtensa.exe");
const subcircuitPath = path.join(runtimeRoot, "subcircuits", "esp32_devkitc_v4.lssubcircuit");
const coreLogPath = path.join(os.tmpdir(), "lasecsimul-display-edges-core.log");

const project = JSON.parse(fs.readFileSync(projectPath, "utf8"));
const pipeName = `lasecsimul-display-edges-${process.pid}-${Date.now()}`;
const core = spawn(corePath, ["--pipe", pipeName], { cwd: repo, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let coreLog = "";
core.stdout.on("data", (c) => { coreLog += c.toString(); });
core.stderr.on("data", (c) => { coreLog += c.toString(); });
const client = new CoreClient(pipeName, { requestTimeoutMs: 30000 });
const instances = new Map();
const log = (...a) => console.error("[display-edges]", ...a);

function resolveEndpoint(ep) {
  const inst = instances.get(ep.componentId);
  if (inst.exposedPins) return inst.exposedPins[ep.pinId];
  return { instanceId: inst.instanceId, pinId: ep.pinId };
}

// Cabeçalho comum de runtimeState: versão @0, largura @8, altura @12, habilitado @16, payload @36.
function summarize(buf) {
  if (!buf || buf.length < 36) return { bytes: buf?.length ?? 0 };
  const payload = buf.subarray(36);
  return {
    enabled: buf.readUInt32LE(16),
    nonZero: [...payload].filter((v) => v !== 0).length,
    text: payload.subarray(0, 32).toString("latin1").replace(/[^\x20-\x7e]/g, "."),
  };
}

// getComponentState responde "simulacao ocupada" enquanto um settle está em andamento.
async function stateWithRetry(instanceId) {
  for (let i = 0; i < 20; ++i) {
    try { return await client.getComponentState(instanceId); } catch { await new Promise((r) => setTimeout(r, 50)); }
  }
  return undefined;
}

async function main() {
  await client.start();
  await client.loadDeviceLibrary(path.join(runtimeRoot, "devices", "library.json"));
  await client.loadDeviceLibrary(path.join(runtimeRoot, "mcu-adapters", "library.json"));
  await client.registerAdhocSubcircuitDefinition(subcircuitPath);
  const catalog = await client.getPropertySchemas();

  for (const c of project.components) {
    const pins = (catalog.pinIdsByTypeId[c.typeId] ?? []).map((id) => ({ id, x: 0, y: 0 }));
    const props = Object.fromEntries(Object.entries(c.properties ?? {}).filter(([k]) => !k.startsWith("__ui_")));
    const r = await client.addComponent(c.typeId, props, pins, c.id, c.label ? [c.label] : []);
    instances.set(c.id, r);
    if (c.typeId === "connectors.tunnel" && c.properties?.name) {
      await client.setTunnelName(r.instanceId, pins[0]?.id ?? "pin", "", String(c.properties.name));
    }
  }
  for (const w of project.topology.conductors) {
    const a = resolveEndpoint(w.from), b = resolveEndpoint(w.to);
    await client.connectWire(a.instanceId, a.pinId, b.instanceId, b.pinId);
  }

  const board = instances.get("devkitC-46");
  const mcuId = board.primaryMcuInstanceId ?? await client.getSubcircuitChildInstanceId(board.instanceId, "mcu1");
  const pcd = instances.get("Pcd8544-19").instanceId;
  const lcd = instances.get("Aip31068_i2c-13").instanceId;

  // Mesmos valores padrão que extension/src/core/coreLifecycle.ts envia (exceto realTimeRate).
  await client.setSimulationConfig({
    targetStepUs: 0, realTimeRate: Number(process.env.RTR ?? 0), maxNonLinearIterations: 0, performanceProfiling: false,
    integrationMethod: "automatic", adaptiveTimeStep: true, initialStepNs: 100, minimumStepNs: 1,
    maximumStepNs: 100000, relativeTolerance: 1e-4, absoluteTolerance: 1e-9,
  });
  await client.run();
  await client.loadMcuFirmware(mcuId, firmwarePath, qemuPath);
  log("firmware carregado");

  const probes = [
    ["pcd.ce", "Pcd8544-19", "ce"], ["pcd.dc", "Pcd8544-19", "dc"], ["pcd.clk", "Pcd8544-19", "clk"],
    ["pcd.rst", "Pcd8544-19", "rst"], ["esp.G19", "devkitC-46", "G19"],
    ["lcd.sda", "Aip31068_i2c-13", "sda"], ["lcd.scl", "Aip31068_i2c-13", "scl"],
    ["esp.G17", "devkitC-46", "G17"], ["led.anode", "Led-87", "anode"],
    ["esp.G13(botao)", "devkitC-46", "G13"], ["esp.G12(espelho)", "devkitC-46", "G12"], ["esp.G27(pisca)", "devkitC-46", "G27"],
  ].map(([key, comp, pin]) => ({ key, ...resolveEndpoint({ componentId: comp, pinId: pin }) }));
  // TOGGLE_BUTTON=1: desliga a fonte do botão na 6ª leitura e religa na 10ª, para ver se o
  // firmware acompanha a entrada GPIO13 (G12 espelha o que ele leu).
  const buttonId = instances.get("Fixed Voltage-3")?.instanceId;

  let probeAllTimer;
  if (process.env.PROBEALL) {
    const all = [];
    for (const w of project.topology.conductors) for (const ep of [w.from, w.to]) {
      const r = resolveEndpoint(ep);
      all.push({ key: `${ep.componentId}.${ep.pinId}`, instanceId: r.instanceId, pinId: r.pinId });
    }
    let busy = false;
    probeAllTimer = setInterval(() => {
      if (busy) return;
      busy = true;
      client.getNodeVoltages(all).catch(() => {}).finally(() => { busy = false; });
    }, 33);
  }

  let uart = "";
  let lastPcd;
  const t0 = performance.now();
  let iteration = 0;
  while (performance.now() - t0 < durationMs) {
    await new Promise((r) => setTimeout(r, 1000));
    ++iteration;
    if (process.env.TOGGLE_BUTTON && buttonId) {
      if (iteration === 6) { await client.setProperty(buttonId, "out", false); log("botao -> 0 V"); }
      if (iteration === 10) { await client.setProperty(buttonId, "out", true); log("botao -> 5 V"); }
    }
    const time = await client.getSimulationTime();
    uart += await client.getProperty(mcuId, "uart0_tx_monitor_hex").catch(() => "");
    const v = await client.getNodeVoltages(probes);
    const volts = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, Number(x).toFixed(2)]));
    log(`t=${((time.mcuVirtualNs ?? time.simulatedNs) / 1e6).toFixed(0)}ms`, JSON.stringify(volts));
    const pcdState = await stateWithRetry(pcd);
    log("  pcd", JSON.stringify(summarize(pcdState)));
    if (pcdState && pcdState.length >= 540 && pcdState.subarray(36).some((b) => b !== 0)) lastPcd = Buffer.from(pcdState);
    log("  lcd", JSON.stringify(summarize(await stateWithRetry(lcd))));
  }
  clearInterval(probeAllTimer);
  log("UART:", JSON.stringify(Buffer.from(uart, "hex").toString("latin1").slice(-Number(process.env.UARTLEN ?? 200))));
  if (lastPcd && process.env.DUMP) {
    // PCD8544: 6 páginas de 84 bytes, bit 0 = linha de cima da página.
    const fb = lastPcd.subarray(36);
    for (let y = 0; y < 48; ++y) {
      let row = "";
      for (let x = 0; x < 84; ++x) row += (fb[(y >> 3) * 84 + x] >> (y & 7)) & 1 ? "#" : ".";
      console.error(row);
    }
  }
  await client.stopSimulation();
  await client.stop();
}

main()
  .catch((e) => { console.error("[display-edges] ERRO", e); process.exitCode = 1; })
  .finally(() => {
    core.kill();
    fs.writeFileSync(coreLogPath, coreLog);
    log(`log do Core em ${coreLogPath}`);
  });
