/*
 * Pacote do host do OpenPLC Editor (media/openplc-workspace/host/host.js, gerado por
 * scripts/build-openplc-workspace.js a partir do código oficial v4.2.8): ProjectService, PouService,
 * LibraryManagerModule e o transpilador LD/FBD/ST/IL -> ST do próprio OpenPLC.
 *
 * Os tipos abaixo descrevem só o que a extensão usa do pacote (que é JavaScript gerado).
 */

import * as fs from "fs";
import * as path from "path";
import type { IecProjectAuthoring, PouDefinition } from "../iecProject";
import { PlcToolchainPaths } from "../plcBuild";
import { rawProjectFiles, readLsplc } from "./lsplcFile";

/** As mesmas quatro bibliotecas que o OpenPLC Editor 4.2.8 traz (resources/strucpp/libs). */
export const OPENPLC_BUNDLED_LIBRARIES = [
  "additional-function-blocks.stlib",
  "iec-standard-fb.stlib",
  "iec-std-functions.stlib",
  "oscat-basic.stlib",
];

export interface OpenPlcProgramIo {
  name: string;
  direction: "input" | "output";
  iecType: string;
}

export interface OpenPlcEntryPoint {
  programName: string;
  instanceName?: string;
  taskName?: string;
  taskIntervalMs: number;
  io: OpenPlcProgramIo[];
}

export interface OpenPlcTranspileResult {
  ok: boolean;
  programSt: string | null;
  pouNames: string[];
  warnings: string[];
  errors: string[];
}

/** Dados do projeto no formato de porta do OpenPLC (o mesmo que o store do editor guarda). */
export interface OpenPlcProjectData {
  pous: Array<{ name: string; pouType: string; body: { language: string; value: unknown }; interface?: { variables?: unknown[] } }>;
  dataTypes: unknown[];
  configurations: { resource: { tasks: unknown[]; instances: unknown[]; globalVariables: unknown[] } };
  libraries?: Array<{ name: string; version: string }>;
  [key: string]: unknown;
}

export interface LoadedOpenPlcProject {
  name: string;
  type: "plc-project" | "plc-library";
  path: string;
  data: OpenPlcProjectData;
  warnings: string[];
}

type ServiceResult = { success: boolean; error?: unknown; data?: unknown; [key: string]: unknown };

/** Arquivos de um projeto do OpenPLC, como o processo principal os entrega ao editor. */
export interface RawProjectData {
  projectPath: string;
  projectJson: string;
  deviceConfig: string;
  pinMapping: string;
  libraryManifest: string;
  pouFiles: Array<{ relativePath: string; content: string }>;
  serverFiles: Array<{ relativePath: string; content: string }>;
  remoteDeviceFiles: Array<{ relativePath: string; content: string }>;
}

export type OpenPlcLanguage = "ld" | "fbd" | "st" | "il" | "sfc";

export interface OpenPlcHost {
  libraries: {
    loadAll(): unknown[];
    listInstalled(): unknown[];
    installFromFile(filePath: string): Promise<ServiceResult>;
    uninstall(name: string): ServiceResult;
  };
  parseProject(raw: RawProjectData): LoadedOpenPlcProject;
  newProjectFiles(options: {
    name: string;
    language: OpenPlcLanguage;
    cycleTime?: string;
    io?: Array<{ name: string; direction: "input" | "output"; type: string }>;
  }): RawProjectData;
  readFolderProject(projectDir: string): Promise<RawProjectData>;
  writeFolderProject(projectDir: string, raw: RawProjectData): Promise<{ success: boolean; error?: string }>;
  pouRelativePath(pouType: string, name: string, language: string): string;
  /** Projeto IEC antigo do LasecSimul (`*.iec.json`) como projeto OpenPLC; `fallbackSt` traduz para
   * ST o POU que o OpenPLC não desenha. */
  fromLasecIecProject(
    project: IecProjectAuthoring,
    options?: { fallbackSt?: (pou: PouDefinition) => { text: string; variables: Array<{ name: string; type: string }> } },
  ): { raw: RawProjectData; warnings: string[] };
  transpile(data: OpenPlcProjectData): OpenPlcTranspileResult;
  entryPoint(data: OpenPlcProjectData): OpenPlcEntryPoint;
}

interface HostModule {
  createOpenPlcHost(options: {
    userDataDir: string;
    bundledLibrariesDir: string;
    librariesDir: string;
    showOpenDialog?: (options: Record<string, unknown>) => Promise<{ canceled: boolean; filePaths: string[] }>;
    showMessageBox?: (options: Record<string, unknown>) => Promise<{ response: number }>;
  }): OpenPlcHost;
}

export function openPlcWorkspaceDir(extensionPath: string): string {
  return path.join(extensionPath, "media", "openplc-workspace");
}

export function openPlcWorkspaceAvailable(extensionPath: string): boolean {
  const root = openPlcWorkspaceDir(extensionPath);
  return fs.existsSync(path.join(root, "host", "host.js")) && fs.existsSync(path.join(root, "webview", "openplc.js"));
}

/** Copia as .stlib do OpenPLC (as do pacote da STruCpp do LasecSimul) para a pasta que o
 * LibraryManagerModule lê como "bundled". */
export function prepareOpenPlcBundledLibraries(toolchain: PlcToolchainPaths, storageDir: string): string {
  const target = path.join(storageDir, "openplc", "bundled-libraries");
  fs.mkdirSync(target, { recursive: true });
  for (const name of OPENPLC_BUNDLED_LIBRARIES) {
    const source = path.join(toolchain.strucppLibrarySourceDir, name);
    const destination = path.join(target, name);
    if (!fs.existsSync(source)) continue;
    const sourceStat = fs.statSync(source);
    const current = fs.existsSync(destination) ? fs.statSync(destination) : undefined;
    if (!current || current.size !== sourceStat.size || current.mtimeMs < sourceStat.mtimeMs) fs.copyFileSync(source, destination);
  }
  return target;
}

let cachedHost: { key: string; host: OpenPlcHost } | undefined;

export interface OpenPlcHostEnvironment {
  extensionPath: string;
  storageDir: string;
  toolchain: PlcToolchainPaths;
  showOpenDialog?: (options: Record<string, unknown>) => Promise<{ canceled: boolean; filePaths: string[] }>;
}

export function loadOpenPlcHost(environment: OpenPlcHostEnvironment): OpenPlcHost {
  const hostPath = path.join(openPlcWorkspaceDir(environment.extensionPath), "host", "host.js");
  if (!fs.existsSync(hostPath)) {
    throw new Error("Editor OpenPLC não empacotado nesta instalação (rode `node scripts/build-openplc-workspace.js`).");
  }
  const key = `${hostPath}|${environment.storageDir}`;
  if (cachedHost?.key === key) return cachedHost.host;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const module = require(hostPath) as HostModule;
  const userDataDir = path.join(environment.storageDir, "openplc", "user-data");
  fs.mkdirSync(userDataDir, { recursive: true });
  const host = module.createOpenPlcHost({
    userDataDir,
    bundledLibrariesDir: prepareOpenPlcBundledLibraries(environment.toolchain, environment.storageDir),
    librariesDir: path.join(environment.storageDir, "openplc", "libraries"),
    ...(environment.showOpenDialog ? { showOpenDialog: environment.showOpenDialog } : {}),
  });
  cachedHost = { key, host };
  return host;
}

/** Projeto montado a partir do arquivo .lsplc (o mesmo caminho que o editor usa ao abrir). */
export function loadLsplcProject(host: OpenPlcHost, filePath: string): LoadedOpenPlcProject {
  return host.parseProject(rawProjectFiles(filePath, readLsplc(filePath)));
}
