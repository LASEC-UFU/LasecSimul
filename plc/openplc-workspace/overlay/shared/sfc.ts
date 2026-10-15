// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Corpo de um POU SFC (IEC 61131-3 3ª ed., 6.7) no projeto OpenPLC do LasecSimul.
 *
 * Mesmos campos do modelo SFC do LasecSimul (extension/src/plc/iecProject.ts), que a tradução
 * SFC -> ST (sfcLowering.ts) consome direto, mais `layout`: posição de cada passo e transição no
 * desenho. O arquivo do POU (`pous/<pasta>/<nome>.sfc`) tem o mesmo formato dos POUs LD/FBD do
 * OpenPLC: cabeçalho PROGRAM/FUNCTION_BLOCK, variáveis e este corpo em JSON.
 */

export const SFC_QUALIFIERS = ['N', 'R', 'S', 'L', 'D', 'P', 'P1', 'P0', 'SD', 'DS', 'SL'] as const
export type SfcQualifier = (typeof SFC_QUALIFIERS)[number]
/** Qualificadores que exigem duração (tabela 56). */
export const SFC_TIMED_QUALIFIERS: readonly SfcQualifier[] = ['L', 'D', 'SD', 'DS', 'SL']

/** Bloco de ação de um passo: qualificador, ação (nomeada ou variável BOOL) e duração. */
export interface SfcActionAssociation {
  actionId: string
  qualifier?: SfcQualifier
  actionName?: string
  time?: string
  indicator?: string
}

/** Ação nomeada do POU, com corpo em ST ou IL. */
export interface SfcAction {
  name: string
  language: 'st' | 'il'
  text: string
}

export interface SfcStep {
  stepId: string
  name: string
  initial?: boolean
  actions: SfcActionAssociation[]
}

export interface SfcTransition {
  transitionId: string
  /** Passos antes; mais de um = convergência simultânea. */
  fromStepIds: string[]
  /** Passos depois; mais de um = divergência simultânea. */
  toStepIds: string[]
  /** Expressão ST BOOL; pode usar `PASSO.X` e `PASSO.T`. */
  condition: string
  /** Divergência seletiva: menor número avaliado primeiro (o editor numera da esquerda para a direita). */
  priority?: number
}

export interface SfcPoint {
  x: number
  y: number
}

export interface SfcBody {
  name: string
  steps: SfcStep[]
  transitions: SfcTransition[]
  actions: SfcAction[]
  layout: Record<string, SfcPoint>
}

export const SFC_GRID = 16
export const SFC_STEP_WIDTH = 112
export const SFC_STEP_HEIGHT = 48
export const SFC_TRANSITION_WIDTH = 64
export const SFC_TRANSITION_HEIGHT = 16
const COLUMN = 288
const ROW = 96
const ORIGIN: SfcPoint = { x: 64, y: 32 }

export const IEC_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

let sequence = 0
export function sfcId(prefix: string): string {
  sequence += 1
  return `${prefix}-${Date.now().toString(36)}-${sequence.toString(36)}`
}

export function snap(value: number): number {
  return Math.round(value / SFC_GRID) * SFC_GRID
}

/** POU SFC novo: só o passo inicial. */
export function defaultSfcBody(name: string): SfcBody {
  const step: SfcStep = { stepId: sfcId('step'), name: 'Init', initial: true, actions: [] }
  return { name, steps: [step], transitions: [], actions: [], layout: { [step.stepId]: { ...ORIGIN } } }
}

/**
 * Programa SFC de um projeto novo com uma entrada e uma saída: Init (inicial) -> entrada TRUE ->
 * S1 (saída ligada, qualificador N) -> entrada FALSE -> Init. Mostra passo, transição e bloco de
 * ação já funcionando.
 */
export function starterSfcBody(name: string, input?: string, output?: string): SfcBody {
  if (!input || !output) return defaultSfcBody(name)
  const init: SfcStep = { stepId: sfcId('step'), name: 'Init', initial: true, actions: [] }
  const on: SfcStep = { stepId: sfcId('step'), name: 'S1', actions: [{ actionId: sfcId('action'), qualifier: 'N', actionName: output }] }
  const transitions: SfcTransition[] = [
    { transitionId: sfcId('transition'), fromStepIds: [init.stepId], toStepIds: [on.stepId], condition: input },
    { transitionId: sfcId('transition'), fromStepIds: [on.stepId], toStepIds: [init.stepId], condition: `NOT ${input}` },
  ]
  const body = { name, steps: [init, on], transitions, actions: [], layout: {} }
  return { ...body, layout: autoLayout(body) }
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

/**
 * Corpo SFC a partir do que veio do arquivo: aceita o POU recém-criado pelo OpenPLC (valor ''),
 * o formato antigo das transições (`fromStepId`/`toStepId`) e corpos sem posição (layout
 * automático a partir do passo inicial).
 */
export function normalizeSfcBody(value: unknown, name: string): SfcBody {
  if (!value || typeof value !== 'object') return defaultSfcBody(name)
  const raw = value as Record<string, unknown>
  const steps = asArray<SfcStep>(raw.steps).map((step) => ({
    stepId: String(step.stepId),
    name: String(step.name ?? ''),
    ...(step.initial ? { initial: true } : {}),
    actions: asArray<SfcActionAssociation>(step.actions).map((action) => ({ ...action, actionId: action.actionId ?? sfcId('action') })),
  }))
  const transitions = asArray<SfcTransition & { fromStepId?: string; toStepId?: string }>(raw.transitions).map((transition) => ({
    transitionId: String(transition.transitionId),
    fromStepIds: transition.fromStepIds ?? (transition.fromStepId ? [transition.fromStepId] : []),
    toStepIds: transition.toStepIds ?? (transition.toStepId ? [transition.toStepId] : []),
    condition: String(transition.condition ?? ''),
    ...(typeof transition.priority === 'number' ? { priority: transition.priority } : {}),
  }))
  const actions = asArray<SfcAction>(raw.actions).map((action) => ({
    name: String(action.name ?? ''),
    language: action.language === 'il' ? ('il' as const) : ('st' as const),
    text: String(action.text ?? ''),
  }))
  const body: SfcBody = {
    name: typeof raw.name === 'string' && raw.name ? raw.name : name,
    steps,
    transitions,
    actions,
    layout: raw.layout && typeof raw.layout === 'object' ? { ...(raw.layout as Record<string, SfcPoint>) } : {},
  }
  if (steps.length === 0) return defaultSfcBody(name)
  const missing = [...steps.map((step) => step.stepId), ...transitions.map((transition) => transition.transitionId)]
    .some((id) => !body.layout[id])
  return missing ? { ...body, layout: { ...autoLayout(body), ...body.layout } } : body
}

/**
 * Posições para um corpo sem desenho: busca em largura a partir do passo inicial; cada nível desce
 * uma linha e os ramos de uma divergência ocupam colunas lado a lado. Transições ficam entre o
 * passo de antes e o de depois.
 */
export function autoLayout(body: Pick<SfcBody, 'steps' | 'transitions'>): Record<string, SfcPoint> {
  const layout: Record<string, SfcPoint> = {}
  const byId = new Map(body.steps.map((step) => [step.stepId, step]))
  const start = body.steps.find((step) => step.initial) ?? body.steps[0]
  if (!start) return layout
  const level = new Map<string, number>([[start.stepId, 0]])
  const column = new Map<string, number>([[start.stepId, 0]])
  const queue = [start.stepId]
  const usedColumns = new Map<number, Set<number>>([[0, new Set([0])]])
  const freeColumn = (row: number, wanted: number): number => {
    const used = usedColumns.get(row) ?? new Set<number>()
    let candidate = wanted
    while (used.has(candidate)) candidate += 1
    used.add(candidate)
    usedColumns.set(row, used)
    return candidate
  }
  while (queue.length > 0) {
    const stepId = queue.shift()!
    const outgoing = body.transitions.filter((transition) => transition.fromStepIds.includes(stepId))
    outgoing.forEach((transition, branch) => {
      for (const [index, target] of transition.toStepIds.entries()) {
        if (!byId.has(target) || level.has(target)) continue
        const row = (level.get(stepId) ?? 0) + 1
        level.set(target, row)
        column.set(target, freeColumn(row, (column.get(stepId) ?? 0) + branch + index))
        queue.push(target)
      }
    })
  }
  let orphanRow = Math.max(0, ...level.values()) + 1
  for (const step of body.steps) {
    if (!level.has(step.stepId)) {
      level.set(step.stepId, orphanRow)
      column.set(step.stepId, freeColumn(orphanRow, 0))
      orphanRow += 1
    }
  }
  for (const step of body.steps) {
    layout[step.stepId] = { x: ORIGIN.x + (column.get(step.stepId) ?? 0) * COLUMN, y: ORIGIN.y + (level.get(step.stepId) ?? 0) * ROW * 2 }
  }
  body.transitions.forEach((transition, index) => {
    const from = transition.fromStepIds.map((id) => layout[id]).filter(Boolean)
    const to = transition.toStepIds.map((id) => layout[id]).filter(Boolean)
    const anchor = from[0] ?? to[0] ?? { x: ORIGIN.x, y: ORIGIN.y + index * ROW }
    const siblings = body.transitions.filter((other) => other.fromStepIds[0] && other.fromStepIds[0] === transition.fromStepIds[0])
    const branch = Math.max(0, siblings.indexOf(transition))
    const backwards = to.length > 0 && from.length > 0 && to[0]!.y <= from[0]!.y
    layout[transition.transitionId] = {
      x: anchor.x + (SFC_STEP_WIDTH - SFC_TRANSITION_WIDTH) / 2 + (backwards ? 0 : branch * COLUMN),
      y: (from[0]?.y ?? anchor.y) + SFC_STEP_HEIGHT + (ROW * 2 - SFC_STEP_HEIGHT - SFC_TRANSITION_HEIGHT) / 2,
    }
  })
  return layout
}

/**
 * Ordem da lista = prioridade da divergência seletiva: transições que saem do mesmo passo, da
 * esquerda para a direita (IEC 61131-3, 6.7.4). Grava `priority` só onde há competição.
 */
export function withLeftToRightPriorities(body: SfcBody): SfcBody {
  const groups = new Map<string, SfcTransition[]>()
  for (const transition of body.transitions) {
    const key = [...transition.fromStepIds].sort().join('|')
    groups.set(key, [...(groups.get(key) ?? []), transition])
  }
  const priority = new Map<string, number>()
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const ordered = [...group].sort((a, b) => (body.layout[a.transitionId]?.x ?? 0) - (body.layout[b.transitionId]?.x ?? 0))
    ordered.forEach((transition, index) => priority.set(transition.transitionId, index + 1))
  }
  return {
    ...body,
    transitions: body.transitions.map((transition) => {
      const { priority: _old, ...rest } = transition
      const value = priority.get(transition.transitionId)
      return value ? { ...rest, priority: value } : rest
    }),
  }
}

/** Nome livre `S1`, `S2`... (ou com o prefixo pedido) que não colide com passos, ações nem variáveis. */
export function freeName(prefix: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((name) => name.toUpperCase()))
  for (let index = 1; ; index += 1) {
    const candidate = `${prefix}${index}`
    if (!used.has(candidate.toUpperCase())) return candidate
  }
}
