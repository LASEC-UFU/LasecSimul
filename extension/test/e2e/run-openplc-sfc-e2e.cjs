// SFC dentro do editor OpenPLC: projeto .lsplc novo em SFC (Init -> DI0 -> S1 [N DO0] -> NOT DI0 ->
// Init), barra de ferramentas SFC, transição e passo arrastados (ligam sozinhos ao elemento de
// cima), condição, bloco de ação, renomear passo, desfazer/refazer, salvar no .lsplc, compilar no
// Core, Play e depurador com os passos ativos do CLP simulado. Mouse e teclado do CDP.
const fs = require("fs");
const path = require("path");
const {
  launch, createOpenPlcProject, writePlcSchematic, dragTool, waitConsole, sleep,
} = require("./openplc-lab.cjs");

const out = path.join(__dirname, "artifacts", "openplc");
fs.mkdirSync(out, { recursive: true });

async function waitFor(probe, predicate, timeoutMs = 15000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await probe();
    if (predicate(last)) return last;
    await sleep(250);
  }
  return last;
}

/** Retângulo de um elemento relativo ao canvas do React Flow (para soltar ferramentas perto dele). */
async function relativeBox(frame, selector) {
  const flow = await frame.locator(".react-flow").last().boundingBox();
  const box = await frame.locator(selector).first().boundingBox();
  return { x: box.x - flow.x, y: box.y - flow.y, width: box.width, height: box.height };
}

(async () => {
  const project = await createOpenPlcProject("sfc", "sfc_lab");
  const fixture = writePlcSchematic(project.projectFile);
  const session = await launch({ projectFile: project.projectFile, fixture, width: 1700, height: 1000 });
  const { frame, workbench } = session;
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok, detail });
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  };
  const shot = (name) => workbench.screenshot({ path: path.join(out, `${name}.png`) });
  const logs = [];
  // Só erros da Webview do editor (o workbench do VS Code registra erros próprios).
  workbench.on("console", (message) => {
    if (message.type() === "error" && /vscode-(webview|resource)|vscode-cdn/.test(message.location().url ?? "")) logs.push(message.text().slice(0, 300));
  });
  const steps = () => frame.evaluate(() => Array.from(document.querySelectorAll("[data-sfc-step]")).map((node) => node.getAttribute("data-sfc-step")));
  const counts = () => frame.evaluate(() => ({
    transitions: document.querySelectorAll(".react-flow__node-sfcTransition").length,
    edges: document.querySelectorAll(".react-flow__edge").length,
    associations: document.querySelectorAll('select[aria-label="Action qualifier"]').length,
  }));
  const store = (selector) => frame.evaluate(selector);
  try {
    await workbench.keyboard.press("Control+B");
    await workbench.keyboard.press("Control+Alt+B");
    await sleep(500);
    await workbench.locator(".tabs-container .tab", { hasText: "sfc_lab.lsplc" }).first().click();
    await sleep(1500);

    // 1. Programa inicial e barra de ferramentas.
    await frame.locator("[data-lasec-sfc-editor]").waitFor({ state: "visible", timeout: 30000 });
    await sleep(800);
    const initial = await counts();
    check("SFC inicial: Init e S1, 2 transições, 4 ligações", JSON.stringify(await steps()) === JSON.stringify(["Init", "S1"]) &&
      initial.transitions === 2 && initial.edges === 4 && initial.associations === 1, JSON.stringify({ steps: await steps(), ...initial }));
    const tools = await frame.evaluate(() => ["Step", "Initial step", "Transition", "Action block"].filter((label) => document.querySelector(`[aria-label="${label}"] [draggable]`)));
    check("barra de ferramentas SFC", tools.length === 4, tools.join(", "));
    await shot("70-sfc-initial");

    // 2. Transição solta embaixo de S1 (divergência seletiva) e passo embaixo dela.
    // O canvas fica abaixo da tabela de variáveis: menos zoom para caber o que vai ser criado.
    for (let i = 0; i < 3; i += 1) await frame.locator(".react-flow__controls-zoomout").first().click();
    await sleep(500);
    const s1 = await relativeBox(frame, '[data-sfc-step="S1"]');
    await dragTool(frame, "Transition", { x: s1.x + s1.width + 40, y: s1.y + s1.height + 30 });
    const afterTransition = await counts();
    check("transição arrastada liga sozinha a S1", afterTransition.transitions === 3 && afterTransition.edges === 5, JSON.stringify(afterTransition));
    const condition = frame.locator('input[aria-label="Transition condition"]').filter({ hasNotText: "x" });
    const fresh = await frame.evaluate(() => Array.from(document.querySelectorAll('input[aria-label="Transition condition"]')).findIndex((input) => input.value === "TRUE"));
    await condition.nth(fresh).click();
    await condition.nth(fresh).press("Control+A");
    await condition.nth(fresh).pressSequentially("S1.T >= T#2s", { delay: 40 });
    await condition.nth(fresh).press("Enter");
    await sleep(500);
    const newTransition = await frame.evaluate(() => {
      const input = Array.from(document.querySelectorAll('input[aria-label="Transition condition"]')).find((item) => item.value === "S1.T >= T#2s");
      const node = input?.closest(".react-flow__node");
      return node?.getAttribute("data-id");
    });
    check("condição da transição gravada", !!newTransition);
    const t = await relativeBox(frame, `.react-flow__node[data-id="${newTransition}"]`);
    await dragTool(frame, "Step", { x: t.x + t.width / 2, y: t.y + t.height + 40 });
    const afterStep = await counts();
    check("passo arrastado liga sozinho à transição", (await steps()).includes("S2") && afterStep.edges === 6, JSON.stringify({ steps: await steps(), ...afterStep }));

    // 3. Bloco de ação solto sobre S2, nome da ação, desfazer/refazer.
    const s2 = await relativeBox(frame, '[data-sfc-step="S2"]');
    await dragTool(frame, "Action block", { x: s2.x + s2.width / 2, y: s2.y + s2.height / 2 });
    check("bloco de ação solto sobre S2", (await counts()).associations === 2);
    const actionName = frame.locator('input[aria-label="Action name"]').nth(1);
    await actionName.click();
    await actionName.pressSequentially("DO0", { delay: 40 });
    await actionName.press("Enter");
    await sleep(400);
    await frame.locator(".react-flow__pane").last().click({ position: { x: 10, y: 10 } });
    await workbench.keyboard.press("Control+Z");
    await sleep(500);
    await workbench.keyboard.press("Control+Z");
    await sleep(500);
    const undone = (await counts()).associations;
    await workbench.keyboard.press("Control+Y");
    await sleep(500);
    await workbench.keyboard.press("Control+Y");
    await sleep(500);
    const redone = await frame.evaluate(() => Array.from(document.querySelectorAll('input[aria-label="Action name"]')).map((input) => input.value));
    check("Ctrl+Z desfaz o bloco de ação e Ctrl+Y refaz", undone === 1 && redone.includes("DO0"), `depois de desfazer: ${undone}, refeito: ${redone.join(",")}`);

    // 4. Renomear passo.
    const name = frame.locator('[data-sfc-step="S2"] input[aria-label="Step name"]');
    await name.click();
    await name.press("Control+A");
    await name.pressSequentially("TEMPO", { delay: 40 });
    await name.press("Enter");
    await sleep(500);
    check("passo renomeado", (await steps()).includes("TEMPO"), (await steps()).join(","));
    await shot("71-sfc-edited");

    // 5. Salvar no .lsplc e compilar no Core.
    await workbench.keyboard.press("Control+S");
    await sleep(2000);
    const saved = project.pou("pous/programs/main.sfc");
    check("Ctrl+S gravou o main.sfc dentro do .lsplc", /"TEMPO"/.test(saved) && /S1\.T >= T#2s/.test(saved), saved.slice(0, 80).replace(/\s+/g, " "));
    await frame.getByRole("button", { name: "Build options" }).click();
    await sleep(400);
    await frame.getByText("Build only", { exact: true }).click();
    const tail = await waitConsole(frame, /Build (finished|is up to date)|failed|error/i, 180000);
    check("SFC compila no Core", /Build (finished|is up to date)/.test(tail), tail.slice(-300));

    // 6. Simulação: Play, depurador, passos ativos.
    await frame.locator('button[aria-label="Play"]').click();
    const running = await waitFor(() => store(() => window.__lasecOpenplcStore.getState().runtimeConnection.plcStatus), (value) => value === "RUNNING", 90000);
    check("Play rodou a simulação", running === "RUNNING", running);
    const debuggerVisible = () => store(() => window.__lasecOpenplcStore.getState().workspace.isDebuggerVisible);
    for (let attempt = 0; attempt < 6 && !(await debuggerVisible()); attempt += 1) {
      await frame.locator('button[aria-label="Debugger"]').click();
      await waitConsole(frame, /Debugger connected|No PLC block is running|Debug compilation failed/i, 60000);
      await waitFor(debuggerVisible, Boolean, 5000);
      if (!(await debuggerVisible())) {
        await frame.getByRole("button", { name: "OK" }).click().catch(() => {});
        await sleep(5000);
      }
    }
    check("depurador conectado", await debuggerVisible());
    const activeSteps = () => frame.evaluate(() => Array.from(document.querySelectorAll('[data-sfc-active="true"]')).map((node) => node.getAttribute("data-sfc-step")));
    const atInit = await waitFor(activeSteps, (value) => value.join() === "Init", 15000);
    check("passo inicial ativo no CLP", atInit.join() === "Init", atInit.join(","));
    await shot("72-sfc-debug-init");

    // Força DI0 pela lista de variáveis do depurador do OpenPLC: a coluna Debug (inseto) da tabela
    // de variáveis coloca a variável na lista; clicar nela abre Force True / Force False.
    await frame.locator("table tbody tr").first().locator("td").last().locator("svg, button").first().click();
    await sleep(800);
    const row = frame.locator("p", { hasText: /^(main\.)?DI0$/i }).first();
    await row.click();
    await sleep(300);
    await frame.getByText("Force True", { exact: true }).click();
    const atS1 = await waitFor(activeSteps, (value) => value.join() === "S1", 10000);
    check("DI0 forçado: Init -> S1", atS1.join() === "S1", atS1.join(","));
    const atTempo = await waitFor(activeSteps, (value) => value.join() === "TEMPO", 10000);
    check("2 s em S1: S1 -> TEMPO (divergência seletiva)", atTempo.join() === "TEMPO", atTempo.join(","));
    await shot("73-sfc-debug-tempo");

    await frame.locator('button[aria-label="Play"]').click();
    await sleep(2000);
  } catch (error) {
    await shot("79-sfc-failure").catch(() => {});
    throw error;
  } finally {
    check("sem erros no console da Webview", logs.length === 0, logs.slice(0, 3).join(" | "));
    await session.close();
  }
  if (results.some((item) => !item.ok)) process.exitCode = 1;
})().catch((error) => { console.error(error); process.exitCode = 1; });
