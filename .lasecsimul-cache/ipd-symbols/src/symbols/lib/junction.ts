// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright © 2026 Praharsh Nagpure — IPD Studio. Noncommercial use only;
// commercial use requires a paid license (see COMMERCIAL-LICENSE.md).

import type { SymbolDef } from '../types'

/**
 * Branch junction: the filled dot where a line taps into an existing pipe.
 * Inserted automatically when a drawn line is dropped onto a pipe; also
 * placeable by hand for manifolds.
 */
export const junction: SymbolDef = {
  id: 'fit.junction',
  name: 'Branch Junction',
  category: 'inline',
  gridSize: { w: 1, h: 1 },
  // cross stubs under the dot bridge the port-to-center distance seamlessly
  render: () =>
    `<path d="M4 0 V8 M0 4 H8" stroke="currentColor" stroke-width="2" fill="none"/>` +
    `<circle cx="4" cy="4" r="3" fill="currentColor" stroke="none"/>`,
  ports: [
    { id: 'n', x: 4, y: 0, kind: 'both' },
    { id: 'e', x: 8, y: 4, kind: 'both' },
    { id: 's', x: 4, y: 8, kind: 'both' },
    { id: 'w', x: 0, y: 4, kind: 'both' },
  ],
  tagRule: 'none',
  keywords: ['junction', 'branch', 'tap', 'tee', 'connection dot', 'node'],
}
