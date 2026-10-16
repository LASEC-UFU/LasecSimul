// Exemplos de trm/plc (.lsplc) abertos no editor OpenPLC dentro do VS Code, em LD e em SFC (cópias do
// projeto e do esquemático numa pasta temporária). Confere o desenho (degraus com paralelo e blocos;
// passos, transições e ações), que o projeto abre sem modificação, compila pelo Build do OpenPLC, roda
// a simulação pelo Play no esquemático do exemplo e, no LD, que o depurador lê membros de instâncias de
// FB (T1.Q, T1.ET, FLIP.Q). Mouse e teclado do CDP.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { launch, waitConsole, waitFor, sleep, repoRoot } = require("./openplc-lab.cjs");

const out = path.join(__dirname, "artifacts", "openplc");
fs.mkdirSync(out, { recursive: true });
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

/** Cópia do exemplo (projeto .lsplc + esquemático) numa pasta temporária. */
function copyExample(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-openplc-example-"));
  for (const file of [`${name}.lsplc`, `${name}.lsproj`]) fs.copyFileSync(path.join(repoRoot, "trm", "plc", file), path.join(root, file));
  return { projectFile: path.join(root, `${name}.lsplc`), schematic: path.join(root, `${name}.lsproj`) };
}

async function build(frame) {
  await frame.getByRole("button", { name: "Build options" }).click();
  await sleep(400);
  await frame.getByText("Build only", { exact: true }).click();
  return waitConsole(frame, /Build (finished|is up to date)|failed|error/i);
}

async function openPou(frame, name) {
  // O projeto abre sem POU aberto; o duplo clique no explorer do OpenPLC abre o programa.
  const item = frame.getByText(name, { exact: true }).first();
  await item.waitFor({ state: "visible", timeout: 30000 });
  await item.dblclick();
  await sleep(1500);
}

/** Play do OpenPLC; `whileRunning` roda com a simulação ligada, antes do Stop. */
async function play(frame, workbench, whileRunning = async () => undefined) {
  await frame.locator('button[aria-label="Play"]').click();
  const status = await waitFor(() => frame.evaluate(() => window.__lasecOpenplcStore.getState().runtimeConnection.plcStatus), (value) => value === "RUNNING", 90000);
  const badge = await workbench.locator(".statusbar").innerText();
  await whileRunning();
  await frame.locator('button[aria-label="Play"]').click();
  await waitFor(() => frame.evaluate(() => window.__lasecOpenplcStore.getState().runtimeConnection.plcStatus), (value) => value === "STOPPED", 30000);
  return { status, badge };
}

/** Debugger do OpenPLC ligado ao CLP simulado (o botão liga/desliga; só clica de novo se não abriu). */
async function openDebugger(frame) {
  const visible = () => frame.evaluate(() => window.__lasecOpenplcStore.getState().workspace.isDebuggerVisible);
  for (let attempt = 0; attempt < 6 && !(await visible()); attempt += 1) {
    await frame.locator('button[aria-label="Debugger"]').click();
    await waitConsole(frame, /Debugger connected|No PLC block is running|Debug compilation failed/i, 60000);
    await waitFor(visible, Boolean, 5000);
    if (!(await visible())) {
      await frame.getByRole("button", { name: "OK" }).click().catch(() => {});
      await sleep(5000);
    }
  }
  return visible();
}

async function scenarioLd() {
  const { projectFile, schematic } = copyExample("partida_pisca_ld");
  const session = await launch({ projectFile, fixture: schematic, width: 1700, height: 1100 });
  const { frame, workbench } = session;
  try {
    await workbench.keyboard.press("Control+B");
    await sleep(500);
    await workbench.locator(".tabs-container .tab", { hasText: "partida_pisca_ld.lsplc" }).first().click();
    await sleep(800);
    if ((await frame.locator(".react-flow").count()) === 0) await openPou(frame, "MAIN");
    const counts = await waitFor(() => frame.evaluate(() => {
      const count = (kind) => document.querySelectorAll(`.react-flow__node-${kind}`).length;
      return { rungs: document.querySelectorAll(".react-flow").length, contact: count("contact"), coil: count("coil"), block: count("block"), parallel: count("parallel") };
    }), (value) => value.rungs >= 4, 30000);
    check("LD: 4 degraus com contatos, bobinas, blocos e o paralelo do selo",
      counts.rungs === 4 && counts.contact === 8 && counts.coil === 3 && counts.block === 3 && counts.parallel === 2, JSON.stringify(counts));
    // O tipo do bloco aparece no desenho em SVG; o store do editor diz qual é.
    const blocks = await frame.evaluate(() => window.__lasecOpenplcStore.getState().ladderFlows
      .flatMap((flow) => flow.rungs.flatMap((rung) => rung.nodes.filter((node) => node.type === "block").map((node) => node.data.variant?.name))));
    check("LD: blocos TON, TOGGLE_1 e ADD", ["TON", "TOGGLE_1", "ADD"].every((name) => blocks.includes(name)), blocks.join(" | "));
    const dirty = await workbench.locator(".tabs-container .tab.dirty").count();
    check("LD: projeto abre sem modificação", dirty === 0, `abas sujas: ${dirty}`);
    await workbench.screenshot({ path: path.join(out, "70-example-ld.png") });
    await frame.locator(".react-flow").nth(3).scrollIntoViewIfNeeded();
    await sleep(600);
    await workbench.screenshot({ path: path.join(out, "72-example-ld-blocks.png") });
    const tail = await build(frame);
    check("LD compila no Core", /Build (finished|is up to date)/.test(tail), tail.slice(-160));
    const ran = await play(frame, workbench, async () => {
      // Depurador: membros das instâncias de FB (T1 : TON, FLIP : TOGGLE_1) no mapa, com valor do CLP.
      check("LD: depurador conectado ao CLP do exemplo", await openDebugger(frame));
      const members = ["MAIN:T1.Q", "MAIN:T1.ET", "MAIN:FLIP.Q"];
      // O OpenPLC só consulta o que está à vista: T1.Q é contato no degrau; T1.ET e FLIP.Q, só no mapa.
      const read = () => frame.evaluate((keys) => {
        const workspace = window.__lasecOpenplcStore.getState().workspace;
        const value = (key) => workspace.debugBoolValues.get(key) ?? workspace.debugNonBoolValues.get(key);
        return keys.map((key) => `${key}=${workspace.debugVariableIndexes.has(key) ? value(key) ?? "?" : "fora do mapa"}`);
      }, members);
      const seen = await waitFor(read, (list) => !list.some((item) => /fora do mapa$/.test(item)) && !/=\?$/.test(list[0]), 20000);
      check("LD: depurador mapeia membros de FB e lê T1.Q do CLP", !seen.some((item) => /fora do mapa$/.test(item)) && !/=\?$/.test(seen[0]), seen.join(", "));
      await workbench.screenshot({ path: path.join(out, "73-example-ld-debug.png") });
    });
    check("LD roda no esquemático do exemplo (pinos START/STOP/LAMP/BLINK)", ran.status === "RUNNING" && /rodando/i.test(ran.badge), `${ran.status}`);
  } finally {
    await session.close();
  }
}

async function scenarioSfc() {
  const { projectFile, schematic } = copyExample("semaforo_sfc");
  const session = await launch({ projectFile, fixture: schematic, width: 1700, height: 1100 });
  const { frame, workbench } = session;
  try {
    await workbench.keyboard.press("Control+B");
    await sleep(500);
    await workbench.locator(".tabs-container .tab", { hasText: "semaforo_sfc.lsplc" }).first().click();
    await sleep(800);
    if ((await frame.locator("[data-sfc-step]").count()) === 0) await openPou(frame, "MAIN");
    const drawn = await waitFor(() => frame.evaluate(() => ({
      steps: Array.from(document.querySelectorAll("[data-sfc-step]")).map((node) => node.getAttribute("data-sfc-step")),
      transitions: document.querySelectorAll(".react-flow__node-sfcTransition").length,
      edges: document.querySelectorAll(".react-flow__edge").length,
    })), (value) => value.steps.length >= 3, 30000);
    check("SFC: passos VM, VD e AM e as 4 transições", ["VM", "VD", "AM"].every((name) => drawn.steps.includes(name)) && drawn.transitions === 4, JSON.stringify(drawn));
    const actions = await frame.evaluate(() => Array.from(document.querySelectorAll(".react-flow__node-sfcStep input")).map((input) => input.value).filter(Boolean));
    check("SFC: blocos de ação com as saídas e a ação CONTA", ["VERMELHO", "VERDE", "AMARELO", "CONTA"].every((name) => actions.includes(name)), actions.join(", "));
    await workbench.screenshot({ path: path.join(out, "71-example-sfc.png") });
    const tail = await build(frame);
    check("SFC compila no Core", /Build (finished|is up to date)/.test(tail), tail.slice(-160));
    const ran = await play(frame, workbench);
    check("SFC roda no esquemático do exemplo", ran.status === "RUNNING" && /rodando/i.test(ran.badge), `${ran.status}`);
  } finally {
    await session.close();
  }
}

(async () => {
  for (const scenario of [scenarioLd, scenarioSfc]) {
    try {
      await scenario();
    } catch (error) {
      check(`${scenario.name}: cenário completo`, false, error instanceof Error ? error.message.split("\n")[0] : String(error));
    }
  }
  if (results.some((item) => !item.ok)) process.exitCode = 1;
})().catch((error) => { console.error(error); process.exitCode = 1; });
