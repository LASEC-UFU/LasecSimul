import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { loadUnifiedCatalog, saveRegisteredSources } from "../catalog/UnifiedCatalog";
import { serializeSubcircuitDocument } from "../catalog/subcircuitDocument";
import { validateSubcircuitDocument } from "../catalog/subcircuitValidation";
import { currentLasecSimulLanguage } from "../currentLanguage";
import { state } from "../state";
import { convertTdpsToSubcircuit, parseTdpsSmp } from "./tdpsImporter";

/** Preserva o .smp, grava um novo .lssubcircuit e o registra no catalogo normal. */
export async function importTdpsSmpCommand(options: { refreshCatalog: () => Promise<void> }): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { "TDPS v7.71": ["smp"] },
    title: "Importar projeto TDPS (.smp)",
  });
  const source = picked?.[0];
  if (!source) return;

  let converted;
  try {
    converted = convertTdpsToSubcircuit(parseTdpsSmp(fs.readFileSync(source.fsPath), path.basename(source.fsPath)));
  } catch (error) {
    void vscode.window.showErrorMessage(`Nao foi possivel interpretar o arquivo TDPS: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const validation = validateSubcircuitDocument(converted.document);
  if (validation.errors.length > 0) {
    void vscode.window.showErrorMessage(`A conversao TDPS gerou um documento invalido: ${validation.errors.join(" | ")}`);
    return;
  }

  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(path.dirname(source.fsPath), `${path.basename(source.fsPath, path.extname(source.fsPath))}.lssubcircuit`)),
    filters: { "LasecSimul Subcircuit": ["lssubcircuit"] },
    title: "Salvar conversao TDPS",
  });
  if (!target) return;
  try {
    fs.writeFileSync(target.fsPath, `${JSON.stringify(serializeSubcircuitDocument(converted.document), null, 2)}\n`, "utf8");
    const reportPath = `${target.fsPath}.tdps-report.json`;
    fs.writeFileSync(reportPath, `${JSON.stringify(converted.report, null, 2)}\n`, "utf8");
    if (state.coreClient) await state.coreClient.registerAdhocSubcircuitDefinition(target.fsPath, { replace: true });
    if (state.extensionContext) {
      const extensionPath = state.extensionContext.extensionPath;
      const catalog = loadUnifiedCatalog(extensionPath, currentLasecSimulLanguage());
      const normalized = path.resolve(target.fsPath).toLowerCase();
      const sources = catalog.registeredSources.filter((entry) => !(entry.kind === "subcircuit-file" && path.resolve(entry.filePath).toLowerCase() === normalized));
      sources.push({ id: `tdps-import-${Date.now()}`, kind: "subcircuit-file", filePath: target.fsPath, folderPath: ["Controle de Processos", "TDPS importado"] });
      saveRegisteredSources(extensionPath, sources);
      await options.refreshCatalog();
    }
  } catch (error) {
    void vscode.window.showErrorMessage(`Nao foi possivel salvar/registrar a conversao TDPS: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  void vscode.window.showInformationMessage(
    `TDPS convertido para ${path.basename(target.fsPath)}. Relatorio: ${path.basename(target.fsPath)}.tdps-report.json (${converted.report.unsupported.length} item(ns) sem semantica confirmada).`
  );
}
