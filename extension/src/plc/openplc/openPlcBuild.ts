/*
 * Projeto PLC (.lsplc, projeto do OpenPLC Editor dentro) -> módulo nativo do bloco "PLC IEC 61131-3".
 *
 * O ST sai do transpilador do próprio OpenPLC Editor (pacote do host); os POUs SFC antes passam pela
 * tradução SFC -> ST do LasecSimul (openPlcSfc.ts). Daí em diante: `compileStProgram` ->
 * `lasecsimul-core --plc-compile`.
 */

import * as crypto from "crypto";
import * as path from "path";
import { CanonicalStOrigin, PlcBuildDiagnostic, PlcBuildEntry, PlcBuildOptions, PlcBuildResult, compileStProgram } from "../plcBuild";
import { OPENPLC_BUNDLED_LIBRARIES, OpenPlcEntryPoint, OpenPlcHost, OpenPlcProjectData, loadLsplcProject } from "./openPlcHost";
import { SfcLineOrigin, prepareOpenPlcSfc } from "./openPlcSfc";

export interface OpenPlcBuildProgress {
  stage: "st" | "c" | "done" | "error";
  message: string;
  level: "info" | "warning" | "error";
}

export interface OpenPlcBuildOptions extends PlcBuildOptions {
  host: OpenPlcHost;
  /** Projeto em memória (o editor aberto); sem ele, lê do disco. */
  projectData?: OpenPlcProjectData;
  progress?: (event: OpenPlcBuildProgress) => void;
}

const POU_START = /^\s*(PROGRAM|FUNCTION_BLOCK|FUNCTION)\s+([A-Za-z_][A-Za-z0-9_]*)/i;
const POU_END = /^\s*END_(PROGRAM|FUNCTION_BLOCK|FUNCTION)\b/i;
const VAR_START = /^\s*VAR(_INPUT|_OUTPUT|_IN_OUT|_EXTERNAL|_TEMP|_GLOBAL)?\b/i;
const VAR_END = /^\s*END_VAR\b/i;
const CONFIGURATION_START = /^\s*CONFIGURATION\b/i;
const CONFIGURATION_END = /^\s*END_CONFIGURATION\b/i;

/** Linha do ST gerado -> POU de origem (o OpenPLC emite um POU inteiro por vez). A CONFIGURATION
 * não pertence a POU nenhum: o `PROGRAM instance0 WITH task0 : main;` dela não abre um POU. */
export function openPlcStOrigins(st: string): CanonicalStOrigin[] {
  const origins: CanonicalStOrigin[] = [];
  let pouName: string | undefined;
  let inVar = false;
  let inConfiguration = false;
  // O transpilador do OpenPLC põe uma linha em branco entre o último END_VAR e o corpo
  // (emit/pou-textual.ts); ela não é linha do editor.
  let separatorPending = false;
  let bodyLine = 0;
  for (const line of st.replace(/\r\n/g, "\n").split("\n")) {
    if (!pouName && (inConfiguration || CONFIGURATION_START.test(line))) {
      inConfiguration = !CONFIGURATION_END.test(line);
      origins.push({ pouId: "", pouName: "", section: "header" });
      continue;
    }
    const start = POU_START.exec(line);
    if (!pouName && start?.[2]) {
      pouName = start[2];
      inVar = false;
      bodyLine = 0;
      origins.push({ pouId: pouName, pouName, section: "header" });
      continue;
    }
    if (!pouName) {
      origins.push({ pouId: "", pouName: "", section: "header" });
      continue;
    }
    if (POU_END.test(line)) {
      origins.push({ pouId: pouName, pouName, section: "header" });
      pouName = undefined;
      continue;
    }
    if (VAR_START.test(line)) inVar = true;
    if (inVar) {
      origins.push({ pouId: pouName, pouName, section: "declaration" });
      if (VAR_END.test(line)) {
        inVar = false;
        separatorPending = true;
      }
      continue;
    }
    if (separatorPending && line.trim() === "") {
      separatorPending = false;
      origins.push({ pouId: pouName, pouName, section: "header" });
      continue;
    }
    separatorPending = false;
    bodyLine += 1;
    origins.push({ pouId: pouName, pouName, section: "body", bodyLine });
  }
  return origins;
}

function projectKey(projectFile: string, name: string): string {
  const normalized = process.platform === "win32" ? path.resolve(projectFile).toLowerCase() : path.resolve(projectFile);
  const digest = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 8);
  return `openplc-${name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 24)}-${digest}`;
}

function buildEntry(entry: OpenPlcEntryPoint): PlcBuildEntry {
  return {
    programName: entry.programName,
    ...(entry.instanceName ? { programInstanceName: entry.instanceName } : {}),
    ...(entry.taskName ? { taskName: entry.taskName } : {}),
    taskIntervalMs: entry.taskIntervalMs,
  };
}

/** Linha de um POU SFC no ST gerado -> passo/transição/ação do diagrama. */
function withSfcElements(origins: CanonicalStOrigin[], elementsByPou: Map<string, SfcLineOrigin[]>): CanonicalStOrigin[] {
  if (elementsByPou.size === 0) return origins;
  return origins.map(origin => {
    const lines = elementsByPou.get(origin.pouName);
    if (!lines || origin.section !== "body" || !origin.bodyLine) return origin;
    const element = lines[origin.bodyLine - 1]?.element;
    const { bodyLine: _line, ...rest } = origin;
    return element ? { ...rest, element } : rest;
  });
}

function describe(item: PlcBuildDiagnostic): string {
  const where = item.elementLabel ? ` (${item.elementLabel})` : item.line ? `:${item.line}` : "";
  return item.pouName ? `${item.pouName}${where}: ${item.message}` : item.message;
}

/** Projeto PLC (.lsplc) -> módulo nativo. `projectData`: o projeto em memória do editor aberto. */
export async function buildOpenPlcProject(projectRef: string, options: OpenPlcBuildOptions): Promise<PlcBuildResult> {
  const started = Date.now();
  const progress = options.progress ?? (() => undefined);
  const fail = (diagnostics: PlcBuildDiagnostic[], entry?: PlcBuildEntry): PlcBuildResult => {
    for (const item of diagnostics) progress({ stage: "error", message: describe(item), level: item.severity === "warning" ? "warning" : "error" });
    return { ok: false, diagnostics, log: diagnostics.map(describe).join("\n"), ...(entry ? { entry } : {}) };
  };

  let data = options.projectData;
  let name = path.basename(projectRef, path.extname(projectRef));
  if (!data) {
    try {
      const loaded = loadLsplcProject(options.host, projectRef);
      data = loaded.data;
      name = loaded.name || name;
    } catch (error) {
      return fail([{ severity: "error", stage: "project", message: error instanceof Error ? error.message : String(error) }]);
    }
  }

  let entry: OpenPlcEntryPoint;
  try {
    entry = options.host.entryPoint(data);
  } catch (error) {
    return fail([{ severity: "error", stage: "project", message: error instanceof Error ? error.message : String(error) }]);
  }
  const entryInfo = buildEntry(entry);

  progress({ stage: "st", message: "Generating Structured Text...", level: "info" });
  // SFC: o transpilador do OpenPLC não traduz; vira ST antes, pela tradução do LasecSimul.
  const sfc = prepareOpenPlcSfc(data);
  const sfcErrors = sfc.diagnostics.filter(item => item.severity === "error");
  if (sfcErrors.length > 0) return fail(sfc.diagnostics, entryInfo);
  const warnings: PlcBuildDiagnostic[] = [...sfc.diagnostics];
  for (const warning of sfc.diagnostics) progress({ stage: "st", message: describe(warning), level: "warning" });

  const transpiled = options.host.transpile(sfc.data);
  if (!transpiled.ok || !transpiled.programSt) {
    const errors = transpiled.errors.length > 0 ? transpiled.errors : ["Failed to generate Structured Text"];
    return fail(errors.map(message => ({ severity: "error" as const, stage: "transpile", message })), entryInfo);
  }
  warnings.push(...transpiled.warnings.map(message => ({ severity: "warning" as const, stage: "transpile", message })));
  for (const warning of transpiled.warnings) progress({ stage: "st", message: warning, level: "warning" });
  const st = sfc.prelude ? `${sfc.prelude}\n\n${transpiled.programSt}` : transpiled.programSt;

  if (options.cacheOnly !== true) {
    progress({ stage: "c", message: "Compiling Structured Text to C++ with STruC++ and the LasecSimul PLC runtime...", level: "info" });
  }
  const result = await compileStProgram({
    projectId: projectKey(projectRef, name),
    programName: entry.programName,
    st,
    origins: withSfcElements(openPlcStOrigins(st), sfc.elementsByPou),
    ioIdByVariableName: {},
    entry: entryInfo,
    warnings,
    libraries: OPENPLC_BUNDLED_LIBRARIES,
    cacheSalt: "openplc-4.2.8",
    started,
  }, options);
  if (result.ok) {
    progress({
      stage: "done",
      message: `${result.cached ? "Build is up to date" : "Build finished"} in ${(result.durationMs / 1000).toFixed(1)} s: ${entry.programName}, ${result.module.exportedIo.length} I/O.`,
      level: "info",
    });
  } else {
    for (const item of result.diagnostics) {
      progress({ stage: "error", message: describe(item), level: item.severity === "warning" ? "warning" : "error" });
    }
  }
  return result;
}
