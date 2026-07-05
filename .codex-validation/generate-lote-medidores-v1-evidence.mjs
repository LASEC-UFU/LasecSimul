import fs from "node:fs";
import {
  componentBox,
  hasRealPinPosition,
  packageSymbolSvg,
  pinLocalPosition,
  registerPackage,
} from "../extension/out-webview/componentSymbols.js";

const catalog = JSON.parse(fs.readFileSync("project/schema/component-catalog.json", "utf8"));

const meterIds = [
  "meters.probe",
  "instruments.voltmeter",
  "meters.ampmeter",
  "meters.freqmeter",
  "meters.oscope",
  "meters.logic_analyzer",
];

const propsById = {
  "meters.probe": { __readout: 0, threshold: 2.5, negativeThreshold: -2.5 },
  "instruments.voltmeter": { __readout: -2.499 },
  "meters.ampmeter": { __readout: 0.0012 },
  "meters.freqmeter": { __readout: 2500 },
  "meters.oscope": { __readout: [0, 0, 0, 0], __history: [[0, 0], [0, 0], [0, 0], [0, 0]] },
  "meters.logic_analyzer": { __readout: 0, __history: [0, 0] },
};

const items = meterIds.map((typeId) => {
  const item = catalog.items.find((entry) => entry.typeId === typeId);
  if (!item?.package) throw new Error(`package nao localizado para ${typeId}`);
  registerPackage(typeId, item.package);
  return item;
});

function pinsFor(item, props) {
  const count = item.pinCount ?? item.package?.pins?.length ?? 0;
  return Array.from({ length: count }, (_, index) => {
    const id = item.pinIds?.[index] ?? item.package?.pins?.[index]?.id ?? `pin-${index + 1}`;
    return {
      id,
      aliases: item.package?.pins?.find((pin) => pin.id === id)?.aliases ?? [],
      position: pinLocalPosition(id, index, count, item.typeId, props),
      real: hasRealPinPosition(item.typeId, id, props),
    };
  });
}

const evidence = {
  generatedAt: new Date().toISOString(),
  scope: "Medidores v1: Probe, Voltimeter, Ampmeter, FreqMeter, Oscope, Logic Analyzer",
  rootCause:
    "Os instrumentos divergiam porque parte ainda vinha de fallbacks por typeId: Probe era SVG manual, medidores digitais tinham LCD manual, e Oscope/Logic Analyzer eram painéis reinterpretados. Agora Probe/digitais usam package.simulidePaint/package.pins e PlotBase usa package.qtWidget, todos no mesmo fluxo de renderer/offset/scale/pinos.",
  rendererChanges: [
    "SimulidePaintPrimitive text agora aceita stateText para Meter::updateStep e FreqMeter::updateStep.",
    "PackageShape text renderiza multiplas linhas com tspan, preservando QGraphicsSimpleTextItem.",
    "PackagePin aceita leadColor para cores declaradas de Pin::setColor, sem desenho hardcoded.",
    "stateFill agora aceita regras numericas com valueProp para thresholds configuraveis do Probe.",
    "PackageDescriptor agora aceita qtWidget.kind=plotBase para traduzir DataWidget/DataLaWidget/PlotDisplay do SimulIDE.",
  ],
  simulideSources: [
    ".codex-simulide-src/src/components/meters/probe.cpp",
    ".codex-simulide-src/src/components/meters/meter.cpp",
    ".codex-simulide-src/src/components/meters/voltmeter.cpp",
    ".codex-simulide-src/src/components/meters/ampmeter.cpp",
    ".codex-simulide-src/src/components/meters/freqmeter.cpp",
    ".codex-simulide-src/src/components/meters/oscope.cpp",
    ".codex-simulide-src/src/components/meters/logicanalizer.cpp",
    ".codex-simulide-src/src/gui/dataplotwidget/datawidget.ui",
    ".codex-simulide-src/src/gui/dataplotwidget/datalawidget.ui",
    ".codex-simulide-src/src/gui/dataplotwidget/plotdisplay.cpp",
    ".codex-simulide-src/src/utils.h",
  ],
  items: items.map((item) => {
    const props = propsById[item.typeId] ?? {};
    const box = componentBox(item.typeId, props);
    const svg = packageSymbolSvg(item.typeId, props, `lote-medidores-v1-${item.typeId}`.replace(/[^A-Za-z0-9_-]/g, "_")) ?? "";
    return {
      typeId: item.typeId,
      label: item.label,
      props,
      status: item.package?.simulidePaint ? "simulidePaint" : item.package?.qtWidget ? "qtWidget" : "nao-localizado",
      source: item.package?.simulidePaint?.source ?? item.package?.qtWidget?.source ?? null,
      box,
      pins: pinsFor(item, props),
      checks: {
        usesPackageRenderer: Boolean(svg),
        hasSimulidePaint: Boolean(item.package?.simulidePaint),
        hasQtWidget: Boolean(item.package?.qtWidget),
        hasMultilineText: svg.includes("<tspan"),
        hasAllRealPinPositions: pinsFor(item, props).every((pin) => pin.real),
        hasBlackBodyOrPlot: svg.includes('fill="#000000"'),
        hasUbuntuMono: svg.includes('font-family="Ubuntu Mono"'),
        hasPlotBaseButton: svg.includes("Expande"),
      },
      svg,
    };
  }),
};

fs.writeFileSync(".codex-validation/lote-medidores-v1-evidence.json", `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

const cards = evidence.items.map((item, index) => {
  const x = 28 + (index % 3) * 250;
  const y = 64 + Math.floor(index / 3) * 190;
  const scale = Math.min(170 / item.box.width, 110 / item.box.height);
  const svgX = 20 + (170 - item.box.width * scale) / 2;
  const svgY = 42 + (110 - item.box.height * scale) / 2;
  const pins = item.pins.map((pin) => `${pin.id}@${pin.position.x},${pin.position.y}`).join(" | ");
  return `
  <g transform="translate(${x},${y})">
    <rect width="220" height="172" fill="#fff" stroke="#b8b8a8"/>
    <text x="10" y="18" font-family="Segoe UI,Arial" font-size="10" fill="#111">${item.typeId}</text>
    <text x="10" y="34" font-family="Consolas,monospace" font-size="9" fill="#555">box=${item.box.width}x${item.box.height}</text>
    <g transform="translate(${svgX},${svgY}) scale(${scale})">
      <svg viewBox="0 0 ${item.box.width} ${item.box.height}" width="${item.box.width}" height="${item.box.height}" overflow="visible">${item.svg}</svg>
    </g>
    <text x="10" y="154" font-family="Consolas,monospace" font-size="8" fill="#126b2f">${pins}</text>
  </g>`;
}).join("\n");

const contactSheet = `<svg xmlns="http://www.w3.org/2000/svg" width="820" height="470" viewBox="0 0 820 470">
<rect width="100%" height="100%" fill="#f8f8e8"/>
<defs>
  <pattern id="grid" width="8" height="8" patternUnits="userSpaceOnUse">
    <path d="M 8 0 L 0 0 0 8" fill="none" stroke="#d7d7c7" stroke-width="1"/>
  </pattern>
</defs>
<rect x="0" y="0" width="820" height="470" fill="url(#grid)" opacity="0.85"/>
<text x="28" y="32" font-family="Segoe UI,Arial" font-size="18" font-weight="700">Lote Medidores v1 - package renderer + qtWidget plotBase</text>
<text x="28" y="50" font-family="Consolas,monospace" font-size="10" fill="#555">fontes: probe.cpp, meter.cpp, freqmeter.cpp, oscope.cpp, logicanalizer.cpp, datawidget.ui, datalawidget.ui, plotdisplay.cpp</text>
${cards}
</svg>`;
fs.writeFileSync(".codex-validation/lote-medidores-v1-contact-sheet.svg", contactSheet, "utf8");

const rows = evidence.items.map((item) => `<tr>
  <td><code>${item.typeId}</code></td>
  <td>${item.status}</td>
  <td><code>${item.source?.file ?? "nao localizado"}</code></td>
  <td><code>${JSON.stringify(item.box)}</code></td>
  <td><code>${JSON.stringify(item.pins)}</code></td>
  <td><code>${JSON.stringify(item.checks)}</code></td>
</tr>`).join("\n");

const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Lote Medidores v1</title>
<style>
body{font-family:Segoe UI,Arial,sans-serif;background:#f8f8e8;color:#111;margin:24px}
table{border-collapse:collapse;width:100%;background:white}td,th{border:1px solid #ccc;padding:8px;vertical-align:top}code{font-family:Consolas,monospace;font-size:12px}.ok{color:#126b2f;font-weight:700}
img{max-width:100%;border:1px solid #bbb;background:#f8f8e8}
</style></head><body>
<h1>Lote Medidores v1</h1>
<p class="ok">Gerado a partir do renderer compilado da extensao. Teste executado: <code>npm --prefix extension test</code>.</p>
<p><img src="lote-medidores-v1-contact-sheet.svg" alt="Contato visual do lote Medidores v1"></p>
<table><thead><tr><th>Componente</th><th>Status</th><th>Fonte SimulIDE</th><th>Box</th><th>Pinos</th><th>Checks</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`;
fs.writeFileSync(".codex-validation/lote-medidores-v1-evidence.html", html, "utf8");

console.log(".codex-validation/lote-medidores-v1-evidence.html");
console.log(".codex-validation/lote-medidores-v1-contact-sheet.svg");
console.log(".codex-validation/lote-medidores-v1-evidence.json");
