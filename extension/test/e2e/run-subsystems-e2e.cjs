// E2E (VS Code real): subsistemas internos x sistemas externos (docs/59-subsistemas-internos-e-sistemas-externos.md).
// Sessão 1: criar 3 subsistemas pela UI (um deles com subsistema aninhado), navegar (caminho/voltar um
// nível), desfazer/refazer, inserir outra instância, renomear, duplicar, exportar, copiar/colar entre
// projetos (regras A/B/C/D), incorporar sistema externo, excluir definição em uso.
// Sessão 2: reabrir; usar o exportado em outro projeto; projeto copiado para outra pasta sem os arquivos
// de origem.
// Uso: npm run test:subsystems:e2e (precisa do Core compilado e atualizado). Altera temporariamente
// project/schema/component-catalog.json ("Adicionar à paleta") e o restaura no fim.
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const extensionPath = path.resolve(__dirname, "../..");
const artifacts = path.join(extensionPath, "test", "e2e", "artifacts", "subsystems");
const req = (name) => require(path.join(extensionPath, "node_modules", name));
const { chromium } = req("@playwright/test");
const { downloadAndUnzipVSCode } = req("@vscode/test-electron");
fs.mkdirSync(artifacts, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (cond, label, detail = "") => { console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? ` -- ${detail}` : ""}`); if (!cond) failures++; return cond; };
const catalogFile = path.resolve(extensionPath, "../project/schema/component-catalog.json");
const catalogBackup = fs.readFileSync(catalogFile);
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
const MS = 1_000_000;

async function launch(workspace, tag) {
  const port = 9400 + Math.floor(Math.random() * 400);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-subsys-user-"));
  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-subsys-ext-"));
  fs.mkdirSync(path.join(userData, "User"), { recursive: true });
  fs.writeFileSync(path.join(userData, "User", "settings.json"), JSON.stringify({
    "lasecsimul.network.mode": "isolated", "workbench.startupEditor": "none", "files.simpleDialog.enable": true,
    "window.dialogStyle": "custom", "lasecsimul.language": "pt-BR",
  }));
  const executable = await downloadAndUnzipVSCode({ version: "1.128.0", cachePath: path.resolve(extensionPath, ".vscode-test"), timeout: 120000 });
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, `--extensions-dir=${extensionsDir}`,
    `--extensionDevelopmentPath=${extensionPath}`, "--disable-workspace-trust", "--disable-updates", "--skip-welcome",
    "--force-device-scale-factor=1", "--disable-gpu", "--disable-shared-process", "--new-window", workspace,
  ], { env: childEnv, stdio: ["ignore", fs.openSync(path.join(artifacts, `${tag}.stdout.log`), "w"), fs.openSync(path.join(artifacts, `${tag}.stderr.log`), "w")] });
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
  await workbench.setViewportSize({ width: 1700, height: 1100 });
  currentWorkbench = workbench;
  await sleep(6000);
  try {
    assertActivated(userData);
  } catch (error) {
    await browser.close().catch(() => undefined);
    child.kill();
    throw error;
  }
  return { browser, workbench, child, userData };
}

/** Extensão que não ativou (ex.: Core desatualizado) invalida o teste inteiro: falha já, com o motivo. */
function assertActivated(userData) {
  const logs = path.join(userData, "logs");
  const exthostLogs = [];
  const walk = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else if (entry.name === "exthost.log") exthostLogs.push(full); } };
  if (fs.existsSync(logs)) walk(logs);
  const failure = exthostLogs.map((file) => fs.readFileSync(file, "utf8")).join("\n").match(/Activating extension josuemoraisgh\.lasecsimul failed[^\n]*\n[^\n]*/);
  if (failure) throw new Error(`a extensão não ativou: ${failure[0]}`);
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

async function findFrame(workbench, selector, tries = 240) {
  for (let attempt = 0; attempt < tries; attempt++) {
    for (const frame of workbench.frames()) {
      if (frame === workbench.mainFrame()) continue;
      try { if (await frame.locator(selector).count()) return frame; } catch { /* troca */ }
    }
    await sleep(250);
  }
  return undefined;
}

/** O iframe do esquemático pode ser recriado (ex.: ao voltar de um nível): reencontra se desanexou. */
let currentWorkbench;
async function liveFrame(frame) {
  if (frame && !frame.isDetached()) return frame;
  return (await findFrame(currentWorkbench, ".canvas", 80)) ?? frame;
}

async function componentsIn(frame) {
  frame = await liveFrame(frame);
  return frame.evaluate(() => Array.from(document.querySelectorAll(".component[data-component-id]")).map((el) => ({
    id: el.getAttribute("data-component-id"), typeId: el.getAttribute("data-type-id"),
    missing: el.classList.contains("component--subcircuit-missing") || el.classList.contains("component--unknown"),
  })));
}
const ofType = (comps, typeId) => comps.filter((c) => c.typeId === typeId);

/** Espera até `predicate(componentes)` valer (a Webview re-renderiza depois da mensagem do host). */
async function waitComponents(frame, predicate, tries = 60) {
  let comps = [];
  for (let attempt = 0; attempt < tries; attempt++) {
    comps = await componentsIn(frame).catch(() => []);
    if (predicate(comps)) return comps;
    await sleep(250);
  }
  return comps;
}

/** Caminho exibido na barra ("" no nível do projeto); `null` se não deu para ler (nunca conta como ""). */
async function breadcrumb(frame) {
  frame = await liveFrame(frame);
  return frame.evaluate(() => document.querySelector(".appbar") ? (document.querySelector(".appbar__subcircuit-label")?.textContent ?? "") : null);
}
async function waitBreadcrumb(frame, predicate, tries = 60) {
  let text = "";
  for (let attempt = 0; attempt < tries; attempt++) {
    const read = await breadcrumb(frame).catch(() => null);
    if (read === null) { await sleep(250); continue; }
    text = read;
    if (predicate(text)) return text;
    await sleep(250);
  }
  return text;
}

/** Clique no canto vazio do canvas (nunca na barra de ferramentas: o 1º ícone é "Abrir projeto"). */
async function clickEmpty(frame) {
  frame = await liveFrame(frame);
  const canvas = frame.locator(".canvas").first();
  const box = await canvas.boundingBox().catch(() => undefined);
  if (box) await canvas.click({ position: { x: 30, y: Math.max(30, box.height - 30) } }).catch(() => undefined);
}

async function select(frame, ids) {
  frame = await liveFrame(frame);
  await clickEmpty(frame);
  for (const [index, id] of ids.entries()) {
    await frame.locator(`.component[data-component-id="${id}"]`).first().click(index === 0 ? {} : { modifiers: ["Shift"] });
    await sleep(200);
  }
  await sleep(300);
}

async function contextMenu(frame, componentId, label) {
  frame = await liveFrame(frame);
  // Ações de UMA instância: seleciona só ela (com seleção múltipla o menu é o de grupo). Criar
  // subsistema usa a seleção feita antes.
  if (label !== "Criar Subsistema Interno") { await clickEmpty(frame); await frame.locator(`.component[data-component-id="${componentId}"]`).first().click(); await sleep(300); }
  await frame.locator(`.component[data-component-id="${componentId}"]`).first().click({ button: "right" });
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const item = frame.locator(".context-menu__item", { has: frame.locator(".context-menu__label", { hasText: new RegExp(`^${escaped}$`) }) }).first();
  await item.waitFor({ state: "visible", timeout: 10000 });
  await item.click();
}

async function inputBox(workbench, value) {
  const input = workbench.locator(".quick-input-widget input").first();
  await input.waitFor({ state: "visible", timeout: 20000 });
  await sleep(500);
  await input.fill(value);
  await sleep(300);
  await workbench.keyboard.press("Enter");
  await sleep(800);
  if (await input.isVisible().catch(() => false)) { await workbench.keyboard.press("Enter"); await sleep(800); }
}

async function quickPickExact(workbench, label) {
  const row = workbench.locator(".quick-input-list .monaco-list-row").filter({ has: workbench.locator(".label-name", { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) }).first();
  await row.waitFor({ state: "visible", timeout: 20000 });
  await row.click();
  await sleep(600);
}

async function modalButton(workbench, label, timeout = 20000) {
  const button = workbench.locator(".monaco-dialog-box .monaco-button", { hasText: label }).first();
  await button.waitFor({ state: "visible", timeout });
  await button.click();
  await sleep(800);
}

async function keys(frame, workbench, combo) {
  // Copiar precisa da seleção: o foco já está na Webview (último clique foi num componente).
  if (combo !== "Control+C") await clickEmpty(frame);
  await sleep(200);
  await workbench.keyboard.press(combo);
  await sleep(1200);
}

async function notifications(workbench) {
  return workbench.locator(".notifications-toasts .notification-list-item-message").allInnerTexts().catch(() => []);
}
async function clearNotifications(workbench) {
  await command(workbench, "Notifications: Clear All Notifications").catch(() => undefined);
  await sleep(500);
}
const ERROR_TEXT = /falha|falhou|não encontrad|Unknown|recusou|erro|inválid/i;

async function saveProject(workbench, file, predicate) {
  const before = fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
  await command(workbench, "LasecSimul: Save Project");
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if (fs.statSync(file).mtimeMs !== before) {
        const doc = readJson(file);
        if (!predicate || predicate(doc)) return doc;
      }
    } catch { /* gravando */ }
    await sleep(500);
  }
  try { return readJson(file); } catch { return undefined; }
}

async function paletteHas(workbench, typeId) {
  const activity = workbench.locator('.activitybar [aria-label*="LasecSimul"], .activitybar [title*="LasecSimul"]').first();
  await activity.waitFor({ state: "visible", timeout: 30000 });
  if ((await activity.getAttribute("aria-expanded").catch(() => null)) !== "true") await activity.click();
  for (let attempt = 0; attempt < 40; attempt++) {
    for (const frame of workbench.frames()) {
      if (frame === workbench.mainFrame()) continue;
      try { if (await frame.locator(`.palette-item[title^="${typeId}\\a "]`).count()) return true; } catch { /* troca */ }
    }
    await sleep(250);
  }
  return false;
}

// ---------- fixtures ----------------------------------------------------------------------------
const tunnel = (id, pinId, direction, x) => ({ id, typeId: "connectors.signal_tunnel", properties: { name: pinId, pinId, direction, valueType: "Real", ...(direction === "Input" ? { defaultValue: 0 } : {}) }, visual: { x, y: 80, rotation: direction === "Input" ? 0 : 180 } });
const conductor = (id, a, ap, b, bp) => ({ id, from: { kind: "port", componentId: a, pinId: ap }, to: { kind: "port", componentId: b, pinId: bp }, vertices: [] });
const signalInterface = [
  { pinId: "in", label: "IN", internalTunnel: "in", domain: "signal", direction: "in", valueType: "Real", width: 1 },
  { pinId: "out", label: "OUT", internalTunnel: "out", domain: "signal", direction: "out", valueType: "Real", width: 1 },
];
const genericSymbol = (name) => ({ width: 180, height: 88, border: true, shapes: [{ kind: "text", x: 90, y: 18, value: name, fontSize: 10, textAnchor: "middle", color: "#111827" }], pins: [
  { id: "in", kind: "ANALOG_IN", x: 0, y: 28, angle: 180, length: 8, label: "IN" }, { id: "out", kind: "ANALOG_OUT", x: 180, y: 42, angle: 0, length: 8, label: "OUT" },
] });
function signalBlock(typeId, name, inner) {
  return {
    schemaVersion: 3, typeId, name, language: "pt-BR",
    components: [tunnel("in-tunnel", "in", "Input", 40), ...inner, tunnel("out-tunnel", "out", "Output", 360)],
    topology: { revision: 0, nodes: [], conductors: [conductor("w-in", "in-tunnel", "value", inner[0].id, "in"), conductor("w-out", inner[inner.length - 1].id, "out", "out-tunnel", "value")] },
    interface: signalInterface, symbolMode: "generic", symbol: genericSymbol(name), exposedComponents: [], exportedPropertyComponentIds: [],
  };
}
const comp = (id, typeId, properties, x, y, extra = {}) => ({ id, typeId, properties, visual: { x, y, rotation: 0 }, ...extra });

function writeFixtures(workspace) {
  fs.mkdirSync(path.join(workspace, "lib"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "A"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "B"), { recursive: true });
  // Sistema EXTERNO com um subsistema INTERNO próprio (Filtro, ganho 7).
  const medidor = {
    ...signalBlock("subcircuits.medidor_e2e", "Medidor", [comp("f1", "subsystem.filtro", {}, 200, 80)]),
    subsystems: [signalBlock("subsystem.filtro", "Filtro", [comp("k", "control.gain", { gain: 7, samplePeriodNs: 10 * MS }, 200, 80)])],
  };
  fs.writeFileSync(path.join(workspace, "lib", "medidor.lssubcircuit"), `${JSON.stringify(medidor, null, 2)}\n`);
  const base = (components, conductors, extra = {}) => ({ schemaVersion: 2, components, topology: { revision: 0, nodes: [], conductors }, visual: { wireRoutes: "auto" }, ...extra });
  const sp = { samplePeriodNs: 10 * MS };
  fs.writeFileSync(path.join(workspace, "A", "projeto_a.lsproj"), `${JSON.stringify(base([
    comp("c", "control.constant", { value: 1, ...sp }, 20, 100),
    comp("g1", "control.gain", { gain: 3, ...sp }, 170, 100),
    comp("fo", "control.first_order", { gain: 2, tau: 1, initial: 0, ...sp }, 320, 100),
    comp("g2", "control.gain", { gain: 1, ...sp }, 20, 240),
    comp("g3", "control.gain", { gain: 0.5, ...sp }, 170, 240),
    comp("o", "control.observer", { observerOnly: true }, 320, 240),
    comp("ext1", "subcircuits.medidor_e2e", {}, 20, 400, { subcircuitRef: { path: "../lib/medidor.lssubcircuit" } }),
  ], [
    conductor("w1", "c", "out", "g1", "in"), conductor("w2", "g1", "out", "fo", "in"), conductor("w3", "fo", "out", "g2", "in"),
    conductor("w4", "g2", "out", "g3", "in"), conductor("w5", "g3", "out", "o", "in"), conductor("w6", "c", "out", "ext1", "in"),
  ]), null, 2)}\n`);
  // Projeto B já tem um subsistema "Sensor" (subsystem.sensor) DIFERENTE (ganho 10).
  fs.writeFileSync(path.join(workspace, "B", "projeto_b.lsproj"), `${JSON.stringify(base([
    comp("cb", "control.constant", { value: 1, ...sp }, 20, 500),
    comp("S", "subsystem.sensor", {}, 200, 500),
  ], [conductor("wb1", "cb", "out", "S", "in")], {
    subsystems: [signalBlock("subsystem.sensor", "Sensor", [comp("k", "control.gain", { gain: 10, ...sp }, 200, 80)])],
  }), null, 2)}\n`);
}

const allTypeIdsDeep = (doc) => JSON.stringify(doc).match(/"typeId":\s*"[^"]+"/g) ?? [];

(async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-subsys-ws-"));
  writeFixtures(workspace);
  const fileA = path.join(workspace, "A", "projeto_a.lsproj");
  const fileB = path.join(workspace, "B", "projeto_b.lsproj");
  const medidorFile = path.join(workspace, "lib", "medidor.lssubcircuit");
  const exportFile = path.join(workspace, "lib", "planta_exportada.lssubcircuit");
  const medidorHash = sha(medidorFile);
  let session;
  try {
    session = await launch(workspace, "subsys-1");
    const { workbench } = session;
    await openFile(workbench, "projeto_a.lsproj");
    let frame = await findFrame(workbench, '.component[data-component-id="g1"]');
    assertActivated(session.userData);
    check(Boolean(frame), "projeto A abre");
    await sleep(2500);

    // 1) Três subsistemas internos pela UI (Controlador com UM bloco só).
    await select(frame, ["g1"]);
    await contextMenu(frame, "g1", "Criar Subsistema Interno");
    await inputBox(workbench, "Controlador");
    let comps = await waitComponents(frame, (c) => ofType(c, "subsystem.controlador").length === 1);
    check(ofType(comps, "subsystem.controlador").length === 1 && !comps.some((c) => c.id === "g1"), "Controlador criado (um bloco) e a seleção virou a instância");
    check(!fs.readdirSync(path.join(workspace, "A")).some((name) => name.endsWith(".lssubcircuit")), "nenhum arquivo .lssubcircuit criado");

    await select(frame, ["fo", "g2"]);
    await contextMenu(frame, "g2", "Criar Subsistema Interno");
    await inputBox(workbench, "Planta");
    comps = await waitComponents(frame, (c) => ofType(c, "subsystem.planta").length === 1);
    const planta = ofType(comps, "subsystem.planta")[0];
    check(Boolean(planta) && !comps.some((c) => c.id === "fo" || c.id === "g2"), "Planta criada (1ª ordem + ganho)");

    await select(frame, ["g3"]);
    await contextMenu(frame, "g3", "Criar Subsistema Interno");
    await inputBox(workbench, "Instrumentação");
    comps = await waitComponents(frame, (c) => ofType(c, "subsystem.instrumentacao").length === 1);
    check(ofType(comps, "subsystem.instrumentacao").length === 1, "Instrumentação criada (typeId estável sem acento)");
    check(!(await paletteHas(workbench, "subsystem.planta")), "subsistemas internos não aparecem na paleta global");

    // 2) Desfazer/refazer a criação.
    await keys(frame, workbench, "Control+Z");
    comps = await waitComponents(frame, (c) => c.some((x) => x.id === "g3"));
    check(comps.some((c) => c.id === "g3") && ofType(comps, "subsystem.instrumentacao").length === 0, "desfazer a criação devolve o bloco original");
    await keys(frame, workbench, "Control+Y");
    comps = await waitComponents(frame, (c) => ofType(c, "subsystem.instrumentacao").length === 1);
    check(ofType(comps, "subsystem.instrumentacao").length === 1 && !comps.some((c) => c.id === "g3"), "refazer recria a instância");

    // 3) Hierarquia: dentro da Planta, criar o Sensor; navegar Projeto › Planta › Sensor; voltar um nível.
    await select(frame, [planta.id]);
    await keys(frame, workbench, "Control+C"); // para tentar colar a Planta dentro do próprio Sensor
    await contextMenu(frame, planta.id, "Abrir Modelo Interno");
    let crumb = await waitBreadcrumb(frame, (t) => /Planta/.test(t));
    frame = await liveFrame(frame);
    check(/projeto_a › Planta/.test(crumb), "caminho hierárquico ao abrir a Planta", crumb);
    comps = await waitComponents(frame, (c) => c.some((x) => x.id === "g2"));
    check(comps.some((c) => c.id === "fo") && comps.some((c) => c.id === "g2"), "modelo interno da Planta mostra os blocos");
    await select(frame, ["g2"]);
    await contextMenu(frame, "g2", "Criar Subsistema Interno");
    await inputBox(workbench, "Sensor");
    comps = await waitComponents(frame, (c) => ofType(c, "subsystem.sensor").length === 1);
    const sensor = ofType(comps, "subsystem.sensor")[0];
    check(Boolean(sensor), "Sensor criado DENTRO da Planta (aninhado)");
    await contextMenu(frame, sensor.id, "Abrir Modelo Interno");
    crumb = await waitBreadcrumb(frame, (t) => /Sensor/.test(t));
    frame = await liveFrame(frame);
    check(/projeto_a › Planta › Sensor/.test(crumb), "caminho com dois níveis", crumb);
    const insideSensor = await waitComponents(frame, (c) => c.some((x) => x.id === "g2"));
    await clearNotifications(workbench);
    await keys(frame, workbench, "Control+V");
    await sleep(2000);
    const recursion = (await notifications(workbench)).some((t) => /referência recursiva/.test(t));
    comps = await waitComponents(frame, (c) => c.length === insideSensor.length);
    check(recursion && comps.length === insideSensor.length && !comps.some((c) => c.typeId === "subsystem.planta"), "colar a Planta dentro do Sensor (que está dentro dela) é recusado", JSON.stringify(await notifications(workbench)));
    await (await liveFrame(frame)).locator('button[aria-label="Voltar ao nível superior"]').first().click();
    crumb = await waitBreadcrumb(frame, (t) => !/Sensor/.test(t));
    frame = await liveFrame(frame);
    check(/projeto_a › Planta$/.test(crumb.trim()), "voltar sobe UM nível (Sensor -> Planta)", crumb);
    await (await liveFrame(frame)).locator('button[aria-label="Voltar ao nível superior"]').first().click();
    await modalButton(workbench, "Salvar");
    crumb = await waitBreadcrumb(frame, (t) => t === "");
    frame = await liveFrame(frame);
    check(crumb === "", "de volta ao projeto");
    comps = await waitComponents(frame, (c) => ofType(c, "subsystem.planta").length === 1);

    // 3b) Editar Painel abre direto no modo Painel.
    const controlador = ofType(comps, "subsystem.controlador")[0];
    await contextMenu(frame, controlador.id, "Editar Painel");
    crumb = await waitBreadcrumb(frame, (t) => /Controlador/.test(t));
    frame = await liveFrame(frame);
    let mode = "";
    for (let attempt = 0; attempt < 40 && mode !== "symbol"; attempt++) { mode = await frame.evaluate(() => document.querySelector(".appbar__subcircuit-mode-select")?.value ?? ""); if (mode !== "symbol") await sleep(250); }
    check(/Controlador/.test(crumb) && mode === "symbol", "Editar Painel abre a definição no modo Painel", `${crumb} / ${mode}`);
    await (await liveFrame(frame)).locator('button[aria-label="Voltar ao nível superior"]').first().click();
    await sleep(1200);
    if (await workbench.locator(".monaco-dialog-box").first().isVisible().catch(() => false)) await modalButton(workbench, "Descartar Alterações");
    crumb = await waitBreadcrumb(frame, (t) => t === "");
    frame = await liveFrame(frame);
    check(crumb === "", "volta do Painel para o projeto");
    comps = await waitComponents(frame, (c) => ofType(c, "subsystem.controlador").length === 1);

    // 4) Duas instâncias da mesma definição + desfazer/refazer.
    await contextMenu(frame, controlador.id, "Inserir outra instância");
    comps = await waitComponents(frame, (c) => ofType(c, "subsystem.controlador").length === 2);
    check(ofType(comps, "subsystem.controlador").length === 2, "segunda instância do Controlador inserida");
    await keys(frame, workbench, "Control+Z");
    comps = await waitComponents(frame, (c) => ofType(c, "subsystem.controlador").length === 1);
    check(ofType(comps, "subsystem.controlador").length === 1, "desfazer remove a instância inserida");
    await keys(frame, workbench, "Control+Y");
    comps = await waitComponents(frame, (c) => ofType(c, "subsystem.controlador").length === 2);
    check(ofType(comps, "subsystem.controlador").length === 2, "refazer devolve a instância");

    // 5) Salvar: tabela com 4 definições, Sensor dentro da Planta, sem cópias por instância.
    let docA = await saveProject(workbench, fileA, (d) => (d.subsystems ?? []).length === 4);
    const tableA = docA?.subsystems ?? [];
    check(["subsystem.controlador", "subsystem.planta", "subsystem.sensor", "subsystem.instrumentacao"].every((t) => tableA.some((d) => d.typeId === t)), "projeto gravado com as 4 definições", JSON.stringify(tableA.map((d) => d.typeId)));
    check(tableA.find((d) => d.typeId === "subsystem.planta")?.components.some((c) => c.typeId === "subsystem.sensor"), "a definição da Planta contém uma instância do Sensor");
    check(!JSON.stringify(docA).includes("\"embedded\""), "nenhuma cópia incorporada por instância");
    check(docA.components.filter((c) => c.typeId === "subsystem.controlador").length === 2, "duas instâncias do Controlador no arquivo");
    check(docA.components.find((c) => c.id === "ext1")?.subcircuitRef?.path === "../lib/medidor.lssubcircuit", "sistema externo continua por referência relativa (separador portável)", docA.components.find((c) => c.id === "ext1")?.subcircuitRef?.path);

    // 6) Simular (três subsistemas ligados, um aninhado, um sistema externo com subsistema interno).
    await clearNotifications(workbench);
    await command(workbench, "LasecSimul: Run Simulation");
    await sleep(5000);
    let texts = await notifications(workbench);
    check(!texts.some((t) => ERROR_TEXT.test(t)), "simulação roda sem erros", JSON.stringify(texts));
    await command(workbench, "LasecSimul: Stop Simulation");
    await sleep(1500);

    // 7) Renomear (typeId não muda) e duplicar como definição independente.
    await contextMenu(frame, controlador.id, "Renomear subsistema…");
    await inputBox(workbench, "Controlador PID");
    await sleep(1000);
    comps = await componentsIn(frame);
    const second = ofType(comps, "subsystem.controlador").find((c) => c.id !== controlador.id);
    await contextMenu(frame, second.id, "Duplicar como definição independente…");
    await inputBox(workbench, "Controlador Rápido");
    comps = await waitComponents(frame, (c) => c.some((x) => x.id === second.id && x.typeId !== "subsystem.controlador"));
    const duplicatedType = comps.find((c) => c.id === second.id)?.typeId;
    check(duplicatedType?.startsWith("subsystem.") && duplicatedType !== "subsystem.controlador" && comps.find((c) => c.id === controlador.id)?.typeId === "subsystem.controlador", "duplicar: só aquela instância passa para a nova definição", duplicatedType);
    docA = await saveProject(workbench, fileA, (d) => (d.subsystems ?? []).length === 5);
    check(docA.subsystems.find((d) => d.typeId === "subsystem.controlador")?.name === "Controlador PID", "renomear muda o nome e mantém o typeId");
    check(docA.subsystems.find((d) => d.typeId === duplicatedType)?.name === "Controlador Rápido", "definição duplicada gravada com o novo nome");

    // 8) Exportar a Planta (leva o Sensor) e adicionar à paleta pelo aviso.
    await clearNotifications(workbench);
    await contextMenu(frame, planta.id, "Exportar como sistema externo…");
    await inputBox(workbench, exportFile);
    const exportedNote = workbench.locator(".notification-list-item", { hasText: "exportado como sistema externo" }).first();
    await exportedNote.waitFor({ state: "visible", timeout: 20000 }).catch(() => undefined);
    const exported = fs.existsSync(exportFile) ? readJson(exportFile) : undefined;
    check(exported?.typeId === "subcircuits.planta_exportada" && (exported.subsystems ?? []).some((d) => d.typeId === "subsystem.sensor"), "exportado com o subsistema interno de que depende", exported?.typeId);
    await exportedNote.locator(".monaco-button", { hasText: "Adicionar à paleta" }).click().catch(() => undefined);
    let inPalette = false;
    for (let attempt = 0; attempt < 30 && !inPalette; attempt++) { inPalette = await paletteHas(workbench, "subcircuits.planta_exportada"); if (!inPalette) await sleep(500); }
    check(inPalette, "sistema exportado adicionado à paleta (opcional)");
    frame = await findFrame(workbench, `.component[data-component-id="${planta.id}"]`);
    comps = await componentsIn(frame);
    check(ofType(comps, "subsystem.planta").length === 1, "o projeto continua usando a cópia interna da Planta");

    // 9) Copiar Planta (interno) + ext1 (externo) e colar no projeto B (outra pasta, com outro "Sensor").
    await select(frame, [planta.id, "ext1"]);
    await keys(frame, workbench, "Control+C");
    await saveProject(workbench, fileA);
    await openFile(workbench, "projeto_b.lsproj");
    frame = await findFrame(workbench, '.component[data-component-id="S"]');
    check(Boolean(frame), "projeto B aberto");
    await sleep(2500);
    const beforePaste = await componentsIn(frame);
    await keys(frame, workbench, "Control+V");
    comps = await waitComponents(frame, (c) => c.length >= beforePaste.length + 2 && c.some((x) => x.typeId === "subsystem.planta" && !x.missing) && c.some((x) => x.typeId === "subcircuits.medidor_e2e" && !x.missing));
    const pastedPlanta = comps.find((c) => c.typeId === "subsystem.planta");
    const pastedExt = comps.find((c) => c.typeId === "subcircuits.medidor_e2e");
    check(Boolean(pastedPlanta) && !pastedPlanta.missing, "Planta colada em B como subsistema interno e resolvida");
    check(Boolean(pastedExt) && !pastedExt.missing, "sistema externo colado em B continua externo e resolvido");
    await keys(frame, workbench, "Control+Z");
    comps = await waitComponents(frame, (c) => c.length === beforePaste.length);
    check(comps.length === beforePaste.length, "desfazer a colagem remove tudo (atômico)");
    await keys(frame, workbench, "Control+Y");
    comps = await waitComponents(frame, (c) => c.length === beforePaste.length + 2);
    check(comps.length === beforePaste.length + 2, "refazer a colagem");
    let docB = await saveProject(workbench, fileB, (d) => (d.subsystems ?? []).length >= 3);
    const tableB = docB?.subsystems ?? [];
    const originalSensor = tableB.find((d) => d.typeId === "subsystem.sensor");
    const plantaB = tableB.find((d) => d.typeId === "subsystem.planta");
    const nestedType = plantaB?.components.find((c) => c.typeId.startsWith("subsystem.sensor"))?.typeId;
    check(originalSensor?.components.some((c) => c.properties?.gain === 10), "o Sensor que B já tinha não foi sobrescrito");
    check(nestedType && nestedType !== "subsystem.sensor" && tableB.some((d) => d.typeId === nestedType), "o Sensor da Planta colada entrou com outra identidade (sem colisão)", nestedType);
    check(tableB.find((d) => d.typeId === nestedType)?.name !== "Sensor", "nome da cópia não colide", tableB.find((d) => d.typeId === nestedType)?.name);
    const extB = docB.components.find((c) => c.typeId === "subcircuits.medidor_e2e");
    check(extB?.subcircuitRef?.path && path.resolve(path.dirname(fileB), extB.subcircuitRef.path) === medidorFile, "referência externa resolvida a partir da pasta de B", extB?.subcircuitRef?.path);
    check(sha(medidorFile) === medidorHash, "arquivo do sistema externo não foi modificado");
    check(!JSON.stringify(docB).includes(path.join(workspace, "A").replace(/\\/g, "\\\\")), "B não guarda caminho do projeto A");

    // 10) Regra C: copiar um subsistema interno de dentro do sistema EXTERNO e colar em B.
    await contextMenu(frame, pastedExt.id, "Abrir Sistema Externo");
    crumb = await waitBreadcrumb(frame, (t) => /Medidor/.test(t));
    frame = await liveFrame(frame);
    check(/projeto_b › Medidor/.test(crumb), "sistema externo aberto para edição", crumb);
    comps = await waitComponents(frame, (c) => c.some((x) => x.id === "f1"));
    check(comps.find((c) => c.id === "f1")?.typeId === "subsystem.filtro", "dentro do externo, o Filtro é um subsistema interno do arquivo");
    await select(frame, ["f1"]);
    await keys(frame, workbench, "Control+C");
    await (await liveFrame(frame)).locator('button[aria-label="Voltar ao nível superior"]').first().click();
    crumb = await waitBreadcrumb(frame, (t) => t === "");
    frame = await liveFrame(frame);
    await sleep(1500);
    const beforeFiltro = await componentsIn(frame);
    await keys(frame, workbench, "Control+V");
    comps = await waitComponents(frame, (c) => c.length === beforeFiltro.length + 1 && c.every((x) => !x.missing));
    const pastedFiltro = comps.find((c) => !beforeFiltro.some((b) => b.id === c.id));
    check(pastedFiltro?.typeId?.startsWith("subsystem.filtro") && !pastedFiltro.missing, "Filtro colado em B virou subsistema interno de B", pastedFiltro?.typeId);
    docB = await saveProject(workbench, fileB, (d) => (d.subsystems ?? []).some((x) => x.typeId.startsWith("subsystem.filtro")));
    check(docB.subsystems.find((d) => d.typeId === pastedFiltro?.typeId)?.components.some((c) => c.properties?.gain === 7), "definição do Filtro copiada com o conteúdo do arquivo");
    check(sha(medidorFile) === medidorHash, "colar não alterou o arquivo externo");

    // 11) Incorporar o sistema externo (cópia independente do arquivo).
    await contextMenu(frame, pastedExt.id, "Incorporar ao projeto");
    comps = await waitComponents(frame, (c) => c.some((x) => x.id === pastedExt.id && x.typeId.startsWith("subsystem.")));
    check(comps.find((c) => c.id === pastedExt.id)?.typeId?.startsWith("subsystem."), "instância passou a usar uma definição interna", comps.find((c) => c.id === pastedExt.id)?.typeId);
    docB = await saveProject(workbench, fileB, (d) => !d.components.some((c) => c.subcircuitRef));
    check(!docB.components.some((c) => c.subcircuitRef), "B não depende mais de arquivo externo");
    check(sha(medidorFile) === medidorHash, "incorporar não alterou o arquivo externo");

    // 12) Excluir definição em uso: dentro de outra definição é recusado; com instâncias pede confirmação; desfazer.
    await command(workbench, "LasecSimul: Gerenciar Subsistemas Internos…");
    await quickPickExact(workbench, tableB.find((d) => d.typeId === nestedType).name);
    await quickPickExact(workbench, "Excluir definição…");
    const refused = workbench.locator(".monaco-dialog-box", { hasText: "é usado dentro de" }).first();
    check(await refused.waitFor({ state: "visible", timeout: 10000 }).then(() => true).catch(() => false), "excluir definição usada dentro de outra é recusado");
    await workbench.keyboard.press("Escape");
    await sleep(800);
    await command(workbench, "LasecSimul: Gerenciar Subsistemas Internos…");
    await quickPickExact(workbench, "Sensor");
    await quickPickExact(workbench, "Excluir definição…");
    await modalButton(workbench, "Excluir definição e 1 instância(s)");
    comps = await waitComponents(frame, (c) => !c.some((x) => x.id === "S"));
    check(!comps.some((c) => c.id === "S"), "definição excluída junto com a instância (após confirmação)");
    await keys(frame, workbench, "Control+Z");
    comps = await waitComponents(frame, (c) => c.some((x) => x.id === "S" && !x.missing));
    check(comps.some((c) => c.id === "S" && !c.missing), "desfazer a exclusão devolve definição e instância");
    docB = await saveProject(workbench, fileB, (d) => d.subsystems.some((x) => x.typeId === "subsystem.sensor"));
    check(docB.subsystems.some((d) => d.typeId === "subsystem.sensor") && docB.components.some((c) => c.id === "S"), "estado restaurado gravado");

    await clearNotifications(workbench);
    await command(workbench, "LasecSimul: Run Simulation");
    await sleep(5000);
    texts = await notifications(workbench);
    check(!texts.some((t) => ERROR_TEXT.test(t)), "B simula (subsistemas colados, incorporado, Filtro)", JSON.stringify(texts));
    await command(workbench, "LasecSimul: Stop Simulation");
    await workbench.screenshot({ path: path.join(artifacts, "subsys-1-b.png") });
  } catch (error) {
    console.log(`FAIL exceção: ${error instanceof Error ? error.stack : error}`);
    failures++;
    await session?.workbench.screenshot({ path: path.join(artifacts, "subsys-1-error.png") }).catch(() => undefined);
  } finally {
    await session?.browser.close().catch(() => undefined);
    session?.child.kill();
    fs.writeFileSync(catalogFile, catalogBackup);
    await sleep(3000);
  }

  // ---------- Sessão 2: reabrir; exportado em outro projeto; cópia em outra pasta sem os arquivos de origem.
  const fileC = path.join(workspace, "C", "projeto_c.lsproj");
  fs.mkdirSync(path.dirname(fileC), { recursive: true });
  fs.writeFileSync(fileC, `${JSON.stringify({ schemaVersion: 2, components: [
    comp("cc", "control.constant", { value: 1, samplePeriodNs: 10 * MS }, 40, 120),
    comp("px", "subcircuits.planta_exportada", {}, 260, 120, { subcircuitRef: { path: "../lib/planta_exportada.lssubcircuit" } }),
  ], topology: { revision: 0, nodes: [], conductors: [conductor("wc", "cc", "out", "px", "P1")] }, visual: { wireRoutes: "auto" } }, null, 2)}\n`);
  let second;
  try {
    second = await launch(workspace, "subsys-2");
    const { workbench } = second;
    await openFile(workbench, "projeto_a.lsproj");
    let frame = await findFrame(workbench, ".component[data-type-id='subsystem.planta']", 120);
    assertActivated(second.userData);
    let comps = frame ? await componentsIn(frame) : [];
    check(comps.length > 0 && !comps.some((c) => c.missing), "sessão nova: projeto A reabre com tudo resolvido", JSON.stringify(comps.filter((c) => c.missing)));
    await clearNotifications(workbench);
    await command(workbench, "LasecSimul: Run Simulation");
    await sleep(5000);
    let texts = await notifications(workbench);
    check(!texts.some((t) => ERROR_TEXT.test(t)), "A simula após reabrir", JSON.stringify(texts));
    await command(workbench, "LasecSimul: Stop Simulation");
    await sleep(1500);

    await openFile(workbench, "projeto_c.lsproj");
    frame = await findFrame(workbench, '.component[data-component-id="px"]', 120);
    comps = frame ? await componentsIn(frame) : [];
    check(comps.some((c) => c.id === "px" && !c.missing), "Planta exportada usada em OUTRO projeto (C) por referência");
    await clearNotifications(workbench);
    await command(workbench, "LasecSimul: Run Simulation");
    await sleep(5000);
    texts = await notifications(workbench);
    check(!texts.some((t) => ERROR_TEXT.test(t)), "C simula com o sistema exportado (e o Sensor dele)", JSON.stringify(texts));
    await command(workbench, "LasecSimul: Stop Simulation");
    await sleep(1500);

    // B copiado para outra pasta; arquivos de origem (medidor) removidos.
    const copyDir = path.join(workspace, "copias", "outra pasta");
    fs.mkdirSync(copyDir, { recursive: true });
    fs.copyFileSync(fileB, path.join(copyDir, "projeto_b_copia.lsproj"));
    fs.renameSync(medidorFile, `${medidorFile}.removido`);
    await openFile(workbench, path.join(copyDir, "projeto_b_copia.lsproj")); // recém-copiado: pelo caminho
    frame = await findFrame(workbench, '.component[data-component-id="S"]', 120);
    await sleep(3000);
    comps = frame ? await componentsIn(frame) : [];
    check(comps.length >= 5 && !comps.some((c) => c.missing), "cópia de B em outra pasta, sem o arquivo externo, abre resolvida", JSON.stringify(comps));
    await clearNotifications(workbench);
    await command(workbench, "LasecSimul: Run Simulation");
    await sleep(5000);
    texts = await notifications(workbench);
    check(!texts.some((t) => ERROR_TEXT.test(t)), "cópia de B simula sem o arquivo de origem", JSON.stringify(texts));
    await command(workbench, "LasecSimul: Stop Simulation");
    await workbench.screenshot({ path: path.join(artifacts, "subsys-2-copy.png") });
  } catch (error) {
    console.log(`FAIL exceção (sessão 2): ${error instanceof Error ? error.stack : error}`);
    failures++;
    await second?.workbench.screenshot({ path: path.join(artifacts, "subsys-2-error.png") }).catch(() => undefined);
  } finally {
    await second?.browser.close().catch(() => undefined);
    second?.child.kill();
    fs.writeFileSync(catalogFile, catalogBackup);
  }
  check(fs.readFileSync(catalogFile).equals(catalogBackup), "catálogo do repositório restaurado após o teste");
  console.log(`workspace: ${workspace}`);
  console.log(failures === 0 ? "SUBSYSTEMS E2E OK" : `${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
})();
