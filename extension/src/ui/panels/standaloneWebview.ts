import * as vscode from "vscode";

/** Move a newly opened tool webview into the same auxiliary VS Code window used by HMI Undock. */
export async function showInAuxiliaryWindow(panel: vscode.WebviewPanel): Promise<boolean> {
  panel.reveal(vscode.ViewColumn.Active, false);
  try {
    await vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow");
    // HMI Undock applies compact chrome after the editor has moved; this produces a real,
    // independently draggable auxiliary window (including across monitors).
    await new Promise((resolve) => setTimeout(resolve, 150));
    const commands = await vscode.commands.getCommands(true);
    if (commands.includes("workbench.action.enableCompactAuxiliaryWindow")) {
      await vscode.commands.executeCommand("workbench.action.enableCompactAuxiliaryWindow");
    }
    return true;
  } catch (error) {
    void vscode.window.showWarningMessage(`Não foi possível desacoplar a janela: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
