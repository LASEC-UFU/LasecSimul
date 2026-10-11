import { strict as assert } from "assert";
import { LdCell, LdRung, PouDefinition } from "./iecProject";
import { IlContext } from "./ilLowering";
import { ldBlockSignature, ldPowerVariable, lowerLdToSt, validateLd } from "./ldLowering";

const contact = (variable: string, kind: "no" | "nc" | "p" | "n" = "no"): LdCell => ({ kind: "contact", contact: kind, variable });
const coil = (variable: string, kind: "coil" | "negated" | "set" | "reset" | "p" | "n" = "coil"): LdCell => ({ kind: "coil", coil: kind, variable });

function rung(id: string, rows: Array<Array<LdCell | null>>, verticals: Array<[number, number]> = [], label?: string): LdRung {
  return { rungId: id, rows, verticals: verticals.map(([row, column]) => ({ row, column })), ...(label ? { label } : {}) };
}

function pou(rungs: LdRung[]): PouDefinition {
  return { pouId: "p", name: "MAIN", kind: "program", interface: { variables: [
    { ioId: "A", name: "A", class: "input", type: "BOOL" }, { ioId: "B", name: "B", class: "input", type: "BOOL" },
    { ioId: "N", name: "N", class: "input", type: "INT" }, { ioId: "Q", name: "Q", class: "output", type: "BOOL" },
    { ioId: "M", name: "M", class: "output", type: "INT" }, { name: "T1", class: "local", type: "TON" },
  ] }, implementation: { language: "ld", networks: [], rungs } };
}

const context: IlContext = { pouName: "MAIN", pouKind: "program",
  variables: new Map([["A", "BOOL"], ["B", "BOOL"], ["N", "INT"], ["Q", "BOOL"], ["M", "INT"], ["T1", "TON"]]), functionBlocks: new Map(), functions: new Map() };

function st(rungs: LdRung[]): string {
  const lowered = lowerLdToSt(pou(rungs), context);
  assert.deepEqual(lowered.diagnostics, [], JSON.stringify(lowered.diagnostics));
  return lowered.lines.map(line => line.text).join("\n");
}

function errors(rungs: LdRung[]): string[] {
  return validateLd(pou(rungs), context).map(item => `${item.element?.label ?? ""}: ${item.message}`);
}

function main(): void {
  assert.equal(ldPowerVariable(0, 0, 0), "__LD_1_1_1");

  // Tabela 74: barra esquerda = TRUE; ligação horizontal passa o estado; vertical = OU.
  const series = st([rung("r1", [[contact("A"), contact("B", "nc"), coil("Q")]])]);
  assert.equal(series, "__LD_1_1_1 := (TRUE) AND A;\n__LD_1_1_2 := (__LD_1_1_1) AND NOT B;\n__LD_1_1_3 := __LD_1_1_2;\nQ := __LD_1_1_3;");
  const parallel = st([rung("r1", [[contact("A"), coil("Q")], [contact("B"), null]], [[0, 0]])]);
  assert.match(parallel, /__LD_1_1_2 := __LD_1_1_1 OR __LD_1_2_1;\nQ := __LD_1_1_2;/, "ligação vertical: OU das linhas unidas");

  // Tabela 76: negada, set, reset, transição; toda bobina passa a esquerda para a direita.
  const coils = st([rung("r1", [[contact("A"), coil("Q", "negated"), coil("Q", "set"), coil("Q", "reset"), coil("Q", "p"), coil("Q", "n")]])]);
  assert.match(coils, /Q := NOT __LD_1_1_2;/);
  assert.match(coils, /__LD_1_1_3 := __LD_1_1_2;\nIF __LD_1_1_3 THEN Q := TRUE; END_IF;/);
  assert.match(coils, /IF __LD_1_1_4 THEN Q := FALSE; END_IF;/);
  assert.match(coils, /__LD_E_1_1_5\(CLK := __LD_1_1_5\);\nQ := __LD_E_1_1_5\.Q;/);
  assert.match(coils, /__LD_E_1_1_6\(CLK := __LD_1_1_6\);\nQ := __LD_E_1_1_6\.Q;/);
  const coilDeclarations = lowerLdToSt(pou([rung("r1", [[contact("A", "p"), coil("Q", "n")]])]), context).declarations.join("\n");
  assert.match(coilDeclarations, /__LD_E_1_1_1 : R_TRIG;/);
  assert.match(coilDeclarations, /__LD_E_1_1_2 : F_TRIG;/);

  // Tabela 75: transição avaliada todo ciclo, conduz com a esquerda ON; comparação.
  assert.match(st([rung("r1", [[contact("B"), contact("A", "p"), coil("Q")]])]), /__LD_E_1_1_2\(CLK := A\);\n__LD_1_1_2 := \(__LD_1_1_1\) AND __LD_E_1_1_2\.Q;/);
  assert.match(st([rung("r1", [[{ kind: "compare", operator: "<>", left: "N", right: "3" }, coil("Q")]])]), /__LD_1_1_1 := \(TRUE\) AND \(N <> 3\);/);

  // Tabela 18: EN/ENO; FB ligado ao degrau por entrada/saída BOOL; função BOOL como saída.
  const blocks = st([
    rung("r1", [[contact("A"), { kind: "block", typeName: "ADD", powerInput: "EN", powerOutput: "ENO", inputs: { IN1: "M", IN2: "1", IN3: "N" }, outputs: { OUT: "M" } }, coil("Q")]]),
    rung("r2", [[contact("A"), { kind: "block", typeName: "TON", instanceName: "T1", powerInput: "IN", powerOutput: "Q", inputs: { PT: "T#1s" }, outputs: {} }, coil("Q")]]),
    rung("r3", [[{ kind: "block", typeName: "GT", powerInput: "EN", powerOutput: "OUT", inputs: { IN1: "N", IN2: "2" }, outputs: {} }, coil("Q")]]),
  ]);
  assert.match(blocks, /IF __LD_1_1_1 THEN M := ADD\(M, 1, N\); END_IF;\n__LD_1_1_2 := __LD_1_1_1;/, "função extensível com EN; ENO acompanha EN");
  assert.match(blocks, /T1\(IN := __LD_2_1_1, PT := T#1s\);\n__LD_2_1_2 := T1\.Q;/);
  assert.match(blocks, /IF TRUE THEN __LD_3_1_1 := GT\(N, 2\); ELSE __LD_3_1_1 := FALSE; END_IF;/);
  assert.equal(ldBlockSignature(context, "CTU")?.inputs.map(pin => pin.name).join(","), "CU,R,PV");
  assert.equal(ldBlockSignature(context, "INT_TO_REAL")?.outputs[0]?.type, "REAL");

  // Tabela 73: sem saltos, linha reta; com saltos, uma rede por estado; retorno depois da rede.
  assert.doesNotMatch(series, /__LD_PC/);
  const jumps = st([
    rung("r1", [[contact("A"), { kind: "jump", label: "fim" }]]),
    rung("r2", [[coil("Q")]]),
    rung("r3", [[contact("B"), { kind: "return" }]], [], "FIM"),
  ]);
  assert.match(jumps, /IF __LD_1_1_2 THEN __LD_PC := 2; ELSE __LD_PC := 1; END_IF;/);
  assert.match(jumps, /2: \(\* FIM \*\)\n {6}__LD_3_1_1 := \(TRUE\) AND B;\n {6}__LD_3_1_2 := __LD_3_1_1;\n {6}IF __LD_3_1_2 THEN RETURN; END_IF;/);

  // Verificações.
  assert.deepEqual(errors([rung("r1", [[contact("A"), coil("Q")]])]), []);
  assert.ok(errors([rung("r1", [[contact("A"), null, coil("Q")]])]).some(item => /coluna 3: elemento sem ligação à esquerda/.test(item)));
  assert.ok(errors([rung("r1", [[contact("N"), coil("A")]])]).join("|").match(/contato precisa de uma variável BOOL: N é INT.*bobina não pode escrever na entrada A/));
  assert.ok(errors([rung("r1", [[{ kind: "block", typeName: "TON", powerInput: "IN", powerOutput: "Q", inputs: {}, outputs: {} }]])]).some(item => /precisa do nome da instância/.test(item)));
  assert.ok(errors([rung("r1", [[{ kind: "block", typeName: "TON", instanceName: "T1", powerInput: "PT", powerOutput: "Q", inputs: {}, outputs: {} }]])]).some(item => /entrada ligada ao degrau precisa ser BOOL/.test(item)));
  assert.ok(errors([rung("r1", [[{ kind: "block", typeName: "ADD", powerInput: "EN", powerOutput: "ENO", inputs: { IN1: "M" }, outputs: { OUT: "M" } }]])]).some(item => /falta a entrada IN2 de ADD/.test(item)));
  assert.ok(errors([rung("r1", [[{ kind: "jump", label: "X" }]]), rung("r2", [[coil("Q")]], [], "A1"), rung("r3", [[coil("Q")]], [], "a1")]).join("|").match(/rótulo de rede repetido: a1.*rótulo não encontrado: X/));
  assert.ok(errors([rung("r1", [[{ kind: "compare", operator: ">", left: "N", right: "2.5", dataType: "INT" }, coil("Q")]])]).some(item => /contato de comparação INT: 2\.5 é ANY_REAL/.test(item)));

  console.log("LD lowering (IEC 61131-3 ed. 3: tabelas 73-76 e 18, ligações, ordem de avaliação, verificações): OK");
}

try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
