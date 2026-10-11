import * as vscode from "vscode";
import { state } from "../state";
import { IecLanguage, IecProjectAuthoring, IecProjectStore, PouKind, parseIecProject } from "./iecProject";
import {
  addPouToProject,
  insertPouReference,
  updatePouInterface,
  updatePouText,
  updateLdRungs,
  updateFbdNetworks,
  updatePouVariables,
  updateSfcBody,
  updateTaskConfiguration,
  updateProjectData,
  updateProjectRuntimeConfiguration,
} from "./iecEditorWorkspace";
import { IEC_STANDARD_FUNCTIONS, IEC_STANDARD_FUNCTION_BLOCKS } from "./iecStandardLibrary";
import { ldBlockSignature, ldCellId, ldPowerVariable, validateLd } from "./ldLowering";
import { ilContextFor } from "./lowering";
import { validateFbd } from "./fbdLowering";
import { validateSfc } from "./sfcLowering";
import { PLC_SCALAR_TYPES, PlcBuildResult, parsePlcVariableReply, plcWatchVariables, resolvePlcEntryPoint } from "./plcBuild";
import { buildIecProjectForSimulator, loadedPlcArtifactHashByComponentId, loadedPlcTaskIntervalMsByComponentId,
  onPlcBuildFinished, runningPlcInstancesFor, sameFilePath } from "./plcRuntimeBridge";

function nonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

function readProject(document: vscode.TextDocument): IecProjectAuthoring {
  return parseIecProject(JSON.parse(document.getText()));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Resultado de compilação no formato que a Webview mostra (sem o módulo inteiro). */
function buildMessage(result: PlcBuildResult): Record<string, unknown> {
  if (!result.ok) return { type: "build", state: "done", ok: false, diagnostics: result.diagnostics };
  return {
    type: "build",
    state: "done",
    ok: true,
    cached: result.cached,
    durationMs: result.durationMs,
    diagnostics: result.warnings,
    programName: result.module.programName,
    inputs: result.module.exportedIo.filter(io => io.direction === "input").length,
    outputs: result.module.exportedIo.filter(io => io.direction === "output").length,
    taskName: result.entry.taskName,
    taskIntervalMs: result.entry.taskIntervalMs,
    toolchain: result.module.cxxToolchainVersion,
    strucpp: result.module.strucppVersion,
  };
}

export class IecProjectEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = "lasecsimul.iecProjectEditor";

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(IecProjectEditorProvider.viewType, new IecProjectEditorProvider(context.extensionUri), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    });
  }

  constructor(private readonly extensionUri: vscode.Uri) {}

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, "media", "iec-editor");
    panel.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    panel.webview.html = this.html(panel.webview, mediaRoot);
    const post = (message: Record<string, unknown>): void => { void panel.webview.postMessage(message); };

    const publish = (): void => {
      try {
        const project = readProject(document);
        const store = new IecProjectStore(project);
        let entry: Record<string, unknown> | undefined;
        try {
          const resolved = resolvePlcEntryPoint(project);
          entry = {
            pouId: resolved.pou.pouId,
            programInstanceName: resolved.programInstanceName ?? "MAIN_INSTANCE",
            taskName: resolved.taskName ?? "MAIN_TASK",
            taskIntervalMs: resolved.taskIntervalMs,
            taskPriority: Number((project.tasks as Array<Record<string, unknown>>)
              .find(task => task.name === resolved.taskName)?.priority ?? 1),
          };
        } catch { /* projeto sem PROGRAM: a seção de configuração pede um */ }
        // Verificações da norma para o SFC (passo inicial, ligações, qualificadores...), no editor gráfico.
        const sfcProblems = project.pous.filter(pou => pou.implementation.language === "sfc").flatMap(pou =>
          validateSfc(pou).map(item => ({ pouId: pou.pouId, pouName: pou.name, severity: item.severity, message: item.message,
            ...(item.element ? { elementId: item.element.id, elementLabel: item.element.label } : {}),
            ...(item.line ? { line: item.line } : {}) })));
        // LD: verificações por elemento e as interfaces dos blocos (pinos) para o editor.
        const ldPous = project.pous.filter(pou => pou.implementation.language === "ld");
        const ldProblems = ldPous.flatMap(pou => validateLd(pou, ilContextFor(pou, store)).map(item => ({
          pouId: pou.pouId, pouName: pou.name, severity: item.severity, message: item.message,
          ...(item.element ? { elementId: item.element.id, elementLabel: item.element.label } : {}) })));
        const fbdProblems = project.pous.filter(pou => pou.implementation.language === "fbd").flatMap(pou =>
          validateFbd(pou, store).map(item => ({ pouId: pou.pouId, pouName: pou.name, severity: "error", message: item.message,
            elementId: item.nodeId, elementLabel: "FBD" })));
        const blockLibrary: Record<string, unknown> = {};
        if (ldPous.length > 0) {
          const context = ilContextFor(ldPous[0]!, store);
          for (const name of [...Object.keys(IEC_STANDARD_FUNCTION_BLOCKS), ...Object.keys(IEC_STANDARD_FUNCTIONS), ...context.functionBlocks.keys(), ...context.functions.keys()]) {
            const signature = ldBlockSignature(context, name);
            if (signature) blockLibrary[name] = signature;
          }
        }
        post({ type: "project", project, symbols: store.symbols(), diagnostics: store.diagnostics(), entry, scalarTypes: PLC_SCALAR_TYPES,
          graphProblems: [...sfcProblems, ...ldProblems, ...fbdProblems], blockLibrary });
      } catch (error) {
        post({ type: "error", message: errorText(error) });
      }
    };

    const edit = async (updated: IecProjectAuthoring): Promise<void> => {
      parseIecProject(updated);
      const workspaceEdit = new vscode.WorkspaceEdit();
      workspaceEdit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
        JSON.stringify(updated, null, 2) + "\n");
      if (!(await vscode.workspace.applyEdit(workspaceEdit))) throw new Error("VS Code rejected the IEC document edit");
    };

    let compiling = false;
    const compile = async (): Promise<void> => {
      if (compiling) return;
      compiling = true;
      post({ type: "build", state: "running" });
      try {
        if (document.isDirty && !(await document.save())) throw new Error("Salve o projeto IEC antes de compilar.");
        const result = await buildIecProjectForSimulator(document.uri.fsPath);
        if (result.ok && runningPlcInstancesFor(document.uri.fsPath).length > 0 && state.simulationStatus !== "stopped") {
          post({ type: "notice", message: "Compilado. Pare e rode a simulação para carregar o novo programa no CLP." });
        }
      } catch (error) {
        post({ type: "build", state: "done", ok: false, diagnostics: [{ severity: "error", stage: "toolchain", message: errorText(error) }] });
      } finally {
        compiling = false;
      }
    };

    // Monitor: lê as variáveis do programa no CLP do esquemático que usa este projeto.
    let selectedInstanceId: string | undefined;
    let pollInFlight = false;
    const poll = async (): Promise<void> => {
      if (pollInFlight || !panel.visible) return;
      pollInFlight = true;
      try {
        const instances = runningPlcInstancesFor(document.uri.fsPath);
        if (!instances.some(item => item.instanceId === selectedInstanceId)) selectedInstanceId = instances[0]?.instanceId;
        let variables: ReturnType<typeof plcWatchVariables> = [];
        let sfcSteps: Array<{ pouId: string; name: string; qualified: string }> = [];
        const ldCells: Array<{ id: string; qualified: string }> = [];
        let ldPouId: string | undefined;
        try {
          const project = readProject(document);
          const entryPou = resolvePlcEntryPoint(project).pou;
          variables = plcWatchVariables(entryPou, project);
          // LD do programa principal: estado de saída de cada elemento (fluxo de energia).
          if (entryPou.implementation.language === "ld") {
            (entryPou.implementation.rungs ?? []).forEach((rung, rungIndex) => rung.rows.forEach((row, rowIndex) => row.forEach((cell, column) => {
              if (cell && ldCells.length < 400) {
                ldCells.push({ id: ldCellId(rung, rowIndex, column), qualified: `${entryPou.name.toUpperCase()}.${ldPowerVariable(rungIndex, rowIndex, column)}` });
              }
            })));
            ldPouId = entryPou.pouId;
          }
          // SFC do programa principal: atividade (X) e tempo (T) de cada passo.
          if (entryPou.implementation.language === "sfc") {
            sfcSteps = entryPou.implementation.steps.map(step => ({ pouId: entryPou.pouId, name: step.name,
              qualified: `${entryPou.name.toUpperCase()}.__SFC_${step.name.toUpperCase()}` }));
          }
        } catch { /* sem PROGRAM */ }
        const values: Record<string, string> = {};
        const forced: Record<string, boolean> = {};
        const sfc: Record<string, { pouId: string; active: boolean; time: string }> = {};
        const ldPower: Record<string, boolean> = {};
        const errors: Record<string, string> = {};
        const client = state.coreClient;
        if (client && selectedInstanceId) {
          const instanceId = selectedInstanceId;
          await Promise.all(variables.map(async variable => {
            try {
              const reply = parsePlcVariableReply(await client.plcGet(instanceId, variable.qualifiedName));
              values[variable.qualifiedName] = reply.value;
              if (reply.forced) forced[variable.qualifiedName] = true;
            }
            catch (error) { errors[variable.qualifiedName] = errorText(error); }
          }));
          await Promise.all(sfcSteps.map(async step => {
            try {
              const active = parsePlcVariableReply(await client.plcGet(instanceId, `${step.qualified}_X`)).value === "TRUE";
              const time = parsePlcVariableReply(await client.plcGet(instanceId, `${step.qualified}_T`)).value;
              sfc[step.name.toUpperCase()] = { pouId: step.pouId, active, time };
            } catch { /* artefato anterior sem este passo */ }
          }));
          await Promise.all(ldCells.map(async cell => {
            try { ldPower[cell.id] = parsePlcVariableReply(await client.plcGet(instanceId, cell.qualified)).value === "TRUE"; }
            catch { /* artefato anterior sem este elemento */ }
          }));
        }
        post({
          type: "monitor",
          instances,
          selectedInstanceId,
          simulationStatus: state.simulationStatus,
          variables,
          values,
          errors,
          forced,
          sfc,
          ld: ldPouId ? { pouId: ldPouId, power: ldPower } : undefined,
        });
      } finally {
        pollInFlight = false;
      }
    };
    const pollTimer = setInterval(() => { void poll(); }, 300);

    const change = vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.uri.toString() === document.uri.toString()) publish();
    });
    const builds = onPlcBuildFinished((projectPath, result) => {
      if (!sameFilePath(projectPath, document.uri.fsPath)) return;
      post(buildMessage(result));
      if (!result.ok || state.simulationStatus === "stopped") return;
      void (async () => {
        for (const instance of runningPlcInstancesFor(projectPath)) {
          if (loadedPlcArtifactHashByComponentId.get(instance.componentId) === result.module.artifactHash) continue;
          if (loadedPlcTaskIntervalMsByComponentId.get(instance.componentId) !== result.entry.taskIntervalMs) {
            post({ type: "notice", message: "Build concluído. Alteração de período de TASK requer parar e iniciar a simulação." });
            continue;
          }
          try {
            await state.coreClient?.loadPlcArtifact(instance.instanceId, result.module);
            loadedPlcArtifactHashByComponentId.set(instance.componentId, result.module.artifactHash);
            post({ type: "notice", message: `Programa recarregado em execução no bloco ${instance.label}.` });
          } catch (error) {
            post({ type: "notice", message: `Build concluído, mas o hot reload do bloco ${instance.label} falhou: ${errorText(error)}` });
          }
        }
      })();
    });
    panel.onDidDispose(() => { change.dispose(); builds.dispose(); clearInterval(pollTimer); });

    // Edições e compilação em fila: o texto enviado junto com o clique em Compilar entra no
    // documento antes do save que precede a compilação. Monitor não espera a fila.
    let queue: Promise<void> = Promise.resolve();
    panel.webview.onDidReceiveMessage(message => {
      const type = message?.type;
      if (type === "selectInstance" || type === "monitorWrite" || type === "monitorReset") { void handle(message); return; }
      queue = queue.then(() => handle(message));
    });
    const handle = async (message: Record<string, unknown> & { type?: string }): Promise<void> => {
      try {
        const type = message?.type;
        if (type === "ready") { publish(); void poll(); return; }
        if (type === "compile") { await compile(); return; }
        if (type === "selectInstance") { selectedInstanceId = String(message.instanceId ?? ""); void poll(); return; }
        if (type === "monitorWrite" || type === "monitorReset") {
          const client = state.coreClient;
          const instanceId = String(message.instanceId ?? "");
          if (!client || !instanceId) throw new Error("Nenhum CLP rodando com este projeto.");
          if (type === "monitorReset" && message.mode === "warm") await client.plcWarmReset(instanceId);
          else if (type === "monitorReset") await client.plcReset(instanceId);
          else {
            const name = String(message.qualifiedName ?? "");
            const value = String(message.value ?? "");
            if (message.mode === "force") await client.plcForce(instanceId, name, value);
            else if (message.mode === "unforce") await client.plcUnforce(instanceId, name);
            else await client.plcSet(instanceId, name, value);
          }
          void poll();
          return;
        }
        const project = readProject(document);
        let updated: IecProjectAuthoring;
        if (type === "addPou") updated = addPouToProject(project, String(message.name ?? ""), message.kind as PouKind, message.language as IecLanguage);
        else if (type === "insertReference") updated = insertPouReference(project, String(message.callerPouId), String(message.targetPouId));
        else if (type === "updateText") updated = updatePouText(project, String(message.pouId), String(message.text ?? ""));
        else if (type === "updateInterface") updated = updatePouInterface(project, String(message.pouId), message.value);
        else if (type === "updateVariables") updated = updatePouVariables(project, String(message.pouId), message.variables);
        else if (type === "updateSfc") updated = updateSfcBody(project, String(message.pouId), message.body);
        else if (type === "updateLd") updated = updateLdRungs(project, String(message.pouId), message.rungs);
        else if (type === "updateFbd") updated = updateFbdNetworks(project, String(message.pouId), message.networks);
        else if (type === "updateTask") {
          updated = updateTaskConfiguration(project,
            { name: String(message.taskName ?? ""), intervalMs: Number(message.intervalMs), priority: Number(message.priority ?? 1),
              ...(typeof message.eventVariable === "string" && message.eventVariable ? { eventVariable: message.eventVariable } : {}) },
            { name: String(message.instanceName ?? ""), pouId: String(message.pouId ?? "") });
        } else if (type === "updateProjectData") updated = updateProjectData(project, message.dataTypes, message.globalVariableLists);
        else if (type === "updateProjectRuntimeConfiguration") updated = updateProjectRuntimeConfiguration(project, message.configuration);
        else return;
        await edit(updated);
      } catch (error) {
        post({ type: "notice", message: errorText(error), error: true });
        publish();
      }
    };
  }

  private html(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
    const token = nonce();
    const script = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "editor.js"));
    const sfcScript = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "sfc.js"));
    const ldScript = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "ld.js"));
    const fbdScript = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "fbd.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "editor.css"));
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${token}';">
<link rel="stylesheet" href="${style}"></head>
<body>
<header id="toolbar">
  <button id="compile" class="primary" title="Compilar o programa (ST -> C++ -> executável do CLP)">Compilar</button>
  <span id="status" class="status">Ainda não compilado</span>
  <span id="notice" class="notice"></span>
</header>
<div id="layout">
  <aside class="pane" id="left">
    <h2>POUs</h2><div id="explorer"></div>
    <div id="add" class="row"></div>
    <h2>Configuração</h2><div id="configuration"></div>
  </aside>
  <main class="pane" id="center">
    <div id="editor"></div>
    <h2>Problemas</h2><div id="problems" class="problems"><span class="muted">Nenhum.</span></div>
  </main>
  <aside class="pane" id="right">
    <h2>Monitor do CLP</h2><div id="monitor"></div>
    <h2>Blocos</h2><input id="search" placeholder="Procurar POU"/><div id="browser"></div>
  </aside>
</div>
<script nonce="${token}" src="${sfcScript}"></script>
<script nonce="${token}" src="${ldScript}"></script>
<script nonce="${token}" src="${fbdScript}"></script>
<script nonce="${token}" src="${script}"></script>
</body></html>`;
  }
}
