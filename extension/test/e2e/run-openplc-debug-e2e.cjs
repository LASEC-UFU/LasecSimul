// Depurador e Play/Stop do OpenPLC sobre a simulação do LasecSimul: esquemático com um bloco
// "PLC IEC 61131-3" ligado a um projeto OpenPLC (DI0 -> contato -> bobina -> DO0). Play do OpenPLC
// roda a simulação (compila no Core e carrega no bloco), Debugger pinta a energia no degrau,
// "Force True" no contato energiza a bobina no CLP simulado e Stop para a simulação.
// Mouse e teclado do CDP, nunca os do sistema.
const fs = require("fs");
const path = require("path");
const { launch, createOpenPlcProject, writePlcSchematic, buildContactCoilRung, waitConsole, sleep } = require("./openplc-lab.cjs");

const out = path.join(__dirname, "artifacts", "openplc");
fs.mkdirSync(out, { recursive: true });

/** Cor do traço do símbolo de cada elemento do degrau (o OpenPLC pinta o estado no depurador). */
async function strokes(frame) {
  return frame.evaluate(() => {
    const color = (kind) => {
      const node = document.querySelector(`.react-flow__node-${kind}`);
      const painted = Array.from(node?.querySelectorAll("svg [stroke], svg [fill]") ?? [])
        .map((element) => (element.getAttribute("stroke") || element.getAttribute("fill") || "").toUpperCase())
        .filter((value) => /^#(00FF00|0464FB|80C000|4080FF)$/.test(value));
      return painted[0] ?? "";
    };
    return { contact: color("contact"), coil: color("coil") };
  });
}

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

(async () => {
  const project = await createOpenPlcProject("ld", "debug_lab");
  const fixture = writePlcSchematic(project.projectFile);
  const session = await launch({ projectFile: project.projectFile, fixture, width: 1700, height: 1000 });
  const { frame, workbench } = session;
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok, detail });
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  };
  const shot = (name) => workbench.screenshot({ path: path.join(out, `${name}.png`) });
  const store = (selector) => frame.evaluate(selector);
  const plcStatus = () => store(() => window.__lasecOpenplcStore.getState().runtimeConnection.plcStatus);
  const debuggerVisible = () => store(() => window.__lasecOpenplcStore.getState().workspace.isDebuggerVisible);
  const simulationBadge = () => workbench.locator(".statusbar").innerText();
  try {
    await workbench.keyboard.press("Control+B");
    await sleep(500);
    await workbench.locator(".tabs-container .tab", { hasText: "debug_lab.lsplc" }).first().click();
    await sleep(800);
    await buildContactCoilRung(frame, "DI0", "DO0");
    await workbench.keyboard.press("Control+S");
    await sleep(2000);

    const connection = await store(() => window.__lasecOpenplcStore.getState().runtimeConnection.connectionStatus);
    check("editor conectado ao runtime da simulação", connection === "connected", connection);

    // Play do OpenPLC = Rodar a simulação do esquemático.
    await frame.locator('button[aria-label="Play"]').click();
    const running = await waitFor(plcStatus, (value) => value === "RUNNING", 90000);
    check("Play do OpenPLC rodou a simulação", running === "RUNNING" && /rodando/i.test(await simulationBadge()), `${running}`);
    await shot("30-play-running");

    // Debugger é liga/desliga: só clica de novo se a sessão não abriu (simulação ainda subindo).
    let tail = "";
    for (let attempt = 0; attempt < 6 && !(await debuggerVisible()); attempt += 1) {
      await frame.locator('button[aria-label="Debugger"]').click();
      tail = await waitConsole(frame, /Debugger connected|No PLC block is running|Debug compilation failed/i, 60000);
      await waitFor(debuggerVisible, Boolean, 5000);
      if (!(await debuggerVisible())) {
        await frame.getByRole("button", { name: "OK" }).click().catch(() => {});
        await sleep(5000);
      }
    }
    check("depurador conectado ao CLP da simulação", await debuggerVisible(), tail.slice(-200));
    const initial = await waitFor(() => strokes(frame), (value) => value.contact !== "" && value.coil !== "");
    check("degrau pintado com DI0 e DO0 em FALSE", initial.contact === "#0464FB" && initial.coil === "#0464FB", JSON.stringify(initial));
    await shot("31-debug-false");

    // Clique no contato com o depurador ativo abre o menu do OpenPLC: Force True.
    await frame.locator(".react-flow__node-contact").first().click();
    await sleep(400);
    await frame.getByText("Force True", { exact: true }).click();
    const forced = await waitFor(() => strokes(frame), (value) => value.coil === "#00FF00");
    check("Force True em DI0 energiza a bobina DO0 no CLP", forced.coil === "#00FF00" && forced.contact === "#80C000", JSON.stringify(forced));
    await shot("32-debug-forced");

    // Stop (o mesmo botão) para a simulação.
    await frame.locator('button[aria-label="Play"]').click();
    const stopped = await waitFor(plcStatus, (value) => value === "STOPPED", 30000);
    check("Stop do OpenPLC parou a simulação", stopped === "STOPPED" && !/rodando/i.test(await simulationBadge()), `${stopped}`);
    await shot("33-stopped");

    // Aba "PLC Logs" do OpenPLC = log de simulação do LasecSimul (compilação do CLP inclusive).
    await frame.getByRole("tab", { name: "PLC Logs" }).click();
    const panel = frame.locator('[aria-label="PLC Logs panel content"]');
    const logs = await waitFor(() => panel.innerText().then((text) => text.replace(/\s+/g, " ")).catch(() => ""), (text) => /\[clp/.test(text), 8000);
    check("PLC Logs mostra o log de simulação do LasecSimul", /\[clp/.test(logs), logs.slice(0, 200));
    await shot("34-plc-logs");
  } finally {
    await session.close();
  }
  if (results.some((item) => !item.ok)) process.exitCode = 1;
})().catch((error) => { console.error(error); process.exitCode = 1; });
