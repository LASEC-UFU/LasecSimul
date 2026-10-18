import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(repoRoot, "subcircuits");
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, ".spec", "fixtures", "tdps-v771-library.json"), "utf8"));
const sourceRoot = process.env.TDPS_SOURCE_ROOT;

if (!sourceRoot) throw new Error("TDPS_SOURCE_ROOT deve apontar para a pasta examples do TDPS v7.71.");
const require = createRequire(import.meta.url);
const importerPath = path.join(repoRoot, "extension", "out-test", "src", "tdps", "tdpsImporter.js");
if (!fs.existsSync(importerPath)) {
  execFileSync(process.execPath, [path.join(repoRoot, "extension", "node_modules", "typescript", "bin", "tsc"), "-p", path.join(repoRoot, "extension", "tsconfig.test.json")], { cwd: repoRoot, stdio: "inherit" });
}
const { parseTdpsSmp, convertTdpsToSubcircuit } = require(importerPath);

for (const entry of manifest.entries) {
  const sourcePath = path.join(sourceRoot, ...entry.source.split("/"));
  if (!fs.existsSync(sourcePath)) throw new Error(`fonte TDPS ausente: ${sourcePath}`);
  const converted = convertTdpsToSubcircuit(parseTdpsSmp(fs.readFileSync(sourcePath), entry.source), entry.typeId);
  if (converted.report.unsupported.length) {
    throw new Error(`${entry.source}: conversao contem semantica sem mapeamento: ${converted.report.unsupported.map((item) => item.reason).join(" | ")}`);
  }
  const document = { ...converted.document, name: entry.label, folderPath: ["Modelos"], help: {
    description: `Modelo TDPS v7.71 convertido da fonte ${entry.source}.`,
  }};
  fs.writeFileSync(path.join(outputDir, entry.file), `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

// Plantas NÃO entram em library.json (nada de registro global no catálogo/Core): os modelos TDPS são
// listados só em plants.json, o índice de modelos usado para incorporar a planta aos projetos e gerar
// um .lsproj independente por planta (scripts/generate-plant-projects.cjs). Remove de library.json
// qualquer entrada TDPS que uma versão antiga deste script tenha gravado.
const libraryPath = path.join(outputDir, "library.json");
const library = JSON.parse(fs.readFileSync(libraryPath, "utf8"));
const withoutTdps = library.subcircuits.filter((entry) => !String(entry.typeId).startsWith("subcircuits.tdps."));
if (withoutTdps.length !== library.subcircuits.length) {
  library.subcircuits = withoutTdps;
  fs.writeFileSync(libraryPath, `${JSON.stringify(library, null, 2)}\n`, "utf8");
}
const plantsPath = path.join(outputDir, "plants.json");
const plants = JSON.parse(fs.readFileSync(plantsPath, "utf8"));
const knownProjects = new Map(plants.plants.map((entry) => [entry.typeId, entry.project]));
const slug = (text) => text.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
const retainedPlants = plants.plants.filter((entry) => !String(entry.typeId).startsWith("subcircuits.tdps."));
const firstTdpsPlant = plants.plants.findIndex((entry) => String(entry.typeId).startsWith("subcircuits.tdps."));
const generatedPlants = manifest.entries.map(({ typeId, file, label }) => ({
  typeId, manifest: file, project: knownProjects.get(typeId) ?? `planta_${slug(label)}.lsproj`,
}));
plants.plants = firstTdpsPlant < 0
  ? [...retainedPlants, ...generatedPlants]
  : [...retainedPlants.slice(0, firstTdpsPlant), ...generatedPlants, ...retainedPlants.slice(firstTdpsPlant)];
fs.writeFileSync(plantsPath, `${JSON.stringify(plants, null, 2)}\n`, "utf8");

// Telas de processo NATIVAS (biblioteca grafica `graphics.*`), nunca mais o bitmap de referencia:
// `apply-tdps-reference-symbols.mjs` gravava `symbol.background = {kind:"image", asset:"<png>"}` e
// foi substituido por este compositor -- ver docs/45-biblioteca-grafica-supervisorio-implementacao.md.
// Reapontar aqui e' o que impede uma regeneracao da biblioteca de reintroduzir os bitmaps.
execFileSync(process.execPath, [path.join(repoRoot, "scripts", "generate-tdps-process-screens.mjs")], { cwd: repoRoot, stdio: "inherit" });
