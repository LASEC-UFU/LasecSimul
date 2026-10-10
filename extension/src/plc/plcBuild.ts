/*
 * Compilação de um projeto IEC 61131-3 até o artefato nativo que o bloco "PLC IEC 61131-3" carrega.
 *
 * Projeto (*.iec.json) -> ST canônico (lowering.ts) -> `lasecsimul-core --plc-compile` (STruCpp +
 * compilador C++, PlcCompiler) -> manifesto PlcNativeModule + executável do worker.
 *
 * Cada build fica num diretório nomeado pelo hash do ST e das ferramentas: compilar de novo o mesmo
 * programa não chama o compilador, e o executável de um build que está rodando nunca é
 * sobrescrito (no Windows ele estaria travado).
 */

import { spawn } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { PlcNativeModuleDto } from "../ipc/CoreClient";
import { resolveCoreExecutablePath } from "../core/coreExecutable";
import { readPlcNativeModule } from "./artifact";
import { IecProjectAuthoring, IecProjectStore, IecVariable, PouDefinition, parseIecProject } from "./iecProject";
import { CanonicalStOrigin, generateCanonicalSt } from "./lowering";

export interface PlcToolchainPaths {
  coreExecutable: string;
  strucppBinary: string;
  /** Diretório com os .stlib do pacote da STruCpp (só os da norma são usados, ver IEC_LIBRARIES). */
  strucppLibrarySourceDir: string;
  runtimeIncludeDir: string;
  plcSrcDir: string;
  /** Ausente: o Core procura g++ no PATH e o Visual C++ (PlcCompiler::resolveCxxCompiler). */
  cxxCompiler?: string;
}

/** Bibliotecas da norma e os blocos adicionais do OpenPLC (PID, RAMP, HYSTERESIS...). A OSCAT do
 * pacote fica de fora: TOGGLE, BLINK, CLK_DIV... colidem com FBs do aluno (PlcCompileOptions). */
export const IEC_LIBRARIES = ["iec-standard-fb.stlib", "iec-std-functions.stlib", "additional-function-blocks.stlib"];

/** Tipos que o worker sabe ler, escrever e forçar (PlcDriverCodegen::mapIecTypeToVarTypeTag). */
export const PLC_SCALAR_TYPES = ["BOOL", "SINT", "INT", "DINT", "LINT", "USINT", "UINT", "UDINT", "ULINT",
  "REAL", "LREAL", "BYTE", "WORD", "DWORD", "LWORD", "TIME", "STRING"];

function platformKey(platform: NodeJS.Platform, arch: string): string {
  return `${platform}-${arch}`;
}

/**
 * Instalação (VSIX): tudo em `bundled/plc/`, inclusive o MinGW no Windows. Checkout de
 * desenvolvimento: STruCpp baixado por `npm run build:strucpp`, runtime e fontes do driver em
 * `core/src/plc`, e o MinGW do MSYS2 em `../tools/msys64/ucrt64` quando existir.
 */
export function resolvePlcToolchain(
  extensionPath: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  exists: (candidate: string) => boolean = fs.existsSync,
): PlcToolchainPaths {
  const exe = platform === "win32" ? ".exe" : "";
  const bundled = path.join(extensionPath, "bundled", "plc");
  const repoRoot = path.resolve(extensionPath, "..");
  const bundledStrucpp = path.join(bundled, "strucpp", `strucpp${exe}`);
  const devStrucppDir = path.join(repoRoot, "plc", "strucpp", "build", platformKey(platform, arch), "strucpp");
  const useBundled = exists(bundledStrucpp);
  const strucppDir = useBundled ? path.dirname(bundledStrucpp) : devStrucppDir;

  let cxxCompiler: string | undefined;
  if (platform === "win32") {
    const candidates = [
      path.join(bundled, "mingw64", "bin", "g++.exe"),
      path.resolve(repoRoot, "..", "tools", "msys64", "ucrt64", "bin", "g++.exe"),
    ];
    cxxCompiler = candidates.find(exists);
  }
  return {
    coreExecutable: resolveCoreExecutablePath(extensionPath),
    strucppBinary: path.join(strucppDir, `strucpp${exe}`),
    strucppLibrarySourceDir: path.join(strucppDir, "libs"),
    runtimeIncludeDir: useBundled ? path.join(bundled, "runtime", "include") : path.join(repoRoot, "core", "src", "plc", "runtime", "include"),
    plcSrcDir: useBundled ? path.join(bundled, "src") : path.join(repoRoot, "core", "src", "plc"),
    ...(cxxCompiler ? { cxxCompiler } : {}),
  };
}

interface NamedEntry { name: string }
interface TaskEntry extends NamedEntry { intervalMs?: number; priority?: number }
interface ResourceEntry extends NamedEntry { task?: string }
interface ConfigurationEntry extends NamedEntry { resource?: string }
interface ProgramInstanceEntry extends NamedEntry { pouId?: string; task?: string }

function named<T extends NamedEntry>(values: unknown[]): T[] {
  return values.filter((value): value is T =>
    !!value && typeof value === "object" && typeof (value as NamedEntry).name === "string");
}

export interface PlcEntryPoint {
  pou: PouDefinition;
  configurationName?: string;
  resourceName?: string;
  programInstanceName?: string;
  taskName?: string;
  /** Período da tarefa cíclica que executa o programa; 10 ms quando o projeto não define. */
  taskIntervalMs: number;
  /** Instâncias de programa a mais no mesmo recurso: nesta etapa só a primeira roda. */
  ignoredProgramInstances: string[];
}

/** CONFIGURATION de entrada (buildSettings.entryConfiguration) -> RESOURCE -> instância de
 * programa associada a uma TASK desse recurso -> POU PROGRAM e período da tarefa. */
export function resolvePlcEntryPoint(project: IecProjectAuthoring): PlcEntryPoint {
  const configurations = named<ConfigurationEntry>(project.configurations);
  const resources = named<ResourceEntry>(project.resources);
  const tasks = named<TaskEntry>(project.tasks);
  const instances = named<ProgramInstanceEntry>(project.programInstances);
  const programs = project.pous.filter(pou => pou.kind === "program");
  const wanted = typeof project.buildSettings.entryConfiguration === "string" ? project.buildSettings.entryConfiguration : undefined;
  const configuration = configurations.find(item => item.name === wanted) ?? configurations[0];
  const resource = resources.find(item => item.name === configuration?.resource) ?? resources[0];
  const resourceTasks = new Set(tasks.filter(task => !resource?.task || task.name === resource.task).map(task => task.name));
  const candidates = instances.filter(instance => programs.some(pou => pou.pouId === instance.pouId) &&
    (!instance.task || resourceTasks.size === 0 || resourceTasks.has(instance.task)));
  const instance = candidates[0];
  const pou = programs.find(item => item.pouId === instance?.pouId) ?? programs[0];
  if (!pou) throw new Error("O projeto não tem nenhum POU do tipo PROGRAM.");
  const task = tasks.find(item => item.name === instance?.task) ?? tasks.find(item => resourceTasks.has(item.name)) ?? tasks[0];
  const interval = Number(task?.intervalMs);
  return {
    pou,
    ...(configuration ? { configurationName: configuration.name } : {}),
    ...(resource ? { resourceName: resource.name } : {}),
    ...(instance ? { programInstanceName: instance.name } : {}),
    ...(task ? { taskName: task.name } : {}),
    taskIntervalMs: Number.isFinite(interval) && interval > 0 ? interval : 10,
    ignoredProgramInstances: candidates.slice(1).map(item => item.name),
  };
}

export interface PlcExportedIoEntry {
  ioId: string;
  name: string;
  direction: "input" | "output";
  iecType: string;
}

/** Pinos do bloco PLC: VAR_INPUT e VAR_OUTPUT do programa de entrada, na ordem declarada. Sai do
 * projeto sem compilar, igual ao que o Core devolve em `exportedIo` depois da compilação. */
export function plcExportedIoFromProject(project: IecProjectAuthoring): PlcExportedIoEntry[] {
  const { pou } = resolvePlcEntryPoint(project);
  return pou.interface.variables
    .filter((variable): variable is IecVariable & { class: "input" | "output" } => variable.class === "input" || variable.class === "output")
    .map(variable => ({
      ioId: variable.ioId ?? variable.name,
      name: variable.name,
      direction: variable.class,
      iecType: variable.type.toUpperCase(),
    }));
}

export interface PlcWatchVariable {
  name: string;
  /** Nome usado em plcGet/plcSet/plcForce: `PROGRAMA.VARIAVEL` em maiúsculas. */
  qualifiedName: string;
  iecType: string;
  role: "input" | "output" | "local";
}

/** Variáveis do programa que o worker publica (entradas, saídas e locais escalares). */
export function plcWatchVariables(pou: PouDefinition): PlcWatchVariable[] {
  return pou.interface.variables
    .filter(variable => variable.class === "input" || variable.class === "output" ||
      ((variable.class === "local") && PLC_SCALAR_TYPES.includes(variable.type.toUpperCase())))
    .map(variable => ({
      name: variable.name,
      qualifiedName: `${pou.name.toUpperCase()}.${variable.name.toUpperCase()}`,
      iecType: variable.type.toUpperCase(),
      role: variable.class === "local" ? "local" : variable.class as "input" | "output",
    }));
}

export interface PlcBuildDiagnostic {
  severity: "error" | "warning";
  stage: string;
  message: string;
  pouId?: string;
  pouName?: string;
  /** Linha no corpo do POU (1 = primeira linha do editor). */
  line?: number;
  column?: number;
  /** Variável cuja declaração causou o erro. */
  variableName?: string;
}

export type PlcBuildResult =
  | {
    ok: true;
    module: PlcNativeModuleDto;
    manifestPath: string;
    entry: PlcEntryPoint;
    cached: boolean;
    durationMs: number;
    warnings: PlcBuildDiagnostic[];
  }
  | { ok: false; diagnostics: PlcBuildDiagnostic[]; log: string; entry?: PlcEntryPoint };

export interface PlcBuildOptions {
  toolchain: PlcToolchainPaths;
  cacheRoot: string;
  /** Só procura um build já feito; não chama o compilador. */
  cacheOnly?: boolean;
  log?: (line: string) => void;
}

function sha256(text: string | Buffer): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function fileStamp(filePath: string | undefined): string {
  if (!filePath) return "";
  try {
    const stat = fs.statSync(filePath);
    return `${filePath}:${stat.size}:${Math.round(stat.mtimeMs)}`;
  } catch {
    return `${filePath}:missing`;
  }
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40) || "plc";
}

/** Erro do STruCpp (`programa.st:8:16: error: ...`) ou do g++ via #line. */
const SOURCE_DIAGNOSTIC = /^(?:.*[\\/])?([^\\/:]+\.st):(\d+):(\d+):\s*(error|warning):\s*(.*)$/;

export function mapCompilerOutput(output: string, origins: CanonicalStOrigin[], stage: string): PlcBuildDiagnostic[] {
  const result: PlcBuildDiagnostic[] = [];
  const seen = new Set<string>();
  for (const rawLine of output.split(/\r?\n/)) {
    const match = SOURCE_DIAGNOSTIC.exec(rawLine.trim());
    if (!match) continue;
    const generatedLine = Number(match[2]);
    const origin = origins[generatedLine - 1];
    const diagnostic: PlcBuildDiagnostic = {
      severity: match[4] === "warning" ? "warning" : "error",
      stage,
      message: match[5]!.trim(),
      column: Number(match[3]),
      ...(origin ? { pouId: origin.pouId, pouName: origin.pouName } : {}),
      ...(origin?.section === "body" ? { line: origin.bodyLine } : {}),
      ...(origin?.variableName ? { variableName: origin.variableName } : {}),
    };
    const key = `${diagnostic.pouId}:${diagnostic.line}:${diagnostic.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(diagnostic);
  }
  return result;
}

/** Copia só as bibliotecas da norma para um diretório próprio (STruCpp lê todas de um `-L`). */
function prepareIecLibraryDir(toolchain: PlcToolchainPaths, cacheRoot: string): string {
  const source = toolchain.strucppLibrarySourceDir;
  const present = IEC_LIBRARIES.filter(name => fs.existsSync(path.join(source, name)));
  if (present.length === 0) throw new Error(`Bibliotecas IEC do STruCpp não encontradas em ${source}`);
  const digest = sha256(present.map(name => fileStamp(path.join(source, name))).join("|")).slice(0, 12);
  const target = path.join(cacheRoot, `strucpp-libs-${digest}`);
  if (!present.every(name => fs.existsSync(path.join(target, name)))) {
    fs.mkdirSync(target, { recursive: true });
    for (const name of present) fs.copyFileSync(path.join(source, name), path.join(target, name));
  }
  return target;
}

function runCore(coreExecutable: string, requestPath: string, cxxCompiler: string | undefined, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    // cc1plus, as e ld do MinGW carregam DLLs do bin/ do toolchain: sem ele no PATH o g++ sai sem
    // mensagem nenhuma.
    if (cxxCompiler && path.isAbsolute(cxxCompiler)) {
      const pathKey = Object.keys(env).find(key => key.toUpperCase() === "PATH") ?? "PATH";
      env[pathKey] = `${path.dirname(cxxCompiler)}${path.delimiter}${env[pathKey] ?? ""}`;
    }
    const child = spawn(coreExecutable, ["--plc-compile", requestPath], { env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

async function verifiedCachedModule(manifestPath: string): Promise<PlcNativeModuleDto | undefined> {
  if (!fs.existsSync(manifestPath)) return undefined;
  try {
    const module = await readPlcNativeModule(manifestPath);
    if (!fs.existsSync(module.nativeBinaryRef)) return undefined;
    if (sha256(fs.readFileSync(module.nativeBinaryRef)) !== module.artifactHash) return undefined;
    return module;
  } catch {
    return undefined;
  }
}

/** Builds antigos do mesmo projeto. Um executável ainda em uso fica (o Windows não deixa apagar). */
function removeStaleBuilds(cacheRoot: string, prefix: string, keep: string): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(cacheRoot, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix) || entry.name === keep) continue;
    try { fs.rmSync(path.join(cacheRoot, entry.name), { recursive: true, force: true }); } catch { /* em uso */ }
  }
}

export async function buildIecProjectFile(projectPath: string, options: PlcBuildOptions): Promise<PlcBuildResult> {
  let project: IecProjectAuthoring;
  try {
    project = parseIecProject(JSON.parse(fs.readFileSync(projectPath, "utf8")));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, diagnostics: [{ severity: "error", stage: "project", message }], log: message };
  }
  return buildIecProject(project, options);
}

export async function buildIecProject(project: IecProjectAuthoring, options: PlcBuildOptions): Promise<PlcBuildResult> {
  const started = Date.now();
  const log = options.log ?? (() => undefined);
  const fail = (diagnostics: PlcBuildDiagnostic[], text: string, entry?: PlcEntryPoint): PlcBuildResult =>
    ({ ok: false, diagnostics, log: text, ...(entry ? { entry } : {}) });

  let entry: PlcEntryPoint;
  try {
    entry = resolvePlcEntryPoint(project);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail([{ severity: "error", stage: "project", message }], message);
  }
  const store = new IecProjectStore(project);
  const warnings: PlcBuildDiagnostic[] = [];
  for (const ignored of entry.ignoredProgramInstances) {
    warnings.push({ severity: "warning", stage: "configuration",
      message: `A instância de programa ${ignored} não roda: nesta versão cada bloco PLC executa uma instância (${entry.programInstanceName ?? entry.pou.name}).` });
  }
  for (const pou of project.pous) {
    if (pou.implementation.language !== "st") {
      warnings.push({ severity: "warning", stage: "project", pouId: pou.pouId, pouName: pou.name,
        message: `${pou.name} está em ${pou.implementation.language.toUpperCase()}: a tradução desta linguagem para ST ainda é experimental.` });
    }
  }

  let canonical: ReturnType<typeof generateCanonicalSt>;
  try {
    canonical = generateCanonicalSt(store, project.projectId, entry.pou.pouId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail([{ severity: "error", stage: "project", message }], message, entry);
  }

  const ioIdByVariableName: Record<string, string> = {};
  for (const variable of entry.pou.interface.variables) {
    if ((variable.class === "input" || variable.class === "output") && variable.ioId) ioIdByVariableName[variable.name] = variable.ioId;
  }

  const { toolchain, cacheRoot } = options;
  const key = sha256(JSON.stringify({
    st: canonical.text,
    io: ioIdByVariableName,
    strucpp: fileStamp(toolchain.strucppBinary),
    cxx: fileStamp(toolchain.cxxCompiler),
    core: fileStamp(toolchain.coreExecutable),
    runtime: fileStamp(path.join(toolchain.runtimeIncludeDir, "iec_std_lib.hpp")),
    driver: fileStamp(path.join(toolchain.plcSrcDir, "PlcScanSession.cpp")),
  })).slice(0, 16);
  const prefix = `${safeName(project.projectId)}-`;
  const buildName = `${prefix}${key}`;
  const buildDir = path.join(cacheRoot, buildName);
  const manifestPath = path.join(buildDir, "artifact.json");

  const cachedModule = await verifiedCachedModule(manifestPath);
  if (cachedModule) {
    return { ok: true, module: cachedModule, manifestPath, entry, cached: true, durationMs: Date.now() - started, warnings };
  }
  if (options.cacheOnly) {
    return fail([{ severity: "error", stage: "cache", message: "Programa ainda não compilado." }], "", entry);
  }

  for (const required of [toolchain.coreExecutable, toolchain.strucppBinary, toolchain.runtimeIncludeDir, toolchain.plcSrcDir]) {
    if (!fs.existsSync(required)) {
      const message = `Ferramenta de compilação do CLP não encontrada: ${required}`;
      return fail([{ severity: "error", stage: "toolchain", message }], message, entry);
    }
  }

  fs.rmSync(buildDir, { recursive: true, force: true });
  fs.mkdirSync(buildDir, { recursive: true });
  let libraryDir: string;
  try {
    libraryDir = prepareIecLibraryDir(toolchain, cacheRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail([{ severity: "error", stage: "toolchain", message }], message, entry);
  }
  const stName = `${entry.pou.name.toLowerCase()}.st`;
  const stPath = path.join(buildDir, stName);
  fs.writeFileSync(stPath, canonical.text, "utf8");
  const requestPath = path.join(buildDir, "request.json");
  fs.writeFileSync(requestPath, `${JSON.stringify({
    stSourcePath: stPath,
    workDir: buildDir,
    strucppBinaryPath: toolchain.strucppBinary,
    strucppLibraryDirs: [libraryDir],
    runtimeIncludeDir: toolchain.runtimeIncludeDir,
    lasecsimulPlcSrcDir: toolchain.plcSrcDir,
    manifestPath,
    ...(toolchain.cxxCompiler ? { cxxCompilerPath: toolchain.cxxCompiler } : {}),
    ioIdByVariableName,
  }, null, 2)}\n`, "utf8");

  log(`Compilando ${entry.pou.name} (${stName}) em ${buildDir}`);
  let run: Awaited<ReturnType<typeof runCore>>;
  try {
    run = await runCore(toolchain.coreExecutable, requestPath, toolchain.cxxCompiler, 180_000);
  } catch (error) {
    const message = `Não foi possível iniciar o compilador do CLP: ${error instanceof Error ? error.message : String(error)}`;
    return fail([{ severity: "error", stage: "toolchain", message }], message, entry);
  }
  const responseLine = run.stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
  let response: { ok?: boolean; diagnostics?: { stage?: string; message?: string; capturedOutput?: string; exitCode?: number } };
  try {
    response = JSON.parse(responseLine);
  } catch {
    const message = `O compilador do CLP terminou sem resposta (código ${run.code}). ${run.stderr.trim()}`.trim();
    return fail([{ severity: "error", stage: "toolchain", message }], `${run.stdout}\n${run.stderr}`, entry);
  }
  if (!response.ok) {
    const stage = response.diagnostics?.stage ?? "unknown";
    const captured = response.diagnostics?.capturedOutput ?? "";
    const mapped = mapCompilerOutput(captured, canonical.origins, stage);
    const diagnostics = mapped.length > 0 ? mapped : [{
      severity: "error" as const,
      stage,
      message: [response.diagnostics?.message, captured.trim().split(/\r?\n/).slice(0, 12).join("\n")].filter(Boolean).join("\n"),
    }];
    log(`Falhou (${stage}): ${response.diagnostics?.message ?? ""}`);
    if (captured) log(captured);
    return fail([...warnings, ...diagnostics], captured || (response.diagnostics?.message ?? ""), entry);
  }
  const module = await readPlcNativeModule(manifestPath);
  removeStaleBuilds(cacheRoot, prefix, buildName);
  const durationMs = Date.now() - started;
  log(`Compilado em ${(durationMs / 1000).toFixed(1)} s: ${module.exportedIo.length} E/S, ${module.cxxToolchainVersion}`);
  return { ok: true, module, manifestPath, entry, cached: false, durationMs, warnings };
}

export function defaultPlcCacheRoot(globalStoragePath: string | undefined): string {
  return path.join(globalStoragePath ?? path.join(os.tmpdir(), "lasecsimul"), "plc-builds");
}
