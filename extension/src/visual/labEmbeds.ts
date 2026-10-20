import * as fs from "fs";
import * as path from "path";
import type { LabView, ProcessExperiment } from "../lab/processExperiment";
import { state } from "../state";
import { CALCULUS_LAB_SCHEMA_VERSION, isProcessActivity, validateCalculusLab, type CalculusLab, type LabActivity } from "../ui/webview/lab/activity";
import { labProjectInfo } from "../ui/webview/lab/audit";
import { LAB_MESSAGE_VERSION, type HostToLabMessage, type LabToHostMessage } from "../ui/webview/lab/messages";
import { activityOfElement, findActivityElement, labExperiment, noteLabActivitySaved } from "./labExperiments";
import { getScreen, putScreen, redoScreen, screenHistory, undoScreen } from "./screenStore";

export { activityOfElement } from "./labExperiments";

/** Instâncias de subsistemas internos aparecem para o laboratório com o `typeId` da planta-modelo de
 * origem (`origin.typeId`): o laboratório continua reconhecendo "o tanque", "a primeira ordem"... */
export function labVisibleComponents(): Array<{ id: string; typeId: string; label?: string }> {
  const originByTypeId = new Map((state.schematicState.subsystems ?? [])
    .filter((definition) => typeof definition.origin?.typeId === "string")
    .map((definition) => [definition.typeId, definition.origin!.typeId!]));
  return state.schematicState.components.map((component) => ({ id: component.id, typeId: originByTypeId.get(component.typeId) ?? component.typeId, label: component.label }));
}

/**
 * As atividades do Laboratório embutidas nas páginas de UMA vista (Painel Visual), docs/62 §6: o mesmo
 * protocolo do painel antigo (`lab/messages.ts`), endereçado pelo id do elemento. O experimento de
 * processo é da atividade do projeto (`labExperiments.ts`), não desta vista: aqui cada `<iframe>` só se
 * liga a ele enquanto aparece. A definição é a do elemento no documento da tela (gravar = editar o
 * documento, com desfazer/refazer do Host). Edição da tela = modo professor; operação = modo aluno.
 */
export class LabEmbedHost {
  /** Vista de cada `<iframe>` ligada ao experimento da atividade. */
  private readonly views = new Map<string, { experiment: ProcessExperiment; view: LabView }>();
  /** `activityJson` que cada atividade viva recebeu no último `labInit`: mudou no documento, reinicia. */
  private readonly live = new Map<string, string>();
  private editing: boolean;

  constructor(
    private readonly documentId: string,
    editing: boolean,
    private readonly post: (elementId: string, message: HostToLabMessage) => void,
  ) {
    this.editing = editing;
  }

  receive(elementId: string, message: LabToHostMessage): void {
    switch (message.type) {
      case "labReady": this.init(elementId); return;
      case "labActivate": this.activate(elementId, message.activity); return;
      case "labRun": void this.experimentOf(elementId)?.run(); return;
      case "labPause": void this.experimentOf(elementId)?.pause(); return;
      case "labRestart": void this.experimentOf(elementId)?.restart(message.parameters); return;
      case "labSetParameter": void this.experimentOf(elementId)?.setParameter(message.id, message.value); return;
      case "labInsertPlant": void this.experimentOf(elementId)?.insertPlant(); return;
      case "labSaveActivity": this.save(elementId, message.activity); return;
      case "labUndo": undoScreen(this.documentId); return;
      case "labRedo": redoScreen(this.documentId); return;
      default: return; // labSetMode/labSaveLab: o modo e a lista de atividades são da tela, não da atividade
    }
  }

  /** O `<iframe>` saiu da página: só a vista se desliga; o experimento e a gravação continuam. */
  close(elementId: string): void {
    this.detach(elementId);
    this.live.delete(elementId);
  }

  dispose(): void {
    for (const elementId of [...this.views.keys()]) this.detach(elementId);
    this.live.clear();
  }

  /** Entrou/saiu da edição: as atividades vivas remontam no modo novo (professor/aluno). */
  setEditing(editing: boolean): void {
    if (editing === this.editing) return;
    this.editing = editing;
    for (const elementId of [...this.live.keys()]) this.init(elementId);
  }

  /** O documento mudou (desfazer, outra vista, Inspector): atividades com definição nova remontam. */
  documentChanged(): void {
    const doc = getScreen(this.documentId);
    for (const [elementId, sent] of [...this.live]) {
      const where = findActivityElement(doc, elementId);
      if (!where) { this.close(elementId); continue; }
      const json = String(doc!.pages[where.pageIndex]!.elements[where.elementIndex]!.properties?.activityJson ?? "");
      if (json === sent) continue;
      // Definição nova: a atividade remonta; o experimento é refeito pelo registro (`labExperiment`).
      this.detach(elementId);
      this.init(elementId);
    }
    for (const elementId of this.live.keys()) this.post(elementId, { version: LAB_MESSAGE_VERSION, type: "labHistory", ...screenHistory(this.documentId) });
  }

  private init(elementId: string): void {
    const doc = getScreen(this.documentId);
    const where = findActivityElement(doc, elementId);
    if (!doc || !where) return;
    const properties = doc.pages[where.pageIndex]!.elements[where.elementIndex]!.properties;
    const activity = activityOfElement(properties);
    this.live.set(elementId, String(properties?.activityJson ?? ""));
    const lab: CalculusLab = { schemaVersion: CALCULUS_LAB_SCHEMA_VERSION, activities: [activity] };
    this.post(elementId, {
      version: LAB_MESSAGE_VERSION, type: "labInit", locale: state.schematicState.locale ?? "pt-BR", lab,
      mode: this.editing ? "teacher" : "student", activeId: activity.id, saved: true,
      ...(state.currentProjectFilePath ? { projectName: path.basename(state.currentProjectFilePath) } : {}),
    });
    this.post(elementId, { version: LAB_MESSAGE_VERSION, type: "labProject", ...labProjectInfo(lab, labVisibleComponents()) });
    this.post(elementId, { version: LAB_MESSAGE_VERSION, type: "labHistory", ...screenHistory(this.documentId) });
  }

  private experimentOf(elementId: string): ProcessExperiment | undefined {
    return this.views.get(elementId)?.experiment;
  }

  private detach(elementId: string): void {
    const attached = this.views.get(elementId);
    attached?.experiment.removeView(attached.view);
    this.views.delete(elementId);
  }

  /** A atividade montou no `<iframe>` (página mostrada, janela trocada, modo trocado): a vista se liga ao
   * experimento dela, que reenvia estado, parâmetros e a série inteira. */
  private activate(elementId: string, activity: LabActivity): void {
    this.detach(elementId);
    if (!isProcessActivity(activity)) return;
    const experiment = labExperiment(this.documentId, elementId);
    if (!experiment || experiment.activityId !== activity.id) return;
    const view: LabView = (message) => this.post(elementId, message);
    this.views.set(elementId, { experiment, view });
    experiment.addView(view);
  }

  /** Professor gravou: a definição volta para o elemento, num passo de desfazer da tela. */
  private save(elementId: string, activity: LabActivity): void {
    const doc = getScreen(this.documentId);
    const where = findActivityElement(doc, elementId);
    if (!doc || !where) return;
    let valid: LabActivity;
    try {
      valid = validateCalculusLab({ schemaVersion: CALCULUS_LAB_SCHEMA_VERSION, activities: [activity] })!.activities[0]!;
    } catch {
      return;
    }
    const json = JSON.stringify(valid);
    const pages = doc.pages.map((page, pageIndex) => pageIndex !== where.pageIndex ? page : {
      ...page,
      elements: page.elements.map((element, elementIndex) => elementIndex !== where.elementIndex ? element : {
        ...element,
        properties: {
          ...element.properties, kind: valid.kind, activityJson: json,
          plantComponentId: "plantComponentId" in valid && typeof valid.plantComponentId === "string" ? valid.plantComponentId : "",
        },
      }),
    });
    // A própria atividade já mostra o que gravou: sem remontar (ela perderia cursor e séries).
    this.live.set(elementId, json);
    noteLabActivitySaved(this.documentId, elementId, json);
    putScreen({ ...doc, pages }, { record: true });
    this.post(elementId, { version: LAB_MESSAGE_VERSION, type: "labSaved", activityId: valid.id });
  }
}

let bundleCache: { key: string; script: string; style: string } | undefined;

/** Laboratório num arquivo só (`tsconfig.lab-embed.json`, AMD) e o tema dele, para ir INLINE no
 * `<iframe>` da atividade: o documento aninhado não carrega recursos pelo service worker da Webview. */
export function labEmbedBundle(extensionPath: string): { script: string; style: string } | undefined {
  const scriptPath = path.join(extensionPath, "out-webview", "lab-embed", "lab.js");
  const stylePath = path.join(extensionPath, "media", "lab", "lab.css");
  try {
    const key = `${fs.statSync(scriptPath).mtimeMs}:${fs.statSync(stylePath).mtimeMs}`;
    if (bundleCache?.key !== key) bundleCache = { key, script: fs.readFileSync(scriptPath, "utf8"), style: fs.readFileSync(stylePath, "utf8") };
    return { script: bundleCache.script, style: bundleCache.style };
  } catch {
    return undefined;
  }
}

/** Mensagem da atividade (vinda da Webview) com a forma mínima do protocolo `lab/messages.ts`. */
export function isLabToHostMessage(value: unknown): value is LabToHostMessage {
  return typeof value === "object" && value !== null && (value as { version?: unknown }).version === LAB_MESSAGE_VERSION
    && typeof (value as { type?: unknown }).type === "string";
}
