import * as vscode from "vscode";
import { canReplaceCurrentProject, openSupportedProjectFile } from "../../project/projectCommands";

export interface SimulideImportCustomEditorOptions {
  extensionUri: vscode.Uri;
  beforeOpen?: () => void;
  resolveExternalDeviceReferences?: (projectDir: string) => Promise<void>;
  openSchematicEditor: (extensionUri: vscode.Uri) => void;
  syncSchematicPanel: () => void;
}

function closeTriggerTab(uri: vscode.Uri, fallbackPanel: vscode.WebviewPanel): void {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputCustom && tab.input.uri.toString() === uri.toString()) {
        void vscode.window.tabGroups.close(tab);
        return;
      }
    }
  }
  setTimeout(() => fallbackPanel.dispose(), 0);
}

/**
 * Editor-gatilho para *.sim1/*.sim2. O arquivo legado nunca vira documento editável do VS Code:
 * a aba é fechada, o circuito é convertido para .lsproj e o pipeline normal do LasecSimul abre
 * o arquivo convertido.
 */
export class SimulideImportCustomEditorProvider
  implements vscode.CustomReadonlyEditorProvider<vscode.CustomDocument> {
  constructor(private readonly options: SimulideImportCustomEditorOptions) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(document: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
    closeTriggerTab(document.uri, webviewPanel);
    if (!(await canReplaceCurrentProject())) return;
    await openSupportedProjectFile(document.uri.fsPath, this.options);
  }
}
