import * as vscode from "vscode";
import { state } from "../state.js";
import { rebuildCoreFromSchematicState } from "../core/coreLifecycle.js";
import { parseDsl } from "./DslParser.js";
import { reconcileDsl } from "./DslReconciler.js";
import { stateToDsl } from "./DslSerializer.js";

let dslDocument: vscode.TextDocument | undefined;
let diagnostics: vscode.DiagnosticCollection | undefined;
let dslDraftOpenListener: ((open: boolean) => void) | undefined;

function setDslDocument(document: vscode.TextDocument | undefined): void {
  dslDocument = document;
  dslDraftOpenListener?.(Boolean(dslDocument));
}

/** Called once from `activate()`. Without this, `dslDocument` was set on open
 * and never cleared -- `isDslDocumentOpen()` stayed `true` forever after the
 * first "Editar circuito em DSL", including after the tab was closed without
 * ever applying, permanently affecting every later `commitOpenDslIfPresent()`
 * gate (Save/Run) and any UI (Property Inspector) that reads the flag. */
export function registerDslDraftCloseTracking(): vscode.Disposable {
  return vscode.workspace.onDidCloseTextDocument((closed) => {
    if (dslDocument && closed.uri.toString() === dslDocument.uri.toString()) setDslDocument(undefined);
  });
}

/** Lets other UI (Property Inspector) react to the DSL draft's open/applied
 * state without polling -- see .spec/features/hart-device-engine.md "Anexo B"
 * sections 108-110: while an unapplied DSL draft exists, it -- not the
 * Property Inspector -- is the editing authority, so the Inspector goes
 * read-only rather than silently diverging from a draft the user is mid-edit
 * on. */
export function onDslDraftOpenChanged(listener: (open: boolean) => void): void { dslDraftOpenListener = listener; }

function reportDiagnostics(uri: vscode.Uri, errors: Array<{ message: string; line: number; column: number; severity: "error" | "warning" }>): void {
  diagnostics ??= vscode.languages.createDiagnosticCollection("lasecsimul-dsl");
  diagnostics.set(uri, errors.map((error) => new vscode.Diagnostic(new vscode.Range(Math.max(0, error.line - 1), Math.max(0, error.column - 1), Math.max(0, error.line - 1), Math.max(0, error.column)), error.message, error.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning)));
}

export async function openDslCommand(): Promise<void> {
  if (!state.schematicPanel) { vscode.window.showInformationMessage("Abra o Esquemático antes de alternar para DSL."); return; }
  const source = stateToDsl(state.schematicState, state.currentProjectFilePath ? state.currentProjectFilePath.split(/[\\/]/).pop()?.replace(/\.lsproj$/i, "") : "Circuit");
  setDslDocument(await vscode.workspace.openTextDocument({ language: "lasecsimul-dsl", content: source }));
  await vscode.window.showTextDocument(dslDocument!, vscode.ViewColumn.One, false);
}

export async function commitDslCommand(): Promise<boolean> {
  const document = dslDocument ?? (vscode.window.activeTextEditor?.document.languageId === "lasecsimul-dsl" ? vscode.window.activeTextEditor.document : undefined);
  if (!document) { vscode.window.showWarningMessage("Nenhum documento DSL está aberto."); return false; }
  const parsed = parseDsl(document.getText());
  if (!parsed.document) { reportDiagnostics(document.uri, parsed.diagnostics); vscode.window.showErrorMessage("DSL inválida: nenhuma alteração foi aplicada."); return false; }
  const reconciled = reconcileDsl(parsed.document, state.schematicState, state.schematicState.catalog);
  reportDiagnostics(document.uri, [...parsed.diagnostics, ...reconciled.diagnostics]);
  if (!reconciled.state) { vscode.window.showErrorMessage("DSL inválida: nenhuma alteração foi aplicada."); return false; }
  const previous = state.schematicState;
  state.schematicState = { ...previous, components: reconciled.state.components, topology: reconciled.state.topology, selectedComponentIds: [], selectedWireIds: [] };
  // This is a full snapshot, so keep the host's incremental-sync baseline aligned with it.
  state.lastSyncedProjectState = state.schematicState;
  state.schematicPanel?.setDirty(true);
  state.schematicPanel?.postMessage({ version: 1, type: "syncState", project: state.schematicState });
  await rebuildCoreFromSchematicState();
  vscode.window.showInformationMessage("DSL aplicada ao modelo de autoria.");
  return true;
}

export function isDslDocumentOpen(): boolean { return Boolean(dslDocument); }

/** Save/Run use this gate so a textual draft can never silently bypass validation. */
export async function commitOpenDslIfPresent(): Promise<boolean> {
  if (!dslDocument && vscode.window.activeTextEditor?.document.languageId !== "lasecsimul-dsl") return true;
  return commitDslCommand();
}
