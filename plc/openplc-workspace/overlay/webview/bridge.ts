// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `window.bridge` do OpenPLC Editor sobre o postMessage do VS Code.
 *
 * No Electron o preload expõe `window.bridge` (src/main/modules/ipc/renderer.ts) e os adaptadores de
 * src/middleware/adapters/editor chamam esse objeto. Aqui o mesmo objeto vira um proxy: chamada com
 * callback no primeiro argumento registra ouvinte de evento do host; as demais viram uma chamada
 * remota respondida pelo host da extensão (extension/src/plc/openplc/OpenPlcEditorProvider.ts).
 * Assim os adaptadores do OpenPLC rodam sem alteração.
 */

type Listener = (...args: unknown[]) => void

interface VsCodeApi {
  postMessage(message: unknown): void
  getState(): unknown
  setState(state: unknown): void
}

declare function acquireVsCodeApi(): VsCodeApi

export const vscodeApi: VsCodeApi = acquireVsCodeApi()

const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
const listeners = new Map<string, Set<Listener>>()
let sequence = 0

/** Ouvintes que no preload recebem só os argumentos, sem o `IpcRendererEvent` na frente. */
const PLAIN_LISTENERS = new Set(['onLibrariesChanged', 'onSimulatorStopped', 'onOpenPackageManager', 'onBoardsUpdated'])

/** `removeXxx()` do preload -> nome do método que registrou o ouvinte. */
const REMOVALS: Record<string, string> = {
  removeCloseProjectListener: 'closeProjectAccelerator',
  removeCloseTabListener: 'closeTabAccelerator',
  removeCreateProjectAccelerator: 'createProjectAccelerator',
  removeDeleteFileListener: 'deleteFileAccelerator',
  removeOpenProjectAccelerator: 'handleOpenProjectRequest',
  removeOpenRecentListener: 'openRecentAccelerator',
  removeSaveFileAccelerator: 'saveFileAccelerator',
  removeSaveProjectAccelerator: 'saveProjectAccelerator',
  removeUndoRequestListener: 'handleUndoRequest',
  removeRedoRequestListener: 'handleRedoRequest',
  removeQuitAppListener: 'quitAppRequest',
  removeExportProjectListener: 'exportProjectRequest',
  removeHandleCloseOrHideWindowAccelerator: 'handleCloseOrHideWindowAccelerator',
}

export function invokeHost<T = unknown>(method: string, args: unknown[] = []): Promise<T> {
  const id = ++sequence
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
    vscodeApi.postMessage({ type: 'openplc:invoke', id, method, args })
  })
}

export function notifyHost(method: string, args: unknown[] = []): void {
  vscodeApi.postMessage({ type: 'openplc:notify', method, args })
}

export function onHostEvent(method: string, listener: Listener): () => void {
  let set = listeners.get(method)
  if (!set) {
    set = new Set()
    listeners.set(method, set)
  }
  set.add(listener)
  return () => {
    set?.delete(listener)
  }
}

/** Dispara um evento como se tivesse vindo do processo principal do Electron. */
export function emitBridgeEvent(method: string, args: unknown[] = []): void {
  emitLocal(method, args)
}

function emitLocal(method: string, args: unknown[]): void {
  const plain = PLAIN_LISTENERS.has(method)
  for (const listener of [...(listeners.get(method) ?? [])]) {
    try {
      if (plain) listener(...args)
      else listener({ sender: null }, ...args)
    } catch (error) {
      console.error(`[openplc-bridge] ouvinte ${method} falhou`, error)
    }
  }
}

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as { type?: string; id?: number; ok?: boolean; value?: unknown; error?: string; method?: string; args?: unknown[] }
  if (!message || typeof message !== 'object') return
  if (message.type === 'openplc:result' && typeof message.id === 'number') {
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.ok) entry.resolve(message.value)
    else entry.reject(new Error(message.error ?? 'Falha no host do VS Code'))
    return
  }
  if (message.type === 'openplc:event' && typeof message.method === 'string') {
    emitLocal(message.method, Array.isArray(message.args) ? message.args : [])
  }
})

/** Métodos que não passam pelo host. */
const local: Record<string, (...args: never[]) => unknown> = {
  log: (level: string, text: string) => {
    if (level === 'error') console.error(text)
    else console.info(text)
    notifyHost('log', [level, text])
  },
  // Janela e menu nativos não existem dentro da aba do VS Code.
  closeWindow: () => undefined,
  hideWindow: () => undefined,
  minimizeWindow: () => undefined,
  maximizeWindow: () => undefined,
  rebuildMenu: () => undefined,
  reloadWindow: () => window.location.reload(),
  handleCloseOrHideWindow: () => undefined,
  handleCloseOrHideWindowAccelerator: () => undefined,
  handleQuitApp: () => undefined,
  setStoreValue: (key: string, value: string) => notifyHost('setStoreValue', [key, value]),
  winHandleUpdateTheme: (theme?: string) => notifyHost('winHandleUpdateTheme', [theme]),
}

export const bridge = new Proxy(local, {
  get(target, property) {
    if (typeof property !== 'string') return undefined
    if (property in target) return target[property]
    if (property in REMOVALS) return () => listeners.delete(REMOVALS[property])
    if (property.startsWith('remove') && property.endsWith('Listener')) return () => undefined
    return (...args: unknown[]) => {
      if (typeof args[0] === 'function') return onHostEvent(property, args[0] as Listener)
      return invokeHost(property, args)
    }
  },
  has(target, property) {
    return typeof property === 'string' || property in target
  },
}) as unknown as Window['bridge']

;(window as unknown as { bridge: Window['bridge'] }).bridge = bridge
