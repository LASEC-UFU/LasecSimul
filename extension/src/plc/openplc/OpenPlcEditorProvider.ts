/*
 * Editor PLC do LasecSimul: o frontend do OpenPLC Editor v4.2.8 (explorer, abas, LD/FBD com React
 * Flow, ST/IL com Monaco + LSP da STruC++, SFC do LasecSimul, variáveis, biblioteca, console) numa
 * aba do VS Code.
 *
 * A Webview (media/openplc-workspace/webview) fala pelo `window.bridge` do OpenPLC; aqui cada
 * chamada vai para os serviços do próprio OpenPLC (pacote do host) ou para o LasecSimul
 * (compilar no Core, recarregar o CLP em execução). O documento é o arquivo .lsplc do projeto
 * (lsplcFile.ts), o mesmo para as cinco linguagens; salvar/sujo/reverter seguem o ciclo do VS Code.
 */

import * as vscode from "vscode";
import { recentSimulationLog } from "../../diagnostics/simulationLog";
import { state } from "../../state";
import { PLC_SCALAR_TYPES, PlcBuildResult, parsePlcVariableReply } from "../plcBuild";
import { hotReloadRunningPlcs, notifyPlcBuildFinished, plcBuildOptions, runningPlcInstancesFor, sameFilePath } from "../plcRuntimeBridge";
import { buildOpenPlcProject } from "./openPlcBuild";
import { driverMonitorVariablesForBinary } from "./openPlcDebug";
import { LsplcBundle, LsplcWrite, applyWrite, rawProjectFiles, readLsplc, readVirtualFile, virtualRelativePath, writeLsplc, writeVirtualFile } from "./lsplcFile";
import { OpenPlcHost, OpenPlcProjectData, loadLsplcProject, loadOpenPlcHost, openPlcWorkspaceAvailable, openPlcWorkspaceDir } from "./openPlcHost";

function nonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Respostas atravessam o postMessage como JSON (Error vira texto). */
function jsonSafe(value: unknown): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value, (_key, item) => item instanceof Error ? item.message : item));
}

function themeName(): "dark" | "light" {
  const kind = vscode.window.activeColorTheme.kind;
  return kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast ? "dark" : "light";
}

class OpenPlcDocument implements vscode.CustomDocument {
  constructor(readonly uri: vscode.Uri) {}
  /** O arquivo .lsplc do projeto. */
  get file(): string {
    return this.uri.fsPath;
  }
  dispose(): void { /* nada a liberar: o estado vive na sessão da Webview */ }
}

interface WebviewMessage {
  type?: string;
  id?: number;
  method?: string;
  args?: unknown[];
}

class OpenPlcSession {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly pendingSaves = new Map<string, (ok: boolean) => void>();
  private saveSequence = 0;
  private compiling = false;
  dirty = false;

  constructor(
    readonly document: OpenPlcDocument,
    readonly panel: vscode.WebviewPanel,
    private readonly host: OpenPlcHost,
    private readonly context: vscode.ExtensionContext,
    private readonly onDirty: (dirty: boolean) => void,
  ) {
    this.disposables.push(panel.webview.onDidReceiveMessage((message: WebviewMessage) => { void this.receive(message); }));
    this.disposables.push(vscode.window.onDidChangeActiveColorTheme(() => this.emit("handleUpdateTheme", [themeName()])));
  }

  dispose(): void {
    for (const resolve of this.pendingSaves.values()) resolve(false);
    this.pendingSaves.clear();
    for (const disposable of this.disposables) disposable.dispose();
  }

  /** Um salvar pedido pelo VS Code ainda não terminou. */
  get saving(): boolean {
    return this.pendingSaves.size > 0;
  }

  emit(method: string, args: unknown[] = []): void {
    void this.panel.webview.postMessage({ type: "openplc:event", method, args: jsonSafe(args) });
  }

  /** Salvar pelo fluxo do próprio OpenPLC (File → Save) e esperar o fim. */
  save(): Promise<boolean> {
    const requestId = `save-${++this.saveSequence}`;
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pendingSaves.delete(requestId); resolve(false); }, 30_000);
      this.pendingSaves.set(requestId, ok => { clearTimeout(timer); resolve(ok); });
      this.emit("lasecSaveRequest", [requestId]);
    });
  }

  /** Última gravação feita pelo próprio editor (salvar, compilar, depurar). */
  private lastOwnWriteMs = 0;

  /** Reverter do VS Code: relê o projeto do disco. Ignora o aviso de "arquivo mudou" que a
   * própria gravação do OpenPLC provoca (senão o editor perderia console e sessão de depuração). */
  reload(): void {
    if (Date.now() - this.lastOwnWriteMs < 5000) return;
    this.emit("lasecReloadProject");
  }

  private async receive(message: WebviewMessage): Promise<void> {
    if (message?.type === "openplc:notify") {
      this.notify(String(message.method ?? ""), Array.isArray(message.args) ? message.args : []);
      return;
    }
    if (message?.type !== "openplc:invoke" || typeof message.id !== "number") return;
    const id = message.id;
    try {
      const value = await this.invoke(String(message.method ?? ""), Array.isArray(message.args) ? message.args : []);
      void this.panel.webview.postMessage({ type: "openplc:result", id, ok: true, value: jsonSafe(value) });
    } catch (error) {
      void this.panel.webview.postMessage({ type: "openplc:result", id, ok: false, error: errorText(error) });
    }
  }

  private notify(method: string, args: unknown[]): void {
    switch (method) {
      case "lasecDirty":
        this.dirty = args[0] === true;
        this.onDirty(this.dirty);
        return;
      case "lasecSaveDone": {
        const resolve = this.pendingSaves.get(String(args[0]));
        this.pendingSaves.delete(String(args[0]));
        resolve?.(args[1] === true);
        return;
      }
      case "setStoreValue":
        void this.context.globalState.update(`openplc.store.${String(args[0])}`, args[1]);
        return;
      case "closeEditor":
        this.panel.dispose();
        return;
      case "log":
        if (args[0] === "error") console.error(`[OpenPLC] ${String(args[1])}`);
        return;
      default:
        return;
    }
  }

  /** Caminho virtual do editor -> caminho dentro do .lsplc (recusa o que estiver fora). */
  private relativeInProject(candidate: unknown): string {
    const value = typeof candidate === "string" ? candidate : "";
    const relative = value ? virtualRelativePath(this.document.file, value) : undefined;
    if (relative === undefined) throw new Error(`Este editor só acessa o projeto ${this.document.file}.`);
    return relative;
  }

  /** Lê o .lsplc do disco, aplica a mudança e grava (o aviso de arquivo alterado que isso provoca é ignorado). */
  private updateBundle(change: (bundle: LsplcBundle) => LsplcBundle): void {
    this.lastOwnWriteMs = Date.now();
    writeLsplc(this.document.file, change(readLsplc(this.document.file)));
    this.lastOwnWriteMs = Date.now();
  }

  private async invoke(method: string, args: unknown[]): Promise<unknown> {
    const { host } = this;
    switch (method) {
      case "lasecHello":
        return { projectPath: this.document.file };
      // ----- projeto (.lsplc: os arquivos do projeto OpenPLC dentro de um arquivo só) -----
      case "readProjectFiles": {
        if (this.relativeInProject(args[0]) !== "") throw new Error("Caminho de projeto inesperado.");
        return { success: true, data: rawProjectFiles(this.document.file, readLsplc(this.document.file)) };
      }
      case "writeProjectFiles": {
        const files = (args[0] ?? {}) as LsplcWrite & { projectPath?: string };
        if (this.relativeInProject(files.projectPath) !== "") throw new Error("Caminho de projeto inesperado.");
        const relatives = [...(files.pouFiles ?? []), ...(files.serverFiles ?? []), ...(files.remoteDeviceFiles ?? [])]
          .map(entry => entry.relativePath).concat(files.deletions ?? []);
        if (relatives.some(relative => relative.replace(/\\/g, "/").split("/").includes(".."))) throw new Error("Caminho fora do projeto.");
        this.updateBundle(bundle => applyWrite(bundle, files));
        return { success: true };
      }
      case "saveFile": {
        const relative = this.relativeInProject(args[0]);
        if (!relative) throw new Error("Caminho de arquivo inesperado.");
        this.updateBundle(bundle => writeVirtualFile(bundle, relative, String(args[1] ?? "")));
        return { success: true };
      }
      case "fileReadContent": {
        const relative = this.relativeInProject(args[0]);
        const content = readVirtualFile(readLsplc(this.document.file), relative);
        return content === undefined ? { success: false, error: `Arquivo não encontrado: ${relative}` } : { success: true, content };
      }
      // O OpenPLC cria, renomeia e apaga POUs na memória e grava tudo no salvar seguinte; estes
      // caminhos de arquivo isolado ficam por compatibilidade.
      case "createPouFile":
        return { success: true };
      case "deletePouFile": {
        const relative = this.relativeInProject(args[0]);
        this.updateBundle(bundle => applyWrite(bundle, { projectJson: JSON.stringify(bundle.project), deletions: [relative] }));
        return { success: true };
      }
      case "renamePouFile":
        return { success: true };
      case "fileWatchStart":
      case "fileWatchStop":
      case "fileWatchStopAll":
        return { success: true };
      case "retrieveRecent":
        return [];
      case "removeProjectFromRecent":
        return { success: true };
      case "deleteProject":
        return { success: false, error: "Apague o arquivo .lsplc pelo Explorer do VS Code." };
      case "createProject":
      case "openProject":
        return { success: false, error: { title: "LasecSimul", description: "Use o comando \"LasecSimul: Novo projeto PLC\"." } };
      case "pathPicker":
      case "openPathPicker":
        return { success: false, error: { title: "LasecSimul", description: "O projeto PLC é um arquivo .lsplc." } };
      // ----- bibliotecas -----
      case "loadAllLibraries":
        return host.libraries.loadAll();
      case "listInstalledLibraries":
        return host.libraries.listInstalled();
      case "installLibraryFromFile": {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          title: "Install Library",
          filters: { "Library files": ["stlib", "lib", "library"] },
        });
        if (!picked?.[0]) return { success: true, canceled: true };
        const result = await host.libraries.installFromFile(picked[0].fsPath);
        if (result.success) this.emit("onLibrariesChanged");
        return result;
      }
      case "uninstallLibrary": {
        const result = host.libraries.uninstall(String(args[0] ?? ""));
        if (result.success) this.emit("onLibrariesChanged");
        return result;
      }
      case "queryPublicCatalog":
        return { success: false, error: "Catálogo público de bibliotecas não disponível no LasecSimul." };
      case "installLibrariesFromCatalog":
        return { results: [] };
      // ----- sistema / tema -----
      case "getSystemInfo":
        return { OS: process.platform, architecture: process.arch === "arm64" ? "arm" : "x64", prefersDarkMode: themeName() === "dark", isWindowMaximized: false };
      case "getStoreValue":
        return this.context.globalState.get(`openplc.store.${String(args[0])}`);
      case "winGetTheme":
        return themeName();
      case "openExternalLinkAccelerator":
        return { success: await vscode.env.openExternal(vscode.Uri.parse(String(args[0] ?? ""))) };
      // ----- LasecSimul -----
      case "lasecCompile":
        return this.compile((args[0] ?? {}) as { compileId?: string; projectData?: OpenPlcProjectData });
      // ----- "runtime" do OpenPLC = simulação do LasecSimul (Play/Stop da barra do OpenPLC) -----
      case "lasecSimulationStatus":
        return { running: state.simulationStatus !== "stopped" };
      case "lasecRunSimulation":
        return this.runSimulation();
      case "lasecStopSimulation":
        await vscode.commands.executeCommand("lasecsimul.stop");
        return { success: true };
      case "lasecSimulationLog":
        // Aba "PLC Logs" do OpenPLC: o mesmo log do canal "LasecSimul: Simulação".
        return recentSimulationLog(Number(args[0] ?? 0)).map(entry => ({
          id: entry.id,
          timestamp: entry.timestamp,
          level: entry.level === "error" ? "ERROR" : entry.level === "warning" ? "WARNING" : "INFO",
          message: entry.message,
        }));
      // ----- depurador do OpenPLC sobre o CLP da simulação -----
      case "lasecDebugMap":
        return this.debugMap();
      case "lasecDebugConnect":
        return this.debugConnect();
      case "lasecDebugDisconnect":
        this.debugInstanceId = undefined;
        return { success: true };
      case "lasecDebugRead":
        return this.debugRead(Array.isArray(args[0]) ? args[0] as Array<string | null> : []);
      case "lasecSfcState":
        return this.sfcState(String(args[0] ?? ""), Array.isArray(args[1]) ? args[1].map(String) : []);
      case "lasecDebugForce":
        return this.debugForce(String(args[0] ?? ""), args[1] === true, String(args[2] ?? ""));
      default:
        console.warn(`[OpenPLC] chamada sem implementação no LasecSimul: ${method}`);
        return undefined;
    }
  }

  /** Play do OpenPLC: roda a simulação do esquemático aberto, se algum bloco CLP usa este projeto. */
  private async runSimulation(): Promise<{ success: boolean; error?: string }> {
    const usesProject = state.schematicState.components.some(component => component.typeId === "plc.instance" &&
      !!component.plc?.iecProjectRef && sameFilePath(component.plc.iecProjectRef, this.document.uri.fsPath));
    if (!usesProject) {
      return {
        success: false,
        error: "No PLC block in the open LasecSimul schematic uses this project. Link a \"PLC IEC 61131-3\" block to this project.json first.",
      };
    }
    if (state.simulationStatus === "stopped") await vscode.commands.executeCommand("lasecsimul.run");
    return { success: true };
  }

  private debugInstanceId: string | undefined;
  private debugWatch: ReturnType<typeof setInterval> | undefined;

  /** Variáveis que o CLP do LasecSimul lê e força: a tabela do driver do build atual (escalares do
   * programa, membros de instâncias de FB, campos de struct, elementos de vetor -- openPlcDebug.ts);
   * sem build em cache, as escalares do programa da instância de entrada (VAR_INPUT, VAR_OUTPUT e VAR). */
  private async debugMap(): Promise<{ success: boolean; variables?: Array<{ path: string; qualifiedName: string; type: string }>; error?: string }> {
    try {
      const project = loadLsplcProject(this.host, this.document.file);
      const entry = this.host.entryPoint(project.data);
      const program = project.data.pous.find(pou => pou.pouType === "program" && pou.name === entry.programName);
      const instance = (entry.instanceName ?? entry.programName).toUpperCase();
      const built = await buildOpenPlcProject(this.document.file, { ...plcBuildOptions({ cacheOnly: true }), host: this.host });
      const fromDriver = built.ok ? driverMonitorVariablesForBinary(built.module.nativeBinaryRef) : [];
      if (fromDriver.length > 0) {
        return {
          success: true,
          variables: fromDriver.map(variable => ({
            path: `${instance}.${variable.name}`,
            qualifiedName: `${entry.programName.toUpperCase()}.${variable.name}`,
            type: variable.type,
          })),
        };
      }
      const variables = ((program?.interface?.variables ?? []) as Array<{ name: string; class?: string; type?: { definition?: string; value?: string } }>)
        .filter(variable => ["input", "output", "local"].includes(String(variable.class ?? "local")) &&
          variable.type?.definition === "base-type" && PLC_SCALAR_TYPES.includes(String(variable.type.value).toUpperCase()))
        .map(variable => ({
          path: `${instance}.${variable.name.toUpperCase()}`,
          qualifiedName: `${entry.programName.toUpperCase()}.${variable.name.toUpperCase()}`,
          type: String(variable.type?.value).toUpperCase(),
        }));
      return { success: true, variables };
    } catch (error) {
      return { success: false, error: errorText(error) };
    }
  }

  private debugConnect(): { success: boolean; error?: string } {
    const instance = runningPlcInstancesFor(this.document.uri.fsPath)[0];
    if (!instance || state.simulationStatus === "stopped") {
      return {
        success: false,
        error: "No PLC block is running this project. Place a \"PLC IEC 61131-3\" block in the LasecSimul schematic, link it to this project.json and run the simulation.",
      };
    }
    this.debugInstanceId = instance.instanceId;
    if (!this.debugWatch) {
      // Simulação parou ou o bloco saiu do Core: solta o bloco antigo. A sessão do OpenPLC continua
      // aberta (valores ficam "velhos") e debugRead reata quando a simulação voltar.
      this.debugWatch = setInterval(() => {
        if (!this.debugInstanceId) return;
        const alive = state.simulationStatus !== "stopped" &&
          runningPlcInstancesFor(this.document.uri.fsPath).some(item => item.instanceId === this.debugInstanceId);
        if (!alive) this.debugInstanceId = undefined;
      }, 500);
      this.disposables.push({ dispose: () => { if (this.debugWatch) clearInterval(this.debugWatch); } });
    }
    return { success: true };
  }

  private async debugRead(names: Array<string | null>): Promise<{ success: boolean; values?: Array<string | null>; error?: string; needsReconnect?: boolean }> {
    const client = state.coreClient;
    // Simulação parada e rodada de novo com o depurador aberto: reata no bloco novo (o OpenPLC só
    // marca os valores como velhos enquanto não há resposta).
    if (!this.debugInstanceId && state.simulationStatus !== "stopped") {
      this.debugInstanceId = runningPlcInstancesFor(this.document.uri.fsPath)[0]?.instanceId;
    }
    const instanceId = this.debugInstanceId;
    if (!client || !instanceId) return { success: false, error: "PLC not running", needsReconnect: true };
    const values = await Promise.all(names.map(async name => {
      if (!name) return null;
      try { return parsePlcVariableReply(await client.plcGet(instanceId, name)).value; }
      catch { return null; }
    }));
    return { success: true, values };
  }

  /** Passos de um POU SFC no CLP da simulação: `PROGRAMA.__SFC_<PASSO>_X` e `_T` (sfcLowering.ts).
   * Só o programa da instância de entrada tem nome direto no CLP. */
  private async sfcState(pouName: string, steps: string[]): Promise<{ states: Record<string, { active: boolean; time?: string }> }> {
    const client = state.coreClient;
    const instance = runningPlcInstancesFor(this.document.uri.fsPath)[0];
    if (!client || !instance || state.simulationStatus === "stopped" || steps.length === 0) return { states: {} };
    let program: string;
    try {
      program = this.host.entryPoint(loadLsplcProject(this.host, this.document.file).data).programName;
    } catch {
      return { states: {} };
    }
    if (program.toUpperCase() !== pouName.toUpperCase()) return { states: {} };
    const states: Record<string, { active: boolean; time?: string }> = {};
    await Promise.all(steps.map(async step => {
      const base = `${program.toUpperCase()}.__SFC_${step.toUpperCase()}`;
      try {
        const active = parsePlcVariableReply(await client.plcGet(instance.instanceId, `${base}_X`)).value.toUpperCase() === "TRUE";
        const time = active ? parsePlcVariableReply(await client.plcGet(instance.instanceId, `${base}_T`)).value : undefined;
        states[step.toUpperCase()] = { active, ...(time ? { time } : {}) };
      } catch { /* módulo antigo, sem este passo */ }
    }));
    return { states };
  }

  private async debugForce(name: string, force: boolean, value: string): Promise<{ success: boolean; error?: string }> {
    const client = state.coreClient;
    const instanceId = this.debugInstanceId;
    if (!client || !instanceId) return { success: false, error: "PLC not running" };
    try {
      if (force) await client.plcForce(instanceId, name, value);
      else await client.plcUnforce(instanceId, name);
      return { success: true };
    } catch (error) {
      return { success: false, error: errorText(error) };
    }
  }

  private async compile(request: { compileId?: string; projectData?: OpenPlcProjectData }): Promise<{ success: boolean; error?: string }> {
    const compileId = request.compileId ?? "";
    const progress = (event: { stage: string; message: string; level: string }): void =>
      this.emit("lasecCompileProgress", [compileId, event]);
    if (this.compiling) return { success: false, error: "Uma compilação já está em andamento." };
    this.compiling = true;
    try {
      const projectRef = this.document.uri.fsPath;
      const result: PlcBuildResult = await buildOpenPlcProject(projectRef, {
        ...plcBuildOptions(),
        host: this.host,
        ...(request.projectData ? { projectData: request.projectData } : {}),
        progress,
      });
      notifyPlcBuildFinished(projectRef, result);
      if (!result.ok) {
        const first = result.diagnostics.find(item => item.severity === "error");
        return { success: false, error: first ? first.message : "Compilation failed" };
      }
      for (const notice of await hotReloadRunningPlcs(projectRef, result)) progress({ stage: "done", message: notice, level: "info" });
      return { success: true };
    } catch (error) {
      progress({ stage: "error", message: errorText(error), level: "error" });
      return { success: false, error: errorText(error) };
    } finally {
      this.compiling = false;
    }
  }
}

export class OpenPlcEditorProvider implements vscode.CustomEditorProvider<OpenPlcDocument> {
  static readonly viewType = "lasecsimul.openplcEditor";

  private readonly changes = new vscode.EventEmitter<vscode.CustomDocumentContentChangeEvent<OpenPlcDocument>>();
  readonly onDidChangeCustomDocument = this.changes.event;
  private readonly sessions = new Map<string, OpenPlcSession>();

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(OpenPlcEditorProvider.viewType, new OpenPlcEditorProvider(context), {
      webviewOptions: { retainContextWhenHidden: true, enableFindWidget: false },
      supportsMultipleEditorsPerDocument: false,
    });
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri): OpenPlcDocument {
    return new OpenPlcDocument(uri);
  }

  async resolveCustomEditor(document: OpenPlcDocument, panel: vscode.WebviewPanel): Promise<void> {
    const extensionPath = this.context.extensionPath;
    const root = vscode.Uri.file(openPlcWorkspaceDir(extensionPath));
    panel.webview.options = { enableScripts: true, localResourceRoots: [root] };
    if (!openPlcWorkspaceAvailable(extensionPath)) {
      panel.webview.html = this.unavailableHtml();
      return;
    }
    let host: OpenPlcHost;
    try {
      host = loadOpenPlcHost({
        extensionPath,
        storageDir: this.context.globalStorageUri.fsPath,
        toolchain: plcBuildOptions().toolchain,
      });
    } catch (error) {
      panel.webview.html = this.unavailableHtml(errorText(error));
      return;
    }
    const key = document.uri.toString();
    const session = new OpenPlcSession(document, panel, host, this.context, dirty => {
      if (dirty) this.changes.fire({ document });
      else if (!session.saving) void this.markClean(document);
    });
    this.sessions.set(key, session);
    panel.onDidDispose(() => {
      session.dispose();
      if (this.sessions.get(key) === session) this.sessions.delete(key);
    });
    panel.webview.html = this.html(panel.webview, root, document.file);
  }

  /** O OpenPLC salvou sozinho (ex.: antes de compilar): tira o "modificado" da aba. */
  private async markClean(document: OpenPlcDocument): Promise<void> {
    const save = (vscode.workspace as unknown as { save?: (uri: vscode.Uri) => Thenable<unknown> }).save;
    const tab = vscode.window.tabGroups.all.flatMap(group => group.tabs)
      .find(item => item.input instanceof vscode.TabInputCustom && item.input.uri.toString() === document.uri.toString());
    if (save && tab?.isDirty) await save(document.uri);
  }

  async saveCustomDocument(document: OpenPlcDocument): Promise<void> {
    const session = this.sessions.get(document.uri.toString());
    if (!session) return;
    if (!(await session.save())) throw new Error("O OpenPLC não conseguiu salvar o projeto.");
  }

  async saveCustomDocumentAs(): Promise<void> {
    throw new Error("Projeto OpenPLC é uma pasta: copie a pasta pelo Explorer para duplicá-lo.");
  }

  async revertCustomDocument(document: OpenPlcDocument): Promise<void> {
    this.sessions.get(document.uri.toString())?.reload();
  }

  async backupCustomDocument(_document: OpenPlcDocument, context: vscode.CustomDocumentBackupContext): Promise<vscode.CustomDocumentBackup> {
    return { id: context.destination.toString(), delete: () => undefined };
  }

  private unavailableHtml(detail?: string): string {
    const text = detail ?? "O editor OpenPLC não está empacotado nesta instalação.";
    return `<!doctype html><html><body style="font-family: var(--vscode-font-family); padding: 24px; color: var(--vscode-foreground)">
<h3>Editor OpenPLC indisponível</h3><p>${text.replace(/[<>&]/g, char => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[char] ?? char))}</p>
<p>Gere o pacote com <code>node scripts/build-openplc-workspace.js</code>.</p></body></html>`;
  }

  private html(webview: vscode.Webview, root: vscode.Uri, projectPath: string): string {
    const scriptNonce = nonce();
    const script = webview.asWebviewUri(vscode.Uri.joinPath(root, "webview", "openplc.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(root, "webview", "openplc.css"));
    const boot = JSON.stringify({ projectPath }).replace(/</g, "\\u003c");
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data: blob:`,
      `font-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${scriptNonce}' ${webview.cspSource}`,
      `worker-src blob: ${webview.cspSource}`,
      `connect-src ${webview.cspSource}`,
    ].join("; ");
    return `<!doctype html>
<html class="h-full ${themeName()}" lang="en" style="color-scheme: ${themeName()}">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${style}" />
<title>OpenPLC</title>
</head>
<body class="h-full">
<div class="h-full bg-neutral-50 text-gray-500 dark:bg-neutral-950 dark:text-gray-400" id="root"></div>
<script nonce="${scriptNonce}">window.__LASECSIMUL_OPENPLC__ = ${boot}; try { localStorage.setItem("theme", "${themeName()}"); } catch {}</script>
<script nonce="${scriptNonce}" src="${script}"></script>
</body>
</html>`;
  }
}

/** project.json de um projeto OpenPLC, aberto no editor OpenPLC. */
/** Abre o projeto PLC (.lsplc) no editor OpenPLC. */
export async function openOpenPlcProject(projectFile: string): Promise<void> {
  await vscode.commands.executeCommand("vscode.openWith", vscode.Uri.file(projectFile), OpenPlcEditorProvider.viewType);
}

export function openPlcHostForExtension(): OpenPlcHost {
  const context = state.extensionContext;
  if (!context) throw new Error("Extensão LasecSimul ainda não foi ativada.");
  return loadOpenPlcHost({
    extensionPath: context.extensionPath,
    storageDir: context.globalStorageUri.fsPath,
    toolchain: plcBuildOptions().toolchain,
  });
}
