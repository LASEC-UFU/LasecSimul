// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright © 2026 Praharsh Nagpure — IPD Studio. Noncommercial use only;
// commercial use requires a paid license (see COMMERCIAL-LICENSE.md).

import type { SymbolDef } from '../types'

const S = 1.5
const path = (d: string, fill = 'none') =>
  `<path d="${d}" fill="${fill}" stroke="currentColor" stroke-width="${S}" stroke-linejoin="round"/>`
const text = (x: number, y: number, t: string, size = 8) =>
  `<text x="${x}" y="${y}" font-size="${size}" font-family="sans-serif" text-anchor="middle" fill="currentColor" stroke="none">${t}</text>`

function inline(
  id: string,
  name: string,
  w: number,
  h: number,
  y: number,
  render: SymbolDef['render'],
  keywords: string[],
  tagRule: SymbolDef['tagRule'] = 'none',
): SymbolDef {
  return {
    id,
    name,
    category: 'inline',
    gridSize: { w: w / 8, h: h / 8 },
    render,
    ports: [
      { id: 'w', x: 0, y, kind: 'process' },
      { id: 'e', x: w, y, kind: 'process' },
    ],
    tagRule,
    keywords,
  }
}

export const inlineItems: SymbolDef[] = [
  inline('strainer.y', 'Y-Strainer', 32, 24, 4,
    () => path('M0 4 H32') + path('M12 4 L20 20 L28 12'),
    ['strainer', 'y-strainer', 'filter']),

  {
    id: 'filter.cartridge',
    name: 'Filter',
    category: 'inline',
    gridSize: { w: 4, h: 6 },
    render: () =>
      path('M4 4 h24 v40 h-24 Z') +
      `<path d="M16 8 V40" fill="none" stroke="currentColor" stroke-width="${S}" stroke-dasharray="2 2"/>`,
    ports: [
      { id: 'n', x: 16, y: 4, kind: 'process' },
      { id: 's', x: 16, y: 44, kind: 'process' },
    ],
    tagRule: 'equipment',
    keywords: ['filter', 'cartridge', 'bag'],
  },

  inline('fit.reducer', 'Reducer', 24, 16, 8,
    () => path('M0 0 L24 4 V12 L0 16 Z'),
    ['reducer', 'expander', 'concentric']),

  inline('fit.flanges', 'Flange Pair', 16, 16, 8,
    () => path('M0 8 H16') + path('M6 0 V16 M10 0 V16'),
    ['flange', 'joint', 'breakout']),

  inline('fit.spectacle', 'Spectacle Blind', 24, 16, 8,
    () =>
      `<circle cx="6" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="${S}"/>` +
      `<circle cx="18" cy="8" r="5" fill="currentColor" stroke="currentColor" stroke-width="${S}"/>` +
      path('M0 8 H1 M23 8 H24'),
    ['spectacle', 'blind', 'spade', 'spacer']),

  inline('fit.steam-trap', 'Steam Trap', 24, 24, 12,
    () =>
      `<circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="${S}"/>` +
      text(12, 16, 'T', 10) +
      path('M0 12 H2 M22 12 H24'),
    ['steam trap', 'trap', 'condensate']),

  {
    id: 'fit.sample',
    name: 'Sample Point',
    category: 'inline',
    gridSize: { w: 2, h: 3 },
    render: () =>
      path('M8 0 V8') +
      path('M2 8 L2 16 L8 12 Z M14 8 L14 16 L8 12 Z') +
      text(8, 24, 'SP'),
    ports: [{ id: 'n', x: 8, y: 0, kind: 'process' }],
    tagRule: 'none',
    keywords: ['sample', 'sp', 'sampling'],
  },

  {
    id: 'fit.drain',
    name: 'Drain',
    category: 'inline',
    gridSize: { w: 2, h: 2 },
    render: () => path('M8 0 V6') + path('M2 6 H14 M2 6 L8 14 L14 6'),
    ports: [{ id: 'n', x: 8, y: 0, kind: 'process' }],
    tagRule: 'none',
    keywords: ['drain', 'low point'],
  },

  {
    id: 'fit.vent',
    name: 'Vent',
    category: 'inline',
    gridSize: { w: 2, h: 2 },
    render: () => path('M8 16 V10') + path('M2 10 H14 M2 10 L8 2 L14 10'),
    ports: [{ id: 's', x: 8, y: 16, kind: 'process' }],
    tagRule: 'none',
    keywords: ['vent', 'atmosphere', 'high point'],
  },

  inline('fit.specbreak', 'Spec Break', 16, 24, 12,
    () => path('M2 20 L8 4 M8 20 L14 4'),
    ['spec break', 'specification', 'class change']),
]

const circle3 = (cx: number, cy: number, r: number) =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="currentColor" stroke-width="1.5"/>`
const path3 = (d: string) =>
  `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>`

export const inlineItems2: SymbolDef[] = [
  inline('strainer.basket', 'Basket Strainer', 32, 24, 4,
    () => path3('M0 4 H32') + path3('M12 4 V14 a4 4 0 0 0 8 0 V4') + path3('M13 10 h6 M13 14 h6'),
    ['strainer', 'basket']),
  inline('strainer.cone', 'Temporary Cone Strainer', 32, 24, 4,
    () => path3('M0 4 H32') + path3('M16 4 L10 18 M16 4 L22 18 M10 18 H22'),
    ['strainer', 'cone', 'witch hat', 'temporary']),
  {
    id: 'centrifuge',
    name: 'Centrifuge',
    category: 'inline',
    gridSize: { w: 6, h: 5 },
    render: () => path3('M8 8 L40 8 L34 32 L14 32 Z') + path3('M24 0 V8') + path3('M10 0 h28'),
    ports: [
      { id: 'n', x: 24, y: 0, kind: 'process' },
      { id: 's', x: 24, y: 32, kind: 'process' },
      { id: 'e', x: 40, y: 20, kind: 'process' },
    ],
    tagRule: 'equipment',
    keywords: ['centrifuge', 'separator', 'solids'],
  },
  {
    id: 'scrubber',
    name: 'Scrubber',
    category: 'inline',
    gridSize: { w: 5, h: 10 },
    render: () =>
      path3('M4 16 a16 12 0 0 1 32 0 V64 a16 12 0 0 1 -32 0 Z') +
      path3('M4 32 H36 M4 44 H36 M8 34 L14 42 M18 34 L24 42 M28 34 L34 42'),
    ports: [
      { id: 'n', x: 20, y: 4, kind: 'process' },
      { id: 'w', x: 4, y: 56, kind: 'process' },
      { id: 's', x: 20, y: 76, kind: 'process' },
    ],
    tagRule: 'equipment',
    keywords: ['scrubber', 'absorber', 'gas cleaning'],
  },
  inline('demister', 'Demister Pad', 32, 16, 8,
    () => path3('M0 8 H32') + path3('M4 2 h24 v12 h-24 Z') + path3('M6 2 L12 14 M14 2 L20 14 M22 2 L28 14 M28 2 L22 14 M20 2 L14 14 M12 2 L6 14'),
    ['demister', 'mist eliminator', 'pad']),
  inline('mixer.static', 'Static Mixer', 40, 16, 8,
    () => path3('M0 0 h40 v16 h-40 Z') + path3('M4 2 L36 14 M4 14 L36 2'),
    ['static mixer', 'inline mixer']),
  inline('fit.reducer-ecc', 'Eccentric Reducer', 24, 16, 8,
    () => path3('M0 0 L24 8 V16 H0 Z'),
    ['reducer', 'eccentric', 'flat bottom']),
  inline('fit.blind', 'Blind Flange', 16, 16, 8,
    () => path3('M0 8 H10') + path3('M10 0 V16 M14 2 V14'),
    ['blind', 'flange', 'end cap']),
  inline('fit.spade', 'Spade / Spacer', 24, 24, 12,
    () => path3('M0 12 H24') + `<circle cx="12" cy="12" r="5" fill="currentColor" stroke="currentColor" stroke-width="1.5"/>` + path3('M12 7 V0'),
    ['spade', 'spacer', 'blind']),
  inline('fit.hose', 'Hose', 32, 16, 8,
    () => path3('M0 8 q4 -6 8 0 q4 6 8 0 q4 -6 8 0 q4 6 8 0'),
    ['hose', 'flexible']),
  inline('fit.expansion', 'Expansion Joint', 24, 16, 8,
    () => path3('M0 8 H4 M20 8 H24') + path3('M4 2 h16 v12 h-16 Z') + path3('M8 2 V14 M12 2 V14 M16 2 V14'),
    ['expansion', 'bellows', 'joint']),
  inline('fit.sightglass', 'Sight Glass', 24, 16, 8,
    () => path3('M0 8 H4 M20 8 H24') + circle3(12, 8, 7) + path3('M4 0 V16 M20 0 V16'),
    ['sight glass', 'flow indicator']),
  {
    id: 'fit.silencer',
    name: 'Silencer',
    category: 'inline',
    gridSize: { w: 2, h: 4 },
    render: () => path3('M8 32 V28') + path3('M2 4 h12 v24 h-12 Z') + path3('M2 10 L14 4 M2 18 L14 12 M2 26 L14 20'),
    ports: [{ id: 's', x: 8, y: 32, kind: 'process' }],
    tagRule: 'none',
    keywords: ['silencer', 'vent', 'muffler'],
  },
  {
    id: 'fit.quill',
    name: 'Injection Quill',
    category: 'inline',
    gridSize: { w: 2, h: 3 },
    render: () => path3('M8 0 V14') + path3('M5 14 L8 22 L11 14 Z') + path3('M4 4 h8'),
    ports: [{ id: 'n', x: 8, y: 0, kind: 'process' }],
    tagRule: 'none',
    keywords: ['quill', 'injection', 'dosing point', 'spray'],
  },
]
