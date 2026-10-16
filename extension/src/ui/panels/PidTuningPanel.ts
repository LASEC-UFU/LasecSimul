import * as fs from "fs";
import * as vscode from "vscode";
import { SchematicPanel } from "./SchematicPanel";

/** Exibe a interface JSP original como modal na própria Webview do esquemático. */
export class PidTuningPanel {
  private static current = false;
  private static componentId: string | undefined;
  private static onPropertyChange: ((name: string, value: string | number | boolean) => void) | undefined;
  private static lastSampleAt = 0;
  private static lastValues = new Map<string, { sp?: number; pv?: number; mv?: number; manual?: boolean; localMode?: boolean }>();

  static open(extensionUri: vscode.Uri, componentId: string, tag = "Controller", onChange: (name: string, value: string | number | boolean) => void): void {
    if (this.componentId !== componentId) this.lastSampleAt = 0;
    this.componentId = componentId;
    this.onPropertyChange = onChange;
    const schematic = SchematicPanel.current;
    if (!schematic) throw new Error("O esquemático precisa estar aberto para exibir a sintonia.");

    const root = vscode.Uri.joinPath(extensionUri, "media", "pid");
    const plotlyUri = vscode.Uri.joinPath(root, "plotly-2.30.0.min.js");
    const context = schematic.pidDialogWebviewContext();
    const nonce = context.nonce;
    let html = fs.readFileSync(vscode.Uri.joinPath(root, "pid_dialog.html").fsPath, "utf8");
    html = html.replace(/<%@[^%]*%>/g, "");
    html = html.replace(/<c:out\s+value=['"][^'"]*['"]\s*\/>/g, "");
    html = html.replace(/const ctxPath =\s*"\s*";/, 'const ctxPath = "";');
    html = html.replace('let DEMO_MODE = false;', 'let DEMO_MODE = false;')
      .replace('const local = ctxPath + "/resources/plotly-2.30.0.min.js";', `const local = "${context.asWebviewUri(plotlyUri)}";`);
    html = html.replace(/<script(?![^>]*\bnonce=)/g, `<script nonce="${nonce}"`);
    html = html.replace(/(let TITLE = )"Controller";/, `$1${JSON.stringify(tag)};`);
    const bridge = `<script nonce="${nonce}">window.PID_COMPONENT_ID=${JSON.stringify(componentId)};const vscode={postMessage:(message)=>parent.postMessage({type:'pidDialogPropertyChanged',message},'*')};</script>`;
    const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${context.cspSource} data:; style-src ${context.cspSource} 'unsafe-inline'; script-src ${context.cspSource} https://cdn.plot.ly 'nonce-${nonce}';">`;
    const fitLayout = `<style nonce="${nonce}">html,body{width:100%;height:100%;overflow:hidden}body{align-items:stretch!important;justify-content:stretch!important;padding:0!important}.controller-body{width:100%;height:100%;min-height:0;grid-template-columns:minmax(240px,.6fr) minmax(0,2.4fr);align-items:stretch}.controller-display,.controller-graph{min-height:0}.controller-display{overflow:auto}.controller-graph{min-width:0}#plotBox{min-height:0}@media(max-width:850px){.controller-body{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr)}.controller-display{max-height:42vh}}</style>`;
    html = html.replace("<head>", `<head>${policy}${fitLayout}${bridge}`);
    this.current = true;
    schematic.showPidDialog(componentId, html);
    const sample = this.latestSample(componentId);
    if (sample) this.updateSample(componentId, sample);
  }

  static handlePropertyChange(message: { componentId: string; name: string; value: string | number | boolean }): void {
    if (!this.current || this.componentId !== message.componentId) return;
    const writable = new Set(["kc", "ti", "td", "bias", "outputMin", "outputMax", "manual", "manualOutput", "localMode", "localSetpoint", "remoteSetpoint"]);
    if (!writable.has(message.name) || (typeof message.value !== "boolean" && (typeof message.value !== "number" || !Number.isFinite(message.value)))) return;
    this.onPropertyChange?.(message.name, message.value);
  }

  static close(): void {
    this.current = false;
    this.componentId = undefined;
    this.onPropertyChange = undefined;
  }

  static updateSample(componentId: string, values: { sp?: number; pv?: number; mv?: number; manual?: boolean; localMode?: boolean; setpointSourceId?: string }): void {
    this.lastValues.set(componentId, values);
    if (!this.current || this.componentId !== componentId) return;
    const now = Date.now();
    void SchematicPanel.current?.postMessage({ version: 1, type: "pidDialogSnapshot", values, dt: this.lastSampleAt ? (now - this.lastSampleAt) / 1000 : 0.3 });
    this.lastSampleAt = now;
  }

  static latestSample(componentId: string): { sp?: number; pv?: number; mv?: number; manual?: boolean; localMode?: boolean } | undefined {
    return this.lastValues.get(componentId);
  }
}
