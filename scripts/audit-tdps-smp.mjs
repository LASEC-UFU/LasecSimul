import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2] || 'C:/SourceCode/TDPSv771';
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(smp|txd)$/i.test(entry.name)) files.push(full);
  }
}
walk(root);
const records = new Map();
const models = [];
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  const recordTypes = [];
  for (const line of lines) {
    const match = line.match(/^\s*(<{2,3}[^>]+>>)/);
    if (match) {
      const type = match[1]; recordTypes.push(type);
      const item = records.get(type) || { count: 0, files: new Set() };
      item.count++; item.files.add(path.relative(root, file)); records.set(type, item);
    }
  }
  models.push({ file: path.relative(root, file), bytes: Buffer.byteLength(text), lines: lines.length,
    recordTypes, references: [...text.matchAll(/\bM\d+\b/g)].length });
}
const out = { root, generatedAt: new Date().toISOString(), fileCount: files.length,
  files: models, recordTypes: [...records].map(([type, v]) => ({ type, count: v.count, files: [...v.files].sort() }))
    .sort((a,b) => b.count-a.count || a.type.localeCompare(b.type)) };
const destination = process.argv[3] || 'tdps-audit-inventory.json';
fs.writeFileSync(destination, JSON.stringify(out, null, 2) + '\n');
console.log(`TDPS audit: ${out.fileCount} files, ${out.recordTypes.length} record markers -> ${destination}`);
