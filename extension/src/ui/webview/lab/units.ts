/**
 * Registro único de unidades do Laboratório (docs/51 §4.9). Espelha a tabela `unitInfo` do Core
 * (`core/src/simulation/SignalEngine.cpp`) -- `units.test.ts` compara as duas, então uma unidade nova
 * entra nos dois lados ou o teste falha. Símbolos ASCII no Core (`m2`, `m3/s`); `display` é o que a
 * tela mostra (`m²`, `m³/s`).
 */
export interface UnitInfo { dimension: string; scale: number; offset: number; display: string }

const u = (dimension: string, scale: number, display: string, offset = 0): UnitInfo => ({ dimension, scale, offset, display });

export const UNITS: Readonly<Record<string, UnitInfo>> = {
  "1": u("dimensionless", 1, ""),
  V: u("voltage", 1, "V"), mV: u("voltage", 1e-3, "mV"), kV: u("voltage", 1e3, "kV"),
  A: u("current", 1, "A"), mA: u("current", 1e-3, "mA"),
  s: u("time", 1, "s"), ms: u("time", 1e-3, "ms"), us: u("time", 1e-6, "µs"), min: u("time", 60, "min"), h: u("time", 3600, "h"),
  Hz: u("frequency", 1, "Hz"), kHz: u("frequency", 1e3, "kHz"),
  Pa: u("pressure", 1, "Pa"), kPa: u("pressure", 1e3, "kPa"), bar: u("pressure", 1e5, "bar"),
  K: u("temperature", 1, "K"), degC: u("temperature", 1, "°C", 273.15),
  m: u("length", 1, "m"), cm: u("length", 1e-2, "cm"), mm: u("length", 1e-3, "mm"),
  m2: u("area", 1, "m²"), cm2: u("area", 1e-4, "cm²"),
  m3: u("volume", 1, "m³"), cm3: u("volume", 1e-6, "cm³"), L: u("volume", 1e-3, "L"), mL: u("volume", 1e-6, "mL"),
  "m3/s": u("volumetricFlow", 1, "m³/s"), "m3/h": u("volumetricFlow", 1 / 3600, "m³/h"),
  "L/s": u("volumetricFlow", 1e-3, "L/s"), "L/min": u("volumetricFlow", 1e-3 / 60, "L/min"),
  "m/s": u("velocity", 1, "m/s"), "cm/s": u("velocity", 1e-2, "cm/s"),
  rad: u("angle", 1, "rad"), deg: u("angle", Math.PI / 180, "°"),
};

export function unitInfo(symbol: string): UnitInfo {
  const info = UNITS[symbol === "" ? "1" : symbol];
  if (!info || !Object.hasOwn(UNITS, symbol === "" ? "1" : symbol)) throw new RangeError(`unidade desconhecida: ${symbol}`);
  return info;
}

/** Converte `value` de `from` para `to` (mesma dimensão; offset para temperatura). */
export function convertUnit(value: number, from: string, to: string): number {
  const a = unitInfo(from);
  const b = unitInfo(to);
  if (a.dimension !== b.dimension) throw new RangeError(`unidades incompatíveis: ${from} → ${to}`);
  return ((value * a.scale + a.offset) - b.offset) / b.scale;
}

export const displayUnit = (symbol: string): string => (Object.hasOwn(UNITS, symbol) ? UNITS[symbol]!.display : symbol);
