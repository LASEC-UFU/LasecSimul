import fs from 'node:fs';
import { componentBox, hasRealPinPosition, packageSymbolSvg, pinLocalPosition, registerPackage } from '../extension/out-webview/componentSymbols.js';
const cat = JSON.parse(fs.readFileSync('project/schema/component-catalog.json', 'utf8'));
const fixed = cat.items.find((i) => i.typeId === 'sources.fixed_volt');
registerPackage('sources.fixed_volt', fixed.package);
const box = componentBox('sources.fixed_volt');
const pinOut = pinLocalPosition('out', 0, 1, 'sources.fixed_volt');
const pinPin = pinLocalPosition('pin', 0, 1, 'sources.fixed_volt');
const pinLegacy = pinLocalPosition('pin-1', 0, 1, 'sources.fixed_volt');
const svgOn = packageSymbolSvg('sources.fixed_volt', { out: true }, 'fixed-on') ?? '';
const svgOff = packageSymbolSvg('sources.fixed_volt', { out: false }, 'fixed-off') ?? '';
console.log(JSON.stringify({
  box,
  pinOut,
  pinPin,
  pinLegacy,
  hasLead: svgOn.includes('x1="20"') && svgOn.includes('x2="28"'),
  onFill: svgOn.includes('fill="#ffa600"'),
  offFill: svgOff.includes('fill="#e6e6ff"'),
  hasZeroLengthLead: svgOn.includes('x1="28.0" y1="12.0" x2="28.0" y2="12.0"'),
  hasText: svgOn.includes('<text'),
  aliasPin: hasRealPinPosition('sources.fixed_volt', 'pin'),
  aliasPin1: hasRealPinPosition('sources.fixed_volt', 'pin-1'),
  svgOn,
  svgOff,
}, null, 2));
