import * as vscode from "vscode";

/** Log estruturado de simulação (canal de saída + painel de Problemas + status bar), inspirado no
 * log window do SimulIDE -- ANTES disto, falhas de Core/QEMU/firmware só apareciam (quando apareciam)
 * como um toast fugaz (`vscode.window.showWarningMessage`/`showErrorMessage`), sem histórico nenhum:
 * fechar a notificação = perder o motivo do erro pra sempre, e falhas silenciosas (bugs reais, ver
 * `reportCoreWarning`/`ensureAllMcuFirmwareUpToDate`) não deixavam rastro em lugar nenhum. Módulo
 * único (em vez de um `OutputChannel` por chamador) pra ter UM histórico cronológico central --
 * mistura mensagens de qualquer dispositivo/etapa, igual ao log window real do SimulIDE. */

export type SimLogLevel = "info" | "warning" | "error";

let channel: vscode.OutputChannel | undefined;
let diagnostics: vscode.DiagnosticCollection | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;

export function initSimulationLog(context: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel("LasecSimul: Simulação");
  diagnostics = vscode.languages.createDiagnosticCollection("lasecsimul");
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.name = "LasecSimul";
  statusBarItem.command = "lasecsimul.showSimulationLog";
  setStatusBarIdle();
  statusBarItem.show();
  context.subscriptions.push(channel, diagnostics, statusBarItem);
}

function levelTag(level: SimLogLevel): string {
  return level === "error" ? "ERRO" : level === "warning" ? "AVISO" : "INFO";
}

export interface SimLogOptions {
  /** Dispositivo/componente que gerou a mensagem (ex: label do MCU) -- omitido quando a mensagem não
   * é de um dispositivo específico (ex: processo Core como um todo). */
  device?: string;
  /** Etapa/ação que estava em andamento (ex: "carregar firmware de \"X\"", "iniciar simulação"). */
  stage: string;
  /** Detalhe técnico adicional (stack, código de erro, tail de log do QEMU) -- indentado, linha a
   * linha, abaixo da mensagem principal no canal de saída. */
  detail?: string;
  /** Mostra também como notificação nativa do VS Code. Default: true para "warning"/"error", false
   * para "info" (info só vai pro canal, senão toda leitura de estado geraria um toast). */
  notify?: boolean;
  /** Traz o canal de saída pra frente. Default: true só para "error" (mensagens críticas). */
  reveal?: boolean;
}

/** Registra uma linha no canal de saída (sempre) e, conforme o nível, também como notificação nativa
 * e atualização da status bar -- ponto único de entrada pra qualquer mensagem de diagnóstico da
 * simulação (Core, QEMU, firmware, ABI). */
export function logSimulation(level: SimLogLevel, message: string, options: SimLogOptions): void {
  const context = options.device ? `${options.stage}/${options.device}` : options.stage;
  const timestamp = new Date().toLocaleString();
  channel?.appendLine(`[${timestamp}] [${levelTag(level)}] [${context}] ${message}`);
  if (options.detail) {
    for (const detailLine of options.detail.split("\n")) channel?.appendLine(`    ${detailLine}`);
  }

  if (options.reveal ?? level === "error") channel?.show(true);

  const notify = options.notify ?? level !== "info";
  if (notify) {
    const fullMessage = `LasecSimul (${context}): ${message}`;
    if (level === "error") {
      void vscode.window.showErrorMessage(fullMessage, "Ver Log de Simulação").then((choice) => {
        if (choice) channel?.show(true);
      });
    } else if (level === "warning") {
      void vscode.window.showWarningMessage(fullMessage, "Ver Log de Simulação").then((choice) => {
        if (choice) channel?.show(true);
      });
    }
  }

  updateStatusBar(level, context, message);
}

function updateStatusBar(level: SimLogLevel, context: string, message: string): void {
  if (!statusBarItem) return;
  if (level === "error") {
    statusBarItem.text = "$(error) LasecSimul: erro";
    statusBarItem.tooltip = `${context}: ${message}`;
    statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
  } else if (level === "warning") {
    statusBarItem.text = "$(warning) LasecSimul: aviso";
    statusBarItem.tooltip = `${context}: ${message}`;
    statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  }
}

function setStatusBarIdle(): void {
  if (!statusBarItem) return;
  statusBarItem.text = "$(circuit-board) LasecSimul";
  statusBarItem.tooltip = "LasecSimul: nenhum erro/aviso pendente -- clique para ver o log de simulação";
  statusBarItem.backgroundColor = undefined;
}

/** Chamado a cada transição de status (`stopped`/`running`/`paused`) que representa uma AÇÃO
 * bem-sucedida do usuário (Run/Pause/Stop) -- limpa qualquer erro/aviso destacado na status bar
 * anterior, senão um erro de uma corrida antiga ficaria "grudado" ali para sempre mesmo depois de uma
 * corrida seguinte bem-sucedida. */
export function noteSimulationStatusChange(status: "stopped" | "running" | "paused"): void {
  if (!statusBarItem) return;
  setStatusBarIdle();
  if (status === "running") statusBarItem.text = "$(debug-start) LasecSimul: rodando";
  else if (status === "paused") statusBarItem.text = "$(debug-pause) LasecSimul: pausado";
}

export function showSimulationLogChannel(): void {
  channel?.show();
}

/** Marca um diagnóstico no painel de Problemas, ancorado no arquivo do projeto atual (quando
 * conhecido) -- best-effort: sem um arquivo salvo pra apontar, a mensagem já foi pro canal de saída
 * e pro toast, então simplesmente não há onde ancorar o ícone de erro (não é uma falha por si só). */
export function reportFirmwareDiagnostic(filePath: string | undefined, key: string, message: string | undefined): void {
  if (!diagnostics || !filePath) return;
  const uri = vscode.Uri.file(filePath);
  const kept = (diagnostics.get(uri) ?? []).filter((d) => d.code !== key);
  if (!message) {
    diagnostics.set(uri, kept);
    return;
  }
  const diagnostic = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), message, vscode.DiagnosticSeverity.Error);
  diagnostic.source = "LasecSimul";
  diagnostic.code = key;
  diagnostics.set(uri, [...kept, diagnostic]);
}
