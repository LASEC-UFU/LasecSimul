const { chromium } = require("@playwright/test");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "../../..");
const executable = process.env.VSCODE_EXECUTABLE_PATH
  || path.join(repoRoot, "extension", ".vscode-test", "vscode-win32-x64-archive-1.128.0", "Code.exe");
const validationRoot = process.env.LASECSIMUL_VSIX_VALIDATION_ROOT
  || path.join(repoRoot, "dist", "install-validation-codex");
const extensionsDir = path.join(validationRoot, "extensions");
const userDataDir = path.join(validationRoot, "user-data");

async function connect(port) {
  let lastError;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { return await chromium.connectOverCDP(`http://127.0.0.1:${port}`); }
    catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  throw lastError;
}

async function command(workbench, title) {
  await workbench.bringToFront();
  await workbench.keyboard.press("Escape");
  await workbench.locator(".monaco-workbench").click({ position: { x: 500, y: 300 } });
  await workbench.keyboard.press("F1");
  const input = workbench.locator(".quick-input-widget input, .quick-input-box input").first();
  await input.waitFor({ state: "visible" });
  await input.fill(`>${title}`);
  await workbench.keyboard.press("Enter");
}

(async () => {
  if (!fs.existsSync(executable)) throw new Error(`VS Code não encontrado: ${executable}`);
  if (!fs.existsSync(extensionsDir)) throw new Error(`perfil com VSIX instalado não encontrado: ${extensionsDir}`);
  const port = 9800 + Math.floor(Math.random() * 100);
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    `--extensions-dir=${extensionsDir}`,
    "--disable-workspace-trust",
    "--disable-updates",
    "--skip-welcome",
    "--disable-gpu",
    "--disable-shared-process",
    "--new-window",
  ], { env: childEnv, stdio: "ignore" });
  let browser;
  try {
    browser = await connect(port);
    let workbench;
    for (let attempt = 0; attempt < 120 && !workbench; attempt++) {
      const pages = browser.contexts().flatMap((context) => context.pages());
      workbench = pages.find((page) => page.url().includes("workbench"))
        ?? pages.find((page) => page.url().startsWith("vscode-file:"));
      if (!workbench) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!workbench) throw new Error("workbench do VS Code instalado não abriu");
    await workbench.locator(".monaco-workbench").waitFor({ state: "visible", timeout: 60_000 });
    const activity = workbench.locator('.activitybar [aria-label*="LasecSimul"], .activitybar [title*="LasecSimul"]').first();
    await activity.waitFor({ state: "visible", timeout: 30_000 });
    await activity.click();
    await workbench.waitForTimeout(2_000);
    await command(workbench, "LasecSimul: Settings");
    await workbench.locator(".settings-editor").waitFor({ state: "visible", timeout: 30_000 });
    console.log("VSIX instalado OK: extensão ativada e Configurações aberta no VS Code isolado");
  } finally {
    await browser?.close().catch(() => undefined);
    child.kill();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
