import * as vscode from "vscode";
import { addSeriesDrain, enqueueCoreMutation, flushSeries, onCoreRebuilt, onSimulationStatusChange } from "../core/coreLifecycle";
import { coreInstanceIdByComponentId, state } from "../state";
import type { ProcessActivity } from "../ui/webview/lab/activity";
import { LAB_MESSAGE_VERSION, type HostToLabMessage, type LabRunStatus, type LabSeriesDelta } from "../ui/webview/lab/messages";
import { PLANTS, checkPlantParameter, type ParameterValues, type PlantSpec } from "../ui/webview/lab/plants";
import { SeriesStore, type SeriesDelta } from "./SeriesStore";

interface BoundPlant {
  componentId: string;
  outerInstanceId: string;
  /** id local no `.lssubcircuit` -> instância Core do filho. */
  children: Map<string, string>;
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

/**
 * Experimento de processo (docs/51 §8): liga a atividade à instância do subcircuito no projeto, assina as
 * séries no Core, repassa deltas à Webview e aplica parâmetros pela política do Host (`plants.ts`). Uma
 * reconstrução do Core (Parar/Reiniciar, edição estrutural) troca os ids das instâncias: a assinatura é
 * refeita e os parâmetros correntes do laboratório são reaplicados.
 */
export class ProcessExperiment {
  private readonly plantSpec: PlantSpec;
  private plant: BoundPlant | undefined;
  private store: SeriesStore | undefined;
  private removeDrain: (() => void) | undefined;
  private parameters: ParameterValues;
  private readonly disposers: Array<() => void> = [];
  private disposed = false;

  constructor(private readonly activity: ProcessActivity, private readonly post: (message: HostToLabMessage) => void) {
    this.plantSpec = PLANTS[activity.kind];
    this.parameters = { ...activity.parameters };
    this.disposers.push(
      // Dentro da reconstrução: `bind` usa o cliente direto, nunca a fila de mutações (que esperaria a si mesma).
      onCoreRebuilt(() => this.bind()),
      onSimulationStatusChange((status) => this.statusChanged(status)),
    );
  }

  get activityId(): string { return this.activity.id; }

  async start(): Promise<void> {
    this.postRunState();
    await enqueueCoreMutation(() => this.bind());
  }

  dispose(): void {
    this.disposed = true;
    for (const dispose of this.disposers.splice(0)) dispose();
    void this.unbind();
  }

  /** Vista nova do mesmo experimento (a Webview da Tela HMI renasce ao trocar de janela): estado da
   * execução, ligação com a planta, parâmetros correntes e a série inteira até aqui -- sem religar nada
   * no Core nem perder a gravação. */
  replay(): void {
    if (this.disposed) return;
    this.postRunState();
    if (this.plant) {
      const label = state.schematicState.components.find((component) => component.id === this.plant!.componentId)?.label ?? this.plant.componentId;
      this.postPlant({ state: "bound", componentId: this.plant.componentId, label });
    }
    for (const [id, value] of Object.entries(this.parameters)) {
      if (typeof value === "number") this.post({ version: LAB_MESSAGE_VERSION, type: "labParameter", activityId: this.activity.id, id, value });
    }
    if (this.store) this.postSeries(this.store.snapshot());
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

  /** Resolve a instância, reaplica os parâmetros e refaz a assinatura. Usa `state.coreClient` direto. */
  private async bind(): Promise<void> {
    if (this.disposed) return;
    await this.unbind();
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
      const localIds = new Set([...this.plantSpec.series.map((c) => c.localId), ...this.plantSpec.parameters.map((p) => p.localId)]);
      const children = new Map<string, string>();
      for (const localId of localIds) children.set(localId, await client.getSubcircuitChildInstanceId(outerInstanceId, localId));
      this.plant = { componentId, outerInstanceId, children };
      const status = state.simulationStatus;
      for (const spec of this.plantSpec.parameters) {
        if (status !== "stopped" && spec.policy !== "live") continue;
        const value = this.parameters[spec.id];
        if (value !== undefined) await this.applyParameter(spec.id, value);
      }
      const subscriptionId = await client.subscribeSeries(
        this.plantSpec.series.map((channel) => ({ instanceId: children.get(channel.localId)!, port: channel.port })),
        { periodNs: this.plantSpec.periodNs },
      );
      const store = new SeriesStore(subscriptionId, this.plantSpec.series.map((channel) => channel.id));
      this.store = store;
      this.removeDrain = addSeriesDrain({
        subscriptionId,
        request: () => store.request(),
        deliver: (chunk) => { const delta = store.ingest(chunk); if (delta) this.postSeries(delta); },
      });
      const label = state.schematicState.components.find((component) => component.id === componentId)?.label ?? componentId;
      this.postPlant({ state: "bound", componentId, label });
      this.postSeries(store.snapshot());
    } catch (err) {
      this.plant = undefined;
      this.postPlant({ state: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  private async unbind(): Promise<void> {
    this.removeDrain?.();
    this.removeDrain = undefined;
    const store = this.store;
    this.store = undefined;
    this.plant = undefined;
    if (store && state.coreClient) await state.coreClient.unsubscribeSeries(store.subscriptionId).catch(() => false);
  }

  private async applyParameter(id: string, value: number): Promise<number | undefined> {
    const spec = this.plantSpec.parameters.find((candidate) => candidate.id === id);
    if (!spec || !this.plant || !state.coreClient) return undefined;
    const result = await state.coreClient.setSubcircuitChildProperty(this.plant.outerInstanceId, spec.localId, spec.property, value);
    return result.appliedAtNs;
  }

  private statusChanged(status: string): void {
    this.postRunState();
    // Sem tick de telemetria em pausa: escoa o que o Core gravou até parar.
    if (status === "paused") void flushSeries().catch(() => undefined);
  }

  private postRunState(): void {
    this.post({ version: LAB_MESSAGE_VERSION, type: "labRunState", status: state.simulationStatus as LabRunStatus });
  }

  private postPlant(status: Extract<HostToLabMessage, { type: "labPlant" }>["status"]): void {
    this.post({ version: LAB_MESSAGE_VERSION, type: "labPlant", activityId: this.activity.id, status });
  }

  /** O Core informa a instância filha e a propriedade; a Webview conhece o parâmetro (`area`, `qIn`...). */
  private parameterIdOf(instanceId: string | undefined, property: string | undefined): string | undefined {
    const children = this.plant?.children;
    if (!children || instanceId === undefined) return undefined;
    return this.plantSpec.parameters.find((spec) => children.get(spec.localId) === instanceId && spec.property === property)?.id;
  }

  private postSeries(delta: SeriesDelta): void {
    const message: LabSeriesDelta = {
      reset: delta.reset, generation: delta.generation, columns: this.plantSpec.series.map((channel) => channel.id),
      t: delta.t, values: delta.columns, lost: delta.lost,
      events: delta.events.map((event) => ({ tS: event.tNs * 1e-9, kind: event.kind,
        ...(event.kind === "parameter" ? { name: this.parameterIdOf(event.instanceId, event.name) ?? event.name } : {}),
        ...(event.value !== undefined ? { value: event.value } : {}),
        ...(event.instanceId !== undefined ? { instanceId: event.instanceId } : {}) })),
    };
    this.post({ version: LAB_MESSAGE_VERSION, type: "labSeries", activityId: this.activity.id, delta: message });
  }
}
