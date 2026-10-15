// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Edições do corpo SFC. Funções puras: recebem o corpo atual e devolvem um novo (o editor grava no
 * store do OpenPLC com histórico de desfazer).
 */

import {
  freeName,
  type SfcActionAssociation,
  type SfcBody,
  type SfcPoint,
  sfcId,
  snap,
  SFC_STEP_HEIGHT,
  SFC_STEP_WIDTH,
  SFC_TRANSITION_HEIGHT,
  SFC_TRANSITION_WIDTH,
} from '../../shared/sfc'

export type SfcElementKind = 'step' | 'transition'

export function elementKind(body: SfcBody, id: string): SfcElementKind | undefined {
  if (body.steps.some((step) => step.stepId === id)) return 'step'
  if (body.transitions.some((transition) => transition.transitionId === id)) return 'transition'
  return undefined
}

export function edgeId(source: string, target: string): string {
  return `${source}=>${target}`
}

function splitEdgeId(id: string): [string, string] | undefined {
  const parts = id.split('=>')
  return parts.length === 2 ? [parts[0]!, parts[1]!] : undefined
}

function point(at: SfcPoint): SfcPoint {
  return { x: snap(at.x), y: snap(at.y) }
}

/**
 * Elemento logo acima do ponto onde algo foi solto: até ~12 linhas de grade abaixo dele e até 2,5
 * larguras de passo para o lado (uma divergência se abre na diagonal). O mais próximo ganha.
 */
function elementAbove(body: SfcBody, kind: SfcElementKind, at: SfcPoint, width: number): string | undefined {
  const otherWidth = kind === 'step' ? SFC_STEP_WIDTH : SFC_TRANSITION_WIDTH
  const otherHeight = kind === 'step' ? SFC_STEP_HEIGHT : SFC_TRANSITION_HEIGHT
  const candidates = (kind === 'step' ? body.steps.map((step) => step.stepId) : body.transitions.map((transition) => transition.transitionId))
    .map((id) => ({ id, position: body.layout[id] }))
    .filter((item): item is { id: string; position: SfcPoint } => !!item.position)
    .map((item) => ({
      id: item.id,
      side: Math.abs(item.position.x + otherWidth / 2 - (at.x + width / 2)),
      gap: at.y - (item.position.y + otherHeight),
    }))
    .filter((item) => item.gap >= 0 && item.gap <= 192 && item.side <= SFC_STEP_WIDTH * 2.5)
    .sort((a, b) => a.gap + a.side / 2 - (b.gap + b.side / 2))
  return candidates[0]?.id
}

/** Passo novo; solto logo abaixo de uma transição, já fica ligado a ela. */
export function addStep(body: SfcBody, center: SfcPoint, options: { initial?: boolean; extraNames?: string[] } = {}): SfcBody {
  const stepId = sfcId('step')
  const name = freeName('S', [...body.steps.map((step) => step.name), ...body.actions.map((action) => action.name), ...(options.extraNames ?? [])])
  const position = point({ x: center.x - SFC_STEP_WIDTH / 2, y: center.y - SFC_STEP_HEIGHT / 2 })
  const above = elementAbove(body, 'transition', position, SFC_STEP_WIDTH)
  const steps = body.steps.map((step) => (options.initial ? { ...step, initial: undefined } : step))
  return {
    ...body,
    steps: [...steps, { stepId, name, ...(options.initial || body.steps.length === 0 ? { initial: true } : {}), actions: [] }],
    transitions: above
      ? body.transitions.map((transition) =>
          transition.transitionId === above ? { ...transition, toStepIds: [...transition.toStepIds, stepId] } : transition)
      : body.transitions,
    layout: { ...body.layout, [stepId]: position },
  }
}

/** Transição nova (condição TRUE); solta logo abaixo de um passo, já sai dele. */
export function addTransition(body: SfcBody, center: SfcPoint): SfcBody {
  const transitionId = sfcId('transition')
  const position = point({ x: center.x - SFC_TRANSITION_WIDTH / 2, y: center.y - SFC_TRANSITION_HEIGHT / 2 })
  const above = elementAbove(body, 'step', position, SFC_TRANSITION_WIDTH)
  return {
    ...body,
    transitions: [...body.transitions, { transitionId, fromStepIds: above ? [above] : [], toStepIds: [], condition: 'TRUE' }],
    layout: { ...body.layout, [transitionId]: position },
  }
}

/** Ligação puxada pelo mouse: passo -> transição ou transição -> passo. */
export function connect(body: SfcBody, source: string, target: string): SfcBody {
  const sourceKind = elementKind(body, source)
  const targetKind = elementKind(body, target)
  if (!sourceKind || !targetKind || sourceKind === targetKind) return body
  return {
    ...body,
    transitions: body.transitions.map((transition) => {
      if (sourceKind === 'step' && transition.transitionId === target && !transition.fromStepIds.includes(source)) {
        return { ...transition, fromStepIds: [...transition.fromStepIds, source] }
      }
      if (sourceKind === 'transition' && transition.transitionId === source && !transition.toStepIds.includes(target)) {
        return { ...transition, toStepIds: [...transition.toStepIds, target] }
      }
      return transition
    }),
  }
}

export function isValidConnection(body: SfcBody, source: string | null, target: string | null): boolean {
  if (!source || !target) return false
  const sourceKind = elementKind(body, source)
  const targetKind = elementKind(body, target)
  return !!sourceKind && !!targetKind && sourceKind !== targetKind
}

/** Apaga passos, transições e ligações. Passo apagado sai das transições que o citavam. */
export function removeElements(body: SfcBody, nodeIds: string[], edgeIds: string[]): SfcBody {
  const removedNodes = new Set(nodeIds)
  const removedEdges = edgeIds.map(splitEdgeId).filter((pair): pair is [string, string] => !!pair)
  const steps = body.steps.filter((step) => !removedNodes.has(step.stepId))
  if (steps.length > 0 && !steps.some((step) => step.initial) && body.steps.some((step) => step.initial && removedNodes.has(step.stepId))) {
    steps[0] = { ...steps[0]!, initial: true }
  }
  const transitions = body.transitions
    .filter((transition) => !removedNodes.has(transition.transitionId))
    .map((transition) => ({
      ...transition,
      fromStepIds: transition.fromStepIds.filter((id) =>
        !removedNodes.has(id) && !removedEdges.some(([source, target]) => source === id && target === transition.transitionId)),
      toStepIds: transition.toStepIds.filter((id) =>
        !removedNodes.has(id) && !removedEdges.some(([source, target]) => source === transition.transitionId && target === id)),
    }))
  const layout = Object.fromEntries(Object.entries(body.layout).filter(([id]) => !removedNodes.has(id)))
  return { ...body, steps, transitions, layout }
}

export function moveElements(body: SfcBody, positions: Array<{ id: string; position: SfcPoint }>): SfcBody {
  const layout = { ...body.layout }
  for (const { id, position } of positions) layout[id] = point(position)
  return { ...body, layout }
}

const STEP_REFERENCE = (name: string) => new RegExp(`\\b${name}\\.(X|T)\\b`, 'gi')

/** Renomeia o passo e as referências `PASSO.X` / `PASSO.T` nas condições e nas ações. */
export function renameStep(body: SfcBody, stepId: string, name: string): SfcBody {
  const old = body.steps.find((step) => step.stepId === stepId)?.name
  if (!old || old === name) return body
  const rewrite = (text: string) => text.replace(STEP_REFERENCE(old), (_match, member: string) => `${name}.${member}`)
  return {
    ...body,
    steps: body.steps.map((step) => (step.stepId === stepId ? { ...step, name } : step)),
    transitions: body.transitions.map((transition) => ({ ...transition, condition: rewrite(transition.condition) })),
    actions: body.actions.map((action) => ({ ...action, text: rewrite(action.text) })),
  }
}

export function setInitialStep(body: SfcBody, stepId: string): SfcBody {
  return {
    ...body,
    steps: body.steps.map((step) => {
      const { initial: _initial, ...rest } = step
      return step.stepId === stepId ? { ...rest, initial: true } : rest
    }),
  }
}

export function setCondition(body: SfcBody, transitionId: string, condition: string): SfcBody {
  return {
    ...body,
    transitions: body.transitions.map((transition) => (transition.transitionId === transitionId ? { ...transition, condition } : transition)),
  }
}

export function addAssociation(body: SfcBody, stepId: string): SfcBody {
  return {
    ...body,
    steps: body.steps.map((step) => (step.stepId === stepId
      ? { ...step, actions: [...step.actions, { actionId: sfcId('action'), qualifier: 'N', actionName: '' }] }
      : step)),
  }
}

export function updateAssociation(body: SfcBody, stepId: string, actionId: string, patch: Partial<SfcActionAssociation>): SfcBody {
  return {
    ...body,
    steps: body.steps.map((step) => (step.stepId === stepId
      ? { ...step, actions: step.actions.map((action) => (action.actionId === actionId ? { ...action, ...patch } : action)) }
      : step)),
  }
}

export function removeAssociation(body: SfcBody, stepId: string, actionId: string): SfcBody {
  return {
    ...body,
    steps: body.steps.map((step) => (step.stepId === stepId ? { ...step, actions: step.actions.filter((action) => action.actionId !== actionId) } : step)),
  }
}

export function addNamedAction(body: SfcBody, extraNames: string[] = []): { body: SfcBody; name: string } {
  const name = freeName('ACTION', [...body.actions.map((action) => action.name), ...body.steps.map((step) => step.name), ...extraNames])
  return { body: { ...body, actions: [...body.actions, { name, language: 'st', text: '' }] }, name }
}

/** Renomeia a ação nomeada e os blocos de ação dos passos que a usam. */
export function renameNamedAction(body: SfcBody, oldName: string, name: string): SfcBody {
  return {
    ...body,
    actions: body.actions.map((action) => (action.name === oldName ? { ...action, name } : action)),
    steps: body.steps.map((step) => ({
      ...step,
      actions: step.actions.map((association) => (association.actionName?.toUpperCase() === oldName.toUpperCase() ? { ...association, actionName: name } : association)),
    })),
  }
}

export function updateNamedAction(body: SfcBody, name: string, patch: Partial<{ language: 'st' | 'il'; text: string }>): SfcBody {
  return { ...body, actions: body.actions.map((action) => (action.name === name ? { ...action, ...patch } : action)) }
}

export function removeNamedAction(body: SfcBody, name: string): SfcBody {
  return { ...body, actions: body.actions.filter((action) => action.name !== name) }
}
