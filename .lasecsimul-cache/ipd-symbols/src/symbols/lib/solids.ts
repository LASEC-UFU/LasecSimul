// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright © 2026 Praharsh Nagpure — IPD Studio. Noncommercial use only;
// commercial use requires a paid license (see COMMERCIAL-LICENSE.md).

import type { SymbolDef } from '../types'

const S = 1.5
const path = (d: string, fill = 'none') =>
  `<path d="${d}" fill="${fill}" stroke="currentColor" stroke-width="${S}" stroke-linejoin="round"/>`
const circle = (cx: number, cy: number, r: number) =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="currentColor" stroke-width="${S}"/>`

const eq = (
  id: string,
  name: string,
  gw: number,
  gh: number,
  render: SymbolDef['render'],
  ports: SymbolDef['ports'],
  keywords: string[],
): SymbolDef => ({ id, name, category: 'inline', gridSize: { w: gw, h: gh }, render, ports, tagRule: 'equipment', keywords })

export const solids: SymbolDef[] = [
  eq('conveyor.belt', 'Belt Conveyor', 10, 2,
    () => circle(8, 8, 6) + circle(72, 8, 6) + path('M8 2 H72 M8 14 H72'),
    [{ id: 'w', x: 0, y: 8, kind: 'process' }, { id: 'e', x: 80, y: 8, kind: 'process' }],
    ['conveyor', 'belt', 'solids']),

  eq('conveyor.screw', 'Screw Conveyor', 10, 2,
    () => path('M0 0 h80 v16 h-80 Z') + path('M4 14 L12 2 L20 14 L28 2 L36 14 L44 2 L52 14 L60 2 L68 14 L76 2'),
    [{ id: 'w', x: 0, y: 8, kind: 'process' }, { id: 'e', x: 80, y: 8, kind: 'process' }],
    ['screw', 'conveyor', 'auger']),

  eq('bucket-elevator', 'Bucket Elevator', 3, 10,
    () => path('M0 8 h24 v64 h-24 Z') + circle(12, 12, 6) + circle(12, 68, 6) + path('M6 28 h4 M14 40 h4 M6 52 h4'),
    [{ id: 's', x: 12, y: 80, kind: 'process' }, { id: 'n', x: 12, y: 8, kind: 'process' }],
    ['bucket', 'elevator', 'vertical']),

  eq('feeder.rotary', 'Rotary Feeder', 4, 4,
    () => path('M0 0 h32 v32 h-32 Z') + circle(16, 16, 11) + path('M16 5 V27 M5 16 H27 M8 8 L24 24 M24 8 L8 24'),
    [{ id: 'n', x: 16, y: 0, kind: 'process' }, { id: 's', x: 16, y: 32, kind: 'process' }],
    ['rotary', 'feeder', 'airlock', 'valve']),

  eq('crusher', 'Crusher / Mill', 6, 5,
    () => path('M0 0 h48 v12 L32 40 H16 L0 12 Z') + circle(18, 14, 6) + circle(30, 14, 6),
    [{ id: 'n', x: 24, y: 0, kind: 'process' }, { id: 's', x: 24, y: 40, kind: 'process' }],
    ['crusher', 'mill', 'grinder']),

  eq('screen.vibrating', 'Vibrating Screen', 8, 5,
    () =>
      path('M0 8 L64 0 L64 12 L0 20 Z') +
      path('M8 10 L14 8 M24 8 L30 6 M40 6 L46 4') +
      path('M8 24 l4 -4 l4 4 l4 -4 M40 24 l4 -4 l4 4 l4 -4') +
      path('M12 20 V24 M48 18 V24'),
    [{ id: 'n', x: 32, y: 0, kind: 'process' }, { id: 's1', x: 56, y: 12, kind: 'process' }, { id: 's2', x: 8, y: 24, kind: 'process' }],
    ['screen', 'vibrating', 'sieve']),

  eq('clarifier', 'Clarifier / Thickener', 10, 4,
    () => path('M0 0 H80 L64 24 H16 Z') + path('M40 0 V18 M28 18 H52') + path('M40 24 V32'),
    [{ id: 'w', x: 0, y: 0, kind: 'process' }, { id: 'e', x: 80, y: 0, kind: 'process' }, { id: 's', x: 40, y: 32, kind: 'process' }],
    ['clarifier', 'thickener', 'settler']),

  eq('filter.press', 'Filter Press', 8, 4,
    () => path('M0 4 h64 v24 h-64 Z') + path('M12 4 V28 M20 4 V28 M28 4 V28 M36 4 V28 M44 4 V28 M52 4 V28'),
    [{ id: 'w', x: 0, y: 16, kind: 'process' }, { id: 's', x: 32, y: 32, kind: 'process' }],
    ['filter press', 'plate and frame']),

  eq('filter.rotary', 'Rotary Drum Filter', 8, 6,
    () => path('M0 32 h64 v16 h-64 Z') + circle(32, 24, 20) + path('M50 10 L58 4'),
    [{ id: 'w', x: 0, y: 40, kind: 'process' }, { id: 'e', x: 64, y: 24, kind: 'process' }, { id: 's', x: 32, y: 48, kind: 'process' }],
    ['rotary drum', 'vacuum filter']),

  eq('dryer.rotary', 'Rotary Dryer', 12, 3,
    () => path('M0 2 L96 8 L96 24 L0 18 Z') + circle(24, 22, 4) + circle(72, 26, 4),
    [{ id: 'w', x: 0, y: 8, kind: 'process' }, { id: 'e', x: 96, y: 16, kind: 'process' }],
    ['rotary dryer', 'kiln']),

  eq('dryer.spray', 'Spray Dryer', 8, 9,
    () => path('M8 0 h48 v24 L36 72 H28 L8 24 Z') + path('M32 0 V8 M28 8 L32 14 L36 8') + path('M56 12 H64'),
    [{ id: 'n', x: 32, y: 0, kind: 'process' }, { id: 'e', x: 64, y: 12, kind: 'process' }, { id: 's', x: 32, y: 72, kind: 'process' }],
    ['spray dryer', 'atomizer']),

  eq('dryer.tray', 'Tray Dryer', 6, 6,
    () => path('M0 0 h48 v48 h-48 Z') + path('M6 12 H42 M6 22 H42 M6 32 H42 M6 42 H42') + path('M0 0 L10 10'),
    [{ id: 'w', x: 0, y: 24, kind: 'process' }, { id: 'e', x: 48, y: 24, kind: 'process' }],
    ['tray dryer', 'oven', 'batch']),

  eq('evaporator', 'Evaporator', 6, 10,
    () =>
      path('M8 16 a16 12 0 0 1 32 0 V64 a16 12 0 0 1 -32 0 Z') +
      path('M8 36 H40 M8 48 H40 M14 36 V48 M22 36 V48 M30 36 V48 M38 36 V48'),
    [{ id: 'w', x: 8, y: 56, kind: 'process' }, { id: 'n', x: 24, y: 4, kind: 'process' }, { id: 's', x: 24, y: 76, kind: 'process' }],
    ['evaporator', 'calandria', 'concentration']),

  eq('crystallizer', 'Crystallizer', 6, 10,
    () =>
      path('M8 16 a16 12 0 0 1 32 0 V64 a16 12 0 0 1 -32 0 Z') +
      path('M18 24 h12 v28 h-12 Z') + path('M24 8 V24') + path('M20 56 L24 50 L28 56'),
    [{ id: 'e', x: 40, y: 32, kind: 'process' }, { id: 's', x: 24, y: 76, kind: 'process' }, { id: 'n', x: 24, y: 4, kind: 'signal' }],
    ['crystallizer', 'draft tube']),

  eq('bagfilter', 'Bag House', 6, 8,
    () => path('M0 0 h48 v40 L24 64 L0 40 Z') + path('M12 6 V32 M24 6 V32 M36 6 V32'),
    [{ id: 'w', x: 0, y: 20, kind: 'process' }, { id: 'n', x: 24, y: 0, kind: 'process' }, { id: 's', x: 24, y: 64, kind: 'process' }],
    ['bag house', 'dust collector', 'fabric filter']),

  eq('coalescer', 'Coalescer', 10, 5,
    () =>
      path('M16 4 H64 a10 14 0 0 1 0 28 H16 a10 14 0 0 1 0 -28 Z') +
      path('M28 4 V32 M32 4 V32 M48 4 V32 M52 4 V32'),
    [{ id: 'w', x: 4, y: 16, kind: 'process' }, { id: 'e', x: 76, y: 16, kind: 'process' }, { id: 's', x: 40, y: 32, kind: 'process' }],
    ['coalescer', 'separator']),

  eq('hydrocyclone', 'Hydrocyclone', 3, 5,
    () => path('M2 4 h20 v6 L12 40 L2 10 Z') + path('M12 4 V0') + path('M0 0 h8 v4 h-8 Z'),
    [{ id: 'w', x: 0, y: 0, kind: 'process' }, { id: 'n', x: 12, y: 0, kind: 'process' }, { id: 's', x: 12, y: 40, kind: 'process' }],
    ['hydrocyclone', 'cyclone', 'liquid']),

  eq('mill.ball', 'Ball Mill', 8, 4,
    () => path('M8 0 H56 a8 16 0 0 1 0 32 H8 a8 16 0 0 1 0 -32 Z') + circle(16, 32, 3) + circle(48, 32, 3),
    [{ id: 'w', x: 0, y: 16, kind: 'process' }, { id: 'e', x: 64, y: 16, kind: 'process' }],
    ['ball mill', 'grinding']),

  eq('extruder', 'Extruder', 9, 4,
    () => path('M0 8 L56 12 L72 14 L72 22 L56 24 L0 28 Z') + path('M12 8 V0 M4 0 h16') + path('M8 18 L48 18'),
    [{ id: 'n', x: 12, y: 0, kind: 'process' }, { id: 'e', x: 72, y: 16, kind: 'process' }],
    ['extruder', 'screw', 'polymer']),

  eq('blender.ribbon', 'Ribbon Blender', 7, 4,
    () => path('M0 0 V20 a28 12 0 0 0 56 0 V0') + path('M8 16 Q28 28 48 16 M8 22 Q28 10 48 22'),
    [{ id: 'n', x: 28, y: 0, kind: 'process' }, { id: 's', x: 28, y: 32, kind: 'process' }],
    ['ribbon blender', 'mixer', 'powder']),
]
