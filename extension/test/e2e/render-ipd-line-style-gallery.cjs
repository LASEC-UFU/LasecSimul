const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const {
  IPD_LINE_CLASSES,
  IPD_LINE_GLYPHS,
  ipdGlyphStations,
  ipdLineClassLabel,
  ipdLineStroke,
} = require("../../out-test/src/ui/webview/ipdLineStyle.js");

const output = path.join(__dirname, "artifacts", "ipd-line-style-gallery.png");
fs.mkdirSync(path.dirname(output), { recursive: true });

function glyphMarkup(lineClass, points) {
  const spec = IPD_LINE_GLYPHS[lineClass];
  if (!spec) return "";
  return ipdGlyphStations(points, spec.spacing).map((station) => {
    const transform = `translate(${station.x} ${station.y}) rotate(${station.angle})`;
    return spec.glyph.kind === "path"
      ? `<path d="${spec.glyph.d}" transform="${transform}" class="glyph-path"/>`
      : `<circle r="${spec.glyph.radius}" transform="${transform}" class="glyph-circle"/>`;
  }).join("");
}

function sample(lineClass, index) {
  const column = index % 2;
  const row = Math.floor(index / 2);
  const x = 28 + column * 470;
  const y = 92 + row * 84;
  const points = [{ x: x + 14, y: y + 26 }, { x: x + 246, y: y + 26 }, { x: x + 246, y: y + 50 }, { x: x + 420, y: y + 50 }];
  const pointsText = points.map((point) => `${point.x},${point.y}`).join(" ");
  const stroke = ipdLineStroke(lineClass);
  const dash = stroke.dasharray ? ` stroke-dasharray="${stroke.dasharray}"` : "";
  const outline = stroke.double
    ? `<polyline points="${pointsText}" fill="none" stroke="#27364a" stroke-width="${stroke.width + 3}" stroke-linecap="round" stroke-linejoin="round"/>`
    : "";
  const ink = stroke.double ? "#f8fafc" : "#27364a";
  return `<g>
    <text x="${x + 14}" y="${y}" class="label">${ipdLineClassLabel(lineClass, "pt-BR")}</text>
    <text x="${x + 420}" y="${y}" class="code" text-anchor="end">${lineClass}</text>
    ${outline}
    <polyline points="${pointsText}" fill="none" stroke="${ink}" stroke-width="${stroke.width}"${dash} stroke-linecap="round" stroke-linejoin="round"/>
    ${glyphMarkup(lineClass, points)}
  </g>`;
}

(async () => {
  const installedBrowser = [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  ].find((candidate) => fs.existsSync(candidate));
  const browser = await chromium.launch({ headless: true, ...(installedBrowser ? { executablePath: installedBrowser } : {}) });
  const page = await browser.newPage({ viewport: { width: 970, height: 790 }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html><head><style>
    html,body{margin:0;background:#dfe7f0;font-family:Segoe UI,Arial,sans-serif;color:#172235}
    svg{display:block;width:970px;height:790px;background:#f8fafc}
    .title{font-size:24px;font-weight:700}.subtitle{font-size:13px;fill:#59697c}
    .label{font-size:14px;font-weight:650}.code{font:11px Consolas,monospace;fill:#617188}
    .glyph-path{fill:none;stroke:#27364a;stroke-width:1.25}.glyph-circle{fill:#f8fafc;stroke:#27364a;stroke-width:1.25}
  </style></head><body><svg viewBox="0 0 970 790">
    <text x="28" y="36" class="title">Classes de linha ISA/IPD no LasecSimul</text>
    <text x="28" y="59" class="subtitle">16 classes • rotas ortogonais • glifos afastados de extremidades e cotovelos • jaqueta em dois traços</text>
    ${IPD_LINE_CLASSES.map(sample).join("")}
  </svg></body></html>`);
  await page.screenshot({ path: output, animations: "disabled" });
  await browser.close();
  process.stdout.write(`${output}\n`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
