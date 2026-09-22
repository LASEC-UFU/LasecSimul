// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright © 2026 Praharsh Nagpure — IPD Studio. Noncommercial use only;
// commercial use requires a paid license (see COMMERCIAL-LICENSE.md).

import type { SymbolDef } from '../types'

const S = 1.5
const path = (d: string, fill = 'none') =>
  `<path d="${d}" fill="${fill}" stroke="currentColor" stroke-width="${S}" stroke-linejoin="round"/>`

export const accessories: SymbolDef[] = [
  {
    id: 'acc.thermowell',
    name: 'Thermowell',
    category: 'accessories',
    gridSize: { w: 2, h: 3 },
    render: () => path('M4 0 H12') + path('M8 0 V16') + path('M6 16 L8 22 L10 16 Z'),
    ports: [{ id: 'n', x: 8, y: 0, kind: 'both' }],
    tagRule: 'isa-instrument',
    keywords: ['thermowell', 'temperature', 'well', 'tw'],
  },
  {
    id: 'acc.pg',
    name: 'Pressure Gauge',
    category: 'accessories',
    gridSize: { w: 2, h: 3 },
    render: () =>
      `<circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="${S}"/>` +
      path('M8 8 L12 4') +
      path('M8 15 V24'),
    ports: [{ id: 's', x: 8, y: 24, kind: 'process' }],
    tagRule: 'isa-instrument',
    keywords: ['gauge', 'pressure', 'dial', 'pg', 'pi'],
  },
  {
    id: 'acc.lg',
    name: 'Gauge Glass',
    category: 'accessories',
    gridSize: { w: 2, h: 5 },
    render: () => path('M0 8 H6 M0 32 H6') + path('M6 4 h4 v32 h-4 Z'),
    ports: [
      { id: 'w1', x: 0, y: 8, kind: 'process' },
      { id: 'w2', x: 0, y: 32, kind: 'process' },
    ],
    tagRule: 'isa-instrument',
    keywords: ['gauge glass', 'level', 'sight', 'lg'],
  },
]

const circle2 = (cx: number, cy: number, r: number) =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="currentColor" stroke-width="1.5"/>`
const path2 = (d: string) =>
  `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>`
const text2 = (x: number, y: number, t: string) =>
  `<text x="${x}" y="${y}" font-size="8" font-family="sans-serif" text-anchor="middle" fill="currentColor" stroke="none">${t}</text>`

export const accessories2: SymbolDef[] = [
  {
    id: 'acc.bulb',
    name: 'Filled Bulb + Capillary',
    category: 'accessories',
    gridSize: { w: 4, h: 3 },
    render: () => circle2(6, 16, 6) + path2('M12 14 q4 4 8 0 q4 -4 8 0 q2 2 4 0'),
    ports: [{ id: 'e', x: 32, y: 12, kind: 'both' }],
    tagRule: 'isa-instrument',
    keywords: ['bulb', 'capillary', 'filled system'],
  },
  {
    id: 'acc.bimetal',
    name: 'Bimetal Thermometer',
    category: 'accessories',
    gridSize: { w: 2, h: 3 },
    render: () =>
      circle2(8, 8, 7) + path2('M8 8 L11 4') +
      path2('M8 15 V20') + path2('M5 20 a3 3 0 1 0 6 0 a2 2 0 1 0 -4 0'),
    ports: [{ id: 's', x: 8, y: 24, kind: 'process' }],
    tagRule: 'isa-instrument',
    keywords: ['bimetal', 'thermometer', 'dial'],
  },
  {
    id: 'acc.seal',
    name: 'Diaphragm Seal',
    category: 'accessories',
    gridSize: { w: 2, h: 2 },
    render: () => path2('M2 0 V16 M14 0 V16') + path2('M2 8 Q8 4 14 8'),
    ports: [
      { id: 'w', x: 0, y: 8, kind: 'process' },
      { id: 'e', x: 16, y: 8, kind: 'both' },
    ],
    tagRule: 'none',
    keywords: ['diaphragm', 'seal', 'chemical seal'],
  },
  {
    id: 'acc.floatcage',
    name: 'External Float Cage',
    category: 'accessories',
    gridSize: { w: 3, h: 5 },
    render: () =>
      path2('M4 4 h16 v32 h-16 Z') + circle2(12, 20, 4) +
      path2('M0 8 H4 M0 32 H4'),
    ports: [
      { id: 'w1', x: 0, y: 8, kind: 'process' },
      { id: 'w2', x: 0, y: 32, kind: 'process' },
    ],
    tagRule: 'isa-instrument',
    keywords: ['float', 'displacer', 'cage', 'level'],
  },
  {
    id: 'acc.radar',
    name: 'Radar Level Horn',
    category: 'accessories',
    gridSize: { w: 4, h: 3 },
    render: () => path2('M16 0 V6') + path2('M8 6 h16 l-4 12 h-8 Z') + path2('M12 22 M10 20 Q16 26 22 20'),
    ports: [{ id: 'n', x: 16, y: 0, kind: 'both' }],
    tagRule: 'isa-instrument',
    keywords: ['radar', 'level', 'horn', 'non-contact'],
  },
  {
    id: 'acc.loadcell',
    name: 'Load Cell',
    category: 'accessories',
    gridSize: { w: 3, h: 2 },
    render: () => path2('M12 0 V4') + path2('M0 4 h24 v10 h-24 Z') + text2(12, 12, 'LC'),
    ports: [{ id: 'n', x: 12, y: 0, kind: 'both' }],
    tagRule: 'isa-instrument',
    keywords: ['load cell', 'weight', 'weigh'],
  },
]
