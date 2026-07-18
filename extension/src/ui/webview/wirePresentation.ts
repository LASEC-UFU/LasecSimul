/** Limiar exclusivamente visual solicitado para a animação dos condutores. */
export const HIGH_WIRE_VOLTAGE_THRESHOLD = 0.7;

/** `true` somente acima de 0,7 V; exatamente 0,7 V ainda pertence ao estado baixo. */
export function isHighWireVoltage(voltage: number): boolean {
  return voltage > HIGH_WIRE_VOLTAGE_THRESHOLD;
}

/**
 * Telemetria é uma sequência de atualizações parciais: um nó pode ainda não estar resolvido
 * naquele tick sem que sua tensão tenha deixado de existir. Preserva a última amostra válida e
 * remove apenas IDs que já não pertencem ao esquemático. `clear` é reservado ao Stop confirmado.
 */
export function reconcileWireVoltages(
  previous: Record<string, number>,
  incoming: Record<string, number>,
  activeWireIds: ReadonlySet<string>,
  clear: boolean
): Record<string, number> {
  if (clear) return {};
  const reconciled: Record<string, number> = {};
  for (const [wireId, voltage] of Object.entries({ ...previous, ...incoming })) {
    if (activeWireIds.has(wireId) && Number.isFinite(voltage)) reconciled[wireId] = voltage;
  }
  return reconciled;
}
