// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright © 2026 Praharsh Nagpure — IPD Studio. Noncommercial use only;
// commercial use requires a paid license (see COMMERCIAL-LICENSE.md).

import type { SymbolDef } from '../types'

const S = 1.5
const path = (d: string, fill = 'none') =>
  `<path d="${d}" fill="${fill}" stroke="currentColor" stroke-width="${S}" stroke-linejoin="round"/>`

/** The 32x16 bowtie shared by most inline valves. */
export const BOWTIE = 'M0 0 L0 16 L16 8 Z M32 0 L32 16 L16 8 Z'

const inlinePorts: SymbolDef['ports'] = [
  { id: 'w', x: 0, y: 8, kind: 'process' },
  { id: 'e', x: 32, y: 8, kind: 'process' },
]

function inlineValve(id: string, name: string, body: string, keywords: string[]): SymbolDef {
  return {
    id,
    name,
    category: 'valves',
    gridSize: { w: 4, h: 2 },
    render: () => body,
    ports: inlinePorts,
    tagRule: 'valve',
    keywords: ['valve', ...keywords],
  }
}

export const manualValves: SymbolDef[] = [
  inlineValve('valve.gate', 'Gate Valve', path(BOWTIE), ['gate', 'block', 'isolation']),
  inlineValve(
    'valve.globe',
    'Globe Valve',
    path(BOWTIE) + `<circle cx="16" cy="8" r="4" fill="currentColor" stroke="none"/>`,
    ['globe', 'throttle'],
  ),
  inlineValve(
    'valve.ball',
    'Ball Valve',
    path(BOWTIE) + `<circle cx="16" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="${S}"/>`,
    ['ball'],
  ),
  inlineValve(
    'valve.butterfly',
    'Butterfly Valve',
    path('M0 0 L0 16 M32 0 L32 16 M4 14 L28 2') +
      `<circle cx="16" cy="8" r="2" fill="currentColor" stroke="none"/>`,
    ['butterfly'],
  ),
  inlineValve(
    'valve.plug',
    'Plug Valve',
    path(BOWTIE) + path('M12 4 h8 v8 h-8 Z'),
    ['plug', 'cock'],
  ),
  inlineValve(
    'valve.needle',
    'Needle Valve',
    path(BOWTIE) +
      `<circle cx="16" cy="8" r="4" fill="currentColor" stroke="none"/>` +
      path('M16 8 L16 0 M13 3 L16 0 L19 3'),
    ['needle', 'fine'],
  ),
  inlineValve(
    'valve.diaphragm',
    'Diaphragm Valve',
    path(BOWTIE) + path('M8 4 Q16 -4 24 4'),
    ['diaphragm', 'weir', 'sanitary'],
  ),
  inlineValve(
    'valve.check',
    'Check Valve',
    path('M4 2 L28 8 L4 14 Z') + path('M28 0 L28 16'),
    ['check', 'non-return', 'nrv', 'one-way'],
  ),
  inlineValve(
    'valve.pinch',
    'Pinch Valve',
    path('M0 8 H32') + path('M4 0 Q16 8 28 0 M4 16 Q16 8 28 16'),
    ['pinch', 'tube'],
  ),
  inlineValve(
    'valve.stopcheck',
    'Stop-Check Valve',
    path('M4 2 L28 8 L4 14 Z') + path('M28 0 L28 16') + path('M16 0 V6 M10 0 H22'),
    ['stop-check', 'check'],
  ),
  inlineValve(
    'valve.knife',
    'Knife Gate Valve',
    path(BOWTIE) + path('M16 8 V0 M12 2 H20'),
    ['knife', 'gate', 'slurry'],
  ),
  {
    id: 'valve.fourway',
    name: '4-Way Valve',
    category: 'valves',
    gridSize: { w: 4, h: 4 },
    render: () =>
      path('M0 8 L0 24 L16 16 Z M32 8 L32 24 L16 16 Z M8 0 L24 0 L16 16 Z M8 32 L24 32 L16 16 Z'),
    ports: [
      { id: 'w', x: 0, y: 16, kind: 'process' },
      { id: 'e', x: 32, y: 16, kind: 'process' },
      { id: 'n', x: 16, y: 0, kind: 'process' },
      { id: 's', x: 16, y: 32, kind: 'process' },
    ],
    tagRule: 'valve',
    keywords: ['valve', 'four-way', '4-way'],
  },
  {
    id: 'valve.angle',
    name: 'Angle Valve',
    category: 'valves',
    gridSize: { w: 3, h: 3 },
    render: () => path('M0 4 L0 20 L16 12 Z M8 24 L24 24 L16 12 Z'),
    ports: [
      { id: 'w', x: 0, y: 12, kind: 'process' },
      { id: 's', x: 16, y: 24, kind: 'process' },
    ],
    tagRule: 'valve',
    keywords: ['valve', 'angle'],
  },
  {
    id: 'valve.threeway',
    name: '3-Way Valve',
    category: 'valves',
    gridSize: { w: 4, h: 3 },
    render: () => path('M0 0 L0 16 L16 8 Z M32 0 L32 16 L16 8 Z M8 24 L24 24 L16 8 Z'),
    ports: [
      { id: 'w', x: 0, y: 8, kind: 'process' },
      { id: 'e', x: 32, y: 8, kind: 'process' },
      { id: 's', x: 16, y: 24, kind: 'process' },
    ],
    tagRule: 'valve',
    keywords: ['valve', 'three-way', '3-way', 'diverting', 'mixing'],
  },
]
