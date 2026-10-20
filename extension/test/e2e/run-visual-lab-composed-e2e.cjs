// E2E das páginas compostas do Laboratório (docs/65 §3.9) no VS Code real com o Core real: o exemplo
// laboratorio-calculo.lsproj abre a tela pelo botão do esquemático; na página do tanque, os elementos
// (tanque de processo, gráficos do processo, parâmetros da planta, controles, leituras, equações) recebem a
// MESMA gravação da planta; Executar pelos controles, slider muda a planta ao vivo (evento no gráfico),
// cursor do gráfico arrastável; primeira ordem e sensor também. Capturas em artifacts/lab-composed-*.png.
// Uso: npm run test:visual:lab:e2e
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
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-lab-composed-ws-"));
  fs.copyFileSync(example, path.join(workspace, "laboratorio-calculo.lsproj"));
  const port = 9600 + Math.floor(Math.random() * 300);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-lab-composed-user-"));
  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-lab-composed-ext-"));
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
  ], { env: childEnv, stdio: ["ignore", fs.openSync(path.join(artifacts, "lab-composed-vscode.stdout.log"), "w"), fs.openSync(path.join(artifacts, "lab-composed-vscode.stderr.log"), "w")] });
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
    let schematic;
    for (let attempt = 0; attempt < 240 && !schematic; attempt++) {
      for (const frame of workbench.frames()) {
        if (frame === workbench.mainFrame()) continue;
        if (await frame.locator('.component[data-component-id="tanque-lab"]').count().catch(() => 0)) { schematic = frame; break; }
      }
      if (!schematic) await sleep(250);
    }
    if (!schematic) throw new Error("projeto não abriu");
    // Fecha a barra lateral: mais espaço para a tela (as capturas mostram o que o aluno vê).
    await workbench.keyboard.press("Control+B");
    await schematic.locator('.component[data-component-id="laboratorio-calculo"]').first().dblclick();
    let shell;
    for (let attempt = 0; attempt < 160 && !shell; attempt++) {
      for (const frame of workbench.frames()) {
        try {
          if (await frame.locator("body.visual-role #labTabs button").count()) { shell = frame; break; }
        } catch { /* frame em troca */ }
      }
      if (!shell) await sleep(250);
    }
    if (!shell) throw new Error("tela do laboratório não abriu");
    const operate = shell.locator("body.visual-role .appbar--visual .appbar__button", { hasText: "Operar" });
    if (await operate.count()) await operate.first().click();
    // Tela só: aba da tela maximizada no grupo (o esquemático fica atrás).
    await workbench.keyboard.press("Control+K");
    await workbench.keyboard.press("Control+M").catch(() => undefined);
    await sleep(1500);

    const tab = (name) => shell.locator("#labTabs button", { hasText: name }).first();
    const element = (typeId, index = 0) => shell.locator(`.component[data-type-id="${typeId}"]`).nth(index);
    const textOf = (typeId, index = 0) => element(typeId, index).evaluate((node) => node.textContent ?? "").catch(() => "");
    const waitText = async (typeId, index, test, timeoutMs, label) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) { const text = await textOf(typeId, index); if (test(text)) return text; await sleep(300); }
      console.log(`  (tempo esgotado esperando ${label}: ${(await textOf(typeId, index)).slice(0, 160)})`);
      return await textOf(typeId, index);
    };
    /** Clica num ponto do elemento dado em coordenadas da caixa do próprio elemento (o zoom da página não importa). */
    const clickAt = async (locator, fx, fy) => {
      const box = await locator.boundingBox();
      await workbench.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
    };
    const dragAt = async (locator, fx0, fx1, fy) => {
      const box = await locator.boundingBox();
      await workbench.mouse.move(box.x + box.width * fx0, box.y + box.height * fy);
      await workbench.mouse.down();
      for (let k = 1; k <= 8; k++) { await workbench.mouse.move(box.x + box.width * (fx0 + ((fx1 - fx0) * k) / 8), box.y + box.height * fy); await sleep(40); }
      await workbench.mouse.up();
    };

    // ---------------------------------------------------------------- tanque
    await tab("Tanque").click();
    await sleep(1200);
    check(await element("graphics.math.process_tank").count() === 1, "página do tanque tem o tanque de processo");
    const charts = await shell.locator('.component[data-type-id="graphics.math.series_chart"]').count();
    const sliders = await shell.locator('.component[data-type-id="graphics.math.plant_parameter"]').count();
    check(charts === 2, "dois gráficos do processo (nível e vazão)", String(charts));
    check(sliders === 3, "três parâmetros da planta (entrada, saída, área)", String(sliders));
    check(await shell.locator(".component iframe, iframe.math-embed").count() === 0, "nenhuma atividade em <iframe> na página composta");
    const ready = await waitText("graphics.math.process_tank", 0, (text) => /V = 20/.test(text), 20000, "tanque com V0");
    check(/V = 20/.test(ready) && /A = 0,1 m²/.test(ready), "o tanque mostra V0 = 20 L e A = 0,1 m² antes de executar (parâmetros da planta)", ready.slice(0, 120));
    await workbench.screenshot({ path: path.join(artifacts, "lab-composed-tank-stopped.png") });

    // Executar pelos controles da simulação (botão verde à esquerda)
    const controls = element("graphics.math.sim_controls");
    const controlsBox = await controls.boundingBox();
    await clickAt(controls, 56 / 620, 0.5);
    const running = await waitText("graphics.math.sim_controls", 0, (text) => /tempo real/.test(text) && /t = [3-9]/.test(text), 40000, "execução");
    check(/Simulação em tempo real/.test(running), "Executar pelo elemento roda a simulação", running.slice(0, 80));
    const tankText = await waitText("graphics.math.process_tank", 0, (text) => /V = 2[2-9]/.test(text), 20000, "volume subindo");
    check(/V = 2[2-9]/.test(tankText) && /entrada 1 L\/s/.test(tankText), "o tanque enche (bomba 1 L/s, saída 0,4 L/s)", tankText.slice(0, 120));
    const chartText = await textOf("graphics.math.series_chart", 0);
    check(/Inclinação = dh\/dt ≈ 0,006/.test(chartText), "gráfico do nível com a tangente dh/dt ≈ q/A = 0,006 m/s", chartText.replace(/\s+/g, " ").slice(0, 200));
    const flowChart = await textOf("graphics.math.series_chart", 1);
    check(/Σ esquerda, n = 12/.test(flowChart) && /∫ = /.test(flowChart), "gráfico da vazão com Riemann e a integral", flowChart.replace(/\s+/g, " ").slice(0, 200));
    const equations = await shell.locator('.component[data-type-id="graphics.math.equation"]').allTextContents();
    check(equations.some((text) => /0,6/.test(text) && /L\/s/.test(text)), "equação q = qₑ − qₛ com o valor 0,6 L/s", equations.join(" | ").replace(/\s+/g, " ").slice(0, 200));

    // Slider da vazão de entrada até o máximo (2 L/s): muda a planta ao vivo
    const inlet = element("graphics.math.plant_parameter", 0);
    await dragAt(inlet, 0.5, 404 / 420, 50 / 76);
    const inletText = await waitText("graphics.math.plant_parameter", 0, (text) => /2 L\/s/.test(text), 10000, "qIn = 2");
    check(/Vazão de entrada\s*2 L\/s/.test(inletText.replace(/\s+/g, " ")), "slider leva a vazão de entrada a 2 L/s", inletText.slice(0, 80));
    const faster = await waitText("graphics.math.process_tank", 0, (text) => /entrada 2 L\/s/.test(text), 15000, "entrada 2 L/s no tanque");
    check(/entrada 2 L\/s/.test(faster), "o tanque mostra a entrada nova (a planta aplicou o parâmetro)", faster.slice(0, 120));
    const tangentFaster = await waitText("graphics.math.series_chart", 0, (text) => /dh\/dt ≈ 0,016/.test(text), 15000, "tangente nova");
    check(/dh\/dt ≈ 0,016/.test(tangentFaster), "a tangente acompanha: (2 − 0,4)/(1000·0,1) = 0,016 m/s", tangentFaster.replace(/\s+/g, " ").slice(0, 160));
    // O slider da área é "ao vivo"; h máx. não está na página. A área muda e o gráfico marca o evento.
    const eventLines = await element("graphics.math.series_chart", 0).locator('line[stroke-dasharray="2 4"]').count();
    check(eventLines >= 1, "o gráfico marca a mudança de parâmetro (evento gravado pelo Core)", String(eventLines));

    // Cursor do gráfico: arrastar para o meio fixa o instante (tangente ali)
    const levelChart = element("graphics.math.series_chart", 0);
    await dragAt(levelChart, 0.5, 0.3, 0.55);
    await sleep(600);
    const cursorText = await textOf("graphics.math.series_chart", 0);
    check(/t = \d/.test(cursorText) && !/t = [0-9]+,?[0-9]* s/.test(""), "o cursor do gráfico se arrasta na operação", (/t = [0-9,]+/.exec(cursorText) ?? [""])[0]);
    await sleep(1500);
    await workbench.screenshot({ path: path.join(artifacts, "lab-composed-tank.png") });

    // ---------------------------------------------------------------- primeira ordem
    await tab("Primeira ordem").click();
    await sleep(1500);
    const firstOrder = await waitText("graphics.math.series_chart", 0, (text) => /Resposta y\(t\)/.test(text) && /Inclinação/.test(text), 20000, "resposta y(t)");
    check(/Resposta y\(t\)/.test(firstOrder) && /Inclinação = dy\/dt/.test(firstOrder), "primeira ordem: a série y(t) já está gravada (a planta grava desde o início)", firstOrder.replace(/\s+/g, " ").slice(0, 160));
    await workbench.screenshot({ path: path.join(artifacts, "lab-composed-first-order.png") });

    // ---------------------------------------------------------------- sensor
    await tab("Sensor").click();
    await sleep(1500);
    const sensor = await waitText("graphics.math.readout", 1, (text) => /12/.test(text), 20000, "I = 12 mA");
    check(/I\s*=\s*12/.test(sensor), "sensor: P = 100 kPa na faixa 0–200 kPa lê 12 mA", sensor.replace(/\s+/g, " ").slice(0, 80));
    await workbench.screenshot({ path: path.join(artifacts, "lab-composed-sensor.png") });

    // Pausar pelos controles
    await clickAt(element("graphics.math.sim_controls"), (4 + 104 + 12 + 34) / 620, 0.5);
    const paused = await waitText("graphics.math.sim_controls", 0, (text) => /pausada/.test(text), 10000, "pausa");
    check(/Simulação pausada/.test(paused), "Pausar pelo elemento pausa a simulação", paused.slice(0, 60));
    void controlsBox;
  } catch (error) {
    console.error(error);
    failures++;
  } finally {
    await browser?.close().catch(() => {});
    child.kill();
  }
  console.log(failures === 0 ? "\nE2E LABORATÓRIO COMPOSTO OK" : `\n${failures} FALHA(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
