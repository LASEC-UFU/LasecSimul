// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Portas da plataforma para o OpenPLC Editor dentro do LasecSimul.
 *
 * Projeto, bibliotecas, sistema, tema e atalhos usam os adaptadores do próprio OpenPLC (o
 * `window.bridge` deles fala com o host do VS Code, ver ./bridge). Compilação vai para o Core do
 * LasecSimul; dispositivo, runtime remoto, simulador e depurador do OpenPLC não se aplicam: o CLP
 * roda dentro do esquemático.
 */

import './bridge'

import { createEditorAcceleratorAdapter } from '@root/middleware/adapters/editor/accelerator-adapter'
import { createEditorLibraryAdapter } from '@root/middleware/adapters/editor/library-adapter'
import { createEditorOrchestratorAdapter } from '@root/middleware/adapters/editor/orchestrator-adapter'
import { createEditorProjectAdapter } from '@root/middleware/adapters/editor/project-adapter'
import { createEditorStlibSourceAdapter } from '@root/middleware/adapters/editor/stlib-source-adapter'
import { createEditorSystemAdapter } from '@root/middleware/adapters/editor/system-adapter'
import { createEditorThemeAdapter } from '@root/middleware/adapters/editor/theme-adapter'
import { createEditorVersionControlAdapter } from '@root/middleware/adapters/editor/version-control-adapter'
import { createEditorWindowAdapter } from '@root/middleware/adapters/editor/window-adapter'
import type { CompilerPort } from '@root/middleware/shared/ports/compiler-port'
import type { DebuggerPort } from '@root/middleware/shared/ports/debugger-port'
import type { DevicePort } from '@root/middleware/shared/ports/device-port'
import type { NavigationPort } from '@root/middleware/shared/ports/navigation-port'
import type { PlatformCapabilities } from '@root/middleware/shared/ports/platform-capabilities'
import type { RuntimePort } from '@root/middleware/shared/ports/runtime-port'
import type { SimulatorPort } from '@root/middleware/shared/ports/simulator-port'
import type { BoardInfo, CompileProgressEvent, CompileResult, DebugCompileResult } from '@root/middleware/shared/ports/types'
import type { PlatformPorts } from '@root/middleware/shared/providers/types'

import { openPLCStoreBase } from '@root/frontend/store'
import { unpackDebugAddr } from '@root/frontend/utils/debug-parser'
import { encodeForceValue, getTypeSizeByName, parseValueByTypeName } from '@root/frontend/utils/variable-sizes'

import { invokeHost, notifyHost, onHostEvent } from './bridge'

export const LASECSIMUL_CAPABILITIES: PlatformCapabilities = {
  isNativeApplication: true,
  hasNativeFileDialogs: true,
  hasAuthentication: false,
  hasLocalSerialPorts: false,
  hasOrchestratorDevices: false,
  hasWebRTC: false,
  hasInProcessSimulator: false,
  hasLocalFilesystem: true,
  hasProjectExport: false,
  hasVersionControl: false,
  hasAboutDialog: false,
  hasPythonLSP: false,
  hasStLSP: true,
  hasUndoRedoHistory: true,
  hasFileWatcher: false,
  hasAIAssistant: false,
  hasProxiedRuntimeConnection: false,
  hasDirectProgramUpload: false,
  hasPackageManager: false,
  hasEthercat: false,
  isDevMode: false,
}

const unsupported = 'Não se aplica ao LasecSimul: o CLP roda no esquemático.'

function createLasecCompilerAdapter(): CompilerPort {
  const run = async (
    mode: 'program' | 'debug',
    projectData: unknown,
    projectPath: string,
    onProgress: (event: CompileProgressEvent) => void,
  ): Promise<CompileResult> => {
    const compileId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const stop = onHostEvent('lasecCompileProgress', (_event: unknown, id: unknown, progress: unknown) => {
      if (id === compileId) onProgress(progress as CompileProgressEvent)
    })
    try {
      return await invokeHost<CompileResult>('lasecCompile', [{ compileId, mode, projectData, projectPath }])
    } finally {
      stop()
    }
  }
  return {
    compileProgram: (args, onProgress) => run('program', args.projectData, args.projectPath, onProgress),
    compileForDebug: async (args, onProgress) =>
      (await run('debug', args.projectData, args.projectPath, onProgress)) as DebugCompileResult,
    exportProjectXml: async () => ({ success: false, error: unsupported }) as never,
  }
}

/** Placa única: o bloco CLP do esquemático. Mantém os componentes que leem `availableBoards` felizes. */
const LASECSIMUL_BOARD = 'LasecSimul'

/**
 * Qualquer placa gravada no projeto ("OpenPLC Simulator", "ESP32"...) responde como o bloco CLP
 * do LasecSimul: a placa não muda nada aqui, e o projeto continua abrindo no OpenPLC original com
 * a placa que tinha.
 */
class AnyBoardMap extends Map<string, BoardInfo> {
  get(key: string): BoardInfo | undefined {
    return super.get(key) ?? super.get(LASECSIMUL_BOARD)
  }
  has(_key: string): boolean {
    return super.has(LASECSIMUL_BOARD)
  }
}

function createLasecDeviceAdapter(): DevicePort {
  const boards = (): Map<string, BoardInfo> =>
    new AnyBoardMap([
      [
        LASECSIMUL_BOARD,
        {
          compiler: 'openplc-compiler',
          core: '',
          preview: '',
          specs: {},
          board: LASECSIMUL_BOARD,
          version: '1',
          // Compilar já recarrega o CLP em execução (hot reload): o OpenPLC não precisa pedir para
          // parar o PLC antes do build, e "Build and upload" fica disponível.
          capabilities: { directUsbUpload: true },
          // Um canal só, sem perguntas: o depurador conecta no CLP do esquemático.
          debug: {
            channels: [{ label: 'LasecSimul', channel: 'simulator', enabledWhen: true, params: {} }],
          },
        } as unknown as BoardInfo,
      ],
    ])
  return {
    getAvailableBoards: async () => boards(),
    getCommunicationPorts: async () => [],
    refreshBoards: async () => [{ board: LASECSIMUL_BOARD, version: '1' }],
    refreshCommunicationPorts: async () => [],
    getPreviewImage: async () => '',
  }
}

function createLasecNavigationAdapter(): NavigationPort {
  return {
    navigate: () => undefined,
    openInNewWindow: () => undefined,
    exitToHost: () => notifyHost('closeEditor'),
  }
}

/**
 * "Runtime" do OpenPLC = a simulação do LasecSimul. O editor fica conectado a ela (main.tsx):
 * Play/Stop da barra do OpenPLC rodam/param a simulação do esquemático e o estado RUNNING/STOPPED
 * vem dela. Demais operações de dispositivo (usuários, portas seriais, EtherCAT...) não existem.
 */
function createLasecRuntimeAdapter(): RuntimePort {
  const fail = async () => ({ success: false, error: unsupported })
  const known: Record<string, unknown> = {
    getStatus: async () => {
      const reply = await invokeHost<{ running: boolean }>('lasecSimulationStatus')
      return { success: true, status: reply.running ? 'RUNNING' : 'STOPPED' }
    },
    startPlc: () => invokeHost('lasecRunSimulation'),
    stopPlc: () => invokeHost('lasecStopSimulation'),
    // Aba "PLC Logs": o log de simulação do LasecSimul (Core, compilação, CLP).
    getLogs: async (minId?: number) => ({ success: true, logs: await invokeHost('lasecSimulationLog', [minId ?? 0]) }),
    getCompilationStatus: async () => ({ success: true, status: 'SUCCESS', logs: [] }),
    clearCredentials: async () => ({ success: true }),
    isReadyForDebug: () => true,
    isConnected: () => true,
  }
  return new Proxy(known as unknown as RuntimePort, {
    get(_target, property) {
      if (typeof property !== 'string' || property === 'then') return undefined
      if (property in known) return known[property]
      if (property.startsWith('on')) return () => () => undefined
      return fail
    },
  })
}

/** Liga o editor ao "runtime" da simulação (Play/Stop e "Build and upload" ficam ativos). */
export function connectLasecRuntime(): void {
  const { deviceActions } = openPLCStoreBase.getState()
  deviceActions.setRuntimeIpAddress('LasecSimul')
  deviceActions.setRuntimeJwtToken('lasecsimul')
  deviceActions.setRuntimeConnectionStatus('connected')
}

function createLasecSimulatorAdapter(): SimulatorPort {
  return {
    loadFirmware: async () => ({ success: false, error: unsupported }),
    stop: async () => ({ success: true }),
    isRunning: () => false,
    onStopped: () => () => undefined,
    connectDebugger: async () => undefined,
  } as unknown as SimulatorPort
}

interface LasecDebugVariable {
  /** Caminho do OpenPLC (`INSTANCE0.DI0`). */
  path: string
  /** Nome que o CLP do LasecSimul entende em plcGet/plcForce (`MAIN.DI0`). */
  qualifiedName: string
  type: string
}

/**
 * Depurador do OpenPLC sobre o CLP que roda no esquemático. O mapa de depuração (formato v2 que
 * a STruC++ gera para o runtime do OpenPLC) é montado com as variáveis que o CLP do LasecSimul
 * expõe; cada endereço é um índice nessa lista. Leitura = plcGet de cada nome, convertida para os
 * bytes que o OpenPLC espera (encodeForceValue); forçar = plcForce/plcUnforce.
 */
function createLasecDebuggerAdapter(): DebuggerPort {
  let variables: LasecDebugVariable[] = []
  let connected = false
  const variableAt = (index: number): LasecDebugVariable | undefined => variables[unpackDebugAddr(index).elemIdx]

  return {
    async connect() {
      const result = await invokeHost<{ success: boolean; error?: string }>('lasecDebugConnect')
      connected = result.success
      return result
    },
    async disconnect() {
      connected = false
      await invokeHost('lasecDebugDisconnect').catch(() => undefined)
      return { success: true }
    },
    async getVariablesList(indexes: number[]) {
      const wanted = indexes.map(variableAt)
      const reply = await invokeHost<{ success: boolean; values?: Array<string | null>; error?: string; needsReconnect?: boolean }>(
        'lasecDebugRead',
        [wanted.map((variable) => variable?.qualifiedName ?? null)],
      )
      if (!reply.success || !reply.values) {
        return { success: false, error: reply.error ?? 'Sem resposta do CLP', ...(reply.needsReconnect ? { needsReconnect: true } : {}) }
      }
      const bytes: number[] = []
      wanted.forEach((variable, position) => {
        if (!variable) return
        const size = getTypeSizeByName(variable.type)
        let encoded: Uint8Array
        try {
          encoded = encodeForceValue(String(reply.values?.[position] ?? ''), variable.type)
        } catch {
          encoded = new Uint8Array(size)
        }
        for (let offset = 0; offset < size; offset += 1) bytes.push(encoded[offset] ?? 0)
      })
      return { success: true, tick: Date.now(), lastIndex: indexes.length - 1, data: bytes }
    },
    async setVariable(index: number, force: boolean, valueBuffer?: Uint8Array) {
      const variable = variableAt(index)
      if (!variable) return { success: false, error: 'Variável fora do mapa de depuração' }
      const value = force && valueBuffer ? parseValueByTypeName(new Uint8Array(valueBuffer), 0, variable.type).value.replace(/^"|"$/g, '') : ''
      return invokeHost('lasecDebugForce', [variable.qualifiedName, force, value])
    },
    verifyMd5: async () => ({ success: true, match: true, targetMd5: 'lasecsimul', targetEndian: 'le' }),
    readProgramMd5: async () => ({ success: true, md5: 'lasecsimul' }),
    async readDebugFile() {
      const reply = await invokeHost<{ success: boolean; variables?: LasecDebugVariable[]; error?: string }>('lasecDebugMap')
      if (!reply.success || !reply.variables) return { success: false, error: reply.error ?? 'Sem mapa de depuração' }
      variables = reply.variables
      const leaves = variables.map((variable, elemIdx) => ({
        arrayIdx: 0,
        elemIdx,
        path: variable.path,
        type: variable.type,
        size: getTypeSizeByName(variable.type),
      }))
      const map = { version: 2, md5: 'lasecsimul', typeTags: {}, arrays: [{ index: 0, count: leaves.length }], leaves }
      return { success: true, content: JSON.stringify(map) }
    },
    // Parar a simulação não encerra a sessão: os valores ficam "velhos" (como um dispositivo que
    // não responde no OpenPLC) e a leitura reata quando a simulação volta.
    onDisconnected: () => () => undefined,
    isConnected: () => connected,
  }
}

export const lasecPorts: PlatformPorts = {
  compiler: createLasecCompilerAdapter(),
  runtime: createLasecRuntimeAdapter(),
  debugger: createLasecDebuggerAdapter(),
  simulator: createLasecSimulatorAdapter(),
  project: createEditorProjectAdapter(),
  device: createLasecDeviceAdapter(),
  orchestrator: createEditorOrchestratorAdapter(),
  system: createEditorSystemAdapter(),
  window: createEditorWindowAdapter(),
  accelerator: createEditorAcceleratorAdapter(),
  theme: createEditorThemeAdapter(),
  versionControl: createEditorVersionControlAdapter(),
  navigation: createLasecNavigationAdapter(),
  library: createEditorLibraryAdapter(),
  stlibSource: createEditorStlibSourceAdapter(),
  capabilities: LASECSIMUL_CAPABILITIES,
}

export { LASECSIMUL_BOARD }
