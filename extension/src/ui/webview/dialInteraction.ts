export interface ContinuousDialMapping {
  centerX: number;
  centerY: number;
  minimum: number;
  maximum: number;
  minimumAngleDeg: number;
  maximumAngleDeg: number;
  step?: number;
  clamp?: boolean;
  deadZonePx?: number;
}

/**
 * Converte a posição ABSOLUTA do ponteiro no valor do dial, como o QDial do SimulIDE.
 * Não recebe o valor anterior de propósito: uma confirmação atrasada nunca pode alterar o
 * resultado do frame seguinte e produzir o efeito visual de avançar/voltar.
 */
export function continuousDialValueFromPointer(
  clientX: number,
  clientY: number,
  mapping: ContinuousDialMapping
): number | undefined {
  const dx = clientX - mapping.centerX;
  const dy = clientY - mapping.centerY;
  if (Math.hypot(dx, dy) < (mapping.deadZonePx ?? 3)) return undefined;

  let angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
  if (angleDeg > 180) angleDeg -= 360;
  if (angleDeg < -180) angleDeg += 360;

  const minAngle = mapping.minimumAngleDeg;
  const maxAngle = mapping.maximumAngleDeg;
  if (angleDeg > maxAngle || angleDeg < minAngle) {
    const distance = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
    angleDeg = distance(angleDeg, maxAngle) <= distance(angleDeg, minAngle) ? maxAngle : minAngle;
  }

  const angleSpan = Math.max(1, Math.abs(maxAngle - minAngle));
  let value = mapping.minimum + ((angleDeg - minAngle) / angleSpan) * (mapping.maximum - mapping.minimum);
  const step = mapping.step ?? 0;
  if (step > 0) value = Math.round(value / step) * step;
  if (mapping.clamp !== false) {
    value = Math.max(Math.min(mapping.minimum, mapping.maximum), Math.min(Math.max(mapping.minimum, mapping.maximum), value));
  }
  return value;
}
