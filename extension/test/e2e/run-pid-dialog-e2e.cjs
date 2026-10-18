// E2E do diálogo de sintonia PID no VS Code real com o Core real: o gráfico usa o miniplot.js próprio
// (o Plotly de 3,6 MB saiu do pacote) e recebe as séries gravadas no Core (tempo simulado exato).
// Uso: npm run test:pid:e2e
const { chromium } = require("@playwright/test");
const { downloadAndUnzipVSCode } = require("@vscode/test-electron");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const extensionPath = path.resolve(__dirname, "../..");
const example = path.resolve(extensionPath, "../trm/Sintonia/malha_teste_pid.lsproj");
const artifacts = path.resolve(__dirname, "artifacts");
fs.mkdirSync(artifacts, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function command(workbench, title) {
  await workbench.keyboard.press("Control+Shift+P");
  const input = workbench.locator(".quick-input-widget input, .quick-input-box input").first();
  await input.waitFor({ state: "visible" });
  await input.fill(`>${title}`);
  await workbench.locator(".quick-input-list .monaco-list-row", { hasText: title }).first().waitFor({ state: "visible", timeout: 30000 });
  await sleep(300);
  await workbench.keyboard.press("Enter");
}

let failures = 0;
const check = (cond, label, detail = "") => { console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? ` -- ${detail}` : ""}`); if (!cond) failures++; };

(async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-pid-ws-"));
  fs.copyFileSync(example, path.join(workspace, "malha_teste_pid.lsproj"));
  const port = 9900 + Math.floor(Math.random() * 90);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-pid-user-"));
  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-pid-ext-"));
  fs.mkdirSync(path.join(userData, "User"), { recursive: true });
  fs.writeFileSync(path.join(userData, "User", "settings.json"), JSON.stringify({ "lasecsimul.network.mode": "isolated", "workbench.startupEditor": "none" }));
  const executable = process.env.VSCODE_EXECUTABLE_PATH || await downloadAndUnzipVSCode({ version: process.env.VSCODE_E2E_VERSION || "1.128.0", cachePath: path.resolve(extensionPath, ".vscode-test"), timeout: 120000 });
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, `--extensions-dir=${extensionsDir}`,
    `--extensionDevelopmentPath=${extensionPath}`, "--disable-workspace-trust", "--disable-updates", "--skip-welcome",
    "--force-device-scale-factor=1", "--disable-gpu", "--disable-shared-process", "--new-window", workspace,
  ], { env: childEnv, stdio: ["ignore", fs.openSync(path.join(artifacts, "pid-vscode.stdout.log"), "w"), fs.openSync(path.join(artifacts, "pid-vscode.stderr.log"), "w")] });
  let browser;
  try {
    for (let attempt = 0; attempt < 120 && !browser; attempt++) {
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await sleep(250); }
    }
    if (!browser) throw new Error("VS Code de teste não iniciou");
    let workbench;
    for (let attempt = 0; attempt < 160 && !workbench; attempt++) {
      workbench = browser.contexts().flatMap((context) => context.pages()).find((page) => page.url().includes("workbench"));
      if (!workbench) await sleep(250);
    }
    if (!workbench) throw new Error("Workbench não abriu");
    await workbench.locator(".monaco-workbench").waitFor({ state: "visible", timeout: 60000 });
    await workbench.setViewportSize({ width: 1600, height: 1100 });
    await sleep(4000);

    await workbench.keyboard.press("Control+P");
    const quick = workbench.locator(".quick-input-widget input").first();
    await quick.waitFor({ state: "visible", timeout: 15000 });
    await quick.fill("malha_teste_pid.lsproj");
    await sleep(1200);
    await workbench.keyboard.press("Enter");
    let schematic;
    for (let attempt = 0; attempt < 240 && !schematic; attempt++) {
      for (const frame of workbench.frames()) {
        if (frame === workbench.mainFrame()) continue;
        if (await frame.locator('.component[data-component-id="pid"]').count().catch(() => 0)) { schematic = frame; break; }
      }
      if (!schematic) await sleep(250);
    }
    if (!schematic) throw new Error("esquemático da malha PID não abriu");
    check(true, "malha de teste PID abre no esquemático");

    await schematic.locator('.component[data-component-id="pid"]').click();
    await schematic.locator('.component[data-component-id="pid"] .pid-tuning-trigger').click({ timeout: 10000 });
    let dialog;
    for (let attempt = 0; attempt < 120 && !dialog; attempt++) {
      for (const frame of workbench.frames()) {
        if (await frame.locator("#plotBox").count().catch(() => 0)) { dialog = frame; break; }
      }
      if (!dialog) await sleep(250);
    }
    if (!dialog) throw new Error("diálogo de sintonia não abriu");
    const inDialog = (fn, arg) => dialog.evaluate(fn, arg);
    const waitFor = async (fn, arg, timeoutMs, label) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) { if (await inDialog(fn, arg).catch(() => false)) return true; await sleep(250); }
      console.log(`  (tempo esgotado esperando ${label})`);
      return false;
    };
    const drawn = await waitFor(() => Boolean(document.querySelector("#plotBox .cartesianlayer .subplot.xy .plot")), null, 15000, "miniplot");
    const plotState = drawn ? "" : await inDialog(() => document.getElementById("plotBox")?.textContent ?? "");
    check(drawn, "o gráfico é desenhado pelo miniplot (SVG próprio)", plotState);
    const scripts = await inDialog(() => ({ miniplot: window.Plotly?.miniplot === true, external: [...document.scripts].map((s) => s.src).filter((src) => /plotly|miniplot/i.test(src)) }));
    check(scripts.miniplot && scripts.external.length === 0, "miniplot inline (o iframe srcdoc não busca recursos da Webview) e nada do Plotly", JSON.stringify(scripts));

    await command(workbench, "LasecSimul: Run Simulation");
    check(await waitFor(() => window.__PID_SERIES__ === true, null, 30000, "séries do Core"), "o diálogo passa a receber as séries gravadas no Core");
    check(await waitFor(() => (document.getElementById("plotBox").__miniplot.data?.[0]?.x?.length ?? 0) > 20, null, 30000, "pontos"), "PV, SP e MV chegam ao gráfico");
    const traces = await inDialog(() => {
      const data = document.getElementById("plotBox").__miniplot.data;
      const x = data[0].x;
      let monotonic = true;
      for (let i = 1; i < x.length; i++) if (!(x[i] >= x[i - 1])) monotonic = false;
      return { lengths: data.map((t) => t.x.length), monotonic, last: x[x.length - 1], finite: data.every((t) => t.y.every(Number.isFinite)) };
    });
    check(traces.lengths.every((n) => n === traces.lengths[0]) && traces.monotonic && traces.finite, "três traços alinhados, tempo simulado crescente", JSON.stringify(traces));
    const paths = await dialog.locator("#plotBox path").count();
    check(paths >= 3, "traços desenhados em SVG", `caminhos: ${paths}`);
    await workbench.screenshot({ path: path.join(artifacts, "pid-dialog.png") });
    await command(workbench, "LasecSimul: Stop Simulation");
  } catch (error) {
    console.error(error);
    failures++;
  } finally {
    await browser?.close().catch(() => {});
    child.kill();
  }
  console.log(failures === 0 ? "\nE2E SINTONIA PID OK" : `\n${failures} FALHA(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
