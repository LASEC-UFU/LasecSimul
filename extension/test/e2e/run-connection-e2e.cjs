const { chromium } = require("@playwright/test");
const { downloadAndUnzipVSCode } = require("@vscode/test-electron");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const extensionPath = path.resolve(__dirname, "../..");
const fixturePath = path.resolve(__dirname, "fixtures/connections.lsproj");
const artifacts = path.resolve(__dirname, "artifacts");
fs.mkdirSync(artifacts, { recursive: true });

async function connect(port) {
  let last;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { return await chromium.connectOverCDP(`http://127.0.0.1:${port}`); }
    catch (error) { last = error; await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  throw last;
}

async function findFrame(workbench, selector) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    for (const frame of workbench.frames()) {
      if (frame === workbench.mainFrame()) continue;
      try { if (await frame.locator(selector).count()) return frame; } catch { /* iframe replaced during activation */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
}

function center(box) { return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; }

function assertOrthogonal(pointsText) {
  const points = pointsText.trim().split(/\s+/).map((entry) => {
    const [x, y] = entry.split(",").map(Number);
    return { x, y };
  });
  for (let index = 0; index + 1 < points.length; index += 1) {
    if (points[index].x !== points[index + 1].x && points[index].y !== points[index + 1].y) {
      throw new Error(`segmento diagonal em ${pointsText}`);
    }
  }
}

(async () => {
  const port = 9800 + Math.floor(Math.random() * 100);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-connection-e2e-user-"));
  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-connection-e2e-ext-"));
  const executable = await downloadAndUnzipVSCode({
    version: process.env.VSCODE_E2E_VERSION || "1.128.0",
    cachePath: path.resolve(extensionPath, ".vscode-test"),
    timeout: 120000,
  });
  const childEnv = { ...process.env, LASECSIMUL_E2E: "1", LASECSIMUL_E2E_FIXTURE: fixturePath };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  let childOutput = "";
  const child = spawn(executable, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userData}`,
    `--extensions-dir=${extensionsDir}`,
    `--extensionDevelopmentPath=${extensionPath}`,
    "--disable-workspace-trust", "--disable-updates", "--skip-welcome",
    "--force-device-scale-factor=1", "--disable-gpu", "--disable-shared-process", "--new-window",
  ], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  const captureChildOutput = (chunk) => { childOutput = (childOutput + chunk.toString()).slice(-12000); };
  child.stdout.on("data", captureChildOutput);
  child.stderr.on("data", captureChildOutput);
  let browser;
  try {
    browser = await connect(port);
    let workbench;
    for (let attempt = 0; attempt < 140 && !workbench; attempt += 1) {
      const pages = browser.contexts().flatMap((context) => context.pages());
      workbench = pages.find((page) => page.url().includes("workbench")) ?? pages.find((page) => page.url().startsWith("vscode-file:"));
      if (!workbench) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!workbench) throw new Error("VS Code de teste não criou o workbench");
    await workbench.locator(".monaco-workbench").waitFor({ state: "visible", timeout: 60000 });
    await workbench.setViewportSize({ width: 1440, height: 1000 });
    const activity = workbench.locator('.activitybar [aria-label*="LasecSimul"], .activitybar [title*="LasecSimul"]').first();
    await activity.waitFor({ state: "visible", timeout: 30000 });
    await activity.click();

    const frame = await findFrame(workbench, '.component[data-component-id="source"]');
    if (!frame) {
      const frames = await Promise.all(workbench.frames().map(async (candidate) => ({
        url: candidate.url(),
        sourceCount: await candidate.locator('.component[data-component-id="source"]').count().catch(() => -1),
        body: await candidate.locator("body").innerText({ timeout: 1000 }).catch(() => "<indisponível>"),
      })));
      throw new Error(`Webview de conexões não abriu\nframes=${JSON.stringify(frames)}\nVSCode=${childOutput}`);
    }
    await frame.evaluate(() => document.fonts.ready);
    const sourcePin = frame.locator('.component[data-component-id="source"] .pin-terminal').first();
    const targetPin = frame.locator('.component[data-component-id="target"] .pin-terminal').first();
    const sourceBox = await sourcePin.boundingBox();
    const targetBox = await targetPin.boundingBox();
    if (!sourceBox || !targetBox) throw new Error("pinos reais não ficaram visíveis");

    const sourceAt = center(sourceBox);
    const targetAt = center(targetBox);
    await workbench.mouse.move(sourceAt.x, sourceAt.y);
    await workbench.mouse.down();
    await workbench.mouse.move(targetAt.x, targetAt.y, { steps: 18 });
    await targetPin.waitFor({ state: "visible" });
    if (!(await targetPin.evaluate((element) => element.classList.contains("pin-terminal--dock-target")))) {
      throw new Error("destino não recebeu feedback visual de docking");
    }
    await workbench.mouse.up();

    const wire = frame.locator('.wire-layer polyline[data-wire-id]').first();
    await wire.waitFor({ state: "attached", timeout: 15000 });
    const before = await wire.getAttribute("points");
    if (!before) throw new Error("fio criado sem geometria");
    assertOrthogonal(before);

    // O painel de propriedades aberto ao selecionar o instrumento cobre o destino. Mover a fonte
    // valida o mesmo reroteamento de endpoint usando uma area que continua visivel no editor real.
    const source = frame.locator('.component[data-component-id="source"]');
    const sourceComponentBox = await source.boundingBox();
    if (!sourceComponentBox) throw new Error("componente de origem não mensurável");
    const sourceDragAt = {
      x: sourceComponentBox.x + sourceComponentBox.width / 2,
      y: sourceComponentBox.y + 10,
    };
    await workbench.mouse.move(sourceDragAt.x, sourceDragAt.y);
    await workbench.mouse.down();
    await workbench.mouse.move(sourceDragAt.x, sourceDragAt.y + 20, { steps: 5 });
    if (!(await source.evaluate((element) => element.classList.contains("dragging")))) {
      throw new Error("o gesto não iniciou o arrasto do componente");
    }
    await workbench.mouse.move(sourceDragAt.x, sourceDragAt.y + 130, { steps: 15 });
    await workbench.mouse.up();
    let movedSourceBox;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      movedSourceBox = await source.boundingBox();
      if (movedSourceBox && Math.abs(movedSourceBox.y - sourceComponentBox.y) > 80) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!movedSourceBox || Math.abs(movedSourceBox.y - sourceComponentBox.y) <= 80) {
      throw new Error("o endpoint não permaneceu na posição arrastada");
    }
    await wire.waitFor({ state: "attached", timeout: 5000 });
    const after = await wire.getAttribute("points");
    if (!after || after === before) throw new Error("mover um endpoint não recalculou a rota");
    assertOrthogonal(after);

    // A mesma sessão valida o caminho HMI -> requestUpdateProperty -> componente alvo. A mensagem
    // de status é injetada como o host faria ao entrar em RUN, sem depender de um Core externo.
    await frame.evaluate(() => window.dispatchEvent(new MessageEvent("message", {
      data: { version: 1, type: "simulationStatus", status: "running" },
    })));
    const operator = frame.locator('.component[data-component-id="operator"]');
    await operator.waitFor({ state: "visible", timeout: 5000 });
    await operator.waitFor({ state: "attached" });
    if (!(await operator.evaluate((element) => element.classList.contains("component--hmi-operator-run")))) {
      throw new Error("controle HMI não entrou no comportamento de RUN");
    }
    const readSelectedVoltage = () => frame.evaluate(() => {
      for (const row of document.querySelectorAll(".property-sheet__field-row")) {
        const caption = row.querySelector(".property-sheet__field-label")?.textContent ?? "";
        if (!/(tens|voltage|volt)/i.test(caption)) continue;
        const input = row.querySelector("input");
        if (input instanceof HTMLInputElement) return input.value;
      }
      return null;
    });
    const sourceVoltageBeforeAction = await readSelectedVoltage();
    if (sourceVoltageBeforeAction === null) {
      throw new Error("Inspector não expôs a tensão da fonte selecionada");
    }
    const operatorMarkupBeforeAction = await operator.locator(".component__symbol").innerHTML();
    const operatorBox = await operator.boundingBox();
    if (!operatorBox) throw new Error("controle HMI não mensurável");
    const operatorAt = center(operatorBox);
    await workbench.mouse.move(operatorAt.x, operatorAt.y);
    await workbench.mouse.down();
    await workbench.mouse.up();
    let sourceVoltageAfterAction = sourceVoltageBeforeAction;
    let operatorMarkupAfterAction = operatorMarkupBeforeAction;
    for (let attempt = 0; attempt < 50 && sourceVoltageAfterAction === sourceVoltageBeforeAction; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      sourceVoltageAfterAction = await readSelectedVoltage();
      operatorMarkupAfterAction = await operator.locator(".component__symbol").innerHTML();
    }
    if (sourceVoltageAfterAction === sourceVoltageBeforeAction) {
      throw new Error(`ação HMI não atualizou source.voltage no Inspector (${sourceVoltageBeforeAction})`);
    }
    if (operatorMarkupAfterAction === operatorMarkupBeforeAction) {
      throw new Error("ação HMI atualizou o alvo, mas não redesenhou o controle operador");
    }

    await frame.locator(".canvas").screenshot({ path: path.join(artifacts, "connection-editor-e2e.png"), animations: "disabled" });
    process.stdout.write(`connection + HMI action E2E OK\n${path.join(artifacts, "connection-editor-e2e.png")}\n`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    child.kill();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
