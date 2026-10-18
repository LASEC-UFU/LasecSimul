import { Ast, arg, dependsOn, isNode } from "./ast.js";
import { simplify } from "./derivative.js";
import { toPolynomial } from "./poly.js";

/**
 * Antiderivada simbólica para o Cálculo 1 (docs/52 §4.6, M7): linearidade, potências, exp/sen/cos/ln
 * de argumento linear e integração por partes (polinômio × exp/sen/cos, polinômio × ln). Sem CAS geral:
 * fora dessas formas devolve `undefined` e quem integra usa a quadratura numérica.
 *
 * `conditions`: hipóteses de domínio sobre argumentos lineares u = a·v + b (ln u exige u > 0; ln|u| e
 * potências negativas exigem u ≠ 0; raízes exigem u ≥ 0). Quem avalia F(b) − F(a) confere que valem no
 * intervalo inteiro -- senão a integral é imprópria e o atalho não se aplica.
 */
export interface DomainCondition { a: Ast; b: Ast; rule: "positive" | "nonzero" | "nonnegative" }
export interface Antiderivative { ast: Ast; methods: string[]; conditions: DomainCondition[] }

interface Linear { a: Ast; b: Ast }

const RULES = "regras de antiderivada (exata)";
const PARTS = "integração por partes (exata)";

/** u = a·v + b com a, b independentes de v (coeficientes podem ser parâmetros simbólicos). */
export function linearIn(u: Ast, v: string): Linear | undefined {
  if (!dependsOn(u, v)) return { a: 0, b: u };
  if (u === v) return { a: 1, b: 0 };
  if (!isNode(u)) return undefined;
  const S = simplify;
  const x = (): Ast => arg(u, 1), y = (): Ast => arg(u, 2);
  switch (u[0]) {
    case "Add": case "Subtract": {
      const p = linearIn(x(), v), q = linearIn(y(), v);
      if (!p || !q) return undefined;
      return { a: S([u[0], p.a, q.a]), b: S([u[0], p.b, q.b]) };
    }
    case "Negate": { const p = linearIn(x(), v); return p && { a: S(["Negate", p.a]), b: S(["Negate", p.b]) }; }
    case "Multiply": {
      const [c, w] = !dependsOn(x(), v) ? [x(), y()] : !dependsOn(y(), v) ? [y(), x()] : [undefined, undefined];
      if (c === undefined || w === undefined) return undefined;
      const p = linearIn(w, v);
      return p && { a: S(["Multiply", c, p.a]), b: S(["Multiply", c, p.b]) };
    }
    case "Divide": {
      if (dependsOn(y(), v)) return undefined;
      const p = linearIn(x(), v);
      return p && { a: S(["Divide", p.a, y()]), b: S(["Divide", p.b, y()]) };
    }
    default: return undefined;
  }
}

const polyToAst = (coefficients: readonly number[], v: string): Ast => {
  let sum: Ast = 0;
  coefficients.forEach((c, k) => {
    if (c === 0) return;
    const term: Ast = k === 0 ? c : ["Multiply", c, k === 1 ? v : ["Power", v, k]];
    sum = sum === 0 ? term : ["Add", sum, term];
  });
  return simplify(sum);
};
const derivePoly = (p: readonly number[]): number[] => p.slice(1).map((c, k) => c * (k + 1));
const integratePoly = (p: readonly number[]): number[] => [0, ...p.map((c, k) => c / (k + 1))];

export function antiderivative(ast: Ast, v: string): Antiderivative | undefined {
  const methods = new Set<string>();
  const conditions: DomainCondition[] = [];
  const result = go(ast);
  return result === undefined ? undefined : { ast: simplify(result), methods: [...methods], conditions };

  function go(node: Ast): Ast | undefined {
    const S = simplify;
    if (!dependsOn(node, v)) { methods.add(RULES); return ["Multiply", node, v]; }
    const poly = toPolynomial(node, v);
    if (poly) { methods.add("antiderivada de polinômio (exata)"); return polyToAst(integratePoly(poly), v); }
    if (!isNode(node)) return undefined;
    const x = (): Ast => arg(node, 1), y = (): Ast => arg(node, 2);
    switch (node[0]) {
      case "Add": case "Subtract": {
        const p = go(x()), q = go(y());
        return p !== undefined && q !== undefined ? [node[0], p, q] : undefined;
      }
      case "Negate": { const p = go(x()); return p === undefined ? undefined : ["Negate", p]; }
      case "Multiply": {
        if (!dependsOn(x(), v)) { const p = go(y()); return p === undefined ? undefined : ["Multiply", x(), p]; }
        if (!dependsOn(y(), v)) { const p = go(x()); return p === undefined ? undefined : ["Multiply", y(), p]; }
        return byParts(x(), y()) ?? byParts(y(), x());
      }
      case "Divide": {
        if (!dependsOn(y(), v)) { const p = go(x()); return p === undefined ? undefined : ["Divide", p, y()]; }
        if (!dependsOn(x(), v)) { // c/u, u linear
          const u = linearIn(y(), v);
          if (!u || u.a === 0) return undefined;
          methods.add(RULES);
          conditions.push({ ...u, rule: "nonzero" });
          return S(["Divide", ["Multiply", x(), ["Ln", ["Abs", y()]]], u.a]);
        }
        return undefined;
      }
      case "Power": {
        const base = x(), exponent = y();
        if (!dependsOn(exponent, v)) {
          const u = linearIn(base, v);
          if (!u || u.a === 0) return undefined;
          methods.add(RULES);
          if (exponent === -1) { conditions.push({ ...u, rule: "nonzero" }); return S(["Divide", ["Ln", ["Abs", base]], u.a]); }
          if (typeof exponent !== "number" || !Number.isInteger(exponent)) conditions.push({ ...u, rule: typeof exponent === "number" && exponent > 0 ? "nonnegative" : "positive" });
          else if (exponent < 0) conditions.push({ ...u, rule: "nonzero" });
          const next = S(["Add", exponent, 1]);
          return S(["Divide", ["Power", base, next], ["Multiply", next, u.a]]);
        }
        if (!dependsOn(base, v)) { // c^u = e^{u ln c}
          const u = linearIn(exponent, v);
          if (!u || u.a === 0) return undefined;
          methods.add(RULES);
          return S(["Divide", node, ["Multiply", u.a, ["Ln", base]]]);
        }
        return undefined;
      }
      case "Sqrt": {
        const u = linearIn(x(), v);
        if (!u || u.a === 0) return undefined;
        methods.add(RULES);
        conditions.push({ ...u, rule: "nonnegative" });
        return S(["Divide", ["Multiply", 2, ["Power", x(), 1.5]], ["Multiply", 3, u.a]]);
      }
      case "Exp": case "Sin": case "Cos": {
        const u = linearIn(x(), v);
        if (!u || u.a === 0) return undefined;
        methods.add(RULES);
        if (node[0] === "Exp") return S(["Divide", node, u.a]);
        if (node[0] === "Sin") return S(["Negate", ["Divide", ["Cos", x()], u.a]]);
        return S(["Divide", ["Sin", x()], u.a]);
      }
      case "Ln": { // ∫ ln u = (u ln u − u)/a, por partes
        const u = linearIn(x(), v);
        if (!u || u.a === 0) return undefined;
        methods.add(PARTS);
        conditions.push({ ...u, rule: "positive" });
        return S(["Divide", ["Subtract", ["Multiply", x(), ["Ln", x()]], x()], u.a]);
      }
      default: return undefined;
    }
  }

  /** P(v)·g(u) por partes (tabular): P polinômio numérico, g ∈ {exp, sen, cos} de argumento linear,
   * ou P(v)·ln v. */
  function byParts(first: Ast, second: Ast): Ast | undefined {
    const P = toPolynomial(first, v);
    if (!P || !isNode(second)) return undefined;
    const S = simplify;
    if (second[0] === "Ln" && arg(second, 1) === v) { // ∫P ln v = Q ln v − ∫Q/v, Q = ∫P (sem termo constante)
      methods.add(PARTS);
      conditions.push({ a: 1, b: 0, rule: "positive" });
      const Q = integratePoly(P);
      return S(["Subtract", ["Multiply", polyToAst(Q, v), ["Ln", v]], polyToAst(integratePoly(Q.slice(1)), v)]);
    }
    if (second[0] !== "Exp" && second[0] !== "Sin" && second[0] !== "Cos") return undefined;
    const u = linearIn(arg(second, 1), v);
    if (!u || typeof u.a !== "number" || u.a === 0) return undefined;
    methods.add(PARTS);
    const a = u.a;
    const derivatives: number[][] = [];
    for (let d = [...P]; d.length > 0 && d.some((c) => c !== 0); d = derivePoly(d)) derivatives.push(d);
    const sum = (pick: (k: number) => boolean, scale: (k: number) => number): Ast => {
      let total: Ast = 0;
      derivatives.forEach((d, k) => { if (pick(k)) total = ["Add", total, ["Multiply", scale(k), polyToAst(d, v)]]; });
      return S(total);
    };
    if (second[0] === "Exp") return S(["Multiply", second, sum(() => true, (k) => (-1) ** k / a ** (k + 1))]);
    const even = sum((k) => k % 2 === 0, (k) => (-1) ** (k / 2) / a ** (k + 1));
    const odd = sum((k) => k % 2 === 1, (k) => (-1) ** ((k - 1) / 2) / a ** (k + 1));
    const sin: Ast = ["Sin", arg(second, 1)], cos: Ast = ["Cos", arg(second, 1)];
    // ∫P sen u = −cos u·Σ(−1)^k P^(2k)/a^(2k+1) + sen u·Σ(−1)^k P^(2k+1)/a^(2k+2); ∫P cos u análogo
    if (second[0] === "Sin") return S(["Add", ["Negate", ["Multiply", cos, even]], ["Multiply", sin, odd]]);
    return S(["Add", ["Multiply", sin, even], ["Multiply", cos, odd]]);
  }
}
