import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function exists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function visualOrigin(manifest) {
  const pkg = manifest.package;
  if (pkg?.simulidePaint) return "simulidePaint";
  if (pkg?.viewSpec) return "viewSpec";
  if (pkg?.background || (Array.isArray(pkg?.shapes) && pkg.shapes.length > 0)) return "package.shapes";
  if (pkg) return "package.pins-only";
  if (typeof manifest.symbolSvg === "string" && manifest.symbolSvg.trim()) return "symbolSvg";
  return "componentSymbols/fallback";
}

function missingDetails(origin) {
  if (origin === "simulidePaint") {
    return ["validar pixel contra SimulIDE", "validar hit-test/shape", "validar comportamento eletrico"];
  }
  if (origin === "viewSpec") {
    return ["paint() C++ nao traduzido", "QPainterPath/arc/text metrics Qt nao garantidos", "hit-test aproximado", "partes moveis dependem de adapter manual"];
  }
  if (origin === "package.shapes") {
    return ["paint() C++ nao traduzido", "estado visual dinamico possivelmente ausente", "hit-test real nao localizado", "labels/pinos dependem do package manual"];
  }
  if (origin === "package.pins-only") {
    return ["corpo visual ausente ou generico", "paint() C++ nao traduzido", "hit-test real nao localizado"];
  }
  if (origin === "symbolSvg") {
    return ["SVG manual fora do package", "pinos calculados por fallback", "hit-test real nao localizado"];
  }
  return ["fallback generico", "geometria SimulIDE nao localizada", "pinos/bounding box/hit-test por heuristica"];
}

function fidelityStatus(origin) {
  if (origin === "simulidePaint") return "candidate-needs-visual-proof";
  return "divergent-by-architecture";
}

function collectCatalogItems() {
  const catalogPath = path.join(root, "project", "schema", "component-catalog.json");
  const catalog = readJson(catalogPath);
  return (catalog.items ?? []).map((item) => ({
    scope: "built-in",
    typeId: item.typeId,
    label: item.label,
    manifestPath: path.relative(root, catalogPath),
    manifest: item,
  }));
}

function collectDeviceItems() {
  const libraryPath = path.join(root, "devices", "library.json");
  const library = readJson(libraryPath);
  return (library.devices ?? []).map((entry) => {
    const manifestPath = path.join(root, "devices", entry.manifest);
    const manifest = exists(manifestPath) ? readJson(manifestPath) : {};
    return {
      scope: "abi-device",
      typeId: entry.typeId,
      label: manifest.label ?? manifest.name,
      manifestPath: path.relative(root, manifestPath),
      manifest,
    };
  });
}

function collectMcuItems() {
  const libraryPath = path.join(root, "mcu-adapters", "library.json");
  const library = exists(libraryPath) ? readJson(libraryPath) : { mcus: [] };
  return (library.mcus ?? []).map((entry) => {
    const manifestPath = path.join(root, "mcu-adapters", entry.manifest);
    const manifest = exists(manifestPath) ? readJson(manifestPath) : {};
    return {
      scope: "mcu-adapter",
      typeId: manifest.chipId ?? entry.chipId,
      label: manifest.name,
      manifestPath: path.relative(root, manifestPath),
      manifest,
    };
  });
}

function collectSubcircuitItems() {
  const libraryPath = path.join(root, "subcircuits", "library.json");
  const library = exists(libraryPath) ? readJson(libraryPath) : { subcircuits: [] };
  return (library.subcircuits ?? []).map((entry) => {
    const manifestPath = path.join(root, "subcircuits", entry.manifest);
    const manifest = exists(manifestPath) ? readJson(manifestPath) : {};
    return {
      scope: "subcircuit",
      typeId: entry.typeId,
      label: manifest.label ?? manifest.name,
      manifestPath: path.relative(root, manifestPath),
      manifest,
    };
  });
}

function auditItem(item) {
  const origin = visualOrigin(item.manifest);
  const source = item.manifest.package?.simulidePaint?.source?.file;
  return {
    scope: item.scope,
    typeId: item.typeId,
    label: item.label ?? "",
    manifestPath: item.manifestPath,
    visualOrigin: origin,
    fidelityStatus: fidelityStatus(origin),
    simulideSource: source ?? "nao localizado",
    missingDetails: missingDetails(origin),
  };
}

function summarize(items) {
  const byScope = {};
  const byOrigin = {};
  const byStatus = {};
  for (const item of items) {
    byScope[item.scope] = (byScope[item.scope] ?? 0) + 1;
    byOrigin[item.visualOrigin] = (byOrigin[item.visualOrigin] ?? 0) + 1;
    byStatus[item.fidelityStatus] = (byStatus[item.fidelityStatus] ?? 0) + 1;
  }
  return { total: items.length, byScope, byOrigin, byStatus };
}

const items = [
  ...collectCatalogItems(),
  ...collectDeviceItems(),
  ...collectMcuItems(),
  ...collectSubcircuitItems(),
].map(auditItem);

const report = {
  generatedAt: new Date().toISOString(),
  simulideSourceRoot: exists(path.join(root, ".codex-simulide-src")) ? ".codex-simulide-src" : "nao localizado",
  summary: summarize(items),
  items,
};

if (process.argv.includes("--write")) {
  const outDir = path.join(root, ".codex-validation");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "render-audit.json");
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(path.relative(root, outPath));
} else {
  console.log(JSON.stringify(report, null, 2));
}
