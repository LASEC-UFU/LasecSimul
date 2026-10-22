const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const site = path.join(root, 'site');
const catalog = JSON.parse(fs.readFileSync(path.join(site, 'catalog.json'), 'utf8'));
const errors = [];
if (!fs.existsSync(path.join(site, 'index.html'))) errors.push('index.html ausente');
const ids = new Set();
for (const item of catalog) {
  if (ids.has(item.id)) errors.push(`identificador duplicado: ${item.id}`);
  ids.add(item.id);
  const id = item.id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'component';
  if (!fs.existsSync(path.join(site, 'components', `${id}.html`))) errors.push(`página ausente para ${item.id}`);
  if (item.icon && !['svg', 'png'].some((ext) => fs.existsSync(path.join(site, 'assets', `${id}.${ext}`)))) errors.push(`ícone não resolvido para ${item.id}`);
}
function htmlFilesUnder(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(prefix, entry.name);
    return entry.isDirectory() ? htmlFilesUnder(path.join(dir, entry.name), rel) : entry.name.endsWith('.html') ? [rel] : [];
  });
}
for (const htmlFile of ['index.html', 'index-alpha.html', 'examples.html', 'code-examples.html', 'developer/index.html', ...htmlFilesUnder(path.join(site, 'components')).map((name) => path.join('components', name)), ...htmlFilesUnder(path.join(site, 'code-examples')).map((name) => path.join('code-examples', name))].map((name) => path.join(site, name))) {
  const html = fs.readFileSync(htmlFile, 'utf8');
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const ref = match[1];
    if (/^(?:https?:|mailto:|#|data:|javascript:)/i.test(ref)) continue;
    const target = path.resolve(path.dirname(htmlFile), decodeURIComponent(ref.split('#')[0]));
    const resolvedTarget = fs.existsSync(target) && fs.statSync(target).isDirectory() ? path.join(target, 'index.html') : target;
    if (!target.startsWith(site + path.sep) && target !== site || !fs.existsSync(resolvedTarget)) errors.push(`referência quebrada em ${path.relative(site, htmlFile)}: ${ref}`);
  }
}
const report = {
  version: require(path.join(root, 'package.json')).version,
  resources: catalog.length,
  pages: catalog.length,
  categories: [...new Set(catalog.map((item) => item.category))].length,
  withDescription: catalog.filter((item) => item.description).length,
  withExamples: catalog.filter((item) => item.examples?.length).length,
  codeExamples: htmlFilesUnder(path.join(site, 'code-examples')).filter((name) => name.endsWith('.html') && !name.startsWith(`raw${path.sep}`)).length,
  withResolvedIcon: catalog.filter((item) => !item.icon || ['svg', 'png'].some((ext) => fs.existsSync(path.join(site, 'assets', `${item.id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'component'}.${ext}`)))).length,
  incomplete: catalog.filter((item) => !item.description).map((item) => item.id),
  withoutExamples: catalog.filter((item) => !item.examples?.length).map((item) => item.id),
  errors,
};
fs.writeFileSync(path.join(site, 'coverage.json'), JSON.stringify(report, null, 2));
console.log(`Cobertura: ${report.pages}/${report.resources} páginas; ${report.withDescription} descrições; ${report.withResolvedIcon} ícones resolvidos.`);
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
