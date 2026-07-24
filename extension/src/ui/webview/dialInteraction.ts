export interface ContinuousDialMapping {
  centerX: number;
  centerY: number;
  minimum: number;
  maximum: number;
  minimumAngleDeg: number;
  maximumAngleDeg: number;
  /** Resolução inteira do QDial subjacente (CustomDial do SimulIDE usa 0..1000). */
  positions?: number;
  step?: number;
  clamp?: boolean;
  deadZonePx?: number;
}

export interface SteppedDialMapping {
  minimum: number;
  maximum: number;
  /** Resolução inteira do QDial subjacente. */
  positions?: number;
  /** singleStep do QDial. CustomDial usa 25; Shift usa uma única posição. */
  singleStep?: number;
  /** Quantização física opcional aplicada por Dialed::dialChanged. */
  step?: number;
  clamp?: boolean;
}

function clampDialValue(value: number, minimum: number, maximum: number): number {
  return Math.max(Math.min(minimum, maximum), Math.min(Math.max(minimum, maximum), value));
}

function quantizePhysicalValue(value: number, step: number | undefined): number {
  return step !== undefined && step > 0 ? Math.round(value / step) * step : value;
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
  // O CustomDial real não é contínuo: QDial armazena um inteiro de 0 a 1000. Reproduzir essa
  // resolução aqui também evita valores de ponto flutuante diferentes a cada pixel/subpixel.
  const positions = Math.max(1, Math.round(mapping.positions ?? 1000));
  const ratio = mapping.maximum === mapping.minimum ? 0 : (value - mapping.minimum) / (mapping.maximum - mapping.minimum);
  value = mapping.minimum + (Math.round(ratio * positions) / positions) * (mapping.maximum - mapping.minimum);
  value = quantizePhysicalValue(value, mapping.step);
  if (mapping.clamp !== false) {
    value = clampDialValue(value, mapping.minimum, mapping.maximum);
  }
  return value;
}

/**
 * Aplica uma seta/roda ao mesmo valor inteiro 0..1000 do CustomDial.
 * No SimulIDE, setSingleStep(25); com Shift usamos uma única posição para o ajuste fino.
 */
export function steppedDialValue(
  currentValue: number,
  direction: 1 | -1,
  fine: boolean,
  mapping: SteppedDialMapping
): number {
  if (!Number.isFinite(currentValue) || mapping.minimum === mapping.maximum) return mapping.minimum;
  const positions = Math.max(1, Math.round(mapping.positions ?? 1000));
  const singleStep = Math.max(1, Math.round(mapping.singleStep ?? 25));
  const ratio = (currentValue - mapping.minimum) / (mapping.maximum - mapping.minimum);
  const currentPosition = Math.round(ratio * positions);
  const nextPosition = currentPosition + direction * (fine ? 1 : singleStep);
  const boundedPosition = mapping.clamp === false
    ? nextPosition
    : Math.max(0, Math.min(positions, nextPosition));
  let value = mapping.minimum + (boundedPosition / positions) * (mapping.maximum - mapping.minimum);
  value = quantizePhysicalValue(value, mapping.step);
  return mapping.clamp === false ? value : clampDialValue(value, mapping.minimum, mapping.maximum);
}
