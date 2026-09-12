import * as vscode from "vscode";
import { PropertySchemaEntry, WebviewComponentCatalogEntry, WebviewComponentModel } from "../webview/model";
import { SimulationStatus } from "../webview/messages";
import { propertyFieldKindFromEditor } from "../webview/batchProperties";
import {
  HART_BUILTIN_VARIABLES,
  hartInspectorClientScript,
  parseCommandRows,
  parseVariableRows,
  preserveExistingVariableIds,
  renderCommandsSection,
  renderVariablesSection,
} from "./hartInspectorSections";

type InspectorMessage = { type: "ready" } | { type: "setProperty"; name: string; value: string | number | boolean };

const HART_HIDDEN_FIELD_IDS = new Set(["hartVariablesJson", "hartCommandsJson", "hartVariablesStatus", "hartCommandsStatus"]);

/** Cosmetic-only relabeling of Core `PropertySchema.group` strings for this
 * panel; the underlying schema groups are shared with the canvas property
 * sheet (`main.ts`) and are not renamed there. */
const GROUP_DISPLAY_NAMES: Record<string, string> = {
  Comunicacao: "General",
  HART: "HART Identity & Addressing",
  Diagnostics: "Diagnostics",
};

function escapeAttr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;");
}

/** Persistent right-side inspector. The webview is metadata-driven; mutations are sent back
 * through the schematic panel's normal requestUpdateProperty path, so undo/persistence/Core
 * validation remain single-sourced (the Authoring Model is the source of truth -- this class
 * only renders it and forwards edits, it never keeps a second authoritative copy). */
export class PropertyInspectorViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private component?: WebviewComponentModel;
  private catalog: WebviewComponentCatalogEntry[] = [];
  private simulationStatus: SimulationStatus = "stopped";
  private dslDraftOpen = false;

  constructor(private readonly extensionUri: vscode.Uri, catalog: WebviewComponentCatalogEntry[],
              private readonly forwardMutation: (componentId: string, name: string, value: string | number | boolean) => void) {
    this.catalog = [...catalog];
  }
  setCatalog(catalog: WebviewComponentCatalogEntry[]): void { this.catalog = [...catalog]; void this.render(); }
  setSelection(component: WebviewComponentModel | undefined): void { this.component = component; void this.render(); }
  /** Mirrors `lasecPlotManager`/`serialTerminalManager`/`serialPortManager`'s own
   * `updateSimulationState` -- structural HART edits (add/remove variable or
   * command, change direction/type) are disabled while RUN is active
   * (HART-FR-021, section 20). */
  setSimulationStatus(status: SimulationStatus): void { this.simulationStatus = status; void this.render(); }

  /** While an unapplied "Lasec DSL" text draft is open, it -- not this panel
   * -- is the editing authority (Anexo B sections 108-110): an Inspector edit
   * made in the meantime would be silently discarded the next time the draft
   * is applied, since `commitDslCommand` replaces the whole Authoring Model
   * from the draft text with no knowledge of any concurrent Inspector edit.
   * Rather than let two surfaces both look editable with values that can
   * silently diverge, this panel goes fully read-only until the draft closes
   * or is applied. */
  setDslDraftOpen(open: boolean): void { this.dslDraftOpen = open; void this.render(); }

  resolveWebviewView(view: vscode.WebviewView): void | Thenable<void> {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "out")] };
    view.webview.onDidReceiveMessage((message: InspectorMessage) => {
      // Defense in depth: the rendered HTML already omits/disables every
      // input while a DSL draft is open, but a message that slips through
      // anyway (e.g. a stale webview that hasn't re-rendered yet) must still
      // never reach the Authoring Model.
      if (message.type !== "setProperty" || !this.component || this.dslDraftOpen) return;
      // Second defense in depth, specific to hartVariablesJson: the `id`
      // input is rendered `readonly` for existing rows (Signal Graph wires
      // are keyed on it -- see hartInspectorSections.ts), but a stale/
      // bypassed webview message must not be able to sneak a changed id
      // through and silently orphan a wire.
      const value = message.name === "hartVariablesJson" && typeof message.value === "string"
        ? preserveExistingVariableIds(String(this.component.properties.hartVariablesJson ?? "[]"), message.value)
        : message.value;
      this.forwardMutation(this.component.id, message.name, value);
    });
    return this.render();
  }

  private renderField(schema: PropertySchemaEntry, value: string | number | boolean, forceReadOnly: boolean): string {
    const kind = propertyFieldKindFromEditor(schema.editor);
    const label = `<span>${escapeAttr(schema.label || schema.id)}</span>`;
    if (kind === "readonly" || forceReadOnly) {
      return `<label class="ro">${label}<div class="ro-value">${escapeAttr(String(value ?? ""))}</div></label>`;
    }
    if (kind === "boolean") {
      return `<label class="cb"><input data-name="${schema.id}" type="checkbox"${value === true ? " checked" : ""}> ${escapeAttr(schema.label || schema.id)}</label>`;
    }
    if (kind === "select" && schema.options?.length) {
      const opts = schema.options.map((o) => `<option value="${escapeAttr(o.value)}"${o.value === value ? " selected" : ""}>${escapeAttr(o.label)}</option>`).join("");
      return `<label>${label}<select data-name="${schema.id}">${opts}</select></label>`;
    }
    const type = kind === "number" ? "number" : "text";
    return `<label>${label}<input data-name="${schema.id}" type="${type}" value="${escapeAttr(String(value ?? ""))}"></label>`;
  }

  private async render(): Promise<void> {
    if (!this.view) return;
    const c = this.component;
    const descriptor = c ? this.catalog.find((entry) => entry.typeId === c.typeId) : undefined;
    const schemas = descriptor?.propertySchema ?? [];
    const values = c?.properties ?? {};
    const isHart = Boolean(c && c.typeId.startsWith("protocol.hart."));

    // Section grouping (section 6 of the Property Inspector contract): group
    // by `schema.group` in order of first appearance, instead of one flat
    // untitled list -- `PropertySchema.group` already existed in Core/the
    // catalog and was simply never used by this panel.
    const groupOrder: string[] = [];
    const byGroup = new Map<string, typeof schemas>();
    for (const schema of schemas) {
      if (isHart && HART_HIDDEN_FIELD_IDS.has(schema.id)) continue;
      const group = schema.group || "General";
      if (!byGroup.has(group)) { byGroup.set(group, []); groupOrder.push(group); }
      byGroup.get(group)!.push(schema);
    }
    const generalSections = groupOrder.map((group) => {
      const fieldsHtml = byGroup.get(group)!.map((schema) => this.renderField(schema, values[schema.id] ?? schema.default, this.dslDraftOpen)).join("");
      const title = GROUP_DISPLAY_NAMES[group] ?? group;
      return `<section><h3>${escapeAttr(title)}</h3>${fieldsHtml}</section>`;
    }).join("");

    let hartHtml = "";
    if (isHart) {
      const structuralEditsLocked = this.dslDraftOpen || this.simulationStatus !== "stopped";
      const variableRows = parseVariableRows(String(values.hartVariablesJson ?? "[]"));
      const commandRows = parseCommandRows(String(values.hartCommandsJson ?? "[]"));
      const commandsStatus = String(values.hartCommandsStatus ?? "OK");
      const variablesStatus = String(values.hartVariablesStatus ?? "OK");
      hartHtml = renderVariablesSection(variableRows, { structuralEditsLocked }) +
        renderCommandsSection(commandRows, commandsStatus, { structuralEditsLocked }, variableRows) +
        (variablesStatus.trim().toUpperCase() !== "OK"
          ? `<section><h3>Diagnostics</h3><div class="hc-status err">Variables: &#10007; ${escapeAttr(variablesStatus)}</div></section>`
          : "");
      if (structuralEditsLocked && !this.dslDraftOpen) {
        hartHtml = `<div class="run-note">Simulation is ${escapeAttr(this.simulationStatus)}: structural edits and variable values are disabled.</div>` + hartHtml;
      }
    }

    // A DSL draft, once open, is the editing authority until applied or
    // closed (Anexo B sections 108-110) -- one banner covers every component
    // type, not just HART, since the whole Authoring Model is at stake, not
    // just this one component's properties.
    const dslBanner = this.dslDraftOpen
      ? `<div class="run-note">A DSL draft is open ("LasecSimul: Editar circuito em DSL"). It is the current editing authority: this panel is read-only until you apply it ("LasecSimul: Aplicar DSL ao Esquemático") or close the draft, so an edit here can never be silently overwritten by the draft.</div>`
      : "";

    this.view.webview.html = `<!doctype html><html><head><meta charset="utf-8"><style>
      body{font:var(--vscode-font-size) var(--vscode-font-family);color:var(--vscode-foreground);padding:10px}
      h2{font-size:13px;margin:0 0 12px}h3{font-size:12px;margin:0 0 8px;opacity:.85}
      .empty{opacity:.7}section{border-top:1px solid var(--vscode-panel-border);padding:8px 0;overflow-wrap:anywhere}
      label{display:block;margin:8px 0}label span{display:block;font-size:11px;margin-bottom:3px}
      label.cb{display:flex;align-items:center;gap:6px}label.cb input{width:auto}
      label.ro .ro-value{opacity:.75;font-family:var(--vscode-editor-font-family,monospace)}
      input,select{box-sizing:border-box;width:100%;max-width:100%;color:inherit;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);padding:4px}
      input[type=checkbox]{width:auto}
      .hv-row,.hc-row{border:1px solid var(--vscode-panel-border);border-radius:4px;padding:6px;margin:6px 0}
      .hv-line{display:flex;gap:4px;margin:3px 0;flex-wrap:wrap}
      .hv-line>input,.hv-line>select{width:auto;flex:1 1 80px;min-width:60px}
      .hv-line label{display:flex;align-items:center;gap:4px;font-size:11px;margin:0}
      .hv-line label input{width:auto}
      .hv-note{font-size:10px;opacity:.7;margin-top:2px}
      .hc-line{display:flex;gap:4px;align-items:center;flex-wrap:wrap;margin:3px 0}
      .hc-line>input{flex:1 1 60px;width:auto}
      .hc-stage-label{font-size:10px;opacity:.7;margin:6px 0 2px}
      .hc-step{display:flex;gap:4px;margin:3px 0;flex-wrap:wrap}
      .hc-step>select,.hc-step>input{width:auto;flex:1 1 70px;min-width:50px}
      .hc-status{font-size:11px;margin-bottom:6px}
      .hc-status.ok{color:var(--vscode-testing-iconPassed,#2ea043)}
      .hc-status.err{color:var(--vscode-testing-iconFailed,#f14c4c)}
      .run-note{font-size:11px;opacity:.85;background:var(--vscode-inputValidation-warningBackground);border:1px solid var(--vscode-inputValidation-warningBorder);padding:6px;border-radius:4px;margin-bottom:8px}
      button{font-size:10px}
    </style></head><body>
      <h2>Properties</h2>${dslBanner}${c
        ? `<div><strong>${escapeAttr(c.label || c.typeId)}</strong><small> &middot; ${escapeAttr(c.typeId)}</small></div>${generalSections || `<div class="empty">No editable properties.</div>`}${hartHtml}`
        : `<div class="empty">No component selected.<br><br>Select a component in the workspace.</div>`}
      <script>
        const api = acquireVsCodeApi();
        document.querySelectorAll('[data-name]').forEach((e) => e.addEventListener('change', () => {
          const v = e.type === 'checkbox' ? e.checked : e.type === 'number' ? Number(e.value) : e.value;
          api.postMessage({ type: 'setProperty', name: e.dataset.name, value: v });
        }));
        ${hartInspectorClientScript()}
      </script>
    </body></html>`;
  }
}

// Re-exported so callers/tests can reference the canonical built-in variable
// list without importing the sections module directly.
export { HART_BUILTIN_VARIABLES };
