// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright © 2026 Praharsh Nagpure — IPD Studio. Noncommercial use only;
// commercial use requires a paid license (see COMMERCIAL-LICENSE.md).

import type { SymbolDef } from '../types'

/**
 * The parameterized ISA instrument bubble: 40x40 local px.
 *   display:  discrete | shared | computer | plc
 *   location: field | control-room | behind-panel | local-panel
 */
const S = 1.5 // stroke width

function locationLines(location: string): string {
  switch (location) {
    case 'control-room':
      return `<line x1="2" y1="20" x2="38" y2="20" stroke="currentColor" stroke-width="${S}"/>`
    case 'behind-panel':
      return `<line x1="2" y1="20" x2="38" y2="20" stroke="currentColor" stroke-width="${S}" stroke-dasharray="4 3"/>`
    case 'local-panel':
      return (
        `<line x1="2" y1="17.5" x2="38" y2="17.5" stroke="currentColor" stroke-width="${S}"/>` +
        `<line x1="2" y1="22.5" x2="38" y2="22.5" stroke="currentColor" stroke-width="${S}"/>`
      )
    default:
      return ''
  }
}

function displayShape(display: string): string {
  const circle = `<circle cx="20" cy="20" r="18" fill="none" stroke="currentColor" stroke-width="${S}"/>`
  switch (display) {
    case 'shared':
      return `<rect x="2" y="2" width="36" height="36" fill="none" stroke="currentColor" stroke-width="${S}"/>` + circle
    case 'computer':
      return `<polygon points="20,2 36,11 36,29 20,38 4,29 4,11" fill="none" stroke="currentColor" stroke-width="${S}"/>`
    case 'plc':
      return (
        `<rect x="2" y="2" width="36" height="36" fill="none" stroke="currentColor" stroke-width="${S}"/>` +
        `<polygon points="20,4 36,20 20,36 4,20" fill="none" stroke="currentColor" stroke-width="${S}"/>`
      )
    default:
      return circle
  }
}

export const bubble: SymbolDef = {
  id: 'instr.bubble',
  name: 'Instrument',
  category: 'instruments',
  gridSize: { w: 5, h: 5 },
  render: (cfg) => displayShape(cfg.display ?? 'discrete') + locationLines(cfg.location ?? 'field'),
  ports: [
    { id: 'n', x: 20, y: 0, kind: 'both' },
    { id: 'e', x: 40, y: 20, kind: 'both' },
    { id: 's', x: 20, y: 40, kind: 'both' },
    { id: 'w', x: 0, y: 20, kind: 'both' },
  ],
  tagRule: 'isa-instrument',
  defaultConfig: { display: 'discrete', location: 'field' },
  configOptions: {
    display: ['discrete', 'shared', 'computer', 'plc'],
    location: ['field', 'control-room', 'behind-panel', 'local-panel'],
  },
  keywords: ['instrument', 'bubble', 'transmitter', 'controller', 'indicator', 'dcs', 'plc'],
}
