import * as fs from "fs";
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
  private lastRenderedScriptMtimeMs: number | undefined;

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private initialState: WebviewProjectState,
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
      existing.initialState = initialState;
      // Achado real (2026-07-18): `reveal()` sozinho NUNCA recarrega `webview.html` -- com
      // `retainContextWhenHidden`, o painel mantém o MESMO contexto JS carregado desde a primeira
      // vez que foi criado nesta sessão do VS Code. Se o usuário recompila `out-webview/main.js` e
      // volta a abrir o esquemático sem antes fechar a aba, o script antigo continua rodando
      // indefinidamente -- sintoma relatado como "minhas mudanças não aparecem depois de F5".
      // Comparamos o mtime do script contra o que foi carregado da última vez: só forçamos
      // `render()` (recarrega a Webview do zero, com nonce novo) quando o arquivo em disco
      // realmente mudou -- do contrário o uso normal (trocar de aba e voltar) mantém o contexto
      // (histórico de undo, seleção, zoom) intacto, sem recarregar a cada reveal.
      const currentMtime = existing.currentScriptMtimeMs();
      if (currentMtime !== undefined && currentMtime !== existing.lastRenderedScriptMtimeMs) {
        // `render()` troca `webview.html`, destruindo o contexto JS anterior -- o handshake antigo
        // ("webviewReady") morreu junto com ele. Sem resetar `ready`, o `postMessage` abaixo seria
        // despachado direto (achando a Webview ainda pronta) e se perderia, enviado antes do
        // listener da Webview NOVA existir; `pendingMessages` garante que ele espera o handshake novo.
        existing.ready = false;
        existing.render();
      }
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

  private currentScriptMtimeMs(): number | undefined {
    try {
      const scriptPath = vscode.Uri.joinPath(this.extensionUri, "out-webview", "main.js");
      return fs.statSync(scriptPath.fsPath).mtimeMs;
    } catch {
      return undefined;
    }
  }

  /** URI do recurso local + query string de cache-busting (`?v=<mtime ou timestamp>`). Achado real
   * (2026-07-18): `webview.asWebviewUri` devolve sempre a MESMA URL `vscode-webview-resource://...`
   * pro mesmo caminho de arquivo -- o cache HTTP do Chromium embutido na Webview (persistente em
   * disco entre janelas do Extension Development Host, não só dentro da mesma sessão) pode servir o
   * `main.js`/`styles.css` ANTIGO pra essa URL mesmo depois de recompilar e depois de um F5 completo
   * (processo novo, `SchematicPanel.current` novo, `render()` chamado do zero) -- o `nonce` no CSP
   * não afeta isso, ele só autoriza QUAL script roda, não força buscar de novo QUAL versão. Anexar
   * `?v=` muda a URL em si, então o cache nunca serve uma resposta antiga pra ela. */
  private cacheBustedUri(webview: vscode.Webview, fileUri: vscode.Uri, fallbackVersion: string): string {
    let version = fallbackVersion;
    try {
      version = String(fs.statSync(fileUri.fsPath).mtimeMs);
    } catch {
      // Mantém o fallback -- arquivo pode estar sendo escrito no exato instante do stat.
    }
    return `${webview.asWebviewUri(fileUri)}?v=${version}`;
  }

  private render(): void {
    const webview = this.panel.webview;
    const scriptPath = vscode.Uri.joinPath(this.extensionUri, "out-webview", "main.js");
    const stylePath = vscode.Uri.joinPath(this.extensionUri, "src", "ui", "webview", "styles.css");

    const nonce = String(Date.now());
    const initialStateJson = JSON.stringify(this.initialState);
    const locale = this.initialState.locale ?? "pt-BR";
    const scriptUri = this.cacheBustedUri(webview, scriptPath, nonce);
    const styleUri = this.cacheBustedUri(webview, stylePath, nonce);

    webview.html = `
      <!doctype html>
      <html lang="${locale}">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}';" />
          <title>${localizedPanelTitle(locale)}</title>
          <link rel="stylesheet" href="${styleUri}" />
        </head>
        <body>
          <main id="app"></main>
          <script nonce="${nonce}">window.__LASECSIMUL_INITIAL_STATE__ = ${initialStateJson};</script>
          <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
        </body>
      </html>
    `;
    this.lastRenderedScriptMtimeMs = this.currentScriptMtimeMs();
  }
}
