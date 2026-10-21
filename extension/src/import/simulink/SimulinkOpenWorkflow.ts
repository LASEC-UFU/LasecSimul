import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { loadBlockLibrary } from "../../catalog/blockLibraryLoader";
import { projectSerializer, state } from "../../state";
import { convertSimulinkFile, defaultLsprojPathForSimulink } from "./SimulinkImporter";
import { formatSimulinkImportReport } from "./SimulinkToLasec";

let importOutput: vscode.OutputChannel | undefined;

function outputChannel(): vscode.OutputChannel {
  importOutput ??= vscode.window.createOutputChannel("LasecSimul: Importação Simulink");
  return importOutput;
}

async function exists(filePath: string): Promise<boolean> {
  try { await fs.access(filePath); return true; } catch { return false; }
}

/** `<nome> (2).lsproj`, `<nome> (3).lsproj`... */
async function nextAvailablePath(preferred: string): Promise<string> {
  const base = preferred.replace(/\.lsproj$/i, "");
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n}).lsproj`;
    if (!(await exists(candidate))) return candidate;
  }
}

async function selectTargetPath(preferredPath: string): Promise<string | undefined | "open-existing"> {
  if (!(await exists(preferredPath))) return preferredPath;
  const openExisting = "Abrir .lsproj existente";
  const replace = "Substituir";
  const createCopy = "Criar cópia";
  const choice = await vscode.window.showWarningMessage(
    `${path.basename(preferredPath)} já existe. O LasecSimul não sobrescreve um projeto convertido sem confirmação.`,
    { modal: true }, openExisting, replace, createCopy);
  if (choice === openExisting) return "open-existing";
  if (choice === replace) return preferredPath;
  if (choice === createCopy) return nextAvailablePath(preferredPath);
  return undefined;
}

/**
 * Converte `.slx`/`.mdl` para `.lsproj` no mesmo diretório (biblioteca equivalente ao Simulink,
 * docs/66) e abre pelo pipeline normal de projeto. O relatório vai para a saída "Importação
 * Simulink"; variáveis do workspace do MATLAB citadas pelos parâmetros ficam no Model Workspace do
 * projeto para o usuário definir.
 */
export async function openSimulinkAsLsproj(
  sourcePath: string,
  extensionPath: string,
  openConvertedProject: (targetPath: string) => Promise<void>,
  editModelWorkspace: () => Promise<void>,
): Promise<void> {
  let conversion;
  try {
    conversion = await convertSimulinkFile(sourcePath, loadBlockLibrary(extensionPath));
  } catch (err) {
    vscode.window.showErrorMessage(`Não foi possível ler o modelo Simulink: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const channel = outputChannel();
  channel.clear();
  channel.appendLine(formatSimulinkImportReport(conversion.report));

  const preferredPath = defaultLsprojPathForSimulink(sourcePath);
  const target = await selectTargetPath(preferredPath);
  if (!target) return;
  if (target === "open-existing") {
    await openConvertedProject(preferredPath);
    return;
  }
  try {
    await projectSerializer.save(target, conversion.project);
  } catch (err) {
    vscode.window.showErrorMessage(`O modelo foi convertido em memória, mas não foi possível gravar o .lsproj: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const report = conversion.report;
  const omitted = report.unsupported.length;
  vscode.window.showInformationMessage(
    `Modelo Simulink convertido para ${path.basename(target)}: ${report.converted} de ${report.blocks} bloco(s)` +
      `${omitted > 0 ? `; ${omitted} sem equivalente omitido(s)` : ""} (relatório na saída "Importação Simulink").`);
  if (omitted > 0 || report.issues.some((issue) => issue.severity !== "info")) channel.show(true);
  await openConvertedProject(target);
  if (report.workspace.length > 0) {
    const define = "Definir variáveis";
    const choice = await vscode.window.showWarningMessage(
      `O modelo usa variáveis do workspace do MATLAB que não ficam no arquivo: ${report.workspace.join(", ")}. Os blocos que as usam só compilam depois de definidas.`,
      define);
    if (choice === define && state.schematicState.modelWorkspace) await editModelWorkspace();
  }
}
