/**
 * Expressão do bloco legado `control.calc_expression` (CalcExpression do SignalEngine, commit
 * ab4c1efb7) -> expressão do bloco Fcn. A árvore é a do parser legado, sem reassociar nada; a
 * impressão usa a precedência do Fcn (UserDefinedBuilders.cpp) e só põe parênteses onde ela difere:
 *
 *   legado: comparação < aditivo < multiplicativo < potência (à DIREITA) < menos unário (liga mais
 *           forte que ^: `-x^2` = (-x)^2), sem funções, só os nomes das entradas declaradas;
 *   Fcn:    relacional < aditivo < multiplicativo < menos unário < ^ (à ESQUERDA, operandos
 *           primários); entradas `u(i)`.
 *
 * As operações (+ - * / pow, comparação 0/1, negação) são as mesmas em double; a ordem de avaliação
 * fica idêntica, então o resultado é bit a bit o do bloco legado.
 */

export type LegacyAst =
  | { kind: "number"; value: number }
  | { kind: "input"; index: number }
  | { kind: "negate"; operand: LegacyAst }
  | { kind: "binary"; op: "+" | "-" | "*" | "/" | "^" | ">" | "<"; left: LegacyAst; right: LegacyAst };

/** Parser idêntico ao ExpressionParser legado (mesmos erros, mesmas colunas). */
export function parseLegacyExpression(text: string, inputs: readonly string[]): LegacyAst {
  let position = 0;
  const fail = (reason: string): never => { throw new Error(`CalcExpression invalida na coluna ${position + 1}: ${reason}`); };
  const whitespace = () => { while (position < text.length && (text[position] === " " || text[position] === "\t")) ++position; };
  const consume = (c: string) => { whitespace(); if (position < text.length && text[position] === c) { ++position; return true; } return false; };
  const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
  const isAlpha = (c: string | undefined) => c !== undefined && ((c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_");

  const comparison = (): LegacyAst => {
    let left = expression();
    for (;;) {
      if (consume(">")) left = { kind: "binary", op: ">", left, right: expression() };
      else if (consume("<")) left = { kind: "binary", op: "<", left, right: expression() };
      else return left;
    }
  };
  const expression = (): LegacyAst => {
    let left = term();
    for (;;) {
      if (consume("+")) left = { kind: "binary", op: "+", left, right: term() };
      else if (consume("-")) left = { kind: "binary", op: "-", left, right: term() };
      else return left;
    }
  };
  const term = (): LegacyAst => {
    let left = power();
    for (;;) {
      if (consume("*")) left = { kind: "binary", op: "*", left, right: power() };
      else if (consume("/")) left = { kind: "binary", op: "/", left, right: power() };
      else return left;
    }
  };
  const power = (): LegacyAst => {
    const base = factor();
    return consume("^") ? { kind: "binary", op: "^", left: base, right: power() } : base;
  };
  const factor = (): LegacyAst => {
    whitespace();
    if (consume("-")) return { kind: "negate", operand: factor() };
    if (consume("(")) { const inner = comparison(); if (!consume(")")) fail("')' ausente"); return inner; }
    if (position >= text.length) fail("operando ausente");
    const begin = position;
    if (isDigit(text[position]) || text[position] === ".") {
      while (position < text.length && (isDigit(text[position]) || ".eE+-".includes(text[position]!))) {
        if ((text[position] === "+" || text[position] === "-") && position > begin && text[position - 1] !== "e" && text[position - 1] !== "E") break;
        ++position;
      }
      // std::stod lê o maior prefixo válido (como parseFloat) e recusa fora da faixa do double.
      const value = Number.parseFloat(text.slice(begin, position));
      if (!Number.isFinite(value)) fail("numero invalido");
      return { kind: "number", value };
    }
    if (isAlpha(text[position])) {
      ++position;
      while (position < text.length && (isAlpha(text[position]) || isDigit(text[position]))) ++position;
      const index = inputs.indexOf(text.slice(begin, position));
      if (index < 0) fail("entrada desconhecida");
      return { kind: "input", index };
    }
    return fail("operando invalido");
  };

  const tree = comparison();
  whitespace();
  if (position !== text.length) fail("token inesperado");
  return tree;
}

/** Valor da árvore como o interpretador legado (para testes de equivalência). */
export function evaluateLegacyAst(node: LegacyAst, inputs: readonly number[]): number {
  switch (node.kind) {
    case "number": return node.value;
    case "input": return inputs[node.index]!;
    case "negate": return -evaluateLegacyAst(node.operand, inputs);
    case "binary": {
      const a = evaluateLegacyAst(node.left, inputs), b = evaluateLegacyAst(node.right, inputs);
      switch (node.op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/": return a / b;
        case "^": return Math.pow(a, b);
        case ">": return a > b ? 1 : 0;
        case "<": return a < b ? 1 : 0;
      }
    }
  }
}

// Níveis do Fcn (maior liga mais forte); um operando com nível menor que o exigido ganha parênteses.
const RELATIONAL = 3, ADDITIVE = 4, MULTIPLICATIVE = 5, UNARY = 7, POWER = 8, PRIMARY = 9;

function level(node: LegacyAst): number {
  if (node.kind === "number" || node.kind === "input") return PRIMARY;
  if (node.kind === "negate") return UNARY;
  switch (node.op) {
    case ">": case "<": return RELATIONAL;
    case "+": case "-": return ADDITIVE;
    case "*": case "/": return MULTIPLICATIVE;
    case "^": return POWER;
  }
}

function print(node: LegacyAst, required: number): string {
  const text = printNode(node);
  return level(node) < required ? `(${text})` : text;
}

function printNode(node: LegacyAst): string {
  switch (node.kind) {
    case "number": return String(node.value);
    case "input": return `u(${node.index + 1})`;
    // Operando do menos unário no Fcn: outro unário ou potência.
    case "negate": return `-${print(node.operand, UNARY)}`;
    case "binary": {
      const own = level(node);
      // Associativas à esquerda: o operando direito precisa ligar estritamente mais forte. Na potência
      // os dois lados são primários (o legado é associativo à direita: `a^b^c` -> `a^(b^c)`).
      const left = node.op === "^" ? PRIMARY : own;
      const right = node.op === "^" ? PRIMARY : own + 1;
      const gap = own <= ADDITIVE ? " " : "";
      return `${print(node.left, left)}${gap}${node.op}${gap}${print(node.right, right)}`;
    }
  }
}

export function legacyAstToFcn(node: LegacyAst): string {
  return printNode(node);
}

/** Expressão legada -> Fcn; `inputs` é a lista de entradas declaradas (ordem das portas = u(i)). */
export function convertLegacyExpression(text: string, inputs: readonly string[]): string {
  return legacyAstToFcn(parseLegacyExpression(text, inputs));
}
