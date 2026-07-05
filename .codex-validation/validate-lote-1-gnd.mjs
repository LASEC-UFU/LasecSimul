import fs from 'node:fs';
import { componentBox, pinLocalPosition, packageSymbolSvg, registerPackage } from '../extension/out-webview/componentSymbols.js';
const cat = JSON.parse(fs.readFileSync('project/schema/component-catalog.json', 'utf8'));
const g = cat.items.find((i) => i.typeId === 'other.ground');
registerPackage('other.ground', g.package);
const box = componentBox('other.ground');
const pin = pinLocalPosition('pin', 0, 1, 'other.ground');
const svg = packageSymbolSvg('other.ground', {}, 'gnd-validation') ?? '';
console.log(JSON.stringify({
  box,
  pin,
  hasTopBar: svg.includes('1.4') && svg.includes('14.6'),
  hasStroke25: svg.includes('2.5'),
  hasZeroLengthLead: svg.includes('x1="8.0" y1="0.0" x2="8.0" y2="0.0"'),
  hasText: svg.includes('<text'),
  svg,
}, null, 2));
