import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { projectSerializer, state } from "../../state";
import {
  convertSimulideFile,
  defaultLsprojPathForSimulide,
  nextAvailableImportedLsprojPath,
} from "./SimulideImporter";
import { formatSimulideImportReport, shortSimulideImportSummary } from "./SimulideImportReport";
import { hasImportErrors } from "./SimulideTypes";

let importOutput: vscode.OutputChannel | undefined;

function outputChannel(): vscode.OutputChannel {
  importOutput ??= vscode.window.createOutputChannel("LasecSimul: Importação SimulIDE");
  return importOutput;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function selectTargetPath(preferredPath: string): Promise<string | undefined | "open-existing"> {
  if (!(await exists(preferredPath))) return preferredPath;

  const openExisting = "Abrir .lsproj existente";
  const replace = "Substituir";
  const createCopy = "Criar cópia";
  const choice = await vscode.window.showWarningMessage(
    `${path.basename(preferredPath)} já existe. O LasecSimul não sobrescreve um projeto convertido sem confirmação.`,
    { modal: true },
    openExisting,
    replace,
    createCopy
  );

  if (choice === openExisting) return "open-existing";
  if (choice === replace) return preferredPath;
  if (choice === createCopy) return nextAvailableImportedLsprojPath(preferredPath);
  return undefined;
}

/**
 * Converte .sim1/.sim2, grava .lsproj no mesmo diretório e delega a abertura ao pipeline normal.
 * openConvertedProject normalmente é um closure chamando openProjectFile(targetPath, options).
 */
export async function openSimulideAsLsproj(
  sourcePath: string,
  openConvertedProject: (targetPath: string) => Promise<void>
): Promise<void> {
  // O catálogo final contém package.simulidePaint.source.className e aliases de pinos. Esperamos a
  // carga inicial para não classificar como "não suportado" um tipo que ainda estava chegando.
  await state.catalogReadyPromise?.catch(() => undefined);

  let conversion;
  try {
    conversion = await convertSimulideFile(sourcePath, state.schematicState.catalog);
  } catch (err) {
    vscode.window.showErrorMessage(
      `Não foi possível interpretar o circuito SimulIDE: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  const channel = outputChannel();
  channel.clear();
  channel.appendLine(formatSimulideImportReport(conversion.report));

  if (hasImportErrors(conversion.report)) {
    channel.show(true);
    vscode.window.showErrorMessage(
      `A conversão encontrou uma falha fatal que não pôde ser preservada. ${shortSimulideImportSummary(conversion.report)}`
    );
    return;
  }

  const preferredPath = defaultLsprojPathForSimulide(sourcePath);
  const targetDecision = await selectTargetPath(preferredPath);
  if (!targetDecision) return;
  if (targetDecision === "open-existing") {
    await openConvertedProject(preferredPath);
    return;
  }

  try {
    await projectSerializer.save(targetDecision, conversion.project);
  } catch (err) {
    vscode.window.showErrorMessage(
      `O circuito foi convertido em memória, mas não foi possível gravar o .lsproj: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  const warningCount = conversion.report.issues.filter((issue) => issue.severity === "warning").length;
  const placeholders = conversion.report.placeholderComponentCount;
  vscode.window.showInformationMessage(
    `Circuito SimulIDE convertido para ${targetDecision}` +
      `${placeholders > 0 ? `; ${placeholders} componente(s) preservado(s) como placeholder` : ""}` +
      `${warningCount > 0 ? ` (${warningCount} aviso(s); veja a saída de importação)` : ""}.`
  );
  if (warningCount > 0) channel.show(true);
  await openConvertedProject(targetDecision);
}
