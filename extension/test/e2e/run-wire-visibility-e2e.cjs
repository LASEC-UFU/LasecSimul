const { chromium } = require("@playwright/test");
const { downloadAndUnzipVSCode } = require("@vscode/test-electron");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const extensionPath = process.env.LASECSIMUL_WIRE_EXTENSION || path.resolve(__dirname, "../..");
const fixturePath = process.env.LASECSIMUL_WIRE_FIXTURE
  ? path.resolve(process.env.LASECSIMUL_WIRE_FIXTURE)
  : process.env.LASECSIMUL_WIRE_CLIP_REGRESSION
    ? path.resolve(__dirname, "../../../test/fixtures/projects/wire-overflow.lsproj")
  : path.resolve(__dirname, "../../../examples/hart-pactware-4-20.lsproj");

(async () => {
  const port = 9900 + Math.floor(Math.random() * 100);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-wire-e2e-user-"));
  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-wire-e2e-ext-"));
  const executable = process.env.LASECSIMUL_WIRE_VSCODE || await downloadAndUnzipVSCode({ version: "1.128.0", cachePath: path.resolve(extensionPath, ".vscode-test"), timeout: 120000 });
  const childEnv = { ...process.env, LASECSIMUL_E2E: "1",
    LASECSIMUL_E2E_FIXTURE: process.env.LASECSIMUL_WIRE_REOPEN
      ? path.resolve(__dirname, "../../../test/fixtures/projects/basic-passive.lsproj") : fixturePath,
    LASECSIMUL_E2E_REOPEN_FIXTURE: process.env.LASECSIMUL_WIRE_REOPEN ? fixturePath : undefined };
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
  try {
    for (let attempt = 0; attempt < 100 && !browser; attempt += 1) {
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); }
      catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
    if (!browser) throw new Error("VS Code de teste não iniciou");
    let workbench;
    for (let attempt = 0; attempt < 140 && !workbench; attempt += 1) {
      workbench = browser.contexts().flatMap((context) => context.pages()).find((page) => page.url().includes("workbench"));
      if (!workbench) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!workbench) throw new Error("Workbench não abriu");
    await workbench.setViewportSize({
      width: Number(process.env.LASECSIMUL_WIRE_WIDTH || 1440),
      height: Number(process.env.LASECSIMUL_WIRE_HEIGHT || (process.env.LASECSIMUL_WIRE_CLIP_REGRESSION ? 700 : 1000)),
    });
    const activity = workbench.locator('.activitybar [aria-label*="LasecSimul"], .activitybar [title*="LasecSimul"]').first();
    await activity.waitFor({ state: "visible", timeout: 30000 });
    await activity.click();
    let frame;
    for (let attempt = 0; attempt < 160 && !frame; attempt += 1) {
      for (const candidate of workbench.frames()) {
        if (candidate !== workbench.mainFrame() && await candidate.locator(".component").count().catch(() => 0)) {
          frame = candidate;
          break;
        }
      }
      if (!frame) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!frame) throw new Error(`Esquemático de teste não abriu: ${childOutput.slice(-2000)}`);
    if (process.env.LASECSIMUL_WIRE_CLIP_REGRESSION) {
      await frame.locator('.property-dock__header button').first().click();
    }
    if (process.env.LASECSIMUL_WIRE_REOPEN) {
      await frame.evaluate(() => {
        window.__wireReloadMessages = [];
        window.addEventListener("message", (event) => window.__wireReloadMessages.push(event.data?.type));
      });
      const firstId = JSON.parse(fs.readFileSync(fixturePath, "utf8")).components[0].id;
      await frame.locator(`.component[data-component-id="${firstId}"]`).waitFor({ state: "attached", timeout: 10000 });
      const messages = await frame.evaluate(() => window.__wireReloadMessages);
      if (!messages.includes("syncState")) throw new Error(`Reabertura não enviou estado completo: ${JSON.stringify(messages)}`);
    }
    if (process.env.LASECSIMUL_WIRE_CREATE) {
      const leftPins = frame.locator('.pin-terminal[data-component-id="left"]');
      const rightPins = frame.locator('.pin-terminal[data-component-id="right"]');
      await leftPins.first().waitFor({ state: "visible" });
      const wiresBefore = await frame.locator('.wire-layer__wire:not(.wire-layer__wire--preview)').count();
      await leftPins.last().click();
      await rightPins.first().click();
      await frame.waitForFunction((count) =>
        document.querySelectorAll('.wire-layer__wire:not(.wire-layer__wire--preview)').length > count,
      wiresBefore, { timeout: 5000 });
    }
    const state = await frame.evaluate(() => ({
      components: document.querySelectorAll(".component").length,
      wireLayer: Boolean(document.querySelector(".wire-layer")),
      layerBox: document.querySelector(".wire-layer")?.getBoundingClientRect().toJSON(),
      layerOverflow: document.querySelector(".wire-layer") ? getComputedStyle(document.querySelector(".wire-layer")).overflow : null,
      canvasBox: document.querySelector(".canvas")?.getBoundingClientRect().toJSON(),
      wires: Array.from(document.querySelectorAll(".wire-layer__wire:not(.wire-layer__wire--preview)"))
        .map((wire) => ({ points: wire.getAttribute("points"), box: wire.getBoundingClientRect().toJSON(), stroke: getComputedStyle(wire).stroke })),
    }));
    process.stdout.write(`wire visibility E2E OK: ${state.wires.length} connection(s)\n`);
    if (process.env.LASECSIMUL_WIRE_DEBUG) process.stdout.write(`${JSON.stringify(state)}\n`);
    if (process.env.LASECSIMUL_WIRE_SCREENSHOT) {
      await workbench.screenshot({ path: path.resolve(process.env.LASECSIMUL_WIRE_SCREENSHOT) });
    }
    if (!state.wires.length || !state.wires.some((wire) => wire.box.width > 0 || wire.box.height > 0)) {
      throw new Error(`Conexões salvas não estão visíveis: ${JSON.stringify(state)}`);
    }
    if (process.env.LASECSIMUL_WIRE_CLIP_REGRESSION) {
      const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      const clippedInCanvas = state.wires.some((wire) =>
        intersects(wire.box, state.canvasBox) && !intersects(wire.box, state.layerBox));
      if (!clippedInCanvas || state.layerOverflow !== "visible") {
        throw new Error(`SVG clips wires inside the canvas: ${JSON.stringify(state)}`);
      }
      const hit = await frame.evaluate(() => {
        const layer = document.querySelector('.wire-layer').getBoundingClientRect();
        const canvas = document.querySelector('.canvas').getBoundingClientRect();
        return Array.from(document.querySelectorAll('.wire-layer__segment-handle')).map((handle) => {
          const box = handle.getBoundingClientRect();
          const x = (box.left + box.right) / 2;
          const y = (box.top + box.bottom) / 2;
          return { x, y, outsideLayer: y > layer.bottom || x > layer.right, insideCanvas: x >= canvas.left && x < canvas.right && y >= canvas.top && y < canvas.bottom, target: document.elementFromPoint(x, y)?.getAttribute('class') };
        }).filter((sample) => sample.outsideLayer && sample.insideCanvas);
      });
      if (!hit.some((sample) => sample.target?.includes('wire-layer__segment-handle'))) {
        throw new Error(`Visible wire cannot be selected outside the SVG viewport: ${JSON.stringify(hit)}`);
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    child.kill();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
