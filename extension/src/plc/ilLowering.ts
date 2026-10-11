/*
 * Lista de Instruções (IL), IEC 61131-3 3ª edição, seção 7.2 -> ST canônico.
 *
 * O resultado corrente (CR) da IL é um acumulador tipado. Aqui ele é uma expressão ST com tipo,
 * montada pelas operações puras (LD, AND, ADD, GT, funções...) e gravada numa variável temporária
 * (`__IL_CR_<TIPO>`) antes de toda instrução com efeito (ST N, S, R, CAL, operadores de entrada de
 * FB, saltos), para que uma escrita nunca mude um valor que o CR ainda vai usar.
 *
 * Operadores (tabela 68): LD ST S R AND & OR XOR NOT ADD SUB MUL DIV MOD GT GE EQ NE LE LT JMP CAL
 * RET e `)`. Modificadores: N (negação do operando), C (condicional: JMPC, CALC, RETC e as formas
 * CN), `(` (operação adiada até o `)`, com ou sem operando na mesma linha). Chamada de função com o
 * CR como primeiro argumento (`LIMIT 0, 100`) ou formal (`LIMIT( MN := 0, IN := X, MX := 100 )`).
 * Chamada de FB por `CAL inst`, `CAL inst(...)` (formal, pode ocupar várias linhas) e pelos
 * operadores de entrada (`IN T1`, `PT T1`, `CU C1`, `R C1`, `LD C2`, `S1 SR1`, `CLK RT1`...).
 *
 * Rótulos e JMP viram uma máquina de estados (`WHILE`/`CASE` sobre `__IL_PC`): ST não tem GOTO. Um
 * laço infinito escrito pelo aluno estoura o watchdog do worker, como no CLP real.
 */

import { IEC_STANDARD_FUNCTIONS, IEC_STANDARD_FUNCTION_BLOCKS } from "./iecStandardLibrary";

export interface IlDiagnostic {
  /** Linha do texto IL (1 = primeira). */
  line: number;
  message: string;
}

export interface IlMember {
  type: string;
  direction: "input" | "output" | "inOut" | "local";
}

export interface IlContext {
  pouName: string;
  pouKind: "program" | "function" | "functionBlock";
  /** Nome (maiúsculas) -> tipo declarado (maiúsculas). Inclui instâncias de FB e, numa FUNCTION, o
   * próprio nome com o tipo de retorno. */
  variables: Map<string, string>;
  /** FBs do projeto: tipo (maiúsculas) -> membros. Os padrão vêm de iecStandardLibrary. */
  functionBlocks: Map<string, Map<string, IlMember>>;
  /** FUNCTIONs do projeto: nome (maiúsculas) -> retorno e entradas na ordem. */
  functions: Map<string, { returnType: string; inputs: string[] }>;
}

export interface IlStLine {
  text: string;
  sourceLine: number;
}

export interface IlLowering {
  /** Declarações para o bloco VAR do POU (temporárias do CR, pilha do `(`, contador de estados). */
  declarations: string[];
  lines: IlStLine[];
  diagnostics: IlDiagnostic[];
}

interface Value {
  expr: string;
  type: string;
  /** constant: só literais, nenhuma escrita muda o valor. temp: uma `__IL_*`, só o gerador escreve.
   * expr: depende de variáveis do programa; copiado para uma temporária antes de qualquer efeito. */
  kind: "constant" | "temp" | "expr";
}

interface Instruction {
  line: number;
  label?: string;
  op: string;
  negate: boolean;
  conditional: boolean;
  deferred: boolean;
  operand: string;
  /** Chamada formal de função: `NOME( P := x, ... )`. */
  formalArgs?: string;
}

interface Frame {
  op: string;
  negate: boolean;
  saved: Value;
  line: number;
}

const DEFERRABLE = new Set(["AND", "&", "OR", "XOR", "ADD", "SUB", "MUL", "DIV", "MOD", "GT", "GE", "EQ", "NE", "LE", "LT"]);
const LOGICAL: Record<string, string> = { AND: "AND", "&": "AND", OR: "OR", XOR: "XOR" };
const ARITHMETIC: Record<string, string> = { ADD: "+", SUB: "-", MUL: "*", DIV: "/", MOD: "MOD" };
const COMPARISON: Record<string, string> = { GT: ">", GE: ">=", EQ: "=", NE: "<>", LE: "<=", LT: "<" };
/** Operadores de entrada de FB da norma (tabela 70); S, R e LD só quando o operando é uma instância. */
const FB_INPUT_OPERATORS = new Set(["S1", "R1", "CLK", "CU", "CD", "PV", "IN", "PT", "S", "R", "LD"]);
const ELEMENTARY = new Set(["BOOL", "SINT", "INT", "DINT", "LINT", "USINT", "UINT", "UDINT", "ULINT", "REAL", "LREAL",
  "BYTE", "WORD", "DWORD", "LWORD", "TIME", "LTIME", "DATE", "TOD", "TIME_OF_DAY", "DT", "DATE_AND_TIME", "STRING", "WSTRING", "CHAR", "WCHAR"]);
const INTEGER_TYPES = new Set(["SINT", "INT", "DINT", "LINT", "USINT", "UINT", "UDINT", "ULINT"]);
const REAL_TYPES = new Set(["REAL", "LREAL"]);
const BIT_TYPES = new Set(["BOOL", "BYTE", "WORD", "DWORD", "LWORD"]);

// ------------------------------------------------------------------------------------------ texto

/** Remove `(* ... *)` e `// ...` fora de literais, mantendo as quebras de linha (números de linha). */
export function stripIlComments(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === "'" || char === "\"") {
      const end = text.indexOf(char, index + 1);
      const stop = end < 0 ? text.length : end + 1;
      out += text.slice(index, stop);
      index = stop;
    } else if (text.startsWith("(*", index)) {
      const end = text.indexOf("*)", index + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(index, stop).replace(/[^\n]/g, " ");
      index = stop;
    } else if (text.startsWith("//", index)) {
      const end = text.indexOf("\n", index);
      const stop = end < 0 ? text.length : end;
      out += " ".repeat(stop - index);
      index = stop;
    } else {
      out += char;
      index += 1;
    }
  }
  return out;
}

/** Divide por vírgulas fora de parênteses, colchetes e literais. */
export function splitTopLevel(text: string, separator = ","): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let current = "";
  for (const char of text) {
    if (quote) {
      current += char;
      if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === "\"") quote = char;
    else if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth -= 1;
    if (char === separator && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else current += char;
  }
  if (current.trim() || parts.length > 0) parts.push(current.trim());
  return parts;
}

function parenBalance(text: string): number {
  let depth = 0;
  let quote = "";
  for (const char of text) {
    if (quote) { if (char === quote) quote = ""; continue; }
    if (char === "'" || char === "\"") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
  }
  return depth;
}

const OPERATOR_PATTERN = /^(&N?|[A-Za-z_][A-Za-z0-9_]*|\))\s*(\()?\s*(.*)$/;
const LABEL_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)\s*:(?!=)\s*(.*)$/;

function decodeOperator(raw: string): { op: string; negate: boolean; conditional: boolean } {
  const upper = raw.toUpperCase();
  if (upper === "&N") return { op: "&", negate: true, conditional: false };
  let match = /^(JMP|CAL|RET)(C?)(N?)$/.exec(upper);
  if (match && (match[2] || !match[3])) return { op: match[1]!, conditional: match[2] === "C", negate: match[3] === "N" };
  match = /^(LD|ST|AND|OR|XOR)(N)$/.exec(upper);
  if (match) return { op: match[1]!, negate: true, conditional: false };
  return { op: upper, negate: false, conditional: false };
}

/** Texto IL -> instruções (rótulos, operador, modificadores, operando; CAL/funções formais juntam linhas). */
export function parseIl(text: string, diagnostics: IlDiagnostic[]): Instruction[] {
  const lines = stripIlComments(text.replace(/\r\n/g, "\n")).split("\n");
  const result: Instruction[] = [];
  let pendingLabel: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    let line = lines[index]!.trim();
    if (!line) continue;
    const label = LABEL_PATTERN.exec(line);
    if (label) {
      if (pendingLabel) result.push({ line: lineNumber, label: pendingLabel, op: "", negate: false, conditional: false, deferred: false, operand: "" });
      pendingLabel = label[1]!.toUpperCase();
      line = label[2]!.trim();
      if (!line) continue;
    }
    // `;` não existe na IL; aceita o hábito do ST no fim da instrução.
    line = line.replace(/;\s*$/, "").trim();
    const match = OPERATOR_PATTERN.exec(line);
    if (!match) {
      diagnostics.push({ line: lineNumber, message: `instrução IL inválida: ${line}` });
      continue;
    }
    const decoded = decodeOperator(match[1]!);
    let operand = match[3]!.trim();
    const paren = Boolean(match[2]);
    const deferred = paren && DEFERRABLE.has(decoded.op);
    let formalArgs: string | undefined;
    if (paren && !deferred && decoded.op !== ")") {
      // NOME( ... ) formal: junta as linhas até fechar o parêntese.
      let body = operand;
      let balance = 1 + parenBalance(body);
      while (balance > 0 && index + 1 < lines.length) {
        index += 1;
        const next = lines[index]!.trim();
        body += (body ? " " : "") + next;
        balance = 1 + parenBalance(body);
      }
      if (balance !== 0) diagnostics.push({ line: lineNumber, message: `parêntese de ${decoded.op}( sem fechamento` });
      formalArgs = body.replace(/\)\s*;?\s*$/, "").trim();
      operand = "";
    } else if ((decoded.op === "CAL") && parenBalance(operand) > 0) {
      // CAL inst( ... ) em várias linhas.
      while (parenBalance(operand) > 0 && index + 1 < lines.length) {
        index += 1;
        operand += " " + lines[index]!.trim();
      }
      if (parenBalance(operand) !== 0) diagnostics.push({ line: lineNumber, message: "parêntese do CAL sem fechamento" });
      operand = operand.replace(/;\s*$/, "").trim();
    }
    result.push({
      line: lineNumber,
      ...(pendingLabel ? { label: pendingLabel } : {}),
      op: decoded.op,
      negate: decoded.negate,
      conditional: decoded.conditional,
      deferred,
      operand,
      ...(formalArgs !== undefined ? { formalArgs } : {}),
    });
    pendingLabel = undefined;
  }
  if (pendingLabel) result.push({ line: lines.length, label: pendingLabel, op: "", negate: false, conditional: false, deferred: false, operand: "" });
  return result;
}

// ------------------------------------------------------------------------------------------ tipos

function isGeneric(type: string): boolean {
  return type.startsWith("ANY");
}

function unify(left: string, right: string): string {
  if (left === right) return left;
  if (isGeneric(left) && !isGeneric(right)) return right;
  if (!isGeneric(left) && isGeneric(right)) return left;
  if (isGeneric(left) && isGeneric(right)) return left === "ANY_REAL" || right === "ANY_REAL" ? "ANY_REAL" : left;
  return left;
}

/** Tipo para a temporária: genéricos viram o tipo mais largo do grupo. */
function concrete(type: string): string | undefined {
  if (type === "ANY_INT" || type === "ANY_NUM") return type === "ANY_NUM" ? "LREAL" : "DINT";
  if (type === "ANY_REAL") return "LREAL";
  if (type === "ANY_BIT") return "DWORD";
  if (type === "ANY_STRING") return "STRING";
  if (/^STRING(\s*[([].*)?$/.test(type)) return "STRING";
  if (/^WSTRING(\s*[([].*)?$/.test(type)) return "WSTRING";
  if (type === "TIME_OF_DAY") return "TOD";
  if (type === "DATE_AND_TIME") return "DT";
  return ELEMENTARY.has(type) ? type : undefined;
}

/** Membro (entrada, saída...) de um tipo de FB do projeto ou da biblioteca padrão. */
export function functionBlockMember(context: IlContext, fbType: string, member: string): IlMember | undefined {
  const project = context.functionBlocks.get(fbType)?.get(member);
  if (project) return project;
  const standard = IEC_STANDARD_FUNCTION_BLOCKS[fbType];
  if (!standard) return undefined;
  for (const [list, direction] of [[standard.inputs, "input"], [standard.outputs, "output"], [standard.inouts, "inOut"]] as const) {
    const found = list.find(item => item.name === member);
    if (found) return { type: found.type, direction };
  }
  return undefined;
}

export function isFunctionBlockType(context: IlContext, type: string | undefined): boolean {
  return !!type && (context.functionBlocks.has(type) || !!IEC_STANDARD_FUNCTION_BLOCKS[type]);
}

/** Tipo de um caminho de variável (A, A.B, A[i], A[i].B, X.3). */
export function variablePathType(context: IlContext, path: string): string | undefined {
  const parts = splitTopLevel(path, ".");
  const head = /^([A-Za-z_][A-Za-z0-9_]*)((?:\[.*\])*)$/.exec(parts[0] ?? "");
  if (!head) return undefined;
  let type = context.variables.get(head[1]!.toUpperCase());
  if (type && head[2]) type = /^ARRAY\s*\[.*\]\s*OF\s+(.+)$/i.exec(type)?.[1]?.trim().toUpperCase();
  for (const raw of parts.slice(1)) {
    if (!type) return undefined;
    if (/^\d+$/.test(raw)) { type = "BOOL"; continue; } // acesso a bit (ed. 3)
    const member = /^([A-Za-z_][A-Za-z0-9_]*)((?:\[.*\])*)$/.exec(raw);
    if (!member) return undefined;
    type = functionBlockMember(context, type, member[1]!.toUpperCase())?.type;
    if (type && member[2]) type = /^ARRAY\s*\[.*\]\s*OF\s+(.+)$/i.exec(type)?.[1]?.trim().toUpperCase();
  }
  return type;
}

/** Tipo de um literal IEC (TRUE, 5, 2.5, 16#FF, INT#3, T#1s, 'texto', %IX0.0), ou undefined. */
export function literalType(text: string): string | undefined {
  const upper = text.toUpperCase();
  if (upper === "TRUE" || upper === "FALSE") return "BOOL";
  const typed = /^([A-Z_]+)#(.+)$/.exec(upper);
  if (typed) {
    const prefix = typed[1]!;
    if (prefix === "T" || prefix === "TIME") return "TIME";
    if (prefix === "LT" || prefix === "LTIME") return "LTIME";
    if (prefix === "D" || prefix === "DATE") return "DATE";
    if (prefix === "TOD" || prefix === "TIME_OF_DAY") return "TOD";
    if (prefix === "DT" || prefix === "DATE_AND_TIME") return "DT";
    if (ELEMENTARY.has(prefix)) return prefix;
    return undefined;
  }
  if (/^\d+#[0-9A-F_]+$/.test(upper)) return "ANY_INT";
  if (/^[+-]?\d[\d_]*$/.test(upper)) return "ANY_INT";
  if (/^[+-]?\d[\d_]*(\.\d[\d_]*)?(E[+-]?\d+)?$/.test(upper)) return "ANY_REAL";
  if (/^'.*'$/.test(text)) return "STRING";
  if (/^".*"$/.test(text)) return "WSTRING";
  const direct = /^%[IQM]([XBWDL])?\d+(\.\d+)*$/.exec(upper);
  if (direct) return ({ X: "BOOL", B: "BYTE", W: "WORD", D: "DWORD", L: "LWORD" } as Record<string, string>)[direct[1] ?? "X"];
  return undefined;
}

// ------------------------------------------------------------------------------------------ geração

class IlGenerator {
  private readonly diagnostics: IlDiagnostic[];
  private readonly declarations = new Map<string, string>();
  private blocks: Array<{ lines: IlStLine[]; label?: string; firstLine: number }> = [];
  private cr: Value | undefined;
  private frames: Frame[] = [];
  private readonly machine: boolean;
  private readonly labels = new Map<string, number>();
  private currentLine = 1;

  constructor(private readonly context: IlContext, private readonly instructions: Instruction[], diagnostics: IlDiagnostic[]) {
    this.diagnostics = diagnostics;
    this.machine = instructions.some(item => item.op === "JMP");
    this.blocks.push({ lines: [], firstLine: instructions[0]?.line ?? 1 });
  }

  private error(message: string, line = this.currentLine): void {
    this.diagnostics.push({ line, message });
  }

  private emit(text: string): void {
    this.blocks[this.blocks.length - 1]!.lines.push({ text, sourceLine: this.currentLine });
  }

  private temp(prefix: string, type: string): string {
    const name = `__IL_${prefix}_${type.replace(/[^A-Z0-9_]/g, "_")}`;
    this.declarations.set(name, type);
    return name;
  }

  // ---------------------------------------------------------------- operandos

  private memberOf(fbType: string, member: string): IlMember | undefined {
    return functionBlockMember(this.context, fbType, member);
  }

  private isFunctionBlockType(type: string | undefined): boolean {
    return isFunctionBlockType(this.context, type);
  }

  private pathType(path: string): string | undefined {
    return variablePathType(this.context, path);
  }

  private operand(text: string, what = "operando"): Value | undefined {
    const trimmed = text.trim();
    if (!trimmed) { this.error(`falta o ${what}`); return undefined; }
    const literal = literalType(trimmed);
    if (literal) return { expr: trimmed, type: literal, kind: "constant" };
    if (!/^[A-Za-z_]/.test(trimmed)) { this.error(`${what} inválido: ${trimmed}`); return undefined; }
    const type = this.pathType(trimmed);
    if (!type) {
      const base = /^[A-Za-z_][A-Za-z0-9_]*/.exec(trimmed)![0].toUpperCase();
      this.error(this.context.variables.has(base) ? `não foi possível determinar o tipo de ${trimmed}` : `variável não declarada: ${trimmed}`);
      return undefined;
    }
    if (this.isFunctionBlockType(type)) { this.error(`${trimmed} é uma instância de ${type}: use CAL ou um operador de entrada`); return undefined; }
    return { expr: trimmed, type, kind: "expr" };
  }

  private requireCr(op: string): Value | undefined {
    if (!this.cr) this.error(`${op} sem resultado corrente: comece com LD`);
    return this.cr;
  }

  /** Copia o CR para `__IL_CR_<TIPO>` quando ele depende de variáveis que a próxima instrução pode
   * mudar. `boundary`: fim de bloco (rótulo/salto), em que o bloco seguinte lê o CR da temporária. */
  private materialize(value: Value | undefined, boundary = false): Value | undefined {
    if (!value) return undefined;
    if (value.kind === "temp" && value.expr.startsWith("__IL_CR_")) return value;
    if (value.kind !== "expr" && !boundary) return value;
    const type = concrete(value.type);
    if (!type) { this.error(`não foi possível guardar o resultado corrente do tipo ${value.type}`); return undefined; }
    const name = this.temp("CR", type);
    this.emit(`${name} := ${value.expr};`);
    return { expr: name, type, kind: "temp" };
  }

  private static derived(expr: string, type: string, parts: Value[]): Value {
    return { expr, type, kind: parts.every(part => part.kind === "constant") ? "constant" : "expr" };
  }

  // ---------------------------------------------------------------- operações

  private binary(op: string, left: Value, right: Value, negate: boolean): Value | undefined {
    const rightExpr = negate ? `NOT (${right.expr})` : `(${right.expr})`;
    const parts = [left, right];
    if (LOGICAL[op]) return IlGenerator.derived(`(${left.expr}) ${LOGICAL[op]} ${rightExpr}`, unify(left.type, right.type), parts);
    if (negate) { this.error(`o modificador N não vale para ${op}`); return undefined; }
    if (ARITHMETIC[op]) {
      const type = left.type === "TIME" || left.type === "LTIME" ? left.type : unify(left.type, right.type);
      return IlGenerator.derived(`(${left.expr}) ${ARITHMETIC[op]} ${rightExpr}`, type, parts);
    }
    if (COMPARISON[op]) return IlGenerator.derived(`(${left.expr}) ${COMPARISON[op]} ${rightExpr}`, "BOOL", parts);
    this.error(`operador desconhecido: ${op}`);
    return undefined;
  }

  private functionReturnType(name: string, args: Array<{ param?: string; value: Value }>): string | undefined {
    const project = this.context.functions.get(name);
    if (project) return project.returnType.toUpperCase();
    const conversion = /^([A-Z_]+)_TO_([A-Z_]+)$/.exec(name);
    if (conversion) return conversion[2] === "TIME_OF_DAY" ? "TOD" : conversion[2] === "DATE_AND_TIME" ? "DT" : conversion[2];
    const trunc = /^TRUNC_([A-Z]+)$/.exec(name);
    if (trunc) return trunc[1];
    const standard = IEC_STANDARD_FUNCTIONS[name];
    if (!standard) return undefined;
    if (name === "TRUNC") return "DINT";
    if (!isGeneric(standard.returnType)) return standard.returnType;
    // Retorno genérico: o tipo dos argumentos declarados com o mesmo genérico (SEL: IN0/IN1, não G).
    let type: string | undefined;
    args.forEach((arg, index) => {
      const param = arg.param
        ? standard.parameters.find(item => item.name === arg.param)
        : standard.parameters[Math.min(index, standard.parameters.length - 1)];
      if (param && param.type === standard.returnType) type = type ? unify(type, arg.value.type) : arg.value.type;
    });
    return type ?? standard.returnType;
  }

  private isFunction(name: string): boolean {
    return this.context.functions.has(name) || !!IEC_STANDARD_FUNCTIONS[name] ||
      /^[A-Z_]+_TO_[A-Z_]+$/.test(name) || /^TRUNC_[A-Z]+$/.test(name);
  }

  private callFunction(name: string, instruction: Instruction): Value | undefined {
    const args: Array<{ param?: string; value: Value; text: string }> = [];
    if (instruction.formalArgs !== undefined) {
      for (const part of splitTopLevel(instruction.formalArgs)) {
        if (!part) continue;
        const formal = /^([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*(.+)$/.exec(part);
        if (!formal) { this.error(`argumento formal inválido em ${name}: ${part}`); return undefined; }
        const value = this.operandExpression(formal[2]!);
        if (!value) return undefined;
        args.push({ param: formal[1]!.toUpperCase(), value, text: `${formal[1]} := ${formal[2]!.trim()}` });
      }
    } else {
      let cr = this.requireCr(name);
      // STruCpp 0.6.3 não compila CONCAT('a', 'b') (C++ sem sobrecarga para dois literais): um
      // literal de string no CR vai para a temporária antes da chamada.
      if (cr && cr.kind === "constant" && /STRING/.test(cr.type)) cr = this.materialize(cr, true);
      if (!cr) return undefined;
      args.push({ value: cr, text: cr.expr });
      if (instruction.operand) {
        for (const part of splitTopLevel(instruction.operand)) {
          const value = this.operandExpression(part);
          if (!value) return undefined;
          args.push({ value, text: part });
        }
      }
    }
    const type = this.functionReturnType(name, args);
    if (!type) { this.error(`função desconhecida: ${name}`); return undefined; }
    return IlGenerator.derived(`${name}(${args.map(arg => arg.text).join(", ")})`, type, args.map(arg => arg.value));
  }

  /** Argumento de função: operando simples ou expressão ST (tipo pelo primeiro termo). */
  private operandExpression(text: string): Value | undefined {
    const trimmed = text.trim();
    if (literalType(trimmed) || /^[A-Za-z_][A-Za-z0-9_.[\]]*$/.test(trimmed)) return this.operand(trimmed, "argumento");
    const first = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(trimmed)?.[0];
    const type = first ? this.pathType(first) : literalType(trimmed.split(/\s+/)[0] ?? "");
    return { expr: `(${trimmed})`, type: type ?? "ANY", kind: "expr" };
  }

  private fbInputOperator(instruction: Instruction): boolean {
    if (!FB_INPUT_OPERATORS.has(instruction.op) || instruction.negate || instruction.deferred) return false;
    const instance = instruction.operand.trim();
    const type = this.pathType(instance);
    if (!this.isFunctionBlockType(type)) return false;
    const member = this.memberOf(type!, instruction.op);
    if (!member || member.direction !== "input") {
      this.error(`${type} não tem a entrada ${instruction.op}`);
      return true;
    }
    const cr = this.materialize(this.requireCr(instruction.op));
    if (!cr) return true;
    this.cr = cr;
    this.emit(`${instance}(${instruction.op} := ${cr.expr});`);
    return true;
  }

  private conditionValue(op: string): Value | undefined {
    const cr = this.materialize(this.requireCr(op));
    if (cr && cr.type !== "BOOL") this.error(`${op} exige resultado corrente BOOL (está ${cr.type})`);
    this.cr = cr;
    return cr;
  }

  private store(instruction: Instruction): void {
    const target = instruction.operand.trim();
    const targetType = this.pathType(target);
    if (!targetType) { this.error(`destino não declarado: ${target}`); return; }
    if (this.isFunctionBlockType(targetType)) { this.error(`${target} é uma instância de FB, não pode receber ST`); return; }
    let cr = this.requireCr("ST");
    if (!cr) return;
    if (instruction.negate) {
      cr = this.materialize(cr);
      if (!cr) return;
      this.emit(`${target} := NOT (${cr.expr});`);
      this.cr = cr;
      return;
    }
    if (cr.kind !== "expr") {
      this.emit(`${target} := ${cr.expr};`);
      this.cr = cr;
      return;
    }
    // Expressão: o CR passa a ser o próprio destino, uma variável simples (sem índice, e não o nome
    // da FUNCTION). A próxima instrução com efeito copia o destino para uma temporária antes.
    const simple = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(target) &&
      !(this.context.pouKind === "function" && target.toUpperCase() === this.context.pouName.toUpperCase());
    if (!simple) cr = this.materialize(cr);
    if (!cr) return;
    this.emit(`${target} := ${cr.expr};`);
    this.cr = simple ? { expr: target, type: targetType, kind: "expr" } : cr;
  }

  private setReset(instruction: Instruction): void {
    const target = instruction.operand.trim();
    const targetType = this.pathType(target);
    if (!targetType) { this.error(`destino não declarado: ${target}`); return; }
    const cr = this.conditionValue(instruction.op);
    if (!cr) return;
    this.emit(`IF ${cr.expr} THEN ${target} := ${instruction.op === "S" ? "TRUE" : "FALSE"}; END_IF;`);
  }

  private call(instruction: Instruction): void {
    const match = /^([A-Za-z_][A-Za-z0-9_.[\]]*)\s*(\((.*)\))?$/s.exec(instruction.operand.trim());
    if (!match) { this.error(`CAL inválido: ${instruction.operand}`); return; }
    const instance = match[1]!;
    const type = this.pathType(instance);
    if (!this.isFunctionBlockType(type)) {
      this.error(type ? `${instance} não é uma instância de bloco de função` : `instância não declarada: ${instance}`);
      return;
    }
    const callText = `${instance}(${(match[3] ?? "").trim()});`;
    if (!instruction.conditional) {
      this.cr = this.materialize(this.cr);
      this.emit(callText);
      return;
    }
    const cr = this.conditionValue(`CALC${instruction.negate ? "N" : ""}`);
    if (!cr) return;
    this.emit(`IF ${instruction.negate ? "NOT " : ""}${cr.expr} THEN ${callText} END_IF;`);
  }

  private ret(instruction: Instruction): void {
    if (!instruction.conditional) { this.emit("RETURN;"); return; }
    const cr = this.conditionValue(`RETC${instruction.negate ? "N" : ""}`);
    if (cr) this.emit(`IF ${instruction.negate ? "NOT " : ""}${cr.expr} THEN RETURN; END_IF;`);
  }

  // ---------------------------------------------------------------- blocos (rótulos e saltos)

  private startBlock(label?: string): void {
    const current = this.blocks[this.blocks.length - 1]!;
    if (label && current.lines.length === 0 && !current.label) {
      // Bloco ainda vazio (início do texto ou logo depois de um JMP): o rótulo é dele.
      current.label = label;
      current.firstLine = this.currentLine;
      this.labels.set(label, this.blocks.length - 1);
      return;
    }
    const crAtEntry = this.materialize(this.cr, true);
    const next = this.blocks.length;
    if (this.machine) this.emit(`__IL_PC := ${next};`);
    this.blocks.push({ lines: [], ...(label ? { label } : {}), firstLine: this.currentLine });
    if (label) this.labels.set(label, next);
    this.cr = crAtEntry;
  }

  private jump(instruction: Instruction): void {
    const target = instruction.operand.trim().toUpperCase();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(target)) { this.error(`rótulo inválido: ${instruction.operand}`); return; }
    const placeholder = `@@LABEL:${target}:${this.currentLine}@@`;
    if (!instruction.conditional) {
      this.cr = this.materialize(this.cr, true);
      this.emit(`__IL_PC := ${placeholder};`);
      this.blocks.push({ lines: [], firstLine: this.currentLine });
      return;
    }
    const cr = this.conditionValue(`JMPC${instruction.negate ? "N" : ""}`);
    if (!cr) return;
    const next = this.blocks.length;
    this.emit(`IF ${instruction.negate ? "NOT " : ""}${cr.expr} THEN __IL_PC := ${placeholder}; ELSE __IL_PC := ${next}; END_IF;`);
    this.blocks.push({ lines: [], firstLine: this.currentLine });
  }

  // ---------------------------------------------------------------- execução

  run(): IlLowering {
    for (const instruction of this.instructions) {
      this.currentLine = instruction.line;
      if (instruction.label) {
        if (this.frames.length > 0) this.error("rótulo dentro de parênteses");
        if (this.labels.has(instruction.label)) this.error(`rótulo repetido: ${instruction.label}`);
        if (this.machine) this.startBlock(instruction.label);
        else this.labels.set(instruction.label, 0);
      }
      if (!instruction.op) continue;
      this.step(instruction);
    }
    for (const frame of this.frames) this.error(`${frame.op}( sem o ")" correspondente`, frame.line);
    return this.finish();
  }

  private step(instruction: Instruction): void {
    const { op } = instruction;
    if (op === ")") {
      const frame = this.frames.pop();
      if (!frame) { this.error(`")" sem operação adiada aberta`); return; }
      const inner = this.requireCr(")");
      this.cr = inner ? this.binary(frame.op, frame.saved, inner, frame.negate) : undefined;
      return;
    }
    if (this.frames.length > 0 && ["ST", "S", "R", "JMP", "CAL", "RET"].includes(op)) {
      this.error(`${op} não é permitido dentro de parênteses`);
      return;
    }
    if (instruction.deferred) {
      const left = this.requireCr(`${op}(`);
      if (!left) return;
      // O lado esquerdo vai para uma temporária própria do nível: as instruções dentro dos
      // parênteses podem reusar `__IL_CR_<TIPO>`.
      const saved: Value | undefined = left.kind === "constant" ? left : (() => {
        const type = concrete(left.type);
        if (!type) { this.error(`não foi possível guardar o resultado corrente do tipo ${left.type}`); return undefined; }
        const name = this.temp(`S${this.frames.length + 1}`, type);
        this.emit(`${name} := ${left.expr};`);
        return { expr: name, type, kind: "temp" as const };
      })();
      if (!saved) return;
      this.frames.push({ op, negate: instruction.negate, saved, line: instruction.line });
      this.cr = instruction.operand ? this.operand(instruction.operand) : undefined;
      return;
    }
    if (this.fbInputOperator(instruction)) return;
    switch (op) {
      case "LD": {
        const value = this.operand(instruction.operand);
        this.cr = value && instruction.negate ? { ...value, expr: `NOT (${value.expr})` } : value;
        return;
      }
      case "ST": this.store(instruction); return;
      case "S":
      case "R": this.setReset(instruction); return;
      case "NOT": {
        const cr = this.requireCr("NOT");
        if (cr) this.cr = { expr: `NOT (${cr.expr})`, type: cr.type, kind: cr.kind === "constant" ? "constant" : "expr" };
        return;
      }
      case "JMP": this.jump(instruction); return;
      case "CAL": this.call(instruction); return;
      case "RET": this.ret(instruction); return;
    }
    if (LOGICAL[op] || ARITHMETIC[op] || COMPARISON[op]) {
      const left = this.requireCr(op);
      const right = this.operand(instruction.operand);
      if (left && right) this.cr = this.binary(op, left, right, instruction.negate);
      return;
    }
    if (this.isFunction(op)) {
      if (instruction.negate || instruction.conditional) { this.error(`modificador inválido para a função ${op}`); return; }
      this.cr = this.callFunction(op, instruction);
      return;
    }
    if (FB_INPUT_OPERATORS.has(op)) { this.error(`${instruction.operand || "operando"} não é uma instância de bloco de função com a entrada ${op}`); return; }
    this.error(`operador IL desconhecido: ${op}`);
  }

  private finish(): IlLowering {
    const declarations = [...this.declarations].map(([name, type]) => `  ${name} : ${type};`);
    const resolve = (text: string): string => text.replace(/@@LABEL:([A-Z0-9_]+):(\d+)@@/g, (_, label: string, line: string) => {
      const index = this.labels.get(label);
      if (index === undefined) { this.diagnostics.push({ line: Number(line), message: `rótulo não encontrado: ${label}` }); return "-1"; }
      return String(index);
    });
    if (!this.machine) {
      return { declarations, lines: this.blocks.flatMap(block => block.lines), diagnostics: this.diagnostics };
    }
    const lines: IlStLine[] = [];
    const first = this.blocks[0]?.firstLine ?? 1;
    declarations.push("  __IL_PC : DINT;");
    lines.push({ text: "__IL_PC := 0;", sourceLine: first });
    lines.push({ text: "WHILE __IL_PC >= 0 DO", sourceLine: first });
    lines.push({ text: "  CASE __IL_PC OF", sourceLine: first });
    this.blocks.forEach((block, index) => {
      lines.push({ text: `    ${index}:${block.label ? ` (* ${block.label} *)` : ""}`, sourceLine: block.firstLine });
      for (const line of block.lines) lines.push({ text: `      ${resolve(line.text)}`, sourceLine: line.sourceLine });
      if (index === this.blocks.length - 1) lines.push({ text: "      __IL_PC := -1;", sourceLine: block.lines.at(-1)?.sourceLine ?? block.firstLine });
    });
    lines.push({ text: "  ELSE", sourceLine: first });
    lines.push({ text: "    __IL_PC := -1;", sourceLine: first });
    lines.push({ text: "  END_CASE;", sourceLine: first });
    lines.push({ text: "END_WHILE;", sourceLine: first });
    return { declarations, lines, diagnostics: this.diagnostics };
  }
}

export function lowerIlToSt(text: string, context: IlContext): IlLowering {
  const diagnostics: IlDiagnostic[] = [];
  const instructions = parseIl(text, diagnostics);
  return new IlGenerator(context, instructions, diagnostics).run();
}
