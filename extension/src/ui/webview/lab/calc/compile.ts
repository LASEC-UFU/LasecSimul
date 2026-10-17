import { Ast, arg, argNode, argString, isNode } from "./ast.js";
import { differentiate } from "./derivative.js";
import { deflate, polyEval, rationalParts, toPolynomial } from "./poly.js";

/** Resultado com proveniência: exato (álgebra/substituição) ou numérico (método declarado). */
export type Evaluation =
  | { kind: "finite"; value: number; exact: boolean; methods: string[] }
  | { kind: "undefined"; reason: string; methods: string[] };

export interface CompiledExpression {
  /** Caminho quente: number (NaN quando indefinido), sem alocar. */
  value(env: ArrayLike<number>): number;
  /** Caminho de interface: classifica e informa o método. */
  evaluate(env: ArrayLike<number>): Evaluation;
}

type Fn = (e: Float64Array) => number;
interface Context { reason: string | undefined; exact: boolean; methods: Set<string> }

/**
 * Compila o AST para uma árvore de closures. Nada é gerado como texto e nada usa eval — compatível
 * com o CSP da Webview. Variáveis ligadas (∫, Σ, Π, lim) recebem posições próprias num vetor de
 * trabalho pré-alocado.
 */
export function compileExpression(ast: Ast, symbols: readonly string[]): CompiledExpression {
  const slots = new Map<string, number>(symbols.map((s, i) => [s, i]));
  let size = symbols.length;
  const ctx: Context = { reason: undefined, exact: true, methods: new Set() };
  const fail = (reason: string): number => { if (!ctx.reason) ctx.reason = reason; return NaN; };
  const approx = (method: string): void => { ctx.exact = false; ctx.methods.add(method); };
  const note = (method: string): void => { ctx.methods.add(method); };

  function withSlot<T>(name: string, fn: (slot: number) => T): T {
    const previous = slots.get(name);
    const slot = size++;
    slots.set(name, slot);
    try { return fn(slot); } finally { if (previous === undefined) slots.delete(name); else slots.set(name, previous); }
  }

  function build(node: Ast): Fn {
    if (typeof node === "number") return () => node;
    if (typeof node === "string") {
      const i = slots.get(node);
      if (i === undefined) throw new Error(`símbolo livre "${node}"`);
      return (e) => e[i] as number;
    }
    const head = node[0];
    const unary = (): Fn => build(arg(node, 1));
    switch (head) {
      case "Add": { const f = unary(), g = build(arg(node, 2)); return (e) => f(e) + g(e); }
      case "Subtract": { const f = unary(), g = build(arg(node, 2)); return (e) => f(e) - g(e); }
      case "Multiply": { const f = unary(), g = build(arg(node, 2)); return (e) => f(e) * g(e); }
      case "Divide": { const f = unary(), g = build(arg(node, 2)); return (e) => { const d = g(e); return d === 0 ? fail("divisão por zero") : f(e) / d; }; }
      case "Power": { const f = unary(), g = build(arg(node, 2)); return (e) => { const r = Math.pow(f(e), g(e)); return Number.isNaN(r) ? fail("potência fora do domínio real") : r; }; }
      case "Negate": { const f = unary(); return (e) => -f(e); }
      case "Sqrt": { const f = unary(); return (e) => { const x = f(e); return x < 0 ? fail("raiz de número negativo") : Math.sqrt(x); }; }
      case "Ln": { const f = unary(); return (e) => { const x = f(e); return x <= 0 ? fail("logaritmo de número não positivo") : Math.log(x); }; }
      case "Log": { const f = unary(); return (e) => { const x = f(e); return x <= 0 ? fail("logaritmo de número não positivo") : Math.log10(x); }; }
      case "Sin": { const f = unary(); return (e) => Math.sin(f(e)); }
      case "Cos": { const f = unary(); return (e) => Math.cos(f(e)); }
      case "Tan": { const f = unary(); return (e) => { const x = f(e); return Math.abs(Math.cos(x)) < 1e-15 ? fail("tangente indefinida (cos = 0)") : Math.tan(x); }; }
      case "Exp": { const f = unary(); return (e) => Math.exp(f(e)); }
      case "Abs": { const f = unary(); return (e) => Math.abs(f(e)); }
      case "Sign": { const f = unary(); return (e) => { const x = f(e); return x === 0 ? fail("não diferenciável: |u| tem canto onde u = 0") : Math.sign(x); }; }
      case "D": {
        const v = argString(node, 2);
        if (!slots.has(v)) throw new Error(`a variável de derivação "${v}" precisa ser variável da expressão`);
        const f = build(differentiate(arg(node, 1), v));
        return (e) => { note("derivada simbólica (regras)"); return f(e); };
      }
      case "Integrate": return buildIntegral(arg(node, 1), argNode(node, 2));
      case "Sum": case "Product": return buildSeries(head, arg(node, 1), argNode(node, 2));
      case "Limit": return buildLimit(arg(node, 1), argString(node, 2), arg(node, 3), arg(node, 4) as number);
      case "Call": throw new Error(`função "${String(arg(node, 1))}" não expandida`);
      default: throw new Error(`operação desconhecida ${head}`);
    }
  }

  function buildIntegral(body: Ast, limits: Ast): Fn {
    if (!isNode(limits)) throw new Error("limites de integração inválidos");
    const v = argString(limits, 1);
    const fLo = build(arg(limits, 2)), fHi = build(arg(limits, 3));
    const poly = toPolynomial(body, v);
    if (poly) { // antiderivada exata
      const anti = [0, ...poly.map((c, k) => c / (k + 1))];
      return (e) => { note("antiderivada de polinômio (exata)"); return polyEval(anti, fHi(e)) - polyEval(anti, fLo(e)); };
    }
    return withSlot(v, (slot) => {
      const f = build(body);
      return (e) => {
        const lo = fLo(e), hi = fHi(e);
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) return fail("limites de integração não finitos");
        approx("Simpson adaptativo (tolerância 1e-10)");
        const r = adaptiveSimpson((x) => { e[slot] = x; return f(e); }, lo, hi, 1e-10, 40);
        return Number.isFinite(r) ? r : fail("integrando indefinido no intervalo");
      };
    });
  }

  function buildSeries(head: string, body: Ast, limits: Ast): Fn {
    if (!isNode(limits)) throw new Error("índices inválidos");
    const k = argString(limits, 1);
    const fm = build(arg(limits, 2)), fn = build(arg(limits, 3));
    return withSlot(k, (slot) => {
      const f = build(body);
      return (e) => {
        const m = fm(e), n = fn(e);
        if (!Number.isInteger(m) || !Number.isInteger(n)) return fail("índices do somatório devem ser inteiros");
        if (n - m > 1e6) return fail("somatório com mais de 10⁶ termos");
        if (head === "Product") {
          note("produto finito (exato)");
          let p = 1;
          for (let i = m; i <= n; i++) { e[slot] = i; p *= f(e); }
          return p;
        }
        note("soma finita (exata, compensada)");
        let s = 0, c = 0;
        for (let i = m; i <= n; i++) { e[slot] = i; const y = f(e) - c; const t = s + y; c = t - s - y; s = t; }
        return s;
      };
    });
  }

  function buildLimit(body: Ast, v: string, target: Ast, side: number): Fn {
    const fTarget = build(target);
    const rational = rationalParts(body, v);
    const poly = toPolynomial(body, v);
    return withSlot(v, (slot) => {
      const f = build(body);
      return (e) => {
        const at = (x: number): number => { const saved = ctx.reason; e[slot] = x; const y = f(e); ctx.reason = saved; return y; };
        return evaluateLimit({ at, a: fTarget(e), side, poly, rational, fail, approx, note });
      };
    });
  }

  const root = build(ast);
  const scratch = new Float64Array(Math.max(size, 1));
  const n = symbols.length;
  const run = (env: ArrayLike<number>): number => { for (let i = 0; i < n; i++) scratch[i] = env[i] as number; return root(scratch); };
  return {
    value(env) { ctx.reason = undefined; return run(env); },
    evaluate(env) {
      ctx.reason = undefined; ctx.exact = true; ctx.methods = new Set();
      const v = run(env);
      const methods = [...ctx.methods];
      if (Number.isFinite(v)) return { kind: "finite", value: v, exact: ctx.exact, methods };
      return { kind: "undefined", reason: ctx.reason ?? (Number.isNaN(v) ? "valor indefinido" : v > 0 ? "diverge para +∞" : "diverge para −∞"), methods };
    },
  };
}

export function adaptiveSimpson(f: (x: number) => number, a: number, b: number, tol: number, maxDepth: number): number {
  const simpson = (fa: number, fm: number, fb: number, h: number): number => (h / 6) * (fa + 4 * fm + fb);
  function rec(lo: number, hi: number, fa: number, fm: number, fb: number, whole: number, eps: number, depth: number): number {
    const m = (lo + hi) / 2;
    const flm = f((lo + m) / 2), frm = f((m + hi) / 2);
    const left = simpson(fa, flm, fm, m - lo), right = simpson(fm, frm, fb, hi - m);
    if (!Number.isFinite(left + right)) return NaN;
    if (depth <= 0 || Math.abs(left + right - whole) <= 15 * eps) return left + right + (left + right - whole) / 15;
    return rec(lo, m, fa, flm, fm, left, eps / 2, depth - 1) + rec(m, hi, fm, frm, fb, right, eps / 2, depth - 1);
  }
  if (a === b) return 0;
  const fa = f(a), fb = f(b), fm = f((a + b) / 2);
  if (!Number.isFinite(fa + fb + fm)) return NaN;
  return rec(a, b, fa, fm, fb, simpson(fa, fm, fb, b - a), tol, maxDepth);
}

interface LimitInput {
  at: (x: number) => number; a: number; side: number;
  poly: number[] | undefined; rational: [number[], number[]] | undefined;
  fail: (reason: string) => number; approx: (method: string) => void; note: (method: string) => void;
}

/** Exato: continuidade, cancelamento de fator comum, comparação de graus. Senão: evidência numérica. */
function evaluateLimit({ at, a, side, poly, rational, fail, approx, note }: LimitInput): number {
  const sides = side === 0 ? [1, -1] : [side];
  const scale = (x: number): number => Math.max(1, Math.abs(x));
  if (!Number.isFinite(a)) {
    if (rational) {
      const [p, q] = rational;
      note("comparação de graus (racional, exata)");
      const dp = p.length - 1, dq = q.length - 1, s = Math.sign(a);
      const lead = (p[dp] as number) / (q[dq] as number);
      if (dp < dq) return 0;
      if (dp === dq) return lead;
      return fail(`diverge para ${Math.sign(lead) * s ** (dp - dq) > 0 ? "+∞" : "−∞"}`);
    }
    return numericSequence(at, (k) => Math.sign(a) * 10 ** k, [1], approx, fail, "x = ±10^k");
  }
  if (poly) { note("substituição direta (polinômio é contínuo)"); return polyEval(poly, a); }
  const fa = at(a);
  const neighbours = sides.map((s) => at(a + s * 1e-7 * scale(a)));
  if (Number.isFinite(fa) && neighbours.every((y) => Number.isFinite(y) && Math.abs(y - fa) <= 1e-5 * scale(fa))) {
    note("substituição direta (função elementar contínua no ponto)");
    return fa;
  }
  if (rational && !Number.isFinite(fa)) {
    const [p, q] = rational;
    let P = p, Q = q, guard = 0;
    while (Math.abs(polyEval(Q, a)) < 1e-12 * scale(a) && Math.abs(polyEval(P, a)) < 1e-12 && guard++ < 32) { P = deflate(P, a)[0]; Q = deflate(Q, a)[0]; }
    const pa = polyEval(P, a), qa = polyEval(Q, a);
    note(P.length < p.length ? "cancelamento do fator comum (x − a) (exato)" : "análise de sinais do quociente de polinômios (exata)");
    if (Math.abs(qa) > 1e-12) return pa / qa;
    const signs = sides.map((s) => Math.sign(polyEval(P, a + s * 1e-9) / polyEval(Q, a + s * 1e-9)));
    if (signs.every((x) => x === signs[0])) return fail(`diverge para ${(signs[0] ?? 0) > 0 ? "+∞" : "−∞"}`);
    return fail("limites laterais infinitos de sinais opostos: o limite não existe");
  }
  return numericSequence(at, (k, s) => a + s * 10 ** -k * scale(a), sides, approx, fail, "sequência lateral a ± 10^-k");
}

function numericSequence(
  at: (x: number) => number, point: (k: number, side: number) => number, sides: readonly number[],
  approx: (m: string) => void, fail: (r: string) => number, label: string,
): number {
  approx(`evidência numérica: ${label}`);
  const estimates: number[] = [];
  for (const s of sides) {
    const name = s > 0 ? "direito" : "esquerdo";
    const values: number[] = [];
    for (let k = 1; k <= 8; k++) values.push(at(point(k, s)));
    const tail = values.slice(-4);
    if (tail.some((y) => !Number.isFinite(y))) {
      const finite = tail.filter(Number.isFinite);
      if (finite.length && finite.every((y) => Math.abs(y) > 1e6)) return fail(`diverge pelo lado ${name}`);
      return fail(`função indefinida perto do ponto pelo lado ${name}`);
    }
    const last = tail[tail.length - 1] as number, prev = tail[tail.length - 2] as number;
    if (Math.abs(last) > 1e8) return fail(`diverge pelo lado ${name}`);
    if (!(Math.abs(last - prev) <= 1e-6 * Math.max(1, Math.abs(last)))) return fail(`sem convergência observada pelo lado ${name}`);
    estimates.push(Math.abs(last) < 1e-6 ? 0 : last); // abaixo da tolerância da evidência
  }
  const [right, left] = estimates as [number, number?];
  if (left !== undefined && Math.abs(right - left) > 1e-5 * Math.max(1, Math.abs(right))) {
    const r6 = (x: number): string => Number(x.toPrecision(6)).toLocaleString("pt-BR");
    return fail(`limites laterais diferentes (direita ≈ ${r6(right)}, esquerda ≈ ${r6(left)}): o limite não existe`);
  }
  return right;
}
