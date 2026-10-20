import * as fs from "fs";
import * as vscode from "vscode";
import { WebviewProjectState } from "../webview/model";
import { WEBVIEW_MESSAGE_VERSION, WebviewToHostMessage } from "../webview/messages";
import { schematicBundleHtml, schematicBundleLocalResourceRoots } from "./schematicBundleHtml";

function localizedPanelTitle(language: "pt-BR" | "en"): string {
  return language === "en" ? "LasecSimul - Schematic" : "LasecSimul - Esquemático";
}

export class SchematicPanel {
  public static current: SchematicPanel | undefined;
  /** O esquemático virou a superfície ativa (a paleta lateral passa a colocar nele, docs/61 §8). */
  public static onDidBecomeActive: (() => void) | undefined;

  private readonly panel: vscode.WebviewPanel;
  private ready = false;
  private readonly pendingMessages: unknown[] = [];
  private language: "pt-BR" | "en" = "pt-BR";
  private dirty = false;
  private lastRenderedScriptMtimeMs: number | undefined;
  private renderNonce = "";

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
    this.panel.onDidChangeViewState(() => {
      if (this.panel.active) SchematicPanel.onDidBecomeActive?.();
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
        localResourceRoots: schematicBundleLocalResourceRoots(extensionUri),
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

  pidDialogWebviewContext(): { cspSource: string; nonce: string; asWebviewUri(uri: vscode.Uri): string } {
    return { cspSource: this.panel.webview.cspSource, nonce: this.renderNonce,
      asWebviewUri: (uri) => this.panel.webview.asWebviewUri(uri).toString() };
  }

  showPidDialog(componentId: string, html: string): void {
    void this.postMessage({ version: WEBVIEW_MESSAGE_VERSION, type: "pidDialogOpen", componentId, html });
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

  /** Switches the single authoring surface to the DSL panel. */
  dispose(): void { this.panel.dispose(); }

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

  private render(): void {
    const nonce = String(Date.now());
    this.renderNonce = nonce;
    this.panel.webview.html = schematicBundleHtml({
      webview: this.panel.webview,
      extensionUri: this.extensionUri,
      initialState: this.initialState,
      title: localizedPanelTitle(this.initialState.locale ?? "pt-BR"),
      nonce,
    });
    this.lastRenderedScriptMtimeMs = this.currentScriptMtimeMs();
  }
}
