// Folha de símbolos da biblioteca de blocos equivalente ao Simulink (docs/66), lado a lado com o
// ícone de referência quando ele existir localmente (external-research/simulink-inventory/icons,
// fora do git: material de consulta, nunca incorporado). Uso:
//   npx tsc -p ./tsconfig.test.json && node test/e2e/render-block-library.cjs <saida.png> [blocos...]
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const extensionRoot = path.resolve(__dirname, "..", "..");
const repoRoot = path.resolve(extensionRoot, "..");
const { loadBlockLibrary } = require(path.join(extensionRoot, "out-test", "src", "catalog", "blockLibraryLoader.js"));
const { blockPackage } = require(path.join(extensionRoot, "out-test", "src", "ui", "webview", "blockLibrary", "blockSymbol.js"));

const [output = path.join(extensionRoot, "out-test", "block-library.png"), ...only] = process.argv.slice(2);
const iconsDir = path.join(repoRoot, "external-research", "simulink-inventory", "icons");
const referenceFor = (spec) => {
  const slug = (spec.doc ?? "").split("/").pop()?.replace(/\.html$/, "");
  const file = slug ? path.join(iconsDir, `${slug}.png`) : undefined;
  return file && fs.existsSync(file) ? `data:image/png;base64,${fs.readFileSync(file).toString("base64")}` : undefined;
};

const cells = [];
for (const library of loadBlockLibrary(extensionRoot)) {
  for (const spec of library.blocks) {
    if (only.length > 0 && !only.includes(spec.id)) continue;
    const variants = [{ name: spec.name, props: {} }, ...(spec.presets ?? []).map((preset) => ({ name: preset.name, props: preset.defaults, size: preset.size }))];
    for (const variant of variants) {
      const pkg = blockPackage(spec, variant.props, variant.size);
      const margin = 10;
      const svg = `<svg width="${pkg.width + 2 * margin}" height="${pkg.height + 2 * margin}" viewBox="${-margin} ${-margin} ${pkg.width + 2 * margin} ${pkg.height + 2 * margin}">${pkg.shapes.map((shape) => shape.value).join("")}${pkg.pins.map((pin) => `<circle cx="${pin.x}" cy="${pin.y}" r="1.6" fill="#d33"/>`).join("")}</svg>`;
      const reference = variant.props && Object.keys(variant.props).length === 0 ? referenceFor(spec) : undefined;
      cells.push(`<div class="cell"><div class="row">${svg}${reference ? `<img src="${reference}"/>` : ""}</div><div class="name">${variant.name}</div></div>`);
    }
  }
}

(async () => {
  const installedBrowser = [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  ].find((candidate) => fs.existsSync(candidate));
  const browser = await chromium.launch({ headless: true, ...(installedBrowser ? { executablePath: installedBrowser } : {}) });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 2 });
  await page.setContent(`<!doctype html><html><head><style>
    body{margin:0;padding:12px;background:#fff;font-family:Segoe UI,Arial,sans-serif}
    .grid{display:flex;flex-wrap:wrap;gap:10px}.cell{border:1px solid #ddd;padding:6px;min-width:150px}
    .row{display:flex;align-items:center;gap:14px}.row img{image-rendering:pixelated;width:auto;height:48px}
    .name{font-size:11px;color:#444;margin-top:4px;text-align:center}
  </style></head><body><div class="grid">${cells.join("")}</div></body></html>`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await page.screenshot({ path: output, fullPage: true });
  await browser.close();
  console.log(`${cells.length} simbolos -> ${output}`);
})().catch((error) => { console.error(error); process.exit(1); });
