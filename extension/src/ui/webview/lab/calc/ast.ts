/**
 * AST e parser do núcleo matemático do Laboratório de Cálculo (ver docs/51 §4.5 e ADR 0014).
 *
 * Forma inspirada em MathJSON (subconjunto próprio, não idêntico):
 *   número | "símbolo" | ["Add", a, b] ["Subtract", a, b] ["Multiply", a, b] ["Divide", a, b] ["Power", a, b]
 *   ["Negate", a] ["Sin", a] … ["Sqrt", a] ["Abs", a] ["Sign", a] ["Call", nome, arg]
 *   ["Integrate", corpo, ["Limits", v, a, b]]   integral definida
 *   ["D", corpo, v]                             derivada em relação a v (v continua livre)
 *   ["Limit", corpo, v, alvo, lado]             lado: 0 bilateral, 1 direita, -1 esquerda
 *   ["Sum" | "Product", corpo, ["Limits", k, m, n]]
 *   ["If", condição, então, senão]              função por partes: se(x < 2, x^2, 4)
 *   ["Less" | "LessEqual" | "Greater" | "GreaterEqual", a, b]   comparações (1 verdadeiro, 0 falso)
 * Nada aqui gera código: o parser produz dados, `compile.ts` produz closures.
 */
export type Ast = number | string | AstNode;
export type AstNode = [string, ...Ast[]];

export class ExpressionError extends Error {
  constructor(message: string, readonly column: number) {
    super(`${message} (coluna ${column + 1})`);
  }
}

/** Função do usuário: `h(t) = corpo`. Chamadas são expandidas por substituição (mantém derivação e
 * caminho polinomial) ou preservadas como `["Call", nome, arg]` para exibição. */
export interface UserFunction { param: string; ast: Ast }
export interface ParseOptions { functions?: Readonly<Record<string, UserFunction>>; keepCalls?: boolean }

const UNARY: Readonly<Record<string, string>> = { sin: "Sin", cos: "Cos", tan: "Tan", exp: "Exp", abs: "Abs", sqrt: "Sqrt", ln: "Ln", log: "Log" };
/** Aridade na sintaxe linear; a variável ligada vem primeiro (o corpo é lido já conhecendo-a). */
const BINDERS: Readonly<Record<string, number>> = { Integrate: 4, D: 2, Limit: 4, Sum: 4, Product: 4 };
const CONSTANTS: Readonly<Record<string, number>> = { "π": Math.PI, pi: Math.PI, "∞": Infinity };

export const isNode = (ast: Ast): ast is AstNode => Array.isArray(ast);
/** Argumento obrigatório de um nó (falha alto em vez de devolver undefined). */
export function arg(node: AstNode, index: number): Ast {
  const value = node[index];
  if (value === undefined) throw new Error(`nó ${node[0]} sem argumento ${index}`);
  return value;
}
export function argString(node: AstNode, index: number): string {
  const value = arg(node, index);
  if (typeof value !== "string") throw new Error(`nó ${node[0]}: argumento ${index} deveria ser símbolo`);
  return value;
}
export function argNode(node: AstNode, index: number): AstNode {
  const value = arg(node, index);
  if (!isNode(value)) throw new Error(`nó ${node[0]}: argumento ${index} deveria ser nó`);
  return value;
}

type Token =
  | { kind: "num"; value: number; pos: number }
  | { kind: "id"; name: string; pos: number }
  | { kind: "op"; op: string; pos: number }
  | { kind: "end"; pos: number };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const at = (k: number): string => text[k] ?? "";
  while (i < text.length) {
    const c = at(i);
    if (c === " " || c === "\t") { i++; continue; }
    if (/[0-9.]/.test(c)) {
      const start = i;
      while (/[0-9.]/.test(at(i))) i++;
      if (/[eE]/.test(at(i)) && /[0-9+-]/.test(at(i + 1))) {
        const save = i;
        i++;
        if (at(i) === "+" || at(i) === "-") i++;
        if (/[0-9]/.test(at(i))) { while (/[0-9]/.test(at(i))) i++; } else i = save;
      }
      const raw = text.slice(start, i);
      if ((raw.match(/\./g) ?? []).length > 1 || !Number.isFinite(Number(raw))) throw new ExpressionError(`número inválido "${raw}"`, start);
      tokens.push({ kind: "num", value: Number(raw), pos: start });
      continue;
    }
    if (/[A-Za-zΔπ∞_]/.test(c)) {
      const start = i;
      if (c === "∞" || c === "π") { i++; tokens.push({ kind: "id", name: c, pos: start }); continue; }
      while (/[A-Za-z0-9Δ_]/.test(at(i))) i++;
      tokens.push({ kind: "id", name: text.slice(start, i), pos: start });
      continue;
    }
    if ((c === "<" || c === ">") && at(i + 1) === "=") { tokens.push({ kind: "op", op: `${c}=`, pos: i }); i += 2; continue; }
    const op = c === "·" || c === "×" ? "*" : c === "−" ? "-" : c === "≤" ? "<=" : c === "≥" ? ">=" : c;
    if ("+-*/^(),<>".includes(op) || op === "<=" || op === ">=") { tokens.push({ kind: "op", op, pos: i }); i++; continue; }
    throw new ExpressionError(`caractere inesperado "${c}"`, i);
  }
  tokens.push({ kind: "end", pos: text.length });
  return tokens;
}

const BINARY: Readonly<Record<string, readonly [number, string]>> = {
  "<": [0, "Less"], "<=": [0, "LessEqual"], ">": [0, "Greater"], ">=": [0, "GreaterEqual"],
  "+": [1, "Add"], "-": [1, "Subtract"], "*": [2, "Multiply"], "/": [2, "Divide"], "^": [4, "Power"],
};
export const COMPARISONS = new Set(["Less", "LessEqual", "Greater", "GreaterEqual"]);
/** Nomes da função por partes na sintaxe linear (o editor gera `se(...)`). */
const PIECEWISE = new Set(["se", "if"]);

/** Pratt parser. `symbols`: variáveis livres permitidas (allowlist). */
export function parseExpression(text: string, symbols: readonly string[], options: ParseOptions = {}): Ast {
  const functions = options.functions ?? {};
  const tokens = tokenize(text);
  let p = 0;
  const peek = (): Token => tokens[p] ?? { kind: "end", pos: text.length };
  const next = (): Token => tokens[p++] ?? { kind: "end", pos: text.length };
  const isOp = (t: Token, op: string): boolean => t.kind === "op" && t.op === op;
  const expectOp = (op: string): void => { const t = next(); if (!isOp(t, op)) throw new ExpressionError(`esperado "${op}"`, t.pos); };
  const startsOperand = (t: Token): boolean => t.kind === "num" || t.kind === "id" || isOp(t, "(");

  function identifier(t: { name: string; pos: number }, scope: readonly string[]): Ast {
    if (Object.hasOwn(CONSTANTS, t.name) && !scope.includes(t.name)) return CONSTANTS[t.name] as number;
    if (scope.includes(t.name)) return t.name;
    if (t.name === "e") return Math.E;
    const parts = [...t.name];
    if (parts.length > 1 && parts.every((c) => scope.includes(c))) {
      return parts.slice(1).reduce<Ast>((acc, c) => ["Multiply", acc, c], parts[0] as string);
    }
    throw new ExpressionError(`símbolo não declarado "${t.name}"`, t.pos);
  }
  function primary(scope: readonly string[]): Ast {
    const t = next();
    if (t.kind === "num") return t.value;
    if (t.kind === "id") {
      // Sempre Object.hasOwn: nomes como "constructor" não podem achar chaves herdadas do protótipo.
      const unary = Object.hasOwn(UNARY, t.name) ? UNARY[t.name] : undefined;
      if (unary) { expectOp("("); const a = expression(0, scope); expectOp(")"); return [unary, a]; }
      if (Object.hasOwn(BINDERS, t.name)) return binder(t.name, scope);
      if (PIECEWISE.has(t.name) && isOp(peek(), "(")) {
        next();
        const condition = expression(0, scope);
        if (!(isNode(condition) && COMPARISONS.has(condition[0]))) throw new ExpressionError("a condição de se(...) precisa ser uma comparação (<, ≤, >, ≥)", t.pos);
        expectOp(",");
        const whenTrue = expression(0, scope);
        expectOp(",");
        const whenFalse = expression(0, scope);
        expectOp(")");
        return ["If", condition, whenTrue, whenFalse];
      }
      const fn = Object.hasOwn(functions, t.name) ? functions[t.name] : undefined;
      if (fn && isOp(peek(), "(")) {
        next();
        const a = expression(0, scope);
        expectOp(")");
        return options.keepCalls ? ["Call", t.name, a] : substitute(fn.ast, fn.param, a);
      }
      return identifier(t, scope);
    }
    if (isOp(t, "(")) { const e = expression(0, scope); expectOp(")"); return e; }
    if (isOp(t, "-")) return ["Negate", expression(3, scope)];
    throw new ExpressionError("operando esperado", t.pos);
  }
  function binder(name: string, scope: readonly string[]): Ast {
    expectOp("(");
    const v = next();
    if (v.kind !== "id" || Object.hasOwn(UNARY, v.name) || Object.hasOwn(CONSTANTS, v.name)) throw new ExpressionError("variável esperada", v.pos);
    const inner = [...scope, v.name];
    const arity = BINDERS[name] as number;
    const args: Ast[] = [];
    for (let i = 1; i < arity; i++) {
      expectOp(",");
      if (name === "Limit" && i === 2) { // lado: 0, 1 ou -1
        const sign = isOp(peek(), "-") ? (next(), -1) : 1;
        const d = next();
        if (d.kind !== "num" || (d.value !== 0 && d.value !== 1)) throw new ExpressionError("lado do limite inválido", d.pos);
        args.push(sign * d.value === 0 ? 0 : sign * d.value);
        continue;
      }
      args.push(expression(0, i === arity - 1 ? inner : scope));
    }
    expectOp(")");
    const body = args[args.length - 1] as Ast;
    switch (name) {
      case "Integrate": return ["Integrate", body, ["Limits", v.name, args[0] as Ast, args[1] as Ast]];
      case "D": return ["D", body, v.name];
      case "Limit": return ["Limit", body, v.name, args[0] as Ast, args[1] as Ast];
      default: return [name, body, ["Limits", v.name, args[0] as Ast, args[1] as Ast]];
    }
  }
  function expression(minPrec: number, scope: readonly string[]): Ast {
    let left = primary(scope);
    for (;;) {
      const t = peek();
      // multiplicação implícita (precedência 3): "0.5t", "2(x+1)", "t sin(t)", "(t+1)(t-1)"; nunca dentro de expoente
      if (startsOperand(t) && minPrec <= 3 && (typeof left === "number" || t.kind !== "num")) {
        left = ["Multiply", left, expression(4, scope)];
        continue;
      }
      if (t.kind !== "op") break;
      const spec = BINARY[t.op];
      if (!spec) break;
      const [prec, head] = spec;
      if (prec < minPrec) break;
      next();
      left = [head, left, expression(t.op === "^" ? prec : prec + 1, scope)];
    }
    return left;
  }
  const ast = expression(0, symbols);
  const rest = peek();
  if (rest.kind !== "end") throw new ExpressionError("token inesperado", rest.pos);
  return ast;
}

/** Variável ligada por ∫, Σ, Π e lim (D não liga: a variável de derivação continua livre). */
export function boundVariable(ast: Ast): string | undefined {
  if (!isNode(ast)) return undefined;
  if (ast[0] === "Limit") return argString(ast, 2);
  if (ast[0] === "Integrate" || ast[0] === "Sum" || ast[0] === "Product") return argString(argNode(ast, 2), 1);
  return undefined;
}

/** A expressão depende de `v` livre? */
export function dependsOn(ast: Ast, v: string): boolean {
  if (ast === v) return true;
  if (!isNode(ast)) return false;
  if (ast[0] === "Limits") return dependsOn(arg(ast, 2), v) || dependsOn(arg(ast, 3), v);
  if (ast[0] === "D") return dependsOn(arg(ast, 1), v) || arg(ast, 2) === v;
  if (ast[0] === "Call") return dependsOn(arg(ast, 2), v);
  if (boundVariable(ast) === v) return ast[0] === "Limit" ? dependsOn(arg(ast, 3), v) : dependsOn(arg(ast, 2), v);
  return ast.slice(1).some((a) => dependsOn(a, v));
}

/** Substitui `name` por `value`, respeitando variáveis ligadas. Substituir a variável de uma derivada
 * exige derivar antes (`differentiate` é injetado para evitar dependência circular de módulos). */
export function substitute(ast: Ast, name: string, value: Ast, differentiate?: (body: Ast, v: string) => Ast): Ast {
  if (ast === name) return value;
  if (!isNode(ast)) return ast;
  const sub = (x: Ast): Ast => substitute(x, name, value, differentiate);
  switch (ast[0]) {
    case "Limits": return ["Limits", arg(ast, 1), sub(arg(ast, 2)), sub(arg(ast, 3))];
    case "D": {
      const v = argString(ast, 2);
      if (v !== name) return ["D", sub(arg(ast, 1)), v];
      if (!differentiate) throw new Error("substituir a variável de uma derivada exige derivar primeiro");
      return sub(differentiate(arg(ast, 1), v));
    }
    case "Limit": return ["Limit", argString(ast, 2) === name ? arg(ast, 1) : sub(arg(ast, 1)), arg(ast, 2), sub(arg(ast, 3)), arg(ast, 4)];
    case "Integrate": case "Sum": case "Product": {
      const limits = argNode(ast, 2);
      return [ast[0], argString(limits, 1) === name ? arg(ast, 1) : sub(arg(ast, 1)), sub(limits)];
    }
    case "Call": return ["Call", arg(ast, 1), sub(arg(ast, 2))];
    default: return [ast[0], ...ast.slice(1).map(sub)];
  }
}
