const { chromium } = require("@playwright/test");
const { downloadAndUnzipVSCode } = require("@vscode/test-electron");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const extensionPath = path.resolve(__dirname, "../..");
const fixturePath = path.resolve(__dirname, "fixtures/connections.lsproj");
const center = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

(async () => {
  const port = 9900 + Math.floor(Math.random() * 100);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-terminal-e2e-user-"));
  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-terminal-e2e-ext-"));
  const executable = await downloadAndUnzipVSCode({ version: "1.128.0", cachePath: path.resolve(extensionPath, ".vscode-test"), timeout: 120000 });
  const childEnv = { ...process.env, LASECSIMUL_E2E: "1", LASECSIMUL_E2E_FIXTURE: fixturePath };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, `--extensions-dir=${extensionsDir}`,
    `--extensionDevelopmentPath=${extensionPath}`, "--disable-workspace-trust", "--disable-updates",
    "--skip-welcome", "--force-device-scale-factor=1", "--disable-gpu", "--disable-shared-process", "--new-window",
  ], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
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
    await workbench.setViewportSize({ width: 1440, height: 1000 });
    const activity = workbench.locator('.activitybar [aria-label*="LasecSimul"], .activitybar [title*="LasecSimul"]').first();
    await activity.waitFor({ state: "visible", timeout: 30000 });
    await activity.click();
    let frame;
    for (let attempt = 0; attempt < 160 && !frame; attempt += 1) {
      for (const candidate of workbench.frames()) {
        if (candidate !== workbench.mainFrame() && await candidate.locator('.component[data-component-id="source"]').count().catch(() => 0)) {
          frame = candidate;
          break;
        }
      }
      if (!frame) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!frame) throw new Error("Esquemático de teste não abriu");

    const component = frame.locator('.component[data-component-id="obstacle"]');
    const pin = component.locator(".pin-terminal").first();
    const box = await component.boundingBox();
    if (!box) throw new Error("Componente não visível");
    await workbench.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
    await frame.getByRole("button", { name: /Edit terminals|Editar terminais/ }).click();
    await pin.waitFor({ state: "visible" });
    const start = center(await pin.boundingBox());
    const destination = { x: start.x - 15, y: start.y + 12 };
    await workbench.mouse.move(start.x, start.y);
    await workbench.mouse.down();
    await workbench.mouse.move(destination.x, destination.y, { steps: 6 });
    await workbench.mouse.up();
    await pin.waitFor({ state: "visible" });
    if (!(await pin.evaluate((element) => element.classList.contains("pin-terminal--selected")))) {
      throw new Error("Terminal arrastado não permaneceu selecionado");
    }

    // Reproduz o relato: menu aberto sobre o corpo depois de selecionar o terminal.
    await workbench.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
    const menu = frame.locator(".context-menu").first();
    await menu.getByRole("button", { name: /Rotate clockwise|Girar no sentido horário/ }).waitFor({ state: "visible" });
    for (const name of [/Rotate counter-clockwise|Girar no sentido anti-horário/, /Rotate 180°|Girar 180°/,
      /Flip horizontally|Inverter horizontalmente/, /Flip vertically|Inverter verticalmente/]) {
      if (!(await menu.getByRole("button", { name }).count())) throw new Error(`Ação ausente: ${name}`);
    }
    if (await menu.getByRole("button", { name: /Copy|Copiar/ }).count()) throw new Error("Menu do componente abriu no lugar do terminal");
    const before = await component.locator(".component__symbol").innerHTML();
    await menu.getByRole("button", { name: /Rotate clockwise|Girar no sentido horário/ }).click();
    let after = await component.locator(".component__symbol").innerHTML();
    for (let attempt = 0; attempt < 30 && before === after; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      after = await component.locator(".component__symbol").innerHTML();
    }
    if (before === after) throw new Error(`Giro não mudou a orientação visual do terminal; markup=${before.slice(0, 280)}`);
    if (!(await pin.evaluate((element) => element.classList.contains("pin-terminal--selected")))) {
      throw new Error("Terminal perdeu a seleção depois do giro");
    }
    const beforeFlip = center(await pin.boundingBox());
    await workbench.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
    await frame.locator(".context-menu").first().getByRole("button", { name: /Flip horizontally|Inverter horizontalmente/ }).click();
    let afterFlip = center(await pin.boundingBox());
    for (let attempt = 0; attempt < 30 && Math.abs(afterFlip.x - beforeFlip.x) < 3; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      afterFlip = center(await pin.boundingBox());
    }
    if (Math.abs(afterFlip.x - beforeFlip.x) < 3) {
      throw new Error(`Inversão horizontal não moveu o terminal no eixo visual: ${JSON.stringify({ beforeFlip, afterFlip })}`);
    }
    process.stdout.write("terminal editor E2E OK\n");
  } finally {
    if (browser) await browser.close().catch(() => {});
    child.kill();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
