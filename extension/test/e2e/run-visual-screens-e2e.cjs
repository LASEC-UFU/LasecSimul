// E2E (VS Code real): Tela HMI em Painel Visual -- inserir pela paleta (Controle › Ferramentas), editar
// acoplada, colocar elementos de Miscelâneos na tela, desfazer/refazer no Host, desacoplar para uma janela
// auxiliar, tela cheia real (inclusive no 2º monitor, quando houver), operar, telemetria ao vivo, acoplar de
// volta, salvar e reabrir (docs/61, docs/62, docs/63 §4.2).
// Uso: npm run test:visual:e2e  (Core compilado). VSCODE_E2E_VERSION escolhe a build (padrão 1.128.0);
// VSCODE_EXECUTABLE_PATH usa um Code.exe instalado.
// ATENÇÃO: abre uma janela do VS Code na sessão do usuário e coloca uma janela em tela cheia por alguns
// segundos (avise quem estiver usando a máquina). Não usa a área de transferência.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const extensionPath = path.resolve(__dirname, "../..");
const artifacts = path.join(extensionPath, "test", "e2e", "artifacts", "visual-screens");
const req = (name) => require(path.join(extensionPath, "node_modules", name));
const { chromium } = req("@playwright/test");
const { downloadAndUnzipVSCode } = req("@vscode/test-electron");
fs.mkdirSync(artifacts, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (cond, label, detail = "") => { console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? ` -- ${detail}` : ""}`); if (!cond) failures++; return cond; };
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));

function monitors() {
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { '{0},{1},{2},{3},{4}' -f $_.Bounds.X,$_.Bounds.Y,$_.Bounds.Width,$_.Bounds.Height,$_.Primary }"], { encoding: "utf8" });
    return out.trim().split(/\r?\n/).filter(Boolean).map((line) => { const [x, y, w, h, primary] = line.split(","); return { x: +x, y: +y, w: +w, h: +h, primary: primary === "True" }; });
  } catch { return []; }
}

function winctl(pid, titleLike, action, rect = []) {
  try {
    return execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "winctl.ps1"),
      "-ProcessId", String(pid), "-TitleLike", titleLike, "-NotTitleLike", "", "-Action", action, ...rect], { encoding: "utf8" }).trim();
  } catch (error) { return `error: ${String(error.message).slice(0, 200)}`; }
}

async function launch(workspace) {
  const port = 9600 + Math.floor(Math.random() * 300);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-visual-user-"));
  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-visual-ext-"));
  fs.mkdirSync(path.join(userData, "User"), { recursive: true });
  fs.writeFileSync(path.join(userData, "User", "settings.json"), JSON.stringify({
    "lasecsimul.network.mode": "isolated", "workbench.startupEditor": "none", "lasecsimul.language": "pt-BR",
    "window.customTitleBarVisibility": "windowed",
    // A barra lateral secundária (Chat) roubaria largura da tela acoplada e cliques do teste.
    "workbench.secondarySideBar.defaultVisibility": "hidden", "chat.disableAIFeatures": true,
  }));
  const executable = process.env.VSCODE_EXECUTABLE_PATH
    ?? await downloadAndUnzipVSCode({ version: process.env.VSCODE_E2E_VERSION || "1.128.0", cachePath: path.resolve(extensionPath, ".vscode-test"), timeout: 120000 });
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, `--extensions-dir=${extensionsDir}`,
    `--extensionDevelopmentPath=${extensionPath}`, "--disable-workspace-trust", "--disable-updates", "--skip-welcome",
    "--force-device-scale-factor=1", "--disable-gpu", "--disable-shared-process", "--new-window", workspace,
  ], { env: childEnv, stdio: ["ignore", fs.openSync(path.join(artifacts, "vscode.stdout.log"), "w"), fs.openSync(path.join(artifacts, "vscode.stderr.log"), "w")] });
  let browser;
  for (let attempt = 0; attempt < 120 && !browser; attempt++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await sleep(250); }
  }
  let workbench;
  for (let attempt = 0; attempt < 160 && !workbench; attempt++) {
    workbench = browser.contexts().flatMap((context) => context.pages()).find((page) => page.url().includes("workbench"));
    if (!workbench) await sleep(250);
  }
  await workbench.locator(".monaco-workbench").waitFor({ state: "visible", timeout: 60000 });
  await workbench.setViewportSize({ width: 1500, height: 950 });
  await sleep(6000);
  return { browser, workbench, child, userData };
}

const allPages = (browser) => browser.contexts().flatMap((context) => context.pages());

async function findFrameIn(pages, selector, tries = 120) {
  for (let attempt = 0; attempt < tries; attempt++) {
    for (const page of pages()) {
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        try { if (await frame.locator(selector).count()) return { frame, page }; } catch { /* troca */ }
      }
    }
    await sleep(250);
  }
  return undefined;
}

async function command(workbench, title) {
  await workbench.locator(".part.statusbar").first().click({ position: { x: 5, y: 5 } }).catch(() => undefined);
  await workbench.keyboard.press("Control+Shift+P");
  const input = workbench.locator(".quick-input-widget input").first();
  await input.waitFor({ state: "visible" });
  await input.fill(`>${title}`);
  await workbench.locator(".quick-input-list .monaco-list-row", { hasText: title }).first().waitFor({ state: "visible", timeout: 30000 });
  await sleep(300);
  await workbench.keyboard.press("Enter");
}

async function openFile(workbench, name) {
  await workbench.locator(".part.statusbar").first().click({ position: { x: 5, y: 5 } }).catch(() => undefined);
  await workbench.keyboard.press("Control+P");
  const quick = workbench.locator(".quick-input-widget input").first();
  await quick.waitFor({ state: "visible", timeout: 15000 });
  await quick.fill(name);
  await sleep(1500);
  await workbench.keyboard.press("Enter");
}

async function paletteFrame(workbench) {
  const activity = workbench.locator('.activitybar [aria-label*="LasecSimul"], .activitybar [title*="LasecSimul"]').first();
  await activity.waitFor({ state: "visible", timeout: 30000 });
  if ((await activity.getAttribute("aria-expanded").catch(() => null)) !== "true") await activity.click();
  return (await findFrameIn(() => [workbench], ".palette__search-input", 80))?.frame;
}

/** Arma a colocação pela paleta lateral: aba certa, busca, item. */
async function paletteArm(palette, tabLabel, query, typeId) {
  const tab = palette.locator(`.palette-tabs__button[aria-label="${tabLabel}"]`).first();
  await tab.click();
  await sleep(200);
  const input = palette.locator(".palette__search-input").first();
  await input.fill(query);
  await sleep(400);
  const item = palette.locator(`.palette-item[data-type-id="${typeId}"]`).first();
  try {
    await item.waitFor({ state: "visible", timeout: 10000 });
  } catch (error) {
    const dump = await palette.evaluate(() => ({
      tabs: Array.from(document.querySelectorAll(".palette button")).slice(0, 8).map((b) => `${b.textContent?.trim()}${b.getAttribute("aria-pressed") === "true" || b.classList.contains("is-active") ? "*" : ""}`),
      items: Array.from(document.querySelectorAll(".palette-item")).slice(0, 15).map((el) => `${el.getAttribute("data-type-id")}`),
      empty: document.querySelector(".palette__empty")?.textContent,
    })).catch(() => undefined);
    throw new Error(`item ${typeId} ausente na paleta: ${JSON.stringify(dump)} (${error.message.split("\n")[0]})`);
  }
  await item.click();
  await sleep(500);
  await input.fill("");
}

async function componentsIn(frame) {
  return frame.evaluate(() => Array.from(document.querySelectorAll(".component[data-component-id]")).map((el) => ({ id: el.getAttribute("data-component-id"), typeId: el.getAttribute("data-type-id") })));
}

async function waitFor(fn, predicate, tries = 60, delay = 250) {
  let value;
  for (let attempt = 0; attempt < tries; attempt++) {
    try { value = await fn(); if (predicate(value)) return value; } catch { /* troca de frame */ }
    await sleep(delay);
  }
  return value;
}

const EMPTY_SPOT = { x: 40, y: 300 };

async function contextMenuOn(frame, locator, label, position = EMPTY_SPOT) {
  await locator.click({ button: "right", position });
  const item = frame.locator(".context-menu__item", { has: frame.locator(".context-menu__label", { hasText: label }) }).first();
  await item.waitFor({ state: "visible", timeout: 8000 });
  return item;
}

async function menuLabels(frame, locator, position = EMPTY_SPOT) {
  await locator.click({ button: "right", position });
  await sleep(300);
  const labels = await frame.locator(".context-menu__label").allInnerTexts().catch(() => []);
  await frame.locator("body").press("Escape").catch(() => undefined);
  await sleep(200);
  return labels;
}

function writeFixture(workspace) {
  const display = { width: 220, height: 92, stroke: "currentColor", fill: "#f8fafc", strokeWidth: 1.5, opacity: 1, label: "K1", valueColor: "#0f172a", value: 0,
    bindSource: "k1", bindChannel: 0, bindScale: 1, bindOffset: 0, bindMin: 0, bindMax: 100, bindUnit: "", bindDecimals: 1 };
  const project = {
    schemaVersion: 2,
    components: [
      { id: "k1", typeId: "control.constant", properties: { value: 42, unit: "" }, label: "K1", visual: { x: 80, y: 240, rotation: 0 } },
      { id: "botao-painel", typeId: "tools.hmi_screen", properties: { title: "Painel", screenId: "painel", width: 176, height: 64 }, label: "Painel", visual: { x: 80, y: 40, rotation: 0 } },
    ],
    topology: { revision: 0, nodes: [], conductors: [] },
    visual: { viewport: { x: 0, y: 0, zoom: 1 }, wireRoutes: "explicit" },
    simulationSettings: {},
    visualDocuments: [{
      schemaVersion: 1, id: "painel", kind: "screen", title: "Painel", presentation: { fullscreenContext: "lab" }, startPageId: "p1",
      pages: [{ id: "p1", name: "Visão geral", width: 1920, height: 1080, navigation: [],
        elements: [{ id: "e-k1", typeId: "graphics.value_display", properties: display, visual: { x: 200, y: 200, width: 220, height: 92 } }] }],
    }],
  };
  fs.writeFileSync(path.join(workspace, "tela.lsproj"), `${JSON.stringify(project, null, 2)}\n`);
}

(async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-visual-ws-"));
  writeFixture(workspace);
  const projectFile = path.join(workspace, "tela.lsproj");
  const { browser, workbench, child, userData } = await launch(workspace);
  const consoleErrors = [];
  workbench.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text().slice(0, 300)); });
  workbench.on("pageerror", (error) => consoleErrors.push(`pageerror: ${String(error).slice(0, 300)}`));
  try {
    await openFile(workbench, "tela.lsproj");
    const schematic = (await findFrameIn(() => [workbench], ".component[data-type-id=\"tools.hmi_screen\"]", 160))?.frame;
    if (!check(Boolean(schematic), "projeto abre com o botão Tela HMI no esquemático")) throw new Error("esquemático não abriu");

    // 1) Inserir uma Tela HMI pela paleta: Controle › Ferramentas.
    const palette = await paletteFrame(workbench);
    check(Boolean(palette), "paleta lateral disponível");
    const toolsFolder = await palette.evaluate(() => Array.from(document.querySelectorAll(".palette-item[data-type-id=\"tools.hmi_screen\"]")).length);
    await paletteArm(palette, "Controle", "Tela HMI", "tools.hmi_screen");
    const canvas = schematic.locator(".canvas").first();
    await canvas.click({ position: { x: 340, y: 190 } });
    const afterInsert = await waitFor(() => componentsIn(schematic), (comps) => comps.filter((c) => c.typeId === "tools.hmi_screen").length === 2);
    check(afterInsert.filter((c) => c.typeId === "tools.hmi_screen").length === 2, "botão inserido pela paleta (Controle › Ferramentas)", `itens visíveis na paleta antes da busca: ${toolsFolder}`);

    // 2) Abrir o painel existente com duplo clique: Painel Visual acoplado, em edição.
    await schematic.locator('.component[data-component-id="botao-painel"]').first().dblclick();
    let visual = await findFrameIn(() => allPages(browser), "body.visual-role .canvas", 120);
    if (!check(Boolean(visual), "duplo clique abre a Tela HMI num Painel Visual")) throw new Error("painel visual não abriu");
    let vframe = visual.frame;
    check(visual.page === workbench, "painel abre acoplado (janela principal)");
    const initial = await waitFor(() => componentsIn(vframe), (comps) => comps.some((c) => c.id === "e-k1"));
    check(initial.some((c) => c.id === "e-k1"), "elemento do documento aparece na tela");
    const editBar = await vframe.locator(".appbar--visual").innerText();
    check(/Operar/.test(editBar), "barra de edição da tela", editBar.replace(/\s+/g, " ").slice(0, 120));

    const stateFromHtml = await vframe.evaluate(() => ({ ...document.body.dataset }));
    check(stateFromHtml.visualDocking === "docked" && stateFromHtml.visualCanUndock === "true", "estado da janela já na 1ª pintura", JSON.stringify(stateFromHtml));
    // 3) Menu de contexto em edição: itens de janela e de modo.
    const background = vframe.locator(".canvas").first();
    const editMenu = await menuLabels(vframe, background);
    check(editMenu.includes("Sair do modo de edição") && editMenu.includes("Desacoplar janela") && editMenu.includes("Tela cheia"), "menu de contexto em edição tem modo e janela", editMenu.join(" | "));
    check(!editMenu.includes("Acoplar ao VS Code"), "menu não oferece ação indisponível (Acoplar estando acoplada)");

    // 4) Elemento de Miscelâneos colocado DIRETO na tela pela paleta lateral (roteada para a tela ativa em edição).
    await background.click({ position: { x: 40, y: 300 } });
    await sleep(300);
    await paletteArm(palette, "Miscelâneos", "Rótulo de tela", "graphics.label");
    const box = await background.boundingBox();
    await background.click({ position: { x: Math.round(box.width * 0.45), y: Math.round(box.height * 0.6) } });
    const withLabel = await waitFor(() => componentsIn(vframe), (comps) => comps.filter((c) => c.typeId === "graphics.label").length === 1);
    check(withLabel.filter((c) => c.typeId === "graphics.label").length === 1, "paleta lateral coloca o elemento na Tela HMI, não no esquemático");
    const schematicLabels = (await componentsIn(schematic)).filter((c) => c.typeId === "graphics.label").length;
    check(schematicLabels === 0, "esquemático continua sem o elemento");

    // 5) Desfazer/refazer no Host.
    await background.click({ position: { x: 40, y: 300 } });
    await workbench.keyboard.press("Control+Z");
    const undone = await waitFor(() => componentsIn(vframe), (comps) => !comps.some((c) => c.typeId === "graphics.label"));
    check(!undone.some((c) => c.typeId === "graphics.label"), "Ctrl+Z desfaz a colocação (histórico no Host)");
    await workbench.keyboard.press("Control+Y");
    const redone = await waitFor(() => componentsIn(vframe), (comps) => comps.some((c) => c.typeId === "graphics.label"));
    check(redone.some((c) => c.typeId === "graphics.label"), "Ctrl+Y refaz");

    // 6) Desacoplar: janela auxiliar, mesma tela, mesmo histórico.
    const pagesBefore = allPages(browser).length;
    await (await contextMenuOn(vframe, background, "Desacoplar janela")).click();
    visual = await waitFor(() => findFrameIn(() => allPages(browser).filter((page) => page !== workbench), "body.visual-role .canvas", 4), (found) => Boolean(found), 80);
    check(Boolean(visual) && allPages(browser).length > pagesBefore, "Desacoplar abre a tela numa janela auxiliar");
    vframe = visual.frame;
    const floating = await waitFor(() => componentsIn(vframe), (comps) => comps.some((c) => c.typeId === "graphics.label") && comps.some((c) => c.id === "e-k1"));
    check(floating.some((c) => c.typeId === "graphics.label") && floating.some((c) => c.id === "e-k1"), "documento intacto depois de desacoplar");
    const floatBar = await waitFor(() => vframe.locator(".appbar--visual").innerText(), (text) => /Acoplar/.test(text));
    check(/Acoplar/.test(floatBar), "barra mostra Acoplar quando flutuante");
    await vframe.locator(".canvas").first().click({ position: { x: 40, y: 300 } });
    await visual.page.keyboard.press("Control+Z");
    const undoFloating = await waitFor(() => componentsIn(vframe), (comps) => !comps.some((c) => c.typeId === "graphics.label"));
    if (!check(!undoFloating.some((c) => c.typeId === "graphics.label"), "desfazer atravessa o Undock (histórico do Host)")) {
      console.log("  foco:", JSON.stringify(await vframe.evaluate(() => ({ focus: document.hasFocus(), active: document.activeElement?.className, data: { ...document.body.dataset } }))));
    }
    await visual.page.keyboard.press("Control+Y");
    await waitFor(() => componentsIn(vframe), (comps) => comps.some((c) => c.typeId === "graphics.label"));

    // 7) Tela cheia real (botão do canto) e contexto Laboratório; Esc sai.
    await vframe.locator(".visual-corner-button--enter").click();
    const fullscreen = await waitFor(() => vframe.evaluate(() => ({ cls: document.body.className, iw: innerWidth, ih: innerHeight, sw: screen.width, sh: screen.height })),
      (g) => g.cls.includes("visual-fullscreen"), 60);
    check(fullscreen?.cls.includes("visual-fullscreen") && fullscreen.iw === fullscreen.sw, "tela cheia ocupa a largura do monitor", JSON.stringify(fullscreen));
    check(fullscreen?.ih >= fullscreen?.sh - 32, "tela cheia ocupa a altura do monitor (≤ 32 px de faixa)", JSON.stringify(fullscreen));
    check(fullscreen?.cls.includes("visual-context-lab"), "tela cheia adota o contexto Laboratório (política padrão)");
    await visual.page.screenshot({ path: path.join(artifacts, "fullscreen-primary.png") }).catch(() => undefined);
    await vframe.locator(".canvas").first().click({ position: { x: 60, y: 300 } });
    await visual.page.keyboard.press("Escape");
    const leftFull = await waitFor(() => vframe.evaluate(() => document.body.className), (cls) => !cls.includes("visual-fullscreen"), 60);
    check(!leftFull.includes("visual-fullscreen") && !leftFull.includes("visual-context-lab"), "Esc sai da tela cheia e volta ao contexto HMI");

    // 8) 2º monitor (se existir): leva a janela até ele e entra em tela cheia lá.
    const screens = monitors();
    const secondary = screens.find((m) => !m.primary);
    if (secondary) {
      const moved = winctl(child.pid, "*Painel*", "move", ["-X", String(secondary.x + 60), "-Y", String(secondary.y + 60), "-W", "900", "-H", "600"]);
      await sleep(1500);
      await vframe.locator(".visual-corner-button--enter").click();
      const second = await waitFor(() => vframe.evaluate(() => ({ cls: document.body.className, iw: innerWidth, sw: screen.width, left: screen.availLeft })), (g) => g.cls.includes("visual-fullscreen"), 60);
      check(second?.cls.includes("visual-fullscreen") && second.left === secondary.x && second.iw === secondary.w, "tela cheia no monitor secundário", `${moved} ${JSON.stringify(second)}`);
      await visual.page.screenshot({ path: path.join(artifacts, "fullscreen-secondary.png") }).catch(() => undefined);
      await vframe.locator(".visual-corner-button--exit").click();
      await waitFor(() => vframe.evaluate(() => document.body.className), (cls) => !cls.includes("visual-fullscreen"), 60);
      const back = await vframe.evaluate(() => screen.availLeft);
      // Uma sessão RDP desconectada troca os monitores por um único "WinDisc": aí não há para onde voltar.
      if (monitors().some((m) => !m.primary && m.x === secondary.x)) check(back === secondary.x, "ao sair, continua no monitor secundário", String(back));
      else console.log(`skip ao sair, continua no monitor secundário: o monitor sumiu durante o teste (${JSON.stringify(monitors())})`);
    } else {
      console.log("skip tela cheia no monitor secundário: só um monitor");
    }

    // 9) Maximizar/restaurar (SO) e operar.
    const max = winctl(child.pid, "*Painel*", "maximize");
    const maximized = await waitFor(() => vframe.locator(".appbar--visual").count(), () => true, 4);
    check(/zoomed=True/.test(max), "janela da tela maximiza pelo SO", max);
    winctl(child.pid, "*Painel*", "restore");
    await sleep(800);
    await (await contextMenuOn(vframe, vframe.locator(".canvas").first(), "Sair do modo de edição")).click();
    const operating = await waitFor(() => vframe.evaluate(() => document.body.className), (cls) => cls.includes("visual-operate"));
    check(operating.includes("visual-operate"), "modo de operação");
    const operateMenu = await menuLabels(vframe, vframe.locator(".canvas").first());
    check(operateMenu.includes("Entrar em modo de edição") && operateMenu.includes("Acoplar ao VS Code"), "menu em operação: entrar em edição e acoplar", operateMenu.join(" | "));

    // 10) Telemetria ao vivo na tela flutuante (com a simulação rodando).
    await vframe.locator('.appbar--visual button[aria-label="Executar simulação"], .appbar--visual .appbar__button--start').first().click().catch(() => undefined);
    const live = await waitFor(() => vframe.locator('.component[data-component-id="e-k1"]').innerText().catch(() => ""), (text) => /42/.test(text), 80);
    check(/42/.test(live), "valor da simulação chega à tela flutuante", live.replace(/\s+/g, " "));
    await vframe.locator(".appbar--visual .appbar__button--stop").first().click().catch(() => undefined);

    // 11) Acoplar de volta.
    await (await contextMenuOn(vframe, vframe.locator(".canvas").first(), "Acoplar ao VS Code")).click();
    const docked = await waitFor(() => findFrameIn(() => [workbench], "body.visual-role .canvas", 4), (found) => Boolean(found), 80);
    check(Boolean(docked), "Acoplar devolve a tela à janela principal");
    check(allPages(browser).filter((page) => page !== workbench).length === 0, "janela auxiliar fecha ao acoplar");
    vframe = docked.frame;
    const dockedComps = await waitFor(() => componentsIn(vframe), (comps) => comps.some((c) => c.typeId === "graphics.label"));
    check(dockedComps.some((c) => c.typeId === "graphics.label"), "documento intacto depois de acoplar");

    // 12) Salvar e conferir o arquivo.
    // Pelo botão Salvar da própria tela (mensagem delegada ao esquemático).
    await vframe.locator(".appbar--visual .appbar__button--save").first().click();
    const saved = await waitFor(() => readJson(projectFile), (doc) => Array.isArray(doc.visualDocuments) && doc.visualDocuments.length === 2, 40, 500);
    check(saved?.visualDocuments?.length === 2, "duas telas gravadas no .lsproj", String(saved?.visualDocuments?.length));
    const painel = saved?.visualDocuments?.find((doc) => doc.id === "painel");
    check(painel?.pages[0].elements.some((el) => el.typeId === "graphics.label"), "elemento colocado na tela foi gravado");
    check(!("hmiApplication" in (saved ?? {})), "formato antigo (hmiApplication) não é gravado");
    const displayWidth = painel?.pages[0].elements.find((el) => el.id === "e-k1")?.visual.width;
    check(displayWidth === 220, "tamanho do elemento estável depois de várias recriações da Webview", String(displayWidth));
  } catch (error) {
    check(false, "execução sem exceção", String(error && error.stack || error));
    console.log("erros de console:", consoleErrors.slice(-15).join(" || "));
    console.log("userData:", userData);
    await workbench.screenshot({ path: path.join(artifacts, "failure.png") }).catch(() => undefined);
  } finally {
    if (failures > 0) console.log("userData:", userData);
    await browser.close().catch(() => undefined);
    try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* já saiu */ }
  }
  console.log(failures === 0 ? "\nTela HMI E2E: tudo ok" : `\nTela HMI E2E: ${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
})();
