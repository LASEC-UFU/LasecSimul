// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright © 2026 Praharsh Nagpure — IPD Studio. Noncommercial use only;
// commercial use requires a paid license (see COMMERCIAL-LICENSE.md).

import type { SymbolDef } from '../types'

const S = 1.5
const path = (d: string, fill = 'none') =>
  `<path d="${d}" fill="${fill}" stroke="currentColor" stroke-width="${S}" stroke-linejoin="round"/>`
const circle = (cx: number, cy: number, r: number) =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="currentColor" stroke-width="${S}"/>`

export const heat: SymbolDef[] = [
  {
    id: 'hx.shell-tube',
    name: 'Shell & Tube Exchanger',
    category: 'heat',
    gridSize: { w: 6, h: 4 },
    render: () => circle(24, 16, 14) + path('M0 16 H48') + path('M24 2 V0 M24 30 V32'),
    ports: [
      { id: 'w', x: 0, y: 16, kind: 'process' },
      { id: 'e', x: 48, y: 16, kind: 'process' },
      { id: 'n', x: 24, y: 0, kind: 'process' },
      { id: 's', x: 24, y: 32, kind: 'process' },
    ],
    tagRule: 'equipment',
    keywords: ['exchanger', 'shell', 'tube', 'cooler', 'heater', 'hx'],
  },
  {
    id: 'hx.plate',
    name: 'Plate Exchanger',
    category: 'heat',
    gridSize: { w: 4, h: 4 },
    render: () =>
      path('M2 2 h28 v28 h-28 Z') +
      path('M10 2 V30 M16 2 V30 M22 2 V30') +
      path('M0 4 H2 M0 28 H2 M30 4 H32 M30 28 H32'),
    ports: [
      { id: 'w1', x: 0, y: 4, kind: 'process' },
      { id: 'w2', x: 0, y: 28, kind: 'process' },
      { id: 'e1', x: 32, y: 4, kind: 'process' },
      { id: 'e2', x: 32, y: 28, kind: 'process' },
    ],
    tagRule: 'equipment',
    keywords: ['exchanger', 'plate', 'phe', 'gasketed'],
  },
  {
    id: 'hx.air-cooler',
    name: 'Air Cooler (Fin-Fan)',
    category: 'heat',
    gridSize: { w: 8, h: 4 },
    render: () =>
      path('M0 8 h64 v24 h-64 Z') +
      circle(32, 20, 8) +
      path('M32 20 L38 14 M32 20 L26 14'),
    ports: [
      { id: 'w', x: 0, y: 20, kind: 'process' },
      { id: 'e', x: 64, y: 20, kind: 'process' },
    ],
    tagRule: 'equipment',
    keywords: ['air cooler', 'fin fan', 'exchanger'],
  },
]

const text2 = (x: number, y: number, t: string, size = 8) =>
  `<text x="${x}" y="${y}" font-size="${size}" font-family="sans-serif" text-anchor="middle" fill="currentColor" stroke="none">${t}</text>`

export const heat2: SymbolDef[] = [
  {
    id: 'hx.kettle',
    name: 'Kettle Reboiler',
    category: 'heat',
    gridSize: { w: 10, h: 6 },
    render: () =>
      path('M12 8 H68 a10 14 0 0 1 0 28 H12 a10 14 0 0 1 0 -28 Z') +
      path('M12 18 H44 a5 5 0 0 1 0 10 H12') +
      path('M56 14 V36'),
    ports: [
      { id: 'w', x: 4, y: 24, kind: 'process' },
      { id: 'n', x: 40, y: 8, kind: 'process' },
      { id: 's', x: 40, y: 36, kind: 'process' },
      { id: 'e', x: 76, y: 24, kind: 'process' },
    ],
    tagRule: 'equipment',
    keywords: ['kettle', 'reboiler', 'u-tube', 'exchanger'],
  },
  {
    id: 'hx.doublepipe',
    name: 'Double-Pipe Exchanger',
    category: 'heat',
    gridSize: { w: 8, h: 3 },
    render: () => path('M4 4 h56 v16 h-56 Z') + path('M0 12 H64') + path('M4 0 V4 M60 20 V24'),
    ports: [
      { id: 'w', x: 0, y: 12, kind: 'process' },
      { id: 'e', x: 64, y: 12, kind: 'process' },
      { id: 'n', x: 4, y: 0, kind: 'process' },
      { id: 's', x: 60, y: 24, kind: 'process' },
    ],
    tagRule: 'equipment',
    keywords: ['double pipe', 'hairpin', 'exchanger'],
  },
  {
    id: 'heater.electric',
    name: 'Electric Heater',
    category: 'heat',
    gridSize: { w: 5, h: 3 },
    render: () => path('M0 0 h40 v24 h-40 Z') + path('M6 12 l4 -6 l6 12 l6 -12 l6 12 l4 -6 h2'),
    ports: [
      { id: 'w', x: 0, y: 12, kind: 'process' },
      { id: 'e', x: 40, y: 12, kind: 'process' },
    ],
    tagRule: 'equipment',
    keywords: ['electric', 'heater', 'immersion'],
  },
  {
    id: 'heater.fired',
    name: 'Fired Heater',
    category: 'heat',
    gridSize: { w: 7, h: 9 },
    render: () =>
      path('M0 16 h56 v48 h-56 Z') +
      path('M20 16 V0 h16 V16') +
      path('M22 56 L28 44 L34 56 Z') +
      path('M8 24 h40 M8 32 h40 M8 40 h40'),
    ports: [
      { id: 'w', x: 0, y: 32, kind: 'process' },
      { id: 'e', x: 56, y: 32, kind: 'process' },
      { id: 's', x: 28, y: 64, kind: 'process' },
    ],
    tagRule: 'equipment',
    keywords: ['fired heater', 'furnace', 'burner'],
  },
  {
    id: 'hx.condenser',
    name: 'Condenser',
    category: 'heat',
    gridSize: { w: 6, h: 6 },
    render: () =>
      `<circle cx="24" cy="16" r="14" fill="none" stroke="currentColor" stroke-width="1.5"/>` +
      path('M0 16 H48') + path('M24 30 V44') + text2(24, 20, 'C'),
    ports: [
      { id: 'w', x: 0, y: 16, kind: 'process' },
      { id: 'e', x: 48, y: 16, kind: 'process' },
      { id: 's', x: 24, y: 44, kind: 'process' },
    ],
    tagRule: 'equipment',
    keywords: ['condenser', 'exchanger', 'overhead'],
  },
  {
    id: 'cooling-tower',
    name: 'Cooling Tower',
    category: 'heat',
    gridSize: { w: 8, h: 7 },
    render: () =>
      path('M8 0 L56 0 L48 48 L16 48 Z') +
      `<circle cx="32" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.5"/>` +
      path('M32 10 L37 5 M32 10 L27 5') +
      path('M20 28 L44 36 M20 36 L44 28'),
    ports: [
      { id: 'w', x: 8, y: 40, kind: 'process' },
      { id: 'e', x: 56, y: 40, kind: 'process' },
      { id: 's', x: 32, y: 48, kind: 'process' },
    ],
    tagRule: 'equipment',
    keywords: ['cooling tower', 'evaporative'],
  },
]
