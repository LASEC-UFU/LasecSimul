import * as vscode from "vscode";
import type { ControlDesignProject } from "../webview/controlDesigner/types";
import type { WebviewComponentModel } from "../webview/model";
import { signalBlockSignature, signalBlockToTransfer } from "../controlDesignerCircuit";
import { certifyAnalyses, type CertificateProgress } from "../webview/controlDesigner/certification";
type Binding = NonNullable<ControlDesignProject["sourceBindings"]>["G"];

const DEFAULT_PROJECT: ControlDesignProject = {
  version: 1, domain: "continuous", sampleTime: 0.1,
  F: { num: "1", den: "1" }, C: { num: "4", den: "1" }, G: { num: "1", den: "1, 2, 0" }, H: { num: "1", den: "1" },
  response: "output", requirements: [], alternatives: [], activeAlternative: "",
};
export class ControlDesignerPanel {
  private static current: vscode.WebviewPanel | undefined;
  private static webviewReady=false;
  private static pendingIdentifiedModel: {label:string;num:number[];den:number[];domain:"continuous"|"discrete";sampleTime:number;stateSpace?:{A:number[][];B:number[];C:number[];D:number;x0?:number[]}} | undefined;
  private static bindingStatuses: Record<string, "current" | "missing" | "changed"> = {};
  private static lastComponents: WebviewComponentModel[] = [];
  static show(
    context: vscode.ExtensionContext,
    initial?: ControlDesignProject,
    onSave?: (project: ControlDesignProject) => void,
    onImport?: (target: "F" | "C" | "G" | "H") => Promise<{ label: string; num: number[]; den: number[]; domain?: "continuous" | "discrete"; sampleTime?: number; stateSpace?: ControlDesignProject["plantStateSpace"]; binding?: Omit<NonNullable<Binding>, "modelSignature"> } | undefined>,
    onApply?: (controller: { num: string; den: string; domain: "continuous" | "discrete"; sampleTime: number }, plant?: NonNullable<ControlDesignProject["plantStateSpace"]>) => Promise<Omit<NonNullable<Binding>, "modelSignature"> | undefined>,
  ): void {
    if (this.current) { this.current.reveal(vscode.ViewColumn.Active); return; }
    const panel = vscode.window.createWebviewPanel("lasecsimul.controlDesigner", "LasecSimul — SisoTools", vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "out-webview")],
    });
    this.current = panel;
    this.webviewReady=false;
    panel.onDidDispose(() => { if (this.current === panel) { this.current = undefined; this.webviewReady=false; } });
    const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "out-webview", "controlDesigner", "main.js"));
    const nonce = String(Date.now());
    panel.webview.html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' ${panel.webview.cspSource}"><title>SisoTools</title></head><body><div id="app"></div><script nonce="${nonce}" type="module" src="${script}"></script></body></html>`;
    panel.webview.onDidReceiveMessage(async (message: { type: string; project?: ControlDesignProject; controller?: { num: string; den: string }; target?: "F" | "C" | "G" | "H"; model?: { num: number[]; den: number[]; domain: "continuous" | "discrete"; sampleTime?: number } }) => {
      if (message.type === "ready") {
        this.webviewReady=true;
        const project = initial ?? context.workspaceState.get<ControlDesignProject>("controlDesignerProject", DEFAULT_PROJECT);
        await panel.webview.postMessage({ type: "init", project });
        if (this.pendingIdentifiedModel) { await panel.webview.postMessage({type:"importedModel",target:"G",model:this.pendingIdentifiedModel,adoptDomain:true}); this.pendingIdentifiedModel=undefined; }
        this.resolveBindingStatuses(project);
        await panel.webview.postMessage({ type: "bindingStatus", statuses: this.bindingStatuses });
      } else if (message.type === "save" && message.project) {
        onSave?.(message.project);
        await context.workspaceState.update("controlDesignerProject", message.project);
        await panel.webview.postMessage({ type: "saved" });
      } else if (message.type === "certify" && message.model) {
        const model = message.model;
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Certificação do SisoTools", cancellable: true }, async (progress, token) => {
          const reportedPhases = new Set<string>();
          const results = await certifyAnalyses(model, {
            timeLimitMs: 10_000, maxSubdivisions: 2048,
            cancelled: () => token.isCancellationRequested,
            onProgress: (value: CertificateProgress) => {
              const firstInPhase = !reportedPhases.has(value.phase); reportedPhases.add(value.phase);
              progress.report({ message: value.message, ...(firstInPhase ? { increment: 32 } : {}) });
            },
          });
          await panel.webview.postMessage({ type: "certificationResult", results, cancelled: token.isCancellationRequested });
        });
      } else if (message.type === "importSelection") {
        const imported = await onImport?.(message.target ?? "G");
        if (imported) await panel.webview.postMessage({ type: "importedModel", model: imported, target: message.target ?? "G" });
      } else if (message.type === "refreshBinding" && message.project && message.target) {
        const binding = message.project.sourceBindings?.[message.target];
        const component = binding && this.lastComponents.find((item) => item.id === binding.componentId);
        if (!binding || !component) {
          await panel.webview.postMessage({ type: "bindingRefreshError", message: "O bloco vinculado não está mais no esquemático." });
        } else if (component.typeId !== binding.typeId) {
          await panel.webview.postMessage({ type: "bindingRefreshError", message: "O tipo do bloco vinculado mudou; remova o vínculo e importe o bloco novamente." });
        } else {
          const model = signalBlockToTransfer(component);
          if (!model) await panel.webview.postMessage({ type: "bindingRefreshError", message: "O bloco vinculado não possui uma representação LTI compatível." });
          else await panel.webview.postMessage({ type: "importedModel", target: message.target, model: { label: component.label, num: model.num, den: model.den, domain: model.domain, sampleTime: model.sampleTime, binding: { componentId: component.id, typeId: component.typeId, label: component.label, signature: signalBlockSignature(component) } } });
        }
      } else if ((message.type === "applyController" && message.controller) || (message.type === "applyPlant" && message.project?.plantStateSpace)) {
        try {
          const target = message.type === "applyPlant" ? "G" : "C";
          const model = message.type === "applyPlant" ? message.project!.G : message.controller!;
          const binding = await onApply?.({ ...model, domain: message.project?.domain ?? "continuous", sampleTime: message.project?.sampleTime ?? 0.1 }, message.type === "applyPlant" ? message.project!.plantStateSpace : undefined);
          if (binding && message.project) {
            const project = { ...message.project, sourceBindings: { ...message.project.sourceBindings, [target]: { ...binding, modelSignature: JSON.stringify([message.project[target].num, message.project[target].den]) } } };
            onSave?.(project);
            await context.workspaceState.update("controlDesignerProject", project);
            await panel.webview.postMessage({ type: "applyCompleted", project, target });
          } else {
            await panel.webview.postMessage({ type: "applyCancelled" });
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          await panel.webview.postMessage({ type: "applyError", message: detail });
          void vscode.window.showErrorMessage(`Falha ao aplicar ${message.type === "applyPlant" ? "G" : "C"}: ${detail}`);
        }
      }
    });
  }

  static importIdentifiedModel(model:{label:string;num:number[];den:number[];domain:"continuous"|"discrete";sampleTime:number;stateSpace?:{A:number[][];B:number[];C:number[];D:number;x0?:number[]}}):void {
    this.pendingIdentifiedModel=model;
    if(this.current&&this.webviewReady){void this.current.webview.postMessage({type:"importedModel",target:"G",model,adoptDomain:true});this.pendingIdentifiedModel=undefined;}
  }
  static syncBindings(project: ControlDesignProject | undefined, components: readonly WebviewComponentModel[]): void {
    this.lastComponents = [...components];
    this.resolveBindingStatuses(project);
    void this.current?.webview.postMessage({ type: "bindingStatus", statuses: this.bindingStatuses });
  }
  private static resolveBindingStatuses(project: ControlDesignProject | undefined): void {
    if (!project?.sourceBindings) { this.bindingStatuses = {}; return; }
    const statuses: Record<string, "current" | "missing" | "changed"> = {};
    for (const [key, binding] of Object.entries(project.sourceBindings)) {
      if (!binding) continue;
      const component = this.lastComponents.find((item) => item.id === binding.componentId);
      statuses[key] = !component ? "missing" : component.typeId !== binding.typeId || signalBlockSignature(component) !== binding.signature ? "changed" : "current";
    }
    this.bindingStatuses = statuses;
  }
}
