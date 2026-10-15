// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Entrada do OpenPLC Editor (v4.2.8) dentro de uma aba do VS Code.
 *
 * Mesmo arranjo de src/main.tsx + src/App.tsx do OpenPLC: estilos, temas do Monaco, bibliotecas
 * .stlib, LSP da STruC++ e a WorkspaceScreen inteira (explorer, abas, editores LD/FBD/ST/IL,
 * variáveis, biblioteca, console). Muda só o que é da plataforma: portas (./ports), moldura sem
 * barra de título (./app-layout), projeto aberto pelo host em vez da tela inicial, salvar e
 * desfazer vindos do VS Code.
 */

// Antes de tudo: o ambiente de workers do Monaco precisa existir quando o editor carregar.
import './workers'
import '@root/frontend/locales/i18n'
import '@xyflow/react/dist/style.css'
import 'tailwindcss/tailwind.css'
import '@root/backend/shared/styles/globals.css'
import '@root/frontend/components/_features/[workspace]/editor/monaco/configs'
import './lasecsimul.css'

import { WorkspaceScreen } from '@root/frontend/screens/workspace-screen'
import { executeSaveProject } from '@root/frontend/services/save-actions'
import { bootStLsp } from '@root/frontend/services/st-lsp/boot'
import { openPLCStoreBase, useOpenPLCStore } from '@root/frontend/store'
import { stlibsToSystemLibraries } from '@root/frontend/utils/stlib-to-system-library'
import { PlatformProvider } from '@root/middleware/shared/providers'
import { ReactNode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import strucppWorkerAsset from 'strucpp/dist/browser-server.js?url'

import { LasecAppLayout } from './app-layout'
import { emitBridgeEvent, invokeHost, notifyHost, onHostEvent } from './bridge'
import { connectLasecRuntime, lasecPorts, LASECSIMUL_CAPABILITIES } from './ports'
import { workerBlobUrl } from './workers'

interface LasecBootConfig {
  projectPath: string
}

const boot = (window as unknown as { __LASECSIMUL_OPENPLC__?: LasecBootConfig }).__LASECSIMUL_OPENPLC__ ?? {
  projectPath: '',
}

// Bibliotecas .stlib (as mesmas do OpenPLC) entram no store antes da primeira árvore aparecer.
const hydrateLibraries = (): void => {
  Promise.all([lasecPorts.library.loadAll(), lasecPorts.library.listInstalled()])
    .then(([archives, installed]) => {
      const actions = openPLCStoreBase.getState().libraryActions
      actions.setSystemLibraries(stlibsToSystemLibraries(archives))
      actions.setBundledLibraryNames(installed.filter((library) => library.bundled).map((library) => library.name))
    })
    .catch((error) => console.error('Falha ao carregar as bibliotecas .stlib:', error))
}
hydrateLibraries()
lasecPorts.library.onLibrariesChanged(() => hydrateLibraries())

void Promise.all([import('monaco-editor'), workerBlobUrl(strucppWorkerAsset)])
  .then(([monaco, workerUrl]) => bootStLsp(lasecPorts, monaco, workerUrl))
  .catch((error) => console.error('LSP da STruC++ indisponível:', error))

/** Salvar pedido pelo VS Code (Ctrl+S, fechar com alterações): mesmo fluxo do menu File → Save. */
onHostEvent('lasecSaveRequest', (_event: unknown, requestId: unknown) => {
  void executeSaveProject(lasecPorts.project, LASECSIMUL_CAPABILITIES).then(
    (result) => notifyHost('lasecSaveDone', [requestId, result.success]),
    () => notifyHost('lasecSaveDone', [requestId, false]),
  )
})

/** Projeto alterado fora do editor (ex.: revert do VS Code): relê do disco. */
onHostEvent('lasecReloadProject', () => {
  const counters = window as unknown as { __lasecReloads?: number }
  counters.__lasecReloads = (counters.__lasecReloads ?? 0) + 1
  void openProject()
})

// Testes de ponta a ponta (extension/test/e2e/openplc-lab.cjs) leem o estado do editor por aqui.
;(window as unknown as { __lasecOpenplcStore?: unknown }).__lasecOpenplcStore = openPLCStoreBase

// Alterações não salvas viram o ponto de "modificado" na aba do VS Code.
let lastDirty: boolean | undefined
openPLCStoreBase.subscribe((state) => {
  const dirty = state.workspace.editingState === 'unsaved'
  if (dirty === lastDirty) return
  lastDirty = dirty
  notifyHost('lasecDirty', [dirty])
})

/** Atalhos que no Electron vinham do menu nativo. Ctrl+S fica com o VS Code (salva a aba). */
window.addEventListener(
  'keydown',
  (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return
    const target = event.target as HTMLElement | null
    const typing =
      !!target &&
      (target.closest('.monaco-editor') !== null ||
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable)
    if (typing) return
    const key = event.key.toLowerCase()
    const redo = (key === 'z' && event.shiftKey) || (key === 'y' && !event.shiftKey)
    const undo = key === 'z' && !event.shiftKey
    if (!undo && !redo) return
    event.preventDefault()
    // Mesmo evento que o menu Edit → Undo/Redo do Electron mandava (AcceleratorHandler).
    emitBridgeEvent(redo ? 'handleRedoRequest' : 'handleUndoRequest', [])
  },
  true,
)

/**
 * Ctrl+A num campo de texto: o navegador já seleciona tudo. A Webview do VS Code também repassa a
 * tecla ao workbench, que devolve um "selectAll" assíncrono -- ele chega depois da primeira letra
 * digitada e a seleciona (a letra seguinte a apaga). Parando a tecla em `document`, depois dos
 * handlers do React e antes do ouvinte do VS Code em `window`, fica só a seleção nativa.
 */
document.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'a') return
  const target = event.target as HTMLElement | null
  if (!target) return
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable || target.closest('.monaco-editor')) {
    event.stopPropagation()
  }
})

async function openProject(): Promise<{ ok: boolean; error?: string }> {
  if (!boot.projectPath) return { ok: false, error: 'Nenhum projeto OpenPLC foi indicado pelo LasecSimul.' }
  const result = await lasecPorts.project.openProjectByPath(boot.projectPath)
  if (!result.success || !result.data) {
    return { ok: false, error: result.error?.description ?? `Não foi possível abrir ${boot.projectPath}` }
  }
  openPLCStoreBase.getState().sharedWorkspaceActions.handleOpenProjectResponse(result.data)
  connectLasecRuntime()
  return { ok: true }
}

const LasecApp = (): ReactNode => {
  const path = useOpenPLCStore((state) => state.project.meta.path)
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    void openProject().then((result) => {
      if (!result.ok) setError(result.error)
      document.body.dataset.lasecOpenplc = result.ok ? 'ready' : 'error'
      notifyHost('lasecReady', [result.ok])
    })
  }, [])

  return (
    <PlatformProvider ports={lasecPorts}>
      <LasecAppLayout>
        {path === '' ? (
          <div className='flex h-full w-full items-center justify-center font-caption text-sm text-neutral-600 dark:text-neutral-300'>
            {error ?? 'Abrindo projeto OpenPLC…'}
          </div>
        ) : (
          <WorkspaceScreen />
        )}
      </LasecAppLayout>
    </PlatformProvider>
  )
}

void invokeHost('lasecHello', [])
createRoot(document.getElementById('root') as HTMLElement).render(<LasecApp />)
