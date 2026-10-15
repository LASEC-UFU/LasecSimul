/*
 * POUs SFC de um projeto OpenPLC -> POUs ST, antes do transpilador do OpenPLC (que não traduz SFC).
 *
 * Usa a tradução SFC -> ST do LasecSimul (sfcLowering.ts: ACTION_CONTROL da norma, divergências e
 * convergências, PASSO.X/.T): o corpo SFC gravado pelo editor tem os mesmos campos do modelo de lá.
 * As variáveis internas da tradução viram variáveis VAR do POU; o FB `__SFC_ACTION_CONTROL` entra
 * uma vez no início do ST do programa.
 */

import { IecVariable, PouDefinition, SfcAction, SfcStep, SfcTransition, VariableClass } from "../iecProject";
import { IlContext, IlMember } from "../ilLowering";
import { PlcBuildDiagnostic } from "../plcBuild";
import { SfcElement, actionControlSource, lowerSfcToSt } from "../sfcLowering";
import { OpenPlcProjectData } from "./openPlcHost";

/** Variável do OpenPLC (formato de porta: `type: {definition, value}`). */
interface OpenPlcVariable {
  name: string;
  class?: string;
  type?: { definition?: string; value?: string };
  location?: string;
  initialValue?: string | null;
  documentation?: string;
  debug?: boolean;
}

interface OpenPlcPou {
  name: string;
  pouType: string;
  interface?: { variables?: OpenPlcVariable[]; returnType?: string };
  body: { language: string; value: unknown };
  documentation?: string;
}

export interface SfcLineOrigin {
  /** Linha do corpo ST gerado (1 = primeira). */
  line: number;
  element?: SfcElement;
}

export interface OpenPlcSfcPreparation {
  data: OpenPlcProjectData;
  /** ST a colocar antes de todo o resto (FB do ACTION_CONTROL), vazio sem SFC. */
  prelude: string;
  diagnostics: PlcBuildDiagnostic[];
  /** POU SFC -> elemento (passo, transição, ação) de cada linha do corpo gerado. */
  elementsByPou: Map<string, SfcLineOrigin[]>;
}

/** Tipos elementares da IEC 61131-3 (o resto é tipo derivado: FB, struct, enum...). */
const ELEMENTARY = new Set(["BOOL", "SINT", "INT", "DINT", "LINT", "USINT", "UINT", "UDINT", "ULINT", "REAL", "LREAL",
  "BYTE", "WORD", "DWORD", "LWORD", "TIME", "DATE", "TOD", "TIME_OF_DAY", "DT", "DATE_AND_TIME", "STRING", "WSTRING",
  "LTIME", "LDATE", "LTOD", "LDT", "CHAR", "WCHAR"]);

const CLASSES: Record<string, VariableClass> = {
  input: "input", output: "output", inOut: "inOut", local: "local", temp: "temp", external: "external", global: "external",
};

function typeName(variable: OpenPlcVariable): string {
  return String(variable.type?.value ?? "").toUpperCase() === "" ? "BOOL" : String(variable.type?.value ?? "");
}

function iecVariables(pou: OpenPlcPou): IecVariable[] {
  return (pou.interface?.variables ?? []).map(variable => ({
    name: variable.name,
    class: CLASSES[String(variable.class ?? "local")] ?? "local",
    type: variable.type?.definition === "base-type" ? typeName(variable).toUpperCase() : typeName(variable),
    ...(variable.initialValue ? { initialValue: String(variable.initialValue) } : {}),
  }));
}

function kindOf(pouType: string): PouDefinition["kind"] {
  return pouType === "program" ? "program" : pouType === "function-block" ? "functionBlock" : "function";
}

/** Contexto que a tradução de IL (corpo das ações em IL) precisa: variáveis do POU e interfaces dos POUs do projeto. */
function ilContext(pou: OpenPlcPou, pous: OpenPlcPou[]): IlContext {
  const variables = new Map<string, string>();
  for (const variable of iecVariables(pou)) variables.set(variable.name.toUpperCase(), variable.type.toUpperCase());
  const functionBlocks = new Map<string, Map<string, IlMember>>();
  const functions = new Map<string, { returnType: string; inputs: string[] }>();
  for (const other of pous) {
    if (other.pouType === "function-block") {
      functionBlocks.set(other.name.toUpperCase(), new Map(iecVariables(other).map(variable => [
        variable.name.toUpperCase(),
        { type: variable.type.toUpperCase(), direction: variable.class === "input" || variable.class === "output" || variable.class === "inOut" ? variable.class : "local" },
      ])));
    } else if (other.pouType === "function") {
      functions.set(other.name.toUpperCase(), {
        returnType: (other.interface?.returnType ?? "BOOL").toUpperCase(),
        inputs: iecVariables(other).filter(variable => variable.class === "input").map(variable => variable.name.toUpperCase()),
      });
    }
  }
  return { pouName: pou.name, pouKind: kindOf(pou.pouType), variables, functionBlocks, functions };
}

const DECLARATION = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?::=\s*(.+?))?\s*;\s*$/;

/** `  __SFC_S1_X : BOOL := TRUE;` -> variável VAR do OpenPLC. */
function declarationVariable(line: string): OpenPlcVariable | undefined {
  const match = DECLARATION.exec(line);
  if (!match) return undefined;
  const type = match[2]!;
  const elementary = ELEMENTARY.has(type.toUpperCase());
  return {
    name: match[1]!,
    class: "local",
    type: { definition: elementary ? "base-type" : "derived", value: elementary ? type.toLowerCase() : type },
    location: "",
    initialValue: match[3] ?? null,
    documentation: "",
    debug: false,
  };
}

interface SfcBodyValue {
  steps?: SfcStep[];
  transitions?: SfcTransition[];
  actions?: SfcAction[];
}

export function prepareOpenPlcSfc(data: OpenPlcProjectData): OpenPlcSfcPreparation {
  const pous = data.pous as unknown as OpenPlcPou[];
  const diagnostics: PlcBuildDiagnostic[] = [];
  const elementsByPou = new Map<string, SfcLineOrigin[]>();
  let hasSfc = false;
  const converted = pous.map((pou): OpenPlcPou => {
    if (pou.body?.language !== "sfc") return pou;
    hasSfc = true;
    const value = (pou.body.value && typeof pou.body.value === "object" ? pou.body.value : {}) as SfcBodyValue;
    const definition: PouDefinition = {
      pouId: pou.name,
      name: pou.name,
      kind: kindOf(pou.pouType),
      interface: { variables: iecVariables(pou), ...(pou.interface?.returnType ? { returnType: pou.interface.returnType } : {}) },
      implementation: {
        language: "sfc",
        steps: (value.steps ?? []).map(step => ({ ...step, actions: step.actions ?? [] })),
        transitions: value.transitions ?? [],
        actions: value.actions ?? [],
      },
    };
    const lowered = lowerSfcToSt(definition, ilContext(pou, pous));
    for (const item of lowered.diagnostics) {
      diagnostics.push({
        severity: item.severity,
        stage: "sfc",
        message: item.message,
        pouId: pou.name,
        pouName: pou.name,
        ...(item.line ? { line: item.line } : {}),
        ...(item.element ? { elementId: item.element.id, elementLabel: item.element.label } : {}),
      });
    }
    elementsByPou.set(pou.name, lowered.lines.map((line, index) => ({ line: index + 1, ...(line.element ? { element: line.element } : {}) })));
    const generated = lowered.declarations.map(declarationVariable).filter((variable): variable is OpenPlcVariable => !!variable);
    return {
      ...pou,
      interface: { ...(pou.interface ?? {}), variables: [...(pou.interface?.variables ?? []), ...generated] },
      body: { language: "st", value: lowered.lines.map(line => line.text).join("\n") || ";" },
    };
  });
  return {
    data: { ...data, pous: converted as unknown as OpenPlcProjectData["pous"] },
    prelude: hasSfc ? actionControlSource().join("\n") : "",
    diagnostics,
    elementsByPou,
  };
}
