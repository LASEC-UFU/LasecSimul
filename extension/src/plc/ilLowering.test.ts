import { strict as assert } from "assert";
import { IlContext, lowerIlToSt, parseIl, splitTopLevel, stripIlComments } from "./ilLowering";

function context(variables: Record<string, string>, extra: Partial<IlContext> = {}): IlContext {
  return {
    pouName: "MAIN",
    pouKind: "program",
    variables: new Map(Object.entries(variables).map(([name, type]) => [name.toUpperCase(), type.toUpperCase()])),
    functionBlocks: new Map(),
    functions: new Map(),
    ...extra,
  };
}

function st(text: string, variables: Record<string, string>, extra: Partial<IlContext> = {}): string {
  const lowered = lowerIlToSt(text, context(variables, extra));
  assert.deepEqual(lowered.diagnostics, [], `diagnósticos inesperados: ${JSON.stringify(lowered.diagnostics)}`);
  return lowered.lines.map(line => line.text).join("\n");
}

function errors(text: string, variables: Record<string, string>): string[] {
  return lowerIlToSt(text, context(variables)).diagnostics.map(item => `${item.line}:${item.message}`);
}

function main(): void {
  // Texto: comentários (* *) em várias linhas e //, literais intocados, rótulo sozinho na linha.
  assert.equal(stripIlComments("LD A (* x\ny *) // z\nST 'a//b'"), `LD A     \n${" ".repeat(9)}\nST 'a//b'`);
  assert.deepEqual(splitTopLevel("MN := 0, IN := F(A, B), 'x,y'"), ["MN := 0", "IN := F(A, B)", "'x,y'"]);
  const parsed = parseIl("INICIO:\n  LD A\nFIM: ST Q;\nCAL T1(\n IN := A,\n PT := T#1s\n)\nANDN( B\n)", []);
  assert.deepEqual(parsed.map(item => [item.line, item.label ?? "", item.op, item.negate, item.deferred]), [
    [2, "INICIO", "LD", false, false], [3, "FIM", "ST", false, false], [4, "", "CAL", false, false], [8, "", "AND", true, true], [9, "", ")", false, false],
  ]);
  assert.equal(parsed[2]!.operand, "T1( IN := A, PT := T#1s )", "CAL formal em várias linhas vira uma instrução");

  // Sem saltos: código em linha reta, sem máquina de estados.
  const straight = st("LD A\nAND( B\nOR C\n)\nST Q", { A: "BOOL", B: "BOOL", C: "BOOL", Q: "BOOL" });
  assert.doesNotMatch(straight, /__IL_PC/);
  assert.match(straight, /__IL_S1_BOOL := A;/, "lado esquerdo do ( guardado na temporária do nível");
  assert.match(straight, /Q := \(__IL_S1_BOOL\) AND \(\(B\) OR \(C\)\);/);

  // Escrita depois de ST: o CR que depende do destino é copiado antes do R.
  const reset = st("LD A\nST Q\nR Q\nST P", { A: "BOOL", Q: "BOOL", P: "BOOL" });
  assert.match(reset, /Q := A;\n__IL_CR_BOOL := Q;\nIF __IL_CR_BOOL THEN Q := FALSE; END_IF;\nP := __IL_CR_BOOL;/);

  // Literal genérico assume o tipo do outro operando; comparação dá BOOL.
  assert.match(st("LD 5\nADD N\nST N", { N: "INT" }), /N := \(5\) \+ \(N\);/);
  assert.match(st("LD N\nGT 3\nST B", { N: "INT", B: "BOOL" }), /B := \(N\) > \(3\);/);

  // Funções: CR como primeiro argumento, retorno pelo genérico (SEL segue IN0/IN1, não G).
  assert.match(st("LD G\nSEL X, Y\nST R", { G: "BOOL", X: "REAL", Y: "REAL", R: "REAL" }), /R := SEL\(G, X, Y\);/);
  assert.match(st("LD N\nINT_TO_REAL\nST R", { N: "INT", R: "REAL" }), /R := INT_TO_REAL\(N\);/);

  // Operadores de entrada de FB e CAL condicional.
  const fb = st("LD A\nIN T1\nLD T#2s\nPT T1\nLD C1.Q\nCALCN C1(CU := A)", { A: "BOOL", T1: "TON", C1: "CTU" });
  assert.match(fb, /T1\(IN := __IL_CR_BOOL\);/);
  assert.match(fb, /T1\(PT := T#2s\);/);
  assert.match(fb, /IF NOT __IL_CR_BOOL THEN C1\(CU := A\); END_IF;/);
  assert.match(st("LD A\nR C1", { A: "BOOL", C1: "CTU" }), /C1\(R := __IL_CR_BOOL\);/, "R com operando CTU é a entrada R");

  // Saltos: máquina de estados com rótulos resolvidos.
  const loop = st("LD 0\nST ACC\nL1: LD ACC\nADD 1\nST ACC\nLT 10\nJMPC L1\nLD ACC\nST Q", { ACC: "INT", Q: "INT" });
  assert.match(loop, /WHILE __IL_PC >= 0 DO/);
  assert.match(loop, /IF __IL_CR_BOOL THEN __IL_PC := 1; ELSE __IL_PC := 2; END_IF;/);
  const lowered = lowerIlToSt("LD 0\nST ACC\nL1: LD ACC\nADD 1\nST ACC\nLT 10\nJMPC L1", context({ ACC: "INT" }));
  assert.ok(lowered.declarations.some(line => line.includes("__IL_PC : DINT")));
  assert.ok(lowered.lines.find(line => line.text.includes("THEN __IL_PC := 1;"))?.sourceLine === 7,
    "o salto aponta para a linha do JMPC no texto IL");

  // FUNCTION: ST no nome da função define o retorno.
  assert.match(st("LD V\nMUL 2\nST DOUBLE_IT", { V: "INT", DOUBLE_IT: "INT" }, { pouName: "DOUBLE_IT", pouKind: "function" }),
    /__IL_CR_INT := \(V\) \* \(2\);\nDOUBLE_IT := __IL_CR_INT;/, "o nome da FUNCTION recebe o valor, mas não vira o CR");

  // Diagnósticos com a linha do texto IL.
  assert.deepEqual(errors("LD A\nAND X\nFOO A\nJMP NADA\n)\nST 3", { A: "BOOL" }).map(item => item.split(":")[0]),
    ["2", "3", "5", "6", "4"]);
  assert.match(errors("ST Q", { Q: "BOOL" })[0]!, /^1:ST sem resultado corrente/);
  assert.match(errors("LD N\nJMPC L\nL: ST N", { N: "INT" })[0]!, /^2:JMPC exige resultado corrente BOOL/);
  assert.match(errors("LD A\nAND( B\nST A\n)", { A: "BOOL", B: "BOOL" })[0]!, /^3:ST não é permitido dentro de parênteses/);
  assert.match(errors("LD A\nIN A", { A: "BOOL" })[0]!, /não é uma instância de bloco de função com a entrada IN/);
  assert.match(errors("LD A\nAND( B", { A: "BOOL", B: "BOOL" })[0]!, /^2:AND\( sem o "\)"/);

  console.log("IL lowering (IEC 61131-3 ed. 3: CR tipado, N/C/(, rótulos/JMP, CAL, operadores de entrada, funções, diagnósticos): OK");
}

try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
