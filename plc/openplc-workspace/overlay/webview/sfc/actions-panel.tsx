// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Ações nomeadas do POU SFC (IEC 61131-3 6.7.4): lista à direita do diagrama; a ação escolhida
 * abre no Monaco com os temas do OpenPLC (openplc-light/openplc-dark), corpo em ST ou IL.
 */

import { Editor } from '@monaco-editor/react'
import { useOpenPLCStore } from '@root/frontend/store'
import { cn } from '@root/frontend/utils/cn'
import { toast } from '@root/frontend/utils/toast'
import { useEffect, useRef, useState } from 'react'

import { IEC_IDENTIFIER, type SfcAction } from '../../shared/sfc'
import { useSfcEditor } from './context'
import { addNamedAction, removeNamedAction, renameNamedAction, updateNamedAction } from './mutations'

const ActionBody = ({ action }: { action: SfcAction }) => {
  const { body, commit, readOnly } = useSfcEditor()
  const dark = useOpenPLCStore((state) => state.workspace.systemConfigs.shouldUseDarkMode)
  const text = useRef(action.text)
  // O blur do Monaco é registrado uma vez: lê sempre o corpo e a ação atuais.
  const latest = useRef({ body, commit, action })
  latest.current = { body, commit, action }
  useEffect(() => {
    text.current = action.text
  }, [action.text])
  return (
    <div className='h-full min-h-0 flex-1 overflow-hidden rounded-md border border-neutral-200 dark:border-neutral-800'>
      <Editor
        key={`${action.name}-${action.language}`}
        language={action.language}
        theme={dark ? 'openplc-dark' : 'openplc-light'}
        defaultValue={action.text}
        options={{ minimap: { enabled: false }, fontSize: 12, lineNumbersMinChars: 3, readOnly, automaticLayout: true, scrollBeyondLastLine: false }}
        onChange={(value) => {
          text.current = value ?? ''
        }}
        onMount={(editor) => {
          editor.onDidBlurEditorText(() => {
            const { body: currentBody, commit: save, action: currentAction } = latest.current
            if (text.current !== currentAction.text) save(updateNamedAction(currentBody, currentAction.name, { text: text.current }))
          })
        }}
      />
    </div>
  )
}

export const SfcActionsPanel = ({ onClose }: { onClose: () => void }) => {
  const { body, commit, readOnly, booleanVariables } = useSfcEditor()
  const [selected, setSelected] = useState<string | undefined>(body.actions[0]?.name)
  const [editing, setEditing] = useState<string | undefined>()
  const [draft, setDraft] = useState('')
  const current = body.actions.find((action) => action.name === selected) ?? body.actions[0]

  const rename = (oldName: string) => {
    const next = draft.trim()
    setEditing(undefined)
    if (!next || next === oldName) return
    const clash = [...body.actions.filter((action) => action.name !== oldName).map((action) => action.name), ...body.steps.map((step) => step.name), ...booleanVariables]
      .some((name) => name.toUpperCase() === next.toUpperCase())
    if (!IEC_IDENTIFIER.test(next) || clash) {
      toast({ title: 'Invalid action name', description: clash ? `${next} is already used.` : `${next} is not a valid IEC identifier.`, variant: 'fail' })
      return
    }
    commit(renameNamedAction(body, oldName, next))
    setSelected(next)
  }

  return (
    <div className='flex h-full w-[320px] shrink-0 flex-col gap-2 border-l border-neutral-200 pl-2 dark:border-neutral-800'>
      <div className='flex items-center justify-between'>
        <span className='font-caption text-xs font-medium text-neutral-1000 dark:text-neutral-50'>Actions</span>
        <div className='flex items-center gap-1'>
          {!readOnly && (
            <button
              type='button'
              aria-label='New action'
              className='rounded px-2 py-0.5 text-xs text-brand hover:bg-neutral-100 dark:hover:bg-neutral-800'
              onClick={() => {
                const created = addNamedAction(body, booleanVariables)
                commit(created.body)
                setSelected(created.name)
              }}
            >
              + Action
            </button>
          )}
          <button type='button' aria-label='Close actions' className='rounded px-1 text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800' onClick={onClose}>
            ×
          </button>
        </div>
      </div>
      <div className='flex max-h-36 flex-col overflow-y-auto'>
        {body.actions.length === 0 && (
          <span className='px-1 text-xs text-neutral-500'>No named actions. Action blocks can also drive BOOL variables directly.</span>
        )}
        {body.actions.map((action) => (
          <div
            key={action.name}
            className={cn('group flex h-7 items-center gap-1 rounded px-1 text-xs text-neutral-850 dark:text-neutral-300', {
              'bg-neutral-100 dark:bg-neutral-800': current?.name === action.name,
            })}
            onClick={() => setSelected(action.name)}
          >
            {editing === action.name ? (
              <input
                aria-label='Action name'
                autoFocus
                className='flex-1 bg-transparent outline-none'
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={() => rename(action.name)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') rename(action.name)
                  if (event.key === 'Escape') setEditing(undefined)
                }}
              />
            ) : (
              <span
                className='flex-1 truncate'
                onDoubleClick={() => {
                  if (readOnly) return
                  setEditing(action.name)
                  setDraft(action.name)
                }}
              >
                {action.name}
              </span>
            )}
            <select
              aria-label='Action language'
              className='bg-transparent text-xs uppercase outline-none'
              value={action.language}
              disabled={readOnly}
              onChange={(event) => commit(updateNamedAction(body, action.name, { language: event.target.value as 'st' | 'il' }))}
            >
              <option value='st'>ST</option>
              <option value='il'>IL</option>
            </select>
            {!readOnly && (
              <button
                type='button'
                aria-label='Delete action'
                className='invisible px-1 text-neutral-500 hover:text-red-500 group-hover:visible'
                onClick={(event) => {
                  event.stopPropagation()
                  commit(removeNamedAction(body, action.name))
                }}
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>
      {current && <ActionBody action={current} />}
    </div>
  )
}
