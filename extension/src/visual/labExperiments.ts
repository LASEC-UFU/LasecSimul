import { enqueueCoreMutation, onCoreRebuilt } from "../core/coreLifecycle";
import { configurePlantRecordings, plantRecording, plantSpecOfComponent, rebindPlantRecordings, releaseUnusedPlantRecordings } from "../lab/plantRecordings";
import { ProcessExperiment } from "../lab/processExperiment";
import {
  CALCULUS_LAB_SCHEMA_VERSION, defaultActivity, isProcessActivity, validateCalculusLab, type LabActivity, type LabActivityKind, type ProcessActivity,
} from "../ui/webview/lab/activity";
import { MATH_ACTIVITY_TYPE_ID, activityFromProperties } from "../ui/webview/mathWidgets";
import type { VisualDocument } from "../ui/webview/visualDocument";
import { faceplatesForSave, getScreen, onScreenChanged, onScreensReset, screensForSave } from "./screenStore";

/** Elemento "Atividade do Laboratório" de uma tela: onde está e qual atividade ele guarda. */
export function findActivityElement(doc: VisualDocument | undefined, elementId: string): { pageIndex: number; elementIndex: number } | undefined {
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
 * Experimentos de processo do PROJETO (docs/65 §7, M12): um por atividade de processo das telas e
 * Faceplates gravados, chaveado por documento e elemento -- não por vista. Assim os parâmetros que o aluno
 * mudou e a gravação da planta (`plantRecordings.ts`) sobrevivem à troca de página e a fechar e reabrir a
 * tela; as vistas só se ligam e desligam (`LabEmbedHost`). Os experimentos nascem e religam na
 * reconstrução do Core, com a execução parada: os parâmetros autorados entram sem gerar eventos de
 * parâmetro no meio de uma gravação.
 */
interface ExperimentEntry {
  documentId: string;
  elementId: string;
  /** `activityJson` do elemento quando o experimento nasceu: mudou no documento, o experimento é refeito. */
  json: string;
  experiment: ProcessExperiment;
}

const entries = new Map<string, ExperimentEntry>();
/** Projeto recém-aberto: os experimentos esperam a reconstrução do Core dele (o Core ainda é o anterior). */
let awaitingRebuild = false;
let syncScheduled = false;

const keyOf = (documentId: string, elementId: string): string => `${documentId}\n${elementId}`;

function processDefinition(doc: VisualDocument, elementId: string): { json: string; activity: ProcessActivity } | undefined {
  const where = findActivityElement(doc, elementId);
  if (!where) return undefined;
  const properties = doc.pages[where.pageIndex]!.elements[where.elementIndex]!.properties;
  const activity = activityOfElement(properties);
  return isProcessActivity(activity) ? { json: String(properties?.activityJson ?? ""), activity } : undefined;
}

/** Atividades de processo do projeto: telas que algum botão abre e Faceplates de definições existentes. */
function projectProcessActivities(): Array<{ documentId: string; elementId: string; json: string; activity: ProcessActivity }> {
  const result: Array<{ documentId: string; elementId: string; json: string; activity: ProcessActivity }> = [];
  for (const doc of [...screensForSave(), ...faceplatesForSave().values()]) {
    for (const page of doc.pages) {
      for (const element of page.elements) {
        if (element.typeId !== MATH_ACTIVITY_TYPE_ID) continue;
        const definition = processDefinition(doc, element.id);
        if (definition) result.push({ documentId: doc.id, elementId: element.id, ...definition });
      }
    }
  }
  return result;
}

function disposeEntry(key: string): void {
  entries.get(key)?.experiment.dispose();
  entries.delete(key);
}

function createEntry(documentId: string, elementId: string, json: string, activity: ProcessActivity): ProcessExperiment {
  const experiment = new ProcessExperiment(activity);
  entries.set(keyOf(documentId, elementId), { documentId, elementId, json, experiment });
  return experiment;
}

/**
 * O experimento da atividade `elementId` do documento, conforme a definição ATUAL: cria se faltar
 * (atividade recém-colocada) e refaz se a definição mudou. Um experimento novo liga na fila do Core.
 */
export function labExperiment(documentId: string, elementId: string): ProcessExperiment | undefined {
  const doc = getScreen(documentId);
  const definition = doc ? processDefinition(doc, elementId) : undefined;
  const key = keyOf(documentId, elementId);
  const entry = entries.get(key);
  if (!definition) {
    if (entry) disposeEntry(key);
    return undefined;
  }
  if (entry && entry.json === definition.json) return entry.experiment;
  if (entry) disposeEntry(key);
  const experiment = createEntry(documentId, elementId, definition.json, definition.activity);
  void enqueueCoreMutation(() => experiment.bind()).catch(() => undefined);
  return experiment;
}

/** O professor gravou a atividade pela própria vista: o experimento continua (sem refazer nem perder a série). */
export function noteLabActivitySaved(documentId: string, elementId: string, json: string): void {
  const entry = entries.get(keyOf(documentId, elementId));
  if (entry) entry.json = json;
}

/** Acerta os experimentos com as atividades do projeto; devolve os que nasceram (ainda sem ligar). */
function reconcile(create: boolean): ProcessExperiment[] {
  const wanted = projectProcessActivities();
  const wantedKeys = new Set(wanted.map((item) => keyOf(item.documentId, item.elementId)));
  for (const key of [...entries.keys()]) if (!wantedKeys.has(key)) disposeEntry(key);
  const created: ProcessExperiment[] = [];
  for (const item of wanted) {
    const key = keyOf(item.documentId, item.elementId);
    const entry = entries.get(key);
    if (entry && entry.json === item.json) continue;
    if (entry) disposeEntry(key);
    if (create) created.push(createEntry(item.documentId, item.elementId, item.json, item.activity));
  }
  return created;
}

/** Plantas que os elementos de tela do projeto mostram (gráfico de série, tanque, parâmetro...): qualquer
 * `graphics.math.*` com `plantComponentId`, menos a atividade (essa tem experimento). */
function elementPlants(): Set<string> {
  const plants = new Set<string>();
  for (const doc of [...screensForSave(), ...faceplatesForSave().values()]) {
    for (const page of doc.pages) {
      for (const element of page.elements) {
        if (!element.typeId?.startsWith("graphics.math.") || element.typeId === MATH_ACTIVITY_TYPE_ID) continue;
        const componentId = element.properties?.plantComponentId;
        if (typeof componentId === "string" && componentId.trim()) plants.add(componentId.trim());
      }
    }
  }
  return plants;
}

/** Plantas em uso no projeto: a gravação delas fica mesmo entre um experimento e o seguinte, e com a tela fechada. */
function plantsInUse(): Set<string> {
  const plants = elementPlants();
  for (const { experiment } of entries.values()) {
    const componentId = experiment.plantComponentId();
    if (componentId) plants.add(componentId);
  }
  return plants;
}

/** Os elementos de tela gravam desde a montagem (o gráfico mostra a série desde t = 0 ao abrir a tela). */
async function recordElementPlants(): Promise<void> {
  for (const componentId of elementPlants()) {
    const spec = plantSpecOfComponent(componentId);
    if (spec) await plantRecording(componentId, spec).catch(() => undefined);
  }
}

/** Dentro da reconstrução do Core (instâncias novas): gravações, depois experimentos, cada um uma vez. */
async function afterCoreRebuilt(): Promise<void> {
  awaitingRebuild = false;
  await rebindPlantRecordings();
  reconcile(true);
  for (const { experiment } of [...entries.values()]) await experiment.bind();
  await recordElementPlants();
  await releaseUnusedPlantRecordings(plantsInUse());
}

/** Uma tela mudou (edição, desfazer, botão apagado): na fila do Core, depois das mudanças em curso. */
function scheduleSync(): void {
  if (syncScheduled) return;
  syncScheduled = true;
  queueMicrotask(() => {
    syncScheduled = false;
    void enqueueCoreMutation(async () => {
      for (const experiment of reconcile(!awaitingRebuild)) await experiment.bind();
      if (!awaitingRebuild) await recordElementPlants();
      await releaseUnusedPlantRecordings(plantsInUse());
    }).catch(() => undefined);
  });
}

export function configureLabExperiments(): () => void {
  const disposers = [
    configurePlantRecordings(),
    onCoreRebuilt(() => afterCoreRebuilt()),
    onScreenChanged(() => scheduleSync()),
    // Outro projeto: nada do experimento anterior (parâmetros do aluno, planta) passa para ele.
    onScreensReset(() => {
      for (const key of [...entries.keys()]) disposeEntry(key);
      awaitingRebuild = true;
    }),
  ];
  return () => {
    for (const dispose of disposers) dispose();
    for (const key of [...entries.keys()]) disposeEntry(key);
  };
}
