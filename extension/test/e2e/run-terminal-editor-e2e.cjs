const { chromium } = require("@playwright/test");
const { downloadAndUnzipVSCode } = require("@vscode/test-electron");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const extensionPath = path.resolve(__dirname, "../..");
const fixturePath = path.resolve(__dirname, "fixtures/terminal-editor.lsproj");
const center = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
const domCenter = async (locator) => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const point = await locator.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    });
    if (point.x && point.y) return point;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Elemento SVG não adquiriu posição visível");
};

(async () => {
  const port = 9900 + Math.floor(Math.random() * 100);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-terminal-e2e-user-"));
  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-terminal-e2e-ext-"));
  const executable = await downloadAndUnzipVSCode({ version: "1.128.0", cachePath: path.resolve(extensionPath, ".vscode-test"), timeout: 120000 });
  const childEnv = { ...process.env, LASECSIMUL_E2E: "1", LASECSIMUL_E2E_FIXTURE: fixturePath };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, `--extensions-dir=${extensionsDir}`,
    `--extensionDevelopmentPath=${extensionPath}`, "--disable-workspace-trust", "--disable-updates",
    "--skip-welcome", "--force-device-scale-factor=1", "--disable-gpu", "--disable-shared-process", "--new-window",
  ], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  let childOutput = "";
  child.stdout.on("data", (chunk) => { childOutput += String(chunk); });
  child.stderr.on("data", (chunk) => { childOutput += String(chunk); });
  let browser;
  try {
    for (let attempt = 0; attempt < 100 && !browser; attempt += 1) {
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); }
      catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
    if (!browser) throw new Error("VS Code de teste não iniciou");
    let workbench;
    for (let attempt = 0; attempt < 140 && !workbench; attempt += 1) {
      workbench = browser.contexts().flatMap((context) => context.pages()).find((page) => page.url().includes("workbench"));
      if (!workbench) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!workbench) throw new Error("Workbench não abriu");
    await workbench.setViewportSize({ width: 1440, height: 1000 });
    const activity = workbench.locator('.activitybar [aria-label*="LasecSimul"], .activitybar [title*="LasecSimul"]').first();
    await activity.waitFor({ state: "visible", timeout: 30000 });
    await activity.click();
    let frame;
    for (let attempt = 0; attempt < 160 && !frame; attempt += 1) {
      for (const candidate of workbench.frames()) {
        if (candidate !== workbench.mainFrame() && await candidate.locator('.component[data-component-id="source"]').count().catch(() => 0)) {
          frame = candidate;
          break;
        }
      }
      if (!frame) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!frame) throw new Error(`Esquemático de teste não abriu: ${childOutput.slice(-2000)}`);

    const ammeter = frame.locator('.component[data-component-id="ammeter"]');
    const reading = ammeter.locator('.component__symbol-body text').first();
    await ammeter.waitFor({ state: "visible" });
    if (!(await reading.count())) throw new Error(`Amperímetro sem leitura: ${(await ammeter.innerHTML()).slice(0, 1500)}`);
    await reading.waitFor({ state: "visible" });
    const textAxes = (locator) => locator.evaluate((element) => {
      const matrix = element.getScreenCTM();
      return { horizontal: matrix?.a, vertical: matrix?.d };
    });
    const flipAmmeter = async (name) => {
      const meterBox = await ammeter.boundingBox();
      if (!meterBox) throw new Error("Amperímetro não mensurável");
      await workbench.mouse.click(meterBox.x + meterBox.width / 2, meterBox.y + meterBox.height / 2, { button: "right" });
      await frame.locator(".context-menu").first().getByRole("button", { name }).click();
    };
    await flipAmmeter(/Flip horizontally|Inverter horizontalmente/);
    let horizontalBody = await textAxes(ammeter.locator('.component__symbol-body'));
    for (let attempt = 0; attempt < 30 && !(horizontalBody.horizontal < 0); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      horizontalBody = await textAxes(ammeter.locator('.component__symbol-body'));
    }
    const horizontalAxes = await textAxes(reading);
    if (!(horizontalBody.horizontal < 0 && horizontalAxes.horizontal > 0 && horizontalAxes.vertical > 0)) {
      throw new Error(`Corpo deve espelhar sem inverter leitura horizontal: ${JSON.stringify({ horizontalBody, horizontalAxes })}`);
    }
    await flipAmmeter(/Flip horizontally|Inverter horizontalmente/);
    await flipAmmeter(/Flip vertically|Inverter verticalmente/);
    let verticalBody = await textAxes(ammeter.locator('.component__symbol-body'));
    for (let attempt = 0; attempt < 30 && !(verticalBody.vertical < 0); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      verticalBody = await textAxes(ammeter.locator('.component__symbol-body'));
    }
    const verticalAxes = await textAxes(reading);
    if (!(verticalBody.vertical < 0 && verticalAxes.horizontal > 0 && verticalAxes.vertical > 0)) {
      throw new Error(`Corpo deve espelhar sem inverter leitura vertical: ${JSON.stringify({ verticalBody, verticalAxes })}`);
    }
    const component = frame.locator('.component[data-component-id="obstacle"]');
    const pin = component.locator(".pin-terminal").first();
    const box = await component.boundingBox();
    if (!box) throw new Error("Componente não visível");
    await workbench.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
    await frame.getByRole("button", { name: /Edit terminals|Editar terminais/ }).click();
    await pin.waitFor({ state: "visible" });
    await pin.click();
    await pin.waitFor({ state: "visible" });
    if (!(await pin.evaluate((element) => element.classList.contains("pin-terminal--selected")))) {
      throw new Error("Terminal arrastado não permaneceu selecionado");
    }

    // Reproduz o relato: menu aberto sobre o corpo depois de selecionar o terminal.
    await workbench.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
    const menu = frame.locator(".context-menu").first();
    await menu.getByRole("button", { name: /Rotate clockwise|Girar no sentido horário/ }).waitFor({ state: "visible" });
    for (const name of [/Rotate counter-clockwise|Girar no sentido anti-horário/, /Rotate 180°|Girar 180°/,
      /Flip horizontally|Inverter horizontalmente/, /Flip vertically|Inverter verticalmente/]) {
      if (!(await menu.getByRole("button", { name }).count())) throw new Error(`Ação ausente: ${name}`);
    }
    if (await menu.getByRole("button", { name: /Copy|Copiar/ }).count()) throw new Error("Menu do componente abriu no lugar do terminal");
    const before = await component.locator(".component__symbol").innerHTML();
    await menu.getByRole("button", { name: /Rotate clockwise|Girar no sentido horário/ }).click();
    let after = await component.locator(".component__symbol").innerHTML();
    for (let attempt = 0; attempt < 30 && before === after; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      after = await component.locator(".component__symbol").innerHTML();
    }
    if (before === after) throw new Error(`Giro não mudou a orientação visual do terminal; markup=${before.slice(0, 280)}`);
    if (!(await pin.evaluate((element) => element.classList.contains("pin-terminal--selected")))) {
      throw new Error("Terminal perdeu a seleção depois do giro");
    }
    await workbench.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
    await frame.locator(".context-menu").first().getByRole("button", { name: /Rotate counter-clockwise|Girar no sentido anti-horário/ }).click();
    const label = component.locator(".component__symbol text").filter({ hasText: "OUT" }).first();
    await label.waitFor({ state: "visible" });
    const beforeFlip = await domCenter(pin);
    const labelBeforeFlip = await domCenter(label);
    await workbench.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
    await frame.locator(".context-menu").first().getByRole("button", { name: /Flip horizontally|Inverter horizontalmente/ }).click();
    let afterFlip = await domCenter(pin);
    let labelAfterFlip = await domCenter(label);
    for (let attempt = 0; attempt < 30 &&
      (Math.abs(labelAfterFlip.x - labelBeforeFlip.x) < 3 || afterFlip.x === 0 || afterFlip.y === 0 ||
       labelAfterFlip.x === 0 || labelAfterFlip.y === 0); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      afterFlip = await domCenter(pin);
      labelAfterFlip = await domCenter(label);
    }
    if (Math.abs(afterFlip.x - beforeFlip.x) > 1 || Math.abs(afterFlip.y - beforeFlip.y) > 1) {
      throw new Error(`Inversão horizontal moveu o terminal: ${JSON.stringify({ beforeFlip, afterFlip })}`);
    }
    if (Math.abs(labelAfterFlip.x - labelBeforeFlip.x) < 3) {
      throw new Error(`Inversão horizontal não levou OUT junto: ${JSON.stringify({ labelBeforeFlip, labelAfterFlip })}`);
    }
    await workbench.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
    await frame.locator(".context-menu").first().getByRole("button", { name: /Finish editing terminals|Concluir edição dos terminais/ }).click();
    await frame.evaluate(() => window.dispatchEvent(new MessageEvent("message", {
      data: { version: 1, type: "simulationStatus", status: "running" },
    })));
    const thumb = component.locator(".slider-thumb-hit");
    await thumb.waitFor({ state: "visible" });
    const thumbBefore = Number(await thumb.getAttribute("x"));
    if (!(thumbBefore > 90 && thumbBefore < 110)) {
      throw new Error(`Valor 940 na faixa 190..1690 deveria iniciar no centro: ${thumbBefore}`);
    }
    const sliderBox = await component.boundingBox();
    if (!sliderBox) throw new Error("Slider não mensurável");
    await workbench.mouse.click(sliderBox.x + 20, sliderBox.y + 10);
    if (!(await component.evaluate((element) => element.classList.contains("selected")))) {
      throw new Error("Primeiro clique não selecionou o slider");
    }
    if (Number(await thumb.getAttribute("x")) !== thumbBefore) throw new Error("Clique na trilha moveu o cursor");
    const thumbBox = await thumb.boundingBox();
    if (!thumbBox) throw new Error("Cursor do slider não mensurável");
    const thumbAt = center(thumbBox);
    await workbench.mouse.move(thumbAt.x, thumbAt.y);
    const cursor = await thumb.evaluate((element) => getComputedStyle(element).cursor);
    if (cursor !== "ew-resize") throw new Error(`Cursor de arraste inesperado: ${cursor}`);
    await workbench.mouse.down();
    await workbench.mouse.move(thumbAt.x + 40, thumbAt.y, { steps: 8 });
    await workbench.mouse.up();
    let thumbAfter = Number(await thumb.getAttribute("x"));
    for (let attempt = 0; attempt < 20 && thumbAfter <= thumbBefore + 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      thumbAfter = Number(await thumb.getAttribute("x"));
    }
    if (thumbAfter <= thumbBefore + 20) throw new Error(`Arraste não mudou o slider: ${thumbBefore} -> ${thumbAfter}`);
    // This fixture has no live Core: the host echoes its real stopped state
    // after the first persisted slider update. Restore Run for the second gesture.
    await frame.evaluate(() => window.dispatchEvent(new MessageEvent("message", {
      data: { version: 1, type: "simulationStatus", status: "running" },
    })));
    const rotated = frame.locator('.component[data-component-id="rotated"]');
    const rotatedThumb = rotated.locator('.slider-thumb-hit');
    await rotatedThumb.waitFor({ state: "visible" });
    const rotatedBefore = Number(await rotatedThumb.getAttribute("x"));
    const rotatedThumbBox = await rotatedThumb.boundingBox();
    if (!rotatedThumbBox) throw new Error("Cursor do slider girado não mensurável");
    const rotatedAt = center(rotatedThumbBox);
    await rotatedThumb.click();
    if (!(await rotated.evaluate((element) => element.classList.contains("selected")))) {
      const frameBox = await frame.frameElement().then((element) => element.boundingBox());
      const hit = await frame.evaluate(({ x, y }) => {
        const element = document.elementFromPoint(x, y);
        return { tag: element?.tagName, className: element?.getAttribute("class") };
      }, { x: rotatedAt.x - (frameBox?.x ?? 0), y: rotatedAt.y - (frameBox?.y ?? 0) });
      throw new Error(`Clique não selecionou slider girado: ${JSON.stringify({ rotatedAt, frameBox, hit })}`);
    }
    await frame.evaluate(() => window.dispatchEvent(new MessageEvent("message", {
      data: { version: 1, type: "simulationStatus", status: "running" },
    })));
    await workbench.mouse.move(rotatedAt.x, rotatedAt.y);
    const rotatedCursor = await rotatedThumb.evaluate((element) => getComputedStyle(element).cursor);
    if (rotatedCursor !== "ew-resize") throw new Error(`Cursor girado inesperado: ${rotatedCursor}; class=${await rotated.getAttribute("class")}`);
    await workbench.mouse.down();
    await workbench.mouse.move(rotatedAt.x, rotatedAt.y + 40, { steps: 8 });
    await workbench.mouse.up();
    let rotatedAfter = Number(await rotatedThumb.getAttribute("x"));
    for (let attempt = 0; attempt < 20 && Math.abs(rotatedAfter - rotatedBefore) < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      rotatedAfter = Number(await rotatedThumb.getAttribute("x"));
    }
    if (Math.abs(rotatedAfter - rotatedBefore) < 20) {
      throw new Error(`Arraste vertical não moveu slider girado: ${rotatedBefore} -> ${rotatedAfter}`);
    }
    if (!(await rotated.evaluate((element) => element.classList.contains("selected")))) {
      throw new Error("Slider perdeu a seleção após o primeiro arraste");
    }
    await frame.evaluate(() => window.dispatchEvent(new MessageEvent("message", {
      data: { version: 1, type: "simulationStatus", status: "running" },
    })));
    const secondThumbBox = await rotatedThumb.boundingBox();
    if (!secondThumbBox) throw new Error("Cursor do segundo arraste não mensurável");
    const secondAt = center(secondThumbBox);
    await workbench.mouse.move(secondAt.x, secondAt.y);
    await workbench.mouse.down();
    await frame.evaluate(() => window.dispatchEvent(new MessageEvent("message", {
      data: { version: 1, type: "boardOverlayData", componentId: "source", items: [] },
    })));
    await workbench.mouse.move(secondAt.x, secondAt.y - 40, { steps: 8 });
    await workbench.mouse.up();
    let secondAfter = Number(await rotatedThumb.getAttribute("x"));
    for (let attempt = 0; attempt < 20 && Math.abs(secondAfter - rotatedAfter) < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      secondAfter = Number(await rotatedThumb.getAttribute("x"));
    }
    if (Math.abs(secondAfter - rotatedAfter) < 20) {
      throw new Error(`Segundo arraste vertical não mudou slider: ${rotatedAfter} -> ${secondAfter}`);
    }
    if (!(await rotated.evaluate((element) => element.classList.contains("selected")))) {
      throw new Error("Slider perdeu a seleção após o segundo arraste");
    }
    process.stdout.write("terminal editor E2E OK\n");
  } finally {
    if (browser) await browser.close().catch(() => {});
    child.kill();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
