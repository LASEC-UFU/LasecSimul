// Métricas da unificação visual (docs/63 §3.2) medidas no VS Code real: M1 (Dock/Undock até a vista pintada),
// M2 (tela cheia sem operação de documento, relayout), M6 (heap por vista e crescimento em ciclos de janela),
// M7 (arrastar numa página de 300 elementos), M8 (interação matemática), M10 (bytes do init da vista).
// Uso: npm run test:visual:performance. Grava test/e2e/artifacts/visual-performance/metrics.json.
// ATENÇÃO: abre uma janela do VS Code na sessão do usuário e alterna janela flutuante/tela cheia (avise
// quem estiver usando a máquina). Não usa a área de transferência.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const extensionPath = path.resolve(__dirname, "../..");
const artifacts = path.join(extensionPath, "test", "e2e", "artifacts", "visual-performance");
const req = (name) => require(path.join(extensionPath, "node_modules", name));
const { chromium } = req("@playwright/test");
const { downloadAndUnzipVSCode } = req("@vscode/test-electron");
fs.mkdirSync(artifacts, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (cond, label, detail = "") => { console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? ` -- ${detail}` : ""}`); if (!cond) failures++; return cond; };
const percentile = (values, p) => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

function writeFixture(workspace) {
  const elements = [];
  for (let index = 0; index < 300; index++) {
    const col = index % 20, row = Math.floor(index / 20);
    const x = 30 + col * 92, y = 30 + row * 68;
    elements.push(index % 3 === 0
      ? { id: `d-${index}`, typeId: "graphics.value_display", label: `D${index}`, properties: { width: 84, height: 44, label: `D${index}`, bindSource: "k1", bindDecimals: 1 }, visual: { x, y, width: 84, height: 44, rotation: 0 } }
      : index % 3 === 1
        ? { id: `r-${index}`, typeId: "graphics.rectangle", label: `R${index}`, properties: { width: 84, height: 44, stroke: "#94a3b8", fill: "#1e293b" }, visual: { x, y, width: 84, height: 44, rotation: 0 } }
        : { id: `l-${index}`, typeId: "graphics.label", label: `L${index}`, properties: { width: 84, height: 30, text: `Rótulo ${index}`, stroke: "#e2e8f0" }, visual: { x, y, width: 84, height: 30, rotation: 0 } });
  }
  const math = [
    { id: "p-a", typeId: "graphics.math.parameter", label: "a", properties: { width: 300, height: 72, name: "a", min: -3, max: 3, step: 0.01, value: 1 }, visual: { x: 40, y: 60, width: 300, height: 72, rotation: 0 } },
    { id: "p-b", typeId: "graphics.math.parameter", label: "b", properties: { width: 300, height: 72, name: "b", min: -5, max: 5, step: 0.1, value: 0 }, visual: { x: 40, y: 150, width: 300, height: 72, rotation: 0 } },
    { id: "plot", typeId: "graphics.math.function_plot", label: "plot", properties: { width: 900, height: 560, expression: "a x^2 + b x - 2", expression2: "sin(x)", xMin: -5, xMax: 5, yMin: -6, yMax: 10, showDerivative: true, showRoots: true }, visual: { x: 380, y: 60, width: 900, height: 560, rotation: 0 } },
    { id: "eq", typeId: "graphics.math.equation", label: "eq", properties: { width: 900, height: 80, lhs: "f(x)", expression: "a x^2 + b x - 2", substitute: true }, visual: { x: 380, y: 650, width: 900, height: 80, rotation: 0 } },
    { id: "tab", typeId: "graphics.math.value_table", label: "tab", properties: { width: 300, height: 560, expression: "a x^2 + b x - 2", start: -5, step: 1, rows: 11 }, visual: { x: 1320, y: 60, width: 300, height: 560, rotation: 0 } },
  ];
  const project = {
    schemaVersion: 2,
    components: [
      { id: "k1", typeId: "control.constant", properties: { value: 42, unit: "" }, label: "K1", visual: { x: 80, y: 240, rotation: 0 } },
      { id: "botao", typeId: "tools.hmi_screen", label: "Medida", properties: { title: "Medida", screenId: "medida", width: 176, height: 64 }, visual: { x: 80, y: 80, rotation: 0 } },
    ],
    topology: { revision: 0, nodes: [], conductors: [] },
    visual: { viewport: { x: 0, y: 0, zoom: 1 } },
    simulationSettings: {},
    visualDocuments: [{
      schemaVersion: 1, id: "medida", kind: "screen", title: "Medida", presentation: { fullscreenContext: "lab" }, startPageId: "grande",
      pages: [{ id: "grande", name: "300 elementos", width: 1920, height: 1080, elements }, { id: "math", name: "Matemática", width: 1920, height: 1080, elements: math }],
    }],
  };
  const file = path.join(workspace, "medida.lsproj");
  fs.writeFileSync(file, JSON.stringify(project, null, 2));
  return file;
}

async function launch(workspace) {
  const port = 9600 + Math.floor(Math.random() * 300);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-perf-user-"));
  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-perf-ext-"));
  fs.mkdirSync(path.join(userData, "User"), { recursive: true });
  fs.writeFileSync(path.join(userData, "User", "settings.json"), JSON.stringify({
    "lasecsimul.network.mode": "isolated", "workbench.startupEditor": "none", "lasecsimul.language": "pt-BR", "window.customTitleBarVisibility": "windowed",
    "workbench.secondarySideBar.defaultVisibility": "hidden", "chat.disableAIFeatures": true,
  }));
  const executable = process.env.VSCODE_EXECUTABLE_PATH
    ?? await downloadAndUnzipVSCode({ version: process.env.VSCODE_E2E_VERSION || "1.128.0", cachePath: path.resolve(extensionPath, ".vscode-test"), timeout: 120000 });
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, `--extensions-dir=${extensionsDir}`, "--js-flags=--expose-gc",
    `--extensionDevelopmentPath=${extensionPath}`, "--disable-workspace-trust", "--disable-updates", "--skip-welcome",
    "--force-device-scale-factor=1", "--disable-gpu", "--disable-shared-process", "--new-window", workspace,
  ], { env: childEnv, stdio: ["ignore", fs.openSync(path.join(artifacts, "vscode.stdout.log"), "w"), fs.openSync(path.join(artifacts, "vscode.stderr.log"), "w")] });
  let browser;
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
  return { browser, workbench, child };
}

const allPages = (browser) => browser.contexts().flatMap((context) => context.pages());

/** A vista da tela já PINTADA (300 elementos no DOM), em qualquer janela; `exclude` = a vista anterior. */
async function paintedView(browser, exclude, attempts = 400) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    for (const page of allPages(browser)) {
      for (const frame of page.frames()) {
        if (frame === exclude) continue;
        try {
          if (await frame.evaluate(() => document.body.classList.contains("visual-role") && document.querySelectorAll(".component").length >= 300)) return { page, frame };
        } catch { /* frame em troca */ }
      }
    }
    await sleep(25);
  }
  return undefined;
}

(async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-perf-ws-"));
  writeFixture(workspace);
  const { browser, workbench, child } = await launch(workspace);
  const metrics = {};
  try {
    await workbench.setViewportSize({ width: 1700, height: 1100 });
    await sleep(4000);
    for (let attempt = 0; attempt < 10; attempt++) {
      await workbench.keyboard.press("Control+P");
      const quick = workbench.locator(".quick-input-widget input").first();
      await quick.waitFor({ state: "visible", timeout: 15000 });
      await quick.fill("medida.lsproj");
      try {
        await workbench.locator(".quick-input-list .monaco-list-row", { hasText: "medida.lsproj" }).first().waitFor({ state: "visible", timeout: 3000 });
        break;
      } catch { await workbench.keyboard.press("Escape"); await sleep(1000); }
    }
    await workbench.keyboard.press("Enter");
    let schematic;
    for (let attempt = 0; attempt < 240 && !schematic; attempt++) {
      for (const frame of workbench.frames()) {
        if (await frame.locator('.component[data-component-id="botao"]').count().catch(() => 0)) { schematic = frame; break; }
      }
      if (!schematic) await sleep(250);
    }
    if (!schematic) throw new Error("esquemático não abriu");
    const openStarted = Date.now();
    await schematic.locator('.component[data-component-id="botao"]').first().dblclick();
    let view = await paintedView(browser);
    if (!view) throw new Error("tela não abriu");
    metrics.openMs = Date.now() - openStarted;

    // M10: bytes do init da vista (a 1ª pintura vem do estado embutido no HTML; o init chega depois).
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await view.frame.evaluate(() => window.__visualStats.boot.init > 0).catch(() => false)) break;
      await sleep(100);
    }
    const stats = await view.frame.evaluate(() => ({ ...window.__visualStats }));
    metrics.M10_initKB = round(stats.initBytes / 1024);
    // M6: heap da vista.
    const heap = async (frame) => frame.evaluate(() => { if (typeof window.gc === "function") window.gc(); return performance.memory?.usedJSHeapSize ?? 0; });
    metrics.M6_heapMB = round(await heap(view.frame) / 1048576);

    // M1: Undock/Dock até a vista seguinte pintada (cada troca de janela recria a Webview).
    const cycles = [];
    const heaps = [];
    for (let cycle = 0; cycle < 20; cycle++) {
      const toFloat = cycle % 2 === 0;
      const button = view.frame.locator(".appbar--visual .appbar__button", { hasText: toFloat ? "Desacoplar" : "Acoplar" }).first();
      const started = Date.now();
      await button.click();
      const next = await paintedView(browser, view.frame);
      if (!next) throw new Error(`ciclo ${cycle}: a vista não voltou`);
      cycles.push(Date.now() - started);
      view = next;
      heaps.push(await heap(view.frame));
      await sleep(400);
    }
    metrics.M1_windowSwitchMs = { p50: percentile(cycles, 50), p95: percentile(cycles, 95), samples: cycles };
    // Vistas flutuantes e acopladas vivem em processos diferentes: compara acoplada com acoplada
    // (ciclos ímpares voltam a acoplar), do 1º retorno ao último.
    const dockedHeaps = heaps.filter((_, index) => index % 2 === 1);
    metrics.M6_heapSeriesMB = heaps.map((value) => round(value / 1048576));
    metrics.M6_heapAfterCyclesMB = round(dockedHeaps[dockedHeaps.length - 1] / 1048576);
    metrics.M6_growthMB = round((dockedHeaps[dockedHeaps.length - 1] - dockedHeaps[0]) / 1048576);
    // Vazamento = tendência, não a diferença entre duas amostras ruidosas (cada ciclo é um documento novo):
    // inclinação por mínimos quadrados das vistas acopladas, em MB por ciclo de janela.
    const xs = dockedHeaps.map((_, index) => index);
    const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
    const meanY = dockedHeaps.reduce((a, b) => a + b, 0) / dockedHeaps.length;
    const slope = xs.reduce((acc, x, index) => acc + (x - meanX) * (dockedHeaps[index] - meanY), 0) / Math.max(1e-9, xs.reduce((acc, x) => acc + (x - meanX) ** 2, 0));
    metrics.M6_slopeMBPerCycle = round(slope / 1048576, 2);

    // M2: tela cheia e volta: nenhuma gravação de documento; tempo até a vista em tela cheia relayoutada.
    const sendsBefore = (await view.frame.evaluate(() => window.__visualStats.documentSends));
    const fullStarted = Date.now();
    await view.frame.locator(".visual-corner-button--enter").click();
    let full;
    for (let attempt = 0; attempt < 400 && !full; attempt++) {
      for (const page of allPages(browser)) {
        for (const frame of page.frames()) {
          if (await frame.evaluate(() => document.body.classList.contains("visual-fullscreen") && document.querySelectorAll(".component").length >= 300).catch(() => false)) { full = { page, frame }; break; }
        }
        if (full) break;
      }
      if (!full) await sleep(25);
    }
    metrics.M2_fullscreenMs = Date.now() - fullStarted;
    const sendsDuring = full ? await full.frame.evaluate(() => window.__visualStats.documentSends) : -1;
    await full?.frame.locator(".visual-corner-button--exit").click();
    // Começou acoplada: sair da tela cheia volta a acoplar, o que recria a Webview -- espera a vista nova.
    let docked;
    for (let attempt = 0; attempt < 400 && !docked; attempt++) {
      for (const candidate of allPages(browser).flatMap((p) => p.frames().map((frame) => ({ page: p, frame })))) {
        if (candidate.frame === full?.frame) continue;
        const ok = await candidate.frame.evaluate(() => document.body.classList.contains("visual-role") && !document.body.classList.contains("visual-undocked")
          && !document.body.classList.contains("visual-fullscreen") && document.querySelectorAll(".component").length >= 300).catch(() => false);
        if (ok) { docked = candidate; break; }
      }
      if (!docked) await sleep(50);
    }
    if (!docked) throw new Error("a vista não voltou acoplada depois da tela cheia");
    view = docked;
    await sleep(800);
    const sendsAfter = await view.frame.evaluate(() => window.__visualStats.documentSends);
    metrics.M2_documentSends = { before: sendsBefore, inFullscreenView: sendsDuring, after: sendsAfter };

    // M7: arrastar um elemento da página de 300 (edição): duração dos quadros durante o gesto.
    const element = view.frame.locator('.component[data-component-id="r-151"]').first();
    const box = await element.boundingBox();
    // Linha de base: a cadência de quadros da janela PARADA (a de teste roda com --disable-gpu e pode não
    // pintar a 60 Hz); o arrasto é julgado contra ela, não contra 16,7 ms absolutos.
    const idle = await view.frame.evaluate(() => new Promise((resolve) => {
      const deltas = [];
      let last = performance.now();
      const tick = (now) => { deltas.push(now - last); last = now; if (deltas.length < 62) requestAnimationFrame(tick); else resolve(deltas.slice(2)); };
      requestAnimationFrame(tick);
    }));
    metrics.M7_idleFrameMs = { p50: round(percentile(idle, 50)), p95: round(percentile(idle, 95)) };
    await view.frame.evaluate(() => {
      window.__frames = [];
      let last = performance.now();
      const tick = (now) => { window.__frames.push(now - last); last = now; if (window.__framesOn) requestAnimationFrame(tick); };
      window.__framesOn = true;
      requestAnimationFrame(tick);
    });
    await view.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await view.page.mouse.down();
    for (let step = 1; step <= 60; step++) {
      await view.page.mouse.move(box.x + box.width / 2 + step * 4, box.y + box.height / 2 + step * 2);
    }
    await view.page.mouse.up();
    const frames = await view.frame.evaluate(() => { window.__framesOn = false; return window.__frames.slice(2); });
    metrics.M7_dragFrameMs = { p50: round(percentile(frames, 50)), p95: round(percentile(frames, 95)), frames: frames.length };

    // M8: interação matemática (página Matemática, operação): repintura dos elementos por mudança de parâmetro.
    await view.frame.locator(".appbar--visual select[title=\"Página\"]").selectOption("math");
    await view.frame.locator(".appbar--visual .appbar__button", { hasText: "Operar" }).click();
    await view.frame.locator("#labTabs button, .appbar--visual").first().waitFor({ timeout: 10000 });
    const page = view.frame.locator(".appbar--visual select[title=\"Página\"]");
    if (await page.count()) await page.selectOption("math").catch(() => undefined);
    const tabs = view.frame.locator("#labTabs button", { hasText: "Matemática" });
    if (await tabs.count()) await tabs.first().click();
    await view.frame.locator('.component[data-component-id="p-a"]').waitFor({ timeout: 10000 });
    await view.frame.evaluate(() => { window.__visualStats.mathRepaintMs.length = 0; });
    const slider = await view.frame.locator('.component[data-component-id="p-a"]').first().boundingBox();
    await view.page.mouse.move(slider.x + 20, slider.y + slider.height * 0.75);
    await view.page.mouse.down();
    for (let step = 0; step < 60; step++) await view.page.mouse.move(slider.x + 20 + step * 4, slider.y + slider.height * 0.75);
    await view.page.mouse.up();
    const repaint = await view.frame.evaluate(() => window.__visualStats.mathRepaintMs.slice());
    metrics.M8_mathRepaintMs = { p50: round(percentile(repaint, 50), 2), p95: round(percentile(repaint, 95), 2), samples: repaint.length };

    fs.writeFileSync(path.join(artifacts, "metrics.json"), `${JSON.stringify({ vscode: process.env.VSCODE_EXECUTABLE_PATH ?? process.env.VSCODE_E2E_VERSION ?? "1.128.0", at: new Date().toISOString(), metrics }, null, 2)}\n`);
    console.log(JSON.stringify(metrics, null, 2));
    check(metrics.M1_windowSwitchMs.p95 <= 1500, "M1: Dock/Undock até a vista pintada p95 ≤ 1,5 s", `${metrics.M1_windowSwitchMs.p95} ms`);
    check(metrics.M2_documentSends.before === metrics.M2_documentSends.after, "M2: tela cheia não grava o documento", JSON.stringify(metrics.M2_documentSends));
    check(metrics.M6_heapMB <= 40, "M6: heap da vista ≤ 40 MB", `${metrics.M6_heapMB} MB`);
    // Guarda de regressão: o init de 36 MB (catálogo inteiro) custava ~20 MB por troca. Hoje sobra uma
    // deriva de ~0,3–0,6 MB/troca no processo da vista com ruído de ±4 MB (documento novo a cada troca,
    // init constante de 89 KB): registrada como pendência no doc 65 §7, investigar com heap snapshots.
    check(metrics.M6_slopeMBPerCycle <= 1, "M6: sem crescimento grande em 20 trocas de janela (≤ 1 MB por troca; ver doc 65 §7)", `${metrics.M6_slopeMBPerCycle} MB/troca; série ${JSON.stringify(metrics.M6_heapSeriesMB)}`);
    check(metrics.M7_dragFrameMs.p95 <= metrics.M7_idleFrameMs.p95 + 16.7, "M7: arrastar com 300 elementos não perde mais de um quadro além da cadência da janela parada",
      `arrasto p95 ${metrics.M7_dragFrameMs.p95} ms × parada p95 ${metrics.M7_idleFrameMs.p95} ms`);
    check(metrics.M8_mathRepaintMs.samples > 0 && metrics.M8_mathRepaintMs.p95 <= 16, "M8: repintura matemática por mudança de parâmetro p95 ≤ 16 ms", `${metrics.M8_mathRepaintMs.p95} ms`);
    check(metrics.M10_initKB > 0 && metrics.M10_initKB <= 200, "M10: init da vista ≤ 200 KB", `${metrics.M10_initKB} KB`);
  } catch (error) {
    check(false, "execução sem exceção", String(error && error.stack || error));
    await workbench.screenshot({ path: path.join(artifacts, "failure.png") }).catch(() => undefined);
  } finally {
    await browser.close().catch(() => undefined);
    try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* já saiu */ }
  }
  console.log(failures === 0 ? "\nDesempenho visual: tudo ok" : `\nDesempenho visual: ${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
})();
