// Demais linguagens no editor OpenPLC dentro do VS Code. ST: Monaco com o LSP da STruC++
// (autocompletar e erro sublinhado) e o menu "+" do OpenPLC. IL: texto e compilação. FBD: variável
// de entrada e de saída arrastadas, ligadas pelo mouse e compiladas. Cada linguagem abre um VS Code
// de teste. Mouse e teclado do CDP. Uso: OPENPLC_E2E_LANGS=st,il,fbd (padrão: todas).
const fs = require("fs");
const path = require("path");
const { launch, createOpenPlcProject, dragTool, setVariable, waitConsole, sleep } = require("./openplc-lab.cjs");

const out = path.join(__dirname, "artifacts", "openplc");
fs.mkdirSync(out, { recursive: true });
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function build(frame) {
  await frame.getByRole("button", { name: "Build options" }).click();
  await sleep(400);
  await frame.getByText("Build only", { exact: true }).click();
  return waitConsole(frame, /Build (finished|is up to date)|failed|error/i);
}

/** Clica no texto do Monaco e digita pelo teclado da página, como uma pessoa (o Monaco 0.54 usa
 * EditContext; o textarea escondido não recebe a digitação). */
async function typeInMonaco(session, text) {
  await session.frame.locator(".monaco-editor .view-lines").first().click();
  await sleep(500);
  await session.workbench.keyboard.type(text, { delay: 50 });
}

async function scenarioSt(session) {
  const { frame, workbench } = session;
  const keyboard = workbench.keyboard;
  await frame.locator(".monaco-editor").first().waitFor({ state: "visible", timeout: 30000 });
  await typeInMonaco(session, "DO0 := NOT D");
  await sleep(800);
  await keyboard.press("Control+Space");
  let suggestions = "";
  for (let attempt = 0; attempt < 20 && !/DI0/.test(suggestions); attempt += 1) {
    await sleep(300);
    suggestions = await frame.evaluate(() => Array.from(document.querySelectorAll(".suggest-widget .monaco-list-row")).map((row) => row.innerText.replace(/\s+/g, " ")).join(" | "));
  }
  check("ST: autocompletar do LSP oferece DI0", /DI0/.test(suggestions), suggestions.slice(0, 160));
  await workbench.screenshot({ path: path.join(out, "40-st-completion.png") });
  await keyboard.press("Escape");
  await keyboard.type("I0 +;", { delay: 60 });
  let squiggles = 0;
  for (let attempt = 0; attempt < 30 && squiggles === 0; attempt += 1) {
    await sleep(300);
    squiggles = await frame.locator(".monaco-editor .squiggly-error").count();
  }
  check("ST: erro de sintaxe sublinhado pelo LSP", squiggles > 0, `marcas: ${squiggles}`);
  await workbench.screenshot({ path: path.join(out, "41-st-diagnostic.png") });
  for (let i = 0; i < 3; i += 1) await keyboard.press("Backspace");
  await keyboard.type(";", { delay: 60 });

  // Menu "+" do OpenPLC: Python e C/C++ ficam desabilitados como o SFC (não rodam no CLP do LasecSimul).
  await frame.locator('[aria-label="Create PLC element trigger component"]').click();
  await sleep(600);
  await frame.getByText("Function Block", { exact: true }).click();
  await sleep(600);
  await frame.locator('[aria-label="pou-language"]').click();
  await sleep(600);
  const options = await frame.evaluate(() => Array.from(document.querySelectorAll("[role=option]")).map((option) =>
    `${option.innerText.trim()}${option.className.includes("pointer-events-none") ? " (desabilitado)" : ""}`));
  check("menu +: SFC habilitado, Python e C/C++ desabilitados",
    options.some((option) => option === "Sequential Functional Chart") &&
    ["Python", "C/C++"].every((name) => options.some((option) => option.startsWith(name) && option.endsWith("(desabilitado)"))),
    options.join(", "));
  await workbench.screenshot({ path: path.join(out, "42-create-menu.png") });
  await keyboard.press("Escape");
  await keyboard.press("Escape");
  await sleep(400);

  await keyboard.press("Control+S");
  await sleep(1500);
  const tail = await build(frame);
  check("ST compila no Core", /Build (finished|is up to date)/.test(tail), tail.slice(-160));
}

async function scenarioIl(session) {
  const { frame, workbench } = session;
  await frame.locator(".monaco-editor").first().waitFor({ state: "visible", timeout: 30000 });
  await typeInMonaco(session, "LD DI0");
  await workbench.keyboard.press("Enter");
  await workbench.keyboard.type("STN DO0", { delay: 50 });
  await sleep(800);
  await workbench.screenshot({ path: path.join(out, "50-il.png") });
  await workbench.keyboard.press("Control+S");
  await sleep(1500);
  const tail = await build(frame);
  check("IL compila no Core", /Build (finished|is up to date)/.test(tail), tail.slice(-160));
}

async function scenarioFbd(session) {
  const { frame, workbench } = session;
  const flow = frame.locator(".react-flow").last();
  await flow.waitFor({ state: "visible", timeout: 30000 });
  const box = await flow.boundingBox();
  const local = { width: box.width, height: box.height };
  await dragTool(frame, "Input variable", { x: local.width * 0.25, y: local.height * 0.35 });
  await dragTool(frame, "Out variable", { x: local.width * 0.6, y: local.height * 0.35 });
  await dragTool(frame, "Block", { x: local.width * 0.4, y: local.height * 0.7 });
  const kinds = await frame.evaluate(() => Array.from(document.querySelectorAll(".react-flow__node")).map((node) => (node.className.match(/react-flow__node-(\S+)/) || [])[1]));
  check("FBD: variáveis e bloco arrastados", ["input-variable", "output-variable", "block"].every((kind) => kinds.includes(kind)), kinds.join(", "));
  await setVariable(frame, "input-variable", "DI0");
  await setVariable(frame, "output-variable", "DO0");

  // Ligação: alça de saída da variável de entrada -> alça de entrada da variável de saída.
  const source = await frame.locator(".react-flow__node-input-variable .react-flow__handle.source").first().boundingBox();
  const target = await frame.locator(".react-flow__node-output-variable .react-flow__handle.target").first().boundingBox();
  const mouse = workbench.mouse;
  await mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await mouse.down();
  for (let step = 1; step <= 12; step += 1) {
    await mouse.move(source.x + (target.x - source.x) * step / 12 + target.width / 2, source.y + (target.y - source.y) * step / 12 + target.height / 2);
    await sleep(30);
  }
  await mouse.up();
  await sleep(800);
  const edges = await frame.locator(".react-flow__edge").count();
  check("FBD: ligação feita arrastando entre as alças", edges > 0, `ligações: ${edges}`);
  // O bloco solto (sem tipo escolhido) sai antes de compilar.
  await frame.locator(".react-flow__node-block").first().click();
  await workbench.keyboard.press("Delete");
  await sleep(600);
  check("FBD: Delete apaga o bloco selecionado", await frame.locator(".react-flow__node-block").count() === 0);
  // Copiar/colar fica fora: na Webview Ctrl+C/Ctrl+V passam pela área de transferência do sistema,
  // que é a mesma da sessão de quem está usando a máquina.
  await workbench.screenshot({ path: path.join(out, "60-fbd.png") });
  await workbench.keyboard.press("Control+S");
  await sleep(1500);
  const tail = await build(frame);
  check("FBD compila no Core", /Build (finished|is up to date)/.test(tail), tail.slice(-200));
}

const SCENARIOS = { st: scenarioSt, il: scenarioIl, fbd: scenarioFbd };

(async () => {
  const languages = (process.env.OPENPLC_E2E_LANGS || "st,il,fbd").split(",").map((item) => item.trim()).filter(Boolean);
  for (const language of languages) {
    const project = await createOpenPlcProject(language, `${language}_lab`);
    const session = await launch({ projectFile: project.projectFile, width: 1700, height: 1000 });
    const logs = [];
    // Só erros da Webview do editor (o workbench do VS Code registra erros próprios).
    session.workbench.on("console", (message) => {
      if (message.type() === "error" && /vscode-(webview|resource)|vscode-cdn/.test(message.location().url ?? "")) logs.push(message.text().slice(0, 300));
    });
    try {
      await session.workbench.keyboard.press("Control+B");
      await session.workbench.keyboard.press("Control+Alt+B");
      await sleep(1500);
      await SCENARIOS[language](session);
    } catch (error) {
      check(`${language}: cenário completo`, false, error instanceof Error ? error.message.split("\n")[0] : String(error));
    } finally {
      check(`${language}: sem erros no console da Webview`, logs.length === 0, logs.slice(0, 3).join(" | "));
      await session.close();
    }
  }
  if (results.some((item) => !item.ok)) process.exitCode = 1;
})().catch((error) => { console.error(error); process.exitCode = 1; });
