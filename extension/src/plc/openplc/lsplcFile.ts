/*
 * Projeto PLC do LasecSimul: um arquivo `.lsplc`, o mesmo para as cinco linguagens (LD, FBD, ST,
 * IL, SFC). Dentro dele está um projeto do OpenPLC Editor inteiro -- o project.json, a configuração
 * de dispositivo e cada POU no texto que o OpenPLC grava em `pous/<pasta>/<nome>.<ld|fbd|st|il|sfc>`
 * -- para o editor (frontend do OpenPLC) trabalhar com os mesmos arquivos que trabalharia numa
 * pasta. Os caminhos que o editor usa (`<arquivo.lsplc>/pous/programs/main.ld`) são virtuais: este
 * módulo os resolve dentro do arquivo.
 */

import * as fs from "fs";
import * as path from "path";
import type { RawProjectData } from "./openPlcHost";

export const LSPLC_EXTENSION = ".lsplc";
export const LSPLC_FORMAT = "lasecsimul.plc-project";

export interface LsplcBundle {
  format: typeof LSPLC_FORMAT;
  formatVersion: 1;
  /** Editor que gravou (o frontend do OpenPLC Editor dentro do LasecSimul). */
  editor: { name: string; version: string };
  /** project.json do OpenPLC (meta + data). */
  project: unknown;
  devices: { configuration: unknown; pinMapping: unknown };
  /** library.json, só em projeto de biblioteca. */
  libraryManifest?: string;
  /** POUs, servidores e dispositivos remotos: caminho relativo (com /) -> texto do arquivo. */
  files: Record<string, string>;
}

export function isLsplcFile(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === LSPLC_EXTENSION;
}

function parseJson(text: string, fallback: unknown): unknown {
  try { return JSON.parse(text); } catch { return text === "" ? fallback : text; }
}

function asText(value: unknown, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export function readLsplc(filePath: string): LsplcBundle {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<LsplcBundle>;
  if (raw.format !== LSPLC_FORMAT || typeof raw.files !== "object" || raw.files === null) {
    throw new Error(`${path.basename(filePath)} não é um projeto PLC do LasecSimul (.lsplc).`);
  }
  return {
    format: LSPLC_FORMAT,
    formatVersion: 1,
    editor: raw.editor ?? { name: "OpenPLC Editor", version: "4.2.8" },
    project: raw.project ?? {},
    devices: { configuration: raw.devices?.configuration ?? {}, pinMapping: raw.devices?.pinMapping ?? [] },
    ...(raw.libraryManifest ? { libraryManifest: raw.libraryManifest } : {}),
    files: { ...raw.files },
  };
}

/** Grava num temporário e troca, para um salvar interrompido não deixar o projeto pela metade. */
export function writeLsplc(filePath: string, bundle: LsplcBundle): void {
  const sortedFiles = Object.fromEntries(Object.entries(bundle.files).sort(([a], [b]) => a.localeCompare(b)));
  const text = `${JSON.stringify({ ...bundle, files: sortedFiles }, null, 2)}\n`;
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, "utf8");
  fs.renameSync(temporary, filePath);
}

const slash = (value: string): string => value.replace(/\\/g, "/").replace(/^\.\//, "");

/** Arquivos do projeto como o OpenPLC os entrega ao editor ao abrir uma pasta. */
export function rawProjectFiles(filePath: string, bundle: LsplcBundle): RawProjectData {
  const entries = Object.entries(bundle.files).map(([relativePath, content]) => ({ relativePath, content }));
  return {
    projectPath: filePath,
    projectJson: asText(bundle.project, "{}"),
    deviceConfig: asText(bundle.devices.configuration, "{}"),
    pinMapping: asText(bundle.devices.pinMapping, "[]"),
    libraryManifest: bundle.libraryManifest ?? "",
    pouFiles: entries.filter(entry => entry.relativePath.startsWith("pous/")),
    serverFiles: entries.filter(entry => entry.relativePath.startsWith("devices/servers/")),
    remoteDeviceFiles: entries.filter(entry => entry.relativePath.startsWith("devices/remote/")),
  };
}

export function bundleFromRaw(raw: Omit<RawProjectData, "projectPath">, editorVersion = "4.2.8"): LsplcBundle {
  const files: Record<string, string> = {};
  for (const file of [...raw.pouFiles, ...raw.serverFiles, ...raw.remoteDeviceFiles]) files[slash(file.relativePath)] = file.content;
  return {
    format: LSPLC_FORMAT,
    formatVersion: 1,
    editor: { name: "OpenPLC Editor", version: editorVersion },
    project: parseJson(raw.projectJson, {}),
    devices: { configuration: parseJson(raw.deviceConfig, {}), pinMapping: parseJson(raw.pinMapping, []) },
    ...(raw.libraryManifest ? { libraryManifest: raw.libraryManifest } : {}),
    files,
  };
}

/** O que o salvar do OpenPLC manda (project:write-files): arquivos novos/alterados e os apagados. */
export interface LsplcWrite {
  projectJson: string;
  deviceConfig?: string;
  pinMapping?: string;
  libraryManifest?: string;
  pouFiles?: Array<{ relativePath: string; content: string }>;
  serverFiles?: Array<{ relativePath: string; content: string }>;
  remoteDeviceFiles?: Array<{ relativePath: string; content: string }>;
  deletions?: string[];
}

export function applyWrite(bundle: LsplcBundle, write: LsplcWrite): LsplcBundle {
  const files = { ...bundle.files };
  for (const file of [...(write.pouFiles ?? []), ...(write.serverFiles ?? []), ...(write.remoteDeviceFiles ?? [])]) {
    files[slash(file.relativePath)] = file.content;
  }
  for (const deleted of write.deletions ?? []) delete files[slash(deleted)];
  return {
    ...bundle,
    project: parseJson(write.projectJson, bundle.project),
    devices: {
      configuration: write.deviceConfig !== undefined ? parseJson(write.deviceConfig, {}) : bundle.devices.configuration,
      pinMapping: write.pinMapping !== undefined ? parseJson(write.pinMapping, []) : bundle.devices.pinMapping,
    },
    ...(write.libraryManifest !== undefined ? { libraryManifest: write.libraryManifest } : {}),
    files,
  };
}

/**
 * Caminho virtual do editor (`<arquivo.lsplc>/pous/programs/main.ld`) -> caminho relativo dentro do
 * arquivo. Fora do projeto: undefined.
 */
export function virtualRelativePath(filePath: string, candidate: string): string | undefined {
  const root = slash(path.resolve(filePath));
  const target = slash(path.resolve(candidate));
  const same = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (same(target, root)) return "";
  const prefix = `${root}/`;
  if (target.length <= prefix.length || !same(target.slice(0, prefix.length), prefix)) return undefined;
  const relative = target.slice(prefix.length);
  return relative.split("/").includes("..") ? undefined : relative;
}

/** Lê um arquivo do projeto pelo caminho relativo (project.json e devices/ inclusive). */
export function readVirtualFile(bundle: LsplcBundle, relative: string): string | undefined {
  if (relative === "project.json") return asText(bundle.project, "{}");
  if (relative === "devices/configuration.json") return asText(bundle.devices.configuration, "{}");
  if (relative === "devices/pin-mapping.json") return asText(bundle.devices.pinMapping, "[]");
  if (relative === "library.json") return bundle.libraryManifest;
  return bundle.files[relative];
}

/** Grava um arquivo do projeto pelo caminho relativo (o "Save file" de uma aba do OpenPLC). */
export function writeVirtualFile(bundle: LsplcBundle, relative: string, content: string): LsplcBundle {
  if (relative === "project.json") return { ...bundle, project: parseJson(content, bundle.project) };
  if (relative === "devices/configuration.json") return { ...bundle, devices: { ...bundle.devices, configuration: parseJson(content, {}) } };
  if (relative === "devices/pin-mapping.json") return { ...bundle, devices: { ...bundle.devices, pinMapping: parseJson(content, []) } };
  if (relative === "library.json") return { ...bundle, libraryManifest: content };
  return { ...bundle, files: { ...bundle.files, [relative]: content } };
}

/** Nome do projeto gravado no project.json (ou o nome do arquivo). */
export function lsplcProjectName(filePath: string, bundle: LsplcBundle): string {
  const meta = (bundle.project as { meta?: { name?: unknown } } | undefined)?.meta;
  return typeof meta?.name === "string" && meta.name ? meta.name : path.basename(filePath, LSPLC_EXTENSION);
}
