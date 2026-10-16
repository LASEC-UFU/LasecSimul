// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Lado host (Node, extensão do VS Code) do OpenPLC Editor no LasecSimul.
 *
 * O projeto PLC do LasecSimul é um arquivo `.lsplc` com o conteúdo de um projeto do OpenPLC
 * (project.json, devices/, pous/) dentro dele; a extensão lê e grava esse arquivo e entrega ao
 * editor o mesmo conjunto de arquivos (RawProjectFiles) que o processo principal do OpenPLC lê da
 * pasta. Daqui saem as partes do OpenPLC Editor v4.2.8 que a extensão reaproveita: montar o
 * projeto a partir dos arquivos (parseProjectFiles), criar um projeto novo (buildProjectFileContent
 * + serializePouToText, como o assistente "New Project"), as bibliotecas (LibraryManagerModule), o
 * transpilador LD/FBD/ST/IL -> ST e a leitura/gravação de uma pasta do OpenPLC original
 * (ProjectService), para importar e exportar.
 */

import { LibraryManagerModule } from '@root/backend/editor/library-manager/library-manager-module'
import { ProjectService } from '@root/backend/editor/services/project-service'
import { ipcPouToFlat } from '@root/backend/editor/utils/ipc-pou-to-flat'
import { buildProjectFileContent } from '@root/backend/shared/project/create-project-files'
import { parseProjectFiles } from '@root/backend/shared/utils/parse-project-files'
import { getExtensionFromLanguage, getFolderFromPouType } from '@root/frontend/utils/PLC/pou-file-extensions'
import { serializePouToText } from '@root/frontend/utils/PLC/pou-text-serializer'
import type { PLCProjectData } from '@root/middleware/shared/ports/types'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

import { starterSfcBody } from '../shared/sfc'
import {
  type LasecEntryPoint,
  type LasecTranspileResult,
  resolveLasecEntryPoint,
  transpileForLasecSimul,
} from '../shared/transpile'
import { configureElectronShim, type ElectronShimOptions } from './electron-shim'

export interface OpenPlcHostOptions extends ElectronShimOptions {
  /** Pasta com as .stlib que acompanham o editor (as mesmas quatro do OpenPLC Editor). */
  bundledLibrariesDir: string
  /** Bibliotecas que o usuário instala pelo Library Manager. */
  librariesDir: string
}

/** Arquivos de um projeto do OpenPLC, como o processo principal os entrega ao editor. */
export interface RawProjectData {
  projectPath: string
  projectJson: string
  deviceConfig: string
  pinMapping: string
  libraryManifest: string
  pouFiles: Array<{ relativePath: string; content: string }>
  serverFiles: Array<{ relativePath: string; content: string }>
  remoteDeviceFiles: Array<{ relativePath: string; content: string }>
}

export interface LoadedOpenPlcProject {
  name: string
  type: 'plc-project' | 'plc-library'
  path: string
  data: PLCProjectData
  warnings: string[]
}

export interface NewProjectOptions {
  name: string
  language: 'ld' | 'fbd' | 'st' | 'il' | 'sfc'
  /** Período da task0, no formato do assistente do OpenPLC (padrão dele: T#20ms). */
  cycleTime?: string
  /** Variáveis de E/S do programa principal (viram pinos do bloco CLP). */
  io?: Array<{ name: string; direction: 'input' | 'output'; type: string }>
}

export interface OpenPlcHost {
  projectService: ProjectService
  libraries: LibraryManagerModule
  /** Projeto montado a partir dos arquivos (mesma função que o editor usa ao abrir). */
  parseProject(raw: RawProjectData): LoadedOpenPlcProject
  /** Arquivos de um projeto novo, como o assistente "New Project" do OpenPLC os cria. */
  newProjectFiles(options: NewProjectOptions): RawProjectData
  /** Lê uma pasta de projeto do OpenPLC Editor original (importar). */
  readFolderProject(projectDir: string): Promise<RawProjectData>
  /** Grava os arquivos numa pasta no formato do OpenPLC Editor original (exportar). */
  writeFolderProject(projectDir: string, raw: RawProjectData): Promise<{ success: boolean; error?: string }>
  /** Nome do arquivo de um POU no projeto (`pous/programs/main.ld`). */
  pouRelativePath(pouType: string, name: string, language: string): string
  transpile(data: PLCProjectData): LasecTranspileResult
  entryPoint(data: PLCProjectData): LasecEntryPoint
}

/** O que UserService#checkIfUserHistoryFolderExists cria na pasta de dados (sem a parte do arduino-cli). */
function ensureUserHistory(userDataDir: string): void {
  const historyDir = join(userDataDir, 'User', 'History')
  mkdirSync(historyDir, { recursive: true })
  for (const file of ['projects.json', 'libraries.json']) {
    const target = join(historyDir, file)
    if (!existsSync(target)) writeFileSync(target, '[]', 'utf-8')
  }
}

const slash = (value: string) => value.replace(/\\/g, '/')

export function createOpenPlcHost(options: OpenPlcHostOptions): OpenPlcHost {
  configureElectronShim(options)
  ensureUserHistory(options.userDataDir)
  const projectService = new ProjectService({} as never)
  const libraries = new LibraryManagerModule({ librariesDir: options.librariesDir, bundledDir: options.bundledLibrariesDir })

  const parseProject = (raw: RawProjectData): LoadedOpenPlcProject => {
    const parsed = parseProjectFiles(
      raw.projectPath,
      raw.projectJson,
      raw.deviceConfig,
      raw.pinMapping,
      raw.pouFiles,
      raw.serverFiles,
      raw.remoteDeviceFiles,
      raw.libraryManifest,
    ) as unknown as {
      meta: { name: string; type: 'plc-project' | 'plc-library'; path: string }
      projectData: PLCProjectData
      warnings?: string[]
    }
    return {
      name: parsed.meta.name,
      type: parsed.meta.type,
      path: parsed.meta.path,
      data: parsed.projectData,
      warnings: parsed.warnings ?? [],
    }
  }

  const pouRelativePath = (pouType: string, name: string, language: string) =>
    `pous/${getFolderFromPouType(pouType)}/${name}${getExtensionFromLanguage(language)}`

  const newProjectFiles = (input: NewProjectOptions): RawProjectData => {
    const built = buildProjectFileContent({
      language: input.language,
      time: input.cycleTime ?? 'T#20ms',
      type: 'plc-project',
      name: input.name,
    })
    const pouFiles = built.pous.map((ipcPou) => {
      const pou = ipcPouToFlat(ipcPou as never)
      const io = input.io ?? []
      pou.interface = {
        ...(pou.interface ?? {}),
        variables: [
          ...(pou.interface?.variables ?? []),
          ...io.map((item) => ({
            name: item.name,
            class: item.direction,
            type: { definition: 'base-type' as const, value: item.type.toLowerCase() },
            location: '',
            initialValue: null,
            documentation: '',
            debug: false,
          })),
        ],
      } as never
      if (pou.body.language === 'sfc') {
        const input0 = io.find((item) => item.direction === 'input')?.name
        const output0 = io.find((item) => item.direction === 'output')?.name
        pou.body = { language: 'sfc', value: starterSfcBody(pou.name, input0, output0) } as never
      }
      return { relativePath: pouRelativePath(pou.pouType, pou.name, pou.body.language), content: serializePouToText(pou as never) }
    })
    return {
      projectPath: '',
      projectJson: JSON.stringify(built.project, null, 2),
      deviceConfig: JSON.stringify(built.deviceConfiguration, null, 2),
      pinMapping: JSON.stringify(built.devicePinMapping, null, 2),
      libraryManifest: '',
      pouFiles,
      serverFiles: [],
      remoteDeviceFiles: [],
    }
  }

  const readFolderProject = async (projectDir: string): Promise<RawProjectData> => {
    const raw = await projectService.readRawProjectFiles(projectDir)
    if (!raw.success || !raw.data) {
      throw new Error(raw.error?.description ?? `Não foi possível ler o projeto OpenPLC em ${projectDir}`)
    }
    const fix = (files: Array<{ relativePath: string; content: string }>) =>
      files.map((file) => ({ relativePath: slash(file.relativePath), content: file.content }))
    return {
      ...raw.data,
      pouFiles: fix(raw.data.pouFiles),
      serverFiles: fix(raw.data.serverFiles),
      remoteDeviceFiles: fix(raw.data.remoteDeviceFiles),
    }
  }

  const writeFolderProject = async (projectDir: string, raw: RawProjectData) => {
    const result = await projectService.writeProjectFiles({
      projectPath: projectDir,
      projectJson: raw.projectJson,
      deviceConfig: raw.deviceConfig,
      pinMapping: raw.pinMapping,
      ...(raw.libraryManifest ? { libraryManifest: raw.libraryManifest } : {}),
      pouFiles: raw.pouFiles,
      serverFiles: raw.serverFiles,
      remoteDeviceFiles: raw.remoteDeviceFiles,
      deletions: [],
    } as never)
    return result.success ? { success: true } : { success: false, error: result.error?.description ?? 'Falha ao gravar a pasta' }
  }

  return {
    projectService,
    libraries,
    parseProject,
    newProjectFiles,
    readFolderProject,
    writeFolderProject,
    pouRelativePath,
    transpile: transpileForLasecSimul,
    entryPoint: resolveLasecEntryPoint,
  }
}

export { iecIntervalMs } from '../shared/transpile'
export { normalizeSfcBody } from '../shared/sfc'
export type { LasecEntryPoint, LasecProgramIo, LasecTranspileResult } from '../shared/transpile'
