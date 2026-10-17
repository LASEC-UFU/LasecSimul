// E2E da vertical do tanque (docs/53 §2) no VS Code real com o Core real: projeto de exemplo com o
// subcircuito hydraulic_tank, Laboratório de Cálculo, execução, parâmetros ao vivo (A com derramamento),
// pausa, Riemann sobre a série gravada e Reiniciar.
// Uso: npm run test:lab:tank:e2e
const { chromium } = require("@playwright/test");
const { downloadAndUnzipVSCode } = require("@vscode/test-electron");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const extensionPath = path.resolve(__dirname, "../..");
const example = path.resolve(extensionPath, "../examples/calculo/laboratorio-calculo.lsproj");
const artifacts = path.resolve(__dirname, "artifacts");
fs.mkdirSync(artifacts, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
const check = (cond, label, detail = "") => { console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? ` -- ${detail}` : ""}`); if (!cond) failures++; };

(async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-lab-tank-ws-"));
  fs.copyFileSync(example, path.join(workspace, "laboratorio-calculo.lsproj"));
  const port = 9600 + Math.floor(Math.random() * 300);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-lab-tank-user-"));
  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-lab-tank-ext-"));
  fs.mkdirSync(path.join(userData, "User"), { recursive: true });
  fs.writeFileSync(path.join(userData, "User", "settings.json"), JSON.stringify({ "lasecsimul.network.mode": "isolated", "workbench.startupEditor": "none" }));
  const executable = process.env.VSCODE_EXECUTABLE_PATH || await downloadAndUnzipVSCode({ version: process.env.VSCODE_E2E_VERSION || "1.128.0", cachePath: path.resolve(extensionPath, ".vscode-test"), timeout: 120000 });
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, `--extensions-dir=${extensionsDir}`,
    `--extensionDevelopmentPath=${extensionPath}`, "--disable-workspace-trust", "--disable-updates", "--skip-welcome",
    "--force-device-scale-factor=1", "--disable-gpu", "--disable-shared-process", "--new-window", workspace,
  ], { env: childEnv, stdio: ["ignore", fs.openSync(path.join(artifacts, "lab-tank-vscode.stdout.log"), "w"), fs.openSync(path.join(artifacts, "lab-tank-vscode.stderr.log"), "w")] });
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
    await workbench.setViewportSize({ width: 1700, height: 1150 });
    await sleep(5000);

    // abre o projeto de exemplo (editor customizado do esquemático)
    await workbench.keyboard.press("Control+P");
    const quick = workbench.locator(".quick-input-widget input").first();
    await quick.waitFor({ state: "visible", timeout: 15000 });
    await quick.fill("laboratorio-calculo.lsproj");
    await sleep(1200);
    await workbench.keyboard.press("Enter");
    let schematic = false;
    for (let attempt = 0; attempt < 240 && !schematic; attempt++) {
      for (const frame of workbench.frames()) {
        if (frame === workbench.mainFrame()) continue;
        if (await frame.locator('.component[data-component-id="tanque-lab"]').count().catch(() => 0)) { schematic = true; break; }
      }
      if (!schematic) await sleep(250);
    }
    check(schematic, "projeto de exemplo abre com o tanque do laboratório no esquemático");

    // abre o laboratório
    await workbench.keyboard.press("Control+Shift+P");
    const palette = workbench.locator(".quick-input-widget input, .quick-input-box input").first();
    await palette.waitFor({ state: "visible" });
    await palette.fill(">LasecSimul: Laboratório de Cálculo");
    await sleep(500);
    await workbench.keyboard.press("Enter");
    let lab;
    for (let attempt = 0; attempt < 160 && !lab; attempt++) {
      for (const frame of workbench.frames()) {
        if (frame === workbench.mainFrame()) continue;
        try { if (await frame.locator('#labTabs button[data-kind="tank"]').count()) { lab = frame; break; } } catch { /* frame em troca */ }
      }
      if (!lab) await sleep(250);
    }
    if (!lab) { await workbench.screenshot({ path: path.join(artifacts, "calculus-lab-tank-fail.png") }); throw new Error("laboratório não abriu"); }
    await lab.evaluate(() => { window.__csp = []; document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`)); });
    const view = (fn, arg) => lab.evaluate(fn, arg);
    const waitFor = async (fn, arg, timeoutMs, label) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) { if (await view(fn, arg).catch(() => false)) return true; await sleep(200); }
      console.log(`  (tempo esgotado esperando ${label})`);
      return false;
    };

    await lab.locator('#labTabs button[data-kind="tank"]').click();
    check(await waitFor(() => document.querySelector("#tkPlant")?.classList.contains("ok"), null, 30000, "planta ligada"),
      "atividade do tanque liga-se à instância do projeto", await lab.locator("#tkPlant").innerText().catch(() => ""));

    // executar
    await lab.locator("#tkRun").click();
    check(await waitFor(() => window.__lab.view?.buffer?.now >= 3, null, 40000, "3 s simulados"), "execução grava séries do Core (≥ 3 s)");
    const early = await view(() => {
      const b = window.__lab.view.buffer;
      return { V: b.linearAt("V", 2).value, h: b.linearAt("h", 2).value, A: b.linearAt("A", 2).value, q: b.stepValueAt("q", 2, -1), status: document.getElementById("tkStatus").textContent };
    });
    check(Math.abs(early.V - 21.2) < 1e-6 && Math.abs(early.h - 0.212) < 1e-9 && early.A === 0.1, "V(2 s) = 21,2 L e h = 0,212 m (bomba 1 L/s, saída 0,4 L/s)", JSON.stringify(early));
    check(Math.abs(early.q - 0.6) < 1e-9 && /Executando/.test(early.status), "q gravado = 0,6 L/s e estado Executando");

    // parâmetros ao vivo: enche mais rápido
    const setSlider = (id, value) => view(([i, v]) => { const el = document.getElementById(i); el.value = String(v); el.dispatchEvent(new Event("input", { bubbles: true })); }, [id, value]);
    await setSlider("tk_qIn", 2);
    await setSlider("tk_qOut", 0);
    check(await waitFor(() => window.__lab.view.graph.get("params").qIn === 2 && window.__lab.view.graph.get("params").qOut === 0, null, 10000, "parâmetros aceitos"),
      "vazões mudam ao vivo (aceitas pelo Core)");
    check(await waitFor(() => window.__lab.view.buffer.events.some((e) => e.kind === "parameter" && e.name === "qIn"), null, 10000, "evento parameter"),
      "a série traz o evento do parâmetro com o instante aplicado");
    check(await waitFor(() => window.__lab.view.buffer.last("V") > 33, null, 30000, "V > 33 L"), "volume passa de 33 L");

    // A ao vivo: 0,03 m² → Vmax = 30 L < V: derramamento discreto
    await setSlider("tk_area", 0.03);
    check(await waitFor(() => window.__lab.view.buffer.events.some((e) => e.kind === "spill"), null, 10000, "derramamento"), "diminuir A abaixo de V derrama de uma vez");
    await sleep(1500);
    const afterSpill = await view(() => {
      const v = window.__lab.view, b = v.buffer, h = b.col("h"), A = b.col("A");
      let maxH = 0;
      for (let i = 0; i < b.length; i++) if (A[i] === 0.03) maxH = Math.max(maxH, h[i]);
      const spill = b.events.find((e) => e.kind === "spill");
      return { maxH, spill: spill.volume, overflow: b.last("overflow"), tank: document.getElementById("tkTank").textContent };
    });
    check(afterSpill.maxH <= 1 + 1e-9, "h nunca passa da borda depois da mudança de A", `h máx ${afterSpill.maxH}`);
    check(afterSpill.spill > 2 && Math.abs(afterSpill.overflow - 2) < 1e-9 && /transborda/.test(afterSpill.tank), "derrama o excesso e passa a transbordar 2 L/s", JSON.stringify(afterSpill).slice(0, 160));

    // pausa: nada mais chega; Riemann sobre a série gravada
    await lab.locator("#tkPause").click();
    check(await waitFor(() => /Pausado/.test(document.getElementById("tkStatus").textContent), null, 10000, "pausa"), "pausar");
    await sleep(800);
    const lengthPaused = await view(() => window.__lab.view.buffer.length);
    await sleep(1500);
    check(lengthPaused === await view(() => window.__lab.view.buffer.length), "em pausa a série não cresce", String(lengthPaused));
    const riemann = await view(() => {
      const g = window.__lab.view.graph;
      g.batch(() => { g.set("a", 0.5); g.set("b", 2.5); g.set("n", 10); g.set("method", "left"); });
      return g.get("riemann");
    });
    check(Math.abs(riemann.sum - 1.2) < 1e-6 && Math.abs(riemann.exact - 1.2) < 1e-6 && Math.abs(riemann.dV - 1.2) < 1e-6,
      "Riemann entre 0,5 s e 2,5 s = ∫q = ΔV = 1,2 L", JSON.stringify({ sum: riemann.sum, exact: riemann.exact, dV: riemann.dV }));
    await sleep(300);
    check(/1,2/.test(await lab.locator("#tkRiemannSum").innerText()), "resultado de Riemann na tela");

    // equações no cursor
    await view(() => window.__lab.view.graph.set("cursor", 2));
    await sleep(300);
    const equations = await lab.locator("#tkEquations").innerText();
    check(/0,6/.test(equations) && /21,2/.test(equations), "equações mostram q e V no cursor (t = 2 s)", equations.replace(/\s+/g, " ").slice(0, 120));

    await workbench.screenshot({ path: path.join(artifacts, "calculus-lab-tank.png") });

    // reiniciar: nova geração, valores iniciais
    await lab.locator("#tkRestart").click();
    check(await waitFor(() => /Configuração/.test(document.getElementById("tkStatus").textContent) && window.__lab.view.buffer.length === 0, null, 30000, "reinício"),
      "Reiniciar para a simulação e zera as séries");
    const restored = await view(() => ({ ...window.__lab.view.graph.get("params"), slider: document.getElementById("tk_area").value }));
    check(restored.qIn === 1 && restored.qOut === 0.4 && restored.area === 0.1 && restored.slider === "0.1", "parâmetros voltam aos valores da atividade", JSON.stringify(restored));

    const csp = await view(() => window.__csp);
    check(csp.length === 0, "nenhuma violação de CSP", csp.join("; "));
  } catch (error) {
    console.error(error);
    failures++;
  } finally {
    await browser?.close().catch(() => {});
    child.kill();
  }
  console.log(failures === 0 ? "\nE2E TANQUE OK" : `\n${failures} FALHA(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
