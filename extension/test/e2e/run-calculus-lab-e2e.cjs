// E2E do Laboratório de Cálculo no VS Code real (Webview, CSP e MathML do Electron de verdade), na
// modalidade das Telas HMI (docs/62 §6, docs/64): o comando abre a tela "Laboratório de Cálculo" no
// contexto Laboratório; cada aba é uma página e cada atividade roda num <iframe> do Painel Visual.
// Uso: npm run test:lab:e2e
const { chromium } = require("@playwright/test");
const { downloadAndUnzipVSCode } = require("@vscode/test-electron");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const extensionPath = path.resolve(__dirname, "../..");
const artifacts = path.resolve(__dirname, "artifacts");
fs.mkdirSync(artifacts, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function executablePath() {
  if (process.env.VSCODE_EXECUTABLE_PATH) return process.env.VSCODE_EXECUTABLE_PATH;
  return downloadAndUnzipVSCode({ version: process.env.VSCODE_E2E_VERSION || "1.128.0", cachePath: path.resolve(extensionPath, ".vscode-test"), timeout: 120000 });
}
async function connect(port) {
  let last;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { return await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch (error) { last = error; await sleep(250); }
  }
  throw last;
}
async function command(workbench, title) {
  // Logo depois de o workbench aparecer, as contribuições das extensões ainda não chegaram à paleta, e
  // a lista aberta cedo demais não se refaz sozinha ("No matching commands"): reabre até o comando aparecer.
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
      await workbench.waitForTimeout(1000);
    }
  }
  await workbench.waitForTimeout(300);
  await workbench.keyboard.press("Enter");
}

let failures = 0;
const check = (cond, label, detail = "") => { console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? ` -- ${detail}` : ""}`); if (!cond) failures++; };

/** Marca de cada atividade montada (id que só aquela vista desenha). */
const MARKER = { functions: "#fnInfo", sensor: "#snQuestion", limits: "#limTable", axis: "#axExactV", firstOrder: "#foQuestion", tank: "#tkTank" };

(async () => {
  const port = 9300 + Math.floor(Math.random() * 500);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-lab-user-"));
  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-lab-ext-"));
  fs.mkdirSync(path.join(userData, "User"), { recursive: true });
  fs.writeFileSync(path.join(userData, "User", "settings.json"), JSON.stringify({
    "lasecsimul.network.mode": "isolated", "workbench.startupEditor": "none", "lasecsimul.language": "pt-BR",
    "workbench.secondarySideBar.defaultVisibility": "hidden", "chat.disableAIFeatures": true,
  }));
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(await executablePath(), [
    `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, `--extensions-dir=${extensionsDir}`,
    `--extensionDevelopmentPath=${extensionPath}`, "--disable-workspace-trust", "--disable-updates", "--skip-welcome",
    "--force-device-scale-factor=1", "--disable-gpu", "--disable-shared-process", "--new-window",
  ], { env: childEnv, stdio: ["ignore", fs.openSync(path.join(artifacts, "lab-vscode.stdout.log"), "w"), fs.openSync(path.join(artifacts, "lab-vscode.stderr.log"), "w")] });
  let browser;
  let workbench;
  const cspViolations = [];
  try {
    browser = await connect(port);
    for (let attempt = 0; attempt < 120 && !workbench; attempt++) {
      const pages = browser.contexts().flatMap((context) => context.pages());
      workbench = pages.find((page) => page.url().includes("workbench")) ?? pages.find((page) => page.url().startsWith("vscode-file:"));
      if (!workbench) await sleep(250);
    }
    if (!workbench) throw new Error("VS Code de teste não criou o workbench");
    // Violações de CSP aparecem no console de qualquer documento da página, inclusive os <iframe> aninhados.
    workbench.on("console", (message) => { if (/Content Security Policy/i.test(message.text())) cspViolations.push(message.text().slice(0, 200)); });
    await workbench.locator(".monaco-workbench").waitFor({ state: "visible", timeout: 60000 });
    await workbench.setViewportSize({ width: 1600, height: 1100 });
    await command(workbench, "LasecSimul: Laboratório de Cálculo");

    /** A casca: o Painel Visual da tela do Laboratório (abas = páginas). */
    let shell;
    for (let attempt = 0; attempt < 160 && !shell; attempt++) {
      for (const frame of workbench.frames()) {
        try { if ((await frame.locator("body.visual-role #labTabs button").count()) >= 6) { shell = frame; break; } } catch { /* frame em troca */ }
      }
      if (!shell) await sleep(250);
    }
    if (!shell) {
      await workbench.screenshot({ path: path.join(artifacts, "calculus-lab-fail.png") });
      throw new Error("tela do Laboratório de Cálculo não abriu");
    }
    check(true, "o comando abre a tela do Laboratório (Tela HMI no contexto Laboratório)");

    /** O <iframe> da atividade que está na página (um novo a cada troca de aba). */
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
    let lab = await activityFrame("functions");
    const text = async (sel) => (await lab.locator(sel).first().innerText()).replace(/\s+/g, " ").trim();
    const frames = () => lab.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    /** Espera o texto de `sel` casar com `pattern` (a atividade recalcula no próximo quadro). */
    const waitText = async (sel, pattern, timeout = 5000) => {
      const deadline = Date.now() + timeout;
      let last = "";
      while (Date.now() < deadline) {
        try { last = await text(sel); if (pattern.test(last)) return last; } catch { /* ainda não montado */ }
        await sleep(100);
      }
      return last;
    };
    const setRange = (sel, value) => lab.evaluate(([s, v]) => {
      const el = document.querySelector(s);
      el.value = String(v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, [sel, value]);
    const openTab = async (kind) => {
      const previous = lab;
      await shell.locator(`#labTabs button[data-kind="${kind}"]`).first().click();
      lab = await activityFrame(kind, previous);
      await frames();
    };
    const MINUS = "[-−]";

    // ---------------------------------------------------------------- abas (ordem pedagógica)
    const kinds = await shell.locator("#labTabs button").evaluateAll((tabs) => tabs.map((t) => t.dataset.kind).join(","));
    check(kinds === "functions,sensor,limits,axis,firstOrder,tank", "seis atividades-modelo na ordem pedagógica", kinds);
    const sentAtStart = await lab.evaluate(() => ({ ...window.__lab.sent }));
    check(!sentAtStart.labSetParameter && !sentAtStart.labRun, "abrir o laboratório não comanda o Core", JSON.stringify(sentAtStart));

    // ---------------------------------------------------------------- funções (aba inicial)
    const roots = await waitText("#fnRoots", /1,414214/);
    check(new RegExp(`${MINUS}1,414214; 1,414214`).test(roots), "f = x² − 2: raízes ±√2", roots);
    const inter = await waitText("#fnIntersections", /2,30278/);
    check(new RegExp(`\\(${MINUS}1,30278; ${MINUS}0,30278\\); \\(2,30278; 3,30278\\)`).test(inter), "f = g em x = (1 ± √13)/2", inter);
    const fnMath = await lab.evaluate(() => { const m = document.querySelector("#fnF math"); const r = m?.getBoundingClientRect(); return { supported: typeof MathMLElement === "function", w: r?.width ?? 0, h: r?.height ?? 0 }; });
    check(fnMath.supported && fnMath.w > 20 && fnMath.h > 10, "MathML Core renderiza no Electron do VS Code", JSON.stringify(fnMath));
    await setRange("#fnParam_a", -1);
    check(/nenhuma na vista/.test(await waitText("#fnRoots", /nenhuma/)), "a = −1: −x² − 2 não tem raízes reais");
    await setRange("#fnParam_a", 1);
    const pathsBefore = await lab.locator("#fnChart path").count();
    await lab.locator("#fnShow_derivative").check();
    await frames();
    const pathsAfter = await lab.locator("#fnChart path").count();
    check(pathsAfter > pathsBefore, "ligar f′ desenha a derivada", `caminhos: ${pathsBefore} → ${pathsAfter}`);
    const fnHandle = lab.locator('#fnChart [role="slider"]').first();
    if (await fnHandle.count()) {
      await fnHandle.focus();
      const before = await text("#fnPoint");
      await workbench.keyboard.press("ArrowRight");
      await frames();
      check((await text("#fnPoint")) !== before, "o ponto sobre f anda pelo teclado (alça acessível)", await text("#fnPoint"));
    } else check(false, "alça do ponto sobre f existe");

    // ---------------------------------------------------------------- limites
    await openTab("limits");
    await lab.locator("#limTable tr").first().waitFor({ timeout: 10000 });
    const rows = await lab.locator("#limTable tr").allInnerTexts();
    check(/4,5\s+3,5/.test(rows[0]) && /4,05\s+3,95/.test(rows[1]) && /4,005\s+3,995/.test(rows[2]), "tabela bilateral confere com a meta", rows.slice(0, 3).join(" | "));
    check(/→ 4 cm\/s ←/.test(await text("#limLimit")), "limite exato 4 cm/s");

    // ε–δ: q(Δ) = 4 + Δ/2, então |q − 4| < ε ⇔ |Δ| < 2ε.
    const delta = (s) => Number((/δ = ([\d,]+)/.exec(s)?.[1] ?? "NaN").replace(",", "."));
    const d05 = delta(await waitText("#limDelta", /δ = /));
    check(d05 > 0.5 && d05 <= 1.0001, "ε = 0,5: δ ≤ 2ε encontrado", String(d05));
    await setRange("#limEps", -1);
    const d01 = delta(await waitText("#limDelta", /ε = 0,1\b/));
    check(d01 > 0.1 && d01 <= 0.20002, "ε = 0,1: δ ≈ 0,2", String(d01));
    await lab.locator("#limCounter").check();
    check(/Nenhum δ serve/.test(await waitText("#limDelta", /Nenhum/)), "contraexemplo (salto de 1): nenhum δ serve para ε = 0,1");
    await lab.locator("#limCounter").uncheck();
    await frames();

    await lab.locator("#limModelEditor").click();
    await workbench.keyboard.press("Control+a");
    await workbench.keyboard.press("Backspace");
    await workbench.keyboard.type("t^3");
    await frames();
    const rows3 = await lab.locator("#limTable tr").allInnerTexts();
    check(/^1\s+61\s+37/.test(rows3[0]), "modelo digitado t³ recalcula a tabela", rows3[0]);
    check(/→ 48 cm\/s ←/.test(await text("#limLimit")), "limite exato passa a 48");
    check(/= 48/.test(await text("#limCalcResult")), "calculadora acompanha o modelo", await text("#limCalcResult"));

    await lab.locator("#limCalcEditor").click();
    await workbench.keyboard.press("Control+a");
    await workbench.keyboard.press("Backspace");
    await lab.locator('#limPalette .key[aria-label="integral definida"]').first().click();
    await workbench.keyboard.type("0");
    await workbench.keyboard.press("Tab");
    await workbench.keyboard.type("1");
    await workbench.keyboard.press("Tab");
    await workbench.keyboard.type("x^2");
    await frames();
    check(/0,3333333333/.test(await text("#limCalcResult")) && /exato/.test(await text("#limCalcResult")), "paleta: ∫₀¹ x² dx exato", await text("#limCalcResult"));

    await lab.locator("#limZero").click();
    await frames();
    check(/denominador do quociente é zero/.test(await text("#limWarning")), "Δt = 0 indefinido");

    // ---------------------------------------------------------------- eixo
    await openTab("axis");
    check((await waitText("#axExactV", /56,25/)) === "56,25", "eixo: v(t₀ = 1 s) = 56,25 mm/s exato (L = 200, T = 4)");
    const axHandle = lab.locator('[role="slider"]').first();
    await axHandle.focus();
    await workbench.keyboard.press("ArrowRight");
    await frames();
    check((await text("#axExactV")) !== "56,25", "a alça de t₀ responde ao teclado e a tabela acompanha", await text("#axExactV"));

    // ---------------------------------------------------------------- apresentação (casca)
    const fontNormal = await lab.evaluate(() => parseFloat(getComputedStyle(document.querySelector("#labActivity")).fontSize));
    await shell.locator("#labPresentation").click();
    await sleep(300);
    const presenting = await lab.evaluate(() => document.body.classList.contains("presentation"));
    const fontPresenting = await lab.evaluate(() => parseFloat(getComputedStyle(document.querySelector("#labActivity")).fontSize));
    await shell.locator("#labPresentation").click();
    await sleep(300);
    const backToNormal = await lab.evaluate(() => !document.body.classList.contains("presentation"));
    check(presenting && fontPresenting > fontNormal && backToNormal, "modo apresentação amplia a interface e volta", `${fontPresenting}px × ${fontNormal}px`);

    // ---------------------------------------------------------------- professor = edição da tela
    await openTab("limits");
    await lab.locator("#limModelEditor").click();
    await workbench.keyboard.press("Control+a");
    await workbench.keyboard.press("Backspace");
    await workbench.keyboard.type("t^3");
    await frames();
    await shell.locator(".visual-lab-header__button", { hasText: "Editar" }).click();
    lab = await activityFrame("limits");
    await lab.locator("#limSave").waitFor({ state: "attached", timeout: 10000 });
    check(/48 cm\/s/.test(await waitText("#limLimit", /48 cm\/s/)), "entrar em edição (modo professor) preserva o modelo editado (t³)", await text("#limLimit"));
    // A atividade só recebe o ponteiro "por dentro": duplo clique no elemento.
    const activityElement = shell.locator('.component[data-type-id="graphics.math.activity"]').first();
    const box = await activityElement.boundingBox();
    await workbench.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await sleep(120);
    await workbench.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await shell.locator("iframe.math-embed--editing").waitFor({ timeout: 5000 });
    check(true, "duplo clique edita a atividade por dentro");
    await lab.locator("#limSave").waitFor({ state: "visible", timeout: 10000 });
    await lab.locator("#limQuestionInput").fill("Qual é a taxa de variação aos 4 s?");
    await lab.locator("#limSave").click();
    await lab.locator("#limSaveStatus").filter({ hasText: "gravada" }).waitFor({ timeout: 10000 });
    check(true, "modo professor grava a atividade na tela (confirmação do host)");

    // ---------------------------------------------------------------- páginas-modelo (substituem o editor de atividades)
    await shell.locator(".canvas").first().click({ position: { x: 5, y: 5 } });
    await sleep(200);
    await shell.locator(".visual-lab-page-select").selectOption("limits");
    await sleep(400);
    const pageOptions = () => shell.locator('.appbar--visual select[title="Página"] option').count();
    check((await pageOptions()) === 7, "+ Página do Laboratório insere a sétima página", String(await pageOptions()));
    await shell.locator(".canvas").first().click({ position: { x: 5, y: 5 } });
    await workbench.keyboard.press("Control+Z");
    for (let i = 0; i < 50 && (await pageOptions()) !== 6; i++) await sleep(100);
    check((await pageOptions()) === 6, "desfazer volta para seis páginas", String(await pageOptions()));
    await workbench.keyboard.press("Control+Y");
    for (let i = 0; i < 50 && (await pageOptions()) !== 7; i++) await sleep(100);
    check((await pageOptions()) === 7, "refazer devolve a sétima", String(await pageOptions()));

    // De volta à operação: a pergunta gravada aparece na aba de Limites.
    await shell.locator(".appbar--visual .appbar__button", { hasText: "Operar" }).click();
    await shell.locator("#labTabs button").first().waitFor({ timeout: 10000 });
    check((await shell.locator("#labTabs button").count()) === 7, "a página nova vira a sétima aba");
    await shell.locator('#labTabs button[data-kind="limits"]').first().click();
    lab = await activityFrame("limits");
    check(/taxa de variação aos 4 s/.test(await waitText("#limQuestion", /taxa de variação/)), "a definição gravada é a da tela", await text("#limQuestion"));

    check(cspViolations.length === 0, "nenhuma violação de CSP na Webview real (casca e atividades)", cspViolations.join("; "));
    await workbench.screenshot({ path: path.join(artifacts, "calculus-lab.png") });
  } catch (error) {
    console.error(error);
    failures++;
    await workbench?.screenshot({ path: path.join(artifacts, "calculus-lab-fail.png") }).catch(() => undefined);
  } finally {
    await browser?.close().catch(() => undefined);
    try { require("child_process").execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* já saiu */ }
  }
  console.log(failures === 0 ? "\nE2E LABORATÓRIO OK" : `\n${failures} FALHA(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
