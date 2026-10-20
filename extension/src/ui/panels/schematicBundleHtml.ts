import * as fs from "fs";
import * as vscode from "vscode";
import type { WebviewProjectState } from "../webview/model";
import type { VisualSession, VisualWindowInfo } from "../webview/visualDocument";

/** Papel da Webview do motor de cena quando ela é um Painel Visual (Tela HMI), não o esquemático. */
export interface VisualRoleConfig {
  documentId: string;
  title: string;
  /** Nonce desta página para os scripts inline das atividades do Laboratório embutidas. */
  labEmbed?: { nonce: string };
  /** Faceplate de um subsistema aberto no contexto de uma instância (docs/62 §8). */
  faceplate?: { instanceId: string; instanceLabel: string };
  /** Sessão, janela e histórico já na 1ª pintura: o `visualState` do Host chega segundos depois
   * quando o host de extensões está ocupado, e o menu de contexto não pode nascer errado. */
  session?: VisualSession;
  window?: VisualWindowInfo;
  history?: { canUndo: boolean; canRedo: boolean };
}

/** URI do recurso local + `?v=<mtime>`: o cache HTTP do Chromium da Webview pode servir o `main.js`
 * antigo para a MESMA URL mesmo depois de recompilar (achado de 2026-07-18, ver `SchematicPanel`). */
export function cacheBustedUri(webview: vscode.Webview, fileUri: vscode.Uri, fallbackVersion: string): string {
  let version = fallbackVersion;
  try {
    version = String(fs.statSync(fileUri.fsPath).mtimeMs);
  } catch {
    // Mantém o fallback -- arquivo pode estar sendo escrito no exato instante do stat.
  }
  return `${webview.asWebviewUri(fileUri)}?v=${version}`;
}

export function schematicBundleLocalResourceRoots(extensionUri: vscode.Uri): vscode.Uri[] {
  return [
    vscode.Uri.joinPath(extensionUri, "src", "ui", "webview"),
    vscode.Uri.joinPath(extensionUri, "out-webview"),
    vscode.Uri.joinPath(extensionUri, "media", "pid"),
    vscode.Uri.joinPath(extensionUri, "media", "lab"),
  ];
}

/**
 * HTML do motor de cena (`out-webview/main.js`). O esquemático e os Painéis Visuais carregam O MESMO
 * bundle (um motor de edição, docs/62 §2); o Painel Visual só acrescenta `__LASECSIMUL_VISUAL_ROLE__`.
 * O estado inicial embutido é só o primeiro quadro: toda Webview pede o estado ao Host no
 * `webviewReady`, inclusive quando o VS Code a recria ao trocar de janela (docs/61 §6.2).
 */
export function schematicBundleHtml(options: {
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
  initialState: WebviewProjectState;
  title: string;
  nonce: string;
  visualRole?: VisualRoleConfig;
}): string {
  const { webview, extensionUri, initialState, title, nonce, visualRole } = options;
  const scriptPath = vscode.Uri.joinPath(extensionUri, "out-webview", "main.js");
  const stylePath = vscode.Uri.joinPath(extensionUri, "src", "ui", "webview", "styles.css");
  const locale = initialState.locale ?? "pt-BR";
  const scriptUri = cacheBustedUri(webview, scriptPath, nonce);
  const styleUri = cacheBustedUri(webview, stylePath, nonce);
  const escapeHtml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // `</script>` dentro do JSON fecharia a tag: o estado é serializado com `<` escapado.
  const json = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c");
  return `
      <!doctype html>
      <html lang="${locale}">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src ${webview.cspSource} 'nonce-${nonce}'; frame-src ${webview.cspSource} about:;" />
          <title>${escapeHtml(title)}</title>
          <link rel="stylesheet" href="${styleUri}" />
        </head>
        <body${visualRole ? ' class="visual-role"' : ""}>
          <main id="app"></main>
          <script nonce="${nonce}">window.__LASECSIMUL_INITIAL_STATE__ = ${json(initialState)};${visualRole ? ` window.__LASECSIMUL_VISUAL_ROLE__ = ${json(visualRole)};` : ""}</script>
          <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
        </body>
      </html>
    `;
}
