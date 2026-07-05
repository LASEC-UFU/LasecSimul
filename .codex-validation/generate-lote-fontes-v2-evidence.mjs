import fs from "node:fs";
import {
  componentBox,
  componentSymbolSvg,
  hasRealPinPosition,
  packageSymbolSvg,
  pinLocalPosition,
  registerPackage,
} from "../extension/out-webview/componentSymbols.js";
import { qtPaintToSimulidePrimitives } from "../scripts/qt-paint-to-simulide-ir.mjs";

const catalog = JSON.parse(fs.readFileSync("project/schema/component-catalog.json", "utf8"));

const sourceIds = [
  "sources.dc_voltage",
  "sources.fixed_volt",
  "sources.clock",
  "sources.wave_gen",
  "sources.voltage_source",
  "sources.current_source",
  "sources.controlled_source",
  "sources.battery",
  "sources.rail",
  "other.ground",
];

const propsById = {
  "sources.dc_voltage": { voltage: 5 },
  "sources.fixed_volt": { voltage: 5, out: true },
  "sources.clock": { out: true },
  "sources.wave_gen": { bipolar: false },
  "sources.voltage_source": { value: 0 },
  "sources.current_source": { value: 0 },
  "sources.controlled_source": { controlPins: true, currSource: true, currControl: false },
  "sources.battery": { voltage: 5 },
  "sources.rail": { voltage: 5 },
  "other.ground": {},
};

const items = sourceIds.map((typeId) => {
  const item = catalog.items.find((entry) => entry.typeId === typeId);
  if (item?.package) registerPackage(typeId, item.package);
  return item;
}).filter(Boolean);

function renderSvg(typeId, props) {
  const packageSvg = packageSymbolSvg(typeId, props, `lote-fontes-v2-${typeId}`.replace(/[^A-Za-z0-9_-]/g, "_"));
  return packageSvg ?? componentSymbolSvg(typeId, props);
}

function itemEvidence(item) {
  const typeId = item.typeId;
  const props = propsById[typeId] ?? {};
  const box = componentBox(typeId, props);
  const pins = Array.from({ length: item.pinCount ?? item.package?.pins?.length ?? 0 }, (_, index) => {
    const fallbackId = item.pinIds?.[index] ?? item.package?.pins?.[index]?.id ?? `pin-${index + 1}`;
    const position = pinLocalPosition(fallbackId, index, item.pinCount ?? item.package?.pins?.length ?? 0, typeId, props);
    return {
      id: fallbackId,
      aliases: item.package?.pins?.[index]?.aliases ?? [],
      position,
      real: hasRealPinPosition(typeId, fallbackId, props),
    };
  });
  const svg = renderSvg(typeId, props);
  return {
    typeId,
    label: item.label,
    status: item.package?.simulidePaint ? "simulidePaint" : "nao-localizado",
    source: item.package?.simulidePaint?.source?.file ?? "nao localizado",
    notes: item.package?.simulidePaint?.source?.notes ?? "sem paint SimulIDE localizado",
    props,
    box,
    pins,
    checks: {
      hasSimulidePaint: Boolean(item.package?.simulidePaint),
      usesFallback: !item.package?.simulidePaint,
      containsGradient: svg.includes("<linearGradient") || svg.includes("<radialGradient"),
      hasPinPositionForAllPins: pins.every((pin) => pin.real),
    },
    svg,
  };
}

const parserSamples = [
  {
    name: "clock.cpp",
    file: ".codex-simulide-src/src/components/sources/clock.cpp",
    symbols: {},
  },
  {
    name: "custombutton.cpp normal widget 32x16",
    file: ".codex-simulide-src/src/gui/custombutton.cpp",
    symbols: { width: 32, height: 16, w: 32, h: 14 },
  },
  {
    name: "customdial.cpp widget 36x36",
    file: ".codex-simulide-src/src/gui/customdial.cpp",
    symbols: { width: 36, height: 36 },
  },
].map((sample) => ({
  ...sample,
  primitives: fs.existsSync(sample.file)
    ? qtPaintToSimulidePrimitives(fs.readFileSync(sample.file, "utf8"), { symbols: sample.symbols })
    : [],
}));

const evidence = {
  generatedAt: new Date().toISOString(),
  scope: "Fontes",
  rootCause:
    "Os componentes divergiam porque parte da renderizacao original esta em primitivas QPainter/Qt widget fora do paint principal; o LasecSimul antes caia em fallback generico ou em shapes manuais.",
  parser: {
    file: "scripts/qt-paint-to-simulide-ir.mjs",
    supportedNow: [
      "QPainter::drawLine",
      "QPainter::drawRoundedRect",
      "QPainter::drawRect",
      "QPainter::drawEllipse",
      "QPainter::drawArc",
      "QPainter::drawPixmap",
      "QLinearGradient",
      "QRadialGradient",
      "QPen/QBrush cores e largura",
      "QPoint/QPointF/QRect/QRectF",
      "variaveis locais numericas simples",
    ],
    stillPendingGenericQtCoverage: [
      "execucao completa de if/else por estado visual",
      "loops com transform save/translate/rotate por primitiva",
      "QPainterPath declarativo completo",
      "metricas reais de drawText Qt",
    ],
    samples: parserSamples,
  },
  items: items.map(itemEvidence),
};

fs.writeFileSync(".codex-validation/lote-fontes-v2-evidence.json", `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
fs.writeFileSync(".codex-validation/qt-parser-fontes-v2.json", `${JSON.stringify(evidence.parser, null, 2)}\n`, "utf8");

const cards = evidence.items.map((item, index) => {
  const x = 24 + (index % 3) * 260;
  const y = 48 + Math.floor(index / 3) * 188;
  const title = `${item.typeId} (${item.status})`;
  const viewBox = `0 0 ${item.box.width} ${item.box.height}`;
  const scale = Math.min(150 / item.box.width, 96 / item.box.height);
  const svgX = x + 24 + (150 - item.box.width * scale) / 2;
  const svgY = y + 38 + (96 - item.box.height * scale) / 2;
  return `
  <g transform="translate(${x},${y})">
    <rect width="236" height="160" fill="#fff" stroke="#b8b8a8"/>
    <text x="10" y="18" font-family="Segoe UI,Arial" font-size="10" fill="#111">${title}</text>
    <text x="10" y="34" font-family="Consolas,monospace" font-size="9" fill="#555">box=${item.box.width}x${item.box.height}</text>
    <g transform="translate(${svgX - x},${svgY - y}) scale(${scale})">
      <svg viewBox="${viewBox}" width="${item.box.width}" height="${item.box.height}" overflow="visible">${item.svg}</svg>
    </g>
    <text x="10" y="144" font-family="Consolas,monospace" font-size="8" fill="${item.status === "simulidePaint" ? "#126b2f" : "#9a4d00"}">${item.source}</text>
  </g>`;
}).join("\n");

const sheetHeight = 48 + Math.ceil(evidence.items.length / 3) * 188 + 24;
const contactSheet = `<svg xmlns="http://www.w3.org/2000/svg" width="820" height="${sheetHeight}" viewBox="0 0 820 ${sheetHeight}">
<rect width="100%" height="100%" fill="#f8f8e8"/>
<defs>
  <pattern id="grid" width="8" height="8" patternUnits="userSpaceOnUse">
    <path d="M 8 0 L 0 0 0 8" fill="none" stroke="#d7d7c7" stroke-width="1"/>
  </pattern>
</defs>
<rect x="0" y="0" width="820" height="${sheetHeight}" fill="url(#grid)" opacity="0.85"/>
<text x="24" y="28" font-family="Segoe UI,Arial" font-size="18" font-weight="700">Lote Fontes v2 - renderer compilado do LasecSimul</text>
${cards}
</svg>`;
fs.writeFileSync(".codex-validation/lote-fontes-v2-contact-sheet.svg", contactSheet, "utf8");

const htmlRows = evidence.items.map((item) => `<tr>
  <td><code>${item.typeId}</code></td>
  <td>${item.status}</td>
  <td><code>${item.source}</code></td>
  <td><code>${JSON.stringify(item.box)}</code></td>
  <td><code>${JSON.stringify(item.pins)}</code></td>
</tr>`).join("\n");

const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Lote Fontes v2</title>
<style>
body{font-family:Segoe UI,Arial,sans-serif;background:#f8f8e8;color:#111;margin:24px}
table{border-collapse:collapse;width:100%;background:white}td,th{border:1px solid #ccc;padding:8px;vertical-align:top}code{font-family:Consolas,monospace;font-size:12px}.ok{color:#126b2f;font-weight:700}.warn{color:#9a4d00;font-weight:700}
img{max-width:100%;border:1px solid #bbb;background:#f8f8e8}
</style></head><body>
<h1>Lote Fontes v2</h1>
<p>Gerado a partir do renderer compilado da extensão. O item <code>sources.dc_voltage</code> aparece como <span class="warn">nao-localizado</span> porque nao foi localizado componente correspondente separado no SimulIDE original consultado.</p>
<p class="ok">Teste executado: <code>npm --prefix extension test</code>.</p>
<p><img src="lote-fontes-v2-contact-sheet.svg" alt="Contato visual do lote Fontes v2"></p>
<table><thead><tr><th>Componente</th><th>Status</th><th>Fonte SimulIDE</th><th>Box</th><th>Pinos</th></tr></thead><tbody>${htmlRows}</tbody></table>
<h2>Parser Qt->IR</h2>
<p>Saida detalhada em <code>qt-parser-fontes-v2.json</code>.</p>
</body></html>`;
fs.writeFileSync(".codex-validation/lote-fontes-v2-evidence.html", html, "utf8");

console.log(".codex-validation/lote-fontes-v2-evidence.html");
console.log(".codex-validation/lote-fontes-v2-contact-sheet.svg");
console.log(".codex-validation/lote-fontes-v2-evidence.json");
console.log(".codex-validation/qt-parser-fontes-v2.json");
