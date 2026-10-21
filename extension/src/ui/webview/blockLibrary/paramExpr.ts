/**
 * Avaliador do subconjunto MATLAB dos parâmetros de bloco (docs/66 §5). Espelho do avaliador do
 * Core (`core/src/simulation/library/ParamExpr.cpp`), que é a autoridade na simulação; este roda na
 * Extension/Webview para desenhar o ícone (ex.: o polinômio da Transfer Fcn) e validar o inspetor.
 * Os dois passam pelos MESMOS vetores (`test/fixtures/block-library/param-expr-vectors.json`).
 * Matrizes em ordem de LINHA.
 */

export interface ParamValue {
  rows: number;
  cols: number;
  data: number[];
}

export class ParamError extends Error {
  constructor(message: string, readonly column: number) {
    super(`${message} (coluna ${column})`);
  }
}

export type ParamWorkspace = ReadonlyMap<string, ParamValue>;

export const scalarValue = (value: number): ParamValue => ({ rows: 1, cols: 1, data: [value] });
export const rowValue = (values: number[]): ParamValue => ({ rows: values.length === 0 ? 0 : 1, cols: values.length, data: values });
const emptyValue = (): ParamValue => ({ rows: 0, cols: 0, data: [] });
const isScalar = (value: ParamValue) => value.data.length === 1;
const isVector = (value: ParamValue) => value.rows === 1 || value.cols === 1 || value.data.length === 0;

/** Elementos na ordem linear do MATLAB (por coluna), como `x(:)`. */
export function linear(value: ParamValue): number[] {
  const result: number[] = [];
  for (let c = 0; c < value.cols; c++) for (let r = 0; r < value.rows; r++) result.push(value.data[r * value.cols + c]!);
  return result;
}

type TokenKind = "number" | "ident" | "op" | "(" | ")" | "[" | "]" | "," | ";" | "newline" | "end";
interface Token { kind: TokenKind; text: string; number: number; column: number; spaceBefore: boolean }

const isIdentStart = (c: string) => /[A-Za-z_]/.test(c);
const isIdentPart = (c: string) => /[A-Za-z0-9_]/.test(c);
const isDigit = (c: string) => c >= "0" && c <= "9";

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let space = false;
  const endsOperand = () => {
    const last = tokens[tokens.length - 1];
    if (!last) return false;
    return last.kind === "number" || last.kind === "ident" || last.kind === ")" || last.kind === "]" || (last.kind === "op" && (last.text === "'" || last.text === ".'"));
  };
  while (i < text.length) {
    const c = text[i]!;
    if (c === " " || c === "\t" || c === "\r") { space = true; i++; continue; }
    if (c === "%") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "." && text.startsWith("...", i)) { while (i < text.length && text[i] !== "\n") i++; if (i < text.length) i++; space = true; continue; }
    const token: Token = { kind: "end", text: "", number: 0, column: i + 1, spaceBefore: space };
    space = false;
    if (c === "\n") { token.kind = "newline"; i++; tokens.push(token); continue; }
    if (isDigit(c) || (c === "." && i + 1 < text.length && isDigit(text[i + 1]!))) {
      const begin = i;
      while (i < text.length && isDigit(text[i]!)) i++;
      if (i < text.length && text[i] === ".") {
        const next = text[i + 1] ?? "";
        if (!["*", "/", "^", "\\", "'"].includes(next)) {
          i++;
          while (i < text.length && isDigit(text[i]!)) i++;
        }
      }
      if (i < text.length && (text[i] === "e" || text[i] === "E")) {
        let j = i + 1;
        if (j < text.length && (text[j] === "+" || text[j] === "-")) j++;
        if (j < text.length && isDigit(text[j]!)) {
          i = j;
          while (i < text.length && isDigit(text[i]!)) i++;
        }
      }
      token.kind = "number";
      token.text = text.slice(begin, i);
      token.number = Number(token.text.endsWith(".") ? token.text.slice(0, -1) : token.text);
      tokens.push(token);
      continue;
    }
    if (isIdentStart(c)) {
      const begin = i;
      while (i < text.length && isIdentPart(text[i]!)) i++;
      token.kind = "ident";
      token.text = text.slice(begin, i);
      tokens.push(token);
      continue;
    }
    const two = text.slice(i, i + 2);
    if (["||", "&&", "==", "~=", "!=", "<=", ">=", ".*", "./", ".^", ".\\", ".'"].includes(two)) {
      token.kind = "op";
      token.text = two === "!=" ? "~=" : two;
      i += 2;
      tokens.push(token);
      continue;
    }
    if (c === "(" || c === ")" || c === "[" || c === "]" || c === "," || c === ";") {
      token.kind = c as TokenKind;
    } else if (c === "'") {
      if (!endsOperand() || token.spaceBefore) throw new ParamError("texto entre aspas nao e um valor numerico", token.column);
      token.kind = "op";
    } else if ("+-*/\\^<>&|~!:".includes(c)) {
      token.kind = "op";
    } else {
      throw new ParamError(`caractere inesperado '${c}'`, token.column);
    }
    token.text = c === "!" ? "~" : c;
    i++;
    tokens.push(token);
  }
  tokens.push({ kind: "end", text: "", number: 0, column: text.length + 1, spaceBefore: false });
  return tokens;
}

function makeValue(rows: number, cols: number, fill = 0): ParamValue {
  return { rows, cols, data: new Array<number>(rows * cols).fill(fill) };
}

function transposed(value: ParamValue): ParamValue {
  const result = makeValue(value.cols, value.rows);
  for (let r = 0; r < value.rows; r++) for (let c = 0; c < value.cols; c++) result.data[c * value.rows + r] = value.data[r * value.cols + c]!;
  return result;
}

function elementwise(a: ParamValue, b: ParamValue, op: (x: number, y: number) => number, column: number): ParamValue {
  if (a.data.length === 0 || b.data.length === 0) {
    if ((a.data.length === 0 && (b.data.length === 0 || isScalar(b))) || (b.data.length === 0 && isScalar(a))) return emptyValue();
    throw new ParamError("operacao com matriz vazia", column);
  }
  const dim = (x: number, y: number) => {
    if (x === y || y === 1) return x;
    if (x === 1) return y;
    throw new ParamError(`dimensoes incompativeis (${a.rows}x${a.cols} e ${b.rows}x${b.cols})`, column);
  };
  const rows = dim(a.rows, b.rows);
  const cols = dim(a.cols, b.cols);
  const result = makeValue(rows, cols);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const x = a.data[(a.rows === 1 ? 0 : r) * a.cols + (a.cols === 1 ? 0 : c)]!;
      const y = b.data[(b.rows === 1 ? 0 : r) * b.cols + (b.cols === 1 ? 0 : c)]!;
      result.data[r * cols + c] = op(x, y);
    }
  return result;
}

const mapValue = (value: ParamValue, op: (x: number) => number): ParamValue => ({ ...value, data: value.data.map(op) });

function matrixProduct(a: ParamValue, b: ParamValue, column: number): ParamValue {
  if (isScalar(a) || isScalar(b)) return elementwise(a, b, (x, y) => x * y, column);
  if (a.cols !== b.rows) throw new ParamError("produto matricial exige colunas(A) == linhas(B)", column);
  const result = makeValue(a.rows, b.cols);
  for (let r = 0; r < a.rows; r++)
    for (let c = 0; c < b.cols; c++) {
      let sum = 0;
      for (let k = 0; k < a.cols; k++) sum += a.data[r * a.cols + k]! * b.data[k * b.cols + c]!;
      result.data[r * b.cols + c] = sum;
    }
  return result;
}

function solveLinear(a: ParamValue, b: ParamValue, column: number): ParamValue {
  if (a.rows !== a.cols || a.rows !== b.rows) throw new ParamError("divisao matricial exige matriz quadrada compativel", column);
  const n = a.rows;
  const m = [...a.data];
  const x: ParamValue = { ...b, data: [...b.data] };
  for (let k = 0; k < n; k++) {
    let pivot = k;
    for (let r = k + 1; r < n; r++) if (Math.abs(m[r * n + k]!) > Math.abs(m[pivot * n + k]!)) pivot = r;
    if (m[pivot * n + k] === 0) throw new ParamError("matriz singular", column);
    if (pivot !== k) {
      for (let c = 0; c < n; c++) [m[k * n + c], m[pivot * n + c]] = [m[pivot * n + c]!, m[k * n + c]!];
      for (let c = 0; c < x.cols; c++) [x.data[k * x.cols + c], x.data[pivot * x.cols + c]] = [x.data[pivot * x.cols + c]!, x.data[k * x.cols + c]!];
    }
    for (let r = 0; r < n; r++) {
      if (r === k) continue;
      const factor = m[r * n + k]! / m[k * n + k]!;
      if (factor === 0) continue;
      for (let c = k; c < n; c++) m[r * n + c]! -= factor * m[k * n + c]!;
      for (let c = 0; c < x.cols; c++) x.data[r * x.cols + c]! -= factor * x.data[k * x.cols + c]!;
    }
  }
  for (let r = 0; r < n; r++) for (let c = 0; c < x.cols; c++) x.data[r * x.cols + c]! /= m[r * n + r]!;
  return x;
}

function identity(rows: number, cols: number): ParamValue {
  const result = makeValue(rows, cols);
  for (let i = 0; i < Math.min(rows, cols); i++) result.data[i * cols + i] = 1;
  return result;
}

function matrixPower(a: ParamValue, b: ParamValue, column: number): ParamValue {
  if (isScalar(a) && isScalar(b)) return scalarValue(a.data[0]! ** b.data[0]!);
  if (!isScalar(b) || a.rows !== a.cols) throw new ParamError("'^' exige matriz quadrada e expoente escalar (use .^)", column);
  const exponent = b.data[0]!;
  if (exponent !== Math.floor(exponent)) throw new ParamError("potencia matricial so com expoente inteiro", column);
  let base = exponent < 0 ? solveLinear(a, identity(a.rows, a.rows), column) : a;
  let n = Math.abs(exponent);
  let result = identity(a.rows, a.rows);
  while (n > 0) {
    if (n % 2 === 1) result = matrixProduct(result, base, column);
    base = matrixProduct(base, base, column);
    n = Math.floor(n / 2);
  }
  return result;
}

function concatenateRow(items: ParamValue[], column: number): ParamValue {
  let rows = 0, cols = 0;
  for (const item of items) {
    if (item.data.length === 0) continue;
    if (rows === 0) rows = item.rows;
    else if (item.rows !== rows) throw new ParamError("concatenacao horizontal com numero de linhas diferente", column);
    cols += item.cols;
  }
  const result = makeValue(rows, cols);
  let offset = 0;
  for (const item of items) {
    if (item.data.length === 0) continue;
    for (let r = 0; r < rows; r++) for (let c = 0; c < item.cols; c++) result.data[r * cols + offset + c] = item.data[r * item.cols + c]!;
    offset += item.cols;
  }
  return result;
}

function concatenateColumn(items: ParamValue[], column: number): ParamValue {
  let rows = 0, cols = 0;
  for (const item of items) {
    if (item.data.length === 0) continue;
    if (cols === 0) cols = item.cols;
    else if (item.cols !== cols) throw new ParamError("concatenacao vertical com numero de colunas diferente", column);
    rows += item.rows;
  }
  const data: number[] = [];
  for (const item of items) if (item.data.length > 0) data.push(...item.data);
  return { rows, cols, data };
}

export function polyConv(a: number[], b: number[]): number[] {
  if (a.length === 0 || b.length === 0) return [];
  const result = new Array<number>(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) result[i + j]! += a[i]! * b[j]!;
  return result;
}

const UNARY_FUNCTIONS: Record<string, (x: number) => number> = {
  abs: Math.abs, sqrt: Math.sqrt, exp: Math.exp, log: Math.log, log10: Math.log10, log2: Math.log2,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, floor: Math.floor, ceil: Math.ceil,
  round: (x) => (x < 0 ? -Math.round(-x) : Math.round(x)), fix: Math.trunc,
  sign: (x) => (x > 0 ? 1 : x < 0 ? -1 : 0), deg2rad: (x) => (x * Math.PI) / 180, rad2deg: (x) => (x * 180) / Math.PI,
  isinf: (x) => (Number.isFinite(x) || Number.isNaN(x) ? 0 : 1), isnan: (x) => (Number.isNaN(x) ? 1 : 0),
  isfinite: (x) => (Number.isFinite(x) ? 1 : 0), not: (x) => (x === 0 ? 1 : 0),
};

class Parser {
  private tokens: Token[];
  private position = 0;
  private context: string[] = [];
  private endValue = Number.NaN;
  private endDims: number[] = [];

  constructor(text: string, private workspace?: ParamWorkspace) {
    this.tokens = tokenize(text);
  }

  parse(): ParamValue {
    this.skipNewlines();
    if (this.peek().kind === "end") return emptyValue();
    const value = this.orExpr();
    this.skipNewlines();
    if (this.peek().kind !== "end") throw new ParamError(`token inesperado '${this.peek().text}'`, this.peek().column);
    return value;
  }

  private peek(ahead = 0): Token { return this.tokens[Math.min(this.position + ahead, this.tokens.length - 1)]!; }
  private next(): Token { return this.tokens[this.position++]!; }
  private inMatrix(): boolean { return this.context[this.context.length - 1] === "["; }
  private skipNewlines(): void { while (this.peek().kind === "newline") this.position++; }
  private isOp(token: Token, op: string): boolean { return token.kind === "op" && token.text === op; }

  private startsNewElement(): boolean {
    if (!this.inMatrix()) return false;
    const token = this.peek();
    if (!token.spaceBefore) return false;
    if (token.kind === "op" && (token.text === "+" || token.text === "-")) return !this.peek(1).spaceBefore && this.peek(1).kind !== "end";
    return token.kind === "number" || token.kind === "ident" || token.kind === "(" || token.kind === "[" || (token.kind === "op" && token.text === "~");
  }

  private orExpr(): ParamValue {
    let left = this.andExpr();
    while (!this.startsNewElement() && (this.isOp(this.peek(), "||") || this.isOp(this.peek(), "|"))) {
      const op = this.next();
      left = elementwise(left, this.andExpr(), (a, b) => (a !== 0 || b !== 0 ? 1 : 0), op.column);
    }
    return left;
  }
  private andExpr(): ParamValue {
    let left = this.comparison();
    while (!this.startsNewElement() && (this.isOp(this.peek(), "&&") || this.isOp(this.peek(), "&"))) {
      const op = this.next();
      left = elementwise(left, this.comparison(), (a, b) => (a !== 0 && b !== 0 ? 1 : 0), op.column);
    }
    return left;
  }
  private comparison(): ParamValue {
    let left = this.range();
    while (!this.startsNewElement() && this.peek().kind === "op" && ["==", "~=", "<", "<=", ">", ">="].includes(this.peek().text)) {
      const op = this.next();
      const right = this.range();
      left = elementwise(left, right, (a, b) => {
        const r = op.text === "==" ? a === b : op.text === "~=" ? a !== b : op.text === "<" ? a < b : op.text === "<=" ? a <= b : op.text === ">" ? a > b : a >= b;
        return r ? 1 : 0;
      }, op.column);
    }
    return left;
  }
  private range(): ParamValue {
    const first = this.additive();
    if (this.startsNewElement() || !this.isOp(this.peek(), ":")) return first;
    const column = this.next().column;
    const second = this.additive();
    let third: ParamValue | undefined;
    if (!this.startsNewElement() && this.isOp(this.peek(), ":")) { this.next(); third = this.additive(); }
    const scalarOf = (v: ParamValue, what: string) => { if (!isScalar(v)) throw new ParamError(`${what} precisa ser escalar`, column); return v.data[0]!; };
    const start = scalarOf(first, "inicio da faixa");
    const step = third ? scalarOf(second, "passo da faixa") : 1;
    const stop = third ? scalarOf(third, "fim da faixa") : scalarOf(second, "fim da faixa");
    if (step === 0 || !Number.isFinite(start) || !Number.isFinite(step) || !Number.isFinite(stop)) throw new ParamError("faixa invalida", column);
    const span = (stop - start) / step;
    if (span < -1e-10) return emptyValue();
    const count = Math.floor(span + 1e-10) + 1;
    if (count > 1_000_000) throw new ParamError("faixa grande demais", column);
    return rowValue(Array.from({ length: count }, (_, i) => start + i * step));
  }
  private additive(): ParamValue {
    let left = this.multiplicative();
    while (!this.startsNewElement() && this.peek().kind === "op" && (this.peek().text === "+" || this.peek().text === "-")) {
      const op = this.next();
      const right = this.multiplicative();
      left = elementwise(left, right, op.text === "+" ? (a, b) => a + b : (a, b) => a - b, op.column);
    }
    return left;
  }
  private multiplicative(): ParamValue {
    let left = this.unary();
    while (!this.startsNewElement() && this.peek().kind === "op" && ["*", "/", ".*", "./", "\\", ".\\"].includes(this.peek().text)) {
      const op = this.next();
      const right = this.unary();
      if (op.text === "*") left = matrixProduct(left, right, op.column);
      else if (op.text === ".*") left = elementwise(left, right, (a, b) => a * b, op.column);
      else if (op.text === "./") left = elementwise(left, right, (a, b) => a / b, op.column);
      else if (op.text === ".\\") left = elementwise(left, right, (a, b) => b / a, op.column);
      else if (op.text === "/") left = isScalar(right) ? elementwise(left, right, (a, b) => a / b, op.column) : transposed(solveLinear(transposed(right), transposed(left), op.column));
      else left = isScalar(left) ? elementwise(right, left, (a, b) => a / b, op.column) : solveLinear(left, right, op.column);
    }
    return left;
  }
  private unary(): ParamValue {
    if (this.peek().kind === "op" && ["-", "+", "~"].includes(this.peek().text)) {
      const op = this.next();
      const value = this.unary();
      if (op.text === "-") return mapValue(value, (x) => -x);
      if (op.text === "~") return mapValue(value, (x) => (x === 0 ? 1 : 0));
      return value;
    }
    return this.power();
  }
  private power(): ParamValue {
    let base = this.postfix();
    while (!this.startsNewElement() && this.peek().kind === "op" && (this.peek().text === "^" || this.peek().text === ".^")) {
      const op = this.next();
      let exponent: ParamValue;
      if (this.peek().kind === "op" && ["-", "+", "~"].includes(this.peek().text)) {
        const sign = this.next();
        exponent = this.postfix();
        if (sign.text === "-") exponent = mapValue(exponent, (x) => -x);
        else if (sign.text === "~") exponent = mapValue(exponent, (x) => (x === 0 ? 1 : 0));
      } else {
        exponent = this.postfix();
      }
      base = op.text === ".^" ? elementwise(base, exponent, (a, b) => a ** b, op.column) : matrixPower(base, exponent, op.column);
    }
    return base;
  }
  private postfix(): ParamValue {
    let value = this.primary();
    while (this.peek().kind === "op" && (this.peek().text === "'" || this.peek().text === ".'") && !this.peek().spaceBefore) {
      this.next();
      value = transposed(value);
    }
    return value;
  }

  private arguments(indexed?: ParamValue): ParamValue[] {
    const args: ParamValue[] = [];
    this.context.push("(");
    this.skipNewlines();
    if (this.peek().kind === ")") { this.next(); this.context.pop(); return args; }
    let position = 0;
    for (;;) {
      this.skipNewlines();
      if (indexed && this.isOp(this.peek(), ":") && (this.peek(1).kind === "," || this.peek(1).kind === ")")) {
        this.next();
        args.push({ rows: 0, cols: 0, data: [Number.NaN] });
      } else {
        const previous = this.endValue;
        if (indexed) this.endValue = this.endDims.length === 0 ? indexed.data.length : this.endDims[Math.min(position, this.endDims.length - 1)]!;
        args.push(this.orExpr());
        this.endValue = previous;
      }
      position++;
      this.skipNewlines();
      if (this.peek().kind === ",") { this.next(); continue; }
      if (this.peek().kind === ")") { this.next(); break; }
      throw new ParamError("',' ou ')' esperado", this.peek().column);
    }
    this.context.pop();
    return args;
  }

  private index(value: ParamValue, column: number): ParamValue {
    let depth = 0, commas = 0;
    for (let i = this.position; i < this.tokens.length; i++) {
      const kind = this.tokens[i]!.kind;
      if (kind === "(" || kind === "[") depth++;
      else if (kind === ")" || kind === "]") { if (depth === 0) break; depth--; }
      else if (kind === "," && depth === 0) commas++;
    }
    const previousDims = this.endDims;
    this.endDims = commas === 0 ? [value.data.length] : [value.rows, value.cols];
    const args = this.arguments(value);
    this.endDims = previousDims;
    const indices = (arg: ParamValue, limit: number): number[] => {
      if (arg.rows === 0 && arg.cols === 0 && arg.data.length === 1 && Number.isNaN(arg.data[0])) return Array.from({ length: limit }, (_, i) => i);
      return arg.data.map((raw) => {
        if (raw !== Math.floor(raw) || raw < 1 || raw > limit) throw new ParamError("indice fora da faixa", column);
        return raw - 1;
      });
    };
    if (args.length === 1) {
      const values = linear(value);
      const picked = indices(args[0]!, values.length).map((i) => values[i]!);
      if (value.cols === 1 && value.rows > 1) return { rows: picked.length, cols: picked.length === 0 ? 0 : 1, data: picked };
      return rowValue(picked);
    }
    if (args.length === 2) {
      const rows = indices(args[0]!, value.rows);
      const cols = indices(args[1]!, value.cols);
      const result = makeValue(rows.length, cols.length);
      rows.forEach((r, ri) => cols.forEach((c, ci) => { result.data[ri * cols.length + ci] = value.data[r * value.cols + c]!; }));
      return result;
    }
    throw new ParamError("indexacao suporta 1 ou 2 indices", column);
  }

  private matrixLiteral(column: number): ParamValue {
    this.context.push("[");
    const rows: ParamValue[] = [];
    let current: ParamValue[] = [];
    for (;;) {
      const token = this.peek();
      if (token.kind === "]") {
        this.next();
        if (current.length > 0) rows.push(concatenateRow(current, column));
        break;
      }
      if (token.kind === "end") throw new ParamError("']' ausente", column);
      if (token.kind === ";" || token.kind === "newline") {
        this.next();
        if (current.length > 0) rows.push(concatenateRow(current, column));
        current = [];
        continue;
      }
      if (token.kind === ",") { this.next(); continue; }
      current.push(this.orExpr());
    }
    this.context.pop();
    return concatenateColumn(rows, column);
  }

  private primary(): ParamValue {
    const token = this.next();
    if (token.kind === "number") return scalarValue(token.number);
    if (token.kind === "(") {
      this.context.push("(");
      const value = this.orExpr();
      this.context.pop();
      if (this.peek().kind !== ")") throw new ParamError("')' ausente", token.column);
      this.next();
      return value;
    }
    if (token.kind === "[") return this.matrixLiteral(token.column);
    if (token.kind === "ident") return this.identifier(token);
    throw new ParamError(token.kind === "end" ? "expressao incompleta" : `operando invalido '${token.text}'`, token.column);
  }

  private identifier(token: Token): ParamValue {
    const name = token.text;
    if (name === "end") {
      if (Number.isNaN(this.endValue)) throw new ParamError("'end' fora de uma indexacao", token.column);
      return scalarValue(this.endValue);
    }
    const call = this.peek().kind === "(" && !(this.inMatrix() && this.peek().spaceBefore);
    const variable = this.workspace?.get(name);
    if (variable) {
      if (!call) return variable;
      const open = this.next();
      return this.index(variable, open.column);
    }
    if (!call) {
      if (name === "pi") return scalarValue(Math.PI);
      if (name === "Inf" || name === "inf") return scalarValue(Infinity);
      if (name === "NaN" || name === "nan") return scalarValue(Number.NaN);
      if (name === "eps") return scalarValue(Number.EPSILON);
      if (name === "realmax") return scalarValue(Number.MAX_VALUE);
      if (name === "realmin") return scalarValue(2.2250738585072014e-308);
      if (name === "true") return scalarValue(1);
      if (name === "false") return scalarValue(0);
      throw new ParamError(`variavel nao definida: '${name}' (defina-a no Model Workspace do projeto)`, token.column);
    }
    this.next();
    return this.callFunction(name, this.arguments(), token.column);
  }

  private callFunction(name: string, args: ParamValue[], column: number): ParamValue {
    const need = (min: number, max: number) => {
      if (args.length < min || args.length > max) throw new ParamError(`numero de argumentos invalido para ${name}`, column);
    };
    const unary = UNARY_FUNCTIONS[name];
    if (unary) { need(1, 1); return mapValue(args[0]!, unary); }
    const scalarArg = (v: ParamValue, what: string) => { if (!isScalar(v)) throw new ParamError(`${what} precisa ser escalar`, column); return v.data[0]!; };
    switch (name) {
      case "real": case "double": need(1, 1); return args[0]!;
      case "transpose": need(1, 1); return transposed(args[0]!);
      case "atan2": need(2, 2); return elementwise(args[0]!, args[1]!, Math.atan2, column);
      case "hypot": need(2, 2); return elementwise(args[0]!, args[1]!, Math.hypot, column);
      case "power": need(2, 2); return elementwise(args[0]!, args[1]!, (a, b) => a ** b, column);
      case "rem": need(2, 2); return elementwise(args[0]!, args[1]!, (a, b) => (b === 0 ? Number.NaN : a - Math.trunc(a / b) * b), column);
      case "mod": need(2, 2); return elementwise(args[0]!, args[1]!, (a, b) => (b === 0 ? a : a - Math.floor(a / b) * b), column);
      case "max": case "min": {
        need(1, 2);
        const isMax = name === "max";
        if (args.length === 2) return elementwise(args[0]!, args[1]!, (a, b) => (isMax ? Math.max(a, b) : Math.min(a, b)), column);
        return reduce(args[0]!, (v) => (isMax ? Math.max(...v) : Math.min(...v)));
      }
      case "sum": need(1, 1); return reduce(args[0]!, (v) => v.reduce((a, b) => a + b, 0), 0);
      case "prod": need(1, 1); return reduce(args[0]!, (v) => v.reduce((a, b) => a * b, 1), 1);
      case "mean": need(1, 1); return reduce(args[0]!, (v) => v.reduce((a, b) => a + b, 0) / v.length);
      case "numel": need(1, 1); return scalarValue(args[0]!.data.length);
      case "length": need(1, 1); return scalarValue(args[0]!.data.length === 0 ? 0 : Math.max(args[0]!.rows, args[0]!.cols));
      case "size": {
        need(1, 2);
        if (args.length === 2) { const dim = scalarArg(args[1]!, "dimensao"); return scalarValue(dim === 1 ? args[0]!.rows : dim === 2 ? args[0]!.cols : 1); }
        return rowValue([args[0]!.rows, args[0]!.cols]);
      }
      case "zeros": case "ones": case "eye": {
        need(0, 2);
        const count = (v: ParamValue) => { const n = scalarArg(v, "dimensao"); if (n < 0 || n !== Math.floor(n) || n > 1e6) throw new ParamError("dimensao invalida", column); return n; };
        let rows = 1, cols = 1;
        if (args.length === 1 && args[0]!.data.length === 2) { rows = count(scalarValue(args[0]!.data[0]!)); cols = count(scalarValue(args[0]!.data[1]!)); }
        else if (args.length >= 1) { rows = count(args[0]!); cols = args.length === 2 ? count(args[1]!) : rows; }
        if (name === "eye") return identity(rows, cols);
        return makeValue(rows, cols, name === "ones" ? 1 : 0);
      }
      case "diag": {
        need(1, 1);
        const v = args[0]!;
        if (isVector(v)) { const n = v.data.length; const r = makeValue(n, n); v.data.forEach((x, i) => { r.data[i * n + i] = x; }); return r; }
        const d: number[] = [];
        for (let i = 0; i < Math.min(v.rows, v.cols); i++) d.push(v.data[i * v.cols + i]!);
        return { rows: d.length, cols: d.length === 0 ? 0 : 1, data: d };
      }
      case "linspace": {
        need(2, 3);
        const a = scalarArg(args[0]!, "inicio"), b = scalarArg(args[1]!, "fim");
        const n = args.length === 3 ? scalarArg(args[2]!, "n") : 100;
        if (n < 1 || n !== Math.floor(n)) throw new ParamError("n invalido em linspace", column);
        return rowValue(Array.from({ length: n }, (_, i) => (n === 1 ? b : a + ((b - a) * i) / (n - 1))));
      }
      case "conv": need(2, 2); return rowValue(polyConv(linear(args[0]!), linear(args[1]!)));
      case "poly": { need(1, 1); let p = [1]; for (const root of linear(args[0]!)) p = polyConv(p, [1, -root]); return rowValue(p); }
      case "polyval": { need(2, 2); const p = linear(args[0]!); return mapValue(args[1]!, (x) => p.reduce((y, c) => y * x + c, 0)); }
      case "repmat": {
        need(2, 3);
        const m = scalarArg(args[1]!, "m"), n = args.length === 3 ? scalarArg(args[2]!, "n") : m;
        const row = concatenateRow(Array.from({ length: n }, () => args[0]!), column);
        return concatenateColumn(Array.from({ length: m }, () => row), column);
      }
      case "reshape": {
        need(3, 3);
        const rows = scalarArg(args[1]!, "linhas"), cols = scalarArg(args[2]!, "colunas");
        const values = linear(args[0]!);
        if (rows * cols !== values.length) throw new ParamError("reshape com numero de elementos diferente", column);
        const r = makeValue(rows, cols);
        values.forEach((x, i) => { r.data[(i % rows) * cols + Math.floor(i / rows)] = x; });
        return r;
      }
      case "fliplr": case "flipud": {
        need(1, 1);
        const v = args[0]!;
        const r = makeValue(v.rows, v.cols);
        for (let i = 0; i < v.rows; i++) for (let j = 0; j < v.cols; j++)
          r.data[i * v.cols + j] = name === "fliplr" ? v.data[i * v.cols + (v.cols - 1 - j)]! : v.data[(v.rows - 1 - i) * v.cols + j]!;
        return r;
      }
      case "cumsum": {
        need(1, 1);
        if (!isVector(args[0]!)) throw new ParamError("cumsum so para vetores", column);
        let sum = 0;
        return mapValue(args[0]!, (x) => (sum += x));
      }
      case "inv": need(1, 1); return solveLinear(args[0]!, identity(args[0]!.rows, args[0]!.rows), column);
      case "pi": need(0, 0); return scalarValue(Math.PI);
      case "eps": need(0, 0); return scalarValue(Number.EPSILON);
      case "Inf": case "inf": need(0, 0); return scalarValue(Infinity);
      case "NaN": case "nan": need(0, 0); return scalarValue(Number.NaN);
      default: throw new ParamError(`funcao nao suportada: ${name}`, column);
    }
  }
}

function reduce(value: ParamValue, fn: (v: number[]) => number, emptyResult?: number): ParamValue {
  if (value.data.length === 0) return emptyResult === undefined ? emptyValue() : scalarValue(emptyResult);
  if (isVector(value)) return scalarValue(fn(value.data));
  const out: number[] = [];
  for (let c = 0; c < value.cols; c++) {
    const column: number[] = [];
    for (let r = 0; r < value.rows; r++) column.push(value.data[r * value.cols + c]!);
    out.push(fn(column));
  }
  return rowValue(out);
}

export function evaluateParam(text: string, workspace?: ParamWorkspace): ParamValue {
  return new Parser(text, workspace).parse();
}

/** Avalia sem lançar: `undefined` quando a expressão não é válida (ícones mostram o texto). */
export function tryEvaluateParam(text: string, workspace?: ParamWorkspace): ParamValue | undefined {
  try {
    return evaluateParam(text, workspace);
  } catch {
    return undefined;
  }
}

/** Número com até 15 dígitos significativos, sem zeros à direita (como o MATLAB em `format short g`). */
export function formatNumber(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "Inf" : "-Inf";
  return String(Number(value.toPrecision(15)));
}

export function formatParam(value: ParamValue): string {
  if (isScalar(value)) return formatNumber(value.data[0]!);
  const rows: string[] = [];
  for (let r = 0; r < value.rows; r++) rows.push(value.data.slice(r * value.cols, (r + 1) * value.cols).map(formatNumber).join(" "));
  return `[${rows.join("; ")}]`;
}
