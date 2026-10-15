// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Projeto IEC antigo do LasecSimul (`*.iec.json`, editores próprios das etapas 1 a 4) -> projeto
 * OpenPLC (`.lsplc`).
 *
 * ST e IL passam como texto; SFC já tem o mesmo modelo (shared/sfc.ts) e só ganha o desenho. O LD
 * antigo é uma grade com ligações verticais (IEC 61131-3 3ª ed., tabela 74); o OpenPLC desenha séries e
 * paralelos (abre/fecha). A grade vira uma expressão série-paralelo e o degrau é montado com as mesmas
 * funções que o editor do OpenPLC usa quando se solta um elemento num marcador (addNewElement), então
 * o resultado é um degrau igual ao que alguém desenharia à mão. O que o OpenPLC não desenha (salto,
 * retorno, contato de comparação, ramo vazio) e o FBD antigo voltam como ST pela tradução do próprio
 * LasecSimul (`fallbackSt`), com aviso.
 */

import { defaultCustomNodesStyles, nodesBuilder } from '@root/frontend/components/_atoms/graphical-editor/ladder/node-builders'
import type { BlockVariant } from '@root/frontend/components/_atoms/graphical-editor/ladder/utils/types'
import { addNewElement } from '@root/frontend/components/_molecules/graphical-editor/ladder/rung/ladder-utils/elements'
import { getPlaceholderPositionBasedOnNode } from '@root/frontend/components/_molecules/graphical-editor/ladder/rung/ladder-utils/elements/utils'
import { newGraphicalEditorNodeID } from '@root/frontend/utils/new-graphical-editor-node-id'
import type { PLCPou, PLCVariable, RungLadderState } from '@root/middleware/shared/ports/types'
import { type Edge, getNodesBounds, type Node } from '@xyflow/react'

import { normalizeSfcBody } from '../shared/sfc'

// ----- modelo antigo (extension/src/plc/iecProject.ts) -----

export interface LegacyVariable {
  ioId?: string
  name: string
  class: 'input' | 'output' | 'inOut' | 'local' | 'temp' | 'external'
  type: string
  initialValue?: string
  retain?: boolean
}

export type LegacyLdCell =
  | { kind: 'wire' }
  | { kind: 'contact'; contact: 'no' | 'nc' | 'p' | 'n'; variable: string }
  | { kind: 'compare'; operator: string; left: string; right: string; dataType?: string }
  | { kind: 'coil'; coil: 'coil' | 'negated' | 'set' | 'reset' | 'p' | 'n'; variable: string }
  | {
      kind: 'block'
      typeName: string
      instanceName?: string
      powerInput: string
      powerOutput: string
      inputs: Record<string, string>
      outputs: Record<string, string>
    }
  | { kind: 'jump'; label: string }
  | { kind: 'return' }

export interface LegacyLdRung {
  rungId: string
  label?: string
  comment?: string
  rows: Array<Array<LegacyLdCell | null>>
  verticals: Array<{ row: number; column: number }>
}

export type LegacyPouBody =
  | { language: 'st' | 'il'; text: string }
  | { language: 'ld'; networks?: unknown[]; rungs?: LegacyLdRung[] }
  | { language: 'fbd'; networks: unknown[] }
  | { language: 'sfc'; steps: unknown[]; transitions: unknown[]; actions?: unknown[] }

export interface LegacyPou {
  pouId: string
  name: string
  kind: 'program' | 'function' | 'functionBlock'
  interface: { returnType?: string; variables: LegacyVariable[] }
  implementation: LegacyPouBody
}

export type LegacyDataType =
  | { name: string; kind: 'alias'; baseType: string; initialValue?: string }
  | { name: string; kind: 'enum'; values: string[] }
  | { name: string; kind: 'struct'; fields: Array<{ name: string; type: string; initialValue?: string }> }
  | { name: string; kind: 'array'; elementType: string; dimensions: string[] }

export interface LegacyIecProject {
  schemaVersion: 1
  projectId: string
  dataTypes?: LegacyDataType[]
  globalVariableLists?: Array<{ name: string; variables: LegacyVariable[] }>
  pous: LegacyPou[]
  tasks?: Array<{ name: string; intervalMs?: number; priority?: number }>
  programInstances?: Array<{ name: string; pouId: string; task?: string }>
}

/** POU que vai como ST: corpo e variáveis internas que a tradução criou. */
export interface LegacyStFallback {
  text: string
  variables: Array<{ name: string; type: string }>
}

export interface LegacyConversionOptions {
  /** Blocos das bibliotecas do OpenPLC (Standard Function Blocks, Standard Functions...). */
  systemLibraries: Array<{ name: string; pous: BlockVariant[] }>
  /** Tradução do POU antigo para ST (extensão: lowerPouBody), para o que o OpenPLC não desenha. */
  fallbackSt?: (pou: LegacyPou) => LegacyStFallback
}

export interface LegacyConversion {
  name: string
  pous: PLCPou[]
  dataTypes: unknown[]
  tasks: Array<{ name: string; triggering: 'Cyclic'; interval: string; priority: number }>
  instances: Array<{ name: string; program: string; task: string }>
  globalVariables: PLCVariable[]
  warnings: string[]
}

class Unsupported extends Error {}

// ----- variáveis -----

const ELEMENTARY = new Set(
  'BOOL SINT INT DINT LINT USINT UINT UDINT ULINT BYTE WORD DWORD LWORD REAL LREAL TIME LTIME DATE LDATE TIME_OF_DAY TOD LTOD DATE_AND_TIME DT LDT STRING WSTRING CHAR WCHAR'.split(
    ' ',
  ),
)

/** Tipo como o OpenPLC guarda (o texto do POU é relido ao abrir; aqui só importa a grafia). */
function variableType(type: string, userTypes: Set<string>): PLCVariable['type'] {
  const value = type.trim()
  const upper = value.toUpperCase()
  if (ELEMENTARY.has(upper)) return { definition: 'base-type', value: upper }
  if (/^ARRAY\s*\[/i.test(value)) return { definition: 'array', value }
  if (userTypes.has(upper)) return { definition: 'user-data-type', value }
  return { definition: 'derived', value }
}

function plcVariable(variable: LegacyVariable | { name: string; type: string; class?: string; initialValue?: string }, userTypes: Set<string>, variableClass?: string): PLCVariable {
  return {
    name: variable.name,
    class: (variableClass ?? (variable as LegacyVariable).class ?? 'local') as PLCVariable['class'],
    type: variableType(variable.type, userTypes),
    location: '',
    initialValue: variable.initialValue ?? null,
    documentation: '',
    debug: false,
  }
}

// ----- LD: grade -> série-paralelo -----

type Leaf = { kind: 'leaf'; cell: Exclude<LegacyLdCell, { kind: 'wire' }> }
type Par = { kind: 'par'; branches: Seq[] }
type Item = Leaf | Par
type Seq = Item[]

const RAIL: Seq = []

function sameSeq(a: Seq, b: Seq): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index])
}

/** OU de sinais que partem da barra: fatora o começo comum (mesmos elementos) e agrupa o resto. */
function mergeSignals(signals: Seq[]): Seq {
  const unique: Seq[] = []
  for (const signal of signals) if (!unique.some((other) => sameSeq(other, signal))) unique.push(signal)
  if (unique.length === 1) return unique[0]
  let prefix = 0
  while (unique.every((signal) => signal.length > prefix && signal[prefix] === unique[0][prefix])) prefix += 1
  const rests = unique.map((signal) => signal.slice(prefix))
  if (rests.some((rest) => rest.length === 0)) throw new Unsupported('ramo paralelo sem elementos (curto-circuito)')
  const groups = new Map<Item, Seq[]>()
  for (const rest of rests) groups.set(rest[0], [...(groups.get(rest[0]) ?? []), rest])
  const branches = [...groups.values()].map((group) => (group.length === 1 ? group[0] : mergeSignals(group)))
  const head = unique[0].slice(0, prefix)
  return branches.length === 1 ? [...head, ...branches[0]] : [...head, { kind: 'par', branches }]
}

/** Mesma avaliação de ldLowering.ts (coluna a coluna; ligação vertical = OU na borda direita). */
function rungToSeq(rung: LegacyLdRung): Seq {
  const rows = rung.rows ?? []
  const columns = Math.max(0, ...rows.map((row) => row.length))
  const produced: Seq[] = []
  const consumed = new Set<Seq>()
  let incoming: Array<Seq | undefined> = rows.map(() => RAIL)
  for (let column = 0; column < columns; column += 1) {
    const outputs: Array<Seq | undefined> = rows.map(() => undefined)
    rows.forEach((row, rowIndex) => {
      const cell = row[column]
      if (!cell) return
      const input = column === 0 ? RAIL : incoming[rowIndex]
      if (!input) throw new Unsupported('elemento sem ligação à esquerda')
      if (cell.kind === 'wire') {
        outputs[rowIndex] = input
        return
      }
      if (cell.kind === 'jump' || cell.kind === 'return') throw new Unsupported('salto/retorno')
      if (cell.kind === 'compare') throw new Unsupported('contato de comparação')
      const output: Seq = [...input, { kind: 'leaf', cell }]
      consumed.add(input)
      produced.push(output)
      outputs[rowIndex] = output
    })
    const group = rows.map((_, index) => index)
    const find = (index: number): number => (group[index] === index ? index : (group[index] = find(group[index])))
    for (const link of rung.verticals ?? []) {
      if (link.column === column && link.row >= 0 && link.row + 1 < rows.length) group[find(link.row + 1)] = find(link.row)
    }
    const next: Array<Seq | undefined> = rows.map(() => undefined)
    const merged = new Map<number, Seq | undefined>()
    rows.forEach((_, rowIndex) => {
      const root = find(rowIndex)
      if (!merged.has(root)) {
        const sources = rows.map((__, index) => index).filter((index) => find(index) === root).map((index) => outputs[index])
          .filter((value): value is Seq => value !== undefined)
        const distinct = sources.filter((source, index) => sources.findIndex((other) => other === source) === index)
        if (distinct.length > 1) {
          const signal = mergeSignals(distinct)
          distinct.forEach((source) => consumed.add(source))
          produced.push(signal)
          merged.set(root, signal)
        } else merged.set(root, distinct[0])
      }
      next[rowIndex] = merged.get(root)
    })
    incoming = next
  }
  // Todo sinal que termina (bobina no fim da linha, ramo que para) chega à barra direita.
  const finals = produced.filter((signal) => !consumed.has(signal))
  return finals.length === 0 ? [] : mergeSignals(finals)
}

function firstLeaf(item: Item): Leaf {
  return item.kind === 'leaf' ? item : firstLeaf(item.branches[0][0])
}

// ----- LD: série-paralelo -> degrau do OpenPLC -----

const CONTACT_VARIANT = { no: 'default', nc: 'negated', p: 'risingEdge', n: 'fallingEdge' } as const
const COIL_VARIANT = { coil: 'default', negated: 'negated', set: 'set', reset: 'reset', p: 'risingEdge', n: 'fallingEdge' } as const

class RungBuilder {
  rung: RungLadderState

  constructor(id: string, comment: string) {
    const bounds: [number, number] = [300, 100]
    const { powerRail } = defaultCustomNodesStyles
    const left = nodesBuilder.powerRail({
      id: `left-rail-${id}`,
      posX: 0,
      posY: bounds[1] / 2 - powerRail.height / 2,
      connector: 'right',
      handleX: powerRail.width,
      handleY: bounds[1] / 2,
    })
    const right = nodesBuilder.powerRail({
      id: `right-rail-${id}`,
      posX: bounds[0],
      posY: bounds[1] / 2 - powerRail.height / 2,
      connector: 'left',
      handleX: bounds[0] - powerRail.width,
      handleY: bounds[1] / 2,
    })
    this.rung = {
      id,
      comment,
      defaultBounds: bounds,
      reactFlowViewport: bounds,
      nodes: [left, right],
      edges: [
        {
          id: `e_${left.id}_${right.id}`,
          source: left.id,
          target: right.id,
          sourceHandle: left.data.handles[0].id,
          targetHandle: right.data.handles[0].id,
          type: 'smoothstep',
        } as Edge,
      ],
      selectedNodes: [],
    } as unknown as RungLadderState
  }

  get leftRailId(): string {
    return this.rung.nodes[0].id
  }

  /** Solta `node` no marcador à direita (série) ou embaixo (paralelo) de `relatedId`. */
  private drop(relatedId: string, node: Node, position: 'right' | 'bottom'): { node: Node; close?: Node } {
    const related = this.rung.nodes.find((candidate) => candidate.id === relatedId)
    if (!related) throw new Unsupported(`elemento ${relatedId} não encontrado no degrau`)
    const placeholder = nodesBuilder.placeholder({
      id: `${position === 'bottom' ? 'parallelPlaceholder' : 'placeholder'}_${related.id}_${newGraphicalEditorNodeID('PH')}`,
      type: position === 'bottom' ? 'parallel' : 'default',
      relatedNode: related,
      position,
      ...getPlaceholderPositionBasedOnNode(related, position),
    }) as Node
    placeholder.selected = true
    const nodes = [...this.rung.nodes]
    nodes.splice(nodes.indexOf(related) + 1, 0, placeholder)
    const closesBefore = new Set(this.rung.nodes.filter((candidate) => candidate.type === 'parallel').map((candidate) => candidate.id))
    const result = addNewElement({ ...this.rung, nodes }, node)
    if (!result.newNode) throw new Unsupported('o OpenPLC recusou o elemento')
    this.rung = { ...this.rung, nodes: result.nodes, edges: result.edges }
    const close = result.nodes.find(
      (candidate) => candidate.type === 'parallel' && !closesBefore.has(candidate.id) && (candidate.data as { type?: string }).type === 'close',
    )
    return { node: result.newNode, ...(close ? { close } : {}) }
  }

  serial(afterId: string, node: Node): Node {
    return this.drop(afterId, node, 'right').node
  }

  parallel(belowId: string, node: Node): { node: Node; close: Node } {
    const result = this.drop(belowId, node, 'bottom')
    if (!result.close) throw new Unsupported('paralelo sem nó de fechamento')
    return { node: result.node, close: result.close }
  }
}

interface LdContext {
  blockVariant(typeName: string): BlockVariant | undefined
  /** Variável declarada no POU, como o editor do OpenPLC guarda nos elementos (tipo em maiúsculas). */
  variable(name: string): PLCVariable | undefined
}

/** Variável ou literal ligado a um bloco: a variável completa quando declarada, como o editor do
 * OpenPLC guarda (contatos e bobinas guardam só o nome), senão só o texto. */
function operand(context: LdContext, name: string): PLCVariable | { name: string } {
  return context.variable(name) ?? { name }
}

function elementNode(leaf: Leaf, context: LdContext): Node {
  const cell = leaf.cell
  const at = { posX: 0, posY: 0, handleX: 0, handleY: 0 }
  if (cell.kind === 'contact' || cell.kind === 'coil') {
    const node =
      cell.kind === 'contact'
        ? nodesBuilder.contact({ id: newGraphicalEditorNodeID('CONTACT'), ...at, variant: CONTACT_VARIANT[cell.contact] })
        : nodesBuilder.coil({ id: newGraphicalEditorNodeID('COIL'), ...at, variant: COIL_VARIANT[cell.coil] })
    node.data = { ...node.data, variable: { name: cell.variable } }
    return node as Node
  }
  if (cell.kind !== 'block') throw new Unsupported(`elemento ${cell.kind}`)
  const variant = context.blockVariant(cell.typeName)
  if (!variant) throw new Unsupported(`bloco ${cell.typeName} não existe nas bibliotecas do OpenPLC nem no projeto`)
  const executionControl = cell.powerInput.toUpperCase() === 'EN'
  const node = nodesBuilder.block({ id: newGraphicalEditorNodeID('BLOCK'), ...at, variant, executionControl }) as Node
  const data = node.data as {
    inputHandles: Array<{ id?: string }>
    outputHandles: Array<{ id?: string }>
    variant: BlockVariant
  }
  const same = (a: string | undefined, b: string) => (a ?? '').toUpperCase() === b.toUpperCase()
  if (!same(data.inputHandles[0]?.id, cell.powerInput) || !same(data.outputHandles[0]?.id, cell.powerOutput)) {
    throw new Unsupported(`${cell.typeName}: o degrau passa por ${cell.powerInput}/${cell.powerOutput}, o OpenPLC só pela primeira entrada e saída`)
  }
  const handleId = (handles: Array<{ id?: string }>, name: string) => handles.find((handle) => same(handle.id, name))?.id
  const connectedVariables = [
    ...Object.entries(cell.inputs ?? {}).map(([name, value]) => {
      const id = handleId(data.inputHandles, name)
      if (!id) throw new Unsupported(`${cell.typeName}: entrada ${name} desconhecida`)
      return { handleId: id, type: 'input' as const, variable: operand(context, value) }
    }),
    ...Object.entries(cell.outputs ?? {}).map(([name, value]) => {
      const id = handleId(data.outputHandles, name)
      if (!id) throw new Unsupported(`${cell.typeName}: saída ${name} desconhecida`)
      return { handleId: id, type: 'output' as const, variable: operand(context, value) }
    }),
  ]
  node.data = { ...node.data, variable: cell.instanceName ? operand(context, cell.instanceName) : { name: '' }, connectedVariables }
  return node
}

/** Monta `seq` à direita de `anchorId`; devolve o último nó (onde o próximo elemento entra). */
function placeSeq(builder: RungBuilder, seq: Seq, anchorId: string, context: LdContext): string {
  let anchor = anchorId
  for (const item of seq) anchor = placeItem(builder, item, anchor, context)
  return anchor
}

function placeItem(builder: RungBuilder, item: Item, anchorId: string, context: LdContext): string {
  const seed = builder.serial(anchorId, elementNode(firstLeaf(item), context))
  return completeItem(builder, item, seed.id, context)
}

/**
 * `item` com o primeiro elemento já no degrau (`seedId`): um paralelo nasce em volta desse
 * elemento (marcador de baixo) e cada ramo cresce para a direita, de fora para dentro.
 */
function completeItem(builder: RungBuilder, item: Item, seedId: string, context: LdContext): string {
  if (item.kind === 'leaf') return seedId
  const [main, ...others] = item.branches
  const rest: Seq = others.length === 1 ? others[0] : [{ kind: 'par', branches: others }]
  const { node: restSeed, close } = builder.parallel(seedId, elementNode(firstLeaf(rest[0]), context))
  completeSeq(builder, main, seedId, context)
  completeSeq(builder, rest, restSeed.id, context)
  return close.id
}

function completeSeq(builder: RungBuilder, seq: Seq, seedId: string, context: LdContext): string {
  let end = completeItem(builder, seq[0], seedId, context)
  for (const item of seq.slice(1)) end = placeItem(builder, item, end, context)
  return end
}

/** Área do degrau como o editor a calcula ao desenhar (rung/body.tsx, updateReactFlowPanelExtent). */
function withViewport(rung: RungLadderState): RungLadderState {
  const origin = { id: '-1', position: { x: 0, y: 0 }, data: {}, width: 150, height: 40 } as Node
  const bounds = getNodesBounds([origin, ...(rung.nodes as Node[])])
  const [width, height] = rung.defaultBounds as [number, number]
  // Nada selecionado nem sendo arrastado, como o editor grava (senão ele marca o POU modificado ao abrir).
  const nodes = rung.nodes.map((node) => ({ ...node, selected: false, dragging: false }))
  return {
    ...rung,
    nodes,
    selectedNodes: [],
    reactFlowViewport: [Math.max(bounds.width, width), Math.max(bounds.height, height) + 20],
  } as RungLadderState
}

function convertLdBody(pou: LegacyPou, context: LdContext): { name: string; rungs: RungLadderState[] } {
  const body = pou.implementation as Extract<LegacyPouBody, { language: 'ld' }>
  if (!body.rungs) throw new Unsupported('LD no formato antigo de redes')
  const rungs = body.rungs.map((rung) => {
    const seq = rungToSeq(rung)
    const builder = new RungBuilder(`rung_${pou.name}_${newGraphicalEditorNodeID('R').slice(2)}`, rung.comment ?? '')
    if (seq.length > 0) placeSeq(builder, seq, builder.leftRailId, context)
    return withViewport(builder.rung)
  })
  return { name: pou.name, rungs }
}

// ----- projeto -----

function iecInterval(ms: number | undefined): string {
  return `T#${Math.max(1, Math.round(ms ?? 20))}ms`
}

const POU_TYPE = { program: 'program', function: 'function', functionBlock: 'function-block' } as const

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Bloco ou função do projeto com o nome de um bloco das bibliotecas do OpenPLC (a OSCAT Basic tem
 * TOGGLE, por exemplo): as bibliotecas entram sempre na compilação e os dois colidiriam. O do projeto
 * ganha um sufixo e as referências (tipo das instâncias, blocos do LD, chamadas de função) seguem.
 */
function renameLibraryCollisions(project: LegacyIecProject, libraryNames: Set<string>, warnings: string[]): {
  project: LegacyIecProject
  renameText(text: string): string
  renameType(type: string): string
} {
  const taken = new Set([...libraryNames, ...project.pous.map((pou) => pou.name.toUpperCase())])
  const renames = new Map<string, string>()
  const functions = new Set<string>()
  for (const pou of project.pous) {
    if (pou.kind === 'program' || !libraryNames.has(pou.name.toUpperCase())) continue
    let index = 1
    while (taken.has(`${pou.name}_${index}`.toUpperCase())) index += 1
    const name = `${pou.name}_${index}`
    taken.add(name.toUpperCase())
    renames.set(pou.name.toUpperCase(), name)
    if (pou.kind === 'function') functions.add(pou.name.toUpperCase())
    warnings.push(`${pou.name}: as bibliotecas do OpenPLC já têm um bloco com esse nome; o do projeto passou a se chamar ${name}.`)
  }
  const renameType = (type: string) => renames.get(type.trim().toUpperCase()) ?? type
  const calls = [...functions].map((name) => [new RegExp(`\\b${escapeRegExp(name)}\\b`, 'gi'), renames.get(name)!] as const)
  const renameText = (text: string) => calls.reduce((current, [pattern, name]) => current.replace(pattern, name), text)
  if (renames.size === 0) return { project, renameText, renameType }
  const copy = JSON.parse(JSON.stringify(project)) as LegacyIecProject
  const renameVariables = (variables: LegacyVariable[]) => variables.forEach((variable) => (variable.type = renameType(variable.type)))
  for (const list of copy.globalVariableLists ?? []) renameVariables(list.variables)
  for (const pou of copy.pous) {
    pou.name = renames.get(pou.name.toUpperCase()) ?? pou.name
    renameVariables(pou.interface.variables)
    const body = pou.implementation as Record<string, unknown>
    if (typeof body.text === 'string') body.text = renameText(body.text)
    for (const rung of (body.rungs as LegacyLdRung[] | undefined) ?? []) {
      for (const row of rung.rows) for (const cell of row) if (cell?.kind === 'block') cell.typeName = renameType(cell.typeName)
    }
    for (const transition of (body.transitions as Array<{ condition?: string }> | undefined) ?? []) {
      if (typeof transition.condition === 'string') transition.condition = renameText(transition.condition)
    }
    for (const action of (body.actions as Array<{ text?: string }> | undefined) ?? []) {
      if (typeof action.text === 'string') action.text = renameText(action.text)
    }
  }
  return { project: copy, renameText, renameType }
}

export function convertLegacyIecProject(original: LegacyIecProject, options: LegacyConversionOptions): LegacyConversion {
  const warnings: string[] = []
  const libraryNames = new Set(options.systemLibraries.flatMap((lib) => lib.pous.map((block) => block.name.toUpperCase())))
  const { project, renameText, renameType } = renameLibraryCollisions(original, libraryNames, warnings)
  const userTypes = new Set((project.dataTypes ?? []).map((type) => type.name.toUpperCase()))

  // Variante de bloco para o LD: biblioteca do OpenPLC ou POU do próprio projeto (como body.tsx monta).
  const library = new Map<string, BlockVariant>()
  for (const lib of options.systemLibraries) for (const block of lib.pous) library.set(block.name.toUpperCase(), block)
  const projectBlocks = new Map<string, BlockVariant>()
  for (const pou of project.pous) {
    if (pou.kind === 'program') continue
    const variables = pou.interface.variables
      .filter((variable) => ['input', 'output', 'inOut'].includes(variable.class))
      .map((variable) => ({ name: variable.name, class: variable.class, type: { ...variableType(variable.type, userTypes), value: variable.type.toUpperCase() } }))
    if (pou.kind === 'function' && pou.interface.returnType) {
      variables.push({ name: 'OUT', class: 'output', type: { definition: 'derived', value: pou.interface.returnType.toUpperCase() } })
    }
    projectBlocks.set(pou.name.toUpperCase(), {
      name: pou.name,
      type: POU_TYPE[pou.kind],
      variables,
      documentation: '',
      extensible: false,
    } as unknown as BlockVariant)
  }
  const pous: PLCPou[] = project.pous.map((pou, pouIndex) => {
    const variables = pou.interface.variables.map((variable) => plcVariable(variable, userTypes))
    const declared = new Map(variables.map((variable) => [variable.name.toUpperCase(), variable]))
    const context: LdContext = {
      blockVariant: (typeName) => projectBlocks.get(typeName.toUpperCase()) ?? library.get(typeName.toUpperCase()),
      variable: (name) => {
        const variable = declared.get(name.trim().toUpperCase())
        return variable ? { ...variable, type: { ...variable.type, value: variable.type.value.toUpperCase() } } : undefined
      },
    }
    if (pou.interface.variables.some((variable) => variable.retain)) {
      warnings.push(`${pou.name}: RETAIN não existe no OpenPLC Editor; as variáveis ficaram sem RETAIN.`)
    }
    const base = {
      name: pou.name,
      pouType: POU_TYPE[pou.kind],
      interface: { ...(pou.interface.returnType ? { returnType: pou.interface.returnType } : {}), variables },
      documentation: '',
    }
    const asSt = (reason: string): PLCPou => {
      if (!options.fallbackSt) throw new Error(`${pou.name}: ${reason}`)
      // A tradução usa o projeto original (nomes de antes da troca); o texto recebe a troca depois.
      const fallback = options.fallbackSt(original.pous[pouIndex])
      warnings.push(`${pou.name}: ${reason}; o POU foi convertido para ST.`)
      return {
        ...base,
        interface: {
          ...base.interface,
          variables: [
            ...variables,
            ...fallback.variables.map((variable) => plcVariable({ ...variable, type: renameType(variable.type) }, userTypes, 'local')),
          ],
        },
        body: { language: 'st', value: renameText(fallback.text) },
      }
    }
    const body = pou.implementation
    switch (body.language) {
      case 'st':
      case 'il':
        return { ...base, body: { language: body.language, value: body.text } }
      case 'sfc':
        return { ...base, body: { language: 'sfc', value: normalizeSfcBody(body, pou.name) } }
      case 'ld':
        try {
          return { ...base, body: { language: 'ld', value: convertLdBody(pou, context) } }
        } catch (error) {
          if (!(error instanceof Unsupported)) throw error
          return asSt(`o LD usa ${error.message}, que o editor LD do OpenPLC não desenha`)
        }
      case 'fbd':
        return asSt('o FBD antigo do LasecSimul não tem equivalente direto no FBD do OpenPLC')
      default:
        throw new Error(`${pou.name}: linguagem desconhecida`)
    }
  })

  const dataTypes = (project.dataTypes ?? []).flatMap((type): unknown[] => {
    if (type.kind === 'enum') return [{ name: type.name, derivation: 'enumerated', values: type.values.map((description) => ({ description })) }]
    if (type.kind === 'struct') {
      return [{
        name: type.name,
        derivation: 'structure',
        variable: type.fields.map((field) => ({
          name: field.name,
          type: variableType(field.type, userTypes),
          ...(field.initialValue ? { initialValue: { simpleValue: { value: field.initialValue } } } : {}),
        })),
      }]
    }
    if (type.kind === 'array') {
      return [{
        name: type.name,
        derivation: 'array',
        baseType: variableType(type.elementType, userTypes),
        dimensions: type.dimensions.map((dimension) => ({ dimension })),
      }]
    }
    warnings.push(`Tipo ${type.name}: o OpenPLC Editor não tem tipo apelido (TYPE ${type.name} : ${type.baseType}); use ${type.baseType}.`)
    return []
  })

  const lists = project.globalVariableLists ?? []
  if (lists.length > 1) warnings.push('As listas de variáveis globais viraram uma só (o OpenPLC tem uma lista por recurso).')
  const globalVariables = lists.flatMap((list) => list.variables.map((variable) => plcVariable(variable, userTypes, 'global')))

  const tasks = (project.tasks ?? []).map((task, index) => ({
    name: task.name,
    triggering: 'Cyclic' as const,
    interval: iecInterval(task.intervalMs),
    priority: task.priority ?? index + 1,
  }))
  const byId = new Map(project.pous.map((pou) => [pou.pouId, pou.name]))
  const instances = (project.programInstances ?? []).flatMap((instance) => {
    const program = byId.get(instance.pouId)
    return program ? [{ name: instance.name, program, task: instance.task ?? tasks[0]?.name ?? 'task0' }] : []
  })
  if (tasks.length === 0) tasks.push({ name: 'task0', triggering: 'Cyclic', interval: 'T#20ms', priority: 1 })
  if (instances.length === 0) {
    const main = project.pous.find((pou) => pou.kind === 'program')
    if (main) instances.push({ name: 'instance0', program: main.name, task: tasks[0].name })
  }

  return { name: project.projectId, pous, dataTypes, tasks, instances, globalVariables, warnings }
}
