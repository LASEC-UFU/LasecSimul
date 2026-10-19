import { polynomialRoots, type TransferFunction } from "./lti.js";

/** Exact rational arithmetic over the input IEEE-754 coefficients. */
type Q = { n: bigint; d: bigint };
const gcd = (a: bigint, b: bigint): bigint => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a || 1n; };
const q = (n: bigint, d = 1n): Q => { if (!d) throw new Error("division by zero"); if (d < 0n) { n = -n; d = -d; } const g = gcd(n, d); return { n: n / g, d: d / g }; };
const qa = (a: Q, b: Q) => q(a.n * b.d + b.n * a.d, a.d * b.d);
const qn = (a: Q) => q(-a.n, a.d);
const qs = (a: Q, b: Q) => qa(a, qn(b));
const qm = (a: Q, b: Q) => q(a.n * b.n, a.d * b.d);
const qd = (a: Q, b: Q) => q(a.n * b.d, a.d * b.n);
const q0 = () => q(0n);
const q1 = () => q(1n);
function fromNumber(value: number): Q {
  if (!Number.isFinite(value)) throw new Error("Coeficiente não finito.");
  if (value === 0) return q0();
  const view = new DataView(new ArrayBuffer(8)); view.setFloat64(0, value, false);
  const bits = view.getBigUint64(0, false), sign = bits >> 63n ? -1n : 1n;
  const exponent = Number((bits >> 52n) & 0x7ffn), fraction = bits & ((1n << 52n) - 1n);
  const significand = exponent ? (1n << 52n) | fraction : fraction;
  const power = (exponent ? exponent - 1023 : -1022) - 52;
  return power >= 0 ? q(sign * significand << BigInt(power)) : q(sign * significand, 1n << BigInt(-power));
}
type P = Q[]; // ascending powers
const clean = (p: P): P => { while (p.length > 1 && p.at(-1)!.n === 0n) p.pop(); return p; };
const derivative = (p: P): P => clean(p.slice(1).map((v, i) => qm(v, q(BigInt(i + 1)))) .concat(p.length <= 1 ? [q0()] : []));
function remainder(a: P, b: P): P {
  let r = [...a];
  while (r.length >= b.length && !(r.length === 1 && r[0]!.n === 0n)) {
    const shift = r.length - b.length, factor = qd(r.at(-1)!, b.at(-1)!);
    for (let i = 0; i < b.length; i++) r[i + shift] = qs(r[i + shift]!, qm(factor, b[i]!));
    clean(r);
  }
  return r;
}
function sturm(p: P): P[] {
  p = clean([...p]); if (p.length < 2) return [p];
  const seq = [p, derivative(p)];
  while (seq.at(-1)!.length > 1) {
    const r = remainder(seq.at(-2)!, seq.at(-1)!).map(qn);
    if (r.length === 1 && r[0]!.n === 0n) break;
    seq.push(r);
  }
  return seq;
}
function signAt(p: P, x: Q): -1 | 0 | 1 { let y = q0(); for (let i = p.length - 1; i >= 0; i--) y = qa(qm(y, x), p[i]!); return y.n < 0n ? -1 : y.n > 0n ? 1 : 0; }
function variations(seq: P[], x: Q): number { const signs = seq.map(p => signAt(p, x)).filter(Boolean); let n = 0; for (let i = 1; i < signs.length; i++) if (signs[i] !== signs[i - 1]) n++; return n; }
const rootCount = (seq: P[], a: Q, b: Q): number => variations(seq, a) - variations(seq, b);
function polynomialGcd(a: P, b: P): P { while (!(b.length === 1 && b[0]!.n === 0n)) [a, b] = [b, remainder(a, b)]; return a; }
const padd = (a: P, b: P): P => clean(Array.from({ length: Math.max(a.length, b.length) }, (_, i) => qa(a[i] ?? q0(), b[i] ?? q0())));
const pscale = (a: P, factor: Q): P => clean(a.map(value => qm(value, factor)));
const pmul = (a: P, b: P): P => { const out = new Array<Q>(a.length + b.length - 1).fill(q0()); a.forEach((x, i) => b.forEach((y, j) => out[i + j] = qa(out[i + j]!, qm(x, y)))); return clean(out); };
const pderivative = (a: P): P => a.length < 2 ? [q0()] : clean(a.slice(1).map((value, i) => qm(value, q(BigInt(i + 1)))));
function magnitudeSquared(coefficientsDescending: readonly number[], domain: TransferFunction["domain"]): P {
  const coefficients = coefficientsDescending.map(fromNumber);
  if (domain === "continuous") {
    let real: P = [q0()], imag: P = [q0()];
    coefficients.forEach((value, i) => {
      const power = coefficients.length - 1 - i;
      if (power % 2 === 0) { const index = power / 2; while (real.length <= index) real.push(q0()); real[index] = (index % 2 ? qn : (x: Q) => x)(value); }
      else { const index = (power - 1) / 2; while (imag.length <= index) imag.push(q0()); imag[index] = (index % 2 ? qn : (x: Q) => x)(value); }
    });
    return padd(pmul(real, real), [q0(), ...pmul(imag, imag)]);
  }
  const ascending = [...coefficients].reverse(), degree = ascending.length - 1, correlations = new Array<Q>(degree + 1).fill(q0());
  for (let lag = 0; lag <= degree; lag++) for (let i = 0; i + lag <= degree; i++) correlations[lag] = qa(correlations[lag]!, qm(ascending[i]!, ascending[i + lag]!));
  const chebyshev: P[] = [[q1()], [q0(), q1()]];
  for (let n = 2; n <= degree; n++) chebyshev.push(padd(pscale([q0(), ...chebyshev[n - 1]!], q(2n)), pscale(chebyshev[n - 2]!, q(-1n))));
  let result: P = [correlations[0]!];
  for (let lag = 1; lag <= degree; lag++) result = padd(result, pscale(chebyshev[lag]!, qm(q(2n), correlations[lag]!)));
  return result;
}
function stationaryMagnitude(tf: TransferFunction): P {
  const n = magnitudeSquared(tf.num, tf.domain), d = magnitudeSquared(tf.den, tf.domain);
  return padd(pmul(pderivative(n), d), pscale(pmul(n, pderivative(d)), q(-1n)));
}
function divideLinear(p: P, root: Q): P {
  const degree = p.length - 1, out = new Array<Q>(degree).fill(q0());
  out[degree - 1] = p[degree]!;
  for (let i = degree - 2; i >= 0; i--) out[i] = qa(p[i + 1]!, qm(root, out[i + 1]!));
  if (degree > 0 && qs(p[0]!, qn(qm(root, out[0]!))).n !== 0n) throw new Error("Exact endpoint division failed.");
  return clean(out);
}
type RootInterval = { lower: Q; upper: Q };
async function isolateRoots(p: P, lower: Q, upper: Q, budget: { remaining: number; deadline: number; cancelled?: () => boolean; progress?: (completed: number) => void }): Promise<RootInterval[] | undefined> {
  p = clean([...p]); if (p.length < 2) return [];
  if (signAt(p, lower) === 0) { let quotient = p; while (quotient.length > 1 && signAt(quotient, lower) === 0) quotient = divideLinear(quotient, lower); const rest = await isolateRoots(quotient, lower, upper, budget); return rest ? [{ lower, upper: lower }, ...rest] : undefined; }
  if (signAt(p, upper) === 0) { let quotient = p; while (quotient.length > 1 && signAt(quotient, upper) === 0) quotient = divideLinear(quotient, upper); const rest = await isolateRoots(quotient, lower, upper, budget); return rest ? [...rest, { lower: upper, upper }] : undefined; }
  const sequence = sturm(p), total = rootCount(sequence, lower, upper), intervals: RootInterval[] = [], stack: Array<{ a: Q; b: Q; count: number }> = total ? [{ a: lower, b: upper, count: total }] : [];
  while (stack.length) {
    if (--budget.remaining < 0 || Date.now() >= budget.deadline || budget.cancelled?.()) return undefined;
    if (budget.progress && budget.remaining % 16 === 0) { budget.progress(10_000 - budget.remaining); await new Promise<void>(resolve => setTimeout(resolve, 0)); }
    const item = stack.pop()!, mid = qd(qa(item.a, item.b), q(2n));
    if (signAt(p, mid) === 0) {
      let quotient = p; while (quotient.length > 1 && signAt(quotient, mid) === 0) quotient = divideLinear(quotient, mid);
      const rest = await isolateRoots(quotient, lower, upper, budget); return rest ? [...rest, { lower: mid, upper: mid }] : undefined;
    }
    const scale = qmax(q1(), qmax(qabs(item.a), qabs(item.b))), tolerance = qd(scale, q(100_000_000n));
    if (item.count === 1 && qcmp(qs(item.b, item.a), tolerance) <= 0) { intervals.push({ lower: item.a, upper: item.b }); continue; }
    const left = rootCount(sequence, item.a, mid), right = rootCount(sequence, mid, item.b);
    if (left + right !== item.count) return undefined;
    if (right) stack.push({ a: mid, b: item.b, count: right });
    if (left) stack.push({ a: item.a, b: mid, count: left });
  }
  return intervals;
}
function bitLength(value: bigint): number { return (value < 0n ? -value : value).toString(2).length; }
function scaledNumbers(values: readonly Q[]): number[] {
  const scale = Math.max(...values.filter(x => x.n !== 0n).map(x => bitLength(x.n) - bitLength(x.d)), 0);
  return values.map(value => {
    if (value.n === 0n) return 0;
    const sn = Math.max(0, bitLength(value.n) - 53), sd = Math.max(0, bitLength(value.d) - 53);
    const mantissa = Number(value.n >> BigInt(sn)) / Number(value.d >> BigInt(sd));
    const exponent = sn - sd - scale;
    return exponent < -1074 ? 0 : mantissa * 2 ** exponent;
  });
}
async function bodeCertificate(tf: TransferFunction, deadline: number, options: CertificationOptions): Promise<AnalysisCertificate> {
  const degree = Math.max(tf.num.length, tf.den.length) - 1;
  if (degree > 6) return { analysis: "bode", status: "inconclusive", message: "Ordem acima de 6 excede o limite de custo do isolamento exato." };
  const denominatorMagnitude = magnitudeSquared(tf.den, tf.domain);
  const frequencyLower = tf.domain === "continuous" ? q0() : q(-1n), frequencyUpper = tf.domain === "continuous" ? undefined : q1();
  for (const endpoint of [frequencyLower, ...(frequencyUpper ? [frequencyUpper] : [])]) if (signAt(denominatorMagnitude, endpoint) === 0) return { analysis: "bode", status: "inconclusive", message: "A resposta tem polo sobre a banda de frequência ou em seu limite." };
  let denominatorBound: Q;
  if (tf.domain === "continuous") {
    const lead = denominatorMagnitude.at(-1)!; let maximum = q0();
    for (const value of denominatorMagnitude.slice(0, -1)) { const ratio = qd(qabs(value), qabs(lead)); if (qcmp(ratio, maximum) > 0) maximum = ratio; }
    denominatorBound = qa(q1(), maximum);
  } else denominatorBound = q1();
  if (rootCount(sturm(denominatorMagnitude), frequencyLower, denominatorBound) > 0) return { analysis: "bode", status: "inconclusive", message: "Existe um polo sobre o eixo/círculo de frequência; a resposta não é finita em toda a banda." };
  const stationary = stationaryMagnitude(tf);
  if (stationary.length === 1 && stationary[0]!.n === 0n) return { analysis: "bode", status: "certified", message: "A magnitude é constante; a equação estacionária é identicamente nula.", details: { stationaryPoints: 0 } };
  let lower = q0(), upper: Q, polynomial = stationary;
  if (tf.domain === "continuous") {
    const lead = stationary.at(-1)!; let max = q0();
    for (const value of stationary.slice(0, -1)) { const ratio = qd(value.n < 0n ? qn(value) : value, lead.n < 0n ? qn(lead) : lead); if (ratio.n * max.d > max.n * ratio.d) max = ratio; }
    upper = qa(q1(), max);
  } else { lower = q(-1n); upper = q1(); }
  if (tf.domain === "continuous" && signAt(polynomial, lower) === 0) while (polynomial.length > 1 && signAt(polynomial, lower) === 0) polynomial = divideLinear(polynomial, lower);
  if (tf.domain === "discrete") for (const endpoint of [q(-1n), q1()]) if (signAt(polynomial, endpoint) === 0) while (polynomial.length > 1 && signAt(polynomial, endpoint) === 0) polynomial = divideLinear(polynomial, endpoint);
  const isolationBudget = Math.max(16, Math.min(100_000, options.maxSubdivisions ?? 10_000));
  const intervals = await isolateRoots(polynomial, lower, upper, { remaining: isolationBudget, deadline, cancelled: options.cancelled, progress: completed => options.onProgress?.({ phase: "bode", completed, total: isolationBudget, message: `Isolamento de Sturm: ${completed} subdivisões.` }) });
  if (!intervals) return { analysis: "bode", status: "inconclusive", message: options.cancelled?.() ? "Cancelado durante o isolamento de Sturm." : "O isolamento exato excedeu o limite de tempo ou subdivisões." };
  const count = intervals.length;
  const descending = scaledNumbers([...stationary].reverse());
  const approx = polynomialRoots(descending).filter(root => Math.abs(root.im) <= 1e-7 * Math.max(1, Math.abs(root.re)) && (tf.domain === "continuous" ? root.re >= 0 : root.re >= -1 && root.re <= 1));
  const physical = approx.filter(root => tf.domain === "continuous" ? root.re > 0 : root.re > -1 && root.re < 1);
  const uniqueRoots = physical.filter((root, i) => physical.findIndex(other => Math.abs(root.re - other.re) <= 1e-6 * Math.max(1, Math.abs(root.re))) === i);
  const allLocated = intervals.every(interval => uniqueRoots.some(root => qcmp(fromNumber(root.re), interval.lower) >= 0 && qcmp(fromNumber(root.re), interval.upper) <= 0));
  const unique = uniqueRoots.length;
  if (unique !== count) return { analysis: "bode", status: "inconclusive", message: `Sturm certificou ${count} raiz(es) estacionária(s), mas o localizador numérico encontrou ${unique}; nenhum conjunto de extremos foi certificado.` };
  if (!allLocated) return { analysis: "bode", status: "inconclusive", message: "O localizador numérico não pôde associar cada candidato ao seu intervalo isolado por Sturm." };
  const maxWidth = Math.max(0, ...intervals.map(interval => qToNumber(qs(interval.upper, interval.lower))));
  if (!Number.isFinite(maxWidth)) return { analysis: "bode", status: "inconclusive", message: "A largura dos intervalos excede a faixa numérica representável." };
  const intervalText = intervals.map(interval => `[${interval.lower.n}/${interval.lower.d}, ${interval.upper.n}/${interval.upper.d}]`).join("; ");
  return { analysis: "bode", status: "certified", message: "Sturm isolou cada candidato estacionário em intervalo racional disjunto; a contagem e a localização de todos os extremos estão certificadas.", details: { stationaryPoints: count, maxCoordinateIntervalWidth: maxWidth, stationaryCoordinateIntervals: intervalText || "nenhum" } };
}
function qToNumber(value: Q): number {
  if (!value.n) return 0;
  const sn = Math.max(0, bitLength(value.n) - 53), sd = Math.max(0, bitLength(value.d) - 53);
  return Number(value.n >> BigInt(sn)) / Number(value.d >> BigInt(sd)) * 2 ** (sn - sd);
}
export interface CertificateProgress { phase: "nyquist" | "bode" | "root-locus"; completed: number; total: number; message: string }
export interface AnalysisCertificate { analysis: CertificateProgress["phase"]; status: "certified" | "inconclusive"; message: string; details?: Record<string, number | string> }
export interface CertificationOptions { timeLimitMs?: number; maxSubdivisions?: number; onProgress?: (progress: CertificateProgress) => void; cancelled?: () => boolean }

function addExactDescending(a: readonly Q[], b: readonly Q[]): Q[] {
  const n = Math.max(a.length, b.length);
  return Array.from({ length: n }, (_, i) => qa(a[a.length - n + i] ?? q0(), b[b.length - n + i] ?? q0()));
}
const qcmp = (a: Q, b: Q): number => { const x = a.n * b.d - b.n * a.d; return x < 0n ? -1 : x > 0n ? 1 : 0; };
const qmin = (a: Q, b: Q): Q => qcmp(a, b) <= 0 ? a : b;
const qmax = (a: Q, b: Q): Q => qcmp(a, b) >= 0 ? a : b;
const qabs = (a: Q): Q => a.n < 0n ? qn(a) : a;
function integerSqrt(n: bigint): bigint { if (n < 2n) return n; let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2)); while (true) { const y = (x + n / x) >> 1n; if (y >= x) return x; x = y; } }
function sqrtBounds(value: Q): [Q, Q] { if (value.n < 0n) throw new Error("negative magnitude square"); const scale = 1n << 40n, scaled = value.n * scale * scale, root = integerSqrt(scaled / value.d), exact = root * root * value.d === scaled; return [q(root, scale), q(exact ? root : root + 1n, scale)]; }
type CQ = { re: Q; im: Q };
const ca = (a: CQ, b: CQ): CQ => ({ re: qa(a.re, b.re), im: qa(a.im, b.im) });
const cm = (a: CQ, b: CQ): CQ => ({ re: qs(qm(a.re, b.re), qm(a.im, b.im)), im: qa(qm(a.re, b.im), qm(a.im, b.re)) });
const cs = (a: CQ, k: Q): CQ => ({ re: qm(a.re, k), im: qm(a.im, k) });
const c0 = (): CQ => ({ re: q0(), im: q0() });
function complexPower(value: CQ, n: number): CQ { let out: CQ = { re: q1(), im: q0() }; for (let i = 0; i < n; i++) out = cm(out, value); return out; }
function binomial(n: number, k: number): bigint { let out = 1n; for (let i = 1; i <= k; i++) out = out * BigInt(n - i + 1) / BigInt(i); return out; }
function taylorCoefficient(descending: readonly Q[], order: number, center: CQ): CQ { const degree = descending.length - 1; let out = c0(); for (let i = 0; i <= degree - order; i++) { const exponent = degree - i; out = ca(out, cs(complexPower(center, exponent - order), qm(descending[i]!, q(binomial(exponent, order))))); } return out; }
const complexAbsBounds = (value: CQ): [Q, Q] => sqrtBounds(qa(qm(value.re, value.re), qm(value.im, value.im)));
function roucheRootCluster(den: Q[], num: Q[], gainLo: Q, gainHi: Q, gainCenter: Q, center: CQ, radius: Q, multiplicity: number): boolean {
  const degree = den.length - 1, delta = qmax(qs(gainCenter, gainLo), qs(gainHi, gainCenter));
  const coefficient = (order: number): CQ => ca(taylorCoefficient(den, order, center), cs(taylorCoefficient(num, order, center), gainCenter));
  const coefficients = Array.from({ length: degree + 1 }, (_, j) => coefficient(j));
  const gainTerms = Array.from({ length: degree + 1 }, (_, j) => complexAbsBounds(taylorCoefficient(num, j, center))[1]);
  let targetLower = qs(complexAbsBounds(coefficients[multiplicity]!)[0], qm(delta, gainTerms[multiplicity]!));
  if (targetLower.n <= 0n) return false;
  let remainderBound = q0(), radiusPower = q1();
  for (let j = 0; j <= degree; j++) {
    if (j !== multiplicity) {
      const upper = qa(complexAbsBounds(coefficients[j]!)[1], qm(delta, gainTerms[j]!));
      remainderBound = qa(remainderBound, qm(upper, radiusPower));
    }
    radiusPower = qm(radiusPower, radius);
  }
  let targetPower = q1(); for (let i = 0; i < multiplicity; i++) targetPower = qm(targetPower, radius);
  return qcmp(qm(targetLower, targetPower), remainderBound) > 0;
}
function exactCharacteristic(den: readonly Q[], num: readonly Q[], gain: Q): Q[] { return addExactDescending(den, num.map(value => qm(value, gain))); }
function certifyLocusInterval(den: Q[], num: Q[], lo: Q, hi: Q): { ok: boolean; maxRadius: Q } {
  const gainValue = (qToNumber(lo) + qToNumber(hi)) / 2; if (!Number.isFinite(gainValue)) return { ok: false, maxRadius: q0() };
  const gain = fromNumber(gainValue); if (qcmp(gain, lo) < 0 || qcmp(gain, hi) > 0) return { ok: false, maxRadius: q0() };
  const characteristic = exactCharacteristic(den, num, gain), roots = polynomialRoots(scaledNumbers(characteristic)), order = characteristic.length - 1;
  if (order < 1 || roots.length !== order) return { ok: false, maxRadius: q0() };
  const centers = roots.map(root => ({ re: fromNumber(root.re), im: fromNumber(root.im) }));
  type Cluster = { indices: number[]; center: CQ; radius: Q };
  const makeCluster = (indices: number[]): Cluster => {
    const center = indices.reduce((sum, index) => ca(sum, centers[index]!), c0());
    center.re = qd(center.re, q(BigInt(indices.length))); center.im = qd(center.im, q(BigInt(indices.length)));
    const spread = indices.reduce((maximum, index) => { const dx = qs(centers[index]!.re, center.re), dy = qs(centers[index]!.im, center.im); return qmax(maximum, sqrtBounds(qa(qm(dx, dx), qm(dy, dy)))[1]); }, q0());
    const margin = qd(qa(q1(), complexAbsBounds(center)[1]), q(100n));
    return { indices, center, radius: qa(spread, margin) };
  };
  const clusters: Cluster[] = centers.map((_, index) => makeCluster([index]));
  while (true) {
    let merge: [number, number] | undefined;
    for (let i = 0; i < clusters.length && !merge; i++) for (let j = i + 1; j < clusters.length; j++) {
      const dx = qs(clusters[i]!.center.re, clusters[j]!.center.re), dy = qs(clusters[i]!.center.im, clusters[j]!.center.im), distance = sqrtBounds(qa(qm(dx, dx), qm(dy, dy)))[0];
      if (qcmp(distance, qa(clusters[i]!.radius, clusters[j]!.radius)) <= 0) { merge = [i, j]; break; }
    }
    if (!merge) break;
    const [i, j] = merge, combined = makeCluster([...clusters[i]!.indices, ...clusters[j]!.indices]); clusters.splice(j, 1); clusters.splice(i, 1, combined);
  }
  let maxRadius = q0();
  for (const cluster of clusters) {
    if (!roucheRootCluster(den, num, lo, hi, gain, cluster.center, cluster.radius, cluster.indices.length)) return { ok: false, maxRadius: q0() };
    maxRadius = qmax(maxRadius, cluster.radius);
  }
  if (clusters.reduce((sum, cluster) => sum + cluster.indices.length, 0) !== order) return { ok: false, maxRadius: q0() };
  return { ok: true, maxRadius };
}
async function certifyRootLocus(tf: TransferFunction, options: CertificationOptions, deadline: number): Promise<AnalysisCertificate> {
  const order = tf.den.length - 1;
  if (order < 1 || order > 4) return { analysis: "root-locus", status: "inconclusive", message: "A prova por caixas de Rouché suporta ordens 1 a 4; modelo fora do limite." };
  const den = tf.den.map(fromNumber), num = Array.from({ length: tf.den.length - tf.num.length }, () => q0()).concat(tf.num.map(fromNumber)), lo = fromNumber(1e-3), hi = fromNumber(1e3);
  if (order === 1) {
    const leadLo = qa(den[0]!, qm(lo, num[0]!)), leadHi = qa(den[0]!, qm(hi, num[0]!));
    if (leadLo.n === 0n || leadHi.n === 0n || (leadLo.n < 0n) !== (leadHi.n < 0n)) return { analysis: "root-locus", status: "inconclusive", message: "O coeficiente líder zera no intervalo de ganho; há um ramo no infinito." };
    const root = (gain: Q) => qn(qd(qa(den[1]!, qm(gain, num[1]!)), qa(den[0]!, qm(gain, num[0]!))));
    const first = qToNumber(root(lo)), last = qToNumber(root(hi));
    if (![first, last].every(Number.isFinite)) return { analysis: "root-locus", status: "inconclusive", message: "O ramo excede a faixa numérica representável." };
    return { analysis: "root-locus", status: "certified", message: "A única raiz é uma função racional monotônica do ganho; os extremos exatos do intervalo cobrem o ramo inteiro.", details: { branches: 1, gainMin: 1e-3, gainMax: 1e3, rootMin: Math.min(first, last), rootMax: Math.max(first, last), subdivisions: 0 } };
  }
  const leadLo = qa(den[0]!, qm(lo, num[0]!)), leadHi = qa(den[0]!, qm(hi, num[0]!));
  if (leadLo.n === 0n || leadHi.n === 0n || (leadLo.n < 0n) !== (leadHi.n < 0n)) return { analysis: "root-locus", status: "inconclusive", message: "O coeficiente líder zera no intervalo de ganho; há um ramo no infinito." };
  const stack: Array<[Q, Q]> = [[lo, hi]]; let subdivisions = 0, maxRadius = q0(); const limit = Math.max(16, Math.min(100_000, options.maxSubdivisions ?? 2048));
  while (stack.length) {
    if (options.cancelled?.()) return { analysis: "root-locus", status: "inconclusive", message: `Cancelado após ${subdivisions} subdivisões certificadas.` };
    if (Date.now() >= deadline || subdivisions >= limit) return { analysis: "root-locus", status: "inconclusive", message: `Orçamento esgotado após ${subdivisions} subdivisões; ${stack.length} intervalo(s) sem prova.` };
    const [a, b] = stack.pop()!; subdivisions++;
    const proof = certifyLocusInterval(den, num, a, b);
    if (proof.ok) maxRadius = qmax(maxRadius, proof.maxRadius);
    else { const mid = qd(qa(a, b), q(2n)); if (qcmp(mid, a) === 0 || qcmp(mid, b) === 0) return { analysis: "root-locus", status: "inconclusive", message: "Precisão insuficiente para subdividir o intervalo remanescente." }; stack.push([mid, b], [a, mid]); }
    if (subdivisions % 8 === 0) { options.onProgress?.({ phase: "root-locus", completed: subdivisions, total: limit, message: `Caixas de Rouché: ${subdivisions} subdivisões; ${stack.length} intervalos pendentes.` }); await new Promise<void>(resolve => setTimeout(resolve, 0)); }
  }
  const maxBoxRadius = qToNumber(maxRadius);
  if (!Number.isFinite(maxBoxRadius)) return { analysis: "root-locus", status: "inconclusive", message: "As caixas certificadas excedem a faixa numérica representável." };
  return { analysis: "root-locus", status: "certified", message: "Caixas de Rouché certificaram todos os ramos em todo o intervalo de ganho, sem lacunas.", details: { branches: order, subdivisions, maxBoxRadius, gainMin: 1e-3, gainMax: 1e3 } };
}
function substituteUnitCircle(p: P): P {
  // (1-s)^n p((1+s)/(1-s)); roots in |z|<1 map to Re(s)<0.
  const n = p.length - 1, out = new Array<Q>(n + 1).fill(q0());
  // Exact polynomial products, coefficients ascending in s.
  const mul = (a: P, b: P): P => { const z = new Array<Q>(a.length + b.length - 1).fill(q0()); a.forEach((x, i) => b.forEach((y, j) => z[i + j] = qa(z[i + j]!, qm(x, y)))); return clean(z); };
  const power = (a: P, k: number): P => { let z: P = [q1()]; for (let i = 0; i < k; i++) z = mul(z, a); return z; };
  for (let i = 0; i <= n; i++) {
    const coefficient = p[i]!;
    const term = mul(power([q1(), q1()], n - i), power([q1(), q(-1n)], i));
    for (let j = 0; j <= n; j++) out[j] = qa(out[j]!, qm(coefficient, term[j] ?? q0()));
  }
  return clean(out);
}

function routhRightHalfPlaneCount(ascending: P): number | undefined {
  const p = clean([...ascending]);
  const degree = p.length - 1;
  if (degree <= 0) return 0;
  const rows: P[] = [];
  const rowLength = Math.ceil((degree + 1) / 2);
  rows.push(Array.from({ length: rowLength }, (_, i) => p[degree - 2 * i] ?? q0()));
  rows.push(Array.from({ length: rowLength }, (_, i) => p[degree - 1 - 2 * i] ?? q0()));
  for (let r = 2; r <= degree; r++) {
    const prev = rows[r - 1]!, prev2 = rows[r - 2]!, first = prev[0]!;
    if (first.n === 0n) return undefined; // singular row: fail closed, never guess
    const row = new Array<Q>(rowLength).fill(q0());
    for (let col = 0; col < rowLength - 1; col++) row[col] = qd(qs(qm(first, prev2[col + 1]!), qm(prev2[0]!, prev[col + 1]!)), first);
    if (row.every(x => x.n === 0n)) return undefined;
    rows.push(row);
  }
  let changes = 0, previous = rows[0]![0]!.n < 0n ? -1 : 1;
  for (let i = 1; i < rows.length; i++) { const n = rows[i]![0]!.n; if (!n) return undefined; const current = n < 0n ? -1 : 1; if (current !== previous) changes++; previous = current; }
  return changes;
}

function nyquistCertificate(tf: TransferFunction): AnalysisCertificate {
  if (Math.max(tf.den.length, tf.num.length) > 9) return { analysis: "nyquist", status: "inconclusive", message: "Ordem acima de 8 excede o limite de custo da certificação exata." };
  const den = tf.den.map(fromNumber), num = tf.num.map(fromNumber);
  const characteristic = addExactDescending(den, num);
  const boundaryAtMinusOne = (polynomial: Q[]) => polynomial.reduce((sum, coefficient, index) => (polynomial.length - 1 - index) % 2 ? qs(sum, coefficient) : qa(sum, coefficient), q0()).n === 0n;
  if (tf.domain === "discrete" && (boundaryAtMinusOne(den) || boundaryAtMinusOne(characteristic))) return { analysis: "nyquist", status: "inconclusive", message: "Polo em z=-1 (fronteira do círculo unitário); contorno singular." };
  const open = tf.domain === "continuous" ? [...den].reverse() : substituteUnitCircle(den);
  const closed = tf.domain === "continuous" ? [...characteristic].reverse() : substituteUnitCircle(characteristic);
  const boundary = (polynomial: P): boolean => {
    const reflected = polynomial.map((coefficient, index) => index % 2 ? qn(coefficient) : coefficient);
    return polynomialGcd([...polynomial], [...reflected]).length > 1;
  };
  if (boundary(open) || boundary(closed)) return { analysis: "nyquist", status: "inconclusive", message: "A checagem exata detectou ou não conseguiu excluir raízes na fronteira de estabilidade." };
  const po = routhRightHalfPlaneCount(open), pc = routhRightHalfPlaneCount(closed);
  if (po === undefined || pc === undefined) return { analysis: "nyquist", status: "inconclusive", message: "A tabela exata de Routh encontrou uma linha singular; nenhum número foi inferido." };
  return { analysis: "nyquist", status: "certified", message: "Contagem de polos instáveis certificada por aritmética racional exata sobre os coeficientes recebidos.", details: { openUnstable: po, closedUnstable: pc, encirclements: tf.domain === "continuous" ? pc - po : po - pc } };
}

/** Runs bounded, opt-in certification. Each result is fail-closed: unsupported proofs are inconclusive. */
export async function certifyAnalyses(tf: TransferFunction, options: CertificationOptions = {}): Promise<AnalysisCertificate[]> {
  const started = Date.now(), timeLimit = Math.max(100, Math.min(120_000, options.timeLimitMs ?? 10_000)), deadline = started + timeLimit;
  const results: AnalysisCertificate[] = [];
  const step = async (phase: CertificateProgress["phase"], message: string, completed: number): Promise<boolean> => {
    options.onProgress?.({ phase, completed, total: 3, message });
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    return !options.cancelled?.() && Date.now() - started < timeLimit;
  };
  if (!await step("nyquist", "Certificando contagem pelo critério de Routh exato…", 1)) return [{ analysis: "nyquist", status: "inconclusive", message: "Certificação cancelada ou orçamento esgotado." }];
  try { results.push(nyquistCertificate(tf)); } catch (error) { results.push({ analysis: "nyquist", status: "inconclusive", message: `Não foi possível fechar a prova: ${error instanceof Error ? error.message : String(error)}` }); }
  if (!await step("bode", "Isolando extremos de Bode com a sequência exata de Sturm…", 2)) {
    results.push({ analysis: "bode", status: "inconclusive", message: "Orçamento esgotado antes de concluir a certificação." });
    results.push({ analysis: "root-locus", status: "inconclusive", message: "Orçamento esgotado antes de concluir a certificação." }); return results;
  }
  try { results.push(await bodeCertificate(tf, deadline, options)); } catch (error) { results.push({ analysis: "bode", status: "inconclusive", message: `Não foi possível fechar o isolamento: ${error instanceof Error ? error.message : String(error)}` }); }
  if (!await step("root-locus", "Verificando se há certificado de cobertura dos ramos…", 3)) {
    results.push({ analysis: "root-locus", status: "inconclusive", message: "Certificação cancelada ou orçamento esgotado." }); return results;
  }
  try { results.push(await certifyRootLocus(tf, options, deadline)); } catch (error) { results.push({ analysis: "root-locus", status: "inconclusive", message: `Não foi possível fechar a cobertura: ${error instanceof Error ? error.message : String(error)}` }); }
  options.onProgress?.({ phase: "root-locus", completed: 3, total: 3, message: "Análises concluídas; verifique quais provas foram fechadas." });
  return results;
}

export function certifiedRealRootCount(coefficientsDescending: readonly number[], lower: number, upper: number): number {
  if (!(lower < upper) || coefficientsDescending.some(value => !Number.isFinite(value))) throw new Error("Intervalo ou coeficientes inválidos.");
  const seq = sturm([...coefficientsDescending].reverse().map(fromNumber));
  return rootCount(seq, fromNumber(lower), fromNumber(upper));
}
