import { Ast, AstNode, arg, argNode, argString, dependsOn, isNode, substitute } from "./ast.js";

/**
 * d(ast)/dv por regras de Cálculo 1. Diferente do atalho interno do GeoGebra (`Derivative.get`), o canto
 * de |u| vira `Sign(u)` — indefinido em u = 0 — em vez de 0/0 silencioso. Lança erro quando não há regra
 * (ex.: limite dentro de uma derivada).
 */
export function differentiate(ast: Ast, v: string): Ast {
  if (isNode(ast) && ast[0] === "If" && !dependsOn(arg(ast, 2), v) && !dependsOn(arg(ast, 3), v) && !dependsOn(arg(ast, 1), v)) return 0;
  if (!dependsOn(ast, v)) return 0;
  if (ast === v) return 1;
  if (!isNode(ast)) return 0;
  const S = simplify;
  const d = (x: Ast): Ast => differentiate(x, v);
  const a = (): Ast => arg(ast, 1);
  const b = (): Ast => arg(ast, 2);
  switch (ast[0]) {
    case "Add": return S(["Add", d(a()), d(b())]);
    case "Subtract": return S(["Subtract", d(a()), d(b())]);
    case "Negate": return S(["Negate", d(a())]);
    case "Multiply": return S(["Add", ["Multiply", d(a()), b()], ["Multiply", a(), d(b())]]);
    case "Divide": return S(["Divide", ["Subtract", ["Multiply", d(a()), b()], ["Multiply", a(), d(b())]], ["Power", b(), 2]]);
    case "Power":
      if (!dependsOn(b(), v)) return S(["Multiply", ["Multiply", b(), ["Power", a(), S(["Subtract", b(), 1])]], d(a())]);
      if (!dependsOn(a(), v)) return S(["Multiply", ["Multiply", ast, ["Ln", a()]], d(b())]);
      return S(["Multiply", ast, ["Add", ["Multiply", d(b()), ["Ln", a()]], ["Divide", ["Multiply", b(), d(a())], a()]]]);
    case "Sqrt": return S(["Divide", d(a()), ["Multiply", 2, ast]]);
    case "Sin": return S(["Multiply", ["Cos", a()], d(a())]);
    case "Cos": return S(["Negate", ["Multiply", ["Sin", a()], d(a())]]);
    case "Tan": return S(["Divide", d(a()), ["Power", ["Cos", a()], 2]]);
    case "Exp": return S(["Multiply", ast, d(a())]);
    case "Ln": return S(["Divide", d(a()), a()]);
    case "Log": return S(["Divide", d(a()), ["Multiply", a(), ["Ln", 10]]]);
    case "Abs": return S(["Multiply", d(a()), ["Sign", a()]]);
    case "Sign": return 0; // fora de 0; em 0 a própria função é indefinida
    case "If": { // derivada por partes; a fronteira é conferida na avaliação (continuidade + derivadas laterais)
      const condition = arg(ast, 1);
      const junction: Ast = isNode(condition) ? ["Junction", arg(condition, 1), arg(condition, 2), arg(ast, 2), arg(ast, 3)] : 0;
      return ["If", condition, d(arg(ast, 2)), d(arg(ast, 3)), junction];
    }
    case "D": return differentiate(differentiate(a(), argString(ast, 2)), v);
    case "Integrate": { // Leibniz / Teorema Fundamental, com integrando independente de v
      const limits = argNode(ast, 2);
      const s = argString(limits, 1), lo = arg(limits, 2), hi = arg(limits, 3);
      if (dependsOn(a(), v)) throw new Error("integrando depende da variável de derivação: fora do escopo");
      return S(["Subtract", ["Multiply", substitute(a(), s, hi, differentiate), d(hi)], ["Multiply", substitute(a(), s, lo, differentiate), d(lo)]]);
    }
    case "Sum": {
      const limits = argNode(ast, 2);
      if (dependsOn(arg(limits, 2), v) || dependsOn(arg(limits, 3), v)) throw new Error("limites do somatório dependem da variável de derivação");
      return S(["Sum", differentiate(a(), v), limits]);
    }
    default: throw new Error(`sem regra de derivação para ${ast[0]}`);
  }
}

/** Simplificação leve: dobra constantes, elementos neutros e coeficientes numéricos de produtos. */
export function simplify(node: Ast): Ast {
  if (!isNode(node)) return node;
  if (node[0] === "Limits") return node;
  const head = node[0];
  const args = node.slice(1).map((x) => simplify(x));
  const a = args[0] as Ast, b = args[1] as Ast;
  const isNum = (x: Ast): x is number => typeof x === "number";
  switch (head) {
    case "Add":
      if (isNum(a) && isNum(b)) return a + b;
      if (a === 0) return b;
      if (b === 0) return a;
      if (isNode(b) && b[0] === "Negate") return simplify(["Subtract", a, arg(b, 1)]);
      return ["Add", a, b];
    case "Subtract":
      if (isNum(a) && isNum(b)) return a - b;
      if (b === 0) return a;
      if (a === 0) return simplify(["Negate", b]);
      return ["Subtract", a, b];
    case "Negate":
      if (isNum(a)) return -a;
      if (isNode(a) && a[0] === "Negate") return arg(a, 1);
      return ["Negate", a];
    case "Multiply": {
      const factors: Ast[] = [];
      const flat = (x: Ast): void => { if (isNode(x) && x[0] === "Multiply") { flat(arg(x, 1)); flat(arg(x, 2)); } else factors.push(x); };
      flat(a); flat(b);
      let coef = 1;
      const rest: Ast[] = [];
      for (const f of factors) {
        if (isNum(f)) coef *= f;
        else if (isNode(f) && f[0] === "Negate") { coef = -coef; rest.push(arg(f, 1)); } else rest.push(f);
      }
      if (coef === 0) return 0;
      if (rest.length === 0) return coef;
      const body = rest.reduce((acc, f) => ["Multiply", acc, f] as AstNode);
      return coef === 1 ? body : coef === -1 ? ["Negate", body] : ["Multiply", coef, body];
    }
    case "Divide":
      if (isNum(a) && isNum(b) && b !== 0) return a / b;
      if (a === 0) return 0;
      if (b === 1) return a;
      return ["Divide", a, b];
    case "Power":
      if (isNum(a) && isNum(b)) return a ** b;
      if (b === 1) return a;
      if (b === 0) return 1;
      return ["Power", a, b];
    default: return [head, ...args];
  }
}
