import * as path from "path";
import { refreshDirtyIndicator } from "../project/projectCommands";
import { state } from "../state";
import type { CalculusLabHost } from "../ui/panels/CalculusLabPanel";
import {
  CALCULUS_LAB_SCHEMA_VERSION, defaultCalculusLab, isProcessActivity, validateCalculusLab, type CalculusLab, type LabActivity,
} from "../ui/webview/lab/activity";
import { labProjectInfo } from "../ui/webview/lab/audit";
import type { HostToLabMessage, LabToHostMessage } from "../ui/webview/lab/messages";
import { ProcessExperiment } from "./processExperiment";

/** Referência estável da definição padrão enquanto o projeto não grava um laboratório próprio
 * (o painel compara por referência para decidir se reenvia a definição). */
let unsavedDefault: CalculusLab | undefined;

export function currentCalculusLab(): CalculusLab {
  return state.schematicState.calculusLab ?? (unsavedDefault ??= defaultCalculusLab());
}

/**
 * Desfazer/refazer da definição do laboratório. É parte do documento (`.lsproj`): cada gravação do
 * professor empilha o estado anterior; desfazer o restaura e marca o projeto como alterado.
 */
const history = { past: [] as Array<CalculusLab | undefined>, future: [] as Array<CalculusLab | undefined>, owner: undefined as CalculusLab | undefined };
const HISTORY_LIMIT = 100;

function commitLab(next: CalculusLab | undefined, record: boolean): void {
  if (record) {
    history.past.push(state.schematicState.calculusLab);
    if (history.past.length > HISTORY_LIMIT) history.past.shift();
    history.future = [];
  }
  state.schematicState = { ...state.schematicState, calculusLab: next };
  history.owner = next;
  refreshDirtyIndicator();
}

/** Projeto trocado (ou o laboratório mudou por fora do histórico): o histórico antigo não vale mais. */
export function syncLabHistoryWithProject(): void {
  if (state.schematicState.calculusLab !== history.owner) {
    history.past = [];
    history.future = [];
    history.owner = state.schematicState.calculusLab;
  }
}

/** Substitui (ou acrescenta) uma atividade e marca o projeto como alterado. Lança se a forma for inválida. */
export function saveLabActivity(activity: LabActivity): CalculusLab {
  syncLabHistoryWithProject();
  const current = state.schematicState.calculusLab ?? defaultCalculusLab();
  const activities = current.activities.some((a) => a.id === activity.id)
    ? current.activities.map((a) => (a.id === activity.id ? activity : a))
    : [...current.activities, activity];
  const lab = validateCalculusLab({ schemaVersion: CALCULUS_LAB_SCHEMA_VERSION, activities }) as CalculusLab;
  commitLab(lab, true);
  return lab;
}

/** Editor de atividades: grava a lista inteira (ordem, remoções, novas). */
export function saveLab(lab: CalculusLab): CalculusLab {
  syncLabHistoryWithProject();
  const valid = validateCalculusLab(lab) as CalculusLab;
  commitLab(valid, true);
  return valid;
}

export function undoLab(): boolean {
  syncLabHistoryWithProject();
  if (history.past.length === 0) return false;
  history.future.push(state.schematicState.calculusLab);
  commitLab(history.past.pop(), false);
  return true;
}

export function redoLab(): boolean {
  syncLabHistoryWithProject();
  if (history.future.length === 0) return false;
  history.past.push(state.schematicState.calculusLab);
  commitLab(history.future.pop(), false);
  return true;
}

export const labHistoryState = (): { canUndo: boolean; canRedo: boolean } => {
  syncLabHistoryWithProject();
  return { canUndo: history.past.length > 0, canRedo: history.future.length > 0 };
};

/** Um experimento ligado ao Core por vez: o da atividade que a Webview está mostrando. */
class LabExperiments {
  private process: ProcessExperiment | undefined;

  constructor(private readonly post: (message: HostToLabMessage) => void) {}

  receive(message: LabToHostMessage): void {
    switch (message.type) {
      case "labActivate":
        if (!isProcessActivity(message.activity)) { this.dispose(); return; }
        if (this.process?.activityId === message.activity.id) return;
        this.dispose();
        this.process = new ProcessExperiment(message.activity, this.post);
        void this.process.start();
        return;
      case "labRun": void this.process?.run(); return;
      case "labPause": void this.process?.pause(); return;
      case "labRestart": void this.process?.restart(message.parameters); return;
      case "labSetParameter": void this.process?.setParameter(message.id, message.value); return;
      case "labInsertPlant": void this.process?.insertPlant(); return;
      default: return;
    }
  }

  /** A definição da atividade ligada mudou (editor/desfazer): religa com a definição nova. */
  reset(): void { this.dispose(); }

  dispose(): void {
    this.process?.dispose();
    this.process = undefined;
  }
}

/** Instâncias de subsistemas internos aparecem para o laboratório com o `typeId` da planta-modelo de
 * origem (`origin.typeId`): o laboratório continua reconhecendo "o tanque", "a primeira ordem"... */
function labVisibleComponents(): Array<{ id: string; typeId: string; label?: string }> {
  const originByTypeId = new Map((state.schematicState.subsystems ?? [])
    .filter((definition) => typeof definition.origin?.typeId === "string")
    .map((definition) => [definition.typeId, definition.origin!.typeId!]));
  return state.schematicState.components.map((component) => ({ id: component.id, typeId: originByTypeId.get(component.typeId) ?? component.typeId, label: component.label }));
}

export function createCalculusLabHost(post: (message: HostToLabMessage) => void): CalculusLabHost {
  const experiments = new LabExperiments(post);
  return {
    getLab: currentCalculusLab,
    isSaved: () => state.schematicState.calculusLab !== undefined,
    saveActivity: (activity) => { saveLabActivity(activity); },
    saveLab: (lab) => { saveLab(lab); experiments.reset(); },
    undo: () => { const done = undoLab(); if (done) experiments.reset(); return done; },
    redo: () => { const done = redoLab(); if (done) experiments.reset(); return done; },
    history: labHistoryState,
    project: () => labProjectInfo(currentCalculusLab(), labVisibleComponents()),
    projectName: () => (state.currentProjectFilePath ? path.basename(state.currentProjectFilePath) : undefined),
    locale: () => state.schematicState.locale ?? "pt-BR",
    onMessage: (message) => experiments.receive(message),
    dispose: () => experiments.dispose(),
  };
}
