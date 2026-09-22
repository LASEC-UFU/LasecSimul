const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { loadUnifiedCatalog } = require("../../out-test/src/catalog/UnifiedCatalog.js");
const { componentBox, packageSymbolSvg, registerPackage } = require("../../out-test/src/ui/webview/componentSymbols.js");
const { graphicalRuntimeProperties } = require("../../out-test/src/ui/webview/graphicsBinding.js");

const extensionRoot = path.resolve(__dirname, "../..");
const repositoryRoot = path.resolve(extensionRoot, "..");
const onlyTypeId = process.env.TDPS_GALLERY_ONLY;
const output = path.join(__dirname, "artifacts", onlyTypeId ? "tdps-basic-flow-screen.png" : "tdps-process-gallery.png");
const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, ".spec", "fixtures", "tdps-v771-library.json"), "utf8"));
const catalog = loadUnifiedCatalog(extensionRoot, "pt-BR").catalog;
for (const entry of catalog) registerPackage(entry.typeId, entry.package, entry.logicSymbolPackage, entry.boardPackage);

const escapeHtml = (value) => String(value)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

const selectedEntries = onlyTypeId ? manifest.entries.filter((entry) => entry.typeId === onlyTypeId) : manifest.entries;
const cards = selectedEntries.map((entry) => {
  const document = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "subcircuits", entry.file), "utf8"));
  const byId = new Map(document.components.map((component) => [component.id, component]));
  const markup = document.exposedComponents.map((exposed) => {
    const component = byId.get(exposed.componentId);
    if (!component || !component.typeId.startsWith("graphics.")) return "";
    const base = component.properties ?? {};
    const properties = { ...base, ...graphicalRuntimeProperties(base, () => undefined) };
    const box = componentBox(component.typeId, properties, "board");
    const body = packageSymbolSvg(component.typeId, properties, component.id, "board") ?? "";
    const rotation = Number(exposed.rotation ?? 0);
    const localRotation = rotation === 0 ? "" : ` transform="rotate(${rotation} ${box.width / 2} ${box.height / 2})"`;
    return `<g transform="translate(${exposed.x} ${exposed.y})"><g${localRotation}>${body}</g></g>`;
  }).join("");
  return `<article><header>${escapeHtml(entry.label)}<small>${escapeHtml(entry.file)}</small></header>
    <div class="screen"><svg viewBox="0 0 ${document.symbol.width} ${document.symbol.height}" preserveAspectRatio="xMidYMid meet">${markup}</svg></div></article>`;
}).join("");

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}body{margin:0;padding:18px;background:#dfe7ef;color:#0f172a;font:12px Segoe UI,Arial,sans-serif}
  h1{margin:0 0 14px;font-size:23px}main{display:grid;grid-template-columns:repeat(${onlyTypeId ? 1 : 4},1fr);gap:12px}
  article{height:${onlyTypeId ? 720 : 292}px;border:1px solid #94a3b8;border-radius:7px;background:#f8fafc;box-shadow:0 1px 3px #0002;overflow:hidden}
  header{height:42px;padding:6px 9px;background:#cdddeb;font-weight:650;line-height:15px}small{display:block;color:#475569;font-size:9px;font-weight:400}
  .screen{height:${onlyTypeId ? 676 : 248}px;padding:5px;color:#263238}.screen svg{display:block;width:100%;height:100%;background:#fff;border:1px solid #cbd5e1}
</style></head><body><h1>24 telas TDPS — auditoria visual vetorial</h1><main>${cards}</main></body></html>`;

(async () => {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const installedBrowser = [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  ].find((candidate) => fs.existsSync(candidate));
  const browser = await chromium.launch({ headless: true, ...(installedBrowser ? { executablePath: installedBrowser } : {}) });
  const page = await browser.newPage({ viewport: { width: onlyTypeId ? 1100 : 1960, height: 900 }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "load" });
  await page.screenshot({ path: output, fullPage: true, animations: "disabled" });
  await browser.close();
  console.log(output);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
