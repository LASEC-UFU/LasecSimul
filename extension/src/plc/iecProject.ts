/*
 * Modelo IEC 61131-3 da tradução SFC -> ST (sfcLowering.ts): POU, variáveis, passos, transições e
 * ações. O editor (OpenPLC, projeto .lsplc) guarda o SFC com os mesmos campos
 * (plc/openplc-workspace/overlay/shared/sfc.ts) e openPlcSfc.ts monta este modelo a partir dele.
 */

export type PouKind = "program" | "function" | "functionBlock";
export type VariableClass = "input" | "output" | "inOut" | "local" | "temp" | "external";

export interface IecVariable {
  ioId?: string;
  name: string;
  class: VariableClass;
  type: string;
  initialValue?: string;
  retain?: boolean;
  attributes?: Record<string, string>;
}

export interface PouInterface {
  returnType?: string;
  variables: IecVariable[];
}

/** Qualificadores de ação da IEC 61131-3 3ª ed. (tabela 56). */
export const SFC_QUALIFIERS = ["N", "R", "S", "L", "D", "P", "P1", "P0", "SD", "DS", "SL"] as const;
export type SfcQualifier = typeof SFC_QUALIFIERS[number];
/** Qualificadores que exigem duração. */
export const SFC_TIMED_QUALIFIERS: readonly SfcQualifier[] = ["L", "D", "SD", "DS", "SL"];

/** Bloco de ação de um passo: qualificador, ação e (L, D, SD, DS, SL) a duração. */
export interface SfcActionAssociation {
  actionId: string;
  /** Ausente = N. */
  qualifier?: SfcQualifier;
  /** Ação nomeada do POU (`actions`) ou variável BOOL (ação booleana: recebe o Q da ação). */
  actionName?: string;
  /** Duração: literal TIME (T#5s) ou variável TIME. */
  time?: string;
  /** Variável indicadora (documentação do bloco de ação). */
  indicator?: string;
  /** Código ST no próprio passo, ou chamada de uma instância de FB. */
  text?: string;
  referencedPouId?: string;
  instanceName?: string;
}

/** Ação nomeada com corpo em ST ou IL (executada enquanto o Q do controle da ação estiver TRUE e
 * uma última vez quando ele cai). */
export interface SfcAction {
  name: string;
  language: "st" | "il";
  text: string;
}

export interface SfcStep {
  stepId: string;
  name: string;
  initial?: boolean;
  actions: SfcActionAssociation[];
}

export interface SfcTransition {
  transitionId: string;
  /** Passos antes; mais de um = convergência simultânea (todos ativos). */
  fromStepIds?: string[];
  /** Passos depois; mais de um = divergência simultânea (todos ativados juntos). */
  toStepIds?: string[];
  /** Um passo de cada lado. */
  fromStepId?: string;
  toStepId?: string;
  /** Expressão ST BOOL; pode usar `PASSO.X` e `PASSO.T`. */
  condition: string;
  /** Divergência seletiva: menor número avaliada primeiro; sem número, a ordem da lista. */
  priority?: number;
}

export function sfcTransitionEnds(transition: SfcTransition): { from: string[]; to: string[] } {
  return {
    from: transition.fromStepIds ?? (transition.fromStepId ? [transition.fromStepId] : []),
    to: transition.toStepIds ?? (transition.toStepId ? [transition.toStepId] : []),
  };
}

export type PouBody =
  | { language: "st" | "il"; text: string }
  | { language: "sfc"; steps: SfcStep[]; transitions: SfcTransition[]; actions?: SfcAction[] };

export interface PouDefinition {
  pouId: string;
  name: string;
  kind: PouKind;
  interface: PouInterface;
  implementation: PouBody;
}
