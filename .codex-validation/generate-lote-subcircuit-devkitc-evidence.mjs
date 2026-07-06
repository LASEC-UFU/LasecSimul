import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

import { seedSubcircuitInternalComponents, seedSymbolAuthoringComponents } from "../extension/out/catalog/symbolAuthoring.js";
import { extractSimulideSubcircuitScene, translateSimulideSubcircuitAuthoringScene } from "../extension/out/catalog/simulideSceneTranslator.js";
import { componentBox, componentLocalOrigin, componentSymbolSvg, pinLocalPosition, registerPackage } from "../extension/out/ui/webview/componentSymbols.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, ".codex-validation");
const subcircuitPath = path.join(root, "subcircuits", "esp32_devkitc_v4.lssub.json");
const mcuPath = path.join(root, "mcu-adapters", "espressif-esp32", "mcu.json");
const catalogPath = path.join(root, "project", "schema", "component-catalog.json");

const subcircuit = JSON.parse(fs.readFileSync(subcircuitPath, "utf8"));
const mcu = JSON.parse(fs.readFileSync(mcuPath, "utf8"));
const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));

for (const item of catalog.items ?? []) {
  if (item.typeId && item.package) registerPackage(item.typeId, item.package, item.logicSymbolPackage);
}
registerPackage(mcu.chipId, mcu.package, mcu.logicSymbolPackage);
registerPackage(subcircuit.typeId, subcircuit.package, subcircuit.logicSymbolPackage);

const internal = seedSubcircuitInternalComponents(subcircuit.components, subcircuit.wires);
const packageComponents = seedSymbolAuthoringComponents(subcircuit.package, 0, 0);
const scene = extractSimulideSubcircuitScene(subcircuit);
const translated = translateSimulideSubcircuitAuthoringScene(packageComponents, internal.components, internal.wires, scene);

function renderComponent(component) {
  const box = componentBox(component.typeId, component.properties);
  const body = componentSymbolSvg(component.typeId, component.properties);
  const origin = componentLocalOrigin(component.typeId, component.properties) ?? { x: box.width / 2, y: box.height / 2 };
  const label = component.showId
    ? `<text x="${box.width / 2}" y="-5" text-anchor="middle" font-family="Arial,sans-serif" font-size="9" fill="#3156b7">${escapeXml(component.label ?? component.id)}</text>`
    : "";
  return `<g transform="translate(${component.x},${component.y}) rotate(${component.rotation ?? 0} ${origin.x} ${origin.y})">${body}${label}</g>`;
}

const componentById = new Map(translated.components.map((component) => [component.id, component]));
const pinOrderByComponent = new Map();
for (const wire of translated.wires) {
  for (const endpoint of [wire.from, wire.to]) {
    if (!pinOrderByComponent.has(endpoint.componentId)) pinOrderByComponent.set(endpoint.componentId, []);
    const order = pinOrderByComponent.get(endpoint.componentId);
    if (!order.includes(endpoint.pinId)) order.push(endpoint.pinId);
  }
}

function endpointPosition(endpoint) {
  const component = componentById.get(endpoint.componentId);
  if (!component) return undefined;
  const box = componentBox(component.typeId, component.properties);
  const origin = componentLocalOrigin(component.typeId, component.properties) ?? { x: box.width / 2, y: box.height / 2 };
  const order = pinOrderByComponent.get(endpoint.componentId) ?? [endpoint.pinId];
  const pinIndex = Math.max(0, order.indexOf(endpoint.pinId));
  const local = pinLocalPosition(endpoint.pinId, pinIndex, Math.max(1, order.length), component.typeId, component.properties);
  const rotation = component.rotation ?? 0;
  const dx = local.x - origin.x;
  const dy = local.y - origin.y;
  const rotated =
    rotation === 90 ? { x: origin.x - dy, y: origin.y + dx }
    : rotation === 180 ? { x: origin.x - dx, y: origin.y - dy }
    : rotation === 270 ? { x: origin.x + dy, y: origin.y - dx }
    : local;
  return { x: component.x + rotated.x, y: component.y + rotated.y };
}

function renderWire(wire) {
  const from = endpointPosition(wire.from);
  const to = endpointPosition(wire.to);
  if (!from || !to) return "";
  const points = [from, ...(wire.points ?? []), to];
  const d = points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
  return `<path d="${d}" fill="none" stroke="#5c6f86" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function bounds(components) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const component of components) {
    const box = componentBox(component.typeId, component.properties);
    minX = Math.min(minX, component.x);
    minY = Math.min(minY, component.y);
    maxX = Math.max(maxX, component.x + box.width);
    maxY = Math.max(maxY, component.y + box.height);
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

const b = bounds(translated.components);
const margin = 40;
const width = Math.ceil(b.width + margin * 2);
const height = Math.ceil(b.height + margin * 2);
const offsetX = margin - b.minX;
const offsetY = margin - b.minY;
const grid = `
  <defs>
    <pattern id="minorGrid" width="10" height="10" patternUnits="userSpaceOnUse">
      <path d="M 10 0 L 0 0 0 10" fill="none" stroke="#d7d7d0" stroke-width="1"/>
    </pattern>
    <pattern id="majorGrid" width="50" height="50" patternUnits="userSpaceOnUse">
      <rect width="50" height="50" fill="url(#minorGrid)"/>
      <path d="M 50 0 L 0 0 0 50" fill="none" stroke="#c3c3bd" stroke-width="1.5"/>
    </pattern>
  </defs>
  <rect width="100%" height="100%" fill="#fbfad6"/>
  <rect width="100%" height="100%" fill="url(#majorGrid)"/>
`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
${grid}
<g transform="translate(${offsetX},${offsetY})">
${translated.wires.map(renderWire).join("\n")}
${translated.components.map(renderComponent).join("\n")}
</g>
</svg>`;

const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Lote Subcircuit DevKitC</title></head>
<body style="margin:0;background:#222">
${svg}
</body>
</html>`;

const packageBody = translated.components.find((component) => component.typeId === "other.package");
const summary = {
  subcircuit: subcircuit.typeId,
  authoringScene: scene ?? null,
  packagePosition: packageBody ? { x: packageBody.x, y: packageBody.y } : null,
  internalMcuPosition: translated.components.find((component) => component.id === "mcu1")
    ? { x: translated.components.find((component) => component.id === "mcu1").x, y: translated.components.find((component) => component.id === "mcu1").y }
    : null,
  components: translated.components.length,
  wires: translated.wires.length,
};

fs.writeFileSync(path.join(outDir, "lote-subcircuit-devkitc-contact-sheet.svg"), svg, "utf8");
fs.writeFileSync(path.join(outDir, "lote-subcircuit-devkitc-evidence.html"), html, "utf8");
fs.writeFileSync(path.join(outDir, "lote-subcircuit-devkitc-evidence.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
if (fs.existsSync(chrome)) {
  const userDataDir = path.join(outDir, ".chrome-subcircuit-devkitc");
  fs.rmSync(userDataDir, { recursive: true, force: true });
  execFileSync(chrome, [
    "--headless=new",
    "--disable-gpu",
    `--user-data-dir=${userDataDir}`,
    `--screenshot=${path.join(outDir, "lote-subcircuit-devkitc-evidence.png")}`,
    `--window-size=${width},${height}`,
    path.join(outDir, "lote-subcircuit-devkitc-evidence.html"),
  ], { stdio: "ignore" });
  fs.rmSync(userDataDir, { recursive: true, force: true });
}

console.log(JSON.stringify(summary, null, 2));
