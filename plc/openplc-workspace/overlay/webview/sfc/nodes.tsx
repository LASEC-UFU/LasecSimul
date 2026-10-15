// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Nós e ligações do editor SFC, no visual dos nós FBD do OpenPLC Editor (borda neutral-850, fundo
 * branco/neutral-900, anel `brand` na seleção, texto xs). Passo: retângulo com o nome (o inicial
 * tem borda dupla, IEC 61131-3 fig. 15) e, à direita, os blocos de ação (qualificador | ação |
 * duração). Transição: barra horizontal com a condição ST ao lado.
 */

import { cn } from '@root/frontend/utils/cn'
import { toast } from '@root/frontend/utils/toast'
import { BaseEdge, type EdgeProps, getSmoothStepPath, Handle, type NodeProps, Position } from '@xyflow/react'
import { type ChangeEvent, type KeyboardEvent, memo, useEffect, useRef, useState } from 'react'

import {
  IEC_IDENTIFIER,
  SFC_QUALIFIERS,
  SFC_STEP_HEIGHT,
  SFC_STEP_WIDTH,
  SFC_TIMED_QUALIFIERS,
  SFC_TRANSITION_HEIGHT,
  SFC_TRANSITION_WIDTH,
  type SfcQualifier,
} from '../../shared/sfc'
import { useSfcEditor } from './context'
import { addAssociation, removeAssociation, renameStep, setCondition, updateAssociation } from './mutations'

const ACTIVE = '#00FF00'
const handleClass = '!h-2 !w-2 !min-h-0 !min-w-0 !rounded-full !border !border-neutral-850 !bg-white dark:!bg-neutral-900'

/**
 * Campo de texto do diagrama: grava uma vez, ao perder o foco (Enter só tira o foco; Escape volta o
 * valor e não grava). `onCommit` devolve false quando recusa o texto (o campo volta ao valor salvo).
 */
function useEditableText(value: string, onCommit: (text: string) => boolean | void) {
  const [text, setText] = useState(value)
  const cancelled = useRef(false)
  useEffect(() => setText(value), [value])
  return {
    value: text,
    onChange: (event: ChangeEvent<HTMLInputElement>) => setText(event.target.value),
    onBlur: () => {
      if (cancelled.current) {
        cancelled.current = false
        setText(value)
        return
      }
      if (text !== value && onCommit(text) === false) setText(value)
    },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        event.currentTarget.blur()
      } else if (event.key === 'Escape') {
        cancelled.current = true
        event.currentTarget.blur()
      }
    },
  }
}

const StepActions = ({ stepId }: { stepId: string }) => {
  const { body, commit, readOnly, booleanVariables } = useSfcEditor()
  const step = body.steps.find((item) => item.stepId === stepId)
  if (!step) return null
  const listId = `sfc-actions-${stepId}`
  const choices = [...body.actions.map((action) => action.name), ...booleanVariables]
  return (
    <div className='flex items-start' style={{ marginTop: (SFC_STEP_HEIGHT - 24) / 2 }}>
      {step.actions.length > 0 && <div className='mt-3 h-px w-4 bg-neutral-850 dark:bg-neutral-400' />}
      <div className='flex flex-col'>
        <datalist id={listId}>
          {choices.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        {step.actions.map((association) => {
          const qualifier = (association.qualifier ?? 'N') as SfcQualifier
          const timed = SFC_TIMED_QUALIFIERS.includes(qualifier)
          return (
            <div
              key={association.actionId}
              className='group/action flex h-6 items-stretch border border-b-0 border-neutral-850 bg-white text-xs text-neutral-1000 last:border-b dark:border-neutral-400 dark:bg-neutral-900 dark:text-neutral-50'
            >
              <select
                aria-label='Action qualifier'
                className='nodrag w-10 border-r border-neutral-850 bg-transparent px-1 text-center outline-none dark:border-neutral-400 dark:bg-neutral-900'
                value={qualifier}
                disabled={readOnly}
                onChange={(event) => commit(updateAssociation(body, stepId, association.actionId, { qualifier: event.target.value as SfcQualifier }))}
              >
                {SFC_QUALIFIERS.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
              <AssociationText
                ariaLabel='Action name'
                className='w-28'
                listId={listId}
                value={association.actionName ?? ''}
                placeholder='???'
                readOnly={readOnly}
                onCommit={(value) => commit(updateAssociation(body, stepId, association.actionId, { actionName: value.trim() }))}
              />
              {timed && (
                <AssociationText
                  ariaLabel='Action time'
                  className='w-16 border-l border-neutral-850 dark:border-neutral-400'
                  value={association.time ?? ''}
                  placeholder='T#1s'
                  readOnly={readOnly}
                  onCommit={(value) => commit(updateAssociation(body, stepId, association.actionId, { time: value.trim() }))}
                />
              )}
              {!readOnly && (
                <button
                  type='button'
                  aria-label='Remove action'
                  className='nodrag hidden w-5 items-center justify-center text-neutral-500 hover:text-red-500 group-hover/action:flex'
                  onClick={() => commit(removeAssociation(body, stepId, association.actionId))}
                >
                  ×
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

const AssociationText = ({
  ariaLabel,
  className,
  listId,
  value,
  placeholder,
  readOnly,
  onCommit,
}: {
  ariaLabel: string
  className: string
  listId?: string
  value: string
  placeholder: string
  readOnly: boolean
  onCommit: (value: string) => void
}) => {
  const editable = useEditableText(value, onCommit)
  return (
    <input
      aria-label={ariaLabel}
      className={cn('nodrag bg-transparent px-1 text-center outline-none placeholder:text-neutral-400', className)}
      list={listId}
      placeholder={placeholder}
      readOnly={readOnly}
      {...editable}
    />
  )
}

export const StepNode = memo(({ id, selected }: NodeProps) => {
  const { body, commit, readOnly, debug, openContextMenu } = useSfcEditor()
  const step = body.steps.find((item) => item.stepId === id)
  const name = useEditableText(step?.name ?? '', (text) => {
    const next = text.trim()
    if (!step || next === step.name) return false
    const clash = [...body.steps.filter((item) => item.stepId !== id).map((item) => item.name), ...body.actions.map((action) => action.name)]
      .some((other) => other.toUpperCase() === next.toUpperCase())
    if (!IEC_IDENTIFIER.test(next) || clash) {
      toast({ title: 'Invalid step name', description: clash ? `${next} is already used in this SFC.` : `${next} is not a valid IEC identifier.`, variant: 'fail' })
      return false
    }
    commit(renameStep(body, id, next))
  })
  if (!step) return null
  const state = debug[step.name.toUpperCase()]
  const active = !!state?.active

  return (
    <div className='flex items-start' onContextMenu={(event) => {
      event.preventDefault()
      if (!readOnly) openContextMenu('step', id, event.clientX, event.clientY)
    }}>
      <div
        className={cn(
          'relative flex items-center justify-center rounded-md border bg-white text-neutral-1000 dark:bg-neutral-900 dark:text-neutral-50',
          'border-neutral-850 hover:border-transparent hover:ring-2 hover:ring-brand dark:border-neutral-400',
          { 'border-transparent ring-2 ring-brand': selected },
        )}
        style={{
          width: SFC_STEP_WIDTH,
          height: SFC_STEP_HEIGHT,
          ...(active ? { borderColor: ACTIVE, boxShadow: `0 0 0 2px ${ACTIVE}`, background: 'rgba(0, 255, 0, 0.12)' } : {}),
        }}
        data-sfc-step={step.name}
        data-sfc-active={active ? 'true' : 'false'}
      >
        {step.initial && (
          <div className='pointer-events-none absolute inset-[3px] rounded-[4px] border border-neutral-850 dark:border-neutral-400' />
        )}
        <Handle id='in' type='target' position={Position.Top} className={handleClass} isConnectable={!readOnly} />
        <input
          aria-label='Step name'
          className='nodrag z-[1] w-[88px] bg-transparent text-center text-xs font-medium outline-none'
          readOnly={readOnly}
          {...name}
        />
        {state?.time && <span className='absolute -bottom-4 left-0 text-[10px] text-neutral-500'>{state.time}</span>}
        <Handle id='out' type='source' position={Position.Bottom} className={handleClass} isConnectable={!readOnly} />
      </div>
      <StepActions stepId={id} />
      {!readOnly && selected && (
        <button
          type='button'
          aria-label='Add action block'
          title='Add action block'
          className='nodrag ml-1 mt-3 flex h-5 w-5 items-center justify-center rounded border border-neutral-850 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-400 dark:text-neutral-300 dark:hover:bg-neutral-800'
          onClick={() => commit(addAssociation(body, id))}
        >
          +
        </button>
      )}
    </div>
  )
})
StepNode.displayName = 'SfcStepNode'

export const TransitionNode = memo(({ id, selected }: NodeProps) => {
  const { body, commit, readOnly, openContextMenu } = useSfcEditor()
  const transition = body.transitions.find((item) => item.transitionId === id)
  const condition = useEditableText(transition?.condition ?? '', (text) => {
    commit(setCondition(body, id, text.trim()))
  })
  if (!transition) return null
  return (
    <div
      className='relative flex items-center justify-center'
      style={{ width: SFC_TRANSITION_WIDTH, height: SFC_TRANSITION_HEIGHT }}
      onContextMenu={(event) => {
        event.preventDefault()
        if (!readOnly) openContextMenu('transition', id, event.clientX, event.clientY)
      }}
    >
      <Handle id='in' type='target' position={Position.Top} className={handleClass} isConnectable={!readOnly} />
      <div className='absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-neutral-850 dark:bg-neutral-400' />
      <div
        className={cn('z-[1] h-1 w-full rounded-sm bg-neutral-850 dark:bg-neutral-300', {
          'ring-2 ring-brand ring-offset-2 dark:ring-offset-neutral-950': selected,
        })}
      />
      {transition.priority !== undefined && (
        <span className='absolute -left-5 text-[10px] text-neutral-500' title='Priority (selective divergence)'>
          {transition.priority}
        </span>
      )}
      <input
        aria-label='Transition condition'
        className='nodrag absolute left-full ml-2 w-56 bg-transparent font-mono text-xs text-neutral-1000 outline-none placeholder:text-neutral-400 dark:text-neutral-50'
        placeholder='condition'
        readOnly={readOnly}
        {...condition}
      />
      <Handle id='out' type='source' position={Position.Bottom} className={handleClass} isConnectable={!readOnly} />
    </div>
  )
})
TransitionNode.displayName = 'SfcTransitionNode'

/** Ligação ortogonal; nas divergências/convergências simultâneas, linha dupla (IEC 61131-3 fig. 16). */
export const SfcEdge = memo((props: EdgeProps) => {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, markerEnd } = props
  const [path] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 0, offset: 16 })
  const double = !!(data as { double?: boolean } | undefined)?.double
  const active = !!(data as { active?: boolean } | undefined)?.active
  const stroke = active ? ACTIVE : selected ? 'var(--primary-default, #0464FB)' : undefined
  return (
    <>
      <BaseEdge path={path} markerEnd={markerEnd} style={{ strokeWidth: double ? 5 : 1.5, ...(stroke ? { stroke } : {}) }} />
      {double && <path d={path} fill='none' className='stroke-white dark:stroke-neutral-950' strokeWidth={2} />}
    </>
  )
})
SfcEdge.displayName = 'SfcEdge'
