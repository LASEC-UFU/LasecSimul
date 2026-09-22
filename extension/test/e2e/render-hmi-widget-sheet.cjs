/**
 * Prancha de contato dos widgets `graphics.hmi.*` em TAMANHO REAL (1:1, sem esticar para caber num
 * cartão). É o único jeito honesto de julgar "está distorcido": a galeria geral desenha cada
 * símbolo escalado para uma célula fixa, o que ESCONDE exatamente o defeito que se quer ver --
 * rótulo colidindo com o corpo, texto saindo da caixa, proporção errada.
 *
 * Uso: `npm --prefix extension run test:hmi:visual`
 */
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { loadUnifiedCatalog } = require("../../out-test/src/catalog/UnifiedCatalog.js");
const { componentBox, packageSymbolSvg, registerPackage } = require("../../out-test/src/ui/webview/componentSymbols.js");
const { graphicalRuntimeProperties } = require("../../out-test/src/ui/webview/graphicsBinding.js");

const extensionRoot = path.resolve(__dirname, "../..");
const output = path.join(__dirname, "artifacts", "hmi-widget-sheet.png");
const catalog = loadUnifiedCatalog(extensionRoot, "pt-BR").catalog;
for (const entry of catalog) registerPackage(entry.typeId, entry.package, entry.logicSymbolPackage, entry.boardPackage);

const escapeHtml = (value) => String(value)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Estados representativos por widget: o valor no meio da faixa, com limites declarados, é o que
 * põe TODOS os elementos na tela ao mesmo tempo (marca, ponteiro, seta de SP, texto). */
const STATES = {
  "graphics.hmi.bar": { value: 62, valueB: 75, limitLL: "10", limitL: "25", limitH: "80", limitHH: "92" },
  "graphics.hmi.gauge": { value: 62, limitL: "25", limitH: "80", limitHH: "92" },
  "graphics.hmi.display": { value: 132.4, showSp: true, valueB: 140, limitH: "150" },
  "graphics.hmi.tank": { value: 62, limitLL: "10", limitHH: "92" },
  "graphics.hmi.valve": { value: 62 },
  "graphics.hmi.pump": { value: 100 },
  "graphics.hmi.lamp": { value: 100 },
  "graphics.hmi.faceplate": { value: 62, valueB: 75, valueC: 48, limitH: "80" },
  "graphics.hmi.alarm_banner": { value: 95, limitH: "80", limitHH: "92" },
};

const cards = catalog
  .filter((entry) => entry.typeId.startsWith("graphics.hmi.") && entry.package)
  .map((entry) => {
    const properties = { ...entry.defaultProperties, ...(STATES[entry.typeId] ?? {}) };
    const runtime = { ...properties, ...graphicalRuntimeProperties(properties, () => undefined) };
    const box = componentBox(entry.typeId, runtime);
    const markup = packageSymbolSvg(entry.typeId, runtime, `sheet-${entry.typeId.replace(/\W/g, "-")}`) ?? "";
    // `overflow:visible` fica FORA de proposito: o que vazar da caixa tem que aparecer cortado,
    // senao o defeito de um rotulo desenhado fora dos limites passa despercebido aqui.
    return `<article>
      <header>${escapeHtml(entry.label)}<small>${escapeHtml(entry.typeId)} · ${box.width}\u00d7${box.height}</small></header>
      <div class="symbol" style="width:${box.width}px;height:${box.height}px">
        <svg width="${box.width}" height="${box.height}" viewBox="0 0 ${box.width} ${box.height}">${markup}</svg>
      </div>
    </article>`;
  })
  .join("");

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box} body{margin:0;padding:24px;background:#d4d4d4;color:#1a1a1a;font:12px Segoe UI,Arial,sans-serif}
  h1{margin:0 0 6px;font-size:20px} p{margin:0 0 18px;color:#454545}
  main{display:flex;flex-wrap:wrap;gap:18px;align-items:flex-start}
  article{background:#e2e2e2;border:1px solid #a8a8a8}
  header{padding:5px 8px;background:#cfcfcf;font-weight:650;line-height:14px;border-bottom:1px solid #a8a8a8}
  small{display:block;color:#6b6b6b;font-size:10px;font-weight:400}
  /* A moldura vermelha marca EXATAMENTE a caixa declarada do widget: tudo que encostar ou passar
     dela e' rotulo fora dos limites. */
  .symbol{margin:10px;outline:1px dashed #c62222;background:#d4d4d4}
</style></head><body>
<h1>Widgets HMI — tamanho real 1:1</h1>
<p>A moldura tracejada e a caixa declarada de cada widget. Texto encostando nela esta fora dos limites.</p>
<main>${cards}</main></body></html>`;

(async () => {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const installed = [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  ].find((candidate) => fs.existsSync(candidate));
  const browser = await chromium.launch(installed ? { executablePath: installed } : {});
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: "load" });
  await page.screenshot({ path: output, fullPage: true });
  await browser.close();
  console.log(`prancha: ${output}`);
})();
