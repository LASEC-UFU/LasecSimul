import fs from 'node:fs';
import { componentBox, pinLocalPosition, packageSymbolSvg, registerPackage } from '../extension/out-webview/componentSymbols.js';
const cat = JSON.parse(fs.readFileSync('project/schema/component-catalog.json', 'utf8'));
const g = cat.items.find((item) => item.typeId === 'other.ground');
registerPackage('other.ground', g.package);
const box = componentBox('other.ground');
const pin = pinLocalPosition('pin', 0, 1, 'other.ground');
const actual = packageSymbolSvg('other.ground', {}, 'lote-1-gnd') ?? '';
const reference = '<line x1="8" y1="0" x2="8" y2="8" stroke="#000" stroke-width="3" stroke-linecap="round"/><line x1="1.4" y1="8" x2="14.6" y2="8" stroke="#000" stroke-width="2.5" stroke-linecap="round"/><line x1="3.7" y1="12" x2="12.3" y2="12" stroke="#000" stroke-width="2.5"/><line x1="6.1" y1="16" x2="9.9" y2="16" stroke="#000" stroke-width="2.5"/>';
const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Lote 1 - GND</title>
<style>
body{font-family:Segoe UI,Arial,sans-serif;background:#f8f8e8;color:#111;margin:24px}.wrap{display:flex;gap:32px;align-items:flex-start}.panel{background:white;border:1px solid #ccc;padding:16px}.grid{background-image:linear-gradient(#d7d7c7 1px,transparent 1px),linear-gradient(90deg,#d7d7c7 1px,transparent 1px);background-size:8px 8px;width:160px;height:160px;display:grid;place-items:center}svg{width:96px;height:108px;overflow:visible}.meta{margin-top:16px;font-family:Consolas,monospace;font-size:13px;white-space:pre-wrap}.ok{color:#126b2f;font-weight:700}
</style></head><body>
<h1>Lote 1 - GND</h1>
<p>Comparacao visual: referencia SimulIDE traduzida de <code>src/components/sources/ground.cpp</code> e saida real do renderer compilado do LasecSimul.</p>
<div class="wrap">
<section class="panel"><h2>Referencia SimulIDE</h2><div class="grid"><svg viewBox="0 0 16 18">${reference}</svg></div></section>
<section class="panel"><h2>LasecSimul renderer</h2><div class="grid"><svg viewBox="0 0 ${box.width} ${box.height}">${actual}</svg></div></section>
</div>
<div class="meta">box=${JSON.stringify(box)}\npin=${JSON.stringify(pin)}\nchecks={topBar:${actual.includes('1.4') && actual.includes('14.6')}, stroke2_5:${actual.includes('2.5')}, noPinLabel:${!actual.includes('>pin<')}}</div>
<p class="ok">Arquivo gerado para auditoria manual.</p>
</body></html>`;
fs.writeFileSync('.codex-validation/lote-1-gnd-evidence.html', html, 'utf8');
console.log('.codex-validation/lote-1-gnd-evidence.html');
