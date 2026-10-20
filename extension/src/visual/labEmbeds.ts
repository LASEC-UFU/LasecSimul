import * as fs from "fs";
import * as path from "path";
import { ProcessExperiment } from "../lab/processExperiment";
import { state } from "../state";
import {
  CALCULUS_LAB_SCHEMA_VERSION, defaultActivity, isProcessActivity, validateCalculusLab, type CalculusLab, type LabActivity, type LabActivityKind,
} from "../ui/webview/lab/activity";
import { labProjectInfo } from "../ui/webview/lab/audit";
import { LAB_MESSAGE_VERSION, type HostToLabMessage, type LabToHostMessage } from "../ui/webview/lab/messages";
import { MATH_ACTIVITY_TYPE_ID, activityFromProperties } from "../ui/webview/mathWidgets";
import type { VisualDocument } from "../ui/webview/visualDocument";
import { getScreen, putScreen, redoScreen, screenHistory, undoScreen } from "./screenStore";

/** Instâncias de subsistemas internos aparecem para o laboratório com o `typeId` da planta-modelo de
 * origem (`origin.typeId`): o laboratório continua reconhecendo "o tanque", "a primeira ordem"... */
export function labVisibleComponents(): Array<{ id: string; typeId: string; label?: string }> {
  const originByTypeId = new Map((state.schematicState.subsystems ?? [])
    .filter((definition) => typeof definition.origin?.typeId === "string")
    .map((definition) => [definition.typeId, definition.origin!.typeId!]));
  return state.schematicState.components.map((component) => ({ id: component.id, typeId: originByTypeId.get(component.typeId) ?? component.typeId, label: component.label }));
}

/** Elemento "Atividade do Laboratório" de uma tela: onde está e qual atividade ele guarda. */
function findActivityElement(doc: VisualDocument | undefined, elementId: string): { pageIndex: number; elementIndex: number } | undefined {
  if (!doc) return undefined;
  for (const [pageIndex, page] of doc.pages.entries()) {
    const elementIndex = page.elements.findIndex((element) => element.id === elementId && element.typeId === MATH_ACTIVITY_TYPE_ID);
    if (elementIndex >= 0) return { pageIndex, elementIndex };
  }
  return undefined;
}

/** A atividade do elemento, validada como o `calculusLab` do `.lsproj`; ilegível vira a atividade-modelo do tipo. */
export function activityOfElement(properties: Record<string, unknown> | undefined): LabActivity {
  const raw = activityFromProperties(properties ?? {});
  const kind = typeof properties?.kind === "string" ? properties.kind as LabActivityKind : "functions";
  try {
    const lab = validateCalculusLab({ schemaVersion: CALCULUS_LAB_SCHEMA_VERSION, activities: [raw] });
    const activity = lab?.activities[0];
    if (activity) return activity;
  } catch {
    // definição ilegível: cai na atividade-modelo do tipo escolhido
  }
  try {
    return defaultActivity(kind);
  } catch {
    return defaultActivity("functions");
  }
}

/**
 * As atividades do Laboratório embutidas nas páginas de UMA vista (Painel Visual), docs/62 §6: o mesmo
 * protocolo do painel antigo (`lab/messages.ts`), endereçado pelo id do elemento. Cada elemento tem o seu
 * experimento de processo; a definição é a do elemento no documento da tela (gravar = editar o documento,
 * com desfazer/refazer do Host). Edição da tela = modo professor; operação = modo aluno.
 */
export class LabEmbedHost {
  private readonly experiments = new Map<string, ProcessExperiment>();
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
      case "labRun": void this.experiments.get(elementId)?.run(); return;
      case "labPause": void this.experiments.get(elementId)?.pause(); return;
      case "labRestart": void this.experiments.get(elementId)?.restart(message.parameters); return;
      case "labSetParameter": void this.experiments.get(elementId)?.setParameter(message.id, message.value); return;
      case "labInsertPlant": void this.experiments.get(elementId)?.insertPlant(); return;
      case "labSaveActivity": this.save(elementId, message.activity); return;
      case "labUndo": undoScreen(this.documentId); return;
      case "labRedo": redoScreen(this.documentId); return;
      default: return; // labSetMode/labSaveLab: o modo e a lista de atividades são da tela, não da atividade
    }
  }

  /** O `<iframe>` saiu da página: desliga o experimento dele. */
  close(elementId: string): void {
    this.experiments.get(elementId)?.dispose();
    this.experiments.delete(elementId);
    this.live.delete(elementId);
  }

  dispose(): void {
    for (const experiment of this.experiments.values()) experiment.dispose();
    this.experiments.clear();
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
      this.experiments.get(elementId)?.dispose();
      this.experiments.delete(elementId);
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

  private activate(elementId: string, activity: LabActivity): void {
    const current = this.experiments.get(elementId);
    if (!isProcessActivity(activity)) {
      current?.dispose();
      this.experiments.delete(elementId);
      return;
    }
    // Mesma atividade (a vista renasceu ao trocar de janela): o experimento continua e reenvia tudo.
    if (current && current.activityId === activity.id) { current.replay(); return; }
    current?.dispose();
    const experiment = new ProcessExperiment(activity, (message) => this.post(elementId, message));
    this.experiments.set(elementId, experiment);
    void experiment.start();
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
