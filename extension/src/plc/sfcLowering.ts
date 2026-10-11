/*
 * SFC (IEC 61131-3 3ª ed., seção 6.7) -> ST canônico.
 *
 * Elementos: passos (um inicial por rede), transições com condição em expressão ST, divergência e
 * convergência seletivas (vários caminhos a partir de um passo; prioridade da esquerda para a direita
 * ou numerada) e simultâneas (uma transição com vários passos antes ou depois), `PASSO.X`, `PASSO.T`,
 * ações nomeadas (corpo ST ou IL) ou booleanas, com os qualificadores N R S L D P P1 P0 SD DS SL.
 *
 * Controle das ações: o bloco ACTION_CONTROL da norma, uma instância por ação. Cada entrada de
 * qualificador é o OU da atividade dos passos que associam a ação com aquele qualificador; T é a
 * duração. A ação de código executa enquanto A (= Q ou a borda de descida de Q, a última execução)
 * estiver TRUE; a ação booleana recebe Q. `ACAO.Q` e `ACAO.A` podem ser lidos.
 *
 * Regras de evolução (6.7.5): situação inicial = passo inicial; uma transição está habilitada
 * quando todos os passos imediatamente anteriores estão ativos e é transposta quando, habilitada, a
 * condição é TRUE; transpor desativa todos os passos anteriores e ativa todos os seguintes; as
 * transições transponíveis ao mesmo tempo são transpostas juntas; um passo desativado e ativado ao
 * mesmo tempo continua ativo. Divergência seletiva: só a primeira transição (prioridade) de um passo
 * é transposta.
 *
 * Ordem dentro do ciclo, que a norma deixa à implementação: (1) `.T` dos passos ativos; (2) controle
 * e execução das ações da situação atual; (3) avaliação das transições com essa situação e
 * aplicação de todas juntas. Assim cada passo ativado executa suas ações pelo menos uma vez antes de
 * qualquer transição seguinte e há no máximo uma evolução por ciclo (o tempo de transposição nunca
 * é zero).
 */

import { IecVariable, PouDefinition, SFC_QUALIFIERS, SFC_TIMED_QUALIFIERS, SfcAction, SfcActionAssociation, SfcQualifier, SfcStep, SfcTransition, sfcTransitionEnds } from "./iecProject";
import { IlContext, lowerIlToSt } from "./ilLowering";

export interface SfcElement {
  id: string;
  label: string;
}

export interface SfcDiagnostic {
  severity: "error" | "warning";
  element?: SfcElement;
  /** Linha dentro do corpo da ação. */
  line?: number;
  message: string;
}

export interface SfcStLine {
  text: string;
  sourceLine: number;
  element?: SfcElement;
}

export interface SfcLowering {
  declarations: string[];
  lines: SfcStLine[];
  diagnostics: SfcDiagnostic[];
}

/** Nome do FB gerado com o corpo do ACTION_CONTROL da norma (ver actionControlSource). */
export const SFC_ACTION_CONTROL_FB = "__SFC_ACTION_CONTROL";

/** ACTION_CONTROL da IEC 61131-3 (3ª ed.: P1, P0 e a saída A com a última execução). */
export function actionControlSource(): string[] {
  return [
    `FUNCTION_BLOCK ${SFC_ACTION_CONTROL_FB}`,
    "VAR_INPUT",
    "  N : BOOL;", "  R : BOOL;", "  S : BOOL;", "  L : BOOL;", "  D : BOOL;", "  P : BOOL;", "  P1 : BOOL;", "  P0 : BOOL;",
    "  SD : BOOL;", "  DS : BOOL;", "  SL : BOOL;", "  T : TIME;",
    "END_VAR",
    "VAR_OUTPUT",
    "  Q : BOOL;", "  A : BOOL;",
    "END_VAR",
    "VAR",
    "  S_FF : RS;", "  SD_FF : RS;", "  DS_FF : RS;", "  SL_FF : RS;",
    "  L_TMR : TON;", "  D_TMR : TON;", "  SD_TMR : TON;", "  DS_TMR : TON;", "  SL_TMR : TON;",
    "  P_TRIG : R_TRIG;", "  P1_TRIG : R_TRIG;", "  P0_TRIG : F_TRIG;", "  Q_FT : F_TRIG;",
    "END_VAR",
    "S_FF(S := S, R1 := R);",
    "L_TMR(IN := L, PT := T);",
    "D_TMR(IN := D, PT := T);",
    "P_TRIG(CLK := P);",
    "P1_TRIG(CLK := P1);",
    "P0_TRIG(CLK := P0);",
    "SD_FF(S := SD, R1 := R);",
    "SD_TMR(IN := SD_FF.Q1, PT := T);",
    "DS_TMR(IN := DS, PT := T);",
    "DS_FF(S := DS_TMR.Q, R1 := R);",
    "SL_FF(S := SL, R1 := R);",
    "SL_TMR(IN := SL_FF.Q1, PT := T);",
    "Q := NOT R AND (N OR (L AND NOT L_TMR.Q) OR D_TMR.Q OR P_TRIG.Q OR P1_TRIG.Q OR P0_TRIG.Q",
    "     OR S_FF.Q1 OR SD_TMR.Q OR DS_FF.Q1 OR (SL_FF.Q1 AND NOT SL_TMR.Q));",
    "Q_FT(CLK := Q);",
    "A := Q OR Q_FT.Q;",
    "END_FUNCTION_BLOCK",
  ];
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const QUALIFIER_INPUT: Record<SfcQualifier, string> = {
  N: "N", R: "R", S: "S", L: "L", D: "D", P: "P", P1: "P1", P0: "P0", SD: "SD", DS: "DS", SL: "SL",
};

function stepVar(step: SfcStep, suffix: "X" | "T" | "T0" | "XN"): string {
  return `__SFC_${step.name.toUpperCase()}_${suffix}`;
}

function actionInstance(name: string): string {
  return `__SFC_AC_${name.toUpperCase()}`;
}

/** Aplica `fn` só ao texto fora de literais e comentários. */
function mapCode(text: string, fn: (segment: string) => string): string {
  let out = "";
  let plain = "";
  let index = 0;
  const flush = (): void => { out += fn(plain); plain = ""; };
  while (index < text.length) {
    let stop = -1;
    const char = text[index]!;
    if (char === "'" || char === "\"") {
      const end = text.indexOf(char, index + 1);
      stop = end < 0 ? text.length : end + 1;
    } else if (text.startsWith("(*", index)) {
      const end = text.indexOf("*)", index + 2);
      stop = end < 0 ? text.length : end + 2;
    } else if (text.startsWith("//", index)) {
      const end = text.indexOf("\n", index);
      stop = end < 0 ? text.length : end;
    }
    if (stop >= 0) {
      flush();
      out += text.slice(index, stop);
      index = stop;
    } else {
      plain += char;
      index += 1;
    }
  }
  flush();
  return out;
}

interface Names {
  steps: Map<string, SfcStep>;
  actions: Map<string, SfcAction>;
}

/** `PASSO.X`, `PASSO.T`, `ACAO.Q`, `ACAO.A` -> variáveis internas. */
function rewriteReferences(text: string, names: Names): string {
  return mapCode(text, segment => segment.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*([XTQA])\b/gi, (whole, name: string, flag: string) => {
    const upperFlag = flag.toUpperCase();
    const step = names.steps.get(name.toUpperCase());
    if (step && (upperFlag === "X" || upperFlag === "T")) return stepVar(step, upperFlag as "X" | "T");
    if (names.actions.has(name.toUpperCase()) && (upperFlag === "Q" || upperFlag === "A")) return `${actionInstance(name)}.${upperFlag}`;
    return whole;
  }));
}

function writesFlag(text: string, names: Names): string | undefined {
  let found: string | undefined;
  mapCode(text, segment => {
    for (const match of segment.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*([XTQA])\s*:=/gi)) {
      const name = match[1]!.toUpperCase();
      if (names.steps.has(name) || names.actions.has(name)) found ??= `${match[1]}.${match[2]!.toUpperCase()}`;
    }
    return segment;
  });
  return found;
}

function hasWord(text: string, word: string): boolean {
  let found = false;
  mapCode(text, segment => { if (new RegExp(`\\b${word}\\b`, "i").test(segment)) found = true; return segment; });
  return found;
}

function stepLabel(step: SfcStep): SfcElement {
  return { id: step.stepId, label: `passo ${step.name}` };
}

function transitionLabel(transition: SfcTransition, steps: Map<string, SfcStep>): SfcElement {
  const { from, to } = sfcTransitionEnds(transition);
  const name = (ids: string[]) => ids.map(id => steps.get(id)?.name ?? id).join("+");
  return { id: transition.transitionId, label: `transição ${name(from)} → ${name(to)}` };
}

function actionLabel(name: string): SfcElement {
  return { id: `action:${name}`, label: `ação ${name}` };
}

/** Ação efetiva de uma associação (formato antigo vira ação anônima N). */
interface ResolvedAssociation {
  step: SfcStep;
  qualifier: SfcQualifier;
  action: string;
  time?: string;
}

function variableClassMap(pou: PouDefinition): Map<string, IecVariable> {
  return new Map(pou.interface.variables.map(variable => [variable.name.toUpperCase(), variable]));
}

/** Verificações da norma, sem gerar código. Usado pelo editor e pela tradução. */
export function validateSfc(pou: PouDefinition): SfcDiagnostic[] {
  return analyze(pou).diagnostics;
}

interface Analysis {
  diagnostics: SfcDiagnostic[];
  steps: SfcStep[];
  stepsById: Map<string, SfcStep>;
  names: Names;
  actions: SfcAction[];
  associations: ResolvedAssociation[];
  booleanActions: Set<string>;
  transitions: Array<{ transition: SfcTransition; from: SfcStep[]; to: SfcStep[]; order: number }>;
}

function analyze(pou: PouDefinition): Analysis {
  const diagnostics: SfcDiagnostic[] = [];
  const body = pou.implementation;
  const empty: Analysis = { diagnostics, steps: [], stepsById: new Map(), names: { steps: new Map(), actions: new Map() }, actions: [], associations: [], booleanActions: new Set(), transitions: [] };
  if (body.language !== "sfc") return empty;
  if (pou.kind === "function") diagnostics.push({ severity: "error", message: "a norma só permite SFC em PROGRAM e FUNCTION_BLOCK" });
  const variables = variableClassMap(pou);
  const steps = body.steps;
  const stepsById = new Map(steps.map(step => [step.stepId, step]));
  const stepsByName = new Map<string, SfcStep>();
  for (const step of steps) {
    const element = stepLabel(step);
    if (!IDENTIFIER.test(step.name)) diagnostics.push({ severity: "error", element, message: `nome de passo inválido: ${step.name}` });
    const key = step.name.toUpperCase();
    if (stepsByName.has(key)) diagnostics.push({ severity: "error", element, message: `nome de passo repetido: ${step.name}` });
    if (variables.has(key)) diagnostics.push({ severity: "error", element, message: `o passo ${step.name} tem o nome de uma variável` });
    stepsByName.set(key, step);
  }
  if (steps.length === 0) diagnostics.push({ severity: "error", message: "o SFC não tem passos" });
  const initial = steps.filter(step => step.initial);
  if (steps.length > 0 && initial.length !== 1) {
    diagnostics.push({ severity: "error", ...(initial[1] ? { element: stepLabel(initial[1]) } : {}),
      message: `a rede SFC deve ter exatamente um passo inicial (tem ${initial.length})` });
  }

  const actions = body.actions ?? [];
  const actionsByName = new Map<string, SfcAction>();
  for (const action of actions) {
    const element = actionLabel(action.name);
    const key = action.name.toUpperCase();
    if (!IDENTIFIER.test(action.name)) diagnostics.push({ severity: "error", element, message: `nome de ação inválido: ${action.name}` });
    if (actionsByName.has(key)) diagnostics.push({ severity: "error", element, message: `ação repetida: ${action.name}` });
    if (stepsByName.has(key) || variables.has(key)) diagnostics.push({ severity: "error", element, message: `a ação ${action.name} tem o nome de um passo ou variável` });
    if (action.language !== "st" && action.language !== "il") diagnostics.push({ severity: "error", element, message: "corpo da ação em ST ou IL" });
    actionsByName.set(key, action);
  }
  const names: Names = { steps: stepsByName, actions: actionsByName };

  // Associações: ação nomeada, variável BOOL (ação booleana) ou o formato antigo.
  const associations: ResolvedAssociation[] = [];
  const booleanActions = new Set<string>();
  const inlineActions: SfcAction[] = [];
  const timeByAction = new Map<string, string>();
  for (const step of steps) {
    step.actions.forEach((association: SfcActionAssociation, index) => {
      const element = stepLabel(step);
      const qualifier = (association.qualifier ?? "N").toUpperCase() as SfcQualifier;
      if (!SFC_QUALIFIERS.includes(qualifier)) { diagnostics.push({ severity: "error", element, message: `qualificador inválido: ${association.qualifier}` }); return; }
      let action = association.actionName?.trim();
      if (!action && (association.text || association.instanceName)) {
        action = `__SFC_STEP_${step.name.toUpperCase()}_${index + 1}`;
        inlineActions.push({ name: action, language: "st", text: association.text ?? `${association.instanceName}();` });
      }
      if (!action) { diagnostics.push({ severity: "error", element, message: "bloco de ação sem o nome da ação" }); return; }
      const key = action.toUpperCase();
      const variable = variables.get(key);
      if (!actionsByName.has(key) && !action.startsWith("__SFC_STEP_")) {
        if (!variable) { diagnostics.push({ severity: "error", element, message: `ação ou variável BOOL não declarada: ${action}` }); return; }
        if (variable.type.trim().toUpperCase() !== "BOOL") { diagnostics.push({ severity: "error", element, message: `ação booleana precisa de uma variável BOOL: ${action} é ${variable.type}` }); return; }
        // Tabela 56: qualquer variável BOOL declarada em VAR ou VAR_OUTPUT pode ser uma ação.
        if (variable.class !== "local" && variable.class !== "output") {
          diagnostics.push({ severity: "error", element, message: `ação booleana precisa de uma variável de VAR ou VAR_OUTPUT: ${action}` });
          return;
        }
        booleanActions.add(key);
      }
      const time = association.time?.trim();
      if (SFC_TIMED_QUALIFIERS.includes(qualifier)) {
        if (!time) { diagnostics.push({ severity: "error", element, message: `o qualificador ${qualifier} exige uma duração (ex.: T#5s)` }); return; }
        const previous = timeByAction.get(key);
        if (previous !== undefined && previous.toUpperCase() !== time.toUpperCase()) {
          diagnostics.push({ severity: "error", element, message: `a ação ${action} tem durações diferentes (${previous} e ${time}); o ACTION_CONTROL da norma tem uma única entrada T` });
          return;
        }
        timeByAction.set(key, time);
      }
      associations.push({ step, qualifier, action: key, ...(time ? { time } : {}) });
    });
  }
  for (const action of inlineActions) actionsByName.set(action.name.toUpperCase(), action);

  // Transições.
  const transitions: Analysis["transitions"] = [];
  body.transitions.forEach((transition, index) => {
    const element = transitionLabel(transition, stepsById);
    const { from, to } = sfcTransitionEnds(transition);
    const fromSteps = from.map(id => stepsById.get(id));
    const toSteps = to.map(id => stepsById.get(id));
    if (from.length === 0 || to.length === 0) diagnostics.push({ severity: "error", element, message: "a transição precisa de passos antes e depois" });
    if (fromSteps.some(step => !step) || toSteps.some(step => !step)) { diagnostics.push({ severity: "error", element, message: "a transição liga um passo que não existe" }); return; }
    if (new Set(from).size !== from.length || new Set(to).size !== to.length) diagnostics.push({ severity: "error", element, message: "passo repetido na mesma transição" });
    if (!transition.condition?.trim()) diagnostics.push({ severity: "error", element, message: "transição sem condição" });
    else if (writesFlag(transition.condition, names)) diagnostics.push({ severity: "error", element, message: "a condição de transição não pode escrever variáveis" });
    transitions.push({ transition, from: fromSteps as SfcStep[], to: toSteps as SfcStep[], order: index });
  });

  // Passos sem caminho a partir do inicial (rede "inalcançável" na terminologia da norma).
  if (initial.length === 1) {
    const reached = new Set([initial[0]!.stepId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const item of transitions) {
        if (item.from.every(step => reached.has(step.stepId))) {
          for (const step of item.to) if (!reached.has(step.stepId)) { reached.add(step.stepId); changed = true; }
        }
      }
    }
    for (const step of steps) {
      if (!reached.has(step.stepId)) diagnostics.push({ severity: "warning", element: stepLabel(step), message: `o passo ${step.name} nunca é alcançado a partir do passo inicial` });
    }
  }

  for (const action of [...actionsByName.values()]) {
    const element = actionLabel(action.name);
    const flag = writesFlag(action.text, names);
    if (flag) diagnostics.push({ severity: "error", element, message: `${flag} é somente leitura` });
    if (hasWord(action.text, action.language === "il" ? "RET[CN]*" : "RETURN")) {
      diagnostics.push({ severity: "error", element, message: "RETURN/RET dentro de ação ainda não é suportado (sairia do POU inteiro)" });
    }
  }

  return { diagnostics, steps, stepsById, names, actions: [...actionsByName.values()], associations, booleanActions, transitions };
}

export function lowerSfcToSt(pou: PouDefinition, ilContext: IlContext): SfcLowering {
  const analysis = analyze(pou);
  const diagnostics = analysis.diagnostics;
  const lines: SfcStLine[] = [];
  const declarations: string[] = [];
  if (diagnostics.some(item => item.severity === "error")) return { declarations, lines, diagnostics };
  const { steps, names, associations, booleanActions, transitions } = analysis;
  const emit = (text: string, element?: SfcElement, sourceLine = 1): void => { lines.push({ text, sourceLine, ...(element ? { element } : {}) }); };

  // Estado: X (ativo), T (tempo desde a ativação), T0 (instante da ativação), XN (próxima situação).
  declarations.push("  __SFC_NOW : TIME;", "  __SFC_INIT : BOOL := TRUE;");
  for (const step of steps) {
    declarations.push(`  ${stepVar(step, "X")} : BOOL := ${step.initial ? "TRUE" : "FALSE"};`,
      `  ${stepVar(step, "T")} : TIME;`, `  ${stepVar(step, "T0")} : TIME;`, `  ${stepVar(step, "XN")} : BOOL;`);
  }
  const usedActions = [...new Set(associations.map(item => item.action))];
  for (const action of usedActions) declarations.push(`  ${actionInstance(action)} : ${SFC_ACTION_CONTROL_FB};`);

  // (1) tempo dos passos ativos.
  emit("(* SFC: tempo dos passos ativos *)");
  emit("__SFC_NOW := TIME();");
  emit("IF __SFC_INIT THEN");
  for (const step of steps.filter(item => item.initial)) emit(`  ${stepVar(step, "T0")} := __SFC_NOW;`, stepLabel(step));
  emit("  __SFC_INIT := FALSE;");
  emit("END_IF;");
  for (const step of steps) emit(`IF ${stepVar(step, "X")} THEN ${stepVar(step, "T")} := __SFC_NOW - ${stepVar(step, "T0")}; END_IF;`, stepLabel(step));

  // (2) controle das ações (ACTION_CONTROL da norma) e execução.
  const actionsByName = new Map(analysis.actions.map(action => [action.name.toUpperCase(), action]));
  for (const action of usedActions) {
    const element = actionLabel(actionsByName.get(action)?.name ?? action);
    const mine = associations.filter(item => item.action === action);
    const inputs: string[] = [];
    for (const qualifier of SFC_QUALIFIERS) {
      const active = mine.filter(item => item.qualifier === qualifier).map(item => stepVar(item.step, "X"));
      if (active.length > 0) inputs.push(`${QUALIFIER_INPUT[qualifier]} := ${active.join(" OR ")}`);
    }
    const time = mine.find(item => item.time)?.time;
    if (time) inputs.push(`T := ${rewriteReferences(time, names)}`);
    emit(`(* ${element.label} *)`, element);
    emit(`${actionInstance(action)}(${inputs.join(", ")});`, element);
    if (booleanActions.has(action)) {
      emit(`${actionsByName.get(action)?.name ?? action} := ${actionInstance(action)}.Q;`, element);
      continue;
    }
    const code = actionsByName.get(action)!;
    emit(`IF ${actionInstance(action)}.A THEN`, element);
    const text = rewriteReferences(code.text, names);
    if (code.language === "st") {
      text.replace(/\r\n/g, "\n").split("\n").forEach((line, index) => emit(`  ${line.replace(/\s+$/, "")}`, element, index + 1));
    } else {
      const context: IlContext = { ...ilContext, variables: new Map(ilContext.variables) };
      for (const step of steps) {
        context.variables.set(stepVar(step, "X"), "BOOL");
        context.variables.set(stepVar(step, "T"), "TIME");
      }
      for (const name of usedActions) context.variables.set(actionInstance(name), SFC_ACTION_CONTROL_FB);
      context.functionBlocks = new Map(context.functionBlocks);
      context.functionBlocks.set(SFC_ACTION_CONTROL_FB, new Map([["Q", { type: "BOOL", direction: "output" }], ["A", { type: "BOOL", direction: "output" }]]));
      const lowered = lowerIlToSt(text, context);
      for (const item of lowered.diagnostics) diagnostics.push({ severity: "error", element, line: item.line, message: item.message });
      for (const declaration of lowered.declarations) if (!declarations.includes(declaration)) declarations.push(declaration);
      for (const line of lowered.lines) emit(`  ${line.text}`, element, line.sourceLine);
    }
    emit("END_IF;", element);
  }

  // (3) evolução: transições habilitadas pela situação atual, transpostas todas juntas.
  emit("(* SFC: evolução *)");
  for (const step of steps) emit(`${stepVar(step, "XN")} := ${stepVar(step, "X")};`, stepLabel(step));
  const ordered = [...transitions].sort((a, b) =>
    (a.transition.priority ?? Number.MAX_SAFE_INTEGER) - (b.transition.priority ?? Number.MAX_SAFE_INTEGER) || a.order - b.order);
  // Divergência seletiva: transições do mesmo passo competem; a primeira na ordem que passar
  // reserva o passo (`__SFC_<P>_XN` já FALSE) e as seguintes deixam de estar habilitadas.
  for (const item of ordered) {
    const element = transitionLabel(item.transition, analysis.stepsById);
    const enabled = item.from.map(step => `${stepVar(step, "X")} AND ${stepVar(step, "XN")}`).join(" AND ");
    emit(`IF ${enabled} THEN`, element);
    emit(`  IF ${rewriteReferences(item.transition.condition.trim(), names)} THEN`, element);
    for (const step of item.from) emit(`    ${stepVar(step, "XN")} := FALSE;`, element);
    for (const step of item.to) emit(`    __SFC_ACT_${step.name.toUpperCase()} := TRUE;`, element);
    emit("  END_IF;", element);
    emit("END_IF;", element);
  }
  // Ativação: passo desativado e ativado no mesmo ciclo continua ativo (sem nova ativação).
  for (const step of steps) {
    declarations.push(`  __SFC_ACT_${step.name.toUpperCase()} : BOOL;`);
    emit(`IF __SFC_ACT_${step.name.toUpperCase()} THEN`, stepLabel(step));
    emit(`  IF NOT ${stepVar(step, "X")} THEN ${stepVar(step, "T0")} := __SFC_NOW; ${stepVar(step, "T")} := T#0s; END_IF;`, stepLabel(step));
    emit(`  ${stepVar(step, "XN")} := TRUE;`, stepLabel(step));
    emit(`  __SFC_ACT_${step.name.toUpperCase()} := FALSE;`, stepLabel(step));
    emit("END_IF;", stepLabel(step));
  }
  for (const step of steps) emit(`${stepVar(step, "X")} := ${stepVar(step, "XN")};`, stepLabel(step));
  return { declarations, lines, diagnostics };
}
