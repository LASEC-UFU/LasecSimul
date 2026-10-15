// Editor OpenPLC dentro do VS Code: degrau novo, contato e bobina arrastados da barra de
// ferramentas (arrastar HTML5, como no OpenPLC), salvar pelo VS Code, variáveis pelo autocompletar
// do OpenPLC e compilação no Core pelo botão Build. Fotos de cada passo em artifacts/openplc.
// Mouse e teclado são do CDP (Playwright) dentro do VS Code de teste, nunca os do sistema.
const fs = require("fs");
const path = require("path");
const { launch, createOpenPlcProject, flowBox, dragUntil, waitFor, setVariable, waitConsole, sleep } = require("./openplc-lab.cjs");

const out = path.join(__dirname, "artifacts", "openplc");
fs.mkdirSync(out, { recursive: true });

async function shot(session, name) {
  await session.workbench.screenshot({ path: path.join(out, `${name}.png`) });
}

async function nodes(frame) {
  return frame.evaluate(() => Array.from(document.querySelectorAll(".react-flow__node"))
    .map((node) => `${node.getAttribute("data-id")}:${(node.className.match(/react-flow__node-(\S+)/) || [])[1]}`));
}

(async () => {
  const project = await createOpenPlcProject(process.env.OPENPLC_E2E_LANGUAGE || "ld", "ladder_lab");
  const session = await launch({ projectFile: project.projectFile, width: 1700, height: 1000 });
  const logs = [];
  session.workbench.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) logs.push(`${message.type()}: ${message.text().slice(0, 300)}`);
  });
  const { frame, workbench } = session;
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok, detail });
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  };
  const mainLd = () => project.pou("pous/programs/main.ld");
  try {
    // Mais espaço para o editor: fecha a barra lateral e o painel auxiliar do VS Code.
    await workbench.keyboard.press("Control+B");
    await workbench.keyboard.press("Control+Alt+B");
    await sleep(1200);
    await shot(session, "10-opened");

    const rows = await frame.evaluate(() => Array.from(document.querySelectorAll("table tbody tr")).map((row) => row.innerText.replace(/\s+/g, " ").trim()));
    check("variáveis DI0/DO0 na tabela", rows.some((row) => row.includes("DI0")) && rows.some((row) => row.includes("DO0")), rows.join(" | "));

    await frame.getByRole("button", { name: "Create new rung button" }).click();
    const box = await waitFor(() => flowBox(frame), Boolean, 10000);
    await sleep(600);
    check("degrau criado", !!box, JSON.stringify(box));
    await shot(session, "11-rung");
    if (!box) throw new Error("sem degrau");

    await dragUntil(frame, "Contact", { x: box.width * 0.3, y: box.height / 2 }, "contact");
    await shot(session, "12-contact");
    await dragUntil(frame, "Coil", { x: box.width * 0.7, y: box.height / 2 }, "coil");
    await shot(session, "13-coil");
    const list = await nodes(frame);
    check("contato no degrau", list.some((item) => item.includes(":contact")));
    check("bobina no degrau", list.some((item) => item.includes(":coil")));

    // Desfazer/refazer pelo teclado (no Electron vinham do menu Edit do OpenPLC).
    const coilCount = () => frame.locator(".react-flow__node-coil").count();
    await frame.locator(".react-flow__pane").last().click({ position: { x: 10, y: 10 } });
    await workbench.keyboard.press("Control+Z");
    const afterUndo = await waitFor(coilCount, (value) => value === 0, 5000);
    await workbench.keyboard.press("Control+Y");
    const afterRedo = await waitFor(coilCount, (value) => value === 1, 5000);
    check("Ctrl+Z tira a bobina e Ctrl+Y devolve", afterUndo === 0 && afterRedo === 1, `depois de desfazer: ${afterUndo}, de refazer: ${afterRedo}`);

    // Duplicar degrau pelo cabeçalho do degrau.
    const rungCount = () => frame.locator(".react-flow").count();
    await frame.locator('[aria-label="Duplicate body button"]').first().click();
    let rungs = await waitFor(rungCount, (value) => value === 2, 5000);
    if (rungs !== 2) {
      await frame.locator('[aria-label="Duplicate body button"]').first().click();
      rungs = await waitFor(rungCount, (value) => value === 2, 5000);
    }
    check("degrau duplicado pelo cabeçalho", rungs === 2, `degraus: ${rungs}`);
    await frame.locator('[aria-label="Delete body button"]').last().click();
    await sleep(600);
    await frame.getByRole("button", { name: /^(Delete|Confirm|Yes)$/ }).first().click().catch(() => {});
    const remaining = await waitFor(rungCount, (value) => value === 1, 5000);
    check("degrau extra apagado", remaining === 1, `degraus: ${remaining}`);

    // Library Manager: as quatro bibliotecas embutidas do OpenPLC 4.2.8.
    await frame.getByText("+ Manage libraries…", { exact: true }).click();
    await sleep(1500);
    const manager = await frame.evaluate(() => document.body.innerText);
    check("Library Manager lista as bibliotecas do OpenPLC",
      ["Additional Function Blocks", "Standard Function Blocks", "Standard Functions", "OSCAT Basic"].every((name) => manager.includes(name)));
    await shot(session, "13b-library-manager");
    // De volta ao POU main (aba do OpenPLC ou item do explorer, o que estiver clicável).
    const mains = frame.getByText(/^\*?\s*main$/);
    for (let index = 0; index < await mains.count(); index += 1) {
      await mains.nth(index).click().catch(() => {});
      await sleep(600);
      if (await frame.locator(".react-flow__node-coil textarea").first().isVisible().catch(() => false)) break;
    }

    const dirtyTab = await workbench.locator(".tab.dirty").count();
    check("aba do VS Code marcada como modificada", dirtyTab > 0, `abas sujas: ${dirtyTab}`);
    await workbench.keyboard.press("Control+S");
    await sleep(2500);
    const dirtyAfter = await workbench.locator(".tab.dirty").count();
    check("Ctrl+S gravou o main.ld", /"rungs"\s*:\s*\[\s*\{/.test(mainLd()) && dirtyAfter === 0, `abas sujas depois: ${dirtyAfter}`);
    await shot(session, "14-saved");

    await setVariable(frame, "contact", "DI0");
    await setVariable(frame, "coil", "DO0");
    const names = await frame.evaluate(() => Array.from(document.querySelectorAll(".react-flow__node textarea")).map((item) => item.value));
    check("variáveis nos elementos", names.includes("DI0") && names.includes("DO0"), names.join(", "));
    await shot(session, "15-variables");

    // Compilar pelo botão do OpenPLC (Build options -> Build only): ST do OpenPLC -> Core.
    await frame.getByRole("button", { name: "Build options" }).click();
    await sleep(400);
    await frame.getByText("Build only", { exact: true }).click();
    const tail = await waitConsole(frame, /Build (finished|is up to date)|failed|error/i);
    check("compilou no Core pelo botão Build", /Build (finished|is up to date)/.test(tail), tail.slice(0, 500));
    check("main.ld salvo com DI0 e DO0 nos elementos", /"name"\s*:\s*"DI0"/.test(mainLd()) && /"name"\s*:\s*"DO0"/.test(mainLd()));
    await shot(session, "16-build");
  } finally {
    fs.writeFileSync(path.join(out, "console.log"), logs.join("\n"));
    console.log(`console: ${logs.length} avisos/erros (artifacts/openplc/console.log)`);
    await session.close();
  }
  if (results.some((item) => !item.ok)) process.exitCode = 1;
})().catch((error) => { console.error(error); process.exitCode = 1; });
