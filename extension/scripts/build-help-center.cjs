const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'site');
const catalogModule = require(path.join(root, 'out', 'catalog', 'UnifiedCatalog.js'));
let entries;
if (process.env.HELP_CATALOG_FIXTURE) entries = JSON.parse(fs.readFileSync(process.env.HELP_CATALOG_FIXTURE, 'utf8'));
else {
  const loaded = catalogModule.loadUnifiedCatalog(root, 'pt-BR');
  entries = [...loaded.catalog];
  // Reuse the app's manifest/library resolver without a running VS Code host. Its only runtime
  // dependency here is locale configuration; the generator pins that to the documented pt-BR locale.
  const Module = require('node:module');
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'vscode') return { workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) }, env: { language: 'pt-BR' } };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const registry = require(path.join(root, 'out', 'catalog', 'registeredSources.js'));
    const bundled = loaded.deviceLibraries.flatMap((library) => registry.expandLibraryJsonToSources(path.resolve(root, library)));
    const registered = registry.resolveRegisteredItems(root, [...bundled, ...loaded.registeredSources]);
    entries.push(...registered.map((item) => item.entry));
  } finally { Module._load = originalLoad; }
  entries = [...new Map(entries.map((entry) => [entry.typeId, entry])).values()];
}
const visibleEntries = entries.filter((entry) => !entry.hidden && !entry.paletteHidden && !entry.disabled);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'components'), { recursive: true });
fs.mkdirSync(path.join(out, 'developer'), { recursive: true });
const examplesRoot = path.resolve(root, '..', 'examples');
const exampleFiles = [];
function collectExamples(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) { if (!item.name.includes('migration-backup')) collectExamples(full); continue; }
    if (!item.name.endsWith('.lsproj')) continue;
    try {
      const project = JSON.parse(fs.readFileSync(full, 'utf8'));
      const rel = path.relative(examplesRoot, full).split(path.sep).join('/');
      const target = path.join(out, 'examples', rel);
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(full, target);
      exampleFiles.push({ name: path.basename(item.name, '.lsproj'), rel, target, typeIds: [...new Set((project.components ?? []).map((component) => component.typeId).filter(Boolean))] });
    } catch (error) { console.warn(`Projeto de exemplo ignorado (${full}): ${error.message}`); }
  }
}
if (fs.existsSync(examplesRoot)) collectExamples(examplesRoot);
const examplesByType = new Map();
for (const example of exampleFiles) for (const typeId of example.typeIds) examplesByType.set(typeId, [...(examplesByType.get(typeId) ?? []), example]);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const slug = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'component';
const iconFallbacks = { 'bridges.controlled_voltage_source': 'fonte-controlada', 'bridges.controlled_current_source': 'fonte-controlada', 'bridges.digital_output': 'fonte-de-tensao' };
const json = JSON.stringify(visibleEntries.map((entry) => ({
  id: entry.typeId, name: entry.label, category: entry.category,
  subcategory: entry.subcategory ?? '', folders: entry.folderPath ?? [],
  icon: entry.icon ?? '', iconFilePath: entry.iconFilePath ?? '',
  pinCount: entry.pinCount ?? null, pinIds: entry.pinIds ?? [],
  properties: entry.defaultProperties ?? {}, schema: entry.propertySchema ?? [],
  description: entry.help?.description ?? '', helpUrl: entry.help?.url ?? '', hidden: Boolean(entry.hidden),
  examples: (examplesByType.get(entry.typeId) ?? []).map(({ name, rel }) => ({ name, path: rel })),
})), null, 2);
fs.writeFileSync(path.join(out, 'catalog.json'), json);
const cards = visibleEntries.map((entry) => {
  const id = slug(entry.typeId);
  const effectiveIcon = iconFallbacks[entry.typeId] ?? entry.icon;
  const candidates = entry.iconFilePath ? [path.resolve(root, entry.iconFilePath)] : effectiveIcon ? ['svg', 'png'].map((ext) => path.join(root, 'media', 'components', 'light', `${effectiveIcon}.${ext}`)) : [];
  const iconPath = candidates.find((candidate) => fs.existsSync(candidate)) ?? '';
  let icon = '';
  if (iconPath && fs.existsSync(iconPath)) {
    const ext = path.extname(iconPath).toLowerCase();
    const dest = path.join(out, 'assets', `${id}${ext}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(iconPath, dest);
    icon = `<img src="assets/${id}${ext}" alt="${esc(entry.label)}" loading="lazy">`;
  }
  const fields = new Map((entry.propertySchema ?? []).map((item) => [item.id, item]));
  const props = Object.entries(entry.defaultProperties ?? {}).map(([key, value]) => { const field = fields.get(key) ?? {}; return `<tr><th>${esc(field.label ?? key)}</th><td><code>${esc(JSON.stringify(value))}</code></td><td>${esc(field.description ?? '')}</td></tr>`; }).join('') || '<tr><td colspan="3">Sem propriedades padrão declaradas.</td></tr>';
  const pins = entry.pinIds?.length ? entry.pinIds.map(esc).join(', ') : entry.pinCount == null ? 'Não especificado' : `${entry.pinCount} pino(s)`;
  const pinRows = (entry.package?.pins ?? []).map((pin) => `<tr><th>${esc(pin.id ?? pin.label ?? 'pino')}</th><td>${esc(pin.kind ?? 'não declarado')}</td><td>${esc(pin.label ?? '')}</td></tr>`).join('') || `<tr><td colspan="3">${esc(pins)}; detalhes elétricos não declarados no catálogo.</td></tr>`;
  const relatedExamples = (examplesByType.get(entry.typeId) ?? []).map((example) => `<li><a href="../examples/${esc(example.rel)}" download>${esc(example.name)} — ${esc(path.basename(example.rel))}</a></li>`).join('');
  const exampleSection = relatedExamples ? `<h2>Exemplos de projeto</h2><p>Projetos existentes no repositório que incluem este recurso:</p><ul>${relatedExamples}</ul>` : '';
  const body = `<header>${icon}<div><small>${esc(entry.category)}${entry.subcategory ? ` · ${esc(entry.subcategory)}` : ''}</small><h1>${esc(entry.label)}</h1><code>${esc(entry.typeId)}</code></div></header><p>${esc(entry.help?.description || `Descrição funcional detalhada ainda não foi cadastrada. O registro confirma que o componente pertence à categoria ${entry.category}.`)}</p><dl><dt>Biblioteca</dt><dd>${esc((entry.folderPath ?? [entry.category]).join(' / '))}</dd><dt>Pinos elétricos</dt><dd>${pins}</dd></dl><h2>Portas e conexões</h2><table><thead><tr><th>Identificador</th><th>Tipo</th><th>Rótulo</th></tr></thead><tbody>${pinRows}</tbody></table><h2>Parâmetros</h2><table><thead><tr><th>Nome</th><th>Padrão</th><th>Descrição</th></tr></thead><tbody>${props}</tbody></table>${exampleSection}<h2>Representação</h2><p>${icon ? 'Ícone sincronizado automaticamente com o arquivo do catálogo.' : 'O registro não declara um arquivo de ícone resolvido.'}</p><p class="related">Dados estruturais extraídos do catálogo atual. Informações funcionais não declaradas permanecem identificadas como incompletas.</p>`;
  const detailBody = body.replaceAll('src="assets/', 'src="../assets/');
  fs.writeFileSync(path.join(out, 'components', `${id}.html`), `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(entry.label)} · LasecSimul Help Center</title><link rel="stylesheet" href="../style.css"></head><body><header class="hero"><a class="brand" href="../">LasecSimul <b>Help Center</b></a><p><a href="../">Início</a> / ${esc(entry.category)} / ${esc(entry.label)}</p></header><main class="detail">${detailBody}</main></body></html>`);
  const searchTerms = [entry.label, entry.typeId, entry.category, entry.subcategory, ...(entry.folderPath ?? []), entry.help?.description, ...Object.keys(entry.defaultProperties ?? {}), ...Object.values(entry.defaultProperties ?? {}).map(String), ...(entry.propertySchema ?? []).flatMap((item) => [item.label, item.description, ...(item.options ?? []).map((option) => option.label)])].filter(Boolean);
  return `<article class="card" id="${id}" data-search="${esc(searchTerms.join(' ').toLocaleLowerCase('pt-BR'))}"><header>${icon}<div><small>${esc(entry.category)}${entry.subcategory ? ` · ${esc(entry.subcategory)}` : ''}</small><h2><a href="components/${id}.html">${esc(entry.label)}</a></h2><code>${esc(entry.typeId)}</code></div></header><p>${esc(entry.help?.description || 'Descrição funcional detalhada ainda não cadastrada.')}</p><dl><dt>Biblioteca</dt><dd>${esc((entry.folderPath ?? [entry.category]).join(' / '))}</dd><dt>Pinos</dt><dd>${pins}</dd></dl></article>`;
}).join('\n');
const categories = [...new Set(visibleEntries.map((entry) => entry.category))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
const nav = categories.map((category) => `<a href="#cat-${slug(category)}">${esc(category)}</a>`).join('');
const grouped = categories.map((category) => `<section id="cat-${slug(category)}"><h2>${esc(category)}</h2>${visibleEntries.filter((entry) => entry.category === category).map((entry) => `<a href="components/${slug(entry.typeId)}.html">${esc(entry.label)}</a>`).join('')}</section>`).join('');
const page = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="Documentação de referência do LasecSimul, gerada a partir do catálogo do aplicativo."><title>LasecSimul Help Center</title><link rel="stylesheet" href="style.css"></head><body><header class="hero"><a class="brand" href="./">LasecSimul <b>Help Center</b></a><p>Referência pesquisável dos componentes, baseada no catálogo unificado do aplicativo.</p><label class="search"><span>Pesquisar</span><input id="q" type="search" placeholder="Nome, categoria ou identificador…" aria-label="Pesquisar componentes"></label><small>${visibleEntries.length} componentes documentados · versão ${esc(require(path.join(root, 'package.json')).version)}</small></header><div class="layout"><nav>${grouped}<section><h2>Índices</h2><a href="index-alpha.html">Índice alfabético</a><a href="examples.html">Projetos de exemplo</a></section><section><h2>Desenvolvimento</h2><a href="developer/index.html">Referência do código (Doxygen)</a></section></nav><main><div class="toolbar"><h1>Referência de componentes</h1><span id="count"></span></div><div class="cards">${cards}</div><p id="empty" hidden>Nenhum componente corresponde à pesquisa.</p><footer>Identificadores, parâmetros, portas e imagens são coletados do catálogo unificado. Conteúdo explicativo adicional segue a convenção Doxygen documentada no guia de autoria.</footer></main></div><script src="search.js"></script></body></html>`;
fs.writeFileSync(path.join(out, 'index.html'), page);
const alphabetical = [...visibleEntries].sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
const alphaRows = alphabetical.map((entry) => `<li><a href="components/${slug(entry.typeId)}.html">${esc(entry.label)}</a> <small>${esc(entry.category)} · <code>${esc(entry.typeId)}</code></small></li>`).join('');
fs.writeFileSync(path.join(out, 'index-alpha.html'), `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Índice alfabético · LasecSimul</title><link rel="stylesheet" href="style.css"></head><body><header class="hero"><a class="brand" href="./">LasecSimul <b>Help Center</b></a><p>Índice alfabético de componentes</p></header><main class="detail"><p><a href="./">Voltar à referência por categoria</a></p><ul>${alphaRows}</ul></main></body></html>`);
const exampleRows = exampleFiles.map((example) => `<li><a href="examples/${esc(example.rel)}" download>${esc(example.name)} — ${esc(path.basename(example.rel))}</a><small> Recursos identificados: ${example.typeIds.length}</small></li>`).join('');
fs.writeFileSync(path.join(out, 'examples.html'), `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Projetos de exemplo · LasecSimul</title><link rel="stylesheet" href="style.css"></head><body><header class="hero"><a class="brand" href="./">LasecSimul <b>Help Center</b></a><p>Projetos executáveis presentes no repositório</p></header><main class="detail"><p>Estes arquivos são copiados do diretório de exemplos do projeto. Abra ou importe o arquivo no LasecSimul para examinar sua montagem.</p><ul>${exampleRows || '<li>Nenhum projeto .lsproj encontrado.</li>'}</ul></main></body></html>`);
fs.writeFileSync(path.join(out, 'developer', 'index.html'), '<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Referência de código · LasecSimul</title><link rel="stylesheet" href="../style.css"><body><header class="hero"><a class="brand" href="../">LasecSimul <b>Help Center</b></a><p>Referência gerada pelo Doxygen no fluxo de publicação.</p></header><main class="detail"><h1>Referência do código</h1><p>Para gerar localmente, instale o Doxygen e execute <code>npm run docs:doxygen</code>. Os comentários estruturados das fontes são a base da referência de desenvolvedor.</p><a href="../HELP_CENTER_AUTHORING.md">Convenção de autoria</a></main></body></html>');
fs.copyFileSync(path.join(root, 'docs', 'HELP_CENTER_AUTHORING.md'), path.join(out, 'HELP_CENTER_AUTHORING.md'));
fs.writeFileSync(path.join(out, 'style.css'), `:root{font-family:Inter,"Segoe UI",sans-serif;color:#182638;background:#f4f7fb;color-scheme:light dark}*{box-sizing:border-box}body{margin:0}.hero{background:linear-gradient(120deg,#082f55,#087e9b);color:white;padding:28px max(24px,calc((100% - 1440px)/2))}.brand{font-size:22px;color:white;text-decoration:none}.hero p{margin:10px 0 18px;color:#d8edf5}.hero small{display:block;margin-top:12px;color:#d8edf5}.search{display:flex;align-items:center;gap:14px;max-width:760px;background:white;border-radius:8px;padding:10px 14px;color:#456}.search input{border:0;outline:0;width:100%;font:inherit}.layout{max-width:1440px;margin:auto;display:grid;grid-template-columns:260px 1fr;gap:30px;padding:28px 24px}nav{position:sticky;top:12px;height:calc(100vh - 24px);overflow:auto;background:white;padding:16px;border-radius:10px}nav section{margin:0 0 18px}nav h2{font-size:13px;color:#557;margin:6px 0}nav a{display:block;color:#286b91;text-decoration:none;font-size:13px;padding:3px 0}main{min-width:0}.detail{max-width:900px;background:#fff;padding:32px;margin:30px auto;border-radius:12px}.detail header{display:flex;gap:18px;align-items:center}.detail header img{width:64px;height:64px}.detail h1{font-size:28px}.toolbar{display:flex;align-items:center;justify-content:space-between}.toolbar h1{font-size:25px}.card{background:white;border:1px solid #dbe4ed;border-radius:10px;padding:18px;margin:0 0 14px;scroll-margin-top:16px}.card header{display:flex;gap:14px;align-items:center}.card header img{width:46px;height:46px;object-fit:contain}.card h2{margin:3px 0;font-size:19px}.card h2 a{color:#15577b;text-decoration:none}.card small{color:#527}.card p{color:#44576a;line-height:1.5}.card dl,.detail dl{display:grid;grid-template-columns:130px 1fr;gap:7px;margin:14px 0}.card dt,.detail dt{font-weight:600}.card dd,.detail dd{margin:0}table{border-collapse:collapse;width:100%;margin-top:10px}td,th{text-align:left;border-bottom:1px solid #e5ebf0;padding:7px}th{width:30%}footer{padding:24px;color:#596b7b;font-size:13px}@media(prefers-color-scheme:dark){:root{color:#e4ebf2;background:#111923}.card,nav,.detail{background:#1b2733;border-color:#354555}.card p,.card small,footer{color:#b0c0ce}nav a,.card h2 a{color:#70c7e9}table td,table th{border-color:#344556}.search{background:#f5f7fa}}@media(max-width:800px){.layout{grid-template-columns:1fr}nav{position:static;height:auto;display:grid;grid-template-columns:repeat(2,1fr);gap:0 14px}.hero{padding:24px}.toolbar h1{font-size:20px}.detail{margin:15px;padding:18px}}`);
fs.writeFileSync(path.join(out, 'search.js'), `const q=document.getElementById('q'),cards=[...document.querySelectorAll('.card')],count=document.getElementById('count'),empty=document.getElementById('empty');function filter(){const term=q.value.trim().toLocaleLowerCase('pt-BR');let n=0;for(const card of cards){const show=card.dataset.search.includes(term);card.hidden=!show;if(show)n++}count.textContent=n+' resultado(s)';empty.hidden=n!==0}q.addEventListener('input',filter);filter();`);
fs.writeFileSync(path.join(out, '404.html'), page);
console.log(`Help Center: ${visibleEntries.length} componentes, ${categories.length} categorias em ${out}`);
