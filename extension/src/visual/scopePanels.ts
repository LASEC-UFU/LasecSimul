import * as vscode from "vscode";
import { addSeriesDrain, onCoreRebuilt, onSimulationStatusChange } from "../core/coreLifecycle";
import { coreInstanceIdByComponentId, state } from "../state";
import { SeriesStore } from "../lab/SeriesStore";
import type { SeriesDelta } from "../lab/SeriesStore";
import type { ProjectTopologyEndpoint } from "../project/ProjectTypes";
import type { WebviewComponentModel } from "../ui/webview/model";
import { cacheBustedUri } from "../ui/panels/schematicBundleHtml";
import { findCatalogEntry } from "../core/coreLifecycle";

interface ScopeChannel { id: string; label: string; instanceId: string; port: string }
interface ScopePanelRecord {
  panel: vscode.WebviewPanel;
  componentId: string;
  channels: ScopeChannel[];
  subscriptionId?: number;
  store?: SeriesStore;
  removeDrain?: () => void;
  disposed: boolean;
  binding?: Promise<void>;
  bindEpoch: number;
}

const TYPE_ID = "sl.scope";
const panels = new Map<string, ScopePanelRecord>();
let extensionUri: vscode.Uri | undefined;

export function configureScopePanels(uri: vscode.Uri): vscode.Disposable {
  extensionUri = uri;
  const status = onSimulationStatusChange((next) => {
    if (next === "stopped") for (const record of panels.values()) {
      record.bindEpoch++; void unbind(record);
      void record.panel.webview.postMessage({ type: "status", text: "Simulação parada" });
    }
    else {
      for (const record of panels.values()) if (record.subscriptionId === undefined) void bind(record);
      for (const record of panels.values()) void record.panel.webview.postMessage({ type: "status", text: next === "paused" ? "Simulação pausada" : "Simulação em execução" });
      if (next === "running") for (const component of state.schematicState.components) {
        if (component.typeId === TYPE_ID && component.properties.OpenAtSimulationStart === true) void openScope(component.id);
      }
    }
  });
  const rebuilt = onCoreRebuilt(async () => {
    for (const record of panels.values()) await refreshBinding(record);
  });
  return new vscode.Disposable(() => {
    status(); rebuilt();
    for (const record of panels.values()) record.panel.dispose();
    panels.clear(); extensionUri = undefined;
  });
}

export async function openScope(componentId: string): Promise<void> {
  const component = state.schematicState.components.find((item) => item.id === componentId && item.typeId === TYPE_ID);
  if (!component) return;
  const existing = panels.get(componentId);
  if (existing) { existing.panel.reveal(vscode.ViewColumn.Active); return; }
  if (!extensionUri) return;
  const panel = vscode.window.createWebviewPanel("lasecsimul.scope", `Scope: ${component.label ?? component.id}`,
    vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "out-webview")] });
  const record: ScopePanelRecord = { panel, componentId, channels: resolveChannels(component), disposed: false, bindEpoch: 0 };
  panels.set(componentId, record);
  panel.onDidDispose(() => { record.disposed = true; panels.delete(componentId); void unbind(record); });
  const script = vscode.Uri.joinPath(extensionUri, "out-webview", "scope", "main.js");
  const nonce = String(Date.now());
  const src = cacheBustedUri(panel.webview, script, nonce);
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' ${panel.webview.cspSource}`;
  panel.webview.html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>Scope</title><style>
    :root{color-scheme:light dark;font:13px var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background)}body{margin:0}header{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:10px 14px;background:var(--vscode-sideBar-background);border-bottom:1px solid var(--vscode-panel-border)}h1{font-size:16px;margin:0;flex:1}.actions{display:flex;gap:6px}button{font:inherit;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;padding:5px 10px;cursor:pointer}button:hover{background:var(--vscode-button-hoverBackground)}.status{color:var(--vscode-descriptionForeground)}.legend{display:flex;gap:12px;flex-wrap:wrap;padding:8px 14px}.item{display:inline-flex;align-items:center;gap:5px}.item i{width:12px;height:3px;display:inline-block}.plot{display:block;width:100%;height:calc(100vh - 90px);min-height:260px;background:var(--vscode-editor-background)}
    </style></head><body><main id="app"></main><script nonce="${nonce}" type="module" src="${src}"></script></body></html>`;
  panel.webview.onDidReceiveMessage((message: { type?: string }) => {
    if (message?.type === "ready") {
      const current = state.schematicState.components.find((item) => item.id === componentId);
      if (!current) return;
      void panel.webview.postMessage({ type: "init", title: current.label ?? current.id, channels: record.channels.map(({ id, label }) => ({ id, label })), params: current.properties });
      void bind(record);
    }
  });
  if (state.simulationStatus === "paused" || state.simulationStatus === "running") void bind(record);
}

function endpointKey(endpoint: ProjectTopologyEndpoint): string {
  return endpoint.kind === "port" ? `p:${endpoint.componentId}:${endpoint.pinId}` : `n:${endpoint.nodeId}`;
}

/** Resolve direct wires and junctions back to the first block output feeding each Scope input. */
function resolveChannels(scope: WebviewComponentModel): ScopeChannel[] {
  const topology = state.schematicState.topology;
  const adjacency = new Map<string, Set<string>>();
  const connect = (a: ProjectTopologyEndpoint, b: ProjectTopologyEndpoint) => {
    const ka = endpointKey(a), kb = endpointKey(b);
    if (!adjacency.has(ka)) adjacency.set(ka, new Set());
    if (!adjacency.has(kb)) adjacency.set(kb, new Set());
    adjacency.get(ka)!.add(kb); adjacency.get(kb)!.add(ka);
  };
  for (const wire of topology.conductors) connect(wire.from, wire.to);
  const channels: ScopeChannel[] = [];
  for (const pin of scope.pins) {
    if (!/^in\d*$/i.test(pin.id)) continue;
    const start = `p:${scope.id}:${pin.id}`;
    const queue = [start], seen = new Set(queue);
    let found: { componentId: string; pinId: string } | undefined;
    while (queue.length && !found) {
      const key = queue.shift()!;
      if (key.startsWith("p:")) {
        const [, componentId, pinId] = key.split(":");
        if (componentId !== scope.id && componentId && pinId && isOutputPin(componentId, pinId)) found = { componentId, pinId };
      }
      for (const next of adjacency.get(key) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
    if (!found) continue;
    const instanceId = coreInstanceIdByComponentId.get(found.componentId);
    if (!instanceId) continue;
    const source = state.schematicState.components.find((item) => item.id === found!.componentId);
    channels.push({ id: pin.id, label: source ? `${source.label ?? source.id} · ${found.pinId}` : found.pinId, instanceId, port: found.pinId });
  }
  return channels;
}

function isOutputPin(componentId: string, pinId: string): boolean {
  const component = state.schematicState.components.find((item) => item.id === componentId);
  if (!component) return false;
  // The block library uses named input/output ports. This excludes `in*` even when they are
  // electrically wired, and keeps signal capture attached to the producing block's output.
  if (/^in\d*$/i.test(pinId)) return false;
  const entry = findCatalogEntry(component.typeId);
  return entry?.pinIds?.includes(pinId) === true || /^out\d*$/i.test(pinId) || /^y\d*$/i.test(pinId);
}

async function bind(record: ScopePanelRecord): Promise<void> {
  if (record.binding) return record.binding;
  const task = bindInner(record);
  record.binding = task;
  try { await task; } finally { if (record.binding === task) record.binding = undefined; }
}

async function refreshBinding(record: ScopePanelRecord): Promise<void> {
  record.bindEpoch++;
  await record.binding?.catch(() => undefined);
  if (!record.disposed && panels.get(record.componentId) === record) await bind(record);
}

async function bindInner(record: ScopePanelRecord): Promise<void> {
  const epoch = ++record.bindEpoch;
  await unbind(record);
  const component = state.schematicState.components.find((item) => item.id === record.componentId);
  if (record.disposed || panels.get(record.componentId) !== record || state.simulationStatus === "stopped" || !component) return;
  record.channels = resolveChannels(component);
  void record.panel.webview.postMessage({ type: "init", title: component.label ?? component.id,
    channels: record.channels.map(({ id, label }) => ({ id, label })), params: component.properties });
  if (!record.channels.length || !state.coreClient) {
    void record.panel.webview.postMessage({ type: "status", text: record.channels.length ? "Core indisponível" : "Conecte as entradas do Scope às saídas de blocos." });
    return;
  }
  try {
    const subscriptionId = await state.coreClient.subscribeSeries(record.channels.map((channel) => ({ instanceId: channel.instanceId, port: channel.port })), { periodNs: 10_000_000, capacityRows: 50_000 });
    if (record.disposed || record.bindEpoch !== epoch || panels.get(record.componentId) !== record || String(state.simulationStatus) === "stopped") { await state.coreClient.unsubscribeSeries(subscriptionId); return; }
    const store = new SeriesStore(subscriptionId, record.channels.map((channel) => channel.id), 50_000);
    record.subscriptionId = subscriptionId; record.store = store;
    record.removeDrain = addSeriesDrain({ subscriptionId, request: () => store.request(), deliver: (chunk) => {
      const delta = store.ingest(chunk); if (delta) postDelta(record, delta);
    } });
    postDelta(record, store.snapshot());
  } catch (error) {
    void record.panel.webview.postMessage({ type: "status", text: `Falha ao capturar sinais: ${error instanceof Error ? error.message : String(error)}` });
  }
}

function postDelta(record: ScopePanelRecord, delta: SeriesDelta): void {
  if (record.disposed) return;
  void record.panel.webview.postMessage({ type: "delta", reset: delta.reset, t: delta.t, columns: delta.columns });
}

async function unbind(record: ScopePanelRecord): Promise<void> {
  record.removeDrain?.(); record.removeDrain = undefined;
  const id = record.subscriptionId; record.subscriptionId = undefined; record.store = undefined;
  if (id !== undefined && state.coreClient) await state.coreClient.unsubscribeSeries(id).catch(() => false);
}
