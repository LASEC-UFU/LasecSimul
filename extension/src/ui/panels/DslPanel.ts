import * as vscode from "vscode";

type DslMessage =
  | { type: "sourceChanged"; source: string }
  | { type: "apply" };

/** One in-app textual editing surface for the circuit DSL.  It intentionally
 * owns the editor column while active: a circuit cannot have competing block
 * and DSL drafts, nor can the DSL command create a second untitled document. */
export class DslPanel {
  static current: DslPanel | undefined;
  private returnToBlocksOnClose = true;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    public source: string,
    private readonly onApply: () => void,
    private readonly onClose: () => void,
  ) {
    panel.onDidDispose(() => {
      if (DslPanel.current === this) DslPanel.current = undefined;
      if (this.returnToBlocksOnClose) this.onClose();
    });
    panel.webview.onDidReceiveMessage((message: DslMessage) => {
      if (message.type === "sourceChanged") {
        this.source = message.source;
      } else if (message.type === "apply") {
        this.onApply();
      }
    });
  }

  static createOrShow(extensionUri: vscode.Uri, source: string, onApply: () => void, onClose: () => void): DslPanel {
    if (DslPanel.current) {
      DslPanel.current.panel.reveal(vscode.ViewColumn.One);
      return DslPanel.current;
    }
    const panel = vscode.window.createWebviewPanel("lasecsimul.dsl", "LasecSimul - DSL", vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [extensionUri],
    });
    const result = new DslPanel(panel, source, onApply, onClose);
    DslPanel.current = result;
    result.render();
    return result;
  }

  dispose(returnToBlocks = true): void {
    this.returnToBlocksOnClose = returnToBlocks;
    this.panel.dispose();
  }

  private render(): void {
    const nonce = String(Date.now());
    const initialSource = JSON.stringify(this.source).replace(/</g, "\\u003c");
    this.panel.webview.html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root { color-scheme: dark; } body { margin: 0; font-family: var(--vscode-editor-font-family); background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
  .toolbar { height: 42px; display:flex; align-items:center; gap:8px; padding:0 12px; border-bottom:1px solid var(--vscode-panel-border); background:var(--vscode-editorWidget-background); }
  .toolbar button { display:inline-flex; align-items:center; gap:7px; min-height:28px; padding:0 12px; border:1px solid var(--vscode-button-border, transparent); border-radius:3px; color:var(--vscode-button-foreground); background:var(--vscode-button-background); cursor:pointer; font:inherit; }
  .toolbar button:hover { background:var(--vscode-button-hoverBackground); } .toolbar .hint { opacity:.75; font-size:12px; }
  textarea { box-sizing:border-box; display:block; width:100%; height:calc(100vh - 43px); resize:none; border:0; outline:0; padding:14px 18px; background:var(--vscode-editor-background); color:var(--vscode-editor-foreground); font:14px/1.55 var(--vscode-editor-font-family); tab-size:2; }
</style></head><body><header class="toolbar"><button id="to-block" title="Aplicar DSL e voltar ao diagrama de blocos">▣&nbsp; Block</button><span class="hint">DSL → Block</span></header><textarea id="source" aria-label="LasecSimul DSL" spellcheck="false"></textarea><script nonce="${nonce}">const vscode=acquireVsCodeApi(); const source=document.getElementById('source'); source.value=${initialSource}; source.addEventListener('input',()=>vscode.postMessage({type:'sourceChanged',source:source.value})); document.getElementById('to-block').addEventListener('click',()=>{vscode.postMessage({type:'sourceChanged',source:source.value});vscode.postMessage({type:'apply'});}); source.focus();</script></body></html>`;
  }
}
