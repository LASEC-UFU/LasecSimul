const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { loadUnifiedCatalog } = require("../../out-test/src/catalog/UnifiedCatalog.js");
const { componentBox, packageSymbolSvg, registerPackage } = require("../../out-test/src/ui/webview/componentSymbols.js");
const { graphicalRuntimeProperties } = require("../../out-test/src/ui/webview/graphicsBinding.js");

const extensionRoot = path.resolve(__dirname, "../..");
const output = path.join(__dirname, "artifacts", "graphics-library-gallery.png");
const catalog = loadUnifiedCatalog(extensionRoot, "pt-BR").catalog;
for (const entry of catalog) registerPackage(entry.typeId, entry.package, entry.logicSymbolPackage, entry.boardPackage);

const escapeHtml = (value) => String(value)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

const cards = catalog
  .filter((entry) => entry.typeId.startsWith("graphics.") && entry.package)
  .map((entry) => {
    const properties = { ...entry.defaultProperties, ...graphicalRuntimeProperties(entry.defaultProperties ?? {}, () => undefined) };
    const box = componentBox(entry.typeId, properties);
    const markup = packageSymbolSvg(entry.typeId, properties, `gallery-${entry.typeId.replace(/\W/g, "-")}`) ?? "";
    const aspect = entry.package.simulidePaint?.aspect ?? "legacy";
    return `<article>
      <header>${escapeHtml(entry.label)}<small>${escapeHtml(entry.typeId)} · ${aspect}</small></header>
      <div class="symbol"><svg viewBox="0 0 ${box.width} ${box.height}" preserveAspectRatio="xMidYMid meet">${markup}</svg></div>
    </article>`;
  })
  .join("");

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box} body{margin:0;padding:20px;background:#e8eef5;color:#0f172a;font:13px Segoe UI,Arial,sans-serif}
  h1{margin:0 0 16px;font-size:24px} main{display:grid;grid-template-columns:repeat(7,1fr);gap:12px}
  article{height:156px;border:1px solid #94a3b8;border-radius:7px;background:#f8fafc;box-shadow:0 1px 3px #0002;overflow:hidden}
  header{height:42px;padding:6px 9px;background:#dbe7f1;font-weight:650;line-height:15px}
  small{display:block;color:#475569;font-size:10px;font-weight:400}
  .symbol{height:112px;padding:8px;color:#263238}.symbol svg{display:block;width:100%;height:100%;overflow:visible}
</style></head><body><h1>Biblioteca gráfica HMI — auditoria vetorial</h1><main>${cards}</main></body></html>`;

(async () => {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const installedBrowser = [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  ].find((candidate) => fs.existsSync(candidate));
  const browser = await chromium.launch({ headless: true, ...(installedBrowser ? { executablePath: installedBrowser } : {}) });
  const page = await browser.newPage({ viewport: { width: 2100, height: 720 }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "load" });
  await page.screenshot({ path: output, fullPage: true, animations: "disabled" });
  await browser.close();
  console.log(output);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
