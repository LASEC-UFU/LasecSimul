import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import type { InstrumentHistoryPayload } from "../webview/messages";
import { showInAuxiliaryWindow } from "./standaloneWebview";

type InstrumentRecord = {
  panel: vscode.WebviewPanel;
  latest?: InstrumentHistoryPayload;
  request: (sinceNs?: number) => void;
  exportData: (name: string, content: string) => void;
  updateProperty: (name: string, value: string | number | boolean) => void;
  saveSettings: (value: string) => void;
  setPauseCondition: (expression: string) => Promise<string | undefined>;
};
const panels = new Map<string, InstrumentRecord>();

/** Floating auxiliary windows for the electrical oscilloscope and logic analyzer. */
export class ElectricalInstrumentPanel {
  static has(componentId: string): boolean { return panels.has(componentId); }
  static open(componentId: string, label: string, kind: "scope" | "logic", request: (sinceNs?: number) => void,
    exportData: (name: string, content: string) => void,
    updateProperty: (name: string, value: string | number | boolean) => void,
    initialSettings = "", saveSettings: (value: string) => void = () => undefined,
    setPauseCondition: (expression: string) => Promise<string | undefined> = async () => undefined): void {
    const existing = panels.get(componentId);
    if (existing) { existing.panel.reveal(vscode.ViewColumn.Active); existing.request(); return; }
    const panel = vscode.window.createWebviewPanel("lasecsimul.electricalInstrument", label, vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true });
    const record: InstrumentRecord = { panel, request, exportData, updateProperty, saveSettings, setPauseCondition };
    panels.set(componentId, record);
    panel.onDidDispose(() => { if (panels.get(componentId) === record) panels.delete(componentId); });
    panel.webview.onDidReceiveMessage((message: { type?: string; sinceNs?: number; name?: string; content?: string; property?: string; value?: unknown; settings?: string; expression?: string }) => {
      if (message?.type === "ready" || message?.type === "historyRequest") {
        record.request(message.type === "historyRequest" ? message.sinceNs : undefined);
        if (record.latest) void panel.webview.postMessage({ type: "history", payload: record.latest });
      } else if (message?.type === "export" && typeof message.name === "string" && typeof message.content === "string") {
        record.exportData(message.name, message.content);
      } else if (message?.type === "property" && typeof message.property === "string" && (typeof message.value === "boolean" || typeof message.value === "number" || typeof message.value === "string")) {
        record.updateProperty(message.property, message.value);
      } else if (message?.type === "settings" && typeof message.settings === "string") {
        record.saveSettings(message.settings);
      } else if (message?.type === "pauseCondition" && typeof message.expression === "string") {
        void record.setPauseCondition(message.expression).then((error) => panel.webview.postMessage({ type: "pauseConditionStatus", error, expression: message.expression }));
      }
    });
    panel.webview.html = instrumentHtml(panel.webview, label, kind, initialSettings);
    void showInAuxiliaryWindow(panel);
  }

  static update(payload: InstrumentHistoryPayload): void {
    const record = panels.get(payload.componentId);
    if (!record) return;
    if (payload.append && payload.oscope && record.latest?.oscope) {
      const channels = payload.oscope.channels.map((incoming, index) => {
        const previous = record.latest!.oscope!.channels[index] ?? { timestampsNs: [], values: [] };
        return { timestampsNs: [...previous.timestampsNs, ...incoming.timestampsNs].slice(-4096), values: [...previous.values, ...incoming.values].slice(-4096) };
      });
      record.latest = { componentId: payload.componentId, oscope: { channels } };
    } else record.latest = payload;
    void record.panel.webview.postMessage({ type: "history", payload });
  }
}

function instrumentHtml(webview: vscode.Webview, title: string, kind: "scope" | "logic", settingsJson: string): string {
  const nonce = String(Date.now());
  const safeTitle = title.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  const raw = fs.readFileSync(path.join(__dirname, "../../../media/electrical-instrument.html"), "utf8");
  return raw.replaceAll("{{CSP}}", webview.cspSource).replaceAll("{{NONCE}}", nonce)
    .replaceAll("{{TITLE}}", safeTitle).replaceAll("{{TITLE_JSON}}", JSON.stringify(title).replace(/</g, "\\u003c"))
    .replaceAll("{{KIND}}", kind).replaceAll("{{SETTINGS}}", JSON.stringify(settingsJson || "{}").replace(/</g, "\\u003c"));
}
