import * as path from "path";
import * as vscode from "vscode";
import { getDiagnosticsCollection } from "./simulationLog";

/** Diagnósticos REAIS (arquivo/linha/coluna) de erro de compilação VHDL -- distinto de
 * `reportFirmwareDiagnostic` (sempre `Range(0,0,0,0)` ancorado no `.lsproj`, formato adequado pra
 * "firmware não encontrado" mas não pra um erro de sintaxe num arquivo fonte real). GHDL emite
 * `arquivo:linha:coluna: mensagem` por padrão -- confirmado contra GHDL 6.0.0 real (Spike 0/Step
 * 4/6, ver `GhdlBackendRealGhdlTest.cpp::testInvalidVhdlReportsCompileFailure`). Este é o primeiro
 * parser de stderr de toolchain baseado em regex no codebase (pesquisado, não havia precedente) --
 * mantido deliberadamente simples (uma linha = um diagnóstico) em vez de tentar reconstruir erros
 * multi-linha do GHDL (contexto de "note:"/trecho de código citado), suficiente pro Problems panel
 * apontar pro lugar certo. */

const GHDL_MESSAGE_PATTERN = /^(.+?):(\d+):(\d+):\s*(.*)$/;

interface ParsedGhdlMessage {
  filePath: string;
  line: number;
  column: number;
  message: string;
}

function parseGhdlLog(log: string): ParsedGhdlMessage[] {
  const results: ParsedGhdlMessage[] = [];
  for (const rawLine of log.split(/\r?\n/)) {
    const match = GHDL_MESSAGE_PATTERN.exec(rawLine.trim());
    if (!match) continue;
    const line = Number(match[2]);
    const column = Number(match[3]);
    if (!Number.isFinite(line) || !Number.isFinite(column) || line < 1 || column < 1) continue;
    results.push({ filePath: match[1] ?? "", line, column, message: match[4] ?? "" });
  }
  return results;
}

/** GHDL ecoa o caminho EXATAMENTE como foi passado no argv de `ghdl -a` (ver
 * `GhdlBackend::compile`) -- normalmente já bate 1:1 com um dos `knownSources`. Fallback por
 * basename cobre o caso raro de GHDL normalizar/relativizar o caminho de um jeito que o match
 * direto não pega (ex: cwd diferente do processo `ghdl`). */
function resolveSourceUri(filePath: string, knownSources: string[]): vscode.Uri {
  const exact = knownSources.find((source) => path.resolve(source) === path.resolve(filePath));
  if (exact) return vscode.Uri.file(exact);
  const byBasename = knownSources.find((source) => path.basename(source) === path.basename(filePath));
  if (byBasename) return vscode.Uri.file(byBasename);
  return vscode.Uri.file(filePath);
}

let previouslyDiagnosedUris: vscode.Uri[] = [];

/** `compileLog === undefined` limpa todo diagnóstico VHDL anterior (analyze/compile teve sucesso
 * dessa vez). Chamado depois de toda tentativa de `analyzeFpga`/`runFpga` (sucesso ou falha) --
 * nunca deixa um erro de uma tentativa anterior "grudado" no painel depois que o usuário corrigiu o
 * VHDL e uma tentativa nova teve sucesso. */
export function reportVhdlDiagnostics(knownSources: string[], compileLog: string | undefined): void {
  const diagnostics = getDiagnosticsCollection();
  if (!diagnostics) return;

  for (const uri of previouslyDiagnosedUris) diagnostics.delete(uri);
  previouslyDiagnosedUris = [];

  if (!compileLog) return;

  const parsed = parseGhdlLog(compileLog);
  if (parsed.length === 0) {
    // GHDL falhou mas a saída não bateu com o formato "arquivo:linha:coluna" esperado (ex: erro de
    // processo/timeout, binário não encontrado -- não um erro de sintaxe) -- ainda assim não pode
    // desaparecer silenciosamente: ancora no primeiro source conhecido, linha 0, só pra aparecer no
    // painel de Problemas com o texto bruto.
    const fallbackSource = knownSources[0];
    if (!fallbackSource) return;
    const fallbackUri = vscode.Uri.file(fallbackSource);
    const diagnostic = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), compileLog.slice(0, 2000), vscode.DiagnosticSeverity.Error);
    diagnostic.source = "GHDL";
    diagnostics.set(fallbackUri, [diagnostic]);
    previouslyDiagnosedUris = [fallbackUri];
    return;
  }

  const byUriKey = new Map<string, { uri: vscode.Uri; list: vscode.Diagnostic[] }>();
  for (const entry of parsed) {
    const uri = resolveSourceUri(entry.filePath, knownSources);
    const key = uri.toString();
    const range = new vscode.Range(entry.line - 1, Math.max(0, entry.column - 1), entry.line - 1, Math.max(0, entry.column - 1) + 1);
    const diagnostic = new vscode.Diagnostic(range, entry.message, vscode.DiagnosticSeverity.Error);
    diagnostic.source = "GHDL";
    const bucket = byUriKey.get(key) ?? { uri, list: [] };
    bucket.list.push(diagnostic);
    byUriKey.set(key, bucket);
  }
  for (const { uri, list } of byUriKey.values()) {
    diagnostics.set(uri, list);
    previouslyDiagnosedUris.push(uri);
  }
}

export function clearVhdlDiagnostics(): void {
  reportVhdlDiagnostics([], undefined);
}
