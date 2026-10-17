import * as vscode from "vscode";
import { addSeriesDrain, enqueueCoreMutation, flushSeries, onCoreRebuilt, onSimulationStatusChange } from "../core/coreLifecycle";
import { coreInstanceIdByComponentId, state } from "../state";
import type { TankActivity } from "../ui/webview/lab/activity";
import { LAB_MESSAGE_VERSION, type HostToLabMessage, type LabRunStatus, type LabSeriesDelta } from "../ui/webview/lab/messages";
import {
  TANK_PARAMETERS, TANK_PLANT_TYPE_ID, TANK_SERIES_CHANNELS, checkTankParameter,
  type TankParameterId, type TankParameterValues,
} from "../ui/webview/lab/tankModel";
import { SeriesStore, type SeriesDelta } from "./SeriesStore";

const SAMPLE_PERIOD_NS = 10_000_000;

interface BoundPlant {
  componentId: string;
  outerInstanceId: string;
  /** id local no `.lssubcircuit` -> instância Core do filho. */
  children: Map<string, string>;
}

/**
 * Experimento do tanque (docs/51 §8): liga a atividade à instância de `hydraulic_tank` do projeto,
 * assina as séries no Core, repassa deltas à Webview e aplica parâmetros pela política do Host.
 * Uma reconstrução do Core (Parar/Reiniciar, edição estrutural) troca os ids das instâncias: a
 * assinatura é refeita e os parâmetros correntes do laboratório são reaplicados.
 */
export class TankExperiment {
  private plant: BoundPlant | undefined;
  private store: SeriesStore | undefined;
  private removeDrain: (() => void) | undefined;
  private parameters: TankParameterValues;
  private readonly disposers: Array<() => void> = [];
  private disposed = false;

  constructor(private activity: TankActivity, private readonly post: (message: HostToLabMessage) => void) {
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

  async run(): Promise<void> {
    if (!this.plant) return;
    await vscode.commands.executeCommand("lasecsimul.run");
  }

  async pause(): Promise<void> {
    if (state.simulationStatus === "running") await vscode.commands.executeCommand("lasecsimul.pause");
  }

  /** Reiniciar: volta aos valores autorados; parar reconstrói o Core e o `onCoreRebuilt` religa tudo. */
  async restart(parameters: TankParameterValues): Promise<void> {
    this.parameters = { ...parameters };
    if (state.simulationStatus !== "stopped") {
      await vscode.commands.executeCommand("lasecsimul.stop");
      return;
    }
    await enqueueCoreMutation(() => this.bind());
  }

  async setParameter(id: TankParameterId, value: number): Promise<void> {
    const running = state.simulationStatus !== "stopped";
    const reason = checkTankParameter(id, value, running);
    if (reason) { this.post({ version: LAB_MESSAGE_VERSION, type: "labParameterRejected", activityId: this.activity.id, id, value, reason }); return; }
    this.parameters[id] = value;
    if (!this.plant) return;
    try {
      const appliedAtNs = await enqueueCoreMutation(() => this.applyParameter(id, value));
      this.post({ version: LAB_MESSAGE_VERSION, type: "labParameter", activityId: this.activity.id, id, value,
        ...(running && appliedAtNs !== undefined ? { appliedAtNs } : {}) });
    } catch (err) {
      this.post({ version: LAB_MESSAGE_VERSION, type: "labParameterRejected", activityId: this.activity.id, id, value,
        reason: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Insere o processo no projeto pela paleta (mesmo caminho do usuário) e liga a atividade a ele. */
  async insertPlant(): Promise<void> {
    await vscode.commands.executeCommand("lasecsimul.palette.addComponent", TANK_PLANT_TYPE_ID);
    await enqueueCoreMutation(() => this.bind());
  }

  private findPlantComponentId(): string | undefined {
    const components = state.schematicState.components.filter((component) => component.typeId === TANK_PLANT_TYPE_ID);
    return (components.find((component) => component.id === this.activity.plantComponentId) ?? components[0])?.id;
  }

  /** Resolve a instância, reaplica os parâmetros e refaz a assinatura. Usa `state.coreClient` direto. */
  private async bind(): Promise<void> {
    if (this.disposed) return;
    await this.unbind();
    const client = state.coreClient;
    const componentId = this.findPlantComponentId();
    if (!componentId) { this.postPlant({ state: "missing" }); return; }
    const outerInstanceId = coreInstanceIdByComponentId.get(componentId);
    if (!client || !outerInstanceId) { this.postPlant({ state: "error", message: "O Core ainda não criou o tanque deste projeto." }); return; }
    try {
      const localIds = new Set([...TANK_SERIES_CHANNELS.map((c) => c.localId), ...TANK_PARAMETERS.map((p) => p.localId)]);
      const children = new Map<string, string>();
      for (const localId of localIds) children.set(localId, await client.getSubcircuitChildInstanceId(outerInstanceId, localId));
      this.plant = { componentId, outerInstanceId, children };
      const status = state.simulationStatus;
      for (const spec of TANK_PARAMETERS) {
        if (status !== "stopped" && spec.policy !== "live") continue;
        await this.applyParameter(spec.id, this.parameters[spec.id]);
      }
      const subscriptionId = await client.subscribeSeries(
        TANK_SERIES_CHANNELS.map((channel) => ({ instanceId: children.get(channel.localId)!, port: channel.port })),
        { periodNs: SAMPLE_PERIOD_NS },
      );
      const store = new SeriesStore(subscriptionId, TANK_SERIES_CHANNELS.map((channel) => channel.id));
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

  private async applyParameter(id: TankParameterId, value: number): Promise<number | undefined> {
    const spec = TANK_PARAMETERS.find((candidate) => candidate.id === id)!;
    if (!this.plant || !state.coreClient) return undefined;
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
  private parameterIdOf(instanceId: string | undefined, property: string | undefined): TankParameterId | undefined {
    const children = this.plant?.children;
    if (!children || instanceId === undefined) return undefined;
    return TANK_PARAMETERS.find((spec) => children.get(spec.localId) === instanceId && spec.property === property)?.id;
  }

  private postSeries(delta: SeriesDelta): void {
    const message: LabSeriesDelta = {
      reset: delta.reset, generation: delta.generation, columns: TANK_SERIES_CHANNELS.map((channel) => channel.id),
      t: delta.t, values: delta.columns, lost: delta.lost,
      events: delta.events.map((event) => ({ tS: event.tNs * 1e-9, kind: event.kind,
        ...(event.kind === "parameter" ? { name: this.parameterIdOf(event.instanceId, event.name) ?? event.name } : {}),
        ...(event.value !== undefined ? { value: event.value } : {}),
        ...(event.instanceId !== undefined ? { instanceId: event.instanceId } : {}) })),
    };
    this.post({ version: LAB_MESSAGE_VERSION, type: "labSeries", activityId: this.activity.id, delta: message });
  }
}
