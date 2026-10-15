// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Editor SFC (IEC 61131-3 3ª ed., 6.7) dentro do OpenPLC Editor. Ocupa o lugar do stub
 * `editor/graphical/SFC` do OpenPLC (que até a versão de desenvolvimento só mostra um texto) com o
 * mesmo arranjo dos editores FBD/LD: canvas React Flow (ReactFlowPanel do OpenPLC, grade, zoom),
 * elementos arrastados da barra lateral, ligações puxadas entre as alças, Delete apaga a seleção,
 * desfazer/refazer pelo histórico de snapshots do OpenPLC e, com o depurador aberto, os passos
 * ativos do CLP da simulação em verde.
 *
 * O corpo (passos, transições, ações, posições) mora no `pou.body.value` do store do OpenPLC, como
 * o dos POUs LD/FBD; o salvar do OpenPLC o grava no arquivo `.sfc` do POU.
 */

import { ReactFlowPanel } from '@root/frontend/components/_atoms/react-flow'
import { useBoundPou } from '@root/frontend/components/_features/[workspace]/editor/graphical/active-context'
import { openPLCStoreBase, useOpenPLCStore } from '@root/frontend/store'
import { toast } from '@root/frontend/utils/toast'
import {
  type Connection,
  type Edge,
  MarkerType,
  type Node,
  type NodeChange,
  type ReactFlowInstance,
  SelectionMode,
  useNodesState,
} from '@xyflow/react'
import { type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { invokeHost } from '../bridge'
import { normalizeSfcBody, type SfcBody, withLeftToRightPriorities } from '../../shared/sfc'
import { SfcActionsPanel } from './actions-panel'
import { SFC_DRAG_TYPE, SfcEditorContext, type SfcEditorState, type SfcStepDebugState } from './context'
import {
  addAssociation,
  addStep,
  addTransition,
  connect,
  edgeId,
  elementKind,
  isValidConnection,
  moveElements,
  removeElements,
  setInitialStep,
} from './mutations'
import { SfcEdge, StepNode, TransitionNode } from './nodes'

const nodeTypes = { sfcStep: StepNode, sfcTransition: TransitionNode }
const edgeTypes = { sfc: SfcEdge }

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value ?? null)) as T

function buildNodes(body: SfcBody, readOnly: boolean, selected: Set<string>): Node[] {
  return [
    ...body.steps.map((step) => ({
      id: step.stepId,
      type: 'sfcStep',
      position: body.layout[step.stepId] ?? { x: 0, y: 0 },
      data: {},
      draggable: !readOnly,
      selected: selected.has(step.stepId),
    })),
    ...body.transitions.map((transition) => ({
      id: transition.transitionId,
      type: 'sfcTransition',
      position: body.layout[transition.transitionId] ?? { x: 0, y: 0 },
      data: {},
      draggable: !readOnly,
      selected: selected.has(transition.transitionId),
    })),
  ]
}

function buildEdges(body: SfcBody, debug: Record<string, SfcStepDebugState>): Edge[] {
  const edges: Edge[] = []
  const stepName = new Map(body.steps.map((step) => [step.stepId, step.name.toUpperCase()]))
  const above = (source: string, target: string) => (body.layout[target]?.y ?? 0) < (body.layout[source]?.y ?? 0)
  for (const transition of body.transitions) {
    const convergence = transition.fromStepIds.length > 1
    const divergence = transition.toStepIds.length > 1
    for (const step of transition.fromStepIds) {
      edges.push({
        id: edgeId(step, transition.transitionId),
        source: step,
        sourceHandle: 'out',
        target: transition.transitionId,
        targetHandle: 'in',
        type: 'sfc',
        data: { double: convergence, active: !!debug[stepName.get(step) ?? '']?.active },
        ...(above(step, transition.transitionId) ? { markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 } } : {}),
      })
    }
    for (const step of transition.toStepIds) {
      edges.push({
        id: edgeId(transition.transitionId, step),
        source: transition.transitionId,
        sourceHandle: 'out',
        target: step,
        targetHandle: 'in',
        type: 'sfc',
        data: { double: divergence },
        ...(above(transition.transitionId, step) ? { markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 } } : {}),
      })
    }
  }
  return edges
}

interface ContextMenuState {
  kind: 'step' | 'transition'
  id: string
  x: number
  y: number
}

export default function SfcEditor() {
  const pouName = useBoundPou()
  const pou = useOpenPLCStore((state) => state.project.data.pous.find((item) => item.name === pouName))
  const isDebuggerVisible = useOpenPLCStore((state) => state.workspace.isDebuggerVisible)
  const readOnly = isDebuggerVisible
  const body = useMemo(() => normalizeSfcBody(pou?.body.value, pouName), [pou?.body.value, pouName])
  const containerRef = useRef<HTMLDivElement>(null)
  const [instance, setInstance] = useState<ReactFlowInstance | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [debug, setDebug] = useState<Record<string, SfcStepDebugState>>({})
  const [menu, setMenu] = useState<ContextMenuState | undefined>()
  const [showActions, setShowActions] = useState(false)

  const booleanVariables = useMemo(
    () => (pou?.interface?.variables ?? [])
      .filter((variable) => (variable.class === 'local' || variable.class === 'output') && variable.type?.value?.toUpperCase() === 'BOOL')
      .map((variable) => variable.name),
    [pou?.interface?.variables],
  )

  /** Grava o corpo novo no POU do OpenPLC, com snapshot para desfazer e a aba como "modificada". */
  const commit = useCallback(
    (next: SfcBody) => {
      const state = openPLCStoreBase.getState()
      const current = state.project.data.pous.find((item) => item.name === pouName)
      if (!current) return
      state.snapshotActions.pushToHistory(pouName, {
        variables: clone(current.interface?.variables ?? []),
        body: clone(current.body.value),
        globalVariables: clone(state.project.data.configurations.resource.globalVariables),
      })
      state.projectActions.updatePou({ name: pouName, content: { language: 'sfc', value: withLeftToRightPriorities(next) } as never })
      state.sharedWorkspaceActions.handleFileAndWorkspaceSavedState(pouName)
    },
    [pouName],
  )

  // POU recém-criado pelo OpenPLC chega com corpo '' (ou sem posições): grava o corpo completo
  // uma vez, sem histórico, para o salvar já sair no formato do editor.
  useEffect(() => {
    if (!pou) return
    const value = pou.body.value as Partial<SfcBody> | string
    if (typeof value === 'object' && value && Array.isArray(value.steps) && value.layout) return
    openPLCStoreBase.getState().projectActions.updatePou({ name: pouName, content: { language: 'sfc', value: body } as never })
  }, [pou, pouName, body])

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  useEffect(() => {
    setNodes(buildNodes(body, readOnly, selected))
  }, [body, readOnly, setNodes])
  const edges = useMemo(() => buildEdges(body, debug), [body, debug])

  const handleNodesChange = useCallback(
    (changes: NodeChange<Node>[]) => {
      onNodesChange(changes)
      const selection = changes.filter((change) => change.type === 'select')
      if (selection.length > 0) {
        setSelected((previous) => {
          const next = new Set(previous)
          for (const change of selection) {
            if (change.type !== 'select') continue
            if (change.selected) next.add(change.id)
            else next.delete(change.id)
          }
          return next
        })
      }
    },
    [onNodesChange],
  )

  // Depurador aberto: estado dos passos lido do CLP da simulação.
  const stepNames = useMemo(() => body.steps.map((step) => step.name), [body.steps])
  useEffect(() => {
    if (!isDebuggerVisible) {
      setDebug({})
      return
    }
    let stopped = false
    const poll = async () => {
      try {
        const reply = await invokeHost<{ states?: Record<string, SfcStepDebugState> }>('lasecSfcState', [pouName, stepNames])
        if (!stopped) setDebug(reply.states ?? {})
      } catch {
        /* simulação parada: mantém o último estado */
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 300)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [isDebuggerVisible, pouName, stepNames])

  const onDragOver = useCallback((event: DragEvent) => {
    if (!event.dataTransfer.types.includes(SFC_DRAG_TYPE)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback(
    (event: DragEvent) => {
      const tool = event.dataTransfer.getData(SFC_DRAG_TYPE)
      if (!tool || !instance || readOnly) return
      event.preventDefault()
      const at = instance.screenToFlowPosition({ x: event.clientX, y: event.clientY })
      if (tool === 'step' || tool === 'initial-step') {
        commit(addStep(body, at, { initial: tool === 'initial-step', extraNames: booleanVariables }))
      } else if (tool === 'transition') {
        commit(addTransition(body, at))
      } else if (tool === 'action') {
        const target = instance
          .getIntersectingNodes({ x: at.x - 4, y: at.y - 4, width: 8, height: 8 })
          .find((node) => elementKind(body, node.id) === 'step')
        if (!target) {
          toast({ title: 'Action block', description: 'Drop the action block on a step.', variant: 'warn' })
          return
        }
        commit(addAssociation(body, target.id))
      }
    },
    [instance, readOnly, body, commit, booleanVariables],
  )

  const state: SfcEditorState = useMemo(
    () => ({
      pouName,
      body,
      readOnly,
      debug,
      booleanVariables,
      commit,
      openContextMenu: (kind, id, x, y) => {
        const rect = containerRef.current?.getBoundingClientRect()
        setMenu({ kind, id, x: x - (rect?.left ?? 0), y: y - (rect?.top ?? 0) })
      },
    }),
    [pouName, body, readOnly, debug, booleanVariables, commit],
  )

  const menuStep = menu?.kind === 'step' ? body.steps.find((step) => step.stepId === menu.id) : undefined

  return (
    <SfcEditorContext.Provider value={state}>
      <div
        ref={containerRef}
        className='relative flex h-full w-full gap-2 rounded-lg border p-1 dark:border-neutral-800'
        data-lasec-sfc-editor={pouName}
        onClick={() => setMenu(undefined)}
      >
        <div className='relative h-full min-w-0 flex-1'>
          <ReactFlowPanel
            key='sfc-react-flow'
            background={true}
            backgroundConfig={{ id: `sfc-bg-${pouName}` }}
            controls={true}
            controlsConfig={{ showInteractive: false }}
            viewportConfig={{
              onInit: setInstance,
              nodeTypes,
              edgeTypes,
              nodes,
              edges,
              fitView: true,
              fitViewOptions: { padding: 0.25, maxZoom: 1 },
              minZoom: 0.25,
              maxZoom: 2,
              nodesDraggable: !readOnly,
              nodesConnectable: !readOnly,
              elementsSelectable: true,
              selectionMode: SelectionMode.Partial,
              snapGrid: [16, 16],
              snapToGrid: true,
              onNodesChange: handleNodesChange,
              isValidConnection: (connection) => isValidConnection(body, connection.source, connection.target),
              onConnect: readOnly ? undefined : (connection: Connection) => commit(connect(body, connection.source, connection.target)),
              onDelete: readOnly
                ? undefined
                : ({ nodes: deletedNodes, edges: deletedEdges }) => {
                    if (deletedNodes.length === 0 && deletedEdges.length === 0) return
                    commit(removeElements(body, deletedNodes.map((node) => node.id), deletedEdges.map((edge) => edge.id)))
                  },
              onNodeDragStop: readOnly
                ? undefined
                : (_event, _node, dragged) => commit(moveElements(body, dragged.map((node) => ({ id: node.id, position: node.position })))),
              onDragOver,
              onDrop,
              proOptions: { hideAttribution: true },
            }}
          />
          <button
            type='button'
            aria-label='Toggle SFC actions'
            className='absolute right-2 top-2 z-10 rounded-md border border-neutral-200 bg-white px-2 py-1 font-caption text-xs text-neutral-850 hover:bg-neutral-100 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800'
            onClick={(event) => {
              event.stopPropagation()
              setShowActions((value) => !value)
            }}
          >
            Actions ({body.actions.length})
          </button>
        </div>
        {showActions && <SfcActionsPanel onClose={() => setShowActions(false)} />}
        {menu && (
          <div
            className='absolute z-50 flex w-44 flex-col rounded-lg border border-neutral-200 bg-white py-1 text-xs text-neutral-850 shadow-lg dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300'
            style={{ left: menu.x, top: menu.y }}
            onClick={(event) => event.stopPropagation()}
          >
            {menu.kind === 'step' && (
              <>
                <button
                  type='button'
                  className='px-3 py-1 text-left hover:bg-neutral-100 disabled:opacity-40 dark:hover:bg-neutral-900'
                  disabled={!!menuStep?.initial}
                  onClick={() => {
                    commit(setInitialStep(body, menu.id))
                    setMenu(undefined)
                  }}
                >
                  Initial step
                </button>
                <button
                  type='button'
                  className='px-3 py-1 text-left hover:bg-neutral-100 dark:hover:bg-neutral-900'
                  onClick={() => {
                    commit(addAssociation(body, menu.id))
                    setMenu(undefined)
                  }}
                >
                  Add action block
                </button>
              </>
            )}
            <button
              type='button'
              className='px-3 py-1 text-left text-red-500 hover:bg-neutral-100 dark:hover:bg-neutral-900'
              onClick={() => {
                commit(removeElements(body, [menu.id], []))
                setMenu(undefined)
              }}
            >
              Delete {menu.kind}
            </button>
          </div>
        )}
      </div>
    </SfcEditorContext.Provider>
  )
}
