type Evaluator = (variables: ReadonlyMap<string, number>) => number;

const FUNCTIONS: Readonly<Record<string, (...values: number[]) => number>> = {
  abs: Math.abs,
  cos: Math.cos,
  exp: Math.exp,
  log: Math.log,
  log10: Math.log10,
  max: Math.max,
  min: Math.min,
  sin: Math.sin,
  sqrt: Math.sqrt,
  tan: Math.tan,
};

/** Compile a small, deterministic math expression without evaluating JavaScript. */
export function compileParameterExpression(source: string, parameterNames: readonly string[]): Evaluator {
  if (source.length > 512) throw new Error("Parameter expression cannot exceed 512 characters.");
  const allowed = new Set(parameterNames);
  const tokens = source.match(/\s*(?:((?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|([()+\-*/^,]))/gy);
  if (!tokens || tokens.join("").replace(/\s/g, "").length !== source.replace(/\s/g, "").length || tokens.length > 256) {
    throw new Error("Parameter expression contains an invalid token or is too long.");
  }
  const values = tokens.map(token => token.trim());
  let index = 0;
  const peek = () => values[index];
  const take = () => values[index++];
  const expect = (token: string) => { if (take() !== token) throw new Error(`Expected '${token}' in parameter expression.`); };

  const expression = (): Evaluator => {
    let left = product();
    while (peek() === "+" || peek() === "-") {
      const operator = take(), right = product(), previous = left;
      left = variables => operator === "+" ? previous(variables) + right(variables) : previous(variables) - right(variables);
    }
    return left;
  };
  const product = (): Evaluator => {
    let left = unary();
    while (peek() === "*" || peek() === "/") {
      const operator = take(), right = unary(), previous = left;
      left = variables => operator === "*" ? previous(variables) * right(variables) : previous(variables) / right(variables);
    }
    return left;
  };
  const unary = (): Evaluator => {
    if (peek() === "+" || peek() === "-") {
      const sign = take(), operand = unary();
      return variables => sign === "-" ? -operand(variables) : operand(variables);
    }
    return power();
  };
  const power = (): Evaluator => {
    const left = primary();
    if (peek() !== "^") return left;
    take();
    const right = unary();
    return variables => left(variables) ** right(variables);
  };
  const primary = (): Evaluator => {
    const token = take();
    if (token === undefined) throw new Error("Unexpected end of parameter expression.");
    if (/^(?:\d|\.)/.test(token)) {
      const number = Number(token);
      if (!Number.isFinite(number)) throw new Error("Parameter expression contains an invalid number.");
      return () => number;
    }
    if (token === "(") {
      const result = expression();
      expect(")");
      return result;
    }
    if (/^[A-Za-z_]/.test(token)) {
      if (peek() === "(") {
        const fn = Object.prototype.hasOwnProperty.call(FUNCTIONS, token) ? FUNCTIONS[token] : undefined;
        if (!fn) throw new Error(`Unsupported function '${token}' in parameter expression.`);
        take();
        const args: Evaluator[] = [expression()];
        while (peek() === ",") { take(); args.push(expression()); }
        expect(")");
        if (token === "min" || token === "max" ? args.length < 2 : args.length !== 1) throw new Error(`Function '${token}' has the wrong number of arguments.`);
        return variables => fn(...args.map(argument => argument(variables)));
      }
      if (allowed.has(token)) return variables => {
        const value = variables.get(token);
        if (value === undefined) throw new Error(`No sampled value is available for parameter '${token}'.`);
        return value;
      };
      if (token === "pi") return () => Math.PI;
      if (token === "e") return () => Math.E;
      throw new Error(`Unknown parameter '${token}' in parameter expression.`);
    }
    throw new Error(`Unexpected token '${token}' in parameter expression.`);
  };

  if (!values.length) throw new Error("Parameter expression is empty.");
  const result = expression();
  if (index !== values.length) throw new Error(`Unexpected token '${peek()}' in parameter expression.`);
  return variables => {
    const value = result(variables);
    if (!Number.isFinite(value)) throw new Error("Parameter expression must produce a finite real value.");
    return value;
  };
}
