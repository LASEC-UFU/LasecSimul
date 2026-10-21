import type { Complex, TransferFunction } from "./lti.js";
import { frequencyResponse, validateTf } from "./lti.js";
import type { TimeUnit } from "./types.js";
import { CONTROL_DESIGN_FREQUENCY_UNITS } from "./types.js";
import { frdFrequencyToRadPerSecond, type FrdFrequencyUnit } from "./frequencyUnits.js";

export interface FrdFitInput {
  frequency: number[];
  response: Complex[];
  frequencyUnit?: FrdFrequencyUnit;
  timeUnit?: TimeUnit;
  domain: "continuous" | "discrete";
  sampleTime?: number;
  order: number;
}
export interface FrdFitResult {
  model: TransferFunction;
  frequencyRadPerSecond: number[];
  relativeRmsError: number;
  maximumRelativeError: number;
}

/** Parse the magnitude-only, piecewise loop-shape profile used by MATLAB's FRD target. */
export function parseFrdMagnitudeProfile(text: string): { frequencyRadPerSecond: number[]; response: Complex[] } {
  const rows = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (rows.length < 2 || rows.length > 5000) throw new Error("Informe de 2 a 5000 pontos FRD, um por linha: frequencia (rad/s), magnitude (dB).");
  const frequencyRadPerSecond: number[] = [], response: Complex[] = [];
  for (const [index, row] of rows.entries()) {
    const columns = row.split(/[\s,]+/).filter(Boolean).map(Number);
    if (columns.length !== 2 || columns.some(value => !Number.isFinite(value)) || columns[0]! <= 0 || columns[1]! < -600 || columns[1]! > 600)
      throw new Error(`Ponto FRD ${index + 1} inválido; use frequência positiva e magnitude entre -600 e 600 dB.`);
    if (index && columns[0]! <= frequencyRadPerSecond[index - 1]!) throw new Error("As frequências FRD devem estar em ordem estritamente crescente.");
    frequencyRadPerSecond.push(columns[0]!);
    response.push({ re: 10 ** (columns[1]! / 20), im: 0 });
  }
  return { frequencyRadPerSecond, response };
}

/** MATLAB FRD interpolation is linear in frequency and complex response; extrapolation is undefined. */
export function interpolateFrdResponse(frequencyRadPerSecond: readonly number[], response: readonly Complex[], omega: number): Complex {
  if (frequencyRadPerSecond.length !== response.length || frequencyRadPerSecond.length < 2 || !Number.isFinite(omega)) throw new Error("FRD interpolation needs matching frequency and response vectors.");
  if (omega < frequencyRadPerSecond[0]! || omega > frequencyRadPerSecond.at(-1)!) throw new Error(`Frequency ${omega} rad/s is outside the measured FRD range (${frequencyRadPerSecond[0]}–${frequencyRadPerSecond.at(-1)} rad/s).`);
  let right = frequencyRadPerSecond.findIndex(value => value >= omega);
  if (right < 0) right = frequencyRadPerSecond.length - 1;
  if (frequencyRadPerSecond[right] === omega || right === 0) return { ...response[right]! };
  const left = right - 1, fraction = (omega - frequencyRadPerSecond[left]!) / (frequencyRadPerSecond[right]! - frequencyRadPerSecond[left]!);
  const a = response[left]!, b = response[right]!;
  return { re: a.re + fraction * (b.re - a.re), im: a.im + fraction * (b.im - a.im) };
}

export interface FrdMarginResult { gainCrossovers: number[]; phaseCrossovers: number[]; phaseMargins: number[]; gainMarginsDb: number[] }
/** Estimate SISO margins by linear complex interpolation of the measured FRD response. */
export function frdMargins(frequencyRadPerSecond: readonly number[], response: readonly Complex[]): FrdMarginResult {
  if (frequencyRadPerSecond.length !== response.length || frequencyRadPerSecond.length < 2) throw new Error("FRD margins need matching frequency and response vectors.");
  let previousPhase: number | undefined;
  const points = frequencyRadPerSecond.map((omega, index) => {
    const z = response[index]!, magnitudeDb = 20 * Math.log10(Math.max(1e-150, Math.hypot(z.re, z.im)));
    let phaseDeg = Math.atan2(z.im, z.re) * 180 / Math.PI;
    if (previousPhase !== undefined) phaseDeg += 360 * Math.round((previousPhase - phaseDeg) / 360);
    previousPhase = phaseDeg;
    return { omega, magnitudeDb, phaseDeg };
  });
  const gainCrossovers: number[] = [], phaseCrossovers: number[] = [], phaseMargins: number[] = [], gainMarginsDb: number[] = [];
  const phaseAt = (omega: number, expected: number) => { const z = interpolateFrdResponse(frequencyRadPerSecond, response, omega), principal = Math.atan2(z.im, z.re) * 180 / Math.PI; return principal + 360 * Math.round((expected - principal) / 360); };
  const magnitudeAt = (omega: number) => { const z = interpolateFrdResponse(frequencyRadPerSecond, response, omega); return 20 * Math.log10(Math.max(1e-150, Math.hypot(z.re, z.im))); };
  const bisect = (a: number, b: number, target: number, valueAt: (omega: number, expected: number) => number, phase: boolean, expectedA: number, expectedB: number) => {
    let lo = a, hi = b, flo = (phase ? expectedA : magnitudeAt(a)) - target;
    for (let iteration = 0; iteration < 52; iteration++) { const mid = (lo + hi) / 2, fraction = (mid - a) / (b - a), expected = expectedA + fraction * (expectedB - expectedA), value = valueAt(mid, expected) - target; if (flo * value <= 0) hi = mid; else { lo = mid; flo = value; } }
    return (lo + hi) / 2;
  };
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]!, b = points[index]!;
    if ((a.magnitudeDb < 0 && b.magnitudeDb > 0) || (a.magnitudeDb > 0 && b.magnitudeDb < 0) || (b.magnitudeDb === 0 && a.magnitudeDb !== 0)) {
      const omega = b.magnitudeDb === 0 ? b.omega : bisect(a.omega, b.omega, 0, (w) => magnitudeAt(w), false, a.magnitudeDb, b.magnitudeDb), fraction = (omega - a.omega) / (b.omega - a.omega), expected = a.phaseDeg + fraction * (b.phaseDeg - a.phaseDeg);
      gainCrossovers.push(omega); phaseMargins.push(180 + phaseAt(omega, expected));
    }
    const low = Math.min(a.phaseDeg, b.phaseDeg), high = Math.max(a.phaseDeg, b.phaseDeg), firstTarget = 180 + 360 * Math.ceil((low - 180) / 360);
    for (let target = firstTarget; target <= high; target += 360) {
      if (target === a.phaseDeg) continue;
      const omega = target === b.phaseDeg ? b.omega : bisect(a.omega, b.omega, target, phaseAt, true, a.phaseDeg, b.phaseDeg), db = magnitudeAt(omega);
      phaseCrossovers.push(omega); gainMarginsDb.push(-db);
    }
  }
  return { gainCrossovers, phaseCrossovers, phaseMargins, gainMarginsDb };
}

function multiply(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array(a.length + b.length - 1).fill(0) as number[];
  a.forEach((x, i) => b.forEach((y, j) => out[i + j]! += x * y));
  return out;
}

/** Converts measured SISO FRD samples to a stable, real-pole rational approximation. */
export function fitFrdStableRealPoles(input: FrdFitInput): FrdFitResult {
  const { frequency, response, domain, order } = input;
  if (!Array.isArray(frequency) || !Array.isArray(response) || frequency.length !== response.length || frequency.length < 4 || frequency.length > 400) {
    throw new Error("FRD requires 4 to 400 matching frequency and response samples.");
  }
  if (!Number.isInteger(order) || order < 1 || order > 8 || frequency.length < 2 * (order + 1)) {
    throw new Error("FRD fit order must be 1–8 and needs at least 2(order+1) samples.");
  }
  if (domain === "discrete" && (!(input.sampleTime! > 0) || !Number.isFinite(input.sampleTime))) throw new Error("A discrete FRD model needs a positive sample time.");
  const unit = input.frequencyUnit ?? "rad/s";
  if (!(CONTROL_DESIGN_FREQUENCY_UNITS as readonly string[]).includes(unit) && unit !== "rad/TimeUnit" && unit !== "cycles/TimeUnit") throw new Error("Unsupported FRD frequency unit.");
  if (domain === "continuous" && unit === "rad/sample") throw new Error("rad/sample FRD data requires a discrete project and sample time.");
  const toRadPerSecond = (value: number) => frdFrequencyToRadPerSecond(value, unit, input.sampleTime ?? 1, input.timeUnit);
  const omega = frequency.map(toRadPerSecond);
  if (omega.some((value, i) => !(value > 0 && Number.isFinite(value)) || i > 0 && value <= omega[i - 1]!) || response.some(value => !Number.isFinite(value.re) || !Number.isFinite(value.im))) {
    throw new Error("FRD frequencies must be positive and increasing, and response data must be finite.");
  }
  const sampleTime = domain === "discrete" ? input.sampleTime : undefined;
  const nyquist = domain === "discrete" ? Math.PI / sampleTime! : Infinity;
  if (omega.at(-1)! > nyquist * (1 + 1e-12)) throw new Error("FRD frequency samples must not exceed Nyquist.");

  const minPole = Math.max(omega[0]! / 100, 1e-8), maxPole = Math.min(omega.at(-1)! * 100, domain === "discrete" ? 50 / sampleTime! : Number.MAX_VALUE);
  if (!(maxPole > minPole)) throw new Error("FRD frequency span is too narrow for a stable-pole fit.");
  const logLow = Math.log(minPole), logHigh = Math.log(maxPole), gridSize = 48;
  const responseScale = Math.sqrt(response.reduce((sum, value) => sum + value.re * value.re + value.im * value.im, 0) / response.length) || 1;

  type Fit = { residues: number[]; error: number };
  const fitAt = (poles: readonly number[]): Fit => {
    const columns = poles.length + 1, matrix: number[][] = [], target: number[] = [];
    for (let i = 0; i < omega.length; i++) {
      const w = omega[i]!, value = response[i]!, re: number[] = [1], im: number[] = [0];
      for (const pole of poles) {
        if (domain === "continuous") {
          const d = pole * pole + w * w;
          re.push(pole / d); im.push(-w / d);
        } else {
          const angle = w * sampleTime!, zr = Math.cos(angle), zi = Math.sin(angle), dr = zr - Math.exp(-pole * sampleTime!), d = dr * dr + zi * zi;
          re.push(dr / d); im.push(-zi / d);
        }
      }
      matrix.push(re); target.push(value.re); matrix.push(im); target.push(value.im);
    }
    const norms = Array.from({ length: columns }, (_, j) => Math.hypot(...matrix.map(row => row[j]!)));
    if (norms.some(norm => !(norm > 1e-14 && Number.isFinite(norm)))) throw new Error("FRD fit is numerically singular; reduce the requested order.");
    const q: number[][] = [], r = Array.from({ length: columns }, () => new Array(columns).fill(0) as number[]);
    for (let j = 0; j < columns; j++) {
      let v = matrix.map(row => row[j]! / norms[j]!);
      for (let pass = 0; pass < 2; pass++) for (let k = 0; k < j; k++) {
        const projection = q[k]!.reduce((sum, item, row) => sum + item * v[row]!, 0);
        r[k]![j] = r[k]![j]! + projection;
        v = v.map((item, row) => item - projection * q[k]![row]!);
      }
      const diagonal = Math.hypot(...v);
      if (!(diagonal > 1e-11)) throw new Error("FRD fit is numerically singular; reduce the requested order.");
      r[j]![j] = diagonal; q.push(v.map(item => item / diagonal));
    }
    const projected = q.map(column => column.reduce((sum, item, row) => sum + item * target[row]!, 0)), scaled = new Array(columns).fill(0) as number[];
    for (let row = columns - 1; row >= 0; row--) scaled[row] = (projected[row]! - r[row]!.slice(row + 1).reduce((sum, value, index) => sum + value * scaled[row + 1 + index]!, 0)) / r[row]![row]!;
    const coefficients = scaled.map((value, i) => value / norms[i]!);
    let squared = 0;
    for (let i = 0; i < omega.length; i++) {
      let re = coefficients[0]!, im = 0;
      for (let j = 0; j < poles.length; j++) { const w = omega[i]!, pole = poles[j]!;
        if (domain === "continuous") { const d = pole * pole + w * w; re += coefficients[j + 1]! * pole / d; im -= coefficients[j + 1]! * w / d; }
        else { const angle = w * sampleTime!, zr = Math.cos(angle), zi = Math.sin(angle), dr = zr - Math.exp(-pole * sampleTime!), d = dr * dr + zi * zi; re += coefficients[j + 1]! * dr / d; im -= coefficients[j + 1]! * zi / d; }
      }
      squared += (re - response[i]!.re) ** 2 + (im - response[i]!.im) ** 2;
    }
    return { residues: coefficients, error: Math.sqrt(squared / response.length) / responseScale };
  };

  let poles = Array.from({ length: order }, (_, i) => Math.exp(logLow + (logHigh - logLow) * (i + 1) / (order + 1)));
  let best = fitAt(poles);
  const separated = (candidate: number, index: number) => poles.every((pole, other) => other === index || Math.abs(Math.log(candidate / pole)) >= 0.025);
  let searchStep = (logHigh - logLow) / (gridSize - 1);
  for (let pass = 0; pass < 4; pass++) {
    for (let index = 0; index < order; index++) {
      let localBest = best, localPole = poles[index]!;
      const candidates = pass === 0
        ? Array.from({ length: gridSize }, (_, i) => Math.exp(logLow + (logHigh - logLow) * i / (gridSize - 1)))
        : Array.from({ length: 25 }, (_, i) => Math.exp(Math.max(logLow, Math.min(logHigh, Math.log(poles[index]!) + (i - 12) * searchStep))));
      for (const candidate of candidates) {
        if (!separated(candidate, index)) continue;
        const next = poles.map((pole, i) => i === index ? candidate : pole);
        try { const fit = fitAt(next); if (fit.error < localBest.error) { localBest = fit; localPole = candidate; } } catch { /* skip singular trial poles */ }
      }
      poles[index] = localPole; best = localBest;
    }
    searchStep /= 10;
  }

  let denominator = [1];
  const factors = poles.map(pole => domain === "continuous" ? [1, pole] : [1, -Math.exp(-pole * sampleTime!)]);
  for (const factor of factors) denominator = multiply(denominator, factor);
  const numerator = denominator.map((value, i) => value * best.residues[0]!);
  for (let i = 0; i < factors.length; i++) {
    let other = [1]; for (let j = 0; j < factors.length; j++) if (i !== j) other = multiply(other, factors[j]!);
    for (let j = 0; j < other.length; j++) numerator[j]! += other[j]! * best.residues[i + 1]!;
  }
  const model = validateTf({ num: numerator, den: denominator, domain, sampleTime });
  const relativeErrors = response.map((value, i) => {
    const w = omega[i]!, x = domain === "continuous" ? { re: 0, im: w } : { re: Math.cos(w * sampleTime!), im: Math.sin(w * sampleTime!) };
    const evaluate = (coefficients: readonly number[]) => { let re = coefficients[0]!, im = 0; for (const coefficient of coefficients.slice(1)) { const nextRe = re * x.re - im * x.im + coefficient, nextIm = re * x.im + im * x.re; re = nextRe; im = nextIm; } return { re, im }; };
    const n = evaluate(model.num), d = evaluate(model.den), den = d.re * d.re + d.im * d.im, predicted = { re: (n.re * d.re + n.im * d.im) / den, im: (n.im * d.re - n.re * d.im) / den };
    return Math.hypot(predicted.re - value.re, predicted.im - value.im) / Math.max(responseScale * 1e-8, Math.hypot(value.re, value.im));
  });
  return { model, frequencyRadPerSecond: omega, relativeRmsError: best.error, maximumRelativeError: Math.max(...relativeErrors) };
}

type FrdFitMode = { kind: "real"; decay: number } | { kind: "pair"; decay: number; frequency: number };

/** Fit a real-coefficient stable model with conjugate pole pairs (and an optional real pole). */
function fitFrdConjugatePairs(input: FrdFitInput): FrdFitResult {
  const { frequency, response, domain, order } = input;
  const unit = input.frequencyUnit ?? "rad/s";
  const omega = frequency.map(value => frdFrequencyToRadPerSecond(value, unit, input.sampleTime ?? 1, input.timeUnit));
  const sampleTime = domain === "discrete" ? input.sampleTime! : 0;
  const low = Math.max(omega[0]! / 100, 1e-8), high = Math.min(omega.at(-1)! * 100, domain === "discrete" ? 50 / sampleTime : Number.MAX_VALUE);
  const frequencyLow = Math.max(omega[0]! / 2, low), frequencyHigh = Math.min(omega.at(-1)!, domain === "discrete" ? Math.PI / sampleTime * .999 : Number.MAX_VALUE);
  if (!(high > low) || !(frequencyHigh > frequencyLow)) throw new Error("FRD frequency span is too narrow for complex-pole fitting.");
  const logLow = Math.log(low), logHigh = Math.log(high), logFrequencyLow = Math.log(frequencyLow), logFrequencyHigh = Math.log(frequencyHigh), gridSize = 32;
  const responseScale = Math.sqrt(response.reduce((sum, value) => sum + value.re * value.re + value.im * value.im, 0) / response.length) || 1;
  const pairCount = Math.floor(order / 2), realCount = order % 2;
  const modes: FrdFitMode[] = Array.from({ length: realCount }, (_, i) => ({ kind: "real", decay: Math.exp(logLow + (logHigh - logLow) * (i + 1) / (realCount + 1)) }));
  for (let i = 0; i < pairCount; i++) modes.push({ kind: "pair", decay: Math.exp(logLow + (logHigh - logLow) * (i + 1) / (pairCount + 1)), frequency: Math.exp(logFrequencyLow + (logFrequencyHigh - logFrequencyLow) * (i + 1) / (pairCount + 1)) });

  type Fit = { coefficients: number[]; error: number };
  const basis = (mode: FrdFitMode, w: number): Array<{ re: number; im: number }> => {
    if (mode.kind === "real") {
      if (domain === "continuous") { const d = mode.decay * mode.decay + w * w; return [{ re: mode.decay / d, im: -w / d }]; }
      const angle = w * sampleTime, zr = Math.cos(angle), zi = Math.sin(angle), radius = Math.exp(-mode.decay * sampleTime), dr = zr - radius, d = dr * dr + zi * zi;
      return [{ re: dr / d, im: -zi / d }];
    }
    if (domain === "continuous") {
      const dr = mode.decay * mode.decay + mode.frequency * mode.frequency - w * w, di = 2 * mode.decay * w, d = dr * dr + di * di;
      return [{ re: w * di / d, im: w * dr / d }, { re: dr / d, im: -di / d }];
    }
    const angle = w * sampleTime, zr = Math.cos(angle), zi = Math.sin(angle), radius = Math.exp(-mode.decay * sampleTime), poleAngle = mode.frequency * sampleTime;
    const dr = zr * zr - zi * zi - 2 * radius * Math.cos(poleAngle) * zr + radius * radius, di = 2 * zr * zi - 2 * radius * Math.cos(poleAngle) * zi, d = dr * dr + di * di;
    return [{ re: (zr * dr + zi * di) / d, im: (zi * dr - zr * di) / d }, { re: dr / d, im: -di / d }];
  };
  const columnCount = () => 1 + modes.reduce((sum, mode) => sum + (mode.kind === "pair" ? 2 : 1), 0);
  const fitAt = (): Fit => {
    const columns = columnCount(), matrix: number[][] = [], target: number[] = [];
    for (let i = 0; i < omega.length; i++) {
      const value = response[i]!, rowRe = [1], rowIm = [0];
      for (const mode of modes) for (const part of basis(mode, omega[i]!)) { rowRe.push(part.re); rowIm.push(part.im); }
      matrix.push(rowRe); target.push(value.re); matrix.push(rowIm); target.push(value.im);
    }
    const norms = Array.from({ length: columns }, (_, j) => Math.hypot(...matrix.map(row => row[j]!)));
    if (norms.some(norm => !(norm > 1e-14 && Number.isFinite(norm)))) throw new Error("FRD complex-pole fit is numerically singular.");
    const q: number[][] = [], r = Array.from({ length: columns }, () => new Array(columns).fill(0) as number[]);
    for (let j = 0; j < columns; j++) {
      let v = matrix.map(row => row[j]! / norms[j]!);
      for (let pass = 0; pass < 2; pass++) for (let k = 0; k < j; k++) {
        const projection = q[k]!.reduce((sum, item, row) => sum + item * v[row]!, 0);
        r[k]![j] = r[k]![j]! + projection; v = v.map((item, row) => item - projection * q[k]![row]!);
      }
      const diagonal = Math.hypot(...v); if (!(diagonal > 1e-11)) throw new Error("FRD complex-pole fit is numerically singular.");
      r[j]![j] = diagonal; q.push(v.map(item => item / diagonal));
    }
    const projected = q.map(column => column.reduce((sum, item, row) => sum + item * target[row]!, 0)), scaled = new Array(columns).fill(0) as number[];
    for (let row = columns - 1; row >= 0; row--) scaled[row] = (projected[row]! - r[row]!.slice(row + 1).reduce((sum, value, index) => sum + value * scaled[row + 1 + index]!, 0)) / r[row]![row]!;
    const coefficients = scaled.map((value, i) => value / norms[i]!); let squared = 0;
    for (let i = 0; i < omega.length; i++) { let re = coefficients[0]!, im = 0, column = 1;
      for (const mode of modes) for (const part of basis(mode, omega[i]!)) { re += coefficients[column]! * part.re; im += coefficients[column++]! * part.im; }
      squared += (re - response[i]!.re) ** 2 + (im - response[i]!.im) ** 2;
    }
    return { coefficients, error: Math.sqrt(squared / response.length) / responseScale };
  };
  let best = fitAt();
  const search = (modeIndex: number, parameter: "decay" | "frequency", lowLog: number, highLog: number, pass: number, step: number) => {
    const mode = modes[modeIndex]!; if (parameter === "frequency" && mode.kind !== "pair") return;
    const oldValue = parameter === "decay" ? mode.decay : mode.kind === "pair" ? mode.frequency : Number.NaN, candidates = pass === 0
      ? Array.from({ length: gridSize }, (_, i) => Math.exp(lowLog + (highLog - lowLog) * i / (gridSize - 1)))
      : Array.from({ length: 17 }, (_, i) => Math.exp(Math.max(lowLog, Math.min(highLog, Math.log(oldValue) + (i - 8) * step))));
    let localValue = oldValue, localBest = best;
    for (const candidate of candidates) {
      if (parameter === "frequency" && modes.some((other, index) => index !== modeIndex && other.kind === "pair" && Math.abs(Math.log(candidate / other.frequency)) < .04)) continue;
      if (parameter === "decay") mode.decay = candidate; else if (mode.kind === "pair") mode.frequency = candidate;
      try { const fit = fitAt(); if (fit.error < localBest.error) { localBest = fit; localValue = candidate; } } catch { /* skip singular trial poles */ }
    }
    if (parameter === "decay") mode.decay = localValue; else if (mode.kind === "pair") mode.frequency = localValue;
    best = localBest;
  };
  let decayStep = (logHigh - logLow) / (gridSize - 1), frequencyStep = (logFrequencyHigh - logFrequencyLow) / (gridSize - 1);
  for (let pass = 0; pass < 5; pass++) {
    for (let i = 0; i < modes.length; i++) { if (modes[i]!.kind === "pair") search(i, "frequency", logFrequencyLow, logFrequencyHigh, pass, frequencyStep); search(i, "decay", logLow, logHigh, pass, decayStep); }
    decayStep /= 10; frequencyStep /= 10;
  }
  const factors = modes.map(mode => mode.kind === "real"
    ? domain === "continuous" ? [1, mode.decay] : [1, -Math.exp(-mode.decay * sampleTime)]
    : domain === "continuous" ? [1, 2 * mode.decay, mode.decay * mode.decay + mode.frequency * mode.frequency] : [1, -2 * Math.exp(-mode.decay * sampleTime) * Math.cos(mode.frequency * sampleTime), Math.exp(-2 * mode.decay * sampleTime)]);
  let denominator = [1]; for (const factor of factors) denominator = multiply(denominator, factor);
  const numerator = denominator.map(value => value * best.coefficients[0]!); let column = 1;
  for (let i = 0; i < modes.length; i++) {
    let other = [1]; for (let j = 0; j < factors.length; j++) if (i !== j) other = multiply(other, factors[j]!);
    const mode = modes[i]!;
    if (mode.kind === "real") { for (let j = 0; j < other.length; j++) numerator[j]! += other[j]! * best.coefficients[column++]!; }
    else { const a = best.coefficients[column++]!, b = best.coefficients[column++]!; for (let j = 0; j < other.length; j++) { numerator[j + 1]! += other[j]! * a; numerator[j + 2]! += other[j]! * b; } }
  }
  const model = validateTf({ num: numerator, den: denominator, domain, sampleTime: domain === "discrete" ? sampleTime : undefined });
  const relativeErrors = response.map((value, i) => { const predicted = frequencyResponse(model, omega[i]!); return Math.hypot(predicted.re - value.re, predicted.im - value.im) / Math.max(responseScale * 1e-8, Math.hypot(value.re, value.im)); });
  return { model, frequencyRadPerSecond: omega, relativeRmsError: best.error, maximumRelativeError: Math.max(...relativeErrors) };
}

/** Select the better stable fit from real poles or stable conjugate pairs. */
export function fitFrdStablePoles(input: FrdFitInput): FrdFitResult {
  const real = fitFrdStableRealPoles(input);
  if (input.order < 2) return real;
  try { const paired = fitFrdConjugatePairs(input); return paired.relativeRmsError < real.relativeRmsError ? paired : real; }
  catch { return real; }
}
