/**
 * Contrato entre o Laboratório e os subcircuitos de processo que ele dirige no Core
 * (scripts/generate-{hydraulic-tank,first-order-lab,sensor-4-20}.py): o que se assina no gravador de
 * séries e quais constantes/propriedades internas são parâmetros, com faixa e política.
 */
export type ProcessKind = "tank" | "firstOrder" | "sensor";

/** `step-average`: a linha i vale no passo (tᵢ₋₁, tᵢ]; `linear`: estado; `zoh`: valor mantido. */
export type SeriesInterpolation = "linear" | "zoh" | "step-average";

export interface PlantSeriesChannel { id: string; localId: string; port: string; unit: string; interpolation: SeriesInterpolation }

export interface PlantParameterSpec {
  id: string;
  label: string;
  localId: string;
  property: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  policy: "live" | "stop-required";
}

export interface PlantSpec {
  kind: ProcessKind;
  typeId: string;
  /** Nome do modelo (planta incorporada ao projeto, fora da paleta), para a mensagem de planta ausente. */
  name: string;
  periodNs: number;
  series: readonly PlantSeriesChannel[];
  parameters: readonly PlantParameterSpec[];
  defaults: Readonly<Record<string, number>>;
}

const MS10 = 10_000_000;

export const TANK_PLANT: PlantSpec = {
  kind: "tank",
  typeId: "subcircuits.process.hydraulic_tank",
  name: "Tanque hidráulico (vazão → volume)",
  periodNs: MS10,
  series: [
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
    { id: "upperContact", localId: "acc", port: "upperContactTime", unit: "s", interpolation: "zoh" },
    { id: "lowerContact", localId: "acc", port: "lowerContactTime", unit: "s", interpolation: "zoh" },
  ],
  parameters: [
    { id: "qIn", label: "Vazão de entrada", localId: "c_qin", property: "value", unit: "L/s", min: 0, max: 2, step: 0.05, policy: "live" },
    { id: "qOut", label: "Vazão de saída (bomba)", localId: "c_qout", property: "value", unit: "L/s", min: 0, max: 2, step: 0.05, policy: "live" },
    { id: "area", label: "Área do tanque A", localId: "c_area", property: "value", unit: "m2", min: 0.03, max: 0.2, step: 0.005, policy: "live" },
    { id: "k", label: "Válvula k", localId: "c_k", property: "value", unit: "L/(s·m)", min: 0.5, max: 5, step: 0.1, policy: "live" },
    { id: "torr", label: "Orifício c", localId: "c_torr", property: "value", unit: "L/(s·√m)", min: 0.5, max: 4, step: 0.1, policy: "live" },
    { id: "outlet", label: "Saída", localId: "c_outlet", property: "value", unit: "", min: 0, max: 2, step: 1, policy: "stop-required" },
    { id: "hMax", label: "h máx.", localId: "c_hmax", property: "value", unit: "m", min: 0.2, max: 2, step: 0.05, policy: "stop-required" },
    { id: "v0", label: "V₀", localId: "acc", property: "initial", unit: "L", min: 0, max: 400, step: 1, policy: "stop-required" },
  ],
  defaults: { qIn: 1, qOut: 0.4, area: 0.1, k: 2, torr: 1.4, outlet: 0, hMax: 1, v0: 20 },
};

export const FIRST_ORDER_PLANT: PlantSpec = {
  kind: "firstOrder",
  typeId: "subcircuits.process.first_order_lab",
  name: "Resposta de primeira ordem (laboratório)",
  periodNs: MS10,
  series: [
    { id: "y", localId: "fo", port: "out", unit: "1", interpolation: "linear" },
    { id: "u", localId: "c_u", port: "out", unit: "1", interpolation: "zoh" },
  ],
  parameters: [
    { id: "u", label: "Degrau u", localId: "c_u", property: "value", unit: "", min: -10, max: 10, step: 0.1, policy: "live" },
    { id: "K", label: "Ganho K", localId: "fo", property: "gain", unit: "", min: 0.1, max: 10, step: 0.1, policy: "stop-required" },
    { id: "tau", label: "Constante de tempo τ", localId: "fo", property: "tau", unit: "s", min: 0.5, max: 60, step: 0.5, policy: "stop-required" },
    { id: "y0", label: "y₀", localId: "fo", property: "initial", unit: "", min: -10, max: 10, step: 0.1, policy: "stop-required" },
  ],
  defaults: { u: 1, K: 2, tau: 5, y0: 0 },
};

export const SENSOR_PLANT: PlantSpec = {
  kind: "sensor",
  typeId: "subcircuits.process.sensor_4_20",
  name: "Sensor 4–20 mA (laboratório)",
  periodNs: MS10,
  series: [
    { id: "p", localId: "c_p", port: "out", unit: "kPa", interpolation: "zoh" },
    { id: "iRaw", localId: "i_raw", port: "out", unit: "mA", interpolation: "zoh" },
    { id: "i", localId: "i_loop", port: "out", unit: "mA", interpolation: "zoh" },
  ],
  parameters: [
    { id: "p", label: "Pressão P", localId: "c_p", property: "value", unit: "kPa", min: 0, max: 300, step: 1, policy: "live" },
    { id: "pmin", label: "Pmin (4 mA)", localId: "c_pmin", property: "value", unit: "kPa", min: 0, max: 150, step: 1, policy: "stop-required" },
    { id: "pmax", label: "Pmax (20 mA)", localId: "c_pmax", property: "value", unit: "kPa", min: 20, max: 300, step: 1, policy: "stop-required" },
  ],
  defaults: { p: 100, pmin: 0, pmax: 200 },
};

export const PLANTS: Readonly<Record<ProcessKind, PlantSpec>> = { tank: TANK_PLANT, firstOrder: FIRST_ORDER_PLANT, sensor: SENSOR_PLANT };

export type ParameterValues = Record<string, number>;

/** Política do Host (o Core aceita valores com sinal): faixa, mudança estrutural e restrições cruzadas. */
export function checkPlantParameter(plant: PlantSpec, id: string, value: number, running: boolean, current: ParameterValues): string | undefined {
  const spec = plant.parameters.find((candidate) => candidate.id === id);
  if (!spec) return `parâmetro desconhecido: ${id}`;
  if (!Number.isFinite(value) || value < spec.min || value > spec.max) return `${spec.label} fora da faixa [${spec.min}, ${spec.max}]`;
  if (spec.policy === "stop-required" && running) return `${spec.label} só muda com a simulação parada: use Reiniciar`;
  if (plant.kind === "sensor") {
    const pmin = id === "pmin" ? value : current.pmin!, pmax = id === "pmax" ? value : current.pmax!;
    if (!(pmax > pmin)) return "Pmax precisa ser maior que Pmin";
  }
  return undefined;
}

/** Valores completos e válidos (faixa de cada parâmetro) ou a mensagem do primeiro problema. */
export function validatePlantParameters(plant: PlantSpec, raw: unknown): ParameterValues | string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "parameters ausente";
  const values: ParameterValues = { ...plant.defaults };
  for (const spec of plant.parameters) {
    const value = (raw as Record<string, unknown>)[spec.id];
    if (typeof value !== "number" || !Number.isFinite(value) || value < spec.min || value > spec.max) return `${spec.id} precisa estar em [${spec.min}, ${spec.max}]`;
    values[spec.id] = value;
  }
  if (plant.kind === "sensor" && !(values.pmax! > values.pmin!)) return "pmax precisa ser maior que pmin";
  return values;
}
