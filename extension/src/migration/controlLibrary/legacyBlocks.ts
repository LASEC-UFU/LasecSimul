/**
 * Conhecimento dos blocos LEGADOS `control.*` (o `SignalMathBlock` do Core antes da biblioteca
 * equivalente ao Simulink, docs/66-68): nomes de propriedade, padrões e portas exatamente como o Core
 * antigo os lia (`core/src/components/control/SignalMathBlock.hpp`, commit ab4c1efb7). Vive só aqui,
 * isolado no módulo de migração -- o caminho de execução normal não conhece mais estes typeIds.
 */

export type LegacyProperties = Record<string, unknown>;

/** Período padrão do bloco legado quando `samplePeriodNs` está ausente (SignalMathBlock::samplePeriodNs). */
export const LEGACY_DEFAULT_PERIOD_NS = 100_000_000;

export function legacyNumber(properties: LegacyProperties, key: string, fallback: number): number {
  const value = properties[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  // O Core legado só aceitava número (`std::get_if<double>`): texto/bool caíam no padrão.
  return fallback;
}

export function legacyBoolean(properties: LegacyProperties, key: string, fallback: boolean): boolean {
  const value = properties[key];
  return typeof value === "boolean" ? value : fallback;
}

export function legacyText(properties: LegacyProperties, key: string, fallback: string): string {
  const value = properties[key];
  return typeof value === "string" ? value : fallback;
}

export function legacyPeriodNs(properties: LegacyProperties): number {
  return Math.max(1, legacyNumber(properties, "samplePeriodNs", LEGACY_DEFAULT_PERIOD_NS));
}

/** Lista `inputs` como o Core legado lia: array JSON (texto, vindo do `.lssubcircuit`), array real
 * (projeto) ou lista separada por vírgula (catálogo/inspetor). */
export function legacyDeclaredInputs(properties: LegacyProperties): string[] {
  const raw = properties.inputs;
  if (Array.isArray(raw)) return raw.filter((value): value is string => typeof value === "string" && value.length > 0);
  if (typeof raw !== "string") return [];
  const text = raw.trim();
  if (text.length === 0) return [];
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string" && value.length > 0) : [];
    } catch {
      return [];
    }
  }
  return text.split(",").map((value) => value.trim()).filter(Boolean);
}

/** Portas de entrada do bloco legado, na ordem (SignalMathBlock::inputPortIds). */
export function legacyInputPorts(typeId: string, properties: LegacyProperties): string[] {
  switch (typeId) {
    case "control.state_space": return ["in"];
    case "control.pid_station": return ["sp", "pv", "am", "lr"];
    case "control.pid": return ["sp", "pv"];
    case "control.accumulator": {
      const ids = ["in", "outflow"];
      if (legacyBoolean(properties, "lowerInput", false)) ids.push("lower");
      if (legacyBoolean(properties, "upperInput", false)) ids.push("upper");
      return ids;
    }
    case "control.bias": {
      const declared = legacyDeclaredInputs(properties);
      return declared.length === 0 ? ["in"] : [declared[0]!];
    }
    case "control.calc_expression": {
      const declared = legacyDeclaredInputs(properties);
      return declared.length === 0 ? ["in"] : declared;
    }
    case "control.sum": case "control.product": case "control.subtract": case "control.divide": {
      const declared = legacyDeclaredInputs(properties);
      return declared.length < 2 ? ["in0", "in1"] : declared;
    }
    case "control.observer": return ["in"];
    case "control.constant": return [];
    default: return ["in"];
  }
}

/** Todos os typeIds legados que a migração reconhece. */
export const LEGACY_CONTROL_TYPE_IDS = new Set([
  "control.gain", "control.sum", "control.product", "control.subtract", "control.divide", "control.bias", "control.integrator",
  "control.filtered_derivative", "control.unit_delay", "control.dead_time", "control.first_order", "control.second_order",
  "control.lead_lag", "control.fopdt", "control.transfer_function", "control.accumulator", "control.valve_characteristic",
  "control.saturation", "control.limiter", "control.deadband", "control.hysteresis", "control.stiction", "control.rate_limiter",
  "control.pid", "control.pid_station", "control.calc_expression", "control.probe", "control.observer", "control.process",
  "control.state_space", "control.constant",
]);

/** Wrappers da antiga paleta (`subcircuits.control.<slug>`, um `.lssubcircuit` com túneis e um único
 * bloco `stage`): slug -> typeId do bloco interno. */
export const LEGACY_WRAPPER_STAGE: Readonly<Record<string, string>> = {
  gain: "control.gain", bias: "control.bias", sum: "control.sum", subtract: "control.subtract", product: "control.product",
  divide: "control.divide", pid: "control.pid", integrator: "control.integrator", filtered_derivative: "control.filtered_derivative",
  unit_delay: "control.unit_delay", dead_time: "control.dead_time", first_order: "control.first_order",
  second_order: "control.second_order", lead_lag: "control.lead_lag", fopdt: "control.fopdt",
  transfer_function: "control.transfer_function", accumulator: "control.accumulator", valve_characteristic: "control.valve_characteristic",
  saturation: "control.saturation", deadband: "control.deadband", hysteresis: "control.hysteresis", stiction: "control.stiction",
  rate_limiter: "control.rate_limiter", limiter: "control.limiter",
};

/** Padrões gravados nos wrappers legados (`scripts/generate-control-block-library.mjs`). */
export const LEGACY_WRAPPER_DEFAULTS: Readonly<Record<string, LegacyProperties>> = {
  gain: { gain: 1 }, bias: { bias: 0 }, sum: { inputs: ["in0", "in1"] }, subtract: { inputs: ["in0", "in1"] },
  product: { inputs: ["in0", "in1"] }, divide: { inputs: ["in0", "in1"] },
  pid: { kc: 1, ti: 10, td: 0, bias: 0, derivativeFilter: 0.1, outputMin: 0, outputMax: 100, action: 1, derivativeOnPv: true, initialIntegral: 0 },
  integrator: { gain: 1, initial: 0 }, filtered_derivative: { gain: 1, filterTau: 0.01, initial: 0 }, unit_delay: { initial: 0 },
  dead_time: { delay: 0.1, initial: 0 }, first_order: { gain: 1, tau: 1, initial: 0 },
  second_order: { gain: 1, omega: 1, zeta: 1, initial: 0, initialDerivative: 0 }, lead_lag: { gain: 1, leadTau: 0, lagTau: 1, initial: 0 },
  fopdt: { gain: 1, tau: 1, delay: 0.1, initial: 0 }, transfer_function: { model: "first_order", gain: 1, tau: 1, initial: 0 },
  accumulator: { initial: 0, lowerLimitEnabled: true, lowerLimit: 0, upperLimitEnabled: false, upperLimit: 100 },
  valve_characteristic: { coefficient: 1, exponent: 1 }, saturation: { minimum: 0, maximum: 100 }, deadband: { width: 0 },
  hysteresis: { low: 0, high: 1, lowOutput: 0, highOutput: 1, initial: 0 }, stiction: { breakaway: 0, slip: 0, initial: 0 },
  rate_limiter: { riseRate: 1, fallRate: 1, initial: 0 }, limiter: { minimum: 0, maximum: 100 },
};
