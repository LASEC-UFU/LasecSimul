import fs from "node:fs";
import path from "node:path";

const repo = process.argv[2] ?? path.resolve("..", "external-research", "drawio");
const stencilRoot = path.join(repo, "src", "main", "webapp", "stencils", "pid");
const outputJson = path.resolve("docs", "drawio-symbol-inventory.json");
const outputMd = path.resolve("docs", "DRAWIO_SYMBOL_INVENTORY.md");

const files = fs.readdirSync(stencilRoot).filter((name) => name.endsWith(".xml")).sort();
const categories = new Map([
  ["piping.xml", "Piping and fittings"],
  ["valves.xml", "Valves"],
  ["pumps.xml", "Pumps"],
  ["pumps_din.xml", "Pumps"],
  ["pumps_iso.xml", "Pumps"],
  ["vessels.xml", "Tanks and vessels"],
  ["instruments.xml", "Instrumentation"],
  ["flow_sensors.xml", "Instrumentation"],
  ["engines.xml", "Motors and drives"],
  ["compressors.xml", "Rotating equipment"],
  ["compressors_iso.xml", "Rotating equipment"],
  ["agitators.xml", "Mixers and agitators"],
  ["mixers.xml", "Mixers and agitators"],
  ["heat_exchangers.xml", "Process equipment"],
  ["filters.xml", "Process equipment"],
  ["separators.xml", "Process equipment"],
  ["misc.xml", "Process equipment"],
]);

function attribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return match?.[1] ?? "";
}

const inventory = [];
for (const file of files) {
  const source = fs.readFileSync(path.join(stencilRoot, file), "utf8");
  const symbols = [...source.matchAll(/<shape\b[^>]*>/g)].map((match, index) => {
    const tag = match[0];
    const start = match.index;
    const end = source.indexOf("</shape>", start);
    const body = end >= 0 ? source.slice(start, end + "</shape>".length) : "";
    const primitives = ["move", "line", "curve", "arc", "ellipse", "rect", "roundrect", "polyline", "close"]
      .filter((primitive) => new RegExp(`<${primitive}\\b`).test(body));
    return {
      id: `${file}:${index + 1}`,
      name: attribute(tag, "name"),
      width: Number(attribute(tag, "w")) || null,
      height: Number(attribute(tag, "h")) || null,
      connections: (body.match(/<constraint\b/g) ?? []).length,
      primitives,
    };
  });
  inventory.push({
    source: `src/main/webapp/stencils/pid/${file}`,
    category: categories.get(file) ?? "Other P&ID",
    symbolCount: symbols.length,
    symbols,
  });
}

const total = inventory.reduce((sum, item) => sum + item.symbolCount, 0);
const document = {
  generatedAt: new Date().toISOString(),
  upstream: "https://github.com/jgraph/drawio",
  commit: "744cb5420fdf126efd7a09b1d7082ca3e12c0841",
  stencilRoot: "src/main/webapp/stencils/pid",
  policy: "Reference-only audit. No draw.io stencil XML or geometry is shipped by LasecSimul.",
  fileCount: inventory.length,
  symbolCount: total,
  files: inventory,
};

fs.writeFileSync(outputJson, `${JSON.stringify(document, null, 2)}\n`);

const grouped = new Map();
for (const item of inventory) {
  if (!grouped.has(item.category)) grouped.set(item.category, []);
  grouped.get(item.category).push(item);
}
const lines = [
  "# Draw.io P&ID symbol inventory",
  "",
  `Generated from draw.io commit \`${document.commit}\` on ${document.generatedAt}.`,
  "",
  `The current upstream P&ID tree contains **${document.fileCount} stencil files** and **${document.symbolCount} shape definitions**. This is an audit inventory only; the production extension ships LasecSimul-native declarative symbols and does not parse draw.io at runtime.`,
  "",
  "## Source and method",
  "",
  `- Repository: ${document.upstream}`,
  "- Tree: `src/main/webapp/stencils/pid/*.xml`",
  "- Symbol count: each `<shape>` element is counted once.",
  "- Connection count: `<constraint>` elements inside each shape.",
  "- Primitive summary: primitive element names found inside each shape.",
  "",
];
for (const [category, items] of grouped) {
  lines.push(`## ${category}`, "", "| Source stencil | Symbols | Names |", "|---|---:|---|");
  for (const item of items) lines.push(`| \`${item.source}\` | ${item.symbolCount} | ${item.symbols.map((symbol) => symbol.name).join(", ")} |`);
  lines.push("");
}
fs.writeFileSync(outputMd, `${lines.join("\n")}\n`);
console.log(`Wrote ${outputJson} and ${outputMd}: ${document.symbolCount} symbols in ${document.fileCount} files.`);
