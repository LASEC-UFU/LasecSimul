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
  kind: "contact" | "coil" | "block" | "input" | "output";
  symbol?: string;
  referencedPouId?: string;
  instanceName?: string;
  negated?: boolean;
  x?: number;
  y?: number;
}

export interface GraphEdge {
  edgeId: string;
  fromNodeId: string;
  fromPort?: string;
  toNodeId: string;
  toPort?: string;
}

export interface GraphNetwork {
  networkId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface SfcStep {
  stepId: string;
  name: string;
  initial?: boolean;
  actions: Array<{ actionId: string; text?: string; referencedPouId?: string; instanceName?: string }>;
}

export interface SfcTransition {
  transitionId: string;
  fromStepId: string;
  toStepId: string;
  condition: string;
}

export type PouBody =
  | { language: "st" | "il"; text: string }
  | { language: "ld" | "fbd"; networks: GraphNetwork[] }
  | { language: "sfc"; steps: SfcStep[]; transitions: SfcTransition[] };

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
  dataTypes: unknown[];
  globalVariableLists: unknown[];
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
  private revisionValue = 0;

  constructor(project?: IecProjectAuthoring) {
    if (!project) return;
    for (const pou of project.pous) this.savePou(pou);
    for (const libraryPou of project.libraries) this.saveLibraryPou(libraryPou);
  }

  get revision(): number { return this.revisionValue; }

  savePou(pou: PouDefinition): IecDiagnostic[] {
    const diagnostics = validatePou(pou).map<IecDiagnostic>(message => ({ code: "invalid-pou", pouId: pou.pouId, message }));
    if (diagnostics.length) return diagnostics;
    const collision = [...this.projectPous.values()].find(candidate =>
      candidate.pouId !== pou.pouId && candidate.name.toUpperCase() === pou.name.toUpperCase());
    if (collision) return [{ code: "duplicate-symbol", pouId: pou.pouId, message: `symbol ${pou.name} already belongs to ${collision.pouId}` }];
    this.projectPous.set(pou.pouId, structuredClone(pou));
    this.revisionValue += 1;
    return this.diagnostics();
  }

  removePou(pouId: string): void {
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
    const result: IecDiagnostic[] = [];
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
      dataTypes: [], globalVariableLists: [], configurations: [], resources: [], tasks: [], programInstances: [],
      pous: [...this.projectPous.values()].map(pou => structuredClone(pou)),
      libraries: [...this.libraries.values()].map(pou => structuredClone(pou)),
      buildSettings: {},
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
  const store = new IecProjectStore();
  for (const pou of project.pous) {
    const diagnostics = store.savePou(pou).filter(item => item.code === "invalid-pou" || item.code === "duplicate-symbol");
    if (diagnostics.length) throw new Error(diagnostics.map(item => item.message).join("; "));
  }
  return project;
}
