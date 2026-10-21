import * as fs from "fs";
import * as vscode from "vscode";
import { showInAuxiliaryWindow } from "./standaloneWebview";

/** Janela independente de sintonia PID; os dados continuam ligados ao componente/Core. */
export class PidTuningPanel {
  private static current: vscode.WebviewPanel | undefined;
  private static componentId: string | undefined;
  private static onPropertyChange: ((name: string, value: string | number | boolean) => void) | undefined;
  private static onClose: (() => void) | undefined;
  private static lastSampleNs: number | undefined;
  private static lastValues = new Map<string, { sp?: number; pv?: number; mv?: number; manual?: boolean; localMode?: boolean }>();

  static open(extensionUri: vscode.Uri, componentId: string, tag = "Controller", onChange: (name: string, value: string | number | boolean) => void, onClose?: () => void): void {
    if (this.current && this.componentId === componentId) {
      this.onPropertyChange = onChange;
      this.onClose = onClose;
      this.current.reveal(vscode.ViewColumn.Active);
      return;
    }
    if (this.current) {
      // Switching controller already attached its new feed in the command handler.
      // Suppress the closing panel callback so it cannot detach that replacement feed.
      this.onClose = undefined;
      this.current.dispose();
    }
    this.componentId = componentId;
    this.onPropertyChange = onChange;
    this.onClose = onClose;
    this.lastSampleNs = undefined;

    const panel = vscode.window.createWebviewPanel("lasecsimul.pidTuning", `Sintonia FOPDT — ${tag}`,
      vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    this.current = panel;
    panel.onDidDispose(() => {
      if (this.current !== panel) return;
      this.current = undefined;
      this.componentId = undefined;
      this.onPropertyChange = undefined;
      const close = this.onClose;
      this.onClose = undefined;
      close?.();
    });
    panel.webview.onDidReceiveMessage((message: { type?: string; name?: string; value?: unknown }) => {
      if (message?.type !== "pidPropertyChanged" || typeof message.name !== "string") return;
      if (typeof message.value !== "boolean" && (typeof message.value !== "number" || !Number.isFinite(message.value))) return;
      this.handlePropertyChange({ componentId, name: message.name, value: message.value });
    });

    const root = vscode.Uri.joinPath(extensionUri, "media", "pid");
    const plotUri = vscode.Uri.joinPath(root, "miniplot.js");
    const plotSrc = panel.webview.asWebviewUri(plotUri).toString();
    const nonce = String(Date.now());
    let html = fs.readFileSync(vscode.Uri.joinPath(root, "pid_dialog.html").fsPath, "utf8");
    html = html.replace(/<%@[^%]*%>/g, "");
    html = html.replace(/Sintonia PID/g, "Sintonia FOPDT");
    html = html.replace(/<c:out\s+value=['"][^'"]*['"]\s*\/>/g, "");
    html = html.replace(/const ctxPath =\s*"\s*";/, 'const ctxPath = "";');
    html = html.replace('const local = ctxPath + "/resources/miniplot.js";', `const local = "${plotSrc}";`)
      .replace("loadScript(local)", "(window.Plotly ? Promise.resolve() : loadScript(local))");
    const miniplot = fs.readFileSync(plotUri.fsPath, "utf8").replace(/<\/script/gi, "<\\/script");
    html = html.replace(/<script(?![^>]*\bnonce=)/g, `<script nonce="${nonce}"`);
    html = html.replace(/(let TITLE = )"Controller";/, `$1${JSON.stringify(tag)};`);
    const bridge = `<script nonce="${nonce}">window.PID_COMPONENT_ID=${JSON.stringify(componentId)};const vscode=acquireVsCodeApi();</script>`;
    const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${panel.webview.cspSource} data:; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src ${panel.webview.cspSource} 'nonce-${nonce}';">`;
    const fitLayout = `<style nonce="${nonce}">html,body{width:100%;height:100%;overflow:hidden}body{align-items:stretch!important;justify-content:stretch!important;padding:0!important;min-height:0!important}.controller-body{width:100%;height:100%;min-height:0;grid-template-columns:minmax(240px,.6fr) minmax(0,2.4fr);align-items:stretch}.controller-display,.controller-graph{min-height:0}.controller-display{overflow:auto}.controller-graph{min-width:0}#plotBox{min-height:0}@media(max-width:850px){.controller-body{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr)}.controller-display{max-height:42vh}}</style>`;
    html = html.replace("<head>", () => `<head>${policy}${fitLayout}${bridge}<script nonce="${nonce}">${miniplot}</script>`);
    panel.webview.html = html;
    void showInAuxiliaryWindow(panel);
    const sample = this.latestSample(componentId);
    if (sample) void panel.webview.postMessage({ type: "pidSnapshot", values: sample, dt: 0 });
  }

  static handlePropertyChange(message: { componentId: string; name: string; value: string | number | boolean }): void {
    if (!this.current || this.componentId !== message.componentId) return;
    const writable = new Set(["kc", "ti", "td", "bias", "outputMin", "outputMax", "manual", "manualOutput", "localMode", "localSetpoint", "remoteSetpoint"]);
    if (!writable.has(message.name) || (typeof message.value !== "boolean" && (typeof message.value !== "number" || !Number.isFinite(message.value)))) return;
    this.onPropertyChange?.(message.name, message.value);
  }

  static close(): void {
    this.current = undefined;
    this.componentId = undefined;
    this.onPropertyChange = undefined;
    this.onClose = undefined;
  }

  static updateSample(componentId: string, values: { sp?: number; pv?: number; mv?: number; manual?: boolean; localMode?: boolean; setpointSourceId?: string }, sampleTimestampNs: number): void {
    this.lastValues.set(componentId, values);
    if (!this.current || this.componentId !== componentId) return;
    const previous = this.lastSampleNs;
    if (previous !== undefined && sampleTimestampNs === previous) return;
    const dt = previous === undefined || sampleTimestampNs < previous ? 0 : (sampleTimestampNs - previous) / 1e9;
    void this.current.webview.postMessage({ type: "pidSnapshot", values, dt });
    this.lastSampleNs = sampleTimestampNs;
  }

  static updateSeries(componentId: string, series: { reset: boolean; t: number[]; pv: number[]; sp: number[]; mv: number[] }): void {
    if (!this.current || this.componentId !== componentId) return;
    void this.current.webview.postMessage({ type: "pidSeries", ...series });
  }

  static latestSample(componentId: string): { sp?: number; pv?: number; mv?: number; manual?: boolean; localMode?: boolean } | undefined {
    return this.lastValues.get(componentId);
  }
}
