import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { openOpenPlcProject, openPlcHostForExtension } from "./openplc/OpenPlcEditorProvider";
import { LSPLC_EXTENSION, bundleFromRaw, isLsplcFile, readLsplc, rawProjectFiles, writeLsplc } from "./openplc/lsplcFile";
import { OpenPlcLanguage, openPlcWorkspaceAvailable } from "./openplc/openPlcHost";
import { state } from "../state";

/** Nome IEC do projeto a partir do nome do arquivo (o project.json do OpenPLC guarda o nome). */
function projectName(file: string): string {
  return path.basename(file, path.extname(file)).replace(/[^A-Za-z0-9_]/g, "_") || "plc_project";
}

function requireEditor(): boolean {
  const extensionPath = state.extensionContext?.extensionPath;
  if (extensionPath && openPlcWorkspaceAvailable(extensionPath)) return true;
  void vscode.window.showErrorMessage("O editor PLC não está empacotado nesta instalação (rode `node scripts/build-openplc-workspace.js`).");
  return false;
}

/**
 * Projeto PLC novo: um arquivo `.lsplc`, o mesmo para as cinco linguagens, criado pelo mesmo
 * serviço do assistente "New Project" do OpenPLC, com DI0/DO0 já declarados no programa `main`.
 */
export async function newIecProjectCommand(
  componentId?: string,
  onProjectCreated?: (componentId: string, absolutePath: string) => Promise<void>,
): Promise<void> {
  if (!requireEditor()) return;
  const language = await vscode.window.showQuickPick([
    { label: "LD (Ladder Diagram)", description: "Diagrama Ladder", value: "ld" as const },
    { label: "FBD (Function Block Diagram)", description: "Diagrama de Blocos Funcionais", value: "fbd" as const },
    { label: "ST (Structured Text)", description: "Texto Estruturado", value: "st" as const },
    { label: "IL (Instruction List)", description: "Lista de Instruções", value: "il" as const },
    { label: "SFC (Sequential Function Chart)", description: "Gráfico Sequencial de Funções", value: "sfc" as const },
  ], { title: "Linguagem do programa principal (main)" });
  if (!language) return;
  const selected = await vscode.window.showSaveDialog({
    filters: { "Projeto PLC LasecSimul": [LSPLC_EXTENSION.slice(1)] },
    saveLabel: "Criar projeto PLC",
    title: "Novo projeto PLC",
  });
  if (!selected) return;
  const file = isLsplcFile(selected.fsPath) ? selected.fsPath : `${selected.fsPath}${LSPLC_EXTENSION}`;
  await createLsplcProject(file, language.value);
  if (componentId && onProjectCreated) await onProjectCreated(componentId, file);
  await openOpenPlcProject(file);
}

export async function createLsplcProject(file: string, language: OpenPlcLanguage): Promise<void> {
  const raw = openPlcHostForExtension().newProjectFiles({
    name: projectName(file),
    language,
    io: [
      { name: "DI0", direction: "input", type: "BOOL" },
      { name: "DO0", direction: "output", type: "BOOL" },
    ],
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeLsplc(file, bundleFromRaw(raw));
}

/** Projeto do OpenPLC Editor original (pasta com project.json) -> arquivo .lsplc. */
export async function importOpenPlcProjectCommand(target?: vscode.Uri): Promise<void> {
  if (!requireEditor()) return;
  const picked = target ? [target] : await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: true,
    canSelectMany: false,
    filters: { "Projeto do OpenPLC Editor (project.json)": ["json"] },
    title: "Importar projeto do OpenPLC Editor (pasta ou project.json)",
  });
  const chosen = picked?.[0]?.fsPath;
  if (!chosen) return;
  const folder = path.basename(chosen).toLowerCase() === "project.json" ? path.dirname(chosen) : chosen;
  if (!fs.existsSync(path.join(folder, "project.json"))) {
    void vscode.window.showErrorMessage(`Não é um projeto do OpenPLC Editor (sem project.json): ${folder}`);
    return;
  }
  const destination = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(path.dirname(folder), `${path.basename(folder)}${LSPLC_EXTENSION}`)),
    filters: { "Projeto PLC LasecSimul": [LSPLC_EXTENSION.slice(1)] },
    saveLabel: "Importar",
    title: "Salvar como projeto PLC do LasecSimul",
  });
  if (!destination) return;
  const file = isLsplcFile(destination.fsPath) ? destination.fsPath : `${destination.fsPath}${LSPLC_EXTENSION}`;
  const raw = await openPlcHostForExtension().readFolderProject(folder);
  writeLsplc(file, bundleFromRaw(raw));
  await openOpenPlcProject(file);
}

/** Arquivo .lsplc -> pasta no formato do OpenPLC Editor original (POUs SFC só abrem no LasecSimul). */
export async function exportOpenPlcProjectCommand(target?: vscode.Uri): Promise<void> {
  if (!requireEditor()) return;
  const source = target?.fsPath ?? (await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { "Projeto PLC LasecSimul": [LSPLC_EXTENSION.slice(1)] },
    title: "Projeto PLC a exportar",
  }))?.[0]?.fsPath;
  if (!source) return;
  const folder = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Exportar aqui",
    title: "Pasta vazia para o projeto do OpenPLC Editor",
  });
  const destination = folder?.[0]?.fsPath;
  if (!destination) return;
  if (fs.existsSync(destination) && fs.readdirSync(destination).length > 0) {
    void vscode.window.showErrorMessage(`Escolha uma pasta vazia: ${destination}`);
    return;
  }
  const result = await openPlcHostForExtension().writeFolderProject(destination, rawProjectFiles(destination, readLsplc(source)));
  if (!result.success) void vscode.window.showErrorMessage(`Não foi possível exportar: ${result.error}`);
  else void vscode.window.showInformationMessage(`Projeto exportado para ${destination}`);
}
