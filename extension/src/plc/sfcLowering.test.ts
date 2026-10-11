import { strict as assert } from "assert";
import { PouDefinition, SfcAction, SfcStep, SfcTransition } from "./iecProject";
import { IlContext } from "./ilLowering";
import { actionControlSource, lowerSfcToSt, validateSfc } from "./sfcLowering";

function step(name: string, actions: Array<[string, string, string?]> = [], initial = false): SfcStep {
  return { stepId: `s-${name}`, name, ...(initial ? { initial: true } : {}),
    actions: actions.map(([qualifier, actionName, time], index) => ({ actionId: `a${index}`, qualifier: qualifier as never, actionName, ...(time ? { time } : {}) })) };
}

function tr(id: string, from: string[], to: string[], condition: string, priority?: number): SfcTransition {
  return { transitionId: id, fromStepIds: from.map(name => `s-${name}`), toStepIds: to.map(name => `s-${name}`), condition, ...(priority ? { priority } : {}) };
}

function pou(steps: SfcStep[], transitions: SfcTransition[], actions: SfcAction[] = [], kind: PouDefinition["kind"] = "program"): PouDefinition {
  return { pouId: "p", name: "MAIN", kind, interface: { variables: [
    { ioId: "GO", name: "GO", class: "input", type: "BOOL" },
    { ioId: "Q", name: "Q", class: "output", type: "BOOL" },
    { ioId: "N", name: "N", class: "output", type: "INT" },
  ] }, implementation: { language: "sfc", steps, transitions, actions } };
}

const context: IlContext = { pouName: "MAIN", pouKind: "program", variables: new Map([["GO", "BOOL"], ["Q", "BOOL"], ["N", "INT"]]), functionBlocks: new Map(), functions: new Map() };

function messages(definition: PouDefinition): string[] {
  return validateSfc(definition).map(item => `${item.severity}:${item.element?.label ?? ""}:${item.message}`);
}

function main(): void {
  // ACTION_CONTROL da norma (3ª ed.): entradas por qualificador, T, saídas Q e A com F_TRIG.
  const control = actionControlSource().join("\n");
  for (const fragment of ["P1 : BOOL;", "P0 : BOOL;", "T : TIME;", "A : BOOL;", "P0_TRIG : F_TRIG;", "Q := NOT R AND (N OR (L AND NOT L_TMR.Q)", "A := Q OR Q_FT.Q;"]) {
    assert.ok(control.includes(fragment), fragment);
  }

  // Verificações da norma.
  assert.ok(messages(pou([step("A"), step("B")], [tr("t", ["A"], ["B"], "GO")])).some(item => /exatamente um passo inicial \(tem 0\)/.test(item)));
  assert.ok(messages(pou([step("A", [], true), step("B", [], true)], [])).some(item => /exatamente um passo inicial \(tem 2\)/.test(item)));
  assert.ok(messages(pou([step("A", [], true), step("A")], [])).some(item => /nome de passo repetido/.test(item)));
  assert.ok(messages(pou([step("A", [["L", "Q"]], true)], [])).some(item => /L exige uma duração/.test(item)));
  assert.ok(messages(pou([step("A", [["L", "Q", "T#1s"]], true), step("B", [["D", "Q", "T#2s"]])], [tr("t", ["A"], ["B"], "GO")]))
    .some(item => /única entrada T/.test(item)), "uma duração por ação (entrada T do ACTION_CONTROL)");
  assert.ok(messages(pou([step("A", [["N", "GO"]], true)], [])).some(item => /precisa de uma variável de VAR ou VAR_OUTPUT: GO/.test(item)));
  assert.ok(messages(pou([step("A", [["N", "N"]], true)], [])).some(item => /precisa de uma variável BOOL/.test(item)));
  assert.ok(messages(pou([step("A", [], true), step("B")], [tr("t", ["A"], ["B"], "")])).some(item => /transição A → B:transição sem condição/.test(item)));
  assert.ok(messages(pou([step("A", [], true), step("B")], [])).some(item => /^warning:passo B:.*nunca é alcançado/.test(item)));
  assert.ok(messages(pou([step("A", [], true)], [], [], "function")).some(item => /só permite SFC em PROGRAM e FUNCTION_BLOCK/.test(item)));
  assert.ok(messages(pou([step("A", [["N", "ACT"]], true)], [], [{ name: "ACT", language: "st", text: "A.X := TRUE;" }]))
    .some(item => /A\.X é somente leitura/.test(item)));
  assert.ok(messages(pou([step("A", [["N", "ACT"]], true)], [], [{ name: "ACT", language: "st", text: "IF GO THEN RETURN; END_IF;" }]))
    .some(item => /RETURN\/RET dentro de ação/.test(item)));
  assert.deepEqual(messages(pou([step("A", [["N", "Q"]], true), step("B")], [tr("t", ["A"], ["B"], "GO"), tr("u", ["B"], ["A"], "B.T > T#1s")])), []);

  // ST gerado: uma instância de ACTION_CONTROL por ação, entradas = OU dos passos por qualificador.
  const lowered = lowerSfcToSt(pou(
    [step("A", [["N", "Q"], ["P1", "COUNT"]], true), step("B", [["N", "Q"]]), step("C1"), step("C2"), step("D")],
    [tr("t1", ["A"], ["B"], "GO", 2), tr("t0", ["A"], ["D"], "NOT GO AND MSG = 'A.X'", 1), tr("t2", ["B"], ["C1", "C2"], "TRUE"), tr("t3", ["C1", "C2"], ["A"], "C1.T >= T#1s")],
    [{ name: "COUNT", language: "st", text: "IF COUNT.Q THEN N := N + 1; END_IF;" }]), context);
  assert.deepEqual(lowered.diagnostics.filter(item => item.severity === "error"), []);
  const text = lowered.lines.map(line => line.text).join("\n");
  assert.match(text, /__SFC_AC_Q\(N := __SFC_A_X OR __SFC_B_X\);\nQ := __SFC_AC_Q\.Q;/, "ação booleana N em dois passos");
  assert.match(text, /__SFC_AC_COUNT\(P1 := __SFC_A_X\);\nIF __SFC_AC_COUNT\.A THEN\n {2}IF __SFC_AC_COUNT\.Q THEN/, "ação de código roda com A; COUNT.Q vira a saída Q");
  assert.ok(text.indexOf("NOT GO AND MSG = 'A.X'") < text.indexOf("IF GO THEN"), "prioridade 1 avaliada antes da 2");
  assert.match(text, /'A\.X'/, "texto entre aspas não é reescrito");
  assert.match(text, /IF __SFC_C1_X AND __SFC_C1_XN AND __SFC_C2_X AND __SFC_C2_XN THEN\n {2}IF __SFC_C1_T >= T#1s THEN/, "convergência simultânea exige os dois passos");
  assert.match(text, /__SFC_ACT_C1 := TRUE;\n {4}__SFC_ACT_C2 := TRUE;/, "divergência simultânea ativa os dois");
  assert.ok(lowered.declarations.some(line => line.includes("__SFC_A_X : BOOL := TRUE;")) && lowered.declarations.some(line => line.includes("__SFC_B_X : BOOL := FALSE;")));
  assert.ok(text.indexOf("__SFC_AC_Q(") < text.indexOf("(* SFC: evolução *)"), "ações da situação atual antes da evolução");
  assert.ok(lowered.lines.some(line => line.element?.label === "transição C1+C2 → A"), "linhas sabem de que elemento vieram");

  console.log("SFC lowering (IEC 61131-3 ed. 3: ACTION_CONTROL, verificações, divergências/convergências, prioridade, ordem do ciclo): OK");
}

try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
