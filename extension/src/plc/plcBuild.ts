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
import { CanonicalStOrigin, IecLoweringError, generateCanonicalSt } from "./lowering";

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
      path.join(bundled, "ucrt64", "bin", "g++.exe"),
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
interface TaskEntry extends NamedEntry { intervalMs?: number; priority?: number; eventVariable?: string }
interface ResourceEntry extends NamedEntry { task?: string; tasks?: string[] }
interface ConfigurationEntry extends NamedEntry { resource?: string }
interface ProgramInstanceEntry extends NamedEntry { pouId?: string; task?: string }

function named<T extends NamedEntry>(values: unknown[]): T[] {
  return values.filter((value): value is T =>
    !!value && typeof value === "object" && typeof (value as NamedEntry).name === "string");
}

export interface PlcEntryPoint {
  pou: PouDefinition;
  programName: string;
  configurationName?: string;
  resourceName?: string;
  programInstanceName?: string;
  taskName?: string;
  /** Período da tarefa cíclica que executa o programa; 10 ms quando o projeto não define. */
  taskIntervalMs: number;
}

/** CONFIGURATION de entrada -> RESOURCE -> instância de programa/TASK de entrada -> POU PROGRAM.
 * O módulo também preserva e executa as demais tasks e instâncias configuradas. */
export function resolvePlcEntryPoint(project: IecProjectAuthoring): PlcEntryPoint {
  const configurations = named<ConfigurationEntry>(project.configurations);
  const resources = named<ResourceEntry>(project.resources);
  const tasks = named<TaskEntry>(project.tasks);
  const instances = named<ProgramInstanceEntry>(project.programInstances);
  const programs = project.pous.filter(pou => pou.kind === "program");
  const wanted = typeof project.buildSettings.entryConfiguration === "string" ? project.buildSettings.entryConfiguration : undefined;
  const configuration = configurations.find(item => item.name === wanted) ?? configurations[0];
  const resource = resources.find(item => item.name === configuration?.resource) ?? resources[0];
  const assignedTaskNames = Array.isArray(resource?.tasks) ? resource.tasks : resource?.task ? [resource.task] : [];
  const resourceTasks = new Set(tasks.filter(task => assignedTaskNames.length === 0 || assignedTaskNames.includes(task.name)).map(task => task.name));
  const candidates = instances.filter(instance => programs.some(pou => pou.pouId === instance.pouId) &&
    (!instance.task || resourceTasks.size === 0 || resourceTasks.has(instance.task)));
  const instance = candidates[0];
  const pou = programs.find(item => item.pouId === instance?.pouId) ?? programs[0];
  if (!pou) throw new Error("O projeto não tem nenhum POU do tipo PROGRAM.");
  const task = tasks.find(item => item.name === instance?.task) ?? tasks.find(item => resourceTasks.has(item.name)) ?? tasks[0];
  const interval = Number(task?.intervalMs);
  return {
    pou,
    programName: pou.name,
    ...(configuration ? { configurationName: configuration.name } : {}),
    ...(resource ? { resourceName: resource.name } : {}),
    ...(instance ? { programInstanceName: instance.name } : {}),
    ...(task ? { taskName: task.name } : {}),
    taskIntervalMs: Number.isFinite(interval) && interval > 0 ? interval : 10,
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
export function plcWatchVariables(pou: PouDefinition, project?: IecProjectAuthoring): PlcWatchVariable[] {
  const result: PlcWatchVariable[] = [];
  const scalarTypes = new Set(PLC_SCALAR_TYPES);
  const dataTypes = [
    ...(project?.dataTypes ?? []),
    ...(project?.pous.filter(item => item.kind === "functionBlock").map(item => ({
      name: item.name,
      kind: "struct" as const,
      fields: item.interface.variables.map(variable => ({ name: variable.name, type: variable.type })),
    })) ?? []),
    ...Object.entries({
      TON: [["IN", "BOOL"], ["PT", "TIME"], ["Q", "BOOL"], ["ET", "TIME"]],
      TOF: [["IN", "BOOL"], ["PT", "TIME"], ["Q", "BOOL"], ["ET", "TIME"]],
      TP: [["IN", "BOOL"], ["PT", "TIME"], ["Q", "BOOL"], ["ET", "TIME"]],
      R_TRIG: [["CLK", "BOOL"], ["Q", "BOOL"]], F_TRIG: [["CLK", "BOOL"], ["Q", "BOOL"]],
      SR: [["S1", "BOOL"], ["R", "BOOL"], ["Q1", "BOOL"]],
      RS: [["S", "BOOL"], ["R1", "BOOL"], ["Q1", "BOOL"]],
      CTU: [["CU", "BOOL"], ["R", "BOOL"], ["PV", "INT"], ["Q", "BOOL"], ["CV", "INT"]],
      CTD: [["CD", "BOOL"], ["LD", "BOOL"], ["PV", "INT"], ["Q", "BOOL"], ["CV", "INT"]],
      CTUD: [["CU", "BOOL"], ["CD", "BOOL"], ["R", "BOOL"], ["LD", "BOOL"], ["PV", "INT"], ["QU", "BOOL"], ["QD", "BOOL"], ["CV", "INT"]],
    }).map(([name, fields]) => ({
      name, kind: "struct" as const, fields: (fields as string[][]).map(([fieldName, type]) => ({ name: fieldName!, type: type! })),
    })),
  ];
  const appendArray = (pathName: string, elementType: string, bounds: Array<readonly [number, number]>,
    stack: Set<string>, budget: number): void => {
    let remaining = budget;
    const visit = (dimension: number, indices: number[]): void => {
      if (remaining <= 0) return;
      if (dimension === bounds.length) {
        remaining -= 1;
        append(`${pathName}${indices.map(index => `[${index}]`).join("")}`, elementType, stack, remaining);
        return;
      }
      const [lower, upper] = bounds[dimension]!;
      for (let index = lower; index <= upper && remaining > 0; index++) visit(dimension + 1, [...indices, index]);
    };
    visit(0, []);
  };
  const append = (pathName: string, typeName: string, stack: Set<string>, budget = 2048): void => {
    const normalized = typeName.trim().toUpperCase();
    if (scalarTypes.has(normalized)) {
      result.push({ name: pathName, qualifiedName: `${pou.name.toUpperCase()}.${pathName}`, iecType: normalized, role: "local" });
      return;
    }
    const derived = dataTypes.find(type => type.name.toUpperCase() === normalized);
    if (derived) {
      if (stack.has(normalized)) return;
      const nextStack = new Set(stack).add(normalized);
      if (derived.kind === "alias") append(pathName, derived.baseType, nextStack, budget);
      else if (derived.kind === "struct") {
        for (const field of derived.fields) append(`${pathName}.${field.name.toUpperCase()}`, field.type, nextStack, budget);
      } else if (derived.kind === "array") {
        const bounds = derived.dimensions.map(bound => {
          const match = /^\s*(-?\d+)\s*\.\.\s*(-?\d+)\s*$/.exec(bound);
          return match ? [Number(match[1]), Number(match[2])] as const : undefined;
        });
        if (bounds.some(bound => !bound || bound[1] < bound[0])) return;
        appendArray(pathName, derived.elementType, bounds as Array<readonly [number, number]>, nextStack, budget);
      }
      return;
    }
    const inlineArray = /^ARRAY\s*\[([^\]]+)\]\s*OF\s*(.+)$/i.exec(typeName.trim());
    if (inlineArray) {
      const bounds = inlineArray[1]!.split(",").map(bound => {
        const match = /^\s*(-?\d+)\s*\.\.\s*(-?\d+)\s*$/.exec(bound);
        return match ? [Number(match[1]), Number(match[2])] as const : undefined;
      });
      if (bounds.some(bound => !bound || bound[1] < bound[0])) return;
      appendArray(pathName, inlineArray[2]!, bounds as Array<readonly [number, number]>, stack, budget);
    }
  };

  for (const variable of pou.interface.variables) {
    if (variable.class === "input" || variable.class === "output") {
      if (scalarTypes.has(variable.type.toUpperCase())) result.push({
        name: variable.name,
        qualifiedName: `${pou.name.toUpperCase()}.${variable.name.toUpperCase()}`,
        iecType: variable.type.toUpperCase(),
        role: variable.class,
      });
    } else if (variable.class === "local") append(variable.name.toUpperCase(), variable.type, new Set());
  }
  return result;
}

/** Resposta de plcGet/plcSet/plcForce: `MAIN.LAMP : BOOL = TRUE [FORCED]`. */
export function parsePlcVariableReply(reply: string): { value: string; forced: boolean } {
  const forced = /\s\[FORCED\]\s*$/.test(reply);
  const text = reply.replace(/\s\[FORCED\]\s*$/, "");
  const equals = text.indexOf(" = ");
  return { value: (equals >= 0 ? text.slice(equals + 3) : text).trim(), forced };
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
  /** SFC: passo, transição ou ação (id do elemento e rótulo legível). */
  elementId?: string;
  elementLabel?: string;
}

/** O que o resto da extensão usa do programa de entrada: nome, TASK e período. */
export interface PlcBuildEntry {
  programName: string;
  configurationName?: string;
  resourceName?: string;
  programInstanceName?: string;
  taskName?: string;
  taskIntervalMs: number;
}

export type PlcBuildResult =
  | {
    ok: true;
    module: PlcNativeModuleDto;
    manifestPath: string;
    entry: PlcBuildEntry;
    cached: boolean;
    durationMs: number;
    warnings: PlcBuildDiagnostic[];
  }
  | { ok: false; diagnostics: PlcBuildDiagnostic[]; log: string; entry?: PlcBuildEntry };

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
      ...(origin?.element ? { elementId: origin.element.id, elementLabel: origin.element.label } : {}),
    };
    const key = `${diagnostic.pouId}:${diagnostic.line}:${diagnostic.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(diagnostic);
  }
  return result;
}

/** Copia só as bibliotecas pedidas para um diretório próprio (STruCpp lê todas de um `-L`). */
export function prepareIecLibraryDir(toolchain: PlcToolchainPaths, cacheRoot: string, libraries: readonly string[] = IEC_LIBRARIES): string {
  const source = toolchain.strucppLibrarySourceDir;
  const present = libraries.filter(name => fs.existsSync(path.join(source, name)));
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
  for (const pou of project.pous) {
    if (pou.implementation.language === "ld" && !pou.implementation.rungs) {
      warnings.push({ severity: "warning", stage: "project", pouId: pou.pouId, pouName: pou.name,
        message: `${pou.name} está em ${pou.implementation.language.toUpperCase()}: a tradução desta linguagem para ST ainda é experimental.` });
    }
  }

  let canonical: ReturnType<typeof generateCanonicalSt>;
  try {
    canonical = generateCanonicalSt(store, project.projectId, entry.pou.pouId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof IecLoweringError) {
      return fail([...warnings, ...error.diagnostics.map(item => ({
        severity: "error" as const, stage: "lowering", message: item.message, pouId: item.pouId, pouName: item.pouName, line: item.line,
        ...(item.element ? { elementId: item.element.id, elementLabel: item.element.label } : {}),
      }))], message, entry);
    }
    return fail([{ severity: "error", stage: "project", message }], message, entry);
  }

  const ioIdByVariableName: Record<string, string> = {};
  for (const variable of entry.pou.interface.variables) {
    if ((variable.class === "input" || variable.class === "output") && variable.ioId) ioIdByVariableName[variable.name] = variable.ioId;
  }
  return compileStProgram({
    projectId: project.projectId,
    programName: entry.pou.name,
    st: canonical.text,
    origins: canonical.origins,
    ioIdByVariableName,
    entry,
    warnings,
    started,
  }, options);
}

export interface StProgramBuildInput {
  /** Prefixo do diretório de build (builds antigos do mesmo projeto são apagados). */
  projectId: string;
  programName: string;
  st: string;
  /** Linha do ST gerado -> POU/linha do editor, para os diagnósticos. Vazio: sem mapeamento. */
  origins: CanonicalStOrigin[];
  ioIdByVariableName: Record<string, string>;
  entry: PlcBuildEntry;
  warnings?: PlcBuildDiagnostic[];
  /** .stlib passadas à STruCpp; padrão IEC_LIBRARIES. */
  libraries?: readonly string[];
  /** Entra na chave do cache junto com o ST (ex.: o mesmo ST com outro mapeamento de diagnóstico). */
  cacheSalt?: string;
  started?: number;
}

/** ST pronto -> `lasecsimul-core --plc-compile` -> módulo nativo, com cache pelo hash do ST e das ferramentas. */
export async function compileStProgram(input: StProgramBuildInput, options: PlcBuildOptions): Promise<PlcBuildResult> {
  const started = input.started ?? Date.now();
  const log = options.log ?? (() => undefined);
  const { entry, ioIdByVariableName } = input;
  const warnings = input.warnings ?? [];
  const libraries = input.libraries ?? IEC_LIBRARIES;
  const fail = (diagnostics: PlcBuildDiagnostic[], text: string): PlcBuildResult =>
    ({ ok: false, diagnostics, log: text, entry });

  const { toolchain, cacheRoot } = options;
  const key = sha256(JSON.stringify({
    st: input.st,
    io: ioIdByVariableName,
    strucpp: fileStamp(toolchain.strucppBinary),
    cxx: fileStamp(toolchain.cxxCompiler),
    core: fileStamp(toolchain.coreExecutable),
    runtime: fileStamp(path.join(toolchain.runtimeIncludeDir, "iec_std_lib.hpp")),
    driver: fileStamp(path.join(toolchain.plcSrcDir, "PlcScanSession.cpp")),
    compiler: fileStamp(path.join(toolchain.plcSrcDir, "PlcCompiler.cpp")),
    parser: fileStamp(path.join(toolchain.plcSrcDir, "PlcInterfaceParser.cpp")),
    driverCodegen: fileStamp(path.join(toolchain.plcSrcDir, "PlcDriverCodegen.cpp")),
    // Só entram quando diferentes do padrão: a chave dos projetos .iec.json continua a mesma.
    ...(input.libraries ? { libraries } : {}),
    ...(input.cacheSalt ? { salt: input.cacheSalt } : {}),
  })).slice(0, 16);
  const prefix = `${safeName(input.projectId)}-`;
  const buildName = `${prefix}${key}`;
  const buildDir = path.join(cacheRoot, buildName);
  const manifestPath = path.join(buildDir, "artifact.json");

  const cachedModule = await verifiedCachedModule(manifestPath);
  if (cachedModule) {
    return { ok: true, module: cachedModule, manifestPath, entry, cached: true, durationMs: Date.now() - started, warnings };
  }
  if (options.cacheOnly) {
    return fail([{ severity: "error", stage: "cache", message: "Programa ainda não compilado." }], "");
  }

  for (const required of [toolchain.coreExecutable, toolchain.strucppBinary, toolchain.runtimeIncludeDir, toolchain.plcSrcDir]) {
    if (!fs.existsSync(required)) {
      const message = `Ferramenta de compilação do CLP não encontrada: ${required}`;
      return fail([{ severity: "error", stage: "toolchain", message }], message);
    }
  }

  fs.rmSync(buildDir, { recursive: true, force: true });
  fs.mkdirSync(buildDir, { recursive: true });
  let libraryDir: string;
  try {
    libraryDir = prepareIecLibraryDir(toolchain, cacheRoot, libraries);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail([{ severity: "error", stage: "toolchain", message }], message);
  }
  const stName = `${input.programName.toLowerCase()}.st`;
  const stPath = path.join(buildDir, stName);
  fs.writeFileSync(stPath, input.st, "utf8");
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

  log(`Compilando ${input.programName} (${stName}) em ${buildDir}`);
  let run: Awaited<ReturnType<typeof runCore>>;
  try {
    run = await runCore(toolchain.coreExecutable, requestPath, toolchain.cxxCompiler, 180_000);
  } catch (error) {
    const message = `Não foi possível iniciar o compilador do CLP: ${error instanceof Error ? error.message : String(error)}`;
    return fail([{ severity: "error", stage: "toolchain", message }], message);
  }
  const responseLine = run.stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
  let response: { ok?: boolean; diagnostics?: { stage?: string; message?: string; capturedOutput?: string; exitCode?: number } };
  try {
    response = JSON.parse(responseLine);
  } catch {
    const message = `O compilador do CLP terminou sem resposta (código ${run.code}). ${run.stderr.trim()}`.trim();
    return fail([{ severity: "error", stage: "toolchain", message }], `${run.stdout}\n${run.stderr}`);
  }
  if (!response.ok) {
    const stage = response.diagnostics?.stage ?? "unknown";
    const captured = response.diagnostics?.capturedOutput ?? "";
    const mapped = mapCompilerOutput(captured, input.origins, stage);
    const diagnostics = mapped.length > 0 ? mapped : [{
      severity: "error" as const,
      stage,
      message: [response.diagnostics?.message, captured.trim().split(/\r?\n/).slice(0, 12).join("\n")].filter(Boolean).join("\n"),
    }];
    log(`Falhou (${stage}): ${response.diagnostics?.message ?? ""}`);
    if (captured) log(captured);
    return fail([...warnings, ...diagnostics], captured || (response.diagnostics?.message ?? ""));
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
