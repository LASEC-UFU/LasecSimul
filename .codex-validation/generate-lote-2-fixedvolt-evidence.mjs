import fs from 'node:fs';
import { componentBox, hasRealPinPosition, packageSymbolSvg, pinLocalPosition, registerPackage } from '../extension/out-webview/componentSymbols.js';
const cat = JSON.parse(fs.readFileSync('project/schema/component-catalog.json', 'utf8'));
const fixed = cat.items.find((item) => item.typeId === 'sources.fixed_volt');
registerPackage('sources.fixed_volt', fixed.package);
const box = componentBox('sources.fixed_volt');
const pinOut = pinLocalPosition('out', 0, 1, 'sources.fixed_volt');
const pinLegacy = pinLocalPosition('pin-1', 0, 1, 'sources.fixed_volt');
const on = packageSymbolSvg('sources.fixed_volt', { out: true }, 'fixed-on') ?? '';
const off = packageSymbolSvg('sources.fixed_volt', { out: false }, 'fixed-off') ?? '';
const referenceOn = '<line x1="20" y1="12" x2="28" y2="12" stroke="#000" stroke-width="3" stroke-linecap="round"/><rect x="4" y="4" width="16" height="16" rx="2" ry="2" stroke="#000" fill="#ffa600" stroke-width="1.5"/>';
const referenceOff = '<line x1="20" y1="12" x2="28" y2="12" stroke="#000" stroke-width="3" stroke-linecap="round"/><rect x="4" y="4" width="16" height="16" rx="2" ry="2" stroke="#000" fill="#e6e6ff" stroke-width="1.5"/>';
const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Lote 2 - FixedVolt</title>
<style>
body{font-family:Segoe UI,Arial,sans-serif;background:#f8f8e8;color:#111;margin:24px}.wrap{display:grid;grid-template-columns:repeat(2, minmax(260px,1fr));gap:24px}.panel{background:white;border:1px solid #ccc;padding:16px}.grid{background-image:linear-gradient(#d7d7c7 1px,transparent 1px),linear-gradient(90deg,#d7d7c7 1px,transparent 1px);background-size:8px 8px;width:180px;height:120px;display:grid;place-items:center}svg{width:140px;height:120px;overflow:visible}.meta{margin-top:16px;font-family:Consolas,monospace;font-size:13px;white-space:pre-wrap}.ok{color:#126b2f;font-weight:700}
</style></head><body>
<h1>Lote 2 - FixedVolt</h1>
<p>Referencia traduzida de <code>src/components/sources/fixedvolt.cpp</code> contra a saida real do renderer compilado.</p>
<div class="wrap">
<section class="panel"><h2>Referencia SimulIDE out=true</h2><div class="grid"><svg viewBox="0 0 28 24">${referenceOn}</svg></div></section>
<section class="panel"><h2>LasecSimul out=true</h2><div class="grid"><svg viewBox="0 0 ${box.width} ${box.height}">${on}</svg></div></section>
<section class="panel"><h2>Referencia SimulIDE out=false</h2><div class="grid"><svg viewBox="0 0 28 24">${referenceOff}</svg></div></section>
<section class="panel"><h2>LasecSimul out=false</h2><div class="grid"><svg viewBox="0 0 ${box.width} ${box.height}">${off}</svg></div></section>
</div>
<div class="meta">box=${JSON.stringify(box)}\npinOut=${JSON.stringify(pinOut)}\npinLegacy=${JSON.stringify(pinLegacy)}\nchecks={onFill:${on.includes('#ffa600')}, offFill:${off.includes('#e6e6ff')}, aliasPin:${hasRealPinPosition('sources.fixed_volt','pin-1')}}</div>
<p class="ok">Arquivo gerado para auditoria manual.</p>
</body></html>`;
fs.writeFileSync('.codex-validation/lote-2-fixedvolt-evidence.html', html, 'utf8');
console.log('.codex-validation/lote-2-fixedvolt-evidence.html');
