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
  check(html.includes('range') && html.includes('out') && html.includes('Como usar este elemento') && html.includes('Parametros e edicao'), 'parametros, portas ou explicacao de uso ausentes');
  check(fs.readFileSync(path.join(root, 'site', 'assets', 'test-sensor.svg'), 'utf8').includes('v1'), 'ícone original não foi sincronizado');
  check(fs.readFileSync(path.join(root, 'site', 'index.html'), 'utf8').includes('pressão no processo'), 'descrição técnica não entrou no índice pesquisável');
  const codeIndex = fs.readFileSync(path.join(root, 'site', 'code-examples.html'), 'utf8');
  check(codeIndex.includes('esp32-wifi-transparent/src/main.cpp') && codeIndex.includes('fpga-vhdl-counter/counter.vhd'), 'a lista de exemplos não incluiu os exemplos de firmware e FPGA');
  const introduction = fs.readFileSync(path.join(root, 'site', 'introduction.html'), 'utf8');
  check(introduction.includes('Eletrônica analógica') && introduction.includes('PLC IEC 61131-3') && introduction.includes('ESP32 e firmware emulado') && introduction.includes('id="core-runtime"') && introduction.includes('N\u00e3o s\u00e3o dois produtos que precisam ser integrados'), 'introducao detalhada ou modelo comum HMI/Laboratorio ausente');
  const wifiPage = fs.readFileSync(path.join(root, 'site', 'code-examples', 'esp32-wifi-transparent-src-main-cpp.html'), 'utf8');
  check(wifiPage.includes('WiFi.begin') && wifiPage.includes('Baixar arquivo original'), 'o código do exemplo não foi exibido nem disponibilizado para download');
  generate([{ ...base, help: undefined }]);
  const checker = spawnSync(process.execPath, [path.join(root, 'scripts', 'check-help-center.cjs')], { cwd: root, encoding: 'utf8' });
  check(checker.status === 0, `verificador recusou a página de fixture: ${checker.stderr || checker.stdout}`);
  const coverage = JSON.parse(fs.readFileSync(path.join(root, 'site', 'coverage.json'), 'utf8'));
  check(coverage.withDescription === 1 && coverage.incomplete.length === 0 && coverage.withExamples === 0, 'fallback description or no-example coverage was not recorded');
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
