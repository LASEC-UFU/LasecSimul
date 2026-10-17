// Prova de conceito isolada (NÃO é produção). Núcleo matemático próprio, sem eval/new Function.
//
// AST JSON com cabeças inspiradas em MathJSON (subconjunto próprio, não idêntico):
//   número | "símbolo" | ["Add",a,b] ["Subtract",a,b] ["Multiply",a,b] ["Divide",a,b] ["Power",a,b]
//   ["Negate",a] ["Sin",a] ... ["Sqrt",a] ["Abs",a]
//   ["Integrate", corpo, ["Limits", v, a, b]]      integral definida
//   ["D", corpo, v]                                derivada em relação a v
//   ["Limit", corpo, v, alvo, lado]                lado: 0 bilateral, 1 direita, -1 esquerda
//   ["Sum"|"Product", corpo, ["Limits", k, m, n]]  soma/produto finitos
// Toda avaliação informa a proveniência: exata (álgebra ou substituição) ou numérica (método).

const UNARY = { sin: "Sin", cos: "Cos", tan: "Tan", exp: "Exp", abs: "Abs", sqrt: "Sqrt", ln: "Ln", log: "Log" };
const BINDERS = { Integrate: 4, D: 2, Limit: 4, Sum: 4, Product: 4 }; // aridade na sintaxe linear (variável primeiro)
const CONSTANTS = { π: Math.PI, pi: Math.PI, "∞": Infinity };

export class ExpressionError extends Error {
  constructor(message, column) { super(`${message} (coluna ${column + 1})`); this.column = column; }
}

// ------------------------------------------------------------------------------------- léxico
function tokenize(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === " " || c === "\t") { i++; continue; }
    if (/[0-9.]/.test(c)) {
      const start = i;
      while (i < text.length && /[0-9.]/.test(text[i])) i++;
      if (/[eE]/.test(text[i] ?? "") && /[0-9+-]/.test(text[i + 1] ?? "")) {
        const save = i; i++;
        if (text[i] === "+" || text[i] === "-") i++;
        if (/[0-9]/.test(text[i] ?? "")) { while (/[0-9]/.test(text[i] ?? "")) i++; } else i = save;
      }
      const raw = text.slice(start, i);
      if ((raw.match(/\./g) ?? []).length > 1 || !Number.isFinite(Number(raw))) throw new ExpressionError(`número inválido "${raw}"`, start);
      tokens.push({ kind: "num", value: Number(raw), pos: start });
      continue;
    }
    if (/[A-Za-zΔπ∞_]/.test(c)) {
      const start = i;
      if (c === "∞" || c === "π") { i++; tokens.push({ kind: "id", name: c, pos: start }); continue; }
      while (i < text.length && /[A-Za-z0-9Δ_]/.test(text[i])) i++;
      tokens.push({ kind: "id", name: text.slice(start, i), pos: start });
      continue;
    }
    const op = c === "·" || c === "×" ? "*" : c === "−" ? "-" : c;
    if ("+-*/^(),".includes(op)) { tokens.push({ kind: "op", op, pos: i }); i++; continue; }
    throw new ExpressionError(`caractere inesperado "${c}"`, i);
  }
  tokens.push({ kind: "end", pos: text.length });
  return tokens;
}

// ------------------------------------------------------------------------------------- sintaxe
/**
 * Pratt parser. `symbols`: variáveis livres permitidas. `functions`: funções do usuário
 * { nome: { param, ast } } — chamadas são expandidas por substituição, o que mantém derivação
 * simbólica e caminho polinomial funcionando (ex.: h(4+Δt)).
 */
export function parseExpression(text, symbols, { functions = {}, keepCalls = false } = {}) {
  const tokens = tokenize(text);
  let p = 0;
  const peek = () => tokens[p];
  const next = () => tokens[p++];
  const isOp = (t, op) => t.kind === "op" && t.op === op;
  const expectOp = (op) => { const t = next(); if (!isOp(t, op)) throw new ExpressionError(`esperado "${op}"`, t.pos); };
  const startsOperand = (t) => t.kind === "num" || t.kind === "id" || isOp(t, "(");

  function identifier(t, scope) {
    if (Object.hasOwn(CONSTANTS, t.name) && !scope.includes(t.name)) return CONSTANTS[t.name];
    if (scope.includes(t.name)) return t.name;
    if (t.name === "e") return Math.E;
    const parts = [...t.name];
    if (parts.length > 1 && parts.every((c) => scope.includes(c))) return parts.slice(1).reduce((acc, c) => ["Multiply", acc, c], parts[0]);
    throw new ExpressionError(`símbolo não declarado "${t.name}"`, t.pos);
  }
  function primary(scope) {
    const t = next();
    if (t.kind === "num") return t.value;
    if (t.kind === "id") {
      if (Object.hasOwn(UNARY, t.name)) { expectOp("("); const arg = expression(0, scope); expectOp(")"); return [UNARY[t.name], arg]; }
      if (Object.hasOwn(BINDERS, t.name)) return binder(t, scope);
      if (Object.hasOwn(functions, t.name) && isOp(peek(), "(")) {
        next(); const arg = expression(0, scope); expectOp(")");
        return keepCalls ? ["Call", t.name, arg] : substitute(functions[t.name].ast, functions[t.name].param, arg);
      }
      return identifier(t, scope);
    }
    if (isOp(t, "(")) { const e = expression(0, scope); expectOp(")"); return e; }
    if (isOp(t, "-")) return ["Negate", expression(3, scope)];
    throw new ExpressionError("operando esperado", t.pos);
  }
  function binder(t, scope) {
    expectOp("(");
    const v = next();
    if (v.kind !== "id" || Object.hasOwn(UNARY, v.name) || Object.hasOwn(CONSTANTS, v.name)) throw new ExpressionError("variável esperada", v.pos);
    const inner = [...scope, v.name];
    const args = [];
    for (let i = 1; i < BINDERS[t.name]; i++) {
      expectOp(",");
      const isBody = i === BINDERS[t.name] - 1;
      if (t.name === "Limit" && i === 2) { // lado: 0, 1 ou -1
        const sign = isOp(peek(), "-") ? (next(), -1) : 1;
        const d = next();
        if (d.kind !== "num" || ![0, 1].includes(d.value)) throw new ExpressionError("lado do limite inválido", d.pos);
        args.push(sign * d.value);
        continue;
      }
      args.push(expression(0, isBody ? inner : scope));
    }
    expectOp(")");
    const body = args.at(-1);
    switch (t.name) {
      case "Integrate": return ["Integrate", body, ["Limits", v.name, args[0], args[1]]];
      case "D": return ["D", body, v.name];
      case "Limit": return ["Limit", body, v.name, args[0], args[1]];
      default: return [t.name, body, ["Limits", v.name, args[0], args[1]]];
    }
  }
  const BIN = { "+": [1, "Add"], "-": [1, "Subtract"], "*": [2, "Multiply"], "/": [2, "Divide"], "^": [4, "Power"] };
  function expression(minPrec, scope) {
    let left = primary(scope);
    for (;;) {
      const t = peek();
      // multiplicação implícita (precedência 3): "0.5t", "2(x+1)", "t sin(t)", "(t+1)(t-1)"; nunca dentro de expoente
      if (startsOperand(t) && minPrec <= 3 && (typeof left === "number" || t.kind !== "num")) { left = ["Multiply", left, expression(4, scope)]; continue; }
      if (t.kind !== "op" || !BIN[t.op]) break;
      const [prec, head] = BIN[t.op];
      if (prec < minPrec) break;
      next();
      left = [head, left, expression(t.op === "^" ? prec : prec + 1, scope)];
    }
    return left;
  }
  const ast = expression(0, symbols);
  if (peek().kind !== "end") throw new ExpressionError("token inesperado", peek().pos);
  return ast;
}

// ------------------------------------------------------------------------------------- utilitários de AST
/** Substitui o símbolo `name` por `value`, respeitando variáveis ligadas (∫, Σ, Π, lim). */
export function substitute(ast, name, value) {
  if (ast === name) return value;
  if (!Array.isArray(ast)) return ast;
  const [head, ...args] = ast;
  const sub = (x) => substitute(x, name, value);
  switch (head) {
    case "Limits": return ["Limits", args[0], sub(args[1]), sub(args[2])];
    // D não liga variável: substituir a própria variável de derivação exige derivar antes
    case "D": return args[1] === name ? sub(differentiate(args[0], args[1])) : ["D", sub(args[0]), args[1]];
    case "Limit": return ["Limit", args[1] === name ? args[0] : sub(args[0]), args[1], sub(args[2]), args[3]];
    case "Integrate": case "Sum": case "Product": return [head, args[1][1] === name ? args[0] : sub(args[0]), sub(args[1])];
    default: return [head, ...args.map(sub)];
  }
}
function boundVariable(ast) {
  if (!Array.isArray(ast)) return undefined;
  if (ast[0] === "Limit") return ast[2];
  if (["Integrate", "Sum", "Product"].includes(ast[0])) return ast[2][1];
  return undefined;
}
export function dependsOn(ast, v) {
  if (ast === v) return true;
  if (!Array.isArray(ast)) return false;
  if (ast[0] === "Limits") return dependsOn(ast[2], v) || dependsOn(ast[3], v);
  if (ast[0] === "D") return dependsOn(ast[1], v) || ast[2] === v;
  if (boundVariable(ast) === v) { // a variável ligada não conta; alvo/limites podem depender de v externo
    return ast[0] === "Limit" ? dependsOn(ast[3], v) : dependsOn(ast[2], v);
  }
  return ast.slice(1).some((a) => dependsOn(a, v));
}

// ------------------------------------------------------------------------------------- polinômios
/** Coeficientes [c0, c1, ...] se `ast` é polinômio em `v` com coeficientes numéricos; senão undefined. */
export function toPolynomial(ast, v) {
  const add = (a, b) => Array.from({ length: Math.max(a.length, b.length) }, (_, i) => (a[i] ?? 0) + (b[i] ?? 0));
  const mul = (a, b) => { const r = new Array(a.length + b.length - 1).fill(0); a.forEach((x, i) => b.forEach((y, j) => { r[i + j] += x * y; })); return r; };
  function go(node) {
    if (typeof node === "number") return Number.isFinite(node) ? [node] : undefined;
    if (typeof node === "string") return node === v ? [0, 1] : undefined;
    const [head, a, b] = node;
    if (!["Add", "Subtract", "Multiply", "Divide", "Power", "Negate"].includes(head)) return undefined;
    const pa = go(a), pb = head === "Negate" ? undefined : go(b);
    switch (head) {
      case "Add": return pa && pb && add(pa, pb);
      case "Subtract": return pa && pb && add(pa, pb.map((x) => -x));
      case "Negate": return pa && pa.map((x) => -x);
      case "Multiply": return pa && pb && mul(pa, pb);
      case "Power": {
        if (!pa || !pb || pb.length !== 1 || !Number.isInteger(pb[0]) || pb[0] < 0 || pb[0] > 32) return undefined;
        let r = [1];
        for (let k = 0; k < pb[0]; k++) r = mul(r, pa);
        return r;
      }
      case "Divide": return pa && pb && pb.length === 1 && pb[0] !== 0 ? pa.map((x) => x / pb[0]) : undefined;
      default: return undefined;
    }
  }
  const r = go(ast);
  if (!r) return undefined;
  while (r.length > 1 && r.at(-1) === 0) r.pop();
  return r;
}
export const polyEval = (c, x) => c.reduceRight((acc, k) => acc * x + k, 0);
/** Divide por (x − a) (Ruffini); devolve [quociente, resto]. */
function deflate(c, a) {
  const n = c.length - 1;
  if (n < 1) return [[0], c[0]];
  const q = new Array(n).fill(0);
  let carry = c[n];
  for (let k = n - 1; k >= 0; k--) { q[k] = carry; carry = c[k] + carry * a; }
  return [q, carry];
}
export function differenceQuotientPolynomial(coeffs, a) {
  const shifted = new Array(coeffs.length).fill(0);
  coeffs.forEach((c, k) => { let binom = 1; for (let j = 0; j <= k; j++) { shifted[j] += c * binom * a ** (k - j); binom = (binom * (k - j)) / (j + 1); } });
  return shifted.slice(1);
}
export function formatPolynomial(coeffs, variable, decimals = 6) {
  const fmt = (x) => Number(x.toFixed(decimals)).toLocaleString("pt-BR", { maximumFractionDigits: decimals });
  const parts = [];
  coeffs.forEach((c, k) => {
    if (Math.abs(c) < 1e-15) return;
    const mag = Math.abs(c), coef = k > 0 && mag === 1 ? "" : fmt(mag);
    parts.push({ sign: c < 0 ? "−" : "+", term: k === 0 ? coef : `${coef}${variable}${k > 1 ? `^${k}` : ""}` });
  });
  if (!parts.length) return "0";
  return parts.map((p, i) => (i === 0 ? (p.sign === "−" ? "−" : "") + p.term : ` ${p.sign} ${p.term}`)).join("");
}

// ------------------------------------------------------------------------------------- derivação simbólica
const S = (node) => simplify(node);
/** d(ast)/dv por regras. Lança erro se uma construção não tiver regra (ex.: limite dentro de D). */
export function differentiate(ast, v) {
  if (!dependsOn(ast, v)) return 0;
  if (ast === v) return 1;
  const [head, a, b] = ast;
  const d = (x) => differentiate(x, v);
  switch (head) {
    case "Add": return S(["Add", d(a), d(b)]);
    case "Subtract": return S(["Subtract", d(a), d(b)]);
    case "Negate": return S(["Negate", d(a)]);
    case "Multiply": return S(["Add", ["Multiply", d(a), b], ["Multiply", a, d(b)]]);
    case "Divide": return S(["Divide", ["Subtract", ["Multiply", d(a), b], ["Multiply", a, d(b)]], ["Power", b, 2]]);
    case "Power":
      if (!dependsOn(b, v)) return S(["Multiply", ["Multiply", b, ["Power", a, S(["Subtract", b, 1])]], d(a)]);
      if (!dependsOn(a, v)) return S(["Multiply", ["Multiply", ast, ["Ln", a]], d(b)]);
      return S(["Multiply", ast, ["Add", ["Multiply", d(b), ["Ln", a]], ["Divide", ["Multiply", b, d(a)], a]]]);
    case "Sqrt": return S(["Divide", d(a), ["Multiply", 2, ast]]);
    case "Sin": return S(["Multiply", ["Cos", a], d(a)]);
    case "Cos": return S(["Negate", ["Multiply", ["Sin", a], d(a)]]);
    case "Tan": return S(["Divide", d(a), ["Power", ["Cos", a], 2]]);
    case "Exp": return S(["Multiply", ast, d(a)]);
    case "Sign": return 0; // fora de 0; em 0 a própria função é indefinida
    case "Ln": return S(["Divide", d(a), a]);
    case "Log": return S(["Divide", d(a), ["Multiply", a, ["Ln", 10]]]);
    case "Abs": return S(["Multiply", d(a), ["Sign", a]]); // Sign é indefinido em 0: |u| tem canto
    case "D": return differentiate(differentiate(a, b), v);
    case "Integrate": { // regra de Leibniz/TFC: integrando independe de v
      const [, s, lo, hi] = b;
      if (dependsOn(a, v)) throw new Error("integrando depende da variável de derivação: fora do escopo");
      return S(["Subtract", ["Multiply", substitute(a, s, hi), d(hi)], ["Multiply", substitute(a, s, lo), d(lo)]]);
    }
    case "Sum": {
      const [, , m, n] = b;
      if (dependsOn(m, v) || dependsOn(n, v)) throw new Error("limites do somatório dependem da variável de derivação");
      return S(["Sum", differentiate(a, v), b]);
    }
    default: throw new Error(`sem regra de derivação para ${head}`);
  }
}
/** Simplificação leve: dobra constantes, elementos neutros e coeficientes numéricos de produtos. */
export function simplify(node) {
  if (!Array.isArray(node)) return node;
  const [head, ...rawArgs] = node;
  if (head === "Limits") return node;
  const args = rawArgs.map((x) => (Array.isArray(x) || typeof x === "number" || typeof x === "string" ? simplify(x) : x));
  const [a, b] = args;
  const isNum = (x) => typeof x === "number";
  switch (head) {
    case "Add":
      if (isNum(a) && isNum(b)) return a + b;
      if (a === 0) return b; if (b === 0) return a;
      if (Array.isArray(b) && b[0] === "Negate") return simplify(["Subtract", a, b[1]]);
      return ["Add", a, b];
    case "Subtract":
      if (isNum(a) && isNum(b)) return a - b;
      if (b === 0) return a; if (a === 0) return simplify(["Negate", b]);
      return ["Subtract", a, b];
    case "Negate":
      if (isNum(a)) return -a;
      if (Array.isArray(a) && a[0] === "Negate") return a[1];
      return ["Negate", a];
    case "Multiply": {
      const factors = [];
      const flat = (x) => (Array.isArray(x) && x[0] === "Multiply" ? (flat(x[1]), flat(x[2])) : factors.push(x));
      flat(a); flat(b);
      let coef = 1; const rest = [];
      for (const f of factors) { if (isNum(f)) coef *= f; else if (Array.isArray(f) && f[0] === "Negate") { coef = -coef; rest.push(f[1]); } else rest.push(f); }
      if (coef === 0) return 0;
      if (!rest.length) return coef;
      const body = rest.reduce((acc, f) => ["Multiply", acc, f]);
      return coef === 1 ? body : coef === -1 ? ["Negate", body] : ["Multiply", coef, body];
    }
    case "Divide":
      if (isNum(a) && isNum(b) && b !== 0) return a / b;
      if (a === 0) return 0; if (b === 1) return a;
      return ["Divide", a, b];
    case "Power":
      if (isNum(a) && isNum(b)) return a ** b;
      if (b === 1) return a; if (b === 0) return 1;
      return ["Power", a, b];
    default: return [head, ...args];
  }
}

// ------------------------------------------------------------------------------------- compilação e avaliação
const LIMIT_STEPS = [1e-1, 1e-2, 1e-3, 1e-4, 1e-5, 1e-6, 1e-7, 1e-8];

/**
 * Compila para árvore de closures. Variáveis ligadas (∫, Σ, lim) ganham posições próprias num
 * vetor de trabalho; nada é gerado como texto. `evaluate` devolve proveniência:
 *   { kind: "finite", value, exact: boolean, methods: string[] } | { kind: "undefined", reason }
 */
export function compileExpression(ast, symbols) {
  const slots = new Map(symbols.map((s, i) => [s, i]));
  let size = symbols.length;
  const ctx = { reason: undefined, exact: true, methods: new Set() };
  const fail = (reason) => { if (!ctx.reason) ctx.reason = reason; return NaN; };
  const approx = (method) => { ctx.exact = false; ctx.methods.add(method); };
  const note = (method) => ctx.methods.add(method);

  function withSlot(name, fn) {
    const prev = slots.get(name);
    const slot = size++;
    slots.set(name, slot);
    try { return fn(slot); } finally { if (prev === undefined) slots.delete(name); else slots.set(name, prev); }
  }
  function build(node) {
    if (typeof node === "number") return () => node;
    if (typeof node === "string") {
      const i = slots.get(node);
      if (i === undefined) throw new Error(`símbolo livre "${node}"`);
      return (e) => e[i];
    }
    const [head, a, b] = node;
    switch (head) {
      case "Add": { const f = build(a), g = build(b); return (e) => f(e) + g(e); }
      case "Subtract": { const f = build(a), g = build(b); return (e) => f(e) - g(e); }
      case "Multiply": { const f = build(a), g = build(b); return (e) => f(e) * g(e); }
      case "Divide": { const f = build(a), g = build(b); return (e) => { const d = g(e); return d === 0 ? fail("divisão por zero") : f(e) / d; }; }
      case "Power": { const f = build(a), g = build(b); return (e) => { const r = Math.pow(f(e), g(e)); return Number.isNaN(r) ? fail("potência fora do domínio real") : r; }; }
      case "Negate": { const f = build(a); return (e) => -f(e); }
      case "Sqrt": { const f = build(a); return (e) => { const x = f(e); return x < 0 ? fail("raiz de número negativo") : Math.sqrt(x); }; }
      case "Ln": { const f = build(a); return (e) => { const x = f(e); return x <= 0 ? fail("logaritmo de número não positivo") : Math.log(x); }; }
      case "Log": { const f = build(a); return (e) => { const x = f(e); return x <= 0 ? fail("logaritmo de número não positivo") : Math.log10(x); }; }
      case "Sin": { const f = build(a); return (e) => Math.sin(f(e)); }
      case "Cos": { const f = build(a); return (e) => Math.cos(f(e)); }
      case "Tan": { const f = build(a); return (e) => { const x = f(e), c = Math.cos(x); return Math.abs(c) < 1e-15 ? fail("tangente indefinida (cos = 0)") : Math.tan(x); }; }
      case "Exp": { const f = build(a); return (e) => Math.exp(f(e)); }
      case "Abs": { const f = build(a); return (e) => Math.abs(f(e)); }
      case "Sign": { const f = build(a); return (e) => { const x = f(e); return x === 0 ? fail("não diferenciável: |u| tem canto onde u = 0") : Math.sign(x); }; }
      case "D": { // derivada simbólica em tempo de compilação
        if (!slots.has(b)) throw new Error(`a variável de derivação "${b}" precisa ser variável da expressão`);
        const f = build(differentiate(a, b));
        return (e) => { note("derivada simbólica (regras)"); return f(e); };
      }
      case "Integrate": return buildIntegral(a, b);
      case "Sum": case "Product": return buildSeries(head, a, b);
      case "Limit": return buildLimit(node);
      default: throw new Error(`operação desconhecida ${head}`);
    }
  }
  function buildIntegral(body, [, v, lo, hi]) {
    const fLo = build(lo), fHi = build(hi);
    const poly = toPolynomial(body, v);
    if (poly) { // antiderivada exata
      const anti = [0, ...poly.map((c, k) => c / (k + 1))];
      return (e) => { note("antiderivada de polinômio (exata)"); const A = fLo(e), B = fHi(e); return polyEval(anti, B) - polyEval(anti, A); };
    }
    return withSlot(v, (slot) => {
      const f = build(body);
      return (e) => {
        const A = fLo(e), B = fHi(e);
        if (!Number.isFinite(A) || !Number.isFinite(B)) return fail("limites de integração não finitos");
        approx("Simpson adaptativo (tolerância 1e-10)");
        const at = (x) => { e[slot] = x; return f(e); };
        const r = adaptiveSimpson(at, A, B, 1e-10, 40);
        return Number.isFinite(r) ? r : fail("integrando indefinido no intervalo");
      };
    });
  }
  function buildSeries(head, body, [, k, m, n]) {
    const fm = build(m), fn = build(n);
    return withSlot(k, (slot) => {
      const f = build(body);
      return (e) => {
        const M = fm(e), N = fn(e);
        if (!Number.isInteger(M) || !Number.isInteger(N)) return fail("índices do somatório devem ser inteiros");
        if (N - M > 1e6) return fail("somatório com mais de 10⁶ termos");
        note(head === "Sum" ? "soma finita (exata, compensada)" : "produto finito (exato)");
        if (head === "Product") { let p = 1; for (let i = M; i <= N; i++) { e[slot] = i; p *= f(e); } return p; }
        let s = 0, c = 0;
        for (let i = M; i <= N; i++) { e[slot] = i; const y = f(e) - c; const t = s + y; c = t - s - y; s = t; }
        return s;
      };
    });
  }
  function buildLimit([, body, v, target, side]) {
    const fTarget = build(target);
    const rational = Array.isArray(body) && body[0] === "Divide" ? [toPolynomial(body[1], v), toPolynomial(body[2], v)] : [undefined, undefined];
    const poly = toPolynomial(body, v);
    return withSlot(v, (slot) => {
      const f = build(body);
      return (e) => {
        const a = fTarget(e);
        const at = (x) => { const saved = ctx.reason; e[slot] = x; const y = f(e); ctx.reason = saved; return y; };
        return evaluateLimit({ at, a, side, poly, rational, fail, approx, note });
      };
    });
  }
  const root = build(ast);
  const scratch = new Float64Array(Math.max(size, 1));
  const n = symbols.length;
  const run = (env) => { for (let i = 0; i < n; i++) scratch[i] = env[i]; return root(scratch); };
  return {
    value(env) { ctx.reason = undefined; return run(env); },
    evaluate(env) {
      ctx.reason = undefined; ctx.exact = true; ctx.methods = new Set();
      const v = run(env);
      if (Number.isFinite(v)) return { kind: "finite", value: v, exact: ctx.exact, methods: [...ctx.methods] };
      return { kind: "undefined", reason: ctx.reason ?? (Number.isNaN(v) ? "valor indefinido" : v > 0 ? "diverge para +∞" : "diverge para −∞"), methods: [...ctx.methods] };
    },
  };
}

function adaptiveSimpson(f, a, b, tol, maxDepth) {
  const simpson = (fa, fm, fb, h) => (h / 6) * (fa + 4 * fm + fb);
  function rec(a, b, fa, fm, fb, whole, tol, depth) {
    const m = (a + b) / 2, lm = (a + m) / 2, rm = (m + b) / 2;
    const flm = f(lm), frm = f(rm);
    const left = simpson(fa, flm, fm, m - a), right = simpson(fm, frm, fb, b - m);
    if (!Number.isFinite(left + right)) return NaN;
    if (depth <= 0 || Math.abs(left + right - whole) <= 15 * tol) return left + right + (left + right - whole) / 15;
    return rec(a, m, fa, flm, fm, left, tol / 2, depth - 1) + rec(m, b, fm, frm, fb, right, tol / 2, depth - 1);
  }
  if (a === b) return 0;
  const fa = f(a), fb = f(b), fm = f((a + b) / 2);
  if (!Number.isFinite(fa + fb + fm)) return NaN;
  return rec(a, b, fa, fm, fb, simpson(fa, fm, fb, b - a), tol, maxDepth);
}

/** Limite com proveniência. Exato: continuidade ou cancelamento de fator comum; senão evidência numérica. */
function evaluateLimit({ at, a, side, poly, rational, fail, approx, note }) {
  const sides = side === 0 ? [1, -1] : [side];
  const scale = (x) => Math.max(1, Math.abs(x));
  if (a === Infinity || a === -Infinity) {
    const [p, q] = rational;
    if (p && q) {
      note("comparação de graus (racional, exata)");
      const dp = p.length - 1, dq = q.length - 1, s = Math.sign(a);
      if (dp < dq) return 0;
      if (dp === dq) return p.at(-1) / q.at(-1);
      return fail(`diverge para ${Math.sign(p.at(-1) / q.at(-1)) * s ** (dp - dq) > 0 ? "+∞" : "−∞"}`);
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
  const [p, q] = rational;
  if (p && q && !Number.isFinite(fa)) {
    let P = p, Q = q, guard = 0;
    while (Math.abs(polyEval(Q, a)) < 1e-12 * scale(a) && Math.abs(polyEval(P, a)) < 1e-12 && guard++ < 32) { P = deflate(P, a)[0]; Q = deflate(Q, a)[0]; }
    const pa = polyEval(P, a), qa = polyEval(Q, a);
    note(P.length < p.length ? "cancelamento do fator comum (x − a) (exato)" : "análise de sinais do quociente de polinômios (exata)");
    if (Math.abs(qa) > 1e-12) return pa / qa;
    const signs = sides.map((s) => Math.sign(polyEval(P, a + s * 1e-9) / polyEval(Q, a + s * 1e-9)));
    if (signs.every((x) => x === signs[0])) return fail(`diverge para ${signs[0] > 0 ? "+∞" : "−∞"}`);
    return fail("limites laterais infinitos de sinais opostos: o limite não existe");
  }
  return numericSequence(at, (k, s) => a + s * 10 ** -k * scale(a), sides, approx, fail, "sequência lateral a ± 10^-k");
}
function numericSequence(at, point, sides, approx, fail, label) {
  approx(`evidência numérica: ${label}`);
  const estimates = [];
  for (const s of sides) {
    const values = [];
    for (let k = 1; k <= 8; k++) values.push(at(point(k, s)));
    const tail = values.slice(-4);
    if (tail.some((y) => !Number.isFinite(y))) {
      const big = tail.filter(Number.isFinite);
      if (big.length && big.every((y) => Math.abs(y) > 1e6)) return fail(`diverge pelo lado ${s > 0 ? "direito" : "esquerdo"}`);
      return fail(`função indefinida perto do ponto pelo lado ${s > 0 ? "direito" : "esquerdo"}`);
    }
    const diffs = tail.slice(1).map((y, i) => Math.abs(y - tail[i]));
    const scaleV = Math.max(1, Math.abs(tail.at(-1)));
    if (Math.abs(tail.at(-1)) > 1e8) return fail(`diverge pelo lado ${s > 0 ? "direito" : "esquerdo"}`);
    if (!(diffs.at(-1) <= 1e-6 * scaleV)) return fail(`sem convergência observada pelo lado ${s > 0 ? "direito" : "esquerdo"}`);
    estimates.push(Math.abs(tail.at(-1)) < 1e-6 ? 0 : tail.at(-1)); // abaixo da tolerância da evidência
  }
  if (estimates.length === 2 && Math.abs(estimates[0] - estimates[1]) > 1e-5 * Math.max(1, Math.abs(estimates[0]))) {
    return fail(`limites laterais diferentes (direita ≈ ${round6(estimates[0])}, esquerda ≈ ${round6(estimates[1])}): o limite não existe`);
  }
  return estimates[0];
}
const round6 = (x) => Number(x.toPrecision(6)).toLocaleString("pt-BR");

// ------------------------------------------------------------------------------------- MathML
const PREC = { Add: 1, Subtract: 1, Multiply: 2, Divide: 3, Negate: 3, Power: 4 };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
/** AST -> marcação MathML Core (texto escapado). */
export function astToMathML(ast, { display = "inline" } = {}) {
  const numML = (v) => (v === Math.PI ? "<mi>π</mi>" : v === Math.E ? "<mi>e</mi>" : v === Infinity ? "<mi>∞</mi>" : v === -Infinity ? "<mrow><mo>−</mo><mi>∞</mi></mrow>"
    : `<mn>${esc(String(Number(v.toPrecision(12))).replace(".", ","))}</mn>`);
  const prec = (node) => (Array.isArray(node) ? PREC[node[0]] ?? 5 : typeof node === "number" && node < 0 ? 3 : 5);
  const wrap = (node, min) => (prec(node) < min ? `<mrow><mo>(</mo>${go(node)}<mo>)</mo></mrow>` : go(node));
  const fn = (name, a) => `<mrow><mi>${name}</mi><mo>&#x2061;</mo><mrow><mo>(</mo>${go(a)}<mo>)</mo></mrow></mrow>`;
  function go(node) {
    if (typeof node === "number") return numML(node);
    if (typeof node === "string") return `<mi>${esc(node)}</mi>`;
    const [head, a, b, c, d] = node;
    switch (head) {
      case "Add": return `<mrow>${wrap(a, 1)}<mo>+</mo>${wrap(b, 2)}</mrow>`;
      case "Subtract": return `<mrow>${wrap(a, 1)}<mo>−</mo>${wrap(b, 2)}</mrow>`;
      case "Multiply": {
        const implicit = typeof a === "number" && (typeof b === "string" || (Array.isArray(b) && ["Power", "Sin", "Cos", "Tan", "Exp", "Ln", "Log", "Sqrt"].includes(b[0])));
        return implicit ? `<mrow>${numML(a)}<mo>&#x2062;</mo>${wrap(b, 2)}</mrow>` : `<mrow>${wrap(a, 2)}<mo>·</mo>${wrap(b, 3)}</mrow>`;
      }
      case "Divide": return `<mfrac>${go(a)}${go(b)}</mfrac>`;
      case "Power": return `<msup>${wrap(a, 5)}${go(b)}</msup>`;
      case "Negate": return `<mrow><mo>−</mo>${wrap(a, 3)}</mrow>`;
      case "Sqrt": return `<msqrt>${go(a)}</msqrt>`;
      case "Abs": return `<mrow><mo>|</mo>${go(a)}<mo>|</mo></mrow>`;
      case "Equal": return `<mrow>${go(a)}<mo>=</mo>${go(b)}</mrow>`;
      case "Sin": case "Cos": case "Tan": case "Exp": case "Ln": case "Log": case "Sign": return fn({ Sin: "sen", Cos: "cos", Tan: "tg", Exp: "exp", Ln: "ln", Log: "log", Sign: "sgn" }[head], a);
      case "Integrate": return `<mrow><msubsup><mo>∫</mo>${go(b[2])}${go(b[3])}</msubsup>${wrap(a, 2)}<mspace width="0.17em"/><mi>d</mi><mi>${esc(b[1])}</mi></mrow>`;
      case "D": return `<mrow><mfrac><mi>d</mi><mrow><mi>d</mi><mi>${esc(b)}</mi></mrow></mfrac>${wrap(a, 5)}</mrow>`;
      case "Limit": return `<mrow><munder><mo movablelimits="false">lim</mo><mrow><mi>${esc(b)}</mi><mo>→</mo>${d === 0 ? go(c) : `<msup>${go(c)}<mo>${d > 0 ? "+" : "−"}</mo></msup>`}</mrow></munder>${wrap(a, 2)}</mrow>`;
      case "Sum": case "Product": return `<mrow><munderover><mo movablelimits="false">${head === "Sum" ? "∑" : "∏"}</mo><mrow><mi>${esc(b[1])}</mi><mo>=</mo>${go(b[2])}</mrow>${go(b[3])}</munderover>${wrap(a, 2)}</mrow>`;
      case "Call": return `<mrow><mi>${esc(a)}</mi><mo>&#x2061;</mo><mrow><mo>(</mo>${go(b)}<mo>)</mo></mrow></mrow>`;
      default: return fn(esc(String(head).toLowerCase()), a);
    }
  }
  return `<math display="${display}">${go(ast)}</math>`;
}
