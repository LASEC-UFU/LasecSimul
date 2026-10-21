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
    throw new Error(`${name}: dimensão ${actual.width}x${actual.height}, esperado ${expected.width}x${expected.height}`);
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

async function clickSvgAt(locator, x, y) {
  await locator.evaluate((element, point) => {
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: rect.left + point.x * rect.width / 640, clientY: rect.top + point.y * rect.height / 330 }));
  }, { x, y });
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
    if (!workbench) throw new Error("VS Code de teste não criou uma página de workbench");
    await workbench.locator(".monaco-workbench").waitFor({ state: "visible", timeout: 60000 });
    await workbench.screenshot({ path: path.join(artifacts, "workbench.png") });
    await workbench.setViewportSize({ width: 1440, height: 1000 });
    const activity = workbench.locator('.activitybar [aria-label*="LasecSimul"], .activitybar [title*="LasecSimul"]').first();
    await activity.waitFor({ state: "visible", timeout: 30000 });
    await activity.click(); // ativa a extensão; o modo E2E abre a fixture pelo pipeline real

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

    // A antiga aba Processo não existe mais: PLC, protocolos e ferramentas moram em Controle.
    if (await paletteFrame.getByRole("tab", { name: /^(Processo|Process)$/ }).count()) throw new Error("a aba Processo não deveria mais existir");
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
      // O título é "typeId\ncaminho\ndica": o `\a ` (quebra de linha em CSS) exige o typeId INTEIRO,
      // senão `subcircuits.control.pid` também casaria com outro typeId que comece igual.
      await paletteFrame.locator(`.palette-item[title^="${typeId}\\a "]`).waitFor({ state: "attached", timeout: 30000 });
    }
    // Plantas não são registradas globalmente: nenhuma aparece na paleta (cada projeto traz a sua).
    for (const typeId of ["subcircuits.process.fopdt", "subcircuits.tdps.basic_flow_loop", "subcircuits.tdps.boiler", "subcircuits.process.hydraulic_tank"]) {
      if (await paletteFrame.locator(`.palette-item[title^="${typeId}\\a "]`).count()) throw new Error(`a planta ${typeId} não deveria estar na paleta`);
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

    // A paleta é reconstruída quando o catálogo chega de novo (ex.: Core terminando de subir); se
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
    if (actionIndex < 0) {
      throw new Error("Projeto de Controladores deve aparecer na pasta Ferramentas");
    }
    const designerAction = paletteFrame.locator('.palette-item[data-type-id="action.controlDesigner"]');
    const clickDesignerAction = async () => {
      let currentPalette;
      for (let attempt = 0; attempt < 40 && !currentPalette; attempt++) {
        for (const frame of workbench.frames()) {
          if (frame === workbench.mainFrame()) continue;
          try { if (await frame.locator(".palette-tabs").count()) { currentPalette = frame; break; } }
          catch { /* VS Code can replace a palette frame while its view is refreshed. */ }
        }
        if (!currentPalette) await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (!currentPalette) throw new Error("component palette webview was not available for the Control Designer action");
      const controlTab = currentPalette.getByRole("tab", { name: /^(Controle|Control)$/ }).first();
      if (await controlTab.count()) await controlTab.evaluate(tab => tab.click());
      await currentPalette.evaluate(() => {
        for (const folder of Array.from(document.querySelectorAll("details.palette-folder"))) folder.open = true;
      });
      const currentAction = currentPalette.locator('.palette-item[data-type-id="action.controlDesigner"]');
      await currentAction.waitFor({ state: "visible", timeout: 10000 });
      await domClick(currentAction);
    };
    await designerAction.waitFor({ state: "visible" });
    if ((await designerAction.innerText()).includes("pino")) throw new Error("a ação da ferramenta não deve indicar pinos");
    await clickDesignerAction();
    let designerFrame;
    for (let attempt = 0; attempt < 100 && !designerFrame; attempt++) {
      for (const frame of workbench.frames()) {
        if (frame === workbench.mainFrame()) continue;
        try { if (await frame.locator("#gain").count()) { designerFrame = frame; break; } }
        catch { /* O iframe pode ser substituído enquanto o editor inicia. */ }
      }
      if (!designerFrame) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!designerFrame) throw new Error("o botão da paleta não abriu o Projeto de Controladores");
    if (!(await designerFrame.locator("h1").innerText()).includes("SisoTools")) throw new Error("SisoTools heading is missing");
    const designerEncoding = await designerFrame.evaluate(() => ({ charset: document.characterSet, lang: document.documentElement.lang }));
    if (designerEncoding.charset.toUpperCase() !== "UTF-8" || designerEncoding.lang !== "pt-BR") throw new Error(`SisoTools webview encoding is incorrect: ${JSON.stringify(designerEncoding)}`);
    const designerHeaderText=await designerFrame.locator("header").innerText(),designerToolbarText=await designerFrame.locator(".toolbar").innerText();
    if(!designerHeaderText.includes("M\u00e9todo de discretiza\u00e7\u00e3o")||!designerToolbarText.includes("Unidade de frequ\u00eancia")||!designerToolbarText.includes("Exibi\u00e7\u00e3o")||!designerToolbarText.includes("Certificar an\u00e1lises")||/M\u00c3|frequ\u00c3|Exibi\u00c3/.test(designerHeaderText+designerToolbarText))throw new Error(`SisoTools toolbar text is not correctly UTF-8 decoded: ${designerHeaderText} ${designerToolbarText}`);
    await designerFrame.locator("#conversionMethod").evaluate(select=>{select.labels[0].firstChild.textContent="MÃ©todo de discretizaÃ§Ã£o ";});
    await designerFrame.waitForFunction(()=>document.querySelector("#conversionMethod")?.labels[0]?.textContent?.includes("Método de discretização"));
    if(!designerToolbarText.includes("Unidade de fase")||!designerToolbarText.includes("Envolver fase em")||!designerToolbarText.includes("Exibir magnitude acima")||!designerToolbarText.includes("Grade dos plots"))throw new Error("SisoTools frequency-response preferences are missing");
    await designerFrame.locator("#timeUnit").selectOption("seconds");
    await designerFrame.waitForFunction(()=>Array.from(document.querySelectorAll("#time text")).some(node=>node.textContent==="tempo (s)"));
    await designerFrame.locator("#timeUnit").selectOption("milliseconds");
    await designerFrame.waitForFunction(()=>Array.from(document.querySelectorAll("#time text")).some(node=>node.textContent==="tempo (ms)"));
    await designerFrame.locator("#frequencyUnit").selectOption("cycles/hour");
    await designerFrame.waitForFunction(()=>Array.from(document.querySelectorAll("#bode text")).some(node=>node.textContent==="frequency (cycles/h)"));
    await designerFrame.locator("#frequencyUnit").selectOption("auto");
    await designerFrame.waitForFunction(()=>Array.from(document.querySelectorAll("#bode text")).some(node=>node.textContent==="frequency (rad/ms)"));
    await designerFrame.locator("#frequencyUnit").selectOption("rad/s");
    await designerFrame.locator("#timeUnit").selectOption("seconds");
    await designerFrame.waitForFunction(()=>Array.from(document.querySelectorAll("#time text")).some(node=>node.textContent==="tempo (s)"));
    await designerFrame.locator("#phaseUnit").selectOption("rad");
    await designerFrame.waitForFunction(()=>Array.from(document.querySelectorAll("#nichols text")).some(node=>/[0-9]\.\d/.test(node.textContent??"")));
    const radianTicks=await designerFrame.locator("#nichols text").allTextContents();
    if(!radianTicks.includes("-3.142"))throw new Error(`Nichols phase axis did not switch to radians: ${radianTicks.join(", ")}`);
    await designerFrame.locator("#phaseUnit").selectOption("deg");
    await designerFrame.waitForFunction(()=>Array.from(document.querySelectorAll("#nichols text")).some(node=>node.textContent==="-180"));
    const nicholsBeforeWrap=await designerFrame.locator("#nichols polyline").first().getAttribute("points");
    const minimumNicholsX=(points)=>Math.min(...(points||"").trim().split(/\s+/).map(point=>Number(point.split(",")[0])).filter(Number.isFinite));
    await designerFrame.locator("#phaseWrapAt").fill("0");await designerFrame.locator("#phaseWrapAt").dispatchEvent("change");
    await designerFrame.waitForFunction(()=>Array.from(document.querySelectorAll("#nichols text")).some(node=>node.textContent==="360"));
    const nicholsWrapped=await designerFrame.locator("#nichols polyline").first().getAttribute("points");
    if(!(minimumNicholsX(nicholsWrapped)>minimumNicholsX(nicholsBeforeWrap)+100))throw new Error("Nichols curve did not move into the selected [0, 360) phase interval");
    await designerFrame.locator("#phaseWrapAt").fill("-180");await designerFrame.locator("#phaseWrapAt").dispatchEvent("change");
    await designerFrame.locator("#minimumMagnitudeDb").fill("0");await designerFrame.locator("#minimumMagnitudeDb").dispatchEvent("change");
    await designerFrame.waitForFunction(()=>Array.from(document.querySelectorAll("#bode polyline")).some(line=>(line.getAttribute("points")||"").split(/\s+/).some(point=>Number(point.split(",")[1])===135)));
    await designerFrame.locator("#minimumMagnitudeDb").fill("");await designerFrame.locator("#minimumMagnitudeDb").dispatchEvent("change");
    const plotGrid=designerFrame.locator("#plotGridPreference"),gridLines=()=>designerFrame.locator('#bode [data-plot-grid="true"]').count();if(await gridLines()<1)throw new Error("Bode did not start with the global plot grid enabled");await plotGrid.uncheck();await plotGrid.dispatchEvent("change");await designerFrame.waitForFunction(()=>document.querySelectorAll('#bode [data-plot-grid="true"]').length===0);await plotGrid.check();await plotGrid.dispatchEvent("change");await designerFrame.waitForFunction(()=>document.querySelectorAll('#bode [data-plot-grid="true"]').length>0);
     await designerFrame.locator("#plotFontSize").fill("14");await designerFrame.locator("#plotFontSize").dispatchEvent("change");await designerFrame.locator("#plotFontBold").check();await designerFrame.locator("#plotFontBold").dispatchEvent("change");await designerFrame.locator("#plotFontItalic").check();await designerFrame.locator("#plotFontItalic").dispatchEvent("change");await designerFrame.locator("#plotAxesColorEnabled").check();await designerFrame.locator("#plotAxesColorEnabled").dispatchEvent("change");await designerFrame.locator("#plotAxesColor").evaluate(input=>{input.value="#09ff09";input.dispatchEvent(new Event("change",{bubbles:true}))});const plotStyle=await designerFrame.locator("#bode text").first().evaluate(element=>({size:getComputedStyle(element).fontSize,weight:getComputedStyle(element).fontWeight,style:getComputedStyle(element).fontStyle,color:getComputedStyle(element).fill,gridColor:getComputedStyle(document.querySelectorAll("#bode [data-plot-grid]")[0]).stroke}));if(plotStyle.size!=="14px"||plotStyle.weight!=="700"||plotStyle.style!=="italic"||plotStyle.color!=="rgb(9, 255, 9)"||plotStyle.gridColor!=="rgb(9, 255, 9)")throw new Error(`global plot style preferences were not applied: ${JSON.stringify(plotStyle)}`);await designerFrame.locator("#plotFontSize").fill("10");await designerFrame.locator("#plotFontSize").dispatchEvent("change");await designerFrame.locator("#plotFontBold").uncheck();await designerFrame.locator("#plotFontBold").dispatchEvent("change");await designerFrame.locator("#plotFontItalic").uncheck();await designerFrame.locator("#plotFontItalic").dispatchEvent("change");await designerFrame.locator("#plotAxesColorEnabled").uncheck();await designerFrame.locator("#plotAxesColorEnabled").dispatchEvent("change");
    const frdFrequency=Array.from({length:24},(_,i)=>.05*10**(i*2/23)),frdResponse=frdFrequency.map(omega=>[6/(4+omega*omega),-3*omega/(4+omega*omega)]);
    await designerFrame.locator("#modelForm").evaluate(select=>{select.closest("details").open=true;});
    await designerFrame.locator("#modelForm").selectOption("frd");
    await designerFrame.locator("#frdOrder").fill("1");
    await designerFrame.locator("#modelData").fill(JSON.stringify({frequency:frdFrequency,response:frdResponse,frequencyUnit:"rad/s"}));
    await designerFrame.locator("#applyModel").scrollIntoViewIfNeeded();
    await designerFrame.locator("#applyModel").click();
    await designerFrame.waitForFunction(()=>!document.querySelector("#frdFitStatus")?.hidden&&document.querySelector("#frdFitStatus")?.textContent?.includes("Ajuste FRD de ordem 1"));
    const frdStatus=await designerFrame.locator("#frdFitStatus").innerText();
    if(!frdStatus.includes("erro RMS relativo"))throw new Error(`FRD fit quality was not reported: ${frdStatus}`);
    const frdProjectStatus=await designerFrame.locator("#frdProjectStatus").innerText();
    if(!frdProjectStatus.includes("FRD medido ativo em frequência")||!frdProjectStatus.includes("respostas temporais e polos usam a aproximação racional"))throw new Error(`FRD model provenance was not shown persistently: ${frdProjectStatus}`);
    const measuredBodeSamples=await designerFrame.locator("#bode circle[style*='pointer-events:all']").count();
    if(measuredBodeSamples!==frdFrequency.length)throw new Error(`open-loop Bode did not use the ${frdFrequency.length} measured FRD samples directly: ${measuredBodeSamples}`);
    const readFrdPoint=async()=>designerFrame.locator("#bode circle[style*='pointer-events:all']").first().evaluate(circle=>circle.querySelector("title")?.textContent??"");
    const parseFrdPoint=(title)=>{const magnitude=title.match(/\|G\|=([-+0-9.eE]+) dB/),phase=title.match(/fase=([-+0-9.eE]+)/);if(!magnitude||!phase)throw new Error("FRD point tooltip is missing magnitude or phase: "+title);return{magnitude:Number(magnitude[1]),phase:Number(phase[1])}};
    const frdPointBefore=parseFrdPoint(await readFrdPoint());
    await designerFrame.locator("#plantDelaySeconds").fill("0.12");
    await designerFrame.locator("#plantDelaySeconds").dispatchEvent("change");
    await designerFrame.waitForFunction(()=>document.querySelector("#frdProjectStatus")?.textContent?.includes("O atraso aplica fase exata"));
    const frdPointAfter=parseFrdPoint(await readFrdPoint()),expectedDelayPhase=-frdFrequency[0]*0.12*180/Math.PI;
    if(Math.abs(frdPointAfter.magnitude-frdPointBefore.magnitude)>0.001||Math.abs((frdPointAfter.phase-frdPointBefore.phase)-expectedDelayPhase)>0.003)throw new Error("FRD delay did not preserve magnitude and apply exact phase: "+JSON.stringify({before:frdPointBefore,after:frdPointAfter,expectedDelayPhase}));
    await designerFrame.locator("#plantDelaySeconds").fill("0");
    await designerFrame.locator("#plantDelaySeconds").dispatchEvent("change");
    const controllerBeforeFrdShape=await Promise.all([designerFrame.locator('[data-model="C"][data-part="num"]').inputValue(),designerFrame.locator('[data-model="C"][data-part="den"]').inputValue()]);
    await designerFrame.locator("#shapeTargetPanel summary").click();
    await designerFrame.locator("#shapeTargetMode").selectOption("frd");
    await designerFrame.locator("#shapeTargetFrd").fill("0.05, 20\n0.5, 0\n5, -20");
    await designerFrame.locator("#shapeTargetMin").fill("0.05");await designerFrame.locator("#shapeTargetMax").fill("5");
    await designerFrame.locator("#shapeTargetFit").click();
    await designerFrame.waitForFunction(()=>document.querySelector("#saved")?.textContent?.includes("planta FRD avaliada diretamente nas medições")||Boolean(document.querySelector("#error")?.textContent?.trim()),null,{timeout:15000});
    if(await designerFrame.locator("#error").textContent())throw new Error(`direct measured-FRD loop shaping failed: ${await designerFrame.locator("#error").textContent()}`);
    for(const [part,index] of [["num",0],["den",1]]){const field=designerFrame.locator(`[data-model="C"][data-part="${part}"]`);await field.fill(controllerBeforeFrdShape[index]);await field.dispatchEvent("change")}
    await designerFrame.locator("#shapeBandwidth").fill("1");await designerFrame.locator("#saved").evaluate(status=>{status.textContent="";});
    await designerFrame.locator("#shapeBandwidthFrdFit").click();
    await designerFrame.waitForFunction(()=>document.querySelector("#saved")?.textContent?.includes("planta FRD avaliada diretamente nas medições")||Boolean(document.querySelector("#error")?.textContent?.trim()),null,{timeout:15000});
    if(await designerFrame.locator("#error").textContent())throw new Error(`measured-FRD bandwidth shaping failed: ${await designerFrame.locator("#error").textContent()}`);
    for(const [part,index] of [["num",0],["den",1]]){const field=designerFrame.locator(`[data-model="C"][data-part="${part}"]`);await field.fill(controllerBeforeFrdShape[index]);await field.dispatchEvent("change")}
    await designerFrame.locator("#shapeTargetMode").selectOption("tf");
    const controllerBeforeFrdDerivative=await Promise.all([designerFrame.locator('[data-model="C"][data-part="num"]').inputValue(),designerFrame.locator('[data-model="C"][data-part="den"]').inputValue()]);
    await designerFrame.locator("#preset").selectOption("PID");
    await designerFrame.locator("#p0").fill("2");await designerFrame.locator("#p1").fill("1");await designerFrame.locator("#p2").fill("0.5");await designerFrame.locator("#p3").fill("10");
    await designerFrame.locator('#presetFields button:has-text("Aplicar controlador")').click();
    await designerFrame.locator("#derivativeOnMeasurement").check();
    const derivativeFrdPoint=parseFrdPoint(await readFrdPoint()),dw=frdFrequency[0],gDerivative={re:6/(4+dw*dw),im:-3*dw/(4+dw*dw)},dDen=100+dw*dw,dTerm={re:.5*10*dw*dw/dDen,im:.5*10*10*dw/dDen},cTerm={re:2+dTerm.re,im:-1/dw+dTerm.im},loopDerivative={re:gDerivative.re*cTerm.re-gDerivative.im*cTerm.im,im:gDerivative.re*cTerm.im+gDerivative.im*cTerm.re},expectedDerivativeMagnitude=20*Math.log10(Math.hypot(loopDerivative.re,loopDerivative.im)),expectedDerivativePhase=Math.atan2(loopDerivative.im,loopDerivative.re)*180/Math.PI;
    if(Math.abs(derivativeFrdPoint.magnitude-expectedDerivativeMagnitude)>0.006||Math.abs(derivativeFrdPoint.phase-expectedDerivativePhase)>0.006)throw new Error("FRD derivative-on-measurement loop did not match its independent complex formula: "+JSON.stringify({actual:derivativeFrdPoint,expected:{magnitude:expectedDerivativeMagnitude,phase:expectedDerivativePhase}}));
    await designerFrame.locator("#architecture").selectOption("nested-inner-feedback");
    await designerFrame.waitForFunction(()=>document.querySelector("#architecture")?.value==="nested-inner-feedback"&&document.querySelectorAll("#bode circle[style*=\"pointer-events:all\"]").length===24);
    const nestedDerivativePoint=parseFrdPoint(await readFrdPoint()),innerDen={re:1+gDerivative.re,im:gDerivative.im},innerDenMag=innerDen.re*innerDen.re+innerDen.im*innerDen.im,innerG={re:(gDerivative.re*innerDen.re+gDerivative.im*innerDen.im)/innerDenMag,im:(gDerivative.im*innerDen.re-gDerivative.re*innerDen.im)/innerDenMag},nestedDerivativeLoop={re:innerG.re*cTerm.re-innerG.im*cTerm.im,im:innerG.re*cTerm.im+innerG.im*cTerm.re},expectedNestedDerivative={magnitude:20*Math.log10(Math.hypot(nestedDerivativeLoop.re,nestedDerivativeLoop.im)),phase:Math.atan2(nestedDerivativeLoop.im,nestedDerivativeLoop.re)*180/Math.PI};
    if(Math.abs(nestedDerivativePoint.magnitude-expectedNestedDerivative.magnitude)>0.006||Math.abs(nestedDerivativePoint.phase-expectedNestedDerivative.phase)>0.006)throw new Error("Nested FRD derivative-on-measurement loop did not match the independent cascade formula: "+JSON.stringify({actual:nestedDerivativePoint,expected:expectedNestedDerivative}));
    await designerFrame.locator("#architecture").selectOption("forward-controller");
    await designerFrame.waitForFunction(()=>document.querySelector("#architecture")?.value==="forward-controller");
    await designerFrame.locator("#derivativeOnMeasurement").evaluate(el=>{const input=el;input.checked=false;input.dispatchEvent(new Event("change",{bubbles:true}))});
    await designerFrame.locator("#preset").selectOption("manual");
    await designerFrame.locator('[data-model="C"][data-part="num"]').fill(controllerBeforeFrdDerivative[0]);await designerFrame.locator('[data-model="C"][data-part="den"]').fill(controllerBeforeFrdDerivative[1]);
    await designerFrame.locator('[data-model="C"][data-part="num"]').dispatchEvent("change");await designerFrame.locator('[data-model="C"][data-part="den"]').dispatchEvent("change");
    await designerFrame.locator("#architecture").selectOption("feedback-controller");
    await designerFrame.waitForFunction(()=>document.querySelector("#architecture")?.value==="feedback-controller");
    const feedbackFrdSamples=await designerFrame.locator("#bode circle[style*='pointer-events:all']").count();
    if(feedbackFrdSamples!==frdFrequency.length)throw new Error(`feedback-architecture Bode did not use all ${frdFrequency.length} measured FRD samples: ${feedbackFrdSamples}`);
    await designerFrame.locator("#architecture").selectOption("nested-inner-feedback");
    await designerFrame.locator("#loopEditor").selectOption("inner");
    await designerFrame.waitForFunction(()=>document.querySelector("#architecture")?.value==="nested-inner-feedback"&&document.querySelector("#bodeTitle")?.textContent?.includes("malha interna"));
    const nestedFeedbackInnerFrdSamples=await designerFrame.locator('#bode circle[style*="pointer-events:all"]').count();
    if(nestedFeedbackInnerFrdSamples!==frdFrequency.length)throw new Error("nested feedback inner-loop FRD sample count mismatch: "+nestedFeedbackInnerFrdSamples);
    await designerFrame.locator("#loopEditor").selectOption("outer");
    const nestedFeedbackOuterFrdSamples=await designerFrame.locator('#bode circle[style*="pointer-events:all"]').count();
    if(nestedFeedbackOuterFrdSamples!==frdFrequency.length)throw new Error("nested feedback outer-loop FRD sample count mismatch: "+nestedFeedbackOuterFrdSamples);
    const nestedFeedbackTarget=await designerFrame.locator("#analysisFrequencyTarget").inputValue();
    await designerFrame.locator("#analysisFrequencyTarget").selectOption("output");
    const nestedFeedbackOutputSamples=await designerFrame.locator('#analysisBode circle[style*="pointer-events:all"]').count();
    if(nestedFeedbackOutputSamples!==frdFrequency.length)throw new Error("nested feedback closed-loop Y/R FRD sample count mismatch: "+nestedFeedbackOutputSamples);
    await designerFrame.locator("#analysisFrequencyTarget").selectOption(nestedFeedbackTarget);
    await designerFrame.locator("#architecture").selectOption("nested-inner-forward");
    await designerFrame.locator("#loopEditor").selectOption("inner");
    await designerFrame.waitForFunction(()=>document.querySelector("#architecture")?.value==="nested-inner-forward"&&document.querySelector("#bodeTitle")?.textContent?.includes("malha interna"));
    const nestedInnerFrdSamples=await designerFrame.locator("#bode circle[style*='pointer-events:all']").count();
    if(nestedInnerFrdSamples!==frdFrequency.length)throw new Error(`nested internal-loop Bode did not use all ${frdFrequency.length} measured FRD samples: ${nestedInnerFrdSamples}`);
    await designerFrame.locator("#loopEditor").selectOption("outer");
    await designerFrame.waitForFunction(()=>document.querySelector("#bodeTitle")?.textContent?.includes("malha externa"));
    const nestedOuterFrdSamples=await designerFrame.locator("#bode circle[style*='pointer-events:all']").count();
    if(nestedOuterFrdSamples!==frdFrequency.length)throw new Error(`nested external-loop Bode did not use all ${frdFrequency.length} measured FRD samples: ${nestedOuterFrdSamples}`);
    const originalAnalysisTarget=await designerFrame.locator("#analysisFrequencyTarget").inputValue();
    await designerFrame.locator("#analysisFrequencyTarget").selectOption("output");
    const nestedClosedFrdSamples=await designerFrame.locator("#analysisBode circle[style*='pointer-events:all']").count();
    if(nestedClosedFrdSamples!==frdFrequency.length)throw new Error(`nested closed-loop Y/R Bode did not use all ${frdFrequency.length} measured FRD samples: ${nestedClosedFrdSamples}`);
    await designerFrame.locator("#analysisFrequencyTarget").selectOption(originalAnalysisTarget);
    await designerFrame.locator("#architecture").selectOption("forward-controller");
    await designerFrame.waitForFunction(()=>document.querySelector("#architecture")?.value==="forward-controller");
    await designerFrame.locator("#architecture").selectOption("imc");
    await designerFrame.waitForFunction(()=>document.querySelector("#architecture")?.value==="imc"&&document.querySelector("#frdProjectStatus")?.textContent?.includes("s\u00edntese IMC"));
    const imcLoopFrdSamples=await designerFrame.locator('#bode circle[style*="pointer-events:all"]').count();
    if(imcLoopFrdSamples!==frdFrequency.length)throw new Error("IMC open-loop Bode sample count mismatch: "+imcLoopFrdSamples);
    const imcLoopFirstTooltip=await designerFrame.locator('#bode circle[style*="pointer-events:all"] title').first().textContent();
    const imcLoopExpectedReal=4*(frdResponse[0][0]-1),imcLoopExpectedImag=4*frdResponse[0][1],imcLoopExpectedDb=20*Math.log10(Math.hypot(imcLoopExpectedReal,imcLoopExpectedImag)),imcLoopReportedDb=Number(/\|G\|=([-+0-9.eE]+) dB/.exec(imcLoopFirstTooltip)?.[1]);
    if(!Number.isFinite(imcLoopReportedDb)||Math.abs(imcLoopReportedDb-imcLoopExpectedDb)>1e-3)throw new Error("IMC measured open-loop response did not use the FRD equations: "+imcLoopFirstTooltip);
    await designerFrame.locator("#analysisFrequencyTarget").selectOption("output");
    const imcClosedFrdSamples=await designerFrame.locator('#analysisBode circle[style*="pointer-events:all"]').count();
    if(imcClosedFrdSamples!==frdFrequency.length)throw new Error("IMC closed-loop Y/R Bode sample count mismatch: "+imcClosedFrdSamples);
    const imcClosedFirstTooltip=await designerFrame.locator('#analysisBode circle[style*="pointer-events:all"] title').first().textContent();
    const imcDenReal=1+imcLoopExpectedReal,imcDenImag=imcLoopExpectedImag,imcYReal=(4*frdResponse[0][0]*imcDenReal+4*frdResponse[0][1]*imcDenImag)/(imcDenReal*imcDenReal+imcDenImag*imcDenImag),imcYImag=(4*frdResponse[0][1]*imcDenReal-4*frdResponse[0][0]*imcDenImag)/(imcDenReal*imcDenReal+imcDenImag*imcDenImag),imcYExpectedDb=20*Math.log10(Math.hypot(imcYReal,imcYImag)),imcYReportedDb=Number(/\|G\|=([-+0-9.eE]+) dB/.exec(imcClosedFirstTooltip)?.[1]);
    if(!Number.isFinite(imcYReportedDb)||Math.abs(imcYReportedDb-imcYExpectedDb)>1e-3)throw new Error("IMC closed-loop Y/R did not use the measured FRD response: "+imcClosedFirstTooltip);
    await designerFrame.locator("#analysisFrequencyTarget").selectOption(originalAnalysisTarget);
    await designerFrame.locator("#architecture").selectOption("forward-controller");
    await designerFrame.waitForFunction(()=>document.querySelector("#architecture")?.value==="forward-controller");
    const frdOriginalController={num:await designerFrame.locator('[data-model="C"][data-part="num"]').inputValue(),den:await designerFrame.locator('[data-model="C"][data-part="den"]').inputValue()};
    await designerFrame.locator("#preset").selectOption("PID");
    await designerFrame.locator("#p0").fill("2");await designerFrame.locator("#p1").fill("0.7");await designerFrame.locator("#p2").fill("0.2");await designerFrame.locator("#p3").fill("10");
    await designerFrame.getByRole("button",{name:"Aplicar controlador"}).click();
    await designerFrame.locator("#pidTwoDofEnabled").check();await designerFrame.locator("#pidTwoDofB").fill("0.5");await designerFrame.locator("#pidTwoDofC").fill("0.25");
    const twoDofOriginalTarget=await designerFrame.locator("#analysisFrequencyTarget").inputValue();await designerFrame.locator("#analysisFrequencyTarget").selectOption("output");
    const twoDofFrdSamples=await designerFrame.locator('#analysisBode circle[style*="pointer-events:all"]').count();if(twoDofFrdSamples!==frdFrequency.length)throw new Error("2DOF closed-loop Y/R did not use all measured FRD samples: "+twoDofFrdSamples);
    const twoDofTooltip=await designerFrame.locator('#analysisBode circle[style*="pointer-events:all"] title').first().textContent(),twoDofOmega=frdFrequency[0],twoDofSettings=await designerFrame.evaluate(()=>{const model=key=>Object.fromEntries(["num","den"].map(part=>[part,document.querySelector(`[data-model="${key}"][data-part="${part}"]`).value.split(",").map(Number)]));return{F:model("F"),C:model("C"),H:model("H"),kp:Number(document.querySelector("#p0").value),ki:Number(document.querySelector("#p1").value),kd:Number(document.querySelector("#p2").value),N:Number(document.querySelector("#p3").value),b:Number(document.querySelector("#pidTwoDofB").value),c:Number(document.querySelector("#pidTwoDofC").value)}});
    const twoDofAdd=(a,b)=>({re:a.re+b.re,im:a.im+b.im}),twoDofMul=(a,b)=>({re:a.re*b.re-a.im*b.im,im:a.re*b.im+a.im*b.re}),twoDofDiv=(a,b)=>({re:(a.re*b.re+a.im*b.im)/(b.re*b.re+b.im*b.im),im:(a.im*b.re-a.re*b.im)/(b.re*b.re+b.im*b.im)}),twoDofAt=(model,w)=>{const poly=values=>values.reduce((result,value)=>twoDofAdd(twoDofMul(result,{re:0,im:w}),{re:value,im:0}),{re:0,im:0});return twoDofDiv(poly(model.num),poly(model.den))};
    const twoDofPID=(kp,ki,kd,N)=>({num:[kp+kd*N,kp*N+ki,ki*N],den:[1,N,0]}),twoDofFeedback=twoDofAt(twoDofSettings.C,twoDofOmega),twoDofReference=twoDofAt(twoDofPID(twoDofSettings.kp*twoDofSettings.b,twoDofSettings.ki,twoDofSettings.kd*twoDofSettings.c,twoDofSettings.N),twoDofOmega),twoDofPlant={re:frdResponse[0][0],im:frdResponse[0][1]},twoDofSensor=twoDofAt(twoDofSettings.H,twoDofOmega),twoDofPrefilterResponse=twoDofAt(twoDofSettings.F,twoDofOmega),twoDofLoop=twoDofMul(twoDofMul(twoDofFeedback,twoDofPlant),twoDofSensor),twoDofExpected=twoDofDiv(twoDofMul(twoDofMul(twoDofPrefilterResponse,twoDofReference),twoDofPlant),{re:1+twoDofLoop.re,im:twoDofLoop.im}),twoDofExpectedDb=20*Math.log10(Math.hypot(twoDofExpected.re,twoDofExpected.im)),twoDofReportedDb=Number(/\|G\|=([-+0-9.eE]+) dB/.exec(twoDofTooltip)?.[1]);
    if(!Number.isFinite(twoDofReportedDb)||Math.abs(twoDofReportedDb-twoDofExpectedDb)>3e-3)throw new Error("2DOF measured FRD Y/R does not match reference and feedback channels: "+twoDofTooltip+" expected "+twoDofExpectedDb+" dB");
    await designerFrame.locator("#analysisFrequencyTarget").selectOption(twoDofOriginalTarget);await designerFrame.locator("#pidTwoDofEnabled").uncheck();
    await designerFrame.locator('[data-model="C"][data-part="num"]').fill(frdOriginalController.num);await designerFrame.locator('[data-model="C"][data-part="den"]').fill(frdOriginalController.den);
    const frdMatlabExportPromise=designerFrame.page().waitForEvent("download",{timeout:15000});
    await designerFrame.locator("#exportMatlab").click();
    const frdMatlabExport=await frdMatlabExportPromise,frdMatlabScript=fs.readFileSync(await frdMatlabExport.path(),"utf8");
    if(!frdMatlabScript.includes("FRDPlant = frd(complex(")||!frdMatlabScript.includes("'FrequencyUnit', 'rad/s'")||!frdMatlabScript.includes("controlSystemDesigner({'bode', 'nichols'}, FRDPlant, C, H, F);"))throw new Error("MATLAB export did not open Control System Designer with the measured FRD plant and current C/H/F");
    await designerFrame.locator("#modelForm").evaluate(select=>{select.closest("details").open=true;});
    await designerFrame.locator('[data-model="G"][data-part="num"]').fill("1");
    await designerFrame.locator('[data-model="G"][data-part="den"]').fill("1, 2, 0");
    await designerFrame.locator("#modelForm").selectOption("pz");
    if((await designerFrame.locator('[data-model="G"][data-part="den"]').inputValue())!=="1, 2, 0")throw new Error("FRD E2E cleanup did not restore the nominal plant");
    const directEquation=await designerFrame.locator("#architectureEquation").innerText();
    if(!directEquation.includes("F\u00b7r")||!directEquation.includes("H\u00b7y")||!directEquation.includes("G\u00b7u"))throw new Error(`direct architecture equation is malformed: ${directEquation}`);
    await designerFrame.locator("#dataBrowser").evaluate(details => { details.open = true; });
    await designerFrame.locator('#dataBrowser [data-browser-action="model:C"]').click();
    const browserFocus = await designerFrame.evaluate(() => ({ model: document.activeElement?.getAttribute("data-model"), part: document.activeElement?.getAttribute("data-part") }));
    if (browserFocus.model !== "C" || browserFocus.part !== "num") throw new Error(`Data Browser did not focus the selected compensator: ${JSON.stringify(browserFocus)}`);
    const matlabExportPromise = designerFrame.page().waitForEvent("download", { timeout: 15000 });
    await designerFrame.locator("#exportMatlab").click();
    const matlabExport = await matlabExportPromise;
    if (matlabExport.suggestedFilename() !== "projeto-controle-matlab.m") throw new Error("MATLAB export filename is incorrect");
    const matlabScript = fs.readFileSync(await matlabExport.path(), "utf8");
    if (!matlabScript.includes("C = tf(") || !matlabScript.includes("G = tf(") || !matlabScript.includes("s = sisoinit(1);") || !matlabScript.includes("controlSystemDesigner(s);")) throw new Error("MATLAB export does not contain the nominal plant, controller, and designer startup command");
    await designerFrame.locator("#plotManager summary").click();
    const locusOrderBefore = await designerFrame.locator("#rl").evaluate(svg => (svg.closest(".card")).style.order);
    await designerFrame.locator('#plotManager label:has-text("Lugar das raizes")').locator('xpath=..').locator('button[title="Mover para baixo"]').click();
    await designerFrame.waitForFunction(before => document.querySelector("#rl")?.closest(".card")?.style.order !== before, locusOrderBefore);
    const bodeVisibility = designerFrame.locator('#plotManager input[aria-label="Exibir Bode da malha"]');
    await bodeVisibility.uncheck();
    if (!(await designerFrame.locator("#bode").evaluate(svg => svg.closest(".card")?.hidden))) throw new Error("plot visibility manager did not hide the Bode editor");
    await bodeVisibility.check();
    if (await designerFrame.locator("#bode").evaluate(svg => svg.closest(".card")?.hidden)) throw new Error("plot visibility manager did not restore the Bode editor");
    await designerFrame.locator("#plotManager summary").click();
    for (const [architecture, configuration] of [["feedback-controller", 2], ["feedforward-disturbance", 3], ["nested-inner-feedback", 4], ["imc", 5], ["nested-inner-forward", 6]]) {
      await designerFrame.locator("#architecture").selectOption(architecture);
      if(configuration===4){const invalidSignals=await designerFrame.evaluate(()=>({prefilter:document.querySelectorAll('#architectureDiagram [data-analysis-input="point:prefilterOutput"]').length,innerSensor:document.querySelector('#analysisPlotInput option[value="point:innerSensorOutput"]')?.disabled,h2Block:document.querySelector('#models [data-model="H2"]')!==null,diagramHasH2:document.querySelector('#architectureDiagram')?.textContent?.includes("H2")}));if(invalidSignals.prefilter||invalidSignals.innerSensor!==true||invalidSignals.h2Block||invalidSignals.diagramHasH2)throw new Error(`configuration 4 exposed blocks or points that do not exist in the MATLAB architecture: ${JSON.stringify(invalidSignals)}`);}
      if(configuration===6){const equation=await designerFrame.locator("#architectureEquation").innerText(),prefilterWire=designerFrame.locator('#architectureDiagram line[data-analysis-input="point:prefilterOutput"]');if(!equation.includes("F"+String.fromCodePoint(183)+"r"))throw new Error(`configuration 6 equation mismatch: ${JSON.stringify({equation,selected:await designerFrame.locator("#architecture").inputValue(),error:await designerFrame.locator("#error").innerText()})}`);await prefilterWire.waitFor({state:"attached"});const geometry=await prefilterWire.evaluate(line=>({x1:Number(line.getAttribute("x1")),x2:Number(line.getAttribute("x2")),y1:Number(line.getAttribute("y1")),y2:Number(line.getAttribute("y2"))}));if(geometry.x1!==76||geometry.x2!==103||geometry.y1!==62||geometry.y2!==62)throw new Error(`configuration 6 F output analysis target is not aligned with its wire: ${JSON.stringify(geometry)}`);}
      const architectureExportPromise = designerFrame.page().waitForEvent("download", { timeout: 15000 });
      await designerFrame.locator("#exportMatlab").click();
      const architectureExport = await architectureExportPromise;
      const architectureScript = fs.readFileSync(await architectureExport.path(), "utf8");
      if (!architectureScript.includes(`s = sisoinit(${configuration});`) || !architectureScript.includes("controlSystemDesigner(s);")) throw new Error(`MATLAB export did not map ${architecture} to configuration ${configuration}`);
      if(configuration===4&&(!architectureScript.includes("s.C2.Value = C2;")||!architectureScript.includes("s.H.Value = H;")||architectureScript.includes("s.C2.Value = C2*H2")||architectureScript.includes("s.F.Value = F;")))throw new Error("configuration 4 MATLAB export does not match its C2 feedback architecture");
      const simulinkExportPromise=designerFrame.page().waitForEvent("download", { timeout: 15000 });
      await designerFrame.locator("#exportSimulink").click();
      const simulinkExport=await simulinkExportPromise;
      if(simulinkExport.suggestedFilename()!=="modelo-simulink.m")throw new Error("Simulink model export filename is incorrect");
      const simulinkScript=fs.readFileSync(await simulinkExport.path(),"utf8");
      if(!simulinkScript.includes(`% Arquitetura: ${architecture}`)||!simulinkScript.includes("save_system(mdl,[mdl '.slx'])")||!simulinkScript.includes("Simulink.BlockDiagram.arrangeSystem"))throw new Error(`Simulink export omitted ${architecture}`);
      if(configuration===6&&(!simulinkScript.includes("'r/1','F/1'")||!simulinkScript.includes("'F/1','Sum_outer/1'")))throw new Error("configuration 6 Simulink model omitted prefilter F from its reference path");
    }
    await designerFrame.locator("#architecture").selectOption("nested-inner-forward");
    const innerTestModels=await designerFrame.evaluate(()=>Object.fromEntries(["G","C2","H2"].flatMap(model=>["num","den"].map(part=>[`${model}_${part}`,document.querySelector(`[data-model="${model}"][data-part="${part}"]`)?.value]))));
    for(const [model,num,den] of [["G","1","1, 1"],["C2","1","1"],["H2","1","1"]]){const numerator=designerFrame.locator(`[data-model="${model}"][data-part="num"]`),denominator=designerFrame.locator(`[data-model="${model}"][data-part="den"]`);await numerator.fill(num);await denominator.fill(den);await denominator.dispatchEvent("change");await numerator.dispatchEvent("change");}
    await designerFrame.locator("#loopEditor").selectOption("inner");
    await designerFrame.locator("#shapeBandwidth").fill("2");
    await designerFrame.locator("#shapeBandwidthSynthesize").click();
    const innerBandwidthStatus=await designerFrame.locator("#error").innerText(),innerBandwidthController=await designerFrame.locator('[data-model="C2"][data-part="num"]').inputValue();
    const innerBandwidthDenominator=await designerFrame.locator('[data-model="C2"][data-part="den"]').inputValue();
    if(innerBandwidthStatus||innerBandwidthController!=="2, 2"||innerBandwidthDenominator!=="1, 0")throw new Error(`target-bandwidth synthesis did not produce C2=2(s+1)/s for G=1/(s+1): ${innerBandwidthStatus}; C2=${innerBandwidthController}/${innerBandwidthDenominator}`);
    for(const model of ["G","C2","H2"]){for(const part of ["num","den"]){const input=designerFrame.locator(`[data-model="${model}"][data-part="${part}"]`),value=innerTestModels[`${model}_${part}`];if(value!==undefined){await input.fill(value);await input.dispatchEvent("change");}}}
    await designerFrame.locator("#loopEditor").selectOption("outer");
    await designerFrame.locator("#architecture").selectOption("forward-controller");
    const plantVariantCountBefore = await designerFrame.locator('#plantVariants [data-plant-remove]').count();
    await designerFrame.locator("#plantVariantName").fill("E2E export multimodel");
    await designerFrame.locator("#savePlantVariant").click();
    if (await designerFrame.locator('#plantVariants [data-plant-remove]').count() !== plantVariantCountBefore + 1) throw new Error("could not prepare a plant variant for MATLAB array export");
    const plantVariantGrid = designerFrame.locator('#plantVariants [data-plant-frequency-grid]').last();
    await plantVariantGrid.fill("0.2, 2, 20");
    await plantVariantGrid.dispatchEvent("change");
    await designerFrame.locator("#architecture").selectOption("nested-inner-forward");
    const restoredPlantVariantGrid = await designerFrame.locator('#plantVariants [data-plant-frequency-grid]').last().inputValue();
    if (restoredPlantVariantGrid !== "0.2, 2, 20") throw new Error(`plant-variant Bode frequency grid did not survive architecture changes: ${restoredPlantVariantGrid}`);
    const arrayExportPromise = designerFrame.page().waitForEvent("download", { timeout: 15000 });
    await designerFrame.locator("#exportMatlab").click();
    const arrayExport = await arrayExportPromise;
    const arrayScript = fs.readFileSync(await arrayExport.path(), "utf8");
    if (!arrayScript.includes("Gmodels(:,:,2) = ss(Gv1);") || !arrayScript.includes("Hmodels(:,:,2) = ss(Hv1);") || !arrayScript.includes("H1models(:,:,2) = ss(H2);") || !arrayScript.includes("G2models(:,:,2)") || !arrayScript.includes("s.G1.Value = Gmodels;")) throw new Error("MATLAB array export did not preserve the plant/sensor variant in configuration 6");
    await designerFrame.locator("#architecture").selectOption("forward-controller");
    await designerFrame.locator("#compare").click();
    await designerFrame.waitForFunction(() => Array.from(document.querySelectorAll('#bode circle[data-custom-frequency]')).some(circle => Math.abs(Number(circle.getAttribute("data-custom-frequency")) - 2) < 1e-12));
    const variantGridMarkers = await designerFrame.locator('#bode circle[data-custom-frequency]').evaluateAll(circles => circles.map(circle => Number(circle.getAttribute("data-custom-frequency"))));
    if (![0.2, 2, 20].every(value => variantGridMarkers.some(marker => Math.abs(marker - value) < 1e-12))) throw new Error(`Bode comparison did not use the selected plant variant's custom grid: ${variantGridMarkers}`);
    await designerFrame.locator('#plantVariants [data-plant-remove]').last().click();
    const frequencyGrid = designerFrame.locator("#frequencyGrid");
    await frequencyGrid.fill("0.1, 1, 17");
    await frequencyGrid.dispatchEvent("change");
    await designerFrame.waitForFunction(() => document.querySelectorAll('#bode circle[fill="transparent"] title').length > 3);
    const nominalGrid = await designerFrame.locator('#bode circle[fill="transparent"] title').evaluateAll((titles) => titles.map((title) => title.textContent));
    if (nominalGrid.length <= 3) throw new Error("nominal model should retain its automatic frequency grid");
    const rootPreference = designerFrame.locator("#showPlantSensorRoots");
    if (await designerFrame.locator("#bode text title").count() === 0) throw new Error("Bode plot should show plant or sensor pole/zero markers by default");
    await rootPreference.uncheck();
    if (await designerFrame.locator("#bode text title").count() !== 0) throw new Error("Bode pole/zero preference did not hide plant and sensor markers");
    await rootPreference.check();
    if (await designerFrame.locator("#bode text title").count() === 0) throw new Error("Bode pole/zero preference did not restore markers");
    const plantDelay = designerFrame.locator("#plantDelaySeconds"), bodePhase = designerFrame.locator("#bode polyline").nth(1), phaseWithoutDelay = await bodePhase.getAttribute("points");
    await plantDelay.fill("0.2");
    await plantDelay.dispatchEvent("change");
    await designerFrame.waitForFunction((previous) => document.querySelectorAll("#bode polyline")[1]?.getAttribute("points") !== previous, phaseWithoutDelay);
    await plantDelay.fill("0");
    await plantDelay.dispatchEvent("change");
    await designerFrame.waitForFunction((previous) => document.querySelectorAll("#bode polyline")[1]?.getAttribute("points") === previous, phaseWithoutDelay);
    const plantNumField=designerFrame.locator('[data-model="G"][data-part="num"]'),plantDenField=designerFrame.locator('[data-model="G"][data-part="den"]'),controllerNumField=designerFrame.locator('[data-model="C"][data-part="num"]'),controllerDenField=designerFrame.locator('[data-model="C"][data-part="den"]');
    const oldPlantNum=await plantNumField.inputValue(),oldPlantDen=await plantDenField.inputValue(),oldControllerNum=await controllerNumField.inputValue(),oldControllerDen=await controllerDenField.inputValue();
    await plantNumField.fill("1");await plantDenField.fill("1, -1");await plantDenField.dispatchEvent("change");await plantNumField.dispatchEvent("change");
    await controllerNumField.fill("2");await controllerDenField.fill("1");await controllerDenField.dispatchEvent("change");await controllerNumField.dispatchEvent("change");
    await designerFrame.locator("#shapeTargetPanel summary").click();
    await designerFrame.locator("#shapeTargetNum").fill("2");await designerFrame.locator("#shapeTargetDen").fill("1, -1");await designerFrame.locator("#shapeTargetMin").fill("0.1");await designerFrame.locator("#shapeTargetMax").fill("10");
    await designerFrame.locator("#shapeTargetFit").click();
    await designerFrame.waitForFunction(()=>document.querySelector("#saved")?.textContent?.includes("Loop shape estrutura fixa"),null,{timeout:10000});
    if((await controllerNumField.inputValue())!=="2"||(await controllerDenField.inputValue())!=="1")throw new Error("fixed-structure loop shaping changed a controller that already stabilizes the unstable plant and exactly matches the target");
    await plantNumField.fill(oldPlantNum);await plantDenField.fill(oldPlantDen);await plantDenField.dispatchEvent("change");await plantNumField.dispatchEvent("change");
    await controllerNumField.fill(oldControllerNum);await controllerDenField.fill(oldControllerDen);await controllerDenField.dispatchEvent("change");await controllerNumField.dispatchEvent("change");
    await designerFrame.locator("#shapeTargetMode").selectOption("frd");
    await designerFrame.locator("#shapeTargetFrd").fill("0.1, 20\n1, 0\n10, -20");
    await designerFrame.locator("#shapeTargetMin").fill("0.1");await designerFrame.locator("#shapeTargetMax").fill("10");
    await designerFrame.locator("#shapeTargetFit").click();
    await designerFrame.waitForFunction(()=>document.querySelector("#saved")?.textContent?.includes("alvo FRD")||Boolean(document.querySelector("#error")?.textContent?.trim()),null,{timeout:15000});
    if(await designerFrame.locator("#error").textContent())throw new Error(`FRD target loop shaping failed: ${await designerFrame.locator("#error").textContent()}`);
    await designerFrame.locator("#shapeTargetMode").selectOption("tf");
    await plantNumField.fill("1");await plantDenField.fill("1, 3, 3, 1");await plantDenField.dispatchEvent("change");await plantNumField.dispatchEvent("change");
    await controllerNumField.fill("1");await controllerDenField.fill("1");await controllerDenField.dispatchEvent("change");await controllerNumField.dispatchEvent("change");
    await designerFrame.locator("#classicalPidMethod").selectOption("zn-frequency");
    await designerFrame.locator("#classicalPidKind").selectOption("P");
    await designerFrame.locator("#classicalPidTune").click();
    const classicalStatus=await designerFrame.locator("#classicalPidStatus").innerText(),classicalGain=Number(await designerFrame.locator("#p0").inputValue());
    if(!classicalStatus.includes("zn-frequency")||Math.abs(classicalGain-4)>0.08)throw new Error(`Ziegler-Nichols frequency tuning did not apply the analytic P gain 4: ${classicalStatus}, Kp=${classicalGain}`);
    await plantNumField.fill(oldPlantNum);await plantDenField.fill(oldPlantDen);await plantDenField.dispatchEvent("change");await plantNumField.dispatchEvent("change");
    await controllerNumField.fill(oldControllerNum);await controllerDenField.fill(oldControllerDen);await controllerDenField.dispatchEvent("change");await controllerNumField.dispatchEvent("change");
    const selectedPointWire=designerFrame.locator('#architectureDiagram [data-analysis-wire-targets] line[data-analysis-input="point:control"]').first();
    await selectedPointWire.click({force:true});
    await designerFrame.locator("#analysisPlotName").fill("E2E loop aberto no fio u");
    await designerFrame.locator("#analysisPlotType").selectOption("bode");
    await designerFrame.locator("#analysisPlotLoopOpening").selectOption("analysisPoint");
    await designerFrame.locator("#newAnalysisPlot").getByRole("button",{name:"Criar plot"}).click();
    const selectedPointPlot=designerFrame.locator("[data-analysis-plot-id]").filter({hasText:"E2E loop aberto no fio u"});
    await selectedPointPlot.waitFor({state:"visible",timeout:10000});
    if(!(await selectedPointPlot.innerText()).includes("ponto selecionado"))throw new Error("selected wire loop opening was not reflected in the generated response plot");
    await designerFrame.locator("#saveAlt").click();
    await designerFrame.locator("#altName").fill("E2E plot overlay");
    await designerFrame.locator("#dialogSave").click();
    const savedAlternativeNumerator=await controllerNumField.inputValue();
    await controllerNumField.fill("99");await controllerNumField.dispatchEvent("change");
    await designerFrame.locator("#exportDesign").selectOption("E2E plot overlay");
    const alternativeMatlabPromise=designerFrame.page().waitForEvent("download",{timeout:15000});await designerFrame.locator("#exportMatlab").click();const alternativeMatlabDownload=await alternativeMatlabPromise,alternativeMatlabScript=fs.readFileSync(await alternativeMatlabDownload.path(),"utf8");
    const savedNumeratorValues=savedAlternativeNumerator.split(/[\s,;]+/).filter(Boolean).map(Number),matlabNumerator=savedNumeratorValues.join(" "),simulinkNumerator=savedNumeratorValues.map(value=>value.toPrecision(15)).join(" ");if(alternativeMatlabDownload.suggestedFilename()!=="E2E-plot-overlay-matlab.m"||!alternativeMatlabScript.includes(`C = tf([${matlabNumerator}],`))throw new Error("MATLAB export did not use the selected saved design");
    const alternativeSimulinkPromise=designerFrame.page().waitForEvent("download",{timeout:15000});await designerFrame.locator("#exportSimulink").click();const alternativeSimulinkDownload=await alternativeSimulinkPromise,alternativeSimulinkScript=fs.readFileSync(await alternativeSimulinkDownload.path(),"utf8");if(alternativeSimulinkDownload.suggestedFilename()!=="E2E-plot-overlay-simulink.m"||!alternativeSimulinkScript.includes(`'Numerator','[${simulinkNumerator}]'`))throw new Error("Simulink export did not use the selected saved design");
    await controllerNumField.fill(savedAlternativeNumerator);await controllerNumField.dispatchEvent("change");
    await designerFrame.locator("#compare").click();
    await designerFrame.waitForFunction(() => { const card=Array.from(document.querySelectorAll("[data-analysis-plot-id]")).find(item=>item.textContent?.includes("E2E loop aberto no fio u"));const titles=Array.from(card?.querySelectorAll(".analysisPlotGraphs svg polyline title")??[]).map(title=>title.textContent??"");return titles.some(title=>title.includes("Ativo"))&&titles.some(title=>title.includes("E2E plot overlay"))&&card?.querySelectorAll('svg [data-response-characteristic="peak"]').length===2 },null,{timeout:10000});
    await designerFrame.locator("#newAnalysisPlot").evaluate(panel=>{panel.open=true});
    await designerFrame.locator("#analysisPlotMode").selectOption("standard");
    await designerFrame.locator("#analysisPlotPath").selectOption("output");
    await designerFrame.locator("#analysisPlotType").selectOption("step");
    await designerFrame.locator("#analysisPlotName").fill("E2E step requirement comparison");
    await designerFrame.locator("#newAnalysisPlot").getByRole("button",{name:"Criar plot"}).click();
    const stepRequirementComparison=designerFrame.locator("[data-analysis-plot-id]").filter({hasText:"E2E step requirement comparison"});
    await stepRequirementComparison.waitFor({state:"visible",timeout:10000});
    await stepRequirementComparison.locator("svg").first().click({button:"right",position:{x:100,y:80}});
    await stepRequirementComparison.getByRole("menuitem",{name:"Novo requisito para este plot"}).click();
    await designerFrame.locator("#designerDialog").waitFor({state:"visible"});
    await designerFrame.locator("#reqKind").selectOption("overshoot");
    await designerFrame.locator("#reqValue").fill("20");
    await designerFrame.locator("#dialogSave").click();
    const overshootHandle=stepRequirementComparison.locator('svg [data-req-drag="stepParameter"][data-parameter="overshoot"]').first(); await overshootHandle.waitFor({state:"visible",timeout:10000}); const overshootValueBefore=await designerFrame.locator("#requirements .req").last().innerText(); await dragSvgMark(overshootHandle,0,10); await designerFrame.waitForTimeout(300); const overshootValueAfter=await designerFrame.locator("#requirements .req").last().innerText(); if(overshootValueAfter===overshootValueBefore)throw new Error(`graphical overshoot requirement drag did not update the requirement: ${overshootValueAfter}`);
    const comparisonRequirementStatus=await stepRequirementComparison.locator('[aria-label="Estado dos requisitos por design"]').innerText();
    if(!comparisonRequirementStatus.includes("Ativo: overshoot")||!comparisonRequirementStatus.includes("E2E plot overlay: overshoot")||!/(met|violated)/.test(comparisonRequirementStatus))throw new Error(`comparison requirements were not evaluated independently for each design: ${comparisonRequirementStatus}`);
    await designerFrame.locator("#newAnalysisPlot").evaluate(panel=>{panel.open=true});
    await designerFrame.locator("#newAnalysisPlot").scrollIntoViewIfNeeded(); await designerFrame.locator("#analysisPlotType").selectOption("sigma");
    await designerFrame.locator("#analysisPlotName").fill("E2E sigma comparison overlay");
    await designerFrame.locator("#newAnalysisPlot").getByRole("button",{name:"Criar plot"}).click();
    const sigmaComparison=designerFrame.locator("[data-analysis-plot-id]").filter({hasText:"E2E sigma comparison overlay"});
    await sigmaComparison.waitFor({state:"visible",timeout:10000});
    await designerFrame.waitForFunction(() => { const card=Array.from(document.querySelectorAll("[data-analysis-plot-id]")).find(item=>item.textContent?.includes("E2E sigma comparison overlay"));const titles=Array.from(card?.querySelectorAll(".analysisPlotGraphs svg polyline title")??[]).map(title=>title.textContent??""),peaks=card?.querySelectorAll('.analysisPlotGraphs svg [data-response-characteristic="peak"]')??[];return titles.some(title=>title.includes("Ativo"))&&titles.some(title=>title.includes("E2E plot overlay"))&&peaks.length===2 },null,{timeout:10000});
    await designerFrame.locator("#newAnalysisPlot").evaluate(panel=>{panel.open=true});
    await designerFrame.locator("#analysisPlotType").selectOption("nichols");
    await designerFrame.locator("#analysisPlotName").fill("E2E Nichols comparison overlay");
    await designerFrame.locator("#newAnalysisPlot").getByRole("button",{name:"Criar plot"}).click();
    const nicholsComparison=designerFrame.locator("[data-analysis-plot-id]").filter({hasText:"E2E Nichols comparison overlay"});
    await nicholsComparison.waitFor({state:"visible",timeout:10000});
    await designerFrame.waitForFunction(() => { const card=Array.from(document.querySelectorAll("[data-analysis-plot-id]")).find(item=>item.textContent?.includes("E2E Nichols comparison overlay"));return card?.querySelectorAll('svg [data-response-characteristic="peak"]').length===2 },null,{timeout:10000});
    await nicholsComparison.getByRole("button",{name:"Remover plot E2E Nichols comparison overlay"}).click();
    await sigmaComparison.getByRole("button",{name:"Remover plot E2E sigma comparison overlay"}).click();
    await stepRequirementComparison.getByRole("button",{name:"Remover plot E2E step requirement comparison"}).click();
    await designerFrame.locator("#compareSelection summary").click();
    await designerFrame.locator('#compareSelection input[data-compare-key="alternative:E2E plot overlay"]').uncheck();
    await designerFrame.locator("#compareSelection summary").click();
    await selectedPointPlot.getByRole("button",{name:"Remover plot E2E loop aberto no fio u"}).click();
    const pointManager=designerFrame.locator("#analysisPointManager");
    await pointManager.locator("summary").click();
    await designerFrame.locator("#analysisPointMarkMode").click();
    await selectedPointWire.click({force:true,position:{x:12,y:0}});
    const pointStatus=designerFrame.locator("#analysisPointStatus");
    if(!/selecionado: point:control/.test(await pointStatus.innerText()))throw new Error(`wire click did not set a pending analysis point: ${await pointStatus.innerText()}`);
    await designerFrame.locator("#analysisPointName").fill("E2E Tap u nomeado");
    await designerFrame.locator("#analysisPointPurposeOutput").check();
    await designerFrame.locator("#addAnalysisPoint").click();
    const namedPoint=designerFrame.locator('#architectureDiagram [data-analysis-point-id]');
    await namedPoint.waitFor({state:"attached",timeout:10000});
    if(await namedPoint.getAttribute("aria-label")!=="Ponto de análise E2E Tap u nomeado")throw new Error("named analysis tap did not persist its label");
    await designerFrame.locator("#analysisPointList button[aria-label^=\"Usar como\"]").nth(1).click();
    if(await designerFrame.locator("#analysisPlotOutput").inputValue()!=="control")throw new Error("named analysis output did not select its output signal");
    await pointManager.getByRole("button",{name:"Remover ponto E2E Tap u nomeado"}).click();
    await designerFrame.locator("#analysisPointMarkMode").click();
    await designerFrame.locator('#architectureDiagram [data-analysis-port="true"][data-analysis-input="point:control"]').click({force:true});
    if(!(await pointStatus.innerText()).includes("Porta/sinal selecionado"))throw new Error(`port marker click did not set a pending analysis point: ${await pointStatus.innerText()}`);
    await designerFrame.locator("#analysisPointName").fill("E2E Porta u nomeada");
    await designerFrame.locator("#addAnalysisPoint").click();
    await designerFrame.locator('#architectureDiagram [data-analysis-point-id]').waitFor({state:"attached",timeout:10000});
    if(!(await designerFrame.locator("#analysisPointList").innerText()).includes("E2E Porta u nomeada"))throw new Error("named analysis point selected at a block port was not persisted");
    await pointManager.getByRole("button",{name:"Remover ponto E2E Porta u nomeada"}).click();
    await frequencyGrid.fill("");
    await frequencyGrid.fill("");
    await frequencyGrid.dispatchEvent("change");
    const architecture = designerFrame.locator("#architectureDiagram");
    const referenceDiagram = await architecture.evaluate((svg) => ({
      equation: document.querySelector("#architectureEquation")?.textContent?.replace(/\s+/g, " ").trim(),
      labels: Array.from(svg.querySelectorAll("text")).map((text) => text.textContent?.trim()),
      blocks: Object.fromEntries(["F", "C", "G", "H"].map((label) => {
        const text = Array.from(svg.querySelectorAll("text")).find((item) => item.textContent?.trim() === label);
        const box = text?.getBBox();
        return [label, box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : undefined];
      })),
    }));
    if (referenceDiagram.equation !== "e = F·r − H·y; u = C·e; y = G·u" || !["F", "Σ", "C", "G", "H"].every((label) => referenceDiagram.labels.includes(label)) || !(referenceDiagram.blocks.F.x < referenceDiagram.blocks.C.x && referenceDiagram.blocks.C.x < referenceDiagram.blocks.G.x && referenceDiagram.blocks.H.y > referenceDiagram.blocks.C.y)) throw new Error(`default architecture diagram differs from the documented F → sum → C → G feedback layout: ${JSON.stringify(referenceDiagram)}`);
    const fullFeedbackWires = await architecture.locator('[data-analysis-wire-targets] line').evaluateAll((lines) => lines.map((line) => [line.getAttribute("x1"), line.getAttribute("y1"), line.getAttribute("x2"), line.getAttribute("y2")]));
    if (!fullFeedbackWires.some((wire) => wire[0] === "400" && wire[1] === "62" && wire[2] === "400" && wire[3] === "116") || !fullFeedbackWires.some((wire) => wire[0] === "145" && wire[1] === "116" && wire[2] === "145" && wire[3] === "78")) throw new Error("arbitrary analysis injection targets do not cover the full default feedback wires");
    await architecture.screenshot({ path: path.join(artifacts, "control-designer-architecture.png") });
    const signsInsideSum = await architecture.evaluate((svg) => {
      const circle = svg.querySelector("circle");
      const signs = Array.from(svg.querySelectorAll("text")).filter((text) => ["+", String.fromCodePoint(8722)].includes(text.textContent || ""));
      if (!circle || signs.length !== 2) return { ok: false, reason: "missing signs/circle", circles: svg.querySelectorAll("circle").length, texts: Array.from(svg.querySelectorAll("text")).map((text) => text.textContent) };
      const bounds = circle.getBBox();
      const boxes = signs.map((sign) => { const box = sign.getBBox(); return { x: box.x, y: box.y, width: box.width, height: box.height }; });
      return { ok: boxes.every((box) => box.x >= bounds.x && box.y >= bounds.y && box.x + box.width <= bounds.x + bounds.width && box.y + box.height <= bounds.y + bounds.height), bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }, boxes };
    });
    if (!signsInsideSum.ok) throw new Error(`os sinais do somador saem do círculo: ${JSON.stringify(signsInsideSum)}`);
    const architectureChecks = [];
    for (const value of ["feedback-controller", "feedforward-disturbance", "nested-inner-feedback", "imc", "nested-inner-forward"]) {
      await designerFrame.locator("#architecture").selectOption(value);
      architectureChecks.push(await designerFrame.locator("#architectureDiagram").evaluate((svg, value) => {
        const circles = Array.from(svg.querySelectorAll("circle")).filter((circle) => Number(circle.getAttribute("r")) > 8);
        const signs = Array.from(svg.querySelectorAll("text")).filter((text) => ["+", String.fromCodePoint(8722)].includes(text.textContent || ""));
        const signsByCircle = circles.map(() => 0);
        const inside = signs.every((sign) => { const box = sign.getBBox(); const x = box.x + box.width / 2, y = box.y + box.height / 2; let best = -1, distance = Infinity; circles.forEach((circle, index) => { const dx = x - Number(circle.getAttribute("cx")), dy = y - Number(circle.getAttribute("cy")), candidate = Math.hypot(dx, dy); if (candidate < distance) { best = index; distance = candidate; } }); if (best < 0) return false; signsByCircle[best]++; return distance <= Number(circles[best].getAttribute("r")) + 1; });
        const expectedWire = value === "feedback-controller" ? ["400", "62", "400", "128"] : value === "feedforward-disturbance" ? ["335", "150", "335", "78"] : value.startsWith("nested-") ? ["430", "62", "430", "128"] : undefined;
        const lines = Array.from(svg.querySelectorAll('[data-analysis-wire-targets] line'));
        const hasWire = expectedWire ? lines.some((line) => ["x1", "y1", "x2", "y2"].every((key, index) => line.getAttribute(key) === expectedWire[index])) : lines.length > 0;
        return { value, circles: circles.length, signs: signs.length, fits: inside && signsByCircle.every((count) => count === 2), hasWire };
      }, value));
    }
    const restoreArchitecture = designerFrame.locator("#architecture");
    await restoreArchitecture.selectOption("forward-controller");
    await restoreArchitecture.selectOption("feedback-controller");
    const internalSignalState = await designerFrame.locator("#analysisPlotOutput").evaluate((select) => ({ architecture: document.querySelector("#architecture").value, errorDisabled: select.querySelector('option[value="error"]').disabled, openingDisabled: document.querySelector('#analysisPlotLoopOpening option[value="feedbackSensor"]').disabled, options: Array.from(select.options).map((option) => [option.value, option.disabled]) }));
    if (internalSignalState.errorDisabled) throw new Error(`feedback-controller must allow error signal plots: ${JSON.stringify(internalSignalState)}`);
    if (internalSignalState.openingDisabled) throw new Error("feedback-controller must allow opening its H*y feedback connection");
    await restoreArchitecture.selectOption("feedforward-disturbance");
    const feedforwardOpeningDisabled = await designerFrame.locator('#analysisPlotLoopOpening option[value="feedbackSensor"]').isDisabled();
    if (feedforwardOpeningDisabled) throw new Error("feedforward architecture must allow opening its H*y feedback connection for external inputs");
    await designerFrame.locator("#newAnalysisPlot").evaluate((panel) => { panel.open = true; });
    await designerFrame.locator("#analysisPlotMode").selectOption("inputOutput");
    await designerFrame.locator("#analysisPlotInput").selectOption(["reference", "plantInputDisturbance", "measurementNoise"]);
    await designerFrame.locator('#analysisPlotInputOrder [data-order-value="reference"] button[data-order-move="down"]').click();
    const selectedInputOrder = await designerFrame.locator('#analysisPlotInputOrder [data-order-value]').evaluateAll(rows => rows.map(row => row.getAttribute("data-order-value")));
    if (selectedInputOrder.join(",") !== "plantInputDisturbance,reference,measurementNoise") throw new Error(`selected input signals could not be reordered: ${selectedInputOrder.join(",")}`);
    await designerFrame.locator("#analysisPlotOutput").selectOption("output");
    await designerFrame.locator("#analysisPlotLoopOpening").selectOption("feedbackSensor");
    await designerFrame.locator("#analysisPlotSimultaneousInputs").check();
    await designerFrame.locator("#analysisPlotInputAmplitudes").fill("2, -0.5, 0.25");
    await designerFrame.locator("#analysisPlotName").fill("E2E feedforward external sources with H*y open");
    await designerFrame.locator("#newAnalysisPlot").getByRole("button", { name: "Criar plot" }).click();
    const feedforwardPlot = designerFrame.locator('[data-analysis-plot-id]').filter({ hasText: "E2E feedforward external sources with H*y open" });
    await feedforwardPlot.waitFor({ state: "visible" });
    const feedforwardPlotOutput = await feedforwardPlot.locator(".analysisPlotGraphs").innerText();
    if (/Error:|NaN|Transferencia inv/i.test(feedforwardPlotOutput) || await feedforwardPlot.locator(".analysisPlotGraphs svg").count() !== 1) throw new Error(`weighted simultaneous feedforward analysis failed: ${feedforwardPlotOutput}`);
    await feedforwardPlot.getByRole("button", { name: "Editar plot E2E feedforward external sources with H*y open" }).click();
    const savedInputAmplitudes = await designerFrame.locator("#analysisPlotInputAmplitudes").inputValue();
    if (savedInputAmplitudes !== "2, -0.5, 0.25") throw new Error(`simultaneous source amplitudes did not survive editing: ${savedInputAmplitudes}`);
    const restoredInputOrder = await designerFrame.locator('#analysisPlotInputOrder [data-order-value]').evaluateAll(rows => rows.map(row => row.getAttribute("data-order-value")));
    if (restoredInputOrder.join(",") !== "plantInputDisturbance,reference,measurementNoise") throw new Error(`saved simultaneous input order did not survive editing: ${restoredInputOrder.join(",")}`);
    await designerFrame.locator("#newAnalysisPlot").getByRole("button", { name: "Cancelar" }).click();
    await feedforwardPlot.getByRole("button", { name: "Remover plot E2E feedforward external sources with H*y open" }).click();
    await designerFrame.locator("#newAnalysisPlot").evaluate((panel) => { panel.open = true; });
    await designerFrame.locator("#analysisPlotMode").selectOption("standard");
    await restoreArchitecture.selectOption("nested-inner-feedback");
    await designerFrame.locator("#newAnalysisPlot").evaluate((panel) => { panel.open = true; });
    await designerFrame.locator("#analysisPlotMode").evaluate((select) => { select.value = "standard"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await designerFrame.locator("#loopEditor").selectOption("outer");
    for (const [path, label] of [["loop", "open outer loop"], ["sensitivity", "outer loop sensitivity"]]) {
      await designerFrame.locator("#analysisPlotPath").selectOption(path);
      await designerFrame.locator("#analysisPlotLoopOpening").selectOption("innerFeedbackSensor");
      await designerFrame.locator("#analysisPlotType").selectOption("bode");
      const name = `E2E ${label} with inner loop opened`;
      await designerFrame.locator("#analysisPlotName").fill(name);
      await designerFrame.locator("#newAnalysisPlot").getByRole("button", { name: "Criar plot" }).click();
      const responsePlot = designerFrame.locator("[data-analysis-plot-id]").filter({ hasText: name });
      await responsePlot.waitFor({ state: "visible" });
      const responseOutput = await responsePlot.locator(".analysisPlotGraphs").innerText();
      if (/Error:|NaN|Transferência inválida/i.test(responseOutput) || await responsePlot.locator(".analysisPlotGraphs svg").count() !== 1) throw new Error(`${label} response with additional loop opening failed: ${responseOutput}`);
      if (path === "loop") {
        await responsePlot.getByRole("button", { name: `Editar plot ${name}` }).click();
        const persistedOpening = await designerFrame.locator("#analysisPlotLoopOpening").inputValue();
        if (persistedOpening !== "innerFeedbackSensor") throw new Error(`saved open-loop response lost its loop opening: ${persistedOpening}`);
        await designerFrame.locator("#newAnalysisPlot").getByRole("button", { name: "Cancelar" }).click();
      }
      await responsePlot.getByRole("button", { name: `Remover plot ${name}` }).click();
      await designerFrame.locator("#newAnalysisPlot").evaluate((panel) => { panel.open = true; });
    }
    await designerFrame.locator("#loopEditor").selectOption("inner");
    for (const [path, label] of [["loop", "open inner loop"], ["sensitivity", "inner loop sensitivity"]]) {
      await designerFrame.locator("#analysisPlotPath").selectOption(path);
      await designerFrame.locator("#analysisPlotLoopOpening").selectOption("none");
      await designerFrame.locator("#analysisPlotName").fill(`E2E ${label}`);
      await designerFrame.locator("#newAnalysisPlot").getByRole("button", { name: "Criar plot" }).click();
      const responsePlot = designerFrame.locator("[data-analysis-plot-id]").filter({ hasText: `E2E ${label}` });
      await responsePlot.waitFor({ state: "visible" });
      const responseOutput = await responsePlot.locator(".analysisPlotGraphs").innerText();
      if (/Error:|NaN|Transferência inválida/i.test(responseOutput) || await responsePlot.locator(".analysisPlotGraphs svg").count() !== 1) throw new Error(`${label} response failed: ${responseOutput}`);
      await responsePlot.getByRole("button", { name: `Remover plot E2E ${label}` }).click();
      await designerFrame.locator("#newAnalysisPlot").evaluate((panel) => { panel.open = true; });
    }
    await designerFrame.locator("#analysisPlotType").selectOption("sigma");
    await designerFrame.locator("#analysisPlotName").fill("E2E singular value response");
    await designerFrame.locator("#newAnalysisPlot").getByRole("button", { name: "Criar plot" }).click();
    const sigmaPlot = designerFrame.locator('[data-analysis-plot-id]').filter({ hasText: "E2E singular value response" });
    await sigmaPlot.waitFor({ state: "visible" });
    if (await sigmaPlot.locator("svg polyline").count() !== 1 || await sigmaPlot.locator('svg [data-response-characteristic="peak"]').count() !== 1 || /Error:|NaN|Faixa de/.test(await sigmaPlot.locator(".analysisPlotGraphs").innerText())) throw new Error("singular value analysis plot or its peak characteristic failed to render");
    await sigmaPlot.locator(".analysisPlotProperties").evaluate((details) => { details.open = true; });
    if (await sigmaPlot.locator(".analysisPlotProperties").locator("label").filter({ hasText: "Escala frequencia" }).count() !== 1) throw new Error("singular value plot is missing frequency scale controls");
    await sigmaPlot.getByRole("button", { name: "Remover plot E2E singular value response" }).click();
    await designerFrame.locator("#newAnalysisPlot").evaluate((panel) => { panel.open = true; });
    await designerFrame.locator("#analysisPlotPath").selectOption("output");
    await designerFrame.locator("#analysisPlotInput").evaluate((select) => { for (const option of select.options) option.selected = option.value === "reference"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await designerFrame.locator("#analysisPlotOutput").evaluate((select) => { for (const option of select.options) option.selected = option.value === "output"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await designerFrame.locator("#analysisPlotLoopOpening").evaluate((select) => { select.value = "none"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await designerFrame.locator("#newAnalysisPlot").evaluate((panel) => { panel.open = false; });
    await restoreArchitecture.selectOption("imc");
    await designerFrame.locator("#architectureDiagram").screenshot({ path: path.join(artifacts, "control-designer-imc-architecture.png") });
    const residualInputOption = designerFrame.locator('#analysisPlotInput option[value="point:imcResidual"]');
    if (!(await residualInputOption.count()) || await residualInputOption.isDisabled()) throw new Error("IMC residual analysis input is missing or disabled");
    const residualWire = designerFrame.locator('#architectureDiagram [data-analysis-wire-targets] line[data-analysis-input="point:imcResidual"]').last();
    if (!(await residualWire.count())) throw new Error("IMC residual feedback wire has no arbitrary-position analysis target");
    const residualWireDebug = await residualWire.evaluate((line) => ({ connected: line.isConnected, input: line.getAttribute("data-analysis-input"), svgBound: typeof line.ownerSVGElement.onclick, boundFlag: line.ownerSVGElement.dataset.analysisPointClickBound, optionDisabled: document.querySelector('#analysisPlotInput option[value="point:imcResidual"]').disabled, architecture: document.querySelector("#architecture").value, derivative: document.querySelector("#derivativeOnMeasurement").checked }));
    await residualWire.click({ force: true });
    const residualPlotState = await designerFrame.evaluate(() => ({ open: document.querySelector("#newAnalysisPlot").open, selected: Array.from(document.querySelector("#analysisPlotInput").selectedOptions).map((option) => option.value) }));
    if (!residualPlotState.open || !residualPlotState.selected.includes("point:imcResidual")) throw new Error("clicking IMC residual wire did not configure its analysis input: " + JSON.stringify({ state: residualPlotState, debug: residualWireDebug }));
    await designerFrame.locator("#analysisPlotName").fill("E2E IMC selected-point loop");
    await designerFrame.locator("#analysisPlotType").selectOption("bode");
    await designerFrame.locator("#analysisPlotLoopOpening").selectOption("analysisPoint");
    await designerFrame.locator("#newAnalysisPlot").getByRole("button", { name: "Criar plot" }).click();
    const imcPointPlot=designerFrame.locator("[data-analysis-plot-id]").filter({hasText:"E2E IMC selected-point loop"});
    await imcPointPlot.waitFor({state:"visible",timeout:10000});
    if(!(await imcPointPlot.innerText()).includes("ponto selecionado"))throw new Error("IMC selected-point loop response was not rendered");
    await imcPointPlot.getByRole("button",{name:"Remover plot E2E IMC selected-point loop"}).click();
    await designerFrame.locator("#newAnalysisPlot").evaluate((panel) => { panel.open = true; });
    await designerFrame.locator("#analysisPlotName").fill("E2E IMC residual output");
    await designerFrame.locator("#analysisPlotType").selectOption("step");
    await designerFrame.locator("#analysisPlotLoopOpening").selectOption("none");
    await designerFrame.locator("#analysisPlotInput").evaluate((select) => { for (const option of select.options) option.selected = option.value === "point:imcResidual"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await designerFrame.locator("#analysisPlotOutput").evaluate((select) => { for (const option of select.options) option.selected = option.value === "imcResidual"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await designerFrame.locator("#newAnalysisPlot").getByRole("button", { name: "Criar plot" }).click();
    const residualOutputPlot=designerFrame.locator("[data-analysis-plot-id]").filter({hasText:"E2E IMC residual output"});
    await residualOutputPlot.waitFor({state:"visible",timeout:10000});
    if(/Error:|NaN|Transferencia invalida/i.test(await residualOutputPlot.innerText()))throw new Error("IMC residual analysis point could not be measured as an output");
    const responseCsvPromise=designerFrame.page().waitForEvent("download", { timeout: 15000 });await residualOutputPlot.getByRole("button",{name:"Exportar dados E2E IMC residual output como CSV"}).click();const responseCsvDownload=await responseCsvPromise,responseCsv=fs.readFileSync(await responseCsvDownload.path(),"utf8");if(!responseCsv.startsWith("serie,tempo_s,valor\r\n")||responseCsv.trim().split(/\r?\n/).length<3||!responseCsv.includes("point:imcResidual->imcResidual"))throw new Error(`analysis response CSV is missing sampled time/output data: ${responseCsv.slice(0,240)}`);
    const matlabResponseExportPromise=designerFrame.page().waitForEvent("download", { timeout: 15000 });await designerFrame.locator("#exportMatlab").click();const matlabResponseExport=await matlabResponseExportPromise,matlabResponseScript=fs.readFileSync(await matlabResponseExport.path(),"utf8");if(!matlabResponseScript.includes("IOTransfer_E2E_IMC_residual_output = tf(")||!matlabResponseScript.includes("controlSystemDesigner(s);"))throw new Error(`MATLAB export omitted the saved IMC residual response model; saved responses=${JSON.stringify(await designerFrame.locator("#analysisSavedResponse option").allTextContents())}; export lines=${JSON.stringify(matlabResponseScript.split(/\r?\n/).filter(line=>line.includes("IOTransfer")||line.includes("Data Browser")))}; UI error=${await designerFrame.locator("#error").innerText()}`);
    await residualOutputPlot.getByRole("button",{name:"Remover plot E2E IMC residual output"}).click();
    await restoreArchitecture.selectOption("nested-inner-forward");
    const nestedInputs = await designerFrame.evaluate(() => ({
      disturbanceDisabled: document.querySelector('#analysisPlotInput option[value="plantInputDisturbance"]').disabled,
      noiseDisabled: document.querySelector('#analysisPlotInput option[value="measurementNoise"]').disabled,
      innerErrorDisabled: document.querySelector('#analysisPlotOutput option[value="innerError"]').disabled,
    }));
    if (nestedInputs.disturbanceDisabled || nestedInputs.noiseDisabled || nestedInputs.innerErrorDisabled) throw new Error(`nested internal plots must accept plant disturbance and measurement noise: ${JSON.stringify(nestedInputs)}`);
    await designerFrame.locator("#newAnalysisPlot").evaluate((panel) => { panel.open = true; });
    await designerFrame.locator("#analysisPlotMode").selectOption("inputOutput");
    await designerFrame.locator("#analysisPlotInput").selectOption(["plantInputDisturbance", "measurementNoise"]);
    await designerFrame.locator("#analysisPlotOutput").selectOption("innerError");
    await designerFrame.locator("#analysisPlotName").fill("E2E disturbance and noise to nested inner error");
    await designerFrame.locator("#newAnalysisPlot").getByRole("button", { name: "Criar plot" }).click();
    const nestedPlot = designerFrame.locator('[data-analysis-plot-id]').filter({ hasText: "E2E disturbance and noise to nested inner error" });
    await nestedPlot.waitFor({ state: "visible" });
    const nestedPlotOutput = await nestedPlot.locator(".analysisPlotGraphs").innerText();
    if (/Error:|NaN|Transferência inválida/i.test(nestedPlotOutput) || await nestedPlot.locator(".analysisPlotGraphs svg").count() !== 2) throw new Error(`nested disturbance/noise-to-inner-error analysis failed: ${nestedPlotOutput}`);
    await nestedPlot.getByRole("button", { name: "Remover plot E2E disturbance and noise to nested inner error" }).click();
    await designerFrame.locator("#newAnalysisPlot").evaluate((panel) => { panel.open = true; });
    await designerFrame.locator("#analysisPlotMode").selectOption("inputOutput");
    await designerFrame.locator("#analysisPlotInput").selectOption("point:innerControl");
    await designerFrame.locator("#analysisPlotOutput").selectOption("output");
    await designerFrame.locator("#analysisPlotName").fill("E2E nested inner selected-point loop");
    await designerFrame.locator("#analysisPlotType").selectOption("bode");
    await designerFrame.locator("#analysisPlotLoopOpening").selectOption("analysisPoint");
    await designerFrame.locator("#newAnalysisPlot").getByRole("button",{name:"Criar plot"}).click();
    const nestedPointPlot=designerFrame.locator("[data-analysis-plot-id]").filter({hasText:"E2E nested inner selected-point loop"});
    await nestedPointPlot.waitFor({state:"visible",timeout:10000});
    if(!(await nestedPointPlot.innerText()).includes("ponto selecionado"))throw new Error("nested inner selected-point loop response was not rendered");
    await nestedPointPlot.getByRole("button",{name:"Remover plot E2E nested inner selected-point loop"}).click();
    await designerFrame.locator("#newAnalysisPlot").evaluate((panel) => { panel.open = true; });
    await designerFrame.locator("#analysisPlotMode").selectOption("standard");
    await designerFrame.locator("#analysisPlotInput").evaluate((select) => { for (const option of select.options) option.selected = option.value === "reference"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await designerFrame.locator("#analysisPlotOutput").evaluate((select) => { for (const option of select.options) option.selected = option.value === "output"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await designerFrame.locator("#newAnalysisPlot").evaluate((panel) => { panel.open = false; });
    await restoreArchitecture.selectOption("forward-controller");
    if (architectureChecks.length !== 5 || architectureChecks.some((item) => !item.fits || !item.hasWire)) throw new Error(`architecture diagram signs are misplaced: ${JSON.stringify(architectureChecks)}`);

    await designerFrame.locator("#rl").click({ button: "right", position: { x: 100, y: 80 } });
    if (await designerFrame.locator("#rootContextMenu button[data-root-context=requirement-new]").count() !== 1) throw new Error("root locus context menu is missing the new design requirement action");
    if (!(await designerFrame.locator("#rootContextMenu").isVisible()) || await designerFrame.locator("#rootContextMenu button[data-root-context=complex-pole]").count() !== 1 || await designerFrame.locator("#rootContextMenu button[data-root-context=integrator]").count() !== 1) throw new Error("root locus context menu is missing dynamic options");
    await designerFrame.locator("#rootContextMenu button[data-root-context=requirement-new]").click();
    await designerFrame.locator("#designerDialog").waitFor({ state: "visible" });
    if (await designerFrame.locator("#reqKind").inputValue() !== "settling" || !(await designerFrame.locator("#reqKind option[value=phaseMargin]").evaluate(option => option.hidden))) throw new Error("root locus requirement menu did not select and filter pole requirements");
    await designerFrame.locator("#designerDialog button[value=cancel]").click();
    await designerFrame.locator("#designerDialog").waitFor({ state: "hidden" });
    for (const graph of ["rl", "bode", "filterBode", "nichols", "controllerPz"]) {
      await designerFrame.locator(`#${graph}`).click({ button: "right", position: { x: 100, y: 80 } });
      if (!(await designerFrame.locator("#rootContextMenu").isVisible()) || await designerFrame.locator("#rootContextMenu button[data-root-context=real-pole]").count() !== 1 || await designerFrame.locator("#rootContextMenu button[data-root-context=real-zero]").count() !== 1) throw new Error(`compensator context menu missing on ${graph}`);
      const complexOption = designerFrame.locator("#rootContextMenu button[data-root-context=complex-pole]");
      if ((graph === "rl" || graph === "bode" || graph === "filterBode" || graph === "nichols" || graph === "controllerPz") !== await complexOption.isVisible()) throw new Error(`complex pole option visibility is incorrect on ${graph}`);
      const networkOption = designerFrame.locator("#rootContextMenu button[data-root-context=network-lead]");
      if (["bode", "filterBode", "nichols"].includes(graph) !== await networkOption.isVisible()) throw new Error(`compound dynamics menu visibility is incorrect on ${graph}`);
      if (graph === "bode" || graph === "filterBode" || graph === "nichols") {
        await designerFrame.locator("#rootContextMenu [data-root-context=requirement-new]").click();
        await designerFrame.locator("#designerDialog").waitFor({ state: "visible" });
        const expectedRequirement = graph === "filterBode" ? "gainLimitUpper" : "phaseMargin";
        if (await designerFrame.locator("#reqKind").inputValue() !== expectedRequirement) throw new Error(`incorrect default requirement for ${graph}`);
        await designerFrame.locator("#designerDialog button[value=cancel]").click();
        await designerFrame.locator("#designerDialog").waitFor({ state: "hidden" });
      }
      if (graph === "controllerPz") await designerFrame.locator("#rootContextMenu").press("Escape");
    }
    const rootLocusControllerPoles = designerFrame.locator('#rl [data-controller-root="pole"]');
    const directPoleCount = await rootLocusControllerPoles.count();
    await designerFrame.locator('#locusTools [data-root-edit="pole"][data-root-kind="real"]').click();
    await clickSvgAt(designerFrame.locator("#rl"), 220, 110);
    await designerFrame.waitForFunction((count) => document.querySelectorAll('#rl [data-controller-root="pole"]').length > count, directPoleCount);
    if (await designerFrame.locator('#locusTools [data-root-edit="pole"][data-root-kind="real"]').getAttribute("aria-pressed") !== "false") throw new Error("direct graphical pole insertion did not exit placement mode");
    const rootLocusControllerZeros = designerFrame.locator('#rl [data-controller-root="zero"]');
    const directZeroCount = await rootLocusControllerZeros.count();
    await designerFrame.locator('#locusTools [data-root-edit="zero"][data-root-kind="real"]').click();
    await clickSvgAt(designerFrame.locator("#rl"), 245, 130);
    await designerFrame.waitForFunction((count) => document.querySelectorAll('#rl [data-controller-root="zero"]').length > count, directZeroCount);
    if (await designerFrame.locator('#locusTools [data-root-edit="zero"][data-root-kind="real"]').getAttribute("aria-pressed") !== "false") throw new Error("direct graphical zero insertion did not exit placement mode");
    await designerFrame.locator("#rl").click({ button: "right", position: { x: 100, y: 80 } });
    await designerFrame.locator('#rootContextMenu [data-root-context="delete-zero"]').dispatchEvent("click");
    await rootLocusControllerZeros.last().dispatchEvent("click");
    await designerFrame.waitForFunction((count) => document.querySelectorAll('#rl [data-controller-root="zero"]').length === count, directZeroCount);
    await designerFrame.locator("#rl").click({ button: "right", position: { x: 100, y: 80 } });
    await designerFrame.locator('#rootContextMenu [data-root-context="delete-pole"]').dispatchEvent("click");
    await rootLocusControllerPoles.last().dispatchEvent("click");
    await designerFrame.waitForFunction((count) => document.querySelectorAll('#rl [data-controller-root="pole"]').length === count, directPoleCount);
    const polesBeforeBodeComplex = await rootLocusControllerPoles.count();
    await designerFrame.locator("#bode").click({ button: "right", position: { x: 180, y: 100 } });
    await designerFrame.locator('#rootContextMenu [data-root-context="complex-pole"]').dispatchEvent("click");
    await designerFrame.locator("#bode").click({ position: { x: 160, y: 120 } });
    await designerFrame.waitForFunction((count) => document.querySelectorAll('#rl [data-controller-root="pole"]').length === count + 2, polesBeforeBodeComplex);
    await designerFrame.locator("#rl").click({ button: "right", position: { x: 100, y: 80 } });
    await designerFrame.locator('#rootContextMenu [data-root-context="delete-pole"]').dispatchEvent("click");
    await rootLocusControllerPoles.last().dispatchEvent("click");
    await designerFrame.waitForFunction((count) => document.querySelectorAll('#rl [data-controller-root="pole"]').length === count, polesBeforeBodeComplex);
    const rootLocusPoleCount = await rootLocusControllerPoles.count();
    await designerFrame.locator("#rl").click({ button: "right", position: { x: 100, y: 80 } });
    await designerFrame.locator('#rootContextMenu [data-root-context="integrator"]').dispatchEvent("click");
    await designerFrame.waitForTimeout(500);
    const rootLocusInsertState = await designerFrame.evaluate(() => ({ poles: document.querySelectorAll('#rl [data-controller-root="pole"]').length, zeros: document.querySelectorAll('#rl [data-controller-root="zero"]').length, denominator: document.querySelector('[data-model="C"][data-part="den"]').value, error: document.querySelector("#error")?.textContent, marks: document.querySelectorAll("#rl [data-controller-root]").length }));
    if (rootLocusInsertState.poles !== rootLocusPoleCount + 1) throw new Error(`root-locus controller insertion failed: ${JSON.stringify(rootLocusInsertState)}`);
    await dragSvgMark(rootLocusControllerPoles.last(), 24, 0);
    await designerFrame.waitForFunction((before) => document.querySelector('[data-model="C"][data-part="den"]')?.value !== before, rootLocusInsertState.denominator);
    await designerFrame.locator("#rl").click({ button: "right", position: { x: 100, y: 80 } });
    await designerFrame.locator('#rootContextMenu [data-root-context="delete-pole"]').dispatchEvent("click");
    await rootLocusControllerPoles.last().dispatchEvent("click");
    await designerFrame.waitForTimeout(250);
    const rootLocusDeleteState = await designerFrame.evaluate(() => ({ poles: document.querySelectorAll('#rl [data-controller-root="pole"]').length, denominator: document.querySelector('[data-model="C"][data-part="den"]').value, error: document.querySelector("#error")?.textContent }));
    if (rootLocusDeleteState.poles !== rootLocusPoleCount) throw new Error(`root-locus controller removal failed: ${JSON.stringify(rootLocusDeleteState)}`);
    for (const [graph, model] of [["bode", "C"], ["nichols", "C"], ["filterBode", "F"]]) {
      const handles = designerFrame.locator(`#${graph} [data-editable-root="pole"]`);
      const originalCount = await handles.count();
      await designerFrame.locator(`#${graph}`).click({ button: "right", position: { x: 100, y: 80 } });
      await designerFrame.locator('#rootContextMenu [data-root-context="integrator"]').dispatchEvent("click");
      await designerFrame.waitForFunction(({ graph, originalCount }) => document.querySelectorAll(`#${graph} [data-editable-root="pole"]`).length === originalCount + 1, { graph, originalCount });
      const denominator = await designerFrame.locator(`[data-model="${model}"][data-part="den"]`).inputValue();
      await dragSvgMark(handles.last(), 24, 0);
      await designerFrame.waitForFunction(({ model, denominator }) => document.querySelector(`[data-model="${model}"][data-part="den"]`)?.value !== denominator, { model, denominator });
      await designerFrame.locator(`#${graph}`).click({ button: "right", position: { x: 100, y: 80 } });
      await designerFrame.locator('#rootContextMenu [data-root-context="delete-pole"]').dispatchEvent("click");
      await handles.last().dispatchEvent("click");
      await designerFrame.waitForFunction(({ graph, originalCount }) => document.querySelectorAll(`#${graph} [data-editable-root="pole"]`).length === originalCount, { graph, originalCount });
    }
    for (const [network, expectedRoots] of [["lead", 1], ["lag", 1], ["leadlag", 2]] ) {
      const polesBefore = await designerFrame.locator('#bode [data-editable-root="pole"]').count();
      const zerosBefore = await designerFrame.locator('#bode [data-editable-root="zero"]').count();
      await designerFrame.locator("#bode").click({ button: "right", position: { x: 100, y: 80 } });
      if(network==="lead")await designerFrame.locator("#networkPhase").fill("45"); await designerFrame.locator(`#rootContextMenu [data-root-context="network-${network}"]`).dispatchEvent("click");
      await clickSvgAt(designerFrame.locator("#bode"), 300, 110);
      await designerFrame.waitForFunction(({ polesBefore, zerosBefore, expectedRoots }) => document.querySelectorAll('#bode [data-editable-root="pole"]').length === polesBefore + expectedRoots && document.querySelectorAll('#bode [data-editable-root="zero"]').length === zerosBefore + expectedRoots, { polesBefore, zerosBefore, expectedRoots });
      if (network === "lead") {
        const compositeRow = designerFrame.locator('#controllerDynamics [data-composite-kind="lead"]').first();
        await compositeRow.waitFor({ state: "visible" });
        if (await compositeRow.locator("input").count() !== 2) throw new Error("lead network row does not expose synchronized zero and pole break frequencies"); const leadZero=Number(await compositeRow.locator("input").nth(0).inputValue()),leadPole=Number(await compositeRow.locator("input").nth(1).inputValue()),measuredLeadPhase=Math.asin((leadPole/leadZero-1)/(leadPole/leadZero+1))*180/Math.PI; if(Math.abs(measuredLeadPhase-45)>0.2)throw new Error(`lead network did not honor requested maximum phase: ${measuredLeadPhase} deg`);
        const numeratorBeforeNetworkEdit = await designerFrame.locator('[data-model="C"][data-part="num"]').inputValue();
        const denominatorBeforeNetworkEdit = await designerFrame.locator('[data-model="C"][data-part="den"]').inputValue();
        const zeroFrequency = Number(await compositeRow.locator("input").nth(0).inputValue());
        const zeroFrequencyInput = compositeRow.locator("input").nth(0);
        await zeroFrequencyInput.fill(String(zeroFrequency * 0.9));
        await zeroFrequencyInput.evaluate((input) => input.dispatchEvent(new Event("change", { bubbles: true })));
        await designerFrame.waitForFunction((before) => document.querySelector('[data-model="C"][data-part="num"]')?.value !== before, numeratorBeforeNetworkEdit);
        const denominatorAfterNetworkEdit = await designerFrame.locator('[data-model="C"][data-part="den"]').inputValue();
        const beforeDenominator = denominatorBeforeNetworkEdit.split(",").map(Number), afterDenominator = denominatorAfterNetworkEdit.split(",").map(Number);
        if (beforeDenominator.length !== afterDenominator.length || beforeDenominator.some((value, index) => Math.abs(value - afterDenominator[index]) > 1e-6 * Math.max(1, Math.abs(value)))) throw new Error(`editing the composite lead zero changed the unrelated pole polynomial: ${denominatorBeforeNetworkEdit} -> ${denominatorAfterNetworkEdit}`);
        await designerFrame.locator("#bode").click({ button: "right", position: { x: 100, y: 80 } });
        await designerFrame.locator('#rootContextMenu [data-root-context="delete-pole"]').dispatchEvent("click");
        await designerFrame.locator('#bode [data-editable-root="pole"]').last().dispatchEvent("click");
        const improperError = await designerFrame.locator("#error").textContent(), improperModel = { num: await designerFrame.locator('[data-model="C"][data-part="num"]').inputValue(), den: await designerFrame.locator('[data-model="C"][data-part="den"]').inputValue() }; if (!(improperError || "").includes("impr\u00f3prio")) throw new Error(`removing the lead pole did not report an improper controller: error=${JSON.stringify(improperError)}, model=${JSON.stringify(improperModel)}`);

      }
      for (const kind of ["zero", "pole"]) for (let index = 0; index < expectedRoots; index++) {
        await designerFrame.locator("#bode").click({ button: "right", position: { x: 100, y: 80 } });
        await designerFrame.locator(`#rootContextMenu [data-root-context="delete-${kind}"]`).dispatchEvent("click");
        await designerFrame.locator(`#bode [data-editable-root="${kind}"]`).last().dispatchEvent("click");
        await designerFrame.waitForTimeout(100);
        const afterDelete = await designerFrame.locator(`#bode [data-editable-root="${kind}"]`).count();
        const expectedAfterDelete = (kind === "pole" ? polesBefore : zerosBefore) + expectedRoots - index - 1;
        const deleteMode = await designerFrame.locator("#bode").getAttribute("data-root-delete-debug");
        if (afterDelete !== expectedAfterDelete) throw new Error(`failed to delete ${kind} from ${network}: count=${afterDelete}, expected=${expectedAfterDelete}, event=${deleteMode}, cursor=${await designerFrame.locator("#bode").evaluate(svg => svg.style.cursor)}`);
      }
      await designerFrame.waitForTimeout(250);
      const networkDeleteState = await designerFrame.evaluate(() => ({ poles: document.querySelectorAll('#bode [data-editable-root="pole"]').length, zeros: document.querySelectorAll('#bode [data-editable-root="zero"]').length, denominator: document.querySelector('[data-model="C"][data-part="den"]').value, numerator: document.querySelector('[data-model="C"][data-part="num"]').value }));
      if (networkDeleteState.poles !== polesBefore || networkDeleteState.zeros !== zerosBefore) throw new Error(`failed to delete ${network}: ${JSON.stringify(networkDeleteState)}; expected ${polesBefore}/${zerosBefore}`);
    }
    const nicholsNotchPoles = designerFrame.locator('#nichols [data-editable-root="pole"]'), nicholsNotchZeros = designerFrame.locator('#nichols [data-editable-root="zero"]');
    const nicholsPoleCount = await nicholsNotchPoles.count(), nicholsZeroCount = await nicholsNotchZeros.count();
    await designerFrame.locator("#nichols").click({ button: "right", position: { x: 100, y: 80 } });
    await designerFrame.locator('#rootContextMenu [data-root-context="network-notch"]').dispatchEvent("click");
    await clickSvgAt(designerFrame.locator("#nichols"), 300, 110);
    await designerFrame.waitForFunction(({ polesBefore, zerosBefore }) => document.querySelectorAll('#nichols [data-editable-root="pole"]').length === polesBefore + 2 && document.querySelectorAll('#nichols [data-editable-root="zero"]').length === zerosBefore + 2, { polesBefore: nicholsPoleCount, zerosBefore: nicholsZeroCount });
    await designerFrame.waitForFunction(() => document.querySelector('#controllerDynamics [data-composite-kind="notch"] input') !== null);
    if (await designerFrame.locator('#controllerDynamics [data-composite-kind="notch"] input').count() !== 3) throw new Error("notch dynamics row does not expose natural frequency and both damping ratios");
    const notchHandles = designerFrame.locator('#bode [data-notch-handle]');
    await designerFrame.waitForFunction(() => document.querySelectorAll('#bode [data-notch-handle]').length === 3);
    const notchNumeratorBefore = await designerFrame.locator('[data-model="C"][data-part="num"]').inputValue();
    await dragSvgMark(designerFrame.locator('#bode [data-notch-handle="center"]'), 0, 3);
    await designerFrame.waitForFunction((before) => document.querySelector('[data-model="C"][data-part="num"]')?.value !== before, notchNumeratorBefore);
    const notchDenominatorBefore = await designerFrame.locator('[data-model="C"][data-part="den"]').inputValue();
    await dragSvgMark(designerFrame.locator('#bode [data-notch-handle="width-right"]'), 5, 0);
    await designerFrame.waitForFunction((before) => document.querySelector('[data-model="C"][data-part="den"]')?.value !== before, notchDenominatorBefore);
    if (await notchHandles.count() !== 3) throw new Error("graphical notch editing did not preserve its frequency, depth, and width handles");
    for (const [kind, handles] of [["zero", nicholsNotchZeros], ["pole", nicholsNotchPoles]]) {
      await designerFrame.locator("#nichols").click({ button: "right", position: { x: 100, y: 80 } });
      await designerFrame.locator(`#rootContextMenu [data-root-context="delete-${kind}"]`).dispatchEvent("click");
      await handles.last().dispatchEvent("click");
    }
    await designerFrame.waitForFunction(({ polesBefore, zerosBefore }) => document.querySelectorAll('#nichols [data-editable-root="pole"]').length === polesBefore && document.querySelectorAll('#nichols [data-editable-root="zero"]').length === zerosBefore, { polesBefore: nicholsPoleCount, zerosBefore: nicholsZeroCount });
    const gainInput = designerFrame.locator('[data-model="C"][data-part="num"]'), gainBefore = await gainInput.inputValue();
    await dragSvgMark(designerFrame.locator('#nichols [data-nichols-gain-handle="true"]').nth(20), 0, -15);
    await designerFrame.waitForFunction((before) => document.querySelector('[data-model="C"][data-part="num"]')?.value !== before, gainBefore);
    await gainInput.fill(gainBefore);
    const poleMarks = designerFrame.locator('#controllerPz [data-kind="pole"]');
    const originalPoleCount = await poleMarks.count();
    await designerFrame.locator("#controllerPz").click({ button: "right", position: { x: 100, y: 80 } });
    await designerFrame.locator('#rootContextMenu [data-root-context="integrator"]').dispatchEvent("click");
    await designerFrame.waitForFunction((count) => document.querySelectorAll('#controllerPz [data-kind="pole"]').length === count + 1, originalPoleCount);
    const originPoleIndex = await poleMarks.evaluateAll((marks) => marks.findIndex((mark) => (mark.getAttribute("aria-label") || "").includes("0.000")));
    if (originPoleIndex < 0) throw new Error("graphical integrator insertion did not create a pole at the origin");
    await designerFrame.locator("#controllerPz").click({ button: "right", position: { x: 100, y: 80 } });
    await designerFrame.locator('#rootContextMenu [data-root-context="delete-pole"]').dispatchEvent("click");
    await poleMarks.nth(originPoleIndex).dispatchEvent("click");
    await designerFrame.waitForFunction((count) => document.querySelectorAll('#controllerPz [data-kind="pole"]').length < count + 1, originalPoleCount);
    await designerFrame.locator("#preset").selectOption("PID");
    await designerFrame.locator("#pidDesignFocus").selectOption("disturbance");
    await designerFrame.locator("#pidTransientBehavior").fill("0.8");
    await designerFrame.locator('button:has-text("Robust PID auto-tune")').click();
    await designerFrame.waitForFunction(() => document.querySelector("#robustPidStatus")?.textContent?.includes("Robust PID search") || Boolean(document.querySelector("#error")?.textContent?.trim()), null, { timeout: 30000 });
    if (await designerFrame.locator("#error").textContent()) throw new Error(`PID tuner failed for disturbance focus: ${await designerFrame.locator("#error").textContent()}`);
    const disturbanceStatus = await designerFrame.locator("#robustPidStatus").innerText();
    if (!disturbanceStatus.includes("disturbance, transient 0.80")) throw new Error("PID tuner did not apply the selected disturbance focus and transient behavior");
    const disturbanceMargin = Number(disturbanceStatus.match(/PM ([0-9.]+) deg/)?.[1]);
    if (!Number.isFinite(disturbanceMargin) || disturbanceMargin < 59.5) throw new Error(`PID tuning failed to honor its 60 degree robustness target: ${disturbanceStatus}`);
    await designerFrame.locator("#pidDesignFocus").selectOption("tracking");
    await designerFrame.locator('button:has-text("Robust PID auto-tune")').click();
    await designerFrame.waitForFunction(() => document.querySelector("#saved")?.textContent?.includes("tracking, transient 0.80") || Boolean(document.querySelector("#error")?.textContent?.trim()), null, { timeout: 30000 });
    if (await designerFrame.locator("#error").textContent()) throw new Error(`PID tracking-focus tuning failed: ${await designerFrame.locator("#error").textContent()}`);
    const trackingStatus = await designerFrame.locator("#robustPidStatus").innerText();
    const trackingMargin = Number(trackingStatus.match(/PM ([0-9.]+) deg/)?.[1]);
    if (!Number.isFinite(trackingMargin) || trackingMargin < 59.5) throw new Error(`changing PID design focus violated the 60 degree robustness target: ${trackingStatus}`);
    await designerFrame.locator("#pidTuningDomain").selectOption("frequency");
    await designerFrame.locator("#pidBandwidth").fill("1.5");
    await designerFrame.locator('button:has-text("Robust PID auto-tune")').click();
    await designerFrame.waitForFunction(() => document.querySelector("#robustPidStatus")?.textContent?.includes("frequency, wc 1.50 rad/s") || Boolean(document.querySelector("#error")?.textContent?.trim()), null, { timeout: 30000 });
    if (await designerFrame.locator("#error").textContent()) throw new Error(`PID bandwidth tuning failed: ${await designerFrame.locator("#error").textContent()}`);
    const frequencyTuningStatus = await designerFrame.locator("#robustPidStatus").innerText();
    const achievedBandwidth = Number(frequencyTuningStatus.match(/achieved ([0-9.]+) rad\/s/)?.[1]);
    if (!Number.isFinite(achievedBandwidth) || achievedBandwidth < 0.75 || achievedBandwidth > 2.25) throw new Error(`PID frequency goal was not reflected in the achieved crossover: ${frequencyTuningStatus}`);
    const savedPlantForIntegral = { numerator: await designerFrame.locator('[data-model="G"][data-part="num"]').inputValue(), denominator: await designerFrame.locator('[data-model="G"][data-part="den"]').inputValue() };
    await designerFrame.locator('[data-model="G"][data-part="num"]').fill("1");
    await designerFrame.locator('[data-model="G"][data-part="num"]').dispatchEvent("change");
    await designerFrame.locator('[data-model="G"][data-part="den"]').fill("1, 1");
    await designerFrame.locator('[data-model="G"][data-part="den"]').dispatchEvent("change");
    await designerFrame.locator("#pidControllerType").selectOption("I");
    await designerFrame.locator("#pidBandwidth").fill("0.5");
    await designerFrame.locator("#robustPidTune").click();
    await designerFrame.waitForFunction(() => document.querySelector("#robustPidStatus")?.textContent?.includes("Robust I search") || Boolean(document.querySelector("#error")?.textContent?.trim()), null, { timeout: 30000 });
    if (await designerFrame.locator("#error").textContent()) throw new Error(`I auto-tuning failed for a stable first-order plant: ${await designerFrame.locator("#error").textContent()}`);
    const tunedI = { numerator: await designerFrame.locator('[data-model="C"][data-part="num"]').inputValue(), denominator: await designerFrame.locator('[data-model="C"][data-part="den"]').inputValue() };
    if (Number(tunedI.numerator.split(",")[0]) === 0 || tunedI.denominator.split(",").length !== 2) throw new Error(`I tuner did not produce an integral controller: ${JSON.stringify(tunedI)}`);
    await designerFrame.locator("#shapeTargetPanel summary").click();
    await designerFrame.locator("#shapeTargetNum").fill("0.5");
    await designerFrame.locator("#shapeTargetDen").fill("1, 2, 1");
    await designerFrame.locator("#shapeTargetMin").fill("0.1");
    await designerFrame.locator("#shapeTargetMax").fill("10");
    await designerFrame.locator("#shapeTargetSynthesize").click();
    await designerFrame.waitForFunction(() => document.querySelector("#saved")?.textContent?.includes("Loop shape exacto"));
    const targetShapeStatus = await designerFrame.locator("#saved").innerText();
    const targetShapeError = Number(targetShapeStatus.match(/erro maximo ([0-9.e+-]+) dB \/ ([0-9.e+-]+) deg/)?.[1]), targetShapePhaseError = Number(targetShapeStatus.match(/erro maximo [0-9.e+-]+ dB \/ ([0-9.e+-]+) deg/)?.[1]);
    if (!Number.isFinite(targetShapeError) || targetShapeError > 1e-8 || !Number.isFinite(targetShapePhaseError) || targetShapePhaseError > 1e-8) throw new Error(`target loop shape did not match within the requested band: ${targetShapeStatus}`);
    const fixedShapeNumerator = (await designerFrame.locator('[data-model="C"][data-part="num"]').inputValue()).split(",").map(Number);
    const fixedShapeOrderBefore = { numerator: fixedShapeNumerator.length, denominator: (await designerFrame.locator('[data-model="C"][data-part="den"]').inputValue()).split(",").length };
    await designerFrame.locator('[data-model="C"][data-part="num"]').fill(fixedShapeNumerator.map(value => String(value * 0.05)).join(", "));
    await designerFrame.locator('[data-model="C"][data-part="num"]').dispatchEvent("change");
    await designerFrame.locator("#shapeTargetFit").click();
    await designerFrame.waitForFunction(() => document.querySelector("#saved")?.textContent?.includes("Loop shape estrutura fixa"));
    const fixedShapeStatus = await designerFrame.locator("#saved").innerText();
    const fixedShapeError = Number(fixedShapeStatus.match(/erro maximo ([0-9.e+-]+) dB \/ ([0-9.e+-]+) deg/)?.[1]);
    const fixedShapeOrderAfter = { numerator: (await designerFrame.locator('[data-model="C"][data-part="num"]').inputValue()).split(",").length, denominator: (await designerFrame.locator('[data-model="C"][data-part="den"]').inputValue()).split(",").length };
    if (!Number.isFinite(fixedShapeError) || fixedShapeError > 1e-6 || JSON.stringify(fixedShapeOrderAfter) !== JSON.stringify(fixedShapeOrderBefore)) throw new Error(`fixed-structure loop shaping did not retain order or match the target: ${fixedShapeStatus}; ${JSON.stringify(fixedShapeOrderBefore)} -> ${JSON.stringify(fixedShapeOrderAfter)}`);
    await designerFrame.locator('[data-model="G"][data-part="num"]').fill(savedPlantForIntegral.numerator);
    await designerFrame.locator('[data-model="G"][data-part="num"]').dispatchEvent("change");
    await designerFrame.locator('[data-model="G"][data-part="den"]').fill(savedPlantForIntegral.denominator);
    await designerFrame.locator('[data-model="G"][data-part="den"]').dispatchEvent("change");
    await designerFrame.locator("#pidControllerType").selectOption("PI");
    await designerFrame.locator("#pidBandwidth").fill("0.8");
    await designerFrame.locator("#robustPidTune").click();
    await designerFrame.waitForFunction(() => document.querySelector("#robustPidStatus")?.textContent?.includes("Robust PI search") || Boolean(document.querySelector("#error")?.textContent?.trim()), null, { timeout: 30000 });
    if (await designerFrame.locator("#error").textContent()) throw new Error(`PI auto-tuning failed: ${await designerFrame.locator("#error").textContent()}`);
    const tunedPi = { numerator: await designerFrame.locator('[data-model="C"][data-part="num"]').inputValue(), denominator: await designerFrame.locator('[data-model="C"][data-part="den"]').inputValue() };
    if (Number(tunedPi.numerator.split(",")[0]) === 0 || tunedPi.denominator.split(",").length !== 2) throw new Error(`PI tuner did not produce a proportional-integral controller: ${JSON.stringify(tunedPi)}`);
    await designerFrame.locator("#pidControllerType").selectOption("P");
    await designerFrame.locator("#pidBandwidth").fill("0.8");
    await designerFrame.locator("#robustPidTune").click();
    await designerFrame.waitForFunction(() => document.querySelector("#robustPidStatus")?.textContent?.includes("Robust P search") || Boolean(document.querySelector("#error")?.textContent?.trim()), null, { timeout: 30000 });
    if (await designerFrame.locator("#error").textContent()) throw new Error(`P auto-tuning failed: ${await designerFrame.locator("#error").textContent()}`);
    const tunedP = { numerator: await designerFrame.locator('[data-model="C"][data-part="num"]').inputValue(), denominator: await designerFrame.locator('[data-model="C"][data-part="den"]').inputValue() };
    if (tunedP.denominator.split(",").length !== 1) throw new Error(`P tuner did not preserve a proportional-only structure: ${JSON.stringify(tunedP)}`);
    await designerFrame.locator("#pidControllerType").selectOption("PD");
    await designerFrame.locator("#robustPidTune").click();
    await designerFrame.waitForFunction(() => document.querySelector("#robustPidStatus")?.textContent?.includes("Robust PD search") || Boolean(document.querySelector("#error")?.textContent?.trim()), null, { timeout: 30000 });
    if (await designerFrame.locator("#error").textContent()) throw new Error(`PDF auto-tuning failed: ${await designerFrame.locator("#error").textContent()}`);
    const tunedPd = { numerator: await designerFrame.locator('[data-model="C"][data-part="num"]').inputValue(), denominator: await designerFrame.locator('[data-model="C"][data-part="den"]').inputValue() };
    if (tunedPd.denominator.split(",").length !== 2) throw new Error(`PDF tuner did not preserve a filtered derivative structure: ${JSON.stringify(tunedPd)}`);
    const tunedFilterN = Number(await designerFrame.locator("#p3").inputValue()), pdfTuningStatus = await designerFrame.locator("#robustPidStatus").textContent();
    if (!(tunedFilterN > 0) || !pdfTuningStatus?.includes(`N=${tunedFilterN.toPrecision(3)}`)) throw new Error(`PDF tuning did not preserve/report the searched derivative filter N: ${pdfTuningStatus}`);
    await designerFrame.locator("#pidControllerType").selectOption("PID");
    await designerFrame.locator("#preset").selectOption("PID");
    await designerFrame.locator('button:has-text("Aplicar controlador")').click();
    const basePrefilterBeforeTwoDof = { num: await designerFrame.locator('[data-model="F"][data-part="num"]').inputValue(), den: await designerFrame.locator('[data-model="F"][data-part="den"]').inputValue() };
    await designerFrame.locator("#pidTwoDofEnabled").check();
    if (!(await designerFrame.locator("#architectureDiagram").getAttribute("aria-label")).includes("dois graus")) throw new Error("2-DOF diagram did not update to show the weighted branches");
    const pidTwoDofDiagram = designerFrame.locator("#architectureDiagram");
    const pidTwoDofLabels = await pidTwoDofDiagram.locator("text").allTextContents();
    const clippedPidTwoDofLabels = await pidTwoDofDiagram.locator("text").evaluateAll((labels) => labels.filter((label) => { const box = label.getBBox(); return box.x < 0 || box.y < 0 || box.x + box.width > 520 || box.y + box.height > 285; }).map((label) => label.textContent));
    if (pidTwoDofLabels.filter((label) => label === String.fromCodePoint(931)).length !== 4 || pidTwoDofLabels.filter((label) => label === String.fromCodePoint(8722) + "Hy").length !== 3 || pidTwoDofLabels.some((label) => label.includes("?")) || clippedPidTwoDofLabels.length) throw new Error(`2-DOF diagram has missing summing junctions or feedback signs: ${JSON.stringify(pidTwoDofLabels)}`);
    await pidTwoDofDiagram.screenshot({ path: path.join(artifacts, "control-designer-pid-2dof.png") });
    await designerFrame.locator("#pidTwoDofB").fill("0.5");
    await designerFrame.locator("#pidTwoDofB").dispatchEvent("change");
    const twoDofPrefilter = { num: await designerFrame.locator('[data-model="F"][data-part="num"]').inputValue(), den: await designerFrame.locator('[data-model="F"][data-part="den"]').inputValue() };
    if (twoDofPrefilter.num !== basePrefilterBeforeTwoDof.num || twoDofPrefilter.den !== basePrefilterBeforeTwoDof.den) throw new Error("2-DOF PID changed the independent prefilter F");
    await designerFrame.locator("#robustPidTune").click();
    await designerFrame.waitForFunction(() => document.querySelector("#robustPidStatus")?.textContent?.includes("candidates."), undefined, { timeout: 60000 });
    const tuningSummary = await designerFrame.locator("#robustPidStatus").textContent();
    if (!tuningSummary?.includes("b=") || !tuningSummary.includes("c=")) throw new Error("robust PID result did not report tuned 2-DOF weights");
    const tunedB = Number(await designerFrame.locator("#pidTwoDofB").inputValue()), tunedC = Number(await designerFrame.locator("#pidTwoDofC").inputValue());
    if (!(tunedB >= 0 && tunedB <= 1 && tunedC >= 0 && tunedC <= 1)) throw new Error("robust PID tuner did not optimize bounded 2-DOF setpoint weights");
    if (await designerFrame.locator('[data-model="F"][data-part="num"]').inputValue() !== basePrefilterBeforeTwoDof.num || await designerFrame.locator('[data-model="F"][data-part="den"]').inputValue() !== basePrefilterBeforeTwoDof.den) throw new Error("robust 2-DOF PID tuning changed the independent prefilter F");
    if (!(await designerFrame.locator('[data-model="C"][data-part="num"]').isDisabled()) || !(await designerFrame.locator('[data-model="F"][data-part="num"]').isDisabled())) throw new Error("2-DOF PID did not lock its derived controller and prefilter models");
    if (!(await designerFrame.locator('[data-model="C"][data-part="num"]').isDisabled()) || !(await designerFrame.locator('[data-model="F"][data-part="num"]').isDisabled())) throw new Error("2-DOF PID did not lock its derived controller and prefilter models");
    await designerFrame.locator("#pidTwoDofEnabled").uncheck();
    if (await designerFrame.locator('[data-model="F"][data-part="num"]').inputValue() !== basePrefilterBeforeTwoDof.num || await designerFrame.locator('[data-model="F"][data-part="den"]').inputValue() !== basePrefilterBeforeTwoDof.den) throw new Error("disabling 2-DOF PID did not restore the original prefilter");
    await designerFrame.locator("#compareSelection summary").click();
    const activeCompareDesign = designerFrame.locator('#compareSelection [data-compare-key="current"]').first();
    if (!(await activeCompareDesign.isChecked())) throw new Error("current design is not selected for comparison by default");
    await activeCompareDesign.uncheck();
    await designerFrame.locator("#compare").click();
    if (!(await designerFrame.locator("#error").textContent()).includes("Selecione pelo menos um controlador")) throw new Error("comparison did not require a selected design");
    await activeCompareDesign.check();
    await designerFrame.locator("#compare").click();
    if (await designerFrame.locator("#error").textContent()) throw new Error("comparison failed after selecting the active design");
    await designerFrame.waitForFunction(() => { const markers=Array.from(document.querySelectorAll("#time [data-response-characteristic=\"peak\"]")); return markers.length>0 && markers.every(marker=>marker.querySelector("title")?.textContent?.includes("Tempo de subida")) },null,{timeout:10000});
    for (const response of ["control", "sensitivity", "output"]) {
      await designerFrame.locator("#response").selectOption(response);
      await designerFrame.locator("#compare").click();
      const caption = await designerFrame.locator("#loopMetrics caption").innerText();
      if (!caption.includes(response)) throw new Error(`comparison ignored selected response ${response}: ${caption}`);
    }
    const comparisonSummary=await designerFrame.locator("#loopMetrics").innerText();
    if(!["Subida","Acomodação","Sobressinal","Margem de ganho","Margem de fase","Pico da resposta"].every(label=>comparisonSummary.includes(label))||await designerFrame.locator("#loopMetrics tbody tr").count()<1)throw new Error(`aggregate response comparison summary is incomplete: ${comparisonSummary}`);
    const graphCards = designerFrame.locator(".plots .card");
    for (let index = 0; index < await graphCards.count(); index++) {
      const card = graphCards.nth(index);
      const toggle = card.locator(".graph-fullscreen-toggle");
      const originalBounds = await card.boundingBox();
      if (!(await toggle.isVisible())) throw new Error(`controle de tela cheia ausente no gráfico ${index + 1}`);
      await domClick(toggle);
      if (!(await card.evaluate((element) => element.classList.contains("fullscreen")))) throw new Error(`gráfico ${index + 1} não expandiu independentemente`);
      if (!(await toggle.locator("svg path").count())) throw new Error(`ícone de tela cheia ausente no gráfico ${index + 1}`);
      const expandedBounds = await card.boundingBox();
      const webviewSize = await designerFrame.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      if (!expandedBounds || expandedBounds.width < webviewSize.width * 0.9 || expandedBounds.height < webviewSize.height * 0.8) throw new Error(`graph ${index + 1} not ocupou a janela: ${JSON.stringify({ expandedBounds, webviewSize })}`);
      await domClick(toggle);
      if (await card.evaluate((element) => element.classList.contains("fullscreen"))) throw new Error(`gráfico ${index + 1} não retornou ao tamanho anterior`);
      const restoredBounds = await card.boundingBox();
      if (!originalBounds || !restoredBounds || Math.abs(restoredBounds.width - originalBounds.width) > 2 || Math.abs(restoredBounds.height - originalBounds.height) > 2) throw new Error(`graph ${index + 1} not restaurou o tamanho independente`);
    }
    const unnamedButtons = await designerFrame.locator("button").evaluateAll((buttons) => buttons.filter((button) => !(button.getAttribute("aria-label") || button.getAttribute("title") || button.textContent.trim())).map((button) => button.outerHTML));
    if (unnamedButtons.length) throw new Error(`botões sem nome acessível no Projeto de Controladores: ${unnamedButtons.join(" | ")}`);
    const keyboardToggle = graphCards.first().locator(".graph-fullscreen-toggle");
    await keyboardToggle.focus();
    if (!(await keyboardToggle.evaluate((button) => document.activeElement === button))) throw new Error("o controle de tela cheia não recebe foco de teclado");
    await workbench.keyboard.press("Enter");
    await workbench.keyboard.press("Escape");
    if (!(await keyboardToggle.evaluate((button) => document.activeElement === button))) throw new Error("Escape não devolveu foco ao controle de tela cheia");
    const keyboardPlot = designerFrame.locator("#bode");
    const initialViewBox = await keyboardPlot.getAttribute("viewBox");
    await keyboardPlot.focus();
    await keyboardPlot.press("ArrowRight");
    if (await keyboardPlot.getAttribute("viewBox") === initialViewBox) throw new Error("gráfico não respondeu ÃƒÂ  navegação por teclado");
    await keyboardPlot.press("Home");
    if (await keyboardPlot.getAttribute("viewBox") !== "0 0 640 330") throw new Error("Home não restaurou o enquadramento do gráfico");
    await designerFrame.locator("body").screenshot({ path: path.join(artifacts, "control-designer.png"), animations: "disabled" });
    const plotBounds = await designerFrame.locator(".plots").boundingBox();
    if (!plotBounds || plotBounds.width < 300 || plotBounds.height < 300) throw new Error(`os gráficos do projeto não têm área útil: ${JSON.stringify(plotBounds)}`);
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
    if (await designerFrame.locator('#controllerPz [data-kind="pole"]').count() !== 1) throw new Error("o mapa de polos do controlador não foi redesenhado após arrastar");
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
    if (await designerFrame.locator('#controllerPz [data-kind="pole"]').count() !== 2 || (await designerFrame.locator("#error").textContent())) throw new Error("arraste do polo complexo rompeu o par conjugado");
    const keyboardPole = designerFrame.locator('#controllerPz [data-kind="pole"]').first();
    if (!(await keyboardPole.getAttribute("aria-label"))?.includes("Polo 1")) throw new Error("polo do controlador sem nome acessível");
    const keyboardDenominatorBefore = await cDenominator.inputValue();
    await keyboardPole.focus();
    await keyboardPole.press("ArrowRight");
    await designerFrame.waitForFunction((before) => document.querySelector('[data-model="C"][data-part="den"]')?.value !== before, keyboardDenominatorBefore);
    if (await designerFrame.locator('#controllerPz [data-kind="pole"]').count() !== 2) throw new Error("edição de polo por teclado rompeu o par conjugado");
    const compensatorFormat = designerFrame.locator('#compensatorFormatRow select');
    const originalCompensatorFormat = await compensatorFormat.inputValue();
    const coefficientsBeforeFormatSwitch = await Promise.all([designerFrame.locator('[data-model="C"][data-part="num"]').inputValue(), designerFrame.locator('[data-model="C"][data-part="den"]').inputValue()]);
    await compensatorFormat.selectOption("zpk");
    if (!(await designerFrame.locator('#controllerDynamics [aria-label*="parte real"]').count()) || await designerFrame.locator('#controllerDynamics [aria-label*="natural"]').count()) throw new Error("ZPK format must expose editable real/imaginary roots without natural-frequency fields");
    await compensatorFormat.selectOption("timeConstant");
    if (!(await designerFrame.locator('#controllerDynamics [aria-label*="constante de tempo"]').count())) throw new Error("time-constant format must expose editable time constants");
    await compensatorFormat.selectOption("naturalFrequency");
    if (!(await designerFrame.locator('#controllerDynamics [aria-label*="natural"]').count()) || !(await designerFrame.locator('#controllerDynamics [aria-label*="amortecimento"]').count())) throw new Error("natural-frequency format must expose editable frequency and damping fields");
    await compensatorFormat.selectOption(originalCompensatorFormat);
    const coefficientsAfterFormatSwitch = await Promise.all([designerFrame.locator('[data-model="C"][data-part="num"]').inputValue(), designerFrame.locator('[data-model="C"][data-part="den"]').inputValue()]);
    if (coefficientsAfterFormatSwitch.some((value, index) => value !== coefficientsBeforeFormatSwitch[index])) throw new Error("changing the compensator display format must preserve the controller model");
    await compensatorFormat.selectOption(originalCompensatorFormat);
    await designerFrame.locator("#preset").selectOption("PI");
    await designerFrame.locator("#plotManager summary").click();
    const timePlotToggle = designerFrame.locator('#plotManager input[aria-label="Exibir Resposta temporal"]');
    await timePlotToggle.uncheck();
    if (!(await designerFrame.locator("#time").evaluate((svg) => svg.closest(".card").hidden))) throw new Error("plot manager did not hide the selected response plot");
    await timePlotToggle.check();
    await designerFrame.locator("#newAnalysisPlot summary").click();
    await designerFrame.locator("#analysisPlotName").fill("Disturbance output");
    await designerFrame.locator("#analysisPlotMode").selectOption("inputOutput");
    await designerFrame.locator("#analysisPlotInput").selectOption("plantInputDisturbance");
    await designerFrame.locator("#analysisPlotOutput").selectOption("output");
    await designerFrame.locator("#analysisPlotType").selectOption("step");
    await designerFrame.locator('#newAnalysisPlot button:has-text("Criar plot")').click();
    const customPlot = designerFrame.locator('.plots [data-analysis-plot-id]').filter({ hasText: "Disturbance output" });
    await customPlot.waitFor({ state: "visible" });
    if (await customPlot.locator("svg polyline").count() === 0) throw new Error("custom response plot was created without a rendered response curve");
    await customPlot.locator(".analysisPlotProperties").evaluate(details => { details.open = true; });
    const normalizeStep = customPlot.getByLabel("Normalizar degraus");
    await normalizeStep.check();
    await customPlot.locator(".analysisPlotProperties button").filter({ hasText: "Aplicar" }).click();
    await designerFrame.waitForFunction((id) => document.querySelector(`[data-analysis-plot-id="${id}"] svg`)?.textContent?.includes("Resposta normalizada"), await customPlot.getAttribute("data-analysis-plot-id"));
    if (!(await customPlot.locator("svg").first().textContent()).includes("Resposta normalizada")) throw new Error("step response normalization did not update the plot axis label");
    await normalizeStep.uncheck();
    await customPlot.getByLabel("Amplitude de entrada").fill("2");
    await customPlot.getByLabel("Tempo final da resposta").fill("2");
    await customPlot.getByLabel("Amostras da resposta").fill("51");
    await customPlot.locator(".analysisPlotProperties button").filter({ hasText: "Aplicar" }).click();
    const responsePointCount = await customPlot.locator("svg polyline").first().evaluate((line) => (line.getAttribute("points") || "").trim().split(/\s+/).length);
    if (responsePointCount !== 51) throw new Error(`custom response plot ignored its 51-sample setting (${responsePointCount})`);
    await customPlot.getByLabel("Atraso da entrada").fill("0.4");
    await customPlot.locator(".analysisPlotProperties button").filter({ hasText: "Aplicar" }).click();
    const delayedInitialLevels = await customPlot.locator("svg polyline").first().evaluate((line) => (line.getAttribute("points") || "").trim().split(/\s+/).slice(0, 10).map((point) => point.split(",")[1]));
    if (new Set(delayedInitialLevels).size !== 1) throw new Error("step response input delay did not hold the output at zero before the delay");
    await customPlot.getByLabel("Subida início (%)").fill("20");
    await customPlot.getByLabel("Subida fim (%)").fill("80");
    await customPlot.getByLabel("Acomodação (%)").fill("5");
    await customPlot.locator(".analysisPlotProperties button").filter({ hasText: "Aplicar" }).click();
    if (await customPlot.locator("svg title").filter({ hasText: "Tempos de cruzamento de 20% e 80%" }).count() !== 1) throw new Error("custom step plot ignored its rise-time threshold settings");
    await customPlot.getByLabel("Instantes de tempo da resposta").fill("0, 0.05, 0.15, 0.4, 1, 2");
    await customPlot.locator(".analysisPlotProperties button").filter({ hasText: "Aplicar" }).click();
    const requestedTimePoints = await customPlot.locator("svg polyline").first().evaluate((line) => (line.getAttribute("points") || "").trim().split(/\s+/).map((point) => Number(point.split(",")[0])));
    if (requestedTimePoints.length !== 6 || new Set(requestedTimePoints.slice(1).map((x, index) => +(x - requestedTimePoints[index]).toFixed(3))).size < 3) throw new Error("custom analysis plot did not use the requested nonuniform time vector");
    const customPlotToggle = designerFrame.locator('#plotManager input[aria-label="Exibir Disturbance output"]');
    await customPlotToggle.uncheck();
    if (!(await customPlot.evaluate((card) => card.hidden))) throw new Error("plot manager did not hide a custom analysis plot");
    await customPlotToggle.check();
    await customPlot.locator('button[aria-label^="Remover plot"]').click();
    if (await designerFrame.locator('.plots [data-analysis-plot-id]').count() !== 0) throw new Error("custom analysis plot was not removed");
    const biasControllerNum = designerFrame.locator('[data-model="C"][data-part="num"]'), biasControllerDen = designerFrame.locator('[data-model="C"][data-part="den"]');
    const previousBiasController = await Promise.all([biasControllerNum.inputValue(), biasControllerDen.inputValue()]);
    await biasControllerNum.fill("4"); await biasControllerNum.dispatchEvent("input");
    await biasControllerDen.fill("1"); await biasControllerDen.dispatchEvent("input");
    await designerFrame.locator("#newAnalysisPlot summary").click();
    await designerFrame.locator("#analysisPlotName").fill("Reference response with bias");
    await designerFrame.locator("#analysisPlotInput").selectOption("reference");
    await designerFrame.locator("#analysisPlotOutput").selectOption("output");
    await designerFrame.locator("#analysisPlotType").selectOption("step");
    await designerFrame.locator('#newAnalysisPlot button:has-text("Criar plot")').click();
    const biasedPlot = designerFrame.locator('.plots [data-analysis-plot-id]').filter({ hasText: "Reference response with bias" });
    await biasedPlot.waitFor({ state: "visible" });
    await biasedPlot.locator(".analysisPlotProperties").evaluate(details => { details.open = true; });
    await biasedPlot.getByLabel("Bias de entrada").fill("1");
    await biasedPlot.locator(".analysisPlotProperties button").filter({ hasText: "Aplicar" }).click();
    const initialBiasedReadout = await biasedPlot.locator("svg").first().evaluate((svg) => {
      const line = svg.querySelector("polyline"); if (!line) return `render error: ${svg.textContent}`;
      const coords = (line.getAttribute("points") || "").trim().split(/\s+/)[0].split(",").map(Number), point = svg.createSVGPoint();
      point.x = coords[0]; point.y = coords[1]; const screen = point.matrixTransform(svg.getScreenCTM());
      svg.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: screen.x, clientY: screen.y }));
      return svg.querySelector('[data-plot-readout="text"]')?.textContent;
    });
    if (!/y = 1\.0+/.test(initialBiasedReadout || "")) throw new Error(`StepPlot input bias did not set the initial steady output: ${initialBiasedReadout}`);
    await biasedPlot.locator('button[aria-label^="Remover plot"]').click();
    await biasControllerNum.fill(previousBiasController[0]); await biasControllerNum.dispatchEvent("input");
    await biasControllerDen.fill(previousBiasController[1]); await biasControllerDen.dispatchEvent("input");
    await designerFrame.locator("#newAnalysisPlot summary").click();
    const savedArbitraryModel = await Promise.all([plantNumField.inputValue(), plantDenField.inputValue(), controllerNumField.inputValue(), controllerDenField.inputValue()]);
    await plantNumField.fill("1"); await plantDenField.fill("1, 1"); await plantDenField.dispatchEvent("change"); await plantNumField.dispatchEvent("change");
    await controllerNumField.fill("4"); await controllerDenField.fill("1"); await controllerDenField.dispatchEvent("change"); await controllerNumField.dispatchEvent("change");
    await designerFrame.locator("#stateSpaceEditor summary").click();
    await designerFrame.locator("#ssA").fill("-1"); await designerFrame.locator("#ssB").fill("1"); await designerFrame.locator("#ssC").fill("1"); await designerFrame.locator("#ssD").fill("0"); await designerFrame.locator("#ssX0").fill("0");
    await designerFrame.locator("#applyStateSpace").click();
    await designerFrame.locator("#analysisPlotMode").selectOption("standard");
    await designerFrame.locator("#analysisPlotPath").selectOption("output");
    await designerFrame.locator("#analysisPlotName").fill("Arbitrary input response");
    await designerFrame.locator("#analysisPlotType").selectOption("lsim");
    await designerFrame.locator("#analysisLsimTimes").fill("0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1");
    await designerFrame.locator("#analysisLsimValues").fill("0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1");
    await designerFrame.locator('#newAnalysisPlot button:has-text("Criar plot")').click();
    const arbitraryPlot = designerFrame.locator('.plots [data-analysis-plot-id]').filter({ hasText: "Arbitrary input response" });
    await arbitraryPlot.waitFor({ state: "visible" });
    await arbitraryPlot.locator(".analysisPlotProperties").evaluate(details => { details.open = true; });
    const lsimInitialStateDiagnostics=await arbitraryPlot.evaluate(card=>{const field=card.querySelector('textarea[aria-label="Estado inicial da resposta"]');return{status:document.querySelector("#stateSpaceStatus")?.textContent,fieldPresent:!!field,fieldHidden:field?.parentElement?.hidden,plotType:card.querySelector("h2")?.textContent}});
    if(!lsimInitialStateDiagnostics.fieldPresent||lsimInitialStateDiagnostics.fieldHidden)throw new Error("lsim initial state field unavailable: "+JSON.stringify(lsimInitialStateDiagnostics));
    await arbitraryPlot.getByLabel("Estado inicial da resposta").fill("2");
    await arbitraryPlot.locator(".analysisPlotProperties button").filter({ hasText: "Aplicar" }).click();
    const arbitraryFinal = await arbitraryPlot.locator("svg").first().evaluate(svg => {
      const raw=svg.querySelector("polyline")?.getAttribute("points")??"",points=raw.trim().split(/\s+/).map(pair=>pair.split(",").map(Number));
      const [x,y]=points.at(-2)??[];if(!Number.isFinite(x)||!Number.isFinite(y))return{error:svg.textContent,points:raw.slice(-160)};
      return{time:(x-48)/577,value:(260-y)*2/248};
    });
    if (!Number.isFinite(arbitraryFinal?.value)||Math.abs(arbitraryFinal.value-0.81077)>.001||Math.abs(arbitraryFinal.time-.9)>.001) throw new Error("arbitrary input response with initial state did not match the expected time and value: " + JSON.stringify(arbitraryFinal));
    await controllerNumField.fill("2"); await controllerNumField.dispatchEvent("input");
    await designerFrame.locator("#saveAlt").click();
    await designerFrame.locator("#altName").fill("E2E x0 overlay");
    await designerFrame.locator("#dialogSave").click();
    await controllerNumField.fill("4"); await controllerNumField.dispatchEvent("input");
    await designerFrame.locator("#compare").click();
    await designerFrame.waitForFunction(() => { const card=Array.from(document.querySelectorAll("[data-analysis-plot-id]")).find(item=>item.textContent?.includes("Arbitrary input response"));const titles=Array.from(card?.querySelectorAll(".analysisPlotGraphs svg polyline title")??[]).map(title=>title.textContent??""),peaks=card?.querySelectorAll('.analysisPlotGraphs svg [data-response-characteristic="peak"]')??[];return titles.some(title=>title.includes("Ativo"))&&titles.some(title=>title.includes("E2E x0 overlay"))&&peaks.length===2 },null,{timeout:10000});
    await designerFrame.locator("#compareSelection").evaluate(panel=>{panel.open=true});
    await designerFrame.locator('#compareSelection input[data-compare-key="alternative:E2E x0 overlay"]').uncheck();
    await designerFrame.locator("#compareSelection").evaluate(panel=>{panel.open=false});
    await arbitraryPlot.locator('button[aria-label^="Remover plot"]').click();
    await designerFrame.locator("#lqgStateWeight").fill("[[1, 0], [0, 1]]");
    await designerFrame.locator("#lqgSynthesize").click();
    if (!(await designerFrame.locator("#error").textContent())?.includes("1 by 1")) throw new Error("LQG accepted a weighting matrix with a dimension different from the state count");
    await designerFrame.locator("#lqgStateWeight").fill("[[2]]");
    await designerFrame.locator("#lqgProcessNoise").fill("[[0.5]]");
    await designerFrame.locator("#lqgControlWeight").fill("2");
    await designerFrame.locator("#lqgIntegralWeight").fill("3");
    await designerFrame.locator("#lqgStateControlCross").fill("[0.2]");
    await designerFrame.locator("#lqgProcessMeasurementCross").fill("[0.1]");
    await designerFrame.locator("#lqgSynthesize").click();
    if ((await designerFrame.locator("#error").textContent())?.trim()) throw new Error(`matrix-weighted LQG synthesis failed: ${await designerFrame.locator("#error").textContent()}`);
    if (!(await designerFrame.locator("#lqgOrderValue").textContent())?.includes("obtida")) throw new Error("matrix-weighted LQG did not report its achieved order");
    const zeroFeedthroughController=[await controllerNumField.inputValue(),await controllerDenField.inputValue()];
    await designerFrame.locator("#ssD").fill("0.25");
    await designerFrame.locator("#applyStateSpace").click();
    await designerFrame.locator("#lqgSynthesize").click();
    if ((await designerFrame.locator("#error").textContent())?.trim()) throw new Error(`LQG rejected a plant with known direct feedthrough: ${await designerFrame.locator("#error").textContent()}`);
    const feedthroughController=[await controllerNumField.inputValue(),await controllerDenField.inputValue()];
    if (JSON.stringify(feedthroughController)===JSON.stringify(zeroFeedthroughController)) throw new Error("LQG direct-feedthrough term did not alter the synthesized observer/controller");
    await designerFrame.locator("#ssD").fill("0");
    await designerFrame.locator("#applyStateSpace").click();
    await controllerNumField.fill(savedArbitraryModel[2]); await controllerDenField.fill(savedArbitraryModel[3]); await controllerDenField.dispatchEvent("change"); await controllerNumField.dispatchEvent("change");
    await designerFrame.locator("#clearStateSpace").click();
    await plantNumField.fill(savedArbitraryModel[0]); await plantDenField.fill(savedArbitraryModel[1]); await plantDenField.dispatchEvent("change"); await plantNumField.dispatchEvent("change");
    await designerFrame.locator("#newAnalysisPlot summary").click();
    await designerFrame.locator("#analysisPlotMode").selectOption("inputOutput");
    await designerFrame.locator("#analysisPlotName").fill("Disturbance control effort");
    await designerFrame.locator("#analysisPlotOutput").selectOption("control");
    await designerFrame.locator('#newAnalysisPlot button:has-text("Criar plot")').click();
    const disturbanceControlPlot = designerFrame.locator('.plots [data-analysis-plot-id]').filter({ hasText: "Disturbance control effort" });
    await disturbanceControlPlot.waitFor({ state: "visible" });
    if (await disturbanceControlPlot.locator("svg polyline").count() === 0) throw new Error("disturbance-to-control transfer did not render");
    await disturbanceControlPlot.locator('button[aria-label^="Remover plot"]').click();
    await designerFrame.locator("#newAnalysisPlot summary").click();
    await designerFrame.locator("#analysisPlotName").fill("Summing junction error");
    await designerFrame.locator("#analysisPlotInput").selectOption("reference");
    await designerFrame.locator("#analysisPlotOutput").selectOption("error");
    await designerFrame.locator('#newAnalysisPlot button:has-text("Criar plot")').click();
    const errorPlot = designerFrame.locator('.plots [data-analysis-plot-id]').filter({ hasText: "Summing junction error" });
    await errorPlot.waitFor({ state: "visible" });
    if (await errorPlot.locator("svg polyline").count() === 0) throw new Error("reference-to-error transfer did not render");
    await errorPlot.locator('button[aria-label^="Remover plot"]').click();
    await designerFrame.locator("#newAnalysisPlot summary").click();
    await designerFrame.locator("#analysisPlotName").fill("Plant input disturbance");
    await designerFrame.locator("#analysisPlotInput").selectOption("plantInputDisturbance");
    await designerFrame.locator("#analysisPlotOutput").selectOption("plantInput");
    await designerFrame.locator('#newAnalysisPlot button:has-text("Criar plot")').click();
    const plantInputPlot = designerFrame.locator('.plots [data-analysis-plot-id]').filter({ hasText: "Plant input disturbance" });
    await plantInputPlot.waitFor({ state: "visible" });
    if (await plantInputPlot.locator("svg polyline").count() === 0) throw new Error("plant-input disturbance transfer did not render");
    await plantInputPlot.locator('button[aria-label^="Remover plot"]').click();
    await designerFrame.locator("#newAnalysisPlot summary").click();
    await designerFrame.locator("#analysisPlotName").fill("Open loop reference to output");
    await designerFrame.locator("#analysisPlotInput").selectOption("reference");
    await designerFrame.locator("#analysisPlotOutput").selectOption("output");
    await designerFrame.locator("#analysisPlotLoopOpening").selectOption("feedbackSensor");
    await designerFrame.locator('#newAnalysisPlot button:has-text("Criar plot")').click();
    const openLoopPlot = designerFrame.locator('.plots [data-analysis-plot-id]').filter({ hasText: "Open loop reference to output" });
    await openLoopPlot.waitFor({ state: "visible" });
    const openLoopTitle = await openLoopPlot.locator("h2").innerText(), openLoopCurveCount = await openLoopPlot.locator("svg polyline").count(); if (!/malha aberta em H.*y/.test(openLoopTitle) || openLoopCurveCount === 0) throw new Error(`the selected feedback loop opening was not applied: title=${openLoopTitle}, curves=${openLoopCurveCount}`);
    await openLoopPlot.locator('button[aria-label^="Remover plot"]').click();
    await designerFrame.locator("#architecture").selectOption("feedback-controller");
    await designerFrame.locator("#newAnalysisPlot summary").click();
    await designerFrame.locator("#analysisPlotName").fill("Feedback controller open response");
    await designerFrame.locator("#analysisPlotMode").selectOption("inputOutput");
    await designerFrame.locator("#analysisPlotInput").selectOption("reference");
    await designerFrame.locator("#analysisPlotOutput").selectOption("output");
    await designerFrame.locator("#analysisPlotLoopOpening").selectOption("feedbackSensor");
    await designerFrame.locator('#newAnalysisPlot button:has-text("Criar plot")').click();
    const feedbackOpenPlot = designerFrame.locator('.plots [data-analysis-plot-id]').filter({ hasText: "Feedback controller open response" });
    await feedbackOpenPlot.waitFor({ state: "visible" });
    if (await feedbackOpenPlot.locator("svg polyline").count() === 0) throw new Error("feedback-controller open-loop response did not render");
    await feedbackOpenPlot.locator('button[aria-label^="Remover plot"]').click();
    await designerFrame.locator("#architecture").selectOption("nested-inner-feedback");
    const nestedOpeningState = await designerFrame.locator("#analysisPlotLoopOpening").evaluate((select) => Object.fromEntries(["feedbackSensor", "innerFeedbackSensor", "allFeedbackSensors"].map((value) => [value, select.querySelector(`option[value=${value}]`).disabled])));
    if (Object.values(nestedOpeningState).some(Boolean)) throw new Error(`nested feedback openings must be available: ${JSON.stringify(nestedOpeningState)}`);
    for (const [value, output, label] of [["innerFeedbackSensor", "innerError", "Inner error with inner loop open"], ["feedbackSensor", "outerSensorOutput", "Outer sensor with outer loop open"], ["allFeedbackSensors", "innerControllerOutput", "Inner controller with both loops open"], ["none", "innerSensorOutput", "Inner sensor closed loop"]]) {
      await designerFrame.locator("#newAnalysisPlot summary").click();
      await designerFrame.locator("#analysisPlotName").fill(label);
      await designerFrame.locator("#analysisPlotMode").selectOption("inputOutput");
      await designerFrame.locator("#analysisPlotInput").selectOption("reference");
      await designerFrame.locator("#analysisPlotOutput").selectOption(output);
      await designerFrame.locator("#analysisPlotLoopOpening").selectOption(value);
      await designerFrame.locator('#newAnalysisPlot button:has-text("Criar plot")').click();
      const nestedPlot = designerFrame.locator('.plots [data-analysis-plot-id]').filter({ hasText: label });
      await nestedPlot.waitFor({ state: "visible" });
      if (await nestedPlot.locator("svg polyline").count() === 0) throw new Error(`${label} response did not render`);
      await nestedPlot.locator('button[aria-label^="Remover plot"]').click();
    }
    await designerFrame.locator("#architecture").selectOption("forward-controller");
    await designerFrame.evaluate(() => document.querySelector("#plotManager summary").click());
    await designerFrame.locator("#plantVariantName").fill("Robust plant");
    await designerFrame.locator("#savePlantVariant").click();
    await designerFrame.waitForFunction(() => document.querySelectorAll("#plantVariants [data-plant-remove]").length === 1);
    await designerFrame.locator("#plantVariantArrayFile").setInputFiles({ name: "model-array.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ plants: [{ num: [1], den: [1, 2] }, { num: [2], den: [1, 3] }], sensors: [{ num: [1], den: [1] }, { num: [1], den: [1, 0.2] }] })) });
    const measuredFrequencies=[0.1,0.3,1,3], measuredFrd={sourceUnit:"rad/s",frequencyRadPerSecond:measuredFrequencies,response:measuredFrequencies.map(w=>({re:1/(1+0.01*w*w),im:-0.1*w/(1+0.01*w*w)}))};
    await designerFrame.locator("#plantVariantArrayFile").setInputFiles({name:"frd-array.json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify({models:[{name:"FRD measured model",plant:{num:[1],den:[1,2]},plantFrd:measuredFrd,sensor:{num:[1],den:[1]},sensorFrd:{...measuredFrd,response:measuredFrd.response.map(point=>({re:point.re*0.8,im:point.im*0.8}))}}]}))});
    await designerFrame.waitForFunction(()=>document.querySelectorAll("#plantVariants [data-plant-remove]").length===4);
    if(!(await designerFrame.locator("#plantVariants").innerText()).includes("FRD medido (4 pontos)"))throw new Error("FRD data was not preserved on the imported model variant");
    if(!(await designerFrame.locator("#plantVariants").innerText()).includes("H FRD medido (4 pontos)"))throw new Error("measured FRD sensor data was not preserved on the imported model variant");
    await designerFrame.locator("#compare").click();
    await designerFrame.waitForFunction(()=>document.querySelectorAll("#bode [data-custom-frequency]").length>=4);
    const frdVariantFrequencies=await designerFrame.locator("#bode [data-custom-frequency]").evaluateAll(circles=>[...new Set(circles.map(circle=>Number(circle.getAttribute("data-custom-frequency"))))].sort((a,b)=>a-b));
    if(JSON.stringify(frdVariantFrequencies)!==JSON.stringify(measuredFrequencies))throw new Error(`FRD variant Bode did not use its measured frequency grid: ${JSON.stringify(frdVariantFrequencies)}`);
    await designerFrame.locator('#plantVariants [data-plant-remove="3"]').click();
    await designerFrame.waitForFunction(()=>document.querySelectorAll("#plantVariants [data-plant-remove]").length===3);
    await designerFrame.waitForFunction(() => document.querySelectorAll("#plantVariants [data-plant-remove]").length === 3);
    const importedVariantText = await designerFrame.locator("#plantVariants").innerText();
    if (!importedVariantText.includes("Modelo importado 1") || !importedVariantText.includes("Modelo importado 2")) throw new Error(`model-array import did not create its two variants: ${importedVariantText}`);
    await designerFrame.locator('#plantVariants [data-plant-remove="2"]').click();
    await designerFrame.locator('#plantVariants [data-plant-remove="1"]').click();
    await designerFrame.waitForFunction(() => document.querySelectorAll("#plantVariants [data-plant-remove]").length === 1);
    await designerFrame.locator("#plantUncertaintySampling summary").evaluate(summary => { const details = summary.closest("details"); if (details) details.open = true; });
    await designerFrame.locator("#uncertaintySampleCount").fill("3");
    await designerFrame.locator("#plantTolerancePercent").fill("10");
    await designerFrame.locator("#sensorTolerancePercent").fill("5");
    await designerFrame.locator("#uncertaintySeed").fill("42");
    await designerFrame.locator("#generateUncertaintyVariants").click();
    await designerFrame.waitForFunction(() => document.querySelectorAll("#plantVariants [data-plant-remove]").length === 4);
    if (!(await designerFrame.locator("#plantUncertaintySampling").innerText()).includes("3 variantes adicionadas; semente 42")) throw new Error("uncertainty sampler did not report its generated reproducible set");
    for (const index of [3, 2, 1]) await designerFrame.locator(`#plantVariants [data-plant-remove="${index}"]`).click();
    await designerFrame.waitForFunction(() => document.querySelectorAll("#plantVariants [data-plant-remove]").length === 1);
    const savedNominalN = await designerFrame.locator('[data-model="G"][data-part="num"]').inputValue();
    const displacedN = String(Number(savedNominalN.split(",")[0]) + 3);
    await designerFrame.locator('[data-model="G"][data-part="num"]').fill(displacedN);
    await designerFrame.locator('[data-model="G"][data-part="num"]').dispatchEvent("change");
    await designerFrame.locator('#plantVariants [data-plant-nominal="0"]').click();
    if (await designerFrame.locator('[data-model="G"][data-part="num"]').inputValue() !== savedNominalN) throw new Error("choosing a nominal model did not activate the selected plant model");
    if (!(await designerFrame.locator("#plantVariants").innerText()).includes(displacedN)) throw new Error("nominal switch did not preserve the previous model as a variant");
    await designerFrame.locator("#frequencyGrid").fill("0.1, 1, 17");
    await designerFrame.locator("#frequencyGrid").dispatchEvent("change");
    await designerFrame.locator("#compare").click();
    await designerFrame.waitForFunction(() => document.querySelectorAll('#bode [data-custom-frequency]').length >= 3);
    const customVariantFrequencies = await designerFrame.locator('#bode [data-custom-frequency]').evaluateAll((circles) => [...new Set(circles.map((circle) => Number(circle.getAttribute("data-custom-frequency"))))].sort((a, b) => a - b));
    if (JSON.stringify(customVariantFrequencies) !== JSON.stringify([0.1, 1, 17])) throw new Error(`comparison Bode did not plot the exact custom variant grid: ${JSON.stringify(customVariantFrequencies)}`);
    await designerFrame.locator("#frequencyGrid").fill("");
    await designerFrame.locator("#frequencyGrid").dispatchEvent("change");
    await designerFrame.locator("#preset").selectOption("PI");
    const prefilterNumBeforeOptimization = await designerFrame.locator('[data-model="F"][data-part="num"]').inputValue();
    const unselectedKiBefore = await designerFrame.locator("#p1").inputValue();
    await designerFrame.locator("#optimizerOptions summary").click();
    await designerFrame.locator("#optimizerRequireStableVariants").check();
    if (!(await designerFrame.locator("#optimizerRequireStableVariants").isChecked())) throw new Error("multimodel stability constraint did not enable");
    await designerFrame.locator('#optimizerSettings [data-opt-key="ki"]').uncheck();
    await designerFrame.locator('[data-opt-start="prefilterGain"]').fill("1.5");
    await designerFrame.locator('[data-opt-min="prefilterGain"]').fill("1.4");
    await designerFrame.locator('[data-opt-max="prefilterGain"]').fill("1.6");
    await designerFrame.locator('[data-opt-scale="prefilterGain"]').fill("0.1");
    await designerFrame.locator('[data-opt-start="kp"]').fill("0.8");
    await designerFrame.locator('[data-opt-min="kp"]').fill("0.2");
    await designerFrame.locator('[data-opt-max="kp"]').fill("1.2");
    await designerFrame.locator('[data-opt-scale="kp"]').fill("0.2");
    await designerFrame.locator("#optimizationIterations").fill("1");
    await designerFrame.locator('button:has-text("Otimizar parametros selecionados")').click();
    await designerFrame.waitForFunction(() => document.querySelector("#saved")?.textContent?.includes("Busca local") || Boolean(document.querySelector("#error")?.textContent?.trim()), null, { timeout: 30000 });
    if (await designerFrame.locator("#error").textContent()) throw new Error(`optimizer failed with selected parameters and bounds: ${await designerFrame.locator("#error").textContent()}`);
    const optimizationReport = await designerFrame.locator("#saved").innerText();
    if (!optimizationReport.includes("pior caso") || !optimizationReport.includes("Por planta:")) throw new Error(`optimizer did not report robust worst-case scoring across plant variants: ${optimizationReport}`);
    const tunedKp = Number(await designerFrame.locator("#p0").inputValue());
    if (tunedKp < 0.2 || tunedKp > 1.2 || await designerFrame.locator("#p1").inputValue() !== unselectedKiBefore) throw new Error("optimizer ignored the selected parameter set or Kp bounds");
    const prefilterNumAfterOptimization = await designerFrame.locator('[data-model="F"][data-part="num"]').inputValue();
    if (prefilterNumAfterOptimization === prefilterNumBeforeOptimization) throw new Error("requirement optimizer did not apply its selected prefilter gain to F");
    await designerFrame.locator("#architecture").selectOption("forward-controller");
    if (!(await designerFrame.locator("#optimizerOptions").evaluate((details) => details.open))) await designerFrame.locator("#optimizerOptions summary").click();
    await designerFrame.locator('[data-model="F"][data-part="num"]').fill("1, 1");
    await designerFrame.locator('[data-model="F"][data-part="den"]').fill("1, 3");
    await designerFrame.locator("#addReq").click();
    await designerFrame.locator("#reqKind").selectOption("gainLimitUpper");
    await designerFrame.locator("#reqPath").selectOption("output");
    await designerFrame.locator("#reqValue").fill("-18");
    await designerFrame.locator("#reqFreqStart").fill("0.5");
    await designerFrame.locator("#reqFreqEnd").fill("5");
    await designerFrame.locator("#reqFreqValueEnd").fill("-18");
    await designerFrame.locator("#dialogSave").click();
    const prefilterPoleKey = await designerFrame.locator('#optimizerSettings [data-opt-key^="prefilter_manual_pole_"]').first().getAttribute("data-opt-key");
    if (!prefilterPoleKey) throw new Error("requirement optimizer did not expose the prefilter pole");
    await designerFrame.locator('#optimizerSettings [data-opt-key]').evaluateAll((inputs) => inputs.forEach((input) => { input.checked = false; }));
    await designerFrame.locator(`[data-opt-key="${prefilterPoleKey}"]`).check();
    await designerFrame.locator(`[data-opt-start="${prefilterPoleKey}"]`).fill("-3");
    await designerFrame.locator(`[data-opt-min="${prefilterPoleKey}"]`).fill("-12");
    await designerFrame.locator(`[data-opt-max="${prefilterPoleKey}"]`).fill("-2");
    await designerFrame.locator(`[data-opt-scale="${prefilterPoleKey}"]`).fill("3");
    await designerFrame.locator("#optimizationIterations").fill("1");
    await designerFrame.locator('button:has-text("Otimizar parametros selecionados")').click();
    await designerFrame.waitForFunction(() => document.querySelector("#saved")?.textContent?.includes("Busca local") || Boolean(document.querySelector("#error")?.textContent?.trim()), null, { timeout: 30000 });
    if (await designerFrame.locator("#error").textContent()) throw new Error(`prefilter pole optimization failed: ${await designerFrame.locator("#error").textContent()}`);
    const optimizedPrefilterDenominator = await designerFrame.locator('[data-model="F"][data-part="den"]').inputValue();
    if (optimizedPrefilterDenominator === "1, 3") throw new Error("requirement optimizer did not apply its selected prefilter pole");
    await designerFrame.locator("#filterGain").fill("6");
    if (await designerFrame.locator('[data-model="F"][data-part="den"]').inputValue() !== optimizedPrefilterDenominator) throw new Error("prefilter gain slider discarded the optimized F pole");
    await designerFrame.locator("#filterGain").fill("0");
    await designerFrame.locator("#requirements .req").last().locator("button[data-remove]").click();
    await designerFrame.locator('[data-model="F"][data-part="num"]').fill("1");
    await designerFrame.locator('[data-model="F"][data-part="den"]').fill("1");
    await designerFrame.locator('[data-model="F"][data-part="num"]').dispatchEvent("change");
    const fixedStructureDenominator = await designerFrame.locator('[data-model="C"][data-part="den"]').inputValue();
    await designerFrame.locator("#preset").selectOption("manual");
    if (!(await designerFrame.locator("#optimizerOptions").evaluate((details) => details.open))) await designerFrame.locator("#optimizerOptions summary").click();
    await designerFrame.locator('[data-opt-start="kp"]').fill("1");
    await designerFrame.locator('[data-opt-min="kp"]').fill("0.5");
    await designerFrame.locator('[data-opt-max="kp"]').fill("1.5");
    await designerFrame.locator('[data-opt-scale="kp"]').fill("0.25");
    await designerFrame.locator("#optimizationIterations").fill("1");
    await designerFrame.locator('button:has-text("Otimizar parametros selecionados")').click();
    await designerFrame.waitForFunction(() => document.querySelector("#saved")?.textContent?.includes("Busca local") || Boolean(document.querySelector("#error")?.textContent?.trim()), null, { timeout: 30000 });
    if (await designerFrame.locator("#error").textContent()) throw new Error(`manual controller gain optimization failed: ${await designerFrame.locator("#error").textContent()}`);
    if (await designerFrame.locator('[data-model="C"][data-part="den"]').inputValue() !== fixedStructureDenominator) throw new Error("manual controller optimization changed the fixed compensator structure");
    const poleKey = await designerFrame.locator('#optimizerSettings [data-opt-key^="manual_pole_"]').first().getAttribute("data-opt-key");
    if (!poleKey) throw new Error("manual rational optimizer did not expose individual pole parameters");
    await designerFrame.locator('[data-opt-key="kp"]').uncheck();
    await designerFrame.locator(`[data-opt-key="${poleKey}"]`).check();
    await designerFrame.locator('#optimizerSettings summary').click().catch(() => {});
    await designerFrame.locator('button:has-text("Otimizar parametros selecionados")').click();
    await designerFrame.waitForFunction(() => document.querySelector("#saved")?.textContent?.includes("Busca local") || Boolean(document.querySelector("#error")?.textContent?.trim()), null, { timeout: 30000 });
    if (await designerFrame.locator("#error").textContent()) throw new Error(`manual pole optimization failed: ${await designerFrame.locator("#error").textContent()}`);
    await designerFrame.locator("#architecture").selectOption("nested-inner-feedback");
    await designerFrame.locator("#preset").selectOption("P");
    if (!(await designerFrame.locator("#optimizerOptions").evaluate((details) => details.open))) await designerFrame.locator("#optimizerOptions summary").click();
    if (await designerFrame.locator('#optimizerSettings [data-opt-key^="prefilter_manual_"]').count()) throw new Error("optimizer exposed F parameters although architecture 4 does not connect the prefilter");
    const secondaryGain = designerFrame.locator('#optimizerSettings [data-opt-key="secondaryGain"]');
    await secondaryGain.check();
    await designerFrame.locator('[data-opt-key="kp"]').uncheck();
    await designerFrame.locator('[data-opt-start="secondaryGain"]').fill("1");
    await designerFrame.locator('[data-opt-min="secondaryGain"]').fill("0.5");
    await designerFrame.locator('[data-opt-max="secondaryGain"]').fill("1.5");
    await designerFrame.locator('[data-opt-scale="secondaryGain"]').fill("0.25");
    await designerFrame.locator("#optimizationIterations").fill("1");
    const innerCompensatorBefore = await designerFrame.locator('[data-model="C2"][data-part="num"]').inputValue();
    await designerFrame.locator('button:has-text("Otimizar parametros selecionados")').click();
    await designerFrame.waitForFunction(() => document.querySelector("#saved")?.textContent?.includes("Busca local") || Boolean(document.querySelector("#error")?.textContent?.trim()), null, { timeout: 30000 });
    if (await designerFrame.locator("#error").textContent()) throw new Error(`nested secondary compensator optimization failed: ${await designerFrame.locator("#error").textContent()}`);
    if (await designerFrame.locator('[data-model="C2"][data-part="num"]').inputValue() === innerCompensatorBefore) throw new Error("selected secondary compensator gain was not applied");
    await designerFrame.locator('[data-model="C2"][data-part="den"]').fill("1, 2");
    await designerFrame.locator('[data-model="C2"][data-part="den"]').dispatchEvent("change");
    await designerFrame.locator("#preset").selectOption("manual");
    const secondaryPoleKey = await designerFrame.locator('#optimizerSettings [data-opt-key^="secondary_manual_pole_"]').first().getAttribute("data-opt-key");
    if (!secondaryPoleKey) throw new Error("manual optimizer did not expose the secondary compensator pole");
    await designerFrame.locator('#optimizerSettings [data-opt-key="secondaryGain"]').uncheck();
    await designerFrame.locator(`[data-opt-key="${secondaryPoleKey}"]`).check();
    await designerFrame.locator(`[data-opt-start="${secondaryPoleKey}"]`).fill("-3.5");
    await designerFrame.locator(`[data-opt-min="${secondaryPoleKey}"]`).fill("-4");
    await designerFrame.locator(`[data-opt-max="${secondaryPoleKey}"]`).fill("-3");
    await designerFrame.locator(`[data-opt-scale="${secondaryPoleKey}"]`).fill("0.5");
    const innerPoleDenominator = await designerFrame.locator('[data-model="C2"][data-part="den"]').inputValue();
    await designerFrame.locator('button:has-text("Otimizar parametros selecionados")').click();
    await designerFrame.waitForFunction(() => document.querySelector("#saved")?.textContent?.includes("Busca local") || Boolean(document.querySelector("#error")?.textContent?.trim()), null, { timeout: 30000 });
    if (await designerFrame.locator("#error").textContent()) throw new Error(`secondary pole optimization failed: ${await designerFrame.locator("#error").textContent()}`);
    if (await designerFrame.locator('[data-model="C2"][data-part="den"]').inputValue() === innerPoleDenominator) throw new Error("selected secondary compensator pole was not applied");
    await designerFrame.locator("#architecture").selectOption("forward-controller");
    const rootRequirementPathsBefore = await designerFrame.locator("#rl path").count();
    const requirementsBefore = await designerFrame.locator("#requirements .req").count();
    const plotForm = designerFrame.locator("#newAnalysisPlot");
    if (!(await plotForm.evaluate((details) => details.open))) await plotForm.locator("summary").click();
    await designerFrame.locator("#analysisPlotName").fill("Pole requirements");
    await designerFrame.locator("#analysisPlotType").selectOption("poleZero");
    await designerFrame.locator('#newAnalysisPlot button:has-text("Criar plot")').click();
    const poleRequirementPlot = designerFrame.locator('.plots [data-analysis-plot-id]').filter({ hasText: "Pole requirements" });
    await poleRequirementPlot.waitFor({ state: "visible" });
    await poleRequirementPlot.locator("svg").first().click({ button: "right", position: { x: 100, y: 80 } });
    const addPlotRequirement = poleRequirementPlot.getByRole("menuitem", { name: "Novo requisito para este plot" });
    await addPlotRequirement.click();
    await designerFrame.locator("#designerDialog").waitFor({ state: "visible" });
    await designerFrame.locator("#reqKind").selectOption("overshoot");
    await designerFrame.locator("#reqValue").fill("20");
    await designerFrame.locator("#dialogSave").click();
    await designerFrame.waitForTimeout(300);
    const requirementSaveState = await designerFrame.evaluate(() => ({ rows: document.querySelectorAll("#requirements .req").length, error: document.querySelector("#error")?.textContent, dialogOpen: document.querySelector("#designerDialog")?.open, mode: document.querySelector("#designerDialog")?.dataset.mode, kind: document.querySelector("#reqKind")?.value, value: document.querySelector("#reqValue")?.value, submitHandler: typeof document.querySelector("#designerDialog form")?.onsubmit }));
    if (requirementSaveState.rows !== requirementsBefore + 1) throw new Error(`requirement save did not run: ${JSON.stringify(requirementSaveState)}`);
    if (requirementSaveState.error?.trim()) throw new Error(`could not add pole plot requirement: ${requirementSaveState.error}`);
    if (requirementSaveState.dialogOpen) throw new Error("saving a design requirement must close its dialog");
    if (await designerFrame.locator("#rl path").count() <= rootRequirementPathsBefore) throw new Error("overshoot requirement was not drawn on the root locus");
    const poleRequirementStatus = await poleRequirementPlot.locator('[aria-label="Estado dos requisitos deste canal"]').innerText();
    if (!poleRequirementStatus.includes("met") && !poleRequirementStatus.includes("violated")) throw new Error(`pole requirement was not evaluated on the pole-zero plot: ${poleRequirementStatus}`);
    await poleRequirementPlot.locator('button[aria-label^="Editar plot"]').click();
    const linkedOvershoot = designerFrame.locator('#analysisPlotRequirements option').filter({ hasText: "overshoot" }).last();
    if (!(await linkedOvershoot.evaluate((option) => option.selected))) throw new Error("newest requirement created from the plot context menu was not linked to that plot");
    await designerFrame.locator("#addReq").click();
    await designerFrame.locator("#reqKind").selectOption("timeLimitUpper");
    await designerFrame.locator("#reqTimeSegments").fill("0, 0, 1, 0, 1, 0.5");
    await designerFrame.locator("#dialogSave").click();
    const slopeRequirement = designerFrame.locator("#requirements .req").last();
    await slopeRequirement.locator("button[data-edit]").click();
    const slopeRoundTrip = await designerFrame.locator("#reqTimeSegments").inputValue();
    if (!/0,\s*0,\s*1,\s*0\.5,\s*1,\s*0\.5/.test(slopeRoundTrip)) throw new Error(`time-bound slope did not derive and preserve its endpoint: ${slopeRoundTrip}`);
    await designerFrame.locator('#designerDialog button[value="cancel"]').click();
    await slopeRequirement.locator("button[data-remove]").click();    await designerFrame.locator("#addReq").click();
    await designerFrame.locator("#reqKind").selectOption("gainLimitUpper");
    await designerFrame.locator("#reqGainSegments").fill("0.1, 0, 10, 0, 1, -20");
    await designerFrame.locator("#dialogSave").click();
    const frequencySlopeRequirement = designerFrame.locator("#requirements .req").last();
    await frequencySlopeRequirement.locator("button[data-edit]").click();
    const frequencySlopeRoundTrip = await designerFrame.locator("#reqGainSegments").inputValue();
    if (!/0\.1,\s*0,\s*10,\s*-40,\s*1,\s*-20/.test(frequencySlopeRoundTrip)) throw new Error(`gain-limit slope did not derive its dB endpoint across two decades: ${frequencySlopeRoundTrip}`);
    await designerFrame.locator('#designerDialog button[value="cancel"]').click();
    await frequencySlopeRequirement.locator("button[data-remove]").click();    await poleRequirementPlot.locator("svg").first().click({ button: "right", position: { x: 120, y: 100 } });
    await poleRequirementPlot.getByRole("menuitem", { name: "Novo requisito para este plot" }).click();
    await designerFrame.locator("#designerDialog").waitFor({ state: "visible" });
    await designerFrame.locator("#reqKind").selectOption("poleRegion");
    await designerFrame.locator("#reqRegionVertices").fill("-1, -2; -1, 2");
    await designerFrame.locator("#reqRegionSide").selectOption("right");
    await designerFrame.locator("#dialogSave").click();
    const poleRegionMark = designerFrame.locator('#rl [data-requirement-flip]').first();
    await poleRegionMark.waitFor({ state: "visible" });
    await poleRegionMark.evaluate(element => element.dispatchEvent(new MouseEvent("contextmenu", { button: 2, bubbles: true, cancelable: true, clientX: 120, clientY: 100 })));
    await designerFrame.locator("#rootContextMenu [data-root-context=requirement-edit]").click();
    await designerFrame.locator("#designerDialog").waitFor({ state: "visible" });
    await designerFrame.locator("#reqRegionSide").selectOption("left");
    await designerFrame.locator("#dialogSave").click();
    await designerFrame.waitForFunction(() => Array.from(document.querySelectorAll("#requirements .req")).some(row => row.textContent?.includes("polos") && row.textContent.includes("lado left")));
    const poleRegionRow = designerFrame.locator("#requirements .req").filter({ hasText: "lado left" });
    const poleRegionBeforeDrag = await poleRegionRow.innerText();
    const poleRegionHandle = designerFrame.locator('#rl [data-req-drag="poleRegion"]').first();
    const poleRegionBox = await poleRegionHandle.boundingBox();
    if (!poleRegionBox) throw new Error("pole-region vertex handle is not visible for graphical editing");
    await designerFrame.page().mouse.move(poleRegionBox.x + poleRegionBox.width / 2, poleRegionBox.y + poleRegionBox.height / 2);
    await designerFrame.page().mouse.down();
    await designerFrame.page().mouse.move(poleRegionBox.x + poleRegionBox.width / 2 + 24, poleRegionBox.y + poleRegionBox.height / 2 - 16, { steps: 4 });
    await designerFrame.page().mouse.up();
    await designerFrame.waitForFunction((before) => Array.from(document.querySelectorAll("#requirements .req")).some(row => row.textContent?.includes("lado left") && row.textContent !== before), poleRegionBeforeDrag);
    await designerFrame.locator("#addReq").click();
    await designerFrame.locator("#designerDialog").waitFor({ state: "visible" });
    await designerFrame.locator("#reqKind").selectOption("gainPhaseUpper");
    await designerFrame.locator("#reqGainPhaseVertices").fill("-200, 1\n-100, 1");
    await designerFrame.locator("#dialogSave").click();
    const gainPhaseRegionMark = designerFrame.locator('#nichols [data-requirement-flip]').first();
    await gainPhaseRegionMark.waitFor({ state: "visible" });
    await gainPhaseRegionMark.evaluate(element => element.dispatchEvent(new MouseEvent("contextmenu", { button: 2, bubbles: true, cancelable: true, clientX: 120, clientY: 100 })));
    await designerFrame.locator("#rootContextMenu [data-root-context=requirement-flip]").click();
    await designerFrame.waitForFunction(() => Array.from(document.querySelectorAll("#requirements .req")).some(row => row.textContent?.includes("gainPhaseLower")));
    await designerFrame.locator('#requirements .req button[data-remove]').last().click();
    await poleRequirementPlot.locator('button[aria-label^="Remover plot"]').click();
    await designerFrame.locator('#requirements .req button[data-remove]').last().click();
    await designerFrame.locator('#requirements .req button[data-remove]').last().click();
    await clickDesignerAction();
    let designerFrameCount = 0;
    for (const frame of workbench.frames()) {
      if (frame !== workbench.mainFrame() && await frame.locator("#gain").count()) designerFrameCount += 1;
    }
    if (designerFrameCount > 1) {
      throw new Error("clique repetido abriu instância duplicada do projeto de controle");
    }
    await workbench.keyboard.press("Control+PageUp");
    await new Promise((resolve) => setTimeout(resolve, 350));

    let schematicFrame;
    for (let attempt = 0; attempt < 80 && !schematicFrame; attempt++) {
      for (const frame of workbench.frames()) {
        if (frame === workbench.mainFrame()) continue;
        try { if (await frame.locator('.component[data-component-id="designerPlant"]').count()) { schematicFrame = frame; break; } }
        catch { /* Webview substituído durante a troca da aba ativa. */ }
      }
      if (!schematicFrame) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!schematicFrame) throw new Error("fixture sem os blocos LTI de integração");
    const plantBlock = schematicFrame.locator('.component[data-component-id="designerPlant"]');
    await plantBlock.evaluate((element) => {
      const box = element.getBoundingClientRect();
      element.setPointerCapture = () => {};
      const x = box.left + box.width / 2, y = box.top + box.height / 2;
      element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX: x, clientY: y }));
      element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX: x, clientY: y }));
    });
    await clickDesignerAction();
    await designerFrame.locator("#importCircuit").click();
    await designerFrame.waitForFunction(() => document.querySelector('[data-model="G"][data-part="num"]')?.value === "2");
    if (await designerFrame.locator('[data-model="G"][data-part="den"]').inputValue() !== "3, 1") throw new Error("importação da planta selecionada gerou coeficientes incorretos");
    if (!(await designerFrame.locator("#bindingStatus").innerText()).includes("sincronizado")) throw new Error("vínculo da planta importada não foi mostrado como sincronizado");
    await clickDesignerAction();
    await workbench.keyboard.press("Control+PageUp");
    await new Promise((resolve) => setTimeout(resolve, 350));

    // Aplicação confirmada pela UI do VS Code e histórico real da Webview.
    const gainBlock = schematicFrame.locator('.component[data-component-id="designerGain"]');
    await gainBlock.evaluate((element) => {
      const box = element.getBoundingClientRect(), x = box.left + box.width / 2, y = box.top + box.height / 2;
      element.setPointerCapture = () => {};
      element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 2, button: 0, clientX: x, clientY: y }));
      element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 2, button: 0, clientX: x, clientY: y }));
    });
    await schematicFrame.waitForFunction(() => document.querySelector('.component[data-component-id="designerGain"]')?.classList.contains("selected"), null, { timeout: 5000 });
    await clickDesignerAction();
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
        catch { /* Webview substituído durante a troca da aba ativa. */ }
      }
      if (!schematicFrame) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!schematicFrame) throw new Error("Webview do esquemático não voltou após aplicar C");
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
    if (Number(appliedGain) !== 5) throw new Error(`aplicação do controlador não atualizou Designer Gain: ${appliedGain}`);
    await schematicFrame.locator("body").click({ position: { x: 20, y: 20 } }).catch(() => {});
    await workbench.keyboard.press("Control+Z");
    await workbench.waitForTimeout(350);
    const undoneGain = await ensureGainProperties();
    if (Number(undoneGain) !== 1) throw new Error(`Ctrl+Z não desfez a aplicação do controlador: ${undoneGain}`);
    await schematicFrame.locator("body").click({ position: { x: 20, y: 20 } }).catch(() => {});
    await workbench.keyboard.press("Control+Y");
    await workbench.waitForTimeout(350);
    const redoneGain = await ensureGainProperties();
    if (Number(redoneGain) !== 5) throw new Error(`Ctrl+Y não refez a aplicação do controlador: ${redoneGain}`);

    // A named real parameter must drive every coefficient occurrence through its declared power.
    await designerFrame.locator("#plantUncertaintySampling summary").evaluate(summary => { const details = summary.closest("details"); if (details) details.open = true; });
    await designerFrame.locator("#uncertaintySampleCount").fill("4");
    await designerFrame.locator("#plantTolerancePercent").fill("0");
    await designerFrame.locator("#sensorTolerancePercent").fill("0");
    await designerFrame.locator("#uncertaintySeed").fill("456");
    await designerFrame.locator("#uncertaintySharedGroups").fill("{}");
    await designerFrame.locator("#uncertaintyParameterModel").fill(JSON.stringify({
      parameters: { p: { nominal: 1, range: [0.5, 1.5] } },
      coefficients: { "den[1]": [{ parameter: "p", power: 1 }] },
    }));
    await designerFrame.locator("#generateUncertaintyVariants").evaluate(button => button.click());
    const parameterSamples = designerFrame.locator("#plantVariants .binding-entry").filter({ hasText: "Amostra incerta 456-" });
    await designerFrame.waitForFunction(() => [...document.querySelectorAll("#plantVariants .binding-entry")].filter(item => item.textContent?.includes("Amostra incerta 456-")).length === 4);
    const sampledConstants = await parameterSamples.evaluateAll(rows => rows.map(row => {
      const denominator = row.textContent?.match(/G=[^/]+\/([^;]+)/)?.[1];
      return denominator === undefined ? NaN : Number(denominator.split(",")[1]);
    }));
    if (sampledConstants.length !== 4 || sampledConstants.some(value => !(value >= 0.5 && value <= 1.5)) || new Set(sampledConstants).size < 2) throw new Error(`parametric samples did not apply p in [0.5,1.5] to den[1]: ${JSON.stringify(sampledConstants)}`);
    while (await parameterSamples.count()) await parameterSamples.first().locator("[data-plant-remove]").evaluate(button => button.click());

    // A general safe expression must be accepted by the same UI and move its nominal coefficient with p.
    const nominalNumerator = Number((await designerFrame.locator('[data-model="G"][data-part="num"]').inputValue()).split(",")[0]);
    await designerFrame.locator("#uncertaintySeed").fill("457");
    await designerFrame.locator("#uncertaintyParameterModel").fill(JSON.stringify({
      parameters: { p: { nominal: 0, range: [-0.5, 0.5] } },
      expressions: { "num[0]": `${nominalNumerator}+p` },
    }));
    await designerFrame.locator("#generateUncertaintyVariants").evaluate(button => button.click());
    const expressionSamples = designerFrame.locator("#plantVariants .binding-entry").filter({ hasText: "Amostra incerta 457-" });
    await designerFrame.waitForFunction(() => [...document.querySelectorAll("#plantVariants .binding-entry")].filter(item => item.textContent?.includes("Amostra incerta 457-")).length === 4);
    const sampledNumerators = await expressionSamples.evaluateAll(rows => rows.map(row => {
      const numerator = row.textContent?.match(/G=([^/]+)\//)?.[1];
      return numerator === undefined ? NaN : Number(numerator.split(",")[0]);
    }));
    if (sampledNumerators.length !== 4 || sampledNumerators.some(value => Math.abs(value - nominalNumerator) > 0.5 + 1e-12) || new Set(sampledNumerators).size < 2) throw new Error(`general expression did not produce varied numerator coefficients around the nominal: ${JSON.stringify({ nominalNumerator, sampledNumerators })}`);
    while (await expressionSamples.count()) await expressionSamples.first().locator("[data-plant-remove]").evaluate(button => button.click());

    // Exercise discrete mode and arbitrary sampled input through the visible designer UI.
    await workbench.keyboard.press("Control+PageDown");
    await designerFrame.locator("#domain").waitFor({ state: "visible", timeout: 10000 });
    await designerFrame.evaluate(() => { window.confirm = () => true; });
    await designerFrame.locator("#domain").selectOption("discrete");
    const discreteShapeModels=await designerFrame.evaluate(()=>Object.fromEntries(["G","C","H"].flatMap(model=>["num","den"].map(part=>[`${model}_${part}`,document.querySelector(`[data-model="${model}"][data-part="${part}"]`)?.value]))));
    for(const model of ["G","C","H"]){for(const [part,value] of [["num","1"],["den","1"]]){const input=designerFrame.locator(`[data-model="${model}"][data-part="${part}"]`);await input.fill(value);await input.dispatchEvent("change");}}
    await designerFrame.locator("#shapeTargetPanel").evaluate(details=>{details.open=true;});
    await designerFrame.locator("#shapeTargetMode").selectOption("frd");await designerFrame.locator("#shapeTargetFrd").fill("0.1, 20\n1, 0\n10, -20");await designerFrame.locator("#shapeTargetMin").fill("0.1");await designerFrame.locator("#shapeTargetMax").fill("10");
    await designerFrame.locator("#saved").evaluate(status=>{status.textContent="";});
    await designerFrame.locator("#shapeTargetFit").click();
    await designerFrame.waitForFunction(()=>document.querySelector("#saved")?.textContent?.includes("alvo FRD")||Boolean(document.querySelector("#error")?.textContent?.trim()),null,{timeout:15000});
    if(await designerFrame.locator("#error").textContent())throw new Error(`discrete FRD loop-shape fit failed: ${await designerFrame.locator("#error").textContent()}`);
    await designerFrame.locator("#shapeTargetMode").selectOption("tf");
    for(const [part,value] of [["num","1"],["den","1"]]){const input=designerFrame.locator(`[data-model="C"][data-part="${part}"]`);await input.fill(value);await input.dispatchEvent("change");}
    const discreteBandwidth=2,discreteTs=Number(await designerFrame.locator("#ts").inputValue());await designerFrame.locator("#shapeBandwidth").fill(String(discreteBandwidth));await designerFrame.locator("#shapeBandwidthSynthesize").click();
    const discreteShapeError=await designerFrame.locator("#error").innerText(),discreteShapeNum=await designerFrame.locator('[data-model="C"][data-part="num"]').inputValue(),discreteShapeDen=await designerFrame.locator('[data-model="C"][data-part="den"]').inputValue(),discretePrewarp=Math.tan(discreteBandwidth*discreteTs/2);
    if(discreteShapeError||discreteShapeDen!=="1, -1"||discreteShapeNum.split(",").some(value=>Math.abs(Number(value.trim())-discretePrewarp)>1e-9))throw new Error(`discrete loop shaping did not prewarp wb/s correctly: ${discreteShapeError}; C=${discreteShapeNum}/${discreteShapeDen}; expected ${discretePrewarp}`);
    for(const [part,value] of [["num","1"],["den","1, -1.6, 0.63"]]){const input=designerFrame.locator(`[data-model="G"][data-part="${part}"]`);await input.fill(value);await input.dispatchEvent("change");}
    await designerFrame.locator("#shapeOrder").fill("2");await designerFrame.locator("#shapeBandwidthSynthesize").click();
    const reducedDiscreteError=await designerFrame.locator("#error").innerText(),reducedDiscreteDen=await designerFrame.locator('[data-model="C"][data-part="den"]').inputValue(),reducedDiscreteStatus=await designerFrame.locator("#shapeStatus").innerText();
    if(reducedDiscreteError||reducedDiscreteDen.split(",").length!==3||!reducedDiscreteStatus.includes("ordem obtida 2"))throw new Error(`discrete loop-shape order preference failed: ${reducedDiscreteError}; C denominator=${reducedDiscreteDen}; status=${reducedDiscreteStatus}`);
    for(const model of ["G","C","H"]){for(const part of ["num","den"]){const input=designerFrame.locator(`[data-model="${model}"][data-part="${part}"]`),value=discreteShapeModels[`${model}_${part}`];if(value!==undefined){await input.fill(value);await input.dispatchEvent("change");}}}
    if (!(await designerFrame.locator('#compensatorFormatRow option[value="timeConstant"]').evaluate((option) => option.disabled))) throw new Error("time-constant format must be unavailable for discrete poles");
    const discreteDelay = designerFrame.locator("#plantDelaySeconds");
    await discreteDelay.fill("0.2");
    await discreteDelay.dispatchEvent("change");
    const discreteMatlabExportPromise = designerFrame.page().waitForEvent("download", { timeout: 15000 });
    await designerFrame.locator("#exportMatlab").click();
    const discreteMatlabExport = await discreteMatlabExportPromise.catch(async error => {
      const state = await designerFrame.evaluate(() => ({ error: document.querySelector("#error")?.textContent, button: document.querySelector("#exportMatlab")?.outerHTML, domain: document.querySelector("#domain")?.value, delay: document.querySelector("#plantDelaySeconds")?.value, denominator: document.querySelector('[data-model="G"][data-part="den"]')?.value, variants: document.querySelectorAll("#plantVariants [data-plant-remove]").length }));
      throw new Error(`${error.message}; MATLAB export debug: ${JSON.stringify(state)}`);
    });
    const discreteMatlabScript = fs.readFileSync(await discreteMatlabExport.path(), "utf8");
    if (!discreteMatlabScript.includes("Ts = 0.100000000000000;") || !discreteMatlabScript.includes("G.InputDelay = 2.00000000000000;")) throw new Error("discrete MATLAB export must preserve Ts and express transport delay in sample periods");
    const discreteSimulinkPromise=designerFrame.page().waitForEvent("download", { timeout: 15000 });
    await designerFrame.locator("#exportSimulink").click();
    const discreteSimulinkDownload=await discreteSimulinkPromise.catch(async error=>{const state=await designerFrame.evaluate(()=>({error:document.querySelector("#error")?.textContent,button:document.querySelector("#exportSimulink")?.outerHTML,domain:document.querySelector("#domain")?.value,delay:document.querySelector("#plantDelaySeconds")?.value}));throw new Error(`${error.message}; Simulink export debug: ${JSON.stringify(state)}`)});
    const discreteSimulink=fs.readFileSync(await discreteSimulinkDownload.path(),"utf8");
    if(!discreteSimulink.includes("Discrete Transfer Fcn")||!discreteSimulink.includes("FixedStepDiscrete")||!discreteSimulink.includes("DelayLength"))throw new Error("discrete Simulink export must preserve Ts and plant sample delay");
    await discreteDelay.fill("0");
    await discreteDelay.dispatchEvent("change");
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
    await designerFrame.locator("#plantUncertaintySampling summary").evaluate(summary => { const details = summary.closest("details"); if (details) details.open = true; });
    await designerFrame.locator("#uncertaintySampleCount").fill("2");
    await designerFrame.locator("#plantTolerancePercent").fill("0");
    await designerFrame.locator("#sensorTolerancePercent").fill("0");
    await designerFrame.locator("#uncertaintySeed").fill("123");
    await designerFrame.locator("#uncertaintySharedGroups").fill("{}");
    await designerFrame.locator("#uncertaintyParameterModel").fill(JSON.stringify({
      parameters: { p: { nominal: 1.2, range: [1.1, 1.3] }, coupling: { nominal: 0, range: [-0.1, 0.1] } },
      coefficients: { "A[1][1]": [{ parameter: "p", power: 1 }], "B[0]": [{ parameter: "p", power: 1 }] },
      affineCoefficients: { "A[1][0]": [{ parameter: "coupling", scale: 1 }] },
    }));
    await designerFrame.locator("#generateUncertaintyVariants").click();
    const stateSpaceSamples=designerFrame.locator("#plantVariants .binding-entry").filter({hasText:"Amostra incerta 123-"});
    await designerFrame.waitForFunction(() => [...document.querySelectorAll("#plantVariants .binding-entry")].filter(item => item.textContent?.includes("Amostra incerta 123-")).length === 2);
    if (!(await stateSpaceSamples.nth(0).innerText()).includes("SS 2 estados")) throw new Error("uncertainty sampling did not retain sampled A/B/C/D realizations");
    await stateSpaceSamples.nth(1).locator("[data-plant-remove]").click();
    await stateSpaceSamples.nth(0).locator("[data-plant-remove]").click();
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
    await clickDesignerAction();
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
        } catch { /* VS Code substitui o iframe vazio pelo Webview real durante a ativação */ }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!instrumentFrame) throw new Error("Webview real não abriu a fixture determinística");
    await workbench.setViewportSize({ width: 1600, height: 1000 });
    await instrumentFrame.evaluate(() => document.fonts.ready);
    // O painel de propriedades (posterior ÃƒÂ s imagens de referência) abre por padrão e cobre o lado
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
    await workbench.setViewportSize({ width: 1440, height: 1000 });
    await domClick(scope.locator(".instrument-popup__close"));

    await domClick(instrumentFrame.locator('.component[data-component-id="logic"] .meter-expand-button'));
    const analyzer = instrumentFrame.locator('.instrument-popup[data-component-id="logic"]');
    await analyzer.waitFor({ state: "visible" });
    await analyzer.evaluate((element) => { element.style.width = "780px"; element.style.height = "520px"; });
    const restoredCondition = await analyzer.locator(".instrument-trigger-condition").inputValue();
    if (restoredCondition !== "1 == 1") {
      throw new Error(`condição persistida não foi restaurada: ${JSON.stringify(restoredCondition)}`);
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

    // Resize real observado pelo mesmo ResizeObserver da UI e persistência
    // após fechar/reabrir.
    const before = await analyzer.boundingBox();
    if (!before) throw new Error("não foi possível medir a janela do analisador");
    const expectedSize = {
      // Reduzir evita que o max-width/max-height responsivo do iframe masque
      // a alteração quando o editor estiver estreito.
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
      throw new Error("redimensionamento responsivo do analisador não foi aplicado");
    }
    await domClick(analyzer.locator(".instrument-popup__close"));
    await domClick(instrumentFrame.locator('.component[data-component-id="logic"] .meter-expand-button'));
    const reopened = instrumentFrame.locator('.instrument-popup[data-component-id="logic"]');
    await reopened.waitFor({ state: "visible" });
    const after = await reopened.boundingBox();
    if (!after || Math.abs(expectedSize.width - after.width) > 2 || Math.abs(expectedSize.height - after.height) > 2) {
      throw new Error(`configuração da janela não persistiu ao reabrir: antes ${Math.round(before.width)}x${Math.round(before.height)}, ` +
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
