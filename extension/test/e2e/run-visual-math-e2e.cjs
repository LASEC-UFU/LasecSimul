// E2E (VS Code real): exemplo de examples/calculo na modalidade das Telas HMI (docs/64 §7) -- o botão
// "Laboratório de Cálculo" abre a tela no contexto Laboratório; a página composta com elementos da tela
// (parâmetros, gráfico de função, equações, tabela) responde ao operador; o professor muda um elemento em
// edição e o aluno vê a mudança em operação; o arquivo grava a mudança; tela cheia no contexto Laboratório
// no monitor principal e no secundário (quando houver).
// Uso: npm run test:visual:math:e2e. VSCODE_E2E_VERSION escolhe a build (padrão 1.128.0);
// VSCODE_EXECUTABLE_PATH usa um Code.exe instalado.
// ATENÇÃO: abre uma janela do VS Code na sessão do usuário e coloca uma janela em tela cheia por alguns
// segundos (avise quem estiver usando a máquina). Não usa a área de transferência.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const extensionPath = path.resolve(__dirname, "../..");
const example = path.resolve(extensionPath, "../examples/calculo/funcoes-e-limites.lsproj");
const artifacts = path.join(extensionPath, "test", "e2e", "artifacts", "visual-math");
const req = (name) => require(path.join(extensionPath, "node_modules", name));
const { chromium } = req("@playwright/test");
const { downloadAndUnzipVSCode } = req("@vscode/test-electron");
fs.mkdirSync(artifacts, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (cond, label, detail = "") => { console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? ` -- ${detail}` : ""}`); if (!cond) failures++; return cond; };

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
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-vmath-user-"));
  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-vmath-ext-"));
  fs.mkdirSync(path.join(userData, "User"), { recursive: true });
  fs.writeFileSync(path.join(userData, "User", "settings.json"), JSON.stringify({
    "lasecsimul.network.mode": "isolated", "workbench.startupEditor": "none", "lasecsimul.language": "pt-BR",
    "window.customTitleBarVisibility": "windowed",
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

const allPages = (browser) => browser.contexts().flatMap((context) => context.pages());

/** Frame (em qualquer janela do VS Code) que tem `selector`. */
async function findFrame(browser, selector, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    for (const page of allPages(browser)) {
      for (const frame of page.frames()) {
        try { if (await frame.locator(selector).count()) return { page, frame }; } catch { /* frame em troca */ }
      }
    }
    await sleep(250);
  }
  return undefined;
}

(async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-vmath-ws-"));
  const projectFile = path.join(workspace, "funcoes-e-limites.lsproj");
  fs.copyFileSync(example, projectFile);
  const { browser, workbench, child } = await launch(workspace);
  try {
    await workbench.setViewportSize({ width: 1700, height: 1100 });
    await sleep(4000);
    // abre o exemplo (editor customizado do esquemático)
    for (let attempt = 0; attempt < 10; attempt++) {
      await workbench.keyboard.press("Control+P");
      const quick = workbench.locator(".quick-input-widget input").first();
      await quick.waitFor({ state: "visible", timeout: 15000 });
      await quick.fill("funcoes-e-limites.lsproj");
      try {
        await workbench.locator(".quick-input-list .monaco-list-row", { hasText: "funcoes-e-limites.lsproj" }).first().waitFor({ state: "visible", timeout: 3000 });
        break;
      } catch { await workbench.keyboard.press("Escape"); await sleep(1000); }
    }
    await workbench.keyboard.press("Enter");
    const schematic = (await findFrame(browser, '.component[data-component-id="laboratorio-calculo"]', 240))?.frame;
    check(Boolean(schematic), 'o exemplo abre com o botão "Laboratório de Cálculo" no esquemático');
    if (!schematic) throw new Error("esquemático não abriu");

    // 1) O botão abre a tela no contexto Laboratório, em operação.
    await schematic.locator('.component[data-component-id="laboratorio-calculo"]').first().dblclick();
    let shell = (await findFrame(browser, "body.visual-role #labTabs button", 160))?.frame;
    check(Boolean(shell), "duplo clique no botão abre a tela do Laboratório");
    if (!shell) throw new Error("tela não abriu");
    const tabs = await shell.locator("#labTabs button").allInnerTexts();
    check(tabs.length === 4 && /elementos da tela/.test(tabs[1]), "quatro páginas: três atividades e a página de elementos (logo depois das funções)", tabs.join(" | "));
    check(await shell.evaluate(() => document.body.classList.contains("visual-context-lab") && document.body.classList.contains("visual-operate")), "abre no contexto Laboratório e em operação");

    // 2) Página composta só com elementos da tela.
    await shell.locator("#labTabs button", { hasText: "elementos da tela" }).click();
    await shell.locator('.component[data-component-id="tabela"]').waitFor({ timeout: 10000 });
    const content = (id) => shell.locator(`.component[data-component-id="${id}"]`).first().evaluate((el) => el.textContent.replace(/\s+/g, " "));
    const plotPath = () => shell.locator('.component[data-component-id="grafico"] path').first().getAttribute("d");
    check(/23/.test(await content("tabela")), "tabela calcula f(−5) = 23 com a = 1, b = 0, c = −2", (await content("tabela")).slice(0, 80));
    const pathBefore = await plotPath();
    check(Boolean(pathBefore && pathBefore.length > 40), "gráfico desenha a curva de f");
    const spans = await shell.locator('.component[data-component-id="grafico"]').first().evaluate((el) => {
      const curve = el.querySelector("path").getBoundingClientRect();
      const frame = el.getBoundingClientRect();
      return { curve: Math.round(curve.width), frame: Math.round(frame.width) };
    });
    check(spans.curve > spans.frame * 0.7, "a curva atravessa a área do gráfico (pixels, não coordenadas do mundo)", JSON.stringify(spans));
    check(/[−-]\s*2/.test(await content("equacao-f")), "equação com os valores substituídos", await content("equacao-f"));

    // 3) Operador arrasta o parâmetro a até o fim do trilho: a = 3.
    const slider = shell.locator('.component[data-component-id="param-a"]').first();
    const box = await slider.boundingBox();
    const sliderPage = shell.page();
    await sliderPage.mouse.click(box.x + box.width * (1 - 14 / 320), box.y + box.height * (54 / 72));
    await sleep(300);
    check(/a =\s*3/.test(await content("param-a")), "parâmetro a = 3 depois do clique no fim do trilho", await content("param-a"));
    check(/73/.test(await content("tabela")), "a tabela acompanha o parâmetro (f(−5) = 73)", (await content("tabela")).slice(0, 80));
    check((await plotPath()) !== pathBefore, "o gráfico acompanha o parâmetro");
    check(/3/.test(await content("equacao-f")), "a equação acompanha o parâmetro", await content("equacao-f"));

    // 4) Professor: em edição muda g(x) do gráfico; o aluno vê em operação; o arquivo grava.
    await shell.locator(".visual-lab-header__button", { hasText: "Editar" }).click();
    await shell.locator(".appbar--visual").filter({ hasText: "Operar" }).waitFor({ timeout: 10000 });
    check(/23/.test(await content("tabela")), "em edição valem os valores autorados (a = 1)");
    const plot = shell.locator('.component[data-component-id="grafico"]').first();
    const plotBox = await plot.boundingBox();
    await sliderPage.mouse.click(plotBox.x + plotBox.width * 0.5, plotBox.y + plotBox.height * 0.5);
    const g = shell.locator(".property-dock .property-sheet__field-row", { has: shell.locator(".property-sheet__field-label", { hasText: "g(x) (opcional)" }) }).locator(".property-sheet__field-input").first();
    await g.waitFor({ timeout: 10000 });
    await g.fill("2 x");
    await g.press("Enter");
    await sleep(400);
    check(/g\(x\) = 2 x/.test(await content("grafico")), "o professor muda g(x) no Inspector", (await content("grafico")).slice(-60));
    await shell.locator(".appbar--visual .appbar__button--save").first().click();
    let saved;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { saved = JSON.parse(fs.readFileSync(projectFile, "utf8")); } catch { saved = undefined; }
      if (saved?.visualDocuments?.[0]?.pages?.some((page) => page.elements.some((el) => el.id === "grafico" && el.properties?.expression2 === "2 x"))) break;
      await sleep(250);
    }
    check(saved?.visualDocuments?.[0]?.pages?.some((page) => page.elements.some((el) => el.id === "grafico" && el.properties?.expression2 === "2 x")) && !("calculusLab" in (saved ?? {})),
      "o .lsproj grava a mudança no documento da tela");
    await shell.locator(".appbar--visual .appbar__button", { hasText: "Operar" }).click();
    await shell.locator("#labTabs button").first().waitFor({ timeout: 10000 });
    // A operação começa na página inicial: volta à página dos elementos.
    await shell.locator("#labTabs button", { hasText: "elementos da tela" }).click();
    await shell.locator('.component[data-component-id="grafico"]').waitFor({ timeout: 10000 });
    check(/g\(x\) = 2 x/.test(await content("grafico")), "o aluno vê a mudança em operação");

    // 5) Tela cheia no contexto Laboratório (monitor principal): o cabeçalho do Laboratório fica.
    await shell.locator(".visual-corner-button--enter").click();
    const full = await findFrame(browser, "body.visual-role.visual-fullscreen", 80);
    const fullInfo = full && await full.frame.evaluate(() => ({ cls: document.body.className, iw: innerWidth, ih: innerHeight, sw: screen.width, sh: screen.height, tabs: document.querySelectorAll("#labTabs button").length, left: screen.availLeft }));
    check(Boolean(fullInfo) && fullInfo.iw === fullInfo.sw && fullInfo.ih >= fullInfo.sh - 32, "tela cheia ocupa o monitor", JSON.stringify(fullInfo));
    check(Boolean(fullInfo) && /visual-context-lab/.test(fullInfo.cls) && fullInfo.tabs === 4, "tela cheia no contexto Laboratório, com as abas", JSON.stringify(fullInfo));
    await full?.page.screenshot({ path: path.join(artifacts, `lab-fullscreen-${fullInfo?.sw}x${fullInfo?.sh}.png`) }).catch(() => undefined);
    await full.frame.locator(".visual-corner-button--exit").click();
    shell = (await findFrame(browser, "body.visual-role:not(.visual-fullscreen) #labTabs button", 80))?.frame;
    check(Boolean(shell), "sair da tela cheia volta ao VS Code (acoplada)");

    // 6) Monitor secundário: desacopla, leva a janela até ele e entra em tela cheia lá.
    const secondary = monitors().find((m) => !m.primary);
    if (secondary && shell) {
      await shell.locator(".canvas").first().click({ button: "right", position: { x: 30, y: 30 } });
      await shell.locator(".context-menu__item", { has: shell.locator(".context-menu__label", { hasText: "Desacoplar janela" }) }).first().click();
      const floating = await findFrame(browser, "body.visual-role.visual-undocked", 80);
      check(Boolean(floating) && floating.page !== workbench, "desacoplar leva a tela a uma janela auxiliar");
      const moved = winctl(child.pid, "*Laborat*", "move", ["-X", String(secondary.x + 60), "-Y", String(secondary.y + 60), "-W", "900", "-H", "600"]);
      await sleep(1500);
      await floating.frame.locator(".visual-corner-button--enter").click();
      const second = await findFrame(browser, "body.visual-role.visual-fullscreen", 80);
      const secondInfo = second && await second.frame.evaluate(() => ({ cls: document.body.className, iw: innerWidth, sw: screen.width, sh: screen.height, left: screen.availLeft, tabs: document.querySelectorAll("#labTabs button").length }));
      check(Boolean(secondInfo) && secondInfo.left === secondary.x && secondInfo.iw === secondary.w && /visual-context-lab/.test(secondInfo.cls),
        "tela cheia do Laboratório no monitor secundário", `${moved} ${JSON.stringify(secondInfo)}`);
      await second?.page.screenshot({ path: path.join(artifacts, `lab-fullscreen-${secondInfo?.sw}x${secondInfo?.sh}.png`) }).catch(() => undefined);
      await second.frame.locator(".visual-corner-button--exit").click();
      const back = await findFrame(browser, "body.visual-role.visual-undocked:not(.visual-fullscreen)", 80);
      check(Boolean(back), "ao sair, a tela continua flutuante no monitor secundário");
    } else {
      console.log("skip tela cheia no monitor secundário: só um monitor");
    }
  } catch (error) {
    check(false, "execução sem exceção", String(error && error.stack || error));
    await workbench.screenshot({ path: path.join(artifacts, "failure.png") }).catch(() => undefined);
  } finally {
    await browser.close().catch(() => undefined);
    try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* já saiu */ }
  }
  console.log(failures === 0 ? "\nElementos matemáticos E2E: tudo ok" : `\nElementos matemáticos E2E: ${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
})();
