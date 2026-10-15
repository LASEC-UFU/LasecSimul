// SPDX-License-Identifier: GPL-3.0-or-later
// Estado do editor SFC compartilhado com os nós do React Flow (sem passar callbacks em `data`).

import { createContext, useContext } from 'react'

import type { SfcBody } from '../../shared/sfc'

/** Tipo do dataTransfer das ferramentas SFC da barra lateral (como 'application/reactflow/fbd-blocks'). */
export const SFC_DRAG_TYPE = 'application/reactflow/sfc-blocks'

export interface SfcStepDebugState {
  active: boolean
  /** Tempo desde a ativação, como o CLP devolve (ex.: T#1s200ms). */
  time?: string
}

export interface SfcEditorState {
  pouName: string
  body: SfcBody
  readOnly: boolean
  /** Estado de cada passo (nome em maiúsculas) lido do CLP quando o depurador está aberto. */
  debug: Record<string, SfcStepDebugState>
  /** Nomes que podem ser ação booleana: variáveis BOOL de VAR e VAR_OUTPUT do POU. */
  booleanVariables: string[]
  commit: (next: SfcBody) => void
  openContextMenu: (kind: 'step' | 'transition', id: string, x: number, y: number) => void
}

export const SfcEditorContext = createContext<SfcEditorState | null>(null)

export function useSfcEditor(): SfcEditorState {
  const value = useContext(SfcEditorContext)
  if (!value) throw new Error('SfcEditorContext ausente')
  return value
}
