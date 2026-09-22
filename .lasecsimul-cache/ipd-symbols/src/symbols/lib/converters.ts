// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright © 2026 Praharsh Nagpure — IPD Studio. Noncommercial use only;
// commercial use requires a paid license (see COMMERCIAL-LICENSE.md).

import type { SymbolDef } from '../types'

const S = 1.5

/**
 * Signal converters / transducers (ISA "Y" function): one parameterized
 * symbol whose cfg.conv picks the conversion legend, e.g. I/P for
 * current-to-pneumatic, E/P voltage-to-pneumatic, P/I pressure-to-current.
 * Drawn as a circle split by a diagonal, input domain over output domain.
 */
const CONVERSIONS = ['I/P', 'E/P', 'P/I', 'P/E', 'I/E', 'E/I', 'A/D', 'D/A']

export const converters: SymbolDef[] = [
  {
    id: 'instr.converter',
    name: 'Signal Converter (I/P, E/P…)',
    category: 'instruments',
    gridSize: { w: 4, h: 4 },
    render: (cfg) => {
      const conv = CONVERSIONS.includes(cfg.conv ?? '') ? cfg.conv! : 'I/P'
      const [top, bottom] = conv.split('/')
      return (
        `<circle cx="16" cy="16" r="14" fill="none" stroke="currentColor" stroke-width="${S}"/>` +
        `<line x1="7" y1="25" x2="25" y2="7" stroke="currentColor" stroke-width="${S}"/>` +
        `<text x="10.5" y="14" font-size="9" font-family="sans-serif" text-anchor="middle" fill="currentColor" stroke="none">${top}</text>` +
        `<text x="21.5" y="26" font-size="9" font-family="sans-serif" text-anchor="middle" fill="currentColor" stroke="none">${bottom}</text>`
      )
    },
    ports: [
      { id: 'w', x: 0, y: 16, kind: 'signal' },
      { id: 'e', x: 32, y: 16, kind: 'signal' },
      { id: 'n', x: 16, y: 0, kind: 'signal' },
      { id: 's', x: 16, y: 32, kind: 'signal' },
    ],
    tagRule: 'isa-instrument',
    defaultConfig: { conv: 'I/P' },
    configOptions: { conv: CONVERSIONS },
    keywords: [
      'converter', 'transducer', 'relay', 'i/p', 'ip', 'e/p', 'ep', 'p/i', 'pi',
      'p/e', 'i/e', 'e/i', 'a/d', 'd/a', 'current to pneumatic', 'signal converter',
      'fy', 'py', 'ty', 'ly',
    ],
  },
]
