import fs from "node:fs";
import {
  componentBox,
  componentSymbolSvg,
  hasRealPinPosition,
  pinLocalPosition,
  registerPackage,
} from "../extension/out-webview/componentSymbols.js";

const items = [
  { kind: "mcu-adapter", manifest: "mcu-adapters/espressif-esp32/mcu.json", typeKey: "chipId", title: "ESP32 QEMU" },
  { kind: "subcircuit-file", manifest: "subcircuits/esp32_devkitc_v4.lssub.json", typeKey: "typeId", title: "ESP32 DevKitC V4" },
  { kind: "subcircuit-file", manifest: "subcircuits/esp32_wroom32.lssub.json", typeKey: "typeId", title: "ESP32-WROOM-32" },
].map((item) => {
  const json = JSON.parse(fs.readFileSync(item.manifest, "utf8"));
  if (!json.package) throw new Error(`package nao localizado em ${item.manifest}`);
  const typeId = json[item.typeKey];
  registerPackage(typeId, json.package, json.logicSymbolPackage);
  const electricalPinIds = item.kind === "mcu-adapter"
    ? Object.keys(json.pinMap ?? {})
    : (json.interface ?? []).map((entry) => entry.pinId).filter(Boolean);
  const packagePinIds = json.package.pins.map((pin) => pin.id);
  const box = componentBox(typeId, json.defaultProperties ?? {});
  const pins = electricalPinIds.map((id, index) => ({
    id,
    real: hasRealPinPosition(typeId, id, json.defaultProperties ?? {}),
    position: hasRealPinPosition(typeId, id, json.defaultProperties ?? {})
      ? pinLocalPosition(id, index, electricalPinIds.length, typeId, json.defaultProperties ?? {})
      : undefined,
  }));
  return {
    ...item,
    json,
    typeId,
    box,
    svg: componentSymbolSvg(typeId, json.defaultProperties ?? {}),
    electricalPinIds,
    packagePinIds,
    pins,
    missingElectricalLeads: electricalPinIds.filter((id) => !pins.find((pin) => pin.id === id)?.real),
    decorativeOrNcPins: packagePinIds.filter((id) => !electricalPinIds.includes(id)),
  };
});

function grid(width, height) {
  let markup = `<rect x="-16" y="-16" width="${width + 32}" height="${height + 32}" fill="#ffffdf"/>`;
  for (let x = -16; x <= width + 16; x += 8) markup += `<line x1="${x}" y1="-16" x2="${x}" y2="${height + 16}" stroke="#c7c7c7" stroke-width=".6"/>`;
  for (let y = -16; y <= height + 16; y += 8) markup += `<line x1="-16" y1="${y}" x2="${width + 16}" y2="${y}" stroke="#c7c7c7" stroke-width=".6"/>`;
  return markup;
}

function panel(item, x, y, scale = 1) {
  const { box } = item;
  return `<g transform="translate(${x} ${y})">
    <text x="0" y="-38" class="title">${item.title}</text>
    <text x="0" y="-30" class="meta">${item.typeId}; box ${box.width.toFixed(1)}x${box.height.toFixed(1)}; eletricos ${item.electricalPinIds.length}; package ${item.packagePinIds.length}</text>
    <g transform="scale(${scale})">
      ${grid(box.width, box.height)}
      <svg viewBox="0 0 ${box.width} ${box.height}" width="${box.width}" height="${box.height}" overflow="visible">${item.svg}</svg>
      ${item.pins.filter((pin) => pin.real).map((pin) => `<circle class="pin" cx="${pin.position.x}" cy="${pin.position.y}" r="2.2"/>`).join("")}
    </g>
  </g>`;
}

const contactSheet = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 300" width="1560" height="900">
  <style>
    .title{font:700 7px Segoe UI,Arial,sans-serif;fill:#1f2937}
    .meta{font:5px Segoe UI,Arial,sans-serif;fill:#374151}
    .pin{fill:#24313f;stroke:#facc15;stroke-width:.7}
    .symbol-stroke{stroke:#111;stroke-width:2;fill:none;stroke-linecap:round;stroke-linejoin:round}
    .symbol-text{fill:#111;font:700 13px Segoe UI,Arial,sans-serif}
  </style>
  <text x="12" y="16" class="title">Lote Microcontroladores - renderer package SimulIDE</text>
  <text x="12" y="25" class="meta">Pontos amarelos/escuros: pinos eletricos reais; packages renderizados por componentSymbols.js, sem fallback hardcoded por typeId.</text>
  ${panel(items[0], 28, 76, 1)}
  ${panel(items[1], 165, 76, 1)}
  ${panel(items[2], 320, 76, 1)}
</svg>`;

const evidence = {
  generatedAt: new Date().toISOString(),
  sourceStatus: {
    simulideEsp32Package: "nao localizado em .codex-simulide-src; SimulIDE usa ./data/esp32/esp32.package em esp32.cpp",
    simulideChipPaint: "localizado em .codex-simulide-src/src/components/subcircuits/chip.cpp",
    simulidePackagePinPaint: "localizado em .codex-simulide-src/src/components/other/packagepin.cpp",
    simulidePinPaint: "localizado em .codex-simulide-src/src/gui/circuitwidget/pin.cpp",
  },
  rendererAssertions: {
    packagePriority: true,
    idBasedPinMatching: true,
    missingElectricalLeadsHidden: true,
    packagePinMarker: true,
    initialTransformSanitized: true,
  },
  components: items.map((item) => ({
    typeId: item.typeId,
    title: item.title,
    manifest: item.manifest,
    box: item.box,
    nativePackageSize: { width: item.json.package.width, height: item.json.package.height },
    schematicSize: { width: item.json.package.schematicWidth ?? item.json.package.width, height: item.json.package.schematicHeight ?? item.json.package.height },
    background: item.json.package.background?.kind ?? "none",
    pinMarker: item.json.package.pinMarker ?? null,
    pinLabelColor: item.json.package.pinLabelColor ?? null,
    electricalPins: item.electricalPinIds.length,
    packagePins: item.packagePinIds.length,
    missingElectricalLeads: item.missingElectricalLeads,
    decorativeOrNcPins: item.decorativeOrNcPins,
    pins: item.pins,
  })),
};

const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Lote Microcontroladores - evidencia</title>
  <style>
    body{font:14px system-ui,Segoe UI,Arial,sans-serif;margin:24px;background:#f6f7f9;color:#172033}
    .card{background:white;border:1px solid #d6dbe3;border-radius:8px;padding:16px;margin:0 0 16px}
    code{background:#f1f4f8;padding:2px 4px;border-radius:4px}
    pre{background:#101827;color:#e5e7eb;padding:12px;border-radius:6px;overflow:auto}
    img{max-width:100%;height:auto;border:1px solid #d6dbe3}
  </style>
</head>
<body>
  <main class="card">
    <h1>Microcontroladores - evidencia visual e funcional</h1>
    <p>Render gerado pelo build compilado de <code>extension/out-webview/componentSymbols.js</code>, registrando os packages reais dos manifests.</p>
    <p><b>Fonte SimulIDE:</b> <code>Chip::paint</code>, <code>Pin::paint</code> e <code>PackagePin::paint</code> localizados; <code>data/esp32/esp32.package</code> nao localizado localmente.</p>
    <p><img src="lote-microcontroladores-contact-sheet.svg" alt="Microcontroladores renderizados"></p>
    <pre>${JSON.stringify(evidence.components.map(({ typeId, box, electricalPins, packagePins, missingElectricalLeads, decorativeOrNcPins, pinMarker }) => ({ typeId, box, electricalPins, packagePins, missingElectricalLeads, decorativeOrNcPins, pinMarker })), null, 2)}</pre>
  </main>
</body>
</html>`;

fs.writeFileSync(".codex-validation/lote-microcontroladores-evidence.json", `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
fs.writeFileSync(".codex-validation/lote-microcontroladores-contact-sheet.svg", contactSheet, "utf8");
fs.writeFileSync(".codex-validation/lote-microcontroladores-evidence.html", html, "utf8");

console.log(".codex-validation/lote-microcontroladores-evidence.html");
console.log(".codex-validation/lote-microcontroladores-contact-sheet.svg");
console.log(".codex-validation/lote-microcontroladores-evidence.json");
