/*
 * Ladder (LD), IEC 61131-3 3ª ed., seção 8.2 -> ST canônico.
 *
 * Rede = grade entre a barra de alimentação esquerda (estado ON) e a direita. Tabela 74: a ligação
 * horizontal passa o estado do elemento à sua esquerda para o da direita; o estado de uma ligação
 * vertical é o OU dos estados ON das ligações horizontais à sua esquerda, copiado para todas as
 * ligações horizontais à sua direita.
 *
 * Tabela 75 (contatos): NA copia o estado da esquerda se a variável está ON; NF se está OFF;
 * transição positiva/negativa dá ON por uma avaliação quando a variável muda OFF->ON / ON->OFF com
 * a esquerda ON; contato de comparação conduz quando `esquerdo <op> direito`.
 * Tabela 76 (bobinas): bobina copia a esquerda para a variável; negada copia o inverso; set/reset
 * ligam/desligam a variável quando a esquerda está ON; de transição positiva/negativa deixam a
 * variável ON por uma avaliação na borda da esquerda. Toda bobina passa a esquerda para a direita.
 * Tabela 18: bloco com EN só executa com EN = TRUE e ENO o acompanha; sem EN executa sempre.
 * Tabela 73: salto (condicional pelo estado da linha, incondicional na barra) e retorno.
 *
 * Avaliação (8.1.7 e 8.2.7): redes de cima para baixo; dentro da rede nenhum elemento é avaliado
 * antes das suas entradas, aqui coluna a coluna da esquerda para a direita e, na coluna, de cima
 * para baixo. Cada elemento grava seu estado de saída numa variável própria (`__LD_<rede>_<linha>_
 * <coluna>`): o estado de uma ligação é o do momento em que o elemento foi avaliado, e o monitor
 * mostra o fluxo de energia. Saltos e retornos agem depois que a rede inteira foi avaliada; com
 * saltos, as redes viram uma máquina de estados (`WHILE`/`CASE`), porque ST não tem GOTO.
 */

import { IEC_STANDARD_FUNCTIONS, IEC_STANDARD_FUNCTION_BLOCKS } from "./iecStandardLibrary";
import { LdCell, LdRung, PouDefinition } from "./iecProject";
import { IlContext, literalType, variablePathType } from "./ilLowering";

export interface LdElement {
  id: string;
  label: string;
}

export interface LdDiagnostic {
  severity: "error" | "warning";
  element?: LdElement;
  message: string;
}

export interface LdStLine {
  text: string;
  sourceLine: number;
  element?: LdElement;
}

export interface LdLowering {
  declarations: string[];
  lines: LdStLine[];
  diagnostics: LdDiagnostic[];
}

/** Variável com o estado de saída do elemento na posição (rede, linha, coluna), para o monitor. */
export function ldPowerVariable(rungIndex: number, row: number, column: number): string {
  return `__LD_${rungIndex + 1}_${row + 1}_${column + 1}`;
}

export function ldCellId(rung: LdRung, row: number, column: number): string {
  return `${rung.rungId}:${row}:${column}`;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const COMPARE_ST: Record<string, string> = { "=": "=", "<>": "<>", ">": ">", ">=": ">=", "<": "<", "<=": "<=" };

interface BlockSignature {
  kind: "functionBlock" | "function";
  inputs: Array<{ name: string; type: string }>;
  outputs: Array<{ name: string; type: string }>;
  extensible: boolean;
}

/** Interface de um bloco: FB ou função, do projeto ou da biblioteca padrão. A saída de uma função é OUT. */
export function ldBlockSignature(context: IlContext, typeName: string): BlockSignature | undefined {
  const name = typeName.trim().toUpperCase();
  const projectFb = context.functionBlocks.get(name);
  if (projectFb) {
    const members = [...projectFb.entries()];
    return {
      kind: "functionBlock",
      inputs: members.filter(([, member]) => member.direction === "input" || member.direction === "inOut").map(([member, info]) => ({ name: member, type: info.type })),
      outputs: members.filter(([, member]) => member.direction === "output").map(([member, info]) => ({ name: member, type: info.type })),
      extensible: false,
    };
  }
  const standardFb = IEC_STANDARD_FUNCTION_BLOCKS[name];
  if (standardFb) return { kind: "functionBlock", inputs: [...standardFb.inputs, ...standardFb.inouts], outputs: standardFb.outputs, extensible: false };
  const projectFunction = context.functions.get(name);
  if (projectFunction) {
    return { kind: "function", inputs: projectFunction.inputs.map(input => ({ name: input, type: "ANY" })),
      outputs: [{ name: "OUT", type: projectFunction.returnType }], extensible: false };
  }
  const standardFunction = IEC_STANDARD_FUNCTIONS[name];
  if (standardFunction) {
    return { kind: "function", inputs: standardFunction.parameters, outputs: [{ name: "OUT", type: standardFunction.returnType }],
      extensible: standardFunction.minArgs !== undefined };
  }
  const conversion = /^([A-Z_]+)_TO_([A-Z_]+)$/.exec(name);
  if (conversion) return { kind: "function", inputs: [{ name: "IN", type: conversion[1]! }], outputs: [{ name: "OUT", type: conversion[2]! }], extensible: false };
  return undefined;
}

function cellLabel(rungIndex: number, row: number, column: number): string {
  return `rede ${rungIndex + 1}, linha ${row + 1}, coluna ${column + 1}`;
}

interface LdJump {
  flag: string;
  label: string;
  element: LdElement;
}

class LdGenerator {
  readonly diagnostics: LdDiagnostic[] = [];
  readonly declarations = new Map<string, string>();
  private readonly blocks: Array<{ lines: LdStLine[]; label?: string; jumps: LdJump[] }> = [];
  private readonly labels = new Map<string, number>();
  private readonly inputVariables: Set<string>;

  constructor(private readonly pou: PouDefinition, private readonly rungs: LdRung[], private readonly context: IlContext, private readonly generate: boolean) {
    this.inputVariables = new Set(pou.interface.variables.filter(variable => variable.class === "input").map(variable => variable.name.toUpperCase()));
  }

  private error(message: string, element?: LdElement, severity: "error" | "warning" = "error"): void {
    this.diagnostics.push({ severity, message, ...(element ? { element } : {}) });
  }

  private boolVariable(text: string, element: LdElement, what: string): string | undefined {
    const name = (text ?? "").trim();
    if (!name) { this.error(`${what} sem variável`, element); return undefined; }
    if (literalType(name)) { this.error(`${what} precisa de uma variável BOOL, não de um literal`, element); return undefined; }
    const type = variablePathType(this.context, name);
    if (!type) { this.error(`variável não declarada: ${name}`, element); return undefined; }
    if (type !== "BOOL") { this.error(`${what} precisa de uma variável BOOL: ${name} é ${type}`, element); return undefined; }
    return name;
  }

  private operand(text: string, element: LdElement, what: string): string | undefined {
    const value = (text ?? "").trim();
    if (!value) { this.error(`${what} vazio`, element); return undefined; }
    if (literalType(value)) return value;
    if (!/^[A-Za-z_]/.test(value)) { this.error(`${what} inválido: ${value}`, element); return undefined; }
    if (!variablePathType(this.context, value)) { this.error(`variável não declarada: ${value}`, element); return undefined; }
    return value;
  }

  private block(cell: Extract<LdCell, { kind: "block" }>, input: string, temp: string, element: LdElement, out: (text: string) => void): void {
    const signature = ldBlockSignature(this.context, cell.typeName);
    if (!signature) { this.error(`bloco desconhecido: ${cell.typeName || "(sem tipo)"}`, element); return; }
    const typeName = cell.typeName.trim().toUpperCase();
    const powerInput = (cell.powerInput || "EN").toUpperCase();
    const powerOutput = (cell.powerOutput || "ENO").toUpperCase();
    const inputs = new Map(Object.entries(cell.inputs ?? {}).map(([name, value]) => [name.toUpperCase(), String(value ?? "").trim()]));
    const outputs = new Map(Object.entries(cell.outputs ?? {}).map(([name, value]) => [name.toUpperCase(), String(value ?? "").trim()]));
    const isInput = (name: string) => signature.inputs.some(item => item.name === name) || (signature.extensible && /^IN\d+$/.test(name));
    if (powerInput !== "EN") {
      const declared = signature.inputs.find(item => item.name === powerInput);
      if (!declared) { this.error(`${typeName} não tem a entrada ${powerInput}`, element); return; }
      if (declared.type !== "BOOL" && !declared.type.startsWith("ANY")) { this.error(`a entrada ligada ao degrau precisa ser BOOL: ${powerInput} é ${declared.type}`, element); return; }
    }
    if (powerOutput !== "ENO") {
      const declared = signature.outputs.find(item => item.name === powerOutput);
      if (!declared) { this.error(`${typeName} não tem a saída ${powerOutput}`, element); return; }
      if (declared.type !== "BOOL" && !declared.type.startsWith("ANY")) { this.error(`a saída ligada ao degrau precisa ser BOOL: ${powerOutput} é ${declared.type}`, element); return; }
    }
    for (const [name, value] of inputs) {
      if (!value) continue;
      if (!isInput(name)) { this.error(`${typeName} não tem a entrada ${name}`, element); return; }
      if (name === powerInput) { this.error(`a entrada ${name} já está ligada ao degrau`, element); return; }
      if (!this.operand(value, element, `entrada ${name}`)) return;
    }
    for (const [name, value] of outputs) {
      if (!value) continue;
      if (!signature.outputs.some(item => item.name === name)) { this.error(`${typeName} não tem a saída ${name}`, element); return; }
      const type = variablePathType(this.context, value);
      if (!type) { this.error(`variável não declarada: ${value}`, element); return; }
      if (this.inputVariables.has(value.toUpperCase())) { this.error(`a saída ${name} não pode escrever na entrada ${value}`, element); return; }
    }
    const en = powerInput === "EN";

    if (signature.kind === "functionBlock") {
      const instance = (cell.instanceName ?? "").trim();
      if (!instance) { this.error(`o bloco ${typeName} precisa do nome da instância`, element); return; }
      if (variablePathType(this.context, instance) !== typeName) { this.error(`${instance} não é uma instância declarada de ${typeName}`, element); return; }
      const args = [...inputs].filter(([, value]) => value).map(([name, value]) => `${name} := ${value}`);
      if (!en) args.unshift(`${powerInput} := ${input}`);
      const call = `${instance}(${args.join(", ")});`;
      const assigns = [...outputs].filter(([, value]) => value).map(([name, value]) => `${value} := ${instance}.${name};`);
      if (en) {
        out(`IF ${input} THEN ${[call, ...assigns].join(" ")} END_IF;`);
        out(`${temp} := ${powerOutput === "ENO" ? input : `(${input}) AND ${instance}.${powerOutput}`};`);
      } else {
        out(call);
        for (const assign of assigns) out(assign);
        out(`${temp} := ${powerOutput === "ENO" ? "TRUE" : `${instance}.${powerOutput}`};`);
      }
      return;
    }

    // Função: argumentos na ordem dos parâmetros; nas extensíveis, IN1, IN2, IN3...
    const names = signature.inputs.map(item => item.name);
    if (signature.extensible) {
      const extra = [...inputs.keys(), ...(en ? [] : [powerInput])].filter(name => /^IN\d+$/.test(name) && !names.includes(name))
        .sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
      names.push(...extra);
    }
    const args: string[] = [];
    for (const name of names) {
      const value = !en && name === powerInput ? input : inputs.get(name);
      if (!value) { this.error(`falta a entrada ${name} de ${typeName}`, element); return; }
      args.push(value);
    }
    const call = `${typeName}(${args.join(", ")})`;
    const target = outputs.get("OUT");
    if (powerOutput === "OUT") {
      out(en ? `IF ${input} THEN ${temp} := ${call}; ELSE ${temp} := FALSE; END_IF;` : `${temp} := ${call};`);
      if (target) out(en ? `IF ${input} THEN ${target} := ${temp}; END_IF;` : `${target} := ${temp};`);
      return;
    }
    if (!target) { this.error(`a saída de ${typeName} precisa de uma variável`, element); return; }
    out(en ? `IF ${input} THEN ${target} := ${call}; END_IF;` : `${target} := ${call};`);
    out(`${temp} := ${en ? input : "TRUE"};`);
  }

  private rung(rung: LdRung, rungIndex: number): void {
    const lines: LdStLine[] = [];
    const rungElement: LdElement = { id: rung.rungId, label: `rede ${rungIndex + 1}` };
    const emit = (element: LdElement) => (text: string): void => { lines.push({ text, sourceLine: 1, element }); };
    if (rung.comment?.trim()) lines.push({ text: `(* ${rung.comment.trim().replace(/\*\)/g, "* )")} *)`, sourceLine: 1, element: rungElement });
    const rows = rung.rows ?? [];
    const columns = Math.max(0, ...rows.map(row => row.length));
    const jumps: LdJump[] = [];
    const returns: string[] = [];
    let incoming: Array<string | undefined> = rows.map(() => "TRUE");
    const verticals = rung.verticals ?? [];
    for (const link of verticals) {
      if (!(link.row >= 0 && link.row + 1 < rows.length && link.column >= 0 && link.column < columns)) {
        this.error("ligação vertical fora da grade", rungElement);
      }
    }
    for (let column = 0; column < columns; column += 1) {
      const outputs: Array<string | undefined> = rows.map(() => undefined);
      for (let row = 0; row < rows.length; row += 1) {
        const cell = rows[row]![column];
        if (!cell) continue;
        const element: LdElement = { id: ldCellId(rung, row, column), label: cellLabel(rungIndex, row, column) };
        const input = column === 0 ? "TRUE" : incoming[row];
        if (input === undefined) { this.error("elemento sem ligação à esquerda (nem pela linha, nem por uma ligação vertical)", element); continue; }
        const temp = ldPowerVariable(rungIndex, row, column);
        this.declarations.set(temp, "BOOL");
        const out = emit(element);
        // Mesmo com erro o elemento conta como ligado: o vizinho da direita não ganha um erro falso.
        outputs[row] = temp;
        switch (cell.kind) {
          case "wire":
            out(`${temp} := ${input};`);
            break;
          case "contact": {
            const variable = this.boolVariable(cell.variable, element, "contato");
            if (!variable) continue;
            if (cell.contact === "no") out(`${temp} := (${input}) AND ${variable};`);
            else if (cell.contact === "nc") out(`${temp} := (${input}) AND NOT ${variable};`);
            else if (cell.contact === "p" || cell.contact === "n") {
              const edge = `__LD_E_${rungIndex + 1}_${row + 1}_${column + 1}`;
              this.declarations.set(edge, cell.contact === "p" ? "R_TRIG" : "F_TRIG");
              out(`${edge}(CLK := ${variable});`);
              out(`${temp} := (${input}) AND ${edge}.Q;`);
            } else { this.error(`tipo de contato inválido: ${String(cell.contact)}`, element); continue; }
            break;
          }
          case "compare": {
            const operator = COMPARE_ST[cell.operator];
            if (!operator) { this.error(`operador de comparação inválido: ${String(cell.operator)}`, element); continue; }
            const left = this.operand(cell.left, element, "operando esquerdo");
            const right = this.operand(cell.right, element, "operando direito");
            if (!left || !right) continue;
            if (cell.dataType?.trim()) {
              // Contato tipado (5a): os dois operandos são do tipo indicado.
              const wanted = cell.dataType.trim().toUpperCase();
              const reals = ["REAL", "LREAL"];
              for (const operand of [left, right]) {
                const type = literalType(operand) ?? variablePathType(this.context, operand);
                // Literal inteiro serve para qualquer tipo numérico; literal real só para REAL/LREAL.
                const fits = !type || type === wanted || type === "ANY_INT" || (type === "ANY_REAL" && reals.includes(wanted));
                if (!fits) this.error(`contato de comparação ${wanted}: ${operand} é ${type}`, element);
              }
            }
            out(`${temp} := (${input}) AND (${left} ${operator} ${right});`);
            break;
          }
          case "coil": {
            const variable = this.boolVariable(cell.variable, element, "bobina");
            if (!variable) continue;
            if (this.inputVariables.has(variable.toUpperCase())) { this.error(`bobina não pode escrever na entrada ${variable}`, element); continue; }
            out(`${temp} := ${input};`);
            if (cell.coil === "coil") out(`${variable} := ${temp};`);
            else if (cell.coil === "negated") out(`${variable} := NOT ${temp};`);
            else if (cell.coil === "set") out(`IF ${temp} THEN ${variable} := TRUE; END_IF;`);
            else if (cell.coil === "reset") out(`IF ${temp} THEN ${variable} := FALSE; END_IF;`);
            else if (cell.coil === "p" || cell.coil === "n") {
              const edge = `__LD_E_${rungIndex + 1}_${row + 1}_${column + 1}`;
              this.declarations.set(edge, cell.coil === "p" ? "R_TRIG" : "F_TRIG");
              out(`${edge}(CLK := ${temp});`);
              out(`${variable} := ${edge}.Q;`);
            } else { this.error(`tipo de bobina inválido: ${String(cell.coil)}`, element); continue; }
            break;
          }
          case "block":
            this.block(cell, input, temp, element, out);
            break;
          case "jump": {
            const label = (cell.label ?? "").trim().toUpperCase();
            if (!IDENTIFIER.test(label)) { this.error("salto sem rótulo de destino", element); continue; }
            out(`${temp} := ${input};`);
            jumps.push({ flag: temp, label, element });
            outputs[row] = undefined; // elemento terminal: nada à direita
            continue;
          }
          case "return":
            out(`${temp} := ${input};`);
            returns.push(temp);
            outputs[row] = undefined;
            continue;
          default:
            this.error("elemento desconhecido", element);
            continue;
        }
      }
      // Ligações verticais na borda direita desta coluna: OU das saídas das linhas unidas.
      const group = rows.map((_, index) => index);
      const find = (index: number): number => (group[index] === index ? index : (group[index] = find(group[index]!)));
      for (const link of verticals) {
        if (link.column !== column || link.row < 0 || link.row + 1 >= rows.length) continue;
        group[find(link.row + 1)] = find(link.row);
      }
      const next: Array<string | undefined> = rows.map(() => undefined);
      for (let row = 0; row < rows.length; row += 1) {
        const members = rows.map((_, index) => index).filter(index => find(index) === find(row));
        const sources = members.map(index => outputs[index]).filter((value): value is string => value !== undefined);
        next[row] = sources.length === 0 ? undefined : sources.length === 1 ? sources[0] : sources.join(" OR ");
      }
      incoming = next;
    }
    // Retorno e saltos depois da rede inteira avaliada.
    for (const flag of returns) lines.push({ text: `IF ${flag} THEN RETURN; END_IF;`, sourceLine: 1, element: rungElement });
    this.blocks.push({ lines, jumps, ...(rung.label?.trim() ? { label: rung.label.trim().toUpperCase() } : {}) });
  }

  run(): LdLowering {
    this.rungs.forEach((rung, index) => {
      const label = rung.label?.trim();
      if (label) {
        const element: LdElement = { id: rung.rungId, label: `rede ${index + 1}` };
        if (!IDENTIFIER.test(label)) this.error(`rótulo de rede inválido: ${label}`, element);
        else if (this.labels.has(label.toUpperCase())) this.error(`rótulo de rede repetido: ${label}`, element);
        else this.labels.set(label.toUpperCase(), index);
      }
    });
    this.rungs.forEach((rung, index) => this.rung(rung, index));
    const allJumps = this.blocks.flatMap(block => block.jumps);
    for (const jump of allJumps) {
      if (!this.labels.has(jump.label)) this.error(`rótulo não encontrado: ${jump.label}`, jump.element);
    }
    const declarations = [...this.declarations].map(([name, type]) => `  ${name} : ${type};`);
    if (!this.generate || this.diagnostics.some(item => item.severity === "error")) return { declarations: [], lines: [], diagnostics: this.diagnostics };
    if (allJumps.length === 0) return { declarations, lines: this.blocks.flatMap(block => block.lines), diagnostics: this.diagnostics };

    // Com saltos: uma rede por estado.
    declarations.push("  __LD_PC : DINT;");
    const lines: LdStLine[] = [{ text: "__LD_PC := 0;", sourceLine: 1 }, { text: "WHILE __LD_PC >= 0 DO", sourceLine: 1 }, { text: "  CASE __LD_PC OF", sourceLine: 1 }];
    this.blocks.forEach((block, index) => {
      const next = index + 1 < this.blocks.length ? index + 1 : -1;
      lines.push({ text: `    ${index}:${block.label ? ` (* ${block.label} *)` : ""}`, sourceLine: 1 });
      for (const line of block.lines) lines.push({ ...line, text: `      ${line.text}` });
      const jumps = block.jumps;
      if (jumps.length === 0) lines.push({ text: `      __LD_PC := ${next};`, sourceLine: 1 });
      else {
        const branches = jumps.map((jump, position) => `${position === 0 ? "IF" : "ELSIF"} ${jump.flag} THEN __LD_PC := ${this.labels.get(jump.label)};`);
        lines.push({ text: `      ${branches.join(" ")} ELSE __LD_PC := ${next}; END_IF;`, sourceLine: 1, element: jumps[0]!.element });
      }
    });
    lines.push({ text: "  ELSE", sourceLine: 1 }, { text: "    __LD_PC := -1;", sourceLine: 1 }, { text: "  END_CASE;", sourceLine: 1 }, { text: "END_WHILE;", sourceLine: 1 });
    return { declarations, lines, diagnostics: this.diagnostics };
  }
}

function rungsOf(pou: PouDefinition): LdRung[] | undefined {
  return pou.implementation.language === "ld" ? pou.implementation.rungs : undefined;
}

/** Verificações sem gerar código (editor). */
export function validateLd(pou: PouDefinition, context: IlContext): LdDiagnostic[] {
  const rungs = rungsOf(pou);
  return rungs ? new LdGenerator(pou, rungs, context, false).run().diagnostics : [];
}

export function lowerLdToSt(pou: PouDefinition, context: IlContext): LdLowering {
  return new LdGenerator(pou, rungsOf(pou) ?? [], context, true).run();
}
