import * as vscode from "vscode";
import type { CoreClient } from "../ipc/CoreClient";

type EnvironmentPath = { path: string };
type ResolvedEnvironment = { executable?: { uri?: vscode.Uri } };
type PythonEnvironmentApi = {
  getActiveEnvironmentPath(resource?: vscode.Uri | vscode.WorkspaceFolder): EnvironmentPath;
  resolveEnvironment(environment: EnvironmentPath | string): Promise<ResolvedEnvironment | undefined>;
  onDidChangeActiveEnvironmentPath(listener: (event: { resource?: vscode.Uri | vscode.WorkspaceFolder }) => void): vscode.Disposable;
};

let activeExecutable: string | undefined;
let listenerRegistered = false;

function workspaceResource(): vscode.Uri | vscode.WorkspaceFolder | undefined {
  const document = vscode.window.activeTextEditor?.document;
  if (document?.uri.scheme === "file") return vscode.workspace.getWorkspaceFolder(document.uri) ?? document.uri;
  return vscode.workspace.workspaceFolders?.[0];
}

export async function resolveSelectedPythonExecutable(): Promise<string | undefined> {
  const extension = vscode.extensions.getExtension<{ environments?: PythonEnvironmentApi }>("ms-python.python");
  if (extension) {
    const api = (extension.isActive ? extension.exports : await extension.activate()).environments as PythonEnvironmentApi | undefined;
    const selected = api?.getActiveEnvironmentPath(workspaceResource());
    if (api && selected?.path) {
      const resolved = await api.resolveEnvironment(selected);
      const executable = resolved?.executable?.uri?.fsPath;
      if (executable) return executable;
      throw new Error(`O ambiente Python selecionado não expõe um executável: ${selected.path}`);
    }
  }
  const config = vscode.workspace.getConfiguration("lasecsimul").get<string>("python.executable")
    ?? vscode.workspace.getConfiguration("python").get<string>("defaultInterpreterPath");
  return config?.trim() || undefined;
}

export async function syncPythonInterpreter(client: CoreClient, log: (message: string) => void): Promise<void> {
  try {
    const configuredTimeout = vscode.workspace.getConfiguration("lasecsimul").get<number>("python.stepTimeoutMs", 250);
    const timeoutMs = Number.isFinite(configuredTimeout) ? Math.round(configuredTimeout) : 250;
    await client.setPythonStepTimeoutMs(timeoutMs);
    const executable = await resolveSelectedPythonExecutable();
    if (!executable) {
      log("Python selecionado ainda não foi resolvido; instale/ative ms-python.python ou configure lasecsimul.python.executable.");
      return;
    }
    activeExecutable = executable;
    await client.setPythonExecutable(executable);
  } catch (error) {
    // Uma mudança feita durante RUN fica pendente no host e será reaplicada antes do próximo Run.
    const message = error instanceof Error ? error.message : String(error);
    if (/simulação parada/i.test(message)) {
      log(`Novo interpretador Python pendente até a simulação parar: ${activeExecutable ?? message}`);
      return;
    }
    log(`Não foi possível selecionar o interpretador Python: ${message}`);
  }
}

export function watchPythonInterpreterChanges(
  context: vscode.ExtensionContext,
  getClient: () => CoreClient | undefined,
  log: (message: string) => void,
): void {
  if (listenerRegistered) return;
  listenerRegistered = true;
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration("lasecsimul.python.executable") &&
        !event.affectsConfiguration("lasecsimul.python.stepTimeoutMs") &&
        !event.affectsConfiguration("python.defaultInterpreterPath")) return;
    const client = getClient();
    if (client) void syncPythonInterpreter(client, log);
  }));
  const extension = vscode.extensions.getExtension<{ environments?: PythonEnvironmentApi }>("ms-python.python");
  if (!extension) {
    log("A extensão Python do VS Code não está instalada; use a configuração lasecsimul.python.executable como fallback.");
    return;
  }
  void (async () => {
    try {
      const exports = extension.isActive ? extension.exports : await extension.activate();
      const api = exports.environments as PythonEnvironmentApi | undefined;
      if (!api) throw new Error("A extensão Python não disponibilizou a API pública de ambientes.");
      context.subscriptions.push(api.onDidChangeActiveEnvironmentPath((event) => {
        const resource = event.resource;
        if (resource) {
          const changedFolder = "uri" in resource ? resource : vscode.workspace.getWorkspaceFolder(resource);
          const uri = changedFolder?.uri ?? ("uri" in resource ? resource.uri : resource);
          if (uri.scheme !== "file") return;
          const active = workspaceResource();
          const activeFolder = active && ("uri" in active ? active : vscode.workspace.getWorkspaceFolder(active));
          if (changedFolder && activeFolder && changedFolder.uri.toString() !== activeFolder.uri.toString()) return;
        }
        const client = getClient();
        if (client) void syncPythonInterpreter(client, log);
      }));
    } catch (error) {
      log(`Não foi possível acompanhar mudanças do Python ativo: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();
}

