import { enqueueCoreMutation } from "../core/coreLifecycle";
import { existingPlantRecording, plantRecording, plantSpecOfComponent, type PlantRecording } from "../lab/plantRecordings";
import { WEBVIEW_MESSAGE_VERSION } from "../ui/webview/messages";

/** Vista que recebe as plantas (Painel Visual). */
export interface PlantFeedTarget {
  postMessage(message: unknown): void;
}

/**
 * Plantas do Laboratório nas telas (gráfico de série, tanque, parâmetro da planta...): cada vista assina
 * as plantas que a página mostra e recebe a série gravada (`plantSeries`, formato do Laboratório) e os
 * parâmetros correntes (`plantParameters`) da MESMA gravação que as atividades usam (`plantRecordings.ts`):
 * uma assinatura no Core por planta, qualquer que seja o número de vistas.
 */
const feeds = new Map<PlantFeedTarget, Map<string, () => void>>();

/** A vista pediu estas plantas; `fresh` (vista recém-criada): manda tudo de novo, inclusive as que já tinha. */
export function subscribePlantFeeds(target: PlantFeedTarget, componentIds: readonly string[], fresh: boolean): void {
  let current = feeds.get(target);
  if (!current) {
    current = new Map();
    feeds.set(target, current);
  }
  const wanted = new Set(componentIds);
  for (const [componentId, stop] of [...current]) {
    if (wanted.has(componentId) && !fresh) continue;
    stop();
    current.delete(componentId);
  }
  for (const componentId of wanted) {
    if (current.has(componentId)) continue;
    const spec = plantSpecOfComponent(componentId);
    if (!spec) {
      target.postMessage({ version: WEBVIEW_MESSAGE_VERSION, type: "plantParameters", componentId, values: {}, error: `"${componentId}" não é uma planta do Laboratório` });
      continue;
    }
    // Reserva a vaga já: um segundo pedido antes de a gravação ligar não assina duas vezes.
    let stop: (() => void) | undefined;
    let cancelled = false;
    current.set(componentId, () => { cancelled = true; stop?.(); });
    void enqueueCoreMutation(() => plantRecording(componentId, spec)).then((recording) => {
      if (cancelled) return;
      stop = listenTo(target, recording);
    }).catch((err: unknown) => {
      target.postMessage({ version: WEBVIEW_MESSAGE_VERSION, type: "plantParameters", componentId, values: {}, error: err instanceof Error ? err.message : String(err) });
    });
  }
}

function listenTo(target: PlantFeedTarget, recording: PlantRecording): () => void {
  const componentId = recording.componentId;
  return recording.listen({
    series: (delta) => target.postMessage({ version: WEBVIEW_MESSAGE_VERSION, type: "plantSeries", componentId, delta: recording.labDelta(delta) }),
    parameters: (values) => target.postMessage({ version: WEBVIEW_MESSAGE_VERSION, type: "plantParameters", componentId, values }),
  });
}

export function unsubscribePlantFeeds(target: PlantFeedTarget): void {
  for (const stop of feeds.get(target)?.values() ?? []) stop();
  feeds.delete(target);
}

/** Um elemento de tela mudou um parâmetro da planta (só na execução; não grava no projeto). */
export async function requestPlantParameter(target: PlantFeedTarget, componentId: string, parameterId: string, value: number): Promise<void> {
  const recording = existingPlantRecording(componentId);
  const reason = recording ? await recording.setParameter(parameterId, value) : "a planta ainda não está ligada ao simulador";
  if (reason) target.postMessage({ version: WEBVIEW_MESSAGE_VERSION, type: "plantParameterRejected", componentId, parameterId, value, reason });
}
