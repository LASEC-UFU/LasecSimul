// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Projeto OpenPLC -> Structured Text para o Core do LasecSimul.
 *
 * É o caminho `OPENPLC_USE_NEW_TRANSPILER` do OpenPLC Editor v4.2.8
 * (backend/editor/compiler/editor-compiler-platform-port.ts::transpileToSt): projeção do formato
 * de porta para o formato de esquema (compiler-adapter.ts::toIpcProjectData), `fromSchemaShape` e
 * `transpileToSt`. Função pura, sem E/S: roda no host da extensão.
 */

import { fromSchemaShape, type SchemaProjectData, transpileToSt } from '@root/backend/shared/transpilers/st-transpiler'
import type { PLCPou, PLCProjectData, PLCVariable } from '@root/middleware/shared/ports/types'

export interface LasecTranspileResult {
  ok: boolean
  programSt: string | null
  pouNames: string[]
  warnings: string[]
  errors: string[]
}

/** Uma variável do programa de entrada que vira pino do bloco CLP do esquemático. */
export interface LasecProgramIo {
  name: string
  direction: 'input' | 'output'
  iecType: string
}

export interface LasecEntryPoint {
  programName: string
  instanceName?: string
  taskName?: string
  taskIntervalMs: number
  io: LasecProgramIo[]
}

function toSchemaShape(data: PLCProjectData): SchemaProjectData {
  return {
    dataTypes: data.dataTypes,
    pous: data.pous.map((pou: PLCPou) => ({
      type: pou.pouType,
      data: {
        name: pou.name,
        variables: (pou.interface?.variables ?? []) as unknown[],
        ...(pou.interface?.returnType ? { returnType: pou.interface.returnType } : {}),
        body: pou.body as { language: string; value: unknown },
        documentation: pou.documentation ?? '',
      },
    })),
    configuration: data.configurations,
    servers: data.servers,
    remoteDevices: data.remoteDevices,
    libraries: data.libraries,
  } as unknown as SchemaProjectData
}

/** Linguagens que só existem com o runtime do OpenPLC (Python embarcado, blocos C/C++). */
const RUNTIME_ONLY_LANGUAGES = new Set(['python', 'cpp'])

export function transpileForLasecSimul(data: PLCProjectData): LasecTranspileResult {
  const errors: string[] = []
  for (const pou of data.pous) {
    const language = String(pou.body?.language ?? '')
    if (RUNTIME_ONLY_LANGUAGES.has(language)) {
      errors.push(`POU "${pou.name}" está em ${language.toUpperCase()}: esta linguagem depende do runtime do OpenPLC e não roda no CLP do LasecSimul.`)
    }
  }
  if (errors.length > 0) return { ok: false, programSt: null, pouNames: [], warnings: [], errors }
  try {
    const result = transpileToSt(fromSchemaShape(toSchemaShape(data)))
    return {
      ok: result.programSt !== null && result.errors.length === 0,
      programSt: result.programSt,
      pouNames: result.pouNames,
      warnings: result.warnings,
      errors: result.errors,
    }
  } catch (error) {
    return { ok: false, programSt: null, pouNames: [], warnings: [], errors: [error instanceof Error ? error.message : String(error)] }
  }
}

const IO_CLASSES: Record<string, 'input' | 'output'> = { input: 'input', output: 'output' }

function variableType(variable: PLCVariable): string {
  const type = (variable as unknown as { type?: { definition?: string; value?: string } }).type
  return String(type?.value ?? '').toUpperCase()
}

/** Período de `T#20ms`, `T#1s`, `t#1m30s`... em milissegundos. */
export function iecIntervalMs(text: string | undefined): number | undefined {
  if (!text) return undefined
  const body = text.trim().replace(/^(t|time)#/i, '').replace(/_/g, '')
  const units: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000, ms: 1, us: 0.001, ns: 0.000001 }
  let total = 0
  let matched = false
  for (const match of body.matchAll(/(\d+(?:\.\d+)?)(ms|us|ns|d|h|m|s)/gi)) {
    total += Number(match[1]) * units[match[2].toLowerCase()]
    matched = true
  }
  return matched && total > 0 ? total : undefined
}

/**
 * Programa que o bloco CLP executa: a primeira instância da RESOURCE (com a TASK dela) ou, sem
 * instância, o primeiro POU PROGRAM. Pinos = VAR_INPUT e VAR_OUTPUT desse programa, na ordem.
 */
export function resolveLasecEntryPoint(data: PLCProjectData): LasecEntryPoint {
  const resource = data.configurations?.resource
  const programs = data.pous.filter((pou) => pou.pouType === 'program')
  const instance = resource?.instances?.find((item) => programs.some((pou) => pou.name === item.program))
  const program = programs.find((pou) => pou.name === instance?.program) ?? programs[0]
  if (!program) throw new Error('O projeto não tem nenhum POU do tipo program.')
  const task = resource?.tasks?.find((item) => item.name === instance?.task) ?? resource?.tasks?.[0]
  const io = (program.interface?.variables ?? [])
    .filter((variable) => IO_CLASSES[String(variable.class)] !== undefined)
    .map((variable) => ({ name: variable.name, direction: IO_CLASSES[String(variable.class)], iecType: variableType(variable) }))
  return {
    programName: program.name,
    ...(instance ? { instanceName: instance.name } : {}),
    ...(task ? { taskName: task.name } : {}),
    taskIntervalMs: iecIntervalMs((task as { interval?: string } | undefined)?.interval) ?? 10,
    io,
  }
}
