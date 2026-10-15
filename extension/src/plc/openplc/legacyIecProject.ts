/*
 * Projeto IEC antigo do LasecSimul (`*.iec.json`, editores das etapas 1 a 4) -> projeto PLC `.lsplc`
 * do editor OpenPLC. A conversão em si fica no host do OpenPLC (overlay/host/legacy.ts), que monta
 * os degraus LD com as funções do próprio editor; daqui vai só a tradução para ST do que o OpenPLC
 * não desenha (salto, retorno, contato de comparação, FBD antigo), feita pelo mesmo `lowerPouBody`
 * que compila esses projetos hoje.
 */

import * as fs from "fs";
import * as path from "path";
import { IecProjectAuthoring, IecProjectStore, PouDefinition } from "../iecProject";
import { lowerPouBody } from "../lowering";
import { bundleFromRaw, LSPLC_EXTENSION, writeLsplc } from "./lsplcFile";
import { OpenPlcHost } from "./openPlcHost";

export const LEGACY_IEC_SUFFIX = ".iec.json";

export function isLegacyIecProjectFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(LEGACY_IEC_SUFFIX);
}

/** `pasta/projeto.iec.json` -> `pasta/projeto.lsplc`. */
export function lsplcPathForLegacy(filePath: string): string {
  const base = path.basename(filePath);
  const stem = isLegacyIecProjectFile(base) ? base.slice(0, -LEGACY_IEC_SUFFIX.length) : path.parse(base).name;
  return path.join(path.dirname(filePath), `${stem}${LSPLC_EXTENSION}`);
}

/** Corpo ST de um POU antigo (o mesmo texto que o build do LasecSimul gera para ele). */
function stFallback(project: IecProjectAuthoring): (pou: PouDefinition) => { text: string; variables: Array<{ name: string; type: string }> } {
  const store = new IecProjectStore(project);
  return (pou) => {
    const lowered = lowerPouBody(pou, store);
    const variables = lowered.declarations.flatMap(line => {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^;]+);/.exec(line);
      return match ? [{ name: match[1]!, type: match[2]!.trim() }] : [];
    });
    return { text: lowered.lines.map(line => line.text).join("\n"), variables };
  };
}

export function convertLegacyIecProject(host: OpenPlcHost, project: IecProjectAuthoring): { raw: ReturnType<OpenPlcHost["fromLasecIecProject"]>["raw"]; warnings: string[] } {
  return host.fromLasecIecProject(project, { fallbackSt: stFallback(project) });
}

export interface LegacyConversionResult {
  target: string;
  warnings: string[];
}

const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

interface SchematicPlcComponent {
  typeId?: string;
  properties?: Record<string, unknown>;
  plc?: Record<string, unknown>;
}

/** Blocos CLP de um esquemático `.lsproj` ligados ao projeto `projectFile`. */
function plcComponentsReferencing(schematicFile: string, projectFile: string, document: { components?: SchematicPlcComponent[] }): SchematicPlcComponent[] {
  const dir = path.dirname(schematicFile);
  return (document.components ?? []).filter(component => {
    if (component.typeId !== "plc.instance") return false;
    const refs = [component.plc?.iecProjectRef, component.properties?.plcIecProjectRef].filter((ref): ref is string => typeof ref === "string" && ref !== "");
    return refs.some(ref => samePath(path.resolve(dir, ref), projectFile));
  });
}

export function schematicReferences(schematicFile: string, projectFile: string): boolean {
  try {
    return plcComponentsReferencing(schematicFile, projectFile, JSON.parse(fs.readFileSync(schematicFile, "utf8"))).length > 0;
  } catch {
    return false;
  }
}

/**
 * O esquemático passa a usar o `.lsplc`: o bloco CLP aponta para ele e deixa a CONFIGURATION do
 * projeto antigo (o `.lsplc` roda a primeira instância da RESOURCE). Os pinos são as mesmas
 * VAR_INPUT/VAR_OUTPUT, com o mesmo nome, então os fios continuam ligados.
 */
export function retargetSchematic(schematicFile: string, legacyFile: string, lsplcFile: string): boolean {
  const document = JSON.parse(fs.readFileSync(schematicFile, "utf8")) as { components?: SchematicPlcComponent[] };
  const components = plcComponentsReferencing(schematicFile, legacyFile, document);
  if (components.length === 0) return false;
  const relative = path.relative(path.dirname(schematicFile), lsplcFile).replace(/\\/g, "/");
  for (const component of components) {
    component.properties = { ...component.properties, plcIecProjectRef: relative, plcEntryConfiguration: "" };
    const { entryConfiguration: _entry, ...plc } = component.plc ?? {};
    component.plc = { ...plc, iecProjectRef: relative };
  }
  fs.writeFileSync(schematicFile, `${JSON.stringify(document, null, 2)}\n`);
  return true;
}

/** Converte `*.iec.json` e grava o `.lsplc` (por padrão ao lado, com o mesmo nome). */
export function convertLegacyIecProjectFile(host: OpenPlcHost, sourceFile: string, target = lsplcPathForLegacy(sourceFile)): LegacyConversionResult {
  const project = JSON.parse(fs.readFileSync(sourceFile, "utf8")) as IecProjectAuthoring;
  if (project?.schemaVersion !== 1 || !Array.isArray(project.pous)) {
    throw new Error(`${path.basename(sourceFile)} não é um projeto IEC do LasecSimul.`);
  }
  const { raw, warnings } = convertLegacyIecProject(host, project);
  const { projectPath: _projectPath, ...files } = raw;
  writeLsplc(target, bundleFromRaw(files));
  return { target, warnings };
}
