// E2E (VS Code real, Core real): Faceplate de subsistema no motor visual (docs/62 §8–10, cenário G do doc 63).
// Duas instâncias do tanque do exemplo, um Faceplate aberto por instância: valores vivos de cada uma, comando
// num slider vale só para a sua instância (`@c_qin.value`), editar o Faceplate (definição) aparece nas duas
// vistas sem reconstruir a simulação, e o arquivo grava o Faceplate dentro da definição.
// Uso: npm run test:visual:faceplate:e2e. ATENÇÃO: abre uma janela do VS Code na sessão do usuário (avise
// quem estiver usando a máquina). Não usa a área de transferência.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const extensionPath = path.resolve(__dirname, "../..");
const example = path.resolve(extensionPath, "../examples/calculo/tanque.lsproj");
const artifacts = path.join(extensionPath, "test", "e2e", "artifacts", "visual-faceplate");
const req = (name) => require(path.join(extensionPath, "node_modules", name));
const { chromium } = req("@playwright/test");
const { downloadAndUnzipVSCode } = req("@vscode/test-electron");
fs.mkdirSync(artifacts, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (cond, label, detail = "") => { console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? ` -- ${detail}` : ""}`); if (!cond) failures++; return cond; };
const TANK = "subsystem.process.hydraulic_tank";

async function launch(workspace) {
  const port = 9600 + Math.floor(Math.random() * 300);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-faceplate-user-"));
  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-faceplate-ext-"));
  fs.mkdirSync(path.join(userData, "User"), { recursive: true });
  fs.writeFileSync(path.join(userData, "User", "settings.json"), JSON.stringify({
    "lasecsimul.network.mode": "isolated", "workbench.startupEditor": "none", "lasecsimul.language": "pt-BR",
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

const framesWith = async (workbench, selector) => {
  const found = [];
  for (const frame of workbench.frames()) {
    try { if (await frame.locator(selector).count()) found.push(frame); } catch { /* frame em troca */ }
  }
  return found;
};

async function waitFor(fn, predicate, attempts = 80, delay = 250) {
  let value;
  for (let attempt = 0; attempt < attempts; attempt++) {
    value = await fn().catch(() => undefined);
    if (predicate(value)) return value;
    await sleep(delay);
  }
  return value;
}

/** Número mostrado por um elemento (display): "Volume 21,40 L" -> 21.4. */
const numberIn = async (frame, id) => {
  const text = await frame.locator(`.component[data-component-id="${id}"]`).first().evaluate((el) => el.textContent.replace(/\s+/g, " "));
  const match = /(-?\d+(?:[.,]\d+)?)/.exec(text.replace(/^[^\d-]*/, ""));
  return match ? Number(match[1].replace(",", ".")) : Number.NaN;
};

(async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-faceplate-ws-"));
  const projectFile = path.join(workspace, "tanque.lsproj");
  // Fixture: o exemplo + uma Tela HMI que lê um interno da instância por caminho (`tanque-lab:acc`).
  const fixture = JSON.parse(fs.readFileSync(example, "utf8"));
  fixture.components.push({ id: "botao-planta", typeId: "tools.hmi_screen", label: "Planta", properties: { title: "Planta", screenId: "planta", width: 176, height: 64 }, visual: { x: 300, y: 20, rotation: 0 } });
  fixture.visualDocuments.push({
    schemaVersion: 1, id: "planta", kind: "screen", title: "Planta", presentation: { fullscreenContext: "hmi", startInOperation: true }, startPageId: "p1",
    pages: [{ id: "p1", name: "Planta", width: 960, height: 540, elements: [
      { id: "v-acc", typeId: "graphics.value_display", label: "Volume", properties: { width: 220, height: 64, label: "Volume pela tela", bindSource: "tanque-lab:acc", bindUnit: "L", bindDecimals: 2 }, visual: { x: 40, y: 40, width: 220, height: 64, rotation: 0 } },
    ] }],
  });
  fs.writeFileSync(projectFile, JSON.stringify(fixture, null, 2));
  const { browser, workbench, child } = await launch(workspace);
  try {
    await workbench.setViewportSize({ width: 1700, height: 1100 });
    await sleep(4000);
    for (let attempt = 0; attempt < 10; attempt++) {
      await workbench.keyboard.press("Control+P");
      const quick = workbench.locator(".quick-input-widget input").first();
      await quick.waitFor({ state: "visible", timeout: 15000 });
      await quick.fill("tanque.lsproj");
      try {
        await workbench.locator(".quick-input-list .monaco-list-row", { hasText: "tanque.lsproj" }).first().waitFor({ state: "visible", timeout: 3000 });
        break;
      } catch { await workbench.keyboard.press("Escape"); await sleep(1000); }
    }
    await workbench.keyboard.press("Enter");
    const schematic = (await waitFor(() => framesWith(workbench, '.component[data-component-id="tanque-lab"]'), (frames) => frames?.length > 0, 240))?.[0];
    if (!check(Boolean(schematic), "o exemplo abre com o tanque no esquemático")) throw new Error("esquemático não abriu");

    const menuOn = async (componentId, label) => {
      // A instância inserida nasce por cima da primeira: o canto superior esquerdo é sempre da clicada.
      await schematic.locator(`.component[data-component-id="${componentId}"]`).first().click({ button: "right", position: { x: 14, y: 14 } });
      const item = schematic.locator(".context-menu__item", { has: schematic.locator(".context-menu__label", { hasText: label }) }).first();
      await item.waitFor({ state: "visible", timeout: 8000 });
      await item.click();
    };
    const tanks = () => schematic.locator(`.component[data-type-id="${TANK}"]`).evaluateAll((els) => els.map((el) => el.dataset.componentId));

    // 1) Segunda instância da mesma definição.
    await menuOn("tanque-lab", "Inserir outra instância");
    const both = await waitFor(tanks, (ids) => ids?.length === 2, 60);
    check(both?.length === 2, "duas instâncias do tanque", JSON.stringify(both));
    const second = both.find((id) => id !== "tanque-lab");
    await schematic.locator(".canvas").first().click({ position: { x: 5, y: 5 } });

    // 2) Um Faceplate por instância.
    await menuOn("tanque-lab", "Abrir Faceplate da instância");
    const frameA = (await waitFor(() => framesWith(workbench, 'body.visual-role .component[data-component-id="fp-volume"]'), (frames) => frames?.length === 1, 120))?.[0];
    check(Boolean(frameA), "Faceplate da 1ª instância abre numa vista própria");
    await menuOn(second, "Abrir Faceplate da instância");
    const framesAB = await waitFor(() => framesWith(workbench, 'body.visual-role .component[data-component-id="fp-volume"]'), (frames) => frames?.length === 2, 120);
    const frameB = framesAB?.find((frame) => frame !== frameA);
    check(Boolean(frameB), "Faceplate da 2ª instância abre noutra vista");
    // As duas vistas abrem como abas do mesmo grupo: traz a aba da vista antes de usá-la.
    // As vistas abrem como abas do mesmo grupo: abrir de novo pelo esquemático REVELA a vista existente
    // (mesmo caminho do usuário), o que a traz para a frente antes de usá-la.
    const activate = async (target) => {
      if (target === "screen") await schematic.locator('.component[data-component-id="botao-planta"]').first().dblclick();
      else await menuOn(target === "A" ? "tanque-lab" : second, "Abrir Faceplate da instância");
      await sleep(900);
    };
    const titleA = await frameA.locator(".appbar--visual").innerText();
    check(/Faceplate · Tanque/.test(titleA), "a barra diz de qual instância é o Faceplate", titleA.replace(/\s+/g, " ").slice(-80));

    // 3) Simulação: valores vivos das duas instâncias.
    await activate("A");
    await frameA.locator(".appbar--visual .appbar__button--start").first().click();
    // Vivo = saiu do valor estático do display (50) e está enchendo a partir de V0 = 20 L.
    const live = (v) => v > 20.2 && v < 40;
    const volumeA = await waitFor(() => numberIn(frameA, "fp-volume"), live, 120);
    const volumeB = await waitFor(() => numberIn(frameB, "fp-volume"), live, 120);
    check(live(volumeA) && live(volumeB), "volume vivo nas duas instâncias (enchendo a 0,6 L/s)", `${volumeA} / ${volumeB}`);
    const later = await waitFor(() => numberIn(frameA, "fp-volume"), (v) => v > volumeA + 0.2, 40);
    check(later > volumeA, "o volume da instância continua subindo", `${volumeA} → ${later}`);
    const trend = await waitFor(() => frameA.locator('.component[data-component-id="fp-tendencia"] polyline').count(), (n) => n > 0, 40);
    check(trend > 0, "a tendência do nível desenha a série da instância");

    // 3b) Uma Tela HMI do projeto lê o interno da instância pelo caminho `tanque-lab:acc`.
    await schematic.locator('.component[data-component-id="botao-planta"]').first().dblclick();
    const screen = (await waitFor(() => framesWith(workbench, 'body.visual-role .component[data-component-id="v-acc"]'), (frames) => frames?.length === 1, 120))?.[0];
    const viaPath = screen ? await waitFor(() => numberIn(screen, "v-acc"), live, 80) : Number.NaN;
    check(live(viaPath), "Tela HMI lê o volume da instância por caminho (tanque-lab:acc)", String(viaPath));
    await activate("A");

    // 4) Comando numa instância vale só para ela.
    const thumb = frameA.locator('.component[data-component-id="fp-slider-entrada"] .slider-thumb-hit').first();
    const box = await thumb.boundingBox();
    const track = await frameA.locator('.component[data-component-id="fp-slider-entrada"]').first().boundingBox();
    await frameA.page().mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await frameA.page().mouse.down();
    // Até a ponta direita do próprio slider (dentro da janela): satura no máximo (5 L/s).
    await frameA.page().mouse.move(track.x + track.width - 2, box.y + box.height / 2, { steps: 10 });
    await frameA.page().mouse.up();
    const entradaA = await waitFor(() => numberIn(frameA, "fp-entrada"), (v) => v > 4.9, 80);
    const entradaB = await numberIn(frameB, "fp-entrada");
    check(entradaA > 4.9, "slider da 1ª instância leva a entrada a 5 L/s", String(entradaA));
    check(Math.abs(entradaB - 1) < 1e-6, "a 2ª instância continua com 1 L/s (estado isolado)", String(entradaB));

    // 5) Editar o Faceplate (definição): as duas vistas mudam, a simulação não é reconstruída.
    const before = await numberIn(frameA, "fp-volume");
    await frameA.locator(".appbar--visual .appbar__button", { hasText: "Editar" }).click();
    await frameA.locator('.component[data-component-id="fp-titulo"]').first().click();
    const textField = frameA.locator(".property-dock .property-sheet__field-row", { has: frameA.locator(".property-sheet__field-label", { hasText: /^Texto:?$/ }) }).locator(".property-sheet__field-input").first();
    await textField.waitFor({ timeout: 10000 });
    await textField.fill("Tanque — painel editado");
    await textField.press("Enter");
    const shared = await waitFor(() => frameB.locator('.component[data-component-id="fp-titulo"]').first().evaluate((el) => el.textContent), (text) => /painel editado/.test(text ?? ""), 40);
    check(/painel editado/.test(shared ?? ""), "a edição do Faceplate aparece na vista da outra instância", shared);
    const running = await frameA.evaluate(() => document.querySelector(".appbar__status")?.className ?? "");
    const after = await waitFor(() => numberIn(frameA, "fp-volume"), (v) => v > before + 0.05, 40);
    check(/running/.test(running) && after > before, "editar o Faceplate não reinicia a simulação (o volume da mesma instância segue subindo)", `${running} ${before} → ${after}`);
    await frameA.locator(".appbar--visual .appbar__button--save").first().click();
    let saved;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { saved = JSON.parse(fs.readFileSync(projectFile, "utf8")); } catch { saved = undefined; }
      if (saved?.subsystems?.[0]?.faceplate?.pages?.[0]?.elements?.some((el) => el.id === "fp-titulo" && el.properties?.text === "Tanque — painel editado")) break;
      await sleep(250);
    }
    check(saved?.subsystems?.[0]?.faceplate?.pages?.[0]?.elements?.some((el) => el.id === "fp-titulo" && el.properties?.text === "Tanque — painel editado"),
      "o .lsproj grava o Faceplate dentro da definição");
    const instanceA = saved?.components?.find((component) => component.id === "tanque-lab");
    const instanceB = saved?.components?.find((component) => component.id === second);
    check(Number(instanceA?.properties?.["@c_qin.value"]) > 4.9 && instanceB?.properties?.["@c_qin.value"] === undefined,
      "o comando gravado é da instância (@c_qin.value só na 1ª)", JSON.stringify({ a: instanceA?.properties?.["@c_qin.value"], b: instanceB?.properties?.["@c_qin.value"] }));
    await frameA.page().screenshot({ path: path.join(artifacts, "faceplates.png") }).catch(() => undefined);

    // 6) Copiar no Faceplate e colar na Tela HMI do projeto (menus do LasecSimul, nunca a área de
    //    transferência do sistema): a ligação `acc` (interno) vira o caminho `tanque-lab:acc`.
    const menuIn = async (frame, locator, label, position) => {
      await locator.click({ button: "right", ...(position ? { position } : {}) });
      const item = frame.locator(".context-menu__item", { has: frame.locator(".context-menu__label", { hasText: label }) }).first();
      await item.waitFor({ state: "visible", timeout: 8000 });
      await item.click();
      await sleep(300);
    };
    await activate("A");
    await menuIn(frameA, frameA.locator('.component[data-component-id="fp-volume"]').first(), "Copiar");
    await activate("screen");
    await menuIn(screen, screen.locator(".canvas").first(), "Entrar em modo de edição", { x: 40, y: 300 });
    await menuIn(screen, screen.locator(".canvas").first(), "Colar", { x: 40, y: 300 });
    await screen.locator(".appbar--visual .appbar__button--save").first().click();
    let pasted;
    for (let attempt = 0; attempt < 60 && !pasted; attempt++) {
      try {
        const doc = JSON.parse(fs.readFileSync(projectFile, "utf8"));
        pasted = doc.visualDocuments.find((entry) => entry.id === "planta")?.pages[0].elements.find((el) => el.id !== "v-acc" && el.typeId === "graphics.value_display");
      } catch { pasted = undefined; }
      if (!pasted) await sleep(250);
    }
    check(pasted?.properties?.bindSource === "tanque-lab:acc", "colar do Faceplate na Tela remapeia a ligação para o caminho da instância", JSON.stringify(pasted?.properties?.bindSource));
  } catch (error) {
    check(false, "execução sem exceção", String(error && error.stack || error));
    await workbench.screenshot({ path: path.join(artifacts, "failure.png") }).catch(() => undefined);
  } finally {
    await browser.close().catch(() => undefined);
    try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* já saiu */ }
  }
  console.log(failures === 0 ? "\nFaceplate E2E: tudo ok" : `\nFaceplate E2E: ${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
})();
