// Measures, inside a real VS Code, how an ESP32 project starts and how often its
// SSD1306 display changes in the schematic Webview. Compares extension builds:
//   LASECSIMUL_RATE_EXTENSION=<unpacked extension dir> (default: this checkout)
//   LASECSIMUL_RATE_FIXTURE=<.lsproj>  LASECSIMUL_RATE_SECONDS=20
//   LASECSIMUL_RATE_NETWORK=lab-router|isolated  LASECSIMUL_RATE_RUNS=1
// Prints one JSON line per run.
const { chromium } = require("@playwright/test");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const extensionPath = path.resolve(process.env.LASECSIMUL_RATE_EXTENSION || path.resolve(__dirname, "../.."));
const fixturePath = path.resolve(process.env.LASECSIMUL_RATE_FIXTURE || "C:/SourceCode/II1P04_GPIO_Debug/lasecSimul/display.lsproj");
const seconds = Number(process.env.LASECSIMUL_RATE_SECONDS || 20);
const runs = Number(process.env.LASECSIMUL_RATE_RUNS || 1);
const network = process.env.LASECSIMUL_RATE_NETWORK || "lab-router";
const executable = process.env.VSCODE_EXECUTABLE_PATH
  || path.resolve(__dirname, "../../.vscode-test/vscode-win32-x64-archive-1.128.0/Code.exe");
const extraExtensions = (process.env.LASECSIMUL_RATE_EXTRA_EXTENSIONS || "").split(";").filter(Boolean);

async function oneRun(index) {
  const port = 9700 + Math.floor(Math.random() * 100);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-rate-user-"));
  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-rate-ext-"));
  for (const extra of extraExtensions) fs.cpSync(extra, path.join(extensionsDir, path.basename(extra)), { recursive: true });
  fs.mkdirSync(path.join(userData, "User"), { recursive: true });
  fs.writeFileSync(path.join(userData, "User", "settings.json"), JSON.stringify({
    "lasecsimul.network.mode": network,
    ...(process.env.LASECSIMUL_RATE_SETTINGS ? JSON.parse(process.env.LASECSIMUL_RATE_SETTINGS) : {}),
  }));
  const childEnv = { ...process.env, LASECSIMUL_E2E: "1", LASECSIMUL_E2E_FIXTURE: fixturePath };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, `--extensions-dir=${extensionsDir}`,
    `--extensionDevelopmentPath=${extensionPath}`, "--disable-workspace-trust", "--disable-updates",
    "--skip-welcome", "--force-device-scale-factor=1", "--disable-gpu", "--disable-shared-process", "--new-window",
  ], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  let childOutput = "";
  child.stdout.on("data", (chunk) => { childOutput += String(chunk); });
  child.stderr.on("data", (chunk) => { childOutput += String(chunk); });
  let browser;
  const result = { run: index, extension: extensionPath, network };
  try {
    for (let attempt = 0; attempt < 120 && !browser; attempt += 1) {
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); }
      catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
    if (!browser) throw new Error("VS Code de teste não iniciou");
    let workbench;
    for (let attempt = 0; attempt < 160 && !workbench; attempt += 1) {
      workbench = browser.contexts().flatMap((context) => context.pages()).find((page) => page.url().includes("workbench"));
      if (!workbench) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!workbench) throw new Error("Workbench não abriu");
    await workbench.setViewportSize({ width: 1440, height: 1000 });
    const activity = workbench.locator('.activitybar [aria-label*="LasecSimul"], .activitybar [title*="LasecSimul"]').first();
    await activity.waitFor({ state: "visible", timeout: 60000 });
    await activity.click();
    let frame;
    for (let attempt = 0; attempt < 240 && !frame; attempt += 1) {
      for (const candidate of workbench.frames()) {
        if (candidate !== workbench.mainFrame() && await candidate.locator('.component').count().catch(() => 0)) { frame = candidate; break; }
      }
      if (!frame) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!frame) {
      if (process.env.LASECSIMUL_RATE_SCREENSHOT) await workbench.screenshot({ path: process.env.LASECSIMUL_RATE_SCREENSHOT });
      throw new Error(`Esquemático não abriu: ${childOutput.slice(-1500)}`);
    }
    const project = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    const displayId = project.components.find((component) => component.typeId === "outputs.ssd1306")?.id;
    await frame.evaluate((id) => {
      window.__rate = { messages: 0, displayChanges: 0, last: undefined, firstChangeMs: undefined, start: performance.now(), types: {} };
      window.addEventListener("message", (event) => {
        const data = event.data;
        window.__rate.types[data?.type] = (window.__rate.types[data?.type] || 0) + 1;
        if (data?.type === "simulationRate" || data?.type === "mcuRealTimeRatio")
          (window.__rate.rates = window.__rate.rates || []).push([Math.round(performance.now()), data]);
        if (data?.type !== "componentVisualState") return;
        window.__rate.messages += 1;
        const encoded = data.statesByComponentId?.[id];
        if (encoded !== undefined && encoded !== window.__rate.last) {
          if (window.__rate.last !== undefined && window.__rate.firstChangeMs === undefined)
            window.__rate.firstChangeMs = performance.now() - window.__rate.start;
          window.__rate.last = encoded;
          window.__rate.displayChanges += 1;
          (window.__rate.frames = window.__rate.frames || []).push([performance.now(), encoded]);
        }
      });
    }, displayId);
    // Start the simulation the way the user does (F5 / Run command).
    await workbench.keyboard.press("F1");
    const input = workbench.locator(".quick-input-widget input").first();
    await input.waitFor({ state: "visible", timeout: 15000 });
    await input.fill(">LasecSimul: Run Simulation");
    await workbench.waitForTimeout(500);
    await workbench.keyboard.press("Enter");
    const startedAt = Date.now();
    await workbench.waitForTimeout(seconds * 1000);
    const rate = await frame.evaluate(() => window.__rate);
    const elapsed = (Date.now() - startedAt) / 1000;
    Object.assign(result, {
      seconds: elapsed,
      visualStateMessagesPerSecond: rate.messages / elapsed,
      displayChangesPerSecond: rate.displayChanges / elapsed,
      displayChanges: rate.displayChanges,
      firstDisplayChangeMs: rate.firstChangeMs,
      messageTypes: rate.types,
      rates: (rate.rates || []).slice(-6),
    });
    if (process.env.LASECSIMUL_RATE_FRAMES) fs.writeFileSync(process.env.LASECSIMUL_RATE_FRAMES, JSON.stringify(rate.frames || []));
  } catch (error) {
    result.error = String(error && error.message || error);
  } finally {
    await browser?.close().catch(() => undefined);
    child.kill();
    await new Promise((resolve) => setTimeout(resolve, 3000));
    // The extension's Output channel is mirrored in the VS Code logs of this profile.
    const logs = path.join(userData, "logs");
    const lines = [];
    const walk = (dir) => { for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/LasecSimul/i.test(entry.name)) lines.push(...fs.readFileSync(full, "utf8").split(/\r?\n/));
    } };
    walk(logs);
    result.logLines = lines.filter(Boolean).length;
    result.logTail = lines.filter(Boolean).slice(-12);
  }
  return result;
}

(async () => {
  for (let index = 1; index <= runs; index += 1) console.log(JSON.stringify(await oneRun(index)));
})().catch((error) => { console.error(error); process.exitCode = 1; });
