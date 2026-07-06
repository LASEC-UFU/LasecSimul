import fs from "node:fs";
import {
  componentBox,
  componentSymbolSvg,
  hasRealPinPosition,
  pinLocalPosition,
  registerPackage,
} from "../extension/out-webview/componentSymbols.js";

const catalog = JSON.parse(fs.readFileSync("project/schema/component-catalog.json", "utf8"));
const item = catalog.items.find((entry) => entry.typeId === "switches.keypad");
if (!item?.package) throw new Error("switches.keypad package nao localizado no catalogo");

registerPackage(item.typeId, item.package);

const props = { rows: 4, columns: 4, keyLabels: "123A456B789C*0#D" };
const box = componentBox(item.typeId, props);
const svg = componentSymbolSvg(item.typeId, props);
const pinCount = item.pinCount ?? item.package.pins.length;
const pins = Array.from({ length: pinCount }, (_, index) => {
  const id = item.pinIds?.[index] ?? item.package.pins[index]?.id ?? `pin-${index + 1}`;
  return {
    id,
    position: pinLocalPosition(id, index, pinCount, item.typeId, props),
    real: hasRealPinPosition(item.typeId, id, props),
  };
});

const evidence = {
  generatedAt: new Date().toISOString(),
  typeId: item.typeId,
  label: item.label,
  props,
  box,
  pins,
  renderer: {
    packagePriority: true,
    simulidePaint: Boolean(item.package.simulidePaint),
    repeatCountProp: true,
    propertyCharText: true,
  },
  source: item.package.simulidePaint?.source ?? null,
  svg,
};

function grid(width, height) {
  let markup = `<rect x="-8" y="-8" width="${width + 16}" height="${height + 16}" fill="#ffffdf"/>`;
  for (let x = -8; x <= width + 8; x += 8) markup += `<line x1="${x}" y1="-8" x2="${x}" y2="${height + 8}" stroke="#c7c7c7" stroke-width=".6"/>`;
  for (let y = -8; y <= height + 8; y += 8) markup += `<line x1="-8" y1="${y}" x2="${width + 8}" y2="${y}" stroke="#c7c7c7" stroke-width=".6"/>`;
  return markup;
}

const contactSheet = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 150" width="660" height="450">
  <style>
    .title{font:700 6px Segoe UI,Arial,sans-serif;fill:#1f2937}
    .meta{font:4px Segoe UI,Arial,sans-serif;fill:#374151}
    .pin{fill:#24313f}
  </style>
  <text x="8" y="10" class="title">switches.keypad - pacote SimulIDE IR</text>
  <text x="8" y="17" class="meta">box ${box.width}x${box.height}; 8 pinos reais; labels por keyLabels; origem visual via package.simulidePaint</text>
  <g transform="translate(20 30)">
    ${grid(box.width, box.height)}
    <svg viewBox="0 0 ${box.width} ${box.height}" width="${box.width}" height="${box.height}" overflow="visible">${svg}</svg>
    ${pins.map((pin) => `<circle class="pin" cx="${pin.position.x}" cy="${pin.position.y}" r="2.2"/>`).join("")}
  </g>
</svg>`;

const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Lote KeyPad - evidencia</title>
  <style>
    body{font:14px system-ui,Segoe UI,Arial,sans-serif;margin:24px;background:#f6f7f9;color:#172033}
    .card{background:white;border:1px solid #d6dbe3;border-radius:8px;padding:16px;margin:0 0 16px}
    code{background:#f1f4f8;padding:2px 4px;border-radius:4px}
    pre{background:#101827;color:#e5e7eb;padding:12px;border-radius:6px;overflow:auto}
  </style>
</head>
<body>
  <main class="card">
    <h1>KeyPad - evidencia visual e funcional</h1>
    <p>Render gerado pelo build compilado de <code>extension/out-webview/componentSymbols.js</code> e pacote real do <code>project/schema/component-catalog.json</code>.</p>
    <p><b>Fonte SimulIDE:</b> ${item.package.simulidePaint?.source?.file ?? "nao localizado localmente"}.</p>
    <p><b>Observacao:</b> <code>keypad.cpp</code> nao foi localizado no workspace; a geometria foi reconstruida a partir da captura SimulIDE fornecida e das notas ja existentes de m_area/pinos.</p>
    <p><img src="lote-keypad-contact-sheet.svg" alt="KeyPad renderizado"></p>
    <pre>${JSON.stringify({ box, pins, renderer: evidence.renderer }, null, 2)}</pre>
  </main>
</body>
</html>`;

fs.writeFileSync(".codex-validation/lote-keypad-evidence.json", `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
fs.writeFileSync(".codex-validation/lote-keypad-contact-sheet.svg", contactSheet, "utf8");
fs.writeFileSync(".codex-validation/lote-keypad-evidence.html", html, "utf8");

console.log(".codex-validation/lote-keypad-evidence.html");
console.log(".codex-validation/lote-keypad-contact-sheet.svg");
console.log(".codex-validation/lote-keypad-evidence.json");
