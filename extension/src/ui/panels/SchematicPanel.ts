import * as vscode from "vscode";
import { WebviewProjectState } from "../webview/model";
import { WEBVIEW_MESSAGE_VERSION, WebviewToHostMessage } from "../webview/messages";

function localizedPanelTitle(language: "pt-BR" | "en"): string {
  return language === "en" ? "LasecSimul - Schematic" : "LasecSimul - Esquemático";
}

export class SchematicPanel {
  public static current: SchematicPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private ready = false;
  private readonly pendingMessages: unknown[] = [];
  private language: "pt-BR" | "en" = "pt-BR";
  private dirty = false;

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly initialState: WebviewProjectState,
    private readonly onMessage: (message: WebviewToHostMessage) => void,
    private readonly onDispose: () => void,
  ) {
    this.panel = panel;
    this.language = initialState.locale ?? "pt-BR";
    this.panel.onDidDispose(() => {
      SchematicPanel.current = undefined;
      this.onDispose();
    });
    this.panel.webview.onDidReceiveMessage((message: WebviewToHostMessage) => {
      if (message.type === "webviewReady") {
        this.ready = true;
        this.flushPendingMessages();
        return;
      }
      this.onMessage(message);
    });
  }

  static createOrShow(
    extensionUri: vscode.Uri,
    initialState: WebviewProjectState,
    onMessage: (message: WebviewToHostMessage) => void,
    onDispose: () => void,
  ): SchematicPanel {
    const existing = SchematicPanel.current;
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.One);
      existing.setLanguage(initialState.locale ?? "pt-BR");
      existing.postMessage({ version: WEBVIEW_MESSAGE_VERSION, type: "syncState", project: initialState });
      return existing;
    }

    const panel = vscode.window.createWebviewPanel(
      "lasecsimul.schematic",
      localizedPanelTitle(initialState.locale ?? "pt-BR"),
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, "src", "ui", "webview"),
          vscode.Uri.joinPath(extensionUri, "out-webview"),
        ],
      }
    );

    SchematicPanel.current = new SchematicPanel(panel, extensionUri, initialState, onMessage, onDispose);
    SchematicPanel.current.render();
    return SchematicPanel.current;
  }

  postMessage(message: unknown): Thenable<boolean> {
    if (!this.ready) {
      this.pendingMessages.push(message);
      return Promise.resolve(true);
    }
    return this.panel.webview.postMessage(message);
  }

  setLanguage(language: "pt-BR" | "en"): void {
    this.language = language;
    this.applyTitle();
  }

  /** Indicador de alteração não salva no título da aba (`"Schematic"` -> `"Schematic ●"`) --
   * substituto de baixo custo pro diálogo nativo "unsaved changes" que `vscode.WebviewPanel` NÃO
   * suporta (diferente de `CustomEditorProvider`, que integraria com o prompt nativo do VS Code
   * via `onDidChangeCustomDocument`/backup -- migrar pra essa API é uma mudança de arquitetura bem
   * maior, fora de escopo aqui). Ver `projectCommands.ts::isProjectDirty`. */
  setDirty(dirty: boolean): void {
    if (this.dirty === dirty) return;
    this.dirty = dirty;
    this.applyTitle();
  }

  private applyTitle(): void {
    const base = localizedPanelTitle(this.language);
    this.panel.title = this.dirty ? `${base} ●` : base;
  }

  private flushPendingMessages(): void {
    while (this.pendingMessages.length > 0) {
      const next = this.pendingMessages.shift();
      if (next !== undefined) {
        void this.panel.webview.postMessage(next);
      }
    }
  }

  private render(): void {
    const webview = this.panel.webview;
    const scriptPath = vscode.Uri.joinPath(this.extensionUri, "out-webview", "main.js");
    const stylePath = vscode.Uri.joinPath(this.extensionUri, "src", "ui", "webview", "styles.css");

    const nonce = String(Date.now());
    const initialStateJson = JSON.stringify(this.initialState);
    const locale = this.initialState.locale ?? "pt-BR";

    webview.html = `
      <!doctype html>
      <html lang="${locale}">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}';" />
          <title>${localizedPanelTitle(locale)}</title>
          <link rel="stylesheet" href="${webview.asWebviewUri(stylePath)}" />
        </head>
        <body>
          <main id="app"></main>
          <script nonce="${nonce}">window.__LASECSIMUL_INITIAL_STATE__ = ${initialStateJson};</script>
          <script type="module" nonce="${nonce}" src="${webview.asWebviewUri(scriptPath)}"></script>
        </body>
      </html>
    `;
  }
}
