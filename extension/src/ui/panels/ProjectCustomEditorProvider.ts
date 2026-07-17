import * as vscode from "vscode";
import { canReplaceCurrentProject, openProjectFile } from "../../project/projectCommands";

export interface ProjectCustomEditorOptions {
  extensionUri: vscode.Uri;
  beforeOpen?: () => void;
  resolveExternalDeviceReferences?: (projectDir: string) => Promise<void>;
  openSchematicEditor: (extensionUri: vscode.Uri) => void;
  syncSchematicPanel: () => void;
}

/** Fecha a aba-gatilho pela API de abas (`vscode.window.tabGroups`), NUNCA chamando
 * `webviewPanel.dispose()` diretamente -- achado real 2026-07-17: mesmo adiando o `dispose()` com
 * `setTimeout(0)` (tentativa anterior), o VS Code ainda derrubava com "OverlayWebview has been
 * disposed" -- o problema não era só timing, era descartar o OBJETO `WebviewPanel` que o próprio VS
 * Code ainda está gerenciando internamente pra essa aba. Fechar via `tabGroups.close(tab)` passa
 * pelo MESMO caminho que um clique no "x" da aba usa, então nunca briga com o ciclo de vida interno
 * do editor. Localiza a aba pelo par (URI, tipo `TabInputCustom`) -- não pelo `viewType` bruto do
 * `webviewPanel` porque builds mais antigos do VS Code expõem esse campo com um prefixo interno
 * diferente do `viewType` registrado (`mainThreadWebview-...`), tornando a comparação exata frágil. */
function closeCustomEditorTab(uri: vscode.Uri, fallbackPanel: vscode.WebviewPanel): void {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputCustom && tab.input.uri.toString() === uri.toString()) {
        void vscode.window.tabGroups.close(tab);
        return;
      }
    }
  }
  // Não deveria acontecer (acabamos de ser chamados pra resolver exatamente esta aba), mas evita
  // deixar um webview em branco pra sempre caso a API de abas represente isto de outra forma numa
  // versão futura do VS Code -- último recurso, mesmo risco de "OverlayWebview has been disposed"
  // do dispose direto, só que aqui é estritamente melhor que NUNCA fechar a aba.
  setTimeout(() => fallbackPanel.dispose(), 0);
}

/** Registrado como editor personalizado padrão pra `*.lsproj` (`package.json::contributes.
 * customEditors`, `priority: "default"`) -- sem isto, clicar/dar duplo clique num `.lsproj` no
 * Explorer abria o JSON cru como texto (comportamento padrão do VS Code pra qualquer arquivo sem
 * editor associado). A extensão só suporta UM projeto aberto por vez (`state.schematicPanel` é
 * singleton, ver `SchematicPanel.ts`) -- então esta classe NUNCA usa o `webviewPanel` que o VS Code
 * cria pra aba do double-click como editor de verdade; ela só serve de GATILHO: fecha essa aba e
 * delega pro mesmo pipeline de produção que "Abrir Projeto"/"Abrir Recente" já usam (`openProjectFile`,
 * que valida o arquivo, restaura o circuito completo no Core e mostra erro claro se o projeto estiver
 * inválido ou não puder ser carregado -- nada disso precisou ser reimplementado aqui). Migrar pra um
 * `CustomEditorProvider` "de verdade" (documento próprio, save/undo nativos) seria uma mudança de
 * arquitetura bem maior — ver o mesmo comentário em `SchematicPanel.setDirty` — fora de escopo pro
 * pedido de só abrir direto no editor certo. */
export class ProjectCustomEditorProvider implements vscode.CustomReadonlyEditorProvider<vscode.CustomDocument> {
  constructor(private readonly options: ProjectCustomEditorOptions) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(document: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
    closeCustomEditorTab(document.uri, webviewPanel);
    if (!(await canReplaceCurrentProject())) return;
    await openProjectFile(document.uri.fsPath, this.options);
  }
}
