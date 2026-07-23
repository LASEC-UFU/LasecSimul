/** Máquina de estado PURA (sem IPC/timer/`vscode`) por trás de `pollSimulationRate`
 * (`coreLifecycle.ts`) -- num arquivo próprio, sem nenhuma dependência de `vscode` em runtime
 * (`coreLifecycle.ts` importa `vscode` como VALOR, não só tipo, então `require`-lo fora de um
 * Extension Host real falha com "Cannot find module 'vscode'" -- ver `coreLifecycle.test.ts`).
 *
 * Duas disciplinas de janela, ambas já em uso antes desta extração:
 *   - `resetOriginEveryTick=true` (solver elétrico, `simulationRate`): a origem da amostra sempre
 *     avança pro tick atual, e o RELATÓRIO é que fica condicionado à janela mínima ter passado desde
 *     a origem anterior -- se os ticks vierem mais rápido que `minWindowMs`, nenhum relatório sai,
 *     mas a origem já pulou pro tick mais recente mesmo assim.
 *   - `resetOriginEveryTick=false` (MCU/QEMU, `mcuRealTimeRatio`, achado 2026-07-22): a origem só
 *     avança quando a janela é satisfeita -- essencial pra uma métrica mais ruidosa (o avanço do
 *     tempo virtual do MCU/QEMU vem em rajadas entre heartbeats/writes da fila Core<->QEMU, ver
 *     PERF-13): uma janela de ~1-2s reduz esse ruído, o que só funciona se a origem for preservada
 *     entre ticks que não fecharam a janela ainda. */
export class RollingRateSampler {
  private previous: { wallMs: number; valueNs: number } | undefined;
  constructor(private readonly minWindowMs: number, private readonly resetOriginEveryTick: boolean) {}
  reset(): void { this.previous = undefined; }
  /** `valueNs === undefined` representa "a fonte da métrica deixou de existir" (ex.: MCU removido
   * do circuito) -- limpa a amostra e só pede relatório (de `undefined`, pra apagar o indicador) se
   * havia uma amostra anterior; nunca relata repetidamente por uma fonte que nunca existiu. */
  sample(wallMs: number, valueNs: number | undefined): { report: boolean; rate: number | undefined } {
    if (valueNs === undefined) {
      const hadSample = this.previous !== undefined;
      this.previous = undefined;
      return { report: hadSample, rate: undefined };
    }
    const previous = this.previous;
    if (!previous) {
      this.previous = { wallMs, valueNs };
      return { report: false, rate: undefined };
    }
    const deltaWallMs = wallMs - previous.wallMs;
    const windowSatisfied = deltaWallMs > this.minWindowMs;
    if (this.resetOriginEveryTick) {
      this.previous = { wallMs, valueNs };
      return windowSatisfied
        ? { report: true, rate: (valueNs - previous.valueNs) / 1e6 / deltaWallMs }
        : { report: false, rate: undefined };
    }
    if (!windowSatisfied) return { report: false, rate: undefined };
    this.previous = { wallMs, valueNs };
    return { report: true, rate: (valueNs - previous.valueNs) / 1e6 / deltaWallMs };
  }
}
