import * as vscode from "vscode";
import { WebviewComponentCatalogEntry, WebviewComponentModel } from "../webview/model";

type InspectorMessage = { type: "ready" } | { type: "setProperty"; name: string; value: string | number | boolean };

/** Persistent right-side inspector.  The webview is metadata-driven; mutations are sent back
 * through the schematic panel's normal requestUpdateProperty path, so undo/persistence/Core
 * validation remain single-sourced. */
export class PropertyInspectorViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private component?: WebviewComponentModel;
  private catalog: WebviewComponentCatalogEntry[] = [];

  constructor(private readonly extensionUri: vscode.Uri, catalog: WebviewComponentCatalogEntry[],
              private readonly forwardMutation: (componentId: string, name: string, value: string | number | boolean) => void) {
    this.catalog = [...catalog];
  }
  setCatalog(catalog: WebviewComponentCatalogEntry[]): void { this.catalog = [...catalog]; void this.render(); }
  setSelection(component: WebviewComponentModel | undefined): void { this.component = component; void this.render(); }
  resolveWebviewView(view: vscode.WebviewView): void | Thenable<void> {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "out")] };
    view.webview.onDidReceiveMessage((message: InspectorMessage) => {
      if (message.type === "setProperty" && this.component) this.forwardMutation(this.component.id, message.name, message.value);
    });
    return this.render();
  }
  private async render(): Promise<void> {
    if (!this.view) return;
    const c = this.component;
    const descriptor = c ? this.catalog.find((entry) => entry.typeId === c.typeId) : undefined;
    const schemas = descriptor?.propertySchema ?? [];
    const values = c?.properties ?? {};
    const fields = schemas.filter((schema) => !["hartVariablesJson", "hartCommandsJson"].includes(schema.id)).map((schema) => {
      const value = values[schema.id] ?? schema.default;
      const type = schema.editor === "checkbox" ? "checkbox" : schema.editor === "number" ? "number" : "text";
      const checked = type === "checkbox" && value === true ? " checked" : "";
      const text = type === "checkbox" ? "" : ` value="${String(value ?? "").replaceAll("&", "&amp;").replaceAll("\"", "&quot;")}"`;
      return `<label><span>${schema.label || schema.id}</span><input data-name="${schema.id}" type="${type}"${text}${checked}></label>`;
    }).join("");
    const hart = c && c.typeId.startsWith("protocol.hart.") ? this.renderHartCollections(values) : "";
    this.view.webview.html = `<!doctype html><html><head><meta charset="utf-8"><style>
      body{font:var(--vscode-font-size) var(--vscode-font-family);color:var(--vscode-foreground);padding:10px}h2{font-size:13px;margin:0 0 12px}h3{font-size:12px;margin:0 0 8px}.empty{opacity:.7}section{border-top:1px solid var(--vscode-panel-border);padding:8px 0}label{display:block;margin:8px 0}label span{display:block;font-size:11px;margin-bottom:3px}input{box-sizing:border-box;width:100%;color:inherit;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);padding:4px}input[type=checkbox]{width:auto}.hart-row{display:grid;grid-template-columns:1fr 1fr auto;gap:4px;margin:4px 0}.hart-row button{font-size:10px}</style></head><body>
      <h2>Properties</h2>${c ? `<div><strong>${c.label || c.typeId}</strong><small> · ${c.typeId}</small></div><section>${fields || `<div class="empty">No editable properties.</div>`}</section>${hart}` : `<div class="empty">No component selected.<br><br>Select a component in the workspace.</div>`}
      <script>const api=acquireVsCodeApi();document.querySelectorAll('input[data-name]').forEach((e)=>e.addEventListener('change',()=>{const v=e.type==='checkbox'?e.checked:e.type==='number'?Number(e.value):e.value;api.postMessage({type:'setProperty',name:e.dataset.name,value:v});}));const hv=${JSON.stringify({hartVariablesJson:values.hartVariablesJson??"[]",hartCommandsJson:values.hartCommandsJson??"[]"})};function commit(k){const rows=[...document.querySelectorAll('[data-hart-key="'+k+'"]')].reduce((a,e)=>{const i=Number(e.dataset.hartIndex);(a[i]??={})[e.dataset.hartField]=e.value;return a},[]);api.postMessage({type:'setProperty',name:k,value:JSON.stringify(rows)});}document.querySelectorAll('[data-hart-key]').forEach(e=>e.addEventListener('change',()=>commit(e.dataset.hartKey)));document.querySelectorAll('[data-hart-add]').forEach(e=>e.addEventListener('click',()=>{const k=e.dataset.hartAdd;let a=[];try{a=JSON.parse(hv[k]||'[]')}catch{};a.push(k==='hartCommandsJson'?{id:128,name:'Custom'}:{id:'PV',name:'Variable'});hv[k]=JSON.stringify(a);api.postMessage({type:'setProperty',name:k,value:hv[k]});}));document.querySelectorAll('[data-hart-remove]').forEach(e=>e.addEventListener('click',()=>{const k=e.dataset.hartRemove;let a=[];try{a=JSON.parse(hv[k]||'[]')}catch{};a.splice(Number(e.dataset.hartIndex),1);hv[k]=JSON.stringify(a);api.postMessage({type:'setProperty',name:k,value:hv[k]});}));</script></body></html>`;
  }

  private renderHartCollections(values: Record<string, string | number | boolean>): string {
    const parse = (key: string): Array<Record<string, unknown>> => { try { const v = JSON.parse(String(values[key] ?? "[]")); return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object") : []; } catch { return []; } };
    const section = (key: string, title: string, seed: Record<string, unknown>) => {
      const items = parse(key);
      const rows = items.map((item, i) => `<div class="hart-row"><input data-hart-key="${key}" data-hart-index="${i}" data-hart-field="id" value="${String(item.id ?? "").replaceAll('"','&quot;')}" placeholder="id"><input data-hart-key="${key}" data-hart-index="${i}" data-hart-field="name" value="${String(item.name ?? "").replaceAll('"','&quot;')}" placeholder="name"><input data-hart-key="${key}" data-hart-index="${i}" data-hart-field="unit" value="${String(item.unit ?? "").replaceAll('"','&quot;')}" placeholder="unit"><input data-hart-key="${key}" data-hart-index="${i}" data-hart-field="source" value="${String(item.source ?? item.function ?? "").replaceAll('"','&quot;')}" placeholder="source/function"><button data-hart-remove="${key}" data-hart-index="${i}">Remove</button></div>`).join("");
      return `<section><h3>${title}</h3>${rows || `<div class="empty">None configured.</div>`}<button data-hart-add="${key}">+ Add</button></section>`;
    };
    return section("hartVariablesJson", "Variables", {id:"PV",name:"Process Value"}) + section("hartCommandsJson", "Commands", {id:1,name:"Command"});
  }
}
