// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Workers dentro da Webview do VS Code.
 *
 * Os arquivos do pacote vêm de `https://file+.vscode-resource...`, servidos pelo service worker da
 * Webview. `new Worker(url)` recusa script de outra origem, e um worker Blob com `importScripts`
 * não passa por aquele service worker (o script não carrega). Então a página busca o texto do
 * script (o fetch dela passa pelo service worker) e o worker nasce de um Blob com o código inteiro.
 * Vale para os workers do Monaco e para o servidor de linguagem da STruC++.
 */

const blobUrls = new Map<string, Promise<string>>()

/** Base dos arquivos do pacote: a pasta do próprio openplc.js. */
function assetBase(): string {
  const script = document.querySelector<HTMLScriptElement>('script[src$="openplc.js"]')
  return script ? new URL('.', script.src).href : document.baseURI
}

export function workerBlobUrl(assetUrl: string): Promise<string> {
  const absolute = new URL(assetUrl, assetBase()).href
  let pending = blobUrls.get(absolute)
  if (!pending) {
    pending = fetch(absolute)
      .then((response) => {
        if (!response.ok) throw new Error(`${response.status} ao carregar ${absolute}`)
        return response.text()
      })
      .then((source) => URL.createObjectURL(new Blob([source], { type: 'application/javascript' })))
    blobUrls.set(absolute, pending)
  }
  return pending
}

/** Arquivos que o monaco-editor-webpack-plugin gera (webpack.webview.cjs: `workers/[name].worker.js`). */
const MONACO_WORKERS: Record<string, string> = { json: 'workers/json.worker.js' }
const MONACO_DEFAULT_WORKER = 'workers/editor.worker.js'

async function monacoWorker(label: string): Promise<Worker> {
  const url = await workerBlobUrl(MONACO_WORKERS[label] ?? MONACO_DEFAULT_WORKER)
  return new Worker(url, { name: label })
}

/**
 * O plugin do Monaco grava `self.MonacoEnvironment` ao carregar o editor (com `getWorkerUrl`).
 * Este setter mantém o que ele grava e acrescenta `getWorker`, que o Monaco consulta primeiro.
 * Precisa rodar antes de qualquer import do monaco-editor (é o primeiro import de ./main).
 */
export function installMonacoWorkers(): void {
  const scope = self as unknown as { MonacoEnvironment?: Record<string, unknown> }
  const getWorker = (_moduleId: string, label: string): Promise<Worker> => monacoWorker(label)
  let environment: Record<string, unknown> = { ...(scope.MonacoEnvironment ?? {}), getWorker }
  Object.defineProperty(scope, 'MonacoEnvironment', {
    configurable: true,
    get: () => environment,
    set: (value: Record<string, unknown> | undefined) => {
      environment = { ...(value ?? {}), getWorker }
    },
  })
}

installMonacoWorkers()
