const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lasecsimul-help-'));
const fixture = path.join(fixtureDir, 'catalog.json');
const icon = path.join(fixtureDir, 'symbol.svg');
function generate(items) {
  fs.writeFileSync(fixture, JSON.stringify(items));
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-help-center.cjs')], { cwd: root, env: { ...process.env, HELP_CATALOG_FIXTURE: fixture }, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}
function check(value, message) { if (!value) throw new Error(message); }
try {
  const base = { typeId: 'test.sensor', label: 'Sensor Teste', category: 'Instrumentação', folderPath: ['Instrumentação', 'Teste'], icon: 'test', iconFilePath: icon, pinCount: 1, pinIds: ['out'], defaultProperties: { range: 10 }, propertySchema: [], help: { description: 'Mede pressão no processo.' }, package: { pins: [{ id: 'out', kind: 'ANALOG_OUT', label: 'OUT' }] } };
  fs.writeFileSync(icon, '<svg>v1</svg>');
  generate([base]);
  let html = fs.readFileSync(path.join(root, 'site', 'components', 'test-sensor.html'), 'utf8');
  check(html.includes('range') && html.includes('out'), 'parâmetros e portas não foram extraídos');
  check(fs.readFileSync(path.join(root, 'site', 'assets', 'test-sensor.svg'), 'utf8').includes('v1'), 'ícone original não foi sincronizado');
  check(fs.readFileSync(path.join(root, 'site', 'index.html'), 'utf8').includes('pressão no processo'), 'descrição técnica não entrou no índice pesquisável');
  generate([{ ...base, help: undefined }]);
  const checker = spawnSync(process.execPath, [path.join(root, 'scripts', 'check-help-center.cjs')], { cwd: root, encoding: 'utf8' });
  check(checker.status === 0, `verificador recusou a página de fixture: ${checker.stderr || checker.stdout}`);
  const coverage = JSON.parse(fs.readFileSync(path.join(root, 'site', 'coverage.json'), 'utf8'));
  check(coverage.incomplete.includes('test.sensor') && coverage.withExamples === 0, 'lacunas de conteúdo não foram marcadas no relatório');
  fs.writeFileSync(icon, '<svg>v2</svg>');
  generate([{ ...base, label: 'Sensor Novo', pinIds: ['out', 'alarm'], pinCount: 2, package: { pins: [{ id: 'out', kind: 'ANALOG_OUT' }, { id: 'alarm', kind: 'DIGITAL_OUT' }] }, defaultProperties: { range: 20, enabled: true } }]);
  html = fs.readFileSync(path.join(root, 'site', 'components', 'test-sensor.html'), 'utf8');
  check(html.includes('enabled') && html.includes('alarm'), 'mudanças em propriedades/portas não foram refletidas');
  check(fs.readFileSync(path.join(root, 'site', 'assets', 'test-sensor.svg'), 'utf8').includes('v2'), 'alteração do ícone não foi sincronizada');
  generate([]);
  check(!fs.existsSync(path.join(root, 'site', 'components', 'test-sensor.html')), 'componente removido permaneceu publicado');
  console.log('Help Center fixture: descoberta, propriedades, portas, sincronização de ícone e remoção validados.');
} finally {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
  const restore = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-help-center.cjs')], { cwd: root, env: { ...process.env, HELP_CATALOG_FIXTURE: '' }, encoding: 'utf8' });
  if (restore.status !== 0) throw new Error(restore.stderr || restore.stdout);
}
