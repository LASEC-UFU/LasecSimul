// E2E da vertical do tanque (docs/53 §2) no VS Code real com o Core real: projeto de exemplo com o
// subcircuito hydraulic_tank e a tela "Laboratório de Cálculo" (Tela HMI, docs/62 §6 e docs/64) aberta
// pelo botão do esquemático -- com as páginas de ATIVIDADE do tanque, da primeira ordem e do sensor (o
// exemplo traz páginas compostas de elementos, testadas em run-visual-lab-composed-e2e.cjs), execução, parâmetros ao vivo (A com derramamento), pausa, Riemann sobre a série
// gravada, inspeção sem comandos ao Core, Reiniciar, primeira ordem (τ), sensor 4–20 mA (12 mA e saturação)
// e gravar/reabrir o projeto com a atividade editada no modo professor (edição da tela).
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

async function command(workbench, title) {
  // A lista aberta antes de as contribuições chegarem não se refaz sozinha: reabre até o comando aparecer.
  for (let attempt = 0; ; attempt++) {
    await workbench.keyboard.press("Control+Shift+P");
    const input = workbench.locator(".quick-input-widget input, .quick-input-box input").first();
    await input.waitFor({ state: "visible" });
    await input.fill(`>${title}`);
    try {
      await workbench.locator(".quick-input-list .monaco-list-row", { hasText: title }).first().waitFor({ state: "visible", timeout: 3000 });
      break;
    } catch (error) {
      await workbench.keyboard.press("Escape");
      if (attempt >= 10) throw error;
      await sleep(1000);
    }
  }
  await sleep(300);
  await workbench.keyboard.press("Enter");
}

/** Marca de cada atividade montada no <iframe> da página. */
const MARKER = { tank: "#tkTank", firstOrder: "#foQuestion", sensor: "#snQuestion" };

let failures = 0;
const check = (cond, label, detail = "") => { console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? ` -- ${detail}` : ""}`); if (!cond) failures++; };

(async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-lab-tank-ws-"));
  // As páginas compostas do exemplo viram páginas de atividade (os modelos do produto, `labPages.ts`).
  const lab = require(path.join(extensionPath, "out", "ui", "webview", "lab", "activity.js"));
  const { labActivityPage } = require(path.join(extensionPath, "out", "ui", "webview", "labPages.js"));
  const project = JSON.parse(fs.readFileSync(example, "utf8"));
  const activityFor = { "pagina-tanque-composta": ["tank", "tanque-lab"], "pagina-primeira-ordem-composta": ["firstOrder", "primeira-ordem-lab"], "pagina-sensor-composta": ["sensor", "sensor-lab"] };
  project.visualDocuments[0].pages = project.visualDocuments[0].pages.map((page) => {
    const [kind, plant] = activityFor[page.id] ?? [];
    return kind ? labActivityPage({ ...lab.defaultActivities().find((activity) => activity.kind === kind), plantComponentId: plant }) : page;
  });
  fs.writeFileSync(path.join(workspace, "laboratorio-calculo.lsproj"), JSON.stringify(project, null, 2));
  const port = 9600 + Math.floor(Math.random() * 300);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-lab-tank-user-"));
  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-lab-tank-ext-"));
  fs.mkdirSync(path.join(userData, "User"), { recursive: true });
  fs.writeFileSync(path.join(userData, "User", "settings.json"), JSON.stringify({
    "lasecsimul.network.mode": "isolated", "workbench.startupEditor": "none", "lasecsimul.language": "pt-BR",
    "workbench.secondarySideBar.defaultVisibility": "hidden", "chat.disableAIFeatures": true,
  }));
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
    // Quick Open até o arquivo aparecer na lista (a indexação do workspace novo pode atrasar).
    for (let attempt = 0; attempt < 10; attempt++) {
      await workbench.keyboard.press("Control+P");
      const quick = workbench.locator(".quick-input-widget input").first();
      await quick.waitFor({ state: "visible", timeout: 15000 });
      await quick.fill("laboratorio-calculo.lsproj");
      try {
        await workbench.locator(".quick-input-list .monaco-list-row", { hasText: "laboratorio-calculo.lsproj" }).first().waitFor({ state: "visible", timeout: 3000 });
        break;
      } catch { await workbench.keyboard.press("Escape"); await sleep(1000); }
    }
    await workbench.keyboard.press("Enter");
    const cspViolations = [];
    workbench.on("console", (message) => { if (/Content Security Policy/i.test(message.text())) cspViolations.push(message.text().slice(0, 200)); });
    const findSchematic = async () => {
      for (let attempt = 0; attempt < 240; attempt++) {
        for (const frame of workbench.frames()) {
          if (frame === workbench.mainFrame()) continue;
          if (await frame.locator('.component[data-component-id="tanque-lab"]').count().catch(() => 0)) return frame;
        }
        await sleep(250);
      }
      return undefined;
    };
    let schematic = await findSchematic();
    check(Boolean(schematic), "projeto de exemplo abre com o tanque do laboratório no esquemático");
    check(Boolean(schematic && await schematic.locator('.component[data-component-id="laboratorio-calculo"][data-type-id="tools.hmi_screen"]').count()),
      'o esquemático traz o botão "Laboratório de Cálculo" (Tela HMI)');

    /** Abre a tela pelo botão do esquemático (duplo clique) e devolve a casca (Painel Visual, abas = páginas). */
    const openLabScreen = async () => {
      await schematic.locator('.component[data-component-id="laboratorio-calculo"]').first().dblclick();
      for (let attempt = 0; attempt < 160; attempt++) {
        for (const frame of workbench.frames()) {
          try {
            if (await frame.locator('body.visual-role #labTabs button[data-kind="tank"]').count()) return frame;
            // A sessão da tela volta como foi deixada (aqui, em edição): passa para a operação.
            const operate = frame.locator("body.visual-role .appbar--visual .appbar__button", { hasText: "Operar" });
            if (await operate.count()) await operate.first().click();
          } catch { /* frame em troca */ }
        }
        await sleep(250);
      }
      await workbench.screenshot({ path: path.join(artifacts, "calculus-lab-tank-fail.png") });
      throw new Error("tela do laboratório não abriu");
    };
    let shell = await openLabScreen();
    /** O <iframe> da atividade da página (um novo a cada troca de aba). */
    const activityFrame = async (kind, previous) => {
      for (let attempt = 0; attempt < 120; attempt++) {
        for (const frame of workbench.frames()) {
          if (frame === previous) continue;
          try { if (await frame.locator(`body.lab-embedded ${MARKER[kind]}`).count()) return frame; } catch { /* frame em troca */ }
        }
        await sleep(250);
      }
      throw new Error(`atividade ${kind} não montou`);
    };
    let lab;
    const openTab = async (kind) => {
      const previous = lab;
      await shell.locator(`#labTabs button[data-kind="${kind}"]`).first().click();
      lab = await activityFrame(kind, previous);
    };
    const view = (fn, arg) => lab.evaluate(fn, arg);
    const waitFor = async (fn, arg, timeoutMs, label) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) { if (await view(fn, arg).catch(() => false)) return true; await sleep(200); }
      console.log(`  (tempo esgotado esperando ${label})`);
      return false;
    };

    await openTab("tank");
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

    // inspeção não comanda o Core e só redesenha o que depende dela (docs/53 §2.6 itens 9 e 14)
    const beforeInspect = await view(() => ({ sent: { ...window.__lab.sent }, renders: { ...window.__lab.view.stats.renders } }));
    await view(() => { const g = window.__lab.view.graph; g.batch(() => { g.set("n", 20); g.set("method", "trapezoid"); }); });
    await sleep(500);
    const afterInspect = await view(() => ({ sent: { ...window.__lab.sent }, renders: { ...window.__lab.view.stats.renders } }));
    check(JSON.stringify(afterInspect.sent) === JSON.stringify(beforeInspect.sent), "inspeção (n, método) não envia nada ao Host", JSON.stringify(afterInspect.sent));
    const untouched = ["baseH", "baseQ", "tank", "plant", "status"].filter((id) => afterInspect.renders[id] !== beforeInspect.renders[id]);
    check(untouched.length === 0 && afterInspect.renders.riemannText > (beforeInspect.renders.riemannText ?? 0),
      "inspeção redesenha só Riemann (gráficos-base, tanque, planta e estado intactos)", untouched.length ? `redesenhou: ${untouched.join(", ")}` : `riemannText ${beforeInspect.renders.riemannText} → ${afterInspect.renders.riemannText}`);

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

    // ---------------------------------------------------------------- primeira ordem (Core real)
    await openTab("firstOrder");
    check(await waitFor(() => document.querySelector("#foPlant")?.classList.contains("ok"), null, 30000, "planta de 1ª ordem ligada"),
      "atividade de 1ª ordem liga-se ao bloco do projeto", await lab.locator("#foPlant").innerText().catch(() => ""));
    await lab.locator("#foRun").click();
    check(await waitFor(() => window.__lab.view?.buffer?.now >= 6, null, 40000, "6 s simulados"), "1ª ordem executa e grava y(t)");
    const t63Text = await lab.locator("#foT63").innerText();
    const t63 = Number((/t − t₀ = ([\d,]+) s/.exec(t63Text)?.[1] ?? "NaN").replace(",", "."));
    check(Math.abs(t63 - 5) < 0.05, "y cruza 63,2 % do salto em t − t₀ ≈ τ = 5 s", t63Text);
    const yFinal = await view(() => window.__lab.view.buffer.last("y"));
    check(yFinal > 1.26 && yFinal < 2, "y caminha para K·u = 2", String(yFinal));
    await lab.locator("#foRestart").click();
    check(await waitFor(() => /Configuração/.test(document.getElementById("foStatus").textContent), null, 30000, "reinício 1ª ordem"), "Reiniciar a 1ª ordem");

    // ---------------------------------------------------------------- sensor 4–20 mA (Core real)
    await openTab("sensor");
    check(await waitFor(() => document.querySelector("#snPlant")?.classList.contains("ok"), null, 30000, "sensor ligado"),
      "atividade do sensor liga-se ao subcircuito do projeto", await lab.locator("#snPlant").innerText().catch(() => ""));
    await lab.locator("#snRun").click();
    check(await waitFor(() => /I = 12 mA/.test(document.getElementById("snCurrent")?.textContent ?? ""), null, 30000, "12 mA"),
      "P = 100 kPa na faixa 0–200 kPa lê 12 mA do simulador", await lab.locator("#snReadout").innerText().catch(() => ""));
    await setSlider("sn_p", 250);
    check(await waitFor(() => Boolean(document.getElementById("snSaturated")) && /I = 20,5 mA/.test(document.getElementById("snCurrent").textContent), null, 20000, "saturação"),
      "acima de Pmax a corrente satura em 20,5 mA", await lab.locator("#snReadout").innerText().catch(() => ""));
    check(/sem saturação 24 mA/.test(await lab.locator("#snReadout").innerText()), "mostra o valor sem saturação (24 mA)");
    await lab.locator("#snRestart").click();
    check(await waitFor(() => /Configuração/.test(document.getElementById("snStatus").textContent), null, 30000, "reinício sensor"), "Reiniciar o sensor");

    // ------------------------------------------- gravação por planta (docs/65 §7, M12)
    // A gravação é da planta e o experimento é da atividade, não da vista: trocar de página ou fechar e
    // reabrir a tela no meio da execução não zera o gráfico nem desfaz o que o aluno mudou.
    const tankSnapshot = () => view(() => {
      const v = window.__lab.view, b = v.buffer;
      return { first: b.length > 0 ? b.t[0] : NaN, now: b.now, parameterEvents: b.events.filter((e) => e.kind === "parameter").length, qIn: v.graph.get("params").qIn };
    });
    await openTab("tank");
    check(await waitFor(() => document.querySelector("#tkPlant")?.classList.contains("ok"), null, 30000, "planta ligada"), "tanque ligado de novo");
    await lab.locator("#tkRun").click();
    check(await waitFor(() => window.__lab.view?.buffer?.now >= 2, null, 40000, "2 s simulados"), "tanque grava de novo depois dos Reiniciar");
    await setSlider("tk_qIn", 1.5);
    check(await waitFor(() => window.__lab.view.graph.get("params").qIn === 1.5 && window.__lab.view.buffer.events.some((e) => e.kind === "parameter" && e.value === 1.5), null, 10000, "qIn 1,5"),
      "qIn = 1,5 aceito ao vivo");
    const beforeLeave = await tankSnapshot();
    await openTab("firstOrder");
    await sleep(2500);
    await openTab("tank");
    check(await waitFor((now) => document.querySelector("#tkPlant")?.classList.contains("ok") && window.__lab.view.buffer.now >= now + 2, beforeLeave.now, 30000, "tanque de volta"),
      "voltar à página do tanque religa a vista");
    const afterReturn = await tankSnapshot();
    check(afterReturn.first <= 0.05 && afterReturn.now >= beforeLeave.now + 2, "voltar à página mostra a série inteira desde t = 0 (a gravação não parou)",
      `antes ${JSON.stringify(beforeLeave)} depois ${JSON.stringify(afterReturn)}`);
    check(afterReturn.qIn === 1.5, "voltar à página mantém o parâmetro que o aluno mudou", String(afterReturn.qIn));
    check(afterReturn.parameterEvents === beforeLeave.parameterEvents, "voltar à página não reaplica parâmetros (nenhum evento novo na série)",
      `${beforeLeave.parameterEvents} → ${afterReturn.parameterEvents}`);
    // Fechar a tela pelo X da aba (o teclado dentro do <iframe> da atividade não chega ao workbench) e
    // reabrir pelo botão do esquemático.
    const screenTab = workbench.locator(".tabs-container .tab", { hasText: /Laboratório de Cálculo/ }).first();
    await screenTab.hover();
    await screenTab.locator(".action-label.codicon-close, .codicon-close").first().click();
    await screenTab.waitFor({ state: "detached", timeout: 10000 });
    await sleep(2500);
    shell = await openLabScreen();
    lab = undefined;
    await openTab("tank");
    check(await waitFor((now) => document.querySelector("#tkPlant")?.classList.contains("ok") && window.__lab.view.buffer.now >= now + 2, afterReturn.now, 30000, "tanque reaberto"),
      "reabrir a tela religa a vista do tanque");
    const afterReopen = await tankSnapshot();
    check(afterReopen.first <= 0.05 && afterReopen.qIn === 1.5 && afterReopen.parameterEvents === beforeLeave.parameterEvents,
      "fechar e reabrir a tela mantém a série desde t = 0, o parâmetro e os eventos", JSON.stringify(afterReopen));
    await lab.locator("#tkRestart").click();
    check(await waitFor(() => /Configuração/.test(document.getElementById("tkStatus").textContent) && window.__lab.view.buffer.length === 0, null, 30000, "reinício"),
      "Reiniciar depois da troca de páginas zera as séries");
    await openTab("sensor"); // a seção seguinte começa abrindo a aba do tanque (um <iframe> novo)

    check(cspViolations.length === 0, "nenhuma violação de CSP", cspViolations.join("; "));

    // ---------------------------------------------------------------- gravar e reabrir (item 10)
    const question = "Quanto o volume aumenta em 10 s? (gravada pelo e2e)";
    await openTab("tank");
    // Modo professor = edição da tela; a atividade recebe o ponteiro "por dentro" (duplo clique).
    await shell.locator(".visual-lab-header__button", { hasText: "Editar" }).click();
    lab = await activityFrame("tank");
    const activityElement = shell.locator('.component[data-type-id="graphics.math.activity"]').first();
    await activityElement.waitFor({ timeout: 10000 });
    const box = await activityElement.boundingBox();
    await workbench.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.4);
    await sleep(120);
    await workbench.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.4);
    await shell.locator("iframe.math-embed--editing").waitFor({ timeout: 5000 });
    await lab.locator("#tkQuestionInput").waitFor({ state: "visible", timeout: 10000 });
    await lab.locator("#tkQuestionInput").fill(question);
    await lab.locator("#tkSave").click();
    await lab.locator("#tkSaveStatus").filter({ hasText: "gravada" }).waitFor({ timeout: 10000 });
    // Salvar pelo botão da própria tela (o esquemático recebe o pedido).
    await shell.locator(".appbar--visual .appbar__button--save").first().click();
    const projectFile = path.join(workspace, "laboratorio-calculo.lsproj");
    const savedTankOf = (doc) => {
      const element = doc?.visualDocuments?.[0]?.pages?.flatMap((page) => page.elements).find((el) => el.typeId === "graphics.math.activity" && el.properties?.kind === "tank");
      try { return element ? JSON.parse(element.properties.activityJson) : undefined; } catch { return undefined; }
    };
    let onDisk;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { onDisk = JSON.parse(fs.readFileSync(projectFile, "utf8")); } catch { onDisk = undefined; }
      if (savedTankOf(onDisk)?.question === question) break;
      await sleep(250);
    }
    check(savedTankOf(onDisk)?.question === question && onDisk.visualDocuments[0].pages.length === 7 && !("calculusLab" in onDisk),
      "o .lsproj gravado traz a atividade editada na tela (sem calculusLab)", savedTankOf(onDisk)?.question ?? "(sem a atividade)");

    await command(workbench, "View: Close All Editors");
    await sleep(1500);
    lab = undefined;
    for (let attempt = 0; attempt < 10; attempt++) {
      await workbench.keyboard.press("Control+P");
      const reopen = workbench.locator(".quick-input-widget input").first();
      await reopen.waitFor({ state: "visible", timeout: 15000 });
      await reopen.fill("laboratorio-calculo.lsproj");
      try {
        await workbench.locator(".quick-input-list .monaco-list-row", { hasText: "laboratorio-calculo.lsproj" }).first().waitFor({ state: "visible", timeout: 3000 });
        break;
      } catch { await workbench.keyboard.press("Escape"); await sleep(1000); }
    }
    await workbench.keyboard.press("Enter");
    schematic = await findSchematic();
    if (!schematic) throw new Error("projeto não reabriu");
    shell = await openLabScreen();
    await openTab("tank");
    check(await waitFor((q) => document.getElementById("tkQuestion")?.textContent === q, question, 15000, "pergunta reaberta"),
      "reabrir o projeto devolve a atividade gravada", await lab.locator("#tkQuestion").innerText().catch(() => ""));
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
