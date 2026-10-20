import * as vscode from "vscode";
import type { WebviewProjectState } from "../webview/model";
import type { WebviewToHostMessage } from "../webview/messages";
import type { VisualSession, VisualWindowInfo, WebviewGeometry } from "../webview/visualDocument";
import { schematicBundleHtml, schematicBundleLocalResourceRoots } from "./schematicBundleHtml";

export const VISUAL_PANEL_VIEW_TYPE = "lasecsimul.visual";

export function visualPanelKey(documentId: string, instanceId?: string): string {
  return instanceId ? `${documentId}@${instanceId}` : documentId;
}

/** O que o Painel Visual pede ao Host (docs/62 §3.6). */
export interface VisualPanelHost {
  /** Estado inicial da Webview (projeto raiz + a tela no lugar de `hmiApplication`). */
  initialState(panel: VisualPanel): WebviewProjectState | undefined;
  /** A Webview (re)nasceu: o Host manda `init`, sessão e janela. Vale também para a recriação feita
   * pelo VS Code ao mover o painel entre janelas (docs/61 §6.2). */
  ready(panel: VisualPanel): void;
  /** Janela e histórico desta vista, embutidos no HTML para a 1ª pintura. */
  roleState(panel: VisualPanel): {
    window: VisualWindowInfo;
    history: { canUndo: boolean; canRedo: boolean };
    /** Faceplate aberto no contexto de uma instância do subsistema. */
    faceplate?: { instanceId: string; instanceLabel: string };
  };
  message(panel: VisualPanel, message: WebviewToHostMessage): void;
  viewStateChanged(panel: VisualPanel): void;
  disposed(panel: VisualPanel): void;
}

/**
 * Uma vista de uma Tela HMI: `WebviewPanel` (`lasecsimul.visual`) com o MESMO bundle do esquemático
 * no papel `visual`. Pode ficar acoplada à área de editores ou numa janela auxiliar do VS Code
 * (ADR 0016). Nada que precise sobreviver a uma troca de janela mora aqui sem cópia no Host.
 */
export class VisualPanel {
  readonly panel: vscode.WebviewPanel;
  ready = false;
  private readonly pending: unknown[] = [];
  session: VisualSession;
  geometry: WebviewGeometry | undefined;
  window: VisualWindowInfo = { docking: "docked", window: "normal", canUndock: false, canFullscreen: false };
  /** Tela cheia pedida com a vista acoplada: ao sair, volta a acoplar (docs/61 §7.1). */
  dockAfterFullscreen = false;
  /** Contexto antes da tela cheia, restaurado ao sair (política `fullscreenContext`). */
  contextBeforeFullscreen: VisualSession["context"] | undefined;
  /** Última coluna da área de editores em que a vista esteve acoplada (Dock volta para ela). */
  dockedColumn: vscode.ViewColumn | undefined;
  /** Contagem de `webviewReady` (cada troca de janela recria a Webview). */
  boots = 0;
  /** Telemetria do projeto vista por ESTA vista (Faceplate de instância: só a da instância, com os ids
   * dos componentes internos). Devolve as mensagens a entregar; ausente = entrega como veio. */
  runtimeTransform: ((message: unknown) => unknown[]) | undefined;
  private disposed = false;

  constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    readonly documentId: string,
    session: VisualSession,
    private readonly host: VisualPanelHost,
    /** Faceplate (docs/62 §8): a instância do subsistema em cujo contexto o documento da definição abre. */
    readonly instanceId?: string,
  ) {
    this.panel = panel;
    this.session = session;
    this.dockedColumn = panel.viewColumn;
    panel.webview.options = { enableScripts: true, localResourceRoots: schematicBundleLocalResourceRoots(extensionUri) };
    panel.webview.onDidReceiveMessage((message: WebviewToHostMessage) => {
      if (message?.type === "webviewReady") {
        this.ready = true;
        this.boots += 1;
        this.host.ready(this);
        this.flush();
        return;
      }
      this.host.message(this, message);
    });
    panel.onDidChangeViewState(() => this.host.viewStateChanged(this));
    panel.onDidDispose(() => {
      this.disposed = true;
      this.ready = false;
      this.host.disposed(this);
    });
    this.render();
  }

  static create(
    extensionUri: vscode.Uri, documentId: string, title: string, column: vscode.ViewColumn, session: VisualSession, host: VisualPanelHost, instanceId?: string,
  ): VisualPanel {
    const panel = vscode.window.createWebviewPanel(VISUAL_PANEL_VIEW_TYPE, title, { viewColumn: column, preserveFocus: false }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: schematicBundleLocalResourceRoots(extensionUri),
    });
    panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "activity-icon.svg");
    return new VisualPanel(panel, extensionUri, documentId, session, host, instanceId);
  }

  /** Uma vista por tela; um Faceplate abre uma vista por instância. */
  get key(): string { return visualPanelKey(this.documentId, this.instanceId); }

  get isDisposed(): boolean { return this.disposed; }

  setTitle(title: string): void {
    if (!this.disposed && this.panel.title !== title) this.panel.title = title;
  }

  /** Mensagens antes do `webviewReady` esperam; depois vão direto. Uma Webview recriada pelo VS Code
   * recebe tudo de novo pelo `init` do Host, então perder um quadro de telemetria nesse intervalo não
   * deixa nada inconsistente. */
  postMessage(message: unknown): void {
    if (this.disposed) return;
    if (!this.ready) {
      this.pending.push(message);
      if (this.pending.length > 200) this.pending.splice(0, this.pending.length - 200);
      return;
    }
    void this.panel.webview.postMessage(message);
  }

  /** Mensagem do tique de telemetria: sem fila (o próximo tique substitui a anterior). */
  postRuntime(message: unknown): void {
    if (this.disposed || !this.ready) return;
    for (const delivered of this.runtimeTransform ? this.runtimeTransform(message) : [message]) void this.panel.webview.postMessage(delivered);
  }

  private flush(): void {
    const queued = this.pending.splice(0);
    for (const message of queued) void this.panel.webview.postMessage(message);
  }

  render(): void {
    const state = this.host.initialState(this);
    if (!state) return;
    const webview = this.panel.webview;
    const nonce = `${Date.now()}${Math.random().toString(36).slice(2)}`;
    // Atividades do Laboratório (`graphics.math.activity`) rodam num `<iframe>` desta Webview com o
    // código inline (`labEmbeds.ts::labEmbedBundle`) e o MESMO nonce (o `<iframe>` herda a CSP).
    const labEmbed = { nonce };
    webview.html = schematicBundleHtml({
      webview,
      extensionUri: this.extensionUri,
      initialState: state,
      title: this.panel.title,
      nonce,
      visualRole: { documentId: this.documentId, title: this.panel.title, labEmbed, session: this.session, ...this.host.roleState(this) },
    });
  }

  dispose(): void {
    if (!this.disposed) this.panel.dispose();
  }
}
