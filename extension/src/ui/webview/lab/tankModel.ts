/**
 * Contrato entre o Laboratório e o subcircuito `subcircuits.process.hydraulic_tank`
 * (scripts/generate-hydraulic-tank.py): o que se assina no Core e quais constantes são parâmetros.
 * Unidades do modelo: volume em L, vazão em L/s, área em m², altura em m.
 */
export const TANK_PLANT_TYPE_ID = "subcircuits.process.hydraulic_tank";

/** `step-average`: a linha i vale no passo (tᵢ₋₁, tᵢ]; `linear`: estado; `zoh`: valor mantido. */
export type SeriesInterpolation = "linear" | "zoh" | "step-average";

export interface TankSeriesChannel {
  id: string;
  localId: string;
  port: string;
  unit: string;
  interpolation: SeriesInterpolation;
}

export const TANK_SERIES_CHANNELS: readonly TankSeriesChannel[] = [
  { id: "V", localId: "acc", port: "out", unit: "L", interpolation: "linear" },
  { id: "h", localId: "h", port: "out", unit: "m", interpolation: "linear" },
  { id: "A", localId: "c_area", port: "out", unit: "m2", interpolation: "zoh" },
  { id: "qOutDemand", localId: "q_out", port: "out", unit: "L/s", interpolation: "zoh" },
  { id: "inActual", localId: "acc", port: "inActual", unit: "L/s", interpolation: "zoh" },
  { id: "outActual", localId: "acc", port: "outActual", unit: "L/s", interpolation: "zoh" },
  { id: "overflow", localId: "acc", port: "overflow", unit: "L/s", interpolation: "zoh" },
  { id: "unmet", localId: "acc", port: "unmet", unit: "L/s", interpolation: "zoh" },
  { id: "cumIn", localId: "acc", port: "cumIn", unit: "L", interpolation: "linear" },
  { id: "cumOut", localId: "acc", port: "cumOut", unit: "L", interpolation: "linear" },
  { id: "cumOverflow", localId: "acc", port: "cumOverflow", unit: "L", interpolation: "linear" },
  { id: "cumUnmet", localId: "acc", port: "cumUnmet", unit: "L", interpolation: "linear" },
  { id: "cumSpill", localId: "acc", port: "cumSpill", unit: "L", interpolation: "zoh" },
];

/** Parâmetros do aluno/professor: constante interna, faixa e política. */
export interface TankParameterSpec {
  id: "qIn" | "qOut" | "area" | "k" | "valve" | "hMax" | "v0";
  localId: string;
  property: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  policy: "live" | "stop-required";
}

export const TANK_PARAMETERS: readonly TankParameterSpec[] = [
  { id: "qIn", localId: "c_qin", property: "value", unit: "L/s", min: 0, max: 2, step: 0.05, policy: "live" },
  { id: "qOut", localId: "c_qout", property: "value", unit: "L/s", min: 0, max: 2, step: 0.05, policy: "live" },
  { id: "area", localId: "c_area", property: "value", unit: "m2", min: 0.03, max: 0.2, step: 0.005, policy: "live" },
  { id: "k", localId: "c_k", property: "value", unit: "L/(s·m)", min: 0.5, max: 5, step: 0.1, policy: "live" },
  { id: "valve", localId: "c_valve", property: "value", unit: "", min: 0, max: 1, step: 1, policy: "stop-required" },
  { id: "hMax", localId: "c_hmax", property: "value", unit: "m", min: 0.2, max: 2, step: 0.05, policy: "stop-required" },
  { id: "v0", localId: "acc", property: "initial", unit: "L", min: 0, max: 400, step: 1, policy: "stop-required" },
];

export type TankParameterId = TankParameterSpec["id"];
export type TankParameterValues = Record<TankParameterId, number>;

export const DEFAULT_TANK_PARAMETERS: TankParameterValues = { qIn: 1, qOut: 0.4, area: 0.1, k: 2, valve: 0, hMax: 1, v0: 20 };

/** Política do Host (o Core aceita demandas com sinal): faixa, passo e mudança estrutural. */
export function checkTankParameter(id: TankParameterId, value: number, running: boolean): string | undefined {
  const spec = TANK_PARAMETERS.find((candidate) => candidate.id === id);
  if (!spec) return `parâmetro desconhecido: ${id}`;
  if (!Number.isFinite(value) || value < spec.min || value > spec.max) return `${id} fora da faixa [${spec.min}, ${spec.max}]`;
  if (spec.policy === "stop-required" && running) return `${id} só muda com a simulação parada: use Reiniciar`;
  return undefined;
}
