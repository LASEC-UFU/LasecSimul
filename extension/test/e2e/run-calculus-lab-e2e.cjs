// E2E do Laboratório de Cálculo no VS Code real (Webview, CSP e MathML do Electron de verdade).
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

async function executablePath() {
  if (process.env.VSCODE_EXECUTABLE_PATH) return process.env.VSCODE_EXECUTABLE_PATH;
  return downloadAndUnzipVSCode({ version: process.env.VSCODE_E2E_VERSION || "1.128.0", cachePath: path.resolve(extensionPath, ".vscode-test"), timeout: 120000 });
}
async function connect(port) {
  let last;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { return await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch (error) { last = error; await new Promise((r) => setTimeout(r, 250)); }
  }
  throw last;
}
async function command(workbench, title) {
  await workbench.keyboard.press("Control+Shift+P");
  const input = workbench.locator(".quick-input-widget input, .quick-input-box input").first();
  await input.waitFor({ state: "visible" });
  await input.fill(`>${title}`);
  await workbench.waitForTimeout(400);
  await workbench.keyboard.press("Enter");
}

let failures = 0;
const check = (cond, label, detail = "") => { console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? ` -- ${detail}` : ""}`); if (!cond) failures++; };

(async () => {
  const port = 9300 + Math.floor(Math.random() * 500);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-lab-user-"));
  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-lab-ext-"));
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(await executablePath(), [
    `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, `--extensions-dir=${extensionsDir}`,
    `--extensionDevelopmentPath=${extensionPath}`, "--disable-workspace-trust", "--disable-updates", "--skip-welcome",
    "--force-device-scale-factor=1", "--disable-gpu", "--disable-shared-process", "--new-window",
  ], { env: childEnv, stdio: ["ignore", fs.openSync(path.join(artifacts, "lab-vscode.stdout.log"), "w"), fs.openSync(path.join(artifacts, "lab-vscode.stderr.log"), "w")] });
  let browser;
  try {
    browser = await connect(port);
    let workbench;
    for (let attempt = 0; attempt < 120 && !workbench; attempt++) {
      const pages = browser.contexts().flatMap((context) => context.pages());
      workbench = pages.find((page) => page.url().includes("workbench")) ?? pages.find((page) => page.url().startsWith("vscode-file:"));
      if (!workbench) await new Promise((r) => setTimeout(r, 250));
    }
    if (!workbench) throw new Error("VS Code de teste não criou o workbench");
    await workbench.locator(".monaco-workbench").waitFor({ state: "visible", timeout: 60000 });
    await workbench.setViewportSize({ width: 1600, height: 1100 });
    await command(workbench, "LasecSimul: Laboratório de Cálculo");

    let lab;
    for (let attempt = 0; attempt < 160 && !lab; attempt++) {
      for (const frame of workbench.frames()) {
        if (frame === workbench.mainFrame()) continue;
        try { if (await frame.locator("#limTable tr").count()) { lab = frame; break; } } catch { /* frame em troca */ }
      }
      if (!lab) await new Promise((r) => setTimeout(r, 250));
    }
    if (!lab) {
      await workbench.screenshot({ path: path.join(artifacts, "calculus-lab-fail.png") });
      fs.writeFileSync(path.join(artifacts, "calculus-lab-frames.json"), JSON.stringify(workbench.frames().map((f) => f.url()), null, 2));
      throw new Error("painel do Laboratório de Cálculo não abriu");
    }
    await lab.evaluate(() => { window.__csp = []; document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`)); });
    const text = async (sel) => (await lab.locator(sel).first().innerText()).replace(/\s+/g, " ").trim();
    const frames = () => lab.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

    const rows = await lab.locator("#limTable tr").allInnerTexts();
    check(/4,5\s+3,5/.test(rows[0]) && /4,05\s+3,95/.test(rows[1]) && /4,005\s+3,995/.test(rows[2]), "tabela bilateral confere com a meta", rows.slice(0, 3).join(" | "));
    check(/→ 4 cm\/s ←/.test(await text("#limLimit")), "limite exato 4 cm/s");
    const math = await lab.evaluate(() => { const m = document.querySelector("#limModelEditor math"); const r = m?.getBoundingClientRect(); return { supported: typeof MathMLElement === "function", w: r?.width ?? 0, h: r?.height ?? 0 }; });
    check(math.supported && math.w > 20 && math.h > 10, "MathML Core renderiza no Electron do VS Code", JSON.stringify(math));

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
    await lab.locator('.key[aria-label="integral definida"]').click();
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

    // modo professor: gravar a atividade no projeto
    await lab.locator("#labTeacher").click();
    await frames();
    check(/48 cm\/s/.test(await text("#limLimit")),"trocar para modo professor preserva o modelo editado (t³)", await text("#limLimit"));
    await lab.locator("#limSave").waitFor({ state: "visible", timeout: 10000 });
    await lab.locator("#limQuestionInput").fill("Qual é a taxa de variação aos 4 s?");
    await lab.locator("#limSave").click();
    await lab.locator("#limSaveStatus").filter({ hasText: "gravada" }).waitFor({ timeout: 10000 });
    check(true, "modo professor grava a atividade no projeto (confirmação do host)");

    const csp = await lab.evaluate(() => window.__csp);
    check(csp.length === 0, "nenhuma violação de CSP na Webview real", csp.join("; "));
    await workbench.screenshot({ path: path.join(artifacts, "calculus-lab.png") });
  } catch (error) {
    console.error(error);
    failures++;
  } finally {
    await browser?.close().catch(() => {});
    child.kill();
  }
  console.log(failures === 0 ? "\nE2E LABORATÓRIO OK" : `\n${failures} FALHA(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
