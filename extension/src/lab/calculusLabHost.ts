import * as path from "path";
import { refreshDirtyIndicator } from "../project/projectCommands";
import { state } from "../state";
import type { CalculusLabHost } from "../ui/panels/CalculusLabPanel";
import { CALCULUS_LAB_SCHEMA_VERSION, defaultCalculusLab, validateCalculusLab, type CalculusLab, type LabActivity } from "../ui/webview/lab/activity";
import type { HostToLabMessage, LabToHostMessage } from "../ui/webview/lab/messages";
import { TankExperiment } from "./tankExperiment";

/** Referência estável da atividade padrão enquanto o projeto não grava um laboratório próprio
 * (o painel compara por referência para decidir se reenvia a definição). */
let unsavedDefault: CalculusLab | undefined;

export function currentCalculusLab(): CalculusLab {
  return state.schematicState.calculusLab ?? (unsavedDefault ??= defaultCalculusLab());
}

/** Substitui (ou acrescenta) uma atividade e marca o projeto como alterado. Lança se a forma for inválida. */
export function saveLabActivity(activity: LabActivity): CalculusLab {
  const current = state.schematicState.calculusLab ?? defaultCalculusLab();
  const activities = current.activities.some((a) => a.id === activity.id)
    ? current.activities.map((a) => (a.id === activity.id ? activity : a))
    : [...current.activities, activity];
  const lab = validateCalculusLab({ schemaVersion: CALCULUS_LAB_SCHEMA_VERSION, activities }) as CalculusLab;
  state.schematicState = { ...state.schematicState, calculusLab: lab };
  refreshDirtyIndicator();
  return lab;
}

/** Um experimento ligado ao Core por vez: o da atividade que a Webview está mostrando. */
class LabExperiments {
  private tank: TankExperiment | undefined;

  constructor(private readonly post: (message: HostToLabMessage) => void) {}

  receive(message: LabToHostMessage): void {
    switch (message.type) {
      case "labActivate":
        if (message.activity.kind !== "tank") { this.dispose(); return; }
        if (this.tank?.activityId === message.activity.id) return;
        this.dispose();
        this.tank = new TankExperiment(message.activity, this.post);
        void this.tank.start();
        return;
      case "labRun": void this.tank?.run(); return;
      case "labPause": void this.tank?.pause(); return;
      case "labRestart": void this.tank?.restart(message.parameters); return;
      case "labSetParameter": void this.tank?.setParameter(message.id, message.value); return;
      case "labInsertPlant": void this.tank?.insertPlant(); return;
      default: return;
    }
  }

  dispose(): void {
    this.tank?.dispose();
    this.tank = undefined;
  }
}

export function createCalculusLabHost(post: (message: HostToLabMessage) => void): CalculusLabHost {
  const experiments = new LabExperiments(post);
  return {
    getLab: currentCalculusLab,
    saveActivity: (activity) => { saveLabActivity(activity); },
    projectName: () => (state.currentProjectFilePath ? path.basename(state.currentProjectFilePath) : undefined),
    locale: () => state.schematicState.locale ?? "pt-BR",
    onMessage: (message) => experiments.receive(message),
    dispose: () => experiments.dispose(),
  };
}
