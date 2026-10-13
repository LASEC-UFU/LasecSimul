// Bancada de interação de fios: abre o VS Code real com a extensão, dirige o esquemático com o
// mouse de verdade (CDP) e mede o que o usuário percebe -- forma do fio a cada passo, quadros,
// custo dos handlers e latência do commit. Usada por `run-wire-scenarios-e2e.cjs`.
const { chromium } = require("@playwright/test");
const { downloadAndUnzipVSCode } = require("@vscode/test-electron");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const harnessRoot = path.resolve(__dirname, "../..");
// Permite medir OUTRA cópia da extensão (ex.: a versão anterior) com esta mesma bancada.
const extensionPath = process.env.LASECSIMUL_WIRE_LAB_EXTENSION ? path.resolve(process.env.LASECSIMUL_WIRE_LAB_EXTENSION) : harnessRoot;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function launch({ fixture, width = 1720, height = 1000, readySelector = ".component", settings }) {
  const port = 9600 + Math.floor(Math.random() * 300);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-wire-lab-user-"));
  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-wire-lab-ext-"));
  if (settings) {
    // Configurações do usuário do VS Code de teste (ex.: { "lasecsimul.language": "pt-BR" }).
    fs.mkdirSync(path.join(userData, "User"), { recursive: true });
    fs.writeFileSync(path.join(userData, "User", "settings.json"), JSON.stringify(settings));
  }
  const executable = await downloadAndUnzipVSCode({
    version: process.env.VSCODE_E2E_VERSION || "1.128.0",
    cachePath: path.resolve(harnessRoot, ".vscode-test"),
    timeout: 120000,
  });
  const childEnv = { ...process.env, LASECSIMUL_E2E: "1", LASECSIMUL_E2E_FIXTURE: fixture };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  let childOutput = "";
  const child = spawn(executable, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, `--extensions-dir=${extensionsDir}`,
    `--extensionDevelopmentPath=${extensionPath}`, "--disable-workspace-trust", "--disable-updates",
    "--skip-welcome", "--force-device-scale-factor=1", "--disable-gpu", "--disable-shared-process", "--new-window",
  ], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  const capture = (chunk) => { childOutput = (childOutput + chunk.toString()).slice(-12000); };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);

  let browser;
  const close = async () => {
    if (browser) await browser.close().catch(() => {});
    child.kill();
  };
  try {
    for (let attempt = 0; attempt < 120 && !browser; attempt += 1) {
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); }
      catch { await sleep(250); }
    }
    if (!browser) throw new Error("VS Code de teste não iniciou");
    let workbench;
    for (let attempt = 0; attempt < 160 && !workbench; attempt += 1) {
      const pages = browser.contexts().flatMap((context) => context.pages());
      workbench = pages.find((page) => page.url().includes("workbench"));
      if (!workbench) await sleep(250);
    }
    if (!workbench) throw new Error("Workbench não abriu");
    await workbench.locator(".monaco-workbench").waitFor({ state: "visible", timeout: 60000 });
    await workbench.setViewportSize({ width, height });
    const activity = workbench.locator('.activitybar [aria-label*="LasecSimul"], .activitybar [title*="LasecSimul"]').first();
    await activity.waitFor({ state: "visible", timeout: 30000 });
    await activity.click();
    let frame;
    for (let attempt = 0; attempt < 200 && !frame; attempt += 1) {
      for (const candidate of workbench.frames()) {
        if (candidate === workbench.mainFrame()) continue;
        if (await candidate.locator(readySelector).count().catch(() => 0)) { frame = candidate; break; }
      }
      if (!frame) await sleep(250);
    }
    if (!frame) throw new Error(`Esquemático de teste não abriu: ${childOutput.slice(-2000)}`);
    await frame.evaluate(() => document.fonts.ready);
    await sleep(1200);
    // O painel de propriedades cobre a metade direita do canvas; recolhe para o teste ver a cena toda.
    const dockToggle = frame.locator(".property-dock__header button").first();
    if (await dockToggle.count()) { await dockToggle.click(); await sleep(300); }
    const lab = await createLab(workbench, frame);
    return { workbench, frame, lab, close, output: () => childOutput };
  } catch (error) {
    await close();
    throw error;
  }
}

async function createLab(workbench, frame) {
  await frame.evaluate(() => {
    const parsePoints = (text) => (text || "").trim().split(/\s+/).filter(Boolean).map((entry) => {
      const [x, y] = entry.split(",").map(Number);
      return { x, y };
    });
    const lab = {
      recording: false, frames: [], handlers: [], mutations: 0, hostPatches: 0, lastFrame: 0,
      shapeLog: [], shapeWatch: undefined,
    };
    window.__wireLab = lab;
    lab.read = () => {
      const layer = document.querySelector(".wire-layer");
      const wires = Array.from(layer?.querySelectorAll("polyline[data-wire-id]") ?? [])
        .filter((el) => !el.classList.contains("wire-layer__wire--outline"))
        .map((el) => ({ id: el.dataset.wireId, points: parsePoints(el.getAttribute("points")) }));
      const previewEl = layer?.querySelector('polyline[data-wire-preview="pending"]');
      const junctions = Array.from(layer?.querySelectorAll(".wire-layer__junction-dot") ?? [])
        .map((el) => ({ x: Number(el.getAttribute("cx")), y: Number(el.getAttribute("cy")) }));
      return { wires, preview: previewEl ? parsePoints(previewEl.getAttribute("points")) : undefined, junctions };
    };
    lab.viewport = () => {
      const canvas = document.querySelector(".canvas");
      const content = document.querySelector(".canvas-content");
      const rect = canvas.getBoundingClientRect();
      const m = new DOMMatrixReadOnly(getComputedStyle(content).transform);
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, x: m.e, y: m.f, zoom: m.a };
    };
    const tick = (now) => {
      if (lab.recording && lab.lastFrame) lab.frames.push(now - lab.lastFrame);
      lab.lastFrame = now;
      if (lab.recording && lab.shapeWatch) {
        const current = lab.shapeWatch();
        const text = JSON.stringify(current);
        if (lab.shapeLog.length === 0 || lab.shapeLog[lab.shapeLog.length - 1].text !== text) lab.shapeLog.push({ text, value: current });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    // Custo de TODOS os handlers de um pointermove: tempo entre a fase de captura na janela e a
    // primeira tarefa depois do despacho.
    const channel = new MessageChannel();
    let pendingStart = 0;
    channel.port1.onmessage = () => {
      if (pendingStart) { lab.handlers.push(performance.now() - pendingStart); pendingStart = 0; }
    };
    window.addEventListener("pointermove", () => {
      if (!lab.recording || pendingStart) return;
      pendingStart = performance.now();
      channel.port2.postMessage(0);
    }, { capture: true });
    new MutationObserver((records) => { if (lab.recording) lab.mutations += records.length; })
      .observe(document.querySelector(".canvas"), { childList: true, subtree: true, attributes: true });
    lab.pointer = undefined;
    window.addEventListener("pointermove", (event) => { lab.pointer = { x: event.clientX, y: event.clientY }; }, { capture: true });
    lab.syncLog = [];
    window.addEventListener("message", (event) => {
      const data = event.data;
      if (data?.type !== "syncStatePatch" && data?.type !== "syncState") return;
      if (lab.recording) lab.hostPatches += 1;
      lab.syncLog.push({ type: data.type, keys: data.patch ? Object.keys(data.patch).join("+") : "*", at: Math.round(performance.now()) });
      if (lab.syncLog.length > 200) lab.syncLog.shift();
    }, { capture: true });
    lab.start = (watch) => {
      lab.frames = []; lab.handlers = []; lab.mutations = 0; lab.hostPatches = 0; lab.shapeLog = [];
      lab.shapeWatch = watch === "preview" ? () => lab.read().preview ?? null
        : watch ? () => lab.read().wires.find((wire) => wire.id === watch)?.points ?? null
        : undefined;
      lab.recording = true;
    };
    lab.stop = () => {
      lab.recording = false;
      const stats = (values) => {
        if (values.length === 0) return { n: 0, p50: 0, p95: 0, max: 0 };
        const sorted = [...values].sort((a, b) => a - b);
        const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
        return { n: sorted.length, p50: +at(0.5).toFixed(2), p95: +at(0.95).toFixed(2), max: +sorted[sorted.length - 1].toFixed(2) };
      };
      return {
        frames: stats(lab.frames), slowFrames: lab.frames.filter((ms) => ms > 34).length,
        handlers: stats(lab.handlers), mutations: lab.mutations, hostPatches: lab.hostPatches,
        shapes: lab.shapeLog.map((entry) => entry.value),
      };
    };
  });

  const canvasBox = await frame.locator(".canvas").boundingBox();
  const viewport = async () => frame.evaluate(() => window.__wireLab.viewport());
  const first = await viewport();
  // Coordenadas do frame -> coordenadas da página do workbench (o que `mouse.move` espera).
  const frameOffset = { x: canvasBox.x - first.left, y: canvasBox.y - first.top };
  const toPage = async (scene) => {
    const v = await viewport();
    return { x: Math.round(frameOffset.x + v.left + v.x + scene.x * v.zoom), y: Math.round(frameOffset.y + v.top + v.y + scene.y * v.zoom) };
  };
  const mouse = workbench.mouse;
  const read = () => frame.evaluate(() => window.__wireLab.read());
  const lab = {
    frame, workbench, read, viewport, toPage, canvasBox,
    actions: 0,
    async pinScene(componentId, pinId) {
      return frame.evaluate(([c, p]) => {
        const el = document.querySelector(`.pin-terminal[data-component-id="${c}"][data-pin-id="${p}"]`);
        if (!el) return undefined;
        const box = el.getBoundingClientRect();
        const v = window.__wireLab.viewport();
        return { x: (box.left + box.width / 2 - v.left - v.x) / v.zoom, y: (box.top + box.height / 2 - v.top - v.y) / v.zoom };
      }, [componentId, pinId]);
    },
    async componentScene(componentId) {
      return frame.evaluate((c) => {
        const el = document.querySelector(`.component[data-component-id="${c}"]`);
        if (!el) return undefined;
        const box = el.getBoundingClientRect();
        const v = window.__wireLab.viewport();
        return { x: (box.left + box.width / 2 - v.left - v.x) / v.zoom, y: (box.top + box.height / 2 - v.top - v.y) / v.zoom };
      }, componentId);
    },
    async move(scene, steps = 1) { const p = await toPage(scene); await mouse.move(p.x, p.y, { steps }); },
    /** Garante que o frame VIU o ponteiro chegar em `p` antes de apertar: logo depois de uma rajada
     * de movimentos, o Chromium às vezes descarta o move+down seguintes (o frame recebe só o up). */
    async settlePointerAt(p) {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        // Afasta um pouco e volta: um move para a mesma posição não gera evento novo.
        await mouse.move(p.x + 2 + attempt, p.y + 1);
        await mouse.move(p.x, p.y);
        await sleep(25 + attempt * 10);
        const seen = await frame.evaluate(() => window.__wireLab.pointer);
        if (seen && Math.abs(seen.x + frameOffset.x - p.x) <= 1 && Math.abs(seen.y + frameOffset.y - p.y) <= 1) return;
      }
      throw new Error(`o frame não recebeu o ponteiro em ${p.x},${p.y}`);
    },
    async click(scene, options = {}) {
      const p = await toPage(scene);
      await lab.settlePointerAt(p);
      await mouse.down(options); await sleep(20); await mouse.up(options); await sleep(20);
      lab.actions += 1;
    },
    async rightClick(scene) { const p = await toPage(scene); await mouse.click(p.x, p.y, { button: "right" }); lab.actions += 1; },
    async drag(from, to, { steps = 16, button = "left", hold } = {}) {
      const a = await toPage(from); const b = await toPage(to);
      await lab.settlePointerAt(a);
      await mouse.down({ button });
      await sleep(20);
      await mouse.move(b.x, b.y, { steps });
      if (hold) await hold();
      await mouse.up({ button });
      lab.actions += 1;
    },
    async key(combo) { await workbench.keyboard.press(combo); lab.actions += 1; },
    async start(watch) { await frame.evaluate((w) => window.__wireLab.start(w), watch); },
    async stop() { return frame.evaluate(() => window.__wireLab.stop()); },
    async settle(ms = 350) { await sleep(ms); },
    async takeSyncLog() { return frame.evaluate(() => window.__wireLab.syncLog.splice(0)); },
    async now() { return frame.evaluate(() => Math.round(performance.now())); },
    async shot(file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      await workbench.screenshot({ path: file, clip: { x: canvasBox.x, y: canvasBox.y, width: Math.min(canvasBox.width, 900), height: Math.min(canvasBox.height, 560) } });
      return file;
    },
    /** Espera o fio confirmado aparecer e devolve quanto tempo levou (ms) desde a chamada. */
    async waitWireCount(count, timeoutMs = 5000) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const state = await read();
        if (state.wires.length === count) return Date.now() - started;
        await sleep(15);
      }
      throw new Error(`esperava ${count} fio(s), há ${(await read()).wires.length}`);
    },
  };
  return lab;
}

/** Sequência de orientações da 1ª perna (H/V) -- trocas contam como "virada" do cotovelo. */
function firstLegOrientations(shapes) {
  const result = [];
  for (const points of shapes) {
    if (!points || points.length < 3) continue;
    const orientation = points[0].y === points[1].y ? "H" : points[0].x === points[1].x ? "V" : "D";
    result.push(orientation);
  }
  return result;
}

function countChanges(values) {
  let changes = 0;
  for (let index = 1; index < values.length; index += 1) if (values[index] !== values[index - 1]) changes += 1;
  return changes;
}

function isOrthogonal(points) {
  for (let index = 0; index + 1 < points.length; index += 1) {
    if (points[index].x !== points[index + 1].x && points[index].y !== points[index + 1].y) return false;
  }
  return true;
}

module.exports = { launch, sleep, firstLegOrientations, countChanges, isOrthogonal, extensionPath };
