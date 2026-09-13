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

execFileSync(process.execPath, [path.join(repoRoot, "scripts", "apply-tdps-reference-symbols.mjs")], { cwd: repoRoot, stdio: "inherit" });
