import * as fs from "fs";
import * as vscode from "vscode";
import type { CalculusLab, LabActivity } from "../webview/lab/activity";
import { LAB_MESSAGE_VERSION, type HostToLabMessage, type LabMode, type LabToHostMessage } from "../webview/lab/messages";

/** O que o painel precisa do resto da extensão (projeto aberto, gravação, séries do Core). */
export interface CalculusLabHost {
  /** Definição corrente do projeto (ou a atividade padrão quando o projeto ainda não tem laboratório). */
  getLab(): CalculusLab;
  /** Professor gravou uma atividade: atualizar o projeto e o indicador de alteração. */
  saveActivity(activity: LabActivity): void;
  projectName(): string | undefined;
  locale(): string;
  /** Mensagens que o painel não trata sozinho (execução, parâmetros, séries). */
  onMessage?(message: LabToHostMessage): void;
  /** Painel fechado: desligar experimentos e assinaturas no Core. */
  dispose?(): void;
}

/**
 * Painel próprio do Laboratório de Cálculo (docs/51 §1: não cresce o `main.ts` do esquemático). A Webview
 * é ESM local compilado em `out-webview/lab/ui/main.js`, sem CDN e sem `eval` (CSP abaixo).
 */
export class CalculusLabPanel {
  static current: CalculusLabPanel | undefined;

  private mode: LabMode = "student";
  private activeId: string | undefined;
  private lastSentLab: CalculusLab | undefined;
  private ready = false;

  static show(extensionUri: vscode.Uri, host: CalculusLabHost): CalculusLabPanel {
    if (CalculusLabPanel.current) {
      CalculusLabPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return CalculusLabPanel.current;
    }
    const panel = vscode.window.createWebviewPanel("lasecsimul.calculusLab", "Laboratório de Cálculo", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "out-webview"), vscode.Uri.joinPath(extensionUri, "src", "ui", "webview", "lab")],
    });
    CalculusLabPanel.current = new CalculusLabPanel(panel, extensionUri, host);
    return CalculusLabPanel.current;
  }

  private constructor(readonly panel: vscode.WebviewPanel, private readonly extensionUri: vscode.Uri, private readonly host: CalculusLabHost) {
    panel.webview.onDidReceiveMessage((message: LabToHostMessage) => this.receive(message));
    panel.onDidDispose(() => {
      if (CalculusLabPanel.current === this) CalculusLabPanel.current = undefined;
      this.host.dispose?.();
    });
    this.render();
  }

  post(message: HostToLabMessage): void {
    void this.panel.webview.postMessage(message);
  }

  /** Chamado depois de mutações do projeto: reenvia a definição só se ela mudou (comparação por referência). */
  syncFromProject(): void {
    if (!this.ready) return;
    const lab = this.host.getLab();
    if (lab === this.lastSentLab) return;
    this.sendInit(lab);
  }

  private receive(message: LabToHostMessage): void {
    if (!message || message.version !== LAB_MESSAGE_VERSION) return;
    switch (message.type) {
      case "labReady":
        this.ready = true;
        this.sendInit(this.host.getLab());
        return;
      case "labSetMode":
        this.mode = message.mode;
        return;
      case "labSaveActivity":
        this.activeId = message.activity.id;
        this.host.saveActivity(message.activity);
        this.lastSentLab = this.host.getLab(); // a Webview já mostra o que acabou de gravar
        this.post({ version: LAB_MESSAGE_VERSION, type: "labSaved", activityId: message.activity.id });
        return;
      default:
        this.host.onMessage?.(message);
    }
  }

  private sendInit(lab: CalculusLab): void {
    this.lastSentLab = lab;
    const activeId = lab.activities.some((a) => a.id === this.activeId) ? this.activeId as string : lab.activities[0]?.id ?? "";
    this.post({ version: LAB_MESSAGE_VERSION, type: "labInit", locale: this.host.locale(), lab, mode: this.mode, activeId, projectName: this.host.projectName() });
  }

  private resourceUri(...segments: string[]): string {
    const file = vscode.Uri.joinPath(this.extensionUri, ...segments);
    let version = String(Date.now());
    try { version = String(fs.statSync(file.fsPath).mtimeMs); } catch { /* arquivo sendo escrito: usa o relógio */ }
    return `${this.panel.webview.asWebviewUri(file)}?v=${version}`;
  }

  private render(): void {
    const webview = this.panel.webview;
    const nonce = `${Date.now()}${Math.random().toString(36).slice(2)}`;
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src ${webview.cspSource} 'nonce-${nonce}'`,
    ].join("; ");
    webview.html = `<!doctype html>
<html lang="${this.host.locale()}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <title>Laboratório de Cálculo</title>
    <link rel="stylesheet" href="${this.resourceUri("src", "ui", "webview", "lab", "ui", "lab.css")}" />
  </head>
  <body>
    <div id="lab" aria-live="off"></div>
    <script type="module" nonce="${nonce}" src="${this.resourceUri("out-webview", "lab", "ui", "main.js")}"></script>
  </body>
</html>`;
  }
}
