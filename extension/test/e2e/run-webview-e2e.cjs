const { chromium } = require("@playwright/test");
const { downloadAndUnzipVSCode } = require("@vscode/test-electron");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const pixelmatch = require("pixelmatch").default;
const { PNG } = require("pngjs");

const extensionPath = path.resolve(__dirname, "../..");
const fixturePath = path.resolve(__dirname, "fixtures/instruments.lsproj");
const artifacts = path.resolve(__dirname, "artifacts");
const baselines = path.resolve(__dirname, "snapshots");
const update = process.env.UPDATE_SNAPSHOTS === "1";
fs.mkdirSync(artifacts, { recursive: true });
fs.mkdirSync(baselines, { recursive: true });

async function executablePath() {
  if (process.env.VSCODE_EXECUTABLE_PATH) return process.env.VSCODE_EXECUTABLE_PATH;
  return downloadAndUnzipVSCode({
    version: process.env.VSCODE_E2E_VERSION || "1.128.0",
    cachePath: path.resolve(extensionPath, ".vscode-test"),
    timeout: 120000,
  });
}

async function connect(port) {
  let last;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { return await chromium.connectOverCDP(`http://127.0.0.1:${port}`); }
    catch (error) { last = error; await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  throw last;
}

function compare(name, actualPath) {
  const expectedPath = path.join(baselines, `${name}.png`);
  if (update || !fs.existsSync(expectedPath)) {
    fs.copyFileSync(actualPath, expectedPath);
    return { pixels: 0, ratio: 0, updated: true };
  }
  const expected = PNG.sync.read(fs.readFileSync(expectedPath));
  const actual = PNG.sync.read(fs.readFileSync(actualPath));
  if (expected.width !== actual.width || expected.height !== actual.height) {
    throw new Error(`${name}: dimensão ${actual.width}x${actual.height}, esperado ${expected.width}x${expected.height}`);
  }
  const diff = new PNG({ width: actual.width, height: actual.height });
  const pixels = pixelmatch(expected.data, actual.data, diff.data, actual.width, actual.height, {
    threshold: 0.12,
    includeAA: false,
  });
  fs.writeFileSync(path.join(artifacts, `${name}.diff.png`), PNG.sync.write(diff));
  fs.copyFileSync(expectedPath, path.join(artifacts, `${name}.expected.png`));
  const ratio = pixels / (actual.width * actual.height);
  if (ratio > 0.005) throw new Error(`${name}: ${pixels} pixels diferentes (${(ratio * 100).toFixed(3)}%)`);
  return { pixels, ratio, updated: false };
}

async function command(workbench, title) {
  await workbench.keyboard.press("Control+Shift+P");
  const input = workbench.locator(".quick-input-widget input, .quick-input-box input").first();
  await input.waitFor({ state: "visible" });
  await input.fill(title);
  await workbench.keyboard.press("Enter");
}

async function domClick(locator) {
  await locator.evaluate((element) => element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true })));
}

(async () => {
  const port = 9300 + Math.floor(Math.random() * 500);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-e2e-user-"));
  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-e2e-ext-"));
  const childEnv = { ...process.env, LASECSIMUL_E2E: "1", LASECSIMUL_E2E_FIXTURE: fixturePath };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(await executablePath(), [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userData}`,
    `--extensions-dir=${extensionsDir}`,
    `--extensionDevelopmentPath=${extensionPath}`,
    "--disable-workspace-trust",
    "--disable-updates",
    "--skip-welcome",
    "--force-device-scale-factor=1",
    "--disable-gpu",
    "--disable-shared-process",
    "--new-window",
  ], {
    env: childEnv,
    stdio: ["ignore", fs.openSync(path.join(artifacts, "vscode.stdout.log"), "w"), fs.openSync(path.join(artifacts, "vscode.stderr.log"), "w")],
  });
  let browser;
  try {
    browser = await connect(port);
    let pages = [];
    let workbench;
    for (let attempt = 0; attempt < 120 && !workbench; attempt++) {
      pages = browser.contexts().flatMap((context) => context.pages());
      workbench = pages.find((page) => page.url().includes("workbench"))
        ?? pages.find((page) => page.url().startsWith("vscode-file:"));
      if (!workbench) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    fs.writeFileSync(path.join(artifacts, "pages.json"), JSON.stringify(await Promise.all(pages.map(async (page) => ({ url: page.url(), title: await page.title() }))), null, 2));
    if (!workbench) throw new Error("VS Code de teste não criou uma página de workbench");
    await workbench.locator(".monaco-workbench").waitFor({ state: "visible", timeout: 60000 });
    await workbench.screenshot({ path: path.join(artifacts, "workbench.png") });
    await workbench.setViewportSize({ width: 1440, height: 1000 });
    const activity = workbench.locator('.activitybar [aria-label*="LasecSimul"], .activitybar [title*="LasecSimul"]').first();
    await activity.waitFor({ state: "visible", timeout: 30000 });
    await activity.click(); // ativa a extensão; o modo E2E abre a fixture pelo pipeline real

    let paletteFrame;
    for (let attempt = 0; attempt < 120 && !paletteFrame; attempt++) {
      for (const frame of workbench.frames()) {
        if (frame === workbench.mainFrame()) continue;
        try {
          if (await frame.locator(".palette-tabs").count()) { paletteFrame = frame; break; }
        } catch { /* a view pode substituir o iframe durante a ativacao */ }
      }
      if (!paletteFrame) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!paletteFrame) throw new Error("Paleta real do LasecSimul nao abriu");

    const controlTab = paletteFrame.getByRole("tab", { name: /^(Controle|Control)$/ }).first();
    await controlTab.waitFor({ state: "visible", timeout: 30000 });
    await domClick(controlTab);
    await paletteFrame.locator('.palette-item[title^="plc.instance"]').waitFor({ state: "attached", timeout: 30000 });

    const processTab = paletteFrame.getByRole("tab", { name: /^(Processo|Process)$/ }).first();
    await processTab.waitFor({ state: "visible", timeout: 30000 });
    await domClick(processTab);

    const requiredProcessTypeIds = [
      "protocol.modbus.server",
      "protocol.modbus.client",
      "protocol.hart.transmitter",
      "protocol.hart.communicator",
      "subcircuits.process.fopdt",
      "subcircuits.tdps.basic_flow_loop",
      "subcircuits.tdps.smith_predictor",
      "subcircuits.tdps.split_range",
      "subcircuits.tdps.surge_tank_level",
      "subcircuits.tdps.heat_exchanger",
      "subcircuits.tdps.furnace_combustion",
      "subcircuits.tdps.boiler_drum",
      "subcircuits.tdps.reactor_temperature",
      "subcircuits.tdps.ph_neutralization",
    ];
    for (const typeId of requiredProcessTypeIds) {
      await paletteFrame.locator(`.palette-item[title^="${typeId}"]`).waitFor({ state: "attached", timeout: 30000 });
    }
    await paletteFrame.locator(".palette").screenshot({
      path: path.join(artifacts, "process-palette.actual.png"),
      animations: "disabled",
    });

    let instrumentFrame;
    for (let attempt = 0; attempt < 120 && !instrumentFrame; attempt++) {
      for (const frame of workbench.frames()) {
        if (frame === workbench.mainFrame()) continue;
        try {
          if (await frame.locator('.component[data-component-id="scope"]').count()) { instrumentFrame = frame; break; }
        } catch { /* VS Code substitui o iframe vazio pelo Webview real durante a ativação */ }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!instrumentFrame) throw new Error("Webview real não abriu a fixture determinística");
    await instrumentFrame.evaluate(() => document.fonts.ready);

    await domClick(instrumentFrame.locator('.component[data-component-id="scope"] .meter-expand-button'));
    const scope = instrumentFrame.locator('.instrument-popup[data-component-id="scope"]');
    await scope.waitFor({ state: "visible" });
    const scopeActual = path.join(artifacts, "oscope.actual.png");
    await scope.screenshot({ path: scopeActual, animations: "disabled" });
    const scopeResult = compare("oscope", scopeActual);
    await domClick(scope.locator(".instrument-popup__close"));

    await domClick(instrumentFrame.locator('.component[data-component-id="logic"] .meter-expand-button'));
    const analyzer = instrumentFrame.locator('.instrument-popup[data-component-id="logic"]');
    await analyzer.waitFor({ state: "visible" });
    const restoredCondition = await analyzer.locator(".instrument-trigger-condition").inputValue();
    if (restoredCondition !== "1 == 1") {
      throw new Error(`condição persistida não foi restaurada: ${JSON.stringify(restoredCondition)}`);
    }
    // A condicao persistida e verdadeira no primeiro timestamp. Limpe-a temporariamente para a
    // aquisicao materializar todos os canais antes de testar a pausa; caso contrario o Core pode
    // pausar antes da primeira rodada de telemetria e o snapshot fica dependente do timing de IPC.
    const conditionInput = analyzer.locator(".instrument-trigger-condition");
    await conditionInput.fill("");
    await conditionInput.dispatchEvent("change");
    await new Promise((resolve) => setTimeout(resolve, 500));
    await domClick(instrumentFrame.locator(".appbar__button--start"));
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await analyzer.getByText("DATA[7]", { exact: true }).first().waitFor({ state: "visible", timeout: 15000 });
    await conditionInput.fill("1 == 1");
    await conditionInput.dispatchEvent("change");
    fs.writeFileSync(path.join(artifacts, "webview-state.txt"), await instrumentFrame.locator("body").innerText());
    await analyzer.locator(".instrument-pause-event").waitFor({ state: "visible", timeout: 15000 });
    const analyzerActual = path.join(artifacts, "analyzer.actual.png");
    await analyzer.screenshot({ path: analyzerActual, animations: "disabled" });
    const analyzerResult = compare("analyzer", analyzerActual);

    // Resize real observado pelo mesmo ResizeObserver da UI e persistência
    // após fechar/reabrir.
    const before = await analyzer.boundingBox();
    if (!before) throw new Error("não foi possível medir a janela do analisador");
    const expectedSize = {
      // Reduzir evita que o max-width/max-height responsivo do iframe masque
      // a alteração quando o editor estiver estreito.
      width: Math.max(620, Math.round(before.width - 80)),
      height: Math.max(390, Math.round(before.height - 60)),
    };
    await analyzer.evaluate((element, size) => {
      element.style.width = `${size.width}px`;
      element.style.height = `${size.height}px`;
      element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    }, expectedSize);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const resized = await analyzer.boundingBox();
    if (!resized || Math.abs(resized.width - expectedSize.width) > 2 || Math.abs(resized.height - expectedSize.height) > 2) {
      throw new Error("redimensionamento responsivo do analisador não foi aplicado");
    }
    await domClick(analyzer.locator(".instrument-popup__close"));
    await domClick(instrumentFrame.locator('.component[data-component-id="logic"] .meter-expand-button'));
    const reopened = instrumentFrame.locator('.instrument-popup[data-component-id="logic"]');
    await reopened.waitFor({ state: "visible" });
    const after = await reopened.boundingBox();
    if (!after || Math.abs(expectedSize.width - after.width) > 2 || Math.abs(expectedSize.height - after.height) > 2) throw new Error("configuração da janela não persistiu ao reabrir");

    fs.writeFileSync(path.join(artifacts, "results.json"), JSON.stringify({
      viewport: { width: 1440, height: 1000, deviceScaleFactor: 1 },
      comparison: { algorithm: "pixelmatch", threshold: 0.12, maxDifferentRatio: 0.005, antialiasingIgnored: true },
      scope: scopeResult,
      analyzer: analyzerResult,
    }, null, 2));
    console.log(`Webview E2E OK: scope=${scopeResult.pixels}px analyzer=${analyzerResult.pixels}px`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (process.platform === "win32" && child.pid) {
      await new Promise((resolve) => {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
        killer.once("exit", resolve);
        killer.once("error", resolve);
      });
    } else child.kill();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
