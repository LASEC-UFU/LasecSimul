/*
 * IEC 61131-3 authoring model used by all five editors.
 *
 * The interface, references and symbol table are deliberately language-neutral: graphical node
 * positions and textual spelling never become the identity of a POU or public I/O. This is the
 * small, host-independent store consumed by the Webview editors and by the build pipeline.
 */

import type { OpenPlcSystemLibrary } from "./openPlcLibraryTypes";

export const IEC_LANGUAGES = ["ld", "fbd", "st", "sfc", "il"] as const;
export type IecLanguage = typeof IEC_LANGUAGES[number];
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

export interface GraphNode {
  nodeId: string;
  kind: "contact" | "coil" | "block" | "input" | "output" | "operator" | "junction";
  symbol?: string;
  referencedPouId?: string;
  instanceName?: string;
  negated?: boolean;
  /** Operador puro IEC em um diagrama FBD. */
  operator?: FbdOperator;
  x?: number;
  y?: number;
}

export const FBD_OPERATORS = ["AND", "OR", "XOR", "NOT", "ADD", "SUB", "MUL", "DIV", "MOD", "EQ", "NE", "GT", "GE", "LT", "LE", "NEG"] as const;
export type FbdOperator = typeof FBD_OPERATORS[number];

export interface GraphEdge {
  edgeId: string;
  fromNodeId: string;
  fromPort?: string;
  toNodeId: string;
  toPort?: string;
  /** Usa o valor armazenado no scan anterior; permite realimentação FBD. */
  feedback?: boolean;
  feedbackInitialValue?: string;
}

export interface GraphNetwork {
  networkId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
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
  /** Formato antigo: código ST no próprio passo, ou chamada de uma instância de FB. */
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
  /** Formato antigo: um passo de cada lado. */
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

/** Contatos da IEC 61131-3 3ª ed., tabela 75: NA, NF, transição positiva e negativa. */
export type LdContactKind = "no" | "nc" | "p" | "n";
/** Bobinas da tabela 76: bobina, negada, set, reset, transição positiva e negativa. */
export type LdCoilKind = "coil" | "negated" | "set" | "reset" | "p" | "n";
/** Operadores do contato de comparação (tabela 75, 5a/5b). */
export const LD_COMPARISONS = ["=", "<>", ">", ">=", "<", "<="] as const;
export type LdComparison = typeof LD_COMPARISONS[number];

/** Elemento numa posição da grade de um degrau. */
export type LdCell =
  /** Ligação horizontal (tabela 74): passa o estado da esquerda para a direita. */
  | { kind: "wire" }
  | { kind: "contact"; contact: LdContactKind; variable: string }
  /** Contato de comparação: `left <op> right`; `dataType` presente = forma tipada (5a). */
  | { kind: "compare"; operator: LdComparison; left: string; right: string; dataType?: string }
  | { kind: "coil"; coil: LdCoilKind; variable: string }
  /** Função ou bloco de função. `powerInput`/`powerOutput`: EN/ENO (tabela 18) ou uma entrada/saída
   * BOOL do próprio bloco ligada ao degrau; as demais entradas e saídas recebem variáveis/literais. */
  | { kind: "block"; typeName: string; instanceName?: string; powerInput: string; powerOutput: string;
      inputs: Record<string, string>; outputs: Record<string, string> }
  /** Salto para o rótulo de uma rede (tabela 73); na coluna 0 é incondicional. */
  | { kind: "jump"; label: string }
  /** Retorno (tabela 73); na coluna 0 é incondicional. */
  | { kind: "return" };

/** Rede (degrau) do LD: grade entre a barra de alimentação esquerda (antes da coluna 0) e a direita. */
export interface LdRung {
  rungId: string;
  /** Rótulo da rede, destino de saltos. */
  label?: string;
  comment?: string;
  /** rows[linha][coluna]; null = posição vazia. */
  rows: Array<Array<LdCell | null>>;
  /** Ligações verticais (tabela 74): une a borda direita da célula (row, column) à da linha de baixo. */
  verticals: Array<{ row: number; column: number }>;
}

export type PouBody =
  | { language: "st" | "il"; text: string }
  /** `rungs` é o modelo do editor LD; `networks` é o formato antigo (lido quando não há `rungs`). */
  | { language: "ld"; networks: GraphNetwork[]; rungs?: LdRung[] }
  | { language: "fbd"; networks: GraphNetwork[] }
  | { language: "sfc"; steps: SfcStep[]; transitions: SfcTransition[]; actions?: SfcAction[] };

export interface PouReference {
  referenceId: string;
  targetPouId: string;
  instanceName?: string;
  expectedSignature: string;
}

export interface PouDefinition {
  pouId: string;
  name: string;
  kind: PouKind;
  interface: PouInterface;
  implementation: PouBody;
  references?: PouReference[];
}

export type IecDataType =
  | { name: string; kind: "alias"; baseType: string; initialValue?: string }
  | { name: string; kind: "enum"; values: string[] }
  | { name: string; kind: "struct"; fields: Array<{ name: string; type: string; initialValue?: string }> }
  | { name: string; kind: "array"; elementType: string; dimensions: string[] };

export interface IecGlobalVariableList {
  name: string;
  variables: IecVariable[];
}

export interface IecLibraryPou {
  namespace: string;
  pouId: string;
  name: string;
  kind: Exclude<PouKind, "program">;
  interface: PouInterface;
  system: boolean;
  enabled: boolean;
  extensible?: boolean;
  category?: string;
}

export interface IecProjectAuthoring {
  schemaVersion: 1;
  projectId: string;
  dataTypes: IecDataType[];
  globalVariableLists: IecGlobalVariableList[];
  pous: PouDefinition[];
  configurations: unknown[];
  resources: unknown[];
  tasks: unknown[];
  programInstances: unknown[];
  libraries: IecLibraryPou[];
  buildSettings: Record<string, unknown>;
}

export interface PouSymbol {
  pouId: string;
  qualifiedName: string;
  displayName: string;
  kind: PouKind;
  language?: IecLanguage;
  interface: PouInterface;
  source: "project" | "system-library" | "project-library";
  extensible?: boolean;
  category?: string;
}

export interface IecDiagnostic {
  code: "invalid-pou" | "duplicate-symbol" | "orphan-reference" | "signature-changed";
  pouId?: string;
  referenceId?: string;
  message: string;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function signatureOf(pou: Pick<PouDefinition, "kind" | "interface">): string {
  const vars = pou.interface.variables
    .filter(variable => variable.class === "input" || variable.class === "output" || variable.class === "inOut")
    .map(variable => `${variable.class}:${variable.ioId ?? variable.name}:${variable.type.toUpperCase()}`)
    .join("|");
  return `${pou.kind}:${pou.interface.returnType?.toUpperCase() ?? ""}:${vars}`;
}

function validatePou(pou: PouDefinition): string[] {
  const errors: string[] = [];
  if (!pou.pouId) errors.push("pouId is required");
  if (!IDENTIFIER.test(pou.name)) errors.push(`invalid POU name: ${pou.name}`);
  if (!IEC_LANGUAGES.includes(pou.implementation.language)) errors.push("unsupported implementation language");
  if (pou.kind === "function" && !pou.interface.returnType) errors.push("FUNCTION requires returnType");
  const names = new Set<string>();
  const ioIds = new Set<string>();
  for (const variable of pou.interface.variables) {
    const normalized = variable.name.toUpperCase();
    if (!IDENTIFIER.test(variable.name)) errors.push(`invalid variable name: ${variable.name}`);
    if (names.has(normalized)) errors.push(`duplicate variable: ${variable.name}`);
    names.add(normalized);
    if ((variable.class === "input" || variable.class === "output" || variable.class === "inOut") && !variable.ioId) {
      errors.push(`public variable requires stable ioId: ${variable.name}`);
    }
    if (variable.ioId) {
      if (ioIds.has(variable.ioId)) errors.push(`duplicate ioId: ${variable.ioId}`);
      ioIds.add(variable.ioId);
    }
  }
  return errors;
}

/** Incremental symbol table shared by LD/FBD/ST/SFC/IL editor surfaces. */
export class IecProjectStore {
  private readonly projectPous = new Map<string, PouDefinition>();
  private readonly libraries = new Map<string, IecLibraryPou>();
  private readonly loadDiagnostics = new Map<string, IecDiagnostic[]>();
  private revisionValue = 0;
  private projectMetadata: Pick<IecProjectAuthoring, "dataTypes" | "globalVariableLists" | "configurations" | "resources" | "tasks" | "programInstances" | "buildSettings"> = {
    dataTypes: [], globalVariableLists: [], configurations: [], resources: [], tasks: [], programInstances: [], buildSettings: {},
  };

  constructor(project?: IecProjectAuthoring) {
    if (!project) return;
    this.projectMetadata = structuredClone({ dataTypes: project.dataTypes ?? [], globalVariableLists: project.globalVariableLists ?? [],
      configurations: project.configurations ?? [], resources: project.resources ?? [], tasks: project.tasks ?? [],
      programInstances: project.programInstances ?? [], buildSettings: project.buildSettings ?? {} });
    for (const [index, pou] of project.pous.entries()) {
      const invalid = validatePou(pou).map<IecDiagnostic>(message => ({ code: "invalid-pou", pouId: pou.pouId, message }));
      if (invalid.length) {
        this.loadDiagnostics.set(pou.pouId || `invalid-pou-${index}`, invalid);
        continue;
      }
      const collision = [...this.projectPous.values()].find(candidate => candidate.name.toUpperCase() === pou.name.toUpperCase());
      if (collision) {
        this.loadDiagnostics.set(pou.pouId, [{ code: "duplicate-symbol", pouId: pou.pouId,
          message: `symbol ${pou.name} already belongs to ${collision.pouId}` }]);
        continue;
      }
      this.projectPous.set(pou.pouId, structuredClone(pou));
      this.revisionValue += 1;
    }
    for (const libraryPou of project.libraries) this.saveLibraryPou(libraryPou);
  }

  get revision(): number { return this.revisionValue; }

  savePou(pou: PouDefinition): IecDiagnostic[] {
    const diagnostics = validatePou(pou).map<IecDiagnostic>(message => ({ code: "invalid-pou", pouId: pou.pouId, message }));
    if (diagnostics.length) {
      this.loadDiagnostics.set(pou.pouId, diagnostics);
      return diagnostics;
    }
    const collision = [...this.projectPous.values()].find(candidate =>
      candidate.pouId !== pou.pouId && candidate.name.toUpperCase() === pou.name.toUpperCase());
    if (collision) {
      const duplicate = [{ code: "duplicate-symbol" as const, pouId: pou.pouId, message: `symbol ${pou.name} already belongs to ${collision.pouId}` }];
      this.loadDiagnostics.set(pou.pouId, duplicate);
      return duplicate;
    }
    this.loadDiagnostics.delete(pou.pouId);
    this.projectPous.set(pou.pouId, structuredClone(pou));
    this.revisionValue += 1;
    return this.diagnostics();
  }

  removePou(pouId: string): void {
    this.loadDiagnostics.delete(pouId);
    if (this.projectPous.delete(pouId)) this.revisionValue += 1;
  }

  saveLibraryPou(pou: IecLibraryPou): void {
    const key = `${pou.namespace}::${pou.pouId}`;
    this.libraries.set(key, structuredClone(pou));
    this.revisionValue += 1;
  }

  /** Imports the pinned OpenPLC v4 library-port shape into the same browser used by all editors. */
  importOpenPlcLibrary(library: OpenPlcSystemLibrary, bundled: boolean, enabled = true): void {
    for (const pou of library.pous) {
      if (pou.language === "cpp") continue;
      this.saveLibraryPou({
        namespace: library.name,
        pouId: `openplc:${library.name}:${pou.name}`,
        name: pou.name,
        kind: pou.type === "function-block" ? "functionBlock" : "function",
        interface: {
          variables: pou.variables.map(variable => ({
            name: variable.name,
            class: variable.class,
            type: variable.type.value,
            ...(variable.initialValue === undefined ? {} : { initialValue: String(variable.initialValue) }),
            ...(variable.class === "input" || variable.class === "output" || variable.class === "inOut"
              ? { ioId: `openplc:${library.name}:${pou.name}:${variable.name}` }
              : {}),
          })),
        },
        system: bundled,
        enabled,
        extensible: pou.extensible,
        category: pou.category,
      });
    }
  }

  getPou(pouId: string): PouDefinition | undefined {
    const value = this.projectPous.get(pouId);
    return value ? structuredClone(value) : undefined;
  }

  /** No publish/build step: a valid interface becomes visible immediately. */
  symbols(): PouSymbol[] {
    const projectSymbols: PouSymbol[] = [...this.projectPous.values()].map(pou => ({
      pouId: pou.pouId,
      qualifiedName: pou.name,
      displayName: pou.name,
      kind: pou.kind,
      language: pou.implementation.language,
      interface: structuredClone(pou.interface),
      source: "project",
    }));
    const librarySymbols: PouSymbol[] = [...this.libraries.values()]
      .filter(pou => pou.enabled || pou.system)
      .map(pou => ({
        pouId: pou.pouId,
        qualifiedName: `${pou.namespace}.${pou.name}`,
        displayName: pou.name,
        kind: pou.kind,
        interface: structuredClone(pou.interface),
        source: pou.system ? "system-library" : "project-library",
        extensible: pou.extensible,
        category: pou.category,
      }));
    return [...projectSymbols, ...librarySymbols].sort((a, b) =>
      a.qualifiedName.localeCompare(b.qualifiedName, "en", { sensitivity: "base" }));
  }

  browser(query = ""): PouSymbol[] {
    const needle = query.trim().toUpperCase();
    return this.symbols().filter(symbol => symbol.kind !== "program" &&
      (!needle || symbol.qualifiedName.toUpperCase().includes(needle)));
  }

  addReference(callerPouId: string, targetPouId: string, referenceId: string, instanceName?: string): IecDiagnostic[] {
    const caller = this.projectPous.get(callerPouId);
    const target = this.projectPous.get(targetPouId) ?? [...this.libraries.values()].find(pou => pou.pouId === targetPouId);
    if (!caller) return [{ code: "invalid-pou", pouId: callerPouId, message: `caller ${callerPouId} does not exist` }];
    if (!target) return [{ code: "orphan-reference", pouId: callerPouId, referenceId, message: `target ${targetPouId} does not exist` }];
    const reference: PouReference = {
      referenceId,
      targetPouId,
      instanceName,
      expectedSignature: signatureOf(target),
    };
    caller.references = [...(caller.references ?? []).filter(item => item.referenceId !== referenceId), reference];
    this.revisionValue += 1;
    return this.diagnostics();
  }

  diagnostics(): IecDiagnostic[] {
    const result: IecDiagnostic[] = [...this.loadDiagnostics.values()].flat();
    const allTargets = new Map<string, Pick<PouDefinition, "kind" | "interface">>();
    for (const pou of this.projectPous.values()) allTargets.set(pou.pouId, pou);
    for (const pou of this.libraries.values()) if (pou.enabled || pou.system) allTargets.set(pou.pouId, pou);
    for (const caller of this.projectPous.values()) {
      for (const reference of caller.references ?? []) {
        const target = allTargets.get(reference.targetPouId);
        if (!target) {
          result.push({ code: "orphan-reference", pouId: caller.pouId, referenceId: reference.referenceId,
            message: `reference ${reference.referenceId} targets removed POU ${reference.targetPouId}` });
        } else if (signatureOf(target) !== reference.expectedSignature) {
          result.push({ code: "signature-changed", pouId: caller.pouId, referenceId: reference.referenceId,
            message: `interface of ${reference.targetPouId} changed incompatibly` });
        }
      }
    }
    return result;
  }

  snapshot(projectId: string): IecProjectAuthoring {
    return {
      schemaVersion: 1,
      projectId,
      ...structuredClone(this.projectMetadata),
      pous: [...this.projectPous.values()].map(pou => structuredClone(pou)),
      libraries: [...this.libraries.values()].map(pou => structuredClone(pou)),
    };
  }
}

export function parseIecProject(value: unknown): IecProjectAuthoring {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("IEC project must be an object");
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1 || typeof raw.projectId !== "string" || !Array.isArray(raw.pous)) {
    throw new Error("unsupported or malformed IEC project");
  }
  for (const forbidden of ["runtimeState", "inputImage", "outputImage", "memory", "queues"]) {
    if (forbidden in raw) throw new Error(`transient PLC field is forbidden in authoring: ${forbidden}`);
  }
  const project = structuredClone(raw) as unknown as IecProjectAuthoring;
  project.dataTypes = Array.isArray(raw.dataTypes) ? structuredClone(raw.dataTypes) as IecDataType[] : [];
  project.globalVariableLists = Array.isArray(raw.globalVariableLists) ? structuredClone(raw.globalVariableLists) as IecGlobalVariableList[] : [];
  for (const field of ["configurations", "resources", "tasks", "programInstances", "libraries"] as const) {
    if (!Array.isArray(project[field])) project[field] = [] as never;
  }
  if (!project.buildSettings || typeof project.buildSettings !== "object" || Array.isArray(project.buildSettings)) project.buildSettings = {};
  const store = new IecProjectStore();
  for (const pou of project.pous) {
    const diagnostics = store.savePou(pou).filter(item => item.code === "invalid-pou" || item.code === "duplicate-symbol");
    if (diagnostics.length) throw new Error(diagnostics.map(item => item.message).join("; "));
  }
  return project;
}
