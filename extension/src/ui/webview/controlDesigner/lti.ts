/** Núcleo LTI SISO independente da interface. Coeficientes em potências decrescentes. */
export type Complex = { re: number; im: number };
export interface TransferFunction { num: number[]; den: number[]; domain: "continuous" | "discrete"; sampleTime?: number }
export interface ZInverseTransferFunction { num: number[]; den: number[]; sampleTime?: number }
export type ControllerForm = "P" | "PI" | "PD" | "PID" | "lead" | "lag" | "leadlag";
export interface ControllerParameters { kp: number; ki: number; kd: number; filterN: number; tau: number; alpha: number }
export interface LoopAnalysis {
  loop: TransferFunction; output: TransferFunction; control: TransferFunction;
  sensitivity: TransferFunction; complementary: TransferFunction;
  /** Perturbação d somada à entrada da planta; ruído n somado à medição H y. */
  plantInputDisturbance: TransferFunction; measurementNoiseOutput: TransferFunction; measurementNoiseControl: TransferFunction;
}
const c = (re: number, im = 0): Complex => ({ re, im });
const add = (a: Complex, b: Complex): Complex => c(a.re + b.re, a.im + b.im);
const sub = (a: Complex, b: Complex): Complex => c(a.re - b.re, a.im - b.im);
const mul = (a: Complex, b: Complex): Complex => c(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
const div = (a: Complex, b: Complex): Complex => { const d = b.re * b.re + b.im * b.im; return c((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d); };
const abs = (a: Complex): number => Math.hypot(a.re, a.im);
const trim = (p: number[]): number[] => { while (p.length > 1 && p[0] === 0) p.shift(); return p; };
export const validateTf = (tf: TransferFunction): TransferFunction => {
  if (!tf || !["continuous", "discrete"].includes(tf.domain)) throw new Error("Domínio inválido.");
  const num = trim([...tf.num]), den = trim([...tf.den]);
  if (!num.length || !den.length || [...num, ...den].some((v) => !Number.isFinite(v))) throw new Error("Informe coeficientes reais finitos.");
  if (den.every((v) => v === 0)) throw new Error("O denominador não pode ser zero.");
  if (num.length > den.length) throw new Error("Modelo impróprio: o grau do numerador excede o do denominador.");
  if (tf.domain === "discrete" && den.length > 1 && (!(tf.sampleTime! > 0) || !Number.isFinite(tf.sampleTime))) throw new Error("Modelo discreto dinâmico exige tempo de amostragem positivo.");
  return { ...tf, num, den };
};
/** z^-1 coefficients are ordered by ascending sample delay: b0 + b1 z^-1 + ... . */
export function toZInverse(tf: TransferFunction): ZInverseTransferFunction {
  const model = validateTf(tf);
  if (model.domain !== "discrete") throw new Error("z^-1 representation is only available for discrete models.");
  const relativeDegree = model.den.length - model.num.length;
  return { num: [...new Array(relativeDegree).fill(0), ...model.num], den: [...model.den], sampleTime: model.sampleTime };
}
export function fromZInverse(model: ZInverseTransferFunction): TransferFunction {
  if (!model.num.length || !model.den.length || model.den[0] === 0) throw new Error("Invalid z^-1 coefficients.");
  const order = Math.max(model.num.length, model.den.length) - 1;
  const num = [...model.num, ...new Array(order + 1 - model.num.length).fill(0)];
  const den = [...model.den, ...new Array(order + 1 - model.den.length).fill(0)];
  return validateTf({ num, den, domain: "discrete", sampleTime: model.sampleTime });
}
/** Formas contínuas com derivada filtrada. Avanço/atraso usam (τs+1)/(ατs+1). */
export function controllerForm(form: ControllerForm, p: ControllerParameters): TransferFunction {
  const { kp, ki, kd, filterN: n, tau, alpha } = p;
  if ([kp, ki, kd, n, tau, alpha].some(x => !Number.isFinite(x)) || n <= 0 || tau <= 0 || alpha <= 0)
    throw new Error("Parâmetros de controlador inválidos; N, τ e α precisam ser positivos.");
  let num: number[], den: number[];
  switch (form) {
    case "P": num = [kp]; den = [1]; break;
    case "PI": num = [kp, ki]; den = [1, 0]; break;
    case "PD": num = [kp + kd * n, kp * n]; den = [1, n]; break;
    case "PID": num = [kp + kd * n, kp * n + ki, ki * n]; den = [1, n, 0]; break;
    case "lead": case "lag": num = [kp * tau, kp]; den = [alpha * tau, 1]; break;
    case "leadlag": num = [kp * tau * tau, 2 * kp * tau, kp]; den = [alpha * alpha * tau * tau, 2 * alpha * tau, 1]; break;
  }
  return validateTf({ num, den, domain: "continuous" });
}
export function transferFromPolesZeros(zerosIn: readonly Complex[], polesIn: readonly Complex[], gain: number, domain: "continuous" | "discrete", sampleTime?: number): TransferFunction {
  if (!Number.isFinite(gain) || polesIn.length === 0) throw new Error("Informe ganho finito e ao menos um polo.");
  if (zerosIn.length > polesIn.length) throw new Error("O modelo por polos e zeros seria impróprio.");
  const coefficients = (roots: readonly Complex[]): number[] => {
    let p = [c(1)];
    for (const root of roots) {
      if (![root.re, root.im].every(Number.isFinite)) throw new Error("Polo/zero não finito.");
      const next = new Array<Complex>(p.length + 1).fill(c(0));
      p.forEach((a, i) => { next[i] = add(next[i]!, a); next[i + 1] = sub(next[i + 1]!, mul(a, root)); });
      p = next;
    }
    if (p.some(x => Math.abs(x.im) > 1e-8 * Math.max(1, Math.abs(x.re)))) throw new Error("Polos e zeros complexos precisam formar pares conjugados.");
    return p.map(x => x.re);
  };
  return validateTf({ num: polyScale(coefficients(zerosIn), gain), den: coefficients(polesIn), domain, sampleTime });
}
export interface StateSpaceModel { A: number[][]; B: number[]; C: number[]; D: number; domain: "continuous" | "discrete"; sampleTime?: number }
/** Converte realização SISO para TF via Faddeev–LeVerrier e parâmetros de Markov. */
export function stateSpaceToTf(model: StateSpaceModel): TransferFunction {
  const { A, B, C, D, domain, sampleTime } = model, n = A.length;
  if (!n || B.length !== n || C.length !== n || A.some(row => row.length !== n) || ![D, ...A.flat(), ...B, ...C].every(Number.isFinite))
    throw new Error("Matrizes de estado inválidas ou dimensões incompatíveis.");
  if (n > 24) throw new Error("Modelos acima de 24 estados excedem o limite numérico atual.");
  if (!["continuous", "discrete"].includes(domain) || (domain === "discrete" && (!(sampleTime! > 0) || !Number.isFinite(sampleTime)))) throw new Error("Modelo discreto exige Ts positivo.");
  // Scale A before Faddeev-LeVerrier recurrence. This limits intermediate powers and
  // retains the full characteristic polynomial, including hidden realization modes.
  const norm = Math.max(1, ...A.map(row => row.reduce((sum, value) => sum + Math.abs(value), 0)));
  if (!Number.isFinite(norm)) throw new Error("Conversão de espaço de estados mal condicionada: norma de A excede a faixa numérica.");
  const scaledA = A.map(row => row.map(value => value / norm));
  const eye = (size: number) => Array.from({ length: size }, (_, i) => Array.from({ length: size }, (_, j) => i === j ? 1 : 0));
  const multiply = (left: number[][], right: number[][]) => left.map(row => right[0]!.map((_, j) => row.reduce((s, x, k) => s + x * right[k]![j]!, 0)));
  const matAddScale = (m: number[][], scale: number) => m.map((row, i) => row.map((x, j) => x + (i === j ? scale : 0)));
  let work: number[][] = eye(n); const scaledDen = [1];
  for (let k = 1; k <= n; k++) { const product = multiply(scaledA, work), coefficient = -product.reduce((s, row, i) => s + row[i]!, 0) / k; scaledDen.push(coefficient); work = matAddScale(product, coefficient); }
  let power: number[][] = eye(n); const moments: number[] = [];
  for (let k = 0; k < n; k++) { moments.push(C.reduce((s, x, i) => s + x * power[i]!.reduce((q, a, j) => q + a * B[j]! / norm, 0), 0)); power = multiply(power, scaledA); }
  const scaledNum = [D, ...Array.from({ length: n }, (_, k) => D * scaledDen[k + 1]! + moments.slice(0, k + 1).reduce((s, m, j) => s + scaledDen[k - j]! * m, 0))];
  const rescale = (coefficients: number[]) => coefficients.map((value, index) => {
    const result = value * norm ** index;
    if (!Number.isFinite(result)) throw new Error("Conversão de espaço de estados mal condicionada: coeficientes fora da faixa numérica representável.");
    if (value !== 0 && result === 0) throw new Error("Conversão de espaço de estados mal condicionada: coeficiente sofreu underflow numérico.");
    return result;
  });
  return validateTf({ num: rescale(scaledNum), den: rescale(scaledDen), domain, sampleTime });
}
export const polyAdd = (a: readonly number[], b: readonly number[]): number[] => { const n = Math.max(a.length, b.length); return Array.from({ length: n }, (_, i) => (a[a.length - n + i] ?? 0) + (b[b.length - n + i] ?? 0)); };
export const polyScale = (a: readonly number[], k: number): number[] => a.map((x) => x * k);
export const polyMul = (a: readonly number[], b: readonly number[]): number[] => { const out = new Array(a.length + b.length - 1).fill(0); a.forEach((x, i) => b.forEach((y, j) => out[i + j] += x * y)); return trim(out); };
export const tfScale = (a: TransferFunction, k: number): TransferFunction => ({ ...a, num: polyScale(a.num, k) });
const staticGain = (tf: TransferFunction): boolean => trim([...tf.den]).length === 1;
function alignDomains(a: TransferFunction, b: TransferFunction): [TransferFunction, TransferFunction] {
  const dynamic = [a, b].filter((tf) => !staticGain(tf));
  if (!dynamic.length) return [a, b];
  const reference = dynamic[0]!;
  for (const tf of dynamic.slice(1)) if (tf.domain !== reference.domain || (reference.domain === "discrete" && tf.sampleTime !== reference.sampleTime)) throw new Error("Incompatible dynamic domains or sample times.");
  const adopt = (tf: TransferFunction): TransferFunction => staticGain(tf) ? { ...tf, domain: reference.domain, sampleTime: reference.sampleTime } : tf;
  return [adopt(a), adopt(b)];
}
export const tfMul = (a: TransferFunction, b: TransferFunction): TransferFunction => {
  [a, b] = alignDomains(validateTf(a), validateTf(b));
  if (a.domain !== b.domain || (a.domain === "discrete" && a.sampleTime !== b.sampleTime)) throw new Error("Não misture modelos contínuos e discretos nem tempos de amostragem distintos.");
  return validateTf({ num: polyMul(a.num, b.num), den: polyMul(a.den, b.den), domain: a.domain, sampleTime: a.sampleTime });
};
export const tfAdd = (a: TransferFunction, b: TransferFunction): TransferFunction => { [a, b] = alignDomains(validateTf(a), validateTf(b)); return validateTf({ num: polyAdd(polyMul(a.num, b.den), polyMul(b.num, a.den)), den: polyMul(a.den, b.den), domain: a.domain, sampleTime: a.sampleTime }); };
function polynomialPower(base: number[], power: number): number[] { let out = [1]; for (let i=0;i<power;i++) out=polyMul(out,base); return out; }
/** Conversão explícita bilinear/Tustin entre s e z; Ts é obrigatório no destino discreto. */
export function convertDomain(tf: TransferFunction, target: "continuous"|"discrete", sampleTime: number): TransferFunction {
  validateTf(tf);
  if (tf.domain===target) {
    if (target === "continuous") return { ...tf, sampleTime: undefined };
    if (!staticGain(tf) && tf.sampleTime !== sampleTime) throw new Error("Changing Ts changes the dynamics; use an explicit domain conversion.");
    return { ...tf, sampleTime: staticGain(tf) ? undefined : sampleTime };
  }
  if (staticGain(tf)) return { ...tf, domain: target, sampleTime: undefined };
  if (!(sampleTime>0) || !Number.isFinite(sampleTime)) throw new Error("Conversão bilinear exige Ts positivo.");
  const degree=tf.den.length-1, factor=2/sampleTime, half=sampleTime/2;
  const substitute=(p: readonly number[]): number[] => {
    let out=new Array(degree+1).fill(0);
    p.forEach((coefficient,index)=>{
      const power=p.length-1-index;
      const numerator=polynomialPower(target==="discrete"?[factor,-factor]:[half,1],power);
      const denominator=polynomialPower(target==="discrete"?[1,1]:[-half,1],degree-power);
      const term=polyScale(polyMul(numerator,denominator),coefficient*(target==="discrete"?1:1));
      out=polyAdd(out,term);
    });
    return trim(out);
  };
  const num=substitute(tf.num),den=substitute(tf.den);
  const scale=den[0]!;
  return validateTf({num:num.map(x=>x/scale),den:den.map(x=>x/scale),domain:target,sampleTime:target==="discrete"?sampleTime:undefined});
}
/** Explicit Euler substitutions for a continuous proper SISO model. */
export function convertEuler(tf: TransferFunction, sampleTime: number, method: "forward" | "backward"): TransferFunction {
  const source = validateTf(tf);
  if (source.domain !== "continuous") throw new Error("Euler conversion requires a continuous model.");
  if (!(sampleTime > 0) || !Number.isFinite(sampleTime)) throw new Error("Euler conversion requires positive Ts.");
  const degree = source.den.length - 1;
  const power = (base: number[], exponent: number) => polynomialPower(base, exponent);
  const substitute = (coefficients: number[]) => {
    let result = new Array<number>(degree + 1).fill(0);
    coefficients.forEach((coefficient, index) => {
      const exponent = coefficients.length - 1 - index;
      const numerator = power([1 / sampleTime, -1 / sampleTime], exponent);
      const denominator = method === "backward" ? power([1, 0], degree - exponent) : [1];
      result = polyAdd(result, polyScale(polyMul(numerator, denominator), coefficient));
    });
    return result;
  };
  const num = substitute(source.num), den = substitute(source.den), leading = den[0]!;
  if (!Number.isFinite(leading) || leading === 0) throw new Error("Euler conversion produced a singular denominator.");
  return validateTf({ num: num.map(value => value / leading), den: den.map(value => value / leading), domain: "discrete", sampleTime });
}
/** Exact zero-order-hold conversion for continuous SISO transfer functions. */
export function convertZoh(tf: TransferFunction, sampleTime: number): TransferFunction {
  const source = validateTf(tf);
  if (source.domain !== "continuous") throw new Error("ZOH conversion requires a continuous model.");
  if (!(sampleTime > 0) || !Number.isFinite(sampleTime)) throw new Error("ZOH conversion requires positive Ts.");
  const n = source.den.length - 1;
  if (!n) return { ...source, domain: "discrete", sampleTime: undefined };
  const den = source.den.map((v) => v / source.den[0]!);
  const num = source.num.map((v) => v / source.den[0]!);
  const padded = [...new Array(n + 1 - num.length).fill(0), ...num], D = padded[0]!;
  const A = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => i < n - 1 ? (j === i + 1 ? 1 : 0) : -den[n - j]!));
  const B = Array.from({ length: n }, (_, i) => i === n - 1 ? 1 : 0);
  const C = Array.from({ length: n }, (_, i) => padded[n - i]! - den[n - i]! * D);
  const size = n + 1;
  const augmented = Array.from({ length: size }, (_, i) => Array.from({ length: size }, (_, j) => i < n ? (j < n ? A[i]![j]! * sampleTime : B[i]! * sampleTime) : 0));
  const multiply = (x: number[][], y: number[][]): number[][] => x.map((row) => y[0]!.map((_, j) => row.reduce((sum, v, k) => sum + v * y[k]![j]!, 0)));
  const norm = Math.max(...augmented.map((row) => row.reduce((sum, v) => sum + Math.abs(v), 0)));
  const squarings = Math.max(0, Math.ceil(Math.log2(Math.max(1, norm))));
  const scaled = augmented.map((row) => row.map((v) => v / 2 ** squarings));
  let exponential: number[][] = Array.from({ length: size }, (_, i) => Array.from({ length: size }, (_, j) => i === j ? 1 : 0));
  let term = exponential.map((row) => [...row]);
  for (let k = 1; k <= 80; k++) {
    term = multiply(term, scaled).map((row) => row.map((v) => v / k));
    exponential = exponential.map((row, i) => row.map((v, j) => v + term[i]![j]!));
    if (Math.max(...term.flat().map(Math.abs)) < 1e-16) break;
  }
  for (let i = 0; i < squarings; i++) exponential = multiply(exponential, exponential);
  const Ad = exponential.slice(0, n).map((row) => row.slice(0, n));
  const Bd = exponential.slice(0, n).map((row) => row[n]!);
  return stateSpaceToTf({ A: Ad, B: Bd, C, D, domain: "discrete", sampleTime });
}
export function closeLoop(F: TransferFunction, C: TransferFunction, G: TransferFunction, H: TransferFunction, derivativeOnMeasurement?: TransferFunction): LoopAnalysis {
  let models = [F, C, G, H, ...(derivativeOnMeasurement ? [derivativeOnMeasurement] : [])].map(validateTf);
  const dynamic = models.filter((tf) => !staticGain(tf));
  const reference = dynamic[0] ?? models[0]!;
  models = models.map((tf) => staticGain(tf) ? { ...tf, domain: reference.domain, sampleTime: reference.sampleTime } : tf);
  const [f, ctl, plant, sensor, derivative] = models as [TransferFunction, TransferFunction, TransferFunction, TransferFunction, TransferFunction | undefined];
  for (const m of models) if (m.domain !== f.domain || (f.domain === "discrete" && m.sampleTime !== f.sampleTime)) throw new Error("Arquitetura com domínios ou tempos de amostragem incompatíveis.");
  const mult = (...p: number[][]): number[] => p.reduce((a, b) => polyMul(a, b), [1]);
  if (derivative) {
    // u = C0(F r - H y) - Dm y; keep reference and measurement paths distinct.
    const characteristic = polyAdd(polyAdd(mult(ctl.den, derivative.den, plant.den, sensor.den), mult(ctl.num, derivative.den, plant.num, sensor.num)), mult(derivative.num, ctl.den, plant.num, sensor.den));
    const tf = (num: number[]) => validateTf({ num, den: characteristic, domain: f.domain, sampleTime: f.sampleTime });
    const loopDen = mult(ctl.den, derivative.den, plant.den, sensor.den);
    const loopNum = polyAdd(mult(ctl.num, derivative.den, plant.num, sensor.num), mult(derivative.num, ctl.den, plant.num, sensor.den));
    const feedback = (num: number[]) => validateTf({ num, den: characteristic, domain: f.domain, sampleTime: f.sampleTime });
    return {
      loop: validateTf({ num: loopNum, den: loopDen, domain: f.domain, sampleTime: f.sampleTime }),
      output: tf(mult(f.num, ctl.num, derivative.den, plant.num, sensor.den)),
      control: tf(mult(f.num, ctl.num, derivative.den, plant.den, sensor.den)),
      sensitivity: feedback(loopDen),
      complementary: feedback(loopNum),
      plantInputDisturbance: feedback(mult(plant.num, ctl.den, derivative.den, sensor.den)),
      measurementNoiseOutput: feedback(polyScale(loopNum, -1)),
      measurementNoiseControl: feedback(polyScale(mult(ctl.num, derivative.den, sensor.den, plant.den), -1)),
    };
  }
  const loopDen = polyAdd(mult(ctl.den, plant.den, sensor.den), mult(ctl.num, plant.num, sensor.num));
  const fullDen = mult(f.den, loopDen);
  const tf = (num: number[]): TransferFunction => validateTf({ num, den: fullDen, domain: f.domain, sampleTime: f.sampleTime });
  const feedbackTf = (num: number[]): TransferFunction => validateTf({ num, den: loopDen, domain: f.domain, sampleTime: f.sampleTime });
  return {
    loop: validateTf({ num: mult(ctl.num, plant.num, sensor.num), den: mult(ctl.den, plant.den, sensor.den), domain: f.domain, sampleTime: f.sampleTime }),
    output: tf(mult(f.num, ctl.num, plant.num, sensor.den)),
    control: tf(mult(f.num, ctl.num, plant.den, sensor.den)),
    sensitivity: validateTf({ num: mult(ctl.den, plant.den, sensor.den), den: loopDen, domain: f.domain, sampleTime: f.sampleTime }),
    complementary: validateTf({ num: mult(ctl.num, plant.num, sensor.num), den: loopDen, domain: f.domain, sampleTime: f.sampleTime }),
    plantInputDisturbance: feedbackTf(mult(plant.num, ctl.den, sensor.den)),
    measurementNoiseOutput: feedbackTf(polyScale(mult(ctl.num, plant.num, sensor.num), -1)),
    measurementNoiseControl: feedbackTf(polyScale(mult(ctl.num, sensor.num, plant.den), -1)),
  };
}
function polynomialAt(p: readonly number[], z: Complex): Complex { return p.reduce((v, k) => add(mul(v, z), c(k)), c(0)); }
/** Durand–Kerner com inicialização circular e refinamento. Raízes conjugadas aparecem preservadas. */
export function polynomialRoots(coefficients: readonly number[]): Complex[] {
  const p = trim([...coefficients]); if (p.length < 2) return [];
  const lead = p[0]!; for (let i = 0; i < p.length; i++) p[i] = p[i]! / lead;
  const n = p.length - 1; if (n > 24) throw new Error("Ordens acima de 24 não são suportadas pelo solucionador atual.");
  const radius = 1 + Math.max(...p.slice(1).map(Math.abs)); let roots = Array.from({ length: n }, (_, i) => c(radius * Math.cos(2 * Math.PI * (i + .25) / n), radius * Math.sin(2 * Math.PI * (i + .25) / n)));
  for (let k = 0; k < 1200; k++) { let err = 0; roots = roots.map((z, i) => { let den = c(1); roots.forEach((w, j) => { if (i !== j) den = mul(den, sub(z, w)); }); if (abs(den) < 1e-28) den = add(den, c(1e-20, 1e-20)); const d = div(polynomialAt(p, z), den); err = Math.max(err, abs(d)); return sub(z, d); }); if (err < 1e-11) break; }
  return roots;
}
export const poles = (tf: TransferFunction): Complex[] => polynomialRoots(tf.den);
/** Internal closed-loop stability depends on the feedback characteristic denominator, not F or a single output path. */
export type StabilityClass = "stable" | "unstable" | "marginal" | "near-boundary";
export function classifyStability(tf: TransferFunction): StabilityClass {
  const model = validateTf(tf), roots = poles(model);
  if (!roots.length) return "stable";
  let boundary = false, near = false;
  for (const pole of roots) {
    const metric = model.domain === "continuous" ? pole.re : abs(pole);
    const edge = model.domain === "continuous" ? 0 : 1;
    if (Math.abs(metric - edge) <= (model.domain === "continuous" ? 1e-9 : 1e-8)) boundary = true;
    else if (Math.abs(metric - edge) <= (model.domain === "continuous" ? 1e-5 : 1e-5)) near = true;
    else if (model.domain === "continuous" ? metric > edge : metric > edge) return "unstable";
  }
  return boundary ? "marginal" : near ? "near-boundary" : "stable";
}
export const isStable = (tf: TransferFunction): boolean => classifyStability(tf) === "stable";
export const zeros = (tf: TransferFunction): Complex[] => polynomialRoots(tf.num);
export function interpretDiscretePole(pole: Complex, sampleTime: number): { principal?: Complex; naturalFrequency?: number; dampingRatio?: number; branchSpacing: number; note: string } {
  if (!(sampleTime > 0) || !Number.isFinite(sampleTime)) throw new Error("Ts must be positive to interpret a discrete pole.");
  const radius = abs(pole), branchSpacing = 2 * Math.PI / sampleTime;
  if (radius === 0) return { branchSpacing, note: "z=0 has no finite logarithmic equivalent; it represents a deadbeat mode." };
  const principal = c(Math.log(radius) / sampleTime, Math.atan2(pole.im, pole.re) / sampleTime);
  const naturalFrequency = abs(principal);
  return { principal, naturalFrequency, dampingRatio: naturalFrequency > 0 ? -principal.re / naturalFrequency : undefined, branchSpacing,
    note: `Principal logarithm; other branches shift imaginary frequency by multiples of ${branchSpacing} rad/s.` };
}
export function evalTf(tf: TransferFunction, s: Complex): Complex { return div(polynomialAt(tf.num, s), polynomialAt(tf.den, s)); }
export const frequencyResponse = (tf: TransferFunction, omega: number): Complex => staticGain(tf) ? evalTf(tf, c(0)) : evalTf(tf, tf.domain === "continuous" ? c(0, omega) : c(Math.cos(omega * tf.sampleTime!), Math.sin(omega * tf.sampleTime!)));
export interface BodePoint { omega: number; magnitudeDb: number; phaseDeg: number }
type BodeSeries = BodePoint[] & { magnitudeExtrema: number[]; coverage: "algebraic-extrema" | "adaptive-only" };
function ascendingTrim(p: number[]): number[] { while (p.length > 1 && p.at(-1) === 0) p.pop(); return p; }
function ascendingAdd(a: readonly number[], b: readonly number[]): number[] { const n = Math.max(a.length,b.length); return ascendingTrim(Array.from({length:n},(_,i)=>(a[i]??0)+(b[i]??0))); }
function ascendingMul(a: readonly number[], b: readonly number[]): number[] { const out=new Array(a.length+b.length-1).fill(0);a.forEach((x,i)=>b.forEach((y,j)=>out[i+j]+=x*y));return ascendingTrim(out); }
function ascendingDerivative(a: readonly number[]): number[] { return a.length<=1?[0]:ascendingTrim(a.slice(1).map((value,index)=>value*(index+1))); }
function ascendingToDescending(a: readonly number[]): number[] { return trim([...a].reverse()); }
function magnitudePolynomialContinuous(coefficients: readonly number[]): number[] {
  let real=[0], imag=[0];
  coefficients.forEach((value,index)=>{const power=coefficients.length-1-index,slot=Math.floor(power/2),target=power%2?imag:real;while(target.length<=slot)target.push(0);target[slot]=value*(Math.floor(power/2)%2?-1:1)});
  return ascendingAdd(ascendingMul(real,real),[0,...ascendingMul(imag,imag)]);
}
function magnitudePolynomialDiscrete(coefficients: readonly number[]): number[] {
  const ascending=[...coefficients].reverse(), degree=ascending.length-1, diagonals=new Array(degree+1).fill(0);
  for(let lag=0;lag<=degree;lag++)for(let index=0;index+lag<=degree;index++)diagonals[lag]+=ascending[index]!*ascending[index+lag]!;
  const chebyshev:[[number[]],[number[]]]|any=[[1],[0,1]];
  for(let n=2;n<=degree;n++)chebyshev[n]=ascendingAdd([0,...chebyshev[n-1]].map((x:number)=>2*x),chebyshev[n-2].map((x:number)=>-x));
  let result=[diagonals[0]!];
  for(let lag=1;lag<=degree;lag++)result=ascendingAdd(result,chebyshev[lag].map((x:number)=>2*diagonals[lag]!*x));
  return result;
}
function algebraicMagnitudeExtrema(tf: TransferFunction): number[] {
  const magnitude=tf.domain==="continuous"?magnitudePolynomialContinuous:magnitudePolynomialDiscrete;
  const numerator=magnitude(tf.num),denominator=magnitude(tf.den);
  const derivative=ascendingAdd(ascendingMul(ascendingDerivative(numerator),denominator),ascendingMul(numerator,ascendingDerivative(denominator)).map(x=>-x));
  const roots=polynomialRoots(ascendingToDescending(derivative));
  return roots.filter(root=>Math.abs(root.im)<1e-7).map(root=>tf.domain==="continuous"?Math.sqrt(root.re):Math.acos(Math.max(-1,Math.min(1,root.re)))/tf.sampleTime!).filter(value=>value>0&&Number.isFinite(value));
}
export function bode(tf: TransferFunction, count = 240): BodeSeries {
  if (tf.domain === "discrete" && !Number.isFinite(tf.sampleTime)) throw new Error("A discrete Bode plot needs a known Ts to define the Nyquist frequency.");
  const ps = [...poles(tf), ...zeros(tf)].map(abs).filter((x) => x > 1e-8 && Number.isFinite(x));
  const nyquist = tf.domain === "discrete" ? Math.PI / tf.sampleTime! : undefined;
  const extrema = algebraicMagnitudeExtrema(tf);
  const high = nyquist ?? Math.max(Math.min(1e5, Math.max(10, (ps.length ? Math.max(...ps) : 1) * 100)), ...extrema);
  // z-plane pole radii are not break frequencies. Sample the physical band up to Nyquist.
  const low = nyquist ? Math.max(1e-8, high / 1e4) : Math.min(Math.max(1e-12, (ps.length ? Math.min(...ps) : 1) / 100), high / 10, ...extrema.map(value=>value/1.05));
  const frequencies = new Set(Array.from({ length: count }, (_, i) => low * (high / low) ** (i / (count - 1))));
  for(const omega of extrema) if(omega<=high) frequencies.add(omega);
  // Add local samples around every finite pole/zero bandwidth so a high-Q resonance does not
  // disappear between adjacent points of the general logarithmic grid.
  for (const root of [...poles(tf), ...zeros(tf)]) {
    const radius = abs(root);
    const center = tf.domain === "continuous" ? Math.abs(root.im) : Math.abs(Math.atan2(root.im, root.re) / tf.sampleTime!);
    const bandwidth = tf.domain === "continuous" ? Math.abs(root.re) : radius > 0 ? Math.abs(Math.log(radius) / tf.sampleTime!) : high;
    if (!(center > 0) || center < low || center > high || !Number.isFinite(bandwidth)) continue;
    const span = Math.max(bandwidth, center * 1e-9);
    for (let i = 0; i <= 120; i++) {
      const omega = center + (i / 120 * 12 - 6) * span;
      if (omega >= low && omega <= high) frequencies.add(omega);
    }
  }
  const result = [...frequencies].sort((a, b) => a - b).map(w => { const z = frequencyResponse(tf, w), phase = Math.atan2(z.im, z.re) * 180 / Math.PI; return { omega: w, magnitudeDb: 20 * Math.log10(Math.max(abs(z), 1e-150)), phaseDeg: phase }; });
  for (let i = 1; i < result.length; i++) {
    const previous = result[i - 1]!.phaseDeg;
    let phase = result[i]!.phaseDeg;
    while (phase - previous > 180) phase -= 360;
    while (phase - previous < -180) phase += 360;
    result[i]!.phaseDeg = phase;
  }
  return Object.assign(result,{magnitudeExtrema:extrema,coverage:"algebraic-extrema" as const}) as BodeSeries;
}
/** Approximate winding of L(jw)+1 over the conjugate Nyquist contour. Returns undefined when a sampled singularity lies on the contour. */
/** Algebraic Nyquist winding from the argument principle; no contour mesh is used. */
export function nyquistEncirclements(tf: TransferFunction): number | undefined {
  const model=validateTf(tf), characteristic=polyAdd(model.den,model.num), openRoots=polynomialRoots(model.den),closedRoots=polynomialRoots(characteristic);
  const unstableCount=(polynomial:readonly number[],roots:Complex[]):number|undefined=>{
    const degree=polynomial.length-1,scale=Math.max(1,...polynomial.map(Math.abs));
    if(roots.some(root=>abs(polynomialAt(polynomial,root))/(scale*Math.max(1,1+abs(root))**degree)>1e-7))return undefined;
    let count=0;
    for(const root of roots){const metric=model.domain==="continuous"?root.re:abs(root),distance=model.domain==="continuous"?Math.abs(metric):Math.abs(metric-1);if(distance<1e-7)return undefined;if(model.domain==="continuous"?metric>0:metric>1)count++;}
    return count;
  };
  const open=unstableCount(model.den,openRoots),closed=unstableCount(characteristic,closedRoots);
  if(open===undefined||closed===undefined)return undefined;
  // The continuous RHP contour uses the opposite orientation from the
  // discrete unit-circle contour (z=e^(jωTs), traversed counter-clockwise).
  return model.domain === "continuous" ? closed-open : open-closed;
}export interface RootLocusPoint { gain: number; roots: Complex[] }
/** Global minimum-distance assignment avoids greedy branch swaps near repeated/crossing roots. */
function associateRootBranches(previous: readonly Complex[], candidates: readonly Complex[]): Complex[] {
  const n = previous.length, u = new Array(n + 1).fill(0), v = new Array(n + 1).fill(0);
  const p = new Array(n + 1).fill(0), way = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(n + 1).fill(Infinity), used = new Array(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0]!;
      let delta = Infinity, j1 = 0;
      for (let j = 1; j <= n; j++) if (!used[j]) {
        const a = previous[i0 - 1]!, b = candidates[j - 1]!;
        const cur = Math.hypot(a.re - b.re, a.im - b.im) - u[i0]! - v[j]!;
        if (cur < minv[j]!) { minv[j] = cur; way[j] = j0; }
        if (minv[j]! < delta) { delta = minv[j]!; j1 = j; }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) { u[p[j]!] += delta; v[j] -= delta; }
        else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]!; p[j0] = p[j1]; j0 = j1; } while (j0 !== 0);
  }
  const ordered = new Array<Complex>(n);
  for (let j = 1; j <= n; j++) ordered[p[j]! - 1] = candidates[j - 1]!;
  return ordered;
}
/** Varre ganhos logarítmicos em k·C₀(s)G(s)H(s); sem cancelamentos automáticos. */
export type RootLocusSeries = RootLocusPoint[] & { converged: boolean; maxRelativeResidual: number };
export function rootLocus(openLoop: TransferFunction, minGain = 1e-3, maxGain = 1e3, samples = 90): RootLocusSeries {
  if (!(minGain > 0) || !(maxGain > minGain) || samples < 2) throw new Error("Root-locus gain interval and sample count are invalid.");
  let maxRelativeResidual=0,unresolved=false;
  const solve = (gain: number, previous?: Complex[]): RootLocusPoint => {
    const characteristic=polyAdd(openLoop.den,polyScale(openLoop.num,gain));let roots=polynomialRoots(characteristic);
    const scale=Math.max(1,...characteristic.map(Math.abs));for(const root of roots)maxRelativeResidual=Math.max(maxRelativeResidual,abs(polynomialAt(characteristic,root))/(scale*Math.max(1,1+abs(root))**(characteristic.length-1)));
    if (previous && roots.length === previous.length) roots = associateRootBranches(previous, roots);
    return { gain, roots };
  };
  const initial: RootLocusPoint[] = [];
  for (let i = 0; i < samples; i++) initial.push(solve(minGain * (maxGain / minGain) ** (i / (samples - 1)), initial[initial.length - 1]?.roots));
  const result: RootLocusPoint[] = [initial[0]!], maxPoints = Math.max(samples, 8192);
  const refine = (left: RootLocusPoint, right: RootLocusPoint, depth: number): void => {
    if(left.roots.length!==right.roots.length){unresolved=true;result.push(right);return;}
    const gain = Math.sqrt(left.gain * right.gain), middle = solve(gain, left.roots);
    const scale = Math.max(1, ...left.roots.map((p) => Math.hypot(p.re, p.im)), ...right.roots.map((p) => Math.hypot(p.re, p.im)));
    let curvature = 0, travel = 0;
    for (let i = 0; i < middle.roots.length; i++) {
      const a = left.roots[i]!, b = right.roots[i]!, m = middle.roots[i]!;
      curvature = Math.max(curvature, Math.hypot(m.re - (a.re + b.re) / 2, m.im - (a.im + b.im) / 2) / scale);
      travel = Math.max(travel, Math.hypot(b.re - a.re, b.im - a.im) / scale);
    }
    if(curvature>.003||travel>.08){if(depth>=14||result.length>=maxPoints-1){unresolved=true;result.push(right);return;}refine(left,middle,depth+1);refine(middle,right,depth+1);}
    else result.push(right);
  };
  for (let i = 1; i < initial.length; i++) refine(result[result.length - 1]!, initial[i]!, 0);
  return Object.assign(result,{converged:!unresolved&&maxRelativeResidual<1e-7,maxRelativeResidual}) as RootLocusSeries;
}
export interface TimeSample { time: number; value: number }
export interface TimeResponse { samples: TimeSample[]; stable: boolean; directFeedthrough: number; converged: boolean }
/** Simulates an explicit sampled input with zero initial state using the discrete difference equation. */
export function timeResponseForInput(tf: TransferFunction, input: readonly number[]): TimeResponse {
  const model = validateTf(tf);
  if (model.domain !== "discrete") throw new Error("Arbitrary sampled inputs require a discrete model.");
  if (!input.length || input.some((value) => !Number.isFinite(value))) throw new Error("Provide a non-empty finite sample sequence.");
  const dt = model.sampleTime!, den = model.den.map((value) => value / model.den[0]!), num = model.num.map((value) => value / model.den[0]!);
  const b = [...new Array(den.length - num.length).fill(0), ...num], outputs: number[] = [], samples: TimeSample[] = [];
  for (let k = 0; k < input.length; k++) {
    let y = 0;
    for (let j = 0; j < b.length; j++) if (k - j >= 0) y += b[j]! * input[k - j]!;
    for (let j = 1; j < den.length; j++) if (k - j >= 0) y -= den[j]! * outputs[k - j]!;
    outputs.push(y); samples.push({ time: k * dt, value: y });
  }
  return { samples, stable: classifyStability(model) === "stable", directFeedthrough: b[0] ?? 0,
    converged: classifyStability(model) === "stable" && samples.every((sample) => Number.isFinite(sample.value)) };
}

/** Closed-loop zero-input response for a nonzero initial plant state with static C and H.
 * The original A/B/C/D realization is used directly, preserving hidden internal modes. */
export function closedLoopInitialStateResponse(plant: { A: number[][]; B: number[]; C: number[]; D: number }, initial: readonly number[], controller: TransferFunction, sensor: TransferFunction, duration?: number, count = 500): TimeResponse {
  const ctl = validateTf(controller), h = validateTf(sensor);
  if (ctl.den.length !== 1 || h.den.length !== 1) throw new Error("A resposta por condição inicial da planta exige C e H estáticos; estados iniciais de controladores dinâmicos ainda não são editáveis.");
  const n = plant.A.length;
  if (!n || plant.A.some(row => row.length !== n) || plant.B.length !== n || plant.C.length !== n || initial.length !== n || initial.some(v => !Number.isFinite(v))) throw new Error("O vetor x₀ deve ter exatamente uma entrada finita por estado da planta.");
  const k = (ctl.num[0]! / ctl.den[0]!) * (h.num[0]! / h.den[0]!), den = 1 + k * plant.D;
  if (Math.abs(den) < 1e-12) throw new Error("A interconexão algébrica de malha fechada é singular (1 + C·H·D = 0).");
  const closedA = plant.A.map((row, i) => row.map((a, j) => a - plant.B[i]! * k * plant.C[j]! / den));
  const outputC = plant.C.map(v => v / den); let x = [...initial]; const stabilityModel = stateSpaceToTf({ A: closedA, B: plant.B, C: outputC, D: 0, domain: ctl.domain, sampleTime: ctl.sampleTime }); const stable = classifyStability(stabilityModel) === "stable";
  const horizon = duration ?? (ctl.domain === "discrete" ? (ctl.sampleTime ?? .1) * 200 : Math.min(100, Math.max(5, ...poles(stateSpaceToTf({ ...plant, domain: "continuous" })).map(p => 8 / Math.max(.04, Math.abs(p.re))))));
  const samples: TimeSample[] = [];
  if (ctl.domain === "discrete") {
    const dt = ctl.sampleTime!; const steps = Math.min(count, Math.max(1, Math.ceil(horizon / dt)));
    for (let step = 0; step < steps; step++) {
      const y = outputC.reduce((sum, value, i) => sum + value * x[i]!, 0);
      samples.push({ time: step * dt, value: y });
      const next = closedA.map(row => row.reduce((sum, value, i) => sum + value * x[i]!, 0));
      for (let i = 0; i < n; i++) x[i] = next[i]!;
    }
  } else {
    const dt = horizon / Math.max(1, count - 1);
    const derivative = (state: number[]) => closedA.map(row => row.reduce((sum, value, i) => sum + value * state[i]!, 0));
    const addScaled = (state: number[], delta: number[], scale: number) => state.map((value, i) => value + delta[i]! * scale);
    for (let step = 0; step < count; step++) {
      const y = outputC.reduce((sum, value, i) => sum + value * x[i]!, 0); samples.push({ time: step * dt, value: y });
      if (step === count - 1) break;
      const a = derivative(x), b = derivative(addScaled(x, a, dt / 2)), c = derivative(addScaled(x, b, dt / 2)), d = derivative(addScaled(x, c, dt));
      x = x.map((value, i) => value + dt * (a[i]! + 2 * b[i]! + 2 * c[i]! + d[i]!) / 6);
    }
  }
  return { samples, stable, directFeedthrough: 0, converged: samples.every(sample => Number.isFinite(sample.value)) };
}
/** RK4 em forma companheira. Época de impulso no termo direto é indicada separadamente como delta. */
export function timeResponse(tf: TransferFunction, kind: "step" | "ramp" | "impulse" = "step", duration?: number, count = 500): TimeResponse {
  validateTf(tf);
  if (tf.domain === "discrete" && !Number.isFinite(tf.sampleTime)) throw new Error("A discrete time response needs a known Ts.");
  const pp = poles(tf), stable = classifyStability(tf) === "stable";
  const horizon = duration ?? (tf.domain === "discrete" ? tf.sampleTime! * 200 : Math.min(100, Math.max(5, ...pp.map((p) => 8 / Math.max(.04, Math.abs(p.re))))));
  if (tf.domain === "discrete") {
    const dt = tf.sampleTime!, n = Math.min(count, Math.ceil(horizon / dt)), den = tf.den.map((x) => x / tf.den[0]!), num = tf.num.map((x) => x / tf.den[0]!);
    const ys: number[] = [], samples: TimeSample[] = [], b = [...new Array(den.length - num.length).fill(0), ...num];
    for (let k = 0; k < n; k++) {
      let y = 0; for (let j = 0; j < b.length; j++) { const ix = k - j; if (ix >= 0) y += b[j]! * (kind === "impulse" ? (ix === 0 ? 1 : 0) : kind === "step" ? 1 : ix * dt); }
      for (let j = 1; j < den.length; j++) { const ix = k - j; if (ix >= 0) y -= den[j]! * ys[ix]!; }
      ys.push(y); samples.push({ time: k * dt, value: Number.isFinite(y) ? y : NaN });
    }
    return { samples, stable, directFeedthrough: b[0] ?? 0, converged: stable && samples.every((s) => Number.isFinite(s.value)) };
  }
  const den = tf.den.map((x) => x / tf.den[0]!), n = den.length - 1, num0 = new Array(n + 1 - tf.num.length).fill(0), num = [...num0, ...tf.num.map((x) => x / tf.den[0]!)];
  const D = num[0] ?? 0, C = Array.from({ length: n }, (_, j) => (num[n - j] ?? 0) - den[n - j]! * D);
  const dt = horizon / Math.max(1, count - 1), x = new Array(n).fill(0), samples: TimeSample[] = [];
  if (kind === "impulse" && n > 0) x[n - 1] = 1;
  const deriv = (state: number[], time: number): number[] => {
    const out = new Array(n).fill(0); for (let i = 0; i < n - 1; i++) out[i] = state[i + 1]!;
    let value = kind === "impulse" ? 0 : kind === "step" ? 1 : time;
    // Input derivative terms for relative degree zero are represented by direct feedthrough.
    if (kind === "impulse") value = 0;
    out[n - 1] = value - den.slice(1).reduce((sum, a, i) => sum + a * state[n - 1 - i]!, 0);
    return out;
  };
  const output = (state: number[], time: number) => C.reduce((sum, a, i) => sum + a * state[i]!, D * (kind === "step" ? 1 : kind === "ramp" ? time : 0));
  for (let k = 0; k < count; k++) {
    const t = k * dt; samples.push({ time: t, value: output(x, t) });
    if (k === count - 1) break;
    const addScaled = (a: number[], b: number[], f: number) => a.map((v, i) => v + b[i]! * f), k1 = deriv(x, t), k2 = deriv(addScaled(x, k1, dt / 2), t + dt / 2), k3 = deriv(addScaled(x, k2, dt / 2), t + dt / 2), k4 = deriv(addScaled(x, k3, dt), t + dt);
    for (let i = 0; i < n; i++) x[i] += dt / 6 * (k1[i]! + 2 * k2[i]! + 2 * k3[i]! + k4[i]!);
  }
  return { samples, stable, directFeedthrough: D, converged: stable && samples.every((s) => Number.isFinite(s.value)) };
}
export interface MarginResult { gainCrossovers: number[]; phaseCrossovers: number[]; phaseMargins: number[]; gainMarginsDb: number[] }
export function margins(tf: TransferFunction, points: BodePoint[] = bode(tf, 1200)): MarginResult {
  const gainCrossovers: number[] = [], phaseCrossovers: number[] = [], phaseMargins: number[] = [], gainMarginsDb: number[] = [];
  const crossing = (a: number, b: number, target = 0): number | undefined => {
    const left = a - target, right = b - target;
    // Own a sample exactly on a crossing by the segment ending there. This prevents
    // a crossover at a sampled point from being counted again by the next segment.
    if (left === 0 || (left < 0 && right < 0) || (left > 0 && right > 0) || left === right) return undefined;
    return Math.max(0, Math.min(1, -left / (right - left)));
  };
  const refine = (a: BodePoint, b: BodePoint, target: number, fraction: number,
                  valueAt: (omega: number, expected: number) => number): { omega: number; value: number } => {
    if (fraction === 1) return { omega: b.omega, value: target };
    let lo = Math.log(a.omega), hi = Math.log(b.omega);
    let flo = a.magnitudeDb, fhi = b.magnitudeDb;
    // Phase crossings use the unwrapped phase as the scalar function instead of dB.
    if (valueAt === phaseAt) { flo = a.phaseDeg; fhi = b.phaseDeg; }
    const interpolate = (x: number) => a.magnitudeDb + x * (b.magnitudeDb - a.magnitudeDb);
    let initial = lo + fraction * (hi - lo);
    if (lo >= hi || flo === fhi || (flo - target) * (fhi - target) > 0) {
      const omega = Math.exp(initial);
      return { omega, value: valueAt(omega, valueAt === phaseAt ? a.phaseDeg + fraction * (b.phaseDeg - a.phaseDeg) : interpolate(fraction)) };
    }
    for (let iteration = 0; iteration < 48; iteration++) {
      const mid = (lo + hi) / 2, omega = Math.exp(mid);
      const expected = valueAt === phaseAt ? a.phaseDeg + (mid - Math.log(a.omega)) / (Math.log(b.omega) - Math.log(a.omega)) * (b.phaseDeg - a.phaseDeg) : 0;
      const value = valueAt(omega, expected);
      if ((flo - target) * (value - target) <= 0) { hi = mid; fhi = value; }
      else { lo = mid; flo = value; }
    }
    initial = (lo + hi) / 2;
    const omega = Math.exp(initial);
    const expected = valueAt === phaseAt ? a.phaseDeg + (initial - Math.log(a.omega)) / (Math.log(b.omega) - Math.log(a.omega)) * (b.phaseDeg - a.phaseDeg) : 0;
    return { omega, value: valueAt(omega, expected) };
  };
  const magnitudeAt = (omega: number) => 20 * Math.log10(Math.max(abs(frequencyResponse(tf, omega)), 1e-150));
  const phaseAt = (omega: number, expected: number) => {
    const response = frequencyResponse(tf, omega);
    const wrapped = Math.atan2(response.im, response.re) * 180 / Math.PI;
    return wrapped + 360 * Math.round((expected - wrapped) / 360);
  };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    const gainFraction = crossing(a.magnitudeDb, b.magnitudeDb);
    if (gainFraction !== undefined) {
      const root = refine(a, b, 0, gainFraction, (omega) => magnitudeAt(omega));
      const expectedPhase = a.phaseDeg + gainFraction * (b.phaseDeg - a.phaseDeg);
      gainCrossovers.push(root.omega);
      phaseMargins.push(180 + phaseAt(root.omega, expectedPhase));
    }
    const phaseLow = Math.min(a.phaseDeg, b.phaseDeg), phaseHigh = Math.max(a.phaseDeg, b.phaseDeg);
    // Targets are odd multiples of 180°: ..., -540°, -180°, 180°, ...
    // Anchor the sequence at the first target at or above the segment minimum.
    const firstTarget = Math.ceil((phaseLow - 180) / 360) * 360 + 180;
    for (let target = firstTarget; target <= phaseHigh; target += 360) {
      if (target < phaseLow) continue;
      const phaseFraction = crossing(a.phaseDeg, b.phaseDeg, target);
      if (phaseFraction === undefined) continue;
      const root = refine(a, b, target, phaseFraction, phaseAt);
      phaseCrossovers.push(root.omega);
      gainMarginsDb.push(-magnitudeAt(root.omega));
    }
  }
  return { gainCrossovers, phaseCrossovers, phaseMargins, gainMarginsDb };
}
export function stepMetrics(samples: readonly TimeSample[], expectedFinal?: number): { finalValue?: number; overshootPercent?: number; settlingTime?: number; riseTime?: number; peakTime?: number; status: "settled" | "not-settled" | "undefined" } {
  if (samples.length < 2 || samples.some((s) => !Number.isFinite(s.value))) return { status: "undefined" };
  const finalValue = Number.isFinite(expectedFinal) ? expectedFinal! : samples[samples.length - 1]!.value, direction = finalValue < 0 ? -1 : 1;
  const peakIndex = samples.reduce((best, sample, index) => sample.value * direction > samples[best]!.value * direction ? index : best, 0);
  const peak = samples[peakIndex]!.value, band = Math.max(Math.abs(finalValue) * .02, 1e-9);
  let lastOutside = -1; samples.forEach((s, i) => { if (Math.abs(s.value - finalValue) > band) lastOutside = i; });
  const settled = lastOutside < samples.length - 1;
  const crossing = (fraction: number) => {
    const index = samples.findIndex((sample) => sample.value * direction >= Math.abs(finalValue) * fraction);
    return index >= 0 ? samples[index]!.time : undefined;
  };
  const t10 = crossing(.1), t90 = crossing(.9);
  return { finalValue, overshootPercent: Math.abs(finalValue) > 1e-12 ? Math.max(0, (peak * direction - Math.abs(finalValue)) / Math.abs(finalValue) * 100) : undefined,
    settlingTime: settled ? samples[Math.max(0, lastOutside + 1)]!.time : undefined, riseTime: t10 !== undefined && t90 !== undefined ? t90 - t10 : undefined,
    peakTime: samples[peakIndex]!.time, status: settled ? "settled" : "not-settled" };
}
