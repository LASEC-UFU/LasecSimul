// Throwaway spike: verifies how a WebviewPanel behaves when moved to an auxiliary window,
// full-screened, maximized, compacted and docked back. Writes a JSON-lines log to SPIKE_DIR.
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

const dir = process.env.SPIKE_DIR;
const log = (event, data = {}) => {
  if (!dir) return;
  fs.appendFileSync(path.join(dir, "log.jsonl"), JSON.stringify({ t: Date.now(), event, ...data }) + "\n");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFile(name, timeoutMs = 60000) {
  const file = path.join(dir, name);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(file)) return true;
    await sleep(100);
  }
  return false;
}

function html() {
  const nonce = String(Date.now());
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>html,body{margin:0;height:100%;background:#0b1f3a;color:#fff;font:14px system-ui}button{margin:20px;font-size:18px}</style></head>
<body><button id="fs">requestFullscreen</button><div id="out"></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const st = vscode.getState() || { boots: 0 };
st.boots++; vscode.setState(st);
let ticks = 0;
const geo = () => ({ boots: st.boots, screenX: window.screenX, screenY: window.screenY, outerWidth: window.outerWidth, outerHeight: window.outerHeight,
  innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio,
  screen: { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight, availLeft: screen.availLeft, availTop: screen.availTop },
  fullscreenEnabled: document.fullscreenEnabled, fullscreenElement: Boolean(document.fullscreenElement),
  permissionsPolicyFullscreen: document.permissionsPolicy ? document.permissionsPolicy.allowsFeature('fullscreen') : (document.featurePolicy ? document.featurePolicy.allowsFeature('fullscreen') : 'n/a'),
  visibility: document.visibilityState, hasFocus: document.hasFocus(), ticks });
document.getElementById('fs').addEventListener('click', () => {
  document.documentElement.requestFullscreen().then(() => vscode.postMessage({ type: 'fsResult', ok: true, geo: geo() }))
    .catch((e) => vscode.postMessage({ type: 'fsResult', ok: false, error: String(e && e.name) + ': ' + String(e && e.message), geo: geo() }));
});
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => vscode.postMessage({ type: 'resize', geo: geo() }), 250); });
document.addEventListener('visibilitychange', () => vscode.postMessage({ type: 'visibility', geo: geo() }));
window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (m.type === 'measure') vscode.postMessage({ type: 'measure', tag: m.tag, geo: geo() });
  if (m.type === 'tick') ticks++;
  if (m.type === 'ticks?') vscode.postMessage({ type: 'ticks', ticks, geo: geo() });
});
vscode.postMessage({ type: 'ready', geo: geo() });
</script></body></html>`;
}

function tabSnapshot() {
  return vscode.window.tabGroups.all.map((g) => ({ viewColumn: g.viewColumn, isActive: g.isActive, tabs: g.tabs.map((t) => t.label) }));
}

async function run() {
  log("start", { vscodeVersion: vscode.version });
  const cmds = await vscode.commands.getCommands(true);
  log("commands", { present: ["workbench.action.moveEditorToNewWindow", "workbench.action.copyEditorToNewWindow", "workbench.action.restoreEditorsToMainWindow",
    "workbench.action.toggleFullScreen", "workbench.action.enableCompactAuxiliaryWindow", "workbench.action.toggleCompactAuxiliaryWindow",
    "workbench.action.newEmptyEditorWindow", "workbench.action.toggleWindowAlwaysOnTop", "workbench.action.openAgentsWindow"].map((c) => [c, cmds.includes(c)]) });

  const panel = vscode.window.createWebviewPanel("spike.hmi", "Spike HMI", vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
  let waiters = [];
  const waitMessage = (type, timeoutMs = 15000) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    waiters.push({ type, resolve: (m) => { clearTimeout(timer); resolve(m); } });
  });
  panel.webview.onDidReceiveMessage((m) => {
    log("webview:" + m.type, m);
    const hit = waiters.filter((w) => w.type === m.type);
    waiters = waiters.filter((w) => w.type !== m.type);
    for (const w of hit) w.resolve(m);
  });
  panel.onDidChangeViewState((e) => log("viewState", { viewColumn: e.webviewPanel.viewColumn, active: e.webviewPanel.active, visible: e.webviewPanel.visible }));
  panel.onDidDispose(() => log("panelDisposed"));
  vscode.window.onDidChangeWindowState((s) => log("windowState", { focused: s.focused, active: s.active }));
  vscode.window.tabGroups.onDidChangeTabGroups((e) => log("tabGroupsChanged", { opened: e.opened.length, closed: e.closed.length, changed: e.changed.length, all: tabSnapshot() }));
  const measure = async (tag) => { void panel.webview.postMessage({ type: "measure", tag }); return waitMessage("measure", 5000); };

  panel.webview.html = html();
  await waitMessage("ready");
  log("docked", { viewColumn: panel.viewColumn, active: panel.active, tabs: tabSnapshot() });

  // Undock
  panel.reveal(vscode.ViewColumn.One, false);
  await sleep(400);
  const readyAfterMove = waitMessage("ready", 15000);
  await vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow");
  const r2 = await readyAfterMove;
  log("undocked", { reloaded: Boolean(r2), viewColumn: panel.viewColumn, active: panel.active, tabs: tabSnapshot() });
  await sleep(800);
  await measure("undocked-normal");
  log("phase", { name: "undocked" });
  await waitFile("ack-undocked");

  // Fullscreen on the aux window (it is the focused window right after the move)
  await vscode.commands.executeCommand("workbench.action.toggleFullScreen");
  await sleep(2500);
  await measure("fullscreen-on");
  log("phase", { name: "fullscreen-on" });
  await waitFile("ack-fullscreen-on");
  await vscode.commands.executeCommand("workbench.action.toggleFullScreen");
  await sleep(2500);
  await measure("fullscreen-off");

  // HTML Fullscreen API inside the webview (driver clicks the button = trusted user gesture)
  log("phase", { name: "click-requestFullscreen" });
  const fsResult = await waitMessage("fsResult", 30000);
  log("requestFullscreenResult", { result: fsResult });
  await sleep(500);

  // Compact mode
  await vscode.commands.executeCommand("workbench.action.enableCompactAuxiliaryWindow");
  await sleep(1200);
  await measure("compact");
  log("phase", { name: "compact" });
  await waitFile("ack-compact");
  await vscode.commands.executeCommand("workbench.action.toggleFullScreen");
  await sleep(2500);
  await measure("compact-fullscreen");
  log("phase", { name: "compact-fullscreen" });
  await waitFile("ack-compact-fullscreen");
  await vscode.commands.executeCommand("workbench.action.toggleFullScreen");
  await sleep(2500);
  await measure("compact-fullscreen-off");

  // Maximize (driver, via CDP) then fullscreen then exit: back to maximized?
  log("phase", { name: "maximize" });
  await waitFile("ack-maximize");
  await sleep(1200);
  await measure("maximized");
  panel.reveal(undefined, false);
  await sleep(400);
  await vscode.commands.executeCommand("workbench.action.toggleFullScreen");
  await sleep(2500);
  await measure("maximized-fullscreen");
  await vscode.commands.executeCommand("workbench.action.toggleFullScreen");
  await sleep(2500);
  await measure("maximized-fullscreen-off");
  log("phase", { name: "maximized-fullscreen-off" });
  await waitFile("ack-maximized-fullscreen-off");

  // Messages while the main window is minimized
  log("phase", { name: "minimize-main" });
  await waitFile("ack-minimize-main");
  await sleep(800);
  for (let i = 0; i < 50; i++) { void panel.webview.postMessage({ type: "tick" }); await sleep(20); }
  void panel.webview.postMessage({ type: "ticks?" });
  await waitMessage("ticks", 5000);
  log("phase", { name: "restore-main" });
  await waitFile("ack-restore-main");

  // Dock via public API: reveal into column One
  const readyAfterDock = waitMessage("ready", 15000);
  panel.reveal(vscode.ViewColumn.One, false);
  const r3 = await readyAfterDock;
  await sleep(1500);
  log("dockedByReveal", { reloaded: Boolean(r3), viewColumn: panel.viewColumn, active: panel.active, tabs: tabSnapshot() });
  log("phase", { name: "docked-by-reveal" });
  await waitFile("ack-docked-by-reveal");

  // Undock again, then dock via restoreEditorsToMainWindow
  panel.reveal(vscode.ViewColumn.One, false);
  await sleep(400);
  const ready4 = waitMessage("ready", 15000);
  await vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow");
  await ready4;
  await sleep(1000);
  const ready5 = waitMessage("ready", 15000);
  await vscode.commands.executeCommand("workbench.action.restoreEditorsToMainWindow");
  const r5 = await ready5;
  await sleep(1500);
  log("dockedByRestore", { reloaded: Boolean(r5), viewColumn: panel.viewColumn, tabs: tabSnapshot() });
  log("phase", { name: "docked-by-restore" });
  await waitFile("ack-docked-by-restore");

  // Second panel opened directly while an aux window is active (ViewColumn.Active)
  panel.reveal(vscode.ViewColumn.One, false);
  await sleep(300);
  const ready6 = waitMessage("ready", 15000);
  await vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow");
  await ready6;
  await sleep(800);
  const second = vscode.window.createWebviewPanel("spike.hmi2", "Spike HMI 2", vscode.ViewColumn.Active, { enableScripts: true });
  second.webview.html = "<!doctype html><body>second</body>";
  await sleep(1500);
  log("secondPanelActiveColumn", { firstViewColumn: panel.viewColumn, secondViewColumn: second.viewColumn, tabs: tabSnapshot() });
  log("phase", { name: "second-panel" });
  await waitFile("ack-second-panel");

  // Close the panel: does the aux window close?
  second.dispose();
  panel.dispose();
  await sleep(1500);
  log("phase", { name: "disposed" });
  await waitFile("ack-disposed");
  log("done");
}

// Multi-monitor scenario: the driver moves the auxiliary window with SetWindowPos (Win32), the extension
// toggles full screen and measures which monitor the webview ends up covering.
async function runMonitor() {
  log("start", { vscodeVersion: vscode.version, scenario: "monitor" });
  const panel = vscode.window.createWebviewPanel("spike.hmi", "Spike HMI", vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
  let waiters = [];
  const waitMessage = (type, timeoutMs = 15000) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    waiters.push({ type, resolve: (m) => { clearTimeout(timer); resolve(m); } });
  });
  panel.webview.onDidReceiveMessage((m) => {
    log("webview:" + m.type, m);
    const hit = waiters.filter((w) => w.type === m.type);
    waiters = waiters.filter((w) => w.type !== m.type);
    for (const w of hit) w.resolve(m);
  });
  const measure = async (tag) => { void panel.webview.postMessage({ type: "measure", tag }); return waitMessage("measure", 5000); };
  const phase = async (name) => { log("phase", { name }); await waitFile("ack-" + name); await sleep(1200); };
  const fullscreen = async () => { panel.reveal(undefined, false); await sleep(400); await vscode.commands.executeCommand("workbench.action.toggleFullScreen"); await sleep(2500); };
  const undock = async () => {
    panel.reveal(vscode.ViewColumn.One, false);
    await sleep(400);
    const ready = waitMessage("ready", 15000);
    await vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow");
    await ready;
    await sleep(800);
    await vscode.commands.executeCommand("workbench.action.enableCompactAuxiliaryWindow");
    await sleep(800);
  };

  panel.webview.html = html();
  await waitMessage("ready");
  await undock();
  await measure("undocked-default-position");
  await phase("list-undocked");

  // 1) window entirely on the secondary monitor
  await phase("move-left");
  await measure("on-left");
  await fullscreen();
  await measure("left-fullscreen");
  await phase("list-left-fullscreen");
  await fullscreen();
  await measure("left-fullscreen-off");
  await phase("list-left-fullscreen-off");

  // 2) maximized on the secondary monitor -> full screen -> back
  await phase("maximize-left");
  await measure("left-maximized");
  await fullscreen();
  await measure("left-max-fullscreen");
  await fullscreen();
  await measure("left-max-fullscreen-off");
  await phase("list-left-max-off");
  await phase("restore-left");

  // 3) window straddling both monitors (most of it on the left one)
  await phase("straddle");
  await measure("straddle");
  await fullscreen();
  await measure("straddle-fullscreen");
  await phase("list-straddle-fullscreen");
  await fullscreen();
  await measure("straddle-fullscreen-off");

  // 4) dock and undock again: where does the new auxiliary window appear?
  const readyDock = waitMessage("ready", 15000);
  panel.reveal(vscode.ViewColumn.One, false);
  await readyDock;
  await sleep(1000);
  await measure("docked");
  await undock();
  await measure("reundocked");
  await phase("list-reundocked");

  panel.dispose();
  await sleep(1000);
  log("done");
}

exports.activate = () => {
  if (!dir) return;
  const scenario = process.env.SPIKE_SCENARIO === "monitor" ? runMonitor : run;
  scenario().catch((err) => log("error", { message: String(err && err.stack || err) }));
};
exports.deactivate = () => undefined;
