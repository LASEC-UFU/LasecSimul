import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { serializeSubcircuitDocument } from "../catalog/subcircuitDocument";
import { validateSubcircuitDocument } from "../catalog/subcircuitValidation";
import { buildStandalonePlantProject } from "../project/plantTemplates";
import { projectSerializer } from "../state";
import { convertTdpsToSubcircuit, parseTdpsSmp } from "./tdpsImporter";

/** `<base>.lsproj` ao lado do `.lssubcircuit`; se já existir, `<base> (2).lsproj`, `(3)`... --
 * nunca sobrescreve um projeto existente. */
function freeProjectPath(directory: string, base: string): string {
  let candidate = path.join(directory, `${base}.lsproj`);
  for (let index = 2; fs.existsSync(candidate); index += 1) candidate = path.join(directory, `${base} (${index}).lsproj`);
  return candidate;
}

/**
 * Preserva o .smp, grava a conversão como `.lssubcircuit` (modelo editável) e um `.lsproj`
 * independente com a planta INCORPORADA. Plantas não são registradas no catálogo/paleta nem no Core
 * global: o projeto gerado abre sozinho e pode ser importado em outro ("Importar Circuito").
 */
export async function importTdpsSmpCommand(): Promise<void> {
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
  let projectPath: string;
  try {
    const manifest = serializeSubcircuitDocument(converted.document);
    fs.writeFileSync(target.fsPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const reportPath = `${target.fsPath}.tdps-report.json`;
    fs.writeFileSync(reportPath, `${JSON.stringify(converted.report, null, 2)}\n`, "utf8");
    const base = path.basename(target.fsPath, path.extname(target.fsPath));
    projectPath = freeProjectPath(path.dirname(target.fsPath), base);
    await projectSerializer.save(projectPath, buildStandalonePlantProject({
      template: { typeId: converted.document.typeId, manifest: path.basename(target.fsPath), project: path.basename(projectPath) },
      manifest,
    }));
  } catch (error) {
    void vscode.window.showErrorMessage(`Nao foi possivel salvar a conversao TDPS: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const open = "Abrir projeto";
  const choice = await vscode.window.showInformationMessage(
    `TDPS convertido para ${path.basename(target.fsPath)} e ${path.basename(projectPath)} (planta incorporada ao projeto). Relatorio: ${path.basename(target.fsPath)}.tdps-report.json (${converted.report.unsupported.length} item(ns) sem semantica confirmada).`,
    open
  );
  if (choice === open) await vscode.commands.executeCommand("vscode.openWith", vscode.Uri.file(projectPath), "lasecsimul.projectEditor");
}
