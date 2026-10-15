// Bancada do editor OpenPLC: abre o VS Code de teste com a extensão, cria um projeto OpenPLC com o
// pacote do host (media/openplc-workspace/host/host.js) e abre esse projeto no editor
// "lasecsimul.openplcEditor". Mouse e teclado são do CDP (Playwright), nunca os do sistema.
const { chromium } = require("@playwright/test");
const { downloadAndUnzipVSCode } = require("@vscode/test-electron");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const harnessRoot = path.resolve(__dirname, "../..");
const repoRoot = path.resolve(harnessRoot, "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Projeto PLC novo (.lsplc) pelo mesmo serviço do assistente do OpenPLC, com DI0/DO0 no programa
 * main. `pou(relativePath)` lê um POU gravado dentro do arquivo. */
async function createOpenPlcProject(language = "ld", name = "lab") {
  const lsplc = require(path.join(harnessRoot, "out", "plc", "openplc", "lsplcFile.js"));
  const { createOpenPlcHost } = require(path.join(harnessRoot, "media", "openplc-workspace", "host", "host.js"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-openplc-lab-"));
  const host = createOpenPlcHost({
    userDataDir: path.join(root, "user-data"),
    bundledLibrariesDir: path.join(repoRoot, "plc", "strucpp", "build", `${process.platform}-${process.arch}`, "strucpp", "libs"),
    librariesDir: path.join(root, "libraries"),
  });
  const projectFile = path.join(root, `${name}.lsplc`);
  const raw = host.newProjectFiles({
    name,
    language,
    io: [{ name: "DI0", direction: "input", type: "BOOL" }, { name: "DO0", direction: "output", type: "BOOL" }],
  });
  lsplc.writeLsplc(projectFile, lsplc.bundleFromRaw(raw));
  const pou = (relativePath) => lsplc.readLsplc(projectFile).files[relativePath] ?? "";
  return { root, projectFile, host, pou };
}

/** Esquemático só com um bloco "PLC IEC 61131-3" ligado ao projeto .lsplc (pinos DI0/DO0). */
function writePlcSchematic(projectFile, io = [["DI0", "input"], ["DO0", "output"]]) {
  const file = path.join(path.dirname(projectFile), "plc_lab.lsproj");
  const relative = path.relative(path.dirname(file), projectFile).replace(/\\/g, "/");
  const exportedIo = io.map(([name, direction]) => ({ ioId: name, name, direction, iecType: "BOOL" }));
  fs.writeFileSync(file, `${JSON.stringify({
    schemaVersion: 2,
    components: [{
      id: "component-openplc-lab-plc",
      typeId: "plc.instance",
      label: "CLP OpenPLC",
      showValue: false,
      showDialValue: false,
      visual: { x: 420, y: 260, rotation: 0 },
      properties: { plcIecProjectRef: relative, plcArtifactRef: "", plcEntryConfiguration: "", plcTaskIntervalMs: 10 },
      plc: { iecProjectRef: relative, exportedIoBindingVersion: 1, exportedIo },
    }],
    topology: { revision: 1, nodes: [], conductors: [] },
    visual: { viewport: { x: 0, y: 0, zoom: 1 } },
    simulationSettings: {},
  }, null, 2)}\n`);
  return file;
}

/**
 * Espelho do repositório só com junções (nada é copiado nem alterado no repo): mesma extensão,
 * mesmo Core compilado, mas `core/src` só com `core/src/plc`. Serve quando outra pessoa está
 * editando fontes do Core em paralelo: a extensão de desenvolvimento recusa um Core mais velho
 * que `core/src` (coreExecutable.ts), e o editor OpenPLC não depende dessas outras fontes.
 * Ativado por LASECSIMUL_OPENPLC_LAB_MIRROR=1.
 */
function prepareMirror() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-openplc-mirror-"));
  const mirror = path.join(base, path.basename(repoRoot));
  fs.mkdirSync(mirror);
  const junction = (target, link) => fs.symlinkSync(target, link, "junction");
  // MinGW do MSYS2 fica ao lado do repositório (plcBuild.ts::resolvePlcToolchain).
  const tools = path.resolve(repoRoot, "..", "tools");
  if (fs.existsSync(tools)) junction(tools, path.join(base, "tools"));
  for (const entry of fs.readdirSync(repoRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || ["core", "extension", ".git"].includes(entry.name)) continue;
    junction(path.join(repoRoot, entry.name), path.join(mirror, entry.name));
  }
  fs.mkdirSync(path.join(mirror, "core", "src"), { recursive: true });
  junction(path.join(repoRoot, "core", "build"), path.join(mirror, "core", "build"));
  junction(path.join(repoRoot, "core", "src", "plc"), path.join(mirror, "core", "src", "plc"));
  const extension = path.join(mirror, "extension");
  fs.mkdirSync(extension);
  for (const entry of fs.readdirSync(harnessRoot, { withFileTypes: true })) {
    const source = path.join(harnessRoot, entry.name);
    if (entry.isDirectory()) junction(source, path.join(extension, entry.name));
    else fs.copyFileSync(source, path.join(extension, entry.name));
  }
  return extension;
}

/** Remove só as junções e pastas do espelho (nunca segue a junção para dentro do repo). */
function removeMirror(extension) {
  const mirror = path.dirname(path.dirname(extension));
  const unlinkTree = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isSymbolicLink() || fs.lstatSync(target).isSymbolicLink()) fs.rmdirSync(target);
      else if (entry.isDirectory()) unlinkTree(target);
      else fs.unlinkSync(target);
    }
    fs.rmdirSync(dir);
  };
  try { unlinkTree(mirror); } catch { /* fica no temp */ }
}

async function launch({ projectFile, fixture, width = 1600, height = 960, settings }) {
  const port = 9300 + Math.floor(Math.random() * 300);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-openplc-lab-user-"));
  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-openplc-lab-ext-"));
  fs.mkdirSync(path.join(userData, "User"), { recursive: true });
  fs.writeFileSync(path.join(userData, "User", "settings.json"), JSON.stringify({
    "workbench.colorTheme": "Default Dark Modern",
    "window.zoomLevel": 0,
    ...settings,
  }));
  const executable = await downloadAndUnzipVSCode({
    version: process.env.VSCODE_E2E_VERSION || "1.128.0",
    cachePath: path.resolve(harnessRoot, ".vscode-test"),
    timeout: 120000,
  });
  const childEnv = { ...process.env, LASECSIMUL_E2E: "1", LASECSIMUL_E2E_OPENPLC_PROJECT: projectFile,
    ...(fixture ? { LASECSIMUL_E2E_FIXTURE: fixture } : {}) };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const extensionPath = process.env.LASECSIMUL_OPENPLC_LAB_MIRROR === "1" ? prepareMirror() : harnessRoot;
  let childOutput = "";
  const child = spawn(executable, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, `--extensions-dir=${extensionsDir}`,
    `--extensionDevelopmentPath=${extensionPath}`, "--disable-workspace-trust", "--disable-updates",
    "--skip-welcome", "--force-device-scale-factor=1", "--disable-gpu", "--disable-shared-process", "--new-window",
    path.dirname(projectFile),
  ], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  const capture = (chunk) => { childOutput = (childOutput + chunk.toString()).slice(-20000); };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);

  let browser;
  const close = async () => {
    if (browser) await browser.close().catch(() => {});
    child.kill();
    if (extensionPath !== harnessRoot) {
      await sleep(3000);
      removeMirror(extensionPath);
    }
  };
  try {
    for (let attempt = 0; attempt < 120 && !browser; attempt += 1) {
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); }
      catch { await sleep(250); }
    }
    if (!browser) throw new Error("VS Code de teste não iniciou");
    let workbench;
    for (let attempt = 0; attempt < 160 && !workbench; attempt += 1) {
      const pages = browser.contexts().flatMap((context) => context.pages());
      workbench = pages.find((page) => page.url().includes("workbench"));
      if (!workbench) await sleep(250);
    }
    if (!workbench) throw new Error("Workbench não abriu");
    await workbench.locator(".monaco-workbench").waitFor({ state: "visible", timeout: 60000 });
    await workbench.setViewportSize({ width, height });
    const frame = await findOpenPlcFrame(workbench, 480);
    if (!frame) {
      await workbench.screenshot({ path: path.join(__dirname, "artifacts", "openplc", "failed-open.png") }).catch(() => {});
      const frames = await Promise.all(workbench.frames().map(async (f) => {
        const text = await f.evaluate(() => document.body?.innerText?.slice(0, 200) ?? "").catch((e) => `ERR ${e.message}`);
        return `${f.url().slice(0, 120)} :: ${text.replace(/\s+/g, " ")}`;
      }));
      throw new Error(`Editor OpenPLC não abriu. Frames:\n${frames.join("\n")}\n${childOutput.slice(-1500)}`);
    }
    await frame.evaluate(() => document.fonts.ready);
    await sleep(1500);
    return { workbench, frame, close, output: () => childOutput };
  } catch (error) {
    await close();
    throw error;
  }
}

async function findOpenPlcFrame(workbench, attempts) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    for (const candidate of workbench.frames()) {
      if (candidate === workbench.mainFrame()) continue;
      const ready = await candidate.evaluate(() => document.body?.dataset.lasecOpenplc === "ready").catch(() => false);
      if (ready) return candidate;
    }
    await sleep(250);
  }
  return undefined;
}

/** Retângulo de um elemento do editor em coordenadas da página do workbench (para o mouse do CDP). */
async function boxInWorkbench(frame, locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("elemento sem caixa");
  return box;
}

/** Retângulo do último degrau (React Flow) do editor Ladder. */
async function flowBox(frame) {
  return frame.evaluate(() => {
    const flows = Array.from(document.querySelectorAll(".react-flow"));
    const flow = flows[flows.length - 1];
    if (!flow) return undefined;
    const rect = flow.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
}

/** Arrasta uma ferramenta da barra do OpenPLC (Contact, Coil, Block) para o degrau. */
async function dragTool(frame, label, target) {
  const source = frame.locator(`[aria-label="${label}"] [draggable], [aria-label="${label}"][draggable]`).first();
  await source.dragTo(frame.locator(".react-flow").last(), { targetPosition: target });
  await sleep(900);
}

/** Espera `probe()` satisfazer `predicate` (ou o tempo acabar) e devolve o último valor. */
async function waitFor(probe, predicate, timeoutMs = 10000) {
  const started = Date.now();
  let last = await probe();
  while (!predicate(last) && Date.now() - started < timeoutMs) {
    await sleep(200);
    last = await probe();
  }
  return last;
}

/** Arrasta a ferramenta até aparecer um nó do tipo `kind` a mais (uma nova tentativa se o primeiro
 * arraste se perder enquanto o editor ainda redesenha). */
async function dragUntil(frame, label, target, kind) {
  const count = () => frame.locator(`.react-flow__node-${kind}`).count();
  const before = await count();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await dragTool(frame, label, target);
    if (await waitFor(count, (value) => value > before, 4000) > before) return true;
  }
  return false;
}

/** Campo "???" acima do elemento, com o autocompletar do OpenPLC. Ctrl+A de propósito: na
 * Webview o VS Code repetia o "selecionar tudo" depois da primeira letra (main.tsx evita). */
async function setVariable(frame, kind, name) {
  const input = frame.locator(`.react-flow__node-${kind} textarea`).first();
  await input.click();
  await sleep(400);
  await input.press("Control+A");
  await input.pressSequentially(name, { delay: 90 });
  await sleep(400);
  await input.press("Enter");
  await sleep(500);
  await frame.locator(".react-flow__pane").last().click({ position: { x: 20, y: 20 } });
  await sleep(400);
}

/** Degrau novo com contato `contact` e bobina `coil` (variáveis já existentes no programa). */
async function buildContactCoilRung(frame, contact = "DI0", coil = "DO0") {
  await frame.getByRole("button", { name: "Create new rung button" }).click();
  const box = await waitFor(() => flowBox(frame), Boolean, 10000);
  if (!box) throw new Error("degrau não criado");
  await sleep(600);
  await dragUntil(frame, "Contact", { x: box.width * 0.3, y: box.height / 2 }, "contact");
  await dragUntil(frame, "Coil", { x: box.width * 0.7, y: box.height / 2 }, "coil");
  await setVariable(frame, "contact", contact);
  await setVariable(frame, "coil", coil);
  return box;
}

/** Texto do console do OpenPLC até casar com `pattern`. */
async function waitConsole(frame, pattern, timeoutMs = 120000) {
  const started = Date.now();
  let tail = "";
  while (Date.now() - started < timeoutMs) {
    const text = await frame.evaluate(() => document.body.innerText);
    tail = (text.split("Console").pop() ?? "").replace(/\s+/g, " ");
    if (pattern.test(tail)) break;
    await sleep(500);
  }
  return tail;
}

/** Comando da paleta do VS Code, digitado pelo teclado do CDP. */
async function runCommand(workbench, title) {
  await workbench.keyboard.press("F1");
  const input = workbench.locator(".quick-input-widget input").first();
  await input.waitFor({ state: "visible", timeout: 15000 });
  await input.fill(`>${title}`);
  await sleep(600);
  await workbench.keyboard.press("Enter");
}

module.exports = {
  launch, createOpenPlcProject, writePlcSchematic, runCommand, findOpenPlcFrame, boxInWorkbench,
  flowBox, dragTool, dragUntil, waitFor, setVariable, buildContactCoilRung, waitConsole, sleep, harnessRoot, repoRoot,
  prepareMirror, removeMirror,
};
