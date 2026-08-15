import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1))), "..", "..");
const specRoot = path.join(repoRoot, ".spec");
const errors = [];

const allowedKinds = new Set(["architecture", "feature", "schema", "adr", "benchmark", "governance", "roadmap"]);
const allowedStatuses = new Set(["active", "planned", "deferred", "accepted", "superseded", "historical"]);
const exemptNames = new Set(["README.md", "STATUS.md"]);

function walk(directory, options = {}) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    if (options.skipGenerated && ["build", "dist", "out", "out-test", "out-webview"].includes(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (options.skipArchive && full === path.join(specRoot, "archive")) continue;
      result.push(...walk(full, options));
    } else {
      result.push(full);
    }
  }
  return result;
}

function parseList(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return undefined;
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(",").map((item) => item.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
}

function parseFrontmatter(file, content) {
  const normalized = content.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return undefined;
  const metadata = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator < 0) {
      errors.push(`${path.relative(repoRoot, file)}: linha inválida no frontmatter: ${line}`);
      continue;
    }
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).trim();
    metadata[key] = raw.startsWith("[") ? parseList(raw) : raw.replace(/^['"]|['"]$/g, "");
  }
  return metadata;
}

const activeMarkdown = walk(specRoot, { skipArchive: true })
  .filter((file) => file.endsWith(".md"));
const documents = [];
const byId = new Map();

for (const file of activeMarkdown) {
  const relative = path.relative(specRoot, file).replaceAll("\\", "/");
  const content = fs.readFileSync(file, "utf8");
  if (exemptNames.has(path.basename(file))) continue;
  const metadata = parseFrontmatter(file, content);
  if (!metadata) {
    errors.push(`${relative}: frontmatter ausente`);
    continue;
  }
  for (const key of ["id", "kind", "status", "dependsOn", "supersedes"]) {
    if (metadata[key] === undefined) errors.push(`${relative}: campo obrigatório ausente: ${key}`);
  }
  if (!/^[A-Z]+-[0-9]{3,4}$/.test(metadata.id ?? "")) errors.push(`${relative}: id inválido: ${metadata.id}`);
  if (!allowedKinds.has(metadata.kind)) errors.push(`${relative}: kind inválido: ${metadata.kind}`);
  if (!allowedStatuses.has(metadata.status)) errors.push(`${relative}: status inválido: ${metadata.status}`);
  if (!Array.isArray(metadata.dependsOn)) errors.push(`${relative}: dependsOn deve usar lista inline []`);
  if (!Array.isArray(metadata.supersedes)) errors.push(`${relative}: supersedes deve usar lista inline []`);
  if (byId.has(metadata.id)) errors.push(`${relative}: id duplicado com ${byId.get(metadata.id).relative}: ${metadata.id}`);
  const document = { file, relative, content, metadata };
  byId.set(metadata.id, document);
  documents.push(document);

  if (["architecture", "feature", "schema"].includes(metadata.kind) && !/^## Aceita(?:ção|cao)\s*$/mi.test(content)) {
    errors.push(`${relative}: documento ${metadata.kind} precisa de seção '## Aceitação'`);
  }
}

for (const document of documents) {
  for (const dependency of document.metadata.dependsOn ?? []) {
    if (!byId.has(dependency)) errors.push(`${document.relative}: dependência inexistente: ${dependency}`);
  }
}

const visiting = new Set();
const visited = new Set();
function visit(id, trail = []) {
  if (visiting.has(id)) {
    errors.push(`ciclo de dependência: ${[...trail, id].join(" -> ")}`);
    return;
  }
  if (visited.has(id) || !byId.has(id)) return;
  visiting.add(id);
  for (const dependency of byId.get(id).metadata.dependsOn ?? []) visit(dependency, [...trail, id]);
  visiting.delete(id);
  visited.add(id);
}
for (const id of byId.keys()) visit(id);

const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
for (const file of activeMarkdown) {
  const relative = path.relative(specRoot, file).replaceAll("\\", "/");
  const content = fs.readFileSync(file, "utf8");
  for (const match of content.matchAll(linkPattern)) {
    let target = match[1].trim().replace(/^<|>$/g, "");
    if (!target || target.startsWith("#") || /^[a-z]+:\/\//i.test(target)) continue;
    target = target.split("#", 1)[0];
    const resolved = path.resolve(path.dirname(file), decodeURIComponent(target));
    if (!fs.existsSync(resolved)) errors.push(`${relative}: link local quebrado: ${match[1]}`);
  }
}

const textExtensions = new Set([".md", ".ts", ".js", ".mjs", ".c", ".cpp", ".h", ".hpp", ".json", ".spec", ".skill", ".txt"]);
for (const file of walk(repoRoot, { skipGenerated: true })) {
  if (file.startsWith(path.join(specRoot, "archive"))) continue;
  if (!textExtensions.has(path.extname(file).toLowerCase())) continue;
  const content = fs.readFileSync(file, "utf8");
  const oldPluralPath = new RegExp("\\.spec" + "s(?:[\\\\/]|\\b)");
  if (oldPluralPath.test(content)) {
    errors.push(`${path.relative(repoRoot, file)}: referência ao antigo nome plural da pasta de especificações`);
  }
}

const legacyRootFiles = fs.readdirSync(specRoot, { withFileTypes: true })
  .filter((entry) => entry.isFile() && !["README.md", "ROADMAP.md", "STATUS.md"].includes(entry.name));
for (const entry of legacyRootFiles) errors.push(`.spec/${entry.name}: arquivo inesperado na raiz canônica`);

JSON.parse(fs.readFileSync(path.join(specRoot, "governance", "spec.schema.json"), "utf8"));

if (errors.length) {
  console.error(`[spec-check] ${errors.length} erro(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`[spec-check] OK: ${documents.length} documentos ativos, ${byId.size} IDs, DAG e links válidos.`);
