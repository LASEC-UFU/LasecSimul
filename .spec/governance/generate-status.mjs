import fs from "node:fs";
import path from "node:path";

const scriptPath = new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1));
const specRoot = path.resolve(path.dirname(scriptPath), "..");

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "archive") files.push(...walk(full));
    } else if (entry.name.endsWith(".md") && !["README.md", "STATUS.md"].includes(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function parseList(value) {
  const inner = value.trim().slice(1, -1).trim();
  return inner ? inner.split(",").map((item) => item.trim()) : [];
}

function metadataOf(content) {
  const match = content.replace(/^\uFEFF/, "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return undefined;
  const metadata = {};
  for (const line of match[1].split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index < 0) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    metadata[key] = value.startsWith("[") ? parseList(value) : value;
  }
  return metadata;
}

const documents = walk(specRoot).map((file) => {
  const content = fs.readFileSync(file, "utf8");
  const metadata = metadataOf(content);
  const title = content.match(/^#\s+(.+)$/m)?.[1] ?? path.basename(file, ".md");
  return {
    ...metadata,
    title,
    relative: path.relative(specRoot, file).replaceAll("\\", "/")
  };
}).filter((document) => document.id).sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));

const counts = new Map();
for (const document of documents) counts.set(document.status, (counts.get(document.status) ?? 0) + 1);

const lines = [
  "# Status das especificações",
  "",
  "> Arquivo gerado por `node .spec/governance/generate-status.mjs`. Não editar manualmente.",
  "",
  `Total: ${documents.length} documentos. ` + [...counts.entries()].sort().map(([status, count]) => `${status}: ${count}`).join("; ") + ".",
  "",
  "| ID | Kind | Status | Documento | Dependências |",
  "|---|---|---|---|---|",
  ...documents.map((document) => `| ${document.id} | ${document.kind} | ${document.status} | [${document.title}](${document.relative}) | ${(document.dependsOn ?? []).join(", ") || "—"} |`),
  "",
  "## Próximo gate",
  "",
  "F1 — reconstruir o baseline a partir de checkout/build limpo. Features novas permanecem bloqueadas até F1–F4.",
  ""
];

fs.writeFileSync(path.join(specRoot, "STATUS.md"), lines.join("\n"), "utf8");
console.log(`[spec-status] STATUS.md gerado com ${documents.length} documentos.`);
