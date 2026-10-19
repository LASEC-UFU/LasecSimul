const { chromium } = require("@playwright/test");
const { downloadAndUnzipVSCode } = require("@vscode/test-electron");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const pixelmatch = require("pixelmatch").default;
const { PNG } = require("pngjs");

const extensionPath = path.resolve(__dirname, "../..");
const fixturePath = path.resolve(__dirname, "fixtures/instruments.lsproj");
const artifacts = path.resolve(__dirname, "artifacts");
const baselines = path.resolve(__dirname, "snapshots");
const update = process.env.UPDATE_SNAPSHOTS === "1";
fs.mkdirSync(artifacts, { recursive: true });
fs.mkdirSync(baselines, { recursive: true });

async function executablePath() {
  if (process.env.VSCODE_EXECUTABLE_PATH) return process.env.VSCODE_EXECUTABLE_PATH;
  return downloadAndUnzipVSCode({
    version: process.env.VSCODE_E2E_VERSION || "1.128.0",
    cachePath: path.resolve(extensionPath, ".vscode-test"),
    timeout: 120000,
  });
}

async function connect(port) {
  let last;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { return await chromium.connectOverCDP(`http://127.0.0.1:${port}`); }
    catch (error) { last = error; await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  throw last;
}

function compare(name, actualPath) {
  const expectedPath = path.join(baselines, `${name}.png`);
  if (update || !fs.existsSync(expectedPath)) {
    fs.copyFileSync(actualPath, expectedPath);
    return { pixels: 0, ratio: 0, updated: true };
  }
  const expected = PNG.sync.read(fs.readFileSync(expectedPath));
  const actual = PNG.sync.read(fs.readFileSync(actualPath));
  if (expected.width !== actual.width || expected.height !== actual.height) {
    throw new Error(`${name}: dimensÃƒÂ£o ${actual.width}x${actual.height}, esperado ${expected.width}x${expected.height}`);
  }
  const diff = new PNG({ width: actual.width, height: actual.height });
  const pixels = pixelmatch(expected.data, actual.data, diff.data, actual.width, actual.height, {
    threshold: 0.12,
    includeAA: false,
  });
  fs.writeFileSync(path.join(artifacts, `${name}.diff.png`), PNG.sync.write(diff));
  fs.copyFileSync(expectedPath, path.join(artifacts, `${name}.expected.png`));
  const ratio = pixels / (actual.width * actual.height);
  if (ratio > 0.005) throw new Error(`${name}: ${pixels} pixels diferentes (${(ratio * 100).toFixed(3)}%)`);
  return { pixels, ratio, updated: false };
}

async function command(workbench, title) {
  await workbench.keyboard.press("Control+Shift+P");
  const input = workbench.locator(".quick-input-widget input, .quick-input-box input").first();
  await input.waitFor({ state: "visible" });
  await input.fill(title);
  await workbench.keyboard.press("Enter");
}

async function domClick(locator) {
  await locator.evaluate((element) => element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true })));
}

async function dragSvgMark(locator, dx, dy) {
  await locator.evaluate((element, offset) => {
    const svg = element.ownerSVGElement;
    const box = element.getBoundingClientRect();
    const x = box.left + box.width / 2, y = box.top + box.height / 2;
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, clientX: x, clientY: y }));
    svg.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: x + offset.dx, clientY: y + offset.dy }));
    svg.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: x + offset.dx, clientY: y + offset.dy }));
  }, { dx, dy });
}

(async () => {
  const port = 9300 + Math.floor(Math.random() * 500);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-e2e-user-"));
  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-e2e-ext-"));
  const childEnv = { ...process.env, LASECSIMUL_E2E: "1", LASECSIMUL_E2E_FIXTURE: fixturePath };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(await executablePath(), [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userData}`,
    `--extensions-dir=${extensionsDir}`,
    `--extensionDevelopmentPath=${extensionPath}`,
    "--disable-workspace-trust",
    "--disable-updates",
    "--skip-welcome",
    "--force-device-scale-factor=1",
    "--disable-gpu",
    "--disable-shared-process",
    "--new-window",
    extensionPath,
  ], {
    env: childEnv,
    stdio: ["ignore", fs.openSync(path.join(artifacts, "vscode.stdout.log"), "w"), fs.openSync(path.join(artifacts, "vscode.stderr.log"), "w")],
  });
  let browser;
  try {
    browser = await connect(port);
    let pages = [];
    let workbench;
    for (let attempt = 0; attempt < 120 && !workbench; attempt++) {
      pages = browser.contexts().flatMap((context) => context.pages());
      workbench = pages.find((page) => page.url().includes("workbench"))
        ?? pages.find((page) => page.url().startsWith("vscode-file:"));
      if (!workbench) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    fs.writeFileSync(path.join(artifacts, "pages.json"), JSON.stringify(await Promise.all(pages.map(async (page) => ({ url: page.url(), title: await page.title() }))), null, 2));
    if (!workbench) throw new Error("VS Code de teste nÃƒÂ£o criou uma pÃƒÂ¡gina de workbench");
    await workbench.locator(".monaco-workbench").waitFor({ state: "visible", timeout: 60000 });
    await workbench.screenshot({ path: path.join(artifacts, "workbench.png") });
    await workbench.setViewportSize({ width: 1440, height: 1000 });
    const activity = workbench.locator('.activitybar [aria-label*="LasecSimul"], .activitybar [title*="LasecSimul"]').first();
    await activity.waitFor({ state: "visible", timeout: 30000 });
    await activity.click(); // ativa a extensÃƒÂ£o; o modo E2E abre a fixture pelo pipeline real

    let paletteFrame;
    for (let attempt = 0; attempt < 120 && !paletteFrame; attempt++) {
      for (const frame of workbench.frames()) {
        if (frame === workbench.mainFrame()) continue;
        try {
          if (await frame.locator(".palette-tabs").count()) { paletteFrame = frame; break; }
        } catch { /* a view pode substituir o iframe durante a ativacao */ }
      }
      if (!paletteFrame) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!paletteFrame) throw new Error("Paleta real do LasecSimul nao abriu");

    // A antiga aba Processo nÃƒÂ£o existe mais: PLC, protocolos e ferramentas moram em Controle.
    if (await paletteFrame.getByRole("tab", { name: /^(Processo|Process)$/ }).count()) throw new Error("a aba Processo nÃƒÂ£o deveria mais existir");
    const controlTab = paletteFrame.getByRole("tab", { name: /^(Controle|Control)$/ }).first();
    await controlTab.waitFor({ state: "visible", timeout: 30000 });
    await domClick(controlTab);

    const requiredControlTypeIds = [
      "plc.instance",
      "protocol.modbus.server",
      "protocol.modbus.client",
      "protocol.hart.device.standard",
      "protocol.hart.modem",
      "control.pid_station",
      "control.constant",
      "control.observer",
      "subcircuits.control.gain",
      "subcircuits.control.pid",
    ];
    for (const typeId of requiredControlTypeIds) {
      // O tÃƒÂ­tulo ÃƒÂ© "typeId\ncaminho\ndica": o `\a ` (quebra de linha em CSS) exige o typeId INTEIRO,
      // senÃƒÂ£o `subcircuits.control.pid` tambÃƒÂ©m casaria com outro typeId que comece igual.
      await paletteFrame.locator(`.palette-item[title^="${typeId}\\a "]`).waitFor({ state: "attached", timeout: 30000 });
    }
    // Plantas nÃƒÂ£o sÃƒÂ£o registradas globalmente: nenhuma aparece na paleta (cada projeto traz a sua).
    for (const typeId of ["subcircuits.process.fopdt", "subcircuits.tdps.basic_flow_loop", "subcircuits.tdps.boiler", "subcircuits.process.hydraulic_tank"]) {
      if (await paletteFrame.locator(`.palette-item[title^="${typeId}\\a "]`).count()) throw new Error(`a planta ${typeId} nÃƒÂ£o deveria estar na paleta`);
    }
    const controlLayout = await paletteFrame.evaluate(() => {
      const typeIdOf = (item) => item.dataset.typeId || (item.getAttribute("title") || "").split("\n")[0];
      return Array.from(document.querySelectorAll(".palette__tree > .palette-folder")).map((folder) => ({
        label: (folder.querySelector(":scope > .palette-folder__summary")?.textContent || "").replace(/^[>v\s]+/, "").trim(),
        typeIds: Array.from(folder.querySelectorAll(".palette-item")).map(typeIdOf),
      }));
    });
    const folderOf = (typeId) => controlLayout.findIndex((folder) => folder.typeIds.includes(typeId));
    const layoutText = JSON.stringify(controlLayout.map((folder) => folder.label));
    if (controlLayout[0]?.typeIds[0] !== "plc.instance") throw new Error(`o PLC deveria ser o primeiro item de Controle: ${layoutText}`);
    if (folderOf("protocol.modbus.server") !== 1 || folderOf("protocol.hart.modem") !== 1) {
      throw new Error(`Modbus e HART deveriam estar na mesma pasta, logo depois do PLC: ${layoutText}`);
    }
    if (folderOf("control.pid_station") !== 2) throw new Error(`Ferramentas deveria vir depois dos protocolos: ${layoutText}`);
    if (folderOf("control.constant") !== 3 || folderOf("subcircuits.control.gain") !== 3) {
      throw new Error(`os blocos que estavam na raiz de Controle deveriam estar em Blocos Funcionais, depois de Ferramentas: ${layoutText}`);
    }

    // A paleta ÃƒÂ© reconstruÃƒÂ­da quando o catÃƒÂ¡logo chega de novo (ex.: Core terminando de subir); se
    // isso acontecer no meio da captura, o elemento some e basta tentar outra vez.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await paletteFrame.locator(".palette").screenshot({
          path: path.join(artifacts, "control-palette.actual.png"),
          animations: "disabled",
        });
        break;
      } catch (error) {
        if (attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    const toolFolder = controlLayout[folderOf("control.pid_station")];
    const actionIndex = toolFolder?.typeIds.indexOf("action.controlDesigner") ?? -1;
    if (actionIndex < 0 || toolFolder?.typeIds[actionIndex - 1] !== "control.pid_station") {
      throw new Error("Projeto de Controladores deve aparecer imediatamente depois de Sintonia em Ferramentas");
    }
    const designerAction = paletteFrame.locator('.palette-item[data-type-id="action.controlDesigner"]');
    await designerAction.waitFor({ state: "visible" });
    if ((await designerAction.innerText()).includes("pino")) throw new Error("a aÃƒÂ§ÃƒÂ£o da ferramenta nÃƒÂ£o deve indicar pinos");
    await domClick(designerAction);
    let designerFrame;
    for (let attempt = 0; attempt < 100 && !designerFrame; attempt++) {
      for (const frame of workbench.frames()) {
        if (frame === workbench.mainFrame()) continue;
        try { if (await frame.locator("#gain").count()) { designerFrame = frame; break; } }
        catch { /* O iframe pode ser substituÃƒÂ­do enquanto o editor inicia. */ }
      }
      if (!designerFrame) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!designerFrame) throw new Error("o botÃƒÂ£o da paleta nÃƒÂ£o abriu o Projeto de Controladores");
    if (!(await designerFrame.locator("h1").innerText()).includes("SisoTools")) throw new Error("SisoTools heading is missing");
    if (await designerFrame.locator("#rl path, #rl polyline").count() === 0) throw new Error(`root plot empty; error=${await designerFrame.locator("#error").innerText()}; svg=${(await designerFrame.locator("#rl").innerHTML()).slice(0,300)}`);
    if (await designerFrame.locator("#nichols path, #nichols polyline").count() === 0 || await designerFrame.locator("#nyquist path, #nyquist polyline").count() < 2) throw new Error("Nichols/Nyquist nÃƒÂ£o foram calculados");
    if (!(await designerFrame.locator("#importCircuit").isVisible()) || !(await designerFrame.locator("#applyCircuit").isVisible())) throw new Error("aÃƒÂ§ÃƒÂµes de integraÃƒÂ§ÃƒÂ£o com o circuito ausentes");
    const graphCards = designerFrame.locator(".plots .card");
    for (let index = 0; index < await graphCards.count(); index++) {
      const card = graphCards.nth(index);
      const toggle = card.locator(".graph-fullscreen-toggle");
      const originalBounds = await card.boundingBox();
      if (!(await toggle.isVisible())) throw new Error(`controle de tela cheia ausente no grÃƒÂ¡fico ${index + 1}`);
      await domClick(toggle);
      if (!(await card.evaluate((element) => element.classList.contains("fullscreen")))) throw new Error(`grÃƒÂ¡fico ${index + 1} nÃƒÂ£o expandiu independentemente`);
      if (!(await toggle.locator("svg path").count())) throw new Error(`ÃƒÂ­cone de tela cheia ausente no grÃƒÂ¡fico ${index + 1}`);
      const expandedBounds = await card.boundingBox();
      const webviewSize = await designerFrame.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      if (!expandedBounds || expandedBounds.width < webviewSize.width * 0.9 || expandedBounds.height < webviewSize.height * 0.8) throw new Error(`graph ${index + 1} not ocupou a janela: ${JSON.stringify({ expandedBounds, webviewSize })}`);
      await domClick(toggle);
      if (await card.evaluate((element) => element.classList.contains("fullscreen"))) throw new Error(`grÃƒÂ¡fico ${index + 1} nÃƒÂ£o retornou ao tamanho anterior`);
      const restoredBounds = await card.boundingBox();
      if (!originalBounds || !restoredBounds || Math.abs(restoredBounds.width - originalBounds.width) > 2 || Math.abs(restoredBounds.height - originalBounds.height) > 2) throw new Error(`graph ${index + 1} not restaurou o tamanho independente`);
    }
    const unnamedButtons = await designerFrame.locator("button").evaluateAll((buttons) => buttons.filter((button) => !(button.getAttribute("aria-label") || button.getAttribute("title") || button.textContent.trim())).map((button) => button.outerHTML));
    if (unnamedButtons.length) throw new Error(`botÃƒÂµes sem nome acessÃƒÂ­vel no Projeto de Controladores: ${unnamedButtons.join(" | ")}`);
    const keyboardToggle = graphCards.first().locator(".graph-fullscreen-toggle");
    await keyboardToggle.focus();
    if (!(await keyboardToggle.evaluate((button) => document.activeElement === button))) throw new Error("o controle de tela cheia nÃƒÂ£o recebe foco de teclado");
    await workbench.keyboard.press("Enter");
    await workbench.keyboard.press("Escape");
    if (!(await keyboardToggle.evaluate((button) => document.activeElement === button))) throw new Error("Escape nÃƒÂ£o devolveu foco ao controle de tela cheia");
    const keyboardPlot = designerFrame.locator("#bode");
    const initialViewBox = await keyboardPlot.getAttribute("viewBox");
    await keyboardPlot.focus();
    await keyboardPlot.press("ArrowRight");
    if (await keyboardPlot.getAttribute("viewBox") === initialViewBox) throw new Error("grÃƒÂ¡fico nÃƒÂ£o respondeu ÃƒÂ  navegaÃƒÂ§ÃƒÂ£o por teclado");
    await keyboardPlot.press("Home");
    if (await keyboardPlot.getAttribute("viewBox") !== "0 0 640 330") throw new Error("Home nÃƒÂ£o restaurou o enquadramento do grÃƒÂ¡fico");
    await designerFrame.locator("body").screenshot({ path: path.join(artifacts, "control-designer.png"), animations: "disabled" });
    const plotBounds = await designerFrame.locator(".plots").boundingBox();
    if (!plotBounds || plotBounds.width < 300 || plotBounds.height < 300) throw new Error(`os grÃƒÂ¡ficos do projeto nÃƒÂ£o tÃƒÂªm ÃƒÂ¡rea ÃƒÂºtil: ${JSON.stringify(plotBounds)}`);
    await designerFrame.locator(".plots").screenshot({ path: path.join(artifacts, "control-designer-plots.png"), animations: "disabled" });
    await designerFrame.locator(".plots").evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await designerFrame.locator("#nyquist").scrollIntoViewIfNeeded();
    await designerFrame.locator("#nyquist").screenshot({ path: path.join(artifacts, "control-designer-nyquist.png"), animations: "disabled" });
    const polesBefore = await designerFrame.locator("#loopMetrics").innerText();
    await designerFrame.locator("#gain").evaluate((input) => { input.value = "0.4"; input.dispatchEvent(new Event("input", { bubbles: true })); });
    await designerFrame.waitForFunction((before) => document.querySelector("#loopMetrics")?.textContent !== before, polesBefore);
    const cNumerator = designerFrame.locator('[data-model="C"][data-part="num"]');
    const cDenominator = designerFrame.locator('[data-model="C"][data-part="den"]');
    await cNumerator.evaluate((input) => { input.value = "4"; input.dispatchEvent(new Event("input", { bubbles: true })); });
    await cDenominator.evaluate((input) => { input.value = "1, 2"; input.dispatchEvent(new Event("input", { bubbles: true })); });
    const draggablePole = designerFrame.locator('#controllerPz [data-kind="pole"]').first();
    await draggablePole.waitFor({ state: "visible" });
    const poleBefore = await cDenominator.inputValue();
    await dragSvgMark(draggablePole, 22, -8);
    await designerFrame.waitForFunction((before) => document.querySelector('[data-model="C"][data-part="den"]')?.value !== before, poleBefore);
    if (await designerFrame.locator('#controllerPz [data-kind="pole"]').count() !== 1) throw new Error("o mapa de polos do controlador nÃƒÂ£o foi redesenhado apÃƒÂ³s arrastar");
    await cNumerator.evaluate((input) => { input.value = "2, 2"; input.dispatchEvent(new Event("input", { bubbles: true })); });
    await cDenominator.evaluate((input) => { input.value = "1, 2"; input.dispatchEvent(new Event("input", { bubbles: true })); });
    const zero = designerFrame.locator('#controllerPz [data-kind="zero"]').first();
    const numeratorBeforeZeroDrag = await cNumerator.inputValue();
    await dragSvgMark(zero, -18, 7);
    await designerFrame.waitForFunction((before) => document.querySelector('[data-model="C"][data-part="num"]')?.value !== before, numeratorBeforeZeroDrag);
    await cNumerator.evaluate((input) => { input.value = "4"; input.dispatchEvent(new Event("input", { bubbles: true })); });
    await cDenominator.evaluate((input) => { input.value = "1, 2, 2"; input.dispatchEvent(new Event("input", { bubbles: true })); });
    const complexPole = designerFrame.locator('#controllerPz [data-kind="pole"]').first();
    const complexDenominatorBefore = await cDenominator.inputValue();
    await dragSvgMark(complexPole, 12, -12);
    await designerFrame.waitForFunction((before) => document.querySelector('[data-model="C"][data-part="den"]')?.value !== before, complexDenominatorBefore);
    if (await designerFrame.locator('#controllerPz [data-kind="pole"]').count() !== 2 || (await designerFrame.locator("#error").innerText())) throw new Error("arraste do polo complexo rompeu o par conjugado");
    const keyboardPole = designerFrame.locator('#controllerPz [data-kind="pole"]').first();
    if (!(await keyboardPole.getAttribute("aria-label"))?.includes("Polo 1")) throw new Error("polo do controlador sem nome acessÃƒÂ­vel");
    const keyboardDenominatorBefore = await cDenominator.inputValue();
    await keyboardPole.focus();
    await keyboardPole.press("ArrowRight");
    await designerFrame.waitForFunction((before) => document.querySelector('[data-model="C"][data-part="den"]')?.value !== before, keyboardDenominatorBefore);
    if (await designerFrame.locator('#controllerPz [data-kind="pole"]').count() !== 2) throw new Error("ediÃƒÂ§ÃƒÂ£o de polo por teclado rompeu o par conjugado");
    await domClick(designerAction);
    let designerFrameCount = 0;
    for (const frame of workbench.frames()) {
      if (frame !== workbench.mainFrame() && await frame.locator("#gain").count()) designerFrameCount += 1;
    }
    if (designerFrameCount > 1) {
      throw new Error("clique repetido abriu instÃƒÂ¢ncia duplicada do projeto de controle");
    }
    await workbench.keyboard.press("Control+PageUp");
    await new Promise((resolve) => setTimeout(resolve, 350));

    let schematicFrame;
    for (let attempt = 0; attempt < 80 && !schematicFrame; attempt++) {
      for (const frame of workbench.frames()) {
        if (frame === workbench.mainFrame()) continue;
        try { if (await frame.locator('.component[data-component-id="designerPlant"]').count()) { schematicFrame = frame; break; } }
        catch { /* Webview substituÃƒÂ­do durante a troca da aba ativa. */ }
      }
      if (!schematicFrame) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!schematicFrame) throw new Error("fixture sem os blocos LTI de integraÃƒÂ§ÃƒÂ£o");
    const plantBlock = schematicFrame.locator('.component[data-component-id="designerPlant"]');
    await plantBlock.evaluate((element) => {
      const box = element.getBoundingClientRect();
      element.setPointerCapture = () => {};
      const x = box.left + box.width / 2, y = box.top + box.height / 2;
      element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX: x, clientY: y }));
      element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX: x, clientY: y }));
    });
    await domClick(designerAction);
    await designerFrame.locator("#importCircuit").click();
    await designerFrame.waitForFunction(() => document.querySelector('[data-model="G"][data-part="num"]')?.value === "2");
    if (await designerFrame.locator('[data-model="G"][data-part="den"]').inputValue() !== "3, 1") throw new Error("importaÃƒÂ§ÃƒÂ£o da planta selecionada gerou coeficientes incorretos");
    if (!(await designerFrame.locator("#bindingStatus").innerText()).includes("sincronizado")) throw new Error("vÃƒÂ­nculo da planta importada nÃƒÂ£o foi mostrado como sincronizado");
    await domClick(designerAction);
    await workbench.keyboard.press("Control+PageUp");
    await new Promise((resolve) => setTimeout(resolve, 350));

    // AplicaÃƒÂ§ÃƒÂ£o confirmada pela UI do VS Code e histÃƒÂ³rico real da Webview.
    const gainBlock = schematicFrame.locator('.component[data-component-id="designerGain"]');
    await gainBlock.evaluate((element) => {
      const box = element.getBoundingClientRect(), x = box.left + box.width / 2, y = box.top + box.height / 2;
      element.setPointerCapture = () => {};
      element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 2, button: 0, clientX: x, clientY: y }));
      element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 2, button: 0, clientX: x, clientY: y }));
    });
    await schematicFrame.waitForFunction(() => document.querySelector('.component[data-component-id="designerGain"]')?.classList.contains("selected"), null, { timeout: 5000 });
    await domClick(designerAction);
    await designerFrame.locator("#applyCircuit").waitFor({ state: "visible", timeout: 10000 });
    await designerFrame.locator("#importTarget").selectOption("F");
    await domClick(designerFrame.locator("#importCircuit"));
    await designerFrame.waitForFunction(() => document.querySelector('[data-model="F"][data-part="num"]')?.value === "1", null, { timeout: 10000 });
    await designerFrame.locator("#importTarget").selectOption("G");
    await designerFrame.locator('[data-model="C"][data-part="num"]').evaluate((input) => { input.value = "5"; input.dispatchEvent(new Event("input", { bubbles: true })); });
    await designerFrame.locator('[data-model="C"][data-part="den"]').evaluate((input) => { input.value = "1"; input.dispatchEvent(new Event("input", { bubbles: true })); });
    await domClick(designerFrame.locator("#applyCircuit"));
    await workbench.waitForTimeout(500);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await workbench.keyboard.press("Control+PageUp");
    await new Promise((resolve) => setTimeout(resolve, 350));
    schematicFrame = undefined;
    for (let attempt = 0; attempt < 80 && !schematicFrame; attempt++) {
      for (const frame of workbench.frames()) {
        if (frame === workbench.mainFrame()) continue;
        try { if (await frame.locator('.component[data-component-id="designerGain"]').count()) { schematicFrame = frame; break; } }
        catch { /* Webview substituÃƒÂ­do durante a troca da aba ativa. */ }
      }
      if (!schematicFrame) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!schematicFrame) throw new Error("Webview do esquemÃƒÂ¡tico nÃƒÂ£o voltou apÃƒÂ³s aplicar C");
    const gainProperties = schematicFrame.locator('.property-dock input[type="number"]');
    const ensureGainProperties = async () => {
      const block = schematicFrame.locator('.component[data-component-id="designerGain"]');
      await block.evaluate((element) => {
        const box=element.getBoundingClientRect(),x=box.left+box.width/2,y=box.top+box.height/2;
        element.setPointerCapture=()=>{};
        element.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,cancelable:true,pointerId:3,button:0,clientX:x,clientY:y}));
        element.dispatchEvent(new PointerEvent("pointerup",{bubbles:true,cancelable:true,pointerId:3,button:0,clientX:x,clientY:y}));
      });
      if (await schematicFrame.locator(".property-dock-toggle").isVisible().catch(() => false)) await domClick(schematicFrame.locator(".property-dock-toggle"));
      await gainProperties.first().waitFor({ state: "visible", timeout: 5000 });
      return gainProperties.first().inputValue();
    };
    const appliedGain = await ensureGainProperties();
    if (Number(appliedGain) !== 5) throw new Error(`aplicaÃƒÂ§ÃƒÂ£o do controlador nÃƒÂ£o atualizou Designer Gain: ${appliedGain}`);
    await schematicFrame.locator("body").click({ position: { x: 20, y: 20 } }).catch(() => {});
    await workbench.keyboard.press("Control+Z");
    await workbench.waitForTimeout(350);
    const undoneGain = await ensureGainProperties();
    if (Number(undoneGain) !== 1) throw new Error(`Ctrl+Z nÃƒÂ£o desfez a aplicaÃƒÂ§ÃƒÂ£o do controlador: ${undoneGain}`);
    await schematicFrame.locator("body").click({ position: { x: 20, y: 20 } }).catch(() => {});
    await workbench.keyboard.press("Control+Y");
    await workbench.waitForTimeout(350);
    const redoneGain = await ensureGainProperties();
    if (Number(redoneGain) !== 5) throw new Error(`Ctrl+Y nÃƒÂ£o refez a aplicaÃƒÂ§ÃƒÂ£o do controlador: ${redoneGain}`);

    // Exercise discrete mode and arbitrary sampled input through the visible designer UI.
    await workbench.keyboard.press("Control+PageDown");
    await designerFrame.locator("#domain").waitFor({ state: "visible", timeout: 10000 });
    await designerFrame.evaluate(() => { window.confirm = () => true; });
    await designerFrame.locator("#domain").selectOption("discrete");
    await designerFrame.locator("#timeKind").selectOption("custom");
    await designerFrame.locator("#timeInputSamples").fill("1, 1, 1, 0");
    await designerFrame.waitForFunction(() => document.querySelector("#timeMetrics")?.textContent?.includes("4 pontos em Ts=0.1 s"), null, { timeout: 10000 }).catch(async error => { const state = await designerFrame.evaluate(() => ({ domain: document.querySelector("#domain")?.value, kind: document.querySelector("#timeKind")?.value, metrics: document.querySelector("#timeMetrics")?.textContent, error: document.querySelector("#error")?.textContent })); throw new Error(`${error.message}; ${JSON.stringify(state)}`); });
    if (await designerFrame.locator('#rl title').count() === 0) throw new Error("discrete root locus is missing its unit-circle marker");
    await designerFrame.evaluate(() => {
      const editor = document.querySelector("#stateSpaceEditor"); if (editor) editor.open = true;
      for (const [id,value] of [["ssA","0.5, 0; 0, 1.2"],["ssB","1, 0"],["ssC","1, 0"],["ssD","0"]]) {
        const field = document.getElementById(id); if (field) (field).value = value;
      }
      document.querySelector("#applyStateSpace").click();
    });
    await designerFrame.waitForFunction(() => document.querySelector("#loopMetrics")?.textContent?.includes("1.200"), null, { timeout: 10000 });
    await workbench.keyboard.press("Control+PageUp");

    // Apply a digital C(z) to a real transfer-function block and verify undo/redo on its persisted fields.
    const discreteBlock = schematicFrame.locator('.component[data-component-id="designerDiscreteTf"]');
    await discreteBlock.evaluate((element) => {
      const box=element.getBoundingClientRect(),x=box.left+box.width/2,y=box.top+box.height/2;
      element.setPointerCapture=()=>{};
      element.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,cancelable:true,pointerId:7,button:0,clientX:x,clientY:y}));
      element.dispatchEvent(new PointerEvent("pointerup",{bubbles:true,cancelable:true,pointerId:7,button:0,clientX:x,clientY:y}));
    });
    await schematicFrame.waitForFunction(() => document.querySelector('.component[data-component-id="designerDiscreteTf"]')?.classList.contains("selected"), null, { timeout: 5000 });
    await schematicFrame.waitForFunction(() => document.querySelector('.component[data-component-id="designerDiscreteTf"]')?.classList.contains("selected"), null, { timeout: 5000 });
    await domClick(designerAction);
    designerFrame = undefined;
    for (let attempt = 0; attempt < 80 && !designerFrame; attempt++) {
      for (const frame of workbench.frames()) { if (frame === workbench.mainFrame()) continue; try { if (await frame.locator("#applyCircuit").count()) { designerFrame = frame; break; } } catch { /* replaced webview */ } }
      if (!designerFrame) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!designerFrame) throw new Error("discrete Control Designer webview did not reopen");
    await designerFrame.locator('[data-model="C"][data-part="num"]').evaluate((input) => { input.value="0.2"; input.dispatchEvent(new Event("input",{bubbles:true})); });
    await designerFrame.locator('[data-model="C"][data-part="den"]').evaluate((input) => { input.value="1, -0.5"; input.dispatchEvent(new Event("input",{bubbles:true})); });
    await domClick(designerFrame.locator("#applyCircuit"));
    await workbench.waitForTimeout(500);
    await workbench.keyboard.press("Control+PageUp");
    const discreteProperty = (key) => schematicFrame.locator('.property-sheet__field-row').filter({hasText:new RegExp(key,"i")}).locator("input").first();
    const selectDiscreteBlock = async () => {
      await discreteBlock.evaluate((element) => {
        const box=element.getBoundingClientRect(),x=box.left+box.width/2,y=box.top+box.height/2;
        element.setPointerCapture=()=>{};
        element.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,cancelable:true,pointerId:8,button:0,clientX:x,clientY:y}));
        element.dispatchEvent(new PointerEvent("pointerup",{bubbles:true,cancelable:true,pointerId:8,button:0,clientX:x,clientY:y}));
      });
    };
    const waitForDiscreteValue = async (key, expected) => {
      await selectDiscreteBlock();
      const field = discreteProperty(key);
      const deadline = Date.now() + 15000;
      let actual = "";
      while (Date.now() < deadline) {
        actual = await field.inputValue();
        if (actual === expected) return;
        await workbench.waitForTimeout(100);
      }
      throw new Error(`${key} expected ${expected}, received ${actual}`);
    };
    await waitForDiscreteValue("Numerator Coefficients", "0.2");
    await schematicFrame.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true })));
    await waitForDiscreteValue("Numerator Coefficients", "0.1");
    await schematicFrame.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "y", ctrlKey: true, bubbles: true, cancelable: true })));
    await waitForDiscreteValue("Numerator Coefficients", "0.2");

    const schematicTab = workbench.getByRole("tab", { name: /Schematic/ }).first();
    if (await schematicTab.count()) await schematicTab.click();
    let instrumentFrame;
    for (let attempt = 0; attempt < 120 && !instrumentFrame; attempt++) {
      for (const frame of workbench.frames()) {
        if (frame === workbench.mainFrame()) continue;
        try {
          if (await frame.locator('.component[data-component-id="scope"]').count()) { instrumentFrame = frame; break; }
        } catch { /* VS Code substitui o iframe vazio pelo Webview real durante a ativaÃƒÂ§ÃƒÂ£o */ }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!instrumentFrame) throw new Error("Webview real nÃƒÂ£o abriu a fixture determinÃƒÂ­stica");
    await instrumentFrame.evaluate(() => document.fonts.ready);
    // O painel de propriedades (posterior ÃƒÂ s imagens de referÃƒÂªncia) abre por padrÃƒÂ£o e cobre o lado
    // direito das janelas de instrumento; recolhe para a captura mostrar a janela inteira.
    const propertyDockToggle = instrumentFrame.locator(".property-dock__header button").first();
    if (await propertyDockToggle.count()) await domClick(propertyDockToggle);

    await domClick(instrumentFrame.locator('.component[data-component-id="scope"] .meter-expand-button'));
    const scope = instrumentFrame.locator('.instrument-popup[data-component-id="scope"]');
    await scope.waitFor({ state: "visible" });
    await scope.evaluate((element) => { element.style.width = "780px"; element.style.height = "570px"; });
    await instrumentFrame.waitForTimeout(600);
    const scopeActual = path.join(artifacts, "oscope.actual.png");
    await scope.screenshot({ path: scopeActual, animations: "disabled" });
    const scopeResult = compare("oscope", scopeActual);
    await domClick(scope.locator(".instrument-popup__close"));

    await domClick(instrumentFrame.locator('.component[data-component-id="logic"] .meter-expand-button'));
    const analyzer = instrumentFrame.locator('.instrument-popup[data-component-id="logic"]');
    await analyzer.waitFor({ state: "visible" });
    await analyzer.evaluate((element) => { element.style.width = "780px"; element.style.height = "520px"; });
    const restoredCondition = await analyzer.locator(".instrument-trigger-condition").inputValue();
    if (restoredCondition !== "1 == 1") {
      throw new Error(`condiÃƒÂ§ÃƒÂ£o persistida nÃƒÂ£o foi restaurada: ${JSON.stringify(restoredCondition)}`);
    }
    // A condicao persistida e verdadeira no primeiro timestamp. Limpe-a temporariamente para a
    // aquisicao materializar todos os canais antes de testar a pausa; caso contrario o Core pode
    // pausar antes da primeira rodada de telemetria e o snapshot fica dependente do timing de IPC.
    const conditionInput = analyzer.locator(".instrument-trigger-condition");
    await conditionInput.fill("");
    await conditionInput.dispatchEvent("change");
    await new Promise((resolve) => setTimeout(resolve, 500));
    await domClick(instrumentFrame.locator(".appbar__button--start"));
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await analyzer.getByText("DATA[7]", { exact: true }).first().waitFor({ state: "visible", timeout: 15000 });
    await conditionInput.fill("1 == 1");
    await conditionInput.dispatchEvent("change");
    fs.writeFileSync(path.join(artifacts, "webview-state.txt"), await instrumentFrame.locator("body").innerText());
    await analyzer.locator(".instrument-pause-event").waitFor({ state: "visible", timeout: 15000 });
    const analyzerActual = path.join(artifacts, "analyzer.actual.png");
    await analyzer.screenshot({ path: analyzerActual, animations: "disabled" });
    const analyzerResult = compare("analyzer", analyzerActual);

    // Resize real observado pelo mesmo ResizeObserver da UI e persistÃƒÂªncia
    // apÃƒÂ³s fechar/reabrir.
    const before = await analyzer.boundingBox();
    if (!before) throw new Error("nÃƒÂ£o foi possÃƒÂ­vel medir a janela do analisador");
    const expectedSize = {
      // Reduzir evita que o max-width/max-height responsivo do iframe masque
      // a alteraÃƒÂ§ÃƒÂ£o quando o editor estiver estreito.
      width: Math.max(620, Math.round(before.width - 80)),
      height: Math.max(390, Math.round(before.height - 60)),
    };
    await analyzer.evaluate((element, size) => {
      element.style.width = `${size.width}px`;
      element.style.height = `${size.height}px`;
      element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    }, expectedSize);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const resized = await analyzer.boundingBox();
    if (!resized || Math.abs(resized.width - expectedSize.width) > 2 || Math.abs(resized.height - expectedSize.height) > 2) {
      throw new Error("redimensionamento responsivo do analisador nÃƒÂ£o foi aplicado");
    }
    await domClick(analyzer.locator(".instrument-popup__close"));
    await domClick(instrumentFrame.locator('.component[data-component-id="logic"] .meter-expand-button'));
    const reopened = instrumentFrame.locator('.instrument-popup[data-component-id="logic"]');
    await reopened.waitFor({ state: "visible" });
    const after = await reopened.boundingBox();
    if (!after || Math.abs(expectedSize.width - after.width) > 2 || Math.abs(expectedSize.height - after.height) > 2) {
      throw new Error(`configuraÃƒÂ§ÃƒÂ£o da janela nÃƒÂ£o persistiu ao reabrir: antes ${Math.round(before.width)}x${Math.round(before.height)}, ` +
        `esperado ${expectedSize.width}x${expectedSize.height}, reaberta ${after ? `${Math.round(after.width)}x${Math.round(after.height)}` : "ausente"}`);
    }

    fs.writeFileSync(path.join(artifacts, "results.json"), JSON.stringify({
      viewport: { width: 1440, height: 1000, deviceScaleFactor: 1 },
      comparison: { algorithm: "pixelmatch", threshold: 0.12, maxDifferentRatio: 0.005, antialiasingIgnored: true },
      scope: scopeResult,
      analyzer: analyzerResult,
    }, null, 2));
    console.log(`Webview E2E OK: scope=${scopeResult.pixels}px analyzer=${analyzerResult.pixels}px`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (process.platform === "win32" && child.pid) {
      await new Promise((resolve) => {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
        killer.once("exit", resolve);
        killer.once("error", resolve);
      });
    } else child.kill();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
