import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const subcircuitsDir = path.join(repoRoot, "subcircuits");
const imageDir = path.join(subcircuitsDir, "tdps-reference-images");
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, ".spec", "fixtures", "tdps-v771-library.json"), "utf8"));
const CANVAS_WIDTH = 640;
const finite = (value, fallback = 0) => typeof value === "number" && Number.isFinite(value) ? value : fallback;

for (const entry of manifest.entries) {
  const filePath = path.join(subcircuitsDir, entry.file);
  const imageName = entry.file.replace(/\.lssubcircuit$/, ".png");
  const imagePath = path.join(imageDir, imageName);
  if (!fs.existsSync(filePath)) throw new Error(`subcircuito ausente: ${filePath}`);
  if (!fs.existsSync(imagePath)) throw new Error(`imagem de referencia ausente: ${imagePath}`);
  const document = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const imageBytes = fs.readFileSync(imagePath);
  const sourceWidth = imageBytes.readUInt32BE(16);
  const sourceHeight = imageBytes.readUInt32BE(20);
  const canvasHeight = Math.max(120, Math.round(CANVAS_WIDTH * sourceHeight / Math.max(1, sourceWidth)));
  const sx = CANVAS_WIDTH / Math.max(1, finite(document.symbol?.width, CANVAS_WIDTH));
  const sy = canvasHeight / Math.max(1, finite(document.symbol?.height, canvasHeight));
  const pins = (document.symbol?.pins ?? []).map((pin) => ({ ...pin, x: finite(pin.x) * sx, y: finite(pin.y) * sy }));
  const exposedComponents = (document.components ?? [])
    .filter((component) => component?.typeId !== "connectors.signal_tunnel" && component?.typeId !== "connectors.tunnel")
    .map((component, layer) => ({ componentId: component.id, x: finite(component.visual?.x) * sx, y: finite(component.visual?.y) * sy,
      rotation: [90, 180, 270].includes(component.visual?.rotation) ? component.visual.rotation : 0, flipH: false, flipV: false, scale: 1, layer }));
  document.symbolMode = "custom";
  document.symbol = { ...(document.symbol ?? {}), width: CANVAS_WIDTH, height: canvasHeight, border: true,
    background: { kind: "image", asset: `tdps-reference-images/${imageName}`, mime: "image/png" }, shapes: [], pins };
  document.exposedComponents = exposedComponents;
  fs.writeFileSync(filePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  console.log(`[tdps-reference] ${entry.file} <- ${imageName}; exposed=${exposedComponents.length}`);
}
