// Reopening projects with embedded plants (trm/ld301): Quick Open the orifice plate project, close
// it, open the pressurized tank project, close it and open both again -- each plant must be drawn.
// Regression (v0.0.82): the project's catalog entry was `hidden` (meant only for the palette); it
// survives between projects and, on the second opening, the instance inherited `hidden` and the
// plant vanished from the schematic.
const { chromium } = require("@playwright/test");
const { downloadAndUnzipVSCode } = require("@vscode/test-electron");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const extensionPath = path.resolve(__dirname, "../..");
const projectsDir = path.resolve(__dirname, "../../../trm/ld301");
const PROJECTS = [
  { file: "placa_orificio_ld301.lsproj", typeId: "subcircuits.local.orifice_flow_dp" },
  { file: "tanque_pressurizado_ld301.lsproj", typeId: "subcircuits.local.pressurized_tank_dp" },
];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-reopen-ws-"));
  for (const { file } of PROJECTS) fs.copyFileSync(path.join(projectsDir, file), path.join(workspace, file));
  const plantIds = Object.fromEntries(PROJECTS.map(({ file, typeId }) => [file,
    JSON.parse(fs.readFileSync(path.join(workspace, file), "utf8")).components.find((component) => component.typeId === typeId).id]));
  const port = 9900 + Math.floor(Math.random() * 100);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-reopen-user-"));
  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-reopen-ext-"));
  fs.mkdirSync(path.join(userData, "User"), { recursive: true });
  fs.writeFileSync(path.join(userData, "User", "settings.json"), JSON.stringify({ "lasecsimul.network.mode": "isolated", "workbench.startupEditor": "none" }));
  const executable = process.env.LASECSIMUL_REOPEN_VSCODE || await downloadAndUnzipVSCode({ version: "1.128.0", cachePath: path.resolve(extensionPath, ".vscode-test"), timeout: 120000 });
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.LASECSIMUL_E2E_FIXTURE;
  const child = spawn(executable, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, `--extensions-dir=${extensionsDir}`,
    `--extensionDevelopmentPath=${extensionPath}`, "--disable-workspace-trust", "--disable-updates",
    "--skip-welcome", "--force-device-scale-factor=1", "--disable-gpu", "--disable-shared-process", "--new-window", workspace,
  ], { env: childEnv, stdio: "ignore" });
  let browser;
  let failures = 0;
  try {
    for (let attempt = 0; attempt < 120 && !browser; attempt += 1) {
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await sleep(250); }
    }
    if (!browser) throw new Error("VS Code de teste não iniciou");
    let workbench;
    for (let attempt = 0; attempt < 160 && !workbench; attempt += 1) {
      workbench = browser.contexts().flatMap((context) => context.pages()).find((page) => page.url().includes("workbench"));
      if (!workbench) await sleep(250);
    }
    if (!workbench) throw new Error("Workbench não abriu");
    await workbench.setViewportSize({ width: 1600, height: 1000 });
    await sleep(6000);

    const open = async (file) => {
      await workbench.keyboard.press("Control+P");
      const input = workbench.locator(".quick-input-widget input").first();
      await input.waitFor({ state: "visible", timeout: 15000 });
      await input.fill(file);
      await sleep(1200);
      await workbench.keyboard.press("Enter");
    };
    const plantDrawn = async (file) => {
      for (let attempt = 0; attempt < 240; attempt += 1) {
        for (const frame of workbench.frames()) {
          if (frame === workbench.mainFrame()) continue;
          // count() first: boundingBox() of a missing element waits for it (the bug would hang, not fail).
          const plant = frame.locator(`.component[data-component-id="${plantIds[file]}"]`).first();
          if (!(await plant.count().catch(() => 0))) continue;
          const box = await plant.boundingBox({ timeout: 1000 }).catch(() => null);
          if (box && box.width > 100 && box.height > 100) return true;
        }
        await sleep(250);
      }
      return false;
    };
    const steps = [PROJECTS[0].file, PROJECTS[1].file, PROJECTS[0].file, PROJECTS[1].file];
    for (const [index, file] of steps.entries()) {
      if (index > 0) { await workbench.keyboard.press("Control+F4"); await sleep(2000); }
      await open(file);
      const drawn = await plantDrawn(file);
      console.log(`${drawn ? "OK" : "FALHOU"}: abertura ${index + 1} de ${file} desenha a planta incorporada`);
      if (!drawn) failures += 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    failures += 1;
  } finally {
    await browser?.close().catch(() => undefined);
    child.kill();
  }
  process.exitCode = failures === 0 ? 0 : 1;
})();
