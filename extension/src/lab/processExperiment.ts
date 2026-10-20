import * as vscode from "vscode";
import { enqueueCoreMutation, onSimulationStatusChange } from "../core/coreLifecycle";
import { coreInstanceIdByComponentId, state } from "../state";
import type { ProcessActivity } from "../ui/webview/lab/activity";
import { LAB_MESSAGE_VERSION, type HostToLabMessage, type LabRunStatus } from "../ui/webview/lab/messages";
import { PLANTS, checkPlantParameter, type ParameterValues, type PlantSpec } from "../ui/webview/lab/plants";
import { plantRecording, type PlantRecording } from "./plantRecordings";
import type { SeriesDelta } from "./SeriesStore";

interface BoundPlant {
  componentId: string;
  outerInstanceId: string;
}

/** Instância do processo que a atividade usa: a referenciada, ou a única do tipo no projeto. */
export function resolvePlantComponentId(activity: ProcessActivity): string | undefined {
  const typeId = PLANTS[activity.kind].typeId;
  // A planta-modelo vive no projeto como subsistema interno (`subsystem.*`) cuja origem registra o
  // `typeId` da planta; instâncias com o próprio `typeId` da planta também valem.
  const fromPlant = new Set([typeId, ...(state.schematicState.subsystems ?? [])
    .filter((definition) => definition.origin?.typeId === typeId)
    .map((definition) => definition.typeId)]);
  const components = state.schematicState.components.filter((component) => fromPlant.has(component.typeId));
  if (activity.plantComponentId) return components.find((component) => component.id === activity.plantComponentId)?.id;
  return components[0]?.id;
}

/** Uma vista da atividade (o `<iframe>` dela numa tela): recebe as mensagens do experimento. */
export type LabView = (message: HostToLabMessage) => void;

type PlantStatus = Extract<HostToLabMessage, { type: "labPlant" }>["status"];

/**
 * Experimento de processo (docs/51 §8): liga a atividade à instância do subcircuito no projeto, aplica
 * parâmetros pela política do Host (`plants.ts`) e repassa às vistas a gravação da planta
 * (`plantRecordings.ts`, uma por planta). O experimento é da ATIVIDADE do projeto, não da vista
 * (`visual/labExperiments.ts`): trocar de página ou fechar a tela só tira a vista; ao voltar, ela recebe
 * o estado inteiro (`addView`) sem reaplicar nada no Core. Quem religa depois de uma reconstrução do Core
 * (Parar/Reiniciar, edição estrutural) é o registro dos experimentos, chamando `bind`.
 */
export class ProcessExperiment {
  private readonly plantSpec: PlantSpec;
  private plant: BoundPlant | undefined;
  private plantStatus: PlantStatus | undefined;
  private recording: PlantRecording | undefined;
  private stopListening: (() => void) | undefined;
  private parameters: ParameterValues;
  private readonly views = new Set<LabView>();
  private readonly disposers: Array<() => void> = [];
  private disposed = false;

  constructor(private readonly activity: ProcessActivity) {
    this.plantSpec = PLANTS[activity.kind];
    this.parameters = { ...activity.parameters };
    this.disposers.push(onSimulationStatusChange(() => this.postRunState()));
  }

  get activityId(): string { return this.activity.id; }

  /** A planta que a atividade usa no projeto atual (antes mesmo de ligar). */
  plantComponentId(): string | undefined {
    return resolvePlantComponentId(this.activity);
  }

  /** Uma vista passa a mostrar o experimento: estado da execução, ligação com a planta, parâmetros
   * correntes e a série inteira até aqui -- sem religar nada no Core nem perder a gravação. */
  addView(view: LabView): void {
    if (this.disposed) return;
    this.views.add(view);
    view(this.runStateMessage());
    if (this.plantStatus) view(this.plantMessage(this.plantStatus));
    for (const [id, value] of Object.entries(this.parameters)) {
      if (typeof value === "number") view({ version: LAB_MESSAGE_VERSION, type: "labParameter", activityId: this.activity.id, id, value });
    }
    const snapshot = this.recording?.snapshot();
    if (snapshot && this.recording) view(this.seriesMessage(this.recording, snapshot));
  }

  removeView(view: LabView): void {
    this.views.delete(view);
  }

  dispose(): void {
    this.disposed = true;
    this.views.clear();
    for (const dispose of this.disposers.splice(0)) dispose();
    this.unbind();
  }

  async run(): Promise<void> {
    if (!this.plant) return;
    await vscode.commands.executeCommand("lasecsimul.run");
  }

  async pause(): Promise<void> {
    if (state.simulationStatus === "running") await vscode.commands.executeCommand("lasecsimul.pause");
  }

  /** Reiniciar: volta aos valores autorados; parar reconstrói o Core e o `onCoreRebuilt` religa tudo. */
  async restart(parameters: ParameterValues): Promise<void> {
    this.parameters = { ...this.plantSpec.defaults, ...parameters };
    if (state.simulationStatus !== "stopped") {
      await vscode.commands.executeCommand("lasecsimul.stop");
      return;
    }
    await enqueueCoreMutation(() => this.bind());
  }

  async setParameter(id: string, value: number): Promise<void> {
    const running = state.simulationStatus !== "stopped";
    const reason = checkPlantParameter(this.plantSpec, id, value, running, this.parameters);
    if (reason) { this.post({ version: LAB_MESSAGE_VERSION, type: "labParameterRejected", activityId: this.activity.id, id, value, reason }); return; }
    this.parameters[id] = value;
    if (!this.plant) {
      this.post({ version: LAB_MESSAGE_VERSION, type: "labParameter", activityId: this.activity.id, id, value });
      return;
    }
    try {
      const appliedAtNs = await enqueueCoreMutation(() => this.applyParameter(id, value));
      this.post({ version: LAB_MESSAGE_VERSION, type: "labParameter", activityId: this.activity.id, id, value,
        ...(running && appliedAtNs !== undefined ? { appliedAtNs } : {}) });
    } catch (err) {
      this.post({ version: LAB_MESSAGE_VERSION, type: "labParameterRejected", activityId: this.activity.id, id, value,
        reason: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Insere o processo no projeto JÁ INCORPORADO (plantas não ficam na paleta: o projeto carrega a
   * sua, ver `project/plantTemplates.ts`) e liga a atividade a ele. */
  async insertPlant(): Promise<void> {
    const componentId = await vscode.commands.executeCommand<string | undefined>("lasecsimul.lab.insertEmbeddedPlant", this.plantSpec.typeId);
    if (!componentId) {
      this.postPlant({ state: "error", message: `o modelo "${this.plantSpec.name}" não foi encontrado no pacote do LasecSimul` });
      return;
    }
    await enqueueCoreMutation(() => this.bind());
  }

  /** Resolve a instância, aplica os parâmetros correntes e passa a escutar a gravação da planta. Usa
   * `state.coreClient` direto: só na fila de mutações do Core ou dentro da reconstrução. */
  async bind(): Promise<void> {
    if (this.disposed) return;
    this.unbind();
    const client = state.coreClient;
    const componentId = resolvePlantComponentId(this.activity);
    if (!componentId) {
      if (this.activity.plantComponentId) this.postPlant({ state: "error", message: `o componente "${this.activity.plantComponentId}" não existe mais no projeto (religue no editor de atividades)` });
      else this.postPlant({ state: "missing" });
      return;
    }
    const outerInstanceId = coreInstanceIdByComponentId.get(componentId);
    if (!client || !outerInstanceId) { this.postPlant({ state: "error", message: "O Core ainda não criou o processo deste projeto." }); return; }
    try {
      // A gravação primeiro: os parâmetros aplicados abaixo ficam registrados nela (todas as vistas da planta).
      const recording = await plantRecording(componentId, this.plantSpec);
      if (this.disposed) return;
      this.recording = recording;
      this.plant = { componentId, outerInstanceId };
      const status = state.simulationStatus;
      for (const spec of this.plantSpec.parameters) {
        if (status !== "stopped" && spec.policy !== "live") continue;
        const value = this.parameters[spec.id];
        if (value !== undefined) await this.applyParameter(spec.id, value);
      }
      if (this.disposed) return;
      const label = state.schematicState.components.find((component) => component.id === componentId)?.label ?? componentId;
      this.postPlant({ state: "bound", componentId, label });
      this.stopListening = recording.listen({
        series: (delta) => this.postSeries(recording, delta),
        // Um elemento de tela mudou o parâmetro da mesma planta: a atividade mostra o mesmo valor.
        parameters: (values) => {
          for (const [id, value] of Object.entries(values)) {
            if (this.parameters[id] === value || !(id in this.parameters)) continue;
            this.parameters[id] = value;
            this.post({ version: LAB_MESSAGE_VERSION, type: "labParameter", activityId: this.activity.id, id, value });
          }
        },
      });
    } catch (err) {
      this.plant = undefined;
      this.postPlant({ state: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Deixa de escutar a gravação; ela continua (é da planta, não deste experimento). */
  private unbind(): void {
    this.stopListening?.();
    this.stopListening = undefined;
    this.recording = undefined;
    this.plant = undefined;
  }

  private async applyParameter(id: string, value: number): Promise<number | undefined> {
    const spec = this.plantSpec.parameters.find((candidate) => candidate.id === id);
    if (!spec || !this.plant || !state.coreClient) return undefined;
    const result = await state.coreClient.setSubcircuitChildProperty(this.plant.outerInstanceId, spec.localId, spec.property, value);
    this.recording?.noteParameter(id, value);
    return result.appliedAtNs;
  }

  private post(message: HostToLabMessage): void {
    for (const view of [...this.views]) view(message);
  }

  private runStateMessage(): HostToLabMessage {
    return { version: LAB_MESSAGE_VERSION, type: "labRunState", status: state.simulationStatus as LabRunStatus };
  }

  private postRunState(): void {
    this.post(this.runStateMessage());
  }

  private plantMessage(status: PlantStatus): HostToLabMessage {
    return { version: LAB_MESSAGE_VERSION, type: "labPlant", activityId: this.activity.id, status };
  }

  /** A vista que chegar depois recebe o último estado da ligação (`addView`). */
  private postPlant(status: PlantStatus): void {
    this.plantStatus = status;
    this.post(this.plantMessage(status));
  }

  private postSeries(recording: PlantRecording, delta: SeriesDelta): void {
    this.post(this.seriesMessage(recording, delta));
  }

  private seriesMessage(recording: PlantRecording, delta: SeriesDelta): HostToLabMessage {
    return { version: LAB_MESSAGE_VERSION, type: "labSeries", activityId: this.activity.id, delta: recording.labDelta(delta) };
  }
}
