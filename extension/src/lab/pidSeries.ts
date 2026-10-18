import { addSeriesDrain, onCoreRebuilt } from "../core/coreLifecycle";
import { coreInstanceIdByComponentId, state } from "../state";
import { PidTuningPanel } from "../ui/panels/PidTuningPanel";
import { SeriesStore } from "./SeriesStore";

/** Portas da estação PID gravadas: PV, SP remoto, MV (saída) e as chaves A/M e L/R. */
const PORTS = ["pv", "sp", "out", "am", "lr"] as const;

/**
 * Gráfico da sintonia PID alimentado pelo gravador de séries do Core (ADR 0012): cada ponto com o tempo
 * simulado exato da amostra do bloco, sem perder amostras entre ticks de telemetria. O SP plotado é o
 * efetivo (local quando L/R = 1, como o bloco usa).
 */
export class PidSeriesFeed {
  private static current: PidSeriesFeed | undefined;

  static attach(componentId: string): void {
    this.detach();
    this.current = new PidSeriesFeed(componentId);
    void this.current.bind();
  }

  static detach(): void {
    this.current?.dispose();
    this.current = undefined;
  }

  private store: SeriesStore | undefined;
  private removeDrain: (() => void) | undefined;
  private readonly removeRebuilt: () => void;
  private disposed = false;

  private constructor(private readonly componentId: string) {
    // Reconstrução do Core troca as instâncias: assina de novo (dentro da reconstrução, cliente direto).
    this.removeRebuilt = onCoreRebuilt(() => this.bind());
  }

  private async bind(): Promise<void> {
    await this.unbind();
    const client = state.coreClient, instanceId = coreInstanceIdByComponentId.get(this.componentId);
    const component = state.schematicState.components.find((item) => item.id === this.componentId);
    if (this.disposed || !client || !instanceId || !component) return;
    const period = Number(component.properties.samplePeriodNs);
    try {
      const subscriptionId = await client.subscribeSeries(PORTS.map((port) => ({ instanceId, port })),
        { periodNs: Number.isFinite(period) && period > 0 ? period : 100_000_000 });
      const store = new SeriesStore(subscriptionId, [...PORTS]);
      this.store = store;
      this.removeDrain = addSeriesDrain({
        subscriptionId,
        request: () => store.request(),
        deliver: (chunk) => {
          const delta = store.ingest(chunk);
          if (!delta) return;
          const live = state.schematicState.components.find((item) => item.id === this.componentId);
          const localSetpoint = Number(live?.properties.localSetpoint ?? 0);
          const [pv, sp, mv, , lr] = delta.columns as [number[], number[], number[], number[], number[]];
          PidTuningPanel.updateSeries(this.componentId, {
            reset: delta.reset, t: delta.t, pv, mv,
            sp: sp.map((value, i) => ((lr[i] ?? 0) >= 0.5 ? localSetpoint : value)),
          });
        },
      });
    } catch {
      // Estação fora do plano (ainda não compilado): o diálogo segue com as leituras por tick.
    }
  }

  private async unbind(): Promise<void> {
    this.removeDrain?.();
    this.removeDrain = undefined;
    const store = this.store;
    this.store = undefined;
    if (store && state.coreClient) await state.coreClient.unsubscribeSeries(store.subscriptionId).catch(() => false);
  }

  private dispose(): void {
    this.disposed = true;
    this.removeRebuilt();
    void this.unbind();
  }
}
