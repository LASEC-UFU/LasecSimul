import { Ast, arg, dependsOn, isNode } from "./ast.js";
import { compileExpression, type CompiledExpression } from "./compile.js";
import { deflate, polyEval, rationalParts } from "./poly.js";

/**
 * Análise de funções de uma variável para o explorador de funções e para Limites (docs/52 §4.5 e §4.7):
 * assíntotas, raízes, interseções, ε–δ e fronteiras de funções por partes. Tudo marcado como exato ou
 * numérico; nenhum resultado numérico é apresentado como prova.
 */
export interface Asymptotes {
  vertical: number[];
  horizontal: number[];
  oblique?: { slope: number; intercept: number };
  exact: boolean;
}

const evaluator = (fn: CompiledExpression) => { const env = new Float64Array(1); return (x: number): number => { env[0] = x; return fn.value(env); }; };

/** Raízes reais de um polinômio em [a, b] (amostragem + bisseção; exatas o bastante para desenho e rótulo). */
function polyRoots(p: readonly number[], a: number, b: number): number[] {
  const f = (x: number): number => polyEval([...p], x);
  return scanRoots(f, a, b, 2000);
}

function scanRoots(f: (x: number) => number, a: number, b: number, samples: number): number[] {
  const roots: number[] = [];
  const push = (x: number): void => { if (!roots.some((r) => Math.abs(r - x) <= 1e-9 * Math.max(1, Math.abs(x)))) roots.push(x); };
  let x0 = a, y0 = f(a);
  if (y0 === 0) push(a);
  for (let i = 1; i <= samples; i++) {
    const x1 = a + ((b - a) * i) / samples, y1 = f(x1);
    if (y1 === 0) push(x1);
    else if (Number.isFinite(y0) && Number.isFinite(y1) && y0 !== 0 && Math.sign(y0) !== Math.sign(y1)) {
      let lo = x0, hi = x1, flo = y0;
      for (let k = 0; k < 200 && hi - lo > 1e-14 * Math.max(1, Math.abs(lo)); k++) {
        const m = (lo + hi) / 2, fm = f(m);
        if (!Number.isFinite(fm)) break;
        if (Math.sign(fm) === Math.sign(flo)) { lo = m; flo = fm; } else hi = m;
      }
      const r = (lo + hi) / 2, fr = f(r);
      // Troca de sinal através de um polo não é raiz: |f| no ponto precisa ser pequeno.
      if (Number.isFinite(fr) && Math.abs(fr) <= 1e-6 * Math.max(1, Math.abs(y0), Math.abs(y1))) push(r);
    }
    x0 = x1; y0 = y1;
  }
  return roots.sort((p, q) => p - q);
}

/** Raízes de f em [a, b] (numéricas: amostragem + bisseção, tolerância 1e-14 relativa em x). */
export function findRoots(fn: CompiledExpression, a: number, b: number, samples = 1200): number[] {
  return scanRoots(evaluator(fn), a, b, samples);
}

/** Interseções de f e g em [a, b] (raízes de f − g). */
export function findIntersections(f: Ast, g: Ast, v: string, symbols: readonly string[], env: ArrayLike<number>, a: number, b: number): Array<[number, number]> {
  const diff = compileExpression(["Subtract", f, g], symbols);
  const fv = compileExpression(f, symbols);
  const values = Float64Array.from(env as ArrayLike<number>);
  const index = symbols.indexOf(v);
  const at = (fn: CompiledExpression, x: number): number => { values[index] = x; return fn.value(values); };
  return scanRoots((x) => at(diff, x), a, b, 1200).map((x) => [x, at(fv, x)]);
}

export function asymptotes(ast: Ast, v: string, fn: CompiledExpression, domain: readonly [number, number]): Asymptotes {
  const parts = rationalParts(ast, v);
  const rational = parts && parts[1].length > 1 ? parts : undefined; // polinômio/constante é polinômio
  if (rational) {
    const [p, q] = rational;
    const vertical: number[] = [];
    for (const r of polyRoots(q, domain[0], domain[1])) {
      let P = [...p], Q = [...q], guard = 0;
      while (Math.abs(polyEval(Q, r)) < 1e-9 && Math.abs(polyEval(P, r)) < 1e-9 && guard++ < 16) { P = deflate(P, r)[0]; Q = deflate(Q, r)[0]; }
      if (Math.abs(polyEval(Q, r)) < 1e-9) vertical.push(r); // fator do denominador que não cancela: assíntota (senão, buraco)
    }
    const dp = p.length - 1, dq = q.length - 1;
    const lead = (p[dp] as number) / (q[dq] as number);
    if (dp < dq) return { vertical, horizontal: [0], exact: true };
    if (dp === dq) return { vertical, horizontal: [lead], exact: true };
    if (dp === dq + 1) { // divisão de polinômios: P/Q = slope·x + intercept + resto/Q
      const slope = lead;
      const intercept = ((p[dp - 1] as number) - slope * (q[dq - 1] ?? 0)) / (q[dq] as number);
      return { vertical, horizontal: [], oblique: { slope, intercept }, exact: true };
    }
    return { vertical, horizontal: [], exact: true };
  }
  // Não racional: polos numéricos dentro do domínio e tendência em ±∞ pela sequência x = ±10^k.
  const f = evaluator(fn);
  const vertical: number[] = [];
  const n = 2000;
  let x0 = domain[0], y0 = f(x0);
  for (let i = 1; i <= n; i++) {
    const x1 = domain[0] + ((domain[1] - domain[0]) * i) / n, y1 = f(x1);
    const jump = Number.isFinite(y0) && Number.isFinite(y1) && Math.sign(y0) !== Math.sign(y1) && Math.abs(y0 - y1) > 1e3;
    if (jump || (Number.isFinite(y0) !== Number.isFinite(y1))) {
      let lo = x0, hi = x1;
      for (let k = 0; k < 80; k++) { const m = (lo + hi) / 2; if (Math.abs(f(m)) > 1e12 || !Number.isFinite(f(m))) { hi = m; lo = m; break; } if (Math.abs(f(lo)) > Math.abs(f(hi))) hi = m; else lo = m; }
      const r = (lo + hi) / 2;
      if (Math.abs(f(r - 1e-9)) > 1e6 || Math.abs(f(r + 1e-9)) > 1e6) vertical.push(r);
    }
    x0 = x1; y0 = y1;
  }
  const horizontal: number[] = [];
  for (const s of [1, -1]) {
    const tail = [6, 7, 8].map((k) => f(s * 10 ** k));
    if (tail.every(Number.isFinite) && Math.abs((tail[2] as number) - (tail[1] as number)) <= 1e-6 * Math.max(1, Math.abs(tail[2] as number))) {
      const y = Math.abs(tail[2] as number) < 1e-9 ? 0 : (tail[2] as number);
      if (!horizontal.some((h) => Math.abs(h - y) < 1e-9)) horizontal.push(y);
    }
  }
  return { vertical, horizontal, exact: false };
}

export type EpsilonDeltaResult =
  | { kind: "delta"; delta: number; samples: number }
  | { kind: "none"; witness: number; gap: number; reason: string };

/**
 * ε–δ visual: maior δ ≤ `maxDelta` (busca por bisseção) com |f(x) − L| < ε para todas as amostras de
 * 0 < |x − a| < δ (uniformes + geométricas perto de a). É evidência numérica, não prova; quando nem
 * δ = 1e-9 serve, devolve uma testemunha (o "contraexemplo" do limite proposto).
 */
export function epsilonDelta(fn: CompiledExpression, a: number, L: number, epsilon: number, maxDelta: number): EpsilonDeltaResult {
  const f = evaluator(fn);
  const samples = 600;
  const worst = (delta: number): { x: number; gap: number } => {
    let x = NaN, gap = -Infinity;
    const probe = (t: number): void => { const y = f(t); const g = Number.isFinite(y) ? Math.abs(y - L) : Infinity; if (g > gap) { gap = g; x = t; } };
    for (let i = 1; i <= samples; i++) {
      const u = (delta * i) / (samples + 1);
      const near = delta * 10 ** (-8 * (1 - i / samples));
      probe(a + u); probe(a - u); probe(a + near); probe(a - near);
    }
    return { x, gap };
  };
  if (!(epsilon > 0) || !(maxDelta > 0)) return { kind: "none", witness: a, gap: Infinity, reason: "ε e δ precisam ser positivos" };
  if (worst(maxDelta).gap < epsilon) return { kind: "delta", delta: maxDelta, samples: samples * 4 };
  let good = 0, bad = maxDelta;
  for (let k = 0; k < 60; k++) {
    const mid = good === 0 ? bad / 4 : Math.sqrt(good * bad);
    if (mid < 1e-9) break;
    if (worst(mid).gap < epsilon) good = mid; else bad = mid;
    if (good > 0 && bad / good < 1.0001) break;
  }
  if (good > 0) return { kind: "delta", delta: good, samples: samples * 4 };
  const witness = worst(1e-9);
  return { kind: "none", witness: witness.x, gap: witness.gap, reason: "perto de a existem pontos com |f(x) − L| ≥ ε: L não é o limite (ou ε é menor que o salto)" };
}

/** Fronteira de função por partes: valores de cada lado e qual trecho contém o ponto (bolinha fechada). */
export interface PiecewisePoint { x: number; left: number; right: number; value: number; continuous: boolean }

export function piecewisePoints(ast: Ast, v: string, symbols: readonly string[], env: ArrayLike<number>): PiecewisePoint[] {
  const points: PiecewisePoint[] = [];
  const values = Float64Array.from(env as ArrayLike<number>);
  const index = symbols.indexOf(v);
  const whole = compileExpression(ast, symbols);
  const at = (x: number): number => { values[index] = x; return whole.value(values); };
  const walk = (node: Ast): void => {
    if (!isNode(node)) return;
    if (node[0] === "If") {
      const c = arg(node, 1);
      if (isNode(c)) {
        const l = arg(c, 1), r = arg(c, 2);
        const boundary = l === v && !dependsOn(r, v) ? r : r === v && !dependsOn(l, v) ? l : undefined;
        if (boundary !== undefined) {
          const x = compileExpression(boundary, symbols).value(values);
          if (Number.isFinite(x)) {
            const h = 1e-9 * Math.max(1, Math.abs(x));
            const left = at(x - h), right = at(x + h), value = at(x);
            points.push({ x, left, right, value, continuous: Math.abs(left - right) <= 1e-6 * Math.max(1, Math.abs(left)) });
          }
        }
      }
    }
    node.slice(1).forEach(walk);
  };
  walk(ast);
  return points;
}
