export interface ControlDesignProject {
  version: 1;
  domain: "continuous" | "discrete";
  sampleTime: number;
  discretizationMethod?: "tustin" | "zoh" | "eulerForward" | "eulerBackward";
  frequencyUnit?: "rad/s" | "Hz" | "rad/sample";
  coefficientConvention?: "z-descending" | "z-inverse";
  plotViewBoxes?: Partial<Record<"rl" | "bode" | "nichols" | "nyquist" | "time" | "pz", string>>;
  F: { num: string; den: string };
  C: { num: string; den: string };
  G: { num: string; den: string };
  /** Optional source realization for the plant; kept intact while G is its analysis view. */
  plantStateSpace?: { A: number[][]; B: number[]; C: number[]; D: number };
  /** Initial condition for the preserved plant realization, in state order. */
  plantInitialState?: number[];
  derivativeOnMeasurement?: boolean;
  measurementDerivative?: { kd: number; filterN: number };
  measurementDerivativeModel?: { num: string; den: string };
  H: { num: string; den: string };
  response: "output" | "control" | "sensitivity" | "complementary" | "plantInputDisturbance" | "measurementNoiseOutput" | "measurementNoiseControl";
  requirements: Array<{ id: string; kind: "overshoot" | "settling" | "phaseMargin" | "poleRadius" | "controlPeak" | "dampingRatio" | "decayRate"; value: number; unit?: string; path?: ControlDesignProject["response"] }>;
  alternatives: Array<{ name: string; color: string; controller: { num: string; den: string } }>;
  activeAlternative: string;
  sourceBindings?: Partial<Record<"F" | "C" | "G" | "H", { componentId: string; typeId: string; label: string; signature: string; modelSignature: string }>>;
}
export function validateControlDesignProject(value: unknown): ControlDesignProject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const x = value as Record<string, unknown>;
  if (x.domain !== "continuous" && x.domain !== "discrete") return undefined;
  const model = (v: unknown): v is { num: string; den: string } => {
    if (!v || typeof v !== "object") return false;
    const m = v as Record<string, unknown>;
    if (typeof m.num !== "string" || typeof m.den !== "string") return false;
    const valid = (s: string) => s.trim().length > 0 && s.split(",").every(t => Number.isFinite(Number(t.trim())));
    if (!valid(m.num) || !valid(m.den)) return false;
    const n = m.num.split(",").map(t => Number(t.trim())), d = m.den.split(",").map(t => Number(t.trim()));
    while (n.length > 1 && n[0] === 0) n.shift();
    while (d.length > 1 && d[0] === 0) d.shift();
    return d.some((coefficient: number) => coefficient !== 0) && n.length <= d.length;
  };
  if (![x.F, x.C, x.G, x.H].every(model)) return undefined;
  let plantStateSpace: ControlDesignProject["plantStateSpace"];
  if (x.plantStateSpace !== undefined) {
    const ss = x.plantStateSpace as Record<string, unknown>;
    if (!ss || typeof ss !== "object" || !Array.isArray(ss.A) || !Array.isArray(ss.B) || !Array.isArray(ss.C) || typeof ss.D !== "number") return undefined;
    const A = ss.A as unknown[];
    if (!A.length || A.length > 24 || A.some(row => !Array.isArray(row) || row.length !== A.length || row.some(value => typeof value !== "number" || !Number.isFinite(value))) || ss.B.length !== A.length || ss.C.length !== A.length || [...ss.B, ...ss.C, ss.D].some(value => typeof value !== "number" || !Number.isFinite(value))) return undefined;
    plantStateSpace = { A: A as number[][], B: ss.B as number[], C: ss.C as number[], D: ss.D };
  }
  let plantInitialState: number[] | undefined;
  if (x.plantInitialState !== undefined) {
    if (!Array.isArray(x.plantInitialState) || x.plantInitialState.some(value => typeof value !== "number" || !Number.isFinite(value))) return undefined;
    if (!plantStateSpace || x.plantInitialState.length !== plantStateSpace.A.length) return undefined;
    plantInitialState = x.plantInitialState as number[];
  }
  if (x.domain === "discrete" && !(typeof x.sampleTime === "number" && Number.isFinite(x.sampleTime) && x.sampleTime > 0)) return undefined;
  let measurementDerivative: ControlDesignProject["measurementDerivative"];
  if (x.measurementDerivative !== undefined) {
    const d = x.measurementDerivative as Record<string, unknown>;
    if (!d || typeof d !== "object" || typeof d.kd !== "number" || !Number.isFinite(d.kd) || typeof d.filterN !== "number" || !Number.isFinite(d.filterN) || d.filterN <= 0) return undefined;
    measurementDerivative = { kd: d.kd, filterN: d.filterN };
  }
  const measurementDerivativeModel = x.measurementDerivativeModel !== undefined && model(x.measurementDerivativeModel) ? x.measurementDerivativeModel as { num: string; den: string } : undefined;
  const requirements = Array.isArray(x.requirements) ? x.requirements.filter((r): r is ControlDesignProject["requirements"][number] =>
    !!r && typeof r === "object" && typeof (r as any).id === "string" &&
    ["overshoot", "settling", "phaseMargin", "poleRadius", "controlPeak", "dampingRatio", "decayRate"].includes((r as any).kind) && Number.isFinite((r as any).value)) : [];
  const alternatives = Array.isArray(x.alternatives) ? x.alternatives.filter((a): a is ControlDesignProject["alternatives"][number] =>
    !!a && typeof a === "object" && typeof (a as any).name === "string" && typeof (a as any).color === "string" && model((a as any).controller)) : [];
  const sourceBindings: NonNullable<ControlDesignProject["sourceBindings"]> = {};
  if (x.sourceBindings && typeof x.sourceBindings === "object" && !Array.isArray(x.sourceBindings)) {
    for (const key of ["F", "C", "G", "H"] as const) {
      const binding = (x.sourceBindings as Record<string, unknown>)[key];
      if (binding && typeof binding === "object") {
        const item = binding as Record<string, unknown>;
        if ([item.componentId, item.typeId, item.label, item.signature, item.modelSignature].every((v) => typeof v === "string")) {
          sourceBindings[key] = { componentId: item.componentId as string, typeId: item.typeId as string, label: item.label as string, signature: item.signature as string, modelSignature: item.modelSignature as string };
        }
      }
    }
  }
  const plotViewBoxes = x.plotViewBoxes && typeof x.plotViewBoxes === "object" ? Object.fromEntries(Object.entries(x.plotViewBoxes as Record<string, unknown>).filter(([key, value]) => ["rl", "bode", "nichols", "nyquist", "time", "pz"].includes(key) && typeof value === "string" && /^-?[0-9.]+ -?[0-9.]+ [0-9.]+ [0-9.]+$/.test(value))) as ControlDesignProject["plotViewBoxes"] : undefined;
  return { version: 1, domain: x.domain, sampleTime: typeof x.sampleTime === "number" ? x.sampleTime : .1,
    F: x.F as ControlDesignProject["F"], C: x.C as ControlDesignProject["C"], G: x.G as ControlDesignProject["G"], H: x.H as ControlDesignProject["H"], ...(plantStateSpace ? { plantStateSpace } : {}), ...(plantInitialState ? { plantInitialState } : {}),
    ...(typeof x.derivativeOnMeasurement === "boolean" ? { derivativeOnMeasurement: x.derivativeOnMeasurement } : {}), ...(measurementDerivative ? { measurementDerivative } : {}), ...(measurementDerivativeModel ? { measurementDerivativeModel } : {}),
    response: ["output", "control", "sensitivity", "complementary", "plantInputDisturbance", "measurementNoiseOutput", "measurementNoiseControl"].includes(String(x.response)) ? x.response as ControlDesignProject["response"] : "output",
    requirements, alternatives, activeAlternative: typeof x.activeAlternative === "string" ? x.activeAlternative : "", ...(Object.keys(sourceBindings).length ? { sourceBindings } : {}),
    discretizationMethod: ["zoh", "eulerForward", "eulerBackward"].includes(String(x.discretizationMethod)) ? x.discretizationMethod as ControlDesignProject["discretizationMethod"] : "tustin",
    frequencyUnit: x.frequencyUnit === "Hz" || x.frequencyUnit === "rad/sample" ? x.frequencyUnit : "rad/s",
    coefficientConvention: x.coefficientConvention === "z-inverse" ? "z-inverse" : "z-descending",
    ...(plotViewBoxes ? { plotViewBoxes } : {}) };
}
