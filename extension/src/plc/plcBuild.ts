/*
 * Compilação do programa de um projeto PLC até o artefato nativo que o bloco "PLC IEC 61131-3"
 * carrega: ST (gerado do projeto .lsplc por openplc/openPlcBuild.ts) -> `lasecsimul-core
 * --plc-compile` (STruCpp + compilador C++, PlcCompiler) -> manifesto PlcNativeModule + executável
 * do worker.
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
import type { SfcElement } from "./sfcLowering";

export interface PlcToolchainPaths {
  coreExecutable: string;
  strucppBinary: string;
  /** Diretório com os .stlib do pacote da STruCpp. */
  strucppLibrarySourceDir: string;
  runtimeIncludeDir: string;
  plcSrcDir: string;
  /** Ausente: o Core procura g++ no PATH e o Visual C++ (PlcCompiler::resolveCxxCompiler). */
  cxxCompiler?: string;
}

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

export interface PlcExportedIoEntry {
  ioId: string;
  name: string;
  direction: "input" | "output";
  iecType: string;
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

/** De onde veio cada linha do ST gerado: erros do STruCpp e do g++ (via #line) apontam para a
 * linha gerada, e o editor mostra o POU e a linha do corpo que o aluno escreveu. */
export interface CanonicalStOrigin {
  pouId: string;
  pouName: string;
  section: "header" | "declaration" | "body";
  /** Linha do corpo (1 = primeira linha do texto do POU), só em `section: "body"`. */
  bodyLine?: number;
  /** Variável declarada nesta linha, em `section: "declaration"`. */
  variableName?: string;
  /** SFC: passo, transição ou ação que gerou a linha. */
  element?: SfcElement;
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
export function prepareIecLibraryDir(toolchain: PlcToolchainPaths, cacheRoot: string, libraries: readonly string[]): string {
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
  /** .stlib passadas à STruCpp. */
  libraries: readonly string[];
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
  const { libraries } = input;
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
    libraries,
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
