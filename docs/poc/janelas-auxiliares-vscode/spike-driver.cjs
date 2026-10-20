// Drives the window spike in a separate VS Code instance over CDP. Usage: node spike-driver.cjs <Code.exe> <runDir> <extDir> <playwrightModulePath>
const [exe, runDir, extDir, playwrightPath, settingsJson] = process.argv.slice(2);
const { chromium } = require(playwrightPath);
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

fs.rmSync(runDir, { recursive: true, force: true });
fs.mkdirSync(runDir, { recursive: true });
const logFile = path.join(runDir, "log.jsonl");
const driverLog = (msg, data = {}) => fs.appendFileSync(path.join(runDir, "driver.jsonl"), JSON.stringify({ t: Date.now(), msg, ...data }) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(port) {
  let last;
  for (let i = 0; i < 120; i++) { try { return await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch (e) { last = e; await sleep(250); } }
  throw last;
}

(async () => {
  const port = 9800 + Math.floor(Math.random() * 150);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "lasec-spike-user-"));
  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "lasec-spike-ext-"));
  if (settingsJson) {
    fs.mkdirSync(path.join(userData, "User"), { recursive: true });
    fs.writeFileSync(path.join(userData, "User", "settings.json"), settingsJson);
  }
  const env = { ...process.env, SPIKE_DIR: runDir };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(exe, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, `--extensions-dir=${extensionsDir}`,
    `--extensionDevelopmentPath=${extDir}`, "--disable-extensions", "--disable-workspace-trust", "--disable-updates", "--skip-welcome",
    "--disable-gpu", "--new-window"], { env, stdio: "ignore" });
  const deadline = Date.now() + 240000;
  let browser;
  try {
    browser = await connect(port);
    const cdp = await browser.newBrowserCDPSession();
    const pages = () => browser.contexts().flatMap((c) => c.pages());
    let main;
    while (!main && Date.now() < deadline) { main = pages().find((p) => p.url().includes("workbench")); if (!main) await sleep(250); }
    driverLog("main", { url: main && main.url() });
    const auxPages = () => pages().filter((p) => p !== main);
    const windowIdOf = async (page) => {
      const session = await page.context().newCDPSession(page);
      const { targetInfo } = await session.send("Target.getTargetInfo");
      const { windowId, bounds } = await cdp.send("Browser.getWindowForTarget", { targetId: targetInfo.targetId });
      return { windowId, bounds };
    };
    const snapshotPages = async (tag) => {
      const list = [];
      for (const p of pages()) {
        let win;
        try { win = await windowIdOf(p); } catch (e) { win = { error: String(e.message) }; }
        let size;
        try { size = await p.evaluate(() => ({ outerWidth, outerHeight, innerWidth, innerHeight, screenX, screenY, fs: document.body.classList.contains("fullscreen"), bodyClasses: document.body.className.slice(0, 300) })); } catch (e) { size = { error: String(e.message) }; }
        list.push({ url: p.url().slice(0, 140), isMain: p === main, win, size });
      }
      driverLog("pages:" + tag, { count: list.length, list });
    };
    const shot = async (page, name) => { try { await page.screenshot({ path: path.join(runDir, name + ".png") }); } catch (e) { driverLog("shotError", { name, e: String(e.message) }); } };
    const ack = (name) => fs.writeFileSync(path.join(runDir, "ack-" + name), "1");
    const handled = new Set();
    let done = false;
    while (!done && Date.now() < deadline) {
      await sleep(200);
      if (!fs.existsSync(logFile)) continue;
      const lines = fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      if (lines.some((l) => l.event === "done" || l.event === "error")) done = true;
      for (const l of lines.filter((x) => x.event === "phase")) {
        if (handled.has(l.name)) continue;
        handled.add(l.name);
        driverLog("phase", { name: l.name });
        await snapshotPages(l.name);
        const aux = auxPages()[0];
        if (["undocked", "fullscreen-on", "compact", "compact-fullscreen", "second-panel"].includes(l.name) && aux) await shot(aux, l.name);
        if (l.name === "click-requestFullscreen" && aux) {
          let clicked = false;
          for (let i = 0; i < 40 && !clicked; i++) {
            for (const frame of aux.frames()) {
              try { if (await frame.locator("#fs").count()) { await frame.locator("#fs").click({ timeout: 3000 }); clicked = true; break; } } catch { /* frame in flux */ }
            }
            if (!clicked) await sleep(250);
          }
          driverLog("clickedFs", { clicked });
          continue;
        }
        const winctl = (titleLike, notTitleLike, action, rect = "") => {
          try {
            return execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${path.join(__dirname, "winctl.ps1")}" -ProcessId ${child.pid} -TitleLike "${titleLike}" -NotTitleLike "${notTitleLike}" -Action ${action} ${rect}`, { encoding: "utf8" }).trim();
          } catch (e) { return "error: " + String(e.message).slice(0, 300); }
        };
        if (l.name.startsWith("list-")) driverLog("auxRect:" + l.name, { out: winctl("*Spike HMI*", "", "list"), main: winctl("*Visual Studio Code*", "*Spike HMI*", "list") });
        if (l.name === "move-left") driverLog("moveLeft", { out: winctl("*Spike HMI*", "", "move", "-X -1266 -Y 100 -W 900 -H 600") });
        if (l.name === "straddle") driverLog("straddle", { out: winctl("*Spike HMI*", "", "move", "-X -700 -Y 100 -W 1000 -H 600") });
        if (l.name === "maximize-left") driverLog("maximizeLeft", { out: winctl("*Spike HMI*", "", "maximize") });
        if (l.name === "restore-left") driverLog("restoreLeft", { out: winctl("*Spike HMI*", "", "restore") });
        if (l.name === "list-left-fullscreen" && aux) await shot(aux, "left-fullscreen");
        if (l.name === "maximize") driverLog("maximizeAux", { out: winctl("*Spike HMI*", "", "maximize") });
        if (l.name === "maximized-fullscreen-off") driverLog("auxStateAfterFullscreenOff", { out: winctl("*Spike HMI*", "", "list") });
        if (l.name === "minimize-main") driverLog("minimizeMain", { out: winctl("*Visual Studio Code*", "*Spike HMI*", "minimize") });
        if (l.name === "restore-main") driverLog("restoreMain", { out: winctl("*Visual Studio Code*", "*Spike HMI*", "restore") });
        await sleep(300);
        ack(l.name);
      }
    }
    await snapshotPages("final");
    driverLog("finished", { done });
  } catch (err) {
    driverLog("driverError", { e: String(err && err.stack || err) });
  } finally {
    try { await browser?.close(); } catch { /* ignore */ }
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" }); } catch { /* already gone */ }
  }
})();
