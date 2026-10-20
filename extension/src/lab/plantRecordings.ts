import { addSeriesDrain, enqueueCoreMutation, flushSeries, onSimulationStatusChange } from "../core/coreLifecycle";
import { coreInstanceIdByComponentId, state } from "../state";
import { childPropertyKey } from "../ui/webview/childPropertyOverrides";
import type { LabSeriesDelta } from "../ui/webview/lab/messages";
import { PLANTS, checkPlantParameter, type ParameterValues, type PlantSpec } from "../ui/webview/lab/plants";
import { SeriesStore, type SeriesDelta } from "./SeriesStore";

/** A especificação da planta do Laboratório que o componente é (pelo `typeId` ou pela origem do subsistema interno). */
export function plantSpecOfComponent(componentId: string): PlantSpec | undefined {
  const component = state.schematicState.components.find((candidate) => candidate.id === componentId);
  if (!component) return undefined;
  const origin = (state.schematicState.subsystems ?? []).find((definition) => definition.typeId === component.typeId)?.origin?.typeId;
  return Object.values(PLANTS).find((spec) => spec.typeId === component.typeId || spec.typeId === origin);
}

const finite = (value: unknown): number | undefined => {
  const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(numeric) ? numeric : undefined;
};

/** Os parâmetros com que o Core monta a planta: o da instância (`@interno.prop`), senão o do subsistema
 * interno, senão o padrão do modelo. */
function documentParameters(componentId: string, spec: PlantSpec): ParameterValues {
  const component = state.schematicState.components.find((candidate) => candidate.id === componentId);
  const definition = (state.schematicState.subsystems ?? []).find((candidate) => candidate.typeId === component?.typeId);
  const values: ParameterValues = { ...spec.defaults };
  for (const parameter of spec.parameters) {
    const inner = definition?.components?.find((candidate) => candidate.id === parameter.localId) as { properties?: Record<string, unknown> } | undefined;
    const value = finite(component?.properties[childPropertyKey(parameter.localId, parameter.property)]) ?? finite(inner?.properties?.[parameter.property]);
    if (value !== undefined) values[parameter.id] = value;
  }
  return values;
}

export interface PlantRecordingListener {
  series?(delta: SeriesDelta): void;
  parameters?(values: ParameterValues): void;
}

/**
 * Gravação das séries de UMA planta do Laboratório (docs/65 §7, M12): uma assinatura no Core por planta,
 * não por atividade nem por vista. Atividades (`processExperiment.ts`) e elementos de tela
 * (`visual/plantFeeds.ts`) só escutam; a gravação segue com a página fora da tela ou com a tela fechada, e
 * quem volta recebe a série inteira. Guarda também os valores correntes dos parâmetros da planta (os do
 * projeto na montagem, depois cada mudança aplicada), para que todas as vistas mostrem o mesmo. Uma
 * reconstrução do Core troca as instâncias: `bind` assina de novo e a série recomeça (nova geração).
 */
export class PlantRecording {
  private store: SeriesStore | undefined;
  private removeDrain: (() => void) | undefined;
  private readonly listeners = new Set<PlantRecordingListener>();
  /** id local no `.lssubcircuit` -> instância Core do filho (séries e parâmetros). */
  private children = new Map<string, string>();
  private values: ParameterValues;

  constructor(readonly componentId: string, readonly spec: PlantSpec) {
    this.values = documentParameters(componentId, spec);
  }

  get bound(): boolean { return this.store !== undefined; }
  get listenerCount(): number { return this.listeners.size; }
  get parameters(): ParameterValues { return { ...this.values }; }

  /** Passa a receber deltas e parâmetros, começando pela série gravada até aqui. */
  listen(listener: PlantRecordingListener): () => void {
    this.listeners.add(listener);
    listener.parameters?.(this.parameters);
    if (this.store) listener.series?.(this.store.snapshot());
    return () => { this.listeners.delete(listener); };
  }

  snapshot(): SeriesDelta | undefined {
    return this.store?.snapshot();
  }

  /** Um parâmetro foi aplicado no Core (por uma atividade ou por um elemento de tela). */
  noteParameter(id: string, value: number): void {
    if (this.values[id] === value) return;
    this.values = { ...this.values, [id]: value };
    for (const listener of [...this.listeners]) listener.parameters?.(this.parameters);
  }

  /** Delta no formato do protocolo do Laboratório: colunas da planta e eventos com o id do parâmetro. */
  labDelta(delta: SeriesDelta): LabSeriesDelta {
    return {
      reset: delta.reset, generation: delta.generation, columns: this.spec.series.map((channel) => channel.id),
      t: delta.t, values: delta.columns, lost: delta.lost,
      // O Core grava cada mudança de parâmetro em TODAS as assinaturas: só ficam as desta planta.
      events: delta.events.filter((event) => event.kind !== "parameter" || this.parameterIdOf(event.instanceId, event.name) !== undefined).map((event) => ({ tS: event.tNs * 1e-9, kind: event.kind,
        ...(event.kind === "parameter" ? { name: this.parameterIdOf(event.instanceId, event.name) ?? event.name } : {}),
        ...(event.value !== undefined ? { value: event.value } : {}),
        ...(event.instanceId !== undefined ? { instanceId: event.instanceId } : {}) })),
    };
  }

  /** Assina as séries da instância atual e volta os parâmetros aos do projeto. Usa `state.coreClient`
   * direto: só na fila de mutações do Core ou dentro da reconstrução. */
  async bind(): Promise<void> {
    await this.unbind();
    this.values = documentParameters(this.componentId, this.spec);
    for (const listener of [...this.listeners]) listener.parameters?.(this.parameters);
    const client = state.coreClient;
    const outerInstanceId = coreInstanceIdByComponentId.get(this.componentId);
    if (!client || !outerInstanceId) return;
    const children = new Map<string, string>();
    const localIds = new Set([...this.spec.series.map((channel) => channel.localId), ...this.spec.parameters.map((parameter) => parameter.localId)]);
    for (const localId of localIds) children.set(localId, await client.getSubcircuitChildInstanceId(outerInstanceId, localId));
    this.children = children;
    const subscriptionId = await client.subscribeSeries(
      this.spec.series.map((channel) => ({ instanceId: children.get(channel.localId)!, port: channel.port })),
      { periodNs: this.spec.periodNs },
    );
    const store = new SeriesStore(subscriptionId, this.spec.series.map((channel) => channel.id));
    this.store = store;
    this.removeDrain = addSeriesDrain({
      subscriptionId,
      request: () => store.request(),
      deliver: (chunk) => {
        const delta = store.ingest(chunk);
        if (delta) for (const listener of [...this.listeners]) listener.series?.(delta);
      },
    });
    const snapshot = store.snapshot();
    for (const listener of [...this.listeners]) listener.series?.(snapshot);
  }

  async unbind(): Promise<void> {
    this.removeDrain?.();
    this.removeDrain = undefined;
    const store = this.store;
    this.store = undefined;
    if (store && state.coreClient) await state.coreClient.unsubscribeSeries(store.subscriptionId).catch(() => false);
  }

  /** Elemento de tela mudou um parâmetro: política do Host (`checkPlantParameter`), depois o Core. Devolve
   * o motivo da recusa, se houver. Vale só para a execução (não grava no projeto): Parar/Reiniciar volta
   * aos valores do projeto. */
  async setParameter(id: string, value: number): Promise<string | undefined> {
    const reason = checkPlantParameter(this.spec, id, value, state.simulationStatus !== "stopped", this.values);
    if (reason) return reason;
    const parameter = this.spec.parameters.find((candidate) => candidate.id === id)!;
    const outerInstanceId = coreInstanceIdByComponentId.get(this.componentId);
    if (!outerInstanceId) return "O Core ainda não criou esta planta.";
    try {
      await enqueueCoreMutation(() => state.coreClient?.setSubcircuitChildProperty(outerInstanceId, parameter.localId, parameter.property, value));
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    this.noteParameter(id, value);
    return undefined;
  }

  /** O Core informa a instância filha e a propriedade; as vistas conhecem o parâmetro (`area`, `qIn`...). */
  private parameterIdOf(instanceId: string | undefined, property: string | undefined): string | undefined {
    if (instanceId === undefined) return undefined;
    return this.spec.parameters.find((parameter) => this.children.get(parameter.localId) === instanceId && parameter.property === property)?.id;
  }
}

const recordings = new Map<string, PlantRecording>();

/** A gravação da planta, assinada se ainda não estiver (mesmo contexto de `PlantRecording.bind`). */
export async function plantRecording(componentId: string, spec: PlantSpec): Promise<PlantRecording> {
  let recording = recordings.get(componentId);
  if (recording && recording.spec !== spec) {
    recordings.delete(componentId);
    await recording.unbind();
    recording = undefined;
  }
  if (!recording) {
    recording = new PlantRecording(componentId, spec);
    recordings.set(componentId, recording);
  }
  if (!recording.bound) await recording.bind();
  return recording;
}

/** A gravação já existente da planta (sem assinar nada). */
export function existingPlantRecording(componentId: string): PlantRecording | undefined {
  return recordings.get(componentId);
}

/** Reconstrução do Core (instâncias e ids novos): todas as gravações assinam de novo. */
export async function rebindPlantRecordings(): Promise<void> {
  for (const recording of [...recordings.values()]) {
    try {
      await recording.bind();
    } catch {
      await recording.unbind().catch(() => undefined);
    }
  }
}

/** Solta as gravações que ninguém escuta e que nada no projeto usa (`inUse`). */
export async function releaseUnusedPlantRecordings(inUse: ReadonlySet<string>): Promise<void> {
  for (const [componentId, recording] of [...recordings]) {
    if (recording.listenerCount > 0 || inUse.has(componentId)) continue;
    recordings.delete(componentId);
    await recording.unbind();
  }
}

/** Em pausa não há tique de telemetria: escoa de uma vez o que o Core gravou até parar. */
export function configurePlantRecordings(): () => void {
  return onSimulationStatusChange((status) => {
    if (status === "paused") void flushSeries().catch(() => undefined);
  });
}
